// V2-A job lifecycle engine (V2A_JOB_LIFECYCLE.md §3, V2A_DECISIONS.md "Deferred").
//
// Durable, per-node job records stored under `<instanceRoot>/jobs/<jobId>.json`.
// Job ownership lives in the process that executes the operation (desktop main
// for the local application host, the Agent process for remote execution), so a
// client restart can never orphan an in-flight operation: the record survives,
// and the executing node reconciles it on the next boot (re-observation).
//
// Security rules honored here:
// - Every persisted detail (error messages, results, cancellation reasons,
//   event details) passes through sanitizeForDiagnostics before it is written.
// - The audit emitter is injected (never imported) so this module stays free of
//   host-specific dependencies; audit failures never affect job execution.
// - Terminal states are immutable once written; transitions are appended to the
//   per-record event log as redacted audit events.
//
// Correlation (V2-J bullet 2): a job record carries the `correlationId` of the
// user operation that requested it when one is available — either passed
// explicitly as `createJob({ correlationId })` or inherited from the ambient
// operation scope (`withOperationScope`/`runWithCorrelationScope` in
// `src/shared/structuredLogger.js`, the canonical id module). The field is
// omitted entirely when neither exists, so records minted outside a scope are
// byte-identical to before and every existing smoke that asserts record shape
// keeps passing. `jobId` remains the durable primary key; `correlationId` is
// the additive join key back to the desktop/Agent log lines of the same
// operation.
//
// Pending-job expiry (V2-G): a job may be minted with `expiresAt` (epoch ms or
// an ISO date string). A node may also configure `defaultPendingJobTtlMs`:
// pending NON-destructive jobs then lapse once they are older than that TTL —
// jobs minted while the TTL is configured get the deadline stamped as their
// `expiresAt`, and older records without one are evaluated against
// `enqueuedAt + TTL`. A destructive approval never lapses by default — it must
// be explicitly cancelled or carry an explicit `expiresAt`. Expiry claims ONLY
// jobs that are still `enqueued` and have never started, and only when
// evaluated: the boot-time re-observation pass, any getJob/listJobs read, or
// a keyed request that looks the job up by its idempotency key settles such a
// job FAILED with code `JOB_EXPIRED` and marks it `expired: true`. A running
// job never expires mid-run; it reconciles exactly as before. An expired job
// is never silently replayed: its durable record stays on disk for audit, and
// a later request reusing its idempotency key mints a fresh explicit job (the
// new execution is authorized by the new request, not replayed from the stale
// one). Without an explicit `expiresAt` and a configured default TTL nothing
// expires — behavior is unchanged for callers that do not opt in.

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { sanitizeForDiagnostics } = require("../redaction");
const { correlationMetadata } = require("../structuredLogger");

const JOB_STATES = Object.freeze({
  ENQUEUED: "enqueued",
  RUNNING: "running",
  CANCELLED: "cancelled",
  FAILED: "failed",
  SUCCEEDED: "succeeded",
  TIMEOUT: "timeout",
});

const TERMINAL_JOB_STATES = new Set([
  JOB_STATES.CANCELLED,
  JOB_STATES.FAILED,
  JOB_STATES.SUCCEEDED,
  JOB_STATES.TIMEOUT,
]);

const JOB_ID_PATTERN = /^job_[a-f0-9]{32}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.:@-]{7,127}$/;
const MAX_EVENTS_PER_JOB = 50;
const DEFAULT_JOB_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_JOB_TIMEOUT_MS = 1000;
const MAX_JOB_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_LIST_LIMIT = 200;
const ATOMIC_RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const ATOMIC_RENAME_RETRY_ATTEMPTS = 5;
const ATOMIC_RENAME_RETRY_DELAY_MS = 25;

// Destructive operations are NEVER silently replayed, even when they succeeded
// (V2A_DECISIONS.md: "explicit non-replay stance for destructive ops"). These
// types are outside the curated idempotency set, but the engine enforces the
// stance anyway so a future caller cannot opt a destructive type into replay.
const DESTRUCTIVE_JOB_TYPES = new Set([
  "instance.delete",
  "instance.forget",
  "instance.forceKill",
]);

