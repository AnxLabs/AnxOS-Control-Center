const { createPairingSessionPayload, normalizePairingCode } = require("../../../src/shared/agentPairing");
const { generateAgentToken, tokenFingerprint, writeAgentConfigToken } = require("../../../src/shared/agentTokenStore");
const { AGENT_STATE_ENROLLED, readEnrollmentRecord } = require("../services/enrollmentService");
const { getDeviceIdentity } = require("../services/deviceIdentityService");
const { logger } = require("../services/diagnosticsLogger");

let activeSession = null;
const failedAttempts = new Map();

// ---------------------------------------------------------------------------
// Security P1 (pairing surface): the pairing handshake is pre-auth and
// /pairing/complete installs a caller-chosen credential, so an unauthenticated
// caller who can reach the agent port could otherwise take over an ALREADY
// ENROLLED node: start the session, read the code back (the code is returned to
// the same caller), and complete with a token of their choosing.
//
// Re-pairing an enrolled node therefore requires EITHER
//   (a) a loopback origin — the operator acting on the Agent machine, which is
//       how the desktop repairs a LOCAL node and how `npm run agent:pair` runs, or
//   (b) proof of possession of a credential the agent already trusts: the live
//       credential (config.token / config.tokenStatus.fingerprint) or the one
//       bound on the enrollment record (record.tokenFingerprint).
//
// No record, or a record that is not `enrolled` (pending / unenrolled / revoked),
// stays UNCHANGED: those are the bootstrap and recovery paths, and the first
// pairing of any node must keep working for both local and remote nodes.
//
// The gate is evaluated before any mutation, so a refused request can neither
// create, replace, nor cancel a session. Only fingerprints of the cheap
// comparison are computed; token material is never logged or echoed.
const PAIRING_REQUIRES_EXISTING_CREDENTIAL = "PAIRING_REQUIRES_EXISTING_CREDENTIAL";
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const PAIRING_ROUTE_METHODS = Object.freeze({
  "/api/v1/pairing/status": "GET",
  "/api/v1/pairing/start": "POST",
  "/api/v1/pairing/cancel": "POST",
  "/api/v1/pairing/complete": "POST",
});
// Body fields a caller may use to prove possession of an existing credential.
// Only fingerprint equality against a trusted fingerprint is accepted; the
// values themselves are never logged, returned, or persisted.
const PROOF_BODY_FIELDS = ["previousAgentToken", "previousCredential", "agentToken", "permanentToken"];

function isLoopbackAddress(address) {
  return typeof address === "string" && LOOPBACK_ADDRESSES.has(address);
}

function readHeaderCredential(request) {
  const headers = request?.headers || {};
  const agentToken = Array.isArray(headers["x-agent-token"]) ? headers["x-agent-token"][0] : headers["x-agent-token"];
  if (typeof agentToken === "string" && agentToken.trim()) return agentToken.trim();
  const authorization = Array.isArray(headers.authorization) ? headers.authorization[0] : headers.authorization;
  const match = typeof authorization === "string" ? authorization.match(/^Bearer\s+(.+)$/i) : null;
  return match ? match[1].trim() : "";
}

