// Backup and file engine fixes (hermetic). One numbered check per finding:
//   1 backup-file-engine-1  Agent Delete/Rename act on a symlink or junction,
//                           never on its target; listings flag links.
//   2 backup-file-engine-2  A backup that is not from the schedule prunes with
//                           the schedule's retention, as the list reports it.
//   3 backup-file-engine-3  A full restore of an imported backup takes the
//                           target's identity (no phantom instance).
//   4 backup-file-engine-4  Backups restore would refuse are refused at create
//                           time, and verify never calls them "verified".
//   5 backup-file-engine-5  SFTP Save and Replace can overwrite an existing
//                           file; plain rename and copy still never overwrite.
//   6 backup-file-engine-6  A failed restore starts a server it stopped again.
//   7 ui-servers-5          Cancel on the restore dialog never restores.
//   8 review R7             A full restore needs room for the safety snapshot
//                           and the staging copy at once on a shared disk.
//   9 review R8             A failed SFTP replace without posix-rename keeps
//                           the original file.
//  10 review Q3             That replace refuses to move a folder aside for a
//                           file, and replaces a link itself.
// Every data root is a fresh temp folder; the Agent config and the instance
// lifecycle are stubbed through require.cache, SFTP is an in-memory fake and
// the renderer function runs in a vm. Nothing touches the network, a real
// Agent, a service or the developer's data.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { Writable } = require("stream");

const rootDir = path.resolve(__dirname, "..");
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const smokeRoot = pinAgentRoots("anx-backup-file-fixes-");
process.env.ANXHUB_CONFIG_DIR = path.join(smokeRoot, "config");
process.env.ANXOS_CONFIG_DIR = path.join(smokeRoot, "config");
process.env.ANXOS_LOG_DIR = path.join(smokeRoot, "logs");
process.env.AGENT_LOG_DIR = path.join(smokeRoot, "logs");
process.env.AGENT_BACKUP_ROOT = path.join(smokeRoot, "backups");
process.env.AGENT_TEMP_DIR = path.join(smokeRoot, "agent-temp");
process.env.AGENT_IDENTITY_PATH = path.join(smokeRoot, "identity.json");
delete process.env.ANXOS_AGENT_RUNTIME_CONFIG;
delete process.env.AGENT_BACKUP_KEEP_LAST;
delete process.env.AGENT_BACKUP_MAX_AGE_DAYS;
const instanceRoot = process.env.AGENT_INSTANCE_ROOT;
fs.mkdirSync(instanceRoot, { recursive: true });
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.AGENT_BACKUP_ROOT, { recursive: true });

