const { BrowserWindow, dialog, ipcMain } = require("electron");
const {
  cancelDownload,
  getDownloads,
  getImportSupport,
  getMinecraftVersionCatalog,
  importCommunityTemplate,
  installTemplate,
  listTemplates,
  retryDownload,
} = require("../services/marketplaceService");
const {
  getProviderPackVersions,
  getProviderPackDetails,
  getManualInstallProviderPage,
  installPack,
  importManualInstallFile,
  marketplaceInstallEvents,
  resumeManualInstall,
  updateSteamCmdInstance,
  searchProviderPacks,
} = require("../services/marketplaceInstallService");
const { audit, requirePermission } = require("../services/securityService");
const { requireNodeContext } = require("./nodeContext");
const { openExternalUrl } = require("../services/externalUrlService");
const { normalizeIpcError } = require("../shared/ipcError");
const { sanitizeForDiagnostics } = require("../shared/redaction");
const crypto = require("crypto");

let progressForwarderRegistered = false;

function getSafeMarketplaceDetails(details = {}) {
  const {
    body: _body,
    responseBody: _responseBody,
    payload: _payload,
    stack: _stack,
    originalStack: _originalStack,
    headers: _headers,
    authorization: _authorization,
    debugMessage: _debugMessage,
    ...safeFields
  } = details && typeof details === "object" ? details : {};
  return sanitizeForDiagnostics(safeFields);
}

function getMarketplaceErrorMessage(error) {
  const code = error?.payload?.error?.code || error?.code;
  const message = error?.payload?.error?.message || error?.message;
  const details = error?.details || error?.payload?.error?.details || {};
  const status = details.status || error?.status || error?.payload?.status || null;
  const validation = error?.payload?.error?.details || details.validation || null;
  const url = details.url || details.invalidUrl || null;
  const body = details.body || details.responseBody || null;
  const name = details.originalName || error?.name || null;
  const stack = details.originalStack || error?.stack || null;

  const parts = [];
  const usefulMessage = message && message !== "Request failed." && message !== "HTTP" && message !== "URL"
    ? message
    : null;
  parts.push(usefulMessage || "Marketplace request failed.");
  if (code) parts.push(`code=${code}`);
  if (status) parts.push(`status=${status}`);
  if (details.provider) parts.push(`provider=${details.provider}`);
  if (details.fileName) parts.push(`file=${details.fileName}`);
  if (url) parts.push(`${details.invalidUrl ? "invalidUrl" : "url"}=${url}`);
  if (body) parts.push(`body=${String(body).slice(0, 1000)}`);
  if (details.recovery) parts.push(`recovery=${details.recovery}`);
  if (details.suggestion) parts.push(`suggestion=${details.suggestion}`);
  if (validation?.field) parts.push(`field=${validation.field}`);
  if (validation?.expected) parts.push(`expected=${validation.expected}`);
  if (validation?.received !== undefined) parts.push(`received=${JSON.stringify(validation.received)}`);
  if (details.field) parts.push(`field=${details.field}`);
  if (details.advertised !== undefined) parts.push(`advertised=${JSON.stringify(details.advertised)}`);
  if (details.resolved !== undefined) parts.push(`resolved=${JSON.stringify(details.resolved)}`);
  if (Array.isArray(details.expectedEnvNames)) parts.push(`expectedEnvNames=${details.expectedEnvNames.join(",")}`);
  if (Array.isArray(details.expectedFileEnvNames)) parts.push(`expectedFileEnvNames=${details.expectedFileEnvNames.join(",")}`);
  if (Array.isArray(details.envSourcesChecked)) parts.push(`envSourcesChecked=${details.envSourcesChecked.join(";")}`);
  if (details.cwd || details.env?.cwd) parts.push(`cwd=${details.cwd || details.env.cwd}`);
  if (details.isPackaged !== undefined || details.env?.isPackaged !== undefined) parts.push(`isPackaged=${details.isPackaged ?? details.env.isPackaged}`);
  if (details.appPath || details.env?.appPath) parts.push(`appPath=${details.appPath || details.env.appPath}`);
  if (details.userDataPath || details.env?.userDataPath) parts.push(`userDataPath=${details.userDataPath || details.env.userDataPath}`);
  if (details.marketplaceConfigPath) parts.push(`marketplaceConfigPath=${details.marketplaceConfigPath}`);
  if (details.env?.resolvedEnvPath !== undefined) parts.push(`resolvedEnvPath=${details.env.resolvedEnvPath || "none"}`);
  if (details.env?.envFileExists !== undefined) parts.push(`envFileExists=${details.env.envFileExists}`);
  if (details.env?.envLoaded !== undefined) parts.push(`envLoaded=${details.env.envLoaded}`);
  if (details.source !== undefined) parts.push(`keySource=${details.source || "none"}`);
  if (name && name !== "Error") parts.push(`error=${name}`);
  if (message === "URL" && !url) parts.push("hint=A URL constructor failed before the invalid value was attached.");

  const detailed = parts.filter(Boolean).join(" | ");

  if (detailed !== "Marketplace request failed.") {
    return detailed;
  }

  return stack ? `${detailed} | stack=${String(stack).split("\n")[0]}` : detailed;
}

