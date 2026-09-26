"use strict";

// Environment parity for the headless CLI/TUI.
//
// The packaged Agent runs under systemd, which reads
// /etc/anxos-agent/agent.env (see packaging/agent-deb/anxos-agent.service).
// A plain root shell running `anxos-agent` does not inherit the unit's
// environment, so `logs` looks in the wrong directory and `status` cannot reach
// a network-bound Agent on a non-default port. This module applies the same
// files to the CLI process BEFORE dispatch.
//
// Rules:
//   - read /etc/anxos-agent/agent.env, then the per-user
//     <XDG_CONFIG_HOME|~/.config>/anxos-agent/agent.env;
//   - a variable already explicitly set in the target env (process.env) wins;
//     otherwise the later file wins over the earlier one;
//   - the per-user file is a candidate only while it belongs to the effective
//     user: it must be owned by the effective uid and must not be group- or
//     world-writable, and when the process runs as root (sudo commonly
//     preserves HOME) it must be root-owned. A user-writable file must never
//     redirect a root command such as `service install`, so a file that fails
//     these checks is skipped with a value-free note (stderr outside --json);
//   - from the PER-USER file only, path-redirection keys
//     (ANXHUB_AGENT_CONFIG_PATH, ANXHUB_CONFIG_DIR,
//     ANXOS_AGENT_RUNTIME_CONFIG) and AGENT_TOKEN are honored only when that
//     file is provably root-owned. /etc/anxos-agent/agent.env is a system-owned
//     path and keeps its full behavior;
//   - comments/blank lines are ignored, whitespace is trimmed, matching
//     single/double quotes are stripped, and malformed keys are rejected;
//   - after the files, packaged defaults are injected ONLY for variables still
//     unset and ONLY when the conventional packaged path exists on this host.
//     A plain root shell has neither the systemd unit's EnvironmentFile values
//     nor those defaults, so `status` could not find the credential and
//     `unpair` resolved an unauthenticated config; explicit environment and
//     env-file values always keep precedence;
//   - ANXOS_AGENT_SKIP_ENV_FILE=1 (or "true") disables loading entirely.
//
// File contents and values are never logged. The returned summary lists only
// paths, key names, and skip/ignore notes.

const fs = require("fs");
const os = require("os");
const path = require("path");

const SYSTEM_ENV_PATH = "/etc/anxos-agent/agent.env";
const USER_ENV_DIRECTORY = "anxos-agent";
const USER_ENV_FILE = "agent.env";
const SKIP_ENV_VAR = "ANXOS_AGENT_SKIP_ENV_FILE";
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GROUP_OR_WORLD_WRITABLE_MASK = 0o022;

// Keys that can redirect where the Agent reads/writes its state or that carry
// the paired credential. A per-user file may influence them only when it is
// provably root-owned (see the module header).
const RESTRICTED_USER_KEYS = Object.freeze([
  "AGENT_TOKEN",
  "ANXHUB_AGENT_CONFIG_PATH",
  "ANXHUB_CONFIG_DIR",
  "ANXOS_AGENT_RUNTIME_CONFIG",
]);

// Packaged layout (packaging/agent-deb): the values and the conventional paths
// they point at coincide, which is why a default is injected only when that
// path exists on this host. Off a packaged install (developer checkout,
// Windows) nothing is injected and behavior is unchanged.
const PACKAGED_DEFAULTS = Object.freeze([
  Object.freeze({ key: "ANXHUB_CONFIG_DIR", path: "/var/lib/anxos-agent/config" }),
  Object.freeze({ key: "ANXOS_LOG_DIR", path: "/var/log/anxos-agent" }),
]);

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stripMatchingQuotes(value) {
  const text = String(value ?? "");
  if (text.length >= 2
    && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    return text.slice(1, -1);
  }
  return text;
}

