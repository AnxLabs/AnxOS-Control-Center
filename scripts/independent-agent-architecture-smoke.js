const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const doc = fs.readFileSync(path.join(root, "docs/ONE_AGENT_PER_NODE_ARCHITECTURE.md"), "utf8");
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const nodeService = fs.readFileSync(path.join(root, "src/services/nodeService.js"), "utf8");
const agentClient = fs.readFileSync(path.join(root, "src/services/agentClient.js"), "utf8");
const serviceRouter = fs.readFileSync(path.join(root, "src/services/serviceRouter.js"), "utf8");

[
  "node:agent-client:smoke",
  "node:registry:smoke",
  "node:legacy-migration:smoke",
  "node:switch:smoke",
  "node:connection-workflow:smoke",
  "node:independent-health:smoke",
  "node:stale-response:smoke",
  "node:compat-cleanup:smoke",
  "dashboard:node-routing:smoke",
  "instances:node-routing:smoke",
  "marketplace:node-routing:smoke",
  "dependencies:node-routing:smoke",
  "resources:node-isolation:smoke",
].forEach((script) => assert(packageJson.scripts?.[script], `package.json should expose ${script}`));

[
  "One node equals one independently running AnxOS Agent.",
  "Anxlab",
  "http://192.168.1.134:47131",
  "Windows PC",
  "http://192.168.1.xxx:47131",
  "VPS",
  "https://agent-vps.example.com",
  "Agents do not connect to each other",
  "Every Agent manages only its local host",
  "Per-node tokens are stored through `src/services/nodeCredentialStore.js`",
  "missing `nodeId` no longer silently routes an agent-backed request",
].forEach((needle) => assert(doc.includes(needle), `Architecture doc should include ${needle}`));

[
  "One machine or server = one independently running AnxHost Agent.",
  'data-node-action="test-form"',
  'data-node-field="enabled"',
  'data-node-field="tags"',
].forEach((needle) => assert(index.includes(needle), `Node onboarding UI should include ${needle}`));

[
  "const nodeRequestSerials = new Map();",
  "nodeRequestSerials.get(context.label) === context.serial",
  "getNodeScopedPayload(requestContext)",
  "activeMarketplaceInstallNodeId",
  "event.nodeId !== activeMarketplaceInstallNodeId",
].forEach((needle) => assert(appSource.includes(needle), `Renderer should preserve node isolation behavior: ${needle}`));

[
  "const HEALTH_STATES = new Set([\"connecting\", \"online\", \"offline\", \"authentication_failed\", \"agent_incompatible\", \"degraded\", \"unknown\"])",
  "function checkNodeHealth",
  "function checkAllNodeHealth",
  "const { agentToken, token, ...persistentNode } = node;",
  "setNodeToken(node.id, node.agentToken)",
  "targetLabel: `node:${node.id}`",
].forEach((needle) => assert(nodeService.includes(needle), `Node service should include ${needle}`));
assert(!nodeService.includes("const { agentToken, connection, token, ...persistentNode } = node;"), "Canonical connection health must survive registry persistence while credentials remain excluded.");

[
  "function forNode(nodeId)",
  "code: \"NODE_DISABLED\"",
  "Select a node before contacting an Agent.",
].forEach((needle) => assert(agentClient.includes(needle), `Node-aware agent client should include ${needle}`));

[
  "implicit-node-fallback-selected",
  "SELECTED_NODE_DEFAULT",
  "getRequestNodeId(options)",
  "withNodeContext(await agentClient.listBackups",
].forEach((needle) => assert(serviceRouter.includes(needle), `Service router should include ${needle}`));

assert(!/agentToken"\s*:\s*node\.agentToken/.test(nodeService), "Node service must not persist raw tokens into nodes.json.");
assert(!doc.includes("nodes.json` currently contains raw node tokens"), "Architecture doc must not claim raw node tokens remain in nodes.json.");

console.log("Independent agent architecture smoke checks passed.");
