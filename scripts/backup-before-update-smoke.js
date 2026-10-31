// Backup before update: a SteamCMD update can take a full rollback backup of
// the stopped server first (the Agent's real backup service), a failed backup
// blocks the update, the rollback point is recorded on the instance, and
// scheduled updates back up by default. SteamCMD is pinned to a path that
// does not exist, so the update step runs up to the spawn and no further.
const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-backup-before-update-"));
const instanceRoot = path.join(base, "instances");
fs.mkdirSync(instanceRoot, { recursive: true });
process.env.AGENT_INSTANCE_ROOT = instanceRoot;
process.env.AGENT_BACKUP_ROOT = path.join(base, "backups");
process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);

const instanceService = require("../agent/src/services/instances/instanceService");
const backupService = require("../agent/src/services/backupService");
const scheduleService = require("../agent/src/services/restartScheduleService");
const APP_ID = 896660;

async function createSteamInstance(instanceId) {
  await instanceService.createInstance({ id: instanceId, displayName: instanceId, type: "custom-command", executable: process.execPath, args: ["-e", "0"] });
  const configPath = path.join(instanceRoot, instanceId, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, `${JSON.stringify({ ...config, installerType: "steamcmd-native", steamAppId: APP_ID, steamInstallDir: "server" }, null, 2)}\n`);
  const manifest = path.join(instanceRoot, instanceId, "data", "server", "steamapps", `appmanifest_${APP_ID}.acf`);
  await fsp.mkdir(path.dirname(manifest), { recursive: true });
  await fsp.writeFile(manifest, `"AppState"\n{\n\t"buildid"\t\t"41"\n}\n`);
  await fsp.writeFile(path.join(instanceRoot, instanceId, "data", "server", "valheim_server.x86_64"), "binary-v41");
}

async function preUpdateBackupChecks() {
  await createSteamInstance("valheim-backup");
  // A missing steamcmd fails the update at spawn: by then the backup has
  // already been taken, which is exactly the ordering under test.
  require("../src/shared/instances/instanceServiceCore")._test.setSteamCmdExecutable(path.join(base, "missing-steamcmd"));
  const session = await instanceService.beginSteamCmdUpdateSession("valheim-backup", { operationId: "backup-smoke-op1" });
  await assert.rejects(
    instanceService.executeSteamCmdUpdate("valheim-backup", { operationId: "backup-smoke-op1", token: session.token, backupBeforeUpdate: true }),
    (error) => ["STEAMCMD_MISSING", "STEAMCMD_SPAWN_FAILED", "STEAMCMD_PROCESS_ERROR"].includes(error.code),
  );
  await instanceService.closeInstallationSession("valheim-backup", { operationId: "backup-smoke-op1", token: session.token }).catch(() => {});
  const backups = (await backupService.listBackups({ instanceId: "valheim-backup" })).backups;
  assert.strictEqual(backups.length, 1, "A full backup is taken before SteamCMD starts.");
  assert.strictEqual(backups[0].reason, "pre-update", "The backup is labelled as a pre-update rollback point.");
  assert.strictEqual(backups[0].type, "full", "Rolling back binaries needs a full backup.");
  assert.strictEqual(backups[0].name, "Pre-update backup build 41");

  // Without a backup request nothing is backed up.
  const plain = await instanceService.beginSteamCmdUpdateSession("valheim-backup", { operationId: "backup-smoke-op2" });
  await assert.rejects(instanceService.executeSteamCmdUpdate("valheim-backup", { operationId: "backup-smoke-op2", token: plain.token }));
  await instanceService.closeInstallationSession("valheim-backup", { operationId: "backup-smoke-op2", token: plain.token }).catch(() => {});
  assert.strictEqual((await backupService.listBackups({ instanceId: "valheim-backup" })).backups.length, 1, "No backup unless asked.");
}

async function failedBackupBlocksUpdate() {
  const core = require("../src/shared/instances/instanceServiceCore");
  let spawnedAfterFailure = false;
  core.configureInstanceService({ createPreUpdateBackup: async () => { throw Object.assign(new Error("BACKUP_DISK_SPACE_INSUFFICIENT"), { code: "BACKUP_DISK_SPACE_INSUFFICIENT" }); } });
  const session = await instanceService.beginSteamCmdUpdateSession("valheim-backup", { operationId: "backup-smoke-op3" });
  const progressBefore = (await instanceService.getSteamCmdUpdateStatus("valheim-backup", { operationId: "backup-smoke-op3", token: session.token }));
  await assert.rejects(
    instanceService.executeSteamCmdUpdate("valheim-backup", { operationId: "backup-smoke-op3", token: session.token, backupBeforeUpdate: true }),
    (error) => {
      spawnedAfterFailure = /STEAMCMD_MISSING|SPAWN/.test(error.code);
      return error.code === "STEAMCMD_PRE_UPDATE_BACKUP_FAILED" && error.causeCode === "BACKUP_DISK_SPACE_INSUFFICIENT";
    },
    "A failed backup must stop the update before SteamCMD runs.",
  );
  assert.strictEqual(spawnedAfterFailure, false);
  assert.strictEqual(progressBefore.stage, "preparing");
  await instanceService.closeInstallationSession("valheim-backup", { operationId: "backup-smoke-op3", token: session.token }).catch(() => {});
  // Restore the real provider for anything that follows.
  core.configureInstanceService({ createPreUpdateBackup: (instanceId, { buildIdBefore } = {}) => backupService.createBackup({ instanceId, type: "full", consistency: "crash", name: `Pre-update backup build ${buildIdBefore || "unknown"}`, createdBy: "steamcmd-update", reason: "pre-update" }) });
}

