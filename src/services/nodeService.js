const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { getApplicationHostNode, APPLICATION_HOST_NODE_ID } = require("./applicationHostService");
const agentClient = require("./agentClient");
const { getEffectiveAgentSettings, getHealth, normalizeAgentSettings } = agentClient;
const {
  deleteNodeToken: deleteStoredNodeToken,
  getNodeCredentialsPath,
  getNodeToken: getStoredNodeToken,
  hasNodeToken: hasStoredNodeToken,
  setNodeToken: setStoredNodeToken,
} = require("./nodeCredentialStore");
const authRecovery = require("./authRecoveryState");
const { parsePairingCode } = require("../shared/agentPairing");
const { AGENT_STATUS, classifyAgentError, createAgentStatusSnapshot } = require("../shared/agentStatus");
const { generateAgentToken, tokenFingerprint } = require("../shared/agentTokenStore");
const { readAgentRuntimeConfig } = require("../shared/agentRuntimeConfigStore");

const NODE_SCHEMA_VERSION = 3;
const DEFAULT_LOCAL_AGENT_PORT = 47131;
const LOCAL_AGENT_HOSTS = ["127.0.0.1", "localhost"];
const LOCAL_AGENT_DISPLAY_NAME = "This PC";
const HEALTH_STATES = new Set(["connecting", "online", "offline", "authentication_failed", "agent_incompatible", "degraded", "unknown"]);
const SUPPORTED_AGENT_API_MAJOR_VERSIONS = new Set([1]);
const SUPPORTED_AGENT_PROTOCOL_VERSION = 1;
const MIN_AGENT_PROTOCOL_VERSION = 1;
const MAX_AGENT_PROTOCOL_VERSION = 1;
const inFlightHealthChecks = new Map();
const nodeHealthGenerations = new Map();
let nodeCredentialRecovery = null;

function hasConfiguredLocalOwner() {
  const securityPath = path.join(getConfigDirectory(), "security.json");
  if (!fs.existsSync(securityPath)) return false;
  try {
    const state = JSON.parse(fs.readFileSync(securityPath, "utf8"));
    return Array.isArray(state?.users)
      && state.users.some((user) => user?.role === "Owner" || user?.role === "Admin");
  } catch {
    return true;
  }
}

function localCredentialsUnlocked() {
  const authState = authRecovery.getState().state;
  return authRecovery.getState().authenticated === true
    || authState === authRecovery.AUTH_STATES.FRESH_SETUP_REQUIRED
    || (authState === authRecovery.AUTH_STATES.LOCKED && !hasConfiguredLocalOwner());
}

function requireNodeCredentialWrite(target, message) {
  if (localCredentialsUnlocked()) return;
  authRecovery.requireLocalCredentialsUnlocked(target, message);
}

function getNodeToken(nodeId, options = {}) {
  if (!localCredentialsUnlocked()) return "";
  try {
    const token = getStoredNodeToken(nodeId);
    nodeCredentialRecovery = null;
    return token;
  } catch (error) {
    if (error?.code !== "NODE_CREDENTIAL_DECRYPT_FAILED") throw error;
    nodeCredentialRecovery = {
      degraded: true,
      reason: "node_credentials_unavailable",
      message: "Saved node credentials could not be restored. Unlock AnxOS to continue.",
    };
    if (options.preserveDecryptionError === true) throw error;
    return "";
  }
}

function hasNodeToken(nodeId) {
  if (!localCredentialsUnlocked()) return false;
  try {
    return hasStoredNodeToken(nodeId);
  } catch (error) {
    if (error?.code !== "NODE_CREDENTIAL_DECRYPT_FAILED") throw error;
    nodeCredentialRecovery = {
      degraded: true,
      reason: "node_credentials_unavailable",
      message: "Saved node credentials could not be restored. Unlock AnxOS to continue.",
    };
    return false;
  }
}

function setNodeToken(nodeId, token) {
  requireNodeCredentialWrite("node-credential-write", "Unlock AnxOS to manage nodes.");
  return setStoredNodeToken(nodeId, token);
}

function deleteNodeToken(nodeId) {
  requireNodeCredentialWrite("node-credential-delete", "Unlock AnxOS to manage nodes.");
  return deleteStoredNodeToken(nodeId);
}

function getConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) return process.env.ANXHUB_CONFIG_DIR;
  try { return app ? path.join(app.getPath("userData"), "config") : path.join(process.cwd(), "config"); }
  catch { return path.join(process.cwd(), "config"); }
}

