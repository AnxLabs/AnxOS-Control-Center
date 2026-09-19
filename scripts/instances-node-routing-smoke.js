const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-instances-routing-"));
process.env.ANXHUB_CONFIG_DIR = path.join(temp, "config");
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

async function startInstanceAgent(name, token) {
  const port = await freePort();
  const requests = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk) => { raw += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, authorization: request.headers.authorization || "", body: raw ? JSON.parse(raw) : null });
      response.setHeader("Content-Type", "application/json");
      if (request.headers.authorization !== `Bearer ${token}`) {
        response.writeHead(401);
        response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }));
        return;
      }
      const instance = { id: "shared-id", name: `${name} Test Server`, displayName: `${name} Test Server`, state: name === "node-a" ? "running" : "stopped", nodeId: name };
      if (request.url === "/api/v1/instances" && request.method === "GET") {
        response.end(JSON.stringify({ instances: [instance], source: name }));
        return;
      }
      if (request.url === "/api/v1/instances" && request.method === "POST") {
        response.end(JSON.stringify({ instance: { ...instance, created: true, requestBody: raw ? JSON.parse(raw) : null } }));
        return;
      }
      if (request.url === "/api/v1/instances/shared-id/start" && request.method === "POST") {
        response.end(JSON.stringify({ ok: true, action: "start", node: name, id: "shared-id" }));
        return;
      }
      if (request.url === "/api/v1/instances/shared-id/logs?stream=all&limit=80" && request.method === "GET") {
        response.end(JSON.stringify({ logs: [`${name} log`], node: name }));
        return;
      }
      if (request.url === "/api/v1/instances/shared-id/file?path=server.properties" && request.method === "GET") {
        response.end(JSON.stringify({ path: "server.properties", content: `${name}=true` }));
        return;
      }
      if (request.url === "/api/v1/instances/shared-id/file" && request.method === "PUT") {
        response.end(JSON.stringify({ ok: true, node: name, body: raw ? JSON.parse(raw) : null }));
        return;
      }
      if (request.url === "/api/v1/instances/shared-id" && request.method === "DELETE") {
        response.end(JSON.stringify({ id: "shared-id", deleted: true, node: name }));
        return;
      }
      response.writeHead(404);
      response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: request.url } }));
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
  const agentA = await startInstanceAgent("node-a", "token-a");
  const agentB = await startInstanceAgent("node-b", "token-b");
  const offlinePort = await freePort();
  try {
    writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "agent.json"), {
      backendMode: "agent",
      agentUrl: "http://127.0.0.1:9",
      agentToken: "legacy-token-must-not-be-used",
    });
    writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "nodes.json"), {
      schemaVersion: 2,
      selectedNodeId: "node-a",
      nodes: [
        { id: "node-a", kind: "agent", name: "Node A", displayName: "Node A", baseUrl: agentA.url, agentUrl: agentA.url, enabled: true, agentIdentity: { deviceId: "device-a" } },
        { id: "node-b", kind: "agent", name: "Node B", displayName: "Node B", baseUrl: agentB.url, agentUrl: agentB.url, enabled: true, agentIdentity: { deviceId: "device-b" } },
        { id: "node-offline", kind: "agent", name: "Node Offline", displayName: "Node Offline", baseUrl: `http://127.0.0.1:${offlinePort}`, agentUrl: `http://127.0.0.1:${offlinePort}`, enabled: true, agentIdentity: { deviceId: "device-offline" } },
      ],
    });
    writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "node-agent-credentials.json"), {
      schemaVersion: 1,
      nodes: {
        "node-a": { agentToken: "token-a" },
        "node-b": { agentToken: "token-b" },
        "node-offline": { agentToken: "token-offline" },
      },
    });

    const serviceRouter = require("../src/services/serviceRouter");
    const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
    const preloadSource = fs.readFileSync(path.join(root, "preload.js"), "utf8");
    const instancesIpcSource = fs.readFileSync(path.join(root, "src", "ipc", "instancesIpc.js"), "utf8");

    const listA = await serviceRouter.listInstances({ nodeId: "node-a" });
    const listB = await serviceRouter.listInstances({ nodeId: "node-b" });
    assert.strictEqual(listA.instances[0].id, "shared-id");
    assert.strictEqual(listB.instances[0].id, "shared-id");
    assert.strictEqual(listA.instances[0].name, "node-a Test Server", "Node A instance data should remain isolated.");
    assert.strictEqual(listB.instances[0].name, "node-b Test Server", "Node B instance data should remain isolated.");
    assert.strictEqual(agentA.requests[0].authorization, "Bearer token-a", "Node A list should use token A.");
    assert.strictEqual(agentB.requests[0].authorization, "Bearer token-b", "Node B list should use token B.");

    const createB = await serviceRouter.createInstance({ nodeId: "node-b", name: "Created" });
    assert.strictEqual(createB.instance.nodeId, "node-b", "Create should target node B.");
    assert.strictEqual(agentB.requests.at(-1).method, "POST");
    assert.strictEqual(agentB.requests.at(-1).url, "/api/v1/instances");

    const startA = await serviceRouter.startInstance("shared-id", { nodeId: "node-a" });
    assert.strictEqual(startA.node, "node-a", "Lifecycle action should target node A despite identical ID.");

    const logsB = await serviceRouter.getInstanceLogs("shared-id", { nodeId: "node-b", stream: "all", limit: 80 });
    assert.deepStrictEqual(logsB.logs, ["node-b log"], "Logs should target node B.");

    const fileA = await serviceRouter.readInstanceFile("shared-id", "server.properties", { nodeId: "node-a" });
    assert.strictEqual(fileA.content, "node-a=true", "Instance file read should target node A.");

    const writeB = await serviceRouter.writeInstanceFile("shared-id", "server.properties", "ok=true", { nodeId: "node-b", encoding: "utf8" });
    assert.strictEqual(writeB.node, "node-b", "Instance file write should target node B.");

    const deleteA = await serviceRouter.deleteInstance("shared-id", { nodeId: "node-a" });
    assert.strictEqual(deleteA.node, "node-a", "Delete should stay bound to the initiating node.");

    await assert.rejects(
      () => serviceRouter.listInstances({ nodeId: "node-offline" }),
      (error) => {
        assert(!JSON.stringify(error).includes("token-offline"), "Offline instance errors must not expose node tokens.");
        assert(!JSON.stringify(error).includes("legacy-token-must-not-be-used"), "Offline instance errors must not fall back to legacy token.");
        return error.code === "AGENT_UNAVAILABLE";
      },
      "Offline selected node should not fall back for Instances.",
    );

    assert(appSource.includes("resetNodeScopedRendererState(`Switching to"), "Renderer should clear instance state on node switch.");
    assert(appSource.includes("latestInstancesSnapshot = null"), "Renderer should clear old instance snapshots on switch.");
    assert(appSource.includes("desktopApiState.api.instances.list(getNodeScopedPayload(requestContext))"), "Renderer should list instances for selected node.");
    assert(preloadSource.includes('sendCommand: (instanceId, command, options = {}) => ipcRenderer.invoke("instances:sendCommand", { ...options, instanceId, command })'), "Console commands must preserve the renderer-captured node context through preload.");
    assert(instancesIpcSource.includes("registerInstanceHandler") && instancesIpcSource.includes("requireNodeContext(payload, channel)"), "Every Instances IPC handler must reject an omitted node context.");
    assert(appSource.includes("const requestContext = createNodeActionContext(\"instance-create\")"), "Instance create should bind an action context.");
    assert(appSource.includes("const requestContext = createNodeActionContext(`instance-${actionName}`)"), "Instance actions should bind node action context.");
    assert(appSource.includes("if (!isNodeActionStillCurrent(requestContext)) return;"), "Instance actions should guard stale node changes.");

    console.log("Instances node routing smoke checks passed.");
  } finally {
    await Promise.all([agentA.close(), agentB.close()]);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
