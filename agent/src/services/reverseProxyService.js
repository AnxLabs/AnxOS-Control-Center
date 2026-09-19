// V2-H reverse-proxy service (Agent side).
//
// WHAT IS REAL HERE
//   - Route definitions are validated by src/shared/reverseProxyPolicy.js and
//     persisted to a bounded, atomic JSON registry in the Agent config dir.
//   - Upstream reachability is a genuine bounded TCP connect to the validated
//     loopback (or explicitly granted) upstream host:port.
//   - Certificate records placed in the config dir are read and mapped through
//     the pure lifecycle state machine.
//
// WHAT IS STATE MODELLING ONLY (never claimed as done)
//   - Writing an actual proxy configuration (nginx/Caddy/Traefik/…) is ABSENT:
//     no such integration exists in this repository. A saved route therefore
//     reports applied:false and an explicit REVERSE_PROXY_ACTIVATION_UNAVAILABLE
//     activation block. "success" means the record was stored, nothing more.
//   - Certificate issuance (ACME/certbot/…) is ABSENT. tlsMode "managed" is
//     recorded as a request and reported as state "pending" with
//     REVERSE_PROXY_TLS_ISSUANCE_UNAVAILABLE. This service never mints an
//     "issued" certificate and never shells out to an issuer.
//
// Nothing here contacts a provider, spawns a command, or serves traffic.

const fs = require("fs");
const net = require("net");
const path = require("path");

const {
  MAX_CERTIFICATE_RECORDS,
  MAX_ROUTE_COUNT,
  assertRouteCountWithinLimit,
  evaluateCertificateState,
  normalizeReverseProxyRoute,
  reverseProxyError,
  summarizeCertificateLifecycle,
} = require("../../../src/shared/reverseProxyPolicy");
const { sanitizeForDiagnostics } = require("../../../src/shared/redaction");

const ROUTES_FILE_NAME = "reverse-proxy-routes.json";
const CERTIFICATES_FILE_NAME = "reverse-proxy-certificates.json";
const SCHEMA_VERSION = 1;
const PROBE_TIMEOUT_MS = 1500;

// The honest operator-facing statements for the two capabilities this build
// does not implement. They are returned on every read so a caller cannot
// mistake a saved record for an activated route.
const ACTIVATION_UNAVAILABLE = Object.freeze({
  supported: false,
  code: "REVERSE_PROXY_ACTIVATION_UNAVAILABLE",
  message: "AnxOS recorded this route but does not write proxy configuration in this build. No traffic is routed until an operator configures a reverse proxy from this record.",
});

const ISSUANCE_UNAVAILABLE = Object.freeze({
  supported: false,
  code: "REVERSE_PROXY_TLS_ISSUANCE_UNAVAILABLE",
  message: "AnxOS does not issue certificates in this build. Provide a certificate manually or issue one with an external ACME client, then record its metadata; a managed request stays pending.",
});

function defaultConfigDirectory() {
  return process.env.ANXHUB_CONFIG_DIR || path.join(process.cwd(), "config");
}

function routesFilePath(options = {}) {
  return options.filePath || path.join(options.configDir || defaultConfigDirectory(), ROUTES_FILE_NAME);
}

function certificatesFilePath(options = {}) {
  return options.certificatesFilePath || path.join(options.configDir || defaultConfigDirectory(), CERTIFICATES_FILE_NAME);
}

