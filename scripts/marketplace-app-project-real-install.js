#!/usr/bin/env node
"use strict";

// Build 214: REAL installation check for the "Your Node.js Application" and
// "Your Python Application" cards. Needs Node.js and Python 3 on this
// computer. Builds two small test projects as .zip files, starts a disposable
// Agent with its own temp folders and installs them through the real
// Marketplace path:
//   N1 Node.js with a port and a bundled package (node_modules): ready on its
//      port, answers over HTTP with the package's value and the arguments,
//      and its data in the project folder survives Stop/Start
//   N2 Python with no port: ready once it keeps running, the arguments reach
//      it, data survives Stop/Start
//   N3 a project with unbundled npm dependencies, one with Python packages and
//      one with a path that leaves its folder are refused before anything is
//      created on the computer
// Run: node scripts/marketplace-app-project-real-install.js

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-app-project-real-install-desktop-");

const nodeService = require("../src/services/nodeService");
const agentClient = require("../src/services/agentClient");
const marketplaceService = require("../src/services/marketplaceService");
const { generateAgentToken, writeAgentConfigToken } = require("../src/shared/agentTokenStore");
const { zipBuffer } = require("../test-helpers/zip-writer");

const OPTIONS = { version: "", providerVersionId: "", serverType: "", storageLocation: "data", playitTunnel: false, acceptEula: false, start: true };
const results = [];

const NODE_SERVER = `const fs = require("fs");
const http = require("http");
const dep = require("tiny-dep");
const runs = (Number(fs.existsSync("runs.txt") ? fs.readFileSync("runs.txt", "utf8") : 0) || 0) + 1;
fs.writeFileSync("runs.txt", String(runs));
console.log("AnxOS node test run " + runs + " args " + JSON.stringify(process.argv.slice(2)));
http.createServer((_, response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ dep: dep.value, runs, args: process.argv.slice(2) }));
}).listen(Number(process.env.PORT), "0.0.0.0");
`;

const PYTHON_MAIN = `import json, os, sys, time
runs = int(open("runs.txt").read()) + 1 if os.path.exists("runs.txt") else 1
open("runs.txt", "w").write(str(runs))
print("AnxOS python test run %d args %s" % (runs, json.dumps(sys.argv[1:])), flush=True)
while True:
    time.sleep(1)
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}

async function waitFor(label, check, { timeoutMs = 60000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} did not happen in ${Math.round(timeoutMs / 1000)} s${last ? `: ${last.message}` : ""}`);
}

