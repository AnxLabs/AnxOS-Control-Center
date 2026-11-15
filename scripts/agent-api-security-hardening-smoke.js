#!/usr/bin/env node
// Agent API security hardening (pre-auth surfaces).
//
// 1. agent-api-security-1: the pairing and enrollment re-pair gates must
//    compare the presented credential to the live Agent token in full. A value
//    whose 48-bit tokenFingerprint merely collides with the live token must be
//    refused, and the unauthenticated /api/v1/health and /api/v1/enroll/status
//    replies must not publish that fingerprint (or the config path) to a
//    remote caller that holds no credential.
// 2. agent-api-security-2: completing a pairing must bind an enrolled record
//    to the new credential at once, so the network pairing gate closes without
//    waiting for the next Agent restart.
// 3. agent-api-security-3: an unauthenticated request must not make the Agent
//    buffer a large body. Host/Origin and the credential are checked from the
//    headers first, and a caller without a valid token is capped at 64 KB.
//
// Hermetic: every config, enrollment, identity, log and instance path lives in
// a per-run temp tree, remote callers are synthetic socket addresses
// (TEST-NET ranges), and the spawned Agent binds 127.0.0.1 on an ephemeral
// port (never 47131/47132).
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");

const root = path.resolve(__dirname, "..");
const smokeRoot = pinAgentRoots("anx-agent-api-security-");
const configDir = path.join(smokeRoot, "config");
const enrollmentPath = path.join(configDir, "enrollment.json");
const identityPath = path.join(configDir, "identity.json");
const logDir = path.join(smokeRoot, "logs");
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
process.env.ANXHUB_CONFIG_DIR = configDir;
process.env.AGENT_ENROLLMENT_PATH = enrollmentPath;
process.env.AGENT_IDENTITY_PATH = identityPath;
process.env.ANXOS_LOG_DIR = logDir;

const OWNER_TOKEN = "anxos_owner-live-credential-value-0123456789abcdef";
const ATTACKER_TOKEN = "anxos_attacker-chosen-credential-value-0123456789ab";
const COLLIDER = "collider-string-found-offline-by-the-attacker";
const GENERATED_TOKEN = "anxos_self-generated-credential-value-0123456789ab";
const REMOTE = "198.51.100.9";
const OWNER_REMOTE = "203.0.113.20";
const OTHER_REMOTE = "203.0.113.66";

// Simulated 48-bit collision: SHA-256(COLLIDER) is made to share the owner
// token's first 12 hex characters (its tokenFingerprint) while the rest of the
// digest stays different. Only that one input is affected.
const realSha256Hex = (value) => crypto.createHash("sha256").update(value).digest("hex");
const forcedDigests = new Map([[COLLIDER, `${realSha256Hex(OWNER_TOKEN).slice(0, 12)}${realSha256Hex(COLLIDER).slice(12)}`]]);
const realCreateHash = crypto.createHash;
crypto.createHash = function createHashWithForcedCollision(algorithm, ...rest) {
  const hash = realCreateHash.call(crypto, algorithm, ...rest);
  if (String(algorithm).toLowerCase() !== "sha256") return hash;
  const chunks = [];
  const update = hash.update.bind(hash);
  const digest = hash.digest.bind(hash);
  hash.update = (data, encoding) => {
    chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data), typeof encoding === "string" ? encoding : "utf8"));
    update(data, encoding);
    return hash;
  };
  hash.digest = (encoding) => {
    const forced = forcedDigests.get(Buffer.concat(chunks).toString("utf8"));
    if (!forced) return digest(encoding);
    digest();
    const buffer = Buffer.from(forced, "hex");
    return encoding ? buffer.toString(encoding) : buffer;
  };
  return hash;
};

const { tokenFingerprint } = require("../src/shared/agentTokenStore");
const pairingRoute = require("../agent/src/routes/pairing");
const enrollmentService = require("../agent/src/services/enrollmentService");
const { handlePublicEnrollment } = require("../agent/src/routes/enroll");
const { handleHealth } = require("../agent/src/routes/health");

const configPath = path.join(configDir, "agent.json");
let checks = 0;

function writeConfigFile(token, extra = {}) {
  for (const name of fs.readdirSync(configDir)) {
    if (/^agent\.json\.schema-v\d+\.backup$/.test(name)) fs.rmSync(path.join(configDir, name), { force: true });
  }
  fs.writeFileSync(configPath, `${JSON.stringify({ backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: token, ...extra }, null, 2)}\n`, { mode: 0o600 });
}

