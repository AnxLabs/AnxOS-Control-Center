// V2-J Wave 1 alert engine (docs/MASTER_ROADMAP.md bullet 3): alerts for disk
// pressure, node failure/offline, backup age and resource exhaustion with
// deduplication and quiet recovery behavior.
//
// Design (bounded + deterministic, dedup-first):
// - deriveAlertConditions(snapshot, options) is the PURE evaluator: no I/O, no
//   clock, no persistence. It turns an injected snapshot into a stable,
//   ordered list of condition descriptors.
// - evaluateAlerts(snapshot, options) is the stateful engine around it: it
//   loads/persists active-alert state, deduplicates by stable condition id,
//   counts occurrences, emits exactly one RECOVERED transition when a
//   condition disappears, and reconciles across desktop restarts.
// - quietHours suppresses EMISSION (notifications) only. State tracking is
//   untouched: occurrences still accumulate and alerts are still persisted, so
//   nothing is lost while the window is active — the deltas are replayed to
//   consumers on the next evaluation outside the window (emitted=false marks
//   suppressed transitions). This is the documented choice: an operator who
//   checks after quiet hours sees the same active alerts and occurrence counts
//   as if quiet hours were never configured.
//
// Thresholds mirror existing project constants rather than inventing new ones:
// - DISK_WARNING_PERCENT 85 / DISK_CRITICAL_PERCENT 95  -> app.js
//   NODE_HEALTH_RESOURCE_THRESHOLDS diskWarningPercent/diskCriticalPercent.
// - DEFAULT_BACKUP_MAX_AGE_DAYS 30 -> agent backupService DEFAULT_RETENTION_DAYS;
//   a snapshot row's own retentionPolicy.maxAgeDays wins when the payload
//   already carries it (agent backupService exposes retentionPolicy on each
//   backup record).
const fs = require("fs");
const path = require("path");

const ALERT_SCHEMA_VERSION = 1;
const ALERT_STORE_FILE = "alerts.json";

const DISK_WARNING_PERCENT = 85;
const DISK_CRITICAL_PERCENT = 95;
const DEFAULT_BACKUP_MAX_AGE_DAYS = 30;

const CONDITION = Object.freeze({
  NODE_OFFLINE: "NODE_OFFLINE",
  DISK_PRESSURE: "DISK_PRESSURE",
  BACKUP_AGE: "BACKUP_AGE",
  INSTANCE_DEGRADED: "INSTANCE_DEGRADED",
});

// A node is healthy only when its connection state resolves to "online".
// Every other recorded state (offline, degraded, authentication_failed,
// agent_incompatible, connecting, unknown) is surfaced as NODE_OFFLINE, with
// the severity split below so a hard outage outranks a transient state.
const HEALTHY_NODE_STATES = new Set(["online"]);
const CRITICAL_NODE_STATES = new Set(["offline", "authentication_failed", "agent_incompatible"]);

// Instance failure states are critical; degraded readiness is a warning.
const INSTANCE_FAILURE_STATES = new Set(["failed", "crashed", "unhealthy", "error"]);
const INSTANCE_DEGRADED_STATES = new Set(["degraded", "timeout"]);

class AlertStoreError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "AlertStoreError";
    this.code = code;
    this.details = details;
  }
}

// Test/embedded seam. `storePath` pins the persistence target, `now` injects
// the clock, `quietHours` injects the window, `persist:false` keeps the engine
// fully in-memory. Configure once at process/test start; production callers
// rely on the ANXHUB_CONFIG_DIR / electron userData defaults below.
const overrides = {
  storePath: null,
  now: null,
  quietHours: null,
  persist: true,
};

// In-memory mirror of the persisted active-alert set, keyed by stable id.
let activeAlerts = new Map();
let loaded = false;
let quarantineReport = null;

function configureAlertService(next = {}) {
  if (Object.prototype.hasOwnProperty.call(next, "storePath")) overrides.storePath = next.storePath || null;
  if (Object.prototype.hasOwnProperty.call(next, "now")) overrides.now = typeof next.now === "function" ? next.now : null;
  if (Object.prototype.hasOwnProperty.call(next, "quietHours")) overrides.quietHours = next.quietHours || null;
  if (Object.prototype.hasOwnProperty.call(next, "persist")) overrides.persist = next.persist !== false;
}

