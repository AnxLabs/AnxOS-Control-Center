const assert = require("assert");
const fs = require("fs/promises");
const crypto = require("crypto");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForAgent(url, token) {
  // Shared readiness helper: see scripts/test-helpers/agent-readiness.js for why
  // the budget is generous here and why the failure message must name a cause.
  const { waitForAgentReady } = require("./test-helpers/agent-readiness");
  return waitForAgentReady({
    label: "Temporary Agent",
    probe: async () => (await fetch(`${url}/api/v1/health`, { headers: { Authorization: `Bearer ${token}` } })).ok,
  });
}

async function requestJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

async function writeConfig(instanceRoot, id, patch = {}) {
  const directory = path.join(instanceRoot, id);
  await fs.mkdir(path.join(directory, "data"), { recursive: true });
  await fs.writeFile(path.join(directory, "config.json"), `${JSON.stringify({
    id,
    displayName: id,
    type: "custom-command",
    executable: "node",
    args: ["server.js"],
    state: "Stopped",
    ...patch,
  }, null, 2)}\n`);
  return directory;
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "anx-agent-instance-record-"));
  const instanceRoot = path.join(tempRoot, "instances");
  const configPath = path.join(tempRoot, "config", "agent.json");
  const port = await freePort();
  const token = `smoke-${crypto.randomBytes(32).toString("base64url")}`;
  const url = `http://127.0.0.1:${port}`;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify({ backendMode: "agent", agentUrl: url, agentToken: token }, null, 2)}\n`);
  const child = spawn(process.execPath, [path.join(rootDir, "agent", "src", "server.js")], {
    cwd: path.join(rootDir, "agent"),
    env: {
      ...process.env,
      ANXHUB_AGENT_CONFIG_PATH: configPath,
      ANXHUB_CONFIG_DIR: path.join(tempRoot, "config"),
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: String(port),
      AGENT_TOKEN: token,
      AGENT_INSTANCE_ROOT: instanceRoot,
      AGENT_IDENTITY_PATH: path.join(tempRoot, "identity.json"),
      ANXOS_LOG_DIR: path.join(tempRoot, "logs"),
    },
    stdio: "ignore",
  });

  try {
    await waitForAgent(url, token);

    const existingDir = await writeConfig(instanceRoot, "existing-record");
    await fs.writeFile(path.join(existingDir, "data", "keep.txt"), "keep\n");
    const existing = await requestJson(`${url}/api/v1/instances/existing-record/record`, token, { method: "DELETE" });
    assert.strictEqual(existing.status, 200, "existing record forget should return 200");
    assert.strictEqual(existing.body.success, true);
    assert.strictEqual(existing.body.instanceId, "existing-record");
    assert.strictEqual(existing.body.metadataRemoved, true);
    assert.strictEqual(existing.body.filesDeleted, false);
    await fs.access(path.join(existingDir, "data", "keep.txt"));
    await assert.rejects(fs.access(path.join(existingDir, "config.json")), /ENOENT/, "metadata config should be removed");

    await writeConfig(instanceRoot, "legacy-record", { restartPolicy: undefined, createdAt: undefined, updatedAt: undefined });
    const legacy = await requestJson(`${url}/api/v1/instances/legacy-record/record`, token, { method: "DELETE" });
    assert.strictEqual(legacy.status, 200, "legacy record forget should return 200");
    assert.strictEqual(legacy.body.metadataRemoved, true);

    await fs.mkdir(path.join(instanceRoot, "stale-missing-directory"), { recursive: true });
    await fs.rm(path.join(instanceRoot, "stale-missing-directory"), { recursive: true, force: true });
    const stale = await requestJson(`${url}/api/v1/instances/stale-missing-directory/record`, token, { method: "DELETE" });
    assert.strictEqual(stale.status, 200, "missing directory forget should be idempotent");
    assert.strictEqual(stale.body.metadataRemoved, false);
    assert.strictEqual(stale.body.alreadyMissing, true);

    const missing = await requestJson(`${url}/api/v1/instances/already-missing/record`, token, { method: "DELETE" });
    assert.strictEqual(missing.status, 200, "already missing record should not route-level 404");
    assert.strictEqual(missing.body.success, true);
    assert.strictEqual(missing.body.metadataRemoved, false);
    assert.strictEqual(missing.body.alreadyMissing, true);

    const invalid = await requestJson(`${url}/api/v1/instances/bad%20id/record`, token, { method: "DELETE" });
    assert.strictEqual(invalid.status, 400, "invalid instance ID should be rejected by Agent validation");
    assert.strictEqual(invalid.body.error.code, "INVALID_INSTANCE_ID");

    await writeConfig(instanceRoot, "reload-persistence");
    const persisted = await requestJson(`${url}/api/v1/instances/reload-persistence/record`, token, { method: "DELETE" });
    assert.strictEqual(persisted.status, 200);
    const list = await requestJson(`${url}/api/v1/instances`, token);
    assert.strictEqual(list.status, 200);
    assert(!list.body.instances.some((instance) => instance.id === "reload-persistence"), "forgotten record must not return after registry reload/list");

    console.log("Agent instance record smoke checks passed.");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
