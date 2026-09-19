#!/usr/bin/env node
"use strict";

// SMOOTH-3010 wiring guard: the main.js CALL SITES for the instance-snapshot
// reuse path, and for the IPC instrumentation that carries it.
//
// WHY THIS SUITE EXISTS
// `scripts/instance-snapshot-reuse-smoke.js` proves the REUSE LOGIC inside
// src/services/alertService.js with real mutation teeth. It does not, and cannot,
// prove that anything on the desktop startup path ever CALLS it. Removing the
// `publishInstanceSnapshot` share from the IPC wrapper, or removing the
// `resolveInstanceSnapshot` call from the alert scheduler's state collector, would
// leave alertService.js byte-perfect, that suite green, and the optimization
// silently dead — the duplication returns, `implicit-node-fallback-selected` goes
// back to 3x/min, and no automated check notices.
//
// `scripts/alert-engine-smoke.js` had the same weakness in a weaker form: it
// asserted `source.includes("startAlertScheduler")`, which a comment or an unused
// import satisfies. That assertion is now exact-expression there too, and the
// call-order half is owned here.
//
// WHAT THIS SUITE PINS — three halves, which prove different amounts:
//
//   A. INSTRUMENTATION BEHAVIOUR (real module, injected fakes). The extracted
//      src/ipc/ipcHandlerInstrumentation.js wrapper is executed with a fake
//      `ipcMain`, so these are behavioural checks with mutation teeth:
//        - an `instances:list` reply is published EXACTLY ONCE with the node id
//          and the reply itself; no other channel (including a prefix look-alike)
//          publishes anything
//        - a THROWING publish does not reject the IPC reply, does not alter the
//          returned result, and is not reported as a request failure
//        - APPLICATION_SHUTTING_DOWN is thrown BEFORE the listener runs, before
//          any log record is emitted, and the guard reads the live flag
//        - the started/completed/error records keep their exact shape and fields
//          (durationMs only by default; payloadBytes only in the gated branch)
//        - `ipcMain.handle` really is replaced, so every later registration is
//          wrapped
//        - a missing dependency fails fast instead of silently no-op'ing
//
//   B. COLLECTOR BEHAVIOUR (real module, injected fakes). The extracted
//      src/services/alertStateCollector.js factory is executed with fake
//      nodeService/alertService/serviceRouter:
//        - `resolveInstanceSnapshot` is called with the SELECTED node id, and with
//          the APPLICATION_HOST_NODE_ID fallback when the selection is falsy
//        - the fetcher handed to it delegates to `serviceRouter.listInstances({})`
//        - nodes and instances are read CONCURRENTLY (a serial implementation
//          deadlocks against the gate this check installs)
//        - `listNodes` receives exactly the read-only options
//        - both reads degrade to empty collections instead of rejecting
//
//   C. RESIDUAL main.js SURFACE (text, comment-stripped, exact expressions).
//        - main.js still invokes the module and wires the collector, as exact
//          call expressions rather than bare identifiers
//        - the extracted bodies are GONE from main.js (no re-inlined duplicate
//          that would leave half A testing code the app never runs)
//        - call ORDER: within the whenReady callback, `instrumentIpcHandlers(...)`
//          precedes `registerInstancesIpc()`, which precedes the collector wiring
//      WHAT C IS: it proves the calls exist as TEXT outside any comment, in the
//      right order, in the shipped file. WHAT C IS NOT: it cannot prove runtime
//      reachability — that the callback ever executes, that Electron is present, or
//      that the scheduler's timer ticks. Half A proves the wrapper's behaviour when
//      called; nothing here proves the app calls it at runtime.
//
// Hermetic: requires only the two extracted modules (which require nothing) plus
// fs/path/assert. No Electron, no network, no real config dir, no node_modules.
// main.js is read AS TEXT and never required (requiring it would start Electron).

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { instrumentIpcHandlers, IPC_PAYLOAD_BYTES_ENABLED } = require("../src/ipc/ipcHandlerInstrumentation");
const { createAlertStateCollector } = require("../src/services/alertStateCollector");
const { normalizeSource } = require("../test-helpers/source-normalize");

