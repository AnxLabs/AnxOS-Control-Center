const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// Hermetic V2-Alpha acceptance-loop slice: a marketplace-created instance must
// survive install -> backup -> bad update -> restore (byte-identical data) and
// honor the uninstall choice contract (Delete removes data, Forget keeps it).
const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxhub-alpha-loop-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
process.env.AGENT_INSTANCE_ROOT = path.join(root, "instances");
process.env.AGENT_BACKUP_ROOT = path.join(root, "backups");

const backupService = require("../agent/src/services/backupService");
const instanceService = require("../agent/src/services/instances/instanceService");

// Mirrors the marketplace installer's buildInstancePayload shape closely enough
// to exercise the same instance record validation (java-app, marketplace tags).
function buildMarketplaceInstancePayload(id, displayName) {
  return {
    id,
    displayName,
    type: "java-app",
    game: "minecraft",
    minecraftVersion: "1.21.1",
    serverVersion: "1.21.1",
    serverSoftware: "Minecraft",
    loader: "vanilla",
    workingDirectory: "data",
    executable: "java",
    args: ["-Xmx4G", "-jar", "server.jar", "nogui"],
    jar: "server.jar",
    serverJar: "server.jar",
    memoryLimit: "4G",
    restartPolicy: "on-failure",
    startupTimeoutMs: 60000,
    shutdownTimeoutMs: 15000,
    ports: [25565],
    primaryPort: 25565,
    installationState: "active",
    tags: ["minecraft", "marketplace", "vanilla"],
  };
}

