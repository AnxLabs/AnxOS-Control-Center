#!/usr/bin/env node
// Behavioral coverage for F1 of the first V2 runtime acceptance pass.
//
// FINDING (cycle 20): during a node switch the Dashboard Network card
// (DOWNLOAD / UPLOAD / TOTAL DOWNLOADED / TOTAL UPLOADED) and the Runtime card
// (UPTIME) rendered the literal node-switch status sentence
// "Switching to Windows Desktop…" in the metric VALUE position.
//
// MECHANISM: selectNode() called
// resetNodeScopedRendererState(`Switching to <node>...`), which forwarded that
// same string to clearDashboardMetricsForActiveTarget(message) ->
// clearDashboardForNodeSwitch(message) -> setField("networkDownload"|...|"uptime",
// message). A transient status sentence therefore became a metric reading.
//
// The real functions are extracted from app.js and driven with a fake `setField`
// (the same seam the renderer uses), so the assertions are on the observed field
// values rather than on source text. The node-switch status is still presented
// separately by the friendly summary (selectedSystemStatus / computerStatus) and
// the sidebar footer; this smoke pins only that it never reaches a metric VALUE.
//
// What it does NOT prove: that a live Dashboard renders these fields (no Electron
// is launched), or that the metrics request succeeds for any particular node.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_PATH = path.resolve(__dirname, "..", "app.js");
const source = fs.readFileSync(APP_PATH, "utf8");

function extractFunction(name) {
  const needle = `function ${name}(`;
  const start = source.indexOf(needle);
  assert(start >= 0, `Could not find function ${name} in app.js.`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}.`);
}

function extractConstLine(name) {
  const match = source.match(new RegExp(`^const ${name}\\s*=[^\\n]*$`, "m"));
  if (!match) return null;
  return match[0];
}

const PLACEHOLDERS_DECL = extractConstLine("DASHBOARD_METRIC_PLACEHOLDERS");
assert(PLACEHOLDERS_DECL, "app.js must declare DASHBOARD_METRIC_PLACEHOLDERS.");

const EXTRACTED = [
  "resolveDashboardMetricPlaceholder",
  "clearDashboardForNodeSwitch",
  "clearDashboardMetricsForActiveTarget",
].map(extractFunction).join("\n\n");

// The exact status sentence the acceptance pass observed. Kept as a literal so
// this smoke fails if the string ever becomes an accepted metric value.
const SWITCH_STATUS = "Switching to Windows Desktop...";

// Every metric field the finding named, plus the neighbours the same code path
// writes, so a fix cannot cover only the four it happened to see.
const METRIC_FIELDS = [
  "hostname",
  "platform",
  "cpuModel",
  "cpuCores",
  "memoryAvailable",
  "memoryTotal",
  "diskFree",
  "diskMount",
  "diskTotal",
  "networkUsage",
  "networkDownload",
  "networkUpload",
  "networkTotalDownload",
  "networkTotalUpload",
  "uptime",
];

const FIELDS_NAMED_IN_FINDING = ["networkDownload", "networkUpload", "networkTotalDownload", "networkTotalUpload", "uptime"];

function createHarness() {
  const fields = new Map();
  const context = {
    console,
    setField: (name, value) => fields.set(name, value),
  };
  vm.createContext(context);
  vm.runInContext(
    `${PLACEHOLDERS_DECL}\n${EXTRACTED}\nthis.clearDashboardMetricsForActiveTarget = clearDashboardMetricsForActiveTarget;\nthis.clearDashboardForNodeSwitch = clearDashboardForNodeSwitch;\nthis.resolveDashboardMetricPlaceholder = resolveDashboardMetricPlaceholder;\nthis.DASHBOARD_METRIC_PLACEHOLDERS = DASHBOARD_METRIC_PLACEHOLDERS;`,
    context,
  );
  return { fields, context };
}

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${label}`);
    console.error(`       ${error.message}`);
  }
}

