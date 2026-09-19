#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-node-credential-repair-"));
process.env.ANXHUB_CONFIG_DIR = root;

const nodeService = require("../src/services/nodeService");
const credentials = require("../src/services/nodeCredentialStore");
const { tokenFingerprint } = require("../src/shared/agentTokenStore");

const endpoint = "http://192.168.1.134:47131";
const missingEndpoint = "http://192.168.1.135:47131";
const staleToken = "stale-node-token";
const currentToken = "current-agent-token";
const otherToken = "other-node-token";
const liveFingerprint = tokenFingerprint(currentToken);

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function writeNodeState({ selectedNodeId = "anxlab", includeLegacyToken = true, nodeId = "anxlab", nodeEndpoint = endpoint } = {}) {
  writeJson(nodeService.getNodesPath(), {
    schemaVersion: nodeService.NODE_SCHEMA_VERSION,
    selectedNodeId,
    nodes: [
      {
        id: nodeId,
        kind: "agent",
        displayName: "Anxlab",
        agentUrl: nodeEndpoint,
        baseUrl: nodeEndpoint,
        enabled: true,
        ...(includeLegacyToken ? { agentToken: staleToken } : {}),
        agentIdentity: { deviceId: "device-anxlab", hostname: "Anxlab", agentVersion: "0.1.0" },
      },
      {
        id: "other-node",
        kind: "agent",
        displayName: "Other Node",
        agentUrl: "http://10.0.0.10:47131",
        baseUrl: "http://10.0.0.10:47131",
        enabled: true,
        agentIdentity: { deviceId: "device-other", hostname: "Other", agentVersion: "0.1.0" },
      },
    ],
    removedLocalAgents: [],
  });
}

async function main() {
  const originalFetch = global.fetch;
  const records = [];
  try {
    global.fetch = async (url, options = {}) => {
      records.push({ url: String(url), hasAuthorization: Boolean(options.headers?.Authorization) });
      if (![`${endpoint}/api/v1/health`, `${missingEndpoint}/api/v1/health`].includes(String(url))) {
        throw new Error(`Unexpected request: ${url}`);
      }
      return new Response(JSON.stringify({
        ok: true,
        service: "anxos-agent",
        tokenConfigured: true,
        tokenFingerprint: liveFingerprint,
        identity: { deviceId: "device-anxlab", hostname: "Anxlab", agentVersion: "0.1.0" },
        apiVersion: "v1",
        protocolVersion: 1,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };

    writeJson(path.join(root, "agent.json"), { backendMode: "agent", agentUrl: endpoint, agentToken: currentToken });
    writeNodeState();
    credentials.setNodeToken("anxlab", staleToken);
    credentials.setNodeToken("other-node", otherToken);

    const mismatch = await nodeService.getNodeCredentialStatus("anxlab");
    assert.strictEqual(mismatch.status, "mismatch", "Stale node credential should be reported as a mismatch.");
    assert.strictEqual(mismatch.storedCredentialFingerprint, tokenFingerprint(staleToken), "Stored fingerprint should describe only the protected node credential.");
    assert.strictEqual(mismatch.runningAgentConfiguredFingerprint, liveFingerprint, "Configured Agent fingerprint should match live health.");
    assert.strictEqual(mismatch.liveHealthFingerprint, liveFingerprint, "Live health fingerprint should be reported.");

    const repaired = await nodeService.repairNodeCredential({ nodeId: "anxlab" });
    assert.strictEqual(repaired.repaired, true, "Mismatched credential should be repaired from matching configured Agent token.");
    assert.strictEqual(repaired.repairStatus, "credential-updated", "Repair should update only the saved node credential.");
    assert.strictEqual(repaired.restartRequired, false, "Credential repair must not require restart.");
    assert.strictEqual(repaired.after.status, "valid", "Credential should be valid after repair.");
    assert.strictEqual(credentials.getNodeToken("other-node"), otherToken, "Repair must preserve other node credentials.");

    const valid = await nodeService.repairNodeCredential({ nodeId: "anxlab" });
    assert.strictEqual(valid.repaired, false, "Valid credential should be a no-op.");
    assert.strictEqual(valid.repairStatus, "already-valid", "Valid credential should report already-valid.");
    assert.strictEqual(valid.restartRequired, false, "Valid no-op must not require restart.");

    credentials.deleteNodeToken("missing-node");
    writeNodeState({ selectedNodeId: "missing-node", includeLegacyToken: false, nodeId: "missing-node", nodeEndpoint: missingEndpoint });
    credentials.setNodeToken("other-node", otherToken);
    const missing = await nodeService.getNodeCredentialStatus("missing-node");
    assert.strictEqual(missing.status, "missing", "Missing protected node credential should be reported.");
    const missingRepair = await nodeService.repairNodeCredential({ nodeId: "missing-node" });
    assert.strictEqual(missingRepair.repaired, false, "Missing credential without a trusted matching token should not be silently repaired.");
    assert.strictEqual(missingRepair.repairStatus, "re-pair-required", "Missing credential without a trusted token should require re-pairing.");
    assert.strictEqual(missingRepair.restartRequired, false, "Missing credential recovery must not rotate or restart automatically.");
    assert.strictEqual(credentials.getNodeToken("other-node"), otherToken, "Missing-credential repair must preserve other credentials.");

    const output = JSON.stringify({ mismatch, repaired, valid, missing, missingRepair });
    for (const secret of [staleToken, currentToken, otherToken]) {
      assert(!output.includes(secret), "Credential diagnostics must not expose raw tokens.");
    }
    assert(records.length >= 4, "Health fingerprint should be checked during status and repair flows.");

    console.log("Node credential repair smoke checks passed.");
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});