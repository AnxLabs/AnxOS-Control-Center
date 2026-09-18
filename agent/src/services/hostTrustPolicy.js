// Request-level Host allowlist + explicit cross-origin denial for the Agent.
//
// Proven precondition (independent security review, 2026-09): the Agent trusted
// the caller-supplied `Host` header (it built its pairing `agentUrl` from it)
// and sent no CORS headers at all. A page on an attacker-controlled origin
// could therefore read Agent responses once DNS rebinding made the page
// same-origin with the loopback-bound Agent. Whether a real browser can finish
// that attack is still unproven (Chrome's Local/Private Network Access gate may
// block it) — this module hardens the proven precondition.
//
// Two independent controls live here:
//
//  1. Host allowlist. The `Host` header is validated against what this Agent
//     can legitimately be addressed as. The check is pure string work: no DNS
//     resolution, no filesystem work, no new subsystem. `os.networkInterfaces()`
//     (already used by this repo for the network inventory) supplies the
//     machine's own interface addresses from a short-lived cache.
//
//  2. Explicit cross-origin denial. The Agent never emits
//     `Access-Control-Allow-Origin`; additionally a state-changing request (or a
//     CORS preflight) whose `Origin` header is present and does not match the
//     request's own Host is refused with CROSS_ORIGIN_DENIED before any
//     authentication, session, or route work runs.
//
// Both checks fail closed: a missing, duplicate, or malformed Host is refused
// with HOST_NOT_ALLOWED rather than being allowed through.
//
// Accepted gap (documented, not accidental): a wildcard bind (0.0.0.0 / ::)
// means "any address this machine has", but deciding whether an arbitrary NAME
// resolves to a local interface would require DNS at request time, which this
// change deliberately does not add. Under a wildcard bind any syntactically
// valid Host is therefore accepted. That case is reported as an accepted gap;
// a concrete bind (the Control Center's default local-agent host is 127.0.0.1)
// enforces the strict allowlist.

const os = require("os");

const HOST_NOT_ALLOWED = "HOST_NOT_ALLOWED";
const CROSS_ORIGIN_DENIED = "CROSS_ORIGIN_DENIED";

// Loopback in every spelling a client can legitimately produce, including the
// IPv4-mapped IPv6 form a dual-stack socket reports.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1"]);
// Binds that mean "every address this machine has".
const WILDCARD_BINDS = new Set(["", "*", "0.0.0.0", "::", "0:0:0:0:0:0:0:0"]);
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const IPV6_PATTERN = /^[0-9a-f:]+$/;
const HOSTNAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const MAX_HOSTNAME_LENGTH = 253;
const MAX_HOST_HEADER_LENGTH = 300;
// Interface addresses change with DHCP/VPN, so the enumeration is cached rather
// than frozen at module load; the TTL keeps the request path cheap.
const INTERFACE_CACHE_TTL_MS = 10000;

let interfaceCache = { at: 0, names: new Set() };
let allowlistCache = { key: null, interfaceAt: -1, value: null };

function stripIpv6Zone(value) {
  const index = String(value || "").indexOf("%");
  return index === -1 ? String(value || "") : String(value).slice(0, index);
}

function isIpv6Literal(value) {
  return typeof value === "string" && value.includes(":") && IPV6_PATTERN.test(value);
}

function isIpLiteral(value) {
  return IPV4_PATTERN.test(String(value || "")) || isIpv6Literal(value);
}

/**
 * Parse a raw Host header value (or a URL hostname) into
 * `{ name, port, literal, token }`, or null when it is missing/malformed.
 * `name` is the lowercased host with the port and IPv6 brackets removed.
 * `token` is the canonical `name[:port]` form, comparable with `new URL(o).host`.
 */
