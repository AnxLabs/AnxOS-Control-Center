const { ipcMain } = require("electron");
const {
  applyWindowsFirewallRule,
  buildWindowsFirewallRulePreview,
  cancelPlayitLinkForNode,
  createPublicAccessService,
  createWindowsFirewallRule,
  controlPlayitService,
  deletePublicAccessService,
  deleteWindowsFirewallRule,
  getPlayitAccountForNode,
  getPlayitLinkForNode,
  getPlayitLogsForNode,
  getPlayitManageLinkForNode,
  getPlayitServiceStatusForNode,
  getPublicAccessSnapshot,
  listPlayitTunnelsForNode,
  listPublicAccessServices,
  listWindowsFirewallRules,
  startPlayitLinkForNode,
} = require("../services/publicAccessProviderService");
const agentClient = require("../services/agentClient");
const { openExternalUrl } = require("../services/externalUrlService");
const { PLAYIT_DOWNLOAD_URL, isAllowedPlayitUrl } = require("../services/playitAccountService");
const { audit, requirePermission } = require("../services/securityService");
const { createIpcError, normalizeIpcError } = require("../shared/ipcError");
const { requireNodeContext } = require("./nodeContext");

// V2-H reverse-proxy / certificate lifecycle. The Agent owns the state; the
// desktop only reads it and records route definitions. `forNode` is the same
// node-scoped Agent client serviceRouter uses, so no second transport is
// introduced here.
const REVERSE_PROXY_SNAPSHOT_PATH = "/api/v1/public-access/reverse-proxy";
const REVERSE_PROXY_APPLY_PATH = "/api/v1/public-access/reverse-proxy/routes";

const EXPECTED_PUBLIC_ACCESS_ERROR_CODES = new Set([
  "UNAUTHORIZED",
  "AUTHENTICATION_FAILED",
  "AGENT_UNAVAILABLE",
  "AGENT_INCOMPATIBLE",
  "NODE_DISABLED",
  "NODE_NOT_FOUND",
  "NODE_REQUIRED",
  "AGENT_PLAYIT_CONTROLS_UNSUPPORTED",
  "AGENT_TIMEOUT",
  "TIMEOUT",
  "NETWORK_ERROR",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "PLAYIT_NOT_INSTALLED",
  "PLAYIT_SERVICE_NOT_FOUND",
  "PLAYIT_START_FAILED",
  "PLAYIT_STOP_FAILED",
  "PLAYIT_RESTART_FAILED",
  "PLAYIT_STATUS_UNKNOWN",
  "PLAYIT_LOGS_UNAVAILABLE",
  "PLAYIT_TUNNELS_UNAVAILABLE",
  "PLAYIT_NOT_RUNNING",
  "PLAYIT_CONFIG_NOT_FOUND",
  "PLAYIT_TUNNEL_PARSE_FAILED",
  "PLAYIT_ALREADY_LINKED",
  "PLAYIT_NOT_LINKED",
  "PLAYIT_LINK_STATE_UNKNOWN",
  "PLAYIT_LINK_NOT_FOUND",
  "PLAYIT_LOGIN_LINK_UNAVAILABLE",
  "NODE_UNSUPPORTED",
  "AGENT_UNAUTHORIZED",
  // V2-H firewall lifecycle: structured refusals/outcomes that should not be
  // logged as unexpected failures.
  "FIREWALL_ELEVATED_CONFIRM_REQUIRED",
  "FIREWALL_PREVIEW_FAILED",
  "FIREWALL_PLATFORM_UNSUPPORTED",
  "FIREWALL_RULE_FAILED",
  "FIREWALL_RULE_LIST_FAILED",
  "FIREWALL_RULE_DELETE_FAILED",
  "FIREWALL_RULE_UNMANAGED",
  "FIREWALL_RULE_NAME_REQUIRED",
  // V2-H reverse-proxy lifecycle: structured refusals that should not be
  // logged as unexpected failures.
  "NODE_NOT_AGENT",
  "REVERSE_PROXY_ROUTE_CONFLICT",
  "REVERSE_PROXY_ROUTE_LIMIT_EXCEEDED",
  "REVERSE_PROXY_ROUTE_INVALID",
  "REVERSE_PROXY_SCHEMA_UNSUPPORTED",
  "REVERSE_PROXY_REGISTRY_CORRUPT",
  "REVERSE_PROXY_CERTIFICATE_REGISTRY_CORRUPT",
  "REVERSE_PROXY_HOSTNAME_REQUIRED",
  "REVERSE_PROXY_HOSTNAME_INVALID",
  "REVERSE_PROXY_UPSTREAM_REQUIRED",
  "REVERSE_PROXY_UPSTREAM_INVALID",
  "REVERSE_PROXY_UPSTREAM_PORT_INVALID",
  "REVERSE_PROXY_UPSTREAM_PORT_NOT_ALLOWED",
  "REVERSE_PROXY_UPSTREAM_PROTOCOL_INVALID",
  "REVERSE_PROXY_TLS_MODE_INVALID",
  "REVERSE_PROXY_PATH_INVALID",
]);
const expectedPublicAccessLogState = new Map();
const EXPECTED_PUBLIC_ACCESS_LOG_INTERVAL_MS = 60 * 1000;

