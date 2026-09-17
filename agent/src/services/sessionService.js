const crypto = require("crypto");

// V2-A browser surface (docs/v2/V2A_BROWSER_SURFACE_WAVE1.md §3 Option A):
// short-lived in-memory sessions for the authenticated management surface.
// A session is a TRANSPORT credential only — it never widens authorization;
// every request still passes the existing fail-closed permission map. The
// store is bounded and sessions expire absolutely; there is no persistence,
// so an agent restart invalidates every session (fail-closed).

const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_ACTIVE_SESSIONS = 16;
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{43}$/;

// One-time browser bootstrap codes (A2.5): the desktop shows a short-TTL
// code; the browser exchanges it for a session cookie. Single-use, bounded,
// unambiguous charset only.
const BOOTSTRAP_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_BOOTSTRAP_CODES = 5;
const BOOTSTRAP_CODE_PATTERN = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const BOOTSTRAP_CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const sessions = new Map();
const bootstrapCodes = new Map();

function sessionError(code, statusCode, message, details = {}) {
  return Object.assign(new Error(message), { code, statusCode, details });
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (a.length !== b.length) {
    // Compare against itself to keep timing flat for mismatched lengths.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function pruneExpired(now = Date.now()) {
  for (const [token, session] of sessions) {
    if (Date.parse(session.expiresAt) <= now) {
      sessions.delete(token);
    }
  }
}

function issueSession(now = Date.now()) {
  pruneExpired(now);
  if (sessions.size >= MAX_ACTIVE_SESSIONS) {
    throw sessionError("SESSION_LIMIT_REACHED", 429, "Too many active management sessions. Try again shortly.");
  }
  const token = crypto.randomBytes(32).toString("base64url");
  const session = {
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
  };
  sessions.set(token, session);
  return { token, expiresAt: session.expiresAt, ttlMs: SESSION_TTL_MS };
}

function validateSessionToken(supplied, now = Date.now()) {
  const value = String(supplied || "").trim();
  if (!value || !SESSION_ID_PATTERN.test(value)) {
    throw sessionError("UI_SESSION_INVALID", 401, "No valid management session. Authenticate again.");
  }
  const session = sessions.get(value);
  if (!session) {
    // Unknown and malformed tokens report the same generic error.
    throw sessionError("UI_SESSION_INVALID", 401, "No valid management session. Authenticate again.");
  }
  if (Date.parse(session.expiresAt) <= now) {
    sessions.delete(value);
    throw sessionError("UI_SESSION_EXPIRED", 401, "The management session expired. Authenticate again.");
  }
  return { expiresAt: session.expiresAt };
}

function revokeSession(supplied) {
  const value = String(supplied || "").trim();
  return sessions.delete(value);
}

function pruneBootstrapCodes(now = Date.now()) {
  for (const [code, entry] of bootstrapCodes) {
    if (Date.parse(entry.expiresAt) <= now) {
      bootstrapCodes.delete(code);
    }
  }
}

function issueBootstrapCode(now = Date.now()) {
  pruneBootstrapCodes(now);
  if (bootstrapCodes.size >= MAX_ACTIVE_BOOTSTRAP_CODES) {
    throw sessionError("BOOTSTRAP_LIMIT_REACHED", 429, "Too many pending browser bootstrap codes. Try again shortly.");
  }
  const pick = () => BOOTSTRAP_CODE_CHARSET[crypto.randomInt(BOOTSTRAP_CODE_CHARSET.length)];
  const code = `${pick()}${pick()}${pick()}${pick()}-${pick()}${pick()}${pick()}${pick()}`;
  const entry = { expiresAt: new Date(now + BOOTSTRAP_TTL_MS).toISOString() };
  bootstrapCodes.set(code, entry);
  return { code, expiresAt: entry.expiresAt, ttlMs: BOOTSTRAP_TTL_MS };
}

// Single-use: a consumed code is deleted, so a replay is just "unknown".
function consumeBootstrapCode(supplied, now = Date.now()) {
  const code = String(supplied || "").trim().toUpperCase();
  if (!code || !BOOTSTRAP_CODE_PATTERN.test(code)) {
    throw sessionError("UI_BOOTSTRAP_INVALID", 401, "That bootstrap code is not valid. Check Control Center for the current code.");
  }
  const entry = bootstrapCodes.get(code);
  if (!entry || Date.parse(entry.expiresAt) <= now) {
    bootstrapCodes.delete(code);
    throw sessionError("UI_BOOTSTRAP_INVALID", 401, "That bootstrap code is not valid. Check Control Center for the current code.");
  }
  bootstrapCodes.delete(code);
  return { consumed: true, expiresAt: entry.expiresAt };
}

function resetSessionsForTest() {
  sessions.clear();
  bootstrapCodes.clear();
}

module.exports = {
  BOOTSTRAP_CODE_PATTERN,
  BOOTSTRAP_TTL_MS,
  MAX_ACTIVE_BOOTSTRAP_CODES,
  MAX_ACTIVE_SESSIONS,
  SESSION_ID_PATTERN,
  SESSION_TTL_MS,
  consumeBootstrapCode,
  issueBootstrapCode,
  issueSession,
  resetSessionsForTest,
  revokeSession,
  validateSessionToken,
};