async function main() {
  const instanceId = "alpha-loop-marketplace";
  const instancePath = path.join(process.env.AGENT_INSTANCE_ROOT, instanceId);
  const worldFile = path.join(instancePath, "data", "world", "level.dat");
  const propertiesFile = path.join(instancePath, "data", "server.properties");

  // Install: create the marketplace-flavored instance record and seed its data.
  const createdInstance = await instanceService.createInstance(buildMarketplaceInstancePayload(instanceId, "Alpha Loop Marketplace Server"));
  assert.strictEqual(createdInstance.id, instanceId, "Marketplace-style instance creation should keep the requested id.");
  const persistedConfig = JSON.parse(fs.readFileSync(path.join(instancePath, "config.json"), "utf8"));
  assert(persistedConfig.tags.includes("marketplace"), "Persisted instance record should carry the marketplace provenance tag.");
  fs.mkdirSync(path.join(instancePath, "data", "world"), { recursive: true });
  fs.writeFileSync(worldFile, "alpha-loop-world-v1");
  fs.writeFileSync(propertiesFile, "motd=pre-update\nmax-players=20\n");

  // Backup: full-scope safety net, the same path the Backups page Backup Now uses.
  const backupResult = await backupService.createBackup({ instanceId, type: "full", name: "Alpha loop pre-update backup", createdBy: "alpha-loop-smoke" });
  assert(backupResult.backup.id, "Backup creation should return a backup id.");
  assert.strictEqual(backupResult.backup.type, "full", "Full-scope backup type should persist.");
  assert(backupResult.backup.sourcePaths.includes("."), "Full backup scope should cover the whole instance including config.json.");
  const listResult = await backupService.listBackups({ instanceId });
  assert.strictEqual(listResult.backups.length, 1, "Backup list should include the pre-update backup.");

  // Update gone wrong: mutate the instance data the way a bad update would.
  const preMutationWorld = fs.readFileSync(worldFile);
  const preMutationProperties = fs.readFileSync(propertiesFile);
  fs.writeFileSync(worldFile, "alpha-loop-world-CORRUPTED");
  fs.writeFileSync(propertiesFile, "motd=post-update\nmax-players=5\n");
  const postUpdateFile = path.join(instancePath, "data", "world", "new-chunk.dat");
  fs.writeFileSync(postUpdateFile, "post-update extra file");
  assert(!fs.readFileSync(worldFile).equals(preMutationWorld), "Setup check: world data should differ after the simulated bad update.");
  assert(!fs.readFileSync(propertiesFile).equals(preMutationProperties), "Setup check: server properties should differ after the simulated bad update.");

  // Restore requires the same explicit overwrite confirmation the renderer's
  // confirm dialog provides (confirmOverwrite: true from restoreSelectedBackup).
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: backupResult.backup.id }),
    (error) => error?.code === "RESTORE_OVERWRITE_CONFIRMATION_REQUIRED",
    "Restore must refuse to overwrite instance data without explicit confirmation.",
  );
  const restored = await backupService.restoreBackup({ backupId: backupResult.backup.id, confirmOverwrite: true });
  assert.strictEqual(restored.restore.instanceId, instanceId, "Restore should target the original instance.");
  assert(restored.restore.safetyBackupId, "Restore should create a safety snapshot before replacing files.");
  assert(fs.readFileSync(worldFile).equals(preMutationWorld), "World data must be byte-identical to the pre-mutation state after restore.");
  assert(fs.readFileSync(propertiesFile).equals(preMutationProperties), "Server properties must be byte-identical to the pre-mutation state after restore.");
  assert(!fs.existsSync(postUpdateFile), "Full restore should remove files added after the backup was taken.");
  assert(fs.existsSync(path.join(instancePath, "config.json")), "Restore should bring back the instance record file.");

  // Uninstall choice contract: Forget keeps data on disk, Delete removes it.
  const forgetId = "alpha-loop-forget";
  const forgetPath = path.join(process.env.AGENT_INSTANCE_ROOT, forgetId);
  const keepFile = path.join(forgetPath, "data", "world", "level.dat");
  await instanceService.createInstance(buildMarketplaceInstancePayload(forgetId, "Alpha Loop Forget Server"));
  fs.mkdirSync(path.join(forgetPath, "data", "world"), { recursive: true });
  fs.writeFileSync(keepFile, "alpha-loop-forget-world");
  const forgot = await instanceService.forgetInstance(forgetId);
  assert.strictEqual(forgot.deleted, true, "Forget should remove the instance from AnxOS.");
  assert.strictEqual(forgot.metadataRemoved, true, "Forget should remove the saved instance record.");
  assert.strictEqual(forgot.filesDeleted, false, "Forget must not delete instance files.");
  assert(fs.readFileSync(keepFile).equals(Buffer.from("alpha-loop-forget-world")), "Forget must keep instance data on disk unchanged.");
  const afterForget = await instanceService.listInstances();
  assert(!afterForget.instances.some((instance) => instance.id === forgetId), "Forgotten instance must not appear in the instance list.");

  const deleted = await instanceService.deleteInstance(instanceId);
  assert.strictEqual(deleted.deleted, true, "Delete should remove the instance from AnxOS.");
  assert.strictEqual(deleted.filesDeleted, true, "Delete must remove instance data files.");
  assert.strictEqual(deleted.metadataRemoved, true, "Delete should remove the saved instance record.");
  assert(!fs.existsSync(instancePath), "Delete must remove the instance directory from disk.");
  const afterDelete = await instanceService.listInstances();
  assert(!afterDelete.instances.some((instance) => instance.id === instanceId), "Deleted instance must not appear in the instance list.");

  // Renderer wiring pins: the per-instance Backups tab Restore button routes
  // through the shared restore flow, and the uninstall dialog states the two
  // data outcomes explicitly instead of hiding them behind backend behavior.
  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert(!/data-instance-backup-action="restore"[^>]*disabled/.test(indexSource), "Per-instance Restore button must be enabled.");
  assert(appSource.includes("restoreBackupForInstance(selectedInstance.id)"), "Per-instance Restore action must route to the instance restore flow.");
  assert(appSource.includes("async function restoreBackupForInstance"), "Renderer should define restoreBackupForInstance.");
  assert(appSource.includes("No backups found for this instance yet."), "Instance restore flow should explain when no backup exists yet.");
  assert(appSource.includes("Delete (removes all instance data)"), "Delete confirmation must state that it removes all instance data.");
  assert(appSource.includes("Forget (keeps data on disk)"), "Forget confirmation must state that it keeps data on disk.");

  fs.rmSync(root, { recursive: true, force: true });
  console.log("alpha-loop-backup-smoke passed");
}

main().catch((error) => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  console.error(error);
  process.exit(1);
});
