// V2-D install transactions on the V2-A durable job lifecycle
// (docs/v2/V2D_MARKETPLACE_RUNTIMES_WAVE1.md §3 item 4): Marketplace installs
// ride the shared V2-A job store (`src/shared/instances/jobLifecycle`) so a
// desktop restart can never orphan them, a keyed repeat dedupes onto the
// original job, and an interrupted install is honestly reconciled as failed on
// the next boot. Mirrors agent/src/services/dockerJobService.js (V2-C), with
// one structural difference: run is caller-provided so smokes can mint jobs
// hermetically without loading the real install executors.

const jobLifecycle = require("../shared/instances/jobLifecycle");

// Exactly marketplace.<namespace>[.<action>]; everything else (marketplace.,
// marketplace..x, marketplace.x, extra segments, uppercase) fails closed
// instead of minting a degenerate job. Note: the Wave-1 survey pattern
// (^marketplace\.<a>\.<b>$) rejects the two contracted two-segment types
// themselves (marketplace.install / marketplace.steamcmd-update), so the
// action segment is optional here while staying strict about characters and
// segment count.
const MARKETPLACE_JOB_TYPE_PATTERN = /^marketplace\.[a-z][a-z0-9:-]{0,63}(\.[a-z][a-z0-9:-]{0,63})?$/;

// Neither Wave-1 Marketplace job type is destructive: both are forward-progress
// operations that may be replayed once succeeded, so idempotency keys are
// allowed (unlike the destructive Docker set, which refuses them).
const MARKETPLACE_JOB_TYPES = Object.freeze({
  INSTALL: "marketplace.install",
  STEAMCMD_UPDATE: "marketplace.steamcmd-update",
});

// Installs carry large downloads; a fresh explicit request may legitimately run
// far longer than the 10-minute engine default. The engine clamps anyway.
const MARKETPLACE_JOB_TIMEOUT_MS = 60 * 60 * 1000;

// Optional warmup (configure the shared job store + one-time re-observation).
// The desktop main wires this to the local instance service's job recovery so
// the marketplace wrappers reuse the shared V2-A job root; smokes configure
// jobLifecycle directly and leave this unset.
let lifecycleWarmup = null;

function setMarketplaceJobsWarmup(warmup) {
  lifecycleWarmup = typeof warmup === "function" ? warmup : null;
}

function marketplaceJobError(code, statusCode, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function isMarketplaceJobType(type) {
  return typeof type === "string" && MARKETPLACE_JOB_TYPE_PATTERN.test(type);
}

// Idempotency-key characters are constrained by the job engine
// (letters, numbers, or _.:@-); subject segments are slugified so any catalog
// or instance identifier can ride the key without producing an invalid key.
function sanitizeMarketplaceKeySegment(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "unknown";
}

function buildMarketplaceInstallKey({ nodeId = null, subject = null, version = null } = {}) {
  const key = [
    "marketplace.install",
    sanitizeMarketplaceKeySegment(nodeId || "local"),
    sanitizeMarketplaceKeySegment(subject),
    sanitizeMarketplaceKeySegment(version || "unversioned"),
  ].join(":");
  // The engine allows up to 128 key characters; keep a small buffer so a
  // trailing separator is never exposed after truncation.
  return key.slice(0, 120);
}

// Mint a durable Marketplace install job. Idempotency keys are recommended
// (allowed: neither Wave-1 type is destructive). A keyed repeat dedupes onto
// the in-flight job, and a keyed repeat of a SUCCEEDED install replays the
// terminal result without re-executing (V2-A curated replay stance). A keyed
// repeat after a failed/cancelled attempt would otherwise surface the engine's
// JOB_CONFLICT guidance ("issue a new explicit request to retry explicitly") —
// the retrying user request IS that explicit new request, so the wrapper mints
// a fresh unkeyed job for it instead of blocking the retry behind a 409.
async function mintMarketplaceJob(options = {}) {
  const type = String(options.type || "");
  if (!isMarketplaceJobType(type)) {
    throw marketplaceJobError("INVALID_MARKETPLACE_JOB_TYPE", 400, "Marketplace job type must be marketplace.<namespace>.<action>.");
  }
  if (lifecycleWarmup) {
    await lifecycleWarmup();
  }
  const createOptions = {
    type,
    target: options.target || {},
    idempotencyKey: options.idempotencyKey,
    timeoutMs: options.timeoutMs === undefined ? MARKETPLACE_JOB_TIMEOUT_MS : options.timeoutMs,
    owner: options.owner,
    cancellationSupported: options.cancellationSupported === true,
    cancel: options.cancel,
    // Fire-and-forget mints (tests, background reconcilers) must get exactly
    // what they asked for: dropping this option silently upgraded non-awaiting
    // mints to awaiting ones and deadlocked their callers (P0-2 review finding).
    awaitResult: options.awaitResult,
    run: options.run,
  };
  try {
    return await jobLifecycle.createJob(createOptions);
  } catch (error) {
    if (error?.code === "JOB_CONFLICT" && createOptions.idempotencyKey !== undefined && createOptions.idempotencyKey !== null) {
      return await jobLifecycle.createJob({ ...createOptions, idempotencyKey: undefined });
    }
    throw error;
  }
}

module.exports = {
  MARKETPLACE_JOB_TYPES,
  MARKETPLACE_JOB_TIMEOUT_MS,
  isMarketplaceJobType,
  buildMarketplaceInstallKey,
  mintMarketplaceJob,
  setMarketplaceJobsWarmup,
};
