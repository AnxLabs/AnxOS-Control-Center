const assert = require("assert");

// V2-A browser surface session smoke (docs/v2/V2A_BROWSER_SURFACE_WAVE1.md
// Option A): session issue/validate/expire/limit semantics at the route layer
// — hermetic, no live server required.

const {
  MAX_ACTIVE_SESSIONS,
  SESSION_ID_PATTERN,
  issueSession,
  resetSessionsForTest,
  revokeSession,
  validateSessionToken,
} = require("../agent/src/services/sessionService");
const {
  SESSION_COOKIE_NAME,
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

  console.log("agent:ui-session:smoke passed");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("agent:ui-session:smoke FAILED:", error);
    process.exit(1);
  });