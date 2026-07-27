const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const nodeService = fs.readFileSync(path.join(root, "src", "services", "nodeService.js"), "utf8");
const agentHealth = fs.readFileSync(path.join(root, "agent", "src", "routes", "health.js"), "utf8");

function requireIndex(needle, message) {
  assert(index.includes(needle), message || `index.html is missing ${needle}`);
}

function requireApp(needle, message) {
  assert(app.includes(needle), message || `app.js is missing ${needle}`);
}

[
  "data-node-health-overview",
  "data-node-health-status",
  "data-node-health-updated",
  "data-node-health-categories",
  "data-node-health-issues",
  "node-health-overview",
  "node-health-categories",
  "node-health-issues",
  "node-details-header",
  "data-node-details-summary",
  "node-health-subsection",
  "node-technical-details",
  "Node Health",
  "Detected Issues",
  "Technical details",
  "Fix All is intentionally unavailable",
  'aria-label="Node health categories"',
  'aria-label="Detected node health issues"',
].forEach((needle) => requireIndex(needle, `Node health UI should expose ${needle}.`));

[
  "NODE_HEALTH_STALE_MS",
  "NODE_HEALTH_RESOURCE_THRESHOLDS",
  "cpuWarningPercent: 90",
  "memoryWarningPercent: 90",
  "diskWarningPercent: 85",
  "diskCriticalPercent: 95",
  "diskCriticalFreeBytes: 2 * 1024 * 1024 * 1024",
  "latencyWarningMs: 1000",
  "NODE_HEALTH_SEVERITY_RANK",
  "NODE_HEALTH_CATEGORY_STATES",
  "function aggregateNodeHealthCategories",
  "function getNodeHealthIssueCategories",
  "function getSharedNodeHealthModel",
  "function getNodeHealthApplicability",
  "function getNodeHealthCacheKey",
  "nodeHealthGeneration",
  "nodeHealthSnapshotCache",
  "function buildNodeHealthModel",
  "function buildConnectivityHealth",
  'connectionState.state === "Authentication Required"',
  "`${connectionState.primary}: ${connectionState.secondary}`",
  'remediation: "Test connection"',
  "function buildAgentHealth",
  "function buildDesktopRuntimeHealth",
  "function buildResourceHealth",
  "function buildStorageHealth",
  "function buildDependencyHealth",
  "function buildMarketplaceHealth",
  "function buildFilesHealth",
  "function buildOperationsHealth",
  "function buildDiagnosticsHealth",
  "function buildUpdatesHealth",
  "function buildMaintenanceHealth",
].forEach((needle) => requireApp(needle, `Node health model should include ${needle}.`));

[
  "function buildAgentCapabilities",
  "supportsGameServers",
  "supportsFileRoots",
  "Windows game-server hosting is planned for a later build.",
].forEach((needle) => assert(agentHealth.includes(needle), `Agent health must report Windows MVP capabilities with ${needle}.`));

[
  "function normalizeAgentCapabilitiesMetadata",
  "function getNodeReportedCapabilities",
  "windowsMvp",
  "Windows game-server hosting is coming later.",
  "Windows Agent MVP nodes unless configured separately.",
].forEach((needle) => assert(nodeService.includes(needle), `Node service must preserve Windows Agent MVP capabilities with ${needle}.`));

[
  'new Set(["Healthy", "Warning", "Degraded", "Unknown", "Unavailable", "Not Tested"])',
  'state: warnings ? "Warning" : scanned ? "Healthy" : "Not Tested"',
  'if (text === "warning" || text === "needs attention") return "Warning"',
  'text === "blocked" || text === "critical" || text === "offline"',
  'if (text === "not tested" || text === "not-tested") return "Not Tested"',
  'const finalState = currentIssueCount <= 0 && ["Warning", "Degraded"].includes(normalizedState)',
  "const currentIssueCategories = getNodeHealthIssueCategories(categories)",
  "const issueCount = currentIssueCategories.reduce",
  "historicalIssueCount: failed.length",
  "activeFailed.length",
  "applicability.agentNode && [\"updates\", \"maintenance\"].includes(category.id)",
  "aggregateNodeHealthCategories(categories)",
  "category.applicable !== false",
  "category.current !== false",
  "!category.stale",
  "No current health issues detected",
  "historicalIssueCount",
  "notTestedCount",
  "unavailableCount",
  "health.currentIssueCategories || getNodeHealthIssueCategories(health.categories)",
  "generation !== nodeHealthGeneration",
  "nodeHealthSnapshotCache.set(health.cacheKey, health)",
  "`${kind}:${id}`",
].forEach((needle) => requireApp(needle, `Deterministic node health rules should include ${needle}.`));

[
  "latestSystemSnapshot",
  "latestSystemSnapshotAt",
  "latestSystemSnapshotNodeId",
  "function hasSystemSnapshotForNode",
  "function getSystemSnapshotForNode",
  "latestInstancesSnapshotAt",
  "latestFilesListingAt",
  "latestDependencyResult",
  "latestDependencyResultAt",
  "renderDependencyStatus",
  "renderSnapshot",
  "renderInstancesSnapshot",
  "renderFileListing",
].forEach((needle) => requireApp(needle, `Node health should reuse existing state from ${needle}.`));

