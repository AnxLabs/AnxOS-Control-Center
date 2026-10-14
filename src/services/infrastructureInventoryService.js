"use strict";

// AIM-1 infrastructure discovery and inventory (docs/v2/V2_AUTONOMOUS_INFRASTRUCTURE_PLAN.md,
// revision 3.1 AIM-1; revision 3.2 addendum A7).
//
// Desktop-side composition over EXISTING read-only Agent routes, so already
// deployed Agents are inventoried without any upgrade or service change.
//
// Contract:
// - Read-only. Every Agent request goes through `guardedRead`, which refuses
//   anything that is not a GET on an allow-listed inventory route. This service
//   never starts, stops, restarts, edits or deletes anything, and (unlike
//   fleetService's refresh) never writes the node registry.
// - Bounded. Node fan-out is limited by INVENTORY_CONCURRENCY; inspect calls by
//   LIMITS.maxInspectsPerNode; every request has a timeout; resources per node
//   and listeners per node are capped and truncation is reported.
// - Honest. A node that cannot be reached keeps its last-known resources,
//   marked stale with the reason. Sections that fail (Docker absent, permission
//   denied) are reported per section instead of as empty lists.
// - Single-flight. Concurrent refreshes share one run.
// - Persistent. The snapshot is written atomically (temp file + rename) with a
//   schema version; a corrupt store is quarantined once and a store from a
//   newer build is refused without being overwritten. After a desktop restart
//   every persisted resource is shown as stale until the next refresh.
// - Protected by default. Unclassified resources are `production` (D4).

const fs = require("fs");
const path = require("path");
const model = require("../shared/infraInventoryModel");
const { redactString } = require("../shared/redaction");

const INVENTORY_STORE_FILE = "infrastructure-inventory.json";
const INVENTORY_CONCURRENCY = 2;
const INSPECT_CONCURRENCY = 2;
const READ_TIMEOUT_MS = 8000;
const DOCKER_LIST_TIMEOUT_MS = 15000;
const MIN_REFRESH_INTERVAL_MS = 10000;
// Resources of a node that is no longer registered are kept (stale) for a week
// so a temporarily removed node does not lose its history, then pruned.
const UNREGISTERED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TOTAL_RESOURCES = 20000;
// States whose live reads would only fail; skip and say why (fleetService).
const SKIP_CONNECTION_STATES = new Set(["offline", "authentication_failed", "agent_incompatible"]);

// Exact read routes this service may call. Anything else is refused before a
// request is made.
const READ_ROUTE_ALLOWLIST = Object.freeze([
  /^\/api\/v1\/health$/,
  /^\/api\/v1\/system\/summary$/,
  /^\/api\/v1\/network\/inventory$/,
  /^\/api\/v1\/instances$/,
  /^\/api\/v1\/docker\/containers$/,
  /^\/api\/v1\/docker\/volumes$/,
  /^\/api\/v1\/docker\/networks$/,
  /^\/api\/v1\/docker\/compose\/projects$/,
  /^\/api\/v1\/docker\/containers\/[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\/inspect$/,
  /^\/api\/v1\/docker\/volumes\/[A-Za-z0-9][A-Za-z0-9_.-]{0,254}\/inspect$/,
]);

class InventoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "InventoryError";
    this.code = code;
  }
}

const overrides = {
  storePath: null,
  now: null,
  reader: null,
  nodes: null,
  agentConfigFor: null,
  persist: true,
  // Test seam for the quarantine rename path (simulates a locked file).
  renameSync: null,
};

let state = null; // { snapshot, loaded, quarantine }
let inFlight = null;
let lastCompletedAt = 0;

function configureInfrastructureInventory(next = {}) {
  for (const key of Object.keys(overrides)) {
    if (Object.prototype.hasOwnProperty.call(next, key)) overrides[key] = next[key];
  }
}

// `keepStore: true` simulates a desktop restart: memory is dropped, the store on
// disk is kept and reloaded on next access.
function resetInfrastructureInventory(options = {}) {
  state = null;
  inFlight = null;
  lastCompletedAt = 0;
  if (options.keepStore !== true) {
    overrides.storePath = null;
    overrides.now = null;
    overrides.reader = null;
    overrides.nodes = null;
    overrides.agentConfigFor = null;
    overrides.persist = true;
    overrides.renameSync = null;
  }
}

function nowMs() {
  return typeof overrides.now === "function" ? overrides.now() : Date.now();
}

