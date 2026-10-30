#!/usr/bin/env node
"use strict";

// End to end against a real Agent process: POST /api/v1/agent/restart.
// On Linux the Agent is given the environment systemd gives a unit's main
// process; it must reply 202, report selfRestart in health, then exit with the
// self-restart failure code so Restart=on-failure brings it back. Elsewhere the
// route must refuse (409) and the Agent must keep running.
// Run: node scripts/agent-self-restart-e2e-smoke.js

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { AGENT_SELF_RESTART_EXIT_CODE } = require("../agent/src/routes/agentLifecycle");

const root = path.resolve(__dirname, "..");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "anx-agent-self-restart-"));
  const configDir = path.join(home, "config");
  fs.mkdirSync(configDir, { recursive: true });
  const token = "self-restart-test-token";
  const port = await freePort();
  const agentJson = path.join(configDir, "agent.json");
  fs.writeFileSync(agentJson, `${JSON.stringify({ backendMode: "agent", agentUrl: `http://127.0.0.1:${port}`, agentToken: token }, null, 2)}\n`, { mode: 0o600 });
  const child = spawn(process.execPath, ["--require", path.join(__dirname, "test-helpers", "fake-systemd-supervisor-preload.js"), path.join(root, "agent", "src", "server.js")], {
    cwd: path.join(root, "agent"),
    env: {
      ...process.env,
      INVOCATION_ID: "",
      SYSTEMD_EXEC_PID: "",
      AGENT_REPO_ROOT: root,
      ANXHUB_CONFIG_DIR: configDir,
      ANXHUB_AGENT_CONFIG_PATH: agentJson,
      AGENT_ENROLLMENT_PATH: path.join(configDir, "enrollment.json"),
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: String(port),
      AGENT_TOKEN: token,
      AGENT_IDENTITY_PATH: path.join(home, "identity.json"),
      AGENT_INSTANCE_ROOT: path.join(home, "instances"),
      AGENT_BACKUP_ROOT: path.join(home, "backups"),
      AGENT_FILE_ROOTS: home,
      ANXOS_LOG_DIR: path.join(home, "logs"),
      AGENT_API_PERMISSIONS: "*",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += String(chunk); });
  child.stderr.on("data", (chunk) => { output += String(chunk); });
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  const url = `http://127.0.0.1:${port}`;
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  try {
    let health = null;
    for (let attempt = 0; attempt < 300 && !health; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Agent exited early (${child.exitCode}): ${output.slice(-600)}`);
      try {
        const response = await fetch(`${url}/api/v1/health`);
        if (response.status === 200) health = await response.json();
      } catch {}
      if (!health) await delay(100);
    }
    assert.ok(health, `Agent did not become ready: ${output.slice(-600)}`);
    const linux = process.platform === "linux";
    assert.strictEqual(health.capabilities?.selfRestart?.supported, linux, "health reports selfRestart exactly when systemd supervises the Agent");

    const unauthorized = await fetch(`${url}/api/v1/agent/restart`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.strictEqual(unauthorized.status, 401, "the route requires the Agent credential");

    const response = await fetch(`${url}/api/v1/agent/restart`, { method: "POST", headers, body: "{}" });
    const body = await response.json();
    if (linux) {
      assert.strictEqual(response.status, 202, JSON.stringify(body));
      const code = await Promise.race([exited, delay(15000).then(() => "timeout")]);
      assert.strictEqual(code, AGENT_SELF_RESTART_EXIT_CODE, `the Agent exits with the self-restart code (got ${code})`);
      console.log(`PASS E1 a supervised Agent replies 202 and exits with code ${AGENT_SELF_RESTART_EXIT_CODE} for systemd to restart it`);
    } else {
      assert.strictEqual(response.status, 409, JSON.stringify(body));
      assert.strictEqual(body.error?.code, "AGENT_SELF_RESTART_UNSUPERVISED");
      await delay(1200);
      assert.strictEqual(child.exitCode, null, "an unsupervised Agent keeps running");
      console.log("PASS E1 off Linux the route refuses (409) and the Agent keeps running");
    }
  } finally {
    if (child.exitCode === null) child.kill();
    await Promise.race([exited, delay(5000)]);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  console.log("agent self-restart e2e smoke passed (1 check).");
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
