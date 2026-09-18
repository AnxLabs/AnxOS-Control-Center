// V2-J Wave 1: hermetic alert-engine smoke.
//
// Covers the bounded, deterministic contract of src/services/alertService.js:
//   - every condition fires with the right severity/target/id
//   - duplicates dedupe (occurrence counts, no second alert)
//   - recovery emits exactly one RECOVERED and clears
//   - quiet hours suppress emission but keep counting state
//   - a desktop restart does not re-fire active alerts (state persists) and
//     reconciles alerts whose condition vanished while offline
//   - acknowledge semantics (marks acknowledgedAt; a NEW occurrence after
//     recovery re-fires unacknowledged)
//   - corrupt store quarantine happens exactly once
//   - tier gating for alerts:list / alerts:acknowledge at the handler level
//
// Roots are pinned before any src module loads so the store and job runtime
// can never leak into the real machine.
const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");

const smokeRoot = pinAgentRoots("anx-alert-engine-");
const configDir = process.env.ANXHUB_CONFIG_DIR;

const alertService = require("../src/services/alertService");

// Injected deterministic clock (UTC). isWithinQuietHours uses UTC minutes.
let clockMs = Date.parse("2026-01-01T12:00:00.000Z");
const at = (iso) => { clockMs = Date.parse(iso); };

function quarantineFiles() {
  return fs.readdirSync(configDir).filter((name) => /^alerts\.json\.corrupt-/.test(name));
}

function countTransitions(result, type) {
  return result.transitions.filter((transition) => transition.type === type).length;
}

// ---------------------------------------------------------------------------
// Phase A: pure evaluator — condition, severity, target, stable id.
// ---------------------------------------------------------------------------
function phasePureEvaluator() {
  const snapshot = {
    nodes: [
      { nodeId: "node-online", state: "online", disk: { usagePercent: 10 } },
      { nodeId: "node-offline", state: "offline" },
      { nodeId: "node-connecting", state: "connecting" },
      { nodeId: "node-disk-warn", state: "online", disk: { usagePercent: 92 } },
      { nodeId: "node-disk-crit", state: "online", disk: { usagePercent: 97 } },
      {
        nodeId: "node-backup",
        state: "online",
        backups: [
          { instanceId: "inst-old", backupAgeDays: 45 },
          { instanceId: "inst-policy", backupAgeDays: 12, retentionPolicy: { maxAgeDays: 7, keepLast: 3 } },
          { instanceId: "inst-fresh", backupAgeDays: 3 },
        ],
      },
      {
        nodeId: "node-inst",
        state: "online",
        instances: [
          { instanceId: "inst-degraded", healthState: "degraded" },
          { instanceId: "inst-failed", processState: "Failed" },
          { instanceId: "inst-ok", healthState: "healthy" },
        ],
      },
    ],
  };
  const conditions = alertService.deriveAlertConditions(snapshot);
  const byId = new Map(conditions.map((condition) => [`${condition.condition}:${condition.target}`, condition]));

  const expect = (condition, target, severity) => {
    const found = conditions.find((entry) => entry.condition === condition && entry.target === target);
    assert(found, `Pure evaluator must fire ${condition} for ${target}.`);
    assert.strictEqual(found.severity, severity, `${condition} for ${target} must be ${severity}, saw ${found.severity}.`);
  };

  expect("NODE_OFFLINE", "node-offline", "critical");
  expect("NODE_OFFLINE", "node-connecting", "warning");
  expect("DISK_PRESSURE", "node-disk-warn", "warning");
  expect("DISK_PRESSURE", "node-disk-crit", "critical");
  expect("BACKUP_AGE", "node-backup/inst-old", "warning");
  expect("BACKUP_AGE", "node-backup/inst-policy", "warning");
  expect("INSTANCE_DEGRADED", "node-inst/inst-degraded", "warning");
  expect("INSTANCE_DEGRADED", "node-inst/inst-failed", "critical");

  // Healthy surfaces stay silent.
  for (const [condition, target] of [
    ["NODE_OFFLINE", "node-online"],
    ["NODE_OFFLINE", "node-disk-warn"],
    ["DISK_PRESSURE", "node-online"],
    ["BACKUP_AGE", "node-backup/inst-fresh"],
    ["INSTANCE_DEGRADED", "node-inst/inst-ok"],
  ]) {
    assert(
      !conditions.some((entry) => entry.condition === condition && entry.target === target),
      `Pure evaluator must not fire ${condition} for healthy ${target}.`,
    );
  }

  // Stable id shape: alert:<CONDITION>:<target>.
  const ids = conditions.map((condition) => `alert:${condition.condition}:${condition.target}`);
  assert(ids.includes("alert:NODE_OFFLINE:node-offline"), "Stable id shape must be alert:<condition>:<target>.");
  assert.deepStrictEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)), "Derived conditions must be deterministically sorted.");
  assert.strictEqual(byId.size, conditions.length, "Condition map keys must be unique.");
}

