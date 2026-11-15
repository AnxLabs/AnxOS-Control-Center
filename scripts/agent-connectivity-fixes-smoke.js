"use strict";

// Regression checks for the agent-connectivity fixes: the Windows Agent task
// time limit, Install/Repair of a running Local Agent, SSH tunnel retries,
// the empty-token fallback, Agent Control's remote-node status and the Local
// Agent restart policy.
//
// Hermetic: every check runs in its own child process with temp data folders,
// faked child_process (no PowerShell, schtasks, netstat, taskkill or Agent
// spawn), AGENT_URL=http://127.0.0.1:9 and fake Agents on random loopback
// ports. Ports 47131/47132 and non-loopback hosts are refused.
// Run: node scripts/agent-connectivity-fixes-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const net = require("net");
const { EventEmitter } = require("events");
const childProcess = require("child_process");

const ROOT = path.join(__dirname, "..");
const BLOCKED_PORTS = new Set([47131, 47132]);
const LOOPBACK = /^(127\.|localhost$|\[?::1\]?$)/;

const CHECKS = [
  ["agent-connectivity-1", "Windows Agent task has no 72 h time limit and restarts on failure; repair detects old tasks", checkTaskTimeLimit],
  ["agent-connectivity-2a", "Install Local Agent succeeds while the Local Agent is already running", checkInstallWhileRunning],
  ["agent-connectivity-2b", "Stop Old Local Agent and Repair starts the Agent before the repair it depends on", checkStopOldAndRepair],
  ["agent-connectivity-2c", "A failed Stop Old Local Agent and Repair never leaves the Local Agent stopped", checkStopOldAndRepairFailureKeepsAgent],
  ["agent-connectivity-3", "A retryable SSH-agent failure is retried with backoff instead of staying failed", checkTunnelTransientRetry],
  ["agent-connectivity-4", "An empty agentToken never carries the Local Agent token to a node endpoint", checkEmptyTokenNoFallback],
  ["agent-connectivity-5", "Agent Control does not mark an unverified remote node Connected from /health", checkRemoteNodeVerified],
  ["agent-connectivity-6", "Restart policy restarts a crashed desktop-managed Agent as labelled", checkRestartPolicy],
  ["agent-connectivity-7", "Start runs an older Agent task (72 h limit, no restart) elevated instead of a non-elevated Agent", checkStartRunsDriftedTask],
  ["agent-connectivity-8", "The Computers row shows why a retried SSH tunnel is still connecting", checkTunnelRowShowsRetryReason],
  ["agent-connectivity-9", "A new SSH tunnel attempt does not show a reason the user already resolved", checkTunnelRowDropsResolvedReason],
];

// ---------------------------------------------------------------- harness --

function setupIsolatedEnvironment(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `anx-agentconn-${label}-`));
  const dir = (name) => {
    const value = path.join(root, name);
    fs.mkdirSync(value, { recursive: true });
    return value;
  };
  const config = dir("config");
  Object.assign(process.env, {
    ANXHUB_CONFIG_DIR: config,
    ANXOS_CONFIG_DIR: config,
    ANXOS_LOG_DIR: dir("logs"),
    AGENT_INSTANCE_ROOT: dir("instances"),
    AGENT_BACKUP_ROOT: dir("backups"),
    AGENT_TEMP_DIR: dir("tmp"),
    AGENT_LOG_DIR: dir("agent-logs"),
    AGENT_IDENTITY_PATH: path.join(root, "identity.json"),
    APPDATA: dir("appdata"),
    LOCALAPPDATA: dir("localappdata"),
    AGENT_URL: "http://127.0.0.1:9",
  });
  delete process.env.AGENT_TOKEN;
  delete process.env.ANXHUB_AGENT_CONFIG_PATH;
  return root;
}

function guardNetwork() {
  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function guardedConnect(...args) {
    const options = typeof args[0] === "object" && args[0] !== null ? args[0] : { port: args[0], host: args[1] };
    const port = Number(options.port);
    const host = String(options.host || "127.0.0.1");
    if (options.path === undefined && (BLOCKED_PORTS.has(port) || !LOOPBACK.test(host))) throw new Error(`blocked connection to ${host}:${port}`);
    return originalConnect.apply(this, args);
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options) => {
    const parsed = new URL(String(url));
    if (BLOCKED_PORTS.has(Number(parsed.port)) || !LOOPBACK.test(parsed.hostname)) {
      return Promise.reject(Object.assign(new Error(`blocked fetch ${parsed.origin}`), { code: "ECONNREFUSED" }));
    }
    return originalFetch(url, options);
  };
}

// Replace every process launcher. `handlers.execFile(name, args)` returns
// { stdout, stderr, error } for the commands a check expects; anything else
// fails with ENOENT, so no real command can run.
function fakeChildProcess(handlers = {}) {
  const calls = [];
  childProcess.execFile = (command, args, options, callback) => {
    const done = typeof options === "function" ? options : callback;
    const name = path.basename(String(command)).toLowerCase();
    calls.push([name, ...(args || [])]);
    Promise.resolve(handlers.execFile ? handlers.execFile(name, args || []) : null).then((result) => {
      const value = result || { error: Object.assign(new Error(`${name} is not available in this test`), { code: "ENOENT" }) };
      setImmediate(() => done?.(value.error || null, value.stdout || "", value.stderr || ""));
    });
    return { pid: 0, kill() {}, on() {}, once() {}, stdout: { on() {} }, stderr: { on() {} } };
  };
  childProcess.spawn = (command, args) => {
    calls.push(["spawn", path.basename(String(command)), ...(args || [])]);
    if (handlers.spawn) return handlers.spawn(command, args || []);
    throw new Error(`spawn(${command}) is not allowed in this test`);
  };
  for (const name of ["exec", "execSync", "execFileSync", "spawnSync"]) {
    childProcess[name] = (command) => { throw new Error(`${name}(${command}) is not allowed in this test`); };
  }
  return calls;
}

