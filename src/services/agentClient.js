const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");
const dotenv = require("dotenv");
const { app } = require("electron");
const {
  isWeakAgentToken,
  parseAgentPairingPayload,
  readAgentConfigFile,
  resolveSharedAgentToken,
  rotateSharedAgentToken,
  tokenFingerprint,
  writeAgentConfigSettings,
} = require("../shared/agentTokenStore");

const DEFAULT_BACKEND_MODE = "local";
const DEFAULT_AGENT_URL = "http://127.0.0.1:47131";
const REQUEST_TIMEOUT_MS = 30000;
const FILE_WRITE_REQUEST_TIMEOUT_MS = 300000;
const FILE_WRITE_TIMEOUT_MS = FILE_WRITE_REQUEST_TIMEOUT_MS;
const FILE_WRITE_RETRY_DELAY_MS = 250;
const TRANSIENT_FILE_WRITE_ERROR_CODES = new Set(["UND_ERR_SOCKET", "ECONNRESET", "EPIPE"]);
const DOCKER_REQUEST_TIMEOUT_MS = 12000;
const PUBLIC_ACCESS_REQUEST_TIMEOUT_MS = 12000;
const VALID_BACKEND_MODES = new Set(["local", "agent", "auto"]);

let environmentLoaded = false;
let lastLoggedAgentSelection = null;
let lastLoggedAgentConfigMeta = null;
let localInstanceService = null;
const requestFailureLogState = new Map();

class AgentClientError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "AgentClientError";
    this.status = details.status || null;
    this.code = details.code || null;
    this.payload = details.payload || null;
    this.details = details.details || details.payload?.error?.details || null;
  }
}

function loadEnvironment() {
  if (environmentLoaded) {
    return;
  }

  environmentLoaded = true;

  try {
    dotenv.config({
      path: process.env.ANXHUB_ENV_PATH || path.join(process.cwd(), ".env"),
      quiet: true,
    });
  } catch {
    // Environment variables are optional for the default local backend.
  }
}

function trimValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function firstDefined(object, keys) {
  for (const key of keys) {
    if (hasOwn(object, key) && object[key] !== undefined) {
      return object[key];
    }
  }

  return undefined;
}

function normalizeBackendMode(value) {
  const normalized = trimValue(value).toLowerCase();
  return VALID_BACKEND_MODES.has(normalized) ? normalized : DEFAULT_BACKEND_MODE;
}

function getDefaultAgentSettings() {
  const tokenStatus = getSharedAgentTokenStatus();
  return {
    backendMode: DEFAULT_BACKEND_MODE,
    agentUrl: DEFAULT_AGENT_URL,
    agentToken: tokenStatus.token || "",
  };
}

function normalizeAgentSettings(settings = {}) {
  const modeValue = firstDefined(settings, ["backendMode", "mode"]);
  const urlValue = firstDefined(settings, ["agentUrl", "url"]);
  const tokenValue = firstDefined(settings, ["agentToken", "token"]);
  const normalizedToken = trimValue(tokenValue);

  return {
    backendMode: modeValue === undefined ? DEFAULT_BACKEND_MODE : normalizeBackendMode(modeValue),
    agentUrl: trimValue(urlValue) || DEFAULT_AGENT_URL,
    agentToken: isWeakAgentToken(normalizedToken) ? "" : normalizedToken,
  };
}

function getAgentConfigDirectory() {
  const explicitConfigDir = trimValue(process.env.ANXHUB_CONFIG_DIR);

  if (explicitConfigDir) {
    return explicitConfigDir;
  }

  if (app) {
    try {
      return path.join(app.getPath("userData"), "config");
    } catch {
      // Fall through to a writable non-Electron fallback.
    }
  }

  return path.join(process.cwd(), "config");
}

function getAgentConfigPath() {
  return path.join(getAgentConfigDirectory(), "agent.json");
}

function getSharedAgentTokenStatus() {
  return resolveSharedAgentToken({
    configPath: getAgentConfigPath(),
    environmentToken: process.env.AGENT_TOKEN,
  });
}

function getLocalInstanceService() {
  if (!localInstanceService) {
    localInstanceService = require("./localInstanceService");
  }
  return localInstanceService;
}

function shouldUseLocalInstanceService(configOverride = null) {
  return !configOverride && getBackendMode() === "local";
}

function logAgentConfigMetadata(reason, configPath, settings = null) {
  const payload = {
    reason,
    configPath,
    keys: settings && typeof settings === "object" && !Array.isArray(settings)
      ? Object.keys(settings).sort()
      : [],
  };
  const serialized = JSON.stringify(payload);

  if (serialized === lastLoggedAgentConfigMeta) {
    return;
  }

  lastLoggedAgentConfigMeta = serialized;
  console.info(
    `[AnxOS][Agent] Config path: ${payload.configPath} (source=${reason}, keys=${payload.keys.join(",") || "<none>"})`,
  );
}

function logAgentSelection(reason, source) {
  const payload = {
    reason,
    backendMode: source.backendMode,
    agentUrl: source.agentUrl || DEFAULT_AGENT_URL,
    hasToken: Boolean(trimValue(source.agentToken)),
  };
  const serialized = JSON.stringify(payload);

  if (serialized === lastLoggedAgentSelection) {
    return;
  }

  lastLoggedAgentSelection = serialized;
  console.info(
    `[AnxOS][Agent] Selected agent URL: ${payload.agentUrl} (mode=${payload.backendMode}, source=${reason}, token=${payload.hasToken ? "set" : "unset"})`,
  );
}

function ensureAgentConfigDirectory() {
  fs.mkdirSync(getAgentConfigDirectory(), { recursive: true });
}

function ensureAgentConfigFile() {
  ensureAgentConfigDirectory();
  const agentConfigPath = getAgentConfigPath();

  if (!fs.existsSync(agentConfigPath)) {
    const defaults = getDefaultAgentSettings();
    fs.writeFileSync(agentConfigPath, `${JSON.stringify(defaults, null, 2)}\n`, "utf8");
    logAgentConfigMetadata("created-default-config", agentConfigPath, defaults);
  } else {
    getSharedAgentTokenStatus();
  }
}

function readAgentSettings() {
  const agentConfigPath = getAgentConfigPath();
  ensureAgentConfigFile();
  const parsed = readAgentConfigFile(agentConfigPath);
  logAgentConfigMetadata("read-config", agentConfigPath, parsed);
  return normalizeAgentSettings(parsed);
}

function saveAgentSettings(settings = {}) {
  const existing = readAgentSettings();
  const explicitMode = firstDefined(settings, ["backendMode", "mode"]);
  const explicitUrl = firstDefined(settings, ["agentUrl", "url"]);
  const hasExplicitToken = hasOwn(settings, "agentToken") || hasOwn(settings, "token");
  const explicitToken = firstDefined(settings, ["agentToken", "token"]);
  const normalized = normalizeAgentSettings({
    backendMode: explicitMode === undefined ? existing.backendMode : explicitMode,
    agentUrl: explicitUrl === undefined ? existing.agentUrl : explicitUrl,
    agentToken: hasExplicitToken ? explicitToken : existing.agentToken,
  });
  const agentConfigPath = getAgentConfigPath();
  ensureAgentConfigDirectory();
  writeAgentConfigSettings(agentConfigPath, normalized);
  logAgentConfigMetadata("saved-config", agentConfigPath, normalized);
  logAgentSelection("saved-config", normalized);
  return normalized;
}

function getEffectiveAgentSettings() {
  loadEnvironment();

  const stored = readAgentSettings();
  const tokenStatus = getSharedAgentTokenStatus();
  const environmentMode = trimValue(process.env.BACKEND_MODE || process.env.backendMode || process.env.ANXHUB_BACKEND_MODE);
  const environmentUrl = trimValue(process.env.AGENT_URL);

  const effective = {
    backendMode: environmentMode ? normalizeBackendMode(environmentMode) : stored.backendMode,
    agentUrl: environmentUrl || stored.agentUrl || DEFAULT_AGENT_URL,
    agentToken: tokenStatus.token || stored.agentToken || "",
    tokenStatus,
    overrides: {
      backendMode: Boolean(environmentMode),
      agentUrl: Boolean(environmentUrl),
      agentToken: Boolean(tokenStatus.environmentTokenPresent && tokenStatus.environmentTokenMatches),
    },
  };

  logAgentSelection("effective-config", effective);
  return effective;
}

function rotateAgentSettingsToken(updates = {}) {
  const current = readAgentSettings();
  const rotated = rotateSharedAgentToken({
    configPath: getAgentConfigPath(),
    updates: {
      backendMode: updates.backendMode || current.backendMode,
      agentUrl: updates.agentUrl || current.agentUrl,
    },
  });
  const settings = readAgentSettings();
  logAgentConfigMetadata("rotated-token", getAgentConfigPath(), settings);
  logAgentSelection("rotated-token", settings);
  return {
    ...rotated,
    settings,
  };
}

function pairAgentFromCode(code) {
  const pairing = parseAgentPairingPayload(code);
  const saved = saveAgentSettings({
    backendMode: "agent",
    agentUrl: pairing.agentUrl,
    agentToken: pairing.agentToken,
  });
  return {
    paired: true,
    agentUrl: saved.agentUrl,
    fingerprint: tokenFingerprint(saved.agentToken),
    expiresAt: pairing.expiresAt,
    restartRequired: false,
  };
}

function getBackendMode() {
  return getEffectiveAgentSettings().backendMode;
}

function isNodeScopedAgentConfig(configOverride = null) {
  const nodeId = trimValue(configOverride?.nodeId || configOverride?.agentNodeId);
  if (nodeId === "application-host" && normalizeBackendMode(configOverride?.backendMode) === "local") {
    return false;
  }
  return Boolean(
    configOverride
      && (nodeId
        || /^node:/i.test(trimValue(configOverride.targetLabel))),
  );
}

function getNodeScopedConfig(configOverride = {}) {
  const explicitNodeId = trimValue(configOverride.nodeId || configOverride.agentNodeId);
  const targetLabelNodeId = /^node:/i.test(trimValue(configOverride.targetLabel))
    ? trimValue(configOverride.targetLabel).replace(/^node:/i, "")
    : "";
  const nodeId = explicitNodeId || targetLabelNodeId;
  if (!nodeId) {
    throw new AgentClientError("Select a registered Agent node before contacting the Agent.", {
      code: "NODE_REQUIRED",
      details: {
        targetLabel: configOverride.targetLabel || null,
        operation: "resolve-node-credential",
      },
    });
  }
  let canonical = null;
  try {
    canonical = getNodeService().getNodeAgentConfig(nodeId);
  } catch (error) {
    throw new AgentClientError(error?.message || "Selected Agent node could not be resolved.", {
      code: error?.code || "NODE_NOT_FOUND",
      details: {
        nodeId,
        targetLabel: configOverride.targetLabel || `node:${nodeId}`,
        operation: "resolve-node-credential",
      },
    });
  }
  if (!trimValue(canonical.agentToken)) {
    throw new AgentClientError("Saved credential is missing for the selected Agent node.", {
      code: "NODE_CREDENTIAL_MISSING",
      details: {
        nodeId,
        nodeUrl: canonical.agentUrl || null,
        targetLabel: configOverride.targetLabel || `node:${nodeId}`,
        operation: "resolve-node-credential",
      },
    });
  }
  return normalizeAgentSettings({
    ...configOverride,
    backendMode: "agent",
    agentUrl: canonical.agentUrl,
    agentToken: canonical.agentToken,
  });
}

function getAgentConfig(configOverride = null) {
  const source = (() => {
    if (!configOverride) {
      return getEffectiveAgentSettings();
    }
    const nodeScoped = isNodeScopedAgentConfig(configOverride);
    if (nodeScoped) {
      return getNodeScopedConfig(configOverride);
    }
    const fallback = nodeScoped
      ? { backendMode: "agent", agentUrl: DEFAULT_AGENT_URL, agentToken: "" }
      : getEffectiveAgentSettings();
    const overrideHasToken = hasOwn(configOverride, "agentToken") || hasOwn(configOverride, "token");
    const normalizedOverride = normalizeAgentSettings({
      ...configOverride,
      agentToken: overrideHasToken
        ? firstDefined(configOverride, ["agentToken", "token"])
        : fallback.agentToken,
    });
    return {
      ...normalizedOverride,
      agentToken: normalizedOverride.agentToken || (nodeScoped ? "" : fallback.agentToken || ""),
    };
  })();

  return {
    url: source.agentUrl || DEFAULT_AGENT_URL,
    token: trimValue(source.agentToken) || null,
  };
}

function buildAgentUrl(pathname, configOverride = null) {
  const config = getAgentConfig(configOverride);
  const baseUrl = config.url.endsWith("/") ? config.url : `${config.url}/`;
  try {
    return new URL(pathname, baseUrl).toString();
  } catch (error) {
    throw new AgentClientError("Invalid agent URL.", {
      code: "AGENT_INVALID_URL",
      payload: {
        error: {
          code: "AGENT_INVALID_URL",
          message: "Invalid agent URL.",
          details: {
            baseUrl,
            pathname,
            invalidUrl: config.url,
            name: error?.name || null,
            message: error?.message || null,
          },
        },
      },
    });
  }
}