function makeConfig(token, tokenStatus = {}) {
  return {
    token,
    instanceRoot: path.join(smokeRoot, "instances"),
    tokenStatus: { configured: true, source: "shared-config", configPath, fingerprint: tokenFingerprint(token), ...tokenStatus },
  };
}

function writeEnrollmentRecord(record) {
  fs.writeFileSync(enrollmentPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

function readEnrollmentFile() {
  try {
    return JSON.parse(fs.readFileSync(enrollmentPath, "utf8"));
  } catch {
    return null;
  }
}

function enrolledRecord(token) {
  return {
    schemaVersion: 1,
    state: "enrolled",
    enrollmentId: "enr-api-security-0001",
    identityPath,
    nodeIdentity: { deviceId: require("../agent/src/services/deviceIdentityService").getDeviceIdentity().deviceId },
    instanceRoot: path.join(smokeRoot, "instances"),
    protocolVersion: 1,
    apiMajorVersion: 1,
    tokenFingerprint: tokenFingerprint(token),
    previousFingerprints: [],
    enrolledAtIso: "2026-01-01T00:00:00.000Z",
  };
}

const urlFor = (pathname) => new URL(pathname, "http://127.0.0.1");
const requestFor = (method, pathname, remoteAddress, { headers = {}, body } = {}) => ({
  method, url: pathname, socket: { remoteAddress }, headers, body,
});

async function expectStatus(invoke, statusCode, code, label) {
  let caught = null;
  try {
    await invoke();
  } catch (error) {
    caught = error;
  }
  assert(caught, `${label}: expected a ${statusCode} refusal, but the request was accepted.`);
  assert.strictEqual(caught.statusCode, statusCode, `${label}: expected HTTP ${statusCode}, got ${caught.statusCode} (${caught.code}).`);
  assert.strictEqual(caught.code, code, `${label}: expected ${code}, got ${caught.code}.`);
}

// ---------------------------------------------------------------------------
// Check 1 (agent-api-security-1)
// ---------------------------------------------------------------------------
async function checkFingerprintIsNotProof() {
  assert.strictEqual(tokenFingerprint(COLLIDER), tokenFingerprint(OWNER_TOKEN), "precondition: the simulated collision must share the 48-bit fingerprint.");
  assert.notStrictEqual(realSha256Hex(COLLIDER), realSha256Hex(OWNER_TOKEN), "precondition: the full digests must still differ.");

  writeConfigFile(OWNER_TOKEN);
  const record = enrolledRecord(OWNER_TOKEN);
  writeEnrollmentRecord(record);
  pairingRoute._test.reset();

  // Pairing gate: header and body proof spellings.
  await expectStatus(
    () => pairingRoute.handlePairing(requestFor("POST", "/api/v1/pairing/start", REMOTE, { headers: { "x-agent-token": COLLIDER } }), urlFor("/api/v1/pairing/start"), makeConfig(OWNER_TOKEN)),
    403, pairingRoute.PAIRING_REQUIRES_EXISTING_CREDENTIAL, "1a: pairing/start with a fingerprint-colliding X-Agent-Token",
  );
  await expectStatus(
    () => pairingRoute.handlePairing(requestFor("POST", "/api/v1/pairing/start", REMOTE, { headers: { authorization: `Bearer ${COLLIDER}` } }), urlFor("/api/v1/pairing/start"), makeConfig(OWNER_TOKEN)),
    403, pairingRoute.PAIRING_REQUIRES_EXISTING_CREDENTIAL, "1a: pairing/start with a fingerprint-colliding bearer token",
  );
  await expectStatus(
    () => pairingRoute.handlePairing(requestFor("POST", "/api/v1/pairing/start", REMOTE, { body: JSON.stringify({ previousAgentToken: COLLIDER }) }), urlFor("/api/v1/pairing/start"), makeConfig(OWNER_TOKEN)),
    403, pairingRoute.PAIRING_REQUIRES_EXISTING_CREDENTIAL, "1a: pairing/start with a fingerprint-colliding previousAgentToken",
  );
  // A config whose live token is absent must not fall back to the fingerprint.
  await expectStatus(
    () => pairingRoute.handlePairing(requestFor("POST", "/api/v1/pairing/start", REMOTE, { headers: { "x-agent-token": COLLIDER } }), urlFor("/api/v1/pairing/start"), { ...makeConfig(OWNER_TOKEN), token: "" }),
    403, pairingRoute.PAIRING_REQUIRES_EXISTING_CREDENTIAL, "1a: pairing/start against a fingerprint-only live credential",
  );
  assert.strictEqual(pairingRoute._test.safeSession().active, false, "1a: a refused start must not open a session.");
  const allowed = await pairingRoute.handlePairing(requestFor("POST", "/api/v1/pairing/start", REMOTE, { headers: { "x-agent-token": OWNER_TOKEN } }), urlFor("/api/v1/pairing/start"), makeConfig(OWNER_TOKEN));
  assert.strictEqual(allowed.statusCode, 200, "1a: the exact live credential must still authorize a remote pairing start.");
  pairingRoute._test.reset();

  // Enrollment re-pair gate: previousAgentToken and the presented-credential spelling.
  for (const [label, body] of [
    ["previousAgentToken", { previousAgentToken: COLLIDER, agentToken: ATTACKER_TOKEN }],
    ["previousCredential", { previousCredential: COLLIDER, agentToken: ATTACKER_TOKEN }],
  ]) {
    const config = makeConfig(OWNER_TOKEN);
    const { body: started } = enrollmentService.startEnrollment({});
    await expectStatus(
      () => enrollmentService.completeEnrollment({ enrollNonce: started.enrollNonce, ...body, scopes: { families: ["owner"] } }, config),
      403, "ENROLL_REPAIR_REQUIRES_EXISTING_CREDENTIAL", `1b: enroll/complete with a fingerprint-colliding ${label}`,
    );
    assert.strictEqual(config.token, OWNER_TOKEN, `1b: a refused enroll/complete (${label}) must keep the live credential.`);
    assert.strictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).agentToken, OWNER_TOKEN, `1b: a refused enroll/complete (${label}) must keep the stored credential.`);
    assert.deepStrictEqual(readEnrollmentFile(), record, `1b: a refused enroll/complete (${label}) must not touch the record.`);
  }
  {
    const { body: started } = enrollmentService.startEnrollment({});
    const config = makeConfig(OWNER_TOKEN);
    const accepted = enrollmentService.completeEnrollment({ enrollNonce: started.enrollNonce, previousAgentToken: OWNER_TOKEN, agentToken: ATTACKER_TOKEN.replace("attacker", "rotated-") }, config);
    assert.strictEqual(accepted.statusCode, 200, "1b: the exact live credential must still authorize an enrollment re-pair.");
  }

  // Unauthenticated remote readers get no credential-derived details.
  writeConfigFile(OWNER_TOKEN);
  writeEnrollmentRecord(enrolledRecord(OWNER_TOKEN));
  const config = makeConfig(OWNER_TOKEN);
  const anonymousHealth = (await handleHealth(config, requestFor("GET", "/api/v1/health", REMOTE))).body;
  assert.strictEqual(anonymousHealth.ok, true, "1c: health must still answer an anonymous caller.");
  assert.strictEqual(anonymousHealth.tokenConfigured, true, "1c: health must still say whether a token is configured.");
  assert.strictEqual(anonymousHealth.tokenFingerprint ?? null, null, "1c: anonymous remote health must not publish the token fingerprint.");
  assert.strictEqual(anonymousHealth.configPath ?? null, null, "1c: anonymous remote health must not publish the config path.");
  const wrongTokenHealth = (await handleHealth(config, requestFor("GET", "/api/v1/health", REMOTE, { headers: { authorization: `Bearer ${COLLIDER}` } }))).body;
  assert.strictEqual(wrongTokenHealth.tokenFingerprint ?? null, null, "1c: a wrong (colliding) bearer token must not unlock the fingerprint.");
  const ownerHealth = (await handleHealth(config, requestFor("GET", "/api/v1/health", REMOTE, { headers: { authorization: `Bearer ${OWNER_TOKEN}` } }))).body;
  assert.strictEqual(ownerHealth.tokenFingerprint, tokenFingerprint(OWNER_TOKEN), "1c: an authenticated caller must still see the live fingerprint (desktop credential checks).");
  assert.strictEqual(ownerHealth.configPath, configPath, "1c: an authenticated caller must still see the config path.");
  const loopbackHealth = (await handleHealth(config, requestFor("GET", "/api/v1/health", "127.0.0.1"))).body;
  assert.strictEqual(loopbackHealth.tokenFingerprint, tokenFingerprint(OWNER_TOKEN), "1c: the operator on the Agent machine (loopback) must still see the fingerprint (local credential-mismatch detection).");

  const anonymousStatus = handlePublicEnrollment(requestFor("GET", "/api/v1/enroll/status", REMOTE), urlFor("/api/v1/enroll/status"), config).body;
  assert.strictEqual(anonymousStatus.state, "enrolled", "1c: enroll/status must still report the state anonymously.");
  assert.strictEqual(anonymousStatus.tokenFingerprint ?? null, null, "1c: anonymous remote enroll/status must not publish the token fingerprint.");
  const loopbackStatus = handlePublicEnrollment(requestFor("GET", "/api/v1/enroll/status", "::1"), urlFor("/api/v1/enroll/status"), config).body;
  assert.strictEqual(loopbackStatus.tokenFingerprint, tokenFingerprint(OWNER_TOKEN), "1c: loopback enroll/status must still report the bound fingerprint.");
  checks += 1;
  console.log("check 1 passed: a 48-bit fingerprint collision is not proof of possession, and anonymous remote callers cannot read the fingerprint");
}