function stubModule(relative, exports) {
  const resolved = require.resolve(path.join(rootDir, relative));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// The real Agent config reads .env files; the stub keeps every root in temp.
stubModule("agent/src/config.js", { getConfig: () => ({ instanceRoot, allowedFolders: [] }) });
const lifecycle = {
  states: new Map(),
  starts: [],
  stops: [],
  async getStatus(id) {
    if (!lifecycle.states.has(id)) throw Object.assign(new Error("INSTANCE_NOT_FOUND"), { code: "INSTANCE_NOT_FOUND" });
    return { ...lifecycle.states.get(id) };
  },
  async stopInstance(id) {
    lifecycle.stops.push(id);
    lifecycle.states.set(id, { state: "Stopped", pid: null });
    return { id, state: "Stopped" };
  },
  async startInstance(id) {
    lifecycle.starts.push(id);
    lifecycle.states.set(id, { state: "Running", pid: 4242 });
    return { id, state: "Running" };
  },
  getWorldScopeCandidates: () => [],
};
stubModule("agent/src/services/instances/instanceService.js", lifecycle);

const backupService = require("../agent/src/services/backupService");
const agentFileService = require("../agent/src/services/fileService");

function makeInstance(id, config = {}, files = {}) {
  const instancePath = path.join(instanceRoot, id);
  const all = {
    "config.json": JSON.stringify({ id, name: id, state: "Stopped", ...config }),
    "data/world/level.dat": `${id}-world`,
    ...files,
  };
  for (const [relative, content] of Object.entries(all)) {
    const target = path.join(instancePath, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  lifecycle.states.set(id, { state: "Stopped", pid: null });
  return instancePath;
}

function exists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

async function rejectsWithCode(promise, code, message) {
  let caught = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert(caught, `${message}: expected ${code}, but the call succeeded.`);
  assert.strictEqual(caught.code, code, `${message}: expected ${code}, got ${caught.code} (${caught.message}).`);
  return caught;
}

const checks = [];
function check(id, title, run) {
  checks.push({ id, title, run });
}

check(1, "backup-file-engine-1: Delete/Rename act on the link, not its target", async () => {
  const fileRoot = path.join(smokeRoot, "file-root");
  fs.mkdirSync(path.join(fileRoot, "data"), { recursive: true });
  fs.mkdirSync(path.join(fileRoot, "data2"), { recursive: true });
  fs.writeFileSync(path.join(fileRoot, "data", "keep.txt"), "keep");
  fs.writeFileSync(path.join(fileRoot, "data2", "keep2.txt"), "keep2");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(path.join(fileRoot, "data"), path.join(fileRoot, "link"), linkType);
  fs.symlinkSync(path.join(fileRoot, "data2"), path.join(fileRoot, "link2"), linkType);
  process.env.AGENT_FILE_ROOTS = fileRoot;
  try {
    const deleted = await agentFileService.mutateFile("delete", { path: path.join(fileRoot, "link") });
    assert.strictEqual(deleted.deleted, true);
    assert(fs.existsSync(path.join(fileRoot, "data", "keep.txt")), "Deleting a link must keep the folder it points to.");
    assert(!exists(path.join(fileRoot, "link")), "Deleting a link must remove the link.");

    await agentFileService.mutateFile("rename", { oldPath: path.join(fileRoot, "link2"), newPath: path.join(fileRoot, "renamed") });
    assert(fs.existsSync(path.join(fileRoot, "data2", "keep2.txt")), "Renaming a link must not move the folder it points to.");
    assert(!exists(path.join(fileRoot, "link2")), "Renaming a link must move the link.");
    assert(fs.lstatSync(path.join(fileRoot, "renamed")).isSymbolicLink(), "The renamed entry must still be the link.");

    const listing = await agentFileService.listFiles(fileRoot);
    const link = listing.entries.find((entry) => entry.name === "renamed");
    const data = listing.entries.find((entry) => entry.name === "data");
    assert(link, "The link must be listed.");
    assert.strictEqual(link.type, "directory", "A linked folder still opens as a folder.");
    assert.strictEqual(link.isSymlink, true, "A link entry must be flagged as a link.");
    assert.notStrictEqual(data.isSymlink, true, "A real folder must not be flagged as a link.");

    // Regular entries and the root guard behave as before.
    fs.mkdirSync(path.join(fileRoot, "plain"));
    fs.writeFileSync(path.join(fileRoot, "plain", "a.txt"), "a");
    await agentFileService.mutateFile("rename", { oldPath: path.join(fileRoot, "plain"), newPath: path.join(fileRoot, "plain2") });
    assert(fs.existsSync(path.join(fileRoot, "plain2", "a.txt")), "A real folder must still rename.");
    await agentFileService.mutateFile("delete", { path: path.join(fileRoot, "plain2") });
    assert(!exists(path.join(fileRoot, "plain2")), "A real folder must still delete.");
    await rejectsWithCode(agentFileService.mutateFile("delete", { path: fileRoot }), "ROOT_DELETE_FORBIDDEN", "The root must never be deleted");
    await rejectsWithCode(agentFileService.mutateFile("delete", { path: path.join(fileRoot, "missing") }), "PATH_NOT_FOUND", "A missing entry");
    await rejectsWithCode(agentFileService.mutateFile("delete", { path: path.join(smokeRoot, "outside.txt") }), "PATH_NOT_ALLOWED", "A path outside the root");
    // A link whose parent leaves the root is still refused.
    const outside = path.join(smokeRoot, "outside-dir");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(outside, path.join(fileRoot, "escape"), linkType);
    await rejectsWithCode(agentFileService.mutateFile("delete", { path: path.join(fileRoot, "escape", "secret.txt") }), "PATH_NOT_ALLOWED", "An entry reached through a link out of the root");
    assert(fs.existsSync(path.join(outside, "secret.txt")), "A file outside the root must survive.");
  } finally {
    delete process.env.AGENT_FILE_ROOTS;
  }
});

check(2, "backup-file-engine-2: manual and pre-update backups honour the schedule's retention", async () => {
  const id = "retention-srv";
  makeInstance(id);
  await backupService.saveSchedule({ instanceId: id, intervalHours: 24, keepLast: 30, maxAgeDays: 90, type: "world" });
  for (let index = 0; index < 12; index += 1) {
    await backupService.createBackup({ instanceId: id, type: "world", name: `scheduled ${index}`, createdBy: "schedule", retention: { keepLast: 30, maxAgeDays: 90 } });
  }
  // Backdate the oldest backup by 45 days: inside the schedule's 90 days.
  const listed = (await backupService.listBackups({ instanceId: id })).backups;
  const oldest = listed[listed.length - 1];
  const metadataFile = path.join(process.env.AGENT_BACKUP_ROOT, `${oldest.id}.json`);
  const metadata = JSON.parse(fs.readFileSync(metadataFile, "utf8"));
  metadata.createdAt = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(metadataFile, JSON.stringify(metadata));
  const reported = (await backupService.listBackups({ instanceId: id })).backups.find((backup) => backup.id === oldest.id);
  assert.deepStrictEqual(reported.retentionPolicy, { keepLast: 30, maxAgeDays: 90, source: "schedule" });
  assert.strictEqual(reported.retentionPolicyMet, true, "Fixture: the list calls the 45-day-old backup within policy.");

  // Exactly the renderer's manual payload, then exactly the pre-update one.
  const manual = await backupService.createBackup({ instanceId: id, type: "world", consistency: "crash", createdBy: "local-user", name: "manual" });
  assert.deepStrictEqual(manual.retention.pruned, [], "A manual backup must not prune what the schedule keeps.");
  const preUpdate = await backupService.createBackup({ instanceId: id, type: "full", consistency: "crash", createdBy: "steamcmd-update", reason: "pre-update", name: "pre-update" });
  assert.deepStrictEqual(preUpdate.retention.pruned, [], "A pre-update backup must not prune what the schedule keeps.");
  const after = (await backupService.listBackups({ instanceId: id })).backups;
  assert.strictEqual(after.length, 14, "All 14 backups must still exist.");
  assert(after.some((backup) => backup.id === oldest.id), "The 45-day-old backup must survive.");

  // Without a schedule the defaults still apply, and an explicit policy wins.
  const plain = "retention-default";
  makeInstance(plain);
  for (let index = 0; index < 11; index += 1) {
    await backupService.createBackup({ instanceId: plain, type: "world", name: `plain ${index}`, retention: { keepLast: 99, maxAgeDays: 99 } });
  }
  const pruned = await backupService.createBackup({ instanceId: plain, type: "world", name: "plain manual" });
  assert.strictEqual(pruned.retention.pruned.length, 2, "Without a schedule the default keep-last of 10 still prunes.");
});

check(3, "backup-file-engine-3: restoring an imported full backup keeps the target's identity", async () => {
  makeInstance("mc-old", { name: "Old server", state: "Running", pid: 31337 });
  const source = (await backupService.createBackup({ instanceId: "mc-old", type: "full", name: "old full" })).backup;
  const content = fs.readFileSync(path.join(process.env.AGENT_BACKUP_ROOT, source.archiveName)).toString("base64");
  makeInstance("mc-new", { name: "New server" });
  const imported = (await backupService.importBackup({ instanceId: "mc-new", content, encoding: "base64", type: "full", name: "imported" })).backup;
  fs.rmSync(path.join(instanceRoot, "mc-old"), { recursive: true, force: true });
  lifecycle.states.delete("mc-old");

  const result = await backupService.restoreBackup({ backupId: imported.id, confirmOverwrite: true, restart: false });
  assert.strictEqual(result.restore.sameInstanceAsBackup, true);
  const record = JSON.parse(fs.readFileSync(path.join(instanceRoot, "mc-new", "config.json"), "utf8"));
  assert.strictEqual(record.id, "mc-new", "The restored record must carry the target's id.");
  assert.strictEqual(record.state, "Stopped", "A stale Running state must not be restored.");
  assert.strictEqual(record.pid, null, "A stale pid must not be restored.");
  assert.strictEqual(record.name, "Old server", "The restored configuration is kept.");
  assert.strictEqual(fs.readFileSync(path.join(instanceRoot, "mc-new", "data", "world", "level.dat"), "utf8"), "mc-old-world");
  assert(!exists(path.join(instanceRoot, "mc-old")), "No folder for the old id may appear.");
  assert(!fs.readdirSync(instanceRoot).some((name) => name.includes("restore-staging")), "No staging folder may be left behind.");
});

check(4, "backup-file-engine-4: backups restore would refuse are refused at create time and never verified", async () => {
  // Real limits: one file just over 256 MiB in a server under 512 MiB. The
  // file is extended without writing data, so the fixture costs no disk I/O.
  const id = "big-entry-srv";
  const instancePath = makeInstance(id);
  const bigPath = path.join(instancePath, "data", "world", "big.dat");
  const handle = fs.openSync(bigPath, "w");
  fs.ftruncateSync(handle, 256 * 1024 * 1024 + 4096);
  fs.closeSync(handle);
  const archivesBefore = fs.readdirSync(process.env.AGENT_BACKUP_ROOT).filter((name) => name.startsWith(id));
  const refused = await rejectsWithCode(backupService.createBackup({ instanceId: id, type: "full", name: "too big" }), "BACKUP_SOURCE_LIMIT_EXCEEDED", "A file restore would refuse");
  assert.strictEqual(refused.details.reason, "ENTRY_TOO_LARGE");
  assert.strictEqual(refused.details.entryName, "data/world/big.dat");
  const archivesAfter = fs.readdirSync(process.env.AGENT_BACKUP_ROOT).filter((name) => name.startsWith(id));
  assert.deepStrictEqual(archivesAfter, archivesBefore, "A refused backup must leave no archive or record.");
  fs.rmSync(bigPath, { force: true });

  // Verify applies the same per-entry and entry-count limits.
  const small = (await backupService.createBackup({ instanceId: id, type: "full", name: "small" })).backup;
  const ok = await backupService.verifyBackup(small.id);
  assert.strictEqual(ok.record.verification.state, "verified", "A restorable backup still verifies.");
  const tooBig = await backupService.verifyBackup(small.id, { maxEntryBytes: 4 });
  assert.notStrictEqual(tooBig.record.verification.state, "verified", "An entry over the restore limit must not verify.");
  assert.strictEqual(tooBig.ok, false);
  assert.strictEqual(tooBig.code, "BACKUP_ARCHIVE_LIMIT_EXCEEDED");
  const tooMany = await backupService.verifyBackup(small.id, { maxEntryCount: 2 });
  assert.notStrictEqual(tooMany.record.verification.state, "verified", "Too many entries must not verify.");
  assert.strictEqual(tooMany.code, "BACKUP_ARCHIVE_LIMIT_EXCEEDED");
  const persisted = JSON.parse(fs.readFileSync(path.join(process.env.AGENT_BACKUP_ROOT, `${small.id}.json`), "utf8"));
  assert.strictEqual(persisted.verification.state, "failed", "The refusal must be persisted.");

  // The shared helper also refuses the projected tar size.
  const { assertArchiveWithinRestoreLimits } = backupService._test;
  assert.strictEqual(typeof assertArchiveWithinRestoreLimits, "function", "The restore limits must be shared with create.");
  const file = (name, size) => ({ name, type: "file", size });
  assertArchiveWithinRestoreLimits([file("a", 10), file("b", 10)], { maxEntryBytes: 10, maxEntryCount: 2, maxExpandedBytes: 4096 });
  assert.throws(() => assertArchiveWithinRestoreLimits([file("big", 11)], { maxEntryBytes: 10, maxEntryCount: 5, maxExpandedBytes: 1 << 20 }),
    (error) => error.code === "BACKUP_SOURCE_LIMIT_EXCEEDED" && error.details.reason === "ENTRY_TOO_LARGE" && error.details.entryName === "big");
  assert.throws(() => assertArchiveWithinRestoreLimits([file("a", 1), file("b", 1), file("c", 1)], { maxEntryBytes: 10, maxEntryCount: 2, maxExpandedBytes: 1 << 20 }),
    (error) => error.code === "BACKUP_SOURCE_LIMIT_EXCEEDED" && error.details.reason === "TOO_MANY_ENTRIES");
  // Two 1-byte files take 2 x (512 header + 512 data) + 1024 trailer = 3072 tar bytes.
  assertArchiveWithinRestoreLimits([file("a", 1), file("b", 1)], { maxEntryBytes: 10, maxEntryCount: 5, maxExpandedBytes: 3072 });
  assert.throws(() => assertArchiveWithinRestoreLimits([file("a", 1), file("b", 1)], { maxEntryBytes: 10, maxEntryCount: 5, maxExpandedBytes: 3071 }),
    (error) => error.code === "BACKUP_SOURCE_LIMIT_EXCEEDED" && error.details.reason === "ARCHIVE_TOO_LARGE");
});

// In-memory SFTP server following SFTP v3: RENAME refuses an existing target
// ("Failure", code 4), posix-rename@openssh.com overwrites.
function createFakeSftp(files, { posixRename = true } = {}) {
  const handles = new Map();
  let nextHandle = 1;
  const failure = () => Object.assign(new Error("Failure"), { code: 4 });
  const noSuchFile = () => Object.assign(new Error("No such file"), { code: 2 });
  const sftp = {
    renames: [],
    open(remotePath, flags, cb) {
      if (flags.includes("x") && files.has(remotePath)) return cb(failure());
      const handle = Buffer.from(String(nextHandle++));
      handles.set(handle.toString(), { path: remotePath, chunks: [] });
      if (flags.includes("w")) files.set(remotePath, Buffer.alloc(0));
      else if (!files.has(remotePath)) return cb(noSuchFile());
      return cb(null, handle);
    },
    write(handle, buffer, offset, length, position, cb) {
      const entry = handles.get(handle.toString());
      if (!entry) return cb(failure());
      entry.chunks.push(Buffer.from(buffer.subarray(offset, offset + length)));
      files.set(entry.path, Buffer.concat(entry.chunks));
      return cb(null);
    },
    close(handle, cb) {
      if (!handles.delete(handle.toString())) return cb(failure());
      return cb(null);
    },
    read(handle, buffer, offset, length, position, cb) {
      const entry = handles.get(handle.toString());
      const data = files.get(entry.path) || Buffer.alloc(0);
      const count = data.copy(buffer, offset, position, Math.min(data.length, position + length));
      return cb(null, count);
    },
    stat(remotePath, cb) {
      if (!files.has(remotePath)) return cb(noSuchFile());
      return cb(null, { size: files.get(remotePath).length, mode: 0o100644, isDirectory: () => false, isFile: () => true });
    },
    lstat(remotePath, cb) {
      return sftp.stat(remotePath, cb);
    },
    unlink(remotePath, cb) {
      if (!files.delete(remotePath)) return cb(noSuchFile());
      return cb(null);
    },
    rename(oldPath, newPath, cb) {
      sftp.renames.push(["rename", oldPath, newPath]);
      if (!files.has(oldPath)) return cb(noSuchFile());
      if (files.has(newPath)) return cb(failure());
      files.set(newPath, files.get(oldPath));
      files.delete(oldPath);
      return cb(null);
    },
    createWriteStream(remotePath, options = {}) {
      const chunks = [];
      return new Writable({
        write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
        final(callback) {
          if (String(options.flags || "").includes("x") && files.has(remotePath)) return callback(failure());
          files.set(remotePath, Buffer.concat(chunks));
          return callback();
        },
      });
    },
  };
  if (posixRename) {
    sftp.ext_openssh_rename = (oldPath, newPath, cb) => {
      sftp.renames.push(["posix-rename", oldPath, newPath]);
      if (!files.has(oldPath)) return cb(noSuchFile());
      files.set(newPath, files.get(oldPath));
      files.delete(oldPath);
      return cb(null);
    };
  } else {
    sftp.ext_openssh_rename = () => { throw new Error("Server does not support this extended request"); };
  }
  return sftp;
}

check(5, "backup-file-engine-5: SFTP Save and Replace overwrite an existing file", async () => {
  const { FileService } = require("../src/services/fileService");
  for (const posixRename of [true, false]) {
    const label = posixRename ? "with posix-rename" : "without posix-rename";
    const files = new Map([["/srv/a.txt", Buffer.from("old")], ["/srv/b.txt", Buffer.from("bee")], ["/srv/c.txt", Buffer.from("sea")]]);
    const sftp = createFakeSftp(files, { posixRename });
    const service = new FileService();
    service.emitTransfer = () => {};
    service.ensureSession = async () => ({ sftp, currentPath: "/srv", homePath: "/srv" });
    const temporaryFiles = () => [...files.keys()].filter((name) => name.endsWith(".tmp"));

    const saved = await service.writeText({ storageId: "sftp-1", path: "/srv/a.txt", content: "new" });
    assert.strictEqual(saved.saved, true);
    assert.strictEqual(files.get("/srv/a.txt").toString(), "new", `Save must replace an existing file (${label}).`);

    await service.uploadContent({ storageId: "sftp-1", directoryPath: "/srv", name: "a.txt", contentBase64: Buffer.from("replaced").toString("base64"), conflictPolicy: "replace" });
    assert.strictEqual(files.get("/srv/a.txt").toString(), "replaced", `Upload Replace must replace an existing file (${label}).`);

    await rejectsWithCode(service.uploadContent({ storageId: "sftp-1", directoryPath: "/srv", name: "a.txt", contentBase64: Buffer.from("x").toString("base64") }), "FILES_CONFLICT", `Upload without Replace (${label})`);
    assert.strictEqual(files.get("/srv/a.txt").toString(), "replaced");

    await service.copy({ storageId: "sftp-1", sourcePath: "/srv/b.txt", destinationPath: "/srv/a.txt", conflictPolicy: "replace" });
    assert.strictEqual(files.get("/srv/a.txt").toString(), "bee", `Copy with Replace must replace (${label}).`);
    await assert.rejects(service.copy({ storageId: "sftp-1", sourcePath: "/srv/c.txt", destinationPath: "/srv/a.txt", conflictPolicy: "error" }), `Copy without Replace must not overwrite (${label}).`);
    assert.strictEqual(files.get("/srv/a.txt").toString(), "bee", `Copy without Replace must leave the destination (${label}).`);

    // The user's own Rename keeps refusing to overwrite.
    await assert.rejects(service.rename({ storageId: "sftp-1", oldPath: "/srv/c.txt", newPath: "/srv/a.txt" }), `Rename must not overwrite (${label}).`);
    assert.strictEqual(files.get("/srv/c.txt").toString(), "sea");
    assert.deepStrictEqual(temporaryFiles(), [], `No temporary file may be left (${label}).`);
  }
});

check(6, "backup-file-engine-6: a failed restore starts the server it stopped again", async () => {
  const id = "restart-srv";
  makeInstance(id);
  const backup = (await backupService.createBackup({ instanceId: id, type: "full", name: "full" })).backup;

  // a) Pre-mutation failure: the backup disk is nearly full.
  lifecycle.states.set(id, { state: "Running", pid: 4242 });
  lifecycle.starts.length = 0;
  const realStatfs = fsp.statfs;
  fsp.statfs = async (target, ...rest) => {
    const stats = await realStatfs(target, ...rest);
    if (path.resolve(target) === path.resolve(process.env.AGENT_BACKUP_ROOT)) return { ...stats, bsize: 4096, bavail: 256, bfree: 256 };
    return stats;
  };
  let error;
  try {
    error = await rejectsWithCode(backupService.restoreBackup({ backupId: backup.id, restart: true, confirmOverwrite: true }), "RESTORE_SNAPSHOT_DISK_SPACE_INSUFFICIENT", "A restore without snapshot space");
  } finally {
    fsp.statfs = realStatfs;
  }
  assert.deepStrictEqual(lifecycle.starts, [id], "The server this restore stopped must be started again.");
  assert.strictEqual(lifecycle.states.get(id).state, "Running");
  assert.strictEqual(error.details.restart?.restarted, true, "The error must say the server was started again.");

  // b) Post-mutation failure that rolls back: extraction fails once.
  lifecycle.states.set(id, { state: "Running", pid: 4242 });
  lifecycle.starts.length = 0;
  const realWriteFile = fsp.writeFile;
  let armed = true;
  fsp.writeFile = async (target, ...rest) => {
    if (armed && typeof target === "string" && target.endsWith(path.join("data", "world", "level.dat"))) {
      armed = false;
      throw Object.assign(new Error("EIO: injected extraction failure"), { code: "EIO" });
    }
    return realWriteFile(target, ...rest);
  };
  try {
    error = await rejectsWithCode(backupService.restoreBackup({ backupId: backup.id, restart: false, confirmOverwrite: true }), "EIO", "A restore whose extraction fails");
  } finally {
    fsp.writeFile = realWriteFile;
  }
  assert.strictEqual(error.details.rollback?.rolledBack, true, "Fixture: the failed restore rolled back.");
  assert.deepStrictEqual(lifecycle.starts, [id], "A rolled-back restore must start the server it stopped again.");
  assert.strictEqual(fs.readFileSync(path.join(instanceRoot, id, "data", "world", "level.dat"), "utf8"), `${id}-world`);

  // c) A server that was stopped before stays stopped.
  lifecycle.states.set(id, { state: "Stopped", pid: null });
  lifecycle.starts.length = 0;
  fsp.statfs = async (target, ...rest) => {
    const stats = await realStatfs(target, ...rest);
    if (path.resolve(target) === path.resolve(process.env.AGENT_BACKUP_ROOT)) return { ...stats, bsize: 4096, bavail: 256, bfree: 256 };
    return stats;
  };
  try {
    await rejectsWithCode(backupService.restoreBackup({ backupId: backup.id, restart: true, confirmOverwrite: true }), "RESTORE_SNAPSHOT_DISK_SPACE_INSUFFICIENT", "A restore of a stopped server");
  } finally {
    fsp.statfs = realStatfs;
  }
  assert.deepStrictEqual(lifecycle.starts, [], "A server that was stopped before must stay stopped.");
});

function extractFunction(source, name) {
  const match = new RegExp(`^(async )?function ${name}\\(`, "m").exec(source);
  assert(match, `app.js must define ${name}.`);
  let index = source.indexOf("(", match.index);
  let depth = 0;
  for (; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")" && --depth === 0) break;
  }
  const open = source.indexOf("{", index);
  depth = 0;
  for (let end = open; end < source.length; end += 1) {
    if (source[end] === "{") depth += 1;
    else if (source[end] === "}" && --depth === 0) return source.slice(match.index, end + 1);
  }
  throw new Error(`Unbalanced ${name}`);
}

check(7, "ui-servers-5: dismissing the restore dialog never restores", async () => {
  const appSource = fs.readFileSync(path.join(rootDir, "app.js"), "utf8");
  const code = ["restoreSelectedBackup", "getRestorePreviewMessage", "confirmDestructiveAction", "isGuidedModeEnabled"]
    .map((name) => extractFunction(appSource, name))
    .join("\n\n");
  async function run(confirmationsOn, answer) {
    const dialogs = [];
    const restores = [];
    const context = {
      settings: { "general.confirmDestructiveActions": confirmationsOn },
      getCurrentSettings: () => context.settings,
      getSelectedBackup: () => null,
      getDesktopApiState: () => ({ hasBackups: true, api: { backups: { restore: async (request) => { restores.push(request); return request.preview ? {} : { restore: {} }; } } } }),
      createNodeActionContext: () => ({ nodeId: "local" }),
      isNodeActionStillCurrent: () => true,
      AnxRestorePreview: { describeRestorePreview: () => null },
      formatDateTime: String,
      createSecurityConfirmation: async (options) => {
        dialogs.push(options);
        return options.title === "Restore this backup?" ? true : answer;
      },
      showToast: () => {},
      refreshInstances: async () => {},
      refreshBackups: async () => {},
      getBackupErrorMessage: (_error, fallback) => fallback,
    };
    vm.createContext(context);
    vm.runInContext(code, context);
    await context.restoreSelectedBackup({ id: "full-1", name: "full-1" });
    return { dialogs, restores: restores.filter((request) => !request.preview) };
  }
  for (const confirmationsOn of [true, false]) {
    const dismissed = await run(confirmationsOn, null);
    assert.strictEqual(dismissed.restores.length, 0, `Cancel, Esc or close must not restore (confirmations ${confirmationsOn ? "on" : "off"}).`);
    const restartDialog = dismissed.dialogs[dismissed.dialogs.length - 1];
    assert(restartDialog.checkboxLabel, "The restart choice must be a checkbox, so Cancel can mean cancel.");
    const restartChosen = await run(confirmationsOn, { confirmed: true, checked: true });
    assert.deepStrictEqual(restartChosen.restores.map((request) => [request.backupId, request.restart, request.confirmOverwrite]), [["full-1", true, true]]);
    const leaveStopped = await run(confirmationsOn, { confirmed: true, checked: false });
    assert.deepStrictEqual(leaveStopped.restores.map((request) => [request.backupId, request.restart, request.confirmOverwrite]), [["full-1", false, true]]);
  }
});

check(8, "review R7: a full restore is refused up front when snapshot and staging copy cannot both fit", async () => {
  const id = "staging-space-srv";
  const instancePath = makeInstance(id, {}, { "data/world/region.mca": crypto.randomBytes(200 * 1024) });
  const backup = (await backupService.createBackup({ instanceId: id, type: "full", name: "full" })).backup;
  const reserve = 64 * 1024 * 1024;
  const watched = [process.env.AGENT_BACKUP_ROOT, instanceRoot].map((target) => path.resolve(target));
  const realStatfs = fsp.statfs;
  // Backup root and instance parent share one disk (as by default). Each of
  // the snapshot (~200 KB) and the extraction (~200 KB) fits on its own with
  // the reserve, but not both at once.
  async function restoreWithFree(freeBytes) {
    fsp.statfs = async (target, ...rest) => {
      const stats = await realStatfs(target, ...rest);
      if (watched.includes(path.resolve(target))) return { ...stats, bsize: 1, bavail: freeBytes, bfree: freeBytes };
      return stats;
    };
    try {
      return await backupService.restoreBackup({ backupId: backup.id, restart: false, confirmOverwrite: true });
    } finally {
      fsp.statfs = realStatfs;
    }
  }
  const backupFilesBefore = fs.readdirSync(process.env.AGENT_BACKUP_ROOT).sort();
  await rejectsWithCode(restoreWithFree(reserve + 300 * 1024), "RESTORE_DISK_SPACE_INSUFFICIENT", "A restore whose snapshot and staging copy do not both fit");
  assert.deepStrictEqual(fs.readdirSync(process.env.AGENT_BACKUP_ROOT).sort(), backupFilesBefore, "A refused restore must not write a safety snapshot.");
  assert.strictEqual(fs.readFileSync(path.join(instancePath, "data", "world", "level.dat"), "utf8"), `${id}-world`, "A refused restore must leave the server untouched.");
  assert(!fs.readdirSync(instanceRoot).some((name) => name.includes("restore-staging")), "No staging folder may be left behind.");
  // With room for both, the same restore goes through.
  const restored = await restoreWithFree(reserve + 600 * 1024);
  assert.strictEqual(restored.restore.instanceId, id);
});

check(9, "review R8: a failed SFTP replace without posix-rename keeps the original file", async () => {
  const { FileService } = require("../src/services/fileService");
  const files = new Map([["/srv/server.properties", Buffer.from("OLD")]]);
  const sftp = createFakeSftp(files, { posixRename: false });
  // The server refuses RENAME onto an existing target and then also fails the
  // retry once the name is free (a server-side error, permissions, policy).
  const plainRename = sftp.rename;
  sftp.rename = (oldPath, newPath, cb) => {
    if (oldPath.endsWith(".write.tmp") && !files.has(newPath)) {
      sftp.renames.push(["rename", oldPath, newPath]);
      return cb(Object.assign(new Error("Failure"), { code: 4 }));
    }
    return plainRename(oldPath, newPath, cb);
  };
  const service = new FileService();
  service.emitTransfer = () => {};
  const session = { sftp, currentPath: "/srv", homePath: "/srv" };
  await assert.rejects(service.writeRemoteBuffer(session, "/srv/server.properties", Buffer.from("NEW"), { replace: true }), "The failed commit must be reported.");
  assert(files.has("/srv/server.properties"), "A failed replace must not delete the original file.");
  assert.strictEqual(files.get("/srv/server.properties").toString(), "OLD", "The original content must be kept.");
  assert.deepStrictEqual([...files.keys()].filter((name) => name.endsWith(".tmp")), [], "No temporary or moved-aside file may be left.");
});

check(10, "review Q3: an SFTP replace without posix-rename never hides a folder behind a file", async () => {
  const { FileService } = require("../src/services/fileService");
  // SFTP v3 with folders and links: RENAME refuses an existing target and
  // moves a whole tree, REMOVE refuses a folder, stat follows links, lstat
  // does not. No posix-rename extension.
  const entries = new Map();
  const failure = () => Object.assign(new Error("Failure"), { code: 4 });
  const noSuchFile = () => Object.assign(new Error("No such file"), { code: 2 });
  const attrs = (entry) => ({ isDirectory: () => entry.type === "dir", isFile: () => entry.type === "file", isSymbolicLink: () => entry.type === "link" });
  const sftp = {
    lstat(remotePath, cb) { const entry = entries.get(remotePath); return entry ? cb(null, attrs(entry)) : cb(noSuchFile()); },
    stat(remotePath, cb) {
      let entry = entries.get(remotePath);
      if (entry?.type === "link") entry = entries.get(entry.target);
      return entry ? cb(null, attrs(entry)) : cb(noSuchFile());
    },
    rename(oldPath, newPath, cb) {
      if (!entries.has(oldPath)) return cb(noSuchFile());
      if (entries.has(newPath)) return cb(failure());
      for (const key of [...entries.keys()]) {
        if (key !== oldPath && !key.startsWith(`${oldPath}/`)) continue;
        entries.set(newPath + key.slice(oldPath.length), entries.get(key));
        entries.delete(key);
      }
      return cb(null);
    },
    unlink(remotePath, cb) {
      const entry = entries.get(remotePath);
      if (!entry || entry.type === "dir") return cb(failure());
      entries.delete(remotePath);
      return cb(null);
    },
    createWriteStream(remotePath) {
      const chunks = [];
      return new Writable({
        write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); },
        final(callback) { entries.set(remotePath, { type: "file", data: Buffer.concat(chunks) }); callback(); },
      });
    },
    open(remotePath, flags, cb) {
      if (entries.has(remotePath)) return cb(failure());
      entries.set(remotePath, { type: "file", data: Buffer.alloc(0) });
      return cb(null, Buffer.from(remotePath));
    },
    write(handle, buffer, offset, length, position, cb) {
      const entry = entries.get(handle.toString());
      entry.data = Buffer.concat([entry.data, buffer.subarray(offset, offset + length)]);
      return cb(null);
    },
    close(handle, cb) { return cb(null); },
    ext_openssh_rename() { throw new Error("Server does not support this extended request"); },
  };
  const service = new FileService();
  service.emitTransfer = () => {};
  service.ensureSession = async () => ({ sftp, currentPath: "/srv", homePath: "/srv" });
  const reset = () => {
    entries.clear();
    entries.set("/srv", { type: "dir" });
    entries.set("/srv/world", { type: "dir" });
    entries.set("/srv/world/level.dat", { type: "file", data: Buffer.from("WORLD") });
    entries.set("/srv/maps", { type: "dir" });
    entries.set("/srv/current", { type: "link", target: "/srv/maps" });
  };
  const hidden = () => [...entries.keys()].filter((key) => posixBase(key).startsWith("."));
  const posixBase = (key) => key.slice(key.lastIndexOf("/") + 1);

  // Upload Replace (the dialog and drag-and-drop) of a file named like a folder.
  reset();
  await rejectsWithCode(service.uploadContent({ storageId: "sftp-1", directoryPath: "/srv", name: "world", contentBase64: Buffer.from("NEW").toString("base64"), conflictPolicy: "replace" }), "FILES_PATH_NOT_FILE", "A file replacing a folder");
  assert.strictEqual(entries.get("/srv/world")?.type, "dir", "The folder must stay where it was.");
  assert.strictEqual(entries.get("/srv/world/level.dat")?.data.toString(), "WORLD", "The folder's contents must stay in place.");
  assert.deepStrictEqual(hidden(), [], "Nothing may be moved aside or left behind.");

  // Save to a path that is a folder.
  reset();
  await rejectsWithCode(service.writeText({ storageId: "sftp-1", path: "/srv/world", content: "NEW" }), "FILES_PATH_NOT_FILE", "Save over a folder");
  assert.strictEqual(entries.get("/srv/world")?.type, "dir");
  assert.deepStrictEqual(hidden(), []);

  // A link to a folder is replaced itself, as posix-rename would; the folder it
  // pointed to is left alone.
  reset();
  await service.uploadContent({ storageId: "sftp-1", directoryPath: "/srv", name: "current", contentBase64: Buffer.from("NEW").toString("base64"), conflictPolicy: "replace" });
  assert.strictEqual(entries.get("/srv/current")?.type, "file", "The link must be replaced by the file.");
  assert.strictEqual(entries.get("/srv/current").data.toString(), "NEW");
  assert.strictEqual(entries.get("/srv/maps")?.type, "dir", "The link's target must be untouched.");
  assert.deepStrictEqual(hidden(), []);
});

async function main() {
  const only = process.argv.slice(2).map(Number).filter(Boolean);
  const failures = [];
  let ran = 0;
  for (const entry of checks) {
    if (only.length && !only.includes(entry.id)) continue;
    ran += 1;
    try {
      await entry.run();
      console.log(`PASS ${entry.id} ${entry.title}`);
    } catch (error) {
      failures.push(entry.id);
      console.error(`FAIL ${entry.id} ${entry.title}\n  ${error?.stack || error}`);
    }
  }
  if (failures.length) {
    console.error(`Backup and file fixes smoke failed: checks ${failures.join(", ")} (${ran} checks).`);
    process.exit(1);
  }
  console.log(`Backup and file fixes smoke passed (${ran} checks).`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
