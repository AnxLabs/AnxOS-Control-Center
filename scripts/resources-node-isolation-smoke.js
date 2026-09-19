const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-resources-node-isolation-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
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
      {
        id: "node-disabled",
        kind: "agent",
        name: "Disabled Node",
        displayName: "Disabled Node",
        baseUrl: "http://127.0.0.1:67131",
        agentUrl: "http://127.0.0.1:67131",
        enabled: false,
        agentIdentity: { deviceId: "device-disabled" },
      },
    ],
  });
  writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "node-agent-credentials.json"), {
    schemaVersion: 1,
    nodes: {
      "node-a": { agentToken: "token-a" },
      "node-b": { agentToken: "token-b" },
      "node-disabled": { agentToken: "token-disabled" },
    },
  });

  const agentClient = require("../src/services/agentClient");
  const serviceRouter = require("../src/services/serviceRouter");
  const { FileService } = require("../src/services/fileService");

  const originalDockerContainers = agentClient.getDockerContainers;
  const originalListBackups = agentClient.listBackups;
  try {
    const seen = [];
    agentClient.getDockerContainers = async (config) => {
      seen.push({ type: "docker", config });
      return {
        containers: [
          { id: "same-id", name: "same-name" },
        ],
      };
    };
    agentClient.listBackups = async (payload, config) => {
      seen.push({ type: "backups", payload, config });
      return {
        backups: [
          { id: "same-backup", instanceId: "same-instance" },
        ],
      };
    };

    const dockerA = await serviceRouter.listDockerContainers({ nodeId: "node-a" });
    const dockerB = await serviceRouter.listDockerContainers({ nodeId: "node-b" });
    assert.strictEqual(dockerA.nodeId, "node-a", "Docker list response should carry Node A.");
    assert.strictEqual(dockerA.containers[0].nodeId, "node-a", "Docker container entries should carry Node A.");
    assert.strictEqual(dockerB.nodeId, "node-b", "Docker list response should carry Node B.");
    assert.strictEqual(dockerB.containers[0].nodeId, "node-b", "Docker container entries should carry Node B.");

    const backupsA = await serviceRouter.listBackups({ nodeId: "node-a" });
    const backupsB = await serviceRouter.listBackups({ nodeId: "node-b" });
    assert.strictEqual(backupsA.backups[0].nodeId, "node-a", "Backup entries should carry Node A.");
    assert.strictEqual(backupsB.backups[0].nodeId, "node-b", "Backup entries should carry Node B.");
    assert.strictEqual(seen.find((entry) => entry.type === "docker").config.nodeId, "node-a", "Docker Agent config should include node identity.");
    assert.strictEqual(seen.find((entry) => entry.type === "backups").config.nodeId, "node-a", "Backup Agent config should include node identity.");

    await assert.rejects(
      () => serviceRouter.listDockerContainers({ nodeId: "node-disabled" }),
      (error) => error.code === "DOCKER_DISABLED_FOR_NODE" || error.code === "NODE_DISABLED",
      "Disabled Docker nodes should reject before request dispatch.",
    );

    const files = new FileService();
    await assert.rejects(
      () => files.identity({ providerType: "agent-native", nodeId: "node-disabled" }),
      (error) => error.code === "NODE_DISABLED",
      "Disabled agent-native Files nodes should reject before request dispatch.",
    );
  } finally {
    agentClient.getDockerContainers = originalDockerContainers;
    agentClient.listBackups = originalListBackups;
  }

  const serviceRouterSource = fs.readFileSync(path.join(__dirname, "..", "src", "services", "serviceRouter.js"), "utf8");
  const fileServiceSource = fs.readFileSync(path.join(__dirname, "..", "src", "services", "fileService.js"), "utf8");
  const rendererSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

  assert(serviceRouterSource.includes("function withNodeContext"), "Service router should centralize node context projection.");
  assert(serviceRouterSource.includes("node?.enabled === false"), "Service router should reject disabled agent nodes.");
  assert(fileServiceSource.includes("getTransferNodeId"), "Files service should derive transfer node ownership.");
  assert(fileServiceSource.includes("nodeId: transferNodeId"), "Files transfer events should include nodeId.");
  assert(rendererSource.includes("event.nodeId && transfer.nodeId && event.nodeId !== transfer.nodeId"), "Renderer should ignore stale file transfer events.");
  assert(rendererSource.includes(".filter((transfer) => !transfer.nodeId || transfer.nodeId === currentNodeId)"), "Renderer should show transfer history for the active node only.");
  assert(rendererSource.includes("selectedInstanceFilePath = null;"), "Node switches should clear selected instance file paths.");
  assert(rendererSource.includes("selectedFileEntryPath = null;"), "Node switches should clear selected Files entries.");
  assert(rendererSource.includes("selectedPublicAccessServiceId = null;"), "Node switches should clear selected Public Access services.");
  assert(rendererSource.includes("filesConnectionState.nodeId = null;"), "Node switches should clear Files connection node ownership.");
  assert(rendererSource.includes("filesClipboardState.targetKey = null;"), "Node switches should clear Files clipboard target ownership.");

  console.log("Resource node isolation smoke checks passed.");
}

main()
  .finally(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
