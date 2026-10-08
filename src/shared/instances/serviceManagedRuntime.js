"use strict";

// Service-managed instance runtime (ADR 0031 addendum).
//
// A "service-managed" instance is an existing OS service (today: a systemd unit)
// that the Agent OBSERVES and CONTROLS but never OWNS. The OS service manager
// is the single owner of the process. The Agent must therefore never spawn the
// workload for this runtime type; it only asks systemd to start/stop/restart
// the already-defined unit and reads state back from systemd.
//
// Security model:
//   * The record is authored on disk by an operator (root). It cannot be created
//     or edited through the Agent API (see instanceServiceCore guards).
//   * The unit must also be named in AGENT_SYSTEMD_UNIT_ALLOWLIST, which lives in
//     the root-owned /etc/anxos-agent/agent.env. An Agent-writable config.json
//     alone can never grant control over an arbitrary unit.
//   * Control actions run with exact argv, no shell:
//       [sudo -n] /usr/bin/systemctl (start|stop|restart) <unit>
//     so a sudoers rule can pin them verbatim. Reads (show) need no privilege.
//   * Every uncertainty fails closed: an unreadable unit is Unknown, never
//     "Stopped", so a blind Agent can never conclude it is safe to act.

const childProcess = require("child_process");

const SERVICE_MANAGED_TYPE = "systemd-service";
const SERVICE_MANAGER_KIND = "systemd";

const SYSTEMCTL_PATH = "/usr/bin/systemctl";
const JOURNALCTL_PATH = "/usr/bin/journalctl";
const SUDO_PATH = "/usr/bin/sudo";

const UNIT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_.@-]{0,100}\.service$/;
const CONTROL_VERBS = Object.freeze(["start", "stop", "restart"]);
const SHOW_PROPERTIES = Object.freeze([
  "LoadState",
  "ActiveState",
  "SubState",
  "Result",
  "MainPID",
  "ExecMainStatus",
  "NRestarts",
  "ActiveEnterTimestamp",
  "UnitFileState",
]);

// Fixed so a sudoers rule can match the journalctl command line verbatim.
const JOURNAL_FETCH_LINES = 200;

const QUERY_TIMEOUT_MS = 10000;
const CONTROL_TIMEOUT_MS = 90000;
const JOURNAL_TIMEOUT_MS = 15000;

function serviceError(code, statusCode, details = {}) {
  return Object.assign(new Error(code), { code, statusCode, ...details });
}

function isServiceManaged(config) {
  return Boolean(config) && config.type === SERVICE_MANAGED_TYPE;
}

