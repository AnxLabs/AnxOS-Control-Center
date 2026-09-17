// V2-F Wave 4: restore targeting and preview. Pins the read-only restore
// preview (byte-compared: no stop, no snapshot, no wipe, no operation lock),
// the three conflict verdicts (overwrite / new-restore / would-stop warning),
// same-instance restore regression, cross-instance restore that moves data to
// the target without ever touching the source, the running-target
// stop/restore/restart discipline, refusal without confirmOverwrite, the
// target registration guard, and target-side rollback on a mid-mutation
// failure.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Pin the shared runtime roots BEFORE any src/ or agent service module loads
// so backup metadata and job records cannot leak into the real machine root.
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const root = pinAgentRoots("anx-restore-targeting-");
process.env.AGENT_BACKUP_ROOT = path.join(root, "backups");

const backupService = require("../agent/src/services/backupService");
const instanceService = require("../agent/src/services/instances/instanceService");
const { handleBackups } = require("../agent/src/routes/backups");
const longOperations = require("../src/shared/longOperationService");

const SOURCE_ID = "restore-target-src";
const TARGET_ID = "restore-target-dst";
const WORLDLESS_ID = "restore-target-noworld";
const GHOST_ID = "restore-target-ghost";

const lifecycleCalls = [];
const lifecycleStates = new Map();
const stopFailures = new Set();

function instanceDir(instanceId) {
  return path.join(process.env.AGENT_INSTANCE_ROOT, instanceId);
}

function stubInstanceLifecycle() {
  // backupService resolves the shared instance service object, so patching
  // these methods intercepts exactly the canonical lifecycle path the restore
  // flow must use. Unknown instances are unregistered, mirroring the real
  // INSTANCE_NOT_FOUND an absent config.json produces.
  instanceService.getStatus = async (instanceId) => {
    if (!lifecycleStates.has(instanceId)) {
      throw Object.assign(new Error("INSTANCE_NOT_FOUND"), { code: "INSTANCE_NOT_FOUND" });
    }
    return { ...lifecycleStates.get(instanceId) };
  };
  instanceService.stopInstance = async (instanceId) => {
    lifecycleCalls.push({ method: "stop", instanceId });
    if (stopFailures.has(instanceId)) {
      throw Object.assign(new Error("INSTANCE_STOP_TIMEOUT"), { code: "INSTANCE_STOP_TIMEOUT" });
    }
    if (lifecycleStates.get(instanceId)?.state === "Running") {
      lifecycleStates.set(instanceId, { state: "Stopped", pid: null });
    }
    return { id: instanceId, state: "Stopped" };
  };
  instanceService.startInstance = async (instanceId) => {
    lifecycleCalls.push({ method: "start", instanceId });
    lifecycleStates.set(instanceId, { state: "Running", pid: 4242 });
    return { id: instanceId, state: "Running" };
  };
}

function createInstanceDir(instanceId, config) {
  const instancePath = instanceDir(instanceId);
  fs.mkdirSync(instancePath, { recursive: true });
  fs.mkdirSync(path.join(instancePath, "data", "world"), { recursive: true });
  fs.writeFileSync(path.join(instancePath, "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(instancePath, "data", "world", "level.dat"), `${instanceId}-level`);
  lifecycleStates.set(instanceId, { state: "Stopped", pid: null });
  return instancePath;
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function snapshotTree(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return null;
  }
  const files = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.set(path.relative(rootDir, fullPath).split(path.sep).join("/"), sha256Buffer(fs.readFileSync(fullPath)));
      }
    }
  };
  walk(rootDir);
  return files;
}

function backupRootSnapshot() {
  return snapshotTree(process.env.AGENT_BACKUP_ROOT);
}

function assertTreeUnchanged(label, before, after) {
  assert.deepStrictEqual(after, before, `${label} must remain byte-identical.`);
}

function lifecycleMethodsFor(instanceId, fromIndex = 0) {
  return lifecycleCalls.slice(fromIndex).filter((call) => call.instanceId === instanceId).map((call) => call.method);
}

function readRestoredWorld(instanceId) {
  return fs.readFileSync(path.join(instanceDir(instanceId), "data", "world", "level.dat"), "utf8");
}

