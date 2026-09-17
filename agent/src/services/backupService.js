const crypto = require("crypto");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");
const zlib = require("zlib");

const { getConfig } = require("../config");
const instanceService = require("./instances/instanceService");
const longOperations = require("../../../src/shared/longOperationService");
const {
  MAX_BACKUP_ARCHIVE_BYTES,
  MAX_BACKUP_COMPRESSION_RATIO,
  MAX_BACKUP_ENTRY_BYTES,
  MAX_BACKUP_ENTRY_COUNT,
  MAX_BACKUP_EXPANDED_BYTES,
} = require("../../../src/shared/backupLimits");

const BACKUP_FORMAT = "tar.gz";
const BACKUP_EXTENSION = ".tar.gz";
const DEFAULT_RETENTION_COUNT = 10;
const DEFAULT_RETENTION_DAYS = 30;
const TAR_BLOCK_SIZE = 512;
const BACKUP_METADATA_SCHEMA_VERSION = 1;
const BACKUP_SCHEDULE_SCHEMA_VERSION = 1;
const MINIMUM_DISK_RESERVE_BYTES = 64 * 1024 * 1024;
// Workload-consistency disclosure (V2-F): "crash" copies are taken while the
// instance keeps running (the historical default), "stopped" copies quiesce
// the workload first through the instance lifecycle.
const BACKUP_CONSISTENCY_MODES = new Set(["crash", "stopped"]);
// States from which a quiesced backup must first bring the instance down;
// mirrors the stop set the restore flow uses.
const INSTANCE_ACTIVE_STATES = new Set(["Starting", "Running", "Restarting", "Stopping"]);
let schedulerStarted = false;
let schedulerTimer = null;

function createBackupError(code, statusCode = 400, details = {}) {
  return Object.assign(new Error(code), { code, statusCode, details });
}

function isInstanceActive(status) {
  return Boolean(status?.pid || INSTANCE_ACTIVE_STATES.has(status?.state));
}

function normalizeBackupConsistency(value) {
  // Unknown values must fail loudly instead of silently downgrading to a
  // weaker consistency guarantee than the caller asked for.
  if (value === undefined || value === null || value === "") return "crash";
  if (!BACKUP_CONSISTENCY_MODES.has(value)) {
    throw createBackupError("INVALID_BACKUP_CONSISTENCY", 400, { consistency: String(value) });
  }
  return value;
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function acquireBackupLock(instanceId, kind, options = {}) {
  try {
    return longOperations.createOperation({
      kind,
      lockKey: `backup:${instanceId}`,
      status: "running",
      canCancel: false,
      retryable: true,
      rollbackSupported: options.rollbackSupported === true,
      // Defense-in-depth: archive/extract operations have no internal timeout,
      // so a hung filesystem operation (e.g. a stalled network mount) could
      // otherwise hold this lock for the rest of the process lifetime.
      timeoutMs: 2 * 60 * 60 * 1000,
      metadata: { instanceId },
    });
  } catch (error) {
    if (error?.code === "DUPLICATE_OPERATION") {
      throw createBackupError("BACKUP_OPERATION_IN_PROGRESS", 409);
    }
    throw error;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function getBackupRoot() {
  return path.resolve(process.env.AGENT_BACKUP_ROOT || path.join(path.dirname(getConfig().instanceRoot), "backups"));
}

function getInstanceRoot() {
  return path.resolve(getConfig().instanceRoot);
}

function isInsideRoot(filePath, root) {
  const relative = path.relative(root, filePath);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function validateInstanceId(value) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(id)) {
    throw createBackupError("INVALID_INSTANCE_ID");
  }
  return id;
}

function validateBackupId(value) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,80}$/.test(id)) {
    throw createBackupError("INVALID_BACKUP_ID");
  }
  return id;
}

function sanitizeName(value, fallback) {
  return String(value || fallback || "Backup")
    .trim()
    .replace(/[^\w .-]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120) || "Backup";
}

function toArchivePath(value) {
  return String(value || "")
    .split(path.sep)
    .join("/")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/");
}

function assertSafeArchiveEntryName(name) {
  const normalized = toArchivePath(name);
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.includes("\\") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(normalized) ||
    /^[a-zA-Z]:/.test(normalized)
  ) {
    throw createBackupError("BACKUP_ARCHIVE_PATH_UNSAFE", 400);
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw createBackupError("BACKUP_ARCHIVE_PATH_UNSAFE", 400);
  }

  return segments.join("/");
}

function writeOctal(buffer, value, offset, length) {
  const text = Math.max(0, Number(value) || 0).toString(8).padStart(length - 1, "0").slice(-(length - 1));
  buffer.write(`${text}\0`, offset, length, "ascii");
}

function splitTarName(name) {
  const nameBuffer = Buffer.from(name);
  if (nameBuffer.length <= 100) {
    return { name, prefix: "" };
  }

  const segments = name.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const prefix = segments.slice(0, index).join("/");
    const suffix = segments.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(suffix) <= 100) {
      return { name: suffix, prefix };
    }
  }

  throw createBackupError("BACKUP_PATH_TOO_LONG", 400);
}

function createTarHeader(entry) {
  const safeName = assertSafeArchiveEntryName(entry.name);
  const split = splitTarName(safeName);
  const header = Buffer.alloc(TAR_BLOCK_SIZE, 0);
  header.write(split.name, 0, 100, "utf8");
  writeOctal(header, entry.mode || (entry.type === "directory" ? 0o755 : 0o644), 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, entry.type === "directory" ? 0 : entry.size || 0, 124, 12);
  writeOctal(header, Math.floor((entry.mtime || Date.now()) / 1000), 136, 12);
  header.fill(" ", 148, 156);
  header.write(entry.type === "directory" ? "5" : "0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (split.prefix) {
    header.write(split.prefix, 345, 155, "utf8");
  }
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const checksumText = checksum.toString(8).padStart(6, "0").slice(-6);
  header.write(`${checksumText}\0 `, 148, 8, "ascii");
  return header;
}

function padTarData(buffer) {
  const remainder = buffer.length % TAR_BLOCK_SIZE;
  return remainder === 0 ? Buffer.alloc(0) : Buffer.alloc(TAR_BLOCK_SIZE - remainder, 0);
}

