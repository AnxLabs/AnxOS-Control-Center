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
const { normalizeApiScopes, resolveAgentNodeId } = require("../permissions");
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
// V2-I bullet 3: optional credential scopes.
//
// An enrollment (re-pair) may carry an optional scope envelope:
//   scopes: { nodeIds?: string[], families?: string[] }
// It is persisted additively on the enrollment record (no schemaVersion bump).
// Re-pairing WITHOUT scopes clears them: completeEnrollment always writes a
// fresh record, so absent scopes => unscoped (full profile permissions).
// `nodeId` (singular, the documented grant spelling) is accepted as an alias
// for `nodeIds`. Malformed scope shapes are refused fail-closed.
// ---------------------------------------------------------------------------
function parseEnrollmentScopes(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw enrollmentError("ENROLL_SCOPE_INVALID", "Enrollment scopes must be an object with optional nodeIds/families arrays.", 400);
  }
  for (const key of ["nodeIds", "nodeId", "families"]) {
    if (raw[key] === undefined || raw[key] === null) continue;
    const list = Array.isArray(raw[key]) ? raw[key] : [raw[key]];
    const valid = list.every((entry) => (typeof entry === "string" || typeof entry === "number") && String(entry).trim());
    if (!valid) {
      throw enrollmentError("ENROLL_SCOPE_INVALID", `Enrollment scope "${key}" must contain only non-empty strings.`, 400, { field: key });
    }
  }
  return normalizeApiScopes(raw);
}