function logAgentRequestFailure(pathname, status, errorCode = null, details = {}) {
  const targetLabel = details.targetLabel || "global-configured-agent";
  const throttleMs = Number.isFinite(details.logThrottleMs) ? details.logThrottleMs : 30000;
  const now = Date.now();
  const key = JSON.stringify({
    targetLabel,
    pathname,
    url: details.url || null,
    method: details.method || "GET",
    status: status ?? null,
    errorCode: errorCode || null,
    message: details.message || null,
  });
  const previous = requestFailureLogState.get(key);

  if (previous && now - previous.lastLoggedAt < throttleMs) {
    previous.suppressedCount += 1;
    requestFailureLogState.set(key, previous);
    return;
  }

  const suppressedCount = previous?.suppressedCount || 0;
  console.error("[AnxOS][Agent] Request failed.", {
    targetLabel,
    pathname,
    url: details.url || null,
    method: details.method || "GET",
    status: status ?? null,
    errorCode: errorCode || null,
    responseBody: details.responseBody || null,
    message: details.message || null,
    originalMessage: details.originalMessage || null,
    causeCode: details.causeCode || null,
    suppressedCount,
  });
  requestFailureLogState.set(key, { lastLoggedAt: now, suppressedCount: 0 });
}

function getTransportErrorCode(error) {
  return error?.cause?.code || error?.code || null;
}

function isTransientFileWriteTransportError(error) {
  if (Number.isInteger(error?.status) && error.status > 0) return false;
  const code = error?.code
    || error?.cause?.code
    || error?.details?.causeCode
    || error?.payload?.error?.details?.causeCode
    || null;
  return TRANSIENT_FILE_WRITE_ERROR_CODES.has(code);
}

async function retryTransientFileWrite(request) {
  try {
    return await request();
  } catch (error) {
    if (!isTransientFileWriteTransportError(error)) throw error;
    await new Promise((resolve) => setTimeout(resolve, FILE_WRITE_RETRY_DELAY_MS));
    return request();
  }
}

function getAgentTransportErrorMessage(errorCode, requestUrl) {
  if (["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"].includes(errorCode)) {
    return `Agent unavailable at ${requestUrl || "the configured URL"}. Check that the Agent is running, reachable, and listening on the configured port.`;
  }
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "AGENT_TIMEOUT"].includes(errorCode)) {
    return `Agent request timed out at ${requestUrl || "the configured URL"}. Check the Agent host, firewall, and network route.`;
  }
  if (["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "ERR_SSL_WRONG_VERSION_NUMBER"].includes(errorCode)) {
    return `Agent TLS verification failed at ${requestUrl || "the configured URL"}. Verify the Agent URL, certificate hostname, trust chain, and certificate validity before reconnecting.`;
  }
  return "Agent unavailable. Check Agent settings.";
}

function getAgentHttpErrorMessage(status, code, payload) {
  if (code === "AGENT_TOKEN_MISSING") {
    return "Agent token is missing. Open Agent Control, generate a pairing code, then pair or repair the node connection.";
  }
  if (code === "UNAUTHORIZED") {
    return "Agent token rejected. Open Agent Control and use Repair, Rotate Token, or Pair with Code to refresh the connection.";
  }
  const payloadMessage = payload?.error?.message;
  if (payloadMessage && payloadMessage !== "Request failed.") {
    return payloadMessage;
  }
  const userMessage = payload?.error?.details?.userMessage;
  if (userMessage) {
    return userMessage;
  }
  return `Agent request failed with HTTP ${status}.`;
}

function getAgentPayloadErrorCode(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return "AGENT_HTTP_ERROR";
  }
  return payload.error?.code || payload.errorCode || payload.code || "AGENT_HTTP_ERROR";
}

function getDockerApiExpectation(pathname, method = "GET") {
  if (!String(pathname || "").startsWith("/api/v1/docker/")) {
    return null;
  }
  const normalizedMethod = String(method || "GET").toUpperCase();
  const expectations = [
    ["GET", /^\/api\/v1\/docker\/capabilities$/, "Agent Docker capability manifest"],
    ["GET", /^\/api\/v1\/docker\/snapshot$/, "Docker workspace snapshot"],
    ["GET", /^\/api\/v1\/docker\/summary$/, "Docker summary"],
    ["GET", /^\/api\/v1\/docker\/containers$/, "container list"],
    ["POST", /^\/api\/v1\/docker\/containers$/, "container create"],
    ["GET", /^\/api\/v1\/docker\/containers\/[^/]+\/inspect$/, "container inspect"],
    ["GET", /^\/api\/v1\/docker\/containers\/[^/]+\/logs(?:\?|$)/, "container logs"],
    ["GET", /^\/api\/v1\/docker\/containers\/[^/]+\/stats$/, "container stats"],
    ["POST", /^\/api\/v1\/docker\/containers\/[^/]+\/(?:start|stop|restart|pause|unpause|kill|rename|exec)$/, "container lifecycle/action"],
    ["DELETE", /^\/api\/v1\/docker\/containers\/[^/]+$/, "container delete"],
    ["GET", /^\/api\/v1\/docker\/images$/, "image list"],
    ["POST", /^\/api\/v1\/docker\/images\/(?:pull|prune)$/, "image pull/prune"],
    ["GET", /^\/api\/v1\/docker\/images\/[^/]+$/, "image inspect"],
    ["DELETE", /^\/api\/v1\/docker\/images\/[^/]+$/, "image delete"],
    ["GET", /^\/api\/v1\/docker\/networks$/, "network list"],
    ["POST", /^\/api\/v1\/docker\/networks(?:\/prune)?$/, "network create/prune"],
    ["GET", /^\/api\/v1\/docker\/networks\/[^/]+\/inspect$/, "network inspect"],
    ["POST", /^\/api\/v1\/docker\/networks\/[^/]+\/(?:connect|disconnect)$/, "network connect/disconnect"],
    ["DELETE", /^\/api\/v1\/docker\/networks\/[^/]+$/, "network delete"],
    ["GET", /^\/api\/v1\/docker\/volumes$/, "volume list"],
    ["POST", /^\/api\/v1\/docker\/volumes\/prune$/, "volume prune"],
    ["GET", /^\/api\/v1\/docker\/volumes\/[^/]+\/inspect$/, "volume inspect"],
    ["DELETE", /^\/api\/v1\/docker\/volumes\/[^/]+$/, "volume delete"],
    ["GET", /^\/api\/v1\/docker\/compose\/projects$/, "Compose project discovery"],
    ["POST", /^\/api\/v1\/docker\/compose\/(?:config|up|stop|restart|pull|build|recreate|logs|status|down)$/, "Compose operation"],
    ["GET", /^\/api\/v1\/docker\/cleanup\/preview$/, "Docker cleanup preview"],
    ["POST", /^\/api\/v1\/docker\/cleanup$/, "Docker cleanup execution"],
  ];
  const match = expectations.find(([expectedMethod, pattern]) => expectedMethod === normalizedMethod && pattern.test(pathname));
  return match?.[2] || "Docker API route";
}

function createDockerNotFoundDetails({ method, pathname, requestUrl, expectation }) {
  return {
    method,
    requestedAgentPath: pathname,
    activeAgentUrl: requestUrl,
    desktopApiExpectation: expectation,
    likelyCause: "Desktop and Agent Docker API versions do not match, or the running Agent was not restarted after a Docker route update.",
    compatibilityEndpoint: "/api/v1/docker/capabilities",
  };
}

function getGameConfigApiExpectation(pathname, method = "GET") {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (!["GET", "PUT", "PATCH"].includes(normalizedMethod)) {
    return null;
  }
  return /^\/api\/v1\/instances\/[^/]+\/game-config(?:\?|$)/.test(String(pathname || ""))
    ? "Minecraft Configuration game-config endpoint"
    : null;
}

function createGameConfigNotFoundDetails({ method, pathname, requestUrl, expectation }) {
  return {
    method,
    requestedAgentPath: pathname,
    activeAgentUrl: requestUrl,
    desktopApiExpectation: expectation,
    likelyCause: "The selected remote Agent does not include the v1.8 Minecraft Configuration API.",
    compatibilityEndpoint: "/api/v1/instances/:id/game-config",
  };
}

function getNeoForgeRepairApiExpectation(pathname, method = "GET") {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (normalizedMethod !== "POST") {
    return null;
  }
  return /^\/api\/v1\/instances\/[^/]+\/neoforge\/repair-runtime$/.test(String(pathname || ""))
    ? "NeoForge runtime repair endpoint"
    : null;
}

function createNeoForgeRepairNotFoundDetails({ method, pathname, requestUrl, expectation }) {
  return {
    method,
    requestedAgentPath: pathname,
    activeAgentUrl: requestUrl,
    desktopApiExpectation: expectation,
    likelyCause: "The selected remote Agent does not include the v1.8 NeoForge runtime repair API or needs to be restarted after update.",
    compatibilityEndpoint: "/api/v1/instances/:id/neoforge/repair-runtime",
  };
}

function getPublicAccessPlayitApiExpectation(pathname, method = "GET") {
  const normalizedMethod = String(method || "GET").toUpperCase();
  const path = String(pathname || "");
  const expectations = [
    ["GET", /^\/api\/v1\/public-access\/playit\/status$/, "Playit service status endpoint"],
    ["GET", /^\/api\/v1\/public-access\/playit\/logs(?:\?|$)/, "Playit service logs endpoint"],
    ["GET", /^\/api\/v1\/public-access\/playit\/tunnels(?:\?|$)/, "Playit tunnel listing endpoint"],
    ["POST", /^\/api\/v1\/public-access\/playit\/(?:start|stop|restart)$/, "Playit service control endpoint"],
  ];
  const match = expectations.find(([expectedMethod, pattern]) => expectedMethod === normalizedMethod && pattern.test(path));
  return match?.[2] || null;
}

function createPublicAccessPlayitNotFoundDetails({ method, pathname, requestUrl, expectation }) {
  return {
    method,
    requestedAgentPath: pathname,
    activeAgentUrl: requestUrl,
    desktopApiExpectation: expectation,
    likelyCause: "The selected remote Agent does not include the v1.8 Playit Public Access controls API or needs to be restarted after update.",
    compatibilityEndpoint: "/api/v1/public-access/playit/status",
  };
}

function redactForAgentLog(value, depth = 0) {
  if (depth > 6) {
    return "[truncated]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactForAgentLog(entry, depth + 1));
  }
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && /bearer\s+[a-z0-9._-]+|eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/i.test(value)) {
      return "[redacted]";
    }
    if (typeof value === "string" && value.length > 4096) {
      return `[string omitted, ${value.length} chars]`;
    }
    return value;
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (/password|passphrase|token|secret|api[-_]?key|authorization|cookie|session|refresh/i.test(key)) {
      return [key, "[redacted]"];
    }
    if (key === "content" && typeof entry === "string" && entry.length > 4096) {
      return [key, `[content omitted, ${entry.length} chars]`];
    }
    return [key, redactForAgentLog(entry, depth + 1)];
  }));
}

function logAgentRequestPayload(pathname, details = {}) {
  if (!["POST", "PUT", "PATCH"].includes(details.method || "GET")) {
    return;
  }
  if (!/^\/api\/v1\/instances(?:\/|$)/.test(pathname)) {
    return;
  }
  console.info("[AnxOS][Agent] Request payload.", {
    pathname,
    method: details.method,
    targetLabel: details.targetLabel || "global-configured-agent",
    body: redactForAgentLog(details.body),
  });
}

function parseAgentPayload(buffer, contentType) {
  if (!buffer || buffer.length === 0) {
    return null;
  }

  if (String(contentType || "").includes("application/json")) {
    try {
      return JSON.parse(buffer.toString("utf8"));
    } catch {
      return null;
    }
  }

  return buffer.toString("utf8");
}