// ---------------------------------------------------------------------------
// Phase B: dedup — one alert per condition+target while active.
// ---------------------------------------------------------------------------
function phaseDedup() {
  const snapshot = { nodes: [{ nodeId: "node-offline", state: "offline" }] };
  at("2026-01-01T12:00:00.000Z");
  const first = alertService.evaluateAlerts(snapshot);
  assert.strictEqual(countTransitions(first, "FIRED"), 1, "First evaluation must FIRED the condition.");
  assert.strictEqual(countTransitions(first, "RECOVERED"), 0, "First evaluation must not RECOVER.");
  assert.strictEqual(first.transitions[0].emitted, true, "A non-quiet FIRED must be emitted.");
  const active = first.alerts.find((alert) => alert.id === "alert:NODE_OFFLINE:node-offline");
  assert(active, "Fired alert must be present in the active set.");
  assert.strictEqual(active.occurrences, 1, "A new alert starts at occurrence 1.");
  assert.strictEqual(active.firstSeenAt, "2026-01-01T12:00:00.000Z", "firstSeenAt must record the first observation.");
  assert.strictEqual(active.lastSeenAt, active.firstSeenAt, "lastSeenAt equals firstSeenAt on the first pass.");

  at("2026-01-01T12:05:00.000Z");
  const second = alertService.evaluateAlerts(snapshot);
  assert.strictEqual(countTransitions(second, "FIRED"), 0, "A repeated condition must not create a second alert.");
  assert.strictEqual(second.transitions.length, 0, "A repeated condition must emit no transitions.");
  const deduped = second.alerts.find((alert) => alert.id === "alert:NODE_OFFLINE:node-offline");
  assert.strictEqual(deduped.occurrences, 2, "Occurrence count must increment on the second pass.");
  assert.strictEqual(deduped.firstSeenAt, "2026-01-01T12:00:00.000Z", "firstSeenAt must not move after dedup.");
  assert.strictEqual(deduped.lastSeenAt, "2026-01-01T12:05:00.000Z", "lastSeenAt must move on the second pass.");
  assert.strictEqual(second.alerts.length, 1, "Exactly one active alert must exist.");
}

// ---------------------------------------------------------------------------
// Phase C: recovery — exactly one RECOVERED, then clear.
// ---------------------------------------------------------------------------
function phaseRecovery() {
  at("2026-01-01T12:10:00.000Z");
  const recovered = alertService.evaluateAlerts({ nodes: [{ nodeId: "node-offline", state: "online" }] });
  assert.strictEqual(countTransitions(recovered, "RECOVERED"), 1, "A vanished condition must emit exactly one RECOVERED.");
  assert.strictEqual(recovered.transitions[0].emitted, true, "A non-quiet RECOVERED must be emitted.");
  assert.strictEqual(recovered.alerts.length, 0, "Recovery must clear the active alert.");
  assert.strictEqual(alertService.getActiveAlerts().length, 0, "The active set must be empty after recovery.");

  const settled = alertService.evaluateAlerts({ nodes: [{ nodeId: "node-offline", state: "online" }] });
  assert.strictEqual(settled.transitions.length, 0, "No further transitions once the condition stays absent.");
}

