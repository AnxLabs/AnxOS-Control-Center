const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-node-health-"));
process.env.ANXHUB_CONFIG_DIR = tempDir;

const { checkAllNodeHealth, checkNodeHealth, getNodesPath } = require("../src/services/nodeService");
const { setNodeToken } = require("../src/services/nodeCredentialStore");

// These assertions are about CLASSIFICATION (online vs offline vs
// authentication_failed vs agent_incompatible), not about latency, so the
// budget must not double as an implicit latency test. It did: a 1000 ms budget
// against real HTTP round trips to seven concurrent local fixtures made this
// suite fail intermittently whenever the machine was loaded (observed failing
// inside a full gate run at 152/252 while three other agents were working, then
// passing in isolation) — a flaky gate is a broken gate, because it produces
// false failures and erodes trust in the run.
//
// The tight budget is kept only where the test WANTS a failure: the
// closed-port probe below, where a refused connection is immediate and a
// timeout still classifies as offline either way.
const HEALTH_BUDGET_MS = 15000;

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve())).catch(() => {});
}

function createAgent({ token, payload, delayMs = 0 }) {
  let hits = 0;
  const server = http.createServer((request, response) => {
    hits += 1;
    // A real Agent implements /api/v1/stats (see agent/src/server.js) and
    // checkNodeHealth() treats a failing authenticated stats probe as
    // "degraded" even when /api/v1/health succeeds. This fixture must
    // simulate that endpoint too, or every node in this test would
    // incorrectly classify as "degraded" instead of "online".
    if (request.url !== "/api/v1/health" && request.url !== "/api/v1/stats") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "UNAUTHORIZED" } }));
      return;
    }
    if (request.url === "/api/v1/stats") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    }, delayMs);
  });
  return { server, getHits: () => hits };
}

const servers = [];

