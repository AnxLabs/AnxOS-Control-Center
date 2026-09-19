const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-startup-selection-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

const nodes = require("../src/services/nodeService");
const activeSelection = require("../src/services/activeNodeSelectionService");

function writeNodes(selectedNodeId, nodeList) {
  // V2-J bullet 6: the node migration writes a durable recovery point that is
  // deliberately NEVER replaced. Each writeNodes call below simulates a fresh
  // installation state, so it must clear that recovery point too — otherwise a
  // later call hands the migration a different legacy source than the recorded
  // recovery point, and verify-or-refuse correctly refuses.
  for (const name of fs.readdirSync(process.env.ANXHUB_CONFIG_DIR)) {
    if (/^nodes\.json\.schema-v\d+\.backup$/.test(name)) {
      fs.rmSync(path.join(process.env.ANXHUB_CONFIG_DIR, name), { force: true });
    }
  }
  fs.writeFileSync(nodes.getNodesPath(), `${JSON.stringify({
    schemaVersion: 2,
    selectedNodeId,
    nodes: nodeList,
  }, null, 2)}\n`, { mode: 0o600 });
}

function node(id, patch = {}) {
  return {
    id,
    kind: "agent",
    name: patch.displayName || id,
    displayName: patch.displayName || id,
    baseUrl: patch.baseUrl || `http://10.0.0.${id === "node-a" ? "10" : "11"}:47131`,
    agentUrl: patch.baseUrl || `http://10.0.0.${id === "node-a" ? "10" : "11"}:47131`,
    enabled: patch.enabled !== false,
    lastConnectionState: patch.lastConnectionState || "unknown",
    agentIdentity: {
      deviceId: patch.deviceId || id,
      hostname: "",
      operatingSystem: "",
      platform: "",
      architecture: "",
      agentVersion: "",
    },
  };
}

async function main() {
  writeNodes("node-a", [node("node-a"), node("node-b")]);
  let restored = await activeSelection.restorePersistedActiveNode();
  assert.strictEqual(restored.selectedNodeId, "node-a", "Startup should restore the previous selected node.");

  writeNodes("node-a", [node("node-a", { lastConnectionState: "offline" }), node("node-b")]);
  restored = await activeSelection.restorePersistedActiveNode();
  assert.strictEqual(restored.selectedNodeId, "node-a", "Startup should preserve an explicitly selected offline node.");

  writeNodes("node-a", [node("node-a", { enabled: false }), node("node-b")]);
  restored = await activeSelection.restorePersistedActiveNode();
  assert.strictEqual(restored.selectedNodeId, "node-a", "Startup should preserve disabled selected nodes for a clear disabled state.");
  assert.strictEqual(restored.disabled, true, "Disabled startup restoration should be marked.");

  writeNodes("deleted-node", [node("node-b")]);
  restored = await activeSelection.restorePersistedActiveNode();
  assert.strictEqual(restored.selectedNodeId, "node-b", "Deleted selected node should recover to the only remaining valid node.");

  writeNodes("deleted-node", [node("node-a"), node("node-b")]);
  restored = await activeSelection.restorePersistedActiveNode();
  assert.strictEqual(restored.selectedNodeId, "application-host", "Deleted selected node with multiple choices should show Select Node/application-host state.");
  assert.strictEqual(restored.requiresSelection, true, "Multiple-node deleted recovery should require deliberate selection.");

  writeNodes(null, [node("node-a")]);
  restored = await activeSelection.restorePersistedActiveNode();
  assert.strictEqual(restored.selectedNodeId, "node-a", "Fresh one-node startup should select the only registered node.");

  const preloadSource = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  const rendererSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const ipcSource = fs.readFileSync(path.join(__dirname, "..", "src", "ipc", "nodesIpc.js"), "utf8");
  assert(preloadSource.includes("restore: () => ipcRenderer.invoke(\"nodes:restore\")"), "Preload should expose node startup restore.");
  assert(ipcSource.includes("nodes:restore") && ipcSource.includes("restorePersistedActiveNode"), "IPC should route startup restore through active-node selection.");
  assert(rendererSource.includes("desktopApiState.api.nodes.restore"), "Renderer startup should restore active-node selection before listing nodes.");

  console.log("Startup synchronized selection smoke checks passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(root, { recursive: true, force: true });
});
