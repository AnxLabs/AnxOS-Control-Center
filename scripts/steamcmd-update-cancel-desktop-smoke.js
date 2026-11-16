// The desktop's side of SteamCMD update Cancel (issue #53). An Agent before
// Build 213 acknowledges a Cancel sent before SteamCMD starts and then runs
// the update anyway, so the desktop must not offer one it can't honour.
// The real marketplaceInstallService with agentClient calls stubbed; every
// network call and child process is blocked.
//   D1 older Agent, before SteamCMD starts: Cancel is not offered and says
//      why; a cancel through the operation is refused, nothing is sent
//   D2 older Agent: a durable-job cancel is held, sent the moment SteamCMD
//      runs, and the update ends cancelled
//   D3 Build 213 Agent (cancelBeforeStart): Cancel is offered during the
//      backup and reaches the Agent at once
//   D4 older Agent: a held cancel the update outran is reported as finished,
//      never as cancelled
//   D5 the Download Manager's Cancel (marketplace:cancelDownload) refuses an
//      update that can't be cancelled yet instead of showing "cancelled"
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-steam-cancel-desktop-"));
const configDir = path.join(root, "config");
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, "agent.json"), `${JSON.stringify({ backendMode: "local", agentUrl: "http://127.0.0.1:9", agentToken: "", schemaVersion: 1 }, null, 2)}\n`);
Object.assign(process.env, {
  ANXHUB_CONFIG_DIR: configDir,
  ANXHUB_AGENT_CONFIG_PATH: path.join(configDir, "agent.json"),
  ANXOS_CONFIG_DIR: path.join(root, "anxos-config"),
  ANXOS_LOG_DIR: path.join(root, "logs"),
  AGENT_INSTANCE_ROOT: path.join(root, "instances"),
  AGENT_BACKUP_ROOT: path.join(root, "backups"),
  AGENT_TEMP_DIR: path.join(root, "tmp"),
  AGENT_LOG_DIR: path.join(root, "agent-logs"),
  AGENT_IDENTITY_PATH: path.join(root, "identity.json"),
  AGENT_URL: "http://127.0.0.1:9",
});
for (const key of ["ANXOS_CONFIG_DIR", "ANXOS_LOG_DIR", "AGENT_INSTANCE_ROOT", "AGENT_BACKUP_ROOT", "AGENT_TEMP_DIR", "AGENT_LOG_DIR"]) fs.mkdirSync(process.env[key], { recursive: true });

global.fetch = async (url) => { throw new Error(`blocked fetch ${url}`); };
for (const name of ["http", "https"]) {
  const mod = require(name);
  mod.request = () => { throw new Error(`blocked ${name}.request`); };
  mod.get = () => { throw new Error(`blocked ${name}.get`); };
}
const childProcess = require("child_process");
for (const fn of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[fn] = () => { throw new Error(`blocked ${fn}`); };
}
const quiet = () => {};
console.info = quiet; console.warn = quiet; console.debug = quiet;

const repo = path.resolve(__dirname, "..");
const jobLifecycle = require(path.join(repo, "src/shared/instances/jobLifecycle"));
jobLifecycle.configureJobLifecycle({ getRoot: () => path.join(process.env.AGENT_INSTANCE_ROOT, "jobs") });
const agentClient = require(path.join(repo, "src/services/agentClient"));
const marketplaceInstallService = require(path.join(repo, "src/services/marketplaceInstallService"));
const longOperations = require(path.join(repo, "src/shared/longOperationService"));
const marketplaceService = require(path.join(repo, "src/services/marketplaceService"));

