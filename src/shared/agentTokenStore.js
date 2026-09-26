const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { decideMigrationRecovery, verifyRecoveryPoint } = require("./migrationRecoveryPolicy");

const WEAK_AGENT_TOKENS = new Set(["test-token", "AnxOS-Token", "anxos-token", ""]);
const AGENT_CONFIG_SCHEMA_VERSION = 1;
const DEFAULT_AGENT_CONFIG = {
  backendMode: "local",
  agentUrl: "http://127.0.0.1:47131",
  agentToken: "",
};

function trimValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function isWeakAgentToken(value) {
  return WEAK_AGENT_TOKENS.has(trimValue(value));
}

function generateAgentToken() {
  return `anxos_${crypto.randomBytes(32).toString("base64url")}`;
}

function tokenFingerprint(value) {
  const token = trimValue(value);
  if (!token) return null;
  return crypto.createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function base64UrlEncodeJson(payload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function base64UrlDecodeJson(value) {
  try {
    return JSON.parse(Buffer.from(String(value || "").trim(), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

// Ownership-preserving atomic replace. A root-run CLI (`anxos-agent unpair`)
// rewrites a config file owned by the service user; creating the temp file as
// root and renaming it over the target silently changed the target's owner to
// root, and the service user then got EACCES on its own config
// (AGENT_CONFIG_CORRUPT on the next pairing/enrollment write). When the target
// already exists, hand the temp file the target's uid/gid before the rename so
// ownership survives. POSIX-only: without process.getuid (Windows) there is no
// ownership to preserve, and a non-root writer that cannot chown keeps the
// pre-existing rename behavior instead of failing the write. The temp file's
// 0600 mode is set at creation and chown does not alter it.
function preserveTargetOwnership(tempPath, targetPath) {
  if (typeof process.getuid !== "function") return false;
  let targetStat;
  try {
    targetStat = fs.statSync(targetPath);
  } catch {
    return false;
  }
  try {
    fs.chownSync(tempPath, targetStat.uid, targetStat.gid);
    return true;
  } catch {
    return false;
  }
}

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  preserveTargetOwnership(tempPath, filePath);
  fs.renameSync(tempPath, filePath);
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean).map((value) => path.resolve(value))));
}

function getCandidateConfigPaths(options = {}) {
  const cwd = options.cwd || process.cwd();
  return unique([
    options.configPath,
    process.env.ANXHUB_AGENT_CONFIG_PATH,
    process.env.ANXHUB_CONFIG_DIR ? path.join(process.env.ANXHUB_CONFIG_DIR, "agent.json") : null,
    options.configDir ? path.join(options.configDir, "agent.json") : null,
    path.join(cwd, "config", "agent.json"),
    path.join(cwd, "..", "config", "agent.json"),
    path.join(cwd, "agent.json"),
  ]);
}

function resolveAgentConfigPath(options = {}) {
  const candidates = getCandidateConfigPaths(options);
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0] || path.join(process.cwd(), "config", "agent.json");
}

function readAgentConfigFile(configPath) {
  if (!fs.existsSync(configPath)) return { ...DEFAULT_AGENT_CONFIG, schemaVersion: AGENT_CONFIG_SCHEMA_VERSION };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Agent config root must be an object.");
  } catch (error) {
    const backupPath = `${configPath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    throw Object.assign(new Error("Agent configuration is unreadable. The original file was preserved; credentials were not rotated."), {
      code: "AGENT_CONFIG_CORRUPT",
      details: { causeCode: error?.code || "INVALID_JSON" },
    });
  }
  const schemaVersion = Number.isInteger(parsed.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > AGENT_CONFIG_SCHEMA_VERSION) {
    throw Object.assign(new Error("Agent configuration was created by a newer runtime version."), {
      code: "AGENT_CONFIG_SCHEMA_UNSUPPORTED",
      details: { schemaVersion, supportedSchemaVersion: AGENT_CONFIG_SCHEMA_VERSION },
    });
  }
  const config = { ...DEFAULT_AGENT_CONFIG, ...parsed, schemaVersion: AGENT_CONFIG_SCHEMA_VERSION };
  if (schemaVersion < AGENT_CONFIG_SCHEMA_VERSION) {
    const backupPath = `${configPath}.schema-v${schemaVersion}.backup`;
    const originalBytes = fs.readFileSync(configPath);
    const backupExisted = fs.existsSync(backupPath);
    if (!backupExisted) fs.copyFileSync(configPath, backupPath, fs.constants.COPYFILE_EXCL);
    // V2-J bullet 6: the rewrite below only runs behind a recovery point that
    // was read back and verified. An unverified copy is refused, not warned
    // past. The stored Agent token cannot be rebuilt from anywhere else.
    let recoveryBytes = null;
    try {
      recoveryBytes = fs.readFileSync(backupPath);
    } catch {
      recoveryBytes = null;
    }
    const recoveryVerification = verifyRecoveryPoint({ mode: "bytes", original: originalBytes, copy: recoveryBytes });
    const recoveryTaken = fs.existsSync(backupPath);
    const recoveryVerdict = decideMigrationRecovery({
      storeId: "agent-config",
      fromSchemaVersion: schemaVersion,
      toSchemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
      recoveryPoint: { canTake: true, taken: recoveryTaken, verified: recoveryVerification.verified },
      reconstructible: { isReconstructible: false, source: null },
    });
    if (recoveryVerdict.verdict !== "proceed") {
      if (!backupExisted && recoveryTaken) {
        try { fs.rmSync(backupPath, { force: true }); } catch {}
      }
      throw Object.assign(new Error("Agent configuration could not be migrated safely because the pre-migration recovery point could not be verified."), {
        code: "AGENT_CONFIG_MIGRATION_RECOVERY_UNVERIFIED",
        details: { storeId: "agent-config", reason: recoveryVerdict.reason, verification: recoveryVerification.reason },
      });
    }
    atomicWriteJson(configPath, config);
  }
  return config;
}

function writeAgentConfigToken(configPath, token, updates = {}) {
  const current = readAgentConfigFile(configPath);
  const next = {
    ...current,
    ...updates,
    schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
    agentToken: token,
  };
  atomicWriteJson(configPath, next);
  return next;
}

function writeAgentConfigSettings(configPath, settings = {}) {
  const current = readAgentConfigFile(configPath);
  const next = {
    ...current,
    ...settings,
    schemaVersion: AGENT_CONFIG_SCHEMA_VERSION,
  };
  atomicWriteJson(configPath, next);
  return next;
}

function resolveSharedAgentToken(options = {}) {
  const configPath = resolveAgentConfigPath(options);
  const config = readAgentConfigFile(configPath);
  const storedToken = trimValue(config.agentToken);
  const environmentToken = trimValue(options.environmentToken ?? process.env.AGENT_TOKEN);
  const usableStoredToken = storedToken && !isWeakAgentToken(storedToken) ? storedToken : "";
  const usableEnvironmentToken = environmentToken && !isWeakAgentToken(environmentToken) ? environmentToken : "";
  const weakStoredTokenReplaced = Boolean(storedToken && isWeakAgentToken(storedToken));
  const weakEnvironmentTokenIgnored = Boolean(environmentToken && isWeakAgentToken(environmentToken));
  const shouldWrite = options.write !== false;

  let token = usableStoredToken;
  let source = usableStoredToken ? "shared-config" : "generated";

  if (!token && usableEnvironmentToken) {
    token = usableEnvironmentToken;
    source = "environment-bootstrap";
  }

  if (!token) {
    token = generateAgentToken();
    source = "generated";
  }

  // Provenance of the credential itself, distinct from this run's resolution
  // source: a token generated on a previous start still resolves as
  // "shared-config", so the origin must be read back from the persisted config.
  // "generated" is what keeps a self-generated credential unenrolled across
  // restarts (see enrollmentService.migrateLegacyBinding).
  const persistedTokenOrigin = trimValue(config.tokenOrigin) || null;
  const tokenOrigin = source === "generated"
    ? "generated"
    : source === "environment-bootstrap"
      ? null
      : persistedTokenOrigin;

  if (shouldWrite && (!usableStoredToken || weakStoredTokenReplaced || storedToken !== token)) {
    const updates = {
      backendMode: config.backendMode || DEFAULT_AGENT_CONFIG.backendMode,
      agentUrl: config.agentUrl || DEFAULT_AGENT_CONFIG.agentUrl,
    };
    if (source === "generated") {
      updates.tokenOrigin = "generated";
    } else if (source === "environment-bootstrap") {
      // The stored credential is being replaced by an environment bootstrap, so
      // any previous provenance no longer describes the current credential. An
      // absent value keeps the legacy migration behavior for env-bootstrap
      // installs; `undefined` drops the key from the serialized config.
      updates.tokenOrigin = undefined;
    }
    // source === "shared-config": the credential is unchanged, so its persisted
    // provenance (whatever it is, including "generated") is left untouched.
    writeAgentConfigToken(configPath, token, updates);
  }

  const envTokenPresent = Boolean(environmentToken);
  const envTokenMatches = envTokenPresent ? environmentToken === token : null;
  const envTokenConflict = Boolean(envTokenPresent && usableEnvironmentToken && usableStoredToken && environmentToken !== token);

  return {
    token,
    configPath,
    source,
    tokenOrigin,
    configured: Boolean(token),
    generated: source === "generated",
    environmentTokenPresent: envTokenPresent,
    environmentTokenMatches: envTokenMatches === null ? null : Boolean(envTokenMatches),
    environmentTokenConflict: envTokenConflict,
    environmentTokenIgnored: Boolean(envTokenConflict || weakEnvironmentTokenIgnored),
    weakStoredTokenReplaced,
    weakEnvironmentTokenIgnored,
    fingerprint: tokenFingerprint(token),
  };
}

function rotateSharedAgentToken(options = {}) {
  const configPath = resolveAgentConfigPath(options);
  const token = generateAgentToken();
  // A rotation is a desktop/operator-owned credential unless the caller states
  // otherwise; an explicit `updates.tokenOrigin` overrides this default.
  writeAgentConfigToken(configPath, token, { tokenOrigin: "desktop-rotation", ...(options.updates || {}) });
  return {
    token,
    configPath,
    fingerprint: tokenFingerprint(token),
    restartRequired: true,
  };
}

function createAgentPairingPayload(options = {}) {
  const status = resolveSharedAgentToken({
    configPath: options.configPath,
    configDir: options.configDir,
    cwd: options.cwd,
    environmentToken: options.environmentToken,
  });
  const config = readAgentConfigFile(status.configPath);
  const agentUrl = trimValue(options.agentUrl || config.agentUrl) || DEFAULT_AGENT_CONFIG.agentUrl;
  const expiresAt = new Date(Date.now() + (Number.parseInt(options.ttlMs, 10) || 15 * 60 * 1000)).toISOString();
  const payload = {
    type: "anxos-agent-pairing",
    version: 1,
    agentUrl,
    agentToken: status.token,
    fingerprint: status.fingerprint,
    issuedAt: new Date().toISOString(),
    expiresAt,
  };
  return {
    code: `ANXOS-PAIR.${base64UrlEncodeJson(payload)}`,
    fingerprint: status.fingerprint,
    agentUrl,
    expiresAt,
    configPath: status.configPath,
  };
}

function parseAgentPairingPayload(value) {
  const raw = String(value || "").trim();
  const encoded = raw.startsWith("ANXOS-PAIR.") ? raw.slice("ANXOS-PAIR.".length) : raw;
  const payload = base64UrlDecodeJson(encoded);
  if (!payload || payload.type !== "anxos-agent-pairing" || payload.version !== 1) {
    const error = new Error("Invalid AnxOS Agent pairing code.");
    error.code = "PAIRING_CODE_INVALID";
    throw error;
  }
  if (!trimValue(payload.agentUrl) || !trimValue(payload.agentToken) || isWeakAgentToken(payload.agentToken)) {
    const error = new Error("Pairing code is missing required Agent connection data.");
    error.code = "PAIRING_CODE_INCOMPLETE";
    throw error;
  }
  if (payload.expiresAt && Date.parse(payload.expiresAt) <= Date.now()) {
    const error = new Error("Pairing code expired. Generate a new code on the Agent machine.");
    error.code = "PAIRING_CODE_EXPIRED";
    throw error;
  }
  const fingerprint = tokenFingerprint(payload.agentToken);
  if (payload.fingerprint && payload.fingerprint !== fingerprint) {
    const error = new Error("Pairing code fingerprint does not match its token.");
    error.code = "PAIRING_CODE_TAMPERED";
    throw error;
  }
  return {
    agentUrl: trimValue(payload.agentUrl),
    agentToken: trimValue(payload.agentToken),
    fingerprint,
    issuedAt: payload.issuedAt || null,
    expiresAt: payload.expiresAt || null,
  };
}

module.exports = {
  AGENT_CONFIG_SCHEMA_VERSION,
  DEFAULT_AGENT_CONFIG,
  generateAgentToken,
  createAgentPairingPayload,
  getCandidateConfigPaths,
  isWeakAgentToken,
  parseAgentPairingPayload,
  preserveTargetOwnership,
  resolveAgentConfigPath,
  resolveSharedAgentToken,
  rotateSharedAgentToken,
  tokenFingerprint,
  readAgentConfigFile,
  writeAgentConfigSettings,
  writeAgentConfigToken,
};
