// V2-F wave 5: backup destinations (local + remote/off-node SFTP) with
// protected credentials and encryption-at-rest for remote copies.
// (docs/MASTER_ROADMAP.md V2-F bullet 7: "Support chosen local and
// remote/off-node destinations, protected credentials and encryption/
// key-recovery procedures.")
//
// Scope of this slice (deliberately bounded and honest):
//   * ONE local destination (the existing AGENT_BACKUP_ROOT; always present,
//     built in, never deleted) plus ONE remote kind: SFTP.
//   * Remote copies are encrypted with AES-256-GCM before they leave the host.
//   * A failed push NEVER fails the local backup: the local artifact stays
//     authoritative and the failure is recorded additively in the backup
//     metadata as pushState and reported to the caller.
//   * Restore from a remote destination downloads + decrypts + verifies the
//     sha256 digest and then hands the archive to the existing restore path.
//     Integrity failure refuses BEFORE any mutation.
//
// Credential decision (survey fact reuse, not a new vault):
//   storageConnectionService.js (src/services) already stores SFTP credentials
//   encrypted at rest and feeds the file browser. This module does NOT create a
//   second credential vault. An SFTP destination records only a
//   `connectionId`; the credentials are resolved at push/download time through
//   a `resolveSftpCredentials` seam whose production default is that same
//   storageConnectionService.getConnection(id, { includeSecrets: true }). The
//   destination store therefore never contains a secret. A deployment where the
//   Agent process cannot read that store (separate host/config dir) or where the
//   connection is missing fails the push with
//   BACKUP_DESTINATION_CREDENTIALS_UNAVAILABLE instead of inventing credentials.
//
// Encryption key handling / recovery statement:
//   The AES-256-GCM key comes from the Agent environment/secret
//   AGENT_BACKUP_ENCRYPTION_KEY (64 hex chars, a 32-byte base64 value, or a
//   passphrase hashed with sha256). The key is NEVER persisted, logged, or
//   returned: metadata records only a non-reversible fingerprint
//   (`keyId = sha256(key).slice(0, 16)`) plus the reference `keyRef`
//   ("env:AGENT_BACKUP_ENCRYPTION_KEY"). There is no key escrow and no
//   recovery path: if the operator loses the key, every remote archive
//   encrypted with it is unrecoverable. Rotating the key does NOT re-encrypt
//   existing remote archives — each manifest names the keyId that produced it,
//   so recovery requires the matching key.

const crypto = require("crypto");
const fs = require("fs/promises");
const fsSync = require("fs");
const path = require("path");

const backupService = require("./backupService");

const DESTINATION_SCHEMA_VERSION = 1;
const DESTINATIONS_FILENAME = "destinations.json";
const LOCAL_DESTINATION_ID = "local";
const DESTINATION_KINDS = new Set(["local", "sftp"]);

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const ENCRYPTION_KEY_ENV = "AGENT_BACKUP_ENCRYPTION_KEY";
const ENCRYPTION_MAGIC = Buffer.from("ANXBK1", "ascii");
const ENCRYPTION_IV_BYTES = 12;
const ENCRYPTION_TAG_BYTES = 16;
// Remote artifact names are derived from the validated backup id only, so a
// crafted id can never escape the configured remote directory.
const REMOTE_ARCHIVE_EXTENSION = ".tar.gz.enc";
const REMOTE_MANIFEST_EXTENSION = ".manifest.json";

const PUSH_STATES = new Set(["pending", "pushed", "failed"]);

function createBackupDestinationError(code, statusCode = 400, details = {}) {
  return Object.assign(new Error(code), { code, statusCode, details });
}

function nowIso() {
  return new Date().toISOString();
}

