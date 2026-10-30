const assert = require("assert");
const {
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
} = require("../src/shared/telemetryStore");

function isoAt(index) {
  return new Date(Date.UTC(2026, 8, 28, 0, 0, 0) + index * 60000).toISOString();
}

// Frozen constants and documented bounds.
assert.strictEqual(TELEMETRY_SCHEMA_VERSION, 1, "schema version starts at 1");
assert.strictEqual(DEFAULT_MAX_SAMPLES_PER_SERIES, 6000, "per-series ring holds roughly seven days at two-minute sampling");
assert.strictEqual(DEFAULT_MAX_SERIES, 256, "series cap");
assert.strictEqual(DEFAULT_MAX_FILE_BYTES, 32 * 1024 * 1024, "file byte cap");
assert.strictEqual(MAX_METADATA_KEYS, 12, "metadata key cap");
assert.ok(Object.isFrozen(SERIES_KINDS) && Object.isFrozen(GAP_REASONS), "kind and gap enums must be frozen");
assert.deepStrictEqual([...SERIES_KINDS], ["host", "node", "instance", "endpoint", "provider"]);
assert.deepStrictEqual([...GAP_REASONS], ["collector-failed", "not-running", "timeout", "unsupported", "unknown"]);

const state = createEmptyState();
assert.deepStrictEqual(state, { schemaVersion: TELEMETRY_SCHEMA_VERSION, series: {} }, "empty state shape");

// Register / push / read round trip.
const registered = registerSeries(state, {
  key: "host:node-a:cpu",
  kind: "host",
  label: "CPU",
  unit: "percent",
  nodeId: "node-a",
  metadata: { zone: "yyc", tier: 1 },
  registeredAt: "2026-09-28T00:00:00.000Z",
});
assert.strictEqual(registered.ok, true, "valid registration succeeds");
assert.deepStrictEqual(registered.series.samples, [], "a new series starts empty");
assert.deepStrictEqual(registered.series.metadata, { tier: 1, zone: "yyc" }, "metadata is sanitized and key-sorted");

assert.strictEqual(pushSample(state, "host:node-a:cpu", { at: isoAt(0), value: 12.5 }).value, 12.5);
const zeroSample = pushSample(state, "host:node-a:cpu", { at: isoAt(1), value: 0 });
assert.strictEqual(zeroSample.value, 0, "zero survives as a present value");
assert.strictEqual(zeroSample.missing, null, "a present value never carries a gap reason");

const roundTrip = readSeries(state, "host:node-a:cpu");
assert.strictEqual(roundTrip.label, "CPU");
assert.strictEqual(roundTrip.unit, "percent");
assert.strictEqual(roundTrip.nodeId, "node-a");
assert.strictEqual(roundTrip.instanceId, null);
assert.strictEqual(roundTrip.samples.length, 2);
assert.deepStrictEqual(roundTrip.samples[0], { at: isoAt(0), value: 12.5, missing: null });

registerSeries(state, { key: "host:node-a:cpu", kind: "host", label: "CPU load", metadata: { tier: 2 } });
const afterReRegister = readSeries(state, "host:node-a:cpu");
assert.strictEqual(afterReRegister.samples.length, 2, "re-registration must not clear samples");
assert.strictEqual(afterReRegister.label, "CPU load", "re-registration updates the label");
assert.strictEqual(afterReRegister.kind, "host", "re-registration keeps identity fields");

// Invalid keys and kinds are rejected; unknown series are never auto-created.
assert.deepStrictEqual(
  registerSeries(state, { key: "no spaces here", kind: "host" }),
  { ok: false, code: "TELEMETRY_SERIES_KEY_INVALID" },
);
assert.strictEqual(registerSeries(state, { key: "ab", kind: "host" }).code, "TELEMETRY_SERIES_KEY_INVALID", "keys shorter than three characters are rejected");
assert.deepStrictEqual(
  registerSeries(state, { key: "host:node-a:disk", kind: "database" }),
  { ok: false, code: "TELEMETRY_KIND_INVALID" },
);
assert.strictEqual(pushSample(state, "host:node-z:missing", { at: isoAt(0), value: 1 }), null, "pushing an unknown series returns null");
assert.strictEqual(readSeries(state, "host:node-z:missing"), null);
assert.ok(!Object.prototype.hasOwnProperty.call(state.series, "host:node-z:missing"), "unknown series are never auto-created");
assert.strictEqual(pushSample(state, "host:node-a:cpu", { at: "not-a-time", value: 4 }), null, "invalid timestamps are rejected");
assert.strictEqual(readSeries(state, "host:node-a:cpu").samples.length, 2, "a rejected push leaves the series unchanged");

