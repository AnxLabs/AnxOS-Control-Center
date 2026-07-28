const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { decryptPayload, encryptPayload } = require("./secureSessionStore");

const NODE_CREDENTIAL_SCHEMA_VERSION = 2;
let cachedStore = null;

class NodeCredentialStoreError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "NodeCredentialStoreError";
    this.code = code;
    this.details = details;
  }
}

function getConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) return process.env.ANXHUB_CONFIG_DIR;
  try { return app ? path.join(app.getPath("userData"), "config") : path.join(process.cwd(), "config"); }
  catch { return path.join(process.cwd(), "config"); }
}

function getNodeCredentialsPath() {
  return path.join(getConfigDirectory(), "node-agent-credentials.json");
}

function trimValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNodeId(nodeId) {
  return trimValue(nodeId).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 96);
}

function cloneStore(store) {
  return {
    schemaVersion: NODE_CREDENTIAL_SCHEMA_VERSION,
    nodes: Object.fromEntries(Object.entries(store?.nodes || {}).map(([nodeId, credential]) => [nodeId, { ...credential }])),
  };
}

function readStore() {
  const filePath = getNodeCredentialsPath();
  if (!fs.existsSync(filePath)) {
    return { schemaVersion: NODE_CREDENTIAL_SCHEMA_VERSION, nodes: {} };
  }
  let parsed;
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
    if (cachedStore?.filePath === filePath && cachedStore.raw === raw) return cloneStore(cachedStore.store);
    parsed = JSON.parse(raw);
  } catch (error) {
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    } catch {}
    throw new NodeCredentialStoreError(
      "Saved node credentials are unreadable. The original file was preserved for recovery.",
      "NODE_CREDENTIAL_STORE_CORRUPT",
      { causeCode: error?.code || "INVALID_JSON" },
    );
  }
  const schemaVersion = Number.isInteger(parsed?.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > NODE_CREDENTIAL_SCHEMA_VERSION) {
    throw new NodeCredentialStoreError(
      "Saved node credentials were created by a newer application version.",
      "NODE_CREDENTIAL_SCHEMA_UNSUPPORTED",
      { schemaVersion, supportedSchemaVersion: NODE_CREDENTIAL_SCHEMA_VERSION },
    );
  }
  if (schemaVersion === NODE_CREDENTIAL_SCHEMA_VERSION) {
    try {
      const decrypted = decryptPayload(parsed.encrypted, filePath);
      if (!decrypted || typeof decrypted !== "object" || Array.isArray(decrypted)) {
        throw new Error("Encrypted credential payload is invalid.");
      }
      const store = {
        schemaVersion: NODE_CREDENTIAL_SCHEMA_VERSION,
        nodes: decrypted.nodes && typeof decrypted.nodes === "object" && !Array.isArray(decrypted.nodes) ? decrypted.nodes : {},
      };
      cachedStore = { filePath, raw, store: cloneStore(store) };
      return cloneStore(store);
    } catch (error) {
      throw new NodeCredentialStoreError(
        "Saved node credentials could not be decrypted on this device.",
        "NODE_CREDENTIAL_DECRYPT_FAILED",
        { causeCode: error?.code || "DECRYPT_FAILED" },
      );
    }
  }
  const legacyNodes = parsed?.nodes && typeof parsed.nodes === "object" && !Array.isArray(parsed.nodes) ? parsed.nodes : {};
  const backupPath = `${filePath}.schema-v${schemaVersion}.backup`;
  if (!fs.existsSync(backupPath)) {
    writeEncryptedStore(backupPath, legacyNodes);
  }
  const migrated = { schemaVersion: NODE_CREDENTIAL_SCHEMA_VERSION, nodes: legacyNodes };
  writeStore(migrated);
  return migrated;
}

function writeEncryptedStore(filePath, nodes) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const raw = `${JSON.stringify({
    schemaVersion: NODE_CREDENTIAL_SCHEMA_VERSION,
    encrypted: encryptPayload({ nodes: nodes || {} }, filePath),
  }, null, 2)}\n`;
  fs.writeFileSync(tempPath, raw, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  return raw;
}

function writeStore(store) {
  const filePath = getNodeCredentialsPath();
  const raw = writeEncryptedStore(filePath, store.nodes);
  cachedStore = { filePath, raw, store: cloneStore(store) };
}

function replaceUnreadableStore(nodes = {}) {
  const filePath = getNodeCredentialsPath();
  const recoveredNodes = Object.fromEntries(
    Object.entries(nodes)
      .map(([nodeId, credential]) => [
        normalizeNodeId(nodeId),
        {
          agentToken: trimValue(credential?.agentToken),
          updatedAt: credential?.updatedAt || new Date().toISOString(),
        },
      ])
      .filter(([nodeId, credential]) => Boolean(nodeId && credential.agentToken)),
  );
  if (!Object.keys(recoveredNodes).length) {
    throw new NodeCredentialStoreError(
      "Saved node credentials could not be recovered because no existing credential source was available.",
      "NODE_CREDENTIAL_RECOVERY_SOURCE_MISSING",
    );
  }
  try {
    readStore();
    throw new NodeCredentialStoreError(
      "Saved node credentials are readable and do not require recovery.",
      "NODE_CREDENTIAL_RECOVERY_NOT_REQUIRED",
    );
  } catch (error) {
    if (error?.code !== "NODE_CREDENTIAL_DECRYPT_FAILED") throw error;
  }

  const preservedPath = `${filePath}.undecryptable-${Date.now()}.backup`;
  fs.copyFileSync(filePath, preservedPath, fs.constants.COPYFILE_EXCL);
  const store = { schemaVersion: NODE_CREDENTIAL_SCHEMA_VERSION, nodes: recoveredNodes };
  writeStore(store);
  return { recovered: true, preservedPath, recoveredNodeCount: Object.keys(recoveredNodes).length };
}

function getNodeToken(nodeId) {
  const id = normalizeNodeId(nodeId);
  if (!id) return "";
  return trimValue(readStore().nodes?.[id]?.agentToken);
}

function setNodeToken(nodeId, token) {
  const id = normalizeNodeId(nodeId);
  const agentToken = trimValue(token);
  if (!id || !agentToken) return false;
  const store = readStore();
  store.nodes[id] = {
    agentToken,
    updatedAt: new Date().toISOString(),
  };
  writeStore(store);
  return true;
}

function deleteNodeToken(nodeId) {
  const id = normalizeNodeId(nodeId);
  if (!id) return false;
  const store = readStore();
  const existed = Object.prototype.hasOwnProperty.call(store.nodes, id);
  if (existed) {
    delete store.nodes[id];
    writeStore(store);
  }
  return existed;
}

function hasNodeToken(nodeId) {
  return Boolean(getNodeToken(nodeId));
}

module.exports = {
  NODE_CREDENTIAL_SCHEMA_VERSION,
  NodeCredentialStoreError,
  deleteNodeToken,
  getNodeCredentialsPath,
  getNodeToken,
  hasNodeToken,
  replaceUnreadableStore,
  setNodeToken,
};
