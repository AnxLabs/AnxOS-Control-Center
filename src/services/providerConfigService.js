const fs = require("fs");
const path = require("path");
const { decryptPayload, encryptPayload } = require("./secureSessionStore");
const {
  decideMigrationRecovery,
  verifyRecoveryPoint,
} = require("../shared/migrationRecoveryPolicy");

const MARKETPLACE_CONFIG_SCHEMA_VERSION = 2;

const DEFAULT_MARKETPLACE_CONFIG = {
  curseForgeApiKey: "",
};
const MARKETPLACE_CONFIG_RECOVERY_MESSAGE =
  "Marketplace provider settings could not be restored. Marketplace providers that require saved credentials are temporarily disabled.";

let recoveryState = {
  degraded: false,
  errorCode: null,
  preservedPath: null,
};

function getElectronApp() {
  try {
    const electron = require("electron");
    return electron && typeof electron === "object" ? electron.app || null : null;
  } catch {
    return null;
  }
}

function getConfigDirectory() {
  if (typeof process.env.ANXHUB_CONFIG_DIR === "string" && process.env.ANXHUB_CONFIG_DIR.trim()) {
    return process.env.ANXHUB_CONFIG_DIR.trim();
  }

  const app = getElectronApp();

  if (app) {
    try {
      return path.join(app.getPath("userData"), "config");
    } catch {}
  }

  return path.join(process.cwd(), "config");
}

function getMarketplaceConfigPath() {
  return path.join(getConfigDirectory(), "marketplace.json");
}

function normalizeMarketplaceConfig(config = {}) {
  return {
    curseForgeApiKey: typeof config.curseForgeApiKey === "string" ? config.curseForgeApiKey.trim() : "",
  };
}

function createMarketplaceConfigError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

function getMarketplaceConfigRecoveryState() {
  return {
    degraded: recoveryState.degraded,
    errorCode: recoveryState.errorCode,
    message: recoveryState.degraded ? MARKETPLACE_CONFIG_RECOVERY_MESSAGE : null,
    preserved: Boolean(recoveryState.preservedPath),
  };
}

function enterMarketplaceConfigRecovery(errorCode, configPath) {
  if (!recoveryState.degraded) {
    const preservedPath = `${configPath}.decrypt-failed.backup`;
    try {
      if (!fs.existsSync(preservedPath)) {
        fs.copyFileSync(configPath, preservedPath, fs.constants.COPYFILE_EXCL);
      }
      recoveryState.preservedPath = preservedPath;
    } catch {}
    console.warn("[Marketplace] Provider config decrypt failed; encrypted config preserved and Marketplace entered degraded state.", {
      errorCode,
      preserved: Boolean(recoveryState.preservedPath),
    });
  }
  recoveryState.degraded = true;
  recoveryState.errorCode = errorCode;
}

function clearMarketplaceConfigRecoveryState() {
  recoveryState = {
    degraded: false,
    errorCode: null,
    preservedPath: null,
  };
}

