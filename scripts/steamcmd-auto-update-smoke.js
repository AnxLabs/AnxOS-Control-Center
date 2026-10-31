// SteamCMD update-available check + opt-in auto-update on scheduled restart.
// Hermetic: SteamCMD is never spawned. The app_info lookup and the SteamCMD
// execute step are replaced through test seams, while the instance lifecycle
// (a real Node workload), the update session and its stopped-state check, and
// the restart schedule tick all run for real.
const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-steamcmd-auto-update-"));
const service = require("../src/shared/instances/instanceServiceCore");
service.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });
process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);
// The schedule service loads the Agent config; keep it inside the temp root.
process.env.AGENT_INSTANCE_ROOT = root;

const scheduleService = require("../agent/src/services/restartScheduleService");

const APP_ID = 2394010;
const MINUTE_MS = 60 * 1000;

function appInfoOutput(buildId, appId = APP_ID) {
  return [
    "Redirecting stderr to '/home/steam/Steam/logs/stderr.txt'",
    "Logging in user 'anonymous' to Steam Public...OK",
    `AppID : ${appId}, change number : 27654321/0, last change : Wed Oct 29 2026`,
    `"${appId}"`,
    "{",
    '\t"common"',
    "\t{",
    '\t\t"name"\t\t"Palworld \\"Dedicated\\" Server"',
    "\t}",
    '\t"depots"',
    "\t{",
    '\t\t"2394012"',
    "\t\t{",
    '\t\t\t"buildid"\t\t"1"',
    '\t\t\t"manifests" { "public" { "gid" "123" } }',
    "\t\t}",
    '\t\t"branches"',
    "\t\t{",
    '\t\t\t"public"',
    "\t\t\t{",
    `\t\t\t\t"buildid"\t\t"${buildId}"`,
    '\t\t\t\t"timeupdated"\t\t"1761700000"',
    "\t\t\t}",
    '\t\t\t"beta"',
    "\t\t\t{",
    '\t\t\t\t"buildid"\t\t"999999"',
    "\t\t\t}",
    "\t\t}",
    "\t}",
    "}",
    '"unrelated"',
    "{ \"buildid\" \"5\" }",
  ].join("\n");
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function waitForRunning(instanceId) {
  let status = await service.getStatus(instanceId);
  for (let attempt = 0; attempt < 40 && status.processState !== service.INSTANCE_STATES.RUNNING; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    status = await service.getStatus(instanceId);
  }
  return status;
}

function manifestPath(instanceId) {
  return path.join(root, instanceId, "data", "server", "steamapps", `appmanifest_${APP_ID}.acf`);
}

async function writeManifest(instanceId, buildId) {
  await fsp.mkdir(path.dirname(manifestPath(instanceId)), { recursive: true });
  await fsp.writeFile(manifestPath(instanceId), `"AppState"\n{\n\t"appid"\t\t"${APP_ID}"\n\t"buildid"\t\t"${buildId}"\n}\n`);
}

async function createSteamInstance(instanceId) {
  await service.createInstance({
    id: instanceId,
    displayName: "SteamCMD Auto Update Smoke",
    type: "custom-command",
    executable: process.execPath,
    args: ["-e", "console.log('Server started'); setInterval(() => {}, 1000)"],
    startupTimeoutMs: 10000,
    shutdownTimeoutMs: 10000,
  });
  const configPath = path.join(root, instanceId, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, `${JSON.stringify({
    ...config,
    installerType: "steamcmd-native",
    steamAppId: APP_ID,
    steamInstallDir: "server",
  }, null, 2)}\n`);
}

function parsingChecks() {
  assert.strictEqual(service.parseSteamCmdLatestBuildId(appInfoOutput("20512345"), APP_ID), "20512345", "The public branch build must be read structurally from app_info_print.");
  assert.strictEqual(service.parseSteamCmdLatestBuildId(appInfoOutput("7"), 730), null, "Another app's section must never be read as this app's build.");
  assert.strictEqual(service.parseSteamCmdLatestBuildId("Logging in user 'anonymous' to Steam Public...FAILED", APP_ID), null);
  assert.strictEqual(service.parseSteamCmdLatestBuildId(appInfoOutput("not-a-build"), APP_ID), null, "Non-numeric build ids are rejected.");
  const tree = service._test.parseSteamKeyValues(appInfoOutput("1"), appInfoOutput("1").indexOf(`"${APP_ID}"`));
  assert.strictEqual(tree[String(APP_ID)].common.name, 'Palworld "Dedicated" Server', "Escaped quotes must be decoded.");
  assert.strictEqual(tree.unrelated, undefined, "Parsing must stop when the app section closes.");
}

async function buildCheckChecks() {
  const instanceId = "steam-check-smoke";
  await createSteamInstance(instanceId);
  let clockMs = Date.parse("2026-10-30T12:00:00Z");
  let latest = "200";
  let lookups = 0;
  let failNext = false;
  service._test.setSteamBuildCheckClock(() => clockMs);
  service._test.resetSteamBuildCheckCache();
  service._test.setSteamAppInfoRunner(async (config) => {
    lookups += 1;
    assert.strictEqual(config.steamAppId, APP_ID);
    if (failNext) {
      failNext = false;
      return { exitCode: 7, stdout: "Could not connect to Steam network" };
    }
    return { exitCode: 0, stdout: appInfoOutput(latest) };
  });

  let check = await service.checkSteamCmdBuildUpdate(instanceId);
  assert.strictEqual(check.installedBuildId, null);
  assert.strictEqual(check.updateAvailable, null, "An unknown installed build must not claim an update is available.");

  await writeManifest(instanceId, "100");
  check = await service.checkSteamCmdBuildUpdate(instanceId);
  assert.deepStrictEqual(
    { installed: check.installedBuildId, source: check.installedSource, latest: check.latestBuildId, available: check.updateAvailable, cached: check.cached },
    { installed: "100", source: "manifest", latest: "200", available: true, cached: true },
    "The cached public build must be compared with the installed manifest build.",
  );
  assert.strictEqual(lookups, 1, "The second check within the TTL must be served from cache.");

  check = await service.checkSteamCmdBuildUpdate(instanceId, { refresh: "1" });
  assert.strictEqual(lookups, 1, "A forced refresh within the per-app floor must not spawn SteamCMD again.");

  clockMs += 3 * MINUTE_MS;
  latest = "300";
  check = await service.checkSteamCmdBuildUpdate(instanceId, { refresh: "1" });
  assert.strictEqual(lookups, 2, "A forced refresh after the floor must run a fresh lookup.");
  assert.strictEqual(check.latestBuildId, "300");
  assert.strictEqual(check.cached, false);

  await Promise.all([
    (clockMs += 31 * MINUTE_MS, service.checkSteamCmdBuildUpdate(instanceId)),
    service.checkSteamCmdBuildUpdate(instanceId),
  ]);
  assert.strictEqual(lookups, 3, "Concurrent checks for one Steam app must share a single lookup.");

  clockMs += 31 * MINUTE_MS;
  failNext = true;
  check = await service.checkSteamCmdBuildUpdate(instanceId);
  assert.strictEqual(check.error, "STEAMCMD_NETWORK_UNAVAILABLE", "A failed lookup must report its classified cause.");
  assert.strictEqual(check.latestBuildId, "300", "A failed lookup must keep the last known good build.");
  check = await service.checkSteamCmdBuildUpdate(instanceId);
  assert.strictEqual(lookups, 4, "A failed lookup is cached briefly so Steam is not hammered.");

  await writeManifest(instanceId, "300");
  check = await service.checkSteamCmdBuildUpdate(instanceId);
  assert.strictEqual(check.updateAvailable, false, "A matching build means the server is up to date.");

  await fsp.rm(manifestPath(instanceId));
  const configPath = path.join(root, instanceId, "config.json");
  fs.writeFileSync(configPath, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(configPath, "utf8")), steamBuildId: "250" }, null, 2)}\n`);
  check = await service.checkSteamCmdBuildUpdate(instanceId);
  assert.strictEqual(check.installedSource, "config", "The verified build persisted after an update is the fallback.");
  assert.strictEqual(check.updateAvailable, true);

  await service.createInstance({ id: "plain-check-smoke", displayName: "Plain", type: "custom-command", executable: process.execPath, args: ["-e", "0"] });
  await assert.rejects(service.checkSteamCmdBuildUpdate("plain-check-smoke"), (error) => error.code === "STEAMCMD_UPDATE_UNSUPPORTED");
  return { setLatest: (value) => { latest = value; }, advance: (ms) => { clockMs += ms; } };
}

async function autoUpdateRestartChecks(clock) {
  const instanceId = "steam-restart-smoke";
  await createSteamInstance(instanceId);
  await writeManifest(instanceId, "400");
  const executions = [];
  let executorResult = null;
  service._test.setSteamCmdUpdateExecutor(async (id, request) => {
    const status = await service.getStatus(id);
    executions.push({ id, state: status.state, pid: status.pid, hasToken: Boolean(request.token) });
    if (executorResult instanceof Error) throw executorResult;
    await writeManifest(id, executorResult.buildIdAfter);
    return { ok: true, ...executorResult };
  });

  // Up to date: a plain restart, no SteamCMD execution.
  clock.setLatest("400");
  clock.advance(60 * MINUTE_MS);
  const first = await service.startInstance(instanceId);
  let outcome = await service.restartInstanceWithSteamUpdate(instanceId);
  assert.strictEqual(outcome.steamUpdate.attempted, false);
  assert.strictEqual(outcome.steamUpdate.reason, "UP_TO_DATE");
  assert.strictEqual(executions.length, 0, "No update may run when the installed build is current.");
  assert.strictEqual(alive(first.pid), false, "The scheduled restart must still replace the old process.");
  assert((await waitForRunning(instanceId)).processState === service.INSTANCE_STATES.RUNNING);
  assert(outcome.job?.type === "instance.restart", "The update-aware restart must be a durable instance.restart job.");

  // Update available and applied between stop and start.
  clock.setLatest("500");
  clock.advance(60 * MINUTE_MS);
  executorResult = { buildIdBefore: "400", buildIdAfter: "500", buildChanged: true };
  const beforeUpdate = await service.getStatus(instanceId);
  outcome = await service.restartInstanceWithSteamUpdate(instanceId);
  assert.strictEqual(executions.length, 1);
  assert.strictEqual(executions[0].state, service.INSTANCE_STATES.STOPPED, "SteamCMD must only run while the server is stopped.");
  assert(!executions[0].pid || !alive(executions[0].pid), "No server process may be alive during the update.");
  assert.strictEqual(executions[0].hasToken, true, "The update must go through an authorized update session.");
  assert.deepStrictEqual(
    { attempted: outcome.steamUpdate.attempted, ok: outcome.steamUpdate.ok, before: outcome.steamUpdate.buildIdBefore, after: outcome.steamUpdate.buildIdAfter },
    { attempted: true, ok: true, before: "400", after: "500" },
  );
  assert.strictEqual(alive(beforeUpdate.pid), false);
  assert((await waitForRunning(instanceId)).processState === service.INSTANCE_STATES.RUNNING, "The server must be started after a successful update.");
  const afterSuccess = await service.checkSteamCmdBuildUpdate(instanceId);
  assert.strictEqual(afterSuccess.updateAvailable, false, "The badge must clear once the new build is installed.");

  // Update available but failing: the server comes back on the old build.
  clock.setLatest("600");
  clock.advance(60 * MINUTE_MS);
  executorResult = Object.assign(new Error("STEAMCMD_UPDATE_TIMEOUT"), { code: "STEAMCMD_UPDATE_TIMEOUT", buildIdBefore: "500", buildIdAfter: "500" });
  outcome = await service.restartInstanceWithSteamUpdate(instanceId);
  assert.strictEqual(executions.length, 2);
  assert.deepStrictEqual(
    { attempted: outcome.steamUpdate.attempted, ok: outcome.steamUpdate.ok, code: outcome.steamUpdate.code, before: outcome.steamUpdate.buildIdBefore },
    { attempted: true, ok: false, code: "STEAMCMD_UPDATE_TIMEOUT", before: "500" },
    "A failed update must be reported with its cause.",
  );
  assert((await waitForRunning(instanceId)).processState === service.INSTANCE_STATES.RUNNING, "A failed update must still start the server on its old build.");
  const logs = fs.readFileSync(path.join(root, instanceId, "logs", "stderr.log"), "utf8");
  assert(logs.includes("Scheduled SteamCMD update failed (STEAMCMD_UPDATE_TIMEOUT)"), "The failure must be visible in the instance console log.");

  // Unknown latest build (lookup failure): plain restart, no update attempt.
  clock.advance(60 * MINUTE_MS);
  service._test.setSteamAppInfoRunner(async () => { throw Object.assign(new Error("STEAMCMD_MISSING"), { code: "STEAMCMD_MISSING" }); });
  service._test.resetSteamBuildCheckCache();
  outcome = await service.restartInstanceWithSteamUpdate(instanceId);
  assert.strictEqual(outcome.steamUpdate.attempted, false);
  assert.strictEqual(outcome.steamUpdate.reason, "STEAMCMD_MISSING");
  assert.strictEqual(executions.length, 2, "An unconfirmed build must never trigger an update.");
  await service.stopInstance(instanceId, { timeoutMs: 2000 });
}

async function scheduleChecks() {
  const scheduleRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-steamcmd-auto-update-schedules-"));
  const state = { clockMs: Date.parse("2026-10-30T12:00:00Z"), plainRestarts: 0, updateRestarts: 0, next: null };
  scheduleService.configureRestartScheduleService({
    root: scheduleRoot,
    now: () => state.clockMs,
    isInstanceRunning: async () => true,
    warnInstance: async () => ({ sent: true }),
    listInstanceJobs: async () => ({ jobs: [] }),
    restartInstance: async () => { state.plainRestarts += 1; return { state: "Running" }; },
    restartInstanceWithSteamUpdate: async () => { state.updateRestarts += 1; return { instance: { state: "Running" }, steamUpdate: state.next }; },
  });
  const { schedule } = await scheduleService.createRestartSchedule({ instanceId: "steam-schedule", intervalHours: 1, warnMinutes: 1 });
  assert.strictEqual(schedule.autoUpdateSteam, false, "Scheduled updates are opt-in.");
  let updated = (await scheduleService.updateRestartSchedule(schedule.id, { autoUpdateSteam: "yes" })).schedule;
  assert.strictEqual(updated.autoUpdateSteam, false, "Only an explicit true enables scheduled updates.");
  updated = (await scheduleService.updateRestartSchedule(schedule.id, { autoUpdateSteam: true })).schedule;
  assert.strictEqual(updated.autoUpdateSteam, true);
  updated = (await scheduleService.updateRestartSchedule(schedule.id, { warnMinutes: 2 })).schedule;
  assert.strictEqual(updated.autoUpdateSteam, true, "An unrelated edit must keep the auto-update choice.");
  assert.strictEqual(updated.nextRunAt, schedule.nextRunAt, "Toggling auto-update must not retime the schedule.");

  state.next = { attempted: true, ok: false, code: "STEAMCMD_UPDATE_TIMEOUT", buildIdBefore: "1" };
  state.clockMs = Date.parse(updated.nextRunAt) + 1000;
  await scheduleService.runDueSchedules();
  let stored = (await scheduleService.listRestartSchedules("steam-schedule")).schedules[0];
  assert.strictEqual(state.updateRestarts, 1);
  assert.strictEqual(state.plainRestarts, 0, "An auto-update schedule must use the update-aware restart.");
  assert.strictEqual(stored.lastError, "STEAM_AUTO_UPDATE_FAILED:STEAMCMD_UPDATE_TIMEOUT", "A failed scheduled update must be surfaced on the schedule.");
  assert.strictEqual(stored.lastSteamUpdate.code, "STEAMCMD_UPDATE_TIMEOUT");
  assert(stored.lastRunAt, "The restart still counts as run when only the update failed.");

  state.next = { attempted: true, ok: true, buildIdBefore: "1", buildIdAfter: "2" };
  state.clockMs = Date.parse(stored.nextRunAt) + 1000;
  await scheduleService.runDueSchedules();
  stored = (await scheduleService.listRestartSchedules("steam-schedule")).schedules[0];
  assert.strictEqual(stored.lastError, null, "A successful update clears the previous failure.");
  assert.strictEqual(stored.lastSteamUpdate.buildIdAfter, "2");

  await scheduleService.updateRestartSchedule(schedule.id, { autoUpdateSteam: false });
  state.clockMs = Date.parse(stored.nextRunAt) + 1000;
  await scheduleService.runDueSchedules();
  assert.strictEqual(state.plainRestarts, 1, "Disabling auto-update returns the schedule to a plain restart.");
  assert.strictEqual(state.updateRestarts, 2);
  await fsp.rm(scheduleRoot, { recursive: true, force: true });
}

function contractChecks() {
  const read = (file) => fs.readFileSync(file, "utf8");
  const core = read("src/shared/instances/instanceServiceCore.js");
  const routes = read("agent/src/routes/instances.js");
  const server = read("agent/src/server.js");
  const client = read("src/services/agentClient.js");
  const router = read("src/services/serviceRouter.js");
  const ipc = read("src/ipc/instancesIpc.js");
  const preload = read("preload.js");
  const ui = read("app.js");
  const html = read("index.html");
  assert(core.includes('"+app_info_update", "1", "+app_info_print"'), "The latest build must come from app_info_print.");
  const appInfoSource = core.slice(core.indexOf("async function runSteamAppInfoPrint"), core.indexOf("async function lookupSteamLatestBuild"));
  assert(appInfoSource.includes("shell: false"), "The build lookup must spawn SteamCMD without a shell.");
  assert(core.includes('checkSteamCmdBuildUpdate: refuseForServiceManaged("steamcmd-update", checkSteamCmdBuildUpdate)'));
  assert(core.includes("restartInstanceWithSteamUpdate: restartInstanceWithSteamUpdateJob"));
  assert(routes.includes('"/steamcmd/update/check"') && routes.includes('request.method === "GET" && steamUpdateCheckId'), "The check must be a GET (instance:read) Agent route.");
  assert(server.includes("isSteamBuildCheck"), "The Agent must allow the bounded build lookup to finish.");
  assert(client.includes("/steamcmd/update/check"));
  assert(router.includes("async function checkSteamCmdBuildUpdate"));
  assert(ipc.includes('"instances:checkSteamUpdate"') && ipc.includes('requirePermission("instance:read", payload.instanceId); return checkSteamCmdBuildUpdate'));
  assert(preload.includes('checkSteamUpdate: (instanceId, options = {}) => ipcRenderer.invoke("instances:checkSteamUpdate"'));
  assert(html.includes("data-steam-update-badge hidden"), "The badge must sit next to Update Server Files and start hidden.");
  assert(ui.includes("badge.hidden = check?.updateAvailable !== true"), "Only a confirmed newer build may show the badge.");
  assert(ui.includes("autoUpdateSteam"), "The restart schedule UI must expose the opt-in.");
}

async function main() {
  parsingChecks();
  const clock = await buildCheckChecks();
  await autoUpdateRestartChecks(clock);
  await scheduleChecks();
  contractChecks();
  service._test.setSteamAppInfoRunner(null);
  service._test.setSteamCmdUpdateExecutor(null);
  service._test.setSteamBuildCheckClock(null);
  await service.shutdownInstanceService({ timeoutMs: 2000 });
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  console.log("SteamCMD auto-update smoke checks passed.");
}

main().catch(async (error) => {
  console.error(error);
  await service.shutdownInstanceService({ timeoutMs: 2000 }).catch(() => {});
  process.exit(1);
});