async function requestJson(pathname, options = {}) {
  const {
    config: configOverride = null,
    method = "GET",
    body = null,
    targetLabel = configOverride?.targetLabel || "global-configured-agent",
    suppressConnectionRefusedLog = configOverride?.suppressConnectionRefusedLog === true,
    logThrottleMs = configOverride?.logThrottleMs,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = options;
  const config = getAgentConfig(configOverride);
  const controller = new AbortController();
  const boundedTimeoutMs = Math.max(1000, Number(timeoutMs) || REQUEST_TIMEOUT_MS);
  const timeout = setTimeout(() => controller.abort(), boundedTimeoutMs);

  try {
    const headers = {
      Accept: "application/json",
    };

    if (config.token) {
      headers.Authorization = `Bearer ${config.token}`;
    }

    if (body !== null) {
      headers["Content-Type"] = "application/json";
    }

    const requestUrl = buildAgentUrl(pathname, configOverride);
    logAgentRequestPayload(pathname, {
      method,
      targetLabel,
      body,
    });
    const response = await fetch(requestUrl, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json") ? await response.json() : await response.text();

    if (!response.ok) {
      const responseErrorCode = getAgentPayloadErrorCode(payload);
      const dockerExpectation = response.status === 404 ? getDockerApiExpectation(pathname, method) : null;
      const gameConfigExpectation = response.status === 404 ? getGameConfigApiExpectation(pathname, method) : null;
      const neoForgeRepairExpectation = response.status === 404 ? getNeoForgeRepairApiExpectation(pathname, method) : null;
      const publicAccessPlayitExpectation = response.status === 404 ? getPublicAccessPlayitApiExpectation(pathname, method) : null;
      const dockerNotFoundDetails = dockerExpectation
        ? createDockerNotFoundDetails({ method, pathname, requestUrl, expectation: dockerExpectation })
        : null;
      const gameConfigNotFoundDetails = gameConfigExpectation
        ? createGameConfigNotFoundDetails({ method, pathname, requestUrl, expectation: gameConfigExpectation })
        : null;
      const neoForgeRepairNotFoundDetails = neoForgeRepairExpectation
        ? createNeoForgeRepairNotFoundDetails({ method, pathname, requestUrl, expectation: neoForgeRepairExpectation })
        : null;
      const publicAccessPlayitNotFoundDetails = publicAccessPlayitExpectation
        ? createPublicAccessPlayitNotFoundDetails({ method, pathname, requestUrl, expectation: publicAccessPlayitExpectation })
        : null;
      const compatibilityDetails = dockerNotFoundDetails || gameConfigNotFoundDetails || neoForgeRepairNotFoundDetails || publicAccessPlayitNotFoundDetails;
      const message = dockerNotFoundDetails
        ? `Agent Docker endpoint was not found for ${method} ${pathname}. Expected ${dockerExpectation}. This usually means the Desktop and Agent builds are out of sync or the Agent needs a restart.`
        : gameConfigNotFoundDetails
          ? `Agent update required for Minecraft Configuration. The selected Agent does not expose ${method} ${pathname}. Update or restart the remote Agent, then try again.`
          : neoForgeRepairNotFoundDetails
            ? `Agent update required for NeoForge repair. The selected Agent does not expose ${method} ${pathname}. Update or restart the remote Agent, then try again.`
            : publicAccessPlayitNotFoundDetails
              ? `Agent update required for Playit service controls. The selected Agent does not expose ${method} ${pathname}. Update or restart the remote Agent, then try again.`
              : getAgentHttpErrorMessage(response.status, responseErrorCode, payload);
      const compatibilityCode = gameConfigNotFoundDetails
        ? "AGENT_GAME_CONFIG_UNSUPPORTED"
        : neoForgeRepairNotFoundDetails
          ? "AGENT_NEOFORGE_REPAIR_UNSUPPORTED"
          : publicAccessPlayitNotFoundDetails
            ? "AGENT_PLAYIT_CONTROLS_UNSUPPORTED"
            : responseErrorCode;
      const error = new AgentClientError(message, {
        status: response.status,
        code: compatibilityCode,
        payload: compatibilityDetails && payload && typeof payload === "object" && !Array.isArray(payload)
          ? {
              ...payload,
              error: {
                ...(payload.error || {}),
                code: compatibilityCode,
                message,
                details: {
                  ...(payload.error?.details || {}),
                  ...compatibilityDetails,
                },
              },
            }
          : payload,
      });
      logAgentRequestFailure(pathname, response.status, responseErrorCode, {
        url: requestUrl,
        method,
        targetLabel,
        logThrottleMs,
        responseBody: response.status === 401 || ["UNAUTHORIZED", "AGENT_TOKEN_MISSING"].includes(responseErrorCode)
          ? "[redacted authentication response]"
          : typeof payload === "string" ? payload : JSON.stringify(payload),
        message: error.message,
        originalMessage: dockerNotFoundDetails?.likelyCause || null,
      });
      throw error;
    }

    return payload;
  } catch (error) {
    if (error instanceof AgentClientError) {
      throw error;
    }

    const errorCode = error?.name === "AbortError"
      ? "AGENT_TIMEOUT"
      : getTransportErrorCode(error) || "AGENT_UNAVAILABLE";
    const requestUrl = (() => {
      try {
        return buildAgentUrl(pathname, configOverride);
      } catch (urlError) {
        return urlError?.payload?.error?.details?.invalidUrl || null;
      }
    })();
    const transportMessage = getAgentTransportErrorMessage(errorCode, requestUrl);
    if (!(suppressConnectionRefusedLog && errorCode === "ECONNREFUSED")) {
      logAgentRequestFailure(pathname, null, errorCode, {
        url: requestUrl,
        method,
        targetLabel,
        logThrottleMs,
        message: transportMessage,
        originalMessage: error?.message || null,
        causeCode: error?.cause?.code || error?.code || null,
      });
    }
    throw new AgentClientError(transportMessage, {
      code: errorCode,
      payload: {
        error: {
          code: errorCode,
          message: transportMessage,
          details: {
            name: error?.name || null,
            message: transportMessage,
            originalMessage: error?.message || null,
            causeCode: error?.cause?.code || error?.code || null,
            url: requestUrl,
            payload: error?.payload || null,
          },
        },
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

function unwrapPayload(payload, key) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }

  if (payload[key] !== undefined) {
    return payload[key];
  }

  if (payload.data && typeof payload.data === "object") {
    if (payload.data[key] !== undefined) {
      return payload.data[key];
    }

    return payload.data;
  }

  return payload;
}

function inferState(status) {
  if (/^up\b|running/i.test(status || "")) {
    return "running";
  }

  if (/exited|created|dead|paused|restarting|removing|stopped/i.test(status || "")) {
    return "stopped";
  }

  return status || null;
}

function normalizeName(name) {
  if (Array.isArray(name)) {
    return normalizeName(name[0]);
  }

  if (typeof name !== "string") {
    return name || null;
  }

  return name.replace(/^\/+/, "") || null;
}

function normalizePorts(ports) {
  if (!Array.isArray(ports)) {
    return ports || null;
  }

  return ports.map((port) => {
    if (!port || typeof port !== "object") {
      return port;
    }

    const privatePort = port.PrivatePort || port.privatePort;
    const publicPort = port.PublicPort || port.publicPort;
    const type = port.Type || port.type;
    const ip = port.IP || port.ip;

    if (publicPort && privatePort) {
      const host = ip ? `${ip}:` : "";
      return `${host}${publicPort}->${privatePort}${type ? `/${type}` : ""}`;
    }

    if (privatePort) {
      return `${privatePort}${type ? `/${type}` : ""}`;
    }

    return JSON.stringify(port);
  });
}

function normalizeContainerStats(stats) {
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) {
    return null;
  }

  return {
    id: stats.id || stats.ID || stats.Container || null,
    container: stats.container || stats.Container || null,
    name: normalizeName(stats.name || stats.Name),
    cpuPercent: stats.cpuPercent ?? stats.CPUPerc ?? stats.CPUPercent ?? null,
    memoryUsage: stats.memoryUsage || null,
    memoryLimit: stats.memoryLimit || null,
    memoryRaw: stats.memoryRaw || stats.MemUsage || null,
    memoryPercent: stats.memoryPercent ?? stats.MemPerc ?? stats.MemoryPercent ?? null,
    networkRx: stats.networkRx || null,
    networkTx: stats.networkTx || null,
    networkRaw: stats.networkRaw || stats.NetIO || null,
    blockIo: stats.blockIo || stats.BlockIO || null,
    pids: stats.pids || stats.PIDs || null,
  };
}

function normalizeContainer(container) {
  if (!container || typeof container !== "object") {
    return null;
  }

  const status = container.status || container.Status || container.state || container.State || null;

  return {
    id: container.id || container.ID || container.Id || null,
    name: normalizeName(container.name || container.Names || container.Name),
    image: container.image || container.Image || null,
    command: container.command || container.Command || null,
    createdAt: container.createdAt || container.CreatedAt || container.created || container.Created || null,
    status,
    state: container.state || container.State || inferState(status),
    ports: normalizePorts(container.ports || container.Ports),
    rawPorts: container.rawPorts || container.RawPorts || container.Ports || null,
    runningFor: container.runningFor || container.RunningFor || status,
    stats: normalizeContainerStats(container.stats || container.Stats),
    cpuPercent: container.cpuPercent || container.CPUPerc || null,
    memoryUsage: container.memoryUsage || null,
    memoryLimit: container.memoryLimit || null,
    memoryRaw: container.memoryRaw || null,
    memoryPercent: container.memoryPercent || null,
  };
}

function normalizeContainers(payload) {
  const containers = unwrapPayload(payload, "containers");

  if (!Array.isArray(containers)) {
    return [];
  }

  return containers.map(normalizeContainer).filter(Boolean);
}

function coerceBoolean(value, fallback) {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    if (/^(true|yes|1|running|installed|healthy|ok)$/i.test(value)) {
      return true;
    }

    if (/^(false|no|0|stopped|missing|unhealthy|error)$/i.test(value)) {
      return false;
    }
  }

  return fallback;
}

function coerceNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function normalizeSummary(payload, containers) {
  const unwrapped = unwrapPayload(payload, "summary") || {};
  const snapshot = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const summary = unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped) ? unwrapped : {};
  const runningContainers = containers.filter((container) => /^running$/i.test(container.state || "") || /^up\b/i.test(container.status || ""));

  const installed = coerceBoolean(snapshot.installed ?? summary.installed, true);
  const daemonRunning = coerceBoolean(snapshot.daemonRunning ?? summary.daemonRunning, true);

  return {
    installed,
    daemonRunning,
    version: snapshot.version || summary.version || null,
    summary: {
      installed,
      daemonRunning,
      runningContainers: coerceNumber(summary.runningContainers ?? snapshot.runningContainers, runningContainers.length),
      totalContainers: coerceNumber(summary.totalContainers ?? snapshot.totalContainers, containers.length),
    },
    lastCheckedAt: snapshot.lastCheckedAt || summary.lastCheckedAt || new Date().toISOString(),
    diagnostics: {
      ...(snapshot.diagnostics && typeof snapshot.diagnostics === "object" ? snapshot.diagnostics : {}),
      agent: {
        url: getAgentConfig().url,
      },
    },
  };
}

function isHealthyPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return true;
  }

  const status = payload.status || payload.state;

  if (typeof payload.healthy === "boolean") {
    return payload.healthy;
  }

  if (typeof payload.ok === "boolean") {
    return payload.ok;
  }

  if (typeof status === "string" && /unhealthy|error|down|unavailable/i.test(status)) {
    return false;
  }

  return true;
}

async function getHealth(configOverride = null, options = {}) {
  return requestJson("/api/v1/health", {
    config: configOverride,
    ...options,
  });
}

async function getDiagnostics(configOverride = null) {
  return requestJson("/api/v1/diagnostics", { config: configOverride });
}

function isCompatibilityFallbackAllowed(error = {}) {
  const status = error.status || error.statusCode || error.payload?.error?.status || null;
  const code = String(error.code || error.payload?.error?.code || "").toUpperCase();
  if (status === 401 || status === 403) return false;
  if (["UNAUTHORIZED", "AUTHENTICATION_FAILED", "NODE_DISABLED", "NODE_NOT_FOUND", "FORBIDDEN", "PERMISSION_DENIED", "POLICY_DENIED"].includes(code)) return false;
  if (status === 404 || status === 405) return true;
  return /ENDPOINT_NOT_SUPPORTED|NOT_SUPPORTED|METHOD_NOT_ALLOWED|NOT_FOUND|CAPABILITY_MISSING/.test(code);
}

async function getSystemStats(configOverride = null) {
  try {
    return await requestJson("/api/v1/stats", {
      config: configOverride,
    });
  } catch (error) {
    if (!isCompatibilityFallbackAllowed(error)) {
      throw error;
    }
    console.warn("[AnxOS][Agent] Stats endpoint unavailable; falling back to system summary.", {
      message: error?.message || String(error),
      code: error?.code || null,
    });
    return requestJson("/api/v1/system/summary", {
      config: configOverride,
    });
  }
}

async function isHealthy(configOverride = null) {
  try {
    return isHealthyPayload(await getHealth(configOverride));
  } catch {
    return false;
  }
}

function normalizeNodeAgentPath(pathname) {
  const value = trimValue(pathname);
  if (!value) return "/api/v1/";
  if (/^https?:\/\//i.test(value)) {
    throw new AgentClientError("Agent node requests must use API paths, not absolute URLs.", {
      code: "AGENT_NODE_ABSOLUTE_URL",
    });
  }
  if (value.startsWith("/api/")) return value;
  return value.startsWith("/") ? `/api/v1${value}` : `/api/v1/${value}`;
}

function createNodeAgentError(message, details = {}) {
  return new AgentClientError(message, {
    status: details.status || null,
    code: details.code || null,
    details,
    payload: {
      error: {
        code: details.code || null,
        message,
        details: {
          nodeId: details.nodeId || null,
          nodeName: details.nodeName || null,
          nodeUrl: details.nodeUrl || null,
          targetLabel: details.targetLabel || null,
          endpoint: details.endpoint || null,
          operation: details.operation || null,
        },
      },
    },
  });
}

function getNodeService() {
  return require("./nodeService");
}

function resolveNodeAgentTarget(nodeId) {
  const requestedNodeId = trimValue(nodeId);
  if (!requestedNodeId) {
    throw createNodeAgentError("Select a node before contacting an Agent.", {
      code: "NODE_REQUIRED",
      operation: "resolve-node-agent",
    });
  }

  let node;
  try {
    node = getNodeService().getNode(requestedNodeId);
  } catch {
    throw createNodeAgentError("Node not found.", {
      code: "NODE_NOT_FOUND",
      nodeId: requestedNodeId,
      operation: "resolve-node-agent",
    });
  }

  const nodeName = node.displayName || node.name || node.id || requestedNodeId;
  const nodeUrl = node.baseUrl || node.agentUrl || null;
  if (node.kind !== "agent") {
    throw createNodeAgentError(`${nodeName} is not an Agent node.`, {
      code: "NODE_NOT_AGENT",
      nodeId: node.id || requestedNodeId,
      nodeName,
      nodeUrl,
      targetLabel: `node:${node.id || requestedNodeId}`,
      operation: "resolve-node-agent",
    });
  }

  if (node.enabled === false) {
    throw createNodeAgentError(`${nodeName} is disabled. Enable the node before sending Agent requests.`, {
      code: "NODE_DISABLED",
      nodeId: node.id || requestedNodeId,
      nodeName,
      nodeUrl,
      targetLabel: `node:${node.id || requestedNodeId}`,
      operation: "resolve-node-agent",
    });
  }

  const targetLabel = `node:${node.id}`;
  const config = getNodeService().getNodeAgentConfig(node.id);
  return {
    node: Object.freeze({
      id: node.id,
      displayName: node.displayName || node.name || node.id,
      agentUrl: nodeUrl,
      agentIdentity: { ...(node.agentIdentity || {}) },
    }),
    nodeId: node.id,
    nodeName,
    nodeUrl,
    targetLabel,
    config: {
      ...config,
      nodeId: node.id,
      nodeName,
      nodeUrl,
      targetLabel,
    },
  };
}

