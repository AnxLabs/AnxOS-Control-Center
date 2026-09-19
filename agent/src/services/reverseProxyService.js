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
const {
  EXPOSURE_MECHANISMS,
  classifyExposureRequest,
} = require("../../../src/shared/exposureRequirementsPolicy");
const { listAccessServices } = require("../../../src/shared/publicAccessServiceRegistry");
const { sanitizeForDiagnostics } = require("../../../src/shared/redaction");

const ROUTES_FILE_NAME = "reverse-proxy-routes.json";
const CERTIFICATES_FILE_NAME = "reverse-proxy-certificates.json";
const DIAGNOSTICS_FILE_NAME = "reverse-proxy-diagnostics.json";
const SCHEMA_VERSION = 1;
const PROBE_TIMEOUT_MS = 1500;

// Bounds for the exposure diagnostics snapshot. A diagnostics read must never
// grow without limit because an operator kept a log file around.
const MAX_DIAGNOSTIC_WORKLOADS = 128;
const MAX_DIAGNOSTIC_INDEX_ENTRIES = 256;
const MAX_RESIDUAL_RESOURCES = 32;
const MAX_ERROR_CODE_LENGTH = 64;
const MAX_ERROR_MESSAGE_LENGTH = 300;
const MAX_RESIDUAL_FIELD_LENGTH = 120;

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

