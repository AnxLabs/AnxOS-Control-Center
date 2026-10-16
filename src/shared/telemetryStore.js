"use strict";

// Bounded historical telemetry series model (host / node / instance /
// endpoint / provider availability).
//
// WHAT THIS MODULE IS
// -------------------
// A pure data model with hard bounds. It owns no clock, filesystem, timers,
// network or hidden state: callers inject every timestamp and own persistence
// (the storage service lands separately). `src/shared/**` is copied into the
// packaged Agent runtime, so this file may only require its pure sibling
// redaction module (same rule as providerAdapterContract.js); it must not touch
// Electron, filesystem, network, or read the clock.
//
// REDACTION
// ---------
// Series labels, units and metadata string values are caller-supplied text, so
// they are redacted through src/shared/redaction.js at every boundary that can
// surface or persist them: registration, deserialization, serialization,
// reads, lists and exports. A label can therefore never carry a credential
// assignment or a private filesystem path into telemetry.json or an export.
// Identity fields (key, nodeId, instanceId) are not free text and stay
// untouched: they are also embedded in series keys.
//
// BOUNDS
// ------
//   * DEFAULT_MAX_SAMPLES_PER_SERIES — a per-series ring, 6000 samples,
//     roughly seven days at two-minute sampling (seven days is 5040 samples,
//     so 6000 keeps headroom). On overflow the OLDEST sample is dropped first
//     so the newest history always survives.
//   * DEFAULT_MAX_SERIES — 256 registered series. registerSeries() refuses
//     beyond the cap and trimToLimits() can re-impose it on loaded state.
//   * DEFAULT_MAX_FILE_BYTES — 32 MiB file budget; bytes are measured as the
//     length of the canonical serialization.
//
// MISSING IS NOT ZERO
// -------------------
// A sample is EITHER present (numeric `value`, `missing === null`) OR missing
// (`value === null`, `missing` is one of GAP_REASONS). The invariant is
// enforced on every write and repair: a numeric value always clears `missing`,
// and a null value without a valid reason becomes "unknown". summarizeSeries()
// computes min/max/avg over present numeric samples only and counts gaps in
// `missingCount`, so a gap can never contribute 0 to an average. A series with
// no samples at all stays registered but empty, which keeps "no samples yet"
// distinguishable from "the value was zero". trimToRetention() deliberately
// keeps emptied series for the same reason.
//
// REPAIR POLICY (serialize / deserialize)
// ---------------------------------------
// serializeState() writes a canonical, bounded view: series keys sorted,
// metadata reduced to at most MAX_METADATA_KEYS primitive entries with sorted
// keys, samples normalized and capped to the newest DEFAULT_MAX_SAMPLES_PER_SERIES
// entries. deserializeState() repairs rather than rejects missing or mistyped
// fields; it only fails for unparseable or non-object input
// (TELEMETRY_STATE_CORRUPT) or a schemaVersion newer than this build
// understands (TELEMETRY_SCHEMA_UNSUPPORTED).
//
// EXPORT SEAM
// -----------
// exportSeries() is the read-only handoff to whatever persistence or transport
// layer comes later: it never mutates state, filters by key and time window,
// caps each row at the per-series bound and reports `truncated` whenever it
// returned less than the full state would have produced.
//
// WHAT IT DOES NOT PROVE
// ----------------------
// This is a model, not a collector: it cannot tell whether a present-looking
// value was ever really collected, whether a gap was reported honestly by its
// producer, or whether an export reached its destination. It also does not
// prove a persisted file's integrity beyond JSON parseability; that belongs to
// the storage service.

const { redactString } = require("./redaction");

const TELEMETRY_SCHEMA_VERSION = 1;
const DEFAULT_MAX_SAMPLES_PER_SERIES = 6000;
const DEFAULT_MAX_SERIES = 256;
const DEFAULT_MAX_FILE_BYTES = 32 * 1024 * 1024;
const SERIES_KINDS = Object.freeze(["host", "node", "instance", "endpoint", "provider"]);
const GAP_REASONS = Object.freeze(["collector-failed", "not-running", "timeout", "unsupported", "unknown"]);
const MAX_METADATA_KEYS = 12;

