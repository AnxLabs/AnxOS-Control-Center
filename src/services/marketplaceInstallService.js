const { EventEmitter } = require("events");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const unzipper = require("unzipper");
const agentClient = require("./agentClient");
const {
  applyMinecraftServerProperties,
  resolveMinecraftPort,
} = require("./minecraftServerConfig");
const { getNode, getSelectedNodeId } = require("./nodeService");
const {
  buildMarketplaceInstallContext,
  resolveMarketplaceInstallTarget: resolveSharedMarketplaceInstallTarget,
  validateMarketplaceInstallContext,
} = require("./marketplaceInstallContext");
const modrinthProvider = require("./providers/modrinthProvider");
const curseforgeProvider = require("./providers/curseforgeProvider");
const { sanitize } = require("../shared/redaction");
const { normalizeDiskEvidence } = require("../shared/diskSpace");
const { CLASSIFICATIONS, classifyServerCompatibility } = require("../shared/marketplaceServerCompatibility");
const longOperations = require("../shared/longOperationService");

const INSTALL_FOLDERS = ["mods", "config", "defaultconfigs", "kubejs", "kubejs/scripts", "world", "logs", "backups"];
const PAPER_DOWNLOADS_API = "https://fill.papermc.io/v3";
const FORGE_PROMOTIONS_URL = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const FORGE_MAVEN_METADATA_URL = "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml";
const NEOFORGE_MAVEN_METADATA_URL = "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml";
const marketplaceInstallEvents = new EventEmitter();
const pendingManualInstalls = new Map();
// Abandoned manual-download flows (dialog closed without importing/cancelling) must not leak forever.
const MANUAL_INSTALL_SESSION_TTL_MS = 60 * 60 * 1000;
const MAX_PROVIDER_DOWNLOAD_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_COUNT = 100000;
const MAX_ARCHIVE_ENTRY_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_EXPANDED_BYTES = 32 * 1024 * 1024 * 1024;
const MAX_ARCHIVE_COMPRESSION_RATIO = 1000;
const MAX_ARCHIVE_PATH_LENGTH = 1024;
const PROVIDER_INSTALL_MIN_FREE_BYTES = 8 * 1024 * 1024 * 1024;

class MarketplaceInstallError extends Error {
  constructor(message, code = "MARKETPLACE_INSTALL_FAILED", details = {}) {
    super(message);
    this.name = "MarketplaceInstallError";
    this.code = code;
    this.details = details;
  }
}

function buildInstallContext(payload = {}, options = {}, instancePayload = {}) {
  return buildMarketplaceInstallContext({
    payload,
    options,
    instancePayload,
    sourceFallback: "marketplace-provider",
    preferOptionProvider: true,
    installPathFallback: "data",
  });
}

function resolveMarketplaceInstallTarget({ nodeId = null, operation = "marketplace-install" } = {}) {
  return resolveSharedMarketplaceInstallTarget({
    nodeId,
    operation,
    createError: (message, code, details) => new MarketplaceInstallError(message, code, details),
  });
}

function validateInstallContext(installContext = {}) {
  return validateMarketplaceInstallContext(installContext, {
    createError: (message, code, details) => new MarketplaceInstallError(message, code, details),
  });
}

function titleCaseProvider(provider) {
  const normalized = String(provider || "provider").trim().toLowerCase();
  if (normalized === "curseforge") return "CurseForge";
  if (normalized === "modrinth") return "Modrinth";
  return normalized ? normalized[0].toUpperCase() + normalized.slice(1) : "Provider";
}

function getCurseForgeAgentConfig(nodeId = null) {
  const target = resolveMarketplaceInstallTarget({ nodeId: nodeId || getSelectedNodeId(), operation: "curseforge-agent-proxy" });
  if (target.type !== "registered-node") {
    return {
      useAgentProxy: false,
      agentConfig: null,
      agentNodeId: "application-host",
      agentNodeLabel: target.nodeLabel || "Application Host",
      credentialSource: target.credentialSource,
    };
  }
  return {
    useAgentProxy: true,
    agentConfig: target.agentConfig,
    agentNodeId: target.nodeId,
    agentNodeLabel: target.nodeLabel,
    agentUrl: target.agentUrl,
    targetLabel: target.targetLabel,
    credentialSource: target.credentialSource,
  };
}

function getCurseForgeBrowseConfig(nodeId = null) {
  const selectedNodeId = nodeId || getSelectedNodeId();
  let node = null;
  try {
    node = getNode(selectedNodeId);
  } catch {}
  return {
    useAgentProxy: false,
    agentConfig: null,
    agentNodeId: node?.id || selectedNodeId || null,
    agentNodeLabel: node?.displayName || node?.name || selectedNodeId || null,
    credentialSource: "desktop-curseforge-api-key",
    browseOnly: true,
  };
}

function isCurseForgeBrowseAuthenticationError(error = {}) {
  const code = error?.payload?.error?.code || error?.code || "";
  const status = Number(error?.details?.status || error?.status || 0);
  const message = String(error?.message || error?.details?.body || "");
  return [
    "CURSEFORGE_API_KEY_REQUIRED",
    "CURSEFORGE_API_KEY_INVALID",
    "CURSEFORGE_CONFIGURATION_MISSING",
  ].includes(code) || (
    [401, 403].includes(status) &&
    /api[\s_-]*key|missing or invalid|invalid key|authentication/i.test(message)
  );
}

async function withCurseForgeBrowseFallback(nodeId, operation) {
  const desktopConfig = getCurseForgeBrowseConfig(nodeId);
  try {
    return {
      value: await operation(desktopConfig),
      config: desktopConfig,
    };
  } catch (error) {
    if (!isCurseForgeBrowseAuthenticationError(error)) {
      throw error;
    }
    const agentConfig = getCurseForgeAgentConfig(nodeId || desktopConfig.agentNodeId);
    if (!agentConfig.useAgentProxy) {
      throw error;
    }
    console.info("[Marketplace][CurseForge] Desktop browse credential rejected; retrying through the selected Agent.", {
      nodeId: agentConfig.agentNodeId,
      nodeLabel: agentConfig.agentNodeLabel,
      originalCode: error?.code || null,
      originalStatus: error?.details?.status || error?.status || null,
    });
    return {
      value: await operation({ ...agentConfig, browseOnly: true }),
      config: { ...agentConfig, browseOnly: true },
    };
  }
}

function serializeError(error, context = {}) {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  const serialized = sanitize({
    ...context,
    name: error?.name || null,
    code: error?.code || null,
    message: error?.message || null,
    status: details.status || error?.status || error?.statusCode || null,
    url: details.url || context.url || null,
    invalidUrl: details.invalidUrl || null,
    details,
  });
  delete serialized.stack;
  delete serialized.body;
  delete serialized.responseBody;
  delete serialized.payload;
  delete serialized.headers;
  delete serialized.authorization;
  if (serialized.details && typeof serialized.details === "object") {
    delete serialized.details.stack;
    delete serialized.details.originalStack;
    delete serialized.details.body;
    delete serialized.details.responseBody;
    delete serialized.details.payload;
    delete serialized.details.headers;
    delete serialized.details.authorization;
  }
  return serialized;
}

async function ensureProviderPackDependencies(options = {}, agentConfig = null) {
  if (agentConfig?.backendMode === "local") {
    return;
  }
  const dependencyIds = ["java"];
  const nodeId = options.nodeId || agentConfig?.nodeId || null;
  const nodeLabel = agentConfig?.agentNodeLabel || agentConfig?.nodeName || nodeId || "Selected node";
  const diagnosticsContext = {
    provider: options.provider || null,
    operation: "dependencies-check",
    nodeId,
    nodeLabel,
    targetType: nodeId ? "registered-node" : "unknown",
    agentUrl: agentConfig?.agentUrl || agentConfig?.nodeUrl || null,
    targetLabel: agentConfig?.targetLabel || (nodeId ? `node:${nodeId}` : null),
    credentialSource: agentConfig?.credentialSource || (nodeId ? "protected-node-credential" : null),
  };
  if (!nodeId) {
    throw new MarketplaceInstallError("No installation target is selected.", "INSTALL_TARGET_REQUIRED", diagnosticsContext);
  }
  emitProgress({ nodeId, instanceId: options.id || options.name || "provider-pack", stage: "dependencies", message: "Checking node dependencies...", current: 0, total: 1 });
  let check;
  try {
    check = await agentClient.checkDependencies({ dependencyIds, nodeId }, agentConfig);
  } catch (error) {
    if (error?.status === 401 || error?.code === "UNAUTHORIZED") {
      throw new MarketplaceInstallError(`${nodeLabel} credential rejected. Repair or re-pair this Node before installing.`, "NODE_CREDENTIAL_REJECTED", {
        ...diagnosticsContext,
        status: error.status || 401,
        errorCode: error.code || "UNAUTHORIZED",
      });
    }
    throw error;
  }
  if (check.ok) {
    emitProgress({ nodeId, instanceId: options.id || options.name || "provider-pack", stage: "dependencies", message: "Node dependencies are ready.", current: 1, total: 1 });
    return;
  }
  if (options.autoInstallDependencies === true) {
    await agentClient.installDependencies({ dependencyIds: check.missingDependencyIds || dependencyIds, nodeId }, agentConfig);
    const recheck = await agentClient.checkDependencies({ dependencyIds, nodeId }, agentConfig);
    if (recheck.ok) {
      emitProgress({ nodeId, instanceId: options.id || options.name || "provider-pack", stage: "dependencies", message: "Node dependencies installed.", current: 1, total: 1 });
      return;
    }
  }
  throw new MarketplaceInstallError("This modpack requires node dependencies before installation can continue.", "DEPENDENCIES_REQUIRED", {
    dependencyIds,
    dependencies: check.dependencies,
    missingDependencies: check.dependencies?.filter((dependency) => !dependency.installed || dependency.state === "update-required") || [],
    provider: options.provider || null,
    retryable: true,
    userAction: "install-dependencies",
  });
}

function truncateForLog(value, maxLength = 4000) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function logMarketplaceInstallFailure(error, context = {}) {
  console.error("[Marketplace][Install] Install failed.", serializeError(error, context));
}

