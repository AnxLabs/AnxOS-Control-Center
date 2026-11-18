#!/usr/bin/env node
"use strict";

// Build 214-F: REAL installation acceptance for a Modrinth modpack.
//
// Not a smoke test and not part of release validation: it needs internet
// access and Java, downloads the pack, its mods and the loader, and starts a
// real Minecraft server. It starts a disposable Agent on a free loopback port
// with its own temp folders, installs the pack through the real provider
// install path (marketplaceInstallService.installPack, the one the window
// uses), and checks that:
//   - the install resolves the pack, downloads its server files and starts it
//   - the server's Java process listens on the chosen TCP port
//   - AnxOS reports it Running / ready
//   - the pack's server mods are in the server's mods folder
//   - the world is kept across Stop and Start
//   - Stop ends the process and frees the port
// Everything is deleted with the Agent's temp folder. The Minecraft EULA is
// accepted for this disposable test server only.
//
// Run: node scripts/marketplace-modpack-real-install.js [modrinth-slug] [minecraft-version]
//      (default: cobblemon-fabric 1.21.1)

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-modpack-real-install-desktop-");

const nodeService = require("../src/services/nodeService");
const agentClient = require("../src/services/agentClient");
const marketplaceInstallService = require("../src/services/marketplaceInstallService");
const { generateAgentToken, writeAgentConfigToken } = require("../src/shared/agentTokenStore");

const SLUG = process.argv[2] || "cobblemon-fabric";
const MINECRAFT = process.argv[3] || "1.21.1";

function run(command, args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout || "").trim() });
    });
  });
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "0.0.0.0", () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}