// ---------------------------------------------------------------------------
// Check 2 (agent-api-security-2)
// ---------------------------------------------------------------------------
async function checkPairingBindsEnrollment() {
  fs.rmSync(enrollmentPath, { force: true });
  writeConfigFile(GENERATED_TOKEN, { tokenOrigin: "generated" });
  pairingRoute._test.reset();
  const config = makeConfig(GENERATED_TOKEN, { tokenOrigin: "generated" });

  const start = await pairingRoute.handlePairing(requestFor("POST", "/api/v1/pairing/start", "127.0.0.1"), urlFor("/api/v1/pairing/start"), config);
  assert.strictEqual(start.statusCode, 200, "2: the first pairing of an unenrolled node must stay open.");
  const complete = await pairingRoute.handlePairing(
    requestFor("POST", "/api/v1/pairing/complete", OWNER_REMOTE, { body: JSON.stringify({ pairingCode: start.body.pairingCode, permanentToken: OWNER_TOKEN }) }),
    urlFor("/api/v1/pairing/complete"),
    config,
  );
  assert.strictEqual(complete.statusCode, 200, "2: the owner's first pairing must succeed.");
  assert.strictEqual(config.token, OWNER_TOKEN, "2: the owner's credential must be live.");

  const record = enrollmentService.readEnrollmentRecord();
  assert(record, "2: completing a pairing must create an enrollment record at once (not only after an Agent restart).");
  assert.strictEqual(record.state, "enrolled", "2: the record created by pairing must be enrolled.");
  assert.strictEqual(record.tokenFingerprint, tokenFingerprint(OWNER_TOKEN), "2: the record must be bound to the paired credential.");
  assert.strictEqual(enrollmentService.assertEnrollmentBinding(config)?.state, "enrolled", "2: the new binding must pass the per-request binding gate without drift.");

  await expectStatus(
    () => pairingRoute.handlePairing(requestFor("POST", "/api/v1/pairing/start", OTHER_REMOTE), urlFor("/api/v1/pairing/start"), config),
    403, pairingRoute.PAIRING_REQUIRES_EXISTING_CREDENTIAL, "2: a second network caller without the credential",
  );
  assert.strictEqual(config.token, OWNER_TOKEN, "2: a refused second pairing must not change the live credential.");
  assert.strictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).agentToken, OWNER_TOKEN, "2: a refused second pairing must not change the stored credential.");
  const owned = await pairingRoute.handlePairing(requestFor("POST", "/api/v1/pairing/start", OTHER_REMOTE, { headers: { "x-agent-token": OWNER_TOKEN } }), urlFor("/api/v1/pairing/start"), config);
  assert.strictEqual(owned.statusCode, 200, "2: the owner's credential must still authorize a remote re-pair.");
  pairingRoute._test.reset();

  // A drifted (unenrolled) record is the recovery path: pairing stays open and
  // the new credential is bound so the gate closes again.
  writeEnrollmentRecord({ ...enrolledRecord(OWNER_TOKEN), state: "unenrolled", driftReason: "instance-root" });
  const recoveryConfig = makeConfig(OWNER_TOKEN);
  const recoveryStart = await pairingRoute.handlePairing(requestFor("POST", "/api/v1/pairing/start", OWNER_REMOTE), urlFor("/api/v1/pairing/start"), recoveryConfig);
  await pairingRoute.handlePairing(
    requestFor("POST", "/api/v1/pairing/complete", OWNER_REMOTE, { body: JSON.stringify({ pairingCode: recoveryStart.body.pairingCode, permanentToken: ATTACKER_TOKEN.replace("attacker", "recovery") }) }),
    urlFor("/api/v1/pairing/complete"),
    recoveryConfig,
  );
  const recovered = enrollmentService.readEnrollmentRecord();
  assert.strictEqual(recovered.state, "enrolled", "2: a recovery pairing must re-enroll a drifted record.");
  assert.strictEqual(recovered.tokenFingerprint, tokenFingerprint(recoveryConfig.token), "2: the recovered record must be bound to the new credential.");

  // A record minted by another Agent identity sharing this config directory is
  // never overwritten.
  const foreign = { ...enrolledRecord(OWNER_TOKEN), state: "unenrolled", identityPath: path.join(smokeRoot, "other-agent", "identity.json") };
  writeEnrollmentRecord(foreign);
  pairingRoute._test.reset();
  const foreignConfig = makeConfig(OWNER_TOKEN);
  const foreignStart = await pairingRoute.handlePairing(requestFor("POST", "/api/v1/pairing/start", "127.0.0.1"), urlFor("/api/v1/pairing/start"), foreignConfig);
  await pairingRoute.handlePairing(
    requestFor("POST", "/api/v1/pairing/complete", "127.0.0.1", { body: JSON.stringify({ pairingCode: foreignStart.body.pairingCode, permanentToken: OWNER_TOKEN }) }),
    urlFor("/api/v1/pairing/complete"),
    foreignConfig,
  );
  assert.deepStrictEqual(readEnrollmentFile(), foreign, "2: pairing must not overwrite another Agent's record.");
  pairingRoute._test.reset();
  checks += 1;
  console.log("check 2 passed: pairing binds an enrolled record at once, closing the network pairing gate");
}

