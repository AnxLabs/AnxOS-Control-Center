const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const bcrypt = require("bcryptjs");
const { app, safeStorage } = require("electron");
const {
  getAgentConfig,
  getAgentConfigPath,
  readAgentSettings,
  rotateAgentSettingsToken,
} = require("./agentClient");
const { tokenFingerprint } = require("../shared/agentTokenStore");
const { completeLocalOwnerRecovery, getCurrentSession: getCurrentAccountSession } = require("./accountService");
const authRecovery = require("./authRecoveryState");
const {
  getConfiguredOwnerAccounts,
  isOwnerAccount,
} = require("./ownerAccountConfig");
const {
  getExecutionTarget,
  getNode,
} = require("./nodeService");
const diagnostics = require("./diagnosticsService");

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const PERSISTENT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 10;
const BCRYPT_ROUNDS = 12;
const SECURITY_SCHEMA_VERSION = 1;
const PERSISTENT_SESSION_SCHEMA_VERSION = 1;
const DEVELOPMENT_FALLBACK_OWNER_PASSWORD = "1245";
const SESSION_TIMEOUT_OPTIONS_MS = new Set([
  0,
  24 * 60 * 60 * 1000,
  7 * 24 * 60 * 60 * 1000,
  30 * 24 * 60 * 60 * 1000,
  90 * 24 * 60 * 60 * 1000,
]);
const ROLE_PERMISSIONS = {
  Owner: ["*"],
  Admin: [
    "instance:read",
    "instance:write",
    "instance:lifecycle",
    "instance:delete",
    "files:read",
    "files:write",
    "docker:read",
    "system:read",
    "dependencies:read",
    "public-access:read",
    "marketplace:read",
    "nodes:read",
    "ssh:read",
    "settings:read",
    "settings:preferences:write",
    "marketplace:install",
    "backups:read",
    "backups:write",
    "backups:restore",
    "settings:write",
  ],
  User: ["instance:read", "instance:lifecycle", "files:read", "docker:read", "backups:read", "system:read", "dependencies:read", "public-access:read", "marketplace:read", "nodes:read", "ssh:read", "settings:read", "settings:preferences:write"],
};
const SECURITY_EVENT_DEFINITIONS = {
  "security.setup": { category: "authentication", severity: "info", message: "Local Owner security was configured." },
  "security.login": { category: "authentication", severity: "info", message: "A local Owner sign-in was recorded." },
  "security.logout": { category: "authentication", severity: "info", message: "A local security session signed out." },
  "security.session.restore": { category: "authentication", severity: "info", message: "A remembered local session was restored." },
  "security.session.revoke": { category: "sessions", severity: "warning", message: "A remembered local session was revoked." },
  "security.sessions.revokeOther": { category: "sessions", severity: "warning", message: "Other remembered local sessions were revoked." },
  "security.sessions.logoutAll": { category: "sessions", severity: "warning", message: "All remembered local sessions were revoked." },
  "security.trustedDevice.remove": { category: "sessions", severity: "warning", message: "Trusted-device access was removed." },
  "security.trustedDevice.rename": { category: "sessions", severity: "info", message: "A trusted-device name was changed." },
  "security.trustedDevices.removeAll": { category: "sessions", severity: "critical", message: "All trusted devices were removed." },
  "agent.token.rotate": { category: "tokens", severity: "warning", message: "The Agent token was rotated." },
  "agent.token.revoke": { category: "tokens", severity: "critical", message: "The Agent token was revoked." },
  "security.remoteAccess.settings": { category: "remote", severity: "info", message: "Remote access security settings changed." },
  "security.remoteAccess.disable": { category: "remote", severity: "warning", message: "Remote access was disabled." },
  "security.ownerWorkspace.lock": { category: "owner", severity: "warning", message: "Owner Workspace was locked." },
  "security.ownerWorkspace": { category: "owner", severity: "warning", message: "Owner authorization was denied." },
  "security.permission": { category: "warnings", severity: "warning", message: "A protected security action was denied." },
  "security.settings.update": { category: "sessions", severity: "info", message: "Session security settings changed." },
  "security.localState.reset": { category: "sessions", severity: "critical", message: "Local security state was reset." },
};

let currentSession = null;
const rateBuckets = new Map();

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

function getSecurityPath() {
  return path.join(getConfigDirectory(), "security.json");
}

function getLegacySecurityPaths() {
  if (process.env.ANXHUB_CONFIG_DIR) return [];
  let appData = "";
  try { appData = app?.getPath("appData") || ""; } catch {}
  if (!appData) return [];
  return ["AnxOS Control Center", "anxos-control-center", "AnxOS-Control-Center", "AnxHub"]
    .map((directory) => path.join(appData, directory, "config", "security.json"))
    .filter((filePath) => path.resolve(filePath) !== path.resolve(getSecurityPath()));
}

function getPersistentSessionPath() {
  return path.join(getConfigDirectory(), "session.dat");
}

function getAuditPath() {
  return path.join(getConfigDirectory(), "audit.log");
}

function isTrustedDevelopmentMode() {
  if (process.env.ANXOS_FORCE_PRODUCTION === "1") {
    return false;
  }
  if (process.env.ANXOS_TRUSTED_DEVELOPMENT_MODE === "1") {
    try {
      if (typeof app?.isPackaged === "boolean") {
        return app.isPackaged === false;
      }
    } catch {
      return process.env.NODE_ENV === "development" || process.defaultApp === true;
    }
    return process.env.NODE_ENV === "development" || process.defaultApp === true;
  }
  try {
    if (app?.isPackaged === false) {
      return true;
    }
  } catch {}
  return process.env.NODE_ENV === "development" && process.defaultApp === true;
}

function logOwnerAuthDiagnostic(event, details = {}) {
  if (!isTrustedDevelopmentMode()) return;
  console.info("[Security][LocalOwner]", {
    event,
    ownerExists: details.ownerExists === true,
    username: details.username || null,
    usernames: details.usernames || undefined,
    authenticationProvider: details.authenticationProvider || "local-owner",
    failureReason: details.failureReason || null,
    hashFormat: details.hashFormat || null,
    sourceDirectory: details.sourceDirectory || undefined,
  });
}

function getPasswordHashFormat(value) {
  const hash = String(value || "");
  if (/^\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(hash)) return "bcrypt";
  return hash ? "unsupported" : "missing";
}

function getDevelopmentOwnerPassword() {
  if (!isTrustedDevelopmentMode()) {
    return null;
  }
  return process.env.ANXOS_DEV_OWNER_PASSWORD || DEVELOPMENT_FALLBACK_OWNER_PASSWORD;
}

function ensureConfigDirectory() {
  fs.mkdirSync(getConfigDirectory(), { recursive: true });
}

function normalizeSecurityState(parsed = {}) {
  return {
    schemaVersion: SECURITY_SCHEMA_VERSION,
    users: Array.isArray(parsed.users) ? parsed.users : [],
    persistentSessions: Array.isArray(parsed.persistentSessions) ? parsed.persistentSessions : [],
    trustedDevices: Array.isArray(parsed.trustedDevices) ? parsed.trustedDevices : [],
    agentTokens: parsed.agentTokens && typeof parsed.agentTokens === "object" ? parsed.agentTokens : {},
    settings: {
      sessionTtlMs: Number.parseInt(parsed.settings?.sessionTtlMs, 10) || SESSION_TTL_MS,
      persistentSessionTtlMs: Number.parseInt(parsed.settings?.persistentSessionTtlMs, 10) || PERSISTENT_SESSION_TTL_MS,
      inactiveSessionExpirationMs: Number.parseInt(parsed.settings?.inactiveSessionExpirationMs, 10) || 0,
      lockOwnerWorkspaceAfterInactivity: parsed.settings?.lockOwnerWorkspaceAfterInactivity !== false,
      requireReauthForSensitiveActions: parsed.settings?.requireReauthForSensitiveActions !== false,
      requireAuthenticatedAccountForRemoteAccess: parsed.settings?.requireAuthenticatedAccountForRemoteAccess === true,
      requireTrustedDeviceForRemoteAccess: parsed.settings?.requireTrustedDeviceForRemoteAccess === true,
      remoteAccessAutoDisableMs: Number.parseInt(parsed.settings?.remoteAccessAutoDisableMs, 10) || 0,
    },
  };
}

