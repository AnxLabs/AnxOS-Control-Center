// Process supervision hardening (hermetic).
//
// One numbered check per verified finding:
//   1. Stop uses the server's console stop command before any signal, so the
//      world is saved (Windows SIGTERM is TerminateProcess).
//   2. Stop ends the whole process tree the instance spawned, not only the
//      launcher (cmd.exe /c run.bat, bash run.sh).
//   3. A persisted PID is trusted only when it is positively the process the
//      service spawned: a recycled PID is never reported Running or signalled.
//   4. Agent/desktop shutdown honours each server's own shutdownTimeoutMs
//      instead of killing it after 5 s.
//   5. "Start this server when the computer starts" (autoStart) is acted on
//      at boot.
//
// Real child processes are local node children of this script; Linux process
// semantics are faked (platform, spawn, process.kill, liveness). Nothing here
// contacts an Agent port, a service or a remote host.
const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");

process.env.AGENT_URL = process.env.AGENT_URL || "http://127.0.0.1:9";
process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);

const CORE_PATH = require.resolve("../src/shared/instances/instanceServiceCore");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-process-supervision-"));
const extraPids = new Set();
let checks = 0;

function loadFreshCore(root) {
  delete require.cache[CORE_PATH];
  const core = require(CORE_PATH);
  core.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });
  return core;
}

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs, label) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function configFile(root, id) {
  return path.join(root, id, "config.json");
}

function readConfig(root, id) {
  return JSON.parse(fs.readFileSync(configFile(root, id), "utf8"));
}

