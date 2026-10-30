const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
// Normalize CRLF to LF so assertions match on both Unix and Windows checkouts
// regardless of Git autocrlf.
const normalize = (value) => value.replace(/\r\n/g, "\n");
const readSource = (relativePath) => normalize(fs.readFileSync(path.join(root, relativePath), "utf8"));

const index = readSource("index.html");
const app = readSource("app.js");
const styles = readSource("styles.css");

// assertOnce proves a hook is not duplicated; the negative lookahead keeps
// attribute prefixes (`data-instance-network-graph` vs `...-graph-empty`) from
// counting as the same hook.
function assertOnce(haystack, needle, label) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...haystack.matchAll(new RegExp(`${escaped}(?![\\w-])`, "g"))].length;
  assert.strictEqual(matches, 1, `${label} must appear exactly once (found ${matches}).`);
}

function assertClassDefined(selector, label) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert(new RegExp(`${escaped}(?![\\w-])`).test(styles), `${label} must be defined in styles.css (${selector}).`);
}

// ---------------------------------------------------------------------------
// 1. Instance workspace tabs, panels, and hook placement
//
// Tab placement decision: the instance smokes pin only one relation —
// scripts/minecraft-players-smoke.js requires Players before Files. No smoke
// pins Network/Performance, so the unpinned preference applies: Network is
// inserted immediately after Console and Performance immediately after
// Network, which preserves Players-before-Files.
// ---------------------------------------------------------------------------
assertOnce(index, 'data-instance-tab="network"', "Instance Network tab button");
assertOnce(index, 'data-instance-tab="performance"', "Instance Performance tab button");
assertOnce(index, 'data-instance-panel="network"', "Instance Network panel");
assertOnce(index, 'data-instance-panel="performance"', "Instance Performance panel");

const tabOrder = ["overview", "console", "network", "performance", "players", "files", "backups", "settings"]
  .map((tab) => index.indexOf(`data-instance-tab="${tab}"`));
tabOrder.forEach((position, indexInOrder) => {
  assert(position > -1, `Missing instance tab: ${["overview", "console", "network", "performance", "players", "files", "backups", "settings"][indexInOrder]}`);
  if (indexInOrder > 0) {
    assert(position > tabOrder[indexInOrder - 1], "Instance tabs must stay in the documented order: Network after Console, Performance after Network, Players before Files.");
  }
});
assert(
  index.indexOf('data-instance-tab="players"') < index.indexOf('data-instance-tab="files"'),
  "The pinned Players-before-Files instance tab order must be preserved.",
);
assert(
  index.indexOf('data-instance-panel="network"') < index.indexOf('data-instance-panel="players"'),
  "The Network panel must sit before the Players panel in the workspace card.",
);
assert(
  index.indexOf('data-instance-panel="performance"') < index.indexOf('data-instance-panel="players"'),
  "The Performance panel must sit before the Players panel in the workspace card.",
);

["add-endpoint", "discover", "sync-provider", "run-diagnostics", "copy-address"].forEach((action) => {
  assertOnce(index, `data-instance-network-action="${action}"`, `Instance Network action ${action}`);
});
["1h", "6h", "24h", "7d"].forEach((range) => {
  assertOnce(index, `data-instance-telemetry-range="${range}"`, `Instance telemetry range ${range}`);
});

assertOnce(index, "data-instance-network-endpoints", "Instance Network endpoints list hook");
assertOnce(index, "data-instance-network-empty", "Instance Network empty state hook");
assertOnce(index, "data-instance-network-status", "Instance Network status hook");
assertOnce(index, "data-instance-network-unsupported", "Instance Network unsupported state hook");
assertOnce(index, "data-instance-network-unsupported-detail", "Instance Network unsupported detail hook");
assertOnce(index, "data-instance-network-diagnostics", "Instance Network diagnostics container hook");
assertOnce(index, "data-instance-network-diagnostics-summary", "Instance Network diagnostics summary hook");
assertOnce(index, "data-instance-network-diagnostics-scopes", "Instance Network diagnostics scopes hook");
assertOnce(index, "data-instance-network-diagnostics-stages", "Instance Network diagnostics stages hook");
assertOnce(index, "data-instance-network-graph", "Instance Network graph container hook");
assertOnce(index, "data-instance-network-graph-empty", "Instance Network graph empty hook");
assertOnce(index, "data-instance-telemetry-summary", "Instance telemetry summary hook");
assertOnce(index, "data-instance-telemetry-charts", "Instance telemetry charts hook");
assertOnce(index, "data-instance-telemetry-empty", "Instance telemetry empty hook");
assertOnce(index, "data-instance-telemetry-status", "Instance telemetry status hook");

