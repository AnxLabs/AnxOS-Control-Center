#!/usr/bin/env node
// Security P1 regression: the pre-auth pairing handshake must not install a
// caller-chosen credential on an ALREADY ENROLLED node.
//
// The proven three-request takeover was:
//   1. POST /api/v1/pairing/start   (pre-auth)  -> returns the pairing code to the caller
//   2. POST /api/v1/pairing/complete -> sets config.token to a caller-chosen value
//   3. GET  /instances with that token -> 200, and the enrollment record self-heals
//      to the caller's fingerprint on the next authenticated request.
//
// This smoke pins the Option B rule: for an enrollment record in state
// `enrolled`, a pairing request is allowed only from loopback OR when the
// caller proves possession of a credential the agent already trusts (the live
// credential or the record's fingerprint); otherwise it is refused with
// PAIRING_REQUIRES_EXISTING_CREDENTIAL (403) BEFORE any mutation. No record or
// a non-enrolled record keeps today's behavior (bootstrap / recovery).
//
// Non-loopback callers cannot be produced by a TCP connection to a
// 127.0.0.1-bound agent on every platform, so the refusal legs drive the REAL
// route handler (agent/src/routes/pairing.js) with a synthetic remoteAddress,
// and the legitimate legs are additionally proven end to end against a real
// spawned Agent over loopback HTTP.
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");

const root = path.resolve(__dirname, "..");
const smokeRoot = pinAgentRoots("anx-pairing-credential-gate-");
const configDir = path.join(smokeRoot, "config");
const enrollmentPath = path.join(configDir, "enrollment.json");
const logDir = path.join(smokeRoot, "logs");
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
process.env.ANXHUB_CONFIG_DIR = configDir;
process.env.AGENT_ENROLLMENT_PATH = enrollmentPath;
// Must be set before the agent logger module loads (it resolves its directory
// once at require time); keeps this smoke's refusal logging inside the temp
// tree so the redaction assertion below can read it.
process.env.ANXOS_LOG_DIR = logDir;

const pairingRoute = require("../agent/src/routes/pairing");
const { tokenFingerprint } = require("../src/shared/agentTokenStore");

const REFUSAL = pairingRoute.PAIRING_REQUIRES_EXISTING_CREDENTIAL;
const REMOTE = "198.51.100.9"; // TEST-NET-2: definitively not loopback
const ATTACKER_TOKEN = "anxos_attacker-chosen-credential-value-0123456789";
const LIVE_TOKEN = "anxos_operator-live-credential-value-0123456789";
const ROTATED_TOKEN = "anxos_operator-rotated-credential-value-0123456789";
const BOOTSTRAP_TOKEN = "anxos_first-enrollment-credential-value-0123456789";

const configPath = path.join(configDir, "agent.json");

function writeConfigFile(token) {
  // V2-J bullet 6: the Agent config migration writes a durable, never-replaced
  // `.schema-v0.backup`. This smoke rewrites the legacy global config with a
  // different token for each leg, which is exactly the state verify-or-refuse
  // refuses, so each leg must start from a clean recovery point.
  for (const name of fs.readdirSync(configDir)) {
    if (/^agent\.json\.schema-v\d+\.backup$/.test(name)) {
      fs.rmSync(path.join(configDir, name), { force: true });
    }
  }
  fs.writeFileSync(configPath, `${JSON.stringify({ backendMode: "agent", agentUrl: "http://127.0.0.1:47131", agentToken: token }, null, 2)}\n`, { mode: 0o600 });
}

function makeConfig(token) {
  return {
    token,
    instanceRoot: path.join(smokeRoot, "instances"),
    tokenStatus: { configured: true, source: "shared-config", configPath, fingerprint: tokenFingerprint(token) },
  };
}