// Registration limit: the cap is enforced and re-registration is still allowed.
const limited = createEmptyState();
for (let index = 0; index < DEFAULT_MAX_SERIES; index += 1) {
  assert.strictEqual(registerSeries(limited, { key: `host:node-${index}:cpu`, kind: "host" }).ok, true);
}
assert.deepStrictEqual(
  registerSeries(limited, { key: "host:node-overflow:cpu", kind: "host" }),
  { ok: false, code: "TELEMETRY_SERIES_LIMIT" },
);
assert.strictEqual(registerSeries(limited, { key: "host:node-0:cpu", kind: "host", label: "kept" }).ok, true, "re-registering an existing key is allowed at the cap");

// Ring behavior: oldest samples are dropped first.
const ring = createEmptyState();
assert.strictEqual(registerSeries(ring, { key: "instance:node-r:instance-1:latency", kind: "instance" }).ok, true);
for (let index = 0; index < 5; index += 1) {
  pushSample(ring, "instance:node-r:instance-1:latency", { at: isoAt(index), value: index, maxSamplesPerSeries: 5 });
}
const firstBefore = listSeries(ring)[0].firstAt;
for (let index = 5; index < 8; index += 1) {
  pushSample(ring, "instance:node-r:instance-1:latency", { at: isoAt(index), value: index, maxSamplesPerSeries: 5 });
}
const ringView = readSeries(ring, "instance:node-r:instance-1:latency");
assert.strictEqual(ringView.samples.length, 5, "the ring cap holds the series at five samples");
assert.strictEqual(ringView.samples[0].value, 3, "oldest samples are dropped first");
assert.strictEqual(ringView.samples[4].value, 7, "the newest sample survives");
const ringRow = listSeries(ring)[0];
assert.strictEqual(ringRow.sampleCount, 5);
assert.notStrictEqual(ringRow.firstAt, firstBefore, "firstAt advances as the ring overflows");
assert.ok(Date.parse(ringRow.firstAt) > Date.parse(firstBefore));
assert.strictEqual(ringRow.lastAt, isoAt(7));

// Missing vs zero: gaps never contribute 0 to statistics.
const gaps = createEmptyState();
registerSeries(gaps, { key: "host:node-b:memory", kind: "host" });
pushSample(gaps, "host:node-b:memory", { at: isoAt(0), value: 1 });
pushSample(gaps, "host:node-b:memory", { at: isoAt(1), value: null, missing: "timeout" });
pushSample(gaps, "host:node-b:memory", { at: isoAt(2), value: 3 });
const mixed = summarizeSeries(gaps, "host:node-b:memory");
assert.strictEqual(mixed.count, 3);
assert.strictEqual(mixed.missingCount, 1);
assert.strictEqual(mixed.avg, 2, "gaps must not contribute zero to the average");
assert.strictEqual(mixed.min, 1);
assert.strictEqual(mixed.max, 3);
assert.strictEqual(mixed.latestValue, 3);
assert.strictEqual(mixed.latestAt, isoAt(2));
assert.strictEqual(mixed.firstAt, isoAt(0));
assert.strictEqual(mixed.lastAt, isoAt(2));

pushSample(gaps, "host:node-b:memory", { at: isoAt(3), value: null, missing: "bogus" });
pushSample(gaps, "host:node-b:memory", { at: isoAt(4), value: null });
const reasonView = readSeries(gaps, "host:node-b:memory");
assert.strictEqual(reasonView.samples[3].missing, "unknown", "invalid gap reasons are coerced to unknown");
assert.strictEqual(reasonView.samples[4].missing, "unknown", "a null value with no reason becomes unknown");
assert.strictEqual(reasonView.samples[4].value, null);

