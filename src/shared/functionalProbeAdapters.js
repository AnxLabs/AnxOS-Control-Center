"use strict";

// AIM-2 functional probe adapters (plan §4.2). Each adapter declares:
//   - liveness: the existing "is it up?" request,
//   - probes:   declarative, bounded, read-only requests,
//   - evaluate: a pure function from probe responses + baseline/config to a
//               functional result (functionalProbeModel vocabulary).
//
// Supported services: Sona (the Owner's active AnxLabs AI application) and the
// general-purpose AI services Qdrant, Ollama, Infinity and Tika. Open WebUI,
// Open Terminal and ANX-CorTex are discontinued (Owner, 2026-10-30) and have no
// adapters; their repositories, volumes and records are left untouched.
//
// Nothing here performs I/O. Responses are plain { status, body } objects, so
// the same evaluators run against hermetic fixtures in tests and real responses
// from the executor (src/services/functionalProbeService.js). planProbeRun() is
// the authorization gate that executor must call first; it encodes the AIM-0
// sign-off (2026-10-30): every live run is deferred until the Owner approves a
// specific scope, and production scopes are probed on demand only.
//
// Only unauthenticated, read-only endpoints are probed. No adapter sends or
// stores credentials, and probe targets come from the Owner's scope file,
// never from service configuration.
//
// Dependency-free apart from src/shared (copied into the Agent runtime).

const {
  FUNCTIONAL_CODES: C,
  NOT_EVALUATED_REASONS: R,
  finding,
  fromFindings,
  notEvaluated,
  pass,
} = require("./functionalProbeModel");

const OK = (response) => Number.isInteger(response?.status) && response.status >= 200 && response.status < 300;
const AUTH_REJECTED = (response) => response?.status === 401 || response?.status === 403;
const DEFAULT_POINT_TOLERANCE = 0.02;

function authFailure(response, credentialConfigured) {
  if (!AUTH_REJECTED(response)) return null;
  return fromFindings({ failures: [finding(credentialConfigured ? C.AUTH_INVALID : C.AUTH_REQUIRED, { status: response.status })] });
}

function missingResponse(...responses) {
  return responses.some((response) => !response || !Number.isInteger(response.status));
}

// Sona backend (anxlabs/sona-api, Compose project "sona", service "api").
// Verified against Sona 8.5.0: uvicorn binds 127.0.0.1:8790 on the Debian host
// and GET /api/health is public, returning { status: "ok", app: "sona",
// version }. Sona's own container healthcheck uses the same route. The probe
// confirms the service answering is Sona and, when the Owner recorded one, its
// expected version. Authenticated routes are never called.
const sona = Object.freeze({
  id: "sona",
  label: "Sona",
  pathsVerified: true,
  liveness: Object.freeze({ method: "GET", path: "/api/health" }),
  probes: Object.freeze([Object.freeze({ id: "health", method: "GET", path: "/api/health" })]),
  evaluate({ expectedVersion = null, responses = {} } = {}) {
    const { health } = responses;
    if (missingResponse(health)) return notEvaluated(R.NO_RESPONSE);
    if (!OK(health)) return fromFindings({ failures: [finding(C.PROBE_ERROR, { status: health.status })] });
    const body = health.body && typeof health.body === "object" ? health.body : {};
    if (body.app !== "sona" || body.status !== "ok") {
      // Something answered on Sona's address, but it is not a healthy Sona.
      return fromFindings({ failures: [finding(C.IDENTITY_CHANGED, { expected: "sona", actual: typeof body.app === "string" ? body.app.slice(0, 64) : null })] });
    }
    if (expectedVersion && body.version !== expectedVersion) {
      return fromFindings({ degradations: [finding(C.VERSION_CHANGED, { expected: expectedVersion, actual: typeof body.version === "string" ? body.version.slice(0, 32) : null })] });
    }
    return pass({ version: typeof body.version === "string" ? body.version.slice(0, 32) : null });
  },
});

