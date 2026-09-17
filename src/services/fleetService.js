// V2-G Wave 2 fleet aggregation (docs/MASTER_ROADMAP.md bullets 3 and 6).
//
// Desktop-side read-only roll-up across every registered node plus controlled
// cross-node batch actions. The fleet service never introduces new Agent
// endpoints: per-node connection/health state comes from the registry the
// desktop already polls (nodeService health checks), and per-node instance/job
// counts reuse the Agent's existing read-only /api/v1/instances and /api/v1/jobs
// queries with the node's own credential. Job records stay owned by the
// executing node, so a node that cannot be reached reports its inventory as
// unavailable instead of inventing totals.
const agentClient = require("./agentClient");
const {
  APPLICATION_HOST_NODE_ID,
  checkNodeHealth,
  disconnectNode,
  getAllNodesSync,
  getNode,
  getNodeAgentConfig,
  reconnectNode,
} = require("./nodeService");

// One bound for every fleet fan-out (summary probes and batch actions) so a
// large registry can never open an unbounded number of concurrent Agent
// requests.
const FLEET_CONCURRENCY_LIMIT = 3;
const FLEET_QUERY_TIMEOUT_MS = 5000;
const FLEET_JOB_SAMPLE_LIMIT = 100;
const FLEET_BATCH_MAX_TARGETS = 100;

const FLEET_ACTIONS = new Set(["start", "stop"]);
const REACHABLE_BATCH_STATES = new Set(["online", "degraded"]);
// States whose live inventory queries would only ever fail: the connection
// itself is down, rejected, or incompatible, so skip the request and say why.
const LIVE_QUERY_CONNECTION_STATES = new Set(["online", "degraded"]);