const dark = createEmptyState();
registerSeries(dark, { key: "endpoint:db-a:reachable", kind: "endpoint" });
for (let index = 0; index < 4; index += 1) {
  pushSample(dark, "endpoint:db-a:reachable", { at: isoAt(index), value: null, missing: "not-running" });
}
const darkSummary = summarizeSeries(dark, "endpoint:db-a:reachable");
assert.strictEqual(darkSummary.count, 4);
assert.strictEqual(darkSummary.missingCount, 4);
assert.strictEqual(darkSummary.avg, null, "an all-missing series has no average");
assert.notStrictEqual(darkSummary.avg, 0, "an all-missing series must never summarize as zero");
assert.strictEqual(darkSummary.min, null);
assert.strictEqual(darkSummary.max, null);
assert.strictEqual(darkSummary.latestValue, null);

const never = createEmptyState();
registerSeries(never, { key: "provider:node-c:openai:latency", kind: "provider" });
assert.deepStrictEqual(
  summarizeSeries(never, "provider:node-c:openai:latency"),
  { count: 0, missingCount: 0, firstAt: null, lastAt: null, latestValue: null, latestAt: null, min: null, max: null, avg: null },
  "an empty series is distinguishable from an all-missing one",
);

const stale = summarizeSeries(gaps, "host:node-b:memory", { now: isoAt(5) });
assert.strictEqual(stale.staleMs, 60000, "staleMs uses the injected now");
assert.strictEqual(summarizeSeries(gaps, "host:node-b:memory").staleMs, undefined, "staleMs appears only when now is injected");

// readSeries filtering by since and limit.
assert.deepStrictEqual(
  readSeries(gaps, "host:node-b:memory", { since: isoAt(2) }).samples.map((sample) => sample.at),
  [isoAt(2), isoAt(3), isoAt(4)],
);
assert.deepStrictEqual(
  readSeries(gaps, "host:node-b:memory", { limit: 2 }).samples.map((sample) => sample.at),
  [isoAt(3), isoAt(4)],
  "limit keeps the last N samples after filtering",
);
assert.deepStrictEqual(readSeries(gaps, "host:node-b:memory", { limit: 0 }).samples, [], "limit 0 returns no samples");

// trimToRetention: injected now, boundary inclusive, emptied series kept.
const retention = createEmptyState();
registerSeries(retention, { key: "host:node-c:cpu", kind: "host" });
registerSeries(retention, { key: "host:node-c:memory", kind: "host" });
registerSeries(retention, { key: "host:node-c:disk", kind: "host" });
pushSample(retention, "host:node-c:cpu", { at: "2026-09-26T00:00:00.000Z", value: 1 });
pushSample(retention, "host:node-c:cpu", { at: "2026-09-27T00:00:00.000Z", value: 2 });
pushSample(retention, "host:node-c:memory", { at: "2026-09-26T12:00:00.000Z", value: 3 });
const retentionResult = trimToRetention(retention, { retentionMs: 24 * 60 * 60 * 1000, now: "2026-09-28T00:00:00.000Z" });
assert.strictEqual(retentionResult.removedSamples, 2, "samples older than the cutoff are dropped");
assert.strictEqual(retentionResult.removedSeries, 0, "emptied series are kept, not removed");
assert.strictEqual(readSeries(retention, "host:node-c:cpu").samples.length, 1, "the sample exactly at the cutoff survives");
assert.strictEqual(readSeries(retention, "host:node-c:memory").samples.length, 0);
const memoryRow = listSeries(retention).find((row) => row.key === "host:node-c:memory");
assert.strictEqual(memoryRow.sampleCount, 0, "an emptied series stays registered and empty");
assert.strictEqual(memoryRow.firstAt, null);
const diskRow = listSeries(retention).find((row) => row.key === "host:node-c:disk");
assert.strictEqual(diskRow.sampleCount, 0, "a never-sampled series looks the same as an emptied one");
assert.deepStrictEqual(
  trimToRetention(retention, { retentionMs: -1, now: "2026-09-28T00:00:00.000Z" }),
  { removedSamples: 0, removedSeries: 0 },
  "an invalid retention window is a no-op",
);