[
  "AGENT_PORT_IN_USE",
  "Authentication failed",
  "Agent unavailable",
  "applyCanonicalNodeStateSnapshot(payload?.nodeState, requestContext)",
  "Re-pair Agent",
  "Repair Connection",
  "The selected system is offline or unreachable.",
  "Reconnect the system or select another available system.",
  "Checking the Agent connection.",
  "Version unavailable",
  "Port conflict detected",
  "CPU and memory unavailable",
  "Disk metrics unavailable",
  "File service unavailable",
  "groupDiagnosticIssues(agentLogEntries)",
].forEach((needle) => requireApp(needle, `Node health should cover ${needle}.`));

[
  'id: "nodeHealth.open"',
  'id: "nodeHealth.refresh"',
  'id: "nodeHealth.unhealthy"',
  'id: "dependencies.recheck"',
  "Node Health: ${health.state}",
  "node health agent dependency resource storage diagnostics operations files maintenance updates marketplace",
].forEach((needle) => requireApp(needle, `Node health search/command integration should include ${needle}.`));

[
  "syncNodeHealthNotifications",
  "dedupKey: `node-health:${health.nodeId}:${health.state}`",
  "dedupKey: `node-health:${health.nodeId}:recovered`",
  "relatedWorkspace: \"nodes\"",
].forEach((needle) => requireApp(needle, `Node health notifications should include ${needle}.`));

[
  "runNodeHealthAction",
  "renderNodeHealthActions",
  "testSelectedNode()",
  "testAgentConnection({ silent: false })",
  "refreshAgentControl({ includeConfig: true })",
  "runDependencyAction(\"check\")",
  "runDependencyAction(\"install\")",
  "runAgentControlAction(\"runDiagnostics\")",
  "refreshDashboard()",
  "selectInstanceStatusFilter(\"running\")",
  "selectOperationFilter(\"failed\")",
  "runDiagnosticsAction(\"export\")",
  "setActiveSettingsCategory(category, selector)",
  "refreshCurrentFilesDirectory()",
  "showPage(\"operations\")",
  "showPage(\"agent-control\")",
  "showPage(\"files\")",
  "showPage(\"maintenance\")",
  "checkForUpdates({ silent: false })",
  "openNodeDetails(getSelectedNodeId())",
].forEach((needle) => requireApp(needle, `Node health remediation should reuse ${needle}.`));

[
  'id: "desktop-runtime"',
  'label: "Desktop runtime"',
  "Desktop runtime health applies only to the local application host.",
  "Desktop uptime",
  "Electron",
  "Developer Mode",
  "buildDesktopRuntimeHealth(selectedNode)",
  "latestSystemSnapshotNodeId === (node?.id || getSelectedNodeId() || \"application-host\")",
  "renderSnapshot(snapshot, requestContext.nodeId)",
].forEach((needle) => requireApp(needle, `Desktop node health should include ${needle}.`));

[
  "Test connection",
  "Ping Agent",
  "Open Agent Control",
  "Open Dashboard",
  "Live Metrics",
  "Open Files",
  "Storage usage",
  "Open Marketplace",
  "View running instances",
  "Check dependencies",
  "Prepare node",
  "Open Operations",
  "Failed operations",
  "Open Diagnostics",
  "Export bundle",
  "Open Maintenance",
  "Open Updates",
].forEach((needle) => requireApp(needle, `Node health cards should expose ${needle}.`));

[
  "getNodeHealthBreakdown",
  "splitNodeHealthEvidence",
  "createNodeHealthDetails",
  "sortNodeHealthIssues",
  "node-health-summary-text",
  "node-health-long-value",
  "Copy details",
  "document.createElement(\"article\")",
  "nodeHealthCategories.replaceChildren()",
  "nodeHealthIssues.replaceChildren()",
  "createTextElement(\"strong\", category.label)",
  "action.setAttribute(\"aria-label\"",
  "actions.forEach((entry)",
  "event.target.closest(\"[data-node-health-action]\")",
].forEach((needle) => requireApp(needle, `Node health rendering should be safe and accessible with ${needle}.`));

[
  ".node-health-overview",
  "repeat(auto-fit, minmax(min(100%, 128px), 1fr))",
  ".node-health-categories",
  "repeat(auto-fit, minmax(min(100%, 260px), 1fr))",
  ".node-health-issues",
  "repeat(auto-fit, minmax(min(100%, 320px), 1fr))",
  ".node-technical-details",
  ".node-details-header",
  "grid-template-columns: minmax(0, 1fr) auto auto",
  "overflow-x: hidden",
  ".node-health-summary-text",
  "-webkit-line-clamp: 2",
  ".node-health-long-value",
  "text-overflow: ellipsis",
  "width: min(980px, calc(100vw - 28px))",
  "@media (prefers-reduced-motion: reduce)",
].forEach((needle) => assert(styles.includes(needle), `Node health polish CSS should include ${needle}.`));

assert(!index.includes("owner-page-rail"), "Node details drawer must not introduce a permanent side rail.");
assert(!app.includes("nodeHealthCategories.innerHTML"), "Node health categories must not use raw HTML injection.");
assert(!app.includes("nodeHealthIssues.innerHTML"), "Node health issues must not use raw HTML injection.");
assert(!app.includes("security score") && !app.includes("health score"), "Node health should not add fake numeric scores.");
assert(!index.includes("data-node-health-fix-all"), "Unsupported Fix All bulk remediation should remain omitted.");
assert(app.includes("refreshNodeHealth({ notify: false })"), "Node health should support quiet refreshes to avoid notification floods.");

console.log("Node health smoke checks passed.");