// V2-G: a pending (enqueued, never-started) job past its expiry settles with
// this error the first time it is evaluated. The message must stay actionable:
// the stale request never executes and the operator re-issues it.
const JOB_EXPIRED_ERROR_MESSAGE = "This queued operation expired while the node was offline. Issue the request again.";

let configuredRootProvider = null;
let auditEventEmitter = null;
let storeLoaded = false;
let storeLoadPromise = null;
let loadedRoot = null;
let recoveryPromise = null;
// V2-G: opt-in default TTL for pending non-destructive jobs. Unset (null) by
// default, so jobs minted without an explicit expiresAt never expire.
let defaultPendingJobTtlMs = null;
const jobs = new Map();
const idempotencyIndex = new Map();

function nowIso() {
  return new Date().toISOString();
}

function createJobError(code, statusCode = 400, details = {}) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function getJobsRoot() {
  if (typeof configuredRootProvider !== "function") {
    throw createJobError("JOB_STORE_UNAVAILABLE", 503, {
      userMessage: "The job store is not configured on this node.",
    });
  }
  return path.resolve(configuredRootProvider());
}

function jobFilePath(jobId) {
  return path.join(getJobsRoot(), `${jobId}.json`);
}

function clampTimeoutMs(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested)) {
    return DEFAULT_JOB_TIMEOUT_MS;
  }
  return Math.min(Math.max(Math.round(requested), MIN_JOB_TIMEOUT_MS), MAX_JOB_TIMEOUT_MS);
}

// V2-G: `expiresAt` accepts an epoch-ms number or an ISO date string and is
// normalized to a canonical ISO string for persistence. Malformed input fails
// closed before any record or index state is touched. A past-dated value is
// rejected too: a job minted already-expired would dispatch and then settle
// FAILED nondeterministically depending on which lazy evaluator ran first.
function normalizeExpiresAt(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) {
    throw createJobError("INVALID_JOB_EXPIRES_AT", 400, {
      field: "expiresAt",
      expected: "an epoch-ms number or an ISO date string",
    });
  }
  if (ms <= Date.now()) {
    throw createJobError("INVALID_JOB_EXPIRES_AT", 400, {
      field: "expiresAt",
      expected: "a future expiry timestamp",
    });
  }
  return new Date(ms).toISOString();
}

// While a default TTL is configured, newly minted non-destructive jobs get
// their derived deadline stamped as `expiresAt` so the record is
// self-describing and keeps its deadline even if the TTL is later removed or
// changed. Records without a stamp (e.g. minted before the TTL was enabled)
// are evaluated age-based in isPendingExpired instead.
function defaultExpiresAtFor(type, enqueuedAtIso) {
  if (defaultPendingJobTtlMs === null || DESTRUCTIVE_JOB_TYPES.has(type)) {
    return null;
  }
  const enqueuedMs = Date.parse(enqueuedAtIso);
  if (!Number.isFinite(enqueuedMs)) {
    return null;
  }
  return new Date(enqueuedMs + defaultPendingJobTtlMs).toISOString();
}

// Expiry only ever claims jobs that never started: a running job reconciles
// exactly as before, and any terminal record is immutable. Invalid persisted
// expiry values are ignored (untrusted data, never a reason to fail a read).
// A record without its own expiry only lapses when a default TTL is configured
// (age-based against enqueuedAt, non-destructive types only) — so enabling the
// TTL also settles pending records minted before it was turned on.
function isPendingExpired(record, nowMs = Date.now()) {
  if (!record || record.state !== JOB_STATES.ENQUEUED || record.startedAt) {
    return false;
  }
  if (record.expiresAt) {
    const expiresMs = Date.parse(record.expiresAt);
    return Number.isFinite(expiresMs) && expiresMs <= nowMs;
  }
  if (defaultPendingJobTtlMs === null || DESTRUCTIVE_JOB_TYPES.has(record.type)) {
    return false;
  }
  const enqueuedMs = Date.parse(record.enqueuedAt);
  return Number.isFinite(enqueuedMs) && enqueuedMs + defaultPendingJobTtlMs <= nowMs;
}

function sanitizeJobValue(value) {
  return sanitizeForDiagnostics(value, { maxDepth: 4 });
}

function sanitizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    return {};
  }
  const sanitized = sanitizeJobValue(target) || {};
  const result = {};
  // V2-D: marketplace install transactions target Marketplace subjects in
  // addition to instance/device identities; "projectId" covers provider packs.
  for (const key of ["instanceId", "requestedId", "nodeId", "backupId", "dependencyId", "containerId", "imageId", "volumeId", "networkId", "projectName", "templateId", "projectId"]) {
    if (typeof sanitized[key] === "string") {
      result[key] = sanitized[key].slice(0, 128);
    }
  }
  return result;
}

function sanitizeOwner(owner) {
  if (!owner || typeof owner !== "object") {
    return { actorId: null, role: null };
  }
  const sanitized = sanitizeJobValue(owner) || {};
  return {
    actorId: typeof sanitized.actorId === "string" ? sanitized.actorId.slice(0, 128) : null,
    role: typeof sanitized.role === "string" ? sanitized.role.slice(0, 64) : null,
  };
}

function publicJob(record) {
  // Records are already sanitized at write time; return a defensive copy so
  // callers cannot mutate the in-memory state of a durable job.
  return JSON.parse(JSON.stringify({
    id: record.id,
    idempotencyKey: record.idempotencyKey || null,
    type: record.type,
    ...(record.correlationId ? { correlationId: record.correlationId } : {}),
    target: record.target,
    owner: record.owner,
    state: record.state,
    stage: record.stage || null,
    expired: record.expired === true,
    enqueuedAt: record.enqueuedAt,
    startedAt: record.startedAt || null,
    completedAt: record.completedAt || null,
    expiresAt: record.expiresAt || null,
    timeoutMs: record.timeoutMs,
    attempts: record.attempts,
    exitCode: record.exitCode ?? null,
    error: record.error || null,
    result: record.result ?? null,
    cancellation: record.cancellation || { requestedAt: null, reason: null, supported: false },
    events: record.events || [],
  }));
}

// A per-writer temp name: a deterministic `<file>.tmp` is shared by every
// concurrent persist of the same record (lazy expiry on read racing a stage
// update or cancel), and the losing rename then throws ENOENT (adversarial
// audit P2, reproduced). The pid+counter suffix makes each writer's temp
// private while the rename stays atomic on the same filesystem.
let persistCounter = 0;

async function persistRecord(record) {
  const filePath = jobFilePath(record.id);
  const payload = `${JSON.stringify(record, null, 2)}\n`;
  persistCounter = (persistCounter + 1) % Number.MAX_SAFE_INTEGER;
  const tempPath = `${filePath}.${process.pid}.${persistCounter}.tmp`;
  await fs.writeFile(tempPath, payload, { mode: 0o600 });
  for (let attempt = 0; attempt < ATOMIC_RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch (error) {
      if (!ATOMIC_RENAME_RETRY_CODES.has(error?.code) || attempt === ATOMIC_RENAME_RETRY_ATTEMPTS - 1) {
        // Best-effort cleanup of this writer's temp so a failed persist does
        // not accumulate orphans (another writer's temp is untouched).
        await fs.rm(tempPath, { force: true }).catch(() => {});
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, ATOMIC_RENAME_RETRY_DELAY_MS));
    }
  }
}

function emitAudit(record, action, outcome, detail) {
  if (typeof auditEventEmitter !== "function") {
    return;
  }
  try {
    auditEventEmitter({
      jobId: record.id,
      type: record.type,
      action,
      outcome,
      state: record.state,
      // V2-J: the audit record is the operation timeline entry for this job, so
      // it carries the same correlation id as the durable record when one
      // exists. Absent (not null) otherwise, keeping the emitted event shape
      // unchanged for jobs minted outside a correlation scope.
      ...(record.correlationId ? { correlationId: record.correlationId } : {}),
      target: record.target,
      detail: detail === undefined ? null : sanitizeJobValue(detail),
    });
  } catch {
    // Audit emission must never break job execution.
  }
}

async function appendEvent(record, event) {
  record.events = Array.isArray(record.events) ? record.events : [];
  record.events.push({ at: nowIso(), ...sanitizeJobValue(event) });
  if (record.events.length > MAX_EVENTS_PER_JOB) {
    record.events = record.events.slice(-MAX_EVENTS_PER_JOB);
  }
  await persistRecord(record);
}

function indexRecord(record) {
  if (record.idempotencyKey) {
    idempotencyIndex.set(record.idempotencyKey, record.id);
  }
}