async function collectArchiveEntries(instancePath, sourcePaths) {
  const entries = [];

  async function visit(relativePath) {
    const safeRelativePath = relativePath === "." ? "." : assertSafeArchiveEntryName(toArchivePath(relativePath));
    const absolutePath = path.resolve(instancePath, relativePath);
    if (!isInsideRoot(absolutePath, instancePath)) {
      throw createBackupError("PATH_NOT_ALLOWED", 403);
    }

    const stats = await fs.lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      throw createBackupError("BACKUP_UNSUPPORTED_FILE_TYPE", 400);
    }

    if (stats.isDirectory()) {
      const archivePath = safeRelativePath === "." ? "" : safeRelativePath.replace(/\/?$/, "/");
      if (archivePath) {
        entries.push({
          name: archivePath,
          absolutePath,
          type: "directory",
          size: 0,
          mtime: stats.mtimeMs,
          mode: stats.mode & 0o777,
        });
      }
      const children = await fs.readdir(absolutePath);
      children.sort((left, right) => left.localeCompare(right));
      for (const child of children) {
        await visit(relativePath === "." ? child : path.join(relativePath, child));
      }
      return;
    }

    if (!stats.isFile()) {
      throw createBackupError("BACKUP_UNSUPPORTED_FILE_TYPE", 400);
    }

    entries.push({
      name: safeRelativePath,
      absolutePath,
      type: "file",
      size: stats.size,
      mtime: stats.mtimeMs,
      mode: stats.mode & 0o777,
    });
  }

  for (const sourcePath of sourcePaths) {
    await visit(sourcePath);
  }

  return entries;
}

