"use strict";

// Operations layer for service-managed instances (ADR 0031, phase 2).
//
// What this adds on top of the foundation (serviceManagedRuntime.js), WITHOUT changing who owns the
// process: the Agent still only observes the service and asks systemd to start/stop/restart one exact
// unit. Nothing here spawns a process, runs a shell or widens the sudoers allowlist.
//
//   * health   : AnxRP's own status artifact (a JSON file the game resource writes), read-only.
//   * players  : FXServer's loopback HTTP endpoints (/dynamic.json, /players.json), read-only,
//                reduced to a COUNT. Names and identifiers are never kept or logged.
//   * listeners: the kernel's socket tables, read-only.
//   * Safe Restart: the proven production flow as one fail-closed state machine with exactly one
//                restart command, an audit trail, and no retry path.
//
// Every input is operator-authored (the root-owned record and deployment manifest) and validated;
// anything missing, stale, unreadable or inconsistent makes a check FAIL, never pass.

const crypto = require("crypto");
const fs = require("fs/promises");
const http = require("http");
const path = require("path");

const { getServiceUnit, serviceError } = require("./serviceManagedRuntime");

const HISTORY_FILE = "service-history.jsonl";
const DEPLOYMENT_FILE = "deployment.json";

const MAX_STATUS_BYTES = 256 * 1024;
const MAX_HTTP_BYTES = 256 * 1024;
const MAX_DEPLOYMENT_BYTES = 64 * 1024;
const HISTORY_MAX_BYTES = 1024 * 1024;
const HISTORY_KEEP_LINES = 400;
const HISTORY_READ_BYTES = 512 * 1024;
const HTTP_TIMEOUT_MS = 3000;

const DEFAULT_STATUS_MAX_AGE_SECONDS = 120;
const DEFAULT_SAFE_RESTART_TIMEOUT_SECONDS = 180;
const POLL_INTERVAL_MS = 1000;
const STABLE_DWELL_MS = 5000; // after READY, watch briefly for a crash-loop restart before declaring success

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
const DEPLOYMENT_ORIGINS = new Set(["official", "local-unofficial", "ci-unsigned"]);
const SAFE_ID = /^[A-Za-z0-9_.-]{1,80}$/;

function operationsError(code, statusCode, details = {}) {
  return serviceError(code, statusCode, details);
}

// ---------------------------------------------------------------------------
// Configuration (operator-authored; validated, never trusted)
// ---------------------------------------------------------------------------

function parseRoots(value) {
  return String(value || "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : null;
}

// Returns { health, players, listeners, safeRestart, problems }. A part that is missing or invalid is null
// and explained in `problems`; Safe Restart is only available when all three evidence sources are valid.
function normalizeOperationsConfig(config, env = process.env) {
  const problems = [];
  const raw = config?.serviceManager?.operations;
  const result = { health: null, players: null, listeners: null, safeRestart: { timeoutSeconds: DEFAULT_SAFE_RESTART_TIMEOUT_SECONDS }, problems };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push("The instance record has no serviceManager.operations section.");
    return result;
  }

  const health = raw.health;
  if (health) {
    const roots = parseRoots(env.AGENT_SERVICE_STATUS_ROOTS);
    const maxAge = boundedInteger(health.maxAgeSeconds, DEFAULT_STATUS_MAX_AGE_SECONDS, 10, 3600);
    const target = typeof health.path === "string" ? health.path : "";
    if (health.kind !== "anxrp-status-file") problems.push("health.kind must be anxrp-status-file.");
    else if (!target || target.includes("\0") || !path.isAbsolute(target) || path.resolve(target) !== path.normalize(target) || target.split(/[\\/]+/).includes("..") || !target.endsWith(".json")) problems.push("health.path must be a normalized absolute .json path.");
    else if (roots.length === 0) problems.push("AGENT_SERVICE_STATUS_ROOTS is not set in the Agent environment, so no status file may be read.");
    else if (!roots.some((root) => isInside(root, path.resolve(target)))) problems.push("health.path is outside AGENT_SERVICE_STATUS_ROOTS.");
    else if (maxAge === null) problems.push("health.maxAgeSeconds must be an integer from 10 to 3600.");
    else result.health = { kind: health.kind, path: path.resolve(target), maxAgeSeconds: maxAge };
  } else {
    problems.push("health is not configured.");
  }

  const players = raw.players;
  if (players) {
    let url = null;
    try { url = new URL(String(players.baseUrl || "")); } catch { url = null; }
    if (players.kind !== "fxserver-http") problems.push("players.kind must be fxserver-http.");
    else if (!url || url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname) || url.username || url.password || !url.port || (url.pathname !== "/" && url.pathname !== "")) problems.push("players.baseUrl must be a loopback http://host:port origin.");
    else result.players = { kind: players.kind, host: url.hostname === "localhost" ? "127.0.0.1" : url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port) };
  } else {
    problems.push("players is not configured.");
  }

  const listeners = raw.listeners || {};
  const ports = Array.isArray(listeners.ports) && listeners.ports.length ? listeners.ports : (Array.isArray(config?.ports) ? config.ports : []);
  const protocols = Array.isArray(listeners.protocols) && listeners.protocols.length ? listeners.protocols : ["tcp", "udp"];
  if (ports.length && ports.every((port) => Number.isInteger(port) && port >= 1 && port <= 65535) && protocols.every((proto) => proto === "tcp" || proto === "udp")) {
    result.listeners = { ports: [...new Set(ports)], protocols: [...new Set(protocols)] };
  } else {
    problems.push("listeners need at least one valid port and tcp/udp protocols.");
  }

  const timeout = boundedInteger(raw.safeRestart?.timeoutSeconds, DEFAULT_SAFE_RESTART_TIMEOUT_SECONDS, 30, 600);
  if (timeout === null) problems.push("safeRestart.timeoutSeconds must be an integer from 30 to 600.");
  else result.safeRestart.timeoutSeconds = timeout;
  return result;
}

