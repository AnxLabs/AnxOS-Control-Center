#!/usr/bin/env node
"use strict";

// A node list refresh (listNodes -> refreshIdentities) health-checks every
// node, which can take a full timeout for an unreachable one. A selection made
// while that runs must survive: the refresh used to write back the registry
// snapshot it read before the checks, reverting the user's choice.
// Run: node scripts/node-selection-race-smoke.js

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-node-selection-race-"));
process.env.ANXHUB_CONFIG_DIR = tempDir;

const { APPLICATION_HOST_NODE_ID, getNodesPath, listNodes, selectNode } = require("../src/services/nodeService");
const { setNodeToken } = require("../src/services/nodeCredentialStore");

const SLOW_MS = 1200;

// Answers every request, but only after SLOW_MS, like a node on a slow link.
function createSlowAgent(deviceId) {
  return http.createServer((request, response) => {
    setTimeout(() => {
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/api/v1/health") {
        response.end(JSON.stringify({ ok: true, service: "anxos-agent", apiVersion: "v1", protocolVersion: 1, identity: { deviceId, hostname: deviceId, agentVersion: "0.1.0" } }));
        return;
      }
      response.end(JSON.stringify({ hostname: deviceId, uptimeSeconds: 1, cpu: { usagePercent: 1 }, memory: { used: 1, total: 2, percent: 50 } }));
    }, SLOW_MS);
  });
}

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
const close = (server) => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
const persistedSelection = () => JSON.parse(fs.readFileSync(getNodesPath(), "utf8")).selectedNodeId;

(async () => {
  const agent = createSlowAgent("slow-node");
  const port = await listen(agent);
  const url = `http://127.0.0.1:${port}`;
  fs.mkdirSync(path.dirname(getNodesPath()), { recursive: true });
  fs.writeFileSync(getNodesPath(), `${JSON.stringify({
    schemaVersion: 2,
    selectedNodeId: "slow-node",
    nodes: [{ id: "slow-node", kind: "agent", displayName: "Slow", agentUrl: url, baseUrl: url, agentIdentity: { deviceId: "slow-node" } }],
  }, null, 2)}\n`);
  setNodeToken("slow-node", "slow-token");

  try {
    // R1: selecting the application host while a refresh is in flight sticks.
    const refresh = listNodes({ discoverLocalAgent: false });
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS / 3));
    await selectNode(APPLICATION_HOST_NODE_ID);
    assert.strictEqual(persistedSelection(), APPLICATION_HOST_NODE_ID, "the selection is saved immediately");
    const refreshed = await refresh;
    assert.strictEqual(persistedSelection(), APPLICATION_HOST_NODE_ID, "a refresh that started before the selection must not revert it");
    assert.strictEqual(refreshed.selectedNodeId, APPLICATION_HOST_NODE_ID, "the refresh reports the current selection");
    console.log("PASS R1 a selection made during a slow node refresh is kept");

    // R2: and the other way round, selecting a remote node during a refresh.
    const second = listNodes({ discoverLocalAgent: false });
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS / 3));
    await selectNode("slow-node");
    await second;
    assert.strictEqual(persistedSelection(), "slow-node", "a remote selection made during a refresh is kept");
    console.log("PASS R2 selecting a remote node during a refresh is kept");
  } finally {
    await close(agent);
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  console.log("node selection race smoke passed (2 checks).");
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
