const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const agentStatus = fs.readFileSync(path.join(root, "src/shared/agentStatus.js"), "utf8");

function requireSource(needle, message) {
  assert(app.includes(needle), message || `app.js is missing ${needle}`);
}

[
  "function syncAgentConnectionDisplayWithSelectedNode",
  'label: "Application Host"',
  'label: "Agent Connected"',
  'label: "Authentication Rejected"',
  'label: "Agent Unavailable"',
  'syncAgentConnectionDisplayWithSelectedNode();',
  "connectionState.state === \"Connected\"",
  "connectionState.state === \"Authentication Required\"",
].forEach((needle) => requireSource(needle, `Top-bar connection state should use explicit selected-node labels: ${needle}`));

[
  "const connectedAgent = remoteNodes.find((node) => getNodeConnectionState(node).state === \"Connected\");",
  "setNodeSummary(\"connected\", connectedAgent ? connectedAgent.displayName || connectedAgent.name || \"Agent\" : \"None\");",
].forEach((needle) => requireSource(needle, `Connected Agent summary must be based on authenticated remote nodes only: ${needle}`));

[
  "const ownsActiveRendererContext = selectedNode.id === getSelectedNodeId();",
  "!ownsActiveRendererContext && [\"resources\", \"storage\", \"dependencies\", \"marketplace-instances\", \"files\", \"operations\", \"diagnostics\"].includes(category.id)",
  "evidence belongs to the active node and is not applied to",
].forEach((needle) => requireSource(needle, `Per-node health must not reuse active-node evidence across node cards/details: ${needle}`));

[
  "const AGENT_STATUS_STATES = Object.freeze",
  "function getAgentStatusSnapshot",
  "return getAgentStatusSnapshot(node);",
  "createNodeBadge(getNodeStatusLabel(node), state)",
].forEach((needle) => requireSource(needle, `Node cards should render from the shared AgentStatus snapshot with one primary badge: ${needle}`));

[
  ["Top-bar indicator", "function getTitlebarConnectionState", "getActiveAgentStatusSnapshot"],
  ["Dashboard", "function getOnboardingAgentSummary", "getAgentStatusSnapshot(target)"],
  ["Nodes", "function getNodeConnectionState", "getAgentStatusSnapshot(node)"],
  ["Agent Control", "function renderAgentControlState", "const agentStatus = getAgentStatusSnapshot(local)"],
  ["Marketplace", "function renderMarketplaceReadiness", "const agentStatus = getActiveAgentStatusSnapshot()"],
  ["Docker", "function getDockerWorkspaceState", "const agentStatus = getActiveAgentStatusSnapshot()"],
  ["Console", "function renderConsoleWorkspace", "setConsoleStatus(\"agent\", getDesktopApiState().hasInstances ? agentStatus.primary : \"Unavailable\")"],
  ["Backups", "function getBackupsConnected", "isAgentStatusAuthenticated(getActiveAgentStatusSnapshot())"],
].forEach(([page, functionNeedle, statusNeedle]) => {
  requireSource(functionNeedle, `${page} should keep its renderer entry point.`);
  requireSource(statusNeedle, `${page} must consume the shared AgentStatus snapshot directly.`);
});

// Files is the exception on purpose: its Folders pill describes the Files
// connection (the storage it has selected, which can be another computer's),
// so it must NOT show the selected computer's Agent status. Build 212
// acceptance found it reading "Connected" for an offline computer's storage.
requireSource("function getFilesFolderStatus", "Files should derive its Folders pill from its own connection.");
requireSource("renderFilesFolderStatus();", "Files should render the pill through renderFilesFolderStatus.");
{
  const start = app.indexOf("function getFilesFolderStatus");
  const body = app.slice(start, app.indexOf("function renderFilesFolderStatus", start));
  assert(!/AgentStatus|agentStatus/.test(body), "The Files Folders pill must not read the selected computer's Agent status.");
}

assert(!app.includes("createNodeBadge(`Connection:"), "Node cards should not render a separate Connection badge.");
assert(!app.includes("createNodeBadge(`Overall:"), "Node cards should not render a separate Overall badge.");
assert(!app.includes("connectionState.key"), "Renderer should not branch on legacy connectionState.key.");

[
  "Authentication Required",
  "Agent Unavailable",
].forEach((needle) => requireSource(needle, `Node status copy should keep auth/offline states distinct: ${needle}`));
assert(agentStatus.includes("Connected to the Agent, but the saved credential was rejected."), "Shared AgentStatus copy must keep auth failures distinct from offline.");

console.log("Node state consistency smoke checks passed.");
