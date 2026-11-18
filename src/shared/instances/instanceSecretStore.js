"use strict";

// Server secret store (docs/SERVER_SECRET_STORE.md). Write-only, encrypted
// passwords a server needs at start, kept outside every server folder.
// AES-256-GCM with a per-computer key that is never stored with the data and
// is recorded only by fingerprint; each value is bound to its server and
// setting name by authenticated data.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const SCHEMA_VERSION = 1;
const ALGORITHM = "aes-256-gcm";
const KEY_FILE_ENV = "AGENT_SERVER_SECRET_KEY_FILE";
const NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,63}$/;
const MAX_SECRETS_PER_SERVER = 8;
const MAX_VALUE_LENGTH = 512;

function storeError(code, statusCode = 400, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  error.status = statusCode;
  error.details = details;
  return error;
}

function storeRoot(instanceRoot) {
  return path.join(path.dirname(path.resolve(instanceRoot)), "anxos-server-secrets");
}

function storePath(instanceRoot) {
  return path.join(storeRoot(instanceRoot), "secrets.json");
}

function keyFingerprint(key) {
  return crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function ensureRoot(instanceRoot) {
  fs.mkdirSync(storeRoot(instanceRoot), { recursive: true, mode: 0o700 });
}

function writeFileAtomic(filePath, content) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, content, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

// The key: a file named by AGENT_SERVER_SECRET_KEY_FILE (kept elsewhere by
// the operator), or a random key created once next to the store.
function loadKey(instanceRoot, { create = true } = {}) {
  const external = process.env[KEY_FILE_ENV];
  if (external) {
    let raw;
    try {
      raw = fs.readFileSync(external);
    } catch {
      throw storeError("SERVER_SECRET_KEY_UNAVAILABLE", 500, { keyRef: `env:${KEY_FILE_ENV}` });
    }
    const key = raw.length === 32 ? raw : Buffer.from(String(raw).trim(), /^[0-9a-f]{64}$/i.test(String(raw).trim()) ? "hex" : "base64");
    if (key.length !== 32) throw storeError("SERVER_SECRET_KEY_INVALID", 500, { keyRef: `env:${KEY_FILE_ENV}` });
    return key;
  }
  const keyPath = path.join(storeRoot(instanceRoot), "server-secrets.key");
  try {
    const key = fs.readFileSync(keyPath);
    if (key.length !== 32) throw storeError("SERVER_SECRET_KEY_INVALID", 500);
    return key;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error.code?.startsWith?.("SERVER_SECRET") ? error : storeError("SERVER_SECRET_KEY_UNAVAILABLE", 500);
    if (!create) return null;
  }
  ensureRoot(instanceRoot);
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyPath, key, { mode: 0o600, flag: "wx" });
    return key;
  } catch (error) {
    // Another start created it at the same moment: use that one.
    if (error?.code === "EEXIST") return loadKey(instanceRoot, { create: false });
    throw storeError("SERVER_SECRET_KEY_UNAVAILABLE", 500);
  }
}

function readStore(instanceRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(instanceRoot), "utf8"));
    if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object") throw new Error("shape");
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return { schemaVersion: SCHEMA_VERSION, entries: {} };
    throw storeError("SERVER_SECRET_STORE_UNREADABLE", 500);
  }
}

function writeStore(instanceRoot, store) {
  ensureRoot(instanceRoot);
  writeFileAtomic(storePath(instanceRoot), `${JSON.stringify({ ...store, schemaVersion: SCHEMA_VERSION }, null, 2)}\n`);
}

function associatedData(instanceId, name) {
  return Buffer.from(`${instanceId}\0${name}`, "utf8");
}

function encryptValue(key, instanceId, name, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(associatedData(instanceId, name));
  const data = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64"), keyId: keyFingerprint(key), setAt: new Date().toISOString() };
}

function decryptValue(key, instanceId, name, record) {
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(record.iv || "", "base64"));
  decipher.setAAD(associatedData(instanceId, name));
  decipher.setAuthTag(Buffer.from(record.tag || "", "base64"));
  return Buffer.concat([decipher.update(Buffer.from(record.data || "", "base64")), decipher.final()]).toString("utf8");
}