// A metadata key that names a credential is redacted by key, not only by value
// pattern: {"authToken":"X"} must never survive into the store or an export.
const SENSITIVE_METADATA_KEY = /token|secret|password|passwd|api[_-]?key|auth|authorization|credential|private/i;

// Accepted registration key: three to 181 characters, starting alphanumeric,
// then lowercase/uppercase alphanumerics, ':', '.', '_' or '-'.
const SERIES_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{2,180}$/i;
const MAX_KEY_LENGTH = 181;
const KEY_SEGMENT_PATTERN = /[^a-z0-9._-]+/gi;

const TELEMETRY_STATE_CORRUPT = "TELEMETRY_STATE_CORRUPT";
const TELEMETRY_SCHEMA_UNSUPPORTED = "TELEMETRY_SCHEMA_UNSUPPORTED";
const TELEMETRY_SERIES_LIMIT = "TELEMETRY_SERIES_LIMIT";
const TELEMETRY_SERIES_KEY_INVALID = "TELEMETRY_SERIES_KEY_INVALID";
const TELEMETRY_KIND_INVALID = "TELEMETRY_KIND_INVALID";

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Accepts a finite epoch number or a parseable timestamp string; everything
// else is "not provided". No clock is read here.
function toTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function normalizeRegisteredAt(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return null;
}

// Free-text presentation values (labels, units, metadata string values) are
// redacted before they can be stored, serialized, read or exported. Identity
// fields are deliberately not routed through this: they are not text and they
// are embedded verbatim in series keys.
function redactPresentationText(value) {
  return typeof value === "string" ? redactString(value) : value;
}

// Metadata is a small JSON-safe bag: at most MAX_METADATA_KEYS entries, keys
// sorted for deterministic encoding, primitive values only (non-primitive
// values are dropped rather than stringified into unbounded text). String
// values are redacted, and a credential-named key has its value replaced with
// "[redacted]" even when the value does not look secret-shaped; the key is kept
// so the metadata shape and bounds stay intact.
function sanitizeMetadata(metadata) {
  const cleaned = {};
  if (!isPlainObject(metadata)) return cleaned;
  for (const key of Object.keys(metadata).sort()) {
    if (Object.keys(cleaned).length >= MAX_METADATA_KEYS) break;
    const value = metadata[key];
    if (SENSITIVE_METADATA_KEY.test(key)) {
      cleaned[key] = "[redacted]";
      continue;
    }
    const type = typeof value;
    if (value === null || type === "boolean") cleaned[key] = value;
    else if (type === "string") cleaned[key] = redactPresentationText(value);
    else if (type === "number" && Number.isFinite(value)) cleaned[key] = value;
  }
  return cleaned;
}

// The missing-vs-zero invariant lives here: a finite numeric value is a
// present sample with no gap reason; anything else is a gap whose reason must
// be one of GAP_REASONS ("unknown" otherwise). Invalid timestamps are rejected
// (null), and invalid samples are dropped rather than guessed.
function normalizeSample(input) {
  if (!isPlainObject(input)) return null;
  const at = typeof input.at === "string" && Number.isFinite(Date.parse(input.at)) ? input.at : null;
  if (at === null) return null;
  if (typeof input.value === "number" && Number.isFinite(input.value)) {
    return { at, value: input.value, missing: null };
  }
  return { at, value: null, missing: GAP_REASONS.includes(input.missing) ? input.missing : "unknown" };
}

function ensureSeriesMap(state) {
  if (!isPlainObject(state)) return null;
  if (!isPlainObject(state.series)) state.series = {};
  return state.series;
}

function seriesSampleCount(series) {
  return isPlainObject(series) && Array.isArray(series.samples) ? series.samples.length : 0;
}

function sampleTimestamp(sample) {
  return isPlainObject(sample) && typeof sample.at === "string" ? sample.at : null;
}

function applyLimit(samples, limit) {
  if (!Number.isInteger(limit) || limit < 0) return samples;
  if (limit === 0) return [];
  return samples.length > limit ? samples.slice(-limit) : samples;
}

