// Servers across every computer (Build 213-B). Reads each registered
// computer's server list through the same per-computer route My Servers
// already uses (serviceRouter.listInstances with an explicit nodeId), a few
// computers at a time, and keeps a last-known copy so a computer that is
// offline still shows its servers, marked as last known, instead of losing
// them. Actions on several servers go one server at a time, each to its own
// computer by explicit nodeId; nothing is ever sent to "the selected
// computer" by accident.
//
// The cache holds names, ids, games and states only (no credentials, no
// paths), in <config>/server-fleet-cache.json.

const fs = require("fs");
const path = require("path");

const CACHE_FILENAME = "server-fleet-cache.json";
const CONCURRENCY = 4;
const FLEET_ACTIONS = new Set(["start", "stop", "restart"]);
const MAX_ACTION_TARGETS = 25;

const STATE_GROUPS = {
  running: "running",
  online: "running",
  ready: "running",
  starting: "starting",
  restarting: "starting",
  reloading: "starting",
  stopping: "stopping",
  stopped: "stopped",
  idle: "stopped",
  failed: "crashed",
  crashed: "crashed",
  unhealthy: "crashed",
  "setup-required": "setup-required",
};

function normalizeServerState(state) {
  return STATE_GROUPS[String(state || "").trim().toLowerCase()] || "unknown";
}

function nodeLabel(node) {
  return node?.displayName || node?.name || node?.id || "Computer";
}

function summarizeServer(instance, node, { lastKnown, fetchedAt }) {
  const metrics = instance?.metrics || instance?.runtime?.metrics || null;
  const cpu = Number(metrics?.cpuPercent);
  const memory = Number(metrics?.memoryRssBytes);
  return {
    key: `${node.id}::${instance.id}`,
    nodeId: node.id,
    nodeName: nodeLabel(node),
    instanceId: String(instance.id),
    name: String(instance.displayName || instance.name || instance.id),
    game: String(instance.gameAdapter || instance.game || instance.templateId || instance.type || "") || null,
    state: lastKnown ? "last-known" : normalizeServerState(instance.state || instance.status),
    reportedState: normalizeServerState(instance.state || instance.status),
    failureReason: instance.failureReason || null,
    cpuPercent: !lastKnown && Number.isFinite(cpu) ? cpu : null,
    memoryBytes: !lastKnown && Number.isFinite(memory) ? memory : null,
    lastKnown,
    fetchedAt,
  };
}

function readCache(configDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, CACHE_FILENAME), "utf8"));
    return raw && typeof raw === "object" && raw.computers && typeof raw.computers === "object" ? raw : { computers: {} };
  } catch {
    return { computers: {} };
  }
}

function writeCache(configDir, cache) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const target = path.join(configDir, CACHE_FILENAME);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, target);
  } catch {
    // The cache only helps offline computers; failing to write it never fails the list.
  }
}

async function runWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

function isComputerOnline(node) {
  if (node.id === "application-host") return true;
  const status = String(node?.connection?.status || "").toLowerCase();
  return status === "online" || status === "degraded";
}

