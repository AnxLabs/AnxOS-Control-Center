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

  console.log("network-page-refresh-race smoke passed");
  process.exitCode = 0;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
