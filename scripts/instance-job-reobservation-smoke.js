const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-instance-job-reobservation-"));
const jobsRoot = path.join(root, "jobs");
const engine = require("../src/shared/instances/jobLifecycle");
const core = require("../src/shared/instances/instanceServiceCore");

const JOB_STATES = engine.JOB_STATES;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  fs.mkdirSync(jobsRoot, { recursive: true });

  // The crashed node already had this instance (its config.json persists on
  // disk). Create it first; the wrapped create's lazy job recovery runs
  // against an empty store, which mirrors a healthy boot.
  core.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });
  process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);
  await core.createInstance({
    id: "reobserve-smoke",
    displayName: "Reobservation Smoke",
    type: "custom-command",
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
  });

  // Phase 1: simulate the node crashing with two open jobs.
  const crashedStart = await engine.createJob({
    type: "instance.start",
    target: { instanceId: "reobserve-smoke" },
    idempotencyKey: "start:reobserve-smoke:v1",
    timeoutMs: 10 * 60 * 1000,
    awaitResult: false,
    run: () => new Promise(() => {}),
  });
  await wait(150);
  assert.strictEqual((await engine.getJob(crashedStart.job.id)).state, JOB_STATES.RUNNING,
    "The crashed node must have persisted the start job as running.");

  // A stop job written directly to disk as it would exist mid-flight.
  const crashedStopId = `job_${crypto.randomBytes(16).toString("hex")}`;
  fs.writeFileSync(path.join(jobsRoot, `${crashedStopId}.json`), JSON.stringify({
    id: crashedStopId,
    idempotencyKey: null,
    type: "instance.stop",
    target: { instanceId: "reobserve-smoke" },
    owner: { actorId: null, role: null },
    state: JOB_STATES.RUNNING,
    stage: null,
    enqueuedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    timeoutMs: 600000,
    attempts: 1,
    exitCode: null,
    error: null,
    result: null,
    cancellation: { requestedAt: null, reason: null, supported: false },
    events: [],
  }, null, 2), { mode: 0o600 });

  // Simulate the restart: drop all in-memory state (the crashed process is
  // gone); every durable record stays on disk.
  engine._test.reset();

  // Phase 2: boot-time re-observation. This is the explicit hook the desktop
  // main / Agent call after their instance recovery pass; reconcile each
  // interrupted record against the instance's truthful persisted state.
  engine.configureJobLifecycle({ getRoot: () => jobsRoot });
  await engine.recoverInterruptedJobs(async (job) => {
    const instanceId = job.target?.instanceId;
    const status = instanceId ? await core.getStatus(instanceId).catch(() => null) : null;
    const instanceState = status?.processState || null;
    const expectedRunning = job.type === "instance.start" || job.type === "instance.restart";
    if (!status) {
      return { state: JOB_STATES.FAILED, error: { code: "JOB_TARGET_GONE", message: "Target instance missing." } };
    }
    if (expectedRunning && instanceState === "Running") {
      return { state: JOB_STATES.SUCCEEDED, result: status };
    }
    if (job.type === "instance.stop" && instanceState === "Stopped") {
      return { state: JOB_STATES.SUCCEEDED, result: status };
    }
    return {
      state: JOB_STATES.FAILED,
      error: {
        code: "JOB_INTERRUPTED",
        message: `The node restarted while this job was in flight; reconciled from persisted instance state (${instanceState}).`,
      },
    };
  });

  const reconciledStart = await core.getInstanceJob(crashedStart.job.id);
  assert.strictEqual(reconciledStart.state, JOB_STATES.FAILED,
    "A start job interrupted by a node restart with the instance stopped must fail.");
  assert.strictEqual(reconciledStart.error.code, "JOB_INTERRUPTED",
    "The interrupted start job must carry a JOB_INTERRUPTED error code.");
  assert(reconciledStart.events.some((event) => event.action === "job.reobserved"),
    "Re-observation must be recorded as a job.reobserved audit event.");

  const reconciledStop = await core.getInstanceJob(crashedStopId);
  assert.strictEqual(reconciledStop.state, JOB_STATES.SUCCEEDED,
    "A stop job interrupted by a node restart must reconcile to succeeded when the instance is stopped.");
  assert(reconciledStop.events.some((event) => event.action === "job.reobserved"),
    "The stop job must also carry a re-observation event.");

  // Recovery runs once: a second read must not duplicate re-observation events.
  const reobservedEventCount = reconciledStart.events.filter((event) => event.action === "job.reobserved").length;
  await engine.recoverInterruptedJobs(async () => ({ state: JOB_STATES.FAILED, error: { code: "SHOULD_NOT_RUN" } }));
  const again = await core.getInstanceJob(crashedStart.job.id);
  assert.strictEqual(
    again.events.filter((event) => event.action === "job.reobserved").length,
    reobservedEventCount,
    "Re-observation must happen exactly once per record.",
  );

  // A fresh keyed start after recovery works; the interrupted attempt's key
  // failed closed, so the retry uses a new explicit key (never a silent replay).
  const started = await core.startInstance("reobserve-smoke", { idempotencyKey: "start:reobserve-smoke:v2" });
  assert(started.pid, "The instance must start normally after re-observation.");
  assert(started.job?.id, "The fresh keyed start must carry its own job record.");
  await core.stopInstance("reobserve-smoke", { timeoutMs: 2000 });

  console.log("Instance job re-observation smoke checks passed.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
