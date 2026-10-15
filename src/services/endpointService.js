"use strict";

/**
 * Endpoint orchestration service.
 *
 * Sits between IPC/provider surfaces and the endpoint store:
 * - typed CRUD over the persisted endpoint registry (endpointStore),
 * - read models (summary, per-service resolution),
 * - endpoint discovery from live evidence:
 *     * Agent nodes: read-only network inventory (listeners/interfaces/checkPort),
 *     * Application-host nodes: bounded local TCP connect probes.
 *
 * Discovery is conservative: it only ever creates or updates DISCOVERED endpoints,
 * never touches manual/provider endpoints, never deletes anything, and never flips
 * the enabled flag.
 */

const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const {
  ENDPOINT_TYPES,
  endpointKey,
  isLoopbackHost,
  isPrivateHost,
  sortEndpoints,
} = require("../shared/endpointModel");

const PROBE_TIMEOUT_MS = 1500;
const DISCOVERY_SCOPES = Object.freeze(["loopback", "lan", "tailscale", "bound"]);

function createServiceError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function validationFailed(errors) {
  return createServiceError("ENDPOINT_VALIDATION_FAILED", "Endpoint input is invalid.", { errors });
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function hasOwn(value, key) {
  return isPlainObject(value) && Object.prototype.hasOwnProperty.call(value, key);
}

// Diagnostics-managed record fields: `health` and `lastCheckedAt` are owned by
// the connectivity diagnostics cache (read-time overlay in
// operationalNotificationService) and the telemetry readers, never by caller
// input. The service boundary strips them before any store upsert so a renderer
// cannot persist fabricated health into endpoints.json. `id` handling stays as
// it was (an input id selects/overwrites the record identity for update and
// re-link flows) and `providerSyncs` is a document-level field the store never
// persists onto a record.
const MANAGEMENT_OWNED_FIELDS = Object.freeze(["health", "lastCheckedAt"]);

function stripManagementOwnedFields(input) {
  if (!isPlainObject(input)) return input;
  const sanitized = { ...input };
  for (const field of MANAGEMENT_OWNED_FIELDS) delete sanitized[field];
  return sanitized;
}

function isCgnatIpv4(host) {
  const parts = String(host || "").trim().split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN));
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  return octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127;
}

function classifyDiscoveredAddress(host, interfaceName) {
  const name = String(interfaceName || "");
  if (/^tailscale/i.test(name) || isCgnatIpv4(host)) return "tailscale";
  if (isPrivateHost(host)) return "lan";
  if (isLoopbackHost(host)) return "private";
  return "custom";
}

function buildDiscoveredName(label, type, host) {
  const base = String(label || "Service").trim() || "Service";
  let suffix;
  if (type === "private") suffix = "loopback";
  else if (type === "lan") suffix = `LAN ${host}`;
  else if (type === "tailscale") suffix = `Tailscale ${host}`;
  else suffix = host;
  const maxBase = Math.max(1, 120 - suffix.length - 3);
  return `${base.slice(0, maxBase)} (${suffix})`;
}

function extractServicePorts(instance) {
  const specs = [];
  const seen = new Set();
  const add = (value, protocol) => {
    const port = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
    if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return;
    const normalizedProtocol = ["udp", "http", "https"].includes(protocol) ? protocol : "tcp";
    const key = `${port}:${normalizedProtocol}`;
    if (seen.has(key)) return;
    seen.add(key);
    specs.push({ port, protocol: normalizedProtocol });
  };
  if (instance && typeof instance === "object") {
    const ports = Array.isArray(instance.ports) ? instance.ports : [];
    for (const entry of ports) {
      if (entry === null || entry === undefined) continue;
      if (isPlainObject(entry)) add(entry.port, entry.protocol);
      else add(entry, null);
    }
    add(instance.preferredPort, null);
  }
  return specs;
}

function normalizeListenerAddress(address) {
  let value = String(address || "").trim();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1).trim();
  return value;
}

function isWildcardAddress(address) {
  return address === "0.0.0.0" || address === "::" || address === "*";
}

