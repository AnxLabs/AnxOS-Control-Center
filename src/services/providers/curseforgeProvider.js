const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const crypto = require("crypto");
const agentClient = require("../agentClient");
const {
  MARKETPLACE_CONFIG_RECOVERY_MESSAGE,
  getMarketplaceConfigPath,
  readMarketplaceConfig,
  readMarketplaceConfigSafe,
  saveMarketplaceConfig,
} = require("../providerConfigService");
const { classifyServerCompatibility } = require("../../shared/marketplaceServerCompatibility");

const CURSEFORGE_API = "https://api.curseforge.com/v1";
const MINECRAFT_GAME_ID = 432;
const MODPACK_CLASS_ID = 4471;
const REQUIRED_DEPENDENCY = 3;
const OPTIONAL_DEPENDENCY = 2;
const modMetadataCache = new Map();
const USER_AGENT = "AnxOS-Control-Center/1.0 (+https://anxos.local)";
const DEFAULT_TIMEOUT_MS = 30000;
const CURSEFORGE_DOWNLOAD_HOSTS = new Set([
  "edge.forgecdn.net",
  "mediafilez.forgecdn.net",
  "media.forgecdn.net",
]);

const API_KEY_FIELDS = ["apiKey", "curseForgeApiKey", "curseforgeApiKey", "cfApiKey"];
const API_KEY_ENV = ["CURSEFORGE_API_KEY", "CF_API_KEY", "ANXHUB_CURSEFORGE_API_KEY"];
const API_KEY_FILE_FIELDS = ["apiKeyFile", "curseForgeApiKeyFile", "curseforgeApiKeyFile", "cfApiKeyFile"];
const API_KEY_FILE_ENV = ["CURSEFORGE_API_KEY_FILE", "CF_API_KEY_FILE", "ANXHUB_CURSEFORGE_API_KEY_FILE"];
const PROXY_URL_FIELDS = ["proxyUrl", "curseForgeProxyUrl", "curseforgeProxyUrl", "cfProxyUrl"];
const PROXY_URL_ENV = ["ANXOS_CURSEFORGE_PROXY_URL", "ANXHUB_CURSEFORGE_PROXY_URL", "CURSEFORGE_PROXY_URL"];
let envLoaded = false;
let envLoadInfo = null;
let startupStatusLogged = false;
let legacyApiKeyMigrationAttempted = false;

class CurseForgeProviderError extends Error {
  constructor(message, code = "CURSEFORGE_ERROR", details = {}) {
    super(message);
    this.name = "CurseForgeProviderError";
    this.code = code;
    this.details = details;
  }
}

function serializeError(error, context = {}) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  return {
    ...context,
    name: error?.name || null,
    code: error?.code || null,
    message: error?.message || null,
    stack: error?.stack || null,
    status: details.status || error?.status || error?.statusCode || null,
    responseBody: details.body || details.responseBody || null,
    url: details.url || context.url || null,
    invalidUrl: details.invalidUrl || null,
    details,
  };
}

function truncateForLog(value, maxLength = 4000) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function friendlyHttpMessage(label, status, body = "") {
  const detail = (() => {
    try {
      const parsed = JSON.parse(body);
      return parsed.message || parsed.error || parsed.detail || "";
    } catch {
      return String(body || "").trim().slice(0, 240);
    }
  })();
  const prefix = `CurseForge ${label}`;
  if (status === 401) return `${prefix}: 401 Invalid API key${detail ? ` - ${detail}` : ""}.`;
  if (status === 403) return `${prefix}: 403 Forbidden. Your API key may not have access${detail ? ` - ${detail}` : ""}.`;
  if (status === 404) return `${prefix}: 404 Project not found${detail ? ` - ${detail}` : ""}.`;
  if (status === 429) return `${prefix}: 429 Rate limited. Try again later${detail ? ` - ${detail}` : ""}.`;
  return `${prefix}: HTTP ${status}${detail ? ` - ${detail}` : ""}`;
}

function logProviderFailure(error, context = {}) {
  console.error("[Marketplace][CurseForge] Provider request failed.", serializeError(error, context));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isTransientError(error) {
  const status = error?.details?.status || error?.status || error?.statusCode;
  const code = error?.code || "";
  const name = error?.name || "";
  return isTransientStatus(status) ||
    ["CURSEFORGE_NETWORK_FAILED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code) ||
    ["AbortError", "TimeoutError"].includes(name);
}

async function withRetry(operation, context = {}) {
  const attempts = Math.max(1, Number(context.attempts) || 3);
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isTransientError(error)) {
        throw error;
      }
      logProviderFailure(error, {
        label: context.label || null,
        url: context.url || null,
        attempt,
        nextAttempt: attempt + 1,
      });
      await delay((Number(context.delayMs) || 500) * attempt);
    }
  }
  throw lastError;
}