class NodeAgentClient {
  constructor(target) {
    this.target = target;
  }

  request(pathname, options = {}) {
    const endpoint = normalizeNodeAgentPath(pathname);
    return requestJson(endpoint, {
      ...options,
      config: this.target.config,
      targetLabel: this.target.config.targetLabel,
    }).catch((error) => {
      if (error instanceof AgentClientError) {
        throw createNodeAgentError(`${this.target.nodeName}: ${error.message}`, {
          status: error.status,
          code: error.code,
          nodeId: this.target.nodeId,
          nodeName: this.target.nodeName,
          nodeUrl: this.target.nodeUrl,
          targetLabel: this.target.targetLabel,
          endpoint,
          operation: options.method || "GET",
        });
      }
      throw error;
    });
  }

  get(pathname, options = {}) {
    return this.request(pathname, { ...options, method: "GET" });
  }

  post(pathname, body = null, options = {}) {
    return this.request(pathname, { ...options, method: "POST", body });
  }

  put(pathname, body = null, options = {}) {
    return this.request(pathname, { ...options, method: "PUT", body });
  }

  patch(pathname, body = null, options = {}) {
    return this.request(pathname, { ...options, method: "PATCH", body });
  }

  delete(pathname, options = {}) {
    return this.request(pathname, { ...options, method: "DELETE" });
  }

  listInstances() {
    return this.get("/instances");
  }

  createInstance(payload = {}) {
    return this.post("/instances", payload);
  }

  updateInstance(instanceId, payload = {}) {
    return this.patch(`/instances/${encodeInstanceId(instanceId)}`, payload);
  }

  renameInstance(instanceId, displayName) {
    return this.post(`/instances/${encodeInstanceId(instanceId)}/display-name`, { displayName });
  }

  duplicateInstance(instanceId, payload = {}) {
    return this.post(`/instances/${encodeInstanceId(instanceId)}/duplicate`, payload);
  }

  getInstanceStatus(instanceId) {
    return this.get(`/instances/${encodeInstanceId(instanceId)}/status`);
  }

  getInstanceMetrics(instanceId) {
    return this.get(`/instances/${encodeInstanceId(instanceId)}/metrics`);
  }

  getInstanceLogs(instanceId, options = {}) {
    const query = new URLSearchParams({
      stream: options.stream || "all",
      limit: String(options.limit || 200),
    });
    return this.get(`/instances/${encodeInstanceId(instanceId)}/logs?${query.toString()}`);
  }

  clearInstanceLogs(instanceId, options = {}) {
    const query = new URLSearchParams({
      stream: options.stream || "all",
    });
    return this.delete(`/instances/${encodeInstanceId(instanceId)}/logs?${query.toString()}`);
  }

  sendInstanceCommand(instanceId, command) {
    return this.post(`/instances/${encodeInstanceId(instanceId)}/command`, { command });
  }

  forceKillInstance(instanceId) {
    return this.post(`/instances/${encodeInstanceId(instanceId)}/force-kill`);
  }

  listInstanceFiles(instanceId, currentPath = ".") {
    const query = new URLSearchParams({ path: currentPath || "." });
    return this.get(`/instances/${encodeInstanceId(instanceId)}/files?${query.toString()}`);
  }

  readInstanceFile(instanceId, filePath) {
    const query = new URLSearchParams({ path: filePath || "." });
    return this.get(`/instances/${encodeInstanceId(instanceId)}/file?${query.toString()}`);
  }

  writeInstanceFile(instanceId, filePath, content, options = {}) {
    const request = () => this.put(`/instances/${encodeInstanceId(instanceId)}/file`, {
      path: filePath,
      content,
      encoding: options.encoding,
    }, { timeoutMs: FILE_WRITE_REQUEST_TIMEOUT_MS });
    return retryTransientFileWrite(request);
  }

  deleteInstanceFile(instanceId, filePath) {
    const query = new URLSearchParams({ path: filePath || "." });
    return this.delete(`/instances/${encodeInstanceId(instanceId)}/file?${query.toString()}`);
  }

  createInstanceFolder(instanceId, folderPath) {
    return this.post(`/instances/${encodeInstanceId(instanceId)}/mkdir`, { path: folderPath });
  }

  renameInstanceFile(instanceId, oldPath, newPath) {
    return this.post(`/instances/${encodeInstanceId(instanceId)}/rename`, { oldPath, newPath });
  }

  getMinecraftProperties(instanceId) {
    return this.get(`/instances/${encodeInstanceId(instanceId)}/minecraft/properties`);
  }

  getGameServerConfig(instanceId, options = {}) {
    const query = new URLSearchParams();
    if (options.adapterId) query.set("adapterId", options.adapterId);
    const suffix = query.toString() ? `?${query.toString()}` : "";
    return this.get(`/instances/${encodeInstanceId(instanceId)}/game-config${suffix}`);
  }

  saveGameServerConfig(instanceId, payload = {}) {
    return this.put(`/instances/${encodeInstanceId(instanceId)}/game-config`, payload);
  }

  saveMinecraftProperties(instanceId, properties = {}) {
    return this.put(`/instances/${encodeInstanceId(instanceId)}/minecraft/properties`, { properties });
  }

  getFiveMReadiness(instanceId) {
    return this.get(`/instances/${encodeInstanceId(instanceId)}/fivem/readiness`);
  }

  saveFiveMLicenseKey(instanceId, licenseKey) {
    return this.put(`/instances/${encodeInstanceId(instanceId)}/fivem/license-key`, { licenseKey });
  }

  startInstance(instanceId) {
    return this.post(`/instances/${encodeInstanceId(instanceId)}/start`);
  }

  beginInstallationSession(instanceId, payload = {}) {
    return this.post(`/instances/${encodeInstanceId(instanceId)}/installation/session`, payload);
  }

  beginSteamCmdUpdateSession(instanceId, payload = {}) { return this.post(`/instances/${encodeInstanceId(instanceId)}/steamcmd/update/session`, payload); }
  getSteamCmdUpdateStatus(instanceId, payload = {}) { return this.post(`/instances/${encodeInstanceId(instanceId)}/steamcmd/update/status`, payload); }
  repairLegacySteamCmdMetadata(instanceId) { return this.post(`/instances/${encodeInstanceId(instanceId)}/steamcmd/update/migrate`, {}); }
  executeSteamCmdUpdate(instanceId, payload = {}, timeoutMs = 610000) { return this.request(`/instances/${encodeInstanceId(instanceId)}/steamcmd/update`, { method: "POST", body: payload, timeoutMs }); }
  closeSteamCmdUpdateSession(instanceId, payload = {}) { return this.delete(`/instances/${encodeInstanceId(instanceId)}/steamcmd/update/session`, { body: payload }); }

  executeInstallationPhase(instanceId, payload = {}, timeoutMs = 310000) {
    return this.request(`/instances/${encodeInstanceId(instanceId)}/installation/execute`, { method: "POST", body: payload, timeoutMs });
  }

  repairNeoForgeRuntime(instanceId, payload = {}, timeoutMs = 310000) {
    return this.request(`/instances/${encodeInstanceId(instanceId)}/neoforge/repair-runtime`, { method: "POST", body: payload, timeoutMs });
  }

  cancelInstallationSession(instanceId, payload = {}) {
    return this.post(`/instances/${encodeInstanceId(instanceId)}/installation/cancel`, payload);
  }

  closeInstallationSession(instanceId, payload = {}) {
    return this.delete(`/instances/${encodeInstanceId(instanceId)}/installation/session`, { body: payload });
  }

  stopInstance(instanceId) {
    return this.post(`/instances/${encodeInstanceId(instanceId)}/stop`);
  }

  restartInstance(instanceId) {
    return this.post(`/instances/${encodeInstanceId(instanceId)}/restart`);
  }

  deleteInstance(instanceId) {
    return this.delete(`/instances/${encodeInstanceId(instanceId)}`);
  }

  forgetInstance(instanceId) {
    return this.delete(`/instances/${encodeInstanceId(instanceId)}/record`);
  }
}

function forNode(nodeId) {
  return new NodeAgentClient(resolveNodeAgentTarget(nodeId));
}