async function writeTarGzArchive(archivePathValue, instancePath, sourcePaths) {
  const entries = await collectArchiveEntries(instancePath, sourcePaths);
  const chunks = [];
  let uncompressedSize = 0;

  for (const entry of entries) {
    chunks.push(createTarHeader(entry));
    if (entry.type === "file") {
      const content = await fs.readFile(entry.absolutePath);
      chunks.push(content, padTarData(content));
      uncompressedSize += content.length;
    }
  }

  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2, 0));
  const archiveBuffer = zlib.gzipSync(Buffer.concat(chunks));
  const tempPath = `${archivePathValue}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, archiveBuffer, { mode: 0o600 });
    await fs.rename(tempPath, archivePathValue);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
  return {
    entryCount: entries.length,
    uncompressedSize,
    // Digest of exactly the bytes renamed into place so the create-time
    // integrity hash in metadata can never drift from the stored archive.
    sha256: sha256Hex(archiveBuffer),
  };
}

function parseOctal(buffer, offset, length) {
  const text = buffer.subarray(offset, offset + length).toString("ascii").replace(/\0.*$/, "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function readTarString(buffer, offset, length) {
  return buffer.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/, "");
}

function parseTarEntries(archiveBuffer, options = {}) {
  const maxArchiveBytes = Math.max(1, Number(options.maxArchiveBytes) || MAX_BACKUP_ARCHIVE_BYTES);
  const maxExpandedBytes = Math.max(1, Number(options.maxExpandedBytes) || MAX_BACKUP_EXPANDED_BYTES);
  const maxEntryBytes = Math.max(1, Number(options.maxEntryBytes) || MAX_BACKUP_ENTRY_BYTES);
  const maxEntryCount = Math.max(1, Number(options.maxEntryCount) || MAX_BACKUP_ENTRY_COUNT);
  const maxCompressionRatio = Math.max(1, Number(options.maxCompressionRatio) || MAX_BACKUP_COMPRESSION_RATIO);
  const compressionCheckMinBytes = Math.max(1, Number(options.compressionCheckMinBytes) || 16 * 1024 * 1024);
  if (!Buffer.isBuffer(archiveBuffer) || archiveBuffer.length > maxArchiveBytes) {
    throw createBackupError("BACKUP_ARCHIVE_LIMIT_EXCEEDED", 413, { archiveBytes: archiveBuffer?.length || 0, maxArchiveBytes });
  }
  let tarBuffer;
  try {
    tarBuffer = zlib.gunzipSync(archiveBuffer, { maxOutputLength: maxExpandedBytes });
  } catch (error) {
    if (error?.code === "ERR_BUFFER_TOO_LARGE" || /larger than|output length/i.test(error?.message || "")) {
      throw createBackupError("BACKUP_ARCHIVE_LIMIT_EXCEEDED", 413, { maxExpandedBytes });
    }
    throw createBackupError("BACKUP_ARCHIVE_INVALID", 400);
  }
  if (archiveBuffer.length > 0 && tarBuffer.length >= compressionCheckMinBytes && tarBuffer.length / archiveBuffer.length > maxCompressionRatio) {
    throw createBackupError("BACKUP_ARCHIVE_COMPRESSION_UNSAFE", 400, { archiveBytes: archiveBuffer.length, expandedBytes: tarBuffer.length, maxCompressionRatio });
  }

  const entries = [];
  let offset = 0;
  let totalSize = 0;

  while (offset + TAR_BLOCK_SIZE <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + TAR_BLOCK_SIZE);
    offset += TAR_BLOCK_SIZE;
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const expectedChecksum = parseOctal(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(" ", 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (!Number.isFinite(expectedChecksum) || expectedChecksum !== actualChecksum) {
      throw createBackupError("BACKUP_ARCHIVE_CHECKSUM_INVALID", 400);
    }

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const fullName = assertSafeArchiveEntryName(prefix ? `${prefix}/${name}` : name);
    const typeFlag = readTarString(header, 156, 1) || "0";
    const size = parseOctal(header, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > tarBuffer.length) {
      throw createBackupError("BACKUP_ARCHIVE_INVALID", 400);
    }
    if (!["0", "5", ""].includes(typeFlag)) {
      throw createBackupError("BACKUP_ARCHIVE_UNSUPPORTED_ENTRY", 400);
    }
    if (size > maxEntryBytes) {
      throw createBackupError("BACKUP_ARCHIVE_LIMIT_EXCEEDED", 413, { entryName: fullName, entryBytes: size, maxEntryBytes });
    }
    if (entries.length + 1 > maxEntryCount) {
      throw createBackupError("BACKUP_ARCHIVE_LIMIT_EXCEEDED", 413, { entryCount: entries.length + 1, maxEntryCount });
    }

    entries.push({
      name: fullName,
      type: typeFlag === "5" ? "directory" : "file",
      size: typeFlag === "5" ? 0 : size,
      dataStart: offset,
      dataEnd: offset + size,
      tarBuffer,
    });
    totalSize += typeFlag === "5" ? 0 : size;
    if (totalSize > maxExpandedBytes) {
      throw createBackupError("BACKUP_ARCHIVE_LIMIT_EXCEEDED", 413, { expandedBytes: totalSize, maxExpandedBytes });
    }
    offset += size + ((TAR_BLOCK_SIZE - (size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE);
  }

  if (entries.length === 0) {
    throw createBackupError("BACKUP_ARCHIVE_EMPTY", 400);
  }

  return {
    entries,
    totalSize,
  };
}

// Header checks alone cannot detect corruption inside file payloads that keeps
// the tar structure intact, so callers with a create-time digest get a whole
// archive hash verification first. Legacy metadata without a digest keeps the
// header-only validation: the field stays absent rather than being fabricated.
async function validateArchiveFile(archivePathValue, expectedSha256 = null) {
  const archiveBuffer = await fs.readFile(archivePathValue);
  const actualSha256 = sha256Hex(archiveBuffer);
  if (expectedSha256 && actualSha256 !== expectedSha256) {
    throw createBackupError("BACKUP_ARCHIVE_HASH_MISMATCH", 400, { expectedSha256, actualSha256 });
  }
  const validation = parseTarEntries(archiveBuffer);
  return {
    entryCount: validation.entries.length,
    uncompressedSize: validation.totalSize,
    sha256: actualSha256,
  };
}

async function extractTarGzArchive(archivePathValue, destinationRoot) {
  const archiveBuffer = await fs.readFile(archivePathValue);
  const validation = parseTarEntries(archiveBuffer);
  const realDestinationRoot = await fs.realpath(destinationRoot).catch(() => destinationRoot);

  for (const entry of validation.entries) {
    const targetPath = path.resolve(destinationRoot, ...entry.name.split("/"));
    if (!isInsideRoot(targetPath, realDestinationRoot)) {
      throw createBackupError("BACKUP_ARCHIVE_PATH_UNSAFE", 400);
    }

    if (entry.type === "directory") {
      await fs.mkdir(targetPath, { recursive: true, mode: 0o700 });
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    await fs.writeFile(targetPath, entry.tarBuffer.subarray(entry.dataStart, entry.dataEnd), { mode: 0o600 });
  }

  return {
    entryCount: validation.entries.length,
    uncompressedSize: validation.totalSize,
  };
}

function metadataPath(backupId) {
  return path.join(getBackupRoot(), `${backupId}.json`);
}

function archivePath(backupId) {
  return path.join(getBackupRoot(), `${backupId}${BACKUP_EXTENSION}`);
}

function schedulesPath() {
  return path.join(getBackupRoot(), "schedules.json");
}

async function ensureBackupRoot() {
  await fs.mkdir(getBackupRoot(), { recursive: true, mode: 0o700 });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

async function getFileSize(filePath) {
  return (await fs.stat(filePath)).size;
}

async function calculatePathSize(filePath) {
  const stats = await fs.lstat(filePath);
  if (stats.isSymbolicLink()) return 0;
  if (stats.isFile()) return stats.size;
  if (!stats.isDirectory()) return 0;
  const entries = await fs.readdir(filePath);
  let total = 0;
  for (const entry of entries) total += await calculatePathSize(path.join(filePath, entry));
  return total;
}

async function ensureDiskSpace(targetPath, requiredBytes, errorCode) {
  let stats;
  try {
    stats = await fs.statfs(targetPath);
  } catch (error) {
    throw createBackupError("BACKUP_DISK_SPACE_CHECK_FAILED", 500, { targetPath, causeCode: error?.code || "STATFS_FAILED" });
  }
  const blockSize = Number(stats.bsize || 0);
  const availableBlocks = Number(stats.bavail ?? stats.bfree ?? 0);
  const availableBytes = blockSize * availableBlocks;
  const payloadBytes = Math.max(0, Number(requiredBytes) || 0);
  const reserveBytes = Math.max(MINIMUM_DISK_RESERVE_BYTES, Math.ceil(payloadBytes * 0.05));
  if (!Number.isFinite(availableBytes) || availableBytes < payloadBytes + reserveBytes) {
    throw createBackupError(errorCode, 507, { requiredBytes: payloadBytes, reserveBytes, availableBytes });
  }
  return { requiredBytes: payloadBytes, reserveBytes, availableBytes };
}

async function getInstancePath(instanceId) {
  const root = getInstanceRoot();
  const resolved = path.resolve(root, validateInstanceId(instanceId));
  if (!isInsideRoot(resolved, root)) {
    throw createBackupError("PATH_NOT_ALLOWED", 403);
  }
  const real = await fs.realpath(resolved).catch(() => {
    throw createBackupError("INSTANCE_NOT_FOUND", 404);
  });
  const realRoot = await fs.realpath(root).catch(() => root);
  if (!isInsideRoot(real, realRoot)) {
    throw createBackupError("PATH_NOT_ALLOWED", 403);
  }
  return real;
}

// Fallback world-scope candidates relative to the instance root. They carry the
// historical Minecraft-style layout and remain the only candidates for
// Minecraft instances and for instances without a recognized game identity.
const GENERIC_WORLD_SOURCE_CANDIDATES = ["data/world", "data/worlds", "data/Worlds"];

async function readInstanceConfigSnapshot(instancePath) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(instancePath, "config.json"), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    // Missing or unreadable instance records keep the generic world candidates
    // so legacy and externally created instances back up exactly as before.
    return null;
  }
}

async function getSourcePaths(instancePath, type) {
  if (type !== "world") {
    return ["."];
  }

  const config = await readInstanceConfigSnapshot(instancePath);
  // Per-candidate guard: an odd game layout (for example a Palworld template
  // with steamInstallDir ".") must not throw out of the whole resolution —
  // an unsafe candidate is simply dropped and the generic candidates still
  // apply.
  const perGameCandidates = (config && typeof instanceService.getWorldScopeCandidates === "function"
    ? instanceService.getWorldScopeCandidates(config)
    : []
  ).flatMap((candidate) => {
    try {
      return [assertSafeArchiveEntryName(`data/${candidate}`)];
    } catch {
      return [];
    }
  });
  const candidates = [...new Set([...perGameCandidates, ...GENERIC_WORLD_SOURCE_CANDIDATES])];

  const existing = [];
  for (const candidate of candidates) {
    const source = path.join(instancePath, candidate);
    if (await fs.stat(source).then((stats) => stats.isDirectory(), () => false)) {
      existing.push(candidate);
    }
  }

  // Keep the deepest matching directories so a nested per-game layout (for
  // example data/server/Pal/Saved) is not archived twice alongside a parent
  // candidate; the generic candidates are siblings and are unaffected.
  const selected = existing.filter((candidate) => !existing.some((other) => (
    other !== candidate && (other === "." || candidate.startsWith(`${other}/`))
  )));

  if (selected.length === 0) {
    throw createBackupError("WORLD_PATH_NOT_FOUND", 404);
  }

  return selected;
}

async function listMetadataFiles() {
  await ensureBackupRoot();
  const entries = await fs.readdir(getBackupRoot(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "schedules.json")
    .map((entry) => path.join(getBackupRoot(), entry.name));
}

async function readSchedules() {
  await ensureBackupRoot();
  const filePath = schedulesPath();
  if (!await fs.stat(filePath).then((stats) => stats.isFile(), () => false)) return [];
  let parsed;
  try {
    parsed = await readJson(filePath);
  } catch (error) {
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    await fs.copyFile(filePath, backupPath, fsSync.constants.COPYFILE_EXCL).catch(() => {});
    throw createBackupError("BACKUP_SCHEDULE_STORE_CORRUPT", 500, { causeCode: error?.code || "INVALID_JSON" });
  }
  const schemaVersion = Number.isInteger(parsed?.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > BACKUP_SCHEDULE_SCHEMA_VERSION) {
    throw createBackupError("BACKUP_SCHEDULE_SCHEMA_UNSUPPORTED", 409, { schemaVersion, supportedSchemaVersion: BACKUP_SCHEDULE_SCHEMA_VERSION });
  }
  const schedules = Array.isArray(parsed?.schedules) ? parsed.schedules : [];
  if (schemaVersion < BACKUP_SCHEDULE_SCHEMA_VERSION) {
    const backupPath = `${filePath}.schema-v${schemaVersion}.backup`;
    if (!await fs.stat(backupPath).then(() => true, () => false)) await fs.copyFile(filePath, backupPath, fsSync.constants.COPYFILE_EXCL);
    await writeSchedules(schedules);
  }
  return schedules;
}

async function writeSchedules(schedules) {
  await ensureBackupRoot();
  await writeJson(schedulesPath(), { schemaVersion: BACKUP_SCHEDULE_SCHEMA_VERSION, schedules });
}

async function listSchedules() {
  return { schedules: await readSchedules() };
}

async function saveSchedule(payload = {}) {
  const instanceId = validateInstanceId(payload.instanceId);
  const intervalHours = Number.parseInt(payload.intervalHours, 10);
  if (!Number.isFinite(intervalHours) || intervalHours < 1 || intervalHours > 24 * 30) {
    throw createBackupError("INVALID_SCHEDULE_INTERVAL");
  }
  const schedule = {
    id: instanceId,
    instanceId,
    enabled: payload.enabled !== false,
    type: String(payload.type || "full") === "world" ? "world" : "full",
    intervalHours,
    keepLast: Number.parseInt(payload.keepLast, 10) || DEFAULT_RETENTION_COUNT,
    maxAgeDays: Number.parseInt(payload.maxAgeDays, 10) || DEFAULT_RETENTION_DAYS,
    nextRunAt: payload.nextRunAt || new Date(Date.now() + intervalHours * 60 * 60 * 1000).toISOString(),
    updatedAt: nowIso(),
  };
  const schedules = (await readSchedules()).filter((entry) => entry.instanceId !== instanceId);
  schedules.push(schedule);
  await writeSchedules(schedules);
  return { schedule };
}

async function deleteSchedule(instanceId) {
  const id = validateInstanceId(instanceId);
  const schedules = (await readSchedules()).filter((entry) => entry.instanceId !== id);
  await writeSchedules(schedules);
  return { id, deleted: true };
}

async function readBackupMetadata(backupId) {
  const id = validateBackupId(backupId);
  const filePath = metadataPath(id);
  let metadata;
  try {
    metadata = await readJson(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw createBackupError("BACKUP_NOT_FOUND", 404);
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    await fs.copyFile(filePath, backupPath, fsSync.constants.COPYFILE_EXCL).catch(() => {});
    throw createBackupError("BACKUP_METADATA_CORRUPT", 500, { backupId: id, causeCode: error?.code || "INVALID_JSON" });
  }
  const schemaVersion = Number.isInteger(metadata?.schemaVersion) ? metadata.schemaVersion : 0;
  if (schemaVersion > BACKUP_METADATA_SCHEMA_VERSION) {
    throw createBackupError("BACKUP_METADATA_SCHEMA_UNSUPPORTED", 409, { backupId: id, schemaVersion, supportedSchemaVersion: BACKUP_METADATA_SCHEMA_VERSION });
  }
  if (schemaVersion < BACKUP_METADATA_SCHEMA_VERSION) {
    const backupPath = `${filePath}.schema-v${schemaVersion}.backup`;
    if (!await fs.stat(backupPath).then(() => true, () => false)) await fs.copyFile(filePath, backupPath, fsSync.constants.COPYFILE_EXCL);
    metadata = { ...metadata, schemaVersion: BACKUP_METADATA_SCHEMA_VERSION };
    await writeJson(filePath, metadata);
  }
  const archive = archivePath(id);
  const size = await getFileSize(archive).catch(() => metadata.size || 0);
  return {
    ...metadata,
    path: archive,
    size,
  };
}

async function listBackups(options = {}) {
  const files = await listMetadataFiles();
  const backups = [];
  const metadataErrors = [];

  for (const file of files) {
    try {
      backups.push(await readBackupMetadata(path.basename(file, ".json")));
    } catch (error) {
      metadataErrors.push({ file: path.basename(file), code: error?.code || "BACKUP_METADATA_INVALID" });
    }
  }

  const filtered = options.instanceId
    ? backups.filter((backup) => backup.instanceId === options.instanceId)
    : backups;
  filtered.sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));

  // Additive health reporting: backup age versus the standing retention policy
  // and the owning schedule's last run outcome. A broken schedule store must
  // not take the backup list down, so its error code lands in diagnostics.
  let schedules = [];
  let scheduleStoreErrorCode = null;
  try {
    schedules = await readSchedules();
  } catch (error) {
    scheduleStoreErrorCode = error?.code || "BACKUP_SCHEDULE_STORE_UNAVAILABLE";
  }
  const scheduleByInstance = new Map(schedules.map((schedule) => [schedule.instanceId, schedule]));
  const newestBackupIds = new Map();
  const instanceIndexes = new Map();
  const nowMs = Date.now();
  for (const backup of filtered) {
    // Older metadata predates consistency disclosure; every copy taken before
    // the stopped option existed was crash-consistent, so the displayed value
    // defaults instead of inventing per-backup history.
    backup.consistency = backup.consistency === "stopped" ? "stopped" : "crash";
    const instanceIndex = instanceIndexes.get(backup.instanceId) ?? 0;
    instanceIndexes.set(backup.instanceId, instanceIndex + 1);
    if (!newestBackupIds.has(backup.instanceId)) {
      newestBackupIds.set(backup.instanceId, backup.id);
    }
    const schedule = scheduleByInstance.get(backup.instanceId) || null;
    const keepLast = Number.parseInt(schedule?.keepLast ?? process.env.AGENT_BACKUP_KEEP_LAST ?? DEFAULT_RETENTION_COUNT, 10);
    const maxAgeDays = Number.parseInt(schedule?.maxAgeDays ?? process.env.AGENT_BACKUP_MAX_AGE_DAYS ?? DEFAULT_RETENTION_DAYS, 10);
    const createdAtMs = new Date(backup.createdAt).getTime();
    const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, nowMs - createdAtMs) : null;
    const tooOld = ageMs !== null && createdAtMs < retentionCutoffMs(maxAgeDays);
    const beyondKeepLast = Number.isFinite(keepLast) && keepLast > 0 && instanceIndex >= keepLast;
    const reasons = [];
    if (tooOld) reasons.push("backup_age_exceeds_max_age_days");
    if (beyondKeepLast) reasons.push("beyond_keep_last_count");

    backup.backupAgeHours = ageMs === null ? null : ageMs / (60 * 60 * 1000);
    backup.backupAgeDays = ageMs === null ? null : ageMs / (24 * 60 * 60 * 1000);
    backup.protectedNewest = newestBackupIds.get(backup.instanceId) === backup.id;
    backup.retentionPolicy = { keepLast, maxAgeDays, source: schedule ? "schedule" : "default" };
    backup.retentionPolicyMet = reasons.length === 0;
    backup.retentionPolicyReason = reasons.length > 0 ? reasons[0] : null;
    backup.scheduleHealth = schedule
      ? {
          enabled: schedule.enabled !== false,
          type: schedule.type || "full",
          intervalHours: schedule.intervalHours ?? null,
          lastRunAt: schedule.lastRunAt || null,
          lastError: schedule.lastError || null,
          nextRunAt: schedule.nextRunAt || null,
        }
      : null;
  }

  return {
    root: getBackupRoot(),
    roots: [getBackupRoot()],
    backups: filtered,
    summary: {
      totalBackups: filtered.length,
      totalSize: filtered.reduce((total, backup) => total + (Number(backup.size) || 0), 0),
      lastBackupAt: filtered[0]?.createdAt || null,
    },
    diagnostics: {
      metadataErrors,
      scheduleStoreErrorCode,
      roots: [{
        path: getBackupRoot(),
        resolvedPath: getBackupRoot(),
        ok: true,
        errorCode: null,
      }],
    },
  };
}

// Shared with the listBackups policy verdict so reported health always mirrors
// what a prune with the same policy would actually delete.
function retentionCutoffMs(maxAgeDays) {
  return Date.now() - Math.max(maxAgeDays, 1) * 24 * 60 * 60 * 1000;
}

async function pruneRetention(instanceId, options = {}) {
  const keepLast = Number.parseInt(options.keepLast ?? process.env.AGENT_BACKUP_KEEP_LAST ?? DEFAULT_RETENTION_COUNT, 10);
  const maxAgeDays = Number.parseInt(options.maxAgeDays ?? process.env.AGENT_BACKUP_MAX_AGE_DAYS ?? DEFAULT_RETENTION_DAYS, 10);
  const backups = (await listBackups({ instanceId })).backups;
  const cutoff = retentionCutoffMs(maxAgeDays);
  const pruned = [];
  const skipped = [];

  for (const [index, backup] of backups.entries()) {
    const tooMany = Number.isFinite(keepLast) && keepLast > 0 && index >= keepLast;
    const tooOld = new Date(backup.createdAt).getTime() < cutoff;
    if (!tooMany && !tooOld) {
      continue;
    }
    if (index === 0) {
      // Never prune the newest recovery point of an instance: even when the age
      // or count policy says it should go, deleting the last recovery point
      // would leave the instance with nothing to restore.
      skipped.push({
        backupId: backup.id,
        protectedAs: "newest",
        reason: tooOld ? "backup_age_exceeds_max_age_days" : "beyond_keep_last_count",
      });
      continue;
    }
    await deleteBackup(backup.id).catch(() => {});
    pruned.push(backup.id);
  }
  return { pruned, skipped };
}

async function performCreateBackup(payload = {}) {
  const instanceId = validateInstanceId(payload.instanceId);
  const type = String(payload.type || "full") === "world" ? "world" : "full";
  const consistency = normalizeBackupConsistency(payload.consistency);
  const instancePath = await getInstancePath(instanceId);
  const sourcePaths = await getSourcePaths(instancePath, type);
  await ensureBackupRoot();
  let sourceSize = 0;
  for (const sourcePath of sourcePaths) sourceSize += await calculatePathSize(path.resolve(instancePath, sourcePath));
  if (sourceSize > MAX_BACKUP_EXPANDED_BYTES) {
    throw createBackupError("BACKUP_SOURCE_LIMIT_EXCEEDED", 413, { sourceSize, maxSourceBytes: MAX_BACKUP_EXPANDED_BYTES });
  }
  await ensureDiskSpace(getBackupRoot(), sourceSize, "BACKUP_DISK_SPACE_INSUFFICIENT");

  // Workload-consistent backup hook (V2-F): "crash" stays byte-identical to
  // the historical behavior — files are archived while the instance keeps
  // running, which is disclosed as crash-consistent. When the caller asks for
  // "stopped", the instance is quiesced through the same canonical stop path
  // the restore flow uses; an already-stopped instance is never stopped or
  // restarted again.
  let instanceWasRunning = null;
  let stoppedForBackup = false;
  if (consistency === "stopped") {
    const { before } = await stopInstanceAndWait(instanceId, {
      stopFailed: "BACKUP_INSTANCE_STOP_FAILED",
      stillRunning: "BACKUP_INSTANCE_STILL_RUNNING",
    });
    instanceWasRunning = isInstanceActive(before);
    stoppedForBackup = instanceWasRunning;
  } else {
    // Crash-consistent copies never touch the lifecycle, so the running flag
    // is disclosure metadata only and an unobservable state is recorded as
    // null rather than guessed.
    instanceWasRunning = await instanceService.getStatus(instanceId)
      .then((status) => isInstanceActive(status))
      .catch(() => null);
  }

  const backupId = `${instanceId}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const archive = archivePath(backupId);
  let archiveDetails;
  let restartAfterBackup = null;
  try {
    archiveDetails = await writeTarGzArchive(archive, instancePath, sourcePaths);
  } finally {
    // The stopped window covers only the archive step, and the restart holds
    // whether the archive succeeded or failed so a paused server is never
    // left down by a failed backup.
    if (stoppedForBackup) {
      restartAfterBackup = await restartInstanceAfterBackup(instanceId);
    }
  }
  const metadata = {
    schemaVersion: BACKUP_METADATA_SCHEMA_VERSION,
    id: backupId,
    instanceId,
    name: sanitizeName(payload.name, `${instanceId} ${type} backup`),
    createdAt: nowIso(),
    createdBy: sanitizeName(payload.createdBy, "local-user"),
    type,
    size: await getFileSize(archive),
    uncompressedSize: archiveDetails.uncompressedSize,
    requiredDiskSpace: archiveDetails.uncompressedSize,
    entryCount: archiveDetails.entryCount,
    compression: BACKUP_FORMAT,
    archiveSha256: archiveDetails.sha256,
    sourcePaths,
    archiveName: path.basename(archive),
    status: "complete",
    // Additive consistency disclosure (schema stays at 1): how the copy was
    // taken and whether the instance had to be stopped and started again.
    consistency,
    instanceWasRunning,
    restartedAfterBackup: restartAfterBackup?.restarted === true,
  };
  if (restartAfterBackup?.attempted && restartAfterBackup.restarted === false) {
    metadata.restartAfterBackupError = {
      code: restartAfterBackup.errorCode,
      message: restartAfterBackup.errorMessage,
    };
  }
  try {
    await writeJson(metadataPath(backupId), metadata);
  } catch (error) {
    await fs.rm(archive, { force: true }).catch(() => {});
    throw error;
  }
  const retention = await pruneRetention(instanceId, payload.retention || {});
  return { backup: metadata, retention, restart: restartAfterBackup || IDLE_RESTART_REPORT };
}

