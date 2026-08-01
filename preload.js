const { contextBridge, ipcRenderer } = require("electron");

function getBridgeByteLength(value) {
  if (typeof value !== "string" || !value) {
    return 0;
  }

  return Buffer.byteLength(value, "utf8");
}

function recordSshBridgeWrite(sessionId, value) {
  globalThis.__anxSshBridgeDiagnostics = {
    writeInvoked: true,
    byteLength: getBridgeByteLength(value),
    sessionPresent: Boolean(sessionId),
    updatedAt: new Date().toISOString(),
  };
}

function forwardPreloadError(operation, error) {
  ipcRenderer.send("diagnostics:log", { severity: "error", source: "preload", file: "desktop", operation, message: error?.message || String(error), context: { code: error?.code || null, stack: error?.stack || null } });
}
process.on("uncaughtException", (error) => forwardPreloadError("uncaught-exception", error));
process.on("unhandledRejection", (reason) => forwardPreloadError("unhandled-rejection", reason instanceof Error ? reason : new Error(String(reason))));

async function invokeAccount(channel, payload) {
  const result = payload === undefined
    ? await ipcRenderer.invoke(channel)
    : await ipcRenderer.invoke(channel, payload);

  if (result && result.ok === false && result.error) {
    const error = new Error(result.error.message || "AnxOS account request failed.");
    error.code = result.error.code || "ACCOUNT_REQUEST_FAILED";
    throw error;
  }

  return result;
}

async function invokeMarketplace(channel, payload) {
  const result = payload === undefined
    ? await ipcRenderer.invoke(channel)
    : await ipcRenderer.invoke(channel, payload);

  if (result && result.ok === false && result.error) {
    const error = new Error(result.error.message || result.error.friendlyMessage || "Marketplace request failed.");
    error.code = result.error.code || "MARKETPLACE_REQUEST_FAILED";
    error.details = result.error.details || {};
    error.friendlyMessage = result.error.friendlyMessage || error.message;
    error.suggestion = result.error.suggestion || error.details.suggestion || null;
    error.retryable = result.error.retryable === true;
    error.status = result.error.status?.code || null;
    error.provider = result.error.provider?.id || null;
    error.diagnostics = result.error.diagnostics || error.details.diagnostics || null;
    throw error;
  }

  return result;
}

async function invokeAgentFeature(channel, payload) {
  const result = payload === undefined
    ? await ipcRenderer.invoke(channel)
    : await ipcRenderer.invoke(channel, payload);

  if (result && result.ok === false && result.error) {
    const error = new Error(result.error.message || "Agent request failed.");
    error.code = result.error.code || "AGENT_REQUEST_FAILED";
    error.details = result.error.details || {};
    throw error;
  }

  return result;
}

const windowApi = {
  minimize: () => ipcRenderer.send("window:minimize"),
  maximize: () => ipcRenderer.send("window:maximize"),
  restore: () => ipcRenderer.send("window:restore"),
  close: () => ipcRenderer.send("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  openWorkspace: (surface, context = {}) => ipcRenderer.invoke("window:openWorkspace", {
    surface,
    context,
    templateId: context?.template?.id || "",
  }),
  focusMain: (page = "") => ipcRenderer.invoke("window:focusMain", { page }),
  getWorkspaceContext: () => ipcRenderer.invoke("window:getWorkspaceContext"),
  onWorkspaceInit: (callback) => {
    const handler = (_, payload) => callback(payload || {});
    ipcRenderer.on("workspaceWindow:init", handler);
    return () => ipcRenderer.removeListener("workspaceWindow:init", handler);
  },
  onNavigate: (callback) => {
    const handler = (_, payload) => callback(payload || {});
    ipcRenderer.on("window:navigate", handler);
    return () => ipcRenderer.removeListener("window:navigate", handler);
  },
  onMaximizedChanged: (callback) => {
    const handler = (_, isMaximized) => callback(Boolean(isMaximized));
    ipcRenderer.on("window:maximized-changed", handler);
    return () => ipcRenderer.removeListener("window:maximized-changed", handler);
  },
};

