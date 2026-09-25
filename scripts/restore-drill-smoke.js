// Restore drill: the missing proof behind the migration recovery-point policy.
// Creates a disposable instance fixture in one temp tree, backs it up through
// the real backupService create path, destroys the fixture, restores through
// the real restoreBackup path, and proves the restored bytes match the fixture
// exactly — plus failure legs proving a truncated archive (with and without a
// create-time digest) and a missing backup fail closed without partially
// overwriting state. Hermetic: every runtime root is pinned inside os.tmpdir()
// (test-helpers/pin-agent-roots.js plus an explicit AGENT_BACKUP_ROOT pin), the
// instance lifecycle is stubbed in-memory, and no Agent, Electron, or real user
// state is read or written.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const root = pinAgentRoots("anx-restore-drill-");
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
process.env.AGENT_BACKUP_ROOT = path.join(root, "backups");

// Safety preflight: refuse to run if any runtime root escaped the temp tree.
// The drill must never be able to read or write the real instances/, backups/,
// or config directories.
const tempRoot = path.resolve(os.tmpdir()).toLowerCase();
["ANXHUB_CONFIG_DIR", "AGENT_INSTANCE_ROOT", "AGENT_BACKUP_ROOT"].forEach((name) => {
  const resolved = path.resolve(String(process.env[name] || ""));
  assert(
    resolved && resolved.toLowerCase().startsWith(`${tempRoot}${path.sep}`),
    `${name} must stay inside ${tempRoot}; refusing to run with ${resolved}`,
  );
});

const backupService = require("../agent/src/services/backupService");
const instanceService = require("../agent/src/services/instances/instanceService");

const INSTANCE_ID = "restore-drill-instance";
const FIXTURE_FILES = [
  ["config.json", `${JSON.stringify({ schemaVersion: 2, id: INSTANCE_ID, displayName: "Restore Drill", state: "Stopped" }, null, 2)}\n`],
  ["data/world/level.dat", "restore-drill-level-v1"],
  ["data/world/region/r.0.0.mca", "restore-drill-region-v1"],
  ["data/sentinel/alpha.txt", "alpha-sentinel-v1"],
  ["data/sentinel/binary.bin", Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x52, 0x44, 0x00])],
];

const steps = [];
const lifecycleCalls = [];
const lifecycleStates = new Map();

function record(step, status, detail) {
  steps.push({ step, status, ...(detail === undefined ? {} : { detail }) });
}

function instanceDir() {
  return path.join(process.env.AGENT_INSTANCE_ROOT, INSTANCE_ID);
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function snapshotTree(rootDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) files.push([path.relative(rootDir, fullPath).split(path.sep).join("/"), sha256(fs.readFileSync(fullPath))]);
    }
  };
  walk(rootDir);
  files.sort((left, right) => left[0].localeCompare(right[0]));
  return files;
}

