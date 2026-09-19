const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { app, safeStorage } = require("electron");
const { Client } = require("ssh2");
const { decideMigrationRecovery, verifyRecoveryPoint } = require("../shared/migrationRecoveryPolicy");

const LOCAL_STORAGE_ID = "local";
const STORAGE_CONNECTIONS_SCHEMA_VERSION = 1;
const VALID_PROVIDER_TYPES = new Set(["local", "sftp"]);

class StorageConnectionError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "StorageConnectionError";
    this.code = details.code || null;
    this.status = details.status || null;
  }
}

function trimValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) {
    return process.env.ANXHUB_CONFIG_DIR;
  }
  try {
    return app ? path.join(app.getPath("userData"), "config") : path.join(process.cwd(), "config");
  } catch {
    return path.join(process.cwd(), "config");
  }
}

function getStorageConnectionsPath() {
  return path.join(getConfigDirectory(), "storage-connections.json");
}

function ensureConfigDirectory() {
  fs.mkdirSync(getConfigDirectory(), { recursive: true });
}

function slugify(value, fallback = "storage") {
  return (trimValue(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || fallback).slice(0, 64);
}

function normalizePort(value) {
  const port = Number.parseInt(value, 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 22;
}

function normalizeProviderType(value) {
  const provider = trimValue(value).toLowerCase();
  return VALID_PROVIDER_TYPES.has(provider) ? provider : "local";
}

function getFallbackKey() {
  return crypto.scryptSync(`${getStorageConnectionsPath()}:${process.env.USER || process.env.USERNAME || "local"}`, "anxos-storage", 32);
}

function encryptSecret(value) {
  const secret = String(value || "");
  if (!secret) {
    return null;
  }
  if (safeStorage?.isEncryptionAvailable?.()) {
    return {
      method: "safeStorage",
      data: safeStorage.encryptString(secret).toString("base64"),
    };
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getFallbackKey(), iv);
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return {
    method: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptSecret(record) {
  if (!record || typeof record !== "object") {
    return "";
  }
  if (record.method === "safeStorage" && safeStorage?.isEncryptionAvailable?.()) {
    return safeStorage.decryptString(Buffer.from(record.data || "", "base64"));
  }
  if (record.method === "aes-256-gcm") {
    const decipher = crypto.createDecipheriv("aes-256-gcm", getFallbackKey(), Buffer.from(record.iv || "", "base64"));
    decipher.setAuthTag(Buffer.from(record.tag || "", "base64"));
    return Buffer.concat([decipher.update(Buffer.from(record.data || "", "base64")), decipher.final()]).toString("utf8");
  }
  return "";
}

function createLocalConnection() {
  return {
    id: LOCAL_STORAGE_ID,
    provider: "local",
    type: "local",
    name: "Local Filesystem",
    displayName: "Local Filesystem",
    badge: "Local",
    rootDirectory: "",
    default: true,
    builtIn: true,
    connected: true,
  };
}

function readStore() {
  const filePath = getStorageConnectionsPath();
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: STORAGE_CONNECTIONS_SCHEMA_VERSION, defaultConnectionId: LOCAL_STORAGE_ID, connections: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Storage connection root must be an object.");
  } catch (error) {
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    throw new StorageConnectionError("Storage connection state is unreadable. The original file was preserved for recovery.", {
      code: "STORAGE_CONNECTION_STORE_CORRUPT",
      status: 500,
    });
  }
  const schemaVersion = Number.isInteger(parsed.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > STORAGE_CONNECTIONS_SCHEMA_VERSION) {
    throw new StorageConnectionError("Storage connection state was created by a newer application version.", {
      code: "STORAGE_CONNECTION_SCHEMA_UNSUPPORTED",
      status: 409,
    });
  }
  const normalized = {
    schemaVersion: STORAGE_CONNECTIONS_SCHEMA_VERSION,
    defaultConnectionId: trimValue(parsed.defaultConnectionId) || LOCAL_STORAGE_ID,
    connections: Array.isArray(parsed.connections) ? parsed.connections : [],
  };
  if (schemaVersion < STORAGE_CONNECTIONS_SCHEMA_VERSION) {
    const backupPath = `${filePath}.schema-v${schemaVersion}.backup`;
    const originalBytes = fs.readFileSync(filePath);
    const backupExisted = fs.existsSync(backupPath);
    if (!backupExisted) fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    // V2-J bullet 6: the rewrite below only runs behind a recovery point that
    // was read back and verified. An unverified copy is refused, not warned
    // past. Stored SFTP connection state cannot be rebuilt from anywhere else.
    let recoveryBytes = null;
    try {
      recoveryBytes = fs.readFileSync(backupPath);
    } catch {
      recoveryBytes = null;
    }
    const recoveryVerification = verifyRecoveryPoint({ mode: "bytes", original: originalBytes, copy: recoveryBytes });
    const recoveryTaken = fs.existsSync(backupPath);
    const recoveryVerdict = decideMigrationRecovery({
      storeId: "storage-connections",
      fromSchemaVersion: schemaVersion,
      toSchemaVersion: STORAGE_CONNECTIONS_SCHEMA_VERSION,
      recoveryPoint: { canTake: true, taken: recoveryTaken, verified: recoveryVerification.verified },
      reconstructible: { isReconstructible: false, source: null },
    });
    if (recoveryVerdict.verdict !== "proceed") {
      if (!backupExisted && recoveryTaken) {
        try { fs.rmSync(backupPath, { force: true }); } catch {}
      }
      throw new StorageConnectionError("Storage connection state could not be migrated safely because the pre-migration recovery point could not be verified.", {
        code: "STORAGE_CONNECTION_MIGRATION_RECOVERY_UNVERIFIED",
        status: 500,
        storeId: "storage-connections",
        reason: recoveryVerdict.reason,
        verification: recoveryVerification.reason,
      });
    }
    writeStore(normalized);
  }
  return normalized;
}

function writeStore(store) {
  ensureConfigDirectory();
  const filePath = getStorageConnectionsPath();
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify({ ...store, schemaVersion: STORAGE_CONNECTIONS_SCHEMA_VERSION }, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    throw error;
  }
}

function publicConnection(connection, defaultConnectionId = LOCAL_STORAGE_ID) {
  return {
    id: connection.id,
    provider: connection.provider || connection.type,
    type: connection.provider || connection.type,
    name: connection.name || connection.displayName,
    displayName: connection.name || connection.displayName,
    badge: connection.provider === "sftp" || connection.type === "sftp" ? "SFTP" : "Local",
    host: connection.host || "",
    port: connection.port || null,
    username: connection.username || "",
    authType: connection.authType || null,
    rootDirectory: connection.rootDirectory || "",
    default: connection.id === defaultConnectionId,
    builtIn: Boolean(connection.builtIn),
    hasPassword: Boolean(connection.credentials?.password),
    hasPrivateKey: Boolean(connection.credentials?.privateKey),
    hasPassphrase: Boolean(connection.credentials?.passphrase),
    createdAt: connection.createdAt || null,
    updatedAt: connection.updatedAt || null,
  };
}

function normalizeConnectionPayload(payload = {}, existing = null) {
  const provider = normalizeProviderType(payload.provider || payload.type);
  if (provider === "local") {
    return createLocalConnection();
  }
  const name = trimValue(payload.name || payload.displayName);
  const host = trimValue(payload.host);
  const username = trimValue(payload.username);
  const authType = trimValue(payload.authType) === "privateKey" ? "privateKey" : "password";
  if (!name || !host || !username) {
    throw new StorageConnectionError("Connection name, host, and username are required.", { code: "STORAGE_FIELDS_REQUIRED" });
  }
  const now = new Date().toISOString();
  const password = payload.password !== undefined ? String(payload.password || "") : null;
  const privateKey = payload.privateKey !== undefined ? String(payload.privateKey || "") : null;
  const passphrase = payload.passphrase !== undefined ? String(payload.passphrase || "") : null;
  return {
    id: trimValue(payload.id) || existing?.id || `sftp-${slugify(name)}-${crypto.randomBytes(3).toString("hex")}`,
    provider: "sftp",
    type: "sftp",
    name,
    host,
    port: normalizePort(payload.port),
    username,
    authType,
    rootDirectory: trimValue(payload.rootDirectory) || "/",
    credentials: {
      password: password !== null && password ? encryptSecret(password) : existing?.credentials?.password || null,
      privateKey: privateKey !== null && privateKey ? encryptSecret(privateKey) : existing?.credentials?.privateKey || null,
      passphrase: passphrase !== null && passphrase ? encryptSecret(passphrase) : existing?.credentials?.passphrase || null,
    },
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
}

function listConnections() {
  const store = readStore();
  return {
    defaultConnectionId: store.defaultConnectionId || LOCAL_STORAGE_ID,
    configPath: getStorageConnectionsPath(),
    connections: [
      publicConnection(createLocalConnection(), store.defaultConnectionId),
      ...store.connections.map((connection) => publicConnection(connection, store.defaultConnectionId)),
    ],
  };
}

function getConnection(connectionId = LOCAL_STORAGE_ID, options = {}) {
  const id = trimValue(connectionId) || LOCAL_STORAGE_ID;
  if (id === LOCAL_STORAGE_ID) {
    return createLocalConnection();
  }
  const store = readStore();
  const connection = store.connections.find((entry) => entry.id === id);
  if (!connection) {
    throw new StorageConnectionError("Storage connection not found.", { code: "STORAGE_CONNECTION_NOT_FOUND", status: 404 });
  }
  if (!options.includeSecrets) {
    return publicConnection(connection, store.defaultConnectionId);
  }
  return {
    ...connection,
    password: decryptSecret(connection.credentials?.password),
    privateKey: decryptSecret(connection.credentials?.privateKey),
    passphrase: decryptSecret(connection.credentials?.passphrase),
  };
}

function saveConnection(payload = {}) {
  const store = readStore();
  const existing = payload.id ? store.connections.find((entry) => entry.id === payload.id) : null;
  const connection = normalizeConnectionPayload(payload, existing);
  if (connection.id === LOCAL_STORAGE_ID) {
    return { connection: publicConnection(createLocalConnection(), store.defaultConnectionId), ...listConnections() };
  }
  const connections = store.connections.filter((entry) => entry.id !== connection.id);
  connections.push(connection);
  const nextStore = {
    ...store,
    defaultConnectionId: payload.default ? connection.id : store.defaultConnectionId || LOCAL_STORAGE_ID,
    connections,
  };
  writeStore(nextStore);
  return {
    connection: publicConnection(connection, nextStore.defaultConnectionId),
    ...listConnections(),
  };
}

function deleteConnection(connectionId) {
  const id = trimValue(connectionId);
  if (!id || id === LOCAL_STORAGE_ID) {
    throw new StorageConnectionError("The local storage connection cannot be deleted.", { code: "STORAGE_LOCAL_READ_ONLY", status: 400 });
  }
  const store = readStore();
  writeStore({
    ...store,
    defaultConnectionId: store.defaultConnectionId === id ? LOCAL_STORAGE_ID : store.defaultConnectionId,
    connections: store.connections.filter((entry) => entry.id !== id),
  });
  return { id, deleted: true, ...listConnections() };
}

function setDefaultConnection(connectionId) {
  const id = trimValue(connectionId) || LOCAL_STORAGE_ID;
  if (id !== LOCAL_STORAGE_ID) {
    getConnection(id);
  }
  const store = readStore();
  writeStore({ ...store, defaultConnectionId: id });
  return listConnections();
}

function mapSftpTestError(error) {
  const message = String(error?.message || "");
  if (/auth|authentication|password|key/i.test(message) || error?.level === "client-authentication") {
    return new StorageConnectionError("Authentication failed.", { code: "STORAGE_AUTH_FAILED" });
  }
  if (/timed out|timeout/i.test(message) || error?.code === "ETIMEDOUT") {
    return new StorageConnectionError("Connection timed out.", { code: "STORAGE_TIMEOUT" });
  }
  if (["ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "ECONNREFUSED"].includes(error?.code)) {
    return new StorageConnectionError("Host unreachable.", { code: "STORAGE_HOST_UNREACHABLE" });
  }
  if (/permission denied/i.test(message)) {
    return new StorageConnectionError("Permission denied.", { code: "STORAGE_PERMISSION_DENIED" });
  }
  if (/no such file|not found/i.test(message)) {
    return new StorageConnectionError("Invalid root directory.", { code: "STORAGE_INVALID_ROOT" });
  }
  return new StorageConnectionError("SFTP connection failed.", { code: "STORAGE_TEST_FAILED" });
}

function buildSftpConfig(connection) {
  const config = {
    host: connection.host,
    port: normalizePort(connection.port),
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

async function testConnection(payload = {}) {
  const connection = payload.id
    ? getConnection(payload.id, { includeSecrets: true })
    : normalizeConnectionPayload(payload);
  if (connection.provider === "local" || connection.type === "local") {
    return { connected: true, message: "This device is available.", connection: createLocalConnection() };
  }
  const hydrated = connection.password || connection.privateKey ? connection : {
    ...connection,
    password: decryptSecret(connection.credentials?.password),
    privateKey: decryptSecret(connection.credentials?.privateKey),
    passphrase: decryptSecret(connection.credentials?.passphrase),
  };
  const client = new Client();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      try {
        client.end();
        client.destroy();
      } catch {}
      callback(value);
    };
    client.on("ready", () => {
      client.sftp((error, sftp) => {
        if (error) {
          finish(reject, mapSftpTestError(error));
          return;
        }
        sftp.stat(hydrated.rootDirectory || "/", (statError, attrs) => {
          if (statError) {
            finish(reject, mapSftpTestError(statError));
            return;
          }
          if (typeof attrs?.isDirectory === "function" && !attrs.isDirectory()) {
            finish(reject, new StorageConnectionError("Invalid root directory.", { code: "STORAGE_INVALID_ROOT" }));
            return;
          }
          finish(resolve, {
            connected: true,
            message: "SFTP connection verified.",
            rootDirectory: hydrated.rootDirectory || "/",
          });
        });
      });
    });
    client.on("error", (error) => finish(reject, mapSftpTestError(error)));
    client.on("close", () => {
      if (!settled) finish(reject, new StorageConnectionError("Connection closed before verification completed.", { code: "STORAGE_CONNECTION_CLOSED" }));
    });
    try {
      client.connect(buildSftpConfig(hydrated));
    } catch (error) {
      finish(reject, mapSftpTestError(error));
    }
  });
}

module.exports = {
  LOCAL_STORAGE_ID,
  STORAGE_CONNECTIONS_SCHEMA_VERSION,
  StorageConnectionError,
  deleteConnection,
  getConnection,
  listConnections,
  saveConnection,
  setDefaultConnection,
  testConnection,
};