// trimToLimits: series cap drops lowest sample counts first, then per-series caps.
const limits = createEmptyState();
const sampleCounts = { "host:n1:cpu": 1, "host:n2:cpu": 3, "host:n3:cpu": 2, "host:n4:cpu": 5 };
for (const [key, count] of Object.entries(sampleCounts)) {
  assert.strictEqual(registerSeries(limits, { key, kind: "host" }).ok, true);
  for (let index = 0; index < count; index += 1) pushSample(limits, key, { at: isoAt(index), value: index });
}
const seriesCap = trimToLimits(limits, { maxSeries: 2 });
assert.deepStrictEqual(seriesCap.droppedSeries, ["host:n1:cpu", "host:n3:cpu"], "series cap drops the lowest sample counts first, tie-broken by key");
assert.deepStrictEqual(Object.keys(limits.series).sort(), ["host:n2:cpu", "host:n4:cpu"], "the two series with the most samples survive");
assert.strictEqual(seriesCap.trimmed, 0, "series-cap trimming removes whole series, not samples");

const perSeriesCap = trimToLimits(limits, { maxSeries: 2, maxSamplesPerSeries: 2 });
assert.strictEqual(perSeriesCap.trimmed, 4, "per-series caps drop the oldest samples");
assert.strictEqual(readSeries(limits, "host:n2:cpu").samples.length, 2);
assert.strictEqual(readSeries(limits, "host:n4:cpu").samples.length, 2);
assert.strictEqual(readSeries(limits, "host:n4:cpu").samples[1].value, 4, "newest samples survive per-series trimming");

// trimToLimits: byte budget trims oldest samples across the largest series.
const bytes = createEmptyState();
registerSeries(bytes, { key: "host:n9:cpu", kind: "host" });
for (let index = 0; index < 20; index += 1) pushSample(bytes, "host:n9:cpu", { at: isoAt(index), value: index });
const fullBytes = estimateStateBytes(bytes);
const budget = Math.floor(fullBytes / 2);
const byteResult = trimToLimits(bytes, { maxFileBytes: budget });
assert.ok(byteResult.bytesAfter <= budget, "byte trimming reaches the budget");
assert.strictEqual(byteResult.overBudget, false);
assert.ok(byteResult.trimmed > 0, "byte trimming removed samples");
const bytesView = readSeries(bytes, "host:n9:cpu");
assert.ok(bytesView.samples.length > 0, "byte trimming keeps the newest history it can afford");
assert.strictEqual(bytesView.samples[bytesView.samples.length - 1].value, 19, "the newest sample survives byte trimming");
assert.strictEqual(byteResult.bytesAfter, estimateStateBytes(bytes), "bytesAfter matches the trimmed state");

const impossible = createEmptyState();
registerSeries(impossible, { key: "host:n9:cpu", kind: "host" });
pushSample(impossible, "host:n9:cpu", { at: isoAt(0), value: 1 });
const impossibleResult = trimToLimits(impossible, { maxFileBytes: 1 });
assert.strictEqual(impossibleResult.overBudget, true, "an unreachable byte budget is reported, not hidden");
assert.strictEqual(readSeries(impossible, "host:n9:cpu").samples.length, 0, "byte trimming stops when no samples remain");
assert.strictEqual(Object.keys(impossible.series).length, 1, "the registered series survives byte trimming");

// Serialize / deserialize round trip and repairs.
const persisted = createEmptyState();
registerSeries(persisted, {
  key: "provider:node-a:openai:latency",
  kind: "provider",
  label: "OpenAI latency",
  unit: "ms",
  nodeId: "node-a",
  metadata: { region: "yyc" },
  registeredAt: "2026-09-28T00:00:00.000Z",
});
pushSample(persisted, "provider:node-a:openai:latency", { at: isoAt(0), value: 0 });
pushSample(persisted, "provider:node-a:openai:latency", { at: isoAt(1), value: null, missing: "collector-failed" });
const decoded = deserializeState(serializeState(persisted));
assert.strictEqual(decoded.ok, true, "a serialized state round-trips");
assert.deepStrictEqual(decoded.state, persisted, "round trip is deep-equal");

const orderedA = createEmptyState();
registerSeries(orderedA, { key: "host:z:cpu", kind: "host" });
registerSeries(orderedA, { key: "host:a:cpu", kind: "host" });
const orderedB = createEmptyState();
registerSeries(orderedB, { key: "host:a:cpu", kind: "host" });
registerSeries(orderedB, { key: "host:z:cpu", kind: "host" });
assert.strictEqual(serializeState(orderedA), serializeState(orderedB), "serialization sorts series keys");

