const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const packageJson = require("../../package.json");
const {
  generateAgentToken,
  isWeakAgentToken,
  tokenFingerprint,
  writeAgentConfigToken,
} = require("../../../src/shared/agentTokenStore");
const { getDeviceIdentity, getIdentityPath, rotateAgentIdentityGeneration } = require("./deviceIdentityService");
const { logger } = require("./diagnosticsLogger");

// V2-A enrollment contract (docs/v2/V2A_DECISIONS.md Decision 1,
// docs/v2/V2A_AGENT_ENROLLMENT.md §3). The persisted record binds exactly one
// tuple: device identity, pinned instance root, protocol/API versions, and the
// agent token fingerprint. Only fingerprints are stored — never raw tokens.
const ENROLLMENT_SCHEMA_VERSION = 1;
const ENROLL_NONCE_TTL_MS = 5 * 60 * 1000;
const ENROLL_NONCE_MAX_ACTIVE = 20;
const { sanitizeForDiagnostics } = require("../../../src/shared/redaction");
const SUPPORTED_PROTOCOL_VERSIONS = new Set([1]);
const SUPPORTED_API_MAJOR_VERSIONS = new Set([1]);
const AGENT_STATE_UNENROLLED = "unenrolled";
const AGENT_STATE_PENDING = "pending";
const AGENT_STATE_ENROLLED = "enrolled";
const AGENT_STATE_REVOKED = "revoked";

let pendingNonce = null;
let enrollmentIdCounter = 0;

function getEnrollmentPath() {
  const base = process.env.ANXHUB_CONFIG_DIR || path.join(process.cwd(), "config");
  return process.env.AGENT_ENROLLMENT_PATH
    || path.join(base, "enrollment.json");
}

function readEnrollmentRecord() {
  const filePath = getEnrollmentPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed;
  } catch (error) {
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    throw Object.assign(new Error("Agent enrollment record is unreadable. The original file was preserved; re-enrollment is required."), {
      code: "ENROLLMENT_RECORD_CORRUPT",
      details: { causeCode: error?.code || "INVALID_JSON" },
    });
  }
}

