// V2-F Wave 3: workload-consistent backup hooks with honest disclosure. Pins
// the stopped-consistency create path (game-server stop-before-backup through
// the canonical instance lifecycle), the reported best-effort restart, the
// already-stopped guard, and the crash-consistent disclosure metadata that
// backs the renderer note.
const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Pin the shared runtime roots BEFORE any src/ or agent service module loads
// so backup metadata and job records cannot leak into the real machine root.
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const root = pinAgentRoots("anx-backup-consistency-");
process.env.AGENT_BACKUP_ROOT = path.join(root, "backups");

const backupService = require("../agent/src/services/backupService");
const instanceService = require("../agent/src/services/instances/instanceService");
const { handleBackups } = require("../agent/src/routes/backups");

const lifecycleCalls = [];
const lifecycleStates = new Map();
let failNextStart = false;

function instanceDir(instanceId) {
  return path.join(process.env.AGENT_INSTANCE_ROOT, instanceId);
}

function stubInstanceLifecycle() {
  // backupService resolves the shared instance service object, so patching
  // these methods intercepts exactly the canonical lifecycle path the stopped
  // consistency flow must use.
  const getStatus = async (instanceId) => ({ ...(lifecycleStates.get(instanceId) || { state: "Stopped", pid: null }) });
  instanceService.getStatus = getStatus;
  instanceService.stopInstance = async (instanceId) => {
    lifecycleCalls.push({ method: "stop", instanceId });
    if (lifecycleStates.get(instanceId)?.state === "Running") {
      // The canonical stop leaves a marker behind so the archive can prove it
      // was created after the instance was quiesced.
      fs.writeFileSync(path.join(instanceDir(instanceId), "stopped-mid-backup.txt"), "quiesced\n");
      lifecycleStates.set(instanceId, { state: "Stopped", pid: null });
    }
    return { id: instanceId, state: "Stopped" };
  };
  instanceService.startInstance = async (instanceId) => {
    lifecycleCalls.push({ method: "start", instanceId });
    if (failNextStart) {
      throw Object.assign(new Error("INSTANCE_START_FAILED"), { code: "INSTANCE_START_FAILED" });
    }
    fs.rmSync(path.join(instanceDir(instanceId), "stopped-mid-backup.txt"), { force: true });
    lifecycleStates.set(instanceId, { state: "Running", pid: 4242 });
    return { id: instanceId, state: "Running" };
  };
}

function createInstanceDir(instanceId) {
  const instancePath = instanceDir(instanceId);
  fs.mkdirSync(instancePath, { recursive: true });
  fs.writeFileSync(path.join(instancePath, "config.json"), `${JSON.stringify({ id: instanceId, displayName: instanceId, state: "Stopped" }, null, 2)}\n`);
  fs.mkdirSync(path.join(instancePath, "data", "world"), { recursive: true });
  fs.writeFileSync(path.join(instancePath, "data", "world", "level.dat"), `${instanceId}-level`);
  return instancePath;
}

function readArchiveEntryNames(backup) {
  const archivePath = path.join(process.env.AGENT_BACKUP_ROOT, backup.archiveName);
  const parsed = backupService._test.parseTarEntries(fs.readFileSync(archivePath));
  return new Set(parsed.entries.map((entry) => entry.name));
}

function lifecycleMethodsFor(instanceId) {
  return lifecycleCalls.filter((call) => call.instanceId === instanceId).map((call) => call.method);
}

