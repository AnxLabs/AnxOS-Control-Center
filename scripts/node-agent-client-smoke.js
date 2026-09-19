const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-node-agent-client-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function startMockAgent(name, token) {
  const port = await freePort();
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization || "", body });
      response.setHeader("Content-Type", "application/json");
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401);
        response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }));
        return;
      }
      response.end(JSON.stringify({ ok: true, name, method: request.method, url: request.url, body: body ? JSON.parse(body) : null }));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const agentA = await startMockAgent("node-a", "token-a");
  const agentB = await startMockAgent("node-b", "token-b");
  const agentC = await startMockAgent("node-c", "token-c");
  const offlinePort = await freePort();
  try {
    writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "nodes.json"), {
      schemaVersion: 3,
      selectedNodeId: "anxlab",
      nodes: [
        { id: "anxlab", kind: "agent", name: "Anxlab", displayName: "Anxlab", baseUrl: agentA.url, agentUrl: agentA.url, enabled: true, agentIdentity: { deviceId: "device-anxlab" } },
        { id: "node-a", kind: "agent", name: "Node A", displayName: "Node A", baseUrl: agentA.url, agentUrl: agentA.url, enabled: true, agentIdentity: { deviceId: "device-a" } },
        { id: "node-b", kind: "agent", name: "Node B", displayName: "Node B", baseUrl: agentB.url, agentUrl: agentB.url, enabled: true, agentIdentity: { deviceId: "device-b" } },
        { id: "node-disabled", kind: "agent", name: "Disabled Node", displayName: "Disabled Node", baseUrl: agentB.url, agentUrl: agentB.url, enabled: false, agentIdentity: { deviceId: "device-disabled" } },
        { id: "node-offline", kind: "agent", name: "Offline Node", displayName: "Offline Node", baseUrl: `http://127.0.0.1:${offlinePort}`, agentUrl: `http://127.0.0.1:${offlinePort}`, enabled: true, agentIdentity: { deviceId: "device-offline" } },
        { id: "node-auth", kind: "agent", name: "Auth Node", displayName: "Auth Node", baseUrl: agentC.url, agentUrl: agentC.url, enabled: true, agentIdentity: { deviceId: "device-auth" } },
        { id: "agent-local-agent-47131", kind: "agent", name: "This PC", displayName: "This PC", baseUrl: agentC.url, agentUrl: agentC.url, enabled: true, localAgent: true, agentIdentity: { deviceId: "local-agent-47131" } },
      ],
    });
    writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "node-agent-credentials.json"), {
      schemaVersion: 1,
      nodes: {
        "node-a": { agentToken: "token-a" },
        "anxlab": { agentToken: "token-a" },
        "node-b": { agentToken: "token-b" },
        "node-disabled": { agentToken: "token-b" },
        "node-offline": { agentToken: "token-offline" },
        "node-auth": { agentToken: "wrong-token" },
        "agent-local-agent-47131": { agentToken: "wrong-token" },
      },
    });

    const agentClient = require("../src/services/agentClient");

    const a = await agentClient.forNode("node-a").get("/instances");
    assert.strictEqual(a.url, "/api/v1/instances", "forNode().get should construct /api/v1 endpoints.");
    assert.strictEqual(agentA.requests[0].authorization, "Bearer token-a", "Node A should use token A.");

    const b = await agentClient.forNode("node-b").post("actions", { action: "ping" });
    assert.strictEqual(b.url, "/api/v1/actions", "forNode().post should construct relative /api/v1 endpoints.");
    assert.deepStrictEqual(b.body, { action: "ping" }, "forNode().post should send JSON payloads.");
    assert.strictEqual(agentB.requests[0].authorization, "Bearer token-b", "Node B should use token B.");

    assert.throws(() => agentClient.forNode("missing-node"), (error) => error.code === "NODE_NOT_FOUND", "Missing nodes should reject clearly.");
    assert.throws(() => agentClient.forNode("node-disabled"), (error) => error.code === "NODE_DISABLED", "Disabled nodes should reject clearly.");

    await assert.rejects(
      () => agentClient.forNode("node-offline").get("/health", { timeoutMs: 1000 }),
      (error) => {
        assert.strictEqual(error.payload?.error?.details?.nodeId, "node-offline");
        assert(!JSON.stringify(error).includes("token-offline"), "Offline errors must not expose tokens.");
        return Boolean(error.code);
      },
      "Offline nodes should reject with node context.",
    );

    await assert.rejects(
      () => agentClient.forNode("node-auth").get("/health"),
      (error) => {
        assert.strictEqual(error.status, 401);
        assert.strictEqual(error.payload?.error?.details?.nodeId, "node-auth");
        assert.strictEqual(error.payload?.error?.details?.nodeUrl, agentC.url);
        assert.strictEqual(error.payload?.error?.details?.targetLabel, "node:node-auth");
        assert(String(error.message).includes("Auth Node"), "Authentication errors should include friendly node name.");
        assert(!JSON.stringify(error).includes("wrong-token"), "Authentication errors must not expose tokens.");
        return true;
      },
      "Authentication failure should preserve status and node context.",
    );

    await assert.rejects(
      () => agentClient.forNode("agent-local-agent-47131").get("/health"),
      (error) => {
        const details = error.payload?.error?.details || {};
        assert.strictEqual(details.nodeId, "agent-local-agent-47131");
        assert.strictEqual(details.nodeName, "This PC");
        assert.strictEqual(details.nodeUrl, agentC.url);
        assert.strictEqual(details.targetLabel, "node:agent-local-agent-47131");
        assert(String(error.message).includes("This PC"), "Localhost node errors should use the initiating local node name.");
        assert(!String(error.message).includes("Anxlab"), "Localhost node errors must not use the globally selected node name.");
        return true;
      },
      "Node error context should not mix selected-node metadata into an initiating local-node request.",
    );

    console.log("Node-aware Agent client smoke checks passed.");
  } finally {
    await Promise.all([agentA.close(), agentB.close(), agentC.close()]);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
