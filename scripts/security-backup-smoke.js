const assert = require("assert");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const fsPromises = require("fs/promises");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxhub-security-backup-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
process.env.AGENT_INSTANCE_ROOT = path.join(root, "instances");
process.env.AGENT_BACKUP_ROOT = path.join(root, "backups");

const securityPath = require.resolve("../src/services/securityService");
let security = require(securityPath);
const nodeService = require("../src/services/nodeService");
const serviceRouter = require("../src/services/serviceRouter");
const storageConnections = require("../src/services/storageConnectionService");
const { FileService } = require("../src/services/fileService");
const backupService = require("../agent/src/services/backupService");
const backupInstanceService = require("../agent/src/services/instances/instanceService");
const longOperations = require("../src/shared/longOperationService");
const { resetLocalPassword } = require("./reset-local-password");

function countAuditActions(action) {
  const auditPath = path.join(process.env.ANXHUB_CONFIG_DIR, "audit.log");
  if (!fs.existsSync(auditPath)) {
    return 0;
  }
  return fs.readFileSync(auditPath, "utf8")
    .trim()
    .split(/\n+/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.action === action)
    .length;
}

async function main() {
  const agentServerSource = fs.readFileSync(path.join(__dirname, "..", "agent", "src", "server.js"), "utf8");
  const recoveryIndex = agentServerSource.indexOf("await recoverBackupArtifacts()");
  const listenIndex = agentServerSource.indexOf("server.listen(");
  assert(recoveryIndex >= 0 && recoveryIndex < listenIndex, "Agent backup recovery must finish before the HTTP listener accepts work.");
  const firstRunStatus = security.getStatus();
  assert.strictEqual(firstRunStatus.setupRequired, true, "Fresh config should not have Remote Control enabled yet.");
  assert.strictEqual(firstRunStatus.localMode, true, "Fresh config should default to Single-Device Mode.");
  assert.strictEqual(firstRunStatus.authenticated, false, "Single-Device Mode should not require sign-in.");
  assert.strictEqual(security.requirePermission("instance:lifecycle", "local-smoke").localMode, true, "Local mode should allow local actions without an owner account.");
  const defaultNodes = await nodeService.listNodes({ discoverLocalAgent: false, refreshIdentity: false });
  assert.strictEqual(defaultNodes.selectedNodeId, "application-host", "The selected node should default to the application host.");
  assert(defaultNodes.nodes.some((node) => node.id === "application-host" && node.kind === "application-host"), "The application host should be a distinct visible node.");
  const localInstances = await serviceRouter.listInstances({ nodeId: "application-host" });
  assert(Array.isArray(localInstances.instances), "Dashboard/instances should work against the local node without account/session/token.");
  const localNodeTest = await nodeService.testNode("application-host");
  assert.strictEqual(localNodeTest.connected, true, "The local node health check should pass without contacting an agent.");
  const fileService = new FileService();
  const localFiles = await fileService.list({ storageId: "local", path: root });
  assert.strictEqual(localFiles.provider, "local", "Local provider should list local files through the storage API.");
  const savedStorage = storageConnections.saveConnection({
    provider: "sftp",
    name: "Kinetic Smoke",
    host: "sftp.example.test",
    port: 22,
    username: "abc123",
    authType: "password",
    password: "super-secret-storage-password",
    rootDirectory: "/home/container",
  });
  assert(savedStorage.connection.id, "SFTP storage connection should be saved.");
  const storageFile = fs.readFileSync(path.join(process.env.ANXHUB_CONFIG_DIR, "storage-connections.json"), "utf8");
  assert(!storageFile.includes("super-secret-storage-password"), "Storage credentials must not be stored in plain text.");
  const listedStorage = storageConnections.listConnections();
  assert(listedStorage.connections.some((connection) => connection.provider === "sftp" && connection.hasPassword), "Saved SFTP connection should expose metadata without secrets.");
  assert.strictEqual(storageConnections.deleteConnection(savedStorage.connection.id).deleted, true, "SFTP storage connection delete should work.");
  const storagePath = path.join(process.env.ANXHUB_CONFIG_DIR, "storage-connections.json");
  const validStorageRaw = fs.readFileSync(storagePath, "utf8");
  assert.strictEqual(JSON.parse(validStorageRaw).schemaVersion, storageConnections.STORAGE_CONNECTIONS_SCHEMA_VERSION, "Storage connection writes must include the current schema.");
  fs.writeFileSync(storagePath, `${JSON.stringify({ schemaVersion: storageConnections.STORAGE_CONNECTIONS_SCHEMA_VERSION + 1, connections: [] })}\n`);
  const futureStorageRaw = fs.readFileSync(storagePath, "utf8");
  assert.throws(
    () => storageConnections.listConnections(),
    (error) => error?.code === "STORAGE_CONNECTION_SCHEMA_UNSUPPORTED",
    "Future storage connection schemas must fail closed.",
  );
  assert.strictEqual(fs.readFileSync(storagePath, "utf8"), futureStorageRaw, "Future storage connection state must remain unchanged.");
  fs.writeFileSync(storagePath, "{not-json\n");
  assert.throws(
    () => storageConnections.listConnections(),
    (error) => error?.code === "STORAGE_CONNECTION_STORE_CORRUPT",
    "Corrupt storage connection state must fail closed.",
  );
  assert(fs.readdirSync(process.env.ANXHUB_CONFIG_DIR).some((name) => name.startsWith("storage-connections.json.corrupt-")), "Corrupt storage connection state should be preserved.");
  fs.writeFileSync(storagePath, validStorageRaw, { mode: 0o600 });

  await security.setupAdmin({ username: "owner", password: "correct horse battery staple", staySignedIn: true });
  const status = security.getStatus();
  assert.strictEqual(status.setupRequired, false, "Owner setup should complete.");
  assert.strictEqual(status.remoteControlEnabled, true, "Owner setup should enable Remote Control.");
  assert.strictEqual(status.user.role, "Owner", "First user should be Owner.");
  assert.strictEqual(status.persistentSession, true, "Stay signed in should create a persistent session.");
  assert.strictEqual(status.persistentSessionCount, 1, "Persistent session should be tracked.");
  const sessionFile = fs.readFileSync(path.join(process.env.ANXHUB_CONFIG_DIR, "session.dat"), "utf8");
  assert(!sessionFile.includes("correct horse battery staple"), "Persistent session file must not contain the password.");
  delete require.cache[securityPath];
  security = require(securityPath);
  const restoredStatus = security.getStatus();
  assert.strictEqual(restoredStatus.authenticated, true, "Persistent session should restore after relaunch.");
  assert.strictEqual(restoredStatus.user.username, "owner", "Restored session should belong to the Owner.");
  const securityConfigPath = path.join(process.env.ANXHUB_CONFIG_DIR, "security.json");
  const securityConfig = JSON.parse(fs.readFileSync(securityConfigPath, "utf8"));
  securityConfig.users[0].passwordHash = bcrypt.hashSync("new correct horse battery staple", 12);
  fs.writeFileSync(securityConfigPath, `${JSON.stringify(securityConfig, null, 2)}\n`);
  delete require.cache[securityPath];
  security = require(securityPath);
  const passwordChangedStatus = security.getStatus();
  assert.strictEqual(passwordChangedStatus.authenticated, false, "Owner password changes should invalidate remembered sessions.");
  await security.login({ username: "owner", password: "new correct horse battery staple", staySignedIn: true });
  delete require.cache[securityPath];
  security = require(securityPath);
  assert.strictEqual(security.getStatus().authenticated, true, "New remembered session should restore.");
  security.logoutAllSessions();
  delete require.cache[securityPath];
  security = require(securityPath);
  const invalidatedStatus = security.getStatus();
  assert.strictEqual(invalidatedStatus.authenticated, false, "Log out of all sessions should invalidate persistent restore.");
  await security.login({ username: "owner", password: "new correct horse battery staple" });
  const rotated = security.rotateAgentToken();
  assert.strictEqual(rotated.configured, true, "Agent token should be rotated through the shared token store.");
  assert(rotated.fingerprint && !rotated.token, "Agent token rotation should return only safe status metadata.");
  assert.strictEqual(rotated.restartRequired, true, "Agent token rotation should require app and agent restart.");
  const nodes = await nodeService.listNodes();
  assert(nodes.nodes.some((node) => node.kind === "application-host"), "Security context should retain the explicit application host node.");
  security.logout();
  await assert.rejects(
    () => security.login({ username: "owner", password: "wrong password 1" }),
    /Invalid username or password/,
    "A failed login should be rejected without logging in.",
  );
  await assert.rejects(
    () => security.login({ username: "owner", password: "wrong password 2" }),
    /Invalid username or password/,
    "A second failed login should be rejected.",
  );
  await security.login({ username: "owner", password: "new correct horse battery staple" });
  const loginAuditCount = countAuditActions("security.login");
  await security.login({ username: "owner", password: "wrong password while already signed in" });
  assert.strictEqual(
    countAuditActions("security.login"),
    loginAuditCount,
    "Duplicate login calls while already authenticated should not create extra login audit entries.",
  );
  security.logout();
  await security.login({ username: "owner", password: "new correct horse battery staple" });
  security.logout();
  for (let index = 0; index < 6; index += 1) {
    await assert.rejects(
      () => security.login({ username: "owner", password: `wrong password ${index + 3}` }),
      /Invalid username or password/,
      "Failed login attempts before the limit should return credential errors.",
    );
  }
  await assert.rejects(
    () => security.login({ username: "owner", password: "new correct horse battery staple" }),
    /Too many requests|RATE_LIMITED/,
    "Rate limiting should only block after genuine repeated failed attempts.",
  );

  const securityFile = path.join(process.env.ANXHUB_CONFIG_DIR, "security.json");
  fs.writeFileSync(path.join(process.env.ANXHUB_CONFIG_DIR, "session.dat"), "stale-session");
  const resetResult = resetLocalPassword({
    securityPath: securityFile,
    username: "owner",
    password: "reset correct horse battery",
  });
  assert(fs.existsSync(resetResult.backupPath), "Password reset should create a security.json backup.");
  assert(!fs.existsSync(path.join(process.env.ANXHUB_CONFIG_DIR, "session.dat")), "Password reset should clear remembered session data.");
  delete require.cache[securityPath];
  security = require(securityPath);
  await security.login({ username: "owner", password: "reset correct horse battery" });
  security.logout();

  security.checkRateLimit("smoke-limit", 1, 60000);
  assert.throws(() => security.checkRateLimit("smoke-limit", 1, 60000), /Too many requests|RATE_LIMITED/);

  const instanceId = "smoke-instance";
  const instancePath = path.join(process.env.AGENT_INSTANCE_ROOT, instanceId);
  fs.mkdirSync(path.join(instancePath, "data", "world"), { recursive: true });
  fs.writeFileSync(path.join(instancePath, "config.json"), JSON.stringify({ id: instanceId, displayName: "Smoke", state: "Stopped" }));
  fs.writeFileSync(path.join(instancePath, "data", "world", "level.dat"), "world");

  const originalStatfs = fsPromises.statfs;
  fsPromises.statfs = async () => ({ bsize: 4096, bavail: 0 });
  await assert.rejects(
    () => backupService.createBackup({ instanceId, type: "world", name: "Full disk", createdBy: "smoke" }),
    (error) => error?.code === "BACKUP_DISK_SPACE_INSUFFICIENT" && error?.statusCode === 507,
    "Backup creation should fail before archive work when the destination volume has insufficient space.",
  );
  fsPromises.statfs = originalStatfs;

  // Concurrent create/restore operations against the same instance must not race:
  // the shared long-operation registry should reject the second call while the
  // first is still running, instead of letting both mutate instance files at once.
  const concurrentAttempts = await Promise.allSettled([
    backupService.createBackup({ instanceId, type: "world", name: "Concurrent A", createdBy: "smoke" }),
    backupService.createBackup({ instanceId, type: "world", name: "Concurrent B", createdBy: "smoke" }),
  ]);
  const fulfilled = concurrentAttempts.filter((result) => result.status === "fulfilled");
  const rejected = concurrentAttempts.filter((result) => result.status === "rejected");
  assert.strictEqual(fulfilled.length, 1, "Only one of two concurrent backup creations for the same instance should succeed.");
  assert.strictEqual(rejected.length, 1, "The second concurrent backup creation for the same instance should be rejected.");
  assert.strictEqual(rejected[0].reason?.code, "BACKUP_OPERATION_IN_PROGRESS", "Rejected concurrent backup creation should use a dedicated conflict error code.");
  await backupService.deleteBackup(fulfilled[0].value.backup.id);
  const afterConcurrencyCheck = await backupService.listBackups({ instanceId });
  assert.strictEqual(afterConcurrencyCheck.backups.length, 0, "Concurrency check backup should be cleaned up before the main backup assertions.");
  const retriedAfterLockRelease = await backupService.createBackup({ instanceId, type: "world", name: "After lock release", createdBy: "smoke" });
  assert(retriedAfterLockRelease.backup.id, "A new backup for the same instance should succeed once the prior operation has completed.");
  await backupService.deleteBackup(retriedAfterLockRelease.backup.id);

  // Retry must perform a genuinely new execution attempt, not merely flip a
  // status flag back to a success-looking state. Fail deterministically
  // against a not-yet-created instance directory, fix the real condition that
  // caused the failure, then retry through the shared framework and confirm a
  // brand-new operation record (and a real archive) is produced while the
  // original failed record is left untouched.
  const retryInstanceId = "retry-smoke-instance";
  await assert.rejects(
    () => backupService.createBackup({ instanceId: retryInstanceId, type: "full", name: "Retry smoke", createdBy: "smoke" }),
    (error) => error?.code === "INSTANCE_NOT_FOUND",
    "Backing up a non-existent instance directory should fail deterministically.",
  );
  const failedRetryOperation = longOperations
    .listOperations({ kind: "backup-create" })
    .filter((operation) => operation.metadata?.instanceId === retryInstanceId && operation.status === "failed")
    .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))[0];
  assert(failedRetryOperation, "The failed backup-create attempt should be recorded in the shared operation registry.");
  assert.strictEqual(failedRetryOperation.canRetry, true, "A failed backup-create operation should be marked retryable.");
  const retryInstancePath = path.join(process.env.AGENT_INSTANCE_ROOT, retryInstanceId);
  fs.mkdirSync(path.join(retryInstancePath, "data", "world"), { recursive: true });
  fs.writeFileSync(path.join(retryInstancePath, "config.json"), JSON.stringify({ id: retryInstanceId, displayName: "Retry Smoke", state: "Stopped" }));
  fs.writeFileSync(path.join(retryInstancePath, "data", "world", "level.dat"), "retry-world");
  const retryResult = await longOperations.retryOperation(failedRetryOperation.id);
  assert(retryResult?.backup?.id, "Retrying through the shared framework should produce a real, successful backup result.");
  const stillFailedOriginal = longOperations.getOperation(failedRetryOperation.id);
  assert.strictEqual(stillFailedOriginal.status, "failed", "The original failed operation record must remain untouched by a retry, proving retry created a new attempt rather than mutating the old one.");
  const newRetryOperation = longOperations
    .listOperations({ kind: "backup-create" })
    .find((operation) => operation.metadata?.backupId === retryResult.backup.id);
  assert(newRetryOperation, "A retry should be tracked as a distinct new operation record.");
  assert.notStrictEqual(newRetryOperation.id, failedRetryOperation.id, "Retry must create a new operation id, not reuse the failed one.");
  assert.strictEqual(newRetryOperation.status, "complete", "The new retry attempt should complete successfully once the underlying failure condition is fixed.");
  await backupService.deleteBackup(retryResult.backup.id);
  fs.rmSync(retryInstancePath, { recursive: true, force: true });

  const created = await backupService.createBackup({ instanceId, type: "world", name: "Smoke world", createdBy: "smoke" });
  assert(created.backup.id, "Backup should have an id.");
  assert.strictEqual(created.backup.type, "world", "World backup type should persist.");
  assert(created.backup.sourcePaths.includes("data/world"), "World backup should include world path.");
  assert(created.backup.uncompressedSize >= 5, "Backup metadata should include uncompressed size.");
  assert(created.backup.requiredDiskSpace >= created.backup.uncompressedSize, "Backup metadata should include required restore disk space.");
  assert.strictEqual(created.backup.schemaVersion, backupService.BACKUP_METADATA_SCHEMA_VERSION, "New backup metadata should use the current schema.");
  const list = await backupService.listBackups({ instanceId });
  assert.strictEqual(list.backups.length, 1, "Backup list should include created backup.");
  assert.strictEqual(list.backups[0].entryCount > 0, true, "Backup list should preserve archive entry count.");
  fs.writeFileSync(path.join(instancePath, "data", "world", "level.dat"), "changed");
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: created.backup.id }),
    (error) => error?.code === "RESTORE_OVERWRITE_CONFIRMATION_REQUIRED",
    "Restore should require explicit overwrite confirmation.",
  );
  const originalGetStatus = backupInstanceService.getStatus;
  const originalStopInstance = backupInstanceService.stopInstance;
  backupInstanceService.getStatus = async () => ({ state: "Running", pid: 4242 });
  backupInstanceService.stopInstance = async () => {
    const error = new Error("process refused to stop");
    error.code = "INSTANCE_STOP_TIMEOUT";
    throw error;
  };
  await assert.rejects(
    () => backupService.restoreBackup({ backupId: created.backup.id, confirmOverwrite: true }),
    (error) => error?.code === "RESTORE_INSTANCE_STOP_FAILED" && error?.details?.causeCode === "INSTANCE_STOP_TIMEOUT",
    "Restore must abort before touching files when a running instance cannot be stopped.",
  );
  assert.strictEqual(fs.readFileSync(path.join(instancePath, "data", "world", "level.dat"), "utf8"), "changed", "A failed stop must leave instance data untouched.");
  backupInstanceService.getStatus = originalGetStatus;
  backupInstanceService.stopInstance = originalStopInstance;
  const oversizedNonWorldFile = path.join(instancePath, "data", "large-server-runtime.bin");
  fs.writeFileSync(oversizedNonWorldFile, "");
  fs.truncateSync(oversizedNonWorldFile, (512 * 1024 * 1024) + 1);
  const restored = await backupService.restoreBackup({ backupId: created.backup.id, confirmOverwrite: true });
  assert.strictEqual(restored.restore.instanceId, instanceId, "Restore should target the original instance.");
  assert(restored.restore.safetyBackupId, "Restore should create a safety snapshot before replacing files.");
  assert.strictEqual(fs.readFileSync(path.join(instancePath, "data", "world", "level.dat"), "utf8"), "world", "World restore should replace changed world files.");
  fs.writeFileSync(path.join(instancePath, "data", "world", "level.dat"), "partially-restored-corruption");
  const safetyMetadata = (await backupService.listBackups({ instanceId })).backups.find((entry) => entry.id === restored.restore.safetyBackupId);
  assert.strictEqual(safetyMetadata.type, "world", "World restore safety snapshots must remain world-only so large server runtimes do not block restoring small world backups.");
  assert(!safetyMetadata.sourcePaths.includes("data/large-server-runtime.bin"), "World restore safety snapshots must exclude unrelated server runtime files.");
  assert(restored.restore.requiredDiskSpace < (512 * 1024 * 1024), "World restore disk accounting must remain scoped to the restored archive rather than unrelated instance files.");
  const rollback = await backupService._test.rollbackRestoreFromSafetySnapshot(instancePath, safetyMetadata);
  assert.strictEqual(rollback.rolledBack, true, "Restore rollback should replace a partial restore with the safety snapshot.");
  assert.strictEqual(fs.readFileSync(path.join(instancePath, "data", "world", "level.dat"), "utf8"), "changed", "Rollback should recover the exact pre-restore instance data.");
  const imported = await backupService.importBackup({
    instanceId,
    content: fs.readFileSync(list.backups[0].path).toString("base64"),
    encoding: "base64",
    name: "Imported smoke backup",
  });
  assert.strictEqual(imported.backup.status, "imported", "Valid imported archives should be accepted.");
  await assert.rejects(
    () => backupService.importBackup({ instanceId, content: Buffer.from("not a tarball").toString("base64"), encoding: "base64" }),
    (error) => error?.code === "BACKUP_ARCHIVE_INVALID",
    "Invalid imported archives should be rejected.",
  );
  const schedulesPath = path.join(process.env.AGENT_BACKUP_ROOT, "schedules.json");
  fs.writeFileSync(schedulesPath, `${JSON.stringify({ schedules: [{ instanceId, intervalHours: 12, type: "world" }] })}\n`, { mode: 0o600 });
  assert.strictEqual((await backupService.listSchedules()).schedules.length, 1, "Legacy backup schedules should survive migration.");
  assert.strictEqual(JSON.parse(fs.readFileSync(schedulesPath, "utf8")).schemaVersion, backupService.BACKUP_SCHEDULE_SCHEMA_VERSION, "Legacy schedules should migrate to the current schema.");
  assert(fs.existsSync(`${schedulesPath}.schema-v0.backup`), "Legacy schedule migration should preserve the original file.");

  const schedule = await backupService.saveSchedule({ instanceId, intervalHours: 24, keepLast: 3, maxAgeDays: 7, type: "world" });
  assert.strictEqual(schedule.schedule.instanceId, instanceId, "Schedule should target the instance.");
  const schedules = await backupService.listSchedules();
  assert.strictEqual(schedules.schedules.length, 1, "Schedule list should include saved schedule.");
  await backupService.deleteSchedule(instanceId);
  assert.strictEqual((await backupService.listSchedules()).schedules.length, 0, "Schedule delete should remove saved schedule.");
  const futureSchedules = { schemaVersion: backupService.BACKUP_SCHEDULE_SCHEMA_VERSION + 1, schedules: [] };
  fs.writeFileSync(schedulesPath, `${JSON.stringify(futureSchedules)}\n`, { mode: 0o600 });
  const futureSchedulesRaw = fs.readFileSync(schedulesPath, "utf8");
  await assert.rejects(() => backupService.listSchedules(), (error) => error?.code === "BACKUP_SCHEDULE_SCHEMA_UNSUPPORTED", "Future backup schedule schemas must fail safely.");
  assert.strictEqual(fs.readFileSync(schedulesPath, "utf8"), futureSchedulesRaw, "Future backup schedule state must remain unchanged.");
  fs.writeFileSync(schedulesPath, "{not-json\n", { mode: 0o600 });
  await assert.rejects(() => backupService.listSchedules(), (error) => error?.code === "BACKUP_SCHEDULE_STORE_CORRUPT", "Corrupt backup schedules must not silently disable all schedules.");
  assert(fs.readdirSync(process.env.AGENT_BACKUP_ROOT).some((name) => name.startsWith("schedules.json.corrupt-")), "Corrupt backup schedules should be preserved.");

  const futureMetadataId = "future-metadata-123456";
  const futureMetadataPath = path.join(process.env.AGENT_BACKUP_ROOT, `${futureMetadataId}.json`);
  fs.writeFileSync(futureMetadataPath, `${JSON.stringify({ schemaVersion: backupService.BACKUP_METADATA_SCHEMA_VERSION + 1, id: futureMetadataId, instanceId })}\n`, { mode: 0o600 });
  const corruptMetadataId = "corrupt-metadata-123456";
  fs.writeFileSync(path.join(process.env.AGENT_BACKUP_ROOT, `${corruptMetadataId}.json`), "{not-json\n", { mode: 0o600 });
  const metadataDiagnostics = (await backupService.listBackups({ instanceId })).diagnostics.metadataErrors;
  assert(metadataDiagnostics.some((entry) => entry.code === "BACKUP_METADATA_SCHEMA_UNSUPPORTED"), "Future backup metadata should be reported in diagnostics.");
  assert(metadataDiagnostics.some((entry) => entry.code === "BACKUP_METADATA_CORRUPT"), "Corrupt backup metadata should be reported in diagnostics.");
  assert.strictEqual(fs.readFileSync(futureMetadataPath, "utf8").includes(`"schemaVersion":${backupService.BACKUP_METADATA_SCHEMA_VERSION + 1}`), true, "Future backup metadata must remain unchanged.");
  await backupService.deleteBackup(created.backup.id);
  await backupService.deleteBackup(imported.backup.id);
  await backupService.deleteBackup(restored.restore.safetyBackupId);
  const afterDelete = await backupService.listBackups({ instanceId });
  assert.strictEqual(afterDelete.backups.length, 0, "Backup delete should remove metadata and archive.");
  const staleDelete = await backupService.deleteBackup(created.backup.id);
  assert.strictEqual(staleDelete.alreadyDeleted, true, "Deleting a stale backup should be idempotent.");

  const legacySecurity = JSON.parse(fs.readFileSync(securityFile, "utf8"));
  delete legacySecurity.schemaVersion;
  fs.writeFileSync(securityFile, `${JSON.stringify(legacySecurity)}\n`, { mode: 0o600 });
  assert.strictEqual(security.getStatus().setupRequired, false, "Legacy security state should preserve the configured Owner during migration.");
  assert.strictEqual(JSON.parse(fs.readFileSync(securityFile, "utf8")).schemaVersion, security.SECURITY_SCHEMA_VERSION, "Legacy security state should migrate to the current schema.");
  assert(fs.existsSync(`${securityFile}.schema-v0.backup`), "Legacy security migration should preserve the original file.");
  const validSecurityRaw = fs.readFileSync(securityFile, "utf8");
  const futureSecurity = { ...JSON.parse(validSecurityRaw), schemaVersion: security.SECURITY_SCHEMA_VERSION + 1 };
  fs.writeFileSync(securityFile, `${JSON.stringify(futureSecurity)}\n`, { mode: 0o600 });
  const futureSecurityRaw = fs.readFileSync(securityFile, "utf8");
  assert.throws(
    () => security.getStatus(),
    (error) => error?.code === "SECURITY_SCHEMA_UNSUPPORTED",
    "Future security schemas must fail closed instead of being treated as first run.",
  );
  assert.strictEqual(fs.readFileSync(securityFile, "utf8"), futureSecurityRaw, "Future security state must remain unchanged.");
  fs.writeFileSync(securityFile, "{not-json\n", { mode: 0o600 });
  assert.throws(
    () => security.getStatus(),
    (error) => error?.code === "SECURITY_STORE_CORRUPT",
    "Corrupt security state must fail closed instead of removing authentication policy.",
  );
  assert(fs.readdirSync(path.dirname(securityFile)).some((name) => name.startsWith(`${path.basename(securityFile)}.corrupt-`)), "Corrupt security state should be preserved.");
  fs.writeFileSync(securityFile, validSecurityRaw, { mode: 0o600 });

  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  [
    "function promptBackupText",
    "function chooseBackupType",
    "function parseBackupWholeNumber",
    "createSecurityTextPrompt({ title, message, label, initialValue, confirmLabel })",
    "Restart after restore?",
    "Backup schedule values are invalid.",
  ].forEach((needle) => assert(appSource.includes(needle), `Backup renderer modal guard missing: ${needle}`));
  [
    "createBackupForInstance",
    "restoreSelectedBackup",
    "importBackupForInstance",
    "configureBackupSchedule",
  ].forEach((functionName) => {
    const start = appSource.indexOf(`async function ${functionName}`);
    assert(start >= 0, `Renderer should define ${functionName}.`);
    const open = appSource.indexOf("{", start);
    let depth = 0;
    let body = "";
    for (let index = open; index < appSource.length; index += 1) {
      const char = appSource[index];
      if (char === "{") depth += 1;
      if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          body = appSource.slice(start, index + 1);
          break;
        }
      }
    }
    assert(!/window\.prompt|prompt\(|window\.confirm|confirm\(/.test(body), `${functionName} should use AnxOS modals instead of browser dialogs.`);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log("Security and backup smoke checks passed.");
}

main().catch((error) => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
  console.error(error);
  process.exit(1);
});