async function requestBuffer(pathname, options = {}) {
  const {
    config: configOverride = null,
    method = "GET",
    body = null,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = options;
  const config = getAgentConfig(configOverride);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || REQUEST_TIMEOUT_MS));

  try {
    const headers = {
      Accept: "application/octet-stream, application/json",
    };

    if (config.token) {
      headers.Authorization = `Bearer ${config.token}`;
    }

    if (body !== null) {
      headers["Content-Type"] = "application/json";
    }

    const requestUrl = buildAgentUrl(pathname, configOverride);
    const response = await fetch(requestUrl, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const contentType = response.headers.get("content-type") || "";
    const buffer = Buffer.from(await response.arrayBuffer());

    if (!response.ok) {
      const payload = parseAgentPayload(buffer, contentType);
      const responseErrorCode = getAgentPayloadErrorCode(payload);
      const message = getAgentHttpErrorMessage(response.status, responseErrorCode, payload);
      const error = new AgentClientError(message, {
        status: response.status,
        code: responseErrorCode,
        payload,
      });
      logAgentRequestFailure(pathname, response.status, responseErrorCode, {
        url: requestUrl,
        method,
        responseBody: response.status === 401 || ["UNAUTHORIZED", "AGENT_TOKEN_MISSING"].includes(responseErrorCode)
          ? "[redacted authentication response]"
          : typeof payload === "string" ? payload : JSON.stringify(payload),
        message: error.message,
      });
      throw error;
    }

    return {
      buffer,
      contentType,
      headers: Object.fromEntries(response.headers.entries()),
    };
  } catch (error) {
    if (error instanceof AgentClientError) {
      throw error;
    }

    const errorCode = error?.name === "AbortError"
      ? "AGENT_TIMEOUT"
      : getTransportErrorCode(error) || "AGENT_UNAVAILABLE";
    const requestUrl = (() => {
      try {
        return buildAgentUrl(pathname, configOverride);
      } catch (urlError) {
        return urlError?.payload?.error?.details?.invalidUrl || null;
      }
    })();
    const transportMessage = getAgentTransportErrorMessage(errorCode, requestUrl);
    logAgentRequestFailure(pathname, null, errorCode, {
      url: requestUrl,
      method,
      message: transportMessage,
      originalMessage: error?.message || null,
      causeCode: error?.cause?.code || error?.code || null,
    });
    throw new AgentClientError(transportMessage, {
      code: errorCode,
      payload: {
        error: {
          code: errorCode,
          message: transportMessage,
          details: {
            name: error?.name || null,
            message: transportMessage,
            originalMessage: error?.message || null,
            causeCode: error?.cause?.code || error?.code || null,
            url: requestUrl,
            payload: error?.payload || null,
          },
        },
      },
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestStream(pathname, options = {}) {
  const {
    config: configOverride = null,
    method = "GET",
    body = null,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = options;
  const config = getAgentConfig(configOverride);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || REQUEST_TIMEOUT_MS));
  let streamReturned = false;

  try {
    const headers = {
      Accept: "application/octet-stream, application/json",
    };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    if (body !== null) headers["Content-Type"] = "application/json";

    const requestUrl = buildAgentUrl(pathname, configOverride);
    const response = await fetch(requestUrl, {
      method,
      headers,
      body: body === null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      const payload = parseAgentPayload(buffer, contentType);
      const responseErrorCode = getAgentPayloadErrorCode(payload);
      const message = getAgentHttpErrorMessage(response.status, responseErrorCode, payload);
      throw new AgentClientError(message, {
        status: response.status,
        code: responseErrorCode,
        payload,
      });
    }
    if (!response.body) {
      throw new AgentClientError("Agent returned an empty download stream.", {
        code: "AGENT_EMPTY_RESPONSE",
      });
    }

    const stream = Readable.fromWeb(response.body);
    const clearRequestTimeout = () => clearTimeout(timeout);
    stream.once("end", clearRequestTimeout);
    stream.once("error", clearRequestTimeout);
    stream.once("close", clearRequestTimeout);
    streamReturned = true;
    return {
      stream,
      contentType,
      headers: Object.fromEntries(response.headers.entries()),
    };
  } catch (error) {
    if (error instanceof AgentClientError) throw error;
    const errorCode = error?.name === "AbortError"
      ? "AGENT_TIMEOUT"
      : getTransportErrorCode(error) || "AGENT_UNAVAILABLE";
    const requestUrl = (() => {
      try {
        return buildAgentUrl(pathname, configOverride);
      } catch (urlError) {
        return urlError?.payload?.error?.details?.invalidUrl || null;
      }
    })();
    const transportMessage = getAgentTransportErrorMessage(errorCode, requestUrl);
    throw new AgentClientError(transportMessage, {
      code: errorCode,
      payload: {
        error: {
          code: errorCode,
          message: transportMessage,
          details: {
            name: error?.name || null,
            originalMessage: error?.message || null,
            causeCode: error?.cause?.code || error?.code || null,
            url: requestUrl,
          },
        },
      },
    });
  } finally {
    if (!streamReturned) clearTimeout(timeout);
  }
}

async function testConnection(configOverride = null) {
  const checkedAt = new Date().toISOString();
  const config = getAgentConfig(configOverride);

  try {
    const payload = await getHealth(configOverride);
    const connected = isHealthyPayload(payload);
    const localFingerprint = config.token ? tokenFingerprint(config.token) : null;
    const remoteFingerprint = payload?.tokenFingerprint || null;
    if (connected) {
      try {
        await getSystemStats(configOverride);
      } catch (protectedError) {
        const mismatchDetail = protectedError?.code === "UNAUTHORIZED" && remoteFingerprint
          ? ` Desktop fingerprint ${localFingerprint || "not configured"} does not match running Agent fingerprint ${remoteFingerprint}.`
          : "";
        return {
          connected: false,
          status: protectedError?.code === "UNAUTHORIZED" ? "token-mismatch" : "disconnected",
          message: `${protectedError?.message || "Agent protected endpoint check failed."}${mismatchDetail}`,
          checkedAt,
          url: config.url,
          health: payload,
          code: protectedError?.code || null,
          fingerprint: localFingerprint,
          remoteFingerprint,
          repairAvailable: protectedError?.code === "UNAUTHORIZED",
        };
      }
    }

    return {
      connected,
      status: connected ? "connected" : "disconnected",
      message: connected ? "Connected to the Agent." : "Agent health check reported a disconnected state.",
      checkedAt,
      url: config.url,
      health: payload,
      fingerprint: localFingerprint,
      remoteFingerprint,
    };
  } catch (error) {
    return {
      connected: false,
      status: "disconnected",
      message: error?.message || "Agent unavailable.",
      checkedAt,
      url: config.url,
      health: null,
      code: error?.code || null,
      fingerprint: config.token ? tokenFingerprint(config.token) : null,
      remoteFingerprint: null,
      repairAvailable: error?.code === "UNAUTHORIZED",
    };
  }
}

async function getDockerSummary() {
  return requestJson("/api/v1/docker/summary", { timeoutMs: DOCKER_REQUEST_TIMEOUT_MS });
}

async function getDockerCapabilities(configOverride = null) {
  return requestJson("/api/v1/docker/capabilities", { config: configOverride, timeoutMs: DOCKER_REQUEST_TIMEOUT_MS });
}

async function getDockerContainers(configOverride = null) {
  return requestJson("/api/v1/docker/containers", { config: configOverride, timeoutMs: DOCKER_REQUEST_TIMEOUT_MS });
}

async function getDockerSnapshot(configOverride = null) {
  const payload = await requestJson("/api/v1/docker/snapshot", { config: configOverride, timeoutMs: DOCKER_REQUEST_TIMEOUT_MS });
  const containers = normalizeContainers(payload);

  return {
    ...normalizeSummary(payload, containers),
    containers,
  };
}

async function createDockerContainer(payload = {}, configOverride = null) {
  return requestJson("/api/v1/docker/containers", {
    config: configOverride,
    method: "POST",
    body: payload,
  });
}

async function inspectDockerContainer(container, configOverride = null) {
  return requestJson(`/api/v1/docker/containers/${encodeURIComponent(String(container || ""))}/inspect`, {
    config: configOverride,
  });
}

async function listDockerImages(configOverride = null) {
  return requestJson("/api/v1/docker/images", { config: configOverride, timeoutMs: DOCKER_REQUEST_TIMEOUT_MS });
}

async function deleteDockerImage(image, configOverride = null) {
  return requestJson(`/api/v1/docker/images/${encodeURIComponent(String(image || ""))}`, {
    config: configOverride,
    method: "DELETE",
  });
}

async function pullDockerImage(image, configOverride = null) {
  return requestJson("/api/v1/docker/images/pull", {
    config: configOverride,
    method: "POST",
    body: { image },
    timeoutMs: 10 * 60 * 1000,
  });
}

async function inspectDockerImage(image, configOverride = null) {
  return requestJson(`/api/v1/docker/images/${encodeURIComponent(String(image || ""))}`, { config: configOverride });
}

async function pruneDockerImages(configOverride = null) {
  return requestJson("/api/v1/docker/images/prune", { config: configOverride, method: "POST", timeoutMs: 120000 });
}

async function listDockerNetworks(configOverride = null) {
  return requestJson("/api/v1/docker/networks", { config: configOverride, timeoutMs: DOCKER_REQUEST_TIMEOUT_MS });
}

async function listDockerVolumes(configOverride = null) {
  return requestJson("/api/v1/docker/volumes", { config: configOverride, timeoutMs: DOCKER_REQUEST_TIMEOUT_MS });
}

async function dockerPost(path, payload = {}, configOverride = null, timeoutMs = DOCKER_REQUEST_TIMEOUT_MS) {
  return requestJson(path, { config: configOverride, method: "POST", body: payload, timeoutMs });
}

async function startDockerContainer(container, configOverride = null) {
  return requestJson(`/api/v1/docker/containers/${encodeURIComponent(String(container || ""))}/start`, {
    config: configOverride,
    method: "POST",
  });
}

async function stopDockerContainer(container, configOverride = null) {
  return requestJson(`/api/v1/docker/containers/${encodeURIComponent(String(container || ""))}/stop`, {
    config: configOverride,
    method: "POST",
  });
}

async function restartDockerContainer(container, configOverride = null) {
  return requestJson(`/api/v1/docker/containers/${encodeURIComponent(String(container || ""))}/restart`, {
    config: configOverride,
    method: "POST",
  });
}

async function pauseDockerContainer(container, configOverride = null) {
  return requestJson(`/api/v1/docker/containers/${encodeURIComponent(String(container || ""))}/pause`, { config: configOverride, method: "POST" });
}

async function unpauseDockerContainer(container, configOverride = null) {
  return requestJson(`/api/v1/docker/containers/${encodeURIComponent(String(container || ""))}/unpause`, { config: configOverride, method: "POST" });
}

async function killDockerContainer(container, configOverride = null) {
  return requestJson(`/api/v1/docker/containers/${encodeURIComponent(String(container || ""))}/kill`, { config: configOverride, method: "POST" });
}

async function renameDockerContainer(container, name, configOverride = null) {
  return requestJson(`/api/v1/docker/containers/${encodeURIComponent(String(container || ""))}/rename`, { config: configOverride, method: "POST", body: { name } });
}

async function execDockerContainer(container, payload = {}, configOverride = null) {
  return requestJson(`/api/v1/docker/containers/${encodeURIComponent(String(container || ""))}/exec`, { config: configOverride, method: "POST", body: payload, timeoutMs: DOCKER_REQUEST_TIMEOUT_MS });
}

async function deleteDockerContainer(container, configOverride = null) {
  return requestJson(`/api/v1/docker/containers/${encodeURIComponent(String(container || ""))}`, {
    config: configOverride,
    method: "DELETE",
  });
}

async function getDockerContainerLogs(container, options = {}, configOverride = null) {
  const query = new URLSearchParams({ tail: String(options.tail || 200) });
  if (options.timestamps === true || options.timestamps === "true") query.set("timestamps", "true");
  return requestJson(`/api/v1/docker/containers/${encodeURIComponent(String(container || ""))}/logs?${query.toString()}`, {
    config: configOverride,
  });
}

async function getDockerContainerStats(container, configOverride = null) {
  return requestJson(`/api/v1/docker/containers/${encodeURIComponent(String(container || ""))}/stats`, {
    config: configOverride,
    timeoutMs: DOCKER_REQUEST_TIMEOUT_MS,
  });
}

async function inspectDockerVolume(volume, configOverride = null) {
  return requestJson(`/api/v1/docker/volumes/${encodeURIComponent(String(volume || ""))}/inspect`, { config: configOverride });
}

async function removeDockerVolume(volume, configOverride = null) {
  return requestJson(`/api/v1/docker/volumes/${encodeURIComponent(String(volume || ""))}`, { config: configOverride, method: "DELETE" });
}

async function pruneDockerVolumes(configOverride = null) {
  return requestJson("/api/v1/docker/volumes/prune", { config: configOverride, method: "POST", timeoutMs: 120000 });
}

async function inspectDockerNetwork(network, configOverride = null) {
  return requestJson(`/api/v1/docker/networks/${encodeURIComponent(String(network || ""))}/inspect`, { config: configOverride });
}

async function createDockerNetwork(payload = {}, configOverride = null) {
  return dockerPost("/api/v1/docker/networks", payload, configOverride);
}

async function removeDockerNetwork(network, configOverride = null) {
  return requestJson(`/api/v1/docker/networks/${encodeURIComponent(String(network || ""))}`, { config: configOverride, method: "DELETE" });
}

async function connectDockerNetwork(network, container, configOverride = null) {
  return dockerPost(`/api/v1/docker/networks/${encodeURIComponent(String(network || ""))}/connect`, { container }, configOverride);
}

async function disconnectDockerNetwork(network, container, configOverride = null) {
  return dockerPost(`/api/v1/docker/networks/${encodeURIComponent(String(network || ""))}/disconnect`, { container }, configOverride);
}

async function pruneDockerNetworks(configOverride = null) {
  return requestJson("/api/v1/docker/networks/prune", { config: configOverride, method: "POST", timeoutMs: 120000 });
}

async function listDockerComposeProjects(configOverride = null) {
  return requestJson("/api/v1/docker/compose/projects", { config: configOverride, timeoutMs: DOCKER_REQUEST_TIMEOUT_MS });
}

async function dockerComposeAction(action, payload = {}, configOverride = null) {
  return dockerPost(`/api/v1/docker/compose/${action}`, payload, configOverride, 20 * 60 * 1000);
}

async function getDockerCleanupPreview(configOverride = null) {
  return requestJson("/api/v1/docker/cleanup/preview", { config: configOverride, timeoutMs: DOCKER_REQUEST_TIMEOUT_MS });
}

async function runDockerCleanup(payload = {}, configOverride = null) {
  return dockerPost("/api/v1/docker/cleanup", payload, configOverride, 10 * 60 * 1000);
}

function normalizePlayitSnapshot(payload) {
  const snapshot = unwrapPayload(payload, "snapshot");
  const candidate =
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
      ? snapshot
      : payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : {};

  return {
    installed: candidate.installed ?? false,
    running: candidate.running ?? false,
    connected: candidate.connected === true ? true : candidate.connected === false ? false : null,
    tunnelAddress: candidate.tunnelAddress || null,
    tunnelDomain: candidate.tunnelDomain || (candidate.tunnelAddress ? String(candidate.tunnelAddress).split(":")[0] : null),
    localTarget: candidate.localTarget || null,
    localIp: candidate.localIp || null,
    localPort: candidate.localPort || null,
    protocol: candidate.protocol || null,
    tunnelId: candidate.tunnelId || null,
    lastCheckedAt: candidate.lastCheckedAt || new Date().toISOString(),
    lastSuccessfulRefreshAt: candidate.lastSuccessfulRefreshAt || null,
    diagnostics: candidate.diagnostics && typeof candidate.diagnostics === "object"
      ? {
          ...candidate.diagnostics,
          agent: {
            url: getAgentConfig().url,
          },
        }
      : {
          agent: {
            url: getAgentConfig().url,
          },
        },
  };
}

async function getPlayitStatus(configOverride = null) {
  return requestJson("/api/v1/playit/status", {
    config: configOverride,
  });
}

async function getPlayitSnapshot(configOverride = null) {
  return normalizePlayitSnapshot(await requestJson("/api/v1/playit/snapshot", {
    config: configOverride,
  }));
}

async function getPublicAccessSnapshot(configOverride = null) {
  return requestJson("/api/v1/public-access/snapshot", {
    config: configOverride,
    timeoutMs: PUBLIC_ACCESS_REQUEST_TIMEOUT_MS,
  });
}

async function getPublicAccessPlayitStatus(configOverride = null) {
  return requestJson("/api/v1/public-access/playit/status", {
    config: configOverride,
    timeoutMs: PUBLIC_ACCESS_REQUEST_TIMEOUT_MS,
  });
}

async function controlPublicAccessPlayit(action, configOverride = null) {
  return requestJson(`/api/v1/public-access/playit/${encodeURIComponent(String(action || ""))}`, {
    config: configOverride,
    method: "POST",
    body: {},
    timeoutMs: PUBLIC_ACCESS_REQUEST_TIMEOUT_MS,
  });
}

async function getPublicAccessPlayitLogs(payload = {}, configOverride = null) {
  const query = new URLSearchParams();
  if (payload.limit) query.set("limit", String(payload.limit));
  return requestJson(`/api/v1/public-access/playit/logs${query.toString() ? `?${query.toString()}` : ""}`, {
    config: configOverride,
    timeoutMs: PUBLIC_ACCESS_REQUEST_TIMEOUT_MS,
  });
}

async function getPublicAccessPlayitTunnels(payload = {}, configOverride = null) {
  const query = payload.nodeId ? `?nodeId=${encodeURIComponent(payload.nodeId)}` : "";
  return requestJson(`/api/v1/public-access/playit/tunnels${query}`, {
    config: configOverride,
    timeoutMs: PUBLIC_ACCESS_REQUEST_TIMEOUT_MS,
  });
}

async function listPublicAccessServices(payload = {}, configOverride = null) {
  const query = payload.nodeId ? `?nodeId=${encodeURIComponent(payload.nodeId)}` : "";
  return requestJson(`/api/v1/public-access/services${query}`, {
    config: configOverride,
  });
}

async function createPublicAccessService(payload = {}, configOverride = null) {
  return requestJson("/api/v1/public-access/services", {
    config: configOverride,
    method: "POST",
    body: payload,
  });
}

async function deletePublicAccessService(serviceId, configOverride = null) {
  return requestJson(`/api/v1/public-access/services/${encodeURIComponent(String(serviceId || ""))}`, {
    config: configOverride,
    method: "DELETE",
  });
}

function safeNumber(value) {
  if (value === null || value === undefined || typeof value === "boolean" || value === "" || Array.isArray(value)) {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePercent(value) {
  const number = safeNumber(value);
  if (number === null) {
    return null;
  }

  return number <= 1 ? number * 100 : number;
}

function parseDurationSeconds(value) {
  if (typeof value !== "string") {
    return safeNumber(value);
  }

  const parts = value.split(":").map((part) => safeNumber(part));

  if (parts.some((part) => part === null)) {
    return safeNumber(value);
  }

  if (parts.length === 4) {
    const [days, hours, minutes, seconds] = parts;
    return days * 86400 + hours * 3600 + minutes * 60 + seconds;
  }

  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return hours * 3600 + minutes * 60 + seconds;
  }

  return safeNumber(value);
}

function findAmpValue(source, keys) {
  if (!source || typeof source !== "object") {
    return null;
  }

  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) {
      return source[key];
    }
  }

  return null;
}

function hasAnyAmpKey(value, keys) {
  if (!value || typeof value !== "object") {
    return false;
  }

  return keys.some((key) => value[key] !== undefined && value[key] !== null);
}

function unwrapAmpResult(value) {
  if (value && typeof value === "object" && Object.keys(value).length === 1 && value.result !== undefined) {
    return value.result;
  }

  return value;
}

function asAmpArray(value) {
  const unwrapped = unwrapAmpResult(value);

  if (Array.isArray(unwrapped)) {
    return unwrapped;
  }

  if (!unwrapped || typeof unwrapped !== "object") {
    return [];
  }

  const preferredKeys = [
    "instances",
    "Instances",
    "AvailableInstances",
    "minecraftInstances",
    "data",
    "result",
    "Result",
  ];

  for (const key of preferredKeys) {
    if (unwrapped[key] !== undefined && unwrapped[key] !== unwrapped) {
      const nested = asAmpArray(unwrapped[key]);

      if (nested.length > 0) {
        return nested;
      }
    }
  }

  if (
    hasAnyAmpKey(unwrapped, [
      "id",
      "Id",
      "ID",
      "InstanceID",
      "InstanceId",
      "name",
      "Name",
      "FriendlyName",
      "Module",
      "ModuleName",
      "ApplicationModule",
    ])
  ) {
    return [unwrapped];
  }

  return Object.entries(unwrapped)
    .filter(([, item]) => item && typeof item === "object")
    .map(([mapKey, item]) => ({ mapKey, ...item }));
}

function getAmpInstanceId(instance) {
  return findAmpValue(instance, ["id", "Id", "ID", "InstanceID", "InstanceId", "InstanceIdString", "Guid", "mapKey"]);
}

function getAmpModuleType(instance) {
  return findAmpValue(instance, ["moduleType", "Module", "ModuleName", "ApplicationModule", "AppModule", "Application"]) || "Unknown";
}

function getAmpInstanceName(instance) {
  return findAmpValue(instance, ["name", "Name", "InstanceName", "FriendlyName", "DisplayName", "Description"]) || "AMP Instance";
}

function isAmpMinecraftInstance(instance) {
  const searchable = [
    getAmpInstanceName(instance),
    getAmpModuleType(instance),
    findAmpValue(instance, ["Target", "Type", "Application", "ApplicationName"]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return searchable.includes("minecraft") || searchable.includes("mc") || searchable.includes("atm10");
}

function normalizeAmpPorts(value) {
  if (Array.isArray(value)) {
    return value
      .map((port) => {
        if (typeof port === "number" || typeof port === "string") {
          return String(port);
        }

        if (!port || typeof port !== "object") {
          return null;
        }

        const number = findAmpValue(port, ["Port", "port", "HostPort", "ContainerPort", "PublicPort"]);
        const protocol = findAmpValue(port, ["Protocol", "protocol"]);
        return number ? `${number}${protocol ? `/${protocol}` : ""}` : null;
      })
      .filter(Boolean);
  }

  if (value && typeof value === "object") {
    return Object.values(value)
      .map((port) => (typeof port === "object" ? findAmpValue(port, ["Port", "port", "HostPort", "PublicPort"]) : port))
      .filter((port) => port !== null && port !== undefined)
      .map(String);
  }

  const singlePort = safeNumber(value);
  return singlePort === null ? [] : [String(singlePort)];
}

function normalizeAmpInstance(instance) {
  if (!instance || typeof instance !== "object") {
    return null;
  }

  const state =
    findAmpValue(instance, ["state", "State", "Status", "ApplicationState", "DaemonState", "AppState", "InstanceState"]) ||
    "Unknown";

  return {
    id: getAmpInstanceId(instance) || getAmpInstanceName(instance),
    name: getAmpInstanceName(instance),
    friendlyName: findAmpValue(instance, ["friendlyName", "FriendlyName"]),
    moduleType: getAmpModuleType(instance),
    isMinecraft: isAmpMinecraftInstance(instance),
    state,
    playerCount: safeNumber(findAmpValue(instance, [
      "playerCount",
      "Players",
      "PlayerCount",
      "CurrentPlayers",
      "ActiveUsers",
      "UsersOnline",
      "OnlinePlayers",
      "PlayersOnline",
    ])),
    maxPlayers: safeNumber(findAmpValue(instance, ["maxPlayers", "MaxPlayers", "MaximumPlayers", "PlayerLimit", "MaxUsers"])),
    tps: safeNumber(findAmpValue(instance, ["tps", "TPS", "TicksPerSecond", "ServerTPS", "CurrentTPS"])),
    cpuUsage: normalizePercent(findAmpValue(instance, ["cpuUsage", "CPUUsage", "CpuUsage", "CPU", "ProcessorUsage", "PercentCPU"])),
    ramUsage: safeNumber(findAmpValue(instance, [
      "ramUsage",
      "MemoryUsageMB",
      "MemoryMB",
      "MemoryUsage",
      "RAMUsage",
      "UsedMemory",
      "Memory",
      "MemUsageMB",
    ])),
    ports: normalizeAmpPorts(findAmpValue(instance, ["ports", "Ports", "Port", "PortMappings", "ApplicationEndpoints", "NetworkPorts", "Endpoint", "Endpoints"])),
    uptime: parseDurationSeconds(findAmpValue(instance, ["uptime", "Uptime", "UptimeSeconds", "RunningSeconds", "StartedFor", "UptimeSec"])),
    version: findAmpValue(instance, [
      "version",
      "Version",
      "AppVersion",
      "ApplicationVersion",
      "ServerVersion",
      "MinecraftVersion",
      "ProductVersion",
      "ReleaseStream",
      "Build",
    ]),
  };
}

function getAmpSummaryCandidate(payload) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const hasTopLevelStatus =
      payload.connected !== undefined ||
      payload.configured !== undefined ||
      payload.status !== undefined ||
      payload.message !== undefined ||
      payload.connection !== undefined ||
      payload.diagnostics !== undefined;

    if (hasTopLevelStatus) {
      return payload;
    }
  }

  const unwrapped = unwrapPayload(payload, "summary");
  return unwrapped && typeof unwrapped === "object" && !Array.isArray(unwrapped)
    ? unwrapped
    : payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};
}

function hasAmpDataEvidence(instances, selectedInstance, summary) {
  if (Array.isArray(instances) && instances.length > 0) {
    return true;
  }

  if (selectedInstance && typeof selectedInstance === "object") {
    return true;
  }

  if (!summary || typeof summary !== "object") {
    return false;
  }

  return [
    summary.playerCount,
    summary.maxPlayers,
    summary.tps,
    summary.cpuUsage,
    summary.ramUsage,
    summary.uptime,
  ].some((value) => Number.isFinite(value)) || Boolean(summary.version) || (Array.isArray(summary.ports) && summary.ports.length > 0);
}

function selectAmpMinecraftInstance(instances) {
  const minecraftInstances = instances.filter((instance) => instance.isMinecraft);

  return {
    selected: minecraftInstances.length === 1 ? minecraftInstances[0] : null,
    minecraftInstances,
    mode: minecraftInstances.length === 0 ? "none" : minecraftInstances.length === 1 ? "auto" : "multiple",
  };
}

function summarizeAmpInstances(instances, summaryCandidate, selectedInstance, minecraftSelectionMode) {
  if (summaryCandidate && typeof summaryCandidate === "object" && summaryCandidate.selectedInstanceName !== undefined) {
    return {
      selectedInstanceId: summaryCandidate.selectedInstanceId || selectedInstance?.id || null,
      selectedInstanceName: summaryCandidate.selectedInstanceName || selectedInstance?.name || null,
      minecraftInstanceCount: coerceNumber(summaryCandidate.minecraftInstanceCount, instances.filter((instance) => instance.isMinecraft).length),
      minecraftSelectionMode: summaryCandidate.minecraftSelectionMode || minecraftSelectionMode,
      state: summaryCandidate.state || null,
      playerCount: safeNumber(summaryCandidate.playerCount),
      maxPlayers: safeNumber(summaryCandidate.maxPlayers),
      tps: safeNumber(summaryCandidate.tps),
      cpuUsage: normalizePercent(summaryCandidate.cpuUsage),
      ramUsage: safeNumber(summaryCandidate.ramUsage),
      ports: Array.isArray(summaryCandidate.ports) ? summaryCandidate.ports.map(String) : [],
      uptime: parseDurationSeconds(summaryCandidate.uptime),
      version: summaryCandidate.version || null,
    };
  }

  if (instances.length === 0) {
    return {
      selectedInstanceId: null,
      selectedInstanceName: null,
      minecraftInstanceCount: 0,
      minecraftSelectionMode,
      state: "No instances",
      playerCount: null,
      maxPlayers: null,
      tps: null,
      cpuUsage: null,
      ramUsage: null,
      ports: [],
      uptime: null,
      version: null,
    };
  }

  const primary = selectedInstance || instances[0];
  const scopedInstances = selectedInstance ? [selectedInstance] : instances;
  const playerValues = scopedInstances.map((instance) => instance.playerCount).filter(Number.isFinite);
  const cpuValues = scopedInstances.map((instance) => instance.cpuUsage).filter(Number.isFinite);
  const ramValues = scopedInstances.map((instance) => instance.ramUsage).filter(Number.isFinite);
  const tpsValues = scopedInstances.map((instance) => instance.tps).filter(Number.isFinite);

  return {
    selectedInstanceId: selectedInstance?.id || null,
    selectedInstanceName: selectedInstance?.name || null,
    minecraftInstanceCount: instances.filter((instance) => instance.isMinecraft).length,
    minecraftSelectionMode,
    state: primary.state,
    playerCount: playerValues.length > 0 ? playerValues.reduce((total, value) => total + value, 0) : null,
    maxPlayers: primary.maxPlayers,
    tps: tpsValues.length > 0 ? tpsValues[0] : null,
    cpuUsage: cpuValues.length > 0 ? cpuValues.reduce((sum, value) => sum + value, 0) : null,
    ramUsage: ramValues.length > 0 ? ramValues.reduce((sum, value) => sum + value, 0) : null,
    ports: primary.ports || [],
    uptime: primary.uptime,
    version: primary.version || null,
  };
}

function getAmpStatusMessage(status, connected) {
  if (connected || status === "connected") {
    return "Connected to AMP.";
  }

  if (status === "auth_failed") {
    return "AMP authentication failed.";
  }

  if (status === "unconfigured") {
    return "AMP is not configured.";
  }

  return "AMP unavailable.";
}

function getAmpConnectionLabel(status) {
  if (status === "connected") {
    return "Connected";
  }

  if (status === "auth_failed") {
    return "Auth failed";
  }

  if (status === "unreachable" || status === "error") {
    return "Unreachable";
  }

  if (status === "unconfigured") {
    return "Unconfigured";
  }

  return "Unavailable";
}

function normalizeAmpSnapshot(statusPayload, instancesPayload) {
  const statusCandidate = getAmpSummaryCandidate(statusPayload);
  const summaryCandidate = unwrapPayload(statusPayload, "summary");
  const instanceRows = asAmpArray(unwrapPayload(instancesPayload, "instances"));
  const normalizedInstances = instanceRows.map(normalizeAmpInstance).filter(Boolean);
  const explicitSelected = statusCandidate.selectedInstance ? normalizeAmpInstance(statusCandidate.selectedInstance) : null;
  const selection = selectAmpMinecraftInstance(normalizedInstances);
  const selectedInstance =
    explicitSelected ||
    normalizedInstances.find((instance) => instance.name === statusCandidate.summary?.selectedInstanceName) ||
    normalizedInstances.find((instance) => instance.id === statusCandidate.summary?.selectedInstanceId) ||
    selection.selected ||
    null;
  const minecraftInstances = Array.isArray(statusCandidate.minecraftInstances)
    ? statusCandidate.minecraftInstances.map(normalizeAmpInstance).filter(Boolean)
    : selection.minecraftInstances;
  const configured = typeof statusCandidate.configured === "boolean" ? statusCandidate.configured : true;
  const connected = typeof statusCandidate.connected === "boolean" ? statusCandidate.connected : coerceBoolean(statusCandidate.status, false);
  const rawStatus = statusCandidate.status || (connected ? "connected" : "unreachable");
  const diagnostics = statusCandidate.diagnostics && typeof statusCandidate.diagnostics === "object"
    ? {
        ...statusCandidate.diagnostics,
        agent: {
          url: getAgentConfig().url,
        },
      }
    : {
        agent: {
          url: getAgentConfig().url,
        },
      };
  const summary = summarizeAmpInstances(
    normalizedInstances,
    summaryCandidate && typeof summaryCandidate === "object" && !Array.isArray(summaryCandidate) ? summaryCandidate : statusCandidate.summary || statusCandidate,
    selectedInstance,
    statusCandidate.minecraftSelectionMode || selection.mode,
  );
  const derivedConnected =
    hasAmpDataEvidence(normalizedInstances, selectedInstance, summary) &&
    rawStatus !== "auth_failed" &&
    rawStatus !== "unconfigured";
  const effectiveConnected = connected || derivedConnected;
  const status = effectiveConnected ? "connected" : rawStatus;
  const message = effectiveConnected ? "Connected to AMP." : statusCandidate.message || getAmpStatusMessage(status, connected);
  const connection = statusCandidate.connection && typeof statusCandidate.connection === "object"
    ? {
        ...statusCandidate.connection,
        status,
        label: getAmpConnectionLabel(status),
        message: effectiveConnected ? "Connected to AMP." : statusCandidate.connection.message || message,
        connected: effectiveConnected,
        unreachable: !effectiveConnected && (status === "unreachable" || status === "error"),
        authFailed: !effectiveConnected && status === "auth_failed",
      }
    : {
        status,
        label: getAmpConnectionLabel(status),
        message,
        connected: effectiveConnected,
        unreachable: !effectiveConnected && (status === "unreachable" || status === "error"),
        authFailed: !effectiveConnected && status === "auth_failed",
        diagnostics,
      };

  return {
    connected: effectiveConnected,
    configured,
    status,
    message,
    diagnostics,
    connection,
    instanceCount: coerceNumber(statusCandidate.instanceCount, normalizedInstances.length),
    instances: normalizedInstances,
    selectedInstance,
    minecraftInstances,
    minecraftSelectionMode: statusCandidate.minecraftSelectionMode || selection.mode,
    playerCount: summary.playerCount ?? null,
    maxPlayers: summary.maxPlayers ?? null,
    tps: summary.tps ?? null,
    cpuUsage: summary.cpuUsage ?? null,
    ramUsage: summary.ramUsage ?? null,
    uptime: summary.uptime ?? null,
    minecraft: statusCandidate.minecraft && typeof statusCandidate.minecraft === "object"
      ? statusCandidate.minecraft
      : {
          selectedInstanceId: summary.selectedInstanceId || null,
          selectedInstanceName: summary.selectedInstanceName || null,
          instanceCount: summary.minecraftInstanceCount || 0,
          selectionMode: summary.minecraftSelectionMode || statusCandidate.minecraftSelectionMode || selection.mode,
          state: summary.state || null,
          playerCount: summary.playerCount ?? null,
          maxPlayers: summary.maxPlayers ?? null,
          tps: summary.tps ?? null,
          cpuUsage: summary.cpuUsage ?? null,
          ramUsage: summary.ramUsage ?? null,
          uptime: summary.uptime ?? null,
          version: summary.version || null,
          ports: summary.ports || [],
        },
    poll: statusCandidate.poll && typeof statusCandidate.poll === "object"
      ? statusCandidate.poll
      : {
          sequence: null,
          lastSuccessfulPollAt: null,
          status,
          instanceCount: normalizedInstances.length,
        },
    summary,
  };
}

async function getAmpStatus(configOverride = null) {
  return requestJson("/api/v1/amp/status", {
    config: configOverride,
  });
}

async function getAmpInstances(configOverride = null) {
  return requestJson("/api/v1/amp/instances", {
    config: configOverride,
  });
}

async function getAmpSnapshot(configOverride = null) {
  const payload = await requestJson("/api/v1/amp/snapshot", {
    config: configOverride,
  });
  return normalizeAmpSnapshot(payload, payload);
}

function normalizePathSegments(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function getBaseName(value) {
  const segments = normalizePathSegments(value);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

function normalizeFileType(entry) {
  const explicitType = trimValue(findAmpValue(entry, ["type", "Type", "kind", "Kind", "entryType", "EntryType"]));

  if (explicitType) {
    if (/dir/i.test(explicitType)) {
      return "directory";
    }

    if (/file/i.test(explicitType)) {
      return "file";
    }

    return explicitType.toLowerCase();
  }

  if (coerceBoolean(findAmpValue(entry, ["isDirectory", "IsDirectory", "directory", "Directory"]), false)) {
    return "directory";
  }

  if (coerceBoolean(findAmpValue(entry, ["isFile", "IsFile", "file", "File"]), false)) {
    return "file";
  }

  return "file";
}

function normalizeFileEntry(entry, currentPath = null) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const rawPath =
    findAmpValue(entry, ["path", "Path", "fullPath", "FullPath", "absolutePath", "AbsolutePath"]) ||
    null;
  const name =
    findAmpValue(entry, ["name", "Name", "displayName", "DisplayName"]) ||
    getBaseName(rawPath) ||
    null;
  const entryPath = rawPath || (currentPath && name ? `${String(currentPath).replace(/[\\/]+$/, "")}/${name}` : name);
  const type = normalizeFileType(entry);
  const size = safeNumber(findAmpValue(entry, ["size", "Size", "length", "Length", "bytes", "Bytes"]));
  const modifiedAt = findAmpValue(entry, ["modifiedAt", "ModifiedAt", "modified", "Modified", "mtime", "MTime", "lastModified", "LastModified"]) || null;
  const extension = type === "file"
    ? (findAmpValue(entry, ["extension", "Extension"]) || (typeof name === "string" && name.includes(".") ? name.split(".").pop() : null))
    : null;

  return {
    name,
    path: entryPath || null,
    type,
    isDirectory: type === "directory",
    size,
    modifiedAt,
    extension: extension ? String(extension).replace(/^\./, "") : null,
  };
}

function normalizeFileEntries(payload, currentPath = null) {
  const candidate = unwrapPayload(payload, "entries");
  const source =
    Array.isArray(candidate) ? candidate
      : Array.isArray(payload?.items) ? payload.items
        : Array.isArray(payload?.files) ? payload.files
          : Array.isArray(payload?.children) ? payload.children
            : Array.isArray(payload?.listing) ? payload.listing
              : [];

  return source.map((entry) => normalizeFileEntry(entry, currentPath)).filter(Boolean);
}

function normalizeRootEntry(entry) {
  if (typeof entry === "string") {
    const trimmed = trimValue(entry);
    return trimmed
      ? {
          name: getBaseName(trimmed) || trimmed,
          path: trimmed,
          type: "directory",
          isDirectory: true,
        }
      : null;
  }

  const normalized = normalizeFileEntry(entry);

  if (!normalized) {
    return null;
  }

  return {
    ...normalized,
    type: "directory",
    isDirectory: true,
  };
}

function normalizeRoots(payload, currentPath = null) {
  const rootsSource =
    Array.isArray(payload?.roots) ? payload.roots
      : Array.isArray(payload?.mounts) ? payload.mounts
        : currentPath ? [currentPath] : [];

  return rootsSource.map(normalizeRootEntry).filter(Boolean);
}

function normalizeBreadcrumbs(payload, currentPath = null) {
  if (Array.isArray(payload?.breadcrumbs)) {
    return payload.breadcrumbs
      .map((crumb) => {
        if (typeof crumb === "string") {
          const trimmed = trimValue(crumb);
          return trimmed ? { name: getBaseName(trimmed) || trimmed, path: trimmed } : null;
        }

        if (!crumb || typeof crumb !== "object") {
          return null;
        }

        const crumbPath = findAmpValue(crumb, ["path", "Path", "fullPath", "FullPath", "absolutePath", "AbsolutePath"]) || null;
        const crumbName = findAmpValue(crumb, ["name", "Name", "displayName", "DisplayName"]) || getBaseName(crumbPath) || null;

        return crumbName || crumbPath ? { name: crumbName || crumbPath, path: crumbPath || crumbName } : null;
      })
      .filter(Boolean);
  }

  if (!currentPath) {
    return [];
  }

  const segments = normalizePathSegments(currentPath);
  const isAbsolute = /^[\\/]|^[A-Za-z]:[\\/]/.test(String(currentPath));
  const breadcrumbs = [];
  let cursor = String(currentPath).includes("\\") ? "" : isAbsolute ? "/" : "";

  segments.forEach((segment) => {
    if (/^[A-Za-z]:$/.test(segment)) {
      cursor = `${segment}/`;
    } else if (cursor === "/" || /^[A-Za-z]:\/$/.test(cursor)) {
      cursor = `${cursor}${segment}`;
    } else if (cursor) {
      cursor = `${cursor}/${segment}`;
    } else {
      cursor = segment;
    }

    breadcrumbs.push({
      name: segment,
      path: cursor,
    });
  });

  return breadcrumbs;
}

function normalizeFileListing(payload, configOverride = null) {
  const listing = unwrapPayload(payload, "listing");
  const candidate =
    listing && typeof listing === "object" && !Array.isArray(listing)
      ? listing
      : payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : {};
  const currentPath =
    findAmpValue(candidate, ["currentPath", "CurrentPath", "path", "Path", "directory", "Directory"]) ||
    null;
  const entries = normalizeFileEntries(candidate, currentPath);
  const roots = normalizeRoots(candidate, currentPath);
  const breadcrumbs = normalizeBreadcrumbs(candidate, currentPath);
  const directoryCount = entries.filter((entry) => entry.isDirectory).length;
  const fileCount = entries.filter((entry) => !entry.isDirectory).length;
  const connected = typeof candidate.connected === "boolean" ? candidate.connected : true;
  const configured = typeof candidate.configured === "boolean" ? candidate.configured : true;
  const status = candidate.status || (connected ? "connected" : "unavailable");
  const message = candidate.message || (connected ? "Connected to file service." : "File service unavailable.");

  return {
    configured,
    connected,
    status,
    message,
    currentPath,
    roots,
    shortcuts: Array.isArray(candidate.shortcuts) ? candidate.shortcuts : [],
    fileShortcuts: Array.isArray(candidate.fileShortcuts) ? candidate.fileShortcuts : Array.isArray(candidate.shortcuts) ? candidate.shortcuts : [],
    capabilities: candidate.capabilities && typeof candidate.capabilities === "object" ? candidate.capabilities : {},
    breadcrumbs,
    entries,
    summary: {
      ...(candidate.summary && typeof candidate.summary === "object" ? candidate.summary : {}),
      directoryCount,
      fileCount,
      totalCount: entries.length,
    },
    lastCheckedAt: candidate.lastCheckedAt || new Date().toISOString(),
    diagnostics: candidate.diagnostics && typeof candidate.diagnostics === "object"
      ? {
          ...candidate.diagnostics,
          agent: {
            url: getAgentConfig(configOverride).url,
          },
        }
      : {
          agent: {
            url: getAgentConfig(configOverride).url,
          },
        },
  };
}

async function getFileList(currentPath = ".", configOverride = null) {
  const query = new URLSearchParams({
    path: currentPath || ".",
  });

  return requestJson(`/api/v1/files/list?${query.toString()}`, { config: configOverride });
}

async function getFileListing(currentPath = ".", configOverride = null) {
  return normalizeFileListing(await getFileList(currentPath, configOverride), configOverride);
}

async function getFilesystemIdentity(configOverride = null) {
  return requestJson("/api/v1/files/identity", { config: configOverride });
}

async function readFileText(currentPath, configOverride = null) {
  const query = new URLSearchParams({ path: currentPath || "." });
  return requestJson(`/api/v1/files/read?${query.toString()}`, { config: configOverride });
}

async function mutateFile(payload = {}, configOverride = null) {
  return requestJson("/api/v1/files/mutate", { config: configOverride, method: "POST", body: payload });
}

function parseContentDispositionFilename(contentDisposition = "") {
  const utfMatch = /filename\*=UTF-8''([^;]+)/i.exec(contentDisposition);

  if (utfMatch?.[1]) {
    try {
      return decodeURIComponent(utfMatch[1]);
    } catch {
      return utfMatch[1];
    }
  }

  const fallbackMatch = /filename=\"?([^\";]+)\"?/i.exec(contentDisposition);
  return fallbackMatch?.[1] || null;
}

async function downloadFile(currentPath, configOverride = null) {
  const query = new URLSearchParams({
    path: currentPath || ".",
  });
  const response = await requestBuffer(`/api/v1/files/download?${query.toString()}`, { config: configOverride });
  const headers = response.headers || {};

  return {
    path: currentPath || ".",
    name:
      parseContentDispositionFilename(headers["content-disposition"]) ||
      (headers["x-anxhub-file-name"] ? decodeURIComponent(headers["x-anxhub-file-name"]) : null) ||
      getBaseName(currentPath) ||
      "download",
    size: Number.parseInt(headers["x-anxhub-file-size"] || headers["content-length"] || "0", 10) || response.buffer.length,
    modifiedAt: headers["last-modified"] || null,
    contentType: response.contentType || "application/octet-stream",
    buffer: response.buffer,
  };
}

function encodeInstanceId(instanceId) {
  return encodeURIComponent(String(instanceId || ""));
}

async function listInstances(configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().listInstances();
  }
  return requestJson("/api/v1/instances", { config: configOverride });
}

async function createInstance(payload = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().createInstance(payload);
  }
  return requestJson("/api/v1/instances", {
    config: configOverride,
    method: "POST",
    body: payload,
  });
}

async function updateInstance(instanceId, payload = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().updateInstance(instanceId, payload);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}`, {
    config: configOverride,
    method: "PATCH",
    body: payload,
  });
}

async function renameInstance(instanceId, displayName, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().renameInstance(instanceId, displayName);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/display-name`, {
    config: configOverride,
    method: "POST",
    body: { displayName },
  });
}