function getMarketplaceUiError(error) {
  const code = error?.payload?.error?.code || error?.code;
  const details = error?.details || error?.payload?.error?.details || {};
  const validation = error?.payload?.error?.details?.field
    ? error.payload.error.details
    : details.validation || null;
  const message = error?.payload?.error?.message || error?.message || "";
  if ([
    "PROVIDER_REQUIRED_FILE_RESTRICTED",
    "PROVIDER_MANUAL_DOWNLOAD_REQUIRED",
    "CURSEFORGE_REQUIRED_FILE_RESTRICTED",
    "MODRINTH_REQUIRED_FILE_RESTRICTED",
    "CURSEFORGE_DOWNLOAD_URL_MISSING",
    "CURSEFORGE_INVALID_DOWNLOAD_URL",
    "CURSEFORGE_UNSAFE_URL",
    "CURSEFORGE_DOWNLOAD_FAILED",
    "CURSEFORGE_REQUEST_FAILED",
    "MODRINTH_DOWNLOAD_URL_MISSING",
    "MODRINTH_INVALID_DOWNLOAD_URL",
    "MODRINTH_UNSAFE_URL",
    "MODRINTH_DOWNLOAD_FAILED",
    "MODRINTH_REQUEST_FAILED",
    "PROVIDER_DOWNLOAD_URL_MISSING",
    "PROVIDER_DOWNLOAD_FAILED",
    "PROVIDER_REQUEST_FAILED",
  ].includes(code) || details.recoveryState === "waiting-manual-download") {
    const provider = details.provider || "provider";
    const providerName = details.providerName || provider;
    return {
      code: "PROVIDER_MANUAL_DOWNLOAD_REQUIRED",
      message: "A required modpack file needs manual download.",
      details: {
        ...details,
        provider,
        providerName,
        friendlyMessage: details.friendlyMessage || "This provider does not allow AnxOS to download one required file automatically.",
        file: details.file || details.fileName || null,
        fileName: details.fileName || details.file || null,
        projectId: details.projectId || null,
        fileId: details.fileId || null,
        suggestion: details.suggestion || "Download/import the missing file manually, or choose another pack/server version.",
        debugMessage: getMarketplaceErrorMessage(error),
        originalMessage: message,
      },
    };
  }
  if ([
    "PROVIDER_IMPORT_FILE_NAME_MISMATCH",
    "PROVIDER_IMPORT_FILE_SIZE_MISMATCH",
    "PROVIDER_IMPORT_FILE_HASH_MISMATCH",
    "PROVIDER_MANUAL_FILE_NOT_IMPORTED",
    "PROVIDER_MANUAL_SESSION_NOT_FOUND",
    "PROVIDER_PAGE_UNAVAILABLE",
  ].includes(code)) {
    return {
      code,
      message: message || "Marketplace request failed.",
      details: {
        ...details,
        debugMessage: getMarketplaceErrorMessage(error),
        originalMessage: message,
      },
    };
  }
  if (code === "CURSEFORGE_API_KEY_REQUIRED") {
    return {
      code,
      message: "CurseForge API key required",
      details: {
        provider: "curseforge",
        action: "open-settings",
      },
    };
  }
  if (code === "CURSEFORGE_API_KEY_INVALID") {
    return {
      code,
      message: "CurseForge API key is missing or invalid",
      details: {
        ...details,
        provider: "curseforge",
        action: "open-settings",
        friendlyMessage: "Update the CurseForge API key in Settings, then retry.",
        suggestion: "Open Settings and replace the configured CurseForge API key.",
        debugMessage: getMarketplaceErrorMessage(error),
        originalMessage: message,
      },
    };
  }

  if (code) {
    return {
      code,
      message: validation?.userMessage || (message && message !== "Request failed." ? message : getMarketplaceErrorMessage(error)),
      details: {
        ...details,
        validation,
        friendlyMessage: details.friendlyMessage || validation?.userMessage || message || null,
        suggestion: details.suggestion || getMarketplaceRecoverySuggestion(code),
        debugMessage: getMarketplaceErrorMessage(error),
        originalMessage: message,
      },
    };
  }

  return {
    code: code || "MARKETPLACE_IPC_ERROR",
    message: message && message !== "Request failed." ? message : getMarketplaceErrorMessage(error),
    details: { ...details, debugMessage: getMarketplaceErrorMessage(error), originalMessage: message || null },
  };
}