// Normalized copies of the samples inside [since, to] (inclusive). Invalid
// bounds are treated as "not provided"; malformed samples are dropped.
function filterSamples(samples, options = {}) {
  const source = Array.isArray(samples) ? samples : [];
  const since = toTime(options.since);
  const to = toTime(options.to);
  const filtered = [];
  for (const sample of source) {
    const normalized = normalizeSample(sample);
    if (!normalized) continue;
    const at = Date.parse(normalized.at);
    if (since !== null && at < since) continue;
    if (to !== null && at > to) continue;
    filtered.push(normalized);
  }
  return filtered;
}

function countSamples(state) {
  const map = isPlainObject(state) && isPlainObject(state.series) ? state.series : {};
  let total = 0;
  for (const key of Object.keys(map)) total += seriesSampleCount(map[key]);
  return total;
}

/**
 * Create an empty telemetry state.
 *
 * @returns {{ schemaVersion: number, series: Record<string, object> }}
 */
function createEmptyState() {
  return { schemaVersion: TELEMETRY_SCHEMA_VERSION, series: {} };
}

/**
 * Register a series, or update the presentation fields of an existing one.
 *
 * Re-registration updates label/unit/metadata only: it never clears samples
 * and never rewrites identity fields (key, kind, nodeId, instanceId) of an
 * existing series. `registeredAt` is stored as provided (string or finite
 * number) because this module owns no clock.
 *
 * @returns {{ ok: true, series: object } | { ok: false, code: string }}
 */
function registerSeries(state, options = {}) {
  const input = isPlainObject(options) ? options : {};
  const map = ensureSeriesMap(state);
  if (!map) return { ok: false, code: TELEMETRY_SERIES_KEY_INVALID };
  const key = input.key;
  if (typeof key !== "string" || !SERIES_KEY_PATTERN.test(key)) {
    return { ok: false, code: TELEMETRY_SERIES_KEY_INVALID };
  }
  const existing = Object.prototype.hasOwnProperty.call(map, key) && isPlainObject(map[key]) ? map[key] : null;
  const requestedKind = input.kind === undefined || input.kind === null
    ? (existing ? existing.kind : null)
    : input.kind;
  if (!SERIES_KINDS.includes(requestedKind)) {
    return { ok: false, code: TELEMETRY_KIND_INVALID };
  }

  if (existing) {
    if (typeof input.label === "string") existing.label = redactPresentationText(input.label);
    if (input.unit !== undefined) existing.unit = typeof input.unit === "string" ? redactPresentationText(input.unit) : null;
    if (input.metadata !== undefined) existing.metadata = sanitizeMetadata(input.metadata);
    return { ok: true, series: existing };
  }

  if (Object.keys(map).length >= DEFAULT_MAX_SERIES) {
    return { ok: false, code: TELEMETRY_SERIES_LIMIT };
  }

  const record = {
    key,
    kind: requestedKind,
    label: typeof input.label === "string" ? redactPresentationText(input.label) : "",
    unit: typeof input.unit === "string" ? redactPresentationText(input.unit) : null,
    nodeId: typeof input.nodeId === "string" ? input.nodeId : null,
    instanceId: typeof input.instanceId === "string" ? input.instanceId : null,
    metadata: sanitizeMetadata(input.metadata),
    registeredAt: normalizeRegisteredAt(input.registeredAt),
    samples: [],
  };
  map[key] = record;
  return { ok: true, series: record };
}

/**
 * Append a sample to a registered series.
 *
 * Unknown series return null and are NOT auto-created. `at` must be a
 * parseable timestamp string; invalid input returns null. The per-series ring
 * drops the oldest sample first when it overflows.
 *
 * @returns {{ at: string, value: number|null, missing: string|null } | null}
 */
function pushSample(state, key, options = {}) {
  const input = isPlainObject(options) ? options : {};
  const map = ensureSeriesMap(state);
  if (!map || typeof key !== "string") return null;
  const series = Object.prototype.hasOwnProperty.call(map, key) && isPlainObject(map[key]) ? map[key] : null;
  if (!series || !Array.isArray(series.samples)) return null;
  const sample = normalizeSample(input);
  if (!sample) return null;
  const cap = Number.isInteger(input.maxSamplesPerSeries) && input.maxSamplesPerSeries > 0
    ? input.maxSamplesPerSeries
    : DEFAULT_MAX_SAMPLES_PER_SERIES;
  series.samples.push(sample);
  while (series.samples.length > cap) series.samples.shift();
  return { ...sample };
}

