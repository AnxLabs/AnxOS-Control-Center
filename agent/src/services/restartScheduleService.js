// V2-E scheduled instance restarts with player-visible warnings
// (docs/MASTER_ROADMAP.md: "…and scheduled tasks" / "Provide maintenance
// windows, restart warnings where supported, and workload-aware
// backup/update sequencing").
//
// Per-instance schedules persisted next to the other agent-managed stores
// (same style as the backup schedule file: atomic JSON writes, one
// dedicated directory). The tick runs alongside the backup scheduler and
// always goes through the canonical instance lifecycle restart path — it
// never signals a raw process kill, and it never starts a stopped instance.

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");

const { getConfig } = require("../config");

const RESTART_SCHEDULE_SCHEMA_VERSION = 1;
const DEFAULT_WARN_MINUTES = 5;
const MIN_WARN_MINUTES = 1;
const MAX_WARN_MINUTES = 24 * 60;
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 24 * 30;
const SHORT_WARN_LEAD_MS = 60 * 1000;
const SCHEDULER_INTERVAL_MS = 60 * 1000;

let schedulerStarted = false;
let schedulerTimer = null;
let tickInFlight = null;
let configuredRoot = null;

// Test seams: the hermetic smoke injects a clock and fake executors so no
// real instance is required. Production executors are resolved lazily so a
// plain require of this module stays cheap.
const executors = {
  now: null,
  isInstanceRunning: null,
  warnInstance: null,
  restartInstance: null,
};

let lazyInstanceService = null;

function getInstanceService() {
  if (!lazyInstanceService) {
    lazyInstanceService = require("./instances/instanceService");
  }
  return lazyInstanceService;
}

function defaultNow() {
  return Date.now();
}

async function defaultIsInstanceRunning(instanceId) {
  const status = await getInstanceService().getStatus(instanceId);
  return String(status?.state || "") === "Running";
}

async function defaultWarnInstance(instanceId, message) {
  return getInstanceService().writeInstanceInput(instanceId, message);
}

async function defaultRestartInstance(instanceId) {
  return getInstanceService().restartInstance(instanceId);
}

// Assign only the provided seams; passing null restores the production
// default for that seam (used by tests that toggle between fakes).
function configureRestartScheduleService(overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, "root")) {
    configuredRoot = overrides.root ? path.resolve(overrides.root) : null;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, "now")) {
    executors.now = overrides.now || defaultNow;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, "isInstanceRunning")) {
    executors.isInstanceRunning = overrides.isInstanceRunning || defaultIsInstanceRunning;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, "warnInstance")) {
    executors.warnInstance = overrides.warnInstance || defaultWarnInstance;
  }
  if (Object.prototype.hasOwnProperty.call(overrides, "restartInstance")) {
    executors.restartInstance = overrides.restartInstance || defaultRestartInstance;
  }
}

configureRestartScheduleService({
  now: null,
  isInstanceRunning: null,
  warnInstance: null,
  restartInstance: null,
});

function now() {
  return (executors.now || defaultNow)();
}

function nowIso(atMs = now()) {
  return new Date(atMs).toISOString();
}

function createRestartScheduleError(code, statusCode = 400, details = {}) {
  return Object.assign(new Error(code), { code, statusCode, details });
}

function getScheduleRoot() {
  if (configuredRoot) return configuredRoot;
  return path.resolve(
    process.env.AGENT_RESTART_SCHEDULE_ROOT
      || path.join(path.dirname(getConfig().instanceRoot), "restart-schedules"),
  );
}

function schedulesPath() {
  return path.join(getScheduleRoot(), "schedules.json");
}

async function ensureScheduleRoot() {
  await fs.mkdir(getScheduleRoot(), { recursive: true, mode: 0o700 });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempPath, filePath);
}

