#!/usr/bin/env node
"use strict";

// AIM-2 increments 2 and 3: the functional probe service and the inventory's
// Function column, with Sona as the active AnxLabs AI application. Hermetic:
// services are local HTTP fakes on 127.0.0.1 (a fake Sona API answers
// /api/health exactly like Sona 8.5.0), the inventory and scope file are
// fixtures. Proves the AIM-0 gate holds in the real executor (no request
// without an approved scope), that an approved run performs bounded real HTTP
// probes, that Sona's stack dependencies come from the inventory without any
// probe, and that the UI never shows an unchecked service as green.
// Run: node scripts/functional-probe-service-smoke.js

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const vm = require("vm");

const { createFunctionalProbeService, defaultRequest } = require("../src/services/functionalProbeService");
const { SONA_STACK } = require("../src/shared/functionalProbeAdapters");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-functional-"));
const scopesPath = path.join(root, "functional-probe-scopes.json");
let results = 0;
const pass = (label) => { results += 1; console.log(`PASS ${label}`); };

function startServer(handler) {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push(`${req.method} ${req.url}`); handler(req, res); });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, hits, url: `http://127.0.0.1:${server.address().port}` })));
}
const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

// Inventory fixture: the Sona stack on Anxlab plus a general-purpose Qdrant.
const sonaContainer = (service, name, state = "healthy") => ({
  key: `anxlab:container:${name}`, kind: "container", name, nodeId: "anxlab", health: { state },
  details: { image: service === "searxng" ? "ghcr.io/searxng/searxng:2026.10.4" : "anxlabs/sona-api:1.0.0" },
  identity: { verified: true, components: { composeProject: "sona", composeService: service, name } },
});
const SONA_KEY = "anxlab:container:sona-api";
const QDRANT_KEY = "anxlab:container:qdrant";
function buildInventory({ tunnelState = "healthy", sonaStale = false } = {}) {
  return {
    resources: [
      { ...sonaContainer("api", "sona-api"), stale: sonaStale },
      ...SONA_STACK.dependencies.map((dependency) => sonaContainer(dependency.service, dependency.containerName, dependency.service === "tunnel" ? tunnelState : "healthy")),
      { key: QDRANT_KEY, kind: "container", name: "qdrant", nodeId: "anxlab", health: { state: "healthy" }, details: { image: "qdrant/qdrant:v1.12.4" } },
      { key: "anxlab:container:postgres", kind: "container", name: "postgres", nodeId: "anxlab", health: { state: "healthy" }, details: { image: "postgres:16" } },
      { key: "anxlab:volume:data", kind: "volume", name: "data", nodeId: "anxlab", health: { state: "unknown" }, details: {} },
    ],
  };
}

