#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-agent-compat-"));
process.env.ANXHUB_CONFIG_DIR = tempDir;

const {
  checkNodeHealth,
  getNodesPath,
  NODE_SCHEMA_VERSION,
  _test,
} = require("../src/services/nodeService");
const { setNodeToken } = require("../src/services/nodeCredentialStore");

function report(health) {
  return _test.getAgentCompatibilityReport(health);
}

assert.strictEqual(_test.normalizeAgentApiMajor("v1"), 1, "API v1 should normalize to major 1.");
assert.strictEqual(_test.normalizeAgentApiMajor(1), 1, "Numeric API 1 should normalize to major 1.");
assert.strictEqual(_test.normalizeAgentApiMajor("1"), 1, "String API 1 should normalize to major 1.");
assert.strictEqual(_test.normalizeAgentProtocolVersion(1), 1, "Numeric protocol 1 should normalize.");
assert.strictEqual(_test.normalizeAgentProtocolVersion("1"), 1, "String protocol 1 should normalize.");
assert.strictEqual(_test.compareAgentVersions("1.9 Build 190", "1.9 Build 191"), -1, "Older Agent builds should compare below the minimum.");
assert.strictEqual(_test.compareAgentVersions("1.9 Build 191", "1.9 Build 191"), 0, "Matching Agent builds should compare equal.");
assert.strictEqual(_test.compareAgentVersions("1.9 Build 192", "1.9 Build 191"), 1, "Newer Agent builds should remain compatible.");

assert.strictEqual(report({ ok: true, apiVersion: "v1", protocolVersion: 1, identity: { agentVersion: "0.1.0" } }).compatible, true, "Live Anxlab payload should be compatible.");
assert.strictEqual(report({ ok: true, apiVersion: "v1", protocolVersion: "1", identity: { agentVersion: "0.1.0" } }).compatible, true, "Protocol string 1 should be compatible.");
assert.strictEqual(report({ ok: true, apiVersion: "1", protocolVersion: 1, identity: { agentVersion: "0.1.0" } }).compatible, true, "Agent product version 0.1.0 must not drive compatibility.");
assert.strictEqual(report({ ok: true, apiVersion: "bogus", protocolVersion: 1 }).compatible, false, "Malformed API version should be incompatible.");
assert.strictEqual(report({ ok: true, apiVersion: "v2", protocolVersion: 1 }).compatible, false, "Unsupported API major should be incompatible.");
assert.strictEqual(report({ ok: true, apiVersion: "v1", protocolVersion: 3 }).compatible, false, "Unsupported protocol should be incompatible.");
assert.strictEqual(report({ ok: true, apiVersion: "v1" }).compatible, false, "Missing protocol should be incompatible.");
assert.strictEqual(report({ ok: true, apiVersion: "v1", protocolVersion: 1, agentVersion: "1.9 Build 190", minimumAgentVersion: "1.9 Build 191" }).compatible, false, "An explicitly older Agent build should require an update.");
assert.strictEqual(report({ ok: true, apiVersion: "v1", protocolVersion: 1, agentVersion: "1.9 Build 191", minimumAgentVersion: "1.9 Build 191" }).compatible, true, "A matching Agent build should be compatible.");
assert.strictEqual(report({ ok: true, apiVersion: "v1", protocolVersion: 1, agentVersion: "1.9 Build 192", minimumAgentVersion: "1.9 Build 191" }).compatible, true, "A newer Agent build should be compatible.");

const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const htmlSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
assert(htmlSource.includes("data-agent-compatibility-card") && htmlSource.includes("Update Agent") && htmlSource.includes("Retry Connection") && htmlSource.includes("Refresh Version"), "Agent Control should expose the guided compatibility card and recovery actions.");
assert(appSource.includes("INCOMPATIBLE_AGENT_PROTECTED_ACTIONS") && appSource.includes("Requires an updated Agent."), "Protected Agent actions should be gated with an accessible explanation.");
assert(appSource.includes("agentCompatibilityNoticeKey") && appSource.includes("blockIncompatibleAgentAction"), "Compatibility warnings should be deduplicated before Operations are created.");
assert(appSource.includes("await refreshNodes();") && appSource.includes("await refreshAgentControl({ includeConfig: false });"), "Compatibility refresh should re-probe node and Agent capability state.");

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

(async () => {
  const server = http.createServer((request, response) => {
    assert.strictEqual(request.headers.authorization, "Bearer compat-token", "Health check should preserve node token authentication.");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      service: "anxos-agent",
      apiVersion: "v1",
      protocolVersion: 1,
      identity: {
        deviceId: "anxlab-device",
        hostname: "Anxlab",
        agentVersion: "0.1.0",
      },
    }));
  });
  const port = await listen(server);
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(getNodesPath(), `${JSON.stringify({
      schemaVersion: NODE_SCHEMA_VERSION,
      selectedNodeId: "anxlab",
      nodes: [{
        id: "anxlab",
        kind: "agent",
        displayName: "Anxlab",
        baseUrl: `http://127.0.0.1:${port}`,
        agentUrl: `http://127.0.0.1:${port}`,
        enabled: true,
        lastConnectionState: "agent_incompatible",
        connection: {
          status: "agent_incompatible",
          connected: false,
          versionCompatibility: "update-required",
          message: "This Agent is reachable, but its API is not compatible with this Control Center.",
        },
        agentIdentity: { deviceId: "anxlab-device", hostname: "Anxlab" },
      }],
      removedLocalAgents: [],
    }, null, 2)}\n`);
    setNodeToken("anxlab", "compat-token");

    const refreshed = await checkNodeHealth("anxlab", { timeoutMs: 1000 });
    assert.strictEqual(refreshed.state, "online", "Valid API v1/protocol 1 health should clear stale Update Required state.");
    assert.strictEqual(refreshed.connected, true, "Compatible live payload should render as connected.");
    assert.strictEqual(refreshed.node.connection.versionCompatibility, "compatible", "Stale update-required compatibility should be cleared.");
    assert.strictEqual(refreshed.node.connection.compatibility.status, "Compatible", "Node details should expose compatible status.");
    assert(refreshed.node.connection.message.includes("Control Center supports: API v1, Protocol 1."), "Node message should include supported API/protocol.");
    assert(refreshed.node.connection.message.includes("Agent reports: API v1, Protocol 1."), "Node message should include reported API/protocol.");
    assert(refreshed.node.connection.message.includes("Status: Compatible."), "Node message should show Compatible status.");

    console.log("Agent compatibility smoke checks passed.");
  } finally {
    server.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
