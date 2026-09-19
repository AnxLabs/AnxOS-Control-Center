#!/usr/bin/env node
"use strict";

// SMOOTH-3011 / SMOOTH-3010 runtime wiring smoke — boots the REAL Electron app.
//
// WHY THIS SUITE EXISTS
// `scripts/instance-snapshot-wiring-smoke.js` proves the extracted modules behave
// (phase A/B) and that the residual main.js call sites exist as TEXT outside
// comments, in the right order (phase C). Its header says plainly what phase C
// cannot do: prove RUNTIME REACHABILITY — that the whenReady callback executes,
// that the wrapper really installs on ipcMain, that a real IPC round trip
// publishes a snapshot, that the scheduler's timer ticks. This suite closes that
// gap with a live process instead of a text scan.
//
// WHAT THIS SUITE DRIVES
//   1. WRAPPER INSTALLED + durationMs. From the renderer (the shipped preload
//      bridge), invoke a real channel that is registered AFTER
//      instrumentIpcHandlers(). Observe the "IPC request started" /
//      "IPC request completed {durationMs}" PAIR appear in the isolated
//      <logDir>/ipc.log, sharing one correlationId.
//   2. instances:list PUBLISH. Drive a real `instances:list` reply, then read the
//      LIVE alertService module instance (same file, same require cache) and
//      assert the reply was shared for that node id. The publish is wrapped in a
//      try/catch and is best-effort, so absence is silent — which is exactly why
//      a runtime read is the proof.
//   3. SCHEDULER + COLLECTOR. The scheduler's immediate tick calls the real
//      collector, whose fetcher resolves and then `evaluateAlerts` persists the
//      alert store. `evaluateAlerts` has exactly two callers (runAlertEvaluation
//      and acknowledgeAlert); at startup, only the scheduler tick can reach it.
//      So a freshly-written store at launch proves the scheduler started AND the
//      collector executed. The reuse path is then exercised against LIVE module
//      state: with the freshly published snapshot, resolveInstanceSnapshot must
//      return it WITHOUT calling the fetcher, and a different node id must call
//      the fetcher (a falsification control).
//   4. PAYLOAD BYTES. With ANXOS_IPC_BYTE_METRICS=1 for the run, scan every real
//      completed record for a numeric `payloadBytes`. If no reachable shipped
//      channel returned a string/Buffer in this run, that is reported as
//      UNPROVEN rather than claimed.
//
// HONEST LIMITS (see the per-proof log lines at runtime)
//   * Proof 1 attributes a record to a channel by operation+counter, not by
//     identity of the specific renderer call; it asserts the count INCREASED by
//     the number of calls it made.
//   * Proof 3 does not observe the scheduler's 60 s REPEAT tick (no log is
//     emitted on that path and the interval is a minute out); it observes the
//     immediate tick through its persisted side effect, and exercises the reuse
//     DECISION against the live module state produced by the shipped wiring.
//   * Proof 4 is conditional on a shipped channel returning a measurable
//     (string/Buffer) payload; see the runtime report.
//
// ISOLATION
// The profile lives in a dedicated `--user-data-dir` under the system temp dir;
// config/log/temp are redirected by scripts/test-helpers/isolated-qa-env.js so
// the owner's real profile and .dev-logs are never read or written.
//
// FOLLOWS the established Electron launch pattern in
// scripts/stabilization-ui-qa.js: condition-based waits with a generous budget,
// no fixed sleep as an assertion gate, a dead-process fast-fail, and a watchdog
// DERIVED from the sum of the budgets so it can never pre-empt a diagnosable
// failure with an opaque timeout.

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");

const root = path.resolve(__dirname, "..");

// The renderer-driven channel. Registered in main.js AFTER instrumentIpcHandlers
// (main.js `ipcMain.handle("app:getRuntimeInfo", ...)`), so a started/completed
// record for it is only possible if the wrapper actually replaced ipcMain.handle.
const DRIVEN_CHANNEL = "app:getRuntimeInfo";
const APP_HOST_NODE_ID = "application-host";
const DRIVEN_CALLS = 3;