function readJsonFile(filePath, corruptCode, label) {
  if (!fs.existsSync(filePath)) return { exists: false, parsed: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Root must be an object.");
    }
    return { exists: true, parsed };
  } catch (error) {
    const backupPath = `${filePath}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(filePath, backupPath, fs.constants.COPYFILE_EXCL); } catch {}
    throw reverseProxyError(
      corruptCode,
      `${label} state is unreadable. The original file was preserved for recovery.`,
      { causeCode: error?.code || "INVALID_JSON" },
      500,
    );
  }
}

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function normalizeStoredRoute(entry) {
  // Re-validate on read so a hand-edited registry cannot introduce a route the
  // policy would have refused. Malformed legacy entries are dropped, not
  // trusted.
  try {
    return normalizeReverseProxyRoute(entry, {});
  } catch {
    return null;
  }
}

function readRouteRegistry(options = {}) {
  const filePath = routesFilePath(options);
  const { exists, parsed } = readJsonFile(filePath, "REVERSE_PROXY_REGISTRY_CORRUPT", "Reverse-proxy route");
  if (!exists) return { schemaVersion: SCHEMA_VERSION, routes: [] };
  const schemaVersion = Number.isInteger(parsed.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > SCHEMA_VERSION) {
    throw reverseProxyError(
      "REVERSE_PROXY_SCHEMA_UNSUPPORTED",
      "Reverse-proxy state was created by a newer application version.",
      { schemaVersion, supportedSchemaVersion: SCHEMA_VERSION },
      409,
    );
  }
  const routes = (Array.isArray(parsed.routes) ? parsed.routes : []).map(normalizeStoredRoute).filter(Boolean);
  return { schemaVersion: SCHEMA_VERSION, routes: routes.slice(0, MAX_ROUTE_COUNT) };
}

function writeRouteRegistry(state, options = {}) {
  const routes = Array.isArray(state.routes) ? state.routes : [];
  assertRouteCountWithinLimit(routes, { maxRoutes: MAX_ROUTE_COUNT });
  const next = { schemaVersion: SCHEMA_VERSION, routes };
  atomicWriteJson(routesFilePath(options), next);
  return next;
}

function readCertificateRecords(options = {}) {
  const filePath = certificatesFilePath(options);
  const { exists, parsed } = readJsonFile(filePath, "REVERSE_PROXY_CERTIFICATE_REGISTRY_CORRUPT", "Reverse-proxy certificate");
  if (!exists) return [];
  return (Array.isArray(parsed.certificates) ? parsed.certificates : []).slice(0, MAX_CERTIFICATE_RECORDS);
}

function listReverseProxyRoutes(options = {}) {
  return readRouteRegistry(options).routes;
}

// Bounded TCP reachability probe against the already-validated upstream. This
// observes whether the workload accepts a connection; it says nothing about
// HTTP routing, DNS or TLS, because none of those are configured by AnxOS.
function probeUpstreamReachability(upstream, options = {}) {
  const connectImpl = options.connect || net.connect.bind(net);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ upstream: { host: upstream.host, port: upstream.port }, checkedAt: new Date().toISOString(), ...result });
    };
    let socket;
    try {
      socket = connectImpl({ host: upstream.host, port: upstream.port, timeout: timeoutMs });
    } catch (error) {
      finish({ reachable: false, code: "REVERSE_PROXY_UPSTREAM_UNREACHABLE", message: error?.message || "Upstream connection could not be started." });
      return;
    }
    socket.once("connect", () => {
      socket.destroy();
      finish({ reachable: true, code: null, message: "The upstream accepted a TCP connection." });
    });
    socket.once("timeout", () => {
      socket.destroy();
      finish({ reachable: false, code: "REVERSE_PROXY_UPSTREAM_UNREACHABLE", message: `The upstream did not accept a connection within ${timeoutMs}ms.` });
    });
    socket.once("error", (error) => {
      socket.destroy();
      finish({ reachable: false, code: "REVERSE_PROXY_UPSTREAM_UNREACHABLE", message: error?.message || "The upstream refused the connection." });
    });
  });
}

function certificateForHostname(certificates, hostname) {
  const target = String(hostname || "").toLowerCase();
  return certificates.find((certificate) => {
    const names = [certificate.hostname, certificate.subject, ...(Array.isArray(certificate.sans) ? certificate.sans : [])]
      .filter(Boolean)
      .map((entry) => String(entry).toLowerCase());
    return names.includes(target);
  }) || null;
}

// Report the certificate lifecycle for a route without ever inventing issuance.
function buildRouteCertificateReport(route, certificates, options = {}) {
  if (route.tlsMode === "none") {
    return { tlsMode: "none", state: "none", verified: false, expiryVerified: false, message: "This route does not request TLS." };
  }
  const record = certificateForHostname(certificates, route.hostname);
  if (!record) {
    // A managed request is a REQUEST: its lifecycle state is pending, never
    // issued. A manual route with nothing recorded is state none. Both carry
    // the operator-facing code and never imply a certificate exists.
    return {
      tlsMode: route.tlsMode,
      state: route.tlsMode === "managed" ? "pending" : "none",
      reason: route.tlsMode === "managed" ? "ISSUANCE_PENDING" : "NO_CERTIFICATE_RECORDED",
      verified: false,
      expiryVerified: false,
      issuanceSupported: false,
      code: route.tlsMode === "managed" ? ISSUANCE_UNAVAILABLE.code : "REVERSE_PROXY_CERTIFICATE_NOT_RECORDED",
      message: route.tlsMode === "managed" ? ISSUANCE_UNAVAILABLE.message : "No certificate metadata is recorded for this hostname yet.",
    };
  }
  const evaluated = evaluateCertificateState(record, options);
  return {
    tlsMode: route.tlsMode,
    state: evaluated.state,
    reason: evaluated.reason,
    verified: evaluated.verified,
    expiryVerified: evaluated.verified,
    expiresAt: evaluated.expiresAt,
    daysRemaining: evaluated.daysRemaining,
    fingerprint: evaluated.fingerprint,
    issuer: evaluated.issuer,
    issuanceSupported: false,
    code: route.tlsMode === "managed" ? ISSUANCE_UNAVAILABLE.code : null,
    message: route.tlsMode === "managed" ? ISSUANCE_UNAVAILABLE.message : null,
  };
}

async function getReverseProxySnapshot(options = {}) {
  const routes = listReverseProxyRoutes(options);
  const records = readCertificateRecords(options);
  const lifecycle = summarizeCertificateLifecycle(records, options);
  const payload = {
    ok: true,
    supported: true,
    platform: process.platform,
    checkedAt: new Date().toISOString(),
    routeCount: routes.length,
    maxRoutes: MAX_ROUTE_COUNT,
    routes: routes.map((route) => ({
      ...route,
      certificate: buildRouteCertificateReport(route, records, options),
    })),
    certificates: lifecycle.certificates,
    certificateLifecycle: {
      total: lifecycle.total,
      counts: lifecycle.counts,
      overall: lifecycle.overall,
      warningDays: lifecycle.warningDays,
    },
    activation: { ...ACTIVATION_UNAVAILABLE },
    certificateIssuance: { ...ISSUANCE_UNAVAILABLE },
  };
  return sanitizeForDiagnostics(payload);
}

async function applyReverseProxyRoute(payload = {}, options = {}) {
  const route = normalizeReverseProxyRoute(payload, options.policy || {});
  const state = readRouteRegistry(options);
  const conflicting = state.routes.find((entry) => entry.id !== route.id && entry.hostname === route.hostname && entry.pathPrefix === route.pathPrefix);
  if (conflicting) {
    throw reverseProxyError(
      "REVERSE_PROXY_ROUTE_CONFLICT",
      "A route already exists for this hostname and path.",
      { existingRouteId: conflicting.id, hostname: route.hostname, pathPrefix: route.pathPrefix },
      409,
    );
  }
  const existing = state.routes.find((entry) => entry.id === route.id);
  const routes = existing
    ? state.routes.map((entry) => (entry.id === route.id ? { ...route, createdAt: entry.createdAt } : entry))
    : [...state.routes, route];
  const persisted = writeRouteRegistry({ schemaVersion: SCHEMA_VERSION, routes }, options);

  const records = readCertificateRecords(options);
  const upstreamReachability = await probeUpstreamReachability(route.upstream, options);
  return sanitizeForDiagnostics({
    success: true,
    // Saving the record happened; activating a proxy did not. Never conflate.
    applied: false,
    activation: { ...ACTIVATION_UNAVAILABLE },
    certificate: buildRouteCertificateReport(route, records, options),
    route,
    upstreamReachability,
    routes: persisted.routes,
  });
}

module.exports = {
  ACTIVATION_UNAVAILABLE,
  CERTIFICATES_FILE_NAME,
  ISSUANCE_UNAVAILABLE,
  ROUTES_FILE_NAME,
  SCHEMA_VERSION,
  applyReverseProxyRoute,
  buildRouteCertificateReport,
  certificateForHostname,
  getReverseProxySnapshot,
  listReverseProxyRoutes,
  probeUpstreamReachability,
  readCertificateRecords,
  readRouteRegistry,
  routesFilePath,
  certificatesFilePath,
  writeRouteRegistry,
  _test: {
    atomicWriteJson,
    normalizeStoredRoute,
  },
};