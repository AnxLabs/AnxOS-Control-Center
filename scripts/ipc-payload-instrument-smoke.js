#!/usr/bin/env node
"use strict";

// SMOOTH-3011: hermetic smoke for the opt-in IPC payload-size instrument.
//
// SOURCE OF TRUTH: the instrument was extracted out of main.js into
// `src/ipc/ipcHandlerInstrumentation.js` (so the wrapper is require-able and
// testable without Electron). This suite reads THAT module as text and executes
// the shipped measurement function from it. `main.js` now only invokes the
// module; the main.js call site is pinned separately by
// scripts/instance-snapshot-wiring-smoke.js.
//
// What this proves:
//   1. The measurement function the desktop actually ships produces an EXACT
//      byte count for known payloads (extracted from the module source and
//      executed verbatim — this is not a re-implementation copy).
//   2. The GATE is wired as claimed: `payloadBytes` is attached only inside the
//      env-gated branch, the default `{ durationMs }` record is unchanged, the
//      error path is untouched, and the live path really CALLS the measured
//      function (all asserted against the module source in phase A). Phase C then
//      exercises a test-local mirror of that wiring, so it proves the LOGIC of the
//      gate rather than the shipped bytes — the end-to-end path, a real channel
//      emitting a real payloadBytes line, remains UNVERIFIED.
//   3. The overhead of enabling the instrument, measured on a large synthetic
//      payload (10 MB string and ~10 MB object), so the cost is a printed number
//      rather than a claim. The rejected design (JSON.stringify of the whole
//      payload) is also measured here, for contrast only — it is never shipped.
//      Deliberately NOT asserted against an upper bound: a wall-clock threshold on
//      a 10 MB payload would fail on a loaded machine, which is the exact
//      timing-margin defect this project has been removing. These are observations,
//      and they are labelled machine-specific.
//
// Hermetic: reads the module as text, touches no network, no Electron, no node_modules.

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const MAIN_PATH = path.join(ROOT, "src", "ipc", "ipcHandlerInstrumentation.js");
const mainSource = fs.readFileSync(MAIN_PATH, "utf8");

const MEASURE_START = "// >>> ipc-payload-metrics:measure";
const MEASURE_END = "// <<< ipc-payload-metrics:measure";