async function duplicateInstance(instanceId, payload = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().duplicateInstance(instanceId, payload);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/duplicate`, {
    config: configOverride,
    method: "POST",
    body: payload,
  });
}

async function getInstanceStatus(instanceId, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().getStatus(instanceId);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/status`, { config: configOverride });
}

async function getInstanceMetrics(instanceId, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().getMetrics(instanceId);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/metrics`, { config: configOverride });
}

async function getInstanceLogs(instanceId, options = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().readLogs(instanceId, options);
  }
  const query = new URLSearchParams({
    stream: options.stream || "all",
    limit: String(options.limit || 200),
  });

  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/logs?${query.toString()}`, { config: configOverride });
}

async function clearInstanceLogs(instanceId, options = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().clearLogs(instanceId, options);
  }
  const query = new URLSearchParams({
    stream: options.stream || "all",
  });

  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/logs?${query.toString()}`, {
    config: configOverride,
    method: "DELETE",
  });
}

async function sendInstanceCommand(instanceId, command, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().writeInstanceInput(instanceId, command);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/command`, {
    config: configOverride,
    method: "POST",
    body: { command },
  });
}

async function forceKillInstance(instanceId, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().forceKillInstance(instanceId);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/force-kill`, {
    config: configOverride,
    method: "POST",
  });
}

async function listInstanceFiles(instanceId, currentPath = ".", configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().listInstanceFiles(instanceId, currentPath);
  }
  const query = new URLSearchParams({ path: currentPath || "." });
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/files?${query.toString()}`, { config: configOverride });
}

