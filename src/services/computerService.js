"use strict";

// Computer summary aggregation service: computers as first-class infrastructure
// objects.
//
// A computer summary composes one read model per node from the existing
// sources, and never probes anything itself:
//   - nodeService                     identity, connection state, OS/arch, uptime, profile metrics
//   - endpointService                 endpoint records + endpoint store load report
//   - endpointStore                   provider sync records (default source)
//   - telemetryService                bounded host series (latest CPU/memory/disk + gaps)
//   - connectivityDiagnosticsService  CACHED diagnostics only (never triggers a probe)
//   - serviceRouter                   instance inventory (services on the computer)
//   - providerIntegrationService      provider snapshot fallback for sync records
//
// CONTRACT
// --------
// getComputerSummary()/listComputerSummaries() never throw: every dependency
// call is wrapped, a failed call adds one of the frozen degraded reasons
// ("nodes-unavailable", "endpoints-unavailable", "telemetry-unavailable",
// "provider-unavailable") and yields null / "unknown" values. Missing data is
// never reported as zero. An offline node is a normal state, not a failure, so
// a node the registry reports as unreachable skips the instance-inventory read
// instead of recording it as degradation.
//
// FROZEN SHAPE
// ------------
// The key set of a summary is fixed; consumers depend on the exact fields
// listed in getComputerSummary's return value. Do not add or rename fields.
//
// REDACTION NOTE
// --------------
// Summaries carry ids, names, and addresses only. Nothing is copied wholesale
// out of node or endpoint records, so agent tokens never leave nodeService, and
// endpoint metadata additionally passes a sensitive-key denylist below as
// presentation defense in depth. That filter is not a substitute for the
// endpoint-model contract that endpoint metadata never carries secrets.
//
// INTERPRETATIONS (documented because the design leaves them open)
// ----------------------------------------------------------------
//   - Per-service reachability is the state of the widest configured scope
//     (public > private_overlay > lan > local). A scope that is
//     "not_configured" carries no path and is skipped; an evaluated service
//     with no configured scope reports "not_configured"; no evaluation at all
//     reports "unknown".
//   - Node connectivity combines each scope across every evaluated service's
//     cached diagnostics with healthModel.combineStates (worst evidence wins).
//     With no evaluated service the frozen defaults apply: "unknown" for local
//     (local health is never claimed without evidence) and "not_configured"
//     for lan/private_overlay/public (no path is known to exist).
//   - The provider snapshot dependency is consulted only when the direct
//     provider-sync map read fails or returns an unusable shape; it carries
//     the same per-node sync record under `syncs`, and avoiding it on the
//     common path keeps a summary read from triggering a provider probe.

const { isLoopbackHost, isPrivateHost, publicEndpointView } = require("../shared/endpointModel");
const healthModel = require("../shared/healthModel");
const telemetryStore = require("../shared/telemetryStore");

// Mirrors applicationHostService.APPLICATION_HOST_NODE_ID. Kept local because
// that module requires electron at load time, which this service must not.
const APPLICATION_HOST_ID = "application-host";

const STALE_AFTER_MS = 120000;
const MAX_SERVICES = 50;
const MAX_ENDPOINTS = 50;
// Defensive output bound for the address list: it aggregates at most
// MAX_ENDPOINTS endpoint hosts plus the node's own addresses.
const MAX_ADDRESSES = 64;
// Bounded fan-out for listComputerSummaries: two nodes in flight at a time.
const LIST_CONCURRENCY = 2;

const DEGRADED_NODES = "nodes-unavailable";
const DEGRADED_ENDPOINTS = "endpoints-unavailable";
const DEGRADED_TELEMETRY = "telemetry-unavailable";
const DEGRADED_PROVIDER = "provider-unavailable";
// Last-resort guard only: buildSummary wraps every dependency call, so this
// reason can only surface if the aggregation itself has a defect.
const DEGRADED_SUMMARY = "summary-failed";

