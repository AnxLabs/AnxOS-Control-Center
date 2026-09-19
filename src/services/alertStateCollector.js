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
function createAlertStateCollector({ nodeService, alertService, serviceRouter } = {}) {
  if (!nodeService || typeof nodeService.getSelectedNodeId !== "function" || typeof nodeService.listNodes !== "function") {
    throw new TypeError("createAlertStateCollector requires nodeService with getSelectedNodeId() and listNodes()");
  }
  if (!alertService || typeof alertService.resolveInstanceSnapshot !== "function") {
    throw new TypeError("createAlertStateCollector requires alertService with resolveInstanceSnapshot()");
  }
  if (!serviceRouter || typeof serviceRouter.listInstances !== "function") {
    throw new TypeError("createAlertStateCollector requires serviceRouter with listInstances()");
  }
  return async () => {
    // SMOOTH-3010: prefer the instance list the renderer just polled for the
    // same node; only make our own agent round trip when nothing fresh is
    // shared (e.g. no window polling). The previous code fetched
    // unconditionally, duplicating the renderer's request and re-emitting
    // the implicit-node fallback on every evaluation.
    const effectiveNodeId = nodeService.getSelectedNodeId() || nodeService.APPLICATION_HOST_NODE_ID;
    const [nodesPayload, instancesPayload] = await Promise.all([
      nodeService.listNodes({ discoverLocalAgent: false, refreshIdentity: false }).catch(() => ({ nodes: [] })),
      alertService.resolveInstanceSnapshot(effectiveNodeId, () => serviceRouter.listInstances({}).catch(() => ({ instances: [] }))),
    ]);
    return {
      nodes: nodesPayload?.nodes || [],
      instances: instancesPayload?.instances || [],
    };
  };
}

module.exports = { createAlertStateCollector };