function diagnosticsFilePath(options = {}) {
  return options.diagnosticsFilePath || path.join(options.configDir || defaultConfigDirectory(), DIAGNOSTICS_FILE_NAME);
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

// ---------------------------------------------------------------------------
// V2-H bullet: "Surface DNS/certificate/provider errors and residual billable
// resources where applicable; never imply provisioning succeeded."
//
// This snapshot reports, per exposed workload, the last DNS error, the last
// certificate error (taken from the real certificate lifecycle state), the last
// provider error, and residual billable resources. The governing rule is that
// an unestablished state is reported "unknown" and never as success:
//
//   - A recorded error is surfaced verbatim (bounded, re-validated).
//   - With no recorded error the state is "unknown", NOT "ok": AnxOS does not
//     resolve DNS, monitor provider APIs or read billing in this build, so the
//     absence of a recorded error proves nothing.
//   - A reverse-proxy route is NEVER reported provisioned: AnxOS records the
//     route but writes no proxy configuration, so whether the exposure is live
//     is unknown (an operator may have configured it externally).
//   - Residual billable resources are never reported as zero by default. With
//     no detector the count is null and the state is "unknown".
//
// Nothing here contacts a provider, spawns a command, or serves traffic.
// ---------------------------------------------------------------------------

const PROVISIONING_KNOWN_SUCCEEDED = "known-succeeded";
const PROVISIONING_KNOWN_FAILED = "known-failed";
const PROVISIONING_UNKNOWN = "unknown";

const DNS_UNKNOWN_NOTE = "AnxOS does not resolve or monitor DNS in this build and no DNS diagnostic is recorded for this exposure, so DNS state is unknown. The absence of a recorded error is not evidence that DNS is correct.";
const PROVIDER_UNKNOWN_NOTE = "AnxOS does not poll this provider in this build and no provider diagnostic is recorded for this exposure, so provider state is unknown. The absence of a recorded error is not evidence that the provider accepted the exposure.";
const RESIDUAL_UNDETECTABLE_NOTE = "This build has no provider billing integration, so residual billable resources cannot be detected. Unknown is reported instead of a fabricated zero.";
const RESIDUAL_PARTIAL_NOTE = "A residual-resource detector ran for some exposures only, so the total cannot be established; unknown is reported rather than a partial or zero count.";

const DIAGNOSTICS_UNAVAILABLE_NOTE = "No recorded reverse-proxy diagnostics exist on this Agent. Every error field is reported unknown rather than assumed absent.";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function truncateText(value, max) {
  const text = String(value ?? "");
  return text.length > max ? text.slice(0, max) : text;
}

function normalizeRecordedError(entry) {
  if (!isPlainObject(entry)) return null;
  const code = entry.code ? truncateText(entry.code, MAX_ERROR_CODE_LENGTH) : null;
  const message = entry.message ? truncateText(entry.message, MAX_ERROR_MESSAGE_LENGTH) : null;
  if (!code && !message) return null;
  return { code, message, at: entry.at ? truncateText(entry.at, 40) : null };
}

function indexRecordedErrors(section) {
  const index = Object.create(null);
  if (!isPlainObject(section)) return index;
  let count = 0;
  for (const key of Object.keys(section)) {
    if (count >= MAX_DIAGNOSTIC_INDEX_ENTRIES) break;
    const normalized = normalizeRecordedError(section[key]);
    if (!normalized) continue;
    index[String(key).toLowerCase()] = normalized;
    count += 1;
  }
  return index;
}

// Read the optional recorded-diagnostics registry. A missing file and an
// unreadable file are both "no recorded error", never "no error happened".
function readDiagnosticsRegistry(options = {}) {
  const filePath = diagnosticsFilePath(options);
  let parsed = null;
  try {
    const result = readJsonFile(filePath, "REVERSE_PROXY_DIAGNOSTICS_CORRUPT", "Reverse-proxy diagnostics");
    if (result.exists) parsed = result.parsed;
  } catch (error) {
    return {
      available: false,
      source: "unreadable",
      code: error?.code || "REVERSE_PROXY_DIAGNOSTICS_CORRUPT",
      message: "Recorded reverse-proxy diagnostics could not be read. Every recorded error is reported unknown rather than assumed absent.",
      dns: Object.create(null),
      certificate: Object.create(null),
      provider: Object.create(null),
    };
  }
  if (!parsed) {
    return {
      available: false,
      source: "absent",
      code: null,
      message: DIAGNOSTICS_UNAVAILABLE_NOTE,
      dns: Object.create(null),
      certificate: Object.create(null),
      provider: Object.create(null),
    };
  }
  return {
    available: true,
    source: "recorded",
    code: null,
    message: null,
    dns: indexRecordedErrors(parsed.dnsErrors),
    certificate: indexRecordedErrors(parsed.certificateErrors),
    provider: indexRecordedErrors(parsed.providerErrors),
  };
}

function recordedErrorFor(index, keys) {
  if (!index) return null;
  for (const key of keys) {
    if (!key) continue;
    const found = index[String(key).toLowerCase()];
    if (found) return found;
  }
  return null;
}

function readAccessServicesForDiagnostics(options = {}) {
  try {
    return { available: true, services: listAccessServices(options), code: null, message: null };
  } catch (error) {
    return {
      available: false,
      services: [],
      code: error?.code || "PUBLIC_ACCESS_REGISTRY_UNAVAILABLE",
      message: "Recorded Public Access services could not be read; they are omitted from the diagnostics snapshot rather than assumed absent.",
    };
  }
}

function buildDnsReport(keys, diagnostics) {
  const recorded = recordedErrorFor(diagnostics.dns, keys);
  if (recorded) {
    return { state: "error", lastError: recorded, recordedAt: recorded.at, note: "A DNS error was recorded for this exposure." };
  }
  return { state: "unknown", lastError: null, recordedAt: null, note: DNS_UNKNOWN_NOTE };
}

function buildProviderReport(providerId, keys, diagnostics, absenceNote = PROVIDER_UNKNOWN_NOTE) {
  const recorded = recordedErrorFor(diagnostics.provider, keys);
  if (recorded) {
    return { providerId: providerId || null, state: "error", lastError: recorded, recordedAt: recorded.at, note: "A provider error was recorded for this exposure." };
  }
  return { providerId: providerId || null, state: "unknown", lastError: null, recordedAt: null, note: absenceNote };
}

// Certificate error surface. For a reverse-proxy route the real lifecycle state
// machine decides; an unreadable expiry lands in "unknown" (never "valid") and
// carries EXPIRY_UNDETERMINABLE as its last error.
function certificateDiagnosticsForRoute(route, records, options, diagnostics, keys) {
  const report = buildRouteCertificateReport(route, records, options);
  let lastError = null;
  if (report.state === "failed") {
    lastError = { code: report.reason || "CERTIFICATE_FAILED", message: "The recorded certificate is in a failed state.", at: null };
  } else if (report.state === "unknown") {
    lastError = { code: report.reason || "CERTIFICATE_STATE_UNKNOWN", message: "The certificate state could not be established; it is not treated as valid.", at: null };
  }
  const recorded = recordedErrorFor(diagnostics.certificate, keys);
  if (recorded) lastError = recorded;
  return {
    state: report.state,
    reason: report.reason || null,
    verified: report.verified === true,
    expiryVerified: report.expiryVerified === true,
    expiresAt: report.expiresAt ?? null,
    lastError,
  };
}

function certificateDiagnosticsForService(service, diagnostics, keys) {
  const tlsCapable = service.protocol === "http" || service.protocol === "https";
  const state = tlsCapable ? "unknown" : "none";
  const reason = tlsCapable ? "CERTIFICATE_STATE_NOT_ESTABLISHED" : "NO_TLS_FOR_RAW_EXPOSURE";
  let lastError = recordedErrorFor(diagnostics.certificate, keys);
  if (!lastError && tlsCapable) {
    lastError = {
      code: reason,
      message: "This exposure can use TLS but AnxOS holds no certificate record for it, so the certificate state is unknown; it is not treated as valid.",
      at: null,
    };
  }
  return { state, reason, verified: false, expiryVerified: false, expiresAt: null, lastError };
}

function normalizeResidualResource(item) {
  if (!isPlainObject(item)) return { id: null, kind: null, providerId: null, billable: null };
  return {
    id: item.id ? truncateText(item.id, MAX_RESIDUAL_FIELD_LENGTH) : null,
    kind: item.kind ? truncateText(item.kind, MAX_RESIDUAL_FIELD_LENGTH) : null,
    providerId: item.providerId ? truncateText(item.providerId, MAX_RESIDUAL_FIELD_LENGTH) : null,
    billable: typeof item.billable === "boolean" ? item.billable : null,
  };
}

// Residual billable resources. Default is "unknown" with a null count; a caller
// may inject a detector result keyed by exposure id, and only then can the state
// be anything other than unknown.
function buildResidualResourceReport(workloadId, options = {}) {
  const source = options.residualBillableResources;
  if (!isPlainObject(source)) {
    return { state: "unknown", count: null, detectable: false, resources: [], note: RESIDUAL_UNDETECTABLE_NOTE };
  }
  const entry = source[workloadId];
  if (!Array.isArray(entry)) {
    return {
      state: "unknown",
      count: null,
      detectable: false,
      resources: [],
      note: "A residual-resource source was provided but holds no entry for this exposure, so presence or absence cannot be established.",
    };
  }
  if (entry.length === 0) {
    return { state: "none-detected", count: 0, detectable: true, resources: [], note: "A residual-resource detector ran for this exposure and reported none." };
  }
  return {
    state: "present",
    count: entry.length,
    detectable: true,
    resources: entry.slice(0, MAX_RESIDUAL_RESOURCES).map(normalizeResidualResource),
    note: "A residual-resource detector reported provider resources for this exposure. Billability is not verified by AnxOS.",
  };
}

function buildProvisioningReport({ kind, certificate, provider, service }) {
  if (provider?.lastError) {
    return {
      state: PROVISIONING_KNOWN_FAILED,
      basis: "recorded-provider-error",
      code: provider.lastError.code || "EXPOSURE_PROVIDER_ERROR",
      message: "A provider error is recorded for this exposure. Provisioning is known not to have succeeded.",
      at: provider.lastError.at || null,
    };
  }
  if (certificate?.state === "failed") {
    return {
      state: PROVISIONING_KNOWN_FAILED,
      basis: "certificate-failed",
      code: certificate.lastError?.code || "CERTIFICATE_FAILED",
      message: "The certificate for this exposure is in a failed state. Provisioning is known not to have succeeded.",
      at: certificate.lastError?.at || null,
    };
  }
  if (kind === "reverse-proxy-route") {
    // AnxOS recorded the route but writes no proxy configuration, so it cannot
    // establish that the exposure is live. Unknown — never succeeded.
    return {
      state: PROVISIONING_UNKNOWN,
      basis: "activation-unavailable",
      code: "REVERSE_PROXY_PROVISIONING_NOT_ESTABLISHED",
      message: "AnxOS recorded this route but does not write proxy configuration, so it cannot establish that the exposure is live. Reported unknown, never succeeded.",
      at: null,
    };
  }
  if (service?.state === "running") {
    return {
      state: PROVISIONING_KNOWN_SUCCEEDED,
      basis: "provider-detected-endpoint",
      code: null,
      message: "The provider reports a live public endpoint for this exposure.",
      at: service.lastCheckedAt || null,
    };
  }
  if (service && (service.state === "provider-unavailable" || service.state === "failed" || service.state === "error")) {
    return {
      state: PROVISIONING_KNOWN_FAILED,
      basis: "provider-unavailable",
      code: "EXPOSURE_PROVIDER_UNAVAILABLE",
      message: "The provider for this exposure is recorded as unavailable or failed. Provisioning is known not to have succeeded.",
      at: service.lastCheckedAt || null,
    };
  }
  return {
    state: PROVISIONING_UNKNOWN,
    basis: "pending-provider-setup",
    code: "EXPOSURE_PROVISIONING_NOT_ESTABLISHED",
    message: "No provider-confirmed endpoint and no recorded failure exist for this exposure, so provisioning state is unknown. Reported unknown, never succeeded.",
    at: null,
  };
}

function buildRouteDiagnosticsWorkload(route, records, diagnostics, options) {
  const protocol = route.tlsMode === "none" ? "http" : "https";
  const keys = [route.id, route.hostname, route.name];
  const certificate = certificateDiagnosticsForRoute(route, records, options, diagnostics, keys);
  const provider = buildProviderReport(null, keys, diagnostics, "Reverse-proxy routes are not tied to a tunneling provider in this build, and no provider diagnostic is recorded for this route.");
  const classification = classifyExposureRequest({ protocol, workloadKind: "web", mechanism: EXPOSURE_MECHANISMS.httpRouting });
  return sanitizeForDiagnostics({
    id: route.id,
    kind: "reverse-proxy-route",
    name: route.name,
    hostname: route.hostname,
    protocol,
    mechanism: classification.mechanism,
    providerId: null,
    requirements: {
      protocol: classification.protocol,
      transport: classification.transport,
      workloadKind: classification.workloadKind,
      mechanism: classification.mechanism,
      outcome: classification.outcome,
      reason: classification.reason,
    },
    provisioning: buildProvisioningReport({ kind: "reverse-proxy-route", certificate, provider }),
    dns: buildDnsReport(keys, diagnostics),
    certificate,
    provider,
    residualBillableResources: buildResidualResourceReport(route.id, options),
  });
}

function buildServiceDiagnosticsWorkload(service, diagnostics, options) {
  let classification;
  try {
    classification = classifyExposureRequest({ protocol: service.protocol, providerId: service.providerId });
  } catch {
    classification = { protocol: service.protocol || null, transport: null, workloadKind: null, mechanism: null, outcome: "unknown", reason: "EXPOSURE_CLASSIFICATION_FAILED", provider: null };
  }
  const keys = [service.id, service.publicHostname, service.hostname, service.name];
  const certificate = certificateDiagnosticsForService(service, diagnostics, keys);
  const provider = buildProviderReport(service.providerId || null, keys, diagnostics);
  return sanitizeForDiagnostics({
    id: service.id,
    kind: "access-service",
    name: service.name,
    hostname: service.publicHostname || service.hostname || null,
    protocol: classification.protocol,
    mechanism: classification.mechanism,
    providerId: service.providerId || null,
    requirements: {
      protocol: classification.protocol,
      transport: classification.transport,
      workloadKind: classification.workloadKind,
      mechanism: classification.mechanism,
      outcome: classification.outcome,
      reason: classification.reason,
    },
    provisioning: buildProvisioningReport({ kind: "access-service", certificate, provider, service }),
    dns: buildDnsReport(keys, diagnostics),
    certificate,
    provider,
    residualBillableResources: buildResidualResourceReport(service.id, options),
  });
}

function summarizeProvisioning(workloads, counts) {
  if (!workloads.length) {
    return {
      state: PROVISIONING_UNKNOWN,
      reason: "NO_EXPOSURE_WORKLOADS",
      message: "No exposure workload is recorded, so no provisioning state is established. Reported unknown, never succeeded.",
    };
  }
  if (counts.unknown > 0) {
    return {
      state: PROVISIONING_UNKNOWN,
      reason: "PROVISIONING_NOT_ESTABLISHED",
      message: `${counts.unknown} exposure workload(s) have no established provisioning state, so the overall state is unknown rather than succeeded.`,
    };
  }
  if (counts[PROVISIONING_KNOWN_FAILED] > 0) {
    return {
      state: PROVISIONING_KNOWN_FAILED,
      reason: "PROVISIONING_FAILED",
      message: `${counts[PROVISIONING_KNOWN_FAILED]} exposure workload(s) are known not to have provisioned.`,
    };
  }
  return {
    state: PROVISIONING_KNOWN_SUCCEEDED,
    reason: "PROVIDER_CONFIRMED",
    message: "Every recorded exposure workload is confirmed live by its provider.",
  };
}

function summarizeResidual(workloads) {
  if (!workloads.length) {
    return { state: "unknown", count: null, detectable: false, note: RESIDUAL_UNDETECTABLE_NOTE };
  }
  const anyUnknown = workloads.some((workload) => workload.residualBillableResources.state === "unknown");
  const detectable = workloads.some((workload) => workload.residualBillableResources.detectable);
  if (anyUnknown) {
    return { state: "unknown", count: null, detectable, note: detectable ? RESIDUAL_PARTIAL_NOTE : RESIDUAL_UNDETECTABLE_NOTE };
  }
  const count = workloads.reduce((total, workload) => total + (workload.residualBillableResources.count || 0), 0);
  if (count > 0) {
    return { state: "present", count, detectable: true, note: "A residual-resource detector reported provider resources. Billability is not verified by AnxOS." };
  }
  return { state: "none-detected", count: 0, detectable: true, note: "A residual-resource detector ran for every exposure and reported none." };
}

async function getExposureDiagnosticsSnapshot(options = {}) {
  const routes = listReverseProxyRoutes(options);
  const records = readCertificateRecords(options);
  const diagnostics = readDiagnosticsRegistry(options);
  const accessServices = readAccessServicesForDiagnostics(options);

  const routeWorkloads = routes.slice(0, MAX_DIAGNOSTIC_WORKLOADS).map((route) => buildRouteDiagnosticsWorkload(route, records, diagnostics, options));
  const remaining = Math.max(0, MAX_DIAGNOSTIC_WORKLOADS - routeWorkloads.length);
  const serviceWorkloads = accessServices.services.slice(0, remaining).map((service) => buildServiceDiagnosticsWorkload(service, diagnostics, options));
  const workloads = [...routeWorkloads, ...serviceWorkloads];

  const counts = { [PROVISIONING_KNOWN_SUCCEEDED]: 0, [PROVISIONING_KNOWN_FAILED]: 0, [PROVISIONING_UNKNOWN]: 0 };
  for (const workload of workloads) counts[workload.provisioning.state] += 1;
  const overall = summarizeProvisioning(workloads, counts);

  return sanitizeForDiagnostics({
    ok: true,
    supported: true,
    platform: process.platform,
    checkedAt: new Date().toISOString(),
    maxWorkloads: MAX_DIAGNOSTIC_WORKLOADS,
    workloadCount: workloads.length,
    provisioning: {
      state: overall.state,
      reason: overall.reason,
      message: overall.message,
      counts,
      knownSucceeded: counts[PROVISIONING_KNOWN_SUCCEEDED],
      knownFailed: counts[PROVISIONING_KNOWN_FAILED],
      unknown: counts[PROVISIONING_UNKNOWN],
    },
    workloads,
    residualBillableResources: summarizeResidual(workloads),
    recordedDiagnostics: {
      available: diagnostics.available,
      source: diagnostics.source,
      code: diagnostics.code,
      message: diagnostics.message,
    },
    accessServiceRegistry: {
      available: accessServices.available,
      code: accessServices.code,
      message: accessServices.message,
    },
    activation: { ...ACTIVATION_UNAVAILABLE },
    certificateIssuance: { ...ISSUANCE_UNAVAILABLE },
  });
}

module.exports = {
  ACTIVATION_UNAVAILABLE,
  CERTIFICATES_FILE_NAME,
  DIAGNOSTICS_FILE_NAME,
  ISSUANCE_UNAVAILABLE,
  MAX_DIAGNOSTIC_WORKLOADS,
  PROVISIONING_KNOWN_FAILED,
  PROVISIONING_KNOWN_SUCCEEDED,
  PROVISIONING_UNKNOWN,
  ROUTES_FILE_NAME,
  SCHEMA_VERSION,
  applyReverseProxyRoute,
  buildRouteCertificateReport,
  buildServiceDiagnosticsWorkload,
  certificateForHostname,
  diagnosticsFilePath,
  getExposureDiagnosticsSnapshot,
  getReverseProxySnapshot,
  listReverseProxyRoutes,
  probeUpstreamReachability,
  readCertificateRecords,
  readDiagnosticsRegistry,
  readRouteRegistry,
  routesFilePath,
  certificatesFilePath,
  writeRouteRegistry,
  _test: {
    atomicWriteJson,
    buildProvisioningReport,
    normalizeRecordedError,
    normalizeResidualResource,
    normalizeStoredRoute,
    summarizeProvisioning,
    summarizeResidual,
  },
};