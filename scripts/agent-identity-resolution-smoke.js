const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-agent-identity-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

const nodes = require("../src/services/nodeService");

function writeNodes(nodeList) {
  // V2-J bullet 6: the node migration now writes a durable recovery point that
  // is deliberately NEVER replaced. Each call below simulates a fresh
  // installation state, so it must clear that recovery point too — otherwise a
  // later call hands the migration a different legacy source than the recorded
  // recovery point and verify-or-refuse correctly refuses.
  for (const name of fs.readdirSync(process.env.ANXHUB_CONFIG_DIR)) {
    if (/^nodes\.json\.schema-v\d+\.backup$/.test(name)) {
      fs.rmSync(path.join(process.env.ANXHUB_CONFIG_DIR, name), { force: true });
    }
  }
  fs.writeFileSync(nodes.getNodesPath(), `${JSON.stringify({
    schemaVersion: 2,
    selectedNodeId: "node-a",
    nodes: nodeList,
  }, null, 2)}\n`, { mode: 0o600 });
}

function node(id, patch = {}) {
  return {
    id,
    kind: "agent",
    name: patch.name || "Test Server",
    displayName: patch.name || "Test Server",
    baseUrl: patch.baseUrl || `http://10.0.0.${id === "node-a" ? "10" : "11"}:47131`,
    agentUrl: patch.agentUrl || patch.baseUrl || `http://10.0.0.${id === "node-a" ? "10" : "11"}:47131`,
    enabled: true,
    agentInstallationId: patch.agentInstallationId || "",
    agentIdentityId: patch.agentIdentityId || "",
    agentIdentity: {
      agentInstallationId: patch.agentInstallationId || "",
      agentIdentityId: patch.agentIdentityId || "",
      deviceId: patch.deviceId || id,
      hostname: patch.hostname || "same-name-host",
      operatingSystem: patch.operatingSystem || "",
      platform: patch.platform || "",
      architecture: "",
      agentVersion: "",
    },
  };
}

try {
  writeNodes([
    node("node-a", { agentInstallationId: "install-a", agentIdentityId: "identity-a", deviceId: "device-a", baseUrl: "http://192.168.1.134:47131/" }),
    node("node-b", { agentInstallationId: "install-b", agentIdentityId: "identity-b", deviceId: "device-b", baseUrl: "http://192.168.1.150:47131" }),
  ]);

  let resolved = nodes.resolveNodeForAgentIdentity({ identity: { agentInstallationId: "install-a" } });
  assert.strictEqual(resolved.nodeId, "node-a", "Stable Agent installation ID should win.");
  assert.strictEqual(resolved.matchType, "agentInstallationId");

  resolved = nodes.resolveNodeForAgentIdentity({ nodeId: "node-b", identity: { agentInstallationId: "missing" } });
  assert.strictEqual(resolved.nodeId, "node-b", "Explicit stored node association should be supported.");
  assert.strictEqual(resolved.matchType, "explicitNodeId");

  resolved = nodes.resolveNodeForAgentIdentity({ nodeId: "node-b", identity: { agentIdentityId: "identity-a" } });
  assert.strictEqual(resolved.nodeId, "node-a", "Authenticated stable identity must win over a stale selected-node association.");
  assert.strictEqual(resolved.matchType, "agentIdentityId");

  resolved = nodes.resolveNodeForAgentIdentity({ identity: { agentIdentityId: "identity-b" } });
  assert.strictEqual(resolved.nodeId, "node-b", "Stable Agent identity ID should resolve a node.");

  resolved = nodes.resolveNodeForAgentIdentity({ identity: { deviceId: "device-a" } });
  assert.strictEqual(resolved.nodeId, "node-a", "Legacy stable device ID should resolve a node.");

  resolved = nodes.resolveNodeForAgentIdentity({ agentUrl: "http://192.168.1.134:47131///" });
  assert.strictEqual(resolved.nodeId, "node-a", "Normalized URL fallback should work for older Agents.");

  writeNodes([
    node("node-a", { agentInstallationId: "install-a", agentIdentityId: "identity-a", deviceId: "device-a", baseUrl: "http://10.10.10.10:47131" }),
    node("node-b", { agentInstallationId: "install-b", agentIdentityId: "identity-b", deviceId: "device-b", baseUrl: "http://192.168.1.150:47131" }),
  ]);
  resolved = nodes.resolveNodeForAgentIdentity({ identity: { agentInstallationId: "install-a" }, agentUrl: "http://old-address:47131" });
  assert.strictEqual(resolved.nodeId, "node-a", "Changed URL should not break explicit stable identity matching.");

  resolved = nodes.resolveNodeForAgentIdentity({ name: "Test Server", identity: { hostname: "same-name-host" } });
  assert.strictEqual(resolved.nodeId, null, "Display name and hostname alone must not identify a node.");
  assert.strictEqual(resolved.matchType, "none");

  writeNodes([
    node("node-a", { agentInstallationId: "", agentIdentityId: "", deviceId: "legacy-a", baseUrl: "http://duplicate:47131" }),
    node("node-b", { agentInstallationId: "", agentIdentityId: "", deviceId: "legacy-b", baseUrl: "http://duplicate:47131/" }),
  ]);
  resolved = nodes.resolveNodeForAgentIdentity({ agentUrl: "http://duplicate:47131" });
  assert.strictEqual(resolved.ambiguous, true, "Ambiguous URL fallback should be rejected safely.");
  assert.strictEqual(resolved.nodeId, null);

  console.log("Agent identity resolution smoke checks passed.");
} catch (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