function getNodesPath() { return path.join(getConfigDirectory(), "nodes.json"); }
function getRuntimeConfigPath() { return path.join(getConfigDirectory(), "agent-runtime.json"); }
function getLegacyAgentConfigPath() { return path.join(getConfigDirectory(), "agent.json"); }
function ensureConfigDirectory() { fs.mkdirSync(getConfigDirectory(), { recursive: true }); }
function normalizeUrl(value) { try { const url = new URL(String(value || "").trim()); return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`; } catch { return String(value || "").trim(); } }
function getUrlParts(url) {
  try {
    const parsed = new URL(normalizeUrl(url));
    return {
      protocol: parsed.protocol.toLowerCase(),
      hostname: parsed.hostname.toLowerCase(),
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
    };
  } catch {
    return null;
  }
}
function isLocalAgentUrl(url) {
  const parts = getUrlParts(url);
  return Boolean(parts && parts.protocol === "http:" && LOCAL_AGENT_HOSTS.includes(parts.hostname));
}
function getLocalAgentPortFromUrl(url) {
  const port = Number.parseInt(getUrlParts(url)?.port, 10);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_LOCAL_AGENT_PORT;
}
function legacyDeviceId(url) {
  if (isLocalAgentUrl(url)) {
    return `local-agent-${getLocalAgentPortFromUrl(url)}`;
  }
  return `legacy-${crypto.createHash("sha256").update(normalizeUrl(url)).digest("hex").slice(0, 20)}`;
}
function nodeIdForDevice(deviceId) { return `agent-${String(deviceId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 56)}`; }
function isGenericNodeDisplayName(value) { return /^(owner machine|default|remote node|agent node|windows desktop|local agent|this pc)$/i.test(String(value || "").trim()); }
function isDefaultLocalAgentDisplayName(value) { return /^(this pc|local agent|owner machine|windows desktop)$/i.test(String(value || "").trim()); }
function isExplicitLocalAgentNode(node = {}) {
  return node.localAgent === true || node.ownerMachine === true || node.profile?.localAgent === true;
}
function getAgentNodeModeLabel(node = {}) { return isExplicitLocalAgentNode(node) ? "Registered Local Agent Node" : "Registered Remote Agent Node"; }

function normalizeRemovedLocalAgents(value) {
  const entries = Array.isArray(value) ? value : [];
  const byKey = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const nodeId = String(entry.nodeId || entry.id || "").trim();
    const deviceId = String(entry.deviceId || "").trim();
    const agentUrl = normalizeUrl(entry.agentUrl || entry.baseUrl || entry.url || "");
    const urls = Array.isArray(entry.agentUrls) ? entry.agentUrls.map(normalizeUrl).filter(Boolean) : [];
    if (agentUrl) urls.push(agentUrl);
    const normalizedUrls = [...new Set(urls)];
    if (!nodeId && !deviceId && normalizedUrls.length === 0) continue;
    const key = nodeId || deviceId || normalizedUrls[0];
    byKey.set(key, {
      nodeId,
      deviceId,
      agentUrls: normalizedUrls,
      removedAt: entry.removedAt || new Date().toISOString(),
    });
  }
  return [...byKey.values()];
}

function getLocalAgentRemovalMarker(node = {}) {
  const agentUrl = normalizeUrl(node.baseUrl || node.agentUrl || node.url || "");
  const localAgent = isExplicitLocalAgentNode(node);
  if (!localAgent) return null;
  const agentUrls = [...new Set([agentUrl, ...getLocalAgentUrls().filter((url) => getLocalAgentPortFromUrl(url) === getLocalAgentPortFromUrl(agentUrl))].filter(Boolean).map(normalizeUrl))];
  return {
    nodeId: node.id || "",
    deviceId: node.agentIdentity?.deviceId || node.deviceId || "",
    agentUrls,
    removedAt: new Date().toISOString(),
  };
}

function localAgentMatchesRemovalMarker(node = {}, marker = {}) {
  const agentUrl = normalizeUrl(node.baseUrl || node.agentUrl || node.url || "");
  const nodeId = String(node.id || "").trim();
  const deviceId = String(node.agentIdentity?.deviceId || node.deviceId || "").trim();
  const markerUrls = new Set((marker.agentUrls || []).map(normalizeUrl));
  return Boolean(
    (marker.nodeId && nodeId && marker.nodeId === nodeId)
      || (marker.deviceId && deviceId && marker.deviceId === deviceId)
      || (agentUrl && markerUrls.has(agentUrl)),
  );
}

function isRemovedLocalAgentNode(state = {}, node = {}) {
  const agentUrl = normalizeUrl(node.baseUrl || node.agentUrl || node.url || "");
  if (!isExplicitLocalAgentNode(node)) return false;
  return normalizeRemovedLocalAgents(state.removedLocalAgents).some((marker) => localAgentMatchesRemovalMarker(node, marker));
}

function clearLocalAgentRemovalMarkersForNode(state = {}, node = {}) {
  const marker = getLocalAgentRemovalMarker(node);
  if (!marker) return normalizeRemovedLocalAgents(state.removedLocalAgents);
  return normalizeRemovedLocalAgents(state.removedLocalAgents).filter((entry) => !localAgentMatchesRemovalMarker(node, entry) && !localAgentMatchesRemovalMarker(marker, entry));
}

function getLocalIpAddresses() {
  const interfaces = require("os").networkInterfaces();
  return Object.values(interfaces).flat().filter(Boolean)
    .filter((entry) => !entry.internal)
    .map((entry) => entry.address)
    .filter(Boolean)
    .slice(0, 16);
}

function summarizeDependencyReadiness(result = null) {
  const dependencies = Array.isArray(result?.dependencies) ? result.dependencies : [];
  const ready = dependencies.filter((dependency) => dependency.state === "installed").length;
  const attention = dependencies.filter((dependency) => dependency.state !== "installed");
  return {
    checked: Boolean(result),
    ready,
    total: dependencies.length,
    attention: attention.length,
    state: !result ? "unknown" : attention.length ? "needs-attention" : "ready",
  };
}

function buildLocalNodeProfile({ node = {}, health = null, stats = null, instances = null, dependencies = null, service = null } = {}) {
  const identity = health?.identity || node.agentIdentity || {};
  return {
    localAgent: true,
    stableNodeId: node.id || nodeIdForDevice(identity.deviceId),
    displayName: node.displayName || LOCAL_AGENT_DISPLAY_NAME,
    customDisplayName: node.displayName && node.displayName !== LOCAL_AGENT_DISPLAY_NAME ? node.displayName : null,
    hostname: identity.hostname || stats?.hostname || null,
    operatingSystem: identity.operatingSystem || stats?.osVersion || null,
    windowsVersion: identity.platform === "win32" || stats?.platform === "win32" ? identity.operatingSystem || stats?.osVersion || null : null,
    platform: identity.platform || stats?.platform || null,
    architecture: identity.architecture || null,
    cpu: stats?.cpu ? { model: stats.cpu.model || null, cores: stats.cpu.cores || null, usagePercent: stats.cpu.usagePercent ?? null } : null,
    ram: stats?.memory ? { totalBytes: stats.memory.total ?? null, usedBytes: stats.memory.used ?? null, usagePercent: stats.memory.percent ?? null } : null,
    gpu: null,
    storage: stats?.disk || null,
    localIpAddresses: getLocalIpAddresses(),
    agentVersion: identity.agentVersion || health?.agentVersion || null,
    agentUptimeSeconds: health?.process?.uptimeSeconds ?? stats?.uptimeSeconds ?? null,
    serviceState: service?.state || null,
    dependencyReadiness: summarizeDependencyReadiness(dependencies),
    instanceCount: Array.isArray(instances?.instances) ? instances.instances.length : null,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeAgentCapabilitiesMetadata(value = null, fallback = {}) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return {
      ...value,
      os: value.os || fallback.os || null,
      supportsSystemMetrics: value.supportsSystemMetrics !== false,
      supportsDocker: value.supportsDocker === true ? true : value.supportsDocker === false ? false : null,
      supportsSsh: value.supportsSsh === true,
      supportsGameServers: value.supportsGameServers === true,
      supportsServiceControl: value.supportsServiceControl === true,
      supportsFileRoots: value.supportsFileRoots !== false,
      supportsPublicAccess: value.supportsPublicAccess !== false,
      supportsPlayit: value.supportsPlayit !== false,
      unsupportedActions: value.unsupportedActions && typeof value.unsupportedActions === "object" && !Array.isArray(value.unsupportedActions)
        ? value.unsupportedActions
        : {},
    };
  }
  const entries = Array.isArray(value) ? new Set(value.map((entry) => String(entry || "").trim()).filter(Boolean)) : new Set();
  return {
    os: fallback.os || null,
    supportsSystemMetrics: true,
    supportsDocker: entries.has("docker") ? true : null,
    supportsSsh: entries.has("ssh"),
    supportsGameServers: entries.has("gameServers") || entries.has("instances"),
    supportsServiceControl: entries.has("serviceControl"),
    supportsFileRoots: true,
    supportsPublicAccess: true,
    supportsPlayit: true,
    unsupportedActions: {},
  };
}

function normalizeRawCapabilitiesMetadata(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || "").trim()).filter(Boolean);
  }
  if (value && typeof value === "object") {
    return value;
  }
  return null;
}

function getNodeReportedCapabilities(node = {}) {
  const platform = node.platform || node.connection?.platform || node.agentIdentity?.platform || "";
  const fallbackOs = platform === "win32" ? "windows" : platform || null;
  return normalizeAgentCapabilitiesMetadata(
    node.connection?.capabilities || node.agentIdentity?.capabilities || node.capabilitiesMetadata || null,
    { os: fallbackOs },
  );
}

function buildNodeCapabilities(node = {}) {
  if (node.kind === "application-host") {
    return {
      applicationHost: true,
      agentApi: false,
      localAgent: false,
      remoteAgent: false,
      serviceControls: true,
      windowsServiceControls: process.platform === "win32",
      filesystem: true,
      marketplace: false,
      instances: true,
      backups: false,
      docker: false,
      publicAccess: true,
      dependencyManagement: false,
      unsupportedActions: {
        docker: "Docker workspace controls require an Agent node.",
        remoteAgentRegistration: "Remote Agent APIs require an Agent node.",
      },
    };
  }
  const localAgent = isExplicitLocalAgentNode(node);
  const reported = getNodeReportedCapabilities(node);
  const platform = node.platform || node.connection?.platform || node.agentIdentity?.platform || "";
  const windows = reported.os === "windows" || platform === "win32";
  const unsupportedActions = {
    ...(reported.unsupportedActions || {}),
    ...(localAgent
      ? {}
      : {
          localServiceInstall: "Local Agent service controls only apply to This PC.",
          localPairingRepair: "Automatic local pairing is only available for This PC.",
        }),
    ...(windows && reported.supportsGameServers !== true
      ? { gameServers: "Windows game-server hosting is coming later. Health, files, Public Access, and Docker detection are available for this MVP." }
      : {}),
    ...(windows && reported.supportsSsh !== true
      ? { ssh: "SSH controls are unavailable for Windows Agent MVP nodes unless configured separately." }
      : {}),
  };
  return {
    applicationHost: false,
    agentApi: true,
    localAgent,
    remoteAgent: !localAgent,
    serviceControls: localAgent,
    windowsServiceControls: localAgent && (process.platform === "win32" || platform === "win32"),
    filesystem: reported.supportsFileRoots !== false,
    marketplace: !windows || reported.supportsGameServers === true,
    instances: !windows || reported.supportsGameServers === true,
    backups: !windows || reported.supportsGameServers === true,
    docker: node.docker?.enabled !== false && reported.supportsDocker !== false,
    publicAccess: true,
    dependencyManagement: true,
    os: reported.os || (windows ? "windows" : platform || null),
    windowsMvp: windows,
    supportsSystemMetrics: reported.supportsSystemMetrics !== false,
    supportsDocker: reported.supportsDocker,
    supportsSsh: reported.supportsSsh === true,
    supportsGameServers: reported.supportsGameServers === true,
    supportsServiceControl: reported.supportsServiceControl === true,
    supportsFileRoots: reported.supportsFileRoots !== false,
    unsupportedActions,
  };
}

function readLocalAgentRuntimeConfig() {
  return readAgentRuntimeConfig(getRuntimeConfigPath());
}

function readLegacyAgentSettingsRaw() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getLegacyAgentConfigPath(), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function getLocalAgentPort() {
  const port = Number.parseInt(readLocalAgentRuntimeConfig().port, 10);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_LOCAL_AGENT_PORT;
}

function getLocalAgentUrls() {
  const port = getLocalAgentPort();
  return LOCAL_AGENT_HOSTS.map((host) => `http://${host}:${port}`);
}

function createLocalAgentConnectionStatus(patch = {}) {
  const baseStatus = patch.status || "offline";
  return {
    connected: patch.connected === true,
    status: baseStatus,
    displayStatus: patch.displayStatus || (baseStatus === "online" ? "Online" : baseStatus === "authentication-required" ? "Authentication Required" : "Offline"),
    localAgent: true,
    desktopApplication: "running",
    installed: patch.installed ?? null,
    serviceRunning: patch.serviceRunning ?? null,
    authenticated: patch.authenticated ?? null,
    remoteAvailability: "not-remote",
    versionCompatibility: patch.versionCompatibility || "unknown",
    message: patch.message || "",
    lastSeen: patch.lastSeen || null,
    latencyMs: Number.isFinite(Number(patch.latencyMs)) ? Number(patch.latencyMs) : null,
    agentVersion: patch.agentVersion || null,
    platform: patch.platform || null,
    operatingSystem: patch.operatingSystem || null,
    architecture: patch.architecture || null,
    hostname: patch.hostname || null,
  };
}

function normalizeConnectionState(value) {
  const state = String(value || "unknown").toLowerCase().replace(/-/g, "_");
  if (state === "authentication_required" || state === "unauthorized" || state === "auth_failed" || state === "token_mismatch") return "authentication_failed";
  if (state === "incompatible" || state === "version_incompatible") return "agent_incompatible";
  if (state === "partial" || state === "limited" || state === "warning") return "degraded";
  if (state === "connected") return "online";
  if (state === "disconnected" || state === "unreachable") return "offline";
  return HEALTH_STATES.has(state) ? state : "unknown";
}

function getConnectionDisplayStatus(state) {
  const normalized = normalizeConnectionState(state);
  if (normalized === "online") return "Online";
  if (normalized === "connecting") return "Connecting";
  if (normalized === "authentication_failed") return "Authentication Required";
  if (normalized === "agent_incompatible") return "Agent Incompatible";
  if (normalized === "degraded") return "Degraded";
  if (normalized === "offline") return "Offline";
  return "Unknown";
}

function classifyHealthError(error) {
  const status = classifyAgentError(error);
  if (status === AGENT_STATUS.AUTHENTICATION_REQUIRED) return "authentication_failed";
  if (status === AGENT_STATUS.DEGRADED) return "degraded";
  const code = String(error?.code || error?.payload?.error?.code || "").toUpperCase();
  const message = String(error?.message || "");
  if (error?.status === 401 || error?.status === 403 || code === "UNAUTHORIZED" || /unauthorized|forbidden|token|credential|auth/i.test(message)) {
    return "authentication_failed";
  }
  if (/INCOMPATIBLE|UNSUPPORTED|API_VERSION|VERSION/i.test(code) || /incompatible|unsupported api|update required/i.test(message)) {
    return "agent_incompatible";
  }
  return "offline";
}

async function probeAuthenticatedAgentEndpoint(config, options = {}) {
  try {
    return await agentClient.getSystemStats(config);
  } catch (error) {
    const status = classifyAgentError(error);
    if (status === AGENT_STATUS.AUTHENTICATION_REQUIRED || status === AGENT_STATUS.OFFLINE) {
      throw error;
    }
    return {
      partialFailure: {
        code: error?.code || null,
        message: error?.message || options.partialFailureMessage || "Authenticated Agent endpoint returned a partial failure.",
      },
    };
  }
}

function normalizeAgentApiMajor(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  const match = raw.match(/^v?(\d+)(?:\.0+)?$/);
  if (!match) return null;
  const major = Number.parseInt(match[1], 10);
  return Number.isInteger(major) && major > 0 ? major : null;
}

function normalizeAgentProtocolVersion(value) {
  if (value === null || value === undefined || value === "") return null;
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : null;
}

function getAgentCompatibilityReport(health = {}) {
  const reportedApiVersion = health.apiVersion ?? health.identity?.apiVersion ?? null;
  const reportedProtocolVersion = health.protocolVersion ?? health.identity?.protocolVersion ?? null;
  const apiMajor = normalizeAgentApiMajor(reportedApiVersion);
  const protocolVersion = normalizeAgentProtocolVersion(reportedProtocolVersion);
  const supportedApi = Array.from(SUPPORTED_AGENT_API_MAJOR_VERSIONS).map((major) => `v${major}`).join(", ");
  const supportedProtocol = MIN_AGENT_PROTOCOL_VERSION === MAX_AGENT_PROTOCOL_VERSION
    ? String(SUPPORTED_AGENT_PROTOCOL_VERSION)
    : `${MIN_AGENT_PROTOCOL_VERSION}-${MAX_AGENT_PROTOCOL_VERSION}`;
  let compatible = true;
  let reason = "compatible";
  if (health.compatible === false || health.apiCompatible === false) {
    compatible = false;
    reason = "agent-reported-incompatible";
  } else if (!apiMajor) {
    compatible = false;
    reason = "missing-or-malformed-api-version";
  } else if (!SUPPORTED_AGENT_API_MAJOR_VERSIONS.has(apiMajor)) {
    compatible = false;
    reason = "unsupported-api-major";
  } else if (!protocolVersion) {
    compatible = false;
    reason = "missing-or-malformed-protocol-version";
  } else if (protocolVersion < MIN_AGENT_PROTOCOL_VERSION) {
    compatible = false;
    reason = "protocol-below-minimum";
  } else if (protocolVersion > MAX_AGENT_PROTOCOL_VERSION) {
    compatible = false;
    reason = "protocol-above-maximum";
  }
  return {
    compatible,
    reason,
    supportedApi,
    supportedProtocol,
    supportedApiMajorVersions: Array.from(SUPPORTED_AGENT_API_MAJOR_VERSIONS),
    minProtocolVersion: MIN_AGENT_PROTOCOL_VERSION,
    maxProtocolVersion: MAX_AGENT_PROTOCOL_VERSION,
    reportedApi: reportedApiVersion ?? null,
    reportedApiMajor: apiMajor,
    reportedProtocol: reportedProtocolVersion ?? null,
    reportedProtocolVersion: protocolVersion,
    status: compatible ? "Compatible" : "Update Required",
  };
}

function formatAgentCompatibilityMessage(report = {}) {
  return `Control Center supports: API ${report.supportedApi || "v1"}, Protocol ${report.supportedProtocol || "1"}. Agent reports: API ${report.reportedApi ?? "missing"}, Protocol ${report.reportedProtocol ?? "missing"}. Status: ${report.status || "Unknown"}.`;
}

function isCompatibleAgentHealth(health = {}) {
  return getAgentCompatibilityReport(health).compatible;
}

function buildConnectionPatch({ state, message = "", latencyMs = null, checkedAt = new Date().toISOString(), health = null, previous = null, localAgent = false, compatibility = null }) {
  const normalized = normalizeConnectionState(state);
  const reachable = ["online", "authentication_failed", "agent_incompatible", "degraded"].includes(normalized);
  const identity = health?.identity || {};
  const compatibilityReport = compatibility || (health ? getAgentCompatibilityReport(health) : previous?.compatibility || null);
  const agentVersion = identity.agentVersion || health?.agentVersion || previous?.agentVersion || null;
  const platform = identity.platform || health?.platform || previous?.platform || null;
  const operatingSystem = identity.operatingSystem || health?.operatingSystem || previous?.operatingSystem || null;
  const architecture = identity.architecture || health?.architecture || previous?.architecture || null;
  const hostname = identity.hostname || health?.hostname || previous?.hostname || null;
  return {
    connected: normalized === "online",
    reachable,
    status: normalized,
    displayStatus: getConnectionDisplayStatus(normalized),
    message,
    lastSeen: reachable ? checkedAt : previous?.lastSeen || null,
    latencyMs: Number.isFinite(Number(latencyMs)) ? Number(latencyMs) : null,
    localAgent,
    desktopApplication: localAgent ? "running" : null,
    installed: reachable ? true : previous?.installed ?? null,
    serviceRunning: reachable ? true : normalized === "offline" ? false : previous?.serviceRunning ?? null,
    authenticated: normalized === "authentication_failed" ? false : ["online", "degraded"].includes(normalized) ? true : previous?.authenticated ?? null,
    authenticatedEndpointOk: ["online", "degraded"].includes(normalized),
    partialFailure: normalized === "degraded" ? message || "Authenticated endpoint returned a partial failure." : null,
    remoteAvailability: localAgent ? "not-remote" : null,
    versionCompatibility: normalized === "agent_incompatible" ? "update-required" : normalized === "online" ? "compatible" : previous?.versionCompatibility || "unknown",
    agentVersion,
    apiVersion: health?.apiVersion || identity.apiVersion || previous?.apiVersion || null,
    protocolVersion: health?.protocolVersion ?? identity.protocolVersion ?? previous?.protocolVersion ?? null,
    compatibility: compatibilityReport,
    platform,
    operatingSystem,
    architecture,
    hostname,
    capabilities: normalizeAgentCapabilitiesMetadata(health?.capabilities || identity.capabilities || previous?.capabilities || null, {
      os: (identity.platform || health?.platform || previous?.platform) === "win32" ? "windows" : identity.platform || health?.platform || previous?.platform || null,
    }),
  };
}

function normalizeTags(value) {
  return Array.isArray(value)
    ? value.map((tag) => String(tag || "").trim()).filter(Boolean).slice(0, 20)
    : [];
}

function normalizeAgentNode(node = {}) {
  const agentUrl = normalizeUrl(node.baseUrl || node.agentUrl || node.url);
  const identity = node.agentIdentity || node.identity || {};
  const agentInstallationId = identity.agentInstallationId || identity.installationId || node.agentInstallationId || "";
  const agentIdentityId = identity.agentIdentityId || identity.identityId || node.agentIdentityId || "";
  const deviceId = identity.deviceId || node.deviceId || agentIdentityId || agentInstallationId || legacyDeviceId(agentUrl);
  const nodeId = node.id && node.id !== "default" ? node.id : nodeIdForDevice(deviceId);
  const credentialToken = getNodeToken(nodeId);
  const rawToken = String(node.agentToken || node.token || "");
  const requestedDisplayName = String(node.displayName || node.name || "").trim();
  const identityHostname = String(identity.hostname || "").trim();
  const localAgent = isExplicitLocalAgentNode(node);
  const displayName = localAgent
    ? requestedDisplayName && !isDefaultLocalAgentDisplayName(requestedDisplayName) ? requestedDisplayName : LOCAL_AGENT_DISPLAY_NAME
    : isGenericNodeDisplayName(requestedDisplayName) && identityHostname
    ? identityHostname
    : requestedDisplayName || identityHostname || "Agent Node";
  const capabilityFallback = { os: identity.platform === "win32" ? "windows" : identity.platform || node.platform || node.connection?.platform || null };
  const capabilitiesMetadata = normalizeRawCapabilitiesMetadata(node.capabilitiesMetadata || node.connection?.capabilities || identity.capabilities || node.capabilities || null);
  const normalizedCapabilitiesMetadata = normalizeAgentCapabilitiesMetadata(capabilitiesMetadata, capabilityFallback);
  const normalizedIdentity = {
    agentInstallationId,
    agentIdentityId,
    deviceId,
    hostname: identity.hostname || "",
    operatingSystem: identity.operatingSystem || "",
    platform: identity.platform || "",
    architecture: identity.architecture || "",
    agentVersion: identity.agentVersion || "",
    apiVersion: identity.apiVersion || "",
    capabilities: normalizeAgentCapabilitiesMetadata(identity.capabilities || normalizedCapabilitiesMetadata, capabilityFallback),
  };
  return {
    id: nodeId,
    kind: "agent",
    name: displayName.slice(0, 80),
    displayName: displayName.slice(0, 80),
    baseUrl: agentUrl,
    agentUrl,
    agentToken: credentialToken || rawToken,
    enabled: node.enabled !== false,
    description: String(node.description || "").trim().slice(0, 500),
    tags: normalizeTags(node.tags),
    lastConnectionState: normalizeConnectionState(node.lastConnectionState || node.connection?.status || "unknown"),
    lastSuccessfulHealthCheck: node.lastSuccessfulHealthCheck || node.connection?.lastSeen || null,
    lastHealthCheckedAt: node.lastHealthCheckedAt || node.connection?.checkedAt || null,
    lastHealthErrorCode: node.lastHealthErrorCode || null,
    lastErrorCategory: node.lastErrorCategory || null,
    agentVersion: node.agentVersion || node.connection?.agentVersion || identity.agentVersion || "",
    apiVersion: node.apiVersion || node.connection?.apiVersion || identity.apiVersion || "",
    platform: node.platform || node.connection?.platform || identity.platform || "",
    hostname: node.hostname || node.connection?.hostname || identity.hostname || "",
    capabilitiesMetadata,
    agentInstallationId,
    agentIdentityId,
    agentIdentity: normalizedIdentity,
    docker: { enabled: node.docker?.enabled !== false, runtime: node.docker?.runtime || "docker" },
    ownerMachine: Boolean(node.ownerMachine),
    localAgent,
    local: localAgent,
    modeLabel: localAgent ? "Registered Local Agent Node" : "Registered Remote Agent Node",
    nodeTypeLabel: "Registered Agent Node",
    builtIn: false,
    removable: true,
    profile: localAgent ? node.profile || buildLocalNodeProfile({ node: { ...node, displayName }, health: { identity } }) : node.profile || null,
    capabilities: buildNodeCapabilities({ ...node, kind: "agent", agentUrl, localAgent, agentIdentity: normalizedIdentity, capabilitiesMetadata }),
    connection: node.connection && typeof node.connection === "object" ? {
      connected: node.connection.connected === true,
      reachable: node.connection.reachable === true || node.connection.connected === true || ["online", "authentication_failed", "agent_incompatible"].includes(normalizeConnectionState(node.connection.status)),
      status: node.connection.status || (node.connection.connected ? "online" : "offline"),
      displayStatus: node.connection.displayStatus || (node.connection.connected ? "Online" : "Offline"),
      message: node.connection.message || "",
      lastSeen: node.connection.lastSeen || null,
      latencyMs: Number.isFinite(Number(node.connection.latencyMs)) ? Number(node.connection.latencyMs) : null,
      localAgent: node.connection.localAgent === true || localAgent,
      desktopApplication: node.connection.desktopApplication || (localAgent ? "running" : null),
      installed: node.connection.installed ?? null,
      serviceRunning: node.connection.serviceRunning ?? null,
      authenticated: node.connection.authenticated ?? null,
      remoteAvailability: node.connection.remoteAvailability || (localAgent ? "not-remote" : null),
      versionCompatibility: node.connection.versionCompatibility || "unknown",
      agentVersion: node.connection.agentVersion || identity.agentVersion || null,
      apiVersion: node.connection.apiVersion || identity.apiVersion || null,
      protocolVersion: node.connection.protocolVersion ?? identity.protocolVersion ?? null,
      compatibility: node.connection.compatibility && typeof node.connection.compatibility === "object" ? node.connection.compatibility : null,
      platform: node.connection.platform || identity.platform || null,
      operatingSystem: node.connection.operatingSystem || identity.operatingSystem || null,
      architecture: node.connection.architecture || identity.architecture || null,
      hostname: node.connection.hostname || identity.hostname || null,
      capabilities: normalizeAgentCapabilitiesMetadata(node.connection.capabilities || identity.capabilities || normalizedCapabilitiesMetadata, capabilityFallback),
    } : null,
    createdAt: node.createdAt || new Date().toISOString(),
    updatedAt: node.updatedAt || new Date().toISOString(),
    executionTarget: { type: "agent", deviceId, localAgent },
  };
}

function mergeAgentNodes(nodes) {
  const byDevice = new Map();
  for (const raw of nodes.map(normalizeAgentNode)) {
    const key = raw.agentIdentity.agentInstallationId || raw.agentIdentity.agentIdentityId || raw.agentIdentity.deviceId;
    const current = byDevice.get(key);
    if (!current) { byDevice.set(key, raw); continue; }
    byDevice.set(key, {
      ...current,
      name: isGenericNodeDisplayName(current.name || current.displayName) && !isGenericNodeDisplayName(raw.name || raw.displayName) ? raw.name || raw.displayName : current.name || current.displayName || raw.name || raw.displayName,
      displayName: isGenericNodeDisplayName(current.displayName) && !isGenericNodeDisplayName(raw.displayName) ? raw.displayName : current.displayName || raw.displayName,
      baseUrl: current.localAgent ? current.baseUrl || current.agentUrl : current.baseUrl || current.agentUrl || raw.baseUrl || raw.agentUrl,
      agentUrl: current.localAgent ? current.agentUrl : current.agentUrl || raw.agentUrl,
      agentToken: current.agentToken || raw.agentToken,
      enabled: current.enabled !== false && raw.enabled !== false,
      description: current.description || raw.description || "",
      tags: normalizeTags([...(current.tags || []), ...(raw.tags || [])]),
      lastConnectionState: current.lastConnectionState || raw.lastConnectionState || "unknown",
      lastSuccessfulHealthCheck: current.lastSuccessfulHealthCheck || raw.lastSuccessfulHealthCheck || null,
      lastHealthCheckedAt: current.lastHealthCheckedAt || raw.lastHealthCheckedAt || null,
      lastHealthErrorCode: current.lastHealthErrorCode || raw.lastHealthErrorCode || null,
      lastErrorCategory: current.lastErrorCategory || raw.lastErrorCategory || null,
      agentVersion: current.agentVersion || raw.agentVersion || "",
      apiVersion: current.apiVersion || raw.apiVersion || "",
      platform: current.platform || raw.platform || "",
      hostname: current.hostname || raw.hostname || "",
      capabilitiesMetadata: current.capabilitiesMetadata || raw.capabilitiesMetadata || null,
      agentInstallationId: current.agentInstallationId || raw.agentInstallationId || "",
      agentIdentityId: current.agentIdentityId || raw.agentIdentityId || "",
      agentIdentity: { ...raw.agentIdentity, ...Object.fromEntries(Object.entries(current.agentIdentity).filter(([, value]) => value)) },
      docker: current.docker || raw.docker,
      ownerMachine: current.ownerMachine || raw.ownerMachine,
      localAgent: current.localAgent || raw.localAgent,
      local: current.local || raw.local,
      modeLabel: getAgentNodeModeLabel(current.localAgent || raw.localAgent ? { ...current, localAgent: true } : current),
      connection: current.connection || raw.connection,
      updatedAt: new Date().toISOString(),
    });
  }
  return [...byDevice.values()];
}

async function discoverLocalAgentNode(state) {
  const effective = getEffectiveAgentSettings();
  const existingLocal = state.nodes.find((node) => node.localAgent === true || isLocalAgentUrl(node.agentUrl));
  let lastError = null;

  for (const agentUrl of getLocalAgentUrls()) {
    const startedAt = Date.now();
    try {
      const health = await getHealth({
        backendMode: "agent",
        agentUrl,
        agentToken: "",
        targetLabel: "local-agent-discovery",
        suppressConnectionRefusedLog: true,
        logThrottleMs: 60000,
      });
      const identity = health.identity || {};
      if (!identity.deviceId) {
        continue;
      }
      const healthConfig = {
        backendMode: "agent",
        agentUrl,
        agentToken: effective.agentToken || existingLocal?.agentToken || "",
      };
      const [stats, instances, dependencies] = await Promise.all([
        agentClient.getSystemStats(healthConfig).catch(() => null),
        agentClient.listInstances(healthConfig).catch(() => null),
        agentClient.checkDependencies({ dependencyIds: ["java", "docker", "git", "steamcmd", "dotnet-runtime", "dotnet-desktop-runtime", "powershell", "ffmpeg", "tailscale", "cloudflared", "playit", "vcredist-runtime"] }, healthConfig).catch(() => null),
      ]);
      return normalizeAgentNode({
        ...existingLocal,
        id: existingLocal?.id && existingLocal.id !== nodeIdForDevice(existingLocal?.agentIdentity?.deviceId) ? existingLocal.id : nodeIdForDevice(identity.deviceId),
        displayName: existingLocal?.displayName || LOCAL_AGENT_DISPLAY_NAME,
        agentUrl,
        agentToken: effective.agentToken || existingLocal?.agentToken || "",
        agentIdentity: identity,
        ownerMachine: true,
        localAgent: true,
        connection: createLocalAgentConnectionStatus({
          connected: true,
          status: "online",
          displayStatus: "Online",
          installed: true,
          serviceRunning: true,
          authenticated: health.tokenConfigured === true ? Boolean(effective.agentToken) : true,
          versionCompatibility: "unknown",
          message: "Local Agent is responding on this PC.",
          lastSeen: new Date().toISOString(),
          latencyMs: Date.now() - startedAt,
          agentVersion: identity.agentVersion || health.agentVersion || null,
          platform: identity.platform || null,
          operatingSystem: identity.operatingSystem || null,
          architecture: identity.architecture || null,
          hostname: identity.hostname || null,
        }),
        profile: buildLocalNodeProfile({
          node: { ...existingLocal, id: existingLocal?.id || nodeIdForDevice(identity.deviceId), displayName: existingLocal?.displayName || LOCAL_AGENT_DISPLAY_NAME, agentIdentity: identity },
          health,
          stats,
          instances,
          dependencies,
          service: { state: "running" },
        }),
      });
    } catch (error) {
      lastError = error;
    }
  }

  if (!existingLocal) {
    return null;
  }

  return normalizeAgentNode({
    ...existingLocal,
    displayName: existingLocal?.displayName || LOCAL_AGENT_DISPLAY_NAME,
    localAgent: true,
    ownerMachine: true,
    connection: createLocalAgentConnectionStatus({
      connected: false,
      status: lastError?.status === 401 || lastError?.code === "UNAUTHORIZED" ? "authentication-required" : "offline",
      displayStatus: lastError?.status === 401 || lastError?.code === "UNAUTHORIZED" ? "Authentication Required" : "Offline",
      installed: null,
      serviceRunning: false,
      authenticated: lastError?.status === 401 || lastError?.code === "UNAUTHORIZED" ? false : null,
      message: lastError?.message || "Local Agent is not responding on this PC.",
      lastSeen: existingLocal.connection?.lastSeen || null,
    }),
  });
}

async function withDiscoveredLocalAgent(state) {
  const localNode = await discoverLocalAgentNode(state);
  if (!localNode) {
    return state;
  }
  if (isRemovedLocalAgentNode(state, localNode)) {
    return { ...state, nodes: state.nodes.filter((node) => !isRemovedLocalAgentNode(state, node)) };
  }
  const nodes = mergeAgentNodes([
    ...state.nodes.filter((node) => !(node.localAgent === true || isLocalAgentUrl(node.agentUrl) || node.agentIdentity?.deviceId === localNode.agentIdentity.deviceId)),
    localNode,
  ]);
  const currentSelection = state.selectedNodeId || APPLICATION_HOST_NODE_ID;
  const selectedRemoteNode = nodes.find((node) => node.id === currentSelection && node.localAgent !== true);
  const shouldDefaultToLocal = !selectedRemoteNode && localNode.connection?.connected === true;
  return { ...state, selectedNodeId: shouldDefaultToLocal ? localNode.id : currentSelection, nodes };
}

function migrateState(parsed = {}) {
  const rawLegacy = readLegacyAgentSettingsRaw();
  const effective = getEffectiveAgentSettings();
  const removedLocalAgents = normalizeRemovedLocalAgents(parsed.removedLocalAgents || parsed.removedLocalAgentNodes);
  const legacyNodes = Array.isArray(parsed.nodes)
    ? parsed.nodes
        .filter((node) => node.id !== APPLICATION_HOST_NODE_ID && node.kind !== "application-host")
        .filter((node) => !isRemovedLocalAgentNode({ removedLocalAgents }, node))
    : [];
  const rawLegacyUrl = String(rawLegacy.agentUrl || rawLegacy.url || process.env.AGENT_URL || "").trim();
  const canMigrateLegacyAgent = effective.backendMode === "agent" && rawLegacyUrl && effective.agentUrl;
  const legacyAgentRemoved = canMigrateLegacyAgent && isRemovedLocalAgentNode({ removedLocalAgents }, { agentUrl: effective.agentUrl, localAgent: isLocalAgentUrl(effective.agentUrl) });
  if (canMigrateLegacyAgent && !legacyAgentRemoved) {
    const legacyUrl = normalizeUrl(effective.agentUrl);
    const existingIndex = legacyNodes.findIndex((node) => normalizeUrl(node.baseUrl || node.agentUrl || node.url) === legacyUrl);
    if (existingIndex >= 0) {
      const existing = legacyNodes[existingIndex];
      legacyNodes[existingIndex] = {
        ...existing,
        baseUrl: existing.baseUrl || existing.agentUrl || legacyUrl,
        agentUrl: existing.agentUrl || existing.baseUrl || legacyUrl,
        agentToken: existing.agentToken || existing.token || getNodeToken(existing.id) || effective.agentToken,
        legacyGlobalAgent: existing.legacyGlobalAgent !== false,
        localAgent: existing.localAgent === true || isLocalAgentUrl(legacyUrl),
        ownerMachine: existing.ownerMachine === true || isLocalAgentUrl(legacyUrl),
      };
    } else {
      legacyNodes.push({ displayName: "Owner Machine", baseUrl: effective.agentUrl, agentUrl: effective.agentUrl, agentToken: effective.agentToken, legacyGlobalAgent: true, localAgent: isLocalAgentUrl(legacyUrl), ownerMachine: isLocalAgentUrl(legacyUrl) });
    }
  }
  const nodes = mergeAgentNodes(legacyNodes).filter((node) => !isRemovedLocalAgentNode({ removedLocalAgents }, node));
  const hadPersistedSelection = Boolean(parsed.selectedNodeId);
  let selectedNodeId = parsed.selectedNodeId || (nodes.length === 1 ? nodes[0].id : APPLICATION_HOST_NODE_ID);
  if (selectedNodeId === "default") selectedNodeId = effective.backendMode === "agent" && nodes[0] ? nodes[0].id : APPLICATION_HOST_NODE_ID;
  if (selectedNodeId !== APPLICATION_HOST_NODE_ID && !nodes.some((node) => node.id === selectedNodeId)) selectedNodeId = nodes.length === 1 ? nodes[0].id : APPLICATION_HOST_NODE_ID;
  if (!hadPersistedSelection && nodes.length > 1) selectedNodeId = APPLICATION_HOST_NODE_ID;
  if (selectedNodeId === APPLICATION_HOST_NODE_ID) {
    const localNode = nodes.find((node) => node.localAgent === true || isLocalAgentUrl(node.agentUrl));
    if (localNode && effective.backendMode === "agent" && isLocalAgentUrl(effective.agentUrl)) selectedNodeId = localNode.id;
  }
  return { schemaVersion: NODE_SCHEMA_VERSION, selectedNodeId, nodes, removedLocalAgents };
}

function toPersistentNode(node) {
  const { agentToken, token, ...persistentNode } = node;
  if (persistentNode.baseUrl && !persistentNode.agentUrl) {
    persistentNode.agentUrl = persistentNode.baseUrl;
  }
  return persistentNode;
}

function toPersistentState(state) {
  return {
    schemaVersion: NODE_SCHEMA_VERSION,
    selectedNodeId: state.selectedNodeId,
    nodes: state.nodes.map(toPersistentNode),
    removedLocalAgents: normalizeRemovedLocalAgents(state.removedLocalAgents),
  };
}

function needsCredentialWrite(state) {
  if (!localCredentialsUnlocked() || nodeCredentialRecovery?.degraded) return false;
  return state.nodes.some((node) => node.kind === "agent" && node.id && node.agentToken && getNodeToken(node.id) !== node.agentToken);
}

function readNodeState() {
  const nodesPath = getNodesPath();
  let parsed = {};
  if (fs.existsSync(nodesPath)) {
    const raw = fs.readFileSync(nodesPath, "utf8");
    try {
      parsed = JSON.parse(raw);
    } catch {
      const backupPath = `${nodesPath}.corrupt.backup`;
      if (!fs.existsSync(backupPath)) fs.copyFileSync(nodesPath, backupPath);
      throw Object.assign(new Error("Node configuration is unreadable. The original file was preserved for recovery."), { code: "NODE_CONFIG_CORRUPT", backupPath });
    }
    const schemaVersion = Number(parsed?.schemaVersion || 0);
    if (schemaVersion > NODE_SCHEMA_VERSION) {
      throw Object.assign(new Error(`Node configuration schema ${schemaVersion} is newer than this application supports.`), {
        code: "NODE_SCHEMA_UNSUPPORTED",
        schemaVersion,
        supportedSchemaVersion: NODE_SCHEMA_VERSION,
      });
    }
    if (schemaVersion < NODE_SCHEMA_VERSION) {
      const backupPath = `${nodesPath}.schema-v${schemaVersion}.backup`;
      if (!fs.existsSync(backupPath)) fs.copyFileSync(nodesPath, backupPath);
    }
  }
  const state = migrateState(parsed);
  if (localCredentialsUnlocked() && (parsed.schemaVersion !== NODE_SCHEMA_VERSION || JSON.stringify(parsed) !== JSON.stringify(toPersistentState(state)) || needsCredentialWrite(state))) {
    writeNodeState(state);
  }
  return state;
}

function writeNodeState(state) {
  requireNodeCredentialWrite("node-config-write", "Unlock AnxOS to manage nodes.");
  ensureConfigDirectory();
  const nodes = state.nodes.map((node) => {
    if (node.kind === "agent" && node.id && node.agentToken && getNodeToken(node.id) !== node.agentToken) {
      setNodeToken(node.id, node.agentToken);
    }
    return toPersistentNode(node);
  });
  const target = getNodesPath();
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ schemaVersion: NODE_SCHEMA_VERSION, selectedNodeId: state.selectedNodeId, nodes, removedLocalAgents: normalizeRemovedLocalAgents(state.removedLocalAgents) }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function publicNode(node) {
  if (node.kind === "application-host") {
    const connection = {
      connected: true,
      status: "online",
      message: "Application host is available.",
      lastSeen: new Date().toISOString(),
      latencyMs: 0,
      authenticated: true,
      authenticatedEndpointOk: true,
    };
    return {
      ...node,
      capabilities: buildNodeCapabilities(node),
      connection,
      agentStatus: createAgentStatusSnapshot({ target: node, connection, state: AGENT_STATUS.CONNECTED, message: connection.message, targetType: "application-host" }),
    };
  }
  const publicPayload = { ...node, baseUrl: node.baseUrl || node.agentUrl, name: node.name || node.displayName, capabilities: buildNodeCapabilities(node), hasToken: Boolean(node.agentToken || hasNodeToken(node.id)), agentToken: node.agentToken || hasNodeToken(node.id) ? "[configured]" : "", local: node.localAgent === true, modeLabel: getAgentNodeModeLabel(node), nodeTypeLabel: "Registered Agent Node", builtIn: false, removable: true, localProfile: node.localAgent === true ? node.profile || null : null };
  return {
    ...publicPayload,
    agentStatus: createAgentStatusSnapshot({
      target: publicPayload,
      connection: publicPayload.connection,
      message: publicPayload.connection?.message,
      checkedAt: publicPayload.lastHealthCheckedAt,
      targetType: publicPayload.localAgent ? "local-agent" : "registered-node",
    }),
  };
}

function applyHealthPatchToNode(node, patch = {}) {
  const checkedAt = patch.checkedAt || new Date().toISOString();
  const state = normalizeConnectionState(patch.state);
  const localAgent = node.localAgent === true || isLocalAgentUrl(node.agentUrl);
  const previousConnection = node.connection || {};
  const connection = buildConnectionPatch({
    state,
    message: patch.message || "",
    latencyMs: patch.latencyMs,
    checkedAt,
    health: patch.health || null,
    previous: previousConnection,
    localAgent,
    compatibility: patch.compatibility || null,
  });
  const identity = patch.health?.identity || node.agentIdentity || {};
  const rawCapabilitiesMetadata = normalizeRawCapabilitiesMetadata(
    patch.health?.capabilities || identity.capabilities || node.capabilitiesMetadata || null,
  );
  const lastSuccessfulHealthCheck = state === "online" ? checkedAt : node.lastSuccessfulHealthCheck || previousConnection.lastSeen || null;
  return normalizeAgentNode({
    ...node,
    lastConnectionState: state,
    lastSuccessfulHealthCheck,
    lastHealthCheckedAt: checkedAt,
    lastHealthErrorCode: patch.errorCode || null,
    lastErrorCategory: state === "online" ? null : state,
    agentVersion: connection.agentVersion || node.agentVersion || "",
    apiVersion: connection.apiVersion || node.apiVersion || "",
    platform: connection.platform || node.platform || "",
    hostname: connection.hostname || node.hostname || "",
    capabilitiesMetadata: rawCapabilitiesMetadata || connection.capabilities || node.capabilitiesMetadata || null,
    agentIdentity: {
      ...node.agentIdentity,
      ...identity,
      deviceId: identity.deviceId || node.agentIdentity?.deviceId,
    },
    connection,
    profile: localAgent && state === "online"
      ? buildLocalNodeProfile({ node, health: patch.health, service: { state: "running" } })
      : node.profile,
  });
}

function updateNodeHealthState(nodeId, patch = {}) {
  const state = readNodeState();
  const index = state.nodes.findIndex((node) => node.id === nodeId);
  if (index < 0) {
    throw Object.assign(new Error("Node not found."), { code: "NODE_NOT_FOUND" });
  }
  const nodes = [...state.nodes];
  nodes[index] = applyHealthPatchToNode(nodes[index], patch);
  const next = { ...state, nodes };
  writeNodeState(next);
  return nodes[index];
}

function advanceNodeHealthGeneration(nodeId) {
  const generation = (nodeHealthGenerations.get(nodeId) || 0) + 1;
  nodeHealthGenerations.set(nodeId, generation);
  return generation;
}

function recordAuthenticatedNodeHealth(payload = {}) {
  const health = payload.health && typeof payload.health === "object" ? payload.health : {};
  const resolution = resolveNodeForAgentIdentity({
    nodeId: payload.nodeId,
    agentUrl: payload.agentUrl,
    identity: health.identity || payload.identity,
  });
  if (resolution.ambiguous) {
    throw Object.assign(new Error("Authenticated Agent identity matches multiple registered nodes."), {
      code: "NODE_IDENTITY_AMBIGUOUS",
      candidates: resolution.candidates,
    });
  }
  if (!resolution.node) {
    throw Object.assign(new Error("Authenticated Agent identity does not match a registered node."), {
      code: "NODE_IDENTITY_NOT_REGISTERED",
    });
  }
  advanceNodeHealthGeneration(resolution.nodeId);
  const updated = updateNodeHealthState(resolution.nodeId, {
    state: "online",
    message: payload.message || "Authenticated Agent endpoint responded.",
    latencyMs: payload.latencyMs,
    health,
    compatibility: payload.compatibility || getAgentCompatibilityReport(health),
    checkedAt: payload.checkedAt || new Date().toISOString(),
  });
  return publicNode(updated);
}

async function checkNodeHealth(nodeId, options = {}) {
  const node = getNode(nodeId);
  if (node.kind === "application-host") {
    return {
      nodeId: APPLICATION_HOST_NODE_ID,
      state: "online",
      connected: true,
      status: "online",
      message: "Application host is available.",
      node: publicNode(node),
      checkedAt: new Date().toISOString(),
    };
  }
  if (node.enabled === false) {
    const updated = updateNodeHealthState(node.id, {
      state: "unknown",
      message: "Node is disabled.",
      errorCode: "NODE_DISABLED",
      checkedAt: new Date().toISOString(),
    });
    return {
      nodeId: node.id,
      state: "unknown",
      connected: false,
      status: "unknown",
      message: "Node is disabled.",
      node: publicNode(updated),
      checkedAt: updated.lastHealthCheckedAt,
    };
  }
  if (inFlightHealthChecks.has(node.id)) {
    return inFlightHealthChecks.get(node.id);
  }
  const generation = advanceNodeHealthGeneration(node.id);
  const run = (async () => {
    const startedAt = Date.now();
    const checkedAt = new Date().toISOString();
    updateNodeHealthState(node.id, {
      state: "connecting",
      message: "Checking Agent health.",
      checkedAt,
    });
    try {
      const health = await getHealth(getNodeAgentConfigFromNode(node), {
        timeoutMs: options.timeoutMs || 8000,
        targetLabel: `node-health:${node.id}`,
        suppressConnectionRefusedLog: true,
        logThrottleMs: 60000,
      });
      const compatibility = getAgentCompatibilityReport(health);
      const authenticatedProbe = compatibility.compatible
        ? await probeAuthenticatedAgentEndpoint(getNodeAgentConfigFromNode(node), { partialFailureMessage: "Agent health responded, but an authenticated endpoint returned a partial failure." })
        : null;
      const state = compatibility.compatible
        ? authenticatedProbe?.partialFailure ? "degraded" : "online"
        : "agent_incompatible";
      const message = state === "online"
        ? `Authenticated Agent endpoint responded. ${formatAgentCompatibilityMessage(compatibility)}`
        : state === "degraded"
        ? authenticatedProbe.partialFailure.message
        : formatAgentCompatibilityMessage(compatibility);
      if (nodeHealthGenerations.get(node.id) !== generation) {
        const current = getNode(node.id);
        return {
          nodeId: current.id,
          state: current.lastConnectionState,
          connected: current.connection?.connected === true,
          status: current.connection?.status,
          message: current.connection?.message,
          latencyMs: current.connection?.latencyMs ?? null,
          node: publicNode(current),
          health,
          checkedAt: current.lastHealthCheckedAt,
          stale: true,
        };
      }
      const updated = updateNodeHealthState(node.id, {
        state,
        message,
        latencyMs: Date.now() - startedAt,
        health,
        compatibility,
        checkedAt: new Date().toISOString(),
      });
      return {
        nodeId: updated.id,
        state,
        connected: state === "online",
        status: state,
        message,
        latencyMs: updated.connection?.latencyMs ?? null,
        node: publicNode(updated),
        health,
        checkedAt: updated.lastHealthCheckedAt,
      };
    } catch (error) {
      const state = classifyHealthError(error);
      const message = state === "authentication_failed"
        ? `${node.displayName || node.name || node.id} credential rejected.`
        : state === "agent_incompatible"
        ? "Agent API version is not compatible with this Control Center."
        : error?.message || "Agent is unreachable.";
      if (nodeHealthGenerations.get(node.id) !== generation) {
        const current = getNode(node.id);
        return {
          nodeId: current.id,
          state: current.lastConnectionState,
          connected: current.connection?.connected === true,
          status: current.connection?.status,
          message: current.connection?.message,
          node: publicNode(current),
          checkedAt: current.lastHealthCheckedAt,
          stale: true,
        };
      }
      const updated = updateNodeHealthState(node.id, {
        state,
        message,
        errorCode: error?.code || null,
        checkedAt: new Date().toISOString(),
      });
      return {
        nodeId: updated.id,
        state,
        connected: false,
        status: state,
        message,
        errorCode: error?.code || null,
        node: publicNode(updated),
        checkedAt: updated.lastHealthCheckedAt,
      };
    } finally {
      if (inFlightHealthChecks.get(node.id) === run) inFlightHealthChecks.delete(node.id);
    }
  })();
  inFlightHealthChecks.set(node.id, run);
  return run;
}

async function checkAllNodeHealth(options = {}) {
  const state = readNodeState();
  const checks = await Promise.allSettled(state.nodes.map((node) => checkNodeHealth(node.id, options)));
  return {
    checkedAt: new Date().toISOString(),
    nodes: checks.map((result, index) => result.status === "fulfilled"
      ? result.value
      : {
          nodeId: state.nodes[index]?.id || null,
          state: "unknown",
          connected: false,
          status: "unknown",
          message: result.reason?.message || "Node health check failed.",
        }),
  };
}

async function refreshIdentities(state) {
  await Promise.allSettled(state.nodes.map((node) => checkNodeHealth(node.id, { timeoutMs: 5000 })));
  const refreshedState = readNodeState();
  const nodes = mergeAgentNodes(refreshedState.nodes);
  const selectedDevice = state.nodes.find((node) => node.id === state.selectedNodeId)?.agentIdentity?.deviceId;
  const selectedNodeId = selectedDevice ? nodes.find((node) => node.agentIdentity.deviceId === selectedDevice)?.id || state.selectedNodeId : state.selectedNodeId;
  const next = { ...state, selectedNodeId, nodes };
  writeNodeState(next);
  return next;
}

async function listNodes(options = {}) {
  if (!localCredentialsUnlocked()) {
    const state = readNodeState();
    return {
      schemaVersion: NODE_SCHEMA_VERSION,
      applicationHost: getApplicationHostNode().applicationHost,
      selectedNodeId: state.selectedNodeId,
      credentialsLocked: true,
      recoveryMessage: "Saved node credentials could not be restored. Unlock AnxOS to continue.",
      nodes: [publicNode(getApplicationHostNode()), ...state.nodes.map(publicNode)],
      configPath: getNodesPath(),
    };
  }
  const initialState = readNodeState();
  if (nodeCredentialRecovery?.degraded) {
    return {
      schemaVersion: NODE_SCHEMA_VERSION,
      applicationHost: getApplicationHostNode().applicationHost,
      selectedNodeId: initialState.selectedNodeId,
      credentialRecovery: nodeCredentialRecovery,
      nodes: [publicNode(getApplicationHostNode()), ...initialState.nodes.map(publicNode)],
      configPath: getNodesPath(),
    };
  }
  const discoveredState = options.discoverLocalAgent === false ? initialState : await withDiscoveredLocalAgent(initialState);
  const state = options.refreshIdentity === false ? discoveredState : await refreshIdentities(discoveredState);
  return {
    schemaVersion: NODE_SCHEMA_VERSION,
    applicationHost: getApplicationHostNode().applicationHost,
    selectedNodeId: state.selectedNodeId,
    credentialRecovery: nodeCredentialRecovery,
    nodes: [publicNode(getApplicationHostNode()), ...state.nodes.map(publicNode)],
    configPath: getNodesPath(),
  };
}

function getNode(nodeId) {
  const id = nodeId || readNodeState().selectedNodeId;
  if (id === APPLICATION_HOST_NODE_ID || id === "default") return getApplicationHostNode();
  const node = readNodeState().nodes.find((entry) => entry.id === id);
  if (!node) throw Object.assign(new Error("Node not found."), { code: "NODE_NOT_FOUND" });
  return node;
}

function getAgentIdentityCandidate(payload = {}) {
  const identity = payload.agentIdentity || payload.identity || payload;
  return {
    nodeId: payload.nodeId || payload.id || "",
    agentInstallationId: identity.agentInstallationId || identity.installationId || payload.agentInstallationId || "",
    agentIdentityId: identity.agentIdentityId || identity.identityId || payload.agentIdentityId || "",
    deviceId: identity.deviceId || payload.deviceId || "",
    agentUrl: normalizeUrl(payload.agentUrl || payload.baseUrl || payload.url || ""),
  };
}

function resolveNodeForAgentIdentity(payload = {}) {
  const candidate = getAgentIdentityCandidate(payload);
  const nodes = readNodeState().nodes;
  const match = (predicate) => nodes.filter((node) => predicate(node));
  const finish = (matches, matchType) => {
    if (matches.length === 1) return { node: matches[0], nodeId: matches[0].id, matchType, ambiguous: false };
    if (matches.length > 1) {
      return {
        node: null,
        nodeId: null,
        matchType,
        ambiguous: true,
        candidates: matches.map((node) => ({ id: node.id, displayName: node.displayName || node.name || node.id })),
      };
    }
    return null;
  };

  if (candidate.agentInstallationId) {
    const resolved = finish(match((node) => node.agentIdentity?.agentInstallationId === candidate.agentInstallationId || node.agentInstallationId === candidate.agentInstallationId), "agentInstallationId");
    if (resolved) return resolved;
  }
  if (candidate.agentIdentityId) {
    const resolved = finish(match((node) => node.agentIdentity?.agentIdentityId === candidate.agentIdentityId || node.agentIdentityId === candidate.agentIdentityId), "agentIdentityId");
    if (resolved) return resolved;
  }
  if (candidate.deviceId) {
    const resolved = finish(match((node) => node.agentIdentity?.deviceId === candidate.deviceId), "deviceId");
    if (resolved) return resolved;
  }
  if (candidate.nodeId) {
    const resolved = finish(match((node) => node.id === candidate.nodeId), "explicitNodeId");
    if (resolved) return resolved;
  }
  if (candidate.agentUrl) {
    const resolved = finish(match((node) => normalizeUrl(node.baseUrl || node.agentUrl) === candidate.agentUrl), "normalizedUrl");
    if (resolved) return resolved;
  }
  return { node: null, nodeId: null, matchType: "none", ambiguous: false, candidates: [] };
}

function getSelectedNodeId() { return readNodeState().selectedNodeId; }
function getAllNodesSync() { const state = readNodeState(); return [getApplicationHostNode(), ...state.nodes]; }
function getNodeAgentConfigFromNode(node) {
  if (!localCredentialsUnlocked()) {
    authRecovery.requireLocalCredentialsUnlocked(
      `node-credential:${node.id}`,
      "Unlock AnxOS to access saved node credentials.",
    );
  }
  return {
    ...normalizeAgentSettings({
    backendMode: "agent",
    agentUrl: node.baseUrl || node.agentUrl,
    agentToken: getNodeToken(node.id, { preserveDecryptionError: true }),
    }),
    nodeId: node.id,
    agentNodeId: node.id,
    targetLabel: `node:${node.id}`,
  };
}
function getNodeAgentConfig(nodeId) { const node = getNode(nodeId); if (node.kind !== "agent") throw Object.assign(new Error("Selected node is not an Agent."), { code: "NODE_NOT_AGENT" }); return getNodeAgentConfigFromNode(node); }
function getExecutionTarget(nodeId) { const node = getNode(nodeId); return node.kind === "agent" ? { type: "agent", nodeId: node.id, deviceId: node.agentIdentity.deviceId, localAgent: node.localAgent === true, capabilities: buildNodeCapabilities(node), config: getNodeAgentConfigFromNode(node) } : { type: "application-host", nodeId: APPLICATION_HOST_NODE_ID, hostId: node.applicationHost.hostId, capabilities: buildNodeCapabilities(node) }; }

function getConfiguredAgentTokenForNode(node) {
  const effective = getEffectiveAgentSettings();
  const nodeUrl = normalizeUrl(node?.agentUrl || node?.baseUrl || "");
  const effectiveUrl = normalizeUrl(effective.agentUrl || "");
  const token = typeof effective.agentToken === "string" ? effective.agentToken.trim() : "";
  if (!nodeUrl || !effectiveUrl || nodeUrl !== effectiveUrl || !token) return null;
  return { source: "configured-agent-token", token, fingerprint: tokenFingerprint(token) };
}

async function getNodeCredentialStatus(nodeId) {
  const node = getNode(nodeId || getSelectedNodeId());
  if (node.kind !== "agent") throw Object.assign(new Error("Selected node is not an Agent."), { code: "NODE_NOT_AGENT" });
  const endpoint = normalizeUrl(node.agentUrl || node.baseUrl || "");
  const storedToken = getNodeToken(node.id, { preserveDecryptionError: true });
  const storedFingerprint = tokenFingerprint(storedToken);
  const configured = getConfiguredAgentTokenForNode(node);
  let health = null;
  let remoteFingerprint = null;
  let reachable = false;
  let healthError = null;
  try {
    health = await getHealth(normalizeAgentSettings({ backendMode: "agent", agentUrl: endpoint, agentToken: configured?.token || storedToken || "" }), {
      timeoutMs: 8000,
      targetLabel: `node-credential-status:${node.id}`,
      suppressConnectionRefusedLog: true,
      logThrottleMs: 60000,
    });
    reachable = true;
    remoteFingerprint = health?.tokenFingerprint || null;
  } catch (error) {
    healthError = { code: error?.code || null, message: error?.message || "Agent health check failed." };
  }
  const configuredMatchesRemote = Boolean(configured?.fingerprint && remoteFingerprint && configured.fingerprint === remoteFingerprint);
  const storedMatchesRemote = Boolean(storedFingerprint && remoteFingerprint && storedFingerprint === remoteFingerprint);
  const status = !storedFingerprint
    ? "missing"
    : !remoteFingerprint
      ? reachable ? "unknown" : "unreachable"
      : storedMatchesRemote ? "valid" : "mismatch";
  return {
    nodeId: node.id,
    nodeLabel: node.displayName || node.name || node.id,
    endpoint,
    credentialSource: "protected-node-credential",
    tokenConfigured: Boolean(storedFingerprint),
    storedCredentialFingerprint: storedFingerprint,
    runningAgentConfiguredFingerprint: configured?.fingerprint || null,
    liveHealthFingerprint: remoteFingerprint,
    configuredAgentCredentialAvailable: Boolean(configured?.fingerprint),
    configuredAgentMatchesLiveHealth: configuredMatchesRemote,
    storedCredentialMatchesLiveHealth: storedMatchesRemote,
    status,
    reachable,
    agentVersion: health?.identity?.agentVersion || health?.agentVersion || node.agentVersion || node.agentIdentity?.agentVersion || null,
    checkedAt: new Date().toISOString(),
    error: healthError,
  };
}

async function repairNodeCredential(payload = {}) {
  const node = getNode(payload.nodeId || getSelectedNodeId());
  if (node.kind !== "agent") throw Object.assign(new Error("Selected node is not an Agent."), { code: "NODE_NOT_AGENT" });
  const before = await getNodeCredentialStatus(node.id);
  if (before.status === "valid") {
    return { repaired: false, repairStatus: "already-valid", restartRequired: false, before, after: before, ...(await listNodes({ discoverLocalAgent: false, refreshIdentity: false })) };
  }
  const pairingCode = String(payload.pairingCode || payload.code || "").trim();
  if (pairingCode) {
    const paired = await pairNodeFromCode({ pairingCode, id: node.id, confirmUrlChange: payload.confirmUrlChange === true });
    const after = await getNodeCredentialStatus(paired.selectedNodeId || node.id);
    return { repaired: true, repairStatus: "re-paired", restartRequired: false, before, after, ...paired };
  }
  const configured = getConfiguredAgentTokenForNode(node);
  if (configured?.token && before.liveHealthFingerprint && configured.fingerprint === before.liveHealthFingerprint) {
    setNodeToken(node.id, configured.token);
    updateNodeHealthState(node.id, { state: "online", message: "Node credential repaired from the matching configured Agent token.", checkedAt: new Date().toISOString() });
    const after = await getNodeCredentialStatus(node.id);
    return { repaired: true, repairStatus: "credential-updated", restartRequired: false, before, after, ...(await listNodes({ discoverLocalAgent: false, refreshIdentity: false })) };
  }
  return { repaired: false, repairStatus: before.status === "missing" ? "re-pair-required" : "manual-repair-required", restartRequired: false, before, after: before, ...(await listNodes({ discoverLocalAgent: false, refreshIdentity: false })) };
}

function agentIdentityMatchesNode(node = null, identity = {}) {
  if (!node || !identity || typeof identity !== "object") return false;
  const existing = node.agentIdentity || {};
  const comparisons = [
    ["deviceId", existing.deviceId, identity.deviceId],
    ["agentInstallationId", existing.agentInstallationId || node.agentInstallationId, identity.agentInstallationId],
    ["agentIdentityId", existing.agentIdentityId || node.agentIdentityId, identity.agentIdentityId],
  ];
  return comparisons.some(([, left, right]) => Boolean(left && right && left === right));
}

async function saveNode(payload = {}) {
  const displayName = String(payload.displayName || payload.name || "").trim();
  const agentUrl = normalizeUrl(payload.agentUrl || payload.url);
  const state = readNodeState();
  const existingById = payload.id ? state.nodes.find((node) => node.id === payload.id) : null;
  const agentTokenInput = String(payload.agentToken || payload.token || "").trim();
  const agentToken = agentTokenInput || existingById?.agentToken || "";
  if (!displayName || displayName.length > 80) throw Object.assign(new Error("Enter a node name up to 80 characters."), { code: "INVALID_NODE_NAME" });
  if (!/^https?:\/\/[^ ]+$/i.test(agentUrl)) throw Object.assign(new Error("Enter a valid Agent URL."), { code: "INVALID_NODE_URL" });
  let healthResponse;
  let identity;
  try {
    healthResponse = await getHealth(normalizeAgentSettings({ backendMode: "agent", agentUrl, agentToken }));
    identity = healthResponse.identity;
  } catch (error) {
    const wrapped = Object.assign(new Error(`Could not read Agent identity: ${error.message}`), {
      code: error?.code || "AGENT_IDENTITY_UNAVAILABLE",
      status: error?.status || error?.statusCode || null,
      details: {
        operation: "node-registration-identity",
        causeCode: error?.code || null,
      },
    });
    Object.defineProperty(wrapped, "cause", { value: error, enumerable: false });
    throw wrapped;
  }
  if (!identity?.deviceId) throw Object.assign(new Error("Agent did not provide a stable device identity."), { code: "AGENT_IDENTITY_MISSING" });
  const existing = state.nodes.find((node) => node.agentIdentity.deviceId === identity.deviceId || node.id === payload.id);
  if (!existing && state.nodes.some((node) => normalizeUrl(node.baseUrl || node.agentUrl) === agentUrl)) {
    throw Object.assign(new Error("A node already uses this Agent URL."), { code: "DUPLICATE_NODE_URL" });
  }
  const nodeId = existing?.id || nodeIdForDevice(identity.deviceId);
  if (agentTokenInput) setNodeToken(nodeId, agentTokenInput);
  const node = normalizeAgentNode({
    ...existing,
    ...payload,
    id: nodeId,
    displayName,
    agentUrl,
    agentToken: agentToken || existing?.agentToken,
    agentIdentity: {
      ...identity,
      capabilities: normalizeAgentCapabilitiesMetadata(identity.capabilities || healthResponse.capabilities || null, { os: identity.platform === "win32" ? "windows" : identity.platform || null }),
    },
  });
  const nodes = mergeAgentNodes([...state.nodes.filter((entry) => entry.id !== node.id && entry.agentIdentity.deviceId !== identity.deviceId), node]);
  writeNodeState({ ...state, removedLocalAgents: clearLocalAgentRemovalMarkersForNode(state, node), nodes });
  return { node: publicNode(node), ...(await listNodes({ refreshIdentity: false })) };
}

async function postPairingComplete(agentUrl, payload = {}, options = {}) {
  const endpoint = `${normalizeUrl(agentUrl)}/api/v1/pairing/complete`;
  const controller = new AbortController();
  const timeoutMs = Math.max(100, Number(options.timeoutMs) || 15000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    const timedOut = error?.name === "AbortError" || controller.signal.aborted;
    throw Object.assign(new Error(timedOut
      ? "Agent pairing timed out. The result is uncertain; generate a new pairing code before trying again."
      : "The Agent pairing request could not be completed. Generate a new pairing code after verifying the Agent URL and connection."), {
      code: timedOut ? "PAIRING_TIMEOUT" : "PAIRING_UNREACHABLE",
      retryAvailable: false,
      details: {
        operation: "pairing-complete",
        causeCode: error?.cause?.code || error?.code || null,
        timeoutMs: timedOut ? timeoutMs : null,
      },
    });
  } finally {
    clearTimeout(timeout);
  }
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok) {
    const message = body?.error?.message || body?.message || `Agent pairing failed with HTTP ${response.status}.`;
    const rawCode = body?.error?.code || "PAIRING_FAILED";
    const code = rawCode === "PAIRING_REJECTED" && /no longer|expired|available/i.test(message) ? "PAIRING_EXPIRED" : rawCode;
    throw Object.assign(new Error(code === "PAIRING_EXPIRED" ? "Pairing session expired. Generate a new pairing code on the Agent, then try again." : message), {
      code,
      status: response.status,
      retryAvailable: code === "PAIRING_EXPIRED",
    });
  }
  return body || {};
}

