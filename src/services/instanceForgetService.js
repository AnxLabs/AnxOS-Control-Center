const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { decideMigrationRecovery, verifyRecoveryPoint } = require("../shared/migrationRecoveryPolicy");

const FORGOTTEN_SCHEMA_VERSION = 1;
const DEFAULT_NODE_ID = "application-host";

class ForgottenInstanceStoreError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "ForgottenInstanceStoreError";
    this.code = code;
    this.details = details;
  }
}

function getConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) return process.env.ANXHUB_CONFIG_DIR;
  try {
    return app ? path.join(app.getPath("userData"), "config") : path.join(process.cwd(), "config");
  } catch {
    return path.join(process.cwd(), "config");
  }
}

function getForgottenInstancesPath() {
  return path.join(getConfigDirectory(), "forgotten-instances.json");
}

function ensureConfigDirectory() {
  fs.mkdirSync(getConfigDirectory(), { recursive: true });
}

function normalizeId(value) {
  return String(value || "").trim();
}

function entryKey(nodeId, instanceId) {
  return `${normalizeId(nodeId) || DEFAULT_NODE_ID}:${normalizeId(instanceId)}`;
}

function readStore() {
  const filePath = getForgottenInstancesPath();
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: FORGOTTEN_SCHEMA_VERSION, entries: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    throw new ForgottenInstanceStoreError(
      "Forgotten-instance state is unreadable. The original file was preserved for recovery.",
      "FORGOTTEN_INSTANCE_STORE_CORRUPT",
      { causeCode: error?.code || "INVALID_JSON" },
    );
  }
  const schemaVersion = Number.isInteger(parsed?.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > FORGOTTEN_SCHEMA_VERSION) {
    throw new ForgottenInstanceStoreError(
      "Forgotten-instance state was created by a newer application version.",
      "FORGOTTEN_INSTANCE_SCHEMA_UNSUPPORTED",
      { schemaVersion, supportedSchemaVersion: FORGOTTEN_SCHEMA_VERSION },
    );
  }
  const state = {
    schemaVersion: FORGOTTEN_SCHEMA_VERSION,
    entries: Array.isArray(parsed?.entries) ? parsed.entries : [],
  };
  if (schemaVersion < FORGOTTEN_SCHEMA_VERSION) {
    const backupPath = `${filePath}.schema-v${schemaVersion}.backup`;
    const originalBytes = fs.readFileSync(filePath);
    const backupExisted = fs.existsSync(backupPath);
    if (!backupExisted) fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    // V2-J bullet 6: the rewrite below only runs behind a verified recovery
    // point. An unverified copy is refused, not warned past. The forgotten-instance
    // ledger is operator state that cannot be rebuilt from anywhere else.
    let recoveryBytes = null;
    try {
      recoveryBytes = fs.readFileSync(backupPath);
    } catch {
      recoveryBytes = null;
    }
    const recoveryVerification = verifyRecoveryPoint({ mode: "bytes", original: originalBytes, copy: recoveryBytes });
    const recoveryTaken = fs.existsSync(backupPath);
    const recoveryVerdict = decideMigrationRecovery({
      storeId: "forgotten-instances",
      fromSchemaVersion: schemaVersion,
      toSchemaVersion: FORGOTTEN_SCHEMA_VERSION,
      recoveryPoint: { canTake: true, taken: recoveryTaken, verified: recoveryVerification.verified },
      reconstructible: { isReconstructible: false, source: null },
    });
    if (recoveryVerdict.verdict !== "proceed") {
      if (!backupExisted && recoveryTaken) {
        try { fs.rmSync(backupPath, { force: true }); } catch {}
      }
      throw new ForgottenInstanceStoreError(
        "Forgotten-instance state could not be migrated safely because the pre-migration recovery point could not be verified.",
        "FORGOTTEN_INSTANCE_MIGRATION_RECOVERY_UNVERIFIED",
        { storeId: "forgotten-instances", reason: recoveryVerdict.reason, verification: recoveryVerification.reason },
      );
    }
    writeStore(state);
  }
  return state;
}

function writeStore(store) {
  ensureConfigDirectory();
  const filePath = getForgottenInstancesPath();
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({
    schemaVersion: FORGOTTEN_SCHEMA_VERSION,
    entries: store.entries || [],
  }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function rememberForgottenInstance(nodeId, instanceId, details = {}) {
  const normalizedNodeId = normalizeId(nodeId) || DEFAULT_NODE_ID;
  const normalizedInstanceId = normalizeId(instanceId);
  if (!normalizedInstanceId) {
    return null;
  }
  const store = readStore();
  const key = entryKey(normalizedNodeId, normalizedInstanceId);
  const now = new Date().toISOString();
  const entry = {
    nodeId: normalizedNodeId,
    instanceId: normalizedInstanceId,
    reason: normalizeId(details.reason) || "manual-forget",
    createdAt: store.entries.find((candidate) => entryKey(candidate.nodeId, candidate.instanceId) === key)?.createdAt || now,
    updatedAt: now,
  };
  writeStore({
    ...store,
    entries: [
      ...store.entries.filter((candidate) => entryKey(candidate.nodeId, candidate.instanceId) !== key),
      entry,
    ],
  });
  return entry;
}

function clearForgottenInstance(nodeId, instanceId) {
  const normalizedNodeId = normalizeId(nodeId) || DEFAULT_NODE_ID;
  const normalizedInstanceId = normalizeId(instanceId);
  const store = readStore();
  const key = entryKey(normalizedNodeId, normalizedInstanceId);
  const nextEntries = store.entries.filter((candidate) => entryKey(candidate.nodeId, candidate.instanceId) !== key);
  if (nextEntries.length !== store.entries.length) {
    writeStore({ ...store, entries: nextEntries });
  }
}

function isInstanceForgotten(nodeId, instanceId) {
  const key = entryKey(normalizeId(nodeId) || DEFAULT_NODE_ID, instanceId);
  return readStore().entries.some((entry) => entryKey(entry.nodeId, entry.instanceId) === key);
}

function filterForgottenInstances(snapshot = {}, nodeId = DEFAULT_NODE_ID) {
  const entries = Array.isArray(snapshot.instances) ? snapshot.instances : [];
  const filtered = entries.filter((instance) => !isInstanceForgotten(nodeId, instance?.id));
  return filtered.length === entries.length ? snapshot : { ...snapshot, instances: filtered };
}

module.exports = {
  FORGOTTEN_SCHEMA_VERSION,
  ForgottenInstanceStoreError,
  clearForgottenInstance,
  filterForgottenInstances,
  getForgottenInstancesPath,
  isInstanceForgotten,
  rememberForgottenInstance,
};