async function createBackup(payload = {}) {
  const instanceId = validateInstanceId(payload.instanceId);
  const operation = acquireBackupLock(instanceId, "backup-create");
  // Registered immediately so a failed create can genuinely be retried through
  // longOperations.retryOperation() rather than only resetting status.
  longOperations.registerRetryHandler(operation.id, () => createBackup(payload));
  try {
    const result = await performCreateBackup(payload);
    longOperations.completeOperation(operation.id, { metadata: { instanceId, backupId: result.backup.id } });
    return result;
  } catch (error) {
    longOperations.failOperation(operation.id, {
      code: error?.code || "BACKUP_CREATE_FAILED",
      message: error?.message || "Backup creation failed.",
    }, { retryable: true });
    throw error;
  }
}

async function deleteBackup(backupId) {
  const id = validateBackupId(backupId);
  const metadata = await readBackupMetadata(id).catch((error) => {
    if (error?.code === "BACKUP_NOT_FOUND") {
      return null;
    }
    throw error;
  });
  if (!metadata) {
    return { id, deleted: false, alreadyDeleted: true };
  }
  await fs.rm(metadata.path, { force: true });
  await fs.rm(metadataPath(metadata.id), { force: true });
  return { id: metadata.id, deleted: true };
}

async function createSafetySnapshot(instanceId, type = "full") {
  // Called from within restoreBackup, which already holds the backup:${instanceId}
  // lock for the duration of the restore, so this bypasses the public locked entry
  // point to avoid a false self-conflict on the same lock key.
  return performCreateBackup({
    instanceId,
    name: `${instanceId} safety snapshot before restore`,
    type: type === "world" ? "world" : "full",
    createdBy: "restore-safety",
    retention: { keepLast: 9999, maxAgeDays: 3650 },
  });
}