function sha256Hex(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Test seams. The hermetic smoke injects a pinned root, a fake SFTP transport,
// a fake credential resolver, and a fixed crypto key so no network, no real
// credential store, and no machine root is touched.
// ---------------------------------------------------------------------------
const seams = {
  root: null,
  now: null,
  encryptionKey: null,
  resolveSftpCredentials: null,
  sftpTransport: null,
};

function defaultResolveSftpCredentials(connectionId) {
  // Lazy so a plain require of this module never pulls the Electron-facing
  // storage connection module (and its ssh2/safeStorage dependencies) unless a
  // remote transfer actually needs it.
  const storageConnectionService = require("../../../src/services/storageConnectionService");
  const connection = storageConnectionService.getConnection(connectionId, { includeSecrets: true });
  return {
    host: connection.host,
    port: connection.port || 22,
    username: connection.username,
    authType: connection.authType,
    password: connection.password,
    privateKey: connection.privateKey,
    passphrase: connection.passphrase,
    rootDirectory: connection.rootDirectory,
  };
}

function configureBackupDestinationService(overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, "root")) {
    seams.root = overrides.root ? path.resolve(overrides.root) : null;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, "now")) {
    seams.now = overrides.now || null;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, "encryptionKey")) {
    seams.encryptionKey = overrides.encryptionKey ?? null;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, "resolveSftpCredentials")) {
    seams.resolveSftpCredentials = overrides.resolveSftpCredentials || null;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, "sftpTransport")) {
    seams.sftpTransport = overrides.sftpTransport || null;
  }
}

function currentTimeIso() {
  return new Date(seams.now ? seams.now() : Date.now()).toISOString();
}

function getDestinationRoot() {
  return seams.root || backupService.getBackupRoot();
}

function destinationsPath() {
  return path.join(getDestinationRoot(), DESTINATIONS_FILENAME);
}

function backupMetadataPath(backupId) {
  return path.join(getDestinationRoot(), `${backupId}.json`);
}

function archivePath(backupId) {
  return path.join(getDestinationRoot(), `${backupId}.tar.gz`);
}

async function ensureDestinationRoot() {
  await fs.mkdir(getDestinationRoot(), { recursive: true, mode: 0o700 });
}

// Per-writer temp name (review P2): a Date.now() suffix in an async writer is
// not unique — two concurrent pushes can land on the same temp path and the
// losing rename throws. A monotonic counter guarantees uniqueness within the
// process; the pid disambiguates across processes.
let destinationWriteCounter = 0;

