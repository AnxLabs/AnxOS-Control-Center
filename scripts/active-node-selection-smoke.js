const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-active-node-"));
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
    agentIdentity: {
      deviceId: patch.deviceId || id,
      hostname: patch.hostname || "",
      operatingSystem: "",
      platform: patch.platform || "",
      architecture: "",
      agentVersion: patch.agentVersion || "",
    },
  };
}

async function main() {
  writeNodes("node-a", [node("node-a"), node("node-b")]);
  assert.strictEqual(activeSelection.getActiveNodeId(), "node-a", "Active node should read persisted selected node.");
  assert.strictEqual(activeSelection.getActiveNode().id, "node-a", "Active node should resolve the selected node.");
  assert.strictEqual(activeSelection.validateActiveNode().valid, true, "Persisted selected node should validate.");

  let events = [];
  const unsubscribe = activeSelection.subscribeToActiveNodeChanges((event) => events.push(event));
  let result = await activeSelection.setActiveNode("node-b", { reason: "smoke-change" });
  assert.strictEqual(result.changed, true, "Changing active node should report changed=true.");
  assert.strictEqual(activeSelection.getActiveNodeId(), "node-b", "Active node should update after selection.");
  assert.strictEqual(events.length, 1, "Changing active node should emit one event.");
  assert.strictEqual(events[0].previousNodeId, "node-a", "Event should include previous node.");
  assert.strictEqual(events[0].nodeId, "node-b", "Event should include next node.");

  result = await activeSelection.setActiveNode("node-b", { reason: "duplicate" });
  assert.strictEqual(result.changed, false, "Selecting the same node should be deduped.");
  assert.strictEqual(events.length, 1, "Duplicate selection should not emit another event.");

  writeNodes("node-a", [node("node-a", { enabled: false }), node("node-b")]);
  assert.strictEqual(activeSelection.validateActiveNode().code, "NODE_DISABLED", "Disabled selected nodes should be reported clearly.");
  await assert.rejects(
    () => activeSelection.setActiveNode("node-a"),
    (error) => error?.code === "NODE_DISABLED",
    "Disabled nodes should not become active through normal selection.",
  );

  writeNodes("deleted-node", [node("node-b")]);
  result = await activeSelection.restorePersistedActiveNode();
  assert.strictEqual(result.selectedNodeId, "node-b", "Deleted selection should recover to the only valid registered node.");

  writeNodes("deleted-node", [node("node-a"), node("node-b")]);
  result = await activeSelection.restorePersistedActiveNode();
  assert.strictEqual(result.selectedNodeId, "application-host", "Deleted selection with multiple nodes should recover to Select Node/application-host state.");
  assert.strictEqual(result.requiresSelection, true, "Multiple-node recovery should require deliberate node selection.");

  writeNodes(null, [node("node-a")]);
  assert.strictEqual(activeSelection.getActiveNodeId(), "node-a", "Fresh one-node state should initialize to the only registered node.");

  writeNodes("node-a", [node("node-a", { baseUrl: "http://192.168.1.134:47131" })]);
  nodes.getNodeAgentConfig("node-a");
  const activeAgent = activeSelection.resolveActiveAgentConnection();
  assert.strictEqual(activeAgent.nodeId, "node-a", "Active Agent connection should derive from the active node.");
  assert.strictEqual(activeAgent.agent.agentUrl, "http://192.168.1.134:47131", "Derived Agent should expose safe URL context.");
  assert(!Object.prototype.hasOwnProperty.call(activeAgent.connection, "agentToken"), "Derived selection state must not expose raw tokens.");

  unsubscribe();
  console.log("Active node selection smoke checks passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