function parseHostValue(rawValue) {
  if (typeof rawValue !== "string") return null;
  const raw = rawValue.trim();
  if (!raw || raw.length > MAX_HOST_HEADER_LENGTH) return null;
  // Reject anything that cannot be a bare host[:port]: userinfo, paths,
  // whitespace, query strings, fragments.
  if (/[\s/\\@?#]/.test(raw)) return null;

  let name = raw;
  let port = null;
  if (raw.startsWith("[")) {
    const close = raw.indexOf("]");
    if (close <= 1) return null;
    name = raw.slice(1, close);
    const rest = raw.slice(close + 1);
    if (rest) {
      if (!rest.startsWith(":")) return null;
      port = rest.slice(1);
    }
    if (!isIpv6Literal(stripIpv6Zone(name))) return null;
  } else {
    const firstColon = raw.indexOf(":");
    const lastColon = raw.lastIndexOf(":");
    if (firstColon !== -1 && firstColon === lastColon) {
      // Exactly one colon: host:port. (A bare IPv6 literal has several colons.)
      name = raw.slice(0, firstColon);
      port = raw.slice(firstColon + 1);
    }
    if (name.includes("[") || name.includes("]")) return null;
  }

  if (port !== null) {
    if (!/^\d{1,5}$/.test(port)) return null;
    const portNumber = Number(port);
    if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) return null;
  }

  const bare = stripIpv6Zone(name).toLowerCase();
  if (!bare) return null;
  const literal = isIpLiteral(bare);
  if (!literal) {
    if (bare.length > MAX_HOSTNAME_LENGTH || !HOSTNAME_PATTERN.test(bare)) return null;
  }

  const bracketed = isIpv6Literal(bare) ? `[${bare}]` : bare;
  return { name: bare, port, literal, token: port ? `${bracketed}:${port}` : bracketed };
}

function normalizeBindValue(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (raw.startsWith("[") && raw.endsWith("]")) return raw.slice(1, -1);
  return raw;
}

function isWildcardBind(host) {
  return WILDCARD_BINDS.has(normalizeBindValue(host));
}

function addAllowlistedHost(target, value) {
  const parsed = parseHostValue(value);
  if (!parsed || isWildcardBind(parsed.name)) return;
  target.add(parsed.name);
}

function hostFromAgentUrl(agentUrl) {
  if (typeof agentUrl !== "string" || !agentUrl.trim()) return null;
  try {
    const parsed = new URL(agentUrl.trim());
    return parsed.hostname || null;
  } catch {
    return null;
  }
}

function localInterfaceNames() {
  const now = Date.now();
  if (now - interfaceCache.at < INTERFACE_CACHE_TTL_MS) return interfaceCache.names;
  const names = new Set();
  let interfaces = null;
  try {
    interfaces = os.networkInterfaces();
  } catch {
    interfaces = null;
  }
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      if (entry && typeof entry.address === "string") names.add(stripIpv6Zone(entry.address).toLowerCase());
    }
  }
  interfaceCache = { at: now, names };
  return names;
}

function machineHostname() {
  try {
    return os.hostname() || null;
  } catch {
    return null;
  }
}

/**
 * The names this Agent legitimately answers for, plus whether its bind is a
 * wildcard. Cheap to build: a handful of set insertions after a cached
 * interface enumeration; no I/O, no DNS.
 */
function buildHostAllowlist(config = {}) {
  const wildcard = isWildcardBind(config.host);
  const key = `${wildcard ? "*" : normalizeBindValue(config.host)}|${String(config.agentUrl || "").toLowerCase()}`;
  const interfaceNames = localInterfaceNames();
  if (allowlistCache.value && allowlistCache.key === key && allowlistCache.interfaceAt === interfaceCache.at) {
    return allowlistCache.value;
  }
  const allowed = new Set(LOOPBACK_HOSTS);
  if (!wildcard) addAllowlistedHost(allowed, config.host);
  addAllowlistedHost(allowed, hostFromAgentUrl(config.agentUrl));
  for (const address of interfaceNames) allowed.add(address);
  addAllowlistedHost(allowed, machineHostname());
  const value = { allowed, wildcard };
  allowlistCache = { key, interfaceAt: interfaceCache.at, value };
  return value;
}

/**
 * Decide whether a raw Host header value is acceptable for this Agent.
 * Never throws; never performs I/O.
 */
function evaluateHost(hostValue, config = {}) {
  if (Array.isArray(hostValue)) {
    return { allowed: false, code: HOST_NOT_ALLOWED, reason: "duplicate-host-header" };
  }
  if (typeof hostValue !== "string" || !hostValue.trim()) {
    return { allowed: false, code: HOST_NOT_ALLOWED, reason: "missing-host-header" };
  }
  const parsed = parseHostValue(hostValue);
  if (!parsed) {
    return { allowed: false, code: HOST_NOT_ALLOWED, reason: "malformed-host-header" };
  }
  const allowlist = buildHostAllowlist(config);
  if (allowlist.allowed.has(parsed.name)) {
    return { allowed: true, parsed, wildcard: allowlist.wildcard, matched: "allowlist" };
  }
  if (allowlist.wildcard) {
    // Accepted gap: see the module header. A wildcard bind cannot tell an
    // operator's DNS name from an attacker's DNS name without a DNS lookup.
    return { allowed: true, parsed, wildcard: true, matched: "wildcard-permissive" };
  }
  return { allowed: false, code: HOST_NOT_ALLOWED, reason: "host-not-in-allowlist", parsed };
}

