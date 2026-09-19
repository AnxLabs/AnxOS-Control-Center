// Hermetic V2-F coverage: legacy backup metadata migration.
//
// `readBackupMetadata` migrates metadata written before the schema existed
// (no `schemaVersion` field) to the current version, preserving the original
// as a byte-stable `<file>.schema-v0.backup` copy. Nothing pinned that contract
// before, and the migration copy was a stat-then-copy pair whose loser threw
// EEXIST — which failed the read and removed a restorable backup from the
// operator's listing when a listing and a restore raced the same legacy file.
//
// What this smoke proves, against the real service on a temp tree:
//   1. a pre-schema record is migrated in memory AND persisted, and is still
//      listed (a migration must never make a backup disappear);
//   2. the preserved copy is byte-identical to the original file, written once,
//      and untouched by re-reads (idempotent);
//   3. a record whose migration copy LOSES that race is still migrated and
//      still listed — the deterministic discriminator for the EEXIST tolerance,
//      since the fixture makes the destination appear between the decision to
//      copy and the copy itself;
//   4. a record written by a NEWER schema is refused rather than guessed at,
//      and the refusal is reported in `metadataErrors` instead of the file
//      being silently invisible.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-backup-migration-"));
process.env.AGENT_INSTANCE_ROOT = path.join(testRoot, "instances");
process.env.AGENT_BACKUP_ROOT = path.join(testRoot, "backups");

const backupService = require("../agent/src/services/backupService");

// Every path below is derived from the service's own backup root — the temp
// directory this smoke created — and is containment-checked before use, so a
// malformed name can never reach outside the fixture tree.
const backupRoot = path.resolve(backupService.getBackupRoot());
function fixturePath(name) {
  const resolved = path.resolve(backupRoot, name);
  if (resolved !== backupRoot && !resolved.startsWith(`${backupRoot}${path.sep}`)) {
    throw new Error("Refusing to touch a path outside the backup fixture root.");
  }
  return resolved;
}

const instanceRoot = path.resolve(process.env.AGENT_INSTANCE_ROOT);
function instanceFixturePath(name) {
  const resolved = path.resolve(instanceRoot, name);
  if (resolved !== instanceRoot && !resolved.startsWith(`${instanceRoot}${path.sep}`)) {
    throw new Error("Refusing to touch a path outside the instance fixture root.");
  }
  return resolved;
}

function createInstanceFixture(instanceId) {
  const instancePath = instanceFixturePath(instanceId);
  fs.mkdirSync(path.join(instancePath, "data", "world"), { recursive: true });
  fs.writeFileSync(path.join(instancePath, "config.json"), JSON.stringify({ id: instanceId, displayName: instanceId, state: "Stopped" }));
  fs.writeFileSync(path.join(instancePath, "data", "world", "level.dat"), "migration-world-v1");
}

function readRawMetadata(backupId) {
  return fs.readFileSync(fixturePath(`${backupId}.json`), "utf8");
}