function writeEncryptedConfig(filePath, config) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({
    schemaVersion: MARKETPLACE_CONFIG_SCHEMA_VERSION,
    encrypted: encryptPayload(normalizeMarketplaceConfig(config), filePath),
  }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

// Deterministic key-ordered serialization so a JSON round-trip of the same
// object always compares equal regardless of key insertion order.
function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

// Verification for the marketplace recovery point: read it back, confirm it is
// a parseable envelope, then decrypt it with the recovery point's own path and
// confirm the logical configuration matches what is being migrated. This proves
// the recovery point is readable and holds the same configuration; it does NOT
// prove a restore into a working installation would succeed.
function verifyEncryptedMarketplaceRecoveryPoint(backupPath, expectedConfig) {
  let raw;
  try {
    raw = fs.readFileSync(backupPath);
  } catch {
    raw = null;
  }
  const parsedCheck = verifyRecoveryPoint({
    mode: "json",
    copy: raw,
    expect: (value) => Number.isInteger(value.schemaVersion) && value.encrypted !== null && typeof value.encrypted === "object",
  });
  if (!parsedCheck.verified) return parsedCheck;
  try {
    const envelope = JSON.parse(raw.toString("utf8"));
    const decrypted = normalizeMarketplaceConfig(decryptPayload(envelope.encrypted, backupPath));
    if (canonicalJson(decrypted) !== canonicalJson(normalizeMarketplaceConfig(expectedConfig))) {
      return { ...parsedCheck, verified: false, reason: "recovery_point_payload_mismatch" };
    }
    return { ...parsedCheck, reason: "encrypted_recovery_point_verified" };
  } catch {
    return { ...parsedCheck, verified: false, reason: "recovery_point_payload_unreadable" };
  }
}

function readMarketplaceConfig(options = {}) {
  const configPath = getMarketplaceConfigPath();
  if (!fs.existsSync(configPath)) {
    clearMarketplaceConfigRecoveryState();
    return options.includeSecrets ? { ...DEFAULT_MARKETPLACE_CONFIG } : { hasCurseForgeApiKey: false };
  }
  if (recoveryState.degraded && options.retry !== true) {
    throw createMarketplaceConfigError(
      recoveryState.errorCode || "MARKETPLACE_CONFIG_DECRYPT_FAILED",
      MARKETPLACE_CONFIG_RECOVERY_MESSAGE,
      { preserved: Boolean(recoveryState.preservedPath), retrySuppressed: true },
    );
  }
  if (options.retry === true) {
    clearMarketplaceConfigRecoveryState();
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    const backupPath = `${configPath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    throw createMarketplaceConfigError(
      "MARKETPLACE_CONFIG_CORRUPT",
      "Marketplace provider configuration is unreadable. The original file was preserved for recovery.",
      { causeCode: error?.code || "INVALID_JSON" },
    );
  }
  const schemaVersion = Number.isInteger(parsed?.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > MARKETPLACE_CONFIG_SCHEMA_VERSION) {
    throw createMarketplaceConfigError(
      "MARKETPLACE_CONFIG_SCHEMA_UNSUPPORTED",
      "Marketplace provider configuration was created by a newer application version.",
      { schemaVersion, supportedSchemaVersion: MARKETPLACE_CONFIG_SCHEMA_VERSION },
    );
  }
  let normalized;
  if (schemaVersion === MARKETPLACE_CONFIG_SCHEMA_VERSION) {
    try {
      normalized = normalizeMarketplaceConfig(decryptPayload(parsed.encrypted, configPath));
    } catch (error) {
      enterMarketplaceConfigRecovery("MARKETPLACE_CONFIG_DECRYPT_FAILED", configPath);
      throw createMarketplaceConfigError(
        "MARKETPLACE_CONFIG_DECRYPT_FAILED",
        MARKETPLACE_CONFIG_RECOVERY_MESSAGE,
        { causeCode: error?.code || "DECRYPT_FAILED", preserved: Boolean(recoveryState.preservedPath) },
      );
    }
  } else {
    normalized = normalizeMarketplaceConfig(parsed);
    const backupPath = `${configPath}.schema-v${schemaVersion}.backup`;
    const backupExisted = fs.existsSync(backupPath);
    if (!backupExisted) writeEncryptedConfig(backupPath, normalized);
    // V2-J bullet 6: the legacy marketplace config is re-encoded into the
    // encrypted envelope only behind a recovery point that was read back and
    // verified. The recovery point is a RE-ENCODE of a plaintext original, so
    // verification is a parse check plus a decrypt-and-compare of the logical
    // configuration. An unverified copy is refused, not warned past.
    const recoveryVerification = verifyEncryptedMarketplaceRecoveryPoint(backupPath, normalized);
    const recoveryVerdict = decideMigrationRecovery({
      storeId: "marketplace-provider-config",
      fromSchemaVersion: schemaVersion,
      toSchemaVersion: MARKETPLACE_CONFIG_SCHEMA_VERSION,
      recoveryPoint: { canTake: true, taken: fs.existsSync(backupPath), verified: recoveryVerification.verified },
      // An owner-supplied credential can later replace a lost one, but the
      // stored provider key itself cannot be rebuilt from anywhere.
      reconstructible: { isReconstructible: false, source: null },
    });
    if (recoveryVerdict.verdict !== "proceed") {
      if (!backupExisted) {
        try {
          fs.rmSync(backupPath, { force: true });
        } catch {}
      }
      throw createMarketplaceConfigError(
        "MARKETPLACE_CONFIG_MIGRATION_RECOVERY_UNVERIFIED",
        "Marketplace provider configuration could not be migrated safely because the pre-migration recovery point could not be verified.",
        { storeId: "marketplace-provider-config", reason: recoveryVerdict.reason, verification: recoveryVerification.reason },
      );
    }
    writeEncryptedConfig(configPath, normalized);
  }
  clearMarketplaceConfigRecoveryState();
  return options.includeSecrets
    ? normalized
    : { hasCurseForgeApiKey: Boolean(normalized.curseForgeApiKey) };
}

function readMarketplaceConfigSafe(options = {}) {
  try {
    return {
      config: readMarketplaceConfig(options),
      recovery: getMarketplaceConfigRecoveryState(),
    };
  } catch (error) {
    if (!["MARKETPLACE_CONFIG_DECRYPT_FAILED", "MARKETPLACE_CONFIG_CORRUPT"].includes(error?.code)) {
      throw error;
    }
    return {
      config: options.includeSecrets ? { ...DEFAULT_MARKETPLACE_CONFIG } : { hasCurseForgeApiKey: false },
      recovery: getMarketplaceConfigRecoveryState(),
    };
  }
}

function retryMarketplaceConfig(options = {}) {
  return readMarketplaceConfig({ ...options, retry: true });
}

function saveMarketplaceConfig(config = {}) {
  let existing = { ...DEFAULT_MARKETPLACE_CONFIG };
  try {
    existing = readMarketplaceConfig({ includeSecrets: true });
  } catch (error) {
    if (!["MARKETPLACE_CONFIG_DECRYPT_FAILED", "MARKETPLACE_CONFIG_CORRUPT"].includes(error?.code)) {
      throw error;
    }
    // A new owner-supplied credential is the recovery path. The unreadable source
    // has already been preserved, so do not require decrypting it before replacing it.
  }
  const next = normalizeMarketplaceConfig({
    ...existing,
    ...config,
  });
  const configPath = getMarketplaceConfigPath();
  writeEncryptedConfig(configPath, next);
  clearMarketplaceConfigRecoveryState();
  return next;
}

module.exports = {
  MARKETPLACE_CONFIG_SCHEMA_VERSION,
  MARKETPLACE_CONFIG_RECOVERY_MESSAGE,
  getMarketplaceConfigPath,
  getMarketplaceConfigRecoveryState,
  readMarketplaceConfig,
  readMarketplaceConfigSafe,
  retryMarketplaceConfig,
  saveMarketplaceConfig,
};
