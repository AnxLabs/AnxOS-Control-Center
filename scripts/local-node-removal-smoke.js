const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-local-node-removal-"));
process.env.ANXHUB_CONFIG_DIR = tempDir;

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve())).catch(() => {});
}

function createLocalAgent() {
  return http.createServer((request, response) => {
    if (request.url === "/api/v1/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        tokenConfigured: false,
        apiVersion: "1",
        identity: {
          deviceId: "local-agent-47131",
          hostname: "This PC",
          platform: "win32",
          agentVersion: "1.7.0",
        },
      }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
  });
}

(async () => {
  const server = createLocalAgent();
  try {
    const port = await listen(server);
    const agentUrl = `http://127.0.0.1:${port}`;
    writeJson(path.join(tempDir, "agent-runtime.json"), { port });
    writeJson(path.join(tempDir, "agent.json"), {
      backendMode: "agent",
      agentUrl,
      agentToken: "legacy-local-token",
    });
    writeJson(path.join(tempDir, "nodes.json"), {
      schemaVersion: 3,
      selectedNodeId: "agent-local-agent-47131",
      nodes: [
        {
          id: "agent-local-agent-47131",
          displayName: "This PC",
          agentUrl,
          localAgent: true,
          agentIdentity: { deviceId: "local-agent-47131" },
        },
      ],
    });
    writeJson(path.join(tempDir, "node-agent-credentials.json"), {
      schemaVersion: 1,
      nodes: {
        "agent-local-agent-47131": { agentToken: "legacy-local-token" },
      },
    });

    const nodes = require("../src/services/nodeService");
    const { getNodeToken } = require("../src/services/nodeCredentialStore");

    await nodes.deleteNode("agent-local-agent-47131");

    const afterDelete = JSON.parse(fs.readFileSync(nodes.getNodesPath(), "utf8"));
    assert.strictEqual(afterDelete.nodes.some((node) => node.id === "agent-local-agent-47131"), false, "deleted local Agent node should be removed from registry");
    assert(afterDelete.removedLocalAgents?.some((entry) => entry.nodeId === "agent-local-agent-47131"), "deleted local Agent node should leave an intentional-removal marker");
    assert.strictEqual(getNodeToken("agent-local-agent-47131"), "", "deleted local Agent credential should be removed");

    const migrated = await nodes.listNodes({ discoverLocalAgent: false, refreshIdentity: false });
    assert(migrated.nodes.some((node) => node.kind === "application-host"), "built-in Application Host should remain listed");
    assert.strictEqual(migrated.nodes.some((node) => node.id === "agent-local-agent-47131"), false, "legacy migration must not recreate a removed local Agent node");

    const discovered = await nodes.listNodes({ discoverLocalAgent: true, refreshIdentity: false });
    assert(discovered.nodes.some((node) => node.kind === "application-host"), "built-in Application Host should remain after discovery");
    assert.strictEqual(discovered.nodes.some((node) => node.id === "agent-local-agent-47131"), false, "local discovery must not recreate an intentionally removed local Agent node");

    console.log("Local node removal smoke checks passed.");
  } finally {
    await close(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
