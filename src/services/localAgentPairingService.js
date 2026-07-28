const { URL } = require("url");
const {
  getAgentConfigPath,
  getSharedAgentTokenStatus,
  readAgentSettings,
  rotateAgentSettingsToken,
  saveAgentSettings,
} = require("./agentClient");
const { SecureSessionStore } = require("./secureSessionStore");
const { tokenFingerprint } = require("../shared/agentTokenStore");

const DEFAULT_LOCAL_AGENT_URL = "http://127.0.0.1:47131";
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

const store = new SecureSessionStore({ fileName: "local-agent-credentials.json" });
let credentialRecovery = null;

function normalizeLocalAgentUrl(value = DEFAULT_LOCAL_AGENT_URL) {
  let parsed;
  try {
    parsed = new URL(String(value || DEFAULT_LOCAL_AGENT_URL).trim());
  } catch {
    const error = new Error("Local Agent URL is invalid.");
    error.code = "LOCAL_AGENT_URL_INVALID";
    throw error;
  }
  if (parsed.protocol !== "http:" || !LOCAL_HOSTS.has(parsed.hostname.toLowerCase())) {
    const error = new Error("Automatic Local Agent pairing is restricted to this computer.");
    error.code = "LOCAL_PAIRING_REQUIRES_LOOPBACK";
    throw error;
  }
  parsed.username = "";
  parsed.password = "";
  parsed.pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function buildCredentialRecord({ agentUrl, agentToken, reason = "local-pairing" }) {
  const fingerprint = tokenFingerprint(agentToken);
  return {
    type: "anxos-local-agent-credentials",
    version: 1,
    scope: "local-only",
    agentUrl,
    agentToken,
    fingerprint,
    allowedHosts: Array.from(LOCAL_HOSTS).sort(),
    agentConfigPath: getAgentConfigPath(),
    pairedAt: new Date().toISOString(),
    reason,
  };
}

function sanitizeCredentialRecord(record = null) {
  if (!record || typeof record !== "object") {
    return { configured: false, state: "missing" };
  }
  const local = (() => {
    try {
      return normalizeLocalAgentUrl(record.agentUrl) === record.agentUrl;
    } catch {
      return false;
    }
  })();
  return {
    configured: Boolean(record.agentToken && record.fingerprint),
    state: local ? "stored" : "invalid",
    scope: record.scope || null,
    agentUrl: local ? record.agentUrl : null,
    fingerprint: record.fingerprint || null,
    pairedAt: record.pairedAt || null,
    localOnly: local && record.scope === "local-only",
  };
}

function readLocalCredential() {
  try {
    const record = store.read();
    credentialRecovery = null;
    return record;
  } catch (error) {
    if (error?.code !== "SECURE_SESSION_DECRYPT_FAILED") throw error;
    const current = readAgentSettings();
    const agentToken = String(current?.agentToken || "").trim();
    if (!agentToken) {
      credentialRecovery = {
        degraded: true,
        state: "unavailable",
        message: "Local Agent credentials could not be restored. Pair the Local Agent again.",
      };
      return null;
    }
    const recovered = buildCredentialRecord({
      agentUrl: normalizeLocalAgentUrl(current.agentUrl || DEFAULT_LOCAL_AGENT_URL),
      agentToken,
      reason: "legacy-config-recovery",
    });
    store.write(recovered);
    credentialRecovery = {
      recovered: true,
      state: "recovered",
      message: "Local Agent credentials were recovered from the existing device configuration.",
    };
    return recovered;
  }
}

function readLocalAgentPairingStatus() {
  return {
    ...sanitizeCredentialRecord(readLocalCredential()),
    credentialRecovery,
  };
}

function snapshotLocalAgentCredential() {
  return readLocalCredential();
}

function restoreLocalAgentCredential(record = null) {
  if (record && typeof record === "object") {
    store.write(record);
  } else {
    store.clear();
  }
  return readLocalAgentPairingStatus();
}

function writeLocalCredential(agentUrl, agentToken, reason) {
  const record = buildCredentialRecord({ agentUrl, agentToken, reason });
  store.write(record);
  return sanitizeCredentialRecord(record);
}

function pairLocalAgent(options = {}) {
  const current = readAgentSettings();
  const agentUrl = normalizeLocalAgentUrl(options.agentUrl || current.agentUrl || DEFAULT_LOCAL_AGENT_URL);
  let token = current.agentToken || "";
  let rotated = null;

  if (options.rotate === true || !token) {
    rotated = rotateAgentSettingsToken({ backendMode: "agent", agentUrl });
    token = rotated.token;
  } else {
    const tokenStatus = getSharedAgentTokenStatus();
    token = tokenStatus.token || token;
    saveAgentSettings({ backendMode: "agent", agentUrl, agentToken: token });
  }

  const credential = writeLocalCredential(agentUrl, token, options.reason || (rotated ? "local-token-rotation" : "local-pairing"));
  return {
    paired: true,
    local: true,
    localOnly: true,
    agentUrl,
    fingerprint: credential.fingerprint,
    credentialState: credential.state,
    credentialStore: "secure-session-store",
    rotated: Boolean(rotated),
    restartRequired: Boolean(rotated),
  };
}

function rotateLocalAgentCredentials(options = {}) {
  return pairLocalAgent({ ...options, rotate: true, reason: options.reason || "local-token-rotation" });
}

module.exports = {
  _test: {
    normalizeLocalAgentUrl,
    sanitizeCredentialRecord,
  },
  pairLocalAgent,
  readLocalAgentPairingStatus,
  restoreLocalAgentCredential,
  rotateLocalAgentCredentials,
  snapshotLocalAgentCredential,
};