function parseAllowlist(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function validateUnitName(unit) {
  const name = String(unit || "").trim();
  if (!UNIT_NAME_PATTERN.test(name)) {
    throw serviceError("SERVICE_UNIT_INVALID", 500, { unit: name || null });
  }
  return name;
}

function getServiceUnit(config) {
  const manager = config?.serviceManager;
  if (!manager || manager.kind !== SERVICE_MANAGER_KIND) {
    throw serviceError("SERVICE_MANAGER_INVALID", 500);
  }
  return validateUnitName(manager.unit);
}

function defaultExecFile(file, args, options) {
  return new Promise((resolve) => {
    childProcess.execFile(file, args, {
      timeout: options?.timeout || QUERY_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      shell: false,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error ? (typeof error.code === "number" ? error.code : null) : 0,
        errorCode: error && typeof error.code !== "number" ? error.code || null : null,
        killed: Boolean(error?.killed),
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  });
}

function parseShowOutput(text) {
  const values = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) {
      values[line.slice(0, index)] = line.slice(index + 1);
    }
  }
  return values;
}

function normalizeMainPid(value) {
  const pid = Number.parseInt(value, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// "@1791447278" (systemctl --timestamp=unix) or "Thu 2026-10-08 08:14:38 UTC". Anything else (a local
// timezone name, "n/a", empty) is unknown rather than guessed.
function parseSystemdTimestamp(value) {
  const text = String(value || "").trim();
  const unix = text.match(/^@(\d+)(?:\.\d+)?$/);
  if (unix) return Number(unix[1]) * 1000;
  const utc = text.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) (?:UTC|GMT)$/);
  if (utc) return Date.UTC(Number(utc[1]), Number(utc[2]) - 1, Number(utc[3]), Number(utc[4]), Number(utc[5]), Number(utc[6]));
  return null;
}

function describeFromShow(unit, values) {
  const activeEnterTimestampMs = parseSystemdTimestamp(values.ActiveEnterTimestamp);
  return {
    unit,
    loadState: values.LoadState || null,
    activeState: values.ActiveState || null,
    subState: values.SubState || null,
    result: values.Result || null,
    mainPid: normalizeMainPid(values.MainPID),
    execMainStatus: Number.isFinite(Number(values.ExecMainStatus)) ? Number(values.ExecMainStatus) : null,
    restartCount: Number.isFinite(Number(values.NRestarts)) ? Number(values.NRestarts) : null,
    activeEnterTimestampMs,
    activeEnterTimestamp: activeEnterTimestampMs === null ? (values.ActiveEnterTimestamp || null) : new Date(activeEnterTimestampMs).toISOString(),
    unitFileState: values.UnitFileState || null,
  };
}

// Pure mapping from systemd's view to the Agent's instance state names (keys of
// INSTANCE_STATES). Anything not positively understood is UNKNOWN.
function mapSystemdState(description) {
  if (!description || description.loadState !== "loaded") {
    return { stateKey: "UNKNOWN", failureReason: "SERVICE_UNIT_NOT_LOADED" };
  }
  switch (description.activeState) {
    case "active":
    case "reloading":
      return { stateKey: "RUNNING", failureReason: null };
    case "activating":
      return description.subState === "auto-restart"
        ? { stateKey: "RESTARTING", failureReason: null }
        : { stateKey: "STARTING", failureReason: null };
    case "deactivating":
      return { stateKey: "STOPPING", failureReason: null };
    case "inactive":
      return { stateKey: "STOPPED", failureReason: null };
    case "failed": {
      const result = description.result || "";
      const failureReason = result === "signal" || result === "core-dump" ? "PROCESS_KILLED"
        : result === "start-limit-hit" ? "CRASH_LOOP"
          : result === "timeout" ? "START_TIMEOUT"
            : "PROCESS_EXITED";
      return { stateKey: "FAILED", failureReason };
    }
    default:
      return { stateKey: "UNKNOWN", failureReason: "SERVICE_STATE_UNRECOGNIZED" };
  }
}

function isPrivilegeDenied(result) {
  const text = `${result.stderr} ${result.stdout}`.toLowerCase();
  return /a password is required|not in the sudoers|may not run sudo|interactive authentication required|access denied|permission denied|not allowed to execute/.test(text);
}

function truncate(text, limit = 400) {
  const value = String(text || "").trim();
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function parseJournal(text, limit) {
  const lines = String(text || "").split(/\r?\n/).filter(Boolean).slice(-limit);
  return lines.map((line) => {
    const match = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.+-]+)\s+\S+\s+[^\s:]+(?:\[\d+\])?:\s?(.*)$/);
    return match
      ? { at: match[1], stream: "journal", message: match[2] }
      : { at: null, stream: "journal", message: line };
  });
}