// ---------------------------------------------------------------------------
// Phase D: quiet hours suppress emission but not state tracking.
// ---------------------------------------------------------------------------
function phaseQuietHours() {
  alertService.configureAlertService({ quietHours: { enabled: true, start: "22:00", end: "07:00" } });
  const snapshot = { nodes: [{ nodeId: "node-quiet", state: "offline" }] };

  at("2026-01-01T23:30:00.000Z");
  const fired = alertService.evaluateAlerts(snapshot);
  assert.strictEqual(fired.quietHoursActive, true, "23:30 UTC must fall inside the 22:00-07:00 window.");
  assert.strictEqual(countTransitions(fired, "FIRED"), 1, "The condition must still be tracked during quiet hours.");
  assert.strictEqual(fired.transitions[0].emitted, false, "Quiet hours must suppress the FIRED emission.");
  assert.strictEqual(fired.transitions[0].quietHours, true, "The suppressed transition must be marked as quiet-hours.");
  assert.strictEqual(fired.alerts.length, 1, "The alert must still be tracked while quiet.");

  at("2026-01-01T23:45:00.000Z");
  const again = alertService.evaluateAlerts(snapshot);
  const alert = again.alerts.find((entry) => entry.id === "alert:NODE_OFFLINE:node-quiet");
  assert.strictEqual(alert.occurrences, 2, "Occurrences must accumulate while quiet.");
  assert.strictEqual(again.transitions.length, 0, "A repeated condition stays deduped while quiet.");

  // Recovery during quiet hours is suppressed but still clears + emits one marker.
  at("2026-01-01T23:50:00.000Z");
  const quietRecovery = alertService.evaluateAlerts({ nodes: [{ nodeId: "node-quiet", state: "online" }] });
  assert.strictEqual(countTransitions(quietRecovery, "RECOVERED"), 1, "Quiet recovery must still emit one marker.");
  assert.strictEqual(quietRecovery.transitions[0].emitted, false, "Quiet recovery emission must be suppressed.");
  assert.strictEqual(quietRecovery.alerts.length, 0, "Quiet recovery must still clear the active alert.");

  alertService.configureAlertService({ quietHours: { enabled: false, start: "22:00", end: "07:00" } });
  at("2026-01-01T12:00:00.000Z");
  const outside = alertService.evaluateAlerts(snapshot);
  assert.strictEqual(outside.quietHoursActive, false, "Midday must be outside the quiet window.");
  assert.strictEqual(outside.transitions[0].emitted, true, "Outside quiet hours emission resumes.");
}