function setPlatform(value) {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check, label, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(25);
  }
  assert.fail(`timed out waiting for: ${label}`);
}

// A stand-in Local Agent: /api/v1/health is public, every other route needs
// the token the Agent read when it started (the real Agent never reloads it).
function createFakeAgent({ port, readToken, pid = 4242, taskRepair = "healthy" }) {
  const { tokenFingerprint } = require("../src/shared/agentTokenStore");
  const requests = [];
  let server = null;
  let startupToken = null;
  function handler(request, response) {
    const authorization = String(request.headers.authorization || "");
    requests.push({ method: request.method, url: request.url, authorization });
    const send = (status, body) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url === "/api/v1/health") {
      return send(200, {
        ok: true,
        service: "anxos-agent",
        apiVersion: "v1",
        protocolVersion: 1,
        tokenConfigured: true,
        tokenFingerprint: tokenFingerprint(startupToken),
        identity: { deviceId: "dev-local", hostname: "smoke-host", agentVersion: "0.1.0", apiVersion: "v1", protocolVersion: 1 },
        process: { pid },
      });
    }
    if (authorization !== `Bearer ${startupToken}`) return send(401, { error: { code: "UNAUTHORIZED", message: "Unauthorized." } });
    if (request.url === "/api/v1/system/agent-task") {
      if (taskRepair !== "healthy") return send(500, { error: { code: "AGENT_TASK_REGISTRATION_FAILED", message: "Registration failed in this test." } });
      return send(200, { ok: true, matchesCanonicalDefinition: true, agentHealth: "healthy", mismatchReasons: [] });
    }
    return send(200, { ok: true, cpu: { usagePercent: 1 }, memory: { used: 1, total: 2 } });
  }
  return {
    requests,
    get running() { return Boolean(server); },
    get startupToken() { return startupToken; },
    start() {
      startupToken = readToken();
      server = http.createServer(handler);
      return new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    },
    stop() {
      const current = server;
      server = null;
      if (!current) return Promise.resolve();
      return new Promise((resolve) => {
        current.close(() => resolve());
        current.closeAllConnections?.();
      });
    },
  };
}

async function statsStatus(port, token) {
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/stats`, { headers: { Authorization: `Bearer ${token}` } });
  return response.status;
}

// ------------------------------------------------------------------ checks --

// agent-connectivity-1
async function checkTaskTimeLimit() {
  const task = require("../src/shared/windowsAgentScheduledTask");
  const executable = "C:\\Program Files\\AnxOS\\AnxOS Control Center.exe";
  const userId = "PC\\user";
  const canonical = task.buildWindowsAgentTaskDefinition({ executablePath: executable, userId });
  const registration = task.buildWindowsTaskRegistrationScript(canonical);
  assert(/-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/.test(registration), "registration must remove the default 72 h execution time limit");
  assert(/-RestartCount [1-9]/.test(registration) && /-RestartInterval /.test(registration), "registration must restart the Agent task when it fails");
  const inspection = task.buildWindowsTaskInspectionScript();
  assert(inspection.includes("$task.Settings.ExecutionTimeLimit") && inspection.includes("$task.Settings.RestartCount"), "inspection must read the time limit and restart count");

  const snapshot = (settings) => ({
    found: true,
    taskName: "AnxOSAgent",
    taskPath: "\\",
    actions: [{ execute: executable, arguments: "--agent", workingDirectory: path.win32.dirname(executable) }],
    principal: { userId, logonType: "Interactive", runLevel: "Highest" },
    triggers: [{ type: "MSFT_TaskLogonTrigger", userId, enabled: true }],
    settings: { enabled: true, startWhenAvailable: true, allowStartOnBatteries: true, stopOnBatteryTransition: false, multipleInstances: "IgnoreNew", ...settings },
  });
  assert(task.compareWindowsAgentTask(snapshot({ executionTimeLimit: "PT72H", restartCount: 3 }), canonical).mismatches.includes("execution-time-limit"), "a PT72H task must be reported for repair");
  assert(task.compareWindowsAgentTask(snapshot({ executionTimeLimit: "PT0S", restartCount: 0 }), canonical).mismatches.includes("restart-on-failure"), "a task that never restarts must be reported for repair");
  assert.deepStrictEqual(task.compareWindowsAgentTask(snapshot({ executionTimeLimit: "PT0S", restartCount: 3 }), canonical).mismatches, [], "an unlimited task that restarts on failure is canonical");

  const installer = fs.readFileSync(path.join(ROOT, "windows", "install-agent-task.ps1"), "utf8");
  const settingsLine = installer.split(/\r?\n/).find((line) => line.includes("New-ScheduledTaskSettingsSet")) || "";
  assert(/-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/.test(settingsLine), "the installer must register the task without a time limit");
  assert(/-RestartCount [1-9]/.test(settingsLine) && /-RestartInterval /.test(settingsLine), "the installer must register the restart-on-failure policy");
}

// agent-connectivity-2a
async function checkInstallWhileRunning() {
  setupIsolatedEnvironment("install");
  guardNetwork();
  fakeChildProcess();
  setPlatform("darwin"); // no Windows task or systemd unit to inspect
  const control = require("../src/services/agentControlService");
  const pairing = require("../src/services/localAgentPairingService");
  const agentClient = require("../src/services/agentClient");
  const port = await freePort();
  control.saveConfig({ ...control.readConfig(), port, host: "127.0.0.1", restartPolicy: "never" });
  pairing.pairLocalAgent({ agentUrl: `http://127.0.0.1:${port}`, reason: "smoke-initial" });
  const agent = createFakeAgent({ port, readToken: () => agentClient.readAgentSettings().agentToken });
  await agent.start();
  try {
    assert.strictEqual(await statsStatus(port, agent.startupToken), 200);
    let result = null;
    let failure = null;
    try { result = await control.installLocalAgent({ autoStart: false, installService: false }); } catch (error) { failure = error; }
    assert.strictEqual(failure, null, `installLocalAgent must succeed with a running Agent, got ${failure?.code}: ${failure?.message}`);
    assert.strictEqual(result.ok, true);
    const desktopToken = agentClient.readAgentSettings().agentToken;
    assert.strictEqual(await statsStatus(port, desktopToken), 200, "the running Agent must accept the desktop's credential after install");
  } finally {
    await agent.stop();
  }
}

