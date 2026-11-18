#!/usr/bin/env node
"use strict";

// Build 214: REAL installation check for the Java application card. Needs
// Java on this computer and a runnable test jar (argument 1; build one from
// any class with a Main-Class manifest). Starts a disposable Agent with its own
// temp folders and installs through the real Marketplace path:
//   A1 no port: ready once it keeps running; program arguments reach the app;
//      the memory limit is applied; data in its folder survives Stop/Start
//      and Restart
//   A2 with a port: ready when the port opens
//   A3 an app that exits at once fails the install with its exit code
//   A4 a file that is not a runnable jar, and runtime options passed as
//      program arguments, are refused before anything is created
// The test jar expected: counts runs in anx-app-runs.txt, prints its args and
// max memory, listens on --port N, exits 3 on --crash.
// Run: node scripts/marketplace-java-app-real-install.js <test.jar> <not-a-jar.jar>

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-java-app-real-install-desktop-");

const nodeService = require("../src/services/nodeService");
const agentClient = require("../src/services/agentClient");
const marketplaceService = require("../src/services/marketplaceService");
const { generateAgentToken, writeAgentConfigToken } = require("../src/shared/agentTokenStore");

const OPTIONS = { version: "", providerVersionId: "", serverType: "", storageLocation: "data", playitTunnel: false, acceptEula: false, start: true };
const results = [];

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
  const registered = await nodeService.saveNode({ displayName: "Java app real-install Agent", agentUrl: url, agentToken: token });
  const pairing = await (await fetch(`${url}/api/v1/pairing/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  await nodeService.pairNodeFromCode({ pairingCode: pairing.pairingCode });
  return { child, nodeId: registered.node.id, instanceRoot: path.join(agentRoot, "instances") };
}

async function status(id, agentConfig) {
  const reply = await agentClient.getInstanceStatus(id, agentConfig);
  return reply.instance || reply;
}

async function logText(id, agentConfig) {
  const reply = await agentClient.getInstanceLogs(id, { lines: 200 }, agentConfig).catch(() => null);
  const entries = reply?.entries || reply?.logs || reply?.lines || [];
  return (Array.isArray(entries) ? entries.map((entry) => entry?.message ?? entry) : [String(entries)]).join("\n");
}

async function check(id, fn) {
  const record = { id, steps: [] };
  results.push(record);
  try {
    await fn(record);
    record.ok = true;
  } catch (error) {
    record.ok = false;
    record.error = String(error?.message || error).slice(0, 600);
  }
  console.log(`${record.ok ? "PASS" : "FAIL"} ${id}: ${record.ok ? record.steps.join("; ") : record.error}`);
}

async function main() {
  const [jarPath, notJarPath] = process.argv.slice(2).map((entry) => path.resolve(entry));
  assert.ok(jarPath && fs.existsSync(jarPath) && notJarPath && fs.existsSync(notJarPath), "usage: <test.jar> <not-a-jar.jar>");
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-java-app-real-install-agent-"));
  let agent = null;
  try {
    agent = await startAgent(agentRoot);
    const agentConfig = nodeService.getNodeAgentConfig(agent.nodeId);
    const install = (id, extra) => marketplaceService.installTemplate({ templateId: "java-app", nodeId: agent.nodeId, requestId: `java-${id}-${Date.now()}`, options: { ...OPTIONS, id, name: id, memory: "256M", ...extra } });

    await check("A1", async (record) => {
      const token = marketplaceService.rememberApplicationFile(jarPath).token;
      await install("anx214-javaapp", { applicationFileToken: token, programArguments: '--name "Hello World"', ports: [] });
      const ready = await waitFor("Running and ready", async () => { const current = await status("anx214-javaapp", agentConfig); return current.state === "Running" && current.readinessState === "ready" ? current : null; }).catch(async (error) => {
        const current = await status("anx214-javaapp", agentConfig).catch(() => ({}));
        throw new Error(`${error.message} | state ${current.state}/${current.readinessState}/${current.failureReason} | cmd ${current.executable} ${JSON.stringify(current.args)} | mode ${current.readinessMode} | log: ${(await logText("anx214-javaapp", agentConfig)).slice(-600)}`);
      });
      record.steps.push(`Running / ${ready.readinessState} with no port`);
      const log = await waitFor("its first line", async () => { const text = await logText("anx214-javaapp", agentConfig); return /AnxOS test app run 1/.test(text) ? text : null; });
      assert.match(log, /args \[--name,Hello World\]/, "program arguments reach the application, quotes kept");
      const maxMemory = Number(/maxMemory (\d+)MB/.exec(log)?.[1]);
      assert.ok(maxMemory > 0 && maxMemory <= 256, `the memory limit is applied (${maxMemory} MB)`);
      record.steps.push(`arguments reach it; max memory ${maxMemory} MB`);
      await agentClient.stopInstance("anx214-javaapp", agentConfig);
      await waitFor("Stopped", async () => (await status("anx214-javaapp", agentConfig)).state === "Stopped");
      await agentClient.startInstance("anx214-javaapp", agentConfig);
      await waitFor("run 2", async () => /AnxOS test app run 2/.test(await logText("anx214-javaapp", agentConfig)));
      await agentClient.restartInstance?.("anx214-javaapp", agentConfig).catch(async () => { await agentClient.stopInstance("anx214-javaapp", agentConfig); await agentClient.startInstance("anx214-javaapp", agentConfig); });
      await waitFor("run 3", async () => /AnxOS test app run 3/.test(await logText("anx214-javaapp", agentConfig)));
      const counter = fs.readFileSync(path.join(agent.instanceRoot, "anx214-javaapp", "data", "anx-app-runs.txt"), "utf8");
      assert.strictEqual(counter.trim(), "3", "its data file survives Stop/Start and Restart");
      record.steps.push("data kept across Stop/Start and Restart (3 runs)");
      await agentClient.stopInstance("anx214-javaapp", agentConfig);
    });

    await check("A2", async (record) => {
      const port = await freePort();
      const token = marketplaceService.rememberApplicationFile(jarPath).token;
      await install("anx214-javaapp-web", { applicationFileToken: token, programArguments: `--port ${port}`, port, ports: [port] });
      await waitFor("ready on its port", async () => (await status("anx214-javaapp-web", agentConfig)).readinessState === "ready");
      record.steps.push(`ready when port ${port} opened`);
      await agentClient.stopInstance("anx214-javaapp-web", agentConfig);
    });

    await check("A3", async (record) => {
      const token = marketplaceService.rememberApplicationFile(jarPath).token;
      await assert.rejects(install("anx214-javaapp-crash", { applicationFileToken: token, programArguments: "--crash", ports: [] }), (error) => {
        assert.match(error.message, /exit code 3|exited/i, `the failure says it exited (${error.message.slice(0, 200)})`);
        return true;
      });
      const log = await logText("anx214-javaapp-crash", agentConfig);
      assert.match(log, /crashing on purpose/, "the application's own error output is in its logs");
      record.steps.push("an app that exits fails the install with its exit code; its output is in the logs");
    });

    await check("A4", async (record) => {
      const before = fs.readdirSync(agent.instanceRoot).length;
      const badToken = marketplaceService.rememberApplicationFile(notJarPath).token;
      await assert.rejects(install("anx214-javaapp-bad", { applicationFileToken: badToken, ports: [] }), /not a Java application/);
      const token = marketplaceService.rememberApplicationFile(jarPath).token;
      await assert.rejects(install("anx214-javaapp-jvm", { applicationFileToken: token, programArguments: "-Xmx64G", ports: [] }), /option for the Java runtime/);
      await assert.rejects(install("anx214-javaapp-none", { applicationFileToken: "", ports: [] }), /Choose the application's \.jar file/);
      assert.strictEqual(fs.readdirSync(agent.instanceRoot).length, before, "nothing was created");
      record.steps.push("not-a-jar, runtime options and a missing file are refused before anything is created");
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