// Clears in-memory state. `keepStore: true` (default) simulates a desktop
// restart without discarding the persisted store; the next evaluate reloads
// from disk and reconciles. `keepStore: false` also resets the seam so an
// isolated test can start clean.
function resetAlertService(options = {}) {
  activeAlerts = new Map();
  loaded = false;
  quarantineReport = null;
  if (options.keepStore !== true) {
    overrides.storePath = null;
    overrides.now = null;
    overrides.quietHours = null;
    overrides.persist = true;
  }
}

function nowIso() {
  return new Date(typeof overrides.now === "function" ? overrides.now() : Date.now()).toISOString();
}

function resolveConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) return process.env.ANXHUB_CONFIG_DIR;
  try {
    // Loaded lazily so hermetic smokes that pin ANXHUB_CONFIG_DIR never touch
    // the Electron runtime. Under plain Node this require resolves to the
    // electron binary path string, so the app guard below simply falls through.
    const electron = require("electron");
    const app = electron && electron.app;
    if (app && typeof app.getPath === "function") return path.join(app.getPath("userData"), "config");
  } catch {}
  return path.join(process.cwd(), "config");
}

function resolveStorePath() {
  if (overrides.storePath) return overrides.storePath;
  if (process.env.ANXOS_ALERTS_STORE) return process.env.ANXOS_ALERTS_STORE;
  return path.join(resolveConfigDirectory(), ALERT_STORE_FILE);
}

// ---------------------------------------------------------------------------
// Pure normalization helpers
// ---------------------------------------------------------------------------
function asNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function alertId(condition, target) {
  return `alert:${condition}:${target}`;
}

function nodesOf(snapshot) {
  return Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
}

function nodeIdOf(node, index) {
  const id = node?.nodeId ?? node?.id ?? node?.name;
  return String(id || `node-${index}`).trim() || `node-${index}`;
}

function normalizeNodeState(node) {
  const raw = node?.state ?? node?.health ?? node?.connection?.status ?? node?.status ?? "";
  const state = String(raw || "").trim().toLowerCase();
  return state || "unknown";
}

function readDiskPercent(node) {
  const disk = node?.disk || node?.storage;
  if (!disk || typeof disk !== "object") return null;
  return asNumber(disk.usagePercent ?? disk.usedPercent ?? disk.percent ?? disk.diskUsagePercent);
}

function classifyInstance(row) {
  const states = [row?.healthState, row?.processState, row?.readinessState]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (states.some((state) => INSTANCE_FAILURE_STATES.has(state))) return { degraded: true, severity: "critical" };
  if (states.some((state) => INSTANCE_DEGRADED_STATES.has(state))) return { degraded: true, severity: "warning" };
  return null;
}

// Instances may arrive nested under a node (node.instances) or flattened at
// the snapshot root (snapshot.instances with an explicit nodeId). Both shapes
// normalize into one nodeId/instanceId keyed map; a target is degraded if ANY
// row for it is degraded (worst-wins).
function collectInstanceRows(snapshot) {
  const rows = new Map();
  const add = (nodeId, instance, index) => {
    if (!instance || typeof instance !== "object") return;
    const instanceId = String(instance.instanceId ?? instance.id ?? instance.name ?? `instance-${index}`).trim();
    if (!instanceId) return;
    const key = `${nodeId}\u0000${instanceId}`;
    const classification = classifyInstance(instance);
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, { nodeId, instanceId, classification });
      return;
    }
    if (classification && (!existing.classification || classification.severity === "critical")) {
      existing.classification = classification;
    }
  };
  nodesOf(snapshot).forEach((node, nodeIndex) => {
    const nodeId = nodeIdOf(node, nodeIndex);
    if (Array.isArray(node?.instances)) node.instances.forEach((instance, index) => add(nodeId, instance, index));
  });
  if (Array.isArray(snapshot?.instances)) {
    snapshot.instances.forEach((instance, index) => {
      const nodeId = String(instance?.nodeId || instance?.node || "").trim();
      if (!nodeId) return;
      add(nodeId, instance, index);
    });
  }
  return [...rows.values()];
}

