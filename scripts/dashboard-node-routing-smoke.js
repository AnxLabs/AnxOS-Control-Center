const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-dashboard-routing-"));
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

async function startStatsAgent(name, token) {
  const port = await freePort();
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization || "" });
    response.setHeader("Content-Type", "application/json");
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401);
      response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }));
      return;
    }
    response.end(JSON.stringify({
      hostname: name,
      platform: name === "node-a" ? "linux" : "win32",
      osVersion: `${name}-os`,
      uptimeSeconds: name === "node-a" ? 100 : 200,
      cpu: { model: `${name}-cpu`, cores: name === "node-a" ? 4 : 8, usagePercent: name === "node-a" ? 11 : 22 },
      memory: { total: 1000, used: name === "node-a" ? 250 : 500, free: name === "node-a" ? 750 : 500, percent: name === "node-a" ? 25 : 50 },
      disk: { total: 2000, used: name === "node-a" ? 300 : 900, free: name === "node-a" ? 1700 : 1100, percent: name === "node-a" ? 15 : 45, mount: "/" },
      network: { downloadPerSecond: name === "node-a" ? 1 : 2, uploadPerSecond: name === "node-a" ? 3 : 4, totalDownload: 10, totalUpload: 20 },
      source: "agent",
    }));
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
  const agentA = await startStatsAgent("node-a", "token-a");
  const agentB = await startStatsAgent("node-b", "token-b");
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

    const systemService = require("../src/services/systemService");
    const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");

    const snapshotA = await systemService.getSystemSnapshot({ nodeId: "node-a" });
    assert.strictEqual(snapshotA.hostname, "node-a", "Dashboard metrics should use node A.");
    assert.strictEqual(snapshotA.memory.percent, 25, "Node A memory should remain isolated.");
    assert.strictEqual(agentA.requests[0].url, "/api/v1/stats", "Dashboard should request stats through the node-aware API path.");
    assert.strictEqual(agentA.requests[0].authorization, "Bearer token-a", "Dashboard should use node A token.");

    const snapshotB = await systemService.getSystemSnapshot({ nodeId: "node-b" });
    assert.strictEqual(snapshotB.hostname, "node-b", "Dashboard metrics should use node B.");
    assert.strictEqual(snapshotB.memory.percent, 50, "Node B memory should remain isolated.");
    assert.strictEqual(agentB.requests[0].authorization, "Bearer token-b", "Dashboard should use node B token.");

    await assert.rejects(
      () => systemService.getSystemSnapshot({ nodeId: "node-offline" }),
      (error) => {
        assert.strictEqual(error.payload?.error?.details?.nodeId, "node-offline");
        assert(!JSON.stringify(error).includes("token-offline"), "Offline dashboard errors must not expose node tokens.");
        assert(!JSON.stringify(error).includes("legacy-token-must-not-be-used"), "Offline dashboard errors must not fall back to the legacy token.");
        return Boolean(error.code);
      },
      "Offline selected node should not fall back to the legacy global Agent.",
    );

    assert(appSource.includes("function clearDashboardForNodeSwitch"), "Renderer should clear dashboard fields when switching nodes.");
    assert(appSource.includes("latestSystemSnapshot = null") && appSource.includes("latestSystemSnapshotNodeId = null"), "Renderer should clear old system snapshots on switch/failure.");
    assert(appSource.includes("desktopApiState.api.system.getSnapshot(getNodeScopedPayload(requestContext))"), "Renderer dashboard should request metrics for the selected node.");
    assert(appSource.includes("if (!isNodeRequestCurrent(requestContext))"), "Renderer dashboard should ignore stale node responses.");

    console.log("Dashboard node routing smoke checks passed.");
  } finally {
    await Promise.all([agentA.close(), agentB.close()]);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
