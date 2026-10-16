const { ipcMain } = require("electron");
const {
  associateEndpoint,
  createEndpoint,
  deleteEndpoint,
  discoverEndpoints,
  getEndpoint,
  getEndpointSummary,
  listEndpoints,
  setEndpointEnabled,
  updateEndpoint,
} = require("../services/endpointService");
const connectivityDiagnosticsService = require("../services/connectivityDiagnosticsService");
const providerIntegrationService = require("../services/providerIntegrationService");
const endpointStore = require("../services/endpointStore");
const { audit, requireLocalOwnerAuthenticated, requirePermission } = require("../services/securityService");
const { createIpcError, normalizeIpcError } = require("../shared/ipcError");
const { requireNodeContext } = require("./nodeContext");

// V2-K: Endpoint Manager / connectivity / provider surfaces. The endpoint
// registry is desktop-local CRUD at the endpoints:write tier; the diagnostics
// and provider channels are node-scoped and mirror publicAccessIpc's
// expected-error envelope so a missing/unreachable Agent degrades to
// { ok: false, error } instead of being logged as an unexpected failure.
// Every channel is local-owner gated like its node-scoped neighbours, and the
// guard chain runs before any transport work.
const EXPECTED_NETWORK_ERROR_CODES = new Set([
  "NODE_REQUIRED",
  "AGENT_UNAVAILABLE",
  "NODE_DISABLED",
  "NODE_NOT_FOUND",
  "TIMEOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "ETIMEDOUT",
  "ENDPOINT_NOT_FOUND",
  "ENDPOINT_AGENT_UNAVAILABLE",
  // Provider sync can legitimately skip a tunnel whose canonical endpoint
  // input fails validation; a surfaced ENDPOINT_VALIDATION_FAILED degrades to
  // the expected-error envelope like the other endpoint-family refusals.
  "ENDPOINT_VALIDATION_FAILED",
]);
const expectedNetworkLogState = new Map();
const EXPECTED_NETWORK_LOG_INTERVAL_MS = 60 * 1000;

function getNetworkErrorCode(error = {}) {
  return String(error.code || error.payload?.error?.code || error.details?.code || "").toUpperCase();
}

function isExpectedNetworkError(error = {}) {
  const code = getNetworkErrorCode(error);
  return error.status === 401
    || error.statusCode === 401
    || EXPECTED_NETWORK_ERROR_CODES.has(code);
}

