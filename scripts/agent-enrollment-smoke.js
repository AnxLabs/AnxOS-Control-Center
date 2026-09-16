const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// V2-A enrollment handshake regression smoke (docs/v2/V2A_DECISIONS.md
// Decision 1): start/complete handshake binds the persisted tuple, nonces are
// single-use short-TTL, legacy bindings auto-migrate, rotate/revoke tiering
// holds, and binding drift refuses authenticated use loudly.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-agent-enroll-"));
const configDir = path.join(root, "config");
process.env.ANXHUB_CONFIG_DIR = configDir;
process.env.AGENT_ENROLLMENT_PATH = path.join(configDir, "enrollment.json");

const enrollmentService = require("../agent/src/services/enrollmentService");
const { handlePublicEnrollment, handleEnrollmentManagement, assertEnrollmentGate } = require("../agent/src/routes/enroll");
const { tokenFingerprint, writeAgentConfigToken } = require("../src/shared/agentTokenStore");

function makeConfig(overrides = {}) {
  const configPath = path.join(configDir, "agent.json");
  const token = "anxos_enrollment-smoke-shared-token-value-0123456789";
  const config = {
    instanceRoot: path.join(root, "instances"),
    instanceRootSource: "env",
    allowedFolders: [path.join(root, "instances"), path.join(root, "other-allowed")],
    token,
    tokenStatus: { configPath, configured: true, source: "generated", fingerprint: tokenFingerprint(token) },
    ...overrides,
  };
  writeAgentConfigToken(configPath, token);
  return config;
}

function url(pathname) { return new URL(`http://127.0.0.1:47131${pathname}`); }
function request(body) { return { body: JSON.stringify(body), method: "POST", headers: {}, socket: { remoteAddress: "127.0.0.1" } }; }

