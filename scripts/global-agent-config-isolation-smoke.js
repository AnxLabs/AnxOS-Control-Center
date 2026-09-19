const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-global-agent-isolation-"));
process.env.ANXHUB_CONFIG_DIR = tempDir;

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function createAgent(label, expectedToken) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({
      label,
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization || "",
    });
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== `Bearer ${expectedToken}`) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { code: "UNAUTHORIZED" } }));
      return;
    }
    response.end(JSON.stringify({ ok: true, label, url: request.url }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      label,
      requests,
      server,
      url: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve)).catch(() => {});
}

(async () => {
  const legacy = await createAgent("legacy-localhost", "legacy-token");
  const nodeA = await createAgent("node-a", "token-a");
  const nodeB = await createAgent("node-b", "token-b");
  try {
    const agentConfigPath = path.join(tempDir, "agent.json");
    const globalConfig = {
      backendMode: "agent",
      agentUrl: legacy.url,
      agentToken: "legacy-token",
    };
    writeJson(agentConfigPath, globalConfig);
    writeJson(path.join(tempDir, "nodes.json"), {
      schemaVersion: 3,
      selectedNodeId: "node-a",
      nodes: [
        { id: "node-a", kind: "agent", displayName: "Anxlab", baseUrl: nodeA.url, agentUrl: nodeA.url, enabled: true, agentIdentity: { deviceId: "device-a" } },
        { id: "node-b", kind: "agent", displayName: "Windows PC", baseUrl: nodeB.url, agentUrl: nodeB.url, enabled: true, agentIdentity: { deviceId: "device-b" } },
      ],
    });
    writeJson(path.join(tempDir, "node-agent-credentials.json"), {
      schemaVersion: 1,
      nodes: {
        "node-a": { agentToken: "token-a" },
      },
    });

    const nodes = require("../src/services/nodeService");
    const agentClient = require("../src/services/agentClient");

    await nodes.selectNode("node-a");
    await agentClient.forNode("node-a").get("/health");
    await nodes.selectNode("node-b");
    await assert.rejects(
      () => agentClient.forNode("node-b").get("/health"),
      (error) => {
        assert.strictEqual(error.code, "NODE_CREDENTIAL_MISSING");
        assert.strictEqual(error.details?.nodeId, "node-b");
        return true;
      },
      "Node B should fail before sending a request when its protected credential is missing.",
    );

    assert.strictEqual(legacy.requests.length, 0, "Global configured Agent must not receive registered-node feature requests.");
    assert(nodeA.requests.some((entry) => entry.authorization === "Bearer token-a"), "Node A should use its protected node credential.");
    assert.strictEqual(nodeB.requests.length, 0, "Node B must not receive an Agent request when its protected credential is missing.");
    const persistedGlobalConfig = JSON.parse(fs.readFileSync(agentConfigPath, "utf8"));
    assert.deepStrictEqual(
      { ...persistedGlobalConfig, schemaVersion: undefined },
      { ...globalConfig, schemaVersion: undefined },
      "Selecting registered nodes must not change global Agent configuration values.",
    );
    assert.strictEqual(persistedGlobalConfig.schemaVersion, 1, "Reading legacy Agent configuration may persist the current schema version.");

    console.log("Global Agent configuration isolation smoke checks passed.");
  } finally {
    await Promise.all([legacy, nodeA, nodeB].map((agent) => close(agent.server)));
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