function readBodyCredentials(request) {
  const raw = request?.body;
  if (typeof raw !== "string" || !raw.trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // An unparseable body proves nothing; the handler's own parse below still
    // reports the malformed request after authorization.
    return [];
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
  return PROOF_BODY_FIELDS.map((field) => String(parsed[field] || "").trim()).filter(Boolean);
}

function trustedCredentialFingerprints(record, config = {}) {
  return new Set([
    tokenFingerprint(config?.token),
    config?.tokenStatus?.fingerprint || null,
    record?.tokenFingerprint || null,
  ].filter(Boolean));
}

// Read-only: never mutates the session or the enrollment record, so a refused
// request leaves both exactly as they were.
function assertPairingAuthorization(request, config = {}) {
  const record = readEnrollmentRecord();
  if (!record || record.state !== AGENT_STATE_ENROLLED) return { mode: "bootstrap-or-recovery" };
  if (isLoopbackAddress(request?.socket?.remoteAddress)) return { mode: "loopback" };
  const trusted = trustedCredentialFingerprints(record, config);
  const presented = [readHeaderCredential(request), ...readBodyCredentials(request)];
  const authorized = presented.some((candidate) => {
    const fingerprint = tokenFingerprint(candidate);
    return Boolean(fingerprint && trusted.has(fingerprint));
  });
  if (authorized) return { mode: "existing-credential" };
  logger.warn("pairing", "Pairing request refused: the existing Agent credential is required", {
    method: request?.method || null,
    // Path only: a query string could carry caller-supplied material, and the
    // audit line must never echo it.
    pathname: String(request?.url || "").split("?")[0] || null,
    code: PAIRING_REQUIRES_EXISTING_CREDENTIAL,
    enrollmentState: record.state,
  }, { file: "pairing", errorCode: PAIRING_REQUIRES_EXISTING_CREDENTIAL });
  const error = new Error(
    "This Agent is already enrolled. Re-pairing it over the network requires the existing Agent credential. "
    + "Run `npm run agent:pair` on the Agent machine (or use AnxOS Control Center on that machine), "
    + "or revoke the enrollment first to recover a lost credential.",
  );
  error.code = PAIRING_REQUIRES_EXISTING_CREDENTIAL;
  error.statusCode = 403;
  throw error;
}

function parseJsonBody(request) {
  try {
    return request.body ? JSON.parse(request.body) : {};
  } catch {
    const error = new Error("Pairing request body must be valid JSON.");
    error.code = "PAIRING_BAD_REQUEST";
    error.statusCode = 400;
    throw error;
  }
}

function getPublicAgentUrl(request, config = {}) {
  const hostHeader = request.headers.host || `${config.host || "127.0.0.1"}:${config.port || 47131}`;
  const scheme = request.socket?.encrypted ? "https" : "http";
  return `${scheme}://${hostHeader}`;
}

function isExpired(session = activeSession) {
  return !session || Date.parse(session.expiresAt || "") <= Date.now();
}

function safeSession(session = activeSession) {
  if (!session || isExpired(session)) {
    return {
      status: session ? "expired" : "not_paired",
      active: false,
      expiresAt: session?.expiresAt || null,
      identity: getDeviceIdentity(),
    };
  }
  return {
    status: "waiting",
    active: true,
    pairingCode: session.pairingCode,
    displayCode: session.displayCode,
    expiresAt: session.expiresAt,
    agentUrl: session.agentUrl,
    identity: getDeviceIdentity(),
  };
}

function assertAttemptAllowed(address) {
  const now = Date.now();
  const attempts = (failedAttempts.get(address) || []).filter((timestamp) => now - timestamp < 60 * 1000);
  if (attempts.length >= 8) {
    const error = new Error("Too many pairing attempts. Wait a moment and try again.");
    error.code = "PAIRING_RATE_LIMITED";
    error.statusCode = 429;
    throw error;
  }
  failedAttempts.set(address, attempts);
}

function recordFailedAttempt(address) {
  const attempts = failedAttempts.get(address) || [];
  attempts.push(Date.now());
  failedAttempts.set(address, attempts);
}

function createSession(request, config = {}) {
  activeSession = createPairingSessionPayload({
    agentUrl: getPublicAgentUrl(request, config),
  });
  return safeSession(activeSession);
}

function completePairing(request, config = {}) {
  const address = request.socket?.remoteAddress || "unknown";
  assertAttemptAllowed(address);
  const body = parseJsonBody(request);
  const suppliedCode = normalizePairingCode(body.pairingCode || body.code || "");
  if (!activeSession || isExpired(activeSession) || suppliedCode !== activeSession.pairingCode) {
    recordFailedAttempt(address);
    const error = new Error("This pairing session is no longer available.");
    error.code = "PAIRING_REJECTED";
    error.statusCode = 401;
    throw error;
  }
  const permanentToken = String(body.permanentToken || body.agentToken || "").trim();
  if (!permanentToken || permanentToken.length < 32) {
    recordFailedAttempt(address);
    const error = new Error("Pairing credential was invalid.");
    error.code = "PAIRING_CREDENTIAL_INVALID";
    error.statusCode = 400;
    throw error;
  }
  const configPath = config.tokenStatus?.configPath;
  writeAgentConfigToken(configPath, permanentToken, {
    backendMode: "agent",
    agentUrl: activeSession.agentUrl,
  });
  config.token = permanentToken;
  config.tokenStatus = {
    ...(config.tokenStatus || {}),
    configured: true,
    source: "pairing",
    fingerprint: tokenFingerprint(permanentToken),
  };
  const pairedSession = activeSession;
  activeSession = null;
  return {
    status: "paired",
    paired: true,
    singleUseInvalidated: true,
    restartRequired: false,
    agentUrl: pairedSession.agentUrl,
    identity: getDeviceIdentity(),
    tokenFingerprint: tokenFingerprint(permanentToken),
  };
}

async function handlePairing(request, url, config = {}) {
  // Security P1: evaluated before any session is created, replaced, or
  // cancelled, so a refused request has no side effect.
  if (PAIRING_ROUTE_METHODS[url.pathname] === request.method) {
    assertPairingAuthorization(request, config);
  }
  if (request.method === "GET" && url.pathname === "/api/v1/pairing/status") {
    return { statusCode: 200, body: safeSession() };
  }
  if (request.method === "POST" && url.pathname === "/api/v1/pairing/start") {
    return { statusCode: 200, body: createSession(request, config) };
  }
  if (request.method === "POST" && url.pathname === "/api/v1/pairing/cancel") {
    activeSession = null;
    return { statusCode: 200, body: { status: "not_paired", active: false, canceled: true } };
  }
  if (request.method === "POST" && url.pathname === "/api/v1/pairing/complete") {
    return { statusCode: 200, body: completePairing(request, config) };
  }
  return null;
}

module.exports = {
  handlePairing,
  PAIRING_REQUIRES_EXISTING_CREDENTIAL,
  _test: {
    assertPairingAuthorization,
    createSession,
    completePairing,
    safeSession,
    reset: () => { activeSession = null; failedAttempts.clear(); },
    generateAgentToken,
  },
};
