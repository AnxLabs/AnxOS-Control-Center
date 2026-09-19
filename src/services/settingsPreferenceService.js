const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { decideMigrationRecovery, verifyRecoveryPoint } = require("../shared/migrationRecoveryPolicy");

const SETTINGS_SCHEMA_VERSION = 1;
const ONBOARDING_VERSION = 1;

class SettingsStoreError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "SettingsStoreError";
    this.code = code;
    this.details = details;
  }
}

const SETTING_DEFINITIONS = {
  "app.displayName": { category: "general", type: "string", default: "AnxOS Control Center", maxLength: 48 },
  "general.defaultPage": { category: "general", type: "enum", default: "dashboard", values: ["dashboard", "minecraft", "amp", "playit", "docker", "ssh", "files", "console", "backups", "operations", "notifications", "maintenance", "security", "nodes", "agent-control", "coolpals", "settings"] },
  "general.restorePreviousPage": { category: "general", type: "boolean", default: true },
  "general.confirmDestructiveActions": { category: "general", type: "boolean", default: true },
  "interface.guidedMode": { category: "general", type: "boolean", default: false },
  "interface.advancedMode": { category: "general", type: "boolean", default: false },
  "general.openExternalLinks": { category: "general", type: "enum", default: "system", values: ["system"] },
  "general.language": { category: "general", type: "enum", default: "en", values: ["en"], disabledReason: "English is the only bundled language." },

  "appearance.accentColor": { category: "appearance", type: "color", default: "#b66cff" },
  "appearance.theme": { category: "appearance", type: "enum", default: "dark", values: ["dark", "system"] },
  "appearance.density": { category: "appearance", type: "enum", default: "comfortable", values: ["comfortable", "compact"] },
  "appearance.sidebarDensity": { category: "appearance", type: "enum", default: "comfortable", values: ["comfortable", "compact"] },
  "appearance.fontScale": { category: "appearance", type: "number", default: 100, min: 90, max: 115 },
  "appearance.animations": { category: "appearance", type: "boolean", default: true },
  "appearance.reduceMotion": { category: "appearance", type: "boolean", default: false },
  "appearance.transparency": { category: "appearance", type: "boolean", default: true },

  "startup.enabled": { category: "startup", type: "boolean", default: true },
  "startup.minimumDurationMs": { category: "startup", type: "number", default: 4200, min: 0, max: 15000 },
  "startup.sound": { category: "startup", type: "boolean", default: true },
  "startup.soundVolume": { category: "startup", type: "number", default: 42, min: 0, max: 100 },
  "startup.launchOnLogin": { category: "startup", type: "boolean", default: false, restartRequired: true },
  "startup.startMinimized": { category: "startup", type: "boolean", default: false },
  "startup.restoreWindowState": { category: "startup", type: "boolean", default: true },
  "startup.reconnectLastAgent": { category: "startup", type: "boolean", default: true },

  "notifications.enabled": { category: "notifications", type: "boolean", default: true },
  "notifications.persistHistory": { category: "notifications", type: "boolean", default: true },
  "notifications.sound": { category: "notifications", type: "boolean", default: false },
  "notifications.volume": { category: "notifications", type: "number", default: 40, min: 0, max: 100 },
  "notifications.quietHours": { category: "notifications", type: "boolean", default: false },
  "notifications.quietStart": { category: "notifications", type: "string", default: "22:00", maxLength: 5 },
  "notifications.quietEnd": { category: "notifications", type: "string", default: "07:00", maxLength: 5 },

  "security.requireOwnerForSensitiveActions": { category: "security", type: "boolean", default: true },
  "security.lockAfterInactivity": { category: "security", type: "boolean", default: true },
  "security.inactivityTimeoutMinutes": { category: "security", type: "number", default: 30, min: 1, max: 240 },
  "security.maskSecrets": { category: "security", type: "boolean", default: true },
  "security.revealSecretTimeoutSeconds": { category: "security", type: "number", default: 30, min: 5, max: 300 },

  "network.requestTimeoutMs": { category: "network", type: "number", default: 10000, min: 1000, max: 120000 },
  "network.retryAttempts": { category: "network", type: "number", default: 2, min: 0, max: 8 },
  "network.retryBackoffMs": { category: "network", type: "number", default: 750, min: 100, max: 30000 },
  "network.heartbeatIntervalMs": { category: "network", type: "number", default: 5000, min: 1000, max: 60000 },
  "network.automaticReconnect": { category: "network", type: "boolean", default: true },
  "network.ipPreference": { category: "network", type: "enum", default: "auto", values: ["auto", "ipv4", "ipv6"] },
  "network.proxyMode": { category: "network", type: "enum", default: "system", values: ["system", "none", "manual"] },
  "network.proxyUrl": { category: "network", type: "string", default: "", maxLength: 200 },
  "network.proxyBypass": { category: "network", type: "string", default: "localhost,127.0.0.1", maxLength: 500 },

  "performance.hardwareAcceleration": { category: "performance", type: "boolean", default: true, restartRequired: true },
  "performance.refreshIntervalMs": { category: "performance", type: "number", default: 3000, min: 1000, max: 60000 },
  "performance.pausePollingMinimized": { category: "performance", type: "boolean", default: true },
  "performance.logRetentionDays": { category: "performance", type: "number", default: 14, min: 1, max: 90 },
  "performance.maxLogSizeMb": { category: "performance", type: "number", default: 10, min: 1, max: 100 },
  "performance.backgroundOperationLimit": { category: "performance", type: "number", default: 3, min: 1, max: 8 },

  "backups.configBackups": { category: "backups", type: "boolean", default: true },
  "backups.frequency": { category: "backups", type: "enum", default: "weekly", values: ["manual", "daily", "weekly"] },
  "backups.retentionCount": { category: "backups", type: "number", default: 10, min: 1, max: 50 },
  "backups.includePreferences": { category: "backups", type: "boolean", default: true },
  "backups.includeNodes": { category: "backups", type: "boolean", default: true },
  "backups.includeIntegrations": { category: "backups", type: "boolean", default: true },

  "amp.url": { category: "integrations", type: "string", default: "", maxLength: 300 },
  "amp.username": { category: "integrations", type: "string", default: "", maxLength: 120 },
  "minecraft.defaultAddress": { category: "integrations", type: "string", default: "", maxLength: 200 },
  "playit.address": { category: "integrations", type: "string", default: "", maxLength: 200 },
  "onboarding.started": { category: "onboarding", type: "boolean", default: false },
  "onboarding.completed": { category: "onboarding", type: "boolean", default: false },
  "onboarding.currentStep": { category: "onboarding", type: "string", default: "welcome", maxLength: 40 },
  "onboarding.setupType": { category: "onboarding", type: "enum", default: "this-pc", values: ["this-pc", "remote", "both"] },
  "onboarding.usageSelections": { category: "onboarding", type: "string", default: "", maxLength: 200 },
  "onboarding.skipped": { category: "onboarding", type: "boolean", default: false },
  "onboarding.welcomeGuidance": { category: "onboarding", type: "boolean", default: true },
  "onboarding.contextualTips": { category: "onboarding", type: "boolean", default: true },
  "guidance.pageIntroductions": { category: "onboarding", type: "boolean", default: true },
  "guidance.dismissedTips": { category: "onboarding", type: "string", default: "", maxLength: 1000 },
  "onboarding.version": { category: "onboarding", type: "number", default: ONBOARDING_VERSION, min: 1, max: ONBOARDING_VERSION },
  "developer.debugMode": { category: "developer", type: "boolean", default: false },
  "developer.verboseLogging": { category: "developer", type: "boolean", default: false },
};

function getConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) return process.env.ANXHUB_CONFIG_DIR;
  try { return path.join(app.getPath("userData"), "config"); } catch { return path.join(process.cwd(), "config"); }
}

function getSettingsPath() {
  return path.join(getConfigDirectory(), "preferences.json");
}

function defaultSettings() {
  return Object.fromEntries(Object.entries(SETTING_DEFINITIONS).map(([key, definition]) => [key, definition.default]));
}

function sanitizeKey(key) {
  const value = String(key || "");
  if (!Object.prototype.hasOwnProperty.call(SETTING_DEFINITIONS, value)) {
    throw Object.assign(new Error(`Unknown setting key: ${value}`), { code: "UNKNOWN_SETTING_KEY" });
  }
  return value;
}

function validateValue(key, value) {
  const definition = SETTING_DEFINITIONS[sanitizeKey(key)];
  if (definition.type === "boolean") return value === true;
  if (definition.type === "number") {
    const number = Number(value);
    if (!Number.isFinite(number)) throw Object.assign(new Error(`${key} must be a number.`), { code: "INVALID_SETTING_VALUE" });
    return Math.min(definition.max, Math.max(definition.min, number));
  }
  if (definition.type === "enum") {
    if (!definition.values.includes(String(value))) throw Object.assign(new Error(`${key} is not a supported option.`), { code: "INVALID_SETTING_VALUE" });
    return String(value);
  }
  if (definition.type === "color") {
    const text = String(value || "");
    if (!/^#[0-9a-f]{6}$/i.test(text)) throw Object.assign(new Error(`${key} must be a hex color.`), { code: "INVALID_SETTING_VALUE" });
    return text;
  }
  const text = String(value ?? "").slice(0, definition.maxLength || 500);
  if (key === "network.proxyUrl" && text && !/^https?:\/\/[^ ]+$/i.test(text)) {
    throw Object.assign(new Error("Manual proxy URL must be http:// or https://."), { code: "INVALID_SETTING_VALUE" });
  }
  return text;
}

function normalizeSettings(input = {}) {
  const next = defaultSettings();
  for (const [key, value] of Object.entries(input || {})) {
    if (!Object.prototype.hasOwnProperty.call(SETTING_DEFINITIONS, key)) continue;
    try { next[key] = validateValue(key, value); } catch {}
  }
  if (input["general.startupSound"] !== undefined && input["startup.sound"] === undefined) next["startup.sound"] = input["general.startupSound"] === true;
  if (input["server.ampUrl"] && !input["amp.url"]) next["amp.url"] = validateValue("amp.url", input["server.ampUrl"]);
  if (input["server.playitAddress"] && !input["playit.address"]) next["playit.address"] = validateValue("playit.address", input["server.playitAddress"]);
  if (input["server.minecraftName"] && !input["minecraft.defaultAddress"]) next["minecraft.defaultAddress"] = validateValue("minecraft.defaultAddress", input["server.minecraftName"]);
  return next;
}

function readRawFile() {
  const filePath = getSettingsPath();
  if (!fs.existsSync(filePath)) return { exists: false, raw: {} };
  try {
    return { exists: true, raw: JSON.parse(fs.readFileSync(filePath, "utf8")) };
  } catch (error) {
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    throw new SettingsStoreError(
      "Saved preferences are unreadable. The original file was preserved for recovery.",
      "SETTINGS_STORE_CORRUPT",
      { causeCode: error?.code || "INVALID_JSON" },
    );
  }
}

function persistSettings(settings) {
  fs.mkdirSync(getConfigDirectory(), { recursive: true });
  const target = getSettingsPath();
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: SETTINGS_SCHEMA_VERSION, settings, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function readPreferences() {
  const { exists, raw } = readRawFile();
  const schemaVersion = Number.isInteger(raw?.schemaVersion) ? raw.schemaVersion : 0;
  if (schemaVersion > SETTINGS_SCHEMA_VERSION) {
    throw new SettingsStoreError(
      "Saved preferences were created by a newer application version.",
      "SETTINGS_SCHEMA_UNSUPPORTED",
      { schemaVersion, supportedSchemaVersion: SETTINGS_SCHEMA_VERSION },
    );
  }
  const settings = normalizeSettings(raw.settings || raw);
  if (!exists) {
    settings["interface.guidedMode"] = true;
  } else if (schemaVersion < SETTINGS_SCHEMA_VERSION || !raw.settings) {
    const settingsPath = getSettingsPath();
    const backupPath = `${settingsPath}.schema-v${schemaVersion}.backup`;
    const originalBytes = fs.readFileSync(settingsPath);
    const backupExisted = fs.existsSync(backupPath);
    if (!backupExisted) {
      fs.copyFileSync(settingsPath, backupPath, fs.constants.COPYFILE_EXCL);
    }
    // V2-J bullet 6: the rewrite below only runs behind a recovery point that
    // was read back and verified. An unverified copy is refused, not warned
    // past. Operator preferences cannot be rebuilt from anywhere else.
    let recoveryBytes = null;
    try {
      recoveryBytes = fs.readFileSync(backupPath);
    } catch {
      recoveryBytes = null;
    }
    const recoveryVerification = verifyRecoveryPoint({ mode: "bytes", original: originalBytes, copy: recoveryBytes });
    const recoveryTaken = fs.existsSync(backupPath);
    const recoveryVerdict = decideMigrationRecovery({
      storeId: "settings-preferences",
      fromSchemaVersion: schemaVersion,
      toSchemaVersion: SETTINGS_SCHEMA_VERSION,
      recoveryPoint: { canTake: true, taken: recoveryTaken, verified: recoveryVerification.verified },
      reconstructible: { isReconstructible: false, source: null },
    });
    if (recoveryVerdict.verdict !== "proceed") {
      if (!backupExisted && recoveryTaken) {
        try { fs.rmSync(backupPath, { force: true }); } catch {}
      }
      throw new SettingsStoreError(
        "Saved preferences could not be migrated safely because the pre-migration recovery point could not be verified.",
        "SETTINGS_STORE_MIGRATION_RECOVERY_UNVERIFIED",
        { storeId: "settings-preferences", reason: recoveryVerdict.reason, verification: recoveryVerification.reason },
      );
    }
    persistSettings(settings);
  }
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    settings,
    definitions: SETTING_DEFINITIONS,
    configPath: getSettingsPath(),
  };
}

function writePreferences(settings) {
  const next = normalizeSettings(settings);
  persistSettings(next);
  return readPreferences();
}

function updatePreferences(patch = {}) {
  const current = readPreferences().settings;
  const next = { ...current };
  for (const [key, value] of Object.entries(patch || {})) {
    next[sanitizeKey(key)] = validateValue(key, value);
  }
  return writePreferences(next);
}

function resetPreferences(category = null) {
  const current = readPreferences().settings;
  let next = defaultSettings();
  if (category) {
    next = { ...current };
    for (const [key, definition] of Object.entries(SETTING_DEFINITIONS)) {
      if (definition.category === category) next[key] = definition.default;
    }
  }
  return writePreferences(next);
}

module.exports = {
  SETTINGS_SCHEMA_VERSION,
  SettingsStoreError,
  ONBOARDING_VERSION,
  SETTING_DEFINITIONS,
  defaultSettings,
  getSettingsPath,
  readPreferences,
  resetPreferences,
  updatePreferences,
  validateValue,
  writePreferences,
};