// ---------------------------------------------------------------------------
// Extract the shipped measurement function from the instrumentation module source.
// ---------------------------------------------------------------------------
function extractMeasureFunction() {
  const start = mainSource.indexOf(MEASURE_START);
  assert.notStrictEqual(start, -1, "the instrumentation module must carry the ipc-payload-metrics:measure start marker.");
  const end = mainSource.indexOf(MEASURE_END, start);
  assert.notStrictEqual(end, -1, "the instrumentation module must carry the ipc-payload-metrics:measure end marker.");
  const block = mainSource.slice(start, end);
  assert(
    block.includes("function measureIpcPayloadBytes"),
    "The extracted block must define measureIpcPayloadBytes.",
  );
  // Execute exactly the shipped block. No transpilation, no copy.
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${block}\nreturn measureIpcPayloadBytes;`);
  const fn = factory();
  assert.strictEqual(typeof fn, "function", "Extracted measureIpcPayloadBytes must be callable.");
  return fn;
}

// ---------------------------------------------------------------------------
// Phase A: source wiring. The instrument must be gated, additive, and must not
// disturb the existing durationMs field or the error path.
// ---------------------------------------------------------------------------
function phaseSourceWiring() {
  assert(
    /const IPC_PAYLOAD_BYTES_ENABLED = process\.env\.ANXOS_IPC_BYTE_METRICS === "1";/.test(mainSource),
    "The byte instrument must be gated on ANXOS_IPC_BYTE_METRICS === \"1\".",
  );
  assert(
    mainSource.includes("if (payloadBytesEnabled) {"),
    "The gate must guard the measurement call so the default path stays unchanged.",
  );
  // ...and the gate the guard reads must BE the module-load env read. The
  // extracted wrapper takes the flag as an injectable option defaulting to that
  // constant (so both states are testable without mutating the environment); this
  // asserts the default is still bound to the env flag and has not been re-homed
  // or defaulted to a literal.
  assert(
    mainSource.includes("payloadBytesEnabled = IPC_PAYLOAD_BYTES_ENABLED,"),
    "The payload-byte gate must default to the module-load env read IPC_PAYLOAD_BYTES_ENABLED, not a literal or a call-time env read.",
  );
  assert(
    mainSource.includes("const completedContext = { durationMs: Date.now() - startedAt };"),
    "The completed record must still be built as { durationMs } exactly as before.",
  );
  assert(
    mainSource.includes("if (payloadBytes !== null) completedContext.payloadBytes = payloadBytes;"),
    "payloadBytes must only be attached when the payload was cheaply measurable.",
  );
  // The measure function must actually be CALLED on the live path. Without this,
  // extraction could keep testing a function the live path no longer calls — a
  // rewiring elsewhere would leave this suite green while the instrument emitted
  // nothing, which is the whole failure mode this file exists to prevent.
  const markerStart = mainSource.indexOf(MEASURE_START);
  const markerEnd = mainSource.indexOf(MEASURE_END);
  assert(
    markerStart !== -1 && markerEnd !== -1,
    "the instrumentation module must carry both ipc-payload-metrics markers for the call site to be checkable.",
  );
  const wiringOnly =
    mainSource.slice(0, markerStart) + mainSource.slice(markerEnd + MEASURE_END.length);
  assert(
    wiringOnly.includes("measureIpcPayloadBytes(result)"),
    "The live IPC path must call measureIpcPayloadBytes(result) OUTSIDE the extracted block; otherwise this suite tests a function the live path no longer calls.",
  );
  assert(
    mainSource.includes('"IPC request completed", completedContext,'),
    "The completed log call must pass the gated context object.",
  );
  // The error path must be untouched: no payload measurement on failure.
  assert(
    mainSource.includes('diagnostics.logError("ipc", channel, error, { durationMs: Date.now() - startedAt }, { file: "ipc", correlationId });'),
    "The IPC error record must remain exactly { durationMs }.",
  );
  assert(
    !mainSource.includes("JSON.stringify(result)") && !mainSource.includes("JSON.stringify(response)"),
    "the instrumentation module must never re-serialize an IPC result to size it.",
  );
  console.log("phase A  source wiring: ok");
}

// ---------------------------------------------------------------------------
// Phase B: exact byte counts from the shipped function.
// ---------------------------------------------------------------------------
function phaseExactCounts(measure) {
  assert.strictEqual(measure(""), 0, "Empty string must be 0 bytes.");
  assert.strictEqual(measure("hello"), 5, "\"hello\" must be 5 bytes.");
  assert.strictEqual(measure("héllo"), Buffer.byteLength("héllo", "utf8"), "Multibyte utf8 length must match Buffer.");
  assert.strictEqual(measure("héllo"), 6, "é is 2 utf8 bytes: 4 + 2 = 6.");
  assert.strictEqual(measure("x".repeat(1024)), 1024, "1024 ASCII chars must be 1024 bytes.");
  assert.strictEqual(measure("€"), 3, "The euro sign is 3 utf8 bytes.");
  assert.strictEqual(measure(Buffer.alloc(1234)), 1234, "Buffer length must be its byteLength.");
  assert.strictEqual(measure(new Uint8Array(7)), 7, "TypedArray length must be its byteLength.");
  assert.strictEqual(measure(new ArrayBuffer(8)), 8, "ArrayBuffer length must be its byteLength.");
  assert.strictEqual(measure(new DataView(new ArrayBuffer(16))), 16, "DataView length must be its byteLength.");

  // Non-measurable payloads are skipped rather than serialized.
  assert.strictEqual(measure({ any: "object" }), null, "Objects must be skipped (null).");
  assert.strictEqual(measure([1, 2, 3]), null, "Arrays must be skipped (null).");
  assert.strictEqual(measure(42), null, "Numbers must be skipped (null).");
  assert.strictEqual(measure(null), null, "Null must be skipped (null).");
  assert.strictEqual(measure(undefined), null, "Undefined must be skipped (null).");
  console.log("phase B  exact byte counts: ok");
}

// ---------------------------------------------------------------------------
// Phase C: absence semantics. Rebuild the completed context exactly the way
// the shipped wrapper does, for gate off and gate on.
// ---------------------------------------------------------------------------
function buildCompletedContext(measure, enabled, result, durationMs) {
  const completedContext = { durationMs };
  if (enabled) {
    const payloadBytes = measure(result);
    if (payloadBytes !== null) completedContext.payloadBytes = payloadBytes;
  }
  return completedContext;
}

function phaseAbsenceSemantics(measure) {
  const disabled = buildCompletedContext(measure, false, "a".repeat(500), 12);
  assert.deepStrictEqual(disabled, { durationMs: 12 }, "Gate off: context must be byte-identical to the pre-change shape.");
  assert(!("payloadBytes" in disabled), "Gate off: payloadBytes must be absent, not null.");
  assert.strictEqual(disabled.durationMs, 12, "Gate off: durationMs must be preserved.");

  const enabledString = buildCompletedContext(measure, true, "a".repeat(500), 12);
  assert.deepStrictEqual(enabledString, { durationMs: 12, payloadBytes: 500 }, "Gate on + string: exact count attached.");
  assert.strictEqual(enabledString.durationMs, 12, "Gate on: durationMs must still be present and unchanged.");

  const enabledObject = buildCompletedContext(measure, true, { big: "x".repeat(10000) }, 12);
  assert.deepStrictEqual(enabledObject, { durationMs: 12 }, "Gate on + object: skipped payloads add no field.");

  console.log("phase C  absence semantics: ok");
}

// ---------------------------------------------------------------------------
// Phase D: measured overhead on large synthetic payloads.
// ---------------------------------------------------------------------------
function timeMs(fn, iterations) {
  // Warm up, then measure the median-ish best of a few runs to reduce noise.
  for (let i = 0; i < 3; i += 1) fn();
  let best = Infinity;
  for (let run = 0; run < 5; run += 1) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i += 1) fn();
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    best = Math.min(best, elapsed / iterations);
  }
  return best;
}

function buildLargeObject() {
  // ~10 MB when serialized, shaped like an instance snapshot.
  return {
    items: Array.from({ length: 90000 }, (_, i) => ({
      id: `inst-${i}`,
      name: `Instance ${i}`,
      tags: ["alpha", "beta", "gamma"],
      state: "online",
      path: `C:/x/y/z/${i}`,
    })),
  };
}

function phaseOverhead(measure) {
  const ITER = 20;
  const bigString = "x".repeat(10 * 1024 * 1024);
  const bigObject = buildLargeObject();

  const stringBytes = Buffer.byteLength(bigString, "utf8");
  const objectJsonBytes = Buffer.byteLength(JSON.stringify(bigObject), "utf8");
  assert(stringBytes === 10485760, "Synthetic string must be exactly 10 MiB.");
  assert(objectJsonBytes > 9 * 1024 * 1024, "Synthetic object must serialize to roughly 10 MB.");

  const disabledCost = timeMs(() => ({ durationMs: 1 }), ITER * 50);
  const enabledStringCost = timeMs(() => measure(bigString), ITER);
  const enabledObjectCost = timeMs(() => measure(bigObject), ITER);
  // Rejected design, measured here only to justify skipping objects. Never shipped.
  const rejectedJsonStringifyCost = timeMs(() => JSON.stringify(bigObject).length, 3);

  const fmt = (n) => n.toFixed(4);
  console.log("phase D  measured overhead (this machine, process.hrtime, best of 5 runs):");
  console.log(`         payload                            bytes         cost (ms/call)`);
  console.log(`         10 MiB string (gate on)            ${String(stringBytes).padEnd(13)} ${fmt(enabledStringCost)}`);
  console.log(`         ~10 MB object (gate on, skipped)   ${String(objectJsonBytes).padEnd(13)} ${fmt(enabledObjectCost)}`);
  console.log(`         baseline context build (gate off)  ${"-".padEnd(13)} ${fmt(disabledCost)}`);
  console.log(`         REJECTED: JSON.stringify(object)   ${String(objectJsonBytes).padEnd(13)} ${fmt(rejectedJsonStringifyCost)}`);
  console.log(`         -> enabled-vs-disabled delta on a 10 MiB string: ${fmt(enabledStringCost - disabledCost)} ms/call`);
  console.log(`         -> rejected re-serialization is ${(rejectedJsonStringifyCost / Math.max(enabledStringCost, 1e-9)).toFixed(1)}x the shipped string path`);

  // The skip path must be effectively free relative to the payload it avoids.
  assert(
    enabledObjectCost < rejectedJsonStringifyCost / 4,
    "Skipping an object must be far cheaper than serializing it, or the design is not worth it.",
  );
  console.log("phase D  overhead measured: ok");
}

function main() {
  console.log("ipc-payload-instrument-smoke: IPC payload-size instrument (src/ipc/ipcHandlerInstrumentation.js)");
  const measure = extractMeasureFunction();
  phaseSourceWiring();
  phaseExactCounts(measure);
  phaseAbsenceSemantics(measure);
  phaseOverhead(measure);
  console.log("ipc-payload-instrument-smoke passed");
}

main();