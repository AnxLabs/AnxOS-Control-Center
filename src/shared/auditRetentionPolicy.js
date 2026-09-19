// Pure audit-retention / access-review / export model for the append-only
// audit store (`src/services/securityService.js` writes it; the account auth
// service appends to the same file).
//
// This module NEVER touches the filesystem and NEVER deletes anything. It is a
// decision model plus a redacted projection: the service layer reads the store,
// this module says what may be pruned and what the window contains.
//
// Non-negotiable rule (V2-I "audit retention, access review and export"):
// security-relevant events are NEVER pruned by age alone. Pruning is fail
// closed — a record whose class cannot be determined is treated as protected,
// and a size cap that cannot be satisfied without pruning a protected record
// causes the whole retention operation to be REFUSED (nothing is pruned).

const { sanitizeForDiagnostics } = require("./redaction");

const POLICY_VERSION = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_WINDOW_MS = 90 * DAY_MS;
const DEFAULT_MAX_RECORDS = 50000;
const DEFAULT_MAX_EXPORT_RECORDS = 5000;
const DEFAULT_MAX_EXPORT_WINDOW_MS = 366 * DAY_MS;
const ROUTINE_CLASS = "routine";

// Every class below is protected: it may never be pruned by age, and it may
// never be pruned to satisfy a size cap. `unknown` is protected by design.
const PROTECTED_CLASSES = Object.freeze([
  "authentication-failure",
  "permission-denial",
  "revocation",
  "destructive",
  "migration-repair",
  "credential-rotation",
  "unknown",
]);

const OUTCOMES_FAILED = new Set(["failed", "denied"]);
const OUTCOME_OK = "ok";

// Actions whose successful, reason-free outcome is informational and therefore
// prunable. This is an ALLOWLIST: an action not listed here is classified as a
// protected class or `unknown`, never as routine. Keep it read-only or purely
// informational — anything that grants, denies, rotates, deletes, restores,
// migrates or reconfigures access belongs on the protected side.
const ROUTINE_ACTION_PATTERNS = Object.freeze([
  /(?:^|\.)list(?:\.|$)/i,
  /^alerts\.acknowledge$/i,
  /^docker\.preflight\.container$/i,
  /^security\.login$/i,
  /^security\.logout$/i,
  /^security\.session\.restore$/i,
  /^account\.login$/i,
  /^account\.logout$/i,
  /^account\.refresh$/i,
]);

function normalizeOutcome(value) {
  return String(value === null || value === undefined ? "" : value).trim().toLowerCase();
}

function normalizeAction(value) {
  return typeof value === "string" ? value.trim() : "";
}

function readRecordActorId(record) {
  const actor = record && typeof record === "object" ? record.actor : null;
  if (!actor || typeof actor !== "object") return null;
  const raw = actor.id ?? actor.username ?? actor.email ?? null;
  return raw === null || raw === undefined ? null : String(raw);
}

function readRecordTimestamp(record) {
  const raw = record && typeof record === "object" ? record.at : null;
  const parsed = typeof raw === "string" ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function isProtectedClass(value) {
  return PROTECTED_CLASSES.includes(value);
}

/**
 * Classify one audit record. A record whose class cannot be determined is
 * classified `unknown`, which is protected. `protected` is redundant with the
 * class list on purpose: callers must not have to re-derive the rule.
 */
function classifyAuditRecord(record) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { action: null, class: "unknown", protected: true, reason: "record-not-an-object" };
  }
  const action = normalizeAction(record.action);
  const outcome = normalizeOutcome(record.outcome);
  if (!action) {
    return { action: null, class: "unknown", protected: true, reason: "missing-action" };
  }
  const timestamp = readRecordTimestamp(record);

  // Prunable only when the action is on the read-only allowlist, the outcome is
  // exactly `ok`, there is no reason detail, and the timestamp is parseable.
  // Anything else — including a routine-looking action that failed or carried a
  // reason — falls through to the protected classification below.
  if (
    timestamp !== null
    && outcome === OUTCOME_OK
    && record.reason === null
    && ROUTINE_ACTION_PATTERNS.some((pattern) => pattern.test(action))
  ) {
    return { action, class: ROUTINE_CLASS, protected: false, reason: "allowlisted-informational" };
  }

  if (/permission|ownerworkspace/i.test(action) && OUTCOMES_FAILED.has(outcome)) {
    return { action, class: "permission-denial", protected: true, reason: "authorization-refusal" };
  }
  if (/revoke|logoutall|revokeother|revokecurrent|removealldevices|invalidat/i.test(action)) {
    return { action, class: "revocation", protected: true, reason: "access-withdrawal" };
  }
  if (/login|signin|sign-in|authenticat|devicelogin/i.test(action)) {
    return { action, class: "authentication-failure", protected: true, reason: "authentication-outcome" };
  }
  if (/migrat|repair|reconcil|recover/i.test(action)) {
    return { action, class: "migration-repair", protected: true, reason: "state-repair-or-migration" };
  }
  if (/rotate|rekey|regenerat|regenerate|generate.?token|identity.?mint|enroll|pair/i.test(action)) {
    return { action, class: "credential-rotation", protected: true, reason: "credential-lifecycle" };
  }
  if (/delete|remove|purge|prune|reset|destroy|drop|wipe|terminate|kill|overwrite|restore|transfer|revoke|disable|batch/i.test(action)) {
    return { action, class: "destructive", protected: true, reason: "destructive-or-state-changing" };
  }
  return { action, class: "unknown", protected: true, reason: "unmapped-action" };
}

