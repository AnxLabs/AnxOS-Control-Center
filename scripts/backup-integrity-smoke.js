const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

// Hermetic V2-F integrity smoke: retention must never delete the newest
// recovery point, backup health must be reported in the list payload, and
// restore/rollback must fail closed on archives that no longer match their
// create-time digest while legacy metadata without a digest keeps working.
const testRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "anx-backup-integrity-"));
process.env.AGENT_INSTANCE_ROOT = path.join(testRoot, "instances");
process.env.AGENT_BACKUP_ROOT = path.join(testRoot, "backups");

const backupService = require("../agent/src/services/backupService");
const { _test } = backupService;

const WORLD_CONTENT = "integrity-world-v1";

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function createInstanceFixture(instanceId) {
  const instancePath = path.join(process.env.AGENT_INSTANCE_ROOT, instanceId);
  fsSync.mkdirSync(path.join(instancePath, "data", "world"), { recursive: true });
  fsSync.writeFileSync(path.join(instancePath, "config.json"), JSON.stringify({ id: instanceId, displayName: instanceId, state: "Stopped" }));
  fsSync.writeFileSync(path.join(instancePath, "data", "world", "level.dat"), WORLD_CONTENT);
  return instancePath;
}

async function readMetadata(backupId) {
  return JSON.parse(await fs.readFile(path.join(process.env.AGENT_BACKUP_ROOT, `${backupId}.json`), "utf8"));
}