async function writeJsonAtomic(filePath, value) {
  destinationWriteCounter = (destinationWriteCounter + 1) % Number.MAX_SAFE_INTEGER;
  const tempPath = `${filePath}.${process.pid}.${destinationWriteCounter}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function createLocalDestination() {
  return Object.freeze({
    id: LOCAL_DESTINATION_ID,
    kind: "local",
    label: "Local backup root",
    root: getDestinationRoot(),
    enabled: true,
    builtIn: true,
    createdAt: null,
    updatedAt: null,
  });
}

// Mirrors backupService.validateBackupId (not exported there): a backup id is
// interpolated into remote file names and local paths, so it must never carry
// separators or traversal segments.
function validateBackupId(value) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,80}$/.test(id)) {
    throw createBackupDestinationError("INVALID_BACKUP_ID");
  }
  return id;
}

function validateDestinationId(value) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(id)) {
    throw createBackupDestinationError("INVALID_BACKUP_DESTINATION_ID");
  }
  return id;
}

function validateRemotePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "/";
  if (raw.includes("\0") || /[\r\n]/.test(raw)) {
    throw createBackupDestinationError("INVALID_BACKUP_DESTINATION_PATH");
  }
  // Separators are normalized BEFORE the traversal check: posixJoin converts
  // `\` to `/` afterwards, so validating the raw string let a Windows-style
  // `..\..\etc` through and it became `/../../etc` on the remote side
  // (review P1, reproduced). Check the normalized form, and also reject any
  // backslash-separated `..` segment directly.
  const normalized = raw.replace(/\\/g, "/");
  if (normalized.split("/").some((segment) => segment === "..")) {
    throw createBackupDestinationError("INVALID_BACKUP_DESTINATION_PATH");
  }
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith("//")) {
    // Drive-letter or UNC-style prefixes are meaningless on the remote and
    // can only be an attempt to confuse path resolution.
    throw createBackupDestinationError("INVALID_BACKUP_DESTINATION_PATH");
  }
  return normalized;
}

function sanitizeLabel(value, fallback) {
  return String(value || fallback || "Backup destination")
    .trim()
    .replace(/[^\w .-]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120) || "Backup destination";
}

async function readDestinations() {
  await ensureDestinationRoot();
  const filePath = destinationsPath();
  if (!await fs.stat(filePath).then((stats) => stats.isFile(), () => false)) return [];
  let parsed;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Destination store root must be an object.");
  } catch (error) {
    // Same recovery convention as the backup/schedule stores: quarantine the
    // unreadable file with COPYFILE_EXCL so the original bytes survive.
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    await fs.copyFile(filePath, backupPath, fsSync.constants.COPYFILE_EXCL).catch(() => {});
    throw createBackupDestinationError("BACKUP_DESTINATION_STORE_CORRUPT", 500, { causeCode: error?.code || "INVALID_JSON" });
  }
  const schemaVersion = Number.isInteger(parsed?.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > DESTINATION_SCHEMA_VERSION) {
    throw createBackupDestinationError("BACKUP_DESTINATION_SCHEMA_UNSUPPORTED", 409, {
      schemaVersion,
      supportedSchemaVersion: DESTINATION_SCHEMA_VERSION,
    });
  }
  const destinations = Array.isArray(parsed?.destinations)
    ? parsed.destinations.filter((entry) => entry && entry.id !== LOCAL_DESTINATION_ID)
    : [];
  if (schemaVersion < DESTINATION_SCHEMA_VERSION) {
    const backupPath = `${filePath}.schema-v${schemaVersion}.backup`;
    if (!await fs.stat(backupPath).then(() => true, () => false)) {
      await fs.copyFile(filePath, backupPath, fsSync.constants.COPYFILE_EXCL).catch(() => {});
    }
    await writeDestinations(destinations);
  }
  return destinations;
}

async function writeDestinations(destinations) {
  await ensureDestinationRoot();
  await writeJsonAtomic(destinationsPath(), {
    schemaVersion: DESTINATION_SCHEMA_VERSION,
    destinations: destinations.filter((entry) => entry && entry.id !== LOCAL_DESTINATION_ID),
  });
}

// Public projection: a destination never exposes credentials (there are none in
// the store) and reports only booleans mirroring publicConnection().
function publicDestination(destination) {
  return {
    id: destination.id,
    kind: destination.kind,
    label: destination.label,
    root: destination.kind === "local" ? destination.root : null,
    connectionId: destination.kind === "sftp" ? destination.connectionId : null,
    path: destination.kind === "sftp" ? destination.path : null,
    enabled: destination.enabled !== false,
    builtIn: Boolean(destination.builtIn),
    createdAt: destination.createdAt || null,
    updatedAt: destination.updatedAt || null,
  };
}

async function getDestination(destinationId) {
  const rawId = String(destinationId || LOCAL_DESTINATION_ID).trim() || LOCAL_DESTINATION_ID;
  if (rawId === LOCAL_DESTINATION_ID) return createLocalDestination();
  const id = validateDestinationId(rawId);
  const destinations = await readDestinations();
  const destination = destinations.find((entry) => entry.id === id);
  if (!destination) {
    throw createBackupDestinationError("BACKUP_DESTINATION_NOT_FOUND", 404, { destinationId: id });
  }
  return destination;
}

async function listDestinations() {
  const destinations = await readDestinations();
  return {
    root: getDestinationRoot(),
    destinations: [publicDestination(createLocalDestination()), ...destinations.map(publicDestination)],
  };
}

async function saveDestination(payload = {}) {
  const kind = String(payload.kind || payload.type || "sftp").trim().toLowerCase();
  if (!DESTINATION_KINDS.has(kind)) {
    throw createBackupDestinationError("INVALID_BACKUP_DESTINATION_KIND", 400, { kind });
  }
  if (kind === "local") {
    // The local destination is the backup root itself and is always present;
    // it is not user-editable, so a save is a no-op that returns it.
    return { destination: publicDestination(createLocalDestination()), ...await listDestinations() };
  }

  const existing = payload.id
    ? (await readDestinations()).find((entry) => entry.id === payload.id) || null
    : null;
  if (payload.id && !existing) {
    throw createBackupDestinationError("BACKUP_DESTINATION_NOT_FOUND", 404, { destinationId: payload.id });
  }

  const connectionId = String(payload.connectionId || existing?.connectionId || "").trim();
  if (!connectionId) {
    throw createBackupDestinationError("BACKUP_DESTINATION_CONNECTION_REQUIRED", 400);
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(connectionId)) {
    throw createBackupDestinationError("INVALID_BACKUP_DESTINATION_CONNECTION_ID");
  }

  const timestamp = currentTimeIso();
  const destination = {
    id: existing?.id || `dest-sftp-${crypto.randomBytes(3).toString("hex")}`,
    kind: "sftp",
    label: sanitizeLabel(payload.label, `SFTP ${connectionId}`),
    connectionId,
    path: validateRemotePath(payload.path ?? existing?.path),
    enabled: payload.enabled !== undefined ? payload.enabled !== false : existing?.enabled !== false,
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };

  const destinations = (await readDestinations()).filter((entry) => entry.id !== destination.id);
  destinations.push(destination);
  await writeDestinations(destinations);
  return { destination: publicDestination(destination), ...await listDestinations() };
}

async function deleteDestination(destinationId) {
  const requested = String(destinationId || "").trim();
  if (!requested || requested === LOCAL_DESTINATION_ID) {
    // The local destination is the backup root: deleting it would mean
    // deleting the backups, which is never what "remove a destination" means.
    throw createBackupDestinationError("BACKUP_LOCAL_DESTINATION_READ_ONLY", 400);
  }
  const id = validateDestinationId(requested);
  const destinations = await readDestinations();
  if (!destinations.some((entry) => entry.id === id)) {
    throw createBackupDestinationError("BACKUP_DESTINATION_NOT_FOUND", 404, { destinationId: id });
  }
  await writeDestinations(destinations.filter((entry) => entry.id !== id));
  return { id, deleted: true, ...await listDestinations() };
}

// ---------------------------------------------------------------------------
// Encryption at rest (AES-256-GCM)
// ---------------------------------------------------------------------------

function parseEncryptionKey(rawValue) {
  if (Buffer.isBuffer(rawValue)) return rawValue.length === 32 ? rawValue : null;
  const value = String(rawValue || "").trim();
  if (!value) return null;
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    const decoded = Buffer.from(value, "base64");
    if (decoded.length === 32) return decoded;
  }
  // Passphrase fallback: a deterministic 32-byte key. Documented so operators
  // know the exact derivation is part of the recovery contract.
  return crypto.createHash("sha256").update(value, "utf8").digest();
}

function resolveEncryptionKey() {
  const raw = seams.encryptionKey !== null && seams.encryptionKey !== undefined
    ? seams.encryptionKey
    : process.env[ENCRYPTION_KEY_ENV];
  const key = parseEncryptionKey(raw);
  if (!key) {
    throw createBackupDestinationError("BACKUP_ENCRYPTION_KEY_MISSING", 400, { envVar: ENCRYPTION_KEY_ENV });
  }
  return key;
}

// Non-reversible fingerprint used to name the key that produced an archive in
// metadata. It is NOT the key and cannot be used to decrypt.
function keyFingerprint(key) {
  return sha256Hex(key).slice(0, 16);
}

function encryptionDescriptor(key) {
  return {
    algorithm: ENCRYPTION_ALGORITHM,
    keyRef: `env:${ENCRYPTION_KEY_ENV}`,
    keyId: keyFingerprint(key),
  };
}

// Envelope layout: magic(6) | iv(12) | tag(16) | ciphertext.
function encryptBufferWithKey(buffer, key) {
  const iv = crypto.randomBytes(ENCRYPTION_IV_BYTES);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([ENCRYPTION_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

function decryptBufferWithKey(envelope, key) {
  if (!Buffer.isBuffer(envelope) || envelope.length < ENCRYPTION_MAGIC.length + ENCRYPTION_IV_BYTES + ENCRYPTION_TAG_BYTES) {
    throw createBackupDestinationError("BACKUP_DESTINATION_ARCHIVE_INVALID", 400);
  }
  if (!envelope.subarray(0, ENCRYPTION_MAGIC.length).equals(ENCRYPTION_MAGIC)) {
    throw createBackupDestinationError("BACKUP_DESTINATION_ARCHIVE_INVALID", 400);
  }
  let offset = ENCRYPTION_MAGIC.length;
  const iv = envelope.subarray(offset, offset + ENCRYPTION_IV_BYTES);
  offset += ENCRYPTION_IV_BYTES;
  const tag = envelope.subarray(offset, offset + ENCRYPTION_TAG_BYTES);
  offset += ENCRYPTION_TAG_BYTES;
  const ciphertext = envelope.subarray(offset);
  const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    // Auth-tag failure means the wrong key or a tampered archive; never echo
    // the bytes or the key.
    throw createBackupDestinationError("BACKUP_DESTINATION_DECRYPT_FAILED", 400, { causeCode: error?.code || "AUTH_TAG_MISMATCH" });
  }
}

async function encryptArchiveFile(localArchivePath, key) {
  const buffer = await fs.readFile(localArchivePath);
  const encrypted = encryptBufferWithKey(buffer, key);
  const encryptedPath = `${localArchivePath}${REMOTE_ARCHIVE_EXTENSION}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(encryptedPath, encrypted, { mode: 0o600 });
  return { encryptedPath, encryptedBytes: encrypted.length, plainBytes: buffer.length };
}

