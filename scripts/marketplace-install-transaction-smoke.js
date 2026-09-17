const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

// V2-D install-transaction smoke (docs/v2/V2D_MARKETPLACE_RUNTIMES_WAVE1.md §3
// item 4): marketplace installs ride the durable V2-A job store, keyed repeats
// dedupe onto the original job (and replay once succeeded), job records persist
// under jobs/<jobId>.json, a cancel settles the job cancelled, an interrupted
// install is honestly reconciled to FAILED/JOB_INTERRUPTED after a restart, and
// non-marketplace job types are refused by the wrapper. Hermetic — no network,
// no agent, no electron; run is caller-provided so the smoke mints jobs
// directly without loading the real install executors.

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-marketplace-install-transaction-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");

const engine = require("../src/shared/instances/jobLifecycle");
engine.configureJobLifecycle({ getRoot: () => path.join(root, "jobs") });

const {
  MARKETPLACE_JOB_TYPES,
  MARKETPLACE_JOB_TIMEOUT_MS,
  buildMarketplaceInstallKey,
  isMarketplaceJobType,
  mintMarketplaceJob,
  setMarketplaceJobsWarmup,
} = require("../src/services/marketplaceInstallJobService");
const instanceServiceCore = require("../src/shared/instances/instanceServiceCore");