function getPublicAccessErrorCode(error = {}) {
  return String(error.code || error.payload?.error?.code || error.details?.code || "").toUpperCase();
}

function isExpectedPublicAccessError(error = {}) {
  const code = getPublicAccessErrorCode(error);
  return error.status === 401
    || error.statusCode === 401
    || EXPECTED_PUBLIC_ACCESS_ERROR_CODES.has(code);
}

function sanitizePublicAccessError(error = {}) {
  const contract = normalizeIpcError(error, {
    code: getPublicAccessErrorCode(error) || "PUBLIC_ACCESS_REQUEST_FAILED",
    fallbackMessage: "Public Access request failed.",
    provider: error?.provider || error?.details?.provider || null,
  });
  return {
    ...contract,
    message: contract.friendlyMessage,
    details: {
      code: contract.code,
      technicalDetails: contract.technicalDetails,
      suggestion: contract.suggestion,
      retryable: contract.retryable,
      status: contract.status,
      provider: contract.provider,
      diagnostics: contract.diagnostics,
      nodeId: contract.technicalDetails?.nodeId || null,
      targetLabel: contract.technicalDetails?.targetLabel || null,
    },
  };
}

function noteExpectedPublicAccessError(channel, error = {}) {
  const sanitized = sanitizePublicAccessError(error);
  const key = `${channel}:${sanitized.error?.code || sanitized.code}:${sanitized.details?.nodeId || "unknown"}`;
  const previous = expectedPublicAccessLogState.get(key) || { count: 0, suppressed: 0, lastLogAt: 0 };
  const now = Date.now();
  previous.count += 1;
  if (!previous.lastLogAt || now - previous.lastLogAt >= EXPECTED_PUBLIC_ACCESS_LOG_INTERVAL_MS) {
    console.warn("[Public Access IPC] Expected Agent request failed.", {
      channel,
      code: sanitized.code,
      status: sanitized.status?.code || null,
      nodeId: sanitized.details.nodeId,
      targetLabel: sanitized.details.targetLabel,
      suppressedCount: previous.suppressed,
    });
    previous.lastLogAt = now;
    previous.suppressed = 0;
  } else {
    previous.suppressed += 1;
  }
  expectedPublicAccessLogState.set(key, previous);
}

function invokePublicAccessRead(channel, operation) {
  return Promise.resolve()
    .then(operation)
    .catch((error) => {
      if (isExpectedPublicAccessError(error)) {
        noteExpectedPublicAccessError(channel, error);
        return {
          ok: false,
          error: sanitizePublicAccessError(error),
        };
      }
      throw createIpcError(error, { code: "PUBLIC_ACCESS_REQUEST_FAILED", fallbackMessage: "Public Access request failed." });
    });
}