async function loadStore() {
  const root = getJobsRoot();
  if (storeLoaded && loadedRoot === root) {
    return;
  }
  if (storeLoadPromise) {
    return storeLoadPromise;
  }
  storeLoadPromise = (async () => {
    if (loadedRoot !== null && loadedRoot !== root) {
      // The instance root was reconfigured (tests, or a service re-point);
      // drop state tracked for the previous root and reload.
      disposeJobLifecycle();
      jobs.clear();
      idempotencyIndex.clear();
      recoveryPromise = null;
      storeLoaded = false;
    }
    loadedRoot = root;
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const entries = await fs.readdir(root);
    for (const entry of entries) {
      if (!entry.endsWith(".json") || entry.endsWith(".tmp")) {
        continue;
      }
      try {
        const raw = await fs.readFile(path.join(root, entry), "utf8");
        const record = JSON.parse(raw);
        if (!record || typeof record.id !== "string" || !JOB_ID_PATTERN.test(record.id)) {
          continue;
        }
        if (jobs.has(record.id)) {
          continue;
        }
        record.events = Array.isArray(record.events) ? record.events : [];
        jobs.set(record.id, {
          record,
          timer: null,
          cancelHandler: null,
        });
        indexRecord(record);
      } catch {
        // Corrupt or partially written job files are skipped; they are
        // untrusted data, never a reason to fail unrelated operations.
      }
    }
    storeLoaded = true;
  })();
  try {
    await storeLoadPromise;
  } catch (error) {
    loadedRoot = null;
    storeLoaded = false;
    throw error;
  } finally {
    storeLoadPromise = null;
  }
}

function markTerminal(record, state, patch = {}) {
  record.state = state;
  record.completedAt = nowIso();
  for (const [key, value] of Object.entries(patch)) {
    record[key] = value;
  }
}

async function settleJob(entry, state, patch = {}, event = {}) {
  const record = entry.record;
  if (TERMINAL_JOB_STATES.has(record.state)) {
    return;
  }
  const sanitizedPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    sanitizedPatch[key] = value === undefined ? null : sanitizeJobValue(value);
  }
  markTerminal(record, state, sanitizedPatch);
  if (entry.timer) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }
  entry.cancelHandler = null;
  await appendEvent(record, { state, action: `job.${state}`, ...event });
  emitAudit(record, `job.${state}`, state === JOB_STATES.SUCCEEDED ? "ok" : state, {
    errorCode: record.error?.code || null,
  });
}

// V2-G: settles a pending job whose approval window lapsed before it ever
// started. The old record stays on disk for audit with `expired: true`; a
// keyed request that finds it re-issues the operation as a fresh explicit job
// (never a replay of the stale one). Safe against concurrent callers: the
// terminal transition inside settleJob is applied synchronously.
async function settleExpiredPendingJob(entry, event = {}) {
  await settleJob(entry, JOB_STATES.FAILED, {
    error: { code: "JOB_EXPIRED", message: JOB_EXPIRED_ERROR_MESSAGE },
    expired: true,
  }, { reason: "expired before start", ...event });
}

function timeoutJobError(record) {
  return createJobError("JOB_TIMEOUT", 504, {
    jobId: record.id,
    timeoutMs: record.timeoutMs,
    userMessage: `Job exceeded its ${record.timeoutMs}ms timeout and was cancelled.`,
  });
}