function getMarketplaceRecoverySuggestion(code) {
  const suggestions = {
    INSTALLER_TYPE_UNSUPPORTED: "Choose another server version or update the Marketplace definition.",
    INVALID_INSTALL_CONTEXT: "Reopen the Marketplace install dialog and retry with a valid target node and instance name.",
    MARKETPLACE_MANIFEST_INVALID: "This Marketplace entry needs to be fixed before it can be installed.",
    MINECRAFT_PORT_INVALID: "Enter a whole-number port between 1 and 65535.",
    MINECRAFT_PORT_IN_USE: "Choose a different local server port.",
    SERVER_PROPERTIES_NOT_WRITABLE: "Check the instance folder permissions, then retry.",
    SERVER_PROPERTIES_UPDATE_FAILED: "Retry the install or open the instance files to inspect server.properties.",
    DEPENDENCIES_REQUIRED: "Install the missing node dependencies, then retry the Marketplace install.",
    ADMIN_REQUIRED: "Configure the Agent with controlled administrator privileges, then retry.",
    UNSUPPORTED_DISTRIBUTION: "Install this dependency manually or use a supported Linux distribution.",
    DEPENDENCY_MISSING: "Install the missing dependency on the selected Agent, then retry.",
    STEAMCMD_NOT_FOUND: "Install SteamCMD on the selected node, then retry.",
    STEAMCMD_INSTALL_FAILED: "Open the install logs, fix the SteamCMD failure, then retry.",
    DOWNLOAD_NOT_FOUND: "Choose another server version or retry later.",
    DOWNLOAD_FAILED: "Check the network connection and retry.",
    EXECUTABLE_NOT_FOUND: "The installer completed but the expected server executable was missing.",
  };
  return suggestions[code] || "Review the technical details, then retry when the underlying issue is fixed.";
}