// ---------------------------------------------------------------------------
// Phase E: restart persistence + reconciliation.
// ---------------------------------------------------------------------------
function phaseRestartReconciliation() {
  const offline = { nodes: [{ nodeId: "node-restart", state: "offline" }] };
  const online = { nodes: [{ nodeId: "node-restart", state: "online" }] };

  at("2026-01-01T12:00:00.000Z");
  const before = alertService.evaluateAlerts(offline);
  assert.strictEqual(countTransitions(before, "FIRED"), 1, "Pre-restart evaluation must fire.");

  // Simulate a desktop restart: in-memory state is dropped, the store survives.
  alertService.resetAlertService({ keepStore: true });
  assert(fs.existsSync(alertService.resolveStorePath()), "The alert store must survive a restart.");
  const reloaded = alertService.getActiveAlerts();
  assert.strictEqual(reloaded.length, 1, "The active alert must be reloaded from the persisted store after a restart.");
  assert.strictEqual(reloaded[0].occurrences, 1, "Reloaded state must reflect the persisted occurrence count, not re-derive it.");

  at("2026-01-01T12:30:00.000Z");
  const afterRestart = alertService.evaluateAlerts(offline);
  assert.strictEqual(countTransitions(afterRestart, "FIRED"), 0, "A restart must not re-fire an already-active alert as new.");
  const reconciled = afterRestart.alerts.find((alert) => alert.id === "alert:NODE_OFFLINE:node-restart");
  assert(reconciled, "The active alert must be reloaded from the persisted store.");
  assert.strictEqual(reconciled.occurrences, 2, "Occurrences must continue across a restart.");
  assert.strictEqual(reconciled.firstSeenAt, "2026-01-01T12:00:00.000Z", "firstSeenAt must survive a restart.");

  // The condition vanished while the desktop was offline: reconcile on restart.
  alertService.resetAlertService({ keepStore: true });
  at("2026-01-01T13:00:00.000Z");
  const vanished = alertService.evaluateAlerts(online);
  assert.strictEqual(countTransitions(vanished, "RECOVERED"), 1, "A condition that vanished while offline must reconcile as RECOVERED.");
  assert.strictEqual(vanished.alerts.length, 0, "Reconciled alerts must clear.");
}

// ---------------------------------------------------------------------------
// Phase F: acknowledge semantics.
// ---------------------------------------------------------------------------
function phaseAcknowledge() {
  const offline = { nodes: [{ nodeId: "node-ack", state: "offline" }] };
  at("2026-01-01T12:00:00.000Z");
  alertService.evaluateAlerts(offline);
  const id = "alert:NODE_OFFLINE:node-ack";

  const acknowledged = alertService.acknowledgeAlert({ id, actor: "matrix-owner" });
  assert.strictEqual(acknowledged.acknowledgedAt, "2026-01-01T12:00:00.000Z", "Acknowledge must stamp acknowledgedAt.");
  assert.strictEqual(acknowledged.acknowledgedBy, "matrix-owner", "Acknowledge must record the actor.");
  assert.strictEqual(alertService.listAlerts().alerts.find((alert) => alert.id === id).acknowledgedAt, "2026-01-01T12:00:00.000Z", "Acknowledgement must persist in the active set.");

  assert.throws(() => alertService.acknowledgeAlert({ id: "alert:NODE_OFFLINE:missing" }), (error) => error.code === "ALERT_NOT_FOUND", "Acknowledging an inactive alert must be refused.");
  assert.throws(() => alertService.acknowledgeAlert({}), (error) => error.code === "ALERT_ID_REQUIRED", "Acknowledge without an id must be refused.");

  // Recovery then a fresh occurrence: the new alert must be unacknowledged and
  // must fire again (acknowledge is not a suppression flag).
  at("2026-01-01T12:10:00.000Z");
  alertService.evaluateAlerts({ nodes: [{ nodeId: "node-ack", state: "online" }] });
  at("2026-01-01T12:20:00.000Z");
  const refired = alertService.evaluateAlerts(offline);
  assert.strictEqual(countTransitions(refired, "FIRED"), 1, "A new occurrence after recovery must re-fire.");
  const fresh = refired.alerts.find((alert) => alert.id === id);
  assert.strictEqual(fresh.acknowledgedAt, null, "A new occurrence must be unacknowledged.");
  assert.strictEqual(fresh.occurrences, 1, "A new occurrence must restart its occurrence count.");
}