async function awaitJobCompletion(entry) {
  // Duplicate (deduped) callers rejoin the original execution instead of
  // starting a second one, and receive the same result/error contract. A keyed
  // duplicate can observe the entry in the narrow window between indexing and
  // dispatch; wait briefly for dispatch rather than racing it.
  for (let attempt = 0; !entry.completion && attempt < 500; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const outcome = await entry.completion;
  const record = entry.record;
  if (record.state === JOB_STATES.SUCCEEDED) {
    return { job: publicJob(record), result: entry.result, deduped: true, replayed: false };
  }
  if (record.state === JOB_STATES.CANCELLED) {
    throw createJobError("JOB_CANCELLED", 409, { jobId: record.id, error: record.error });
  }
  if (record.state === JOB_STATES.TIMEOUT) {
    throw timeoutJobError(record);
  }
  throw entry.originalError || createJobError("JOB_FAILED", 500, {
    jobId: record.id,
    error: record.error,
  });
}

function runJob(entry, run) {
  const record = entry.record;

  const execute = async () => {
    if (record.state !== JOB_STATES.ENQUEUED) {
      // Cancelled (or otherwise settled) between enqueue and dispatch.
      return;
    }
    record.state = JOB_STATES.RUNNING;
    record.startedAt = nowIso();
    await appendEvent(record, { state: JOB_STATES.RUNNING, action: "job.running" });
    emitAudit(record, "job.running", "ok");

    entry.timer = setTimeout(() => {
      entry.timer = null;
      void (async () => {
        try {
          if (TERMINAL_JOB_STATES.has(record.state)) {
            return;
          }
          if (typeof entry.cancelHandler === "function") {
            try {
              await entry.cancelHandler({ reason: "timeout", jobId: record.id });
            } catch {
              // The timeout transition is recorded regardless of cancel outcome.
            }
          }
          await settleJob(entry, JOB_STATES.TIMEOUT, {
            error: { code: "JOB_TIMEOUT", message: `Job exceeded its ${record.timeoutMs}ms timeout and was cancelled.` },
          }, { reason: "timeout" });
        } catch {
          // Persisting the timeout must not throw into an unhandled rejection.
        }
      })();
    }, record.timeoutMs);
    entry.timer.unref?.();

    try {
      const result = await run({
        jobId: record.id,
        setStage: async (stage) => {
          if (TERMINAL_JOB_STATES.has(record.state)) {
            return;
          }
          record.stage = typeof stage === "string" ? String(stage).slice(0, 200) : null;
          await persistRecord(record).catch(() => {});
        },
      });
      entry.result = result;
      if (record.cancellation?.requestedAt) {
        await settleJob(entry, JOB_STATES.CANCELLED, {}, { reason: record.cancellation.reason || "cancelled by operator" });
        return;
      }
      await settleJob(entry, JOB_STATES.SUCCEEDED, { result, error: null });
    } catch (error) {
      entry.originalError = error;
      if (record.cancellation?.requestedAt) {
        await settleJob(entry, JOB_STATES.CANCELLED, {}, { reason: record.cancellation.reason || "cancelled by operator" });
        return;
      }
      const sanitizedError = sanitizeJobValue({
        code: error?.code || "JOB_FAILED",
        message: error?.message || "Job failed.",
      });
      await settleJob(entry, JOB_STATES.FAILED, { error: sanitizedError });
    }
  };

  return execute();
}

function findExistingByIdempotencyKey(idempotencyKey) {
  const existingJobId = idempotencyIndex.get(idempotencyKey);
  if (!existingJobId) {
    return null;
  }
  return jobs.get(existingJobId) || null;
}

function throwIdempotencyConflict(record, priorState) {
  throw createJobError("JOB_CONFLICT", 409, {
    priorJobId: record.id,
    priorState,
    idempotencyKey: record.idempotencyKey,
    userMessage: DESTRUCTIVE_JOB_TYPES.has(record.type)
      ? "Destructive operations are never replayed. Issue a new explicit request to repeat this operation."
      : `A prior attempt under this idempotency key ended in state "${priorState}". Use a new idempotency key to retry explicitly.`,
  });
}

async function createJob(options = {}) {
  await loadStore();

  const type = typeof options.type === "string" ? options.type : null;
  if (!type || !/^[a-z][a-z0-9.:-]{2,63}$/.test(type)) {
    throw createJobError("INVALID_JOB_TYPE", 400, { expected: "namespace.action (e.g. instance.start)" });
  }

  const run = typeof options.run === "function" ? options.run : null;
  if (!run) {
    throw createJobError("INVALID_JOB_RUN", 400, { expected: "an executable run function" });
  }

  // V2-G: normalized up front so malformed expiry input fails closed before
  // any record or idempotency index state is touched.
  const expiresAt = normalizeExpiresAt(options.expiresAt);

  let idempotencyKey = null;
  let releasedExpiredPrior = null;
  if (options.idempotencyKey !== undefined && options.idempotencyKey !== null) {
    idempotencyKey = String(options.idempotencyKey);
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw createJobError("INVALID_IDEMPOTENCY_KEY", 400, {
        field: "idempotencyKey",
        expected: "8-128 characters: letters, numbers, or _.:@-",
      });
    }
    // Synchronous lookup on purpose: the check-then-create sequence must be
    // atomic within one continuation so two concurrent keyed requests can
    // never both create a job for the same key.
    const existingEntry = findExistingByIdempotencyKey(idempotencyKey);
    if (existingEntry) {
      const prior = existingEntry.record;
      if (isPendingExpired(prior) || prior.expired === true) {
        // V2-G: the expired attempt can never execute again, so its key is
        // released instead of replaying or conflicting — whether the record
        // is still pending-expired or was ALREADY settled (by boot recovery
        // or a lazy read) before this request. A terminal expired record
        // must behave identically to a pending-expired one, or the contract
        // depends on which evaluator ran first (P1 review finding). The
        // fresh explicit request below mints a new job; the expired record
        // stays on disk for audit. The key stays reserved for THIS
        // continuation until the new record is indexed, preserving the
        // concurrent-duplicate guarantee.
        releasedExpiredPrior = existingEntry;
      } else if (!TERMINAL_JOB_STATES.has(prior.state)) {
        // Duplicate in-flight request: rejoin the original execution and return
        // the same job, never a second run of the same operation.
        emitAudit(prior, "job.dedupe", "ok", { requestedType: type });
        if (options.awaitResult !== false) {
          return await awaitJobCompletion(existingEntry);
        }
        return { job: publicJob(prior), deduped: true, replayed: false };
      } else if (DESTRUCTIVE_JOB_TYPES.has(prior.type) || prior.state !== JOB_STATES.SUCCEEDED) {
        emitAudit(prior, "job.conflict", "blocked", { requestedType: type, priorState: prior.state });
        throwIdempotencyConflict(prior, prior.state);
      } else {
        // Non-destructive succeeded result: replay the terminal result without
        // re-executing the operation.
        await appendEvent(prior, { action: "job.replay", state: prior.state, detail: { requestedType: type } });
        emitAudit(prior, "job.replay", "ok", { requestedType: type });
        return { job: publicJob(prior), result: prior.result, deduped: true, replayed: true };
      }
    }
  }

  const record = {
    id: `job_${crypto.randomBytes(16).toString("hex")}`,
    idempotencyKey,
    type,
    // V2-J: explicit caller id wins, otherwise the ambient operation scope.
    // Spread so an uncorrelated job keeps the previous record shape exactly.
    ...correlationMetadata(options.correlationId),
    target: sanitizeTarget(options.target),
    owner: sanitizeOwner(options.owner),
    state: JOB_STATES.ENQUEUED,
    stage: null,
    enqueuedAt: nowIso(),
    startedAt: null,
    completedAt: null,
    expiresAt: null,
    timeoutMs: clampTimeoutMs(options.timeoutMs),
    attempts: 1,
    exitCode: null,
    error: null,
    result: null,
    cancellation: {
      requestedAt: null,
      reason: null,
      supported: typeof options.cancel === "function" || options.cancellationSupported === true,
    },
    events: [],
  };
  // V2-G: an explicit expiry wins; otherwise a configured default TTL applies
  // (non-destructive types only). Stamped so the record is self-describing;
  // unstamped records are evaluated age-based while a TTL is configured.
  record.expiresAt = expiresAt || defaultExpiresAtFor(type, record.enqueuedAt);

  const entry = {
    record,
    timer: null,
    cancelHandler: typeof options.cancel === "function" ? options.cancel : null,
    result: undefined,
    originalError: null,
    completion: null,
  };
  jobs.set(record.id, entry);
  indexRecord(record);

  if (releasedExpiredPrior) {
    // Durable, audited settlement of the expired record whose key this fresh
    // job now owns. The index above already points at the new record, so a
    // concurrent keyed duplicate dedupes onto this execution instead of
    // minting a second one. A persist failure must not abort the fresh job's
    // dispatch — the stale record is settled by the next lazy read anyway
    // (best-effort here; review finding).
    await settleExpiredPendingJob(releasedExpiredPrior, { reason: "expired before start (idempotency key re-issued)" }).catch(() => {});
  }

  await appendEvent(record, { state: JOB_STATES.ENQUEUED, action: "job.enqueued" });
  emitAudit(record, "job.enqueued", "ok");

  if (record.state === JOB_STATES.ENQUEUED) {
    const completion = runJob(entry, run);
    entry.completion = completion;
    // Internal bookkeeping must never surface as an unhandled rejection; the
    // record settles its own terminal state inside execute().
    completion.catch(() => {});
  }

  const awaitResult = options.awaitResult !== false;
  if (!awaitResult) {
    return { job: publicJob(record), deduped: false, replayed: false };
  }

  if (!entry.completion) {
    // Cancelled (or otherwise settled) between enqueue and dispatch: report
    // the terminal record instead of awaiting an execution that never started.
    return { job: publicJob(record), deduped: false, replayed: false, result: null };
  }

  await entry.completion;
  const result = entry.result;
  if (record.state === JOB_STATES.FAILED) {
    if (entry.originalError && typeof entry.originalError === "object" && entry.originalError.jobId === undefined) {
      // Correlate the surfaced error back to its durable job record.
      entry.originalError.jobId = record.id;
    }
    throw entry.originalError || createJobError("JOB_FAILED", 500, { jobId: record.id, error: record.error });
  }
  if (record.state === JOB_STATES.TIMEOUT) {
    throw timeoutJobError(record);
  }
  if (record.state === JOB_STATES.CANCELLED) {
    throw createJobError("JOB_CANCELLED", 409, { jobId: record.id, error: record.error });
  }
  return { job: publicJob(record), result, deduped: false, replayed: false };
}