// Canonical stop-then-verify pattern: read the live status, stop through the
// instance lifecycle when the workload is active, then re-verify the stop
// actually landed before callers depend on a quiesced instance. Restore and
// stopped-consistency backups share it so both flows stop the same way.
async function stopInstanceAndWait(instanceId, errorCodes) {
  const before = await instanceService.getStatus(instanceId);
  if (isInstanceActive(before)) {
    try {
      await instanceService.stopInstance(instanceId);
    } catch (error) {
      throw createBackupError(errorCodes.stopFailed, 409, {
        instanceId,
        causeCode: error?.code || "INSTANCE_STOP_FAILED",
      });
    }
  }
  const after = await instanceService.getStatus(instanceId);
  if (isInstanceActive(after)) {
    throw createBackupError(errorCodes.stillRunning, 409, {
      instanceId,
      state: after?.state || "Unknown",
      pid: after?.pid || null,
    });
  }
  return { before, after };
}

async function ensureInstanceStoppedForRestore(instanceId) {
  return (await stopInstanceAndWait(instanceId, {
    stopFailed: "RESTORE_INSTANCE_STOP_FAILED",
    stillRunning: "RESTORE_INSTANCE_STILL_RUNNING",
  })).after;
}

// Best-effort restart through the same canonical start path the restore flow
// uses. A failed restart never fails the backup itself, but it is reported in
// the create result and metadata instead of being silently swallowed.
async function restartInstanceAfterBackup(instanceId) {
  try {
    await instanceService.startInstance(instanceId);
    return { attempted: true, restarted: true, errorCode: null, errorMessage: null };
  } catch (error) {
    return {
      attempted: true,
      restarted: false,
      errorCode: error?.code || "INSTANCE_START_FAILED",
      errorMessage: String(error?.message || "Instance restart after backup failed."),
    };
  }
}