(async () => {
  const onlineA = createAgent({
    token: "token-a",
    payload: {
      ok: true,
      apiVersion: "1",
      protocolVersion: 1,
      agentVersion: "1.7.0",
      capabilities: ["instances", "docker"],
      identity: { deviceId: "agent-a", hostname: "Node A", platform: "linux", agentVersion: "1.7.0" },
    },
  });
  servers.push(onlineA.server);
  const onlineB = createAgent({
    token: "token-b",
    payload: {
      ok: true,
      apiVersion: "1",
      protocolVersion: 1,
      agentVersion: "1.7.1",
      capabilities: ["files"],
      identity: { deviceId: "agent-b", hostname: "Node B", platform: "win32", agentVersion: "1.7.1" },
    },
  });
  servers.push(onlineB.server);
  const authAgent = createAgent({
    token: "right-token",
    payload: { ok: true, apiVersion: "1", protocolVersion: 1, identity: { deviceId: "agent-auth", hostname: "Auth Node" } },
  });
  servers.push(authAgent.server);
  const incompatibleAgent = createAgent({
    token: "token-incompatible",
    payload: { ok: true, apiVersion: "0", protocolVersion: 1, identity: { deviceId: "agent-old", hostname: "Old Node", agentVersion: "0.1.0" } },
  });
  servers.push(incompatibleAgent.server);
  const recoveryAgent = createAgent({
    token: "token-recovery",
    payload: { ok: true, apiVersion: "1", protocolVersion: 1, identity: { deviceId: "agent-recovery", hostname: "Recovery Node" } },
  });
  servers.push(recoveryAgent.server);
  const slowAgent = createAgent({
    token: "token-slow",
    delayMs: 100,
    payload: { ok: true, apiVersion: "1", protocolVersion: 1, identity: { deviceId: "agent-slow", hostname: "Slow Node" } },
  });
  servers.push(slowAgent.server);

  const portA = await listen(onlineA.server);
  const portB = await listen(onlineB.server);
  const portAuth = await listen(authAgent.server);
  const portOld = await listen(incompatibleAgent.server);
  const portSlow = await listen(slowAgent.server);
  const recoveryProbe = http.createServer();
  await listen(recoveryProbe);
  const recoveryPort = recoveryProbe.address().port;
  await close(recoveryProbe);

  const nodes = [
    { id: "node-a", kind: "agent", displayName: "Node A", baseUrl: `http://127.0.0.1:${portA}`, agentIdentity: { deviceId: "agent-a" }, enabled: true },
    { id: "node-b", kind: "agent", displayName: "Node B", baseUrl: `http://127.0.0.1:${portB}`, agentIdentity: { deviceId: "agent-b" }, enabled: true },
    { id: "node-offline", kind: "agent", displayName: "Offline Node", baseUrl: "http://127.0.0.1:9", agentIdentity: { deviceId: "agent-offline" }, enabled: true },
    { id: "node-auth", kind: "agent", displayName: "Auth Node", baseUrl: `http://127.0.0.1:${portAuth}`, agentIdentity: { deviceId: "agent-auth" }, enabled: true },
    { id: "node-old", kind: "agent", displayName: "Old Node", baseUrl: `http://127.0.0.1:${portOld}`, agentIdentity: { deviceId: "agent-old" }, enabled: true },
    { id: "node-recovery", kind: "agent", displayName: "Recovery Node", baseUrl: `http://127.0.0.1:${recoveryPort}`, agentIdentity: { deviceId: "agent-recovery" }, enabled: true },
    { id: "node-slow", kind: "agent", displayName: "Slow Node", baseUrl: `http://127.0.0.1:${portSlow}`, agentIdentity: { deviceId: "agent-slow" }, enabled: true },
  ];

  fs.mkdirSync(tempDir, { recursive: true });
  fs.writeFileSync(getNodesPath(), `${JSON.stringify({ schemaVersion: 2, selectedNodeId: "node-a", nodes }, null, 2)}\n`);
  setNodeToken("node-a", "token-a");
  setNodeToken("node-b", "token-b");
  setNodeToken("node-offline", "token-offline");
  setNodeToken("node-auth", "wrong-token");
  setNodeToken("node-old", "token-incompatible");
  setNodeToken("node-recovery", "token-recovery");
  setNodeToken("node-slow", "token-slow");

  const result = await checkAllNodeHealth({ timeoutMs: HEALTH_BUDGET_MS });
  const states = new Map(result.nodes.map((entry) => [entry.nodeId, entry.state]));
  assert.strictEqual(states.get("node-a"), "online");
  assert.strictEqual(states.get("node-b"), "online");
  assert.strictEqual(states.get("node-offline"), "offline");
  assert.strictEqual(states.get("node-auth"), "authentication_failed");
  assert.strictEqual(states.get("node-old"), "agent_incompatible");

  const persisted = JSON.parse(fs.readFileSync(getNodesPath(), "utf8"));
  const byId = new Map(persisted.nodes.map((node) => [node.id, node]));
  assert.strictEqual(byId.get("node-a").lastConnectionState, "online");
  assert.ok(byId.get("node-a").lastSuccessfulHealthCheck, "online node should store last successful health check");
  assert.strictEqual(byId.get("node-auth").lastConnectionState, "authentication_failed");
  assert.strictEqual(byId.get("node-old").lastConnectionState, "agent_incompatible");
  assert.strictEqual(JSON.stringify(persisted).includes("token-a"), false, "tokens must not be persisted in nodes.json");
  assert.deepStrictEqual(byId.get("node-a").capabilitiesMetadata, ["instances", "docker"]);

  const slowHitsBefore = slowAgent.getHits();
  const slowChecks = await Promise.all([
    checkNodeHealth("node-slow", { timeoutMs: HEALTH_BUDGET_MS }),
    checkNodeHealth("node-slow", { timeoutMs: HEALTH_BUDGET_MS }),
  ]);
  assert.strictEqual(slowChecks[0].state, "online");
  assert.strictEqual(slowChecks[1].state, "online");
  // One full health-check cycle now makes two real requests (health, then the
  // authenticated stats probe); two overlapping calls deduplicated into a
  // single run should still only produce those two hits, not four.
  assert.strictEqual(slowAgent.getHits() - slowHitsBefore, 2, "overlapping checks for one node should be deduplicated");

  // Deliberately tight: this port is closed, so the check must classify it as
  // offline. A refused connection is immediate, and a budget expiry classifies
  // as offline too, so the tight value cannot make this leg flaky in the
  // direction that matters.
  const beforeRecovery = await checkNodeHealth("node-recovery", { timeoutMs: 250 });
  assert.strictEqual(beforeRecovery.state, "offline");
  await new Promise((resolve) => recoveryAgent.server.listen(recoveryPort, "127.0.0.1", resolve));
  const afterRecovery = await checkNodeHealth("node-recovery", { timeoutMs: HEALTH_BUDGET_MS });
  assert.strictEqual(afterRecovery.state, "online");

  await Promise.all(servers.map(close));
  console.log("Independent node health smoke checks passed.");
})().catch(async (error) => {
  console.error(error);
  await Promise.allSettled(servers.map(close));
  process.exitCode = 1;
});
