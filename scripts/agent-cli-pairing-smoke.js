#!/usr/bin/env node
// Headless Agent pairing smoke.
//
// Real runtime legs (isolated temp Agent, ephemeral port):
//   - `pair --json` code format (ANX-XXXX-XXXX-XXXX) and ~10 minute expiry;
//   - single-use: the first completion succeeds, a replay of the same code is
//     refused and cannot rebind the credential;
//   - a stale non-loopback `agentUrl` in agent.json with a loopback bind: the
//     mint falls back to loopback and the human output must still print the
//     loopback NOTICE (and `--json` must stay notice-free);
//   - a first enrollment is recorded through the real /enroll API, then a
//     non-loopback re-pair refusal is exercised against the REAL gate
//     (assertPairingAuthorization) with a synthetic remote address, because a
//     loopback TCP caller can never be non-loopback. The refusal must leave the
//     enrollment record, the credential, and the pairing session unchanged.
//
// In-process legs (no waiting on wall-clock expiry):
//   - pairing-flow expiry with an injected clock (no 10-minute sleep);
//   - the waiting -> paired and timeout state transitions;
//   - the typed PAIRING_REQUIRES_EXISTING_CREDENTIAL guidance (fake client);
//   - the rate-limit refusal path in the real route module (8 failed attempts
//     then 429), asserting the live session was not consumed.
"use strict";

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const { waitForAgentReady } = require("./test-helpers/agent-readiness");

const rootDir = path.resolve(__dirname, "..");
const cliPath = path.join(rootDir, "agent", "src", "cli.js");
const agentEntry = path.join(rootDir, "agent", "src", "server.js");

const smokeRoot = pinAgentRoots("anx-agent-cli-pairing-smoke-");
const configDir = process.env.ANXHUB_CONFIG_DIR;
const logDir = path.join(smokeRoot, "logs");
const instanceRoot = process.env.AGENT_INSTANCE_ROOT;
const enrollmentPath = path.join(configDir, "enrollment.json");
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(instanceRoot, { recursive: true });
process.env.ANXOS_LOG_DIR = logDir;
process.env.AGENT_ENROLLMENT_PATH = enrollmentPath;

const { generateAgentToken, tokenFingerprint } = require("../src/shared/agentTokenStore");
const { parsePairingCode } = require("../src/shared/agentPairing");
const { createPairingFlow, formatRemaining } = require("../agent/src/tui/pairing-flow");

const AGENT_TOKEN = `anxos_${"d".repeat(40)}`;
const PERMANENT_TOKEN = generateAgentToken();
const REPLAY_TOKEN = generateAgentToken();
const REMOTE = "198.51.100.21";
const RATE_LIMIT_REMOTE = "203.0.113.7";
const agentChildren = new Set();
const cliChildren = new Set();

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

function agentEnv(port, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.AGENT_URL;
  delete env.ANXOS_AGENT_RUNTIME_CONFIG;
  return {
    ...env,
    ANXHUB_CONFIG_DIR: configDir,
    ANXHUB_AGENT_CONFIG_PATH: path.join(configDir, "agent.json"),
    AGENT_ENROLLMENT_PATH: enrollmentPath,
    AGENT_IDENTITY_PATH: path.join(smokeRoot, "device-identity.json"),
    AGENT_HOST: "127.0.0.1",
    AGENT_PORT: String(port),
    AGENT_INSTANCE_ROOT: instanceRoot,
    AGENT_BACKUP_ROOT: path.join(smokeRoot, "backups"),
    ANXOS_LOG_DIR: logDir,
    ANXOS_TEST_SHUTDOWN_IPC: "1",
  };
}

// `resolveAgentConfigPath()` prefers an EXISTING candidate over a missing
// ANXHUB_AGENT_CONFIG_PATH, so the temp config file must exist before the Agent
// or CLI starts — otherwise a dev-machine config fixture elsewhere on the
// machine is read (and later rewritten by pairing).
function seedAgentConfigFile(port) {
  fs.writeFileSync(
    path.join(configDir, "agent.json"),
    `${JSON.stringify({ backendMode: "agent", agentUrl: `http://127.0.0.1:${port}`, agentToken: AGENT_TOKEN }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

// A stale non-loopback address that fails fast: the machine's own non-internal
// IPv4 with a closed port refuses immediately, and TEST-NET-2 is the fallback.
function findStaleAgentHost() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal && entry.address) return entry.address;
    }
  }
  return "198.51.100.77";
}

