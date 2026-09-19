const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-local-application-separation-"));
process.env.ANXHUB_CONFIG_DIR = tempDir;

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

(async () => {
  try {
    writeJson(path.join(tempDir, "nodes.json"), {
      schemaVersion: 3,
      selectedNodeId: "application-host",
      nodes: [
        {
          id: "agent-local-agent-47131",
          displayName: "Windows Agent",
          agentUrl: "http://127.0.0.1:47131",
          localAgent: true,
          agentIdentity: { deviceId: "local-agent-47131", hostname: "This PC", platform: "win32" },
        },
      ],
    });

    const nodes = require("../src/services/nodeService");
    const state = await nodes.listNodes({ discoverLocalAgent: false, refreshIdentity: false });
    const applicationHost = state.nodes.find((node) => node.kind === "application-host");
    const localAgentNode = state.nodes.find((node) => node.id === "agent-local-agent-47131");

    assert(applicationHost, "Application Host should be present.");
    assert(localAgentNode, "Registered localhost Agent node should be present.");
    assert.notStrictEqual(applicationHost.id, localAgentNode.id, "Application Host and registered local Agent node must not share IDs.");
    assert.strictEqual(applicationHost.modeLabel, "Local Application", "Application Host should be labeled as the Local Application.");
    assert.strictEqual(applicationHost.nodeTypeLabel, "Application Host", "Application Host should expose explicit type metadata.");
    assert.strictEqual(applicationHost.builtIn, true, "Application Host should be built in.");
    assert.strictEqual(applicationHost.removable, false, "Application Host should not be removable.");
    assert.strictEqual(localAgentNode.modeLabel, "Registered Local Agent Node", "Local Agent node should be labeled as a registered Agent node.");
    assert.strictEqual(localAgentNode.nodeTypeLabel, "Registered Agent Node", "Local Agent node should expose registered-node type metadata.");
    assert.strictEqual(localAgentNode.builtIn, false, "Registered localhost Agent node should not be built in.");
    assert.strictEqual(localAgentNode.removable, true, "Registered localhost Agent node should be removable.");
    assert.strictEqual(nodes.getExecutionTarget(applicationHost.id).type, "application-host", "Application Host should route as application-host.");
    assert.strictEqual(nodes.getExecutionTarget(localAgentNode.id).type, "agent", "Registered localhost Agent should route as an Agent node.");

    const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
    assert(appSource.includes("function getNodeTypeLabel"), "Renderer should centralize node type labels.");
    assert(appSource.includes("The built-in Application Host cannot be removed."), "Renderer should explain why Application Host removal is disabled.");
    assert(appSource.includes("Local Application Host"), "Renderer should distinguish Application Host from registered Agent nodes.");

    console.log("Local Application separation smoke checks passed.");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
