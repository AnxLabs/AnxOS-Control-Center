// V2-F wave 5: backup destinations smoke.
//
// Hermetic: pins every runtime root under one temp tree, injects an in-memory
// SFTP transport, a fake credential resolver, and a fixed AES-256-GCM key, so
// no network, no real credential vault, and no machine root is touched.
//
// Covers: local default destination, destination CRUD + per-root isolation,
// push success (pushed state + decrypt round-trip + sha256 verified), push
// failure that leaves the local backup intact, missing credentials, missing
// encryption key, restore-from-remote end to end (push -> delete local ->
// download/decrypt/verify -> restore), tampered archive/manifest refused before
// mutation, and that the encryption key never appears in metadata/logs/errors.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Pin roots BEFORE any src/ or agent service module loads.
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const smokeRoot = pinAgentRoots("anx-backup-destinations-");
process.env.AGENT_BACKUP_ROOT = path.join(smokeRoot, "backups");
delete process.env.AGENT_BACKUP_ENCRYPTION_KEY;

const backupService = require("../agent/src/services/backupService");
const destinationService = require("../agent/src/services/backupDestinationService");
const { handleBackups } = require("../agent/src/routes/backups");

const BACKUP_ROOT = process.env.AGENT_BACKUP_ROOT;
const SOURCE_ID = "dest-src";
const SFTP_CONNECTION_ID = "sftp-remote-a";
const MISSING_CONNECTION_ID = "sftp-missing";
const SFTP_PASSWORD = "s3cret-remote-password-value";
const ENCRYPTION_KEY = crypto.randomBytes(32);
const ENCRYPTION_KEY_HEX = ENCRYPTION_KEY.toString("hex");
const ENCRYPTION_KEY_BASE64 = ENCRYPTION_KEY.toString("base64");

// ---------------------------------------------------------------------------
// In-memory SFTP transport + credential resolver
// ---------------------------------------------------------------------------
const remoteFiles = new Map();
const transport = {
  uploaded: [],
  failedRemotePaths: new Set(),
  failNextUpload: false,
  async uploadFile({ localPath, remotePath }) {
    if (this.failNextUpload) {
      this.failNextUpload = false;
      throw Object.assign(new Error("simulated sftp upload failure"), { code: "ECONNRESET" });
    }
    if (this.failedRemotePaths.has(remotePath)) {
      throw Object.assign(new Error("simulated sftp upload failure"), { code: "ECONNRESET" });
    }
    remoteFiles.set(remotePath, fs.readFileSync(localPath));
    this.uploaded.push(remotePath);
  },
  async downloadFile({ remotePath, localPath }) {
    if (!remoteFiles.has(remotePath)) {
      throw Object.assign(new Error("no such remote file"), { code: "ENOENT" });
    }
    fs.writeFileSync(localPath, remoteFiles.get(remotePath));
  },
};

async function resolveSftpCredentials(connectionId) {
  if (connectionId === MISSING_CONNECTION_ID) {
    throw Object.assign(new Error("connection not found"), { code: "STORAGE_CONNECTION_NOT_FOUND" });
  }
  return {
    host: "backup.example.invalid",
    port: 2222,
    username: "anx",
    authType: "password",
    password: SFTP_PASSWORD,
    privateKey: null,
    passphrase: null,
    rootDirectory: "/",
  };
}

function configureSmoke(overrides = {}) {
  destinationService.configureBackupDestinationService({
    root: BACKUP_ROOT,
    encryptionKey: ENCRYPTION_KEY_HEX,
    resolveSftpCredentials,
    sftpTransport: transport,
    ...overrides,
  });
}
configureSmoke();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function metadataFilePath(backupId) {
  return path.join(BACKUP_ROOT, `${backupId}.json`);
}

