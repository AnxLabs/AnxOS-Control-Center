#!/usr/bin/env node
"use strict";

// AIM-2 acceptance (plan §AIM-2), hermetic only. Fixture replays must produce
// the plan's codes while liveness reports healthy: C3 (Qdrant: AUTH_INVALID vs
// COLLECTION_MISSING vs NOT_WIRED), C4 (DANGLING_DEPENDENCY) and C6
// (not-in-use), plus the Sona contract (the Owner's active AnxLabs AI app). A
// functional state that was not evaluated never renders green. No network: the
// AIM-0 sign-off (2026-10-30) defers every live run.
// Open WebUI, Open Terminal and ANX-CorTex are discontinued (Owner,
// 2026-10-30), so incident C1 (Open WebUI workspace) has no adapter any more.
// Run: node scripts/functional-contracts-smoke.js

const assert = require("assert");
const model = require("../src/shared/functionalProbeModel");
const {
  FUNCTIONAL_ADAPTERS: A,
  SONA_STACK,
  evaluateConfigReferences,
  evaluateDeclaredDependencies,
  planProbeRun,
  recognizeFunctionalService,
  sonaStackDependencies,
} = require("../src/shared/functionalProbeAdapters");

let results = 0;
const pass = (label) => { results += 1; console.log(`PASS ${label}`); };
const LIVE = "healthy"; // liveness for every replay: the service is up

// SONA — GET /api/health, verified against Sona 8.5.0 (public, unauthenticated).
const sonaOk = A.sona.evaluate({ expectedVersion: "8.5.0", responses: { health: { status: 200, body: { status: "ok", app: "sona", version: "8.5.0" } } } });
assert.strictEqual(model.formatOutcome(sonaOk), "pass");
assert.strictEqual(sonaOk.version, "8.5.0");
assert.strictEqual(model.combineHealthAndFunctional(LIVE, sonaOk).renderGreen, true);
const sonaWrongApp = A.sona.evaluate({ responses: { health: { status: 200, body: { status: "ok", app: "something-else" } } } });
assert.strictEqual(model.formatOutcome(sonaWrongApp), "fail:IDENTITY_CHANGED", "another service answering on Sona's address is not Sona");
assert.strictEqual(model.formatOutcome(A.sona.evaluate({ responses: { health: { status: 200, body: { status: "degraded", app: "sona" } } } })), "fail:IDENTITY_CHANGED");
assert.strictEqual(model.formatOutcome(A.sona.evaluate({ responses: { health: { status: 200, body: "<html>login</html>" } } })), "fail:IDENTITY_CHANGED");
const sonaUpgraded = A.sona.evaluate({ expectedVersion: "8.5.0", responses: { health: { status: 200, body: { status: "ok", app: "sona", version: "8.6.0" } } } });
assert.strictEqual(model.formatOutcome(sonaUpgraded), "degraded:VERSION_CHANGED");
assert.strictEqual(model.combineHealthAndFunctional(LIVE, sonaUpgraded).overall, "degraded");
assert.strictEqual(model.formatOutcome(A.sona.evaluate({ responses: { health: { status: 502 } } })), "fail:PROBE_ERROR");
assert.strictEqual(model.formatOutcome(A.sona.evaluate({ responses: {} })), "not-evaluated:NO_RESPONSE");
assert.deepStrictEqual(A.sona.probes.map((probe) => `${probe.method} ${probe.path}`), ["GET /api/health"], "Sona is probed only on its public health route");
pass("SONA the health contract confirms it is Sona (and its expected version); nothing authenticated is called");