/**
 * Read one series (normalized copies) with optional since/limit filtering.
 * `limit` keeps the LAST N samples after filtering. Unknown series -> null.
 */
function readSeries(state, key, options = {}) {
  const input = isPlainObject(options) ? options : {};
  const map = isPlainObject(state) && isPlainObject(state.series) ? state.series : null;
  if (!map || typeof key !== "string") return null;
  const series = Object.prototype.hasOwnProperty.call(map, key) && isPlainObject(map[key]) ? map[key] : null;
  if (!series) return null;
  const samples = applyLimit(filterSamples(series.samples, input), input.limit);
  return {
    key,
    kind: series.kind,
    label: redactPresentationText(series.label),
    unit: redactPresentationText(series.unit),
    nodeId: series.nodeId,
    instanceId: series.instanceId,
    metadata: sanitizeMetadata(series.metadata),
    samples,
  };
}

/** Metadata rows for every registered series, sorted by key. */
function listSeries(state) {
  const map = isPlainObject(state) && isPlainObject(state.series) ? state.series : null;
  if (!map) return [];
  const rows = [];
  for (const key of Object.keys(map).sort()) {
    const series = map[key];
    if (!isPlainObject(series)) continue;
    const samples = Array.isArray(series.samples) ? series.samples : [];
    rows.push({
      key,
      kind: series.kind,
      label: redactPresentationText(series.label),
      unit: redactPresentationText(series.unit),
      nodeId: series.nodeId,
      instanceId: series.instanceId,
      sampleCount: samples.length,
      firstAt: sampleTimestamp(samples[0]),
      lastAt: sampleTimestamp(samples[samples.length - 1]),
    });
  }
  return rows;
}

/**
 * Summarize a series over an optional since window.
 *
 * min/max/avg are computed over present numeric samples only; gaps count in
 * `missingCount` and never contribute 0. `staleMs` (now - latestAt) is present
 * only when the caller injects `now`. Unknown series -> null.
 */
function summarizeSeries(state, key, options = {}) {
  const input = isPlainObject(options) ? options : {};
  const map = isPlainObject(state) && isPlainObject(state.series) ? state.series : null;
  if (!map || typeof key !== "string") return null;
  const series = Object.prototype.hasOwnProperty.call(map, key) && isPlainObject(map[key]) ? map[key] : null;
  if (!series) return null;
  const samples = filterSamples(series.samples, input);

  let missingCount = 0;
  let numericCount = 0;
  let sum = 0;
  let min = null;
  let max = null;
  for (const sample of samples) {
    if (sample.missing !== null) {
      missingCount += 1;
      continue;
    }
    numericCount += 1;
    sum += sample.value;
    if (min === null || sample.value < min) min = sample.value;
    if (max === null || sample.value > max) max = sample.value;
  }

  const latest = samples.length > 0 ? samples[samples.length - 1] : null;
  const summary = {
    count: samples.length,
    missingCount,
    firstAt: samples.length > 0 ? samples[0].at : null,
    lastAt: latest ? latest.at : null,
    latestValue: latest ? latest.value : null,
    latestAt: latest ? latest.at : null,
    min,
    max,
    avg: numericCount > 0 ? sum / numericCount : null,
  };
  const now = toTime(input.now);
  if (now !== null && latest !== null) summary.staleMs = now - Date.parse(latest.at);
  return summary;
}

/**
 * Drop samples older than now - retentionMs.
 *
 * Series that end up with zero samples are KEPT registered and empty; only a
 * structurally unusable series record is removed (counted in `removedSeries`).
 * That is what keeps "this series has no samples yet" distinct from a zero.
 */
