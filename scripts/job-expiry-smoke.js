const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Pin runtime roots before service modules load (eb13b83 job-store leak
// lesson): this smoke writes raw job records to disk and must never leak them
// into the real machine root or replay records across runs.
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const smokeRoot = pinAgentRoots("anx-job-expiry-");

const engine = require("../src/shared/instances/jobLifecycle");

const JOB_STATES = engine.JOB_STATES;
const JOB_EXPIRED_MESSAGE = "This queued operation expired while the node was offline. Issue the request again.";

// Each phase gets its own jobs root so recovery caching and leftover records
// from earlier phases can never leak into later assertions.
let jobsRoot = null;
function usePhaseRoot(name) {
  jobsRoot = path.join(smokeRoot, "instances", `jobs-${name}`);
  engine.configureJobLifecycle({ getRoot: () => jobsRoot });
  return jobsRoot;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Writes a pending (enqueued, never started) record directly to disk, exactly
// as a node that crashed between enqueue-persist and dispatch — or a desktop
// whose queued job never transferred to an offline agent — would have left it.
function writePendingJobRecord({ idempotencyKey = null, type = "instance.start", enqueuedAtMs = Date.now(), expiresAt = null }) {
  const id = `job_${crypto.randomBytes(16).toString("hex")}`;
  fs.mkdirSync(jobsRoot, { recursive: true });
  fs.writeFileSync(path.join(jobsRoot, `${id}.json`), JSON.stringify({
    id,
    idempotencyKey,
    type,
    target: { instanceId: "expiry-smoke" },
    owner: { actorId: null, role: null },
    state: JOB_STATES.ENQUEUED,
    stage: null,
    enqueuedAt: new Date(enqueuedAtMs).toISOString(),
    startedAt: null,
    completedAt: null,
    expiresAt,
    timeoutMs: 600000,
    attempts: 1,
    exitCode: null,
    error: null,
    result: null,
    cancellation: { requestedAt: null, reason: null, supported: false },
    events: [],
  }, null, 2), { mode: 0o600 });
  return id;
}

function readRecord(jobId) {
  return JSON.parse(fs.readFileSync(path.join(jobsRoot, `${jobId}.json`), "utf8"));
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
  // ---- Phase 1: explicit expiresAt — lazy expiry on read -------------------
  // Two pending records past their deadline: one settles via getJob, the other
  // via listJobs (both are lazy evaluation points).
  usePhaseRoot("1-explicit-lazy");
  const viaGetId = writePendingJobRecord({ expiresAt: new Date(Date.now() + 80).toISOString() });
  const viaListId = writePendingJobRecord({ expiresAt: new Date(Date.now() + 80).toISOString() });
  await wait(150);

  const expired = await engine.getJob(viaGetId);
  assert.strictEqual(expired.state, JOB_STATES.FAILED,
    "A pending job past its expiresAt must settle failed on the first lazy read.");
  assert.strictEqual(expired.error.code, "JOB_EXPIRED",
    "The expired job must carry the JOB_EXPIRED error code.");
  assert.strictEqual(expired.error.message, JOB_EXPIRED_MESSAGE,
    "The expired job must carry an actionable re-issue message.");
  assert.strictEqual(expired.expired, true,
    "The settled record must expose expired: true.");
  assert.strictEqual(typeof expired.expiresAt, "string",
    "The public record must expose its expiresAt.");

  const listed = await engine.listJobs({ type: "instance.start" });
  const listedExpired = listed.jobs.find((job) => job.id === viaListId);
  assert(listedExpired, "The second pending record must be listed.");
  assert.strictEqual(listedExpired.state, JOB_STATES.FAILED,
    "listJobs must lazily settle an expired pending record before listing it.");
  assert.strictEqual(listedExpired.error.code, "JOB_EXPIRED", "listJobs settlement must use JOB_EXPIRED.");
  assert.strictEqual(listedExpired.expired, true, "listJobs must reflect expired: true.");

  // A repeat read is idempotent: the settled record is terminal and unchanged.
  const reread = await engine.getJob(viaGetId);
  assert.strictEqual(reread.state, JOB_STATES.FAILED, "A repeat read must not re-settle or alter the record.");
  const persistedExpired = readRecord(viaGetId);
  assert.strictEqual(persistedExpired.state, JOB_STATES.FAILED, "The settlement must be durable on disk.");
  assert.strictEqual(persistedExpired.expired, true, "The durable record must carry expired: true.");
  assert(persistedExpired.events.some((event) => event.action === "job.failed"),
    "The expiry settlement must be recorded as a job.failed event.");
  assert(!persistedExpired.events.some((event) => event.action === "job.reobserved"),
    "A lazy-read expiry is not a re-observation and must not claim to be one.");

  // ---- Phase 2: a running job NEVER expires mid-run ------------------------
  usePhaseRoot("2-running-unaffected");
  let runningRelease;
  const runningPromise = new Promise((resolve) => { runningRelease = resolve; });
  const running = await engine.createJob({
    type: "instance.start",
    target: { instanceId: "expiry-smoke" },
    idempotencyKey: "expiry:running:v1",
    expiresAt: Date.now() + 120, // epoch-ms number form
    timeoutMs: 10000,
    awaitResult: false,
    run: () => runningPromise,
  });
  assert.strictEqual(typeof running.job.expiresAt, "string",
    "A minted job must persist its normalized (ISO) expiresAt.");
  assert.strictEqual(running.job.expired, false, "A live job must report expired: false.");
  await wait(250); // the deadline passes while the job is running
  const midRun = await engine.getJob(running.job.id);
  assert.strictEqual(midRun.state, JOB_STATES.RUNNING,
    "A running job must never be claimed by expiry mid-run.");
  assert.strictEqual(midRun.expired, false, "A running job must not be marked expired.");
  runningRelease({ pid: 7 });
  const finished = await waitForState(running.job.id, JOB_STATES.SUCCEEDED);
  assert.strictEqual(finished.expired, false, "A completed job must not be marked expired.");
  assert.strictEqual(finished.result.pid, 7, "The run must complete normally past the deadline.");

  // ---- Phase 3: a succeeded job is unaffected by its expiry ----------------
  usePhaseRoot("3-succeeded-unaffected");
  const fast = await engine.createJob({
    type: "instance.start",
    target: { instanceId: "expiry-smoke" },
    idempotencyKey: "expiry:fast:v1",
    expiresAt: new Date(Date.now() + 80).toISOString(),
    run: async () => ({ pid: 8 }),
  });
  assert.strictEqual(fast.job.state, JOB_STATES.SUCCEEDED, "The fast job must settle succeeded.");
  await wait(150); // the deadline passes after completion
  const afterDeadline = await engine.getJob(fast.job.id);
  assert.strictEqual(afterDeadline.state, JOB_STATES.SUCCEEDED,
    "Expiry must only ever claim jobs that never started.");
  assert.strictEqual(afterDeadline.expired, false, "A succeeded job must not be marked expired.");

  // ---- Phase 4: a keyed request after expiry mints fresh (no silent replay)
  usePhaseRoot("4-key-release");
  const staleId = writePendingJobRecord({
    idempotencyKey: "expiry:keyed:v1",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  engine._test.reset(); // drop in-memory state; the durable record stays
  usePhaseRoot("4-key-release");

  let freshRuns = 0;
  const fresh = await engine.createJob({
    type: "instance.start",
    target: { instanceId: "expiry-smoke" },
    idempotencyKey: "expiry:keyed:v1",
    run: async () => {
      freshRuns += 1;
      return { pid: 9 };
    },
  });
  assert.notStrictEqual(fresh.job.id, staleId, "A keyed request after expiry must mint a fresh job.");
  assert.strictEqual(fresh.deduped, false, "The fresh mint must not be reported as a dedupe.");
  assert.strictEqual(fresh.replayed, false, "The expired record must never be replayed as success.");
  assert.strictEqual(fresh.job.state, JOB_STATES.SUCCEEDED, "The fresh explicit job must execute.");
  assert.strictEqual(freshRuns, 1, "Exactly the fresh execution must have run.");
  const staleRecord = readRecord(staleId);
  assert.strictEqual(staleRecord.state, JOB_STATES.FAILED, "The expired record must stay settled failed.");
  assert.strictEqual(staleRecord.expired, true, "The expired record must stay marked for audit.");
  assert.strictEqual(staleRecord.idempotencyKey, "expiry:keyed:v1",
    "The expired record must keep its key for audit.");

  // The key now belongs to the fresh job: a repeat keyed request replays IT.
  const replay = await engine.createJob({
    type: "instance.start",
    target: { instanceId: "expiry-smoke" },
    idempotencyKey: "expiry:keyed:v1",
    run: async () => {
      freshRuns += 1;
      return { pid: 10 };
    },
  });
  assert.strictEqual(replay.job.id, fresh.job.id, "The key must be re-pointed at the fresh job.");
  assert.strictEqual(replay.replayed, true, "The fresh job's result must replay normally.");
  assert.strictEqual(freshRuns, 1, "Replay of the fresh job must not re-execute.");

  // ---- Phase 4b: the record settled by an EARLIER evaluator (boot recovery)
  // must behave identically to the pending-expired case — the re-issue mints
  // fresh instead of hitting the FAILED branch's JOB_CONFLICT (review P1-1).
  usePhaseRoot("4b-settled-reissue");
  const settledId = writePendingJobRecord({
    idempotencyKey: "expiry:recovered:v1",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  engine._test.reset(); // drop in-memory state; the durable record stays
  usePhaseRoot("4b-settled-reissue");
  // Boot-style recovery pass settles the record FIRST, before any keyed
  // request arrives.
  await engine.recoverInterruptedJobs();
  const settledRecord = readRecord(settledId);
  assert.strictEqual(settledRecord.state, JOB_STATES.FAILED, "Recovery must settle the expired pending record.");
  assert.strictEqual(settledRecord.expired, true, "Recovery must mark the expired record.");
  let recoveredRuns = 0;
  const reissuedAfterRecovery = await engine.createJob({
    type: "instance.start",
    target: { instanceId: "expiry-smoke" },
    idempotencyKey: "expiry:recovered:v1",
    run: async () => {
      recoveredRuns += 1;
      return { pid: 11 };
    },
  });
  assert.notStrictEqual(reissuedAfterRecovery.job.id, settledId, "A keyed request after a SETTLED expiry must still mint a fresh job.");
  assert.strictEqual(reissuedAfterRecovery.deduped, false, "The re-issue must not dedupe onto the settled expired record.");
  assert.strictEqual(reissuedAfterRecovery.replayed, false, "The settled expired record must never replay.");
  assert.strictEqual(recoveredRuns, 1, "The re-issued job must execute.");

  // Past-dated expiresAt at mint is rejected (review P2: a job minted
  // already-expired would dispatch then settle FAILED nondeterministically).
  await assert.rejects(
    () => engine.createJob({
      type: "instance.start",
      target: { instanceId: "expiry-smoke" },
      expiresAt: new Date(Date.now() - 5000).toISOString(),
      run: async () => ({}),
    }),
    (error) => error.code === "INVALID_JOB_EXPIRES_AT",
    "A past-dated expiresAt must be rejected at mint.",
  );

  // ---- Phase 5: no expiry config + no expiresAt = zero behavior change -----
  usePhaseRoot("5-no-opt-in");
  const legacyId = writePendingJobRecord({ enqueuedAtMs: Date.now() - 60 * 60 * 1000 });
  engine._test.reset();
  usePhaseRoot("5-no-opt-in");

  const legacy = await engine.getJob(legacyId);
  assert.strictEqual(legacy.state, JOB_STATES.ENQUEUED,
    "Without an explicit expiresAt and a configured default TTL, an old pending job must never expire.");
  assert.strictEqual(legacy.expired, false, "The un-expired record must report expired: false.");

  const recoveryOutcome = await engine.recoverInterruptedJobs(async () => ({
    state: JOB_STATES.FAILED,
    error: { code: "RECONCILED_NORMALLY" },
  }));
  assert.strictEqual(recoveryOutcome.recovered, true, "Recovery must report recovered: true.");
  assert.strictEqual(recoveryOutcome.expired, 0, "No record was expired in this pass.");
  const reconciledLegacy = await engine.getJob(legacyId);
  assert.strictEqual(reconciledLegacy.error.code, "RECONCILED_NORMALLY",
    "The old pending job must reconcile exactly as before, not expire.");

  // ---- Phase 6: defaultPendingJobTtlMs is opt-in and skips destructive -----
  engine._test.reset();
  usePhaseRoot("6-default-ttl");
  engine.configureJobLifecycle({ getRoot: () => jobsRoot, defaultPendingJobTtlMs: 100 });
  const defaultTtlId = writePendingJobRecord({ enqueuedAtMs: Date.now() - 60 * 60 * 1000 });
  const destructivePendingId = writePendingJobRecord({
    type: "instance.delete",
    enqueuedAtMs: Date.now() - 60 * 60 * 1000,
  });

  const defaultTtl = await engine.getJob(defaultTtlId);
  assert.strictEqual(defaultTtl.state, JOB_STATES.FAILED,
    "A non-destructive pending job older than the configured default TTL must expire.");
  assert.strictEqual(defaultTtl.error.code, "JOB_EXPIRED", "The default-TTL settlement must use JOB_EXPIRED.");
  const destructivePending = await engine.getJob(destructivePendingId);
  assert.strictEqual(destructivePending.state, JOB_STATES.ENQUEUED,
    "A destructive pending job must never expire by default (no explicit expiresAt).");

  const mintedDefault = await engine.createJob({
    type: "instance.start",
    target: { instanceId: "expiry-smoke" },
    run: async () => ({ ok: true }),
  });
  assert.strictEqual(typeof mintedDefault.job.expiresAt, "string",
    "A minted non-destructive job must get the default TTL stamped at mint time.");
  const mintedDestructive = await engine.createJob({
    type: "instance.forget",
    target: { instanceId: "expiry-smoke" },
    run: async () => ({ ok: true }),
  });
  assert.strictEqual(mintedDestructive.job.expiresAt, null,
    "A minted destructive job must not receive a default expiry.");

  // ---- Phase 7: recovery settles expired jobs and counts them --------------
  engine._test.reset();
  usePhaseRoot("7-recovery-count");
  const recoveredExpiredId = writePendingJobRecord({ expiresAt: new Date(Date.now() - 1000).toISOString() });
  const recoveredFreshId = writePendingJobRecord({ expiresAt: new Date(Date.now() + 60 * 1000).toISOString() });

  let reconcileCalls = 0;
  const outcome = await engine.recoverInterruptedJobs(async () => {
    reconcileCalls += 1;
    return { state: JOB_STATES.SUCCEEDED, result: { reconciled: true } };
  });
  assert.strictEqual(outcome.recovered, true, "Recovery must report recovered: true.");
  assert.strictEqual(outcome.expired, 1, "The reconcile outcome must count exactly the expired job.");
  assert.strictEqual(reconcileCalls, 1,
    "An expired pending job must be settled by expiry, not handed to reconciliation.");

  const recoveredExpired = await engine.getJob(recoveredExpiredId);
  assert.strictEqual(recoveredExpired.state, JOB_STATES.FAILED, "The expired record must settle failed.");
  assert.strictEqual(recoveredExpired.error.code, "JOB_EXPIRED", "The recovery expiry must use JOB_EXPIRED.");
  const recoveredExpiredDisk = readRecord(recoveredExpiredId);
  assert(!recoveredExpiredDisk.events.some((event) => event.action === "job.reobserved"),
    "An expired job has nothing to re-observe and must not carry a re-observation event.");
  const recoveredFresh = await engine.getJob(recoveredFreshId);
  assert.strictEqual(recoveredFresh.state, JOB_STATES.SUCCEEDED,
    "A not-yet-expired pending job must still reconcile normally.");

  // ---- Phase 8: destructive refusal semantics remain untouched -------------
  engine._test.reset();
  usePhaseRoot("8-destructive");
  await engine.createJob({
    type: "instance.delete",
    target: { instanceId: "expiry-smoke" },
    idempotencyKey: "expiry:delete:v1",
    run: async () => ({ deleted: true }),
  });
  await assert.rejects(
    () => engine.createJob({
      type: "instance.delete",
      target: { instanceId: "expiry-smoke" },
      idempotencyKey: "expiry:delete:v1",
      run: async () => ({ deleted: true }),
    }),
    (error) => error.code === "JOB_CONFLICT" && error.statusCode === 409,
    "A succeeded destructive result must still refuse its key (JOB_CONFLICT).",
  );

  // A destructive pending job past an EXPLICIT expiresAt releases its key: the
  // stale approval lapsed, so a keyed request re-issues a fresh explicit job.
  const staleForget = writePendingJobRecord({
    type: "instance.forget",
    idempotencyKey: "expiry:forget:v1",
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  engine._test.reset();
  usePhaseRoot("8-destructive");
  let forgetRuns = 0;
  const reissued = await engine.createJob({
    type: "instance.forget",
    target: { instanceId: "expiry-smoke" },
    idempotencyKey: "expiry:forget:v1",
    run: async () => {
      forgetRuns += 1;
      return { forgotten: true };
    },
  });
  assert.notStrictEqual(reissued.job.id, staleForget,
    "A keyed request after a destructive job expired must mint a fresh explicit job.");
  assert.strictEqual(reissued.deduped, false, "The re-issue must not be a dedupe.");
  assert.strictEqual(reissued.replayed, false, "The stale destructive record must never be replayed.");
  assert.strictEqual(reissued.job.state, JOB_STATES.SUCCEEDED, "The re-issued execution must run once.");
  assert.strictEqual(forgetRuns, 1, "Exactly the re-issued execution must have run.");
  assert.strictEqual(readRecord(staleForget).expired, true, "The stale destructive record stays for audit.");

  // ---- Phase 9: malformed expiresAt fails closed ---------------------------
  await assert.rejects(
    () => engine.createJob({
      type: "instance.start",
      target: { instanceId: "expiry-smoke" },
      expiresAt: "not-a-date",
      run: async () => ({}),
    }),
    (error) => error.code === "INVALID_JOB_EXPIRES_AT" && error.statusCode === 400,
    "A malformed expiresAt must be rejected before any state is touched.",
  );

  console.log("job-expiry-smoke passed");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
