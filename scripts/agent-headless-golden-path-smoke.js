#!/usr/bin/env node
// Headless Agent golden path smoke (real runtime, isolated env).
//
// Boots the real Agent in a temp root with an ephemeral port, then walks the
// exact path a Control Center uses:
//   pairing/start -> generate token -> pairing/complete (as
//   nodeService.postPairingComplete does) -> authenticated health/stats with
//   x-agent-token -> enroll/complete -> provision a minimal self-contained
//   instance through the instance API -> start it -> observe healthy status ->
//   stop it -> restart the Agent and prove the paired credential and the
//   enrollment survived.
//
// The workload is the shared allowlisted fixture (a stdout readiness marker
// plus a long-lived process) so no game template or download is involved. The
// same marker drives the product's stdout readiness detection.
"use strict";

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const { waitForAgentReady } = require("./test-helpers/agent-readiness");
const { allowlistedCommand } = require("./test-helpers/allowlisted-executable");
const { generateAgentToken, tokenFingerprint } = require("../src/shared/agentTokenStore");

const rootDir = path.resolve(__dirname, "..");
const agentEntry = path.join(rootDir, "agent", "src", "server.js");

const smokeRoot = pinAgentRoots("anx-agent-golden-path-smoke-");
const configDir = process.env.ANXHUB_CONFIG_DIR;
const logDir = path.join(smokeRoot, "logs");
const instanceRoot = process.env.AGENT_INSTANCE_ROOT;
const backupRoot = path.join(smokeRoot, "backups");
const enrollmentPath = path.join(configDir, "enrollment.json");
const agentConfigPath = path.join(configDir, "agent.json");
const instanceId = "golden-path-smoke";
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(instanceRoot, { recursive: true });
fs.mkdirSync(backupRoot, { recursive: true });

const AGENT_TOKEN = `anxos_${"g".repeat(40)}`;
const agentChildren = new Set();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function agentEnv(port) {
  const env = { ...process.env };
  delete env.AGENT_URL;
  delete env.ANXOS_AGENT_RUNTIME_CONFIG;
  return {
    ...env,
    ANXHUB_CONFIG_DIR: configDir,
    ANXHUB_AGENT_CONFIG_PATH: agentConfigPath,
    AGENT_ENROLLMENT_PATH: enrollmentPath,
    AGENT_IDENTITY_PATH: path.join(smokeRoot, "device-identity.json"),
    AGENT_HOST: "127.0.0.1",
    AGENT_PORT: String(port),
    AGENT_INSTANCE_ROOT: instanceRoot,
    AGENT_BACKUP_ROOT: backupRoot,
    ANXOS_LOG_DIR: logDir,
    ANXOS_TEST_SHUTDOWN_IPC: "1",
  };
}