function safeRestartAvailability(operations) {
  const missing = [];
  if (!operations.health) missing.push("health");
  if (!operations.players) missing.push("players");
  if (!operations.listeners) missing.push("listeners");
  return missing.length === 0
    ? { available: true, reason: null }
    : { available: false, reason: `Safe Restart needs ${missing.join(", ")} configured in the instance record. ${operations.problems.join(" ")}`.trim() };
}

// ---------------------------------------------------------------------------
// Evidence readers (all read-only, all bounded)
// ---------------------------------------------------------------------------

function classifyFileError(error, prefix) {
  if (error?.code === "ENOENT") return `${prefix}_MISSING`;
  if (error?.code === "EACCES" || error?.code === "EPERM") return `${prefix}_UNREADABLE`;
  if (error?.code === "TOO_LARGE") return `${prefix}_TOO_LARGE`;
  return `${prefix}_READ_FAILED`;
}

async function readFileBounded(filePath, maxBytes) {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw Object.assign(new Error("not a file"), { code: "NOT_A_FILE" });
    if (stat.size > maxBytes) throw Object.assign(new Error("too large"), { code: "TOO_LARGE" });
    const buffer = Buffer.alloc(stat.size);
    await handle.read(buffer, 0, stat.size, 0);
    return { text: buffer.toString("utf8"), mtimeMs: stat.mtimeMs, size: stat.size };
  } finally {
    await handle.close();
  }
}

function httpGetJson({ host, port, pathname, timeoutMs = HTTP_TIMEOUT_MS, maxBytes = MAX_HTTP_BYTES }) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host, port, path: pathname, method: "GET", timeout: timeoutMs, agent: false, headers: { accept: "application/json" } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(Object.assign(new Error(`HTTP ${response.statusCode}`), { code: "HTTP_STATUS" }));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          request.destroy(Object.assign(new Error("too large"), { code: "TOO_LARGE" }));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(Object.assign(new Error("invalid json"), { code: "INVALID_JSON" })); }
      });
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("timeout"), { code: "TIMEOUT" })));
    request.on("error", reject);
    request.end();
  });
}

function wholeNumber(value) {
  const number = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return Number.isInteger(number) && number >= 0 ? number : null;
}

async function readHealth(health, deps) {
  if (!health) return { configured: false, available: false, ready: false, error: "HEALTH_NOT_CONFIGURED" };
  let file;
  try {
    file = await deps.readFile(health.path, MAX_STATUS_BYTES);
  } catch (error) {
    return { configured: true, available: false, ready: false, error: classifyFileError(error, "HEALTH_FILE") };
  }
  let document;
  try { document = JSON.parse(file.text); } catch { return { configured: true, available: false, ready: false, error: "HEALTH_FILE_INVALID" }; }
  if (!document || typeof document !== "object") return { configured: true, available: false, ready: false, error: "HEALTH_FILE_INVALID" };
  const state = typeof document.state === "string" ? document.state.slice(0, 40) : null;
  const bootId = typeof document.boot_id === "string" && SAFE_ID.test(document.boot_id) ? document.boot_id : null;
  const ageSeconds = Math.max(0, Math.round(((deps.now() - file.mtimeMs) / 1000) * 10) / 10);
  const stale = ageSeconds > health.maxAgeSeconds;
  const sessions = document.sessions && typeof document.sessions === "object"
    ? { active: wholeNumber(document.sessions.active), total: wholeNumber(document.sessions.total), spawned: wholeNumber(document.sessions.spawned), withCharacter: wholeNumber(document.sessions.with_character) }
    : null;
  const version = typeof document.framework?.version === "string" ? document.framework.version : (typeof document.version === "string" ? document.version : null);
  return {
    configured: true,
    available: true,
    // READY only counts when the artifact is fresh and carries a boot id; a stale file proves nothing.
    ready: state === "READY" && !stale && Boolean(bootId),
    state,
    stale,
    ageSeconds,
    bootId,
    version: version ? version.slice(0, 40) : null,
    uptimeSeconds: wholeNumber(Math.round(Number(document.uptime_sec))),
    sessions,
    error: null,
  };
}