async function main() {
  let inventory = buildInventory();
  let requestCalls = 0;
  const spyRequest = async (options) => { requestCalls += 1; return defaultRequest(options); };
  const service = createFunctionalProbeService({ getInventory: () => inventory, scopesPath, request: spyRequest, timeoutMs: 2000, maxBytes: 4096 });
  const byAdapter = (view, id) => view.services.find((entry) => entry.adapterId === id);

  // S1: no scope file — Sona and Qdrant are listed, neither is green, Sona shows its stack.
  let view = service.describe();
  assert.deepStrictEqual(view.services.map((entry) => entry.adapterId).sort(), ["qdrant", "sona"], "only the Sona API and Qdrant are recognized (not Sona's sandbox/plugins, not postgres)");
  for (const entry of view.services) {
    assert.strictEqual(entry.functional.formatted, "not-evaluated:LIVE_RUNS_DEFERRED");
    assert.strictEqual(entry.combined.renderGreen, false);
    assert.strictEqual(entry.scope.classification, "production");
  }
  const sona = byAdapter(view, "sona");
  assert.deepStrictEqual(sona.dependencies.map((dependency) => `${dependency.id}:${dependency.liveness}`), ["sandbox:healthy", "plugins:healthy", "claude-code:healthy", "browser:healthy", "searxng:healthy", "tunnel:healthy"]);
  assert.strictEqual(byAdapter(view, "qdrant").dependencies, null);
  assert.strictEqual(requestCalls, 0);
  pass("S1 no approved scope: Sona and Qdrant are listed as not checked, Sona's six-service stack is shown, nothing is requested");

  // S2: a down Sona dependency fails Sona from inventory evidence alone; a stale stack is unknown.
  inventory = buildInventory({ tunnelState: "stopped" });
  let entry = byAdapter(service.describe(), "sona");
  assert.strictEqual(entry.functional.formatted, "fail:DEPENDENCY_DOWN");
  assert.strictEqual(entry.functional.findings[0].dependency, "tunnel");
  assert.deepStrictEqual([entry.liveness, entry.combined.overall], ["healthy", "failed"], "the API is up but Sona doesn't work without its tunnel");
  inventory = buildInventory({ tunnelState: "stopped", sonaStale: true });
  entry = byAdapter(service.describe(), "sona");
  assert.strictEqual(entry.functional.formatted, "not-evaluated:LIVE_RUNS_DEFERRED", "a stale stack is not evidence of an outage");
  inventory = buildInventory();
  assert.strictEqual(requestCalls, 0);
  pass("S2 a stopped Sona dependency fails Sona with zero requests; a stale stack stays unknown");

  // S3: an on-demand check without approval sends nothing.
  let checked = await service.run(SONA_KEY);
  assert.strictEqual(requestCalls, 0, "the gate stops the executor before any request");
  assert.deepStrictEqual([checked.functional.reason, checked.requests, checked.trigger], ["LIVE_RUNS_DEFERRED", 0, "on-demand"]);
  await assert.rejects(service.run("anxlab:container:sona-sandbox"), (error) => error.code === "FUNCTIONAL_TARGET_UNSUPPORTED");
  await assert.rejects(service.run("anxlab:container:postgres"), (error) => error.code === "FUNCTIONAL_TARGET_UNSUPPORTED");
  await assert.rejects(service.run("missing"), (error) => error.code === "FUNCTIONAL_TARGET_NOT_FOUND");
  pass("S3 Check without Owner approval records LIVE_RUNS_DEFERRED and makes zero requests");

  // Local fakes: Sona's API, a Qdrant, and a host that must never be contacted.
  const elsewhere = await startServer((req, res) => json(res, 200, { stolen: true }));
  let sonaHealth = { status: "ok", app: "sona", version: "8.5.0" };
  const sonaApi = await startServer((req, res) => (req.url === "/api/health" ? json(res, 200, sonaHealth) : json(res, 401, { detail: "Not authenticated" })));
  let collectionsBody = { result: { collections: [{ name: "knowledge" }] } };
  const qdrant = await startServer((req, res) => {
    if (req.url === "/healthz") return json(res, 200, { title: "qdrant" });
    if (req.url === "/collections") return json(res, 200, collectionsBody);
    if (req.url === "/collections/knowledge") return json(res, 200, { result: { points_count: 1200 } });
    if (req.url === "/redirect") { res.writeHead(302, { location: `${elsewhere.url}/collections` }); return res.end(); }
    return json(res, 404, {});
  });
  const writeScopes = (scopes) => fs.writeFileSync(scopesPath, JSON.stringify({ schemaVersion: 1, scopes }));

  try {
    // S4: approved on-demand Sona check: real GET /api/health only.
    writeScopes({ [SONA_KEY]: { classification: "non-production", liveRunApproved: true, baseUrl: sonaApi.url, expected: { expectedVersion: "8.5.0" }, approvedBy: "Owner (fixture)" } });
    checked = await service.run(SONA_KEY);
    assert.strictEqual(checked.functional.formatted, "pass");
    assert.strictEqual(checked.combined.renderGreen, true);
    assert.deepStrictEqual(sonaApi.hits, ["GET /api/health", "GET /api/health"], "liveness + functional, both on the public health route; no authenticated route is touched");
    assert.strictEqual(checked.scope.classification, "production", "the scope file alone can't make a service non-production");
    sonaHealth = { status: "ok", app: "sona", version: "8.6.0" };
    assert.strictEqual((await service.run(SONA_KEY)).functional.formatted, "degraded:VERSION_CHANGED");
    sonaHealth = { status: "ok", app: "not-sona" };
    assert.strictEqual((await service.run(SONA_KEY)).functional.formatted, "fail:IDENTITY_CHANGED");
    sonaHealth = { status: "ok", app: "sona", version: "8.5.0" };
    inventory = buildInventory({ tunnelState: "failed" });
    checked = await service.run(SONA_KEY);
    assert.strictEqual(checked.functional.formatted, "fail:DEPENDENCY_DOWN", "a passing health probe can't hide a down tunnel");
    inventory = buildInventory();
    pass("S4 an approved Sona check reads only GET /api/health; version drift, a wrong app and a down dependency are each reported");

    // S5: general-purpose Qdrant still works end to end.
    writeScopes({ [QDRANT_KEY]: { classification: "non-production", liveRunApproved: true, baseUrl: qdrant.url, expected: { expectedCollections: ["knowledge"], baseline: { points: { knowledge: 1200 } } } } });
    checked = await service.run(QDRANT_KEY);
    assert.strictEqual(checked.functional.formatted, "pass");
    assert.deepStrictEqual(qdrant.hits.slice(-3), ["GET /healthz", "GET /collections", "GET /collections/knowledge"]);
    writeScopes({ [QDRANT_KEY]: { classification: "non-production", liveRunApproved: true, baseUrl: qdrant.url, expected: { expectedCollections: ["knowledge"], wiring: { appBackend: "qdrant-original", probedService: "qdrant-recovery" } } } });
    checked = await service.run(QDRANT_KEY);
    assert.deepStrictEqual([checked.functional.formatted, checked.liveness, checked.combined.overall], ["fail:NOT_WIRED", "healthy", "failed"]);
    pass("S5 an approved Qdrant check passes or reports NOT_WIRED while the service is up");

    // S6: scheduled production runs and bad scope files never send a request.
    const before = requestCalls;
    writeScopes({ [SONA_KEY]: { liveRunApproved: true, baseUrl: sonaApi.url } });
    assert.strictEqual((await service.run(SONA_KEY, { trigger: "schedule" })).functional.reason, "OPT_IN_REQUIRED");
    fs.writeFileSync(scopesPath, "{ not json");
    assert.strictEqual((await service.run(SONA_KEY)).functional.reason, "LIVE_RUNS_DEFERRED", "an unreadable scope file approves nothing");
    fs.writeFileSync(scopesPath, JSON.stringify({ schemaVersion: 2, scopes: { [SONA_KEY]: { liveRunApproved: true, baseUrl: sonaApi.url } } }));
    assert.strictEqual((await service.run(SONA_KEY)).functional.reason, "LIVE_RUNS_DEFERRED", "an unknown schema approves nothing");
    assert.strictEqual(requestCalls, before, "none of these sent a request");
    pass("S6 scheduled production runs and bad scope files never send a request");

    // S7: probes don't follow redirects, oversized answers are no answer, only http(s).
    const redirect = await defaultRequest({ method: "GET", url: `${qdrant.url}/redirect`, timeoutMs: 2000, maxBytes: 4096 });
    assert.strictEqual(redirect.status, 302);
    assert.deepStrictEqual(elsewhere.hits, [], "the redirect target was never contacted");
    collectionsBody = { result: { collections: [{ name: "knowledge" }] }, padding: "x".repeat(8192) };
    writeScopes({ [QDRANT_KEY]: { classification: "non-production", liveRunApproved: true, baseUrl: qdrant.url, expected: { expectedCollections: ["knowledge"] } } });
    checked = await service.run(QDRANT_KEY);
    assert.strictEqual(checked.functional.formatted, "not-evaluated:NO_RESPONSE");
    await assert.rejects(defaultRequest({ method: "GET", url: "file:///etc/passwd" }), (error) => error.code === "PROBE_PROTOCOL");
    pass("S7 no redirects followed, size cap enforced, only http(s)");
  } finally {
    for (const handle of [sonaApi, qdrant, elsewhere]) await new Promise((resolve) => handle.server.close(resolve));
  }

  // S8: UI helpers from the real app.js.
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const start = app.indexOf("const INFRA_FUNCTIONAL_REASON_LABELS");
  const end = app.indexOf("async function loadInfraFunctionalStates");
  assert.ok(start > 0 && end > start);
  const sandbox = {};
  vm.runInNewContext(`${app.slice(start, end)}\nthis.describeFunctionalPill = describeFunctionalPill; this.describeStackSummary = describeStackSummary;`, sandbox);
  const pill = sandbox.describeFunctionalPill;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(pill({ functional: { outcome: "not-evaluated", reason: "LIVE_RUNS_DEFERRED" } }))),
    { label: "Not checked", tone: "planned", title: "Live checks are deferred until the Owner approves this service's scope (AIM-0)." });
  assert.strictEqual(pill({ functional: { outcome: "pass" }, combined: { renderGreen: true } }).tone, "ok");
  assert.strictEqual(pill({ functional: { outcome: "pass" }, combined: { renderGreen: false } }).tone, "warning");
  assert.strictEqual(pill({ functional: { outcome: "fail", code: "DEPENDENCY_DOWN" } }).label, "Failing: DEPENDENCY_DOWN");
  assert.strictEqual(pill({ functional: { outcome: "green" } }).tone, "planned", "an unknown outcome is not checked, never green");
  const deps = (overrides = {}) => SONA_STACK.dependencies.map((dependency) => ({ id: dependency.service, label: dependency.label, present: true, liveness: "healthy", ...(overrides[dependency.service] || {}) }));
  assert.strictEqual(sandbox.describeStackSummary(deps()).text, "stack 6/6 healthy");
  assert.strictEqual(sandbox.describeStackSummary(deps({ tunnel: { liveness: "failed" } })).text, "stack: Cloudflare tunnel failed");
  assert.strictEqual(sandbox.describeStackSummary(deps({ searxng: { present: false, liveness: "unknown" } })).text, "stack: Web search (SearXNG) missing");
  assert.strictEqual(sandbox.describeStackSummary(null), null);
  assert.ok(app.includes('["Kind", "Name", "Node", "Health", "Function", "Ownership"'), "Health and Function are separate columns");
  pass("S8 the Function column shows Works only when checked and green, and summarizes Sona's stack");

  // S9: wiring.
  const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  const ipc = fs.readFileSync(path.join(__dirname, "..", "src", "ipc", "infrastructureInventoryIpc.js"), "utf8");
  assert.ok(preload.includes('functional: () => ipcRenderer.invoke("infrastructureInventory:functional")'));
  assert.ok(preload.includes('checkFunction: (resourceKey) => ipcRenderer.invoke("infrastructureInventory:checkFunction", { resourceKey })'));
  assert.ok(/checkFunction[\s\S]{0,400}requirePermission\("settings:write"[\s\S]{0,300}audit\(\{ action: "infrastructure\.functional-check"/.test(ipc), "the on-demand check is Owner-only and audited");
  const capability = require("../src/shared/serviceCapabilityContract");
  assert.ok(capability.SERVICE_CAPABILITY_IDS.includes("functionalProbes"));
  assert.strictEqual(capability.deriveServiceCapabilities({ family: "minecraft" }).capabilities.functionalProbes, undefined, "no game family claims functional probes");
  pass("S9 IPC is wired (read + Owner-only audited check) and functionalProbes is in the closed vocabulary");

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`functional probe service smoke passed (${results} checks).`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