function readSecurityFile(filePath, options = {}) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw error;
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    throw Object.assign(new Error("Security state is unreadable. The original file was preserved and protected actions remain unavailable."), {
      code: "SECURITY_STORE_CORRUPT",
      details: { causeCode: error?.code || "INVALID_JSON" },
    });
  }
  const schemaVersion = Number.isInteger(parsed?.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > SECURITY_SCHEMA_VERSION) {
    throw Object.assign(new Error("Security state was created by a newer application version."), {
      code: "SECURITY_SCHEMA_UNSUPPORTED",
      details: { schemaVersion, supportedSchemaVersion: SECURITY_SCHEMA_VERSION },
    });
  }
  const state = normalizeSecurityState(parsed);
  if (options.migrate === true && schemaVersion < SECURITY_SCHEMA_VERSION) {
    const backupPath = `${filePath}.schema-v${schemaVersion}.backup`;
    if (!fs.existsSync(backupPath)) fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    writeSecurityState(state);
  }
  return state;
}

function migrateLegacyOwnerUsers(state, legacyPaths = getLegacySecurityPaths()) {
  if (state.users.some((entry) => entry?.role === "Owner" || entry?.role === "Admin")) return state;
  for (const legacyPath of legacyPaths) {
    try {
      const users = readSecurityFile(legacyPath).users.filter((entry) => entry?.role === "Owner" || entry?.role === "Admin");
      if (!users.length) continue;
      const migrated = { ...state, users };
      writeSecurityState(migrated);
      logOwnerAuthDiagnostic("legacy-owner-migrated", {
        ownerExists: true,
        usernames: users.map((entry) => String(entry.username || "")).filter(Boolean),
        sourceDirectory: path.basename(path.dirname(path.dirname(legacyPath))),
      });
      return migrated;
    } catch {}
  }
  return state;
}

function readSecurityState() {
  try {
    return migrateLegacyOwnerUsers(readSecurityFile(getSecurityPath(), { migrate: true }));
  } catch (error) {
    if (error?.code === "ENOENT") return migrateLegacyOwnerUsers(normalizeSecurityState());
    logOwnerAuthDiagnostic("security-store-read-failed", {
      failureReason: "CONFIG_READ_FAILED",
    });
    throw error;
  }
}

function writeSecurityState(state) {
  ensureConfigDirectory();
  const filePath = getSecurityPath();
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(normalizeSecurityState(state), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function removePersistentSessionFile() {
  try {
    fs.rmSync(getPersistentSessionPath(), { force: true });
  } catch {}
}

function getFallbackEncryptionKey() {
  let username = "local-user";
  try {
    username = os.userInfo().username || username;
  } catch {}

  return crypto.scryptSync(
    `${username}:${os.hostname()}:${getSecurityPath()}`,
    "anxhub-local-session",
    32
  );
}

function encryptLocalSession(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (safeStorage?.isEncryptionAvailable?.()) {
    return {
      schemaVersion: PERSISTENT_SESSION_SCHEMA_VERSION,
      method: "safeStorage",
      data: safeStorage.encryptString(payload.toString("utf8")).toString("base64"),
    };
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getFallbackEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(payload), cipher.final()]);
  return {
    schemaVersion: PERSISTENT_SESSION_SCHEMA_VERSION,
    method: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };
}

function decryptLocalSession(record) {
  if (!record || typeof record !== "object") {
    return null;
  }

  if (record.method === "safeStorage" && safeStorage?.isEncryptionAvailable?.()) {
    return JSON.parse(safeStorage.decryptString(Buffer.from(record.data || "", "base64")));
  }

  if (record.method === "aes-256-gcm") {
    const decipher = crypto.createDecipheriv("aes-256-gcm", getFallbackEncryptionKey(), Buffer.from(record.iv || "", "base64"));
    decipher.setAuthTag(Buffer.from(record.tag || "", "base64"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(record.data || "", "base64")), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  }

  return null;
}

function writePersistentSessionRecordAtomic(record) {
  ensureConfigDirectory();
  const filePath = getPersistentSessionPath();
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporaryPath, filePath);
  } catch (cause) {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
    const error = Object.assign(new Error("Remembered session state could not be saved atomically."), { code: "PERSISTENT_SESSION_WRITE_FAILED" });
    Object.defineProperty(error, "cause", { value: cause, enumerable: false });
    throw error;
  }
}

function writePersistentSessionFile(payload) {
  ensureConfigDirectory();
  const filePath = getPersistentSessionPath();
  if (fs.existsSync(filePath)) {
    const current = parsePersistentSessionRecord({ preserveFailure: true });
    if (!current) throw Object.assign(new Error("Remembered session state is unreadable and must be reset explicitly before it can be replaced."), { code: "PERSISTENT_SESSION_CORRUPT" });
  }
  writePersistentSessionRecordAtomic(encryptLocalSession(payload));
}

function parsePersistentSessionRecord({ preserveFailure = false } = {}) {
  const filePath = getPersistentSessionPath();
  if (!fs.existsSync(filePath)) return null;
  let record;
  try {
    record = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (preserveFailure) {
      const backupPath = `${filePath}.corrupt-${Date.now()}.backup`;
      try { fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    }
    return null;
  }
  const schemaVersion = record?.schemaVersion === undefined ? 0 : Number(record.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion < 0) return null;
  if (schemaVersion > PERSISTENT_SESSION_SCHEMA_VERSION) {
    throw Object.assign(new Error("Remembered session state was created by a newer application version."), { code: "PERSISTENT_SESSION_SCHEMA_UNSUPPORTED", details: { schemaVersion, supportedSchemaVersion: PERSISTENT_SESSION_SCHEMA_VERSION } });
  }
  if (schemaVersion < PERSISTENT_SESSION_SCHEMA_VERSION) {
    const backupPath = `${filePath}.schema-v${schemaVersion}.backup`;
    if (!fs.existsSync(backupPath)) fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL);
    writePersistentSessionRecordAtomic({ ...record, schemaVersion: PERSISTENT_SESSION_SCHEMA_VERSION });
  }
  return record;
}

function readPersistentSessionFile() {
  let record;
  try {
    record = parsePersistentSessionRecord({ preserveFailure: true });
    return record ? decryptLocalSession(record) : null;
  } catch (error) {
    if (error?.code === "PERSISTENT_SESSION_SCHEMA_UNSUPPORTED") return null;
    const filePath = getPersistentSessionPath();
    const backupPath = `${filePath}.undecryptable-${Date.now()}.backup`;
    try { fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    return null;
  }
}

function getPasswordHashDigest(user) {
  return crypto.createHash("sha256").update(String(user?.passwordHash || "")).digest("base64url");
}

function pruneExpiredPersistentSessions(state, now = Date.now()) {
  const originalCount = state.persistentSessions.length;
  state.persistentSessions = state.persistentSessions.filter((session) => Date.parse(session.expiresAt || "") > now);
  return state.persistentSessions.length !== originalCount;
}

function removePersistentSessionRecord(sessionId) {
  if (!sessionId) {
    return;
  }
  const state = readSecurityState();
  const nextSessions = state.persistentSessions.filter((entry) => entry.id !== sessionId);
  if (nextSessions.length !== state.persistentSessions.length) {
    state.persistentSessions = nextSessions;
    writeSecurityState(state);
  }
}

function publicUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: user.id,
    username: user.username,
    role: user.role,
    account: Boolean(user.account),
    email: user.email || null,
    provider: user.provider || null,
    ownerAuthorized: user.account === true ? user.ownerAuthorized === true : user.role === "Owner",
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt || null,
  };
}

function accountSessionToSecurityUser(accountSession) {
  if (!accountSession) {
    return null;
  }
  const account = accountSession.account || accountSession.user || {};
  const ownerAuthorized = isOwnerAccount({
    id: account.id,
    email: account.email,
  });
  return {
    id: account.id || "anxos-account",
    username: account.displayName || account.username || account.email || "AnxOS Account",
    email: account.email || null,
    provider: accountSession.provider || account.provider || "AnxOS",
    role: ownerAuthorized ? "Owner" : "Account",
    account: true,
    ownerAuthorized,
    createdAt: accountSession.createdAt || null,
    updatedAt: null,
    lastLoginAt: null,
  };
}

