const { ipcMain } = require("electron");
const {
  getDefaultAgentSettings,
  getAgentConfigPath,
  getEffectiveAgentSettings,
  getSharedAgentTokenStatus,
  pairAgentFromCode,
  readAgentSettings,
  saveAgentSettings,
  testConnection,
  requestJson,
} = require("../services/agentClient");
const { getExecutionTarget, getNode, getSelectedNodeId } = require("../services/nodeService");
const {
  getMarketplaceConfigPath,
  readMarketplaceConfigSafe,
  saveMarketplaceConfig,
} = require("../services/providerConfigService");
const {
  readPreferences,
  resetPreferences,
  updatePreferences,
} = require("../services/settingsPreferenceService");
const {
  assertCanReadSettingsSecret,
  assertCanResetSettingsCategory,
  assertCanWriteSettingsPayload,
  getSettingsPermissions,
} = require("../services/settingsPermissionService");
const curseforgeProvider = require("../services/providers/curseforgeProvider");
const { audit, requirePermission } = require("../services/securityService");
const { createIpcError, normalizeIpcError } = require("../shared/ipcError");

function registerSettingsHandler(channel, handler) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      throw createIpcError(error, {
        code: "SETTINGS_REQUEST_FAILED",
        fallbackMessage: "Settings operation failed.",
        suggestion: "Review the setting value and permissions, then retry.",
      });
    }
  });
}

function getAgentSettingsPayload() {
  const stored = readAgentSettings();
  const effective = getEffectiveAgentSettings();

  return {
    stored,
    effective: {
      backendMode: effective.backendMode,
      agentUrl: effective.agentUrl,
    },
    overrides: effective.overrides,
    defaults: getDefaultAgentSettings(),
    configPath: getAgentConfigPath(),
    tokenStatus: getSafeAgentTokenStatus(),
  };
}

function getSafeAgentTokenStatus() {
  const status = getSharedAgentTokenStatus();
  return {
    configured: status.configured,
    source: status.source,
    fingerprint: status.fingerprint,
    configPath: status.configPath,
    environmentTokenPresent: status.environmentTokenPresent,
    environmentTokenMatches: status.environmentTokenMatches,
    environmentTokenConflict: status.environmentTokenConflict,
    environmentTokenIgnored: status.environmentTokenIgnored,
    weakStoredTokenReplaced: status.weakStoredTokenReplaced,
    weakEnvironmentTokenIgnored: status.weakEnvironmentTokenIgnored,
    restartRequiredAfterRotation: true,
  };
}

function isOnboardingPreferenceUpdate(settings = {}) {
  const keys = Object.keys(settings || {});
  return keys.length > 0 && keys.every((key) =>
    key.startsWith("onboarding.") || key.startsWith("guidance."),
  );
}

function getMarketplaceSettingsPayload() {
  const safeStored = readMarketplaceConfigSafe();
  const stored = safeStored.config;
  const status = curseforgeProvider._test.getApiKeyStatus();
  const diagnostics = curseforgeProvider._test.getConfigurationDiagnostics();
  const selectedNodeId = getSelectedNodeId();
  const selectedNode = getNode(selectedNodeId);

  return {
    stored,
    recovery: safeStored.recovery,
    configPath: getMarketplaceConfigPath(),
    curseForge: {
      configured: diagnostics.configured,
      source: status.source,
      diagnostics: {
        ...diagnostics,
        degraded: safeStored.recovery.degraded || diagnostics.degraded === true,
        recoveryMessage: safeStored.recovery.message || diagnostics.recoveryMessage || null,
        selectedAgentName: selectedNode?.displayName || selectedNodeId,
        selectedAgentId: selectedNodeId,
      },
    },
  };
}

