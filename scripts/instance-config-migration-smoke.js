const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-instance-schema-"));
const service = require("../src/shared/instances/instanceServiceCore");
service.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });

function filePath(id) {
  return path.join(root, id, "config.json");
}

function writeFixture(id, value) {
  fs.mkdirSync(path.dirname(filePath(id)), { recursive: true });
  fs.writeFileSync(filePath(id), `${JSON.stringify(value, null, 2)}\n`);
}

function hashFile(target) {
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

async function main() {
  const build199Fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "build199-instance-config.json"), "utf8"));
  writeFixture(build199Fixture.id, build199Fixture);
  const dataMarker = path.join(root, build199Fixture.id, "data", "world-marker.txt");
  fs.mkdirSync(path.dirname(dataMarker), { recursive: true });
  fs.writeFileSync(dataMarker, "preserve-build199-data\n");

  const migratedBuild199 = await service.getStatus(build199Fixture.id);
  assert.strictEqual(migratedBuild199.id, build199Fixture.id);
  const migratedBuild199Raw = JSON.parse(fs.readFileSync(filePath(build199Fixture.id), "utf8"));
  assert.strictEqual(migratedBuild199Raw.schemaVersion, service.INSTANCE_CONFIG_SCHEMA_VERSION, "Build 199 schema 1 records must migrate to Build 200 schema.");
  assert.deepStrictEqual(migratedBuild199Raw.build199Extension, build199Fixture.build199Extension, "Migration must preserve unknown Build 199 metadata.");
  assert.strictEqual(fs.readFileSync(dataMarker, "utf8"), "preserve-build199-data\n", "Migration must not alter instance data.");
  const build199BackupPath = `${filePath(build199Fixture.id)}.schema-v1.backup`;
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(build199BackupPath, "utf8")), build199Fixture, "Migration backup must preserve the exact Build 199 record.");
  const firstBackup = fs.readFileSync(build199BackupPath, "utf8");
  await service.getStatus(build199Fixture.id);
  assert.strictEqual(fs.readFileSync(build199BackupPath, "utf8"), firstBackup, "Migration reruns must not replace the original backup.");

  const representativeRecords = [
    {
      ...build199Fixture,
      id: "build199-running",
      displayName: "Build 199 Running Record",
      state: "Running",
      pid: 999999,
      marketplace: { provider: "modrinth", projectId: "fixture-project", installedVersion: "1.2.3", unknownProviderField: "preserve" },
      build199Extension: { preserve: true, lifecycle: "running" },
    },
    {
      ...build199Fixture,
      id: "build199-failed",
      displayName: "Build 199 Failed Install",
      installationState: "installing",
      installStage: "download",
      installationOperationId: "build199-operation",
      lastInstallAttemptAt: "2026-09-04T09:20:00.000Z",
      marketplace: { provider: "curseforge", projectId: "fixture-pack", fileId: "fixture-file" },
      build199Extension: { preserve: true, lifecycle: "interrupted-install" },
    },
  ];
  for (const record of representativeRecords) writeFixture(record.id, record);
  service._test.setProcessAliveProvider(() => false);
  const recovery = await service.recoverIncompleteInstallations();
  service._test.setProcessAliveProvider(null);
  assert(recovery.repaired.some((entry) => entry.instanceId === "build199-failed"), "Interrupted Build 199 installs must be retained and recovered.");

  const inventory = await service.listInstances();
  const inventoryIds = inventory.instances.map((entry) => entry.id);
  for (const expectedId of [build199Fixture.id, "build199-running", "build199-failed"]) {
    assert(inventoryIds.includes(expectedId), `Migrated inventory must retain ${expectedId}.`);
    assert(fs.existsSync(`${filePath(expectedId)}.schema-v1.backup`), `Schema-1 backup must exist for ${expectedId}.`);
  }
  const runningRaw = JSON.parse(fs.readFileSync(filePath("build199-running"), "utf8"));
  assert.deepStrictEqual(runningRaw.marketplace, representativeRecords[0].marketplace, "Marketplace metadata and unknown provider fields must survive migration.");
  assert.deepStrictEqual(runningRaw.build199Extension, representativeRecords[0].build199Extension, "Unknown running-record fields must survive migration.");
  assert.strictEqual(runningRaw.pid, null, "A stale Build 199 running PID must be reconciled after restart.");
  assert.notStrictEqual(runningRaw.state, "Running", "A missing Build 199 process must not remain falsely Running.");
  const failedRaw = JSON.parse(fs.readFileSync(filePath("build199-failed"), "utf8"));
  assert.strictEqual(failedRaw.installationState, "failed", "Interrupted Build 199 installs must remain inspectable as failed.");
  assert.strictEqual(failedRaw.installStage, "interrupted");
  assert.match(failedRaw.lastInstallError, /^INSTALLATION_INTERRUPTED:/);
  assert.deepStrictEqual(failedRaw.marketplace, representativeRecords[1].marketplace, "Failed-install Marketplace metadata must survive recovery.");

  const migratedHashes = new Map([build199Fixture.id, "build199-running", "build199-failed"].map((id) => [id, hashFile(filePath(id))]));
  service.disposeInstanceService();
  service.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });
  await service.listInstances();
  await service.recoverIncompleteInstallations();
  for (const [id, hash] of migratedHashes) {
    assert.strictEqual(hashFile(filePath(id)), hash, `Restart and migration rerun must not mutate already migrated ${id}.`);
  }

  const created = await service.createInstance({ id: "schema-smoke", displayName: "Schema Smoke", type: "node-app", executable: "node", args: ["app.js"] });
  let persisted = JSON.parse(fs.readFileSync(filePath(created.id), "utf8"));
  assert.strictEqual(persisted.schemaVersion, service.INSTANCE_CONFIG_SCHEMA_VERSION, "New instance metadata should include the current schema version.");

  delete persisted.schemaVersion;
  fs.writeFileSync(filePath(created.id), `${JSON.stringify(persisted, null, 2)}\n`);
  await service.getStatus(created.id);
  const backupPath = `${filePath(created.id)}.schema-v0.backup`;
  assert(fs.existsSync(backupPath), "Legacy instance migration should preserve the original file.");
  assert.strictEqual(JSON.parse(fs.readFileSync(backupPath, "utf8")).schemaVersion, undefined, "Migration backup should contain the legacy payload.");
  assert.strictEqual(JSON.parse(fs.readFileSync(filePath(created.id), "utf8")).schemaVersion, service.INSTANCE_CONFIG_SCHEMA_VERSION, "Legacy metadata should migrate to the current schema.");

  persisted = JSON.parse(fs.readFileSync(filePath(created.id), "utf8"));
  persisted.schemaVersion = service.INSTANCE_CONFIG_SCHEMA_VERSION + 1;
  const futureRaw = `${JSON.stringify(persisted, null, 2)}\n`;
  fs.writeFileSync(filePath(created.id), futureRaw);
  await assert.rejects(() => service.getStatus(created.id), (error) => error.code === "INSTANCE_CONFIG_SCHEMA_UNSUPPORTED");
  assert.strictEqual(fs.readFileSync(filePath(created.id), "utf8"), futureRaw, "Unknown future instance metadata must remain unchanged.");

  const malformedPath = filePath("malformed-smoke");
  fs.mkdirSync(path.dirname(malformedPath), { recursive: true });
  const malformedRaw = "{ this is not valid JSON\n";
  fs.writeFileSync(malformedPath, malformedRaw);
  await assert.rejects(() => service.getStatus("malformed-smoke"), (error) => error.code === "INSTANCE_CONFIG_UNREADABLE");
  assert.strictEqual(fs.readFileSync(malformedPath, "utf8"), malformedRaw, "Malformed persisted configuration must remain untouched for recovery.");
  console.log(JSON.stringify({
    status: "PASS",
    classification: "FIXTURE MIGRATION VERIFIED",
    migratedInstances: [build199Fixture.id, "build199-running", "build199-failed"],
    schema1Backups: 3,
    inventoryCount: inventory.instances.length,
    staleRunningRecordReconciled: true,
    interruptedInstallRetained: true,
    unknownFieldsPreserved: true,
    restartIdempotent: true,
    malformedAndFutureSchemasProtected: true,
  }, null, 2));
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