const ROOT = path.resolve(__dirname, "..");
const MAIN_PATH = path.join(ROOT, "main.js");

const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.error(`  FAIL ${name}`);
    console.error(`       ${error && error.message ? error.message : error}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Fakes. Deliberately minimal: the extracted modules require nothing, so these
// are the whole environment.
// ---------------------------------------------------------------------------
function makeIpcMain() {
  const handlers = new Map();
  const ipcMain = {
    handlers,
    handle(channel, listener) {
      handlers.set(channel, listener);
      return ipcMain;
    },
  };
  return ipcMain;
}

function makeDiagnostics() {
  const logs = [];
  const errors = [];
  let seq = 0;
  return {
    logs,
    errors,
    correlationId(scope) {
      seq += 1;
      return `${scope}-${seq}`;
    },
    log(level, scope, code, message, context, meta) {
      logs.push({ level, scope, code, message, context, meta });
    },
    logError(scope, code, error, context, meta) {
      errors.push({ scope, code, error, context, meta });
    },
    startedFor(code) {
      return logs.filter((entry) => entry.message === "IPC request started" && entry.code === code);
    },
    completedFor(code) {
      return logs.filter((entry) => entry.message === "IPC request completed" && entry.code === code);
    },
  };
}

function makeInstrumented(options = {}) {
  const ipcMain = makeIpcMain();
  const diagnostics = options.diagnostics || makeDiagnostics();
  const publishes = [];
  instrumentIpcHandlers({
    ipcMain,
    diagnostics,
    isShuttingDown: options.isShuttingDown,
    publishInstanceSnapshot: options.publishInstanceSnapshot || ((nodeId, payload) => publishes.push({ nodeId, payload })),
    payloadBytesEnabled: options.payloadBytesEnabled,
  });
  return { ipcMain, diagnostics, publishes };
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) { resolve(); return; }
      if (Date.now() > deadline) {
        reject(new Error(`timed out after ${timeoutMs} ms waiting for the concurrent read`));
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

const REPLY = { instances: [{ id: "inst-1", nodeId: "node-a" }], nodes: [], backups: [] };

// ---------------------------------------------------------------------------
// Phase A: instrumentation behaviour.
// ---------------------------------------------------------------------------
async function phaseInstrumentation() {
  await check("A1. PUBLISH: an instances:list reply is published exactly once with the node id and the reply itself", async () => {
    const { ipcMain, publishes } = makeInstrumented();
    ipcMain.handle("instances:list", async () => REPLY);
    const handler = ipcMain.handlers.get("instances:list");

    const returned = await handler({ sender: "event" }, { nodeId: "node-a" });

    assert.deepStrictEqual(
      publishes,
      [{ nodeId: "node-a", payload: REPLY }],
      `publish invariant violated: an instances:list reply must be shared exactly once as (nodeId, reply); got ${JSON.stringify(publishes.map((call) => call.nodeId))}. A broken channel guard or a dropped publish call leaves the snapshot-reuse optimization dead.`,
    );
    assert.strictEqual(returned, REPLY, "the handler must still return the listener's reply unchanged.");
  });

  await check("A2. PUBLISH: no publish happens for any other channel (exact match, not a prefix)", async () => {
    const { ipcMain, publishes } = makeInstrumented();
    for (const channel of ["nodes:list", "instances:list2", "instances:listAll", "instances:list "]) {
      ipcMain.handle(channel, async () => REPLY);
      const returned = await ipcMain.handlers.get(channel)({}, { nodeId: "node-a" });
      assert.strictEqual(returned, REPLY, `channel ${channel}: the reply must pass through unchanged.`);
    }
    assert.strictEqual(
      publishes.length,
      0,
      `channel guard violated: only the exact string "instances:list" may publish a snapshot; ${publishes.length} publish(es) happened for other channels (a startsWith-style guard would do this).`,
    );
  });

  await check("A3. PUBLISH: a throwing publish does not reject the reply, does not alter the result, and is not a request failure", async () => {
    const diagnostics = makeDiagnostics();
    const { ipcMain } = makeInstrumented({
      diagnostics,
      publishInstanceSnapshot: () => {
        throw new Error("snapshot share failed");
      },
    });
    ipcMain.handle("instances:list", async () => REPLY);

    const returned = await ipcMain.handlers.get("instances:list")({}, { nodeId: "node-a" });

    assert.strictEqual(
      returned,
      REPLY,
      "best-effort invariant violated: a share failure must NEVER affect the IPC reply. Losing the try/catch around publish turns a harmless snapshot-share error into a failed instances:list for the renderer.",
    );
    assert.strictEqual(
      diagnostics.errors.length,
      0,
      `best-effort invariant violated: a share failure must not be reported as a request failure; ${diagnostics.errors.length} logError record(s) were emitted.`,
    );
    assert.strictEqual(
      diagnostics.completedFor("instances:list").length,
      1,
      "best-effort invariant violated: the request must still complete normally when the share fails.",
    );
  });

  await check("A4. PUBLISH: a missing payload argument publishes a null-ish node id instead of throwing", async () => {
    const { ipcMain, publishes } = makeInstrumented();
    ipcMain.handle("instances:list", async () => REPLY);
    const returned = await ipcMain.handlers.get("instances:list")({ sender: "event" });
    assert.strictEqual(returned, REPLY, "an instances:list reply must be returned even when no payload was supplied.");
    assert.strictEqual(publishes.length, 1, "the share must still happen when the caller supplied no payload.");
    assert.strictEqual(publishes[0].nodeId, undefined, "`args[1]?.nodeId` must degrade to undefined, not throw.");
  });

  await check("A5. SHUTDOWN: APPLICATION_SHUTTING_DOWN is thrown before the listener runs and before any log record", async () => {
    let shuttingDown = false;
    let listenerCalls = 0;
    const diagnostics = makeDiagnostics();
    const { ipcMain, publishes } = makeInstrumented({ diagnostics, isShuttingDown: () => shuttingDown });
    ipcMain.handle("instances:list", async () => {
      listenerCalls += 1;
      return REPLY;
    });
    const handler = ipcMain.handlers.get("instances:list");

    shuttingDown = true;
    await assert.rejects(
      handler({}, { nodeId: "node-a" }),
      (error) => error && error.code === "APPLICATION_SHUTTING_DOWN" && /shutting down/i.test(error.message),
      "shutdown guard violated: a request received while shutting down must reject with code APPLICATION_SHUTTING_DOWN.",
    );
    assert.strictEqual(listenerCalls, 0, "shutdown guard violated: the listener must NOT run while shutting down (the guard must precede it).");
    assert.strictEqual(publishes.length, 0, "shutdown guard violated: a refused request must not publish a snapshot.");
    assert.strictEqual(
      diagnostics.logs.length,
      0,
      "shutdown guard violated: no IPC log record may be emitted for a refused request, which proves the guard precedes the logging.",
    );

    // The guard must read the LIVE flag, not a value captured at wiring time.
    shuttingDown = false;
    assert.strictEqual(await handler({}, { nodeId: "node-a" }), REPLY, "once the flag clears, the handler must serve again.");
    assert.strictEqual(listenerCalls, 1, "the listener must run exactly once after the flag cleared.");
  });

  await check("A6. DIAGNOSTICS: started/completed records keep their exact shape, fields and per-call correlation ids", async () => {
    const diagnostics = makeDiagnostics();
    const { ipcMain } = makeInstrumented({ diagnostics, payloadBytesEnabled: false });
    ipcMain.handle("nodes:list", async () => "payload");
    const handler = ipcMain.handlers.get("nodes:list");

    await handler({}, {});
    await handler({}, {});

    const started = diagnostics.startedFor("nodes:list");
    assert.strictEqual(started.length, 2, "each request must emit exactly one \"IPC request started\" record.");
    assert.strictEqual(started[0].scope, "ipc", "the start record must be scoped to \"ipc\".");
    assert.strictEqual(started[0].level, "info", "the start record must be level info.");
    assert.deepStrictEqual(started[0].context, {}, "the start record's context must remain the empty object.");
    assert.strictEqual(started[0].meta.file, "ipc", "the start record must keep { file: \"ipc\" }.");
    assert.ok(started[0].meta.correlationId, "the start record must carry a correlation id.");
    assert.notStrictEqual(
      started[0].meta.correlationId,
      started[1].meta.correlationId,
      "each request must receive its OWN correlation id (a cached id would collapse unrelated requests into one trace).",
    );

    const completed = diagnostics.completedFor("nodes:list");
    assert.strictEqual(completed.length, 2, "each request must emit exactly one \"IPC request completed\" record.");
    assert.strictEqual(completed[0].meta.file, "ipc", "the completed record must keep { file: \"ipc\" }.");
    assert.strictEqual(
      completed[0].meta.correlationId,
      started[0].meta.correlationId,
      "the completed record must carry the SAME correlation id as its start record.",
    );
    assert.deepStrictEqual(
      Object.keys(completed[0].context),
      ["durationMs"],
      `default-path invariant violated: with the byte gate off the completed context must be exactly { durationMs }; got ${JSON.stringify(Object.keys(completed[0].context))}.`,
    );
    assert.ok(Number.isFinite(completed[0].context.durationMs), "durationMs must be a finite number.");
  });

  await check("A7. DIAGNOSTICS: the error path logs logError with exactly { durationMs } and rethrows the original error", async () => {
    const diagnostics = makeDiagnostics();
    const { ipcMain } = makeInstrumented({ diagnostics });
    const boom = Object.assign(new Error("channel exploded"), { code: "BOOM" });
    ipcMain.handle("nodes:fail", async () => {
      throw boom;
    });

    await assert.rejects(
      ipcMain.handlers.get("nodes:fail")({}, {}),
      (error) => error === boom,
      "the original error object must be rethrown unchanged (a wrapped error would change the renderer's error contract).",
    );

    assert.strictEqual(diagnostics.errors.length, 1, "exactly one logError record must be emitted for a failed request.");
    assert.strictEqual(diagnostics.errors[0].scope, "ipc", "the failure record must be scoped to \"ipc\".");
    assert.strictEqual(diagnostics.errors[0].code, "nodes:fail", "the failure record must name the channel.");
    assert.strictEqual(diagnostics.errors[0].error, boom, "the failure record must carry the original error.");
    assert.deepStrictEqual(
      Object.keys(diagnostics.errors[0].context),
      ["durationMs"],
      "the IPC error record must remain exactly { durationMs } (no payload measurement on the failure path).",
    );
    assert.strictEqual(
      diagnostics.completedFor("nodes:fail").length,
      0,
      "a failed request must not also emit a \"completed\" record.",
    );
  });

  await check("A8. GATE: payloadBytes is attached only inside the gated branch and only for cheaply measurable payloads", async () => {
    assert.strictEqual(
      IPC_PAYLOAD_BYTES_ENABLED,
      process.env.ANXOS_IPC_BYTE_METRICS === "1",
      "the gate must be the env flag read once at module load.",
    );

    const off = makeDiagnostics();
    const offRun = makeInstrumented({ diagnostics: off, payloadBytesEnabled: false });
    offRun.ipcMain.handle("nodes:list", async () => "a".repeat(500));
    await offRun.ipcMain.handlers.get("nodes:list")({}, {});
    assert.deepStrictEqual(
      off.completedFor("nodes:list")[0].context,
      { durationMs: off.completedFor("nodes:list")[0].context.durationMs },
      "gate off: payloadBytes must be absent, not null.",
    );
    assert.ok(!("payloadBytes" in off.completedFor("nodes:list")[0].context), "gate off: payloadBytes must be absent.");

    const onString = makeDiagnostics();
    const onStringRun = makeInstrumented({ diagnostics: onString, payloadBytesEnabled: true });
    onStringRun.ipcMain.handle("nodes:list", async () => "héllo");
    await onStringRun.ipcMain.handlers.get("nodes:list")({}, {});
    assert.strictEqual(
      onString.completedFor("nodes:list")[0].context.payloadBytes,
      6,
      "gate on + string: the exact utf8 byte count must be attached (é is 2 bytes: 4 + 2 = 6).",
    );

    const onObject = makeDiagnostics();
    const onObjectRun = makeInstrumented({ diagnostics: onObject, payloadBytesEnabled: true });
    onObjectRun.ipcMain.handle("nodes:list", async () => ({ big: "x".repeat(10000) }));
    await onObjectRun.ipcMain.handlers.get("nodes:list")({}, {});
    assert.ok(
      !("payloadBytes" in onObject.completedFor("nodes:list")[0].context),
      "gate on + object: an unmeasurable payload must be SKIPPED (never re-serialized to count its bytes).",
    );
  });

  await check("A9. CONTRACT: ipcMain.handle is replaced, so every later registration is wrapped", async () => {
    const ipcMain = makeIpcMain();
    const original = ipcMain.handle;
    instrumentIpcHandlers({ ipcMain, diagnostics: makeDiagnostics(), publishInstanceSnapshot: () => {} });
    assert.notStrictEqual(ipcMain.handle, original, "the wrapper must REPLACE ipcMain.handle; otherwise nothing registered afterwards is instrumented.");
  });

  await check("A10. CONTRACT: missing dependencies fail fast instead of silently no-op'ing", async () => {
    assert.throws(
      () => instrumentIpcHandlers({ diagnostics: makeDiagnostics(), publishInstanceSnapshot: () => {} }),
      (error) => error instanceof TypeError && /ipcMain/.test(error.message),
      "a missing ipcMain must be refused loudly.",
    );
    assert.throws(
      () => instrumentIpcHandlers({ ipcMain: makeIpcMain(), publishInstanceSnapshot: () => {} }),
      (error) => error instanceof TypeError && /diagnostics/.test(error.message),
      "a missing diagnostics service must be refused loudly.",
    );
    assert.throws(
      () => instrumentIpcHandlers({ ipcMain: makeIpcMain(), diagnostics: makeDiagnostics() }),
      (error) => error instanceof TypeError && /publishInstanceSnapshot/.test(error.message),
      "a missing publishInstanceSnapshot must be refused loudly: an omitted hook is exactly how the snapshot share would silently die.",
    );
  });
}

// ---------------------------------------------------------------------------
// Phase B: alert state collector behaviour.
// ---------------------------------------------------------------------------
function makeCollectorWorld({
  getSelectedNodeId = () => "node-a",
  hostNodeId = "app-host-node",
  nodesPayload = { nodes: [{ id: "node-a" }] },
  instancesPayload = { instances: [{ id: "inst-1" }] },
  listNodesImpl = null,
  listInstancesImpl = null,
} = {}) {
  const calls = { resolve: [], listInstances: [], listNodes: [] };
  const nodeService = {
    APPLICATION_HOST_NODE_ID: hostNodeId,
    getSelectedNodeId,
    listNodes: async (options) => {
      calls.listNodes.push(options);
      if (listNodesImpl) return listNodesImpl();
      return nodesPayload;
    },
  };
  const alertService = {
    resolveInstanceSnapshot: async (nodeId, fetcher) => {
      calls.resolve.push({ nodeId, fetcher });
      const value = await fetcher();
      calls.resolvedValue = value;
      return value;
    },
  };
  const serviceRouter = {
    listInstances: async (options) => {
      calls.listInstances.push(options);
      if (listInstancesImpl) return listInstancesImpl();
      return instancesPayload;
    },
  };
  return { calls, nodeService, alertService, serviceRouter, hostNodeId };
}

async function phaseCollector() {
  await check("B1. RESOLVE: the selected node id is passed to resolveInstanceSnapshot, exactly once", async () => {
    const world = makeCollectorWorld({ getSelectedNodeId: () => "node-selected" });
    const state = await createAlertStateCollector(world)({});

    assert.strictEqual(
      world.calls.resolve.length,
      1,
      `reuse-wiring violated: resolveInstanceSnapshot must be called exactly once per pass (was ${world.calls.resolve.length}). Dropping this call is what makes the snapshot share dead while alertService.js stays perfect.`,
    );
    assert.strictEqual(
      world.calls.resolve[0].nodeId,
      "node-selected",
      `reuse-wiring violated: resolveInstanceSnapshot must be called with the SELECTED node id, not a constant (got ${JSON.stringify(world.calls.resolve[0].nodeId)}).`,
    );
    assert.strictEqual(typeof world.calls.resolve[0].fetcher, "function", "resolveInstanceSnapshot must receive a fetcher function.");
    assert.deepStrictEqual(state, { nodes: [{ id: "node-a" }], instances: [{ id: "inst-1" }] }, "the collector must shape the two payloads into { nodes, instances }.");
  });

  await check("B2. RESOLVE: the APPLICATION_HOST_NODE_ID fallback is used for every falsy selection", async () => {
    for (const selection of [null, undefined, ""]) {
      const world = makeCollectorWorld({ getSelectedNodeId: () => selection, hostNodeId: "host-fallback-node" });
      await createAlertStateCollector(world)({});
      assert.strictEqual(
        world.calls.resolve[0].nodeId,
        "host-fallback-node",
        `fallback violated: a falsy selection (${JSON.stringify(selection)}) must resolve to service.APPLICATION_HOST_NODE_ID, the SAME value the app-host path uses; got ${JSON.stringify(world.calls.resolve[0].nodeId)}.`,
      );
    }
  });

  await check("B3. FETCH: the fetcher handed to resolveInstanceSnapshot delegates to serviceRouter.listInstances({})", async () => {
    const world = makeCollectorWorld();
    await createAlertStateCollector(world)({});

    assert.deepStrictEqual(
      world.calls.listInstances,
      [{}],
      `fetcher violated: the fetcher must call serviceRouter.listInstances({}); got ${JSON.stringify(world.calls.listInstances)}.`,
    );
    assert.deepStrictEqual(
      world.calls.resolvedValue,
      { instances: [{ id: "inst-1" }] },
      "the fetcher must RESOLVE to the router's payload so resolveInstanceSnapshot can return it.",
    );
  });

  await check("B4. FETCH: the fetcher swallows a router failure into { instances: [] } instead of rejecting", async () => {
    const world = makeCollectorWorld({
      listInstancesImpl: () => {
        throw Object.assign(new Error("router down"), { code: "ROUTER_DOWN" });
      },
    });
    const state = await createAlertStateCollector(world)({});
    assert.deepStrictEqual(state.instances, [], "an unreachable router must degrade to an empty instance list, not fail the evaluation pass.");
  });

  await check("B5. READ: nodes and instances are read CONCURRENTLY (a serial implementation cannot pass this)", async () => {
    let listInstancesCalled = false;
    const world = makeCollectorWorld({
      // listNodes blocks until listInstances has been called. Under Promise.all
      // that resolves; under a serial `await listNodes` then `await ...` it can
      // never be satisfied and this check times out, naming the coupling.
      listNodesImpl: async () => {
        await waitFor(() => listInstancesCalled, 2000);
        return { nodes: [{ id: "node-a" }] };
      },
      listInstancesImpl: async () => {
        listInstancesCalled = true;
        return { instances: [{ id: "inst-1" }] };
      },
    });
    const state = await createAlertStateCollector(world)({});
    assert.deepStrictEqual(state, { nodes: [{ id: "node-a" }], instances: [{ id: "inst-1" }] }, "both concurrent reads must contribute to the state.");
  });

  await check("B6. READ: listNodes receives exactly the read-only options", async () => {
    const world = makeCollectorWorld();
    await createAlertStateCollector(world)({});
    assert.deepStrictEqual(
      world.calls.listNodes,
      [{ discoverLocalAgent: false, refreshIdentity: false }],
      `the collector must pass { discoverLocalAgent: false, refreshIdentity: false }; got ${JSON.stringify(world.calls.listNodes)}.`,
    );
  });

  await check("B7. READ: a failing listNodes degrades to { nodes: [] } instead of rejecting", async () => {
    const world = makeCollectorWorld({
      listNodesImpl: () => {
        throw new Error("node service down");
      },
    });
    const state = await createAlertStateCollector(world)({});
    assert.deepStrictEqual(state.nodes, [], "an unreachable node service must degrade to an empty node list, not fail the pass.");
  });

  await check("B8. RETURN: missing or malformed payload shapes become empty arrays, never undefined", async () => {
    for (const [label, nodesPayload, instancesPayload] of [
      ["null payloads", null, null],
      ["undefined payloads", undefined, undefined],
      ["object without the collection", { ok: true }, { ok: true }],
    ]) {
      const world = makeCollectorWorld({
        listNodesImpl: async () => nodesPayload,
        listInstancesImpl: async () => instancesPayload,
      });
      const state = await createAlertStateCollector(world)({});
      assert.deepStrictEqual(
        state,
        { nodes: [], instances: [] },
        `${label}: the evaluator's snapshot must receive empty arrays, not undefined (buildAlertSnapshot tolerates it, but the shape contract is arrays).`,
      );
    }
  });

  await check("B9. CONTRACT: missing dependencies fail fast instead of silently no-op'ing", async () => {
    const world = makeCollectorWorld();
    assert.throws(() => createAlertStateCollector({}), (error) => error instanceof TypeError, "no dependencies at all must be refused loudly.");
    assert.throws(
      () => createAlertStateCollector({ nodeService: world.nodeService, alertService: world.alertService }),
      (error) => error instanceof TypeError && /serviceRouter/.test(error.message),
      "a missing serviceRouter must be refused loudly.",
    );
    assert.throws(
      () => createAlertStateCollector({ nodeService: world.nodeService, serviceRouter: world.serviceRouter }),
      (error) => error instanceof TypeError && /alertService/.test(error.message),
      "a missing alertService must be refused loudly.",
    );
    assert.throws(
      () => createAlertStateCollector({ alertService: world.alertService, serviceRouter: world.serviceRouter }),
      (error) => error instanceof TypeError && /nodeService/.test(error.message),
      "a missing nodeService must be refused loudly.",
    );
  });
}

