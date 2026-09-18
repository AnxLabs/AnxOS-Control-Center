const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs/promises");
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

async function request(url, token, pathname, options = {}) {
  const response = await fetch(`${url}${pathname}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function waitForAgent(url, token) {
  // Shared readiness helper: see scripts/test-helpers/agent-readiness.js for why
  // the budget is generous here and why the failure message must name a cause.
  const { waitForAgentReady } = require("./test-helpers/agent-readiness");
  return waitForAgentReady({
    label: "Installation execution test Agent",
    probe: async () => (await request(url, token, "/api/v1/health")).status === 200,
  });
}

async function createInstallingInstance(url, token, id, operationId) {
  const created = await request(url, token, "/api/v1/instances", {
    method: "POST",
    body: {
      id,
      displayName: id,
      type: "java-app",
      executable: "java",
      args: ["-jar", "server.jar", "nogui"],
      jar: "server.jar",
      workingDirectory: "data",
      installationState: "installing",
      installationOperationId: operationId,
    },
  });
  assert.strictEqual(created.status, 201, JSON.stringify(created.body));
}

async function begin(url, token, id, operationId) {
  return request(url, token, `/api/v1/instances/${id}/installation/session`, {
    method: "POST",
    body: { operationId, installerFamily: "forge" },
  });
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "anx-agent-installer-"));
  const instanceRoot = path.join(tempRoot, "instances");
  const binRoot = path.join(tempRoot, "bin");
  const configRoot = path.join(tempRoot, "config");
  const port = await freePort();
  const token = `installer-${crypto.randomBytes(32).toString("base64url")}`;
  const url = `http://127.0.0.1:${port}`;
  await fs.mkdir(binRoot, { recursive: true });
  await fs.mkdir(configRoot, { recursive: true });
  await fs.writeFile(path.join(configRoot, "agent.json"), `${JSON.stringify({
    backendMode: "agent",
    agentUrl: url,
    agentToken: token,
  }, null, 2)}\n`);
  const javaStub = `#!/usr/bin/env node
const fs = require("fs");
if (process.argv.includes("-jar")) {
  fs.writeFileSync("installer-cwd.txt", process.cwd() + "\\n");
  fs.writeFileSync("installer-args.txt", process.argv.slice(2).join("\\n") + "\\n");
}
if (fs.existsSync("fail-mode")) { console.error("structured-failure"); process.exit(23); }
if (fs.existsSync("timeout-mode")) { setTimeout(() => {}, 30000); }
else { console.log("installer-complete"); }
`;
  const javaPath = path.join(binRoot, "java");
  const stubPath = path.join(binRoot, "java-stub.js");
  await fs.writeFile(stubPath, javaStub, { mode: 0o644 });
  if (process.platform === "win32") {
    // Windows command resolution does not execute extensionless PATH files;
    // provide a native .cmd shim that invokes the deterministic Node stub.
    await fs.writeFile(path.join(binRoot, "java.cmd"), `@echo off\r\n"${process.execPath}" "${stubPath}" %*\r\n`, { mode: 0o755 });
  } else {
    await fs.writeFile(javaPath, javaStub, { mode: 0o755 });
  }
  const agent = spawn(process.execPath, [path.join(rootDir, "agent", "src", "server.js")], {
    cwd: path.join(rootDir, "agent"),
    env: {
      ...process.env,
      PATH: `${binRoot}${path.delimiter}${process.env.PATH || ""}`,
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: String(port),
      AGENT_TOKEN: token,
      AGENT_INSTANCE_ROOT: instanceRoot,
      ANXHUB_CONFIG_DIR: configRoot,
      ANXHUB_AGENT_CONFIG_PATH: path.join(configRoot, "agent.json"),
      ANXOS_LOG_DIR: path.join(tempRoot, "logs"),
      NODE_ENV: "test",
      ANXOS_TEST_INSTALLER_STUB_PATH: stubPath,
    },
    stdio: "ignore",
  });

  try {
    await waitForAgent(url, token);
    const operationId = "provider-install-secure-success-001";
    await createInstallingInstance(url, token, "forge-hidden", operationId);
    const hidden = await request(url, token, "/api/v1/instances");
    assert(!hidden.body.instances.some((item) => item.id === "forge-hidden"), "Installing instance must remain hidden.");

    const normalStart = await request(url, token, "/api/v1/instances/forge-hidden/start", { method: "POST" });
    assert.strictEqual(normalStart.status, 409);
    assert.strictEqual(normalStart.body.error.code, "INSTANCE_INSTALLATION_INCOMPLETE");

    const unauthenticated = await fetch(`${url}/api/v1/instances/forge-hidden/installation/session`, { method: "POST" });
    assert.strictEqual(unauthenticated.status, 401, "Installer route must require Agent authentication.");
    const stale = await begin(url, token, "forge-hidden", "provider-install-wrong-operation-001");
    assert.strictEqual(stale.status, 403);
    assert.strictEqual(stale.body.error.code, "INSTALLATION_OPERATION_MISMATCH");

    const session = await begin(url, token, "forge-hidden", operationId);
    assert.strictEqual(session.status, 201);
    const wrongToken = await request(url, token, "/api/v1/instances/forge-hidden/installation/execute", {
      method: "POST",
      body: { operationId, token: "wrong", phase: "install-server" },
    });
    assert.strictEqual(wrongToken.status, 403);
    const untrusted = await request(url, token, "/api/v1/instances/forge-hidden/installation/execute", {
      method: "POST",
      body: { operationId, token: session.body.token, phase: "shell", command: "touch compromised" },
    });
    assert.strictEqual(untrusted.status, 400);
    assert.strictEqual(untrusted.body.error.code, "INSTALLER_PHASE_NOT_ALLOWED");

    const executed = await request(url, token, "/api/v1/instances/forge-hidden/installation/execute", {
      method: "POST",
      body: { operationId, token: session.body.token, phase: "install-server", command: "touch compromised" },
    });
    assert.strictEqual(executed.status, 200, JSON.stringify(executed.body));
    assert.strictEqual(executed.body.exitCode, 0);
    assert.match(executed.body.stdout, /installer-complete/);
    const dataRoot = path.join(instanceRoot, "forge-hidden", "data");
    assert.strictEqual((await fs.readFile(path.join(dataRoot, "installer-cwd.txt"), "utf8")).trim(), dataRoot);
    assert.deepStrictEqual((await fs.readFile(path.join(dataRoot, "installer-args.txt"), "utf8")).trim().split(/\r?\n/), ["-jar", "forge-installer.jar", "--installServer"]);
    await assert.rejects(fs.access(path.join(dataRoot, "compromised")), /ENOENT/);

    await request(url, token, "/api/v1/instances/forge-hidden/installation/session", {
      method: "DELETE",
      body: { operationId, token: session.body.token },
    });
    const activated = await request(url, token, "/api/v1/instances/forge-hidden", { method: "PATCH", body: { installationState: "active" } });
    assert.strictEqual(activated.status, 200);
    assert((await request(url, token, "/api/v1/instances")).body.instances.some((item) => item.id === "forge-hidden"));
    await fs.writeFile(path.join(dataRoot, "server.jar"), "test-runtime");
    const normalStartAfterActivation = await request(url, token, "/api/v1/instances/forge-hidden/start", { method: "POST" });
    assert.strictEqual(normalStartAfterActivation.status, 200, JSON.stringify(normalStartAfterActivation.body));

    const failureOperation = "provider-install-structured-failure-001";
    await createInstallingInstance(url, token, "forge-failure", failureOperation);
    await fs.writeFile(path.join(instanceRoot, "forge-failure", "data", "fail-mode"), "1");
    const failureSession = await begin(url, token, "forge-failure", failureOperation);
    const failed = await request(url, token, "/api/v1/instances/forge-failure/installation/execute", {
      method: "POST",
      body: { operationId: failureOperation, token: failureSession.body.token, phase: "install-server" },
    });
    assert.strictEqual(failed.status, 422);
    assert.strictEqual(failed.body.error.code, "INSTALLER_EXIT_NONZERO");
    assert.strictEqual(failed.body.error.details.exitCode, 23);
    assert.match(failed.body.error.details.stderr, /structured-failure/);
    assert.strictEqual((await request(url, token, "/api/v1/instances/forge-failure", { method: "DELETE" })).status, 200);
    await assert.rejects(fs.access(path.join(instanceRoot, "forge-failure")), /ENOENT/);

    const timeoutOperation = "provider-install-timeout-rollback-001";
    await createInstallingInstance(url, token, "forge-timeout", timeoutOperation);
    await fs.writeFile(path.join(instanceRoot, "forge-timeout", "data", "timeout-mode"), "1");
    const timeoutSession = await begin(url, token, "forge-timeout", timeoutOperation);
    const timedOut = await request(url, token, "/api/v1/instances/forge-timeout/installation/execute", {
      method: "POST",
      body: { operationId: timeoutOperation, token: timeoutSession.body.token, phase: "install-server", timeoutMs: 1000 },
    });
    assert.strictEqual(timedOut.status, 504);
    assert.strictEqual(timedOut.body.error.code, "INSTALLER_TIMEOUT");
    assert.strictEqual(timedOut.body.error.details.timeoutMs, 1000);
    await request(url, token, "/api/v1/instances/forge-timeout", { method: "DELETE" });
    await assert.rejects(fs.access(path.join(instanceRoot, "forge-timeout")), /ENOENT/);

    const concurrentOperation = "provider-install-concurrent-cancel-001";
    await createInstallingInstance(url, token, "forge-concurrent", concurrentOperation);
    await fs.writeFile(path.join(instanceRoot, "forge-concurrent", "data", "timeout-mode"), "1");
    const concurrentSession = await begin(url, token, "forge-concurrent", concurrentOperation);
    const execution = request(url, token, "/api/v1/instances/forge-concurrent/installation/execute", {
      method: "POST",
      body: { operationId: concurrentOperation, token: concurrentSession.body.token, phase: "install-server", timeoutMs: 10000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const duplicate = await request(url, token, "/api/v1/instances/forge-concurrent/installation/execute", {
      method: "POST",
      body: { operationId: concurrentOperation, token: concurrentSession.body.token, phase: "install-server" },
    });
    assert.strictEqual(duplicate.status, 409);
    assert.strictEqual(duplicate.body.error.code, "INSTALLER_ALREADY_RUNNING");
    const cancelled = await request(url, token, "/api/v1/instances/forge-concurrent/installation/cancel", {
      method: "POST",
      body: { operationId: concurrentOperation, token: concurrentSession.body.token },
    });
    assert.strictEqual(cancelled.status, 200);
    const cancellationResult = await execution;
    assert.strictEqual(cancellationResult.status, 409);
    assert.strictEqual(cancellationResult.body.error.code, "INSTALLER_CANCELLED");
    await request(url, token, "/api/v1/instances/forge-concurrent", { method: "DELETE" });

    const completedSession = await begin(url, token, "forge-hidden", operationId);
    assert.strictEqual(completedSession.status, 409);
    assert.strictEqual(completedSession.body.error.code, "INSTALLATION_STATE_INVALID");

    const preload = await fs.readFile(path.join(rootDir, "preload.js"), "utf8");
    assert(!preload.includes("installation/execute"), "Renderer preload must not expose the privileged installer route.");
    console.log("Agent installation execution smoke checks passed.");
  } finally {
    agent.kill("SIGTERM");
    await new Promise((resolve) => agent.once("exit", resolve));
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