function windowsRepairHarness(taskRepair) {
  const state = { agent: null, port: 0, pid: 5151, agentScript: "" };
  const calls = fakeChildProcess({
    execFile(name, args) {
      const joined = args.join(" ");
      if (name === "netstat.exe") {
        return { stdout: state.agent?.running ? `  TCP    127.0.0.1:${state.port}    0.0.0.0:0    LISTENING    ${state.pid}\r\n` : "" };
      }
      if (name === "powershell.exe" && joined.includes("Win32_Process")) {
        return { stdout: JSON.stringify({ ProcessId: state.pid, Name: "node.exe", ExecutablePath: process.execPath, CommandLine: `"${process.execPath}" "${state.agentScript}"` }) };
      }
      if (name === "powershell.exe" && joined.includes("Get-ScheduledTask")) return { stdout: JSON.stringify({ found: false, legacyTaskNames: [] }) };
      if (name === "taskkill.exe") {
        const pid = Number(args[args.indexOf("/PID") + 1]);
        if (pid !== state.pid || !state.agent?.running) return { error: Object.assign(new Error("not found"), { code: 128 }) };
        return state.agent.stop().then(() => ({ stdout: "SUCCESS" }));
      }
      if (name === "sc.exe") return { error: Object.assign(new Error("1060"), { code: 1060 }), stdout: "[SC] OpenService FAILED 1060" };
      return null;
    },
    spawn(command, args) {
      // start() launching the bundled Agent: bring the fake Agent back up.
      assert.strictEqual(path.resolve(String(args[0])), path.resolve(state.agentScript), "start() must launch the bundled Agent script");
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = state.pid;
      child.exitCode = null;
      child.killed = false;
      child.kill = () => { child.killed = true; state.agent.stop().then(() => { child.exitCode = 0; child.emit("exit", 0, null); }); return true; };
      state.agent.start();
      return child;
    },
  });
  return { state, calls, taskRepair };
}

async function prepareWindowsRepair(taskRepair) {
  setupIsolatedEnvironment(`repair-${taskRepair}`);
  guardNetwork();
  setPlatform("win32");
  const harness = windowsRepairHarness(taskRepair);
  const control = require("../src/services/agentControlService");
  const pairing = require("../src/services/localAgentPairingService");
  const agentClient = require("../src/services/agentClient");
  harness.state.port = await freePort();
  harness.state.agentScript = control._test.getAgentScript();
  control.saveConfig({ ...control.readConfig(), port: harness.state.port, host: "127.0.0.1", restartPolicy: "never" });
  pairing.pairLocalAgent({ agentUrl: `http://127.0.0.1:${harness.state.port}`, reason: "smoke-initial" });
  harness.state.agent = createFakeAgent({ port: harness.state.port, pid: harness.state.pid, taskRepair, readToken: () => agentClient.readAgentSettings().agentToken });
  await harness.state.agent.start();
  return { ...harness, control, agentClient };
}

// agent-connectivity-2b
async function checkStopOldAndRepair() {
  const { state, calls, control, agentClient } = await prepareWindowsRepair("healthy");
  try {
    let result = null;
    let failure = null;
    try { result = await control.stopOldLocalAgentAndRepair({}); } catch (error) { failure = error; }
    assert(calls.some((call) => call[0] === "taskkill.exe"), "the verified old Agent is stopped first");
    assert.strictEqual(failure, null, `repair must succeed through a restarted Agent, got ${failure?.code}: ${failure?.message}`);
    assert.strictEqual(result.ok, true);
    assert(state.agent.running, "the Local Agent must be running after the repair");
    assert(state.agent.requests.some((entry) => entry.method === "POST" && entry.url === "/api/v1/system/agent-task"), "the privileged repair reached a running Agent");
    assert.strictEqual(await statsStatus(state.port, agentClient.readAgentSettings().agentToken), 200);
  } finally {
    await state.agent.stop();
  }
}