async function pairNodeFromCode(payload = {}) {
  const pairing = parsePairingCode(payload.pairingCode || payload.code || "");
  const agentUrl = normalizeUrl(pairing.agentUrl);
  const state = readNodeState();
  const existingById = payload.nodeId || payload.id ? state.nodes.find((node) => node.id === (payload.nodeId || payload.id)) : null;
  const existingUrl = existingById ? normalizeUrl(existingById.baseUrl || existingById.agentUrl) : null;
  if (existingById && existingUrl !== agentUrl && payload.confirmUrlChange !== true) {
    throw Object.assign(new Error("This pairing code is for a different Agent address. Confirm the URL change before re-pairing this existing node."), {
      code: "NODE_REPAIR_URL_CONFIRMATION_REQUIRED",
      details: {
        nodeId: existingById.id,
        currentAgentUrl: existingUrl,
        pairingAgentUrl: agentUrl,
      },
    });
  }
  const permanentToken = generateAgentToken();
  const paired = await postPairingComplete(agentUrl, {
    pairingCode: pairing.pairingCode,
    permanentToken,
  });
  const health = await getHealth(normalizeAgentSettings({
    backendMode: "agent",
    agentUrl,
    agentToken: permanentToken,
  }), {
    timeoutMs: 8000,
    targetLabel: "node-pairing",
    suppressConnectionRefusedLog: true,
    logThrottleMs: 60000,
  });
  const identity = health.identity || paired.identity || {};
  if (!identity?.deviceId) throw Object.assign(new Error("Paired Agent did not provide a stable device identity."), { code: "AGENT_IDENTITY_MISSING" });
  const existing = existingById || state.nodes.find((node) => node.agentIdentity?.deviceId === identity.deviceId || normalizeUrl(node.baseUrl || node.agentUrl) === agentUrl);
  const displayName = String(payload.displayName || existing?.displayName || identity.hostname || "Paired Agent").trim().slice(0, 80) || "Paired Agent";
  const pairedNodeId = existing?.id || nodeIdForDevice(identity.deviceId);
  setNodeToken(pairedNodeId, permanentToken);
  const node = normalizeAgentNode({
    ...existing,
    id: pairedNodeId,
    displayName,
    agentUrl,
    agentToken: permanentToken,
    enabled: true,
    agentIdentity: {
      ...identity,
      agentInstallationId: identity.agentInstallationId || paired.agentInstallationId || null,
      agentIdentityId: identity.agentIdentityId || paired.agentIdentityId || null,
      apiVersion: identity.apiVersion || health.apiVersion || null,
      capabilities: normalizeAgentCapabilitiesMetadata(identity.capabilities || health.capabilities || null, { os: identity.platform === "win32" ? "windows" : identity.platform || null }),
    },
    lastConnectionState: "online",
    connection: {
      connected: true,
      status: "online",
      message: "Agent paired successfully.",
      lastSeen: new Date().toISOString(),
      capabilities: normalizeAgentCapabilitiesMetadata(identity.capabilities || health.capabilities || null, { os: identity.platform === "win32" ? "windows" : identity.platform || null }),
    },
  });
  const nodes = mergeAgentNodes([...state.nodes.filter((entry) => entry.id !== node.id && entry.agentIdentity?.deviceId !== identity.deviceId), node]);
  writeNodeState({ ...state, removedLocalAgents: clearLocalAgentRemovalMarkersForNode(state, node), selectedNodeId: node.id, nodes });
  return {
    paired: true,
    repairedExistingNode: Boolean(existingById),
    node: publicNode(node),
    selectedNodeId: node.id,
    agentUrl,
    identity,
    tokenConfigured: true,
    tokenFingerprint: paired.tokenFingerprint || null,
    ...(await listNodes({ discoverLocalAgent: false, refreshIdentity: false })),
  };
}