/**
 * Whether an arbitrary Host value may be echoed back to the client as this
 * Agent's address (the pairing payload's `agentUrl`).
 *
 * Stricter than `evaluateHost`: a NAME is echoed only when it is one the Agent
 * answers for, so a DNS-rebinding-shaped name cannot be reflected into a value
 * the client then trusts and connects to. An IP literal is always echoable —
 * DNS rebinding cannot produce one, and a remote Control Center legitimately
 * addresses a remote Agent by its LAN address.
 */
function isEchoableAgentHost(hostValue, config = {}) {
  const parsed = parseHostValue(hostValue);
  if (!parsed || isWildcardBind(parsed.name)) return false;
  if (parsed.literal) return true;
  return buildHostAllowlist(config).allowed.has(parsed.name);
}

/**
 * A trusted `host:port` authority for this Agent, used whenever the request's
 * Host cannot be echoed. Prefers the operator-configured agentUrl, then the
 * configured bind, then loopback.
 */
function trustedAgentAuthority(config = {}) {
  const port = Number(config.port) > 0 ? String(config.port) : "47131";
  for (const candidate of [hostFromAgentUrl(config.agentUrl), config.host]) {
    const parsed = parseHostValue(candidate);
    // `token` keeps IPv6 in bracket form, so `[::1]` never becomes `::1:port`.
    if (parsed && !isWildcardBind(parsed.name)) return `${parsed.token}:${port}`;
  }
  return `127.0.0.1:${port}`;
}

/**
 * Compare an `Origin` header against the request's own canonical Host token.
 * A missing Origin is not cross-origin (Node/Electron clients send none).
 * A duplicate or unparseable Origin — including the literal `null` — is
 * treated as cross-origin so the caller can fail closed.
 */
function evaluateOrigin(originValue, requestHostToken) {
  if (originValue === undefined || originValue === null) return { originPresent: false, crossOrigin: false };
  if (Array.isArray(originValue)) {
    return { originPresent: true, crossOrigin: true, reason: "duplicate-origin-header" };
  }
  const raw = String(originValue).trim();
  if (!raw) return { originPresent: false, crossOrigin: false };
  let originHost;
  try {
    originHost = new URL(raw).host.toLowerCase();
  } catch {
    return { originPresent: true, crossOrigin: true, reason: "malformed-origin-header" };
  }
  const expected = String(requestHostToken || "").toLowerCase();
  return { originPresent: true, crossOrigin: originHost !== expected, originHost };
}

function isStateChangingMethod(method) {
  return !/^(?:GET|HEAD|OPTIONS)$/i.test(String(method || "GET"));
}

/**
 * The request-layer trust gate. Throws a typed 4xx error when the request is
 * addressed to a host this Agent does not answer for, or when a cross-origin
 * Origin attempts a state change or a CORS preflight.
 *
 * Ordering note: the checks run before any authentication, session creation,
 * enrollment handling, or route dispatch, so a refused request has no side
 * effect and cannot reach a handler that would echo the caller's Host.
 */
function assertTrustedRequest(request, config = {}) {
  const host = evaluateHost(request?.headers?.host, config);
  if (!host.allowed) {
    const error = new Error("This Agent does not answer for the requested host.");
    error.code = HOST_NOT_ALLOWED;
    error.statusCode = 421;
    error.details = { reason: host.reason };
    throw error;
  }
  const origin = evaluateOrigin(request?.headers?.origin, host.parsed.token);
  if (origin.crossOrigin && (isStateChangingMethod(request?.method) || String(request?.method || "").toUpperCase() === "OPTIONS")) {
    const error = new Error("Cross-origin requests may not change Agent state.");
    error.code = CROSS_ORIGIN_DENIED;
    error.statusCode = 403;
    error.details = { reason: origin.reason || "origin-host-mismatch" };
    throw error;
  }
  return { host, origin };
}

function resetHostTrustPolicyCacheForTest() {
  interfaceCache = { at: 0, names: new Set() };
  allowlistCache = { key: null, interfaceAt: -1, value: null };
}

module.exports = {
  CROSS_ORIGIN_DENIED,
  HOST_NOT_ALLOWED,
  assertTrustedRequest,
  buildHostAllowlist,
  evaluateHost,
  evaluateOrigin,
  isEchoableAgentHost,
  isWildcardBind,
  parseHostValue,
  resetHostTrustPolicyCacheForTest,
  trustedAgentAuthority,
};