function patchConfig(root, id, patch) {
  const current = readConfig(root, id);
  fs.writeFileSync(configFile(root, id), `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}

// A fake game server: prints a readiness line, ignores SIGTERM where signals
// can be trapped, and saves only when it reads its console stop command.
function consoleServerScript(savedPath, saveDelayMs = 0) {
  return [
    "const fs = require('fs');",
    "process.on('SIGTERM', () => {});",
    "console.log('Done (0.1s)! For help, type \"help\"');",
    "let buffer = '';",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += String(chunk);",
    "  if (buffer.split(/\\r?\\n/).includes('stop')) {",
    `    setTimeout(() => { fs.writeFileSync(${JSON.stringify(savedPath)}, 'saved'); process.exit(0); }, ${saveDelayMs});`,
    "  }",
    "});",
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Fake Linux host: spawn, process.kill and liveness are replaced so process
// group semantics can be exercised on any platform.
// ---------------------------------------------------------------------------
async function withFakeLinux(run) {
  const root = fs.mkdtempSync(path.join(scratch, "linux-"));
  const core = loadFreshCore(root);
  const FAKE_PID = 4193001;
  const state = { wrapperAlive: false, grandchildAlive: false, kills: [], stdin: "", spawnOptions: null, child: null, onStdin: null };
  const originalSpawn = childProcess.spawn;
  const originalKill = process.kill;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

  function exitWrapper(code, signal) {
    if (!state.wrapperAlive) return;
    state.wrapperAlive = false;
    state.child.exitCode = code;
    state.child.signalCode = signal;
    setImmediate(() => {
      state.child.emit("exit", code, signal);
      state.child.emit("close", code, signal);
    });
  }

  childProcess.spawn = (command, args, options = {}) => {
    if (!Array.isArray(args) || !args.includes("fake-linux-server")) {
      return originalSpawn(command, args, options);
    }
    // A ChildProcess object that was never spawned: the service treats only
    // real child processes as roots for group signals and tree kills.
    const child = new childProcess.ChildProcess();
    child.pid = FAKE_PID;
    child.exitCode = null;
    child.signalCode = null;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.stdin.on("data", (chunk) => {
      state.stdin += String(chunk);
      state.onStdin?.(state.stdin);
    });
    child.kill = () => true;
    state.child = child;
    state.spawnOptions = options;
    state.wrapperAlive = true;
    state.grandchildAlive = true;
    return child;
  };
  process.kill = (pid, signal) => {
    const numeric = Number(pid);
    if (Math.abs(numeric) !== FAKE_PID) return originalKill.call(process, pid, signal);
    if (signal === 0) {
      const isAlive = numeric > 0 ? state.wrapperAlive : (state.wrapperAlive || state.grandchildAlive);
      if (!isAlive) {
        const error = new Error("ESRCH");
        error.code = "ESRCH";
        throw error;
      }
      return true;
    }
    state.kills.push([numeric, signal]);
    if (numeric < 0) {
      // The whole group gets the signal: the non-interactive bash launcher
      // dies at once; the java grandchild needs a moment to save.
      exitWrapper(null, signal);
      if (signal === "SIGKILL") state.grandchildAlive = false;
      else setTimeout(() => { state.grandchildAlive = false; }, 300);
    } else {
      // Only the launcher: its child is reparented and keeps running.
      exitWrapper(null, signal);
    }
    return true;
  };
  core._test.setProcessAliveProvider((pid) => {
    const numeric = Number(pid);
    if (numeric === FAKE_PID) return state.wrapperAlive;
    if (numeric === -FAKE_PID) return state.wrapperAlive || state.grandchildAlive;
    return alive(numeric);
  });
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "linux" });
  try {
    await run({ core, root, state, exitWrapper });
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    childProcess.spawn = originalSpawn;
    process.kill = originalKill;
    core._test.setProcessAliveProvider(null);
  }
}

// ---------------------------------------------------------------------------
// 1. Console stop before any signal.
// ---------------------------------------------------------------------------
async function checkConsoleStop(core, root) {
  const savedPath = path.join(scratch, "console-saved.txt");
  await core.createInstance({
    id: "console-stop",
    displayName: "Paper Console Stop",
    type: "custom-command",
    executable: process.execPath,
    args: ["-e", consoleServerScript(savedPath)],
    startupTimeoutMs: 10000,
    shutdownTimeoutMs: 8000,
  });
  const started = await core.startInstance("console-stop");
  assert(started.pid && alive(started.pid), "1: the console-stop server must be running");
  await waitFor(async () => (await core.getStatus("console-stop")).processState === "Running", 5000, "console-stop readiness");
  const stopped = await core.stopInstance("console-stop");
  assert.strictEqual(stopped.processState, "Stopped", "1: Stop must end in Stopped");
  assert.strictEqual(fs.existsSync(savedPath), true, "1: Stop must send the console stop command so the server saves before it exits");
  const persisted = readConfig(root, "console-stop");
  assert.strictEqual(persisted.exitCode, 0, "1: the server must exit on its own (exit code 0), not be terminated");
  assert.strictEqual(persisted.signal || null, null, "1: no forced signal may end a server that obeyed its stop command");
  assert.strictEqual(alive(started.pid), false, "1: the server process must be gone after Stop");
}

async function checkConsoleStopFakeLinux() {
  await withFakeLinux(async ({ core, state, exitWrapper }) => {
    await core.createInstance({
      id: "linux-console-stop",
      displayName: "Paper Linux Console",
      type: "custom-command",
      executable: process.execPath,
      args: ["fake-linux-server"],
      shutdownTimeoutMs: 5000,
    });
    state.onStdin = (text) => {
      if (/(^|\n)stop\n/.test(text)) {
        state.grandchildAlive = false;
        exitWrapper(0, null);
      }
    };
    await core.startInstance("linux-console-stop");
    const stopped = await core.stopInstance("linux-console-stop");
    assert.strictEqual(stopped.processState, "Stopped", "1 (linux): Stop must end in Stopped");
    assert.match(state.stdin, /(^|\n)stop\n/, "1 (linux): Stop must write the console stop command first");
    assert.deepStrictEqual(state.kills, [], "1 (linux): a server that obeys its stop command must not be signalled");
  });
}

// ---------------------------------------------------------------------------
// 2. Stop ends the whole process tree.
// ---------------------------------------------------------------------------
async function checkTreeStop(core) {
  const pidFile = path.join(scratch, "grandchild.pid");
  const grandchildScript = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  let executable;
  let args;
  if (process.platform === "win32") {
    const batPath = path.join(scratch, "run.bat");
    fs.writeFileSync(batPath, `@echo off\r\n"${process.execPath}" -e "${grandchildScript.replace(/"/g, '\\"')}"\r\n`);
    executable = "cmd.exe";
    args = ["/c", batPath];
  } else {
    const shPath = path.join(scratch, "run.sh");
    fs.writeFileSync(shPath, `#!/bin/bash\n"${process.execPath}" -e ${JSON.stringify(grandchildScript)}\necho done\n`);
    executable = "bash";
    args = [shPath];
  }
  await core.createInstance({
    id: "tree-stop",
    displayName: "Tree Stop",
    type: "custom-command",
    executable,
    args,
    startupTimeoutMs: 10000,
    shutdownTimeoutMs: 3000,
  });
  const started = await core.startInstance("tree-stop");
  assert(started.pid, "2: the launcher must start");
  await waitFor(() => fs.existsSync(pidFile) && Number(fs.readFileSync(pidFile, "utf8")) > 0, 10000, "the launcher's grandchild");
  const grandchildPid = Number(fs.readFileSync(pidFile, "utf8"));
  extraPids.add(grandchildPid);
  assert(alive(grandchildPid), "2: the grandchild game process must be running before Stop");
  const stopped = await core.stopInstance("tree-stop");
  assert.strictEqual(stopped.processState, "Stopped", "2: Stop must end in Stopped");
  await waitFor(() => !alive(grandchildPid), 3000, "the grandchild to exit").catch(() => {});
  assert.strictEqual(alive(grandchildPid), false, "2: Stop must end the launcher's child process too, not leave it serving while the record says Stopped");
}