function getCurrentUser() {
  restorePersistentSession();
  if (!currentSession || currentSession.expiresAt <= Date.now()) {
    if (currentSession?.persistent) {
      removePersistentSessionFile();
    }
    currentSession = null;
    return null;
  }

  if (currentSession.developmentOwner === true) {
    if (!isTrustedDevelopmentMode()) {
      currentSession = null;
      return null;
    }
    return publicUser(currentSession.userSnapshot);
  }

  const user = readSecurityState().users.find((entry) => entry.id === currentSession.userId);
  if (!user) {
    if (currentSession.persistent) {
      removePersistentSessionFile();
    }
    currentSession = null;
    return null;
  }

  if (currentSession.persistent && currentSession.passwordHashDigest !== getPasswordHashDigest(user)) {
    removePersistentSessionRecord(currentSession.persistentSessionId);
    removePersistentSessionFile();
    currentSession = null;
    return null;
  }

  return publicUser(user);
}

async function createPersistentSession(state, user) {
  const rawToken = crypto.randomBytes(48).toString("base64url");
  const device = getCurrentDeviceInfo();
  const session = {
    id: crypto.randomUUID(),
    userId: user.id,
    tokenHash: await bcrypt.hash(rawToken, BCRYPT_ROUNDS),
    passwordHashDigest: getPasswordHashDigest(user),
    deviceId: device.id,
    deviceName: device.name,
    platform: device.platform,
    createdAt: new Date().toISOString(),
    lastUsedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + (state.settings.persistentSessionTtlMs || PERSISTENT_SESSION_TTL_MS)).toISOString(),
  };
  state.persistentSessions.push(session);
  writePersistentSessionFile({
    sessionId: session.id,
    token: rawToken,
    expiresAt: session.expiresAt,
  });
  return session;
}

function createRuntimeSession(user, expiresAt, persistent = false, persistentSessionId = null) {
  currentSession = {
    token: crypto.randomBytes(32).toString("base64url"),
    userId: user.id,
    expiresAt,
    persistent,
    persistentSessionId,
    passwordHashDigest: getPasswordHashDigest(user),
  };
}

function restorePersistentSession() {
  if (currentSession) {
    return null;
  }

  const localSession = readPersistentSessionFile();
  if (!localSession?.sessionId || !localSession?.token) {
    return null;
  }

  const state = readSecurityState();
  const now = Date.now();
  let changed = pruneExpiredPersistentSessions(state, now);
  const session = state.persistentSessions.find((entry) => entry.id === localSession.sessionId);
  const user = session ? state.users.find((entry) => entry.id === session.userId) : null;

  if (!session || !user || Date.parse(session.expiresAt || "") <= now || session.passwordHashDigest !== getPasswordHashDigest(user)) {
    removePersistentSessionFile();
    if (session) {
      state.persistentSessions = state.persistentSessions.filter((entry) => entry.id !== session.id);
      changed = true;
    }
    if (changed) {
      writeSecurityState(state);
    }
    return null;
  }

  let ok = false;
  try {
    ok = bcrypt.compareSync(String(localSession.token), session.tokenHash);
  } catch {
    ok = false;
  }

  if (!ok) {
    removePersistentSessionFile();
    state.persistentSessions = state.persistentSessions.filter((entry) => entry.id !== session.id);
    writeSecurityState(state);
    return null;
  }

  session.lastUsedAt = new Date().toISOString();
  writeSecurityState(state);
  createRuntimeSession(user, Date.parse(session.expiresAt), true, session.id);
  audit({ action: "security.session.restore", outcome: "ok", actor: publicUser(user) });
  return publicUser(user);
}

