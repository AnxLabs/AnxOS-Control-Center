(function initializeInstanceMetricsLifecycle(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnxInstanceMetrics = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createInstanceMetricsLifecycleApi() {
  "use strict";

  function toTimestamp(value, fallback = 0) {
    if (Number.isFinite(value)) return value;
    const parsed = Date.parse(value || "");
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function createStore() {
    const entries = new Map();
    let scope = null;

    function setScope(nextScope) {
      const normalized = nextScope || null;
      if (scope === normalized) return false;
      scope = normalized;
      entries.clear();
      return true;
    }

    function begin(instanceId, requestId, now = Date.now()) {
      if (!instanceId) return null;
      const current = entries.get(instanceId);
      const next = {
        ...(current || {}),
        instanceId,
        scope,
        status: current?.sample ? "refreshing" : "loading",
        requestId,
        requestedAt: now,
        error: null,
      };
      entries.set(instanceId, next);
      return next;
    }

    function succeed(instanceId, requestId, sample, receivedAt = Date.now()) {
      const current = entries.get(instanceId);
      if (!current || current.requestId !== requestId) return current || null;
      const incomingAt = toTimestamp(sample?.sampledAt ?? sample?.timestamp, receivedAt);
      if (current.sample && incomingAt < toTimestamp(current.sampleAt, 0)) return current;
      const next = {
        ...current,
        status: "ready",
        sample: { ...(sample || {}), id: sample?.id || instanceId },
        sampleAt: incomingAt,
        receivedAt,
        error: null,
      };
      entries.set(instanceId, next);
      return next;
    }

    function fail(instanceId, requestId, error, receivedAt = Date.now()) {
      const current = entries.get(instanceId);
      if (!current || current.requestId !== requestId) return current || null;
      const next = {
        ...current,
        status: current.sample ? "stale" : "unavailable",
        receivedAt,
        error: error?.message || String(error || "Metrics unavailable."),
      };
      entries.set(instanceId, next);
      return next;
    }

    function stop(instanceId) {
      if (!instanceId) return false;
      return entries.delete(instanceId);
    }

    return {
      setScope,
      begin,
      succeed,
      fail,
      stop,
      get: (instanceId) => entries.get(instanceId) || null,
      getSample: (instanceId) => entries.get(instanceId)?.sample || null,
      getStatus: (instanceId) => entries.get(instanceId)?.status || "idle",
      keys: () => [...entries.keys()],
      reset: () => entries.clear(),
      size: () => entries.size,
    };
  }

  return { createStore, toTimestamp };
});
