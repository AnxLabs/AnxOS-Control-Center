const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-node-registry-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

const nodes = require("../src/services/nodeService");
const { getNodeToken, setNodeToken } = require("../src/services/nodeCredentialStore");
// Hermeticity: deleteNode performs a best-effort enrollment revocation against
// the node's configured agent URL (a LAN address in this fixture). Stub the
// transport so the smoke never emits a live network request.
const agentClient = require("../src/services/agentClient");
agentClient.revokeAgentEnrollment = async () => ({ revoked: true });

const legacyNode = {
  id: "anxlab",
  displayName: "Anxlab",
  agentUrl: "http://user:pass@192.168.1.134:47131/",
  agentToken: "node-specific-token",
  enabled: false,
  description: "Lab machine",
  tags: ["lab", "linux", ""],
  connection: {
    status: "online",
    lastSeen: "2026-07-15T00:00:00.000Z",
  },
};

try {
  const migrated = nodes.migrateState({ schemaVersion: 1, selectedNodeId: "anxlab", nodes: [legacyNode] });
  assert.strictEqual(migrated.nodes.length, 1, "Migration should preserve a single legacy node.");
  assert.strictEqual(migrated.nodes[0].id, "anxlab", "Migration should preserve existing node IDs.");
  assert.strictEqual(migrated.nodes[0].name, "Anxlab", "Migration should add canonical name.");
  assert.strictEqual(migrated.nodes[0].displayName, "Anxlab", "Migration should preserve display name.");
  assert.strictEqual(migrated.nodes[0].baseUrl, "http://192.168.1.134:47131", "Migration should normalize baseUrl and strip URL credentials.");
  assert.strictEqual(migrated.nodes[0].agentUrl, "http://192.168.1.134:47131", "Compatibility agentUrl should match normalized baseUrl.");
  assert.strictEqual(migrated.nodes[0].enabled, false, "Migration should preserve enabled state.");
  assert.deepStrictEqual(migrated.nodes[0].tags, ["lab", "linux"], "Migration should normalize tags.");
  assert.strictEqual(migrated.nodes[0].lastConnectionState, "online", "Migration should preserve last connection state.");
  assert.strictEqual(migrated.nodes[0].lastSuccessfulHealthCheck, "2026-07-15T00:00:00.000Z", "Migration should preserve last health timestamp.");

  fs.writeFileSync(nodes.getNodesPath(), `${JSON.stringify({ schemaVersion: 1, selectedNodeId: "anxlab", nodes: [legacyNode] }, null, 2)}\n`, { mode: 0o600 });
  const listed = nodes.listNodes({ discoverLocalAgent: false, refreshIdentity: false });
  Promise.resolve(listed).then(async (state) => {
    const node = state.nodes.find((entry) => entry.id === "anxlab");
    assert(node, "Deserialization should return the migrated node.");
    assert.strictEqual(node.baseUrl, "http://192.168.1.134:47131", "Public node should expose normalized baseUrl.");
    assert.strictEqual(node.agentUrl, "http://192.168.1.134:47131", "Public node should preserve compatibility agentUrl.");
    assert.strictEqual(node.hasToken, true, "Public node should report token presence.");
    assert.strictEqual(node.agentToken, "[configured]", "Public node should not expose the raw token.");

    const persisted = JSON.parse(fs.readFileSync(nodes.getNodesPath(), "utf8"));
    const serialized = JSON.stringify(persisted);
    assert(!serialized.includes("node-specific-token"), "nodes.json must not contain raw node tokens.");
    assert.strictEqual(persisted.nodes[0].baseUrl, "http://192.168.1.134:47131", "nodes.json should persist baseUrl.");
    assert.strictEqual(persisted.nodes[0].enabled, false, "nodes.json should persist enabled state.");

    const credentialsRaw = fs.readFileSync(nodes.getNodeCredentialsPath(), "utf8");
    assert(!credentialsRaw.includes("node-specific-token"), "Credential store must encrypt the node token at rest.");
    assert.strictEqual(getNodeToken("anxlab"), "node-specific-token", "Credential store should decrypt the node token for trusted main-process consumers.");

    const config = nodes.getNodeAgentConfig("anxlab");
    assert.strictEqual(config.agentUrl, "http://192.168.1.134:47131", "Agent config should resolve node baseUrl.");
    assert.strictEqual(config.agentToken, "node-specific-token", "Agent config should resolve node token from credential store.");

    setNodeToken("anxlab", "new-canonical-token");
    fs.writeFileSync(nodes.getNodesPath(), `${JSON.stringify({
      schemaVersion: nodes.NODE_SCHEMA_VERSION,
      selectedNodeId: "anxlab",
      nodes: [{ ...persisted.nodes[0], agentToken: "stale-metadata-token" }],
    }, null, 2)}\n`, { mode: 0o600 });
    assert.strictEqual(nodes.getNodeAgentConfig("anxlab").agentToken, "new-canonical-token", "Protected node credential store must be the canonical token source over stale node metadata.");

    await nodes.deleteNode("anxlab");
    assert.strictEqual(getNodeToken("anxlab"), "", "Deleting a node should delete its stored credential.");

    console.log("Node registry model smoke checks passed.");
  }).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }).finally(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
} catch (error) {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.error(error.stack || error.message);
  process.exitCode = 1;
}