async function fetchWithTimeout(url, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const signal = options.signal && typeof AbortSignal?.any === "function"
      ? AbortSignal.any([options.signal, controller.signal])
      : options.signal || controller.signal;
    const { timeoutMs: _timeoutMs, signal: _signal, ...fetchOptions } = options;
    return await fetch(url, {
      ...fetchOptions,
      signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function trimValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

function getElectronApp() {
  try {
    const electron = require("electron");
    return electron && typeof electron === "object" ? electron.app || null : null;
  } catch {
    return null;
  }
}

function getElectronRuntimeInfo() {
  const app = getElectronApp();

  if (!app) {
    return {
      isElectron: false,
      isPackaged: false,
      appPath: null,
      userDataPath: null,
      configPath: null,
    };
  }

  let appPath = null;
  let userDataPath = null;

  try {
    appPath = typeof app.getAppPath === "function" ? app.getAppPath() : null;
  } catch {}

  try {
    userDataPath = app.getPath("userData");
  } catch {}

  return {
    isElectron: true,
    isPackaged: Boolean(app.isPackaged),
    appPath,
    userDataPath,
    configPath: userDataPath ? path.join(userDataPath, "config") : null,
  };
}

function getElectronConfigDirectory() {
  return getElectronRuntimeInfo().configPath;
}

function getElectronUserDataDirectory() {
  return getElectronRuntimeInfo().userDataPath;
}

function getRepoEnvPath() {
  return path.join(__dirname, "..", "..", "..", ".env");
}

function getEnvCandidates() {
  const electronConfigDirectory = getElectronConfigDirectory();
  const electronUserDataDirectory = getElectronUserDataDirectory();

  return uniquePaths([
    process.env.ANXHUB_ENV_PATH,
    electronConfigDirectory ? path.join(electronConfigDirectory, ".env") : null,
    electronUserDataDirectory ? path.join(electronUserDataDirectory, ".env") : null,
    getRepoEnvPath(),
    path.join(process.cwd(), ".env"),
    path.join(process.cwd(), "agent", ".env"),
    process.execPath ? path.join(path.dirname(process.execPath), ".env") : null,
    process.resourcesPath ? path.join(process.resourcesPath, ".env") : null,
    process.resourcesPath ? path.join(process.resourcesPath, "app", ".env") : null,
  ]);
}

function findEnvPath() {
  return getEnvCandidates().find((candidate) => {
    try {
      return fs.existsSync(candidate);
    } catch {
      return false;
    }
  }) || null;
}

function loadEnv() {
  if (envLoaded) {
    return envLoadInfo;
  }
  envLoaded = true;
  const envSourcesChecked = getEnvCandidates();
  const resolvedEnvPath = findEnvPath();
  const runtime = getElectronRuntimeInfo();

  envLoadInfo = {
    cwd: process.cwd(),
    isPackaged: runtime.isPackaged,
    appPath: runtime.appPath,
    userDataPath: runtime.userDataPath,
    envSourcesChecked,
    resolvedEnvPath,
    envFileExists: Boolean(resolvedEnvPath),
    envLoaded: false,
    envLoadErrorCode: null,
  };

  if (!resolvedEnvPath) {
    return envLoadInfo;
  }

  try {
    const result = dotenv.config({ path: resolvedEnvPath, quiet: true });
    envLoadInfo.envLoaded = !result.error;
    envLoadInfo.envLoadErrorCode = result.error?.code || result.error?.name || null;
  } catch (error) {
    envLoadInfo.envLoadErrorCode = error?.code || error?.name || "ENV_LOAD_FAILED";
  }

  return envLoadInfo;
}

function readEnvFileValues(filePath) {
  if (!filePath) {
    return {};
  }

  try {
    return dotenv.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return {};
  }
}

function cleanSecretValue(value) {
  const text = String(value || "").trim();
  if (
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith('"') && text.endsWith('"'))
  ) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function firstSecretValue(config = {}, fields = [], envNames = []) {
  for (const field of fields) {
    const value = cleanSecretValue(config[field]);
    if (value) {
      return value;
    }
  }
  for (const envName of envNames) {
    const value = cleanSecretValue(process.env[envName]);
    if (value) {
      return value;
    }
  }
  return "";
}

function firstConfigValue(config = {}, fields = [], envNames = []) {
  for (const field of fields) {
    const value = trimValue(config[field]);
    if (value) return value;
  }
  for (const envName of envNames) {
    const value = trimValue(process.env[envName]);
    if (value) return value;
  }
  return "";
}

function readSecretFile(filePath) {
  const cleanPath = cleanSecretValue(filePath);
  if (!cleanPath) {
    return "";
  }
  try {
    return cleanSecretValue(fs.readFileSync(cleanPath, "utf8"));
  } catch (error) {
    throw new CurseForgeProviderError(
      `CurseForge API key file could not be read: ${cleanPath}`,
      "CURSEFORGE_API_KEY_FILE_UNREADABLE",
      { path: cleanPath, message: error.message }
    );
  }
}

function getLegacyApiKeyCandidate() {
  if (process.env.ANXHUB_DISABLE_CURSEFORGE_ENV_FALLBACK === "1") {
    return { key: "", source: null };
  }

  const envFileValues = readEnvFileValues(envLoadInfo?.resolvedEnvPath);
  for (const envName of API_KEY_ENV) {
    const value = cleanSecretValue(envFileValues[envName]);
    if (value) {
      return {
        key: value,
        source: envName,
      };
    }
  }
  for (const envName of API_KEY_FILE_ENV) {
    const value = cleanSecretValue(envFileValues[envName]);
    if (value) {
      return {
        key: readSecretFile(value),
        source: envName,
      };
    }
  }

  const direct = firstSecretValue({}, [], API_KEY_ENV);
  if (direct) {
    return {
      key: direct,
      source: API_KEY_ENV.find((envName) => cleanSecretValue(process.env[envName])) || "env",
    };
  }

  const fileEnvName = API_KEY_FILE_ENV.find((envName) => cleanSecretValue(process.env[envName]));
  if (fileEnvName) {
    return {
      key: readSecretFile(process.env[fileEnvName]),
      source: fileEnvName,
    };
  }

  return { key: "", source: null };
}

function migrateLegacyApiKeyToConfig() {
  if (process.env.ANXHUB_DISABLE_CURSEFORGE_KEY_MIGRATION === "1") {
    return null;
  }

  if (legacyApiKeyMigrationAttempted) {
    return null;
  }

  legacyApiKeyMigrationAttempted = true;
  const stored = readMarketplaceConfig({ includeSecrets: true });
  if (firstSecretValue(stored, API_KEY_FIELDS, [])) {
    return null;
  }

  let legacy = { key: "", source: null };
  try {
    legacy = getLegacyApiKeyCandidate();
  } catch (error) {
    console.warn("[Marketplace][CurseForge] Legacy API key migration skipped.", serializeError(error));
    return null;
  }

  if (!legacy.key) {
    return null;
  }

  try {
    saveMarketplaceConfig({ curseForgeApiKey: legacy.key });
    console.info("[Marketplace][CurseForge] Migrated legacy API key to app config.", {
      source: legacy.source ? `legacy-env:${legacy.source}` : "legacy-env",
      marketplaceConfigPath: getMarketplaceConfigPath(),
    });
    return {
      migrated: true,
      source: legacy.source,
    };
  } catch (error) {
    console.warn("[Marketplace][CurseForge] Legacy API key migration failed.", serializeError(error, {
      source: legacy.source ? `legacy-env:${legacy.source}` : "legacy-env",
      marketplaceConfigPath: getMarketplaceConfigPath(),
    }));
    return null;
  }
}

function readStoredApiKeyWithMigration(options = {}) {
  const safeResult = readMarketplaceConfigSafe({ includeSecrets: true });
  const stored = safeResult.config;
  if (safeResult.recovery.degraded) {
    return {
      key: "",
      migrated: false,
      degraded: true,
      errorCode: safeResult.recovery.errorCode,
    };
  }
  const storedDirect = firstSecretValue(stored, API_KEY_FIELDS, []);
  if (storedDirect) {
    return {
      key: storedDirect,
      migrated: false,
    };
  }

  if (options.migrate === false) {
    return {
      key: "",
      migrated: false,
    };
  }

  const migration = migrateLegacyApiKeyToConfig();
  if (migration?.migrated) {
    const migratedStored = readMarketplaceConfig({ includeSecrets: true });
    const migratedDirect = firstSecretValue(migratedStored, API_KEY_FIELDS, []);
    if (migratedDirect) {
      return {
        key: migratedDirect,
        migrated: true,
        migrationSource: migration.source,
      };
    }
  }

  return {
    key: "",
    migrated: false,
  };
}

function getCurseForgeApiKey(config = {}) {
  loadEnv();
  const stored = readStoredApiKeyWithMigration({ migrate: false });
  if (stored.key) {
    return stored.key;
  }

  const directConfig = firstSecretValue(config, API_KEY_FIELDS, []);
  if (directConfig) {
    return directConfig;
  }

  const migratedStored = readStoredApiKeyWithMigration();
  if (migratedStored.key) {
    return migratedStored.key;
  }

  const legacy = getLegacyApiKeyCandidate();
  if (legacy.key) {
    return legacy.key;
  }

  const secretFile = firstSecretValue(config, API_KEY_FILE_FIELDS, []);
  return readSecretFile(secretFile);
}

function getApiKeyStatus(config = {}) {
  const envInfo = loadEnv();
  const directConfigField = API_KEY_FIELDS.find((field) => cleanSecretValue(config[field]));
  const directEnvName = API_KEY_ENV.find((envName) => cleanSecretValue(process.env[envName]));
  const fileConfigField = API_KEY_FILE_FIELDS.find((field) => cleanSecretValue(config[field]));
  const fileEnvName = API_KEY_FILE_ENV.find((envName) => cleanSecretValue(process.env[envName]));
  const envFallbackDisabled = process.env.ANXHUB_DISABLE_CURSEFORGE_ENV_FALLBACK === "1";
  const storedKey = readStoredApiKeyWithMigration({ migrate: false });
  const safeStored = readMarketplaceConfigSafe({ includeSecrets: true });
  const stored = safeStored.config;
  const storedConfigField = storedKey.key
    ? API_KEY_FIELDS.find((field) => cleanSecretValue(stored[field])) || "curseForgeApiKey"
    : null;
  const source = storedConfigField
    ? `app-config:${storedConfigField}`
    : directConfigField
      ? `config:${directConfigField}`
      : directEnvName && !envFallbackDisabled
        ? `legacy-env:${directEnvName}`
        : fileConfigField
          ? `config:${fileConfigField}`
          : fileEnvName && !envFallbackDisabled
            ? `legacy-env:${fileEnvName}`
            : null;
  let loaded = false;
  let errorCode = null;

  try {
    loaded = Boolean(getCurseForgeApiKey(config));
  } catch (error) {
    errorCode = error?.code || error?.name || "CURSEFORGE_API_KEY_STATUS_FAILED";
  }

  return {
    loaded,
    source,
    errorCode,
    env: envInfo,
    hostedProxyConfigured: Boolean(getHostedProxyUrl(config)),
    agentProxyEligible: shouldUseAgentProxy(config),
    fingerprint: getApiKeyFingerprint(config),
    degraded: safeStored.recovery.degraded || storedKey.degraded === true,
    recoveryMessage: safeStored.recovery.message,
  };
}

function getApiKeyFingerprint(config = {}) {
  try {
    const key = getCurseForgeApiKey(config);
    return key ? crypto.createHash("sha256").update(key).digest("hex").slice(0, 12) : null;
  } catch {
    return null;
  }
}

function getConfigurationDiagnostics(config = {}) {
  const status = getApiKeyStatus(config);
  const mode = status.hostedProxyConfigured
    ? "hosted-proxy"
    : status.agentProxyEligible
      ? "agent-proxy"
      : status.loaded
        ? "owner-local"
        : "unavailable";
  return {
    provider: "curseforge",
    mode,
    configured: status.hostedProxyConfigured || status.agentProxyEligible || status.loaded,
    keyConfigured: status.loaded,
    keySource: status.source,
    keyFingerprint: status.fingerprint,
    hostedProxyConfigured: status.hostedProxyConfigured,
    agentProxyEligible: status.agentProxyEligible,
    errorCode: status.errorCode,
    degraded: status.degraded,
    recoveryMessage: status.recoveryMessage,
  };
}

function ensureConfigured(config = {}) {
  const diagnostics = getConfigurationDiagnostics(config);
  if (diagnostics.degraded) {
    throw new CurseForgeProviderError(
      MARKETPLACE_CONFIG_RECOVERY_MESSAGE,
      "CURSEFORGE_PROVIDER_SETTINGS_UNAVAILABLE",
      { provider: "curseforge", degraded: true },
    );
  }
  if (diagnostics.hostedProxyConfigured || diagnostics.agentProxyEligible) {
    return true;
  }
  requireApiKey(config);
  return true;
}

async function testConnection(config = {}) {
  const diagnostics = getConfigurationDiagnostics(config);
  try {
    await getModLoaders({ ...config, timeoutMs: config.timeoutMs || 10000 });
    return {
      ok: true,
      provider: "curseforge",
      diagnostics: {
        ...diagnostics,
        browsing: "passed",
        fileDownloadAuthentication: "not-tested",
      },
    };
  } catch (error) {
    return {
      ok: false,
      provider: "curseforge",
      error: {
        code: error?.code || "CURSEFORGE_TEST_FAILED",
        message: error?.message || "CurseForge connection test failed.",
        status: error?.details?.status || error?.status || null,
      },
      diagnostics: {
        ...diagnostics,
        browsing: "failed",
        fileDownloadAuthentication: "not-tested",
      },
    };
  }
}

function logStartupStatus() {
  if (startupStatusLogged) {
    return getApiKeyStatus();
  }

  startupStatusLogged = true;
  let status;
  try {
    status = getApiKeyStatus();
  } catch (error) {
    status = {
      loaded: false,
      source: null,
      degraded: true,
      errorCode: error?.code || "MARKETPLACE_CONFIG_UNAVAILABLE",
      env: loadEnv(),
    };
  }

  console.info("[Marketplace][CurseForge] API key status.", {
    loaded: status.loaded,
    source: status.source,
    envFileExists: status.env.envFileExists,
    envLoaded: status.env.envLoaded,
    envLoadErrorCode: status.env.envLoadErrorCode,
    apiKeyErrorCode: status.errorCode,
    degraded: status.degraded === true,
    resolvedEnvPath: status.env.resolvedEnvPath,
    cwd: status.env.cwd,
  });

  return status;
}

function requireApiKey(config = {}) {
  const apiKey = getCurseForgeApiKey(config);
  if (!apiKey) {
    const status = getApiKeyStatus(config);
    throw new CurseForgeProviderError(
      "CurseForge API key is required to install CurseForge packs.",
      "CURSEFORGE_API_KEY_REQUIRED",
      {
        provider: "curseforge",
        loaded: status.loaded,
        source: status.source,
        env: status.env,
        envSourcesChecked: status.env.envSourcesChecked,
        cwd: status.env.cwd,
        isPackaged: status.env.isPackaged,
        appPath: status.env.appPath,
        userDataPath: status.env.userDataPath,
        marketplaceConfigPath: getMarketplaceConfigPath(),
        expectedEnvNames: API_KEY_ENV,
        expectedFileEnvNames: API_KEY_FILE_ENV,
        recovery: "Save the CurseForge API key in Settings > Marketplace > CurseForge API Key.",
      }
    );
  }
  return apiKey;
}

function setRuntimeApiKey() {
  envLoaded = false;
  envLoadInfo = null;
  legacyApiKeyMigrationAttempted = false;
}

function normalizeLoader(loader) {
  const value = String(loader || "").trim().toLowerCase();
  const loaderMap = {
    forge: 1,
    fabric: 4,
    quilt: 5,
    neoforge: 6,
  };
  return loaderMap[value] || "";
}

function normalizeModLoaderName(loader) {
  const value = String(loader || "").trim().toLowerCase();
  const loaderMap = {
    "1": "Forge",
    forge: "Forge",
    "4": "Fabric",
    fabric: "Fabric",
    "5": "Quilt",
    quilt: "Quilt",
    "6": "NeoForge",
    neoforge: "NeoForge",
    "neo forge": "NeoForge",
    "neo-forge": "NeoForge",
  };
  return loaderMap[value] || "";
}

function extractLoaders(values = []) {
  return [...new Set((values || []).map(normalizeModLoaderName).filter(Boolean))];
}

function createUrl(pathname, params = {}) {
  const url = new URL(`${CURSEFORGE_API}${pathname}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url;
}

function buildApiHeaders(config = {}) {
  return {
    "Accept": "application/json",
    "User-Agent": USER_AGENT,
    "x-api-key": requireApiKey(config),
  };
}

function getHostedProxyUrl(config = {}) {
  loadEnv();
  return firstConfigValue(config, PROXY_URL_FIELDS, PROXY_URL_ENV);
}

function shouldUseAgentProxy(config = {}) {
  if (config.useAgentProxy === false || process.env.ANXOS_DISABLE_CURSEFORGE_AGENT_PROXY === "1") {
    return false;
  }
  if (config.useAgentProxy === true || process.env.ANXOS_CURSEFORGE_USE_AGENT_PROXY === "1") {
    return true;
  }
  return agentClient.getBackendMode() !== "local";
}

function appendProxyParams(endpoint, pathname, params = {}) {
  const url = new URL(endpoint);
  url.searchParams.set("path", pathname);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url;
}

async function requestHostedProxyJson(proxyUrl, pathname, params = {}, label = "CurseForge request", config = {}) {
  const endpoint = appendProxyParams(new URL("/api/v1/marketplace/curseforge/api", proxyUrl.endsWith("/") ? proxyUrl : `${proxyUrl}/`), pathname, params);
  const response = await fetchWithTimeout(endpoint, {
    headers: {
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    timeoutMs: config.timeoutMs,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new CurseForgeProviderError(friendlyHttpMessage(label, response.status, body), "CURSEFORGE_PROXY_REQUEST_FAILED", {
      status: response.status,
      body: truncateForLog(body),
      url: String(endpoint),
      source: "hosted-proxy",
    });
  }
  return JSON.parse(body);
}

async function requestAgentProxyJson(pathname, params = {}, label = "CurseForge request", config = {}) {
  const endpointPath = getAgentProxyApiPath(pathname, params);
  const query = new URLSearchParams(endpointPath.params || {});
  const requestPath = query.toString() ? `${endpointPath.pathname}?${query.toString()}` : endpointPath.pathname;
  const nodeId = config.agentNodeId || config.agentConfig?.nodeId || config.agentConfig?.agentNodeId || null;
  const nodeLabel = config.agentNodeLabel || config.agentConfig?.agentNodeLabel || null;
  const credentialSource = config.credentialSource || config.agentConfig?.credentialSource || (nodeId ? "node-credential-store" : "global-configured-agent");
  try {
    return await agentClient.requestJson(requestPath, {
      config: config.agentConfig || null,
      timeoutMs: config.timeoutMs || DEFAULT_TIMEOUT_MS,
      targetLabel: nodeLabel ? `curseforge:${nodeLabel}` : nodeId ? `curseforge:${nodeId}` : "curseforge-agent-proxy",
      suppressConnectionRefusedLog: true,
    });
  } catch (error) {
    const code = error?.payload?.error?.code || error?.code || "CURSEFORGE_AGENT_PROXY_FAILED";
    const missing = code === "CURSEFORGE_CONFIGURATION_MISSING";
    const unauthorized = error?.status === 401 || code === "UNAUTHORIZED";
    throw new CurseForgeProviderError(
      missing
        ? "CurseForge is not configured on the selected AnxOS Agent."
        : unauthorized && nodeLabel
          ? `${nodeLabel} credential rejected. Repair the selected node connection before installing.`
          : error?.message || `${label}: Agent proxy request failed.`,
      code,
      {
        provider: "curseforge",
        status: error?.status || null,
        payload: error?.payload || null,
        source: "agent-proxy",
        nodeId,
        nodeLabel,
        endpoint: requestPath,
        credentialSource,
      }
    );
  }
}

function getAgentProxyApiPath(pathname, params = {}) {
  if (pathname === "/mods/search") {
    return { pathname: "/api/v1/marketplace/curseforge/search", params };
  }
  const projectMatch = pathname.match(/^\/mods\/(\d+)$/);
  if (projectMatch) {
    return { pathname: `/api/v1/marketplace/curseforge/projects/${projectMatch[1]}`, params: {} };
  }
  const filesMatch = pathname.match(/^\/mods\/(\d+)\/files$/);
  if (filesMatch) {
    return { pathname: `/api/v1/marketplace/curseforge/projects/${filesMatch[1]}/files`, params };
  }
  const fileMatch = pathname.match(/^\/mods\/(\d+)\/files\/(\d+)$/);
  if (fileMatch) {
    return { pathname: `/api/v1/marketplace/curseforge/files/${fileMatch[2]}`, params: { projectId: fileMatch[1] } };
  }
  const query = new URLSearchParams({ path: pathname });
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, String(value));
    }
  });
  return { pathname: "/api/v1/marketplace/curseforge/api", params: Object.fromEntries(query.entries()) };
}

async function requestJsonViaTrustedBackend(pathname, params = {}, label = "CurseForge request", config = {}) {
  const proxyUrl = getHostedProxyUrl(config);
  if (proxyUrl) {
    return requestHostedProxyJson(proxyUrl, pathname, params, label, config);
  }
  if (shouldUseAgentProxy(config)) {
    return requestAgentProxyJson(pathname, params, label, config);
  }
  return requestJson(createUrl(pathname, params), label, config);
}

async function requestHostedProxyBuffer(proxyUrl, url, label, options = {}) {
  const endpoint = new URL("/api/v1/marketplace/curseforge/download", proxyUrl.endsWith("/") ? proxyUrl : `${proxyUrl}/`);
  endpoint.searchParams.set("url", String(url));
  if (options.projectId) endpoint.searchParams.set("projectId", String(options.projectId));
  if (options.fileId) endpoint.searchParams.set("fileId", String(options.fileId));
  const response = await fetchWithTimeout(endpoint, {
    headers: {
      Accept: "application/octet-stream, application/json",
      "User-Agent": USER_AGENT,
    },
    timeoutMs: options.timeoutMs || options.config?.timeoutMs,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) {
    throw new CurseForgeProviderError(`${label}: hosted proxy download failed.`, "CURSEFORGE_PROXY_DOWNLOAD_FAILED", {
      status: response.status,
      url: String(endpoint),
      source: "hosted-proxy",
      projectId: options.projectId || null,
      fileId: options.fileId || null,
    });
  }
  return buffer;
}

async function requestAgentProxyBuffer(url, label, options = {}) {
  const query = new URLSearchParams({ url: String(url) });
  if (options.projectId) query.set("projectId", String(options.projectId));
  if (options.fileId) query.set("fileId", String(options.fileId));
  const proxyConfig = options.config || {};
  const nodeId = proxyConfig.agentNodeId || proxyConfig.agentConfig?.nodeId || proxyConfig.agentConfig?.agentNodeId || null;
  const nodeLabel = proxyConfig.agentNodeLabel || proxyConfig.agentConfig?.agentNodeLabel || null;
  const credentialSource = proxyConfig.credentialSource || proxyConfig.agentConfig?.credentialSource || (nodeId ? "node-credential-store" : "global-configured-agent");
  try {
    const result = await agentClient.requestBuffer(`/api/v1/marketplace/curseforge/download?${query.toString()}`, {
      config: proxyConfig.agentConfig
        ? { ...proxyConfig.agentConfig, targetLabel: nodeLabel ? `curseforge:${nodeLabel}` : nodeId ? `curseforge:${nodeId}` : "curseforge-agent-proxy" }
        : null,
      // Server packs can legitimately take several minutes; keep this timeout scoped to the download.
      timeoutMs: Math.max(15 * 60 * 1000, Number(options.timeoutMs) || Number(proxyConfig.timeoutMs) || 0),
    });
    return result.buffer;
  } catch (error) {
    const code = error?.payload?.error?.code || error?.code || "CURSEFORGE_AGENT_PROXY_DOWNLOAD_FAILED";
    const unauthorized = error?.status === 401 || code === "UNAUTHORIZED";
    throw new CurseForgeProviderError(error?.message || `${label}: Agent proxy download failed.`, code, {
      provider: "curseforge",
      status: error?.status || null,
      payload: error?.payload || null,
      source: "agent-proxy",
      nodeId,
      nodeLabel,
      endpoint: "/api/v1/marketplace/curseforge/download",
      credentialSource,
      projectId: options.projectId || null,
      fileId: options.fileId || null,
      authenticationFailure: unauthorized,
    });
  }
}

async function requestBufferViaTrustedBackend(url, label, options = {}) {
  const proxyUrl = getHostedProxyUrl(options.config || {});
  if (proxyUrl) {
    return requestHostedProxyBuffer(proxyUrl, url, label, options);
  }
  if (shouldUseAgentProxy(options.config || {})) {
    return requestAgentProxyBuffer(url, label, options);
  }
  return requestBuffer(url, label, options);
}

function buildDownloadHeaders(url, config = {}) {
  const parsed = validateDownloadUrl(url, "CurseForge file");
  const headers = {
    "User-Agent": USER_AGENT,
  };
  if (CURSEFORGE_DOWNLOAD_HOSTS.has(parsed.hostname.toLowerCase()) || parsed.hostname.toLowerCase().endsWith(".curseforge.com")) {
    headers["x-api-key"] = requireApiKey(config);
  }
  return headers;
}

async function fetchDownloadWithRedirects(url, options = {}) {
  let current = validateDownloadUrl(url, "CurseForge file");
  const maxRedirects = Math.min(Math.max(Number(options.maxRedirects) || 5, 0), 10);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const headers = buildDownloadHeaders(current, options.config || {});
    const response = await fetchWithTimeout(current, {
      headers,
      redirect: "manual",
      timeoutMs: options.timeoutMs || options.config?.timeoutMs,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      response.redirectCount = redirectCount;
      response.authenticated = Boolean(headers["x-api-key"]);
      response.finalUrl = String(current);
      response.finalHostname = current.hostname;
      return response;
    }
    const location = response.headers.get("location");
    if (!location) {
      response.redirectCount = redirectCount;
      response.authenticated = Boolean(headers["x-api-key"]);
      response.finalUrl = String(current);
      response.finalHostname = current.hostname;
      return response;
    }
    current = validateDownloadUrl(new URL(location, current).toString(), "CurseForge file redirect");
  }
  throw new CurseForgeProviderError("CurseForge download exceeded the redirect limit.", "CURSEFORGE_DOWNLOAD_REDIRECT_LIMIT", {
    url: String(current),
    redirectLimit: maxRedirects,
  });
}

async function requestJson(url, label, config = {}) {
  try {
    return await withRetry(async () => {
      const response = await fetchWithTimeout(url, {
        headers: buildApiHeaders(config),
        timeoutMs: config.timeoutMs,
      });
      const body = await response.text();
      console.info("[Marketplace][CurseForge] HTTP response.", {
        label,
        url: String(url),
        status: response.status,
        ok: response.ok,
        bodyBytes: Buffer.byteLength(body || "", "utf8"),
      });
      if (!response.ok) {
        throw new CurseForgeProviderError(friendlyHttpMessage(label, response.status, body), "CURSEFORGE_REQUEST_FAILED", {
          status: response.status,
          body: truncateForLog(body),
          url: String(url),
        });
      }
      try {
        return JSON.parse(body);
      } catch (error) {
        throw new CurseForgeProviderError(`${label} returned invalid JSON.`, "CURSEFORGE_INVALID_JSON", {
          message: error.message,
          body: truncateForLog(body),
          url: String(url),
        });
      }
    }, { label, url: String(url), attempts: config.attempts, delayMs: config.retryDelayMs });
  } catch (error) {
    const effectiveError = error instanceof CurseForgeProviderError
      ? error
      : new CurseForgeProviderError(`${label}: Network timeout or connection failure - ${error?.message || "request failed"}`, "CURSEFORGE_NETWORK_FAILED", {
        url: String(url),
        message: error?.message || "request failed",
        stack: error?.stack || null,
      });
    logProviderFailure(effectiveError, { label, url: String(url) });
    throw effectiveError;
  }
}

function validateDownloadUrl(url, label = "CurseForge file") {
  const rawUrl = String(url || "").trim();
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new CurseForgeProviderError(`${label} has an invalid download URL.`, "CURSEFORGE_INVALID_DOWNLOAD_URL", {
      invalidUrl: rawUrl || String(url),
      message: error?.message || "Invalid URL",
      stack: error?.stack || null,
    });
  }
  if (!["https:", "http:"].includes(parsed.protocol)) {
    throw new CurseForgeProviderError(`${label} has an unsafe download URL.`, "CURSEFORGE_UNSAFE_URL", { url: rawUrl });
  }
  return parsed;
}

async function requestBuffer(url, label, options = {}) {
  const parsed = validateDownloadUrl(url, label);
  try {
    return await withRetry(async () => {
      const response = await fetchDownloadWithRedirects(parsed, options);
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new CurseForgeProviderError(friendlyHttpMessage(label, response.status, body), "CURSEFORGE_DOWNLOAD_FAILED", {
          status: response.status,
          body: truncateForLog(body),
          url: response.finalUrl || url,
          hostname: response.finalHostname || parsed.hostname,
          redirectCount: response.redirectCount || 0,
          authenticated: Boolean(response.authenticated),
          projectId: options.projectId || null,
          fileId: options.fileId || null,
        });
      }
      console.info("[Marketplace][CurseForge] Download response.", {
        label,
        hostname: response.finalHostname || parsed.hostname,
        status: response.status,
        ok: response.ok,
        redirected: Boolean(response.redirectCount),
        redirectCount: response.redirectCount || 0,
        projectId: options.projectId || null,
        fileId: options.fileId || null,
        authenticated: Boolean(response.authenticated),
      });
      return Buffer.from(await response.arrayBuffer());
    }, { label, url, attempts: options.attempts || options.config?.attempts, delayMs: options.retryDelayMs || options.config?.retryDelayMs });
  } catch (error) {
    const effectiveError = error instanceof CurseForgeProviderError
      ? error
      : new CurseForgeProviderError(`${label}: Network timeout or connection failure - ${error?.message || "request failed"}`, "CURSEFORGE_NETWORK_FAILED", {
        url,
        hostname: parsed.hostname,
        projectId: options.projectId || null,
        fileId: options.fileId || null,
        message: error?.message || "request failed",
        stack: error?.stack || null,
      });
    logProviderFailure(effectiveError, { label, url });
    throw effectiveError;
  }
}

const curseForgeClient = {
  createUrl,
  requestJson,
  requestBuffer,
  searchMods(params = {}, config = {}) {
    return requestJsonViaTrustedBackend("/mods/search", params, "CurseForge search", config);
  },
  getMod(projectId, config = {}) {
    return requestJsonViaTrustedBackend(`/mods/${encodeURIComponent(projectId)}`, {}, "CurseForge mod", config);
  },
  getFiles(projectId, params = {}, config = {}) {
    return requestJsonViaTrustedBackend(`/mods/${encodeURIComponent(projectId)}/files`, params, "CurseForge files", config);
  },
  getFile(projectId, fileId, config = {}) {
    return requestJsonViaTrustedBackend(`/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`, {}, "CurseForge file", config);
  },
  getFileDownloadUrl(projectId, fileId, config = {}) {
    return requestJsonViaTrustedBackend(`/mods/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}/download-url`, {}, "CurseForge download URL", config);
  },
  getMinecraftVersions(config = {}) {
    return requestJsonViaTrustedBackend("/minecraft/version", {}, "CurseForge Minecraft versions", config);
  },
  getModLoaders(config = {}) {
    return requestJsonViaTrustedBackend("/minecraft/modloader", {}, "CurseForge mod loaders", config);
  },
  downloadFile(url, label, options = {}) {
    return requestBufferViaTrustedBackend(url, label, options);
  },
};

function assertProviderMetadata(projectId, context = "CurseForge project") {
  if (!projectId) {
    throw new CurseForgeProviderError(`${context}: Invalid provider metadata. Missing providerProjectId.`, "INVALID_PROVIDER_METADATA", {
      projectId,
    });
  }
}

function normalizeMod(mod = {}) {
  const websiteUrl = mod.links?.websiteUrl || mod.websiteUrl || null;
  const normalized = {
    id: mod.id,
    slug: mod.slug,
    name: mod.name || mod.slug || String(mod.id || ""),
    websiteUrl,
    projectUrl: websiteUrl,
    description: mod.summary || "",
    iconUrl: mod.logo?.url || null,
    author: Array.isArray(mod.authors) ? mod.authors.map((entry) => entry.name).filter(Boolean).join(", ") : "CurseForge",
    downloads: mod.downloadCount || 0,
    provider: "curseforge",
    providerProjectId: mod.id,
    minecraftVersions: [...new Set(mod.latestFilesIndexes?.map((entry) => entry.gameVersion).filter(Boolean) || [])],
    loaders: extractLoaders(mod.latestFilesIndexes?.map((entry) => entry.modLoader) || []),
    updatedAt: mod.dateModified || mod.dateReleased || null,
    serverPackFileId: mod.serverPackFileId || mod.server_pack_file_id || null,
    serverPackCompatible: mod.serverPackCompatible !== undefined ? mod.serverPackCompatible : (mod.server_pack_compatible !== undefined ? mod.server_pack_compatible : null),
    serverCapable: mod.serverCapable !== undefined ? mod.serverCapable : (mod.server_capable !== undefined ? mod.server_capable : null),
    raw: mod,
  };
  normalized.serverCompatibility = classifyServerCompatibility(normalized);
  return normalized;
}

function normalizeFile(file = {}) {
  const gameVersions = Array.isArray(file.gameVersions)
    ? file.gameVersions
    : Array.isArray(file.gameVersion)
      ? file.gameVersion
      : [];
  const normalized = {
    id: file.id,
    projectId: file.modId,
    name: file.displayName || file.fileName || String(file.id || ""),
    fileName: file.fileName || file.displayName || `${file.id}.jar`,
    downloadUrl: file.downloadUrl || null,
    minecraftVersions: gameVersions,
    loaders: extractLoaders(gameVersions),
    releaseType: file.releaseType || null,
    dependencies: Array.isArray(file.dependencies) ? file.dependencies : [],
    modules: Array.isArray(file.modules) ? file.modules : [],
    serverPackFileId: file.serverPackFileId || file.server_pack_file_id || null,
    serverPackCompatible: file.serverPackCompatible !== undefined ? file.serverPackCompatible : (file.server_pack_compatible !== undefined ? file.server_pack_compatible : null),
    serverCapable: file.serverCapable !== undefined ? file.serverCapable : (file.server_capable !== undefined ? file.server_capable : null),
    raw: file,
  };
  normalized.serverCompatibility = classifyServerCompatibility(normalized);
  return normalized;
}

function getFileMinecraftVersions(file = {}) {
  return Array.isArray(file.minecraftVersions)
    ? file.minecraftVersions
    : Array.isArray(file.gameVersions)
      ? file.gameVersions
      : [];
}

function getFileLoaders(file = {}) {
  return Array.isArray(file.loaders) ? file.loaders : extractLoaders(getFileMinecraftVersions(file));
}

function fileMatchesSelection(file = {}, selection = {}) {
  const requestedMinecraftVersion = String(selection.minecraftVersion || selection.version || "").trim().toLowerCase();
  const requestedLoader = normalizeModLoaderName(selection.loader || "");
  const versions = getFileMinecraftVersions(file).map((entry) => String(entry || "").trim().toLowerCase());
  const loaders = getFileLoaders(file).map(normalizeModLoaderName).filter(Boolean);
  return (!requestedMinecraftVersion || versions.includes(requestedMinecraftVersion)) &&
    (!requestedLoader || loaders.length === 0 || loaders.includes(requestedLoader));
}

function getReleaseTypeRank(releaseType) {
  const normalized = String(releaseType || "").trim().toLowerCase();
  if (releaseType === 1 || normalized === "1" || normalized === "release") return 0;
  if (releaseType === 2 || normalized === "2" || normalized === "beta") return 1;
  if (releaseType === 3 || normalized === "3" || normalized === "alpha") return 2;
  return 3;
}

function selectBestFile(files = [], selection = {}) {
  const candidates = (Array.isArray(files) ? files : [])
    .filter((file) => fileMatchesSelection(file, selection));
  return candidates.sort((left, right) => {
    const rank = getReleaseTypeRank(left.releaseType) - getReleaseTypeRank(right.releaseType);
    if (rank !== 0) return rank;
    return String(right.raw?.fileDate || right.raw?.fileDateUtc || right.raw?.gameVersionsDate || right.raw?.dateCreated || "").localeCompare(
      String(left.raw?.fileDate || left.raw?.fileDateUtc || left.raw?.gameVersionsDate || left.raw?.dateCreated || "")
    );
  })[0] || null;
}

function normalizeSearchOptions(queryOrOptions = "", minecraftVersion = "", loader = "", config = {}) {
  if (queryOrOptions && typeof queryOrOptions === "object") {
    return {
      query: queryOrOptions.query || "",
      minecraftVersion: queryOrOptions.minecraftVersion || queryOrOptions.version || "",
      loader: queryOrOptions.loader || "",
      mode: queryOrOptions.mode || "featured",
      offset: Math.max(Number.parseInt(queryOrOptions.offset, 10) || 0, 0),
      limit: Math.min(Math.max(Number.parseInt(queryOrOptions.limit, 10) || 25, 1), 50),
      config: queryOrOptions.config || config,
    };
  }
  return {
    query: queryOrOptions || "",
    minecraftVersion,
    loader,
    mode: "featured",
    offset: 0,
    limit: 25,
    config,
  };
}

function getSortField(mode, query) {
  if (query) return 2;
  if (mode === "trending") return 6;
  if (mode === "updated") return 3;
  return 2;
}

async function searchModpacks(queryOrOptions = "", minecraftVersion = "", loader = "", config = {}) {
  const options = normalizeSearchOptions(queryOrOptions, minecraftVersion, loader, config);
  const keyStatus = getApiKeyStatus(options.config);
  const url = createUrl("/mods/search", {
    gameId: MINECRAFT_GAME_ID,
    classId: MODPACK_CLASS_ID,
    searchFilter: options.query,
    gameVersion: options.minecraftVersion,
    modLoaderType: normalizeLoader(options.loader),
    sortField: getSortField(options.mode, options.query),
    sortOrder: "desc",
    index: options.offset,
    pageSize: options.limit,
  });
  console.info("[Marketplace][CurseForge] Search request.", {
    provider: "curseforge",
    mode: options.mode,
    query: options.query,
    minecraftVersion: options.minecraftVersion,
    loader: options.loader,
    offset: options.offset,
    limit: options.limit,
    apiKeyLoaded: keyStatus.loaded,
    apiKeySource: keyStatus.source,
    envFileExists: keyStatus.env?.envFileExists,
    envLoaded: keyStatus.env?.envLoaded,
    url: String(url),
  });
  const payload = await curseForgeClient.searchMods({
    gameId: MINECRAFT_GAME_ID,
    classId: MODPACK_CLASS_ID,
    searchFilter: options.query,
    gameVersion: options.minecraftVersion,
    modLoaderType: normalizeLoader(options.loader),
    sortField: getSortField(options.mode, options.query),
    sortOrder: "desc",
    index: options.offset,
    pageSize: options.limit,
  }, options.config);
  const rawRows = Array.isArray(payload.data) ? payload.data : [];
  const results = rawRows.map(normalizeMod);
  const total = payload.pagination?.totalCount || results.length;
  const diagnostics = {
    provider: "curseforge",
    url: String(url),
    apiCount: rawRows.length,
    filteredCount: rawRows.length,
    parsedCount: results.length,
    total,
    apiKeyLoaded: keyStatus.loaded,
    apiKeySource: keyStatus.source,
    zeroReason: rawRows.length === 0
      ? "api_returned_zero"
      : results.length === 0
        ? "parser_produced_zero"
        : null,
  };
  console.info("[Marketplace][CurseForge] Search parsed.", diagnostics);
  return {
    provider: "curseforge",
    mode: options.mode,
    offset: options.offset,
    limit: options.limit,
    total,
    nextOffset: options.offset + results.length,
    hasMore: options.offset + results.length < total,
    diagnostics,
    results,
  };
}

async function getMod(projectId, config = {}) {
  if (!projectId) {
    assertProviderMetadata(projectId, "CurseForge mod");
  }
  const cacheKey = String(projectId);
  if (modMetadataCache.has(cacheKey)) {
    return modMetadataCache.get(cacheKey);
  }
  const payload = await curseForgeClient.getMod(projectId, config);
  const mod = normalizeMod(payload.data || {});
  modMetadataCache.set(cacheKey, mod);
  return mod;
}

async function getFiles(projectId, minecraftVersion = "", loader = "", config = {}) {
  if (!projectId) {
    assertProviderMetadata(projectId, "CurseForge files");
  }
  const payload = await curseForgeClient.getFiles(projectId, {
    gameVersion: minecraftVersion,
    modLoaderType: normalizeLoader(loader),
    pageSize: 50,
  }, config);
  return (payload.data || []).map(normalizeFile);
}

async function getFile(projectId, fileId, config = {}) {
  const payload = await curseForgeClient.getFile(projectId, fileId, config);
  return normalizeFile(payload.data || {});
}

async function getFileDownloadUrl(projectId, fileId, config = {}) {
  const payload = await curseForgeClient.getFileDownloadUrl(projectId, fileId, config);
  return typeof payload.data === "string" ? payload.data : "";
}

async function getMinecraftVersions(config = {}) {
  const payload = await curseForgeClient.getMinecraftVersions(config);
  return Array.isArray(payload.data) ? payload.data : [];
}

async function getModLoaders(config = {}) {
  const payload = await curseForgeClient.getModLoaders(config);
  return Array.isArray(payload.data) ? payload.data : [];
}

async function resolveFile(projectId, minecraftVersion = "", loader = "", requestedFileId = "", config = {}) {
  if (requestedFileId && requestedFileId !== "latest") {
    const file = await getFile(projectId, requestedFileId, config);
    if (!fileMatchesSelection(file, { minecraftVersion, loader })) {
      throw new CurseForgeProviderError("Requested CurseForge file does not match the selected Minecraft version or loader.", "CURSEFORGE_FILE_VERSION_MISMATCH", {
        projectId,
        fileId: requestedFileId,
        requestedMinecraftVersion: minecraftVersion || null,
        requestedLoader: loader || null,
        fileMinecraftVersions: getFileMinecraftVersions(file),
        fileLoaders: getFileLoaders(file),
      });
    }
    return file;
  }
  const files = await getFiles(projectId, minecraftVersion, loader, config);
  const file = selectBestFile(files, { minecraftVersion, loader });
  if (!file) {
    throw new CurseForgeProviderError("No compatible CurseForge server file was found.", "CURSEFORGE_FILE_NOT_FOUND");
  }
  return file;
}

async function resolveDependencies(file, config = {}, state = null, options = {}) {
  const resolved = state || {
    seenProjects: new Set(),
    seenFiles: new Set(),
    dependencies: [],
  };
  for (const dependency of Array.isArray(file?.dependencies) ? file.dependencies : []) {
    if (![REQUIRED_DEPENDENCY, OPTIONAL_DEPENDENCY].includes(dependency.relationType)) {
      continue;
    }
    if (dependency.relationType === OPTIONAL_DEPENDENCY && options.includeOptional !== true) {
      continue;
    }
    if (!dependency.modId || resolved.seenProjects.has(dependency.modId)) {
      continue;
    }
    const dependencyFile = await resolveFile(dependency.modId, "", "", "", config);
    if (!dependencyFile || resolved.seenFiles.has(dependencyFile.id)) {
      continue;
    }
    resolved.seenProjects.add(dependency.modId);
    resolved.seenFiles.add(dependencyFile.id);
    resolved.dependencies.push({
      file: dependencyFile,
      projectId: dependency.modId,
      dependencyType: dependency.relationType === REQUIRED_DEPENDENCY ? "required" : "optional",
    });
    await resolveDependencies(dependencyFile, config, resolved, options);
  }
  return resolved.dependencies;
}

async function downloadFile(file, destination = "", options = {}) {
  let downloadUrl = file?.downloadUrl;
  if (!downloadUrl) {
    try {
      downloadUrl = await getFileDownloadUrl(file?.projectId, file?.id, options.config || {});
    } catch (error) {
      if (error && typeof error === "object") {
        error.details = {
          ...(error.details || {}),
          fileName: file?.fileName || file?.name || null,
          projectId: file?.projectId || null,
          fileId: file?.id || null,
        };
      }
      throw error;
    }
  }
  if (!downloadUrl) {
    throw new CurseForgeProviderError(`${file?.fileName || "CurseForge file"} has no download URL.`, "CURSEFORGE_DOWNLOAD_URL_MISSING", {
      projectId: file?.projectId || null,
      fileId: file?.id || null,
      fileName: file?.fileName || file?.name || null,
    });
  }
  const buffer = await curseForgeClient.downloadFile(downloadUrl, file.fileName || "CurseForge file", {
    ...options,
    projectId: file?.projectId || null,
    fileId: file?.id || null,
  });
  if (destination) {
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, file.fileName), buffer);
  }
  if (options.returnBuffer === false) {
    return { ...file, buffer: null };
  }
  return { ...file, downloadUrl, buffer };
}

module.exports = {
  _test: {
    buildApiHeaders,
    buildDownloadHeaders,
    cleanSecretValue,
    curseForgeClient,
    fetchDownloadWithRedirects,
    friendlyHttpMessage,
    getApiKeyStatus,
    getConfigurationDiagnostics,
    getCurseForgeApiKey,
    getEnvCandidates,
    isTransientError,
    normalizeMod,
    normalizeFile,
    fileMatchesSelection,
    getFileLoaders,
    getFileMinecraftVersions,
    getReleaseTypeRank,
    normalizeLoader,
    normalizeMod,
    selectBestFile,
    requireApiKey,
    setRuntimeApiKey,
    withRetry,
  },
  CurseForgeProviderError,
  downloadFile,
  ensureConfigured,
  getFile,
  getFileDownloadUrl,
  getFiles,
  getMinecraftVersions,
  getMod,
  getModLoaders,
  logStartupStatus,
  resolveDependencies,
  resolveFile,
  searchModpacks,
  testConnection,
};