// ---------------------------------------------------------------------------
// Phase C: residual main.js surface. TEXT ONLY — see the header for what this
// half can and cannot prove. Synchronous, but reported through the same named
// check shape as phases A/B so a failure names the invariant in one line.
// ---------------------------------------------------------------------------
function syncCheck(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.error(`  FAIL ${name}`);
    console.error(`       ${error && error.message ? error.message : error}`);
    throw error;
  }
}

function phaseResidualMainSurface() {
  const raw = fs.readFileSync(MAIN_PATH, "utf8");
  const source = normalizeSource(raw);

  const exact = (expression, message) => assert.ok(source.includes(expression), message);

  syncCheck("C1. TEXT: main.js requires the extracted IPC instrumentation module", () => {
    exact(
      'const { instrumentIpcHandlers } = require("./src/ipc/ipcHandlerInstrumentation");',
      'main.js must require the extracted instrumentation module (without it the wrapper is never installed).',
    );
  });

  syncCheck("C2. TEXT: main.js requires the extracted alert state collector", () => {
    exact(
      'const { createAlertStateCollector } = require("./src/services/alertStateCollector");',
      "main.js must require the extracted alert state collector.",
    );
  });

  syncCheck("C3. TEXT: main.js invokes instrumentIpcHandlers with the live getter and the publish hook", () => {
    exact(
      'instrumentIpcHandlers({ ipcMain, diagnostics, isShuttingDown: () => appShuttingDown, publishInstanceSnapshot: (nodeId, payload) => require("./src/services/alertService").publishInstanceSnapshot(nodeId, payload), });',
      "main.js must invoke instrumentIpcHandlers with ipcMain, diagnostics, the LIVE shutdown getter, and the lazy publishInstanceSnapshot closure. A bare `instrumentIpcHandlers` identifier would not prove the call, and a dropped publishInstanceSnapshot argument would silently kill the snapshot share.",
    );
  });

  syncCheck("C4. TEXT: main.js starts the scheduler with the extracted collector", () => {
    exact(
      "alertService.startAlertScheduler({ collectState: createAlertStateCollector({ nodeService, alertService, serviceRouter }), });",
      "main.js must start the alert scheduler with the extracted collector built from nodeService/alertService/serviceRouter.",
    );
  });

  syncCheck("C5. TEXT: main.js stops the scheduler on quit", () => {
    exact(
      "alertService.stopAlertScheduler();",
      "main.js must stop the alert scheduler on quit.",
    );
  });

  syncCheck("C6. TEXT: the extracted bodies are GONE from main.js (no re-inlined duplicate)", () => {
    // A re-inlined copy would leave phase A testing a module the app no longer
    // runs, while main.js carried a second copy that no behavioural check
    // exercises — the exact failure mode this file exists to prevent.
    for (const leftover of [
      "function instrumentIpcHandlers",
      "measureIpcPayloadBytes",
      "IPC_PAYLOAD_BYTES_ENABLED",
      "IPC request started",
      "IPC request completed",
      "resolveInstanceSnapshot(",
      "APPLICATION_SHUTTING_DOWN",
    ]) {
      assert.ok(
        !source.includes(leftover),
        `main.js must no longer contain "${leftover}": that body was extracted into a require-able module, and a re-inlined copy would be untested (phase A tests the module, not main.js).`,
      );
    }
  });

  syncCheck("C7. ORDER: whenReady < instrumentIpcHandlers < registerInstancesIpc < collector, and start < stop", () => {
    const marks = {
      "app.whenReady().then(async () => {": source.indexOf("app.whenReady().then(async () => {"),
      "instrumentIpcHandlers({": source.indexOf("instrumentIpcHandlers({"),
      "registerInstancesIpc();": source.indexOf("registerInstancesIpc();"),
      "createAlertStateCollector(": source.indexOf("createAlertStateCollector("),
      "alertService.startAlertScheduler(": source.indexOf("alertService.startAlertScheduler("),
      "alertService.stopAlertScheduler();": source.indexOf("alertService.stopAlertScheduler();"),
    };
    for (const [label, index] of Object.entries(marks)) {
      assert.ok(index !== -1, `order check precondition failed: "${label}" was not found in main.js.`);
    }
    assert.ok(
      marks["app.whenReady().then(async () => {"] < marks["instrumentIpcHandlers({"],
      "order violated: instrumentIpcHandlers() must be invoked inside the whenReady startup callback, not at module load.",
    );
    assert.ok(
      marks["instrumentIpcHandlers({"] < marks["registerInstancesIpc();"],
      "order violated: instrumentIpcHandlers() must run BEFORE registerInstancesIpc(), otherwise instances:list is registered through the unwrapped ipcMain.handle and is never instrumented or shared.",
    );
    assert.ok(
      marks["registerInstancesIpc();"] < marks["createAlertStateCollector("],
      "order violated: the alert scheduler's collector must be wired after registerInstancesIpc(), so the channel it depends on exists before the first evaluation pass.",
    );
    assert.ok(
      marks["alertService.startAlertScheduler("] < marks["alertService.stopAlertScheduler();"],
      "order violated: the scheduler must be started before its before-quit stop handler is registered.",
    );
  });

  console.log("phase C  residual main.js surface: text-only (calls exist as text, in order; runtime reachability NOT proven)");
}

async function main() {
  console.log("instance-snapshot-wiring-smoke: main.js call-site wiring for SMOOTH-3010 snapshot reuse");
  await phaseInstrumentation();
  await phaseCollector();
  phaseResidualMainSurface();
  console.log(`${results.length} checks passed`);
  console.log("instance-snapshot-wiring-smoke passed");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});