// A pre-schema record: exactly what an older build wrote, with no
// `schemaVersion` field at all.
function writeLegacyMetadata(backupId, instanceId, size) {
  const bytes = `${JSON.stringify({
    id: backupId,
    instanceId,
    createdAt: new Date().toISOString(),
    type: "world",
    status: "complete",
    size,
  }, null, 2)}\n`;
  fs.writeFileSync(fixturePath(`${backupId}.json`), bytes, { mode: 0o600 });
  return bytes;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function main() {
  const instanceId = "migration-instance";
  createInstanceFixture(instanceId);

  // --- 1 + 2: migrate on read, persist, preserve the original once ---
  const seeded = await backupService.createBackup({ instanceId, type: "world", name: "seeded", createdBy: "smoke" });
  const legacyId = seeded.backup.id;
  const legacyBytes = writeLegacyMetadata(legacyId, instanceId, seeded.backup.size);
  assert(
    !("schemaVersion" in JSON.parse(readRawMetadata(legacyId))),
    "Fixture check: the legacy metadata must not carry a schemaVersion.",
  );

  const firstList = await backupService.listBackups({ instanceId });
  const migrated = firstList.backups.find((backup) => backup.id === legacyId);
  assert(migrated, "A pre-schema backup must still be listed: migrating must not make it disappear.");
  assert.strictEqual(
    migrated.schemaVersion,
    backupService.BACKUP_METADATA_SCHEMA_VERSION,
    "A pre-schema record must be migrated to the current schema when it is read.",
  );
  assert.strictEqual(
    JSON.parse(readRawMetadata(legacyId)).schemaVersion,
    backupService.BACKUP_METADATA_SCHEMA_VERSION,
    "The migration must be persisted, not only applied in memory.",
  );

  const preservedBytes = fs.readFileSync(fixturePath(`${legacyId}.json.schema-v0.backup`), "utf8");
  assert.strictEqual(
    sha256(preservedBytes),
    sha256(legacyBytes),
    "The preserved pre-migration copy must be byte-identical to the original file.",
  );

  // Idempotent: another read neither rewrites the preserved copy nor adds one.
  const secondList = await backupService.listBackups({ instanceId });
  assert.strictEqual(
    secondList.backups.find((backup) => backup.id === legacyId)?.schemaVersion,
    backupService.BACKUP_METADATA_SCHEMA_VERSION,
    "Re-reading a migrated record must keep it at the current schema.",
  );
  assert.strictEqual(
    sha256(fs.readFileSync(fixturePath(`${legacyId}.json.schema-v0.backup`), "utf8")),
    sha256(legacyBytes),
    "Re-reading must not alter the preserved pre-migration copy.",
  );

  // --- 3: the lost-race path ---
  // Deterministic: the copy destination appears between the migration's
  // decision to copy and the copy itself, so the copy fails with EEXIST while
  // the original is still preserved. Failing the read here would drop a
  // restorable backup from the listing, which is the defect this pins.
  const raced = await backupService.createBackup({ instanceId, type: "world", name: "raced", createdBy: "smoke" });
  const racedBytes = writeLegacyMetadata(raced.backup.id, instanceId, raced.backup.size);
  const realCopyFile = fsp.copyFile;
  fsp.copyFile = async (source, destination, mode) => {
    if (typeof destination === "string" && destination.endsWith(".schema-v0.backup")) {
      // A concurrent reader wins the race first.
      await realCopyFile(source, destination, mode).catch(() => {});
    }
    return realCopyFile(source, destination, mode);
  };
  let racedRecord = null;
  let racedListed = false;
  try {
    const racedList = await backupService.listBackups({ instanceId });
    racedRecord = racedList.backups.find((backup) => backup.id === raced.backup.id) || null;
    racedListed = Boolean(racedRecord);
  } finally {
    fsp.copyFile = realCopyFile;
  }
  assert(racedListed, "A pre-schema backup must not be dropped when another reader already wrote the pre-migration copy.");
  assert.strictEqual(
    racedRecord.schemaVersion,
    backupService.BACKUP_METADATA_SCHEMA_VERSION,
    "A record whose migration copy lost the race must still be migrated.",
  );
  assert.strictEqual(
    sha256(fs.readFileSync(fixturePath(`${raced.backup.id}.json.schema-v0.backup`), "utf8")),
    sha256(racedBytes),
    "The race must leave a byte-stable copy of the original bytes.",
  );

  // --- 4: a newer schema is refused and reported ---
  const future = await backupService.createBackup({ instanceId, type: "world", name: "future", createdBy: "smoke" });
  const futureMetadata = JSON.parse(readRawMetadata(future.backup.id));
  fs.writeFileSync(
    fixturePath(`${future.backup.id}.json`),
    `${JSON.stringify({ ...futureMetadata, schemaVersion: backupService.BACKUP_METADATA_SCHEMA_VERSION + 1 }, null, 2)}\n`,
    { mode: 0o600 },
  );
  const futureList = await backupService.listBackups({ instanceId });
  assert(
    !futureList.backups.some((backup) => backup.id === future.backup.id),
    "A newer-schema record must not be presented as a usable backup.",
  );
  assert(
    Array.isArray(futureList.diagnostics?.metadataErrors)
      && futureList.diagnostics.metadataErrors.some((entry) => entry.file === `${future.backup.id}.json` && entry.code === "BACKUP_METADATA_SCHEMA_UNSUPPORTED"),
    `A refused newer-schema record must be reported in diagnostics.metadataErrors rather than silently skipped. Observed: ${JSON.stringify(futureList.diagnostics?.metadataErrors)}`,
  );

  // The refusal must be the reader's own error, not a side effect of the list.
  await assert.rejects(
    () => backupService.readBackupMetadata(future.backup.id),
    (error) => error?.code === "BACKUP_METADATA_SCHEMA_UNSUPPORTED",
    "Reading a newer-schema record directly must fail closed with the schema code.",
  );

  // --- 5: the schedule store carries the same migration and the same race ---
  // Reading schedules migrates a pre-schema store the same way, and the same
  // lost-race failure would take the schedule store down instead of just one
  // backup. Both migration sites are covered here because they are the same
  // defect class.
  const schedulePath = fixturePath("schedules.json");
  const legacyScheduleBytes = `${JSON.stringify({
    schedules: [{ instanceId, enabled: true, intervalHours: 24, keepLast: 3, createdAt: new Date().toISOString() }],
  }, null, 2)}\n`;
  fs.writeFileSync(schedulePath, legacyScheduleBytes, { mode: 0o600 });
  const migratedSchedules = await backupService.listSchedules();
  assert.strictEqual(migratedSchedules.schedules.length, 1, "A pre-schema schedule store must be migrated and still readable.");
  assert.strictEqual(
    JSON.parse(fs.readFileSync(schedulePath, "utf8")).schemaVersion,
    1,
    "The migrated schedule store must be persisted at the current schema version.",
  );
  assert.strictEqual(
    sha256(fs.readFileSync(fixturePath("schedules.json.schema-v0.backup"), "utf8")),
    sha256(legacyScheduleBytes),
    "The schedule store's pre-migration copy must be byte-identical to the original.",
  );

  // Deterministic lost race for the schedule store: the preserved copy appears
  // before the migration's own copy runs.
  const racedStoreBytes = `${JSON.stringify({ schedules: [{ instanceId, enabled: true, intervalHours: 12, keepLast: 2 }] }, null, 2)}\n`;
  const racedStoreTarget = fixturePath("schedules.json");
  fs.writeFileSync(racedStoreTarget, racedStoreBytes, { mode: 0o600 });
  fs.rmSync(fixturePath("schedules.json.schema-v0.backup"), { force: true });
  const realCopyFileForSchedules = fsp.copyFile;
  fsp.copyFile = async (source, destination, mode) => {
    if (typeof destination === "string" && destination.endsWith("schedules.json.schema-v0.backup")) {
      await realCopyFileForSchedules(source, destination, mode).catch(() => {});
    }
    return realCopyFileForSchedules(source, destination, mode);
  };
  let racedSchedules = null;
  try {
    racedSchedules = await backupService.listSchedules();
  } finally {
    fsp.copyFile = realCopyFileForSchedules;
  }
  assert(
    racedSchedules && Array.isArray(racedSchedules.schedules),
    "A pre-schema schedule store must not fail to load when another reader already wrote the pre-migration copy.",
  );

  fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log("Backup metadata migration smoke checks passed.");
}

main().catch((error) => {
  try {
    fs.rmSync(testRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
  console.error(error);
  process.exit(1);
});