async function waitFor(label, check, { timeoutMs = 60000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? ` (${lastError.message})` : ""}`);
}

// Which process listens on a TCP port (exact port filter, name read back).
async function tcpOwner(port) {
  if (process.platform === "win32") {
    const reply = await run("powershell.exe", ["-NoProfile", "-Command",
      `$c = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; "$($c.OwningProcess) $($p.ProcessName)" }`]);
    const [pid, name] = reply.stdout.split(/\s+/);
    return pid ? { pid: Number(pid), name: name || "" } : null;
  }
  const reply = await run("ss", ["-H", "-ltnp", `sport = :${Number(port)}`]);
  const match = reply.stdout.match(/users:\(\("([^"]+)",pid=(\d+)/);
  return match ? { pid: Number(match[2]), name: match[1] } : null;
}

// Minecraft server list ping (1.7+ protocol): the server answers with its
// status JSON, which proves it is serving players, not only listening.
function minecraftStatus(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const varint = (value) => { const bytes = []; do { let b = value & 0x7f; value >>>= 7; if (value) b |= 0x80; bytes.push(b); } while (value); return Buffer.from(bytes); };
    const packet = (id, body) => { const payload = Buffer.concat([varint(id), body]); return Buffer.concat([varint(payload.length), payload]); };
    const host = Buffer.from("127.0.0.1");
    const portBuffer = Buffer.alloc(2); portBuffer.writeUInt16BE(port);
    let data = Buffer.alloc(0);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("no status answer")); }, 10000);
    socket.on("connect", () => {
      socket.write(packet(0, Buffer.concat([varint(767), varint(host.length), host, portBuffer, varint(1)])));
      socket.write(packet(0, Buffer.alloc(0)));
    });
    socket.on("data", (chunk) => {
      data = Buffer.concat([data, chunk]);
      const start = data.indexOf("{");
      const end = data.lastIndexOf("}");
      if (start >= 0 && end > start) {
        try { const status = JSON.parse(data.slice(start, end + 1).toString("utf8")); clearTimeout(timer); socket.destroy(); resolve(status); } catch {}
      }
    });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function startAgent(agentRoot) {
  const configDir = path.join(agentRoot, "config");
  for (const dir of [configDir, path.join(agentRoot, "instances"), path.join(agentRoot, "logs")]) fs.mkdirSync(dir, { recursive: true });
  const bootstrapToken = generateAgentToken();
  writeAgentConfigToken(path.join(configDir, "agent.json"), bootstrapToken, { backendMode: "agent" });
  const port = await freeTcpPort();
  const url = `http://127.0.0.1:${port}`;
  // The packaged Agent runs from the app's install folder, which holds AnxOS's
  // bundled Java and is an allowed executable root. A checkout has no bundled
  // runtimes, so on Windows use the installed app's (read only) the same way.
  const bundled = process.platform === "win32" && process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "Programs", "AnxOS Control Center", "resources", "bundled-runtimes", "win-x64")
    : "";
  const runtimeEnv = bundled && fs.existsSync(path.join(bundled, "bundle-manifest.json"))
    ? { ANXOS_BUNDLED_RUNTIME_ROOT: bundled, AGENT_INSTANCE_EXECUTABLE_ROOTS: [path.dirname(process.execPath), bundled].join(path.delimiter) }
    : {};
  if (runtimeEnv.ANXOS_BUNDLED_RUNTIME_ROOT) console.log(`Using the installed app's bundled runtimes: ${bundled}`);
  const child = spawn(process.execPath, [path.join(repoRoot, "agent", "src", "server.js")], {
    cwd: path.join(repoRoot, "agent"),
    env: {
      ...process.env,
      ...runtimeEnv,
      ANXHUB_CONFIG_DIR: configDir,
      ANXHUB_AGENT_CONFIG_PATH: path.join(configDir, "agent.json"),
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: String(port),
      AGENT_IDENTITY_PATH: path.join(configDir, "identity.json"),
      AGENT_INSTANCE_ROOT: path.join(agentRoot, "instances"),
      ANXOS_LOG_DIR: path.join(agentRoot, "logs"),
    },
    stdio: "ignore",
  });
  await waitFor("the disposable Agent", async () => (await fetch(`${url}/api/v1/health`)).ok, { timeoutMs: 20000, intervalMs: 150 });
  const registered = await nodeService.saveNode({ displayName: "Modpack real-install Agent", agentUrl: url, agentToken: bootstrapToken });
  const pairing = await (await fetch(`${url}/api/v1/pairing/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  await nodeService.pairNodeFromCode({ pairingCode: pairing.pairingCode });
  return { child, nodeId: registered.node.id, instanceRoot: path.join(agentRoot, "instances") };
}

async function readyState(id, agentConfig, timeoutMs) {
  return waitFor("AnxOS reporting the server ready", async () => {
    const current = (await agentClient.getInstanceStatus(id, agentConfig)).instance || {};
    if (current.state === "Failed") throw Object.assign(new Error(`server failed: ${current.failureReason || "no reason"}`), { fatal: true });
    return current.state === "Running" && current.readinessState === "ready" ? current : null;
  }, { timeoutMs, intervalMs: 3000 });
}

async function main() {
  console.log(`Modpack real install on ${os.platform()} ${os.release()}: Modrinth ${SLUG} for Minecraft ${MINECRAFT}`);
  const project = await (await fetch(`https://api.modrinth.com/v2/project/${encodeURIComponent(SLUG)}`, { headers: { "user-agent": "AnxOS-real-install-test" } })).json();
  assert.ok(project?.id, `Modrinth project ${SLUG} exists`);
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-modpack-real-install-agent-"));
  const id = `anx214-modpack-${SLUG}`.slice(0, 48);
  const record = { steps: [] };
  let agent = null;
  let agentConfig = null;
  let port = null;
  try {
    agent = await startAgent(agentRoot);
    agentConfig = nodeService.getNodeAgentConfig(agent.nodeId);
    port = await freeTcpPort();
    const started = Date.now();
    const result = await marketplaceInstallService.installPack({
      provider: "modrinth",
      providerProjectId: project.id,
      nodeId: agent.nodeId,
      // The provider install names the server from instanceId (or the name).
      instanceId: id,
      id,
      name: `Anx214 ${project.title}`.slice(0, 60),
      minecraftVersion: MINECRAFT,
      loader: "fabric",
      requestId: `real-${id}-${Date.now()}`,
      options: { instanceId: id, id, name: `Anx214 ${project.title}`.slice(0, 60), port, memory: "4G", storageLocation: "data", acceptEula: true, start: true, autoInstallDependencies: false, playitTunnel: false },
    });
    record.installSeconds = Math.round((Date.now() - started) / 1000);
    const steps = (result?.progress || []).map((step) => `${step.label}:${step.status}`);
    assert.ok(!steps.some((step) => /:failed$/.test(step)), `no install step failed (${steps.join(", ")})`);
    record.steps.push(`installed in ${record.installSeconds} s`);

    const instancePath = path.join(agent.instanceRoot, id);
    const modsDir = [path.join(instancePath, "data", "mods"), path.join(instancePath, "mods")].find((dir) => fs.existsSync(dir));
    assert.ok(modsDir, "the server has a mods folder");
    const mods = fs.readdirSync(modsDir).filter((name) => name.endsWith(".jar"));
    assert.ok(mods.length >= 5, `the pack's server mods were installed (found ${mods.length})`);
    record.steps.push(`${mods.length} mod jars in ${path.relative(instancePath, modsDir)}`);

    const owner = await waitFor("the server listening on its port", async () => {
      const found = await tcpOwner(port);
      return found && /java/i.test(found.name) ? found : null;
    }, { timeoutMs: 900000, intervalMs: 5000 });
    record.steps.push(`${owner.name} listens on TCP ${port}`);
    await readyState(id, agentConfig, 120000);
    record.steps.push("AnxOS state: Running / ready");
    const status = await waitFor("a server-list answer", () => minecraftStatus(port), { timeoutMs: 120000, intervalMs: 5000 });
    assert.ok(String(status?.version?.name || "").includes(MINECRAFT), `the server reports Minecraft ${MINECRAFT} (got ${status?.version?.name})`);
    record.steps.push(`server list answers (${status.version.name}, ${status.players?.max ?? "?"} slots)`);

    const worldDir = [path.join(instancePath, "data", "world"), path.join(instancePath, "world")].find((dir) => fs.existsSync(dir));
    assert.ok(worldDir && fs.existsSync(path.join(worldDir, "level.dat")), "the server created its world");
    const marker = path.join(worldDir, "anx214-marker.txt");
    fs.writeFileSync(marker, "kept");

    await agentClient.stopInstance(id, agentConfig);
    await waitFor("the port being freed after Stop", async () => !(await tcpOwner(port)), { timeoutMs: 120000 });
    record.steps.push("Stop ended the process and freed the port");
    assert.ok(fs.existsSync(path.join(worldDir, "level.dat")), "the world is kept after Stop");

    await agentClient.startInstance(id, agentConfig);
    await waitFor("the server listening again", async () => /java/i.test((await tcpOwner(port))?.name || ""), { timeoutMs: 600000, intervalMs: 5000 });
    await readyState(id, agentConfig, 120000);
    assert.strictEqual(fs.readFileSync(marker, "utf8"), "kept", "the same world is used after Start");
    record.steps.push("Start reused the same world and was ready again");
    await agentClient.stopInstance(id, agentConfig);
    await waitFor("the port being freed", async () => !(await tcpOwner(port)), { timeoutMs: 120000 });
    record.ok = true;
  } catch (error) {
    record.ok = false;
    record.error = String(error?.message || error).slice(0, 900);
    if (agentConfig) {
      const failed = (await agentClient.getInstanceStatus(id, agentConfig).catch(() => null))?.instance || {};
      record.state = `${failed.state} / ${failed.readinessState ?? "none"} / ${failed.failureReason || "no failure reason"}`;
      const logs = await agentClient.getInstanceLogs(id, { limit: 30 }, agentConfig).catch(() => null);
      record.logs = (logs?.entries || []).map((entry) => entry.message).join("\n");
    }
  } finally {
    if (agent && agentConfig) {
      await agentClient.stopInstance(id, agentConfig).catch(() => {});
      if (port) await waitFor("the server stopping", async () => !(await tcpOwner(port)), { timeoutMs: 90000 }).catch(() => {});
      if (process.env.KEEP !== "1") await agentClient.deleteInstance(id, agentConfig).catch((error) => { record.cleanup = `delete failed: ${error.message}`; });
    }
    if (agent?.child && agent.child.exitCode === null) agent.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (process.env.KEEP !== "1") {
      try { fs.rmSync(agentRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
  }
  console.log(`${record.ok ? "PASS" : "FAIL"} modrinth ${SLUG} ${MINECRAFT} (port ${port}): ${record.ok ? record.steps.join("; ") : record.error}`);
  if (!record.ok) {
    console.log(`STEPS| ${record.steps.join("; ")}`);
    console.log(`STATE| ${record.state || "unknown"}`);
    for (const line of String(record.logs || "").split("\n").slice(-25)) console.log(`LOG| ${line.slice(0, 300)}`);
  }
  if (record.cleanup) console.log(`CLEANUP| ${record.cleanup}`);
  console.log(`Cleanup: temp folder ${fs.existsSync(agentRoot) ? "still present: " + agentRoot : "removed"}`);
  if (!record.ok) process.exitCode = 1;
}

main()
  .catch((error) => { console.error("modpack real install FAILED:", error?.stack || error); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 500));