async function invokeMarketplaceOperation(operation, context = {}) {
  const requestId = context.requestId || crypto.randomUUID();
  const startedAt = Date.now();
  console.info("[Marketplace][IPC] request", {
    stage: "ipc.request", requestId, templateId: context.templateId || null,
    nodeId: context.nodeId || null, instanceName: context.instanceName || null,
  });
  try {
    const result = await operation(requestId);
    console.info("[Marketplace][IPC] response", { stage: "ipc.response", requestId, ok: result?.ok !== false, status: result?.status || 200, elapsedMs: Date.now() - startedAt });
    return result;
  } catch (error) {
    const uiError = getMarketplaceUiError(error);
    uiError.details = getSafeMarketplaceDetails(uiError.details);
    const normalized = normalizeIpcError({
      code: uiError.code,
      message: uiError.message,
      friendlyMessage: uiError.message,
      status: error?.status || error?.payload?.status || error?.details?.status || null,
      details: uiError.details,
      cause: error,
    }, {
      code: "MARKETPLACE_REQUEST_FAILED",
      suggestion: uiError.details.suggestion || getMarketplaceRecoverySuggestion(uiError.code),
      provider: uiError.details.provider || null,
      retryable: uiError.details.retryable,
    });
    console.error("[Marketplace][IPC] Operation failed.", {
      stage: "ipc.error",
      requestId,
      code: normalized.code,
      message: normalized.friendlyMessage,
      status: normalized.status?.code || null,
      provider: normalized.provider?.id || null,
      technicalDetails: normalized.technicalDetails,
      details: uiError.details,
      elapsedMs: Date.now() - startedAt,
    });
    return {
      ok: false,
      error: {
        ...normalized,
        details: uiError.details,
      },
    };
  }
}

