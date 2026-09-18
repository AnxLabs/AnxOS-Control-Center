#!/usr/bin/env node
// Behavioral regression for the destructive workload-transfer gate in the
// renderer (app.js).
//
// WHY THIS EXISTS
// ---------------
// scripts/ui-polish-smoke.js pins the transfer gate with static string checks.
// An adversarial review mutation-tested those pins and proved them mostly
// decorative: a second destructive path written as `api.workload.transfer(`,
// neutering the confirmation (`if (!confirmed)` -> `if (false)`), deriving the
// typed phrase from the raw operator input, and neutering the in-flight
// re-check all left the static pins green. Static string presence is not a
// guard assertion.
//
// This smoke executes the REAL `openWorkloadTransfer` control flow extracted
// from app.js against stubbed IPC + confirmation and asserts on OBSERVED CALLS
// (which stubs were invoked, in what order, with what arguments), not on source
// text. The only source-derived assertion is the single-call-site scan in
// assertion 6, which is normalized to catch receiver variants rather than the
// literal `api.transfer(` string the static pin keys on.
//
// The static pins in ui-polish-smoke.js are intentionally left untouched; this
// is the behavioral layer underneath them, not a replacement.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_PATH = path.join(__dirname, "..", "app.js");
const source = fs.readFileSync(APP_PATH, "utf8");

// ---------------------------------------------------------------------------
// Function extraction: pull the real openWorkloadTransfer body out of app.js
// and run it in a sandbox with every free variable stubbed. The extractor
// brace-matches from the function's opening brace, which is exact for this
// function (all braces in its body — including template-literal `${...}`
// interpolations — are balanced).
// ---------------------------------------------------------------------------
function extractFunction(name) {
  const needle = `async function ${name}(`;
  const start = source.indexOf(needle);
  assert(start >= 0, `Could not find async function ${name} in app.js.`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return { text: source.slice(start, index + 1), start, end: index + 1 };
    }
  }
  throw new Error(`Could not extract ${name}.`);
}

const OPEN_WORKLOAD_TRANSFER = extractFunction("openWorkloadTransfer");

