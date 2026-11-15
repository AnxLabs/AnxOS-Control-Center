// Resource-leak hardening (hermetic). One numbered check per finding:
//   1 resource-leaks-1  A SteamCMD run that times out kills its whole process
//                       tree and settles even when a grandchild keeps the
//                       stdio pipes open, so the session, the node's SteamCMD
//                       queue and a following build lookup are never stuck.
//   2 resource-leaks-2  An aborted Agent download closes its file stream, and
//                       desktop backup/file downloads use an idle timeout
//                       instead of a 30 s limit on the whole transfer.
//   3 resource-leaks-3  Backup scheduler ticks never overlap, and a tick never
//                       writes back a stale schedule list over a schedule the
//                       user disabled, changed or deleted during the backup.
// Every root is a fresh temp folder. SteamCMD is a fake child process (no
// real process is spawned or signalled), downloads use loopback ephemeral
// ports, and long timer constants are scaled down so the run stays short.
// Nothing touches a real Agent, a service or the developer's data.
const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const http = require("http");
const os = require("os");
const path = require("path");
const stream = require("stream");
const { EventEmitter } = require("events");

const rootDir = path.resolve(__dirname, "..");
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const smokeRoot = pinAgentRoots("anx-resource-leaks-");
process.env.ANXHUB_CONFIG_DIR = path.join(smokeRoot, "config");
process.env.ANXOS_CONFIG_DIR = path.join(smokeRoot, "config");
process.env.ANXOS_LOG_DIR = path.join(smokeRoot, "logs");
process.env.AGENT_LOG_DIR = path.join(smokeRoot, "logs");
process.env.AGENT_BACKUP_ROOT = path.join(smokeRoot, "backups");
process.env.AGENT_TEMP_DIR = path.join(smokeRoot, "agent-temp");
process.env.AGENT_IDENTITY_PATH = path.join(smokeRoot, "identity.json");
process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);
process.env.AGENT_URL = "http://127.0.0.1:9";
delete process.env.ANXOS_AGENT_RUNTIME_CONFIG;
const instanceRoot = process.env.AGENT_INSTANCE_ROOT;
fs.mkdirSync(instanceRoot, { recursive: true });
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.AGENT_BACKUP_ROOT, { recursive: true });

// Long fixed timeouts are scaled so a check can cross them in about a second:
// the desktop request limit (30 s), its download idle limit (60 s) and the
// SteamCMD build-lookup limit (2 min).
const SCALED_DELAYS = new Map([[30000, 300], [60000, 600], [120000, 1200]]);
const realSetTimeout = global.setTimeout;
global.setTimeout = function scaledSetTimeout(callback, delay, ...args) {
  return realSetTimeout(callback, SCALED_DELAYS.has(delay) ? SCALED_DELAYS.get(delay) : delay, ...args);
};

const childProcess = require("child_process");
const instanceService = require("../agent/src/services/instances/instanceService");
const core = require("../src/shared/instances/instanceServiceCore");
const backupService = require("../agent/src/services/backupService");
const agentClient = require("../src/services/agentClient");

const results = [];
async function check(number, name, fn) {
  try {
    await fn();
    results.push({ number, name, ok: true });
    console.log(`ok ${number} ${name}`);
  } catch (error) {
    results.push({ number, name, ok: false });
    console.error(`FAIL ${number} ${name}: ${error?.stack || error}`);
  }
}

function withDeadline(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = realSetTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms); }),
  ]);
}

const delay = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 1. SteamCMD: a wrapper whose real SteamCMD grandchild holds the pipes.
// ---------------------------------------------------------------------------
const APP_ID = 896660;
const STEAMCMD_SENTINEL = path.join(smokeRoot, "fake-bin", "steamcmd");
let nextFakePid = 70001;
const fakeTrees = new Map();
const spawnCalls = [];
const killCalls = [];