// Parses KEY=VALUE lines into a plain object. Malformed lines and malformed
// keys are rejected (ignored), never guessed at.
function parseEnvText(text) {
  const values = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (!ENV_KEY_PATTERN.test(key)) continue;
    values[key] = stripMatchingQuotes(trimmed.slice(separator + 1).trim());
  }
  return values;
}

/**
 * The files this module would read, each with its role. `role: "user"` means
 * the ownership gate and restricted-key rule apply; the system path never is.
 */
function resolveEnvFileSources(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const xdgConfigHome = trim(env.XDG_CONFIG_HOME) || path.join(homeDir, ".config");
  const systemPath = options.systemPath === undefined ? SYSTEM_ENV_PATH : options.systemPath;
  const userPath = options.userPath === undefined
    ? path.join(xdgConfigHome, USER_ENV_DIRECTORY, USER_ENV_FILE)
    : options.userPath;
  const sources = [];
  if (systemPath) sources.push({ path: systemPath, role: "system" });
  if (userPath) sources.push({ path: userPath, role: "user" });
  return sources;
}

// Backwards-compatible path list. When an explicit `paths` array is supplied to
// applyEnvFile, a path is treated as the system file only if it equals
// `systemPath` (default /etc/anxos-agent/agent.env); every other path carries
// the per-user rules, because the hardening is about the file a user can write.
function resolveEnvFilePaths(options = {}) {
  if (Array.isArray(options.sources)) {
    return options.sources.filter((source) => source && source.path).map((source) => source.path);
  }
  return resolveEnvFileSources(options).map((source) => source.path);
}

function resolveApplySources(options = {}) {
  if (Array.isArray(options.sources)) {
    return options.sources
      .filter((source) => source && source.path)
      .map((source) => ({ path: source.path, role: source.role === "user" ? "user" : "system" }));
  }
  if (Array.isArray(options.paths)) {
    const systemPath = options.systemPath === undefined ? SYSTEM_ENV_PATH : options.systemPath;
    return options.paths
      .filter(Boolean)
      .map((filePath) => ({ path: filePath, role: filePath === systemPath ? "system" : "user" }));
  }
  return resolveEnvFileSources(options);
}

function currentUid(options = {}) {
  if (options.getuid === null) return null;
  const source = typeof options.getuid === "function" ? options.getuid : process.getuid;
  if (typeof source !== "function") return null;
  const value = Number(source());
  return Number.isFinite(value) ? value : null;
}

/**
 * Ownership gate for a per-user env file.
 *   usable: false  -> do not read the file at all (reason says why);
 *   absent: true   -> not a source, exactly like a missing file;
 *   rootOwned      -> true only when ownership was verified as uid 0, which is
 *                     what allows the restricted keys through.
 */
function evaluatePerUserEnvOwnership(stats, uid) {
  const ownerUid = Number(stats?.uid);
  if (!Number.isFinite(ownerUid)) {
    return { usable: true, absent: false, rootOwned: false, ownershipChecked: false };
  }
  if (ownerUid !== uid) {
    return {
      usable: false,
      absent: false,
      rootOwned: false,
      ownershipChecked: true,
      reason: uid === 0
        ? "it is not owned by root while this command runs as root"
        : "it is not owned by the effective user",
    };
  }
  const mode = Number(stats?.mode);
  if (Number.isFinite(mode) && (mode & GROUP_OR_WORLD_WRITABLE_MASK) !== 0) {
    return {
      usable: false,
      absent: false,
      rootOwned: false,
      ownershipChecked: true,
      reason: "it is group- or world-writable",
    };
  }
  return { usable: true, absent: false, rootOwned: ownerUid === 0, ownershipChecked: true };
}

