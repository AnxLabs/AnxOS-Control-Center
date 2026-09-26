// Node switching smoke checks.
//
// 2026-09-26 — Node picker background-click dismiss:
//   The node picker popover is anchored directly above the sidebar footer, so
//   while open it overlaps the bottom sidebar nav items (including Settings).
//   The popover click handler must NOT stop propagation for clicks on its
//   non-option background/padding: those clicks fall through to the
//   document-level dismiss and close the popover on the first click (the next
//   click then reaches the previously covered nav item). Only clicks on
//   [data-node-picker-option] keep stopPropagation, and option clicks still
//   select + close. The assertions below pin that contract so an unconditional
//   popover stopPropagation cannot be reintroduced, and a small harness runs
//   the handler extracted from app.js against synthetic events to verify the
//   fall-through/stop behavior itself.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const readText = (filePath) => fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
const appSource = readText(path.join(repoRoot, "app.js"));
const preloadSource = readText(path.join(repoRoot, "preload.js"));
const serviceRouterSource = readText(path.join(repoRoot, "src", "services", "serviceRouter.js"));
const agentClientSource = readText(path.join(repoRoot, "src", "services", "agentClient.js"));
const applicationHostSource = readText(path.join(repoRoot, "src", "services", "applicationHostService.js"));
const nodeServiceSource = readText(path.join(repoRoot, "src", "services", "nodeService.js"));
const indexSource = readText(path.join(repoRoot, "index.html"));

function includesAll(source, snippets, label) {
  for (const snippet of snippets) {
    assert(
      source.includes(snippet),
      `${label} is missing expected node-switch guard: ${snippet}`,
    );
  }
}

function compact(source) {
  return source.replace(/\s+/g, " ");
}

includesAll(appSource, [
  "let selectedNodeContextVersion = 0;",
  "let nodePickerOpen = false;",
  "function getNodeConnectionState",
  "const AGENT_STATUS_STATES = Object.freeze",
  '"Connected"',
  '"Connecting"',
  '"Degraded"',
  '"Authentication Required"',
  '"Offline"',
  "function getNodeConnectionSummary",
  "function getNodeRequestContext",
  "function isNodeRequestCurrent",
  "function getNodeScopedPayload",
  "function isNodeSwitching",
  "function shouldSkipNodeScopedPolling",
  "function createNodeActionContext",
  "function isNodeActionStillCurrent",
  "function resetNodeScopedRendererState",
  "async function reloadActiveNodeData",
  "const activePageName = getActivePageName();",
  "function openNodePicker",
  "function closeNodePicker",
  "function renderNodePicker",
  "function positionNodePicker",
  "selectedNodeContextVersion += 1;",
  "resetNodeScopedRendererState(`Switching to",
], "Renderer");

includesAll(appSource, [
  "function syncNodeSelectorControls",
  "syncNodeSelectorControls();",
  "nodePickerTrigger?.addEventListener(\"click\"",
  "event.stopPropagation();",
  "document.addEventListener(\"click\"",
  "nodePicker?.addEventListener(\"keydown\"",
  "await activateNodePickerOption(nodePickerActiveIndex);",
  "closeNodePicker();\n      await selectNode(node.id || \"application-host\");",
  "sidebarFooter.dataset.agentState = nodeState;",
  "sidebarFooter.dataset.tooltip = `${nodeName} | ${nodeSwitchInProgress ? \"Switching node\" : connectionState.secondary}`;",
  "badge.textContent = node.id === getSelectedNodeId() ? \"Current\" : connectionState.label;",
], "Node picker interaction");

includesAll(compact(appSource), [
  'nodePicker?.addEventListener("click", (event) => { if (!event.target.closest("[data-node-picker-option]")) { return; } event.stopPropagation(); });',
  'option.addEventListener("click", async (event) => { event.stopPropagation(); closeNodePicker(); await selectNode(node.id || "application-host"); });',
], "Node picker background dismiss");
assert(
  !compact(appSource).includes('nodePicker?.addEventListener("click", (event) => { event.stopPropagation(); });'),
  "Node picker must not unconditionally swallow background clicks; clicks outside options must reach the document dismiss.",
);