// SONA-RECOGNITION — the API, not its sandbox or plugin host (same image).
const sonaContainer = (service, name, state = "healthy") => ({
  kind: "container", key: `h:container:${name}`, name, nodeId: "anxlab", health: { state },
  details: { image: service === "browser" ? "mcr.microsoft.com/playwright:v1.60.0-noble" : "anxlabs/sona-api:1.0.0" },
  identity: { verified: true, components: { composeProject: "sona", composeService: service, name } },
});
const api = sonaContainer("api", "sona-api");
assert.strictEqual(recognizeFunctionalService(api)?.id, "sona");
assert.strictEqual(recognizeFunctionalService(sonaContainer("sandbox", "sona-sandbox")), null, "the sandbox runs the API image but is not the API");
assert.strictEqual(recognizeFunctionalService(sonaContainer("plugins", "sona-plugins")), null);
assert.strictEqual(recognizeFunctionalService({ kind: "container", name: "sona-api", details: { image: "anxlabs/sona-api:1.0.0" }, identity: { verified: false, components: {} } })?.id, "sona", "without Compose labels the container name decides");
assert.strictEqual(recognizeFunctionalService({ kind: "container", name: "sona-sandbox", details: { image: "anxlabs/sona-api:1.0.0" }, identity: { verified: false, components: {} } }), null);
for (const retired of ["ghcr.io/open-webui/open-webui:main", "ghcr.io/example/open-terminal:1"]) {
  assert.strictEqual(recognizeFunctionalService({ kind: "container", name: "x", details: { image: retired } }), null, `${retired} is discontinued and not recognized`);
}
assert.deepStrictEqual(Object.keys(A).sort(), ["infinity", "ollama", "qdrant", "sona", "tika"]);
pass("SONA-RECOGNITION Sona's API is recognized by image + Compose service; retired apps are not recognized");

// SONA-STACK — dependencies from the inventory: a down dependency fails Sona (C6 semantics).
const stack = [api, ...SONA_STACK.dependencies.map((dependency) => sonaContainer(dependency.service, dependency.containerName))];
let deps = sonaStackDependencies(api, stack);
assert.deepStrictEqual(deps.map((dependency) => `${dependency.id}:${dependency.liveness}`), ["sandbox:healthy", "plugins:healthy", "claude-code:healthy", "browser:healthy", "searxng:healthy", "tunnel:healthy"]);
let evaluated = evaluateDeclaredDependencies({ declared: deps.map((d) => d.id), dependencies: deps.filter((d) => d.present).map(({ id, liveness }) => ({ id, liveness })) });
assert.strictEqual(model.formatOutcome(evaluated.functional), "pass");
deps = sonaStackDependencies(api, stack.map((resource) => (resource.name === "sona-tunnel" ? { ...resource, health: { state: "stopped" } } : resource)));
evaluated = evaluateDeclaredDependencies({ declared: deps.map((d) => d.id), dependencies: deps.filter((d) => d.present).map(({ id, liveness }) => ({ id, liveness })) });
assert.strictEqual(model.formatOutcome(evaluated.functional), "fail:DEPENDENCY_DOWN");
assert.strictEqual(evaluated.functional.findings[0].dependency, "tunnel");
deps = sonaStackDependencies(api, stack.filter((resource) => resource.name !== "sona-searxng"));
evaluated = evaluateDeclaredDependencies({ declared: deps.map((d) => d.id), dependencies: deps.filter((d) => d.present).map(({ id, liveness }) => ({ id, liveness })) });
assert.strictEqual(model.formatOutcome(evaluated.functional), "fail:DANGLING_DEPENDENCY", "a declared stack service missing from the host is dangling");
assert.ok(sonaStackDependencies({ ...api, nodeId: "other" }, stack).every((d) => !d.present), "dependencies are matched on the API's own node only");
pass("SONA-STACK the Sona stack's six services come from the inventory; a stopped or missing one fails Sona");

