const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

async function main() {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "anx-backup-recovery-"));
  const instanceRoot = path.join(testRoot, "instances");
  const backupRoot = path.join(testRoot, "backups");
  process.env.AGENT_INSTANCE_ROOT = instanceRoot;
  process.env.AGENT_BACKUP_ROOT = backupRoot;

  const backupServiceModule = require("../agent/src/services/backupService");
  const backupService = backupServiceModule._test;
  await fs.mkdir(backupRoot, { recursive: true });
  await fs.writeFile(path.join(backupRoot, "interrupted.tar.gz.123.tmp"), "partial");
  await fs.writeFile(path.join(backupRoot, "orphan.tar.gz"), "partial");
  await fs.writeFile(path.join(backupRoot, "committed.tar.gz"), "archive");
  await fs.writeFile(path.join(backupRoot, "committed.json"), "{}");

  const first = await backupService.recoverBackupArtifacts();
  assert.deepStrictEqual(
    first.removed.map((entry) => entry.reason),
    ["temporary-artifact"],
    "Only uncommitted temporary files may be deleted.",
  );
  assert.strictEqual(first.quarantined.length, 1, "An archive without metadata must be quarantined, not removed.");
  assert.strictEqual(first.quarantined[0].file, "orphan.tar.gz");
  assert.strictEqual(first.quarantined[0].reason, "archive-without-metadata");
  await assert.rejects(fs.stat(path.join(backupRoot, "interrupted.tar.gz.123.tmp")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(backupRoot, "orphan.tar.gz")), { code: "ENOENT" });
  assert.strictEqual((await fs.stat(path.join(backupRoot, "committed.tar.gz"))).isFile(), true);

  // Data-preservation regression: the orphan archive must still exist on disk
  // under quarantine/, renamed with a timestamp, with its bytes untouched.
  const quarantineDir = path.join(backupRoot, "quarantine");
  const quarantineEntries = await fs.readdir(quarantineDir);
  assert.strictEqual(quarantineEntries.length, 1, "Exactly the orphaned archive must be in quarantine.");
  assert.match(
    quarantineEntries[0],
    /^orphan\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.orphan\.tar\.gz$/,
    "Quarantined archives must be renamed with a filesystem-safe timestamp.",
  );
  assert.strictEqual(
    await fs.readFile(path.join(quarantineDir, quarantineEntries[0]), "utf8"),
    "partial",
    "Quarantine must preserve the archive bytes.",
  );

  // Quarantined artifacts must never be listed as backups or counted.
  const listed = await backupServiceModule.listBackups();
  assert.strictEqual(listed.backups.length, 1, "Quarantined archives must not be listed as backups.");
  assert.strictEqual(listed.summary.totalBackups, 1, "Quarantined archives must not be counted in backup totals.");
  assert(!listed.backups.some((backup) => String(backup.id || "").includes("orphan")));
  assert(!listed.backups.some((backup) => String(backup.path || "").includes("quarantine")));

  const second = await backupService.recoverBackupArtifacts();
  assert.deepStrictEqual(second, { removed: [], quarantined: [] });
  assert.deepStrictEqual(
    await fs.readdir(quarantineDir),
    quarantineEntries,
    "Recovery must be idempotent and must never delete quarantined archives.",
  );
  await fs.rm(testRoot, { recursive: true, force: true });
  console.log("Backup interrupted artifact recovery smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
