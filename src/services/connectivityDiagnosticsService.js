"use strict";

// Bounded connectivity diagnostics pipeline.
//
// One run walks six ordered checkpoints (service process, local socket, host
// network, agent, tunnel provider, public endpoint) and produces the canonical
// diagnostics result from src/shared/connectivityDiagnostics.js, plus the
// node/edge graph from src/shared/connectivityGraph.js.
//
// Boundaries:
//   - Read-only: this service never starts, stops, repairs, or reconfigures
//     anything. It only reads cached/recorded state and probes a TCP socket.
//   - Bounded: every dependency call and every probe runs under a timeout and
//     every stage is wrapped in try/catch. A thrown or hanging dependency
//     becomes a stage in state "unknown" with sanitized evidence. runDiagnostics
//     never rejects for dependency failures.
//   - The one caller error: passing an endpointId that does not exist throws a
//     typed ENOTFOUND error before any stage runs (documented below).
//   - Defaults are lazy-required so the module loads in a plain Node process
//     (no electron) and tests can inject fakes for every dependency.

const net = require("node:net");

const diagnosticsModel = require("../shared/connectivityDiagnostics");
const healthModel = require("../shared/healthModel");
const { buildConnectivityGraph } = require("../shared/connectivityGraph");
const providerContract = require("../shared/providerAdapterContract");
const { endpointKey } = require("../shared/endpointModel");

const DEFAULT_CACHE_TTL_MS = 30000;
const DEFAULT_PROBE_TIMEOUT_MS = 2500;
// The public-endpoint probe is deliberately fixed at 2500 ms: it answers a
// question about the internet, not about the local probe budget, and keeping it
// constant lets callers distinguish a local-socket probe from a public probe.
const PUBLIC_PROBE_TIMEOUT_MS = 2500;
const AGENT_STALE_AFTER_MS = 120000;
const MAX_EVIDENCE_TEXT_LENGTH = 200;
const MAX_BOUND_ADDRESSES = 32;

const NAT_HAIRPIN_NOTE =
  "External reachability not confirmed from this vantage (NAT hairpin or firewall on the local network can cause this).";

const ENDPOINT_TYPES = Object.freeze(["lan", "private", "tailscale", "public", "custom"]);