async function testSelectedAgentCurseForgeConnection() {
  const selectedNodeId = getSelectedNodeId();
  const selectedNode = getNode(selectedNodeId);
  const executionTarget = getExecutionTarget(selectedNodeId);
  const checkedAt = new Date().toISOString();
  const base = {
    selectedAgentName: selectedNode?.displayName || selectedNodeId,
    selectedAgentId: selectedNodeId,
    agentReachable: false,
    configured: false,
    source: null,
    fingerprint: null,
    apiConnectivity: "not-tested",
    cdnAuthenticationConnectivity: "not-tested",
    lastTestTime: checkedAt,
    errorCode: null,
  };

  if (executionTarget.type !== "agent") {
    const local = await curseforgeProvider.testConnection();
    return {
      ok: Boolean(local.ok),
      provider: "curseforge",
      diagnostics: {
        ...base,
        agentReachable: true,
        configured: Boolean(local.diagnostics?.configured),
        source: local.diagnostics?.keySource || local.diagnostics?.mode || null,
        fingerprint: local.diagnostics?.keyFingerprint || null,
        apiConnectivity: local.ok ? "passed" : "failed",
        cdnAuthenticationConnectivity: "not-tested",
        errorCode: local.error?.code || null,
      },
      ...(local.error ? { error: local.error } : {}),
    };
  }

  try {
    const status = await requestJson("/api/v1/marketplace/curseforge/status", {
      config: executionTarget.config,
      targetLabel: "curseforge-diagnostics-status",
      suppressConnectionRefusedLog: true,
    });
    const test = await requestJson("/api/v1/marketplace/curseforge/test", {
      config: executionTarget.config,
      targetLabel: "curseforge-diagnostics-test",
      suppressConnectionRefusedLog: true,
      timeoutMs: 45000,
    }).catch((error) => {
      const payload = error?.payload && typeof error.payload === "object" && !Array.isArray(error.payload)
        ? error.payload
        : null;
      const errorCode = payload?.errorCode || payload?.error?.code || error?.code || "CURSEFORGE_AGENT_TEST_FAILED";
      return {
        ok: false,
        checkedAt: payload?.checkedAt || checkedAt,
        errorCode,
        api: payload?.api || { ok: false, status: error?.status || null, errorCode },
        cdn: payload?.cdn || { ok: false, status: null, errorCode: null },
      };
    });
    return {
      ok: Boolean(test.ok),
      provider: "curseforge",
      diagnostics: {
        ...base,
        agentReachable: true,
        configured: Boolean(status.configured),
        source: status.source || null,
        fingerprint: status.fingerprint || null,
        apiConnectivity: test.api?.ok ? "passed" : "failed",
        cdnAuthenticationConnectivity: test.cdn?.ok ? "passed" : "failed",
        lastTestTime: test.checkedAt || checkedAt,
        errorCode: test.errorCode || test.api?.errorCode || test.cdn?.errorCode || null,
      },
      error: test.ok ? null : {
        code: test.errorCode || test.api?.errorCode || test.cdn?.errorCode || "CURSEFORGE_TEST_FAILED",
        message: "CurseForge connection test failed.",
        status: test.api?.status || test.cdn?.status || null,
      },
    };
  } catch (error) {
    const normalized = normalizeIpcError(error, {
      code: "AGENT_UNAVAILABLE",
      fallbackMessage: "Selected Agent is unreachable.",
      suggestion: "Verify the selected Agent URL and credentials, then retry.",
      provider: "curseforge",
    });
    return {
      ok: false,
      provider: "curseforge",
      diagnostics: {
        ...base,
        errorCode: normalized.code,
      },
      error: {
        code: normalized.code,
        message: normalized.friendlyMessage,
        status: normalized.status?.code || null,
        suggestion: normalized.suggestion,
        retryable: normalized.retryable,
      },
    };
  }
}

function registerSettingsIpc() {
  registerSettingsHandler("settings:getPermissions", async () => getSettingsPermissions());
  registerSettingsHandler("settings:getPreferences", async () => {
    requirePermission("settings:read", "preferences");
    return readPreferences();
  });
  registerSettingsHandler("settings:savePreferences", async (_, payload = {}) => {
    const settings = payload.settings || payload;
    if (!isOnboardingPreferenceUpdate(settings)) {
      requirePermission("settings:preferences:write", "preferences");
    }
    assertCanWriteSettingsPayload(settings, "preferences");
    const result = updatePreferences(settings);
    audit({ action: "settings.preferences.save", target: "preferences" });
    return result;
  });
  registerSettingsHandler("settings:resetPreferences", async (_, payload = {}) => {
    requirePermission("settings:preferences:write", payload.category || "preferences");
    assertCanResetSettingsCategory(payload.category || null);
    const result = resetPreferences(payload.category || null);
    audit({ action: "settings.preferences.reset", target: payload.category || "all" });
    return result;
  });
  registerSettingsHandler("settings:getAgentConfig", async () => {
    assertCanReadSettingsSecret("canManageAgentConfiguration", "agent-config");
    return getAgentSettingsPayload();
  });
  registerSettingsHandler("settings:saveAgentConfig", async (_, payload = {}) => {
    assertCanReadSettingsSecret("canManageAgentConfiguration", "agent-config");
    saveAgentSettings(payload);
    audit({ action: "settings.agent.save", target: "agent-config" });
    return getAgentSettingsPayload();
  });
  registerSettingsHandler("settings:testAgentConnection", async (_, payload = null) => {
    assertCanReadSettingsSecret("canManageAgentConfiguration", "agent-connection-test");
    return testConnection(payload);
  });
  registerSettingsHandler("settings:pairAgent", async (_, payload = {}) => {
    assertCanReadSettingsSecret("canManageAgentConfiguration", "agent-pairing");
    const result = pairAgentFromCode(payload.code || payload.pairingCode || "");
    audit({ action: "settings.agent.pair", target: "agent-config", reason: result.fingerprint || null });
    return {
      ...getAgentSettingsPayload(),
      paired: true,
      pairing: {
        agentUrl: result.agentUrl,
        fingerprint: result.fingerprint,
        restartRequired: result.restartRequired,
      },
    };
  });
  registerSettingsHandler("settings:getMarketplaceConfig", async () => {
    assertCanReadSettingsSecret("canManageMarketplaceSettings", "marketplace-config");
    return getMarketplaceSettingsPayload();
  });
  registerSettingsHandler("settings:saveMarketplaceConfig", async (_, payload = {}) => {
    assertCanReadSettingsSecret("canManageMarketplaceSettings", "marketplace-config");
    const saved = saveMarketplaceConfig({ curseForgeApiKey: payload.curseForgeApiKey || "" });
    curseforgeProvider._test.setRuntimeApiKey(saved.curseForgeApiKey);
    audit({ action: "settings.marketplace.save", target: "marketplace-config" });
    return getMarketplaceSettingsPayload();
  });
  registerSettingsHandler("settings:testCurseForgeConnection", async () => {
    assertCanReadSettingsSecret("canManageMarketplaceSettings", "marketplace-config");
    const result = await testSelectedAgentCurseForgeConnection();
    audit({ action: "settings.marketplace.testCurseForge", target: "marketplace-config", reason: result.ok ? "ok" : result.error?.code || "failed" });
    return result;
  });
}

module.exports = {
  registerSettingsIpc,
};