function createSystemdController(options = {}) {
  const exec = options.execFile || defaultExecFile;
  const getPlatform = () => options.platform || process.platform;
  const getElevation = () => String(options.elevation ?? process.env.AGENT_SYSTEMD_ELEVATION ?? "none").toLowerCase();
  const getAllowlist = () => (Array.isArray(options.allowlist)
    ? options.allowlist
    : parseAllowlist(process.env.AGENT_SYSTEMD_UNIT_ALLOWLIST));

  function assertSupported() {
    if (getPlatform() !== "linux") {
      throw serviceError("SERVICE_MANAGER_UNSUPPORTED", 501, { platform: getPlatform() });
    }
  }

  function assertUnitAllowed(unitName) {
    const unit = validateUnitName(unitName);
    if (!getAllowlist().includes(unit)) {
      throw serviceError("SERVICE_UNIT_NOT_ALLOWED", 403, { unit });
    }
    return unit;
  }

  // Elevation is explicit and enumerated: never a free-form command prefix.
  function withElevation(file, args) {
    const elevation = getElevation();
    if (elevation === "sudo") {
      return { file: SUDO_PATH, args: ["-n", file, ...args] };
    }
    if (elevation === "none") {
      return { file, args };
    }
    throw serviceError("SERVICE_ELEVATION_INVALID", 500, { elevation });
  }

  async function describe(unitName) {
    assertSupported();
    const unit = assertUnitAllowed(unitName);
    // --timestamp=unix: the default prints the host's LOCAL timezone name, which cannot be parsed reliably.
    const result = await exec(SYSTEMCTL_PATH, ["show", unit, "--no-pager", "--timestamp=unix", `--property=${SHOW_PROPERTIES.join(",")}`], { timeout: QUERY_TIMEOUT_MS });
    if (!result.ok) {
      throw serviceError("SERVICE_QUERY_FAILED", 502, { unit, detail: truncate(result.stderr) });
    }
    const values = parseShowOutput(result.stdout);
    if (!values.LoadState || !values.ActiveState) {
      // Output that does not parse is not evidence of anything.
      throw serviceError("SERVICE_QUERY_FAILED", 502, { unit, detail: "unparseable systemctl output" });
    }
    return describeFromShow(unit, values);
  }

  async function control(verb, unitName) {
    if (!CONTROL_VERBS.includes(verb)) {
      throw serviceError("SERVICE_VERB_INVALID", 500, { verb });
    }
    assertSupported();
    const unit = assertUnitAllowed(unitName);
    const command = withElevation(SYSTEMCTL_PATH, [verb, unit]);
    const result = await exec(command.file, command.args, { timeout: CONTROL_TIMEOUT_MS });
    if (!result.ok) {
      if (isPrivilegeDenied(result)) {
        throw serviceError("SERVICE_CONTROL_DENIED", 403, { unit, verb, detail: truncate(result.stderr) });
      }
      throw serviceError("SERVICE_CONTROL_FAILED", 502, { unit, verb, detail: truncate(result.stderr) });
    }
    return { unit, verb };
  }

  async function readJournal(unitName, limit) {
    assertSupported();
    const unit = assertUnitAllowed(unitName);
    const command = withElevation(JOURNALCTL_PATH, ["-u", unit, "-n", String(JOURNAL_FETCH_LINES), "-o", "short-iso", "--no-pager", "-q"]);
    const result = await exec(command.file, command.args, { timeout: JOURNAL_TIMEOUT_MS });
    if (!result.ok) {
      throw serviceError(isPrivilegeDenied(result) ? "SERVICE_LOGS_DENIED" : "SERVICE_LOGS_FAILED", isPrivilegeDenied(result) ? 403 : 502, { unit, detail: truncate(result.stderr) });
    }
    return parseJournal(result.stdout, Math.max(1, Math.min(Number(limit) || JOURNAL_FETCH_LINES, JOURNAL_FETCH_LINES)));
  }

  function summary() {
    return {
      mechanism: SERVICE_MANAGER_KIND,
      supported: getPlatform() === "linux",
      elevation: getElevation(),
      allowedUnits: [...getAllowlist()],
    };
  }

  return { describe, control, readJournal, summary, assertUnitAllowed };
}

module.exports = {
  SERVICE_MANAGED_TYPE,
  SERVICE_MANAGER_KIND,
  CONTROL_VERBS,
  SHOW_PROPERTIES,
  JOURNAL_FETCH_LINES,
  isServiceManaged,
  getServiceUnit,
  validateUnitName,
  parseAllowlist,
  parseShowOutput,
  parseSystemdTimestamp,
  describeFromShow,
  mapSystemdState,
  parseJournal,
  createSystemdController,
  serviceError,
};
