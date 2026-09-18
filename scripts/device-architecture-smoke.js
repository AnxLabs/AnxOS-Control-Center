const assert = require("assert");
const fs = require("fs/promises");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");

// H4: timeouts used to be hardcoded (15s startup, 12s stop) and were tight on
// loaded CI runners. They are now configurable with raised defaults, and temp
// cleanup uses a bounded retry loop with backoff instead of a single
// fs.rm call. Everything stays hermetic (isolated temp root, loopback ports).
function envMs(name, fallback) {
  const parsed = Number.parseInt(process.env[name], 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const AGENT_START_BUDGET_MS = envMs("ANX_DEVICE_SMOKE_START_TIMEOUT_MS", 45000);
const AGENT_STOP_TIMEOUT_MS = envMs("ANX_DEVICE_SMOKE_STOP_TIMEOUT_MS", 30000);
const CLEANUP_ATTEMPTS = envMs("ANX_DEVICE_SMOKE_CLEANUP_ATTEMPTS", 12);
const CLEANUP_BASE_DELAY_MS = envMs("ANX_DEVICE_SMOKE_CLEANUP_DELAY_MS", 250);

// Bounded-but-reliable temp cleanup. Windows can hold directory handles briefly
// after a child exits (EPERM/EBUSY), so retry with linear backoff up to a hard
// attempt cap. A final failure is reported as a warning rather than swallowed,
// and deliberately does not mask the smoke result (temp cleanup is best-effort).
async function removeTree(dir) {
  if (!dir) return;
  let lastError;
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      return;
    } catch (error) {
      lastError = error;
      if (attempt === CLEANUP_ATTEMPTS - 1) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(CLEANUP_BASE_DELAY_MS * (attempt + 1), 2000)));
    }
  }
  console.error(`WARNING: device-architecture smoke could not remove temp dir ${dir}: ${lastError?.message || lastError}`);
}