async function testNodeConnectionPayload(payload = {}) {
  const displayName = String(payload.displayName || payload.name || "Agent Node").trim().slice(0, 80) || "Agent Node";
  const agentUrl = normalizeUrl(payload.agentUrl || payload.url);
  const state = readNodeState();
  const existing = payload.id ? state.nodes.find((node) => node.id === payload.id) : null;
  const agentTokenInput = String(payload.agentToken || payload.token || "").trim();
  const agentToken = agentTokenInput || existing?.agentToken || "";
  if (!/^https?:\/\/[^ ]+$/i.test(agentUrl)) throw Object.assign(new Error("Enter a valid Agent URL."), { code: "INVALID_NODE_URL" });
  const startedAt = Date.now();
  const health = await getHealth(normalizeAgentSettings({ backendMode: "agent", agentUrl, agentToken }), {
    timeoutMs: 8000,
    targetLabel: payload.id ? `node-test:${payload.id}` : "node-test:new",
    suppressConnectionRefusedLog: true,
    logThrottleMs: 60000,
  });
  const identity = health.identity || {};
  const compatibility = getAgentCompatibilityReport(health);
  const compatible = compatibility.compatible;
  return {
    connected: compatible,
    status: compatible ? "online" : "agent_incompatible",
    state: compatible ? "online" : "agent_incompatible",
    message: compatible ? `Agent connection verified. ${formatAgentCompatibilityMessage(compatibility)}` : formatAgentCompatibilityMessage(compatibility),
    latencyMs: Date.now() - startedAt,
    agentVersion: identity.agentVersion || health.agentVersion || null,
    apiVersion: identity.apiVersion || health.apiVersion || null,
    protocolVersion: identity.protocolVersion ?? health.protocolVersion ?? null,
    compatibility,
    platform: identity.platform || health.platform || null,
    capabilities: normalizeAgentCapabilitiesMetadata(health.capabilities || identity.capabilities || null, { os: identity.platform === "win32" ? "windows" : identity.platform || null }),
    node: publicNode(normalizeAgentNode({
      ...existing,
      displayName,
      agentUrl,
      agentToken,
      agentIdentity: {
        ...identity,
        capabilities: normalizeAgentCapabilitiesMetadata(identity.capabilities || health.capabilities || null, { os: identity.platform === "win32" ? "windows" : identity.platform || null }),
      },
      connection: {
        ...(existing?.connection || {}),
        connected: compatible,
        status: compatible ? "online" : "agent_incompatible",
        capabilities: normalizeAgentCapabilitiesMetadata(identity.capabilities || health.capabilities || null, { os: identity.platform === "win32" ? "windows" : identity.platform || null }),
      },
    })),
  };
}