class FleetBatchError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = "FleetBatchError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// Runs async tasks with at most `limit` in flight, preserving input order in
// the results. Tasks are expected to resolve (callers wrap their own errors);
// a rejecting task rejects the whole run.
async function runWithConcurrency(tasks, limit) {
  const boundedLimit = Math.max(1, Number(limit) || 1);
  const results = new Array(tasks.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(boundedLimit, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeConnectionStatus(node) {
  const status = String(node.connection?.status || node.lastConnectionState || "").toLowerCase();
  return status || "unknown";
}

function fleetStateCode(state) {
  return `NODE_${String(state || "unknown").toUpperCase().replace(/-/g, "_")}`;
}

function summarizeConnection(node) {
  if (node.kind === "application-host") {
    // The application host is the desktop itself; if this aggregation is
    // running, the host is up. Mirrors the connection publicNode fabricates.
    return {
      status: "online",
      displayStatus: "Online",
      connected: true,
      manualDisconnect: false,
      lastSeen: new Date().toISOString(),
    };
  }
  return {
    status: normalizeConnectionStatus(node),
    displayStatus: node.connection?.displayStatus || node.lastConnectionState || "Unknown",
    connected: node.connection?.connected === true,
    manualDisconnect: node.manualDisconnect === true,
    lastSeen: node.connection?.lastSeen || node.lastSuccessfulHealthCheck || null,
  };
}

function unavailableInventory(code, message) {
  return {
    available: false,
    code,
    message,
    instanceCount: null,
    runningInstanceCount: null,
    jobs: null,
  };
}

function summarizeInstances(instancesResponse) {
  const instances = Array.isArray(instancesResponse?.instances) ? instancesResponse.instances : [];
  const running = instances.filter((instance) => instance?.processRunning === true).length;
  return {
    available: true,
    instanceCount: instances.length,
    runningInstanceCount: running,
  };
}

function summarizeJobs(jobsResponse) {
  const jobs = Array.isArray(jobsResponse?.jobs) ? jobsResponse.jobs : [];
  const byState = {};
  for (const job of jobs) {
    const state = String(job?.state || "unknown");
    byState[state] = (byState[state] || 0) + 1;
  }
  return {
    available: true,
    sampled: jobs.length,
    total: Number.isFinite(Number(jobsResponse?.total)) ? Number(jobsResponse.total) : jobs.length,
    byState,
  };
}

const FLEET_READ_OPTIONS = { suppressConnectionRefusedLog: true, logThrottleMs: 60000 };

async function collectNodeInventory(config) {
  // Sequential inside the node task so the fleet-wide fan-out stays at the
  // shared concurrency bound (each node holds one request slot at a time).
  try {
    const instancesResponse = await agentClient.listInstances(config, { ...FLEET_READ_OPTIONS, timeoutMs: FLEET_QUERY_TIMEOUT_MS });
    const instances = summarizeInstances(instancesResponse);
    let jobs = null;
    try {
      jobs = summarizeJobs(await agentClient.listJobs(config, { ...FLEET_READ_OPTIONS, limit: FLEET_JOB_SAMPLE_LIMIT, timeoutMs: FLEET_QUERY_TIMEOUT_MS }));
    } catch (error) {
      jobs = { available: false, code: error?.code || "JOB_QUERY_FAILED", message: error?.message || "Job records are unavailable for this node." };
    }
    return { available: true, ...instances, jobs };
  } catch (error) {
    return unavailableInventory(
      error?.code || "INSTANCE_QUERY_FAILED",
      error?.message || "Instance inventory is unavailable for this node.",
    );
  }
}

function buildFleetEntry(node, inventory) {
  const connection = summarizeConnection(node);
  return {
    nodeId: node.id,
    displayName: node.displayName || node.name || node.id,
    kind: node.kind,
    group: node.kind === "agent" ? String(node.group || "") : "",
    enabled: node.enabled !== false,
    connection,
    instances: inventory?.available ? {
      available: true,
      instanceCount: inventory.instanceCount,
      runningInstanceCount: inventory.runningInstanceCount,
    } : {
      available: false,
      code: inventory?.code || "INVENTORY_UNAVAILABLE",
      message: inventory?.message || "Instance inventory is unavailable for this node.",
    },
    jobs: inventory?.jobs?.available ? {
      available: true,
      sampled: inventory.jobs.sampled,
      total: inventory.jobs.total,
      byState: inventory.jobs.byState,
    } : {
      available: false,
      code: inventory?.jobs?.code || inventory?.code || "JOBS_UNAVAILABLE",
      message: inventory?.jobs?.message || inventory?.message || "Job records are unavailable for this node.",
    },
    checkedAt: new Date().toISOString(),
  };
}

async function buildAgentFleetEntry(node) {
  const status = normalizeConnectionStatus(node);
  const canQueryLive = node.enabled !== false
    && node.manualDisconnect !== true
    && LIVE_QUERY_CONNECTION_STATES.has(status);
  let inventory;
  if (!canQueryLive) {
    inventory = unavailableInventory(
      node.enabled === false ? "NODE_DISABLED" : fleetStateCode(node.manualDisconnect === true ? "disconnected" : status),
      node.enabled === false
        ? "Node is disabled."
        : node.manualDisconnect === true
          ? "Node is manually disconnected; reconnect it to aggregate inventory."
          : "Node connection is not online; live inventory was not queried.",
    );
  } else {
    // Node credentials live in the protected per-node credential store, so the
    // request config must go through nodeService's resolver; an unlock or
    // lookup failure degrades this node's inventory instead of the whole fleet.
    try {
      inventory = await collectNodeInventory(getNodeAgentConfig(node.id));
    } catch (error) {
      inventory = unavailableInventory(
        error?.code || "NODE_CONFIG_UNAVAILABLE",
        error?.message || "Node credentials are unavailable; live inventory was not queried.",
      );
    }
  }
  return buildFleetEntry(node, inventory);
}

function buildApplicationHostFleetEntry(node) {
  return buildFleetEntry(node, unavailableInventory(
    "APPLICATION_HOST_NOT_AGENT",
    "The application host is this desktop; live fleet inventory applies to Agent nodes.",
  ));
}

function addByState(totals, byState) {
  for (const [state, count] of Object.entries(byState || {})) {
    totals[state] = (totals[state] || 0) + count;
  }
}

function buildFleetTotals(entries) {
  const totals = {
    nodes: entries.length,
    agents: entries.filter((entry) => entry.kind === "agent").length,
    applicationHosts: entries.filter((entry) => entry.kind === "application-host").length,
    online: 0,
    offline: 0,
    degraded: 0,
    authenticationFailed: 0,
    agentIncompatible: 0,
    connecting: 0,
    unknown: 0,
    disabled: 0,
    manuallyDisconnected: 0,
    instanceCount: 0,
    runningInstanceCount: 0,
    inventoryAvailableNodes: 0,
    inventoryUnavailableNodes: 0,
    jobs: {},
    jobsAvailableNodes: 0,
    jobsUnavailableNodes: 0,
  };
  for (const entry of entries) {
    if (entry.enabled === false) totals.disabled += 1;
    const status = entry.connection.status;
    if (status === "online") totals.online += 1;
    else if (status === "offline") totals.offline += 1;
    else if (status === "degraded") totals.degraded += 1;
    else if (status === "authentication_failed") totals.authenticationFailed += 1;
    else if (status === "agent_incompatible") totals.agentIncompatible += 1;
    else if (status === "connecting") totals.connecting += 1;
    else totals.unknown += 1;
    if (entry.connection.manualDisconnect === true) totals.manuallyDisconnected += 1;
    if (entry.instances.available) {
      totals.inventoryAvailableNodes += 1;
      totals.instanceCount += entry.instances.instanceCount || 0;
      totals.runningInstanceCount += entry.instances.runningInstanceCount || 0;
    } else {
      totals.inventoryUnavailableNodes += 1;
    }
    if (entry.jobs.available) {
      totals.jobsAvailableNodes += 1;
      addByState(totals.jobs, entry.jobs.byState);
    } else {
      totals.jobsUnavailableNodes += 1;
    }
  }
  return totals;
}

// Read-only fleet roll-up. Phase 1 refreshes each Agent node's connection
// state with the desktop's existing per-node health check (the same check the
// node registry polling runs), so the roll-up reflects current reachability
// instead of a stale snapshot; a failed probe keeps the node's last recorded
// state and the roll-up reports it honestly. Phase 2 aggregates registry
// connection state plus best-effort live instance/job counts for Agent nodes
// the desktop can currently reach. Every fan-out respects the shared bound.
async function getFleetSummary(options = {}) {
  const limit = Number(options.concurrencyLimit) || FLEET_CONCURRENCY_LIMIT;
  const agentNodes = getAllNodesSync().filter((node) => node.kind === "agent");
  await runWithConcurrency(agentNodes.map((node) => async () => {
    try {
      await checkNodeHealth(node.id, { timeoutMs: FLEET_QUERY_TIMEOUT_MS });
    } catch {
      // checkNodeHealth resolves agent failures into recorded states; reaching
      // here means the probe itself failed, so the roll-up falls back to the
      // registry's last recorded state for this node.
    }
  }), limit);
  const entries = await runWithConcurrency(getAllNodesSync().map((node) => async () => {
    return node.kind === "application-host"
      ? buildApplicationHostFleetEntry(node)
      : buildAgentFleetEntry(node);
  }), limit);
  return {
    checkedAt: new Date().toISOString(),
    concurrencyLimit: FLEET_CONCURRENCY_LIMIT,
    nodes: entries,
    totals: buildFleetTotals(entries),
  };
}

function normalizeBatchTargets(nodeIds) {
  const raw = Array.isArray(nodeIds) ? nodeIds : [];
  const targets = [];
  const seen = new Set();
  for (const value of raw) {
    const nodeId = String(value || "").trim();
    if (!nodeId || seen.has(nodeId)) continue;
    seen.add(nodeId);
    targets.push(nodeId);
  }
  return targets;
}

function resolveBatchTarget(nodeId) {
  let node = null;
  try {
    node = getNode(nodeId);
  } catch (error) {
    if (error?.code !== "NODE_NOT_FOUND") throw error;
  }
  if (!node) {
    return { ok: false, code: "NODE_NOT_FOUND", message: `Node ${nodeId} is not registered.`, node: null };
  }
  if (node.kind === "application-host" || nodeId === APPLICATION_HOST_NODE_ID || nodeId === "default") {
    return {
      ok: false,
      code: "APPLICATION_HOST_READ_ONLY",
      message: "The built-in application host is not a fleet batch target.",
      node,
    };
  }
  return { ok: true, code: "OK", message: "", node };
}

function buildBatchRecord(nodeId, node, outcome) {
  return {
    nodeId,
    nodeName: node?.displayName || node?.name || nodeId,
    ok: outcome.ok === true,
    code: outcome.code || (outcome.ok ? "OK" : "FLEET_BATCH_FAILED"),
    message: outcome.message || "",
    ...(outcome.state ? { state: outcome.state } : {}),
  };
}

// Cross-node batch actions. "start" reconnects the node connection (clears an
// owner disconnect and re-runs the health check); "stop" disconnects it. Every
// action resolves its own target from the registry, so a wrong or missing node
// id becomes a per-node failure record instead of touching another node.
// Stopping connections is destructive and requires explicit confirmation.
async function runFleetBatchAction(payload = {}) {
  const action = String(payload.action || "").trim().toLowerCase();
  if (!FLEET_ACTIONS.has(action)) {
    throw new FleetBatchError("FLEET_BATCH_ACTION_INVALID", 'Batch action must be "start" or "stop".');
  }
  if (action === "stop" && payload.confirm !== true) {
    throw new FleetBatchError(
      "FLEET_BATCH_CONFIRMATION_REQUIRED",
      "Confirm before disconnecting nodes: this stops AnxOS management of each target.",
      409,
    );
  }
  const targets = normalizeBatchTargets(payload.nodeIds);
  if (!targets.length) {
    throw new FleetBatchError("FLEET_BATCH_TARGETS_REQUIRED", "Select at least one node for the batch action.");
  }
  if (targets.length > FLEET_BATCH_MAX_TARGETS) {
    throw new FleetBatchError(
      "FLEET_BATCH_TOO_LARGE",
      `Batch actions are limited to ${FLEET_BATCH_MAX_TARGETS} nodes per run.`,
      413,
    );
  }
  const startedAt = new Date().toISOString();
  const results = await runWithConcurrency(targets.map((nodeId) => async () => {
    const target = resolveBatchTarget(nodeId);
    if (!target.ok) {
      return buildBatchRecord(nodeId, target.node, target);
    }
    try {
      if (action === "stop") {
        disconnectNode(nodeId);
        return buildBatchRecord(nodeId, target.node, { ok: true, code: "OK", message: "Node disconnected." });
      }
      const outcome = await reconnectNode(nodeId);
      const state = String(outcome?.state || "unknown");
      const ok = REACHABLE_BATCH_STATES.has(state);
      return buildBatchRecord(nodeId, target.node, {
        ok,
        code: ok ? "OK" : fleetStateCode(state),
        message: outcome?.message || (ok ? "Node connection restored." : "Node could not be reconnected."),
        state,
      });
    } catch (error) {
      return buildBatchRecord(nodeId, target.node, {
        ok: false,
        code: error?.code || "FLEET_BATCH_FAILED",
        message: error?.message || "Batch action failed for this node.",
      });
    }
  }), FLEET_CONCURRENCY_LIMIT);
  const succeeded = results.filter((result) => result.ok).length;
  return {
    action,
    startedAt,
    finishedAt: new Date().toISOString(),
    concurrencyLimit: FLEET_CONCURRENCY_LIMIT,
    results,
    summary: {
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
    },
  };
}

module.exports = {
  FLEET_BATCH_MAX_TARGETS,
  FLEET_CONCURRENCY_LIMIT,
  getFleetSummary,
  runFleetBatchAction,
  runWithConcurrency,
};
