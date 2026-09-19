// V2-H reverse-proxy route policy + certificate lifecycle (pure, testable).
//
// This module is deliberately pure: no filesystem, no network, no process
// access. It answers two questions and nothing else:
//
//   1. Is this reverse-proxy route definition safe and well formed?
//      (normalizeReverseProxyRoute — fail closed with typed error codes)
//   2. What lifecycle state does this certificate's metadata put it in?
//      (evaluateCertificateState — never report "valid" when expiry is
//      undeterminable)
//
// The Agent service (agent/src/services/reverseProxyService.js) and the route
// surface (agent/src/routes/publicAccess.js) are thin wrappers over this. The
// policy is the security boundary: anything it refuses never reaches a
// persisted record, a probe, or an operator-facing "applied" claim.
//
// Honesty contract (V2-H bullet 4): this module models certificate STATE only.
// It does not and cannot issue a certificate. TLS mode "managed" is recorded
// as a *request*, and its lifecycle state defaults to "pending" — never
// "issued" — until verified metadata with a determinable expiry says
// otherwise.

const DEFAULT_WARNING_DAYS = 30;
const MAX_WARNING_DAYS = 365;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_NAME_LENGTH = 80;
const MAX_PATH_PREFIX_LENGTH = 256;
const MAX_ROUTE_COUNT = 64;
const MAX_CERTIFICATE_RECORDS = 256;

// Loopback-only by default: an AnxOS reverse-proxy upstream is a workload on
// the same host. Reaching anything else requires the caller to pass an
// explicit allowlist, so a mistyped or hostile upstream cannot silently point
// the proxy at an arbitrary internal or public host.
const DEFAULT_UPSTREAM_HOSTS = Object.freeze(["127.0.0.1", "localhost", "::1"]);

const UPSTREAM_PROTOCOLS = Object.freeze(["http", "https"]);
const TLS_MODES = Object.freeze(["none", "manual", "managed"]);
const CERTIFICATE_STATES = Object.freeze(["none", "pending", "issued", "expiring", "expired", "failed", "unknown"]);

// States that mean "a certificate covering this route is currently usable".
const HEALTHY_CERTIFICATE_STATES = Object.freeze(["issued", "expiring"]);

function reverseProxyError(code, message, details = {}, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.statusCode = statusCode;
  return error;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasControlCharacters(value) {
  return /[\u0000-\u001f\u007f]/.test(String(value));
}

function stripTrailingDot(value) {
  return value.endsWith(".") ? value.slice(0, -1) : value;
}

const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DNS_HOSTNAME = new RegExp(`^(?:${DNS_LABEL}\\.)+${DNS_LABEL}$`);
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

// A public route hostname is a DNS name or an IPv4 literal. Wildcards are only
// ever accepted as the leftmost label and only with an explicit grant.
function normalizeRouteHostname(value, options = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw reverseProxyError("REVERSE_PROXY_HOSTNAME_REQUIRED", "A public service hostname is required.", { field: "hostname" });
  }
  if (hasControlCharacters(raw) || /\s/.test(raw)) {
    throw reverseProxyError("REVERSE_PROXY_HOSTNAME_INVALID", "The hostname may not contain whitespace or control characters.", { field: "hostname", received: raw.slice(0, 120) });
  }
  // Reject traversal-shaped input before any pattern match: a slash, backslash,
  // percent-encoding or a bare/empty label is never a service domain.
  if (/[\\/%]/.test(raw) || raw.includes("..") || raw.startsWith(".") || raw.endsWith("..")) {
    throw reverseProxyError("REVERSE_PROXY_HOSTNAME_INVALID", "The hostname is not a valid service domain.", { field: "hostname", received: raw.slice(0, 120) });
  }
  const hostname = stripTrailingDot(raw.toLowerCase());
  if (hostname.length > MAX_HOSTNAME_LENGTH) {
    throw reverseProxyError("REVERSE_PROXY_HOSTNAME_INVALID", `The hostname must be at most ${MAX_HOSTNAME_LENGTH} characters.`, { field: "hostname", maxLength: MAX_HOSTNAME_LENGTH });
  }
  if (hostname.startsWith("*.")) {
    const suffix = hostname.slice(2);
    if (!DNS_HOSTNAME.test(suffix)) {
      throw reverseProxyError("REVERSE_PROXY_HOSTNAME_INVALID", "A wildcard hostname must be a valid domain suffix.", { field: "hostname", received: hostname });
    }
    const grants = Array.isArray(options.grantedWildcardHosts)
      ? options.grantedWildcardHosts.map((entry) => String(entry).trim().toLowerCase())
      : [];
    if (!grants.includes(hostname)) {
      throw reverseProxyError(
        "REVERSE_PROXY_WILDCARD_NOT_GRANTED",
        "A wildcard hostname can only be used with an explicit grant for that exact wildcard.",
        { field: "hostname", received: hostname, granted: grants },
        403,
      );
    }
    return hostname;
  }
  if (hostname.includes("*")) {
    throw reverseProxyError("REVERSE_PROXY_HOSTNAME_INVALID", "The wildcard must be the leftmost label of the hostname.", { field: "hostname", received: hostname });
  }
  if (IPV4.test(hostname)) return hostname;
  if (!DNS_HOSTNAME.test(hostname)) {
    throw reverseProxyError("REVERSE_PROXY_HOSTNAME_INVALID", "Enter a public service domain such as app.example.com, or an IPv4 address.", { field: "hostname", received: hostname });
  }
  return hostname;
}

