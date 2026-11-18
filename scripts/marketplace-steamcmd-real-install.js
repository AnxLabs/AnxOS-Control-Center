#!/usr/bin/env node
"use strict";

// Build 214-F: REAL installation acceptance for SteamCMD game servers on this
// computer's operating system.
//
// Not a smoke test and not part of release validation: it needs SteamCMD and
// internet access, downloads several gigabytes per game, and starts the real
// game server. It starts a disposable Agent on a free loopback port with its
// own temp folders, installs each game through the real Marketplace install
// path on ports chosen at run time, and checks that:
//   - the install verifies its files and starts the server
//   - the server process binds the chosen UDP port (so the port setting works)
//   - the settings file AnxOS wrote is the one the server uses
//   - Stop ends the process and frees the port
// The server and its files are then deleted with the Agent's temp folder.
// Windows may ask to allow the game server through the firewall; the answer
// does not affect this run. Nothing outside the temp folders is changed.
//
// Run: node scripts/marketplace-steamcmd-real-install.js <template-id> [...]

const assert = require("assert");
const dgram = require("dgram");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-steamcmd-real-install-desktop-");

const nodeService = require("../src/services/nodeService");
const agentClient = require("../src/services/agentClient");
const marketplaceService = require("../src/services/marketplaceService");
const { generateAgentToken, writeAgentConfigToken } = require("../src/shared/agentTokenStore");

const OPTIONS = { version: "", providerVersionId: "", serverType: "", storageLocation: "data", memory: "", playitTunnel: false, acceptEula: false, start: true };
const results = [];

function run(command, args, { timeout = 30000 } = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() });
    });
  });
}

function freeTcpPort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}

// A UDP port that is free now, and whose next port is free too (games that
// take a game port and a query port get a pair).
async function freeUdpPair(range = [30000, 49999]) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = range[0] + Math.floor(Math.random() * (range[1] - range[0]));
    const free = async (candidate) => new Promise((resolve) => {
      const socket = dgram.createSocket("udp4");
      socket.once("error", () => resolve(false));
      socket.bind(candidate, "0.0.0.0", () => socket.close(() => resolve(true)));
    });
    if (await free(port) && await free(port + 1)) return [port, port + 1];
  }
  throw new Error("no free UDP port pair found");
}

// Which process owns a UDP port. Exact port filter, and the process name is
// read back so the check cannot be satisfied by some other program.
async function udpOwner(port) {
  if (process.platform === "win32") {
    const reply = await run("powershell.exe", ["-NoProfile", "-Command",
      `$e = Get-NetUDPEndpoint -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object -First 1; if ($e) { $p = Get-Process -Id $e.OwningProcess -ErrorAction SilentlyContinue; "$($e.OwningProcess) $($p.ProcessName)" }`]);
    const [pid, name] = reply.stdout.split(/\s+/);
    return pid ? { pid: Number(pid), name: name || "" } : null;
  }
  const reply = await run("ss", ["-H", "-lunp", `sport = :${Number(port)}`]);
  const match = reply.stdout.match(/users:\(\("([^"]+)",pid=(\d+)/);
  return match ? { pid: Number(match[2]), name: match[1] } : null;
}

// Steam server query (A2S_INFO) on 127.0.0.1: the name a server advertises.
// A server may first answer with a challenge (0x41) that the query repeats.
function a2sInfoName(port, { timeoutMs = 5000 } = {}) {
  const request = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]), Buffer.from("Source Engine Query\0", "latin1")]);
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); reject(new Error(`no A2S_INFO answer on UDP ${port}`)); }, timeoutMs);
    socket.on("message", (message) => {
      if (message.readInt32LE(0) !== -1) return;
      if (message[4] === 0x41) {
        socket.send(Buffer.concat([request, message.subarray(5, 9)]), port, "127.0.0.1");
        return;
      }
      if (message[4] !== 0x49) return;
      clearTimeout(timer);
      socket.close();
      const end = message.indexOf(0, 6);
      resolve(message.subarray(6, end).toString("utf8"));
    });
    socket.send(request, port, "127.0.0.1");
  });
}