async function readInstanceFile(instanceId, filePath, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().readInstanceFile(instanceId, filePath);
  }
  const query = new URLSearchParams({ path: filePath || "." });
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/file?${query.toString()}`, { config: configOverride });
}

async function instanceFileExists(instanceId, filePath, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().instanceFileExists(instanceId, filePath);
  }
  const query = new URLSearchParams({ path: filePath || "." });
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/exists?${query.toString()}`, { config: configOverride });
}

async function writeInstanceFile(instanceId, filePath, content, options = {}, configOverride = null) {
  const effectiveConfig = configOverride || options.config || null;
  if (shouldUseLocalInstanceService(effectiveConfig)) {
    return getLocalInstanceService().writeInstanceFile(instanceId, filePath, content, options);
  }
  const request = () => requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/file`, {
    config: effectiveConfig,
    method: "PUT",
    timeoutMs: FILE_WRITE_REQUEST_TIMEOUT_MS,
    body: {
      path: filePath,
      content,
      encoding: options.encoding,
    },
  });
  return retryTransientFileWrite(request);
}

async function deleteInstanceFile(instanceId, filePath, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().deleteInstanceFile(instanceId, filePath);
  }
  const query = new URLSearchParams({ path: filePath || "." });
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/file?${query.toString()}`, {
    config: configOverride,
    method: "DELETE",
  });
}