async function listServersAcrossComputers({ listNodes, listInstancesForNode, configDir, now = () => new Date().toISOString() }) {
  const nodes = (await listNodes()).filter((node) => node && node.id);
  const cache = readCache(configDir);
  const computers = await runWithConcurrency(nodes, CONCURRENCY, async (node) => {
    const cached = cache.computers[node.id] || null;
    if (!isComputerOnline(node)) {
      return { node, status: "offline", message: "This computer is not connected.", cached };
    }
    try {
      const response = await listInstancesForNode(node.id);
      const instances = Array.isArray(response) ? response : Array.isArray(response?.instances) ? response.instances : [];
      return { node, status: "online", instances, fetchedAt: now() };
    } catch (error) {
      return { node, status: "unavailable", message: error?.message || "The server list could not be read.", code: error?.code || null, cached };
    }
  });

  const servers = [];
  const summary = [];
  for (const entry of computers) {
    const { node } = entry;
    if (entry.status === "online") {
      const list = entry.instances.filter((instance) => instance && instance.id);
      cache.computers[node.id] = {
        name: nodeLabel(node),
        fetchedAt: entry.fetchedAt,
        servers: list.map((instance) => ({ id: String(instance.id), displayName: instance.displayName || instance.name || null, gameAdapter: instance.gameAdapter || instance.game || instance.templateId || instance.type || null, state: instance.state || instance.status || null })),
      };
      list.forEach((instance) => servers.push(summarizeServer(instance, node, { lastKnown: false, fetchedAt: entry.fetchedAt })));
      summary.push({ nodeId: node.id, name: nodeLabel(node), status: "online", serverCount: list.length, fetchedAt: entry.fetchedAt });
    } else {
      const cached = entry.cached;
      (cached?.servers || []).forEach((instance) => servers.push(summarizeServer(instance, node, { lastKnown: true, fetchedAt: cached.fetchedAt || null })));
      summary.push({ nodeId: node.id, name: nodeLabel(node), status: entry.status, message: entry.message, serverCount: cached?.servers?.length || 0, fetchedAt: cached?.fetchedAt || null, lastKnown: Boolean(cached) });
    }
  }
  // Forget cached computers that are no longer registered.
  const registered = new Set(nodes.map((node) => node.id));
  for (const nodeId of Object.keys(cache.computers)) if (!registered.has(nodeId)) delete cache.computers[nodeId];
  writeCache(configDir, cache);
  return { computers: summary, servers };
}

// Start / Stop / Restart several servers, possibly on several computers.
// Each target names its computer; a target on an offline computer, or one
// the caller may not control, is reported and skipped, never re-routed.
async function runServerFleetAction({ action, targets, confirm, listNodes, authorize, runAction }) {
  const verb = String(action || "").toLowerCase();
  if (!FLEET_ACTIONS.has(verb)) throw Object.assign(new Error('Action must be "start", "stop" or "restart".'), { code: "SERVER_FLEET_ACTION_INVALID" });
  if ((verb === "stop" || verb === "restart") && confirm !== true) {
    throw Object.assign(new Error("Confirm before stopping or restarting servers: players on them are disconnected."), { code: "SERVER_FLEET_CONFIRMATION_REQUIRED" });
  }
  const list = (Array.isArray(targets) ? targets : [])
    .map((target) => ({ nodeId: String(target?.nodeId || "").trim(), instanceId: String(target?.instanceId || "").trim() }))
    .filter((target) => target.nodeId && target.instanceId);
  const unique = [...new Map(list.map((target) => [`${target.nodeId}::${target.instanceId}`, target])).values()];
  if (!unique.length) throw Object.assign(new Error("Select at least one server."), { code: "SERVER_FLEET_TARGETS_REQUIRED" });
  if (unique.length > MAX_ACTION_TARGETS) throw Object.assign(new Error(`Up to ${MAX_ACTION_TARGETS} servers per action.`), { code: "SERVER_FLEET_TOO_MANY" });
  const nodes = new Map((await listNodes()).map((node) => [node.id, node]));
  const results = [];
  for (const target of unique) {
    const node = nodes.get(target.nodeId);
    if (!node) {
      results.push({ ...target, ok: false, code: "NODE_NOT_FOUND", message: "That computer is no longer registered." });
      continue;
    }
    if (!isComputerOnline(node)) {
      results.push({ ...target, nodeName: nodeLabel(node), ok: false, code: "NODE_OFFLINE", message: `${nodeLabel(node)} is not connected.` });
      continue;
    }
    try {
      authorize(target);
      await runAction(verb, target);
      results.push({ ...target, nodeName: nodeLabel(node), ok: true });
    } catch (error) {
      results.push({ ...target, nodeName: nodeLabel(node), ok: false, code: error?.code || "SERVER_ACTION_FAILED", message: error?.message || String(error) });
    }
  }
  return { action: verb, ok: results.every((result) => result.ok), succeeded: results.filter((result) => result.ok).length, failed: results.filter((result) => !result.ok).length, results };
}

module.exports = {
  CACHE_FILENAME,
  listServersAcrossComputers,
  normalizeServerState,
  runServerFleetAction,
};
