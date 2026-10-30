"use strict";

// AIM-2 functional correctness contracts (plan §4.2): the result vocabulary
// and how a service's functional state combines with its liveness.
//
// Liveness ("is it up?") comes from healthModel. A functional probe answers
// "does it actually work for what we use it for?" and returns exactly one of:
//
//   pass                        — the contract holds,
//   degraded:<code>             — usable, but drifting from its baseline,
//   fail:<code>                 — the contract is broken,
//   not-evaluated:<reason>      — nothing was checked (no baseline, live runs
//                                 deferred, opt-in required, ...).
//
// Overall status is the worse of liveness and function, and "not-evaluated"
// maps to healthModel's "unknown", which outranks healthy: an unchecked
// service can never render green (the no-fake-green contract).
//
// Dependency-free apart from healthModel (both live in src/shared, which is
// copied into the Agent runtime): no Electron, no fs, no network.

const healthModel = require("./healthModel");

const CONTRACT_VERSION = 1;

const FUNCTIONAL_OUTCOMES = Object.freeze(["pass", "degraded", "fail", "not-evaluated"]);

// Closed set of failure/degradation codes. C-numbers refer to the incidents in
// plan §2.2 that each code would have caught.
const FUNCTIONAL_CODES = Object.freeze({
  AUTH_REQUIRED: "AUTH_REQUIRED", // the service needs a credential; probes never send one
  AUTH_INVALID: "AUTH_INVALID", // a credential was sent and rejected (C3)
  COLLECTION_MISSING: "COLLECTION_MISSING", // an expected Qdrant collection is absent (C3)
  EMPTY: "EMPTY", // the collection exists but holds no points (C3)
  POINTS_BELOW_BASELINE: "POINTS_BELOW_BASELINE", // fewer points than the baseline allows (C3)
  NOT_WIRED: "NOT_WIRED", // data is healthy but not the backend the app uses (C3)
  IDENTITY_CHANGED: "IDENTITY_CHANGED", // the service answering is not the expected application
  VERSION_CHANGED: "VERSION_CHANGED", // running a different version than the Owner recorded
  DANGLING_DEPENDENCY: "DANGLING_DEPENDENCY", // a configured reference resolves to nothing (C4)
  DEPENDENCY_DOWN: "DEPENDENCY_DOWN", // a dependency the configuration uses is not healthy (C6)
  MODEL_MISSING: "MODEL_MISSING", // an expected Ollama model is not installed
  DIMENSION_MISMATCH: "DIMENSION_MISMATCH", // Infinity embedding has the wrong dimension
  PARSE_MISMATCH: "PARSE_MISMATCH", // Tika returned unexpected text for the fixture
  PROBE_ERROR: "PROBE_ERROR", // the probe itself failed (timeout, unexpected status)
});

const NOT_EVALUATED_REASONS = Object.freeze({
  NO_BASELINE: "NO_BASELINE", // nothing to compare against yet
  OPT_IN_REQUIRED: "OPT_IN_REQUIRED", // scheduled probes need an Owner opt-in the scope doesn't have
  LIVE_RUNS_DEFERRED: "LIVE_RUNS_DEFERRED", // AIM-0: live runs need a separately approved scope
  NOT_APPLICABLE: "NOT_APPLICABLE", // the probe doesn't apply to this service/configuration
  NO_RESPONSE: "NO_RESPONSE", // no probe response was available to evaluate
});

// How dependencies render. "not-in-use" is neutral: the configuration doesn't
// use it, so its state must not make the dependent service look broken (C6).
const DEPENDENCY_USAGE = Object.freeze(["in-use", "not-in-use"]);

// Severity within one probe's findings: the outcome reports the most severe.
const OUTCOME_RANK = Object.freeze({ pass: 0, degraded: 1, "not-evaluated": 2, fail: 3 });

// Functional outcome -> healthModel state, so combination reuses worstState().
const OUTCOME_TO_HEALTH_STATE = Object.freeze({
  pass: "healthy",
  degraded: "degraded",
  fail: "failed",
  "not-evaluated": "unknown",
});