const IDLE_RESTART_REPORT = Object.freeze({ attempted: false, restarted: false, errorCode: null, errorMessage: null });

async function rollbackRestoreFromSafetySnapshot(instancePath, safetyBackup) {
  if (!safetyBackup?.path) {
    throw createBackupError("RESTORE_SAFETY_SNAPSHOT_MISSING", 500);
  }
  await validateArchiveFile(safetyBackup.path, safetyBackup.archiveSha256);
  if (safetyBackup.type === "world") {
    for (const sourcePath of Array.isArray(safetyBackup.sourcePaths) ? safetyBackup.sourcePaths : []) {
      const targetPath = path.resolve(instancePath, sourcePath);
      if (!isInsideRoot(targetPath, instancePath)) {
        throw createBackupError("BACKUP_ARCHIVE_PATH_UNSAFE", 400);
      }
      await fs.rm(targetPath, { recursive: true, force: true });
    }
  } else {
    await fs.rm(instancePath, { recursive: true, force: true });
    await fs.mkdir(instancePath, { recursive: true, mode: 0o700 });
  }
  await extractTarGzArchive(safetyBackup.path, instancePath);
  const rollbackVerified = safetyBackup.type === "world"
    ? (Array.isArray(safetyBackup.sourcePaths) && safetyBackup.sourcePaths.length > 0 && await Promise.all(
      safetyBackup.sourcePaths.map((sourcePath) => fs.stat(path.resolve(instancePath, sourcePath)).then(() => true, () => false)),
    )).every(Boolean)
    : await fs.stat(path.join(instancePath, "config.json")).then((stats) => stats.isFile(), () => false);
  if (!rollbackVerified) {
    throw createBackupError("RESTORE_ROLLBACK_VERIFICATION_FAILED", 500);
  }
  return { rolledBack: true, safetyBackupId: safetyBackup.id };
}

