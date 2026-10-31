// SteamCMD update polish: Steam branch selection, one SteamCMD run per node,
// update-aware player warnings, and the renderer's Check now / patch notes /
// list badge / failure toast wiring. Hermetic: SteamCMD is never spawned.
const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-steamcmd-polish-"));
process.env.AGENT_INSTANCE_ROOT = root;
const service = require("../src/shared/instances/instanceServiceCore");
service.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });
process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);
const scheduleService = require("../agent/src/services/restartScheduleService");

function appInfo(appId, branches) {
  const branchLines = Object.entries(branches).map(([name, buildId]) => `\t\t\t"${name}"\n\t\t\t{\n\t\t\t\t"buildid"\t\t"${buildId}"\n\t\t\t}`).join("\n");
  return `AppID : ${appId}\n"${appId}"\n{\n\t"depots"\n\t{\n\t\t"branches"\n\t\t{\n${branchLines}\n\t\t}\n\t}\n}\n`;
}

async function createSteamInstance(instanceId, appId, installedBuildId) {
  await service.createInstance({ id: instanceId, displayName: instanceId, type: "custom-command", executable: process.execPath, args: ["-e", "0"] });
  const configPath = path.join(root, instanceId, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, `${JSON.stringify({ ...config, installerType: "steamcmd-native", steamAppId: appId, steamInstallDir: "server" }, null, 2)}\n`);
  const manifest = path.join(root, instanceId, "data", "server", "steamapps", `appmanifest_${appId}.acf`);
  await fsp.mkdir(path.dirname(manifest), { recursive: true });
  await fsp.writeFile(manifest, `"AppState"\n{\n\t"buildid"\t\t"${installedBuildId}"\n}\n`);
}

async function branchChecks() {
  assert.deepStrictEqual(service.parseSteamCmdBranchBuildIds(appInfo(896660, { public: "10", "public-test": "12" }), 896660), { public: "10", "public-test": "12" });
  assert.strictEqual(service.parseSteamCmdLatestBuildId(appInfo(896660, { public: "10", "public-test": "12" }), 896660, "public-test"), "12");

  service._test.resetSteamBuildCheckCache();
  service._test.setSteamAppInfoRunner(async (config) => ({ exitCode: 0, stdout: appInfo(config.steamAppId, { public: "10", "public-test": "12" }) }));
  await createSteamInstance("valheim-branch", 896660, "10");
  let check = await service.checkSteamCmdBuildUpdate("valheim-branch");
  assert.deepStrictEqual({ branch: check.branch, latest: check.latestBuildId, available: check.updateAvailable }, { branch: "public", latest: "10", available: false });
  assert.deepStrictEqual(check.branches, ["public", "public-test"], "The check must list the branches Steam reports.");

  const saved = await service.setSteamCmdBranch("valheim-branch", { branch: "public-test" });
  assert.strictEqual(saved.steamBranch, "public-test");
  check = await service.checkSteamCmdBuildUpdate("valheim-branch");
  assert.deepStrictEqual({ branch: check.branch, latest: check.latestBuildId, available: check.updateAvailable }, { branch: "public-test", latest: "12", available: true }, "A selected beta compares against that branch's build.");

  await service.setSteamCmdBranch("valheim-branch", { branch: "gone-beta" });
  check = await service.checkSteamCmdBuildUpdate("valheim-branch");
  assert.strictEqual(check.error, "STEAMCMD_BRANCH_NOT_FOUND", "An unlisted branch must be reported, never compared against public.");
  assert.strictEqual(check.updateAvailable, null);

  const reset = await service.setSteamCmdBranch("valheim-branch", { branch: "public" });
  assert.strictEqual(reset.steamBranch, null, "Public is stored as the default, not as an explicit branch.");
  await assert.rejects(service.setSteamCmdBranch("valheim-branch", { branch: "bad branch;rm" }), (error) => error.code === "STEAMCMD_BRANCH_INVALID");
  await assert.rejects(service.setSteamCmdBranch("valheim-branch", { branch: "-beta" }), (error) => error.code === "STEAMCMD_BRANCH_INVALID", "A branch can never be parsed as a SteamCMD flag.");
}

async function lockChecks() {
  service._test.resetSteamBuildCheckCache();
  let active = 0;
  let peak = 0;
  service._test.setSteamAppInfoRunner(async (config) => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active -= 1;
    return { exitCode: 0, stdout: appInfo(config.steamAppId, { public: "5" }) };
  });
  await createSteamInstance("rust-lock", 258550, "5");
  await createSteamInstance("cs2-lock", 730, "5");
  await Promise.all([service.checkSteamCmdBuildUpdate("rust-lock"), service.checkSteamCmdBuildUpdate("cs2-lock"), service.checkSteamCmdBuildUpdate("valheim-branch")]);
  assert.strictEqual(peak, 1, "Only one SteamCMD process may run on a node at a time.");
}