async function readPlayers(players, deps) {
  if (!players) return { configured: false, available: false, consistent: false, count: null, error: "PLAYERS_NOT_CONFIGURED" };
  let clients = null;
  let listed = null;
  let error = null;
  try {
    const dynamic = await deps.httpGetJson({ host: players.host, port: players.port, pathname: "/dynamic.json" });
    clients = wholeNumber(dynamic?.clients);
  } catch (caught) { error = `PLAYERS_DYNAMIC_${caught?.code || "FAILED"}`; }
  try {
    const roster = await deps.httpGetJson({ host: players.host, port: players.port, pathname: "/players.json" });
    // Only the length is kept: the roster carries names and identifiers that must never be stored or logged.
    listed = Array.isArray(roster) ? roster.length : null;
  } catch (caught) { error = error || `PLAYERS_ROSTER_${caught?.code || "FAILED"}`; }
  const available = clients !== null && listed !== null;
  const consistent = available && clients === listed;
  return { configured: true, available, consistent, count: consistent ? clients : null, clients, listed, error: available ? (consistent ? null : "PLAYERS_SOURCES_DISAGREE") : (error || "PLAYERS_UNAVAILABLE") };
}

async function readListeners(listeners, deps) {
  if (!listeners) return { configured: false, available: false, allListening: false, ports: [], error: "LISTENERS_NOT_CONFIGURED" };
  let rows = null;
  try { rows = await deps.listListeningSockets(); } catch { rows = null; }
  if (!Array.isArray(rows)) return { configured: true, available: false, allListening: false, ports: [], error: "LISTENERS_UNAVAILABLE" };
  const ports = listeners.ports.map((port) => {
    const protocols = listeners.protocols.map((protocol) => ({ protocol, listening: rows.some((row) => row.port === port && row.protocol === protocol) }));
    return { port, protocols, listening: protocols.every((entry) => entry.listening) };
  });
  return { configured: true, available: true, allListening: ports.every((entry) => entry.listening), ports, error: null };
}

function summarizeSystemd(description, nowMs) {
  if (!description) return null;
  const enteredMs = Number.isFinite(description.activeEnterTimestampMs) ? description.activeEnterTimestampMs : null;
  return {
    unit: description.unit,
    loadState: description.loadState,
    activeState: description.activeState,
    subState: description.subState,
    result: description.result,
    mainPid: description.mainPid,
    restartCount: description.restartCount,
    unitFileState: description.unitFileState,
    activeEnterTimestamp: description.activeEnterTimestamp,
    activeEnterTimestampMs: enteredMs,
    uptimeSeconds: enteredMs !== null && description.activeState === "active" ? Math.max(0, Math.round((nowMs - enteredMs) / 1000)) : null,
  };
}

// ---------------------------------------------------------------------------
// Deployment manifest: operator-authored, read-only to the Agent
// ---------------------------------------------------------------------------

function text(value, limit = 300) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f]/g, " ").slice(0, limit) : null;
}

function hex64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value) ? value.toLowerCase() : null;
}

async function describePath(target, deps) {
  if (!target) return { state: "not-declared" };
  try {
    await deps.statPath(target);
    return { state: "present" };
  } catch (error) {
    // EACCES means the Agent cannot see it, which is different from it being gone.
    return { state: error?.code === "ENOENT" ? "missing" : "unverifiable" };
  }
}

