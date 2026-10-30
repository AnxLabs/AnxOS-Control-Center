"use strict";

// AIM-2 functional probe adapters (plan §4.2). Each adapter declares:
//   - liveness: the existing "is it up?" request,
//   - probes:   declarative, bounded requests that read state (never write it;
//               Open Terminal's session open/close is the one marked stateful),
//   - evaluate: a pure function from probe responses + baseline/config to a
//               functional result (functionalProbeModel vocabulary).
//
// Nothing here performs I/O. Responses are plain { status, body } objects, so
// the same evaluators run against hermetic fixtures in tests and, later, real
// responses from an executor. planProbeRun() is the authorization gate that
// executor must call first; it encodes the AIM-0 sign-off (2026-10-30):
// every live run is deferred until the Owner approves a specific scope,
// production scopes are probed on demand only, and stateful probes need a
// per-scope opt-in.
//
// Probe paths marked pathsVerified: false are design placeholders: they have
// not been checked against the deployed service versions, and the hermetic
// fixtures exercise only the evaluators. An executor must refuse an adapter
// whose paths are unverified until the approved live run pins them.
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

// Open WebUI / ANX-CorTex (incident C1): the workspace must still belong to the
// baseline owner and hold at least the baseline's objects; configured tool and
// terminal references must resolve.
const WORKSPACE_KINDS = Object.freeze(["knowledgeBases", "prompts", "tools", "skills", "notes"]);

const openWebUi = Object.freeze({
  id: "open-webui",
  pathsVerified: false,
  label: "Open WebUI / ANX-CorTex",
  stateful: false,
  liveness: Object.freeze({ method: "GET", path: "/health" }),
  probes: Object.freeze([
    Object.freeze({ id: "owner", method: "GET", path: "/api/v1/auths/", auth: "read-only-account" }),
    Object.freeze({ id: "counts", method: "GET", path: "/api/v1/workspace/summary", auth: "read-only-account" }),
  ]),
  evaluate({ credentialConfigured = false, baseline = null, responses = {}, references = [] } = {}) {
    if (!credentialConfigured) return notEvaluated(R.NO_CREDENTIAL);
    if (!baseline) return notEvaluated(R.NO_BASELINE);
    const { owner, counts } = responses;
    if (missingResponse(owner, counts)) return notEvaluated(R.NO_RESPONSE);
    const rejected = authFailure(owner, true) || authFailure(counts, true);
    if (rejected) return rejected;
    if (!OK(owner) || !OK(counts)) return fromFindings({ failures: [finding(C.PROBE_ERROR, { status: OK(owner) ? counts.status : owner.status })] });
    const failures = [];
    if (baseline.ownerIdentityHash && owner.body?.ownerIdentityHash !== baseline.ownerIdentityHash) {
      failures.push(finding(C.IDENTITY_CHANGED, { expected: baseline.ownerIdentityHash, actual: owner.body?.ownerIdentityHash || null }));
    }
    const missing = {};
    for (const kind of WORKSPACE_KINDS) {
      const expected = Number(baseline.counts?.[kind]);
      const actual = Number(counts.body?.[kind]);
      if (Number.isFinite(expected) && !(Number.isFinite(actual) && actual >= expected)) {
        missing[kind] = { baseline: expected, actual: Number.isFinite(actual) ? actual : null };
      }
    }
    if (Object.keys(missing).length) failures.push(finding(C.WORKSPACE_OBJECTS_MISSING, { missing }));
    const dangling = references.filter((reference) => reference && reference.resolves !== true);
    if (dangling.length) failures.push(finding(C.DANGLING_DEPENDENCY, { references: dangling.map(({ name, target }) => ({ name, target })) }));
    return fromFindings({ failures });
  },
});