function listenerRowsForPort(inventory, port, protocol) {
  const rows = Array.isArray(inventory?.listeners) ? inventory.listeners : [];
  return rows.filter((row) => (
    row
    && typeof row === "object"
    && Number(row.localPort) === port
    && String(row.protocol || "tcp").toLowerCase() === protocol
    && typeof row.localAddress === "string"
    && row.localAddress.trim() !== ""
  ));
}

function collectInventoryInterfaces(inventory) {
  const rows = Array.isArray(inventory?.interfaces) ? inventory.interfaces : [];
  return rows
    .filter((entry) => (
      entry
      && typeof entry === "object"
      && typeof entry.address === "string"
      && entry.address.trim() !== ""
      && entry.internal !== true
    ))
    .map((entry) => ({
      host: entry.address.trim(),
      interfaceName: typeof entry.name === "string" && entry.name.trim() !== "" ? entry.name.trim() : null,
      family: entry.family === "IPv6" || entry.family === 6 ? "IPv6" : "IPv4",
    }));
}

function probeTcpPort(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new net.Socket();
    const finish = (listening) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect({ host, port });
    } catch {
      finish(false);
    }
  });
}

// Application-host discovery fallback: enumerate the OS interfaces, then run a
// bounded TCP connect probe against 127.0.0.1 and every interface address for each
// requested service port. No shell, no UDP probe (TCP connect is the evidence).
async function defaultProbeLocalListeners(options = {}) {
  const ports = Array.isArray(options.ports) ? options.ports : [];
  const interfaces = os.networkInterfaces();
  const targets = [];
  const seen = new Set();
  const addTarget = (host, interfaceName, family, internal) => {
    const key = String(host);
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ host, interfaceName, family, internal });
  };
  addTarget("127.0.0.1", "loopback", "IPv4", true);
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const entry of entries || []) {
      if (!entry || typeof entry.address !== "string" || entry.address.trim() === "") continue;
      addTarget(
        entry.address.trim(),
        name,
        entry.family === 6 || entry.family === "IPv6" ? "IPv6" : "IPv4",
        entry.internal === true,
      );
    }
  }

  const results = [];
  for (const portSpec of ports) {
    const port = Number(portSpec?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    const probes = await Promise.all(targets.map(async (target) => ({
      ...target,
      listening: await probeTcpPort(target.host, port),
    })));
    results.push({
      port,
      protocol: portSpec.protocol || "tcp",
      listening: probes.some((probe) => probe.listening === true),
      probes,
    });
  }
  return {
    supported: true,
    availability: "application-host",
    results,
    probedAt: new Date().toISOString(),
  };
}

function defaultGetNetworkInventory(options = {}) {
  return require("./serviceRouter").getNetworkInventory(options);
}

function defaultListInstances(options = {}) {
  return require("./serviceRouter").listInstances(options);
}

function defaultGetNode(nodeId) {
  return require("./nodeService").getNode(nodeId);
}

const defaultDeps = Object.freeze({
  getNetworkInventory: (options) => defaultGetNetworkInventory(options || {}),
  listInstances: (options) => defaultListInstances(options || {}),
  getNode: (nodeId) => defaultGetNode(nodeId),
  probeLocalListeners: (options) => defaultProbeLocalListeners(options),
});

