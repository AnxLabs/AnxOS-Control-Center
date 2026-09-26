"use strict";

// systemd service management for the headless Agent CLI. Three installation
// shapes are recognized, in this order:
//
//   system  — a package-managed unit in /lib/systemd/system or /usr/lib/systemd/system.
//             install/uninstall refuse (the package manager owns it); lifecycle
//             actions require root.
//   user    — a per-user unit in ~/.config/systemd/user, which this module can
//             install (source installs) and uninstall without touching data.
//   none    — no unit at all; status reports not-installed and install can create
//             the user unit.
//
// All systemctl interaction goes through an injectable command-runner seam so
// the behavior is testable on any platform without a live init system. Nothing
// in this module ever deletes configuration, instances, or backups.

const fs = require("fs");
const os = require("os");
const path = require("path");
const childProcess = require("child_process");
const { readAgentRuntimeConfig } = require("../../../src/shared/agentRuntimeConfigStore");
const { isWildcardBind } = require("./hostTrustPolicy");

const UNIT_NAME = "anxos-agent.service";
const SYSTEM_UNIT_PATHS = [
  "/lib/systemd/system/anxos-agent.service",
  "/usr/lib/systemd/system/anxos-agent.service",
];
const DEFAULT_PORT = 47131;
const DEFAULT_HOST = "127.0.0.1";
const COMMAND_TIMEOUT_MS = 15000;
const WILDCARD_OR_LOOPBACK = new Set(["", "*", "0.0.0.0", "::", "127.0.0.1", "localhost", "::1"]);

class ServiceManagerError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ServiceManagerError";
    this.code = code;
    if (options.details) this.details = options.details;
    if (options.recoverySuggestion) this.recoverySuggestion = options.recoverySuggestion;
  }
}

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function execFileRunner(command, args, options = {}) {
  return new Promise((resolve) => {
    childProcess.execFile(
      command,
      args,
      { timeout: options.timeoutMs || COMMAND_TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: typeof error?.code === "number" ? error.code : error ? 1 : 0,
          errorCode: typeof error?.code === "string" ? error.code : null,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      },
    );
  });
}

function defaultIsRoot() {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

// systemd units are line-oriented: an embedded CR/LF would start a new
// directive or continuation line. Every value embedded into a unit passes
// through here; AGENT_HOST is additionally validated and rejected outright
// (resolveUnitBindHost) because it is operator-supplied.
function stripUnitLineBreaks(value) {
  return String(value).replace(/[\r\n]+/g, "");
}

function quoteUnitValue(value) {
  return `"${stripUnitLineBreaks(value).replace(/([\\"])/g, "\\$1")}"`;
}

// Shape rules shared with the unit generator: a host value must be a single
// token without whitespace (including CR/LF, which would inject unit
// directives), path separators, or backslashes. setBindingOverride
// additionally refuses loopback and wildcard binds; a unit may legitimately
// default to loopback or bind a wildcard, so buildUserUnit uses only this
// shape check.
function validateHostShape(host) {
  const value = trim(host);
  if (!value) return { ok: false, reason: "empty" };
  if (/[\s/\\]/.test(value)) return { ok: false, reason: "malformed" };
  return { ok: true, host: value };
}

function parseEnvFile(text) {
  const entries = [];
  String(text || "").split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      entries.push({ type: "raw", text: line });
      return;
    }
    const separator = trimmed.indexOf("=");
    if (separator <= 0) {
      entries.push({ type: "raw", text: line });
      return;
    }
    entries.push({ type: "entry", key: trimmed.slice(0, separator).trim(), value: trimmed.slice(separator + 1).trim() });
  });
  return entries;
}