async function main() {
  let config = makeConfig();

  // 1. Version negotiation: supported protocol window succeeds.
  const started = handlePublicEnrollment(request({ minProtocolVersion: 1, maxProtocolVersion: 1 }), url("/api/v1/enroll/start"), config);
  assert.strictEqual(started.statusCode, 200, "Supported protocol window should start enrollment.");
  assert.strictEqual(started.body.protocolVersion, 1, "Agent must advertise protocol version 1.");
  assert.ok(started.body.enrollNonce && started.body.enrollNonce.length > 30, "Enrollment must return a strong single-use nonce.");
  assert.ok(Date.parse(started.body.enrollNonceExpiresAt) > Date.now(), "Nonce must carry a future expiry.");

  // 2. Version negotiation: unsupported protocol window is refused.
  assert.throws(
    () => handlePublicEnrollment(request({ minProtocolVersion: 2, maxProtocolVersion: 3 }), url("/api/v1/enroll/start"), config),
    (error) => error.code === "PROTOCOL_VERSION_UNSUPPORTED",
    "Unsupported protocol window must be refused before any credential exchange.",
  );
  assert.throws(
    () => handlePublicEnrollment(request({ minimumAgentVersion: "999.0.0" }), url("/api/v1/enroll/start"), config),
    (error) => error.code === "AGENT_VERSION_INCOMPATIBLE",
    "A minimum agent version above the runtime must be refused at start.",
  );

  // 3. Completion binds the persisted tuple (nonce from step 1).
  const newToken = "anxos_enrollment-completed-binding-token-0123456789";
  const completed = handlePublicEnrollment(
    request({ enrollNonce: started.body.enrollNonce, agentToken: newToken, agentUrl: "http://127.0.0.1:47131", instanceRoot: config.instanceRoot }),
    url("/api/v1/enroll/complete"),
    config,
  );
  assert.strictEqual(completed.statusCode, 200, "Valid nonce completion must enroll.");
  assert.strictEqual(completed.body.tokenFingerprint, tokenFingerprint(newToken), "Enrollment must bind the presented token fingerprint.");
  assert.strictEqual(completed.body.protocolVersion, 1, "Enrollment record must pin protocol version.");
  assert.ok(completed.body.enrollmentId.startsWith("enr-"), "Enrollment must mint an enrollmentId.");

  const record = enrollmentService.readEnrollmentRecord();
  assert.strictEqual(record.state, "enrolled", "Persisted record must be enrolled.");
  assert.strictEqual(record.tokenFingerprint, tokenFingerprint(newToken), "Persisted fingerprint must match the enrolled token.");
  assert.strictEqual(record.nodeIdentity.deviceId, completed.body.identity.deviceId, "Record must bind the agent's actual deviceId.");
  assert.strictEqual(record.instanceRoot, config.instanceRoot, "Record must pin the resolved instance root.");
  assert.strictEqual(record.agentInstallationId, completed.body.identity.agentInstallationId, "Record must bind agentInstallationId.");
  const recordMode = fs.statSync(enrollmentService.getEnrollmentPath()).mode & 0o777;
  if (process.platform !== "win32") {
    assert.strictEqual(recordMode, 0o600, "Enrollment record must be written with 0600 permissions.");
  }

  // 4. Nonce single-use: replay is rejected with a distinct code.
  assert.throws(
    () => handlePublicEnrollment(request({ enrollNonce: started.body.enrollNonce, agentToken: newToken }), url("/api/v1/enroll/complete"), config),
    (error) => error.code === "ENROLL_NONCE_REUSED",
    "A replayed nonce must be rejected as reused.",
  );
  assert.throws(
    () => handlePublicEnrollment(request({ enrollNonce: "bogus-nonce-value" }), url("/api/v1/enroll/complete"), config),
    (error) => error.code === "ENROLL_NONCE_INVALID",
    "An unknown nonce must be rejected.",
  );

  // 5. Pinned root must match the actual root unless explicitly allowed.
  let start2 = handlePublicEnrollment(request({}), url("/api/v1/enroll/start"), config);
  assert.throws(
    () => handlePublicEnrollment(request({ enrollNonce: start2.body.enrollNonce, agentToken: newToken, instanceRoot: path.join(root, "stray-tree") }), url("/api/v1/enroll/complete"), config),
    (error) => error.code === "INSTANCE_ROOT_MISMATCH",
    "A stray pinned root outside allowed folders must be refused.",
  );
  start2 = handlePublicEnrollment(request({}), url("/api/v1/enroll/start"), config);
  const pinnedAllowed = handlePublicEnrollment(
    request({ enrollNonce: start2.body.enrollNonce, agentToken: newToken, instanceRoot: path.join(root, "other-allowed", "override") }),
    url("/api/v1/enroll/complete"),
    config,
  );
  assert.strictEqual(pinnedAllowed.statusCode, 200, "An explicitly allowed pinned-root override must be accepted.");
  assert.strictEqual(pinnedAllowed.body.instanceRoot, config.instanceRoot, "The agent still pins its ACTUAL resolved root.");

  // 6. Status summary is public-safe (no roots, no raw secrets).
  const status = handlePublicEnrollment({ method: "GET", body: "" }, url("/api/v1/enroll/status"), config);
  assert.strictEqual(status.body.state, "enrolled", "Status must report enrolled state.");
  assert.strictEqual(JSON.stringify(status.body).includes(config.instanceRoot), false, "Status must not leak the instance root.");

  // 7. Legacy auto-migration: an existing persisted shared token becomes enrolled.
  const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-agent-enroll-legacy-"));
  const legacyDir = path.join(legacyRoot, "config");
  process.env.AGENT_ENROLLMENT_PATH = path.join(legacyDir, "enrollment.json");
  const legacyToken = "anxos_legacy-persisted-shared-token-value-0123456789";
  const legacyConfig = makeConfig({ instanceRoot: path.join(legacyRoot, "instances") });
  legacyConfig.tokenStatus.source = "shared-config";
  legacyConfig.tokenStatus.fingerprint = tokenFingerprint(legacyToken);
  legacyConfig.token = legacyToken;
  writeAgentConfigToken(legacyConfig.tokenStatus.configPath, legacyToken);
  const migration = enrollmentService.migrateLegacyBinding(legacyConfig);
  assert.strictEqual(migration.migrated, true, "A persisted shared-token binding must auto-migrate.");
  assert.strictEqual(migration.record.state, "enrolled", "Migrated binding must be enrolled.");
  assert.strictEqual(migration.record.legacyMigrated, true, "Migration must be flagged for diagnostics.");
  assert.strictEqual(migration.record.tokenFingerprint, tokenFingerprint(legacyToken), "Migration must bind the current credential fingerprint.");
  const migrationAgain = enrollmentService.migrateLegacyBinding(legacyConfig);
  assert.strictEqual(migrationAgain.migrated, false, "Migration must not run twice for an enrolled record.");

  // 8. Binding drift refuses authenticated use with NODE_BINDING_MISMATCH.
  const driftedConfig = { ...legacyConfig, instanceRoot: path.join(legacyRoot, "elsewhere") };
  assert.throws(
    () => assertEnrollmentGate("/api/v1/stats", driftedConfig),
    (error) => error.code === "NODE_BINDING_MISMATCH",
    "Instance-root drift must refuse authenticated routes with NODE_BINDING_MISMATCH.",
  );
  const driftedRecord = enrollmentService.readEnrollmentRecord();
  assert.strictEqual(driftedRecord.state, "unenrolled", "A drifted record must drop to unenrolled.");
  assert.strictEqual(driftedRecord.driftReason, "instance-root", "Drift must record the mismatch reason.");
  // Health/enroll/pairing stay reachable through the gate.
  assert.strictEqual(assertEnrollmentGate("/api/v1/health", driftedConfig), null, "Health must stay reachable after drift.");
  assert.strictEqual(assertEnrollmentGate("/api/v1/enroll/status", driftedConfig), null, "Enrollment status must stay reachable after drift.");

  // 9. Rotation bumps the identity generation and preserves history.
  process.env.AGENT_ENROLLMENT_PATH = path.join(configDir, "enrollment.json");
  const tokenBeforeRotation = config.token;
  const rotated = handleEnrollmentManagement(request({}), url("/api/v1/credentials/rotate"), config);
  assert.strictEqual(rotated.statusCode, 200, "Rotation must succeed on an enrolled agent.");
  assert.notStrictEqual(rotated.body.token, tokenBeforeRotation, "Rotation must mint a new token.");
  assert.notStrictEqual(rotated.body.tokenFingerprint, rotated.body.previousFingerprint, "Rotation must produce a new fingerprint.");
  assert.ok(rotated.body.agentIdentityGeneration, "Rotation must report the rotated identity generation.");
  const afterRotate = enrollmentService.readEnrollmentRecord();
  assert.ok(afterRotate.previousFingerprints.includes(rotated.body.previousFingerprint), "Rotation must append the previous fingerprint.");
  assert.strictEqual(config.token, rotated.body.token, "In-memory credential must follow the rotation.");
  const beforeRotateGeneration = afterRotate.agentIdentityGeneration;
  const rotatedAgain = handleEnrollmentManagement(request({}), url("/api/v1/credentials/rotate"), config);
  assert.notStrictEqual(rotatedAgain.body.agentIdentityGeneration, beforeRotateGeneration, "Each rotation must bump the identity generation.");

  // 10. Revoke requires explicit confirmation and is owner-gated upstream.
  assert.throws(
    () => handleEnrollmentManagement(request({}), url("/api/v1/enroll/revoke"), config),
    (error) => error.code === "REVOKE_CONFIRMATION_REQUIRED",
    "Revocation without explicit confirmation must be refused.",
  );
  const revoked = handleEnrollmentManagement(request({ confirmRevoke: true, reason: "decommissioned" }), url("/api/v1/enroll/revoke"), config);
  assert.strictEqual(revoked.body.state, "revoked", "Confirmed revocation must set revoked state.");
  assert.throws(
    () => assertEnrollmentGate("/api/v1/stats", config),
    (error) => error.code === "REVOKED",
    "Revoked agents must refuse authenticated routes.",
  );
  assert.throws(
    () => handleEnrollmentManagement(request({ confirmRevoke: true }), url("/api/v1/enroll/revoke"), config),
    (error) => error.code === "NO_ACTIVE_ENROLLMENT",
    "A second revocation must report no active enrollment.",
  );
  // Re-enroll after revoke is a fresh cycle.
  const reEnrollStart = handlePublicEnrollment(request({}), url("/api/v1/enroll/start"), config);
  assert.strictEqual(reEnrollStart.statusCode, 200, "Revoked agents must be able to start a fresh enrollment.");

  // 11. Spawn-contract evaluation (Decision 1) is loud and actionable.
  const standalone = enrollmentService.evaluateSpawnEnvironment({});
  assert.strictEqual(standalone.spawnContract, "standalone", "A start without ANXHUB_CONFIG_DIR is a standalone start.");
  assert.strictEqual(standalone.canonical, false, "A standalone start is not canonical.");
  assert.match(standalone.diagnostic, /ANXHUB_CONFIG_DIR/, "The standalone diagnostic must name the missing canonical env.");
  const legacy = enrollmentService.evaluateSpawnEnvironment({ ANXHUB_CONFIG_DIR: path.join(os.tmpdir(), "AnxHub", "config") });
  assert.strictEqual(legacy.spawnContract, "legacy-anxhub", "A legacy AnxHub config dir must be detected.");
  assert.match(legacy.diagnostic, /legacy AnxHub/i, "The legacy diagnostic must be explicit.");
  const desktop = enrollmentService.evaluateSpawnEnvironment({ ANXHUB_CONFIG_DIR: path.join(os.tmpdir(), "AnxOS", "config") });
  assert.strictEqual(desktop.spawnContract, "desktop", "A canonical config dir is a desktop spawn.");
  assert.strictEqual(desktop.diagnostic, null, "A desktop spawn must not emit a diagnostic.");

  console.log("agent:enroll:smoke passed");
}

main().catch((error) => {
  console.error("agent:enroll:smoke FAILED:", error);
  process.exitCode = 1;
});