async function checkTreeStopFakeLinux() {
  await withFakeLinux(async ({ core, state }) => {
    await core.createInstance({
      id: "linux-tree-stop",
      displayName: "Linux Tree Stop",
      type: "custom-command",
      executable: process.execPath,
      args: ["fake-linux-server"],
      shutdownTimeoutMs: 3000,
    });
    await core.startInstance("linux-tree-stop");
    assert.strictEqual(state.spawnOptions?.detached, true, "2 (linux): the instance must run in its own process group");
    const stopped = await core.stopInstance("linux-tree-stop");
    assert.strictEqual(stopped.processState, "Stopped", "2 (linux): Stop must end in Stopped");
    assert(state.kills.some(([pid, signal]) => pid === -4193001 && signal === "SIGTERM"), "2 (linux): Stop must signal the instance's process group");
    assert.strictEqual(state.grandchildAlive, false, "2 (linux): Stop must wait until every process in the group has exited");
  });
}

// ---------------------------------------------------------------------------
// 3. A recycled PID is never trusted or signalled.
// ---------------------------------------------------------------------------
function spawnVictim() {
  const victim = childProcess.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  extraPids.add(victim.pid);
  return victim;
}

async function checkRecycledPid(core, root) {
  // 3a: a legacy record (no spawn identity) whose PID now belongs to an
  // unrelated process with a different executable.
  await core.createInstance({
    id: "recycled-legacy",
    displayName: "Recycled Legacy",
    type: "custom-command",
    executable: "anxos-no-such-server",
    args: ["--nogui"],
  });
  const victimA = spawnVictim();
  await waitFor(() => alive(victimA.pid), 3000, "victim A");
  patchConfig(root, "recycled-legacy", { state: "Running", pid: victimA.pid, runtimeProcess: null });
  const legacyStatus = await core.getStatus("recycled-legacy");
  assert.notStrictEqual(legacyStatus.processState, "Running", "3a: a recycled PID must not be reported as the running server");
  await core.stopInstance("recycled-legacy").catch(() => {});
  await core.forceKillInstance("recycled-legacy").catch(() => {});
  assert.strictEqual(alive(victimA.pid), true, "3a: Stop/Force Kill must never signal an unrelated process");
  patchConfig(root, "recycled-legacy", { state: "Running", pid: victimA.pid, runtimeProcess: null });
  // The start may succeed and then fail to spawn the missing binary; the only
  // wrong outcome is a refusal because of the unrelated process.
  const startError = await core.startInstance("recycled-legacy").then(() => null, (error) => error);
  assert.notStrictEqual(startError?.code, "INSTANCE_ALREADY_RUNNING", "3a: Start must not be refused because of an unrelated process");
  await core.stopInstance("recycled-legacy").catch(() => {});
  assert.strictEqual(alive(victimA.pid), true, "3a: the unrelated process must survive the whole sequence");

  // 3b: a record with a spawn identity whose PID was reused after a reboot by
  // another process of the same executable.
  await core.createInstance({
    id: "recycled-identity",
    displayName: "Recycled Identity",
    type: "custom-command",
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  });
  const victimB = spawnVictim();
  await waitFor(() => alive(victimB.pid), 3000, "victim B");
  const anHourAgo = Date.now() - 60 * 60 * 1000;
  patchConfig(root, "recycled-identity", {
    state: "Running",
    pid: victimB.pid,
    runtimeProcess: null,
    processIdentity: {
      pid: victimB.pid,
      imageName: "node",
      startedAtMs: anHourAgo,
      bootTimeMs: anHourAgo - 60 * 60 * 1000,
      bootId: null,
      startTicks: process.platform === "linux" ? "1" : null,
    },
  });
  const identityStatus = await core.getStatus("recycled-identity");
  assert.notStrictEqual(identityStatus.processState, "Running", "3b: a PID whose process started after the recorded spawn must not be trusted");
  await core.forceKillInstance("recycled-identity").catch(() => {});
  assert.strictEqual(alive(victimB.pid), true, "3b: Force Kill must never signal a recycled PID");

  // 3c (control): a server that survived an Agent restart is still recognised
  // and still stoppable by a fresh service instance.
  await core.createInstance({
    id: "survivor",
    displayName: "Survivor",
    type: "custom-command",
    executable: process.execPath,
    args: ["-e", "console.log('Server started'); setInterval(() => {}, 1000)"],
    startupTimeoutMs: 10000,
  });
  const survivor = await core.startInstance("survivor");
  extraPids.add(survivor.pid);
  const restartedAgent = loadFreshCore(root);
  const survivorStatus = await restartedAgent.getStatus("survivor");
  assert.strictEqual(survivorStatus.processState, "Running", "3c: a genuine surviving server must still be recognised after an Agent restart");
  assert.strictEqual(survivorStatus.pid, survivor.pid, "3c: the surviving server keeps its PID");
  await restartedAgent.stopInstance("survivor", { timeoutMs: 3000 });
  await waitFor(() => !alive(survivor.pid), 3000, "the survivor to stop").catch(() => {});
  assert.strictEqual(alive(survivor.pid), false, "3c: a verified surviving server can still be stopped");
  await restartedAgent.shutdownInstanceService({ timeoutMs: 1000 }).catch(() => {});
}

