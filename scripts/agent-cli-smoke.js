#!/usr/bin/env node
// Headless Agent CLI smoke: drives the real `anxos-agent` CLI against a real,
// isolated Agent process (temp ANXHUB_CONFIG_DIR / AGENT_INSTANCE_ROOT /
// ANXOS_LOG_DIR, ephemeral port). Nothing here touches a live Agent: the port
// is ephemeral, the config dir is a temp tree, and the process is stopped in
// `finally`.
//
// Proves: --version/--help, status --json, pairing (start -> complete over the
// real HTTP flow -> waiting->paired through `pair --json --wait`), pair --cancel,
// the human `pair` output carrying the full pairing code plus the short reference
// code, logs --json, service status --json, diagnostics --json, usage exit codes,
// the non-TTY no-arg fallback, and the ANXOS_TUI_KEYS automation seam (q, pq).
// Every captured stdout/stderr is asserted to contain no credential material.
"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const { waitForAgentReady } = require("./test-helpers/agent-readiness");
const { parsePairingCode } = require("../src/shared/agentPairing");

const rootDir = path.resolve(__dirname, "..");
const cliPath = path.join(rootDir, "agent", "src", "cli.js");
const agentEntry = path.join(rootDir, "agent", "src", "server.js");

const smokeRoot = pinAgentRoots("anx-agent-cli-smoke-");
const configDir = process.env.ANXHUB_CONFIG_DIR;
const logDir = path.join(smokeRoot, "logs");
const instanceRoot = process.env.AGENT_INSTANCE_ROOT;
const backupRoot = path.join(smokeRoot, "backups");
const identityPath = path.join(smokeRoot, "device-identity.json");
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });
fs.mkdirSync(instanceRoot, { recursive: true });
fs.mkdirSync(backupRoot, { recursive: true });

const AGENT_TOKEN = `anxos_${"c".repeat(40)}`;
const CLI_TIMEOUT_MS = 30000;
const agentChildren = new Set();
const cliChildren = new Set();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function agentEnv(port, extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.AGENT_URL;
  delete env.ANXOS_AGENT_RUNTIME_CONFIG;
  const pinned = {
    ...env,
    ANXHUB_CONFIG_DIR: configDir,
    ANXHUB_AGENT_CONFIG_PATH: path.join(configDir, "agent.json"),
    AGENT_ENROLLMENT_PATH: path.join(configDir, "enrollment.json"),
    AGENT_IDENTITY_PATH: identityPath,
    AGENT_HOST: "127.0.0.1",
    AGENT_PORT: String(port),
    AGENT_INSTANCE_ROOT: instanceRoot,
    AGENT_BACKUP_ROOT: backupRoot,
    ANXOS_TEST_SHUTDOWN_IPC: "1",
  };
  // ANXOS_LOG_DIR is normally pinned to the isolated log dir; the env-file leg
  // must be able to leave it unset so the env file under test is the only source.
  if (!Object.prototype.hasOwnProperty.call(extra, "ANXOS_LOG_DIR")) pinned.ANXOS_LOG_DIR = logDir;
  return pinned;
}

// `resolveAgentConfigPath()` prefers an EXISTING candidate over a missing
// ANXHUB_AGENT_CONFIG_PATH, so the temp config file must exist before the Agent
// or CLI starts — otherwise a dev-machine config fixture elsewhere on the
// machine is read (and later rewritten by pairing).
function seedAgentConfigFile(port) {
  fs.writeFileSync(
    path.join(configDir, "agent.json"),
    `${JSON.stringify({ backendMode: "agent", agentUrl: `http://127.0.0.1:${port}`, agentToken: AGENT_TOKEN }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function spawnAgent(port) {
  const child = spawn(process.execPath, [agentEntry], {
    cwd: path.join(rootDir, "agent"),
    env: agentEnv(port, { AGENT_TOKEN }),
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  agentChildren.add(child);
  child.once("exit", () => agentChildren.delete(child));
  return child;
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  try {
    if (child.connected) child.send({ type: "shutdown" });
    else child.kill("SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
  const finished = await Promise.race([exited.then(() => true), wait(8000).then(() => false)]);
  if (!finished) {
    try { child.kill("SIGKILL"); } catch {}
    await Promise.race([exited, wait(3000)]);
  }
}

function runCli(args, env = {}, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: smokeRoot,
      env: agentEnv(options.port || 0, {
        // Hermetic by default: the host's installed env files must not leak into
        // the CLI under test. The env-file leg below opts back in explicitly.
        ANXOS_AGENT_SKIP_ENV_FILE: options.loadEnvFile === true ? undefined : "1",
        ...env,
      }),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    cliChildren.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, CLI_TIMEOUT_MS);
    child.stdin.end();
    child.once("close", (code) => {
      clearTimeout(timer);
      cliChildren.delete(child);
      resolve({ code, stdout, stderr });
    });
  });
}

function spawnCliStreaming(args, env, port) {
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: smokeRoot,
    env: agentEnv(port, { ANXOS_AGENT_SKIP_ENV_FILE: "1", ...env }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  cliChildren.add(child);
  const state = { stdout: "", stderr: "", code: null };
  child.stdout.on("data", (chunk) => { state.stdout += String(chunk); });
  child.stderr.on("data", (chunk) => { state.stderr += String(chunk); });
  child.stdin.end();
  const exited = new Promise((resolve) => child.once("close", (code) => {
    cliChildren.delete(child);
    state.code = code;
    resolve(state);
  }));
  return { child, state, exited };
}

function assertNoPermanentToken(text, label) {
  assert(!text.includes(AGENT_TOKEN), `${label} must not contain the Agent credential value.`);
  assert(!text.includes("anxos_"), `${label} must not contain any credential-looking "anxos_" literal.`);
}

// Minimal TTY double for the in-process TUI survival leg: stores handlers and
// writes so terminal restore can be asserted without a real terminal.
function createFakeTty() {
  const handlers = new Map();
  return {
    isTTY: true,
    columns: 80,
    rows: 24,
    writes: [],
    rawModes: [],
    paused: false,
    resumed: false,
    setEncoding() {},
    setRawMode(value) { this.rawModes.push(value); },
    resume() { this.resumed = true; },
    pause() { this.paused = true; },
    write(chunk) { this.writes.push(String(chunk)); return true; },
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
      return this;
    },
    removeListener(event, handler) {
      handlers.set(event, (handlers.get(event) || []).filter((entry) => entry !== handler));
      return this;
    },
    emit(event, ...args) {
      for (const handler of handlers.get(event) || []) handler(...args);
      return true;
    },
  };
}

// Joins the pairing-code fragment lines that follow the "Pairing code (paste
// into Add Computer):" label. The TUI hard-wraps the full code into
// width-bounded fragments; joining them (whitespace is what normalizePairingCode
// strips on paste) must reconstruct exactly what Control Center redeems.
function reconstructWrappedCode(text) {
  const lines = String(text).split(/\r?\n/);
  const label = lines.findIndex((line) => line.includes("Pairing code (paste"));
  if (label === -1) return "";
  const start = lines.findIndex((line, index) => index > label && /^ANX-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}\./.test(line.trim()));
  if (start === -1) return "";
  let code = "";
  for (let index = start; index < lines.length; index += 1) {
    const fragment = lines[index].trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(fragment)) break;
    // A bare friendly code is the compact "Reference code" line at widths too
    // narrow for its label, not a fragment of the full code.
    if (code && /^ANX-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(fragment)) break;
    code += fragment;
  }
  return code;
}