// ---------------------------------------------------------------------------
// Phase G: corrupt-store quarantine happens exactly once.
// ---------------------------------------------------------------------------
function phaseCorruptQuarantine() {
  const storePath = alertService.resolveStorePath();
  fs.writeFileSync(storePath, "{ this is not valid json");
  alertService.resetAlertService({ keepStore: true });

  at("2026-01-01T12:00:00.000Z");
  alertService.evaluateAlerts({ nodes: [{ nodeId: "node-quarantine", state: "offline" }] });
  assert.strictEqual(quarantineFiles().length, 1, "A corrupt store must be quarantined exactly once.");
  assert(alertService.getAlertStoreStatus().quarantine, "The store status must report the quarantine.");

  // The engine persisted a valid store, so a second restart never quarantines again.
  alertService.resetAlertService({ keepStore: true });
  alertService.evaluateAlerts({ nodes: [{ nodeId: "node-quarantine", state: "offline" }] });
  assert.strictEqual(quarantineFiles().length, 1, "A valid store must not be quarantined again.");
  assert.strictEqual(alertService.getAlertStoreStatus().quarantine, null, "No quarantine on a healthy store.");
}

// ---------------------------------------------------------------------------
// Phase H: tier gating at the handler level (both channels).
// ---------------------------------------------------------------------------
// The engine must have a PRODUCTION caller: an inert engine meant alerts:list
// always returned an empty store (review P1 — dead feature). This pins the
// scheduler wiring end to end: the mapper builds the evaluator's snapshot from
// desktop-shaped state, one pass persists real alerts, and the scheduler is
// start/stop idempotent.
async function phaseSchedulerWiring() {
  const alertService = require("../src/services/alertService");
  const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  assert(source.includes("startAlertScheduler"), "main.js must start the alert scheduler (otherwise the engine is dead code).");
  assert(source.includes("stopAlertScheduler"), "main.js must stop the alert scheduler on quit.");

  const mapped = alertService.buildAlertSnapshot({
    nodes: [{ id: "node-a", connection: { status: "offline" }, disk: { usagePercent: 97 } }],
    instances: [{ nodeId: "node-a", id: "inst-1", processState: "failed" }],
  });
  assert.strictEqual(mapped.nodes[0].nodeId, "node-a", "the mapper must carry the node identity through.");
  assert.strictEqual(mapped.nodes[0].state, "offline", "the mapper must read the connection state.");
  assert.strictEqual(mapped.instances[0].nodeId, "node-a", "the mapper must carry the instance node binding.");

  const outcome = await alertService.runAlertEvaluation({
    collectState: async () => ({
      nodes: [{ id: "node-off", connection: { status: "offline" } }],
      instances: [],
    }),
  });
  assert.strictEqual(outcome.ok, true, "an evaluation pass over an injected provider must succeed.");
  assert(outcome.alerts.some((alert) => alert.condition === "NODE_OFFLINE"), "the pass must persist a real node-offline alert.");

  const unavailable = await alertService.runAlertEvaluation({
    collectState: async () => {
      throw Object.assign(new Error("state unavailable"), { code: "STATE_DOWN" });
    },
  });
  assert.strictEqual(unavailable.ok, false, "an unreachable provider must be reported, not fatal.");
  assert.strictEqual(unavailable.errorCode, "STATE_DOWN", "the provider failure code must surface.");

  let passes = 0;
  const stop = alertService.startAlertScheduler({
    collectState: async () => { passes += 1; return { nodes: [], instances: [] }; },
  }, { intervalMs: 10 });
  const stopAgain = alertService.startAlertScheduler({ collectState: async () => ({}) }, { intervalMs: 10 });
  await new Promise((resolve) => setTimeout(resolve, 40));
  stop();
  stopAgain();
  const passesAtStop = passes;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.strictEqual(passes, passesAtStop, "a stopped scheduler must not keep evaluating.");
  assert(passesAtStop >= 1, "the scheduler must run an immediate first pass.");
}