// Mirrors ChildProcess: 'exit' when the wrapper dies, 'close' only once both
// stdio streams have closed. The grandchild keeps the pipes open until its
// process tree is killed, exactly like steamcmd.sh running linux32/steamcmd.
function createFakeSteamTree() {
  const child = new EventEmitter();
  child.pid = nextFakePid++;
  child.stdout = new stream.PassThrough();
  child.stderr = new stream.PassThrough();
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  const tree = { child, grandchildAlive: true, closed: false };
  let closedStreams = 0;
  const maybeClose = () => {
    if (tree.closed || closedStreams < 2 || (child.exitCode === null && child.signalCode === null)) return;
    tree.closed = true;
    child.emit("close", child.exitCode, child.signalCode);
  };
  child.stdout.on("close", () => { closedStreams += 1; maybeClose(); });
  child.stderr.on("close", () => { closedStreams += 1; maybeClose(); });
  tree.wrapperDies = (signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.signalCode = signal;
    child.emit("exit", null, signal);
    maybeClose();
  };
  tree.killTree = () => {
    tree.wrapperDies("SIGKILL");
    if (tree.grandchildAlive) {
      tree.grandchildAlive = false;
      child.stdout.destroy();
      child.stderr.destroy();
    }
  };
  child.kill = (signal = "SIGTERM") => {
    killCalls.push({ kind: "child.kill", pid: child.pid, signal });
    child.killed = true;
    setImmediate(() => tree.wrapperDies(signal));
    return true;
  };
  child.stdout.write("Redirecting stderr to '/home/steam/Steam/logs/stderr.txt'\n");
  fakeTrees.set(child.pid, tree);
  return tree;
}

const realSpawn = childProcess.spawn;
childProcess.spawn = function fakeSpawn(command, args = [], options = {}) {
  if (command === STEAMCMD_SENTINEL) {
    const tree = createFakeSteamTree();
    spawnCalls.push({ command, args, options, pid: tree.child.pid });
    return tree.child;
  }
  return realSpawn.apply(this, arguments);
};

// taskkill never really runs: it only ends a fake tree it was given.
const realExecFile = childProcess.execFile;
childProcess.execFile = function fakeExecFile(command, args = [], options, callback) {
  if (!String(command).toLowerCase().startsWith("taskkill")) return realExecFile.apply(this, arguments);
  const done = typeof options === "function" ? options : callback;
  killCalls.push({ kind: "taskkill", args: [...args] });
  const pid = Number(args[args.indexOf("/PID") + 1]);
  const tree = fakeTrees.get(pid);
  setImmediate(() => {
    if (tree && args.includes("/T") && args.includes("/F")) tree.killTree();
    done?.(tree ? null : Object.assign(new Error("taskkill: process not found"), { code: 128 }), "", "");
  });
  return new EventEmitter();
};

let groupKillMode = "kills-tree";
const realProcessKill = process.kill;
process.kill = function fakeProcessKill(pid, signal) {
  const tree = fakeTrees.get(Math.abs(Number(pid)));
  if (!tree) return realProcessKill.apply(process, arguments);
  killCalls.push({ kind: "process.kill", pid, signal });
  if (Number(pid) < 0) {
    if (groupKillMode === "kills-tree") { tree.killTree(); return true; }
    // The grandchild escaped the group (setsid): only the wrapper can be hit.
    throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
  }
  tree.wrapperDies(signal);
  return true;
};

async function createSteamInstance(instanceId) {
  await instanceService.createInstance({ id: instanceId, displayName: instanceId, type: "custom-command", executable: process.execPath, args: ["-e", "0"] });
  const configPath = path.join(instanceRoot, instanceId, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, `${JSON.stringify({ ...config, installerType: "steamcmd-native", steamAppId: APP_ID, steamInstallDir: "server" }, null, 2)}\n`);
  const manifest = path.join(instanceRoot, instanceId, "data", "server", "steamapps", `appmanifest_${APP_ID}.acf`);
  await fsp.mkdir(path.dirname(manifest), { recursive: true });
  await fsp.writeFile(manifest, `"AppState"\n{\n\t"buildid"\t\t"41"\n}\n`);
}