// Resolves the scope context for the CURRENT persisted enrollment so the
// request path can enforce it. A missing/legacy record yields an unscoped
// context (null scopes), which preserves pre-V2-I behavior exactly.
function resolveEnrollmentScopeContext() {
  let record = null;
  try {
    record = readEnrollmentRecord();
  } catch {
    // A corrupt record is surfaced by the enrollment binding gate; scope
    // resolution must not turn every request into a distinct failure.
    return { scopes: null, nodeId: null };
  }
  if (!record) return { scopes: null, nodeId: null };
  const deviceId = record.nodeIdentity?.deviceId || null;
  return {
    scopes: normalizeApiScopes(record.scopes),
    nodeId: deviceId ? resolveAgentNodeId(deviceId) : null,
  };
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

// ---------------------------------------------------------------------------
// Security hardening (V2-I): re-pairing an EXISTING, non-revoked enrollment must
// prove possession of a credential the agent already trusts. Completion refuses
// unless the caller presents either the credential on the record
// (record.tokenFingerprint) or the agent's LIVE credential (config.token).
//
// The live credential is accepted because that is what the legitimate repair
// flow needs: the desktop pairs the node (nodeService.pairNodeFromCode ->
// POST /api/v1/pairing/complete), which rotates the shared config token, and then
// completes enrollment with the rotated credential. The persisted record
// fingerprint stays stale until the binding self-heals, so a record-bound-only
// gate refuses that legitimate re-pair — scripts/multi-node-fleet-smoke.js
// exercises the exact sequence and fails against a record-bound gate (verified:
// 403 where it asserts 200).
//
// RESIDUAL — PROVEN, NOT FIXED HERE. This gate is defense-in-depth, NOT an
// authorization boundary. /api/v1/pairing/start is pre-auth and hands the
// pairing code back to the same caller, and /api/v1/pairing/complete sets
// config.token to a caller-chosen value, so an unauthenticated client that can
// reach the agent port can install a credential and then satisfy the live
// credential branch. An independent adversarial review reproduced that end to
// end: a control re-pair without pairing was refused 403, while the
// pair-then-enroll sequence succeeded 200 and rebound the record's
// tokenFingerprint with caller-chosen scopes. Closing it requires an
// authorization decision on the pairing surface itself (pairing must not be
// usable by the same unauthenticated caller who redeems it), tracked in the
// security queue of docs/v2/V2_CAMPAIGN_QUEUES.md.
//
// First enrollment (no record) stays open — that is the bootstrap path.
// Re-enrollment after revocation stays open — that is the recovery path — and is
// recorded as a distinct audit event so revoke-then-reenroll is visible.
// ---------------------------------------------------------------------------
const ENROLL_REPAIR_REQUIRES_EXISTING_CREDENTIAL = "ENROLL_REPAIR_REQUIRES_EXISTING_CREDENTIAL";
const ENROLL_REENROLL_AFTER_REVOCATION = "ENROLL_REENROLL_AFTER_REVOCATION";
const ENROLL_REPAIR_AUTHORIZED = "ENROLL_REPAIR_AUTHORIZED";

function auditEnrollmentEvent(level, message, code, context = {}) {
  try {
    // Only non-secret metadata (ids, states, modes) is ever passed here; token
    // material is never included in an audit context.
    if (level === "warn") logger.warn("enrollment", message, { ...context, code }, { file: "enrollment", errorCode: code });
    else logger.info("enrollment", message, { ...context, code }, { file: "enrollment", errorCode: code });
  } catch {
    // Audit must never block or alter an enrollment decision.
  }
}

function resolveLiveCredentialFingerprint(config = {}) {
  return tokenFingerprint(config?.token) || config?.tokenStatus?.fingerprint || null;
}

// Read-only: never mutates the enrollment record, so a refused re-pair leaves
// the persisted binding (and its scopes) exactly as it was.
function assertRepairAuthorization(previous, body = {}, config = {}) {
  if (!previous) return { mode: "first-enrollment" };
  if (previous.state === AGENT_STATE_REVOKED) return { mode: "after-revocation" };
  // Record fingerprint plus the live credential: the live branch is what the
  // pair-then-enroll repair flow depends on (see the header comment).
  const trustedFingerprints = new Set([
    previous.tokenFingerprint || null,
    resolveLiveCredentialFingerprint(config),
  ].filter(Boolean));
  const suppliedPrevious = String(body?.previousAgentToken || body?.previousCredential || "").trim();
  const suppliedNew = String(body?.agentToken || body?.permanentToken || "").trim();
  const previousFingerprint = suppliedPrevious ? tokenFingerprint(suppliedPrevious) : null;
  const newFingerprint = suppliedNew ? tokenFingerprint(suppliedNew) : null;
  if (previousFingerprint && trustedFingerprints.has(previousFingerprint)) return { mode: "previous-credential" };
  // Re-presenting the current credential as the new one is also proof of
  // possession (the caller must know the existing token to supply it).
  if (newFingerprint && trustedFingerprints.has(newFingerprint)) return { mode: "presented-credential" };
  auditEnrollmentEvent("warn", "Enrollment re-pair refused: the existing Agent credential is required", ENROLL_REPAIR_REQUIRES_EXISTING_CREDENTIAL, {
    enrollmentId: previous.enrollmentId || null,
    state: previous.state || null,
  });
  throw enrollmentError(
    ENROLL_REPAIR_REQUIRES_EXISTING_CREDENTIAL,
    "This Agent is already enrolled. Re-pairing requires the existing Agent credential; revoke the enrollment first to recover a lost credential.",
    403,
    { enrollmentId: previous.enrollmentId || null, state: previous.state || null },
  );
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
  // Parsed before any mutation so a malformed scope shape fails the request
  // without rotating identity or rewriting the previous binding.
  const scopes = parseEnrollmentScopes(body?.scopes);
  const previous = readEnrollmentRecord();
  // Security P1: an existing, non-revoked enrollment may only be re-paired by a
  // caller proving possession of the existing credential. Evaluated BEFORE any
  // mutation so a refused attempt cannot rotate identity or rewrite the record.
  const repairAuthorization = assertRepairAuthorization(previous, body, config);
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
    // V2-I scopes are additive and optional: only present when the re-pair
    // supplied them, otherwise absent (unscoped => full profile permissions).
    ...(scopes ? { scopes } : {}),
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
  // Positive audit is emitted only after the record is durably written, so the
  // audit trail never claims a re-enrollment that did not happen.
  if (repairAuthorization.mode === "after-revocation") {
    auditEnrollmentEvent("info", "Enrollment completed after revocation (recovery re-enrollment)", ENROLL_REENROLL_AFTER_REVOCATION, {
      previousEnrollmentId: previous?.enrollmentId || null,
      revokedAtIso: previous?.revokedAtIso || null,
      enrollmentId: record.enrollmentId,
    });
  } else if (repairAuthorization.mode === "previous-credential" || repairAuthorization.mode === "presented-credential") {
    auditEnrollmentEvent("info", "Enrollment re-pair authorized by an existing Agent credential", ENROLL_REPAIR_AUTHORIZED, {
      previousEnrollmentId: previous?.enrollmentId || null,
      enrollmentId: record.enrollmentId,
      authorization: repairAuthorization.mode,
    });
  }
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
  parseEnrollmentScopes,
  readEnrollmentRecord,
  resolveEnrollmentScopeContext,
  revokeEnrollment,
  rotateEnrollmentCredential,
  startEnrollment,
};
