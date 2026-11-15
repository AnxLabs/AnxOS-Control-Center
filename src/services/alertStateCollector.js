// SMOOTH-3010: the alert scheduler's state provider, extracted from main.js so the
// desktop wiring — selected-node resolution plus the instance-snapshot reuse path —
// is require-able and behaviourally testable without Electron.
//
// Dependency injection only: this module requires NOTHING, and in particular must
// never require main.js — that would be a require cycle. The caller (main.js) owns
// the lazy `require(...)` of nodeService/alertService/serviceRouter and passes them
// in, so this module has no service dependency at load time.
//
// Behaviour copied verbatim from the in-main.js `collectState` closure:
//   - resolve the effective node id from the current selection, falling back to the
//     application-host node when nothing is selected;
//   - read nodes and instances concurrently;
//   - both reads degrade to empty collections rather than rejecting, so an alert
//     evaluation pass is never taken down by an unreachable service.
//
// The evaluator also needs facts the node list does not carry:
//   - instance records have no nodeId (the list is read for one node), so each
//     row is stamped with the node it was read for; without it every instance
//     row was dropped and INSTANCE_DEGRADED could never fire;
//   - disk usage comes from the telemetry sampler's latest host:<node>:diskPercent
//     reading (optional telemetryService), attached to the node row as `disk`;
//   - backups come from one bounded, node-scoped serviceRouter.listBackups read;
//   - `observed` names the nodes whose instance and backup reads succeeded, so
//     a failed read or another selected computer does not clear their alerts.
const BACKUP_LIST_TIMEOUT_MS = 8 * 1000;
// Covers the slowest sampling interval (1 h) with slack; an older reading is
// not evidence of the disk's current state.
const DISK_READING_MAX_AGE_MS = 2 * 60 * 60 * 1000;

function withTimeout(value, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("Backup listing timed out."), { code: "BACKUP_LIST_TIMEOUT" })), timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    Promise.resolve(value).then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

function latestDiskPercents(summary) {
  const byNode = new Map();
  const series = Array.isArray(summary?.series) ? summary.series : [];
  for (const row of series) {
    const nodeId = typeof row?.nodeId === "string" ? row.nodeId : "";
    const key = typeof row?.key === "string" ? row.key : "";
    if (!nodeId || !key.startsWith("host:") || !key.endsWith(":diskPercent")) continue;
    const value = Number(row?.summary?.latestValue);
    const atMs = Date.parse(row?.summary?.latestAt || "");
    if (row?.summary?.latestValue === null || !Number.isFinite(value) || !Number.isFinite(atMs)) continue;
    const previous = byNode.get(nodeId);
    if (!previous || atMs > previous.atMs) byNode.set(nodeId, { percent: value, atMs });
  }
  return byNode;
}

function createAlertStateCollector({ nodeService, alertService, serviceRouter, telemetryService = null } = {}) {
  if (!nodeService || typeof nodeService.getSelectedNodeId !== "function" || typeof nodeService.listNodes !== "function") {
    throw new TypeError("createAlertStateCollector requires nodeService with getSelectedNodeId() and listNodes()");
  }
  if (!alertService || typeof alertService.resolveInstanceSnapshot !== "function") {
    throw new TypeError("createAlertStateCollector requires alertService with resolveInstanceSnapshot()");
  }
  if (!serviceRouter || typeof serviceRouter.listInstances !== "function") {
    throw new TypeError("createAlertStateCollector requires serviceRouter with listInstances()");
  }
  const readsBackups = typeof serviceRouter.listBackups === "function";

  async function readDiskPercents() {
    if (!telemetryService || typeof telemetryService.getTelemetrySummary !== "function") return new Map();
    try {
      const byNode = latestDiskPercents(await telemetryService.getTelemetrySummary({ sinceMs: DISK_READING_MAX_AGE_MS }));
      const oldestMs = Date.now() - DISK_READING_MAX_AGE_MS;
      for (const [nodeId, reading] of byNode) if (reading.atMs < oldestMs) byNode.delete(nodeId);
      return byNode;
    } catch {
      return new Map();
    }
  }

  async function readBackups(nodeId) {
    try {
      const payload = await withTimeout(serviceRouter.listBackups({ nodeId }), BACKUP_LIST_TIMEOUT_MS);
      const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.backups) ? payload.backups : [];
      return rows
        .filter((row) => row && typeof row === "object")
        .map((row) => ({ ...row, nodeId: row.nodeId || nodeId }));
    } catch {
      // A failed or timed-out read is not "no backups": null keeps it out of
      // `observed`, so the node's backup alerts are carried forward.
      return null;
    }
  }

  return async () => {
    // SMOOTH-3010: prefer the instance list the renderer just polled for the
    // same node; only make our own agent round trip when nothing fresh is
    // shared (e.g. no window polling). The previous code fetched
    // unconditionally, duplicating the renderer's request and re-emitting
    // the implicit-node fallback on every evaluation.
    const effectiveNodeId = nodeService.getSelectedNodeId() || nodeService.APPLICATION_HOST_NODE_ID;
    const [nodesPayload, instancesPayload, diskPercents, backups] = await Promise.all([
      nodeService.listNodes({ discoverLocalAgent: false, refreshIdentity: false }).catch(() => null),
      alertService.resolveInstanceSnapshot(effectiveNodeId, () => serviceRouter.listInstances({}).catch(() => null)),
      readDiskPercents(),
      readsBackups ? readBackups(effectiveNodeId) : null,
    ]);
    const nodes = (nodesPayload?.nodes || []).map((node) => {
      const reading = diskPercents.get(node?.id || node?.nodeId);
      return reading ? { ...node, disk: { percent: reading.percent } } : node;
    });
    const instances = (instancesPayload?.instances || []).map((instance) => (
      instance && typeof instance === "object" && !instance.nodeId && !instance.node ? { ...instance, nodeId: effectiveNodeId } : instance
    ));
    // Which reads succeeded, by node: only the selected computer's servers and
    // backups are read, and a failed read degrades to empty data. The
    // evaluator must not treat either as "the condition went away".
    const observed = {
      nodes: Array.isArray(nodesPayload?.nodes) ? nodes.map((node) => node?.id || node?.nodeId).filter(Boolean) : null,
      instances: Array.isArray(instancesPayload?.instances) ? [effectiveNodeId] : [],
    };
    if (readsBackups) observed.backups = backups ? [effectiveNodeId] : [];
    const state = { nodes, instances, observed };
    if (backups) state.backups = backups;
    return state;
  };
}

module.exports = { createAlertStateCollector };