// ---------------------------------------------------------------------------
// Check 3 (agent-api-security-3): real spawned Agent over loopback.
// ---------------------------------------------------------------------------
function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on("error", reject);
  });
}

async function waitForAgent(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Spawned Agent did not become reachable.");
}

// Sends the headers plus `sendBytes` of a body. Resolves with the response
// status (and how much of the body had been written) or with null when no
// response arrives within `waitMs` — i.e. the server is still buffering.
function partialUpload(port, { method = "POST", pathname, headers = {}, declaredBytes = null, sendBytes, waitMs = 4000 }) {
  return new Promise((resolve) => {
    let settled = false;
    let sent = 0;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(value);
    };
    const request = http.request({
      host: "127.0.0.1",
      port,
      method,
      path: pathname,
      headers: {
        "Content-Type": "application/json",
        ...(declaredBytes !== null ? { "Content-Length": String(declaredBytes) } : { "Transfer-Encoding": "chunked" }),
        ...headers,
      },
    }, (response) => {
      let text = "";
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => finish({ status: response.statusCode, sent, body: text, connection: response.headers.connection || null }));
      response.on("error", () => finish({ status: response.statusCode, sent, body: text }));
    });
    request.on("error", (error) => finish({ status: null, sent, error: error.code || error.message }));
    const timer = setTimeout(() => finish(null), waitMs);
    const chunk = Buffer.alloc(16 * 1024, 0x61);
    const pump = () => {
      while (sent < sendBytes && !settled) {
        const size = Math.min(chunk.length, sendBytes - sent);
        sent += size;
        if (!request.write(size === chunk.length ? chunk : chunk.subarray(0, size))) {
          request.once("drain", pump);
          return;
        }
      }
    };
    pump();
  });
}