// ---------------------------------------------------------------------------
// SFTP transport (default) — the agent-side analogue of the ssh2 handling the
// file service uses. Kept behind a seam so the smoke never touches a network.
// ---------------------------------------------------------------------------

function posixJoin(...segments) {
  const joined = segments
    .map((segment) => String(segment || "").replace(/\\/g, "/"))
    .filter((segment) => segment.length > 0)
    .join("/")
    .replace(/\/+/g, "/");
  return joined.startsWith("/") ? joined : `/${joined}`;
}

function remoteArchivePath(destination, backupId) {
  return posixJoin(destination.path || "/", `${validateBackupId(backupId)}${REMOTE_ARCHIVE_EXTENSION}`);
}

function remoteManifestPath(destination, backupId) {
  return posixJoin(destination.path || "/", `${validateBackupId(backupId)}${REMOTE_MANIFEST_EXTENSION}`);
}

function posixDirname(value) {
  const normalized = posixJoin(value);
  const trimmed = normalized.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return "/";
  return trimmed.slice(0, index);
}

function buildSftpConnectConfig(connection) {
  const config = {
    host: connection.host,
    port: Number.parseInt(connection.port, 10) || 22,
    username: connection.username,
    readyTimeout: 12000,
    keepaliveInterval: 15000,
    keepaliveCountMax: 2,
  };
  if (connection.authType === "privateKey") {
    config.privateKey = connection.privateKey;
    if (connection.passphrase) config.passphrase = connection.passphrase;
  } else {
    config.password = connection.password;
  }
  return config;
}