function isPrunableRoutine(record) {
  return classifyAuditRecord(record).protected === false;
}

function filterWindow(records, options = {}) {
  const list = Array.isArray(records) ? records : [];
  const from = options.from === undefined || options.from === null || options.from === "" ? null : Date.parse(options.from);
  const to = options.to === undefined || options.to === null || options.to === "" ? null : Date.parse(options.to);
  if (from !== null && !Number.isFinite(from)) {
    const error = new Error("Audit window start is not a valid timestamp.");
    error.code = "AUDIT_WINDOW_INVALID";
    throw error;
  }
  if (to !== null && !Number.isFinite(to)) {
    const error = new Error("Audit window end is not a valid timestamp.");
    error.code = "AUDIT_WINDOW_INVALID";
    throw error;
  }
  if (from !== null && to !== null && from > to) {
    const error = new Error("Audit window start must not be later than its end.");
    error.code = "AUDIT_WINDOW_INVALID";
    throw error;
  }
  const kept = [];
  let undated = 0;
  for (const record of list) {
    const timestamp = readRecordTimestamp(record);
    if (timestamp === null) {
      // A record with no parseable timestamp cannot be placed in a window; it
      // is retained and reported rather than silently dropped.
      undated += 1;
      continue;
    }
    if (from !== null && timestamp < from) continue;
    if (to !== null && timestamp > to) continue;
    kept.push(record);
  }
  return { records: kept, undated, from, to };
}

function countByClass(records) {
  const counts = {};
  for (const record of records) {
    const { class: eventClass } = classifyAuditRecord(record);
    counts[eventClass] = (counts[eventClass] || 0) + 1;
  }
  return counts;
}

/**
 * Compute the retention plan for a set of audit records.
 *
 * Rules (see `describeRetentionPolicy()`):
 *  1. Age: only `routine` records older than the window are pruned.
 *  2. Cap: when the surviving set is still larger than `maxRecords`, the oldest
 *     remaining `routine` records are pruned, oldest first.
 *  3. Refusal: if the cap cannot be met without pruning a non-routine record,
 *     the operation is REFUSED and the input is returned untouched.
 */