async function createInstanceFolder(instanceId, folderPath, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().createInstanceFolder(instanceId, folderPath);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/mkdir`, {
    config: configOverride,
    method: "POST",
    body: { path: folderPath },
  });
}

async function renameInstanceFile(instanceId, oldPath, newPath, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().renameInstanceFile(instanceId, oldPath, newPath);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/rename`, {
    config: configOverride,
    method: "POST",
    body: {
      oldPath,
      newPath,
    },
  });
}

async function getMinecraftProperties(instanceId, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().readMinecraftProperties(instanceId);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/minecraft/properties`, { config: configOverride });
}

async function getGameServerConfig(instanceId, options = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().readGameServerConfig(instanceId, options);
  }
  const query = new URLSearchParams();
  if (options?.adapterId) query.set("adapterId", options.adapterId);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/game-config${suffix}`, { config: configOverride });
}

async function saveGameServerConfig(instanceId, payload = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().writeGameServerConfig(instanceId, payload);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/game-config`, {
    config: configOverride,
    method: "PUT",
    body: payload,
  });
}

async function saveMinecraftProperties(instanceId, properties = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().writeMinecraftProperties(instanceId, properties);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/minecraft/properties`, {
    config: configOverride,
    method: "PUT",
    body: { properties },
  });
}

async function getFiveMReadiness(instanceId, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().refreshFiveMReadiness(instanceId);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/fivem/readiness`, { config: configOverride });
}

async function saveFiveMLicenseKey(instanceId, licenseKey, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().saveFiveMLicenseKey(instanceId, licenseKey);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/fivem/license-key`, {
    config: configOverride,
    method: "PUT",
    body: { licenseKey },
  });
}

async function startInstance(instanceId, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().startInstance(instanceId);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/start`, {
    config: configOverride,
    method: "POST",
  });
}

async function beginInstallationSession(instanceId, payload = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().beginInstallationSession(instanceId, payload);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/installation/session`, {
    config: configOverride,
    method: "POST",
    body: payload,
  });
}

async function beginSteamCmdUpdateSession(instanceId, payload = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) return getLocalInstanceService().beginSteamCmdUpdateSession(instanceId, payload);
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/steamcmd/update/session`, { config: configOverride, method: "POST", body: payload });
}
async function getSteamCmdUpdateStatus(instanceId, payload = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) return getLocalInstanceService().getSteamCmdUpdateStatus(instanceId, payload);
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/steamcmd/update/status`, { config: configOverride, method: "POST", body: payload });
}
async function repairLegacySteamCmdMetadata(instanceId, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) return getLocalInstanceService().repairLegacySteamCmdMetadata(instanceId);
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/steamcmd/update/migrate`, { config: configOverride, method: "POST", body: {} });
}
async function executeSteamCmdUpdate(instanceId, payload = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) return getLocalInstanceService().executeSteamCmdUpdate(instanceId, payload);
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/steamcmd/update`, { config: configOverride, method: "POST", body: payload, timeoutMs: 610000 });
}
async function closeSteamCmdUpdateSession(instanceId, payload = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) return getLocalInstanceService().closeSteamCmdUpdateSession(instanceId, payload);
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/steamcmd/update/session`, { config: configOverride, method: "DELETE", body: payload });
}

async function executeInstallationPhase(instanceId, payload = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().executeInstallationPhase(instanceId, payload);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/installation/execute`, {
    config: configOverride,
    method: "POST",
    body: payload,
    timeoutMs: Math.min(610000, Math.max(30000, Number(payload.timeoutMs) || 300000) + 10000),
  });
}

async function repairNeoForgeRuntime(instanceId, payload = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().repairNeoForgeRuntime(instanceId, payload);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/neoforge/repair-runtime`, {
    config: configOverride,
    method: "POST",
    body: payload,
    timeoutMs: Math.min(610000, Math.max(30000, Number(payload.timeoutMs) || 300000) + 10000),
  });
}

async function cancelInstallationSession(instanceId, payload = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().cancelInstallationSession(instanceId, payload);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/installation/cancel`, {
    config: configOverride,
    method: "POST",
    body: payload,
  });
}

async function closeInstallationSession(instanceId, payload = {}, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().closeInstallationSession(instanceId, payload);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/installation/session`, {
    config: configOverride,
    method: "DELETE",
    body: payload,
  });
}

async function stopInstance(instanceId, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().stopInstance(instanceId);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/stop`, {
    config: configOverride,
    method: "POST",
  });
}

async function restartInstance(instanceId, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().restartInstance(instanceId);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/restart`, {
    config: configOverride,
    method: "POST",
  });
}

async function deleteInstance(instanceId, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().deleteInstance(instanceId);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}`, {
    config: configOverride,
    method: "DELETE",
  });
}

async function forgetInstance(instanceId, configOverride = null) {
  if (shouldUseLocalInstanceService(configOverride)) {
    return getLocalInstanceService().forgetInstance(instanceId);
  }
  return requestJson(`/api/v1/instances/${encodeInstanceId(instanceId)}/record`, {
    config: configOverride,
    method: "DELETE",
  });
}

async function listBackups(options = {}, configOverride = null) {
  const query = new URLSearchParams();
  if (options.instanceId) {
    query.set("instanceId", options.instanceId);
  }
  return requestJson(`/api/v1/backups/list${query.toString() ? `?${query.toString()}` : ""}`, {
    config: configOverride,
  });
}

async function createBackup(payload = {}, configOverride = null) {
  return requestJson("/api/v1/backups", {
    config: configOverride,
    method: "POST",
    body: payload,
  });
}

async function restoreBackup(payload = {}, configOverride = null) {
  return requestJson("/api/v1/backups/restore", {
    config: configOverride,
    method: "POST",
    body: payload,
  });
}

async function importBackup(payload = {}, configOverride = null) {
  return requestJson("/api/v1/backups/import", {
    config: configOverride,
    method: "POST",
    body: payload,
  });
}

async function deleteBackup(backupId, configOverride = null) {
  return requestJson(`/api/v1/backups/${encodeURIComponent(String(backupId || ""))}`, {
    config: configOverride,
    method: "DELETE",
  });
}

async function downloadBackup(backupId, configOverride = null) {
  return requestBuffer(`/api/v1/backups/${encodeURIComponent(String(backupId || ""))}/download`, {
    config: configOverride,
  });
}

async function listBackupSchedules(configOverride = null) {
  return requestJson("/api/v1/backups/schedules", {
    config: configOverride,
  });
}

async function saveBackupSchedule(payload = {}, configOverride = null) {
  return requestJson("/api/v1/backups/schedules", {
    config: configOverride,
    method: "PUT",
    body: payload,
  });
}

async function deleteBackupSchedule(instanceId, configOverride = null) {
  return requestJson(`/api/v1/backups/${encodeURIComponent(String(instanceId || ""))}/schedule`, {
    config: configOverride,
    method: "DELETE",
  });
}

async function getDependencyCatalog(configOverride = null) {
  return requestJson("/api/v1/dependencies/catalog", { config: configOverride });
}

async function checkDependencies(payload = {}, configOverride = null) {
  return requestJson("/api/v1/dependencies/check", {
    config: configOverride,
    method: "POST",
    body: payload,
  });
}

async function planDependencyPreparation(payload = {}, configOverride = null) {
  return requestJson("/api/v1/dependencies/plan", {
    config: configOverride,
    method: "POST",
    body: payload,
  });
}

async function installDependencies(payload = {}, configOverride = null) {
  return requestJson("/api/v1/dependencies/install", {
    config: configOverride,
    method: "POST",
    body: payload,
  });
}

module.exports = {
  _test: {
    getAgentTransportErrorMessage,
    getTransportErrorCode,
  },
  AgentClientError,
  beginInstallationSession,
  beginSteamCmdUpdateSession,
  getSteamCmdUpdateStatus,
  repairLegacySteamCmdMetadata,
  cancelInstallationSession,
  checkDependencies,
  closeInstallationSession,
  closeSteamCmdUpdateSession,
  clearInstanceLogs,
  createBackup,
  createDockerContainer,
  createDockerNetwork,
  createPublicAccessService,
  deleteDockerImage,
  deletePublicAccessService,
  downloadFile,
  downloadBackup,
  createInstance,
  createInstanceFolder,
  duplicateInstance,
  deleteBackup,
  deleteBackupSchedule,
  deleteDockerContainer,
  disconnectDockerNetwork,
  execDockerContainer,
  executeInstallationPhase,
  executeSteamCmdUpdate,
  repairNeoForgeRuntime,
  deleteInstance,
  forgetInstance,
  deleteInstanceFile,
  forceKillInstance,
  getAgentConfigPath,
  getBackendMode,
  getDefaultAgentSettings,
  getEffectiveAgentSettings,
  getAmpInstances,
  getAmpSnapshot,
  getAmpStatus,
  getAgentConfig,
  getDockerContainers,
  getDockerCapabilities,
  getDockerContainerLogs,
  getDockerContainerStats,
  getDockerCleanupPreview,
  getDockerSnapshot,
  getDockerSummary,
  forNode,
  getDiagnostics,
  inspectDockerContainer,
  inspectDockerImage,
  inspectDockerNetwork,
  inspectDockerVolume,
  getFileList,
  getFileListing,
  getFilesystemIdentity,
  getHealth,
  getDependencyCatalog,
  getSystemStats,
  getInstanceLogs,
  getInstanceMetrics,
  getInstanceStatus,
  getFiveMReadiness,
  getGameServerConfig,
  instanceFileExists,
  getMinecraftProperties,
  getPlayitSnapshot,
  getPlayitStatus,
  getPublicAccessPlayitLogs,
  getPublicAccessPlayitStatus,
  getPublicAccessPlayitTunnels,
  getPublicAccessSnapshot,
  isHealthy,
  importBackup,
  installDependencies,
  listBackupSchedules,
  listBackups,
  controlPublicAccessPlayit,
  listDockerImages,
  listDockerComposeProjects,
  listDockerNetworks,
  listDockerVolumes,
  listPublicAccessServices,
  connectDockerNetwork,
  listInstanceFiles,
  listInstances,
  loadEnvironment,
  normalizeAgentSettings,
  mutateFile,
  killDockerContainer,
  pauseDockerContainer,
  pullDockerImage,
  pruneDockerImages,
  pruneDockerNetworks,
  pruneDockerVolumes,
  readAgentSettings,
  readFileText,
  removeDockerNetwork,
  removeDockerVolume,
  renameInstance,
  renameDockerContainer,
  runDockerCleanup,
  pairAgentFromCode,
  planDependencyPreparation,
  getSharedAgentTokenStatus,
  isCompatibilityFallbackAllowed,
  requestBuffer,
  requestStream,
  requestJson,
  rotateAgentSettingsToken,
  saveAgentSettings,
  saveBackupSchedule,
  saveFiveMLicenseKey,
  saveGameServerConfig,
  saveMinecraftProperties,
  sendInstanceCommand,
  startDockerContainer,
  dockerComposeAction,
  restartInstance,
  restoreBackup,
  testConnection,
  startInstance,
  stopInstance,
  stopDockerContainer,
  unpauseDockerContainer,
  restartDockerContainer,
  readInstanceFile,
  renameInstanceFile,
  updateInstance,
  writeInstanceFile,
};