const HINTS = Object.freeze({
  startService: Object.freeze([{ id: "start-service", label: "Start service", kind: "start-service" }]),
  openNetwork: Object.freeze([{ id: "open-network", label: "Open Network", kind: "open-network" }]),
  openProvider: Object.freeze([{ id: "open-provider", label: "Open provider", kind: "open-provider" }]),
  copyDetails: Object.freeze([{ id: "copy-details", label: "Copy details", kind: "copy-details" }]),
});

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalString(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function errorCodeOf(error) {
  const code = error && error.code;
  if (code == null) return "STAGE_FAILED";
  return String(code).slice(0, 60);
}

// Sanitizes error text before it can reach evidence or a detail line: collapse
// whitespace, bound the length, and never carry a raw object. Errors are still
// untrusted input, so nothing else from them is copied.
function sanitizeErrorText(error) {
  const raw = error && (error.message || String(error));
  const text = String(raw == null ? "Unknown error" : raw).replace(/\s+/g, " ").trim();
  return text ? text.slice(0, MAX_EVIDENCE_TEXT_LENGTH) : "Unknown error";
}

function errorEvidence(error) {
  return { error: errorCodeOf(error), errorMessage: sanitizeErrorText(error) };
}

function normalizeProtocol(value) {
  const text = normalizeOptionalString(value);
  return text ? text.toLowerCase() : null;
}

function normalizeEndpointList(value) {
  if (Array.isArray(value)) return value.filter(isObject);
  if (isObject(value) && Array.isArray(value.endpoints)) return value.endpoints.filter(isObject);
  return [];
}

function endpointHost(endpoint) {
  return normalizeOptionalString(endpoint && endpoint.host) || "";
}

function endpointPort(endpoint) {
  const value = endpoint && endpoint.port;
  if (value == null || value === "") return null;
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function endpointType(endpoint) {
  return String((endpoint && endpoint.type) || "").trim().toLowerCase();
}

function endpointProviderId(endpoint) {
  return normalizeOptionalString(endpoint && endpoint.providerId);
}

function sanitizeAddresses(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item == null ? "" : String(item)))
    .filter(Boolean)
    .slice(0, MAX_BOUND_ADDRESSES);
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} timed out after ${timeoutMs} ms.`), { code: "TIMEOUT" }));
    }, timeoutMs);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// TCP probe (default dependency implementation)
// ---------------------------------------------------------------------------

// Bounded single-purpose TCP connect probe. Always resolves, never throws:
//   { ok, result: "connected"|"refused"|"timeout"|"error", latencyMs, code? }
// The socket is destroyed on every terminal path, including the timeout.
function probeTcp(options = {}) {
  const startedAt = Date.now();
  const host = options.host == null ? "" : String(options.host).trim();
  const port = Number(options.port);
  const requestedTimeoutMs = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0 ? requestedTimeoutMs : DEFAULT_PROBE_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    let socket = null;
    let timer = null;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (socket) {
        try {
          socket.destroy();
        } catch {
          /* socket teardown is best-effort */
        }
      }
      resolve({ latencyMs: Math.max(0, Date.now() - startedAt), ...payload });
    };

    try {
      if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
        finish({ ok: false, result: "error", code: "EINVALIDTARGET" });
        return;
      }
      socket = net.connect({ host, port });
      timer = setTimeout(() => finish({ ok: false, result: "timeout", code: "ETIMEDOUT" }), timeoutMs);
      socket.once("connect", () => {
        finish({ ok: true, result: "connected", latencyMs: Math.max(0, Date.now() - startedAt) });
      });
      socket.once("error", (error) => {
        const code = errorCodeOf(error);
        finish({ ok: false, result: code === "ECONNREFUSED" ? "refused" : "error", code });
      });
      socket.once("close", () => finish({ ok: false, result: "error", code: "ECONNECTIONCLOSED" }));
    } catch (error) {
      finish({ ok: false, result: "error", code: errorCodeOf(error) });
    }
  });
}

// ---------------------------------------------------------------------------
// Default (production) dependencies — all lazy-required on first use.
// ---------------------------------------------------------------------------

async function defaultGetServiceContext({ nodeId, serviceId }) {
  let instance = null;
  let computer = null;
  if (serviceId) {
    try {
      const serviceRouter = require("./serviceRouter");
      const listed = await serviceRouter.listInstances({ nodeId });
      const instances = Array.isArray(listed) ? listed : Array.isArray(listed && listed.instances) ? listed.instances : [];
      instance = instances.find((entry) => String(entry && entry.id) === String(serviceId)) || null;
    } catch {
      instance = null;
    }
  }
  try {
    if (nodeId) {
      const nodeSvc = require("./nodeService");
      const node = nodeSvc.getNode(nodeId);
      if (node) {
        computer = {
          id: node.id || nodeId,
          name: node.displayName || node.name || node.hostname || node.id || nodeId,
        };
      }
    }
  } catch {
    computer = null;
  }
  return { instance, computer };
}

function defaultGetAgentState({ nodeId }) {
  try {
    const nodeSvc = require("./nodeService");
    const node = nodeSvc.getNode(nodeId);
    if (!node || node.kind === "application-host") {
      return { kind: "application-host", state: "online", lastContact: null, agentVersion: null, stale: false };
    }
    const state = String(node.lastConnectionState || (node.connection && node.connection.status) || "unknown");
    const lastContact = node.lastSuccessfulHealthCheck || (node.connection && node.connection.lastSeen) || null;
    const agentVersion =
      node.agentVersion || (node.connection && node.connection.agentVersion) || (node.agentIdentity && node.agentIdentity.agentVersion) || null;
    const lastContactMs = lastContact ? Date.parse(String(lastContact)) : NaN;
    const stale = !Number.isFinite(lastContactMs) || Date.now() - lastContactMs > AGENT_STALE_AFTER_MS;
    return { kind: "agent", state, lastContact, agentVersion, stale };
  } catch {
    return { kind: "agent", state: "unknown", lastContact: null, agentVersion: null, stale: true };
  }
}

function defaultGetEndpoints({ nodeId, serviceId }) {
  const endpointService = require("./endpointService");
  if (!endpointService || typeof endpointService.listEndpoints !== "function") return [];
  return Promise.resolve(endpointService.listEndpoints({ nodeId, serviceId })).then((listed) => normalizeEndpointList(listed));
}

function defaultGetProviderState({ nodeId, providerId }) {
  const providerIntegrationService = require("./providerIntegrationService");
  if (!providerIntegrationService || typeof providerIntegrationService.getProviderStateForNode !== "function") {
    return null;
  }
  return Promise.resolve(providerIntegrationService.getProviderStateForNode({ nodeId, providerId })).then((state) =>
    state == null ? null : state,
  );
}

// The desktop Agent client reads the inventory without a server-side port
// check today, so the port check is derived from the returned listener rows
// when the inventory does not already carry one.
function shapeInventoryWithPort(inventory, port, protocol) {
  const record = isObject(inventory) ? inventory : {};
  let checkPort = isObject(record.checkPort) ? record.checkPort : null;
  const portNumber = Number(port);
  if (!checkPort && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535) {
    const wantedProtocol = (normalizeProtocol(protocol) || "tcp").toLowerCase();
    const listeners = Array.isArray(record.listeners) ? record.listeners : [];
    const matches = listeners.filter(
      (row) => isObject(row) && Number(row.localPort) === portNumber && String(row.protocol || "").toLowerCase() === wantedProtocol,
    );
    checkPort = {
      port: portNumber,
      protocol: wantedProtocol,
      listening: matches.length > 0,
      boundAddresses: Array.from(new Set(matches.map((row) => String(row.localAddress || "")).filter(Boolean))).sort(),
      listenerSource: record.listenerSource || null,
    };
  }
  return {
    supported: record.supported === true ? true : record.supported === false ? false : null,
    listenerSource: record.listenerSource || null,
    listeners: Array.isArray(record.listeners) ? record.listeners : [],
    interfaces: Array.isArray(record.interfaces) ? record.interfaces : [],
    checkPort,
  };
}

function defaultGetNetworkInventory({ nodeId, port, protocol }) {
  const serviceRouter = require("./serviceRouter");
  return Promise.resolve(serviceRouter.getNetworkInventory({ nodeId })).then((inventory) =>
    shapeInventoryWithPort(inventory, port, protocol),
  );
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function createConnectivityDiagnosticsService(config = {}) {
  const source = isObject(config) ? config : {};
  const injectedDeps = isObject(source.deps) ? source.deps : {};
  const now = typeof source.now === "function" ? source.now : () => new Date().toISOString();
  const cacheTtlMs = Number.isFinite(Number(source.cacheTtlMs)) && Number(source.cacheTtlMs) >= 0
    ? Number(source.cacheTtlMs)
    : DEFAULT_CACHE_TTL_MS;
  const probeTimeoutMs = Number.isFinite(Number(source.probeTimeoutMs)) && Number(source.probeTimeoutMs) > 0
    ? Number(source.probeTimeoutMs)
    : DEFAULT_PROBE_TIMEOUT_MS;

  const deps = {
    getServiceContext: injectedDeps.getServiceContext || defaultGetServiceContext,
    getAgentState: injectedDeps.getAgentState || defaultGetAgentState,
    getEndpoints: injectedDeps.getEndpoints || defaultGetEndpoints,
    getProviderState: injectedDeps.getProviderState || defaultGetProviderState,
    getNetworkInventory: injectedDeps.getNetworkInventory || defaultGetNetworkInventory,
    probeTcp: injectedDeps.probeTcp || probeTcp,
  };

  const cache = new Map();
  const inFlight = new Map();
  // invalidateDiagnostics({ endpointId }) (endpoint edit/delete) advances the
  // epoch and records it as that endpoint's last change. A run notes the epoch
  // when it starts; if any endpoint it resolved (requested, selected for a
  // service-level run, or public) changed since, it tested a target that no
  // longer exists and its result is discarded instead of cached or returned.
  // Comparing against the start epoch also covers an edit made before the run
  // had selected that endpoint.
  let endpointEpoch = 0;
  const endpointChangedAt = new Map();

  function endpointChangedSince(endpointIds, epoch) {
    for (const id of endpointIds) {
      if ((endpointChangedAt.get(id) || 0) > epoch) return true;
    }
    return false;
  }

  function discardedResult({ nodeId, serviceId, endpointId }) {
    return {
      cached: false,
      stale: true,
      state: "unknown",
      reason: "NOT_EVALUATED",
      discarded: "ENDPOINT_CHANGED",
      target: { nodeId: nodeId || null, serviceId: serviceId || null, endpointId: endpointId || null },
    };
  }
  let lastRunAt = null;

  function nowMs() {
    try {
      const value = now();
      if (typeof value === "number" && Number.isFinite(value)) return value;
      const parsed = Date.parse(String(value));
      return Number.isFinite(parsed) ? parsed : Date.now();
    } catch {
      return Date.now();
    }
  }

  function resolveNowIso() {
    try {
      const value = now();
      if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
      }
      if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    } catch {
      /* fall through to the wall clock */
    }
    return new Date().toISOString();
  }

  function cacheKey(target) {
    const keyNodeId = normalizeOptionalString(target && target.nodeId) || "";
    const keyServiceId = normalizeOptionalString(target && target.serviceId) || "";
    const keyEndpointId = normalizeOptionalString(target && target.endpointId) || "";
    return `${keyNodeId}|${keyServiceId}|${keyEndpointId}`;
  }

  function readCache(key) {
    const entry = cache.get(key);
    if (!entry) return null;
    if (nowMs() - entry.storedAt > cacheTtlMs) {
      cache.delete(key);
      return null;
    }
    return entry;
  }

  function cachedResultView(entry) {
    return { ...entry.result, cached: true, cachedAt: entry.cachedAt };
  }

  function callDep(label, factory) {
    // Every dependency call is bounded: a hung dependency is evidence-quality
    // data (unknown), not a stuck diagnostics run.
    return withTimeout(Promise.resolve().then(factory), probeTimeoutMs, label);
  }

  function callProbe(request) {
    return withTimeout(Promise.resolve().then(() => deps.probeTcp(request)), request.timeoutMs, "probeTcp");
  }

  // -------------------------------------------------------------------------
  // Stage helpers
  // -------------------------------------------------------------------------

  function remediationForState(state) {
    return state === "unknown" ? [...HINTS.copyDetails] : [];
  }

  function buildStage(id, stage) {
    const state = stage && healthModel.CONNECTIVITY_STATES.includes(stage.state) ? stage.state : "unknown";
    const remediation = Array.isArray(stage && stage.remediation) && stage.remediation.length
      ? stage.remediation
      : remediationForState(state);
    return diagnosticsModel.createStage({
      id,
      state,
      detail: (stage && stage.detail) || "",
      evidence: (stage && stage.evidence) || {},
      remediation,
    });
  }

  // A stage builder that throws (dependency error, timeout, or an unexpected
  // shape) becomes an "unknown" stage with sanitized evidence. This is the
  // single guarantee that dependency failures never escape runDiagnostics.
  async function runStage(id, builder) {
    try {
      return buildStage(id, await builder());
    } catch (error) {
      try {
        return buildStage(id, {
          state: "unknown",
          detail: `Stage check failed: ${sanitizeErrorText(error)}`,
          evidence: errorEvidence(error),
        });
      } catch {
        return diagnosticsModel.createStage({ id, state: "unknown", detail: "Stage could not be evaluated.", evidence: {} });
      }
    }
  }

  function stageById(stages, id) {
    return stages.find((stage) => stage && stage.id === id) || null;
  }

  function pickPublicEndpoint(endpoints, resolvedEndpoint) {
    if (resolvedEndpoint && endpointType(resolvedEndpoint) === "public") return resolvedEndpoint;
    const publicEndpoints = endpoints.filter((endpoint) => endpointType(endpoint) === "public");
    return publicEndpoints.find((endpoint) => endpoint.enabled !== false) || publicEndpoints[0] || null;
  }

  // -------------------------------------------------------------------------
  // Stage builders
  // -------------------------------------------------------------------------

  async function buildServiceProcessStage(context) {
    if (!context.serviceId) {
      return { state: "not_configured", detail: "No service associated" };
    }
    if (context.contextError) throw context.contextError;
    const instance = context.instance;
    if (!instance) {
      return { state: "not_configured", detail: "No service associated" };
    }
    const instanceState = instance.state || instance.processState || "unknown";
    const state = healthModel.mapInstanceProcessState(instanceState);
    const processRunning = typeof instance.processRunning === "boolean"
      ? instance.processRunning
      : ["starting", "running", "stopping", "restarting"].includes(String(instanceState).trim().toLowerCase().replace(/[_\s]+/g, "-"));
    const stage = {
      state,
      detail: `Service process is ${String(instanceState)}.`,
      evidence: {
        instanceState: String(instanceState),
        processRunning,
        pid: instance.pid == null ? null : Number(instance.pid),
        uptimeSeconds: Number.isFinite(Number(instance.uptimeSeconds)) ? Number(instance.uptimeSeconds) : null,
        healthState: instance.healthState == null ? null : String(instance.healthState),
      },
    };
    if (state === "failed") stage.remediation = [...HINTS.startService];
    return stage;
  }

  async function buildLocalSocketStage(context) {
    if (context.endpointsError) throw context.endpointsError;
    const endpoint = context.endpoint;
    if (!endpoint) {
      return { state: "not_configured", detail: "No endpoint to probe." };
    }
    const port = endpointPort(endpoint);
    if (port == null) {
      return { state: "not_configured", detail: "No local port to probe." };
    }
    const protocol = normalizeProtocol(endpoint.protocol);
    if (protocol === "udp") {
      return { state: "unsupported", detail: "UDP reachability cannot be probed" };
    }
    const host = endpointHost(endpoint);
    const request = { host, port, timeoutMs: probeTimeoutMs };
    const probe = await callProbe(request);
    if (!isObject(probe)) {
      throw Object.assign(new Error("Probe returned no result."), { code: "PROBE_NO_RESULT" });
    }
    if (probe.ok === true && probe.result === "connected") {
      return {
        state: "healthy",
        detail: `TCP ${host}:${port} accepted a connection.`,
        evidence: { result: "connected", latencyMs: Number.isFinite(Number(probe.latencyMs)) ? Number(probe.latencyMs) : null },
      };
    }
    if (probe.result === "refused") {
      return {
        state: "failed",
        detail: `TCP ${host}:${port} refused the connection.`,
        evidence: { result: "refused" },
        remediation: [...HINTS.openNetwork],
      };
    }
    if (probe.result === "timeout") {
      return {
        state: "unknown",
        detail: `TCP ${host}:${port} did not answer the probe.`,
        evidence: { result: "timeout" },
      };
    }
    return {
      state: "failed",
      detail: `TCP ${host}:${port} probe failed.`,
      evidence: { result: probe.result == null ? "error" : String(probe.result), code: probe.code == null ? null : String(probe.code) },
      remediation: [...HINTS.openNetwork],
    };
  }

  async function buildHostNetworkStage(context) {
    if (context.endpointsError) throw context.endpointsError;
    const endpoint = context.endpoint;
    const port = endpointPort(endpoint);
    if (port == null) {
      return { state: "not_configured", detail: "No local port to check." };
    }
    const protocol = normalizeProtocol(endpoint.protocol) || "tcp";
    const inventory = await callDep("getNetworkInventory", () =>
      deps.getNetworkInventory({ nodeId: context.nodeId, port, protocol }),
    );
    if (!isObject(inventory)) {
      return { state: "unknown", detail: "Network inventory is unavailable.", evidence: { note: "Network inventory is unavailable." } };
    }
    if (inventory.supported === false) {
      return {
        state: "unsupported",
        detail: "Host network inventory is not supported on this computer.",
        evidence: { listenerSource: inventory.listenerSource == null ? null : String(inventory.listenerSource) },
      };
    }
    const checkPort = isObject(inventory.checkPort) ? inventory.checkPort : null;
    const listenerSource = (checkPort && checkPort.listenerSource) || inventory.listenerSource || null;
    if (!checkPort || typeof checkPort.listening !== "boolean") {
      return { state: "unknown", detail: "Host port check is unavailable.", evidence: { note: "Port check unavailable." } };
    }
    if (checkPort.listening === true) {
      return {
        state: "healthy",
        detail: `Port ${port}/${protocol} is bound on the host.`,
        evidence: { boundAddresses: sanitizeAddresses(checkPort.boundAddresses), listenerSource: listenerSource == null ? null : String(listenerSource) },
      };
    }
    return {
      state: "failed",
      detail: `Port ${port}/${protocol} is not listening on the host.`,
      evidence: { listenerSource: listenerSource == null ? null : String(listenerSource) },
    };
  }

  async function buildAgentStage(context) {
    const agentState = await callDep("getAgentState", () => deps.getAgentState({ nodeId: context.nodeId }));
    if (!isObject(agentState)) {
      return { state: "unknown", detail: "Agent state is unavailable.", evidence: { agentState: "unknown", note: "Agent state is unavailable." } };
    }
    if (agentState.kind === "application-host") {
      return { state: "not_configured", detail: "Local computer (no agent required)" };
    }
    const state = String(agentState.state || "unknown");
    const evidence = {
      agentState: state,
      lastContact: agentState.lastContact == null ? null : String(agentState.lastContact),
      agentVersion: agentState.agentVersion == null ? null : String(agentState.agentVersion),
    };
    if (agentState.stale === true) {
      return { state: "unknown", detail: "Agent health data is stale.", evidence: { ...evidence, stale: true, note: "Last Agent contact is older than 120 seconds." } };
    }
    if (state === "online") {
      return { state: "healthy", detail: "Agent is online.", evidence };
    }
    if (state === "degraded") {
      return { state: "degraded", detail: "Agent is degraded.", evidence };
    }
    if (state === "offline" || state === "authentication_failed" || state === "agent_incompatible") {
      return { state: "failed", detail: `Agent is ${state}.`, evidence };
    }
    return { state: "unknown", detail: "Agent state is unknown.", evidence: { ...evidence, note: "Agent state is unknown." } };
  }

  function readProviderStageState(rawProviderState) {
    if (!isObject(rawProviderState)) return null;
    const normalized = providerContract.normalizeProviderState(rawProviderState);
    let tunnelId = null;
    try {
      const rawTunnelId = rawProviderState.tunnelId != null ? rawProviderState.tunnelId : rawProviderState.tunnel_id;
      const candidate = rawTunnelId != null ? rawTunnelId : normalized.tunnels[0] ? normalized.tunnels[0].id : null;
      tunnelId = candidate == null ? null : String(candidate).slice(0, 120);
    } catch {
      tunnelId = null;
    }
    return {
      providerId: normalized.providerId,
      state: normalized.state,
      connected: normalized.connected,
      publicAddress: normalized.publicAddress,
      region: normalized.region,
      tunnelId,
    };
  }

  async function buildProviderStage(context) {
    if (context.endpointsError) throw context.endpointsError;
    // The provider path feeds the public endpoint, so when the resolved
    // endpoint carries no provider the public endpoint's provider is used.
    const providerEndpoint =
      (context.endpoint && endpointProviderId(context.endpoint) ? context.endpoint : null) ||
      (context.publicEndpoint && endpointProviderId(context.publicEndpoint) ? context.publicEndpoint : null);
    const providerId = providerEndpoint ? endpointProviderId(providerEndpoint) : null;
    if (!providerId) {
      return { state: "not_configured", detail: "No provider configured for this endpoint." };
    }
    const rawProviderState = await callDep("getProviderState", () =>
      deps.getProviderState({ nodeId: context.nodeId, providerId }),
    );
    if (rawProviderState == null) {
      return { state: "unknown", detail: `Provider ${providerId} state is unavailable.`, evidence: { providerId, note: "Provider state is unavailable." } };
    }
    const providerState = readProviderStageState(rawProviderState);
    if (!providerState) {
      return { state: "unknown", detail: `Provider ${providerId} state is unavailable.`, evidence: { providerId, note: "Provider state is unavailable." } };
    }
    const providerEvidence = {
      providerId,
      providerState: providerState.state,
      tunnelId: providerState.tunnelId,
      publicAddress: providerState.publicAddress,
      region: providerState.region,
    };
    let state;
    let detail;
    if (providerState.state === "running" && providerState.connected === true) {
      state = "healthy";
      detail = `Provider ${providerId} is running and connected.`;
    } else if (providerState.state === "running" && providerState.connected === false) {
      state = "degraded";
      detail = `Provider ${providerId} is running but not connected.`;
    } else if (providerState.state === "stopped" || providerState.state === "not-installed") {
      state = "failed";
      detail = `Provider ${providerId} is ${providerState.state}.`;
    } else if (providerState.state === "auth-required") {
      state = "failed";
      detail = `Provider ${providerId} requires authentication.`;
    } else if (providerState.state === "unsupported") {
      state = "unsupported";
      detail = `Provider ${providerId} is unsupported on this computer.`;
    } else {
      state = "unknown";
      detail = `Provider ${providerId} state is ${providerState.state}.`;
    }
    const stage = { state, detail, evidence: providerEvidence };
    if (state === "failed") stage.remediation = [...HINTS.openProvider];
    return stage;
  }

  async function buildPublicEndpointStage(context) {
    if (context.endpointsError) throw context.endpointsError;
    const publicEndpoint = context.publicEndpoint;
    if (!publicEndpoint) {
      return { state: "not_configured", detail: "No public endpoint configured." };
    }
    if (context.providerStageState === "failed") {
      return { state: "failed", detail: "Provider path failed.", evidence: { note: "provider path failed" } };
    }
    const host = endpointHost(publicEndpoint);
    const port = endpointPort(publicEndpoint);
    if (context.probePublic === true && host && port != null) {
      const probe = await callProbe({ host, port, timeoutMs: PUBLIC_PROBE_TIMEOUT_MS });
      if (isObject(probe) && probe.ok === true && probe.result === "connected") {
        return {
          state: "healthy",
          detail: `Public endpoint ${host}:${port} accepted a connection from the control plane.`,
          evidence: { result: "connected", latencyMs: Number.isFinite(Number(probe.latencyMs)) ? Number(probe.latencyMs) : null, vantage: "control-plane" },
        };
      }
      return {
        state: "unknown",
        detail: NAT_HAIRPIN_NOTE,
        evidence: { result: isObject(probe) && probe.result != null ? String(probe.result) : "error", vantage: "control-plane", note: NAT_HAIRPIN_NOTE },
      };
    }
    if (port == null) {
      return { state: "unknown", detail: "No public port configured.", evidence: { note: "No public port configured." } };
    }
    return { state: "unknown", detail: "External reachability not verified.", evidence: { note: "External reachability not verified." } };
  }

  // -------------------------------------------------------------------------
  // Run
  // -------------------------------------------------------------------------

  async function execute(options, testedEndpointIds = new Set()) {
    const startedAt = nowMs();
    const nodeId = normalizeOptionalString(options.nodeId) || "";
    const serviceId = normalizeOptionalString(options.serviceId);
    const endpointId = normalizeOptionalString(options.endpointId);
    const checkedAt = resolveNowIso();
    // Captured before the first await, so any edit or delete during the run
    // is seen at completion.
    const epochAtStart = endpointEpoch;
    if (endpointId != null) testedEndpointIds.add(endpointId);

    let contextError = null;
    let instance = null;
    let computer = null;
    try {
      const context = await callDep("getServiceContext", () => deps.getServiceContext({ nodeId, serviceId }));
      if (isObject(context)) {
        instance = isObject(context.instance) ? context.instance : null;
        computer = isObject(context.computer) ? context.computer : null;
      }
    } catch (error) {
      contextError = error;
    }

    let endpointsError = null;
    let endpoints = [];
    try {
      endpoints = normalizeEndpointList(await callDep("getEndpoints", () => deps.getEndpoints({ nodeId, serviceId })));
    } catch (error) {
      endpointsError = error;
    }

    let endpoint = null;
    if (endpointId) {
      if (!endpointsError) {
        endpoint = endpoints.find((entry) => String(entry.id) === String(endpointId)) || null;
        if (!endpoint) {
          // The only throw in runDiagnostics: a caller asked for a specific
          // endpoint that does not exist for this node/service. Everything
          // else is answered with stages, never with an exception.
          const error = Object.assign(new Error(`Endpoint "${endpointId}" was not found for this target.`), { code: "ENOTFOUND" });
          error.endpointId = endpointId;
          error.nodeId = nodeId;
          throw error;
        }
      }
    } else {
      const enabled = endpoints.filter((entry) => entry.enabled !== false);
      endpoint = serviceId
        ? enabled.find((entry) => String(entry.serviceId || "") === String(serviceId)) || null
        : enabled[0] || null;
    }

    const publicEndpoint = endpointsError ? null : pickPublicEndpoint(endpoints, endpoint);
    // The endpoints this run will probe or report on; shared with its in-flight
    // entry so an edit to any of them detaches the run.
    for (const resolved of [endpoint, publicEndpoint]) {
      const resolvedId = resolved ? normalizeOptionalString(resolved.id) : null;
      if (resolvedId != null) testedEndpointIds.add(resolvedId);
    }

    const contextView = {
      nodeId,
      serviceId,
      endpoint,
      publicEndpoint,
      contextError,
      instance,
      endpointsError,
      probePublic: options.probePublic !== false,
    };

    const stages = [];
    stages.push(await runStage("service-process", () => buildServiceProcessStage(contextView)));
    stages.push(await runStage("local-socket", () => buildLocalSocketStage(contextView)));
    stages.push(await runStage("host-network", () => buildHostNetworkStage(contextView)));
    stages.push(await runStage("agent", () => buildAgentStage(contextView)));
    stages.push(await runStage("provider", () => buildProviderStage(contextView)));
    const providerStageState = stageById(stages, "provider") ? stageById(stages, "provider").state : "unknown";
    stages.push(await runStage("public-endpoint", () => buildPublicEndpointStage({ ...contextView, providerStageState })));

    const stateById = {};
    for (const stage of stages) stateById[stage.id] = stage.state;
    const localScope = healthModel.combineStates([stateById["service-process"], stateById["local-socket"]]);
    const hasType = (type) => endpoints.some((entry) => endpointType(entry) === type);
    const scopes = {
      process: stateById["service-process"],
      local: localScope,
      lan: endpointsError ? "unknown" : hasType("lan") ? healthModel.combineStates([localScope, stateById["host-network"]]) : "not_configured",
      private_overlay: endpointsError
        ? "unknown"
        : hasType("tailscale")
          ? healthModel.combineStates([localScope, stateById["host-network"]])
          : "not_configured",
      public: endpointsError ? "unknown" : publicEndpoint ? stateById["public-endpoint"] : "not_configured",
    };

    const computerName = computer && computer.name ? String(computer.name) : null;
    const serviceName = instance ? String(instance.displayName || instance.name || instance.id) : null;
    const target = {
      nodeId,
      computerName,
      serviceId,
      serviceName,
      endpointId: endpoint ? String(endpoint.id) : endpointId,
      endpointLabel: endpoint ? String(endpoint.name || endpoint.label || "") || null : null,
    };

    const durationMs = Math.max(0, nowMs() - startedAt);
    const provisional = diagnosticsModel.buildDiagnosticsResult({
      target,
      stages,
      scopes,
      checkedAt,
      durationMs,
      cached: false,
    });

    let graph = null;
    if (nodeId) {
      try {
        graph = buildConnectivityGraph({
          computer: { id: nodeId, name: computerName },
          service: instance ? { id: instance.id, name: serviceName } : null,
          endpoints,
          providers: Array.from(new Set(endpoints.map((entry) => endpointProviderId(entry)).filter(Boolean))),
          diagnostics: provisional,
          now: checkedAt,
        });
      } catch {
        graph = null;
      }
    }

    const result = diagnosticsModel.buildDiagnosticsResult({
      target,
      stages,
      scopes,
      checkedAt,
      durationMs,
      cached: false,
      graph,
    });

    if (endpointChangedSince(testedEndpointIds, epochAtStart)) {
      // An endpoint this run tested was edited or deleted while it was in
      // flight: the result describes a target that no longer exists. Neither
      // cached nor returned, for the caller and for every caller that joined.
      return discardedResult({ nodeId, serviceId, endpointId });
    }

    // The tested target (endpointKey: computer, type, host, port, protocol,
    // service) is stored with the result, so an endpoint edited afterwards
    // (same id, different target) can never be shown this result.
    // The key's segments are stored as fields: an endpoint id may itself
    // contain the "|" key delimiter, so endpoint lookups never parse the key.
    cache.set(cacheKey({ nodeId, serviceId, endpointId }), {
      result,
      cachedAt: checkedAt,
      storedAt: nowMs(),
      nodeId,
      endpointId,
      // Every endpoint the result describes, so a later edit to any of them
      // (including one a service-level run selected) drops it.
      testedEndpointIds: Array.from(testedEndpointIds),
      targetKey: endpoint ? endpointKey(endpoint) : null,
    });
    lastRunAt = checkedAt;
    return result;
  }

  async function runDiagnostics(options = {}) {
    const input = isObject(options) ? options : {};
    const key = cacheKey(input);

    if (input.refresh !== true) {
      const cached = readCache(key);
      if (cached) return cachedResultView(cached);
    }

    const pending = inFlight.get(key);
    if (pending) return pending.run;

    const testedEndpointIds = new Set();
    const run = execute(input, testedEndpointIds).finally(() => {
      if (inFlight.get(key)?.run === run) inFlight.delete(key);
    });
    inFlight.set(key, { run, testedEndpointIds });
    return run;
  }

  // An entry describes the endpoint a caller holds only if it tested that
  // endpoint's current target. A caller that names an endpoint and supplies
  // its current record (`endpoint`, null when the endpoint no longer exists,
  // e.g. deleted while a run was in flight) gets only a matching entry;
  // callers that supply no record (service-level reads) keep the entry. A
  // refusal is "not evaluated", never "unknown".
  function entryMatchesEndpoint(entry, target) {
    if (!isObject(target) || !Object.prototype.hasOwnProperty.call(target, "endpoint")) return true;
    if (normalizeOptionalString(target.endpointId) == null) return true;
    if (!isObject(target.endpoint)) return false;
    return entry.targetKey != null && entry.targetKey === endpointKey(target.endpoint);
  }

  // Cache-only read. Returns the cached result when the target was evaluated
  // within the TTL, otherwise a sentinel: never a fabricated health state.
  function getCachedDiagnostics(target = {}) {
    const key = cacheKey(target);
    const entry = readCache(key);
    if (entry && entryMatchesEndpoint(entry, target)) return cachedResultView(entry);
    if (entry) cache.delete(key);
    return { cached: false, stale: true, state: "unknown", reason: "NOT_EVALUATED" };
  }

  // Latest fresh evaluation of one endpoint, however it was run: an endpoint
  // test caches under node||endpoint, a service-scoped run under
  // node|service|endpoint. Readers ask about the endpoint itself, so the lookup
  // spans every service segment for that node and endpoint.
  function getCachedEndpointDiagnostics(target = {}) {
    const input = isObject(target) ? target : {};
    const nodeId = normalizeOptionalString(input.nodeId) || "";
    const endpointId = normalizeOptionalString(input.endpointId);
    if (endpointId == null) return { cached: false, stale: true, state: "unknown", reason: "NOT_EVALUATED" };
    let best = null;
    for (const key of Array.from(cache.keys())) {
      const entry = readCache(key);
      if (!entry || entry.nodeId !== nodeId || entry.endpointId !== endpointId) continue;
      if (!entryMatchesEndpoint(entry, input)) continue;
      if (!best || entry.storedAt > best.storedAt) best = entry;
    }
    return best ? cachedResultView(best) : { cached: false, stale: true, state: "unknown", reason: "NOT_EVALUATED" };
  }

  // Presentation projection: `health` and `lastCheckedAt` are
  // diagnostics-managed and never persisted, so every reader that shows them
  // derives them here from the cached evaluation (cache-only, never a probe).
  function projectEndpointHealth(endpoints, { fallbackNodeId = null } = {}) {
    return (Array.isArray(endpoints) ? endpoints : []).map((endpoint) => {
      if (!isObject(endpoint)) return endpoint;
      const endpointId = normalizeOptionalString(endpoint.id ?? endpoint.endpointId);
      if (endpointId == null) return endpoint;
      const nodeId = normalizeOptionalString(endpoint.computerId ?? endpoint.nodeId) || normalizeOptionalString(fallbackNodeId);
      const cached = getCachedEndpointDiagnostics({ nodeId, endpointId, endpoint });
      const state = cached && cached.cached === true ? normalizeOptionalString(cached.overall && cached.overall.state) : null;
      if (!state) return endpoint;
      return {
        ...endpoint,
        health: { status: state, state, checkedAt: cached.cachedAt || null, source: "diagnostics" },
        lastCheckedAt: cached.cachedAt || null,
      };
    });
  }

  // invalidateDiagnostics({ nodeId, serviceId }) drops every cached target for
  // that node (optionally narrowed to one service); { endpointId } drops that
  // endpoint's entries (optionally on one node); no argument drops all.
  function invalidateDiagnostics(target = {}) {
    const input = isObject(target) ? target : {};
    const wantedNodeId = normalizeOptionalString(input.nodeId);
    const wantedServiceId = normalizeOptionalString(input.serviceId);
    const wantedEndpointId = normalizeOptionalString(input.endpointId);
    if (wantedEndpointId != null) {
      // One endpoint, on every node and service segment it was evaluated under.
      // Runs already in flight for it are discarded on completion and detached
      // so later callers start a fresh run against the current record.
      endpointEpoch += 1;
      endpointChangedAt.set(wantedEndpointId, endpointEpoch);
      for (const [key, pending] of Array.from(inFlight.entries())) {
        if (pending.testedEndpointIds.has(wantedEndpointId)) inFlight.delete(key);
      }
      let invalidated = 0;
      for (const key of Array.from(cache.keys())) {
        const entry = cache.get(key);
        const tested = Array.isArray(entry?.testedEndpointIds) && entry.testedEndpointIds.includes(wantedEndpointId);
        if (!entry || (entry.endpointId !== wantedEndpointId && !tested)) continue;
        if (wantedNodeId != null && entry.nodeId !== wantedNodeId) continue;
        cache.delete(key);
        invalidated += 1;
      }
      return { invalidated };
    }
    if (wantedNodeId == null) {
      const count = cache.size;
      cache.clear();
      return { invalidated: count };
    }
    let invalidated = 0;
    for (const key of Array.from(cache.keys())) {
      const separator = key.indexOf("|");
      const keyNodeId = separator >= 0 ? key.slice(0, separator) : key;
      const keyServiceId = separator >= 0 ? key.slice(separator + 1, key.indexOf("|", separator + 1)) : "";
      if (keyNodeId !== wantedNodeId) continue;
      if (wantedServiceId != null && keyServiceId !== wantedServiceId) continue;
      cache.delete(key);
      invalidated += 1;
    }
    return { invalidated };
  }

  function getDiagnosticsStatus() {
    return {
      cachedTargets: cache.size,
      lastRunAt,
      inFlight: inFlight.size,
    };
  }

  return {
    runDiagnostics,
    getCachedDiagnostics,
    getCachedEndpointDiagnostics,
    projectEndpointHealth,
    invalidateDiagnostics,
    getDiagnosticsStatus,
  };
}

const defaultService = createConnectivityDiagnosticsService();

module.exports = {
  createConnectivityDiagnosticsService,
  probeTcp,
  runDiagnostics: defaultService.runDiagnostics,
  getCachedDiagnostics: defaultService.getCachedDiagnostics,
  getCachedEndpointDiagnostics: defaultService.getCachedEndpointDiagnostics,
  projectEndpointHealth: defaultService.projectEndpointHealth,
  invalidateDiagnostics: defaultService.invalidateDiagnostics,
  getDiagnosticsStatus: defaultService.getDiagnosticsStatus,
};
