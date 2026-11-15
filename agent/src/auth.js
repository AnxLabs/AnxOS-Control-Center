const crypto = require("crypto");

function readBearerToken(headerValue) {
  if (!headerValue || typeof headerValue !== "string") {
    return "";
  }

  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isPublicRoute(pathname) {
  return pathname === "/api/v1/health";
}

// V2-A: the agent still authenticates exactly one shared token (scoped
// per-node/per-workload credentials are deferred to V2-I). This descriptor is
// the single recognized principal so future per-principal grants have a stable
// identity to bind to; it carries no authority of its own.
const SHARED_TOKEN_PRINCIPAL = Object.freeze({ principal: "shared-token", role: null });

function resolveRequestPrincipal() {
  return SHARED_TOKEN_PRINCIPAL;
}

function isAuthorized(request, config, pathname) {
  if (isPublicRoute(pathname)) {
    return {
      ok: true,
      statusCode: 200,
      code: "PUBLIC_ROUTE",
    };
  }

  if (!config.token) {
    return {
      ok: false,
      statusCode: 503,
      code: "AGENT_TOKEN_MISSING",
    };
  }

  const token = request.headers["x-agent-token"] || readBearerToken(request.headers.authorization);

  if (typeof token !== "string" || !safeEqual(token, config.token)) {
    return {
      ok: false,
      statusCode: 401,
      code: "UNAUTHORIZED",
    };
  }

  return {
    ok: true,
    statusCode: 200,
    code: "AUTHORIZED",
  };
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

// Credential-derived details (the token fingerprint and the config path) are
// for the operator only: a caller on the Agent machine (loopback, the same
// trust the pairing gate gives), or one that presents the live token. The
// public health and enrollment-status routes used to send the fingerprint to
// anyone, which let a network caller search offline for a colliding string.
function canReadCredentialDetails(request, config = {}) {
  if (LOOPBACK_ADDRESSES.has(request?.socket?.remoteAddress)) return true;
  if (!config.token) return false;
  const token = request?.headers?.["x-agent-token"] || readBearerToken(request?.headers?.authorization);
  return typeof token === "string" && safeEqual(token, config.token);
}

module.exports = {
  canReadCredentialDetails,
  isAuthorized,
  resolveRequestPrincipal,
};