function audit(event) {
  ensureConfigDirectory();
  const actor = event.actor || getCurrentUser();
  const record = {
    at: new Date().toISOString(),
    actor: actor ? { id: actor.id, username: actor.username, role: actor.role } : null,
    action: event.action,
    outcome: event.outcome || "ok",
    target: event.target || null,
    reason: event.reason || null,
  };

  fs.appendFileSync(getAuditPath(), `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

function redactSensitive(value) {
  return String(value || "")
    .replace(/(authorization|cookie|password|refresh[_-]?token|access[_-]?token|agent[_-]?token|api[_-]?key|secret)\s*[:=]\s*[^,\s}]+/gi, "$1=[redacted]")
    .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[redacted]");
}

function sanitizeSecurityText(value, fallback = "Unavailable", maxLength = 120) {
  const text = redactSensitive(String(value || "").replace(/[\u0000-\u001f\u007f]/g, " ").trim());
  return (text || fallback).slice(0, maxLength);
}

function publicTargetId(type, rawId) {
  return crypto
    .createHash("sha256")
    .update(`${type}:${String(rawId || "")}:${getSecurityPath()}`)
    .digest("base64url")
    .slice(0, 24);
}

function resolvePersistentSessionId(state, target) {
  const publicId = String(target || "");
  const match = state.persistentSessions.find((entry) => publicTargetId("session", entry.id) === publicId);
  return match?.id || null;
}

function resolveTrustedDeviceId(state, target) {
  const publicId = String(target || "");
  const match = state.trustedDevices.find((entry) => publicTargetId("device", entry.id) === publicId);
  return match?.id || null;
}

function getCurrentDeviceId() {
  return crypto
    .createHash("sha256")
    .update(`${os.hostname()}:${os.platform()}:${os.arch()}:${getSecurityPath()}`)
    .digest("hex")
    .slice(0, 16);
}

function getCurrentDeviceInfo() {
  return {
    id: getCurrentDeviceId(),
    name: os.hostname(),
    platform: `${os.platform()} ${os.arch()}`,
    firstSeen: null,
    lastSeen: new Date().toISOString(),
    current: true,
  };
}

function normalizeTrustedDevices(state) {
  const current = getCurrentDeviceInfo();
  const devices = Array.isArray(state.trustedDevices) ? state.trustedDevices : [];
  let changed = false;
  const existing = devices.find((device) => device.id === current.id);
  if (!existing) {
    devices.push({
      ...current,
      trusted: true,
      firstSeen: new Date().toISOString(),
      trustExpiresAt: null,
    });
    changed = true;
  } else {
    existing.name = existing.name || current.name;
    existing.platform = existing.platform || current.platform;
    existing.lastSeen = current.lastSeen;
    existing.trusted = existing.trusted !== false;
    changed = true;
  }
  state.trustedDevices = devices;
  return changed;
}

function safeIso(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function getAuditEvents(limit = 80) {
  try {
    return fs.readFileSync(getAuditPath(), "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Math.min(250, limit)))
      .map((line) => {
        try {
          const entry = JSON.parse(line);
          const definition = SECURITY_EVENT_DEFINITIONS[entry.action] || {};
          const failed = entry.outcome === "failed" || entry.outcome === "denied";
          return {
            timestamp: safeIso(entry.at) || new Date().toISOString(),
            type: String(entry.action || "security.event"),
            category: definition.category || categorizeSecurityEvent(entry.action),
            severity: failed ? "warning" : definition.severity || "info",
            source: "desktop-security-service",
            device: sanitizeSecurityText(os.hostname(), "This device", 80),
            actor: entry.actor ? {
              id: entry.actor.id ? publicTargetId("actor", entry.actor.id) : null,
              username: sanitizeSecurityText(entry.actor.username, "Unknown user", 80),
              role: sanitizeSecurityText(entry.actor.role, "Unknown", 40),
            } : null,
            result: entry.outcome || "ok",
            message: failed
              ? sanitizeSecurityText(entry.reason, definition.message || "Security action failed.", 180)
              : definition.message || "Security event recorded.",
            diagnosticIssue: failed ? `security:${entry.action || "event"}:${entry.outcome || "failed"}` : null,
            notificationKey: /session\.revoke|sessions\.revokeOther|sessions\.logoutAll|trustedDevice\.remove|agent\.token|ownerWorkspace|permission/i.test(entry.action || "")
              ? `security-event:${entry.action}:${entry.outcome || "ok"}`
              : null,
            action: failed ? "open-diagnostics" : "review",
            details: {
              target: redactSensitive(entry.target || ""),
              reason: redactSensitive(entry.reason || ""),
            },
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

function categorizeSecurityEvent(action = "") {
  if (/login|logout|session|account/i.test(action)) return "authentication";
  if (/token/i.test(action)) return "tokens";
  if (/remote|agent/i.test(action)) return "remote";
  if (/owner|workspace/i.test(action)) return "owner";
  if (/trusted|device/i.test(action)) return "sessions";
  if (/failed|denied|warn/i.test(action)) return "warnings";
  return "all";
}

function getSessionRows(state, status) {
  const now = Date.now();
  const currentDevice = getCurrentDeviceInfo();
  const rows = state.persistentSessions.map((session) => ({
    id: publicTargetId("session", session.id),
    deviceId: session.deviceId ? publicTargetId("device", session.deviceId) : publicTargetId("device", currentDevice.id),
    deviceName: sanitizeSecurityText(session.deviceName || currentDevice.name, "Unknown device", 100),
    operatingSystem: sanitizeSecurityText(session.platform || currentDevice.platform, "Platform unavailable", 100),
    location: session.location ? sanitizeSecurityText(session.location, "Unavailable", 80) : "Unavailable",
    ipAddress: session.ipAddress ? "Available to trusted backend" : "Unavailable",
    lastActiveAt: safeIso(session.lastUsedAt),
    createdAt: safeIso(session.createdAt),
    expiresAt: safeIso(session.expiresAt),
    current: currentSession?.persistentSessionId === session.id,
    trusted: state.trustedDevices.some((device) => device.id === currentDevice.id && device.trusted !== false),
    expired: Date.parse(session.expiresAt || "") <= now,
    remembered: true,
    revocationAvailable: true,
  }));
  if (status.authenticated && !rows.some((row) => row.current)) {
    rows.unshift({
      id: "runtime-current",
      deviceName: sanitizeSecurityText(currentDevice.name, "This device", 100),
      operatingSystem: sanitizeSecurityText(currentDevice.platform, "Platform unavailable", 100),
      location: "Unavailable",
      ipAddress: "Unavailable",
      lastActiveAt: new Date().toISOString(),
      createdAt: currentSession?.expiresAt ? new Date(Math.min(Date.now(), currentSession.expiresAt)).toISOString() : null,
      expiresAt: currentSession?.expiresAt ? new Date(currentSession.expiresAt).toISOString() : null,
      current: true,
      trusted: true,
      runtimeOnly: true,
      expired: false,
      remembered: false,
      revocationAvailable: false,
    });
  }
  return rows;
}

function getNodeScopedAgentSettings(options = {}) {
  const target = getExecutionTarget(options?.nodeId);
  return target.type === "agent" ? target.config : { backendMode: "local", agentUrl: "", agentToken: "" };
}

function getAgentTokenSummary(state, options = {}) {
  const settings = getNodeScopedAgentSettings(options);
  const target = getExecutionTarget(options?.nodeId);
  const effectiveConfig = getAgentConfig(settings);
  const agentToken = effectiveConfig.token || settings.agentToken || "";
  const agentUrl = settings.agentUrl || effectiveConfig.url || "";
  let stat = null;
  try {
    stat = fs.statSync(getAgentConfigPath());
  } catch {}
  const fingerprint = tokenFingerprint(agentToken);
  const tokenRecord = state.agentTokens?.[fingerprint] || {};
  return {
    configured: Boolean(agentToken),
    fingerprint: fingerprint || (agentToken ? "Configured" : "Unavailable"),
    createdAt: safeIso(tokenRecord.createdAt) || (stat ? stat.birthtime.toISOString() : null),
    lastRotatedAt: safeIso(tokenRecord.lastRotatedAt) || (stat ? stat.mtime.toISOString() : null),
    lastUsedAt: safeIso(tokenRecord.lastUsedAt),
    scope: target.type === "agent" ? "Selected Agent node" : "Application host",
    expirationState: "No expiration",
    associatedDevice: getNode(options?.nodeId)?.displayName || (target.type === "agent" ? agentUrl : "Application Host"),
    configPath: getAgentConfigPath(),
    connectedAgents: target.type === "agent" && agentUrl ? 1 : 0,
    lastAuthenticationAt: safeIso(tokenRecord.lastAuthenticationAt) || safeIso(tokenRecord.lastUsedAt),
    recentFailures: getAuditEvents(40).filter((event) => event.category === "tokens" && event.result !== "ok").length,
  };
}

function getRemoteAccessSummary(state, options = {}) {
  const settings = getNodeScopedAgentSettings(options);
  const enabled = settings.backendMode === "agent" || settings.backendMode === "auto";
  let parsed = null;
  try {
    parsed = new URL(settings.agentUrl);
  } catch {}
  const host = parsed?.hostname || null;
  const localOnly = !host || host === "127.0.0.1" || host === "localhost";
  const localNetwork = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(host || "");
  return {
    enabled,
    address: settings.agentUrl || null,
    port: parsed?.port || "Unavailable",
    scope: !enabled ? "Disabled" : localOnly ? "Localhost only" : localNetwork ? "Local network only" : "Remote",
    exposedBeyondLocalNetwork: Boolean(enabled && !localOnly && !localNetwork),
    requireAuthenticatedAccount: Boolean(state.settings.requireAuthenticatedAccountForRemoteAccess),
    requireTrustedDevice: Boolean(state.settings.requireTrustedDeviceForRemoteAccess),
    autoDisableMs: state.settings.remoteAccessAutoDisableMs || 0,
  };
}

function buildRecommendations({ status, sessions, trustedDevices, remoteAccess, token, events, state }) {
  const recommendations = [];
  if (status.accountAuthenticated && status.user?.email && !status.user?.emailConfirmedAt) {
    recommendations.push({
      id: "email-verification-unavailable",
      severity: "info",
      title: "Email verification status unavailable",
      explanation: "Supabase email verification details are not reported to this desktop build.",
      evidence: "Current account session does not include emailConfirmedAt.",
      risk: "Unknown",
      action: "Open Account Page",
      dismissible: true,
      destructive: false,
    });
  }
  const staleSessions = sessions.filter((session) => !session.current && (session.expired || isOlderThan(session.lastActiveAt, 30 * 24 * 60 * 60 * 1000)));
  if (staleSessions.length > 0) {
    recommendations.push({
      id: "revoke-stale-sessions",
      severity: "medium",
      title: "Review stale remembered sessions",
      explanation: "Remembered sessions with old or expired activity can be revoked from this device.",
      evidence: `${staleSessions.length} stale or expired remembered session${staleSessions.length === 1 ? "" : "s"} found.`,
      risk: "Medium",
      action: "Review Sessions",
      dismissible: true,
      destructive: true,
    });
  }
  if (sessions.length > 1 && staleSessions.length === 0) {
    recommendations.push({
      id: "review-active-sessions",
      severity: "low",
      title: "Review remembered sessions",
      explanation: `${sessions.length} sessions are known on this device.`,
      evidence: `${sessions.filter((session) => session.remembered).length} remembered session${sessions.filter((session) => session.remembered).length === 1 ? "" : "s"} reported by the local security store.`,
      risk: "Low",
      action: "Review",
      dismissible: true,
      destructive: false,
    });
  }
  const staleTrustedDevices = trustedDevices.filter((device) => device.trusted && !device.current && isOlderThan(device.lastSeen, 90 * 24 * 60 * 60 * 1000));
  if (staleTrustedDevices.length > 0) {
    recommendations.push({
      id: "remove-unused-trusted-devices",
      severity: "medium",
      title: "Remove unused trusted devices",
      explanation: "Trusted devices with old activity should be reviewed before they keep trusted status.",
      evidence: `${staleTrustedDevices.length} non-current trusted device${staleTrustedDevices.length === 1 ? "" : "s"} have not been active for more than 90 days.`,
      risk: "Medium",
      action: "Review Devices",
      dismissible: true,
      destructive: true,
    });
  }
  if (remoteAccess.exposedBeyondLocalNetwork) {
    recommendations.push({
      id: "remote-access-exposed",
      severity: "high",
      title: "Remote access is exposed beyond the local network",
      explanation: "Review the listening address and disable remote access when you do not need it.",
      evidence: `Reported scope: ${remoteAccess.scope}.`,
      risk: "High",
      action: "Disable Remote Access",
      dismissible: false,
      destructive: true,
    });
  }
  if (!token.configured && remoteAccess.enabled) {
    recommendations.push({
      id: "agent-token-missing",
      severity: "critical",
      title: "Agent token is not configured",
      explanation: "Protected remote-agent routes require a shared token.",
      evidence: "Remote access is enabled and no Agent token is configured.",
      risk: "Critical",
      action: "Generate Token",
      dismissible: false,
      destructive: true,
    });
  }
  const lastRotation = Date.parse(token.lastRotatedAt || token.createdAt || "");
  if (token.configured && Number.isFinite(lastRotation) && Date.now() - lastRotation > 90 * 24 * 60 * 60 * 1000) {
    recommendations.push({
      id: "rotate-old-token",
      severity: "medium",
      title: "Rotate an old agent token",
      explanation: "The current agent token appears older than 90 days.",
      evidence: `Last rotation: ${token.lastRotatedAt || token.createdAt || "not reported"}.`,
      risk: "Medium",
      action: "Rotate Token",
      dismissible: true,
      destructive: true,
    });
  }
  const failedLogins = events.filter((event) => /login/i.test(event.type) && event.result === "failed");
  if (failedLogins.length > 0) {
    recommendations.push({
      id: "failed-signins",
      severity: "medium",
      title: "Review recent failed sign-in attempts",
      explanation: `${failedLogins.length} failed sign-in event${failedLogins.length === 1 ? "" : "s"} found in the recent audit log.`,
      evidence: "Failed local Owner sign-in events are present in the redacted audit log.",
      risk: "Medium",
      action: "Review Events",
      dismissible: true,
      destructive: false,
    });
  }
  if (!state.settings.inactiveSessionExpirationMs) {
    recommendations.push({
      id: "session-expiration",
      severity: "low",
      title: "Configure automatic session expiration",
      explanation: "Inactive sessions are currently not set to expire automatically beyond normal token lifetime.",
      evidence: "Inactive session expiration is set to Never.",
      risk: "Low",
      action: "Configure",
      dismissible: true,
      destructive: false,
    });
  }
  return recommendations;
}

function isOlderThan(value, ageMs) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) && Date.now() - timestamp > ageMs;
}

function getSecurityDashboard(options = {}) {
  const actor = requirePermission("settings:write", "security-dashboard");
  const status = getStatus();
  const state = readSecurityState();
  if (normalizeTrustedDevices(state)) {
    writeSecurityState(state);
  }
  const events = getAuditEvents();
  const sessions = getSessionRows(state, status);
  const trustedDevices = state.trustedDevices.map((device) => ({
    id: publicTargetId("device", device.id),
    name: sanitizeSecurityText(device.name, "Unnamed device", 100),
    platform: sanitizeSecurityText(device.platform, "Unavailable", 100),
    firstSeen: safeIso(device.firstSeen),
    lastSeen: safeIso(device.lastSeen),
    trustExpiresAt: safeIso(device.trustExpiresAt),
    current: device.id === getCurrentDeviceId(),
    trusted: device.trusted !== false,
    activationMethod: sanitizeSecurityText(device.activationMethod || "Local desktop security store", "Unknown", 80),
    relatedSessionCount: sessions.filter((session) => session.deviceId === publicTargetId("device", device.id)).length,
    stale: isOlderThan(device.lastSeen, 90 * 24 * 60 * 60 * 1000),
  }));
  const token = getAgentTokenSummary(state, options);
  const remoteAccess = getRemoteAccessSummary(state, options);
  const recommendations = buildRecommendations({ status, sessions, trustedDevices, remoteAccess, token, events, state });
  const unresolvedWarnings = recommendations.filter((item) => item.severity !== "info" && item.severity !== "low").length;
  const rememberedSessionCount = sessions.filter((session) => !session.runtimeOnly).length;
  const trustedDeviceCount = trustedDevices.filter((device) => device.trusted).length;
  const recentSessionRevocations = events.filter((event) => /session.*revoke|logoutAll/i.test(event.type)).length;
  const recentDeviceActivations = events.filter((event) => /trustedDevice|device/i.test(event.type)).length;
  const overall = unresolvedWarnings >= 2 || recommendations.some((item) => item.severity === "critical")
      ? "Critical"
      : unresolvedWarnings > 0 || recommendations.length > 0
        ? "Needs Attention"
      : "Secure";
  return {
    actor: publicUser(actor),
    overview: {
      status: overall,
      signedInAccount: status.user?.username || "This Device",
      deviceTrustState: trustedDevices.find((device) => device.current)?.trusted ? "Trusted" : "Untrusted",
      activeSessionCount: sessions.length,
      remoteAccessStatus: remoteAccess.enabled ? remoteAccess.scope : "Disabled",
      agentTokenStatus: token.configured ? "Configured" : "Missing",
      lastSecurityEvent: events[0] || null,
      unresolvedWarnings,
      rememberedSessionCount,
      trustedDeviceCount,
      recentSessionRevocations,
      recentDeviceActivations,
      accountProviderConfiguration: status.accountAuthenticated ? "Configured" : status.ownerAccountConfigured ? "Owner allowlist configured" : "Local-only",
      securitySensitiveOperations: ["Agent token rotation", "Session revocation", "Trusted-device removal"],
      diagnosticsIssues: events.filter((event) => event.diagnosticIssue).slice(0, 5).map((event) => event.diagnosticIssue),
    },
    accountProtection: {
      provider: status.accountAuthenticated ? "AnxOS Account" : status.authenticated ? "Local owner" : "Not signed in",
      emailVerification: status.accountAuthenticated ? "Unavailable" : "Not connected",
      sessionExpiration: state.settings.inactiveSessionExpirationMs
        ? `${Math.round(state.settings.inactiveSessionExpirationMs / 86400000)} day${Math.round(state.settings.inactiveSessionExpirationMs / 86400000) === 1 ? "" : "s"}`
        : "Not configured",
      requireReauthForSensitiveActions: Boolean(state.settings.requireReauthForSensitiveActions),
      rememberedSessionCount,
      trustedDeviceCount,
      ownerAuthorization: status.ownerWorkspaceAvailable ? "Authorized" : status.ownerAccountConfigured ? "Configured, not authorized" : "Not configured",
    },
    permissions: [
      {
        id: "account",
        name: status.user?.account ? "AnxOS account" : "Local owner session",
        state: status.user?.account ? "Connected" : status.authenticated ? "Active" : "Unavailable",
        detail: status.user?.username || "No signed-in account reported.",
      },
      {
        id: "role",
        name: "Current role",
        state: status.user?.role || "Local",
        detail: status.ownerWorkspaceAvailable ? "Owner Workspace access is authorized." : "Owner-only tools remain locked unless authorization is granted.",
      },
      {
        id: "security",
        name: "Security controls",
        state: status.authenticated ? "Allowed" : "Locked",
        detail: "Session, trusted-device, and token actions are validated by the main process.",
      },
      {
        id: "remote-agent",
        name: "Remote Agent access",
        state: remoteAccess.enabled ? remoteAccess.scope : "Disabled",
        detail: remoteAccess.enabled
          ? "Remote access follows the authenticated-account and trusted-device requirements shown above."
          : "Remote Agent routes are not enabled for this target.",
      },
      {
        id: "marketplace-files",
        name: "Marketplace and Files",
        state: status.authenticated || !status.setupRequired ? "Available" : "Locked",
        detail: "Marketplace, Files, and node actions still validate node and Agent boundaries before running.",
      },
      {
        id: "owner-workspace",
        name: "Owner Workspace",
        state: status.ownerWorkspaceAvailable ? "Allowed" : "Locked",
        detail: "Owner-only workspace commands are checked again by main-process authorization.",
      },
    ],
    recommendations,
    sessions,
    trustedDevices,
    remoteAccess,
    agentToken: token,
    authentication: {
      emailVerification: status.accountAuthenticated ? "Unavailable" : "Not connected",
      twoFactor: "Not reported",
      passwordLastChangedAt: null,
      accountRecovery: status.accountAuthenticated ? "Manage on account website" : "Not connected",
      recentFailedSignIns: events.filter((event) => /login/i.test(event.type) && event.result === "failed").length,
      sessionTimeoutMs: state.settings.inactiveSessionExpirationMs || 0,
      lockOwnerWorkspaceAfterInactivity: Boolean(state.settings.lockOwnerWorkspaceAfterInactivity),
      requireReauthForSensitiveActions: Boolean(state.settings.requireReauthForSensitiveActions),
    },
    events,
    auditPath: getAuditPath(),
  };
}

function getAuditFolderForOpen() {
  requirePermission("settings:write", "audit-log");
  return path.dirname(getAuditPath());
}

function checkRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const bucket = rateBuckets.get(key) || [];
  const active = bucket.filter((timestamp) => now - timestamp < windowMs);
  active.push(now);
  rateBuckets.set(key, active);

  if (active.length > limit) {
    const error = new Error("Too many requests. Try again shortly.");
    error.code = "RATE_LIMITED";
    throw error;
  }
}

function getRateLimitState(key, windowMs) {
  const now = Date.now();
  const active = (rateBuckets.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  rateBuckets.set(key, active);
  return {
    key,
    count: active.length,
    windowMs,
  };
}

function recordRateLimitAttempt(key, limit, windowMs, details = {}) {
  const now = Date.now();
  const active = (rateBuckets.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
  active.push(now);
  rateBuckets.set(key, active);
  console.warn("[Security] Rate-limit attempt recorded.", {
    key,
    count: active.length,
    limit,
    windowMs,
    reason: details.reason || null,
  });
  if (active.length > limit) {
    const error = new Error("Too many requests. Try again shortly.");
    error.code = "RATE_LIMITED";
    console.warn("[Security] Rate limit triggered.", {
      key,
      count: active.length,
      limit,
      windowMs,
      reason: details.reason || null,
    });
    throw error;
  }
}

function resetRateLimit(key, reason = "reset") {
  if (rateBuckets.delete(key)) {
    console.info("[Security] Rate-limit bucket reset.", { key, reason });
  }
}

function normalizeUsername(value) {
  const username = String(value || "").trim();
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) {
    const error = new Error("Use a username with 3-40 letters, numbers, dots, dashes, or underscores.");
    error.code = "INVALID_USERNAME";
    throw error;
  }
  return username;
}

function normalizeRole(value, fallback = "User") {
  const role = String(value || fallback).trim();
  if (!Object.prototype.hasOwnProperty.call(ROLE_PERMISSIONS, role)) {
    const error = new Error("Invalid role.");
    error.code = "INVALID_ROLE";
    throw error;
  }
  return role;
}

function validatePassword(value) {
  const password = String(value || "");
  if (password.length < PASSWORD_MIN_LENGTH) {
    const error = new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
    error.code = "WEAK_PASSWORD";
    throw error;
  }
  return password;
}

function validateProductionOwnerPassword(password) {
  if (isTrustedDevelopmentMode()) {
    return;
  }
  const normalized = String(password || "");
  if (normalized === DEVELOPMENT_FALLBACK_OWNER_PASSWORD) {
    const error = new Error("Choose a stronger owner password.");
    error.code = "WEAK_PASSWORD";
    throw error;
  }
  if (/^(password|admin|owner|anxos|qwerty|letmein|123456|1234567890)$/i.test(normalized) || /^(\d)\1+$/.test(normalized)) {
    const error = new Error("Choose a stronger owner password.");
    error.code = "WEAK_PASSWORD";
    throw error;
  }
}

function getStatus() {
  const user = getCurrentUser();
  const accountSession = getCurrentAccountSession();
  const accountUser = accountSessionToSecurityUser(accountSession);
  const state = readSecurityState();
  if (pruneExpiredPersistentSessions(state)) {
    writeSecurityState(state);
  }
  const hasAdminUser = state.users.some((entry) => entry.role === "Owner" || entry.role === "Admin");
  const localMode = !hasAdminUser;
  const recovery = authRecovery.getState();
  if (!recovery.lockedRecoverable) {
    authRecovery.enterLocked({ setupRequired: !hasAdminUser });
    if (user) {
      authRecovery.enterUnlocked({ provider: "local-owner" });
    } else if (accountUser && hasAdminUser) {
      authRecovery.enterLocalCredentialsLocked({ reason: "node_credentials_unavailable" });
    }
  }
  const localOwnerAuthenticated = Boolean(user && authRecovery.getState().authenticated);
  return {
    setupRequired: !hasAdminUser,
    localMode,
    remoteControlEnabled: hasAdminUser,
    authenticated: Boolean(user || accountUser),
    user: user || accountUser,
    accountAuthenticated: Boolean(accountUser),
    localOwnerAuthenticated,
    roles: Object.keys(ROLE_PERMISSIONS),
    permissions: (user || accountUser) ? ROLE_PERMISSIONS[(user || accountUser).role] || [] : localMode ? ["local:*"] : [],
    ownerWorkspaceAvailable: Boolean((user || accountUser)?.role === "Owner" && (user || accountUser)?.ownerAuthorized !== false),
    ownerAccountConfigured: Boolean(getConfiguredOwnerAccounts().userIds.length || getConfiguredOwnerAccounts().emails.length),
    trustedDevelopmentMode: isTrustedDevelopmentMode(),
    agentTokenConfigured: Boolean(readAgentSettings().agentToken || getAgentConfig().token),
    persistentSession: Boolean(currentSession?.persistent),
    persistentSessionCount: state.persistentSessions.length,
    securityPath: getSecurityPath(),
    auditPath: getAuditPath(),
    authState: authRecovery.getState().state,
    recoveryRequired: authRecovery.getState().lockedRecoverable,
    recoveryMessage: authRecovery.getState().message,
    recoveryReason: authRecovery.getState().reason,
  };
}

async function setupAdmin(payload = {}) {
  checkRateLimit("setup-admin", 5, 10 * 60 * 1000);
  const state = readSecurityState();
  if (state.users.some((entry) => entry.role === "Owner" || entry.role === "Admin")) {
    const error = new Error("Security setup is already complete.");
    error.code = "SETUP_COMPLETE";
    throw error;
  }

  const username = normalizeUsername(payload.username || "owner");
  const rawPassword = String(payload.password || "");
  const developmentPassword = getDevelopmentOwnerPassword();
  const password = developmentPassword && rawPassword === developmentPassword ? rawPassword : validatePassword(rawPassword);
  if (payload.passwordConfirm !== undefined && String(payload.passwordConfirm || "") !== password) {
    const error = new Error("Password confirmation does not match.");
    error.code = "PASSWORD_CONFIRMATION_MISMATCH";
    throw error;
  }
  validateProductionOwnerPassword(password);
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = {
    id: crypto.randomUUID(),
    username,
    role: "Owner",
    passwordHash,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastLoginAt: null,
  };

  state.users.push(user);
  writeSecurityState(state);
  audit({ action: "security.setup", outcome: "ok", actor: publicUser(user) });
  return login({ username, password, staySignedIn: payload.staySignedIn });
}

async function login(payload = {}) {
  authRecovery.enterUnlocking();
  const username = normalizeUsername(payload.username);
  const activeUser = getCurrentUser();
  if (activeUser?.username?.toLowerCase() === username.toLowerCase() && currentSession && !authRecovery.getState().lockedRecoverable) {
    console.info("[Security] Login request ignored because the user is already signed in.", {
      username,
      persistent: currentSession.persistent === true,
    });
    return {
      token: currentSession.token,
      expiresAt: new Date(currentSession.expiresAt).toISOString(),
      persistent: currentSession.persistent === true,
      user: activeUser,
    };
  }

  const rateLimitKey = `login:${username.toLowerCase()}`;
  const rateLimitWindowMs = 5 * 60 * 1000;
  const rateLimitLimit = 6;
  const rateLimitState = getRateLimitState(rateLimitKey, rateLimitWindowMs);
  console.info("[Security] Login attempt started.", {
    username,
    failedAttemptCount: rateLimitState.count,
    limit: rateLimitLimit,
    staySignedIn: payload.staySignedIn === true,
  });
  if (rateLimitState.count >= rateLimitLimit) {
    console.warn("[Security] Login blocked by rate limit before credential check.", {
      username,
      failedAttemptCount: rateLimitState.count,
      limit: rateLimitLimit,
    });
    const error = new Error("Too many requests. Try again shortly.");
    error.code = "RATE_LIMITED";
    throw error;
  }
  const state = readSecurityState();
  const user = state.users.find((entry) => String(entry?.username || "").toLowerCase() === username.toLowerCase());
  logOwnerAuthDiagnostic("provider-selected", {
    ownerExists: Boolean(user),
    username: user?.username || username,
  });
  const password = String(payload.password || "");
  const developmentPassword = getDevelopmentOwnerPassword();
  const devFallbackOk = !user && state.users.length === 0 && username.toLowerCase() === "anx" && developmentPassword && password === developmentPassword;
  const hashFormat = getPasswordHashFormat(user?.passwordHash);
  const disabled = Boolean(user?.disabled === true || user?.enabled === false);
  let hashMatches = false;
  if (user && !disabled && hashFormat === "bcrypt") {
    try { hashMatches = await bcrypt.compare(password, user.passwordHash); } catch {}
  }
  const ok = devFallbackOk || hashMatches;

  if (!isTrustedDevelopmentMode() && !user && password === DEVELOPMENT_FALLBACK_OWNER_PASSWORD) {
    logOwnerAuthDiagnostic("authentication-failed", {
      ownerExists: false,
      username,
      failureReason: "DEVELOPMENT_FALLBACK_DISABLED",
      hashFormat,
    });
    diagnostics.log("warn", "authentication", "local-owner-login", "Local Owner authentication failed", { username: user?.username || username, ownerExists: Boolean(user), failureReason, hashFormat }, { file: "auth", errorCode: failureReason });
    audit({ action: "security.login", outcome: "failed", target: username, reason: "DEFAULT_DEV_PASSWORD_REJECTED" });
    recordRateLimitAttempt(rateLimitKey, rateLimitLimit, rateLimitWindowMs, { reason: "INVALID_CREDENTIALS" });
    const error = new Error("Invalid username or password. This is the local owner account for this device, not an online Anx account.");
    error.code = "INVALID_CREDENTIALS";
    throw error;
  }

  if (!ok) {
    const failureReason = !user ? "USER_MISSING" : disabled ? "ACCOUNT_DISABLED" : hashFormat !== "bcrypt" ? "HASH_FORMAT_UNSUPPORTED" : "HASH_MISMATCH";
    logOwnerAuthDiagnostic("authentication-failed", {
      ownerExists: Boolean(user),
      username: user?.username || username,
      failureReason,
      hashFormat,
    });
    audit({ action: "security.login", outcome: "failed", target: username, reason: "INVALID_CREDENTIALS" });
    recordRateLimitAttempt(rateLimitKey, rateLimitLimit, rateLimitWindowMs, { reason: "INVALID_CREDENTIALS" });
    const error = new Error("Invalid username or password. This is the local owner account for this device, not an online Anx account.");
    error.code = "INVALID_CREDENTIALS";
    throw error;
  }

  resetRateLimit(rateLimitKey, "successful-login");
  logOwnerAuthDiagnostic("authentication-succeeded", {
    ownerExists: Boolean(user),
    username: user?.username || username,
    hashFormat,
  });
  diagnostics.log("info", "authentication", "local-owner-login", "Local Owner authentication succeeded", { username: user?.username || username, provider: "local-owner" }, { file: "auth" });

  const authenticatedUser = user || {
    id: "development-owner",
    username: "Anx",
    role: "Owner",
    passwordHash: "development-runtime-only",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastLoginAt: new Date().toISOString(),
  };

  if (user) {
    user.lastLoginAt = new Date().toISOString();
    user.updatedAt = new Date().toISOString();
    pruneExpiredPersistentSessions(state);
  }
  let persistentSession = null;
  if (payload.staySignedIn === true && user) {
    persistentSession = await createPersistentSession(state, user);
  } else {
    removePersistentSessionFile();
  }
  if (user) {
    writeSecurityState(state);
  }
  const expiresAt = persistentSession
    ? Date.parse(persistentSession.expiresAt)
    : Date.now() + (state.settings.sessionTtlMs || SESSION_TTL_MS);
  createRuntimeSession(authenticatedUser, expiresAt, Boolean(persistentSession), persistentSession?.id || null);
  if (devFallbackOk) {
    currentSession.developmentOwner = true;
    currentSession.userSnapshot = publicUser(authenticatedUser);
  }
  audit({ action: "security.login", outcome: "ok", actor: publicUser(authenticatedUser), reason: devFallbackOk ? "DEVELOPMENT_OWNER_FALLBACK" : null });
  const recovery = completeLocalOwnerRecovery();
  authRecovery.enterUnlocked({ provider: "local-owner" });

  return {
    token: currentSession.token,
    expiresAt: new Date(currentSession.expiresAt).toISOString(),
    persistent: Boolean(persistentSession),
    user: publicUser(authenticatedUser),
    authState: authRecovery.getState().state,
    warning: recovery.warning || null,
  };
}

function logout() {
  const actor = getCurrentUser();
  const persistentSessionId = currentSession?.persistentSessionId || null;
  if (persistentSessionId) {
    const state = readSecurityState();
    state.persistentSessions = state.persistentSessions.filter((entry) => entry.id !== persistentSessionId);
    writeSecurityState(state);
    removePersistentSessionFile();
  }
  currentSession = null;
  audit({ action: "security.logout", outcome: "ok", actor });
  return { ok: true };
}

function logoutAllSessions() {
  const actor = requirePermission("settings:write", "security-sessions");
  const state = readSecurityState();
  state.persistentSessions = [];
  writeSecurityState(state);
  removePersistentSessionFile();
  currentSession = null;
  audit({ action: "security.sessions.logoutAll", outcome: "ok", actor });
  return { ok: true };
}

function userHasPermission(user, permission) {
  if (!permission) {
    return true;
  }

  if (!user) {
    return false;
  }

  const permissions = ROLE_PERMISSIONS[user.role] || [];
  return permissions.includes("*") || permissions.includes(permission);
}

function requirePermission(permission, target = null, options = {}) {
  if (options.localCredentials !== false) {
    authRecovery.requireUnlocked(target || permission);
  }
  const status = getStatus();
  if (status.accountAuthenticated && status.user?.role === "Owner" && status.user?.ownerAuthorized === true) {
    return {
      ...status.user,
      permissions: ["*"],
    };
  }

  if (status.setupRequired) {
    return {
      id: "local-device",
      username: "This Device",
      role: "Local",
      localMode: true,
      permissions: ["local:*"],
    };
  }

  if (!status.user) {
    const error = new Error("Sign in to continue.");
    error.code = "LOGIN_REQUIRED";
    throw error;
  }

  if (!userHasPermission(status.user, permission)) {
    audit({ action: "security.permission", outcome: "denied", target, reason: permission });
    const error = new Error("Your role does not allow this action.");
    error.code = "PERMISSION_DENIED";
    throw error;
  }

  return status.user;
}

function requireOwner(target = "owner-workspace") {
  authRecovery.requireUnlocked(target);
  const status = getStatus();
  if (!status.user || status.user.role !== "Owner" || (status.user.account === true && status.user.ownerAuthorized !== true)) {
    audit({ action: "security.ownerWorkspace", outcome: "denied", target, reason: "OWNER_REQUIRED" });
    const error = new Error("Owner access is required.");
    error.code = "OWNER_REQUIRED";
    throw error;
  }
  return status.user;
}

function requireLocalOwnerAuthenticated(target = "protected-local-action", message = "Unlock AnxOS to continue.") {
  authRecovery.requireLocalCredentialsUnlocked(target, message);
  const status = getStatus();
  if (!status.localOwnerAuthenticated) {
    const error = new Error(message);
    error.code = "AUTH_UNLOCK_REQUIRED";
    error.friendlyMessage = message;
    throw error;
  }
  return status.user;
}

function allowReadCompatibility() {
  const status = getStatus();
  return status.setupRequired || status.authenticated;
}

function rotateAgentToken() {
  const actor = requirePermission("settings:write", "agent-token");
  checkRateLimit("agent-token-rotate", 10, 10 * 60 * 1000);
  const current = readAgentSettings();
  const rotated = rotateAgentSettingsToken(current);
  const state = readSecurityState();
  state.agentTokens = state.agentTokens || {};
  state.agentTokens[rotated.fingerprint] = {
    createdAt: state.agentTokens[rotated.fingerprint]?.createdAt || new Date().toISOString(),
    lastRotatedAt: new Date().toISOString(),
    lastUsedAt: null,
    scope: current.backendMode === "agent" ? "Remote agent" : "Local device",
    associatedDevice: current.agentUrl || "This Device",
  };
  writeSecurityState(state);
  audit({ action: "agent.token.rotate", outcome: "ok", actor, target: getAgentConfigPath() });
  return {
    configured: true,
    fingerprint: rotated.fingerprint,
    restartRequired: true,
    message: "Agent token rotated. Restart the AnxOS agent and desktop app so both reload the shared token.",
  };
}

function revokePersistentSession(sessionId) {
  const actor = requirePermission("settings:write", "security-session");
  const target = String(sessionId || "");
  if (!target || target === "runtime-current") {
    const error = new Error("This session cannot be revoked from the session list.");
    error.code = "INVALID_SESSION";
    throw error;
  }
  const state = readSecurityState();
  const resolvedTarget = resolvePersistentSessionId(state, target);
  if (!resolvedTarget) {
    const error = new Error("Session was not found or has already been revoked.");
    error.code = "SESSION_NOT_FOUND";
    throw error;
  }
  const before = state.persistentSessions.length;
  state.persistentSessions = state.persistentSessions.filter((entry) => entry.id !== resolvedTarget);
  if (state.persistentSessions.length === before) {
    const error = new Error("Session was not found.");
    error.code = "SESSION_NOT_FOUND";
    throw error;
  }
  writeSecurityState(state);
  if (currentSession?.persistentSessionId === resolvedTarget) {
    currentSession = null;
    removePersistentSessionFile();
  }
  audit({ action: "security.session.revoke", outcome: "ok", actor, target: publicTargetId("session", resolvedTarget) });
  return getSecurityDashboard();
}

function revokeOtherSessions() {
  const actor = requirePermission("settings:write", "security-sessions");
  const currentId = currentSession?.persistentSessionId || null;
  const state = readSecurityState();
  state.persistentSessions = currentId
    ? state.persistentSessions.filter((entry) => entry.id === currentId)
    : [];
  writeSecurityState(state);
  audit({ action: "security.sessions.revokeOther", outcome: "ok", actor });
  return getSecurityDashboard();
}

function removeTrustedDevice(deviceId) {
  const actor = requirePermission("settings:write", "trusted-device");
  const target = String(deviceId || "");
  if (!target) {
    const error = new Error("Device ID is required.");
    error.code = "DEVICE_REQUIRED";
    throw error;
  }
  const state = readSecurityState();
  normalizeTrustedDevices(state);
  const resolvedTarget = resolveTrustedDeviceId(state, target);
  if (!resolvedTarget) {
    const error = new Error("Trusted device was not found or has already been removed.");
    error.code = "DEVICE_NOT_FOUND";
    throw error;
  }
  const existing = state.trustedDevices.find((device) => device.id === resolvedTarget);
  if (existing?.trusted === false) {
    const error = new Error("Trusted device was already removed.");
    error.code = "DEVICE_ALREADY_REMOVED";
    throw error;
  }
  state.trustedDevices = state.trustedDevices.map((device) => (
    device.id === resolvedTarget ? { ...device, trusted: false, removedAt: new Date().toISOString() } : device
  ));
  writeSecurityState(state);
  audit({ action: "security.trustedDevice.remove", outcome: "ok", actor, target: publicTargetId("device", resolvedTarget) });
  return getSecurityDashboard();
}

function renameTrustedDevice(deviceId, name) {
  const actor = requirePermission("settings:write", "trusted-device");
  const target = String(deviceId || "");
  const nextName = String(name || "").trim().slice(0, 80);
  if (!target || !nextName) {
    const error = new Error("Device ID and name are required.");
    error.code = "DEVICE_RENAME_INVALID";
    throw error;
  }
  const state = readSecurityState();
  normalizeTrustedDevices(state);
  const resolvedTarget = resolveTrustedDeviceId(state, target);
  const device = state.trustedDevices.find((entry) => entry.id === resolvedTarget);
  if (!device) {
    const error = new Error("Device was not found.");
    error.code = "DEVICE_NOT_FOUND";
    throw error;
  }
  device.name = nextName;
  device.updatedAt = new Date().toISOString();
  writeSecurityState(state);
  audit({ action: "security.trustedDevice.rename", outcome: "ok", actor, target: publicTargetId("device", resolvedTarget) });
  return getSecurityDashboard();
}

function updateSessionSecuritySettings(payload = {}) {
  const actor = requirePermission("settings:write", "security-settings");
  const state = readSecurityState();
  const inactiveSessionExpirationMs = Number.parseInt(payload.inactiveSessionExpirationMs, 10);
  if (!SESSION_TIMEOUT_OPTIONS_MS.has(inactiveSessionExpirationMs)) {
    const error = new Error("Unsupported session expiration setting.");
    error.code = "INVALID_SESSION_TIMEOUT";
    throw error;
  }
  state.settings.inactiveSessionExpirationMs = inactiveSessionExpirationMs;
  state.settings.lockOwnerWorkspaceAfterInactivity = payload.lockOwnerWorkspaceAfterInactivity !== false;
  state.settings.requireReauthForSensitiveActions = payload.requireReauthForSensitiveActions !== false;
  writeSecurityState(state);
  audit({ action: "security.settings.update", outcome: "ok", actor, target: "session-expiration" });
  return getSecurityDashboard();
}

function updateRemoteAccessSettings(payload = {}) {
  const actor = requirePermission("settings:write", "remote-access");
  const state = readSecurityState();
  state.settings.requireAuthenticatedAccountForRemoteAccess = payload.requireAuthenticatedAccount === true;
  state.settings.requireTrustedDeviceForRemoteAccess = payload.requireTrustedDevice === true;
  state.settings.remoteAccessAutoDisableMs = Number.parseInt(payload.autoDisableMs, 10) || 0;
  writeSecurityState(state);
  audit({ action: "security.remoteAccess.settings", outcome: "ok", actor });
  return getSecurityDashboard();
}

function disableRemoteAccess() {
  const actor = requirePermission("settings:write", "remote-access");
  const current = readAgentSettings();
  const { saveAgentSettings } = require("./agentClient");
  saveAgentSettings({
    backendMode: "local",
    agentUrl: current.agentUrl,
    agentToken: current.agentToken,
  });
  audit({ action: "security.remoteAccess.disable", outcome: "ok", actor });
  return getSecurityDashboard();
}

function revokeAgentToken() {
  const actor = requirePermission("settings:write", "agent-token");
  checkRateLimit("agent-token-revoke", 6, 10 * 60 * 1000);
  const { saveAgentSettings } = require("./agentClient");
  const current = readAgentSettings();
  const fingerprint = tokenFingerprint(current.agentToken);
  saveAgentSettings({
    backendMode: current.backendMode,
    agentUrl: current.agentUrl,
    agentToken: "",
  });
  audit({ action: "agent.token.revoke", outcome: "ok", actor, target: fingerprint });
  return getSecurityDashboard();
}

function generateReplacementAgentToken() {
  return rotateAgentToken();
}

function lockOwnerWorkspace() {
  const actor = requireOwner("owner-workspace-lock");
  audit({ action: "security.ownerWorkspace.lock", outcome: "ok", actor });
  return { ok: true, locked: true };
}

function emergencySecurityAction(action, confirmation = "") {
  const actor = requirePermission("settings:write", "security-emergency");
  if (String(confirmation || "").trim() !== "SECURE ANXOS") {
    const error = new Error("Type SECURE ANXOS to confirm this action.");
    error.code = "CONFIRMATION_REQUIRED";
    throw error;
  }
  const normalized = String(action || "");
  if (normalized === "sign-out-all") {
    return logoutAllSessions();
  }
  if (normalized === "revoke-agent-tokens") {
    return revokeAgentToken();
  }
  if (normalized === "remove-trusted-devices") {
    const state = readSecurityState();
    normalizeTrustedDevices(state);
    state.trustedDevices = state.trustedDevices.map((device) => ({ ...device, trusted: false, removedAt: new Date().toISOString() }));
    writeSecurityState(state);
    audit({ action: "security.trustedDevices.removeAll", outcome: "ok", actor });
    return getSecurityDashboard();
  }
  if (normalized === "disable-remote-access") {
    return disableRemoteAccess();
  }
  if (normalized === "lock-owner-workspace") {
    return lockOwnerWorkspace();
  }
  if (normalized === "reset-local-security") {
    const state = readSecurityState();
    state.persistentSessions = [];
    state.trustedDevices = [];
    writeSecurityState(state);
    removePersistentSessionFile();
    audit({ action: "security.localState.reset", outcome: "ok", actor });
    return getSecurityDashboard();
  }
  const error = new Error("Unsupported emergency security action.");
  error.code = "UNSUPPORTED_SECURITY_ACTION";
  throw error;
}

module.exports = {
  SECURITY_SCHEMA_VERSION,
  _test: {
    encryptLocalSession,
    getPasswordHashFormat,
    migrateLegacyOwnerUsers,
    normalizeSecurityState,
    parsePersistentSessionRecord,
    readPersistentSessionFile,
    writePersistentSessionFile,
  },
  audit,
  checkRateLimit,
  disableRemoteAccess,
  emergencySecurityAction,
  generateReplacementAgentToken,
  getAuditFolderForOpen,
  getSecurityDashboard,
  getStatus,
  login,
  logout,
  logoutAllSessions,
  lockOwnerWorkspace,
  removeTrustedDevice,
  requirePermission,
  requireLocalOwnerAuthenticated,
  requireOwner,
  renameTrustedDevice,
  revokeAgentToken,
  revokeOtherSessions,
  revokePersistentSession,
  rotateAgentToken,
  setupAdmin,
  updateRemoteAccessSettings,
  updateSessionSecuritySettings,
  allowReadCompatibility,
};