function serializeEnvEntries(entries) {
  // Blank raw lines are dropped: rewriting the override for one key must not
  // leave gaps between entries. Comments and ordering are preserved.
  const lines = entries
    .filter((entry) => entry.type === "entry" || trim(entry.text))
    .map((entry) => (entry.type === "entry" ? `${entry.key}=${entry.value}` : entry.text));
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function detectPrimaryNonInternalIpv4(interfaces) {
  const source = interfaces || os.networkInterfaces();
  for (const entries of Object.values(source || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.family !== "IPv4" || entry.internal === true) continue;
      if (String(entry.address).startsWith("169.254.")) continue;
      return entry.address;
    }
  }
  return null;
}

function createServiceManager(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const runner = options.runner || execFileRunner;
  const fileSystem = options.fileSystem || fs;
  const homeDir = options.homeDir || os.homedir();
  const xdgConfigHome = options.xdgConfigHome || trim(env.XDG_CONFIG_HOME) || path.join(homeDir, ".config");
  const systemUnitPaths = options.systemUnitPaths || SYSTEM_UNIT_PATHS;
  const isRoot = options.isRoot || defaultIsRoot;
  const nodeExecutable = options.nodeExecutable || process.execPath;
  const serverScript = options.serverScript || path.resolve(__dirname, "..", "server.js");
  const runtimeConfig = options.runtimeConfig || readRuntimeConfigSafe();

  function readRuntimeConfigSafe() {
    const candidates = [
      env.ANXOS_AGENT_RUNTIME_CONFIG,
      env.ANXHUB_CONFIG_DIR ? path.join(env.ANXHUB_CONFIG_DIR, "agent-runtime.json") : null,
    ].filter(Boolean);
    for (const filePath of candidates) {
      try {
        if (fileSystem.existsSync(filePath)) return readAgentRuntimeConfig(filePath, { migrate: false });
      } catch {
        return {};
      }
    }
    return {};
  }

  function resolveMode() {
    for (const candidate of systemUnitPaths) {
      try {
        if (fileSystem.existsSync(candidate)) return { mode: "system", unitPath: candidate };
      } catch {
        // An unreadable path simply is not a detected unit.
      }
    }
    const userPath = resolveUserUnitPath();
    try {
      if (fileSystem.existsSync(userPath)) return { mode: "user", unitPath: userPath };
    } catch {
      // Same: treat as absent.
    }
    return { mode: "none", unitPath: null };
  }

  function resolveUserUnitPath() {
    return path.join(xdgConfigHome, "systemd", "user", UNIT_NAME);
  }

  function resolveOverridePath() {
    const explicit = trim(env.AGENT_ENV_OVERRIDE_PATH);
    if (explicit) return explicit;
    if (resolveMode().mode === "system") return "/etc/anxos-agent/agent.env";
    return path.join(xdgConfigHome, "anxos-agent", "agent.env");
  }

  function resolveConfigDir() {
    const explicit = trim(env.ANXHUB_CONFIG_DIR);
    if (explicit) return explicit;
    if (resolveMode().mode === "system") return "/var/lib/anxos-agent/config";
    return path.join(xdgConfigHome, "anxos-agent", "config");
  }

  function resolveInstanceRoot() {
    const explicit = trim(env.AGENT_INSTANCE_ROOT);
    if (explicit) return explicit;
    if (resolveMode().mode === "system") return "/var/lib/anxos-agent/instances";
    return path.join(xdgConfigHome, "anxos-agent", "instances");
  }

  function resolveLogDir() {
    const explicit = trim(env.ANXOS_LOG_DIR);
    if (explicit) return explicit;
    if (resolveMode().mode === "system") return "/var/log/anxos-agent";
    return path.join(xdgConfigHome, "anxos-agent", "logs");
  }

  function resolveBackupRoot() {
    const explicit = trim(env.AGENT_BACKUP_ROOT);
    if (explicit) return explicit;
    if (resolveMode().mode === "system") return "/var/lib/anxos-agent/backups";
    return path.join(xdgConfigHome, "anxos-agent", "backups");
  }

  function resolveBindHost() {
    return trim(env.AGENT_HOST) || trim(runtimeConfig.host) || DEFAULT_HOST;
  }

  function resolvePort() {
    const parsed = Number.parseInt(env.AGENT_PORT || runtimeConfig.port, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
  }

  function systemctlPrefix(mode) {
    return mode === "user" ? ["--user"] : [];
  }

  function assertSupported() {
    if (platform !== "linux") {
      throw new ServiceManagerError(
        "PLATFORM_UNSUPPORTED",
        `Background service management is only supported on Linux with systemd (this platform is ${platform}).`,
      );
    }
  }

  function assertCanManage(mode) {
    if (mode === "system" && !isRoot()) {
      throw new ServiceManagerError(
        "SERVICE_PRIVILEGE_REQUIRED",
        "This Agent is managed by the system package (anxos-agent.service). Changing it requires root.",
        { recoverySuggestion: "Run the same command with sudo, or manage the unit with the system package manager." },
      );
    }
  }

  function assertSystemctlAvailable(result) {
    if (result?.errorCode === "ENOENT" || result?.missing) {
      throw new ServiceManagerError("SYSTEMD_UNAVAILABLE", "systemctl is not available on this system.", {
        recoverySuggestion: "Install and start systemd, or run the Agent process directly.",
      });
    }
  }

  function commandFailure(code, action, result) {
    return new ServiceManagerError(code, result?.stderr?.trim() || result?.stdout?.trim() || `The Agent service could not be ${action}.`, {
      details: { code: result?.code ?? null, stderr: result?.stderr || null, stdout: result?.stdout || null },
    });
  }

  async function runSystemctl(args) {
    return runner("systemctl", args, { timeoutMs: COMMAND_TIMEOUT_MS });
  }

  async function status() {
    if (platform !== "linux") {
      return {
        supported: false,
        mode: "unsupported",
        unitName: UNIT_NAME,
        unitPath: null,
        installed: false,
        enabled: false,
        active: false,
        state: "unsupported",
        reason: `Service management requires Linux with systemd (this platform is ${platform}).`,
      };
    }

    const detection = resolveMode();
    const base = {
      supported: true,
      mode: detection.mode,
      unitName: UNIT_NAME,
      unitPath: detection.unitPath,
      installed: detection.mode !== "none",
      enabled: false,
      active: false,
      state: detection.mode === "none" ? "not-installed" : "unknown",
      detail: detection.mode === "none"
        ? "No systemd unit was found for anxos-agent.service."
        : `${detection.mode === "system" ? "System" : "User"} unit detected at ${detection.unitPath}.`,
    };
    if (detection.mode === "none") return base;

    const prefix = systemctlPrefix(detection.mode);
    const enabledResult = await runSystemctl([...prefix, "is-enabled", UNIT_NAME]);
    const activeResult = await runSystemctl([...prefix, "is-active", UNIT_NAME]);
    if (enabledResult?.errorCode === "ENOENT" || activeResult?.errorCode === "ENOENT") {
      return {
        ...base,
        supported: false,
        state: "unsupported",
        reason: "systemctl is not available on this system.",
      };
    }
    // A present-but-unusable systemctl (for example an SSH session without a
    // running user manager) is reported instead of being rendered as "not
    // enabled", which would misstate what the operator can do.
    const busFailure = [enabledResult, activeResult].find((result) => !result?.ok
      && /(Failed to connect to bus|not been booted with systemd|System has not been booted|No medium found)/i.test(result?.stderr || ""));
    if (busFailure) {
      return {
        ...base,
        supported: false,
        state: "unsupported",
        reason: trim(busFailure.stderr) || "systemd could not be reached.",
      };
    }

    const enabledText = `${enabledResult.stdout}\n${enabledResult.stderr}`.trim();
    const activeText = activeResult.stdout.trim();
    const enabled = /^enabled/.test(enabledText);
    const active = activeText === "active";
    return {
      ...base,
      enabled,
      active,
      state: active ? "active" : activeText || (enabled ? "inactive" : "not-enabled"),
      privilege: {
        rootRequired: detection.mode === "system",
        isRoot: isRoot(),
      },
    };
  }

  async function lifecycle(action) {
    assertSupported();
    const detection = resolveMode();
    if (detection.mode === "none") {
      throw new ServiceManagerError(
        "SERVICE_NOT_INSTALLED",
        `No ${UNIT_NAME} unit is installed. Run \`anxos-agent service install\` for a source installation.`,
      );
    }
    assertCanManage(detection.mode);
    const prefix = systemctlPrefix(detection.mode);
    const result = await runSystemctl([...prefix, action, UNIT_NAME]);
    assertSystemctlAvailable(result);
    if (!result.ok) {
      throw commandFailure(`SERVICE_${action.toUpperCase()}_FAILED`, `${action}ed`, result);
    }
    return { action, changed: true, ...(await status()) };
  }

  function resolveUnitBindHost() {
    const host = resolveBindHost();
    const shape = validateHostShape(host);
    if (!shape.ok) {
      throw new ServiceManagerError(
        "AGENT_BIND_HOST_INVALID",
        `AGENT_HOST ${JSON.stringify(trim(host))} cannot be embedded in a systemd unit (${shape.reason}).`,
        {
          details: { reason: shape.reason },
          recoverySuggestion: "Set AGENT_HOST (or the runtime config host) to a single address with no whitespace, control characters, or path separators.",
        },
      );
    }
    return shape.host;
  }

  function buildUserUnit() {
    const configDir = resolveConfigDir();
    const identityPath = path.join(configDir, "device-identity.json");
    const overridePath = resolveOverridePath();
    const bindHost = resolveUnitBindHost();
    const lines = [
      "[Unit]",
      "Description=AnxOS Agent",
      "After=network.target",
      "",
      "[Service]",
      "Type=simple",
      `Environment=${quoteUnitValue("ELECTRON_RUN_AS_NODE=1")}`,
      `Environment=${quoteUnitValue(`ANXHUB_CONFIG_DIR=${configDir}`)}`,
      `Environment=${quoteUnitValue(`AGENT_HOST=${bindHost}`)}`,
      `Environment=${quoteUnitValue(`AGENT_PORT=${resolvePort()}`)}`,
      `Environment=${quoteUnitValue(`AGENT_IDENTITY_PATH=${identityPath}`)}`,
      `Environment=${quoteUnitValue(`AGENT_INSTANCE_ROOT=${resolveInstanceRoot()}`)}`,
      `Environment=${quoteUnitValue(`ANXOS_LOG_DIR=${resolveLogDir()}`)}`,
      // Read after the defaults above so explicit operator overrides win, the
      // same ordering the packaged system unit uses. The leading '-' keeps the
      // unit valid before the file exists.
      `EnvironmentFile=-${stripUnitLineBreaks(overridePath)}`,
      `ExecStart=${quoteUnitValue(nodeExecutable)} ${quoteUnitValue(serverScript)}`,
      "Restart=on-failure",
      "",
      "[Install]",
      "WantedBy=default.target",
      "",
    ];
    return lines.join("\n");
  }

  async function install() {
    assertSupported();
    const detection = resolveMode();
    if (detection.mode === "system") {
      throw new ServiceManagerError(
        "SERVICE_MANAGED_BY_PACKAGE",
        "This Agent is managed by the operating system package, so the CLI will not modify it.",
        {
          recoverySuggestion: "Use the package manager: `sudo apt install --reinstall anxos-agent` or `sudo systemctl restart anxos-agent.service`.",
        },
      );
    }

    const versionResult = await runSystemctl(["--version"]);
    assertSystemctlAvailable(versionResult);

    const unitPath = resolveUserUnitPath();
    const unitDir = path.dirname(unitPath);
    fileSystem.mkdirSync(unitDir, { recursive: true });
    const unitText = buildUserUnit();
    const tempPath = `${unitPath}.${process.pid}.${Date.now()}.tmp`;
    fileSystem.writeFileSync(tempPath, unitText, { mode: 0o600 });
    fileSystem.renameSync(tempPath, unitPath);
    try {
      fileSystem.chmodSync(unitPath, 0o600);
    } catch {
      // Best-effort on platforms without POSIX modes.
    }

    const reload = await runSystemctl(["--user", "daemon-reload"]);
    assertSystemctlAvailable(reload);
    if (!reload.ok) {
      throw new ServiceManagerError("SERVICE_INSTALL_FAILED", reload.stderr.trim() || "systemd could not reload its unit definitions.", {
        details: { unitPath, unitWritten: true },
      });
    }
    const enabled = await runSystemctl(["--user", "enable", "--now", UNIT_NAME]);
    if (!enabled.ok) {
      throw new ServiceManagerError("SERVICE_INSTALL_FAILED", enabled.stderr.trim() || "The user service could not be enabled.", {
        details: { unitPath, unitWritten: true, code: enabled.code ?? null },
      });
    }
    return {
      action: "install",
      changed: true,
      unitPath,
      ...(await status()),
      notes: [
        "For a headless server, enable lingering so the user service starts at boot: sudo loginctl enable-linger <user>.",
      ],
    };
  }

  async function uninstall() {
    assertSupported();
    const detection = resolveMode();
    if (detection.mode === "system") {
      throw new ServiceManagerError(
        "SERVICE_MANAGED_BY_PACKAGE",
        "This Agent is managed by the operating system package, so the CLI will not remove it.",
        {
          recoverySuggestion: "Remove it with the package manager: `sudo apt remove anxos-agent`. Agent data, instances and backups are never deleted by this command.",
        },
      );
    }
    if (detection.mode === "none") {
      return {
        action: "uninstall",
        removed: false,
        mode: "none",
        detail: `No user unit was installed at ${resolveUserUnitPath()}.`,
        dataPreserved: true,
      };
    }

    const disable = await runSystemctl(["--user", "disable", "--now", UNIT_NAME]);
    let removed = false;
    try {
      fileSystem.rmSync(detection.unitPath, { force: true });
      removed = true;
    } catch (error) {
      throw new ServiceManagerError("SERVICE_UNINSTALL_FAILED", `The user unit at ${detection.unitPath} could not be removed.`, {
        details: { causeCode: error?.code || null },
      });
    }
    const reload = await runSystemctl(["--user", "daemon-reload"]);
    return {
      action: "uninstall",
      removed,
      unitPath: detection.unitPath,
      disabled: disable.ok,
      warning: disable.ok ? null : disable.stderr.trim() || "The unit could not be stopped before removal.",
      reloaded: reload.ok,
      dataPreserved: true,
      detail: "The user unit was removed. Agent configuration, instances and backups were preserved.",
    };
  }

  function readOverrideFile(overridePath) {
    try {
      if (!fileSystem.existsSync(overridePath)) return { exists: false, entries: [] };
      return { exists: true, entries: parseEnvFile(fileSystem.readFileSync(overridePath, "utf8")) };
    } catch (error) {
      throw new ServiceManagerError("AGENT_ENV_UNREADABLE", `The Agent environment override at ${overridePath} could not be read.`, {
        details: { causeCode: error?.code || null },
      });
    }
  }

  function writeOverrideFile(overridePath, entries) {
    fileSystem.mkdirSync(path.dirname(overridePath), { recursive: true });
    const tempPath = `${overridePath}.${process.pid}.${Date.now()}.tmp`;
    fileSystem.writeFileSync(tempPath, serializeEnvEntries(entries), { mode: 0o600 });
    fileSystem.renameSync(tempPath, overridePath);
    try {
      fileSystem.chmodSync(overridePath, 0o600);
    } catch {
      // Best-effort on platforms without POSIX modes.
    }
  }

  function assertOverrideWritable() {
    const mode = resolveMode().mode;
    if (mode === "system" && !isRoot()) {
      throw new ServiceManagerError(
        "SERVICE_PRIVILEGE_REQUIRED",
        "This Agent is installed by the system package, so its network binding is configured in /etc/anxos-agent/agent.env and requires root.",
        { recoverySuggestion: "Run the same command with sudo to change the Agent bind address." },
      );
    }
  }

  function validateBindHost(host) {
    const shape = validateHostShape(host);
    if (!shape.ok) return shape;
    if (WILDCARD_OR_LOOPBACK.has(shape.host.toLowerCase())) return { ok: false, reason: "wildcard-or-loopback" };
    if (isWildcardBind(shape.host)) return { ok: false, reason: "wildcard" };
    return shape;
  }

  /**
   * Explicit, operator-confirmed network access: write AGENT_HOST=<ip> into the
   * environment override file, preserving every other key. Never called
   * implicitly, and never enables a wildcard bind.
   */
  function setBindingOverride(host) {
    assertSupported();
    assertOverrideWritable();
    const validated = validateBindHost(host);
    if (!validated.ok) {
      throw new ServiceManagerError("AGENT_BIND_HOST_INVALID", `"${trim(host)}" is not a usable Agent bind address.`, {
        details: { reason: validated.reason },
      });
    }
    const overridePath = resolveOverridePath();
    const { entries } = readOverrideFile(overridePath);
    let replaced = false;
    const next = entries.map((entry) => {
      if (entry.type === "entry" && entry.key === "AGENT_HOST") {
        replaced = true;
        return { type: "entry", key: "AGENT_HOST", value: validated.host };
      }
      return entry;
    });
    if (!replaced) next.push({ type: "entry", key: "AGENT_HOST", value: validated.host });
    writeOverrideFile(overridePath, next);
    return {
      ok: true,
      path: overridePath,
      host: validated.host,
      changed: true,
      restartRequired: true,
    };
  }

  function readBindingOverride() {
    const overridePath = resolveOverridePath();
    const { exists, entries } = readOverrideFile(overridePath);
    const values = {};
    entries.forEach((entry) => {
      if (entry.type === "entry") values[entry.key] = entry.value;
    });
    return { path: overridePath, exists, values, agentHost: values.AGENT_HOST || null };
  }

  function clearBindingOverride() {
    assertSupported();
    assertOverrideWritable();
    const overridePath = resolveOverridePath();
    const { exists, entries } = readOverrideFile(overridePath);
    if (!exists) return { ok: true, path: overridePath, cleared: false, restartRequired: false };
    const next = entries.filter((entry) => !(entry.type === "entry" && entry.key === "AGENT_HOST"));
    const remaining = next.filter((entry) => entry.type === "entry" || trim(entry.text));
    if (remaining.length === 0) {
      fileSystem.rmSync(overridePath, { force: true });
      return { ok: true, path: overridePath, cleared: true, removedFile: true, restartRequired: true };
    }
    writeOverrideFile(overridePath, next);
    return { ok: true, path: overridePath, cleared: true, restartRequired: true };
  }

  return {
    ServiceManagerError,
    buildUserUnit,
    clearBindingOverride,
    detectPrimaryNonInternalIpv4,
    install,
    readBindingOverride,
    resolveBackupRoot,
    resolveConfigDir,
    resolveInstanceRoot,
    resolveLogDir,
    resolveMode,
    resolveOverridePath,
    resolveUserUnitPath,
    restart: () => lifecycle("restart"),
    setBindingOverride,
    start: () => lifecycle("start"),
    status,
    stop: () => lifecycle("stop"),
    uninstall,
  };
}

module.exports = {
  ServiceManagerError,
  createServiceManager,
  detectPrimaryNonInternalIpv4,
  _test: {
    execFileRunner,
    parseEnvFile,
    quoteUnitValue,
    serializeEnvEntries,
    SYSTEM_UNIT_PATHS,
    UNIT_NAME,
    validateHostShape,
  },
};