function createEndpointService({ store, deps } = {}) {
  const serviceStore = store || require("./endpointStore").getEndpointStore();
  const resolvedDeps = Object.freeze({
    ...defaultDeps,
    ...(isPlainObject(deps) ? deps : {}),
  });

  function getLoadReport() {
    return isPlainObject(serviceStore.loadReport) ? serviceStore.loadReport : {};
  }

  function requireEndpoint(id) {
    const record = serviceStore.get(id);
    if (!record) {
      throw createServiceError("ENDPOINT_NOT_FOUND", "Endpoint was not found.", { endpointId: id });
    }
    return record;
  }

  function legacyServiceRecordsExist({ nodeId, serviceId }) {
    const directory = serviceStore.configDirectory;
    if (typeof directory !== "string" || directory.trim() === "") return false;
    try {
      const legacyPath = path.join(directory, "public-access-services.json");
      if (!fs.existsSync(legacyPath)) return false;
      const parsed = JSON.parse(fs.readFileSync(legacyPath, "utf8"));
      const services = Array.isArray(parsed?.services) ? parsed.services : Array.isArray(parsed) ? parsed : [];
      if (!Array.isArray(services) || services.length === 0) return false;
      if (!nodeId && !serviceId) return true;
      return services.some((record) => {
        if (!isPlainObject(record)) return false;
        if (nodeId && record.nodeId !== nodeId) return false;
        if (serviceId && record.linkedInstanceId !== serviceId) return false;
        return true;
      });
    } catch {
      return false;
    }
  }

  function listEndpoints(filter) {
    return serviceStore.list(filter);
  }

  function getEndpoint(id) {
    return requireEndpoint(id);
  }

  function getEndpointSummary({ nodeId } = {}) {
    const endpoints = serviceStore.list(nodeId ? { nodeId } : {});
    const byType = {};
    for (const type of ENDPOINT_TYPES) byType[type] = 0;
    const byHealth = {};
    const services = new Set();
    const computers = new Set();
    let enabled = 0;
    let lastUpdatedAt = null;
    for (const endpoint of endpoints) {
      byType[endpoint.type] = (byType[endpoint.type] || 0) + 1;
      const health = isPlainObject(endpoint.health) && typeof endpoint.health.status === "string" && endpoint.health.status !== ""
        ? endpoint.health.status
        : "unknown";
      byHealth[health] = (byHealth[health] || 0) + 1;
      if (endpoint.enabled !== false) enabled += 1;
      if (endpoint.serviceId) services.add(endpoint.serviceId);
      if (endpoint.computerId) computers.add(endpoint.computerId);
      if (typeof endpoint.updatedAt === "string" && (!lastUpdatedAt || endpoint.updatedAt > lastUpdatedAt)) {
        lastUpdatedAt = endpoint.updatedAt;
      }
    }
    const report = getLoadReport();
    return {
      total: endpoints.length,
      enabled,
      disabled: endpoints.length - enabled,
      byType,
      byHealth,
      serviceCount: services.size,
      computerCount: computers.size,
      lastUpdatedAt,
      degraded: report.corrupt === true || Boolean(report.migrationError),
    };
  }

  function createEndpoint(input) {
    // health/lastCheckedAt are diagnostics-managed (diagnostics cache + in-memory
    // overlay); strip them at the service boundary so create cannot persist
    // caller-supplied health into endpoints.json.
    return serviceStore.upsert(stripManagementOwnedFields(input));
  }

  function updateEndpoint(id, patch = {}) {
    const existing = requireEndpoint(id);
    const sanitizedPatch = stripManagementOwnedFields(isPlainObject(patch) ? patch : {});
    const merged = { ...existing, ...sanitizedPatch, id: existing.id };
    return serviceStore.upsert(merged);
  }

  function deleteEndpoint(id) {
    return serviceStore.remove(id);
  }

  function setEndpointEnabled(id, enabled) {
    return serviceStore.setEnabled(id, enabled);
  }

  function associateEndpoint(payload = {}) {
    const input = isPlainObject(payload) ? payload : {};
    const record = requireEndpoint(input.endpointId);
    const hasService = hasOwn(input, "serviceId");
    const hasComputer = hasOwn(input, "computerId");
    if (!hasService && !hasComputer) {
      throw validationFailed([{
        field: "serviceId",
        code: "ENDPOINT_ASSOCIATION_REQUIRED",
        message: "Provide a serviceId or computerId to associate the endpoint.",
      }]);
    }
    const next = { ...record, id: record.id };
    if (hasService) next.serviceId = input.serviceId ?? null;
    if (hasComputer) next.computerId = input.computerId ?? null;
    return serviceStore.upsert(next);
  }

  function upsertProviderEndpoint(payload = {}) {
    const input = isPlainObject(payload) ? payload : {};
    const base = isPlainObject(input.input) ? { ...input.input } : {};
    if (!base.providerId) {
      throw validationFailed([{
        field: "providerId",
        code: "ENDPOINT_PROVIDER_REQUIRED",
        message: "Provider id is required for provider endpoints.",
      }]);
    }
    if (!base.computerId && input.nodeId) base.computerId = input.nodeId;
    base.source = "provider";
    return serviceStore.upsert(base);
  }

  function recordProviderSync(nodeId, patch) {
    return serviceStore.recordProviderSync(nodeId, patch);
  }

  // Persisted per-node provider sync records ({ [nodeId]: record }). Part of
  // the gateway contract providerIntegrationService reads for snapshot.syncs.
  function getProviderSyncs() {
    return serviceStore.getProviderSyncs();
  }

  function resolveServiceEndpoints({ nodeId, serviceId } = {}) {
    const filter = {};
    if (nodeId) filter.nodeId = nodeId;
    if (serviceId) filter.serviceId = serviceId;
    const sorted = sortEndpoints(serviceStore.list(filter));
    const endpoints = [
      ...sorted.filter((endpoint) => endpoint.enabled !== false),
      ...sorted.filter((endpoint) => endpoint.enabled === false),
    ];
    const report = getLoadReport();
    return {
      endpoints,
      degraded: report.corrupt === true || Boolean(report.migrationError),
      legacyAvailable: legacyServiceRecordsExist({ nodeId, serviceId }),
    };
  }

  function applyDiscoveredSpecs(specs, context) {
    // Every classified spec counts as observed, even when the endpoint write is
    // skipped because a manual/provider record owns the identity: the address is
    // present in the current inventory classification either way.
    for (const spec of specs) context.observedHosts.add(String(spec.host));
    const deduped = [];
    const seen = new Set();
    for (const spec of specs) {
      const key = endpointKey({
        computerId: context.nodeId,
        type: spec.type,
        host: spec.host,
        port: spec.port,
        protocol: spec.protocol,
        serviceId: spec.serviceId,
      });
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(spec);
    }
    for (const spec of deduped) {
      const key = endpointKey({
        computerId: context.nodeId,
        type: spec.type,
        host: spec.host,
        port: spec.port,
        protocol: spec.protocol,
        serviceId: spec.serviceId,
      });
      const existing = serviceStore.list().find((entry) => endpointKey(entry) === key) || null;
      if (existing && existing.source !== "discovered") {
        context.skipped.push({
          reason: "existing-non-discovered",
          endpointId: existing.id,
          host: spec.host,
          type: spec.type,
          port: spec.port,
        });
        continue;
      }
      if (existing) {
        const merged = {
          ...existing,
          id: existing.id,
          host: spec.host,
          metadata: { ...existing.metadata, ...spec.metadata },
        };
        const record = serviceStore.upsert(merged);
        context.updated.push(record);
      } else {
        const record = serviceStore.upsert({ ...spec, source: "discovered", computerId: context.nodeId });
        context.created.push(record);
      }
    }
  }

  function buildSpec({ host, type, scope, port, protocol, nodeId, serviceId, label, interfaceName, family, nowIso }) {
    const metadata = { scope, discoveredAt: nowIso };
    if (interfaceName) metadata.interfaceName = interfaceName;
    if (family) metadata.addressFamily = family;
    else if (String(host).indexOf(":") !== -1) metadata.addressFamily = "IPv6";
    else metadata.addressFamily = "IPv4";
    return {
      name: buildDiscoveredName(label || serviceId || nodeId, type, host),
      type,
      host,
      port,
      protocol,
      providerId: null,
      serviceId: serviceId || null,
      computerId: nodeId,
      source: "discovered",
      metadata,
    };
  }

  function serviceLabel(instance, serviceId, nodeId) {
    if (isPlainObject(instance)) {
      if (typeof instance.displayName === "string" && instance.displayName.trim() !== "") return instance.displayName.trim();
      if (typeof instance.name === "string" && instance.name.trim() !== "") return instance.name.trim();
    }
    return serviceId || nodeId || "Service";
  }

  function buildAgentSpecsForPort(inventory, portEntry, context) {
    const specs = [];
    const rows = listenerRowsForPort(inventory, portEntry.port, portEntry.protocol);
    const interfaces = collectInventoryInterfaces(inventory);
    const checkResult = isPlainObject(inventory?.checkPort) && Number(inventory.checkPort.port) === portEntry.port
      ? inventory.checkPort
      : null;
    const listening = checkResult ? checkResult.listening === true : rows.length > 0;
    portEntry.listening = listening;
    if (!listening) {
      context.result.portNotListening = true;
      context.result.skipped.push({ reason: "port-not-listening", port: portEntry.port, protocol: portEntry.protocol });
      return specs;
    }

    const loopbackSeen = new Set();
    let wildcard = false;
    const concrete = [];
    for (const row of rows) {
      const address = normalizeListenerAddress(row.localAddress);
      if (address === "") continue;
      if (isLoopbackHost(address)) {
        if (!loopbackSeen.has(address)) {
          loopbackSeen.add(address);
          specs.push(buildSpec({
            host: address,
            type: "private",
            scope: "loopback",
            port: portEntry.port,
            protocol: portEntry.protocol,
            nodeId: context.nodeId,
            serviceId: context.serviceId,
            label: context.label,
            family: address.indexOf(":") !== -1 ? "IPv6" : "IPv4",
            nowIso: context.nowIso,
          }));
        }
        continue;
      }
      if (isWildcardAddress(address)) {
        wildcard = true;
        continue;
      }
      concrete.push(address);
    }

    if (wildcard) {
      for (const iface of interfaces) {
        const type = classifyDiscoveredAddress(iface.host, iface.interfaceName);
        if (type === "lan" && iface.family !== "IPv4") continue;
        if (type !== "lan" && type !== "tailscale") continue;
        specs.push(buildSpec({
          host: iface.host,
          type,
          scope: type === "tailscale" ? "tailscale" : "lan",
          port: portEntry.port,
          protocol: portEntry.protocol,
          nodeId: context.nodeId,
          serviceId: context.serviceId,
          label: context.label,
          interfaceName: iface.interfaceName,
          family: iface.family,
          nowIso: context.nowIso,
        }));
      }
    }

    for (const address of concrete) {
      const iface = interfaces.find((entry) => entry.host === address) || null;
      const type = classifyDiscoveredAddress(address, iface?.interfaceName);
      specs.push(buildSpec({
        host: address,
        type,
        scope: "bound",
        port: portEntry.port,
        protocol: portEntry.protocol,
        nodeId: context.nodeId,
        serviceId: context.serviceId,
        label: context.label,
        interfaceName: iface?.interfaceName || null,
        family: iface?.family || (address.indexOf(":") !== -1 ? "IPv6" : "IPv4"),
        nowIso: context.nowIso,
      }));
    }
    return specs;
  }

  function buildProbeSpecsForPort(probeResult, portEntry, context) {
    const specs = [];
    const probes = Array.isArray(probeResult?.probes) ? probeResult.probes : [];
    const listening = probeResult?.listening === true || probes.some((probe) => probe?.listening === true);
    portEntry.listening = listening;
    if (!listening) {
      context.result.portNotListening = true;
      context.result.skipped.push({ reason: "port-not-listening", port: portEntry.port, protocol: portEntry.protocol });
      return specs;
    }
    for (const probe of probes) {
      if (!probe || probe.listening !== true || typeof probe.host !== "string" || probe.host.trim() === "") continue;
      const host = probe.host.trim();
      const family = probe.family === "IPv6" || probe.family === 6 ? "IPv6" : "IPv4";
      if (probe.internal === true || isLoopbackHost(host)) {
        specs.push(buildSpec({
          host,
          type: "private",
          scope: "loopback",
          port: portEntry.port,
          protocol: portEntry.protocol,
          nodeId: context.nodeId,
          serviceId: context.serviceId,
          label: context.label,
          interfaceName: probe.interfaceName || null,
          family,
          nowIso: context.nowIso,
        }));
        continue;
      }
      const type = classifyDiscoveredAddress(host, probe.interfaceName);
      if (type !== "lan" && type !== "tailscale") {
        context.result.skipped.push({
          reason: "unclassified-address",
          host,
          interfaceName: probe.interfaceName || null,
          port: portEntry.port,
        });
        continue;
      }
      specs.push(buildSpec({
        host,
        type,
        scope: type === "tailscale" ? "tailscale" : "lan",
        port: portEntry.port,
        protocol: portEntry.protocol,
        nodeId: context.nodeId,
        serviceId: context.serviceId,
        label: context.label,
        interfaceName: probe.interfaceName || null,
        family,
        nowIso: context.nowIso,
      }));
    }
    return specs;
  }

  function finalizeDiscoveryState(result) {
    if (result.state === "unsupported") return result;
    if (result.ports.length === 0) {
      result.state = "unknown";
      return result;
    }
    const allListening = result.ports.every((entry) => entry.listening === true);
    if (!allListening) {
      result.state = "degraded";
      return result;
    }
    result.state = result.skipped.length > 0 ? "degraded" : "healthy";
    return result;
  }

  // Stale discovers = discovered endpoints for the same service+computer whose
  // host was not classified in this run (the address disappeared from the live
  // inventory). Pure report: callers must never delete or disable these records.
  function collectStaleDiscovered(context) {
    const observed = context.observedHosts;
    return serviceStore
      .list({ nodeId: context.nodeId })
      .filter((endpoint) => (
        endpoint.source === "discovered"
        && endpoint.serviceId === context.serviceId
        && !observed.has(String(endpoint.host))
      ))
      .map((endpoint) => endpoint.id);
  }

  async function discoverEndpoints({ nodeId, serviceId, deps: overrideDeps } = {}) {
    if (typeof nodeId !== "string" || nodeId.trim() === "") {
      throw createServiceError("ENDPOINT_NODE_REQUIRED", "A node id is required for endpoint discovery.");
    }
    const effectiveDeps = overrideDeps && isPlainObject(overrideDeps)
      ? { ...resolvedDeps, ...overrideDeps }
      : resolvedDeps;
    const nowIso = new Date().toISOString();
    let label = serviceId || nodeId;

    const result = {
      created: [],
      updated: [],
      state: "unknown",
      inventoryAvailable: false,
      portNotListening: false,
      ports: [],
      skipped: [],
      // Non-destructive staleness report: previously discovered endpoint ids for
      // this service+computer whose address was not classified in this run.
      // Reported only; nothing is ever deleted, disabled or edited.
      stale: [],
      reason: null,
    };
    const context = {
      nodeId,
      serviceId: serviceId || null,
      label,
      nowIso,
      result,
      created: result.created,
      updated: result.updated,
      skipped: result.skipped,
      observedHosts: new Set(),
    };

    let instances = [];
    try {
      const listing = await effectiveDeps.listInstances({ nodeId });
      instances = Array.isArray(listing?.instances) ? listing.instances : Array.isArray(listing) ? listing : [];
    } catch {
      result.reason = "instances-unavailable";
      result.skipped.push({ reason: "instances-unavailable" });
      return result;
    }

    let instance = null;
    if (serviceId) {
      instance = instances.find((entry) => isPlainObject(entry) && entry.id === serviceId) || null;
      if (!instance) {
        result.reason = "service-not-found";
        result.skipped.push({ reason: "service-not-found", serviceId });
        return result;
      }
    }

    const ports = extractServicePorts(instance);
    if (ports.length === 0) {
      result.reason = "no-ports";
      result.skipped.push({ reason: "no-ports", serviceId: serviceId || null });
      return result;
    }
    result.ports = ports.map((entry) => ({ port: entry.port, protocol: entry.protocol, listening: false }));
    context.label = serviceLabel(instance, serviceId, nodeId);

    let nodeKind = "agent";
    try {
      const node = await effectiveDeps.getNode(nodeId);
      if (node && typeof node === "object" && node.kind === "application-host") nodeKind = "application-host";
    } catch {
      result.reason = "node-unavailable";
      result.skipped.push({ reason: "node-unavailable", nodeId });
      return result;
    }

    if (nodeKind === "application-host") {
      let probe = null;
      try {
        probe = await effectiveDeps.probeLocalListeners({
          nodeId,
          ports: ports.map((entry) => ({ port: entry.port, protocol: entry.protocol })),
        });
      } catch {
        probe = null;
      }
      if (!probe || typeof probe !== "object") {
        result.reason = "probe-unavailable";
        result.state = "unknown";
        result.skipped.push({ reason: "probe-unavailable" });
        return result;
      }
      if (probe.supported === false) {
        result.reason = "local-probe-unsupported";
        result.state = "unsupported";
        return result;
      }
      result.inventoryAvailable = true;
      for (const portEntry of result.ports) {
        const probeResult = (Array.isArray(probe.results) ? probe.results : []).find((entry) => (
          entry
          && Number(entry.port) === portEntry.port
          && (!entry.protocol || entry.protocol === portEntry.protocol)
        )) || null;
        if (!probeResult) {
          portEntry.listening = false;
          result.portNotListening = true;
          result.skipped.push({ reason: "port-not-probed", port: portEntry.port, protocol: portEntry.protocol });
          continue;
        }
        const specs = buildProbeSpecsForPort(probeResult, portEntry, context);
        applyDiscoveredSpecs(specs, context);
      }
      result.stale = collectStaleDiscovered(context);
      return finalizeDiscoveryState(result);
    }

    for (const portEntry of result.ports) {
      let inventory = null;
      try {
        inventory = await effectiveDeps.getNetworkInventory({
          nodeId,
          checkPort: portEntry.port,
          protocol: portEntry.protocol,
        });
      } catch (error) {
        throw createServiceError(
          "ENDPOINT_AGENT_UNAVAILABLE",
          `Network inventory is unavailable for node ${nodeId}.`,
          { nodeId, causeCode: error?.code || null },
        );
      }
      if (!inventory || typeof inventory !== "object") {
        result.reason = "inventory-unavailable";
        result.state = "unknown";
        result.skipped.push({ reason: "inventory-unavailable", port: portEntry.port });
        return result;
      }
      if (inventory.supported === false) {
        result.reason = "inventory-unsupported";
        result.state = "unsupported";
        return result;
      }
      result.inventoryAvailable = true;
      const specs = buildAgentSpecsForPort(inventory, portEntry, context);
      applyDiscoveredSpecs(specs, context);
    }
    result.stale = collectStaleDiscovered(context);
    return finalizeDiscoveryState(result);
  }

  return {
    listEndpoints,
    getEndpoint,
    getEndpointSummary,
    createEndpoint,
    updateEndpoint,
    deleteEndpoint,
    setEndpointEnabled,
    associateEndpoint,
    upsertProviderEndpoint,
    recordProviderSync,
    getProviderSyncs,
    resolveServiceEndpoints,
    discoverEndpoints,
  };
}

