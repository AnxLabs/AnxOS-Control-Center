const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { createStore } = require("../src/shared/instanceMetricsLifecycle");

const metrics = createStore();
metrics.setScope("node-a");
assert.strictEqual(metrics.getStatus("server-a"), "idle", "unrequested metrics should be distinguishable from unavailable");

metrics.begin("server-a", 1, 100);
metrics.begin("server-b", 2, 100);
assert.strictEqual(metrics.getStatus("server-a"), "loading", "first sample should render as loading");
assert.strictEqual(metrics.getStatus("server-b"), "loading", "each running instance should own an independent loading state");

metrics.succeed("server-b", 2, { id: "server-b", cpuPercent: 7, memoryRssBytes: 2100, sampledAt: 210 }, 220);
metrics.succeed("server-a", 1, { id: "server-a", cpuPercent: 14, memoryRssBytes: 3800, sampledAt: 200 }, 230);
assert.strictEqual(metrics.getSample("server-a").cpuPercent, 14, "server A metrics must remain keyed to server A");
assert.strictEqual(metrics.getSample("server-b").cpuPercent, 7, "server B metrics must remain keyed to server B");

metrics.begin("server-a", 3, 300);
assert.strictEqual(metrics.getStatus("server-a"), "refreshing", "refresh should retain the previous valid sample");
metrics.fail("server-a", 3, new Error("agent temporarily unavailable"), 310);
assert.strictEqual(metrics.getStatus("server-a"), "stale", "temporary failure with a prior sample should become stale/reconnecting");
assert.strictEqual(metrics.getSample("server-a").cpuPercent, 14, "temporary failure must preserve the last valid sample");

metrics.begin("server-c", 4, 400);
metrics.fail("server-c", 4, new Error("metrics unsupported"), 410);
assert.strictEqual(metrics.getStatus("server-c"), "unavailable", "first-sample failure should be genuinely unavailable");

metrics.begin("server-a", 5, 500);
metrics.begin("server-a", 6, 510);
metrics.succeed("server-a", 6, { id: "server-a", cpuPercent: 18, sampledAt: 600 }, 610);
metrics.succeed("server-a", 5, { id: "server-a", cpuPercent: 3, sampledAt: 550 }, 620);
assert.strictEqual(metrics.getSample("server-a").cpuPercent, 18, "older request completion must not overwrite a newer sample");

metrics.stop("server-b");
assert.strictEqual(metrics.get("server-b"), null, "stopped instances should leave the monitoring set");

metrics.setScope("node-b");
assert.strictEqual(metrics.size(), 0, "node switching must clear node-scoped telemetry");

const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
assert.match(app, /const instanceMetricsStore = window\.AnxInstanceMetrics\.createStore\(\)/, "renderer must use the keyed telemetry store");
assert.match(app, /getInstances\(\)\.filter\(isInstanceRunning\)/, "scheduler must discover all running instances");
assert.match(app, /renderInstancesSnapshot\(snapshot\);[\s\S]{0,180}refreshEligibleInstanceMetrics\(\)/, "opening or refreshing Instances must schedule metrics without selection");
assert.match(app, /INSTANCE_METRICS_MAX_CONCURRENCY = 3/, "metrics scheduler must have bounded concurrency");
assert.match(app, /instanceMetricsInFlight\.has\(instanceId\)/, "metrics requests must deduplicate per instance");
assert.match(app, /instanceMetricsStore\.setScope\(requestContext\.nodeId\)/, "metrics must be scoped to the selected node");
assert.match(app, /if \(!eligibleSet\.has\(instanceId\)\) instanceMetricsStore\.stop\(instanceId\)/, "stopped instances must be removed from monitoring");
assert.match(app, /renderInstanceMetricsUpdate\(instanceId\)/, "one sample should update its keyed row");
assert.match(app, /existingRows\.get\(instance\.id\)/, "metrics rendering must preserve the keyed instance row");
assert.match(app, /\["idle", "loading"\]\.includes\(status\)[\s\S]{0,80}Loading metrics/, "first-sample state must render as loading");

const selectStart = app.indexOf("function selectInstance(");
const selectEnd = app.indexOf("function renderInstancesSnapshot", selectStart);
const selectSource = app.slice(selectStart, selectEnd);
assert.doesNotMatch(selectSource, /getMetrics|requestInstanceMetrics|refreshEligibleInstanceMetrics/, "selection must not initialize or duplicate monitoring");

const consoleStart = app.indexOf("async function refreshConsoleMetrics");
const consoleEnd = app.indexOf("async function refreshConsoleLogs", consoleStart);
const consoleSource = app.slice(consoleStart, consoleEnd);
assert.doesNotMatch(consoleSource, /api\.instances\.getMetrics/, "detail/console metrics must consume the shared store");
assert.doesNotMatch(consoleSource, /refreshEligibleInstanceMetrics/, "detail/console refresh must not create a second monitoring loop");

console.log("Instance metrics lifecycle smoke passed.");
