"use strict";

// Phase X: proposals and approvals for assistant-initiated operations.
//
// The assistant can only *propose*. A proposal pins one validated tool call
// (tool, target ids, arguments) and the user who asked, and gets a digest over
// exactly those fields. Approval must come back through the app's approval
// channel with the same digest, from the same user, before expiry, once.
// Altered arguments change the digest; a second use finds the proposal already
// consumed; a forged "approved" message from the model never reaches this
// module because only the approval IPC handler calls approve().
//
// The broker keeps a bounded journal. Anything still authorized or running
// when the app restarts is marked "interrupted" and never retried by itself.

const crypto = require("crypto");

const STATES = Object.freeze([
  "awaiting_approval", "authorized", "running", "succeeded", "failed",
  "verification_unavailable", "rejected", "expired", "cancelled", "interrupted",
]);
const OPEN_STATES = new Set(["awaiting_approval"]);
const ACTIVE_STATES = new Set(["authorized", "running"]);
const TERMINAL_STATES = new Set(["succeeded", "failed", "verification_unavailable", "rejected", "expired", "cancelled", "interrupted"]);

const DEFAULT_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING = 5;
const MAX_JOURNAL = 100;

function brokerError(code, message) {
  return Object.assign(new Error(message), { code });
}

// Stable JSON: sorted keys at every level, so the digest does not depend on
// property order.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function computeDigest({ id, tool, target, args, actorId, nonce }) {
  return crypto.createHash("sha256").update(canonicalJson({ id, tool, target, args, actorId, nonce })).digest("hex");
}

function actorIdOf(actor) {
  const id = actor && (actor.id || actor.username);
  if (typeof id !== "string" || !id) throw brokerError("AI_ACTOR_REQUIRED", "A signed-in user is required.");
  return id;
}