function archiveFilePath(backupId) {
  return path.join(BACKUP_ROOT, `${backupId}.tar.gz`);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readArchive(backupId) {
  return fs.readFileSync(archiveFilePath(backupId));
}

function assertNoSecret(text, label) {
  assert(!String(text).includes(ENCRYPTION_KEY_HEX), `${label}: the raw encryption key must never appear.`);
  assert(!String(text).includes(ENCRYPTION_KEY_BASE64), `${label}: the base64 encryption key must never appear.`);
  assert(!String(text).includes(SFTP_PASSWORD), `${label}: the SFTP password must never appear.`);
}

function instanceDir(instanceId) {
  return path.join(process.env.AGENT_INSTANCE_ROOT, instanceId);
}

function createInstanceDir(instanceId) {
  const instancePath = instanceDir(instanceId);
  fs.mkdirSync(path.join(instancePath, "data", "world"), { recursive: true });
  fs.writeFileSync(path.join(instancePath, "config.json"), `${JSON.stringify({
    id: instanceId,
    displayName: "Backup Destination Source",
    type: "minecraft-paper",
    templateId: "minecraft-paper",
    game: "minecraft",
    state: "Stopped",
    pid: null,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(instancePath, "data", "world", "level.dat"), `${instanceId}-level`);
  return instancePath;
}

function snapshotInstanceTree(instanceId) {
  const files = new Map();
  const base = instanceDir(instanceId);
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile()) files.set(path.relative(base, fullPath).replace(/\\/g, "/"), fs.readFileSync(fullPath, "utf8"));
    }
  };
  walk(base);
  return files;
}

function assertTreesEqual(before, after, label) {
  assert.deepStrictEqual([...after.keys()].sort(), [...before.keys()].sort(), `${label}: instance file set must be unchanged.`);
  for (const [key, value] of before) {
    assert.strictEqual(after.get(key), value, `${label}: instance file ${key} must be unchanged.`);
  }
}

function makeRequest(method, body) {
  return { method, body: body === undefined ? undefined : JSON.stringify(body) };
}

function makeUrl(pathname) {
  return { pathname, searchParams: new URLSearchParams() };
}

async function route(method, pathname, body) {
  return handleBackups(makeRequest(method, body), makeUrl(pathname));
}

async function createAndPushBackup(destinationId) {
  const backup = (await backupService.createBackup({
    instanceId: SOURCE_ID,
    type: "full",
    name: `${SOURCE_ID} destination backup`,
    createdBy: "smoke",
  })).backup;
  const push = await destinationService.pushBackupToDestination(backup.id, { destinationId });
  assert.strictEqual(push.pushState.state, "pushed", `push for ${backup.id} must succeed.`);
  return backup;
}

async function expectFailure(code, operation, label) {
  let failure = null;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  assert(failure, `${label}: expected a ${code} failure.`);
  assert.strictEqual(failure.code, code, `${label}: expected ${code}, saw ${failure.code || failure.message}.`);
  assertNoSecret(failure.message, `${label} error message`);
  assertNoSecret(JSON.stringify(failure.details || {}), `${label} error details`);
  return failure;
}

// ---------------------------------------------------------------------------
async function main() {
  createInstanceDir(SOURCE_ID);

  // --- A. Local default destination + CRUD ---------------------------------
  const initial = await destinationService.listDestinations();
  assert.strictEqual(initial.destinations.length, 1, "Only the local destination exists initially.");
  const local = initial.destinations[0];
  assert.strictEqual(local.id, destinationService.LOCAL_DESTINATION_ID, "The local destination must be the built-in default.");
  assert.strictEqual(local.kind, "local", "The default destination kind must be local.");
  assert.strictEqual(local.builtIn, true, "The local destination must be marked built-in.");
  assert.strictEqual(local.root, path.resolve(BACKUP_ROOT), "The local destination root must be the backup root.");

  await expectFailure("BACKUP_LOCAL_DESTINATION_READ_ONLY", () => destinationService.deleteDestination("local"), "delete local destination");
  await expectFailure("BACKUP_DESTINATION_NOT_FOUND", () => destinationService.deleteDestination("dest-nope"), "delete unknown destination");
  await expectFailure("BACKUP_DESTINATION_NOT_FOUND", () => destinationService.getDestination("dest-nope"), "read unknown destination");
  await expectFailure("BACKUP_DESTINATION_CONNECTION_REQUIRED", () => destinationService.saveDestination({ kind: "sftp", label: "No connection" }), "save without connection");
  await expectFailure("INVALID_BACKUP_DESTINATION_KIND", () => destinationService.saveDestination({ kind: "ftp", connectionId: SFTP_CONNECTION_ID }), "save invalid kind");

  const saved = await destinationService.saveDestination({
    kind: "sftp",
    label: "Remote Offsite A",
    connectionId: SFTP_CONNECTION_ID,
    path: "/backups/anx",
  });
  const destinationId = saved.destination.id;
  assert.strictEqual(saved.destination.kind, "sftp", "Saved destination must be sftp.");
  assert.strictEqual(saved.destination.connectionId, SFTP_CONNECTION_ID, "Saved destination must reference the connection id.");
  assert.strictEqual(saved.destination.path, "/backups/anx", "Saved destination must keep its remote path.");
  assert.strictEqual(saved.destination.enabled, true, "Saved destination must default to enabled.");
  // No credential field may ever leave the agent.
  assert(!("password" in saved.destination) && !("credentials" in saved.destination), "Public destination must not expose credentials.");
  const storeRaw = fs.readFileSync(path.join(BACKUP_ROOT, destinationService.DESTINATIONS_FILENAME), "utf8");
  assertNoSecret(storeRaw, "destination store");
  assert(!storeRaw.includes(SFTP_PASSWORD), "Destination store must not contain the SFTP password.");
  assert(storeRaw.includes(SFTP_CONNECTION_ID), "Destination store must record the connection id reference.");

  const updated = await destinationService.saveDestination({ id: destinationId, label: "Remote Offsite A2" });
  assert.strictEqual(updated.destination.id, destinationId, "Updating a destination must keep its id.");
  assert.strictEqual(updated.destination.label, "Remote Offsite A2", "Updating a destination must change its label.");

  // --- A2. Per-root isolation ---------------------------------------------
  const otherRoot = path.join(smokeRoot, "other-backups");
  destinationService.configureBackupDestinationService({ root: otherRoot });
  const otherList = await destinationService.listDestinations();
  assert.strictEqual(otherList.destinations.length, 1, "A different backup root must not see this root's destinations.");
  assert.strictEqual(otherList.destinations[0].id, "local", "The other root still has its own local default.");
  assert(!fs.existsSync(path.join(otherRoot, destinationService.DESTINATIONS_FILENAME)), "A destination store must never be written for a root without destinations.");
  configureSmoke();
  const restoredList = await destinationService.listDestinations();
  assert.strictEqual(restoredList.destinations.length, 2, "The original root must still hold its local + sftp destinations.");

  // --- B. Route wiring -----------------------------------------------------
  const routeList = await route("GET", "/api/v1/backups/destinations");
  assert.strictEqual(routeList.statusCode, 200, "GET /backups/destinations must be 200.");
  assert.strictEqual(routeList.body.destinations.length, 2, "Route must return both destinations.");

  const routeSave = await route("POST", "/api/v1/backups/destinations", {
    kind: "sftp",
    label: "Route Destination",
    connectionId: SFTP_CONNECTION_ID,
    path: "/backups/route",
  });
  assert.strictEqual(routeSave.statusCode, 201, "POST /backups/destinations must be 201.");
  const routeDestinationId = routeSave.body.destination.id;

  const routeDelete = await route("DELETE", `/api/v1/backups/destinations/${routeDestinationId}`);
  assert.strictEqual(routeDelete.statusCode, 200, "DELETE /backups/destinations/:id must be 200.");
  assert.strictEqual(routeDelete.body.deleted, true, "DELETE must report the deletion.");
  const routeDeleteMissing = await route("DELETE", "/api/v1/backups/destinations/dest-nope");
  assert.strictEqual(routeDeleteMissing.statusCode, 404, "DELETE of an unknown destination must be 404.");
  assert.strictEqual(routeDeleteMissing.body.error.code, "BACKUP_DESTINATION_NOT_FOUND", "DELETE must map the error code.");

  // --- C. Push success + decrypt round-trip + sha256 -----------------------
  const backup = await createAndPushBackup(destinationId);
  assert.strictEqual(backup.archiveSha256, sha256Hex(readArchive(backup.id)), "Create-time digest must match the local archive bytes.");

  const pushedMetadata = readJson(metadataFilePath(backup.id));
  assert.strictEqual(pushedMetadata.pushState.state, "pushed", "Push must be recorded as pushed in the backup metadata.");
  assert(pushedMetadata.pushState.pushedAt, "A pushed pushState must carry pushedAt.");
  assert.strictEqual(pushedMetadata.pushState.destinationId, destinationId, "pushState must name the destination.");
  assert.strictEqual(pushedMetadata.pushState.encrypted, true, "A remote pushState must be marked encrypted.");
  assert.strictEqual(pushedMetadata.pushState.algorithm, "aes-256-gcm", "Remote pushState must record the encryption algorithm.");
  assert(pushedMetadata.pushState.keyId, "Remote pushState must record a keyId fingerprint.");
  assert.strictEqual(pushedMetadata.pushState.keyRef, "env:AGENT_BACKUP_ENCRYPTION_KEY", "Remote pushState must record the key reference.");

  const remoteArchivePath = destinationService._test.remoteArchivePath({ path: "/backups/anx" }, backup.id);
  const remoteManifestPath = destinationService._test.remoteManifestPath({ path: "/backups/anx" }, backup.id);
  assert(remoteFiles.has(remoteArchivePath), "The encrypted archive must be uploaded to the destination.");
  assert(remoteFiles.has(remoteManifestPath), "The manifest must be uploaded to the destination.");

  const manifest = JSON.parse(remoteFiles.get(remoteManifestPath).toString("utf8"));
  assert.strictEqual(manifest.archiveSha256, backup.archiveSha256, "The manifest must carry the archive sha256.");
  assert.strictEqual(manifest.encryption.keyId, pushedMetadata.pushState.keyId, "Manifest and metadata must agree on keyId.");
  assert(!("key" in manifest.encryption), "The manifest must never carry the key itself.");

  const decrypted = destinationService._test.decryptBufferWithKey(remoteFiles.get(remoteArchivePath), ENCRYPTION_KEY);
  assert.strictEqual(sha256Hex(decrypted), backup.archiveSha256, "Decrypt round-trip must reproduce the exact archive sha256.");
  assert.deepStrictEqual(decrypted, readArchive(backup.id), "Decrypt round-trip must reproduce the exact archive bytes.");

  // Key/password must never leak into metadata, manifest, or pushState.
  assertNoSecret(fs.readFileSync(metadataFilePath(backup.id), "utf8"), "backup metadata");
  assertNoSecret(remoteFiles.get(remoteManifestPath).toString("utf8"), "remote manifest");
  assertNoSecret(JSON.stringify(pushedMetadata.pushState), "pushState");

  // --- D. Push failure leaves the local backup intact ----------------------
  transport.failNextUpload = true;
  const failedPush = await destinationService.pushBackupToDestination(backup.id, { destinationId });
  assert.strictEqual(failedPush.pushState.state, "failed", "A failed transfer must be reported as pushState failed.");
  assert.strictEqual(failedPush.pushState.errorCode, "BACKUP_DESTINATION_PUSH_FAILED", "A failed transfer must report its error code.");
  assert.strictEqual(failedPush.pushState.pushedAt, null, "A failed push must not claim a pushedAt.");
  assert(fs.existsSync(archiveFilePath(backup.id)), "The local archive must survive a failed push.");
  const afterFailedPush = await backupService.readBackupMetadata(backup.id);
  assert.strictEqual(afterFailedPush.size, backup.size, "The local backup metadata must survive a failed push.");
  assert.strictEqual(readJson(metadataFilePath(backup.id)).pushState.state, "failed", "The failed pushState must be persisted.");
  // A later successful push overwrites the failed state.
  const rePush = await destinationService.pushBackupToDestination(backup.id, { destinationId });
  assert.strictEqual(rePush.pushState.state, "pushed", "A retried push must be able to reach pushed.");

  // --- E. Missing credentials ---------------------------------------------
  const missingCreds = await destinationService.saveDestination({
    kind: "sftp",
    label: "Missing Credentials",
    connectionId: MISSING_CONNECTION_ID,
    path: "/backups/missing",
  });
  const missingCredsPush = await destinationService.pushBackupToDestination(backup.id, { destinationId: missingCreds.destination.id });
  assert.strictEqual(missingCredsPush.pushState.state, "failed", "An unresolvable credential must fail the push, not the backup.");
  assert.strictEqual(missingCredsPush.pushState.errorCode, "BACKUP_DESTINATION_CREDENTIALS_UNAVAILABLE", "Missing credentials must be reported explicitly.");
  assert(fs.existsSync(archiveFilePath(backup.id)), "The local archive must survive a credential failure.");

  // --- F. Missing encryption key ------------------------------------------
  configureSmoke({ encryptionKey: null });
  const noKeyPush = await destinationService.pushBackupToDestination(backup.id, { destinationId });
  assert.strictEqual(noKeyPush.pushState.state, "failed", "A missing encryption key must fail the push, not the backup.");
  assert.strictEqual(noKeyPush.pushState.errorCode, "BACKUP_ENCRYPTION_KEY_MISSING", "A missing key must be reported explicitly.");
  assert(fs.existsSync(archiveFilePath(backup.id)), "The local archive must survive a missing-key failure.");
  assertNoSecret(JSON.stringify(noKeyPush.pushState), "missing-key pushState");
  configureSmoke();
  const keyRestored = await destinationService.pushBackupToDestination(backup.id, { destinationId });
  assert.strictEqual(keyRestored.pushState.state, "pushed", "Restoring the key must allow the push to succeed.");

  // --- G. Restore from remote, end to end ---------------------------------
  // push -> delete local -> download/decrypt/verify -> restore. The local
  // archive AND metadata are both removed so the restore can only succeed by
  // fetching the remote copy and reconstructing the record from the manifest.
  const restoreBackup = await createAndPushBackup(destinationId);
  const restoreExpectedTree = snapshotInstanceTree(SOURCE_ID);
  await backupService.deleteBackup(restoreBackup.id);
  assert(!fs.existsSync(archiveFilePath(restoreBackup.id)), "Deleting the local backup must remove the local archive.");
  assert(!fs.existsSync(metadataFilePath(restoreBackup.id)), "Deleting the local backup must remove the local metadata.");
  // Mutate the instance so the restore has something to undo.
  fs.writeFileSync(path.join(instanceDir(SOURCE_ID), "data", "world", "level.dat"), "mutated-before-remote-restore");
  assert.notStrictEqual(
    snapshotInstanceTree(SOURCE_ID).get("data/world/level.dat"),
    restoreExpectedTree.get("data/world/level.dat"),
    "The instance must be mutated before the remote restore.",
  );
  const remoteRestore = await route(
    "POST",
    `/api/v1/backups/${restoreBackup.id}/destinations/${destinationId}/restore`,
    { instanceId: SOURCE_ID, confirmOverwrite: true },
  );
  assert.strictEqual(remoteRestore.statusCode, 200, `Remote restore must be 200 (saw ${remoteRestore.statusCode} ${JSON.stringify(remoteRestore.body)}).`);
  assert.strictEqual(remoteRestore.body.restore.backupId, restoreBackup.id, "Remote restore must report the restored backup.");
  assert.strictEqual(remoteRestore.body.restore.instanceId, SOURCE_ID, "Remote restore must report the instance.");
  assert(remoteRestore.body.restore.restoredEntries > 0, "Remote restore must restore entries.");
  assertTreesEqual(restoreExpectedTree, snapshotInstanceTree(SOURCE_ID), "Remote restore must restore the pushed content exactly.");
  assert(fs.existsSync(archiveFilePath(restoreBackup.id)), "Remote restore must recreate the local archive.");
  const recreatedMetadata = readJson(metadataFilePath(restoreBackup.id));
  assert.strictEqual(recreatedMetadata.archiveSha256, restoreBackup.archiveSha256, "Recreated metadata must keep the verified digest.");
  assert.strictEqual(recreatedMetadata.restoredFromDestination.algorithm, "aes-256-gcm", "Recreated metadata must record the encryption algorithm.");
  assert.strictEqual(recreatedMetadata.restoredFromDestination.keyId, pushedMetadata.pushState.keyId, "Recreated metadata must record the keyId that produced the remote copy.");
  assert.strictEqual(recreatedMetadata.restoredFromDestination.keyRef, "env:AGENT_BACKUP_ENCRYPTION_KEY", "Recreated metadata must record the key reference.");
  assertNoSecret(JSON.stringify(recreatedMetadata), "recreated metadata");

  // --- H. Tampered manifest digest is refused before mutation --------------
  const tamperShaBackup = await createAndPushBackup(destinationId);
  const tamperShaManifestPath = destinationService._test.remoteManifestPath({ path: "/backups/anx" }, tamperShaBackup.id);
  const tamperedManifest = JSON.parse(remoteFiles.get(tamperShaManifestPath).toString("utf8"));
  tamperedManifest.archiveSha256 = sha256Hex(Buffer.from("not-the-archive"));
  remoteFiles.set(tamperShaManifestPath, Buffer.from(`${JSON.stringify(tamperedManifest, null, 2)}\n`, "utf8"));
  await backupService.deleteBackup(tamperShaBackup.id);
  fs.writeFileSync(path.join(instanceDir(SOURCE_ID), "data", "world", "level.dat"), "tamper-sha-guard");
  const beforeTamperSha = snapshotInstanceTree(SOURCE_ID);
  await expectFailure("BACKUP_ARCHIVE_HASH_MISMATCH", () => route(
    "POST",
    `/api/v1/backups/${tamperShaBackup.id}/destinations/${destinationId}/restore`,
    { instanceId: SOURCE_ID, confirmOverwrite: true },
  ).then((result) => {
    if (result.statusCode !== 200) {
      const error = new Error(result.body?.error?.code || "RESTORE_FAILED");
      error.code = result.body?.error?.code || "RESTORE_FAILED";
      error.statusCode = result.statusCode;
      throw error;
    }
    return result;
  }), "tampered manifest digest");
  assertTreesEqual(beforeTamperSha, snapshotInstanceTree(SOURCE_ID), "A digest mismatch must refuse before any mutation.");
  assert(!fs.existsSync(archiveFilePath(tamperShaBackup.id)), "A digest mismatch must not materialize the local archive.");

  // --- I. Tampered ciphertext is refused before mutation -------------------
  const tamperEncBackup = await createAndPushBackup(destinationId);
  const tamperEncArchivePath = destinationService._test.remoteArchivePath({ path: "/backups/anx" }, tamperEncBackup.id);
  const tamperedEnvelope = Buffer.from(remoteFiles.get(tamperEncArchivePath));
  tamperedEnvelope[tamperedEnvelope.length - 1] ^= 0xff;
  remoteFiles.set(tamperEncArchivePath, tamperedEnvelope);
  await backupService.deleteBackup(tamperEncBackup.id);
  fs.writeFileSync(path.join(instanceDir(SOURCE_ID), "data", "world", "level.dat"), "tamper-enc-guard");
  const beforeTamperEnc = snapshotInstanceTree(SOURCE_ID);
  await expectFailure("BACKUP_DESTINATION_DECRYPT_FAILED", () => destinationService.restoreBackupFromDestination({
    backupId: tamperEncBackup.id,
    destinationId,
    instanceId: SOURCE_ID,
    confirmOverwrite: true,
  }), "tampered ciphertext");
  assertTreesEqual(beforeTamperEnc, snapshotInstanceTree(SOURCE_ID), "A decrypt failure must refuse before any mutation.");
  assert(!fs.existsSync(archiveFilePath(tamperEncBackup.id)), "A decrypt failure must not materialize the local archive.");

  // --- J. Local destination with no local archive refuses -----------------
  await expectFailure("BACKUP_DESTINATION_ARCHIVE_MISSING", () => destinationService.restoreBackupFromDestination({
    backupId: tamperEncBackup.id,
    destinationId: "local",
    instanceId: SOURCE_ID,
    confirmOverwrite: true,
  }), "local destination missing archive");

  // --- K. Key never leaks anywhere ----------------------------------------
  const allMetadata = fs.readdirSync(BACKUP_ROOT)
    .filter((file) => file.endsWith(".json"))
    .map((file) => fs.readFileSync(path.join(BACKUP_ROOT, file), "utf8"))
    .join("\n");
  assertNoSecret(allMetadata, "all backup metadata + destination store");
  for (const [remotePath, buffer] of remoteFiles) {
    assertNoSecret(buffer.toString("utf8"), `remote artifact ${remotePath}`);
    assertNoSecret(remotePath, `remote path ${remotePath}`);
  }

  console.log("backup-destinations-smoke passed");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
