#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-remote-pairing-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

const { createPairingSessionPayload } = require("../src/shared/agentPairing");
const agentPairingRoute = require("../agent/src/routes/pairing");

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function main() {
  const localSession = agentPairingRoute._test.createSession({ headers: { host: "127.0.0.1:47131" }, socket: {} }, { host: "127.0.0.1", port: 47131 });
  assert.strictEqual(localSession.agentUrl, "http://127.0.0.1:47131", "Local Windows Agent generation should retain localhost identity.");
  const remoteSession = agentPairingRoute._test.createSession({ headers: { host: "192.168.1.134:47131" }, socket: {} }, { host: "127.0.0.1", port: 47131 });
  assert.strictEqual(remoteSession.agentUrl, "http://192.168.1.134:47131", "Remote generation should use the requested Host header, not configured localhost.");

  const nodes = require("../src/services/nodeService");
  const agentControl = require("../src/services/agentControlService");
  const originalFetch = global.fetch;
  writeJson(nodes.getNodesPath(), {
    schemaVersion: nodes.NODE_SCHEMA_VERSION,
    selectedNodeId: "anxlab",
    nodes: [{
      id: "anxlab",
      kind: "agent",
      name: "Anxlab",
      displayName: "Anxlab",
      baseUrl: "http://192.168.1.134:47131",
      agentUrl: "http://192.168.1.134:47131",
      enabled: true,
      agentIdentity: { deviceId: "anxlab-device", hostname: "Anxlab" },
    }],
    removedLocalAgents: [],
  });
  global.fetch = async (url) => {
    assert.strictEqual(String(url), "http://192.168.1.134:47131/api/v1/pairing/start", "Anxlab generation must target the Anxlab endpoint.");
    const session = createPairingSessionPayload({ agentUrl: "http://192.168.1.134:47131" });
    return new Response(JSON.stringify({ ...session, status: "waiting" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const anxlabSession = await agentControl.startPairingSession({ nodeId: "anxlab" });
  assert.strictEqual(anxlabSession.requestedAgentUrl, "http://192.168.1.134:47131", "Remote Anxlab generation should preserve the selected node URL.");
  assert.strictEqual(anxlabSession.agentUrl, "http://192.168.1.134:47131", "Remote Anxlab payload must not be rewritten to localhost.");
  global.fetch = originalFetch;

  let completeCount = 0;
  let generatedCode = "";
  let generatedUrl = "";
  let acceptedToken = "";
  const server = http.createServer((request, response) => {
    const baseUrl = `http://${request.headers.host}`;
    if (request.method === "POST" && request.url === "/api/v1/pairing/start") {
      const session = createPairingSessionPayload({ agentUrl: baseUrl });
      generatedCode = session.pairingCode;
      generatedUrl = session.agentUrl;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ ...session, status: "waiting", identity: { deviceId: "anxlab-device", hostname: "Anxlab" } }));
      return;
    }
    if (request.method === "POST" && request.url === "/api/v1/pairing/complete") {
      completeCount += 1;
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        acceptedToken = JSON.parse(body || "{}").permanentToken || "";
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ status: "paired", identity: { deviceId: "anxlab-device", hostname: "Anxlab" }, tokenFingerprint: "abc123" }));
      });
      return;
    }
    if (request.method === "GET" && request.url === "/api/v1/health") {
      const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "") || request.headers["x-agent-token"] || "";
      response.writeHead(token && token === acceptedToken ? 200 : 401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        ok: token && token === acceptedToken,
        apiVersion: "1",
        protocolVersion: 1,
        agentVersion: "1.0.0",
        identity: { deviceId: "anxlab-device", hostname: "Anxlab", platform: "linux", architecture: "x64", agentVersion: "1.0.0", apiVersion: "1" },
        capabilities: [],
      }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found." } }));
  });

  const port = await listen(server);
  const remoteUrl = `http://127.0.0.1:${port}`;
  try {
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
        agentIdentity: { deviceId: "anxlab-device", hostname: "Anxlab" },
      }],
      removedLocalAgents: [],
    });

    const session = await agentControl.startPairingSession({ nodeId: "anxlab" });
    assert.strictEqual(session.requestedAgentUrl, remoteUrl, "Remote generation must target the selected node URL.");
    assert.strictEqual(session.agentUrl, remoteUrl, "Generated pairing payload must retain the intended Agent URL.");
    assert.strictEqual(generatedUrl, remoteUrl, "Remote generation must not fall back to configured localhost.");

    const repaired = await nodes.pairNodeFromCode({ id: "anxlab", pairingCode: session.pairingCode });
    assert.strictEqual(repaired.paired, true, "Existing Anxlab node should repair when generated and submitted URLs match.");
    assert.strictEqual(repaired.agentUrl, remoteUrl, "Pair submission should use the same Agent URL used for generation.");
    assert.strictEqual(completeCount, 1, "Matching repair should submit exactly one pairing completion request.");

    const localCode = createPairingSessionPayload({ agentUrl: "http://127.0.0.1:47131" }).pairingCode;
    await assert.rejects(
      () => nodes.pairNodeFromCode({ id: "anxlab", pairingCode: localCode }),
      (error) => error?.code === "NODE_REPAIR_URL_CONFIRMATION_REQUIRED" &&
        error.details?.currentAgentUrl === remoteUrl &&
        error.details?.pairingAgentUrl === "http://127.0.0.1:47131",
      "Localhost code used against Anxlab should produce one clear URL mismatch error.",
    );
    assert.strictEqual(completeCount, 1, "URL mismatch must be detected before consuming a pairing session.");

    console.log("Remote pairing target smoke checks passed.");
  } finally {
    global.fetch = originalFetch;
    server.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
