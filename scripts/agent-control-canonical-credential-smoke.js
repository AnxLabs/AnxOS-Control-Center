#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

// V2-J bullet 6: migrating the legacy global Agent config now plants a durable,
// never-replaced `.schema-v0.backup`. This smoke rewrites that legacy file for
// different scenarios, which is exactly the state verify-or-refuse refuses, so
// each rewrite must start from a clean recovery point.
function writeLegacyAgentConfig(filePath, payload) {
  const directory = path.dirname(filePath);
  if (fs.existsSync(directory)) {
    for (const name of fs.readdirSync(directory)) {
      if (/^agent\.json\.schema-v\d+\.backup$/.test(name)) {
        fs.rmSync(path.join(directory, name), { force: true });
      }
    }
  }
  writeJson(filePath, payload);
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function createAgentServer({ expectedToken, hostname, records, unauthorizedDelayMs = 0 }) {
  return http.createServer((request, response) => {
    const auth = String(request.headers.authorization || "");
    records.push({ pathname: request.url, auth });
    if (request.method === "GET" && request.url === "/api/v1/health") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        service: "anxos-agent",
        apiVersion: "v1",
        protocolVersion: 1,
        identity: { deviceId: `${hostname.toLowerCase()}-device`, hostname, agentVersion: "0.1.0" },
      }));
      return;
    }
    const protectedPaths = new Set([
      "/api/v1/stats",
      "/api/v1/instances",
      "/api/v1/docker/capabilities",
      "/api/v1/public-access/snapshot",
      "/api/v1/amp/status",
    ]);
    if (request.method === "GET" && protectedPaths.has(request.url)) {
      if (auth !== `Bearer ${expectedToken}`) {
        setTimeout(() => {
          response.writeHead(401, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Unauthorized." } }));
        }, unauthorizedDelayMs);
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        process: { uptimeSeconds: 10, memoryBytes: 1024, cpuSeconds: 1, connectedClients: 1 },
        cpu: { usagePercent: 1 },
        memory: { used: 1024, total: 4096, percent: 25 },
      }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found." } }));
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-agent-control-creds-"));
  process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
  process.env.ANXOS_LOG_DIR = path.join(root, "logs");
  fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

  const remoteRecords = [];
  const localRecords = [];
  const remote = createAgentServer({ expectedToken: "node-token", hostname: "Anxlab", records: remoteRecords, unauthorizedDelayMs: 150 });
  const local = createAgentServer({ expectedToken: "local-token", hostname: "Windows Local Agent", records: localRecords });
  const remotePort = await listen(remote);
  const localPort = await listen(local);
  const remoteUrl = `http://127.0.0.1:${remotePort}`;
  const localUrl = `http://127.0.0.1:${localPort}`;

  try {
    const nodes = require("../src/services/nodeService");
    const credentials = require("../src/services/nodeCredentialStore");
    const control = require("../src/services/agentControlService");
    const agentClient = require("../src/services/agentClient");
    const agentConfigPath = agentClient.getAgentConfigPath();
    const beforeGlobalConfig = { backendMode: "agent", agentUrl: remoteUrl, agentToken: "stale-global-token" };

    writeJson(nodes.getNodesPath(), {
      schemaVersion: nodes.NODE_SCHEMA_VERSION,
      selectedNodeId: "anxlab",
      nodes: [{
        id: "anxlab",
        kind: "agent",
        name: "Anxlab",
        displayName: "Anxlab",
        baseUrl: remoteUrl,
        agentUrl: remoteUrl,
        enabled: true,
        agentIdentity: { deviceId: "anxlab-device", hostname: "Anxlab", agentVersion: "0.1.0" },
      }],
      removedLocalAgents: [],
    });
    writeLegacyAgentConfig(agentConfigPath, beforeGlobalConfig);
    assert.strictEqual(credentials.setNodeToken("anxlab", "stale-node-token"), true, "Smoke setup should begin with the rejected node credential.");

    const staleHealthRequest = nodes.checkNodeHealth("anxlab");
    while (!remoteRecords.some((record) => record.pathname === "/api/v1/stats" && record.auth === "Bearer stale-node-token")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.strictEqual(credentials.setNodeToken("anxlab", "node-token"), true, "Credential repair should replace the rejected node credential.");

    const selected = await control.listAgents({ selectedNodeId: "anxlab" });
    assert.strictEqual(selected.activeAgent?.nodeId, "anxlab", "Agent Control should expose the selected registered node as the active Agent.");
    assert.strictEqual(selected.activeAgent?.targetType, "node:anxlab", "Selected remote Agent Control target must use a node-scoped label.");
    assert.strictEqual(selected.activeAgent?.state, "Running", "Selected Anxlab should authenticate with the node credential.");
    assert(remoteRecords.some((record) => record.pathname === "/api/v1/stats" && record.auth === "Bearer node-token"), "Selected Anxlab /stats must use the canonical node credential.");
    assert(!remoteRecords.some((record) => record.auth === "Bearer stale-global-token"), "Selected Anxlab must not use the stale global Agent token.");
    assert.strictEqual(selected.nodeState?.nodes.find((node) => node.id === "anxlab")?.connection?.status, "online", "Agent Control must return the recovered canonical node registry snapshot.");
    await staleHealthRequest;
    const recoveredNode = nodes.getNode("anxlab");
    assert.strictEqual(recoveredNode.connection?.status, "online", "A delayed unauthorized response must not overwrite authenticated recovery.");
    assert.strictEqual(recoveredNode.connection?.authenticated, true, "Recovered node should be marked authenticated.");
    assert(recoveredNode.connection?.lastSeen, "Authenticated recovery should refresh last seen.");
    assert.strictEqual(recoveredNode.lastErrorCategory, null, "Authenticated recovery should clear the stale offline error.");
    const migratedGlobalConfig = JSON.parse(fs.readFileSync(agentConfigPath, "utf8"));
    assert.deepStrictEqual(
      { backendMode: migratedGlobalConfig.backendMode, agentUrl: migratedGlobalConfig.agentUrl, agentToken: migratedGlobalConfig.agentToken },
      beforeGlobalConfig,
      "Selecting Anxlab must not mutate global Agent settings beyond schema migration.",
    );
    assert.strictEqual(migratedGlobalConfig.schemaVersion, 1, "Reading legacy global Agent settings should apply the current schema.");

    writeJson(nodes.getNodesPath(), {
      schemaVersion: nodes.NODE_SCHEMA_VERSION,
      selectedNodeId: "application-host",
      nodes: [],
      removedLocalAgents: [],
    });
    writeLegacyAgentConfig(agentConfigPath, { backendMode: "agent", agentUrl: localUrl, agentToken: "local-token" });
    const global = await control.listAgents({ selectedNodeId: "application-host" });
    assert.strictEqual(global.configured?.state, "Running", "Global local Agent context should continue to use the local/global credential.");
    assert(localRecords.some((record) => record.pathname === "/api/v1/stats" && record.auth === "Bearer local-token"), "Local/global Agent /stats must use the global credential.");

    console.log("Agent Control canonical credential smoke checks passed.");
  } finally {
    remote.close();
    local.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
