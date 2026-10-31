// Scheduled SteamCMD update progress: the Agent exposes a read-only view of
// an update it is running (never the session token), instances report it as
// active, and the renderer mirrors it into the Download Manager until it
// finishes. Hermetic: SteamCMD is never spawned.
const assert = require("assert");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const vm = require("vm");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-scheduled-progress-"));
process.env.AGENT_INSTANCE_ROOT = root;
const service = require("../src/shared/instances/instanceServiceCore");
service.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });
process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);
const APP_ID = 2394010;

async function createSteamInstance(instanceId, buildId) {
  await service.createInstance({ id: instanceId, displayName: instanceId, type: "custom-command", executable: process.execPath, args: ["-e", "console.log('Server started'); setInterval(() => {}, 1000)"], startupTimeoutMs: 10000, shutdownTimeoutMs: 10000 });
  const configPath = path.join(root, instanceId, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, `${JSON.stringify({ ...config, installerType: "steamcmd-native", steamAppId: APP_ID, steamInstallDir: "server" }, null, 2)}\n`);
  await writeManifest(instanceId, buildId);
}

async function writeManifest(instanceId, buildId) {
  const manifest = path.join(root, instanceId, "data", "server", "steamapps", `appmanifest_${APP_ID}.acf`);
  await fsp.mkdir(path.dirname(manifest), { recursive: true });
  await fsp.writeFile(manifest, `"AppState"\n{\n\t"buildid"\t\t"${buildId}"\n}\n`);
}

async function agentChecks() {
  service._test.resetSteamBuildCheckCache();
  service._test.setSteamAppInfoRunner(async () => ({ exitCode: 0, stdout: `"${APP_ID}"\n{\n"depots"\n{\n"branches"\n{\n"public"\n{\n"buildid" "20"\n}\n}\n}\n}\n` }));
  await createSteamInstance("progress-smoke", "10");
  await service.startInstance("progress-smoke");

  const idle = service.getSteamCmdUpdateProgress("progress-smoke");
  assert.deepStrictEqual({ active: idle.active, running: idle.running, operationId: idle.operationId }, { active: null, running: false, operationId: null });

  let during = null;
  let statusDuring = null;
  let fail = false;
  service._test.setSteamCmdUpdateExecutor(async (id, request) => {
    during = service.getSteamCmdUpdateProgress(id);
    statusDuring = await service.getStatus(id);
    if (fail) throw Object.assign(new Error("STEAMCMD_NETWORK_UNAVAILABLE"), { code: "STEAMCMD_NETWORK_UNAVAILABLE", buildIdBefore: "20" });
    await writeManifest(id, "20");
    return { ok: true, buildIdBefore: "10", buildIdAfter: "20", buildChanged: true, operationId: request.operationId };
  });
  await service.restartInstanceWithSteamUpdate("progress-smoke");
  assert(during?.active?.scheduled && /^auto-update-/.test(during.active.operationId), "An Agent-run update is reported as active while it runs.");
  assert.strictEqual(during.operationId, during.active.operationId, "The progress view follows the running update session.");
  assert.strictEqual(during.active.latestBuildId, "20");
  assert(!JSON.stringify(during).includes("token"), "The progress view must never expose the update session token.");
  assert.strictEqual(statusDuring.steamUpdateActive?.operationId, during.active.operationId, "Instance status reports the active scheduled update.");

  const after = service.getSteamCmdUpdateProgress("progress-smoke");
  assert.strictEqual(after.active, null);
  assert.deepStrictEqual({ op: after.last.operationId, ok: after.last.ok, to: after.last.buildIdAfter }, { op: during.active.operationId, ok: true, to: "20" });
  assert.strictEqual((await service.getStatus("progress-smoke")).steamUpdateActive, null);

  service._test.resetSteamBuildCheckCache();
  service._test.setSteamAppInfoRunner(async () => ({ exitCode: 0, stdout: `"${APP_ID}"\n{\n"depots"\n{\n"branches"\n{\n"public"\n{\n"buildid" "30"\n}\n}\n}\n}\n` }));
  fail = true;
  await service.restartInstanceWithSteamUpdate("progress-smoke");
  const failed = service.getSteamCmdUpdateProgress("progress-smoke");
  assert.deepStrictEqual({ ok: failed.last.ok, code: failed.last.code, before: failed.last.buildIdBefore }, { ok: false, code: "STEAMCMD_NETWORK_UNAVAILABLE", before: "20" });
  await service.stopInstance("progress-smoke", { timeoutMs: 2000 });
}

function rendererChecks() {
  const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const start = source.indexOf("function applyScheduledSteamUpdateProgress(");
  const end = source.indexOf("async function pollScheduledSteamUpdates(");
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}\nthis.apply = applyScheduledSteamUpdateProgress;`, context);
  const entry = { id: "scheduled-steam-op1", operationId: "op1", status: "running", stage: "Preparing", progress: 0, logs: [] };
  let next = context.apply(entry, { active: { operationId: "op1" }, operationId: "op1", label: "Downloading update...", percent: 42, logs: [{ message: "x" }] });
  assert.deepStrictEqual({ status: next.status, stage: next.stage, progress: next.progress }, { status: "running", stage: "Downloading update...", progress: 42 });
  next = context.apply(entry, { active: { operationId: "op1" }, operationId: null });
  assert.strictEqual(next, entry, "Before the session exists the entry waits unchanged.");
  next = context.apply(entry, { active: null, last: { operationId: "op1", ok: true, buildIdAfter: "20" } });
  assert.deepStrictEqual({ status: next.status, progress: next.progress }, { status: "complete", progress: 100 });
  next = context.apply(entry, { active: null, last: { operationId: "op1", ok: false, code: "STEAMCMD_UPDATE_TIMEOUT", buildIdBefore: "10" } });
  assert.strictEqual(next.status, "failed");
  assert(/STEAMCMD_UPDATE_TIMEOUT/.test(next.body) && /build 10/.test(next.body), "A failed scheduled update says why and which build is running.");
  next = context.apply(entry, { active: null, last: { operationId: "other" } });
  assert.strictEqual(next.status, "complete", "A finished update with no matching record still leaves the running state.");

  assert(source.includes("[...marketplaceLocalDownloadEntries, ...scheduledSteamUpdateEntries, ...downloads]"), "Scheduled updates appear in the Download Manager.");
  assert(source.includes("syncScheduledSteamUpdates(instances);"), "Instance refreshes start tracking active scheduled updates.");
  const routes = fs.readFileSync("agent/src/routes/instances.js", "utf8");
  assert(routes.includes('request.method === "GET" && steamUpdateProgressId'), "Progress is a GET (instance:read) Agent route.");
  const ipc = fs.readFileSync("src/ipc/instancesIpc.js", "utf8");
  assert(ipc.includes('"instances:getSteamUpdateProgress"') && ipc.includes('requirePermission("instance:read", payload.instanceId); return getSteamCmdUpdateProgress'));
  assert(fs.readFileSync("preload.js", "utf8").includes('getSteamUpdateProgress: (instanceId, options = {}) => ipcRenderer.invoke("instances:getSteamUpdateProgress"'));
}

async function main() {
  await agentChecks();
  rendererChecks();
  service._test.setSteamAppInfoRunner(null);
  service._test.setSteamCmdUpdateExecutor(null);
  await service.shutdownInstanceService({ timeoutMs: 2000 });
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  console.log("Scheduled update progress smoke checks passed.");
}

main().catch(async (error) => {
  console.error(error);
  await service.shutdownInstanceService({ timeoutMs: 2000 }).catch(() => {});
  process.exit(1);
});