function wrapPublicAccessOperation(operation) {
  return Promise.resolve()
    .then(operation)
    .catch((error) => ({ ok: false, error: sanitizePublicAccessError(error) }));
}

// V2-H reverse-proxy read/apply. The Agent is the only authority for route and
// certificate state; these helpers exist so the smoke can drive the exact
// request the handler makes.
function getReverseProxySnapshotForNode(payload = {}) {
  return agentClient.forNode(payload.nodeId).get(REVERSE_PROXY_SNAPSHOT_PATH);
}

function applyReverseProxyRouteForNode(payload = {}) {
  const { nodeId, ...route } = payload;
  return agentClient.forNode(nodeId).post(REVERSE_PROXY_APPLY_PATH, route);
}

// playit claim and sign-in links work like short-lived credentials: the main
// process opens them in the browser and the renderer only learns whether a
// link exists. Each linking attempt's link is opened automatically once.
const openedPlayitLinks = new Set();

function playitLinkView(session = {}, opened = false) {
  return {
    id: session.id || null,
    state: session.state || null,
    startedAt: session.startedAt || null,
    endedAt: session.endedAt || null,
    message: session.message || null,
    hasLink: Boolean(session.linkUrl || session.hasLink),
    opened,
  };
}

async function openPlayitUrl(linkUrl, source) {
  if (!isAllowedPlayitUrl(linkUrl)) {
    throw Object.assign(new Error("playit did not return a playit.gg link."), { code: "PLAYIT_LOGIN_LINK_UNAVAILABLE" });
  }
  await openExternalUrl(linkUrl, { source });
  return true;
}

async function openPlayitLinkOnce(nodeId, session) {
  const key = `${nodeId || "local"}:${session?.id || ""}`;
  if (!session?.linkUrl || openedPlayitLinks.has(key)) return false;
  await openPlayitUrl(session.linkUrl, "playit-account-link");
  openedPlayitLinks.add(key);
  return true;
}

async function startPlayitLink(payload) {
  const session = await startPlayitLinkForNode(payload);
  const opened = await openPlayitLinkOnce(payload.nodeId, session);
  return playitLinkView(session, opened);
}

async function pollPlayitLink(payload) {
  const session = await getPlayitLinkForNode({ ...payload, withLink: true });
  const opened = session?.state === "awaiting-approval" ? await openPlayitLinkOnce(payload.nodeId, session) : false;
  return playitLinkView(session, opened);
}

async function reopenPlayitLink(payload) {
  const session = await getPlayitLinkForNode({ ...payload, withLink: true });
  if (session?.state !== "awaiting-approval" || !session.linkUrl) {
    throw Object.assign(new Error("There is no playit approval link waiting right now."), { code: "PLAYIT_LINK_NOT_FOUND" });
  }
  await openPlayitUrl(session.linkUrl, "playit-account-link");
  return playitLinkView(session, true);
}

async function openPlayitManage(payload) {
  const { linkUrl } = await getPlayitManageLinkForNode(payload);
  await openPlayitUrl(linkUrl, "playit-account-manage");
  return { opened: true };
}

