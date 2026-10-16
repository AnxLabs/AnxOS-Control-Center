"use strict";

// Network page refresh race smoke (PR #9 review P1). Run from the repository root:
//   node scripts/network-page-refresh-race-smoke.js
//
// Runs the REAL refreshNetworkPage() from app.js in a sandbox with controllable
// endpoint reads, and proves the page can never be left stuck in its loading
// state:
//   - a repeated (non-forced) refresh for the same node while one is in flight
//     joins it: the in-flight request still completes and clears `loading`;
//   - a refresh for a different node supersedes the in-flight one, whichever
//     finishes first, and only the newest request's data is shown;
//   - a forced refresh supersedes the in-flight one and clears `loading`.

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Fail closed: a run that never reaches its summary must not exit 0.
process.exitCode = 1;

const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");
function extractFunction(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} must exist in app.js`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `${header} must be a top-level function`);
  return source.slice(start, end + 2);
}
const refreshSource = extractFunction(appSource, "async function refreshNetworkPage(");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makePage() {
  const listCalls = [];
  const api = {
    endpoints: {
      list: (payload) => {
        const call = { payload, ...deferred() };
        listCalls.push(call);
        return call.promise;
      },
    },
    providers: { getStatus: async () => ({ providers: [] }) },
  };
  const context = {
    networkState: { endpoints: [], summary: null, providers: null, providerSyncs: null, loading: false, requestId: 0, lastError: null, degraded: false },
    selectedNodeId: "node-a",
    networkEndpointList: null,
    getDesktopApi: () => api,
    getSelectedNodeId: () => context.selectedNodeId,
    renderNetworkEndpoints() {},
    updateNetworkToolbarState() {},
    renderNetworkSummary() {},
    renderNetworkProviders() {},
    getFriendlyErrorMessage: (_error, fallback) => fallback,
    mergeNetworkProviderSyncs: () => context.networkState.providerSyncs,
    computeNetworkSummary: () => ({}),
  };
  vm.createContext(context);
  vm.runInContext(`${refreshSource}\nthis.refreshNetworkPage = refreshNetworkPage;`, context);
  return { context, listCalls };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// PR #9 fourth review: the REAL runners from app.js, given a run discarded
// because its endpoint changed mid-run, show "not evaluated" and never render
// a target result.
const DISCARDED = Object.freeze({ cached: false, stale: true, state: "unknown", reason: "NOT_EVALUATED", discarded: "ENDPOINT_CHANGED" });
function extractConst(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} must exist in app.js`);
  return source.slice(start, source.indexOf(";\n", start) + 2);
}
function makeRunnerPage(result) {
  const element = () => {
    const node = { hidden: true, children: [], replaceChildren: (...kids) => { node.children = kids; } };
    return node;
  };
  const rendered = { diagnostics: [], graph: [], instanceDiagnostics: [], instanceGraph: [], toasts: [], refreshes: 0 };
  const context = {
    networkState: { diagnostics: { stale: "previous" }, lastError: null },
    networkDiagnosticsInFlight: false,
    networkDiagnosticsSerial: 0,
    networkSelectedStageId: "stage-x",
    networkDiagnosticsPanel: element(),
    networkDiagnosticsSummary: element(),
    networkDiagnosticsScopes: element(),
    networkDiagnosticsStages: element(),
    instanceNetworkDiagnosticsPanel: element(),
    instanceNetworkDiagnosticsSummary: element(),
    instanceNetworkDiagnosticsScopes: element(),
    instanceNetworkDiagnosticsStages: element(),
    instanceNetworkTabState: { instanceId: "svc-1", diagnosticsInFlight: false, diagnosticsSerial: 0, diagnostics: { stale: "previous" } },
    selectedInstanceId: "svc-1",
    getDesktopApi: () => ({
      endpoints: { test: async () => result },
      connectivity: { runDiagnostics: async () => result },
    }),
    getSelectedNodeId: () => "node-a",
    getNetworkEndpointById: (id) => ({ id }),
    updateNetworkToolbarState() {},
    updateInstanceNetworkToolbarState() {},
    renderNetworkStatusLine() {},
    renderNetworkDiagnostics: (value) => rendered.diagnostics.push(value),
    renderNetworkGraph: (value) => rendered.graph.push(value),
    renderInstanceNetworkDiagnostics: (value) => rendered.instanceDiagnostics.push(value),
    renderInstanceNetworkGraph: (value) => rendered.instanceGraph.push(value),
    renderInstanceNetworkTab() {},
    refreshNetworkPage: async () => { rendered.refreshes += 1; },
    showToast: (message, tone) => rendered.toasts.push({ message, tone }),
    createTextElement: (tag, text) => ({ tag, text }),
    normalizeIpcErrorMessage: (message, fallback) => message || fallback,
    getFriendlyErrorMessage: (_error, fallback) => fallback,
    normalizeNetworkState: (value) => value || "unknown",
    networkStateLabel: (value) => value,
    getConnectivityToastTone: () => "info",
  };
  vm.createContext(context);
  const sources = [
    extractFunction(appSource, "function isDiscardedConnectivityResult("),
    extractConst(appSource, "const DISCARDED_CONNECTIVITY_MESSAGE ="),
    extractFunction(appSource, "function showDiscardedNetworkDiagnostics("),
    extractFunction(appSource, "async function testNetworkEndpoint("),
    extractFunction(appSource, "async function runNetworkDiagnostics("),
    extractFunction(appSource, "async function refreshInstanceNetworkDiagnostics("),
  ];
  vm.runInContext(`${sources.join("\n")}
this.testNetworkEndpoint = testNetworkEndpoint;
this.runNetworkDiagnostics = runNetworkDiagnostics;
this.refreshInstanceNetworkDiagnostics = refreshInstanceNetworkDiagnostics;
this.DISCARDED_CONNECTIVITY_MESSAGE = DISCARDED_CONNECTIVITY_MESSAGE;`, context);
  return { context, rendered };
}