function nowIso() {
  return new Date(nowMs()).toISOString();
}

function resolveConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) return process.env.ANXHUB_CONFIG_DIR;
  try {
    const electron = require("electron");
    const app = electron && electron.app;
    if (app && typeof app.getPath === "function") return path.join(app.getPath("userData"), "config");
  } catch {}
  return path.join(process.cwd(), "config");
}

function resolveStorePath() {
  if (overrides.storePath) return overrides.storePath;
  if (process.env.ANXOS_INVENTORY_STORE) return process.env.ANXOS_INVENTORY_STORE;
  return path.join(resolveConfigDirectory(), INVENTORY_STORE_FILE);
}

function emptySnapshot() {
  return {
    schemaVersion: model.INVENTORY_SCHEMA_VERSION,
    generatedAt: null,
    lastRefresh: null,
    nodes: [],
    resources: [],
    // Reserved for Owner-confirmed classifications (AIM-0); AIM-1 never writes it.
    classifications: {},
  };
}

function safeMessage(value, fallback) {
  const message = redactString(String(value || fallback || "")).slice(0, 300);
  return message || fallback || null;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function renameFile(from, to) {
  return (overrides.renameSync || fs.renameSync)(from, to);
}

// An existing quarantined copy with exactly these bytes, if any. Used so a
// store that cannot leave the active path is copied once, not once per restart.
function findIdenticalQuarantine(target, bytes) {
  const dir = path.dirname(target);
  const prefix = `${path.basename(target)}.corrupt-`;
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => name.startsWith(prefix)); } catch { return null; }
  for (const name of names) {
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && stat.size === bytes.length && fs.readFileSync(candidate).equals(bytes)) return candidate;
    } catch {}
  }
  return null;
}

// Moves the unusable store out of the active path so the next load finds no
// store and starts clean: one quarantine per corruption, not one per restart.
// The file is renamed (never deleted), so it stays recoverable.
//   - Rename blocked (e.g. a Windows lock): keep a copy, then replace the
//     active path with an empty valid store.
//   - Replacement also blocked, or no copy possible: the corrupt file stays
//     at the active path untouched and the session runs read-only (nothing is
//     written over it). A byte-identical earlier copy is reused, so repeated
//     restarts do not accumulate copies.
function quarantine(target, code) {
  let quarantinePath = `${target}.corrupt-${nowMs()}`;
  for (let suffix = 1; fs.existsSync(quarantinePath); suffix += 1) {
    quarantinePath = `${target}.corrupt-${nowMs()}-${suffix}`;
  }
  try {
    renameFile(target, quarantinePath);
    return { path: quarantinePath, code, method: "moved" };
  } catch {}
  let bytes = null;
  try { bytes = fs.readFileSync(target); } catch {}
  const existingCopy = bytes ? findIdenticalQuarantine(target, bytes) : null;
  if (existingCopy) {
    quarantinePath = existingCopy;
  } else {
    try {
      fs.copyFileSync(target, quarantinePath, fs.constants.COPYFILE_EXCL);
    } catch {
      return { path: null, code, method: "unmovable", readOnly: true };
    }
  }
  try {
    const temp = `${target}.${process.pid}.${nowMs()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(emptySnapshot(), null, 2)}\n`, { mode: 0o600 });
    try {
      renameFile(temp, target);
    } catch (error) {
      try { fs.unlinkSync(temp); } catch {}
      throw error;
    }
  } catch {
    return { path: quarantinePath, code, method: "copied-not-replaced", readOnly: true };
  }
  return { path: quarantinePath, code, method: "copied" };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidStoredResource(resource) {
  return isPlainObject(resource)
    && typeof resource.key === "string" && resource.key.length > 0
    && model.RESOURCE_KINDS.includes(resource.kind)
    && typeof resource.nodeId === "string"
    && (resource.nodeIds === undefined || (Array.isArray(resource.nodeIds) && resource.nodeIds.every((id) => typeof id === "string")))
    && (resource.identity === undefined || isPlainObject(resource.identity))
    && (resource.health === undefined || isPlainObject(resource.health));
}

function isValidStoredNode(node) {
  return isPlainObject(node) && typeof node.nodeId === "string" && node.nodeId.length > 0
    && (node.sections === undefined || Array.isArray(node.sections));
}