assert.deepStrictEqual(deserializeState("{not json"), { ok: false, code: "TELEMETRY_STATE_CORRUPT", state: null });
assert.deepStrictEqual(deserializeState("42"), { ok: false, code: "TELEMETRY_STATE_CORRUPT", state: null });
assert.deepStrictEqual(deserializeState(null), { ok: false, code: "TELEMETRY_STATE_CORRUPT", state: null });
assert.deepStrictEqual(
  deserializeState(JSON.stringify({ schemaVersion: TELEMETRY_SCHEMA_VERSION + 1, series: {} })),
  { ok: false, code: "TELEMETRY_SCHEMA_UNSUPPORTED", state: null },
  "a future schema version is refused rather than misread",
);

const repairedMissingSeries = deserializeState(JSON.stringify({ schemaVersion: TELEMETRY_SCHEMA_VERSION }));
assert.strictEqual(repairedMissingSeries.ok, true);
assert.deepStrictEqual(repairedMissingSeries.state, createEmptyState(), "a state missing its series map is repaired");

const repaired = deserializeState(JSON.stringify({
  schemaVersion: "one",
  series: {
    "host:repair:cpu": {
      kind: "host",
      label: 7,
      unit: "percent",
      metadata: { keep: "yes", nested: { a: 1 }, count: 2 },
      samples: [
        { at: isoAt(0), value: "not-a-number" },
        { at: "invalid", value: 3 },
        { at: isoAt(1), value: 5 },
        "junk",
      ],
    },
    "bad key": { kind: "host" },
    "host:repair:disk": { kind: "not-a-kind", samples: [] },
  },
}));
assert.strictEqual(repaired.ok, true, "a partial state is repaired, not rejected");
assert.strictEqual(repaired.state.schemaVersion, TELEMETRY_SCHEMA_VERSION, "a mistyped schema version is repaired");
assert.strictEqual(repaired.state.series["host:repair:cpu"].label, "", "a mistyped label is repaired");
assert.strictEqual(repaired.state.series["host:repair:cpu"].unit, "percent");
assert.deepStrictEqual(repaired.state.series["host:repair:cpu"].metadata, { count: 2, keep: "yes" }, "metadata keeps only bounded primitive entries");
assert.deepStrictEqual(repaired.state.series["host:repair:cpu"].samples, [
  { at: isoAt(0), value: null, missing: "unknown" },
  { at: isoAt(1), value: 5, missing: null },
], "samples are normalized and invalid entries dropped");
assert.strictEqual(repaired.state.series["bad key"], undefined, "invalid keys are dropped");
assert.strictEqual(repaired.state.series["host:repair:disk"], undefined, "series with unknown kinds are dropped");

// Sensitive metadata keys: a credential-named key is redacted by key even when
// its value does not look secret-shaped. The raw fixture carries both markers,
// so the leak scan below can actually see them (negative control).
const rawSecretFixture = JSON.stringify({ authToken: "X", note: "Bearer abc" });
assert.ok(rawSecretFixture.includes('"X"') && rawSecretFixture.includes("abc"), "negative control: the raw fixture must contain both markers");

const secretNamed = createEmptyState();
registerSeries(secretNamed, {
  key: "host:node-d:cpu",
  kind: "host",
  metadata: { authToken: "X", note: "Bearer abc", zone: "yyc" },
});
assert.deepStrictEqual(
  secretNamed.series["host:node-d:cpu"].metadata,
  { authToken: "[redacted]", note: "Bearer [redacted]", zone: "yyc" },
  "a secret-named key is redacted while non-secret keys keep their values",
);

const secretRead = readSeries(secretNamed, "host:node-d:cpu");
assert.strictEqual(secretRead.metadata.authToken, "[redacted]");
assert.ok(!secretRead.metadata.authToken.includes("X"), "the raw secret-named value must not survive a read");
assert.ok(!secretRead.metadata.note.includes("abc"), "the bearer value must not survive a read");
assert.strictEqual(secretRead.metadata.zone, "yyc", "non-secret metadata keeps its value on read");