// The Sona stack's services as declared in its Compose file (deploy/
// docker-compose.yml): the API depends on all of them. sandbox and plugins run
// the API image on Unix sockets with no network; the tunnel (cloudflared)
// carries traffic from the Cloudflare-hosted frontend to the API.
const SONA_STACK = Object.freeze({
  composeProject: "sona",
  apiService: "api",
  apiContainerName: "sona-api",
  dependencies: Object.freeze([
    Object.freeze({ service: "sandbox", containerName: "sona-sandbox", label: "Code sandbox" }),
    Object.freeze({ service: "plugins", containerName: "sona-plugins", label: "Plugin host" }),
    Object.freeze({ service: "claude-code", containerName: "sona-claude-code", label: "Claude Code worker" }),
    Object.freeze({ service: "browser", containerName: "sona-browser", label: "Browser (Playwright)" }),
    Object.freeze({ service: "searxng", containerName: "sona-searxng", label: "Web search (SearXNG)" }),
    Object.freeze({ service: "tunnel", containerName: "sona-tunnel", label: "Cloudflare tunnel" }),
  ]),
});

// Qdrant (incident C3): collection read; expected collections present and
// non-empty, point counts within tolerance of the baseline, and the app
// actually wired to this Qdrant. No API key is sent: an instance that requires
// one reports AUTH_REQUIRED.
const qdrant = Object.freeze({
  id: "qdrant",
  label: "Qdrant",
  pathsVerified: true,
  liveness: Object.freeze({ method: "GET", path: "/healthz" }),
  probes: Object.freeze([
    Object.freeze({ id: "collections", method: "GET", path: "/collections" }),
    Object.freeze({ id: "collectionInfo", method: "GET", path: "/collections/{name}", perExpectedCollection: true }),
  ]),
  evaluate({ credentialConfigured = false, expectedCollections = [], baseline = null, tolerance = DEFAULT_POINT_TOLERANCE, responses = {}, wiring = null } = {}) {
    if (!expectedCollections.length && !baseline) return notEvaluated(R.NO_BASELINE);
    const { collections, collectionInfo = {} } = responses;
    if (missingResponse(collections)) return notEvaluated(R.NO_RESPONSE);
    const rejected = authFailure(collections, credentialConfigured);
    if (rejected) return rejected;
    if (!OK(collections)) return fromFindings({ failures: [finding(C.PROBE_ERROR, { status: collections.status })] });
    const present = new Set((collections.body?.result?.collections || []).map((entry) => entry?.name).filter(Boolean));
    const failures = [];
    const degradations = [];
    for (const name of expectedCollections) {
      if (!present.has(name)) {
        failures.push(finding(C.COLLECTION_MISSING, { collection: name }));
        continue;
      }
      const info = collectionInfo[name];
      const points = Number(info?.body?.result?.points_count);
      if (!OK(info) || !Number.isFinite(points)) {
        failures.push(finding(C.PROBE_ERROR, { collection: name, status: info?.status ?? null }));
        continue;
      }
      if (points === 0) {
        failures.push(finding(C.EMPTY, { collection: name }));
        continue;
      }
      const expectedPoints = Number(baseline?.points?.[name]);
      if (Number.isFinite(expectedPoints) && points < expectedPoints * (1 - tolerance)) {
        degradations.push(finding(C.POINTS_BELOW_BASELINE, { collection: name, baseline: expectedPoints, actual: points }));
      }
    }
    // Healthy data the app isn't using is still a broken RAG (C3's "NOT_WIRED").
    if (wiring && wiring.appBackend && wiring.probedService && wiring.appBackend !== wiring.probedService) {
      failures.push(finding(C.NOT_WIRED, { appBackend: wiring.appBackend, probedService: wiring.probedService }));
    }
    return fromFindings({ failures, degradations });
  },
});

// Ollama: expected models installed. A generation probe is GPU work and is not
// declared.
const ollama = Object.freeze({
  id: "ollama",
  label: "Ollama",
  pathsVerified: true,
  liveness: Object.freeze({ method: "GET", path: "/api/version" }),
  probes: Object.freeze([Object.freeze({ id: "tags", method: "GET", path: "/api/tags" })]),
  evaluate({ expectedModels = [], responses = {} } = {}) {
    if (!expectedModels.length) return notEvaluated(R.NO_BASELINE);
    const { tags } = responses;
    if (missingResponse(tags)) return notEvaluated(R.NO_RESPONSE);
    if (!OK(tags)) return fromFindings({ failures: [finding(C.PROBE_ERROR, { status: tags.status })] });
    const installed = new Set((tags.body?.models || []).map((model) => model?.name).filter(Boolean));
    const missing = expectedModels.filter((name) => !installed.has(name));
    return missing.length ? fromFindings({ failures: [finding(C.MODEL_MISSING, { models: missing })] }) : pass();
  },
});