function runCli(args, env, port) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: smokeRoot,
      env: agentEnv(port, env),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    cliChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdin.end();
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 30000);
    child.once("close", (code) => {
      clearTimeout(timer);
      cliChildren.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

async function stopChild(child) {
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

async function postJson(baseUrl, pathname, body, token) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, body: payload };
}

async function readEnrollmentState(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/enroll/status`);
  return response.json();
}

function readAllLogs(directory) {
  let text = "";
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) text += `${fs.readFileSync(full, "utf8")}\n`;
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return text;
}

function fakeClient(overrides = {}) {
  return {
    pairingStart: async () => ({
      ok: true,
      baseUrl: "http://127.0.0.1:47131",
      body: { displayCode: "ANX-AAAA-BBBB-CCCC", pairingCode: "ANX-AAAA-BBBB-CCCC.payload", agentUrl: "http://127.0.0.1:47131", expiresAt: new Date(Date.now() + 600000).toISOString() },
    }),
    pairingStatus: async () => ({ ok: true, body: { status: "waiting" } }),
    pairingCancel: async () => ({ ok: true, body: { status: "not_paired" } }),
    health: async () => ({ ok: true, body: { tokenFingerprint: null } }),
    ...overrides,
  };
}

async function runFlowLegs() {
  // Expired session via injected clock: no 10-minute wait.
  const future = Date.now() + 11 * 60 * 1000;
  const expiredFlow = createPairingFlow({
    client: fakeClient({
      pairingStart: async () => ({
        ok: true,
        baseUrl: "http://127.0.0.1:47131",
        body: { displayCode: "ANX-EXPD-EXPD-EXPD", pairingCode: "ANX-EXPD-EXPD-EXPD.payload", agentUrl: "http://127.0.0.1:47131", expiresAt: new Date(Date.now() - 60000).toISOString() },
      }),
    }),
    now: () => future,
    sleep: () => { throw new Error("an expired session must never sleep/poll for wall-clock time."); },
  });
  const started = await expiredFlow.start();
  assert.strictEqual(started.status, "waiting", "a session started before its expiry is applied must report waiting.");
  const expired = await expiredFlow.refresh();
  assert.strictEqual(expired.status, "expired", "an expired session must be classified as expired by the injected clock.");
  assert.strictEqual(formatRemaining(expired.remainingMs), "expired", "an expired session must report no remaining time.");
  const expiredFinal = await expiredFlow.waitForCompletion({ timeoutMs: 1000 });
  assert.strictEqual(expiredFinal.status, "expired", "waitForCompletion must return expired immediately when the clock is past expiry.");

  // Waiting -> paired and timeout transitions.
  let statusCalls = 0;
  const pairedFlow = createPairingFlow({
    client: fakeClient({
      pairingStatus: async () => {
        statusCalls += 1;
        return statusCalls >= 2 ? { ok: true, body: { status: "not_paired" } } : { ok: true, body: { status: "waiting" } };
      },
      health: async () => ({ ok: true, body: { tokenFingerprint: "fingerprint123" } }),
    }),
    sleep: () => Promise.resolve(),
    pollIntervalMs: 250,
  });
  await pairedFlow.start();
  const paired = await pairedFlow.waitForCompletion({ timeoutMs: 5000 });
  assert.strictEqual(paired.status, "paired", "a session consumed on the Agent must become paired.");
  assert.strictEqual(paired.tokenFingerprint, "fingerprint123", "the paired state must carry the credential fingerprint, never the credential.");

  const timeoutFlow = createPairingFlow({
    client: fakeClient(),
    pollIntervalMs: 250,
  });
  await timeoutFlow.start();
  const timedOut = await timeoutFlow.waitForCompletion({ timeoutMs: 600 });
  assert.strictEqual(timedOut.status, "timeout", "a session that outlives the requested wait must be classified as timeout.");
  assert(timedOut.remainingMs > 0, "a timed-out (not expired) session must still have time remaining.");

  // Typed guidance for the enrolled-node refusal, at the flow/client level.
  const gateFlow = createPairingFlow({
    client: fakeClient({
      pairingStart: async () => {
        const error = new Error("This Agent is already enrolled. Re-pairing it over the network requires the existing Agent credential.");
        error.code = "PAIRING_REQUIRES_EXISTING_CREDENTIAL";
        error.statusCode = 403;
        throw error;
      },
    }),
  });
  const gated = await gateFlow.start();
  assert.strictEqual(gated.status, "error", "an enrolled-node refusal must surface as a typed pairing error.");
  assert.strictEqual(gated.error?.code, "PAIRING_REQUIRES_EXISTING_CREDENTIAL", "the typed refusal code must be preserved.");
  assert(/existing Agent credential/i.test(gated.error?.hint || ""), "the refusal must carry actionable guidance.");
  assert(/sudo/i.test(gated.error?.hint || ""), "the refusal guidance must name the sudo/owner remediation.");

  console.log("pairing-flow legs passed: expiry (injected clock), paired, timeout, and typed refusal guidance");
}

async function runRateLimitLeg() {
  const pairingRoute = require("../agent/src/routes/pairing");
  pairingRoute._test.reset();
  const request = (remoteAddress, body) => ({ method: "POST", url: "/api/v1/pairing/complete", socket: { remoteAddress }, headers: {}, body: JSON.stringify(body) });
  const session = pairingRoute._test.createSession({ method: "POST", url: "/api/v1/pairing/start", socket: { remoteAddress: RATE_LIMIT_REMOTE }, headers: {} }, {});
  assert(session.pairingCode && session.active, "the route module must open a pairing session for the rate-limit leg.");
  const config = {};
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    await assert.rejects(
      async () => pairingRoute._test.completePairing(request(RATE_LIMIT_REMOTE, { pairingCode: "ANX-WRNG-WRNG-WRNG", permanentToken: generateAgentToken() }), config),
      (error) => error.code === "PAIRING_REJECTED" && error.statusCode === 401,
      `failed attempt ${attempt} must be refused as a rejected session.`,
    );
  }
  await assert.rejects(
    async () => pairingRoute._test.completePairing(request(RATE_LIMIT_REMOTE, { pairingCode: "ANX-WRNG-WRNG-WRNG", permanentToken: generateAgentToken() }), config),
    (error) => {
      assert.strictEqual(error.code, "PAIRING_RATE_LIMITED", `the 9th attempt must be rate limited, got ${error.code || error.message}.`);
      assert.strictEqual(error.statusCode, 429, "the rate-limit refusal must use HTTP 429.");
      return true;
    },
    "the rate limit must refuse further attempts.",
  );
  const stillActive = pairingRoute._test.safeSession();
  assert(stillActive.active && stillActive.pairingCode === session.pairingCode, "a rate-limited refusal must not consume or alter the live session.");
  pairingRoute._test.reset();
  console.log("rate-limit leg passed: 8 rejected attempts then 429, with the live session untouched");
}

async function runSpawnedAgentLegs() {
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  seedAgentConfigFile(port);
  const child = spawn(process.execPath, [agentEntry], {
    cwd: path.join(rootDir, "agent"),
    env: agentEnv(port, { AGENT_TOKEN }),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  agentChildren.add(child);
  let childOutput = "";
  child.stdout.on("data", (chunk) => { childOutput += String(chunk); });
  child.stderr.on("data", (chunk) => { childOutput += String(chunk); });
  try {
    await waitForAgentReady({
      label: "pairing smoke Agent",
      child,
      stderr: () => childOutput,
      probe: async () => (await fetch(`${baseUrl}/api/v1/health`)).ok,
    });

    // --- pair --json: format + ~10 minute expiry ---------------------------
    const pair = await runCli(["pair", "--json"], { AGENT_TOKEN }, port);
    assert.strictEqual(pair.code, 0, `pair --json must exit 0 (stderr: ${pair.stderr}).`);
    const session = JSON.parse(pair.stdout);
    // P1-B (Build 205): machine-readable output stays clean; the loopback
    // warning is human-output only.
    assert(!pair.stdout.includes("NOTICE"), "pair --json must stay machine-readable without the human loopback notice.");
    assert.strictEqual(session.state, "waiting", "pair --json must report a waiting session.");
    assert(/^ANX-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(session.displayCode), `the code must use ANX-XXXX-XXXX-XXXX, got ${session.displayCode}.`);
    assert(session.pairingCode?.startsWith(`${session.displayCode}.`), "the machine code must embed the display code.");
    const remainingMs = Date.parse(session.expiresAt) - Date.now();
    assert(remainingMs > 9 * 60 * 1000 && remainingMs <= 10.5 * 60 * 1000, `the code must expire ~10 minutes out, got ${Math.round(remainingMs / 1000)}s.`);
    assert(!pair.stdout.includes(AGENT_TOKEN) && !pair.stderr.includes(AGENT_TOKEN), "pair output must not contain the Agent credential.");
    assert(!(pair.stdout + pair.stderr).includes("anxos_"), "pair output must not contain credential-looking literals.");

    // --- single use: first complete succeeds, replay is refused ------------
    const first = await postJson(baseUrl, "/api/v1/pairing/complete", { pairingCode: session.pairingCode, permanentToken: PERMANENT_TOKEN });
    assert.strictEqual(first.status, 200, `the first pairing completion must succeed (got ${first.status}).`);
    assert.strictEqual(first.body?.status, "paired", "the first completion must report paired.");

    const replay = await postJson(baseUrl, "/api/v1/pairing/complete", { pairingCode: session.pairingCode, permanentToken: REPLAY_TOKEN });
    assert.strictEqual(replay.status, 401, "replaying a consumed pairing code must be refused.");
    assert.strictEqual(replay.body?.error?.code, "PAIRING_REJECTED", "a replay must be a typed session rejection.");
    const replayAuthorized = await fetch(`${baseUrl}/api/v1/instances`, { headers: { Authorization: `Bearer ${REPLAY_TOKEN}` } });
    assert.strictEqual(replayAuthorized.status, 401, "a replayed credential must not authorize requests.");
    const originalAuthorized = await fetch(`${baseUrl}/api/v1/instances`, { headers: { Authorization: `Bearer ${PERMANENT_TOKEN}` } });
    assert.strictEqual(originalAuthorized.status, 200, "the first credential must keep working after a replay attempt.");

    // --- enroll through the real API, then prove the non-loopback gate -----
    const enrollStart = await postJson(baseUrl, "/api/v1/enroll/start", {}, null);
    assert.strictEqual(enrollStart.status, 200, "enroll/start must serve the handshake.");
    const enrollComplete = await postJson(baseUrl, "/api/v1/enroll/complete", { enrollNonce: enrollStart.body.enrollNonce, agentToken: PERMANENT_TOKEN }, null);
    assert.strictEqual(enrollComplete.status, 200, `enroll/complete must record the enrollment (got ${enrollComplete.status}: ${JSON.stringify(enrollComplete.body)}).`);
    assert.strictEqual((await readEnrollmentState(baseUrl)).state, "enrolled", "the Agent must report the enrolled state.");

    const enrollmentBefore = fs.readFileSync(enrollmentPath, "utf8");
    const configBefore = fs.readFileSync(path.join(configDir, "agent.json"), "utf8");
    const pairingRoute = require("../agent/src/routes/pairing");
    pairingRoute._test.reset();
    assert.throws(
      () => pairingRoute._test.assertPairingAuthorization(
        { method: "POST", url: "/api/v1/pairing/start", socket: { remoteAddress: REMOTE }, headers: {}, body: "" },
        {},
      ),
      (error) => {
        assert.strictEqual(error.code, "PAIRING_REQUIRES_EXISTING_CREDENTIAL", `a non-loopback re-pair of an enrolled node must be refused with the typed code, got ${error.code || error.message}.`);
        assert.strictEqual(error.statusCode, 403, "the enrolled-node refusal must use HTTP 403.");
        return true;
      },
      "a non-loopback re-pair of an enrolled node must be refused.",
    );
    assert.strictEqual(fs.readFileSync(enrollmentPath, "utf8"), enrollmentBefore, "the refusal must not change the enrollment record.");
    assert.strictEqual(fs.readFileSync(path.join(configDir, "agent.json"), "utf8"), configBefore, "the refusal must not change the stored credential.");
    assert.strictEqual((await readEnrollmentState(baseUrl)).state, "enrolled", "the refusal must not change the Agent's enrollment state.");
    const stillAuthorized = await fetch(`${baseUrl}/api/v1/instances`, { headers: { Authorization: `Bearer ${PERMANENT_TOKEN}` } });
    assert.strictEqual(stillAuthorized.status, 200, "the credential must keep working after a refused re-pair attempt.");
    const sessionState = pairingRoute._test.safeSession();
    assert.strictEqual(sessionState.active, false, "a refused non-loopback start must not create a pairing session.");

    // --- what the human `pair` output shows must redeem exactly -------------
    // The CLI prints the FULL pairing code (the only value Control Center's Add
    // Computer accepts); redeeming that exact printed string proves the
    // journey is completable. Whitespace from terminal wrapping is stripped by
    // normalizePairingCode, so a wrapped paste is equivalent.
    const humanToken = generateAgentToken();
    const humanPair = await runCli(["pair"], { AGENT_TOKEN }, port);
    assert.strictEqual(humanPair.code, 0, `human pair must exit 0 (stderr: ${humanPair.stderr}).`);
    assert(humanPair.stdout.includes("Pairing code (paste into Add Computer):"), "the human pair output must label the full code as the code to paste.");
    // P1-B (Build 205): a loopback-only mint must warn with the exact remedy
    // BEFORE the code, so the linear journey cannot dead-end at "expired".
    assert(humanPair.stdout.includes("NOTICE: This Agent is reachable on this computer only (loopback)."), "the human pair output must warn when the code is loopback-only.");
    assert(humanPair.stdout.indexOf("NOTICE:") < humanPair.stdout.indexOf("Pairing code (paste into Add Computer):"), "the loopback notice must appear before the pairing code.");
    assert(humanPair.stdout.includes("sudo anxos-agent"), "the loopback notice must include the TUI network opt-in remedy.");
    assert(humanPair.stdout.includes("/etc/anxos-agent/agent.env"), "the loopback notice must include the AGENT_HOST remedy.");
    const humanCodeLine = humanPair.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^ANX-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}\.[A-Za-z0-9_-]+$/.test(line));
    assert(humanCodeLine, `the human pair output must print the full pairing code on its own line (stdout: ${JSON.stringify(humanPair.stdout.slice(0, 400))}).`);
    const humanParsed = parsePairingCode(humanCodeLine);
    assert.strictEqual(humanParsed.agentUrl, baseUrl, "the printed full code must carry this Agent's address.");
    assert(humanPair.stdout.includes(`Reference code: ${humanParsed.displayCode}`), "the human pair output must show the short reference code separately.");
    assert(!(humanPair.stdout + humanPair.stderr).includes(humanToken), "the human pair output must not contain a credential.");
    assert(!(humanPair.stdout + humanPair.stderr).includes("anxos_"), "the human pair output must not contain credential-looking literals.");
    const humanComplete = await postJson(baseUrl, "/api/v1/pairing/complete", { pairingCode: humanCodeLine, permanentToken: humanToken });
    assert.strictEqual(humanComplete.status, 200, `redeeming the human-printed code must succeed (got ${humanComplete.status}: ${JSON.stringify(humanComplete.body)}).`);
    assert.strictEqual(humanComplete.body?.status, "paired", "the human-printed code must complete a real pairing.");
    const humanAuthorized = await fetch(`${baseUrl}/api/v1/instances`, { headers: { Authorization: `Bearer ${humanToken}` } });
    assert.strictEqual(humanAuthorized.status, 200, "the credential installed from the human-printed code must authorize requests.");

    // --- stale non-loopback agentUrl: fallback must not silence the notice --
    // The stored address is non-loopback and unreachable while the Agent binds
    // loopback, so pairingStart falls through to the loopback candidate. The
    // pre-mint resolveConnection() then still reports loopbackOnly=false; the
    // notice must come from the address the session actually returned.
    const staleAgentUrl = `http://${findStaleAgentHost()}:${port}`;
    fs.writeFileSync(
      path.join(configDir, "agent.json"),
      `${JSON.stringify({ schemaVersion: 1, backendMode: "agent", agentUrl: staleAgentUrl, agentToken: AGENT_TOKEN }, null, 2)}\n`,
      { mode: 0o600 },
    );

    const staleJson = await runCli(["pair", "--json"], { AGENT_TOKEN }, port);
    assert.strictEqual(staleJson.code, 0, `pair --json must exit 0 with a stale agentUrl (stderr: ${staleJson.stderr}).`);
    const staleSession = JSON.parse(staleJson.stdout);
    assert(!staleJson.stdout.includes("NOTICE"), "pair --json must stay machine-readable with a stale agentUrl.");
    assert(/^http:\/\/127\.0\.0\.1:/.test(staleSession.agentUrl || ""), `the stale-URL mint must fall back to loopback, got ${staleSession.agentUrl}.`);

    const staleHuman = await runCli(["pair"], { AGENT_TOKEN }, port);
    assert.strictEqual(staleHuman.code, 0, `human pair must exit 0 with a stale agentUrl (stderr: ${staleHuman.stderr}).`);
    assert(staleHuman.stdout.includes("NOTICE: This Agent is reachable on this computer only (loopback)."), "a loopback mint must print the notice even when a stale non-loopback agentUrl exists.");
    assert(staleHuman.stdout.indexOf("NOTICE:") < staleHuman.stdout.indexOf("Pairing code (paste into Add Computer):"), "the stale-URL notice must appear before the pairing code.");
    assert(staleHuman.stdout.includes("sudo anxos-agent"), "the stale-URL notice must include the TUI network opt-in remedy.");
    assert(staleHuman.stdout.includes("/etc/anxos-agent/agent.env"), "the stale-URL notice must include the AGENT_HOST remedy.");
    const staleCodeLine = staleHuman.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^ANX-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}\.[A-Za-z0-9_-]+$/.test(line));
    assert(staleCodeLine, `the stale-URL human output must print the full pairing code on its own line (stdout: ${JSON.stringify(staleHuman.stdout.slice(0, 400))}).`);
    assert.strictEqual(parsePairingCode(staleCodeLine).agentUrl, baseUrl, "the stale-URL notice must accompany a loopback code, proving the fallback happened.");
    const staleComplete = await postJson(baseUrl, "/api/v1/pairing/complete", { pairingCode: staleCodeLine, permanentToken: generateAgentToken() });
    assert.strictEqual(staleComplete.status, 200, `the stale-URL loopback code must still redeem locally (got ${staleComplete.status}).`);
    console.log("stale-URL legs passed: a non-loopback stored agentUrl that falls back to loopback still prints the notice (human) and stays notice-free in --json");

    assert(!childOutput.includes(PERMANENT_TOKEN) && !childOutput.includes(REPLAY_TOKEN) && !childOutput.includes(humanToken), "the Agent output must not contain credential material.");
    const agentLogs = readAllLogs(logDir);
    assert(agentLogs.length > 0, "the spawned Agent must have written logs into the isolated log dir.");
    assert(!agentLogs.includes(PERMANENT_TOKEN) && !agentLogs.includes(REPLAY_TOKEN) && !agentLogs.includes(humanToken), "the Agent logs must not contain credential material.");
    console.log("spawned-agent legs passed: code format/expiry, single-use replay refusal, enrolled-node gate refusal with no state change, human-printed code redemption");

    await stopChild(child);
    assert.strictEqual(child.exitCode, 0, "the Agent must shut down cleanly under the test shutdown channel.");
  } finally {
    await stopChild(child);
  }
}