// ---------------------------------------------------------------------------
// Assertion 6 support: normalized single-call-site scan.
//
// The static pin counts the literal `api.transfer(`. A second destructive path
// written as `api.workload.transfer(` (the review's M1 evasion) evades it. This
// scanner counts every invocation of a `.transfer(` method on ANY receiver, plus
// computed bracket access (`obj["transfer"](...)`), so a second path is caught
// regardless of how the receiver is spelled.
// ---------------------------------------------------------------------------
const TRANSFER_CALL_PATTERNS = [
  /\.transfer\s*\(/g,
  /\[\s*["'`]transfer["'`]\s*\]\s*\(/g,
];
function scanWorkloadTransferCallSites(text) {
  const hits = [];
  for (const pattern of TRANSFER_CALL_PATTERNS) {
    for (const match of text.matchAll(pattern)) hits.push({ index: match.index, text: match[0] });
  }
  hits.sort((left, right) => left.index - right.index);
  return hits.map((hit) => ({
    ...hit,
    line: text.slice(0, hit.index).split(/\r?\n/).length,
  }));
}

// Positive control for the scanner itself: if the patterns are ever neutered to
// "always exactly one", this self-test fails instead of silently passing.
const SCANNER_SELF_TEST = scanWorkloadTransferCallSites(
  'api.transfer({});\nawait api.workload.transfer({});\nworkloadApi["transfer"]({});',
);
assert.strictEqual(
  SCANNER_SELF_TEST.length,
  3,
  `The transfer call-site scanner must catch receiver variants and bracket access (found ${SCANNER_SELF_TEST.length}, expected 3: api.transfer, api.workload.transfer, api["transfer"]).`,
);

// ---------------------------------------------------------------------------
// Harness: run the real openWorkloadTransfer against stubbed collaborators and
// record every observed call.
// ---------------------------------------------------------------------------
function createHarness(overrides = {}) {
  const state = {
    order: [],
    previewCalls: [],
    transferCalls: [],
    confirmCalls: [],
    toasts: [],
    notifications: [],
    refreshCalls: 0,
    buttonUpdates: 0,
    sourceInstance: { id: "src-inst", displayName: "Source Instance" },
    previewImpl: async () => ({ ok: true, steps: [] }),
    transferImpl: async () => ({ ok: true, steps: [] }),
    confirmImpl: async (options) => options.phrase,
    dialogImpl: async () => ({ targetNodeId: "node-B", targetInstanceId: "inst-1" }),
    stillCurrentImpl: () => true,
    ...overrides,
  };

  const api = {
    transferPreview: async (payload) => {
      state.order.push("preview");
      state.previewCalls.push(payload);
      return state.previewImpl(payload);
    },
    transfer: async (payload) => {
      state.order.push("transfer");
      state.transferCalls.push(payload);
      return state.transferImpl(payload);
    },
  };

  const context = {
    getWorkloadTransferApi: () => api,
    findInstance: () => state.sourceInstance,
    showToast: (message, tone) => state.toasts.push({ message, tone }),
    blockProtectedAction: () => false,
    securityState: { localOwnerAuthenticated: true },
    getSelectedNode: () => ({ id: "node-A", kind: "agent", displayName: "Node A" }),
    getSelectedNodeId: () => "node-A",
    getWorkloadTransferTargetNodes: () => [{ id: "node-B", kind: "agent", displayName: "Node B" }],
    createWorkloadTransferTargetDialog: async (options) => state.dialogImpl(options),
    createNodeActionContext: () => ({ nodeId: "node-A", version: 1, serial: 1, label: "workload-transfer" }),
    getNodeScopedPayload: (actionContext, payload = {}) => ({ ...payload, nodeId: actionContext?.nodeId || "node-A" }),
    isNodeActionStillCurrent: () => state.stillCurrentImpl(),
    createSecurityConfirmation: async (options) => {
      state.order.push("confirm");
      state.confirmCalls.push(options);
      return state.confirmImpl(options);
    },
    formatWorkloadTransferStep: (step = {}) => String(step.step || "step"),
    getWorkloadTransferSteps: (error) => (Array.isArray(error?.steps) ? error.steps : []),
    formatWorkloadTransferStepTrail: () => "trail",
    createNotification: (notification) => state.notifications.push(notification),
    refreshInstances: async () => {
      state.refreshCalls += 1;
    },
    updateInstanceActionButtons: () => {
      state.buttonUpdates += 1;
    },
    getAgentErrorCode: (error) => error?.code || null,
    normalizeIpcErrorMessage: (error, fallback) => String(error?.message || fallback),
  };

  vm.createContext(context);
  // The three in-flight flags are module-level `let` in app.js; declare them as
  // function-scoped `var` in the sandbox so the extracted function reads and
  // writes the same bindings across calls.
  vm.runInContext(
    "var workloadTransferInFlight = false, instanceActionRequestInFlight = false, instancesRequestInFlight = false;\n"
      + OPEN_WORKLOAD_TRANSFER.text
      + "\nthis.openWorkloadTransfer = openWorkloadTransfer;",
    context,
  );

  state.run = () => context.openWorkloadTransfer(state.sourceInstance);
  state.toastText = () => state.toasts.map((toast) => toast.message).join(" | ");
  state.notificationTitles = () => state.notifications.map((notification) => notification.title);
  return state;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
async function main() {
  // --- Assertion 1: happy path, preview -> typed confirmation -> transfer ---
  const happy = createHarness({
    dialogImpl: async () => ({ targetNodeId: "node-B", targetInstanceId: "raw-Input-Id" }),
    previewImpl: async () => ({ ok: true, targetInstanceId: "resolved-id-9", steps: [], conflict: {} }),
    transferImpl: async () => ({ ok: true, targetInstanceId: "resolved-id-9", steps: [] }),
    confirmImpl: async (options) => options.phrase,
  });
  await happy.run();
  assert.strictEqual(happy.previewCalls.length, 1, "1: the preview must be called exactly once.");
  assert.strictEqual(
    happy.previewCalls[0].targetInstanceId,
    "raw-Input-Id",
    "1: the preview must be asked about the operator's raw target id (the service resolves it).",
  );
  assert.strictEqual(happy.confirmCalls.length, 1, "1: the confirmation must be requested exactly once.");
  assert.strictEqual(
    happy.confirmCalls[0].phrase,
    "resolved-id-9",
    "INVARIANT VIOLATED (assertion 1): the confirmation phrase must be the preview-resolved target instance id 'resolved-id-9', not the raw operator input 'raw-Input-Id'.",
  );
  assert.strictEqual(happy.transferCalls.length, 1, "1: the transfer must be called exactly once.");
  assert.strictEqual(happy.transferCalls[0].confirmOverwrite, true, "1: the transfer must set confirmOverwrite: true.");
  assert.strictEqual(
    happy.transferCalls[0].targetInstanceId,
    "resolved-id-9",
    "1: the transfer must target the preview-resolved instance id.",
  );
  assert.deepStrictEqual(
    happy.order,
    ["preview", "confirm", "transfer"],
    "1: the observed call order must be preview -> confirmation -> transfer.",
  );
  console.log("[1] happy path: preview -> confirmation(phrase=resolved-id-9) -> transfer(confirmOverwrite:true)");

  // --- Assertion 2: declined confirmation must never reach api.transfer ---
  // This is the review's M2 evasion: the static pin proves a phrase string
  // exists, not that the transfer call is gated on the confirmation result.
  const declined = createHarness({
    previewImpl: async () => ({ ok: true, targetInstanceId: "resolved-id-9", steps: [] }),
    confirmImpl: async () => null,
  });
  await declined.run();
  assert.strictEqual(declined.previewCalls.length, 1, "2: the preview must still run before the gate.");
  assert.strictEqual(declined.confirmCalls.length, 1, "2: the confirmation must be requested before any transfer.");
  assert.strictEqual(
    declined.transferCalls.length,
    0,
    "INVARIANT VIOLATED (assertion 2): a declined confirmation (createSecurityConfirmation resolved falsy) must NEVER reach api.transfer.",
  );
  assert.ok(/canceled/i.test(declined.toastText()), "2: a declined transfer must tell the operator it was canceled.");
  console.log("[2] declined confirmation: transfer call sites observed = 0");

  // --- Assertion 3: accepted confirmation uses the RESOLVED id, not raw input ---
  // The review's M3 evasion: phrase derived from `selection.targetInstanceId`
  // (raw operator input) instead of `preview.targetInstanceId`.
  const resolved = createHarness({
    dialogImpl: async () => ({ targetNodeId: "node-B", targetInstanceId: "My-Instance" }),
    previewImpl: async () => ({ ok: true, targetInstanceId: "my-instance", steps: [] }),
    confirmImpl: async (options) => options.phrase,
  });
  await resolved.run();
  assert.strictEqual(
    resolved.confirmCalls[0].phrase,
    "my-instance",
    "INVARIANT VIOLATED (assertion 3): the confirmation phrase must be the preview-resolved target instance id, not the raw operator input 'My-Instance'.",
  );
  assert.strictEqual(resolved.transferCalls.length, 1, "3: an accepted confirmation must reach the transfer exactly once.");
  assert.strictEqual(
    resolved.transferCalls[0].targetInstanceId,
    "my-instance",
    "INVARIANT VIOLATED (assertion 3): the transfer must target the preview-resolved id, even when the raw operator input differs.",
  );
  console.log("[3] raw 'My-Instance' vs resolved 'my-instance': phrase and transfer both use the resolved id");

  // --- Assertion 4: preview failure must not reach the confirmation gate ---
  const previewThrew = createHarness({
    previewImpl: async () => {
      throw Object.assign(new Error("preview exploded"), { code: "WORKLOAD_PREVIEW_FAILED" });
    },
  });
  await previewThrew.run();
  assert.strictEqual(
    previewThrew.confirmCalls.length,
    0,
    "INVARIANT VIOLATED (assertion 4a): a thrown preview must not reach the confirmation gate.",
  );
  assert.strictEqual(previewThrew.transferCalls.length, 0, "4a: a thrown preview must never reach api.transfer.");
  assert.ok(
    previewThrew.notificationTitles().some((title) => /failed/i.test(title)),
    "4a: a failed preview must be reported honestly.",
  );
  console.log("[4a] preview threw: confirmation requests = 0, transfer calls = 0, failure reported");

  const previewNotOk = createHarness({
    previewImpl: async () => ({ ok: false, error: { code: "WORKLOAD_PREVIEW_FAILED", message: "preview refused" } }),
  });
  await previewNotOk.run();
  assert.strictEqual(
    previewNotOk.confirmCalls.length,
    0,
    "INVARIANT VIOLATED (assertion 4b): a preview that resolves {ok:false} must not reach the confirmation gate.",
  );
  assert.strictEqual(previewNotOk.transferCalls.length, 0, "4b: a {ok:false} preview must never reach api.transfer.");
  console.log("[4b] preview {ok:false}: confirmation requests = 0, transfer calls = 0");

  // --- Assertion 5: a node switch mid-flight must not swallow the result ---
  // The reviewer verified the code has no stale guard on the transfer path:
  // the source/target are captured before the await, so the outcome of a
  // destructive transfer is always reported even if the selected node changed
  // while it ran. Pin that behaviorally: the selection goes stale during the
  // transfer, so any reintroduced `isNodeActionStillCurrent` guard after the
  // transfer would bail and drop the notification.
  let nodeChanged = false;
  const switched = createHarness({
    previewImpl: async () => ({ ok: true, targetInstanceId: "resolved-id-9", steps: [] }),
    stillCurrentImpl: () => !nodeChanged,
    transferImpl: async () => {
      nodeChanged = true; // operator switches nodes while the restore is running
      return { ok: true, targetInstanceId: "resolved-id-9", steps: [{ step: "target.restore.confirm", ok: true }] };
    },
  });
  await switched.run();
  assert.strictEqual(
    switched.transferCalls.length,
    1,
    "5: the confirmed destructive transfer must still run when the node changes mid-flight.",
  );
  assert.ok(
    switched.notificationTitles().some((title) => /Workload transfer completed/.test(title)),
    "INVARIANT VIOLATED (assertion 5): a node switch mid-flight must not swallow the completed destructive result.",
  );
  assert.ok(
    !switched.notificationTitles().some((title) => /failed/i.test(title)),
    "5: a successful transfer must not be reported as failed after a mid-flight node switch.",
  );
  console.log("[5] node switched mid-transfer: result still reported (no stale guard on the transfer path)");

  // --- Assertion 6: exactly one workload .transfer( call site in app.js ---
  const callSites = scanWorkloadTransferCallSites(source);
  assert.strictEqual(
    callSites.length,
    1,
    `INVARIANT VIOLATED (assertion 6): workload transfer must have exactly one .transfer( call site so the preview/confirmation gate cannot be bypassed from a second path; found ${callSites.length} at line(s) ${callSites.map((site) => site.line).join(", ")}.`,
  );
  const [callSite] = callSites;
  assert.ok(
    callSite.index >= OPEN_WORKLOAD_TRANSFER.start && callSite.index < OPEN_WORKLOAD_TRANSFER.end,
    `INVARIANT VIOLATED (assertion 6): the single .transfer( call site (line ${callSite.line}) must live inside openWorkloadTransfer, the gated flow.`,
  );
  console.log(`[6] single workload .transfer( call site at app.js:${callSite.line}, inside openWorkloadTransfer`);

  console.log("workload-transfer-gate-behavior smoke checks passed.");
}

main().catch((error) => {
  console.error("workload-transfer-gate-behavior smoke FAILED:", error && error.message ? error.message : error);
  if (error && error.stack) console.error(error.stack);
  process.exit(1);
});