function writeEnrollmentRecord(record) {
  const filePath = getEnrollmentPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify({ ...record, schemaVersion: ENROLLMENT_SCHEMA_VERSION }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function newEnrollmentId() {
  enrollmentIdCounter += 1;
  return `enr-${crypto.randomUUID()}`;
}

function compareVersions(left, right) {
  const parse = (value) => String(value || "").split(/[.-]/).map((part) => Number.parseInt(part, 10)).map((part) => (Number.isFinite(part) ? part : 0));
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function enrollmentError(code, message, statusCode, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, details });
}

// ---------------------------------------------------------------------------
// Spawn contract (Decision 1): ANXHUB_CONFIG_DIR is the single canonical
// identity + config source. A desktop-spawned agent always receives it.
// A legacy standalone install points it at %APPDATA%\AnxHub\config. A bare
// standalone start has none. Legacy and standalone starts get a loud,
// actionable diagnostic — they must never silently adopt a stray root.
// ---------------------------------------------------------------------------
const LEGACY_ANXHUB_PATTERN = /(^|[\\/])AnxHub([\\/]|$)/i;

function evaluateSpawnEnvironment(env = process.env) {
  const configDir = String(env.ANXHUB_CONFIG_DIR || "").trim();
  if (!configDir) {
    return {
      spawnContract: "standalone",
      canonical: false,
      configDir: null,
      diagnostic: "[AnxOS Agent] Agent was not started by AnxOS Control Center: ANXHUB_CONFIG_DIR is not set. "
        + "This agent must be enrolled before it can be trusted, and its identity/config location may fall back to a stray directory. "
        + "Start the Agent from the Control Center desktop app, or set ANXHUB_CONFIG_DIR (and AGENT_INSTANCE_ROOT / AGENT_IDENTITY_PATH) explicitly to the canonical AnxOS config directory.",
    };
  }
  if (LEGACY_ANXHUB_PATTERN.test(configDir)) {
    return {
      spawnContract: "legacy-anxhub",
      canonical: false,
      configDir,
      diagnostic: "[AnxOS Agent] Agent is using a legacy AnxHub config directory instead of the canonical AnxOS config directory. "
        + "This binding is auto-migrated into the enrollment record, but the installation should be started from the current AnxOS Control Center so ANXHUB_CONFIG_DIR points at the canonical location.",
    };
  }
  return { spawnContract: "desktop", canonical: true, configDir, diagnostic: null };
}

function emitSpawnDiagnostic(assessment) {
  if (!assessment?.diagnostic) return;
  const loud = assessment.spawnContract === "standalone" ? console.error : console.warn;
  try {
    (assessment.spawnContract === "standalone"
      ? (message, payload) => logger.error("enrollment", message, payload, { file: "enrollment" })
      : (message, payload) => logger.warn("enrollment", message, payload, { file: "enrollment" })
    )("Agent spawn contract diagnostic", { spawnContract: assessment.spawnContract, diagnostic: assessment.diagnostic });
  } catch {
    // Logging must never block startup.
  }
  loud(assessment.diagnostic);
}

// ---------------------------------------------------------------------------
// Nonce store: single active short-TTL nonce for /enroll/complete. Single-use;
// a replayed nonce is a distinct error (ENROLL_NONCE_REUSED). Signed nonces
// are deferred per docs/v2/V2A_DECISIONS.md.
// ---------------------------------------------------------------------------
function clearExpiredNonce(now = Date.now()) {
  if (pendingNonce && Date.parse(pendingNonce.expiresAt) <= now) {
    pendingNonce = null;
  }
}

function issueEnrollNonce() {
  clearExpiredNonce();
  // The store holds a single active nonce; older pending sessions are
  // invalidated by issuing a new one, which keeps the surface minimal.
  const nonce = {
    value: crypto.randomBytes(32).toString("base64url"),
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ENROLL_NONCE_TTL_MS).toISOString(),
    used: false,
  };
  pendingNonce = nonce;
  return nonce;
}

function consumeEnrollNonce(supplied) {
  clearExpiredNonce();
  const value = String(supplied || "").trim();
  if (!value || !pendingNonce) {
    throw enrollmentError("ENROLL_NONCE_INVALID", "No active enrollment session. Start a new enrollment first.", 401);
  }
  if (Date.parse(pendingNonce.expiresAt) <= Date.now()) {
    pendingNonce = null;
    throw enrollmentError("ENROLL_NONCE_EXPIRED", "The enrollment nonce expired. Start a new enrollment.", 410);
  }
  const matches = value.length === pendingNonce.value.length
    && crypto.timingSafeEqual(Buffer.from(value), Buffer.from(pendingNonce.value));
  if (!matches) {
    // An unknown nonce is distinct from a replay of the real one: replays of
    // the correct nonce fall through to the single-use check below.
    throw enrollmentError("ENROLL_NONCE_INVALID", "The enrollment nonce was rejected. Start a new enrollment.", 401);
  }
  if (pendingNonce.used) {
    throw enrollmentError("ENROLL_NONCE_REUSED", "This enrollment nonce was already used. Start a new enrollment.", 409);
  }
  pendingNonce.used = true;
  return true;
}