function createApprovalBroker({ now = () => Date.now(), ttlMs = DEFAULT_TTL_MS, randomId = () => crypto.randomUUID(), randomNonce = () => crypto.randomBytes(16).toString("hex"), onTransition = () => {}, initialJournal = [] } = {}) {
  const records = new Map();

  for (const entry of Array.isArray(initialJournal) ? initialJournal.slice(-MAX_JOURNAL) : []) {
    if (!entry || typeof entry.id !== "string" || !STATES.includes(entry.state)) continue;
    const record = { ...entry };
    if (ACTIVE_STATES.has(record.state)) {
      record.state = "interrupted";
      record.result = { ok: false, message: "AnxOS closed while this operation was in progress. It was not retried. Check the server's state before trying again." };
      record.updatedAt = now();
    } else if (OPEN_STATES.has(record.state)) {
      record.state = "expired";
      record.updatedAt = now();
    }
    records.set(record.id, record);
  }

  function publicView(record) {
    if (!record) return null;
    const { nonce, actorId, ...rest } = record;
    return { ...rest, digest: record.digest };
  }

  function transition(record, state, patch = {}) {
    record.state = state;
    record.updatedAt = now();
    Object.assign(record, patch);
    trim();
    onTransition(publicView(record));
    return publicView(record);
  }

  function trim() {
    if (records.size <= MAX_JOURNAL) return;
    const removable = [...records.values()].filter((record) => TERMINAL_STATES.has(record.state)).sort((a, b) => a.updatedAt - b.updatedAt);
    while (records.size > MAX_JOURNAL && removable.length) records.delete(removable.shift().id);
  }

  function expireOld() {
    const time = now();
    for (const record of records.values()) {
      if (OPEN_STATES.has(record.state) && time > record.expiresAt) transition(record, "expired");
    }
  }

  // call: a frozen result of toolRegistry.validateToolCall (operational only).
  function propose({ call, actor, request = "", preview = {} }) {
    if (!call || !call.definition) throw brokerError("AI_TOOL_CALL_INVALID", "Only validated tool calls can be proposed.");
    if (call.definition.category !== "operational") throw brokerError("AI_TOOL_NOT_PROPOSABLE", call.definition.category === "sensitive"
      ? "This kind of change is never made by the assistant. Use its own page."
      : "Read-only tools do not need approval.");
    const actorId = actorIdOf(actor);
    expireOld();
    const pending = [...records.values()].filter((record) => OPEN_STATES.has(record.state) && record.actorId === actorId);
    if (pending.length >= MAX_PENDING) throw brokerError("AI_TOO_MANY_PENDING", "Approve or reject the waiting proposals first.");
    const id = randomId();
    const nonce = randomNonce();
    const created = now();
    const record = {
      id,
      tool: call.tool,
      target: { ...call.target },
      args: { ...call.args },
      request: String(request || "").slice(0, 300),
      preview: {
        summary: String(preview.summary || "").slice(0, 300),
        targetLabel: String(preview.targetLabel || "").slice(0, 160),
        impact: String(preview.impact || call.definition.sideEffects || "").slice(0, 300),
        warnings: Array.isArray(preview.warnings) ? preview.warnings.map((text) => String(text).slice(0, 240)).slice(0, 6) : [],
        verification: call.definition.verification,
      },
      actorId,
      nonce,
      createdAt: created,
      updatedAt: created,
      expiresAt: created + ttlMs,
      state: "awaiting_approval",
      result: null,
    };
    record.digest = computeDigest(record);
    records.set(id, record);
    onTransition(publicView(record));
    return publicView(record);
  }

  // Called only by the approval IPC handler after a person clicked Approve.
  // Returns the exact call to run; the record becomes "authorized" and can
  // never be approved again.
  function authorize({ proposalId, digest, actor }) {
    expireOld();
    const record = records.get(String(proposalId || ""));
    if (!record) throw brokerError("AI_PROPOSAL_UNKNOWN", "That proposal does not exist.");
    if (record.state === "expired") throw brokerError("AI_PROPOSAL_EXPIRED", "That proposal expired. Ask again to get a fresh one.");
    if (!OPEN_STATES.has(record.state)) throw brokerError("AI_PROPOSAL_USED", "That proposal was already handled and cannot be approved again.");
    if (actorIdOf(actor) !== record.actorId) throw brokerError("AI_PROPOSAL_WRONG_USER", "Only the person who asked can approve this proposal.");
    const expected = computeDigest(record);
    if (typeof digest !== "string" || digest.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(expected))) {
      throw brokerError("AI_PROPOSAL_MODIFIED", "The approved request does not match the proposal. Nothing was run.");
    }
    transition(record, "authorized", { authorizedAt: now() });
    return { id: record.id, tool: record.tool, target: { ...record.target }, args: { ...record.args } };
  }

  function reject({ proposalId, actor }) {
    const record = records.get(String(proposalId || ""));
    if (!record || !OPEN_STATES.has(record.state)) throw brokerError("AI_PROPOSAL_UNKNOWN", "There is no waiting proposal with that id.");
    if (actorIdOf(actor) !== record.actorId) throw brokerError("AI_PROPOSAL_WRONG_USER", "Only the person who asked can reject this proposal.");
    return transition(record, "rejected");
  }

  function markRunning(id) {
    const record = records.get(id);
    if (!record || record.state !== "authorized") throw brokerError("AI_PROPOSAL_STATE", "The operation is not authorized.");
    return transition(record, "running", { startedAt: now() });
  }

  function finish(id, state, result = {}) {
    const record = records.get(id);
    if (!record || !ACTIVE_STATES.has(record.state)) throw brokerError("AI_PROPOSAL_STATE", "The operation is not running.");
    if (!["succeeded", "failed", "verification_unavailable", "cancelled"].includes(state)) throw brokerError("AI_PROPOSAL_STATE", "Unknown final state.");
    return transition(record, state, { result, finishedAt: now() });
  }

  // Disabling the assistant cancels everything that has not started.
  function cancelPending(reason = "The assistant was turned off.") {
    let count = 0;
    for (const record of records.values()) {
      if (OPEN_STATES.has(record.state)) { transition(record, "cancelled", { result: { ok: false, message: reason } }); count += 1; }
    }
    return count;
  }

  function isTargetBusy(target) {
    return [...records.values()].some((record) => ACTIVE_STATES.has(record.state)
      && record.target.nodeId === target.nodeId
      && (record.target.instanceId || record.target.container || null) === (target.instanceId || target.container || null));
  }

  function get(id) { expireOld(); return publicView(records.get(String(id || ""))); }
  function list() { expireOld(); return [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt).map(publicView); }
  function journal() { return [...records.values()].map((record) => ({ ...record })); }

  return { authorize, cancelPending, finish, get, isTargetBusy, journal, list, markRunning, propose, reject };
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_JOURNAL,
  MAX_PENDING,
  STATES,
  canonicalJson,
  computeDigest,
  createApprovalBroker,
};