function applyRetention(records, options = {}) {
  if (!Array.isArray(records)) {
    throw new TypeError("applyRetention expects an array of audit records.");
  }
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const windowMs = Number.isFinite(Number(options.windowMs)) && Number(options.windowMs) > 0
    ? Number(options.windowMs)
    : DEFAULT_RETENTION_WINDOW_MS;
  const maxRecords = Number.isFinite(Number(options.maxRecords)) && Number(options.maxRecords) >= 0
    ? Number(options.maxRecords)
    : DEFAULT_MAX_RECORDS;
  const cutoff = now - windowMs;

  const pruned = [];
  const kept = [];
  for (const record of records) {
    const classification = classifyAuditRecord(record);
    const timestamp = readRecordTimestamp(record);
    if (!classification.protected && timestamp !== null && timestamp < cutoff) {
      pruned.push({ record, classification, reason: "aged-out-of-window" });
      continue;
    }
    kept.push(record);
  }

  const capExceeded = kept.length > maxRecords;
  let refused = false;
  let refusalReason = null;
  if (capExceeded) {
    const overflow = kept.length - maxRecords;
    const extraCandidates = [];
    for (const record of kept) {
      const classification = classifyAuditRecord(record);
      const timestamp = readRecordTimestamp(record);
      if (!classification.protected && timestamp !== null) extraCandidates.push({ record, timestamp });
    }
    if (extraCandidates.length < overflow) {
      refused = true;
      refusalReason = "CAP_EXCEEDED_PROTECTED_ONLY";
    } else {
      extraCandidates.sort((left, right) => left.timestamp - right.timestamp);
      for (const candidate of extraCandidates.slice(0, overflow)) {
        const classification = classifyAuditRecord(candidate.record);
        pruned.push({ record: candidate.record, classification, reason: "size-cap" });
        const index = kept.indexOf(candidate.record);
        if (index >= 0) kept.splice(index, 1);
      }
    }
  }

  if (refused) {
    // Fail closed: a refusal prunes nothing at all, not even the aged-out ones.
    return {
      policyVersion: POLICY_VERSION,
      refused: true,
      refusalReason,
      windowMs,
      maxRecords,
      cutoff: new Date(cutoff).toISOString(),
      kept: records.slice(),
      pruned: [],
      prunedCount: 0,
      keptCount: records.length,
      protectedRetained: countByClass(records),
    };
  }

  return {
    policyVersion: POLICY_VERSION,
    refused: false,
    refusalReason: null,
    windowMs,
    maxRecords,
    cutoff: new Date(cutoff).toISOString(),
    kept,
    pruned,
    prunedCount: pruned.length,
    keptCount: kept.length,
    protectedRetained: countByClass(kept),
  };
}

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function summarizeRecord(record) {
  const classification = classifyAuditRecord(record);
  const timestamp = readRecordTimestamp(record);
  const safe = sanitizeForDiagnostics({
    at: timestamp === null ? null : new Date(timestamp).toISOString(),
    action: normalizeAction(record?.action) || "unknown",
    outcome: normalizeOutcome(record?.outcome) || "unknown",
    actor: record?.actor && typeof record.actor === "object"
      ? {
        id: record.actor.id ?? null,
        username: record.actor.username ?? record.actor.email ?? null,
        role: record.actor.role ?? null,
      }
      : null,
    target: record?.target ?? null,
    reason: record?.reason ?? null,
  });
  return { ...safe, class: classification.class, protected: classification.protected };
}

/**
 * Pure access-review projection: who did what, over a window, with counts and
 * first/last seen. Every field passes through the repo's diagnostics redactor
 * before it reaches the caller, so no secret material leaves this function.
 */
function buildAccessReview(records, options = {}) {
  const window = filterWindow(records, options);
  const groups = new Map();
  const actorKeys = new Set();
  let protectedCount = 0;

  for (const record of window.records) {
    const classification = classifyAuditRecord(record);
    if (classification.protected) protectedCount += 1;
    const timestamp = readRecordTimestamp(record);
    const actorId = readRecordActorId(record);
    const actorKey = actorId === null ? "(no-actor)" : actorId;
    actorKeys.add(actorKey);
    const key = `${actorKey}\u0000${classification.action || "unknown"}\u0000${normalizeOutcome(record?.outcome) || "unknown"}`;
    const entry = groups.get(key) || {
      actorReference: actorId,
      action: classification.action || "unknown",
      outcome: normalizeOutcome(record?.outcome) || "unknown",
      class: classification.class,
      protected: classification.protected,
      count: 0,
      firstSeen: null,
      lastSeen: null,
    };
    entry.count += 1;
    if (timestamp !== null) {
      if (entry.firstSeen === null || timestamp < Date.parse(entry.firstSeen)) entry.firstSeen = new Date(timestamp).toISOString();
      if (entry.lastSeen === null || timestamp > Date.parse(entry.lastSeen)) entry.lastSeen = new Date(timestamp).toISOString();
    }
    groups.set(key, entry);
  }

  const entries = Array.from(groups.values())
    .sort((left, right) => (
      String(left.actorReference || "").localeCompare(String(right.actorReference || ""))
      || left.action.localeCompare(right.action)
      || left.outcome.localeCompare(right.outcome)
    ))
    .map((entry) => sanitizeForDiagnostics(entry));

  const generatedAt = Number.isFinite(Number(options.now)) ? new Date(Number(options.now)).toISOString() : new Date().toISOString();
  return {
    policyVersion: POLICY_VERSION,
    generatedAt,
    window: {
      from: window.from === null ? null : new Date(window.from).toISOString(),
      to: window.to === null ? null : new Date(window.to).toISOString(),
    },
    recordCount: window.records.length,
    undatedRecords: window.undated,
    actorCount: actorKeys.size,
    protectedEventCount: protectedCount,
    entries,
  };
}

