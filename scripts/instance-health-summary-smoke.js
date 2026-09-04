const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const { classifyInstanceState, summarizeInstanceHealth } = require(path.join(rootDir, "src", "shared", "instanceHealthSummary.js"));

function assertClassification(state, expected, label) {
  const bucket = classifyInstanceState({ state });
  assert.strictEqual(bucket, expected, `${label || state} should map to ${expected}, got ${bucket}`);
}

async function main() {
  // State classification: every requested health bucket must be reachable.
  assertClassification("Running", "running");
  assertClassification("Stopped", "stopped");
  assertClassification("Starting", "starting");
  assertClassification("Restarting", "starting", "restarting must count as starting");
  assertClassification("Stopping", "stopping");
  assertClassification("Failed", "failed");
  assertClassification("Crashed", "failed", "crashed maps to failed");
  assertClassification("Setup Required", "setupRequired");
  assertClassification("Unavailable", "unavailable");
  assertClassification("", "unknown", "empty state maps to unknown");
  assertClassification("Mystery State", "unknown");

  // A live process with degraded health/readiness is unhealthy, not Running.
  assert.strictEqual(classifyInstanceState({ state: "Running", healthState: "degraded" }), "unhealthy");
  assert.strictEqual(classifyInstanceState({ state: "Running", readinessState: "timeout" }), "unhealthy");
  assert.strictEqual(classifyInstanceState({ state: "Running", healthState: "healthy" }), "running");

  // Summary counts across a mixed inventory.
  const inventory = [
    { id: "a", name: "Alpha", state: "Running" },
    { id: "b", name: "Beta", state: "Running", healthState: "degraded", failureReason: "STARTUP_TIMEOUT" },
    { id: "c", name: "Gamma", state: "Starting" },
    { id: "d", name: "Delta", state: "Stopping" },
    { id: "e", name: "Epsilon", state: "Stopped" },
    { id: "f", name: "Zeta", state: "Failed", failureReason: "STALE_PID" },
    { id: "g", name: "Eta", state: "Unknown" },
    { id: "h", name: "Theta", state: "Setup Required" },
    { id: "i", name: "Iota", state: "Running" },
  ];
  const summary = summarizeInstanceHealth(inventory);

  assert.strictEqual(summary.total, 9);
  assert.strictEqual(summary.counts.running, 2, "degraded running instance must not count as running");
  assert.strictEqual(summary.counts.unhealthy, 1);
  assert.strictEqual(summary.counts.starting, 1);
  assert.strictEqual(summary.counts.stopping, 1);
  assert.strictEqual(summary.counts.stopped, 1);
  assert.strictEqual(summary.counts.failed, 1);
  assert.strictEqual(summary.counts.unknown, 1);
  assert.strictEqual(summary.counts.setupRequired, 1);

  // Needs-attention ordering: failed first, then unhealthy, then unknown.
  assert.strictEqual(summary.attentionCount, 3);
  assert.deepStrictEqual(
    summary.needsAttention.map((item) => item.bucket),
    ["failed", "unhealthy", "unknown"],
    "attention list must order failed before unhealthy before unknown"
  );
  assert.strictEqual(summary.needsAttention[0].reason, "STALE_PID");
  assert.strictEqual(summary.needsAttention[0].name, "Zeta");
  // Setup Required is a guided workflow, not an operational fault.
  assert.ok(!summary.needsAttention.some((item) => item.bucket === "setupRequired"));

  // Empty and non-array inputs stay truthful.
  assert.deepStrictEqual(summarizeInstanceHealth([]).counts.running, 0);
  assert.strictEqual(summarizeInstanceHealth([]).total, 0);
  assert.strictEqual(summarizeInstanceHealth(null).total, 0);

  // Renderer wiring.
  const indexHtml = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");
  const appJs = fs.readFileSync(path.join(rootDir, "app.js"), "utf8");
  const stylesCss = fs.readFileSync(path.join(rootDir, "styles.css"), "utf8");
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));

  assert.ok(indexHtml.includes('src="src/shared/instanceHealthSummary.js"'), "index.html must load the shared health summary module.");
  for (const field of ["instancesStarting", "instancesStopping", "instancesNeedsAttention"]) {
    assert.ok(indexHtml.includes(`data-field="${field}"`), `index.html must expose the ${field} summary field.`);
  }
  assert.ok(indexHtml.includes("data-instance-attention"), "index.html must include the attention strip region.");

  assert.ok(appJs.includes("function summarizeInstanceHealthBuckets("), "renderer must summarize through the shared module helper.");
  assert.ok(appJs.includes("shared.summarizeInstanceHealth(instances)"), "renderer must use the shared summarizer when available.");
  assert.ok(appJs.includes("renderInstanceAttentionStrip(healthSummary)"), "renderInstanceSummary must render the attention strip.");
  assert.ok(appJs.includes("renderInstanceAttentionStrip(null)"), "unavailable snapshots must clear the attention strip.");
  assert.match(appJs, /setField\("instancesTotal", String\(instances\.length\)\)/, "legacy summary fields must remain populated.");

  assert.ok(stylesCss.includes(".instances-summary-card--attention .instances-summary-card__icon"), "attention card must have distinct styling.");
  assert.ok(stylesCss.includes(".instances-attention-strip") && stylesCss.includes(".instances-attention-item"), "attention strip must be styled.");

  assert.ok(
    Object.values(packageJson.scripts).includes("node scripts/instance-health-summary-smoke.js"),
    "smoke test must be registered in package.json scripts."
  );

  console.log("instance-health-summary-smoke: all assertions passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});