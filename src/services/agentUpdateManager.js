// Fleet view of Agent versions, Update All, and the optional automatic update
// schedule. It only decides *which* nodes to update and when; every update
// goes through remoteAgentUpdateService.updateRemoteAgent, which owns the SSH
// checks, the downgrade guard, package verification, workload checks, the
// install and the rollback.
//
// Automatic updates are OFF unless agent-auto-update.json in the config folder
// says {"enabled": true}. A missing or unreadable file means off.

const fs = require("fs");
const path = require("path");
const { compareAgentArtifactVersions, normalizeAgentArtifactVersion } = require("../shared/agentBuildIdentity");

const APPLICATION_HOST_NODE_ID = "application-host";
const AUTO_UPDATE_FILENAME = "agent-auto-update.json";
const DEFAULT_AUTO_UPDATE_POLICY = Object.freeze({
  enabled: false,
  // "notify": list available updates and record them; "apply": install them.
  mode: "notify",
  // Only these computers may update automatically; none until chosen.
  nodeIds: Object.freeze([]),
  days: Object.freeze([0, 1, 2, 3, 4, 5, 6]),
  start: "03:00",
  durationMinutes: 120,
});
const AUTO_UPDATE_TICK_MS = 15 * 60 * 1000;

function nodeName(node) {
  return node?.displayName || node?.name || node?.id || "node";
}

function nodeBuild(node) {
  return normalizeAgentArtifactVersion(node?.connection?.agentArtifactVersion || node?.agentArtifactVersion || "");
}

function nodePlatform(node) {
  return String(node?.platform || node?.connection?.platform || node?.agentIdentity?.platform || "").toLowerCase();
}

// One node's update state against the build this Desktop bundles.
function classifyNodeAgentUpdate(node, { desktopBuild, profile } = {}) {
  const base = { nodeId: node?.id || null, name: nodeName(node), installedBuild: nodeBuild(node) || null, targetBuild: desktopBuild || null, canUpdate: false };
  if (!node || node.id === APPLICATION_HOST_NODE_ID) return { ...base, state: "local", reason: "This PC's Agent updates with AnxOS Control Center." };
  if (!desktopBuild) return { ...base, state: "unknown", reason: "This Desktop cannot read its own Agent build." };
  if (node.connection?.status !== "online") return { ...base, state: "offline", reason: "The computer is not connected." };
  const platform = nodePlatform(node);
  if (platform && platform !== "linux") return { ...base, state: "unsupported", reason: "Agent updates from this Desktop are available for Linux computers." };
  if (!base.installedBuild) {
    return { ...base, state: "unknown-build", reason: "This Agent predates build reporting. Update it once by hand; after that AnxOS can update it." };
  }
  const comparison = compareAgentArtifactVersions(base.installedBuild, desktopBuild);
  if (comparison === null) return { ...base, state: "unknown-build", reason: `AnxOS cannot compare ${base.installedBuild} with ${desktopBuild}.` };
  if (comparison === 0) return { ...base, state: "up-to-date", reason: "Up to date." };
  if (comparison > 0) return { ...base, state: "newer-than-desktop", reason: "This Agent is newer than AnxOS Control Center. Update the app instead." };
  if (!profile) return { ...base, state: "update-available", reason: "Assign an SSH key profile to this computer to update it from here." };
  if (profile.authType !== "privateKey") return { ...base, state: "update-available", reason: "The computer's SSH profile signs in with a password. Set up key sign-in for it on the SSH page to update it from here." };
  return { ...base, state: "update-available", canUpdate: true, reason: `Update ${base.installedBuild} → ${desktopBuild}.` };
}

async function getAgentUpdateOverview({ listNodes, desktopBuild, getProfileForNode }) {
  const nodes = await listNodes();
  const entries = (Array.isArray(nodes) ? nodes : []).map((node) => classifyNodeAgentUpdate(node, { desktopBuild, profile: getProfileForNode(node.id) }));
  const counts = entries.reduce((totals, entry) => ({ ...totals, [entry.state]: (totals[entry.state] || 0) + 1 }), {});
  return { desktopBuild: desktopBuild || null, nodes: entries, counts, updatable: entries.filter((entry) => entry.canUpdate).length };
}