// Checks a { NAME: value } map from an install or update. Returns it cleaned.
function validateSecretEnvironment(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw storeError("INVALID_SECRET_ENVIRONMENT");
  const entries = Object.entries(value);
  if (entries.length > MAX_SECRETS_PER_SERVER) throw storeError("INVALID_SECRET_ENVIRONMENT", 400, { max: MAX_SECRETS_PER_SERVER });
  const cleaned = {};
  for (const [name, raw] of entries) {
    const text = typeof raw === "string" ? raw : "";
    if (!NAME_PATTERN.test(name) || text.length < 1 || text.length > MAX_VALUE_LENGTH || /[\0\r\n]/.test(text)) {
      throw storeError("INVALID_SECRET_ENVIRONMENT", 400, { name: NAME_PATTERN.test(name) ? name : null });
    }
    cleaned[name] = text;
  }
  return cleaned;
}

// Stores (or replaces) values for one server. Other names are kept.
function setServerSecrets(instanceRoot, instanceId, values) {
  const cleaned = validateSecretEnvironment(values);
  if (Object.keys(cleaned).length === 0) return [];
  const key = loadKey(instanceRoot);
  const store = readStore(instanceRoot);
  const current = store.entries[instanceId] || {};
  for (const [name, value] of Object.entries(cleaned)) current[name] = encryptValue(key, instanceId, name, value);
  store.entries[instanceId] = current;
  writeStore(instanceRoot, store);
  return Object.keys(current);
}

// Decrypts the named values for a server start. Any missing or unreadable
// value refuses the start: the server must never start without it.
function readServerSecretsForStart(instanceRoot, instanceId, names = []) {
  if (!Array.isArray(names) || names.length === 0) return {};
  const store = readStore(instanceRoot);
  const entries = store.entries[instanceId] || {};
  const key = loadKey(instanceRoot, { create: false });
  const values = {};
  const unavailable = [];
  for (const name of names) {
    const record = entries[name];
    if (!record || !key) { unavailable.push(name); continue; }
    try {
      values[name] = decryptValue(key, instanceId, name, record);
    } catch {
      unavailable.push(name);
    }
  }
  if (unavailable.length > 0) {
    const error = storeError("SERVER_SECRET_UNAVAILABLE", 409, { names: unavailable });
    error.message = `This server needs ${unavailable.join(", ")}, which is not stored on this computer (for example after a move). Set a new value, then start it again.`;
    throw error;
  }
  return values;
}

function listServerSecretNames(instanceRoot, instanceId) {
  const entries = readStore(instanceRoot).entries[instanceId] || {};
  return Object.entries(entries).map(([name, record]) => ({ name, configured: true, setAt: record.setAt || null }));
}

function deleteServerSecrets(instanceRoot, instanceId) {
  const store = readStore(instanceRoot);
  if (!store.entries[instanceId]) return false;
  delete store.entries[instanceId];
  writeStore(instanceRoot, store);
  return true;
}

// Re-encrypts every value with a new key, then replaces the key file. Values
// that cannot be decrypted with the current key are reported, not dropped.
function rotateServerSecretKey(instanceRoot, newKey = crypto.randomBytes(32)) {
  if (!Buffer.isBuffer(newKey) || newKey.length !== 32) throw storeError("SERVER_SECRET_KEY_INVALID");
  if (process.env[KEY_FILE_ENV]) throw storeError("SERVER_SECRET_KEY_EXTERNAL", 409, { keyRef: `env:${KEY_FILE_ENV}` });
  const oldKey = loadKey(instanceRoot, { create: false });
  const store = readStore(instanceRoot);
  const unreadable = [];
  for (const [instanceId, entries] of Object.entries(store.entries)) {
    for (const [name, record] of Object.entries(entries)) {
      try {
        const value = decryptValue(oldKey, instanceId, name, record);
        entries[name] = { ...encryptValue(newKey, instanceId, name, value), setAt: record.setAt };
      } catch {
        unreadable.push(`${instanceId}/${name}`);
      }
    }
  }
  writeStore(instanceRoot, store);
  writeFileAtomic(path.join(storeRoot(instanceRoot), "server-secrets.key"), newKey);
  return { keyId: keyFingerprint(newKey), unreadable };
}

// Replaces each secret value in a line of server output.
function redactSecretValues(line, values = []) {
  let text = String(line ?? "");
  for (const value of values) {
    if (value && value.length >= 4) text = text.split(value).join("[redacted]");
  }
  return text;
}

module.exports = {
  KEY_FILE_ENV,
  deleteServerSecrets,
  keyFingerprint,
  listServerSecretNames,
  readServerSecretsForStart,
  redactSecretValues,
  rotateServerSecretKey,
  setServerSecrets,
  storeRoot,
  validateSecretEnvironment,
};