async function getJob(jobId) {
  await loadStore();
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
    throw createJobError("INVALID_JOB_ID", 400, { field: "jobId", expected: "job_<32 hex characters>" });
  }
  const entry = jobs.get(jobId);
  if (!entry) {
    return null;
  }
  if (isPendingExpired(entry.record)) {
    // V2-G lazy expiry: a read settles an expired pending job before showing
    // it, so the caller observes the truth (failed/expired) instead of a
    // stale approval that must never execute.
    await settleExpiredPendingJob(entry);
  }
  return publicJob(entry.record);
}

async function listJobs(options = {}) {
  await loadStore();
  const limitRaw = Number(options.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(Math.floor(limitRaw), MAX_LIST_LIMIT)
    : MAX_LIST_LIMIT;
  const filtered = [];
  for (const entry of jobs.values()) {
    const record = entry.record;
    if (options.type && record.type !== options.type) {
      continue;
    }
    if (options.instanceId && record.target?.instanceId !== options.instanceId
      && record.target?.requestedId !== options.instanceId) {
      continue;
    }
    if (isPendingExpired(record)) {
      // V2-G lazy expiry (see getJob): settle before the record is listed.
      await settleExpiredPendingJob(entry);
    }
    filtered.push(record);
  }
  filtered.sort((a, b) => String(b.enqueuedAt || "").localeCompare(String(a.enqueuedAt || "")));
  return {
    jobs: filtered.slice(0, limit).map(publicJob),
    total: filtered.length,
  };
}

async function cancelJob(jobId, options = {}) {
  await loadStore();
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
    throw createJobError("INVALID_JOB_ID", 400, { field: "jobId", expected: "job_<32 hex characters>" });
  }
  const entry = jobs.get(jobId);
  if (!entry) {
    return null;
  }
  const record = entry.record;
  const reason = sanitizeJobValue(String(options.reason || "cancelled by operator")).slice(0, 300);

  if (TERMINAL_JOB_STATES.has(record.state)) {
    // Idempotent cancel: a repeat cancel of a terminal job returns the existing
    // result with no new side effect.
    return { job: publicJob(record), cancelled: false, alreadyTerminal: true };
  }

  record.cancellation = {
    ...record.cancellation,
    requestedAt: nowIso(),
    reason,
  };

  if (record.state === JOB_STATES.ENQUEUED) {
    markTerminal(record, JOB_STATES.CANCELLED);
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.cancelHandler = null;
    await appendEvent(record, { state: JOB_STATES.CANCELLED, action: "job.cancelled", reason });
    emitAudit(record, "job.cancelled", "cancelled", { reason });
    return { job: publicJob(record), cancelled: true, alreadyTerminal: false };
  }

  await persistRecord(record);
  if (typeof entry.cancelHandler === "function") {
    const handler = entry.cancelHandler;
    entry.cancelHandler = null;
    try {
      await handler({ reason, jobId: record.id });
    } catch (error) {
      await appendEvent(record, {
        action: "job.cancel.failed",
        state: record.state,
        detail: { message: error?.message || "cancel handler failed" },
      });
    }
    // The run settles the terminal transition (usually to cancelled); if the
    // handler completed the operation first, settleJob skipped the cancel.
  } else {
    await appendEvent(record, { action: "job.cancel.unsupported", state: record.state, reason });
  }

  return { job: publicJob(record), cancelled: true, alreadyTerminal: false };
}

