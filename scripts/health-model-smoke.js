const assert = require("node:assert/strict");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const health = require(path.join(rootDir, "src", "shared", "healthModel.js"));

const EXPECTED_STATES = ["healthy", "degraded", "failed", "unknown", "unsupported", "not_configured"];
const EXPECTED_LABELS = {
  healthy: "Healthy",
  degraded: "Degraded",
  failed: "Failed",
  unknown: "Unknown",
  unsupported: "Unsupported",
  not_configured: "Not Configured",
};
const EXPECTED_TONES = {
  healthy: "ok",
  degraded: "warning",
  failed: "error",
  unknown: "neutral",
  unsupported: "muted",
  not_configured: "muted",
};

async function main() {
  // Vocabulary and ranking tables.
  assert.deepStrictEqual([...health.CONNECTIVITY_STATES], EXPECTED_STATES);
  assert.deepStrictEqual(health.STATE_RANK, { healthy: 1, degraded: 2, unknown: 3, failed: 4 });
  assert.deepStrictEqual([...health.UNRANKED_STATES], ["unsupported", "not_configured"]);
  assert.deepStrictEqual([...health.REACHABILITY_SCOPES], ["process", "local", "lan", "private_overlay", "public"]);
  assert.deepStrictEqual(health.SCOPE_LABELS, {
    process: "Process",
    local: "Local",
    lan: "LAN",
    private_overlay: "Private Overlay",
    public: "Public",
  });

  // worstState: failed dominates, unknown outranks degraded/healthy, unranked
  // states are excluded, empty input is unknown, only-unranked is
  // not_configured.
  assert.strictEqual(health.worstState(["healthy", "degraded"]), "degraded");
  assert.strictEqual(health.worstState(["degraded", "failed", "unknown"]), "failed", "failed must dominate");
  assert.strictEqual(health.worstState(["failed", "healthy"]), "failed");
  assert.strictEqual(health.worstState(["healthy", "degraded", "unknown"]), "unknown", "unknown outranks degraded");
  assert.strictEqual(health.worstState(["healthy", "unsupported"]), "healthy", "unranked states must be excluded");
  assert.strictEqual(health.worstState(["unsupported"]), "not_configured");
  assert.strictEqual(health.worstState(["unsupported", "not_configured"]), "not_configured");
  assert.strictEqual(health.worstState([]), "unknown");
  assert.strictEqual(health.worstState(null), "unknown");
  assert.strictEqual(health.worstState(["healthy", "bogus"]), "unknown", "unknown input is never trusted as healthy");
  assert.notStrictEqual(health.worstState(["unknown"]), "healthy", "unknown is never healthy");
  assert.notStrictEqual(health.worstState([]), "healthy", "no evidence is never healthy");

  // combineStates: any failed -> failed; any unknown (or empty) -> unknown;
  // degraded before healthy; only-unranked preserves a single unranked value
  // and folds mixed unranked values to not_configured.
  assert.strictEqual(health.combineStates(["healthy", "failed"]), "failed");
  assert.strictEqual(health.combineStates(["failed", "unknown", "degraded"]), "failed");
  assert.strictEqual(health.combineStates(["degraded", "unknown", "healthy"]), "unknown");
  assert.strictEqual(health.combineStates(["healthy", "unknown"]), "unknown");
  assert.strictEqual(health.combineStates(["healthy", "degraded"]), "degraded");
  assert.strictEqual(health.combineStates(["healthy"]), "healthy");
  assert.strictEqual(health.combineStates([]), "unknown");
  assert.strictEqual(health.combineStates(null), "unknown");
  assert.strictEqual(health.combineStates(["unsupported", "healthy"]), "healthy", "unranked + healthy must stay healthy");
  assert.strictEqual(health.combineStates(["not_configured", "degraded"]), "degraded");
  assert.strictEqual(health.combineStates(["unsupported"]), "unsupported");
  assert.strictEqual(health.combineStates(["not_configured"]), "not_configured");
  assert.strictEqual(health.combineStates(["unsupported", "not_configured"]), "not_configured");
  assert.strictEqual(health.combineStates(["unsupported", "bogus"]), "unknown");

  // Process tree -> diagnostic-path state mapping (full requested table).
  assert.strictEqual(health.mapInstanceProcessState("Running"), "healthy");
  assert.strictEqual(health.mapInstanceProcessState("Starting"), "degraded");
  assert.strictEqual(health.mapInstanceProcessState("Restarting"), "degraded");
  assert.strictEqual(health.mapInstanceProcessState("Stopping"), "degraded");
  assert.strictEqual(health.mapInstanceProcessState("Stopped"), "failed");
  assert.strictEqual(health.mapInstanceProcessState("Failed"), "failed");
  assert.strictEqual(health.mapInstanceProcessState("Setup Required"), "not_configured");
  assert.strictEqual(health.mapInstanceProcessState("setup  required"), "not_configured", "case/space variants normalize");
  assert.strictEqual(health.mapInstanceProcessState("Unknown"), "unknown");
  assert.strictEqual(health.mapInstanceProcessState(undefined), "unknown");
  assert.strictEqual(health.mapInstanceProcessState(""), "unknown");
  assert.strictEqual(health.mapInstanceProcessState("Crashed"), "unknown", "unlisted lifecycle values stay unknown, not invented");

  // Predicate helpers.
  assert.strictEqual(health.isHealthy("healthy"), true);
  assert.strictEqual(health.isHealthy("unknown"), false);
  assert.strictEqual(health.isFailed("failed"), true);
  assert.strictEqual(health.isFailed("healthy"), false);
  assert.strictEqual(health.isUnknown("unknown"), true);
  assert.strictEqual(health.isUnknown("degraded"), false);
  assert.strictEqual(health.isUnsupported("unsupported"), true);
  assert.strictEqual(health.isUnsupported("failed"), false);
  assert.strictEqual(health.isNotConfigured("not_configured"), true);
  assert.strictEqual(health.isNotConfigured("healthy"), false);

  // Labels and tones for all six states, plus unknown input fallbacks.
  for (const state of EXPECTED_STATES) {
    assert.strictEqual(health.stateLabel(state), EXPECTED_LABELS[state]);
    assert.strictEqual(health.stateTone(state), EXPECTED_TONES[state]);
  }
  assert.strictEqual(health.stateLabel("bogus"), "Unknown");
  assert.strictEqual(health.stateTone("bogus"), "neutral");

  // Frozen vocabulary and semantics.
  assert.ok(Object.isFrozen(health.CONNECTIVITY_STATES));
  assert.ok(Object.isFrozen(health.STATE_RANK));
  assert.ok(Object.isFrozen(health.UNRANKED_STATES));
  assert.ok(Object.isFrozen(health.REACHABILITY_SCOPES));
  assert.ok(Object.isFrozen(health.SCOPE_LABELS));

  const semantics = health.describeHealthSemantics();
  assert.ok(Object.isFrozen(semantics), "semantics must be frozen");
  assert.ok(Object.isFrozen(semantics.rules), "semantics rules must be frozen");
  assert.strictEqual(semantics.version, 1);
  assert.deepStrictEqual([...semantics.vocabulary], EXPECTED_STATES);
  assert.ok(semantics.rules.length >= 5, "semantics must document the axes and rules");
  assert.ok(semantics.rules.every((rule) => typeof rule === "string" && rule.length > 0));
  assert.ok(semantics.rules.some((rule) => /RUNNING service is not automatically reachable/.test(rule)));

  console.log("health-model-smoke: all assertions passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