async function readSchedules() {
  await ensureScheduleRoot();
  const filePath = schedulesPath();
  if (!await fs.stat(filePath).then((stats) => stats.isFile(), () => false)) return [];
  let parsed;
  try {
    parsed = await readJson(filePath);
  } catch (error) {
    // COPYFILE_EXCL caps the quarantine at one file (the backupService
    // precedent): a persistently corrupt store hit on every 60s tick must
    // not grow the schedule dir forever.
    const backupPath = `${filePath}.corrupt`;
    await fs.copyFile(filePath, backupPath, fs.constants.COPYFILE_EXCL).catch(() => {});
    throw createRestartScheduleError("RESTART_SCHEDULE_STORE_CORRUPT", 500, { causeCode: error?.code || "INVALID_JSON" });
  }
  const schemaVersion = Number.isInteger(parsed?.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > RESTART_SCHEDULE_SCHEMA_VERSION) {
    throw createRestartScheduleError("RESTART_SCHEDULE_SCHEMA_UNSUPPORTED", 409, {
      schemaVersion,
      supportedSchemaVersion: RESTART_SCHEDULE_SCHEMA_VERSION,
    });
  }
  return Array.isArray(parsed?.schedules) ? parsed.schedules : [];
}

async function writeSchedules(schedules) {
  await ensureScheduleRoot();
  await writeJson(schedulesPath(), { schemaVersion: RESTART_SCHEDULE_SCHEMA_VERSION, schedules });
}

function validateInstanceId(value) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(id)) {
    throw createRestartScheduleError("INVALID_INSTANCE_ID");
  }
  return id;
}

function validateScheduleId(value) {
  const id = String(value || "").trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{7,80}$/.test(id)) {
    throw createRestartScheduleError("INVALID_RESTART_SCHEDULE_ID");
  }
  return id;
}

// "HH:MM" in the agent's local time. Returns minutes since midnight, or null
// when the value is not a valid daily time.
function parseDailyTime(value) {
  const text = String(value || "").trim();
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!match) {
    return null;
  }
  return Number.parseInt(match[1], 10) * 60 + Number.parseInt(match[2], 10);
}

function parseWarnMinutes(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_WARN_MINUTES;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < MIN_WARN_MINUTES || parsed > MAX_WARN_MINUTES) {
    throw createRestartScheduleError("INVALID_RESTART_WARN_MINUTES");
  }
  return parsed;
}

// Next occurrence of a local wall-clock time strictly after fromMs.
function nextDailyRunMs(minutesOfDay, fromMs) {
  const candidate = new Date(fromMs);
  candidate.setHours(Math.floor(minutesOfDay / 60), minutesOfDay % 60, 0, 0);
  let next = candidate.getTime();
  while (next <= fromMs) {
    next += 24 * 60 * 60 * 1000;
    // Re-anchor to the wall clock after each day step: a raw +24h drifts
    // ±1h across DST transitions even though cadence stays "daily".
    candidate.setTime(next);
    candidate.setHours(Math.floor(minutesOfDay / 60), minutesOfDay % 60, 0, 0);
    next = candidate.getTime();
  }
  return next;
}

// Advance a schedule's due time while preserving its cadence: restarts stay
// anchored to the previous due time instead of drifting forward from "now",
// so an agent that was offline still keeps its original rhythm.
function nextDueAtMs(schedule, previousDueAtMs, fromMs) {
  if (schedule.type === "daily") {
    const minutesOfDay = parseDailyTime(schedule.dailyTime);
    let next = previousDueAtMs;
    if (!Number.isFinite(next)) {
      next = nextDailyRunMs(minutesOfDay, fromMs);
    }
    while (next <= fromMs) {
      next += 24 * 60 * 60 * 1000;
    }
    return next;
  }
  const intervalMs = (Number(schedule.intervalHours) || MIN_INTERVAL_HOURS) * 60 * 60 * 1000;
  let next = Number.isFinite(previousDueAtMs) ? previousDueAtMs + intervalMs : fromMs + intervalMs;
  while (next <= fromMs) {
    next += intervalMs;
  }
  return next;
}

function freshWarnState(dueAtMs) {
  return {
    dueAt: new Date(dueAtMs).toISOString(),
    longSentAt: null,
    shortSentAt: null,
  };
}