function logMarketplaceInstallStep(message, context = {}) {
  console.info("[Marketplace][Install]", {
    message,
    ...context,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientStatus(status) {
  return [408, 409, 425, 429, 500, 502, 503, 504].includes(Number(status));
}

function isTransientError(error) {
  const status = error?.details?.status || error?.status || error?.statusCode;
  const code = error?.code || error?.payload?.error?.code || "";
  const name = error?.name || error?.payload?.error?.details?.name || "";
  return isTransientStatus(status) ||
    ["NETWORK_FAILED", "AGENT_TIMEOUT", "AGENT_UNAVAILABLE", "UND_ERR_CONNECT_TIMEOUT", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"].includes(code) ||
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
      const waitMs = Number(context.delayMs) || 500;
      logMarketplaceInstallStep("Retrying transient Marketplace operation.", {
        label: context.label || null,
        attempt,
        nextAttempt: attempt + 1,
        code: error?.code || null,
        status: error?.details?.status || error?.status || null,
        url: error?.details?.url || context.url || null,
        message: error?.message || null,
      });
      await delay(waitMs * attempt);
    }
  }

  throw lastError;
}

function friendlyHttpMessage(label, status, body = "") {
  const detail = (() => {
    try {
      const parsed = JSON.parse(body);
      return parsed.error || parsed.message || parsed.description || "";
    } catch {
      return String(body || "").trim().slice(0, 240);
    }
  })();
  if (status === 401) return `${label}: 401 Invalid API key.`;
  if (status === 403) return `${label}: 403 Forbidden.`;
  if (status === 404) return `${label}: 404 Project not found.`;
  if (status === 429) return `${label}: 429 Rate limited. Try again later.`;
  return `${label}: HTTP ${status}${detail ? ` - ${detail}` : ""}`;
}

function friendlyError(error) {
  if (error?.code === "CURSEFORGE_API_KEY_REQUIRED") {
    return error?.message || "CurseForge API key is required to install CurseForge packs.";
  }
  return error?.message || "Marketplace install failed.";
}

function buildDetailedErrorMessage(error, fallback = "Marketplace install failed.") {
  const details = error?.details && typeof error.details === "object" ? error.details : {};
  const parts = [];
  const code = error?.code || details.code;
  const message = error?.message && error.message !== "URL" ? error.message : "";
  parts.push(message || fallback);
  if (code) parts.push(`code=${code}`);
  if (details.status || error?.status || error?.statusCode) parts.push(`status=${details.status || error.status || error.statusCode}`);
  if (details.provider) parts.push(`provider=${details.provider}`);
  if (details.fileName) parts.push(`file=${details.fileName}`);
  if (details.url) parts.push(`url=${details.url}`);
  if (details.invalidUrl) parts.push(`invalidUrl=${details.invalidUrl}`);
  if (details.body || details.responseBody) parts.push(`body=${truncateForLog(details.body || details.responseBody, 1000)}`);
  if (details.recovery) parts.push(`recovery=${details.recovery}`);
  if (details.suggestion) parts.push(`suggestion=${details.suggestion}`);
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
  if (error?.name && error.name !== "Error") parts.push(`error=${error.name}`);
  if (error?.message === "URL" && !details.invalidUrl && !details.url) {
    parts.push("hint=A URL constructor failed, but the invalid value was not attached by the throwing code.");
  }
  return parts.join(" | ");
}

function emitProgress(payload = {}) {
  const total = Number(payload.total) || 0;
  const current = Number(payload.current) || 0;
  const percent = Number.isFinite(Number(payload.percent))
    ? Number(payload.percent)
    : total > 0 ? Math.round((current / total) * 100) : 0;
  const event = {
    nodeId: payload.nodeId || "",
    instanceId: payload.instanceId || "",
    stage: payload.stage || "resolving",
    message: payload.message || "",
    current,
    total,
    percent: Math.max(0, Math.min(percent, 100)),
    logs: Array.isArray(payload.logs) ? payload.logs.slice(-120) : [],
  };
  marketplaceInstallEvents.emit("progress", event);
  if (payload.operationId) {
    updateProviderInstallOperation(payload.operationId, {
      stage: event.stage,
      body: event.message,
      progress: event.percent,
      logs: event.logs,
      status: event.stage === "waiting" ? "waiting" : event.stage === "done" ? "complete" : "running",
    });
  }
  return event;
}

function throwIfInstallCancelled(signal) {
  if (!signal?.aborted) return;
  throw new MarketplaceInstallError("Marketplace installation was cancelled.", "INSTALL_CANCELLED", {
    retryable: true,
    cancelled: true,
  });
}

function updateProviderInstallOperation(operationId, patch = {}) {
  const operation = longOperations.getOperation(operationId);
  if (!operation) return null;
  const status = patch.status === "complete" ? "complete"
    : patch.status === "failed" ? "failed"
      : patch.status === "cancelled" ? "cancelled"
        : patch.status === "waiting" ? "paused" : "running";
  const canCancel = patch.canCancel !== undefined ? Boolean(patch.canCancel) : status === "running";
  const canRetry = patch.canRetry !== undefined ? Boolean(patch.canRetry) : status === "failed" || status === "cancelled";
  const metadata = {
    ...(operation.metadata || {}),
    ...patch,
    canCancel,
    canRetry,
    updatedAt: new Date().toISOString(),
  };
  return longOperations.updateOperation(operationId, {
    status,
    stage: metadata.stage || null,
    message: metadata.body || null,
    progress: Number.isFinite(Number(metadata.progress)) ? Number(metadata.progress) : null,
    canCancel,
    canRetry,
    metadata,
  });
}

function createProviderInstallOperation(payload, context = {}) {
  const controller = new AbortController();
  const now = new Date().toISOString();
  const id = `provider-install-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const metadata = {
    id,
    nodeId: context.nodeId,
    instanceId: context.instanceId,
    templateId: payload.templateId || payload.providerProjectId || payload.projectId || "provider-pack",
    title: payload.name || payload.instanceName || "Marketplace provider pack",
    status: "running",
    stage: "Preflight",
    progress: 0,
    body: "Preparing provider installation.",
    canCancel: true,
    canRetry: false,
    controller,
    startedAt: now,
    updatedAt: now,
  };
  const operation = longOperations.createOperation({
    id,
    kind: "marketplace-download",
    nodeId: context.nodeId,
    lockKey: `marketplace-provider:${context.nodeId}:${context.instanceId}`,
    status: "running",
    canCancel: true,
    retryable: true,
    rollbackSupported: true,
    metadata,
  });
  longOperations.registerCancelHandler(id, () => controller.abort());
  const retry = typeof context.retry === "function" ? context.retry : () => installPack({ ...payload });
  longOperations.registerRetryHandler(id, retry);
  return { operation, controller, signal: controller.signal };
}

function slugify(value, fallback = "minecraft-server") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || fallback;
}

function displayName(value, fallback = "Minecraft Server") {
  return String(value || "").trim().slice(0, 96) || fallback;
}

function normalizeMemory(value, fallback = "4G") {
  const text = String(value || "").trim().toUpperCase();
  return /^\d+\s*(M|G|MB|GB)$/.test(text) ? text.replace(/\s+/g, "") : fallback;
}

function normalizeLoader(loader) {
  const normalized = String(loader || "").trim().toLowerCase();
  if (normalized.includes("neoforge")) return "neoforge";
  if (normalized.includes("forge")) return "forge";
  if (normalized.includes("fabric")) return "fabric";
  if (normalized.includes("quilt")) return "quilt";
  if (normalized.includes("paper")) return "paper";
  if (normalized.includes("purpur")) return "purpur";
  if (normalized.includes("spigot")) return "spigot";
  if (normalized.includes("vanilla")) return "vanilla";
  return normalized || "vanilla";
}

function resolvePort(value) {
  return resolveMinecraftPort({ port: value }, [25565]);
}

function validateDownloadUrl(url) {
  const rawUrl = String(url || "").trim();
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (error) {
    throw new MarketplaceInstallError("Invalid download URL.", "INVALID_DOWNLOAD_URL", {
      invalidUrl: rawUrl || String(url),
      message: error?.message || "Invalid URL",
      stack: error?.stack || null,
    });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new MarketplaceInstallError("Download URL is not allowed.", "DOWNLOAD_URL_UNSAFE", { url: rawUrl });
  }
  return parsed;
}

function getUrlPathBasename(url, fallback = "download") {
  try {
    return path.basename(validateDownloadUrl(url).pathname) || fallback;
  } catch (error) {
    logMarketplaceInstallFailure(error, { label: "derive download file name", url });
    throw error;
  }
}

async function fetchJson(url, label) {
  try {
    return await withRetry(async () => {
      const response = await fetch(validateDownloadUrl(url));
      const body = await response.text();
      if (!response.ok) {
        throw new MarketplaceInstallError(friendlyHttpMessage(label, response.status, body), "DOWNLOAD_RESOLVE_FAILED", {
          status: response.status,
          body: truncateForLog(body),
          url,
        });
      }
      try {
        return JSON.parse(body);
      } catch (error) {
        throw new MarketplaceInstallError(`${label} returned invalid JSON.`, "DOWNLOAD_RESOLVE_FAILED", {
          message: error.message,
          body: truncateForLog(body),
          url,
        });
      }
    }, { label, url });
  } catch (error) {
    const effectiveError = error instanceof MarketplaceInstallError
      ? error
      : new MarketplaceInstallError(`${label}: Network timeout or connection failure - ${error?.message || "request failed"}`, "NETWORK_FAILED", {
        url,
        message: error?.message || "request failed",
        stack: error?.stack || null,
      });
    logMarketplaceInstallFailure(effectiveError, { label, url });
    throw effectiveError;
  }
}

async function fetchBuffer(url, label, options = {}) {
  try {
    return await withRetry(async () => {
      throwIfInstallCancelled(options.signal);
      const response = await fetch(validateDownloadUrl(url), { signal: options.signal });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new MarketplaceInstallError(friendlyHttpMessage(label, response.status, body), "DOWNLOAD_FAILED", {
          status: response.status,
          body: truncateForLog(body),
          url,
        });
      }
      return readBoundedResponseBuffer(response, { label, url, signal: options.signal });
    }, { label, url });
  } catch (error) {
    if (options.signal?.aborted || error?.name === "AbortError") {
      throwIfInstallCancelled(options.signal || { aborted: true });
    }
    const effectiveError = error instanceof MarketplaceInstallError
      ? error
      : new MarketplaceInstallError(`${label}: Network timeout or connection failure - ${error?.message || "request failed"}`, "NETWORK_FAILED", {
        url,
        message: error?.message || "request failed",
        stack: error?.stack || null,
      });
    logMarketplaceInstallFailure(effectiveError, { label, url });
    throw effectiveError;
  }
}

async function readBoundedResponseBuffer(response, options = {}) {
  const maxBytes = Math.max(1, Number(options.maxBytes) || MAX_PROVIDER_DOWNLOAD_BYTES);
  const declaredBytes = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
    response.body?.cancel?.().catch?.(() => {});
    throw new MarketplaceInstallError(`${options.label || "Provider download"} exceeds the maximum supported download size.`, "DOWNLOAD_TOO_LARGE", {
      url: options.url || null,
      declaredBytes,
      maxBytes,
    });
  }
  if (!response.body?.getReader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new MarketplaceInstallError(`${options.label || "Provider download"} exceeds the maximum supported download size.`, "DOWNLOAD_TOO_LARGE", {
        url: options.url || null,
        receivedBytes: buffer.length,
        maxBytes,
      });
    }
    return buffer;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let receivedBytes = 0;
  try {
    while (true) {
      throwIfInstallCancelled(options.signal);
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      receivedBytes += chunk.length;
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new MarketplaceInstallError(`${options.label || "Provider download"} exceeds the maximum supported download size.`, "DOWNLOAD_TOO_LARGE", {
          url: options.url || null,
          receivedBytes,
          maxBytes,
        });
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, receivedBytes);
  } catch (error) {
    if (options.signal?.aborted) {
      await reader.cancel().catch(() => {});
    }
    throw error;
  } finally {
    reader.releaseLock?.();
  }
}

async function fetchText(url, label) {
  try {
    return await withRetry(async () => {
      const response = await fetch(validateDownloadUrl(url));
      const body = await response.text();
      if (!response.ok) {
        throw new MarketplaceInstallError(friendlyHttpMessage(label, response.status, body), "DOWNLOAD_RESOLVE_FAILED", {
          status: response.status,
          body: truncateForLog(body),
          url,
        });
      }
      return body;
    }, { label, url });
  } catch (error) {
    const effectiveError = error instanceof MarketplaceInstallError
      ? error
      : new MarketplaceInstallError(`${label}: Network timeout or connection failure - ${error?.message || "request failed"}`, "NETWORK_FAILED", {
        url,
        message: error?.message || "request failed",
        stack: error?.stack || null,
      });
    logMarketplaceInstallFailure(effectiveError, { label, url });
    throw effectiveError;
  }
}

function ensureProviderProjectId(projectId, provider) {
  if (!projectId) {
    throw new MarketplaceInstallError(`${provider} install failed: Invalid provider metadata. Missing providerProjectId.`, "INVALID_PROVIDER_METADATA");
  }
}

function ensureServerFiles(files, provider) {
  if (!files.length) {
    throw new MarketplaceInstallError(`${provider} modpack has no server files for the selected Minecraft version/loader.`, "MISSING_SERVER_FILES");
  }
}

function ensureSupportedModpack(condition, provider, reason = "Unsupported modpack") {
  if (!condition) {
    throw new MarketplaceInstallError(`${provider} install failed: ${reason}.`, "UNSUPPORTED_MODPACK");
  }
}

function isCurseForgeServerSignalPath(entryPath = "") {
  const normalized = String(entryPath || "").replace(/\\/g, "/").replace(/^overrides\//, "").toLowerCase();
  return normalized === "server.properties" ||
    normalized === "eula.txt" ||
    /^start(?:server)?(\.(sh|bat|cmd))?$/.test(normalized) ||
    /^run\.(sh|bat|cmd)$/.test(normalized) ||
    /^minecraft_server.*\.jar$/.test(normalized) ||
    /^forge-.*\.jar$/.test(normalized) ||
    /^neoforge-.*\.jar$/.test(normalized) ||
    normalized === "fabric-server-launch.jar" ||
    normalized.startsWith("libraries/") ||
    /^mods\/.+\.jar$/.test(normalized);
}

function ensureCurseForgeServerPackCandidate(context = {}) {
  if (context.isDedicatedServerPack) {
    return;
  }
  if (context.serverSignalCount > 0 || context.bundledModCount > 0) {
    logMarketplaceInstallStep("Validated CurseForge archive as server-capable without separate server pack.", {
      instanceId: context.instanceId,
      projectId: context.projectId,
      fileId: context.fileId,
      serverSignalCount: context.serverSignalCount,
      bundledModCount: context.bundledModCount,
    });
    return;
  }
  throw new MarketplaceInstallError(
    "This project does not provide a compatible dedicated-server pack for the selected version.",
    "CURSEFORGE_SERVER_PACK_REQUIRED",
    {
      provider: "curseforge",
      providerName: "CurseForge",
      projectId: context.projectId || null,
      fileId: context.fileId || null,
      fileName: context.fileName || null,
      suggestion: "Choose a project and version with an official CurseForge server pack.",
    }
  );
}

function getCurseForgeManifestFiles(manifest, options = {}) {
  if (!manifest) {
    if (options.isDedicatedServerPack) return [];
    ensureSupportedModpack(false, "CurseForge", "server pack did not include a manifest.json");
  }
  return Array.isArray(manifest?.files) ? manifest.files : [];
}

function getCurseForgeFileId(file = {}) {
  return file.id || file.fileId || file.fileID || file.file_id || null;
}

function getCurseForgeProjectId(file = {}, fallback = null) {
  return file.projectId || file.modId || file.projectID || fallback || null;
}

function getCurseForgeVersions(file = {}) {
  return Array.isArray(file.minecraftVersions) ? file.minecraftVersions : Array.isArray(file.gameVersions) ? file.gameVersions : [];
}

function getCurseForgeLoaders(file = {}) {
  return Array.isArray(file.loaders) ? file.loaders : [];
}

function normalizeProviderLoaderValue(loader = "") {
  const normalized = normalizeLoader(loader);
  if (normalized === "neoforge") return "neoforge";
  if (normalized === "forge") return "forge";
  if (normalized === "fabric") return "fabric";
  if (normalized === "quilt") return "quilt";
  return normalized || "";
}

function selectProviderMinecraftVersion(versions = []) {
  const values = [...new Set((Array.isArray(versions) ? versions : []).map((entry) => String(entry || "").trim()).filter(Boolean))];
  return values.find((version) => /^1\.\d+\.\d+$/.test(version)) ||
    values.find((version) => /^1\.\d+$/.test(version)) ||
    values[0] ||
    "";
}

function displayProviderMinecraftVersion(versions = []) {
  const selected = selectProviderMinecraftVersion(versions);
  if (!selected) return "Compatibility Unknown";
  if (/^1\.\d+$/.test(selected)) return `${selected}.x`;
  return selected;
}

function selectProviderLoader(loaders = []) {
  return (Array.isArray(loaders) ? loaders : [])
    .map(normalizeProviderLoaderValue)
    .find(Boolean) || "";
}

function curseForgeFileMatchesSelection(file = {}, selection = {}) {
  const requestedMinecraftVersion = String(selection.minecraftVersion || selection.version || "").trim().toLowerCase();
  const requestedLoader = normalizeProviderLoaderValue(selection.loader || "");
  const versions = getCurseForgeVersions(file).map((entry) => String(entry || "").trim().toLowerCase());
  const loaders = getCurseForgeLoaders(file).map(normalizeProviderLoaderValue);
  const versionMatches = !requestedMinecraftVersion || versions.includes(requestedMinecraftVersion);
  const loaderMatches = !requestedLoader || loaders.length === 0 || loaders.includes(requestedLoader);
  return versionMatches && loaderMatches;
}

function createProviderAdvertisedMismatchError(provider, context = {}) {
  console.info("[Marketplace][ProviderSelection] Advertised metadata mismatch.", {
    provider: String(provider || "").toLowerCase(),
    field: context.field || null,
    advertised: context.advertised || null,
    resolved: context.resolved || null,
    projectId: context.projectId || null,
  });
  return new MarketplaceInstallError(`${provider} install failed: advertised Marketplace metadata does not match the resolved provider file/version.`, "PROVIDER_ADVERTISED_METADATA_MISMATCH", {
    provider: String(provider || "").toLowerCase(),
    ...context,
    retryable: false,
    suggestion: "Refresh the Marketplace card and retry the install.",
  });
}

function assertAdvertisedProviderSelection(provider, advertised = {}, resolved = {}) {
  const advertisedVersionId = String(advertised.providerVersionId || advertised.advertisedProviderVersionId || "").trim();
  const resolvedVersionId = String(resolved.providerVersionId || resolved.fileId || resolved.versionId || "").trim();
  if (advertisedVersionId && resolvedVersionId && advertisedVersionId !== resolvedVersionId) {
    throw createProviderAdvertisedMismatchError(provider, {
      field: "providerVersionId",
      advertised: advertisedVersionId,
      resolved: resolvedVersionId,
      projectId: resolved.projectId || advertised.projectId || null,
    });
  }

  const advertisedServerPackFileId = String(advertised.providerServerPackFileId || advertised.advertisedProviderServerPackFileId || "").trim();
  const resolvedServerPackFileId = String(resolved.providerServerPackFileId || resolved.serverPackFileId || "").trim();
  if (advertisedServerPackFileId && resolvedServerPackFileId && advertisedServerPackFileId !== resolvedServerPackFileId) {
    throw createProviderAdvertisedMismatchError(provider, {
      field: "providerServerPackFileId",
      advertised: advertisedServerPackFileId,
      resolved: resolvedServerPackFileId,
      projectId: resolved.projectId || advertised.projectId || null,
    });
  }

  const advertisedMinecraftVersion = String(advertised.minecraftVersion || advertised.advertisedMinecraftVersion || "").trim();
  const resolvedMinecraftVersions = Array.isArray(resolved.minecraftVersions) ? resolved.minecraftVersions : [];
  if (advertisedMinecraftVersion && advertisedMinecraftVersion !== "latest" && resolvedMinecraftVersions.length > 0 && !resolvedMinecraftVersions.includes(advertisedMinecraftVersion)) {
    throw createProviderAdvertisedMismatchError(provider, {
      field: "minecraftVersion",
      advertised: advertisedMinecraftVersion,
      resolved: resolvedMinecraftVersions,
      projectId: resolved.projectId || advertised.projectId || null,
    });
  }

  const advertisedLoader = normalizeProviderLoaderValue(advertised.loader || advertised.advertisedLoader || "");
  const resolvedLoaders = (Array.isArray(resolved.loaders) ? resolved.loaders : []).map(normalizeProviderLoaderValue).filter(Boolean);
  if (advertisedLoader && resolvedLoaders.length > 0 && !resolvedLoaders.includes(advertisedLoader)) {
    throw createProviderAdvertisedMismatchError(provider, {
      field: "loader",
      advertised: advertisedLoader,
      resolved: resolvedLoaders,
      projectId: resolved.projectId || advertised.projectId || null,
    });
  }
}

function applyResolvedProviderSelection(options = {}, resolved = {}) {
  const minecraftVersion = selectProviderMinecraftVersion(resolved.minecraftVersions);
  const loader = selectProviderLoader(resolved.loaders);
  if (minecraftVersion) {
    options.minecraftVersion = minecraftVersion;
    options.version = minecraftVersion;
  }
  if (loader) {
    options.loader = loader;
    options.serverType = loader;
  }
  if (resolved.providerVersionId) {
    options.providerVersionId = resolved.providerVersionId;
  }
  if (resolved.providerFileId) {
    options.providerFileId = resolved.providerFileId;
  }
  if (resolved.providerServerPackFileId) {
    options.providerServerPackFileId = resolved.providerServerPackFileId;
  }
  if (resolved.modpackVersion) {
    options.modpackVersion = resolved.modpackVersion;
  }
  options.providerResolvedMetadata = {
    ...(options.providerResolvedMetadata || {}),
    ...resolved,
    minecraftVersion,
    displayMinecraftVersion: displayProviderMinecraftVersion(resolved.minecraftVersions),
    loader,
  };
  return options;
}

function scoreCurseForgeServerPackCandidate(candidate = {}, selectedFile = {}, selection = {}) {
  let score = 0;
  const candidateId = getCurseForgeFileId(candidate);
  const selectedServerPackFileId = selectedFile.serverPackFileId || selectedFile.raw?.serverPackFileId || null;
  if (selectedServerPackFileId && String(candidateId) === String(selectedServerPackFileId)) score += 1000;
  if (curseForgeFileMatchesSelection(candidate, selection)) score += 100;
  if (candidate.releaseType === selectedFile.releaseType) score += 20;
  return score;
}

function createCurseForgeServerPackRequiredError(context = {}) {
  return new MarketplaceInstallError(
    "This project does not provide a compatible dedicated-server pack for the selected version.",
    "CURSEFORGE_SERVER_PACK_REQUIRED",
    {
      provider: "curseforge",
      providerName: "CurseForge",
      projectId: context.projectId || null,
      fileId: context.fileId || null,
      fileName: context.fileName || null,
      minecraftVersion: context.minecraftVersion || null,
      loader: context.loader || null,
      serverCompatibility: context.compatibility || null,
      suggestion: "Choose a project and version with an official CurseForge server pack.",
    }
  );
}

async function resolveCurseForgeServerPackSelection({
  projectId,
  minecraftVersion = "",
  loader = "",
  requestedFileId = "",
  requestedServerPackFileId = "",
  config = {},
} = {}) {
  ensureProviderProjectId(projectId, "CurseForge");
  const [project, selectedFile] = await Promise.all([
    curseforgeProvider.getMod(projectId, config),
    curseforgeProvider.resolveFile(projectId, minecraftVersion, loader, requestedFileId, config),
  ]);
  const selectedFileId = getCurseForgeFileId(selectedFile);
  const selectedServerPackFileId = selectedFile.serverPackFileId || selectedFile.raw?.serverPackFileId || null;
  const preferredServerPackReferences = [
    {
      fileId: requestedServerPackFileId,
      source: "advertised-serverPackFileId",
    },
    {
      fileId: selectedServerPackFileId,
      source: "selected-file-serverPackFileId",
    },
  ].filter((entry, index, entries) =>
    entry.fileId && entries.findIndex((candidate) => String(candidate.fileId) === String(entry.fileId)) === index
  );
  for (const reference of preferredServerPackReferences) {
    try {
      const serverFile = await curseforgeProvider.getFile(projectId, reference.fileId, config);
      const serverFileVersions = getCurseForgeVersions(serverFile);
      const serverFileLoaders = getCurseForgeLoaders(serverFile);
      const advertisedMetadataOmitted = reference.source === "advertised-serverPackFileId"
        && serverFileVersions.length === 0
        && serverFileLoaders.length === 0;
      if (
        getCurseForgeFileId(serverFile)
        && (
          curseForgeFileMatchesSelection(serverFile, { minecraftVersion, loader })
          || advertisedMetadataOmitted
        )
      ) {
        return {
          selectedFile,
          serverFile,
          source: reference.source,
          compatibility: classifyServerCompatibility({ ...project, ...selectedFile, projectId, serverPackFileId: reference.fileId }),
        };
      }
    } catch (error) {
      logMarketplaceInstallStep("Preferred CurseForge server pack reference was unavailable.", {
        projectId,
        selectedFileId,
        serverPackFileId: reference.fileId,
        source: reference.source,
        code: error?.code || null,
        status: error?.status || error?.details?.status || null,
      });
    }
  }

  const files = await curseforgeProvider.getFiles(projectId, minecraftVersion, loader, config);
  const explicitServerPackIds = [...new Set(files
    .map((file) => file.serverPackFileId || file.raw?.serverPackFileId || null)
    .filter(Boolean)
    .map(String))];
  if (selectedServerPackFileId) {
    explicitServerPackIds.push(String(selectedServerPackFileId));
  }
  const explicitCandidates = [];
  const unavailableExplicitServerPackIds = new Set();
  for (const serverPackFileId of explicitServerPackIds) {
    try {
      const serverFile = await curseforgeProvider.getFile(projectId, serverPackFileId, config);
      if (getCurseForgeFileId(serverFile) && curseForgeFileMatchesSelection(serverFile, { minecraftVersion, loader })) {
        explicitCandidates.push(serverFile);
      }
    } catch (error) {
      unavailableExplicitServerPackIds.add(String(serverPackFileId));
      logMarketplaceInstallStep("Skipping unavailable CurseForge server pack reference.", {
        projectId,
        selectedFileId,
        serverPackFileId,
        code: error?.code || null,
        status: error?.status || error?.details?.status || null,
      });
    }
  }

  const candidates = explicitCandidates
    .filter((file, index, list) => list.findIndex((entry) => String(getCurseForgeFileId(entry)) === String(getCurseForgeFileId(file))) === index)
    .sort((left, right) => scoreCurseForgeServerPackCandidate(right, selectedFile, { minecraftVersion, loader }) - scoreCurseForgeServerPackCandidate(left, selectedFile, { minecraftVersion, loader }));

  if (candidates.length > 0) {
    return {
      selectedFile,
      serverFile: candidates[0],
      source: "project-serverPackFileId",
      compatibility: classifyServerCompatibility({ ...project, ...selectedFile, projectId }),
    };
  }

  const compatibility = classifyServerCompatibility({ ...project, ...selectedFile, projectId, loader, loaders: selectedFile.loaders?.length ? selectedFile.loaders : project.loaders });
  if (compatibility.classification === CLASSIFICATIONS.SERVER_COMPATIBLE) {
    return { selectedFile, serverFile: selectedFile, source: "provider-declared-server-compatible", compatibility };
  }

  throw createCurseForgeServerPackRequiredError({
    projectId,
    fileId: selectedFileId,
    fileName: selectedFile.fileName,
    minecraftVersion,
    loader,
    compatibility,
  });
}

function ensureModrinthServerCapable(project = {}) {
  const serverSide = String(project.serverSide || project.raw?.server_side || "").trim().toLowerCase();
  if (serverSide === "unsupported") {
    throw new MarketplaceInstallError(
      `Modrinth install failed: ${project.name || project.slug || project.id || "selected pack"} is marked client-only and cannot be installed as a server instance.`,
      "MODRINTH_CLIENT_ONLY_PACK",
      {
        provider: "modrinth",
        projectId: project.providerProjectId || project.id || null,
        projectName: project.name || null,
        serverSide,
        clientSide: project.clientSide || project.raw?.client_side || null,
        suggestion: "Choose a modpack with server-side support or install the client pack in a launcher instead.",
      }
    );
  }
}

function isRecoverableProviderFileError(error) {
  if (isManualDownloadRequiredError(error)) {
    return true;
  }

  if ([
    "CURSEFORGE_DOWNLOAD_URL_MISSING",
    "CURSEFORGE_INVALID_DOWNLOAD_URL",
    "CURSEFORGE_UNSAFE_URL",
    "CURSEFORGE_DOWNLOAD_FAILED",
    "MODRINTH_DOWNLOAD_URL_MISSING",
    "MODRINTH_INVALID_DOWNLOAD_URL",
    "MODRINTH_UNSAFE_URL",
    "MODRINTH_DOWNLOAD_FAILED",
    "PROVIDER_DOWNLOAD_URL_MISSING",
    "PROVIDER_DOWNLOAD_FAILED",
  ].includes(error?.code)) {
    return true;
  }

  const status = Number(error?.details?.status || error?.status || error?.statusCode);
  return [
    "CURSEFORGE_REQUEST_FAILED",
    "MODRINTH_REQUEST_FAILED",
    "PROVIDER_REQUEST_FAILED",
  ].includes(error?.code) && [403, 404].includes(status);
}

function isCurseForgeAccessDeniedFileError(error) {
  const status = Number(error?.details?.status || error?.status || error?.statusCode);
  return ["CURSEFORGE_REQUEST_FAILED", "CURSEFORGE_DOWNLOAD_FAILED"].includes(error?.code) && [403, 404].includes(status);
}

function isProviderManualDownloadRequiredError(error) {
  if (!error) {
    return false;
  }

  if (isManualDownloadRequiredError(error)) {
    return true;
  }

  const status = Number(error?.details?.status || error?.status || error?.statusCode);
  const code = error?.code || error?.details?.code || "";
  const message = String(error?.message || error?.details?.reason || error?.details?.message || "").toLowerCase();
  return [
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
  ].includes(code) && [403, 404].includes(status) || /manual download|required file|restricted|forbidden|download url/i.test(message);
}

function getCurseForgeFileContext(file = {}, fallback = {}) {
  const required = file.required !== false && file.optional !== true;
  return {
    fileName: file.fileName || file.name || fallback.fileName || null,
    projectId: file.projectID || file.projectId || file.project_id || fallback.projectId || null,
    fileId: file.fileID || file.fileId || file.file_id || file.id || fallback.fileId || null,
    dependencyType: fallback.dependencyType || (required ? "required" : "optional"),
  };
}

async function resolveCurseForgeManualProjectMetadata(context = {}) {
  const projectId = context.projectId || context.providerProjectId;
  if (!projectId) {
    return {
      ...context,
      downloadPageUrl: getOfficialProviderUrl({ ...context, provider: "curseforge" }),
    };
  }

  try {
    const project = await curseforgeProvider.getMod(projectId, context.curseForgeConfig || {});
    const websiteUrl = project.websiteUrl || project.projectUrl || project.raw?.links?.websiteUrl || null;
    const enriched = {
      ...context,
      provider: "curseforge",
      providerName: "CurseForge",
      projectId,
      projectName: context.projectName || project.name || null,
      projectSlug: context.projectSlug || project.slug || null,
      websiteUrl: context.websiteUrl || websiteUrl,
      projectUrl: context.projectUrl || websiteUrl,
    };
    enriched.downloadPageUrl = getOfficialProviderUrl(enriched);
    logMarketplaceInstallStep("Resolved CurseForge project metadata for manual download.", {
      provider: "curseforge",
      projectId,
      fileId: context.fileId || null,
      fileName: context.fileName || null,
      projectName: enriched.projectName || null,
      projectSlug: enriched.projectSlug || null,
      websiteUrl: enriched.websiteUrl || null,
    });
    return enriched;
  } catch (error) {
    logMarketplaceInstallStep("CurseForge project metadata unavailable for manual download.", {
      provider: "curseforge",
      projectId,
      fileId: context.fileId || null,
      fileName: context.fileName || null,
      reason: error?.message || "metadata lookup failed",
      code: error?.code || null,
      recovery: "continue-with-manual-download-fallback-url",
    });
    return {
      ...context,
      provider: "curseforge",
      providerName: "CurseForge",
      downloadPageUrl: getOfficialProviderUrl({ ...context, provider: "curseforge" }),
    };
  }
}

async function resolveModrinthManualProjectMetadata(context = {}) {
  const projectId = context.projectId || context.providerProjectId || context.projectSlug;
  if (!projectId) {
    return {
      ...context,
      downloadPageUrl: getOfficialProviderUrl({ ...context, provider: "modrinth" }),
    };
  }

  try {
    const project = await modrinthProvider.getProject(projectId);
    const enriched = {
      ...context,
      provider: "modrinth",
      providerName: "Modrinth",
      projectId: context.projectId || project.id || project.providerProjectId || projectId,
      projectName: context.projectName || project.name || null,
      projectSlug: context.projectSlug || project.slug || null,
      projectType: context.projectType || project.projectType || null,
      websiteUrl: context.websiteUrl || project.websiteUrl || project.projectUrl || null,
      projectUrl: context.projectUrl || project.projectUrl || project.websiteUrl || null,
    };
    enriched.downloadPageUrl = getOfficialProviderUrl(enriched);
    logMarketplaceInstallStep("Resolved Modrinth project metadata for manual download.", {
      provider: "modrinth",
      projectId: enriched.projectId || null,
      versionId: context.versionId || null,
      fileName: context.fileName || null,
      projectName: enriched.projectName || null,
      projectSlug: enriched.projectSlug || null,
      projectType: enriched.projectType || null,
      websiteUrl: enriched.websiteUrl || null,
    });
    return enriched;
  } catch (error) {
    logMarketplaceInstallStep("Modrinth project metadata unavailable for manual download.", {
      provider: "modrinth",
      projectId,
      versionId: context.versionId || null,
      fileName: context.fileName || null,
      reason: error?.message || "metadata lookup failed",
      code: error?.code || null,
      recovery: "continue-with-manual-download-fallback-url",
    });
    return {
      ...context,
      provider: "modrinth",
      providerName: "Modrinth",
      downloadPageUrl: getOfficialProviderUrl({ ...context, provider: "modrinth" }),
    };
  }
}

function logSkippedCurseForgeRestrictedFile(error, context = {}) {
  logMarketplaceInstallStep("Skipping restricted CurseForge dependency file.", {
    provider: "curseforge",
    ...context,
    status: error?.details?.status || error?.status || null,
    reason: error?.message || "CurseForge denied file download access.",
    url: error?.details?.url || null,
    responseBody: error?.details?.body || error?.details?.responseBody || null,
    recovery: "skipped-restricted-file",
  });
}

function createRestrictedCurseForgeFileError(error, context = {}) {
  const fileName = context.fileName || error?.details?.fileName || "unknown file";
  const projectId = context.projectId || error?.details?.projectId || "unknown project";
  const fileId = context.fileId || error?.details?.fileId || "unknown file id";
  return new MarketplaceInstallError(
    `A required modpack file needs manual download: ${fileName}.`,
    "PROVIDER_REQUIRED_FILE_RESTRICTED",
    {
      provider: "curseforge",
      providerName: "CurseForge",
      originalCode: "CURSEFORGE_REQUIRED_FILE_RESTRICTED",
      friendlyMessage: "This provider does not allow AnxOS to download one required file automatically.",
      recoveryState: "waiting-manual-download",
      fileName,
      file: fileName,
      projectId,
      fileId,
      projectName: context.projectName || null,
      projectSlug: context.projectSlug || null,
      websiteUrl: context.websiteUrl || null,
      projectUrl: context.projectUrl || context.websiteUrl || null,
      downloadPageUrl: getOfficialProviderUrl({ ...context, provider: "curseforge", projectId, fileId, fileName }),
      expectedDestinationPath: context.expectedDestinationPath || `mods/${safeArchivePath(fileName)}`,
      dependencyType: context.dependencyType || "required",
      status: error?.details?.status || error?.status || null,
      body: error?.details?.body || error?.details?.responseBody || null,
      url: error?.details?.url || null,
      reason: error?.message || "CurseForge denied file download access.",
      suggestion: "Download/import the missing file manually, or choose another pack/server version.",
      cause: serializeError(error),
    }
  );
}

function getManualRequirementId(context = {}) {
  return [
    context.provider || "provider",
    context.projectId || context.projectSlug || "project",
    context.versionId || "version",
    context.fileId || context.hash || context.fileName || context.expectedDestinationPath || "file",
  ].map((part) => String(part || "").replace(/[^a-z0-9_.-]+/gi, "-")).join(":");
}

function getOfficialProviderUrl(context = {}) {
  if (context.downloadPageUrl) return context.downloadPageUrl;
  const provider = String(context.provider || "").toLowerCase();
  if (provider === "modrinth") {
    if (context.websiteUrl && !context.versionId) return context.websiteUrl;
    if (context.projectUrl && !context.versionId) return context.projectUrl;
    const projectType = String(context.projectType || "project").trim().toLowerCase() || "project";
    const slug = context.projectSlug || null;
    if (slug && context.versionId) return `https://modrinth.com/${encodeURIComponent(projectType)}/${encodeURIComponent(slug)}/version/${encodeURIComponent(context.versionId)}`;
    if (slug) return `https://modrinth.com/${encodeURIComponent(projectType)}/${encodeURIComponent(slug)}`;
    const searchTerm = context.projectName || context.fileName || context.projectId;
    if (searchTerm) return `https://modrinth.com/search?query=${encodeURIComponent(searchTerm)}`;
  }
  if (provider === "curseforge") {
    if (context.websiteUrl) return context.websiteUrl;
    if (context.projectUrl) return context.projectUrl;
    const searchTerm = context.projectName || context.projectSlug || context.fileName || context.projectId;
    if (searchTerm) return `https://www.curseforge.com/minecraft/search?search=${encodeURIComponent(searchTerm)}`;
  }
  if (context.projectUrl) return context.projectUrl;
  if (context.websiteUrl) return context.websiteUrl;
  return "";
}

function createManualDownloadRequiredError(error, context = {}) {
  const provider = String(context.provider || error?.details?.provider || "provider").toLowerCase();
  const providerName = context.providerName || titleCaseProvider(provider);
  const fileName = context.fileName || context.file || error?.details?.fileName || error?.details?.file || "required-file";
  const expectedDestinationPath = context.expectedDestinationPath || `mods/${safeArchivePath(path.basename(fileName))}`;
  const details = {
    ...(error?.details || {}),
    ...context,
    provider,
    providerName,
    originalCode: context.originalCode || error?.code || error?.details?.originalCode || `${provider.toUpperCase()}_REQUIRED_FILE_RESTRICTED`,
    friendlyMessage: "This provider does not allow AnxOS to download one required file automatically.",
    recoveryState: "waiting-manual-download",
    fileName,
    file: fileName,
    expectedDestinationPath,
    requirementId: getManualRequirementId({ ...context, provider, fileName, expectedDestinationPath }),
    downloadPageUrl: getOfficialProviderUrl({ ...context, provider, fileName, expectedDestinationPath }),
    suggestion: context.suggestion || "Download the required file from the official provider page, then import it to continue the installation.",
    reason: context.reason || error?.message || "Provider requires manual download.",
    cause: serializeError(error),
  };
  return new MarketplaceInstallError(
    `A required modpack file needs manual download: ${fileName}.`,
    "PROVIDER_MANUAL_DOWNLOAD_REQUIRED",
    details
  );
}

function isManualDownloadRequiredError(error) {
  const code = error?.code || error?.details?.code || "";
  const message = String(error?.message || error?.details?.reason || error?.details?.message || "").toLowerCase();
  return [
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
  ].includes(code) || error?.details?.recoveryState === "waiting-manual-download" || /manual download|required file|restricted|download url/i.test(message);
}

function getImportedManualFile(manualFiles = {}, requirementId) {
  return manualFiles?.[requirementId] || null;
}

function pruneExpiredManualInstalls() {
  const now = Date.now();
  for (const [id, existing] of pendingManualInstalls) {
    if (now - Date.parse(existing.createdAt || "") > MANUAL_INSTALL_SESSION_TTL_MS) {
      pendingManualInstalls.delete(id);
    }
  }
}

function createPendingManualInstall(context = {}) {
  pruneExpiredManualInstalls();
  const manual = context.manual || {};
  const sessionId = `manual-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const session = {
    id: sessionId,
    nodeId: context.nodeId || context.agentConfig?.nodeId || null,
    status: "waiting-manual-download",
    createdAt: new Date().toISOString(),
    importedFiles: {},
    ...context,
    manual: {
      ...manual,
      sessionId,
      requirementId: manual.requirementId || getManualRequirementId(manual),
      providerName: manual.providerName || titleCaseProvider(manual.provider),
      downloadPageUrl: getOfficialProviderUrl(manual),
    },
  };
  pendingManualInstalls.set(sessionId, session);
  return session;
}

function getPublicManualInstall(session) {
  const manual = session?.manual || {};
  return {
    sessionId: session?.id || manual.sessionId || "",
    nodeId: session?.nodeId || null,
    status: session?.status || "waiting-manual-download",
    provider: manual.provider || "",
    providerName: manual.providerName || titleCaseProvider(manual.provider),
    projectName: manual.projectName || null,
    projectId: manual.projectId || null,
    projectSlug: manual.projectSlug || null,
    websiteUrl: manual.websiteUrl || null,
    projectType: manual.projectType || null,
    versionId: manual.versionId || null,
    fileId: manual.fileId || null,
    fileName: manual.fileName || manual.file || null,
    expectedDestinationPath: manual.expectedDestinationPath || null,
    hash: manual.hash || null,
    size: manual.size || null,
    downloadPageUrl: manual.downloadPageUrl || "",
    projectUrl: manual.projectUrl || "",
    reason: manual.reason || null,
    suggestion: manual.suggestion || "Download/import the missing file manually, or choose another pack/server version.",
    canImport: true,
    canResume: Object.prototype.hasOwnProperty.call(session?.importedFiles || {}, manual.requirementId),
  };
}

function normalizeFileNameForMatch(value) {
  return path.basename(String(value || ""))
    .trim()
    .toLowerCase();
}

function normalizeFileStemForMatch(value) {
  const fileName = normalizeFileNameForMatch(value);
  const ext = path.extname(fileName);
  return fileName.slice(0, fileName.length - ext.length).replace(/[^a-z0-9]+/g, "");
}

function hasCloseFileNameMatch(actualName, expectedName) {
  const normalizedActual = normalizeFileNameForMatch(actualName);
  const normalizedExpected = normalizeFileNameForMatch(expectedName);
  if (!normalizedActual || !normalizedExpected) {
    return false;
  }
  if (normalizedActual === normalizedExpected) {
    return true;
  }
  const actualExt = path.extname(normalizedActual);
  const expectedExt = path.extname(normalizedExpected);
  if (actualExt !== expectedExt) {
    return false;
  }
  const actualStem = normalizeFileStemForMatch(normalizedActual);
  const expectedStem = normalizeFileStemForMatch(normalizedExpected);
  return actualStem === expectedStem ||
    actualStem.includes(expectedStem) ||
    expectedStem.includes(actualStem);
}

function verifyImportedFile(filePath, manual = {}) {
  const stat = fs.statSync(filePath);
  const expectedName = manual.fileName || manual.file;
  const actualName = path.basename(filePath);
  if (expectedName && !hasCloseFileNameMatch(actualName, expectedName)) {
    throw new MarketplaceInstallError(
      `Selected file does not match the expected file name (${path.basename(expectedName)}).`,
      "PROVIDER_IMPORT_FILE_NAME_MISMATCH",
      {
        expectedFileName: path.basename(expectedName),
        actualFileName: actualName,
      }
    );
  }
  if (manual.size && Number(manual.size) !== stat.size) {
    throw new MarketplaceInstallError(`Selected file size does not match ${manual.size} bytes.`, "PROVIDER_IMPORT_FILE_SIZE_MISMATCH", {
      expectedSize: Number(manual.size),
      actualSize: stat.size,
    });
  }
  const buffer = fs.readFileSync(filePath);
  const sha1 = crypto.createHash("sha1").update(buffer).digest("hex");
  const sha512 = crypto.createHash("sha512").update(buffer).digest("hex");
  const expectedHash = manual.hash || manual.sha1 || manual.sha512;
  if (expectedHash && ![sha1, sha512].includes(String(expectedHash).toLowerCase())) {
    throw new MarketplaceInstallError("Selected file hash does not match the expected provider metadata.", "PROVIDER_IMPORT_FILE_HASH_MISMATCH", {
      expectedHash,
      sha1,
      sha512,
    });
  }
  return { buffer, size: stat.size, sha1, sha512, fileName: actualName };
}

function extractXmlTag(xml, tagName) {
  const match = String(xml || "").match(new RegExp(`<${tagName}>([^<]+)</${tagName}>`));
  return match ? match[1].trim() : "";
}

function extractXmlTags(xml, tagName) {
  return [...String(xml || "").matchAll(new RegExp(`<${tagName}>([^<]+)</${tagName}>`, "g"))].map((match) => match[1].trim());
}

function inferNeoForgeMinecraftVersion(version) {
  const text = String(version || "");
  const literal = text.match(/\b1\.\d+(?:\.\d+)?\b/)?.[0];
  if (literal) {
    return literal;
  }
  const modern = text.match(/^(\d{2})\.(\d+)\./);
  return modern ? `1.${Number.parseInt(modern[1], 10)}.${Number.parseInt(modern[2], 10)}` : "";
}

function safeArchivePath(entryPath) {
  const raw = String(entryPath || "");
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:\//.test(normalized) || normalized.length > MAX_ARCHIVE_PATH_LENGTH) {
    throw new MarketplaceInstallError(`Archive contains an unsafe path: ${entryPath}`, "ARCHIVE_PATH_UNSAFE", { entryPath });
  }
  const clean = path.posix.normalize(normalized);
  if (!clean || clean === "." || clean.startsWith("../") || clean === ".." || path.posix.isAbsolute(clean)) {
    throw new MarketplaceInstallError(`Archive contains an unsafe path: ${entryPath}`, "ARCHIVE_PATH_UNSAFE", { entryPath });
  }
  return clean;
}

function validateZipDirectory(directory = {}) {
  const files = Array.isArray(directory.files) ? directory.files : [];
  if (files.length > MAX_ARCHIVE_ENTRY_COUNT) {
    throw new MarketplaceInstallError("Archive contains too many entries.", "ARCHIVE_LIMIT_EXCEEDED", { entryCount: files.length, maxEntryCount: MAX_ARCHIVE_ENTRY_COUNT });
  }
  let expandedBytes = 0;
  for (const entry of files) {
    safeArchivePath(entry.path);
    if (entry.type === "Directory") continue;
    const uncompressedBytes = Math.max(0, Number(entry.uncompressedSize) || 0);
    const compressedBytes = Math.max(0, Number(entry.compressedSize) || 0);
    if (uncompressedBytes > MAX_ARCHIVE_ENTRY_BYTES) {
      throw new MarketplaceInstallError("Archive entry exceeds the supported expanded size.", "ARCHIVE_LIMIT_EXCEEDED", { entryPath: entry.path, uncompressedBytes, maxEntryBytes: MAX_ARCHIVE_ENTRY_BYTES });
    }
    expandedBytes += uncompressedBytes;
    if (expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
      throw new MarketplaceInstallError("Archive exceeds the supported expanded size.", "ARCHIVE_LIMIT_EXCEEDED", { expandedBytes, maxExpandedBytes: MAX_ARCHIVE_EXPANDED_BYTES });
    }
    if (uncompressedBytes >= 16 * 1024 * 1024 && compressedBytes > 0 && uncompressedBytes / compressedBytes > MAX_ARCHIVE_COMPRESSION_RATIO) {
      throw new MarketplaceInstallError("Archive has an unsafe compression ratio.", "ARCHIVE_COMPRESSION_UNSAFE", { entryPath: entry.path, compressedBytes, uncompressedBytes, maxRatio: MAX_ARCHIVE_COMPRESSION_RATIO });
    }
  }
  return { entryCount: files.length, expandedBytes };
}

function stripArchiveRoot(entryPath) {
  const safe = safeArchivePath(entryPath);
  if (safe.startsWith("overrides/")) return safe.slice("overrides/".length);
  if (safe.startsWith("server-overrides/")) return safe.slice("server-overrides/".length);
  return safe;
}

async function extractZipBuffer(buffer, onFile, options = {}) {
  logMarketplaceInstallStep("Opening zip archive.", { bytes: Buffer.byteLength(buffer || Buffer.alloc(0)) });
  const directory = await unzipper.Open.buffer(Buffer.from(buffer));
  validateZipDirectory(directory);
  for (const entry of directory.files) {
    throwIfInstallCancelled(options.signal);
    if (entry.type === "Directory") {
      continue;
    }
    const safePath = safeArchivePath(entry.path);
    logMarketplaceInstallStep("Extracting archive entry.", { path: safePath, compressedSize: entry.compressedSize || null, uncompressedSize: entry.uncompressedSize || null });
    const content = await entry.buffer();
    throwIfInstallCancelled(options.signal);
    await onFile(safePath, content);
  }
}

async function extractZipStream(stream, onFile, options = {}) {
  let entryCount = 0;
  let expandedBytes = 0;
  const parser = stream.pipe(unzipper.Parse({ forceStream: true }));
  for await (const entry of parser) {
    throwIfInstallCancelled(options.signal);
    const entryPath = safeArchivePath(entry.path);
    if (entry.type === "Directory") {
      entry.autodrain();
      continue;
    }
    entryCount += 1;
    if (entryCount > MAX_ARCHIVE_ENTRY_COUNT) {
      entry.autodrain();
      throw new MarketplaceInstallError("Archive contains too many entries.", "ARCHIVE_LIMIT_EXCEEDED", {
        entryCount,
        maxEntries: MAX_ARCHIVE_ENTRY_COUNT,
      });
    }
    const uncompressedBytes = Math.max(0, Number(entry.vars?.uncompressedSize) || 0);
    const compressedBytes = Math.max(0, Number(entry.vars?.compressedSize) || 0);
    if (uncompressedBytes > MAX_ARCHIVE_ENTRY_BYTES) {
      entry.autodrain();
      throw new MarketplaceInstallError("Archive entry exceeds the supported expanded size.", "ARCHIVE_LIMIT_EXCEEDED", {
        entryPath,
        uncompressedBytes,
        maxEntryBytes: MAX_ARCHIVE_ENTRY_BYTES,
      });
    }
    expandedBytes += uncompressedBytes;
    if (expandedBytes > MAX_ARCHIVE_EXPANDED_BYTES) {
      entry.autodrain();
      throw new MarketplaceInstallError("Archive exceeds the supported expanded size.", "ARCHIVE_LIMIT_EXCEEDED", {
        expandedBytes,
        maxExpandedBytes: MAX_ARCHIVE_EXPANDED_BYTES,
      });
    }
    if (
      uncompressedBytes >= 16 * 1024 * 1024
      && compressedBytes > 0
      && uncompressedBytes / compressedBytes > MAX_ARCHIVE_COMPRESSION_RATIO
    ) {
      entry.autodrain();
      throw new MarketplaceInstallError("Archive has an unsafe compression ratio.", "ARCHIVE_COMPRESSION_UNSAFE", {
        entryPath,
        compressedBytes,
        uncompressedBytes,
        maxRatio: MAX_ARCHIVE_COMPRESSION_RATIO,
      });
    }
    const content = await entry.buffer();
    throwIfInstallCancelled(options.signal);
    await onFile(entryPath, content);
  }
}

function createDeduper() {
  const seen = new Set();
  return {
    has(key) {
      return seen.has(String(key || ""));
    },
    add(key) {
      const value = String(key || "");
      if (!value || seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    },
    size() {
      return seen.size;
    },
  };
}

async function writeText(instanceId, filePath, content, agentConfig) {
  logMarketplaceInstallStep("Writing text file.", { instanceId, filePath, bytes: Buffer.byteLength(String(content || ""), "utf8") });
  return withRetry(
    () => agentClient.writeInstanceFile(instanceId, filePath, content, { config: agentConfig }),
    { label: "agent write text", attempts: 3 }
  );
}

async function writeBuffer(instanceId, filePath, buffer, agentConfig) {
  logMarketplaceInstallStep("Writing binary file.", { instanceId, filePath, bytes: Buffer.byteLength(buffer || Buffer.alloc(0)) });
  return withRetry(
    () => agentClient.writeInstanceFile(instanceId, filePath, Buffer.from(buffer).toString("base64"), {
      encoding: "base64",
      config: agentConfig,
    }),
    { label: "agent write binary", attempts: 3 }
  );
}

async function writeIfMissing(instanceId, filePath, buffer, agentConfig) {
  const exists = await withRetry(
    () => agentClient.instanceFileExists(instanceId, filePath, agentConfig),
    { label: "agent file exists", attempts: 3 }
  );
  if (exists?.exists) {
    logMarketplaceInstallStep("Skipping existing file.", { instanceId, filePath });
    return false;
  }
  await writeBuffer(instanceId, filePath, buffer, agentConfig);
  return true;
}

async function validateInstalledServerJar(instanceId, serverInfo, agentConfig) {
  const serverJar = String(serverInfo?.serverJar || "").trim();
  if (!serverJar) {
    throw new MarketplaceInstallError("Marketplace install did not configure a server jar.", "SERVER_JAR_NOT_CONFIGURED", {
      instanceId,
      suggestion: "Install failed before launch metadata could be written.",
    });
  }
  const exists = await withRetry(
    () => agentClient.instanceFileExists(instanceId, serverJar, agentConfig),
    { label: "validate installed server jar", attempts: 3 }
  );
  if (!exists?.exists) {
    throw new MarketplaceInstallError(`Marketplace install did not create the configured server jar: ${serverJar}.`, "SERVER_JAR_MISSING", {
      instanceId,
      fileName: serverJar,
      recovery: "install-failed-before-success",
      suggestion: "Retry the Marketplace install; the server runtime download or loader installer did not produce the expected jar.",
    });
  }
  return {
    serverJar,
    exists,
  };
}

function isWindowsInstallTarget(options = {}, agentConfig = {}) {
  const platform = String(
    options.platform ||
      options.agentPlatform ||
      agentConfig.platform ||
      agentConfig.operatingSystem ||
      agentConfig.nodePlatform ||
      ""
  ).toLowerCase();
  return platform.includes("win");
}

function getPreferredStartupScriptCandidates(options = {}, agentConfig = {}) {
  return isWindowsInstallTarget(options, agentConfig)
    ? ["startserver.bat", "run.bat", "start.bat", "startserver.cmd", "run.cmd", "start.cmd", "startserver.sh", "run.sh"]
    : ["run.sh", "startserver.sh", "start.sh", "startserver.bat", "run.bat", "start.bat", "startserver.cmd", "run.cmd", "start.cmd"];
}

function buildStartupScriptPatch(scriptPath) {
  const script = String(scriptPath || "").trim().replace(/\\/g, "/");
  const basename = path.basename(script).toLowerCase();
  const relative = script.startsWith("./") ? script : `./${script}`;
  if (basename.endsWith(".sh")) {
    return {
      executable: "bash",
      args: [relative],
      startupArguments: [relative],
      startupScript: script,
    };
  }
  if (basename.endsWith(".bat") || basename.endsWith(".cmd")) {
    return {
      executable: "cmd.exe",
      args: ["/c", relative],
      startupArguments: ["/c", relative],
      startupScript: script,
    };
  }
  return null;
}

function isInstallerJarName(value = "") {
  return /(?:^|\/)(?:forge|neoforge)(?:-[^/]+)?-installer\.jar$/i.test(String(value || "").replace(/\\/g, "/")) ||
    /(?:^|\/)(?:forge|neoforge)-installer\.jar$/i.test(String(value || "").replace(/\\/g, "/"));
}

function createServerPackRuntimeUnresolvedError(message, details = {}) {
  return new MarketplaceInstallError(message || "Server-pack runtime could not be resolved safely.", "SERVER_PACK_RUNTIME_UNRESOLVED", {
    ...details,
    retryable: false,
    suggestion: details.suggestion || "Reinstall this instance from a server-compatible pack that includes a valid launch script or server runtime.",
  });
}

async function readInstanceText(instanceId, filePath, agentConfig) {
  try {
    const result = await agentClient.readInstanceFile(instanceId, filePath, agentConfig);
    return result?.supported === false ? "" : String(result?.content || "");
  } catch {
    return "";
  }
}

async function listInstanceDirectoryEntries(instanceId, directoryPath, agentConfig) {
  try {
    const result = await agentClient.listInstanceFiles(instanceId, directoryPath, agentConfig);
    return Array.isArray(result?.entries) ? result.entries : [];
  } catch {
    return [];
  }
}

async function findRootFileNames(instanceId, agentConfig) {
  return (await listInstanceDirectoryEntries(instanceId, ".", agentConfig))
    .filter((entry) => entry.type === "file" || entry.isDirectory === false)
    .map((entry) => entry.name)
    .filter(Boolean);
}

function extractNeoForgeUnixArgsReferences(scriptText = "") {
  const refs = [];
  const pattern = /(?:^|[@'"=\s])((?:\.\/)?libraries\/net\/neoforged\/neoforge\/([^\/\s'"`]+)\/unix_args\.txt)\b/gi;
  let match;
  while ((match = pattern.exec(String(scriptText || "")))) {
    refs.push({
      relativePath: match[1].replace(/^\.\//, ""),
      version: match[2],
    });
  }
  return refs;
}