assert(
  index.includes('data-instance-network-status role="status" aria-live="polite"'),
  "The instance Network status line must be a polite live region.",
);
assert(
  index.includes('data-instance-telemetry-status role="status"'),
  "The instance telemetry status line must be a status region.",
);
assert(index.includes("data-instance-network-diagnostics hidden"), "The instance diagnostics panel must start hidden.");
assert(/data-instance-network-graph hidden/.test(index), "The instance graph container must start hidden.");
assert(index.includes("data-instance-network-graph-empty"), "The instance graph empty state must exist.");
assert(index.includes("data-instance-network-empty hidden"), "The instance endpoint empty state must start hidden.");
assert(index.includes("data-instance-telemetry-empty hidden"), "The instance telemetry empty state must start hidden.");
assert(index.includes("data-instance-network-unsupported hidden"), "The unsupported state must start hidden.");
assert(
  index.includes("Endpoints are not supported for this service on this computer."),
  "The unsupported endpoint state must render the explicit capability message.",
);
assert(
  /data-endpoint-picker-empty[^>]*hidden/.test(index) && index.includes("No endpoints configured for this service yet."),
  "The endpoint picker must carry a hidden empty state.",
);
assert(index.includes("No telemetry samples yet for this service."), "The telemetry empty state message must be pinned.");
assert(
  index.includes('data-instance-telemetry-range="6h" aria-pressed="true"'),
  "The 6h telemetry range must be the default pressed option.",
);
["1h", "24h", "7d"].forEach((range) => {
  assert(
    index.includes(`data-instance-telemetry-range="${range}" aria-pressed="false"`),
    `The ${range} telemetry range must declare aria-pressed=false until selected.`,
  );
});

// ---------------------------------------------------------------------------
// 2. Endpoint picker modal markup: modal roles, title, list, actions, empty
// ---------------------------------------------------------------------------
const pickerStart = index.indexOf("data-instance-endpoint-picker");
assert(pickerStart > -1, "Missing instance endpoint picker backdrop.");
const pickerEnd = index.indexOf('<div class="app-modal-backdrop app-modal-backdrop--drawer"', pickerStart);
assert(pickerEnd > pickerStart, "The endpoint picker must appear before the node details drawer.");
const pickerSource = index.slice(pickerStart, pickerEnd);
assert(pickerSource.includes('role="dialog" aria-modal="true"'), "The endpoint picker must be a modal dialog.");
assert(pickerSource.includes('aria-labelledby="instance-endpoint-picker-title"'), "The endpoint picker must be labelled by its title.");
assert(pickerSource.includes('id="instance-endpoint-picker-title"'), "The endpoint picker title id must exist.");
assert(pickerSource.includes("data-instance-endpoint-picker-title"), "The endpoint picker title must be addressable.");
assert(pickerSource.includes('tabindex="-1"'), "The endpoint picker must be programmatically focusable.");
assert(pickerSource.includes("data-endpoint-picker-list"), "The endpoint picker must contain its choice list.");
assert(pickerSource.includes("data-endpoint-picker-empty"), "The endpoint picker must contain its empty state.");
["copy", "cancel", "manage"].forEach((action) => {
  assert(
    pickerSource.includes(`data-endpoint-picker-action="${action}"`),
    `The endpoint picker must expose the ${action} action.`,
  );
});
assert(
  pickerSource.includes("data-endpoint-picker-action=\"share-details\""),
  "The endpoint picker must offer Share details… for the share purpose.",
);
assert(
  index.indexOf("data-instance-endpoint-picker") < index.indexOf('<div class="app-modal-backdrop app-modal-backdrop--drawer"'),
  "The endpoint picker must appear before the node details drawer.",
);

// ---------------------------------------------------------------------------
// 3. Frozen renderer function surface
// ---------------------------------------------------------------------------
[
  "function refreshInstanceNetworkTab(instanceId)",
  "function renderInstanceNetworkTab(instanceId)",
  "function handleInstanceNetworkAction(action)",
  "function refreshInstanceNetworkDiagnostics(instanceId, endpointId)",
  "function renderInstanceNetworkDiagnostics(result)",
  "function renderInstanceNetworkGraph(result)",
  "function refreshInstancePerformanceTab(instanceId)",
  "function renderInstancePerformanceTab(instanceId)",
  "function openInstanceEndpointPicker(instanceId, purpose = \"copy\"",
  "function closeInstanceEndpointPicker()",
  "function handleInstanceEndpointPickerChoice(value)",
].forEach((needle) => assert(app.includes(needle), `Frozen function surface is missing: ${needle}`));
assert(app.includes("function renderTelemetrySparkline(container, samples, options = {})"), "renderTelemetrySparkline must be frozen.");

