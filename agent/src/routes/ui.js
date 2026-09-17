const fs = require("fs");
const path = require("path");
const { consumeBootstrapCode, issueBootstrapCode, issueSession, validateSessionToken } = require("../services/sessionService");

// V2-A browser surface routes (docs/v2/V2A_BROWSER_SURFACE_WAVE1.md Option A).
// POST /api/v1/ui/session — exchange the existing bearer credential for a
// short-lived httpOnly session cookie (transport credential only; the
// fail-closed permission map is unchanged). GET /api/v1/ui/session — validate
// the current session cookie. GET /api/v1/ui — the session-gated read-only
// management page (static asset; no innerHTML sinks; loopback http default).

const SESSION_COOKIE_NAME = "anxos_ui_session";
const MANAGEMENT_PAGE_PATH = path.join(__dirname, "..", "public", "management.html");
const MANAGEMENT_PAGE_CACHE = { mtimeMs: 0, html: null };

const MANAGEMENT_PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

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

function loadManagementPage() {
  try {
    const stats = fs.statSync(MANAGEMENT_PAGE_PATH);
    if (!MANAGEMENT_PAGE_CACHE.html || stats.mtimeMs !== MANAGEMENT_PAGE_CACHE.mtimeMs) {
      MANAGEMENT_PAGE_CACHE.mtimeMs = stats.mtimeMs;
      MANAGEMENT_PAGE_CACHE.html = fs.readFileSync(MANAGEMENT_PAGE_PATH, "utf8");
    }
    return MANAGEMENT_PAGE_CACHE.html;
  } catch {
    return null;
  }
}

function parseBootstrapBody(request) {
  try {
    const parsed = request.body ? JSON.parse(request.body) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw Object.assign(new Error("Bootstrap request body must be valid JSON."), {
      code: "UI_BOOTSTRAP_BAD_REQUEST",
      statusCode: 400,
    });
  }
}

// Bearer-gated (permission ui:session): the desktop mints the code it will
// show to the operator for the browser bootstrap form.
function handleUiBootstrapCode(request, url) {
  if (request.method === "POST" && url.pathname === "/api/v1/ui/bootstrap-code") {
    const issued = issueBootstrapCode();
    return {
      statusCode: 200,
      body: { code: issued.code, expiresAt: issued.expiresAt, ttlMs: issued.ttlMs },
    };
  }
  return {
    statusCode: 404,
    body: { error: { code: "NOT_FOUND", message: "Request failed." } },
  };
}

// Pre-auth: exchanges a one-time bootstrap code for a session cookie. The
// browser holds no bearer credential — this is its only way in.
function handleUiBootstrap(request, url) {
  if (request.method === "POST" && url.pathname === "/api/v1/ui/session/bootstrap") {
    const body = parseBootstrapBody(request);
    consumeBootstrapCode(body?.code);
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
  return {
    statusCode: 404,
    body: { error: { code: "NOT_FOUND", message: "Request failed." } },
  };
}

function handleUiSession(request, url) {
  if (request.method === "GET" && url.pathname === "/api/v1/ui") {
    // Session-gated static page. A missing/expired session redirects the
    // browser to Control Center guidance rather than serving the shell.
    try {
      validateSessionToken(parseSessionCookie(request));
    } catch {
      return {
        statusCode: 302,
        headers: { location: "/api/v1/ui/session?state=expired" },
        body: null,
      };
    }
    const html = loadManagementPage();
    if (html === null) {
      return {
        statusCode: 404,
        body: { error: { code: "UI_PAGE_UNAVAILABLE", message: "The management page asset is missing on this agent." } },
      };
    }
    return {
      statusCode: 200,
      headers: MANAGEMENT_PAGE_HEADERS,
      rawBody: Buffer.from(html, "utf8"),
    };
  }
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
  handleUiBootstrap,
  handleUiBootstrapCode,
  handleUiSession,
  handleUiSessionError,
  parseSessionCookie,
  sessionCookieHeader,
};