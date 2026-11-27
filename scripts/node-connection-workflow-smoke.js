const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const appJs = fs.readFileSync(path.join(root, "app.js"), "utf8");

[
  "One machine or server = one independently running AnxHost Agent.",
  "data-node-form-status",
  'data-node-field="description"',
  'data-node-field="tags"',
  'data-node-field="enabled"',
  'data-node-action="test-form"',
  'data-node-field-error="displayName"',
  'data-node-field-error="agentUrl"',
  'data-node-field-error="agentToken"',
  'placeholder="Leave blank to keep the existing token"',
].forEach((needle) => assert(index.includes(needle), `Node workflow UI should include ${needle}`));

[
  "function validateNodeFormPayload",
  "function setNodeFormErrors",
  "function setNodeFormBusy",
  "function testNodeFormConnection",
  "desktopApiState.api.nodes.testConnection(payload)",
  "nodeFormBusy",
  "payload.tags = String(field.value || \"\").split(\",\")",
  "field.dataset.nodeField === \"enabled\"",
].forEach((needle) => assert(appJs.includes(needle), `Renderer node workflow should include ${needle}`));

assert(!appJs.includes("window.prompt("), "Node workflow must not use window.prompt.");
assert(!appJs.includes("alert("), "Node workflow must not use alert.");
assert(!appJs.includes("confirm("), "Node workflow must not use browser confirm.");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-node-workflow-"));
process.env.ANXHUB_CONFIG_DIR = tempDir;

const nodeService = require("../src/services/nodeService");
const { saveNode, testNodeConnectionPayload } = nodeService;
const { getNodeToken } = require("../src/services/nodeCredentialStore");
const servers = [];

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve())).catch(() => {});
}

function createAgent({ token, apiVersion = "1", deviceId = "workflow-node" }) {
  return http.createServer((request, response) => {
    if (request.url !== "/api/v1/health") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
      return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "UNAUTHORIZED" } }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      apiVersion,
      protocolVersion: 1,
      capabilities: ["instances", "files"],
      identity: { deviceId, hostname: "Workflow Node", platform: "linux", agentVersion: "1.7.0" },
    }));
  });
}

(async () => {
  const server = createAgent({ token: "secret-token" });
  const oldServer = createAgent({ token: "old-token", apiVersion: "0", deviceId: "old-workflow-node" });
  servers.push(server, oldServer);
  const port = await listen(server);
  const oldPort = await listen(oldServer);
  const agentUrl = `http://127.0.0.1:${port}`;

  const created = await saveNode({
    displayName: "Workflow Node",
    agentUrl,
    agentToken: "secret-token",
    enabled: true,
    description: "Primary lab machine",
    tags: ["lab", "minecraft"],
  });
  const node = created.node;
  assert.strictEqual(node.displayName, "Workflow Node");
  assert.strictEqual(node.hasToken, true);
  assert.strictEqual(node.agentToken, "[configured]");
  assert.strictEqual(getNodeToken(node.id), "secret-token", "token should be stored in protected node credential store");

  const tested = await testNodeConnectionPayload({ id: node.id, displayName: "Workflow Node", agentUrl, agentToken: "" });
  assert.strictEqual(tested.connected, true, "blank edit token should reuse existing protected token for test connection");

  const edited = await saveNode({
    id: node.id,
    displayName: "Workflow Node Renamed",
    agentUrl,
    agentToken: "",
    enabled: false,
    description: "Edited without re-entering token",
    tags: ["edited"],
  });
  const editedNode = edited.node;
  assert.strictEqual(editedNode.id, node.id, "editing should preserve immutable node id");
  assert.strictEqual(editedNode.displayName, "Workflow Node Renamed");
  assert.strictEqual(editedNode.enabled, false);
  assert.deepStrictEqual(editedNode.tags, ["edited"]);
  assert.strictEqual(getNodeToken(node.id), "secret-token", "blank edit token must preserve previous protected token");

  await assert.rejects(
    () => testNodeConnectionPayload({ displayName: "Bad URL", agentUrl: "not a url", agentToken: "x" }),
    /valid Agent URL/,
  );
  await assert.rejects(
    () => testNodeConnectionPayload({ displayName: "Bad Token", agentUrl, agentToken: "wrong-token" }),
    /token rejected|authentication|Agent request failed/i,
  );
  await assert.rejects(
    () => saveNode({ displayName: "Bad Token Registration", agentUrl, agentToken: "wrong-token" }),
    (error) => error?.code === "UNAUTHORIZED" && error?.status === 401 && error?.details?.causeCode === "UNAUTHORIZED",
    "Node registration must preserve authentication failure classification for guided recovery.",
  );
  const originalFetch = global.fetch;
  global.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
  });
  try {
    await assert.rejects(
      () => nodeService._test.postPairingComplete(agentUrl, { pairingCode: "temporary", permanentToken: "replacement" }, { timeoutMs: 100 }),
      (error) => error?.code === "PAIRING_TIMEOUT" && error?.retryAvailable === false && /new pairing code/i.test(error.message),
      "Timed-out credential rotation must abort and require a fresh pairing code instead of blind retry.",
    );
  } finally {
    global.fetch = originalFetch;
  }
  const incompatible = await testNodeConnectionPayload({
    displayName: "Old Node",
    agentUrl: `http://127.0.0.1:${oldPort}`,
    agentToken: "old-token",
  });
  assert.strictEqual(incompatible.connected, false);
  assert.strictEqual(incompatible.status, "agent_incompatible");

  const nodesJson = fs.readFileSync(path.join(tempDir, "nodes.json"), "utf8");
  assert.strictEqual(nodesJson.includes("secret-token"), false, "nodes.json must not contain raw node token");

  await Promise.all(servers.map(close));
  console.log("Node connection workflow smoke checks passed.");
})().catch(async (error) => {
  console.error(error);
  await Promise.allSettled(servers.map(close));
  process.exitCode = 1;
});