function extractRegisteredHandler(source, marker, label) {
  const start = source.indexOf(marker);
  assert(start !== -1, `Missing ${label} registration: ${marker}`);
  const end = source.indexOf("});", start);
  assert(end !== -1, `Unterminated ${label} handler: ${marker}`);
  return source.slice(start, end + 3);
}

const nodePickerClickRegistered = {};
const nodePickerClickSnippet = extractRegisteredHandler(
  appSource,
  'nodePicker?.addEventListener("click"',
  "node picker click",
);
new Function("nodePicker", `"use strict";\n${nodePickerClickSnippet}`)({
  addEventListener: (type, handler) => {
    nodePickerClickRegistered[type] = handler;
  },
});
assert.strictEqual(
  typeof nodePickerClickRegistered.click,
  "function",
  "Node picker click handler must register through addEventListener.",
);

function makeNodePickerClickEvent(optionTarget) {
  return {
    stopped: false,
    target: {
      closest: (selector) => (selector === "[data-node-picker-option]" ? optionTarget : null),
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
}

const nodePickerBackgroundClick = makeNodePickerClickEvent(null);
nodePickerClickRegistered.click(nodePickerBackgroundClick);
assert.strictEqual(
  nodePickerBackgroundClick.stopped,
  false,
  "Click on the node picker background must fall through to the document dismiss.",
);
const nodePickerOptionClick = makeNodePickerClickEvent({});
nodePickerClickRegistered.click(nodePickerOptionClick);
assert.strictEqual(
  nodePickerOptionClick.stopped,
  true,
  "Click on a node picker option must keep stopPropagation.",
);

includesAll(appSource, [
  'if (activePageName === "dashboard")',
  'if (activePageName === "marketplace")',
  'if (activePageName === "agent-control")',
  "refreshMarketplaceDownloads()",
  "refreshAgentControl()",
], "Active-view node refresh");

includesAll(appSource, [
  "desktopApiState.api.system.getSnapshot(getNodeScopedPayload(requestContext))",
  "desktopApiState.api.amp.getSnapshot(getNodeScopedPayload(requestContext))",
  "desktopApiState.api.publicAccess.getSnapshot(payload)",
  "desktopApiState.api.playit.getSnapshot(payload)",
  "desktopApiState.api.docker.getSnapshot(getNodeScopedPayload(requestContext))",
  "desktopApiState.api.instances.list(getNodeScopedPayload(requestContext))",
  "desktopApiState.api.backups.list(getNodeScopedPayload(requestContext))",
  "desktopApiState.api.security.getDashboard(getNodeScopedPayload(requestContext))",
], "Node-scoped refresh");

includesAll(appSource, [
  "if (!isNodeRequestCurrent(requestContext))",
  "requestInstanceId !== selectedInstanceId",
  "getActiveConsoleInstance()?.id !== requestInstanceId",
], "Stale response protection");

includesAll(compact(appSource), [
  "const requestSerial = ++systemRequestSerial; activeSystemRequestSerial = requestSerial;",
  "if (activeSystemRequestSerial === requestSerial) { markStartupReady(\"system\"); systemRequestInFlight = false; activeSystemRequestSerial = 0;",
  "systemRequestInFlight = false; activeSystemRequestSerial = 0;",
  "if (isNodeRequestCurrent(requestContext)) { instancesRequestInFlight = false;",
  "if (isNodeRequestCurrent(requestContext)) { backupRequestInFlight = false;",
  // Docker releases its in-flight flag unconditionally in the finally block so a
  // node switch mid-request cannot deadlock refreshes; only the UI finalizers are
  // guarded by current node + serial context.
  "dockerRequestInFlight = false; if (isNodeRequestCurrent(requestContext) && requestId === dockerRequestSerial) {",
], "Request ownership and current-context finalizers");

includesAll(appSource, [
  "!shouldSkipNodeScopedPolling() && getActivePageName() === \"dashboard\"",
  "!shouldSkipNodeScopedPolling() && [\"dashboard\", \"amp\", \"minecraft\"].includes(getActivePageName())",
  "!shouldSkipNodeScopedPolling() && [\"dashboard\", \"playit\"].includes(getActivePageName())",
  "if (shouldSkipNodeScopedPolling()) return;",
], "Node-scoped polling");

includesAll(appSource, [
  "const previousNodesState = {",
  "const persistedState = await desktopApiState.api.nodes.select(nodesState.selectedNodeId);",
  "nodesState = previousNodesState;",
  "return { changed: false, selectedNodeId: previousNodeId };",
  "return { changed: true, selectedNodeId: getSelectedNodeId() };",
  "showToast(normalizeIpcErrorMessage(error, \"Node could not be selected.\"), \"warning\");",
  "nodeSwitchInProgress = true;",
  "const switchGeneration = ++nodeSwitchGeneration;",
  "if (switchGeneration === nodeSwitchGeneration) {",
  "Unconditionally leave the \"switching\" state",
  "nodeSwitchInProgress = false;",
  "Selected node was unavailable. Switched to",
  "getFriendlyErrorMessage(result.message || \"Node unavailable.\")",
], "Node switch persistence and completion");

assert(
  !appSource.includes("nodesState.selectedNodeId = node.id || nodesState.selectedNodeId;"),
  "Global search and secondary selectors must not mutate selectedNodeId outside selectNode().",
);

includesAll(appSource, [
  "function renderLocalAgentSystems",
  "getLocalApplicationHostNode",
  "Stable ID application-host",
  "Local Application Host",
  "Local Agent Service",
  "renderRemoteAgents(payload?.remote || [])",
], "Agent Control local and remote system identity");

includesAll(applicationHostSource, [
  "cpu: {",
  "memory: {",
  "storage: {",
  "desktopUptimeSeconds",
  "electronVersion",
  "appVersion",
  "developerMode",
  "runningState: \"running\"",
], "Application host first-class identity");

includesAll(indexSource, [
  'data-node-detail="cpu"',
  'data-node-detail="memory"',
  'data-node-detail="storage"',
  'data-node-detail="desktopUptime"',
  'data-node-detail="electronVersion"',
  'data-node-detail="appVersion"',
  'data-node-detail="developerMode"',
  'data-node-detail="runningState"',
  'data-node-detail="unsupportedFeatures"',
], "Node Details desktop identity fields");

includesAll(appSource, [
  "formatNodeCpu",
  "formatNodeMemory",
  "formatNodeStorage",
  "getNodeUnsupportedFeatureSummary",
  "Unsupported here: Docker workspace controls require an Agent node.",
  "Remote Agent APIs, Agent token management, and remote Docker controls require an Agent node.",
], "Renderer desktop Node Details identity");

includesAll(appSource, [
  "const requestContext = createNodeActionContext(\"backup-create\");",
  "const requestContext = createNodeActionContext(`docker-${actionName}`);",
  "const requestContext = createNodeActionContext(\"instance-create\");",
  "const requestContext = createNodeActionContext(`instance-${actionName}`);",
  "const requestContext = createNodeActionContext(\"console-command\");",
  "if (!isNodeActionStillCurrent(requestContext)) return;",
], "Node action targeting");

includesAll(preloadSource, [
  "system: {\n    getSnapshot: (payload = {})",
  "amp: {\n    getSnapshot: (payload = {})",
  "playit: {\n    getSnapshot: (payload = {})",
  "publicAccess: {\n    getSnapshot: (payload = {})",
  "getMetrics: (instanceId, options = {})",
  "listSchedules: (payload = {})",
], "Preload bridge");

includesAll(serviceRouterSource, [
  "async function getPlayitSnapshot(options = {})",
  "async function getAmpSnapshot(options = {})",
  "return withNodeContext(await agentClient.listBackups(options, getOptionalNodeConfig(options)), nodeId);",
  "return withNodeContext(await agentClient.createBackup(payload, getOptionalNodeConfig(payload)), nodeId);",
], "Service router");

includesAll(nodeServiceSource, [
  "function buildNodeCapabilities",
  "serviceControls: localAgent",
  "remoteAgent: !localAgent",
  "Local Agent service controls only apply to This PC.",
  "capabilities: buildNodeCapabilities(node)",
  "capabilities: buildNodeCapabilities(node)",
], "Shared node capabilities");

includesAll(agentClientSource, [
  "async function getPlayitSnapshot(configOverride = null)",
  "async function getAmpSnapshot(configOverride = null)",
  "async function listBackups(options = {}, configOverride = null)",
  "async function downloadBackup(backupId, configOverride = null)",
], "Agent client");

console.log("Node switching smoke checks passed.");