// ---------------------------------------------------------------------------
// Handshake steps
// ---------------------------------------------------------------------------
function startEnrollment(body = {}) {
  const minProtocol = Number(body?.minProtocolVersion);
  const maxProtocol = Number(body?.maxProtocolVersion ?? minProtocol);
  const hasProtocolWindow = Number.isFinite(minProtocol) && Number.isFinite(maxProtocol)
    ? minProtocol <= 1 && maxProtocol >= 1
    : true;
  if (!hasProtocolWindow) {
    throw enrollmentError("PROTOCOL_VERSION_UNSUPPORTED", "This agent does not support the requested protocol version.", 400, {
      supportedProtocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
      agentProtocolVersion: 1,
    });
  }
  const minimumAgentVersion = String(body?.minimumAgentVersion || "").trim();
  if (minimumAgentVersion && compareVersions(packageJson.version, minimumAgentVersion) < 0) {
    throw enrollmentError("AGENT_VERSION_INCOMPATIBLE", "The agent runtime is older than the minimum version required by the client.", 400, {
      agentVersion: packageJson.version,
      minimumAgentVersion,
    });
  }
  const nonce = issueEnrollNonce();
  return {
    statusCode: 200,
    body: {
      status: AGENT_STATE_PENDING,
      protocolVersion: 1,
      apiMajorVersion: 1,
      agentVersion: packageJson.version,
      enrollNonce: nonce.value,
      enrollNonceExpiresAt: nonce.expiresAt,
      identity: getDeviceIdentity(),
    },
  };
}

function resolvePinnedInstanceRoot(body, config) {
  const pinned = String(body?.instanceRoot || "").trim();
  if (!pinned) return { pinned: null, root: config.instanceRoot };
  const resolvedPinned = path.resolve(pinned);
  const actual = path.resolve(config.instanceRoot || "");
  if (resolvedPinned === actual) return { pinned: resolvedPinned, root: config.instanceRoot };
  const allowedFolders = (Array.isArray(config.allowedFolders) ? config.allowedFolders : []).map((entry) => path.resolve(String(entry)));
  const withinAllowed = allowedFolders.some((entry) => resolvedPinned === entry || resolvedPinned.startsWith(`${entry}${path.sep}`));
  if (!withinAllowed) {
    throw enrollmentError("INSTANCE_ROOT_MISMATCH", "The pinned instance root does not match the agent's configured root and is outside the agent's allowed folders.", 409, {
      pinnedRoot: sanitizeForDiagnostics({ pinnedRoot: resolvedPinned }).pinnedRoot || "redacted",
      configuredRootSource: config.instanceRootSource || null,
    });
  }
  // Explicit override allowed only while the nonce is fresh — completion runs
  // immediately after /enroll/start, so freshness is guaranteed by the nonce.
  return { pinned: resolvedPinned, root: config.instanceRoot, pinnedRootOverride: resolvedPinned };
}