// ---------------------------------------------------------------------------
// 4. Lazy tab loading in setActiveInstanceTab (no polling)
// ---------------------------------------------------------------------------
const tabStart = app.indexOf("function setActiveInstanceTab(");
const tabEnd = app.indexOf("function stringifyArgs(");
assert(tabStart > -1 && tabEnd > tabStart, "setActiveInstanceTab must exist.");
const tabSource = app.slice(tabStart, tabEnd);
assert(
  tabSource.includes('activeInstanceTab === "network"') && tabSource.includes("refreshInstanceNetworkTab(selectedInstanceId);"),
  "setActiveInstanceTab must lazily refresh the Network tab.",
);
assert(
  tabSource.includes('activeInstanceTab === "performance"') && tabSource.includes("refreshInstancePerformanceTab(selectedInstanceId);"),
  "setActiveInstanceTab must lazily refresh the Performance tab.",
);
assert(
  !/registerRefreshTask\([^)]*refreshInstance(?:Network|Performance)Tab/.test(app),
  "Instance Network/Performance tabs must not be registered as pollers.",
);

// ---------------------------------------------------------------------------
// 5. Telemetry key format and range constants
// ---------------------------------------------------------------------------
assert(
  app.includes("const prefix = `instance:${nodeId}:${instanceId}`"),
  "The renderer must replicate the canonical telemetry series key prefix.",
);
["cpuPercent", "memoryRssBytes", "uptimeSeconds"].forEach((metric) => {
  assert(
    app.includes(`\${prefix}:${metric}`),
    `The canonical telemetry key for ${metric} must be present.`,
  );
});
assert(
  app.includes("instanceSeriesKey") && app.includes("src/shared/telemetryStore.js"),
  "The canonical key format must be documented against its source of truth.",
);
[["1h", "3600000"], ["6h", "21600000"], ["24h", "86400000"], ["7d", "604800000"]].forEach(([range, sinceMs]) => {
  assert(
    app.includes(`id: "${range}"`) && app.includes(`sinceMs: ${sinceMs}`),
    `The ${range} telemetry range must map to sinceMs ${sinceMs}.`,
  );
});
assert(app.includes("function setInstanceTelemetryRange("), "The telemetry range control must be wired to a setter.");
assert(
  app.includes('button.setAttribute("aria-pressed", active ? "true" : "false")'),
  "Telemetry range buttons must expose aria-pressed state.",
);

// ---------------------------------------------------------------------------
// 6. Endpoint picker choice wiring and inspector action rewiring
// ---------------------------------------------------------------------------
assert(
  app.includes('presentation.buildEndpointChoices(endpoints, { serviceId: targetId, preferScope })'),
  "Picker choices must come from the shared presentation buildEndpointChoices.",
);
assert(
  app.includes('const preferScope = normalizedPurpose === "share" ? "public" : "lan";'),
  "Picker scope preference must be public for share and lan for copy.",
);
assert(
  app.includes("function buildInstanceEndpointPickerFallbackChoices("),
  "A minimal fallback choice builder must exist for builds without the presentation module.",
);

const runStart = app.indexOf("async function runInstanceAction(");
const runEnd = app.indexOf('if (actionName === "repair-neoforge-runtime")', runStart);
assert(runStart > -1 && runEnd > runStart, "runInstanceAction must exist with its repair branch intact.");
const runSource = app.slice(runStart, runEnd);
assert(
  runSource.includes('tryOpenInstanceEndpointPicker(selectedInstance, "copy")')
    && runSource.indexOf('tryOpenInstanceEndpointPicker(selectedInstance, "copy")') < runSource.indexOf("copyInstanceAccessAddress(selectedInstance)"),
  "copy-access-address must try the endpoint picker before the legacy copy fallback.",
);
assert(
  runSource.includes('tryOpenInstanceEndpointPicker(selectedInstance, "share")'),
  "expose-share and share-server must try the endpoint picker with the share purpose.",
);
assert(
  runSource.includes('pickerOutcome === "empty"') && runSource.includes("No endpoints configured — copied the legacy address."),
  "The legacy copy toast must be preserved and only claim an empty endpoint list when the registry said so.",
);
assert(
  runSource.includes("createAccessServiceForInstance(selectedInstance)"),
  "expose-share legacy behavior must remain the fallback.",
);
assert(
  runSource.includes("openShareServerModal(selectedInstance)"),
  "share-server legacy behavior must remain the fallback.",
);