function deleteNode(nodeId) {
  if (!nodeId || nodeId === APPLICATION_HOST_NODE_ID || nodeId === "default") {
    throw Object.assign(new Error("The application host cannot be deleted."), { code: "APPLICATION_HOST_READ_ONLY" });
  }
  const state = readNodeState();
  const node = state.nodes.find((entry) => entry.id === nodeId);
  const removalMarker = node ? getLocalAgentRemovalMarker(node) : null;
  const nodes = state.nodes.filter((entry) => entry.id !== nodeId);
  deleteNodeToken(nodeId);
  const removedLocalAgents = removalMarker
    ? normalizeRemovedLocalAgents([...(state.removedLocalAgents || []), removalMarker])
    : normalizeRemovedLocalAgents(state.removedLocalAgents);
  writeNodeState({
    ...state,
    removedLocalAgents,
    selectedNodeId: state.selectedNodeId === nodeId ? APPLICATION_HOST_NODE_ID : state.selectedNodeId,
    nodes,
  });
  return { id: nodeId, deleted: true };
}
async function selectNode(nodeId) { getNode(nodeId); const state = readNodeState(); writeNodeState({ ...state, selectedNodeId: nodeId || APPLICATION_HOST_NODE_ID }); return listNodes({ discoverLocalAgent: false, refreshIdentity: false }); }
async function testNode(nodeId) { return checkNodeHealth(nodeId || getSelectedNodeId(), { timeoutMs: 8000 }); }

module.exports = { APPLICATION_HOST_NODE_ID, HEALTH_STATES, NODE_SCHEMA_VERSION, checkAllNodeHealth, checkNodeHealth, deleteNode, getAllNodesSync, getExecutionTarget, getNode, getNodeAgentConfig, getNodeCredentialStatus, getNodeCredentialsPath, getNodesPath, getSelectedNodeId, listNodes, mergeAgentNodes, migrateState, pairNodeFromCode, recordAuthenticatedNodeHealth, repairNodeCredential, resolveNodeForAgentIdentity, saveNode, selectNode, testNode, testNodeConnectionPayload, updateNodeHealthState, _test: { buildNodeCapabilities, formatAgentCompatibilityMessage, getAgentCompatibilityReport, getNodeReportedCapabilities, normalizeAgentApiMajor, normalizeAgentCapabilitiesMetadata, normalizeAgentProtocolVersion, postPairingComplete } };