console.log("F1 dashboard metric value placeholder smoke");

// --- 1. The regression itself -------------------------------------------------
check("a node-switch status sentence never becomes a metric value", () => {
  const { fields, context } = createHarness();
  context.clearDashboardMetricsForActiveTarget(SWITCH_STATUS);
  for (const field of METRIC_FIELDS) {
    assert.notStrictEqual(fields.get(field), SWITCH_STATUS, `${field} must not render the node-switch status sentence.`);
    assert(
      context.DASHBOARD_METRIC_PLACEHOLDERS.includes(fields.get(field)),
      `${field} must render a placeholder, got ${JSON.stringify(fields.get(field))}.`,
    );
  }
  for (const field of FIELDS_NAMED_IN_FINDING) {
    assert.strictEqual(fields.get(field), "Checking...", `${field} should show the neutral loading placeholder.`);
  }
});

// --- 2. A genuinely missing metric still renders the placeholder -------------
check("a genuinely missing metric still renders a placeholder, not a blank", () => {
  const { fields, context } = createHarness();
  context.clearDashboardMetricsForActiveTarget("Unavailable");
  for (const field of METRIC_FIELDS) {
    assert.strictEqual(fields.get(field), "Unavailable", `${field} must render the unavailable placeholder.`);
  }
  assert.strictEqual(fields.get("temperature"), "Unavailable", "Temperature must stay honest when unavailable.");
});

check("the no-argument call renders the placeholder, never undefined", () => {
  const { fields, context } = createHarness();
  context.clearDashboardMetricsForActiveTarget();
  for (const field of METRIC_FIELDS) {
    assert.strictEqual(fields.get(field), "Checking...", `${field} must default to the loading placeholder.`);
  }
});

check("clearDashboardForNodeSwitch is guarded on its own call path too", () => {
  const { fields, context } = createHarness();
  context.clearDashboardForNodeSwitch(SWITCH_STATUS);
  assert.strictEqual(fields.get("networkSummary"), "Checking...", "networkSummary must not render a status sentence.");
  assert.strictEqual(fields.get("runtimeUptime"), "Checking...", "runtimeUptime must not render a status sentence.");
});

// --- 3. The resolver only lets honest placeholders through --------------------
check("resolveDashboardMetricPlaceholder accepts only the two honest placeholders", () => {
  const { context } = createHarness();
  assert.strictEqual(context.resolveDashboardMetricPlaceholder("Unavailable"), "Unavailable");
  assert.strictEqual(context.resolveDashboardMetricPlaceholder("Checking..."), "Checking...");
  assert.strictEqual(context.resolveDashboardMetricPlaceholder(SWITCH_STATUS), "Checking...");
  assert.strictEqual(context.resolveDashboardMetricPlaceholder(undefined), "Checking...");
  assert.strictEqual(context.resolveDashboardMetricPlaceholder(""), "Checking...");
});

// --- 4. The node-switch call site must not forward its status message --------
// A static pin is used here only because the call site lives in
// resetNodeScopedRendererState, whose ~120 node-scoped dependencies make an
// extracted execution a stub farm rather than a test. The behavioural half
// above proves the invariant even if this call site regresses.
check("resetNodeScopedRendererState does not forward its status message into metrics", () => {
  assert(
    source.includes("clearDashboardMetricsForActiveTarget(DASHBOARD_METRIC_PLACEHOLDERS[0]);"),
    "The node-switch reset must clear Dashboard metrics to the loading placeholder.",
  );
  assert(
    !source.includes("clearDashboardMetricsForActiveTarget(message);"),
    "The node-switch reset must not pass its transient status message as a metric value.",
  );
});

if (failures) {
  console.error(`\nF1 dashboard metric value placeholder smoke FAILED (${failures} check(s)).`);
  process.exitCode = 1;
} else {
  console.log("\nF1 dashboard metric value placeholder smoke passed.");
}