async function warningChecks() {
  const scheduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-steamcmd-polish-schedules-"));
  const warns = [];
  let clockMs = Date.parse("2026-10-31T12:00:00Z");
  scheduleService.configureRestartScheduleService({
    root: scheduleRoot,
    now: () => clockMs,
    isInstanceRunning: async () => true,
    warnInstance: async (instanceId, message) => { warns.push({ instanceId, message }); },
    listInstanceJobs: async () => ({ jobs: [] }),
    restartInstance: async () => ({}),
    restartInstanceWithSteamUpdate: async () => ({ steamUpdate: { attempted: false, reason: "UP_TO_DATE" } }),
  });
  const auto = (await scheduleService.createRestartSchedule({ instanceId: "auto-warn", intervalHours: 1, warnMinutes: 5, autoUpdateSteam: true })).schedule;
  const plain = (await scheduleService.createRestartSchedule({ instanceId: "plain-warn", intervalHours: 1, warnMinutes: 5 })).schedule;
  clockMs = Date.parse(auto.nextRunAt) - 4 * 60 * 1000;
  await scheduleService.runDueSchedules();
  const autoWarn = warns.find((entry) => entry.instanceId === "auto-warn");
  const plainWarn = warns.find((entry) => entry.instanceId === "plain-warn");
  assert(autoWarn && /update if a new version is available/.test(autoWarn.message), "Auto-update schedules must tell players the restart may include an update.");
  assert.strictEqual(plainWarn?.message, "AnxOS scheduled restart in 5 minute(s).", "Plain schedules keep their established wording.");
  clockMs = Date.parse(plain.nextRunAt) + 1000;
  await scheduleService.runDueSchedules();
  await scheduleService.waitForSteamUpdateRestarts();
  await fsp.rm(scheduleRoot, { recursive: true, force: true });
}

function contractChecks() {
  // Normalised so the checks hold on CRLF (Windows autocrlf) checkouts too.
  const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const core = read("src/shared/instances/instanceServiceCore.js");
  const routes = read("agent/src/routes/instances.js");
  const ipc = read("src/ipc/instancesIpc.js");
  const preload = read("preload.js");
  const ui = read("app.js");
  const html = read("index.html");
  assert(core.includes('...betaArgs, "validate", "+quit"'), "Updates must pass the selected branch with -beta.");
  assert(core.includes("withSteamCmdLock(() => new Promise"), "Updates must wait for the per-node SteamCMD lock.");
  assert(core.includes("withSteamCmdLock(() => (steamAppInfoRunner || runSteamAppInfoPrint)(config))"), "Build lookups must take the per-node SteamCMD lock.");
  assert(routes.includes('"/steamcmd/branch"') && routes.includes('request.method === "POST" && steamBranchId'), "Branch selection is a POST (instance:write) Agent route.");
  assert(ipc.includes('"instances:setSteamBranch"') && ipc.includes('requirePermission("instance:write", payload.instanceId);\n    audit({ action: "instance.steamBranch.set"'));
  assert(preload.includes('setSteamBranch: (instanceId, branch, options = {}) => ipcRenderer.invoke("instances:setSteamBranch"'));
  assert(html.includes("data-steam-update-check hidden") && html.includes("data-steam-branch hidden") && html.includes("data-steam-update-notes"), "Check now, branch and patch notes controls sit with Update Server Files.");
  assert(html.includes('rel="noopener noreferrer"'), "The patch notes link opens externally without an opener.");
  assert(ui.includes("https://steamdb.info/patchnotes/${buildId}/") && ui.includes("/^\\d{1,20}$/.test(buildId)"), "Patch notes links are built only from a numeric build id.");
  assert(ui.includes("refreshSteamUpdateCheck(instance, { force: true, refresh: true })"), "Check now must force a fresh lookup.");
  assert(ui.includes('pill.className = "instance-tag--update"'), "Instance list rows show an update pill.");
  assert(ui.includes("announceScheduledSteamUpdateFailures(instance, restartSchedulesState.schedules)"), "Failed scheduled updates raise a toast.");
}

async function main() {
  await branchChecks();
  await lockChecks();
  await warningChecks();
  contractChecks();
  service._test.setSteamAppInfoRunner(null);
  await service.shutdownInstanceService({ timeoutMs: 2000 });
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  console.log("SteamCMD update polish smoke checks passed.");
}

main().catch(async (error) => {
  console.error(error);
  await service.shutdownInstanceService({ timeoutMs: 2000 }).catch(() => {});
  process.exit(1);
});
