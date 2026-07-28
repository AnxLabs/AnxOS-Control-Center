const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-agent-errors-"));
const originalConsoleError = console.error;
const requestFailureLogs = [];
console.error = (...args) => {
  if (args[0] === "[AnxOS][Agent] Request failed.") {
    requestFailureLogs.push(args[1]);
    return;
  }
  originalConsoleError(...args);
};
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function createServer(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}`,
    }));
  });
}

async function main() {
  const auth = await createServer((request, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Old terminal recovery text should be ignored." } }));
  });
  const incompatible = await createServer((request, response) => {
    response.writeHead(426, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { code: "AGENT_INCOMPATIBLE", message: "Agent API is incompatible." } }));
  });
  const healthy = await createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify([]));
  });
  const offline = await createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => offline.server.close(resolve));

  writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "nodes.json"), {
    schemaVersion: 2,
    selectedNodeId: "auth-node",
    nodes: [
      { id: "auth-node", kind: "agent", displayName: "Auth Node", baseUrl: auth.baseUrl, agentUrl: auth.baseUrl, enabled: true },
      { id: "offline-node", kind: "agent", displayName: "Offline Node", baseUrl: offline.baseUrl, agentUrl: offline.baseUrl, enabled: true },
      { id: "incompatible-node", kind: "agent", displayName: "Old Node", baseUrl: incompatible.baseUrl, agentUrl: incompatible.baseUrl, enabled: true },
      { id: "healthy-node", kind: "agent", displayName: "Healthy Node", baseUrl: healthy.baseUrl, agentUrl: healthy.baseUrl, enabled: true },
    ],
  });
  writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "node-agent-credentials.json"), {
    schemaVersion: 1,
    nodes: {
      "auth-node": { agentToken: "bad-token" },
      "offline-node": { agentToken: "token" },
      "incompatible-node": { agentToken: "token" },
      "healthy-node": { agentToken: "token" },
    },
  });

  const serviceRouter = require("../src/services/serviceRouter");
  const agentClient = require("../src/services/agentClient");
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

  await assert.rejects(
    () => serviceRouter.listInstances({ nodeId: "auth-node" }),
    (error) => error.code === "UNAUTHORIZED" && error.status === 401 && /Re-pair|Repair/.test(error.message),
    "HTTP 401 must remain an authentication failure across service routing.",
  );
  await assert.rejects(
    () => serviceRouter.listInstances({ nodeId: "offline-node" }),
    (error) => ["ECONNREFUSED", "NETWORK_ERROR", "AGENT_UNAVAILABLE"].includes(error.code),
    "ECONNREFUSED must remain an offline/unavailable category.",
  );
  await assert.rejects(
    () => serviceRouter.listInstances({ nodeId: "incompatible-node" }),
    (error) => error.code === "AGENT_INCOMPATIBLE",
    "Compatibility errors must remain incompatible.",
  );
  const healthyResult = await serviceRouter.listInstances({ nodeId: "healthy-node" });
  assert.deepStrictEqual(healthyResult, [], "One node authentication failure must not affect another node.");
  assert(appSource.includes("Authentication failed.") && appSource.includes("Re-pair the Agent or repair the connection."), "Renderer must expose authentication-failed recovery copy.");
  assert(appSource.includes('id: "agent-url"') && appSource.includes("Correct the Agent URL"), "Renderer must provide wrong-URL recovery guidance.");
  assert(appSource.includes('id: "agent-tls"') && appSource.includes("certificate validity, and trust chain"), "Renderer must provide TLS-specific recovery guidance.");
  assert(appSource.includes('id: "agent-incompatible"') && appSource.includes("Agent update required.") && appSource.includes("Update the Agent on this node"), "Renderer must provide plain-language version-compatibility recovery guidance.");
  assert(appSource.includes('id: "agent-duplicate"') && appSource.includes("instead of creating a duplicate identity"), "Renderer must provide duplicate-identity recovery guidance.");
  const tlsMessage = agentClient._test.getAgentTransportErrorMessage("CERT_HAS_EXPIRED", "https://agent.example.test:47131");
  assert(/TLS verification failed/.test(tlsMessage) && /certificate validity/.test(tlsMessage), "TLS failures must provide certificate-specific guided recovery.");
  assert(!/token|authorization header/i.test(tlsMessage), "TLS recovery guidance must not request or expose credentials.");
  const serializedFailureLogs = JSON.stringify(requestFailureLogs);
  assert(!serializedFailureLogs.includes("bad-token"), "Agent failure diagnostics must not expose node credentials.");
  assert(!serializedFailureLogs.includes('"stack"'), "Expected Agent failures must not emit raw stack traces into diagnostics.");

  await Promise.all([auth, incompatible, healthy].map((entry) => new Promise((resolve) => entry.server.close(resolve))));
  console.log("Agent error category smoke checks passed.");
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    console.error = originalConsoleError;
    fs.rmSync(root, { recursive: true, force: true });
  });