function loadStore() {
  if (state?.loaded) return state;
  const target = resolveStorePath();
  state = { snapshot: emptySnapshot(), loaded: true, quarantine: null, readOnly: false };
  if (!fs.existsSync(target)) return state;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    state.quarantine = quarantine(target, error?.code || "INVALID_JSON");
    if (state.quarantine.readOnly) state.readOnly = true;
    return state;
  }
  const schemaVersion = Number.isInteger(raw?.schemaVersion) ? raw.schemaVersion : 0;
  if (schemaVersion > model.INVENTORY_SCHEMA_VERSION) {
    // Written by a newer build: never overwrite it. Inventory runs in memory
    // only until the operator resolves the version mismatch.
    state.readOnly = true;
    state.quarantine = { path: null, code: "INVENTORY_STORE_SCHEMA_UNSUPPORTED" };
    return state;
  }
  if (schemaVersion < 1 || !Array.isArray(raw.resources) || !Array.isArray(raw.nodes)
    || !raw.resources.every(isValidStoredResource) || !raw.nodes.every(isValidStoredNode)
    || (raw.classifications !== undefined && (raw.classifications === null || typeof raw.classifications !== "object" || Array.isArray(raw.classifications)))) {
    // Valid JSON with a malformed structure is treated exactly like a corrupt
    // file: quarantined once, inventory restarts empty, IPC stays usable.
    state.quarantine = quarantine(target, "INVENTORY_STORE_INVALID");
    if (state.quarantine.readOnly) state.readOnly = true;
    return state;
  }
  // Restart recovery: persisted data is last-known, not current.
  state.snapshot = {
    ...emptySnapshot(),
    ...raw,
    resources: model.markAllStale(raw.resources.slice(0, MAX_TOTAL_RESOURCES), "NOT_REFRESHED_SINCE_RESTART"),
    nodes: raw.nodes.map((node) => ({ ...node, fromPreviousSession: true })),
    classifications: raw.classifications && typeof raw.classifications === "object" ? raw.classifications : {},
  };
  return state;
}

