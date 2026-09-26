#!/usr/bin/env node
// Marketplace readiness smoke — Build 205 honest-outcome coverage.
//
// The adversarial review found the two claimed honest-outcome behaviors had no
// automated coverage (they were only verified by hand in WSL). This smoke pins
// them with hard legs:
//
//   A. Paper pre-flight refusal: a resolved version whose `javaMinimum` is
//      newer than the Java major the selected node reported must fail with
//      JAVA_VERSION_UNSUPPORTED before any download or start, naming the
//      required and available Java majors. An equal major must not refuse.
//   B. Start-readiness honesty: Starting -> Stopped -> Stopped must surface
//      START_FAILED with the process failure metadata; Starting -> Running
//      (readinessState ready) must report a ready start; a slow-but-alive
//      process that never becomes ready must stay "readiness pending".
//   C. F6: a fast Failed -> Starting -> Failed crash-restart alternation must
//      be terminal instead of being reported as readiness pending.
//   D. F6b: a non-retryable resolver failure (JAVA_VERSION_UNSUPPORTED) must
//      not mark the download record retryable, while retryable resolver
//      failures still must.
//
// Hermetic: pinAgentRoots keeps config/instance/job roots inside a temp tree,
// and global.fetch plus the agent client are mocked, so no network, no
// Electron, and no real application data is touched.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");

// Never inherit a real config root from the shell; pinAgentRoots uses the
// (now unset) env var only as an override.
delete process.env.ANXHUB_CONFIG_DIR;
pinAgentRoots("anx-marketplace-readiness-smoke-");

const marketplaceService = require("../src/services/marketplaceService");
const agentClient = require("../src/services/agentClient");

const {
  assertResolvedJavaCompatible,
  resolveAvailableJavaMajor,
  waitForStartedInstanceReadiness,
} = marketplaceService._test;

const NODE_ID = "readiness-smoke-node";
// Synthetic double, deliberately not a real Minecraft release: no published
// Paper version has a fabricated Java 25 minimum, so the mock data must not
// reuse a real version number and confuse future readers.
const PAPER_SYNTHETIC_VERSION_REQUIRES_JAVA_25 = "26.2";
const PAPER_VERSION_SUPPORTS_JAVA_21 = "1.21.10";
const PAPER_UNKNOWN_VERSION = "1.21.9";
const PAPER_JAR_URL = "https://mock.local/paper.jar";

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

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

// The selected node the smoke installs against. The mock agent never receives
// a real request, but resolveMarketplaceAgentConfig must still resolve an
// Agent-kind node so the dependency check (and its Java major) is exercised.
writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "nodes.json"), {
  schemaVersion: 2,
  selectedNodeId: NODE_ID,
  nodes: [{
    id: NODE_ID,
    kind: "agent",
    name: "Readiness Smoke Node",
    displayName: "Readiness Smoke Node",
    baseUrl: "http://192.168.1.134:47131",
    agentUrl: "http://192.168.1.134:47131",
    enabled: true,
    agentIdentity: { deviceId: "readiness-smoke-device" },
  }],
});
writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "node-agent-credentials.json"), {
  schemaVersion: 1,
  nodes: { [NODE_ID]: { agentToken: "smoke-token" } },
});

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)).buffer,
  };
}

function binaryResponse(body) {
  const buffer = Buffer.from(body);
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(buffer.length) },
    text: async () => body,
    arrayBuffer: async () => buffer,
  };
}

const originalFetch = global.fetch;