// ---------------------------------------------------------------------------
// Pure evaluator
// ---------------------------------------------------------------------------
function deriveAlertConditions(snapshot = {}, options = {}) {
  const conditions = [];
  const nodes = nodesOf(snapshot);

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const nodeId = nodeIdOf(node, index);
    const state = normalizeNodeState(node);

    if (!HEALTHY_NODE_STATES.has(state)) {
      const severity = CRITICAL_NODE_STATES.has(state) ? "critical" : "warning";
      conditions.push({
        condition: CONDITION.NODE_OFFLINE,
        target: nodeId,
        severity,
        title: "Node offline",
        message: `Node ${nodeId} is ${state}; it is not reporting as online.`,
      });
    }

    const diskPercent = readDiskPercent(node);
    if (diskPercent !== null && diskPercent >= DISK_WARNING_PERCENT) {
      const critical = diskPercent >= DISK_CRITICAL_PERCENT;
      conditions.push({
        condition: CONDITION.DISK_PRESSURE,
        target: nodeId,
        severity: critical ? "critical" : "warning",
        title: "Disk pressure",
        message: `Node ${nodeId} disk usage is ${diskPercent}% (warning ${DISK_WARNING_PERCENT}%, critical ${DISK_CRITICAL_PERCENT}%).`,
      });
    }

    if (Array.isArray(node?.backups)) {
      for (const backup of node.backups) {
        if (!backup || typeof backup !== "object") continue;
        const instanceId = String(backup.instanceId ?? backup.instance ?? "").trim();
        if (!instanceId) continue;
        const ageDays = asNumber(backup.backupAgeDays);
        if (ageDays === null) continue;
        const policyMaxAge = asNumber(backup.retentionPolicy?.maxAgeDays);
        const threshold = policyMaxAge !== null && policyMaxAge > 0 ? policyMaxAge : DEFAULT_BACKUP_MAX_AGE_DAYS;
        if (ageDays > threshold) {
          conditions.push({
            condition: CONDITION.BACKUP_AGE,
            target: `${nodeId}/${instanceId}`,
            severity: "warning",
            title: "Backup age exceeded",
            message: `Newest backup for ${instanceId} on ${nodeId} is ${Math.round(ageDays)} day(s) old (policy ${threshold} day(s)).`,
          });
        }
      }
    }
  }

  for (const row of collectInstanceRows(snapshot)) {
    if (!row.classification) continue;
    conditions.push({
      condition: CONDITION.INSTANCE_DEGRADED,
      target: `${row.nodeId}/${row.instanceId}`,
      severity: row.classification.severity,
      title: "Instance degraded",
      message: `Instance ${row.instanceId} on ${row.nodeId} is not healthy.`,
    });
  }

  // Stable ordering makes the evaluator deterministic for tests and for the
  // persisted-store diff (id -> first appearance order preserved on reload).
  conditions.sort((a, b) => alertId(a.condition, a.target).localeCompare(alertId(b.condition, b.target)));
  if (Array.isArray(options.conditions)) {
    return conditions.filter((condition) => options.conditions.includes(condition.condition));
  }
  return conditions;
}