async function writeMetadata(metadata) {
  await fs.writeFile(
    path.join(process.env.AGENT_BACKUP_ROOT, `${metadata.id}.json`),
    `${JSON.stringify(metadata, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function ageIso(daysAgo) {
  return new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
}

async function flipMiddleByte(filePath) {
  const buffer = await fs.readFile(filePath);
  buffer[Math.floor(buffer.length / 2)] ^= 0xff;
  await fs.writeFile(filePath, buffer, { mode: 0o600 });
}

async function main() {
  // --- Retention safety: the newest recovery point survives maxAgeDays=0 ---
  const retentionInstance = "retention-instance";
  createInstanceFixture(retentionInstance);
  const oldest = await backupService.createBackup({ instanceId: retentionInstance, type: "world", name: "old 1", createdBy: "smoke" });
  const middle = await backupService.createBackup({ instanceId: retentionInstance, type: "world", name: "old 2", createdBy: "smoke" });
  const newest = await backupService.createBackup({ instanceId: retentionInstance, type: "world", name: "old 3", createdBy: "smoke" });
  for (const [backup, daysAgo] of [[oldest, 10], [middle, 9], [newest, 8]]) {
    const metadata = await readMetadata(backup.backup.id);
    metadata.createdAt = ageIso(daysAgo);
    await writeMetadata(metadata);
  }

  const prune = await _test.pruneRetention(retentionInstance, { keepLast: 10, maxAgeDays: 0 });
  assert.deepStrictEqual(
    [...prune.pruned].sort(),
    [oldest.backup.id, middle.backup.id].sort(),
    "maxAgeDays=0 must prune every outdated backup except the newest recovery point.",
  );
  assert.deepStrictEqual(
    prune.skipped,
    [{ backupId: newest.backup.id, protectedAs: "newest", reason: "backup_age_exceeds_max_age_days" }],
    "Pruning must report the newest recovery point it skipped.",
  );
  const afterPrune = await backupService.listBackups({ instanceId: retentionInstance });
  assert.strictEqual(afterPrune.backups.length, 1, "Only the protected newest backup should remain after maxAgeDays=0 pruning.");
  assert.strictEqual(afterPrune.backups[0].id, newest.backup.id, "The surviving backup must be the newest recovery point.");
  assert.strictEqual(
    (await fs.stat(path.join(process.env.AGENT_BACKUP_ROOT, `${newest.backup.id}.tar.gz`))).isFile(),
    true,
    "The protected newest recovery point archive must stay on disk.",
  );

  // The createBackup response must surface what retention pruned or skipped.
  const freshA = await backupService.createBackup({ instanceId: retentionInstance, type: "world", name: "fresh a", createdBy: "smoke" });
  const freshB = await backupService.createBackup({ instanceId: retentionInstance, type: "world", name: "fresh b", createdBy: "smoke" });
  const capped = await backupService.createBackup({
    instanceId: retentionInstance,
    type: "world",
    name: "capped",
    createdBy: "smoke",
    retention: { keepLast: 2, maxAgeDays: 3650 },
  });
  assert(capped.retention && Array.isArray(capped.retention.pruned), "Create responses must carry the retention report.");
  assert.deepStrictEqual(capped.retention.skipped, [], "A fresh newest backup under a count-only cap needs no protection report.");
  assert.deepStrictEqual(
    [...capped.retention.pruned].sort(),
    [freshA.backup.id, newest.backup.id].sort(),
    "keepLast=2 must prune everything beyond the two newest recovery points.",
  );

  // --- Backup health reporting in the list payload ---
  await backupService.saveSchedule({ instanceId: retentionInstance, intervalHours: 24, keepLast: 3, maxAgeDays: 7, type: "world" });
  // saveSchedule resets run history; inject it the way runDueSchedules records it.
  const schedulesFile = path.join(process.env.AGENT_BACKUP_ROOT, "schedules.json");
  const schedules = JSON.parse(await fs.readFile(schedulesFile, "utf8"));
  schedules.schedules[0].lastRunAt = ageIso(0.1);
  schedules.schedules[0].lastError = "BACKUP_SOURCE_LIMIT_EXCEEDED";
  await fs.writeFile(schedulesFile, `${JSON.stringify(schedules, null, 2)}\n`, { mode: 0o600 });

  const stale = await backupService.createBackup({ instanceId: retentionInstance, type: "world", name: "stale", createdBy: "smoke" });
  const staleMetadata = await readMetadata(stale.backup.id);
  staleMetadata.createdAt = ageIso(8);
  await writeMetadata(staleMetadata);

  const healthList = await backupService.listBackups({ instanceId: retentionInstance });
  assert.strictEqual(healthList.diagnostics.scheduleStoreErrorCode, null, "A healthy schedule store must be reported as such.");
  const staleEntry = healthList.backups.find((backup) => backup.id === stale.backup.id);
  assert(Number.isFinite(staleEntry.backupAgeHours) && Number.isFinite(staleEntry.backupAgeDays), "Backup age versus policy must be reported in hours and days.");
  assert(staleEntry.backupAgeDays > 7.5 && staleEntry.backupAgeDays < 8.5, "Reported backup age should match the fixture age.");
  assert.strictEqual(staleEntry.retentionPolicyMet, false, "A backup older than the scheduled maxAgeDays must fail the policy verdict.");
  assert.strictEqual(staleEntry.retentionPolicyReason, "backup_age_exceeds_max_age_days", "The policy verdict must explain the violation.");
  assert.strictEqual(staleEntry.retentionPolicy.source, "schedule", "The verdict must disclose whether the policy came from a schedule or defaults.");
  assert.strictEqual(staleEntry.protectedNewest, false, "A stale non-newest backup must not be flagged as protected.");
  const freshEntry = healthList.backups.find((backup) => backup.id === capped.backup.id);
  assert.strictEqual(freshEntry.retentionPolicyMet, true, "A fresh backup under the scheduled policy must pass the verdict.");
  assert.strictEqual(freshEntry.protectedNewest, true, "The newest recovery point per instance must be flagged as protected.");
  assert.strictEqual(freshEntry.scheduleHealth.lastError, "BACKUP_SOURCE_LIMIT_EXCEEDED", "Schedule lastError must be surfaced in the list payload.");
  assert(freshEntry.scheduleHealth.lastRunAt, "Schedule lastRunAt must be surfaced in the list payload.");
  assert.strictEqual(freshEntry.scheduleHealth.enabled, true, "Schedule health must report enabled state.");

  // --- Archive integrity: create-time digest, restore gate, rollback gate ---
  const integrityInstance = "integrity-instance";
  const integrityPath = createInstanceFixture(integrityInstance);
  const worldFile = path.join(integrityPath, "data", "world", "level.dat");

  const created = await backupService.createBackup({ instanceId: integrityInstance, type: "world", name: "integrity", createdBy: "smoke" });
  const archiveFile = path.join(process.env.AGENT_BACKUP_ROOT, `${created.backup.id}.tar.gz`);
  assert.strictEqual(
    created.backup.archiveSha256,
    sha256Hex(await fs.readFile(archiveFile)),
    "Create-time metadata must record the real archive digest.",
  );
  const integrityListed = (await backupService.listBackups({ instanceId: integrityInstance }))
    .backups.find((backup) => backup.id === created.backup.id);
  assert.strictEqual(integrityListed.archiveSha256, created.backup.archiveSha256, "The list payload must expose the create-time digest.");
  assert.strictEqual(integrityListed.scheduleHealth, null, "Instances without a schedule must report no schedule health.");

  const restored = await backupService.restoreBackup({ backupId: created.backup.id, confirmOverwrite: true });
  assert.strictEqual(
    fsSync.readFileSync(worldFile, "utf8"),
    WORLD_CONTENT,
    "Intact archive restore with digest verification must still work end to end.",
  );

  // Rollback reuse must verify the safety snapshot digest before mutating.
  const safetyId = restored.restore.safetyBackupId;
  const safetyMetadata = (await backupService.listBackups({ instanceId: integrityInstance }))
    .backups.find((backup) => backup.id === safetyId);
  await flipMiddleByte(path.join(process.env.AGENT_BACKUP_ROOT, `${safetyId}.tar.gz`));
  fsSync.writeFileSync(worldFile, "pre-rollback-marker");
  await assert.rejects(
    () => _test.rollbackRestoreFromSafetySnapshot(integrityPath, safetyMetadata),
    (error) => error?.code === "BACKUP_ARCHIVE_HASH_MISMATCH",
    "Rollback must refuse a safety snapshot whose archive no longer matches its digest.",
  );
  assert.strictEqual(
    fsSync.readFileSync(worldFile, "utf8"),
    "pre-rollback-marker",
    "A rejected rollback must not touch instance files.",
  );

  // Legacy metadata without a digest: the field stays absent and the existing
  // header-only validation keeps working end to end.
  const legacyContentAtCreation = fsSync.readFileSync(worldFile, "utf8");
  const legacy = await backupService.createBackup({ instanceId: integrityInstance, type: "world", name: "legacy", createdBy: "smoke" });
  const legacyMetadata = await readMetadata(legacy.backup.id);
  delete legacyMetadata.archiveSha256;
  await writeMetadata(legacyMetadata);
  const legacyEntry = (await backupService.listBackups({ instanceId: integrityInstance }))
    .backups.find((backup) => backup.id === legacy.backup.id);
  assert(!("archiveSha256" in legacyEntry), "Legacy fixtures must keep the digest field honestly absent.");
  fsSync.writeFileSync(worldFile, "changed-for-legacy-restore");
  await backupService.restoreBackup({ backupId: legacy.backup.id, confirmOverwrite: true });
  assert.strictEqual(
    fsSync.readFileSync(worldFile, "utf8"),
    legacyContentAtCreation,
    "Legacy metadata restore must keep working with header-only validation.",
  );

  // Tampered archive: restore must fail closed without extracting anything.
  const tampered = await backupService.createBackup({ instanceId: integrityInstance, type: "world", name: "tampered", createdBy: "smoke" });
  await flipMiddleByte(path.join(process.env.AGENT_BACKUP_ROOT, `${tampered.backup.id}.tar.gz`));
  fsSync.writeFileSync(worldFile, "tamper-marker");
  const backupsBeforeTamperedRestore = (await backupService.listBackups({ instanceId: integrityInstance })).backups.length;
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: tampered.backup.id, confirmOverwrite: true }),
    (error) => error?.code === "BACKUP_ARCHIVE_HASH_MISMATCH",
    "Restore must reject an archive that no longer matches its create-time digest.",
  );
  assert.strictEqual(
    fsSync.readFileSync(worldFile, "utf8"),
    "tamper-marker",
    "A rejected tampered restore must not extract anything.",
  );
  assert.strictEqual(
    (await backupService.listBackups({ instanceId: integrityInstance })).backups.length,
    backupsBeforeTamperedRestore,
    "A rejected tampered restore must not create a safety snapshot.",
  );

  // Corruption that keeps valid gzip/tar headers used to pass the header-only
  // check; the create-time digest must now catch it before extraction.
  const corruptPayload = await backupService.createBackup({ instanceId: integrityInstance, type: "world", name: "payload corrupt", createdBy: "smoke" });
  const corruptArchive = path.join(process.env.AGENT_BACKUP_ROOT, `${corruptPayload.backup.id}.tar.gz`);
  const tarBuffer = zlib.gunzipSync(await fs.readFile(corruptArchive));
  tarBuffer[1024] ^= 0xff; // first payload byte inside the level.dat entry, past both tar headers
  const recompressed = zlib.gzipSync(tarBuffer);
  assert.doesNotThrow(
    () => _test.parseTarEntries(recompressed),
    "Fixture check: payload corruption behind valid tar headers must pass the header-only validation.",
  );
  await fs.writeFile(corruptArchive, recompressed, { mode: 0o600 });
  fsSync.writeFileSync(worldFile, "payload-corrupt-marker");
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: corruptPayload.backup.id, confirmOverwrite: true }),
    (error) => error?.code === "BACKUP_ARCHIVE_HASH_MISMATCH",
    "Corrupt payloads behind valid headers must now be caught by the digest check.",
  );
  assert.strictEqual(
    fsSync.readFileSync(worldFile, "utf8"),
    "payload-corrupt-marker",
    "A rejected corrupt-payload restore must not extract anything.",
  );

  // Retention is per instance: work on the integrity instance must not touch
  // the retention instance's recovery points.
  assert(
    (await backupService.listBackups({ instanceId: retentionInstance })).backups.some((backup) => backup.id === stale.backup.id),
    "Per-instance retention must not prune another instance's backups.",
  );

  await fs.rm(testRoot, { recursive: true, force: true });
  console.log("Backup integrity smoke checks passed.");
}

main().catch((error) => {
  try {
    fsSync.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
  console.error(error);
  process.exit(1);
});
