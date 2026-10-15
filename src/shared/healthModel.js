(function initializeHealthModel(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnxHealthModel = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createHealthModelApi() {
  "use strict";

  // Canonical connectivity vocabulary. Everything the endpoint manager,
  // diagnostics pipeline, connectivity graph, and notifications report must be
  // expressed in these six states — never in ad-hoc strings.
  const CONNECTIVITY_STATES = Object.freeze([
    "healthy",
    "degraded",
    "failed",
    "unknown",
    "unsupported",
    "not_configured",
  ]);

  // Ranked states participate in worst-state aggregation. Higher rank wins.
  // unknown ranks above degraded/healthy because absence of evidence must never
  // silently read as good news.
  const STATE_RANK = Object.freeze({
    healthy: 1,
    degraded: 2,
    unknown: 3,
    failed: 4,
  });

  // Unranked states describe "not applicable / nothing to fail". They are
  // excluded from worst-state aggregation so a single unsupported stage cannot
  // drag an otherwise healthy path down, and they are never failures.
  const UNRANKED_STATES = Object.freeze(["unsupported", "not_configured"]);

  // Reachability scopes are the distinct questions a connectivity check can
  // answer. A process can be Running while nothing outside the machine can
  // reach it; each scope is answered by its own stage.
  const REACHABILITY_SCOPES = Object.freeze(["process", "local", "lan", "private_overlay", "public"]);

  const SCOPE_LABELS = Object.freeze({
    process: "Process",
    local: "Local",
    lan: "LAN",
    private_overlay: "Private Overlay",
    public: "Public",
  });

  const STATE_LABELS = Object.freeze({
    healthy: "Healthy",
    degraded: "Degraded",
    failed: "Failed",
    unknown: "Unknown",
    unsupported: "Unsupported",
    not_configured: "Not Configured",
  });

  const STATE_TONES = Object.freeze({
    healthy: "ok",
    degraded: "warning",
    failed: "error",
    unknown: "neutral",
    unsupported: "muted",
    not_configured: "muted",
  });

  function isConnectivityState(value) {
    return CONNECTIVITY_STATES.includes(value);
  }

  // Anything that is not a known state is evidence-quality data, not a crash:
  // it is treated as unknown so a typo can never be reported as healthy.
  function asKnownState(value) {
    return isConnectivityState(value) ? value : "unknown";
  }

  // Highest-ranked state present. Unranked states are ignored entirely: when
  // ONLY unranked states are present the path describes "nothing to fail", so
  // the answer is not_configured. Empty input has no evidence at all, which is
  // unknown, never healthy.
  function worstState(states) {
    const list = Array.isArray(states) ? states.map(asKnownState) : [];
    if (list.length === 0) return "unknown";
    let worst = null;
    let worstRank = 0;
    for (const state of list) {
      const rank = STATE_RANK[state] || 0;
      if (rank > worstRank) {
        worst = state;
        worstRank = rank;
      }
    }
    return worst || "not_configured";
  }

  // Combine states that jointly describe ONE path or scope:
  //   any failed  -> failed            (a broken link breaks the path)
  //   any unknown -> unknown           (missing evidence taints the whole path)
  //   any degraded -> degraded
  //   any healthy -> healthy
  //   otherwise (only unranked present) -> the single unranked value, or
  //   not_configured when several different unranked values are mixed.
  // Empty input -> unknown.
  function combineStates(states) {
    const list = Array.isArray(states) ? states.map(asKnownState) : [];
    if (list.includes("failed")) return "failed";
    if (list.length === 0 || list.includes("unknown")) return "unknown";
    if (list.includes("degraded")) return "degraded";
    if (list.includes("healthy")) return "healthy";
    const unique = Array.from(new Set(list));
    return unique.length === 1 ? unique[0] : "not_configured";
  }

  function isHealthy(state) {
    return state === "healthy";
  }

  function isFailed(state) {
    return state === "failed";
  }

  function isUnknown(state) {
    return state === "unknown";
  }

  function isUnsupported(state) {
    return state === "unsupported";
  }

  function isNotConfigured(state) {
    return state === "not_configured";
  }

  function stateLabel(state) {
    return STATE_LABELS[state] || "Unknown";
  }

  function stateTone(state) {
    return STATE_TONES[state] || "neutral";
  }

  // Maps the instance process lifecycle (the value stored on an instance
  // record) onto the connectivity vocabulary used by the diagnostics path.
  // These are DIAGNOSTIC-PATH states, NOT the canonical instance lifecycle
  // enum: the renderer's lifecycle classification (see
  // instanceHealthSummary.js) is the authority for instance lifecycle. Here a
  // Stopped/Failed process is reported as failed because the connectivity path
  // cannot carry traffic without it, and Setup Required is merely
  // not_configured — it has a guided workflow and is not an operational fault.
  function mapInstanceProcessState(instanceState) {
    const normalized = String(instanceState == null ? "" : instanceState)
      .trim()
      .toLowerCase()
      .replace(/[_\s]+/g, "-");
    switch (normalized) {
      case "running":
        return "healthy";
      case "starting":
        return "degraded";
      case "restarting":
        return "degraded";
      case "stopping":
        return "degraded";
      case "stopped":
        return "failed";
      case "failed":
        return "failed";
      case "setup-required":
        return "not_configured";
      default:
        return "unknown";
    }
  }

  // Frozen, machine-readable description of what the vocabulary means. Consumers
  // and reviewers can assert against this instead of re-deriving semantics.
  function describeHealthSemantics() {
    return Object.freeze({
      version: 1,
      vocabulary: Object.freeze([...CONNECTIVITY_STATES]),
      rules: Object.freeze([
        "Process/lifecycle state, reachability, and provider state are distinct axes; one never implies another.",
        "healthy requires positive evidence; absence of evidence is unknown, not healthy.",
        "unknown is neither failed nor healthy; it means the question has not been answered.",
        "unsupported and not_configured are not failures; they mean there is nothing to fail.",
        "A RUNNING service is not automatically reachable: a healthy service-process stage says nothing about local-socket, host-network, provider, or public-endpoint reachability.",
        "worstState aggregates ranked states only; unranked states are excluded and yield not_configured when they are all that is present.",
        "combineStates returns failed when any input failed, unknown when any input is unknown, and degraded/healthy only when the remaining inputs positively support them.",
      ]),
    });
  }

  return {
    CONNECTIVITY_STATES,
    STATE_RANK,
    UNRANKED_STATES,
    REACHABILITY_SCOPES,
    SCOPE_LABELS,
    worstState,
    combineStates,
    isHealthy,
    isFailed,
    isUnknown,
    isUnsupported,
    isNotConfigured,
    stateLabel,
    stateTone,
    mapInstanceProcessState,
    describeHealthSemantics,
  };
});