// agent-connectivity-2c
async function checkStopOldAndRepairFailureKeepsAgent() {
  const { state, control } = await prepareWindowsRepair("fail");
  try {
    let failure = null;
    try { await control.stopOldLocalAgentAndRepair({}); } catch (error) { failure = error; }
    assert(failure, "a failed privileged repair is still reported");
    assert(state.agent.running, "a failed repair must not leave the Local Agent stopped");
  } finally {
    await state.agent.stop();
  }
}

// agent-connectivity-3
async function checkTunnelTransientRetry() {
  const { createNodeTunnelService } = require("../src/services/nodeTunnelService");
  const timers = [];
  let agentAvailable = false;
  let configCalls = 0;
  const agentMessage = "The OpenSSH Authentication Agent isn't running. Start it, then retry.";
  const ssh = {
    createUnattendedConnectConfig() {
      configCalls += 1;
      if (!agentAvailable) throw Object.assign(new Error(agentMessage), { code: "SSH_AGENT_UNAVAILABLE", retryable: true });
      return { connectConfig: { host: "node.example" }, hostKeyState: { mismatch: false } };
    },
    createClient() {
      const client = new EventEmitter();
      client.end = () => {};
      client.connect = () => client.emit("ready");
      return client;
    },
  };
  const node = { id: "vps", kind: "agent", enabled: true, agentUrl: "http://127.0.0.1:47132", transport: { type: "ssh-tunnel", sshProfileId: "p1", remoteHost: "127.0.0.1", remotePort: 47131 } };
  const service = createNodeTunnelService({
    getNodes: () => [node],
    getSsh: () => ssh,
    createServer: () => {
      const server = new EventEmitter();
      server.listen = (_port, _host, callback) => callback();
      server.close = () => {};
      return server;
    },
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
  });
  service.sync();
  let status = service.getStatus("vps");
  assert.notStrictEqual(status.state, "failed", "a retryable SSH-agent failure must not end in 'failed'");
  assert.strictEqual(timers.length, 1, "a retry must be scheduled");
  assert.strictEqual(status.lastError?.code, "SSH_AGENT_UNAVAILABLE");
  assert.strictEqual(status.lastError?.message, agentMessage, "the actionable SSH-agent message is kept");
  agentAvailable = true;
  timers.shift().fn();
  status = service.getStatus("vps");
  assert.strictEqual(status.state, "connected", "the retry connects once the SSH agent is available");
  assert.strictEqual(configCalls, 2);
  service.stopAll();

  // Errors that need the user to act still stop retrying.
  timers.length = 0;
  const permanent = createNodeTunnelService({
    getNodes: () => [node],
    getSsh: () => ({ createUnattendedConnectConfig() { throw Object.assign(new Error("approve the host key"), { code: "SSH_HOST_KEY_NOT_APPROVED" }); } }),
    createServer: () => { const server = new EventEmitter(); server.listen = (_p, _h, callback) => callback(); server.close = () => {}; return server; },
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: () => {},
  });
  permanent.sync();
  assert.strictEqual(permanent.getStatus("vps").state, "failed");
  assert.strictEqual(timers.length, 0, "a permanent configuration error is not retried");
  permanent.stopAll();

  // sshService marks an unparseable key "retryable" (the user may retry after
  // fixing it); retrying it in the background would never succeed.
  const badKey = createNodeTunnelService({
    getNodes: () => [node],
    getSsh: () => ({ createUnattendedConnectConfig() { throw Object.assign(new Error("The private key could not be used."), { code: "SSH_PRIVATE_KEY_INVALID", retryable: true }); } }),
    createServer: () => { const server = new EventEmitter(); server.listen = (_p, _h, callback) => callback(); server.close = () => {}; return server; },
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: () => {},
  });
  badKey.sync();
  assert.strictEqual(badKey.getStatus("vps").state, "failed");
  assert.strictEqual(timers.length, 0, "a key the user must fix is not retried in the background");
  badKey.stopAll();
}