const CONNECTIVITY_SCOPES = Object.freeze(["local", "lan", "private_overlay", "public"]);
const REACHABILITY_SCOPE_PRIORITY = Object.freeze(["public", "private_overlay", "lan", "local"]);
const CONNECTIVITY_DEFAULTS = Object.freeze({
  local: "unknown",
  lan: "not_configured",
  private_overlay: "not_configured",
  public: "not_configured",
});
const METRIC_KEYS = Object.freeze(["cpuPercent", "memoryPercent", "diskPercent"]);
const KNOWN_CONNECTIVITY_STATES = new Set(healthModel.CONNECTIVITY_STATES);

// Mirrors nodeService.normalizeConnectionState's public vocabulary without
// importing that module (which requires electron at load time).
const STATE_ALIASES = Object.freeze({
  connected: "online",
  disconnected: "offline",
  unreachable: "offline",
  authentication_required: "authentication_failed",
  unauthorized: "authentication_failed",
  auth_failed: "authentication_failed",
  token_mismatch: "authentication_failed",
  incompatible: "agent_incompatible",
  version_incompatible: "agent_incompatible",
});

// Redaction denylist for endpoint metadata keys. Case-insensitive so a record
// that (against the endpoint-model contract) stores a credential-shaped key
// can never leak it through a computer summary.
const SENSITIVE_METADATA_KEY_PATTERN = /token|secret|password|passwd|credential|auth|api[-_]?key|private[-_]?key|cookie/i;

const ONLINE_STATES = new Set(["online", "degraded"]);
const OFFLINE_STATES = new Set(["offline", "authentication_failed", "agent_incompatible"]);

// ---------------------------------------------------------------------------
// Default dependencies. Resolved lazily inside each function so loading this
// module (for example under plain Node in the smoke script) never forms a
// require cycle with the services it aggregates.
// ---------------------------------------------------------------------------

const defaultDeps = Object.freeze({
  // Registry-only enumeration by default: local-agent discovery and identity
  // refresh are live network probes and must not run inside a summary read.
  listNodes: () => require("./nodeService").listNodes({ discoverLocalAgent: false, refreshIdentity: false }),
  getNode: (nodeId) => require("./nodeService").getNode(nodeId),
  listEndpoints: (filter) => require("./endpointService").listEndpoints(filter),
  getEndpointSummary: (filter) => require("./endpointService").getEndpointSummary(filter),
  getProviderSyncs: () => require("./endpointStore").getEndpointStore().getProviderSyncs(),
  getProviderSnapshot: (filter) => require("./providerIntegrationService").getProviderSnapshot(filter),
  getTelemetrySummary: (filter) => require("./telemetryService").getTelemetrySummary(filter),
  getCachedDiagnostics: (filter) => require("./connectivityDiagnosticsService").getCachedDiagnostics(filter),
  listInstances: (filter) => require("./serviceRouter").listInstances(filter),
});

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

async function settle(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch {
    return { ok: false, value: null };
  }
}

function pushReason(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason);
}

function toIsoOrNull(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : text;
}

function normalizeConnectionState(value) {
  const state = String(value == null ? "" : value).trim().toLowerCase().replace(/-/g, "_");
  const alias = STATE_ALIASES[state];
  return alias || state || "unknown";
}

