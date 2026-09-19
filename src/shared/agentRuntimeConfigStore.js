const fs = require("fs");
const path = require("path");
const { decideMigrationRecovery, verifyRecoveryPoint } = require("./migrationRecoveryPolicy");

const AGENT_RUNTIME_CONFIG_SCHEMA_VERSION = 1;

function configError(code, message, filePath, cause = null) {
  const error = Object.assign(new Error(message), {
    code,
    configPath: filePath,
    recoverySuggestion: code === "AGENT_RUNTIME_CONFIG_FUTURE_VERSION"
      ? "Update AnxOS Control Center and the Local Agent before retrying."
      : "Restore the Agent configuration backup from Agent Control, or repair the Local Agent configuration.",
  });
  if (cause) Object.defineProperty(error, "cause", { value: cause, enumerable: false });
  return error;
}

function assertConfigObject(value, filePath) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw configError("AGENT_RUNTIME_CONFIG_INVALID", "Agent runtime configuration must be a JSON object.", filePath);
  }
  return value;
}

function normalizeSchema(value, filePath) {
  const schemaVersion = value.schemaVersion === undefined ? 0 : Number(value.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
    throw configError("AGENT_RUNTIME_CONFIG_INVALID_SCHEMA", "Agent runtime configuration has an invalid schema version.", filePath);
  }
  if (schemaVersion > AGENT_RUNTIME_CONFIG_SCHEMA_VERSION) {
    throw configError("AGENT_RUNTIME_CONFIG_FUTURE_VERSION", `Agent runtime configuration schema ${schemaVersion} is newer than supported schema ${AGENT_RUNTIME_CONFIG_SCHEMA_VERSION}.`, filePath);
  }
  return schemaVersion;
}

function parseConfig(raw, filePath) {
  try {
    return assertConfigObject(JSON.parse(raw), filePath);
  } catch (error) {
    if (error?.code?.startsWith("AGENT_RUNTIME_CONFIG_")) throw error;
    throw configError("AGENT_RUNTIME_CONFIG_CORRUPT", "Agent runtime configuration is not valid JSON.", filePath, error);
  }
}

