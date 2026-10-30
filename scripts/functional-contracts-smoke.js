#!/usr/bin/env node
"use strict";

// AIM-2 acceptance (plan §AIM-2), hermetic only: fixture replays of incidents
// C1, C3, C4 and C6 must produce WORKSPACE_OBJECTS_MISSING / IDENTITY_CHANGED,
// AUTH_INVALID vs COLLECTION_MISSING vs NOT_WIRED, DANGLING_DEPENDENCY and
// not-in-use respectively, while liveness reports healthy; and a functional
// state that was not evaluated never renders green. No network, no live
// services: AIM-0 (signed 2026-10-30) defers every live run.
// Run: node scripts/functional-contracts-smoke.js

const assert = require("assert");
const model = require("../src/shared/functionalProbeModel");
const {
  FUNCTIONAL_ADAPTERS: A,
  evaluateConfigReferences,
  evaluateDeclaredDependencies,
  planProbeRun,
} = require("../src/shared/functionalProbeAdapters");

let results = 0;
const pass = (label) => { results += 1; console.log(`PASS ${label}`); };
const codes = (functional) => functional.findings.map((entry) => entry.code);
const LIVE = "healthy"; // liveness for every incident replay: the service is up

// C1 — Open WebUI redeploy: the app answered /health, but the workspace now
// belonged to a different owner and most objects were gone.
const c1Baseline = { ownerIdentityHash: "sha256:owner-anx", counts: { knowledgeBases: 6, prompts: 14, tools: 5, skills: 3, notes: 9 } };
const c1 = A["open-webui"].evaluate({
  credentialConfigured: true,
  baseline: c1Baseline,
  responses: {
    owner: { status: 200, body: { ownerIdentityHash: "sha256:fresh-install-admin" } },
    counts: { status: 200, body: { knowledgeBases: 0, prompts: 2, tools: 5, skills: 0, notes: 9 } },
  },
});
assert.strictEqual(c1.outcome, "fail");
assert.deepStrictEqual(codes(c1), ["IDENTITY_CHANGED", "WORKSPACE_OBJECTS_MISSING"]);
assert.deepStrictEqual(Object.keys(c1.findings[1].missing).sort(), ["knowledgeBases", "prompts", "skills"]);
let combined = model.combineHealthAndFunctional(LIVE, c1);
assert.deepStrictEqual([combined.liveness, combined.functional, combined.overall, combined.renderGreen], ["healthy", "failed", "failed", false]);
assert.strictEqual(combined.functionalOutcome, "fail:IDENTITY_CHANGED");
pass("C1 a healthy-looking Open WebUI with a new owner and missing objects fails functionally");

// C3 — Qdrant: three distinct failures that liveness can't tell apart.
const qdrantBase = { credentialConfigured: true, expectedCollections: ["anx-cortex-m5"], baseline: { points: { "anx-cortex-m5": 1200 } } };
const okCollections = { status: 200, body: { result: { collections: [{ name: "anx-cortex-m5" }] } } };
const okInfo = { "anx-cortex-m5": { status: 200, body: { result: { points_count: 1200 } } } };
const c3Auth = A.qdrant.evaluate({ ...qdrantBase, responses: { collections: { status: 401 } } });
const c3AuthNoCredential = A.qdrant.evaluate({ ...qdrantBase, credentialConfigured: false, responses: { collections: { status: 401 } } });
const c3Missing = A.qdrant.evaluate({ ...qdrantBase, responses: { collections: { status: 200, body: { result: { collections: [{ name: "recovery-copy" }] } } } } });
const c3NotWired = A.qdrant.evaluate({ ...qdrantBase, responses: { collections: okCollections, collectionInfo: okInfo }, wiring: { appBackend: "qdrant-windows-original", probedService: "qdrant-recovery" } });
const c3Empty = A.qdrant.evaluate({ ...qdrantBase, responses: { collections: okCollections, collectionInfo: { "anx-cortex-m5": { status: 200, body: { result: { points_count: 0 } } } } } });
const c3Drift = A.qdrant.evaluate({ ...qdrantBase, responses: { collections: okCollections, collectionInfo: { "anx-cortex-m5": { status: 200, body: { result: { points_count: 1000 } } } } } });
const c3Ok = A.qdrant.evaluate({ ...qdrantBase, responses: { collections: okCollections, collectionInfo: okInfo }, wiring: { appBackend: "qdrant-recovery", probedService: "qdrant-recovery" } });
assert.strictEqual(model.formatOutcome(c3Auth), "fail:AUTH_INVALID");
assert.strictEqual(model.formatOutcome(c3AuthNoCredential), "fail:AUTH_REQUIRED");
assert.strictEqual(model.formatOutcome(c3Missing), "fail:COLLECTION_MISSING");
assert.strictEqual(model.formatOutcome(c3NotWired), "fail:NOT_WIRED");
assert.strictEqual(model.formatOutcome(c3Empty), "fail:EMPTY");
assert.strictEqual(model.formatOutcome(c3Drift), "degraded:POINTS_BELOW_BASELINE");
assert.strictEqual(model.formatOutcome(c3Ok), "pass");
for (const functional of [c3Auth, c3Missing, c3NotWired]) {
  assert.strictEqual(model.combineHealthAndFunctional(LIVE, functional).overall, "failed");
}
assert.strictEqual(model.combineHealthAndFunctional(LIVE, c3Drift).overall, "degraded");
assert.strictEqual(model.combineHealthAndFunctional(LIVE, c3Ok).renderGreen, true);
pass("C3 Qdrant distinguishes AUTH_INVALID / AUTH_REQUIRED / COLLECTION_MISSING / NOT_WIRED / EMPTY / drift while liveness is healthy");