function completeEnrollment(body = {}, config = {}) {
  consumeEnrollNonce(body?.enrollNonce);
  const rawToken = String(body?.agentToken || body?.permanentToken || "").trim();
  if (!rawToken || rawToken.length < 32 || isWeakAgentToken(rawToken)) {
    throw enrollmentError("ENROLL_CREDENTIAL_INVALID", "The enrollment credential was missing or invalid.", 400);
  }
  const pin = resolvePinnedInstanceRoot(body, config);
  const configPath = config.tokenStatus?.configPath;
  if (!configPath) {
    throw enrollmentError("ENROLL_CONFIG_PATH_MISSING", "The agent token config path is unavailable; enrollment cannot bind credentials.", 500);
  }
  const identity = getDeviceIdentity();
  const previous = readEnrollmentRecord();
  const previousFingerprints = [...(previous?.previousFingerprints || [])];
  if (previous?.state === AGENT_STATE_ENROLLED && previous?.tokenFingerprint) {
    // Re-enrollment revokes the previous binding: the old fingerprint is kept
    // only as history, and the identity generation rotates so re-pair is
    // unambiguous (docs/v2/V2A_IDENTITY_MODEL.md §3.4).
    previousFingerprints.push(previous.tokenFingerprint);
    rotateAgentIdentityGeneration();
  }
  const updatedIdentity = getDeviceIdentity();
  const record = {
    schemaVersion: ENROLLMENT_SCHEMA_VERSION,
    state: AGENT_STATE_ENROLLED,
    enrollmentId: newEnrollmentId(),
    // Which agent this binding belongs to: multiple agents may share one
    // ANXHUB_CONFIG_DIR while keeping per-agent identity files, so the
    // binding must record the identity path it was minted against.
    identityPath: getIdentityPath(),
    nodeIdentity: {
      deviceId: updatedIdentity.deviceId,
      hostname: updatedIdentity.hostname,
      platform: updatedIdentity.platform,
      architecture: updatedIdentity.architecture,
      agentVersion: updatedIdentity.agentVersion,
    },
    agentInstallationId: updatedIdentity.agentInstallationId,
    agentIdentityGeneration: updatedIdentity.agentIdentityGeneration,
    instanceRoot: pin.root,
    ...(pin.pinnedRootOverride ? { pinnedInstanceRoot: pin.pinnedRootOverride } : {}),
    protocolVersion: 1,
    apiMajorVersion: 1,
    tokenFingerprint: tokenFingerprint(rawToken),
    previousFingerprints,
    enrolledAtIso: new Date().toISOString(),
    legacyMigrated: false,
    revokedAtIso: null,
    revokeReason: null,
  };
  writeAgentConfigToken(configPath, rawToken, {
    backendMode: "agent",
    agentUrl: String(body?.agentUrl || "").trim() || undefined,
  });
  config.token = rawToken;
  config.tokenStatus = {
    ...(config.tokenStatus || {}),
    configured: true,
    source: "enrollment",
    fingerprint: record.tokenFingerprint,
  };
  writeEnrollmentRecord(record);
  return {
    statusCode: 200,
    body: {
      status: AGENT_STATE_ENROLLED,
      enrollmentId: record.enrollmentId,
      identity: updatedIdentity,
      instanceRoot: record.instanceRoot,
      protocolVersion: record.protocolVersion,
      apiMajorVersion: record.apiMajorVersion,
      tokenFingerprint: record.tokenFingerprint,
    },
  };
}

// Auto-migrate an existing persisted shared token (current session) into an
// enrolled record so the enrollment upgrade does not break running installs.
// A fresh generated token is NOT auto-enrolled; it stays unenrolled.
function migrateLegacyBinding(config = {}) {
  const existing = readEnrollmentRecord();
  if (existing && [AGENT_STATE_ENROLLED, AGENT_STATE_PENDING, AGENT_STATE_REVOKED].includes(existing.state)) {
    return { migrated: false, reason: existing.state === AGENT_STATE_PENDING ? "pending" : "record-exists", record: existing };
  }
  const tokenStatus = config.tokenStatus || {};
  if (tokenStatus.source !== "shared-config" || !tokenStatus.fingerprint || !config.token) {
    return { migrated: false, reason: "no-persisted-credential", record: existing };
  }
  const identity = getDeviceIdentity();
  const record = {
    schemaVersion: ENROLLMENT_SCHEMA_VERSION,
    state: AGENT_STATE_ENROLLED,
    enrollmentId: newEnrollmentId(),
    identityPath: getIdentityPath(),
    nodeIdentity: {
      deviceId: identity.deviceId,
      hostname: identity.hostname,
      platform: identity.platform,
      architecture: identity.architecture,
      agentVersion: identity.agentVersion,
    },
    agentInstallationId: identity.agentInstallationId,
    agentIdentityGeneration: identity.agentIdentityGeneration,
    instanceRoot: config.instanceRoot,
    protocolVersion: 1,
    apiMajorVersion: 1,
    tokenFingerprint: tokenStatus.fingerprint,
    previousFingerprints: [],
    enrolledAtIso: new Date().toISOString(),
    legacyMigrated: true,
    revokedAtIso: null,
    revokeReason: null,
  };
  writeEnrollmentRecord(record);
  return { migrated: true, record };
}