function phaseTierGating() {
  const handlers = new Map();
  const state = { localOwnerUnlocked: false, permissionGranted: false };
  let serviceReached = 0;
  const securityStub = {
    audit: () => {},
    requireLocalOwnerAuthenticated: () => {
      if (!state.localOwnerUnlocked) throw Object.assign(new Error("Locked."), { code: "LOCAL_AUTHENTICATION_REQUIRED" });
    },
    requirePermission: () => {
      if (!state.permissionGranted) throw Object.assign(new Error("Your role does not allow this action."), { code: "PERMISSION_DENIED" });
    },
  };
  const alertServiceStub = {
    listAlerts: () => { serviceReached += 1; return { alerts: [] }; },
    acknowledgeAlert: (payload) => { serviceReached += 1; return { id: payload?.id || "stub" }; },
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
    if (request === "../services/securityService") return securityStub;
    if (request === "../services/alertService") return alertServiceStub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require("../src/ipc/alertsIpc").registerAlertsIpc();
  } finally {
    Module._load = originalLoad;
  }

  const probe = async (channel, payload) => {
    const handler = handlers.get(channel);
    assert(handler, `${channel} must be registered.`);
    let failure = null;
    let result = null;
    try {
      result = await handler({}, payload);
    } catch (error) {
      failure = error;
    }
    return { failure, result };
  };

  const asyncMain = async () => {
    for (const channel of ["alerts:list", "alerts:acknowledge"]) {
      // Locked desktop: the local-owner gate refuses before the tier is read.
      state.localOwnerUnlocked = false;
      state.permissionGranted = true;
      serviceReached = 0;
      const locked = await probe(channel, { id: "alert:NODE_OFFLINE:node-a" });
      assert.strictEqual(locked.failure?.code, "LOCAL_AUTHENTICATION_REQUIRED", `${channel} must refuse a locked desktop with LOCAL_AUTHENTICATION_REQUIRED.`);
      assert.strictEqual(serviceReached, 0, `${channel} must refuse before touching the alert service.`);

      // Unlocked but without the tier: permission denial.
      state.localOwnerUnlocked = true;
      state.permissionGranted = false;
      serviceReached = 0;
      const denied = await probe(channel, { id: "alert:NODE_OFFLINE:node-a" });
      assert.strictEqual(denied.failure?.code, "PERMISSION_DENIED", `${channel} must reject an unauthorized actor with PERMISSION_DENIED.`);
      assert.strictEqual(serviceReached, 0, `${channel} must authorize before touching the alert service.`);
    }

    state.localOwnerUnlocked = true;
    state.permissionGranted = true;
    serviceReached = 0;
    const listResult = await probe("alerts:list", {});
    assert.strictEqual(listResult.failure, null, "alerts:list must resolve for an authorized actor.");
    assert.strictEqual(serviceReached, 1, "alerts:list must reach the alert service exactly once.");
    serviceReached = 0;
    const ackResult = await probe("alerts:acknowledge", { id: "alert:NODE_OFFLINE:node-a" });
    assert.strictEqual(ackResult.failure, null, "alerts:acknowledge must resolve for an authorized actor.");
    assert.strictEqual(serviceReached, 1, "alerts:acknowledge must reach the alert service exactly once.");
    assert.strictEqual(ackResult.result.id, "alert:NODE_OFFLINE:node-a", "alerts:acknowledge must return the acknowledged alert.");
  };

  return asyncMain();
}

async function main() {
  fs.mkdirSync(configDir, { recursive: true });
  alertService.configureAlertService({
    now: () => clockMs,
    quietHours: { enabled: false, start: "22:00", end: "07:00" },
  });
  alertService.resetAlertService({ keepStore: false });
  alertService.configureAlertService({
    now: () => clockMs,
    quietHours: { enabled: false, start: "22:00", end: "07:00" },
  });

  phasePureEvaluator();
  phaseDedup();
  phaseRecovery();
  phaseQuietHours();
  phaseRestartReconciliation();
  phaseAcknowledge();
  phaseCorruptQuarantine();
  await phaseTierGating();
  await phaseSchedulerWiring();

  console.log("alert-engine-smoke passed");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