function persist(snapshot) {
  if (overrides.persist === false || state?.readOnly) return;
  const target = resolveStorePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${nowMs()}.tmp`;
  const stored = {
    ...snapshot,
    nodes: snapshot.nodes.map(({ fromPreviousSession, ...node }) => node),
  };
  fs.writeFileSync(temp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
function defaultReader() {
  const agentClient = require("./agentClient");
  return (pathname, options) => agentClient.requestJson(pathname, options);
}

function defaultNodes() {
  return require("./nodeService").getAllNodesSync();
}

function defaultAgentConfigFor(nodeId) {
  return require("./nodeService").getNodeAgentConfig(nodeId);
}

function assertReadRoute(method, pathname) {
  if (String(method || "GET").toUpperCase() !== "GET") {
    throw new InventoryError("INVENTORY_ROUTE_NOT_ALLOWED", "Inventory may only issue GET requests.");
  }
  if (!READ_ROUTE_ALLOWLIST.some((pattern) => pattern.test(pathname))) {
    throw new InventoryError("INVENTORY_ROUTE_NOT_ALLOWED", `Inventory may not call ${pathname}.`);
  }
}

function createGuardedRead(config) {
  const reader = overrides.reader || defaultReader();
  return async (pathname, timeoutMs = READ_TIMEOUT_MS) => {
    assertReadRoute("GET", pathname);
    return reader(pathname, {
      method: "GET",
      config,
      timeoutMs,
      suppressConnectionRefusedLog: true,
      logThrottleMs: 60000,
    });
  };
}

function classifyReadError(error) {
  const status = error?.status || error?.statusCode || error?.payload?.error?.status || null;
  const code = String(error?.code || error?.payload?.error?.code || "").toUpperCase();
  if (status === 401 || code === "AGENT_AUTH_FAILED" || code === "UNAUTHORIZED" || code === "AUTHENTICATION_FAILED") return "AUTH_FAILED";
  if (status === 403 || code === "FORBIDDEN" || code === "PERMISSION_DENIED" || code === "POLICY_DENIED") return "PERMISSION_DENIED";
  if (status === 404 || status === 405) return "ROUTE_NOT_SUPPORTED";
  if (code === "INVENTORY_ROUTE_NOT_ALLOWED") return code;
  return code || "READ_FAILED";
}

async function runWithConcurrency(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function readSection(sections, name, run) {
  try {
    const value = await run();
    sections.push({ name, status: "ok", code: null });
    return value;
  } catch (error) {
    sections.push({ name, status: "unavailable", code: classifyReadError(error), message: safeMessage(error?.message, "Read failed.") });
    return null;
  }
}

function firstInspect(payload) {
  const list = Array.isArray(payload?.inspect) ? payload.inspect : null;
  return list && list[0] && typeof list[0] === "object" ? list[0] : null;
}

async function collectNode(node) {
  const config = (overrides.agentConfigFor || defaultAgentConfigFor)(node.id);
  const read = createGuardedRead(config);
  const sections = [];

  let health;
  try {
    health = await read("/api/v1/health");
  } catch (error) {
    const httpStatus = error?.status || error?.statusCode || error?.payload?.error?.status || null;
    // No HTTP response at all (refused, timeout, DNS, TLS): one stable code,
    // with the transport detail kept as the cause.
    const code = httpStatus ? classifyReadError(error) : "NODE_UNREACHABLE";
    return {
      nodeId: node.id,
      ok: false,
      code,
      cause: String(error?.code || "").slice(0, 60) || null,
      message: safeMessage(error?.message, "The Agent did not answer the health check."),
      sections,
    };
  }
  sections.push({ name: "health", status: "ok", code: null });

  const hostIdentity = model.buildHostIdentity(health?.identity, node.agentIdentity || null);
  const ctx = {
    nodeId: node.id,
    nodeName: node.displayName || node.name || node.id,
    hostIdentity,
    hostKey: hostIdentity.key,
    hostVerified: hostIdentity.verified,
  };

  if (hostIdentity.reason === "AGENT_IDENTITY_MISMATCH") {
    // The URL now answers as a different device than the one registered. Do
    // not attribute anything to this node until the operator re-pairs it.
    return {
      nodeId: node.id,
      ok: false,
      code: "AGENT_IDENTITY_MISMATCH",
      message: "The Agent at this address reports a different device than the one registered for this node. Re-pair the node.",
      sections,
    };
  }

  const summary = await readSection(sections, "system", () => read("/api/v1/system/summary"));
  const instancesPayload = await readSection(sections, "instances", () => read("/api/v1/instances"));
  const networkPayload = await readSection(sections, "listeners", () => read("/api/v1/network/inventory"));

  const resources = [model.buildHostResource(ctx, health, summary)];
  // Only a host that supports service-managed instances has a meaningful
  // allow-list; elsewhere the allow-list judgment is not applicable (null).
  const serviceManagedCapability = health?.capabilities?.serviceManagedInstances;
  const allowedUnits = serviceManagedCapability?.supported === true && Array.isArray(serviceManagedCapability.allowedUnits) ? serviceManagedCapability.allowedUnits : null;
  for (const instance of Array.isArray(instancesPayload?.instances) ? instancesPayload.instances : []) {
    resources.push(model.buildInstanceResource(ctx, instance, allowedUnits));
  }

  let listenersTruncated = Boolean(networkPayload?.listenersTruncated);
  const listeners = Array.isArray(networkPayload?.listeners) ? networkPayload.listeners : [];
  if (listeners.length > model.LIMITS.maxListenersPerNode) listenersTruncated = true;
  for (const listener of listeners.slice(0, model.LIMITS.maxListenersPerNode)) {
    resources.push(model.buildListenerResource(ctx, listener));
  }

  // Docker: skipped honestly when the host reports Docker unavailable.
  const containersPayload = await readSection(sections, "docker", () => read("/api/v1/docker/containers", DOCKER_LIST_TIMEOUT_MS));
  let dockerAvailable = Boolean(containersPayload && containersPayload.installed !== false && containersPayload.daemonRunning !== false);
  if (containersPayload && !dockerAvailable) {
    const section = sections.find((entry) => entry.name === "docker");
    section.status = "unavailable";
    section.code = containersPayload.installed === false ? "DOCKER_NOT_INSTALLED" : "DOCKER_DAEMON_UNAVAILABLE";
    section.message = safeMessage(containersPayload.message, "Docker is not available on this host.");
  }

  let inspectBudget = model.LIMITS.maxInspectsPerNode;
  let inspectsSkipped = 0;
  const takeBudget = () => {
    if (inspectBudget <= 0) { inspectsSkipped += 1; return false; }
    inspectBudget -= 1;
    return true;
  };

  if (dockerAvailable) {
    const containers = Array.isArray(containersPayload.containers) ? containersPayload.containers : [];
    const inspected = await runWithConcurrency(containers, INSPECT_CONCURRENCY, async (container) => {
      const id = String(container?.id || "");
      if (!id || !takeBudget()) return null;
      try { return firstInspect(await read(`/api/v1/docker/containers/${encodeURIComponent(id)}/inspect`)); } catch { return null; }
    });
    containers.forEach((container, index) => resources.push(model.buildContainerResource(ctx, container, inspected[index])));

    const volumesPayload = await readSection(sections, "volumes", () => read("/api/v1/docker/volumes", DOCKER_LIST_TIMEOUT_MS));
    const volumes = Array.isArray(volumesPayload?.volumes) ? volumesPayload.volumes : [];
    const volumeInspects = await runWithConcurrency(volumes, INSPECT_CONCURRENCY, async (volume) => {
      const name = String(volume?.name || "");
      if (!name || !takeBudget()) return null;
      try { return firstInspect(await read(`/api/v1/docker/volumes/${encodeURIComponent(name)}/inspect`)); } catch { return null; }
    });
    volumes.forEach((volume, index) => resources.push(model.buildVolumeResource(ctx, volume, volumeInspects[index])));

    const networksPayload = await readSection(sections, "networks", () => read("/api/v1/docker/networks", DOCKER_LIST_TIMEOUT_MS));
    for (const network of Array.isArray(networksPayload?.networks) ? networksPayload.networks : []) {
      resources.push(model.buildNetworkResource(ctx, network));
    }
    const composePayload = await readSection(sections, "compose", () => read("/api/v1/docker/compose/projects", DOCKER_LIST_TIMEOUT_MS));
    for (const project of Array.isArray(composePayload?.projects) ? composePayload.projects : []) {
      resources.push(model.buildComposeProjectResource(ctx, project));
    }
  }

  // Kinds whose source section was not read this time; their previous
  // resources are kept as stale by mergeNodeCollection instead of vanishing.
  const sectionCode = (name) => sections.find((entry) => entry.name === name && entry.status !== "ok")?.code || null;
  const unreadKinds = {};
  const markUnread = (kinds, code) => { if (code) kinds.forEach((kind) => { unreadKinds[kind] = code; }); };
  markUnread(["instance", "service-managed-instance"], sectionCode("instances"));
  markUnread(["listener"], sectionCode("listeners"));
  const dockerCode = sectionCode("docker");
  markUnread(["container", "volume", "network", "compose-project"], dockerCode);
  if (!dockerCode) {
    markUnread(["volume"], sectionCode("volumes"));
    markUnread(["network"], sectionCode("networks"));
    markUnread(["compose-project"], sectionCode("compose"));
  }

  let deduped = model.dedupeResources(resources.filter(Boolean));
  const truncated = deduped.length > model.LIMITS.maxResourcesPerNode;
  if (truncated) deduped = deduped.slice(0, model.LIMITS.maxResourcesPerNode);

  return {
    nodeId: node.id,
    ok: true,
    code: null,
    hostKey: hostIdentity.key,
    hostVerified: hostIdentity.verified,
    hostIdentityReason: hostIdentity.reason,
    sections,
    resources: deduped,
    unreadKinds,
    limits: { truncated, listenersTruncated, inspectsSkipped },
  };
}

// ---------------------------------------------------------------------------
// Refresh orchestration
// ---------------------------------------------------------------------------
function skipReason(node) {
  if (node.kind === "application-host") return { code: "APPLICATION_HOST_NOT_AGENT", message: "This desktop is the application host; inventory comes from registered Agent nodes (including the local Agent)." };
  if (node.kind !== "agent") return { code: "NODE_KIND_UNSUPPORTED", message: "Only Agent nodes are inventoried." };
  if (node.enabled === false) return { code: "NODE_DISABLED", message: "Node is disabled." };
  if (node.manualDisconnect === true) return { code: "NODE_DISCONNECTED", message: "Node is manually disconnected; reconnect it to inventory it." };
  const status = String(node.connection?.status || node.lastConnectionState || "").toLowerCase();
  if (SKIP_CONNECTION_STATES.has(status)) return { code: `NODE_${status.toUpperCase()}`, message: `Node connection is ${status}; live inventory was not queried.` };
  return null;
}

function nodeRecord(node, previous, patch) {
  return {
    nodeId: node.id,
    name: String(node.displayName || node.name || node.id).slice(0, 200),
    kind: node.kind || "unknown",
    lastAttemptAt: patch.lastAttemptAt || previous?.lastAttemptAt || null,
    lastSuccessAt: patch.lastSuccessAt || previous?.lastSuccessAt || null,
    status: patch.status,
    code: patch.code || null,
    message: patch.message || null,
    hostKey: patch.hostKey || previous?.hostKey || null,
    hostVerified: patch.hostVerified ?? previous?.hostVerified ?? false,
    sections: patch.sections || [],
    limits: patch.limits || null,
  };
}

async function runRefresh() {
  const { snapshot } = loadStore();
  const startedMs = nowMs();
  const startedAt = new Date(startedMs).toISOString();
  const nodes = (overrides.nodes ? overrides.nodes() : defaultNodes()) || [];
  const previousNodes = new Map(snapshot.nodes.map((node) => [node.nodeId, node]));

  const outcomes = await runWithConcurrency(nodes, INVENTORY_CONCURRENCY, async (node) => {
    const skip = skipReason(node);
    if (skip) return { node, collection: { nodeId: node.id, ok: false, code: skip.code, message: skip.message, sections: [] }, skipped: true };
    try {
      return { node, collection: await collectNode(node), skipped: false };
    } catch (error) {
      return { node, collection: { nodeId: node.id, ok: false, code: error?.code || "NODE_CONFIG_UNAVAILABLE", message: safeMessage(error?.message, "Node credentials are unavailable."), sections: [] }, skipped: false };
    }
  });

  const at = nowIso();
  let resources = snapshot.resources;
  const nodeRecords = [];
  for (const { node, collection, skipped } of outcomes) {
    resources = model.mergeNodeCollection(resources, collection, at);
    const previous = previousNodes.get(node.id);
    nodeRecords.push(nodeRecord(node, previous, collection.ok
      ? { status: "collected", lastAttemptAt: at, lastSuccessAt: at, sections: collection.sections, hostKey: collection.hostKey, hostVerified: collection.hostVerified, code: collection.hostIdentityReason, limits: collection.limits }
      : { status: skipped ? "skipped" : "unavailable", lastAttemptAt: skipped ? previous?.lastAttemptAt : at, code: collection.code, message: collection.message, sections: collection.sections }));
  }

  // Nodes no longer registered: keep their resources as stale for the retention
  // window, then prune.
  const registered = new Set(nodes.map((node) => node.id));
  const cutoff = nowMs() - UNREGISTERED_RETENTION_MS;
  resources = resources
    .map((resource) => ((resource.nodeIds || [resource.nodeId]).some((id) => registered.has(id))
      ? resource
      : { ...resource, stale: true, staleReason: "NODE_NOT_REGISTERED" }))
    .filter((resource) => resource.staleReason !== "NODE_NOT_REGISTERED" || Date.parse(resource.lastSeen || 0) >= cutoff)
    .slice(0, MAX_TOTAL_RESOURCES)
    .map((resource) => model.applyProtection(resource, snapshot.classifications));

  const next = {
    ...snapshot,
    schemaVersion: model.INVENTORY_SCHEMA_VERSION,
    generatedAt: at,
    lastRefresh: { startedAt, completedAt: at, durationMs: nowMs() - startedMs },
    nodes: nodeRecords,
    resources,
  };
  state.snapshot = next;
  persist(next);
  lastCompletedAt = nowMs();
  return next;
}

function publicSnapshot(snapshot, extra = {}) {
  const { classifications, ...rest } = snapshot;
  return {
    ...rest,
    summary: model.summarize(snapshot.resources, snapshot.nodes),
    store: {
      quarantine: state?.quarantine || null,
      readOnly: state?.readOnly === true,
    },
    refreshing: Boolean(inFlight),
    ...extra,
  };
}

function getInventory() {
  const { snapshot } = loadStore();
  return publicSnapshot(snapshot);
}

async function refreshInventory(options = {}) {
  loadStore();
  if (inFlight) return publicSnapshot(await inFlight, { joined: true });
  if (options.force !== true && lastCompletedAt && nowMs() - lastCompletedAt < MIN_REFRESH_INTERVAL_MS) {
    return publicSnapshot(state.snapshot, { throttled: true });
  }
  inFlight = runRefresh();
  try {
    return publicSnapshot(await inFlight);
  } finally {
    inFlight = null;
  }
}

module.exports = {
  INVENTORY_STORE_FILE,
  READ_ROUTE_ALLOWLIST,
  MIN_REFRESH_INTERVAL_MS,
  UNREGISTERED_RETENTION_MS,
  InventoryError,
  assertReadRoute,
  configureInfrastructureInventory,
  resetInfrastructureInventory,
  getInventory,
  refreshInventory,
};