// ---------------------------------------------------------------------------
// 4. Service shutdown honours the per-instance shutdown timeout.
// ---------------------------------------------------------------------------
async function checkShutdownTimeout(core, root) {
  const savedPath = path.join(scratch, "shutdown-saved.txt");
  await core.createInstance({
    id: "slow-save",
    displayName: "Paper Slow Save",
    type: "custom-command",
    executable: process.execPath,
    args: ["-e", consoleServerScript(savedPath, 6500)],
    startupTimeoutMs: 10000,
    shutdownTimeoutMs: 20000,
  });
  const started = await core.startInstance("slow-save");
  await waitFor(async () => (await core.getStatus("slow-save")).processState === "Running", 5000, "slow-save readiness");
  // Exactly as agent/src/server.js and main.js call it.
  const result = await core.shutdownInstanceService();
  assert.strictEqual(result.stopped, 1, "4: shutdown must stop the running server");
  assert.strictEqual(fs.existsSync(savedPath), true, "4: a server that needs 6.5 s to save must not be killed after 5 s on shutdown");
  const persisted = readConfig(root, "slow-save");
  assert.strictEqual(persisted.exitCode, 0, "4: the server must exit on its own during shutdown");
  assert.strictEqual(alive(started.pid), false, "4: the server must be gone after shutdown");

  const repo = path.resolve(__dirname, "..");
  const agentServer = fs.readFileSync(path.join(repo, "agent", "src", "server.js"), "utf8");
  const desktopMain = fs.readFileSync(path.join(repo, "main.js"), "utf8");
  for (const [name, source] of [["agent/src/server.js", agentServer], ["main.js", desktopMain]]) {
    assert(!/shutdownInstanceService\(\{\s*timeoutMs:\s*5000/.test(source), `4: ${name} must not cap every server's shutdown at 5 s`);
  }
  const ceiling = core.SERVICE_SHUTDOWN_CEILING_MS;
  assert(Number.isInteger(ceiling) && ceiling >= 60000, "4: the service shutdown ceiling must be generous");
  assert(/SERVICE_SHUTDOWN_CEILING_MS/.test(agentServer), "4: the Agent's force-exit timer must cover the shutdown ceiling");
}

// ---------------------------------------------------------------------------
// 5. autoStart is acted on at boot.
// ---------------------------------------------------------------------------
async function checkAutoStart(core, root) {
  const longLived = ["-e", "console.log('Server started'); setInterval(() => {}, 1000)"];
  const base = { type: "custom-command", executable: process.execPath, args: longLived, startupTimeoutMs: 10000 };
  await core.createInstance({ ...base, id: "auto-on", displayName: "Auto On", autoStart: true });
  await core.createInstance({ ...base, id: "auto-off", displayName: "Auto Off", autoStart: false });
  await core.createInstance({ ...base, id: "auto-operator-stopped", displayName: "Auto Operator Stopped", autoStart: true });
  await core.createInstance({ ...base, id: "auto-service-stopped", displayName: "Auto Service Stopped", autoStart: true });
  const beforeBoot = new Date(Date.now() - os.uptime() * 1000 - 60 * 60 * 1000).toISOString();
  patchConfig(root, "auto-on", { state: "Stopped", pid: null, lastStoppedAt: beforeBoot });
  patchConfig(root, "auto-off", { state: "Stopped", pid: null, lastStoppedAt: beforeBoot });
  patchConfig(root, "auto-operator-stopped", { state: "Stopped", pid: null, lastStoppedAt: new Date().toISOString(), stopOrigin: "operator" });
  patchConfig(root, "auto-service-stopped", { state: "Stopped", pid: null, lastStoppedAt: new Date().toISOString(), stopOrigin: "service-shutdown" });

  assert.strictEqual(typeof core.startAutoStartInstances, "function", "5: the service must expose a boot-time autoStart pass");
  const result = await core.startAutoStartInstances({ staggerMs: 0 });
  const started = [...result.started].sort();
  assert.deepStrictEqual(started, ["auto-on", "auto-service-stopped"], "5: only autoStart servers that were not stopped by the operator in this boot are started");
  for (const id of ["auto-on", "auto-service-stopped"]) {
    const status = await core.getStatus(id);
    assert(["Starting", "Running"].includes(status.processState), `5: ${id} must be running after the boot pass`);
    extraPids.add(status.pid);
  }
  assert.strictEqual((await core.getStatus("auto-off")).processState, "Stopped", "5: autoStart=false must stay stopped");
  assert.strictEqual((await core.getStatus("auto-operator-stopped")).processState, "Stopped", "5: a server the operator stopped in this boot must stay stopped");

  // A second pass (Agent restarted again) must not fail on running servers.
  const again = await core.startAutoStartInstances({ staggerMs: 0 });
  assert.deepStrictEqual(again.started, [], "5: running servers are not started twice");
  assert.deepStrictEqual(again.failures, [], "5: running servers are skipped, not reported as failures");

  // A stop during shutdown is recorded as such, so the next boot restores it.
  await core.shutdownInstanceService({ timeoutMs: 3000 });
  assert.strictEqual(readConfig(root, "auto-on").stopOrigin, "service-shutdown", "5: a shutdown stop must be recorded as a service stop");
  await core.stopInstance("auto-off");
  assert.strictEqual(readConfig(root, "auto-off").stopOrigin, "operator", "5: an operator stop must be recorded as such");

  const repo = path.resolve(__dirname, "..");
  assert(/startAutoStartInstances\(/.test(fs.readFileSync(path.join(repo, "agent", "src", "server.js"), "utf8")), "5: the Agent must run the autoStart pass at boot");
  assert(/startAutoStartInstances\(/.test(fs.readFileSync(path.join(repo, "main.js"), "utf8")), "5: the desktop local host must run the autoStart pass at launch");
}

async function main() {
  const failures = [];
  const root = fs.mkdtempSync(path.join(scratch, "real-"));
  let core = null;
  // The fake-Linux halves load their own service copy, so they run before the
  // shared real-process copy is loaded.
  const realCore = () => {
    core = core || loadFreshCore(root);
    return core;
  };
  const steps = [
    ["1 process-supervision-1 console stop before any signal", async () => {
      await checkConsoleStopFakeLinux();
      await checkConsoleStop(realCore(), root);
    }],
    ["2 process-supervision-2 stop ends the whole process tree", async () => {
      await checkTreeStopFakeLinux();
      await checkTreeStop(realCore());
    }],
    ["3 process-supervision-3 recycled PID is never trusted or signalled", () => checkRecycledPid(realCore(), root)],
    ["4 process-supervision-4 shutdown honours per-server timeout", () => checkShutdownTimeout(realCore(), root)],
    ["5 process-supervision-5 autoStart acted on at boot", () => checkAutoStart(realCore(), root)],
  ];
  for (const [label, run] of steps) {
    try {
      await run();
      checks += 1;
      console.log(`ok ${label}`);
    } catch (error) {
      failures.push(label);
      console.error(`FAIL ${label}: ${error?.stack || error}`);
    }
  }
  await realCore().shutdownInstanceService({ timeoutMs: 2000 }).catch(() => {});
  if (failures.length) {
    throw new Error(`${failures.length} check(s) failed: ${failures.join(", ")}`);
  }
  console.log(`Process supervision hardening smoke passed (${checks} checks)`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
}).finally(async () => {
  for (const pid of extraPids) {
    if (!alive(pid)) continue;
    try { process.kill(pid, "SIGKILL"); } catch {}
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
      break;
    } catch {
      await sleep(250);
    }
  }
});