// Post-enrollment drift detection: identity, credential, and instance root
// must all still match the pinned tuple. A mismatch drops the agent to
// unenrolled and refuses authenticated use with NODE_BINDING_MISMATCH.
function assertEnrollmentBinding(config = {}) {
  const record = readEnrollmentRecord();
  if (!record) return null;
  if (record.state === AGENT_STATE_REVOKED) {
    throw enrollmentError("REVOKED", "This agent enrollment was revoked. Re-enroll this Agent from Control Center.", 410, {
      enrollmentId: record.enrollmentId || null,
      revokedAtIso: record.revokedAtIso || null,
    });
  }
  if (record.state !== AGENT_STATE_ENROLLED) return record;
  // Foreign binding: multiple agents may share one ANXHUB_CONFIG_DIR while
  // keeping per-agent identity files. If the persisted binding was minted
  // against a DIFFERENT identity path, it is simply not this agent's
  // enrollment — treat this agent as unenrolled (loud diagnostic) and never
  // mutate the shared record, which would clobber the other agent's binding.
  // Tamper detection is preserved: a record bound to THIS identity path whose
  // deviceId/root/fingerprint no longer match still drifts with 453 below.
  const boundIdentityPath = record.identityPath ? path.resolve(record.identityPath) : null;
  const ownIdentityPath = path.resolve(getIdentityPath());
  if (boundIdentityPath && boundIdentityPath !== ownIdentityPath) {
    console.warn("[AnxOS Agent] Shared config directory holds an enrollment bound to a different Agent identity; this agent is treated as unenrolled.", {
      boundIdentityPath: record.identityPath,
      ownIdentityPath: getIdentityPath(),
      enrollmentId: record.enrollmentId || null,
    });
    return null;
  }
  const identity = getDeviceIdentity();
  const fingerprint = config.tokenStatus?.fingerprint || tokenFingerprint(config.token);
  const rootMatches = record.instanceRoot
    ? path.resolve(record.instanceRoot) === path.resolve(config.instanceRoot || "")
    : true;
  const identityMatches = record.nodeIdentity?.deviceId === identity.deviceId;
  const fingerprintMatches = record.tokenFingerprint && fingerprint === record.tokenFingerprint;
  // Credential self-heal: the desktop legitimately rotates the shared token
  // outside the agent (node re-pair / credential repair writes the config
  // directly). A request that already authenticated against the agent's
  // CURRENT config token is a legitimate rotation, not drift — sync the
  // binding fingerprint (keeping the old one as history) instead of refusing
  // with 453. A token that matches NEITHER the binding NOR the current config
  // cannot reach here, because auth.js would have rejected it first.
  if (!fingerprintMatches && fingerprint && config.token && fingerprint === tokenFingerprint(config.token)) {
    const healed = {
      ...record,
      previousFingerprints: [...(record.previousFingerprints || []), record.tokenFingerprint].filter(Boolean),
      tokenFingerprint: fingerprint,
      credentialSyncedAtIso: new Date().toISOString(),
    };
    writeEnrollmentRecord(healed);
    return healed;
  }
  if (rootMatches && identityMatches && fingerprintMatches) return record;
  writeEnrollmentRecord({
    ...record,
    state: AGENT_STATE_UNENROLLED,
    driftReason: !fingerprintMatches ? "token-fingerprint" : !identityMatches ? "device-identity" : "instance-root",
    driftedAtIso: new Date().toISOString(),
  });
  throw enrollmentError("NODE_BINDING_MISMATCH", "The agent no longer matches its enrolled binding. Re-enroll this Agent.", 453, {
    driftReason: !fingerprintMatches ? "token-fingerprint" : !identityMatches ? "device-identity" : "instance-root",
  });
}