function trimToRetention(state, options = {}) {
  const input = isPlainObject(options) ? options : {};
  const result = { removedSamples: 0, removedSeries: 0 };
  const retentionMs = input.retentionMs;
  const now = toTime(input.now);
  if (!Number.isFinite(retentionMs) || retentionMs < 0 || now === null) return result;
  const map = ensureSeriesMap(state);
  if (!map) return result;

  const cutoff = now - retentionMs;
  for (const key of Object.keys(map)) {
    const series = map[key];
    if (!isPlainObject(series)) {
      delete map[key];
      result.removedSeries += 1;
      continue;
    }
    const samples = Array.isArray(series.samples) ? series.samples : [];
    const kept = [];
    for (const sample of samples) {
      const normalized = normalizeSample(sample);
      if (normalized && Date.parse(normalized.at) >= cutoff) kept.push(normalized);
      else result.removedSamples += 1;
    }
    series.samples = kept;
  }
  return result;
}

// Remove oldest samples from the series with the most samples (ties broken by
// smallest key) until the tracked byte count fits. Each shift() frees exactly
// the sample's encoded length plus one separator byte, so the fast accounting
// converges; the state is re-measured once per round to keep the loop honest
// even on repaired input.
function trimToByteBudget(state, maxFileBytes, counter) {
  let bytes = estimateStateBytes(state);
  let remaining = countSamples(state);
  while (bytes > maxFileBytes && remaining > 0) {
    const overflow = bytes - maxFileBytes;
    const key = largestSeriesKey(state);
    if (key === null) break;
    const series = state.series[key];
    let freed = 0;
    while (freed < overflow && series.samples.length > 0 && remaining > 0) {
      const sample = series.samples.shift();
      freed += encodedSampleBytes(sample);
      counter.trimmed += 1;
      remaining -= 1;
    }
    const next = estimateStateBytes(state);
    if (next >= bytes) break;
    bytes = next;
  }
  return bytes;
}

function encodedSampleBytes(sample) {
  const normalized = normalizeSample(sample);
  if (!normalized) return 1;
  return JSON.stringify(normalized).length + 1;
}