function registerMarketplaceIpc() {
  if (!progressForwarderRegistered) {
    progressForwarderRegistered = true;
    marketplaceInstallEvents.on("progress", (payload) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        if (!window.isDestroyed()) {
          window.webContents.send("marketplace:install-progress", payload);
        }
      });
    });
  }

  ipcMain.handle("marketplace:listTemplates", async () => invokeMarketplaceOperation(() => { requirePermission("marketplace:read", "templates"); return listTemplates(); }));
  ipcMain.handle("marketplace:getMinecraftVersions", async (_, payload = {}) => invokeMarketplaceOperation(() => { requirePermission("marketplace:read", payload.templateId); return getMinecraftVersionCatalog(payload.templateId); }));
  ipcMain.handle("marketplace:searchProviderPacks", async (_, payload = {}) => invokeMarketplaceOperation(async () => {
    requirePermission("marketplace:read", payload.provider || "provider-search");
    console.info("[Marketplace][IPC] searchProviderPacks request.", {
      provider: payload.provider || "modrinth",
      mode: payload.mode || "featured",
      query: payload.query || "",
      minecraftVersion: payload.minecraftVersion || payload.version || "",
      loader: payload.loader || "",
      offset: payload.offset || 0,
      limit: payload.limit || null,
    });
    const result = await searchProviderPacks(payload);
    console.info("[Marketplace][IPC] searchProviderPacks response.", {
      provider: result?.provider || payload.provider || "modrinth",
      resultCount: Array.isArray(result?.results) ? result.results.length : 0,
      responseBytes: Buffer.byteLength(JSON.stringify(result || {}), "utf8"),
      diagnostics: result?.diagnostics || null,
    });
    return result;
  }));
  ipcMain.handle("marketplace:getProviderPackVersions", async (_, payload = {}) => invokeMarketplaceOperation(() => { requirePermission("marketplace:read", payload.projectId || payload.id); return getProviderPackVersions(payload); }));
  ipcMain.handle("marketplace:getProviderPackDetails", async (_, payload = {}) => invokeMarketplaceOperation(() => { requirePermission("marketplace:read", payload.projectId || payload.id); return getProviderPackDetails(payload); }));
  ipcMain.handle("marketplace:getImportSupport", async () => invokeMarketplaceOperation(() => { requirePermission("marketplace:read", "import-support"); return getImportSupport(); }));
  ipcMain.handle("marketplace:importCommunityTemplate", async (_, payload = {}) => invokeMarketplaceOperation(() => {
    requirePermission("marketplace:install", payload?.template?.id || payload?.id || "community-template");
    audit({ action: "marketplace.communityTemplate.import", target: payload?.template?.id || payload?.id || "community-template" });
    return importCommunityTemplate(payload);
  }));
  ipcMain.handle("marketplace:installTemplate", async (_, payload = {}) => invokeMarketplaceOperation((requestId) => {
    requireNodeContext(payload, "Marketplace template installation");
    requirePermission("marketplace:install", payload.templateId);
    audit({ action: "marketplace.install", target: payload.templateId });
    return installTemplate({ ...payload, requestId });
  }, payload));
  ipcMain.handle("marketplace:installPack", async (_, payload = {}) => invokeMarketplaceOperation((requestId) => {
    requireNodeContext(payload, "Marketplace provider-pack installation");
    const target = payload.providerProjectId || payload.projectId || payload.templateId || payload.id || payload.template?.id || "provider-pack";
    requirePermission("marketplace:install", target);
    audit({ action: "marketplace.providerPack.install", target });
    return installPack({ ...payload, requestId });
  }, payload));
  ipcMain.handle("marketplace:updateSteamServer", async (_, payload = {}) => invokeMarketplaceOperation(() => {
    requireNodeContext(payload, "SteamCMD server update");
    requirePermission("marketplace:install", payload.instanceId || "steamcmd-update");
    audit({ action: "marketplace.steamcmd.update", target: payload.instanceId || "unknown" });
    return updateSteamCmdInstance({ nodeId: payload.nodeId, instanceId: payload.instanceId });
  }));
  ipcMain.handle("marketplace:openManualDownloadPage", async (_, payload = {}) => invokeMarketplaceOperation(async () => {
    requireNodeContext(payload, "Marketplace manual download recovery");
    requirePermission("marketplace:install", payload.sessionId || "manual-download");
    const result = getManualInstallProviderPage(payload.sessionId, { nodeId: payload.nodeId });
    await openExternalUrl(result.url, { source: "marketplace-manual-download" });
    return { opened: true, ...result };
  }));
  ipcMain.handle("marketplace:importManualDownloadFile", async (_, payload = {}) => invokeMarketplaceOperation(async () => {
    requireNodeContext(payload, "Marketplace manual file import");
    requirePermission("marketplace:install", payload.sessionId || "manual-import");
    const dialogOptions = {
      title: "Import required modpack file",
      properties: ["openFile"],
      filters: [
        { name: "Modpack files", extensions: ["jar", "zip"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const window = BrowserWindow.getFocusedWindow();
    const selection = window
      ? await dialog.showOpenDialog(window, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (selection.canceled || !selection.filePaths?.[0]) {
      return { canceled: true };
    }
    return importManualInstallFile(payload.sessionId, selection.filePaths[0], { nodeId: payload.nodeId });
  }));
  ipcMain.handle("marketplace:resumeManualInstall", async (_, payload = {}) => invokeMarketplaceOperation(() => {
    requireNodeContext(payload, "Marketplace manual install resume");
    requirePermission("marketplace:install", payload.sessionId || "manual-resume");
    return resumeManualInstall(payload.sessionId, { nodeId: payload.nodeId });
  }));
  ipcMain.handle("marketplace:getDownloads", async (_, payload = {}) => invokeMarketplaceOperation(() => { requireNodeContext(payload, "Marketplace download listing"); requirePermission("marketplace:read", payload.nodeId); return getDownloads(payload.nodeId); }));
  ipcMain.handle("marketplace:cancelDownload", async (_, payload = {}) => invokeMarketplaceOperation(() => {
    requireNodeContext(payload, "Marketplace download cancellation");
    requirePermission("marketplace:install", payload.downloadId || "download-cancel");
    return cancelDownload(payload.downloadId, { nodeId: payload.nodeId });
  }));
  ipcMain.handle("marketplace:retryDownload", async (_, payload = {}) => invokeMarketplaceOperation(() => {
    requireNodeContext(payload, "Marketplace download retry");
    requirePermission("marketplace:install", payload.downloadId || "download-retry");
    return retryDownload(payload.downloadId, { nodeId: payload.nodeId });
  }));
}

module.exports = {
  _test: {
    getMarketplaceErrorMessage,
    getMarketplaceUiError,
  },
  registerMarketplaceIpc,
};