function openSftpSession(connection) {
  const { Client } = require("ssh2");
  const client = new Client();
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { client.end(); client.destroy(); } catch {}
      reject(error);
    };
    client.on("ready", () => {
      client.sftp((error, sftp) => {
        if (error) {
          fail(error);
          return;
        }
        if (settled) return;
        settled = true;
        resolve({ client, sftp });
      });
    });
    client.on("error", fail);
    client.on("close", () => fail(new Error("SFTP connection closed before the transfer completed.")));
    try {
      client.connect(buildSftpConnectConfig(connection));
    } catch (error) {
      fail(error);
    }
  });
}

async function ensureRemoteDirectory(sftp, remotePath) {
  const segments = posixJoin(remotePath).split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = `${current}/${segment}`;
    await new Promise((resolve) => sftp.mkdir(current, () => resolve()));
  }
}

function defaultSftpTransport() {
  return {
    async uploadFile({ connection, localPath, remotePath: targetPath }) {
      const { client, sftp } = await openSftpSession(connection);
      try {
        await ensureRemoteDirectory(sftp, posixDirname(targetPath));
        await new Promise((resolve, reject) => {
          sftp.fastPut(localPath, targetPath, (error) => (error ? reject(error) : resolve()));
        });
      } finally {
        try { client.end(); } catch {}
      }
    },
    async downloadFile({ connection, remotePath: sourcePath, localPath }) {
      const { client, sftp } = await openSftpSession(connection);
      try {
        await new Promise((resolve, reject) => {
          sftp.fastGet(sourcePath, localPath, (error) => (error ? reject(error) : resolve()));
        });
      } finally {
        try { client.end(); } catch {}
      }
    },
  };
}

function getTransport() {
  return seams.sftpTransport || defaultSftpTransport();
}

function mapTransferError(error, code) {
  const causeCode = String(error?.code || "").trim() || "SFTP_TRANSFER_FAILED";
  // Only the mapped code travels: SFTP errors can embed a host/user and must
  // not leak credentials or connection strings into metadata.
  return createBackupDestinationError(code, 400, { causeCode });
}

async function resolveSftpConnection(destination) {
  const resolver = seams.resolveSftpCredentials || defaultResolveSftpCredentials;
  try {
    const connection = await resolver(destination.connectionId);
    if (!connection || !connection.host || !connection.username) {
      throw new Error("incomplete connection");
    }
    return connection;
  } catch (error) {
    if (error?.code && String(error.code).startsWith("BACKUP_")) throw error;
    throw createBackupDestinationError("BACKUP_DESTINATION_CREDENTIALS_UNAVAILABLE", 400, {
      connectionId: destination.connectionId,
      causeCode: error?.code || "CREDENTIAL_RESOLUTION_FAILED",
    });
  }
}

