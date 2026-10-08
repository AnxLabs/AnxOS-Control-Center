"use strict";

// Starts the REAL Agent HTTP server with a service-managed ("systemd-service")
// instance whose systemd is a state file the test controls. Used by the smokes
// that prove the desktop service layer and the Electron UI against a real Agent.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const root = path.resolve(__dirname, "..", "..");
const INSTANCE_ID = "fivem-fxserver";
const UNIT = "anxrp-fxserver.service";

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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(file) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (attempt >= 20) throw error;
    }
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.driver.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  // Windows refuses to rename over a file the other process has open at that instant.
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(temp, file); return; } catch (error) {
      if (attempt >= 50 || !/^(EPERM|EBUSY|EACCES)$/.test(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

// Binaries the Agent legitimately launches on its own schedule, unrelated to any instance.
const BACKGROUND_HELPERS = /(?:^|[\\/])(?:docker|unzip|tar|xz|df|ss|ps|lsblk|uptime|uname|whoami|hostname|wmic|powershell|tasklist|netstat|ipconfig)(?:\.exe)?$/i;

const UNIT_STATES = {
  running: { activeState: "active", subState: "running", result: "success", mainPid: 4242, execMainStatus: 0, restartCount: 0, loadState: "loaded", unitFileState: "enabled", activeEnterTimestamp: "Tue 2026-10-06 10:00:00 UTC", activeEnterTimestampMs: Date.now() - 3600 * 1000 },
  stopped: { activeState: "inactive", subState: "dead", result: "success", mainPid: null, execMainStatus: 0, restartCount: 0, loadState: "loaded", unitFileState: "enabled", activeEnterTimestamp: "Tue 2026-10-06 10:00:00 UTC" },
  failed: { activeState: "failed", subState: "failed", result: "exit-code", mainPid: null, execMainStatus: 1, restartCount: 3, loadState: "loaded", unitFileState: "enabled", activeEnterTimestamp: "Tue 2026-10-06 10:00:00 UTC" },
  starting: { activeState: "activating", subState: "start", result: "success", mainPid: 4300, execMainStatus: 0, restartCount: 0, loadState: "loaded", unitFileState: "enabled", activeEnterTimestamp: "Tue 2026-10-06 10:00:00 UTC" },
};

async function startServiceManagedAgent(options = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-svcmanaged-"));
  const configDir = path.join(home, "config");
  const logDir = path.join(home, "logs");
  const instanceRoot = path.join(home, "instances");
  const instanceDir = path.join(instanceRoot, INSTANCE_ID);
  const stateFile = path.join(home, "fake-systemd.json");
  const token = options.token || `anxos_svc-managed-fixture-${crypto.randomBytes(12).toString("hex")}`;
  // Optional operations layer: a status file, a fake FXServer HTTP endpoint and listener state.
  const statusDir = path.join(home, "status");
  const statusFile = path.join(statusDir, "anxrp-status.json");
  let fxServer = null;
  let operationsConfig = null;
  const fxState = { clients: 0, roster: [], down: false };
  if (options.operations) {
    fs.mkdirSync(statusDir, { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify({ state: "READY", boot_id: "boot-1", framework: { version: "0.5.0" }, uptime_sec: 3600, sessions: { active: 0, total: 0, spawned: 0, with_character: 0 } }));
    fxServer = http.createServer((request, response) => {
      if (fxState.down) { request.socket.destroy(); return; }
      response.setHeader("content-type", "application/json");
      if (request.url === "/dynamic.json") response.end(JSON.stringify({ clients: fxState.clients }));
      else if (request.url === "/players.json") response.end(JSON.stringify(fxState.roster));
      else { response.statusCode = 404; response.end("{}"); }
    });
    await new Promise((resolve) => fxServer.listen(0, "127.0.0.1", resolve));
    const fxPort = fxServer.address().port;
    operationsConfig = {
      health: { kind: "anxrp-status-file", path: statusFile, maxAgeSeconds: 600 },
      players: { kind: "fxserver-http", baseUrl: `http://127.0.0.1:${fxPort}` },
      listeners: { ports: [30120], protocols: ["tcp", "udp"] },
      safeRestart: { timeoutSeconds: options.safeRestartTimeoutSeconds || 30 },
    };
  }
  for (const dir of [configDir, logDir, path.join(instanceDir, "data"), path.join(instanceDir, "logs")]) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(instanceDir, "config.json"), `${JSON.stringify({
    id: INSTANCE_ID,
    type: "systemd-service",
    templateId: options.templateId || "fivem",
    displayName: "AnxRP",
    serverSoftware: "FiveM FXServer",
    schemaVersion: 2,
    installationState: "active",
    serverVersion: "35805-6fd665a365f56c2582c36d8ffaf301b0b1d5764b",
    workingDirectory: "data",
    ports: [30120],
    autoStart: false,
    restartPolicy: "never",
    serviceManager: { kind: "systemd", unit: UNIT, ...(operationsConfig ? { operations: operationsConfig } : {}) },
  }, null, 2)}\n`);

  if (options.deployment) fs.writeFileSync(path.join(instanceDir, "deployment.json"), JSON.stringify(options.deployment, null, 2));
  // Ordinary (Agent-owned) instances alongside the service-managed one, for tests
  // that must prove nothing service-managed leaks into normal instances. They are
  // never started by these tests.
  for (const extraId of options.extraInstances || []) {
    const dir = path.join(instanceRoot, extraId);
    fs.mkdirSync(path.join(dir, "data"), { recursive: true });
    fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), `${JSON.stringify({
      id: extraId, displayName: "Plain Server", type: "custom-command", schemaVersion: 2, installationState: "active",
      workingDirectory: "data", executable: "node", args: ["-e", "0"], ports: [], environment: {}, autoStart: false,
      restartPolicy: "never", startupTimeoutMs: 15000, shutdownTimeoutMs: 10000, state: "Stopped",
    }, null, 2)}
`);
  }

  writeJsonAtomic(stateFile, {
    unit: { unit: UNIT, ...UNIT_STATES[options.initial || "running"] },
    calls: [],
    spawnAttempts: [],
    failDescribe: options.failDescribe || null,
    ...(options.operations ? {
      listeners: [{ port: 30120, protocol: "tcp" }, { port: 30120, protocol: "udp" }],
      world: { statusFile, bootNumber: 1, restarts: 0, ports: [30120], delays: options.worldDelays || { pid: 500, listeners: 900, ready: 1600 } },
    } : {}),
    journalError: null,
    journal: [
      { at: "2026-10-06T10:00:00+0000", stream: "journal", message: "fxserver started; api_key=hunter2secretvalue" },
      { at: "2026-10-06T10:00:05+0000", stream: "journal", message: "AnxRP READY" },
    ],
  });

  const port = await freePort();
  const agentJson = path.join(configDir, "agent.json");
  fs.writeFileSync(agentJson, `${JSON.stringify({ backendMode: "agent", agentUrl: `http://127.0.0.1:${port}`, agentToken: token }, null, 2)}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, ["--require", path.join(__dirname, "fake-systemd-preload.js"), path.join(root, "agent", "src", "server.js")], {
    cwd: path.join(root, "agent"),
    env: {
      ...process.env,
      FAKE_SYSTEMD_FILE: stateFile,
      AGENT_REPO_ROOT: root,
      ANXHUB_CONFIG_DIR: configDir,
      ANXHUB_AGENT_CONFIG_PATH: agentJson,
      AGENT_ENROLLMENT_PATH: path.join(configDir, "enrollment.json"),
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: String(port),
      AGENT_TOKEN: token,
      AGENT_IDENTITY_PATH: path.join(home, "identity.json"),
      AGENT_INSTANCE_ROOT: instanceRoot,
      AGENT_BACKUP_ROOT: path.join(home, "backups"),
      AGENT_FILE_ROOTS: home,
      ANXOS_LOG_DIR: logDir,
      AGENT_API_PERMISSIONS: options.permissions || "*",
      AGENT_API_RATE_LIMIT_PER_MINUTE: "20000",
      ...(options.operations ? { AGENT_SERVICE_STATUS_ROOTS: statusDir } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });

  const url = `http://127.0.0.1:${port}`;
  const headers = { "x-agent-token": token, authorization: `Bearer ${token}`, "content-type": "application/json" };
  async function api(method, pathname, body) {
    const response = await fetch(`${url}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, json, text };
  }

  let ready = false;
  for (let attempt = 0; attempt < 300 && !ready; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Agent exited early (${child.exitCode}): ${output.slice(-600)}`);
    try { ready = (await fetch(`${url}/api/v1/health`, { headers })).status === 200; } catch { ready = false; }
    if (!ready) await delay(100);
  }
  if (!ready) throw new Error(`Agent did not become ready: ${output.slice(-600)}`);

  let stopped = false;
  return {
    url,
    port,
    token,
    home,
    configDir,
    instanceId: INSTANCE_ID,
    unit: UNIT,
    recordPath: path.join(instanceDir, "config.json"),
    recordSha: () => crypto.createHash("sha256").update(fs.readFileSync(path.join(instanceDir, "config.json"))).digest("hex"),
    api,
    output: () => output,
    unitStates: Object.keys(UNIT_STATES),
    // Safe Restart world controls (operations: true).
    statusFile,
    setPlayers(count) {
      fxState.clients = count;
      fxState.roster = Array.from({ length: count }, (_, index) => ({ name: `Player ${index}`, identifiers: [`license:${index}`] }));
    },
    setFxDown(down) { fxState.down = Boolean(down); },
    setWorld(patch) {
      const state = readJson(stateFile);
      state.world = { ...state.world, ...patch };
      writeJsonAtomic(stateFile, state);
    },
    writeStatus(document) { fs.writeFileSync(statusFile, JSON.stringify(document)); },
    historyLines() {
      const file = path.join(instanceDir, "logs", "service-history.jsonl");
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
    },
    restartCalls: () => readJson(stateFile).calls.filter(([verb]) => verb === "restart"),
    setUnit(name) {
      const state = readJson(stateFile);
      state.unit = { unit: UNIT, ...UNIT_STATES[name] };
      writeJsonAtomic(stateFile, state);
    },
    patchState(patch) {
      writeJsonAtomic(stateFile, { ...readJson(stateFile), ...patch });
    },
    state: () => readJson(stateFile),
    controlCalls: () => readJson(stateFile).calls.filter(([verb]) => ["start", "stop", "restart"].includes(verb)),
    // Timestamped control calls since the fixture started (diagnostics for failing runs).
    callLog: () => readJson(stateFile).callLog || [],
    // Child processes the Agent launched, minus its own periodic background helpers
    // (Docker polling, archive probes, disk stats). Anything else is a failure.
    spawnAttempts: () => readJson(stateFile).spawnAttempts.filter((entry) => !BACKGROUND_HELPERS.test(entry.command)),
    rawSpawnAttempts: () => readJson(stateFile).spawnAttempts,
    clearRecords() {
      const state = readJson(stateFile);
      state.calls = [];
      state.spawnAttempts = [];
      writeJsonAtomic(stateFile, state);
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await Promise.race([exited, delay(5000)]);
      }
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      if (fxServer) await new Promise((resolve) => { fxServer.close(resolve); fxServer.closeAllConnections?.(); });
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

module.exports = { startServiceManagedAgent, INSTANCE_ID, UNIT };