// ---------------------------------------------------------------------------
// Budgets and derived watchdog.
//
// A log-append observable is a same-machine filesystem write that lands in
// single-digit milliseconds; 15 s is a wide environmental cushion, not a
// boot-latency measurement. The bootstrap budget is larger because it spans
// process warm-up, the whenReady startup sequence and the first renderer calls.
// The watchdog must exceed the sum of the budgets that can elapse in one run,
// otherwise it pre-empts a diagnosable failure with "timed out".
// ---------------------------------------------------------------------------
const CONDITION_BUDGET_MS = 15000;
const BOOTSTRAP_BUDGET_MS = 45000;
const CONDITION_POLL_MS = 100;
const MAX_WAIT_BUDGETS_PER_RUN = 10; // observes 1 bootstrap + up to 9 conditions today
const WATCHDOG_MS = BOOTSTRAP_BUDGET_MS + MAX_WAIT_BUDGETS_PER_RUN * CONDITION_BUDGET_MS + 30000;

function redacted(value) {
  return String(value || "").replace(/(token|password|secret|authorization|cookie|session)[=:]\S+/gi, "$1=[redacted]");
}

function readTextSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function readIpcEntries(logDir) {
  const raw = readTextSafe(path.join(logDir, "ipc.log"));
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A partially-flushed final line is normal while the app is appending.
    }
  }
  return entries;
}

function rawLine(entry) {
  return JSON.stringify({
    operation: entry.operation,
    message: entry.message,
    context: entry.context,
    correlationId: entry.correlationId,
  });
}