function firstNonEmptyString(candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate.trim();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-field derivations
// ---------------------------------------------------------------------------

function deriveAgentState(node) {
  if (node.kind === "application-host") return "online";
  return normalizeConnectionState(node.lastConnectionState || node.connection?.status || "unknown");
}

// Tri-state: true = confirmed reachable, false = confirmed unreachable or
// refused, null = no terminal evidence yet ("connecting", "unknown", or a
// missing connection). A "degraded" agent responded with a partial failure, so
// it is reachable.
function deriveOnline(node, agentState) {
  if (node.kind === "application-host") return true;
  if (ONLINE_STATES.has(agentState)) return true;
  if (OFFLINE_STATES.has(agentState)) return false;
  return null;
}

function deriveLastContact(node, nowIso) {
  if (node.kind === "application-host") {
    // The application host is the machine running this process: contact is
    // current by definition even though the raw host node carries no
    // connection record. A wrapped (public) host node may carry a lastSeen.
    return toIsoOrNull(node.connection?.lastSeen) || nowIso;
  }
  return toIsoOrNull(node.lastSuccessfulHealthCheck || node.connection?.lastSeen || null);
}

function isLastContactStale(lastContact, nowMs) {
  if (!lastContact) return true;
  const parsed = Date.parse(lastContact);
  return !Number.isFinite(parsed) || nowMs - parsed > STALE_AFTER_MS;
}

function deriveUptimeSeconds(node) {
  if (node.kind === "application-host") {
    const host = isPlainObject(node.applicationHost) ? node.applicationHost : {};
    const systemUptime = finiteNumber(host.systemUptimeSeconds);
    if (systemUptime !== null) return systemUptime;
    return finiteNumber(host.desktopUptimeSeconds);
  }
  const candidates = [node.uptimeSeconds, node.connection?.uptimeSeconds, node.profile?.agentUptimeSeconds];
  for (const candidate of candidates) {
    const value = finiteNumber(candidate);
    if (value !== null) return value;
  }
  return null;
}

function deriveMetrics(node) {
  if (node.kind === "application-host") {
    const host = isPlainObject(node.applicationHost) ? node.applicationHost : {};
    const memory = isPlainObject(host.memory) ? host.memory : {};
    const total = finiteNumber(memory.total);
    const used = finiteNumber(memory.used);
    const percent = total !== null && total > 0 && used !== null ? Math.round((used / total) * 1000) / 10 : null;
    return {
      // The application host record carries no live CPU or disk sample; the
      // telemetry section carries sampled history when it exists.
      cpu: null,
      memory: percent !== null ? { percent } : null,
      disk: null,
    };
  }
  const profile = isPlainObject(node.profile) ? node.profile : {};
  const cpuPercent = finiteNumber(profile.cpu?.usagePercent);
  const memoryPercent = finiteNumber(profile.ram?.usagePercent);
  const storage = isPlainObject(profile.storage) ? profile.storage : null;
  const diskPercent = finiteNumber(storage ? (storage.percent ?? storage.usagePercent ?? storage.usedPercent) : null);
  return {
    cpu: cpuPercent !== null ? { usagePercent: cpuPercent } : null,
    memory: memoryPercent !== null ? { percent: memoryPercent } : null,
    disk: diskPercent !== null ? { percent: diskPercent } : null,
  };
}

function deriveOs(node) {
  if (node.kind === "application-host") return node.applicationHost?.operatingSystem || null;
  return firstNonEmptyString([
    node.connection?.operatingSystem,
    node.agentIdentity?.operatingSystem,
    node.platform === "win32" ? "windows" : node.platform,
  ]);
}

function deriveArchitecture(node) {
  if (node.kind === "application-host") return node.applicationHost?.architecture || null;
  return firstNonEmptyString([node.connection?.architecture, node.agentIdentity?.architecture, node.architecture]);
}

function deriveAgentVersion(node) {
  // The application host runs no agent, so there is no agent version to report.
  if (node.kind === "application-host") return null;
  return firstNonEmptyString([node.connection?.agentVersion, node.agentIdentity?.agentVersion, node.agentVersion]);
}

function classifyAddressHost(host) {
  if (isLoopbackHost(host)) return "private";
  const parts = String(host).split(".");
  if (parts.length === 4 && parts[0] === "100") {
    const second = Number(parts[1]);
    // CGNAT range, the classification endpointService uses for tailnet
    // addresses, mirrored here because a bare node address carries no
    // interface name to inspect.
    if (Number.isInteger(second) && second >= 64 && second <= 127) return "tailscale";
  }
  if (isPrivateHost(host)) return "lan";
  return "custom";
}

function nodeAddressEntries(node) {
  const entries = [];
  if (Array.isArray(node.addresses)) entries.push(...node.addresses.slice(0, MAX_ADDRESSES));
  // Normalized agent nodes never set node.addresses; a local agent's own
  // interface addresses live on the profile instead, so both are honored.
  if (Array.isArray(node.profile?.localIpAddresses)) entries.push(...node.profile.localIpAddresses.slice(0, MAX_ADDRESSES));
  return entries;
}

function collectAddresses(node, endpointViews) {
  const rows = [];
  const seen = new Set();
  const add = (type, address, source) => {
    const text = typeof address === "string" ? address.trim() : "";
    if (!text || seen.has(text) || rows.length >= MAX_ADDRESSES) return;
    seen.add(text);
    rows.push({ type: firstNonEmptyString([type]) || "unknown", address: text, source });
  };
  for (const view of endpointViews) add(view.type, view.host, "endpoint");
  for (const entry of nodeAddressEntries(node)) {
    if (isPlainObject(entry)) add(entry.type, entry.address, "node");
    else add(classifyAddressHost(String(entry || "")), String(entry || ""), "node");
  }
  return rows;
}

function deriveOverlay(endpointViews) {
  const tailscale = endpointViews.find((view) => view.type === "tailscale") || null;
  if (!tailscale) return null;
  const health = isPlainObject(tailscale.health) ? tailscale.health : {};
  const state = firstNonEmptyString([health.state]) || "unknown";
  return { available: true, state, address: firstNonEmptyString([tailscale.host]) };
}

// ---------------------------------------------------------------------------
// Cached diagnostics readers
// ---------------------------------------------------------------------------

// Returns the four scope states when the cached diagnostics represent a real
// evaluation, or null for the connectivity service's NOT_EVALUATED sentinel
// (or any shape without scope evidence).
function readScopeStates(diagnostics) {
  if (!isPlainObject(diagnostics) || diagnostics.cached === false) return null;
  const source = isPlainObject(diagnostics.reachability)
    ? diagnostics.reachability
    : isPlainObject(diagnostics.scopes)
      ? diagnostics.scopes
      : null;
  if (!source) return null;
  const scopes = {};
  for (const scope of CONNECTIVITY_SCOPES) {
    scopes[scope] = KNOWN_CONNECTIVITY_STATES.has(source[scope]) ? source[scope] : "unknown";
  }
  return scopes;
}

function pickReachability(scopes) {
  for (const scope of REACHABILITY_SCOPE_PRIORITY) {
    const state = scopes[scope];
    if (state && state !== "not_configured") return state;
  }
  return "not_configured";
}

function combineConnectivity(evaluatedScopes) {
  const connectivity = {};
  for (const scope of CONNECTIVITY_SCOPES) {
    const states = [];
    for (const scopes of evaluatedScopes) {
      if (scopes[scope]) states.push(scopes[scope]);
    }
    connectivity[scope] = states.length === 0 ? CONNECTIVITY_DEFAULTS[scope] : healthModel.combineStates(states);
  }
  return connectivity;
}

// ---------------------------------------------------------------------------
// Telemetry section
// ---------------------------------------------------------------------------

function buildTelemetrySection(payload, nodeId) {
  if (!isPlainObject(payload)) return null;
  const series = Array.isArray(payload.series) ? payload.series : [];
  const wantedKeys = {};
  for (const metric of METRIC_KEYS) wantedKeys[telemetryStore.hostSeriesKey(nodeId, metric)] = metric;
  const latestByMetric = {};
  for (const metric of METRIC_KEYS) latestByMetric[metric] = null;

  let seriesCount = 0;
  let missingCount = 0;
  for (const row of series) {
    if (!isPlainObject(row)) continue;
    if (row.nodeId === nodeId) {
      seriesCount += 1;
      const missing = finiteNumber(row.summary?.missingCount);
      if (missing !== null && missing > 0) missingCount += Math.round(missing);
    }
    const metric = wantedKeys[row.key];
    if (!metric) continue;
    const value = finiteNumber(row.summary?.latestValue);
    if (value === null) continue;
    const at = toIsoOrNull(row.summary?.latestAt || row.lastAt || null);
    if (!at) continue;
    const previous = latestByMetric[metric];
    if (!previous || at > previous.at) latestByMetric[metric] = { value, at };
  }

  let latestAt = null;
  for (const metric of METRIC_KEYS) {
    const entry = latestByMetric[metric];
    if (entry && (!latestAt || entry.at > latestAt)) latestAt = entry.at;
  }
  const latest = latestAt
    ? {
        cpuPercent: latestByMetric.cpuPercent ? latestByMetric.cpuPercent.value : null,
        memoryPercent: latestByMetric.memoryPercent ? latestByMetric.memoryPercent.value : null,
        diskPercent: latestByMetric.diskPercent ? latestByMetric.diskPercent.value : null,
        at: latestAt,
      }
    : null;
  return { latest, seriesCount, missingCount };
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

function redactEndpointMetadata(metadata) {
  const safe = {};
  if (!isPlainObject(metadata)) return safe;
  for (const key of Object.keys(metadata)) {
    if (SENSITIVE_METADATA_KEY_PATTERN.test(key)) continue;
    safe[key] = metadata[key];
  }
  return safe;
}

function redactEndpointView(view) {
  return { ...view, metadata: redactEndpointMetadata(view.metadata) };
}

// ---------------------------------------------------------------------------
// Summary builders
// ---------------------------------------------------------------------------

function createEmptySummary(nodeId, reasons) {
  return {
    id: typeof nodeId === "string" && nodeId !== "" ? nodeId : null,
    name: null,
    kind: null,
    os: null,
    architecture: null,
    agentVersion: null,
    agentState: "unknown",
    online: null,
    lastContact: null,
    lastContactStale: true,
    uptimeSeconds: null,
    uptimeAt: null,
    cpu: null,
    memory: null,
    disk: null,
    addresses: [],
    overlay: null,
    services: [],
    endpoints: [],
    connectivity: { ...CONNECTIVITY_DEFAULTS },
    telemetry: null,
    providerSync: null,
    lastKnownAt: null,
    degraded: reasons.length > 0,
    degradedReasons: reasons,
  };
}

function serviceDisplayName(instance, fallbackId) {
  return firstNonEmptyString([instance.displayName, instance.name]) || fallbackId;
}

function instanceServiceState(instance) {
  return firstNonEmptyString([instance.state, instance.processState]) || "unknown";
}

function createComputerService({ deps = {} } = {}) {
  const overrides = isPlainObject(deps) ? deps : {};
  const resolvedDeps = {};
  for (const name of Object.keys(defaultDeps)) {
    resolvedDeps[name] = typeof overrides[name] === "function" ? overrides[name] : defaultDeps[name];
  }

  async function buildSummary(requestedNodeId) {
    const reasons = [];
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    let node = null;
    try {
      node = await resolvedDeps.getNode(requestedNodeId);
    } catch {
      node = null;
    }
    if (!isPlainObject(node)) {
      pushReason(reasons, DEGRADED_NODES);
      return createEmptySummary(requestedNodeId, reasons);
    }

    const nodeId = typeof node.id === "string" && node.id !== "" ? node.id : requestedNodeId || null;
    const agentState = deriveAgentState(node);
    const online = deriveOnline(node, agentState);

    const [endpointsSettled, endpointSummarySettled, telemetrySettled, syncsSettled] = await Promise.all([
      settle(() => resolvedDeps.listEndpoints({ nodeId })),
      settle(() => resolvedDeps.getEndpointSummary({ nodeId })),
      settle(() => resolvedDeps.getTelemetrySummary({ nodeId })),
      settle(() => resolvedDeps.getProviderSyncs()),
    ]);

    // --- Endpoints --------------------------------------------------------
    let endpointRecords = [];
    if (endpointsSettled.ok) {
      const listed = endpointsSettled.value;
      endpointRecords = Array.isArray(listed) ? listed : Array.isArray(listed?.endpoints) ? listed.endpoints : [];
    } else {
      pushReason(reasons, DEGRADED_ENDPOINTS);
    }
    if (!endpointSummarySettled.ok) {
      pushReason(reasons, DEGRADED_ENDPOINTS);
    } else if (isPlainObject(endpointSummarySettled.value) && endpointSummarySettled.value.degraded === true) {
      // A corrupt or migration-failed endpoint store means endpoint data
      // cannot be trusted; that is reported under the frozen
      // endpoints-unavailable reason.
      pushReason(reasons, DEGRADED_ENDPOINTS);
    }

    const endpointViews = [];
    for (const record of endpointRecords) {
      if (endpointViews.length >= MAX_ENDPOINTS) break;
      const view = publicEndpointView(record);
      if (view) endpointViews.push(redactEndpointView(view));
    }

    // --- Services (instances) + cached diagnostics ------------------------
    let instances = [];
    if (online === false) {
      // A node the registry reports as unreachable cannot serve its instance
      // inventory. The read is skipped rather than recorded as degradation:
      // offline is a normal state, not a failure.
      instances = [];
    } else {
      const instancesSettled = await settle(() => resolvedDeps.listInstances({ nodeId }));
      if (instancesSettled.ok) {
        const listed = instancesSettled.value;
        instances = Array.isArray(listed) ? listed : Array.isArray(listed?.instances) ? listed.instances : [];
      } else {
        // The instance inventory is read through the node itself; a failed
        // read means the node's data is unavailable.
        pushReason(reasons, DEGRADED_NODES);
      }
    }

    const services = [];
    const evaluatedScopes = [];
    for (const instance of instances.slice(0, MAX_SERVICES)) {
      if (!isPlainObject(instance)) continue;
      const serviceId = firstNonEmptyString([instance.id]);
      if (!serviceId) continue;
      const diagnosticsSettled = await settle(() => resolvedDeps.getCachedDiagnostics({ nodeId, serviceId }));
      let scopes = null;
      if (diagnosticsSettled.ok) {
        scopes = readScopeStates(diagnosticsSettled.value);
      } else {
        pushReason(reasons, DEGRADED_ENDPOINTS);
      }
      if (scopes) evaluatedScopes.push(scopes);
      services.push({
        id: serviceId,
        name: serviceDisplayName(instance, serviceId),
        state: instanceServiceState(instance),
        reachability: scopes ? pickReachability(scopes) : "unknown",
      });
    }
    const connectivity = combineConnectivity(evaluatedScopes);

    // --- Telemetry --------------------------------------------------------
    let telemetry = null;
    if (telemetrySettled.ok) {
      telemetry = buildTelemetrySection(telemetrySettled.value, nodeId);
    } else {
      pushReason(reasons, DEGRADED_TELEMETRY);
    }

    // --- Provider sync ----------------------------------------------------
    let providerSync = null;
    const syncsUsable = syncsSettled.ok && isPlainObject(syncsSettled.value);
    if (!syncsUsable) pushReason(reasons, DEGRADED_PROVIDER);
    if (syncsUsable) {
      const entry = syncsSettled.value[nodeId];
      providerSync = isPlainObject(entry) ? { ...entry } : null;
    } else {
      // Fallback: the provider snapshot carries the same per-node sync record.
      const snapshotSettled = await settle(() => resolvedDeps.getProviderSnapshot({ nodeId }));
      if (snapshotSettled.ok) {
        const snapshot = snapshotSettled.value;
        providerSync = isPlainObject(snapshot) && isPlainObject(snapshot.syncs) ? { ...snapshot.syncs } : null;
      } else {
        pushReason(reasons, DEGRADED_PROVIDER);
      }
    }

    // --- Assembly ---------------------------------------------------------
    const lastContact = deriveLastContact(node, nowIso);
    const uptimeSeconds = deriveUptimeSeconds(node);
    const metrics = deriveMetrics(node);
    return {
      id: nodeId,
      name: firstNonEmptyString([node.displayName, node.name, node.hostname]) || nodeId,
      kind: node.kind === "application-host" ? "application-host" : "agent",
      os: deriveOs(node),
      architecture: deriveArchitecture(node),
      agentVersion: deriveAgentVersion(node),
      agentState,
      online,
      lastContact,
      lastContactStale: isLastContactStale(lastContact, nowMs),
      uptimeSeconds,
      uptimeAt: uptimeSeconds === null ? null : new Date(nowMs - uptimeSeconds * 1000).toISOString(),
      cpu: metrics.cpu,
      memory: metrics.memory,
      disk: metrics.disk,
      addresses: collectAddresses(node, endpointViews),
      overlay: deriveOverlay(endpointViews),
      services,
      endpoints: endpointViews,
      connectivity,
      telemetry,
      providerSync,
      lastKnownAt: online === false ? lastContact : null,
      degraded: reasons.length > 0,
      degradedReasons: reasons,
    };
  }

  async function getComputerSummary(options = {}) {
    const input = isPlainObject(options) ? options : {};
    const requestedNodeId = typeof input.nodeId === "string" && input.nodeId.trim() !== "" ? input.nodeId.trim() : undefined;
    try {
      return await buildSummary(requestedNodeId);
    } catch {
      // Last-resort guard: buildSummary wraps every dependency call, so this
      // catch only fires on an internal defect. The never-throw contract still
      // holds and the defect is reported as a degraded summary.
      return createEmptySummary(requestedNodeId, [DEGRADED_SUMMARY]);
    }
  }

  async function listComputerSummaries(options = {}) {
    const input = isPlainObject(options) ? options : {};
    const includeDisabled = input.includeDisabled === true;
    const listReasons = [];

    let listed = [];
    try {
      const payload = await resolvedDeps.listNodes();
      listed = Array.isArray(payload) ? payload : Array.isArray(payload?.nodes) ? payload.nodes : [];
    } catch {
      pushReason(listReasons, DEGRADED_NODES);
    }

    const ids = [];
    const seen = new Set();
    const addId = (id) => {
      const text = typeof id === "string" ? id.trim() : "";
      if (!text || seen.has(text)) return;
      seen.add(text);
      ids.push(text);
    };
    // The application host is always part of the fleet view, first.
    addId(APPLICATION_HOST_ID);
    for (const node of listed) {
      if (!isPlainObject(node)) continue;
      if (node.kind === "application-host") {
        addId(node.id || APPLICATION_HOST_ID);
        continue;
      }
      if (node.enabled === false && !includeDisabled) continue;
      addId(node.id);
    }

    const computers = new Array(ids.length).fill(null);
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(LIST_CONCURRENCY, ids.length));
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < ids.length) {
        const index = cursor;
        cursor += 1;
        const id = ids[index];
        try {
          computers[index] = await buildSummary(id);
        } catch {
          computers[index] = createEmptySummary(id, [DEGRADED_SUMMARY]);
        }
      }
    });
    await Promise.all(workers);

    const summaries = computers.filter(Boolean);
    return {
      computers: summaries,
      generatedAt: new Date().toISOString(),
      degraded: listReasons.length > 0 || summaries.some((summary) => summary.degraded === true),
    };
  }

  return { getComputerSummary, listComputerSummaries };
}

const defaultService = createComputerService();

module.exports = {
  createComputerService,
  getComputerSummary: (options) => defaultService.getComputerSummary(options),
  listComputerSummaries: (options) => defaultService.listComputerSummaries(options),
};
