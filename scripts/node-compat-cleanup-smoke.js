const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-node-compat-"));
process.env.ANXHUB_CONFIG_DIR = tempDir;

const serviceRouter = require("../src/services/serviceRouter");
const { getNodesPath } = require("../src/services/nodeService");
const { setNodeToken } = require("../src/services/nodeCredentialStore");
const agentClient = require("../src/services/agentClient");

fs.mkdirSync(tempDir, { recursive: true });

function writeNodes(selectedNodeId) {
  // V2-J bullet 6: the node migration now writes a durable recovery point that
  // is deliberately NEVER replaced. Each call below simulates a fresh
  // installation state, so it must clear that recovery point too — otherwise a
  // later call hands the migration a different legacy source than the recorded
  // recovery point and verify-or-refuse correctly refuses.
  for (const name of fs.readdirSync(process.env.ANXHUB_CONFIG_DIR)) {
    if (/^nodes\.json\.schema-v\d+\.backup$/.test(name)) {
      fs.rmSync(path.join(process.env.ANXHUB_CONFIG_DIR, name), { force: true });
    }
  }
  fs.writeFileSync(getNodesPath(), `${JSON.stringify({
    schemaVersion: 2,
    selectedNodeId,
    nodes: [
      {
        id: "node-a",
        kind: "agent",
        displayName: "Node A",
        baseUrl: "http://127.0.0.1:47131",
        agentUrl: "http://127.0.0.1:47131",
        enabled: true,
        agentIdentity: { deviceId: "node-a-device" },
      },
    ],
  }, null, 2)}\n`);
  setNodeToken("node-a", "node-token");
}

(async () => {
  writeNodes("node-a");
  const originalForNode = agentClient.forNode;
  agentClient.forNode = (nodeId) => ({
    listInstances: async () => ({ instances: [{ id: "same-instance", nodeId }] }),
  });
  const remoteList = await serviceRouter.listInstances();
  assert.strictEqual(remoteList.instances[0].nodeId, "node-a", "agent-backed service calls should use the selected Agent when nodeId is omitted.");
  agentClient.forNode = originalForNode;

  writeNodes("application-host");
  const localList = await serviceRouter.listInstances();
  assert(Array.isArray(localList.instances), "application-host fallback should preserve local single-node behavior");

  const serviceSource = fs.readFileSync(path.join(root, "src/services/serviceRouter.js"), "utf8");
  assert(serviceSource.includes("implicit-node-fallback-selected"), "Implicit selected-node routing should emit diagnostics.");
  assert(serviceSource.includes("SELECTED_NODE_DEFAULT"), "Selected node defaults should be identifiable in diagnostics.");

  console.log("Node compatibility cleanup smoke checks passed.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