// Paper API mock: the synthetic 26.2 double requires Java 25, 1.21.10 requires
// Java 21, and any
// other requested version has no stable build (a retryable resolver failure).
function installFetchMock(fetches) {
  global.fetch = async (url) => {
    const href = String(url);
    fetches.push(href);
    if (href === "https://fill.papermc.io/v3/projects/paper/versions") {
      return jsonResponse({
        versions: [
          { version: { id: PAPER_SYNTHETIC_VERSION_REQUIRES_JAVA_25, java: { version: { minimum: 25 } } } },
          { version: { id: PAPER_VERSION_SUPPORTS_JAVA_21, java: { version: { minimum: 21 } } } },
        ],
      });
    }
    if (
      href === `https://fill.papermc.io/v3/projects/paper/versions/${PAPER_SYNTHETIC_VERSION_REQUIRES_JAVA_25}/builds`
      || href === `https://fill.papermc.io/v3/projects/paper/versions/${PAPER_VERSION_SUPPORTS_JAVA_21}/builds`
    ) {
      return jsonResponse([{
        id: 77,
        channel: "STABLE",
        downloads: { "server:default": { name: "paper.jar", url: PAPER_JAR_URL, size: 1024 } },
      }]);
    }
    if (href.startsWith("https://fill.papermc.io/v3/projects/paper/versions/")) {
      return jsonResponse([]);
    }
    if (href === PAPER_JAR_URL) {
      return binaryResponse("paper-jar-bytes");
    }
    throw new Error(`Unexpected readiness smoke fetch URL: ${href}`);
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

const patchedAgentMethods = [
  "createInstance",
  "listInstances",
  "createInstanceFolder",
  "writeInstanceFile",
  "readInstanceFile",
  "saveMinecraftProperties",
  "updateInstance",
  "getInstanceStatus",
  "startInstance",
  "forceKillInstance",
  "getInstanceLogs",
  "deleteInstance",
  "checkDependencies",
  "installDependencies",
];
const originalAgent = {};

function createHarness() {
  const instances = new Map();
  const files = new Map();
  const startedInstanceIds = [];
  const statusSequences = new Map();

  function currentInstance(instanceId) {
    const instance = instances.get(instanceId);
    if (!instance) {
      const error = new Error(`Missing mocked instance ${instanceId}`);
      error.code = "INSTANCE_NOT_FOUND";
      throw error;
    }
    return instance;
  }

  function javaDependencyCheck() {
    return {
      ok: true,
      dependencies: [{
        id: "java",
        displayName: "Java runtime",
        installed: true,
        supported: true,
        version: "21.0.1",
        minVersion: "17",
      }],
      missingDependencyIds: [],
    };
  }

  const harness = {
    instances,
    files,
    startedInstanceIds,
    statusSequences,
    currentInstance,
    setStatusSequence(instanceId, states) {
      statusSequences.set(instanceId, states.map((state) => ({ ...state })));
    },
    install() {
      patchedAgentMethods.forEach((name) => {
        originalAgent[name] = agentClient[name];
      });

      agentClient.createInstance = async (payload) => {
        const instance = { ...payload, state: "Stopped", pid: null, startupTimeoutMs: 30000 };
        instances.set(payload.id, instance);
        return { instance };
      };
      agentClient.listInstances = async () => ({
        root: "/mock/instances",
        instances: [...instances.values()],
      });
      agentClient.createInstanceFolder = async () => ({ ok: true });
      agentClient.writeInstanceFile = async (instanceId, filePath, content) => {
        files.set(`${instanceId}:${filePath}`, content);
        return { path: filePath, size: String(content || "").length };
      };
      agentClient.readInstanceFile = async (instanceId, filePath) => {
        const key = `${instanceId}:${filePath}`;
        if (!files.has(key)) {
          const error = new Error("Not found");
          error.code = "PATH_NOT_FOUND";
          throw error;
        }
        return { path: filePath, content: String(files.get(key) || "") };
      };
      agentClient.saveMinecraftProperties = async (instanceId, properties) => {
        files.set(`${instanceId}:server.properties`, JSON.stringify(properties));
        return { ok: true, properties };
      };
      agentClient.updateInstance = async (instanceId, patch) => {
        const next = { ...currentInstance(instanceId), ...patch };
        instances.set(instanceId, next);
        return { instance: next };
      };
      // After a start, queued states model the agent's polling view; the queue
      // is only consumed once the start was requested so pre-start status
      // reads (if any) cannot eat a leg's scripted sequence.
      agentClient.getInstanceStatus = async (instanceId) => {
        const instance = currentInstance(instanceId);
        const sequence = statusSequences.get(instanceId);
        if (startedInstanceIds.includes(instanceId) && Array.isArray(sequence) && sequence.length > 0) {
          const next = { ...instance, ...sequence.shift() };
          instances.set(instanceId, next);
          return { instance: next };
        }
        return { instance };
      };
      agentClient.startInstance = async (instanceId) => {
        if (!startedInstanceIds.includes(instanceId)) {
          startedInstanceIds.push(instanceId);
        }
        const next = {
          ...currentInstance(instanceId),
          state: "Starting",
          readinessState: "starting",
          pid: 4100 + startedInstanceIds.length,
        };
        instances.set(instanceId, next);
        return { instance: next };
      };
      agentClient.forceKillInstance = async () => ({ ok: true });
      agentClient.getInstanceLogs = async () => ({ entries: [] });
      agentClient.deleteInstance = async (instanceId) => {
        instances.delete(instanceId);
        return { deleted: true };
      };
      agentClient.checkDependencies = async () => javaDependencyCheck();
      agentClient.installDependencies = async () => javaDependencyCheck();
    },
  };

  return harness;
}

function restoreAgent() {
  patchedAgentMethods.forEach((name) => {
    agentClient[name] = originalAgent[name];
  });
}

async function installPaper(harness, instanceId, version, start = true) {
  harness.install();
  return marketplaceService.installTemplate({
    templateId: "minecraft-paper",
    nodeId: NODE_ID,
    options: {
      id: instanceId,
      name: "Readiness Smoke Paper",
      version,
      memory: "2G",
      port: 25579,
      acceptEula: true,
      start,
    },
  });
}

function findDownloadRecords(instanceId) {
  const downloads = marketplaceService.getDownloads().downloads;
  const parent = downloads.find((record) => record.retryContext?.options?.id === instanceId && !record.parentTaskId) || null;
  const child = parent
    ? downloads.find((record) => record.parentTaskId === parent.id && record.templateId === "minecraft-paper") || null
    : null;
  return { parent, child };
}

// ---------------------------------------------------------------------------
// A. Java pre-flight helper contract (unit level)
// ---------------------------------------------------------------------------
function checkJavaCompatibilityHelpers() {
  assert.strictEqual(
    resolveAvailableJavaMajor({ dependencies: [{ id: "java", installed: true, version: "21.0.1" }] }),
    21,
    "resolveAvailableJavaMajor must parse the installed Java major."
  );
  assert.strictEqual(
    resolveAvailableJavaMajor({ dependencies: [{ id: "java", installed: false, version: "21.0.1" }] }),
    null,
    "A dependency check that did not install Java must not report a Java major."
  );
  assert.strictEqual(
    resolveAvailableJavaMajor({ dependencies: [{ id: "nodejs", installed: true, version: "22.0.0" }] }),
    null,
    "A non-Java dependency must not be read as Java."
  );
  assert.strictEqual(resolveAvailableJavaMajor(null), null, "A missing dependency check must not guess a Java major.");

  assert.throws(
    () => assertResolvedJavaCompatible({ version: PAPER_SYNTHETIC_VERSION_REQUIRES_JAVA_25, javaMinimum: 25 }, 21),
    (error) => {
      assert.strictEqual(error?.code, "JAVA_VERSION_UNSUPPORTED", "A newer required Java must be refused.");
      assert.match(error.message, /requires Java 25/, "The refusal must name the required Java major.");
      assert.match(error.message, /Java 21/, "The refusal must name the available Java major.");
      assert.strictEqual(error.details?.requiredJavaMajor, 25, "The refusal must carry the required Java major.");
      assert.strictEqual(error.details?.availableJavaMajor, 21, "The refusal must carry the available Java major.");
      assert.strictEqual(error.details?.retryable, false, "A Java mismatch must be non-retryable.");
      return true;
    },
    "A version that requires Java 25 must be refused on a Java 21 node."
  );

  // Equal major, newer node Java, missing resolver minimum, and unknown node
  // Java all keep the previous behavior instead of guessing.
  assertResolvedJavaCompatible({ version: PAPER_VERSION_SUPPORTS_JAVA_21, javaMinimum: 21 }, 21);
  assertResolvedJavaCompatible({ version: "1.20.4", javaMinimum: 17 }, 21);
  assertResolvedJavaCompatible({ version: "1.20.4", javaMinimum: null }, 21);
  assertResolvedJavaCompatible({ version: "1.20.4", javaMinimum: 25 }, null);
}

// ---------------------------------------------------------------------------
// B. Paper install-level pre-flight refusal (F6b assertion included)
// ---------------------------------------------------------------------------
async function checkPaperJavaRefusal() {
  const harness = createHarness();
  const fetches = [];
  const instanceId = "paper-java-refusal-smoke";
  installFetchMock(fetches);
  try {
    await assert.rejects(
      () => installPaper(harness, instanceId, PAPER_SYNTHETIC_VERSION_REQUIRES_JAVA_25),
      (error) => {
        assert.strictEqual(error?.code, "JAVA_VERSION_UNSUPPORTED", `Expected JAVA_VERSION_UNSUPPORTED, got ${error?.code}: ${error?.message}`);
        assert.match(error.message, /requires Java 25/);
        assert.match(error.message, /Java 21/);
        assert.strictEqual(error.details?.retryable, false);
        return true;
      },
      "A Paper version that requires Java 25 must be refused on a Java 21 node."
    );
    assert(
      !fetches.includes(PAPER_JAR_URL),
      "The refused install must not download the server jar."
    );
    assert.strictEqual(
      harness.startedInstanceIds.length,
      0,
      "The refused install must not start an instance."
    );

    const { parent, child } = findDownloadRecords(instanceId);
    assert(child, "The refused install must keep a child download record.");
    assert.strictEqual(child.status, "failed", "The refused download record must be marked failed.");
    assert.match(child.error || "", /requires Java 25/, "The download record must explain the refusal.");
    assert.strictEqual(
      child.canRetry,
      false,
      "JAVA_VERSION_UNSUPPORTED must not offer a Retry that would fail identically (F6b)."
    );
    assert(parent, "The refused install must keep the parent install record.");
    assert.strictEqual(parent.canRetry, false, "The parent install record must also be non-retryable.");
  } finally {
    restoreAgent();
    restoreFetch();
  }
}

// ---------------------------------------------------------------------------
// B. Java 21 vs minimum 21: no refusal, and a pre-ready exit is START_FAILED
// ---------------------------------------------------------------------------
async function checkSupportedJavaStartFailure() {
  const harness = createHarness();
  const fetches = [];
  const instanceId = "paper-start-failure-smoke";
  harness.setStatusSequence(instanceId, [
    { state: "Starting", readinessState: "starting" },
    { state: "Stopped", readinessState: "stopped", exitCode: 1, failureReason: null },
    { state: "Stopped", readinessState: "stopped", exitCode: 1, failureReason: null },
  ]);
  installFetchMock(fetches);
  try {
    await assert.rejects(
      () => installPaper(harness, instanceId, PAPER_VERSION_SUPPORTS_JAVA_21),
      (error) => {
        assert.strictEqual(error?.code, "START_FAILED", `Expected START_FAILED, got ${error?.code}: ${error?.message}`);
        assert.match(error.message, /exit code 1/, "The failure must name the exit code.");
        assert.strictEqual(error.details?.failureReason, "PROCESS_EXITED", "A Stopped instance without a reason must be PROCESS_EXITED.");
        assert.strictEqual(error.details?.exitCode, 1, "The failure must carry the exit code.");
        assert.strictEqual(error.details?.state, "Stopped", "The failure must carry the observed state.");
        assert.strictEqual(error.details?.step, "Optional start", "The failure must identify the start step.");
        assert.strictEqual(error.details?.instanceId, instanceId, "The failure must identify the instance.");
        assert.strictEqual(error.details?.retryable, true, "A crashed start must stay retryable.");
        return true;
      },
      "A started process that exits before ready must fail the install."
    );
    assert(
      fetches.includes(PAPER_JAR_URL),
      "A Java 21 minimum on a Java 21 node must not be refused before download."
    );
    assert.strictEqual(
      harness.startedInstanceIds.length,
      1,
      "A Java 21 minimum on a Java 21 node must be allowed to start."
    );
  } finally {
    restoreAgent();
    restoreFetch();
  }
}

// ---------------------------------------------------------------------------
// B. Starting -> Running (ready) is a successful start
// ---------------------------------------------------------------------------
async function checkReadyStart() {
  const harness = createHarness();
  const fetches = [];
  const instanceId = "paper-ready-start-smoke";
  harness.setStatusSequence(instanceId, [
    { state: "Starting", readinessState: "starting" },
    { state: "Running", readinessState: "ready", pid: 7777 },
  ]);
  installFetchMock(fetches);
  try {
    const result = await installPaper(harness, instanceId, PAPER_VERSION_SUPPORTS_JAVA_21);
    assert.strictEqual(result.instance?.id, instanceId, "A ready start must return the installed instance.");
    const startStep = result.progress.filter((step) => step.label === "Optional start").pop();
    assert(startStep, "The install progress must include the Optional start step.");
    assert.strictEqual(startStep.status, "complete", "A ready start must complete the Optional start step.");
    assert.match(startStep.detail || "", /reported ready/, "A ready start must be reported as ready, not pending.");
    assert.strictEqual(harness.startedInstanceIds.length, 1, "The ready start must have started the instance once.");
  } finally {
    restoreAgent();
    restoreFetch();
  }
}

// ---------------------------------------------------------------------------
// C. F6: fast crash-restart alternation is terminal, not pending
// ---------------------------------------------------------------------------
async function checkCrashRestartAlternationIsTerminal() {
  const harness = createHarness();
  const instanceId = "readiness-crashloop-smoke";
  harness.instances.set(instanceId, {
    id: instanceId,
    state: "Starting",
    readinessState: "starting",
    startupTimeoutMs: 30000,
  });
  // A process that keeps crash-restarting faster than the 1 s sampling: the
  // state never stays Failed for two consecutive samples, so only the total
  // failed-sample count can catch it.
  const crashRestartStates = [];
  for (let index = 0; index < 12; index += 1) {
    crashRestartStates.push(index % 2 === 0
      ? { state: "Failed", readinessState: "failed", exitCode: 1, failureReason: "PROCESS_EXITED" }
      : { state: "Starting", readinessState: "starting", pid: 5000 + index });
  }
  harness.setStatusSequence(instanceId, crashRestartStates);
  harness.install();
  try {
    // The helper is driven directly: the queue is keyed on a requested start,
    // so record one to activate the scripted states.
    harness.startedInstanceIds.push(instanceId);
    const result = await waitForStartedInstanceReadiness(instanceId);
    assert.strictEqual(
      result.failed,
      true,
      "A Failed -> Starting -> Failed crash-restart alternation must be terminal, not readiness pending."
    );
    assert.strictEqual(result.ready, false, "A crash-looping start must not be reported ready.");
    assert.strictEqual(result.instance?.state, "Failed", "The terminal result must carry the failed instance.");
  } finally {
    restoreAgent();
  }
}

// ---------------------------------------------------------------------------
// B. Slow-but-alive deadline stays "readiness pending"
// ---------------------------------------------------------------------------
async function checkSlowButAliveDeadlineIsPending() {
  const harness = createHarness();
  const instanceId = "readiness-pending-smoke";
  harness.instances.set(instanceId, {
    id: instanceId,
    state: "Starting",
    readinessState: "starting",
    startupTimeoutMs: 30000,
  });
  harness.install();
  const realNow = Date.now;
  let fakeNow = realNow();
  // Once the start is requested, every Date.now() call advances the fake clock
  // past the 35 s readiness window, so "alive but never ready" reaches its
  // deadline deterministically without a real 35 s sleep.
  Date.now = () => {
    if (harness.startedInstanceIds.length === 0) {
      return realNow();
    }
    const value = fakeNow;
    fakeNow += 40000;
    return value;
  };
  try {
    harness.startedInstanceIds.push(instanceId);
    const result = await waitForStartedInstanceReadiness(instanceId);
    assert.strictEqual(result.verified, true, "A recognizable alive status must be verified.");
    assert.strictEqual(result.failed, false, "A process that stays alive must not be reported failed.");
    assert.strictEqual(result.ready, false, "A process that never became ready must not be reported ready.");
  } finally {
    Date.now = realNow;
    restoreAgent();
  }
}

// ---------------------------------------------------------------------------
// B. Install-level slow-but-alive start reports "readiness pending"
// ---------------------------------------------------------------------------
async function checkSlowButAliveInstallReportsPending() {
  const harness = createHarness();
  const fetches = [];
  const instanceId = "paper-pending-start-smoke";
  installFetchMock(fetches);
  const realNow = Date.now;
  let fakeNow = realNow();
  // Same fake clock as above: the install still completes, but the readiness
  // window is already elapsed when the first post-start sample is evaluated.
  Date.now = () => {
    if (harness.startedInstanceIds.length === 0) {
      return realNow();
    }
    const value = fakeNow;
    fakeNow += 40000;
    return value;
  };
  try {
    const result = await installPaper(harness, instanceId, PAPER_VERSION_SUPPORTS_JAVA_21);
    const startStep = result.progress.filter((step) => step.label === "Optional start").pop();
    assert(startStep, "The install progress must include the Optional start step.");
    assert.strictEqual(startStep.status, "complete", "A pending readiness must not fail the install.");
    assert.match(
      startStep.detail || "",
      /readiness is still pending/,
      "A slow-but-alive start must report readiness pending."
    );
    assert.doesNotMatch(startStep.detail || "", /reported ready/, "A pending start must not claim ready.");
    assert.strictEqual(harness.startedInstanceIds.length, 1, "The pending start must have started the instance once.");
  } finally {
    Date.now = realNow;
    restoreAgent();
    restoreFetch();
  }
}

// ---------------------------------------------------------------------------
// D. F6b positive control: a retryable resolver failure still offers Retry
// ---------------------------------------------------------------------------
async function checkRetryableResolverFailureKeepsRetry() {
  const harness = createHarness();
  const fetches = [];
  const instanceId = "paper-retryable-resolve-smoke";
  installFetchMock(fetches);
  try {
    await assert.rejects(
      () => installPaper(harness, instanceId, PAPER_UNKNOWN_VERSION),
      (error) => {
        assert.strictEqual(error?.code, "DOWNLOAD_RESOLVE_FAILED", `Expected DOWNLOAD_RESOLVE_FAILED, got ${error?.code}: ${error?.message}`);
        return true;
      },
      "A version without a stable build must fail resolution."
    );
    const { child } = findDownloadRecords(instanceId);
    assert(child, "A resolver failure must keep a child download record.");
    assert.strictEqual(
      child.canRetry,
      true,
      "A retryable resolver failure must still offer Retry (positive control for F6b)."
    );
  } finally {
    restoreAgent();
    restoreFetch();
  }
}

async function main() {
  console.log("marketplace-readiness-smoke: Build 205 honest-outcome guards");
  await check("A. Java compatibility helpers", checkJavaCompatibilityHelpers);
  await check("B. Paper Java 25 vs node Java 21 is refused before download/start", checkPaperJavaRefusal);
  await check("B. Paper Java 21 vs minimum 21 is not refused and a pre-ready exit is START_FAILED", checkSupportedJavaStartFailure);
  await check("B. Starting -> Running (ready) reports a ready start", checkReadyStart);
  await check("C. F6: Failed -> Starting -> Failed alternation is terminal", checkCrashRestartAlternationIsTerminal);
  await check("B. Slow-but-alive deadline stays readiness pending (helper contract)", checkSlowButAliveDeadlineIsPending);
  await check("B. Slow-but-alive install reports readiness pending", checkSlowButAliveInstallReportsPending);
  await check("D. F6b: retryable resolver failure still offers Retry", checkRetryableResolverFailureKeepsRetry);
  console.log(`${results.length} checks passed`);
  console.log("marketplace-readiness-smoke passed");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