function largestSeriesKey(state) {
  const map = isPlainObject(state) && isPlainObject(state.series) ? state.series : {};
  let best = null;
  let bestCount = 0;
  for (const key of Object.keys(map)) {
    const count = seriesSampleCount(map[key]);
    if (count === 0) continue;
    if (best === null || count > bestCount || (count === bestCount && key < best)) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Enforce the hard bounds on a loaded state.
 *
 * 1. Per-series sample cap (oldest dropped first).
 * 2. Total series cap: the lowest-sampleCount series are dropped first, with
 *    a deterministic key tie-break.
 * 3. File byte budget: oldest samples are trimmed from the largest series
 *    first until the canonical size fits or no samples remain. `overBudget`
 *    reports whether the budget was unreachable (for example an absurdly small
 *    maxFileBytes); it is never hidden.
 */
function trimToLimits(state, options = {}) {
  const input = isPlainObject(options) ? options : {};
  const maxSamplesPerSeries = Number.isInteger(input.maxSamplesPerSeries) && input.maxSamplesPerSeries > 0
    ? input.maxSamplesPerSeries
    : DEFAULT_MAX_SAMPLES_PER_SERIES;
  const maxSeries = Number.isInteger(input.maxSeries) && input.maxSeries >= 0
    ? input.maxSeries
    : DEFAULT_MAX_SERIES;
  const maxFileBytes = Number.isInteger(input.maxFileBytes) && input.maxFileBytes > 0
    ? input.maxFileBytes
    : DEFAULT_MAX_FILE_BYTES;

  const result = { trimmed: 0, droppedSeries: [], bytesAfter: 0, overBudget: false };
  const map = ensureSeriesMap(state);
  if (!map) {
    result.bytesAfter = estimateStateBytes(state);
    result.overBudget = result.bytesAfter > maxFileBytes;
    return result;
  }

  for (const key of Object.keys(map)) {
    const series = map[key];
    if (!isPlainObject(series) || !Array.isArray(series.samples)) continue;
    while (series.samples.length > maxSamplesPerSeries) {
      series.samples.shift();
      result.trimmed += 1;
    }
  }

  const keys = Object.keys(map).filter((key) => isPlainObject(map[key]));
  if (keys.length > maxSeries) {
    const ranked = keys.slice().sort((a, b) => {
      const diff = seriesSampleCount(map[a]) - seriesSampleCount(map[b]);
      if (diff !== 0) return diff;
      return a < b ? -1 : a > b ? 1 : 0;
    });
    for (const key of ranked.slice(0, keys.length - maxSeries)) {
      delete map[key];
      result.droppedSeries.push(key);
    }
    result.droppedSeries.sort();
  }

  result.bytesAfter = trimToByteBudget(state, maxFileBytes, result);
  result.overBudget = result.bytesAfter > maxFileBytes;
  return result;
}

/**
 * Bounded read-only export for the future persistence/transport service.
 *
 * Never mutates state. `keys` selects series (null/omitted = all, sorted by
 * key); `since`/`to` filter samples inclusively; `generatedAt` is echoed back
 * as provided (null when the caller has no clock). Each row carries its
 * full series record and is capped at DEFAULT_MAX_SAMPLES_PER_SERIES newest
 * samples. `truncated` is true whenever the export returned less than the full
 * state (key filter, time filter, malformed entries or the sample cap).
 */
function exportSeries(state, options = {}) {
  const input = isPlainObject(options) ? options : {};
  const map = ensureSeriesMap(state);
  const keysFilter = Array.isArray(input.keys) ? new Set(input.keys) : null;
  const rows = [];
  let truncated = false;

  for (const key of map ? Object.keys(map).sort() : []) {
    const series = map[key];
    if (!isPlainObject(series)) {
      truncated = true;
      continue;
    }
    if (keysFilter && !keysFilter.has(key)) {
      truncated = true;
      continue;
    }
    const rawCount = Array.isArray(series.samples) ? series.samples.length : 0;
    const samples = filterSamples(series.samples, input);
    if (samples.length < rawCount) truncated = true;
    let bounded = samples;
    if (samples.length > DEFAULT_MAX_SAMPLES_PER_SERIES) {
      bounded = samples.slice(-DEFAULT_MAX_SAMPLES_PER_SERIES);
      truncated = true;
    }
    rows.push({
      key,
      kind: series.kind,
      label: redactPresentationText(series.label),
      unit: redactPresentationText(series.unit),
      nodeId: series.nodeId,
      instanceId: series.instanceId,
      metadata: sanitizeMetadata(series.metadata),
      registeredAt: normalizeRegisteredAt(series.registeredAt),
      samples: bounded,
    });
  }

  return {
    generatedAt: normalizeRegisteredAt(input.generatedAt),
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    series: rows,
    truncated,
  };
}

/** Canonical, deterministic JSON encoding (series keys sorted). */
function serializeState(state) {
  const map = isPlainObject(state) && isPlainObject(state.series) ? state.series : {};
  const canonical = { schemaVersion: TELEMETRY_SCHEMA_VERSION, series: {} };
  for (const key of Object.keys(map).sort()) {
    const series = map[key];
    if (!isPlainObject(series) || !SERIES_KEY_PATTERN.test(key) || !SERIES_KINDS.includes(series.kind)) continue;
    const samples = [];
    const source = Array.isArray(series.samples) ? series.samples : [];
    for (const sample of source) {
      const normalized = normalizeSample(sample);
      if (normalized) samples.push(normalized);
    }
    const bounded = samples.length > DEFAULT_MAX_SAMPLES_PER_SERIES
      ? samples.slice(-DEFAULT_MAX_SAMPLES_PER_SERIES)
      : samples;
    canonical.series[key] = {
      key,
      kind: series.kind,
      label: typeof series.label === "string" ? redactPresentationText(series.label) : "",
      unit: typeof series.unit === "string" ? redactPresentationText(series.unit) : null,
      nodeId: typeof series.nodeId === "string" ? series.nodeId : null,
      instanceId: typeof series.instanceId === "string" ? series.instanceId : null,
      metadata: sanitizeMetadata(series.metadata),
      registeredAt: normalizeRegisteredAt(series.registeredAt),
      samples: bounded,
    };
  }
  return JSON.stringify(canonical);
}

/**
 * Tolerant load. Repairs missing/mistyped fields instead of rejecting them:
 * a missing series map becomes {}, invalid keys/kind/samples are dropped, and
 * the canonical bounds (series count, per-series samples) are re-imposed.
 * Only unparseable/non-object input and a future schemaVersion fail.
 *
 * @returns {{ ok: true, state: object } | { ok: false, code: string, state: null }}
 */
function deserializeState(raw) {
  if (typeof raw !== "string") return { ok: false, code: TELEMETRY_STATE_CORRUPT, state: null };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: TELEMETRY_STATE_CORRUPT, state: null };
  }
  if (!isPlainObject(parsed)) return { ok: false, code: TELEMETRY_STATE_CORRUPT, state: null };
  if (Number.isInteger(parsed.schemaVersion) && parsed.schemaVersion > TELEMETRY_SCHEMA_VERSION) {
    return { ok: false, code: TELEMETRY_SCHEMA_UNSUPPORTED, state: null };
  }

  const state = createEmptyState();
  const source = isPlainObject(parsed.series) ? parsed.series : {};
  for (const key of Object.keys(source).sort()) {
    if (Object.keys(state.series).length >= DEFAULT_MAX_SERIES) break;
    if (!SERIES_KEY_PATTERN.test(key)) continue;
    const series = source[key];
    if (!isPlainObject(series) || !SERIES_KINDS.includes(series.kind)) continue;
    const samples = [];
    const rawSamples = Array.isArray(series.samples) ? series.samples : [];
    for (const sample of rawSamples) {
      const normalized = normalizeSample(sample);
      if (normalized) samples.push(normalized);
    }
    state.series[key] = {
      key,
      kind: series.kind,
      label: typeof series.label === "string" ? redactPresentationText(series.label) : "",
      unit: typeof series.unit === "string" ? redactPresentationText(series.unit) : null,
      nodeId: typeof series.nodeId === "string" ? series.nodeId : null,
      instanceId: typeof series.instanceId === "string" ? series.instanceId : null,
      metadata: sanitizeMetadata(series.metadata),
      registeredAt: normalizeRegisteredAt(series.registeredAt),
      samples: samples.length > DEFAULT_MAX_SAMPLES_PER_SERIES
        ? samples.slice(-DEFAULT_MAX_SAMPLES_PER_SERIES)
        : samples,
    };
  }
  return { ok: true, state };
}

