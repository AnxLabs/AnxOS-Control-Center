const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const nodeService = fs.readFileSync(path.join(root, "src", "services", "nodeService.js"), "utf8");

[
  "const LOCAL_AGENT_HOSTS = [\"127.0.0.1\", \"localhost\"]",
  "const LOCAL_AGENT_DISPLAY_NAME = \"This PC\"",
  "function isLocalAgentUrl",
  "function getLocalAgentUrls",
  "function createLocalAgentConnectionStatus",
  "function buildLocalNodeProfile",
  "function getLocalIpAddresses",
  "function summarizeDependencyReadiness",
  "async function discoverLocalAgentNode",
  "async function withDiscoveredLocalAgent",
  "localAgent: true",
  "ownerMachine: true",
  "\"Authentication Required\"",
  "desktopApplication: \"running\"",
  "remoteAvailability: \"not-remote\"",
  "versionCompatibility",
  "dependencyReadiness",
  "instanceCount",
  "localIpAddresses",
  "customDisplayName",
  "stableNodeId",
  // Only a loopback URL on the Local Agent's own port is this PC; a tunneled
  // remote node (127.0.0.1 on another port) is not (node-tunnel-not-local-smoke).
  "isExplicitLocalAgentNode(node) || isThisPcAgentUrl(node.agentUrl)",
  "return isLocalAgentUrl(url) && getLocalAgentPortFromUrl(url) === getLocalAgentPort();",
  "selectedRemoteNode",
  "shouldDefaultToLocal",
  "mergeAgentNodes([",
  "agentToken: node.agentToken || hasNodeToken(node.id) ? \"[configured]\" : \"\"",
  "modeLabel: getAgentNodeModeLabel(node)",
  "Registered Local Agent Node",
].forEach((needle) => {
  assert(nodeService.includes(needle), `Local Agent discovery source should include ${needle}.`);
});

assert(
  /LOCAL_AGENT_HOSTS\.map\(\(host\) => `http:\/\/\$\{host\}:\$\{port\}`\)/.test(nodeService),
  "Local Agent discovery should probe both configured localhost hostnames.",
);

assert(
  /return `local-agent-\$\{getLocalAgentPortFromUrl\(url\)\}`/.test(nodeService),
  "Localhost URLs should share a local placeholder identity before health returns a stable device ID.",
);

assert(
  nodeService.includes("isDefaultLocalAgentDisplayName") && nodeService.includes("requestedDisplayName && !isDefaultLocalAgentDisplayName(requestedDisplayName)"),
  "Local Agent nodes should default to This PC while allowing a custom display name.",
);

assert(
  nodeService.includes("localProfile: node.localAgent === true ? node.profile || null : null"),
  "Public Local Agent nodes should expose a local node profile without exposing the raw token.",
);

assert(
  /status: lastError\?\.status === 401 \|\| lastError\?\.code === "UNAUTHORIZED" \? "authentication-required" : "offline"/.test(nodeService),
  "Local Agent discovery should distinguish authentication-required from offline.",
);

assert(
  /nodes: \[publicNode\(getApplicationHostNode\(\)\), \.\.\.state\.nodes\.map\(publicNode\)\]/.test(nodeService),
  "Application host should remain present alongside discovered Agent nodes.",
);

console.log("Local Agent discovery smoke checks passed.");
