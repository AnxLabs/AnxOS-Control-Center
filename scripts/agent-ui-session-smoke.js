const assert = require("assert");

// V2-A browser surface session smoke (docs/v2/V2A_BROWSER_SURFACE_WAVE1.md
// Option A): session issue/validate/expire/limit semantics at the route layer
// — hermetic, no live server required.

const {
  BOOTSTRAP_CODE_PATTERN,
  MAX_ACTIVE_BOOTSTRAP_CODES,
  MAX_ACTIVE_SESSIONS,
  SESSION_ID_PATTERN,
  consumeBootstrapCode,
  issueBootstrapCode,
  issueSession,
  resetSessionsForTest,
  revokeSession,
  validateSessionToken,
} = require("../agent/src/services/sessionService");
const {
  SESSION_COOKIE_NAME,
  handleUiBootstrap,
  handleUiSession,
  handleUiSessionError,
  parseSessionCookie,
  sessionCookieHeader,
} = require("../agent/src/routes/ui");

const BASE = "http://127.0.0.1:47131";
const u = (p) => new URL(`${BASE}${p}`);
const dispatch = (request, url) => {
  try {
    return handleUiSession(request, url);
  } catch (error) {
    return handleUiSessionError(error);
  }
};
// Mirror the server's pre-auth wrap: handler errors become error results.
const runBootstrap = (request, url) => {
  try {
    return handleUiBootstrap(request, url);
  } catch (error) {
    return handleUiSessionError(error);
  }
};