// Infinity: embedding a fixed string returns the expected dimension. POST, but
// computes only; no stored state changes.
const infinity = Object.freeze({
  id: "infinity",
  label: "Infinity embeddings",
  pathsVerified: true,
  liveness: Object.freeze({ method: "GET", path: "/health" }),
  probes: Object.freeze([Object.freeze({ id: "embedding", method: "POST", path: "/embeddings", body: Object.freeze({ input: ["anxos functional probe"] }) })]),
  evaluate({ expectedDimension = null, responses = {} } = {}) {
    if (!Number.isInteger(expectedDimension)) return notEvaluated(R.NO_BASELINE);
    const { embedding } = responses;
    if (missingResponse(embedding)) return notEvaluated(R.NO_RESPONSE);
    if (!OK(embedding)) return fromFindings({ failures: [finding(C.PROBE_ERROR, { status: embedding.status })] });
    const vector = embedding.body?.data?.[0]?.embedding;
    const actual = Array.isArray(vector) ? vector.length : null;
    return actual === expectedDimension ? pass() : fromFindings({ failures: [finding(C.DIMENSION_MISMATCH, { expected: expectedDimension, actual })] });
  },
});

// Tika: parsing a tiny fixed text returns that text.
const tika = Object.freeze({
  id: "tika",
  label: "Apache Tika",
  pathsVerified: true,
  liveness: Object.freeze({ method: "GET", path: "/tika" }),
  probes: Object.freeze([Object.freeze({ id: "parse", method: "PUT", path: "/tika", body: "AnxOS functional probe", accept: "text/plain" })]),
  evaluate({ expectedText = null, responses = {} } = {}) {
    if (!expectedText) return notEvaluated(R.NO_BASELINE);
    const { parse } = responses;
    if (missingResponse(parse)) return notEvaluated(R.NO_RESPONSE);
    if (!OK(parse)) return fromFindings({ failures: [finding(C.PROBE_ERROR, { status: parse.status })] });
    return String(parse.body || "").includes(expectedText) ? pass() : fromFindings({ failures: [finding(C.PARSE_MISMATCH, { expected: expectedText })] });
  },
});

const FUNCTIONAL_ADAPTERS = Object.freeze({
  [sona.id]: sona,
  [qdrant.id]: qdrant,
  [ollama.id]: ollama,
  [infinity.id]: infinity,
  [tika.id]: tika,
});

// Config-reference check (incident C4): every reference a service's
// configuration makes (vector DB URLs, search or browser endpoints) must
// resolve to something in the inventory. Repairing one is an R3 proposal,
// never automatic.
function evaluateConfigReferences({ references = [], knownTargets = [] } = {}) {
  if (!references.length) return notEvaluated(R.NOT_APPLICABLE);
  const known = new Set(knownTargets.map((target) => String(target).toLowerCase()));
  const dangling = references.filter((reference) => !known.has(String(reference?.target || "").toLowerCase()));
  return dangling.length
    ? fromFindings({ failures: [finding(C.DANGLING_DEPENDENCY, { references: dangling.map(({ from, setting, target }) => ({ from, setting, target })) })] })
    : pass();
}

// Declared expected dependencies (incident C6): a dependency the deployed
// configuration doesn't use renders "not-in-use" (neutral), never "down", and
// cannot fail the dependent service. A used dependency that isn't healthy does.
function evaluateDeclaredDependencies({ declared = [], dependencies = [] } = {}) {
  const used = new Set(declared);
  const usage = dependencies.map((dependency) => Object.freeze({
    id: dependency.id,
    usage: used.has(dependency.id) ? "in-use" : "not-in-use",
    liveness: dependency.liveness || "unknown",
  }));
  const down = usage.filter((entry) => entry.usage === "in-use" && entry.liveness !== "healthy");
  const missing = [...used].filter((id) => !dependencies.some((dependency) => dependency.id === id));
  const failures = [
    ...down.map((entry) => finding(C.DEPENDENCY_DOWN, { dependency: entry.id, liveness: entry.liveness })),
    ...missing.map((id) => finding(C.DANGLING_DEPENDENCY, { dependency: id })),
  ];
  return Object.freeze({ usage: Object.freeze(usage), functional: fromFindings({ failures }) });
}