async function restoreBackup(payload = {}) {
  const backup = await readBackupMetadata(payload.backupId);
  const instanceId = validateInstanceId(payload.instanceId || backup.instanceId);
  if (instanceId !== backup.instanceId) {
    throw createBackupError("BACKUP_INSTANCE_MISMATCH");
  }
  if (payload.confirmOverwrite !== true) {
    throw createBackupError("RESTORE_OVERWRITE_CONFIRMATION_REQUIRED", 400);
  }
  const operation = acquireBackupLock(instanceId, "backup-restore", { rollbackSupported: true });
  // Registered immediately so a failed restore can genuinely be retried
  // through longOperations.retryOperation() rather than only resetting status.
  longOperations.registerRetryHandler(operation.id, () => restoreBackup(payload));
  let instancePath = null;
  let safety = null;
  let mutationStarted = false;
  try {
    instancePath = await getInstancePath(instanceId);
    const validation = await validateArchiveFile(backup.path, backup.archiveSha256);

    await ensureInstanceStoppedForRestore(instanceId);
    const safetySourcePaths = await getSourcePaths(instancePath, backup.type);
    let safetySnapshotSize = 0;
    for (const sourcePath of safetySourcePaths) {
      safetySnapshotSize += await calculatePathSize(path.resolve(instancePath, sourcePath));
    }
    await ensureDiskSpace(getBackupRoot(), safetySnapshotSize, "RESTORE_SNAPSHOT_DISK_SPACE_INSUFFICIENT");
    await ensureDiskSpace(path.dirname(instancePath), validation.uncompressedSize, "RESTORE_DISK_SPACE_INSUFFICIENT");
    safety = await createSafetySnapshot(instanceId, backup.type);
    mutationStarted = true;
    if (backup.type === "world") {
      for (const sourcePath of Array.isArray(backup.sourcePaths) ? backup.sourcePaths : []) {
        const targetPath = path.resolve(instancePath, sourcePath);
        if (!isInsideRoot(targetPath, instancePath)) {
          throw createBackupError("BACKUP_ARCHIVE_PATH_UNSAFE", 400);
        }
        await fs.rm(targetPath, { recursive: true, force: true });
      }
    } else {
      await fs.rm(instancePath, { recursive: true, force: true });
      await fs.mkdir(instancePath, { recursive: true, mode: 0o700 });
    }
    await extractTarGzArchive(backup.path, instancePath);

    if (backup.type !== "world" && !await fs.stat(path.join(instancePath, "config.json")).then((stats) => stats.isFile(), () => false)) {
      throw createBackupError("RESTORE_VERIFICATION_FAILED", 500);
    }

    const restored = {
      backupId: backup.id,
      instanceId,
      safetyBackupId: safety.backup.id,
      requiredDiskSpace: validation.uncompressedSize,
      restoredEntries: validation.entryCount,
      restoredAt: nowIso(),
    };

    if (payload.restart === true) {
      await instanceService.startInstance(instanceId).catch(() => {});
    }

    longOperations.completeOperation(operation.id, { metadata: { instanceId, backupId: backup.id, safetyBackupId: safety.backup.id } });
    return { restore: restored };
  } catch (error) {
    let rollback = null;
    if (mutationStarted && instancePath && safety?.backup) {
      try {
        rollback = await rollbackRestoreFromSafetySnapshot(instancePath, safety.backup);
      } catch (rollbackError) {
        const failure = createBackupError("RESTORE_ROLLBACK_FAILED", 500, {
          instanceId,
          backupId: backup.id,
          safetyBackupId: safety.backup.id,
          causeCode: error?.code || "BACKUP_RESTORE_FAILED",
          rollbackCauseCode: rollbackError?.code || "RESTORE_ROLLBACK_FAILED",
        });
        longOperations.failOperation(operation.id, { code: failure.code, message: failure.message }, { retryable: false });
        throw failure;
      }
    }
    if (rollback) {
      error.details = {
        ...(error.details || {}),
        rollback,
      };
    }
    longOperations.failOperation(operation.id, {
      code: error?.code || "BACKUP_RESTORE_FAILED",
      message: error?.message || "Backup restore failed.",
    }, { retryable: true });
    throw error;
  }
}

