const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

// V2-I bullet 3 hermetic smoke: scoped service/API credentials.
//
// Pins, against a REAL spawned agent:
//   1. unscoped token behaves exactly as before (regression baseline),
//   2. a family-scoped token is allowed in-family and denied out-of-family
//      with API_SCOPE_DENIED naming only the lacked family,
//   3. a node-scoped token is allowed on its node and denied for another node
//      with API_SCOPE_DENIED naming the target node,
//   4. scopes persist in the enrollment record and are cleared on re-pair
//      without scopes,
//   5. denial audit entries are present in the agent logs,
//   6. no token material appears in any denial response or captured log line,
//   7. re-pair authority (security P1): an existing, non-revoked enrollment can
//      only be re-paired by a caller presenting the existing Agent credential,
//      so an unauthenticated caller can no longer drop scopes; re-enrollment
//      after revocation stays allowed (recovery) and is audited distinctly.
//
// Roots are pinned into one temp tree (test-helpers/pin-agent-roots.js) and
// the agent's log directory is redirected into that tree so no run can leak
// job records, enrollment state, or logs into the developer machine.

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const { tokenFingerprint } = require("../src/shared/agentTokenStore");

const rootDir = path.resolve(__dirname, "..");
const smokeRoot = pinAgentRoots("anx-agent-scope-enforcement-");
const configDirectory = path.join(smokeRoot, "config");
const logDirectory = path.join(smokeRoot, "logs");
const instanceRoot = path.join(smokeRoot, "instances");

const bootstrapToken = `anxos_scope-bootstrap-token-${"b".repeat(48)}`;
const enrolledToken = `anxos_scope-enrolled-token-${"a".repeat(48)}`;
const repairToken = `anxos_scope-repaired-token-${"f".repeat(48)}`;
const recoveryToken = `anxos_scope-recovery-token-${"g".repeat(48)}`;
const unauthorizedToken = `anxos_scope-unauthorized-token-${"c".repeat(48)}`;
const wrongPreviousToken = `anxos_scope-not-the-record-token-${"d".repeat(48)}`;
const otherNodeId = "agent-other-node-0001";

const capturedStderr = [];
const capturedDenialBodies = [];

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

