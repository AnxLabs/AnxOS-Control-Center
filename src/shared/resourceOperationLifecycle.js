(function initializeResourceOperationLifecycle(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnxResourceOperations = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createResourceOperationLifecycle() {
  "use strict";

  const ACTIVE_STATUSES = new Set(["queued", "running"]);
  const TERMINAL_STATUSES = new Set(["success", "failed", "completed", "complete", "cancelled", "canceled"]);

  function timestamp(value, fallback = 0) {
    if (Number.isFinite(value)) return value;
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function normalizeStatus(value) {
    const status = String(value || "running").toLowerCase();
    if (status === "complete" || status === "completed") return "success";
    if (status === "cancelled" || status === "canceled") return "failed";
    return status;
  }

  function operationVersion(operation = {}) {
    return timestamp(operation.updatedAt, timestamp(operation.completedAt, timestamp(operation.startedAt)));
  }

  function shouldAcceptOperation(current, incoming) {
    if (!current) return true;
    const currentStatus = normalizeStatus(current.status);
    const incomingStatus = normalizeStatus(incoming.status);
    const currentVersion = operationVersion(current);
    const incomingVersion = operationVersion(incoming);
    if (incomingVersion < currentVersion) return false;
    if (TERMINAL_STATUSES.has(currentStatus) && ACTIVE_STATUSES.has(incomingStatus) && incomingVersion <= currentVersion) return false;
    const currentProgress = Number(current.progress);
    const incomingProgress = Number(incoming.progress);
    if (ACTIVE_STATUSES.has(currentStatus) && ACTIVE_STATUSES.has(incomingStatus) &&
        Number.isFinite(currentProgress) && Number.isFinite(incomingProgress) &&
        incomingProgress < currentProgress && incomingVersion <= currentVersion) return false;
    return true;
  }

  function createStore() {
    const resources = new Map();
    const operations = new Map();

    function reconcileResources(incoming = [], options = {}) {
      const incomingIds = new Set();
      for (const resource of incoming) {
        if (!resource?.id) continue;
        incomingIds.add(resource.id);
        resources.set(resource.id, { ...(resources.get(resource.id) || {}), ...resource });
      }
      const removableIds = new Set(options.removableIds || []);
      for (const id of [...resources.keys()]) {
        if (!incomingIds.has(id) && removableIds.has(id) && !ACTIVE_STATUSES.has(normalizeStatus(operations.get(id)?.status))) {
          resources.delete(id);
          operations.delete(id);
        }
      }
      return [...resources.values()];
    }

    function updateOperation(resourceId, patch = {}) {
      if (!resourceId) return null;
      const current = operations.get(resourceId) || null;
      const incoming = { ...(current || {}), ...patch, resourceId };
      if (!shouldAcceptOperation(current, incoming)) return current;
      operations.set(resourceId, incoming);
      return incoming;
    }

    function clearOperation(resourceId, expectedType) {
      const current = operations.get(resourceId);
      if (!current || (expectedType && current.type !== expectedType)) return false;
      operations.delete(resourceId);
      return true;
    }

    return {
      reconcileResources,
      updateOperation,
      clearOperation,
      getResource: (id) => resources.get(id) || null,
      getResources: () => [...resources.values()],
      getOperation: (id) => operations.get(id) || null,
      getVisibleResource: (id) => {
        const resource = resources.get(id);
        return resource ? { ...resource, operation: operations.get(id) || null } : null;
      },
      reset: () => {
        resources.clear();
        operations.clear();
      },
    };
  }

  return { createStore, normalizeStatus, shouldAcceptOperation };
});