function rotateEnrollmentCredential(config = {}) {
  const record = readEnrollmentRecord();
  if (!record || record.state !== AGENT_STATE_ENROLLED) {
    throw enrollmentError("NO_ACTIVE_ENROLLMENT", "Credential rotation requires an enrolled agent.", 409);
  }
  const configPath = config.tokenStatus?.configPath;
  if (!configPath) {
    throw enrollmentError("ENROLL_CONFIG_PATH_MISSING", "The agent token config path is unavailable; rotation cannot proceed.", 500);
  }
  const previousFingerprint = record.tokenFingerprint;
  const token = generateAgentToken();
  writeAgentConfigToken(configPath, token, {
    backendMode: "agent",
    agentUrl: undefined,
  });
  const rotatedIdentity = rotateAgentIdentityGeneration();
  const updated = {
    ...record,
    tokenFingerprint: tokenFingerprint(token),
    previousFingerprints: [...(record.previousFingerprints || []), previousFingerprint].filter(Boolean),
    agentIdentityGeneration: rotatedIdentity.agentIdentityGeneration,
    rotatedAtIso: new Date().toISOString(),
  };
  writeEnrollmentRecord(updated);
  config.token = token;
  config.tokenStatus = {
    ...(config.tokenStatus || {}),
    configured: true,
    source: "enrollment",
    fingerprint: updated.tokenFingerprint,
  };
  return {
    statusCode: 200,
    body: {
      token,
      tokenFingerprint: updated.tokenFingerprint,
      previousFingerprint,
      agentIdentityGeneration: updated.agentIdentityGeneration,
      restartRequired: false,
    },
  };
}

function revokeEnrollment(config = {}, options = {}) {
  if (options?.confirmRevoke !== true) {
    throw enrollmentError("REVOKE_CONFIRMATION_REQUIRED", "Revocation is permanent and requires an explicit confirmation.", 400);
  }
  const record = readEnrollmentRecord();
  if (!record || record.state !== AGENT_STATE_ENROLLED) {
    throw enrollmentError("NO_ACTIVE_ENROLLMENT", "There is no active enrollment to revoke.", 409);
  }
  const revoked = {
    ...record,
    state: AGENT_STATE_REVOKED,
    revokedAtIso: new Date().toISOString(),
    revokeReason: String(options?.reason || "").trim().slice(0, 200) || "owner-revoked",
    tokenFingerprint: null,
  };
  writeEnrollmentRecord(revoked);
  return {
    statusCode: 200,
    body: {
      status: AGENT_STATE_REVOKED,
      state: AGENT_STATE_REVOKED,
      enrollmentId: revoked.enrollmentId,
      revokedAtIso: revoked.revokedAtIso,
      reEnrollRequired: true,
    },
  };
}

// Public-safe status summary: never includes the token, the raw root, or
// private path details. The fingerprint is the same public value health
// already exposes.
function enrollmentStatusSummary(config = {}) {
  const record = readEnrollmentRecord();
  const state = record?.state || AGENT_STATE_UNENROLLED;
  const body = {
    status: state,
    state,
    enrollmentId: record?.enrollmentId || null,
    enrolledAtIso: record?.enrolledAtIso || null,
    legacyMigrated: Boolean(record?.legacyMigrated),
    revokedAtIso: record?.revokedAtIso || null,
    driftReason: record?.driftReason || null,
    tokenFingerprint: record?.state === AGENT_STATE_ENROLLED ? record.tokenFingerprint : null,
    identity: getDeviceIdentity(),
  };
  return { statusCode: 200, body };
}

module.exports = {
  AGENT_STATE_ENROLLED,
  AGENT_STATE_PENDING,
  AGENT_STATE_REVOKED,
  AGENT_STATE_UNENROLLED,
  ENROLLMENT_SCHEMA_VERSION,
  assertEnrollmentBinding,
  completeEnrollment,
  enrollmentStatusSummary,
  evaluateSpawnEnvironment,
  emitSpawnDiagnostic,
  getEnrollmentPath,
  migrateLegacyBinding,
  readEnrollmentRecord,
  revokeEnrollment,
  rotateEnrollmentCredential,
  startEnrollment,
};