// ---------------------------------------------------------------------------
// Push
// ---------------------------------------------------------------------------

async function writeBackupPushState(backupId, pushState) {
  const filePath = backupMetadataPath(backupId);
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw createBackupDestinationError("BACKUP_NOT_FOUND", 404, { backupId });
    }
    throw error;
  }
  // Additive: only pushState is touched, every existing field is preserved
  // byte-for-byte so the backup metadata schema stays at 1.
  const next = { ...raw, pushState };
  await writeJsonAtomic(filePath, next);
  return next;
}

function buildManifest(metadata, descriptor) {
  return {
    schemaVersion: 1,
    backupId: metadata.id,
    instanceId: metadata.instanceId,
    name: metadata.name,
    createdAt: metadata.createdAt,
    createdBy: metadata.createdBy,
    type: metadata.type,
    status: metadata.status,
    consistency: metadata.consistency ?? null,
    sourcePaths: Array.isArray(metadata.sourcePaths) ? metadata.sourcePaths : [],
    archiveName: metadata.archiveName || `${metadata.id}.tar.gz`,
    archiveSha256: metadata.archiveSha256,
    size: metadata.size,
    uncompressedSize: metadata.uncompressedSize,
    entryCount: metadata.entryCount,
    // Non-secret encryption descriptor only. The key itself is never written.
    encryption: descriptor,
  };
}

async function pushToLocalDestination(metadata, destination) {
  const localArchive = archivePath(metadata.id);
  if (!await fs.stat(localArchive).then((stats) => stats.isFile(), () => false)) {
    throw createBackupDestinationError("BACKUP_DESTINATION_ARCHIVE_MISSING", 404, { backupId: metadata.id });
  }
  return {
    state: "pushed",
    destinationId: destination.id,
    destinationKind: "local",
    pushedAt: currentTimeIso(),
    errorCode: null,
    remotePath: localArchive,
    encrypted: false,
    keyId: null,
    keyRef: null,
    algorithm: null,
  };
}

async function performPush(metadata, destination) {
  if (destination.kind === "local") {
    return pushToLocalDestination(metadata, destination);
  }

  // Encryption key first: fail before dialing anything so a misconfigured key
  // is reported as the real cause rather than a transfer error.
  const key = resolveEncryptionKey();
  const descriptor = encryptionDescriptor(key);
  const localArchive = metadata.path || archivePath(metadata.id);
  if (!await fs.stat(localArchive).then((stats) => stats.isFile(), () => false)) {
    throw createBackupDestinationError("BACKUP_DESTINATION_ARCHIVE_MISSING", 404, { backupId: metadata.id });
  }

  const connection = await resolveSftpConnection(destination);
  const transport = getTransport();
  const targetArchive = remoteArchivePath(destination, metadata.id);
  const targetManifest = remoteManifestPath(destination, metadata.id);

  const encrypted = await encryptArchiveFile(localArchive, key);
  const manifestTemp = path.join(getDestinationRoot(), `.${metadata.id}.${process.pid}.${Date.now()}.manifest.tmp`);
  try {
    await transport.uploadFile({ connection, localPath: encrypted.encryptedPath, remotePath: targetArchive, destination });
    const manifestJson = `${JSON.stringify(buildManifest(metadata, descriptor), null, 2)}\n`;
    await fs.writeFile(manifestTemp, manifestJson, { mode: 0o600 });
    await transport.uploadFile({ connection, localPath: manifestTemp, remotePath: targetManifest, destination });
  } catch (error) {
    throw mapTransferError(error, "BACKUP_DESTINATION_PUSH_FAILED");
  } finally {
    await fs.rm(encrypted.encryptedPath, { force: true }).catch(() => {});
    await fs.rm(manifestTemp, { force: true }).catch(() => {});
  }

  return {
    state: "pushed",
    destinationId: destination.id,
    destinationKind: "sftp",
    pushedAt: currentTimeIso(),
    errorCode: null,
    remotePath: targetArchive,
    remoteManifestPath: targetManifest,
    encrypted: true,
    algorithm: descriptor.algorithm,
    keyId: descriptor.keyId,
    keyRef: descriptor.keyRef,
    archiveSha256: metadata.archiveSha256,
  };
}

