const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-marketplace-node-routing-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function main() {
  writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "nodes.json"), {
    schemaVersion: 2,
    selectedNodeId: "node-a",
    nodes: [
      {
        id: "node-a",
        kind: "agent",
        name: "Node A",
        displayName: "Node A",
        baseUrl: "http://127.0.0.1:47131",
        agentUrl: "http://127.0.0.1:47131",
        enabled: true,
        agentIdentity: { deviceId: "device-a" },
      },
      {
        id: "node-b",
        kind: "agent",
        name: "Node B",
        displayName: "Node B",
        baseUrl: "http://127.0.0.1:57131",
        agentUrl: "http://127.0.0.1:57131",
        enabled: true,
        agentIdentity: { deviceId: "device-b" },
      },
    ],
  });
  writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "node-agent-credentials.json"), {
    schemaVersion: 1,
    nodes: {
      "node-a": { agentToken: "token-a" },
      "node-b": { agentToken: "token-b" },
    },
  });
  writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "agent.json"), {
    backendMode: "agent",
    agentUrl: "http://legacy-global:47131",
    agentToken: "legacy-token",
  });

  const marketplaceService = require("../src/services/marketplaceService");

  const nodeA = marketplaceService._test.resolveMarketplaceAgentConfig("node-a");
  const nodeB = marketplaceService._test.resolveMarketplaceAgentConfig("node-b");
  assert.strictEqual(nodeA.agentUrl, "http://127.0.0.1:47131", "Marketplace should resolve Node A URL.");
  assert.strictEqual(nodeA.agentToken, "token-a", "Marketplace should resolve Node A token.");
  assert.strictEqual(nodeA.nodeId, "node-a", "Marketplace should carry Node A identity.");
  assert.strictEqual(nodeB.agentUrl, "http://127.0.0.1:57131", "Marketplace should resolve Node B URL.");
  assert.strictEqual(nodeB.agentToken, "token-b", "Marketplace should resolve Node B token.");
  assert.strictEqual(nodeB.nodeId, "node-b", "Marketplace should carry Node B identity.");

  const local = marketplaceService._test.resolveMarketplaceAgentConfig("application-host");
  assert.strictEqual(local.backendMode, "local", "Marketplace must not fall back to legacy global agent settings.");

  const recordA = marketplaceService.createDependencyInstallRecord({ nodeId: "node-a", dependencyIds: ["java"] });
  const recordB = marketplaceService.createDependencyInstallRecord({ nodeId: "node-b", dependencyIds: ["docker"] });
  assert.deepStrictEqual(
    marketplaceService.getDownloads("node-a").downloads.map((download) => download.id),
    [recordA.id],
    "Download Manager should filter Node A downloads.",
  );
  assert.deepStrictEqual(
    marketplaceService.getDownloads("node-b").downloads.map((download) => download.id),
    [recordB.id],
    "Download Manager should filter Node B downloads.",
  );
  assert.throws(
    () => marketplaceService.cancelDownload(recordB.id, { nodeId: "node-a" }),
    (error) => error.code === "DOWNLOAD_NODE_MISMATCH",
    "Download actions must reject the wrong node.",
  );

  const marketplaceSource = fs.readFileSync(path.join(__dirname, "..", "src", "services", "marketplaceService.js"), "utf8");
  const installSource = fs.readFileSync(path.join(__dirname, "..", "src", "services", "marketplaceInstallService.js"), "utf8");
  const ipcSource = fs.readFileSync(path.join(__dirname, "..", "src", "ipc", "marketplaceIpc.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  const rendererSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

  assert(!marketplaceSource.includes("targetLabel: \"configured-agent\""), "Marketplace must not keep configured-agent fallback.");
  assert(installSource.includes("nodeId: payload.nodeId || \"\""), "Provider install progress events should include nodeId.");
  assert(installSource.includes("nodeId: context.nodeId || context.agentConfig?.nodeId || null"), "Manual install sessions should retain node ownership.");
  assert(ipcSource.includes('requireNodeContext(payload, "Marketplace template installation")'), "Marketplace template installs must require an explicit target.");
  assert(ipcSource.includes('requireNodeContext(payload, "Marketplace provider-pack installation")'), "Marketplace provider installs must require an explicit target.");
  assert(ipcSource.includes("getDownloads(payload.nodeId)"), "Marketplace downloads IPC should pass the required nodeId.");
  assert(ipcSource.includes("cancelDownload(payload.downloadId, { nodeId: payload.nodeId })"), "Marketplace cancel IPC should pass the required nodeId.");
  assert(preloadSource.includes("getDownloads: (payload = {})"), "Preload should accept node-scoped download requests.");
  assert(rendererSource.includes("activeMarketplaceInstallNodeId"), "Renderer should track the installing node.");
  assert(rendererSource.includes("event.nodeId !== activeMarketplaceInstallNodeId"), "Renderer should ignore stale provider progress events.");
  assert(rendererSource.includes("const requestContext = getNodeRequestContext(\"marketplace-downloads\")"), "Renderer should snapshot node context for Marketplace downloads.");
  assert(rendererSource.includes("api.marketplace.getDownloads(getNodeScopedPayload(requestContext))"), "Renderer should request node-scoped Marketplace downloads.");

  console.log("Marketplace node routing smoke passed.");
}

try {
  main();
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