let defaultService = null;

function getDefaultEndpointService() {
  if (!defaultService) defaultService = createEndpointService({});
  return defaultService;
}

function listEndpoints(filter) {
  return getDefaultEndpointService().listEndpoints(filter);
}

function getEndpointSummary(options) {
  return getDefaultEndpointService().getEndpointSummary(options);
}

function getEndpoint(id) {
  return getDefaultEndpointService().getEndpoint(id);
}

function createEndpoint(input) {
  return getDefaultEndpointService().createEndpoint(input);
}

function updateEndpoint(id, patch) {
  return getDefaultEndpointService().updateEndpoint(id, patch);
}

function deleteEndpoint(id) {
  return getDefaultEndpointService().deleteEndpoint(id);
}

function setEndpointEnabled(id, enabled) {
  return getDefaultEndpointService().setEndpointEnabled(id, enabled);
}

function associateEndpoint(payload) {
  return getDefaultEndpointService().associateEndpoint(payload);
}

function upsertProviderEndpoint(payload) {
  return getDefaultEndpointService().upsertProviderEndpoint(payload);
}

function recordProviderSync(nodeId, patch) {
  return getDefaultEndpointService().recordProviderSync(nodeId, patch);
}

function resolveServiceEndpoints(options) {
  return getDefaultEndpointService().resolveServiceEndpoints(options);
}

function discoverEndpoints(options) {
  return getDefaultEndpointService().discoverEndpoints(options);
}

function getProviderSyncs() {
  return getDefaultEndpointService().getProviderSyncs();
}

module.exports = {
  createEndpointService,
  getDefaultEndpointService,
  listEndpoints,
  getEndpoint,
  getEndpointSummary,
  createEndpoint,
  updateEndpoint,
  deleteEndpoint,
  setEndpointEnabled,
  associateEndpoint,
  upsertProviderEndpoint,
  recordProviderSync,
  getProviderSyncs,
  resolveServiceEndpoints,
  discoverEndpoints,
  _test: {
    defaultDeps,
    defaultProbeLocalListeners,
    probeTcpPort,
    extractServicePorts,
    classifyDiscoveredAddress,
    isCgnatIpv4,
    buildDiscoveredName,
    DISCOVERY_SCOPES,
  },
};