function buildSchedulePayload(payload = {}, existing = null) {
  const type = String(payload.type || existing?.type || "interval") === "daily" ? "daily" : "interval";
  // Create defaults to enabled; an update without an explicit enabled field
  // preserves the stored value so the enable/disable toggle can flip it.
  const enabled = payload.enabled !== undefined
    ? payload.enabled !== false
    : existing ? existing.enabled !== false : true;
  const schedule = {
    ...(existing || {}),
    type,
    enabled,
  };

  if (type === "daily") {
    const dailyTime = payload.dailyTime !== undefined ? payload.dailyTime : existing?.dailyTime;
    if (parseDailyTime(dailyTime) === null) {
      throw createRestartScheduleError("INVALID_RESTART_DAILY_TIME");
    }
    schedule.dailyTime = String(dailyTime).trim();
    schedule.intervalHours = null;
  } else {
    const rawInterval = payload.intervalHours !== undefined ? payload.intervalHours : existing?.intervalHours;
    const intervalHours = Number.parseInt(rawInterval, 10);
    if (!Number.isFinite(intervalHours) || intervalHours < MIN_INTERVAL_HOURS || intervalHours > MAX_INTERVAL_HOURS) {
      throw createRestartScheduleError("INVALID_RESTART_INTERVAL");
    }
    schedule.intervalHours = intervalHours;
    schedule.dailyTime = null;
  }

  schedule.warnMinutes = parseWarnMinutes(
    payload.warnMinutes !== undefined ? payload.warnMinutes : existing?.warnMinutes,
  );
  return schedule;
}

async function listRestartSchedules(instanceId = null) {
  const filterId = instanceId === null ? null : validateInstanceId(instanceId);
  const schedules = await readSchedules();
  const filtered = filterId === null
    ? schedules
    : schedules.filter((schedule) => schedule.instanceId === filterId);
  filtered.sort((left, right) => `${left.instanceId}:${left.createdAt}`.localeCompare(`${right.instanceId}:${right.createdAt}`));
  return { schedules: filtered };
}

async function createRestartSchedule(payload = {}) {
  const instanceId = validateInstanceId(payload.instanceId);
  const schedules = await readSchedules();
  const atMs = now();
  const schedule = buildSchedulePayload({ ...payload, instanceId });
  schedule.id = `rs${crypto.randomBytes(9).toString("hex")}`;
  schedule.instanceId = instanceId;
  schedule.nextRunAt = new Date(nextDueAtMs(schedule, Number.NaN, atMs)).toISOString();
  schedule.warnState = freshWarnState(Date.parse(schedule.nextRunAt));
  schedule.createdAt = nowIso(atMs);
  schedule.updatedAt = schedule.createdAt;
  schedule.lastRunAt = null;
  schedule.lastError = null;
  schedule.skippedAt = null;
  schedule.skipReason = null;
  schedules.push(schedule);
  await writeSchedules(schedules);
  return { schedule };
}

async function getRestartSchedule(id) {
  const scheduleId = validateScheduleId(id);
  const schedules = await readSchedules();
  const schedule = schedules.find((entry) => entry.id === scheduleId);
  if (!schedule) {
    throw createRestartScheduleError("RESTART_SCHEDULE_NOT_FOUND", 404);
  }
  return schedule;
}

