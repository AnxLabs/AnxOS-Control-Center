const { issueSession, validateSessionToken } = require("../services/sessionService");

// V2-A browser surface routes (docs/v2/V2A_BROWSER_SURFACE_WAVE1.md Option A).
// POST /api/v1/ui/session — exchange the existing bearer credential for a
// short-lived httpOnly session cookie (transport credential only; the
// fail-closed permission map is unchanged). GET /api/v1/ui/session — validate
// the current session cookie. Neither route is public; bearer auth applies
// upstream for POST, and GET requires a valid cookie by design.

const SESSION_COOKIE_NAME = "anxos_ui_session";

function parseSessionCookie(request) {
  const header = String(request.headers?.cookie || "");
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE_NAME) {
      return rest.join("=");
    }
  }
  return null;
}

function sessionCookieHeader(token, expiresAt) {
  // HttpOnly + SameSite=Strict + explicit expiry; Path scoped to the UI
  // session surface only. Secure is intentionally NOT set — the surface is
  // loopback http by default (V2A brief §4.3); revisit with any exposure change.
  return `${SESSION_COOKIE_NAME}=${token}; Path=/api/v1/ui; HttpOnly; SameSite=Strict; Expires=${new Date(expiresAt).toUTCString()}`;
}

function handleUiSession(request, url) {
  if (request.method === "POST" && url.pathname === "/api/v1/ui/session") {
    const issued = issueSession();
    return {
      statusCode: 200,
      headers: {
        "set-cookie": sessionCookieHeader(issued.token, issued.expiresAt),
      },
      body: {
        status: "active",
        expiresAt: issued.expiresAt,
        ttlMs: issued.ttlMs,
      },
    };
  }
  if (request.method === "GET" && url.pathname === "/api/v1/ui/session") {
    const cookie = parseSessionCookie(request);
    const session = validateSessionToken(cookie);
    return {
      statusCode: 200,
      body: {
        status: "active",
        expiresAt: session.expiresAt,
      },
    };
  }
  return {
    statusCode: 404,
    body: { error: { code: "NOT_FOUND", message: "Request failed." } },
  };
}

function handleUiSessionError(error) {
  return {
    statusCode: error.statusCode || 500,
    body: {
      error: {
        code: error.code || "UI_SESSION_REQUEST_FAILED",
        message: error.message || "Request failed.",
      },
    },
  };
}

module.exports = {
  SESSION_COOKIE_NAME,
  handleUiSession,
  handleUiSessionError,
  parseSessionCookie,
  sessionCookieHeader,
};