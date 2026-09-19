const fs = require("fs");
const path = require("path");
const { app } = require("electron");
const { decryptPayload, encryptPayload } = require("./secureSessionStore");
const {
  decideMigrationRecovery,
  verifyRecoveryPoint,
} = require("../shared/migrationRecoveryPolicy");

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
  const backupExisted = fs.existsSync(backupPath);
  if (!backupExisted) {
    writeEncryptedStore(backupPath, legacyNodes);
  }
  // V2-J bullet 6: the legacy plaintext store is migrated to the encrypted
  // envelope only behind a recovery point that was read back and verified.
  // Unlike a byte copy, this recovery point is a RE-ENCODE (the legacy file was
  // plaintext), so verification is a parse check plus a decrypt-and-compare of
  // the logical node payload. An unverified copy is refused, not warned past.
  const recoveryVerification = verifyEncryptedCredentialRecoveryPoint(backupPath, legacyNodes);
  const recoveryVerdict = decideMigrationRecovery({
    storeId: "node-credentials",
    fromSchemaVersion: schemaVersion,
    toSchemaVersion: NODE_CREDENTIAL_SCHEMA_VERSION,
    recoveryPoint: { canTake: true, taken: fs.existsSync(backupPath), verified: recoveryVerification.verified },
    // The legacy plaintext store is the source being migrated; once overwritten
    // there is no other copy to rebuild the credentials from.
    reconstructible: { isReconstructible: false, source: null },
  });
  if (recoveryVerdict.verdict !== "proceed") {
    if (!backupExisted) {
      try {
        fs.rmSync(backupPath, { force: true });
      } catch {}
    }
    throw new NodeCredentialStoreError(
      "Saved node credentials could not be migrated safely because the pre-migration recovery point could not be verified.",
      "NODE_CREDENTIAL_MIGRATION_RECOVERY_UNVERIFIED",
      { storeId: "node-credentials", reason: recoveryVerdict.reason, verification: recoveryVerification.reason },
    );
  }
  const migrated = { schemaVersion: NODE_CREDENTIAL_SCHEMA_VERSION, nodes: legacyNodes };
  writeStore(migrated);
  return migrated;
}

// Deterministic key-ordered serialization so a JSON round-trip of the same
// object always compares equal regardless of key insertion order.
function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

// Verification for the node-credential recovery point: read it back, confirm it
// is a parseable envelope, then decrypt it with the recovery point's own path
// and confirm the logical node payload matches the legacy nodes being migrated.
// This proves the recovery point is readable and holds the same credentials; it
// does NOT prove a restore into a working installation would succeed.
function verifyEncryptedCredentialRecoveryPoint(backupPath, expectedNodes) {
  let raw;
  try {
    raw = fs.readFileSync(backupPath);
  } catch {
    raw = null;
  }
  const parsedCheck = verifyRecoveryPoint({
    mode: "json",
    copy: raw,
    expect: (value) => Number.isInteger(value.schemaVersion) && value.encrypted !== null && typeof value.encrypted === "object",
  });
  if (!parsedCheck.verified) return parsedCheck;
  try {
    const envelope = JSON.parse(raw.toString("utf8"));
    const decrypted = decryptPayload(envelope.encrypted, backupPath);
    const decryptedNodes = decrypted && typeof decrypted === "object" && !Array.isArray(decrypted) ? decrypted.nodes : null;
    if (!decryptedNodes || typeof decryptedNodes !== "object" || Array.isArray(decryptedNodes)) {
      return { ...parsedCheck, verified: false, reason: "recovery_point_payload_unreadable" };
    }
    if (canonicalJson(decryptedNodes) !== canonicalJson(expectedNodes || {})) {
      return { ...parsedCheck, verified: false, reason: "recovery_point_payload_mismatch" };
    }
    return { ...parsedCheck, reason: "encrypted_recovery_point_verified" };
  } catch {
    return { ...parsedCheck, verified: false, reason: "recovery_point_payload_unreadable" };
  }
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
