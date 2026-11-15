#!/usr/bin/env node
"use strict";

// Regression checks for state that was silently lost or overwritten.
//   1 state-durability-1  the AnxNet device key is never replaced when it
//                         can't be read: an undecryptable or damaged key file
//                         is kept byte for byte, a copy is preserved, and a
//                         typed ANXNET_DEVICE_KEY_UNREADABLE error is raised;
//                         a fallback key survives a computer rename; a host
//                         that answered (key mismatch) never gets an
//                         in-process node started beside it
//   2 state-durability-2  the Agent's backup scheduler never writes back a
//                         schedules.json read before its backups ran:
//                         schedules disabled, deleted or added meanwhile are
//                         kept, and overlapping ticks back up each schedule
//                         once with no false BACKUP_OPERATION_IN_PROGRESS
//   3 state-durability-3  a SteamCMD update keeps settings saved while its
//                         backup and download ran
//   4 state-durability-4  the desktop and the Local Agent sharing one config
//                         folder keep separate long-operation files, so
//                         neither erases the other's records or marks the
//                         other's running operation as interrupted
// Each check runs in its own child process with temp folders. Electron,
// SteamCMD, the AnxNet host and backups are faked; nothing talks to a real
// Agent, service, network or host.
// Run: node scripts/state-durability-hardening-smoke.js

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.resolve(__dirname, "..");
const SELF = __filename;

function tempRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `state-durability-${label}-`));
}

function isolate(root) {
  process.env.AGENT_URL = "http://127.0.0.1:9";
  for (const key of ["ANXHUB_CONFIG_DIR", "ANXOS_CONFIG_DIR", "ANXOS_LOG_DIR"]) {
    process.env[key] = path.join(root, key);
    fs.mkdirSync(process.env[key], { recursive: true });
  }
}

// ---- 1: AnxNet device key ------------------------------------------------------------------

// A controllable Electron safeStorage stand-in.
function installElectronStub() {
  const Module = require("module");
  const safeStorage = {
    available: false,
    isEncryptionAvailable() { return this.available; },
    encryptString(text) { return Buffer.from(`stub:${text}`, "utf8"); },
    decryptString(buffer) {
      const text = buffer.toString("utf8");
      if (!text.startsWith("stub:")) throw new Error("Error while decrypting the ciphertext provided to safeStorage.decryptString.");
      return text.slice(5);
    },
  };
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return { app: null, safeStorage };
    return originalLoad.call(this, request, parent, isMain);
  };
  return safeStorage;
}

function stubModule(relative, exports) {
  const resolved = require.resolve(path.join(REPO, relative));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

function preservedCopies(file) {
  return fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(`${path.basename(file)}.`) && name.endsWith(".backup"));
}

function expectUnreadable(fn, label) {
  let caught = null;
  try { fn(); } catch (error) { caught = error; }
  assert(caught, `${label}: the unreadable key is refused, not replaced`);
  assert.strictEqual(caught.code, "ANXNET_DEVICE_KEY_UNREADABLE", `${label}: typed error (got ${caught.code || caught.message})`);
}