async function waitForAgent(url) {
  // Shared readiness helper: see scripts/test-helpers/agent-readiness.js for why
  // the budget is generous here and why the failure message must name a cause.
  const { waitForAgentReady } = require("./test-helpers/agent-readiness");
  return waitForAgentReady({
    label: "Scope-enforcement agent",
    probe: async () => (await fetch(`${url}/api/v1/health`)).ok,
  });
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function jsonFetch(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { response, text, body };
}

// Drives one full handshake. `previousToken`, when supplied, is presented as the
// explicit proof of possession required to re-pair an existing enrollment.
async function enrollWith(url, options = {}) {
  const start = await jsonFetch(`${url}/api/v1/enroll/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ minProtocolVersion: 1, maxProtocolVersion: 1 }),
  });
  assert.strictEqual(start.response.status, 200, "Enrollment start must succeed.");
  assert.ok(start.body?.enrollNonce, "Enrollment start must return a nonce.");
  const payload = {
    enrollNonce: start.body.enrollNonce,
    agentToken: options.token || enrolledToken,
    agentUrl: url,
    instanceRoot,
  };
  if (options.scopes !== undefined) payload.scopes = options.scopes;
  if (options.previousToken !== undefined) payload.previousAgentToken = options.previousToken;
  return jsonFetch(`${url}/api/v1/enroll/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function enroll(url, scopes) {
  const complete = await enrollWith(url, { scopes });
  assert.strictEqual(complete.response.status, 200, `Enrollment complete must succeed (scopes=${JSON.stringify(scopes)}).`);
  return complete.body;
}

async function expectAllowed(url, pathname, token, expectedStatus = 200) {
  const { response, body } = await jsonFetch(`${url}${pathname}`, { headers: authHeaders(token) });
  assert.strictEqual(
    response.status,
    expectedStatus,
    `${pathname} must be allowed (expected ${expectedStatus}, got ${response.status}${body?.error ? ` ${body.error.code}` : ""}).`,
  );
  return body;
}

async function expectDenied(url, pathname, token, expectedCode, expectedScope = null) {
  const { response, text, body } = await jsonFetch(`${url}${pathname}`, { headers: authHeaders(token) });
  capturedDenialBodies.push({ pathname, text });
  assert.strictEqual(response.status, 403, `${pathname} must be denied with 403 (got ${response.status}).`);
  assert.strictEqual(body?.error?.code, expectedCode, `${pathname} expected ${expectedCode}, got ${body?.error?.code}.`);
  if (expectedScope) {
    assert.strictEqual(body.error.details?.scope?.type, expectedScope.type, `${pathname} denial must name the lacked scope type.`);
    assert.strictEqual(body.error.details?.scope?.value, expectedScope.value, `${pathname} denial must name the lacked scope value.`);
  }
  return { text, body };
}

function readEnrollmentRecord() {
  return JSON.parse(fs.readFileSync(path.join(configDirectory, "enrollment.json"), "utf8"));
}

function readCapturedLogs() {
  const parts = [];
  for (const entry of fs.readdirSync(logDirectory, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    parts.push(fs.readFileSync(path.join(logDirectory, entry.name), "utf8"));
  }
  return parts.join("\n");
}

async function main() {
  await fsp.mkdir(configDirectory, { recursive: true });
  await fsp.mkdir(instanceRoot, { recursive: true });
  // Pin the agent config path explicitly so the agent never falls back to a
  // repo/global config file (which would silently change the credential).
  await fsp.writeFile(path.join(configDirectory, "agent.json"), JSON.stringify({
    backendMode: "agent",
    agentToken: bootstrapToken,
  }));
  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;

  const agent = spawn(process.execPath, [path.join(rootDir, "agent", "src", "server.js")], {
    cwd: path.join(rootDir, "agent"),
    env: {
      ...process.env,
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: String(port),
      AGENT_TOKEN: bootstrapToken,
      // Explicit least-privilege set: system:read + files:read are granted, so
      // a scope denial can only come from scoping, and console:read stays
      // denied at the permission layer (the unscoped regression control).
      // `owner` is granted so the owner-tier /enroll/revoke recovery path can be
      // exercised; it grants no other capability used here.
      AGENT_API_PERMISSIONS: "system:read,files:read,owner",
      AGENT_FILE_ROOTS: smokeRoot,
      AGENT_INSTANCE_ROOT: instanceRoot,
      AGENT_BACKUP_ROOT: path.join(smokeRoot, "backups"),
      ANXHUB_CONFIG_DIR: configDirectory,
      ANXHUB_AGENT_CONFIG_PATH: path.join(configDirectory, "agent.json"),
      ANXOS_LOG_DIR: logDirectory,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  agent.stderr.on("data", (chunk) => capturedStderr.push(chunk.toString("utf8")));

  try {
    await waitForAgent(url);

    // --- 1. Public/auth behavior unchanged -----------------------------------
    await expectAllowed(url, "/api/v1/health", bootstrapToken);
    const unauthenticated = await jsonFetch(`${url}/api/v1/stats`);
    assert.strictEqual(unauthenticated.response.status, 401, "Non-public APIs must still require authentication.");

    // --- 2. Unscoped token regression baseline -------------------------------
    // The startup-migrated record carries no scopes => unscoped context =>
    // profile permissions apply exactly as before (grant in-profile, deny
    // out-of-profile).
    await expectAllowed(url, "/api/v1/stats", bootstrapToken);
    await expectAllowed(url, "/api/v1/files/identity", bootstrapToken);
    await expectDenied(url, "/api/v1/console/commands", bootstrapToken, "API_PERMISSION_DENIED");

    // --- 3. Family-scoped token ----------------------------------------------
    // The agent auto-migrated its persisted shared token into an enrolled record
    // at startup (registerEnrollmentStartup -> migrateLegacyBinding), so the first
    // handshake here is a RE-PAIR and must prove possession of that credential.
    // A truly record-less first enrollment (the bootstrap path) is covered by
    // agent-enrollment-smoke, which runs the service without startup migration.
    const migrated = readEnrollmentRecord();
    assert.strictEqual(migrated.state, "enrolled", "The persisted shared token must auto-migrate into an enrolled record.");
    assert.strictEqual(migrated.tokenFingerprint, tokenFingerprint(bootstrapToken), "The migrated record must bind the persisted shared credential.");
    // The hole: a re-pair that presents a fresh caller-chosen token WITHOUT the
    // existing credential must be refused (before the gate this succeeded).
    const unauthorizedFirst = await enrollWith(url, { token: enrolledToken, scopes: { families: ["system"] } });
    capturedDenialBodies.push({ pathname: "/api/v1/enroll/complete (no migrated credential)", text: unauthorizedFirst.text });
    assert.strictEqual(unauthorizedFirst.response.status, 403, "A re-pair without the migrated credential must be refused.");
    assert.strictEqual(unauthorizedFirst.body?.error?.code, "ENROLL_REPAIR_REQUIRES_EXISTING_CREDENTIAL", "The refusal must carry the distinct repair code.");
    assert.strictEqual(readEnrollmentRecord().tokenFingerprint, tokenFingerprint(bootstrapToken), "A refused re-pair must not rebind the record.");
    // Presenting the migrated credential authorizes the re-pair and the scopes.
    const firstRepair = await enrollWith(url, { token: enrolledToken, previousToken: bootstrapToken, scopes: { families: ["system"] } });
    assert.strictEqual(firstRepair.response.status, 200, `Re-pairing the migrated record with its credential must succeed (got ${firstRepair.response.status}).`);
    assert.ok(firstRepair.body?.enrollmentId, "Enrollment must mint an enrollmentId.");
    let record = readEnrollmentRecord();
    assert.deepStrictEqual(
      record.scopes,
      { nodeIds: [], families: ["system"] },
      "Family scopes must persist on the enrollment record.",
    );
    await expectAllowed(url, "/api/v1/stats", enrolledToken);
    const familyDenial = await expectDenied(url, "/api/v1/files/identity", enrolledToken, "API_SCOPE_DENIED", {
      type: "family",
      value: "files",
    });
    assert.match(familyDenial.body.error.message, /scoped/i, "Scope denial must carry a scope-aware message.");
    // Combined scopes prove the denial names ONLY the lacked family: the node
    // scope contents must never be echoed.
    const nodeId = await resolveCurrentNodeId(url);
    await enroll(url, { nodeIds: [nodeId], families: ["system"] });
    const combinedDenial = await expectDenied(url, "/api/v1/files/identity", enrolledToken, "API_SCOPE_DENIED", {
      type: "family",
      value: "files",
    });
    assert.ok(!combinedDenial.text.includes(nodeId), "A family denial must not leak the credential's node scope.");
    assert.ok(!combinedDenial.text.includes("nodeIds"), "A family denial must not echo the scope schema.");
    await expectAllowed(url, "/api/v1/stats", enrolledToken);

    // --- 4. Node-scoped token -------------------------------------------------
    await enroll(url, { nodeIds: [otherNodeId] });
    record = readEnrollmentRecord();
    assert.deepStrictEqual(
      record.scopes,
      { nodeIds: [otherNodeId], families: [] },
      "Node scopes must persist on the enrollment record.",
    );
    // A credential scoped to a different node is denied everywhere on this node.
    // The denial names the target node it would need to cover (this agent's
    // node id) and never the credential's own scope entry.
    const nodeDenial = await expectDenied(url, "/api/v1/stats", enrolledToken, "API_SCOPE_DENIED", { type: "node", value: nodeId });
    assert.ok(!nodeDenial.text.includes(otherNodeId), "A node denial must not leak the credential's own node scope.");
    await expectDenied(url, "/api/v1/files/identity", enrolledToken, "API_SCOPE_DENIED", { type: "node", value: nodeId });

    // --- 5. Re-pair without scopes clears them --------------------------------
    await enroll(url, undefined);
    record = readEnrollmentRecord();
    assert.strictEqual(record.scopes, undefined, "Re-pairing without scopes must clear the persisted scopes.");
    await expectAllowed(url, "/api/v1/stats", enrolledToken);
    await expectAllowed(url, "/api/v1/files/identity", enrolledToken);
    // Unscoped is NOT a wildcard grant: out-of-profile capabilities stay denied.
    await expectDenied(url, "/api/v1/console/commands", enrolledToken, "API_PERMISSION_DENIED");

    // --- 6. Re-pair authority (security P1) -----------------------------------
    // 6a. Re-pairing with the EXISTING credential can still change scopes.
    await enroll(url, { families: ["system"] });
    record = readEnrollmentRecord();
    assert.deepStrictEqual(
      record.scopes,
      { nodeIds: [], families: ["system"] },
      "An authorized re-pair must be able to change the persisted scopes.",
    );
    await expectAllowed(url, "/api/v1/stats", enrolledToken);
    await expectDenied(url, "/api/v1/files/identity", enrolledToken, "API_SCOPE_DENIED", { type: "family", value: "files" });

    // 6b. The hole this fixes: a fresh caller-chosen token with NO previous
    // credential must be refused, must not mutate the record, and must not leak
    // token material. Before the gate this call would re-bind the agent to the
    // attacker token and drop the scopes (full profile permissions).
    const recordBeforeRefusal = readEnrollmentRecord();
    const unauthorized = await enrollWith(url, { token: unauthorizedToken });
    capturedDenialBodies.push({ pathname: "/api/v1/enroll/complete (unauthorized re-pair)", text: unauthorized.text });
    assert.strictEqual(unauthorized.response.status, 403, `An unauthorized re-pair must be refused with 403 (got ${unauthorized.response.status}).`);
    assert.strictEqual(
      unauthorized.body?.error?.code,
      "ENROLL_REPAIR_REQUIRES_EXISTING_CREDENTIAL",
      `An unauthorized re-pair must carry the distinct repair code, got ${unauthorized.body?.error?.code}.`,
    );
    assert.deepStrictEqual(readEnrollmentRecord(), recordBeforeRefusal, "A refused re-pair must not mutate the enrollment record.");
    assert.ok(!unauthorized.text.includes(unauthorizedToken), "A repair denial must never echo the supplied credential.");
    assert.ok(!unauthorized.text.includes(enrolledToken), "A repair denial must never echo the existing credential.");
    // The refused attempt changed nothing: the credential is still scoped.
    await expectDenied(url, "/api/v1/files/identity", enrolledToken, "API_SCOPE_DENIED", { type: "family", value: "files" });

    // 6c. A wrong explicit previous credential is refused identically.
    const wrongPrevious = await enrollWith(url, { token: unauthorizedToken, previousToken: wrongPreviousToken });
    capturedDenialBodies.push({ pathname: "/api/v1/enroll/complete (wrong previous credential)", text: wrongPrevious.text });
    assert.strictEqual(wrongPrevious.response.status, 403, "A wrong previous credential must be refused with 403.");
    assert.strictEqual(
      wrongPrevious.body?.error?.code,
      "ENROLL_REPAIR_REQUIRES_EXISTING_CREDENTIAL",
      "A wrong previous credential must carry the distinct repair code.",
    );
    assert.deepStrictEqual(readEnrollmentRecord(), recordBeforeRefusal, "A wrong previous credential must not mutate the enrollment record.");

    // 6d. An explicit previous credential authorizes rotating to a NEW token and
    // narrowing scopes; the superseded credential stops authenticating.
    const repaired = await enrollWith(url, { token: repairToken, previousToken: enrolledToken, scopes: { families: ["files"] } });
    assert.strictEqual(repaired.response.status, 200, `An authorized re-pair with the previous credential must succeed (got ${repaired.response.status}).`);
    assert.deepStrictEqual(
      readEnrollmentRecord().scopes,
      { nodeIds: [], families: ["files"] },
      "The authorized re-pair must persist the newly supplied scopes.",
    );
    await expectAllowed(url, "/api/v1/files/identity", repairToken);
    await expectDenied(url, "/api/v1/stats", repairToken, "API_SCOPE_DENIED", { type: "family", value: "system" });
    const superseded = await jsonFetch(`${url}/api/v1/stats`, { headers: authHeaders(enrolledToken) });
    assert.strictEqual(superseded.response.status, 401, "The superseded credential must stop authenticating after an authorized re-pair.");
    // Re-pair back to the baseline credential so later steps keep their token.
    const restored = await enrollWith(url, { token: enrolledToken, previousToken: repairToken });
    assert.strictEqual(restored.response.status, 200, "Re-pairing back with the rotated credential must succeed.");
    await expectAllowed(url, "/api/v1/stats", enrolledToken);

    // 6e. Revocation is the recovery path: re-enrollment is allowed WITHOUT the
    // previous credential, but is recorded as a distinct audit event.
    const revoked = await jsonFetch(`${url}/api/v1/enroll/revoke`, {
      method: "POST",
      headers: { ...authHeaders(enrolledToken), "Content-Type": "application/json" },
      body: JSON.stringify({ confirmRevoke: true, reason: "scope-enforcement-smoke" }),
    });
    assert.strictEqual(revoked.response.status, 200, `Owner revocation must succeed (got ${revoked.response.status}).`);
    assert.strictEqual(revoked.body?.state, "revoked", "Revocation must persist the revoked state.");
    const recovered = await enrollWith(url, { token: recoveryToken });
    assert.strictEqual(recovered.response.status, 200, "Re-enrollment after revocation must be allowed (recovery path).");
    assert.strictEqual(readEnrollmentRecord().state, "enrolled", "Recovery re-enrollment must re-bind the agent.");
    assert.strictEqual(readEnrollmentRecord().tokenFingerprint, (await jsonFetch(`${url}/api/v1/enroll/status`)).body?.tokenFingerprint, "Recovery must bind the new credential fingerprint.");

    // --- 7. Denial audit entries + secret hygiene -----------------------------
    const logs = readCapturedLogs();
    assert.ok(
      logs.includes('"errorCode":"API_SCOPE_DENIED"'),
      "Scope denials must produce audit entries carrying the API_SCOPE_DENIED code.",
    );
    assert.ok(
      logs.includes('"errorCode":"ENROLL_REPAIR_REQUIRES_EXISTING_CREDENTIAL"'),
      "A refused re-pair must produce an audit entry carrying the distinct repair code.",
    );
    assert.ok(
      logs.includes('"errorCode":"ENROLL_REENROLL_AFTER_REVOCATION"'),
      "Re-enrollment after revocation must be recorded as a distinct audit event.",
    );
    for (const token of [bootstrapToken, enrolledToken, repairToken, recoveryToken, unauthorizedToken, wrongPreviousToken]) {
      assert.ok(!logs.includes(token), "Captured logs must never contain token material.");
      for (const denial of capturedDenialBodies) {
        assert.ok(!denial.text.includes(token), `Denial response for ${denial.pathname} must never contain token material.`);
      }
    }
    const stderr = capturedStderr.join("");
    for (const token of [enrolledToken, repairToken, recoveryToken, unauthorizedToken, wrongPreviousToken]) {
      assert.ok(!stderr.includes(token), "Agent stderr must never contain token material.");
    }

    console.log("agent-scope-enforcement-smoke passed");
  } finally {
    agent.kill("SIGTERM");
    await new Promise((resolve) => agent.once("exit", resolve));
    await fsp.rm(smokeRoot, { recursive: true, force: true });
  }
}

// The node this agent serves, using the same derivation as nodeService.
async function resolveCurrentNodeId(url) {
  const status = await jsonFetch(`${url}/api/v1/enroll/status`);
  assert.strictEqual(status.response.status, 200, "Enrollment status must be readable.");
  const deviceId = status.body?.identity?.deviceId;
  assert.ok(deviceId, "Enrollment status must expose the device identity.");
  return `agent-${String(deviceId).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 56)}`;
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