const desktopApi = {
  app: {
    getRuntimeInfo: () => ipcRenderer.invoke("app:getRuntimeInfo"),
  },
  diagnostics: {
    log: (payload = {}) => ipcRenderer.invoke("diagnostics:log", payload),
    capture: (payload = {}) => ipcRenderer.invoke("diagnostics:capture", payload),
    read: (payload = {}) => ipcRenderer.invoke("diagnostics:read", payload),
    openFolder: () => ipcRenderer.invoke("diagnostics:openFolder"),
    copySummary: () => ipcRenderer.invoke("diagnostics:copySummary"),
    exportBundle: () => ipcRenderer.invoke("diagnostics:export"),
  },
  agentControl: {
    list: (payload = {}) => ipcRenderer.invoke("agentControl:list", payload),
    status: (payload = {}) => ipcRenderer.invoke("agentControl:status", payload),
    diagnostics: () => ipcRenderer.invoke("agentControl:diagnostics"),
    remoteDiagnostics: (nodeId) => ipcRenderer.invoke("agentControl:remoteDiagnostics", { nodeId }),
    getConfig: () => ipcRenderer.invoke("agentControl:getConfig"),
    saveConfig: (payload = {}) => ipcRenderer.invoke("agentControl:saveConfig", payload),
    restoreConfig: () => ipcRenderer.invoke("agentControl:restoreConfig"),
    resetConfig: () => ipcRenderer.invoke("agentControl:resetConfig"),
    start: () => ipcRenderer.invoke("agentControl:start"),
    installLocalAgent: (payload = {}) => ipcRenderer.invoke("agentControl:installLocalAgent", payload),
    stopOldLocalAgentAndRepair: (payload = {}) => ipcRenderer.invoke("agentControl:stopOldLocalAgentAndRepair", payload),
    pairLocalAgent: (payload = {}) => ipcRenderer.invoke("agentControl:pairLocalAgent", payload),
    startPairingSession: (payload = {}) => ipcRenderer.invoke("agentControl:startPairingSession", payload),
    updateLocalAgent: (payload = {}) => ipcRenderer.invoke("agentControl:updateLocalAgent", payload),
    stop: () => ipcRenderer.invoke("agentControl:stop"),
    restart: () => ipcRenderer.invoke("agentControl:restart"),
    forceRestart: () => ipcRenderer.invoke("agentControl:forceRestart"),
    installService: () => ipcRenderer.invoke("agentControl:installService"),
    uninstallService: () => ipcRenderer.invoke("agentControl:uninstallService"),
    enableAutoStart: () => ipcRenderer.invoke("agentControl:enableAutoStart"),
    disableAutoStart: () => ipcRenderer.invoke("agentControl:disableAutoStart"),
    openLogs: () => ipcRenderer.invoke("agentControl:openLogs"),
    openDataFolder: () => ipcRenderer.invoke("agentControl:openDataFolder"),
  },
  updates: {
    getState: () => ipcRenderer.invoke("updates:getState"),
    check: (options = {}) => ipcRenderer.invoke("updates:check", options),
    download: () => ipcRenderer.invoke("updates:download"),
    install: () => ipcRenderer.invoke("updates:install"),
    skip: (version) => ipcRenderer.invoke("updates:skip", { version }),
    openDownloaded: () => ipcRenderer.invoke("updates:open-downloaded"),
    openDownload: () => ipcRenderer.invoke("updates:open-download"),
    openRelease: () => ipcRenderer.invoke("updates:open-release"),
    onStatus: (callback) => {
      const handler = (_, payload) => callback(payload);
      ipcRenderer.on("updates:status", handler);
      return () => ipcRenderer.removeListener("updates:status", handler);
    },
  },
  developerUpdates: {
    getState: () => ipcRenderer.invoke("developerUpdates:getState"),
    check: (options = {}) => ipcRenderer.invoke("developerUpdates:check", options),
    update: () => ipcRenderer.invoke("developerUpdates:update"),
    restart: () => ipcRenderer.invoke("developerUpdates:restart"),
    openChanges: () => ipcRenderer.invoke("developerUpdates:openChanges"),
  },
  maintenance: {
    scan: () => ipcRenderer.invoke("maintenance:scan"),
    clear: (categoryIds = []) => ipcRenderer.invoke("maintenance:clear", { categoryIds }),
  },
  account: {
    getStatus: () => invokeAccount("account:getStatus"),
    restore: () => invokeAccount("account:restore"),
    startDeviceLogin: () => invokeAccount("account:startDeviceLogin"),
    loginWithPassword: (payload = {}) => invokeAccount("account:loginWithPassword", payload),
    checkDeviceLogin: () => invokeAccount("account:checkDeviceLogin"),
    cancelDeviceLogin: () => invokeAccount("account:cancelDeviceLogin"),
    refresh: () => invokeAccount("account:refresh"),
    openPage: () => invokeAccount("account:openPage"),
    listDevices: () => invokeAccount("account:listDevices"),
    revokeCurrentDevice: () => invokeAccount("account:revokeCurrentDevice"),
    logout: () => invokeAccount("account:logout"),
  },
  window: windowApi,
  system: {
    getSnapshot: (payload = {}) => invokeAgentFeature("system:getSnapshot", payload),
  },
  amp: {
    getSnapshot: (payload = {}) => invokeAgentFeature("amp:getSnapshot", payload),
  },
  playit: {
    getSnapshot: (payload = {}) => ipcRenderer.invoke("playit:getSnapshot", payload),
  },
  publicAccess: {
    getSnapshot: (payload = {}) => ipcRenderer.invoke("publicAccess:getSnapshot", payload),
    listServices: (payload = {}) => ipcRenderer.invoke("publicAccess:listServices", payload),
    getPlayitStatus: (payload = {}) => ipcRenderer.invoke("publicAccess:getPlayitStatus", payload),
    getPlayitLogs: (payload = {}) => ipcRenderer.invoke("publicAccess:getPlayitLogs", payload),
    listPlayitTunnels: (payload = {}) => ipcRenderer.invoke("publicAccess:listPlayitTunnels", payload),
    controlPlayit: (payload = {}) => ipcRenderer.invoke("publicAccess:controlPlayit", payload),
    createService: (payload = {}) => ipcRenderer.invoke("publicAccess:createService", payload),
    deleteService: (payload = {}) => ipcRenderer.invoke("publicAccess:deleteService", payload),
    createFirewallRule: (payload = {}) => ipcRenderer.invoke("publicAccess:createFirewallRule", payload),
  },
  docker: {
    getSnapshot: (payload = {}) => invokeAgentFeature("docker:getSnapshot", payload),
    listContainers: (payload = {}) => invokeAgentFeature("docker:listContainers", payload),
    inspectContainer: (container, payload = {}) => ipcRenderer.invoke("docker:inspectContainer", { ...payload, container }),
    create: (payload = {}) => ipcRenderer.invoke("docker:create", payload),
    start: (container, payload = {}) => ipcRenderer.invoke("docker:start", { ...payload, container }),
    startContainer: (container, payload = {}) => ipcRenderer.invoke("docker:start", { ...payload, container }),
    stop: (container, payload = {}) => ipcRenderer.invoke("docker:stop", { ...payload, container }),
    stopContainer: (container, payload = {}) => ipcRenderer.invoke("docker:stop", { ...payload, container }),
    restart: (container, payload = {}) => ipcRenderer.invoke("docker:restart", { ...payload, container }),
    restartContainer: (container, payload = {}) => ipcRenderer.invoke("docker:restart", { ...payload, container }),
    pause: (container, payload = {}) => ipcRenderer.invoke("docker:pause", { ...payload, container }),
    unpause: (container, payload = {}) => ipcRenderer.invoke("docker:unpause", { ...payload, container }),
    kill: (container, payload = {}) => ipcRenderer.invoke("docker:kill", { ...payload, container }),
    rename: (container, name, payload = {}) => ipcRenderer.invoke("docker:rename", { ...payload, container, name }),
    delete: (container, payload = {}) => ipcRenderer.invoke("docker:delete", { ...payload, container }),
    removeContainer: (container, payload = {}) => ipcRenderer.invoke("docker:removeContainer", { ...payload, container }),
    listImages: (payload = {}) => invokeAgentFeature("docker:listImages", payload),
    removeImage: (image, payload = {}) => ipcRenderer.invoke("docker:removeImage", { ...payload, image }),
    pullImage: (image, payload = {}) => ipcRenderer.invoke("docker:pullImage", { ...payload, image }),
    inspectImage: (image, payload = {}) => ipcRenderer.invoke("docker:inspectImage", { ...payload, image }),
    pruneImages: (payload = {}) => ipcRenderer.invoke("docker:pruneImages", payload),
    listNetworks: (payload = {}) => invokeAgentFeature("docker:listNetworks", payload),
    inspectNetwork: (network, payload = {}) => ipcRenderer.invoke("docker:inspectNetwork", { ...payload, network }),
    createNetwork: (payload = {}) => ipcRenderer.invoke("docker:createNetwork", payload),
    removeNetwork: (network, payload = {}) => ipcRenderer.invoke("docker:removeNetwork", { ...payload, network }),
    connectNetwork: (network, container, payload = {}) => ipcRenderer.invoke("docker:connectNetwork", { ...payload, network, container }),
    disconnectNetwork: (network, container, payload = {}) => ipcRenderer.invoke("docker:disconnectNetwork", { ...payload, network, container }),
    pruneNetworks: (payload = {}) => ipcRenderer.invoke("docker:pruneNetworks", payload),
    listVolumes: (payload = {}) => invokeAgentFeature("docker:listVolumes", payload),
    inspectVolume: (volume, payload = {}) => ipcRenderer.invoke("docker:inspectVolume", { ...payload, volume }),
    removeVolume: (volume, payload = {}) => ipcRenderer.invoke("docker:removeVolume", { ...payload, volume }),
    pruneVolumes: (payload = {}) => ipcRenderer.invoke("docker:pruneVolumes", payload),
    getLogs: (container, payload = {}) => ipcRenderer.invoke("docker:getLogs", { ...payload, container }),
    getStats: (container, payload = {}) => ipcRenderer.invoke("docker:getStats", { ...payload, container }),
    exec: (container, payload = {}) => ipcRenderer.invoke("docker:exec", { ...payload, container }),
    listComposeProjects: (payload = {}) => ipcRenderer.invoke("docker:listComposeProjects", payload),
    compose: (action, payload = {}) => ipcRenderer.invoke("docker:compose", { ...payload, action }),
    getCleanupPreview: (payload = {}) => ipcRenderer.invoke("docker:getCleanupPreview", payload),
    cleanup: (kind, payload = {}) => ipcRenderer.invoke("docker:cleanup", { ...payload, kind }),
  },
  marketplace: {
    listTemplates: () => invokeMarketplace("marketplace:listTemplates"),
    getMinecraftVersions: (templateId) => invokeMarketplace("marketplace:getMinecraftVersions", { templateId }),
    searchProviderPacks: (payload = {}) => invokeMarketplace("marketplace:searchProviderPacks", payload),
    getProviderPackVersions: (payload = {}) => invokeMarketplace("marketplace:getProviderPackVersions", payload),
    getProviderPackDetails: (payload = {}) => invokeMarketplace("marketplace:getProviderPackDetails", payload),
    getImportSupport: () => invokeMarketplace("marketplace:getImportSupport"),
    importCommunityTemplate: (payload = {}) => invokeMarketplace("marketplace:importCommunityTemplate", payload),
    installTemplate: (payload) => invokeMarketplace("marketplace:installTemplate", payload),
    installPack: (payload) => invokeMarketplace("marketplace:installPack", payload),
    updateSteamServer: (payload) => invokeMarketplace("marketplace:updateSteamServer", payload),
    openManualDownloadPage: (sessionId, payload = {}) => invokeMarketplace("marketplace:openManualDownloadPage", { ...payload, sessionId }),
    importManualDownloadFile: (sessionId, payload = {}) => invokeMarketplace("marketplace:importManualDownloadFile", { ...payload, sessionId }),
    resumeManualInstall: (sessionId, payload = {}) => invokeMarketplace("marketplace:resumeManualInstall", { ...payload, sessionId }),
    onInstallProgress: (callback) => {
      const handler = (_, payload) => callback(payload);
      ipcRenderer.on("marketplace:install-progress", handler);
      return () => ipcRenderer.removeListener("marketplace:install-progress", handler);
    },
    getDownloads: (payload = {}) => invokeMarketplace("marketplace:getDownloads", payload),
    cancelDownload: (downloadId, payload = {}) => invokeMarketplace("marketplace:cancelDownload", { ...payload, downloadId }),
    retryDownload: (downloadId, payload = {}) => invokeMarketplace("marketplace:retryDownload", { ...payload, downloadId }),
  },
  dependencies: {
    getCatalog: (payload = {}) => ipcRenderer.invoke("dependencies:getCatalog", payload),
    check: (payload = {}) => ipcRenderer.invoke("dependencies:check", payload),
    plan: (payload = {}) => ipcRenderer.invoke("dependencies:plan", payload),
    install: (payload = {}) => ipcRenderer.invoke("dependencies:install", payload),
  },
  instances: {
    list: (payload = {}) => invokeAgentFeature("instances:list", payload),
    create: (payload) => ipcRenderer.invoke("instances:create", payload),
    update: (instanceId, config, options = {}) => ipcRenderer.invoke("instances:update", { ...options, instanceId, config }),
    rename: (instanceId, displayName, options = {}) => ipcRenderer.invoke("instances:rename", { ...options, instanceId, displayName }),
    duplicate: (instanceId, config = {}, options = {}) => ipcRenderer.invoke("instances:duplicate", { ...options, instanceId, config }),
    openFolder: (instanceId, options = {}) => ipcRenderer.invoke("instances:openFolder", { ...options, instanceId }),
    getStatus: (instanceId, options = {}) => invokeAgentFeature("instances:getStatus", { ...options, instanceId }),
    getMetrics: (instanceId, options = {}) => invokeAgentFeature("instances:getMetrics", { ...options, instanceId }),
    getLogs: (instanceId, options = {}) => invokeAgentFeature("instances:getLogs", { instanceId, ...options }),
    clearLogs: (instanceId, options = {}) => ipcRenderer.invoke("instances:clearLogs", { instanceId, ...options }),
    sendCommand: (instanceId, command, options = {}) => ipcRenderer.invoke("instances:sendCommand", { ...options, instanceId, command }),
    start: (instanceId, payload = {}) => ipcRenderer.invoke("instances:start", { ...payload, instanceId }),
    stop: (instanceId, payload = {}) => ipcRenderer.invoke("instances:stop", { ...payload, instanceId }),
    restart: (instanceId, payload = {}) => ipcRenderer.invoke("instances:restart", { ...payload, instanceId }),
    repairNeoForgeRuntime: (instanceId, payload = {}) => ipcRenderer.invoke("instances:repairNeoForgeRuntime", { ...payload, instanceId }),
    forceKill: (instanceId, payload = {}) => ipcRenderer.invoke("instances:forceKill", { ...payload, instanceId }),
    delete: (instanceId, payload = {}) => ipcRenderer.invoke("instances:delete", { ...payload, instanceId }),
    forget: (instanceId, payload = {}) => ipcRenderer.invoke("instances:forget", { ...payload, instanceId }),
    listFiles: (instanceId, path = ".", options = {}) => ipcRenderer.invoke("instances:listFiles", { ...options, instanceId, path }),
    readFile: (instanceId, path, options = {}) => ipcRenderer.invoke("instances:readFile", { ...options, instanceId, path }),
    writeFile: (instanceId, path, content, options = {}) => ipcRenderer.invoke("instances:writeFile", { instanceId, path, content, ...options }),
    deleteFile: (instanceId, path, options = {}) => ipcRenderer.invoke("instances:deleteFile", { ...options, instanceId, path }),
    createFolder: (instanceId, path, options = {}) => ipcRenderer.invoke("instances:createFolder", { ...options, instanceId, path }),
    renameFile: (instanceId, oldPath, newPath, options = {}) => ipcRenderer.invoke("instances:renameFile", { ...options, instanceId, oldPath, newPath }),
    getGameServerConfig: (instanceId, options = {}) => ipcRenderer.invoke("instances:getGameServerConfig", { ...options, instanceId }),
    saveGameServerConfig: (instanceId, payload = {}, options = {}) => ipcRenderer.invoke("instances:saveGameServerConfig", { ...options, ...payload, instanceId }),
    getMinecraftProperties: (instanceId, options = {}) => ipcRenderer.invoke("instances:getMinecraftProperties", { ...options, instanceId }),
    saveMinecraftProperties: (instanceId, properties, options = {}) => ipcRenderer.invoke("instances:saveMinecraftProperties", { ...options, instanceId, properties }),
    getFiveMReadiness: (instanceId, options = {}) => ipcRenderer.invoke("instances:getFiveMReadiness", { ...options, instanceId }),
    saveFiveMLicenseKey: (instanceId, licenseKey, options = {}) => ipcRenderer.invoke("instances:saveFiveMLicenseKey", { ...options, instanceId, licenseKey }),
  },
  actions: {
    executeAction: (actionId, params = {}, options = {}) => ipcRenderer.invoke("action:execute", { actionId, params, ...options }),
  },
  backups: {
    list: (payload = {}) => invokeAgentFeature("backups:list", payload),
    create: (payload = {}) => ipcRenderer.invoke("backups:create", payload),
    restore: (payload = {}) => ipcRenderer.invoke("backups:restore", payload),
    delete: (backupId, payload = {}) => ipcRenderer.invoke("backups:delete", { ...payload, backupId }),
    download: (backupId, payload = {}) => ipcRenderer.invoke("backups:download", { ...payload, backupId }),
    import: (payload = {}) => ipcRenderer.invoke("backups:import", payload),
    listSchedules: (payload = {}) => invokeAgentFeature("backups:listSchedules", payload),
    saveSchedule: (payload = {}) => ipcRenderer.invoke("backups:saveSchedule", payload),
    deleteSchedule: (instanceId, payload = {}) => ipcRenderer.invoke("backups:deleteSchedule", { ...payload, instanceId }),
  },
  nodes: {
    list: () => ipcRenderer.invoke("nodes:list"),
    restore: () => ipcRenderer.invoke("nodes:restore"),
    save: (payload = {}) => ipcRenderer.invoke("nodes:save", payload),
    pair: (payload = {}) => ipcRenderer.invoke("nodes:pair", payload),
    delete: (nodeId) => ipcRenderer.invoke("nodes:delete", { nodeId }),
    select: (nodeId) => ipcRenderer.invoke("nodes:select", { nodeId }),
    test: (nodeId) => ipcRenderer.invoke("nodes:test", { nodeId }),
    testConnection: (payload = {}) => ipcRenderer.invoke("nodes:testConnection", payload),
    health: (nodeId) => ipcRenderer.invoke("nodes:health", { nodeId }),
    healthAll: () => ipcRenderer.invoke("nodes:healthAll"),
    credentialStatus: (nodeId) => ipcRenderer.invoke("nodes:credentialStatus", { nodeId }),
    repairCredential: (payload = {}) => ipcRenderer.invoke("nodes:repairCredential", payload),
    generateToken: () => ipcRenderer.invoke("nodes:generateToken"),
  },
  files: {
    listConnections: () => ipcRenderer.invoke("files:listConnections"),
    saveConnection: (payload = {}) => ipcRenderer.invoke("files:saveConnection", payload),
    deleteConnection: (storageId) => ipcRenderer.invoke("files:deleteConnection", { storageId }),
    setDefaultConnection: (storageId) => ipcRenderer.invoke("files:setDefaultConnection", { storageId }),
    testConnection: (payload = {}) => ipcRenderer.invoke("files:testConnection", payload),
    identity: (payload = {}) => ipcRenderer.invoke("files:identity", payload),
    list: (payload) => ipcRenderer.invoke("files:list", payload),
    disconnect: (profileId, storageId = null) => ipcRenderer.invoke("files:disconnect", { profileId, storageId }),
    cancelTransfer: (transferId) => ipcRenderer.invoke("files:cancelTransfer", { transferId }),
    readText: (payload) => ipcRenderer.invoke("files:readText", payload),
    writeText: (payload) => ipcRenderer.invoke("files:writeText", payload),
    mkdir: (payload) => ipcRenderer.invoke("files:mkdir", payload),
    rename: (payload) => ipcRenderer.invoke("files:rename", payload),
    copy: (payload) => ipcRenderer.invoke("files:copy", payload),
    newFile: (payload) => ipcRenderer.invoke("files:newFile", payload),
    delete: (payload) => ipcRenderer.invoke("files:delete", payload),
    upload: (payload) => ipcRenderer.invoke("files:upload", payload),
    download: (payload) => ipcRenderer.invoke("files:download", payload),
    onTransfer: (callback) => {
      const handler = (_, payload) => callback(payload);
      ipcRenderer.on("files:transfer", handler);
      return () => ipcRenderer.removeListener("files:transfer", handler);
    },
  },
  storageWindow: {
    open: (payload = {}) => ipcRenderer.invoke("storageWindow:open", payload),
    close: () => ipcRenderer.invoke("storageWindow:close"),
    saved: (payload = {}) => ipcRenderer.invoke("storageWindow:saved", payload),
    onInit: (callback) => {
      const handler = (_, payload) => callback(payload || {});
      ipcRenderer.on("storageWindow:init", handler);
      return () => ipcRenderer.removeListener("storageWindow:init", handler);
    },
    onSaved: (callback) => {
      const handler = (_, payload) => callback(payload || {});
      ipcRenderer.on("files:storageConnectionSaved", handler);
      return () => ipcRenderer.removeListener("files:storageConnectionSaved", handler);
    },
  },
  ssh: {
    listProfiles: () => ipcRenderer.invoke("ssh:listProfiles"),
    saveProfile: (payload) => ipcRenderer.invoke("ssh:saveProfile", payload),
    assignProfileToNode: (payload) => ipcRenderer.invoke("ssh:assignProfileToNode", payload),
    connect: (payload) => ipcRenderer.invoke("ssh:connect", payload),
    disconnect: (sessionId) => ipcRenderer.invoke("ssh:disconnect", { sessionId }),
    write: (sessionId, input) => {
      recordSshBridgeWrite(sessionId, input);
      return ipcRenderer.invoke("ssh:write", { sessionId, input });
    },
    resize: (sessionId, size = {}) => ipcRenderer.invoke("ssh:resize", { sessionId, ...size }),
    onData: (callback) => {
      const handler = (_, payload) => callback(payload);
      ipcRenderer.on("ssh:data", handler);
      return () => ipcRenderer.removeListener("ssh:data", handler);
    },
    onStatus: (callback) => {
      const handler = (_, payload) => callback(payload);
      ipcRenderer.on("ssh:status", handler);
      return () => ipcRenderer.removeListener("ssh:status", handler);
    },
  },
  settings: {
    getPermissions: () => ipcRenderer.invoke("settings:getPermissions"),
    getPreferences: () => ipcRenderer.invoke("settings:getPreferences"),
    savePreferences: (settings = {}) => ipcRenderer.invoke("settings:savePreferences", { settings }),
    resetPreferences: (category = null) => ipcRenderer.invoke("settings:resetPreferences", { category }),
    getAgentConfig: () => ipcRenderer.invoke("settings:getAgentConfig"),
    saveAgentConfig: (settings) => ipcRenderer.invoke("settings:saveAgentConfig", settings),
    testAgentConnection: (settings) => ipcRenderer.invoke("settings:testAgentConnection", settings),
    pairAgent: (payload = {}) => ipcRenderer.invoke("settings:pairAgent", payload),
    getMarketplaceConfig: () => ipcRenderer.invoke("settings:getMarketplaceConfig"),
    saveMarketplaceConfig: (settings) => ipcRenderer.invoke("settings:saveMarketplaceConfig", settings),
    testCurseForgeConnection: () => ipcRenderer.invoke("settings:testCurseForgeConnection"),
  },
  security: {
    getStatus: () => ipcRenderer.invoke("security:getStatus"),
    getDashboard: (payload = {}) => ipcRenderer.invoke("security:getDashboard", payload),
    setupAdmin: (payload) => ipcRenderer.invoke("security:setupAdmin", payload),
    login: (payload) => ipcRenderer.invoke("security:login", payload),
    logout: () => ipcRenderer.invoke("security:logout"),
    logoutAllSessions: () => ipcRenderer.invoke("security:logoutAllSessions"),
    rotateAgentToken: () => ipcRenderer.invoke("security:rotateAgentToken"),
    revokeSession: (sessionId) => ipcRenderer.invoke("security:revokeSession", { sessionId }),
    revokeOtherSessions: () => ipcRenderer.invoke("security:revokeOtherSessions"),
    removeTrustedDevice: (deviceId) => ipcRenderer.invoke("security:removeTrustedDevice", { deviceId }),
    renameTrustedDevice: (deviceId, name) => ipcRenderer.invoke("security:renameTrustedDevice", { deviceId, name }),
    updateSessionSettings: (payload = {}) => ipcRenderer.invoke("security:updateSessionSettings", payload),
    updateRemoteAccess: (payload = {}) => ipcRenderer.invoke("security:updateRemoteAccess", payload),
    disableRemoteAccess: () => ipcRenderer.invoke("security:disableRemoteAccess"),
    revokeAgentToken: () => ipcRenderer.invoke("security:revokeAgentToken"),
    generateReplacementAgentToken: () => ipcRenderer.invoke("security:generateReplacementAgentToken"),
    lockOwnerWorkspace: () => ipcRenderer.invoke("security:lockOwnerWorkspace"),
    emergencyAction: (payload = {}) => ipcRenderer.invoke("security:emergencyAction", payload),
    openAuditFolder: () => ipcRenderer.invoke("security:openAuditFolder"),
  },
  ownerWorkspace: {
    getStatus: () => ipcRenderer.invoke("ownerWorkspace:getStatus"),
    getWorkspace: () => ipcRenderer.invoke("ownerWorkspace:getWorkspace"),
    createPage: (payload = {}) => ipcRenderer.invoke("ownerWorkspace:createPage", payload),
    updatePage: (payload = {}) => ipcRenderer.invoke("ownerWorkspace:updatePage", payload),
    duplicatePage: (payload = {}) => ipcRenderer.invoke("ownerWorkspace:duplicatePage", payload),
    deletePage: (payload = {}) => ipcRenderer.invoke("ownerWorkspace:deletePage", payload),
    reorderPages: (payload = {}) => ipcRenderer.invoke("ownerWorkspace:reorderPages", payload),
    selectPage: (payload = {}) => ipcRenderer.invoke("ownerWorkspace:selectPage", payload),
    saveContent: (payload = {}) => ipcRenderer.invoke("ownerWorkspace:saveContent", payload),
    getAnalytics: () => ipcRenderer.invoke("ownerWorkspace:getAnalytics"),
    getFlags: () => ipcRenderer.invoke("ownerWorkspace:getFlags"),
    setFlag: (payload = {}) => ipcRenderer.invoke("ownerWorkspace:setFlag", payload),
    runApiRequest: (payload = {}) => ipcRenderer.invoke("ownerWorkspace:runApiRequest", payload),
    clearApiHistory: () => ipcRenderer.invoke("ownerWorkspace:clearApiHistory"),
    getCommands: () => ipcRenderer.invoke("ownerWorkspace:getCommands"),
    runCommand: (payload = {}) => ipcRenderer.invoke("ownerWorkspace:runCommand", payload),
    readLogs: () => ipcRenderer.invoke("ownerWorkspace:readLogs"),
  },
};

contextBridge.exposeInMainWorld("anxWindow", windowApi);
contextBridge.exposeInMainWorld("anx", desktopApi);
contextBridge.exposeInMainWorld("anxhub", desktopApi);
contextBridge.exposeInMainWorld("anxos", desktopApi);
contextBridge.exposeInMainWorld("electronAPI", desktopApi);