async function recoverInterruptedJobs(reconcile) {
  await loadStore();
  if (recoveryPromise) {
    return recoveryPromise;
  }
  recoveryPromise = (async () => {
    let expiredCount = 0;
    for (const entry of jobs.values()) {
      const record = entry.record;
      if (TERMINAL_JOB_STATES.has(record.state)) {
        continue;
      }
      if (isPendingExpired(record)) {
        // V2-G: an expired pending job never started, so there is nothing on
        // the node to re-observe; settle it expired instead of reconciling.
        await settleExpiredPendingJob(entry, { reason: "expired before start (re-observed after node restart)" });
        expiredCount += 1;
        continue;
      }
      let outcome;
      try {
        outcome = typeof reconcile === "function"
          ? await reconcile(publicJob(record))
          : null;
      } catch (error) {
        outcome = {
          state: JOB_STATES.FAILED,
          error: { code: "JOB_RECONCILE_FAILED", message: error?.message || "Reconciliation failed." },
        };
      }
      const state = outcome?.state;
      if (!TERMINAL_JOB_STATES.has(state)) {
        outcome = {
          state: JOB_STATES.FAILED,
          error: { code: "JOB_INTERRUPTED", message: "The node restarted while this job was in flight; it could not be reconciled." },
        };
      }
      await appendEvent(record, {
        action: "job.reobserved",
        state: record.state,
        detail: { reconciledTo: state },
      });
      await settleJob(entry, state, {
        error: state === JOB_STATES.SUCCEEDED ? null : sanitizeJobValue(outcome.error || { code: "JOB_INTERRUPTED" }),
        result: state === JOB_STATES.SUCCEEDED ? sanitizeJobValue(outcome.result ?? null) : null,
      }, { reason: "re-observed after node restart" });
    }
    return expiredCount;
  })();
  try {
    const expiredCount = await recoveryPromise;
    return { recovered: true, expired: expiredCount };
  } catch (error) {
    recoveryPromise = null;
    throw error;
  }
}

