const {
  assertEnrollmentBinding,
  completeEnrollment,
  emitSpawnDiagnostic,
  enrollmentStatusSummary,
  evaluateSpawnEnvironment,
  migrateLegacyBinding,
  revokeEnrollment,
  rotateEnrollmentCredential,
  startEnrollment,
} = require("../services/enrollmentService");
const { logger } = require("../services/diagnosticsLogger");

// V2-A enrollment routes. Public handshake paths (/enroll/start, /enroll/complete,
// /enroll/status) are nonce/public protected and handled before bearer auth.
// Privileged paths (/credentials/rotate, /enroll/revoke) are bearer
// authenticated and permission-gated by getEnrollmentRoutePermission in
// server.js: rotate is agent:manage (admin may rotate), revoke is owner-only
// with an explicit confirmation (docs/v2/V2A_DECISIONS.md).
const PUBLIC_ENROLL_PATHS = new Set(["/api/v1/enroll/start", "/api/v1/enroll/complete", "/api/v1/enroll/status"]);

function parseJsonBody(request) {
  try {
    return request.body ? JSON.parse(request.body) : {};
  } catch {
    throw Object.assign(new Error("Enrollment request body must be valid JSON."), {
      code: "ENROLL_BAD_REQUEST",
      statusCode: 400,
    });
  }
}

function handlePublicEnrollment(request, url, config = {}) {
  const pathname = url.pathname;
  if (!PUBLIC_ENROLL_PATHS.has(pathname)) return null;
  if (request.method === "GET" && pathname === "/api/v1/enroll/status") {
    return enrollmentStatusSummary(config);
  }
  if (request.method === "POST" && pathname === "/api/v1/enroll/start") {
    return startEnrollment(parseJsonBody(request));
  }
  if (request.method === "POST" && pathname === "/api/v1/enroll/complete") {
    return completeEnrollment(parseJsonBody(request), config);
  }
  return null;
}

function handleEnrollmentManagement(request, url, config = {}) {
  const body = parseJsonBody(request);
  if (url.pathname === "/api/v1/credentials/rotate" && request.method === "POST") {
    return rotateEnrollmentCredential(config);
  }
  if (url.pathname === "/api/v1/enroll/revoke" && request.method === "POST") {
    return revokeEnrollment(config, {
      confirmRevoke: body.confirmRevoke === true,
      reason: body.reason,
    });
  }
  return null;
}

function getEnrollmentRoutePermission(pathname) {
  if (pathname === "/api/v1/enroll/revoke") return "owner";
  if (pathname === "/api/v1/credentials/rotate") return "agent:manage";
  return null;
}

// Per-request binding gate for authenticated routes. Health, enrollment, and
// the legacy pairing path stay reachable so a drifted/revoked agent can be
// detected and re-enrolled; every other route refuses with
// NODE_BINDING_MISMATCH / REVOKED once the pinned tuple no longer matches.
function assertEnrollmentGate(pathname, config = {}) {
  if (pathname === "/api/v1/health"
    || pathname.startsWith("/api/v1/enroll/")
    || pathname.startsWith("/api/v1/pairing/")) {
    return null;
  }
  assertEnrollmentBinding(config);
  return null;
}

let startupRegistered = false;

// Idempotent startup wiring: evaluates the desktop spawn contract (Decision 1)
// with a loud diagnostic on legacy/standalone starts, then auto-migrates an
// existing persisted shared-token binding into an enrolled record so the
// enrollment upgrade never breaks a running session.
function registerEnrollmentStartup(config = {}) {
  if (startupRegistered) return { alreadyRegistered: true };
  startupRegistered = true;
  const assessment = evaluateSpawnEnvironment();
  emitSpawnDiagnostic(assessment);
  try {
    const migration = migrateLegacyBinding(config);
    if (migration.migrated) {
      logger.info("enrollment", "Legacy agent binding auto-migrated into enrollment record", { spawnContract: assessment.spawnContract }, { file: "enrollment" });
    }
    if (migration.record?.state === "enrolled") {
      // Surface binding drift (root/token/device change since enrollment)
      // early so a stray root can never silently serve traffic.
      assertEnrollmentBinding(config);
    }
  } catch (error) {
    // A binding mismatch is a loud, actionable condition, not a crash: the
    // refusal is enforced per-request by the route gate in server.js.
    logger.error("enrollment", "Enrollment startup binding check failed", {
      code: error?.code || "ENROLLMENT_STARTUP_FAILED",
      message: error?.message || String(error),
    }, { file: "enrollment" });
  }
  return { alreadyRegistered: false, spawnContract: assessment.spawnContract };
}

module.exports = {
  PUBLIC_ENROLL_PATHS,
  assertEnrollmentGate,
  getEnrollmentRoutePermission,
  handleEnrollmentManagement,
  handlePublicEnrollment,
  registerEnrollmentStartup,
  _test: {
    parseJsonBody,
    resetStartup: () => { startupRegistered = false; },
  },
};