async function checkPreAuthBodyCap() {
  const agentHome = path.join(smokeRoot, "agent-home");
  const agentConfigDir = path.join(agentHome, "config");
  fs.mkdirSync(agentConfigDir, { recursive: true });
  const port = await getFreePort();
  assert(port !== 47131 && port !== 47132, "the smoke must never use the real Agent ports.");
  fs.writeFileSync(path.join(agentConfigDir, "agent.json"), `${JSON.stringify({ backendMode: "agent", agentUrl: `http://127.0.0.1:${port}`, agentToken: OWNER_TOKEN }, null, 2)}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, [path.join(root, "agent", "src", "server.js")], {
    cwd: path.join(root, "agent"),
    env: {
      ...process.env,
      ANXHUB_CONFIG_DIR: agentConfigDir,
      ANXHUB_AGENT_CONFIG_PATH: path.join(agentConfigDir, "agent.json"),
      AGENT_ENROLLMENT_PATH: path.join(agentConfigDir, "enrollment.json"),
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: String(port),
      AGENT_TOKEN: OWNER_TOKEN,
      AGENT_IDENTITY_PATH: path.join(agentHome, "identity.json"),
      AGENT_INSTANCE_ROOT: path.join(agentHome, "instances"),
      AGENT_FILE_ROOTS: smokeRoot,
      ANXOS_LOG_DIR: path.join(agentHome, "logs"),
      AGENT_API_RATE_LIMIT_PER_MINUTE: "2000",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childOutput = "";
  child.stdout.on("data", (chunk) => { childOutput += String(chunk); });
  child.stderr.on("data", (chunk) => { childOutput += String(chunk); });
  try {
    await waitForAgent(port);
    const TEN_MB = 10 * 1024 * 1024;

    const declared = await partialUpload(port, { pathname: "/api/v1/instances", declaredBytes: TEN_MB, sendBytes: 64 * 1024 });
    assert(declared, "3a: an unauthenticated 10 MB upload must be refused before the body is sent (the Agent kept buffering).");
    assert([401, 413].includes(declared.status), `3a: expected 401 or 413 for an unauthenticated 10 MB upload, got ${declared.status} (${declared.error || declared.body}).`);
    assert(declared.sent < TEN_MB, "3a: the refusal must arrive before the whole body was sent.");

    const chunked = await partialUpload(port, { pathname: "/api/v1/instances", sendBytes: 256 * 1024 });
    assert(chunked, "3b: an unauthenticated chunked upload over 64 KB must be refused without waiting for the body to end.");
    assert(chunked.status === null || [401, 413].includes(chunked.status), `3b: expected 401/413 or a closed connection, got ${chunked.status}.`);

    const wrongHost = await partialUpload(port, { pathname: "/api/v1/instances", declaredBytes: TEN_MB, sendBytes: 64 * 1024, headers: { Host: "evil.example" } });
    assert(wrongHost && wrongHost.status === 421, `3c: a foreign Host must be refused (421) before the body is read, got ${wrongHost && wrongHost.status}.`);

    const pairingBody = await partialUpload(port, { pathname: "/api/v1/pairing/start", declaredBytes: 100 * 1024, sendBytes: 100 * 1024 });
    assert(pairingBody && pairingBody.status === 413, `3d: a pre-auth pairing body over 64 KB must get 413, got ${pairingBody && pairingBody.status}.`);
    assert(/REQUEST_TOO_LARGE/.test(pairingBody.body || ""), "3d: the 413 must carry REQUEST_TOO_LARGE.");

    const small = await fetch(`http://127.0.0.1:${port}/api/v1/instances`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.strictEqual(small.status, 401, "3e: a small unauthenticated request must still get 401.");

    const authenticated = await fetch(`http://127.0.0.1:${port}/api/v1/instances`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${OWNER_TOKEN}` },
      body: `{"padding":"${"x".repeat(300 * 1024)}"`,
    });
    assert.notStrictEqual(authenticated.status, 413, "3f: an authenticated body over 64 KB must still be accepted for processing.");
    assert.notStrictEqual(authenticated.status, 401, "3f: the owner's token must authenticate.");

    const enrollSmall = await fetch(`http://127.0.0.1:${port}/api/v1/enroll/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.strictEqual(enrollSmall.status, 200, "3g: a small pre-auth enroll/start must still work.");
    checks += 1;
    console.log("check 3 passed: unauthenticated callers cannot make the Agent buffer large bodies");
  } catch (error) {
    if (childOutput) console.error(childOutput.slice(-4000));
    throw error;
  } finally {
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", resolve);
      child.kill("SIGTERM");
      setTimeout(resolve, 3000).unref?.();
    });
  }
}

(async () => {
  // Every check runs even when an earlier one fails, so one run shows the
  // state of each finding.
  const failures = [];
  for (const [id, check] of [
    ["agent-api-security-1", checkFingerprintIsNotProof],
    ["agent-api-security-2", checkPairingBindsEnrollment],
    ["agent-api-security-3", checkPreAuthBodyCap],
  ]) {
    try {
      await check();
    } catch (error) {
      failures.push(id);
      console.error(`FAILED ${id}: ${error && error.stack ? error.stack : error}`);
    }
  }
  if (failures.length) {
    console.error(`agent-api-security-hardening-smoke failed: ${failures.join(", ")} (${checks} of 3 checks passed)`);
    process.exitCode = 1;
    return;
  }
  console.log(`agent-api-security-hardening-smoke passed (${checks} checks)`);
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