async function waitForCondition(appProcess, { label, probe, budgetMs = CONDITION_BUDGET_MS, intervalMs = CONDITION_POLL_MS }) {
  const attempts = Math.max(1, Math.ceil(budgetMs / intervalMs));
  const startedAt = Date.now();
  let lastState = "no observation recorded";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (appProcess && (appProcess.exitCode !== null || appProcess.signalCode !== null)) {
      throw new Error(
        `${label} can never become true: the application exited (code=${appProcess.exitCode} signal=${appProcess.signalCode}) after ${Date.now() - startedAt} ms. Last observed state: ${lastState}`,
      );
    }
    try {
      const observation = await probe();
      lastState = redacted(observation.state);
      if (observation.ready) return observation.value;
    } catch (error) {
      lastState = redacted(`probe could not observe anything: ${error?.message || String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `${label} did not become true within ${Date.now() - startedAt} ms of polling ` +
    `(budget ${budgetMs} ms, ${attempts} polls at ${intervalMs} ms). Last observed state: ${lastState}`,
  );
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-ipc-wiring-"));
  // config/log/temp redirection: logs land in <qaEnv.root>/logs, NOT the real
  // .dev-logs, so this suite never depends on or pollutes the owner's logs.
  const qaEnvironment = createIsolatedQaEnv("anx-ipc-wiring-env-");
  const alertStorePath = path.join(qaEnvironment.configDir, "alerts.json");
  const launchStartedAt = Date.now();

  let app = null;
  const mainLogs = [];
  const proof = {};
  const watchdog = setTimeout(() => {
    console.error(`ipc-wiring-runtime-smoke FAILED: watchdog of ${WATCHDOG_MS} ms elapsed before a verdict was reached.`);
    console.error(JSON.stringify(proof, null, 2));
    app?.close?.().catch(() => {});
    process.exitCode = 1;
  }, WATCHDOG_MS);

  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, "--no-sandbox", root, "--qa-mode"],
      env: { ...process.env, ...qaEnvironment.env, ANXOS_QA_MODE: "1", ANXOS_IPC_BYTE_METRICS: "1" },
    });
    const appProcess = app.process();
    const onMainOutput = (chunk) => mainLogs.push(redacted(chunk.toString()));
    appProcess.stdout?.on("data", onMainOutput);
    appProcess.stderr?.on("data", onMainOutput);

    const page = await app.firstWindow();
    page.setDefaultTimeout(8000);
    await page.waitForLoadState("domcontentloaded");

    // Bootstrap: the preload bridge must exist in the renderer's main world and
    // at least one IPC record must already be in the log. If the running lane
    // that owns preload.js/app.js has the app mid-edit, this fails with the
    // bridge state rather than an opaque timeout.
    await waitForCondition(appProcess, {
      label: "the shipped preload bridge (window.anx) must be available and at least one IPC record must have been written",
      budgetMs: BOOTSTRAP_BUDGET_MS,
      probe: async () => {
        const bridge = await page.evaluate(() => ({
          anx: typeof window.anx === "object" && window.anx !== null,
          app: typeof window.anx?.app?.getRuntimeInfo === "function",
          instancesList: typeof window.anx?.instances?.list === "function",
        })).catch((error) => ({ error: error?.message || String(error) }));
        const entries = readIpcEntries(qaEnvironment.logDir);
        const completed = entries.filter((entry) => entry.message === "IPC request completed").length;
        return {
          ready: bridge.anx === true && bridge.app === true && completed > 0,
          state: JSON.stringify({ bridge, completedRecords: completed, logDir: qaEnvironment.logDir }),
        };
      },
    });

    // -----------------------------------------------------------------------
    // PROOF 1 — the instrumentation wrapper is installed on the real ipcMain.
    // -----------------------------------------------------------------------
    const baseline = readIpcEntries(qaEnvironment.logDir)
      .filter((entry) => entry.operation === DRIVEN_CHANNEL && entry.message === "IPC request completed").length;

    const driven = await page.evaluate(async (channel) => {
      const results = [];
      for (let index = 0; index < 3; index += 1) {
        results.push(await window.anx.app.getRuntimeInfo());
      }
      return { count: results.length, allObjects: results.every((value) => value && typeof value === "object") };
    }, DRIVEN_CHANNEL);

    const proofOne = await waitForCondition(appProcess, {
      label: `the driven channel "${DRIVEN_CHANNEL}" must emit ${DRIVEN_CALLS} new IPC request completed records with durationMs`,
      probe: () => {
        const entries = readIpcEntries(qaEnvironment.logDir);
        const completed = entries.filter((entry) => entry.operation === DRIVEN_CHANNEL && entry.message === "IPC request completed");
        const withDuration = completed.filter((entry) => Number.isFinite(entry.context?.durationMs));
        const paired = withDuration.filter((entry) => entries.some(
          (other) => other.message === "IPC request started" && other.correlationId === entry.correlationId,
        ));
        return {
          ready: completed.length - baseline >= DRIVEN_CALLS && paired.length >= 1,
          value: { completed: completed.length, baseline, withDurationMs: withDuration.length, paired: paired.length, sample: paired[0] || null },
          state: `channel=${DRIVEN_CHANNEL} completed=${completed.length} (baseline ${baseline}) withDurationMs=${withDuration.length} paired=${paired.length}`,
        };
      },
    });
    assert.ok(proofOne.paired >= 1, "at least one driven call must produce a started/completed pair sharing one correlationId");
    assert.ok(proofOne.sample?.context?.durationMs !== undefined, "the completed record must carry context.durationMs");
    proof.proof1 = {
      status: "PROVEN AT RUNTIME",
      channel: DRIVEN_CHANNEL,
      drivenCalls: driven.count,
      replyWasObject: driven.allObjects,
      completedRecords: proofOne.completed,
      recordsWithDurationMs: proofOne.withDurationMs,
      pairedStartedCompleted: proofOne.paired,
      sampleCompletedLine: rawLine(proofOne.sample),
    };
    console.log(`proof 1  WRAPPER INSTALLED: ${proofOne.paired} started/completed pair(s) for ${DRIVEN_CHANNEL}`);
    console.log(`         ${rawLine(proofOne.sample)}`);

    // -----------------------------------------------------------------------
    // PROOF 2 + 3b — the live alertService module state, driven by real IPC.
    // One evaluate so the read happens against the SAME module instance the app
    // loaded (absolute path => identical require-cache entry as main.js's
    // relative require), not a second copy.
    // -----------------------------------------------------------------------
    const listResult = await page.evaluate(async (nodeId) => {
      const reply = await window.anx.instances.list({ nodeId });
      return {
        instanceCount: Array.isArray(reply?.instances) ? reply.instances.length : null,
        keys: reply && typeof reply === "object" ? Object.keys(reply) : null,
      };
    }, APP_HOST_NODE_ID);

    const observation = await app.evaluate(async ({ app }, arg) => {
      const loadModule = (target) => {
        try {
          return require(target);
        } catch (primary) {
          try {
            return process.mainModule.require(target);
          } catch (secondary) {
            throw new Error(`require("${target}") failed: ${primary && primary.message} | ${secondary && secondary.message}`);
          }
        }
      };
      const nodePath = loadModule("path");
      const alertService = loadModule(nodePath.join(app.getAppPath(), "src", "services", "alertService"));
      const instrumentation = loadModule(nodePath.join(app.getAppPath(), "src", "ipc", "ipcHandlerInstrumentation"));

      const nodeId = arg.nodeId;
      const snapshot = alertService.getInstanceSnapshot(nodeId);

      let fastPathFetcherCalled = false;
      const fastPath = await alertService.resolveInstanceSnapshot(nodeId, async () => {
        fastPathFetcherCalled = true;
        return { instances: [{ id: "__fetcher__" }] };
      });

      const controlNodeId = `__absent-node-${Date.now()}__`;
      let controlFetcherCalled = false;
      const controlValue = await alertService.resolveInstanceSnapshot(controlNodeId, async () => {
        controlFetcherCalled = true;
        return { instances: [] };
      });

      return {
        nodeId,
        payloadBytesGateEnabled: instrumentation.IPC_PAYLOAD_BYTES_ENABLED === true,
        snapshotPresent: Boolean(snapshot),
        snapshotInstanceCount: Array.isArray(snapshot?.instances) ? snapshot.instances.length : null,
        fastPathFetcherCalled,
        fastPathInstanceCount: Array.isArray(fastPath?.instances) ? fastPath.instances.length : null,
        controlNodeId,
        controlFetcherCalled,
        controlInstanceCount: Array.isArray(controlValue?.instances) ? controlValue.instances.length : null,
      };
    }, { nodeId: APP_HOST_NODE_ID });

    assert.ok(
      observation.snapshotPresent,
      `instances:list reply was not shared: alertService.getInstanceSnapshot("${APP_HOST_NODE_ID}") is null. ` +
      `The publish is best-effort and silent, so either the channel did not reply successfully ` +
      `(renderer got instanceCount=${JSON.stringify(listResult.instanceCount)}) or the publish hook is not wired.`,
    );
    assert.strictEqual(
      observation.fastPathFetcherCalled,
      false,
      "reuse path violated: with a fresh cross-node snapshot present, resolveInstanceSnapshot must NOT call the fetcher.",
    );
    assert.strictEqual(
      observation.controlFetcherCalled,
      true,
      "falsification control failed: for a node with no snapshot the fetcher MUST be called, otherwise the positive assertion is vacuous.",
    );
    proof.proof2 = {
      status: "PROVEN AT RUNTIME",
      nodeId: APP_HOST_NODE_ID,
      rendererReplyInstanceCount: listResult.instanceCount,
      rendererReplyKeys: listResult.keys,
      liveSnapshotPresent: observation.snapshotPresent,
      liveSnapshotInstanceCount: observation.snapshotInstanceCount,
    };
    proof.proof3b = {
      status: "PROVEN AT RUNTIME",
      fastPathFetcherCalled: observation.fastPathFetcherCalled,
      fastPathInstanceCount: observation.fastPathInstanceCount,
      controlNodeId: observation.controlNodeId,
      controlFetcherCalled: observation.controlFetcherCalled,
      controlInstanceCount: observation.controlInstanceCount,
    };
    console.log(`proof 2  instances:list PUBLISH: reply instances=${JSON.stringify(listResult.instanceCount)}, live snapshot present=${observation.snapshotPresent} instances=${JSON.stringify(observation.snapshotInstanceCount)} for node ${APP_HOST_NODE_ID}`);
    console.log(`proof 3b REUSE: fast-path fetcher called=${observation.fastPathFetcherCalled} (want false); control node fetch called=${observation.controlFetcherCalled} (want true)`);

    // -----------------------------------------------------------------------
    // PROOF 3a — the scheduler's immediate tick ran with the collector.
    // evaluateAlerts persists the store; its only startup caller is the
    // scheduler's tick via runAlertEvaluation -> the collector.
    // -----------------------------------------------------------------------
    const store = await waitForCondition(appProcess, {
      label: "the alert store must be written by a startup evaluation pass (proves the scheduler ticked and the collector resolved)",
      probe: () => {
        const raw = readTextSafe(alertStorePath);
        if (!raw.trim()) return { ready: false, state: `no alert store yet at ${alertStorePath}` };
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return { ready: false, state: `alert store present but not yet valid JSON at ${alertStorePath}` };
        }
        const updatedMs = Date.parse(parsed?.updatedAt || "");
        return {
          ready: Number.isFinite(updatedMs) && updatedMs >= launchStartedAt - 2000,
          value: { updatedAt: parsed?.updatedAt || null, activeCount: Array.isArray(parsed?.active) ? parsed.active.length : null, schemaVersion: parsed?.schemaVersion ?? null },
          state: `alerts.json updatedAt=${parsed?.updatedAt} active=${JSON.stringify(parsed?.active?.length)}`,
        };
      },
    });
    assert.ok(store.updatedAt, "the alert store must carry an updatedAt written at/after launch");
    proof.proof3a = {
      status: "PROVEN AT RUNTIME",
      storePath: alertStorePath,
      updatedAt: store.updatedAt,
      launchStartedAt: new Date(launchStartedAt).toISOString(),
      activeCount: store.activeCount,
      schemaVersion: store.schemaVersion,
      note: "evaluateAlerts has exactly two callers (runAlertEvaluation, acknowledgeAlert); only the scheduler's immediate tick can reach it at startup.",
    };
    console.log(`proof 3a SCHEDULER/COLLECTOR: alerts.json written by startup evaluation pass, updatedAt=${store.updatedAt} (launch began ${new Date(launchStartedAt).toISOString()})`);

    // -----------------------------------------------------------------------
    // PROOF 4 — payloadBytes on a real completed record (gate forced on).
    // -----------------------------------------------------------------------
    const allEntries = readIpcEntries(qaEnvironment.logDir);
    const completedAll = allEntries.filter((entry) => entry.message === "IPC request completed");
    const withPayloadBytes = completedAll.filter((entry) => typeof entry.context?.payloadBytes === "number");
    assert.strictEqual(
      observation.payloadBytesGateEnabled,
      true,
      "ANXOS_IPC_BYTE_METRICS=1 must have been read at module load in the live process, otherwise proof 4 tests nothing.",
    );
    if (withPayloadBytes.length > 0) {
      proof.proof4 = {
        status: "PROVEN AT RUNTIME",
        gateEnabledInLiveProcess: true,
        completedRecordsScanned: completedAll.length,
        recordsWithPayloadBytes: withPayloadBytes.length,
        sampleCompletedLine: rawLine(withPayloadBytes[0]),
      };
      console.log(`proof 4  PAYLOAD BYTES: ${withPayloadBytes.length} real completed record(s) carried payloadBytes`);
      console.log(`         ${rawLine(withPayloadBytes[0])}`);
    } else {
      proof.proof4 = {
        status: "UNPROVEN",
        gateEnabledInLiveProcess: true,
        completedRecordsScanned: completedAll.length,
        recordsWithPayloadBytes: 0,
        reason: "No reachable shipped channel returned a string/Buffer payload in this run; the instrument deliberately skips object/array payloads (never re-serializes them), so no payloadBytes field could be emitted. The gate was active in the live process.",
      };
      console.log(`proof 4  PAYLOAD BYTES: UNPROVEN — gate active in the live process, but 0 of ${completedAll.length} completed record(s) had a measurable (string/Buffer) payload.`);
    }

    // -----------------------------------------------------------------------
    // Verdict. Also assert no main-process exception was swallowed into a
    // startup that "passed" while the wiring silently failed.
    // -----------------------------------------------------------------------
    const startupFailure = mainLogs.join("").match(/\[Alerts\] Scheduler start failed\./);
    assert.ok(!startupFailure, "main.js reported that the alert scheduler failed to start; the other proofs cannot stand.");

    console.log("");
    console.log(JSON.stringify({
      pass: true,
      logDir: qaEnvironment.logDir,
      configDir: qaEnvironment.configDir,
      proof1: proof.proof1,
      proof2: proof.proof2,
      proof3a: proof.proof3a,
      proof3b: proof.proof3b,
      proof4: proof.proof4,
    }, null, 2));
    console.log("ipc-wiring-runtime-smoke passed");
  } finally {
    clearTimeout(watchdog);
    await app?.close?.().catch(() => {});
    // Retries only apply alongside `recursive: true` (Node ignores them on the
    // non-recursive path); the repo's rm-sync-retry guard enforces that rule.
    // A cleanup failure must not replace the verdict, so it is reported, not thrown.
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (cleanupError) {
      console.warn(`[cleanup] could not remove the QA profile directory ${userDataDir}: ${cleanupError?.code || cleanupError?.message || cleanupError}`);
    }
    qaEnvironment.cleanup();
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});