async function updateRestartSchedule(id, payload = {}, options = {}) {
  const scheduleId = validateScheduleId(id);
  const schedules = await readSchedules();
  const index = schedules.findIndex((entry) => entry.id === scheduleId);
  if (index === -1) {
    throw createRestartScheduleError("RESTART_SCHEDULE_NOT_FOUND", 404);
  }
  const atMs = now();
  const previous = schedules[index];
  // Authz scope: a schedule belongs to exactly one instance. A caller whose
  // permissions cover the PATH instance but not the schedule's own instance
  // must not be able to retime, enable or delete it (the path instance gate
  // alone would allow instance A's rights to control instance B's schedule).
  assertScheduleInScope(previous, options);
  const updated = buildSchedulePayload({ ...payload, instanceId: previous.instanceId }, previous);
  const timingChanged = updated.type !== previous.type
    || updated.intervalHours !== previous.intervalHours
    || updated.dailyTime !== previous.dailyTime;
  // Re-enabling (or retiming) a schedule re-anchors its next run from now so
  // an edit never fires instantly from a stale due time.
  if (timingChanged || (updated.enabled && previous.enabled === false)) {
    updated.nextRunAt = new Date(nextDueAtMs(updated, Number.NaN, atMs)).toISOString();
    updated.warnState = freshWarnState(Date.parse(updated.nextRunAt));
  }
  updated.id = previous.id;
  updated.instanceId = previous.instanceId;
  updated.createdAt = previous.createdAt;
  updated.updatedAt = nowIso(atMs);
  updated.lastRunAt = previous.lastRunAt ?? null;
  updated.lastError = previous.lastError ?? null;
  // A retimed (or re-enabled) schedule starts a clean cycle: the previous
  // skip marker described an old due time and must not leak into the new one.
  const reanchored = timingChanged || updated.nextRunAt !== previous.nextRunAt;
  updated.skippedAt = reanchored ? null : previous.skippedAt ?? null;
  updated.skipReason = reanchored ? null : previous.skipReason ?? null;
  schedules[index] = updated;
  await writeSchedules(schedules);
  return { schedule: updated };
}

async function deleteRestartSchedule(id, options = {}) {
  const scheduleId = validateScheduleId(id);
  const schedules = await readSchedules();
  const target = schedules.find((entry) => entry.id === scheduleId);
  if (!target) {
    throw createRestartScheduleError("RESTART_SCHEDULE_NOT_FOUND", 404);
  }
  assertScheduleInScope(target, options);
  const remaining = schedules.filter((entry) => entry.id !== scheduleId);
  await writeSchedules(remaining);
  return { id: scheduleId, deleted: true };
}

// Instance-scope guard for schedule mutations reached through an
// instance-scoped path: the schedule must belong to that instance. Reported
// as NOT_FOUND so a wrong instance path never confirms another instance's
// schedule existence.
function assertScheduleInScope(schedule, options) {
  if (options?.instanceScope !== undefined && schedule.instanceId !== options.instanceScope) {
    throw createRestartScheduleError("RESTART_SCHEDULE_NOT_FOUND", 404);
  }
}

async function sendWarning(schedule, message) {
  // Warnings are a best-effort courtesy channel: a failed stdin write (for
  // example the process exited between the liveness check and the write)
  // must never block the restart itself.
  try {
    await (executors.warnInstance || defaultWarnInstance)(schedule.instanceId, message);
  } catch {}
}