// One at a time, so a bad build stops at the first node it breaks instead of
// the whole fleet. A failure is recorded and the run stops unless asked to
// continue (an expected refusal, like servers running, does not stop it).
const NON_STOPPING_CODES = new Set([
  "REMOTE_AGENT_UPDATE_SERVERS_RUNNING",
  "REMOTE_AGENT_UPDATE_WORKLOADS_UNKNOWN",
  "REMOTE_AGENT_UPDATE_SUDO_REQUIRED",
  "REMOTE_AGENT_UPDATE_ROLLBACK_UNAVAILABLE",
  "REMOTE_AGENT_UPDATE_NODE_UNHEALTHY",
]);

// Hooks, all optional:
//   before(entry)    -> null to go ahead, or { code, message } to skip this
//                       computer (for example servers are running on it)
//   shouldContinue() -> false stops before the next computer (automatic
//                       updates switched off mid-run)
//   record(entry, outcome) -> called with "running" and with the final outcome
async function updateAllAgents({ overview, updateAgent, onProgress = () => {}, before = null, shouldContinue = null, record = null }) {
  const targets = overview.nodes.filter((entry) => entry.canUpdate);
  const results = [];
  const note = async (entry, outcome) => {
    if (record) await Promise.resolve(record(entry, outcome)).catch(() => {});
  };
  let stoppedBy = null;
  for (const entry of targets) {
    if (shouldContinue && !(await shouldContinue())) {
      stoppedBy = { code: "AGENT_UPDATE_DISABLED", message: "Not started: automatic updates were turned off." };
      break;
    }
    const skip = before ? await before(entry) : null;
    if (skip) {
      const outcome = { nodeId: entry.nodeId, name: entry.name, ok: false, skipped: true, code: skip.code, message: skip.message };
      results.push(outcome);
      await note(entry, { status: "skipped", code: skip.code, message: skip.message });
      onProgress({ nodeId: entry.nodeId, name: entry.name, state: "skipped", code: skip.code });
      continue;
    }
    onProgress({ nodeId: entry.nodeId, name: entry.name, state: "running" });
    await note(entry, { status: "running" });
    try {
      const result = await updateAgent(entry.nodeId);
      results.push({ nodeId: entry.nodeId, name: entry.name, ok: true, updated: result?.updated === true, upToDate: result?.upToDate === true, targetBuild: entry.targetBuild });
      await note(entry, { status: result?.upToDate ? "up-to-date" : "succeeded", result });
      onProgress({ nodeId: entry.nodeId, name: entry.name, state: "complete" });
    } catch (error) {
      const stops = !NON_STOPPING_CODES.has(error?.code);
      results.push({ nodeId: entry.nodeId, name: entry.name, ok: false, code: error?.code || "AGENT_UPDATE_FAILED", message: error?.message || String(error), manualCommand: error?.details?.manualCommand || null });
      await note(entry, { status: error?.code === "REMOTE_AGENT_UPDATE_SUDO_REQUIRED" ? "needs-approval" : "failed", error });
      onProgress({ nodeId: entry.nodeId, name: entry.name, state: "failed", code: error?.code || null });
      if (stops) {
        stoppedBy = { code: "AGENT_UPDATE_NOT_STARTED", message: "Not started: an earlier update failed." };
        break;
      }
    }
  }
  const skipped = targets.slice(results.length).map((entry) => ({ nodeId: entry.nodeId, name: entry.name, ok: false, code: stoppedBy?.code || "AGENT_UPDATE_NOT_STARTED", message: stoppedBy?.message || "Not started." }));
  return {
    ok: results.every((result) => result.ok) && skipped.length === 0,
    updated: results.filter((result) => result.updated).length,
    failed: results.filter((result) => !result.ok && !result.skipped).length,
    skippedCount: results.filter((result) => result.skipped).length + skipped.length,
    results: [...results, ...skipped],
  };
}

// ---------------------------------------------------------------- history

const HISTORY_FILENAME = "agent-update-history.json";
const HISTORY_LIMIT = 200;

function readUpdateHistory(configDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(configDir, HISTORY_FILENAME), "utf8"));
    return Array.isArray(raw?.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, filePath);
}

// One entry per attempt, updated in place from "running" to its result.
function recordUpdateHistory(configDir, entry) {
  const entries = readUpdateHistory(configDir);
  const index = entries.findIndex((existing) => existing.id === entry.id);
  if (index >= 0) entries[index] = { ...entries[index], ...entry };
  else entries.unshift(entry);
  writeJsonAtomic(path.join(configDir, HISTORY_FILENAME), { schemaVersion: 1, entries: entries.slice(0, HISTORY_LIMIT) });
  return entry;
}