const secretSerialized = serializeState(secretNamed);
assert.ok(!secretSerialized.includes('"X"'), "serializeState must not contain the raw secret-named value");
assert.ok(!secretSerialized.includes("abc"), "serializeState must not contain the bearer value");
assert.ok(secretSerialized.includes('"zone":"yyc"'), "non-secret metadata survives serialization");

const secretExported = exportSeries(secretNamed, {});
const secretExportText = JSON.stringify(secretExported);
assert.ok(!secretExportText.includes('"X"'), "exportSeries must not contain the raw secret-named value");
assert.ok(!secretExportText.includes("abc"), "exportSeries must not contain the bearer value");
assert.strictEqual(secretExported.series[0].metadata.authToken, "[redacted]");
assert.strictEqual(secretExported.series[0].metadata.zone, "yyc", "non-secret metadata keeps its value on export");

const secretLoaded = deserializeState(JSON.stringify({
  schemaVersion: TELEMETRY_SCHEMA_VERSION,
  series: {
    "host:node-l:cpu": {
      kind: "host",
      metadata: { authToken: "X", note: "Bearer abc", zone: "yyc" },
      samples: [],
    },
  },
}));
assert.strictEqual(secretLoaded.ok, true);
assert.strictEqual(secretLoaded.state.series["host:node-l:cpu"].metadata.authToken, "[redacted]", "a loaded secret-named key is redacted");
assert.strictEqual(secretLoaded.state.series["host:node-l:cpu"].metadata.zone, "yyc", "non-secret metadata keeps its value on load");

// exportSeries: filtering, pass-through generatedAt and bounded truncation.
const exported = createEmptyState();
registerSeries(exported, { key: "host:x:cpu", kind: "host" });
registerSeries(exported, { key: "host:x:memory", kind: "host" });
for (let index = 0; index < 4; index += 1) pushSample(exported, "host:x:cpu", { at: isoAt(index), value: index });
pushSample(exported, "host:x:memory", { at: isoAt(1), value: 9 });

const fullExport = exportSeries(exported, {});
assert.strictEqual(fullExport.schemaVersion, TELEMETRY_SCHEMA_VERSION);
assert.strictEqual(fullExport.generatedAt, null, "generatedAt stays null unless the caller injects it");
assert.strictEqual(fullExport.truncated, false);
assert.deepStrictEqual(fullExport.series.map((series) => series.key), ["host:x:cpu", "host:x:memory"], "exports are sorted by key");

const windowExport = exportSeries(exported, { keys: ["host:x:cpu"], since: isoAt(1), to: isoAt(2) });
assert.deepStrictEqual(windowExport.series.map((series) => series.key), ["host:x:cpu"]);
assert.deepStrictEqual(windowExport.series[0].samples.map((sample) => sample.value), [1, 2], "since/to filter inclusively");
assert.strictEqual(windowExport.truncated, true, "a filtered export is marked truncated");

const stampedExport = exportSeries(exported, { generatedAt: isoAt(9) });
assert.strictEqual(stampedExport.generatedAt, isoAt(9), "generatedAt is passed through when injected");
assert.strictEqual(stampedExport.truncated, false);

const bigExportSource = createEmptyState();
registerSeries(bigExportSource, { key: "host:big:cpu", kind: "host" });
for (let index = 0; index < DEFAULT_MAX_SAMPLES_PER_SERIES + 2; index += 1) {
  pushSample(bigExportSource, "host:big:cpu", { at: isoAt(index), value: index, maxSamplesPerSeries: DEFAULT_MAX_SAMPLES_PER_SERIES + 2 });
}
const bigExport = exportSeries(bigExportSource, {});
assert.strictEqual(bigExport.series[0].samples.length, DEFAULT_MAX_SAMPLES_PER_SERIES, "exports are bounded to the default per-series cap");
assert.strictEqual(bigExport.series[0].samples[0].value, 2, "the oldest samples are the ones dropped");
assert.strictEqual(bigExport.series[0].samples[DEFAULT_MAX_SAMPLES_PER_SERIES - 1].value, DEFAULT_MAX_SAMPLES_PER_SERIES + 1);
assert.strictEqual(bigExport.truncated, true, "a bounded export is marked truncated");

