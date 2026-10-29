#!/usr/bin/env node
"use strict";

// Pairing self-repair and blip tolerance in checkNodeHealth
// (src/services/nodeService.js), against local fake Agents in a temporary
// config directory.
// Run: node scripts/node-self-repair-smoke.js

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-node-self-repair-"));
process.env.ANXHUB_CONFIG_DIR = tempDir;

const { checkNodeHealth, getNodesPath, _test } = require("../src/services/nodeService");
const { setNodeToken } = require("../src/services/nodeCredentialStore");

const health = (deviceId) => ({ ok: true, service: "anxos-agent", apiVersion: "v1", protocolVersion: 1, identity: { deviceId, hostname: deviceId, agentVersion: "0.1.0" } });

function createAgent(token, deviceId) {
  return http.createServer((request, response) => {
    if (request.url === "/api/v1/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(health(deviceId)));
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Agent token rejected." } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ hostname: deviceId, uptimeSeconds: 1, cpu: { usagePercent: 1 }, memory: { used: 1, total: 2, percent: 50 } }));
  });
}

const listen = (server, port = 0) => new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => server.close(() => resolve()));

(async () => {
  // S1: the grace window itself.
  const now = Date.parse("2026-10-29T12:00:00.000Z");
  const recent = { lastSuccessfulHealthCheck: "2026-10-29T11:59:30.000Z" };
  assert.strictEqual(_test.isWithinFailureGrace(recent, 1, now), true, "one failure right after a success is a blip");
  assert.strictEqual(_test.isWithinFailureGrace(recent, 2, now), false, "two failures in a row are an outage");
  assert.strictEqual(_test.isWithinFailureGrace({ lastSuccessfulHealthCheck: "2026-10-29T11:50:00.000Z" }, 1, now), false, "an old success gives no grace");
  assert.strictEqual(_test.isWithinFailureGrace({}, 1, now), false, "a node never seen online gets no grace");
  console.log("PASS S1 the grace window covers one recent failure only");

  // S2: a node that drops reads "Reconnecting" first, then Offline.
  let agent = createAgent("good-token", "blip-node");
  const port = await listen(agent);
  const denied = createAgent("canonical-token", "auth-node");
  const deniedPort = await listen(denied);
  const nodes = [
    { id: "blip-node", kind: "agent", displayName: "Blip", agentUrl: `http://127.0.0.1:${port}`, baseUrl: `http://127.0.0.1:${port}`, agentIdentity: { deviceId: "blip-node" } },
    { id: "auth-node", kind: "agent", displayName: "Auth", agentUrl: `http://127.0.0.1:${deniedPort}`, baseUrl: `http://127.0.0.1:${deniedPort}`, agentIdentity: { deviceId: "auth-node" } },
  ];
  fs.mkdirSync(path.dirname(getNodesPath()), { recursive: true });
  fs.writeFileSync(getNodesPath(), `${JSON.stringify({ schemaVersion: 2, selectedNodeId: "blip-node", nodes }, null, 2)}\n`);
  setNodeToken("blip-node", "good-token");
  setNodeToken("auth-node", "stale-token");

  let result = await checkNodeHealth("blip-node", { timeoutMs: 1000 });
  assert.strictEqual(result.state, "online");
  await close(agent);
  result = await checkNodeHealth("blip-node", { timeoutMs: 500 });
  assert.strictEqual(result.state, "connecting", "the first failure after a success reads as reconnecting");
  assert.match(result.message, /Reconnecting/);
  result = await checkNodeHealth("blip-node", { timeoutMs: 500 });
  assert.strictEqual(result.state, "offline", "a second failure in a row is reported as offline");
  agent = createAgent("good-token", "blip-node");
  await listen(agent, port);
  result = await checkNodeHealth("blip-node", { timeoutMs: 1000 });
  assert.strictEqual(result.state, "online", "the node recovers by itself");
  await close(agent);
  result = await checkNodeHealth("blip-node", { timeoutMs: 500 });
  assert.strictEqual(result.state, "connecting", "the failure streak resets after a success");
  console.log("PASS S2 a brief outage reads Reconnecting, a real one Offline, and recovery resets it");

  // S3: a rejected credential with no safe repair stays a clear re-pair prompt.
  result = await checkNodeHealth("auth-node", { timeoutMs: 1000 });
  assert.strictEqual(result.state, "authentication_failed", "no silent success when nothing proves the credential");
  assert.match(result.message, /Re-pair/);
  result = await checkNodeHealth("auth-node", { timeoutMs: 1000 });
  assert.strictEqual(result.state, "authentication_failed", "rejected credentials are never masked as reconnecting");
  console.log("PASS S3 rejected credentials without a safe repair ask for re-pairing");

  await close(denied);
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("node self-repair smoke passed (3 checks).");
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
