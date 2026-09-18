const { ipcMain } = require("electron");
const {
  applyWindowsFirewallRule,
  buildWindowsFirewallRulePreview,
  createPublicAccessService,
  createWindowsFirewallRule,
  controlPlayitService,
  deletePublicAccessService,
  deleteWindowsFirewallRule,
  getPlayitLogsForNode,
  getPlayitServiceStatusForNode,
  getPublicAccessSnapshot,
  listPlayitTunnelsForNode,
  listPublicAccessServices,
  listWindowsFirewallRules,
} = require("../services/publicAccessProviderService");
const { audit, requirePermission } = require("../services/securityService");
const { createIpcError, normalizeIpcError } = require("../shared/ipcError");
const { requireNodeContext } = require("./nodeContext");

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
}

module.exports = {
  registerPublicAccessIpc,
  _test: {
    expectedPublicAccessLogState,
    invokePublicAccessRead,
    isExpectedPublicAccessError,
    sanitizePublicAccessError,
  },
};