// C4 — a tool-server reference pointed at a stack that no longer existed.
const c4 = evaluateConfigReferences({
  references: [
    { from: "open-webui", setting: "TOOL_SERVER_CONNECTIONS[0].url", target: "open-terminal:8000" },
    { from: "open-webui", setting: "QDRANT_URI", target: "qdrant:6333" },
  ],
  knownTargets: ["qdrant:6333", "ollama:11434"],
});
assert.strictEqual(model.formatOutcome(c4), "fail:DANGLING_DEPENDENCY");
assert.deepStrictEqual(c4.findings[0].references.map((reference) => reference.target), ["open-terminal:8000"]);
assert.strictEqual(model.combineHealthAndFunctional(LIVE, c4).overall, "failed");
assert.strictEqual(model.formatOutcome(evaluateConfigReferences({ references: [{ target: "qdrant:6333" }], knownTargets: ["QDRANT:6333"] })), "pass");
pass("C4 a configured reference that resolves to nothing is DANGLING_DEPENDENCY");

// C6 — services the configuration doesn't use rendered as "down" and alarmed.
const c6 = evaluateDeclaredDependencies({
  declared: ["qdrant", "ollama"],
  dependencies: [
    { id: "qdrant", liveness: "healthy" },
    { id: "ollama", liveness: "healthy" },
    { id: "searxng", liveness: "failed" },
    { id: "tika", liveness: "unknown" },
  ],
});
assert.deepStrictEqual(c6.usage.map((entry) => `${entry.id}:${entry.usage}`), ["qdrant:in-use", "ollama:in-use", "searxng:not-in-use", "tika:not-in-use"]);
assert.strictEqual(model.formatOutcome(c6.functional), "pass", "unused, failing dependencies do not fail the service");
assert.strictEqual(model.combineHealthAndFunctional(LIVE, c6.functional).renderGreen, true);
const c6Down = evaluateDeclaredDependencies({ declared: ["qdrant"], dependencies: [{ id: "qdrant", liveness: "failed" }] });
assert.strictEqual(model.formatOutcome(c6Down.functional), "fail:DEPENDENCY_DOWN");
const c6Absent = evaluateDeclaredDependencies({ declared: ["infinity"], dependencies: [] });
assert.strictEqual(model.formatOutcome(c6Absent.functional), "fail:DANGLING_DEPENDENCY");
pass("C6 dependencies the configuration doesn't use are not-in-use (neutral); used ones that are down still fail");