async function main() {
  // 1. Reopening the page (same node, not forced) while a refresh is in flight.
  {
    const { context, listCalls } = makePage();
    const first = context.refreshNetworkPage();
    await flush();
    assert.strictEqual(context.networkState.loading, true);
    const second = await context.refreshNetworkPage();
    assert.strictEqual(second, context.networkState, "the repeated call joins the in-flight refresh");
    assert.strictEqual(listCalls.length, 1, "no second read for the same node");
    listCalls[0].resolve({ endpoints: [{ id: "ep-a" }] });
    await first;
    assert.strictEqual(context.networkState.loading, false, "the in-flight refresh clears loading (no stuck page)");
    assert.deepStrictEqual(context.networkState.endpoints.map((entry) => entry.id), ["ep-a"]);
  }

  // 2. Switching node while a refresh is in flight: the newer request wins,
  //    whichever finishes first.
  for (const order of ["older-first", "newer-first"]) {
    const { context, listCalls } = makePage();
    const older = context.refreshNetworkPage();
    await flush();
    context.selectedNodeId = "node-b";
    const newer = context.refreshNetworkPage();
    await flush();
    assert.strictEqual(listCalls.length, 2, `${order}: a different node starts its own read`);
    assert.strictEqual(listCalls[1].payload.nodeId, "node-b");
    const finish = async (index, endpoints, promise) => { listCalls[index].resolve({ endpoints }); await promise; };
    if (order === "older-first") {
      await finish(0, [{ id: "ep-a" }], older);
      assert.strictEqual(context.networkState.loading, true, "the superseded request leaves loading to the newer one");
      await finish(1, [{ id: "ep-b" }], newer);
    } else {
      await finish(1, [{ id: "ep-b" }], newer);
      await finish(0, [{ id: "ep-a" }], older);
    }
    assert.strictEqual(context.networkState.loading, false, `${order}: loading is cleared`);
    assert.deepStrictEqual(context.networkState.endpoints.map((entry) => entry.id), ["ep-b"], `${order}: only the newest node's data is shown`);
  }

  // 3. A forced refresh while one is in flight supersedes it and still clears loading.
  {
    const { context, listCalls } = makePage();
    const first = context.refreshNetworkPage();
    await flush();
    const forced = context.refreshNetworkPage({ force: true });
    await flush();
    assert.strictEqual(listCalls.length, 2, "a forced refresh always reads");
    listCalls[0].resolve({ endpoints: [{ id: "ep-old" }] });
    await first;
    listCalls[1].resolve({ endpoints: [{ id: "ep-new" }] });
    await forced;
    assert.strictEqual(context.networkState.loading, false);
    assert.deepStrictEqual(context.networkState.endpoints.map((entry) => entry.id), ["ep-new"]);
  }

  // 4. A failed read still clears loading.
  {
    const { context, listCalls } = makePage();
    const run = context.refreshNetworkPage();
    await flush();
    listCalls[0].reject(new Error("agent down"));
    await run;
    assert.strictEqual(context.networkState.loading, false, "a failed read never leaves the page loading");
    assert.strictEqual(context.networkState.lastError, "Endpoints could not be loaded.");
  }

  // 5. PR #9 fourth review: a discarded run is shown as not evaluated by
  //    every runner; the obsolete target result is never rendered.
  for (const runner of ["testNetworkEndpoint", "runNetworkDiagnostics"]) {
    const { context, rendered } = makeRunnerPage(DISCARDED);
    await context[runner]("ep-1");
    assert.strictEqual(context.networkState.diagnostics, null, `${runner}: no diagnostics are kept`);
    assert.deepStrictEqual(rendered.diagnostics, [], `${runner}: no result is rendered`);
    assert.ok(rendered.graph.every((value) => value === null), `${runner}: the graph is cleared, never drawn from the result`);
    assert.strictEqual(context.networkDiagnosticsSummary.children[0].text, context.DISCARDED_CONNECTIVITY_MESSAGE, `${runner}: not-evaluated message`);
    assert.strictEqual(context.networkDiagnosticsPanel.hidden, false, `${runner}: the message is visible`);
    assert.deepStrictEqual(rendered.toasts, [{ message: context.DISCARDED_CONNECTIVITY_MESSAGE, tone: "warning" }], `${runner}: a warning, not a finished state`);
    assert.strictEqual(context.networkDiagnosticsInFlight, false, `${runner}: the in-flight flag is released`);
  }
  {
    const { context, rendered } = makeRunnerPage(DISCARDED);
    await context.refreshInstanceNetworkDiagnostics("svc-1", "ep-1");
    assert.strictEqual(context.instanceNetworkTabState.diagnostics, null, "instance: no diagnostics are kept");
    assert.deepStrictEqual(rendered.instanceDiagnostics, [], "instance: no result is rendered");
    assert.ok(rendered.instanceGraph.every((value) => value === null), "instance: the graph is cleared");
    assert.strictEqual(context.instanceNetworkDiagnosticsSummary.children[0].text, context.DISCARDED_CONNECTIVITY_MESSAGE);
    assert.deepStrictEqual(rendered.toasts, [{ message: context.DISCARDED_CONNECTIVITY_MESSAGE, tone: "warning" }]);
    assert.strictEqual(context.instanceNetworkTabState.diagnosticsInFlight, false, "instance: the in-flight flag is released");
  }
  // A normal result still renders (the discard branch is specific).
  {
    const real = { overall: { state: "healthy" }, stages: [], graph: null };
    const { context, rendered } = makeRunnerPage(real);
    await context.testNetworkEndpoint("ep-1");
    assert.deepStrictEqual(rendered.diagnostics, [real], "a real result is rendered as before");
    assert.strictEqual(rendered.toasts[0].message, "Endpoint test finished: healthy.");
  }

  console.log("network-page-refresh-race smoke passed");
  process.exitCode = 0;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