function writeFixtureFile(relativePath, content) {
  const target = path.join(instanceDir(), relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function archiveFileDigests(backup) {
  const archivePath = path.join(process.env.AGENT_BACKUP_ROOT, backup.archiveName);
  const parsed = backupService._test.parseTarEntries(fs.readFileSync(archivePath));
  return parsed.entries
    .filter((entry) => entry.type !== "directory")
    .map((entry) => [entry.name, sha256(entry.tarBuffer.subarray(entry.dataStart, entry.dataEnd))])
    .sort((left, right) => left[0].localeCompare(right[0]));
}

function cleanup() {
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}

// The canonical lifecycle path is intercepted in-memory: the dispose-able
// fixture is Stopped throughout, so a correct restore never stops or starts it.
function stubInstanceLifecycle() {
  instanceService.getStatus = async (instanceId) => ({ ...(lifecycleStates.get(instanceId) || { state: "Stopped", pid: null }) });
  instanceService.stopInstance = async (instanceId) => {
    lifecycleCalls.push({ method: "stop", instanceId });
    lifecycleStates.set(instanceId, { state: "Stopped", pid: null });
    return { id: instanceId, state: "Stopped" };
  };
  instanceService.startInstance = async (instanceId) => {
    lifecycleCalls.push({ method: "start", instanceId });
    lifecycleStates.set(instanceId, { state: "Running", pid: 4242 });
    return { id: instanceId, state: "Running" };
  };
}

async function main() {
  stubInstanceLifecycle();

  // (a) Disposable test state with sentinel files and known content hashes.
  fs.mkdirSync(instanceDir(), { recursive: true });
  for (const [relativePath, content] of FIXTURE_FILES) writeFixtureFile(relativePath, content);
  const fixtureDigests = snapshotTree(instanceDir());
  assert.strictEqual(fixtureDigests.length, FIXTURE_FILES.length, "Fixture snapshot must cover every fixture file.");
  record("a.create-disposable-state", "PASS", { files: fixtureDigests.length });

  // (b) Backup through the real create path. The archive must contain exactly
  // the fixture bytes and carry a create-time digest matching the stored file.
  const created = await backupService.createBackup({ instanceId: INSTANCE_ID, type: "full", name: "restore drill", createdBy: "restore-drill-smoke" });
  const backup = created.backup;
  const archivePath = path.join(process.env.AGENT_BACKUP_ROOT, backup.archiveName);
  assert.strictEqual(backup.status, "complete", "The backup must report completion only after the archive is durable.");
  assert.strictEqual(backup.archiveSha256, sha256(fs.readFileSync(archivePath)), "The create-time digest must match the stored archive bytes.");
  assert(fs.existsSync(path.join(process.env.AGENT_BACKUP_ROOT, `${backup.id}.json`)), "Backup metadata must be persisted next to the archive.");
  assert.deepStrictEqual(archiveFileDigests(backup), fixtureDigests, "The archive must contain exactly the fixture bytes.");
  record("b.create-backup", "PASS", { backupId: backup.id, entries: backup.entryCount, archiveBytes: backup.size });

  // (c) Mutate and destroy the disposable state.
  writeFixtureFile("data/world/level.dat", "corrupted-by-drill");
  fs.rmSync(path.join(instanceDir(), "data", "sentinel", "alpha.txt"), { force: true });
  writeFixtureFile("data/stray/should-not-survive.txt", "stray");
  const destroyedDigests = snapshotTree(instanceDir());
  assert.notDeepStrictEqual(destroyedDigests, fixtureDigests, "Fixture check: the destroyed state must differ from the fixture.");
  record("c.destroy-disposable-state", "PASS", { files: destroyedDigests.length });

  // (d) Restore from the backup through the real restore path.
  const restored = await backupService.restoreBackup({ backupId: backup.id, confirmOverwrite: true });
  const restore = restored.restore;
  assert.strictEqual(restore.backupId, backup.id, "The restore result must name the archive it restored.");
  assert.strictEqual(restore.sameInstanceAsBackup, true, "The drill restores the backup's own instance.");
  assert.strictEqual(restore.targetWasRunning, false, "The fixture is stopped; the restore must disclose that honestly.");
  assert.strictEqual(restore.restoredEntries, backup.entryCount, "The reported restored entry count must match the archive.");
  assert(restore.safetyBackupId, "A same-instance restore must take a target safety snapshot.");
  assert(fs.existsSync(path.join(process.env.AGENT_BACKUP_ROOT, `${restore.safetyBackupId}.json`)), "The reported safety snapshot must exist on disk.");
  assert.deepStrictEqual(restore.restart, { attempted: false, restarted: false, errorCode: null, errorMessage: null }, "A stopped instance must not be restarted.");
  assert.deepStrictEqual(lifecycleCalls, [], "A stopped fixture must never be stopped or started by backup or restore.");
  record("d.restore-backup", "PASS", { safetyBackupId: restore.safetyBackupId, restoredEntries: restore.restoredEntries });

  // (e) The restored state must match (a) byte-for-byte. A restore that
  // reported success with wrong or partial bytes fails right here.
  assert.deepStrictEqual(snapshotTree(instanceDir()), fixtureDigests, "The restored tree must match the fixture byte-for-byte (content hashes).");
  assert(!fs.existsSync(path.join(instanceDir(), "data", "stray", "should-not-survive.txt")), "A full restore must not leave pre-restore stray files behind.");
  assert.deepStrictEqual(fs.readFileSync(path.join(instanceDir(), "data", "sentinel", "binary.bin")), FIXTURE_FILES[4][1], "Binary sentinel bytes must round-trip exactly.");
  record("e.verify-restored-state", "PASS", { matchesFixture: true, strayFileRemoved: true });

  // Failure leg 1: a truncated archive with a create-time digest must fail
  // closed with the digest error and must not partially overwrite state.
  const tampered = (await backupService.createBackup({ instanceId: INSTANCE_ID, type: "full", name: "tamper drill", createdBy: "restore-drill-smoke" })).backup;
  const tamperedArchivePath = path.join(process.env.AGENT_BACKUP_ROOT, tampered.archiveName);
  const tamperedBytes = fs.readFileSync(tamperedArchivePath);
  fs.writeFileSync(tamperedArchivePath, tamperedBytes.subarray(0, Math.max(1, tamperedBytes.length - Math.ceil(tamperedBytes.length / 3))), { mode: 0o600 });
  writeFixtureFile("data/world/level.dat", "tamper-marker");
  const tamperedTreeBefore = snapshotTree(instanceDir());
  const backupsBeforeTamperedRestore = (await backupService.listBackups({ instanceId: INSTANCE_ID })).backups.length;
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: tampered.id, confirmOverwrite: true }),
    (error) => error?.code === "BACKUP_ARCHIVE_HASH_MISMATCH",
    "A truncated archive that no longer matches its create-time digest must fail closed.",
  );
  assert.deepStrictEqual(snapshotTree(instanceDir()), tamperedTreeBefore, "A rejected truncated restore must not partially overwrite state.");
  assert.strictEqual(
    (await backupService.listBackups({ instanceId: INSTANCE_ID })).backups.length,
    backupsBeforeTamperedRestore,
    "A rejected restore must not create a safety snapshot.",
  );
  record("f.truncated-archive-fails-closed", "PASS", { errorCode: "BACKUP_ARCHIVE_HASH_MISMATCH", stateUnchanged: true });

  // Failure leg 1b: legacy metadata without a digest still fails closed on the
  // same truncated archive through structural validation.
  const tamperedMetadataPath = path.join(process.env.AGENT_BACKUP_ROOT, `${tampered.id}.json`);
  const tamperedMetadata = JSON.parse(fs.readFileSync(tamperedMetadataPath, "utf8"));
  delete tamperedMetadata.archiveSha256;
  fs.writeFileSync(tamperedMetadataPath, `${JSON.stringify(tamperedMetadata, null, 2)}\n`, { mode: 0o600 });
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: tampered.id, confirmOverwrite: true }),
    (error) => error?.code === "BACKUP_ARCHIVE_INVALID",
    "A truncated archive must fail closed even when the metadata carries no digest.",
  );
  assert.deepStrictEqual(snapshotTree(instanceDir()), tamperedTreeBefore, "A rejected digest-less restore must not partially overwrite state.");
  record("g.digestless-truncated-archive-fails-closed", "PASS", { errorCode: "BACKUP_ARCHIVE_INVALID", stateUnchanged: true });

  // Failure leg 2: a backup that does not exist must fail closed.
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: "missing-backup-0000", confirmOverwrite: true }),
    (error) => error?.code === "BACKUP_NOT_FOUND",
    "A missing backup must fail closed with the documented code.",
  );
  assert.deepStrictEqual(snapshotTree(instanceDir()), tamperedTreeBefore, "A missing backup must leave state untouched.");
  record("h.missing-backup-fails-closed", "PASS", { errorCode: "BACKUP_NOT_FOUND", stateUnchanged: true });

  // Failure leg 3: metadata exists but the archive file is gone. This must
  // also fail closed — with the wrapped, coded backup error instead of a raw
  // filesystem ENOENT.
  const orphaned = (await backupService.createBackup({ instanceId: INSTANCE_ID, type: "full", name: "orphan drill", createdBy: "restore-drill-smoke" })).backup;
  fs.rmSync(path.join(process.env.AGENT_BACKUP_ROOT, orphaned.archiveName), { force: true });
  let missingArchiveErrorCode = null;
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: orphaned.id, confirmOverwrite: true }),
    (error) => {
      missingArchiveErrorCode = error?.code || "UNKNOWN";
      return error?.code === "BACKUP_ARCHIVE_MISSING"
        && error?.statusCode === 404
        && error?.details?.backupId === orphaned.id;
    },
    "A restore whose archive file is missing must fail closed with the wrapped BACKUP_ARCHIVE_MISSING code.",
  );
  assert(missingArchiveErrorCode, "A missing archive must produce a failure, not a silent success.");
  assert.deepStrictEqual(snapshotTree(instanceDir()), tamperedTreeBefore, "A missing archive must leave state untouched.");
  record("i.missing-archive-fails-closed", "PASS", { errorCode: missingArchiveErrorCode, stateUnchanged: true });

  cleanup();
  const summary = {
    status: "PASS",
    classification: "RESTORE DRILL EXECUTED — DISPOSABLE BACKUP RECOVERED BYTE-FOR-BYTE",
    restoreDrillRun: true,
    instanceId: INSTANCE_ID,
    fixtureFiles: fixtureDigests.length,
    restoredMatchesFixture: true,
    strayFileRemovedByRestore: true,
    safetySnapshotTaken: true,
    truncatedArchiveRejectedWith: "BACKUP_ARCHIVE_HASH_MISMATCH",
    digestlessTruncatedArchiveRejectedWith: "BACKUP_ARCHIVE_INVALID",
    missingBackupRejectedWith: "BACKUP_NOT_FOUND",
    missingArchiveRejectedWith: missingArchiveErrorCode,
    tempRootRemoved: !fs.existsSync(root),
    steps,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log(`restore-drill-smoke passed: ${fixtureDigests.length} fixture files recovered byte-for-byte, all failure legs failed closed.`);
}

main().catch((error) => {
  cleanup();
  console.error(error);
  process.exitCode = 1;
});
