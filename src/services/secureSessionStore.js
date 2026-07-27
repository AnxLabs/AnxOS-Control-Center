const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
let app = null;
let safeStorage = null;
const SECURE_SESSION_SCHEMA_VERSION = 1;
try {
  ({ app, safeStorage } = require("electron"));
} catch {
  // Shared services can use the machine-bound fallback outside Electron.
}

function getDefaultConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) {
    return process.env.ANXHUB_CONFIG_DIR;
  }
  try {
    return app ? path.join(app.getPath("userData"), "config") : path.join(process.cwd(), "config");
  } catch {
    return path.join(process.cwd(), "config");
  }
}

function getFallbackEncryptionKey(filePath, purpose = "anxos-secure-session") {
  let username = "local-user";
  try {
    username = os.userInfo().username || username;
  } catch {}
  return crypto.scryptSync(`${username}:${os.hostname()}:${filePath}`, purpose, 32);
}

function encryptPayload(value, filePath) {
  const payload = JSON.stringify(value);
  if (safeStorage?.isEncryptionAvailable?.()) {
    return {
      method: "safeStorage",
      data: safeStorage.encryptString(payload).toString("base64"),
    };
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getFallbackEncryptionKey(filePath), iv);
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  return {
    method: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptPayload(record, filePath) {
  if (!record || typeof record !== "object") {
    return null;
  }
  if (record.method === "safeStorage" && safeStorage?.isEncryptionAvailable?.()) {
    return JSON.parse(safeStorage.decryptString(Buffer.from(record.data || "", "base64")));
  }
  if (record.method === "aes-256-gcm") {
    const decipher = crypto.createDecipheriv("aes-256-gcm", getFallbackEncryptionKey(filePath), Buffer.from(record.iv || "", "base64"));
    decipher.setAuthTag(Buffer.from(record.tag || "", "base64"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(record.data || "", "base64")), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  }
  return null;
}

function secureSessionError(code, message, filePath, cause = null, details = {}) {
  const error = Object.assign(new Error(message), { code, filePath, details });
  if (cause) Object.defineProperty(error, "cause", { value: cause, enumerable: false });
  return error;
}

function atomicWrite(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(payload)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    throw secureSessionError("SECURE_SESSION_WRITE_FAILED", "Encrypted session state could not be saved atomically.", filePath, error);
  }
}

class SecureSessionStore {
  constructor(options = {}) {
    this.configDirectory = options.configDirectory || getDefaultConfigDirectory();
    this.fileName = options.fileName || "account.json";
  }

  get filePath() {
    return path.join(this.configDirectory, this.fileName);
  }

  read() {
    if (!fs.existsSync(this.filePath)) return null;
    let record;
    try {
      record = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
    } catch (error) {
      const preservedPath = `${this.filePath}.corrupt-${Date.now()}.backup`;
      try { fs.copyFileSync(this.filePath, preservedPath, fs.constants.COPYFILE_EXCL); } catch {}
      throw secureSessionError("SECURE_SESSION_CORRUPT", "Encrypted session state is unreadable and was preserved for recovery.", this.filePath, error);
    }
    const schemaVersion = record?.schemaVersion === undefined ? 0 : Number(record.schemaVersion);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 0) throw secureSessionError("SECURE_SESSION_SCHEMA_INVALID", "Encrypted session state has an invalid schema version.", this.filePath);
    if (schemaVersion > SECURE_SESSION_SCHEMA_VERSION) throw secureSessionError("SECURE_SESSION_SCHEMA_UNSUPPORTED", "Encrypted session state was created by a newer application version.", this.filePath, null, { schemaVersion, supportedSchemaVersion: SECURE_SESSION_SCHEMA_VERSION });
    let value;
    try {
      value = decryptPayload(record, this.filePath);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Decrypted session payload must be an object.");
    } catch (error) {
      const preservedPath = `${this.filePath}.undecryptable-${Date.now()}.backup`;
      try { fs.copyFileSync(this.filePath, preservedPath, fs.constants.COPYFILE_EXCL); } catch {}
      throw secureSessionError("SECURE_SESSION_DECRYPT_FAILED", "Encrypted session state could not be decrypted and was preserved for recovery.", this.filePath, error);
    }
    if (schemaVersion < SECURE_SESSION_SCHEMA_VERSION) {
      const backupPath = `${this.filePath}.schema-v${schemaVersion}.backup`;
      if (!fs.existsSync(backupPath)) fs.copyFileSync(this.filePath, backupPath, fs.constants.COPYFILE_EXCL);
      atomicWrite(this.filePath, { ...record, schemaVersion: SECURE_SESSION_SCHEMA_VERSION });
    }
    return value;
  }

  write(session) {
    if (fs.existsSync(this.filePath)) this.read();
    atomicWrite(this.filePath, { schemaVersion: SECURE_SESSION_SCHEMA_VERSION, ...encryptPayload(session, this.filePath) });
  }

  replacePreservingUnreadable(session) {
    if (fs.existsSync(this.filePath)) {
      const preservedPath = `${this.filePath}.recovery-${Date.now()}.backup`;
      fs.copyFileSync(this.filePath, preservedPath, fs.constants.COPYFILE_EXCL);
    }
    atomicWrite(this.filePath, { schemaVersion: SECURE_SESSION_SCHEMA_VERSION, ...encryptPayload(session, this.filePath) });
  }

  clear() {
    try {
      fs.rmSync(this.filePath, { force: true });
    } catch {}
  }
}

module.exports = {
  SECURE_SESSION_SCHEMA_VERSION,
  SecureSessionStore,
  decryptPayload,
  encryptPayload,
  getDefaultConfigDirectory,
};