// The authorization gate an executor must call before any live probe. Returns
// null when the run may proceed, or the not-evaluated result to record.
//   scope.liveRunApproved  — the Owner approved live runs for this exact scope
//                            (AIM-0: none yet; every live run is deferred),
//   scope.classification   — "production" unless the Owner confirmed otherwise.
function planProbeRun(adapter, scope = {}, { trigger = "on-demand" } = {}) {
  if (!adapter || FUNCTIONAL_ADAPTERS[adapter.id] !== adapter) return notEvaluated(R.NOT_APPLICABLE);
  if (adapter.pathsVerified !== true) return notEvaluated(R.NOT_APPLICABLE, { detail: "Probe paths not yet verified against the deployed service." });
  if (scope.liveRunApproved !== true) return notEvaluated(R.LIVE_RUNS_DEFERRED);
  // No scheduled opt-ins have been granted for production scopes.
  if (scope.classification !== "non-production" && trigger !== "on-demand") return notEvaluated(R.OPT_IN_REQUIRED);
  return null;
}

// Recognition. Matching is on the image repository (registry and tag ignored)
// so a pinned or mirrored image still matches. Sona's sandbox and plugin host
// run the same image as its API, so the API is the container whose Compose
// service is "api" (or, without verified Compose labels, named "sona-api").
const IMAGE_PATTERNS = Object.freeze([
  Object.freeze({ adapterId: "sona", pattern: /(^|\/)sona-api$/ }),
  Object.freeze({ adapterId: "qdrant", pattern: /(^|\/)qdrant$/ }),
  Object.freeze({ adapterId: "ollama", pattern: /(^|\/)ollama$/ }),
  Object.freeze({ adapterId: "infinity", pattern: /(^|\/)infinity(-emb)?$/ }),
  Object.freeze({ adapterId: "tika", pattern: /(^|\/)tika$/ }),
]);

function imageRepository(image) {
  const withoutDigest = String(image || "").trim().toLowerCase().split("@")[0];
  const lastSlash = withoutDigest.lastIndexOf("/");
  const lastColon = withoutDigest.lastIndexOf(":");
  // A colon after the last slash is a tag; before it, a registry port.
  return lastColon > lastSlash ? withoutDigest.slice(0, lastColon) : withoutDigest;
}

function composeOf(resource = {}) {
  const components = resource.identity?.components || {};
  return { project: components.composeProject || null, service: components.composeService || null };
}

function isSonaApi(resource) {
  const { project, service } = composeOf(resource);
  if (project || service) return project === SONA_STACK.composeProject && service === SONA_STACK.apiService;
  return resource.name === SONA_STACK.apiContainerName;
}

function recognizeFunctionalService(resource = {}) {
  if (resource?.kind !== "container") return null;
  const repository = imageRepository(resource.details?.image);
  if (!repository) return null;
  const match = IMAGE_PATTERNS.find((entry) => entry.pattern.test(repository));
  if (!match) return null;
  if (match.adapterId === "sona" && !isSonaApi(resource)) return null;
  return FUNCTIONAL_ADAPTERS[match.adapterId];
}

// Sona's dependencies as they appear in the inventory: each declared stack
// service, matched on the same node by Compose project/service (or container
// name), with its container health. Read from the already-collected inventory,
// so it needs no probe and no approval.
function sonaStackDependencies(apiResource, resources = []) {
  const containers = resources.filter((resource) => resource?.kind === "container" && resource.nodeId === apiResource?.nodeId);
  const { project } = composeOf(apiResource);
  return SONA_STACK.dependencies.map((dependency) => {
    const match = containers.find((resource) => {
      const compose = composeOf(resource);
      if (compose.project || compose.service) {
        return compose.project === (project || SONA_STACK.composeProject) && compose.service === dependency.service;
      }
      return resource.name === dependency.containerName;
    });
    const state = match?.health?.state;
    const liveness = state === "healthy" ? "healthy" : state === "degraded" ? "degraded" : state === "failed" || state === "stopped" ? "failed" : "unknown";
    return Object.freeze({ id: dependency.service, label: dependency.label, present: Boolean(match), liveness, resourceKey: match?.key || null });
  });
}

module.exports = {
  FUNCTIONAL_ADAPTERS,
  SONA_STACK,
  evaluateConfigReferences,
  evaluateDeclaredDependencies,
  imageRepository,
  planProbeRun,
  recognizeFunctionalService,
  sonaStackDependencies,
};