// Key helpers: deterministic, character-safe, registration-safe.
assert.strictEqual(hostSeriesKey("node-a", "cpu"), "host:node-a:cpu");
assert.strictEqual(instanceSeriesKey("node-a", "instance-1", "latency"), "instance:node-a:instance-1:latency");
assert.strictEqual(endpointSeriesKey("node-a", "db-a", "reachable"), "endpoint:node-a:db-a:reachable");
assert.notStrictEqual(endpointSeriesKey("node-a", "db-a", "reachable"), endpointSeriesKey("node-b", "db-a", "reachable"), "endpoint series are per node");
// PR #9 final review: distinct endpoint ids never share a series, whatever
// characters or length they use; key-safe ids (generated ep-<hex>) stay readable.
{
  const collisionSets = [
    ["ep/a", "ep?a", "ep a", "ep-a"],
    ["", "unknown"],
    ["h-x", "h-X"],
    ["-lead", "lead"],
    ["trail-", "trail"],
    [`ep-${"x".repeat(200)}-1`, `ep-${"x".repeat(200)}-2`],
  ];
  const registrations = createEmptyState();
  for (const ids of collisionSets) {
    const keys = ids.map((id) => endpointSeriesKey("node-a", id, "available"));
    assert.strictEqual(new Set(keys).size, ids.length, `distinct endpoint ids get distinct series: ${JSON.stringify(ids)}`);
    for (const key of keys) {
      assert.strictEqual(registerSeries(registrations, { key, kind: "endpoint" }).ok, true, `encoded key registers as a valid series key: ${key}`);
    }
  }
  // An id spelled exactly like another id's encoded segment never takes over
  // that series (the "h-" marker is reserved for encoded ids).
  const encodedSegment = endpointSeriesKey("node-a", "ep/a", "available").split(":")[2];
  assert.ok(encodedSegment.startsWith("h-"), "a non-key-safe id is encoded");
  assert.notStrictEqual(endpointSeriesKey("node-a", encodedSegment, "available"), endpointSeriesKey("node-a", "ep/a", "available"),
    "an id that looks like an encoded segment gets its own series");
  assert.strictEqual(endpointSeriesKey("node-a", "ep-0123abcdef", "available"), "endpoint:node-a:ep-0123abcdef:available", "generated ids stay readable");
  assert.strictEqual(endpointSeriesKey("node-a", "ep/a", "available"), endpointSeriesKey("node-a", "ep/a", "available"), "the encoding is deterministic");
}
assert.strictEqual(providerSeriesKey("node-a", "openai", "latency"), "provider:node-a:openai:latency");

const messy = hostSeriesKey("Node A!!", "cpu %");
assert.strictEqual(messy, hostSeriesKey("Node A!!", "cpu %"), "key helpers are deterministic");
assert.match(messy, /^[a-z0-9][a-z0-9:._-]{2,180}$/i, "sanitized keys stay registration-safe");
assert.strictEqual(registerSeries(createEmptyState(), { key: messy, kind: "host" }).ok, true, "sanitized keys register cleanly");

const longKey = hostSeriesKey("x".repeat(400), "y".repeat(400));
assert.ok(longKey.length <= 181, "long segments are truncated to the maximum key length");
assert.match(longKey, /^[a-z0-9][a-z0-9:._-]{2,180}$/i);
assert.strictEqual(registerSeries(createEmptyState(), { key: longKey, kind: "host" }).ok, true);

assert.strictEqual(hostSeriesKey(null, undefined), "host:unknown:unknown", "absent segments become a deterministic placeholder");

// estimateStateBytes grows with samples and matches the canonical encoding.
const sized = createEmptyState();
registerSeries(sized, { key: "host:size:cpu", kind: "host" });
const sizeEmpty = estimateStateBytes(sized);
pushSample(sized, "host:size:cpu", { at: isoAt(0), value: 1 });
const sizeOne = estimateStateBytes(sized);
pushSample(sized, "host:size:cpu", { at: isoAt(1), value: 2 });
const sizeTwo = estimateStateBytes(sized);
assert.ok(Number.isInteger(sizeEmpty) && sizeEmpty > 0, "estimates are integers");
assert.ok(sizeOne > sizeEmpty, "a sample increases the encoded size");
assert.ok(sizeTwo > sizeOne);
assert.strictEqual(sizeTwo, serializeState(sized).length, "estimateStateBytes is the canonical JSON length");

console.log("Telemetry store smoke passed.");