function writeAtomic(filePath, value, { backup = true } = {}) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    fs.writeFileSync(temporaryPath, serialized, { mode: 0o600, flag: "wx" });
    if (backup && fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.backup`);
    fs.renameSync(temporaryPath, filePath);
    try { fs.chmodSync(filePath, 0o600); } catch {}
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    if (error?.code?.startsWith("AGENT_RUNTIME_CONFIG_")) throw error;
    throw configError("AGENT_RUNTIME_CONFIG_WRITE_FAILED", "Agent runtime configuration could not be saved atomically.", filePath, error);
  }
  return value;
}

function migrateConfig(value, schemaVersion, filePath) {
  if (schemaVersion === AGENT_RUNTIME_CONFIG_SCHEMA_VERSION) return value;
  const migrated = { ...value, schemaVersion: AGENT_RUNTIME_CONFIG_SCHEMA_VERSION };
  const migrationBackup = `${filePath}.pre-migration-v${schemaVersion}.backup`;
  const timestamps = fs.statSync(filePath);
  const originalBytes = fs.readFileSync(filePath);
  const backupExisted = fs.existsSync(migrationBackup);
  if (!backupExisted) fs.copyFileSync(filePath, migrationBackup);
  // V2-J bullet 6: the rewrite below only runs behind a recovery point that was
  // read back and verified. An unverified copy is refused, not warned past. The
  // Agent runtime configuration cannot be rebuilt from anywhere else.
  let recoveryBytes = null;
  try {
    recoveryBytes = fs.readFileSync(migrationBackup);
  } catch {
    recoveryBytes = null;
  }
  const recoveryVerification = verifyRecoveryPoint({ mode: "bytes", original: originalBytes, copy: recoveryBytes });
  const recoveryTaken = fs.existsSync(migrationBackup);
  const recoveryVerdict = decideMigrationRecovery({
    storeId: "agent-runtime-config",
    fromSchemaVersion: schemaVersion,
    toSchemaVersion: AGENT_RUNTIME_CONFIG_SCHEMA_VERSION,
    recoveryPoint: { canTake: true, taken: recoveryTaken, verified: recoveryVerification.verified },
    reconstructible: { isReconstructible: false, source: null },
  });
  if (recoveryVerdict.verdict !== "proceed") {
    if (!backupExisted && recoveryTaken) {
      try { fs.rmSync(migrationBackup, { force: true }); } catch {}
    }
    const error = configError(
      "AGENT_RUNTIME_CONFIG_MIGRATION_RECOVERY_UNVERIFIED",
      "Agent runtime configuration could not be migrated safely because the pre-migration recovery point could not be verified.",
      filePath,
    );
    error.details = { storeId: "agent-runtime-config", reason: recoveryVerdict.reason, verification: recoveryVerification.reason };
    throw error;
  }
  const result = writeAtomic(filePath, migrated, { backup: false });
  try { fs.utimesSync(filePath, timestamps.atime, timestamps.mtime); } catch {}
  return result;
}

function readAgentRuntimeConfig(filePath, { defaults = {}, migrate = true } = {}) {
  if (!fs.existsSync(filePath)) return { ...defaults };
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    throw configError("AGENT_RUNTIME_CONFIG_READ_FAILED", "Agent runtime configuration could not be read.", filePath, error);
  }
  const parsed = parseConfig(raw, filePath);
  const schemaVersion = normalizeSchema(parsed, filePath);
  const value = migrate && schemaVersion < AGENT_RUNTIME_CONFIG_SCHEMA_VERSION
    ? migrateConfig(parsed, schemaVersion, filePath)
    : parsed;
  return { ...defaults, ...value };
}

function saveAgentRuntimeConfig(filePath, value) {
  const normalized = assertConfigObject(value, filePath);
  normalizeSchema({ ...normalized, schemaVersion: normalized.schemaVersion ?? AGENT_RUNTIME_CONFIG_SCHEMA_VERSION }, filePath);
  return writeAtomic(filePath, { ...normalized, schemaVersion: AGENT_RUNTIME_CONFIG_SCHEMA_VERSION });
}

function restoreAgentRuntimeConfig(filePath, validate = (value) => value) {
  const backupPath = `${filePath}.backup`;
  if (!fs.existsSync(backupPath)) {
    throw configError("CONFIG_BACKUP_MISSING", "No Agent configuration backup is available.", filePath);
  }
  let restored;
  try {
    const parsed = parseConfig(fs.readFileSync(backupPath, "utf8"), backupPath);
    normalizeSchema(parsed, backupPath);
    restored = validate(parsed);
  } catch (error) {
    if (error?.code?.startsWith("AGENT_RUNTIME_CONFIG_") || error?.code === "CONFIG_BACKUP_MISSING") throw error;
    throw configError("AGENT_RUNTIME_CONFIG_BACKUP_INVALID", "Agent runtime configuration backup is invalid.", backupPath, error);
  }
  if (fs.existsSync(filePath)) {
    const interruptedStatePath = `${filePath}.pre-restore-${Date.now()}.backup`;
    try {
      fs.copyFileSync(filePath, interruptedStatePath, fs.constants.COPYFILE_EXCL);
    } catch (error) {
      throw configError("AGENT_RUNTIME_CONFIG_RESTORE_SNAPSHOT_FAILED", "The current Agent runtime configuration could not be preserved before restore.", filePath, error);
    }
  }
  return writeAtomic(filePath, { ...restored, schemaVersion: AGENT_RUNTIME_CONFIG_SCHEMA_VERSION }, { backup: false });
}

module.exports = {
  AGENT_RUNTIME_CONFIG_SCHEMA_VERSION,
  readAgentRuntimeConfig,
  restoreAgentRuntimeConfig,
  saveAgentRuntimeConfig,
};