// agent-connectivity-4
async function checkEmptyTokenNoFallback() {
  setupIsolatedEnvironment("token");
  guardNetwork();
  fakeChildProcess();
  setPlatform("darwin");
  const LOCAL_TOKEN = `anxos_${"L".repeat(43)}`;
  const records = [];
  const server = http.createServer((request, response) => {
    records.push({ method: request.method, url: request.url, authorization: request.headers.authorization || null });
    response.writeHead(200, { "Content-Type": "application/json" });
    if (request.url === "/api/v1/system/agent-task") return response.end(JSON.stringify({ ok: true, matchesCanonicalDefinition: true, agentHealth: "healthy" }));
    response.end(JSON.stringify({ ok: true, service: "anxos-agent", apiVersion: "v1", protocolVersion: 1, tokenConfigured: true, tokenFingerprint: "000000000000", identity: { deviceId: "dev-remote", hostname: "Remote", agentVersion: "0.1.0", apiVersion: "v1", protocolVersion: 1 } }));
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const url = `http://127.0.0.1:${port}`;
  try {
    fs.writeFileSync(path.join(process.env.ANXHUB_CONFIG_DIR, "agent.json"), JSON.stringify({ backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: LOCAL_TOKEN }));
    const agentClient = require("../src/services/agentClient");
    const nodeService = require("../src/services/nodeService");
    assert.strictEqual(agentClient.readAgentSettings().agentToken, LOCAL_TOKEN, "test precondition: the Local Agent token is configured");
    const leaked = () => records.filter((entry) => String(entry.authorization || "").includes(LOCAL_TOKEN));

    await agentClient.getHealth(agentClient.normalizeAgentSettings({ backendMode: "agent", agentUrl: url, agentToken: "" }));
    assert.strictEqual(records.at(-1).authorization, null, "an explicit empty token must send no credential");

    fs.writeFileSync(nodeService.getNodesPath(), JSON.stringify({
      schemaVersion: nodeService.NODE_SCHEMA_VERSION,
      selectedNodeId: "application-host",
      nodes: [{ id: "remote", kind: "agent", displayName: "Remote", name: "Remote", agentUrl: url, baseUrl: url, enabled: true, agentIdentity: { deviceId: "dev-remote", hostname: "Remote", agentVersion: "0.1.0" } }],
      removedLocalAgents: [],
    }));
    const credential = await nodeService.getNodeCredentialStatus("remote");
    assert.strictEqual(credential.status, "missing");
    await nodeService.testNodeConnectionPayload({ displayName: "New", agentUrl: url, agentToken: "" });
    assert.deepStrictEqual(leaked(), [], "no node probe may carry the Local Agent token");

    // Authenticated calls to this PC's Local Agent still carry its credential.
    records.length = 0;
    const control = require("../src/services/agentControlService");
    control.saveConfig({ ...control.readConfig(), port, host: "127.0.0.1", restartPolicy: "never" });
    await agentClient.repairWindowsAgentTask(control._test.getLocalAgentHealthConfig(control.readConfig()));
    assert.strictEqual(records.at(-1).authorization, `Bearer ${LOCAL_TOKEN}`, "the Local Agent's own privileged calls stay authenticated");
    // A config with no token key still means "the configured Agent token".
    assert.strictEqual(agentClient.getAgentConfig({ backendMode: "agent", agentUrl: url }).token, LOCAL_TOKEN);
  } finally {
    server.close();
  }
}

// agent-connectivity-5
async function checkRemoteNodeVerified() {
  setupIsolatedEnvironment("remote");
  guardNetwork();
  fakeChildProcess();
  setPlatform("darwin");
  const { tokenFingerprint } = require("../src/shared/agentTokenStore");
  const LIVE_TOKEN = `anxos_${"R".repeat(43)}`;
  const STALE_TOKEN = `anxos_${"S".repeat(43)}`;
  const records = [];
  const server = http.createServer((request, response) => {
    const authorization = String(request.headers.authorization || "");
    records.push(`${request.method} ${request.url}`);
    response.writeHead(request.url === "/api/v1/health" || authorization === `Bearer ${LIVE_TOKEN}` ? 200 : 401, { "Content-Type": "application/json" });
    if (request.url === "/api/v1/health") {
      return response.end(JSON.stringify({ ok: true, service: "anxos-agent", apiVersion: "v1", protocolVersion: 1, tokenConfigured: true, tokenFingerprint: tokenFingerprint(LIVE_TOKEN), identity: { deviceId: "dev-r", hostname: "RemoteBox", agentVersion: "0.1.0", apiVersion: "v1", protocolVersion: 1 } }));
    }
    response.end(JSON.stringify(authorization === `Bearer ${LIVE_TOKEN}` ? { ok: true } : { error: { code: "UNAUTHORIZED", message: "Unauthorized." } }));
  });
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  const url = `http://127.0.0.1:${port}`;
  try {
    const nodeService = require("../src/services/nodeService");
    const credentials = require("../src/services/nodeCredentialStore");
    const control = require("../src/services/agentControlService");
    control.saveConfig({ ...control.readConfig(), port: await freePort(), host: "127.0.0.1", restartPolicy: "never" });
    fs.writeFileSync(nodeService.getNodesPath(), JSON.stringify({
      schemaVersion: nodeService.NODE_SCHEMA_VERSION,
      selectedNodeId: "application-host",
      nodes: [{ id: "agent-dev-r", kind: "agent", name: "RemoteBox", displayName: "RemoteBox", baseUrl: url, agentUrl: url, enabled: true, agentIdentity: { deviceId: "dev-r", hostname: "RemoteBox", agentVersion: "0.1.0" } }],
      removedLocalAgents: [],
    }));
    const rowFor = (listed) => listed.remote.find((row) => row.nodeId === "agent-dev-r");

    credentials.setNodeToken("agent-dev-r", STALE_TOKEN);
    const stale = rowFor(await control.listAgents({ nodeId: "application-host" }));
    assert.notStrictEqual(stale.agentStatus.state, "Connected", "a node whose credential is stale must not read Connected");
    assert.notStrictEqual(nodeService.getNode("agent-dev-r").connection?.authenticated, true, "a /health reply must not record the node as authenticated");

    // The good path still works without an extra protected request.
    credentials.setNodeToken("agent-dev-r", LIVE_TOKEN);
    records.length = 0;
    const live = rowFor(await control.listAgents({ nodeId: "application-host" }));
    assert.strictEqual(live.agentStatus.state, "Connected", "a node whose credential matches the live Agent reads Connected");
    assert.strictEqual(nodeService.getNode("agent-dev-r").connection?.authenticated, true);
    assert.deepStrictEqual(records, ["GET /api/v1/health"]);
  } finally {
    server.close();
  }
}

// agent-connectivity-6
async function checkRestartPolicy() {
  setupIsolatedEnvironment("restart");
  guardNetwork();
  setPlatform("darwin");
  const state = { agent: null, children: [] };
  fakeChildProcess({
    spawn() {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 6000 + state.children.length;
      child.exitCode = null;
      child.killed = false;
      child.exitWith = (code) => state.agent.stop().then(() => { child.exitCode = code; child.emit("exit", code, null); });
      child.kill = () => { child.killed = true; child.exitWith(1); return true; };
      state.children.push(child);
      state.agent.start();
      return child;
    },
  });
  const control = require("../src/services/agentControlService");
  const agentClient = require("../src/services/agentClient");
  const decide = control._test.shouldRestartManagedAgent;
  assert.strictEqual(typeof decide, "function", "shouldRestartManagedAgent must be exposed for tests");
  assert.strictEqual(decide({ policy: "on-failure", code: 1 }), true);
  assert.strictEqual(decide({ policy: "on-failure", code: null, signal: "SIGSEGV" }), true);
  assert.strictEqual(decide({ policy: "on-failure", code: 0 }), false);
  assert.strictEqual(decide({ policy: "always", code: 0 }), true);
  assert.strictEqual(decide({ policy: "always", code: 1 }), true);
  assert.strictEqual(decide({ policy: "never", code: 1 }), false);
  assert.strictEqual(decide({ policy: "on-failure", code: 1, intentionalStop: true }), false);
  assert.strictEqual(decide({ policy: "always", code: 0, intentionalStop: true }), false);

  const port = await freePort();
  control.saveConfig({ ...control.readConfig(), port, host: "127.0.0.1", restartPolicy: "on-failure" });
  require("../src/services/localAgentPairingService").pairLocalAgent({ agentUrl: `http://127.0.0.1:${port}`, reason: "smoke-initial" });
  state.agent = createFakeAgent({ port, readToken: () => agentClient.readAgentSettings().agentToken });
  await control.start();
  assert.strictEqual(state.children.length, 1);
  await state.children[0].exitWith(1);
  await until(() => state.children.length === 2 && state.agent.running, "the crashed Agent is restarted under the default policy", 6000);

  // An intentional stop is never undone by the restart policy. The automatic
  // start() may still be waiting for health, so retry while it is busy.
  await until(async () => {
    try {
      await control.stop();
      return true;
    } catch (error) {
      if (error.code === "AGENT_OPERATION_BUSY") return false;
      throw error;
    }
  }, "stop() after the automatic restart", 8000);
  await wait(1500);
  assert.strictEqual(state.children.length, 2, "stop() must not trigger a restart");
  assert.strictEqual(state.agent.running, false);
}

// agent-connectivity-7
// A task registered before the time-limit fix (PT72H, RestartCount 0) must
// still be run by Start: only the elevated task Agent can re-register it, and
// a desktop-spawned Agent is not elevated.
async function checkStartRunsDriftedTask() {
  setupIsolatedEnvironment("drifted-task");
  guardNetwork();
  setPlatform("win32");
  process.env.USERDOMAIN = "SMOKE";
  process.env.USERNAME = "user";
  const task = require("../src/shared/windowsAgentScheduledTask");
  const userId = task.getCurrentWindowsUser();
  const state = { agent: null, port: 0, pid: 6161 };
  const snapshot = () => ({
    found: true,
    taskName: "AnxOSAgent",
    taskPath: "\\",
    legacyTaskNames: [],
    actions: [{ execute: process.execPath, arguments: "--agent", workingDirectory: path.win32.dirname(process.execPath) }],
    principal: { userId, logonType: "Interactive", runLevel: "Highest" },
    triggers: [{ type: "MSFT_TaskLogonTrigger", userId, enabled: true }],
    settings: { enabled: true, startWhenAvailable: true, allowStartOnBatteries: true, stopOnBatteryTransition: false, multipleInstances: "IgnoreNew", executionTimeLimit: "PT72H", restartCount: 0 },
    state: state.agent?.running ? "Running" : "Ready",
  });
  const calls = fakeChildProcess({
    execFile(name, args) {
      const joined = args.join(" ");
      if (name === "powershell.exe" && joined.includes("Get-ScheduledTask")) return { stdout: JSON.stringify(snapshot()) };
      if (name === "netstat.exe") return { stdout: state.agent?.running ? `  TCP    127.0.0.1:${state.port}    0.0.0.0:0    LISTENING    ${state.pid}\r\n` : "" };
      if (name === "sc.exe") return { error: Object.assign(new Error("1060"), { code: 1060 }), stdout: "[SC] OpenService FAILED 1060" };
      if (name === "schtasks.exe" && args[0] === "/Run") return state.agent.start().then(() => ({ stdout: "SUCCESS" }));
      return null;
    },
  });
  const control = require("../src/services/agentControlService");
  const pairing = require("../src/services/localAgentPairingService");
  const agentClient = require("../src/services/agentClient");
  state.port = await freePort();
  control.saveConfig({ ...control.readConfig(), port: state.port, host: "127.0.0.1", restartPolicy: "never" });
  pairing.pairLocalAgent({ agentUrl: `http://127.0.0.1:${state.port}`, reason: "smoke-initial" });
  state.agent = createFakeAgent({ port: state.port, pid: state.pid, readToken: () => agentClient.readAgentSettings().agentToken });
  try {
    let failure = null;
    try { await control.start(); } catch (error) { failure = error; }
    assert(!calls.some((call) => call[0] === "spawn"), "start() must not spawn a non-elevated Agent while the elevated task can be run");
    assert(calls.some((call) => call[0] === "schtasks.exe" && call[1] === "/Run"), "start() must run the existing Agent task");
    assert.strictEqual(failure, null, `start() must succeed through the task, got ${failure?.code}: ${failure?.message}`);
    assert(state.agent.running, "the task Agent is running");
    const service = (await control.getStatus()).service;
    assert.strictEqual(service.registrationStatus, "invalid", "the outdated settings are still reported for repair");
    assert.deepStrictEqual(service.verification.mismatchReasons, ["execution-time-limit", "restart-on-failure"]);
  } finally {
    await state.agent.stop();
  }
}

// agent-connectivity-8
// SSH_AGENT_UNAVAILABLE is retried in "connecting", so a row that only shows
// lastError for "failed" hides the step the user must take.
async function checkTunnelRowShowsRetryReason() {
  const vm = require("vm");
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const labels = app.match(/const NODE_TUNNEL_STATE_LABELS = \{[\s\S]*?\n\};/);
  const describe = app.match(/function describeNodeRoute\(node\) \{[\s\S]*?\n\}/);
  assert(labels && describe, "describeNodeRoute and its labels must be found in app.js");
  const { createNodeTunnelService } = require("../src/services/nodeTunnelService");
  const timers = [];
  const agentMessage = "The OpenSSH Authentication Agent isn't running. Set the ssh-agent service to Automatic and start it.";
  const node = { id: "vps", kind: "agent", enabled: true, agentUrl: "http://127.0.0.1:47132", transport: { type: "ssh-tunnel", sshProfileId: "p1", remoteHost: "127.0.0.1", remotePort: 47131 } };
  const service = createNodeTunnelService({
    getNodes: () => [node],
    getSsh: () => ({ createUnattendedConnectConfig() { throw Object.assign(new Error(agentMessage), { code: "SSH_AGENT_UNAVAILABLE", retryable: true }); } }),
    createServer: () => { const server = new EventEmitter(); server.listen = (_p, _h, callback) => callback(); server.close = () => {}; return server; },
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
  });
  service.sync();
  timers.shift().fn();
  const status = service.getStatus("vps");
  service.stopAll();
  assert.strictEqual(status.state, "connecting", "the SSH-agent failure is still retried");
  const row = (tunnel) => vm.runInNewContext(`${labels[0]}; ${describe[0]}; describeNodeRoute(node);`, { node, nodeTunnelStatusById: new Map([[node.id, tunnel]]) });
  assert.strictEqual(row(status), `SSH tunnel · Connecting · ${agentMessage}`, "the row must say why the tunnel is still connecting");
  assert.strictEqual(row({ ...status, state: "reconnecting" }), `SSH tunnel · Reconnecting · ${agentMessage}`);
  assert.strictEqual(row({ state: "connected", lastError: null }), "SSH tunnel · Connected");
  assert.strictEqual(row({ state: "failed", lastError: { message: "approve the host key" } }), "SSH tunnel · Needs attention · approve the host key");
}

// agent-connectivity-9
// A new attempt must not show a reason it has already moved past: after the
// user approves a changed host key (or fixes a profile) and clicks Reconnect,
// or once a retried SSH-agent error clears, the handshake row has no reason.
// A dropped session still explains the retry's handshake.
async function checkTunnelRowDropsResolvedReason() {
  const vm = require("vm");
  const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const labels = app.match(/const NODE_TUNNEL_STATE_LABELS = \{[\s\S]*?\n\};/);
  const describe = app.match(/function describeNodeRoute\(node\) \{[\s\S]*?\n\}/);
  assert(labels && describe, "describeNodeRoute and its labels must be found in app.js");
  const { createNodeTunnelService } = require("../src/services/nodeTunnelService");
  const node = { id: "vps", kind: "agent", enabled: true, agentUrl: "http://127.0.0.1:47132", transport: { type: "ssh-tunnel", sshProfileId: "p1", remoteHost: "127.0.0.1", remotePort: 47131 } };
  const row = (tunnel) => vm.runInNewContext(`${labels[0]}; ${describe[0]}; describeNodeRoute(node);`, { node, nodeTunnelStatusById: new Map([[node.id, tunnel]]) });
  const makeService = (prepare) => {
    const timers = [];
    const clients = [];
    const service = createNodeTunnelService({
      getNodes: () => [node],
      getSsh: () => ({
        createUnattendedConnectConfig: prepare,
        // connect() never settles by itself: the test drives the handshake.
        createClient() { const client = new EventEmitter(); client.end = () => {}; client.connect = () => {}; clients.push(client); return client; },
      }),
      createServer: () => { const server = new EventEmitter(); server.listen = (_p, _h, callback) => callback(); server.close = () => {}; return server; },
      setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
      clearTimeout: (timer) => { const index = timers.indexOf(timer); if (index >= 0) timers.splice(index, 1); },
    });
    return { service, timers, clients };
  };

  // 1. Host key mismatch, the user approves the new key, then Reconnect.
  let mismatch = true;
  const hostKey = makeService(() => ({ connectConfig: { host: "node.example" }, hostKeyState: { mismatch } }));
  hostKey.service.sync();
  hostKey.clients[0].emit("error", Object.assign(new Error("host key"), { level: "client-authentication" }));
  let status = hostKey.service.getStatus("vps");
  assert.strictEqual(status.state, "failed");
  assert.strictEqual(status.lastError?.code, "SSH_HOST_KEY_MISMATCH");
  mismatch = false;
  hostKey.service.reconnect("vps");
  status = hostKey.service.getStatus("vps");
  assert.strictEqual(status.state, "connecting");
  assert.strictEqual(status.lastError, null, "the approved host-key error must not carry into the new attempt");
  assert.strictEqual(row(status), "SSH tunnel · Connecting");
  // The new attempt still reports its own failure.
  hostKey.clients[1].emit("error", Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }));
  status = hostKey.service.getStatus("vps");
  assert.notStrictEqual(status.lastError, null, "a failure of the new attempt is reported");
  assert.notStrictEqual(status.lastError.code, "SSH_HOST_KEY_MISMATCH");
  hostKey.service.stopAll();

  // 2. A permanent preparation error (missing profile), fixed, then Reconnect,
  //    after a tunnel that had connected once ("reconnecting").
  let profileMissing = false;
  const profile = makeService(() => {
    if (profileMissing) throw Object.assign(new Error("The SSH profile was not found."), { code: "SSH_PROFILE_NOT_FOUND" });
    return { connectConfig: { host: "node.example" }, hostKeyState: { mismatch: false } };
  });
  profile.service.sync();
  profile.clients[0].emit("ready");
  profileMissing = true;
  profile.clients[0].emit("close");
  assert.strictEqual(profile.service.getStatus("vps").state, "reconnecting");
  profile.timers.shift().fn();
  status = profile.service.getStatus("vps");
  assert.strictEqual(status.state, "failed");
  assert.strictEqual(status.lastError?.code, "SSH_PROFILE_NOT_FOUND");
  profileMissing = false;
  profile.service.reconnect("vps");
  status = profile.service.getStatus("vps");
  assert.strictEqual(status.state, "reconnecting");
  assert.strictEqual(row(status), "SSH tunnel · Reconnecting", "the fixed profile error must not carry into the new attempt");
  profile.service.stopAll();

  // 3. A retried SSH-agent error clears once preparation succeeds.
  let agentAvailable = false;
  const agent = makeService(() => {
    if (!agentAvailable) throw Object.assign(new Error("The OpenSSH Authentication Agent isn't running."), { code: "SSH_AGENT_UNAVAILABLE", retryable: true });
    return { connectConfig: { host: "node.example" }, hostKeyState: { mismatch: false } };
  });
  agent.service.sync();
  assert.strictEqual(agent.service.getStatus("vps").lastError?.code, "SSH_AGENT_UNAVAILABLE");
  agentAvailable = true;
  agent.timers.shift().fn();
  status = agent.service.getStatus("vps");
  assert.strictEqual(status.state, "connecting");
  assert.strictEqual(row(status), "SSH tunnel · Connecting", "the SSH agent is available again, so its error is no longer the reason");
  agent.service.stopAll();

  // 4. A dropped session keeps its reason through the retry's handshake, and
  //    a manual Reconnect while retrying keeps it too.
  const dropped = makeService(() => ({ connectConfig: { host: "node.example" }, hostKeyState: { mismatch: false } }));
  dropped.service.sync();
  dropped.clients[0].emit("ready");
  dropped.clients[0].emit("close");
  dropped.timers.shift().fn();
  status = dropped.service.getStatus("vps");
  assert.strictEqual(status.state, "reconnecting");
  assert.strictEqual(row(status), "SSH tunnel · Reconnecting · The SSH session to the node closed.");
  dropped.service.reconnect("vps");
  assert.strictEqual(row(dropped.service.getStatus("vps")), "SSH tunnel · Reconnecting · The SSH session to the node closed.");
  dropped.clients[dropped.clients.length - 1].emit("ready");
  assert.strictEqual(row(dropped.service.getStatus("vps")), "SSH tunnel · Connected");
  dropped.service.stopAll();
}

