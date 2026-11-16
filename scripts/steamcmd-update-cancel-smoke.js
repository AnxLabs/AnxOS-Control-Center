// SteamCMD update cancellation before SteamCMD starts (issue #53).
// A Cancel acknowledged while the pre-update backup runs, or while the update
// waits for another SteamCMD task, must stop the update: no spawn, no changed
// files, no "updated" record. Real Agent instance service on a temp tree;
// child_process.spawn is replaced for the fake SteamCMD path only (the fake
// child has no PID, so a kill can only reach the fake). No network, no real
// SteamCMD, no real servers.
//   C0 control: an uncancelled update spawns once and succeeds
//   C1 cancel during the backup: cancelled, 0 spawns, build unchanged
//   C2 cancel during a backup that then fails: still reported as cancelled
//   C3 cancel while queued behind another SteamCMD task: cancelled, 0 spawns
//   C4 control: cancel after spawn kills the child and reports cancelled
const assert = require("assert");
const childProcess = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-steam-cancel-"));
const instanceRoot = path.join(base, "instances");
fs.mkdirSync(instanceRoot, { recursive: true });
process.env.AGENT_INSTANCE_ROOT = instanceRoot;
process.env.AGENT_BACKUP_ROOT = path.join(base, "backups");
process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);

const instanceService = require("../agent/src/services/instances/instanceService");
const core = require("../src/shared/instances/instanceServiceCore");

const APP_ID = 896660;
const ID = "valheim-cancel";
const FAKE_STEAMCMD = path.join(base, "fake-steamcmd");
const manifestPath = path.join(instanceRoot, ID, "data", "server", "steamapps", `appmanifest_${APP_ID}.acf`);
const manifest = (build) => `"AppState"\n{\n\t"StateFlags"\t\t"4"\n\t"buildid"\t\t"${build}"\n}\n`;