async function completePairingOverHttp(baseUrl, pairingCode, permanentToken) {
  const response = await fetch(`${baseUrl}/api/v1/pairing/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairingCode, permanentToken }),
  });
  const body = await response.json().catch(() => null);
  assert.strictEqual(response.status, 200, `pairing/complete must succeed (got ${response.status}: ${JSON.stringify(body)}).`);
  assert.strictEqual(body?.status, "paired", "pairing/complete must report the paired state.");
  return body;
}

async function pairingStatus(baseUrl) {
  const response = await fetch(`${baseUrl}/api/v1/pairing/status`);
  assert.strictEqual(response.status, 200, "pairing/status must be reachable.");
  return response.json();
}

async function authenticatedInstances(baseUrl, token) {
  const response = await fetch(`${baseUrl}/api/v1/instances`, { headers: { Authorization: `Bearer ${token}` } });
  return response.status;
}

// ---------------------------------------------------------------------------
// Environment parity legs: the installed Agent env files must be parsed and
// applied by the CLI before dispatch, with explicit process.env winning.
// ---------------------------------------------------------------------------
async function runEnvFileLegs(port) {
  const { applyEnvFile, _test } = require("../agent/src/services/agentEnvFile");
  const { parseEnvText, stripMatchingQuotes, applyPackagedDefaults, PACKAGED_DEFAULTS } = _test;

  const parsed = parseEnvText([
    "# comment",
    "",
    "  AGENT_HOST = 10.0.0.5  ",
    "AGENT_PORT=47132",
    'QUOTED="value with spaces"',
    "SINGLE='single-quoted'",
    'UNMATCHED="half-quoted',
    "1INVALID=value",
    "BAD KEY=value",
    "NO_SEPARATOR",
    "=empty-key",
    "EQUALS=a=b",
    "#AGENT_URL=http://ignored",
  ].join("\n"));
  assert.strictEqual(parsed.AGENT_HOST, "10.0.0.5", "env values must be trimmed.");
  assert.strictEqual(parsed.AGENT_PORT, "47132", "plain KEY=VALUE lines must parse.");
  assert.strictEqual(parsed.QUOTED, "value with spaces", "matching double quotes must be stripped.");
  assert.strictEqual(parsed.SINGLE, "single-quoted", "matching single quotes must be stripped.");
  assert.strictEqual(parsed.UNMATCHED, '"half-quoted', "only a matching quote pair may be stripped.");
  assert.strictEqual(parsed.EQUALS, "a=b", "only the first '=' separates key and value.");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed, "1INVALID"), false, "malformed keys must be rejected.");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed, "BAD KEY"), false, "keys containing spaces must be rejected.");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed, "NO_SEPARATOR"), false, "lines without '=' must be ignored.");
  assert.strictEqual(Object.prototype.hasOwnProperty.call(parsed, "AGENT_URL"), false, "commented lines must be ignored.");
  assert.strictEqual(stripMatchingQuotes("plain"), "plain", "unquoted values must pass through.");

  const envRoot = path.join(smokeRoot, "env-file");
  const systemFile = path.join(envRoot, "system.env");
  const userFile = path.join(envRoot, "user.env");
  fs.mkdirSync(envRoot, { recursive: true });
  fs.writeFileSync(systemFile, "AGENT_HOST=10.0.0.5\nFROM_SYSTEM=system\nSHARED=system\n", "utf8");
  fs.writeFileSync(userFile, "FROM_USER=user\nSHARED=user\n", "utf8");

  const target = { AGENT_HOST: "127.0.0.9" };
  const summary = applyEnvFile({ env: target, paths: [systemFile, userFile] });
  assert.strictEqual(target.AGENT_HOST, "127.0.0.9", "an explicitly set process.env value must win over env files.");
  assert.strictEqual(target.FROM_SYSTEM, "system", "the system env file must be applied.");
  assert.strictEqual(target.FROM_USER, "user", "the user env file must be applied.");
  assert.strictEqual(target.SHARED, "user", "the user env file must win over the system env file.");
  assert.deepStrictEqual(summary.appliedKeys, ["FROM_SYSTEM", "FROM_USER", "SHARED"], "the summary must report applied keys only.");
  assert.deepStrictEqual(summary.paths, [systemFile, userFile], "the summary must report the files that were read.");
  assert(!JSON.stringify(summary).includes("10.0.0.5"), "the summary must never carry values.");

  const skippedTarget = { ANXOS_AGENT_SKIP_ENV_FILE: "1" };
  const skipped = applyEnvFile({ env: skippedTarget, paths: [systemFile, userFile] });
  assert.strictEqual(skipped.skipped, true, "the skip flag must disable loading.");
  assert.strictEqual(skippedTarget.FROM_SYSTEM, undefined, "a skipped load must apply nothing.");

  const missingTarget = {};
  const missing = applyEnvFile({ env: missingTarget, paths: [path.join(envRoot, "missing.env")] });
  assert.strictEqual(missing.skipped, false, "a missing file must not count as skipped.");
  assert.deepStrictEqual(missing.appliedKeys, [], "a missing file must apply nothing.");

  // --- packaged defaults (B2) ---------------------------------------------
  // A plain root shell has neither the systemd unit's EnvironmentFile values
  // nor the packaged layout defaults, so `status` could not find the
  // credential. The `exists` predicate is the testable seam: it decides whether
  // the conventional packaged path is present on this host, so these legs run
  // identically on Windows, macOS, and Linux.
  const allPackagedPathsExist = () => true;
  const noPackagedPathsExist = () => false;

  const defaultedTarget = {};
  const defaulted = applyPackagedDefaults({ env: defaultedTarget, exists: allPackagedPathsExist });
  assert.strictEqual(defaultedTarget.ANXHUB_CONFIG_DIR, "/var/lib/anxos-agent/config", "unset ANXHUB_CONFIG_DIR must take the packaged default when the path exists.");
  assert.strictEqual(defaultedTarget.ANXOS_LOG_DIR, "/var/log/anxos-agent", "unset ANXOS_LOG_DIR must take the packaged default when the path exists.");
  assert.deepStrictEqual(defaulted.appliedKeys, ["ANXHUB_CONFIG_DIR", "ANXOS_LOG_DIR"], "the seam must report which defaults were applied.");
  assert(!JSON.stringify(defaulted).includes("/var/lib"), "the seam summary must never carry values.");

  const absentTarget = {};
  const absentDefaults = applyPackagedDefaults({ env: absentTarget, exists: noPackagedPathsExist });
  assert.strictEqual(absentTarget.ANXHUB_CONFIG_DIR, undefined, "a default must not apply when its packaged path is absent.");
  assert.strictEqual(absentTarget.ANXOS_LOG_DIR, undefined, "a default must not apply when its packaged path is absent.");
  assert.deepStrictEqual(absentDefaults.appliedKeys, [], "no defaults may be reported when no packaged path exists.");

  const explicitTarget = { ANXHUB_CONFIG_DIR: "/custom/config", ANXOS_LOG_DIR: "/custom/logs" };
  applyPackagedDefaults({ env: explicitTarget, exists: allPackagedPathsExist });
  assert.strictEqual(explicitTarget.ANXHUB_CONFIG_DIR, "/custom/config", "an explicit env value must win over the packaged default.");
  assert.strictEqual(explicitTarget.ANXOS_LOG_DIR, "/custom/logs", "an explicit env value must win over the packaged default.");

  // Through the full loader: file values are applied first and keep precedence;
  // only the still-unset variable takes the packaged default, and the summary
  // keeps file-applied keys and defaulted keys distinct.
  const packagedFile = path.join(envRoot, "packaged.env");
  fs.writeFileSync(packagedFile, "ANXHUB_CONFIG_DIR=/from-env-file\n", "utf8");
  const packagedTarget = {};
  const packagedSummary = applyEnvFile({ env: packagedTarget, sources: [{ path: packagedFile, role: "system" }], exists: allPackagedPathsExist });
  assert.strictEqual(packagedTarget.ANXHUB_CONFIG_DIR, "/from-env-file", "an env-file value must win over the packaged default.");
  assert.strictEqual(packagedTarget.ANXOS_LOG_DIR, "/var/log/anxos-agent", "a still-unset variable must take the packaged default after the files are applied.");
  assert.deepStrictEqual(packagedSummary.appliedKeys, ["ANXHUB_CONFIG_DIR"], "only env-file keys belong in appliedKeys.");
  assert.deepStrictEqual(packagedSummary.defaultedKeys, ["ANXOS_LOG_DIR"], "only packaged defaults belong in defaultedKeys.");

  const omittedTarget = {};
  const omittedSummary = applyEnvFile({ env: omittedTarget, paths: [path.join(envRoot, "missing.env")], exists: noPackagedPathsExist });
  assert.deepStrictEqual(omittedSummary.defaultedKeys, [], "no defaulted keys may be reported when the packaged paths are absent.");
  assert.deepStrictEqual(PACKAGED_DEFAULTS.map((entry) => entry.key).sort(), ["ANXHUB_CONFIG_DIR", "ANXOS_LOG_DIR"], "the packaged defaults must cover exactly the two documented variables.");

  const skippedDefaultsTarget = { ANXOS_AGENT_SKIP_ENV_FILE: "1" };
  const skippedDefaults = applyEnvFile({ env: skippedDefaultsTarget, paths: [packagedFile], exists: allPackagedPathsExist });
  assert.strictEqual(skippedDefaults.skipped, true, "the skip flag must still disable loading entirely.");
  assert.strictEqual(skippedDefaultsTarget.ANXHUB_CONFIG_DIR, undefined, "a skipped load must not inject packaged defaults either.");

  // CLI end-to-end: the loader must run before dispatch, so an env-file-only
  // ANXOS_LOG_DIR appears in `status --json` paths.logDir, and the skip flag
  // disables exactly that.
  const xdgHome = path.join(envRoot, "xdg");
  const envFileDir = path.join(xdgHome, "anxos-agent");
  const envFileLogDir = path.join(envRoot, "env-file-logs");
  fs.mkdirSync(envFileDir, { recursive: true });
  fs.mkdirSync(envFileLogDir, { recursive: true });
  fs.writeFileSync(path.join(envFileDir, "agent.env"), `ANXOS_LOG_DIR=${envFileLogDir}\n# comment\n`, "utf8");

  const loaded = await runCli(["status", "--json"], {
    AGENT_TOKEN,
    XDG_CONFIG_HOME: xdgHome,
    ANXOS_LOG_DIR: undefined,
  }, { port, loadEnvFile: true });
  assert.strictEqual(loaded.code, 0, `status --json with an env file must exit 0 (stderr: ${loaded.stderr}).`);
  const loadedJson = JSON.parse(loaded.stdout);
  assert.strictEqual(loadedJson.paths?.logDir, envFileLogDir, `the CLI must apply the installed env file before dispatch, got ${loadedJson.paths?.logDir}.`);

  const skipTarget = await runCli(["status", "--json"], {
    AGENT_TOKEN,
    XDG_CONFIG_HOME: xdgHome,
    ANXOS_LOG_DIR: undefined,
    ANXOS_AGENT_SKIP_ENV_FILE: "1",
  }, { port, loadEnvFile: true });
  assert.strictEqual(skipTarget.code, 0, `status --json with the skip flag must exit 0 (stderr: ${skipTarget.stderr}).`);
  const skipJson = JSON.parse(skipTarget.stdout);
  assert.notStrictEqual(skipJson.paths?.logDir, envFileLogDir, "ANXOS_AGENT_SKIP_ENV_FILE=1 must disable env-file loading.");

  // Log fallback: a configured path with no agent.log falls back to the
  // packaged path and says which path was used.
  const { readAgentLogTail } = require("../agent/src/services/agentLogService");
  const fallbackFile = path.join(envRoot, "fallback", "agent.log");
  fs.mkdirSync(path.dirname(fallbackFile), { recursive: true });
  fs.writeFileSync(fallbackFile, "fallback-line-1\nfallback-line-2\n", "utf8");
  const fallback = readAgentLogTail({ filePath: path.join(envRoot, "no-log-dir", "agent.log"), fallbackPath: fallbackFile, lines: 10 });
  assert.strictEqual(fallback.ok, true, "the fallback log must be read when the configured path is missing.");
  assert.strictEqual(fallback.path, fallbackFile, "the fallback result must report the path actually used.");
  assert.strictEqual(fallback.fallbackUsed, true, "the fallback must be reported.");
  assert.deepStrictEqual(fallback.lines, ["fallback-line-1", "fallback-line-2"], "the fallback tail must be returned.");
  assert(fallback.note && fallback.note.includes(fallbackFile), "the fallback must say which path was used.");

  const primaryFile = path.join(envRoot, "primary", "agent.log");
  fs.mkdirSync(path.dirname(primaryFile), { recursive: true });
  fs.writeFileSync(primaryFile, "primary-line\n", "utf8");
  const primary = readAgentLogTail({ filePath: primaryFile, fallbackPath: fallbackFile, lines: 10 });
  assert.strictEqual(primary.path, primaryFile, "an existing configured log must win over the fallback.");
  assert.strictEqual(primary.fallbackUsed, undefined, "no fallback may be reported when the configured log exists.");

  // --- per-user file hardening (F1) ----------------------------------------
  // Ownership and root-ownership are simulated through the injected fs/getuid
  // seam, so these legs assert the same rules on every platform. The real-stat
  // path is exercised on POSIX hosts only (win32 has no uid owner model).
  const hardeningUserFile = path.join(envRoot, "hardening-user.env");
  fs.writeFileSync(hardeningUserFile, [
    "ANXHUB_CONFIG_DIR=/redirected/config",
    "ANXHUB_AGENT_CONFIG_PATH=/redirected/agent.json",
    "ANXOS_AGENT_RUNTIME_CONFIG=/redirected/runtime.json",
    "AGENT_TOKEN=anxos_injected",
    `ANXOS_LOG_DIR=${path.join(envRoot, "hardening-logs")}`,
    "AGENT_HOST=10.0.0.77",
  ].join("\n") + "\n", { mode: 0o600 });
  const hardeningSystemFile = path.join(envRoot, "hardening-system.env");
  fs.writeFileSync(hardeningSystemFile, [
    "ANXHUB_CONFIG_DIR=/etc-managed/config",
    "AGENT_TOKEN=anxos_system",
    "ANXOS_LOG_DIR=/etc-managed/logs",
  ].join("\n") + "\n", { mode: 0o644 });

  const injectedFs = (stats) => ({ readFileSync: fs.readFileSync, statSync: () => stats });
  const capturedNotes = [];
  const captureNote = (message) => capturedNotes.push(message);

  // Root + user-owned file: skipped entirely, with a value-free note.
  const rootTarget = {};
  const rootSummary = applyEnvFile({
    env: rootTarget,
    sources: [{ path: hardeningUserFile, role: "user" }],
    fileSystem: injectedFs({ uid: 1000, mode: 0o100600 }),
    getuid: () => 0,
    onNote: captureNote,
    exists: noPackagedPathsExist,
  });
  assert.strictEqual(rootTarget.ANXHUB_CONFIG_DIR, undefined, "root must ignore redirect keys from a user-owned per-user env file.");
  assert.strictEqual(rootTarget.AGENT_TOKEN, undefined, "root must not take AGENT_TOKEN from a user-owned per-user env file.");
  assert.strictEqual(rootTarget.ANXOS_LOG_DIR, undefined, "root must skip a user-owned per-user env file entirely.");
  assert.deepStrictEqual(rootSummary.skippedPaths, [hardeningUserFile], "the skipped per-user file must be reported.");
  assert(rootSummary.notes.some((line) => /not owned by root/.test(line)), "the skip note must say why the file was ignored.");
  assert(!JSON.stringify(rootSummary).includes("anxos_injected") && !JSON.stringify(rootSummary).includes("/redirected"), "the summary and notes must never carry values.");

  // Group/world-writable per-user file: skipped even for its own user.
  const writableTarget = {};
  const writableSummary = applyEnvFile({
    env: writableTarget,
    sources: [{ path: hardeningUserFile, role: "user" }],
    fileSystem: injectedFs({ uid: 1000, mode: 0o100666 }),
    getuid: () => 1000,
    onNote: captureNote,
    exists: noPackagedPathsExist,
  });
  assert.strictEqual(writableTarget.AGENT_HOST, undefined, "a group/world-writable per-user env file must be skipped.");
  assert.deepStrictEqual(writableSummary.skippedPaths, [hardeningUserFile], "the writable file must be reported as skipped.");
  assert(writableSummary.notes.some((line) => /group- or world-writable/.test(line)), "the skip note must name the writability reason.");

  // Owned by the effective non-root uid and 0600: applied, but the redirect
  // keys and AGENT_TOKEN are ignored because the file is not root-owned.
  const ownedTarget = {};
  const ownedSummary = applyEnvFile({
    env: ownedTarget,
    sources: [{ path: hardeningUserFile, role: "user" }],
    fileSystem: injectedFs({ uid: 1000, mode: 0o100600 }),
    getuid: () => 1000,
    onNote: captureNote,
    exists: noPackagedPathsExist,
  });
  assert.strictEqual(ownedTarget.ANXOS_LOG_DIR, path.join(envRoot, "hardening-logs"), "non-restricted keys must still apply from an owner-controlled per-user file.");
  assert.strictEqual(ownedTarget.AGENT_HOST, "10.0.0.77", "AGENT_HOST is not restricted and must apply.");
  for (const key of ["ANXHUB_CONFIG_DIR", "ANXHUB_AGENT_CONFIG_PATH", "ANXOS_AGENT_RUNTIME_CONFIG", "AGENT_TOKEN"]) {
    assert.strictEqual(ownedTarget[key], undefined, `${key} must be ignored from a non-root-owned per-user file.`);
  }
  assert.deepStrictEqual(
    ownedSummary.ignoredKeys,
    ["AGENT_TOKEN", "ANXHUB_AGENT_CONFIG_PATH", "ANXHUB_CONFIG_DIR", "ANXOS_AGENT_RUNTIME_CONFIG"],
    "the ignored restricted keys must be reported by name.",
  );

  // Root + root-owned per-user file: full behavior (restricted keys honored).
  const rootOwnedTarget = {};
  const rootOwnedSummary = applyEnvFile({
    env: rootOwnedTarget,
    sources: [{ path: hardeningUserFile, role: "user" }],
    fileSystem: injectedFs({ uid: 0, mode: 0o100600 }),
    getuid: () => 0,
    onNote: captureNote,
    exists: noPackagedPathsExist,
  });
  assert.strictEqual(rootOwnedTarget.ANXHUB_CONFIG_DIR, "/redirected/config", "a root-owned per-user file must be honored for a root command.");
  assert.strictEqual(rootOwnedTarget.AGENT_TOKEN, "anxos_injected", "a root-owned per-user file may carry AGENT_TOKEN for a root command.");
  assert.deepStrictEqual(rootOwnedSummary.ignoredKeys, [], "nothing may be ignored from a root-owned per-user file.");

  // The system-owned /etc file keeps full behavior and is never stat-gated.
  let statCalls = 0;
  const systemTarget = {};
  applyEnvFile({
    env: systemTarget,
    sources: [{ path: hardeningSystemFile, role: "system" }],
    fileSystem: {
      readFileSync: fs.readFileSync,
      statSync: () => { statCalls += 1; return { uid: 1000, mode: 0o100666 }; },
    },
    getuid: () => 0,
    onNote: captureNote,
    exists: noPackagedPathsExist,
  });
  assert.strictEqual(systemTarget.ANXHUB_CONFIG_DIR, "/etc-managed/config", "the system-owned env file must keep applying ANXHUB_CONFIG_DIR.");
  assert.strictEqual(systemTarget.AGENT_TOKEN, "anxos_system", "the system-owned env file must keep applying AGENT_TOKEN.");
  assert.strictEqual(systemTarget.ANXOS_LOG_DIR, "/etc-managed/logs", "the system-owned env file must keep applying non-restricted keys.");
  assert.strictEqual(statCalls, 0, "the system-owned env file must not be ownership-checked.");

  // Default resolution marks exactly the /etc path as system-owned.
  const resolvedSources = _test.resolveEnvFileSources({ env: { XDG_CONFIG_HOME: envRoot }, homeDir: envRoot });
  assert.deepStrictEqual(resolvedSources.map((source) => source.role), ["system", "user"], "default resolution must treat /etc as system-owned and the XDG file as per-user.");
  assert.strictEqual(resolvedSources[0].path, "/etc/anxos-agent/agent.env", "the system source must be the /etc path.");
  assert(resolvedSources[1].path.startsWith(envRoot), "the per-user source must come from XDG_CONFIG_HOME.");

  // Notes go to stderr outside --json mode and stay silent in --json mode.
  const stderrNotes = [];
  applyEnvFile({
    env: {},
    sources: [{ path: hardeningUserFile, role: "user" }],
    fileSystem: injectedFs({ uid: 1000, mode: 0o100600 }),
    getuid: () => 0,
    stderr: { write: (chunk) => stderrNotes.push(String(chunk)) },
    argv: ["status"],
    exists: noPackagedPathsExist,
  });
  assert(stderrNotes.some((line) => /Ignoring per-user agent env file/.test(line)), "a skipped per-user file must be noted on stderr outside --json mode.");
  const jsonNotes = [];
  applyEnvFile({
    env: {},
    sources: [{ path: hardeningUserFile, role: "user" }],
    fileSystem: injectedFs({ uid: 1000, mode: 0o100600 }),
    getuid: () => 0,
    stderr: { write: (chunk) => jsonNotes.push(String(chunk)) },
    argv: ["status", "--json"],
    exists: noPackagedPathsExist,
  });
  assert.deepStrictEqual(jsonNotes, [], "--json mode must not write skip notes to stderr.");

  // Real-stat path on POSIX hosts. On win32 there is no uid owner model, so
  // the injected-fs legs above are the coverage there.
  if (process.platform === "win32") {
    console.log("SKIP: real per-user ownership stat legs are POSIX-only (win32 has no uid owner model); injected-fs legs cover the logic.");
  } else {
    // The real-stat expectation depends on the effective uid: a root-owned file
    // is exactly the case where a per-user file's restricted keys are honored,
    // so assert the invariant that matches the runner instead of assuming a
    // non-root runner.
    const realUid = process.getuid();
    const rootRunner = realUid === 0;
    const realTarget = {};
    const realSummary = applyEnvFile({
      env: realTarget,
      sources: [{ path: hardeningUserFile, role: "user" }],
      getuid: () => realUid,
      onNote: captureNote,
      exists: noPackagedPathsExist,
    });
    assert.strictEqual(realTarget.AGENT_HOST, "10.0.0.77", "the real 0600 per-user file owned by the effective uid must be read on POSIX.");
    if (rootRunner) {
      assert.strictEqual(realTarget.ANXHUB_CONFIG_DIR, "/redirected/config", "a real root-owned per-user file must be honored for a root command.");
      assert.strictEqual(realTarget.AGENT_TOKEN, "anxos_injected", "a real root-owned per-user file may carry AGENT_TOKEN for a root command.");
      assert.deepStrictEqual(realSummary.ignoredKeys, [], "nothing may be ignored from a real root-owned per-user file.");
      // Cross-owner complement: root must ignore a per-user file that is not
      // root-owned. Simulated through the injected-fs seam because creating a
      // file owned by another uid is not portable.
      const crossOwnerTarget = {};
      const crossOwnerSummary = applyEnvFile({
        env: crossOwnerTarget,
        sources: [{ path: hardeningUserFile, role: "user" }],
        fileSystem: injectedFs({ uid: 1000, mode: 0o100600 }),
        getuid: () => 0,
        onNote: captureNote,
        exists: noPackagedPathsExist,
      });
      assert.strictEqual(crossOwnerTarget.ANXHUB_CONFIG_DIR, undefined, "root must ignore restricted keys from a non-root-owned per-user file.");
      assert.deepStrictEqual(crossOwnerSummary.skippedPaths, [hardeningUserFile], "a non-root-owned per-user file must be reported as skipped for root.");
    } else {
      assert.strictEqual(realTarget.ANXHUB_CONFIG_DIR, undefined, "the real per-user file must still have restricted keys ignored.");
    }
    console.log(rootRunner
      ? "real per-user stat legs executed as root: root-owned restricted keys honored, non-root-owned file ignored via injected-fs"
      : "real per-user stat legs executed as non-root: restricted keys from the real per-user file ignored");

    fs.chmodSync(hardeningUserFile, 0o666);
    const writableRealTarget = {};
    const writableReal = applyEnvFile({
      env: writableRealTarget,
      sources: [{ path: hardeningUserFile, role: "user" }],
      getuid: () => process.getuid(),
      onNote: captureNote,
      exists: noPackagedPathsExist,
    });
    assert.strictEqual(writableRealTarget.AGENT_HOST, undefined, "a real group/world-writable per-user file must be skipped on POSIX.");
    assert.deepStrictEqual(writableReal.skippedPaths, [hardeningUserFile], "the real skipped file must be reported.");
    fs.chmodSync(hardeningUserFile, 0o600);
  }

  console.log("env-file legs passed: parsing, precedence, skip flag, CLI wiring, log fallback, per-user ownership and restricted-key hardening");
}

async function main() {
  const { generateAgentToken, tokenFingerprint } = require("../src/shared/agentTokenStore");
  const port = await getFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  seedAgentConfigFile(port);
  const child = spawnAgent(port);

  let childOutput = "";
  child.stdout.on("data", (chunk) => { childOutput += String(chunk); });
  child.stderr.on("data", (chunk) => { childOutput += String(chunk); });

  try {
    await waitForAgentReady({
      label: "CLI smoke Agent",
      child,
      stderr: () => childOutput,
      probe: async () => (await fetch(`${baseUrl}/api/v1/health`)).ok,
    });

    await runEnvFileLegs(port);

    // --- --version / --help -------------------------------------------------
    const version = await runCli(["--version"], { AGENT_TOKEN }, { port });
    assert.strictEqual(version.code, 0, `--version must exit 0 (stderr: ${version.stderr}).`);
    assert(/^anxos-agent \d+\.\d+\.\d+/.test(version.stdout.trim()), `--version must print the tool version, got: ${JSON.stringify(version.stdout.trim())}`);
    assertNoPermanentToken(version.stdout + version.stderr, "--version output");

    const help = await runCli(["--help"], { AGENT_TOKEN }, { port });
    assert.strictEqual(help.code, 0, "--help must exit 0.");
    assert(help.stdout.includes("Usage:"), "--help must print usage.");
    assert(help.stdout.includes("anxos-agent status") && help.stdout.includes("anxos-agent pair"), "--help must document the status and pair subcommands.");
    assert(help.stdout.includes("ANXOS_TUI_KEYS"), "--help must document the TUI automation seam.");
    assertNoPermanentToken(help.stdout + help.stderr, "--help output");

    // --- status --json ------------------------------------------------------
    const status = await runCli(["status", "--json"], { AGENT_TOKEN }, { port });
    assert.strictEqual(status.code, 0, `status --json must exit 0 (stderr: ${status.stderr}).`);
    const statusJson = JSON.parse(status.stdout);
    assert.strictEqual(statusJson.ok, true, "status --json must report the Agent reachable.");
    assert.strictEqual(statusJson.reachable, true, "status --json must report reachable=true.");
    assert.strictEqual(statusJson.baseUrl, baseUrl, "status --json must report the ephemeral Agent URL.");
    assert(statusJson.agent?.deviceId, "status --json must include the device identity.");
    assert.strictEqual(statusJson.health?.tokenConfigured, true, "status --json must report the configured credential.");
    assert.strictEqual(statusJson.paths?.configDir, configDir, "status --json must report the isolated config dir.");
    assertNoPermanentToken(status.stdout + status.stderr, "status output");

    // --- pair --json --wait: waiting -> paired over the real HTTP flow ------
    const permanentToken = generateAgentToken();
    const waiter = spawnCliStreaming(["pair", "--json", "--wait", "--timeout", "60"], { AGENT_TOKEN }, port);
    let startedEvent = null;
    const startDeadline = Date.now() + 20000;
    while (Date.now() < startDeadline && !startedEvent) {
      const firstLine = waiter.state.stdout.split(/\r?\n/).find((line) => line.trim().startsWith("{"));
      if (firstLine) {
        try {
          const parsed = JSON.parse(firstLine);
          if (parsed.event === "pairing-started") startedEvent = parsed;
        } catch {
          // The line is not complete yet; keep polling.
        }
      }
      if (!startedEvent) await wait(50);
    }
    assert(startedEvent, `pair --json --wait must print a pairing-started event (stdout: ${JSON.stringify(waiter.state.stdout.slice(0, 400))}, stderr: ${JSON.stringify(waiter.state.stderr.slice(0, 400))}).`);
    assert(/^ANX-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(startedEvent.displayCode), `pairing code must use the ANX-XXXX-XXXX-XXXX format, got ${startedEvent.displayCode}.`);

    const waitingStatus = await pairingStatus(baseUrl);
    assert.strictEqual(waitingStatus.status, "waiting", "the Agent must report the started session as waiting.");
    await completePairingOverHttp(baseUrl, startedEvent.pairingCode, permanentToken);
    const consumedStatus = await pairingStatus(baseUrl);
    assert.strictEqual(consumedStatus.status, "not_paired", "completing the session must consume it on the Agent.");
    assert.strictEqual(await authenticatedInstances(baseUrl, permanentToken), 200, "the paired credential must authorize authenticated requests.");

    const waited = await Promise.race([waiter.exited, wait(20000).then(() => null)]);
    if (!waited) {
      try { waiter.child.kill("SIGKILL"); } catch {}
      assert.fail(`pair --json --wait must exit after the code is used (stdout: ${JSON.stringify(waiter.state.stdout.slice(-400))}).`);
    }
    assert.strictEqual(waited.code, 0, `pair --json --wait must exit 0 after pairing (stderr: ${waited.stderr}).`);
    const resultLines = waited.stdout.split(/\r?\n/).filter(Boolean);
    const resultEvent = resultLines.map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter((entry) => entry?.event === "pairing-result").pop();
    assert(resultEvent, "pair --json --wait must print a pairing-result event.");
    assert.strictEqual(resultEvent.state, "paired", `the CLI must report state=paired, got ${resultEvent.state}.`);
    assert.strictEqual(resultEvent.credentialFingerprint, tokenFingerprint(permanentToken), "the reported fingerprint must match the installed credential.");
    assertNoPermanentToken(waited.stdout + waited.stderr, "pair --wait output");

    // --- pair --cancel ------------------------------------------------------
    const start = await runCli(["pair", "--json"], { AGENT_TOKEN }, { port });
    assert.strictEqual(start.code, 0, "pair --json must exit 0.");
    const session = JSON.parse(start.stdout);
    assert.strictEqual(session.state, "waiting", "pair --json must report a waiting session.");
    const cancel = await runCli(["pair", "--cancel", "--json"], { AGENT_TOKEN }, { port });
    assert.strictEqual(cancel.code, 0, `pair --cancel must exit 0 (stderr: ${cancel.stderr}).`);
    const cancelJson = JSON.parse(cancel.stdout);
    assert.strictEqual(cancelJson.cancelled, true, "pair --cancel --json must report cancelled=true.");
    assert.strictEqual((await pairingStatus(baseUrl)).status, "not_paired", "a cancelled session must be gone from the Agent.");
    assertNoPermanentToken(start.stdout + cancel.stdout + cancel.stderr, "pair/cancel output");

    // --- human `pair`: the full code to paste, plus the short reference ------
    // The full code carries the Agent address Control Center needs; the short
    // reference code is only for matching the session on screen. Neither may
    // contain credential material.
    const humanPair = await runCli(["pair"], { AGENT_TOKEN }, { port });
    assert.strictEqual(humanPair.code, 0, `pair must exit 0 (stderr: ${humanPair.stderr}).`);
    assert(humanPair.stdout.includes("Pairing code (paste into Add Computer):"), "the human pair output must label the full code as the code to paste.");
    const humanCodeLine = humanPair.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^ANX-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}\.[A-Za-z0-9_-]+$/.test(line));
    assert(humanCodeLine, `the human pair output must print the full pairing code on its own line (stdout: ${JSON.stringify(humanPair.stdout.slice(0, 400))}).`);
    const humanParsed = parsePairingCode(humanCodeLine);
    assert.strictEqual(humanParsed.agentUrl, baseUrl, "the printed full code must carry the Agent address Control Center needs.");
    assert(humanPair.stdout.includes(`Reference code: ${humanParsed.displayCode}`), "the human pair output must show the short reference code separately.");
    assert(humanPair.stdout.includes("paste the full pairing code above"), "the human pair output must instruct pasting the full code into Add Computer.");
    assertNoPermanentToken(humanPair.stdout + humanPair.stderr, "human pair output");
    const humanCancel = await runCli(["pair", "--cancel", "--json"], { AGENT_TOKEN }, { port });
    assert.strictEqual(humanCancel.code, 0, `cancelling the human pair session must exit 0 (stderr: ${humanCancel.stderr}).`);

    // --- logs --json --------------------------------------------------------
    const logs = await runCli(["logs", "--json"], { AGENT_TOKEN }, { port });
    assert.strictEqual(logs.code, 0, `logs --json must exit 0 (stderr: ${logs.stderr}).`);
    const logsJson = JSON.parse(logs.stdout);
    assert.strictEqual(logsJson.ok, true, "logs --json must read the Agent log.");
    assert(path.resolve(logsJson.path).startsWith(path.resolve(logDir)), `logs --json must read the isolated log dir, got ${logsJson.path}.`);
    assert(Array.isArray(logsJson.lines) && logsJson.lines.length > 0, "the spawned Agent must have written log entries.");
    assertNoPermanentToken(logs.stdout + logs.stderr, "logs output");

    // --- service status --json (platform-dependent, must not throw) ---------
    const service = await runCli(["service", "status", "--json"], { AGENT_TOKEN }, { port });
    assert.strictEqual(service.code, 0, `service status --json must exit 0 (stderr: ${service.stderr}).`);
    const serviceJson = JSON.parse(service.stdout);
    assert.strictEqual(typeof serviceJson.supported, "boolean", "service status must report a supported boolean.");
    assert(["system", "user", "none", "unsupported"].includes(serviceJson.mode), `service status must report a known mode, got ${serviceJson.mode}.`);
    assertNoPermanentToken(service.stdout + service.stderr, "service status output");

    // --- diagnostics --json (redacted, fingerprint-only) --------------------
    const diagnostics = await runCli(["diagnostics", "--json"], { AGENT_TOKEN }, { port });
    assert.strictEqual(diagnostics.code, 0, `diagnostics --json must exit 0 (stderr: ${diagnostics.stderr}).`);
    const diagnosticsJson = JSON.parse(diagnostics.stdout);
    assert.strictEqual(diagnosticsJson.tool?.name, "anxos-agent", "diagnostics must identify the tool.");
    assert.strictEqual(diagnosticsJson.agent?.reachable, true, "diagnostics must report the Agent reachable.");
    assert(Array.isArray(diagnosticsJson.notes) && diagnosticsJson.notes.some((note) => /no credential material/i.test(note)), "diagnostics must state that it contains no credential material.");
    assertNoPermanentToken(diagnostics.stdout + diagnostics.stderr, "diagnostics output");

    // --- exit codes and the non-TTY fallback --------------------------------
    const unknownCommand = await runCli(["definitely-not-a-command"], { AGENT_TOKEN }, { port });
    assert.strictEqual(unknownCommand.code, 2, "an unknown subcommand must exit with the usage code.");
    assert(unknownCommand.stderr.includes("Unknown command"), "an unknown subcommand must explain the failure.");
    const unknownOption = await runCli(["status", "--definitely-not-an-option"], { AGENT_TOKEN }, { port });
    assert.strictEqual(unknownOption.code, 2, "an unknown option must exit with the usage code.");

    const noArgs = await runCli([], { AGENT_TOKEN }, { port });
    assert.strictEqual(noArgs.code, 0, `a piped no-arg invocation must fall back to plain status (stderr: ${noArgs.stderr}).`);
    assert(noArgs.stdout.includes("AnxOS Agent status"), "the non-TTY no-arg fallback must print the plain status report.");
    assert(noArgs.stdout.includes("Reachable:"), "the plain status report must show reachability.");
    assertNoPermanentToken(noArgs.stdout + noArgs.stderr, "no-arg fallback output");

    // --- TUI automation seam: q and pq --------------------------------------
    const tuiQuit = await runCli([], { AGENT_TOKEN, ANXOS_TUI_KEYS: "q" }, { port });
    assert.strictEqual(tuiQuit.code, 0, `ANXOS_TUI_KEYS=q must exit 0 (stderr: ${tuiQuit.stderr}).`);
    assert(tuiQuit.stdout.includes("AnxOS Agent"), "the TUI status view must render a header.");
    assert(tuiQuit.stdout.includes("q quit") || tuiQuit.stdout.includes("[q quit]"), "the TUI must render the key bar.");
    assertNoPermanentToken(tuiQuit.stdout + tuiQuit.stderr, "TUI q output");

    const tuiPairQuit = await runCli([], { AGENT_TOKEN, ANXOS_TUI_KEYS: "pq" }, { port });
    assert.strictEqual(tuiPairQuit.code, 0, `ANXOS_TUI_KEYS=pq must exit 0 (stderr: ${tuiPairQuit.stderr}).`);
    assert(tuiPairQuit.stdout.includes("Pair a computer"), "the TUI pairing view must render.");
    assert(tuiPairQuit.stdout.includes("Pairing code (paste into Add Computer):"), "the TUI pairing view must label the full code as the code to paste.");
    const tuiCode = reconstructWrappedCode(tuiPairQuit.stdout);
    assert(tuiCode, "the TUI pairing view must show the full pairing code fragments.");
    const tuiParsed = parsePairingCode(tuiCode);
    assert.strictEqual(tuiParsed.agentUrl, baseUrl, "the TUI-displayed full code must carry the Agent address Control Center needs.");
    assert(tuiPairQuit.stdout.includes(`Reference code: ${tuiParsed.displayCode}`), "the TUI pairing view must show the short reference code separately.");
    assert(tuiPairQuit.stdout.includes("Expires in"), "the TUI pairing view must show the expiry countdown.");
    assertNoPermanentToken(tuiPairQuit.stdout + tuiPairQuit.stderr, "TUI pq output");

    // --- TUI render failure survival (F5) -----------------------------------
    // A malformed state value makes the real renderer throw. The TUI must not
    // die quietly: it must report the failure, keep the process alive, and
    // restore the terminal when the operator quits.
    const { runTui } = require("../agent/src/tui/tui");
    const fakeInput = createFakeTty();
    const fakeOutput = createFakeTty();
    const malformedStateValue = new Proxy({}, { get() { throw new Error("malformed state"); } });
    const stubTuiClient = {
      resolveConnection: () => ({ primary: "http://127.0.0.1:47131", loopbackOnly: false, token: { readable: true, fingerprint: "smoke" } }),
      health: async () => ({ ok: false, code: "AGENT_UNREACHABLE" }),
      enrollStatus: async () => null,
      pairingStatus: async () => null,
      stats: async () => ({ ok: false, code: "STATS_UNAVAILABLE" }),
    };
    const stubServiceManager = {
      status: () => ({ supported: false, mode: "unsupported", state: "unsupported", reason: "smoke stub" }),
      restart: async () => ({ state: "ok" }),
      setBindingOverride: () => ({ host: "10.0.0.5" }),
    };
    const uncaughtBefore = process.listenerCount("uncaughtException");
    const rejectionBefore = process.listenerCount("unhandledRejection");
    const sigintBefore = process.listenerCount("SIGINT");
    const tuiExitCode = await runTui({
      env: {},
      input: fakeInput,
      output: fakeOutput,
      client: stubTuiClient,
      serviceManager: stubServiceManager,
      state: { update: malformedStateValue },
    });
    assert.strictEqual(tuiExitCode, 0, "the TUI must return normally when a render fails.");
    const tuiScreen = () => fakeOutput.writes.join("");
    assert(
      tuiScreen().includes("Render error") && tuiScreen().includes("malformed state"),
      `the TUI must surface the render failure instead of dying (output: ${JSON.stringify(tuiScreen().slice(0, 300))}).`,
    );
    assert(fakeInput.resumed, "the interactive TUI must resume the input stream.");
    fakeInput.emit("data", "q");
    await wait(100);
    assert(fakeInput.rawModes.includes(true) && fakeInput.rawModes.includes(false), "the TUI must enable raw mode on start and disable it on shutdown.");
    assert(fakeInput.paused, "shutdown must pause the input stream.");
    assert(tuiScreen().includes("\u001b[?25h"), "shutdown must write the cursor restore sequence.");
    assert.strictEqual(process.listenerCount("uncaughtException"), uncaughtBefore, "the TUI must remove its last-resort handlers on shutdown.");
    assert.strictEqual(process.listenerCount("unhandledRejection"), rejectionBefore, "the TUI must remove its last-resort handlers on shutdown.");
    assert.strictEqual(process.listenerCount("SIGINT"), sigintBefore, "the TUI must remove its SIGINT handler on shutdown.");

    await stopChild(child);
    assert(!childOutput.includes(AGENT_TOKEN), "the Agent process output must not contain the credential.");
    console.log("agent:cli:smoke passed — CLI subcommands, pairing flow, TUI seam, env-file hardening, TUI failure survival, and credential redaction verified");
  } finally {
    for (const cliChild of cliChildren) {
      try { cliChild.kill("SIGKILL"); } catch {}
    }
    await stopChild(child);
    fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error("agent:cli:smoke FAILED:", error.stack || error.message);
  process.exitCode = 1;
});