function sanitizeNetworkError(error = {}) {
  const contract = normalizeIpcError(error, {
    code: getNetworkErrorCode(error) || "NETWORK_REQUEST_FAILED",
    fallbackMessage: "Network request failed.",
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

function noteExpectedNetworkError(channel, error = {}) {
  const sanitized = sanitizeNetworkError(error);
  const key = `${channel}:${sanitized.error?.code || sanitized.code}:${sanitized.details?.nodeId || "unknown"}`;
  const previous = expectedNetworkLogState.get(key) || { count: 0, suppressed: 0, lastLogAt: 0 };
  const now = Date.now();
  previous.count += 1;
  if (!previous.lastLogAt || now - previous.lastLogAt >= EXPECTED_NETWORK_LOG_INTERVAL_MS) {
    console.warn("[Network IPC] Expected Agent request failed.", {
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
  expectedNetworkLogState.set(key, previous);
}

// Expected refusals/unavailability resolve as { ok: false, error }; everything
// else is an unexpected failure and throws the typed IPC error.
function invokeExpectedNetworkOperation(channel, operation) {
  return Promise.resolve()
    .then(operation)
    .catch((error) => {
      if (isExpectedNetworkError(error)) {
        noteExpectedNetworkError(channel, error);
        return {
          ok: false,
          error: sanitizeNetworkError(error),
        };
      }
      throw createIpcError(error, { code: "NETWORK_REQUEST_FAILED", fallbackMessage: "Network request failed." });
    });
}

function invokeNetworkOperation(operation) {
  return Promise.resolve()
    .then(operation)
    .catch((error) => {
      throw createIpcError(error, {
        code: "NETWORK_REQUEST_FAILED",
        fallbackMessage: "Network request failed.",
        suggestion: "Review the connectivity diagnostics, correct the reported problem, then retry.",
      });
    });
}

function currentEndpointRecord(endpointId) {
  if (typeof endpointId !== "string" || !endpointId.trim()) return null;
  try {
    return getEndpoint(endpointId.trim());
  } catch {
    return null;
  }
}

function buildEndpointFilter(payload = {}) {
  const filter = {};
  if (typeof payload.nodeId === "string" && payload.nodeId.trim()) filter.nodeId = payload.nodeId.trim();
  if (typeof payload.serviceId === "string" && payload.serviceId.trim()) filter.serviceId = payload.serviceId.trim();
  if (typeof payload.type === "string" && payload.type.trim()) filter.type = payload.type.trim();
  if (typeof payload.enabled === "boolean") filter.enabled = payload.enabled;
  return filter;
}

// The registry read composes the endpoint list, the summary counts, the
// persisted provider-sync records and the one-shot legacy migration report so
// the Network surface can render degraded state truthfully in one round trip.
// Stored records never carry health (diagnostics-managed fields are stripped
// on write), so the cached evaluation is projected onto the returned records
// and onto the summary's health counts: a completed endpoint test stays
// visible after the list refresh that follows it.
function projectHealth(endpoints, nodeId) {
  if (typeof connectivityDiagnosticsService.projectEndpointHealth !== "function") return endpoints;
  return connectivityDiagnosticsService.projectEndpointHealth(endpoints, { fallbackNodeId: nodeId || null });
}

async function listEndpointsForIpc(payload = {}) {
  const filter = buildEndpointFilter(payload);
  const listed = await listEndpoints(filter);
  const endpoints = projectHealth(Array.isArray(listed) ? listed : Array.isArray(listed?.endpoints) ? listed.endpoints : [], filter.nodeId);
  let summary = null;
  try {
    summary = await getEndpointSummary({ nodeId: filter.nodeId || null });
    if (summary && typeof summary === "object") {
      const scoped = await listEndpoints(filter.nodeId ? { nodeId: filter.nodeId } : {});
      const byHealth = {};
      for (const endpoint of projectHealth(Array.isArray(scoped) ? scoped : [], filter.nodeId)) {
        const health = typeof endpoint?.health?.status === "string" && endpoint.health.status ? endpoint.health.status : "unknown";
        byHealth[health] = (byHealth[health] || 0) + 1;
      }
      summary = { ...summary, byHealth };
    }
  } catch {
    summary = null;
  }
  let providerSyncs = null;
  let migration = null;
  try {
    const store = endpointStore.getEndpointStore();
    if (store && typeof store.getProviderSyncs === "function") providerSyncs = store.getProviderSyncs();
    const report = store && typeof store.loadReport === "object" ? store.loadReport : null;
    if (report) migration = report.legacyMigration || null;
  } catch {
    providerSyncs = null;
    migration = null;
  }
  return {
    endpoints,
    summary: summary && typeof summary === "object" ? summary : null,
    migration,
    providerSyncs,
    degraded: summary?.degraded === true,
  };
}

function registerNetworkIpc() {
  ipcMain.handle("endpoints:list", async (_, payload = {}) => invokeNetworkOperation(() => {
    requireLocalOwnerAuthenticated("endpoints:list", "Unlock AnxOS to view endpoints.");
    requirePermission("endpoints:read", payload.nodeId);
    audit({ action: "endpoints.list", target: payload.nodeId || "endpoints" });
    return listEndpointsForIpc(payload);
  }));
  ipcMain.handle("endpoints:create", async (_, payload = {}) => invokeNetworkOperation(async () => {
    requireLocalOwnerAuthenticated("endpoints:create", "Unlock AnxOS to create endpoints.");
    requirePermission("endpoints:write", payload.nodeId);
    const created = await createEndpoint(payload);
    audit({ action: "endpoint.create", target: created?.id || payload.id || payload.endpointId || null });
    return created;
  }));
  ipcMain.handle("endpoints:update", async (_, payload = {}) => invokeNetworkOperation(() => {
    requireLocalOwnerAuthenticated("endpoints:update", "Unlock AnxOS to update endpoints.");
    const id = payload?.id ?? payload?.endpointId;
    requirePermission("endpoints:write", id);
    audit({ action: "endpoint.update", target: id || null });
    return updateEndpoint(id, payload);
  }));
  ipcMain.handle("endpoints:delete", async (_, payload = {}) => invokeNetworkOperation(() => {
    requireLocalOwnerAuthenticated("endpoints:delete", "Unlock AnxOS to delete endpoints.");
    const id = payload?.id ?? payload?.endpointId;
    requirePermission("endpoints:write", id);
    audit({ action: "endpoint.delete", target: id || null });
    return deleteEndpoint(id);
  }));
  ipcMain.handle("endpoints:setEnabled", async (_, payload = {}) => invokeNetworkOperation(() => {
    requireLocalOwnerAuthenticated("endpoints:setEnabled", "Unlock AnxOS to change endpoint state.");
    const id = payload?.id ?? payload?.endpointId;
    requirePermission("endpoints:write", id);
    audit({ action: "endpoint.toggle", target: id || null });
    return setEndpointEnabled(id, payload?.enabled);
  }));
  ipcMain.handle("endpoints:associate", async (_, payload = {}) => invokeNetworkOperation(() => {
    requireLocalOwnerAuthenticated("endpoints:associate", "Unlock AnxOS to associate endpoints.");
    requirePermission("endpoints:write", payload.endpointId);
    audit({ action: "endpoint.associate", target: payload.endpointId || null });
    return associateEndpoint(payload);
  }));
  // Discovery reads the node's live listener inventory and reconciles it into
  // endpoint records, so it is a node-scoped write tier; an unreachable Agent
  // is an expected outcome (ENDPOINT_AGENT_UNAVAILABLE) and degrades to the
  // { ok: false, error } envelope instead of an unexpected failure.
  ipcMain.handle("endpoints:discover", async (_, payload = {}) => invokeExpectedNetworkOperation("endpoints:discover", () => {
    requireLocalOwnerAuthenticated("endpoints:discover", "Unlock AnxOS to discover endpoints.");
    requirePermission("endpoints:write", payload.nodeId);
    requireNodeContext(payload, "endpoint discovery");
    audit({ action: "endpoint.discover", target: payload.nodeId || null });
    return discoverEndpoints({ nodeId: payload.nodeId, serviceId: payload.serviceId });
  }));
  // Diagnostics run against a selected node: the endpoint must exist, the
  // Agent must answer, and every structured refusal is an expected outcome.
  ipcMain.handle("endpoints:test", async (_, payload = {}) => invokeExpectedNetworkOperation("endpoints:test", () => {
    requireLocalOwnerAuthenticated("endpoints:test", "Unlock AnxOS to test endpoints.");
    requirePermission("diagnostics:run", payload.endpointId || payload.nodeId);
    requireNodeContext(payload, "endpoint diagnostics");
    audit({ action: "endpoint.test", target: payload.endpointId || null });
    return connectivityDiagnosticsService.runDiagnostics({
      nodeId: payload.nodeId,
      endpointId: payload.endpointId,
      refresh: true,
    });
  }));
  // The cached read is cache-only (it never probes) and, like its sibling
  // connectivity:runDiagnostics, resolves the expected-error envelope for the
  // documented refusal codes (NODE_REQUIRED, AGENT_UNAVAILABLE, ...) instead of
  // throwing. Guard and permission refusals still throw unchanged.
  ipcMain.handle("connectivity:getDiagnostics", async (_, payload = {}) => invokeExpectedNetworkOperation("connectivity:getDiagnostics", () => {
    requireLocalOwnerAuthenticated("connectivity:getDiagnostics", "Unlock AnxOS to view connectivity diagnostics.");
    requirePermission("endpoints:read", payload.nodeId);
    requireNodeContext(payload, "connectivity diagnostics");
    audit({ action: "connectivity.getDiagnostics", target: payload.endpointId || payload.nodeId || null });
    // For an endpoint read, the current record (null once the endpoint is
    // gone) lets the cache refuse a result for a target the endpoint no longer
    // points at or for an endpoint deleted while its run was in flight.
    // Service-level reads name no endpoint and stay unchanged.
    const target = { nodeId: payload.nodeId, serviceId: payload.serviceId, endpointId: payload.endpointId };
    if (typeof payload.endpointId === "string" && payload.endpointId.trim()) {
      target.endpoint = currentEndpointRecord(payload.endpointId);
    }
    return connectivityDiagnosticsService.getCachedDiagnostics(target);
  }));
  ipcMain.handle("connectivity:runDiagnostics", async (_, payload = {}) => invokeExpectedNetworkOperation("connectivity:runDiagnostics", () => {
    requireLocalOwnerAuthenticated("connectivity:runDiagnostics", "Unlock AnxOS to run connectivity diagnostics.");
    requirePermission("diagnostics:run", payload.nodeId);
    requireNodeContext(payload, "connectivity diagnostics");
    audit({ action: "connectivity.runDiagnostics", target: payload.endpointId || payload.nodeId || null });
    return connectivityDiagnosticsService.runDiagnostics({
      nodeId: payload.nodeId,
      serviceId: payload.serviceId,
      endpointId: payload.endpointId,
      refresh: true,
    });
  }));
  ipcMain.handle("providers:getStatus", async (_, payload = {}) => invokeNetworkOperation(() => {
    requireLocalOwnerAuthenticated("providers:getStatus", "Unlock AnxOS to view provider status.");
    requirePermission("providers:read", payload.nodeId);
    requireNodeContext(payload, "provider status");
    audit({ action: "providers.getStatus", target: payload.nodeId });
    // providerIntegrationService degrades an unreachable Agent to an unknown
    // provider state, so this read answers a snapshot rather than throwing.
    return providerIntegrationService.getProviderSnapshot({ nodeId: payload.nodeId });
  }));
  ipcMain.handle("providers:sync", async (_, payload = {}) => invokeExpectedNetworkOperation("providers:sync", () => {
    requireLocalOwnerAuthenticated("providers:sync", "Unlock AnxOS to sync providers.");
    requirePermission("providers:sync", payload.nodeId);
    requireNodeContext(payload, "provider sync");
    audit({ action: "provider.sync", target: payload.nodeId });
    return providerIntegrationService.syncTunnels({ nodeId: payload.nodeId });
  }));
}

module.exports = {
  registerNetworkIpc,
  _test: {
    EXPECTED_NETWORK_ERROR_CODES,
    expectedNetworkLogState,
    buildEndpointFilter,
    invokeExpectedNetworkOperation,
    invokeNetworkOperation,
    isExpectedNetworkError,
    sanitizeNetworkError,
    listEndpointsForIpc,
  },
};
