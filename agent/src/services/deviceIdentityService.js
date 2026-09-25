const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const packageJson = require("../../package.json");
const { decideMigrationRecovery, verifyRecoveryPoint } = require("../../../src/shared/migrationRecoveryPolicy");
// V2-A identity model (docs/v2/V2A_IDENTITY_MODEL.md §3.2): the agent mints
// deviceId (stable per device lineage), agentInstallationId (stable per
// installation) and agentIdentityGeneration (intentionally rotated on
// re-pair / credential rotate / re-enrollment). All three live in
// device-identity.json so node derivation stays deterministic from one store.
const DEVICE_IDENTITY_SCHEMA_VERSION = 2;

function getIdentityPath() {
  return process.env.AGENT_IDENTITY_PATH
    || path.join(process.env.ANXHUB_CONFIG_DIR || path.join(process.cwd(), "config"), "device-identity.json");
}

function newInstallationId() {
  return `agenti-${crypto.randomUUID()}`;
}

function newIdentityGeneration() {
  return `agentn-${crypto.randomUUID()}`;
}

// Normalize a legacy (schema v0/v1) identity record into the v2 shape without
// minting replacement ids for fields the caller already trusts.
function normalizeIdentityRecord(parsed) {
  return {
    schemaVersion: DEVICE_IDENTITY_SCHEMA_VERSION,
    deviceId: parsed.deviceId,
    agentInstallationId: typeof parsed.agentInstallationId === "string" && parsed.agentInstallationId
      ? parsed.agentInstallationId
      : newInstallationId(),
    agentIdentityGeneration: typeof parsed.agentIdentityGeneration === "string" && parsed.agentIdentityGeneration
      ? parsed.agentIdentityGeneration
      : newIdentityGeneration(),
  };
}

function writeIdentity(identityPath, record) {
  fs.mkdirSync(path.dirname(identityPath), { recursive: true });
  const tempPath = `${identityPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({ ...record, schemaVersion: DEVICE_IDENTITY_SCHEMA_VERSION }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, identityPath);
}

function readOrCreateDeviceId() {
  const identityPath = getIdentityPath();
  if (!fs.existsSync(identityPath)) {
    const record = {
      schemaVersion: DEVICE_IDENTITY_SCHEMA_VERSION,
      deviceId: `device-${crypto.randomUUID()}`,
      agentInstallationId: newInstallationId(),
      agentIdentityGeneration: newIdentityGeneration(),
    };
    writeIdentity(identityPath, record);
    return record;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(identityPath, "utf8"));
  } catch (error) {
    const backupPath = `${identityPath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(identityPath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    throw Object.assign(new Error("Agent device identity is unreadable. The original file was preserved; a new identity was not generated."), {
      code: "DEVICE_IDENTITY_CORRUPT",
      details: { causeCode: error?.code || "INVALID_JSON" },
    });
  }
  const schemaVersion = Number.isInteger(parsed?.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > DEVICE_IDENTITY_SCHEMA_VERSION) {
    throw Object.assign(new Error("Agent device identity was created by a newer runtime version."), {
      code: "DEVICE_IDENTITY_SCHEMA_UNSUPPORTED",
      details: { schemaVersion, supportedSchemaVersion: DEVICE_IDENTITY_SCHEMA_VERSION },
    });
  }
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(parsed?.deviceId || "")) {
    throw Object.assign(new Error("Agent device identity is invalid. Repair the preserved identity instead of registering a duplicate node."), {
      code: "DEVICE_IDENTITY_INVALID",
    });
  }
  const record = normalizeIdentityRecord(parsed);
  if (schemaVersion !== DEVICE_IDENTITY_SCHEMA_VERSION) {
    // V2-J bullet 6: the v0/v1->v2 rewrite MINTS new random
    // agentInstallationId / agentIdentityGeneration, so it is irreversible and
    // not reconstructible from anywhere else. Mirror the policy-gated stores:
    // take the pre-upgrade recovery point, read it back and verify it
    // byte-for-byte BEFORE the rewrite, and refuse with
    // DEVICE_IDENTITY_MIGRATION_RECOVERY_UNVERIFIED when it cannot be verified.
    // A device with no prior identity is minted fresh above and never reaches
    // this branch.
    const backupPath = `${identityPath}.schema-v${schemaVersion}.backup`;
    const originalBytes = fs.readFileSync(identityPath);
    const backupExisted = fs.existsSync(backupPath);
    if (!backupExisted) fs.copyFileSync(identityPath, backupPath, fs.constants.COPYFILE_EXCL);
    let recoveryBytes = null;
    try {
      recoveryBytes = fs.readFileSync(backupPath);
    } catch {
      recoveryBytes = null;
    }
    const recoveryVerification = verifyRecoveryPoint({ mode: "bytes", original: originalBytes, copy: recoveryBytes });
    const recoveryTaken = fs.existsSync(backupPath);
    const recoveryVerdict = decideMigrationRecovery({
      storeId: "agent-device-identity",
      fromSchemaVersion: schemaVersion,
      toSchemaVersion: DEVICE_IDENTITY_SCHEMA_VERSION,
      recoveryPoint: { canTake: true, taken: recoveryTaken, verified: recoveryVerification.verified },
      reconstructible: { isReconstructible: false, source: null },
    });
    if (recoveryVerdict.verdict !== "proceed") {
      if (!backupExisted && recoveryTaken) {
        try { fs.rmSync(backupPath, { force: true }); } catch {}
      }
      throw Object.assign(new Error("Agent device identity could not be migrated safely because the pre-migration recovery point could not be verified."), {
        code: "DEVICE_IDENTITY_MIGRATION_RECOVERY_UNVERIFIED",
        details: { storeId: "agent-device-identity", reason: recoveryVerdict.reason, verification: recoveryVerification.reason },
      });
    }
    writeIdentity(identityPath, record);
  }
  return record;
}

// Rotate the identity generation (re-pair / token rotate / re-enrollment).
// deviceId and agentInstallationId are intentionally never touched here.
function rotateAgentIdentityGeneration() {
  const identityPath = getIdentityPath();
  const current = readOrCreateDeviceId();
  const record = { ...current, agentIdentityGeneration: newIdentityGeneration() };
  writeIdentity(identityPath, record);
  return record;
}

function getDeviceIdentity() {
  const record = readOrCreateDeviceId();
  return {
    deviceId: record.deviceId,
    agentInstallationId: record.agentInstallationId,
    agentIdentityGeneration: record.agentIdentityGeneration,
    hostname: os.hostname(),
    operatingSystem: `${os.type()} ${os.release()}`.trim(),
    platform: process.platform,
    architecture: process.arch,
    agentVersion: packageJson.version,
  };
}

module.exports = {
  DEVICE_IDENTITY_SCHEMA_VERSION,
  getDeviceIdentity,
  getIdentityPath,
  rotateAgentIdentityGeneration,
};