async function readDeployment(instanceDir, deps) {
  const agent = deps.agentBuild ? deps.agentBuild() : null;
  const base = { declared: false, unofficial: null, matchesRunningAgent: null, runningAgent: agent };
  let file;
  try {
    file = await deps.readFile(path.join(instanceDir, DEPLOYMENT_FILE), MAX_DEPLOYMENT_BYTES);
  } catch (error) {
    return { ...base, error: error?.code === "ENOENT" ? null : classifyFileError(error, "DEPLOYMENT_FILE") };
  }
  let document;
  try { document = JSON.parse(file.text); } catch { return { ...base, error: "DEPLOYMENT_FILE_INVALID" }; }
  if (!document || typeof document !== "object" || document.schema !== 1) return { ...base, error: "DEPLOYMENT_FILE_INVALID" };
  const origin = DEPLOYMENT_ORIGINS.has(document.agentBuild?.origin) ? document.agentBuild.origin : "unknown";
  const artifact = document.rollback?.artifact || {};
  const backup = document.rollback?.backup || {};
  const declaredVersion = text(document.agentBuild?.artifactVersion, 60);
  return {
    declared: true,
    // Anything that is not explicitly the official release is flagged, including an unrecognized value.
    unofficial: origin !== "official",
    origin,
    agentBuild: {
      artifactVersion: declaredVersion,
      sha256: hex64(document.agentBuild?.sha256),
      builtFromCommit: text(document.agentBuild?.builtFromCommit, 64),
      since: text(document.agentBuild?.since, 40),
      note: text(document.agentBuild?.note, 500),
    },
    matchesRunningAgent: agent && declaredVersion ? agent.artifactVersion === declaredVersion : null,
    runningAgent: agent,
    rollback: {
      artifact: { name: text(artifact.name, 120), path: text(artifact.path, 300), sha256: hex64(artifact.sha256), ...(await describePath(artifact.path, deps)) },
      backup: { dir: text(backup.dir, 300), createdAt: text(backup.createdAt, 40), manifestSha256: hex64(backup.manifestSha256), ...(await describePath(backup.dir, deps)) },
    },
    notes: Array.isArray(document.notes) ? document.notes.slice(0, 10).map((note) => text(note, 300)).filter(Boolean) : [],
    error: null,
  };
}

// ---------------------------------------------------------------------------
// History (append-only JSONL under the Agent-writable logs/ directory)
// ---------------------------------------------------------------------------

function createHistoryStore(deps) {
  function historyPath(config) {
    return path.join(deps.instanceDir(config), "logs", HISTORY_FILE);
  }

  async function checkWritable(config) {
    try {
      await fs.mkdir(path.dirname(historyPath(config)), { recursive: true });
      await fs.appendFile(historyPath(config), "", { mode: 0o600 });
      return true;
    } catch {
      return false;
    }
  }

  async function append(config, entry) {
    const file = historyPath(config);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    try {
      const stat = await fs.stat(file);
      if (stat.size > HISTORY_MAX_BYTES) {
        const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
        const temp = `${file}.${process.pid}.tmp`;
        await fs.writeFile(temp, `${lines.slice(-HISTORY_KEEP_LINES).join("\n")}\n`, { mode: 0o600 });
        await fs.rename(temp, file);
      }
    } catch { /* rotation is best effort; the append already succeeded */ }
  }

  async function readLines(config) {
    const file = historyPath(config);
    let handle;
    try {
      handle = await fs.open(file, "r");
      const stat = await handle.stat();
      const length = Math.min(stat.size, HISTORY_READ_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, stat.size - length);
      const lines = buffer.toString("utf8").split("\n");
      if (stat.size > length) lines.shift(); // the first line of a tail read may be cut in half
      return lines.filter(Boolean);
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw operationsError("SERVICE_HISTORY_UNREADABLE", 500);
    } finally {
      await handle?.close();
    }
  }

  // Merges `started` and `finished` records into one operation each, newest first. A started record with
  // no finished record that is not running in this process was cut off (Agent restart): `interrupted`.
  async function operations(config, { limit = 20, isLive = () => false } = {}) {
    const byId = new Map();
    for (const line of await readLines(config)) {
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || typeof entry.id !== "string") continue;
      byId.set(entry.id, { ...(byId.get(entry.id) || {}), ...entry });
    }
    const merged = [...byId.values()].map((entry) => (entry.phase === "started" && !isLive(entry.id) ? { ...entry, phase: "finished", outcome: "interrupted", finishedAt: entry.finishedAt || null } : entry));
    merged.sort((left, right) => String(right.startedAt || right.at || "").localeCompare(String(left.startedAt || left.at || "")));
    return merged.slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)));
  }

  return { append, operations, checkWritable, historyPath };
}

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

