(function initializeInstanceHealthSummary(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnxInstanceHealthSummary = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createInstanceHealthSummaryApi() {
  "use strict";

  const HEALTH_BUCKETS = Object.freeze([
    "running",
    "stopped",
    "starting",
    "stopping",
    "unavailable",
    "unhealthy",
    "failed",
    "unknown",
    "setupRequired",
  ]);

  function normalizeState(value) {
    return String(value || "").trim().toLowerCase().replace(/[_\s]+/g, "-");
  }

  function isEmptyState(value) {
    return !String(value || "").trim();
  }

  // Maps the persisted instance `state` (plus orthogonal health/readiness
  // states) onto one truthful summary bucket. A live process with degraded
  // health must surface as unhealthy instead of silently counting as Running.
  function classifyInstanceState(instance) {
    const state = normalizeState(instance?.state || instance?.lifecycleState);
    if (!state) return "unknown";
    if (["failed", "crashed", "crash-loop"].includes(state)) return "failed";
    if (["running", "online"].includes(state)) {
      const healthState = normalizeState(instance?.healthState);
      const readinessState = normalizeState(instance?.readinessState);
      if (
        ["degraded", "unhealthy", "failing"].includes(healthState) ||
        ["timeout", "degraded", "unhealthy", "failing"].includes(readinessState)
      ) {
        return "unhealthy";
      }
      return "running";
    }
    if (["starting", "restarting"].includes(state)) return "starting";
    if (state === "stopping") return "stopping";
    if (["stopped", "exited"].includes(state)) return "stopped";
    if (["setup-required", "setuprequired"].includes(state)) return "setupRequired";
    if (["unavailable", "unreachable"].includes(state)) return "unavailable";
    return "unknown";
  }

  function getInstanceDisplayName(instance) {
    return String(instance?.displayName || instance?.name || instance?.id || "Unknown instance").trim() || "Unknown instance";
  }

  function getInstanceFailureReason(instance) {
    const candidates = [
      instance?.failureReason,
      instance?.lastError,
      instance?.lastError?.message,
      instance?.status?.failureReason,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
      if (candidate && typeof candidate === "object") {
        const code = candidate.code || candidate.reason;
        if (typeof code === "string" && code.trim()) return code.trim();
      }
    }
    return null;
  }

  function emptyCounts() {
    return HEALTH_BUCKETS.reduce((counts, bucket) => {
      counts[bucket] = 0;
      return counts;
    }, {});
  }

  function summarizeInstanceHealth(instances) {
    const list = Array.isArray(instances) ? instances : [];
    const counts = emptyCounts();
    const needsAttention = [];

    list.forEach((instance) => {
      const bucket = classifyInstanceState(instance);
      counts[bucket] = (counts[bucket] || 0) + 1;

      // Failed, degraded, unreachable, and unclassified instances always need
      // attention. Setup Required is intentionally excluded: it has its own
      // guided workflow and is not an operational fault.
      if (["failed", "unhealthy", "unavailable", "unknown"].includes(bucket)) {
        needsAttention.push({
          id: instance?.id || null,
          name: getInstanceDisplayName(instance),
          bucket,
          state: String(instance?.state || "").trim() || "Unknown",
          reason: getInstanceFailureReason(instance),
        });
      }
    });

    const attentionOrder = { failed: 0, unhealthy: 1, unavailable: 2, unknown: 3 };
    needsAttention.sort((left, right) =>
      (attentionOrder[left.bucket] ?? 9) - (attentionOrder[right.bucket] ?? 9) ||
      String(left.name).localeCompare(String(right.name))
    );

    return {
      total: list.length,
      counts,
      needsAttention,
      attentionCount: needsAttention.length,
    };
  }

  function formatBucketLabel(bucket) {
    const labels = {
      running: "Running",
      stopped: "Stopped",
      starting: "Starting",
      stopping: "Stopping",
      unavailable: "Unavailable",
      unhealthy: "Unhealthy",
      failed: "Failed",
      unknown: "Unknown",
      setupRequired: "Setup Required",
    };
    return labels[bucket] || "Unknown";
  }

  return {
    HEALTH_BUCKETS,
    classifyInstanceState,
    summarizeInstanceHealth,
    formatBucketLabel,
    isEmptyState,
  };
});