async function timedOutUpdate(instanceId, operationId, platform, mode) {
  core._test.setProcessTreePlatform?.(platform);
  groupKillMode = mode;
  const session = await instanceService.beginSteamCmdUpdateSession(instanceId, { operationId });
  const startedAt = Date.now();
  await withDeadline(assert.rejects(
    instanceService.executeSteamCmdUpdate(instanceId, { operationId, token: session.token, timeoutMs: 1000 }),
    (error) => error.code === "STEAMCMD_UPDATE_TIMEOUT",
  ), 8000, `SteamCMD update (${platform}, ${mode})`);
  const elapsedMs = Date.now() - startedAt;
  const tree = fakeTrees.get(spawnCalls[spawnCalls.length - 1].pid);
  // A new session can be opened: the timed-out run no longer holds session.child.
  const next = await instanceService.beginSteamCmdUpdateSession(instanceId, { operationId: `${operationId}-next` });
  await instanceService.closeInstallationSession(instanceId, { operationId: `${operationId}-next`, token: next.token }).catch(() => {});
  return { tree, elapsedMs, options: spawnCalls[spawnCalls.length - 1].options };
}

async function steamCmdChecks() {
  core._test.setSteamCmdExecutable(STEAMCMD_SENTINEL);
  await createSteamInstance("steam-hang");

  // POSIX: SteamCMD runs in its own process group and the group is killed.
  const posix = await timedOutUpdate("steam-hang", "leak-op-posix", "linux", "kills-tree");
  assert.strictEqual(posix.options.detached, true, "On POSIX SteamCMD gets its own process group.");
  assert(killCalls.some((call) => call.kind === "process.kill" && call.pid === -posix.tree.child.pid && call.signal === "SIGKILL"), "The whole process group is killed on timeout.");
  assert.strictEqual(posix.tree.grandchildAlive, false, "The SteamCMD grandchild is dead after the timeout.");

  // POSIX, a grandchild outside the group: the run still settles once the
  // wrapper has exited (its pipes are closed from our side).
  const escaped = await timedOutUpdate("steam-hang", "leak-op-escape", "linux", "escapes-group");
  assert.strictEqual(escaped.tree.child.signalCode, "SIGKILL", "The wrapper is killed when the group kill fails.");
  assert(escaped.elapsedMs < 6000, `An escaped grandchild cannot hold the run open (took ${escaped.elapsedMs} ms).`);

  // Windows: no detached console; the tree is ended with taskkill /T /F.
  const windows = await timedOutUpdate("steam-hang", "leak-op-win", "win32", "kills-tree");
  assert.strictEqual(windows.options.detached, false, "Windows keeps SteamCMD attached (no new console).");
  assert(killCalls.some((call) => call.kind === "taskkill" && call.args.join(" ") === `/PID ${windows.tree.child.pid} /T /F`), "Windows kills the whole SteamCMD tree.");
  assert.strictEqual(windows.tree.grandchildAlive, false);

  // A cancelled run kills the tree too and settles as cancelled.
  core._test.setProcessTreePlatform?.("linux");
  groupKillMode = "kills-tree";
  const cancelSession = await instanceService.beginSteamCmdUpdateSession("steam-hang", { operationId: "leak-op-cancel" });
  const cancelled = instanceService.executeSteamCmdUpdate("steam-hang", { operationId: "leak-op-cancel", token: cancelSession.token, timeoutMs: 600000 });
  await delay(150);
  await instanceService.cancelInstallationSession("steam-hang", { operationId: "leak-op-cancel", token: cancelSession.token });
  await withDeadline(assert.rejects(cancelled, (error) => error.code === "STEAMCMD_UPDATE_CANCELLED"), 6000, "Cancelled SteamCMD update");
  assert.strictEqual(fakeTrees.get(spawnCalls[spawnCalls.length - 1].pid).grandchildAlive, false, "Cancel kills the SteamCMD grandchild.");

  // The node's SteamCMD queue still moves: a build lookup that itself hangs
  // past its (scaled) two-minute limit settles, and a following one runs.
  core._test.resetSteamBuildCheckCache();
  core._test.setSteamAppInfoRunner(null);
  const hungLookup = await withDeadline(instanceService.checkSteamCmdBuildUpdate("steam-hang", { refresh: true }), 8000, "Hung SteamCMD build lookup");
  assert.strictEqual(hungLookup.error, "STEAMCMD_BUILD_CHECK_TIMEOUT", "A hung lookup reports its timeout.");
  assert.strictEqual(fakeTrees.get(spawnCalls[spawnCalls.length - 1].pid).grandchildAlive, false, "A hung lookup's SteamCMD tree is killed.");
  core._test.resetSteamBuildCheckCache();
  core._test.setSteamAppInfoRunner(async () => ({ exitCode: 0, stdout: `"${APP_ID}"\n{\n"depots"\n{\n"branches"\n{\n"public"\n{\n"buildid" "42"\n}\n}\n}\n}\n` }));
  const lookup = await withDeadline(instanceService.checkSteamCmdBuildUpdate("steam-hang", { refresh: true }), 4000, "SteamCMD queue after timeouts");
  assert.strictEqual(lookup.latestBuildId, "42", "The SteamCMD queue runs the next task.");
  core._test.setSteamAppInfoRunner(null);
  core._test.setProcessTreePlatform?.(null);
}