function createServiceOperations(deps) {
  const history = createHistoryStore(deps);
  const active = new Map(); // instanceId -> live operation (also the in-process restart lock)
  const recent = new Map(); // operationId -> last known operation (for polling right after it finishes)

  function operationsFor(config) {
    return normalizeOperationsConfig(config, deps.env || process.env);
  }

  function isBusy(instanceId) {
    return active.has(instanceId);
  }

  async function snapshot(config, operations, { includeWait = false } = {}) {
    const unit = getServiceUnit(config);
    const nowMs = deps.now();
    const [description, health, players, listeners] = await Promise.all([
      deps.describe(unit).catch((error) => ({ __error: error?.code || "SERVICE_QUERY_FAILED" })),
      readHealth(operations.health, deps),
      readPlayers(operations.players, deps),
      readListeners(operations.listeners, deps),
    ]);
    const systemd = description?.__error ? { error: description.__error } : summarizeSystemd(description, nowMs);
    return { at: new Date(nowMs).toISOString(), systemd, anxrp: health, players, listeners };
  }

  async function overview(config, { historyLimit = 5 } = {}) {
    const operations = operationsFor(config);
    const [state, deployment, recentOperations] = await Promise.all([
      snapshot(config, operations),
      readDeployment(deps.instanceDir(config), deps),
      history.operations(config, { limit: historyLimit, isLive: (id) => [...active.values()].some((operation) => operation.id === id) }).catch(() => []),
    ]);
    const availability = safeRestartAvailability(operations);
    return {
      instanceId: config.id,
      unit: getServiceUnit(config),
      ...state,
      configuration: { problems: operations.problems, statusMaxAgeSeconds: operations.health?.maxAgeSeconds ?? null },
      deployment,
      safeRestart: { ...availability, busy: isBusy(config.id), timeoutSeconds: operations.safeRestart.timeoutSeconds },
      recentOperations,
    };
  }

  function check(id, label, passed, detail, status) {
    return { id, label, status: status || (passed ? "pass" : "fail"), detail };
  }

  // Read-only. Every check must PASS; unknown, unavailable and ambiguous all fail.
  async function preflight(config, options = {}) {
    const operations = operationsFor(config);
    const checks = [];
    const availability = safeRestartAvailability(operations);
    checks.push(check("configured", "Safe Restart is configured for this instance", availability.available, availability.available ? "Health, players and listeners are configured." : availability.reason));
    const unit = (() => { try { return getServiceUnit(config); } catch { return null; } })();
    checks.push(check("instance", "Correct instance and unit", Boolean(unit) && config.type === "systemd-service" && (!options.expectedUnit || options.expectedUnit === unit), unit ? (options.expectedUnit && options.expectedUnit !== unit ? `The request expected ${options.expectedUnit} but this instance runs ${unit}.` : `${config.id} runs ${unit}.`) : "The instance record has no valid service unit."));
    if (!availability.available || !unit) return finalizePreflight(checks, null);

    const state = await snapshot(config, operations);
    const systemd = state.systemd;
    const healthy = Boolean(systemd) && !systemd.error && systemd.loadState === "loaded" && systemd.activeState === "active" && systemd.subState === "running" && Number(systemd.mainPid) > 0;
    checks.push(check("systemd", "Service is active and running", healthy, healthy ? `${unit} is active (MainPID ${systemd.mainPid}).` : (systemd?.error ? `systemd could not be read (${systemd.error}).` : `${unit} is ${systemd?.activeState || "unknown"}/${systemd?.subState || "unknown"}; Safe Restart only restarts a healthy running service. Use Start for a stopped or failed one.`)));
    const pidMatches = options.expectedMainPid === undefined || options.expectedMainPid === null || Number(options.expectedMainPid) === systemd?.mainPid;
    checks.push(check("expected-pid", "Matches the process you were looking at", pidMatches, pidMatches ? "MainPID is unchanged since the page was loaded." : `The page showed MainPID ${options.expectedMainPid} but systemd now reports ${systemd?.mainPid}. Refresh and review before restarting.`));
    const busyElsewhere = isBusy(config.id);
    checks.push(check("exclusive", "No other restart is in progress", !busyElsewhere, busyElsewhere ? "A Safe Restart is already running for this instance." : "No restart is running."));
    const anxrp = state.anxrp;
    checks.push(check("anxrp-ready", "AnxRP reports READY (fresh)", anxrp.ready, anxrp.ready ? `AnxRP is READY (boot ${anxrp.bootId}, status ${anxrp.ageSeconds}s old).` : (anxrp.available ? (anxrp.stale ? `The AnxRP status file is ${anxrp.ageSeconds}s old, which is stale; its state cannot be trusted.` : `AnxRP state is ${anxrp.state || "unknown"}, not READY.`) : `AnxRP health could not be read (${anxrp.error}).`)));
    const players = state.players;
    const playersPass = players.available && players.consistent && players.count === 0;
    checks.push(check("players", "No players are connected", playersPass, playersPass ? "FXServer reports 0 connected players (both endpoints agree)." : (players.available && players.consistent ? `${players.count} player(s) connected. Safe Restart will not disconnect players.` : `Player count cannot be verified (${players.error}). Safe Restart fails closed.`)));
    const listeners = state.listeners;
    checks.push(check("listeners", "Game ports are listening", listeners.available && listeners.allListening, listeners.available ? (listeners.allListening ? `Listening on ${listeners.ports.map((entry) => entry.port).join(", ")}.` : "A configured port is not listening, so the service looks unhealthy.") : `Listening sockets cannot be read (${listeners.error}).`));
    const writable = await history.checkWritable(config);
    checks.push(check("audit", "Restart history can be written", writable, writable ? "The audit trail is writable." : "The history file cannot be written; no un-audited restart is allowed."));
    return finalizePreflight(checks, state);
  }

  function finalizePreflight(checks, state) {
    return { ok: checks.every((entry) => entry.status === "pass"), checks, state, at: new Date(deps.now()).toISOString() };
  }

  async function refuse(config, pre, options) {
    const entry = { v: 1, id: deps.newId(), kind: "safe-restart", phase: "finished", outcome: "refused", startedAt: new Date(deps.now()).toISOString(), finishedAt: new Date(deps.now()).toISOString(), requestedBy: options.requestedBy || "agent-api", correlationId: options.correlationId || null, refusal: pre.checks.filter((entry) => entry.status !== "pass").map(({ id, label, detail }) => ({ id, label, detail })), pre: compactState(pre.state) };
    try { await history.append(config, entry); } catch { /* the refusal itself is still returned */ }
    throw operationsError("SERVICE_SAFE_RESTART_REFUSED", 409, { checks: pre.checks, operationId: entry.id });
  }

  function compactState(state) {
    if (!state) return null;
    return {
      mainPid: state.systemd?.mainPid ?? null,
      activeEnterTimestamp: state.systemd?.activeEnterTimestamp ?? null,
      restartCount: state.systemd?.restartCount ?? null,
      bootId: state.anxrp?.bootId ?? null,
      anxrpState: state.anxrp?.state ?? null,
      players: state.players?.count ?? null,
      sessionsActive: state.anxrp?.sessions?.active ?? null,
    };
  }

  // Validates and starts one Safe Restart. Returns as soon as the restart flow is running (the caller polls).
  // The returned `completion` promise exists for tests and never rejects.
  async function startSafeRestart(config, options = {}) {
    if (options.confirm !== true) throw operationsError("SERVICE_SAFE_RESTART_CONFIRMATION_REQUIRED", 400);
    if (isBusy(config.id)) throw operationsError("SERVICE_OPERATION_IN_PROGRESS", 409, { instanceId: config.id });
    const operations = operationsFor(config);
    const pre = await preflight(config, options);
    if (!pre.ok) return refuse(config, pre, options);
    // Claim the lock only after the preflight, and re-check: two requests can pass preflight together.
    if (isBusy(config.id)) throw operationsError("SERVICE_OPERATION_IN_PROGRESS", 409, { instanceId: config.id });
    const operation = {
      id: deps.newId(),
      kind: "safe-restart",
      instanceId: config.id,
      unit: getServiceUnit(config),
      phase: "started",
      outcome: null,
      startedAt: new Date(deps.now()).toISOString(),
      steps: [],
      pre: compactState(pre.state),
      requestedBy: options.requestedBy || "agent-api",
      correlationId: options.correlationId || null,
    };
    active.set(config.id, operation);
    recent.set(operation.id, operation);
    try {
      // Written before the restart command so a crash mid-flow still leaves a trace.
      await history.append(config, { v: 1, id: operation.id, kind: operation.kind, phase: "started", startedAt: operation.startedAt, unit: operation.unit, pre: operation.pre, requestedBy: operation.requestedBy, correlationId: operation.correlationId });
    } catch {
      active.delete(config.id);
      throw operationsError("SERVICE_HISTORY_UNWRITABLE", 409);
    }
    const completion = runSafeRestart(config, operations, operation, pre.state, options).catch(() => {});
    return { operation: publicOperation(operation), completion };
  }

  function step(operation, id, label, status, detail) {
    const entry = { id, label, status, detail: detail || null, at: new Date(deps.now()).toISOString() };
    const index = operation.steps.findIndex((existing) => existing.id === id);
    if (index === -1) operation.steps.push(entry); else operation.steps[index] = entry;
    return entry;
  }

  async function runSafeRestart(config, operations, operation, before, options) {
    const unit = operation.unit;
    const timeoutMs = operations.safeRestart.timeoutSeconds * 1000;
    const startedMs = deps.now();
    const deadline = startedMs + timeoutMs;
    let outcome = "failed";
    let failure = null;
    let after = null;
    try {
      step(operation, "preflight", "Preflight checks", "pass", "All checks passed.");
      // The players check is repeated immediately before the command: the preflight can be seconds old.
      const recheck = await readPlayers(operations.players, deps);
      if (!(recheck.available && recheck.consistent && recheck.count === 0)) {
        step(operation, "players-recheck", "Players re-checked right before restart", "fail", recheck.count > 0 ? `${recheck.count} player(s) connected.` : `Player count cannot be verified (${recheck.error}).`);
        outcome = "refused";
        failure = "A player connected or the count became unverifiable; nothing was restarted.";
        return;
      }
      step(operation, "players-recheck", "Players re-checked right before restart", "pass", "0 players.");

      step(operation, "restart", "Restart command (exactly one)", "running", `systemctl restart ${unit}`);
      try {
        await deps.control("restart", unit);
      } catch (error) {
        // No retry, ever. The outcome of a failed command is read back below, read-only.
        step(operation, "restart", "Restart command (exactly one)", "fail", error?.code || "SERVICE_CONTROL_FAILED");
        failure = error?.code || "SERVICE_CONTROL_FAILED";
        outcome = "failed";
        return;
      }
      step(operation, "restart", "Restart command (exactly one)", "pass", "systemd accepted the restart.");

      // 1. a new main process
      step(operation, "new-process", "New service process", "running");
      let current = null;
      while (deps.now() < deadline) {
        const description = await deps.describe(unit).catch(() => null);
        current = summarizeSystemd(description, deps.now());
        const newerStart = !Number.isFinite(before.systemd?.activeEnterTimestampMs) || !Number.isFinite(current?.activeEnterTimestampMs) || current.activeEnterTimestampMs > before.systemd.activeEnterTimestampMs;
        if (current && current.activeState === "active" && current.subState === "running" && Number(current.mainPid) > 0 && current.mainPid !== before.systemd.mainPid && newerStart) break;
        current = null;
        await deps.sleep(POLL_INTERVAL_MS);
      }
      if (!current) { step(operation, "new-process", "New service process", "fail", "No new active MainPID before the timeout."); outcome = "timeout"; failure = "The service did not come back with a new process in time."; return; }
      step(operation, "new-process", "New service process", "pass", `MainPID ${before.systemd.mainPid} -> ${current.mainPid}.`);

      // 2. listeners
      step(operation, "listeners", "Game ports listening", "running");
      let listening = null;
      while (deps.now() < deadline) {
        listening = await readListeners(operations.listeners, deps);
        if (listening.available && listening.allListening) break;
        await deps.sleep(POLL_INTERVAL_MS);
      }
      if (!(listening?.available && listening.allListening)) { step(operation, "listeners", "Game ports listening", "fail", listening?.available ? "A configured port is not listening." : `Listening sockets unreadable (${listening?.error}).`); outcome = "timeout"; failure = "The game ports were not listening in time."; return; }
      step(operation, "listeners", "Game ports listening", "pass", listening.ports.map((entry) => entry.port).join(", "));

      // 3. AnxRP READY with a new boot id
      step(operation, "ready", "AnxRP READY with a new boot id", "running");
      let health = null;
      while (deps.now() < deadline) {
        health = await readHealth(operations.health, deps);
        if (health.ready && health.bootId && health.bootId !== before.anxrp.bootId) break;
        await deps.sleep(POLL_INTERVAL_MS);
      }
      if (!(health?.ready && health.bootId && health.bootId !== before.anxrp.bootId)) { step(operation, "ready", "AnxRP READY with a new boot id", "fail", health?.available ? `State ${health.state || "unknown"}, boot ${health.bootId || "none"} (was ${before.anxrp.bootId}).` : `Health unreadable (${health?.error}).`); outcome = "timeout"; failure = "AnxRP did not report READY with a new boot id in time."; return; }
      step(operation, "ready", "AnxRP READY with a new boot id", "pass", `boot ${before.anxrp.bootId} -> ${health.bootId}.`);

      // 4. the service must still be the same new process, and must not have restarted itself meanwhile
      await deps.sleep(STABLE_DWELL_MS);
      const settled = summarizeSystemd(await deps.describe(unit).catch(() => null), deps.now());
      const stable = settled && settled.activeState === "active" && settled.mainPid === current.mainPid && (!Number.isFinite(before.systemd.restartCount) || !Number.isFinite(settled.restartCount) || settled.restartCount === before.systemd.restartCount);
      if (!stable) { step(operation, "stable", "Service stable after restart", "fail", "The process changed again or systemd restarted it on its own (possible crash loop)."); outcome = "failed"; failure = "The service did not stay on the new process."; return; }
      step(operation, "stable", "Service stable after restart", "pass", `MainPID ${settled.mainPid}, NRestarts unchanged.`);
      outcome = "succeeded";
      after = { systemd: settled, anxrp: health, players: await readPlayers(operations.players, deps), listeners: listening };
    } catch (error) {
      outcome = "failed";
      failure = error?.code || "SERVICE_SAFE_RESTART_FAILED";
    } finally {
      operation.phase = "finished";
      operation.outcome = outcome;
      operation.finishedAt = new Date(deps.now()).toISOString();
      operation.durationMs = deps.now() - startedMs;
      operation.error = failure;
      if (!after) {
        // Read-only look at what state we ended in, for the record.
        try { after = { systemd: summarizeSystemd(await deps.describe(unit), deps.now()), anxrp: await readHealth(operations.health, deps) }; } catch { after = null; }
      }
      operation.post = after ? { mainPid: after.systemd?.mainPid ?? null, activeState: after.systemd?.activeState ?? null, activeEnterTimestamp: after.systemd?.activeEnterTimestamp ?? null, bootId: after.anxrp?.bootId ?? null, anxrpState: after.anxrp?.state ?? null, players: after.players?.count ?? null } : null;
      try {
        await history.append(config, { v: 1, id: operation.id, kind: operation.kind, phase: "finished", outcome, finishedAt: operation.finishedAt, durationMs: operation.durationMs, steps: operation.steps.slice(0, 20), post: operation.post, error: failure });
      } catch { /* the in-memory record still serves this process; the lock must be released regardless */ }
      active.delete(config.id);
    }
  }

  function publicOperation(operation) {
    return { id: operation.id, kind: operation.kind, instanceId: operation.instanceId, unit: operation.unit, phase: operation.phase, outcome: operation.outcome, startedAt: operation.startedAt, finishedAt: operation.finishedAt || null, durationMs: operation.durationMs ?? null, steps: operation.steps.map((entry) => ({ ...entry })), pre: operation.pre, post: operation.post || null, error: operation.error || null };
  }

  async function getOperation(config, operationId) {
    if (!SAFE_ID.test(String(operationId || ""))) throw operationsError("SERVICE_OPERATION_NOT_FOUND", 404);
    const live = recent.get(operationId);
    if (live && live.instanceId === config.id) return publicOperation(live);
    const [found] = (await history.operations(config, { limit: 100, isLive: () => false })).filter((entry) => entry.id === operationId);
    if (!found) throw operationsError("SERVICE_OPERATION_NOT_FOUND", 404);
    return found;
  }

  // Best-effort audit of the ordinary start/stop/restart buttons, so the history is complete.
  async function recordLifecycle(config, kind, outcome, details = {}) {
    const now = new Date(deps.now()).toISOString();
    try {
      await history.append(config, { v: 1, id: deps.newId(), kind, phase: "finished", outcome, startedAt: now, finishedAt: now, requestedBy: details.requestedBy || "agent-api", correlationId: details.correlationId || null, pre: details.pre || null, post: details.post || null, error: details.error || null });
    } catch { /* never block a lifecycle action on the audit file */ }
  }

  async function readHistory(config, { limit = 20 } = {}) {
    return history.operations(config, { limit, isLive: (id) => [...active.values()].some((operation) => operation.id === id) });
  }

  return { overview, preflight, startSafeRestart, getOperation, readHistory, recordLifecycle, isBusy, normalizeConfig: operationsFor };
}

function defaultDeps(overrides = {}) {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    newId: () => `op_${crypto.randomBytes(8).toString("hex")}`,
    readFile: readFileBounded,
    httpGetJson,
    statPath: (target) => fs.stat(target),
    env: process.env,
    ...overrides,
  };
}

module.exports = {
  HISTORY_FILE,
  DEPLOYMENT_FILE,
  normalizeOperationsConfig,
  safeRestartAvailability,
  readHealth,
  readPlayers,
  readListeners,
  readDeployment,
  createHistoryStore,
  createServiceOperations,
  defaultDeps,
  readFileBounded,
  httpGetJson,
};