// Turns an update outcome into a history entry. Rollback is reported from
// what the update itself did, never assumed.
function historyEntryFor({ id, at, trigger, overviewEntry, outcome }) {
  const error = outcome.error || null;
  const rollbackStatus = error?.details?.rollback
    ? (error.details.rollback.verified ? "rolled-back" : "rollback-failed")
    : error?.code === "REMOTE_AGENT_UPDATE_ROLLBACK_UNAVAILABLE" ? "unavailable" : null;
  const result = outcome.result || null;
  // Builds only: the Agent's package.json version is a fixed placeholder
  // (0.1.0) and never describes what is installed. The verified build is what
  // the updated Agent itself reported after the update.
  const verifiedBuild = normalizeAgentArtifactVersion(result?.verifiedBuild || result?.verification?.agentArtifactVersion || "") || null;
  const entry = {
    id,
    at,
    trigger,
    nodeId: overviewEntry.nodeId,
    name: overviewEntry.name,
    fromBuild: overviewEntry.installedBuild || normalizeAgentArtifactVersion(result?.installedBuild || "") || null,
    toBuild: overviewEntry.targetBuild || normalizeAgentArtifactVersion(result?.targetBuild || "") || null,
    verifiedBuild,
    status: outcome.status,
    code: error?.code || outcome.code || null,
    message: error?.message || outcome.message || null,
    manualCommand: error?.details?.manualCommand || null,
    method: result?.method || error?.details?.method || null,
    rollback: rollbackStatus,
  };
  const deferred = Array.isArray(result?.deferredRestarts) ? result.deferredRestarts.filter((name) => typeof name === "string").slice(0, 20) : [];
  if (deferred.length) entry.deferredRestarts = deferred;
  return entry;
}

// ---------------------------------------------------------------- automatic

function parseClock(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

function normalizeAutoUpdatePolicy(raw = {}) {
  const policy = { ...DEFAULT_AUTO_UPDATE_POLICY, nodeIds: [], days: [...DEFAULT_AUTO_UPDATE_POLICY.days] };
  if (!raw || typeof raw !== "object") return policy;
  policy.enabled = raw.enabled === true;
  policy.mode = raw.mode === "apply" ? "apply" : "notify";
  if (Array.isArray(raw.nodeIds)) {
    policy.nodeIds = [...new Set(raw.nodeIds.map((value) => String(value || "").trim()).filter((value) => value && value !== APPLICATION_HOST_NODE_ID && value.length <= 128))].slice(0, 50);
  }
  if (Array.isArray(raw.days)) {
    const days = [...new Set(raw.days.map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))].sort();
    if (days.length) policy.days = days;
  }
  if (parseClock(raw.start) !== null) policy.start = raw.start;
  const duration = Number(raw.durationMinutes);
  if (Number.isInteger(duration) && duration >= 15 && duration <= 720) policy.durationMinutes = duration;
  return policy;
}

function readAutoUpdatePolicy(configDir) {
  try {
    return normalizeAutoUpdatePolicy(JSON.parse(fs.readFileSync(path.join(configDir, AUTO_UPDATE_FILENAME), "utf8")));
  } catch {
    return normalizeAutoUpdatePolicy(null);
  }
}

// The only writer of agent-auto-update.json. What is saved is exactly what the
// scheduler reads on its next tick, so turning it off takes effect at once.
function writeAutoUpdatePolicy(configDir, raw) {
  const policy = normalizeAutoUpdatePolicy(raw);
  writeJsonAtomic(path.join(configDir, AUTO_UPDATE_FILENAME), policy);
  return policy;
}

// Local wall-clock window. A window may cross midnight; it belongs to the day
// it starts on. No loops over time, so DST changes cannot hang it.
function isWithinMaintenanceWindow(policy, now = new Date()) {
  const start = parseClock(policy.start);
  if (start === null) return false;
  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  const today = now.getDay();
  const yesterday = (today + 6) % 7;
  const end = start + policy.durationMinutes;
  if (policy.days.includes(today) && minuteOfDay >= start && minuteOfDay < Math.min(end, 1440)) return true;
  if (end > 1440 && policy.days.includes(yesterday) && minuteOfDay < end - 1440) return true;
  return false;
}