// ---------------------------------------------------------------------------
// 2. Downloads: the Agent's stream on abort, and the desktop's time limit.
// ---------------------------------------------------------------------------
function loadAgentSendStream() {
  const source = fs.readFileSync(path.join(rootDir, "agent/src/server.js"), "utf8");
  const match = /function sendStream\([\s\S]*?\n}\r?\n/.exec(source);
  assert(match, "agent/src/server.js defines sendStream.");
  // eslint-disable-next-line no-new-func
  return new Function("pipeline", `${match[0]}\nreturn sendStream;`)(stream.pipeline);
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function agentStreamClosesOnAbort() {
  const sendStream = loadAgentSendStream();
  const filePath = path.join(smokeRoot, "big-backup.tar.gz");
  fs.writeFileSync(filePath, Buffer.alloc(32 * 1024 * 1024, 7));
  let source = null;
  const server = await listen((request, response) => {
    source = fs.createReadStream(filePath);
    sendStream(response, 200, source, { "Content-Type": "application/gzip" });
  });
  try {
    await new Promise((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port: server.address().port, path: "/download" }, (response) => {
        response.once("data", () => { request.destroy(); resolve(); });
      });
      request.on("error", () => {});
      request.setTimeout(5000, () => reject(new Error("no data")));
    });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && !(source.destroyed && source.closed)) await delay(50);
    assert.strictEqual(source.destroyed, true, "An aborted download destroys the archive stream.");
    assert.strictEqual(source.closed, true, "An aborted download closes the archive file.");
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function desktopDownloadsUseIdleTimeout() {
  // Trickles 15 chunks, one every 100 ms (1.5 s in total): far past the scaled
  // 30 s request limit, never idle for long.
  const trickle = await listen((request, response) => {
    response.writeHead(200, { "Content-Type": "application/gzip", "Content-Disposition": "attachment; filename=\"a.tar.gz\"" });
    let sent = 0;
    const timer = setInterval(() => {
      response.write(Buffer.alloc(1024, sent));
      sent += 1;
      if (sent === 15) { clearInterval(timer); response.end(); }
    }, 100);
    response.on("close", () => clearInterval(timer));
  });
  // Sends headers and one chunk, then stalls forever.
  const stalled = await listen((request, response) => {
    response.writeHead(200, { "Content-Type": "application/gzip" });
    response.write(Buffer.alloc(16));
  });
  const config = (server) => ({ agentUrl: `http://127.0.0.1:${server.address().port}`, agentToken: "resource-leaks-smoke" });
  try {
    const backup = await withDeadline(agentClient.downloadBackup("alpha-1", config(trickle)), 6000, "Trickled backup download");
    assert.strictEqual(backup.buffer.length, 15 * 1024, "A slow backup download completes in full.");
    const file = await withDeadline(agentClient.downloadFile("world/region.mca", config(trickle)), 6000, "Trickled file download");
    assert.strictEqual(file.size, 15 * 1024, "A slow file download completes in full.");
    const stalledStartedAt = Date.now();
    await withDeadline(assert.rejects(agentClient.downloadBackup("alpha-1", config(stalled)), (error) => error.code === "AGENT_TIMEOUT"), 6000, "Stalled backup download");
    assert(Date.now() - stalledStartedAt >= 500, "A stalled download is ended by the idle limit, not sooner.");
  } finally {
    for (const server of [trickle, stalled]) {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Backup scheduler: overlapping ticks and edits during a long backup.
// ---------------------------------------------------------------------------
// The fixed service exposes its tick; an unfixed one is driven through the
// production interval callback (which cannot be awaited, so it waits 2 s).
let capturedSchedulerTick = null;
function schedulerTick() {
  if (typeof backupService._test.runDueSchedules === "function") return backupService._test.runDueSchedules();
  if (!capturedSchedulerTick) {
    const realSetInterval = global.setInterval;
    global.setInterval = (callback) => { capturedSchedulerTick = callback; return { unref() { return this; } }; };
    try { backupService.startBackupScheduler(); } finally { global.setInterval = realSetInterval; }
    backupService.stopBackupScheduler();
    return delay(2000);
  }
  capturedSchedulerTick();
  return delay(2000);
}

async function backupSchedulerChecks() {
  for (const id of ["alpha", "beta"]) {
    await instanceService.createInstance({ id, displayName: id, type: "custom-command", executable: process.execPath, args: ["-e", "0"] });
    await fsp.writeFile(path.join(instanceRoot, id, "data", "world.dat"), `${id} world`);
  }
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await backupService.saveSchedule({ instanceId: "alpha", intervalHours: 6, keepLast: 10, nextRunAt: past });
  await backupService.saveSchedule({ instanceId: "beta", intervalHours: 6, keepLast: 10, nextRunAt: future });

  // Hold alpha's backup at its first lifecycle read until the test releases it.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let alphaBackupStarts = 0;
  const realGetStatus = instanceService.getStatus;
  instanceService.getStatus = async function gatedGetStatus(id, ...rest) {
    if (id === "alpha" && alphaBackupStarts++ === 0) await gate;
    return realGetStatus.call(this, id, ...rest);
  };
  try {
    const firstTick = schedulerTick();
    await delay(150);
    assert.strictEqual(alphaBackupStarts, 1, "The first tick started alpha's backup.");
    // A second tick while the first one runs must not start another backup.
    const secondTick = schedulerTick();
    await delay(150);
    assert.strictEqual(alphaBackupStarts, 1, "An overlapping tick never starts the same backup again.");
    // The user edits during the backup.
    await backupService.saveSchedule({ instanceId: "alpha", intervalHours: 12, keepLast: 3, enabled: false });
    await backupService.deleteSchedule("beta");
    release();
    await withDeadline(Promise.all([firstTick, secondTick]), 10000, "Scheduler ticks");
    const { schedules } = await backupService.listSchedules();
    const alpha = schedules.find((entry) => entry.instanceId === "alpha");
    assert(alpha, "alpha's schedule still exists.");
    assert.strictEqual(alpha.enabled, false, "A schedule disabled during a backup stays disabled.");
    assert.strictEqual(alpha.keepLast, 3, "A retention change made during a backup is kept.");
    assert.strictEqual(alpha.intervalHours, 12, "An interval change made during a backup is kept.");
    assert(alpha.lastRunAt, "The tick still records that the backup ran.");
    assert.strictEqual(alpha.lastError, null);
    assert(!schedules.some((entry) => entry.instanceId === "beta"), "A schedule deleted during a backup stays deleted.");
    const backups = (await backupService.listBackups({ instanceId: "alpha" })).backups;
    assert.strictEqual(backups.length, 1, "Exactly one scheduled backup ran.");

    // An unedited schedule gets the tick's next run time.
    await backupService.saveSchedule({ instanceId: "beta", intervalHours: 2, keepLast: 10, nextRunAt: past });
    const before = Date.now();
    await schedulerTick();
    const beta = (await backupService.listSchedules()).schedules.find((entry) => entry.instanceId === "beta");
    assert(Date.parse(beta.nextRunAt) >= before + 2 * 60 * 60 * 1000 - 1000, "An unedited schedule advances to its next interval.");
    assert(beta.lastRunAt);
  } finally {
    instanceService.getStatus = realGetStatus;
    release();
  }
}

(async () => {
  await check(1, "resource-leaks-1 SteamCMD timeout kills the tree and frees the queue", steamCmdChecks);
  await check(2, "resource-leaks-2 aborted downloads close the stream; desktop uses an idle limit", async () => {
    await agentStreamClosesOnAbort();
    await desktopDownloadsUseIdleTimeout();
  });
  await check(3, "resource-leaks-3 backup scheduler ticks never overlap or undo edits", backupSchedulerChecks);
  const failed = results.filter((entry) => !entry.ok);
  console.log(`Resource-leak hardening smoke: ${results.length - failed.length}/${results.length} passed (${results.length} checks)`);
  process.exit(failed.length ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
