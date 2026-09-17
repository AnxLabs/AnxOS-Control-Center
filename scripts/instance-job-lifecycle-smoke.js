const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-instance-job-lifecycle-"));
// Pin the instance root BEFORE the core loads: its boot-time job-store
// ensure otherwise mkdirs the cwd-default instances/jobs (the eb13b83-class
// leak the rc:validate tripwire now fails on).
process.env.AGENT_INSTANCE_ROOT = path.join(root, "instances");
const engine = require("../src/shared/instances/jobLifecycle");
const core = require("../src/shared/instances/instanceServiceCore");

const jobsRoot = path.join(root, "jobs");
engine.configureJobLifecycle({ getRoot: () => jobsRoot });

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForState(jobId, state, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await engine.getJob(jobId);
    if (job && job.state === state) {
      return job;
    }
    if (Date.now() > deadline) {
      throw new Error(`Job ${jobId} did not reach state ${state} (last: ${job?.state}).`);
    }
    await wait(25);
  }
}

async function main() {
  // 1. Duplicate in-flight keyed request rejoins the original execution.
  let runCount = 0;
  const makeStartRequest = () => engine.createJob({
    type: "instance.start",
    target: { instanceId: "smoke-01" },
    idempotencyKey: "start:smoke-01:wave1",
    timeoutMs: 5000,
    run: async () => {
      runCount += 1;
      await wait(200);
      return { pid: 4242 };
    },
  });
  // Both requests are in flight together: the duplicate must rejoin the
  // original execution instead of starting a second one.
  const [first, second] = await Promise.all([makeStartRequest(), makeStartRequest()]);
  assert.strictEqual(first.job.id, second.job.id, "Duplicate in-flight requests must return the same job.");
  assert.strictEqual(second.deduped, true, "The duplicate must be reported as deduped.");
  assert.strictEqual(runCount, 1, "The underlying operation must execute exactly once.");
  assert.strictEqual(second.result.pid, 4242, "The deduped caller receives the original execution result.");
  assert.strictEqual(second.job.state, "succeeded", "The shared job must settle succeeded.");
  const recordFile = path.join(jobsRoot, `${first.job.id}.json`);
  assert(fs.existsSync(recordFile), "The job record must be persisted under jobs/<jobId>.json.");

  // 2. A terminal succeeded keyed result replays without re-executing.
  const replay = await engine.createJob({
    type: "instance.start",
    target: { instanceId: "smoke-01" },
    idempotencyKey: "start:smoke-01:wave1",
    run: async () => {
      runCount += 1;
      return { pid: 1 };
    },
  });
  assert.strictEqual(replay.replayed, true, "A terminal succeeded result must replay.");
  assert.strictEqual(runCount, 1, "Replay must not re-execute the operation.");
  assert(replay.job.events.some((event) => event.action === "job.replay"), "Replay must leave a job.replay audit event on the record.");

  // 3. A terminal FAILED keyed result is never silently replayed.
  await assert.rejects(
    () => engine.createJob({
      type: "instance.stop",
      target: { instanceId: "smoke-02" },
      idempotencyKey: "stop:smoke-02:wave1",
      run: async () => {
        const error = new Error("stop failed");
        error.code = "INSTANCE_STOP_FAILED";
        throw error;
      },
    }),
    (error) => error.code === "INSTANCE_STOP_FAILED",
    "A failed job must surface the original operation error to its caller.",
  );
  const listAfterFailure = await engine.listJobs({ type: "instance.stop", instanceId: "smoke-02" });
  const failing = listAfterFailure.jobs[0];
  assert(failing && failing.state === "failed", "The failing job must settle failed and persist.");
  await assert.rejects(
    () => engine.createJob({
      type: "instance.stop",
      target: { instanceId: "smoke-02" },
      idempotencyKey: "stop:smoke-02:wave1",
      run: async () => ({ retried: true }),
    }),
    (error) => error.code === "JOB_CONFLICT" && error.statusCode === 409
      && error.details.priorJobId === failing.id && error.details.priorState === "failed",
    "A failed keyed result must surface JOB_CONFLICT instead of a silent replay.",
  );

  // 4. Destructive types are never replayed, even on success.
  const destructive = await engine.createJob({
    type: "instance.delete",
    target: { instanceId: "smoke-03" },
    idempotencyKey: "delete:smoke-03:wave1",
    run: async () => ({ deleted: true }),
  });
  assert.strictEqual(destructive.job.state, "succeeded");
  await assert.rejects(
    () => engine.createJob({
      type: "instance.delete",
      target: { instanceId: "smoke-03" },
      idempotencyKey: "delete:smoke-03:wave1",
      run: async () => ({ deleted: true }),
    }),
    (error) => error.code === "JOB_CONFLICT",
    "Destructive operations must never be silently replayed.",
  );

  // 4b. The exported destructive set is pinned exactly as the Wave-1 contract
  // requires (docs/v2/V2A_WAVE1_REVIEW.md item f): adding a type to this set
  // must be a deliberate, tested decision.
  assert.deepStrictEqual(
    new Set([...engine.DESTRUCTIVE_JOB_TYPES]),
    new Set(["instance.delete", "instance.forget", "instance.forceKill"]),
    "The exported destructive set must enumerate exactly the contracted types.",
  );

  // 5. Cancellation: a running job with a cancel handler settles cancelled.
  // The job handle is taken with awaitResult disabled (the way an IPC jobs
  // surface would observe it) so the cancel can arrive mid-run from a second
  // requester while the original caller is still awaiting the operation.
  let cancelInvoked = false;
  const cancellable = await engine.createJob({
    type: "instance.start",
    target: { instanceId: "smoke-04" },
    idempotencyKey: "start:smoke-04:wave1",
    timeoutMs: 10000,
    awaitResult: false,
    cancel: async () => {
      cancelInvoked = true;
    },
    run: async () => {
      await wait(1500);
      return { pid: 5 };
    },
  });
  await wait(100);
  const cancelled = await engine.cancelJob(cancellable.job.id, { reason: "operator changed their mind" });
  assert.strictEqual(cancelled.cancelled, true, "A running job with a cancel handler must be cancellable.");
  const cancelledJob = await waitForState(cancellable.job.id, "cancelled", 8000);
  assert.strictEqual(cancelInvoked, true, "The registered cancel handler must run.");
  assert.strictEqual(cancelledJob.cancellation.reason, "operator changed their mind", "The cancellation reason must persist (sanitized).");
  const cancelAgain = await engine.cancelJob(cancellable.job.id, { reason: "second cancel" });
  assert.strictEqual(cancelAgain.alreadyTerminal, true, "A repeat cancel of a terminal job must be idempotent.");

  // 6. Timeout is a distinct terminal state.
  let releaseSlowRun;
  const slowRunPromise = new Promise((resolve) => { releaseSlowRun = resolve; });
  const slow = await engine.createJob({
    type: "instance.update",
    target: { instanceId: "smoke-05" },
    idempotencyKey: "update:smoke-05:wave1",
    timeoutMs: 200,
    awaitResult: false,
    run: () => slowRunPromise,
  });
  const timedOut = await waitForState(slow.job.id, "timeout");
  assert.strictEqual(timedOut.error.code, "JOB_TIMEOUT", "Timeout must record a JOB_TIMEOUT error.");
  releaseSlowRun({});

  // 7. Secrets in error details are redacted before persistence.
  let secretJobId = null;
  await assert.rejects(
    () => engine.createJob({
      type: "instance.update",
      target: { instanceId: "smoke-06" },
      idempotencyKey: "update:smoke-06:wave1",
      run: async () => {
        throw new Error("auth failed with token=hunter2secretvalue");
      },
    }),
    (error) => {
      secretJobId = error.jobId || null;
      return error instanceof Error;
    },
    "The failed operation must surface its original error.",
  );
  assert(secretJobId, "The failed job id must be carried on the error.");
  const secret = await engine.getJob(secretJobId);
  assert.strictEqual(secret.state, "failed");
  const persisted = JSON.parse(fs.readFileSync(path.join(jobsRoot, `${secretJobId}.json`), "utf8"));
  assert(!persisted.error.message.includes("hunter2secretvalue"), "Persisted error messages must be redacted.");
  assert(persisted.error.message.includes("[redacted]"), `Redaction marker expected, got: ${persisted.error.message}`);

  // 8. Invalid idempotency keys fail closed.
  await assert.rejects(
    () => engine.createJob({ type: "instance.start", idempotencyKey: "bad key with spaces", run: async () => ({}) }),
    (error) => error.code === "INVALID_IDEMPOTENCY_KEY",
    "Malformed idempotency keys must be rejected.",
  );

  // 9. Core-level keyed lifecycle: replay must not restart the instance.
  engine._test.reset();
  core.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });
  process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);
  await core.createInstance({
    id: "job-core-smoke",
    displayName: "Job Core Smoke",
    type: "custom-command",
    executable: process.execPath,
    args: ["-e", "console.log('started'); setInterval(() => {}, 1000)"],
  });
  const started = await core.startInstance("job-core-smoke", { idempotencyKey: "start:job-core-smoke:v1" });
  const startJobId = started.job?.id;
  assert(startJobId, "A keyed start must attach its job record to the result.");
  assert.strictEqual(started.job.state, "succeeded", "The start job must settle succeeded.");
  assert(started.pid, "The instance must actually start.");
  const replayedStart = await core.startInstance("job-core-smoke", { idempotencyKey: "start:job-core-smoke:v1" });
  assert.strictEqual(replayedStart.job.id, startJobId, "A keyed repeat must return the original job.");
  assert.strictEqual(replayedStart.pid, started.pid, "Replay must not restart the instance (same pid).");
  assert(replayedStart.job.events.some((event) => event.action === "job.replay"), "Replay must be auditable on the record.");
  const listed = await core.listInstanceJobs({ type: "instance.start", instanceId: "job-core-smoke" });
  assert.strictEqual(listed.jobs.length, 1, "Exactly one job record must exist for the keyed start.");
  await core.stopInstance("job-core-smoke", { timeoutMs: 2000 });
  const stoppedTerminal = await core.cancelInstanceJob(startJobId, { reason: "late cancel" });
  assert.strictEqual(stoppedTerminal.alreadyTerminal, true, "Cancelling a terminal job must be idempotent.");

  console.log("Instance job lifecycle smoke checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