async function waitForJobState(jobId, state, timeoutMs = 5000) {
  for (let start = Date.now(); Date.now() - start < timeoutMs; ) {
    const job = await engine.getJob(jobId);
    if (job?.state === state) {
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Job ${jobId} did not reach state "${state}" within ${timeoutMs}ms.`);
}

async function main() {
  // 1. The Wave-1 marketplace job-type contract is pinned exactly.
  assert.deepStrictEqual(
    { ...MARKETPLACE_JOB_TYPES },
    {
      INSTALL: "marketplace.install",
      STEAMCMD_UPDATE: "marketplace.steamcmd-update",
    },
    "The marketplace job types must be exactly the Wave-1 contract.",
  );
  assert.strictEqual(isMarketplaceJobType("marketplace.install"), true);
  assert.strictEqual(isMarketplaceJobType("marketplace.steamcmd-update"), true);
  // Uppercase segments, degenerate shapes, and foreign namespaces all fail
  // closed. Two-segment (marketplace.<seg>) and three-segment
  // (marketplace.<seg>.<action>) types are valid — the contracted types are
  // two-segment — but empty segments, four segments, and uppercase are not.
  for (const bad of [
    "marketplace.steamcmdUpdate",
    "marketplace.",
    "marketplace..",
    "marketplace..x",
    "marketplace.install.x.y",
    "instance.start",
  ]) {
    assert.strictEqual(isMarketplaceJobType(bad), false, `Degenerate/foreign job type must be refused: ${bad}`);
  }

  // 2. Keyed repeat dedupes onto the original install; the record persists.
  let runCount = 0;
  const installKey = buildMarketplaceInstallKey({ nodeId: null, subject: "smoke-instance", version: "1.2.3" });
  assert.strictEqual(installKey, "marketplace.install:local:smoke-instance:1.2.3", "Keys must follow the recommended marketplace shape.");
  const mintInstall = () => mintMarketplaceJob({
    type: MARKETPLACE_JOB_TYPES.INSTALL,
    target: { nodeId: "local", templateId: "minecraft-vanilla" },
    idempotencyKey: installKey,
    run: async ({ setStage }) => {
      await setStage("executing");
      runCount += 1;
      return { installed: true, instanceId: "smoke-instance" };
    },
  });
  const first = await mintInstall();
  assert.strictEqual(first.job.type, "marketplace.install", "The install must mint a marketplace.install job.");
  assert.strictEqual(first.job.state, "succeeded", "The install job must settle succeeded.");
  assert.strictEqual(first.job.target.templateId, "minecraft-vanilla", "templateId must persist through the target whitelist.");
  assert.strictEqual(first.job.timeoutMs, MARKETPLACE_JOB_TIMEOUT_MS, "Install jobs default to the one-hour marketplace timeout.");
  assert.strictEqual(first.job.stage, "executing", "setStage must forward into the durable record.");
  assert(fs.existsSync(path.join(root, "jobs", `${first.job.id}.json`)), "Install jobs must persist under jobs/<jobId>.json.");
  const second = await mintInstall();
  assert.strictEqual(second.job.id, first.job.id, "A keyed repeat must return the original job.");
  assert.strictEqual(second.deduped, true, "A keyed repeat must be reported as deduped.");
  assert.strictEqual(second.replayed, true, "A keyed repeat of a succeeded install must replay, not re-execute.");
  assert.strictEqual(runCount, 1, "A deduped call must not re-execute the operation.");
  assert.strictEqual(second.result.installed, true, "The deduped caller receives the original result.");

  // 3. A keyed repeat while the first attempt is still running joins it.
  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  const slowMint = mintMarketplaceJob({
    type: MARKETPLACE_JOB_TYPES.INSTALL,
    target: {},
    idempotencyKey: "marketplace.install:local:slow-subject:1",
    run: async () => {
      await slowGate;
      return { slow: true };
    },
  });
  const joinedPromise = mintMarketplaceJob({
    type: MARKETPLACE_JOB_TYPES.INSTALL,
    target: {},
    idempotencyKey: "marketplace.install:local:slow-subject:1",
    run: async () => {
      throw new Error("A deduped caller must not execute a second run.");
    },
  });
  releaseSlow();
  const joined = await joinedPromise;
  const slow = await slowMint;
  assert.strictEqual(slow.job.state, "succeeded");
  assert.strictEqual(joined.deduped, true, "An in-flight keyed repeat must join the original execution.");
  assert.strictEqual(joined.replayed, false, "An in-flight dedupe is a join, not a replay.");

  // 4. Retry after a failed keyed attempt mints a fresh explicit job (the
  // conflict guidance's "new explicit request") instead of blocking the retry.
  let retryAttempts = 0;
  const retryMint = () => mintMarketplaceJob({
    type: MARKETPLACE_JOB_TYPES.INSTALL,
    target: {},
    idempotencyKey: "marketplace.install:local:flaky-subject:1",
    run: async () => {
      retryAttempts += 1;
      if (retryAttempts === 1) {
        throw new Error("flaky first attempt");
      }
      return { ok: true };
    },
  });
  await assert.rejects(() => retryMint(), (error) => error.message === "flaky first attempt", "The original failure must surface, not the job conflict.");
  const retryOk = await retryMint();
  assert.strictEqual(retryOk.deduped, false, "The retry must be a fresh explicit job, not a replay.");
  assert.strictEqual(retryOk.job.state, "succeeded");
  assert.strictEqual(retryAttempts, 2, "The retry must actually re-execute the operation.");

  // 5. A cancelled marketplace job settles cancelled through the cancel seam.
  let cancelObserved = null;
  let abortRun;
  const runGate = new Promise((resolve) => { abortRun = resolve; });
  let runStarted;
  const runStartedPromise = new Promise((resolve) => { runStarted = resolve; });
  const cancellableMint = await mintMarketplaceJob({
    type: MARKETPLACE_JOB_TYPES.STEAMCMD_UPDATE,
    target: { instanceId: "steam-instance" },
    idempotencyKey: "marketplace.steamcmd-update:local:steam-instance:current",
    cancellationSupported: true,
    awaitResult: false,
    cancel: async ({ reason }) => {
      cancelObserved = reason;
      abortRun();
    },
    run: async () => {
      runStarted();
      await runGate;
      throw new Error("Install aborted by cancel.");
    },
  });
  await runStartedPromise;
  const cancelled = await engine.cancelJob(cancellableMint.job.id, { reason: "smoke cancel" });
  assert.strictEqual(cancelled.cancelled, true, "Cancel must be accepted for a running marketplace job.");
  assert.strictEqual(cancelObserved, "smoke cancel", "Cancel must forward onto the executor's cancel seam.");
  const cancelledJob = await waitForJobState(cancellableMint.job.id, "cancelled");
  assert.strictEqual(cancelledJob.cancellation.supported, true, "The steamcmd update job must advertise cancellation support.");

  // 6. An install interrupted by a desktop restart is honestly reconciled as
  // FAILED/JOB_INTERRUPTED through the production reconcile branch.
  let hangStarted;
  const hangStartedPromise = new Promise((resolve) => { hangStarted = resolve; });
  const hungMint = mintMarketplaceJob({
    type: MARKETPLACE_JOB_TYPES.INSTALL,
    target: { nodeId: "local", templateId: "interrupted-template" },
    idempotencyKey: "marketplace.install:local:interrupted-subject:1",
    awaitResult: false,
    run: async () => {
      hangStarted();
      await new Promise(() => {});
    },
  });
  const hung = await hungMint;
  assert.strictEqual(hung.deduped, false);
  await hangStartedPromise;
  await waitForJobState(hung.job.id, "running");
  const hungPublic = await engine.getJob(hung.job.id);
  const outcome = await instanceServiceCore._test.reconcileInterruptedInstanceJob(hungPublic);
  assert.strictEqual(outcome.state, engine.JOB_STATES.FAILED, "Interrupted marketplace jobs must reconcile to FAILED.");
  assert.strictEqual(outcome.error.code, "JOB_INTERRUPTED", "Interrupted marketplace jobs must carry the JOB_INTERRUPTED code.");
  assert.match(outcome.error.message, /Marketplace/i, "The interrupted reconcile must explain what happened and how to recover.");
  await engine.recoverInterruptedJobs(instanceServiceCore._test.reconcileInterruptedInstanceJob);
  const reconciled = await engine.getJob(hung.job.id);
  assert.strictEqual(reconciled.state, "failed", "The recovery pass must settle the interrupted install.");
  assert.strictEqual(reconciled.error.code, "JOB_INTERRUPTED");

  // 7. Non-marketplace job types are refused by the wrapper (fail closed).
  await assert.rejects(
    () => mintMarketplaceJob({ type: "instance.start", run: async () => ({}) }),
    (error) => error.code === "INVALID_MARKETPLACE_JOB_TYPE" && error.statusCode === 400,
    "Non-marketplace job types must be refused by the marketplace job wrapper.",
  );
  for (const bad of ["marketplace.", "marketplace..", "marketplace..x", "marketplace.install.x.y", "marketplace.steamcmdUpdate"]) {
    await assert.rejects(
      () => mintMarketplaceJob({ type: bad, run: async () => ({}) }),
      (error) => error.code === "INVALID_MARKETPLACE_JOB_TYPE",
      `Degenerate marketplace job type must be rejected: ${bad}`,
    );
  }

  // 8. The desktop warmup hook runs before mints and can be cleared again.
  let warmupCalls = 0;
  setMarketplaceJobsWarmup(() => {
    warmupCalls += 1;
  });
  await mintMarketplaceJob({
    type: MARKETPLACE_JOB_TYPES.INSTALL,
    target: {},
    run: async () => ({ warmed: true }),
  });
  assert.strictEqual(warmupCalls, 1, "The lifecycle warmup must run before a mint when configured.");
  setMarketplaceJobsWarmup(null);
  await mintMarketplaceJob({
    type: MARKETPLACE_JOB_TYPES.INSTALL,
    target: {},
    run: async () => ({ warmed: true }),
  });
  assert.strictEqual(warmupCalls, 1, "Clearing the warmup must stop the warmup calls.");

  console.log("marketplace:install-transaction:smoke passed");
}

main().catch((error) => {
  console.error("marketplace:install-transaction:smoke FAILED:", error);
  process.exitCode = 1;
});