function activeWindowsTelemetryHandles() {
  if (process.platform !== "win32" || typeof process._getActiveHandles !== "function") return [];
  return process._getActiveHandles().filter((handle) => {
    const spawnfile = String(handle?.spawnfile || "").toLowerCase();
    return spawnfile.endsWith("anxos-hardware-telemetry.exe");
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function startAgent(base, name) {
  const root = path.join(base, name);
  await fs.mkdir(root, { recursive: true });
  const port = await freePort();
  const token = `${name}-token`;
  const stderr = [];
  const child = spawn(process.execPath, [path.join(rootDir, "agent", "src", "server.js")], {
    cwd: root,
    env: { ...process.env, AGENT_HOST: "127.0.0.1", AGENT_PORT: String(port), AGENT_TOKEN: token, AGENT_FILE_ROOTS: root, AGENT_INSTANCE_ROOT: path.join(root, "instances"), AGENT_IDENTITY_PATH: path.join(root, "identity.json") },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + AGENT_START_BUDGET_MS;
  for (;;) {
    try { if ((await fetch(`${url}/api/v1/health`)).ok) return { child, root, url, token }; } catch {}
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const detail = stderr.join("").trim();
  throw new Error(`${name} Agent did not start within ${Math.round(AGENT_START_BUDGET_MS / 1000)} seconds.${detail ? `\n${detail}` : ""}`);
}

async function stopAgent(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  await new Promise((resolve) => {
    const done = () => resolve();
    child.once("close", done);
    child.kill("SIGTERM");
    setTimeout(done, AGENT_STOP_TIMEOUT_MS).unref?.();
  });
  child.stderr?.destroy();
}

async function main() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "anx-device-architecture-"));
  process.env.ANXHUB_CONFIG_DIR = path.join(temp, "config");
  await fs.mkdir(process.env.ANXHUB_CONFIG_DIR, { recursive: true });
  const first = await startAgent(temp, "debian-owner");
  const second = await startAgent(temp, "windows-future");
  try {
    await fs.writeFile(path.join(process.env.ANXHUB_CONFIG_DIR, "agent.json"), `${JSON.stringify({ backendMode: "agent", agentUrl: first.url, agentToken: first.token })}\n`);
    const nodes = require("../src/services/nodeService");

    const legacy = nodes.migrateState({ selectedNodeId: "default", nodes: [
      { id: "owner-a", displayName: "Owner Machine", agentUrl: first.url, agentToken: first.token },
      { id: "owner-b", displayName: "Duplicate URL", agentUrl: `${first.url}/`, agentToken: "" },
    ] });
    assert.strictEqual(legacy.nodes.length, 1, "Legacy duplicate URLs should merge into one stable Agent node.");
    assert.strictEqual(legacy.nodes[0].displayName, "Duplicate URL", "A non-generic duplicate display name should replace the legacy Owner Machine label.");
    assert.strictEqual(legacy.nodes[0].agentToken, first.token);

    await fs.writeFile(nodes.getNodesPath(), `${JSON.stringify({ schemaVersion: 1, selectedNodeId: "default", nodes: legacy.nodes }, null, 2)}\n`);
    let state = await nodes.listNodes();
    assert.strictEqual(state.nodes[0].id, "application-host", "Application host must always be a distinct first node.");
    assert.strictEqual(state.nodes[0].kind, "application-host");
    assert.strictEqual(state.nodes[1].kind, "agent");
    assert.notStrictEqual(state.nodes[0].id, state.nodes[1].id);
    assert(state.nodes[1].agentIdentity.deviceId, "Agent node must use reported device identity.");

    await nodes.saveNode({ displayName: "Owner Alias", agentUrl: first.url, agentToken: first.token });
    state = await nodes.listNodes();
    assert.strictEqual(state.nodes.filter((node) => node.kind === "agent").length, 1, "Registering the same Agent identity must not duplicate it.");
    const future = await nodes.saveNode({ displayName: "Future Windows", agentUrl: second.url, agentToken: second.token });
    state = await nodes.listNodes();
    assert.strictEqual(state.nodes.filter((node) => node.kind === "agent").length, 2, "Distinct authenticated Agent identities must not collapse because both use loopback transport.");
    assert.strictEqual(state.nodes.find((node) => node.id === future.node.id)?.localAgent, false, "A newly registered loopback Agent must not be classified as local from its URL alone.");

    const owner = state.nodes.find((node) => node.kind === "agent" && node.agentUrl === first.url);
    await nodes.selectNode(owner.id);
    assert.strictEqual(nodes.getSelectedNodeId(), owner.id, "Selected node must persist.");
    assert.strictEqual(nodes.getExecutionTarget(owner.id).type, "agent");
    assert.strictEqual(nodes.getExecutionTarget("application-host").type, "application-host");

    const systemService = require("../src/services/systemService");
    assert.strictEqual((await systemService.getSystemSnapshot({ nodeId: "application-host" })).source, "local", "Dashboard must route application host locally.");
    assert.strictEqual(activeWindowsTelemetryHandles().length, 0, "Windows telemetry helper must not retain a referenced child-process handle after a local snapshot.");
    assert.strictEqual((await systemService.getSystemSnapshot({ nodeId: owner.id })).source, "agent", "Dashboard must route Agent nodes to that Agent.");

    const { FileService } = require("../src/services/fileService");
    const files = new FileService();
    const local = await files.list({ providerType: "renderer-local", storageId: "local", nodeId: "application-host", path: temp });
    assert(local.local && local.connected, "renderer-local must use the application host filesystem.");
    const remote = await files.list({ providerType: "agent-native", nodeId: owner.id, path: first.root });
    assert(remote.provider === "agent" && remote.connected, "agent-native must use Agent APIs.");
    await assert.rejects(files.list({ providerType: "unknown", nodeId: owner.id }), /provider type/i, "Unknown providers must not fall back.");

    const appSource = await fs.readFile(path.join(rootDir, "app.js"), "utf8");
    const indexSource = await fs.readFile(path.join(rootDir, "index.html"), "utf8");
    assert(appSource.includes('providerType: "agent-native"'), "Renderer must expose Agent filesystem explicitly.");
    assert(appSource.includes('providerType: "renderer-local"'), "Renderer must expose application-host filesystem explicitly.");
    assert(indexSource.includes("data-routing-diagnostics"), "Development diagnostics panel must exist.");
    assert(future.node.agentIdentity.deviceId !== owner.agentIdentity.deviceId);
    console.log("Device architecture smoke checks passed.");
  } finally {
    await stopAgent(first.child);
    await stopAgent(second.child);
    await removeTree(temp);
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