function normalizeUpstreamHost(value, options = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    throw reverseProxyError("REVERSE_PROXY_UPSTREAM_REQUIRED", "An upstream host and port are required.", { field: "upstream" });
  }
  // A local path/socket ("/var/run/app.sock"), a URL, a query, a fragment or a
  // credential-bearing authority are all not "host:port" and are refused.
  if (/[\\/?#@]/.test(raw) || raw.includes("://") || hasControlCharacters(raw) || /\s/.test(raw)) {
    throw reverseProxyError(
      "REVERSE_PROXY_UPSTREAM_INVALID",
      "The upstream must be a host and port, not a URL, path or socket.",
      { field: "upstream.host", received: raw.slice(0, 120), expected: "host" },
    );
  }
  const unbracketed = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
  const host = unbracketed.toLowerCase();
  if (!host) {
    throw reverseProxyError("REVERSE_PROXY_UPSTREAM_INVALID", "The upstream host is empty.", { field: "upstream.host", received: raw.slice(0, 120) });
  }
  if (hasControlCharacters(host) || /\s/.test(host) || host.includes("*")) {
    throw reverseProxyError("REVERSE_PROXY_UPSTREAM_INVALID", "The upstream host is not a valid hostname or address.", { field: "upstream.host", received: host.slice(0, 120) });
  }
  const allowed = Array.isArray(options.allowedUpstreamHosts) && options.allowedUpstreamHosts.length
    ? options.allowedUpstreamHosts.map((entry) => String(entry).trim().toLowerCase())
    : DEFAULT_UPSTREAM_HOSTS;
  if (!allowed.includes(host)) {
    throw reverseProxyError(
      "REVERSE_PROXY_UPSTREAM_HOST_NOT_ALLOWED",
      "The upstream host is outside the allowed host space. Only loopback upstreams are allowed unless the operator grants more.",
      { field: "upstream.host", received: host, allowed },
      403,
    );
  }
  if (!IPV4.test(host) && host !== "localhost" && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host)) {
    throw reverseProxyError("REVERSE_PROXY_UPSTREAM_INVALID", "The upstream host is not a valid hostname or address.", { field: "upstream.host", received: host.slice(0, 120) });
  }
  return host;
}

