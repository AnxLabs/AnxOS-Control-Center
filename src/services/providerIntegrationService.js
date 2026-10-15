"use strict";

// Provider integration service: provider detection snapshot -> canonical
// provider state + endpoint records.
//
// Provider-specific mapping lives in the adapters (src/shared/providers/*).
// This service owns only the orchestration and the policy that comes with it:
//
// - getProviderSnapshot() / getProviderStateForNode() never throw on provider
//   failure; a thrown or timed-out snapshot degrades to state "unknown" with
//   PROVIDER_SNAPSHOT_UNAVAILABLE. The one exception is NODE_REQUIRED when no
//   nodeId was supplied.
// - syncTunnels() reconciles canonical tunnels into endpoint records through
//   the endpoint gateway. It is idempotent: records are classified
//   created/updated/unchanged from the pre-upsert state, and stale provider
//   endpoints are reported only - never deleted or disabled. A tunnel whose
//   canonical input fails endpoint validation is reported in `skipped`
//   ({ tunnelId, code, message }) and the remaining tunnels still sync: one bad
//   tunnel never aborts the whole sync.
// - Provider credentials are neither read nor returned: adapters strip
//   sensitive keys, and this service passes only canonical shapes, fixed
//   diagnostic codes and short notes.
//
// Defaults are resolved lazily inside the functions (./serviceRouter and
// ./endpointService) so loading this module can never form a require cycle
// with the diagnostics or endpoint services, and tests can inject fakes
// through deps.

const { normalizeProviderState, scrubDiagnosticText } = require("../shared/providerAdapterContract");
const { buildEndpointId, endpointKey } = require("../shared/endpointModel");

const PLAYIT_PROVIDER_ID = "playit";
const MANUAL_PROVIDER_ID = "manual";
const DEFAULT_SNAPSHOT_TIMEOUT_MS = 8000;
const DEFAULT_CACHE_TTL_MS = 30000;
const MAX_NOTES = 50;
const TUNNEL_LOCAL_PROTOCOLS = Object.freeze(["tcp", "udp"]);

const SYNC_ERROR_CODES = Object.freeze({
  PLAYIT_NOT_INSTALLED: "PLAYIT_NOT_INSTALLED",
  PROVIDER_SNAPSHOT_INVALID: "PROVIDER_SNAPSHOT_INVALID",
  AGENT_UNAVAILABLE: "AGENT_UNAVAILABLE",
});