/** Encoded size of the canonical serialization (the future file size). */
function estimateStateBytes(state) {
  return serializeState(state).length;
}

function normalizeKeySegment(value) {
  const text = value === null || value === undefined ? "" : String(value);
  const cleaned = text.trim().replace(KEY_SEGMENT_PATTERN, "-").replace(/^-+|-+$/g, "");
  return cleaned.length > 0 ? cleaned : "unknown";
}

function buildSeriesKey(prefix, segments) {
  const key = [prefix].concat(segments.map(normalizeKeySegment)).join(":");
  return key.length > MAX_KEY_LENGTH ? key.slice(0, MAX_KEY_LENGTH) : key;
}

// Series keys are `<prefix>:<segment>:...:<metric>`, deterministic and
// registration-safe: segments are trimmed, invalid character runs collapse to
// "-", empty or absent segments become "unknown", and the joined key is capped
// at the 181 characters SERIES_KEY_PATTERN accepts.
function hostSeriesKey(nodeId, metric) {
  return buildSeriesKey("host", [nodeId, metric]);
}

function instanceSeriesKey(nodeId, instanceId, metric) {
  return buildSeriesKey("instance", [nodeId, instanceId, metric]);
}

function endpointSeriesKey(endpointId, metric) {
  return buildSeriesKey("endpoint", [endpointId, metric]);
}

function providerSeriesKey(nodeId, providerId, metric) {
  return buildSeriesKey("provider", [nodeId, providerId, metric]);
}

module.exports = {
  TELEMETRY_SCHEMA_VERSION,
  DEFAULT_MAX_SAMPLES_PER_SERIES,
  DEFAULT_MAX_SERIES,
  DEFAULT_MAX_FILE_BYTES,
  SERIES_KINDS,
  GAP_REASONS,
  MAX_METADATA_KEYS,
  createEmptyState,
  registerSeries,
  pushSample,
  readSeries,
  listSeries,
  summarizeSeries,
  trimToRetention,
  trimToLimits,
  exportSeries,
  serializeState,
  deserializeState,
  estimateStateBytes,
  hostSeriesKey,
  instanceSeriesKey,
  endpointSeriesKey,
  providerSeriesKey,
};