// ---------------------------------------------------------------------------
// Restart provenance (the live defect): a freshly installed packaged Agent
// generates its own credential on first start. On the SECOND start that
// credential resolves as "shared-config" and used to be auto-migrated into an
// enrollment record the Control Center never issued, which then made remote
// pairing impossible (PAIRING_REQUIRES_EXISTING_CREDENTIAL for both /start and
// /complete). tokenOrigin=generated must survive restarts and keep the node
// unenrolled until an explicit pairing/enrollment adopts the credential.
// ---------------------------------------------------------------------------
async function runRestartProvenanceLegs() {
  const pairingRoute = require("../agent/src/routes/pairing");
  const provenanceRoot = path.join(smokeRoot, "provenance");
  const provenanceConfigDir = path.join(provenanceRoot, "config");
  const provenanceLogDir = path.join(provenanceRoot, "logs");
  const provenanceInstanceRoot = path.join(provenanceRoot, "instances");
  const provenanceConfigPath = path.join(provenanceConfigDir, "agent.json");
  const provenanceEnrollmentPath = path.join(provenanceConfigDir, "enrollment.json");
  fs.mkdirSync(provenanceConfigDir, { recursive: true });
  fs.mkdirSync(provenanceLogDir, { recursive: true });
  fs.mkdirSync(provenanceInstanceRoot, { recursive: true });

  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const outputs = [];

  // resolveAgentConfigPath() prefers an EXISTING candidate, so the isolated
  // config file must exist before the first boot — otherwise the Agent reads
  // (and may rewrite) the repo's agent/config/agent.json. An empty token is the
  // fresh-install state: the Agent generates and persists its own credential.
  fs.writeFileSync(
    provenanceConfigPath,
    `${JSON.stringify({ schemaVersion: 1, backendMode: "agent", agentUrl: baseUrl, agentToken: "" }, null, 2)}\n`,
    { mode: 0o600 },
  );

  function provenanceEnv() {
    const env = agentEnv(port);
    delete env.AGENT_TOKEN;
    return {
      ...env,
      ANXHUB_CONFIG_DIR: provenanceConfigDir,
      ANXHUB_AGENT_CONFIG_PATH: provenanceConfigPath,
      AGENT_ENROLLMENT_PATH: provenanceEnrollmentPath,
      AGENT_IDENTITY_PATH: path.join(provenanceRoot, "device-identity.json"),
      AGENT_INSTANCE_ROOT: provenanceInstanceRoot,
      AGENT_BACKUP_ROOT: path.join(provenanceRoot, "backups"),
      ANXOS_LOG_DIR: provenanceLogDir,
    };
  }

  async function bootAgent(label) {
    const child = spawn(process.execPath, [agentEntry], {
      cwd: path.join(rootDir, "agent"),
      env: provenanceEnv(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    agentChildren.add(child);
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    outputs.push(() => output);
    await waitForAgentReady({
      label,
      child,
      stderr: () => output,
      probe: async () => (await fetch(`${baseUrl}/api/v1/health`)).ok,
    });
    return child;
  }

  let child = null;
  try {
    // --- Boot 1: fresh install, self-generated credential -------------------
    child = await bootAgent("provenance Agent boot 1");
    const firstPairingStatus = await (await fetch(`${baseUrl}/api/v1/pairing/status`)).json();
    assert.strictEqual(firstPairingStatus.status, "not_paired", "a fresh Agent must report not_paired.");
    assert.strictEqual((await readEnrollmentState(baseUrl)).state, "unenrolled", "a fresh Agent must be unenrolled.");
    await stopChild(child);
    assert.strictEqual(child.exitCode, 0, "the provenance Agent must shut down cleanly after boot 1.");
    const generatedConfig = JSON.parse(fs.readFileSync(provenanceConfigPath, "utf8"));
    assert.strictEqual(generatedConfig.tokenOrigin, "generated", "a self-generated credential must persist tokenOrigin=generated.");
    assert(generatedConfig.agentToken && generatedConfig.agentToken.length > 30, "the generated credential must be persisted.");
    assert(!fs.existsSync(provenanceEnrollmentPath), "a self-generated credential must not create an enrollment record.");

    // --- Boot 2 (the defect): restart must NOT auto-enroll it ---------------
    child = await bootAgent("provenance Agent boot 2");
    const secondPairingStatus = await (await fetch(`${baseUrl}/api/v1/pairing/status`)).json();
    assert.strictEqual(secondPairingStatus.status, "not_paired", "a restart must not consume pairing availability by auto-enrolling the generated credential.");
    assert.strictEqual((await readEnrollmentState(baseUrl)).state, "unenrolled", "a restart must not enroll a self-generated credential.");
    assert(!fs.existsSync(provenanceEnrollmentPath), "a restart must not write an enrollment record for a self-generated credential.");
    assert.strictEqual(JSON.parse(fs.readFileSync(provenanceConfigPath, "utf8")).tokenOrigin, "generated", "a restart must not rewrite the generated provenance.");

    // Remote bootstrap must still work: a non-loopback caller sees no record
    // (simulated the way the credential-gate smoke does; a loopback TCP caller
    // can never be non-loopback).
    const previousEnrollmentPath = process.env.AGENT_ENROLLMENT_PATH;
    process.env.AGENT_ENROLLMENT_PATH = provenanceEnrollmentPath;
    try {
      pairingRoute._test.reset();
      const authorization = pairingRoute._test.assertPairingAuthorization(
        { method: "POST", url: "/api/v1/pairing/start", socket: { remoteAddress: REMOTE }, headers: {}, body: "" },
        {},
      );
      assert.strictEqual(authorization.mode, "bootstrap-or-recovery", "a non-loopback pairing start must stay allowed while no record exists.");
    } finally {
      if (previousEnrollmentPath === undefined) delete process.env.AGENT_ENROLLMENT_PATH;
      else process.env.AGENT_ENROLLMENT_PATH = previousEnrollmentPath;
    }

    // --- Real bootstrap over HTTP, then pairing clears provenance -----------
    const start = await postJson(baseUrl, "/api/v1/pairing/start", {}, null);
    assert.strictEqual(start.status, 200, `the real pairing start must succeed on a restarted fresh Agent (got ${start.status}).`);
    const complete = await postJson(baseUrl, "/api/v1/pairing/complete", { pairingCode: start.body.pairingCode, permanentToken: PERMANENT_TOKEN }, null);
    assert.strictEqual(complete.status, 200, `pairing/complete must succeed (got ${complete.status}).`);
    const pairedConfig = JSON.parse(fs.readFileSync(provenanceConfigPath, "utf8"));
    assert.strictEqual(pairedConfig.tokenOrigin, "pairing", "completing a pairing must persist tokenOrigin=pairing, clearing generated.");

    // --- Explicit enrollment, then restart with an intact record ------------
    const enrollStart = await postJson(baseUrl, "/api/v1/enroll/start", {}, null);
    assert.strictEqual(enrollStart.status, 200, "enroll/start must serve the handshake.");
    const enrollComplete = await postJson(baseUrl, "/api/v1/enroll/complete", { enrollNonce: enrollStart.body.enrollNonce, agentToken: PERMANENT_TOKEN }, null);
    assert.strictEqual(enrollComplete.status, 200, `enroll/complete must record the enrollment (got ${enrollComplete.status}: ${JSON.stringify(enrollComplete.body)}).`);
    const recordBefore = JSON.parse(fs.readFileSync(provenanceEnrollmentPath, "utf8"));
    assert.strictEqual(recordBefore.state, "enrolled", "the explicit enrollment must be recorded.");
    assert.strictEqual(recordBefore.legacyMigrated, false, "an explicit enrollment must not be flagged as a legacy migration.");
    const enrollmentIdBefore = recordBefore.enrollmentId;
    assert.strictEqual(JSON.parse(fs.readFileSync(provenanceConfigPath, "utf8")).tokenOrigin, "enrollment", "enrolling must persist tokenOrigin=enrollment.");

    await stopChild(child);
    child = await bootAgent("provenance Agent boot 3");
    const restartedStatus = await readEnrollmentState(baseUrl);
    assert.strictEqual(restartedStatus.state, "enrolled", "an explicit enrollment must survive the restart.");
    assert.strictEqual(restartedStatus.enrollmentId, enrollmentIdBefore, "a restart with an intact record must not create a second enrollment record.");
    const recordAfter = JSON.parse(fs.readFileSync(provenanceEnrollmentPath, "utf8"));
    assert.strictEqual(recordAfter.enrollmentId, enrollmentIdBefore, "the persisted record must keep its enrollmentId across the restart.");
    assert.strictEqual(recordAfter.legacyMigrated, false, "the restart must not convert an explicit enrollment into a migrated one.");
    assert.strictEqual((await (await fetch(`${baseUrl}/api/v1/pairing/status`)).json()).status, "not_paired", "pairing sessions must not survive a restart.");

    for (const captured of outputs) {
      assert(!captured().includes(PERMANENT_TOKEN), "the provenance Agent output must not contain the paired credential.");
      assert(!captured().includes(generatedConfig.agentToken), "the provenance Agent output must not contain the generated credential.");
    }
    const provenanceLogs = readAllLogs(provenanceLogDir);
    assert(!provenanceLogs.includes(PERMANENT_TOKEN) && !provenanceLogs.includes(generatedConfig.agentToken), "the provenance Agent logs must not contain credential material.");
    console.log("restart provenance legs passed: generated stays unenrolled across restarts, remote bootstrap works, pairing/enrollment adopt provenance");
  } finally {
    await stopChild(child);
  }
}

async function main() {
  await runFlowLegs();
  await runRateLimitLeg();
  await runSpawnedAgentLegs();
  await runRestartProvenanceLegs();
  console.log("agent:cli-pairing:smoke passed — format, expiry, single-use, gate refusal, rate limit, stale-URL loopback notice");
}

main().catch((error) => {
  console.error("agent:cli-pairing:smoke FAILED:", error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  for (const cliChild of cliChildren) {
    try { cliChild.kill("SIGKILL"); } catch {}
  }
  for (const agentChild of agentChildren) {
    try { agentChild.kill("SIGKILL"); } catch {}
  }
  try { fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
});