// C3 — Qdrant: distinct failures that liveness can't tell apart.
const qdrantBase = { credentialConfigured: true, expectedCollections: ["knowledge"], baseline: { points: { knowledge: 1200 } } };
const okCollections = { status: 200, body: { result: { collections: [{ name: "knowledge" }] } } };
const okInfo = { knowledge: { status: 200, body: { result: { points_count: 1200 } } } };
const c3 = {
  auth: A.qdrant.evaluate({ ...qdrantBase, responses: { collections: { status: 401 } } }),
  authNoCredential: A.qdrant.evaluate({ ...qdrantBase, credentialConfigured: false, responses: { collections: { status: 401 } } }),
  missing: A.qdrant.evaluate({ ...qdrantBase, responses: { collections: { status: 200, body: { result: { collections: [{ name: "recovery-copy" }] } } } } }),
  notWired: A.qdrant.evaluate({ ...qdrantBase, responses: { collections: okCollections, collectionInfo: okInfo }, wiring: { appBackend: "qdrant-original", probedService: "qdrant-recovery" } }),
  empty: A.qdrant.evaluate({ ...qdrantBase, responses: { collections: okCollections, collectionInfo: { knowledge: { status: 200, body: { result: { points_count: 0 } } } } } }),
  drift: A.qdrant.evaluate({ ...qdrantBase, responses: { collections: okCollections, collectionInfo: { knowledge: { status: 200, body: { result: { points_count: 1000 } } } } } }),
  ok: A.qdrant.evaluate({ ...qdrantBase, responses: { collections: okCollections, collectionInfo: okInfo }, wiring: { appBackend: "qdrant-recovery", probedService: "qdrant-recovery" } }),
};
assert.deepStrictEqual(Object.fromEntries(Object.entries(c3).map(([key, value]) => [key, model.formatOutcome(value)])), {
  auth: "fail:AUTH_INVALID", authNoCredential: "fail:AUTH_REQUIRED", missing: "fail:COLLECTION_MISSING", notWired: "fail:NOT_WIRED",
  empty: "fail:EMPTY", drift: "degraded:POINTS_BELOW_BASELINE", ok: "pass",
});
for (const key of ["auth", "missing", "notWired"]) assert.strictEqual(model.combineHealthAndFunctional(LIVE, c3[key]).overall, "failed");
pass("C3 Qdrant distinguishes AUTH_INVALID / AUTH_REQUIRED / COLLECTION_MISSING / NOT_WIRED / EMPTY / drift while liveness is healthy");

// C4 — a configured reference that resolves to nothing.
const c4 = evaluateConfigReferences({
  references: [
    { from: "sona", setting: "searxng_url", target: "searxng:8080" },
    { from: "sona", setting: "ollama_url", target: "ollama:11434" },
  ],
  knownTargets: ["ollama:11434"],
});
assert.strictEqual(model.formatOutcome(c4), "fail:DANGLING_DEPENDENCY");
assert.deepStrictEqual(c4.findings[0].references.map((reference) => reference.target), ["searxng:8080"]);
assert.strictEqual(model.formatOutcome(evaluateConfigReferences({ references: [{ target: "qdrant:6333" }], knownTargets: ["QDRANT:6333"] })), "pass");
pass("C4 a configured reference that resolves to nothing is DANGLING_DEPENDENCY");

// C6 — dependencies the configuration doesn't use are neutral, never "down".
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
assert.strictEqual(model.formatOutcome(c6.functional), "pass");
assert.strictEqual(model.formatOutcome(evaluateDeclaredDependencies({ declared: ["qdrant"], dependencies: [{ id: "qdrant", liveness: "failed" }] }).functional), "fail:DEPENDENCY_DOWN");
pass("C6 dependencies the configuration doesn't use are not-in-use (neutral); used ones that are down still fail");

// No fake green.
for (const [label, functional] of [
  ["no baseline", A.qdrant.evaluate({ responses: {} })],
  ["no response", A.sona.evaluate({})],
  ["missing functional result", undefined],
  ["malformed functional result", { outcome: "green" }],
]) {
  const view = model.combineHealthAndFunctional("healthy", functional);
  assert.strictEqual(view.renderGreen, false, label);
  assert.strictEqual(view.overall, "unknown", label);
}
assert.strictEqual(model.combineHealthAndFunctional("running", model.pass()).overall, "unknown", "an unrecognised liveness value is unknown, never healthy");
assert.strictEqual(model.combineHealthAndFunctional("failed", model.pass()).overall, "failed", "a passing probe can't hide a dead service");
pass("NFG not-evaluated, missing and malformed functional states never render green");