// ---------------------------------------------------------------------------
// 7. Capability honesty and defensive bridge calls
// ---------------------------------------------------------------------------
const regionStart = app.indexOf("function getInstanceNetworkSupportFailure(");
const regionEnd = app.indexOf("function syncFleetControls(");
assert(regionStart > -1 && regionEnd > regionStart, "The instance Network/Performance region must be identifiable.");
const region = app.slice(regionStart, regionEnd);
assert(region.includes("function refreshInstanceNetworkTab("), "The region slice must cover the new instance tab block.");
["typeof api?.endpoints?.list !== \"function\"", "typeof api?.endpoints?.discover !== \"function\"", "typeof api?.providers?.sync === \"function\"", "typeof api?.telemetry?.getSeries !== \"function\"", "typeof api?.connectivity?.runDiagnostics !== \"function\""]
  .forEach((needle) => assert(region.includes(needle), `Defensive capability check is missing: ${needle}`));
assert(region.includes("Discovery is unavailable in this build."), "Missing discover channel must render the friendly fallback.");
assert(region.includes("Provider sync is unavailable in this build."), "Missing provider sync must render the friendly fallback.");
assert(
  region.includes("INSTANCE_NETWORK_UNSUPPORTED_MESSAGE") && region.includes("Boolean(supportFailure)"),
  "The empty state must defer to the unsupported/degraded state instead of faking empty.",
);
assert(
  region.includes("buildNetworkEndpointCard(endpoint)"),
  "The instance Network tab must reuse the shared endpoint card renderer.",
);
assert(
  region.includes("summarizeConnectivity(") && region.includes("formatDiagnosticsEvidence("),
  "Instance diagnostics must reuse the shared presentation helpers.",
);
assert(
  region.includes('return "opened"') && region.includes('return "empty"') && region.includes('return "unavailable"'),
  "The endpoint picker helper must report opened/empty/unavailable honestly.",
);
assert(
  /if \(result\?\.state === "unsupported"\) \{[\s\S]{0,400}?state\.unsupported = true;/.test(region),
  "Discovery reporting unsupported must drive the unsupported state directly.",
);

// The new region is textContent-only: no innerHTML anywhere, and no browser
// confirm/alert/prompt dialogs.
assert(!region.includes("innerHTML"), "The new instance Network/Performance region must not use innerHTML.");
assert(!/\bwindow\.(confirm|alert|prompt)\b/.test(region), "The new region must not use browser dialogs.");
assert(
  region.includes('document.createElementNS("http://www.w3.org/2000/svg"'),
  "The telemetry sparkline must be built as inline SVG with document.createElementNS.",
);
assert(region.includes('"connectivity-state-pill"'), "Picker scope pills must reuse the connectivity state pill class.");

// ---------------------------------------------------------------------------
// 8. Styles: semantic-token classes, 980/720 responsiveness, reduced motion
// ---------------------------------------------------------------------------
[
  ".instance-network-tab",
  ".instance-telemetry-tab",
  ".instance-telemetry-ranges",
  ".instance-telemetry-range",
  ".instance-telemetry-summary",
  ".instance-telemetry-summary-card",
  ".instance-telemetry-charts",
  ".telemetry-sparkline",
  ".telemetry-sparkline__svg",
  ".telemetry-sparkline__line",
  ".telemetry-sparkline__gap",
  ".telemetry-sparkline__latest",
  ".endpoint-picker-list",
  ".endpoint-picker-choice",
  ".endpoint-picker-choice__address",
  ".app-modal--endpoint-picker",
].forEach((selector) => assertClassDefined(selector, "Instance Network/Performance class"));

const cssMarker = styles.indexOf("Instance workspace Network + Performance tabs, and the endpoint picker");
assert(cssMarker > -1, "The instance Network/Performance CSS block must exist.");
const cssEndMarker = styles.indexOf(".app-modal-backdrop--drawer", cssMarker);
assert(cssEndMarker > cssMarker, "The instance Network/Performance CSS block must be delimited.");
const cssRegion = styles.slice(cssMarker, cssEndMarker);
assert(cssRegion.includes("@media (max-width: 980px)"), "The instance tab styles must respond at 980px.");
assert(cssRegion.includes("@media (max-width: 720px)"), "The instance tab styles must respond at 720px.");
assert(cssRegion.includes(".instance-telemetry-summary"), "The 980/720 rules must cover the telemetry summary grid.");
assert(cssRegion.includes(".instance-telemetry-ranges"), "The 720 rule must cover the telemetry range control.");
assert(
  cssRegion.includes('html[data-reduce-motion="true"] .endpoint-picker-choice'),
  "The endpoint picker motion must respect reduced motion.",
);
assert(!/rgba?\(/.test(cssRegion), "The new styles must use semantic tokens, not raw rgb/rgba colors.");
assert(!/#[0-9a-fA-F]{3,8}\b/.test(cssRegion), "The new styles must use semantic tokens, not raw hex colors.");

console.log("Instance network/performance UI smoke checks passed.");