function disposeJobLifecycle() {
  for (const entry of jobs.values()) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
    entry.cancelHandler = null;
  }
}

function configureJobLifecycle(options = {}) {
  if (typeof options.getRoot === "function") {
    configuredRootProvider = options.getRoot;
  }
  if (typeof options.auditEvent === "function") {
    auditEventEmitter = options.auditEvent;
  }
  // V2-G: opt-in default pending-job TTL. Explicitly passing a non-positive or
  // non-finite value disables the default again.
  if (options.defaultPendingJobTtlMs !== undefined) {
    const ttl = Number(options.defaultPendingJobTtlMs);
    defaultPendingJobTtlMs = Number.isFinite(ttl) && ttl > 0 ? Math.round(ttl) : null;
  }
}

function setAuditEventEmitter(emitter) {
  auditEventEmitter = typeof emitter === "function" ? emitter : null;
}

module.exports = {
  JOB_STATES,
  TERMINAL_JOB_STATES,
  DESTRUCTIVE_JOB_TYPES,
  DEFAULT_JOB_TIMEOUT_MS,
  configureJobLifecycle,
  setAuditEventEmitter,
  createJob,
  getJob,
  listJobs,
  cancelJob,
  recoverInterruptedJobs,
  disposeJobLifecycle,
  _test: {
    isStoreLoaded: () => storeLoaded,
    trackedJobCount: () => jobs.size,
    async reset() {
      disposeJobLifecycle();
      jobs.clear();
      idempotencyIndex.clear();
      storeLoaded = false;
      storeLoadPromise = null;
      loadedRoot = null;
      recoveryPromise = null;
      defaultPendingJobTtlMs = null;
    },
  },
};