const CODE_VALUES = new Set(Object.values(FUNCTIONAL_CODES));
const REASON_VALUES = new Set(Object.values(NOT_EVALUATED_REASONS));

function finding(code, details = {}) {
  if (!CODE_VALUES.has(code)) throw new Error(`Unknown functional code: ${code}`);
  return Object.freeze({ code, ...details });
}

function pass(details = {}) {
  return Object.freeze({ outcome: "pass", code: null, reason: null, findings: Object.freeze([]), ...details });
}

function degraded(code, details = {}) {
  return result("degraded", [finding(code, details.finding || {})], details);
}

function fail(code, details = {}) {
  return result("fail", [finding(code, details.finding || {})], details);
}

function notEvaluated(reason, details = {}) {
  if (!REASON_VALUES.has(reason)) throw new Error(`Unknown not-evaluated reason: ${reason}`);
  const { finding: _ignored, ...rest } = details;
  return Object.freeze({ outcome: "not-evaluated", code: null, reason, findings: Object.freeze([]), ...rest });
}

function result(outcome, findings, details = {}) {
  const { finding: _ignored, ...rest } = details;
  return Object.freeze({ outcome, code: findings[0]?.code || null, reason: null, findings: Object.freeze(findings), ...rest });
}

// Builds a result from several findings: "fail" if any finding is a failure,
// otherwise "degraded", otherwise pass. The reported code is the first failure
// (or first degradation) in the order the evaluator produced them.
function fromFindings({ failures = [], degradations = [] } = {}, details = {}) {
  if (failures.length) return result("fail", [...failures, ...degradations], details);
  if (degradations.length) return result("degraded", degradations, details);
  return pass(details);
}

// "fail:AUTH_INVALID", "not-evaluated:NO_BASELINE", "pass" — the plan's wire form.
function formatOutcome(functional) {
  if (!functional || !FUNCTIONAL_OUTCOMES.includes(functional.outcome)) return "not-evaluated:NO_RESPONSE";
  if (functional.outcome === "pass") return "pass";
  if (functional.outcome === "not-evaluated") return `not-evaluated:${functional.reason}`;
  return `${functional.outcome}:${functional.code}`;
}

// Health and Functional are reported separately; overall is the worse of the
// two using healthModel ranks. Missing or malformed functional input is
// treated as not evaluated, never as pass.
function combineHealthAndFunctional(livenessState, functional) {
  // An unrecognised liveness value is evidence-quality data: treat it as unknown.
  const liveness = healthModel.CONNECTIVITY_STATES.includes(livenessState) ? livenessState : "unknown";
  const outcome = functional && FUNCTIONAL_OUTCOMES.includes(functional.outcome) ? functional.outcome : "not-evaluated";
  const functionalState = OUTCOME_TO_HEALTH_STATE[outcome];
  // Liveness and function jointly describe one service: any failure fails it,
  // and missing evidence (unknown) taints it.
  const overall = healthModel.combineStates([liveness, functionalState]);
  return Object.freeze({
    liveness,
    functional: functionalState,
    functionalOutcome: formatOutcome(functional || null),
    overall,
    // The only way to render green: both answered and both healthy.
    renderGreen: overall === "healthy" && outcome === "pass",
  });
}

function worstOutcome(results = []) {
  return results.reduce((worst, current) => {
    const outcome = current?.outcome && FUNCTIONAL_OUTCOMES.includes(current.outcome) ? current.outcome : "not-evaluated";
    return OUTCOME_RANK[outcome] > OUTCOME_RANK[worst] ? outcome : worst;
  }, "pass");
}

module.exports = {
  CONTRACT_VERSION,
  DEPENDENCY_USAGE,
  FUNCTIONAL_CODES,
  FUNCTIONAL_OUTCOMES,
  NOT_EVALUATED_REASONS,
  OUTCOME_TO_HEALTH_STATE,
  combineHealthAndFunctional,
  degraded,
  fail,
  finding,
  formatOutcome,
  fromFindings,
  notEvaluated,
  pass,
  worstOutcome,
};