function inspectPerUserEnvFile(filePath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const uid = currentUid(options);
  if (uid === null) {
    // No POSIX owner model on this platform: ownership cannot be proven, so
    // restricted keys stay ignored, but the file itself is still read the way
    // it always was off a packaged install.
    return { usable: true, absent: false, rootOwned: false, ownershipChecked: false };
  }
  let stats = null;
  try {
    stats = fileSystem.statSync(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { usable: true, absent: true, rootOwned: false, ownershipChecked: true };
    }
    return {
      usable: false,
      absent: false,
      rootOwned: false,
      ownershipChecked: true,
      reason: `it could not be inspected (${error?.code || "stat failed"})`,
    };
  }
  return evaluatePerUserEnvOwnership(stats, uid);
}

function canUseDescriptorInspection(fileSystem) {
  return typeof fileSystem?.openSync === "function"
    && typeof fileSystem?.fstatSync === "function"
    && typeof fileSystem?.closeSync === "function";
}

/**
 * Race-free per-user env read: the file is opened once and both the ownership
 * gate (fstat on the descriptor) and the content read use that same descriptor,
 * so a path swap between the check and the read cannot present unchecked
 * content. Injected filesystems without descriptor primitives keep the legacy
 * path-stat behavior so existing test doubles stay valid.
 */
function readPerUserEnvFile(filePath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const uid = currentUid(options);
  if (!canUseDescriptorInspection(fileSystem)) {
    const ownership = inspectPerUserEnvFile(filePath, options);
    if (ownership.absent || !ownership.usable) return { ...ownership, readable: false, text: "" };
    try {
      return { ...ownership, readable: true, text: fileSystem.readFileSync(filePath, "utf8") };
    } catch {
      return { ...ownership, readable: false, text: "" };
    }
  }
  let descriptor = null;
  try {
    descriptor = fileSystem.openSync(filePath, "r");
    const stats = fileSystem.fstatSync(descriptor);
    const ownership = uid === null
      ? { usable: true, absent: false, rootOwned: false, ownershipChecked: false }
      : evaluatePerUserEnvOwnership(stats, uid);
    if (!ownership.usable) return { ...ownership, readable: false, text: "" };
    let text = "";
    try {
      text = fileSystem.readFileSync(descriptor, "utf8");
    } catch {
      return { ...ownership, readable: false, text: "" };
    }
    return { ...ownership, readable: true, text };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { usable: true, absent: true, rootOwned: false, ownershipChecked: true, readable: false, text: "" };
    }
    return {
      usable: false,
      absent: false,
      rootOwned: false,
      ownershipChecked: true,
      reason: `it could not be inspected (${error?.code || "open failed"})`,
      readable: false,
      text: "",
    };
  } finally {
    if (descriptor !== null) {
      try { fileSystem.closeSync(descriptor); } catch {}
    }
  }
}

// Default note sink: a brief, value-free line on stderr, suppressed in --json
// mode so machine-readable output stays machine-readable.
function defaultNoteWriter(options = {}) {
  const argv = Array.isArray(options.argv) ? options.argv : process.argv;
  const jsonMode = Array.isArray(argv) && argv.includes("--json");
  const stream = options.stderr || process.stderr;
  return (message) => {
    if (jsonMode) return;
    try {
      stream.write(`anxos-agent: ${message}\n`);
    } catch {
      // A closed stderr must never break env loading.
    }
  };
}

/**
 * Inject the packaged layout defaults for variables that are still unset, and
 * only when the conventional packaged path exists. Explicit environment and
 * env-file values (already present on `env`) keep precedence. `exists` is
 * injectable so the decision is unit-testable without /var paths; the result
 * carries key names only, never values.
 */
function applyPackagedDefaults(options = {}) {
  const env = options.env || process.env;
  const exists = typeof options.exists === "function" ? options.exists : (candidate) => fs.existsSync(candidate);
  const appliedKeys = [];
  for (const entry of PACKAGED_DEFAULTS) {
    if (env[entry.key] !== undefined) continue;
    let present = false;
    try {
      present = Boolean(exists(entry.path));
    } catch {
      present = false;
    }
    if (!present) continue;
    env[entry.key] = entry.path;
    appliedKeys.push(entry.key);
  }
  return { appliedKeys: appliedKeys.sort() };
}