async function childDeviceKey() {
  const root = tempRoot("key");
  isolate(root);
  const safeStorage = installElectronStub();
  stubModule("src/services/nodeService.js", { getAllNodesSync: () => [], getNode: () => null });
  const service = require(path.join(REPO, "src/services/anxnetService.js"));
  const devicePrivateKeyPem = service._test?.devicePrivateKeyPem;
  assert.strictEqual(typeof devicePrivateKeyPem, "function", "the device key reader is reachable for tests");
  const realHostname = os.hostname;
  const keyFile = () => path.join(service.dataDir(), "anxnet-device.key.json");

  try {
    // (a) Fallback cipher (no keyring): the key survives a computer rename.
    process.env.ANXHUB_CONFIG_DIR = path.join(root, "a");
    const original = devicePrivateKeyPem();
    assert(/BEGIN PRIVATE KEY/.test(original), "a key is created when there is none");
    assert.strictEqual(devicePrivateKeyPem(), original, "the same key is read back");
    const bytes = fs.readFileSync(keyFile());
    os.hostname = () => "renamed-computer";
    assert.strictEqual(devicePrivateKeyPem(), original, "the key is still this computer's key after a rename");
    assert(fs.readFileSync(keyFile()).equals(bytes), "the key file is not rewritten after a rename");
    os.hostname = realHostname;

    // (b) A fallback key written by an older build (no recorded name) and a
    // renamed computer: refused and kept; renaming back gives the key back.
    process.env.ANXHUB_CONFIG_DIR = path.join(root, "b");
    const legacy = devicePrivateKeyPem();
    const record = JSON.parse(fs.readFileSync(keyFile(), "utf8"));
    delete record.hostname;
    fs.writeFileSync(keyFile(), JSON.stringify(record));
    const legacyBytes = fs.readFileSync(keyFile());
    os.hostname = () => "renamed-computer";
    expectUnreadable(devicePrivateKeyPem, "renamed computer, older key file");
    assert(fs.readFileSync(keyFile()).equals(legacyBytes), "the undecryptable key file is left byte for byte");
    assert.strictEqual(preservedCopies(keyFile()).length, 1, "a recovery copy is preserved");
    expectUnreadable(devicePrivateKeyPem, "second start, still renamed");
    assert.strictEqual(preservedCopies(keyFile()).length, 1, "repeated starts don't pile up identical copies");
    os.hostname = realHostname;
    assert.strictEqual(devicePrivateKeyPem(), legacy, "renaming the computer back gives the original key back");
    assert.strictEqual(JSON.parse(fs.readFileSync(keyFile(), "utf8")).hostname, realHostname(), "the computer name is now recorded with the older key");
    os.hostname = () => "renamed-again";
    assert.strictEqual(devicePrivateKeyPem(), legacy, "and a later rename no longer locks it");
    os.hostname = realHostname;

    // (c) Written with the keyring, which is unavailable on a later start.
    process.env.ANXHUB_CONFIG_DIR = path.join(root, "c");
    safeStorage.available = true;
    const keyring = devicePrivateKeyPem();
    assert.strictEqual(JSON.parse(fs.readFileSync(keyFile(), "utf8")).method, "safeStorage", "the key uses the keyring when there is one");
    const keyringBytes = fs.readFileSync(keyFile());
    safeStorage.available = false;
    expectUnreadable(devicePrivateKeyPem, "keyring unavailable");
    assert(fs.readFileSync(keyFile()).equals(keyringBytes), "the keyring-encrypted key is kept while the keyring is away");
    safeStorage.available = true;
    assert.strictEqual(devicePrivateKeyPem(), keyring, "the keyring coming back gives the original key back");

    // (d) The keyring can't decrypt it (a changed backend), and a damaged file.
    const swapped = JSON.parse(fs.readFileSync(keyFile(), "utf8"));
    fs.writeFileSync(keyFile(), JSON.stringify({ ...swapped, data: Buffer.from("other-backend").toString("base64") }));
    const swappedBytes = fs.readFileSync(keyFile());
    expectUnreadable(devicePrivateKeyPem, "keyring decrypt throws");
    assert(fs.readFileSync(keyFile()).equals(swappedBytes), "a key the keyring can't decrypt is kept");
    fs.writeFileSync(keyFile(), "{ not json");
    expectUnreadable(devicePrivateKeyPem, "damaged file");
    assert.strictEqual(fs.readFileSync(keyFile(), "utf8"), "{ not json", "a damaged key file is kept");
    assert(fs.readdirSync(path.dirname(keyFile())).some((name) => /\.corrupt-\d+\.backup$/.test(name)), "a damaged key file gets a recovery copy");
    safeStorage.available = false;

    // (e) A new key never leaves a temporary file behind.
    assert.deepStrictEqual(fs.readdirSync(path.dirname(keyFile())).filter((name) => name.endsWith(".tmp")), [], "no temporary key files are left");
  } finally {
    os.hostname = realHostname;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function childHostFallback() {
  const root = tempRoot("host");
  isolate(root);
  installElectronStub();
  const dataDir = path.join(process.env.ANXHUB_CONFIG_DIR, "anxnet");
  fs.mkdirSync(dataDir, { recursive: true });
  // Port 0 skips the fixed-port probe; nothing listens in this check.
  fs.writeFileSync(path.join(dataDir, "anxnet-settings.json"), JSON.stringify({ backgroundService: true, listenHost: "127.0.0.1", listenPort: 0, dnsPort: 0 }));
  stubModule("src/services/nodeService.js", { getAllNodesSync: () => [], getNode: () => null });

  const hostBehaviour = { connect: "ok", unlock: null };
  const hostCalls = [];
  const { EventEmitter } = require("events");
  class FakeHostClient extends EventEmitter {
    async connect() {
      hostCalls.push("connect");
      if (hostBehaviour.connect !== "ok") throw Object.assign(new Error("AnxNet's background process didn't start."), { code: hostBehaviour.connect });
      return this;
    }
    async call(method) {
      hostCalls.push(method);
      if (method === "unlock" && hostBehaviour.unlock) throw Object.assign(new Error("host refused"), { code: hostBehaviour.unlock });
      if (method === "status") return { network: null };
      return true;
    }
    disconnect() { hostCalls.push("disconnect"); }
  }
  const createdNodes = [];
  class FakeNode extends EventEmitter {
    constructor(options) { super(); createdNodes.push(options); }
    async start() {}
    async stop() {}
    async createNetwork() { return { network: null }; }
    status() { return { network: null }; }
  }
  const realHostClient = require(path.join(REPO, "src/anxnet/hostClient.js"));
  stubModule("src/anxnet/hostClient.js", { ...realHostClient, AnxNetHostClient: FakeHostClient });
  const realNode = require(path.join(REPO, "src/anxnet/node.js"));
  stubModule("src/anxnet/node.js", { ...realNode, AnxNetNode: FakeNode });
  const service = require(path.join(REPO, "src/services/anxnetService.js"));
  const warnings = [];
  service.events.on("warning", (warning) => warnings.push(warning.code));

  try {
    // A running host with a different key: reported, no second node.
    hostBehaviour.unlock = "ANXNET_HOST_KEY_MISMATCH";
    await assert.rejects(service.createNetwork({ name: "x" }), (error) => error.code === "ANXNET_HOST_KEY_MISMATCH", "a key mismatch is reported");
    assert.strictEqual(createdNodes.length, 0, "no in-process node starts beside a running host");
    assert(hostCalls.includes("disconnect"), "the connection to the refusing host is closed");

    // A host that answered but timed out: still alive, so still no second node.
    hostBehaviour.unlock = "ANXNET_HOST_TIMEOUT";
    await assert.rejects(service.createNetwork({ name: "x" }), (error) => error.code === "ANXNET_HOST_TIMEOUT");
    assert.strictEqual(createdNodes.length, 0, "a slow host doesn't get a second node beside it either");

    // An unreadable key: the host is never started, and nothing runs in-process.
    hostBehaviour.unlock = null;
    fs.writeFileSync(path.join(dataDir, "anxnet-device.key.json"), "{ damaged");
    hostCalls.length = 0;
    await assert.rejects(service.createNetwork({ name: "x" }), (error) => error.code === "ANXNET_DEVICE_KEY_UNREADABLE");
    assert.deepStrictEqual(hostCalls, [], "an unreadable key doesn't start or contact a host");
    assert.strictEqual(createdNodes.length, 0, "an unreadable key doesn't start an in-process node");
    assert.strictEqual(fs.readFileSync(path.join(dataDir, "anxnet-device.key.json"), "utf8"), "{ damaged", "the key file is kept");

    // The helper really couldn't start: AnxNet still runs in-process, as before.
    fs.rmSync(path.join(dataDir, "anxnet-device.key.json"));
    hostBehaviour.connect = "ANXNET_HOST_START_FAILED";
    await service.createNetwork({ name: "x" });
    assert.strictEqual(createdNodes.length, 1, "a host that never started still falls back to an in-process node");
    assert(warnings.includes("ANXNET_HOST_START_FAILED"), "and says so");
  } finally {
    await service.shutdown().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---- 2: backup schedules -------------------------------------------------------------------

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function childBackupSchedules() {
  const root = tempRoot("sched");
  isolate(root);
  process.env.AGENT_PORT = "9";
  process.env.AGENT_BACKUP_ROOT = path.join(root, "backups");
  process.env.AGENT_INSTANCE_ROOT = path.join(root, "instances");
  fs.mkdirSync(process.env.AGENT_INSTANCE_ROOT, { recursive: true });
  const backups = require(path.join(REPO, "agent/src/services/backupService.js"));
  assert.strictEqual(typeof backups._test?.runDueSchedules, "function", "the scheduler pass is reachable for tests");
  assert.strictEqual(typeof backups._test?.setScheduledBackupRunner, "function", "the scheduled backup can be faked");
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  const read = async () => (await backups.listSchedules()).schedules;
  const byId = async () => Object.fromEntries((await read()).map((entry) => [entry.instanceId, entry]));

  try {
    // (a) Edits made while a scheduled backup runs are kept.
    await backups.saveSchedule({ instanceId: "survival", intervalHours: 6, nextRunAt: past });
    await backups.saveSchedule({ instanceId: "legacy", intervalHours: 6, nextRunAt: past });
    const calls = [];
    const started = deferred();
    const gate = deferred();
    backups._test.setScheduledBackupRunner(async (request) => {
      calls.push(request.instanceId);
      if (calls.length === 1) { started.resolve(); await gate.promise; }
      return { backup: { id: `b-${request.instanceId}` } };
    });
    const run = backups._test.runDueSchedules();
    await started.promise;
    const first = calls[0];
    const other = first === "survival" ? "legacy" : "survival";
    await backups.saveSchedule({ instanceId: first, intervalHours: 8, enabled: false });
    await backups.deleteSchedule(other);
    await backups.saveSchedule({ instanceId: "creative", intervalHours: 12 });
    gate.resolve();
    await run;
    let schedules = await byId();
    assert.deepStrictEqual(Object.keys(schedules).sort(), [first, "creative"].sort(), "a schedule deleted during the run stays deleted and one added stays added");
    assert.strictEqual(schedules[first].enabled, false, "a schedule disabled during its backup stays disabled");
    assert.strictEqual(schedules[first].intervalHours, 8, "an interval changed during the backup is kept");
    assert(Date.parse(schedules[first].nextRunAt) > Date.now(), "the edited schedule keeps its new next run");
    assert.strictEqual(schedules[first].lastError, null, "the finished backup is still recorded");
    assert(schedules[first].lastRunAt, "with its run time");
    assert.deepStrictEqual(calls, [first], "the schedule deleted before its turn is not backed up");

    // (b) Overlapping ticks back up each due schedule once.
    await backups.deleteSchedule(first);
    await backups.deleteSchedule("creative");
    await backups.saveSchedule({ instanceId: "alpha", intervalHours: 6, nextRunAt: past });
    await backups.saveSchedule({ instanceId: "beta", intervalHours: 6, nextRunAt: past });
    calls.length = 0;
    const gate2 = deferred();
    const busy = new Set();
    backups._test.setScheduledBackupRunner(async (request) => {
      if (busy.has(request.instanceId)) throw Object.assign(new Error("BACKUP_OPERATION_IN_PROGRESS"), { code: "BACKUP_OPERATION_IN_PROGRESS" });
      busy.add(request.instanceId);
      calls.push(request.instanceId);
      await gate2.promise;
      busy.delete(request.instanceId);
      return { backup: { id: `b-${request.instanceId}` } };
    });
    const tick1 = backups._test.runDueSchedules();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const tick2 = backups._test.runDueSchedules();
    await new Promise((resolve) => setTimeout(resolve, 50));
    gate2.resolve();
    await Promise.all([tick1, tick2]);
    assert.deepStrictEqual([...calls].sort(), ["alpha", "beta"], "each due schedule is backed up exactly once");
    schedules = await byId();
    for (const id of ["alpha", "beta"]) {
      assert.strictEqual(schedules[id].lastError, null, `${id} is not reported as failed`);
      assert(Date.parse(schedules[id].nextRunAt) > Date.now(), `${id} moves to its next run`);
    }

    // (c) A failed scheduled backup is still recorded and rescheduled.
    await backups.saveSchedule({ instanceId: "alpha", intervalHours: 6, nextRunAt: past });
    backups._test.setScheduledBackupRunner(async () => { throw Object.assign(new Error("disk"), { code: "BACKUP_DISK_FULL" }); });
    await backups._test.runDueSchedules();
    schedules = await byId();
    assert.strictEqual(schedules.alpha.lastError, "BACKUP_DISK_FULL", "a failed backup records its error");
    assert(Date.parse(schedules.alpha.nextRunAt) > Date.now(), "and is rescheduled");
    assert(Date.parse(schedules.beta.nextRunAt) > Date.now(), "a schedule that wasn't due is left alone");
  } finally {
    backups._test.setScheduledBackupRunner?.(null);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---- 3: SteamCMD update keeps concurrent settings ------------------------------------------

async function childSteamUpdate() {
  const root = tempRoot("steam");
  isolate(root);
  const instanceRoot = path.join(root, "instances");
  fs.mkdirSync(instanceRoot, { recursive: true });
  process.env.AGENT_PORT = "9";
  process.env.AGENT_INSTANCE_ROOT = instanceRoot;
  process.env.AGENT_BACKUP_ROOT = path.join(root, "backups");
  process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);
  const { EventEmitter } = require("events");
  const { PassThrough } = require("stream");
  const APP_ID = 896660;
  const ID = "steam-settings";
  const manifest = path.join(instanceRoot, ID, "data", "server", "steamapps", `appmanifest_${APP_ID}.acf`);
  const realSpawn = childProcess.spawn;
  childProcess.spawn = function fakeSpawn(command, ...rest) {
    if (command !== "FAKE-STEAMCMD") return realSpawn.call(this, command, ...rest);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.pid = 99999;
    child.kill = () => { child.killed = true; };
    setTimeout(() => {
      fs.writeFileSync(manifest, `"AppState"\n{\n\t"buildid"\t\t"42"\n}\n`);
      child.stdout.end(`Success! App '${APP_ID}' fully installed.\n`);
      child.stderr.end();
      setTimeout(() => child.emit("close", 0, null), 20);
    }, 30);
    return child;
  };
  const instanceService = require(path.join(REPO, "agent/src/services/instances/instanceService"));
  const core = require(path.join(REPO, "src/shared/instances/instanceServiceCore"));
  try {
    await instanceService.createInstance({ id: ID, displayName: "Old Name", type: "custom-command", executable: process.execPath, args: ["-e", "0"] });
    const configFile = path.join(instanceRoot, ID, "config.json");
    const created = JSON.parse(fs.readFileSync(configFile, "utf8"));
    fs.writeFileSync(configFile, JSON.stringify({ ...created, installerType: "steamcmd-native", steamAppId: APP_ID, steamInstallDir: "server" }, null, 2));
    fs.mkdirSync(path.dirname(manifest), { recursive: true });
    fs.writeFileSync(manifest, `"AppState"\n{\n\t"buildid"\t\t"41"\n}\n`);
    core._test.setSteamCmdExecutable("FAKE-STEAMCMD");
    const backupStarted = deferred();
    const backupGate = deferred();
    core.configureInstanceService({ createPreUpdateBackup: async () => { backupStarted.resolve(); await backupGate.promise; return { backup: { id: "pre-1", name: "Pre-update" } }; } });

    const session = await instanceService.beginSteamCmdUpdateSession(ID, { operationId: "state-durability-op1" });
    const update = instanceService.executeSteamCmdUpdate(ID, { operationId: "state-durability-op1", token: session.token, backupBeforeUpdate: true });
    await backupStarted.promise;
    await instanceService.updateInstance(ID, { displayName: "New Name", autoStart: true });
    backupGate.resolve();
    const result = await update;
    await instanceService.closeInstallationSession(ID, { operationId: "state-durability-op1", token: session.token }).catch(() => {});
    assert.strictEqual(result.ok, true, "the fake update succeeds");
    const after = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.strictEqual(after.displayName, "New Name", "a name saved during the update is kept");
    assert.strictEqual(after.autoStart, true, "Auto Start switched on during the update stays on");
    assert.strictEqual(String(after.steamBuildId), "42", "the update records the new build");
    assert.strictEqual(after.steamPreUpdateBackup?.id, "pre-1", "and its rollback point");
  } finally {
    childProcess.spawn = realSpawn;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---- 4: long-operation files ---------------------------------------------------------------

function loadLongOperations(role) {
  const longOperations = require(path.join(REPO, "src/shared/longOperationService.js"));
  // The Agent names its store at startup (agent/src/server.js); the desktop
  // keeps the default.
  if (role === "agent") {
    const configure = longOperations.configureOperationStore;
    if (typeof configure === "function") configure({ owner: "agent" });
  }
  return longOperations;
}

// The Agent: creates a running restore, flushes, waits, then updates and
// flushes again, as a long restore does.
async function childAgentOperations() {
  const longOperations = loadLongOperations("agent");
  longOperations.createOperation({ id: "agent-restore", type: "backup-restore", title: "Restore", status: "running" });
  longOperations._test.flushPersist();
  process.stdout.write(`ready ${longOperations.getOperationsStatePath()}\n`);
  await new Promise((resolve) => process.stdin.once("data", resolve));
  longOperations.updateOperation("agent-restore", { progress: 50, message: "Halfway" });
  longOperations._test.flushPersist();
  process.exit(0);
}

async function childDesktopOperations() {
  const longOperations = loadLongOperations("desktop");
  const seen = longOperations.listOperations().map((operation) => `${operation.id}:${operation.status}`);
  longOperations.createOperation({ id: "desktop-download", type: "marketplace-download", title: "Download", status: "running" });
  longOperations._test.flushPersist();
  process.stdout.write(`${JSON.stringify({ seen, statePath: longOperations.getOperationsStatePath() })}\n`);
}

async function checkLongOperationFiles() {
  const root = tempRoot("ops");
  const env = { ...process.env, AGENT_URL: "http://127.0.0.1:9", ANXHUB_CONFIG_DIR: path.join(root, "config"), ANXOS_LOG_DIR: path.join(root, "logs"), ANXOS_CONFIG_DIR: path.join(root, "anxos") };
  try {
    const agent = childProcess.spawn(process.execPath, [SELF, "--child", "agent-ops"], { env, stdio: ["pipe", "pipe", "inherit"] });
    let agentOut = "";
    const agentReady = new Promise((resolve, reject) => {
      agent.stdout.on("data", (chunk) => { agentOut += chunk; if (agentOut.includes("\n")) resolve(); });
      agent.once("exit", (code) => reject(new Error(`agent child exited early (${code})`)));
    });
    await agentReady;
    const agentStatePath = agentOut.trim().replace(/^ready /, "");
    const desktop = childProcess.spawnSync(process.execPath, [SELF, "--child", "desktop-ops"], { env, encoding: "utf8" });
    assert.strictEqual(desktop.status, 0, `desktop child failed: ${desktop.stderr}`);
    const desktopResult = JSON.parse(desktop.stdout.trim().split("\n").pop());
    const agentExit = new Promise((resolve) => agent.once("exit", resolve));
    agent.stdin.end("go\n");
    assert.strictEqual(await agentExit, 0, "agent child finished");

    assert.notStrictEqual(agentStatePath, desktopResult.statePath, "the Agent and the desktop keep separate files");
    assert.strictEqual(path.basename(desktopResult.statePath), "long-operations.json", "the desktop keeps its original file name");
    assert(!desktopResult.seen.some((entry) => entry.startsWith("agent-restore")), "the desktop doesn't load the Agent's running restore as interrupted");
    const desktopOps = JSON.parse(fs.readFileSync(desktopResult.statePath, "utf8")).operations;
    const agentOps = JSON.parse(fs.readFileSync(agentStatePath, "utf8")).operations;
    const desktopDownload = desktopOps.find((operation) => operation.id === "desktop-download");
    assert(desktopDownload && desktopDownload.status === "running", "the Agent's later write doesn't erase the desktop's download record");
    const agentRestore = agentOps.find((operation) => operation.id === "agent-restore");
    assert(agentRestore && agentRestore.status === "running" && agentRestore.progress === 50, "the Agent's restore record is intact and still running");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // The owner can only be chosen before the store is used, and must be a
  // plain name (it becomes part of a file name).
  const longOperations = require(path.join(REPO, "src/shared/longOperationService.js"));
  assert.strictEqual(typeof longOperations.configureOperationStore, "function", "the store owner can be configured");
  assert.throws(() => longOperations.configureOperationStore({ owner: "../escape" }), (error) => error.code === "OPERATION_STORE_OWNER_INVALID");
}

async function childStoreOwnerLocked() {
  const root = tempRoot("owner");
  isolate(root);
  try {
    const longOperations = require(path.join(REPO, "src/shared/longOperationService.js"));
    longOperations.listOperations();
    assert.strictEqual(longOperations.configureOperationStore({ owner: "agent" }), false, "a store already in use isn't switched to another file");
    assert.strictEqual(path.basename(longOperations.getOperationsStatePath()), "long-operations.json", "the file in use stays the same");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// ---- runner ----------------------------------------------------------------------------------

const CHILDREN = {
  "device-key": childDeviceKey,
  "host-fallback": childHostFallback,
  "backup-schedules": childBackupSchedules,
  "steam-update": childSteamUpdate,
  "agent-ops": childAgentOperations,
  "desktop-ops": childDesktopOperations,
  "store-owner": childStoreOwnerLocked,
};

function runChild(name) {
  const result = childProcess.spawnSync(process.execPath, [SELF, "--child", name], {
    env: { ...process.env, AGENT_URL: "http://127.0.0.1:9" },
    encoding: "utf8",
    timeout: 120000,
  });
  if (result.status !== 0) {
    throw new Error(`${name} failed:\n${(result.stderr || result.stdout || String(result.error || "")).trim()}`);
  }
}

async function main() {
  const childIndex = process.argv.indexOf("--child");
  if (childIndex !== -1) {
    const name = process.argv[childIndex + 1];
    await CHILDREN[name]();
    return;
  }
  const checks = [
    ["1 state-durability-1 device key is kept when unreadable", () => { runChild("device-key"); runChild("host-fallback"); }],
    ["2 state-durability-2 backup scheduler keeps concurrent schedule edits", () => runChild("backup-schedules")],
    ["3 state-durability-3 SteamCMD update keeps concurrent settings", () => runChild("steam-update")],
    ["4 state-durability-4 desktop and Agent keep separate long-operation files", async () => { await checkLongOperationFiles(); runChild("store-owner"); }],
  ];
  let failed = 0;
  for (const [label, check] of checks) {
    try {
      await check();
      console.log(`ok   ${label}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${label}\n${error.stack || error.message}`);
    }
  }
  console.log(`state-durability-hardening-smoke: ${checks.length - failed}/${checks.length} passed (${checks.length} checks)`);
  if (failed) process.exit(1);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