function extractInstallerJarReferences(scriptText = "") {
  return [...new Set([...String(scriptText || "").matchAll(/(?:^|[\s"'`])((?:\.\/)?(?:forge|neoforge)(?:-[0-9A-Za-z][0-9A-Za-z._+-]*)?-installer\.jar)\b/gi)]
    .map((match) => match[1].replace(/^\.\//, "")))];
}

function parseVersionedInstaller(fileName = "") {
  const name = path.basename(String(fileName || ""));
  const neoForge = name.match(/^neoforge-([0-9A-Za-z][0-9A-Za-z._+-]*)-installer\.jar$/i);
  if (neoForge) {
    return {
      loader: "neoforge",
      serverSoftware: "NeoForge",
      loaderVersion: neoForge[1],
      minecraftVersion: inferNeoForgeMinecraftVersion(neoForge[1]) || null,
      fileName: name,
      versioned: true,
    };
  }
  const forge = name.match(/^forge-([0-9A-Za-z][0-9A-Za-z._+-]*)-installer\.jar$/i);
  if (forge) {
    return {
      loader: "forge",
      serverSoftware: "Forge",
      loaderVersion: forge[1],
      minecraftVersion: String(forge[1]).split("-")[0] || null,
      fileName: name,
      versioned: true,
    };
  }
  if (/^neoforge-installer\.jar$/i.test(name)) {
    return { loader: "neoforge", serverSoftware: "NeoForge", loaderVersion: null, minecraftVersion: null, fileName: name, versioned: false };
  }
  if (/^forge-installer\.jar$/i.test(name)) {
    return { loader: "forge", serverSoftware: "Forge", loaderVersion: null, minecraftVersion: null, fileName: name, versioned: false };
  }
  return null;
}

function selectInstallerCandidate(rootFiles = [], context = {}) {
  const candidates = rootFiles.map(parseVersionedInstaller).filter(Boolean);
  const expectedNeoForgeVersion = context.neoForgeVersion || null;
  const referenced = new Set((context.referencedInstallers || []).map((entry) => path.basename(String(entry || "")).toLowerCase()));
  return candidates.sort((left, right) => {
    const score = (candidate) => {
      let value = 0;
      if (referenced.has(candidate.fileName.toLowerCase())) value += 1000;
      if (expectedNeoForgeVersion && candidate.loader === "neoforge" && candidate.loaderVersion === expectedNeoForgeVersion) value += 900;
      if (candidate.versioned) value += 500;
      if (candidate.loader === normalizeLoader(context.loader || "")) value += 100;
      return value;
    };
    return score(right) - score(left) || left.fileName.localeCompare(right.fileName);
  })[0] || null;
}

function buildRuntimeVersionInfo(runtime = {}, options = {}) {
  const software = runtime.serverSoftware || (runtime.loader === "neoforge" ? "NeoForge" : runtime.loader === "forge" ? "Forge" : options.loader || options.serverType || "Minecraft");
  const gameVersion = runtime.minecraftVersion || options.minecraftVersion || options.version || null;
  const softwareVersion = runtime.loaderVersion || null;
  return {
    game: "minecraft",
    gameVersion,
    minecraftVersion: gameVersion,
    software,
    softwareVersion,
    displayVersion: [software, gameVersion].filter(Boolean).join(" ") || gameVersion || software || null,
    displayVersionDetail: softwareVersion ? `${software} ${softwareVersion}` : null,
  };
}

async function resolveServerPackRuntime(instanceId, startupTarget = {}, options = {}, agentConfig = {}) {
  const rootFiles = await findRootFileNames(instanceId, agentConfig);
  const scriptPath = startupTarget.type === "script" ? startupTarget.path : null;
  const scriptText = scriptPath ? await readInstanceText(instanceId, scriptPath, agentConfig) : "";
  const unixRefs = extractNeoForgeUnixArgsReferences(scriptText);
  const referencedInstallers = extractInstallerJarReferences(scriptText);
  const expectedNeoForgeVersion = unixRefs[0]?.version || null;

  if (startupTarget.type === "script") {
    if (/^run\.sh$/i.test(path.basename(scriptPath)) && expectedNeoForgeVersion) {
      const missing = [];
      for (const ref of unixRefs) {
        const exists = await agentClient.instanceFileExists(instanceId, ref.relativePath, agentConfig);
        if (!exists?.exists) missing.push(ref.relativePath);
      }
      if (missing.length > 0) {
        const availableVersions = (await listInstanceDirectoryEntries(instanceId, "libraries/net/neoforged/neoforge", agentConfig))
          .filter((entry) => entry.isDirectory || entry.type === "directory")
          .map((entry) => entry.name)
          .filter(Boolean);
        throw createServerPackRuntimeUnresolvedError("Server-pack runtime could not be resolved safely: run.sh references missing NeoForge unix_args.txt.", {
          instanceId,
          startupScript: scriptPath,
          missing,
          expectedVersion: expectedNeoForgeVersion,
          availableVersions,
        });
      }
    }

    const installer = selectInstallerCandidate(rootFiles, {
      loader: options.loader,
      neoForgeVersion: expectedNeoForgeVersion,
      referencedInstallers,
    });
    const runtime = {
      type: "script",
      startupScript: scriptPath,
      serverJar: installer?.fileName || null,
      loader: expectedNeoForgeVersion ? "neoforge" : installer?.loader || normalizeLoader(options.loader || options.serverType),
      serverSoftware: expectedNeoForgeVersion ? "NeoForge" : installer?.serverSoftware || options.loader || options.serverType || "Minecraft",
      loaderVersion: expectedNeoForgeVersion || installer?.loaderVersion || null,
      minecraftVersion: expectedNeoForgeVersion ? inferNeoForgeMinecraftVersion(expectedNeoForgeVersion) || options.minecraftVersion || options.version || null : installer?.minecraftVersion || options.minecraftVersion || options.version || null,
      installerFile: installer?.fileName || null,
      unixArgsPath: unixRefs[0]?.relativePath || null,
      serverPackRuntimePreserved: true,
      requiresInstallerBootstrap: Boolean(
        (expectedNeoForgeVersion || normalizeLoader(options.loader || options.serverType) === "neoforge" || installer?.loader === "neoforge") &&
        unixRefs.length === 0
      ),
    };
    runtime.versionInfo = buildRuntimeVersionInfo(runtime, options);
    return runtime;
  }

  const jarCandidates = ["server.jar", "minecraft_server.jar", ...rootFiles.filter((name) => /\.jar$/i.test(name) && !isInstallerJarName(name))];
  for (const jar of [...new Set(jarCandidates)]) {
    const exists = await agentClient.instanceFileExists(instanceId, jar, agentConfig);
    if (exists?.exists) {
      const runtime = {
        type: "jar",
        serverJar: jar,
        loader: normalizeLoader(options.loader || options.serverType) || "vanilla",
        serverSoftware: options.loader || options.serverType || "Minecraft",
        loaderVersion: null,
        minecraftVersion: options.minecraftVersion || options.version || null,
        serverPackRuntimePreserved: true,
      };
      runtime.versionInfo = buildRuntimeVersionInfo(runtime, options);
      return runtime;
    }
  }

  throw createServerPackRuntimeUnresolvedError("Server-pack runtime could not be resolved safely: no launch script or server jar was found.", {
    instanceId,
    rootFiles,
  });
}

async function resolveInstalledStartupTarget(instanceId, serverInfo = {}, options = {}, agentConfig = {}) {
  for (const candidate of getPreferredStartupScriptCandidates(options, agentConfig)) {
    const exists = await withRetry(
      () => agentClient.instanceFileExists(instanceId, candidate, agentConfig),
      { label: "detect startup script", attempts: 3 }
    );
    if (exists?.exists) {
      const patch = buildStartupScriptPatch(candidate);
      if (patch) {
        return {
          type: "script",
          path: candidate,
          patch,
        };
      }
    }
  }

  return {
    type: "jar",
    path: serverInfo.serverJar || "server.jar",
    patch: null,
  };
}

async function resolveVanillaServerJar(minecraftVersion) {
  const manifest = await fetchJson("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json", "Mojang version manifest");
  const versionId = minecraftVersion && minecraftVersion !== "latest"
    ? minecraftVersion
    : manifest.latest?.release;
  const version = (manifest.versions || []).find((entry) => entry.id === versionId);
  if (!version?.url) {
    throw new MarketplaceInstallError("No matching Minecraft server jar was found.", "MOJANG_VERSION_NOT_FOUND");
  }
  const metadata = await fetchJson(version.url, "Mojang version metadata");
  if (!metadata.downloads?.server?.url) {
    throw new MarketplaceInstallError("Selected Minecraft version has no server jar.", "MOJANG_SERVER_JAR_MISSING");
  }
  return { url: metadata.downloads.server.url, fileName: "server.jar", serverJar: "server.jar", minecraftVersion: versionId };
}

async function resolvePaperServerJar(minecraftVersion, project = "paper") {
  const projectMeta = await fetchJson(`${PAPER_DOWNLOADS_API}/projects/${encodeURIComponent(project)}`, "Paper Downloads project metadata");
  const versionGroups = projectMeta.versions && typeof projectMeta.versions === "object" && !Array.isArray(projectMeta.versions)
    ? Object.values(projectMeta.versions).flat()
    : projectMeta.versions || [];
  const versionId = minecraftVersion && minecraftVersion !== "latest"
    ? minecraftVersion
    : versionGroups[0];
  if (!versionId) {
    throw new MarketplaceInstallError("No Paper version was found.", "PAPER_VERSION_NOT_FOUND", {
      url: `${PAPER_DOWNLOADS_API}/projects/${encodeURIComponent(project)}`,
    });
  }
  const buildsPayload = await fetchJson(`${PAPER_DOWNLOADS_API}/projects/${encodeURIComponent(project)}/versions/${encodeURIComponent(versionId)}/builds`, "Paper Downloads builds");
  const builds = Array.isArray(buildsPayload) ? buildsPayload : buildsPayload.builds || [];
  const build = [...builds].reverse().find((entry) => entry?.downloads?.["server:default"]?.url) ||
    [...builds].reverse().find((entry) => entry?.downloads && Object.keys(entry.downloads).length > 0);
  const serverDownload = build?.downloads?.["server:default"] || build?.downloads?.server || Object.values(build?.downloads || {})[0];
  if (!build?.id || !serverDownload?.url || !serverDownload?.name) {
    throw new MarketplaceInstallError("No Paper server jar was found in the Paper Downloads API response.", "PAPER_VERSION_NOT_FOUND", {
      url: `${PAPER_DOWNLOADS_API}/projects/${encodeURIComponent(project)}/versions/${encodeURIComponent(versionId)}/builds`,
      body: truncateForLog(JSON.stringify(buildsPayload)),
    });
  }
  return {
    url: serverDownload.url,
    fileName: serverDownload.name,
    serverJar: "server.jar",
    minecraftVersion: versionId,
    loaderVersion: String(build.id),
  };
}

async function resolvePurpurServerJar(minecraftVersion) {
  const project = await fetchJson("https://api.purpurmc.org/v2/purpur", "Purpur project metadata");
  const versionId = minecraftVersion && minecraftVersion !== "latest"
    ? minecraftVersion
    : (project.versions || [])[project.versions.length - 1];
  const builds = await fetchJson(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(versionId)}`, "Purpur builds");
  const latest = builds.builds?.latest;
  if (!latest) {
    throw new MarketplaceInstallError("No Purpur server jar was found.", "PURPUR_VERSION_NOT_FOUND");
  }
  return {
    url: `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(versionId)}/${encodeURIComponent(String(latest))}/download`,
    fileName: "purpur.jar",
    serverJar: "server.jar",
    minecraftVersion: versionId,
    loaderVersion: String(latest),
  };
}

async function resolveFabricServerJar(minecraftVersion, loaderVersion = "") {
  const loaders = await fetchJson("https://meta.fabricmc.net/v2/versions/loader", "Fabric loader metadata");
  const installers = await fetchJson("https://meta.fabricmc.net/v2/versions/installer", "Fabric installer metadata");
  const loader = loaderVersion && loaderVersion !== "latest"
    ? loaderVersion
    : loaders.find((entry) => entry.stable)?.version || loaders[0]?.version;
  const installer = installers.find((entry) => entry.stable)?.version || installers[0]?.version;
  if (!minecraftVersion || minecraftVersion === "latest") {
    throw new MarketplaceInstallError("Select a Minecraft version for Fabric installs.", "FABRIC_VERSION_REQUIRED");
  }
  return {
    url: `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(minecraftVersion)}/${encodeURIComponent(loader)}/${encodeURIComponent(installer)}/server/jar`,
    fileName: "fabric-server.jar",
    serverJar: "fabric-server.jar",
    minecraftVersion,
    loaderVersion: loader,
  };
}

async function resolveQuiltServerJar(minecraftVersion, loaderVersion = "") {
  const loaders = await fetchJson("https://meta.quiltmc.org/v3/versions/loader", "Quilt loader metadata");
  const installers = await fetchJson("https://meta.quiltmc.org/v3/versions/installer", "Quilt installer metadata");
  const loader = loaderVersion && loaderVersion !== "latest"
    ? loaderVersion
    : loaders[0]?.version;
  const installer = installers[0];
  if (!minecraftVersion || minecraftVersion === "latest") {
    throw new MarketplaceInstallError("Select a Minecraft version for Quilt installs.", "QUILT_VERSION_REQUIRED");
  }
  if (!installer?.url || !loader) {
    throw new MarketplaceInstallError("No Quilt installer metadata was found.", "QUILT_VERSION_NOT_FOUND");
  }
  return {
    url: installer.url,
    fileName: "quilt-installer.jar",
    downloadDestination: "quilt-installer.jar",
    serverJar: "quilt-server-launch.jar",
    minecraftVersion,
    loaderVersion: loader,
    installer: {
      jar: "quilt-installer.jar",
      args: ["install", "server", minecraftVersion, loader, "--download-server"],
      startup: { executable: "java", args: ["-jar", "quilt-server-launch.jar", "nogui"] },
    },
  };
}

async function resolveForgeInstaller(minecraftVersion) {
  const requestedVersion = minecraftVersion || "latest";
  let forgeVersion = "";
  if (String(requestedVersion).toLowerCase() !== "latest") {
    const promotions = await fetchJson(FORGE_PROMOTIONS_URL, "Forge promotions lookup");
    const promos = promotions?.promos || {};
    const forgeBuild = promos[`${requestedVersion}-recommended`] || promos[`${requestedVersion}-latest`];
    if (forgeBuild) {
      forgeVersion = `${requestedVersion}-${forgeBuild}`;
    }
  }
  if (!forgeVersion) {
    const metadata = await fetchText(FORGE_MAVEN_METADATA_URL, "Forge metadata lookup");
    const versions = extractXmlTags(metadata, "version");
    if (String(requestedVersion).toLowerCase() !== "latest") {
      forgeVersion = versions.filter((version) => String(version).startsWith(`${requestedVersion}-`)).at(-1) || "";
    }
    forgeVersion = forgeVersion || extractXmlTag(metadata, "release") || extractXmlTag(metadata, "latest");
  }
  if (!forgeVersion) {
    throw new MarketplaceInstallError("Unable to download Forge installer.", "FORGE_RESOLVE_FAILED");
  }
  return {
    url: `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(forgeVersion)}/forge-${encodeURIComponent(forgeVersion)}-installer.jar`,
    fileName: "forge-installer.jar",
    serverJar: "forge-installer.jar",
    minecraftVersion: forgeVersion.split("-")[0],
    loaderVersion: forgeVersion,
    installer: { jar: "forge-installer.jar", args: ["--installServer"], startup: { executable: "bash", args: ["run.sh", "nogui"] } },
  };
}

async function resolveNeoForgeInstaller(minecraftVersion) {
  const requestedVersion = minecraftVersion || "latest";
  const metadata = await fetchText(NEOFORGE_MAVEN_METADATA_URL, "NeoForge metadata lookup");
  const versions = extractXmlTags(metadata, "version");
  let neoForgeVersion = extractXmlTag(metadata, "release") || extractXmlTag(metadata, "latest");
  if (String(requestedVersion).toLowerCase() !== "latest") {
    neoForgeVersion = versions.filter((version) => inferNeoForgeMinecraftVersion(version) === String(requestedVersion)).at(-1) ||
      versions.filter((version) => version.startsWith(`${requestedVersion}.`)).at(-1) ||
      neoForgeVersion;
  }
  if (!neoForgeVersion) {
    throw new MarketplaceInstallError("Unable to download NeoForge installer.", "NEOFORGE_RESOLVE_FAILED");
  }
  return {
    url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${encodeURIComponent(neoForgeVersion)}/neoforge-${encodeURIComponent(neoForgeVersion)}-installer.jar`,
    fileName: "neoforge-installer.jar",
    serverJar: "neoforge-installer.jar",
    minecraftVersion: String(requestedVersion).toLowerCase() === "latest" ? inferNeoForgeMinecraftVersion(neoForgeVersion) || requestedVersion : requestedVersion,
    loaderVersion: neoForgeVersion,
    installer: { jar: "neoforge-installer.jar", args: ["--installServer"], startup: { executable: "bash", args: ["run.sh", "nogui"] } },
  };
}

async function resolveServerJar(options = {}) {
  const loader = normalizeLoader(options.loader || options.serverType);
  const minecraftVersion = options.minecraftVersion || options.version || "latest";
  if (loader === "paper") return resolvePaperServerJar(minecraftVersion, "paper");
  if (loader === "purpur") return resolvePurpurServerJar(minecraftVersion);
  if (loader === "fabric") return resolveFabricServerJar(minecraftVersion, options.loaderVersion);
  if (loader === "quilt") return resolveQuiltServerJar(minecraftVersion, options.loaderVersion);
  if (loader === "forge") return resolveForgeInstaller(minecraftVersion);
  if (loader === "neoforge") return resolveNeoForgeInstaller(minecraftVersion);
  return resolveVanillaServerJar(minecraftVersion);
}

function createDeferredProviderServerInfo(options = {}) {
  return {
    url: null,
    fileName: "",
    serverJar: null,
    minecraftVersion: options.minecraftVersion || options.version || null,
    loaderVersion: options.loaderVersion || null,
    providerRuntimeDeferred: true,
  };
}

function buildInstancePayload(options, serverInfo) {
  const name = displayName(options.instanceName || options.name || options.displayName);
  const id = slugify(options.instanceId || name);
  const memory = normalizeMemory(options.memory || options.ram || options.memoryLimit, "4G");
  const port = resolveMinecraftPort(options, [25565]);
  return {
    id,
    displayName: name,
    type: "java-app",
    game: "minecraft",
    minecraftVersion: serverInfo.minecraftVersion || options.minecraftVersion || options.version || null,
    serverVersion: serverInfo.minecraftVersion || options.minecraftVersion || options.version || null,
    serverSoftware: options.loader || options.serverType || "Minecraft",
    loader: options.loader || options.serverType || "vanilla",
    loaderVersion: serverInfo.loaderVersion || options.loaderVersion || null,
    provider: options.provider || "marketplace",
    providerProjectId: options.providerProjectId || options.projectId || "",
    providerVersionId: options.providerVersionId || options.versionId || "",
    providerFileId: options.providerFileId || "",
    providerServerPackFileId: options.providerServerPackFileId || "",
    modpackVersion: options.modpackVersion || options.providerResolvedMetadata?.modpackVersion || "",
    workingDirectory: "data",
    executable: "java",
    args: [`-Xmx${memory}`, "-jar", serverInfo.serverJar || "server.jar", "nogui"],
    jar: serverInfo.serverJar || "server.jar",
    serverJar: serverInfo.serverJar || null,
    serverJarPath: serverInfo.serverJar || null,
    startJar: serverInfo.serverJar || null,
    restartPolicy: "on-failure",
    startupTimeoutMs: 60000,
    shutdownTimeoutMs: 15000,
    memoryLimit: memory,
    ports: [port],
    primaryPort: port,
    status: "stopped",
    installationState: "installing",
    tags: ["minecraft", options.provider || "marketplace", options.loader || options.serverType || "vanilla"].filter(Boolean),
  };
}

async function runServerInstaller(instanceId, serverInfo, agentConfig, operationId, signal = null, memory = "4G") {
  if (!serverInfo.installer) {
    return;
  }
  const installerFamily = String(serverInfo.loaderVersion || "").startsWith("neoforge-") || serverInfo.installer.jar === "neoforge-installer.jar"
    ? "neoforge"
    : serverInfo.installer.jar === "forge-installer.jar" ? "forge"
      : serverInfo.installer.jar === "quilt-installer.jar" ? "quilt" : null;
  if (!installerFamily) {
    throw new MarketplaceInstallError("The generated server installer is not in the trusted installer allowlist.", "INSTALLER_FAMILY_NOT_ALLOWED");
  }
  emitProgress({ instanceId, stage: "extracting", message: "Running server loader installer..." });
  const session = await agentClient.beginInstallationSession(instanceId, { operationId, installerFamily }, agentConfig);
  const sessionProof = { operationId, token: session.token };
  let cancellationRequested = false;
  const cancelInstaller = () => {
    cancellationRequested = true;
    agentClient.cancelInstallationSession(instanceId, sessionProof, agentConfig).catch(() => {});
  };
  signal?.addEventListener("abort", cancelInstaller, { once: true });
  try {
    if (signal?.aborted) cancelInstaller();
    await agentClient.executeInstallationPhase(instanceId, {
      ...sessionProof,
      phase: "install-server",
      timeoutMs: 300000,
    }, agentConfig);
    if (cancellationRequested || signal?.aborted) {
      throw new MarketplaceInstallError("Marketplace installation was cancelled.", "INSTALL_CANCELLED");
    }
    await agentClient.closeInstallationSession(instanceId, sessionProof, agentConfig);
  } catch (error) {
    await agentClient.cancelInstallationSession(instanceId, sessionProof, agentConfig).catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancelInstaller);
  }
  let startup = serverInfo.installer.startup || {};
  if (installerFamily === "forge") {
    const legacyServerJar = `forge-${serverInfo.loaderVersion}.jar`;
    const legacyJarStatus = await agentClient.instanceFileExists(instanceId, legacyServerJar, agentConfig);
    if (legacyJarStatus?.exists) {
      serverInfo.serverJar = legacyServerJar;
      startup = { executable: "java", args: [`-Xmx${normalizeMemory(memory, "4G")}`, "-jar", legacyServerJar, "nogui"] };
    }
  }
  await agentClient.updateInstance(instanceId, {
    executable: startup.executable || "bash",
    args: startup.args || ["run.sh", "nogui"],
    startupArguments: startup.args || ["run.sh", "nogui"],
    startupScript: startup.executable === "java" ? null : (startup.args || ["run.sh"])[0] || "run.sh",
    workingDirectory: "data",
    restartPolicy: "on-failure",
    startupTimeoutMs: 60000,
  }, agentConfig);
}

function buildInstallMetadata(options, serverInfo, records) {
  const source = records.source || {};
  return {
    name: displayName(options.instanceName || options.name || options.displayName),
    provider: options.provider || "manual",
    providerProjectId: options.providerProjectId || options.projectId || "",
    providerVersionId: source.modrinthVersion || source.curseForgeFileId || options.providerVersionId || options.versionId || "",
    providerFileId: source.curseForgeFileId || options.providerFileId || "",
    providerServerPackFileId: source.curseForgeServerPackFileId || options.providerServerPackFileId || "",
    minecraftVersion: source.minecraftVersion || serverInfo.minecraftVersion || options.minecraftVersion || options.version || "",
    loader: source.loader || options.loader || options.serverType || "vanilla",
    modpackVersion: source.modpackVersion || options.modpackVersion || "",
    loaderVersion: serverInfo.loaderVersion || options.loaderVersion || "",
    serverJar: serverInfo.serverJar || "server.jar",
    serverJarPath: serverInfo.serverJar || "server.jar",
    startJar: serverInfo.serverJar || "server.jar",
    installedAt: new Date().toISOString(),
    mods: records.mods || [],
    downloads: records.downloads || [],
    source,
  };
}

async function installModrinthPack(instanceId, payload, agentConfig, progressState) {
  const projectId = payload.providerProjectId || payload.projectId;
  ensureProviderProjectId(projectId, "Modrinth");
  emitProgress({ ...progressState, stage: "resolving", message: "Resolving Modrinth version..." });
  const project = payload.modrinthSelectedProject || await modrinthProvider.getProject(projectId);
  ensureModrinthServerCapable(project);
  const version = payload.modrinthSelectedVersion || await modrinthProvider.resolveVersion(projectId, payload.minecraftVersion || payload.version, payload.loader, payload.providerVersionId || payload.versionId);
  const resolvedMetadata = buildModrinthResolvedMetadata(version, project);
  logMarketplaceInstallStep("Resolved Modrinth install version.", {
    provider: "modrinth",
    projectId,
    versionId: resolvedMetadata.providerVersionId || null,
    advertisedMinecraftVersion: resolvedMetadata.minecraftVersion || null,
    loader: resolvedMetadata.loader || null,
    releaseType: resolvedMetadata.releaseType || null,
    serverCompatibilityConfirmed: resolvedMetadata.serverCompatibilityConfirmed,
  });
  const primary = version.primaryFile || version.files?.[0];
  ensureSupportedModpack(primary?.url, "Modrinth", "selected version does not expose downloadable files");
  const mods = [];
  const downloads = [];
  const dedupe = createDeduper();
  const manualFiles = progressState.manualFiles || {};

  if (primary?.filename?.endsWith(".mrpack")) {
    emitProgress({ ...progressState, stage: "downloading", message: "Downloading Modrinth pack..." });
    const pack = await fetchBuffer(primary.url, primary.filename, { signal: progressState.signal });
    emitProgress({ ...progressState, stage: "extracting", message: "Extracting Modrinth overrides..." });
    await extractZipBuffer(pack, async (entryPath, content) => {
      if (entryPath === "modrinth.index.json") {
        const index = JSON.parse(content.toString("utf8"));
        const files = Array.isArray(index.files) ? index.files : [];
        ensureServerFiles(files, "Modrinth");
        let current = 0;
        for (const file of files) {
          current += 1;
          const env = file.env || {};
          if (!payload.allowClientFiles && env.server === "unsupported") {
            continue;
	          }
	          const fileUrl = Array.isArray(file.downloads) ? file.downloads[0] : "";
	          const filePath = safeArchivePath(file.path || "");
	          const requirement = {
	            provider: "modrinth",
	            providerName: "Modrinth",
	            projectId,
	            projectSlug: project.slug || projectId,
	            projectName: project.name || null,
	            projectType: project.projectType || "modpack",
	            websiteUrl: project.websiteUrl || null,
	            versionId: version.id,
	            fileName: path.posix.basename(filePath),
	            expectedDestinationPath: filePath,
	            hash: file.hashes?.sha1 || file.hashes?.sha512 || null,
	            size: file.fileSize || file.size || null,
	            projectUrl: project.projectUrl || null,
	          };
          requirement.requirementId = getManualRequirementId(requirement);
          if (!fileUrl) {
            if (env.server === "unsupported") {
              continue;
            }
	            const enrichedRequirement = await resolveModrinthManualProjectMetadata(requirement);
	            throw createManualDownloadRequiredError({
	              code: "MODRINTH_DOWNLOAD_URL_MISSING",
	              message: `${requirement.fileName || "Modrinth file"} has no download URL.`,
	              details: {
	                status: 404,
	              },
	            }, {
	              ...enrichedRequirement,
	              originalCode: "MODRINTH_DOWNLOAD_URL_MISSING",
	              reason: "The provider did not provide a direct download URL for this required file.",
	            });
          }
          if (!dedupe.add(file.hashes?.sha1 || fileUrl || filePath)) {
            continue;
          }
          if (getImportedManualFile(manualFiles, requirement.requirementId)) {
            mods.push({ file: filePath, sha1: file.hashes?.sha1 || null, provider: "modrinth", manualImport: true });
            downloads.push({ file: filePath, provider: "modrinth-manual-import" });
            continue;
          }
          emitProgress({ ...progressState, stage: "downloading", message: `Downloading ${current}/${files.length} mods...`, current, total: files.length });
          try {
            const modBuffer = await fetchBuffer(fileUrl, path.posix.basename(filePath), { signal: progressState.signal });
            await writeIfMissing(instanceId, filePath, modBuffer, agentConfig);
            mods.push({ file: filePath, sha1: file.hashes?.sha1 || null, provider: "modrinth" });
            downloads.push({ file: filePath, provider: "modrinth" });
	          } catch (error) {
	            if (isProviderManualDownloadRequiredError(error)) {
	              const enrichedRequirement = await resolveModrinthManualProjectMetadata(requirement);
	              throw createManualDownloadRequiredError(error, {
	                ...enrichedRequirement,
	                originalCode: "MODRINTH_REQUIRED_FILE_RESTRICTED",
	              });
	            }
            if (isRecoverableProviderFileError(error)) {
              logMarketplaceInstallFailure(error, {
                provider: "modrinth",
                instanceId,
                fileName: path.posix.basename(filePath),
                url: fileUrl,
                recovery: "skipped-file",
              });
              continue;
            }
            throw error;
          }
        }
        return;
      }
      if (entryPath.startsWith("overrides/") || entryPath.startsWith("server-overrides/")) {
        const target = stripArchiveRoot(entryPath);
        if (target) {
          await writeBuffer(instanceId, target, content, agentConfig);
          downloads.push({ file: target, provider: "modrinth-overrides" });
        }
      }
    }, { signal: progressState.signal });
  } else {
    const dependencies = await modrinthProvider.resolveDependencies(version, payload.minecraftVersion || payload.version, payload.loader, {
      allowClientFiles: payload.allowClientFiles,
    });
    const fileEntries = [
      { version, dependencyType: "primary", project },
      ...dependencies.map((entry) => ({ version: entry.version, dependencyType: entry.dependencyType || "required", project: entry.project })),
    ];
    ensureServerFiles(fileEntries.map((entry) => entry.version), "Modrinth");
    let current = 0;
    for (const entry of fileEntries) {
      const resolvedVersion = entry.version;
      current += 1;
	      const file = resolvedVersion.primaryFile || resolvedVersion.files?.[0];
	      const fileName = file?.filename || getUrlPathBasename(file?.url, "modrinth-file.jar");
	      const entryProject = entry.project || {};
	      const requirement = {
	        provider: "modrinth",
	        providerName: "Modrinth",
	        projectId: resolvedVersion.projectId || entryProject.providerProjectId || projectId,
	        projectSlug: entryProject.slug || resolvedVersion.projectId || project.slug || projectId,
	        projectName: entryProject.name || project.name || null,
	        projectType: entryProject.projectType || project.projectType || "modpack",
	        websiteUrl: entryProject.websiteUrl || project.websiteUrl || null,
	        versionId: resolvedVersion.id,
	        fileName,
	        expectedDestinationPath: `mods/${safeArchivePath(fileName)}`,
	        hash: file?.hashes?.sha1 || file?.hashes?.sha512 || null,
	        size: file?.size || null,
	        projectUrl: entryProject.projectUrl || project.projectUrl || null,
	      };
      requirement.requirementId = getManualRequirementId(requirement);
      if (!file?.url) {
        if (entry.dependencyType === "optional") {
          logMarketplaceInstallStep("Skipping optional Modrinth dependency without download URL.", {
            instanceId,
            provider: "modrinth",
            projectId: requirement.projectId,
            versionId: requirement.versionId,
            fileName: requirement.fileName,
            recovery: "skipped-missing-download-url",
          });
          continue;
        }
	        const enrichedRequirement = await resolveModrinthManualProjectMetadata(requirement);
	        throw createManualDownloadRequiredError({
	          code: "MODRINTH_DOWNLOAD_URL_MISSING",
	          message: `${requirement.fileName} has no download URL.`,
	          details: { status: 404 },
	        }, {
	          ...enrichedRequirement,
	          originalCode: "MODRINTH_DOWNLOAD_URL_MISSING",
	          reason: "The provider did not provide a direct download URL for this required file.",
	        });
      }
      if (!dedupe.add(file.hashes?.sha1 || file.url)) {
        continue;
      }
      const target = requirement.expectedDestinationPath;
      if (getImportedManualFile(manualFiles, requirement.requirementId)) {
        mods.push({ file: target, sha1: file.hashes?.sha1 || null, provider: "modrinth", versionId: resolvedVersion.id, manualImport: true });
        downloads.push({ file: target, provider: "modrinth-manual-import" });
        continue;
      }
      emitProgress({ ...progressState, stage: "downloading", message: `Downloading ${current}/${fileEntries.length} mods...`, current, total: fileEntries.length });
      try {
        const buffer = await fetchBuffer(file.url, fileName, { signal: progressState.signal });
        await writeIfMissing(instanceId, target, buffer, agentConfig);
        mods.push({ file: target, sha1: file.hashes?.sha1 || null, provider: "modrinth", versionId: resolvedVersion.id });
        downloads.push({ file: target, provider: "modrinth" });
	      } catch (error) {
	        if (isProviderManualDownloadRequiredError(error) && (current === 1 || entry.dependencyType !== "optional")) {
	          const enrichedRequirement = await resolveModrinthManualProjectMetadata(requirement);
	          throw createManualDownloadRequiredError(error, {
	            ...enrichedRequirement,
	            originalCode: "MODRINTH_REQUIRED_FILE_RESTRICTED",
	          });
	        }
	        if (isRecoverableProviderFileError(error)) {
	          if (current === 1 || entry.dependencyType !== "optional") {
	            const enrichedRequirement = await resolveModrinthManualProjectMetadata(requirement);
	            throw createManualDownloadRequiredError(error, {
	              ...enrichedRequirement,
	              originalCode: "MODRINTH_REQUIRED_FILE_RESTRICTED",
	            });
	          }
          logMarketplaceInstallFailure(error, {
            provider: "modrinth",
            instanceId,
            fileName: requirement.fileName,
            url: file.url,
            recovery: "skipped-file",
          });
          continue;
        }
        throw error;
      }
    }
  }

  if (mods.length === 0 && downloads.length === 0) {
    throw new MarketplaceInstallError("Modrinth install failed: no usable modpack files could be downloaded.", "MISSING_SERVER_FILES", {
      projectId,
      versionId: version.id,
    });
  }

  return {
    mods,
    downloads,
    source: {
      modrinthVersion: version.id,
      modrinthVersionName: version.name,
      minecraftVersion: resolvedMetadata.minecraftVersion,
      loader: resolvedMetadata.loader,
      modpackVersion: resolvedMetadata.modpackVersion,
      releaseType: resolvedMetadata.releaseType,
      serverCompatibilityConfirmed: resolvedMetadata.serverCompatibilityConfirmed,
    },
  };
}

async function installCurseForgePack(instanceId, payload, agentConfig, progressState) {
  const projectId = payload.providerProjectId || payload.projectId;
  const curseForgeConfig = progressState.curseForgeConfig || getCurseForgeAgentConfig(progressState.nodeId);
  const curseForgeBrowseConfig = progressState.curseForgeBrowseConfig || getCurseForgeBrowseConfig(progressState.nodeId);
  ensureProviderProjectId(projectId, "CurseForge");
  emitProgress({ ...progressState, stage: "resolving", message: "Resolving CurseForge file..." });
  const selection = payload.curseForgeServerPackSelection || await resolveCurseForgeServerPackSelection({
    projectId,
    minecraftVersion: payload.minecraftVersion || payload.version,
    loader: payload.loader,
    requestedFileId: payload.providerVersionId || payload.fileId,
    config: curseForgeBrowseConfig,
  });
  const file = selection.selectedFile;
  const serverFile = selection.serverFile;
  const resolvedMetadata = buildCurseForgeResolvedMetadata(selection, projectId);
  ensureSupportedModpack(serverFile?.id, "CurseForge", "server pack file could not be resolved");
  logMarketplaceInstallStep("Resolved CurseForge server pack file.", {
    instanceId,
    projectId,
    selectedFileId: file.id,
    selectedFileName: file.fileName,
    serverPackFileId: serverFile.id,
    serverPackFileName: serverFile.fileName,
    advertisedMinecraftVersion: resolvedMetadata.minecraftVersion || null,
    loader: resolvedMetadata.loader || null,
    releaseType: resolvedMetadata.releaseType || null,
    serverCompatibilityConfirmed: resolvedMetadata.serverCompatibilityConfirmed,
    source: selection.source || null,
    serverCompatibility: selection.compatibility || null,
  });
  emitProgress({ ...progressState, stage: "downloading", message: `Downloading ${serverFile.fileName || "CurseForge server pack"}...` });
  const downloaded = /\.zip$/i.test(serverFile.fileName || "")
    ? await curseforgeProvider.downloadFileStream(serverFile, { config: curseForgeConfig, signal: progressState.signal })
    : await curseforgeProvider.downloadFile(serverFile, "", { config: curseForgeConfig, signal: progressState.signal });
  const mods = [];
  const downloads = [];
  const dedupe = createDeduper();
  const manualFiles = progressState.manualFiles || {};
  const isDedicatedServerPack = Boolean(serverFile.id !== file.id || selection.source);

  if (/\.zip$/i.test(downloaded.fileName)) {
    emitProgress({ ...progressState, stage: "extracting", message: "Extracting CurseForge manifest..." });
    let manifest = null;
    let bundledModCount = 0;
    let serverSignalCount = 0;
    await extractZipStream(downloaded.stream, async (entryPath, content) => {
      if (isCurseForgeServerSignalPath(entryPath)) {
        serverSignalCount += 1;
      }
      if (entryPath === "manifest.json") {
        logMarketplaceInstallStep("Parsing CurseForge manifest.", { instanceId, projectId, fileName: downloaded.fileName });
        try {
          manifest = JSON.parse(content.toString("utf8"));
        } catch (error) {
          throw new MarketplaceInstallError("CurseForge server pack manifest is invalid JSON.", "INVALID_MANIFEST", {
            message: error.message,
            fileName: downloaded.fileName,
          });
        }
        if (isDedicatedServerPack) {
          await writeBuffer(instanceId, entryPath, content, agentConfig);
          downloads.push({ file: entryPath, provider: "curseforge-server-pack" });
        }
        return;
      }
      if (isDedicatedServerPack) {
        await writeBuffer(instanceId, entryPath, content, agentConfig);
        downloads.push({ file: entryPath, provider: "curseforge-server-pack" });
        if (entryPath.startsWith("mods/") && /\.jar$/i.test(entryPath)) {
          bundledModCount += 1;
          mods.push({ file: entryPath, provider: "curseforge-server-pack", bundled: true });
        }
        return;
      }
      if (!entryPath.startsWith("overrides/")) {
        return;
      }
      const target = stripArchiveRoot(entryPath);
      if (target) {
        await writeBuffer(instanceId, target, content, agentConfig);
        downloads.push({ file: target, provider: "curseforge-overrides" });
      }
    }, { signal: progressState.signal });
    const manifestFiles = getCurseForgeManifestFiles(manifest, { isDedicatedServerPack });
    ensureCurseForgeServerPackCandidate({
      instanceId,
      projectId,
      fileId: serverFile.id,
      fileName: downloaded.fileName,
      isDedicatedServerPack,
      bundledModCount,
      serverSignalCount,
    });
    if (isDedicatedServerPack && bundledModCount > 0) {
      logMarketplaceInstallStep("Using bundled CurseForge server pack files.", {
        instanceId,
        projectId,
        bundledModCount,
        manifestFiles: manifestFiles.length,
      });
      return {
        mods,
        downloads,
        source: {
          curseForgeFileId: file.id,
          curseForgeServerPackFileId: serverFile.id,
          curseForgeFileName: downloaded.fileName,
          minecraftVersion: resolvedMetadata.minecraftVersion,
          loader: resolvedMetadata.loader,
          modpackVersion: resolvedMetadata.modpackVersion,
          releaseType: resolvedMetadata.releaseType,
          serverCompatibilityConfirmed: resolvedMetadata.serverCompatibilityConfirmed,
        },
      };
    }
    ensureServerFiles(manifestFiles, "CurseForge");
    let current = 0;
    for (const manifestFile of manifestFiles) {
      current += 1;
      if (manifestFile.required === false || manifestFile.optional === true) {
        logMarketplaceInstallStep("Skipping optional CurseForge manifest file.", { instanceId, manifestFile });
        continue;
      }
      const manifestProjectId = manifestFile.projectID || manifestFile.projectId || manifestFile.project_id;
      const manifestFileId = manifestFile.fileID || manifestFile.fileId || manifestFile.file_id;
      ensureSupportedModpack(manifestProjectId && manifestFileId, "CurseForge", "manifest contains a file without projectID/fileID");
      if (!dedupe.add(`${manifestProjectId}:${manifestFileId}`)) {
        continue;
      }
      const requirement = {
        provider: "curseforge",
        providerName: "CurseForge",
        projectId: manifestProjectId,
        fileId: manifestFileId,
        fileName: manifestFile.fileName || null,
        expectedDestinationPath: manifestFile.fileName ? `mods/${safeArchivePath(manifestFile.fileName)}` : null,
      };
      emitProgress({ ...progressState, stage: "downloading", message: `Downloading ${current}/${manifestFiles.length} mods...`, current, total: manifestFiles.length });
      try {
        const modFile = await curseforgeProvider.getFile(manifestProjectId, manifestFileId, curseForgeConfig);
        requirement.fileName = requirement.fileName || modFile.fileName || modFile.name || null;
        requirement.expectedDestinationPath = requirement.expectedDestinationPath || `mods/${safeArchivePath(requirement.fileName || `${manifestFileId}.jar`)}`;
        requirement.requirementId = getManualRequirementId(requirement);
        if (getImportedManualFile(manualFiles, requirement.requirementId)) {
          mods.push({ file: requirement.expectedDestinationPath, provider: "curseforge", projectId: manifestProjectId, fileId: manifestFileId, manualImport: true });
          downloads.push({ file: requirement.expectedDestinationPath, provider: "curseforge-manual-import" });
          continue;
        }
        const modDownload = await curseforgeProvider.downloadFile(modFile, "", { config: curseForgeConfig, signal: progressState.signal });
        const target = `mods/${safeArchivePath(modDownload.fileName)}`;
        await writeIfMissing(instanceId, target, modDownload.buffer, agentConfig);
        mods.push({ file: target, provider: "curseforge", projectId: manifestProjectId, fileId: manifestFileId });
        downloads.push({ file: target, provider: "curseforge" });
      } catch (error) {
        const fileContext = getCurseForgeFileContext(manifestFile, {
          fileName: error?.details?.fileName || null,
          projectId: manifestProjectId,
          fileId: manifestFileId,
        });
        if (isProviderManualDownloadRequiredError(error) && fileContext.dependencyType === "required") {
          const enrichedFileContext = await resolveCurseForgeManualProjectMetadata({
            ...fileContext,
            curseForgeConfig,
            expectedDestinationPath: requirement.expectedDestinationPath || (fileContext.fileName ? `mods/${safeArchivePath(fileContext.fileName)}` : null),
          });
          throw createRestrictedCurseForgeFileError(error, {
            ...enrichedFileContext,
          });
        }
        if (isRecoverableProviderFileError(error)) {
          if (isCurseForgeAccessDeniedFileError(error)) {
            logSkippedCurseForgeRestrictedFile(error, {
              instanceId,
              ...fileContext,
            });
          } else {
            logMarketplaceInstallFailure(error, {
              instanceId,
              ...fileContext,
              recovery: "skipped-file",
            });
          }
          continue;
        }
        throw error;
      }
    }
  } else {
    const dependencyEntries = await curseforgeProvider.resolveDependencies(file, curseForgeConfig, null, {
      includeOptional: payload.includeOptionalDependencies === true,
    });
    const fileEntries = [
      { file: downloaded, dependencyType: "primary" },
      ...dependencyEntries.map((entry) => ({ file: entry.file, dependencyType: entry.dependencyType || "required" })),
    ];
    ensureServerFiles(fileEntries.map((entry) => entry.file), "CurseForge");
    let current = 0;
    for (const entry of fileEntries) {
      const item = entry.file;
      current += 1;
      if (!dedupe.add(`${item.projectId}:${item.id}`)) {
        continue;
      }
      try {
        const fileName = item.fileName || item.name || `${item.id}.jar`;
        const target = `mods/${safeArchivePath(fileName)}`;
        const requirement = {
          provider: "curseforge",
          providerName: "CurseForge",
          projectId: item.projectId,
          fileId: item.id,
          fileName,
          expectedDestinationPath: target,
          dependencyType: entry.dependencyType || "required",
        };
        requirement.requirementId = getManualRequirementId(requirement);
        if (getImportedManualFile(manualFiles, requirement.requirementId)) {
          emitProgress({ ...progressState, stage: "downloading", message: `Downloading ${current}/${fileEntries.length} mods...`, current, total: fileEntries.length });
          mods.push({ file: target, provider: "curseforge", projectId: item.projectId, fileId: item.id, manualImport: true });
          downloads.push({ file: target, provider: "curseforge-manual-import" });
          continue;
        }
        const modDownload = item.buffer ? item : await curseforgeProvider.downloadFile(item, "", { config: curseForgeConfig, signal: progressState.signal });
        emitProgress({ ...progressState, stage: "downloading", message: `Downloading ${current}/${fileEntries.length} mods...`, current, total: fileEntries.length });
        await writeIfMissing(instanceId, target, modDownload.buffer, agentConfig);
        mods.push({ file: target, provider: "curseforge", projectId: item.projectId, fileId: item.id });
        downloads.push({ file: target, provider: "curseforge" });
      } catch (error) {
        const fileContext = getCurseForgeFileContext(item, {
          fileName: error?.details?.fileName || null,
          projectId: item.projectId,
          fileId: item.id,
          dependencyType: entry.dependencyType || "required",
        });
        if (isProviderManualDownloadRequiredError(error) && fileContext.dependencyType === "required") {
          const enrichedFileContext = await resolveCurseForgeManualProjectMetadata({
            ...fileContext,
            curseForgeConfig,
            expectedDestinationPath: fileContext.fileName ? `mods/${safeArchivePath(fileContext.fileName)}` : null,
          });
          throw createRestrictedCurseForgeFileError(error, {
            ...enrichedFileContext,
          });
        }
        if (isRecoverableProviderFileError(error)) {
          if (isCurseForgeAccessDeniedFileError(error)) {
            logSkippedCurseForgeRestrictedFile(error, {
              instanceId,
              ...fileContext,
            });
          } else {
            logMarketplaceInstallFailure(error, {
              provider: "curseforge",
              instanceId,
              ...fileContext,
              recovery: "skipped-file",
            });
          }
          continue;
        }
        throw error;
      }
    }
  }
  if (mods.length === 0 && downloads.length === 0) {
    throw new MarketplaceInstallError("CurseForge install failed: no usable modpack files could be downloaded.", "MISSING_SERVER_FILES", {
      projectId,
      fileId: file.id,
      serverPackFileId: serverFile.id,
    });
  }
  return {
    mods,
    downloads,
    source: {
      curseForgeFileId: file.id,
      curseForgeFileName: file.fileName,
      curseForgeServerPackFileId: serverFile.id,
      curseForgeServerPackFileName: serverFile.fileName,
      minecraftVersion: resolvedMetadata.minecraftVersion,
      loader: resolvedMetadata.loader,
      modpackVersion: resolvedMetadata.modpackVersion,
      releaseType: resolvedMetadata.releaseType,
      serverCompatibilityConfirmed: resolvedMetadata.serverCompatibilityConfirmed,
    },
  };
}

async function continueProviderPackInstall(context = {}) {
  const {
    provider,
    instanceId,
    options,
    agentConfig,
    curseForgeConfig = null,
    curseForgeBrowseConfig = null,
    serverInfo,
    instancePayload,
    createResult,
    manualFiles = {},
    operationId = null,
    signal = null,
  } = context;

  const nodeId = agentConfig?.nodeId || options?.nodeId || null;
  let installRecords = { mods: [], downloads: [], source: {} };
  if (provider === "modrinth") {
    installRecords = await installModrinthPack(instanceId, options, agentConfig, { nodeId, instanceId, manualFiles, operationId, signal });
  } else if (provider === "curseforge") {
    installRecords = await installCurseForgePack(instanceId, options, agentConfig, { nodeId, instanceId, manualFiles, curseForgeConfig, curseForgeBrowseConfig, operationId, signal });
  }

  throwIfInstallCancelled(signal);
  emitProgress({ nodeId, instanceId, operationId, stage: "writing", message: "Writing instance metadata...", current: 1, total: 1 });
  await writeText(instanceId, "eula.txt", `eula=${options.acceptEula === false ? "false" : "true"}\n`, agentConfig);
  await applyMinecraftServerProperties(agentClient, instanceId, {
    ...options,
    name: instancePayload.displayName,
  }, instancePayload.primaryPort, agentConfig);
  let startupTarget = await resolveInstalledStartupTarget(instanceId, serverInfo, options, agentConfig);
  let serverPackRuntime = shouldResolveProviderServerPackRuntime(startupTarget, serverInfo, options)
    ? await resolveServerPackRuntime(instanceId, startupTarget, options, agentConfig)
    : null;
  const providerNeoForgeServerPack = requiresAuthoritativeNeoForgePreparation(serverInfo, options);
  if (providerNeoForgeServerPack || serverPackRuntime?.requiresInstallerBootstrap) {
    emitProgress({ nodeId, instanceId, operationId, stage: "installing", message: "Preparing NeoForge server runtime...", current: 1, total: 1 });
    await agentClient.repairNeoForgeRuntime(instanceId, { timeoutMs: 300000 }, agentConfig);
    startupTarget = await resolveInstalledStartupTarget(instanceId, serverInfo, options, agentConfig);
    serverPackRuntime = await resolveServerPackRuntime(instanceId, startupTarget, options, agentConfig);
    if (serverPackRuntime.requiresInstallerBootstrap) {
      throw createServerPackRuntimeUnresolvedError("NeoForge server runtime remained incomplete after installer bootstrap.", {
        instanceId,
        startupScript: startupTarget.path || null,
        installerFile: serverPackRuntime.installerFile || null,
      });
    }
  }
  const scriptStartupUsesInstallerJar = startupTarget.type === "script" && isInstallerJarName(serverInfo.serverJar);
  const runtimeServerInfo = serverPackRuntime
    ? {
      ...serverInfo,
      serverJar: startupTarget.type === "script" ? serverPackRuntime.serverJar || null : serverPackRuntime.serverJar,
      minecraftVersion: serverPackRuntime.minecraftVersion || serverInfo.minecraftVersion,
      loaderVersion: serverPackRuntime.loaderVersion || serverInfo.loaderVersion,
      versionInfo: serverPackRuntime.versionInfo || null,
      providerRuntimeDeferred: false,
      serverPackRuntime,
    }
    : scriptStartupUsesInstallerJar
    ? { ...serverInfo, serverJar: null }
    : serverInfo;
  const metadata = buildInstallMetadata(options, runtimeServerInfo, {
    ...installRecords,
    source: {
      ...(installRecords.source || {}),
      startupTarget: startupTarget.type,
      startupScript: startupTarget.type === "script" ? startupTarget.path : null,
      serverPackRuntime: serverPackRuntime || null,
    },
  });
  if (serverPackRuntime?.versionInfo) {
    metadata.versionInfo = serverPackRuntime.versionInfo;
    metadata.serverSoftware = serverPackRuntime.serverSoftware || metadata.loader;
    metadata.softwareVersion = serverPackRuntime.loaderVersion || metadata.loaderVersion || null;
    metadata.displayVersion = serverPackRuntime.versionInfo.displayVersion || null;
    metadata.displayVersionDetail = serverPackRuntime.versionInfo.displayVersionDetail || null;
  }
  await writeText(instanceId, "metadata.json", `${JSON.stringify(metadata, null, 2)}\n`, agentConfig);
  const activationPatch = {
    ...metadata,
    ...(startupTarget.patch || {}),
    jar: runtimeServerInfo.serverJar,
    serverJar: runtimeServerInfo.serverJar,
    serverJarPath: runtimeServerInfo.serverJar,
    startJar: runtimeServerInfo.serverJar,
    installationState: "active",
  };
  const configRecord = serverInfo.providerRuntimeDeferred
    ? { ...instancePayload, ...activationPatch, status: "stopped", port: instancePayload.primaryPort }
    : { ...instancePayload, status: "stopped", port: instancePayload.primaryPort };
  await writeText(instanceId, "config.json", `${JSON.stringify(configRecord, null, 2)}\n`, agentConfig);
  if (startupTarget.type !== "script") {
    await validateInstalledServerJar(instanceId, runtimeServerInfo, agentConfig);
  }
  const activationResult = await agentClient.updateInstance(instanceId, {
    ...activationPatch,
  }, agentConfig);
  const activatedInstance = activationResult?.instance || activationResult || {};
  if (options.start) {
    throwIfInstallCancelled(signal);
    emitProgress({ nodeId, instanceId, operationId, stage: "writing", message: "Starting instance...", current: 1, total: 1 });
    await withRetry(
      () => agentClient.startInstance(instanceId, agentConfig),
      { label: "agent start instance", attempts: 2 }
    );
  }

  logMarketplaceInstallStep("Marketplace install completed.", {
    step: "INSTALL_COMPLETED",
    provider,
    instanceId,
    projectId: options.providerProjectId || options.projectId || null,
    versionId: options.providerVersionId || options.versionId || null,
  });
  emitProgress({ nodeId, instanceId, operationId, stage: "done", message: "Done", current: 1, total: 1, percent: 100 });
  return {
    status: "completed",
    instance: { ...(createResult?.instance || createResult || {}), ...activatedInstance, id: instanceId, displayName: instancePayload.displayName, installationState: "active" },
    metadata,
    progress: [{ label: "Done", status: "complete", detail: "Marketplace pack installed." }],
  };
}

function shouldResolveProviderServerPackRuntime(startupTarget = {}, serverInfo = {}, options = {}) {
  return Boolean(
    serverInfo.providerRuntimeDeferred ||
    (
      startupTarget.type === "script" &&
      normalizeLoader(options.loader || options.serverType || serverInfo.loader || serverInfo.serverSoftware) === "neoforge"
    )
  );
}

function requiresAuthoritativeNeoForgePreparation(serverInfo = {}, options = {}) {
  return Boolean(
    serverInfo.providerRuntimeDeferred &&
    normalizeLoader(options.loader || options.serverType || serverInfo.loader || serverInfo.serverSoftware) === "neoforge"
  );
}

async function cleanupIncompleteInstance(instanceId, agentConfig) {
  try {
    await agentClient.deleteInstance(instanceId, agentConfig);
    return { attempted: true, succeeded: true, instanceId };
  } catch (error) {
    const failure = serializeError(error, {
      operation: "delete-incomplete-instance",
      instanceId,
    });
    logMarketplaceInstallFailure(error, {
      step: "ROLLBACK_FAILED",
      instanceId,
      cleanup: failure,
    });
    return {
      attempted: true,
      succeeded: false,
      instanceId,
      error: failure,
      suggestion: "Delete the incomplete instance before retrying the installation.",
    };
  }
}

async function assertProviderInstallDiskSpace(options = {}, agentConfig = null) {
  const requiredFreeBytes = Math.max(1, Number(options.minFreeBytes || options.requiredFreeBytes) || PROVIDER_INSTALL_MIN_FREE_BYTES);
  let diskSpaceCheck;
  try {
    diskSpaceCheck = normalizeDiskEvidence(await agentClient.getSystemStats(agentConfig));
  } catch (error) {
    throw new MarketplaceInstallError("Disk-space preflight could not read storage metrics from the selected node.", "DISK_SPACE_CHECK_UNAVAILABLE", {
      requiredFreeBytes,
      cause: serializeError(error),
      retryable: true,
      suggestion: "Verify the Agent connection and update the Agent before retrying.",
    });
  }
  if (!Number.isFinite(diskSpaceCheck.freeBytes)) {
    throw new MarketplaceInstallError("Disk-space preflight could not determine available storage on the selected node.", "DISK_SPACE_CHECK_UNAVAILABLE", {
      diskSpaceCheck,
      requiredFreeBytes,
      retryable: true,
      suggestion: "Update or repair the selected Agent so it can report disk capacity.",
    });
  }
  if (diskSpaceCheck.freeBytes < requiredFreeBytes) {
    throw new MarketplaceInstallError("The selected node does not have enough free disk space for this Marketplace install.", "INSUFFICIENT_DISK_SPACE", {
      diskSpaceCheck: { ...diskSpaceCheck, requiredFreeBytes },
      requiredFreeBytes,
      retryable: false,
      suggestion: "Free storage on the selected node or choose another node.",
    });
  }
  return { ...diskSpaceCheck, requiredFreeBytes };
}

async function installPack(payload = {}) {
  const provider = String(payload.provider || payload.template?.provider || "anxhub").toLowerCase();
  const options = {
    ...payload.template,
    ...payload.options,
    ...payload,
    provider,
    providerProjectId: payload.providerProjectId || payload.template?.providerProjectId || payload.projectId,
  };
  if (["modrinth", "curseforge"].includes(provider)) {
    ensureProviderProjectId(options.providerProjectId, provider === "modrinth" ? "Modrinth" : "CurseForge");
  }
  const installTarget = resolveMarketplaceInstallTarget({ nodeId: payload.nodeId, operation: `${provider}-install` });
  const agentConfig = installTarget.agentConfig;
  if (installTarget.platform && agentConfig && typeof agentConfig === "object") {
    agentConfig.platform = installTarget.platform;
  }
  const installNodeId = installTarget.nodeId;
  const curseForgeConfig = provider === "curseforge" ? getCurseForgeAgentConfig(installTarget.nodeId) : null;
  let curseForgeBrowseConfig = provider === "curseforge" ? getCurseForgeBrowseConfig(installTarget.nodeId) : null;
  if (provider === "curseforge") {
    curseforgeProvider.ensureConfigured(curseForgeBrowseConfig || {});
    const browseResolution = await withCurseForgeBrowseFallback(
      installTarget.nodeId,
      (config) => resolveCurseForgeServerPackSelection({
        projectId: options.providerProjectId,
        minecraftVersion: options.minecraftVersion || options.version,
        loader: options.loader,
        requestedFileId: options.providerVersionId || options.fileId,
        requestedServerPackFileId: options.advertisedProviderServerPackFileId || options.providerServerPackFileId || options.serverPackFileId,
        config,
      }),
    );
    options.curseForgeServerPackSelection = browseResolution.value;
    curseForgeBrowseConfig = browseResolution.config;
    const resolvedMetadata = buildCurseForgeResolvedMetadata(options.curseForgeServerPackSelection, options.providerProjectId);
    assertAdvertisedProviderSelection("CurseForge", {
      projectId: options.providerProjectId,
      providerVersionId: options.advertisedProviderVersionId || options.providerVersionId || options.fileId,
      providerServerPackFileId: options.advertisedProviderServerPackFileId || options.providerServerPackFileId || options.serverPackFileId,
      minecraftVersion: options.advertisedMinecraftVersion || options.minecraftVersion || options.version,
      loader: options.advertisedLoader || options.loader,
    }, resolvedMetadata);
    applyResolvedProviderSelection(options, resolvedMetadata);
    logMarketplaceInstallStep("Selected CurseForge server pack before Agent install.", {
      provider,
      projectId: options.providerProjectId || null,
      selectedFileId: options.curseForgeServerPackSelection.selectedFile?.id || null,
      selectedFileName: options.curseForgeServerPackSelection.selectedFile?.fileName || null,
      serverPackFileId: options.curseForgeServerPackSelection.serverFile?.id || null,
      serverPackFileName: options.curseForgeServerPackSelection.serverFile?.fileName || null,
      advertisedMinecraftVersion: resolvedMetadata.minecraftVersion || null,
      loader: resolvedMetadata.loader || null,
      releaseType: resolvedMetadata.releaseType || null,
      serverCompatibilityConfirmed: resolvedMetadata.serverCompatibilityConfirmed,
      source: options.curseForgeServerPackSelection.source || null,
      serverCompatibility: options.curseForgeServerPackSelection.compatibility || null,
    });
  } else if (provider === "modrinth") {
    const projectId = options.providerProjectId;
    const project = await modrinthProvider.getProject(projectId);
    ensureModrinthServerCapable(project);
    options.modrinthSelectedProject = project;
    options.modrinthSelectedVersion = await modrinthProvider.resolveVersion(projectId, options.minecraftVersion || options.version, options.loader, options.providerVersionId || options.versionId);
    const resolvedMetadata = buildModrinthResolvedMetadata(options.modrinthSelectedVersion, project);
    assertAdvertisedProviderSelection("Modrinth", {
      projectId,
      providerVersionId: options.advertisedProviderVersionId || options.providerVersionId || options.versionId,
      minecraftVersion: options.advertisedMinecraftVersion || options.minecraftVersion || options.version,
      loader: options.advertisedLoader || options.loader,
    }, resolvedMetadata);
    applyResolvedProviderSelection(options, resolvedMetadata);
    logMarketplaceInstallStep("Selected Modrinth version before Agent install.", {
      provider,
      projectId,
      versionId: resolvedMetadata.providerVersionId || null,
      advertisedMinecraftVersion: resolvedMetadata.minecraftVersion || null,
      loader: resolvedMetadata.loader || null,
      releaseType: resolvedMetadata.releaseType || null,
      serverCompatibilityConfirmed: resolvedMetadata.serverCompatibilityConfirmed,
    });
  }
  logMarketplaceInstallStep("Resolved Marketplace install target.", {
    provider,
    operation: "install-target",
    nodeId: installTarget.nodeId,
    nodeLabel: installTarget.nodeLabel,
    targetType: installTarget.type,
    agentUrl: installTarget.agentUrl,
    targetLabel: installTarget.targetLabel,
    credentialSource: installTarget.credentialSource,
  });
  const diskSpaceCheck = await assertProviderInstallDiskSpace(options, agentConfig);
  logMarketplaceInstallStep("Marketplace disk-space preflight passed.", {
    step: "DISK_SPACE_PREFLIGHT",
    nodeId: installNodeId,
    freeBytes: diskSpaceCheck.freeBytes,
    requiredFreeBytes: diskSpaceCheck.requiredFreeBytes,
    mount: diskSpaceCheck.mount,
  });
  await ensureProviderPackDependencies({ ...options, nodeId: installNodeId }, agentConfig);
  const providerRuntimeDeferred = ["modrinth", "curseforge"].includes(provider);
  const serverInfo = providerRuntimeDeferred
    ? createDeferredProviderServerInfo(options)
    : await resolveServerJar(options);
  const instancePayload = buildInstancePayload(options, serverInfo);
  const installContext = validateInstallContext(buildInstallContext(payload, options, instancePayload));
  const instanceId = instancePayload.id;
  const installOperation = createProviderInstallOperation(payload, { nodeId: installNodeId, instanceId });
  const operationId = installOperation.operation.id;
  const signal = installOperation.signal;
  instancePayload.installationOperationId = operationId;
  let created = false;
  let createResult = null;

  try {
    throwIfInstallCancelled(signal);
    emitProgress({ nodeId: installNodeId, instanceId, operationId, stage: "resolving", message: "Creating instance folder...", current: 0, total: 1 });
    createResult = await withRetry(
      () => agentClient.createInstance(instancePayload, agentConfig),
      { label: "agent create instance", attempts: 3 }
    );
    created = true;
    for (const folder of INSTALL_FOLDERS) {
      await withRetry(
        () => agentClient.createInstanceFolder(instanceId, folder, agentConfig),
        { label: "agent create folder", attempts: 3 }
      );
    }

    if (!providerRuntimeDeferred) {
      emitProgress({ nodeId: installNodeId, instanceId, operationId, stage: "downloading", message: "Downloading server runtime...", current: 0, total: 1 });
      await writeBuffer(instanceId, serverInfo.downloadDestination || serverInfo.serverJar, await fetchBuffer(serverInfo.url, serverInfo.fileName, { signal }), agentConfig);
      throwIfInstallCancelled(signal);
      await runServerInstaller(instanceId, serverInfo, agentConfig, operationId, signal, instancePayload.memoryLimit);
    }

    return await continueProviderPackInstall({
      provider,
      instanceId,
      options,
      agentConfig,
      curseForgeConfig,
      curseForgeBrowseConfig,
      serverInfo,
      instancePayload,
      createResult,
      manualFiles: {},
      operationId,
      signal,
    });
  } catch (error) {
    logMarketplaceInstallFailure(error, {
      provider,
      instanceId,
      providerProjectId: options.providerProjectId || null,
      providerVersionId: options.providerVersionId || options.versionId || null,
      minecraftVersion: options.minecraftVersion || options.version || null,
      loader: options.loader || options.serverType || null,
      installContext,
    });
    const detailedMessage = buildDetailedErrorMessage(error, friendlyError(error));
    if (isManualDownloadRequiredError(error) && created) {
      const manual = {
        ...(error.details || {}),
        provider,
        providerName: error.details?.providerName || titleCaseProvider(provider),
      };
      const session = createPendingManualInstall({
        provider,
        nodeId: installNodeId,
        instanceId,
        options,
        agentConfig,
        curseForgeConfig,
        serverInfo,
        instancePayload,
        createResult,
        manual,
        operationId,
        signal,
        rawError: serializeError(error),
      });
      logMarketplaceInstallStep("Manual download required.", {
        step: "MANUAL_DOWNLOAD_REQUIRED",
        provider,
        instanceId,
        projectId: options.providerProjectId || options.projectId || null,
        versionId: options.providerVersionId || options.versionId || null,
        fileName: manual.fileName || null,
      });
      updateProviderInstallOperation(operationId, { status: "waiting", stage: "Waiting", body: "Waiting for manual download.", canCancel: false });
      emitProgress({ nodeId: installNodeId, instanceId, operationId, stage: "waiting", message: "Waiting for manual download.", current: 0, total: 0, percent: 0 });
      return {
        status: "waiting-manual-download",
        instance: { ...(createResult?.instance || createResult || {}), id: instanceId, displayName: instancePayload.displayName },
        manualDownload: getPublicManualInstall(session),
        progress: [{ label: "Waiting for Manual Download", status: "waiting", detail: "A required modpack file needs manual download." }],
      };
    }
    const cancelled = error?.code === "INSTALL_CANCELLED" || signal.aborted;
    emitProgress({ nodeId: installNodeId, instanceId, stage: cancelled ? "cancelled" : "error", message: detailedMessage, current: 0, total: 0, percent: 0 });
    const cleanup = created
      ? await cleanupIncompleteInstance(instanceId, agentConfig)
      : { attempted: false, succeeded: false, instanceId };
    updateProviderInstallOperation(operationId, {
      status: cancelled ? "cancelled" : "failed",
      stage: cancelled ? "Cancelled" : "Failed",
      body: detailedMessage,
      error: cancelled ? null : detailedMessage,
      canCancel: false,
      canRetry: true,
    });
    throw new MarketplaceInstallError(detailedMessage, error?.code || (provider === "curseforge" ? "CURSEFORGE_INSTALL_FAILED" : "MARKETPLACE_INSTALL_FAILED"), {
      ...(error?.details || {}),
      originalName: error?.name || null,
      originalMessage: error?.message || null,
      cleanup,
    });
  }
}

function getPendingManualInstall(sessionId, options = {}) {
  const key = String(sessionId || "");
  const session = pendingManualInstalls.get(key);
  if (!session) {
    throw new MarketplaceInstallError("Manual download session was not found.", "PROVIDER_MANUAL_SESSION_NOT_FOUND", { sessionId });
  }
  if (Date.now() - Date.parse(session.createdAt || "") > MANUAL_INSTALL_SESSION_TTL_MS) {
    pendingManualInstalls.delete(key);
    throw new MarketplaceInstallError("Manual download session expired. Start the install again.", "PROVIDER_MANUAL_SESSION_EXPIRED", { sessionId });
  }
  const requestedNodeId = String(options.nodeId || "").trim();
  const sessionNodeId = String(session.nodeId || session.agentConfig?.nodeId || "").trim();
  if (requestedNodeId && sessionNodeId && requestedNodeId !== sessionNodeId) {
    throw new MarketplaceInstallError("Manual download session belongs to a different node.", "PROVIDER_MANUAL_SESSION_NODE_MISMATCH", {
      sessionId: session.id,
      nodeId: requestedNodeId,
      sessionNodeId,
    });
  }
  return session;
}

function getManualInstallRecovery(sessionId, options = {}) {
  return getPublicManualInstall(getPendingManualInstall(sessionId, options));
}

function getManualInstallProviderPage(sessionId, options = {}) {
  const session = getPendingManualInstall(sessionId, options);
  const url = session.manual.downloadPageUrl || session.manual.projectUrl || getOfficialProviderUrl(session.manual);
  if (!url) {
    throw new MarketplaceInstallError("Provider page is unavailable for this manual download.", "PROVIDER_PAGE_UNAVAILABLE", {
      sessionId,
      provider: session.manual.provider || null,
    });
  }
  return { url, manualDownload: getPublicManualInstall(session) };
}

async function importManualInstallFile(sessionId, filePath, options = {}) {
  const session = getPendingManualInstall(sessionId, options);
  const manual = session.manual || {};
  const verified = verifyImportedFile(filePath, manual);
  const target = manual.expectedDestinationPath || `mods/${safeArchivePath(verified.fileName)}`;
  await writeBuffer(session.instanceId, target, verified.buffer, session.agentConfig);
  session.importedFiles[manual.requirementId] = {
    file: target,
    fileName: verified.fileName,
    size: verified.size,
    sha1: verified.sha1,
    sha512: verified.sha512,
    importedAt: new Date().toISOString(),
  };
  session.status = "file-imported";
  logMarketplaceInstallStep("Manual file imported.", {
    step: "MANUAL_FILE_IMPORTED",
    provider: session.provider || manual.provider || null,
    instanceId: session.instanceId,
    sessionId: session.id,
    fileName: verified.fileName,
    target,
    projectId: manual.projectId || null,
    versionId: manual.versionId || null,
    fileId: manual.fileId || null,
  });
  emitProgress({ nodeId: session.nodeId || session.agentConfig?.nodeId || null, instanceId: session.instanceId, stage: "imported", message: "Manual file imported.", current: 1, total: 1, percent: 100 });
  return {
    imported: true,
    manualDownload: getPublicManualInstall(session),
    importedFile: session.importedFiles[manual.requirementId],
  };
}

async function resumeManualInstall(sessionId, options = {}) {
  const session = getPendingManualInstall(sessionId, options);
  const manual = session.manual || {};
  if (!session.importedFiles[manual.requirementId]) {
    throw new MarketplaceInstallError("Import the missing file before resuming.", "PROVIDER_MANUAL_FILE_NOT_IMPORTED", {
      sessionId,
      requirementId: manual.requirementId,
    });
  }
  session.status = "resuming";
  updateProviderInstallOperation(session.operationId, {
    status: "running",
    stage: "Resuming",
    body: "Resuming Marketplace installation.",
    canCancel: true,
    canRetry: false,
  });
  logMarketplaceInstallStep("Resuming Marketplace install.", {
    step: "INSTALL_RESUMED",
    provider: session.provider || manual.provider || null,
    instanceId: session.instanceId,
    sessionId: session.id,
    projectId: manual.projectId || null,
    versionId: manual.versionId || null,
    fileName: manual.fileName || null,
  });
  emitProgress({ nodeId: session.nodeId || session.agentConfig?.nodeId || null, instanceId: session.instanceId, stage: "resuming", message: "Resuming Marketplace install...", current: 0, total: 0, percent: 0 });
  try {
    const result = await continueProviderPackInstall({
      provider: session.provider,
      instanceId: session.instanceId,
      options: session.options,
      agentConfig: session.agentConfig,
      curseForgeConfig: session.curseForgeConfig || null,
      serverInfo: session.serverInfo,
      instancePayload: session.instancePayload,
      createResult: session.createResult,
      manualFiles: session.importedFiles,
      operationId: session.operationId,
      signal: session.signal,
    });
    pendingManualInstalls.delete(session.id);
    return result;
  } catch (error) {
    session.status = "waiting-manual-download";
    updateProviderInstallOperation(session.operationId, {
      status: "waiting",
      stage: "Waiting",
      body: "Manual installation is still waiting for a valid required file.",
      canCancel: false,
      canRetry: false,
    });
    throw error;
  }
}

async function updateSteamCmdInstance(payload = {}) {
  const instanceId = String(payload.instanceId || "").trim();
  const nodeId = payload.nodeId || null;
  if (!instanceId) throw new MarketplaceInstallError("An instance is required.", "INVALID_INSTANCE_ID");
  const target = resolveMarketplaceInstallTarget({
    nodeId: nodeId || getSelectedNodeId(),
    operation: "steamcmd-update",
  });
  const targetNodeId = target.nodeId;
  const agentConfig = target.agentConfig;
  const operationId = `steamcmd-update-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const controller = new AbortController();
  const operation = longOperations.createOperation({
    id: operationId,
    kind: "marketplace-download",
    nodeId: targetNodeId,
    lockKey: `marketplace-steamcmd-update:${targetNodeId}:${instanceId}`,
    status: "running",
    canCancel: true,
    retryable: false,
    rollbackSupported: false,
    metadata: {
      id: operationId,
      instanceId,
      nodeId: targetNodeId,
      name: "Update server files",
      type: "steamcmd-update",
      installerType: "steamcmd-native",
      status: "running",
      stage: "Preparing",
      progress: 0,
      progressMode: "determinate",
      body: "Preparing SteamCMD update.",
      logs: [],
      controller,
      canCancel: true,
      canRetry: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  longOperations.registerCancelHandler(operationId, () => controller.abort());
  let session = null;
  try {
    emitProgress({ nodeId: targetNodeId, instanceId, operationId, stage: "preflight", message: "Checking SteamCMD update prerequisites.", current: 0, total: 1 });
    await agentClient.repairLegacySteamCmdMetadata(instanceId, agentConfig);
    session = await agentClient.beginSteamCmdUpdateSession(instanceId, { operationId }, agentConfig);
    const proof = { operationId, token: session.token };
    if (controller.signal.aborted) {
      await agentClient.cancelInstallationSession(instanceId, proof, agentConfig).catch(() => {});
      throw new MarketplaceInstallError("Server update cancelled.", "STEAMCMD_UPDATE_CANCELLED");
    }
    controller.signal.addEventListener("abort", () => {
      agentClient.cancelInstallationSession(instanceId, proof, agentConfig).catch(() => {});
    }, { once: true });
    emitProgress({ nodeId: targetNodeId, instanceId, operationId, stage: "connecting", message: "Connecting to Steam...", percent: 1 });
    let executionFinished = false;
    const execution = agentClient.executeSteamCmdUpdate(instanceId, proof, agentConfig)
      .finally(() => { executionFinished = true; });
    while (!executionFinished) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (executionFinished) break;
      try {
        const status = await agentClient.getSteamCmdUpdateStatus(instanceId, proof, agentConfig);
        emitProgress({
          nodeId: targetNodeId,
          instanceId,
          operationId,
          stage: status.stage || "updating",
          message: status.label || "Updating server files with SteamCMD...",
          percent: status.percent,
          logs: status.logs,
        });
      } catch (statusError) {
        if (executionFinished) break;
        console.warn("[Marketplace][SteamCMD] Live update status unavailable.", {
          instanceId,
          operationId,
          code: statusError?.code || null,
        });
      }
    }
    const result = await execution;
    const completionMessage = result.buildChanged === false
      ? "Server is already up to date."
      : "Server files updated successfully.";
    emitProgress({ nodeId: targetNodeId, instanceId, operationId, stage: "done", message: completionMessage, current: 1, total: 1, percent: 100 });
    updateProviderInstallOperation(operationId, {
      status: "complete",
      stage: "Complete",
      body: completionMessage,
      progress: 100,
      canCancel: false,
      result,
    });
    return { operationId, instanceId, result };
  } catch (error) {
    const cancelled = controller.signal.aborted || /CANCEL/i.test(String(error?.code || ""));
    updateProviderInstallOperation(operationId, {
      status: cancelled ? "cancelled" : "failed",
      stage: cancelled ? "Cancelled" : "Failed",
      body: cancelled ? "Server update cancelled." : error.message || "SteamCMD update failed.",
      progress: longOperations.getOperation(operationId)?.progress || 0,
      canCancel: false,
      code: cancelled ? "STEAMCMD_UPDATE_CANCELLED" : error.code || "STEAMCMD_UPDATE_FAILED",
      canRetry: false,
    });
    throw error;
  } finally {
    if (session?.token) {
      await agentClient.closeSteamCmdUpdateSession(instanceId, { operationId, token: session.token }, agentConfig).catch(() => {});
    }
  }
}

async function searchProviderPacks(payload = {}) {
  const provider = String(payload.provider || "modrinth").toLowerCase();
  console.info("[Marketplace][ProviderSearch] Dispatch.", {
    provider,
    mode: payload.mode || "featured",
    query: payload.query || "",
    minecraftVersion: payload.minecraftVersion || payload.version || "",
    loader: payload.loader || "",
    offset: payload.offset || 0,
    limit: payload.limit || null,
  });
  let result;
  if (provider === "curseforge") {
    const browse = await withCurseForgeBrowseFallback(
      payload.nodeId,
      (config) => curseforgeProvider.searchModpacks({ ...payload, config }),
    );
    const curseForgeConfig = browse.config;
    result = browse.value;
    result = await enrichCurseForgeSearchResults(result, payload, curseForgeConfig);
    result.diagnostics = {
      ...(result.diagnostics || {}),
      nodeId: curseForgeConfig.agentNodeId,
      nodeLabel: curseForgeConfig.agentNodeLabel,
      agentProxy: curseForgeConfig.useAgentProxy,
      credentialSource: curseForgeConfig.credentialSource,
      browseOnly: true,
      serverCompatibilityCounts: (result.results || []).reduce((counts, project) => {
        const classification = project.serverCompatibility?.classification || "UNKNOWN";
        counts[classification] = (counts[classification] || 0) + 1;
        return counts;
      }, {}),
    };
  } else if (provider === "modrinth") {
    result = await modrinthProvider.searchModpacks(payload);
    result = await enrichModrinthSearchResults(result, payload);
  } else {
    result = {
      provider,
      diagnostics: { provider, zeroReason: "unsupported_provider", apiCount: 0, filteredCount: 0, parsedCount: 0 },
      results: [],
    };
  }
  console.info("[Marketplace][ProviderSearch] Result.", {
    provider,
    resultCount: Array.isArray(result?.results) ? result.results.length : 0,
    diagnostics: result?.diagnostics || null,
  });
  return result;
}

function buildCurseForgeResolvedMetadata(selection = {}, projectId = null) {
  const selectedFile = selection.selectedFile || {};
  const serverFile = selection.serverFile || selectedFile;
  const minecraftVersions = getCurseForgeVersions(serverFile).length ? getCurseForgeVersions(serverFile) : getCurseForgeVersions(selectedFile);
  const loaders = getCurseForgeLoaders(serverFile).length ? getCurseForgeLoaders(serverFile) : getCurseForgeLoaders(selectedFile);
  return {
    projectId,
    providerVersionId: selectedFile.id ? String(selectedFile.id) : "",
    providerFileId: selectedFile.id ? String(selectedFile.id) : "",
    providerServerPackFileId: serverFile.id ? String(serverFile.id) : "",
    minecraftVersions,
    minecraftVersion: selectProviderMinecraftVersion(minecraftVersions),
    displayMinecraftVersion: displayProviderMinecraftVersion(minecraftVersions),
    loaders,
    loader: selectProviderLoader(loaders),
    modpackVersion: selectedFile.name || selectedFile.fileName || "",
    releaseType: selectedFile.releaseType || null,
    serverCompatibilityConfirmed: Boolean(serverFile.id && selection.compatibility?.classification !== CLASSIFICATIONS.CLIENT_ONLY),
    serverCompatibility: selection.compatibility || null,
    source: selection.source || null,
  };
}

function buildModrinthResolvedMetadata(version = {}, project = {}) {
  const minecraftVersions = Array.isArray(version.minecraftVersions) ? version.minecraftVersions : [];
  const loaders = Array.isArray(version.loaders) ? version.loaders : [];
  return {
    projectId: project.providerProjectId || project.id || version.projectId || null,
    providerVersionId: version.id ? String(version.id) : "",
    versionId: version.id ? String(version.id) : "",
    minecraftVersions,
    minecraftVersion: selectProviderMinecraftVersion(minecraftVersions),
    displayMinecraftVersion: displayProviderMinecraftVersion(minecraftVersions),
    loaders,
    loader: selectProviderLoader(loaders),
    modpackVersion: version.versionNumber || version.name || "",
    releaseType: version.type || null,
    serverCompatibilityConfirmed: String(project.serverSide || project.raw?.server_side || "").toLowerCase() !== "unsupported",
    serverSide: project.serverSide || project.raw?.server_side || null,
  };
}

function mergeResolvedProviderMetadata(project = {}, metadata = {}) {
  const minecraftVersion = metadata.minecraftVersion || project.minecraftVersion || "";
  const loader = metadata.loader || project.loader || "";
  return {
    ...project,
    providerVersionId: metadata.providerVersionId || project.providerVersionId || "",
    providerFileId: metadata.providerFileId || project.providerFileId || metadata.providerVersionId || "",
    providerServerPackFileId: metadata.providerServerPackFileId || project.providerServerPackFileId || "",
    minecraftVersion,
    displayMinecraftVersion: metadata.displayMinecraftVersion || minecraftVersion || "Compatibility Unknown",
    minecraftVersions: metadata.minecraftVersions?.length ? metadata.minecraftVersions : project.minecraftVersions || [],
    loader,
    loaders: metadata.loaders?.length ? metadata.loaders : project.loaders || [],
    modpackVersion: metadata.modpackVersion || project.modpackVersion || "",
    releaseType: metadata.releaseType || project.releaseType || null,
    serverCompatibilityConfirmed: metadata.serverCompatibilityConfirmed === true,
    serverCompatibility: metadata.serverCompatibility || project.serverCompatibility || null,
    selectedProviderFile: metadata,
  };
}

async function enrichCurseForgeSearchResults(result = {}, payload = {}, config = {}) {
  const results = Array.isArray(result.results) ? result.results : [];
  const enriched = await Promise.all(results.map(async (project) => {
    const projectId = project.providerProjectId || project.id || project.slug;
    try {
      const selection = await resolveCurseForgeServerPackSelection({
        projectId,
        minecraftVersion: payload.minecraftVersion || payload.version || "",
        loader: payload.loader || "",
        config,
      });
      const metadata = buildCurseForgeResolvedMetadata(selection, projectId);
      console.info("[Marketplace][ProviderVersion] Selected CurseForge card target.", {
        provider: "curseforge",
        projectId,
        selectedFileId: metadata.providerFileId || null,
        selectedServerPackFileId: metadata.providerServerPackFileId || null,
        advertisedMinecraftVersion: metadata.minecraftVersion || null,
        loader: metadata.loader || null,
        releaseType: metadata.releaseType,
        serverCompatibilityConfirmed: metadata.serverCompatibilityConfirmed,
      });
      return mergeResolvedProviderMetadata(project, metadata);
    } catch (error) {
      console.info("[Marketplace][ProviderVersion] CurseForge card compatibility unresolved.", {
        provider: "curseforge",
        projectId,
        minecraftVersion: payload.minecraftVersion || payload.version || "",
        loader: payload.loader || "",
        code: error?.code || null,
        message: error?.message || null,
      });
      return {
        ...project,
        minecraftVersion: "",
        displayMinecraftVersion: "Compatibility Unknown",
        providerVersionId: "",
        serverCapable: false,
        serverCompatibility: {
          state: "unknown",
          label: "Compatibility Unknown",
          detail: "No compatible server file/version could be resolved for this card.",
          installable: false,
          errorCode: error?.code || null,
        },
      };
    }
  }));
  return { ...result, results: enriched };
}

async function enrichModrinthSearchResults(result = {}, payload = {}) {
  const results = Array.isArray(result.results) ? result.results : [];
  const enriched = await Promise.all(results.map(async (project) => {
    const projectId = project.providerProjectId || project.id || project.slug;
    try {
      ensureModrinthServerCapable(project);
      const version = await modrinthProvider.resolveVersion(projectId, payload.minecraftVersion || payload.version || "", payload.loader || "", "");
      const metadata = buildModrinthResolvedMetadata(version, project);
      console.info("[Marketplace][ProviderVersion] Selected Modrinth card target.", {
        provider: "modrinth",
        projectId,
        versionId: metadata.providerVersionId || null,
        advertisedMinecraftVersion: metadata.minecraftVersion || null,
        loader: metadata.loader || null,
        releaseType: metadata.releaseType,
        serverCompatibilityConfirmed: metadata.serverCompatibilityConfirmed,
      });
      return mergeResolvedProviderMetadata(project, metadata);
    } catch (error) {
      console.info("[Marketplace][ProviderVersion] Modrinth card compatibility unresolved.", {
        provider: "modrinth",
        projectId,
        minecraftVersion: payload.minecraftVersion || payload.version || "",
        loader: payload.loader || "",
        code: error?.code || null,
        message: error?.message || null,
      });
      return {
        ...project,
        minecraftVersion: "",
        displayMinecraftVersion: "Compatibility Unknown",
        providerVersionId: "",
        serverSide: "unsupported",
        serverCompatibility: {
          state: "unknown",
          label: "Compatibility Unknown",
          detail: "No compatible server version could be resolved for this card.",
          installable: false,
          errorCode: error?.code || null,
        },
      };
    }
  }));
  return { ...result, results: enriched };
}

async function getProviderPackVersions(payload = {}) {
  const provider = String(payload.provider || "modrinth").toLowerCase();
  const projectId = payload.providerProjectId || payload.projectId;
  if (provider === "curseforge") {
    const browse = await withCurseForgeBrowseFallback(
      payload.nodeId,
      (config) => curseforgeProvider.getFiles(projectId, payload.minecraftVersion || payload.version || "", payload.loader || "", config),
    );
    const curseForgeConfig = browse.config;
    const files = browse.value;
    return { provider, nodeId: curseForgeConfig.agentNodeId, nodeLabel: curseForgeConfig.agentNodeLabel, versions: files.map((file) => ({ id: file.id, name: file.name, fileName: file.fileName, minecraftVersions: file.minecraftVersions, loaders: file.loaders || [], serverPackFileId: file.serverPackFileId || null, serverCompatibility: file.serverCompatibility })) };
  }
  if (provider === "modrinth") {
    const versions = await modrinthProvider.getVersions(projectId, payload.minecraftVersion || payload.version || "", payload.loader || "");
    return { provider, versions: versions.map((version) => ({ id: version.id, name: version.name, versionNumber: version.versionNumber, minecraftVersions: version.minecraftVersions, loaders: version.loaders })) };
  }
  return { provider, versions: [] };
}

async function getProviderPackDetails(payload = {}) {
  const provider = String(payload.provider || "modrinth").toLowerCase();
  const projectId = payload.providerProjectId || payload.projectId;
  if (provider === "curseforge") {
    const browse = await withCurseForgeBrowseFallback(
      payload.nodeId,
      (config) => curseforgeProvider.getMod(projectId, config),
    );
    return { provider, project: browse.value, nodeId: browse.config.agentNodeId, nodeLabel: browse.config.agentNodeLabel };
  }
  if (provider === "modrinth") {
    return { provider, project: await modrinthProvider.getProject(projectId) };
  }
  return { provider, project: null };
}

module.exports = {
  _test: {
    buildInstallContext,
    buildInstallMetadata,
    buildInstancePayload,
    applyResolvedProviderSelection,
    assertProviderInstallDiskSpace,
    assertAdvertisedProviderSelection,
    buildCurseForgeResolvedMetadata,
    buildModrinthResolvedMetadata,
    cleanupIncompleteInstance,
    createPendingManualInstall,
    createProviderInstallOperation,
    createManualDownloadRequiredError,
    createRestrictedCurseForgeFileError,
    createDeduper,
    ensureCurseForgeServerPackCandidate,
    ensureProviderPackDependencies,
    ensureModrinthServerCapable,
    friendlyHttpMessage,
    getCurseForgeBrowseConfig,
    getCurseForgeAgentConfig,
    isCurseForgeBrowseAuthenticationError,
    withCurseForgeBrowseFallback,
    getCurseForgeFileContext,
    getManualRequirementId,
    getPendingManualInstall,
    getOfficialProviderUrl,
    isManualDownloadRequiredError,
    isCurseForgeAccessDeniedFileError,
    isRecoverableProviderFileError,
    isCurseForgeServerSignalPath,
    getCurseForgeManifestFiles,
    isTransientError,
    resolveCurseForgeServerPackSelection,
    selectProviderMinecraftVersion,
    resolveInstalledStartupTarget,
    resolvePaperServerJar,
    buildStartupScriptPatch,
    createDeferredProviderServerInfo,
    isInstallerJarName,
    resolveServerPackRuntime,
    shouldResolveProviderServerPackRuntime,
    requiresAuthoritativeNeoForgePreparation,
    resolveMarketplaceInstallTarget,
    readBoundedResponseBuffer,
    serializeError,
    safeArchivePath,
    stripArchiveRoot,
    throwIfInstallCancelled,
    updateProviderInstallOperation,
    validateZipDirectory,
    withRetry,
    validateInstallContext,
  },
  getManualInstallProviderPage,
  getManualInstallRecovery,
  installPack,
  importManualInstallFile,
  marketplaceInstallEvents,
  resumeManualInstall,
  updateSteamCmdInstance,
  searchProviderPacks,
  getProviderPackVersions,
  getProviderPackDetails,
};
