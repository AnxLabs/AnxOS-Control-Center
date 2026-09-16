const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// V2-A identity minting regression smoke (docs/v2/V2A_IDENTITY_MODEL.md §3.2):
// the agent mints deviceId + agentInstallationId (stable) and
// agentIdentityGeneration (intentionally rotated) in one schema-v2 store.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-agent-identity-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
delete process.env.AGENT_IDENTITY_PATH;

const {
  DEVICE_IDENTITY_SCHEMA_VERSION,
  getDeviceIdentity,
  getIdentityPath,
  rotateAgentIdentityGeneration,
} = require("../agent/src/services/deviceIdentityService");

function main() {
  // 1. Fresh mint writes the full schema-v2 tuple once, atomically, 0600.
  const first = getDeviceIdentity();
  assert.strictEqual(DEVICE_IDENTITY_SCHEMA_VERSION, 2, "Identity schema must be v2.");
  assert.match(first.deviceId, /^device-[0-9a-f-]{36}$/, "deviceId must keep the device-<uuid> format.");
  assert.match(first.agentInstallationId, /^agenti-[0-9a-f-]{36}$/, "agentInstallationId must be minted per install.");
  assert.match(first.agentIdentityGeneration, /^agentn-[0-9a-f-]{36}$/, "agentIdentityGeneration must be minted per enrollment generation.");
  assert.ok(first.hostname, "Identity must self-describe the hostname.");
  assert.ok(first.agentVersion, "Identity must self-describe the agent version.");
  const persisted = JSON.parse(fs.readFileSync(getIdentityPath(), "utf8"));
  assert.strictEqual(persisted.schemaVersion, 2, "Persisted identity must be schema v2.");
  assert.strictEqual(persisted.deviceId, first.deviceId, "Persisted deviceId must match.");
  if (process.platform !== "win32") {
    assert.strictEqual(fs.statSync(getIdentityPath()).mode & 0o777, 0o600, "Identity file must be 0600.");
  }

  // 2. Stable across reads: no re-minting on repeated calls.
  const second = getDeviceIdentity();
  assert.deepStrictEqual(
    { deviceId: second.deviceId, agentInstallationId: second.agentInstallationId, agentIdentityGeneration: second.agentIdentityGeneration },
    { deviceId: first.deviceId, agentInstallationId: first.agentInstallationId, agentIdentityGeneration: first.agentIdentityGeneration },
    "Repeated identity reads must be stable.",
  );

  // 3. Rotation bumps ONLY the generation; device and installation ids hold.
  const rotated = rotateAgentIdentityGeneration();
  assert.notStrictEqual(rotated.agentIdentityGeneration, first.agentIdentityGeneration, "Rotation must mint a new generation.");
  assert.strictEqual(rotated.deviceId, first.deviceId, "Rotation must preserve deviceId.");
  assert.strictEqual(rotated.agentInstallationId, first.agentInstallationId, "Rotation must preserve agentInstallationId.");
  const afterRotation = getDeviceIdentity();
  assert.strictEqual(afterRotation.agentIdentityGeneration, rotated.agentIdentityGeneration, "Rotation must persist.");

  // 4. Schema v1 upgrade preserves the existing deviceId and mints the new ids
  // with a backup of the v1 record.
  const v1Dir = path.join(root, "v1");
  process.env.AGENT_IDENTITY_PATH = path.join(v1Dir, "device-identity.json");
  fs.mkdirSync(v1Dir, { recursive: true });
  const legacyDeviceId = "device-legacy-lineage-0001";
  fs.writeFileSync(path.join(v1Dir, "device-identity.json"), `${JSON.stringify({ schemaVersion: 1, deviceId: legacyDeviceId }, null, 2)}\n`, { mode: 0o600 });
  const upgraded = getDeviceIdentity();
  assert.strictEqual(upgraded.deviceId, legacyDeviceId, "The v1 upgrade must preserve the existing device lineage.");
  assert.match(upgraded.agentInstallationId, /^agenti-/, "The v1 upgrade must mint agentInstallationId.");
  assert.match(upgraded.agentIdentityGeneration, /^agentn-/, "The v1 upgrade must mint agentIdentityGeneration.");
  assert.ok(fs.existsSync(`${process.env.AGENT_IDENTITY_PATH}.schema-v1.backup`), "The v1 record must be backed up before upgrade.");
  const upgradedPersisted = JSON.parse(fs.readFileSync(process.env.AGENT_IDENTITY_PATH, "utf8"));
  assert.strictEqual(upgradedPersisted.schemaVersion, 2, "Upgraded identity must be schema v2.");
  delete process.env.AGENT_IDENTITY_PATH;

  // 5. Corrupt identity is preserved, never silently replaced.
  const corruptDir = path.join(root, "corrupt");
  process.env.AGENT_IDENTITY_PATH = path.join(corruptDir, "device-identity.json");
  fs.mkdirSync(corruptDir, { recursive: true });
  fs.writeFileSync(process.env.AGENT_IDENTITY_PATH, "{not-json", { mode: 0o600 });
  assert.throws(
    () => getDeviceIdentity(),
    (error) => error.code === "DEVICE_IDENTITY_CORRUPT",
    "A corrupt identity must fail loudly and preserve the original.",
  );
  assert.ok(fs.readdirSync(corruptDir).some((entry) => entry.includes(".corrupt-")), "The corrupt identity must be preserved with a backup.");
  delete process.env.AGENT_IDENTITY_PATH;

  console.log("agent:identity-mint:smoke passed");
}

try {
  main();
} catch (error) {
  console.error("agent:identity-mint:smoke FAILED:", error);
  process.exitCode = 1;
}