// No fake green: anything not evaluated, missing or malformed is never green.
for (const [label, functional] of [
  ["no baseline", A.qdrant.evaluate({ responses: {} })],
  ["no credential", A["open-webui"].evaluate({ baseline: c1Baseline })],
  ["no response", A.ollama.evaluate({ expectedModels: ["llama3"] })],
  ["missing functional result", undefined],
  ["malformed functional result", { outcome: "green" }],
]) {
  const view = model.combineHealthAndFunctional("healthy", functional);
  assert.strictEqual(view.renderGreen, false, label);
  assert.strictEqual(view.overall, "unknown", label);
  assert.ok(view.functionalOutcome.startsWith("not-evaluated:"), label);
}
assert.strictEqual(model.combineHealthAndFunctional("running", model.pass()).overall, "unknown", "an unrecognised liveness value is unknown, never healthy");
assert.strictEqual(model.combineHealthAndFunctional("failed", model.pass()).overall, "failed", "a passing probe can't hide a dead service");
pass("NFG not-evaluated, missing and malformed functional states never render green");

// Other adapters behave on their fixtures.
assert.strictEqual(model.formatOutcome(A.ollama.evaluate({ expectedModels: ["llama3:8b", "nomic-embed-text"], responses: { tags: { status: 200, body: { models: [{ name: "llama3:8b" }] } } } })), "fail:MODEL_MISSING");
assert.strictEqual(model.formatOutcome(A.infinity.evaluate({ expectedDimension: 768, responses: { embedding: { status: 200, body: { data: [{ embedding: new Array(384).fill(0) }] } } } })), "fail:DIMENSION_MISMATCH");
assert.strictEqual(model.formatOutcome(A.infinity.evaluate({ expectedDimension: 768, responses: { embedding: { status: 200, body: { data: [{ embedding: new Array(768).fill(0) }] } } } })), "pass");
assert.strictEqual(model.formatOutcome(A.tika.evaluate({ expectedText: "AnxOS functional probe", responses: { parse: { status: 200, body: "garbled" } } })), "fail:PARSE_MISMATCH");
assert.strictEqual(model.formatOutcome(A["open-terminal"].evaluate({ credentialConfigured: true, responses: { sessionOpen: { status: 201 }, sessionClose: { status: 500 } } })), "fail:SESSION_FAILED");
pass("ADP Ollama, Infinity, Tika and Open Terminal evaluators report their own codes");

// Authorization gate = the AIM-0 sign-off in code.
const qdrantAdapter = A.qdrant;
assert.strictEqual(planProbeRun(qdrantAdapter, {}).reason, "LIVE_RUNS_DEFERRED", "no scope approved: every live run is deferred");
assert.strictEqual(planProbeRun(qdrantAdapter, { classification: "non-production" }).reason, "LIVE_RUNS_DEFERRED", "non-production alone is not approval");
assert.strictEqual(planProbeRun(qdrantAdapter, { liveRunApproved: true, classification: "production" }, { trigger: "schedule" }).reason, "OPT_IN_REQUIRED", "no scheduled probes against production");
assert.strictEqual(planProbeRun(qdrantAdapter, { liveRunApproved: true, classification: "production" }), null, "an approved on-demand read may run");
assert.strictEqual(planProbeRun(qdrantAdapter, { liveRunApproved: true, classification: "non-production" }, { trigger: "schedule" }), null);
assert.strictEqual(planProbeRun(A["open-terminal"], { liveRunApproved: true, classification: "production" }).reason, "NOT_APPLICABLE", "unverified probe paths are refused");
assert.strictEqual(planProbeRun(A["open-webui"], { liveRunApproved: true, classification: "non-production" }).reason, "NOT_APPLICABLE");
assert.strictEqual(planProbeRun({ id: "made-up" }, { liveRunApproved: true }).reason, "NOT_APPLICABLE");
pass("GATE live runs deferred without Owner approval; production on demand only; unverified adapters refused");

// Contract shape: probes are declarative and only Open Terminal is stateful.
for (const adapter of Object.values(A)) {
  assert.ok(adapter.liveness?.method === "GET", `${adapter.id} liveness is a GET`);
  assert.ok(Array.isArray(adapter.probes) && adapter.probes.length > 0, `${adapter.id} declares probes`);
  assert.strictEqual(typeof adapter.evaluate, "function");
  assert.strictEqual(adapter.stateful, adapter.id === "open-terminal", `${adapter.id} stateful flag`);
  assert.strictEqual(typeof adapter.pathsVerified, "boolean");
}
assert.throws(() => model.fail("MADE_UP_CODE"), /Unknown functional code/);
assert.throws(() => model.notEvaluated("BECAUSE"), /Unknown not-evaluated reason/);
pass("SHAPE adapters are declarative; the code and reason vocabularies are closed");

console.log(`functional contracts smoke passed (${results} checks).`);