async function waitFor(label, check, { timeoutMs = 180000, intervalMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label} did not happen in ${Math.round(timeoutMs / 1000)} s${last ? `: ${last.message}` : ""}`);
}

// Per game: the process that must own the port, and the settings file check.
const GAMES = {
  "v-rising": {
    processName: /VRisingServer/i,
    async settings({ instancePath, name }) {
      const settingsDir = path.join(instancePath, "data", "server", "save-data");
      assert.ok(fs.existsSync(settingsDir), "saves and settings are written under save-data in the server folder");
      const log = fs.readFileSync(path.join(instancePath, "data", "server", "logs", "VRisingServer.log"), "utf8");
      assert.ok(log.includes(name), "the server log shows the chosen server name");
    },
  },
  enshrouded: {
    processName: /enshrouded_server/i,
    async settings({ instancePath, name, ports }) {
      const config = JSON.parse(fs.readFileSync(path.join(instancePath, "data", "server", "enshrouded_server.json"), "utf8"));
      assert.strictEqual(config.name, name, "the server kept the name AnxOS wrote");
      assert.strictEqual(config.queryPort, ports[0], "the server kept the port AnxOS wrote");
    },
  },
  // Existing templates, run to check the Windows start and UDP readiness fixes.
  valheim: {
    processName: /valheim_server/i,
    async settings({ instancePath }) {
      assert.ok(fs.existsSync(path.join(instancePath, "data", "server", "saves")), "the world is saved under saves in the server folder");
    },
  },
  palworld: {
    // PalServer.exe starts PalServer-Win64-Shipping-Cmd.exe, which binds the port.
    processName: /PalServer/i,
    async settings({ instancePath }) {
      assert.ok(fs.existsSync(path.join(instancePath, "data", "server", "Pal", "Saved")), "Palworld writes its saves under Pal/Saved");
    },
  },
  "garrys-mod": {
    processName: /srcds/i,
    async settings({ instancePath }) {
      assert.ok(fs.existsSync(path.join(instancePath, "data", "server", "garrysmod", "cfg")), "the game folder is in the server folder");
    },
  },
  "project-zomboid": {
    processName: /java/i,
    async settings({ instancePath, id, result }) {
      const password = result.credentials?.[0]?.secret || "";
      assert.match(password, /^[A-Za-z0-9]{24}$/, "a generated administrator password is returned once");
      const serverDir = path.join(instancePath, "data", "server");
      const consoleLog = fs.readFileSync(path.join(serverDir, "Zomboid", "server-console.txt"), "utf8");
      assert.match(consoleLog, /Administrator account 'admin' created/, "the administrator account was created with it");
      assert.ok(fs.existsSync(path.join(serverDir, "Zomboid", "Server", `${id}.ini`)), "the server settings are in the server folder");
      // Nowhere in plain text: not the server folder, its logs, the Agent's
      // settings for it, or the Agent's secret store.
      const agentRoot = path.dirname(path.dirname(instancePath));
      const hits = [];
      const walk = (folder) => {
        for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
          const full = path.join(folder, entry.name);
          if (entry.isDirectory()) { if (!/^(java|jre64|media|natives|steamapps)$/.test(entry.name)) walk(full); }
          else if (entry.isFile() && fs.statSync(full).size < 64 * 1024 * 1024 && fs.readFileSync(full).includes(password)) hits.push(path.relative(agentRoot, full));
        }
      };
      walk(agentRoot);
      assert.deepStrictEqual(hits, [], `the password is in no plain-text file (${JSON.stringify(hits)})`);
      assert.ok(fs.existsSync(path.join(agentRoot, "anxos-server-secrets", "secrets.json")), "it is held, encrypted, in the Agent's secret store");
      assert.ok(!JSON.stringify(result.progress).includes(password), "the password is not in the install steps");
    },
  },
  factorio: {
    processName: /factorio/i,
    async settings({ instancePath, name, ports }) {
      const factorioDir = path.join(instancePath, "data", "server", "factorio");
      assert.ok(fs.existsSync(path.join(factorioDir, "saves", "anxos.zip")), "a world was created on the first start");
      const log = fs.readFileSync(path.join(factorioDir, "factorio-current.log"), "utf8");
      assert.ok(log.includes(`Hosting game at IP ADDR:({0.0.0.0:${ports[0]}})`) || log.includes(`:${ports[0]}`), "the server hosts on the chosen port");
      assert.strictEqual(JSON.parse(fs.readFileSync(path.join(factorioDir, "anxos-server-settings.json"), "utf8")).name, name, "the server uses the settings AnxOS wrote");
    },
  },
  "ark-survival-evolved": {
    processName: /ShooterGameServer/i,
    // ARK also uses the game port + 1, so the query port is further away.
    portsFor: (pair) => [pair[0], pair[0] + 10],
    // ARK writes ShooterGame.log and its session settings only when it exits
    // cleanly, so ask the running server for the name it advertises instead.
    async settings({ instancePath, id, ports }) {
      const saved = path.join(instancePath, "data", "server", "ShooterGame", "Saved");
      assert.ok(fs.existsSync(path.join(saved, "Config", "WindowsServer")), "the server keeps its settings in the server folder");
      // It answers queries about a minute after its ports open.
      const advertised = await waitFor("an A2S_INFO answer", () => a2sInfoName(ports[1]), { timeoutMs: 300000, intervalMs: 5000 });
      assert.ok(advertised.startsWith(id), `the query port advertises the session AnxOS gave it (got "${advertised}")`);
    },
    readyTimeoutMs: 1200000,
  },
  "ark-survival-ascended": {
    processName: /ArkAscendedServer/i,
    async settings({ instancePath, id }) {
      const saved = path.join(instancePath, "data", "server", "ShooterGame", "Saved");
      assert.ok(fs.existsSync(path.join(saved, "Config", "WindowsServer")), "the server keeps its settings in the server folder");
      // ASA writes its log while it runs; the session it hosts is named there.
      const logs = path.join(saved, "Logs");
      await waitFor("the session name in the server log", () => fs.existsSync(logs) && fs.readdirSync(logs)
        .filter((file) => /\.log$/i.test(file))
        .some((file) => fs.readFileSync(path.join(logs, file), "utf8").includes(id)), { timeoutMs: 300000, intervalMs: 5000 });
    },
    readyTimeoutMs: 1500000,
  },
  "core-keeper": {
    processName: /CoreKeeperServer/i,
    async settings({ instancePath, name, ports }) {
      const serverDir = path.join(instancePath, "data", "server");
      const gameInfo = await waitFor("GameInfo.txt", () => fs.existsSync(path.join(serverDir, "GameInfo.txt")) && fs.readFileSync(path.join(serverDir, "GameInfo.txt"), "utf8"), { timeoutMs: 120000, intervalMs: 2000 });
      assert.match(gameInfo, new RegExp(`^Port: ${ports[0]}$`, "m"), "the server reports the chosen port for direct connections");
      const config = JSON.parse(fs.readFileSync(path.join(serverDir, "saves", "ServerConfig.json"), "utf8"));
      assert.strictEqual(config.worldName, name, "the saves folder in the server folder holds the name AnxOS gave it");
      assert.strictEqual(config.maxNumberPlayers, 8);
    },
  },
  "space-engineers": {
    processName: /SpaceEngineersDedicated/i,
    async settings({ instancePath, id, name, ports }) {
      const world = path.join(instancePath, "data", "server", "world");
      const config = fs.readFileSync(path.join(world, "SpaceEngineers-Dedicated.cfg"), "utf8");
      assert.ok(config.includes(`<ServerPort>${ports[0]}</ServerPort>`) && config.includes(`<ServerName>${name}</ServerName>`), "the settings file AnxOS wrote names the port and server");
      const log = fs.readdirSync(world).filter((file) => /^SpaceEngineersDedicated_.*\.log$/.test(file)).map((file) => fs.readFileSync(path.join(world, file), "utf8")).join("\n");
      assert.ok(log.includes(`0.0.0.0:${ports[0]}`), "the server's own log binds the chosen port");
      // The world is saved under its id shortly after "Game ready".
      await waitFor("the world save", () => fs.existsSync(path.join(world, "Saves", id, "Sandbox.sbc")), { timeoutMs: 180000, intervalMs: 5000 });
    },
    readyTimeoutMs: 600000,
  },
  "seven-days-to-die": {
    processName: /7DaysToDieServer/i,
    async settings({ instancePath, ports }) {
      const serverDir = path.join(instancePath, "data", "server");
      const log = fs.readFileSync(path.join(serverDir, "logs", "output_log.txt"), "utf8");
      assert.ok(/GamePref\.ServerPort = (\d+)/.exec(log)?.[1] === String(ports[0]), "the server uses the port AnxOS wrote");
      assert.ok(/GamePref\.TelnetEnabled = False/.test(log), "the remote console is off");
      assert.ok(fs.existsSync(path.join(serverDir, "UserData", "Saves")), "saves are kept in the server folder");
    },
  },
  satisfactory: {
    // FactoryServer.exe starts FactoryServer-Win64-Shipping-Cmd.exe, which binds the ports.
    processName: /FactoryServer/i,
    async settings({ instancePath, ports }) {
      const log = fs.readFileSync(path.join(instancePath, "data", "server", "FactoryGame", "Saved", "Logs", "FactoryGame.log"), "utf8");
      assert.ok(log.includes(`-Port=${ports[0]} -ReliablePort=${ports[1]}`), "the server started with the ports AnxOS chose");
    },
  },
  "dont-starve-together": {
    processName: /dontstarve_dedicated_server/i,
    // LAN servers must use 10998-11018; DST replaces any other port.
    portRange: [10998, 11017],
    async settings({ instancePath, ports }) {
      const log = fs.readFileSync(path.join(instancePath, "data", "server", "saves", "Cluster", "Master", "server_log.txt"), "utf8");
      assert.ok(log.includes(`Lan Server Started on port: ${ports[0]}`), "the server started on the port AnxOS wrote");
      assert.ok(!/Invalid port selection/.test(log), "the server accepted the port");
    },
  },
  unturned: {
    processName: /Unturned/i,
    async settings({ instancePath, id }) {
      const serverDir = path.join(instancePath, "data", "server", "Servers", id);
      assert.ok(fs.existsSync(path.join(serverDir, "Server", "Commands.dat")), "Commands.dat is where the server reads it");
      assert.ok(fs.readdirSync(serverDir).length > 1, "the server created its own files next to the settings AnxOS wrote");
    },
  },
};

async function startAgent(agentRoot) {
  const configDir = path.join(agentRoot, "config");
  for (const dir of [configDir, path.join(agentRoot, "instances"), path.join(agentRoot, "logs")]) fs.mkdirSync(dir, { recursive: true });
  const bootstrapToken = generateAgentToken();
  writeAgentConfigToken(path.join(configDir, "agent.json"), bootstrapToken, { backendMode: "agent" });
  const port = await freeTcpPort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(repoRoot, "agent", "src", "server.js")], {
    cwd: path.join(repoRoot, "agent"),
    env: {
      ...process.env,
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
  const registered = await nodeService.saveNode({ displayName: "SteamCMD real-install Agent", agentUrl: url, agentToken: bootstrapToken });
  const pairing = await (await fetch(`${url}/api/v1/pairing/start`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json();
  await nodeService.pairNodeFromCode({ pairingCode: pairing.pairingCode });
  return { child, nodeId: registered.node.id, url, instanceRoot: path.join(agentRoot, "instances") };
}

async function runGame(templateId, agent, agentConfig) {
  const spec = GAMES[templateId];
  const name = `Anx214 ${templateId}`;
  const id = `anx214-${templateId}`;
  const pair = await freeUdpPair(spec.portRange);
  const ports = spec.portsFor ? spec.portsFor(pair) : pair;
  const record = { templateId, ports, steps: [] };
  results.push(record);
  const started = Date.now();
  let created = false;
  try {
    const result = await marketplaceService.installTemplate({
      templateId,
      nodeId: agent.nodeId,
      requestId: `real-${id}-${Date.now()}`,
      options: { ...OPTIONS, id, name, port: ports[0], ports, queryPort: ports[1], autoInstallDependencies: false },
    });
    created = true;
    record.installSeconds = Math.round((Date.now() - started) / 1000);
    const steps = (result.progress || []).map((step) => `${step.label}:${step.status}`);
    assert.ok(!steps.some((step) => /:failed$/.test(step)), `no install step failed (${steps.join(", ")})`);
    record.steps.push("installed and verified");

    const owner = await waitFor("the server binding its port", async () => {
      const found = await udpOwner(ports[0]);
      return found && spec.processName.test(found.name) ? found : null;
    }, { timeoutMs: spec.readyTimeoutMs || 420000 });
    record.steps.push(`${owner.name} bound UDP ${ports[0]}`);

    const status = await agentClient.getInstanceStatus(id, agentConfig);
    const instance = status.instance || status;
    record.state = `${instance.state} / readiness ${instance.readinessState ?? "none"}`;
    // Readiness comes from the UDP port check, which runs every second.
    const ready = await waitFor("AnxOS reporting the server ready", async () => {
      const current = (await agentClient.getInstanceStatus(id, agentConfig)).instance || {};
      return current.state === "Running" && current.readinessState === "ready" ? current : null;
    }, { timeoutMs: 30000, intervalMs: 1000 }).catch(() => null);
    record.state = ready ? "Running / readiness ready" : record.state;
    assert.ok(ready, `AnxOS reports the server running and ready (${record.state})`);
    record.steps.push(`AnxOS state: ${record.state}`);
    const instancePath = path.join(agent.instanceRoot, id);
    await spec.settings({ instancePath, name, id, ports, result });
    record.steps.push("uses the settings AnxOS wrote");

    await agentClient.stopInstance(id, agentConfig);
    await waitFor("the port being freed after Stop", async () => !(await udpOwner(ports[0])), { timeoutMs: 90000 });
    record.steps.push("Stop ended the process and freed the port");
    record.ok = true;
  } catch (error) {
    record.ok = false;
    record.error = String(error?.message || error).slice(0, 700);
    if (error?.details?.missingArtifacts) record.error += ` | missing: ${error.details.missingArtifacts.join(", ")}`;
    const failedStatus = await agentClient.getInstanceStatus(id, agentConfig).catch(() => null);
    const failed = failedStatus?.instance || failedStatus || {};
    record.state = `${failed.state} / readiness ${failed.readinessState ?? "none"} / ${failed.failureReason || "no failure reason"}`;
    // Which ports the game's processes really hold, to tell "wrong port" from "not started".
    record.listening = process.platform !== "win32" ? "" : (await run("powershell.exe", ["-NoProfile", "-Command",
      `Get-Process | Where-Object { $_.ProcessName -match '${spec.processName.source}' } | ForEach-Object { $id = $_.Id; $u = (Get-NetUDPEndpoint -OwningProcess $id -ErrorAction SilentlyContinue | ForEach-Object LocalPort) -join ','; $t = (Get-NetTCPConnection -OwningProcess $id -State Listen -ErrorAction SilentlyContinue | ForEach-Object LocalPort) -join ','; "$($_.ProcessName) pid=$id udp=[$u] tcp=[$t]" }`])).stdout;
    const logs = await agentClient.getInstanceLogs(id, { lines: 25 }, agentConfig).catch(() => null);
    const text = logs?.logs ?? logs?.lines ?? logs?.content ?? "";
    record.logs = (Array.isArray(text) ? text.map((line) => line?.message ?? line).join("\n") : String(text)).split(/\r?\n/).slice(-20).join("\n");
  } finally {
    if (process.env.KEEP === "1") {
      await agentClient.stopInstance(id, agentConfig).catch(() => {});
      record.cleanup = `KEEP=1: files left in ${path.join(agent.instanceRoot, id)}`;
    } else if (created || fs.existsSync(path.join(agent.instanceRoot, id))) {
      await agentClient.stopInstance(id, agentConfig).catch(() => {});
      await waitFor("the server stopping", async () => !(await udpOwner(ports[0])), { timeoutMs: 60000 }).catch(() => {});
      await agentClient.deleteInstance(id, agentConfig).catch((error) => { record.cleanup = `delete failed: ${error.message}`; });
    }
  }
  console.log(`${record.ok ? "PASS" : "FAIL"} ${templateId} (${record.installSeconds ?? "?"} s install, ports ${ports.join("/")}): ${record.ok ? record.steps.join("; ") : record.error}`);
  if (!record.ok) {
    console.log(`STATE| ${record.state}`);
    console.log(`PORTS| ${String(record.listening || "no matching process").replace(/\r?\n/g, " ; ")}`);
    for (const line of String(record.logs || "").split("\n")) console.log(`LOG| ${line.slice(0, 300)}`);
  }
  if (record.cleanup) console.log(`CLEANUP| ${record.cleanup}`);
}

async function main() {
  const wanted = process.argv.slice(2);
  if (wanted.length === 0) throw new Error(`Name at least one game: ${Object.keys(GAMES).join(", ")}`);
  for (const id of wanted) assert.ok(GAMES[id], `unknown game ${id}`);
  console.log(`SteamCMD real install on ${os.platform()} ${os.release()}`);
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-steamcmd-real-install-agent-"));
  let agent = null;
  try {
    agent = await startAgent(agentRoot);
    const agentConfig = nodeService.getNodeAgentConfig(agent.nodeId);
    for (const id of wanted) await runGame(id, agent, agentConfig);
  } finally {
    if (agent?.child && agent.child.exitCode === null) agent.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    if (process.env.KEEP !== "1") {
      try { fs.rmSync(agentRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    }
    console.log(`Cleanup: temp folder ${fs.existsSync(agentRoot) ? "still present: " + agentRoot : "removed"}`);
  }
  const failed = results.filter((entry) => !entry.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} passed.`);
  if (failed.length) process.exitCode = 1;
}

main()
  .catch((error) => { console.error("real install run FAILED:", error?.stack || error); process.exitCode = 1; })
  .finally(() => setTimeout(() => process.exit(process.exitCode || 0), 500));