async function main() {
  resetSessionsForTest();

  // 1. Issue: bearer auth is enforced upstream (server.js); the route mints a
  // bounded httpOnly session cookie.
  const issued = dispatch({ method: "POST", headers: {}, body: "" }, u("/api/v1/ui/session"));
  assert.strictEqual(issued.statusCode, 200, "Session issue must return 200.");
  const cookieHeader = issued.headers["set-cookie"];
  assert.ok(cookieHeader.startsWith(`${SESSION_COOKIE_NAME}=`), "The session must be set as a cookie.");
  assert.ok(cookieHeader.includes("HttpOnly"), "The session cookie must be HttpOnly.");
  assert.ok(cookieHeader.includes("SameSite=Strict"), "The session cookie must be SameSite=Strict.");
  assert.ok(cookieHeader.includes("Path=/api/v1/ui"), "The session cookie must be path-scoped to the UI surface.");
  const token = parseSessionCookie({ headers: { cookie: cookieHeader } });
  assert.ok(SESSION_ID_PATTERN.test(token), "The session token must be a 32-byte base64url value.");

  // 2. Validate: a valid cookie returns the session with its expiry.
  const validated = dispatch(
    { method: "GET", headers: { cookie: cookieHeader }, body: "" },
    u("/api/v1/ui/session"),
  );
  assert.strictEqual(validated.statusCode, 200, "A valid session cookie must validate.");
  assert.strictEqual(validated.body.expiresAt, issued.body.expiresAt, "Validation must report the session expiry.");

  // 3. Fail-closed: missing and malformed cookies are rejected with one error.
  const missing = dispatch({ method: "GET", headers: {}, body: "" }, u("/api/v1/ui/session"));
  assert.strictEqual(missing.statusCode, 401, "A missing cookie must be rejected.");
  assert.strictEqual(missing.body.error.code, "UI_SESSION_INVALID");
  const garbage = dispatch(
    { method: "GET", headers: { cookie: `${SESSION_COOKIE_NAME}=not-a-real-session` }, body: "" },
    u("/api/v1/ui/session"),
  );
  assert.strictEqual(garbage.statusCode, 401, "An unknown cookie must be rejected.");
  assert.strictEqual(garbage.body.error.code, "UI_SESSION_INVALID");

  // 4. The store is bounded: issuing past the cap fails closed.
  resetSessionsForTest();
  for (let index = 0; index < MAX_ACTIVE_SESSIONS; index += 1) {
    const issuedBatch = dispatch({ method: "POST", headers: {}, body: "" }, u("/api/v1/ui/session"));
    assert.strictEqual(issuedBatch.statusCode, 200, `Session ${index + 1} must issue within the cap.`);
  }
  const overflow = dispatch({ method: "POST", headers: {}, body: "" }, u("/api/v1/ui/session"));
  assert.strictEqual(overflow.statusCode, 429, "Issuing past the cap must fail closed.");
  assert.strictEqual(overflow.body.error.code, "SESSION_LIMIT_REACHED");

  // 5. Revocation and expiry semantics.
  resetSessionsForTest();
  const single = issueSession();
  assert.strictEqual(revokeSession(single.token), true, "Revocation must remove the session.");
  assert.throws(() => validateSessionToken(single.token), (error) => error.code === "UI_SESSION_INVALID",
    "A revoked session must no longer validate.");
  const expired = issueSession(Date.now() - 16 * 60 * 1000);
  assert.throws(() => validateSessionToken(expired.token), (error) => error.code === "UI_SESSION_EXPIRED",
    "An expired session must be rejected with the expiry code.");

  // 6. The management page is session-gated: a valid session serves the
  // static shell with a tightened CSP; no session redirects to guidance.
  resetSessionsForTest();
  const pageSession = issueSession();
  const pageCookie = sessionCookieHeader(pageSession.token, pageSession.expiresAt);
  const pageOk = dispatch(
    { method: "GET", headers: { cookie: pageCookie }, body: "" },
    u("/api/v1/ui"),
  );
  assert.strictEqual(pageOk.statusCode, 200, "A valid session must serve the management page.");
  assert.ok(String(pageOk.headers["content-security-policy"]).includes("default-src 'none'"), "The page must carry a tightened CSP.");
  const pageDenied = dispatch({ method: "GET", headers: {}, body: "" }, u("/api/v1/ui"));
  // No session at the route layer: the page handler redirects the browser to
  // the bootstrap form rather than serving the shell.
  assert.strictEqual(pageDenied.statusCode, 302, "A missing session must redirect, not serve the shell.");
  assert.strictEqual(pageDenied.headers.location, "/api/v1/ui/bootstrap", "The redirect must target the bootstrap form.");

  // 6b. The bootstrap form itself is pre-auth and always reachable.
  const bootstrapPage = dispatch({ method: "GET", headers: {}, body: "" }, u("/api/v1/ui/bootstrap"));
  assert.strictEqual(bootstrapPage.statusCode, 200, "The bootstrap form must be pre-auth (always reachable).");
  assert.ok(String(bootstrapPage.headers["content-security-policy"]).includes("default-src 'none'"), "The bootstrap page must carry the same CSP.");

  // 7. Browser bootstrap (A2.5): one-time code → session cookie, pre-auth.
  resetSessionsForTest();
  const codeIssued = issueBootstrapCode();
  assert.ok(BOOTSTRAP_CODE_PATTERN.test(codeIssued.code), "Bootstrap codes must use the unambiguous XXXX-XXXX form.");
  const badBootstrap = runBootstrap(
    { method: "POST", headers: {}, body: JSON.stringify({ code: "AAAA-AAAA" }) },
    u("/api/v1/ui/session/bootstrap"),
  );
  assert.strictEqual(badBootstrap.statusCode, 401, "An unknown code must be rejected.");
  const bootstrap = runBootstrap(
    { method: "POST", headers: {}, body: JSON.stringify({ code: codeIssued.code }) },
    u("/api/v1/ui/session/bootstrap"),
  );
  assert.strictEqual(bootstrap.statusCode, 200, "A valid code must mint a session.");
  assert.ok(bootstrap.headers["set-cookie"].startsWith(`${SESSION_COOKIE_NAME}=`), "Bootstrap must set the session cookie.");
  const replay = runBootstrap(
    { method: "POST", headers: {}, body: JSON.stringify({ code: codeIssued.code }) },
    u("/api/v1/ui/session/bootstrap"),
  );
  assert.strictEqual(replay.statusCode, 401, "A bootstrap code is single-use: replay must be rejected.");
  assert.strictEqual(replay.body.error.code, "UI_BOOTSTRAP_INVALID");
  const malformed = runBootstrap(
    { method: "POST", headers: {}, body: JSON.stringify({ code: "nope" }) },
    u("/api/v1/ui/session/bootstrap"),
  );
  assert.strictEqual(malformed.statusCode, 401, "Malformed codes must be rejected.");
  resetSessionsForTest();
  for (let index = 0; index < MAX_ACTIVE_BOOTSTRAP_CODES; index += 1) {
    issueBootstrapCode();
  }
  assert.throws(() => issueBootstrapCode(), (error) => error.code === "BOOTSTRAP_LIMIT_REACHED",
    "Pending bootstrap codes are bounded.");

  console.log("agent:ui-session:smoke passed");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("agent:ui-session:smoke FAILED:", error);
    process.exit(1);
  });