// ---------------------------------------------------------------------------
// Quiet hours
// ---------------------------------------------------------------------------
function parseClockMinutes(value) {
  const match = String(value ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function resolveQuietHours(options = {}) {
  const quietHours = options.quietHours !== undefined ? options.quietHours : overrides.quietHours;
  if (!quietHours || quietHours.enabled !== true) return null;
  const start = parseClockMinutes(quietHours.start);
  const end = parseClockMinutes(quietHours.end);
  if (start === null || end === null) return null;
  return { start, end };
}

// Half-open window [start, end). A window that wraps midnight (start > end)
// covers the tail of one day and the head of the next.
function isWithinQuietHours(date, window) {
  if (!window) return false;
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  if (window.start === window.end) return false;
  if (window.start < window.end) return minutes >= window.start && minutes < window.end;
  return minutes >= window.start || minutes < window.end;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------
function cloneAlert(alert) {
  return {
    id: alert.id,
    condition: alert.condition,
    severity: alert.severity,
    title: alert.title,
    message: alert.message,
    target: alert.target,
    firstSeenAt: alert.firstSeenAt,
    lastSeenAt: alert.lastSeenAt,
    occurrences: alert.occurrences,
    acknowledgedAt: alert.acknowledgedAt ?? null,
    acknowledgedBy: alert.acknowledgedBy ?? null,
  };
}

function serializeState(evaluatedAt) {
  return {
    schemaVersion: ALERT_SCHEMA_VERSION,
    updatedAt: evaluatedAt || nowIso(),
    active: [...activeAlerts.values()].map(cloneAlert),
  };
}

function persistState(evaluatedAt) {
  if (overrides.persist === false) return;
  const target = resolveStorePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(serializeState(evaluatedAt), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, target);
}

function loadPersistedState() {
  const target = resolveStorePath();
  if (!fs.existsSync(target)) return { active: [], recovered: null };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(target, "utf8"));
  } catch (error) {
    // Corrupt-store quarantine (settingsPreferenceService convention): keep
    // the unreadable file for forensics exactly once, then start from an empty
    // active set. The next persist writes a valid store, so a second load never
    // quarantines again.
    const quarantinePath = `${target}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(target, quarantinePath, fs.constants.COPYFILE_EXCL); } catch {}
    quarantineReport = { path: quarantinePath, code: error?.code || "INVALID_JSON" };
    return { active: [], recovered: quarantineReport };
  }
  const schemaVersion = Number.isInteger(raw?.schemaVersion) ? raw.schemaVersion : 0;
  if (schemaVersion > ALERT_SCHEMA_VERSION) {
    // A newer store is unreadable by this build; quarantine it rather than
    // silently discarding the operator's alert history.
    const quarantinePath = `${target}.corrupt-${Date.now()}`;
    try { fs.copyFileSync(target, quarantinePath, fs.constants.COPYFILE_EXCL); } catch {}
    quarantineReport = { path: quarantinePath, code: "SCHEMA_UNSUPPORTED", schemaVersion };
    return { active: [], recovered: quarantineReport };
  }
  const active = Array.isArray(raw?.active) ? raw.active : [];
  return { active, recovered: null };
}

function ensureLoaded() {
  if (loaded) return;
  const { active } = loadPersistedState();
  activeAlerts = new Map();
  for (const alert of active) {
    if (!alert || typeof alert !== "object" || !alert.id) continue;
    activeAlerts.set(alert.id, cloneAlert(alert));
  }
  loaded = true;
}

// ---------------------------------------------------------------------------
// Stateful engine
// ---------------------------------------------------------------------------
function evaluateAlerts(snapshot = {}, options = {}) {
  ensureLoaded();
  const nowDate = new Date(typeof overrides.now === "function" ? overrides.now() : Date.now());
  const timestamp = nowDate.toISOString();
  const quietWindow = resolveQuietHours(options);
  const suppressed = isWithinQuietHours(nowDate, quietWindow);
  const conditions = deriveAlertConditions(snapshot, options);
  const present = new Map(conditions.map((condition) => [alertId(condition.condition, condition.target), condition]));
  const transitions = [];

  for (const [id, condition] of present) {
    const existing = activeAlerts.get(id);
    if (existing) {
      // Deduplication: the same condition for the same target never creates a
      // second alert while it is active; only the occurrence counter, lastSeen
      // and the refreshed descriptive fields move.
      existing.occurrences += 1;
      existing.lastSeenAt = timestamp;
      existing.severity = condition.severity;
      existing.title = condition.title;
      existing.message = condition.message;
      continue;
    }
    const alert = {
      id,
      condition: condition.condition,
      severity: condition.severity,
      title: condition.title,
      message: condition.message,
      target: condition.target,
      firstSeenAt: timestamp,
      lastSeenAt: timestamp,
      occurrences: 1,
      acknowledgedAt: null,
    };
    activeAlerts.set(id, alert);
    transitions.push({ type: "FIRED", alertId: id, alert: cloneAlert(alert), emitted: !suppressed, quietHours: suppressed });
  }

  // Recovery: a condition absent for this one evaluation pass clears its alert
  // and emits exactly one RECOVERED transition.
  for (const [id, alert] of [...activeAlerts]) {
    if (present.has(id)) continue;
    activeAlerts.delete(id);
    transitions.push({ type: "RECOVERED", alertId: id, alert: cloneAlert(alert), emitted: !suppressed, quietHours: suppressed });
  }

  persistState(timestamp);

  return {
    alerts: getActiveAlerts(),
    transitions,
    evaluatedAt: timestamp,
    quietHoursActive: suppressed,
  };
}

function getActiveAlerts() {
  ensureLoaded();
  return [...activeAlerts.values()].map(cloneAlert);
}

// Renderer-facing read: alerts plus a coarse degraded flag. The absolute store
// path stays internal (getAlertStoreStatus) so the IPC surface cannot leak host
// filesystem layout.
function listAlerts() {
  return {
    alerts: getActiveAlerts(),
    degraded: quarantineReport !== null,
  };
}

function acknowledgeAlert(payload = {}) {
  ensureLoaded();
  const id = String(payload?.id ?? payload?.alertId ?? "").trim();
  if (!id) {
    throw Object.assign(new Error("An alert id is required to acknowledge."), { code: "ALERT_ID_REQUIRED" });
  }
  const alert = activeAlerts.get(id);
  if (!alert) {
    throw Object.assign(new Error("That alert is no longer active."), { code: "ALERT_NOT_FOUND" });
  }
  // Acknowledge records who/when but is deliberately NOT a suppression flag:
  // when the condition recovers the alert clears, and a later occurrence of the
  // same condition is a brand-new alert with acknowledgedAt reset to null.
  alert.acknowledgedAt = nowIso();
  alert.acknowledgedBy = String(payload?.actor ?? "local-owner").slice(0, 120);
  persistState();
  return cloneAlert(alert);
}

function getAlertStoreStatus() {
  return {
    path: resolveStorePath(),
    exists: fs.existsSync(resolveStorePath()),
    quarantine: quarantineReport ? { ...quarantineReport } : null,
  };
}

// ---------------------------------------------------------------------------
// Snapshot collection + scheduler (the production caller).
// The engine is inert without a driver: alerts:list always returned an empty
// store until this wiring landed (review P1 — dead feature). The collector
// reads the SAME desktop state the nodes page already polls, so it adds no new
// network surface; the scheduler runs a bounded interval and is stopped on app
// quit.
// ---------------------------------------------------------------------------
const DEFAULT_EVALUATION_INTERVAL_MS = 60 * 1000;
let evaluationTimer = null;

// SMOOTH-3010: the desktop renderer already polls the instance list every ~5 s
// (instances:list). The scheduler used to make its own agent round trip every
// 60 s (`serviceRouter.listInstances({})`), which duplicated that fetch and
// re-triggered the implicit-node fallback on every call (measured:
// implicit-node-fallback-selected exactly 3x/min at :31 for a whole session).
// Publish the payload the renderer already received and let an evaluation pass
// reuse it while it is fresh and for the same node. When nothing fresh has been
// published (no window polling, or a different node is selected) the caller
// falls back to a real fetch, so alerts keep working unchanged.
const INSTANCE_SNAPSHOT_MAX_AGE_MS = 20000;
let instanceSnapshot = null;

function publishInstanceSnapshot(nodeId, payload) {
  if (!payload || !Array.isArray(payload.instances)) return;
  instanceSnapshot = { nodeId: nodeId || null, at: Date.now(), payload };
}

function getInstanceSnapshot(nodeId, maxAgeMs = INSTANCE_SNAPSHOT_MAX_AGE_MS) {
  if (!instanceSnapshot) return null;
  if ((instanceSnapshot.nodeId || null) !== (nodeId || null)) return null;
  if (Date.now() - instanceSnapshot.at > maxAgeMs) return null;
  return instanceSnapshot.payload;
}

function resetInstanceSnapshot() {
  instanceSnapshot = null;
}

// The scheduler's one decision: reuse a fresh snapshot for the same node, or
// make the fetch. `fetcher` is supplied by the caller (it owns the service
// router), which keeps this module free of an agent dependency.
async function resolveInstanceSnapshot(nodeId, fetcher) {
  const shared = getInstanceSnapshot(nodeId);
  if (shared) return shared;
  return fetcher();
}

// Pure mapper: desktop node/instance/backup state → the evaluator's snapshot.
function buildAlertSnapshot({ nodes = [], instances = [], backups = [], now = Date.now() } = {}) {
  return {
    now,
    nodes: (Array.isArray(nodes) ? nodes : []).map((node) => ({
      nodeId: node?.id || node?.nodeId || node?.deviceId || null,
      state: node?.state || node?.health || node?.connection?.status || null,
      disk: node?.disk || node?.storage || null,
      instances: Array.isArray(node?.instances) ? node.instances : undefined,
    })),
    instances: (Array.isArray(instances) ? instances : []).map((instance) => ({
      nodeId: instance?.nodeId || instance?.node || null,
      instanceId: instance?.id || instance?.instanceId || null,
      processState: instance?.processState || instance?.state || null,
      healthState: instance?.healthState || null,
      readinessState: instance?.readinessState || null,
    })),
    backups: (Array.isArray(backups) ? backups : []).map((row) => ({
      nodeId: row?.nodeId || null,
      instanceId: row?.instanceId || null,
      backupAgeDays: row?.backupAgeDays ?? null,
      retentionPolicy: row?.retentionPolicy || null,
    })),
  };
}

// One evaluation pass over an injected state provider. Never throws to the
// caller: an unreachable provider is reported, not fatal (a monitoring pass
// must not take the app down).
async function runAlertEvaluation(providers = {}, options = {}) {
  const collect = providers.collectState || (async () => ({}));
  let state;
  try {
    state = await collect();
  } catch (error) {
    return { ok: false, errorCode: error?.code || "ALERT_SNAPSHOT_UNAVAILABLE", alerts: listAlerts().alerts };
  }
  const snapshot = buildAlertSnapshot({
    nodes: state?.nodes || [],
    instances: state?.instances || [],
    backups: state?.backups || [],
    now: typeof overrides.now === "function" ? overrides.now() : Date.now(),
  });
  const outcome = evaluateAlerts(snapshot, options);
  return { ok: true, ...outcome };
}

function stopAlertScheduler() {
  if (evaluationTimer) {
    clearInterval(evaluationTimer);
    evaluationTimer = null;
  }
}

function startAlertScheduler(providers = {}, options = {}) {
  if (evaluationTimer) return () => stopAlertScheduler();
  const intervalMs = Number.isFinite(Number(options.intervalMs)) && Number(options.intervalMs) > 0
    ? Number(options.intervalMs)
    : DEFAULT_EVALUATION_INTERVAL_MS;
  const tick = () => {
    runAlertEvaluation(providers, options).catch(() => {});
  };
  tick();
  evaluationTimer = setInterval(tick, intervalMs);
  if (typeof evaluationTimer.unref === "function") evaluationTimer.unref();
  return () => stopAlertScheduler();
}

module.exports = {
  CONDITION,
  DISK_WARNING_PERCENT,
  DISK_CRITICAL_PERCENT,
  DEFAULT_BACKUP_MAX_AGE_DAYS,
  DEFAULT_EVALUATION_INTERVAL_MS,
  ALERT_SCHEMA_VERSION,
  AlertStoreError,
  acknowledgeAlert,
  buildAlertSnapshot,
  configureAlertService,
  deriveAlertConditions,
  evaluateAlerts,
  getActiveAlerts,
  getAlertStoreStatus,
  getInstanceSnapshot,
  INSTANCE_SNAPSHOT_MAX_AGE_MS,
  isWithinQuietHours,
  listAlerts,
  publishInstanceSnapshot,
  resetAlertService,
  resetInstanceSnapshot,
  resolveInstanceSnapshot,
  resolveStorePath,
  runAlertEvaluation,
  startAlertScheduler,
  stopAlertScheduler,
};
