const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-agent-token-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
// resolveAgentConfigPath() prefers an EXISTING candidate over a missing one, so
// the temp config file must exist before the first resolve — otherwise this
// smoke reads (and rewrites) the repo's config/agent.json instead of its own
// isolated tree.
const smokeConfigPath = path.join(process.env.ANXHUB_CONFIG_DIR, "agent.json");
fs.mkdirSync(path.dirname(smokeConfigPath), { recursive: true });
fs.writeFileSync(smokeConfigPath, `${JSON.stringify({ backendMode: "agent", agentUrl: "http://127.0.0.1:47131", agentToken: "" }, null, 2)}\n`, { mode: 0o600 });

const {
  AGENT_CONFIG_SCHEMA_VERSION,
  createAgentPairingPayload,
  parseAgentPairingPayload,
  resolveSharedAgentToken,
  rotateSharedAgentToken,
  writeAgentConfigToken,
} = require("../src/shared/agentTokenStore");
const { isAuthorized } = require("../agent/src/auth");
const { handleHealth } = require("../agent/src/routes/health");

function request(headers = {}) {
  return { headers };
}

function auth(headers, config = { token: "shared-token" }, pathname = "/api/v1/stats") {
  return isAuthorized(request(headers), config, pathname);
}

// B1 ownership invariant: a root-run CLI rewrite (`sudo anxos-agent unpair`)
// must not turn a config owned by the service user into a root-owned file. On
// POSIX and as root we simulate the packaged install by chowning the target to
// a foreign uid/gid and assert the atomic writer preserves it. Windows has no
// uid/gid to preserve (process.getuid is unavailable), so the leg is an
// explicit SKIP there; a non-root POSIX run asserts the same-owner invariant
// and reports that the foreign-owner simulation was skipped.
function ownershipPreservationLeg() {
  if (process.platform === "win32" || typeof process.getuid !== "function") {
    console.log("SKIP (win32): atomic-writer ownership preservation is POSIX-only and cannot be asserted on this platform.");
    return;
  }
  const ownershipDir = path.join(root, "ownership");
  const ownershipPath = path.join(ownershipDir, "agent.json");
  fs.mkdirSync(ownershipDir, { recursive: true });
  fs.writeFileSync(
    ownershipPath,
    `${JSON.stringify({ backendMode: "agent", agentUrl: "http://127.0.0.1:47131", agentToken: "" }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const initial = fs.statSync(ownershipPath);
  let expectedUid = initial.uid;
  let expectedGid = initial.gid;
  let simulatedForeignOwner = false;
  if (process.getuid() === 0) {
    try {
      fs.chownSync(ownershipPath, 12345, 12345);
      const foreign = fs.statSync(ownershipPath);
      expectedUid = foreign.uid;
      expectedGid = foreign.gid;
      simulatedForeignOwner = true;
    } catch {
      // Cannot simulate a foreign owner from this process.
    }
  }
  const token = `anxos_${"e".repeat(40)}`;
  writeAgentConfigToken(ownershipPath, token, {});
  const after = fs.statSync(ownershipPath);
  assert.strictEqual(after.uid, expectedUid, `the atomic writer must preserve the target uid (${expectedUid}), got ${after.uid}.`);
  assert.strictEqual(after.gid, expectedGid, `the atomic writer must preserve the target gid (${expectedGid}), got ${after.gid}.`);
  assert.strictEqual(after.mode & 0o777, 0o600, "the atomic writer must preserve mode 0600.");
  assert.strictEqual(JSON.parse(fs.readFileSync(ownershipPath, "utf8")).agentToken, token, "the ownership leg must still write the payload.");
  if (simulatedForeignOwner) {
    console.log(`ownership leg passed: root-equivalent atomic write preserved uid=${expectedUid} gid=${expectedGid} mode=0600`);
  } else {
    console.log("SKIP (posix non-root): foreign-owner simulation requires root; same-owner uid/gid and mode 0600 preservation were asserted instead.");
  }
}

// Deterministic branch coverage for the B1 fix, runnable on every platform:
// stub POSIX availability and observe the atomic writer handing the temp file
// the TARGET's uid/gid before the rename, and skipping the chown entirely when
// no target exists. This is the behavior the POSIX leg asserts against a real
// filesystem; here it is asserted against the call contract itself.
function ownershipBranchLeg() {
  const branchDir = path.join(root, "ownership-branch");
  fs.mkdirSync(branchDir, { recursive: true });
  const targetPath = path.join(branchDir, "agent.json");
  const token = `anxos_${"d".repeat(40)}`;
  fs.writeFileSync(targetPath, `${JSON.stringify({ schemaVersion: AGENT_CONFIG_SCHEMA_VERSION, backendMode: "agent", agentUrl: "http://127.0.0.1:47131", agentToken: "" }, null, 2)}\n`, { mode: 0o600 });

  const realGetuid = process.getuid;
  const realChownSync = fs.chownSync;
  const realStatSync = fs.statSync;
  const chownCalls = [];
  try {
    process.getuid = () => 0;
    fs.statSync = (candidate, ...rest) => (candidate === targetPath ? { uid: 4242, gid: 4343 } : realStatSync(candidate, ...rest));
    fs.chownSync = (candidate, uid, gid) => { chownCalls.push({ candidate, uid, gid }); };
    writeAgentConfigToken(targetPath, token, {});
    assert.strictEqual(chownCalls.length, 1, "an existing target must trigger exactly one chown per replace.");
    assert.strictEqual(chownCalls[0].uid, 4242, "the temp file must receive the target's uid.");
    assert.strictEqual(chownCalls[0].gid, 4343, "the temp file must receive the target's gid.");
    assert(chownCalls[0].candidate !== targetPath && chownCalls[0].candidate.startsWith(`${targetPath}.`), "the chown must target the temp file, never the target path.");
    assert.strictEqual(JSON.parse(fs.readFileSync(targetPath, "utf8")).agentToken, token, "the replace must still persist the payload.");

    chownCalls.length = 0;
    const freshPath = path.join(branchDir, "fresh.json");
    writeAgentConfigToken(freshPath, token, {});
    assert.strictEqual(chownCalls.length, 0, "a missing target must not trigger a chown.");
    assert.strictEqual(JSON.parse(fs.readFileSync(freshPath, "utf8")).agentToken, token, "the fresh write must still persist the payload.");
  } finally {
    process.getuid = realGetuid;
    fs.chownSync = realChownSync;
    fs.statSync = realStatSync;
  }
  console.log("ownership branch leg passed: temp file chowned to the target uid/gid before rename; missing target skips chown");
}

function main() {
  const health = auth({}, { token: "" }, "/api/v1/health");
  assert.strictEqual(health.ok, true, "Public health endpoint should work without authentication.");
  return Promise.resolve(handleHealth({ token: "shared-token", tokenStatus: { fingerprint: "abc123", configPath: "/tmp/agent.json" } })).then((healthResponse) => {
    assert.strictEqual(healthResponse.body.tokenFingerprint, "abc123", "Health endpoint should expose running token fingerprint.");
    assert.strictEqual(healthResponse.body.tokenConfigured, true, "Health endpoint should expose safe token configured status.");
  }).then(() => {

  const missing = auth({}, { token: "" });
  assert.strictEqual(missing.ok, false, "Missing server token should fail protected routes.");
  assert.strictEqual(missing.statusCode, 503, "Missing server token should return setup error status.");
  assert.strictEqual(missing.code, "AGENT_TOKEN_MISSING", "Missing server token should return setup error code.");

  const matchedHeader = auth({ "x-agent-token": "shared-token" });
  assert.strictEqual(matchedHeader.ok, true, "Matching X-Agent-Token should authorize.");

  const matchedBearer = auth({ authorization: "Bearer shared-token" });
  assert.strictEqual(matchedBearer.ok, true, "Matching bearer token should authorize.");

  const wrong = auth({ "x-agent-token": "wrong-token" });
  assert.strictEqual(wrong.ok, false, "Wrong token should fail.");
  assert.strictEqual(wrong.statusCode, 401, "Wrong token should return 401.");
  assert.strictEqual(wrong.code, "UNAUTHORIZED", "Wrong token should return unauthorized code.");

  const first = resolveSharedAgentToken();
  assert(first.token && first.token.length > 30, "Shared token should be generated when missing.");
  assert(fs.existsSync(first.configPath), "Shared token should be persisted.");
  assert.strictEqual(first.tokenOrigin, "generated", "A self-generated credential must report tokenOrigin=generated.");
  const firstPersisted = JSON.parse(fs.readFileSync(first.configPath, "utf8"));
  assert.strictEqual(firstPersisted.tokenOrigin, "generated", "A self-generated credential must persist tokenOrigin=generated.");

  // Restart view: a persisted generated credential resolves as shared-config
  // but keeps its generated provenance, which is what keeps it unenrolled.
  const restarted = resolveSharedAgentToken();
  assert.strictEqual(restarted.source, "shared-config", "A persisted credential must resolve as shared-config on restart.");
  assert.strictEqual(restarted.tokenOrigin, "generated", "A persisted generated credential must keep its provenance across restarts.");
  assert.strictEqual(restarted.token, first.token, "A restart must reuse the persisted credential.");

  process.env.AGENT_TOKEN = "stale-shell-token";
  const conflict = resolveSharedAgentToken();
  assert.strictEqual(conflict.token, first.token, "Stale shell token must not silently override the shared token.");
  assert.strictEqual(conflict.environmentTokenConflict, true, "Stale shell token should be reported as a conflict.");
  assert.strictEqual(conflict.environmentTokenIgnored, true, "Stale shell token should be ignored.");

  const configPath = path.join(process.env.ANXHUB_CONFIG_DIR, "agent.json");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  // Each legacy-config rewrite needs a FRESH verified recovery point: a stale
  // .schema-v0.backup from the first migration would fail verification against
  // this new original (and the store is right to refuse that).
  fs.rmSync(`${configPath}.schema-v0.backup`, { force: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ backendMode: "agent", agentUrl: "http://127.0.0.1:47131", agentToken: "test-token" }, null, 2)}\n`);
  delete process.env.AGENT_TOKEN;
  const replaced = resolveSharedAgentToken();
  assert.notStrictEqual(replaced.token, "test-token", "Weak default token should be replaced.");
  assert.strictEqual(replaced.weakStoredTokenReplaced, true, "Weak token replacement should be reported.");
  assert.strictEqual(replaced.tokenOrigin, "generated", "A replaced weak token is self-generated and must be marked generated.");
  assert.strictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).tokenOrigin, "generated", "The generated provenance must be persisted.");
  assert.strictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).schemaVersion, AGENT_CONFIG_SCHEMA_VERSION, "Legacy Agent config should migrate to the current schema.");
  assert(fs.existsSync(`${configPath}.schema-v0.backup`), "Legacy Agent config migration should preserve the original file.");

  // Environment bootstrap: adopting an env token must not claim generated
  // provenance, and must clear a stale marker so the credential keeps the
  // legacy migration behavior on the next start.
  const envBootstrapToken = "anxos_environment-bootstrap-token-value-0123456789";
  fs.writeFileSync(configPath, `${JSON.stringify({ schemaVersion: AGENT_CONFIG_SCHEMA_VERSION, backendMode: "agent", agentUrl: "http://127.0.0.1:47131", agentToken: "", tokenOrigin: "generated" }, null, 2)}\n`, { mode: 0o600 });
  process.env.AGENT_TOKEN = envBootstrapToken;
  const bootstrapped = resolveSharedAgentToken();
  delete process.env.AGENT_TOKEN;
  assert.strictEqual(bootstrapped.source, "environment-bootstrap", "An env token must resolve as environment-bootstrap.");
  assert.strictEqual(bootstrapped.tokenOrigin, null, "An environment bootstrap credential must not claim generated provenance.");
  assert.strictEqual(bootstrapped.token, envBootstrapToken, "The environment token must be adopted.");
  assert.strictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).tokenOrigin, undefined, "Adopting an environment token must clear stale generated provenance.");

  const rotated = rotateSharedAgentToken();
  assert(rotated.fingerprint && !rotated.fingerprint.includes(rotated.token), "Rotation should provide only a fingerprint for display.");
  assert.notStrictEqual(rotated.token, replaced.token, "Rotation should create a new token.");
  assert.strictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).tokenOrigin, "desktop-rotation", "Rotation must persist desktop-rotation provenance.");
  rotateSharedAgentToken({ updates: { tokenOrigin: "pairing" } });
  assert.strictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).tokenOrigin, "pairing", "Explicit caller updates must override the rotation provenance default.");

  const pairing = createAgentPairingPayload({ agentUrl: "http://10.0.0.5:47131" });
  assert(pairing.code.startsWith("ANXOS-PAIR."), "Pairing export should produce an AnxOS pairing code.");
  assert(pairing.fingerprint && !pairing.code.includes(pairing.fingerprint), "Pairing code should not rely on fingerprint as the secret.");
  const imported = parseAgentPairingPayload(pairing.code);
  assert.strictEqual(imported.agentUrl, "http://10.0.0.5:47131", "Pairing import should preserve agent URL.");
  assert.strictEqual(imported.fingerprint, pairing.fingerprint, "Pairing import should verify fingerprint.");
  assert(imported.agentToken && imported.agentToken.length > 30, "Pairing import should recover the token for secure local storage.");

  const expired = createAgentPairingPayload({ ttlMs: -1000 });
  assert.throws(() => parseAgentPairingPayload(expired.code), /expired/i, "Expired pairing codes should be rejected.");

  const agentClient = require("../src/services/agentClient");
  agentClient.saveAgentSettings({
    backendMode: "agent",
    agentUrl: "http://10.0.0.5:47131",
    agentToken: imported.agentToken,
  });
  const formOverrideConfig = agentClient.getAgentConfig({
    backendMode: "agent",
    agentUrl: "http://10.0.0.5:47131",
  });
  assert.strictEqual(formOverrideConfig.token, imported.agentToken, "Blank Settings form token should preserve the saved paired token.");

  const futureConfig = { schemaVersion: AGENT_CONFIG_SCHEMA_VERSION + 1, backendMode: "agent", agentToken: rotated.token };
  fs.writeFileSync(configPath, `${JSON.stringify(futureConfig)}\n`, { mode: 0o600 });
  const futureRaw = fs.readFileSync(configPath, "utf8");
  assert.throws(
    () => resolveSharedAgentToken(),
    (error) => error?.code === "AGENT_CONFIG_SCHEMA_UNSUPPORTED",
    "Future Agent config schemas must fail without rotating credentials.",
  );
  assert.strictEqual(fs.readFileSync(configPath, "utf8"), futureRaw, "Future Agent config must remain unchanged.");

  fs.writeFileSync(configPath, "{not-json\n", { mode: 0o600 });
  assert.throws(
    () => resolveSharedAgentToken(),
    (error) => error?.code === "AGENT_CONFIG_CORRUPT",
    "Corrupt Agent config must not generate and persist a replacement token.",
  );
  assert(fs.readdirSync(path.dirname(configPath)).some((name) => name.startsWith(`${path.basename(configPath)}.corrupt-`)), "Corrupt Agent config should be preserved.");
  assert.throws(
    () => agentClient.readAgentSettings(),
    (error) => error?.code === "AGENT_CONFIG_CORRUPT",
    "Desktop Agent settings reads must not convert corrupt shared configuration to defaults.",
  );
  const corruptRaw = fs.readFileSync(configPath, "utf8");
  assert.throws(
    () => agentClient.saveAgentSettings({ backendMode: "local" }),
    (error) => error?.code === "AGENT_CONFIG_CORRUPT",
    "Desktop Agent settings writes must not overwrite corrupt shared configuration.",
  );
  assert.strictEqual(fs.readFileSync(configPath, "utf8"), corruptRaw, "Rejected settings writes must preserve corrupt Agent configuration for recovery.");

  const identityPath = path.join(root, "device-identity.json");
  process.env.AGENT_IDENTITY_PATH = identityPath;
  const identityService = require("../agent/src/services/deviceIdentityService");
  fs.writeFileSync(identityPath, `${JSON.stringify({ deviceId: "legacy-device-id" })}\n`, { mode: 0o600 });
  assert.strictEqual(identityService.getDeviceIdentity().deviceId, "legacy-device-id", "Legacy device identity should survive migration.");
  assert.strictEqual(JSON.parse(fs.readFileSync(identityPath, "utf8")).schemaVersion, identityService.DEVICE_IDENTITY_SCHEMA_VERSION, "Legacy device identity should migrate to the current schema.");
  assert(fs.existsSync(`${identityPath}.schema-v0.backup`), "Device identity migration should preserve the original file.");
  const futureIdentity = { schemaVersion: identityService.DEVICE_IDENTITY_SCHEMA_VERSION + 1, deviceId: "future-device-id" };
  fs.writeFileSync(identityPath, `${JSON.stringify(futureIdentity)}\n`, { mode: 0o600 });
  const futureIdentityRaw = fs.readFileSync(identityPath, "utf8");
  assert.throws(
    () => identityService.getDeviceIdentity(),
    (error) => error?.code === "DEVICE_IDENTITY_SCHEMA_UNSUPPORTED",
    "Future device identity schemas must fail without generating a duplicate identity.",
  );
  assert.strictEqual(fs.readFileSync(identityPath, "utf8"), futureIdentityRaw, "Future device identity must remain unchanged.");
  fs.writeFileSync(identityPath, "{not-json\n", { mode: 0o600 });
  assert.throws(
    () => identityService.getDeviceIdentity(),
    (error) => error?.code === "DEVICE_IDENTITY_CORRUPT",
    "Corrupt device identity must not generate a replacement identity.",
  );

    ownershipPreservationLeg();
    ownershipBranchLeg();
    console.log("Agent token smoke checks passed.");
  });
}

main()?.catch?.((error) => {
  console.error(error);
  process.exit(1);
});