// General-purpose adapters keep their contracts.
assert.strictEqual(model.formatOutcome(A.ollama.evaluate({ expectedModels: ["llama3:8b", "nomic-embed-text"], responses: { tags: { status: 200, body: { models: [{ name: "llama3:8b" }] } } } })), "fail:MODEL_MISSING");
assert.strictEqual(model.formatOutcome(A.infinity.evaluate({ expectedDimension: 768, responses: { embedding: { status: 200, body: { data: [{ embedding: new Array(384).fill(0) }] } } } })), "fail:DIMENSION_MISMATCH");
assert.strictEqual(model.formatOutcome(A.infinity.evaluate({ expectedDimension: 768, responses: { embedding: { status: 200, body: { data: [{ embedding: new Array(768).fill(0) }] } } } })), "pass");
assert.strictEqual(model.formatOutcome(A.tika.evaluate({ expectedText: "AnxOS functional probe", responses: { parse: { status: 200, body: "garbled" } } })), "fail:PARSE_MISMATCH");
assert.strictEqual(model.formatOutcome(A.tika.evaluate({ expectedText: "AnxOS functional probe", responses: { parse: { status: 200, body: "AnxOS functional probe\n" } } })), "pass");
pass("ADP Ollama, Infinity and Tika evaluators report their own codes");

// Authorization gate = the AIM-0 sign-off in code.
assert.strictEqual(planProbeRun(A.sona, {}).reason, "LIVE_RUNS_DEFERRED", "no scope approved: every live run is deferred");
assert.strictEqual(planProbeRun(A.qdrant, { classification: "non-production" }).reason, "LIVE_RUNS_DEFERRED", "non-production alone is not approval");
assert.strictEqual(planProbeRun(A.sona, { liveRunApproved: true, classification: "production" }, { trigger: "schedule" }).reason, "OPT_IN_REQUIRED", "no scheduled probes against production");
assert.strictEqual(planProbeRun(A.sona, { liveRunApproved: true, classification: "production" }), null, "an approved on-demand read may run");
assert.strictEqual(planProbeRun(A.qdrant, { liveRunApproved: true, classification: "non-production" }, { trigger: "schedule" }), null);
assert.strictEqual(planProbeRun({ ...A.sona }, { liveRunApproved: true }).reason, "NOT_APPLICABLE", "only registered adapters pass the gate");
assert.strictEqual(planProbeRun({ id: "made-up" }, { liveRunApproved: true }).reason, "NOT_APPLICABLE");
pass("GATE live runs deferred without Owner approval; production on demand only; unknown adapters refused");

// Contract shape: declarative, read-only, unauthenticated probes.
for (const adapter of Object.values(A)) {
  assert.ok(adapter.liveness?.method === "GET", `${adapter.id} liveness is a GET`);
  assert.ok(Array.isArray(adapter.probes) && adapter.probes.length > 0, `${adapter.id} declares probes`);
  assert.strictEqual(adapter.pathsVerified, true, `${adapter.id} probe paths are verified`);
  assert.ok(adapter.probes.every((probe) => !probe.auth), `${adapter.id} probes send no credentials`);
  assert.ok(adapter.probes.every((probe) => ["GET", "POST", "PUT"].includes(probe.method) && !probe.stateful), `${adapter.id} probes don't change state`);
}
assert.throws(() => model.fail("MADE_UP_CODE"), /Unknown functional code/);
assert.throws(() => model.notEvaluated("BECAUSE"), /Unknown not-evaluated reason/);
for (const retired of ["WORKSPACE_OBJECTS_MISSING", "SESSION_FAILED"]) assert.ok(!(retired in model.FUNCTIONAL_CODES), `${retired} belonged to a retired adapter`);
assert.ok(!("NO_CREDENTIAL" in model.NOT_EVALUATED_REASONS));
pass("SHAPE adapters are declarative and credential-free; the vocabularies are closed");

console.log(`functional contracts smoke passed (${results} checks).`);