function writeEnrollmentRecord(record) {
  fs.mkdirSync(path.dirname(enrollmentPath), { recursive: true });
  fs.writeFileSync(enrollmentPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function clearEnrollmentRecord() {
  try { fs.rmSync(enrollmentPath, { force: true }); } catch {}
}

function readEnrollmentRecord() {
  return JSON.parse(fs.readFileSync(enrollmentPath, "utf8"));
}

function enrolledRecord(token) {
  return {
    schemaVersion: 1,
    state: "enrolled",
    enrollmentId: "enr-pairing-gate-0001",
    identityPath: path.join(configDir, "identity.json"),
    instanceRoot: path.join(smokeRoot, "instances"),
    protocolVersion: 1,
    apiMajorVersion: 1,
    tokenFingerprint: tokenFingerprint(token),
    previousFingerprints: [],
    scopes: [{ type: "api", value: "instance:read" }],
    enrolledAtIso: "2026-01-01T00:00:00.000Z",
  };
}

const urlFor = (pathname) => new URL(pathname, "http://127.0.0.1:47131");
const requestFor = (method, pathname, remoteAddress, { headers = {}, body } = {}) => ({
  method, url: pathname, socket: { remoteAddress }, headers, body,
});

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

async function expectRefusal(invoke, label) {
  await assert.rejects(
    invoke,
    (error) => {
      assert.strictEqual(error.code, REFUSAL, `${label}: must refuse with ${REFUSAL} (got ${error.code || error.message}).`);
      assert.strictEqual(error.statusCode, 403, `${label}: refusal must use status 403.`);
      return true;
    },
    `${label}: the enrolled pairing gate must refuse.`,
  );
}

// ---------------------------------------------------------------------------
// Leg 1-2, 4-6: real route handler, synthetic non-loopback caller.
// ---------------------------------------------------------------------------
async function runHandlerLegs() {
  // --- Leg 5: first pairing of a node with NO record still succeeds remotely.
  clearEnrollmentRecord();
  pairingRoute._test.reset();
  const bootstrapStart = await pairingRoute.handlePairing(
    requestFor("POST", "/api/v1/pairing/start", REMOTE),
    urlFor("/api/v1/pairing/start"),
    makeConfig(BOOTSTRAP_TOKEN),
  );
  assert.strictEqual(bootstrapStart.statusCode, 200, "Leg 5: a node with no enrollment record must serve a remote pairing start.");
  assert(bootstrapStart.body.pairingCode, "Leg 5: a remote bootstrap start must return a pairing code.");
  assert(!JSON.stringify(bootstrapStart.body).includes("agentToken"), "Leg 5: the session payload must not expose a permanent token.");

  const bootstrapConfig = makeConfig(BOOTSTRAP_TOKEN);
  const bootstrapComplete = await pairingRoute.handlePairing(
    requestFor("POST", "/api/v1/pairing/complete", REMOTE, { body: JSON.stringify({ pairingCode: bootstrapStart.body.pairingCode, permanentToken: BOOTSTRAP_TOKEN }) }),
    urlFor("/api/v1/pairing/complete"),
    bootstrapConfig,
  );
  assert.strictEqual(bootstrapComplete.statusCode, 200, "Leg 5: a remote first-pairing complete must still succeed (bootstrap preserved).");
  assert.strictEqual(bootstrapConfig.token, BOOTSTRAP_TOKEN, "Leg 5: the bootstrap pairing must install the caller's credential on an unenrolled node.");
  console.log("leg 5 passed: remote first pairing (no enrollment record) still succeeds");

  // --- Leg 1: the three-request takeover is closed for an enrolled node.
  const record = enrolledRecord(LIVE_TOKEN);
  writeEnrollmentRecord(record);
  writeConfigFile(LIVE_TOKEN);
  pairingRoute._test.reset();

  await expectRefusal(
    () => pairingRoute.handlePairing(requestFor("POST", "/api/v1/pairing/start", REMOTE), urlFor("/api/v1/pairing/start"), makeConfig(LIVE_TOKEN)),
    "Leg 1: remote pairing/start with no credential",
  );
  assert.strictEqual(pairingRoute._test.safeSession().active, false, "Leg 1: a refused remote start must not create a pairing session.");

  // A session exists (as if an on-host operator opened one). The remote caller
  // must not be able to redeem it even with the correct code.
  const session = await pairingRoute.handlePairing(
    requestFor("POST", "/api/v1/pairing/start", "127.0.0.1"),
    urlFor("/api/v1/pairing/start"),
    makeConfig(LIVE_TOKEN),
  );
  assert.strictEqual(session.statusCode, 200, "Leg 1 setup: a loopback start must open a session on an enrolled node.");
  const pairingCode = session.body.pairingCode;
  const configBefore = JSON.stringify(makeConfig(LIVE_TOKEN).tokenStatus);

  const liveConfig = makeConfig(LIVE_TOKEN);
  await expectRefusal(
    () => pairingRoute.handlePairing(
      requestFor("POST", "/api/v1/pairing/complete", REMOTE, { body: JSON.stringify({ pairingCode, permanentToken: ATTACKER_TOKEN }) }),
      urlFor("/api/v1/pairing/complete"),
      liveConfig,
    ),
    "Leg 1: remote pairing/complete with a caller-chosen token",
  );
  assert.strictEqual(liveConfig.token, LIVE_TOKEN, "Leg 1: a refused complete must leave config.token UNCHANGED.");
  assert.strictEqual(tokenFingerprint(liveConfig.token), tokenFingerprint(LIVE_TOKEN), "Leg 1: the live credential fingerprint must be unchanged.");
  assert.strictEqual(JSON.stringify(liveConfig.tokenStatus), configBefore, "Leg 1: a refused complete must not touch config token status.");
  assert.strictEqual(
    fs.readFileSync(configPath, "utf8"),
    `${JSON.stringify({ backendMode: "agent", agentUrl: "http://127.0.0.1:47131", agentToken: LIVE_TOKEN }, null, 2)}\n`,
    "Leg 1: a refused complete must not rewrite the on-disk agent config.",
  );
  assert.deepStrictEqual(readEnrollmentRecord(), record, "Leg 1: a refused complete must not mutate the enrollment record (or its scopes).");
  assert.strictEqual(tokenFingerprint(ATTACKER_TOKEN) === readEnrollmentRecord().tokenFingerprint, false, "Leg 1: the record must not rebind to the attacker fingerprint.");
  const stillActive = pairingRoute._test.safeSession();
  assert(stillActive.active && stillActive.pairingCode === pairingCode, "Leg 1: a refused complete must not consume the live session.");
  console.log("leg 1 passed: remote start + complete takeover of an enrolled node is refused with no mutation");

  // --- Leg 2: status/cancel are refused and cannot read or destroy the live code.
  await expectRefusal(
    () => pairingRoute.handlePairing(requestFor("GET", "/api/v1/pairing/status", REMOTE), urlFor("/api/v1/pairing/status"), makeConfig(LIVE_TOKEN)),
    "Leg 2: remote pairing/status",
  );
  await expectRefusal(
    () => pairingRoute.handlePairing(requestFor("POST", "/api/v1/pairing/cancel", REMOTE), urlFor("/api/v1/pairing/cancel"), makeConfig(LIVE_TOKEN)),
    "Leg 2: remote pairing/cancel",
  );
  const afterCancel = pairingRoute._test.safeSession();
  assert(afterCancel.active && afterCancel.pairingCode === pairingCode, "Leg 2: a refused cancel must not destroy the live session, and the code must be unchanged.");
  console.log("leg 2 passed: remote pairing/status and pairing/cancel are refused and cannot read or destroy the live code");

  // --- Leg 4: remote re-pair WITH the live credential still succeeds.
  // 4a: Authorization: Bearer
  const remoteStart = await pairingRoute.handlePairing(
    requestFor("POST", "/api/v1/pairing/start", REMOTE, { headers: { authorization: `Bearer ${LIVE_TOKEN}` } }),
    urlFor("/api/v1/pairing/start"),
    makeConfig(LIVE_TOKEN),
  );
  assert.strictEqual(remoteStart.statusCode, 200, "Leg 4a: a remote caller with the live bearer credential must open a session.");
  const remoteConfig = makeConfig(LIVE_TOKEN);
  const remoteComplete = await pairingRoute.handlePairing(
    requestFor("POST", "/api/v1/pairing/complete", REMOTE, {
      headers: { authorization: `Bearer ${LIVE_TOKEN}` },
      body: JSON.stringify({ pairingCode: remoteStart.body.pairingCode, permanentToken: ROTATED_TOKEN }),
    }),
    urlFor("/api/v1/pairing/complete"),
    remoteConfig,
  );
  assert.strictEqual(remoteComplete.statusCode, 200, "Leg 4a: a remote re-pair with the live credential must succeed.");
  assert.strictEqual(remoteConfig.token, ROTATED_TOKEN, "Leg 4a: the authorized re-pair must rotate the live credential.");
  console.log("leg 4a passed: remote re-pair with the live bearer credential succeeds");

  // 4b: previousAgentToken in the body (the enroll-surface spelling), and the
  // x-agent-token header spelling for start.
  writeEnrollmentRecord(enrolledRecord(ROTATED_TOKEN));
  writeConfigFile(ROTATED_TOKEN);
  pairingRoute._test.reset();
  const headerStart = await pairingRoute.handlePairing(
    requestFor("POST", "/api/v1/pairing/start", REMOTE, { headers: { "x-agent-token": ROTATED_TOKEN } }),
    urlFor("/api/v1/pairing/start"),
    makeConfig(ROTATED_TOKEN),
  );
  assert.strictEqual(headerStart.statusCode, 200, "Leg 4b: the x-agent-token spelling must authorize a remote start.");
  const bodyConfig = makeConfig(ROTATED_TOKEN);
  const bodyComplete = await pairingRoute.handlePairing(
    requestFor("POST", "/api/v1/pairing/complete", REMOTE, {
      body: JSON.stringify({ pairingCode: headerStart.body.pairingCode, permanentToken: LIVE_TOKEN, previousAgentToken: ROTATED_TOKEN }),
    }),
    urlFor("/api/v1/pairing/complete"),
    bodyConfig,
  );
  assert.strictEqual(bodyComplete.statusCode, 200, "Leg 4b: previousAgentToken must authorize a remote re-pair.");
  assert.strictEqual(bodyConfig.token, LIVE_TOKEN, "Leg 4b: the authorized re-pair must rotate the credential.");
  console.log("leg 4b passed: remote re-pair with x-agent-token and previousAgentToken succeeds");

  // --- Leg 3 (handler level): loopback re-pair of an enrolled node succeeds.
  writeEnrollmentRecord(enrolledRecord(LIVE_TOKEN));
  writeConfigFile(LIVE_TOKEN);
  pairingRoute._test.reset();
  const loopbackStart = await pairingRoute.handlePairing(
    requestFor("POST", "/api/v1/pairing/start", "127.0.0.1"),
    urlFor("/api/v1/pairing/start"),
    makeConfig(LIVE_TOKEN),
  );
  assert.strictEqual(loopbackStart.statusCode, 200, "Leg 3: a loopback start must open a session on an enrolled node.");
  const loopbackConfig = makeConfig(LIVE_TOKEN);
  const loopbackComplete = await pairingRoute.handlePairing(
    requestFor("POST", "/api/v1/pairing/complete", "127.0.0.1", {
      body: JSON.stringify({ pairingCode: loopbackStart.body.pairingCode, permanentToken: ROTATED_TOKEN }),
    }),
    urlFor("/api/v1/pairing/complete"),
    loopbackConfig,
  );
  assert.strictEqual(loopbackComplete.statusCode, 200, "Leg 3: the loopback repair path must still complete.");
  assert.strictEqual(loopbackConfig.token, ROTATED_TOKEN, "Leg 3: the loopback repair must rotate the credential.");
  for (const loopbackAddress of ["::1", "::ffff:127.0.0.1"]) {
    writeEnrollmentRecord(enrolledRecord(ROTATED_TOKEN));
    pairingRoute._test.reset();
    const variant = await pairingRoute.handlePairing(
      requestFor("GET", "/api/v1/pairing/status", loopbackAddress),
      urlFor("/api/v1/pairing/status"),
      makeConfig(ROTATED_TOKEN),
    );
    assert.strictEqual(variant.statusCode, 200, `Leg 3: loopback address ${loopbackAddress} must be allowed.`);
  }
  console.log("leg 3 passed: loopback re-pair of an enrolled node still succeeds");

  // --- Leg 6: no refusal leaks token material or the live pairing code.
  writeEnrollmentRecord(enrolledRecord(LIVE_TOKEN));
  writeConfigFile(LIVE_TOKEN);
  pairingRoute._test.reset();
  const leakConfig = makeConfig(LIVE_TOKEN);
  const leakSession = await pairingRoute.handlePairing(
    requestFor("POST", "/api/v1/pairing/start", "127.0.0.1"),
    urlFor("/api/v1/pairing/start"),
    leakConfig,
  );
  assert.strictEqual(leakSession.statusCode, 200, "Leg 6 setup: a loopback session on the enrolled node must open.");
  const leakCode = leakSession.body.pairingCode;
  const refusalInputs = [
    ["start", () => pairingRoute.handlePairing(requestFor("POST", "/api/v1/pairing/start", REMOTE), urlFor("/api/v1/pairing/start"), leakConfig)],
    ["status", () => pairingRoute.handlePairing(requestFor("GET", "/api/v1/pairing/status", REMOTE), urlFor("/api/v1/pairing/status"), leakConfig)],
    ["cancel", () => pairingRoute.handlePairing(requestFor("POST", "/api/v1/pairing/cancel", REMOTE), urlFor("/api/v1/pairing/cancel"), leakConfig)],
    ["complete", () => pairingRoute.handlePairing(requestFor("POST", "/api/v1/pairing/complete", REMOTE, { body: JSON.stringify({ pairingCode: leakCode, permanentToken: ATTACKER_TOKEN }) }), urlFor("/api/v1/pairing/complete"), leakConfig)],
  ];
  for (const [label, invoke] of refusalInputs) {
    let captured = null;
    await assert.rejects(invoke, (error) => { captured = error; return true; });
    const serialized = JSON.stringify({ message: captured.message, code: captured.code, details: captured.details || null, statusCode: captured.statusCode });
    for (const secret of [LIVE_TOKEN, ATTACKER_TOKEN, leakCode, tokenFingerprint(LIVE_TOKEN)]) {
      assert(!serialized.includes(secret), `Leg 6: the refused ${label} response must not contain ${secret.slice(0, 12)}...`);
    }
  }
  const logs = readAllLogs(logDir);
  assert(logs.length > 0, "Leg 6: the refusal must be audited (a pairing warn line is expected in the log directory).");
  assert(logs.includes("Pairing request refused"), "Leg 6: the refusal must actually be logged for the operator to find.");
  for (const secret of [LIVE_TOKEN, ATTACKER_TOKEN, leakCode, tokenFingerprint(LIVE_TOKEN)]) {
    assert(!logs.includes(secret), `Leg 6: pairing logs must not contain token material or the live pairing code (${secret.slice(0, 12)}...).`);
  }
  console.log("leg 6 passed: refusals leak neither token material nor the live pairing code in the response or the logs");
}

// ---------------------------------------------------------------------------
// Legs 3 + 5 end to end: a real spawned Agent over loopback HTTP.
// ---------------------------------------------------------------------------
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForAgent(baseUrl) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/v1/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Spawned Agent did not become reachable.");
}

async function runSpawnedAgentLegs() {
  const agentHome = path.join(smokeRoot, "agent-home");
  const agentConfigDir = path.join(agentHome, "config");
  const agentEnrollmentPath = path.join(agentConfigDir, "enrollment.json");
  const agentInstanceRoot = path.join(agentHome, "instances");
  fs.mkdirSync(agentConfigDir, { recursive: true });
  const port = await getFreePort();
  const agentUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(root, "agent", "src", "server.js")], {
    cwd: path.join(root, "agent"),
    env: {
      ...process.env,
      ANXHUB_CONFIG_DIR: agentConfigDir,
      ANXHUB_AGENT_CONFIG_PATH: path.join(agentConfigDir, "agent.json"),
      AGENT_ENROLLMENT_PATH: agentEnrollmentPath,
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: String(port),
      AGENT_TOKEN: BOOTSTRAP_TOKEN,
      AGENT_IDENTITY_PATH: path.join(agentHome, "identity.json"),
      AGENT_INSTANCE_ROOT: agentInstanceRoot,
      AGENT_FILE_ROOTS: smokeRoot,
      ANXOS_LOG_DIR: path.join(agentHome, "logs"),
      AGENT_API_RATE_LIMIT_PER_MINUTE: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.on("data", (chunk) => { childOutput += String(chunk); });
  child.stderr.on("data", (chunk) => { childOutput += String(chunk); });
  const stopChild = () => new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(resolve, 2000).unref?.();
  });
  try {
    await waitForAgent(agentUrl);

    // Leg 5 end-to-end: no enrollment record -> loopback bootstrap pairing works.
    const start = await fetch(`${agentUrl}/api/v1/pairing/start`, { method: "POST" });
    assert.strictEqual(start.status, 200, "Leg 5e: a spawned Agent with no enrollment record must serve the pairing handshake.");
    const session = await start.json();
    assert(session.pairingCode && session.pairingCode.startsWith("ANX-"), "Leg 5e: the spawned Agent must return a pairing code.");
    const complete = await fetch(`${agentUrl}/api/v1/pairing/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: session.pairingCode, permanentToken: BOOTSTRAP_TOKEN }),
    });
    assert.strictEqual(complete.status, 200, "Leg 5e: the spawned Agent must accept the first pairing credential.");
    const pairedHealth = await fetch(`${agentUrl}/api/v1/instances`, { headers: { Authorization: `Bearer ${BOOTSTRAP_TOKEN}` } });
    assert.strictEqual(pairedHealth.status, 200, "Leg 5e: the paired credential must authenticate against the spawned Agent.");

    // Leg 3 end-to-end: mark the node enrolled, then re-pair over loopback.
    fs.writeFileSync(agentEnrollmentPath, `${JSON.stringify({
      schemaVersion: 1,
      state: "enrolled",
      enrollmentId: "enr-spawned-pairing-gate",
      identityPath: path.join(agentHome, "identity.json"),
      instanceRoot: agentInstanceRoot,
      protocolVersion: 1,
      apiMajorVersion: 1,
      tokenFingerprint: tokenFingerprint(BOOTSTRAP_TOKEN),
      previousFingerprints: [],
      enrolledAtIso: "2026-01-01T00:00:00.000Z",
    }, null, 2)}\n`, { mode: 0o600 });
    const status = await fetch(`${agentUrl}/api/v1/pairing/status`);
    assert.strictEqual(status.status, 200, "Leg 3e: the loopback status route must stay reachable on an enrolled node.");

    const repairStart = await fetch(`${agentUrl}/api/v1/pairing/start`, { method: "POST" });
    assert.strictEqual(repairStart.status, 200, "Leg 3e: loopback re-pair of an enrolled node must still open a session.");
    const repairSession = await repairStart.json();
    const repairComplete = await fetch(`${agentUrl}/api/v1/pairing/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pairingCode: repairSession.pairingCode, permanentToken: ROTATED_TOKEN }),
    });
    assert.strictEqual(repairComplete.status, 200, "Leg 3e: loopback re-pair of an enrolled node must still complete.");
    const rotatedHealth = await fetch(`${agentUrl}/api/v1/instances`, { headers: { Authorization: `Bearer ${ROTATED_TOKEN}` } });
    assert.strictEqual(rotatedHealth.status, 200, "Leg 3e: the rotated credential must authenticate immediately.");
    const staleHealth = await fetch(`${agentUrl}/api/v1/instances`, { headers: { Authorization: `Bearer ${BOOTSTRAP_TOKEN}` } });
    assert.strictEqual(staleHealth.status, 401, "Leg 3e: the pre-repair credential must be rejected after the loopback repair.");

    // Leg 6 (runtime): the spawned Agent's own logs must not carry token material.
    const spawnedLogs = readAllLogs(path.join(agentHome, "logs"));
    for (const secret of [BOOTSTRAP_TOKEN, ROTATED_TOKEN, session.pairingCode, repairSession.pairingCode]) {
      assert(!spawnedLogs.includes(secret), `Leg 6: spawned Agent logs must not contain token material or a pairing code (${secret.slice(0, 12)}...).`);
      assert(!childOutput.includes(secret), `Leg 6: spawned Agent stdout/stderr must not contain token material or a pairing code (${secret.slice(0, 12)}...).`);
    }
    console.log("leg 3e/5e passed: a real spawned Agent still bootstraps, and a loopback re-pair of its enrolled node still succeeds");
  } finally {
    await stopChild();
  }
}

async function main() {
  await runHandlerLegs();
  await runSpawnedAgentLegs();
  clearEnrollmentRecord();
  pairingRoute._test.reset();
  console.log("agent:pairing-credential-gate:smoke passed");
}

main().catch((error) => {
  console.error("agent:pairing-credential-gate:smoke FAILED:", error.stack || error.message);
  process.exitCode = 1;
});