let defaultRegistry = null;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Built once, lazily: the shared adapters are pure mappers with no dependency
// on this layer, but keeping the require here means importing this module does
// no work beyond the dependency-free contract and endpoint model.
function getDefaultRegistry() {
  if (!defaultRegistry) {
    const { createPlayitProviderAdapter } = require("../shared/providers/playitProviderAdapter");
    const { createManualProviderAdapter } = require("../shared/providers/manualProviderAdapter");
    defaultRegistry = {
      [PLAYIT_PROVIDER_ID]: createPlayitProviderAdapter(),
      [MANUAL_PROVIDER_ID]: createManualProviderAdapter(),
    };
  }
  return defaultRegistry;
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return Promise.resolve(promise);
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    void resolve;
    timer = setTimeout(() => {
      const error = new Error("The provider snapshot request timed out.");
      error.code = "PROVIDER_SNAPSHOT_TIMEOUT";
      reject(error);
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function requireNodeId(nodeId) {
  const value = typeof nodeId === "string" ? nodeId.trim() : "";
  if (!value) {
    const error = new Error("A node id is required for provider integration.");
    error.code = "NODE_REQUIRED";
    error.statusCode = 400;
    throw error;
  }
  return value;
}

// "Unchanged" means the stored record already matches the input on address,
// protocol and provider tunnel id. Key equality alone is not enough: the same
// endpoint key can legitimately be re-pointed at a different tunnel.
function isIdenticalEndpointRecord(endpoint, input) {
  if (endpoint.host !== input.host) return false;
  if (endpoint.port !== input.port) return false;
  if (endpoint.protocol !== input.protocol) return false;
  const endpointTunnelId = isPlainObject(endpoint.metadata) ? (endpoint.metadata.tunnelId ?? null) : null;
  const inputTunnelId = isPlainObject(input.metadata) ? (input.metadata.tunnelId ?? null) : null;
  return endpointTunnelId === inputTunnelId;
}

function asEndpointList(value) {
  return Array.isArray(value) ? value.filter((entry) => isPlainObject(entry)) : [];
}

function resolveEndpointId(stored, matched, input) {
  if (stored && typeof stored.id === "string" && stored.id) return stored.id;
  if (matched && typeof matched.id === "string" && matched.id) return matched.id;
  return buildEndpointId(input);
}

function pushNote(result, message) {
  if (result.notes.length >= MAX_NOTES) return;
  result.notes.push(String(message));
}

function createProviderIntegrationService({ deps = {}, now } = {}) {
  const overrides = isPlainObject(deps) ? deps : {};
  const nowFn = typeof now === "function" ? now : () => now;
  const snapshotTimeoutMs = Number.isFinite(overrides.snapshotTimeoutMs)
    ? Math.max(1, overrides.snapshotTimeoutMs)
    : DEFAULT_SNAPSHOT_TIMEOUT_MS;
  const cacheTtlMs = Number.isFinite(overrides.cacheTtlMs)
    ? Math.max(0, overrides.cacheTtlMs)
    : DEFAULT_CACHE_TTL_MS;
  const snapshotCache = new Map();
  // Last provider state learned by an explicit read or sync, per node. Kept
  // regardless of the snapshot TTL: background readers (notifications,
  // telemetry) use it so they never make the Agent probe the provider.
  const lastKnown = new Map();

  function currentDate() {
    let value = null;
    try {
      value = nowFn();
    } catch {
      value = null;
    }
    const date = value instanceof Date
      ? value
      : new Date(value === undefined || value === null ? Date.now() : value);
    return Number.isFinite(date.getTime()) ? date : new Date();
  }

  function nowIso() {
    return currentDate().toISOString();
  }

  function nowMs() {
    return currentDate().getTime();
  }

  function getRegistry() {
    if (!isPlainObject(overrides.registry)) return getDefaultRegistry();
    return { ...getDefaultRegistry(), ...overrides.registry };
  }

  function loadPlayitSnapshotFn() {
    if (typeof overrides.getPlayitSnapshot === "function") return overrides.getPlayitSnapshot;
    const serviceRouter = require("./serviceRouter");
    const snapshotFn = serviceRouter && serviceRouter.getPlayitSnapshot;
    if (typeof snapshotFn !== "function") {
      const error = new Error("The Playit snapshot provider is not available.");
      error.code = SYNC_ERROR_CODES.AGENT_UNAVAILABLE;
      throw error;
    }
    return snapshotFn;
  }

  function loadEndpointGateway() {
    if (isPlainObject(overrides.endpointGateway)) return overrides.endpointGateway;
    return require("./endpointService");
  }

  // Bounded fetch: a synchronous throw, a rejected promise or a timeout all
  // become { ok: false } so callers can degrade instead of propagating.
  async function fetchPlayitSnapshot(nodeId) {
    let snapshotPromise;
    try {
      const snapshotFn = loadPlayitSnapshotFn();
      snapshotPromise = Promise.resolve().then(() => snapshotFn({ nodeId }));
    } catch (error) {
      return { ok: false, error };
    }
    try {
      const snapshot = await withTimeout(snapshotPromise, snapshotTimeoutMs);
      return { ok: true, snapshot };
    } catch (error) {
      return { ok: false, error };
    }
  }

  function unavailablePlayitState() {
    const adapter = getRegistry()[PLAYIT_PROVIDER_ID];
    const normalize = typeof adapter.normalizeState === "function" ? adapter.normalizeState : normalizeProviderState;
    return normalize({
      providerId: PLAYIT_PROVIDER_ID,
      displayName: adapter.displayName || null,
      state: "unknown",
      availability: "unknown",
      diagnostics: [{
        code: "PROVIDER_SNAPSHOT_UNAVAILABLE",
        message: "The Playit snapshot could not be read. Check the selected node and the Playit integration.",
      }],
    });
  }

  function rememberPlayitState(nodeId, playitState) {
    const manualState = getRegistry()[MANUAL_PROVIDER_ID].status({});
    lastKnown.set(nodeId, { providers: [playitState, manualState], checkedAt: nowIso(), atMs: nowMs() });
    return playitState;
  }

  async function buildPlayitProviderState(nodeId) {
    const fetched = await fetchPlayitSnapshot(nodeId);
    if (!fetched.ok) return rememberPlayitState(nodeId, unavailablePlayitState());
    const adapter = getRegistry()[PLAYIT_PROVIDER_ID];
    try {
      return rememberPlayitState(nodeId, adapter.status(fetched.snapshot));
    } catch {
      return rememberPlayitState(nodeId, unavailablePlayitState());
    }
  }

  async function readProviderSyncs(nodeId) {
    try {
      const gateway = loadEndpointGateway();
      if (!gateway || typeof gateway.getProviderSyncs !== "function") return null;
      const all = await gateway.getProviderSyncs();
      if (!isPlainObject(all)) return null;
      return all[nodeId] || null;
    } catch {
      return null;
    }
  }

  async function getProviderSnapshot({ nodeId, refresh = false } = {}) {
    const resolvedNodeId = requireNodeId(nodeId);
    let providers = null;
    let checkedAt = null;
    let fromCache = false;

    if (!refresh && cacheTtlMs > 0) {
      const cached = snapshotCache.get(resolvedNodeId);
      if (cached && nowMs() - cached.atMs < cacheTtlMs) {
        providers = cached.providers;
        checkedAt = cached.checkedAt;
        fromCache = true;
      }
    }

    if (!fromCache) {
      const playitState = await buildPlayitProviderState(resolvedNodeId);
      const manualState = getRegistry()[MANUAL_PROVIDER_ID].status({});
      providers = [playitState, manualState];
      checkedAt = nowIso();
      if (cacheTtlMs > 0) snapshotCache.set(resolvedNodeId, { atMs: nowMs(), providers, checkedAt });
    }

    return {
      nodeId: resolvedNodeId,
      checkedAt,
      providers,
      syncs: await readProviderSyncs(resolvedNodeId),
      cache: { cached: fromCache },
    };
  }

  // Cache-only read for background consumers: returns the last state an
  // explicit refresh or sync recorded and never contacts the Agent, so it can
  // never launch the provider binary there. Nothing known yet -> no providers.
  async function getCachedProviderSnapshot({ nodeId } = {}) {
    const resolvedNodeId = requireNodeId(nodeId);
    const entry = lastKnown.get(resolvedNodeId) || null;
    return {
      nodeId: resolvedNodeId,
      checkedAt: entry ? entry.checkedAt : null,
      providers: entry ? entry.providers : [],
      syncs: await readProviderSyncs(resolvedNodeId),
      cache: { cached: Boolean(entry), source: "last-known", ageMs: entry ? Math.max(0, nowMs() - entry.atMs) : null },
    };
  }

  async function getProviderStateForNode({ nodeId, providerId } = {}) {
    const resolvedNodeId = requireNodeId(nodeId);
    const id = typeof providerId === "string" ? providerId.trim() : "";
    if (id === PLAYIT_PROVIDER_ID) return buildPlayitProviderState(resolvedNodeId);
    if (id === MANUAL_PROVIDER_ID) return getRegistry()[MANUAL_PROVIDER_ID].status({});
    return normalizeProviderState({
      providerId: id || null,
      state: "unsupported",
      availability: "unknown",
      diagnostics: [{
        code: "PROVIDER_UNSUPPORTED",
        message: id ? `Provider "${id}" is not supported.` : "No provider id was supplied.",
      }],
    });
  }

  async function failSync(gateway, nodeId, result, state, errorCode, note) {
    result.state = state;
    result.errorCode = errorCode;
    pushNote(result, note);
    await gateway.recordProviderSync(nodeId, {
      providerId: PLAYIT_PROVIDER_ID,
      state,
      tunnelCount: 0,
      errorCode,
      lastSyncAt: result.lastSyncAt,
    });
    return result;
  }

  async function syncTunnels({ nodeId } = {}) {
    const resolvedNodeId = requireNodeId(nodeId);
    const gateway = loadEndpointGateway();
    const lastSyncAt = nowIso();
    const result = {
      ok: false,
      providerId: PLAYIT_PROVIDER_ID,
      state: "unknown",
      connected: null,
      tunnels: [],
      endpointsCreated: [],
      endpointsUpdated: [],
      unchanged: [],
      // Tunnels whose canonical endpoint input could not be written:
      // [{ tunnelId, code, message }]. One skipped tunnel never aborts the sync.
      skipped: [],
      associated: [],
      ambiguous: [],
      unassociated: [],
      staleProviderEndpoints: [],
      lastSyncAt,
      errorCode: null,
      notes: [],
    };

    const fetched = await fetchPlayitSnapshot(resolvedNodeId);
    if (!fetched.ok) {
      rememberPlayitState(resolvedNodeId, unavailablePlayitState());
      return failSync(
        gateway,
        resolvedNodeId,
        result,
        "unknown",
        SYNC_ERROR_CODES.AGENT_UNAVAILABLE,
        "The Playit snapshot could not be read; no endpoints were changed.",
      );
    }
    if (!isPlainObject(fetched.snapshot)) {
      return failSync(
        gateway,
        resolvedNodeId,
        result,
        "unknown",
        SYNC_ERROR_CODES.PROVIDER_SNAPSHOT_INVALID,
        "The Playit snapshot was not a structured object; no endpoints were changed.",
      );
    }

    const adapter = getRegistry()[PLAYIT_PROVIDER_ID];
    const providerState = rememberPlayitState(resolvedNodeId, adapter.status(fetched.snapshot));
    const tunnels = adapter.listTunnels(fetched.snapshot);
    result.state = providerState.state;
    result.connected = providerState.connected;

    if (providerState.state === "not-installed") {
      return failSync(
        gateway,
        resolvedNodeId,
        result,
        "not-installed",
        SYNC_ERROR_CODES.PLAYIT_NOT_INSTALLED,
        "Playit is not installed on this node; no endpoints were changed.",
      );
    }

    result.tunnels = tunnels;
    const existingEndpoints = asEndpointList(await gateway.listEndpoints({ nodeId: resolvedNodeId }));
    const currentTunnelIds = new Set(
      tunnels.map((tunnel) => tunnel.id).filter((id) => typeof id === "string" && id !== ""),
    );
    const pending = [];

    for (const tunnel of tunnels) {
      const label = tunnel.id || tunnel.name || "unnamed tunnel";
      if (tunnel.localPort === null || tunnel.localPort === undefined) {
        pushNote(result, `Skipped tunnel ${label}: no local port to associate.`);
        continue;
      }
      if (!TUNNEL_LOCAL_PROTOCOLS.includes(tunnel.protocol)) {
        pushNote(result, `Skipped tunnel ${label}: protocol ${tunnel.protocol || "unknown"} is not tcp or udp.`);
        continue;
      }
      const candidates = existingEndpoints.filter((endpoint) =>
        endpoint.source !== "provider"
        && Boolean(endpoint.serviceId)
        && endpoint.port === tunnel.localPort
        && endpoint.protocol === tunnel.protocol,
      );
      const serviceIds = [...new Set(candidates.map((endpoint) => endpoint.serviceId))].sort();
      const serviceId = serviceIds.length === 1 ? serviceIds[0] : null;
      pending.push({
        tunnel,
        serviceIds,
        input: adapter.endpointFromTunnel(tunnel, { computerId: resolvedNodeId, serviceId }),
      });
    }

    for (const entry of pending) {
      const key = endpointKey(entry.input);
      const matches = existingEndpoints.filter((endpoint) => endpointKey(endpoint) === key);
      const matched = matches.length > 0 ? matches[0] : null;
      if (matches.length > 1) {
        pushNote(result, `Multiple stored endpoints match tunnel ${entry.tunnel.id || "unnamed"}; the first record was reused.`);
      }
      let stored = null;
      try {
        stored = await gateway.upsertProviderEndpoint({ input: entry.input, nodeId: resolvedNodeId });
      } catch (error) {
        // A single invalid tunnel must not abort the sync: report it and keep
        // reconciling the remaining tunnels.
        const code = typeof error?.code === "string" && error.code ? error.code : "ENDPOINT_SYNC_FAILED";
        result.skipped.push({
          tunnelId: entry.tunnel.id || null,
          code,
          // Validation messages can echo tunnel input; scrub like diagnostics.
          message: (typeof error?.message === "string" && scrubDiagnosticText(error.message))
            || "The tunnel endpoint could not be written.",
        });
        pushNote(result, `Skipped tunnel ${entry.tunnel.id || "unnamed"}: ${code}.`);
        continue;
      }
      const identical = matched ? isIdenticalEndpointRecord(matched, entry.input) : false;
      const endpointId = resolveEndpointId(stored, matched, entry.input);

      if (identical) result.unchanged.push(endpointId);
      else if (matched) result.endpointsUpdated.push(endpointId);
      else result.endpointsCreated.push(endpointId);

      if (entry.serviceIds.length > 1) {
        result.ambiguous.push({ tunnelId: entry.tunnel.id || null, services: entry.serviceIds });
      } else if (entry.serviceIds.length === 1) {
        result.associated.push({ tunnelId: entry.tunnel.id || null, endpointId, serviceId: entry.serviceIds[0] });
      } else {
        result.unassociated.push(endpointId);
      }
    }

    const stale = [];
    for (const endpoint of existingEndpoints) {
      if (endpoint.source !== "provider") continue;
      if (endpoint.providerId !== PLAYIT_PROVIDER_ID) continue;
      if (endpoint.computerId !== resolvedNodeId) continue;
      const tunnelId = isPlainObject(endpoint.metadata) ? endpoint.metadata.tunnelId : null;
      if (tunnelId !== null && tunnelId !== undefined && currentTunnelIds.has(tunnelId)) continue;
      if (typeof endpoint.id === "string" && endpoint.id) stale.push(endpoint.id);
    }
    if (stale.length > 0) {
      result.staleProviderEndpoints = [...new Set(stale)];
      pushNote(
        result,
        `${result.staleProviderEndpoints.length} provider endpoint(s) no longer match a tunnel; reported only, left unchanged.`,
      );
    }

    result.ok = true;
    result.errorCode = null;
    await gateway.recordProviderSync(resolvedNodeId, {
      providerId: PLAYIT_PROVIDER_ID,
      state: providerState.state,
      tunnelCount: tunnels.length,
      errorCode: null,
      lastSyncAt,
    });
    return result;
  }

  return {
    getProviderSnapshot,
    getCachedProviderSnapshot,
    getProviderStateForNode,
    syncTunnels,
  };
}

const providerIntegrationService = createProviderIntegrationService();

module.exports = {
  createProviderIntegrationService,
  providerIntegrationService,
  getProviderSnapshot: (options) => providerIntegrationService.getProviderSnapshot(options),
  getCachedProviderSnapshot: (options) => providerIntegrationService.getCachedProviderSnapshot(options),
  getProviderStateForNode: (options) => providerIntegrationService.getProviderStateForNode(options),
  syncTunnels: (options) => providerIntegrationService.syncTunnels(options),
};