// Push a completed backup archive to a destination. A push failure never fails
// the local backup: the local artifact stays authoritative and the failure is
// recorded as pushState "failed" and returned to the caller.
async function pushBackupToDestination(backupId, payload = {}) {
  const metadata = await backupService.readBackupMetadata(backupId);
  const destination = await getDestination(payload.destinationId);
  const pendingState = {
    state: "pending",
    destinationId: destination.id,
    destinationKind: destination.kind,
    attemptedAt: currentTimeIso(),
    pushedAt: null,
    errorCode: null,
  };
  await writeBackupPushState(metadata.id, pendingState);

  let pushState;
  try {
    pushState = await performPush(metadata, destination);
  } catch (error) {
    pushState = {
      state: "failed",
      destinationId: destination.id,
      destinationKind: destination.kind,
      attemptedAt: pendingState.attemptedAt,
      pushedAt: null,
      errorCode: error?.code || "BACKUP_DESTINATION_PUSH_FAILED",
      causeCode: error?.details?.causeCode || null,
      remotePath: null,
      encrypted: destination.kind === "sftp",
    };
    await writeBackupPushState(metadata.id, pushState);
    // Reported, not thrown: the local backup remains intact and authoritative.
    return { backup: { ...metadata, pushState }, destination: publicDestination(destination), pushState };
  }

  await writeBackupPushState(metadata.id, pushState);
  return { backup: { ...metadata, pushState }, destination: publicDestination(destination), pushState };
}

// ---------------------------------------------------------------------------
// Restore from a remote destination
// ---------------------------------------------------------------------------

async function readLocalMetadata(backupId) {
  try {
    return await backupService.readBackupMetadata(backupId);
  } catch (error) {
    if (error?.code === "BACKUP_NOT_FOUND") return null;
    throw error;
  }
}

