#!/usr/bin/env node
// Server file downloads (Build 213-F): the exact bytes of one file, from the
// Agent's instance service, through its REST route and the desktop client.
// Real Agent route and core on a temp tree; the HTTP server in front of the
// route copies agent/src/server.js's stream handling (requiring server.js
// starts the listener).
//   D1 the core returns a binary file byte for byte
//   D2 paths outside the data folder, links that leave it, folders and files
//      over the limit are refused
//   D3 the REST route streams the bytes, and agentClient.downloadInstanceFile
//      receives them unchanged with the node credential
//   D4 an Agent without the route (older build) is reported as "update the
//      Agent"; a missing file stays PATH_NOT_FOUND
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { pipeline } = require("stream");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const root = pinAgentRoots("anx-file-download-");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

const core = require("../agent/src/services/instances/instanceService");
const { handleInstances } = require("../agent/src/routes/instances");
const agentClient = require("../src/services/agentClient");

const INSTANCE_ID = "download-instance";
const dataRoot = path.join(process.env.AGENT_INSTANCE_ROOT, INSTANCE_ID, "data");
fs.mkdirSync(path.join(dataRoot, "plugins"), { recursive: true });
fs.writeFileSync(path.join(process.env.AGENT_INSTANCE_ROOT, INSTANCE_ID, "config.json"), `${JSON.stringify({ id: INSTANCE_ID, displayName: "Download", state: "Stopped" }, null, 2)}\n`);
// A jar-like file: zip magic, NULs, every byte value, invalid UTF-8.
const jar = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0xc3, 0x28]), crypto.randomBytes(300 * 1024)]);
fs.writeFileSync(path.join(dataRoot, "plugins", "test plugin.jar"), jar);
const outside = path.join(root, "outside");
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(outside, "secret.txt"), "not yours");

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function startAgentFront({ legacy = false } = {}) {
  const requests = [];
  const server = http.createServer(async (request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization || "" });
    const url = new URL(request.url, "http://127.0.0.1");
    if (legacy && url.pathname.endsWith("/file/download")) {
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { code: "NOT_FOUND", message: "Request failed." } }));
      return;
    }
    const result = await handleInstances(request, url);
    if (result?.stream) {
      response.writeHead(result.statusCode || 200, { "Cache-Control": "no-store", ...result.headers });
      pipeline(result.stream, response, () => {});
      return;
    }
    response.writeHead(result?.statusCode || 200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(result?.body ?? null));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((done) => server.close(done)),
  })));
}

function registerNodes(entries) {
  fs.writeFileSync(path.join(process.env.ANXHUB_CONFIG_DIR, "nodes.json"), `${JSON.stringify({
    schemaVersion: 3,
    selectedNodeId: entries[0].id,
    nodes: entries.map(({ id, url }) => ({ id, kind: "agent", name: id, displayName: id, baseUrl: url, agentUrl: url, enabled: true, agentIdentity: { deviceId: `device-${id}` } })),
  }, null, 2)}
`);
  fs.writeFileSync(path.join(process.env.ANXHUB_CONFIG_DIR, "node-agent-credentials.json"), `${JSON.stringify({
    schemaVersion: 1,
    nodes: Object.fromEntries(entries.map(({ id }) => [id, { agentToken: `token-${id}` }])),
  }, null, 2)}
`);
}

async function main() {
  // D1
  const download = await core.openInstanceFileDownload(INSTANCE_ID, "plugins/test plugin.jar");
  assert.strictEqual(download.size, jar.length);
  assert.strictEqual(download.fileName, "test plugin.jar");
  assert.ok((await collect(download.stream)).equals(jar), "the core must return the exact bytes");
  console.log("  ok D1 core returns the file byte for byte");

  // D2
  await assert.rejects(core.openInstanceFileDownload(INSTANCE_ID, "../config.json"), (error) => error.code === "PATH_NOT_ALLOWED");
  await assert.rejects(core.openInstanceFileDownload(INSTANCE_ID, "plugins"), (error) => error.code === "PATH_NOT_FILE");
  await assert.rejects(core.openInstanceFileDownload(INSTANCE_ID, "plugins/test plugin.jar", { maxBytes: 1024 }), (error) => error.code === "FILE_TOO_LARGE" && error.statusCode === 413);
  fs.symlinkSync(outside, path.join(dataRoot, "escape"), "junction");
  await assert.rejects(core.openInstanceFileDownload(INSTANCE_ID, "escape/secret.txt"), (error) => error.code === "PATH_NOT_ALLOWED");
  console.log("  ok D2 escapes, links out, folders and oversized files are refused");

  // D3
  const agent = await startAgentFront();
  const legacy = await startAgentFront({ legacy: true });
  registerNodes([{ id: "node-a", url: agent.url }, { id: "node-old", url: legacy.url }]);
  try {
    const received = await agentClient.downloadInstanceFile(INSTANCE_ID, "plugins/test plugin.jar", agentClient.forNode("node-a").target.config);
    assert.ok(received.buffer.equals(jar), "the desktop must receive the exact bytes");
    assert.strictEqual(received.fileName, "test plugin.jar");
    const last = agent.requests.at(-1);
    assert.strictEqual(last.url, `/api/v1/instances/${INSTANCE_ID}/file/download?path=plugins%2Ftest+plugin.jar`);
    assert.strictEqual(last.authorization, "Bearer token-node-a");
    console.log("  ok D3 REST route streams the bytes to the desktop client");

    // D4 (missing file on a current Agent)
    await assert.rejects(
      agentClient.downloadInstanceFile(INSTANCE_ID, "plugins/missing.jar", agentClient.forNode("node-a").target.config),
      (error) => error.code === "PATH_NOT_FOUND",
    );
  } finally {
    await agent.close();
  }
  try {
    await assert.rejects(
      agentClient.downloadInstanceFile(INSTANCE_ID, "plugins/test plugin.jar", agentClient.forNode("node-old").target.config),
      (error) => error.code === "AGENT_UPDATE_REQUIRED" && /Update the Agent/.test(error.message),
    );
  } finally {
    await legacy.close();
  }
  console.log("  ok D4 an older Agent asks for an update; a missing file stays PATH_NOT_FOUND");
  console.log("Instance file download smoke passed (4 cases).");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