// Qdrant (incident C3): authenticated collection read; expected collections
// present and non-empty, point counts within tolerance of the baseline, and
// the app actually wired to this Qdrant.
const qdrant = Object.freeze({
  id: "qdrant",
  pathsVerified: true,
  label: "Qdrant",
  stateful: false,
  liveness: Object.freeze({ method: "GET", path: "/healthz" }),
  probes: Object.freeze([
    Object.freeze({ id: "collections", method: "GET", path: "/collections", auth: "api-key" }),
    Object.freeze({ id: "collectionInfo", method: "GET", path: "/collections/{name}", auth: "api-key", perExpectedCollection: true }),
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

// Ollama: expected models installed. The tiny generation probe is GPU work and
// stays on-demand only (not declared here).
const ollama = Object.freeze({
  id: "ollama",
  pathsVerified: true,
  label: "Ollama",
  stateful: false,
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
  pathsVerified: true,
  label: "Infinity embeddings",
  stateful: false,
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

// Tika: parsing a bundled tiny fixture returns the expected text.
const tika = Object.freeze({
  id: "tika",
  pathsVerified: true,
  label: "Apache Tika",
  stateful: false,
  liveness: Object.freeze({ method: "GET", path: "/tika" }),
  probes: Object.freeze([Object.freeze({ id: "parse", method: "PUT", path: "/tika", body: "fixture:anxos-functional-probe.txt", accept: "text/plain" })]),
  evaluate({ expectedText = null, responses = {} } = {}) {
    if (!expectedText) return notEvaluated(R.NO_BASELINE);
    const { parse } = responses;
    if (missingResponse(parse)) return notEvaluated(R.NO_RESPONSE);
    if (!OK(parse)) return fromFindings({ failures: [finding(C.PROBE_ERROR, { status: parse.status })] });
    return String(parse.body || "").includes(expectedText) ? pass() : fromFindings({ failures: [finding(C.PARSE_MISMATCH, { expected: expectedText })] });
  },
});

// Open Terminal: authenticated session open/close, never a command. Opening a
// session is a small state change, so it is the one stateful probe.
const openTerminal = Object.freeze({
  id: "open-terminal",
  pathsVerified: false,
  label: "Open Terminal",
  stateful: true,
  liveness: Object.freeze({ method: "GET", path: "/health" }),
  probes: Object.freeze([
    Object.freeze({ id: "sessionOpen", method: "POST", path: "/api/sessions", auth: "read-only-account", stateful: true }),
    Object.freeze({ id: "sessionClose", method: "DELETE", path: "/api/sessions/{id}", auth: "read-only-account", stateful: true }),
  ]),
  evaluate({ credentialConfigured = false, responses = {} } = {}) {
    if (!credentialConfigured) return notEvaluated(R.NO_CREDENTIAL);
    const { sessionOpen, sessionClose } = responses;
    if (missingResponse(sessionOpen)) return notEvaluated(R.NO_RESPONSE);
    const rejected = authFailure(sessionOpen, true);
    if (rejected) return rejected;
    if (!OK(sessionOpen) || !OK(sessionClose)) return fromFindings({ failures: [finding(C.SESSION_FAILED, { openStatus: sessionOpen.status, closeStatus: sessionClose?.status ?? null })] });
    return pass();
  },
});

const FUNCTIONAL_ADAPTERS = Object.freeze({
  [openWebUi.id]: openWebUi,
  [qdrant.id]: qdrant,
  [ollama.id]: ollama,
  [infinity.id]: infinity,
  [tika.id]: tika,
  [openTerminal.id]: openTerminal,
});

// Config-reference check (incident C4): every reference a service's
// configuration makes (tool servers, terminals, vector DB URLs) must resolve to
// something in the inventory. Repairing one is an R3 proposal, never automatic.
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
//   scope.classification   — "production" unless the Owner confirmed otherwise,
//   scope.optIns[adapter]  — per-scope opt-in for stateful probes.
function planProbeRun(adapter, scope = {}, { trigger = "on-demand" } = {}) {
  if (!adapter || !FUNCTIONAL_ADAPTERS[adapter.id]) return notEvaluated(R.NOT_APPLICABLE);
  if (adapter.pathsVerified !== true) return notEvaluated(R.NOT_APPLICABLE, { detail: "Probe paths not yet verified against the deployed service." });
  if (scope.liveRunApproved !== true) return notEvaluated(R.LIVE_RUNS_DEFERRED);
  const production = scope.classification !== "non-production";
  // No scheduled opt-ins have been granted for production scopes.
  if (production && trigger !== "on-demand") return notEvaluated(R.OPT_IN_REQUIRED);
  if (adapter.stateful && production && scope.optIns?.[adapter.id] !== true) return notEvaluated(R.OPT_IN_REQUIRED);
  return null;
}

module.exports = {
  FUNCTIONAL_ADAPTERS,
  WORKSPACE_KINDS,
  evaluateConfigReferences,
  evaluateDeclaredDependencies,
  planProbeRun,
};
