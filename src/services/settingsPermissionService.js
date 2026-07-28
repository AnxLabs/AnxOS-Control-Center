const { getStatus, requireLocalOwnerAuthenticated, requireOwner } = require("./securityService");

const SETTINGS_CAPABILITIES = [
  "canManageMarketplaceSettings",
  "canManageDeveloperSettings",
  "canManageInternalUpdates",
  "canManageAdvancedSecurity",
  "canManageInfrastructure",
  "canManageAgentConfiguration",
  "canManageProviderCredentials",
  "canViewDiagnostics",
  "canManageAdvancedNetworking",
];

const OWNER_ONLY_SETTING_KEYS = new Set([
  "developer.debugMode",
  "developer.verboseLogging",
  "security.requireOwnerForSensitiveActions",
  "security.lockAfterInactivity",
  "security.inactivityTimeoutMinutes",
  "security.maskSecrets",
  "security.revealSecretTimeoutSeconds",
  "network.requestTimeoutMs",
  "network.retryAttempts",
  "network.retryBackoffMs",
  "network.heartbeatIntervalMs",
  "network.automaticReconnect",
  "network.ipPreference",
  "network.proxyMode",
  "network.proxyUrl",
  "network.proxyBypass",
  "performance.hardwareAcceleration",
  "performance.logRetentionDays",
  "performance.maxLogSizeMb",
  "performance.backgroundOperationLimit",
  "backups.includeNodes",
  "backups.includeIntegrations",
  "amp.username",
]);

const OWNER_ONLY_CATEGORIES = new Set([
  "developer",
]);

function isOwnerStatus(status = getStatus()) {
  return Boolean(status?.user?.role === "Owner" && (status.user.account !== true || status.user.ownerAuthorized === true));
}

function getSettingsPermissions(status = getStatus()) {
  const owner = isOwnerStatus(status);
  const capabilities = Object.fromEntries(SETTINGS_CAPABILITIES.map((capability) => [capability, owner]));
  return {
    owner,
    authenticated: Boolean(status.authenticated || status.accountAuthenticated),
    role: status.user?.role || (status.setupRequired ? "Local" : "Guest"),
    userId: status.user?.id || null,
    updatedAt: new Date().toISOString(),
    capabilities,
    categories: {
      ownerOnly: [...OWNER_ONLY_CATEGORIES],
    },
    settings: {
      ownerOnly: [...OWNER_ONLY_SETTING_KEYS],
    },
  };
}

function requireSettingsCapability(capability, target = "settings") {
  if (!SETTINGS_CAPABILITIES.includes(capability)) {
    const error = new Error("Unknown settings capability.");
    error.code = "UNKNOWN_SETTINGS_CAPABILITY";
    throw error;
  }
  try {
    return requireOwner(target);
  } catch (error) {
    if (error?.code === "OWNER_REQUIRED") {
      error.code = "FORBIDDEN";
      error.capability = capability;
      error.target = target;
    }
    throw error;
  }
}

function assertCanReadSettingsSecret(capability, target) {
  requireLocalOwnerAuthenticated(target || capability, "Unlock AnxOS to use saved credentials.");
  return requireSettingsCapability(capability, target);
}

function assertCanWriteSettingsPayload(settings = {}, target = "preferences") {
  const keys = Object.keys(settings || {});
  const restricted = keys.filter((key) => OWNER_ONLY_SETTING_KEYS.has(key));
  if (restricted.length) {
    requireSettingsCapability("canManageDeveloperSettings", target);
  }
  return { restricted };
}

function assertCanResetSettingsCategory(category = null) {
  if (!category) {
    requireSettingsCapability("canManageDeveloperSettings", "settings-reset-all");
    return;
  }
  if (OWNER_ONLY_CATEGORIES.has(category)) {
    requireSettingsCapability("canManageDeveloperSettings", `settings-reset-${category}`);
  }
}

module.exports = {
  SETTINGS_CAPABILITIES,
  OWNER_ONLY_CATEGORIES,
  OWNER_ONLY_SETTING_KEYS,
  assertCanReadSettingsSecret,
  assertCanResetSettingsCategory,
  assertCanWriteSettingsPayload,
  getSettingsPermissions,
  requireSettingsCapability,
};