async function rollbackPointChecks() {
  const core = require("../src/shared/instances/instanceServiceCore");
  core._test.resetSteamBuildCheckCache();
  core._test.setSteamAppInfoRunner(async () => ({ exitCode: 0, stdout: `"${APP_ID}"\n{\n"depots"\n{\n"branches"\n{\n"public"\n{\n"buildid" "42"\n}\n}\n}\n}\n` }));
  let received = null;
  core._test.setSteamCmdUpdateExecutor(async (id, request) => {
    received = request;
    return { ok: true, buildIdBefore: "41", buildIdAfter: "42", buildChanged: true, preUpdateBackup: { id: "valheim-backup-1", name: "Pre-update backup build 41" } };
  });
  const outcome = await instanceService.restartInstanceWithSteamUpdate("valheim-backup", { backupBeforeUpdate: true });
  assert.strictEqual(received.backupBeforeUpdate, true, "A scheduled update passes the backup request to the update step.");
  assert.strictEqual(outcome.steamUpdate.preUpdateBackupId, "valheim-backup-1", "The scheduled outcome names its rollback point.");
  await instanceService.stopInstance("valheim-backup", { timeoutMs: 2000 }).catch(() => {});
  core._test.setSteamCmdUpdateExecutor(null);
  core._test.setSteamAppInfoRunner(null);
}

async function scheduleDefaults() {
  const scheduleRoot = path.join(base, "schedules");
  let received = null;
  let clockMs = Date.parse("2026-10-31T12:00:00Z");
  scheduleService.configureRestartScheduleService({
    root: scheduleRoot,
    now: () => clockMs,
    isInstanceRunning: async () => true,
    warnInstance: async () => {},
    listInstanceJobs: async () => ({ jobs: [] }),
    restartInstance: async () => ({}),
    restartInstanceWithSteamUpdate: async (instanceId, options) => { received = options; return { steamUpdate: { attempted: false, reason: "UP_TO_DATE" } }; },
  });
  const created = (await scheduleService.createRestartSchedule({ instanceId: "valheim-backup", intervalHours: 1, warnMinutes: 1, autoUpdateSteam: true })).schedule;
  assert.strictEqual(created.backupBeforeUpdate, true, "Scheduled updates back up first by default.");
  clockMs = Date.parse(created.nextRunAt) + 1000;
  await scheduleService.runDueSchedules();
  await scheduleService.waitForSteamUpdateRestarts?.();
  assert.deepStrictEqual(received, { backupBeforeUpdate: true });
  const off = (await scheduleService.updateRestartSchedule(created.id, { backupBeforeUpdate: false })).schedule;
  assert.strictEqual(off.backupBeforeUpdate, false);
  assert.strictEqual((await scheduleService.updateRestartSchedule(created.id, { warnMinutes: 2 })).schedule.backupBeforeUpdate, false, "An unrelated edit keeps the choice.");
}

function contractChecks() {
  // Normalised so the checks hold on CRLF (Windows autocrlf) checkouts too.
  const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const ui = read("app.js");
  const ipc = read("src/ipc/marketplaceIpc.js");
  const install = read("src/services/marketplaceInstallService.js");
  const server = read("agent/src/server.js");
  assert(ui.includes('checkboxLabel: "Back up the server first so this update can be rolled back (uses disk space)",\n        checkboxChecked: true,'), "The manual update offers a backup, checked by default.");
  assert(ui.includes("backupBeforeUpdate: steamBackupBeforeUpdate"), "The choice reaches the update request.");
  assert(ipc.includes("backupBeforeUpdate: payload.backupBeforeUpdate === true"));
  assert(install.includes("backupBeforeUpdate: payload.backupBeforeUpdate === true }, agentConfig)"));
  assert(server.includes("31 * 60 * 1000") && server.includes("11 * 60 * 1000"), "The Agent gives SteamCMD updates time for a backup; other installers keep 11 minutes.");
  assert(ui.includes("restoreSelectedBackup({ id: rollback.id"), "Roll Back Update restores through the normal restore flow.");
  assert(read("index.html").includes("data-steam-rollback hidden disabled"));
}

async function main() {
  await preUpdateBackupChecks();
  await failedBackupBlocksUpdate();
  await rollbackPointChecks();
  await scheduleDefaults();
  contractChecks();
  await instanceService.shutdownInstanceService({ timeoutMs: 2000 }).catch(() => {});
  await fsp.rm(base, { recursive: true, force: true }).catch(() => {});
  console.log("Backup before update smoke checks passed.");
}

main().catch(async (error) => {
  console.error(error);
  await instanceService.shutdownInstanceService({ timeoutMs: 2000 }).catch(() => {});
  process.exit(1);
});
