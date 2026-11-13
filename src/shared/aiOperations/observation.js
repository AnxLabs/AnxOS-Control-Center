"use strict";

// Phase X: one fact the assistant may show or reason about.
//
// Every observation names where it came from (source), what it describes
// (target, by stable ids), when it was measured and how fresh it is. The
// assistant never shows a value without this envelope, so a cached or stale
// reading can never be presented as live, and missing data is "unavailable",
// never zero.

const { redactString } = require("../redaction");

const FRESHNESS = Object.freeze(["live", "cached", "stale", "unavailable"]);
const KINDS = Object.freeze(["measurement", "inferred", "verified"]);

// A reading younger than this is "live"; up to STALE_AFTER_MS it is "cached";
// older is "stale". Tuned to the app's own polling (5 s heartbeat, 15 s
// freshness rule on My Servers).
const LIVE_WINDOW_MS = 30 * 1000;
const STALE_AFTER_MS = 5 * 60 * 1000;
const MAX_UNTRUSTED_TEXT = 400;

function toTime(value) {
  if (value === null || value === undefined || value === "") return null;
  const time = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(time) ? time : null;
}

function classifyFreshness(observedAt, now = Date.now(), { liveWindowMs = LIVE_WINDOW_MS, staleAfterMs = STALE_AFTER_MS, reportedStale = false } = {}) {
  const time = toTime(observedAt);
  if (time === null) return "unavailable";
  const age = Math.max(0, now - time);
  if (reportedStale || age > staleAfterMs) return "stale";
  return age <= liveWindowMs ? "live" : "cached";
}

function cleanTarget(target = {}) {
  const out = {};
  for (const key of ["nodeId", "instanceId", "container"]) {
    if (typeof target[key] === "string" && target[key].trim()) out[key] = target[key].trim().slice(0, 160);
  }
  if (typeof target.label === "string" && target.label.trim()) out.label = redactString(target.label.trim()).slice(0, 120);
  return out;
}

function makeObservation({ source, target = {}, observedAt = null, freshness = null, kind = "measurement", label, value = null, unit = null, note = null, now = Date.now(), reportedStale = false } = {}) {
  if (typeof source !== "string" || !source) throw new Error("An observation needs a source.");
  const resolvedFreshness = value === null || value === undefined
    ? "unavailable"
    : (FRESHNESS.includes(freshness) ? freshness : classifyFreshness(observedAt, now, { reportedStale }));
  const time = toTime(observedAt);
  return Object.freeze({
    source,
    target: cleanTarget(target),
    label: redactString(String(label || source)).slice(0, 120),
    value: resolvedFreshness === "unavailable" ? null : value,
    unit,
    observedAt: time === null ? null : new Date(time).toISOString(),
    freshness: resolvedFreshness,
    kind: KINDS.includes(kind) ? kind : "measurement",
    note: note ? redactString(String(note)).slice(0, 240) : null,
  });
}

// Text that came from the managed systems (log lines, file names, container
// names, mod descriptions). It is data, never instructions: control characters
// are removed, secrets redacted, length bounded, and it is marked so the model
// prompt can fence it.
function untrustedText(value, maxLength = MAX_UNTRUSTED_TEXT) {
  const text = redactString(String(value ?? ""))
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\s+$/g, "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

module.exports = {
  FRESHNESS,
  KINDS,
  LIVE_WINDOW_MS,
  STALE_AFTER_MS,
  classifyFreshness,
  makeObservation,
  untrustedText,
};