function normalizeUpstreamPort(value, options = {}) {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text)) {
    throw reverseProxyError("REVERSE_PROXY_UPSTREAM_PORT_INVALID", "The upstream port must be a whole number from 1 to 65535.", { field: "upstream.port", received: value, expected: "integer 1-65535" });
  }
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw reverseProxyError("REVERSE_PROXY_UPSTREAM_PORT_INVALID", "The upstream port must be a whole number from 1 to 65535.", { field: "upstream.port", received: value, expected: "integer 1-65535" });
  }
  const allowedPorts = Array.isArray(options.allowedUpstreamPorts) && options.allowedUpstreamPorts.length
    ? options.allowedUpstreamPorts.map((entry) => Number(entry)).filter((entry) => Number.isInteger(entry))
    : null;
  if (allowedPorts && !allowedPorts.includes(port)) {
    throw reverseProxyError("REVERSE_PROXY_UPSTREAM_PORT_NOT_ALLOWED", "The upstream port is outside the allowed port space.", { field: "upstream.port", received: port, allowed: allowedPorts }, 403);
  }
  return port;
}

// Accepts "host:port", "host:port" with bracketed IPv6, or { host, port }.
function normalizeUpstream(value, options = {}) {
  let hostInput;
  let portInput;
  if (isPlainObject(value)) {
    hostInput = value.host;
    portInput = value.port;
  } else {
    const text = String(value ?? "").trim();
    // Refuse a path, socket, URL, credential-bearing authority or query before
    // attempting to split host:port — a local socket path is not an upstream.
    if (!text || /[\\/?#@]/.test(text) || text.includes("://") || hasControlCharacters(text) || /\s/.test(text)) {
      throw reverseProxyError(
        "REVERSE_PROXY_UPSTREAM_INVALID",
        "The upstream must be a host and port, not a URL, path or socket.",
        { field: "upstream", received: text.slice(0, 120), expected: "host:port" },
      );
    }
    if (text.startsWith("[")) {
      const close = text.indexOf("]");
      if (close === -1 || text[close + 1] !== ":") {
        throw reverseProxyError("REVERSE_PROXY_UPSTREAM_INVALID", "The upstream must be a host and port, not a URL, path or socket.", { field: "upstream", received: text.slice(0, 120) });
      }
      hostInput = text.slice(1, close);
      portInput = text.slice(close + 2);
    } else {
      const separator = text.lastIndexOf(":");
      if (separator <= 0 || separator === text.length - 1) {
        throw reverseProxyError("REVERSE_PROXY_UPSTREAM_REQUIRED", "The upstream must include both a host and a port.", { field: "upstream", received: text.slice(0, 120), expected: "host:port" });
      }
      hostInput = text.slice(0, separator);
      portInput = text.slice(separator + 1);
    }
  }
  const host = normalizeUpstreamHost(hostInput, options);
  const port = normalizeUpstreamPort(portInput, options);
  return { host, port };
}

function normalizeUpstreamProtocol(value) {
  const protocol = String(value ?? "http").trim().toLowerCase();
  if (!UPSTREAM_PROTOCOLS.includes(protocol)) {
    throw reverseProxyError("REVERSE_PROXY_UPSTREAM_PROTOCOL_INVALID", "The upstream protocol must be http or https.", { field: "upstreamProtocol", received: value, expected: [...UPSTREAM_PROTOCOLS] });
  }
  return protocol;
}

function normalizeTlsMode(value) {
  const mode = String(value ?? "none").trim().toLowerCase();
  if (!TLS_MODES.includes(mode)) {
    throw reverseProxyError("REVERSE_PROXY_TLS_MODE_INVALID", "The TLS mode must be none, manual or managed.", { field: "tlsMode", received: value, expected: [...TLS_MODES] });
  }
  return mode;
}

function normalizePathPrefix(value) {
  const text = String(value ?? "/").trim() || "/";
  if (text.length > MAX_PATH_PREFIX_LENGTH) {
    throw reverseProxyError("REVERSE_PROXY_PATH_INVALID", `The path prefix must be at most ${MAX_PATH_PREFIX_LENGTH} characters.`, { field: "pathPrefix", maxLength: MAX_PATH_PREFIX_LENGTH });
  }
  if (!text.startsWith("/") || text.includes("..") || text.includes("\\") || text.includes("//") || hasControlCharacters(text) || /\s/.test(text)) {
    throw reverseProxyError("REVERSE_PROXY_PATH_INVALID", "The path prefix must start with / and cannot contain traversal segments.", { field: "pathPrefix", received: text.slice(0, 120), expected: "/path" });
  }
  return text === "/" ? "/" : text.replace(/\/+$/, "");
}

function normalizeRouteName(value, hostname, options = {}) {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  const fallback = options.name || `${hostname}`;
  return (name || fallback || "Reverse Proxy Route").slice(0, MAX_NAME_LENGTH);
}

function createReverseProxyRouteId(route) {
  const crypto = require("crypto");
  return `proxy-${crypto
    .createHash("sha256")
    .update([route.hostname, route.pathPrefix || "/", route.upstream.host, String(route.upstream.port)].join("|").toLowerCase())
    .digest("hex")
    .slice(0, 16)}`;
}

// Validate + normalise a route definition. Every field is bounded; unknown
// fields are dropped rather than persisted. Fail closed with a typed code.
function normalizeReverseProxyRoute(input = {}, options = {}) {
  if (!isPlainObject(input)) {
    throw reverseProxyError("REVERSE_PROXY_ROUTE_INVALID", "A reverse-proxy route definition is required.", { field: "route" });
  }
  const hostname = normalizeRouteHostname(input.hostname || input.domain || input.host, options);
  const upstream = normalizeUpstream(input.upstream ?? input.target, options);
  const upstreamProtocol = normalizeUpstreamProtocol(input.upstreamProtocol || input.protocol);
  const tlsMode = normalizeTlsMode(input.tlsMode);
  const pathPrefix = normalizePathPrefix(input.pathPrefix ?? input.path);
  const now = new Date().toISOString();
  const route = {
    id: String(input.id || "").trim() || null,
    name: normalizeRouteName(input.name, hostname, options),
    hostname,
    pathPrefix,
    upstream,
    upstreamProtocol,
    tlsMode,
    managedBy: "AnxOS",
    createdAt: input.createdAt || now,
    updatedAt: now,
  };
  route.id = route.id && /^proxy-[a-z0-9]{4,64}$/.test(route.id) ? route.id : createReverseProxyRouteId(route);
  if (options.existingCreatedAt) route.createdAt = options.existingCreatedAt;
  return route;
}

function assertRouteCountWithinLimit(routes, { maxRoutes = MAX_ROUTE_COUNT } = {}) {
  if (Array.isArray(routes) && routes.length > maxRoutes) {
    throw reverseProxyError("REVERSE_PROXY_ROUTE_LIMIT_EXCEEDED", `At most ${maxRoutes} reverse-proxy routes can be managed.`, { maxRoutes, received: routes.length }, 409);
  }
}

// ---------------------------------------------------------------------------
// Certificate lifecycle state machine (pure).
//
// States an operator sees: none, pending, issued, expiring, expired, failed,
// unknown. Invariant: a certificate is only ever reported as verifiable
// ("issued"/"expiring"/"expired") when its expiry moment can actually be
// determined. An unreadable or absent notAfter is "unknown", never valid.
// ---------------------------------------------------------------------------
function parseCertificateDate(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function evaluateCertificateState(certificate, options = {}) {
  const warningDays = Math.min(
    MAX_WARNING_DAYS,
    Math.max(1, Number.isFinite(Number(options.warningDays)) ? Number(options.warningDays) : DEFAULT_WARNING_DAYS),
  );
  const nowMs = options.now !== undefined ? new Date(options.now).getTime() : Date.now();
  const base = { warningDays, expiresAt: null, daysRemaining: null, verified: false, reason: null };

  if (!isPlainObject(certificate)) {
    return { ...base, state: "none", reason: "NO_CERTIFICATE_RECORDED" };
  }

  const shared = {
    id: certificate.id ? String(certificate.id) : null,
    subject: certificate.subject ? String(certificate.subject) : null,
    issuer: certificate.issuer ? String(certificate.issuer) : null,
    fingerprint: certificate.fingerprint ? String(certificate.fingerprint) : null,
    sans: Array.isArray(certificate.sans) ? certificate.sans.map((entry) => String(entry)) : [],
  };

  if (certificate.failureCode || certificate.lastError || String(certificate.state || "").toLowerCase() === "failed") {
    return {
      ...base,
      ...shared,
      state: "failed",
      reason: String(certificate.failureCode || certificate.lastError || "ISSUANCE_FAILED"),
    };
  }

  if (certificate.pending === true || String(certificate.state || "").toLowerCase() === "pending") {
    return { ...base, ...shared, state: "pending", reason: "ISSUANCE_PENDING" };
  }

  const expiresAt = parseCertificateDate(certificate.notAfter ?? certificate.expiresAt ?? certificate.validTo);
  if (!expiresAt) {
    // The one thing this machine must never do: call it valid without an
    // expiry it can read.
    return { ...base, ...shared, state: "unknown", reason: "EXPIRY_UNDETERMINABLE" };
  }
  const notBefore = parseCertificateDate(certificate.notBefore);
  if (notBefore && notBefore.getTime() > nowMs) {
    return { ...base, ...shared, state: "pending", reason: "NOT_YET_VALID", expiresAt: expiresAt.toISOString(), verified: true, daysRemaining: Math.ceil((expiresAt.getTime() - nowMs) / 86400000) };
  }
  const daysRemaining = Math.ceil((expiresAt.getTime() - nowMs) / 86400000);
  if (expiresAt.getTime() <= nowMs) {
    return { ...base, ...shared, state: "expired", reason: "EXPIRED", expiresAt: expiresAt.toISOString(), verified: true, daysRemaining };
  }
  if (daysRemaining <= warningDays) {
    return { ...base, ...shared, state: "expiring", reason: "WITHIN_EXPIRY_WINDOW", expiresAt: expiresAt.toISOString(), verified: true, daysRemaining };
  }
  return { ...base, ...shared, state: "issued", reason: "VALID", expiresAt: expiresAt.toISOString(), verified: true, daysRemaining };
}

// Worst-to-best ordering used to summarise a set without claiming health from
// an empty or unreadable set.
const CERTIFICATE_STATE_SEVERITY = Object.freeze({
  failed: 0,
  expired: 1,
  unknown: 2,
  pending: 3,
  expiring: 4,
  issued: 5,
  none: 6,
});

function summarizeCertificateLifecycle(certificates = [], options = {}) {
  const list = Array.isArray(certificates) ? certificates.slice(0, MAX_CERTIFICATE_RECORDS) : [];
  const evaluated = list.map((certificate) => evaluateCertificateState(certificate, options));
  const counts = {};
  for (const state of CERTIFICATE_STATES) counts[state] = 0;
  for (const entry of evaluated) counts[entry.state] += 1;
  let overall = list.length === 0 ? "none" : "issued";
  for (const entry of evaluated) {
    if (CERTIFICATE_STATE_SEVERITY[entry.state] < CERTIFICATE_STATE_SEVERITY[overall]) overall = entry.state;
  }
  return {
    total: list.length,
    counts,
    overall,
    warningDays: evaluated[0]?.warningDays ?? DEFAULT_WARNING_DAYS,
    certificates: evaluated,
  };
}

function isHealthyCertificateState(state) {
  return HEALTHY_CERTIFICATE_STATES.includes(state);
}

module.exports = {
  CERTIFICATE_STATES,
  CERTIFICATE_STATE_SEVERITY,
  DEFAULT_UPSTREAM_HOSTS,
  DEFAULT_WARNING_DAYS,
  HEALTHY_CERTIFICATE_STATES,
  MAX_CERTIFICATE_RECORDS,
  MAX_HOSTNAME_LENGTH,
  MAX_NAME_LENGTH,
  MAX_PATH_PREFIX_LENGTH,
  MAX_ROUTE_COUNT,
  MAX_WARNING_DAYS,
  TLS_MODES,
  UPSTREAM_PROTOCOLS,
  assertRouteCountWithinLimit,
  createReverseProxyRouteId,
  evaluateCertificateState,
  isHealthyCertificateState,
  normalizePathPrefix,
  normalizeReverseProxyRoute,
  normalizeRouteHostname,
  normalizeTlsMode,
  normalizeUpstream,
  normalizeUpstreamProtocol,
  reverseProxyError,
  summarizeCertificateLifecycle,
  _test: {
    parseCertificateDate,
  },
};