function seedAgentConfigFile(port) {
  fs.writeFileSync(
    agentConfigPath,
    `${JSON.stringify({ backendMode: "agent", agentUrl: `http://127.0.0.1:${port}`, agentToken: AGENT_TOKEN }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function spawnAgent(port) {
  const child = spawn(process.execPath, [agentEntry], {
    cwd: path.join(rootDir, "agent"),
    env: agentEnv(port),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  agentChildren.add(child);
  child.once("exit", () => agentChildren.delete(child));
  return child;
}

async function stopAgent(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    if (child.connected) child.send({ type: "shutdown" });
    else child.kill("SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
  const finished = await Promise.race([exited.then(() => true), wait(8000).then(() => false)]);
  if (!finished) {
    try { child.kill("SIGKILL"); } catch {}
    await Promise.race([exited, wait(3000)]);
  }
}

async function api(baseUrl, method, pathname, token, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { "x-agent-token": token } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

async function waitForInstanceState(baseUrl, token, predicate, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    const status = await api(baseUrl, "GET", `/api/v1/instances/${instanceId}/status`, token);
    assert.strictEqual(status.status, 200, `instance status must be readable (${label}).`);
    latest = status.body?.instance || null;
    if (latest && predicate(latest)) return latest;
    await wait(500);
  }
  assert.fail(`the instance did not reach ${label} in time; last state: ${JSON.stringify(latest)}`);
}

async function killInstanceProcessFromDisk() {
  try {
    const config = JSON.parse(fs.readFileSync(path.join(instanceRoot, instanceId, "config.json"), "utf8"));
    const pid = Number(config.pid);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  } catch {
    // No instance config or no live pid: nothing to clean up.
  }
}

async function main() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  seedAgentConfigFile(port);
  let child = spawnAgent(port);
  let childOutput = "";
  const collect = (chunk) => { childOutput += String(chunk); };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);

  const pairedToken = generateAgentToken();
  const fixture = allowlistedCommand({
    nodeScript: "console.log('Done (0.1s)! For help, type help');setInterval(function(){},1000);",
    shellScript: "echo 'Done (0.1s)! For help, type help'; exec sleep 300",
  });

  try {
    await waitForAgentReady({
      label: "golden path Agent",
      child,
      stderr: () => childOutput,
      probe: async () => (await fetch(`${baseUrl}/api/v1/health`)).ok,
    });

    // --- pairing exactly as nodeService.postPairingComplete does -----------
    const start = await api(baseUrl, "POST", "/api/v1/pairing/start", null, {});
    assert.strictEqual(start.status, 200, "pairing/start must open a session.");
    const complete = await api(baseUrl, "POST", "/api/v1/pairing/complete", null, { pairingCode: start.body.pairingCode, permanentToken: pairedToken });
    assert.strictEqual(complete.status, 200, `pairing/complete must succeed (got ${complete.status}: ${JSON.stringify(complete.body)}).`);
    assert.strictEqual(complete.body?.status, "paired", "pairing/complete must report the paired state.");

    const health = await api(baseUrl, "GET", "/api/v1/health", null);
    assert.strictEqual(health.status, 200, "health must be reachable after pairing.");
    const stats = await api(baseUrl, "GET", "/api/v1/stats", pairedToken);
    assert.strictEqual(stats.status, 200, "the paired credential must authorize stats (x-agent-token).");

    const enrollStart = await api(baseUrl, "POST", "/api/v1/enroll/start", null, {});
    const enrollComplete = await api(baseUrl, "POST", "/api/v1/enroll/complete", null, { enrollNonce: enrollStart.body.enrollNonce, agentToken: pairedToken });
    assert.strictEqual(enrollComplete.status, 200, `enroll/complete must record the enrollment (got ${enrollComplete.status}).`);
    assert.strictEqual((await api(baseUrl, "GET", "/api/v1/enroll/status", null)).body.state, "enrolled", "the node must be enrolled.");

    // --- provision a minimal self-contained instance ------------------------
    const created = await api(baseUrl, "POST", "/api/v1/instances", pairedToken, {
      id: instanceId,
      displayName: "Golden Path Smoke",
      type: "custom-command",
      executable: fixture.executable,
      args: fixture.args,
      workingDirectory: "data",
      restartPolicy: "never",
      startupTimeoutMs: 20000,
      shutdownTimeoutMs: 10000,
    });
    assert.strictEqual(created.status, 201, `instance creation must succeed (got ${created.status}: ${JSON.stringify(created.body)}).`);
    assert.strictEqual(created.body?.instance?.id, instanceId, "the created instance must report its id.");
    const listed = await api(baseUrl, "GET", "/api/v1/instances", pairedToken);
    assert.strictEqual(listed.status, 200, "the instance list must be readable with the credential.");
    assert((listed.body?.instances || []).some((entry) => entry.id === instanceId), "the provisioned instance must appear in the list.");

    // --- start and observe healthy ------------------------------------------
    const started = await api(baseUrl, "POST", `/api/v1/instances/${instanceId}/start`, pairedToken, {});
    assert.strictEqual(started.status, 200, `instance start must succeed (got ${started.status}: ${JSON.stringify(started.body)}).`);
    const healthyInstance = await waitForInstanceState(baseUrl, pairedToken, (instance) => instance.healthy === true, "healthy", 30000);
    assert.strictEqual(healthyInstance.healthState, "healthy", "the started instance must report healthState healthy.");
    assert.strictEqual(healthyInstance.processRunning, true, "the healthy instance must have a running process.");

    // --- stop it -------------------------------------------------------------
    const stopped = await api(baseUrl, "POST", `/api/v1/instances/${instanceId}/stop`, pairedToken, {});
    assert.strictEqual(stopped.status, 200, "instance stop must succeed.");
    const stoppedInstance = await waitForInstanceState(baseUrl, pairedToken, (instance) => instance.processRunning === false, "stopped", 30000);
    assert.strictEqual(stoppedInstance.processRunning, false, "the stopped instance must not keep a running process.");
    assert.notStrictEqual(stoppedInstance.healthState, "healthy", "a stopped instance must not report healthy.");

    // --- restart the Agent: credential + enrollment persist -----------------
    await stopAgent(child);
    assert.strictEqual(child.exitCode, 0, "the Agent must shut down cleanly under the test shutdown channel.");
    childOutput = "";
    child = spawnAgent(port);
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    await waitForAgentReady({
      label: "restarted golden path Agent",
      child,
      stderr: () => childOutput,
      probe: async () => (await fetch(`${baseUrl}/api/v1/health`)).ok,
    });

    const storedConfig = JSON.parse(fs.readFileSync(agentConfigPath, "utf8"));
    assert.strictEqual(tokenFingerprint(storedConfig.agentToken), tokenFingerprint(pairedToken), "the paired credential must persist in the Agent config across restart.");
    const restartedStats = await api(baseUrl, "GET", "/api/v1/stats", pairedToken);
    assert.strictEqual(restartedStats.status, 200, "the same credential must authorize after the Agent restart.");
    const restartedHealth = await api(baseUrl, "GET", "/api/v1/health", null);
    assert.strictEqual(restartedHealth.body?.tokenFingerprint, tokenFingerprint(pairedToken), "the restarted Agent must report the persisted credential fingerprint.");
    assert.strictEqual((await api(baseUrl, "GET", "/api/v1/enroll/status", null)).body.state, "enrolled", "the enrollment must survive the Agent restart.");
    const restartedInstances = await api(baseUrl, "GET", "/api/v1/instances", pairedToken);
    assert.strictEqual(restartedInstances.status, 200, "instances must be readable with the credential after restart.");
    assert((restartedInstances.body?.instances || []).some((entry) => entry.id === instanceId), "the instance must survive the Agent restart.");
    const restartedStatus = await api(baseUrl, "GET", `/api/v1/instances/${instanceId}/status`, pairedToken);
    assert.strictEqual(restartedStatus.body?.instance?.processRunning, false, "the stopped instance must not be resurrected by the restart.");

    assert(!childOutput.includes(pairedToken), "the Agent output must not contain the paired credential.");
    const logs = fs.readdirSync(logDir).filter((name) => name.endsWith(".log")).map((name) => fs.readFileSync(path.join(logDir, name), "utf8")).join("\n");
    assert(!logs.includes(pairedToken) && !logs.includes(AGENT_TOKEN), "the Agent logs must not contain credential material.");

    console.log("agent:golden-path:smoke passed — boot, pair, stats, enroll, provision, healthy, stop, restart persistence");
  } finally {
    try {
      if (child.exitCode === null && child.signalCode === null) {
        await api(baseUrl, "POST", `/api/v1/instances/${instanceId}/force-kill`, pairedToken, {}).catch(() => {});
      }
    } catch {}
    await killInstanceProcessFromDisk();
    await stopAgent(child);
  }
}

main().catch((error) => {
  console.error("agent:golden-path:smoke FAILED:", error.stack || error.message);
  process.exitCode = 1;
}).finally(async () => {
  for (const agentChild of agentChildren) {
    try { agentChild.kill("SIGKILL"); } catch {}
  }
  await killInstanceProcessFromDisk();
  try { fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch {}
});