function windowKey(policy, now) {
  const start = parseClock(policy.start);
  const startedYesterday = now.getHours() * 60 + now.getMinutes() < start;
  const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (startedYesterday ? 1 : 0));
  return `${day.getFullYear()}-${day.getMonth() + 1}-${day.getDate()}`;
}

// One tick: run at most once per window, only when enabled and inside it, and
// only for the computers the owner allowed. "notify" records what is
// available; "apply" installs it through updateAllAgents with the same
// checks as Update All, plus a re-read of the policy before every computer.
async function runAutoUpdateTick({ policy, now = new Date(), state, getOverview, updateAgent, before = null, shouldContinue = null, record = null, notify = null }) {
  if (!policy.enabled) return { ran: false, reason: "disabled" };
  if (!isWithinMaintenanceWindow(policy, now)) return { ran: false, reason: "outside-window" };
  const key = windowKey(policy, now);
  if (state.lastWindowKey === key) return { ran: false, reason: "already-ran" };
  state.lastWindowKey = key;
  const overview = await getOverview();
  const allowed = new Set(policy.nodeIds);
  const eligible = (Array.isArray(overview?.nodes) ? overview.nodes : []).filter((entry) => entry.canUpdate && allowed.has(entry.nodeId));
  if (!eligible.length) return { ran: true, reason: "nothing-to-update", result: null };
  if (policy.mode !== "apply") {
    for (const entry of eligible) if (notify) await Promise.resolve(notify(entry)).catch(() => {});
    return { ran: true, reason: "notified", notified: eligible.map((entry) => entry.nodeId) };
  }
  return { ran: true, reason: "updated", result: await updateAllAgents({ overview: { ...overview, nodes: eligible }, updateAgent, before, shouldContinue, record }) };
}

function startAgentAutoUpdateScheduler({ configDir, getOverview, updateAgent, before = null, record = null, notify = null, log = () => {}, intervalMs = AUTO_UPDATE_TICK_MS }) {
  const state = { lastWindowKey: null, running: false };
  // configDir may be a function, resolved at each tick, so registering the
  // scheduler never reads configuration paths up front.
  const dir = () => (typeof configDir === "function" ? configDir() : configDir);
  const tick = async () => {
    if (state.running) return;
    state.running = true;
    try {
      const policy = readAutoUpdatePolicy(dir());
      const outcome = await runAutoUpdateTick({
        policy,
        state,
        getOverview,
        updateAgent,
        before,
        record,
        notify,
        // Switching automatic updates off stops the run before the next computer.
        shouldContinue: () => {
          const current = readAutoUpdatePolicy(dir());
          return current.enabled && current.mode === "apply";
        },
      });
      if (outcome.ran) log(outcome);
    } catch (error) {
      log({ ran: false, reason: "error", message: error?.message || String(error) });
    } finally {
      state.running = false;
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}

// The servers an Agent restart would stop: the running ones the Agent runs
// itself. A service-managed server (type "systemd-service") belongs to its
// own systemd unit; Agent shutdown never stops it (it only stops processes
// it spawned), so it does not block an update. Verified on the VPS: AnxRP
// kept its PID through the 212 and 213 Agent upgrades.
const ACTIVE_SERVER_STATES = new Set(["running", "starting", "restarting", "reloading", "stopping"]);
function serversStoppedByAgentRestart(instances = []) {
  return (Array.isArray(instances) ? instances : []).filter((instance) => (
    ACTIVE_SERVER_STATES.has(String(instance?.state || "").toLowerCase())
    && instance?.type !== "systemd-service"
  ));
}

module.exports = {
  AUTO_UPDATE_FILENAME,
  serversStoppedByAgentRestart,
  HISTORY_FILENAME,
  historyEntryFor,
  readUpdateHistory,
  recordUpdateHistory,
  writeAutoUpdatePolicy,
  DEFAULT_AUTO_UPDATE_POLICY,
  classifyNodeAgentUpdate,
  getAgentUpdateOverview,
  isWithinMaintenanceWindow,
  normalizeAutoUpdatePolicy,
  readAutoUpdatePolicy,
  runAutoUpdateTick,
  startAgentAutoUpdateScheduler,
  updateAllAgents,
};