async function main() {
  stubInstanceLifecycle();

  // Crash consistency is the default and must stay byte-identical behavior:
  // a running instance is never stopped, the copy is disclosed as crash-
  // consistent, and the running flag is recorded honestly.
  const crashInstanceId = "smoke-consistency-crash";
  createInstanceDir(crashInstanceId);
  lifecycleStates.set(crashInstanceId, { state: "Running", pid: 1111 });
  const crashResult = await backupService.createBackup({ instanceId: crashInstanceId, type: "full", name: "crash", createdBy: "smoke" });
  assert.deepStrictEqual(lifecycleMethodsFor(crashInstanceId), [], "Crash-consistent (default) create must not stop or restart the running instance.");
  assert.strictEqual(crashResult.backup.consistency, "crash", "Default creates must disclose crash consistency.");
  assert.strictEqual(crashResult.backup.instanceWasRunning, true, "Crash metadata must honestly record that the instance was running.");
  assert.strictEqual(crashResult.backup.restartedAfterBackup, false, "Crash creates must never claim a restart happened.");
  assert.strictEqual(crashResult.backup.schemaVersion, backupService.BACKUP_METADATA_SCHEMA_VERSION, "Consistency disclosure must stay additive within metadata schema 1.");
  assert.deepStrictEqual(
    crashResult.restart,
    { attempted: false, restarted: false, errorCode: null, errorMessage: null },
    "Crash creates must report that no lifecycle restart was attempted.",
  );

  // An unobservable state must stay honest: recorded as unknown (null) instead
  // of guessed, without blocking the crash-consistent create.
  const unobservableInstanceId = "smoke-consistency-unobserv";
  createInstanceDir(unobservableInstanceId);
  const previousGetStatus = instanceService.getStatus;
  instanceService.getStatus = async (instanceId) => {
    if (instanceId === unobservableInstanceId) {
      throw Object.assign(new Error("INSTANCE_NOT_FOUND"), { code: "INSTANCE_NOT_FOUND" });
    }
    return previousGetStatus(instanceId);
  };
  const unobservableResult = await backupService.createBackup({ instanceId: unobservableInstanceId, type: "full", name: "unobservable", createdBy: "smoke" });
  assert.strictEqual(unobservableResult.backup.consistency, "crash");
  assert.strictEqual(unobservableResult.backup.instanceWasRunning, null, "An unobservable state must be recorded as unknown instead of guessed.");
  assert.strictEqual(unobservableResult.restart.attempted, false);

  // Stopped consistency: stop through the canonical path, create the archive
  // in the shortest possible stopped window, then restart through the
  // canonical start path exactly once.
  const stoppedInstanceId = "smoke-consistency-stopped";
  createInstanceDir(stoppedInstanceId);
  lifecycleStates.set(stoppedInstanceId, { state: "Running", pid: 2222 });
  const stoppedResult = await backupService.createBackup({ instanceId: stoppedInstanceId, type: "full", name: "stopped", createdBy: "smoke", consistency: "stopped" });
  assert.deepStrictEqual(
    lifecycleMethodsFor(stoppedInstanceId),
    ["stop", "start"],
    "Stopped consistency must stop through the canonical path, back up, and restart exactly once.",
  );
  assert(readArchiveEntryNames(stoppedResult.backup).has("stopped-mid-backup.txt"), "The archive must be created after the canonical stop (quiesce marker archived).");
  assert(!fs.existsSync(path.join(instanceDir(stoppedInstanceId), "stopped-mid-backup.txt")), "The canonical restart must run after the archive step (quiesce marker removed).");
  assert.strictEqual(stoppedResult.backup.consistency, "stopped", "Stopped creates must disclose stopped consistency.");
  assert.strictEqual(stoppedResult.backup.instanceWasRunning, true, "Stopped metadata must honestly record that the instance had been running.");
  assert.strictEqual(stoppedResult.backup.restartedAfterBackup, true, "A successful restart must be recorded.");
  assert.deepStrictEqual(stoppedResult.restart, { attempted: true, restarted: true, errorCode: null, errorMessage: null }, "Stopped creates must report the restart outcome.");
  assert.strictEqual(lifecycleStates.get(stoppedInstanceId).state, "Running", "The instance must be running again after a stopped-consistency backup.");

  // A failed restart is best-effort: the backup still completes, but the
  // failure is reported in the result and metadata instead of swallowed.
  const restartFailInstanceId = "smoke-consistency-restartfa";
  createInstanceDir(restartFailInstanceId);
  lifecycleStates.set(restartFailInstanceId, { state: "Running", pid: 3333 });
  failNextStart = true;
  let restartFailResult;
  try {
    restartFailResult = await backupService.createBackup({ instanceId: restartFailInstanceId, type: "full", name: "restart-fail", createdBy: "smoke", consistency: "stopped" });
  } finally {
    failNextStart = false;
  }
  assert.deepStrictEqual(lifecycleMethodsFor(restartFailInstanceId), ["stop", "start"], "A failed restart must still be attempted through the canonical path.");
  assert.strictEqual(restartFailResult.backup.status, "complete", "A restart failure must never fail the backup itself.");
  assert.strictEqual(restartFailResult.backup.restartedAfterBackup, false, "A failed restart must not be reported as restarted.");
  assert.deepStrictEqual(
    restartFailResult.backup.restartAfterBackupError,
    { code: "INSTANCE_START_FAILED", message: "INSTANCE_START_FAILED" },
    "A failed restart must be reported in the persisted metadata.",
  );
  assert.strictEqual(restartFailResult.restart.attempted, true);
  assert.strictEqual(restartFailResult.restart.restarted, false);
  assert.strictEqual(restartFailResult.restart.errorCode, "INSTANCE_START_FAILED", "The create result must report the restart failure code.");
  assert.strictEqual(lifecycleStates.get(restartFailInstanceId).state, "Stopped", "Honest final state: the stub start failed, so the instance stays down.");

  // An already-stopped instance is never stopped or restarted again.
  const alreadyStoppedInstanceId = "smoke-consistency-alreadyst";
  createInstanceDir(alreadyStoppedInstanceId);
  lifecycleStates.set(alreadyStoppedInstanceId, { state: "Stopped", pid: null });
  const alreadyStoppedResult = await backupService.createBackup({ instanceId: alreadyStoppedInstanceId, type: "full", name: "already-stopped", createdBy: "smoke", consistency: "stopped" });
  assert.deepStrictEqual(lifecycleMethodsFor(alreadyStoppedInstanceId), [], "An already-stopped instance must never be stopped or restarted for a stopped-consistency backup.");
  assert.strictEqual(alreadyStoppedResult.backup.instanceWasRunning, false);
  assert.strictEqual(alreadyStoppedResult.backup.restartedAfterBackup, false);
  assert.strictEqual(alreadyStoppedResult.restart.attempted, false);

  // Unknown consistency values fail loudly instead of silently downgrading,
  // and never touch the instance lifecycle.
  const invalidInstanceId = "smoke-consistency-invalid";
  await assert.rejects(
    () => backupService.createBackup({ instanceId: invalidInstanceId, type: "full", name: "invalid", createdBy: "smoke", consistency: "warm" }),
    (error) => error?.code === "INVALID_BACKUP_CONSISTENCY",
    "Unknown consistency values must fail loudly instead of silently downgrading.",
  );
  assert.deepStrictEqual(lifecycleMethodsFor(invalidInstanceId), [], "An invalid consistency request must not touch the instance lifecycle.");

  // Metadata fields persist to disk with the schema version unchanged.
  const persistedStopped = JSON.parse(fs.readFileSync(path.join(process.env.AGENT_BACKUP_ROOT, `${stoppedResult.backup.id}.json`), "utf8"));
  assert.strictEqual(persistedStopped.consistency, "stopped");
  assert.strictEqual(persistedStopped.instanceWasRunning, true);
  assert.strictEqual(persistedStopped.restartedAfterBackup, true);
  assert.strictEqual(persistedStopped.schemaVersion, backupService.BACKUP_METADATA_SCHEMA_VERSION, "Persisted consistency disclosure must stay within metadata schema 1.");

  // listBackups surfaces consistency per backup, including legacy metadata
  // written before this wave (which was crash-consistent by construction).
  const legacyId = "legacy-consistency-1a2b3c";
  fs.writeFileSync(
    path.join(process.env.AGENT_BACKUP_ROOT, `${legacyId}.json`),
    `${JSON.stringify({ schemaVersion: 1, id: legacyId, instanceId: crashInstanceId, createdAt: new Date().toISOString(), type: "full", status: "complete" }, null, 2)}\n`,
  );
  const listedForInstance = await backupService.listBackups({ instanceId: crashInstanceId });
  assert.strictEqual(listedForInstance.backups.find((backup) => backup.id === crashResult.backup.id)?.consistency, "crash");
  assert.strictEqual(
    listedForInstance.backups.find((backup) => backup.id === legacyId)?.consistency,
    "crash",
    "Legacy metadata must surface as crash-consistent instead of a blank value.",
  );
  const allListed = await backupService.listBackups();
  assert(
    allListed.backups.every((backup) => backup.consistency === "crash" || backup.consistency === "stopped"),
    "listBackups must surface a consistency value for every backup.",
  );
  assert.strictEqual(allListed.backups.find((backup) => backup.id === stoppedResult.backup.id)?.consistency, "stopped");

  // The REST create route accepts the consistency option end to end and
  // drives the same canonical stop/restart path.
  const routeInstanceId = "smoke-consistency-route";
  createInstanceDir(routeInstanceId);
  lifecycleStates.set(routeInstanceId, { state: "Running", pid: 5555 });
  const routeResponse = await handleBackups(
    { method: "POST", body: JSON.stringify({ instanceId: routeInstanceId, type: "full", name: "route", createdBy: "smoke", consistency: "stopped" }) },
    new URL("http://localhost/api/v1/backups"),
  );
  assert.strictEqual(routeResponse.statusCode, 201, "The REST create route must accept the consistency option.");
  assert.strictEqual(routeResponse.body.backup.consistency, "stopped", "The route response must disclose the stopped consistency.");
  assert.strictEqual(routeResponse.body.restart.attempted, true, "The route response must carry the restart report.");
  assert.deepStrictEqual(lifecycleMethodsFor(routeInstanceId), ["stop", "start"], "The REST route must drive the same canonical stop/restart path.");
  const invalidRouteResponse = await handleBackups(
    { method: "POST", body: JSON.stringify({ instanceId: routeInstanceId, consistency: "snapshot" }) },
    new URL("http://localhost/api/v1/backups"),
  );
  assert.strictEqual(invalidRouteResponse.statusCode, 400, "The route must reject unknown consistency values.");
  assert.strictEqual(invalidRouteResponse.body.error.code, "INVALID_BACKUP_CONSISTENCY");

  // Pin the renderer disclosure: the static crash-consistent note, the pause
  // checkbox that maps to consistency "stopped", and the reported restart
  // failure (the renderer cannot run under Node, so the source is pinned).
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  [
    "note: \"The server keeps running while a crash-consistent copy is taken.\",",
    "checkboxLabel: options.offerPause ? \"Pause server during backup\" : \"\",",
    "const { type, consistency } = await chooseBackupType(\"Create world-only backup?\", findInstance(targetInstanceId) || null, { offerPause: true });",
    "const { type } = await chooseBackupType(\"Schedule world-only backups?\", findInstance(instanceId) || null);",
    "close({ confirmed: true, checked: checkbox.checked });",
    "result?.restart?.attempted && result.restart.restarted === false",
  ].forEach((needle) => assert(appSource.includes(needle), `Backup consistency renderer pinning missing: ${needle}`));

  // External-start honesty (review P1-2): an INSTANCE_ALREADY_RUNNING restart
  // failure is re-reported as skipped (attempted:false), never as a failed
  // restart while the server is actually running.
  const skipped = await backupService._test.restartInstanceAfterBackup("restart-mapping-probe", {
    startInstance: async () => {
      const error = new Error("Instance is already running.");
      error.code = "INSTANCE_ALREADY_RUNNING";
      throw error;
    },
  });
  assert.strictEqual(skipped.attempted, false, "An externally-started instance must not be reported as a restart attempt.");
  assert.strictEqual(skipped.errorCode, "RESTART_SKIPPED_ALREADY_RUNNING", "The skip must carry its distinct code.");
  const restarted = await backupService._test.restartInstanceAfterBackup("restart-mapping-probe", {
    startInstance: async () => {},
  });
  assert.strictEqual(restarted.attempted && restarted.restarted, true, "A normal restart must still be reported as attempted+restarted.");

  fs.rmSync(root, { recursive: true, force: true });
  console.log("backup-consistency-smoke passed");
}

main().catch((error) => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  console.error(error);
  process.exit(1);
});
