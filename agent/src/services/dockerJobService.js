// V2-C durable job wrapper for Docker lifecycle operations
// (docs/v2/V2C_CONTAINERS_WAVE1.md §3.3): state-changing Docker operations
// ride the shared V2-A job store (`src/shared/instances/jobLifecycle`) so a
// client restart can never orphan them, and destructive operations are never
// replayable — they refuse idempotency keys (V2A_WAVE1_REVIEW item f stance).

const jobLifecycle = require("../../../src/shared/instances/jobLifecycle");

// Destructive Docker operations are outside any curated idempotency set: each
// execution mints a fresh explicit job, and an idempotency key is refused so a
// repeated request can never silently replay a destructive side effect.
const DESTRUCTIVE_DOCKER_JOB_TYPES = new Set([
  "docker.container.delete",
  "docker.image.delete",
  "docker.image.prune",
  "docker.volume.delete",
  "docker.volume.prune",
  "docker.network.delete",
  "docker.network.prune",
  "docker.compose.down",
  "docker.cleanup.run",
]);

function isDestructiveDockerType(type) {
  return DESTRUCTIVE_DOCKER_JOB_TYPES.has(type);
}

function dockerJobError(code, statusCode, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

// Exactly docker.<namespace>.<action>; everything else (docker., docker..x,
// docker.x, extra segments) fails closed instead of minting a degenerate job.
const DOCKER_JOB_TYPE_PATTERN = /^docker\.[a-z][a-z0-9.:-]{0,63}\.[a-z][a-z0-9.:-]{0,63}$/;

async function mintDockerJob(options = {}) {
  const type = String(options.type || "");
  if (!type || !DOCKER_JOB_TYPE_PATTERN.test(type)) {
    throw dockerJobError("INVALID_DOCKER_JOB_TYPE", 400, "Docker job type must be docker.<namespace>.<action>.");
  }
  const destructive = isDestructiveDockerType(type);
  const idempotencyKey = options.idempotencyKey;
  if (destructive && idempotencyKey !== undefined && idempotencyKey !== null) {
    throw dockerJobError("DESTRUCTIVE_IDEMPOTENCY_REFUSED", 400,
      "Destructive Docker operations are never replayed and cannot accept an idempotency key.");
  }
  return jobLifecycle.createJob({
    type,
    target: options.target || {},
    idempotencyKey: destructive ? undefined : idempotencyKey,
    timeoutMs: options.jobTimeoutMs,
    owner: options.owner,
    cancellationSupported: options.cancellationSupported,
    cancel: options.cancel,
    run: options.run,
  });
}

module.exports = {
  DESTRUCTIVE_DOCKER_JOB_TYPES,
  isDestructiveDockerType,
  mintDockerJob,
};