function deferred() {
  let resolve; let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(check, label, timeoutMs = 8000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out: ${label}`);
}

let status = {};
let execution = deferred();
const cancels = [];
agentClient.repairLegacySteamCmdMetadata = async () => ({ repaired: false });
agentClient.beginSteamCmdUpdateSession = async (_id, payload) => ({ token: "t", operationId: payload.operationId });
agentClient.executeSteamCmdUpdate = () => execution.promise;
agentClient.getSteamCmdUpdateStatus = async () => ({ ...status });
agentClient.cancelInstallationSession = async (_id, proof) => { cancels.push(proof.operationId); return { cancelled: true }; };
agentClient.closeSteamCmdUpdateSession = async () => ({ closed: true });

function startUpdate(instanceId) {
  const run = marketplaceInstallService.updateSteamCmdInstance({ nodeId: "application-host", instanceId });
  run.catch(() => {});
  return run;
}

const operationFor = (instanceId) => longOperations.listOperations({}).find((entry) => entry.metadata?.instanceId === instanceId && entry.metadata?.type === "steamcmd-update");
const polled = async (instanceId, predicate, label) => waitFor(() => { const operation = operationFor(instanceId); return operation && predicate(operation) ? operation : null; }, label);
const jobFor = async (instanceId) => (await jobLifecycle.listJobs({ instanceId })).jobs.find((job) => !["succeeded", "failed", "cancelled"].includes(job.state));

async function main() {
  // D1
  status = { stage: "backup", label: "Backing up the server before the update...", running: false };
  execution = deferred();
  cancels.length = 0;
  const run1 = startUpdate("old-agent-1");
  const op1 = await polled("old-agent-1", (operation) => /Cancel is available once SteamCMD starts/.test(operation.message || ""), "waiting note");
  assert.strictEqual(op1.canCancel, false, "an older Agent's update can't be cancelled before SteamCMD starts");
  await assert.rejects(longOperations.cancelOperation(op1.id), (error) => error.code === "OPERATION_NOT_CANCELLABLE");
  assert.strictEqual(cancels.length, 0, "nothing is sent to the Agent");
  status = { stage: "downloading", label: "Downloading...", running: true };
  const op1b = await polled("old-agent-1", (operation) => operation.canCancel === true, "Cancel offered once SteamCMD runs");
  assert.ok(!/Cancel is available once/.test(op1b.message || ""));
  execution.resolve({ buildIdBefore: "41", buildIdAfter: "42", buildChanged: true });
  await run1;
  console.log("  ok D1 older Agent: no Cancel before SteamCMD starts (refused, nothing sent), offered once it runs");

  // D2
  status = { stage: "preparing", label: "Waiting for another SteamCMD task on this node...", running: false };
  execution = deferred();
  cancels.length = 0;
  const run2 = startUpdate("old-agent-2");
  await polled("old-agent-2", (operation) => operation.canCancel === false && /Waiting for another SteamCMD task/.test(operation.message || ""), "queued");
  const job2 = await waitFor(() => jobFor("old-agent-2"), "job record");
  await jobLifecycle.cancelJob(job2.jobId || job2.id, { reason: "smoke" });
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.strictEqual(cancels.length, 0, "the held cancel is not sent while the Agent would ignore it");
  status = { stage: "connecting", label: "Connecting to Steam...", running: true };
  await waitFor(() => cancels.length === 1, "held cancel sent once SteamCMD runs");
  execution.reject(Object.assign(new Error("cancelled"), { code: "STEAMCMD_UPDATE_CANCELLED" }));
  await assert.rejects(run2);
  assert.strictEqual(operationFor("old-agent-2").status, "cancelled");
  console.log("  ok D2 older Agent: a job cancel is held, sent when SteamCMD runs, and the update ends cancelled");

  // D3
  status = { stage: "backup", label: "Backing up the server before the update...", running: false, cancelBeforeStart: true };
  execution = deferred();
  cancels.length = 0;
  const run3 = startUpdate("new-agent-3");
  const op3 = await polled("new-agent-3", (operation) => operation.canCancel === true, "Cancel offered during backup");
  assert.ok(!/Cancel is available once/.test(op3.message || ""));
  await longOperations.cancelOperation(op3.id);
  await waitFor(() => cancels.length === 1, "cancel sent at once");
  execution.reject(Object.assign(new Error("cancelled"), { code: "STEAMCMD_UPDATE_CANCELLED" }));
  await assert.rejects(run3);
  console.log("  ok D3 Build 213 Agent: Cancel is offered during the backup and sent at once");

  // D4
  status = { stage: "backup", label: "Backing up the server before the update...", running: false };
  execution = deferred();
  cancels.length = 0;
  const run4 = startUpdate("old-agent-4");
  await polled("old-agent-4", (operation) => operation.canCancel === false && /Backing up/.test(operation.message || ""), "backup");
  const job4 = await waitFor(() => jobFor("old-agent-4"), "job record");
  await jobLifecycle.cancelJob(job4.jobId || job4.id, { reason: "smoke" });
  execution.resolve({ buildIdBefore: "41", buildIdAfter: "42", buildChanged: true });
  await run4.catch(() => {});
  const op4 = operationFor("old-agent-4");
  assert.strictEqual(cancels.length, 0);
  assert.notStrictEqual(op4.status, "cancelled", "an update that finished is never reported as cancelled");
  assert.match(op4.message || op4.metadata?.body || "", /finished before the cancel could stop it/);
  console.log("  ok D4 a held cancel the update outran is reported as finished, not cancelled");

  // D5
  status = { stage: "backup", label: "Backing up the server before the update...", running: false };
  execution = deferred();
  cancels.length = 0;
  const run5 = startUpdate("old-agent-5");
  const op5 = await polled("old-agent-5", (operation) => operation.canCancel === false && /Backing up/.test(operation.message || ""), "backup");
  assert.throws(() => marketplaceService.cancelDownload(op5.id, { nodeId: "application-host" }), (error) => error.code === "DOWNLOAD_NOT_CANCELLABLE");
  assert.notStrictEqual(operationFor("old-agent-5").status, "cancelled", "nothing is marked cancelled");
  assert.strictEqual(cancels.length, 0);
  status = { stage: "downloading", label: "Downloading...", running: true };
  const op5b = await polled("old-agent-5", (operation) => operation.canCancel === true, "Cancel offered once SteamCMD runs");
  marketplaceService.cancelDownload(op5b.id, { nodeId: "application-host" });
  await waitFor(() => cancels.length === 1, "cancel sent");
  execution.reject(Object.assign(new Error("cancelled"), { code: "STEAMCMD_UPDATE_CANCELLED" }));
  await assert.rejects(run5);
  console.log("  ok D5 Download Manager Cancel is refused before it can work, and works once SteamCMD runs");

  console.log("SteamCMD update cancel desktop smoke passed (5 cases).");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    process.exit(process.exitCode || 0);
  }, 200);
});