/**
 * Apply the Agent env files to `env` (default process.env), then inject the
 * packaged defaults for anything the files (and the caller) did not set.
 * Returns a value-free summary: which paths existed, which keys were applied
 * from files, which keys were ignored by the per-user hardening, which files
 * were skipped for ownership, the notes that were emitted, which keys were
 * defaulted, and whether loading was disabled.
 */
function applyEnvFile(options = {}) {
  const env = options.env || process.env;
  if (/^(1|true)$/i.test(trim(env[SKIP_ENV_VAR]))) {
    return {
      skipped: true,
      appliedKeys: [],
      defaultedKeys: [],
      ignoredKeys: [],
      skippedPaths: [],
      notes: [],
      paths: [],
    };
  }
  const fileSystem = options.fileSystem || fs;
  const note = typeof options.onNote === "function" ? options.onNote : defaultNoteWriter(options);
  const applied = new Map();
  const readPaths = [];
  const skippedPaths = [];
  const ignoredKeys = new Set();
  const notes = [];
  const recordNote = (message) => {
    notes.push(message);
    try {
      note(message);
    } catch {
      // A note must never break env loading.
    }
  };
  for (const source of resolveApplySources(options)) {
    const isUserFile = source.role === "user";
    let ownership = { usable: true, absent: false, rootOwned: false };
    let text = "";
    if (isUserFile) {
      const inspected = readPerUserEnvFile(source.path, { fileSystem, getuid: options.getuid });
      if (inspected.absent) continue;
      if (!inspected.usable) {
        skippedPaths.push(source.path);
        recordNote(`Ignoring per-user agent env file ${source.path}: ${inspected.reason}.`);
        continue;
      }
      if (!inspected.readable) continue;
      ownership = inspected;
      text = inspected.text;
    } else {
      try {
        text = fileSystem.readFileSync(source.path, "utf8");
      } catch {
        // A missing/unreadable file is simply not a source.
        continue;
      }
    }
    readPaths.push(source.path);
    const parsed = parseEnvText(text);
    for (const key of Object.keys(parsed)) {
      // Explicit process.env always wins; within the files the later one wins.
      if (env[key] !== undefined) continue;
      if (isUserFile && RESTRICTED_USER_KEYS.includes(key) && !ownership.rootOwned) {
        ignoredKeys.add(key);
        recordNote(`Ignoring ${key} from ${source.path}: the per-user env file is not root-owned.`);
        continue;
      }
      applied.set(key, parsed[key]);
    }
  }
  for (const [key, value] of applied) {
    env[key] = value;
  }
  const defaults = applyPackagedDefaults({ env, exists: options.exists });
  return {
    skipped: false,
    appliedKeys: [...applied.keys()].sort(),
    defaultedKeys: defaults.appliedKeys,
    ignoredKeys: [...ignoredKeys].sort(),
    skippedPaths,
    notes,
    paths: readPaths,
  };
}

module.exports = {
  SKIP_ENV_VAR,
  SYSTEM_ENV_PATH,
  PACKAGED_DEFAULTS,
  RESTRICTED_USER_KEYS,
  applyEnvFile,
  applyPackagedDefaults,
  resolveEnvFilePaths,
  resolveEnvFileSources,
  _test: {
    ENV_KEY_PATTERN,
    PACKAGED_DEFAULTS,
    RESTRICTED_USER_KEYS,
    parseEnvText,
    resolveEnvFilePaths,
    resolveEnvFileSources,
    resolveApplySources,
    inspectPerUserEnvFile,
    readPerUserEnvFile,
    evaluatePerUserEnvOwnership,
    defaultNoteWriter,
    stripMatchingQuotes,
    applyEnvFile,
    applyPackagedDefaults,
  },
};