async function startAgent(agentRoot) {
  const configDir = path.join(agentRoot, "config");
  for (const dir of [configDir, path.join(agentRoot, "instances"), path.join(agentRoot, "logs")]) fs.mkdirSync(dir, { recursive: true });
  const token = generateAgentToken();
  writeAgentConfigToken(path.join(configDir, "agent.json"), token, { backendMode: "agent" });
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(repoRoot, "agent", "src", "server.js")], {
    cwd: path.join(repoRoot, "agent"),
    env: { ...process.env, ANXHUB_CONFIG_DIR: configDir, ANXHUB_AGENT_CONFIG_PATH: path.join(configDir, "agent.json"), AGENT_HOST: "127.0.0.1", AGENT_PORT: String(port), AGENT_IDENTITY_PATH: path.join(configDir, "identity.json"), AGENT_INSTANCE_ROOT: path.join(agentRoot, "instances"), ANXOS_LOG_DIR: path.join(agentRoot, "logs") },
    stdio: "ignore",
  });
  await waitFor("the disposable Agent", async () => (await fetch(`${url}/api/v1/health`)).ok, { timeoutMs: 20000, intervalMs: 150 });
  const registered = await nodeService.saveNode({ displayName: "App project real-install Agent", agentUrl: url, agentToken: token });
  const pairing = await (await fetch(`${url}/api/v1/pairing/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  await nodeService.pairNodeFromCode({ pairingCode: pairing.pairingCode });
  return { child, nodeId: registered.node.id, instanceRoot: path.join(agentRoot, "instances") };
}

async function status(id, agentConfig) {
  const reply = await agentClient.getInstanceStatus(id, agentConfig);
  return reply.instance || reply;
}

async function logText(id, agentConfig) {
  const reply = await agentClient.getInstanceLogs(id, { limit: 200 }, agentConfig).catch(() => null);
  const entries = reply?.entries || [];
  return entries.map((entry) => entry?.message ?? entry).join("\n");
}

async function ready(id, agentConfig) {
  return waitFor("Running and ready", async () => {
    const current = await status(id, agentConfig);
    if (current.state === "Failed") throw new Error(`failed: ${current.failureReason}`);
    return current.state === "Running" && current.readinessState === "ready" ? current : null;
  }).catch(async (error) => {
    const current = await status(id, agentConfig).catch(() => ({}));
    throw new Error(`${error.message} | ${current.state}/${current.readinessState}/${current.failureReason} | cmd ${current.executable} ${JSON.stringify(current.args)} in ${current.workingDirectory} | log: ${(await logText(id, agentConfig)).slice(-500)}`);
  });
}

async function check(id, fn) {
  const record = { id, steps: [] };
  results.push(record);
  try {
    await fn(record);
    record.ok = true;
  } catch (error) {
    record.ok = false;
    record.error = String(error?.message || error).slice(0, 900);
  }
  console.log(`${record.ok ? "PASS" : "FAIL"} ${id}: ${record.ok ? record.steps.join("; ") : record.error}`);
}

async function main() {
  console.log(`App project real install on ${os.platform()} ${os.release()}`);
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-app-project-real-install-agent-"));
  const zips = path.join(agentRoot, "zips");
  fs.mkdirSync(zips, { recursive: true });
  const write = (name, entries) => { const file = path.join(zips, name); fs.writeFileSync(file, zipBuffer(entries)); return file; };
  const nodeZip = write("node-project.zip", [
    { name: "web-app/package.json", data: JSON.stringify({ name: "web-app", main: "src/server.js", dependencies: { "tiny-dep": "1.0.0" } }) },
    { name: "web-app/src/server.js", data: NODE_SERVER },
    { name: "web-app/node_modules/tiny-dep/package.json", data: JSON.stringify({ name: "tiny-dep", version: "1.0.0", main: "index.js" }) },
    { name: "web-app/node_modules/tiny-dep/index.js", data: "module.exports = { value: 'bundled package works' };" },
  ]);
  const pythonZip = write("python-project.zip", [{ name: "worker/main.py", data: PYTHON_MAIN }, { name: "worker/requirements.txt", data: "# standard library only\n" }]);
  let agent = null;
  try {
    agent = await startAgent(agentRoot);
    const agentConfig = nodeService.getNodeAgentConfig(agent.nodeId);
    const install = (templateId, id, kind, file, extra) => marketplaceService.installTemplate({
      templateId,
      nodeId: agent.nodeId,
      requestId: `${id}-${Date.now()}`,
      options: { ...OPTIONS, id, name: id, memory: "256M", applicationFileToken: marketplaceService.rememberApplicationFile(file, kind).token, ...extra },
    });

    await check("N1", async (record) => {
      const id = "anx214-node-project";
      const port = await freePort();
      await install("node-app-import", id, "node-application", nodeZip, { programArguments: '--mode "very fast"', port, ports: [port] });
      await ready(id, agentConfig);
      record.steps.push(`Running / ready on port ${port}`);
      const reply = await waitFor("an HTTP answer", async () => (await fetch(`http://127.0.0.1:${port}/`)).json());
      assert.strictEqual(reply.dep, "bundled package works", "the bundled node_modules package loads");
      assert.deepStrictEqual(reply.args, ["--mode", "very fast"], "program arguments reach the app, quotes kept");
      assert.ok(fs.existsSync(path.join(agent.instanceRoot, id, "data", "app", "src", "server.js")), "the project is in data/app with its folders");
      record.steps.push("answers over HTTP with its bundled package and the arguments");
      await agentClient.stopInstance(id, agentConfig);
      await waitFor("Stopped", async () => (await status(id, agentConfig)).state === "Stopped");
      await agentClient.startInstance(id, agentConfig);
      await ready(id, agentConfig);
      const second = await waitFor("the second run answering", async () => { const body = await (await fetch(`http://127.0.0.1:${port}/`)).json(); return body.runs === 2 ? body : null; });
      assert.strictEqual(second.runs, 2, "data in the project folder survives Stop/Start");
      record.steps.push("data kept across Stop/Start (2 runs)");
      await agentClient.stopInstance(id, agentConfig);
    });

    await check("N2", async (record) => {
      const id = "anx214-python-project";
      await install("python-app-import", id, "python-application", pythonZip, { programArguments: "--queue jobs", ports: [] });
      const current = await ready(id, agentConfig);
      record.steps.push(`Running / ready with no port (${current.executable})`);
      const log = await waitFor("its first line", async () => { const text = await logText(id, agentConfig); return /AnxOS python test run 1/.test(text) ? text : null; });
      assert.match(log, /args \["--queue", "jobs"\]/, "program arguments reach the app");
      await agentClient.stopInstance(id, agentConfig);
      await waitFor("Stopped", async () => (await status(id, agentConfig)).state === "Stopped");
      await agentClient.startInstance(id, agentConfig);
      await waitFor("run 2", async () => /AnxOS python test run 2/.test(await logText(id, agentConfig)));
      assert.strictEqual(fs.readFileSync(path.join(agent.instanceRoot, id, "data", "app", "runs.txt"), "utf8").trim(), "2", "data survives Stop/Start");
      record.steps.push("arguments reach it; data kept across Stop/Start (2 runs)");
      await agentClient.stopInstance(id, agentConfig);
    });

    await check("N3", async (record) => {
      const before = fs.readdirSync(agent.instanceRoot).filter((name) => name !== "jobs").length;
      const unbundled = write("unbundled.zip", [{ name: "package.json", data: JSON.stringify({ dependencies: { express: "^5" } }) }, { name: "index.js", data: "require('express')" }]);
      await assert.rejects(install("node-app-import", "anx214-node-unbundled", "node-application", unbundled, { ports: [] }), /npm install --omit=dev/);
      const packages = write("packages.zip", [{ name: "main.py", data: "import requests" }, { name: "requirements.txt", data: "requests\n" }]);
      await assert.rejects(install("python-app-import", "anx214-python-packages", "python-application", packages, { ports: [] }), /does not install Python packages/);
      const escape = write("escape.zip", [{ name: "package.json", data: "{}" }, { name: "index.js", data: "x" }, { name: "../outside.js", data: "x" }]);
      await assert.rejects(install("node-app-import", "anx214-node-escape", "node-application", escape, { ports: [] }), /leaves its folder/);
      assert.strictEqual(fs.readdirSync(agent.instanceRoot).filter((name) => name !== "jobs").length, before, "nothing was created");
      assert.ok(!fs.existsSync(path.join(agent.instanceRoot, "outside.js")) && !fs.existsSync(path.join(agentRoot, "outside.js")), "no file was written outside");
      record.steps.push("unbundled npm dependencies, Python packages and an escaping path are refused before anything is created");
    });
  } finally {
    if (agent?.child && agent.child.exitCode === null) agent.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try { fs.rmSync(agentRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    console.log(`Cleanup: temp folder ${fs.existsSync(agentRoot) ? "still present" : "removed"}`);
  }
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed.`);
  if (failed.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 500));