function registerPublicAccessIpc() {
  ipcMain.handle("publicAccess:getSnapshot", async (_, payload = {}) => invokePublicAccessRead("publicAccess:getSnapshot", () => { requirePermission("public-access:read", payload.nodeId); return getPublicAccessSnapshot(requireNodeContext(payload, "Public Access snapshot")); }));
  ipcMain.handle("publicAccess:listServices", async (_, payload = {}) => invokePublicAccessRead("publicAccess:listServices", () => { requirePermission("public-access:read", payload.nodeId); return listPublicAccessServices(requireNodeContext(payload, "Public Access services")); }));
  ipcMain.handle("publicAccess:getPlayitStatus", async (_, payload = {}) => invokePublicAccessRead("publicAccess:getPlayitStatus", () => { requirePermission("public-access:read", payload.nodeId); return getPlayitServiceStatusForNode(requireNodeContext(payload, "Playit status")); }));
  ipcMain.handle("publicAccess:getPlayitLogs", async (_, payload = {}) => invokePublicAccessRead("publicAccess:getPlayitLogs", () => { requirePermission("public-access:read", payload.nodeId); return getPlayitLogsForNode(requireNodeContext(payload, "Playit logs")); }));
  ipcMain.handle("publicAccess:listPlayitTunnels", async (_, payload = {}) => invokePublicAccessRead("publicAccess:listPlayitTunnels", () => { requirePermission("public-access:read", payload.nodeId); return listPlayitTunnelsForNode(requireNodeContext(payload, "Playit tunnels")); }));
  ipcMain.handle("publicAccess:createService", async (_, payload = {}) => wrapPublicAccessOperation(() => {
    requireNodeContext(payload, "Public Access service creation");
    requirePermission("instance:write", "public-access");
    audit({ action: "publicAccess.createService", target: payload.providerId || "public-access" });
    return createPublicAccessService(payload);
  }));
  ipcMain.handle("publicAccess:deleteService", async (_, payload = {}) => wrapPublicAccessOperation(() => {
    requireNodeContext(payload, "Public Access service deletion");
    requirePermission("instance:write", "public-access");
    audit({ action: "publicAccess.deleteService", target: payload.serviceId || payload.id || "public-access" });
    return deletePublicAccessService(payload);
  }));
  ipcMain.handle("publicAccess:createFirewallRule", async (_, payload = {}) => wrapPublicAccessOperation(() => {
    requireNodeContext(payload, "Public Access firewall rule");
    requirePermission("instance:write", "public-access-firewall");
    audit({ action: "publicAccess.createFirewallRule", target: `${payload.protocol || "tcp"}:${payload.localPort || payload.port || ""}` });
    return createWindowsFirewallRule(payload);
  }));
  // V2-H firewall lifecycle: preview is a read (no mutation); apply/list/delete
  // follow the existing node-context-then-permission ordering so the locked
  // sweep still denies before any transport work runs.
  ipcMain.handle("publicAccess:previewFirewallRule", async (_, payload = {}) => invokePublicAccessRead("publicAccess:previewFirewallRule", () => {
    requirePermission("public-access:read", payload.nodeId);
    requireNodeContext(payload, "Public Access firewall rule preview");
    return buildWindowsFirewallRulePreview(payload);
  }));
  ipcMain.handle("publicAccess:listFirewallRules", async (_, payload = {}) => invokePublicAccessRead("publicAccess:listFirewallRules", () => {
    requirePermission("public-access:read", payload.nodeId);
    return listWindowsFirewallRules(requireNodeContext(payload, "Public Access firewall rules"));
  }));
  ipcMain.handle("publicAccess:applyFirewallRule", async (_, payload = {}) => wrapPublicAccessOperation(() => {
    requireNodeContext(payload, "Public Access firewall rule apply");
    requirePermission("instance:write", "public-access-firewall");
    audit({ action: "publicAccess.applyFirewallRule", target: `${payload.protocol || "tcp"}:${payload.localPort || payload.port || ""}` });
    return applyWindowsFirewallRule(payload);
  }));
  ipcMain.handle("publicAccess:deleteFirewallRule", async (_, payload = {}) => wrapPublicAccessOperation(() => {
    requireNodeContext(payload, "Public Access firewall rule deletion");
    requirePermission("instance:write", "public-access-firewall");
    audit({ action: "publicAccess.deleteFirewallRule", target: payload.name || payload.id || "public-access-firewall" });
    return deleteWindowsFirewallRule(payload);
  }));
  ipcMain.handle("publicAccess:controlPlayit", async (_, payload = {}) => wrapPublicAccessOperation(() => {
    requireNodeContext(payload, "Playit service control");
    requirePermission("instance:write", "public-access-playit");
    audit({ action: "publicAccess.controlPlayit", target: payload.action || "playit" });
    return controlPlayitService(payload);
  }));
  ipcMain.handle("publicAccess:getPlayitAccount", async (_, payload = {}) => invokePublicAccessRead("publicAccess:getPlayitAccount", () => { requirePermission("public-access:read", payload.nodeId); return getPlayitAccountForNode(requireNodeContext(payload, "playit account")); }));
  ipcMain.handle("publicAccess:openPlayitDownload", async (_, payload = {}) => invokePublicAccessRead("publicAccess:openPlayitDownload", async () => {
    requirePermission("public-access:read", payload.nodeId);
    await openPlayitUrl(PLAYIT_DOWNLOAD_URL, "playit-download");
    return { opened: true };
  }));
  ipcMain.handle("publicAccess:startPlayitLink", async (_, payload = {}) => wrapPublicAccessOperation(() => {
    requireNodeContext(payload, "playit account linking");
    requirePermission("instance:write", "public-access-playit");
    audit({ action: "publicAccess.startPlayitLink", target: "playit" });
    return startPlayitLink(payload);
  }));
  // Polling reads the pending link so it can be opened, so it needs the same
  // permission as starting; it is not audited per poll.
  ipcMain.handle("publicAccess:getPlayitLink", async (_, payload = {}) => wrapPublicAccessOperation(() => {
    requireNodeContext(payload, "playit account linking");
    requirePermission("instance:write", "public-access-playit");
    return pollPlayitLink(payload);
  }));
  ipcMain.handle("publicAccess:openPlayitLink", async (_, payload = {}) => wrapPublicAccessOperation(() => {
    requireNodeContext(payload, "playit account linking");
    requirePermission("instance:write", "public-access-playit");
    audit({ action: "publicAccess.openPlayitLink", target: "playit" });
    return reopenPlayitLink(payload);
  }));
  ipcMain.handle("publicAccess:cancelPlayitLink", async (_, payload = {}) => wrapPublicAccessOperation(async () => {
    requireNodeContext(payload, "playit account linking");
    requirePermission("instance:write", "public-access-playit");
    audit({ action: "publicAccess.cancelPlayitLink", target: "playit" });
    return playitLinkView(await cancelPlayitLinkForNode(payload));
  }));
  ipcMain.handle("publicAccess:openPlayitManage", async (_, payload = {}) => wrapPublicAccessOperation(() => {
    requireNodeContext(payload, "playit account");
    requirePermission("instance:write", "public-access-playit");
    audit({ action: "publicAccess.openPlayitManage", target: "playit" });
    return openPlayitManage(payload);
  }));
  // V2-H reverse-proxy / certificate state: the read is a node-scoped Agent
  // read (no mutation); apply records a route definition and is audited. Both
  // keep the family guard order (permission first for reads, node context then
  // permission for writes) so the locked sweep denies before any transport
  // work starts.
  ipcMain.handle("publicAccess:getReverseProxy", async (_, payload = {}) => invokePublicAccessRead("publicAccess:getReverseProxy", () => {
    requirePermission("public-access:read", payload.nodeId);
    return getReverseProxySnapshotForNode(requireNodeContext(payload, "Reverse-proxy state"));
  }));
  ipcMain.handle("publicAccess:applyReverseProxyRoute", async (_, payload = {}) => wrapPublicAccessOperation(() => {
    requireNodeContext(payload, "Reverse-proxy route apply");
    requirePermission("instance:write", "public-access-reverse-proxy");
    audit({ action: "publicAccess.applyReverseProxyRoute", target: payload.hostname || "reverse-proxy" });
    return applyReverseProxyRouteForNode(payload);
  }));
}

module.exports = {
  registerPublicAccessIpc,
  _test: {
    playitLinkView,
    expectedPublicAccessLogState,
    invokePublicAccessRead,
    isExpectedPublicAccessError,
    sanitizePublicAccessError,
    getReverseProxySnapshotForNode,
    applyReverseProxyRouteForNode,
    REVERSE_PROXY_SNAPSHOT_PATH,
    REVERSE_PROXY_APPLY_PATH,
  },
};