// ---- fake SteamCMD --------------------------------------------------------
const spawned = [];
let childBehaviour = "succeed";
const realSpawn = childProcess.spawn;
childProcess.spawn = function spawn(command, args, options) {
  if (command !== FAKE_STEAMCMD) return realSpawn.call(this, command, args, options);
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.killed = 0;
  const finish = (code, signal) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code; child.signalCode = signal;
    child.emit("exit", code, signal);
    child.stdout.end(); child.stderr.end();
    child.emit("close", code, signal);
  };
  child.kill = () => { child.killed += 1; setImmediate(() => finish(null, "SIGKILL")); return true; };
  spawned.push(child);
  if (childBehaviour === "succeed") {
    setImmediate(async () => {
      await fsp.writeFile(manifestPath, manifest("42"));
      child.stdout.write(`Success! App '${APP_ID}' fully installed.\n`);
      finish(0, null);
    });
  }
  return child;
};

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(check, label, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out: ${label}`);
}

async function resetInstance() {
  await fsp.writeFile(manifestPath, manifest("41"));
}

async function savedBuild() {
  const config = JSON.parse(await fsp.readFile(path.join(instanceRoot, ID, "config.json"), "utf8"));
  return config.steamBuildId || null;
}

async function manifestBuild() {
  return (await fsp.readFile(manifestPath, "utf8")).match(/"buildid"\s+"(\d+)"/)[1];
}

async function stage(operationId, token) {
  return instanceService.getSteamCmdUpdateStatus(ID, { operationId, token }).catch(() => ({}));
}

async function main() {
  await instanceService.createInstance({ id: ID, displayName: ID, type: "custom-command", executable: process.execPath, args: ["-e", "0"] });
  const configPath = path.join(instanceRoot, ID, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, `${JSON.stringify({ ...config, installerType: "steamcmd-native", steamAppId: APP_ID, steamInstallDir: "server" }, null, 2)}\n`);
  await fsp.mkdir(path.dirname(manifestPath), { recursive: true });
  core._test.setSteamCmdExecutable(FAKE_STEAMCMD);

  // C0
  await resetInstance();
  childBehaviour = "succeed";
  const s0 = await instanceService.beginSteamCmdUpdateSession(ID, { operationId: "cancel-op0" });
  const ok = await instanceService.executeSteamCmdUpdate(ID, { operationId: "cancel-op0", token: s0.token });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(spawned.length, 1);
  assert.strictEqual(await savedBuild(), "42", "a successful update records its build");
  await instanceService.closeInstallationSession(ID, { operationId: "cancel-op0", token: s0.token }).catch(() => {});
  console.log("  ok C0 control: uncancelled update spawns once and records build 42");

  // C1
  await resetInstance();
  const config1 = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, `${JSON.stringify({ ...config1, steamBuildId: "41" }, null, 2)}\n`);
  spawned.length = 0;
  const backup = deferred();
  core.configureInstanceService({ createPreUpdateBackup: () => backup.promise });
  const s1 = await instanceService.beginSteamCmdUpdateSession(ID, { operationId: "cancel-op1" });
  const run1 = instanceService.executeSteamCmdUpdate(ID, { operationId: "cancel-op1", token: s1.token, backupBeforeUpdate: true });
  run1.catch(() => {});
  await waitFor(async () => (await stage("cancel-op1", s1.token)).stage === "backup", "backup stage");
  const ack1 = await instanceService.cancelInstallationSession(ID, { operationId: "cancel-op1", token: s1.token });
  assert.strictEqual(ack1.cancelled, true);
  backup.resolve({ backup: { id: "pre-update-1", name: "Pre-update backup build 41" } });
  await assert.rejects(run1, (error) => error.code === "STEAMCMD_UPDATE_CANCELLED", "an acknowledged cancel during the backup ends the update as cancelled");
  assert.strictEqual(spawned.length, 0, "SteamCMD never starts after a cancel during the backup");
  assert.strictEqual(await manifestBuild(), "41");
  assert.strictEqual(await savedBuild(), "41", "no updated build is recorded");
  console.log("  ok C1 cancel during the backup: cancelled, 0 spawns, build 41 kept");

  // C2
  spawned.length = 0;
  const failing = deferred();
  core.configureInstanceService({ createPreUpdateBackup: () => failing.promise });
  const s2 = await instanceService.beginSteamCmdUpdateSession(ID, { operationId: "cancel-op2" });
  const run2 = instanceService.executeSteamCmdUpdate(ID, { operationId: "cancel-op2", token: s2.token, backupBeforeUpdate: true });
  run2.catch(() => {});
  await waitFor(async () => (await stage("cancel-op2", s2.token)).stage === "backup", "backup stage");
  await instanceService.cancelInstallationSession(ID, { operationId: "cancel-op2", token: s2.token });
  failing.reject(Object.assign(new Error("BACKUP_ABORTED"), { code: "BACKUP_ABORTED" }));
  await assert.rejects(run2, (error) => error.code === "STEAMCMD_UPDATE_CANCELLED");
  assert.strictEqual(spawned.length, 0);
  console.log("  ok C2 a backup that fails after a cancel is still reported as cancelled");

  // C3
  core.configureInstanceService({ createPreUpdateBackup: () => Promise.resolve({ backup: { id: "unused" } }) });
  spawned.length = 0;
  core._test.resetSteamBuildCheckCache();
  const lookup = deferred();
  core._test.setSteamAppInfoRunner(() => lookup.promise);
  const holder = instanceService.checkSteamCmdBuildUpdate(ID, { refresh: true }).catch(() => null);
  const s3 = await instanceService.beginSteamCmdUpdateSession(ID, { operationId: "cancel-op3" });
  const run3 = instanceService.executeSteamCmdUpdate(ID, { operationId: "cancel-op3", token: s3.token });
  run3.catch(() => {});
  await waitFor(async () => /Waiting for another SteamCMD task/.test((await stage("cancel-op3", s3.token)).label || ""), "queued behind another SteamCMD task");
  const ack3 = await instanceService.cancelInstallationSession(ID, { operationId: "cancel-op3", token: s3.token });
  assert.strictEqual(ack3.cancelled, true);
  lookup.resolve({ exitCode: 0, stdout: `"${APP_ID}"\n{\n"depots"\n{\n"branches"\n{\n"public"\n{\n"buildid" "42"\n}\n}\n}\n}\n` });
  await holder;
  await assert.rejects(run3, (error) => error.code === "STEAMCMD_UPDATE_CANCELLED", "an acknowledged cancel while queued ends the update as cancelled");
  assert.strictEqual(spawned.length, 0, "SteamCMD never starts after a cancel while queued");
  assert.strictEqual(await manifestBuild(), "41");
  assert.strictEqual(await savedBuild(), "41");
  core._test.setSteamAppInfoRunner(null);
  console.log("  ok C3 cancel while queued: cancelled, 0 spawns, build 41 kept");

  // C4
  spawned.length = 0;
  childBehaviour = "hang";
  const s4 = await instanceService.beginSteamCmdUpdateSession(ID, { operationId: "cancel-op4" });
  const run4 = instanceService.executeSteamCmdUpdate(ID, { operationId: "cancel-op4", token: s4.token });
  run4.catch(() => {});
  await waitFor(() => spawned.length === 1, "SteamCMD started");
  await instanceService.cancelInstallationSession(ID, { operationId: "cancel-op4", token: s4.token });
  await assert.rejects(run4, (error) => error.code === "STEAMCMD_UPDATE_CANCELLED");
  assert.strictEqual(spawned[0].killed, 1, "the running SteamCMD is killed");
  console.log("  ok C4 control: cancel after spawn kills SteamCMD and reports cancelled");

  console.log("SteamCMD update cancel smoke passed (5 cases).");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  childProcess.spawn = realSpawn;
  setTimeout(() => {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch {}
    process.exit(process.exitCode || 0);
  }, 200);
});