async function main() {
  stubInstanceLifecycle();

  // Source carries a stale runtime claim in its record on purpose: a full
  // cross-instance restore must rebrand the restored record to the target and
  // must not adopt the stale pid as live.
  const sourcePath = createInstanceDir(SOURCE_ID, {
    id: SOURCE_ID,
    displayName: "Restore Source",
    state: "Running",
    pid: 4321,
    runtimeProcess: { pid: 4321 },
  });
  createInstanceDir(TARGET_ID, { id: TARGET_ID, displayName: "Restore Target", state: "Stopped" });
  // Registered target without any world directory: exercises the safety-scope
  // fallback for world-scope restores into a fresh target.
  fs.mkdirSync(instanceDir(WORLDLESS_ID), { recursive: true });
  fs.writeFileSync(path.join(instanceDir(WORLDLESS_ID), "config.json"), `${JSON.stringify({ id: WORLDLESS_ID, displayName: "No World Target", state: "Stopped" }, null, 2)}\n`);
  lifecycleStates.set(WORLDLESS_ID, { state: "Stopped", pid: null });

  const worldBackup = (await backupService.createBackup({ instanceId: SOURCE_ID, type: "world", name: "src world", createdBy: "smoke" })).backup;
  const fullBackup = (await backupService.createBackup({ instanceId: SOURCE_ID, type: "full", name: "src full", createdBy: "smoke" })).backup;
  assert(worldBackup.archiveSha256 && fullBackup.archiveSha256, "Fixture check: created backups must carry create-time digests.");

  // 1. Preview (same instance, dry run) must be genuinely read-only: no stop,
  // no snapshot, no wipe, and no long-operation lock record.
  const baseline = {
    source: snapshotTree(sourcePath),
    target: snapshotTree(instanceDir(TARGET_ID)),
    worldless: snapshotTree(instanceDir(WORLDLESS_ID)),
    backups: backupRootSnapshot(),
  };
  const previewSame = await backupService.restoreBackup({ backupId: worldBackup.id, preview: true });
  assert.strictEqual(previewSame.preview, true, "Preview must be flagged as a dry-run result.");
  assert.strictEqual(previewSame.backup.id, worldBackup.id, "Preview must report the backup it would restore.");
  assert.strictEqual(previewSame.backup.archiveSha256, worldBackup.archiveSha256, "Preview metadata must expose the archive digest.");
  assert.strictEqual(previewSame.target.instanceId, SOURCE_ID, "Preview must resolve the default target to the backup's own instance.");
  assert.strictEqual(previewSame.target.sameInstance, true, "Same-instance preview must report overwrite semantics.");
  assert.strictEqual(previewSame.target.registered, true, "Preview must report a registered target.");
  assert.strictEqual(previewSame.target.running, false, "Preview must report the target running state.");
  assert.strictEqual(previewSame.conflict.verdict, "overwrite", "target == source instance must report overwrite verdict.");
  assert.strictEqual(previewSame.conflict.requiresConfirmation, true, "Preview must state that a real restore needs confirmation.");
  assert.strictEqual(previewSame.conflict.confirmed, false, "Preview without confirmOverwrite must report unconfirmed.");
  assert.deepStrictEqual(previewSame.conflict.warnings, [], "A stopped same-instance target must produce no warnings.");
  assert.strictEqual(previewSame.scope.type, "world");
  assert.strictEqual(previewSame.scope.willWipeWholeInstance, false, "World-scope preview must not claim a whole-instance wipe.");
  assert(previewSame.scope.backupSourcePaths.includes("data/world"), "Preview must report the backup's own source paths.");
  assert.deepStrictEqual(longOperations.listOperations({ kind: "backup-restore" }), [], "Preview must never acquire the restore operation lock.");
  assertTreeUnchanged("source instance after same-instance preview", baseline.source, snapshotTree(sourcePath));
  assertTreeUnchanged("target instance after same-instance preview", baseline.target, snapshotTree(instanceDir(TARGET_ID)));
  assertTreeUnchanged("backup root after same-instance preview", baseline.backups, backupRootSnapshot());

  // 2. Cross-instance preview reports new-restore semantics and stays
  // read-only on BOTH instances.
  const previewCross = await backupService.restoreBackup({ backupId: worldBackup.id, preview: true, targetInstanceId: TARGET_ID });
  assert.strictEqual(previewCross.preview, true);
  assert.strictEqual(previewCross.target.instanceId, TARGET_ID);
  assert.strictEqual(previewCross.target.sameInstance, false);
  assert.strictEqual(previewCross.target.registered, true);
  assert.strictEqual(previewCross.conflict.verdict, "new-restore", "target != source instance must report new-restore verdict.");
  assert.deepStrictEqual(previewCross.conflict.warnings, [], "A stopped cross-instance target must produce no warnings.");
  assertTreeUnchanged("source instance after cross preview", baseline.source, snapshotTree(sourcePath));
  assertTreeUnchanged("target instance after cross preview", baseline.target, snapshotTree(instanceDir(TARGET_ID)));
  assertTreeUnchanged("backup root after cross preview", baseline.backups, backupRootSnapshot());

  // 3a. A running target must surface the would-stop warning without being
  // stopped by the preview.
  lifecycleStates.set(TARGET_ID, { state: "Running", pid: 7777 });
  const previewRunning = await backupService.restoreBackup({ backupId: worldBackup.id, preview: true, targetInstanceId: TARGET_ID });
  assert.strictEqual(previewRunning.target.running, true, "Preview must report a running target.");
  assert(previewRunning.conflict.warnings.includes("RESTORE_TARGET_RUNNING"), "Preview must warn that a running target would be stopped.");
  assert.deepStrictEqual(lifecycleMethodsFor(TARGET_ID), [], "Preview must never stop the running target.");
  lifecycleStates.set(TARGET_ID, { state: "Stopped", pid: null });

  // 3b. A missing target is reported, not thrown: preview exists to show the
  // operator why a restore would be refused.
  const previewGhost = await backupService.restoreBackup({ backupId: worldBackup.id, preview: true, targetInstanceId: GHOST_ID });
  assert.strictEqual(previewGhost.target.registered, false, "Preview must report an unregistered target.");
  assert.strictEqual(previewGhost.target.exists, false, "Preview must report that the target directory does not exist.");
  assert(previewGhost.conflict.warnings.includes("RESTORE_TARGET_INSTANCE_MISSING"), "Preview must warn about a missing target.");
  assert.strictEqual(previewGhost.conflict.verdict, "new-restore");

  // 3c. A registered target without world directories: preview reports the
  // world-scope miss and the widened full-scope safety snapshot.
  const previewWorldless = await backupService.restoreBackup({ backupId: worldBackup.id, preview: true, targetInstanceId: WORLDLESS_ID });
  assert.strictEqual(previewWorldless.scope.worldScopeError, "WORLD_PATH_NOT_FOUND", "Preview must disclose the missing target world scope.");
  assert.strictEqual(previewWorldless.scope.safetyType, "full", "Missing world scope must widen the safety snapshot to the whole target.");
  assert.deepStrictEqual(previewWorldless.scope.safetySourcePaths, ["."]);
  assert(previewWorldless.conflict.warnings.includes("RESTORE_TARGET_WORLD_SCOPE_MISSING"), "Preview must warn about the widened safety snapshot.");
  assertTreeUnchanged("worldless target after preview", baseline.worldless, snapshotTree(instanceDir(WORLDLESS_ID)));

  // Malformed target ids and mismatched payload.instanceId keep failing loud.
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: worldBackup.id, preview: true, targetInstanceId: "bad id!" }),
    (error) => error?.code === "INVALID_INSTANCE_ID",
    "Malformed targetInstanceId must fail validation even in preview.",
  );
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: worldBackup.id, instanceId: "other-instance", preview: true }),
    (error) => error?.code === "BACKUP_INSTANCE_MISMATCH",
    "payload.instanceId must keep naming the backup's own instance.",
  );
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: "missing-backup-1", preview: true }),
    (error) => error?.code === "BACKUP_NOT_FOUND",
    "Preview of an unknown backup must fail with the documented code.",
  );

  // 4. Refusal without confirmOverwrite leaves everything untouched: no stop,
  // no safety snapshot, no wipe, no operation record.
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: worldBackup.id, targetInstanceId: TARGET_ID }),
    (error) => error?.code === "RESTORE_OVERWRITE_CONFIRMATION_REQUIRED"
      && error?.details?.targetInstanceId === TARGET_ID
      && error?.details?.sameTargetAsBackup === false,
    "Cross-instance restore without confirmOverwrite must refuse with target-aware details.",
  );
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: worldBackup.id }),
    (error) => error?.code === "RESTORE_OVERWRITE_CONFIRMATION_REQUIRED",
    "Same-instance restore without confirmOverwrite must still refuse.",
  );
  assert.deepStrictEqual(longOperations.listOperations({ kind: "backup-restore" }), [], "A refused restore must not create an operation record.");
  assert.deepStrictEqual(lifecycleCalls, [], "Refused restores must never touch the lifecycle.");
  assertTreeUnchanged("source after refusals", baseline.source, snapshotTree(sourcePath));
  assertTreeUnchanged("target after refusals", baseline.target, snapshotTree(instanceDir(TARGET_ID)));
  assertTreeUnchanged("backup root after refusals", baseline.backups, backupRootSnapshot());

  // A cross-instance restore onto an unregistered target refuses fast.
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: worldBackup.id, targetInstanceId: GHOST_ID, confirmOverwrite: true }),
    (error) => error?.code === "RESTORE_TARGET_INSTANCE_NOT_FOUND" && error?.details?.causeCode === "INSTANCE_NOT_FOUND",
    "Restore must refuse an unregistered cross-instance target.",
  );
  assertTreeUnchanged("backup root after ghost-target refusal", baseline.backups, backupRootSnapshot());

  // 5. Regression: same-instance world restore still works end to end, keeps
  // the historical restart opt-in, and never restarts an unstopped flow.
  fs.writeFileSync(path.join(sourcePath, "data", "world", "level.dat"), "corrupted-by-bad-update");
  const sameRestore = await backupService.restoreBackup({ backupId: worldBackup.id, confirmOverwrite: true });
  assert.strictEqual(sameRestore.restore.instanceId, SOURCE_ID, "Same-instance restore keeps the historical result id.");
  assert.strictEqual(sameRestore.restore.sourceInstanceId, SOURCE_ID);
  assert.strictEqual(sameRestore.restore.sameInstanceAsBackup, true);
  assert.strictEqual(sameRestore.restore.targetWasRunning, false);
  assert.strictEqual(readRestoredWorld(SOURCE_ID), `${SOURCE_ID}-level`, "Same-instance world restore must restore the archived content.");
  assert.deepStrictEqual(
    sameRestore.restore.restart,
    { attempted: false, restarted: false, errorCode: null, errorMessage: null },
    "Same-instance restore without restart:true must not restart.",
  );
  assert.deepStrictEqual(lifecycleMethodsFor(SOURCE_ID), [], "Restoring a stopped instance must not stop or start it.");

  // 6. Cross-instance world restore moves the workload to the target and
  // leaves the source byte-identical, including its (stale) instance record.
  const sourceBeforeCross = snapshotTree(sourcePath);
  const crossWorld = await backupService.restoreBackup({ backupId: worldBackup.id, confirmOverwrite: true, targetInstanceId: TARGET_ID });
  assert.strictEqual(crossWorld.restore.targetInstanceId, TARGET_ID);
  assert.strictEqual(crossWorld.restore.sourceInstanceId, SOURCE_ID);
  assert.strictEqual(crossWorld.restore.sameInstanceAsBackup, false);
  assert.strictEqual(crossWorld.restore.targetWasRunning, false);
  assert.strictEqual(readRestoredWorld(TARGET_ID), `${SOURCE_ID}-level`, "Cross-instance restore must move the source workload to the target.");
  assert.strictEqual(readRestoredWorld(SOURCE_ID), `${SOURCE_ID}-level`, "The source workload must survive a cross-instance restore.");
  assertTreeUnchanged("source instance after cross world restore", sourceBeforeCross, snapshotTree(sourcePath));
  const targetConfigAfterWorld = JSON.parse(fs.readFileSync(path.join(instanceDir(TARGET_ID), "config.json"), "utf8"));
  assert.strictEqual(targetConfigAfterWorld.id, TARGET_ID, "A world-scope restore must not touch the target's instance record.");
  assert(!("targetRecord" in crossWorld.restore), "A world-scope restore must not report a record rebrand.");
  assert(crossWorld.restore.safetyBackupId, "Cross-instance restore must take a safety snapshot of the target.");
  const targetBackups = (await backupService.listBackups({ instanceId: TARGET_ID })).backups;
  assert(targetBackups.some((backup) => backup.id === crossWorld.restore.safetyBackupId), "The safety snapshot must belong to the target instance.");
  assert.deepStrictEqual(lifecycleMethodsFor(TARGET_ID), [], "Restoring into a stopped target must not stop or start it.");
  assert.deepStrictEqual(
    crossWorld.restore.restart,
    { attempted: false, restarted: false, errorCode: null, errorMessage: null },
    "A stopped cross-instance target must not be restarted.",
  );

  // 7. Cross-instance FULL restore rebrands the restored record: the target
  // keeps its registered id and gets a clean stopped runtime state, while the
  // restored configuration (display name) comes from the backup.
  const crossFull = await backupService.restoreBackup({ backupId: fullBackup.id, confirmOverwrite: true, targetInstanceId: TARGET_ID });
  assert.strictEqual(crossFull.restore.targetRecord.patched, true, "A cross-instance full restore must rebrand the restored instance record.");
  assert(crossFull.restore.targetRecord.fields.includes("id"), "The record rebrand must include the id field.");
  const targetConfigAfterFull = JSON.parse(fs.readFileSync(path.join(instanceDir(TARGET_ID), "config.json"), "utf8"));
  assert.strictEqual(targetConfigAfterFull.id, TARGET_ID, "The target must keep its registered id after a full restore.");
  assert.strictEqual(targetConfigAfterFull.state, "Stopped", "The restored record must be reconciled to a stopped state.");
  assert.strictEqual(targetConfigAfterFull.pid, null, "The restored record must not adopt the source's stale pid.");
  assert.strictEqual(targetConfigAfterFull.runtimeProcess, null, "The restored record must not adopt the source's runtime claim.");
  assert.strictEqual(targetConfigAfterFull.displayName, "Restore Source", "The restored configuration must come from the backup.");
  assert.strictEqual(readRestoredWorld(TARGET_ID), `${SOURCE_ID}-level`, "Full restore must restore the archived workload content.");
  assertTreeUnchanged("source instance after cross full restore", sourceBeforeCross, snapshotTree(sourcePath));

  // 8. Running target: stop, restore, restart — the source is untouched.
  lifecycleStates.set(TARGET_ID, { state: "Running", pid: 8888 });
  const callsBeforeRunningRestore = lifecycleCalls.length;
  const crossRunning = await backupService.restoreBackup({ backupId: fullBackup.id, confirmOverwrite: true, targetInstanceId: TARGET_ID });
  assert.deepStrictEqual(
    lifecycleMethodsFor(TARGET_ID, callsBeforeRunningRestore),
    ["stop", "start"],
    "A running target must be stopped before the restore and restarted after it.",
  );
  assert.strictEqual(crossRunning.restore.targetWasRunning, true, "The result must disclose that the target was running before the restore.");
  assert.strictEqual(crossRunning.restore.restart.attempted, true);
  assert.strictEqual(crossRunning.restore.restart.restarted, true);
  assert.strictEqual(lifecycleStates.get(TARGET_ID).state, "Running", "The target must be running again after the restore.");
  assertTreeUnchanged("source instance after running-target restore", sourceBeforeCross, snapshotTree(sourcePath));

  // 9. An explicit restart:false suppresses the post-restore restart: the
  // target is stopped for the restore and left stopped afterwards.
  lifecycleStates.set(TARGET_ID, { state: "Running", pid: 9999 });
  const callsBeforeNoRestart = lifecycleCalls.length;
  const crossNoRestart = await backupService.restoreBackup({ backupId: fullBackup.id, confirmOverwrite: true, targetInstanceId: TARGET_ID, restart: false });
  assert.deepStrictEqual(lifecycleMethodsFor(TARGET_ID, callsBeforeNoRestart), ["stop"], "restart:false must suppress the post-restore start.");
  assert.strictEqual(crossNoRestart.restore.restart.attempted, false, "A suppressed restart must be reported as not attempted.");
  assert.strictEqual(lifecycleStates.get(TARGET_ID).state, "Stopped", "A suppressed restart must leave the target stopped.");

  // 10. A target that cannot be stopped fails before any mutation on either
  // side: no snapshot, no wipe, source and target both untouched.
  stopFailures.add(TARGET_ID);
  lifecycleStates.set(TARGET_ID, { state: "Running", pid: 1010 });
  const targetBeforeStopFailure = snapshotTree(instanceDir(TARGET_ID));
  const backupsBeforeStopFailure = backupRootSnapshot();
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: fullBackup.id, confirmOverwrite: true, targetInstanceId: TARGET_ID }),
    (error) => error?.code === "RESTORE_INSTANCE_STOP_FAILED" && error?.details?.instanceId === TARGET_ID,
    "Restore must abort when the running target cannot be stopped.",
  );
  stopFailures.delete(TARGET_ID);
  assertTreeUnchanged("target after failed stop", targetBeforeStopFailure, snapshotTree(instanceDir(TARGET_ID)));
  assertTreeUnchanged("source after failed stop", sourceBeforeCross, snapshotTree(sourcePath));
  assertTreeUnchanged("backup root after failed stop", backupsBeforeStopFailure, backupRootSnapshot());

  // 11. A failure inside the mutation window must roll the TARGET back to its
  // prior state. Forced by a crafted world backup whose sourcePaths point
  // outside the target: the delete step refuses after the safety snapshot.
  const rollbackBackup = (await backupService.createBackup({ instanceId: SOURCE_ID, type: "world", name: "src world for rollback", createdBy: "smoke" })).backup;
  const rollbackMetadataPath = path.join(process.env.AGENT_BACKUP_ROOT, `${rollbackBackup.id}.json`);
  const rollbackMetadata = JSON.parse(fs.readFileSync(rollbackMetadataPath, "utf8"));
  rollbackMetadata.sourcePaths = ["../outside-instance"];
  fs.writeFileSync(rollbackMetadataPath, `${JSON.stringify(rollbackMetadata, null, 2)}\n`);
  const targetBeforeRollback = snapshotTree(instanceDir(TARGET_ID));
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: rollbackBackup.id, confirmOverwrite: true, targetInstanceId: TARGET_ID }),
    (error) => error?.code === "BACKUP_ARCHIVE_PATH_UNSAFE" && error?.details?.rollback?.rolledBack === true,
    "A mid-mutation failure must roll the target back from the safety snapshot.",
  );
  assertTreeUnchanged("target after rollback", targetBeforeRollback, snapshotTree(instanceDir(TARGET_ID)));
  assertTreeUnchanged("source after rollback", sourceBeforeCross, snapshotTree(sourcePath));

  // 12. The REST restore route passes preview and targeting through with the
  // existing permission gate untouched.
  const routePreview = await handleBackups(
    { method: "POST", body: JSON.stringify({ backupId: worldBackup.id, preview: true }) },
    new URL("http://localhost/api/v1/backups/restore"),
  );
  assert.strictEqual(routePreview.statusCode, 200, "The restore route must accept a preview request.");
  assert.strictEqual(routePreview.body.preview, true);
  assert.strictEqual(routePreview.body.conflict.verdict, "overwrite");
  const routeCrossPreview = await handleBackups(
    { method: "POST", body: JSON.stringify({ backupId: worldBackup.id, preview: true, targetInstanceId: TARGET_ID }) },
    new URL("http://localhost/api/v1/backups/restore"),
  );
  assert.strictEqual(routeCrossPreview.statusCode, 200);
  assert.strictEqual(routeCrossPreview.body.conflict.verdict, "new-restore");
  const routeRefusal = await handleBackups(
    { method: "POST", body: JSON.stringify({ backupId: worldBackup.id, targetInstanceId: TARGET_ID }) },
    new URL("http://localhost/api/v1/backups/restore"),
  );
  assert.strictEqual(routeRefusal.statusCode, 400, "The restore route must refuse an unconfirmed cross-instance restore.");
  assert.strictEqual(routeRefusal.body.error.code, "RESTORE_OVERWRITE_CONFIRMATION_REQUIRED");
  assertTreeUnchanged("source after route checks", sourceBeforeCross, snapshotTree(sourcePath));
  assertTreeUnchanged("target after route checks", targetBeforeRollback, snapshotTree(instanceDir(TARGET_ID)));

  fs.rmSync(root, { recursive: true, force: true });
  console.log("restore-targeting-smoke passed");
}

main().catch((error) => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  console.error(error);
  process.exit(1);
});