async function evaluateSchedule(schedule, changed) {
  const atMs = now();
  const dueAtMs = Date.parse(schedule.nextRunAt);
  if (!Number.isFinite(dueAtMs)) {
    schedule.nextRunAt = new Date(nextDueAtMs(schedule, Number.NaN, atMs)).toISOString();
    schedule.warnState = freshWarnState(Date.parse(schedule.nextRunAt));
    changed.value = true;
    return;
  }

  if (!schedule.warnState || schedule.warnState.dueAt !== schedule.nextRunAt) {
    schedule.warnState = freshWarnState(dueAtMs);
    changed.value = true;
  }

  const warnMinutes = Number(schedule.warnMinutes) || DEFAULT_WARN_MINUTES;
  const longLeadMinutes = warnMinutes > 1 ? warnMinutes : null;

  // Still before the due time: emit staged warnings to the running server.
  if (atMs < dueAtMs) {
    let running = null;
    try {
      running = await (executors.isInstanceRunning || defaultIsInstanceRunning)(schedule.instanceId);
    } catch (error) {
      schedule.lastError = error?.code || "RESTART_SCHEDULE_STATUS_FAILED";
      changed.value = true;
      return;
    }
    if (!running) {
      return;
    }
    if (longLeadMinutes && atMs >= dueAtMs - warnMinutes * 60 * 1000 && !schedule.warnState.longSentAt) {
      await sendWarning(schedule, `AnxOS scheduled restart in ${warnMinutes} minute(s).`);
      schedule.warnState.longSentAt = nowIso(atMs);
      changed.value = true;
    }
    if (atMs >= dueAtMs - SHORT_WARN_LEAD_MS && !schedule.warnState.shortSentAt) {
      await sendWarning(schedule, "AnxOS scheduled restart in about 1 minute.");
      schedule.warnState.shortSentAt = nowIso(atMs);
      changed.value = true;
    }
    return;
  }

  // Due (or overdue): the instance must already be running — a stopped
  // instance is skipped, never started.
  let running = null;
  try {
    running = await (executors.isInstanceRunning || defaultIsInstanceRunning)(schedule.instanceId);
  } catch (error) {
    schedule.lastError = error?.code || "RESTART_SCHEDULE_STATUS_FAILED";
    changed.value = true;
    return;
  }
  if (!running) {
    schedule.skippedAt = nowIso(atMs);
    schedule.skipReason = "INSTANCE_NOT_RUNNING";
    schedule.lastError = null;
    schedule.nextRunAt = new Date(nextDueAtMs(schedule, dueAtMs, atMs)).toISOString();
    schedule.warnState = freshWarnState(Date.parse(schedule.nextRunAt));
    changed.value = true;
    return;
  }

  try {
    // Cold-start fallback: the agent may have been offline across both warn
    // thresholds. Deliver any unsent warnings in order before the restart so
    // connected players always receive notice.
    if (longLeadMinutes && !schedule.warnState.longSentAt) {
      await sendWarning(schedule, `AnxOS scheduled restart in ${warnMinutes} minute(s).`);
      schedule.warnState.longSentAt = nowIso(atMs);
    }
    if (!schedule.warnState.shortSentAt) {
      await sendWarning(schedule, "AnxOS scheduled restart in about 1 minute.");
      schedule.warnState.shortSentAt = nowIso(atMs);
    }
    await (executors.restartInstance || defaultRestartInstance)(schedule.instanceId);
    schedule.lastRunAt = nowIso(atMs);
    schedule.lastError = null;
  } catch (error) {
    schedule.lastError = error?.code || "RESTART_SCHEDULE_FAILED";
  }

  schedule.skippedAt = null;
  schedule.skipReason = null;
  schedule.nextRunAt = new Date(nextDueAtMs(schedule, dueAtMs, atMs)).toISOString();
  schedule.warnState = freshWarnState(Date.parse(schedule.nextRunAt));
  changed.value = true;
}

async function runDueSchedules() {
  // Overlapping ticks share one evaluation so a due restart fires exactly
  // once even if the interval timer and a manual evaluation collide.
  if (tickInFlight) {
    return tickInFlight;
  }
  tickInFlight = (async () => {
    const schedules = await readSchedules();
    const changed = { value: false };
    for (const schedule of schedules) {
      if (!schedule.enabled) {
        continue;
      }
      try {
        await evaluateSchedule(schedule, changed);
      } catch {
        // A malformed schedule entry must not stop the remaining schedules;
        // the store keeps the raw entry and the next tick retries.
      }
    }
    if (changed.value) {
      await writeSchedules(schedules);
    }
    return { evaluated: schedules.length, changed: changed.value };
  })();
  try {
    return await tickInFlight;
  } finally {
    tickInFlight = null;
  }
}

function startRestartScheduler() {
  if (schedulerStarted) {
    return;
  }
  schedulerStarted = true;
  schedulerTimer = setInterval(() => {
    runDueSchedules().catch(() => {});
  }, SCHEDULER_INTERVAL_MS).unref?.();
  runDueSchedules().catch(() => {});
}

function stopRestartScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  schedulerStarted = false;
}

module.exports = {
  DEFAULT_WARN_MINUTES,
  MAX_INTERVAL_HOURS,
  MIN_INTERVAL_HOURS,
  RESTART_SCHEDULE_SCHEMA_VERSION,
  configureRestartScheduleService,
  createRestartSchedule,
  deleteRestartSchedule,
  getRestartSchedule,
  listRestartSchedules,
  runDueSchedules,
  startRestartScheduler,
  stopRestartScheduler,
  updateRestartSchedule,
};