/**
 * Bounded, redacted, deterministic export of an audit window.
 *
 * Deterministic: records are ordered by timestamp then a canonical key, and the
 * document is serialized with sorted object keys, so two exports of the same
 * input are byte-identical and diffable.
 *
 * Bounded: an input window larger than `maxExportRecords`, a window span larger
 * than `maxExportWindowMs`, or an invalid window is REFUSED with a typed error
 * rather than truncated.
 */
function buildAuditExport(records, options = {}) {
  if (!Array.isArray(records)) {
    throw new TypeError("buildAuditExport expects an array of audit records.");
  }
  const maxExportRecords = Number.isFinite(Number(options.maxExportRecords)) && Number(options.maxExportRecords) > 0
    ? Number(options.maxExportRecords)
    : DEFAULT_MAX_EXPORT_RECORDS;
  const maxExportWindowMs = Number.isFinite(Number(options.maxExportWindowMs)) && Number(options.maxExportWindowMs) > 0
    ? Number(options.maxExportWindowMs)
    : DEFAULT_MAX_EXPORT_WINDOW_MS;

  const window = filterWindow(records, options);
  if (window.records.length > maxExportRecords) {
    const error = new Error(`Audit export window holds ${window.records.length} records, above the ${maxExportRecords}-record export cap. Narrow the window.`);
    error.code = "AUDIT_EXPORT_WINDOW_TOO_LARGE";
    error.details = { recordCount: window.records.length, maxExportRecords };
    throw error;
  }
  if (window.from !== null && window.to !== null && (window.to - window.from) > maxExportWindowMs) {
    const error = new Error("Audit export window span is above the supported maximum.");
    error.code = "AUDIT_EXPORT_WINDOW_TOO_WIDE";
    error.details = { spanMs: window.to - window.from, maxExportWindowMs };
    throw error;
  }

  const ordered = window.records.slice().sort((left, right) => {
    const leftTime = readRecordTimestamp(left);
    const rightTime = readRecordTimestamp(right);
    if (leftTime !== rightTime) {
      if (leftTime === null) return 1;
      if (rightTime === null) return -1;
      return leftTime - rightTime;
    }
    return stableStringify(summarizeRecord(left)).localeCompare(stableStringify(summarizeRecord(right)));
  });

  const generatedAt = Number.isFinite(Number(options.now)) ? new Date(Number(options.now)).toISOString() : new Date().toISOString();
  const document = {
    schema: "anxos.audit.export",
    schemaVersion: POLICY_VERSION,
    generatedAt,
    window: {
      from: window.from === null ? null : new Date(window.from).toISOString(),
      to: window.to === null ? null : new Date(window.to).toISOString(),
      recordCount: ordered.length,
      undatedRecords: window.undated,
    },
    redacted: true,
    protectedClasses: PROTECTED_CLASSES.slice(),
    entries: ordered.map(summarizeRecord),
  };
  return {
    document,
    json: `${stableStringify(document)}\n`,
    recordCount: ordered.length,
    maxExportRecords,
  };
}

function describeRetentionPolicy() {
  return {
    policyVersion: POLICY_VERSION,
    windowDays: DEFAULT_RETENTION_WINDOW_MS / DAY_MS,
    maxRecords: DEFAULT_MAX_RECORDS,
    maxExportRecords: DEFAULT_MAX_EXPORT_RECORDS,
    maxExportWindowDays: DEFAULT_MAX_EXPORT_WINDOW_MS / DAY_MS,
    routineClass: ROUTINE_CLASS,
    protectedClasses: PROTECTED_CLASSES.slice(),
    rules: [
      "Only records classified `routine` (an explicit read-only/informational allowlist) may be pruned by age.",
      "Security-relevant events are never pruned by age: authentication failures, permission denials, revocations, destructive operations, migration/repair events and credential rotation are protected.",
      "A record whose class cannot be determined (missing or unmapped action, missing or unparseable timestamp, failed or denied outcome on a routine-looking action) is treated as protected.",
      "When the record count exceeds the size cap, the oldest remaining routine records are pruned first; a cap that cannot be met without pruning a protected record is refused and nothing is pruned.",
    ],
  };
}

module.exports = {
  POLICY_VERSION,
  ROUTINE_CLASS,
  PROTECTED_CLASSES,
  DEFAULT_RETENTION_WINDOW_MS,
  DEFAULT_MAX_RECORDS,
  DEFAULT_MAX_EXPORT_RECORDS,
  DEFAULT_MAX_EXPORT_WINDOW_MS,
  applyRetention,
  buildAccessReview,
  buildAuditExport,
  classifyAuditRecord,
  describeRetentionPolicy,
  filterWindow,
  isPrunableRoutine,
  isProtectedClass,
  stableStringify,
};