async function fetchRemoteManifest(destination, backupId) {
  const connection = await resolveSftpConnection(destination);
  const transport = getTransport();
  const tempPath = path.join(getDestinationRoot(), `.${backupId}.${process.pid}.${Date.now()}.manifest.tmp`);
  try {
    await transport.downloadFile({
      connection,
      remotePath: remoteManifestPath(destination, backupId),
      localPath: tempPath,
      destination,
    });
    return JSON.parse(await fs.readFile(tempPath, "utf8"));
  } catch (error) {
    if (error?.code && String(error.code).startsWith("BACKUP_")) throw error;
    throw mapTransferError(error, "BACKUP_DESTINATION_MANIFEST_UNAVAILABLE");
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
}

function metadataFromManifest(manifest, backupId) {
  const schemaVersion = Number.isInteger(manifest?.schemaVersion) ? manifest.schemaVersion : 0;
  if (schemaVersion > backupService.BACKUP_METADATA_SCHEMA_VERSION) {
    throw createBackupDestinationError("BACKUP_METADATA_SCHEMA_UNSUPPORTED", 409, {
      schemaVersion,
      supportedSchemaVersion: backupService.BACKUP_METADATA_SCHEMA_VERSION,
    });
  }
  return {
    schemaVersion: backupService.BACKUP_METADATA_SCHEMA_VERSION,
    id: backupId,
    instanceId: manifest.instanceId,
    name: manifest.name || `${backupId} restored from remote`,
    createdAt: manifest.createdAt,
    createdBy: manifest.createdBy || "remote-destination",
    type: manifest.type === "world" ? "world" : "full",
    size: manifest.size || 0,
    uncompressedSize: manifest.uncompressedSize || 0,
    requiredDiskSpace: manifest.uncompressedSize || 0,
    entryCount: manifest.entryCount || 0,
    compression: "tar.gz",
    archiveSha256: manifest.archiveSha256,
    sourcePaths: Array.isArray(manifest.sourcePaths) ? manifest.sourcePaths : ["."],
    archiveName: manifest.archiveName || `${backupId}.tar.gz`,
    status: manifest.status || "complete",
    consistency: manifest.consistency ?? null,
    // Provenance for the recreated local artifact (additive field).
    restoredFromDestination: {
      algorithm: manifest.encryption?.algorithm || null,
      keyId: manifest.encryption?.keyId || null,
      keyRef: manifest.encryption?.keyRef || null,
    },
  };
}

// Download + decrypt + verify the archive from a remote destination, then hand
// it to the existing restore path. Nothing is mutated until the sha256 has been
// verified against the recorded digest.
async function materializeRemoteArchive(destination, backupId, expectedSha256) {
  const key = resolveEncryptionKey();
  const connection = await resolveSftpConnection(destination);
  const transport = getTransport();
  await ensureDestinationRoot();
  const stamp = `${process.pid}.${Date.now()}`;
  const encryptedTemp = path.join(getDestinationRoot(), `.${backupId}.${stamp}.enc.tmp`);
  const plainTemp = path.join(getDestinationRoot(), `.${backupId}.${stamp}.tar.gz.tmp`);

  try {
    await transport.downloadFile({
      connection,
      remotePath: remoteArchivePath(destination, backupId),
      localPath: encryptedTemp,
      destination,
    });
    const envelope = await fs.readFile(encryptedTemp);
    const plain = decryptBufferWithKey(envelope, key);
    const actualSha256 = sha256Hex(plain);
    if (expectedSha256 && actualSha256 !== expectedSha256) {
      // Integrity refuses BEFORE any mutation: the local artifact and the
      // instance are both untouched.
      throw createBackupDestinationError("BACKUP_ARCHIVE_HASH_MISMATCH", 400, {
        expectedSha256,
        actualSha256,
      });
    }
    await fs.writeFile(plainTemp, plain, { mode: 0o600 });
    await fs.rename(plainTemp, archivePath(backupId));
    return { sha256: actualSha256, bytes: plain.length };
  } catch (error) {
    if (error?.code && String(error.code).startsWith("BACKUP_")) throw error;
    throw mapTransferError(error, "BACKUP_DESTINATION_DOWNLOAD_FAILED");
  } finally {
    await fs.rm(encryptedTemp, { force: true }).catch(() => {});
    await fs.rm(plainTemp, { force: true }).catch(() => {});
  }
}

async function restoreBackupFromDestination(payload = {}) {
  const backupId = validateBackupId(payload.backupId);
  const destination = await getDestination(payload.destinationId);
  if (destination.kind === "local") {
    // The local destination IS the backup root, so the archive is (or should
    // be) already in place; there is no independent remote copy to fetch.
    const localArchive = archivePath(backupId);
    if (!await fs.stat(localArchive).then((stats) => stats.isFile(), () => false)) {
      throw createBackupDestinationError("BACKUP_DESTINATION_ARCHIVE_MISSING", 404, { backupId });
    }
    return backupService.restoreBackup({ ...payload, backupId });
  }

  let metadata = await readLocalMetadata(backupId);
  let manifest = null;
  if (!metadata) {
    manifest = await fetchRemoteManifest(destination, backupId);
  }
  const expectedSha256 = metadata?.archiveSha256 || manifest?.archiveSha256 || null;
  const localArchive = archivePath(backupId);
  const localArchiveExists = await fs.stat(localArchive).then((stats) => stats.isFile(), () => false);
  if (!localArchiveExists) {
    await materializeRemoteArchive(destination, backupId, expectedSha256);
    if (!metadata && manifest) {
      // Recreate the local metadata record from the remote manifest so the
      // existing restore path (which reads metadata) can run unchanged. The
      // digest was just verified against the bytes now on disk.
      metadata = metadataFromManifest(manifest, backupId);
      await writeJsonAtomic(backupMetadataPath(backupId), metadata);
    }
  } else if (expectedSha256) {
    // A stale/corrupt local copy must not be silently restored; the existing
    // restore path re-verifies, but refusing here keeps the failure explicit.
    const actualSha256 = sha256Hex(await fs.readFile(localArchive));
    if (actualSha256 !== expectedSha256) {
      await materializeRemoteArchive(destination, backupId, expectedSha256);
    }
  }

  return backupService.restoreBackup({ ...payload, backupId });
}

module.exports = {
  DESTINATION_SCHEMA_VERSION,
  DESTINATIONS_FILENAME,
  LOCAL_DESTINATION_ID,
  ENCRYPTION_ALGORITHM,
  ENCRYPTION_KEY_ENV,
  REMOTE_ARCHIVE_EXTENSION,
  REMOTE_MANIFEST_EXTENSION,
  PUSH_STATES,
  _test: {
    decryptBufferWithKey,
    encryptBufferWithKey,
    encryptionDescriptor,
    keyFingerprint,
    parseEncryptionKey,
    remoteArchivePath,
    remoteManifestPath,
  },
  configureBackupDestinationService,
  deleteDestination,
  getDestination,
  getDestinationRoot,
  listDestinations,
  pushBackupToDestination,
  restoreBackupFromDestination,
  saveDestination,
};