async function importBackup(payload = {}) {
  const instanceId = validateInstanceId(payload.instanceId);
  const content = String(payload.content || "");
  if (!content) {
    throw createBackupError("BACKUP_CONTENT_REQUIRED");
  }
  const estimatedBytes = payload.encoding === "base64" ? Math.ceil(content.length * 0.75) : Buffer.byteLength(content, "utf8");
  if (estimatedBytes > MAX_BACKUP_ARCHIVE_BYTES) {
    throw createBackupError("BACKUP_ARCHIVE_LIMIT_EXCEEDED", 413, { estimatedBytes, maxArchiveBytes: MAX_BACKUP_ARCHIVE_BYTES });
  }
  await ensureBackupRoot();
  const backupId = `${instanceId}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
  const archive = archivePath(backupId);
  const tempArchive = `${archive}.${process.pid}.${Date.now()}.tmp`;
  let archiveDetails;
  try {
    await fs.writeFile(tempArchive, Buffer.from(content, payload.encoding === "base64" ? "base64" : "utf8"), { mode: 0o600 });
    archiveDetails = await validateArchiveFile(tempArchive);
    await fs.rename(tempArchive, archive);
  } catch (error) {
    await fs.rm(tempArchive, { force: true }).catch(() => {});
    throw error;
  }
  const metadata = {
    schemaVersion: BACKUP_METADATA_SCHEMA_VERSION,
    id: backupId,
    instanceId,
    name: sanitizeName(payload.name, `${instanceId} imported backup`),
    createdAt: nowIso(),
    createdBy: sanitizeName(payload.createdBy, "import"),
    type: String(payload.type || "full") === "world" ? "world" : "full",
    size: await getFileSize(archive),
    uncompressedSize: archiveDetails.uncompressedSize,
    requiredDiskSpace: archiveDetails.uncompressedSize,
    entryCount: archiveDetails.entryCount,
    compression: BACKUP_FORMAT,
    archiveSha256: archiveDetails.sha256,
    sourcePaths: ["."],
    archiveName: path.basename(archive),
    status: "imported",
  };
  try {
    await writeJson(metadataPath(backupId), metadata);
  } catch (error) {
    await fs.rm(archive, { force: true }).catch(() => {});
    throw error;
  }
  return { backup: metadata };
}

async function getBackupDownload(backupId) {
  const backup = await readBackupMetadata(backupId);
  return {
    backup,
    stream: fsSync.createReadStream(backup.path),
    headers: {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="${backup.archiveName || path.basename(backup.path)}"`,
    },
  };
}

async function runDueSchedules() {
  const schedules = await readSchedules();
  const now = Date.now();
  let changed = false;

  for (const schedule of schedules) {
    if (!schedule.enabled || new Date(schedule.nextRunAt || 0).getTime() > now) {
      continue;
    }

    try {
      await createBackup({
        instanceId: schedule.instanceId,
        type: schedule.type,
        name: `${schedule.instanceId} scheduled ${schedule.type} backup`,
        createdBy: "schedule",
        retention: {
          keepLast: schedule.keepLast,
          maxAgeDays: schedule.maxAgeDays,
        },
      });
      schedule.lastRunAt = nowIso();
      schedule.lastError = null;
    } catch (error) {
      schedule.lastError = error?.code || "SCHEDULE_FAILED";
    }

    schedule.nextRunAt = new Date(Date.now() + schedule.intervalHours * 60 * 60 * 1000).toISOString();
    schedule.updatedAt = nowIso();
    changed = true;
  }

  if (changed) {
    await writeSchedules(schedules);
  }
}

function startBackupScheduler() {
  if (schedulerStarted) {
    return;
  }
  schedulerStarted = true;
  schedulerTimer = setInterval(() => {
    runDueSchedules().catch(() => {});
  }, 60 * 1000).unref?.();
  runDueSchedules().catch(() => {});
}

async function recoverBackupArtifacts() {
  await ensureBackupRoot();
  const entries = await fs.readdir(getBackupRoot(), { withFileTypes: true });
  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = path.join(getBackupRoot(), entry.name);
    if (entry.name.endsWith(".tmp")) {
      await fs.rm(filePath, { force: true });
      removed.push({ file: entry.name, reason: "temporary-artifact" });
      continue;
    }
    if (entry.name.endsWith(BACKUP_EXTENSION)) {
      const backupId = entry.name.slice(0, -BACKUP_EXTENSION.length);
      if (!await fs.stat(metadataPath(backupId)).then((stats) => stats.isFile(), () => false)) {
        await fs.rm(filePath, { force: true });
        removed.push({ file: entry.name, reason: "archive-without-metadata" });
      }
    }
  }
  return { removed };
}

function stopBackupScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  schedulerStarted = false;
}

module.exports = {
  BACKUP_METADATA_SCHEMA_VERSION,
  BACKUP_SCHEDULE_SCHEMA_VERSION,
  _test: {
    createTarHeader,
    ensureDiskSpace,
    padTarData,
    parseTarEntries,
    pruneRetention,
    recoverBackupArtifacts,
    rollbackRestoreFromSafetySnapshot,
  },
  createBackup,
  deleteBackup,
  deleteSchedule,
  getBackupDownload,
  importBackup,
  listBackups,
  listSchedules,
  restoreBackup,
  recoverBackupArtifacts,
  saveSchedule,
  startBackupScheduler,
  stopBackupScheduler,
};
