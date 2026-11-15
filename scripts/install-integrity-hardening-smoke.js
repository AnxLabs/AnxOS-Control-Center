// Install integrity hardening — hermetic smoke.
//
// One numbered check per verified finding:
//   II1 remote Agent push update: a copy that fails while publishing restores
//       the backup and restarts the previous runtime, and the Desktop reports
//       "restored" only when the swap script's marker says so.
//   II2 SteamCMD updates: a large update that keeps making progress is not
//       killed at ten minutes, a stalled one is, and a scheduled update that
//       was killed part-way does not start the server on a half-written
//       install.
//   II3 publisher checksums: Paper's sha256, Mojang's server sha1 and the
//       per-file hashes of a Modrinth pack (and CurseForge's sha1) are compared
//       with the downloaded bytes before anything is written.
//
// Nothing here reaches a real host: fetch, the Agent client, SSH, SteamCMD and
// systemctl are fakes, long timers are compressed, and the swap script runs
// under a local POSIX sh with PATH stubs inside a temporary folder.
"use strict";

process.env.AGENT_URL = process.env.AGENT_URL || "http://127.0.0.1:9";

const assert = require("assert");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const Module = require("module");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const repoRoot = path.join(__dirname, "..");
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-install-integrity-"));
const realSetTimeout = global.setTimeout;
const realSpawn = childProcess.spawn;

const sha1 = (buffer) => crypto.createHash("sha1").update(buffer).digest("hex");
const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const sha512 = (buffer) => crypto.createHash("sha512").update(buffer).digest("hex");