// ------------------------------------------------------------------ runner --

async function runCase(id) {
  const entry = CHECKS.find(([checkId]) => checkId === id);
  if (!entry) throw new Error(`unknown check ${id}`);
  await entry[2]();
}

async function main() {
  const caseIndex = process.argv.indexOf("--case");
  if (caseIndex >= 0) {
    await runCase(process.argv[caseIndex + 1]);
    process.exit(0);
  }
  const realSpawnSync = childProcess.spawnSync;
  let failed = 0;
  CHECKS.forEach(([id, label], index) => {
    const result = realSpawnSync(process.execPath, [__filename, "--case", id], { cwd: ROOT, encoding: "utf8", timeout: 120000, env: { ...process.env, AGENT_URL: "http://127.0.0.1:9" } });
    const ok = result.status === 0;
    if (!ok) failed += 1;
    console.log(`${ok ? "PASS" : "FAIL"} ${index + 1}. [${id}] ${label}`);
    if (!ok) {
      const detail = `${result.stderr || ""}${result.error ? `\n${result.error.message}` : ""}`.trim().split(/\r?\n/).filter((line) => !/^\[AnxOS\]/.test(line)).slice(-12).join("\n");
      console.log(detail.replace(/^/gm, "    "));
    }
  });
  console.log(`agent-connectivity-fixes-smoke: ${CHECKS.length - failed}/${CHECKS.length} passed (${CHECKS.length} checks)`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