// ---------------------------------------------------------------------------
// Module loading: the remote update service gets light stubs for its
// unrelated transports (as scripts/remote-agent-update-smoke.js does).
// ---------------------------------------------------------------------------
const remoteServicePath = path.join(repoRoot, "src", "services", "remoteAgentUpdateService.js");
const originalModuleLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { app: { getPath: () => smokeRoot, isPackaged: false } };
  if (parent?.filename === remoteServicePath) {
    if (request === "./diagnosticsService") return { log: () => {}, logError: () => {} };
    if (request === "./nodeService") return { getNode: () => null };
    if (request === "./applicationHostService") return { APPLICATION_HOST_NODE_ID: "application-host" };
    if (request === "./sshService") return { SshService: class StubSshService {} };
    if (request === "./localAgentRuntimeService") {
      return { getBundledLocalAgentRuntime: () => ({ exists: false }), getBundledLocalAgentVersion: () => null };
    }
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
const remoteAgentUpdateService = require(remoteServicePath);
Module._load = originalModuleLoad;

// ---------------------------------------------------------------------------
// II1 helpers
// ---------------------------------------------------------------------------
function findPosixShell() {
  const candidates = process.platform === "win32"
    ? ["C:/Program Files/Git/usr/bin/sh.exe", "C:/Program Files/Git/bin/sh.exe", "C:/Program Files (x86)/Git/usr/bin/sh.exe"]
    : ["/bin/sh", "/usr/bin/sh"];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function toShellPath(value) {
  return value.replace(/\\/g, "/");
}

function writeStub(directory, name, body) {
  const file = path.join(directory, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

// Runs the real generated swap script with stubbed systemctl, df and
// (optionally) a cp that fails whenever it copies out of the staged tree.
function runSwapScript(label, { failStagedCopy = false, freeKb = 999999999, failRestart = false, backupOutsideUpdateDir = false } = {}) {
  const shell = findPosixShell();
  if (!shell) return null;
  const caseRoot = path.join(smokeRoot, `swap-${label}`);
  const root = path.join(caseRoot, "root");
  const stageParent = path.join(root, ".anxos-agent-update");
  const stamp = path.join(stageParent, "2026-11-14T00-00-00-000Z");
  const staged = path.join(stamp, "staged");
  const backup = backupOutsideUpdateDir ? path.join(caseRoot, "elsewhere", "stamp", "backup") : path.join(stamp, "backup");
  if (backupOutsideUpdateDir) fs.mkdirSync(path.join(caseRoot, "elsewhere", "keep-me"), { recursive: true });
  const leftover = path.join(stageParent, "2026-11-01T00-00-00-000Z");
  const stubs = path.join(caseRoot, "stubs");
  const systemctlLog = path.join(caseRoot, "systemctl.log");
  for (const directory of [path.join(root, "agent", "src"), path.join(staged, "agent", "src"), path.join(leftover, "staged"), stubs]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(root, "agent", "src", "server.js"), "live-runtime\n");
  fs.writeFileSync(path.join(root, "package.json"), "{\"live\":true}\n");
  fs.writeFileSync(path.join(staged, "agent", "src", "server.js"), "staged-runtime\n");
  fs.writeFileSync(path.join(staged, "package.json"), "{\"staged\":true}\n");
  fs.writeFileSync(path.join(leftover, "staged", "old.bin"), "old attempt\n");
  const logPath = toShellPath(systemctlLog);
  writeStub(stubs, "systemctl", [
    `echo "$*" >> '${logPath}'`,
    failRestart ? 'case "$*" in *start*) exit 1 ;; esac' : "",
    "exit 0",
  ].join("\n"));
  writeStub(stubs, "df", [
    'echo "Filesystem 1024-blocks Used Available Capacity Mounted on"',
    `echo "/dev/fake 100000000 1000 ${freeKb} 1% /"`,
  ].join("\n"));
  writeStub(stubs, "cp", [
    failStagedCopy
      ? 'for arg in "$@"; do case "$arg" in */staged/*) echo "cp: No space left on device" >&2; exit 1 ;; esac; done'
      : "",
    'if [ -x /usr/bin/cp ]; then exec /usr/bin/cp "$@"; else exec /bin/cp "$@"; fi',
  ].join("\n"));
  const script = remoteAgentUpdateService._test.buildSwapScript({
    runtimeRoot: toShellPath(root),
    stagedDir: toShellPath(staged),
    backupDir: toShellPath(backup),
    unitName: "anxos-agent",
    includedPaths: ["agent", "package.json"],
  });
  const pathSeparator = process.platform === "win32" ? ";" : ":";
  const shellBin = path.dirname(shell);
  const result = childProcess.spawnSync(shell, ["-c", script], {
    encoding: "utf8",
    env: { ...process.env, PATH: [stubs, shellBin, process.env.PATH || ""].join(pathSeparator), XDG_RUNTIME_DIR: toShellPath(caseRoot) },
    timeout: 60000,
  });
  const systemctlCalls = fs.existsSync(systemctlLog) ? fs.readFileSync(systemctlLog, "utf8").trim().split(/\r?\n/).filter(Boolean) : [];
  return {
    code: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    systemctlCalls,
    root,
    staged,
    backup,
    leftover,
    read: (relative) => {
      const file = path.join(root, ...relative.split("/"));
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
    },
  };
}

function remoteUpdateOptions(swapResult) {
  const discoveryStdout = "--- exec ---\n{ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/anxos/app/agent/src/server.js ; ignore_errors=no }\n--- ps ---\n--- node ---\n/usr/bin/node\n";
  const runner = async (profileId, command) => {
    // The target probe: answer as the expected node (hostname + device ID).
    if (command.includes("--- hostname ---")) {
      return { code: 0, stdout: "--- user ---\nloaded\n--- system ---\nnot-found\n--- hostname ---\nnode-host\n--- agents ---\n\"deviceId\":\"device-key\"\n", stderr: "" };
    }
    if (command.includes("ExecStart")) return { code: 0, stdout: discoveryStdout, stderr: "" };
    if (command.includes("tar -xzf -")) return { code: 0, stdout: "STAGE_OK\n512", stderr: "" };
    if (command.includes("SWAP_OK")) return swapResult;
    if (command.includes("ROLLBACK_OK")) throw new Error("the verify-failure rollback must not run after a failed swap");
    return { code: 0, stdout: "", stderr: "" };
  };
  return {
    resolveNode: async () => ({ id: "node-key", displayName: "Node", platform: "linux", hostname: "node-host", agentIdentity: { deviceId: "device-key" } }),
    sshService: { getProfileForNode: () => ({ id: "profile-key", authType: "privateKey", displayName: "Key" }), runCommand: async () => ({ code: 0, stdout: "", stderr: "" }) },
    payloadReader: () => ({ runtime: { packaged: false }, payload: { files: [{ relativePath: "agent/src/server.js", absolutePath: __filename, mode: 0o644 }], totalBytes: 10, includedPaths: ["agent"] } }),
    runner,
    healthProbe: async () => ({ connected: true, networkInventoryOk: true, agentVersion: "0.1.0" }),
    bundledVersion: "9.9.9",
    updateDir: path.join(smokeRoot, "remote-updates"),
    sleep: async () => {},
    verifyAttempts: 1,
    verifyDelayMs: 0,
  };
}

async function remoteUpdateError(swapResult) {
  return remoteAgentUpdateService.updateRemoteAgent("node-key", remoteUpdateOptions(swapResult)).then(
    () => { throw new Error("the update must not succeed"); },
    (error) => error,
  );
}

async function checkRemoteAgentPublishFailureRollsBack() {
  // (a) The real generated script, run under sh.
  const failed = runSwapScript("publish-fails", { failStagedCopy: true });
  if (failed) {
    assert.notStrictEqual(failed.code, 0, `a failed publish must exit non-zero:\n${failed.stdout}\n${failed.stderr}`);
    assert(/PUBLISH_FAILED_ROLLED_BACK/.test(failed.stdout), `the script must print the rolled-back marker:\n${failed.stdout}\n${failed.stderr}`);
    assert.strictEqual(failed.read("agent/src/server.js"), "live-runtime\n", "agent/ must be restored from the backup");
    assert.strictEqual(failed.read("package.json"), "{\"live\":true}\n", "every included path must be restored");
    const stopIndex = failed.systemctlCalls.findIndex((call) => /--user stop anxos-agent/.test(call));
    const startIndex = failed.systemctlCalls.findIndex((call) => /--user start anxos-agent/.test(call));
    assert(stopIndex >= 0 && startIndex > stopIndex, `the Agent must be started again after the stop: ${JSON.stringify(failed.systemctlCalls)}`);
    assert(!fs.existsSync(failed.staged), "the staged copy is removed after a failed publish");
    assert(fs.existsSync(failed.backup), "the backup stays for the operator");
    assert(!fs.existsSync(failed.leftover), "folders older attempts left behind are pruned");

    const restartFails = runSwapScript("restart-fails", { failStagedCopy: true, failRestart: true });
    assert(/ROLLBACK_FAILED/.test(restartFails.stdout) && !/PUBLISH_FAILED_ROLLED_BACK/.test(restartFails.stdout), `a restore whose restart fails must say so:\n${restartFails.stdout}`);

    const noSpace = runSwapScript("no-space", { freeKb: 1 });
    assert.strictEqual(noSpace.code, 7, `too little free space must stop before the Agent is touched:\n${noSpace.stdout}\n${noSpace.stderr}`);
    assert(/INSUFFICIENT_SPACE/.test(noSpace.stdout));
    assert(!noSpace.systemctlCalls.some((call) => /stop/.test(call)), "the Agent must not be stopped when the space check fails");
    assert.strictEqual(noSpace.read("agent/src/server.js"), "live-runtime\n");

    const ok = runSwapScript("success");
    assert.strictEqual(ok.code, 0, `the happy path must still succeed:\n${ok.stdout}\n${ok.stderr}`);
    assert(/SWAP_OK/.test(ok.stdout));
    assert.strictEqual(ok.read("agent/src/server.js"), "staged-runtime\n", "the staged runtime is published");
    assert(fs.existsSync(path.join(ok.backup, "agent", "src", "server.js")), "the backup stays for the verify-failure rollback");

    // Pruning never leaves the dedicated update folder.
    const outside = runSwapScript("prune-guard", { backupOutsideUpdateDir: true });
    assert.strictEqual(outside.code, 0, `${outside.stdout}\n${outside.stderr}`);
    assert(fs.existsSync(path.join(smokeRoot, "swap-prune-guard", "elsewhere", "keep-me")), "folders outside .anxos-agent-update must never be pruned");
  } else {
    console.log("NOTE II1: no POSIX sh found; the generated swap script was not executed.");
  }

  // (b) The Desktop reports what the markers say.
  const rolledBack = await remoteUpdateError({ code: 8, stdout: "BACKUP_OK\nSTOP_OK\nPUBLISH_FAILED\nRESTORE_OK\nPUBLISH_FAILED_ROLLED_BACK\n", stderr: "cp: No space left on device" });
  assert.strictEqual(rolledBack.code, "REMOTE_AGENT_UPDATE_SWAP_FAILED");
  assert(/restored and restarted/.test(rolledBack.message), rolledBack.message);
  const rollbackFailed = await remoteUpdateError({ code: 8, stdout: "BACKUP_OK\nSTOP_OK\nPUBLISH_FAILED\nRESTORE_FAILED\nROLLBACK_FAILED\n", stderr: "" });
  assert.strictEqual(rollbackFailed.code, "REMOTE_AGENT_UPDATE_ROLLBACK_FAILED");
  assert(!/was restored/.test(rollbackFailed.message), `a failed restore must never be reported as restored: ${rollbackFailed.message}`);
  // An exit with no marker after the stop (the old script's set -e exit) is
  // not "restored" either.
  const interrupted = await remoteUpdateError({ code: 1, stdout: "BACKUP_OK\nSTOP_OK\n", stderr: "cp: No space left on device" });
  assert.strictEqual(interrupted.code, "REMOTE_AGENT_UPDATE_SWAP_INTERRUPTED");
  assert(!/was restored/.test(interrupted.message), interrupted.message);
  const beforeStop = await remoteUpdateError({ code: 9, stdout: "BACKUP_FAILED\n", stderr: "" });
  assert(/runtime is unchanged/.test(beforeStop.message), beforeStop.message);
  const startFailed = await remoteUpdateError({ code: 3, stdout: "BACKUP_OK\nSTOP_OK\nPUBLISH_OK\nSTART_FAILED\nRESTORE_OK\nSWAP_ROLLED_BACK\n", stderr: "" });
  assert.strictEqual(startFailed.code, "REMOTE_AGENT_UPDATE_SWAP_FAILED");
  assert(/previous runtime was restored/.test(startFailed.message));
}

// ---------------------------------------------------------------------------
// II2 helpers: the instance core with a fake SteamCMD and compressed timers.
// ---------------------------------------------------------------------------
const TIMER_SCALE = 10000; // 10 min -> 60 ms, 30 min -> 180 ms, 2 h -> 720 ms
const FAKE_STEAMCMD = path.join(smokeRoot, "fake-steamcmd-does-not-exist");
const APP_ID = 2394010;
let instanceService = null;
let fakeSteamCmdBehaviour = null;
// Only the SteamCMD runs are compressed: job timers created while instances are
// set up keep their real length.
let compressing = false;

function compressLongTimers() {
  global.setTimeout = function compressedSetTimeout(fn, ms, ...rest) {
    const delay = Number(ms);
    return realSetTimeout(fn, compressing && delay >= 60000 ? Math.max(1, Math.round(delay / TIMER_SCALE)) : ms, ...rest);
  };
  childProcess.spawn = function fakeSpawn(command, args, options) {
    if (command !== FAKE_STEAMCMD) return realSpawn.apply(this, arguments);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.pid = 424242;
    const timers = [];
    const finish = (exitCode, signal) => {
      for (const timer of timers) clearInterval(timer);
      setImmediate(() => { child.stdout.end(); child.stderr.end(); child.emit("close", exitCode, signal); });
    };
    child.kill = (signal) => { child.killed = true; finish(null, signal || "SIGTERM"); return true; };
    fakeSteamCmdBehaviour({ child, args, timers, finish });
    return child;
  };
  // The core ends a SteamCMD run with a process-tree kill (taskkill /T on
  // Windows, a process-group signal elsewhere). The fake child's PID is not
  // ours to signal on this machine, so both are turned into a kill of the fake.
  const fakeChildren = new Map();
  const trackedSpawn = childProcess.spawn;
  childProcess.spawn = function trackingSpawn(command) {
    const child = trackedSpawn.apply(this, arguments);
    if (command === FAKE_STEAMCMD) fakeChildren.set(child.pid, child);
    return child;
  };
  const realExecFile = childProcess.execFile;
  childProcess.execFile = function fakeTreeKill(command, args, options, callback) {
    const pid = Number(Array.isArray(args) ? args[args.indexOf("/PID") + 1] : NaN);
    if (/taskkill/i.test(String(command)) && fakeChildren.has(pid)) {
      fakeChildren.get(pid).kill("SIGKILL");
      const done = typeof options === "function" ? options : callback;
      if (typeof done === "function") setImmediate(() => done(null, "", ""));
      return new EventEmitter();
    }
    return realExecFile.apply(this, arguments);
  };
  const realKill = process.kill;
  process.kill = function fakeGroupKill(pid, signal) {
    const target = fakeChildren.get(Math.abs(Number(pid)));
    if (target) { target.kill(signal); return true; }
    return realKill.apply(process, arguments);
  };
}

function restoreTimersAndSpawn() {
  global.setTimeout = realSetTimeout;
  childProcess.spawn = realSpawn;
}

function manifestPath(instanceId) {
  return path.join(smokeRoot, "instances", instanceId, "data", "server", "steamapps", `appmanifest_${APP_ID}.acf`);
}

async function writeManifest(instanceId, buildId, stateFlags = 4) {
  await fsp.mkdir(path.dirname(manifestPath(instanceId)), { recursive: true });
  await fsp.writeFile(manifestPath(instanceId), `"AppState"\n{\n\t"appid"\t\t"${APP_ID}"\n\t"StateFlags"\t\t"${stateFlags}"\n\t"buildid"\t\t"${buildId}"\n}\n`);
}

async function createSteamInstance(instanceId) {
  await instanceService.createInstance({
    id: instanceId,
    displayName: "Install Integrity Smoke",
    type: "custom-command",
    executable: process.execPath,
    args: ["-e", "console.log('Server started'); setInterval(() => {}, 1000)"],
    startupTimeoutMs: 10000,
    shutdownTimeoutMs: 10000,
  });
  const configPath = path.join(smokeRoot, "instances", instanceId, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, `${JSON.stringify({ ...config, installerType: "steamcmd-native", steamAppId: APP_ID, steamInstallDir: "server" }, null, 2)}\n`);
}

function appInfo(buildId) {
  return [`"${APP_ID}"`, "{", '"depots"', "{", '"branches"', "{", '"public"', "{", `"buildid" "${buildId}"`, "}", "}", "}", "}"].join("\n");
}

async function runManualUpdate(instanceId) {
  const operationId = `smoke-update-${crypto.randomBytes(4).toString("hex")}`;
  const session = await instanceService.beginSteamCmdUpdateSession(instanceId, { operationId });
  const startedAt = Date.now();
  try {
    const result = await instanceService.executeSteamCmdUpdate(instanceId, { operationId, token: session.token });
    return { result, elapsedMs: Date.now() - startedAt };
  } catch (error) {
    return { error, elapsedMs: Date.now() - startedAt };
  } finally {
    await instanceService.closeInstallationSession(instanceId, { operationId, token: session.token }).catch(() => {});
  }
}

async function checkSteamCmdUpdateBudgetAndIncompleteInstall() {
  process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);
  process.env.AGENT_INSTANCE_ROOT = path.join(smokeRoot, "instances");
  fs.mkdirSync(process.env.AGENT_INSTANCE_ROOT, { recursive: true });
  instanceService = require(path.join(repoRoot, "src", "shared", "instances", "instanceServiceCore.js"));
  instanceService.configureInstanceService({ getConfig: () => ({ instanceRoot: process.env.AGENT_INSTANCE_ROOT }) });
  instanceService._test.setSteamCmdExecutable(FAKE_STEAMCMD);
  compressLongTimers();
  try {
    // (a) A large update that keeps printing progress for "67 minutes"
    // (400 ms compressed) and then finishes must not be killed at ten.
    const progressing = "steam-progressing";
    await createSteamInstance(progressing);
    await writeManifest(progressing, "400");
    fakeSteamCmdBehaviour = ({ child, timers, finish }) => {
      let percent = 0;
      timers.push(setInterval(() => {
        percent = Math.min(99, percent + 1);
        child.stdout.write(` Update state (0x61) downloading, progress: ${percent.toFixed(2)} (1 / 100)\n`);
      }, 20));
      realSetTimeout(() => {
        if (child.killed) return;
        fs.writeFileSync(manifestPath(progressing), `"AppState"\n{\n\t"appid"\t\t"${APP_ID}"\n\t"StateFlags"\t\t"4"\n\t"buildid"\t\t"500"\n}\n`);
        child.stdout.write(`Success! App '${APP_ID}' fully installed.\n`);
        finish(0, null);
      }, 400);
    };
    compressing = true;
    const progressed = await runManualUpdate(progressing);
    compressing = false;
    assert(!progressed.error, `an update that keeps making progress past ten minutes must not be killed (${progressed.error?.code})`);
    assert.strictEqual(progressed.result.buildIdAfter, "500");

    // (b) A SteamCMD that prints nothing is ended by the stall watchdog, well
    // before the two-hour ceiling.
    const stalled = "steam-stalled";
    await createSteamInstance(stalled);
    await writeManifest(stalled, "400");
    fakeSteamCmdBehaviour = () => {};
    compressing = true;
    const stalledRun = await runManualUpdate(stalled);
    compressing = false;
    assert.strictEqual(stalledRun.error?.code, "STEAMCMD_UPDATE_TIMEOUT", "a silent SteamCMD must time out");
    assert.strictEqual(stalledRun.error.stalled, true, "the timeout must come from the no-progress watchdog");
    // Scaled like the timers: the hard ceiling is the two-hour maximum.
    const scaledCeilingMs = instanceService._test.STEAMCMD_UPDATE_TIMEOUT_MAX_MS / TIMER_SCALE;
    assert(stalledRun.elapsedMs < scaledCeilingMs, `the stall watchdog must fire before the hard ceiling (${stalledRun.elapsedMs} ms of ${scaledCeilingMs} ms)`);

    // (c) Scheduled update killed part-way (StateFlags not "fully installed"):
    // the server must not be started on the half-written install.
    const scheduled = "steam-scheduled";
    await createSteamInstance(scheduled);
    await writeManifest(scheduled, "400");
    instanceService._test.resetSteamBuildCheckCache();
    instanceService._test.setSteamAppInfoRunner(async () => ({ exitCode: 0, stdout: appInfo("500") }));
    instanceService._test.setSteamCmdUpdateExecutor(async (id) => {
      await writeManifest(id, "500", 1026);
      throw Object.assign(new Error("STEAMCMD_UPDATE_TIMEOUT"), { code: "STEAMCMD_UPDATE_TIMEOUT", buildIdBefore: "400", buildIdAfter: "500" });
    });
    let scheduledError = null;
    try {
      await instanceService.restartInstanceWithSteamUpdate(scheduled);
    } catch (error) {
      scheduledError = error;
    }
    const status = await instanceService.getStatus(scheduled);
    assert.notStrictEqual(status.processState, instanceService.INSTANCE_STATES.RUNNING, "a half-written install must not be started");
    assert.strictEqual(scheduledError?.code, "STEAMCMD_INSTALL_INCOMPLETE", `the scheduled restart must fail with STEAMCMD_INSTALL_INCOMPLETE (got ${scheduledError?.code || "success"})`);
    assert.strictEqual(status.state, instanceService.INSTANCE_STATES.FAILED, "the server is marked Failed");

    // (d) A timeout that left the install whole still starts the old build.
    const whole = "steam-scheduled-whole";
    await createSteamInstance(whole);
    await writeManifest(whole, "400");
    instanceService._test.resetSteamBuildCheckCache();
    instanceService._test.setSteamCmdUpdateExecutor(async () => {
      throw Object.assign(new Error("STEAMCMD_UPDATE_TIMEOUT"), { code: "STEAMCMD_UPDATE_TIMEOUT", buildIdBefore: "400", buildIdAfter: "400" });
    });
    const wholeOutcome = await instanceService.restartInstanceWithSteamUpdate(whole);
    assert.strictEqual(wholeOutcome.steamUpdate.ok, false);
    assert.notStrictEqual(wholeOutcome.steamUpdate.installIncomplete, true);
    await instanceService.stopInstance(whole, { timeoutMs: 5000 }).catch(() => {});
  } finally {
    compressing = false;
    instanceService._test.setSteamCmdUpdateExecutor(null);
    restoreTimersAndSpawn();
  }
}

// ---------------------------------------------------------------------------
// II3 helpers: fetch routes and an in-memory Agent client.
// ---------------------------------------------------------------------------
const routes = new Map();
const originalFetch = global.fetch;
function installFetch() {
  global.fetch = async (url) => {
    const href = String(url);
    if (!routes.has(href)) throw new Error(`hermetic smoke: unexpected fetch ${href}`);
    const body = routes.get(href);
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    return new Response(buffer, { status: 200, headers: { "content-length": String(buffer.length), "content-type": Buffer.isBuffer(body) ? "application/octet-stream" : "application/json" } });
  };
}

function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of Object.entries(entries)) {
    const fileName = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(fileName.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(fileName.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, fileName, data);
    centrals.push(central, fileName);
    offset += 30 + fileName.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function checkPublisherChecksumsAreEnforced() {
  if (typeof zlib.crc32 !== "function" || typeof Response !== "function") throw new Error("Node 20.15+ is required for this smoke.");
  installFetch();
  const agentClient = require(path.join(repoRoot, "src", "services", "agentClient.js"));
  const written = new Map();
  const patched = {};
  for (const name of ["writeInstanceFile", "readInstanceFile", "instanceFileExists"]) patched[name] = agentClient[name];
  agentClient.writeInstanceFile = async (id, filePath, content, options) => {
    written.set(filePath, options && options.encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content));
    return { ok: true };
  };
  agentClient.readInstanceFile = async (id, filePath) => ({ content: (written.get(filePath) || Buffer.alloc(0)).toString("base64") });
  agentClient.instanceFileExists = async (id, filePath) => ({ exists: written.has(filePath) });
  try {
    const marketplaceService = require(path.join(repoRoot, "src", "services", "marketplaceService.js"));
    const realJar = Buffer.from("PK\u0003\u0004REAL-SERVER-JAR");
    const substituted = Buffer.from("<html>captive portal</html>");
    const download = async (name, spec) => {
      written.clear();
      try {
        const result = await marketplaceService._test.downloadOneToInstance({ id: name, name, downloads: [spec] }, spec, {}, "inst-integrity", [], { nodeId: "node-1" });
        return { result, written: written.get(spec.destination) || null };
      } catch (error) {
        return { error, written: written.get(spec.destination) || null };
      }
    };

    // Paper: the build's sha256 is enforced.
    const paper = "https://fill.papermc.io/v3/projects/paper";
    routes.set(`${paper}/versions`, { versions: [{ version: { id: "1.21.4", java: { version: { minimum: 21 } } } }] });
    routes.set(`${paper}/versions/1.21.4/builds`, [{ id: 200, channel: "STABLE", downloads: { "server:default": { name: "paper.jar", url: "https://fill-data.papermc.io/paper.jar", checksums: { sha256: sha256(realJar) }, size: realJar.length } } }]);
    const paperSpec = { type: "url", resolver: "papermc", project: "paper", version: "1.21.4", build: "200", destination: "server.jar", required: true };
    routes.set("https://fill-data.papermc.io/paper.jar", substituted);
    const paperBad = await download("paper", paperSpec);
    assert.strictEqual(paperBad.error?.code, "DOWNLOAD_CHECKSUM_MISMATCH", "a jar that does not match PaperMC's sha256 must be refused");
    assert.strictEqual(paperBad.written, null, "nothing may be written when the sha256 does not match");
    routes.set("https://fill-data.papermc.io/paper.jar", realJar);
    const paperGood = await download("paper", paperSpec);
    assert(!paperGood.error, `the real Paper jar must install (${paperGood.error?.code})`);
    assert(paperGood.written && paperGood.written.equals(realJar));

    // Vanilla: Mojang's server sha1 is enforced.
    routes.set("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json", { latest: { release: "1.21.4" }, versions: [{ id: "1.21.4", url: "https://piston-meta.mojang.com/v1/packages/x/1.21.4.json" }] });
    routes.set("https://piston-meta.mojang.com/v1/packages/x/1.21.4.json", { downloads: { server: { url: "https://piston-data.mojang.com/v1/objects/abc/server.jar", sha1: sha1(realJar), size: realJar.length } }, javaVersion: { majorVersion: 21 } });
    const vanillaSpec = { type: "url", resolver: "mojang-vanilla", version: "1.21.4", destination: "server.jar", required: true };
    routes.set("https://piston-data.mojang.com/v1/objects/abc/server.jar", substituted);
    const vanillaBad = await download("vanilla", vanillaSpec);
    assert.strictEqual(vanillaBad.error?.code, "DOWNLOAD_CHECKSUM_MISMATCH", "a jar that does not match Mojang's sha1 must be refused");
    assert.strictEqual(vanillaBad.written, null);
    routes.set("https://piston-data.mojang.com/v1/objects/abc/server.jar", realJar);
    const vanillaGood = await download("vanilla", vanillaSpec);
    assert(!vanillaGood.error, `the real Vanilla jar must install (${vanillaGood.error?.code})`);

    // Modrinth .mrpack: each mod's declared hash is enforced.
    const marketplaceInstallService = require(path.join(repoRoot, "src", "services", "marketplaceInstallService.js"));
    const installModrinthPack = marketplaceInstallService._test.installModrinthPack;
    assert.strictEqual(typeof installModrinthPack, "function", "installModrinthPack must be reachable for this check");
    const realMod = Buffer.from("PK\u0003\u0004REAL-MOD");
    const otherMod = Buffer.from("PK\u0003\u0004REPLACED-MOD");
    const index = {
      formatVersion: 1,
      game: "minecraft",
      versionId: "1",
      name: "pack",
      dependencies: { minecraft: "1.21.4", "fabric-loader": "0.16.9" },
      files: [{ path: "mods/foo.jar", hashes: { sha1: sha1(realMod), sha512: sha512(realMod) }, env: { server: "required", client: "required" }, downloads: ["https://github.com/x/y/releases/download/v1/foo.jar"], fileSize: realMod.length }],
    };
    const packUrl = "https://cdn.modrinth.com/data/pack/versions/v1/pack.mrpack";
    routes.set(packUrl, makeZip({ "modrinth.index.json": Buffer.from(JSON.stringify(index)) }));
    const installPack = async () => {
      written.clear();
      try {
        const result = await installModrinthPack("inst-pack", {
          providerProjectId: "pack",
          modrinthSelectedProject: { id: "pack", slug: "pack", name: "Pack", projectType: "modpack", serverSide: "required", clientSide: "optional", server_side: "required" },
          modrinthSelectedVersion: { id: "v1", gameVersions: ["1.21.4"], loaders: ["fabric"], primaryFile: { url: packUrl, filename: "pack.mrpack" }, files: [{ url: packUrl, filename: "pack.mrpack", hashes: {} }] },
        }, { nodeId: "node-1" }, { nodeId: "node-1", instanceId: "inst-pack", manualFiles: {} });
        return { result, mod: written.get("mods/foo.jar") || null };
      } catch (error) {
        return { error, mod: written.get("mods/foo.jar") || null };
      }
    };
    routes.set("https://github.com/x/y/releases/download/v1/foo.jar", otherMod);
    const packBad = await installPack();
    assert.strictEqual(packBad.error?.code, "DOWNLOAD_CHECKSUM_MISMATCH", `a pack file that does not match its declared hash must be refused (got ${packBad.error?.code || "success"})`);
    assert.strictEqual(packBad.mod, null, "the mismatched mod must not be written");
    routes.set("https://github.com/x/y/releases/download/v1/foo.jar", realMod);
    const packGood = await installPack();
    assert(!packGood.error, `the pack with matching mods must install (${packGood.error?.code}: ${packGood.error?.message})`);
    assert(packGood.mod && packGood.mod.equals(realMod));

    // CurseForge publishes SHA-1 as hashes[{ algo: 1 }]; malformed values are ignored.
    const verify = marketplaceInstallService._test.verifyDownloadedFileHash;
    assert.throws(() => verify(otherMod, [{ algo: 1, value: sha1(realMod) }], { fileName: "cf.jar" }), (error) => error.code === "DOWNLOAD_CHECKSUM_MISMATCH");
    assert.deepStrictEqual(verify(realMod, [{ algo: 2, value: "a".repeat(32) }, { algo: 1, value: sha1(realMod).toUpperCase() }]), { algorithm: "sha1", value: sha1(realMod) });
    assert.strictEqual(verify(otherMod, { sha1: "mr" }), null, "a malformed declared hash is not a digest and is not enforced");
  } finally {
    Object.assign(agentClient, patched);
    global.fetch = originalFetch;
  }
}

const checks = [
  ["II1 remote Agent publish failure restores the backup, restarts the Agent, and is reported honestly", checkRemoteAgentPublishFailureRollsBack],
  ["II2 SteamCMD updates outlive ten minutes while progressing; a killed scheduled update does not start a half-written install", checkSteamCmdUpdateBudgetAndIncompleteInstall],
  ["II3 Paper sha256, Mojang sha1 and Modrinth/CurseForge per-file hashes are compared with the downloaded bytes", checkPublisherChecksumsAreEnforced],
];

(async () => {
  let failed = 0;
  for (const [name, check] of checks) {
    try {
      await check();
      console.log(`PASS ${name}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${name}\n  ${error?.stack || error}`);
    }
  }
  try {
    if (instanceService) await instanceService.shutdownInstanceService({ timeoutMs: 2000 }).catch(() => {});
  } catch {
    // Best effort.
  }
  fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 3 });
  console.log(`(${checks.length} checks)`);
  process.exit(failed ? 1 : 0);
})();
