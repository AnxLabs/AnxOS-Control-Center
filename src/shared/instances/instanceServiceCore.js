const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs/promises");
const fsSync = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const javaRuntimeResolver = require("../minecraftJavaRuntime");
const {
  buildConfigModel,
  getAdapter,
  hashContent,
  mergeSubmittedValues,
  serializeDocument,
} = require("../gameServerConfigManager");

let runtimeConfigProvider = () => ({
  instanceRoot: process.env.AGENT_INSTANCE_ROOT || path.join(process.cwd(), "instances"),
});
let resolveJavaRuntimeProvider = javaRuntimeResolver.resolveJavaRuntime;

function configureInstanceService(options = {}) {
  if (typeof options.getConfig === "function") {
    runtimeConfigProvider = options.getConfig;
  }
  if (typeof options.resolveJavaRuntime === "function") {
    resolveJavaRuntimeProvider = options.resolveJavaRuntime;
  }
}

function getConfig() {
  return runtimeConfigProvider();
}

const INSTANCE_STATES = Object.freeze({
  STOPPED: "Stopped",
  STARTING: "Starting",
  RUNNING: "Running",
  STOPPING: "Stopping",
  RESTARTING: "Restarting",
  FAILED: "Failed",
  UNKNOWN: "Unknown",
  SETUP_REQUIRED: "Setup Required",
});

const INSTANCE_TYPES = new Set([
  "custom-command",
  "node-app",
  "python-app",
  "java-app",
  "minecraft-paper",
]);

const DEFAULT_RESTART_POLICY = "never";
const RESTART_POLICIES = new Set(["never", "on-failure", "always"]);
const DEFAULT_STARTUP_TIMEOUT_MS = 15000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10000;
const MAX_STARTUP_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const MAX_SHUTDOWN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_LOG_LINES = 1000;
const STARTUP_EARLY_EXIT_MS = 8000;
const RESTART_BACKOFF_BASE_MS = 1000;
const RESTART_BACKOFF_MAX_MS = 30000;
const RESTART_BACKOFF_MAX_IMMEDIATE_FAILURES = 5;
const PROCESS_TAIL_LINE_LIMIT = 20;
const PORT_CONNECT_TIMEOUT_MS = 500;
const PROC_STAT_TICKS_PER_SECOND = 100;
const PAGE_SIZE_BYTES = 4096;
const VERSION_CACHE_VERSION = 4;
const INSTANCE_CONFIG_SCHEMA_VERSION = 1;
const ATOMIC_RENAME_RETRY_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const ATOMIC_RENAME_RETRY_ATTEMPTS = 5;
const ATOMIC_RENAME_RETRY_DELAY_MS = 25;
const FIVEM_LICENSE_MESSAGE = "FiveM needs a valid license key in server.cfg before it can start.";
const FIVEM_CONFIG_RELATIVE_PATH = "server/server.cfg";
const FIVEM_LICENSE_PLACEHOLDERS = new Set([
  "CHANGE_ME",
  "CHANGE_ME_FIVEM_LICENSE_KEY",
  "YOUR_LICENSE_KEY",
  "YOUR_FIVEM_LICENSE_KEY",
  "LICENSE_KEY_HERE",
]);
const FIVEM_LICENSE_FAILURE_PATTERN = /Invalid key format specified|Could not authenticate server license key|HTTP 429/i;
const DEFAULT_EXECUTABLE_ROOTS = [
  "/bin",
  "/usr/bin",
  "/usr/local/bin",
  "/sbin",
  "/usr/sbin",
  "/usr/local/sbin",
  "/srv/anxos/bin",
  "/usr/lib/jvm",
  "/usr/java",
  "/opt/java",
  "/opt/jdk",
  "/srv/anxos/runtimes",
];

const runningProcesses = new Map();
const metricsSamples = new Map();
const restartBackoffStates = new Map();
const restartTimers = new Map();
const versionRefreshTimers = new Map();
const installationSessions = new Map();
let processInspectionProvider = null;
let processAliveProvider = null;

const INSTALLER_PHASES = Object.freeze({
  forge: Object.freeze({
    "install-server": Object.freeze({ executable: "java", args: ["-jar", "forge-installer.jar", "--installServer"] }),
  }),
  neoforge: Object.freeze({
    "install-server": Object.freeze({ executable: "java", args: ["-jar", "neoforge-installer.jar", "--installServer"] }),
  }),
  quilt: Object.freeze({ "install-server": true }),
});
const INSTALLATION_OPERATION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const INSTALLER_TIMEOUT_MIN_MS = 1000;
const INSTALLER_TIMEOUT_MAX_MS = 10 * 60 * 1000;
const INSTALLER_OUTPUT_MAX_BYTES = 1024 * 1024;
const LEGACY_STEAMCMD_TEMPLATES = Object.freeze({
  palworld: { appId: 2394010, installDir: "server", verifyFiles: ["server/PalServer.sh", "server/Pal/Binaries/Linux/PalServer-Linux-Shipping"] },
  valheim: { appId: 896660, installDir: "server", verifyFiles: ["server/valheim_server.x86_64"] },
  rust: { appId: 258550, installDir: "server", verifyFiles: ["server/RustDedicated"] },
  cs2: { appId: 730, installDir: "server", verifyFiles: ["server/game/bin/linuxsteamrt64/cs2"] },
});
const STEAM_UPDATE_OPERATION_ID_PATTERN = INSTALLATION_OPERATION_ID_PATTERN;

function createInstanceError(code, statusCode = 400, details = {}) {
  return Object.assign(new Error(code), { code, statusCode, ...details });
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeRuntimeJarName(value) {
  return String(value || "").trim().replace(/\\/g, "/").split("/").pop().toLowerCase();
}

function isInstallerRuntimeJar(value) {
  const fileName = normalizeRuntimeJarName(value);
  return Boolean(fileName) && /(?:^|[-_.])(?:neo)?forge[-_.].*installer.*\.jar$|^(?:neo)?forge-installer\.jar$|^neoforge-installer\.jar$/i.test(fileName);
}

function isScriptPath(value) {
  return /\.(?:sh|bash|bat|cmd)$/i.test(String(value || "").trim());
}

function hasScriptRuntimeLaunch(config = {}) {
  const executable = String(config.executable || config.command || "").trim().toLowerCase();
  const args = Array.isArray(config.args) ? config.args : [];
  return isScriptPath(config.startScript || config.startupScript || config.launchScript) ||
    ((executable === "bash" || executable === "sh" || executable === "cmd.exe" || executable === "cmd") && args.some(isScriptPath)) ||
    String(config.launchType || "").trim().toLowerCase() === "script";
}

function clearInstallerRuntimeJarMetadata(config = {}) {
  if (!hasScriptRuntimeLaunch(config)) {
    return config;
  }
  let changed = false;
  const next = { ...config };
  for (const field of ["jar", "serverJar", "serverJarPath", "startJar"]) {
    if (isInstallerRuntimeJar(next[field])) {
      next[field] = null;
      changed = true;
    }
  }
  return changed ? next : config;
}

function execFile(command, args, options = {}) {
  return new Promise((resolve) => {
    childProcess.execFile(command, args, {
      timeout: options.timeout || 3000,
      maxBuffer: options.maxBuffer || 512 * 1024,
      cwd: options.cwd,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout || "",
        stderr: stderr || "",
      });
    });
  });
}

function getInstanceRoot() {
  return path.resolve(getConfig().instanceRoot);
}

function isInsideRoot(filePath, root) {
  const relative = path.relative(root, filePath);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function getInstallationSession(instanceId) {
  return installationSessions.get(validateInstanceId(instanceId)) || null;
}

function validateInstallationSession(session, operationId, token) {
  if (!session || session.operationId !== operationId || !token || session.token !== token) {
    throw createInstanceError("INSTALLATION_SESSION_INVALID", 403);
  }
  if (session.closed) {
    throw createInstanceError("INSTALLATION_SESSION_CLOSED", 409);
  }
  return session;
}

async function beginInstallationSession(instanceId, request = {}) {
  const config = await loadInstanceConfig(instanceId);
  if (config.installationState !== "installing") {
    throw createInstanceError("INSTALLATION_STATE_INVALID", 409, { installationState: config.installationState || null });
  }
  const operationId = String(request.operationId || "").trim();
  const installerFamily = String(request.installerFamily || "").trim().toLowerCase();
  if (!INSTALLATION_OPERATION_ID_PATTERN.test(operationId)) {
    throw createInstanceError("INSTALLATION_OPERATION_INVALID", 400);
  }
  if (!config.installationOperationId || config.installationOperationId !== operationId) {
    throw createInstanceError("INSTALLATION_OPERATION_MISMATCH", 403);
  }
  if (!INSTALLER_PHASES[installerFamily]) {
    throw createInstanceError("INSTALLER_FAMILY_NOT_ALLOWED", 400);
  }
  const existing = getInstallationSession(config.id);
  if (existing && !existing.closed) {
    throw createInstanceError("INSTALLATION_SESSION_CONFLICT", 409);
  }
  const session = {
    instanceId: config.id,
    operationId,
    installerFamily,
    token: crypto.randomBytes(32).toString("base64url"),
    child: null,
    closed: false,
    createdAt: Date.now(),
  };
  installationSessions.set(config.id, session);
  return { operationId, token: session.token, installerFamily, status: "ready" };
}

function appendBoundedOutput(current, chunk) {
  const next = `${current}${String(chunk || "")}`;
  if (Buffer.byteLength(next) <= INSTALLER_OUTPUT_MAX_BYTES) return next;
  return Buffer.from(next).subarray(-INSTALLER_OUTPUT_MAX_BYTES).toString("utf8");
}

function resolveTrustedInstallerCommand(session, config, phase) {
  if (session.installerFamily === "quilt" && phase === "install-server") {
    const minecraftVersion = String(config.minecraftVersion || "").trim();
    const loaderVersion = String(config.loaderVersion || "").trim();
    const safeVersion = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,79}$/;
    if (!safeVersion.test(minecraftVersion) || !safeVersion.test(loaderVersion)) {
      throw createInstanceError("INSTALLER_CONFIGURATION_INVALID", 400, { installerFamily: "quilt", phase });
    }
    return { executable: "java", args: ["-jar", "quilt-installer.jar", "install", "server", minecraftVersion, loaderVersion, "--download-server"] };
  }
  const trusted = INSTALLER_PHASES[session.installerFamily]?.[phase] || null;
  // Test-only executable injection keeps installer-session smoke tests
  // deterministic on hosts without Java. It is unreachable unless the Agent
  // is explicitly running with NODE_ENV=test and a test-provided path.
  if (trusted && process.env.NODE_ENV === "test" && process.env.ANXOS_TEST_INSTALLER_STUB_PATH) {
    return { ...trusted, executable: process.execPath, args: [process.env.ANXOS_TEST_INSTALLER_STUB_PATH, ...trusted.args] };
  }
  return trusted;
}

async function executeInstallationPhase(instanceId, request = {}) {
  const config = await loadInstanceConfig(instanceId);
  if (config.installationState !== "installing") {
    throw createInstanceError("INSTALLATION_STATE_INVALID", 409, { installationState: config.installationState || null });
  }
  const operationId = String(request.operationId || "").trim();
  const token = String(request.token || "");
  const phase = String(request.phase || "").trim().toLowerCase();
  const session = validateInstallationSession(getInstallationSession(config.id), operationId, token);
  const command = resolveTrustedInstallerCommand(session, config, phase);
  if (!command) {
    throw createInstanceError("INSTALLER_PHASE_NOT_ALLOWED", 400, { installerFamily: session.installerFamily, phase });
  }
  if (session.child) {
    throw createInstanceError("INSTALLER_ALREADY_RUNNING", 409);
  }
  const timeoutMs = Math.min(INSTALLER_TIMEOUT_MAX_MS, Math.max(INSTALLER_TIMEOUT_MIN_MS, Number(request.timeoutMs) || 300000));
  const workingDirectory = resolveRelativeManagedPath(config.id, "data", "data");
  const startedAt = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let cancelled = false;

  const result = await new Promise((resolve, reject) => {
    let child;
    try {
      child = childProcess.spawn(command.executable, command.args, {
        cwd: workingDirectory,
        env: buildSpawnEnvironment(config),
        detached: false,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      reject(createInstanceError("INSTALLER_SPAWN_FAILED", 500, { causeCode: error?.code || null }));
      return;
    }
    session.child = child;
    session.cancel = () => {
      cancelled = true;
      if (!child.killed) child.kill("SIGKILL");
    };
    child.stdout?.on("data", (chunk) => { stdout = appendBoundedOutput(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendBoundedOutput(stderr, chunk); });
    child.once("error", (error) => reject(createInstanceError("INSTALLER_PROCESS_ERROR", 500, { causeCode: error?.code || null })));
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    const timer = setTimeout(() => {
      timedOut = true;
      if (!child.killed) child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", () => clearTimeout(timer));
  }).finally(() => {
    session.child = null;
    session.cancel = null;
  });

  const durationMs = Date.now() - startedAt;
  const details = { operationId, installerFamily: session.installerFamily, phase, exitCode: result.exitCode, signal: result.signal || null, timeoutMs, durationMs, stdout, stderr };
  if (cancelled) throw createInstanceError("INSTALLER_CANCELLED", 409, details);
  if (timedOut) throw createInstanceError("INSTALLER_TIMEOUT", 504, details);
  if (result.exitCode !== 0) throw createInstanceError("INSTALLER_EXIT_NONZERO", 422, details);
  return { ok: true, ...details };
}

async function closeInstallationSession(instanceId, request = {}) {
  const id = validateInstanceId(instanceId);
  const session = validateInstallationSession(getInstallationSession(id), String(request.operationId || "").trim(), String(request.token || ""));
  if (session.child) throw createInstanceError("INSTALLER_ALREADY_RUNNING", 409);
  session.closed = true;
  installationSessions.delete(id);
  return { closed: true, operationId: session.operationId };
}

async function cancelInstallationSession(instanceId, request = {}) {
  const id = validateInstanceId(instanceId);
  const session = validateInstallationSession(getInstallationSession(id), String(request.operationId || "").trim(), String(request.token || ""));
  if (session.cancel) session.cancel();
  session.closed = true;
  if (!session.child) installationSessions.delete(id);
  return { cancelled: true, operationId: session.operationId };
}

async function beginSteamCmdUpdateSession(instanceId, request = {}) {
  const config = await loadInstanceConfig(instanceId);
  if (config.installerType !== "steamcmd-native" || !Number.isInteger(config.steamAppId) || config.steamAppId < 1) {
    throw createInstanceError("STEAMCMD_UPDATE_UNSUPPORTED", 409);
  }
  if (config.state !== INSTANCE_STATES.STOPPED || runningProcesses.has(config.id)) {
    throw createInstanceError("STEAMCMD_UPDATE_REQUIRES_STOPPED", 409, { state: config.state });
  }
  const operationId = String(request.operationId || "").trim();
  if (!STEAM_UPDATE_OPERATION_ID_PATTERN.test(operationId)) throw createInstanceError("INSTALLATION_OPERATION_INVALID", 400);
  const existing = getInstallationSession(config.id);
  if (existing && !existing.closed) throw createInstanceError("STEAMCMD_UPDATE_CONFLICT", 409);
  const session = { instanceId: config.id, operationId, installerFamily: "steamcmd-update", token: crypto.randomBytes(32).toString("base64url"), child: null, closed: false, createdAt: Date.now() };
  installationSessions.set(config.id, session);
  return { operationId, token: session.token, status: "ready", appId: config.steamAppId };
}

async function repairLegacySteamCmdMetadata(instanceId) {
  const config = await loadInstanceConfig(instanceId);
  if (config.installerType === "steamcmd-native" && config.steamAppId) return publicConfig(config);
  const template = LEGACY_STEAMCMD_TEMPLATES[String(config.templateId || "").toLowerCase()];
  if (!template) throw createInstanceError("STEAMCMD_METADATA_MIGRATION_REQUIRED", 409, { templateId: config.templateId || null });
  if (config.state !== INSTANCE_STATES.STOPPED || runningProcesses.has(config.id)) throw createInstanceError("STEAMCMD_UPDATE_REQUIRES_STOPPED", 409);
  const root = path.resolve(instancePath(config.id));
  if (!isInsideRoot(root, getInstanceRoot())) throw createInstanceError("PATH_NOT_ALLOWED", 403);
  const verifyFiles = template.verifyFiles.filter((relative) => {
    const target = path.resolve(root, "data", relative);
    return isInsideRoot(target, path.join(root, "data"));
  });
  if (!verifyFiles.length) throw createInstanceError("STEAMCMD_METADATA_AMBIGUOUS", 409);
  const found = [];
  for (const relative of verifyFiles) {
    if (await pathExists(path.resolve(root, "data", relative))) found.push(relative);
  }
  if (!found.length) throw createInstanceError("STEAMCMD_UPDATE_ARTIFACTS_MISSING", 422, { templateId: config.templateId, expected: verifyFiles });
  const next = { ...config, installerType: "steamcmd-native", steamAppId: template.appId, steamInstallDir: template.installDir, steamVerifyFiles: found, updatedAt: nowIso() };
  await saveInstanceConfig(next);
  return publicConfig(next);
}

async function executeSteamCmdUpdate(instanceId, request = {}) {
  const config = await loadInstanceConfig(instanceId);
  if (config.installerType !== "steamcmd-native" || !Number.isInteger(config.steamAppId) || config.steamAppId < 1) throw createInstanceError("STEAMCMD_UPDATE_UNSUPPORTED", 409);
  if (config.state !== INSTANCE_STATES.STOPPED || runningProcesses.has(config.id)) throw createInstanceError("STEAMCMD_UPDATE_REQUIRES_STOPPED", 409, { state: config.state });
  const session = validateInstallationSession(getInstallationSession(config.id), String(request.operationId || "").trim(), String(request.token || ""));
  if (session.installerFamily !== "steamcmd-update") throw createInstanceError("INSTALLATION_SESSION_INVALID", 403);
  if (session.child) throw createInstanceError("STEAMCMD_UPDATE_CONFLICT", 409);
  const installDir = String(config.steamInstallDir || "server").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/.test(installDir) || path.isAbsolute(installDir) || installDir.includes("..")) throw createInstanceError("PATH_NOT_ALLOWED", 403);
  const workingDirectory = resolveRelativeManagedPath(config.id, "data", "data");
  const args = ["+force_install_dir", installDir, "+login", "anonymous", "+app_update", String(config.steamAppId), "validate", "+quit"];
  const timeoutMs = Math.min(INSTALLER_TIMEOUT_MAX_MS, Math.max(INSTALLER_TIMEOUT_MIN_MS, Number(request.timeoutMs) || 10 * 60 * 1000));
  const startedAt = Date.now(); let stdout = ""; let stderr = ""; let timedOut = false; let cancelled = false;
  const result = await new Promise((resolve, reject) => {
    let child;
    try { child = childProcess.spawn("steamcmd", args, { cwd: workingDirectory, env: buildSpawnEnvironment(config), shell: false, detached: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
    catch (error) { reject(createInstanceError("STEAMCMD_SPAWN_FAILED", 500, { causeCode: error?.code || null })); return; }
    session.child = child; session.cancel = () => { cancelled = true; if (!child.killed) child.kill("SIGKILL"); };
    child.stdout?.on("data", (chunk) => { stdout = appendBoundedOutput(stdout, chunk); }); child.stderr?.on("data", (chunk) => { stderr = appendBoundedOutput(stderr, chunk); });
    child.once("error", (error) => reject(createInstanceError("STEAMCMD_PROCESS_ERROR", 500, { causeCode: error?.code || null })));
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    const timer = setTimeout(() => { timedOut = true; if (!child.killed) child.kill("SIGKILL"); }, timeoutMs); child.once("close", () => clearTimeout(timer));
  }).finally(() => { session.child = null; session.cancel = null; });
  const details = { operationId: session.operationId, appId: config.steamAppId, args, exitCode: result.exitCode, signal: result.signal || null, timeoutMs, durationMs: Date.now() - startedAt, stdout, stderr };
  if (cancelled) throw createInstanceError("STEAMCMD_UPDATE_CANCELLED", 409, details);
  if (timedOut) throw createInstanceError("STEAMCMD_UPDATE_TIMEOUT", 504, details);
  if (result.exitCode !== 0) throw createInstanceError("STEAMCMD_UPDATE_FAILED", 422, details);
  const verifyFiles = Array.isArray(config.steamVerifyFiles) ? config.steamVerifyFiles : [];
  for (const relative of verifyFiles) {
    const target = resolveRelativeManagedPath(config.id, `data/${relative}`, "data");
    if (!await pathExists(target)) throw createInstanceError("STEAMCMD_UPDATE_ARTIFACTS_MISSING", 422, { ...details, missing: relative });
  }
  return { ok: true, ...details, verified: verifyFiles };
}

function terminateInstallationSession(instanceId) {
  const session = installationSessions.get(instanceId);
  if (!session) return;
  if (session.cancel) session.cancel();
  session.closed = true;
  installationSessions.delete(instanceId);
}

function validateInstanceId(value) {
  const id = String(value || "").trim();

  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(id)) {
    throw createInstanceError("INVALID_INSTANCE_ID");
  }

  return id;
}

function validateDisplayName(value, fallback) {
  const displayName = String(value || fallback || "").trim();

  if (!displayName || displayName.length > 120 || /[\0\r\n]/.test(displayName)) {
    throw createInstanceError("INVALID_DISPLAY_NAME");
  }

  return displayName;
}

function validateInstanceType(value) {
  const type = String(value || "").trim();

  if (!INSTANCE_TYPES.has(type)) {
    throw createInstanceError("INVALID_INSTANCE_TYPE");
  }

  return type;
}

function validateBoolean(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function parseStrictPositiveInteger(value) {
  const raw = typeof value === "string" ? value.trim() : value;
  if (typeof raw === "number") {
    return Number.isInteger(raw) ? raw : NaN;
  }
  return /^[0-9]+$/.test(String(raw)) ? Number(raw) : NaN;
}

function validatePositiveInteger(value, fallback, max = Number.MAX_SAFE_INTEGER, field = "number") {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = parseStrictPositiveInteger(value);

  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw createInstanceError("INVALID_NUMBER", 400, { field, expected: `positive integer up to ${max}`, received: value });
  }

  return parsed;
}

function normalizeStringArray(value, fieldName, maxItems = 64) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value) || value.length > maxItems) {
    throw createInstanceError(`INVALID_${fieldName}`);
  }

  return value.map((entry) => {
    const normalized = String(entry || "").trim();

    if (!normalized || normalized.includes("\0") || normalized.length > 512) {
      throw createInstanceError(`INVALID_${fieldName}`);
    }

    return normalized;
  });
}

function normalizeTags(value) {
  return normalizeStringArray(value, "TAGS", 32).map((tag) => {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/.test(tag)) {
      throw createInstanceError("INVALID_TAGS");
    }

    return tag;
  });
}

function normalizeInstallationState(value, fallback = "active") {
  if (value === undefined || value === null || value === "") return fallback;
  if (["installing", "active"].includes(value)) return value;
  throw createInstanceError("INSTALLATION_STATE_INVALID");
}

function normalizeOptionalJarPath(value) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === "") {
    return null;
  }
  return validateRelativeAssetPath(value, "JAR");
}

function normalizePorts(value) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value) || value.length > 32) {
    throw createInstanceError("INVALID_PORTS");
  }

  return value.map((port) => {
    const parsed = parseStrictPositiveInteger(port);

    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw createInstanceError("INVALID_PORTS");
    }

    return parsed;
  });
}

function normalizeEnvironment(value) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== "object" || Array.isArray(value)) {
    throw createInstanceError("INVALID_ENVIRONMENT");
  }

  const entries = Object.entries(value);

  if (entries.length > 128) {
    throw createInstanceError("INVALID_ENVIRONMENT");
  }

  return entries.reduce((environment, [key, rawValue]) => {
    const normalizedKey = String(key || "").trim();

    if (!/^[A-Z_][A-Z0-9_]{0,127}$/i.test(normalizedKey)) {
      throw createInstanceError("INVALID_ENVIRONMENT");
    }

    if (/token|secret|password|credential|api[_-]?key/i.test(normalizedKey)) {
      throw createInstanceError("SECRET_ENVIRONMENT_NOT_ALLOWED");
    }

    const normalizedValue = String(rawValue ?? "");

    if (normalizedValue.includes("\0") || normalizedValue.length > 4096) {
      throw createInstanceError("INVALID_ENVIRONMENT");
    }

    environment[normalizedKey] = normalizedValue;
    return environment;
  }, {});
}

function validateRestartPolicy(value) {
  const restartPolicy = String(value || DEFAULT_RESTART_POLICY).trim();

  if (!RESTART_POLICIES.has(restartPolicy)) {
    throw createInstanceError("INVALID_RESTART_POLICY");
  }

  return restartPolicy;
}

function validateExecutable(value) {
  const executable = String(value || "").trim();

  if (!executable || executable.includes("\0") || executable.length > 256) {
    throw createInstanceError("INVALID_EXECUTABLE");
  }

  if (/[;&|`$<>]/.test(executable)) {
    throw createInstanceError("INVALID_EXECUTABLE");
  }

  if (executable.includes("/") && !path.isAbsolute(executable)) {
    throw createInstanceError("INVALID_EXECUTABLE");
  }

  if (!executable.includes("/") && !/^[a-zA-Z0-9_.+-]+$/.test(executable)) {
    throw createInstanceError("INVALID_EXECUTABLE");
  }

  return executable;
}

function getExecutableRoots() {
  const configuredRoots = process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS
    ? process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS.split(path.delimiter)
    : DEFAULT_EXECUTABLE_ROOTS;

  return configuredRoots.map((root) => path.resolve(root.trim())).filter(Boolean);
}

function assertExecutableAllowed(executable) {
  if (!path.isAbsolute(executable)) {
    return;
  }

  const resolvedExecutable = path.resolve(executable);
  const allowedRoots = [...getExecutableRoots(), getInstanceRoot()];

  if (!allowedRoots.some((root) => isInsideRoot(resolvedExecutable, root))) {
    throw createInstanceError("EXECUTABLE_NOT_ALLOWED", 403);
  }
}

function validateRelativeAssetPath(value, fieldName) {
  const assetPath = String(value || "").trim();

  if (!assetPath || assetPath.includes("\0") || path.isAbsolute(assetPath)) {
    throw createInstanceError(`INVALID_${fieldName}`);
  }

  const normalized = path.normalize(assetPath);

  if (normalized === "." || normalized.startsWith("..") || normalized.split(path.sep).includes("..")) {
    throw createInstanceError(`INVALID_${fieldName}`);
  }

  return normalized;
}

function validateMemoryValue(value) {
  if (!value) {
    return "";
  }

  const memory = String(value).trim();

  if (!/^[1-9][0-9]{0,5}[kKmMgG]?$/.test(memory)) {
    throw createInstanceError("INVALID_MEMORY_LIMIT");
  }

  return memory;
}

function isJavaJvmArgument(value) {
  const text = String(value || "");
  return /^-(?:X|D|agentlib:|agentpath:|javaagent:)/.test(text) ||
    /^--(?:add-|enable-|illegal-|module-|limit-|patch-|upgrade-|add-|show-|splash|verbose|enable-preview)/.test(text);
}

function normalizeJavaJarCommandArgs(args = [], jarPath = "app.jar") {
  const rawArgs = Array.isArray(args) ? args.map((arg) => String(arg || "").trim()).filter(Boolean) : [];
  const firstJarIndex = rawArgs.findIndex((arg) => arg === "-jar");
  const detectedJar = firstJarIndex >= 0 && rawArgs[firstJarIndex + 1]
    ? rawArgs[firstJarIndex + 1]
    : jarPath;
  const jar = validateRelativeAssetPath(detectedJar || jarPath, "JAR");
  const jvmArgs = [];
  const appArgs = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "-jar") {
      index += 1;
      continue;
    }
    if (arg === jar) {
      continue;
    }
    if (isJavaJvmArgument(arg)) {
      jvmArgs.push(arg);
    } else {
      appArgs.push(arg);
    }
  }

  return [...jvmArgs, "-jar", jar, ...appArgs];
}

function shellCommandJoinIndex(executable, args = []) {
  const name = executableName(executable);
  const first = String(args[0] || "").toLowerCase();
  const second = String(args[1] || "").toLowerCase();

  if ((name === "bash" || name === "sh") && (first === "-c" || first === "-lc")) {
    return 1;
  }

  if ((name === "powershell" || name === "powershell.exe" || name === "pwsh" || name === "pwsh.exe") && second !== "-encodedcommand") {
    const commandIndex = args.findIndex((arg) => /^-(?:command|c)$/i.test(String(arg || "")));
    return commandIndex >= 0 ? commandIndex + 1 : -1;
  }

  return -1;
}

function normalizeShellWrapperArgs(executable, args = []) {
  const normalizedArgs = Array.isArray(args) ? args.map((arg) => String(arg ?? "").trim()).filter(Boolean) : [];
  const joinIndex = shellCommandJoinIndex(executable, normalizedArgs);

  if (joinIndex < 0 || normalizedArgs.length <= joinIndex + 1) {
    return normalizedArgs;
  }

  return [
    ...normalizedArgs.slice(0, joinIndex),
    normalizedArgs.slice(joinIndex).join(" "),
  ];
}

function instancePath(instanceId) {
  return path.join(getInstanceRoot(), instanceId);
}

function configPath(instanceId) {
  return path.join(instancePath(instanceId), "config.json");
}

function logPath(instanceId, streamName) {
  return path.join(instancePath(instanceId), "logs", `${streamName}.log`);
}

async function ensureManagedPath(filePath) {
  const root = getInstanceRoot();
  const resolved = path.resolve(filePath);

  if (!isInsideRoot(resolved, root)) {
    throw createInstanceError("PATH_NOT_ALLOWED", 403);
  }

  return resolved;
}

async function ensureInstanceDirectories(instanceId) {
  const basePath = await ensureManagedPath(instancePath(instanceId));

  await fs.mkdir(path.join(basePath, "logs"), { recursive: true });
  await fs.mkdir(path.join(basePath, "data"), { recursive: true });
  await fs.mkdir(path.join(basePath, "runtime"), { recursive: true });

  return basePath;
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await atomicWriteManagedFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function isTransientAtomicRenameError(error) {
  return process.platform === "win32" && ATOMIC_RENAME_RETRY_CODES.has(error?.code);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameManagedFileWithRetry(tempPath, filePath) {
  let lastError = null;
  for (let attempt = 0; attempt <= ATOMIC_RENAME_RETRY_ATTEMPTS; attempt += 1) {
    try {
      await fs.rename(tempPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientAtomicRenameError(error) || attempt >= ATOMIC_RENAME_RETRY_ATTEMPTS) {
        throw error;
      }
      await wait(ATOMIC_RENAME_RETRY_DELAY_MS);
    }
  }
  throw lastError;
}

async function atomicWriteManagedFile(filePath, content, options = {}) {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(tempPath, content, { ...options, flag: "wx", mode: options.mode || 0o600 });
    await renameManagedFileWithRetry(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function resolveRelativeManagedPath(instanceId, value, fallback) {
  const relativePath = String(value || fallback || "").trim();

  if (!relativePath || relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw createInstanceError("INVALID_PATH");
  }

  const resolved = path.resolve(instancePath(instanceId), relativePath);

  if (!isInsideRoot(resolved, instancePath(instanceId))) {
    throw createInstanceError("PATH_NOT_ALLOWED", 403);
  }

  return resolved;
}

function resolveInstanceDataPath(instanceId, value = ".") {
  const relativePath = String(value || ".").trim();

  if (relativePath.includes("\0") || path.isAbsolute(relativePath)) {
    throw createInstanceError("INVALID_PATH");
  }

  const dataRoot = path.join(instancePath(instanceId), "data");
  const resolved = path.resolve(dataRoot, relativePath);

  if (!isInsideRoot(resolved, dataRoot)) {
    throw createInstanceError("PATH_NOT_ALLOWED", 403);
  }

  return {
    path: resolved,
    root: dataRoot,
    relativePath: path.relative(dataRoot, resolved) || ".",
  };
}

async function assertNoInstanceDataEscape(resolved, options = {}) {
  const realRoot = await fs.realpath(resolved.root).catch(() => path.resolve(resolved.root));
  const existingTarget = await fs.realpath(resolved.path).catch(() => null);

  if (existingTarget && !isInsideRoot(existingTarget, realRoot)) {
    throw createInstanceError("PATH_NOT_ALLOWED", 403);
  }

  if (options.forWrite) {
    const parent = path.dirname(resolved.path);
    let existingAncestor = parent;
    while (!await fs.lstat(existingAncestor).then(() => true, (error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    })) {
      const next = path.dirname(existingAncestor);
      if (next === existingAncestor) break;
      existingAncestor = next;
    }
    const realAncestor = await fs.realpath(existingAncestor).catch(() => path.resolve(existingAncestor));
    if (!isInsideRoot(realAncestor, realRoot)) {
      throw createInstanceError("PATH_NOT_ALLOWED", 403);
    }
    await fs.mkdir(parent, { recursive: true });
    const realParent = await fs.realpath(parent).catch(() => path.resolve(parent));
    if (!isInsideRoot(realParent, realRoot)) {
      throw createInstanceError("PATH_NOT_ALLOWED", 403);
    }
  }
}

function buildTypeCommand(type, payload) {
  const rawArgs = normalizeStringArray(payload.args, "ARGS", 128);

  if (type === "custom-command") {
    const executable = validateExecutable(payload.executable || payload.command);
    return {
      executable,
      args: normalizeShellWrapperArgs(executable, rawArgs),
    };
  }

  if (type === "node-app") {
    const executable = validateExecutable(payload.executable || "node");
    const entrypoint = validateRelativeAssetPath(payload.entrypoint || "index.js", "ENTRYPOINT");
    return {
      executable,
      args: [entrypoint, ...normalizeShellWrapperArgs(executable, rawArgs)],
    };
  }

  if (type === "python-app") {
    const executable = validateExecutable(payload.executable || "python3");
    const entrypoint = validateRelativeAssetPath(payload.entrypoint || "app.py", "ENTRYPOINT");
    return {
      executable,
      args: [entrypoint, ...normalizeShellWrapperArgs(executable, rawArgs)],
    };
  }

  if (type === "java-app") {
    const executable = validateExecutable(payload.executable || (rawArgs.some(isStartupScript) ? "bash" : "java"));
    const args = normalizeShellWrapperArgs(executable, rawArgs);
    const scriptCommand = buildStartupScriptCommand(executable, args);
    if (scriptCommand) {
      return scriptCommand;
    }
    if (isScriptExecutable(executable) || args.some(isStartupScript)) {
      const scriptArgs = args.length > 0
        ? args
        : normalizeStringArray(payload.startupArguments, "ARGS", 128);
      return {
        executable,
        args: scriptArgs,
      };
    }
    const jar = validateRelativeAssetPath(payload.jar || payload.serverJar || payload.entrypoint || "app.jar", "JAR");
    return {
      executable: validateExecutable(payload.executable || "java"),
      args: normalizeJavaJarCommandArgs(args, jar),
    };
  }

  if (type === "minecraft-paper") {
    const executable = validateExecutable(payload.executable || "java");
    const args = normalizeShellWrapperArgs(executable, rawArgs);
    const jar = validateRelativeAssetPath(payload.jar || payload.entrypoint || "paper.jar", "JAR");
    const memory = validateMemoryValue(payload.memory || payload.memoryLimit || "");
    const memoryArgs = memory ? [`-Xmx${memory}`] : [];
    return {
      executable,
      args: [...memoryArgs, "-jar", jar, "nogui", ...args],
    };
  }

  throw createInstanceError("INVALID_INSTANCE_TYPE");
}

function assertSafeArguments(args) {
  for (const arg of args) {
    if (arg.includes("\0") || arg.length > 512) {
      throw createInstanceError("INVALID_ARGS");
    }
  }
}

function normalizeInstanceConfig(payload, existingConfig = null) {
  const createdAt = existingConfig?.createdAt || nowIso();
  const id = existingConfig?.id || validateInstanceId(payload.id);
  const type = validateInstanceType(payload.type || existingConfig?.type);
  const command = buildTypeCommand(type, payload);
  const primaryPort = parseStrictPositiveInteger(payload.primaryPort);

  if ((payload.javaRuntime !== undefined || payload.javaRuntimeOverride !== undefined || payload.requiredJavaMajor !== undefined)) {
    throw createInstanceError("JAVA_RUNTIME_SELECTION_AGENT_OWNED", 403);
  }
  if (path.isAbsolute(command.executable) && isMinecraftJavaInstance({ ...payload, type })) {
    throw createInstanceError("JAVA_RUNTIME_PATH_NOT_ALLOWED", 403);
  }

  assertExecutableAllowed(command.executable);
  assertSafeArguments(command.args);

  const config = {
    id,
    displayName: validateDisplayName(payload.displayName || payload.name, id),
    type,
    workingDirectory: path.relative(instancePath(id), resolveRelativeManagedPath(id, payload.workingDirectory, "data")) || ".",
    executable: command.executable,
    args: command.args,
    startupArguments: payload.startupArguments !== undefined ? normalizeStringArray(payload.startupArguments, "ARGS", 128) : null,
    startupScript: payload.startupScript ? validateRelativeAssetPath(payload.startupScript, "ENTRYPOINT") : null,
    environment: normalizeEnvironment(payload.environment || payload.env),
    autoStart: validateBoolean(payload.autoStart, false),
    restartPolicy: validateRestartPolicy(payload.restartPolicy),
    startupTimeoutMs: validatePositiveInteger(payload.startupTimeoutMs, DEFAULT_STARTUP_TIMEOUT_MS, MAX_STARTUP_TIMEOUT_MS, "startupTimeoutMs"),
    shutdownTimeoutMs: validatePositiveInteger(payload.shutdownTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS, MAX_SHUTDOWN_TIMEOUT_MS, "shutdownTimeoutMs"),
    memoryLimit: payload.memoryLimit ? validateMemoryValue(payload.memoryLimit) : null,
    serverJar: normalizeOptionalJarPath(payload.serverJar) || normalizeOptionalJarPath(payload.jar) || null,
    serverJarPath: normalizeOptionalJarPath(payload.serverJarPath) || normalizeOptionalJarPath(payload.serverJar) || normalizeOptionalJarPath(payload.jar) || null,
    startJar: normalizeOptionalJarPath(payload.startJar) || normalizeOptionalJarPath(payload.serverJar) || normalizeOptionalJarPath(payload.jar) || null,
    ports: normalizePorts(payload.ports),
    game: payload.game ? String(payload.game).slice(0, 80) : null,
    version: payload.version ? String(payload.version).slice(0, 80) : null,
    versionName: payload.versionName ? String(payload.versionName).slice(0, 80) : null,
    serverVersion: payload.serverVersion ? String(payload.serverVersion).slice(0, 80) : null,
    serverSoftware: payload.serverSoftware ? String(payload.serverSoftware).slice(0, 80) : null,
    loader: payload.loader ? String(payload.loader).slice(0, 80) : null,
    loaderVersion: payload.loaderVersion ? String(payload.loaderVersion).slice(0, 80) : null,
    minecraftVersion: payload.minecraftVersion ? String(payload.minecraftVersion).slice(0, 80) : null,
    gameVersion: payload.gameVersion ? String(payload.gameVersion).slice(0, 80) : null,
    softwareVersion: payload.softwareVersion ? String(payload.softwareVersion).slice(0, 80) : null,
    displayVersion: payload.displayVersion ? String(payload.displayVersion).slice(0, 120) : null,
    displayVersionDetail: payload.displayVersionDetail ? String(payload.displayVersionDetail).slice(0, 120) : null,
    templateVersion: payload.templateVersion ? String(payload.templateVersion).slice(0, 80) : null,
    templateId: payload.templateId ? String(payload.templateId).slice(0, 80) : null,
    installerType: payload.installerType === "steamcmd-native" ? "steamcmd-native" : null,
    steamAppId: Number.isInteger(Number(payload.steamAppId)) && Number(payload.steamAppId) > 0 ? Number(payload.steamAppId) : null,
    steamInstallDir: payload.steamInstallDir ? String(payload.steamInstallDir).slice(0, 120) : null,
    steamVerifyFiles: Array.isArray(payload.steamVerifyFiles) ? payload.steamVerifyFiles.map((entry) => String(entry)).slice(0, 32) : [],
    buildNumber: payload.buildNumber ? String(payload.buildNumber).slice(0, 80) : null,
    paperBuild: payload.paperBuild ? String(payload.paperBuild).slice(0, 80) : null,
    buildDate: payload.buildDate ? String(payload.buildDate).slice(0, 80) : null,
    detectedVersionAt: payload.detectedVersionAt || null,
    versionCacheVersion: payload.versionCacheVersion || null,
    connectionHost: payload.connectionHost ? String(payload.connectionHost).slice(0, 255) : null,
    primaryPort: Number.isInteger(primaryPort) && primaryPort > 0 && primaryPort <= 65535 ? primaryPort : null,
    tags: normalizeTags(payload.tags),
    installationState: normalizeInstallationState(payload.installationState),
    installationOperationId: payload.installationState === "installing" && INSTALLATION_OPERATION_ID_PATTERN.test(String(payload.installationOperationId || ""))
      ? String(payload.installationOperationId)
      : null,
    createdAt,
    updatedAt: nowIso(),
    lastStartedAt: existingConfig?.lastStartedAt || null,
    lastStoppedAt: existingConfig?.lastStoppedAt || null,
    state: existingConfig?.state || INSTANCE_STATES.STOPPED,
    pid: existingConfig?.pid || null,
    exitCode: existingConfig?.exitCode ?? null,
    signal: existingConfig?.signal || null,
    failureReason: existingConfig?.failureReason || null,
    setupRequired: existingConfig?.setupRequired || null,
    setupReadiness: existingConfig?.setupReadiness || null,
    readinessState: existingConfig?.readinessState || "stopped",
    healthState: existingConfig?.healthState || "unknown",
    javaRuntime: existingConfig?.javaRuntime || null,
  };

  config.versionInfo = normalizeVersionInfo(payload.versionInfo, config);

  if (
    payload.state !== undefined
    || payload.pid !== undefined
    || payload.exitCode !== undefined
    || payload.signal !== undefined
    || payload.setupRequired !== undefined
    || payload.setupReadiness !== undefined
    || payload.readinessState !== undefined
    || payload.healthState !== undefined
  ) {
    throw createInstanceError("RUNTIME_FIELDS_READ_ONLY");
  }

  return config;
}

function isMinecraftJavaInstance(config) {
  const game = String(config.game || config.versionInfo?.game || "").toLowerCase();
  const tags = Array.isArray(config.tags) ? config.tags.map((tag) => String(tag).toLowerCase()) : [];
  return config.type === "java-app" && (game === "minecraft" || tags.includes("minecraft") || Boolean(config.minecraftVersion));
}

function javaRuntimeMetadata(config) {
  return {
    minecraftVersion: config.minecraftVersion || config.gameVersion || config.versionInfo?.gameVersion || config.serverVersion,
    loader: config.loader || config.serverSoftware || config.versionInfo?.software || "vanilla",
    loaderVersion: config.loaderVersion || config.softwareVersion || config.versionInfo?.softwareVersion || null,
    requiredJavaMajor: config.requiredJavaMajor || null,
    javaRuntimeOverride: config.javaRuntime?.userOverride || null,
  };
}

function resolveInstanceJavaRuntime(config) {
  if (!isMinecraftJavaInstance(config)) return config;
  if (isScriptBasedCommand(config)) return config;
  const requirement = javaRuntimeResolver.getRequiredJavaMajor(javaRuntimeMetadata(config));
  if (!requirement) return config;
  const persisted = config.javaRuntime?.executable
    ? javaRuntimeResolver.inspectJavaExecutable(config.javaRuntime.executable)
    : null;
  const runtime = persisted?.major === requirement.major
    ? { ...config.javaRuntime, ...persisted, requiredMajor: requirement.major, source: config.javaRuntime.source || "persisted" }
    : resolveJavaRuntimeProvider(javaRuntimeMetadata(config));
  return {
    ...config,
    executable: runtime.executable,
    javaRuntime: {
      executable: runtime.executable,
      major: runtime.major,
      requiredMajor: requirement.major,
      source: runtime.source,
      resolvedAt: runtime.resolvedAt || nowIso(),
      versionOutput: runtime.versionOutput || null,
    },
  };
}

function publicConfig(config) {
  config = clearInstallerRuntimeJarMetadata(config);
  const { installationOperationId: _installationOperationId, ...safeConfig } = config;
  const crashLoop = config.state === INSTANCE_STATES.FAILED && config.failureReason === "CRASH_LOOP";
  const processRunning = [INSTANCE_STATES.STARTING, INSTANCE_STATES.RUNNING, INSTANCE_STATES.STOPPING, INSTANCE_STATES.RESTARTING].includes(config.state);
  const readinessState = config.state === INSTANCE_STATES.RUNNING ? config.readinessState || "unknown"
    : config.state === INSTANCE_STATES.STARTING ? "starting"
      : config.state === INSTANCE_STATES.STOPPING ? "stopping"
        : config.state === INSTANCE_STATES.FAILED ? "failed"
          : config.state === INSTANCE_STATES.UNKNOWN ? "unknown" : "stopped";
  const healthState = crashLoop ? "crash-loop"
    : config.state === INSTANCE_STATES.FAILED ? "crashed"
      : config.state === INSTANCE_STATES.RUNNING ? (readinessState === "ready" ? "healthy" : "degraded")
        : config.state === INSTANCE_STATES.SETUP_REQUIRED ? "degraded" : "unknown";
  return {
    ...safeConfig,
    processState: config.state,
    readinessState,
    healthState,
    processRunning,
    serverReady: readinessState === "ready",
    healthy: healthState === "healthy",
    degraded: healthState === "degraded",
    lifecycleState: crashLoop ? "Crash Loop" : config.state === INSTANCE_STATES.FAILED && config.failureReason ? "Crashed" : config.state,
    crashed: config.state === INSTANCE_STATES.FAILED && Boolean(config.failureReason),
    crashLoop,
    instancePath: instancePath(config.id),
    environment: Object.keys(config.environment || {}).reduce((redacted, key) => {
      redacted[key] = "[configured]";
      return redacted;
    }, {}),
  };
}

function numericOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function pickString(...values) {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) {
      return text.slice(0, 255);
    }
  }
  return null;
}

function booleanProperty(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(text)) return true;
  if (["false", "0", "no", "off"].includes(text)) return false;
  return null;
}

function integerProperty(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 && number <= 65535 ? number : null;
}

function pickTunnelAddress(config = {}) {
  const playit = config.playit && typeof config.playit === "object" ? config.playit : {};
  const network = config.network && typeof config.network === "object" ? config.network : {};
  const tunnels = Array.isArray(config.tunnels) ? config.tunnels : [];
  const primaryTunnel = tunnels.find(Boolean) || {};
  return pickString(
    config.playitTunnelAddress,
    config.playitAddress,
    config.tunnelAddress,
    config.tunnelDomain,
    playit.tunnelAddress,
    playit.tunnelDomain,
    playit.address,
    network.publicAddress,
    network.tunnelAddress,
    primaryTunnel.tunnelAddress,
    primaryTunnel.tunnelDomain,
    primaryTunnel.address,
    primaryTunnel.url
  );
}

function parseRandomSeedFromLevelDat(buffer) {
  const candidates = [buffer];
  try {
    candidates.push(zlib.gunzipSync(buffer));
  } catch {}

  for (const candidate of candidates) {
    const name = Buffer.from("RandomSeed", "utf8");
    const offset = candidate.indexOf(name);
    if (offset < 3) continue;
    const tagOffset = offset - 3;
    const nameLength = candidate.readUInt16BE(offset - 2);
    const valueOffset = offset + nameLength;
    if (candidate[tagOffset] !== 4 || nameLength !== name.length || valueOffset + 8 > candidate.length) continue;
    return String(candidate.readBigInt64BE(valueOffset));
  }

  return null;
}

function parseTpsFromMessages(messages = []) {
  for (const message of [...messages].reverse()) {
    const text = String(message || "");
    const match = text.match(/\bTPS\b[^:]*:\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?(?:\s*,\s*(\d+(?:\.\d+)?))?/i) ||
      text.match(/\bTPS\b\s*[=:]\s*(\d+(?:\.\d+)?)/i) ||
      text.match(/\b(?:current|server)\s+tps\b[^0-9]*(\d+(?:\.\d+)?)/i);
    if (match) {
      const value = numericOrNull(match[1]);
      if (value !== null) {
        return value;
      }
    }
  }
  return null;
}

async function readRecentLogMessages(instanceId, limit = 250) {
  const entries = (await Promise.all(["stdout", "stderr"].map((streamName) => {
    return readRecentLines(logPath(instanceId, streamName), limit).catch(() => []);
  }))).flat();
  return entries.map((entry) => entry?.message).filter(Boolean);
}

async function queryMinecraftRuntimeStatus(config) {
  for (const port of getMinecraftStatusPorts(config)) {
    const status = await queryMinecraftStatus(port).catch(() => null);
    if (status?.version || status?.players) {
      return { status, port };
    }
  }
  return null;
}

function buildRconPacket(id, type, payload = "") {
  const body = Buffer.concat([
    Buffer.alloc(4),
    Buffer.alloc(4),
    Buffer.from(String(payload), "utf8"),
    Buffer.from([0, 0]),
  ]);
  body.writeInt32LE(id, 0);
  body.writeInt32LE(type, 4);
  const packet = Buffer.alloc(body.length + 4);
  packet.writeInt32LE(body.length, 0);
  body.copy(packet, 4);
  return packet;
}

function parseRconPacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 14) return null;
  const length = buffer.readInt32LE(0);
  if (length + 4 > buffer.length) return null;
  return {
    id: buffer.readInt32LE(4),
    type: buffer.readInt32LE(8),
    payload: buffer.subarray(12, 4 + length - 2).toString("utf8"),
  };
}

async function runRconCommand(port, password, command) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks = [];
    let stage = "login";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(PORT_CONNECT_TIMEOUT_MS);
    socket.on("connect", () => {
      socket.write(buildRconPacket(1, 3, password));
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const packet = parseRconPacket(Buffer.concat(chunks));
      if (!packet) return;
      chunks.length = 0;
      if (stage === "login") {
        if (packet.id !== 1) {
          finish(null);
          return;
        }
        stage = "command";
        socket.write(buildRconPacket(2, 2, command));
        return;
      }
      finish(packet.payload || null);
    });
    socket.on("timeout", () => finish(null));
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

async function queryMinecraftRcon(config, properties = {}) {
  const enabled = booleanProperty(properties["enable-rcon"]);
  const port = integerProperty(properties["rcon.port"]) || integerProperty(config.rconPort);
  const password = pickString(properties["rcon.password"], config.rconPassword);
  if (enabled !== true || !port || !password) {
    return null;
  }
  const [tpsOutput, seedOutput] = await Promise.all([
    runRconCommand(port, password, "tps"),
    runRconCommand(port, password, "seed"),
  ]);
  const seedMatch = String(seedOutput || "").match(/-?\d{4,}/);
  return {
    tps: parseTpsFromMessages([tpsOutput]),
    seed: seedMatch ? seedMatch[0] : null,
  };
}

async function readLevelDatSeed(instanceId, worldName = "world") {
  const safeWorld = String(worldName || "world").replace(/[\\/]/g, "").trim() || "world";
  const candidates = [
    path.join(instancePath(instanceId), "data", safeWorld, "level.dat"),
    path.join(instancePath(instanceId), "data", "world", "level.dat"),
  ];

  for (const filePath of candidates) {
    try {
      const buffer = await fs.readFile(filePath);
      const seed = parseRandomSeedFromLevelDat(buffer);
      if (seed) return seed;
    } catch {}
  }

  return null;
}

async function buildMinecraftSummary(config) {
  if (inferGameFamily(config) !== "minecraft" && !isMinecraftSoftwareName([config.type, config.serverSoftware, config.displayName, config.id].join(" "))) {
    return null;
  }

  const properties = (await readMinecraftProperties(config.id).catch(() => ({ properties: {} }))).properties || {};
  const queryEnabled = booleanProperty(properties["enable-query"]);
  const queryPort = integerProperty(properties["query.port"]) || integerProperty(config.queryPort) || integerProperty(config.primaryPort);
  const rconEnabled = booleanProperty(properties["enable-rcon"]);
  const rconPort = integerProperty(properties["rcon.port"]) || integerProperty(config.rconPort);
  const queryResult = config.state === INSTANCE_STATES.RUNNING ? await queryMinecraftRuntimeStatus({ ...config, queryPort }) : null;
  const rconResult = config.state === INSTANCE_STATES.RUNNING ? await queryMinecraftRcon(config, properties) : null;
  const status = queryResult?.status || null;
  const logMessages = await readRecentLogMessages(config.id).catch(() => []);
  const players = status?.players && typeof status.players === "object" ? status.players : {};
  const maxPlayers = numericOrNull(players.max) ?? numericOrNull(properties["max-players"]) ?? numericOrNull(config.maxPlayers);
  const onlinePlayers = numericOrNull(players.online) ?? numericOrNull(config.onlinePlayers);
  const version = parseMinecraftVersion(status?.version?.name) || config.minecraftVersion || config.gameVersion || config.versionInfo?.gameVersion || null;
  const worldName = pickString(config.worldName, config.world, properties["level-name"], "world");
  const seed = pickString(config.seed, config.worldSeed, properties["level-seed"]) || await readLevelDatSeed(config.id, worldName) || pickString(rconResult?.seed);
  const hasLivePlayers = numericOrNull(players.online) !== null || numericOrNull(players.max) !== null;
  const tps = numericOrNull(config.tps) ?? numericOrNull(config.stats?.tps) ?? numericOrNull(config.runtime?.tps) ?? parseTpsFromMessages(logMessages) ?? numericOrNull(rconResult?.tps);

  return {
    version,
    serverType: config.serverSoftware || inferServerSoftware(config),
    javaVersion: config.executable || null,
    players: {
      online: onlinePlayers,
      max: maxPlayers,
      status: hasLivePlayers ? "reported" : config.state !== INSTANCE_STATES.RUNNING ? "waiting" : queryEnabled === false ? "query-disabled" : "not-reported",
      queryEnabled,
      queryPort,
      statusPort: queryResult?.port || null,
    },
    tps,
    tpsStatus: tps !== null ? "reported" : rconEnabled === false ? "rcon-disabled" : "not-reported",
    worldName,
    seed,
    seedStatus: seed ? "reported" : rconEnabled === false ? "rcon-disabled" : "not-reported",
    query: { enabled: queryEnabled, port: queryPort, status: hasLivePlayers ? "reported" : queryEnabled === false ? "disabled" : "not-reported" },
    rcon: { enabled: rconEnabled, port: rconPort, status: rconEnabled === false ? "disabled" : "not-reported" },
    playitTunnel: pickTunnelAddress(config),
  };
}

async function publicConfigDetailed(config) {
  const output = publicConfig(config);
  const minecraft = await buildMinecraftSummary(config).catch(() => null);
  return minecraft ? { ...output, minecraft } : output;
}

function cleanVersionValue(value) {
  const text = String(value || "").trim();
  if (!text || text === "latest" || text === "Unknown version" || /\blatest\b/i.test(text)) {
    return null;
  }
  return text.slice(0, 80);
}

function extractGenericVersion(value) {
  return String(value || "").match(/\b\d+(?:\.\d+){1,4}\b/)?.[0] || null;
}

function inferGameFamily(config = {}) {
  const searchable = [
    config.game,
    config.templateId,
    config.type,
    config.displayName,
    config.id,
    config.serverSoftware,
    ...(Array.isArray(config.tags) ? config.tags : []),
    ...(Array.isArray(config.args) ? config.args : []),
  ].join(" ").toLowerCase();

  if (isMinecraftSoftwareName(searchable)) return "minecraft";
  if (searchable.includes("terraria") || searchable.includes("tshock")) return "terraria";
  if (searchable.includes("fivem") || searchable.includes("fxserver")) return "fivem";
  if (searchable.includes("valheim")) return "valheim";
  if (searchable.includes("palworld")) return "palworld";
  if (searchable.includes("counter-strike") || searchable.includes("cs2")) return "cs2";
  if (searchable.includes("rust")) return "rust";
  return null;
}

function isMinecraftSoftwareName(value) {
  return /minecraft|paper|purpur|spigot|bukkit|fabric|quilt|forge|neoforge|mohist|magma|arclight|vanilla/i.test(String(value || ""));
}

function inferServerSoftware(config) {
  const searchable = [
    config.serverSoftware,
    config.templateId,
    config.type,
    config.displayName,
    config.id,
    ...(Array.isArray(config.tags) ? config.tags : []),
    ...(Array.isArray(config.args) ? config.args : []),
  ].join(" ").toLowerCase();

  if (searchable.includes("bungeecord")) return "BungeeCord";
  if (searchable.includes("waterfall")) return "Waterfall";
  if (searchable.includes("velocity")) return "Velocity";
  if (searchable.includes("sponge")) return "Sponge";
  if (searchable.includes("folia")) return "Folia";
  if (searchable.includes("neoforge")) return "NeoForge";
  if (searchable.includes("forge")) return "Forge";
  if (searchable.includes("fabric")) return "Fabric";
  if (searchable.includes("quilt")) return "Quilt";
  if (searchable.includes("purpur")) return "Purpur";
  if (searchable.includes("spigot")) return "Spigot";
  if (searchable.includes("bukkit")) return "Bukkit";
  if (searchable.includes("paper")) return "Paper";
  if (searchable.includes("vanilla") || searchable.includes("minecraft")) return "Vanilla";
  return config.serverSoftware || null;
}

function formatVersionDetailLabel(software, softwareVersion, buildNumber, game) {
  const normalizedSoftware = cleanVersionValue(software);
  const normalizedVersion = cleanVersionValue(softwareVersion);
  const normalizedBuild = cleanVersionValue(buildNumber);
  const lowerSoftware = String(normalizedSoftware || "").toLowerCase();
  const lowerGame = String(game || "").toLowerCase();

  if (lowerGame === "minecraft") {
    if ((/paper|purpur/.test(lowerSoftware)) && normalizedBuild) {
      return `${normalizedSoftware} Build ${normalizedBuild}`;
    }
    if ((/folia/.test(lowerSoftware)) && normalizedBuild) {
      return `${normalizedSoftware} Build ${normalizedBuild}`;
    }
    if ((/fabric|quilt/.test(lowerSoftware)) && normalizedVersion) {
      return `${normalizedSoftware} Loader ${normalizedVersion}`;
    }
    if ((/forge|neoforge|mohist|magma|arclight|velocity|waterfall|bungeecord|sponge/.test(lowerSoftware)) && normalizedVersion) {
      return `${normalizedSoftware} ${normalizedVersion}`;
    }
    if (normalizedBuild) {
      return `${normalizedSoftware || "Build"} ${normalizedBuild}`;
    }
    if (normalizedVersion) {
      return `${normalizedSoftware || "Software"} ${normalizedVersion}`;
    }
  }

  if (lowerGame === "terraria") {
    return normalizedVersion && normalizedSoftware ? `${normalizedSoftware} ${normalizedVersion}` : normalizedVersion || normalizedSoftware;
  }

  if (lowerGame === "fivem") {
    if (normalizedBuild) {
      return `${normalizedSoftware || "FXServer"} Artifact ${normalizedBuild}`;
    }
    return normalizedVersion && normalizedSoftware ? `${normalizedSoftware} ${normalizedVersion}` : normalizedVersion || normalizedSoftware;
  }

  if (normalizedVersion && normalizedSoftware) {
    return `${normalizedSoftware} ${normalizedVersion}`;
  }
  return normalizedBuild || normalizedVersion || normalizedSoftware;
}

function normalizeVersionInfo(versionInfo = null, config = {}) {
  const input = versionInfo && typeof versionInfo === "object" ? versionInfo : {};
  const game = cleanVersionValue(
    input.game ||
      input.gameFamily ||
      config.game ||
      inferGameFamily(config)
  );
  const software = cleanVersionValue(
    input.software ||
      input.serverSoftware ||
      config.serverSoftware ||
      inferServerSoftware(config)
  );
  const combinedVersionText = [
    input.displayVersion,
    input.displayVersionDetail,
    input.gameVersion,
    input.softwareVersion,
    config.versionName,
    config.version,
    config.serverVersion,
  ].filter(Boolean).join(" ");
  const minecraftVersion = parseMinecraftVersion(
    input.gameVersion ||
      input.minecraftVersion ||
      config.minecraftVersion ||
      combinedVersionText
  );
  const genericVersion = extractGenericVersion(
    input.gameVersion ||
      input.displayVersion ||
      config.serverVersion ||
      config.versionName ||
      config.version
  );
  const softwareVersion = cleanVersionValue(
    input.softwareVersion ||
      input.loaderVersion ||
      input.serverVersion ||
      (game === "minecraft"
        ? (cleanVersionValue(config.buildNumber || config.paperBuild || config.serverVersion) || null)
        : null)
  );
  const buildNumber = cleanVersionValue(input.buildNumber || input.paperBuild || config.buildNumber || config.paperBuild);
  const rawGameVersion = cleanVersionValue(input.gameVersion || input.minecraftVersion);
  const gameVersion = cleanVersionValue(
    game === "minecraft"
      ? (parseMinecraftVersion(rawGameVersion) || minecraftVersion)
      : (rawGameVersion || genericVersion)
  );
  const minecraftDisplay = game === "minecraft"
    ? (gameVersion || softwareVersion || buildNumber ? [
      software,
      gameVersion,
      buildNumber && /paper|purpur|folia/i.test(String(software || "")) ? `build ${buildNumber}` : null,
      softwareVersion && !String(softwareVersion).includes(String(gameVersion || "")) && !/paper|purpur|folia/i.test(String(software || "")) ? softwareVersion : null,
    ].filter(Boolean).join(" ") : null)
    : null;
  const inputDisplayVersion = cleanVersionValue(input.displayVersion);
  const usableInputDisplayVersion = game === "minecraft" && inputDisplayVersion && !parseMinecraftVersion(inputDisplayVersion)
    ? null
    : inputDisplayVersion;
  const displayVersion = cleanVersionValue(
    usableInputDisplayVersion ||
      (game === "minecraft"
        ? (minecraftDisplay || gameVersion || softwareVersion || buildNumber)
        : game === "fivem"
          ? (buildNumber ? `Artifact ${buildNumber}` : softwareVersion || genericVersion)
          : gameVersion || softwareVersion || buildNumber || config.version)
  );
  const displayVersionDetail = cleanVersionValue(
    input.displayVersionDetail ||
      formatVersionDetailLabel(software, softwareVersion, buildNumber, game)
  );

  if (!game && !software && !gameVersion && !softwareVersion && !displayVersion && !displayVersionDetail && !buildNumber) {
    return null;
  }

  return {
    game: game || null,
    software: software || null,
    gameVersion: gameVersion || null,
    softwareVersion: softwareVersion || null,
    buildNumber: buildNumber || null,
    buildDate: cleanVersionValue(input.buildDate || config.buildDate),
    displayVersion: displayVersion || null,
    displayVersionDetail: displayVersionDetail || null,
    isMinecraft: game === "minecraft",
  };
}

function isFiveMInstance(config) {
  const searchable = [
    config.templateId,
    config.type,
    config.displayName,
    config.id,
    config.serverSoftware,
    ...(Array.isArray(config.tags) ? config.tags : []),
    ...(Array.isArray(config.args) ? config.args : []),
  ].join(" ").toLowerCase();
  return searchable.includes("fivem") || searchable.includes("fxserver");
}

function getFiveMConfigPath(instanceId) {
  return path.join(instancePath(instanceId), "data", FIVEM_CONFIG_RELATIVE_PATH);
}

function getDefaultFiveMServerConfig(config = {}) {
  const port = Array.isArray(config.ports) && config.ports[0] ? config.ports[0] : config.primaryPort || 30120;
  const name = String(config.displayName || config.id || "AnxOS FiveM Server").replace(/"/g, "'");
  return [
    `endpoint_add_tcp "0.0.0.0:${port}"`,
    `endpoint_add_udp "0.0.0.0:${port}"`,
    `sv_hostname "${name}"`,
    `sets sv_projectName "${name}"`,
    'sets sv_projectDesc "Managed by AnxOS"',
    "sv_maxclients 32",
    'sv_licenseKey "CHANGE_ME_FIVEM_LICENSE_KEY"',
    "",
  ].join("\n");
}

function parseFiveMLicenseEntries(configText) {
  return String(configText || "").split(/\r?\n/).map((line, index) => {
    const active = !/^\s*[#;]/.test(line);
    const match = line.match(/^\s*(?:set\s+)?sv_licenseKey\s+(.+?)\s*$/i);
    if (!active || !match) {
      return null;
    }
    const rawValue = String(match[1] || "").trim().replace(/^["']|["']$/g, "");
    const value = rawValue.split(/\s+#|\s+;/)[0].trim().replace(/^["']|["']$/g, "");
    return { line, index, value };
  }).filter(Boolean);
}

function extractFiveMLicenseKey(configText) {
  return parseFiveMLicenseEntries(configText)[0]?.value || "";
}

function isValidFiveMLicenseKey(value) {
  const key = String(value || "").trim();
  return Boolean(key) && !FIVEM_LICENSE_PLACEHOLDERS.has(key.toUpperCase()) && !/[{}<>$]/.test(key) && /^[A-Za-z0-9_-]{8,}$/.test(key);
}

function buildFiveMReadiness(reasonCode, config = {}, extra = {}) {
  const ready = reasonCode === "READY";
  const messages = {
    READY: "FiveM setup is complete.",
    NOT_FIVEM: "This instance does not use FiveM setup.",
    CONFIG_MISSING: "FiveM server.cfg is missing.",
    LICENSE_MISSING: "FiveM setup requires a license key before startup.",
    LICENSE_PLACEHOLDER: "FiveM setup requires replacing the placeholder license key.",
    LICENSE_INVALID: "FiveM setup requires a valid Cfx.re license key.",
  };
  return {
    ready,
    setupRequired: !ready && reasonCode !== "NOT_FIVEM",
    reasonCode,
    message: messages[reasonCode] || messages.LICENSE_MISSING,
    requiredField: ready || reasonCode === "NOT_FIVEM" ? null : "sv_licenseKey",
    configPath: FIVEM_CONFIG_RELATIVE_PATH,
    suggestedAction: ready || reasonCode === "NOT_FIVEM"
      ? null
      : "Open Configure FiveM and paste a license key from the official Cfx.re Keymaster service.",
    hasConfiguredLicenseKey: ready,
    checkedAt: nowIso(),
    templateId: config.templateId || null,
    ...extra,
  };
}

function getFiveMLicenseReason(configText) {
  const entries = parseFiveMLicenseEntries(configText);
  if (entries.length === 0) {
    return "LICENSE_MISSING";
  }
  const key = entries[0].value;
  if (!key) {
    return "LICENSE_MISSING";
  }
  if (FIVEM_LICENSE_PLACEHOLDERS.has(key.toUpperCase())) {
    return "LICENSE_PLACEHOLDER";
  }
  return isValidFiveMLicenseKey(key) ? "READY" : "LICENSE_INVALID";
}

async function readFiveMConfigText(config) {
  return readTextIfExists(getFiveMConfigPath(config.id), 128 * 1024);
}

async function evaluateFiveMReadiness(config) {
  if (!isFiveMInstance(config)) {
    return buildFiveMReadiness("NOT_FIVEM", config);
  }
  const configPath = getFiveMConfigPath(config.id);
  const exists = await pathExists(configPath);
  if (!exists) {
    return buildFiveMReadiness("CONFIG_MISSING", config);
  }
  const configText = await readFiveMConfigText(config);
  return buildFiveMReadiness(getFiveMLicenseReason(configText), config);
}

async function persistFiveMReadiness(config, readiness) {
  if (!isFiveMInstance(config) || readiness.reasonCode === "NOT_FIVEM") {
    return config;
  }
  const hasActiveRuntimeState = [
    INSTANCE_STATES.RUNNING,
    INSTANCE_STATES.STARTING,
    INSTANCE_STATES.STOPPING,
    INSTANCE_STATES.RESTARTING,
  ].includes(config.state);
  const patch = readiness.ready
    ? {
      setupRequired: null,
      setupReadiness: readiness,
      failureReason: config.failureReason === "FIVEM_LICENSE_REQUIRED" || config.failureReason === "FIVEM_SETUP_REQUIRED" ? null : config.failureReason,
      state: config.state === INSTANCE_STATES.SETUP_REQUIRED ? INSTANCE_STATES.STOPPED : config.state,
    }
    : {
      setupRequired: {
        code: "FIVEM_LICENSE_REQUIRED",
        reasonCode: readiness.reasonCode,
        message: readiness.message,
        requiredField: readiness.requiredField,
        configPath: readiness.configPath,
        suggestedAction: readiness.suggestedAction,
        checkedAt: readiness.checkedAt,
      },
      setupReadiness: readiness,
      failureReason: null,
      state: hasActiveRuntimeState ? config.state : INSTANCE_STATES.SETUP_REQUIRED,
      pid: hasActiveRuntimeState ? config.pid : null,
      lastStoppedAt: hasActiveRuntimeState ? config.lastStoppedAt : nowIso(),
    };
  return updateRuntimeState(config.id, patch);
}

async function refreshFiveMReadiness(instanceId) {
  const config = await loadInstanceConfig(instanceId);
  const readiness = await evaluateFiveMReadiness(config);
  const updated = await persistFiveMReadiness(config, readiness);
  return {
    config: updated,
    instance: publicConfig(updated),
    readiness,
  };
}

async function assertFiveMCanStart(config) {
  if (!isFiveMInstance(config)) {
    return;
  }

  const { readiness } = await refreshFiveMReadiness(config.id);
  if (!readiness.ready) {
    const error = createInstanceError("FIVEM_SETUP_REQUIRED", 409, {
      readiness,
      setupRequired: true,
    });
    error.message = "FiveM setup is required before this server can start.";
    throw error;
  }
}

function normalizeFiveMLicenseInput(value) {
  const key = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!isValidFiveMLicenseKey(key)) {
    const error = createInstanceError("INVALID_FIVEM_LICENSE_KEY", 400, {
      field: "sv_licenseKey",
      expected: "a non-placeholder Cfx.re license key containing letters, numbers, underscores, or dashes",
      received: key ? "[provided]" : "",
      suggestion: "Generate a key through the official Cfx.re Keymaster service, then paste it here.",
    });
    error.message = "Enter a valid FiveM license key.";
    throw error;
  }
  return key;
}

function updateFiveMLicenseInConfig(configText, licenseKey) {
  const lines = String(configText || "").replace(/\r\n/g, "\n").split("\n");
  let replaced = false;
  const nextLines = lines.map((line) => {
    if (/^\s*[#;]/.test(line) || !/^\s*(?:set\s+)?sv_licenseKey\b/i.test(line)) {
      return line;
    }
    if (!replaced) {
      replaced = true;
      return `sv_licenseKey "${licenseKey}"`;
    }
    return `# ${line.replace(/sv_licenseKey\s+.+$/i, 'sv_licenseKey "[redacted duplicate removed]"')}`;
  });
  if (!replaced) {
    if (nextLines.length > 0 && nextLines[nextLines.length - 1].trim()) {
      nextLines.push("");
    }
    nextLines.push(`sv_licenseKey "${licenseKey}"`);
  }
  return `${nextLines.join("\n").replace(/\n*$/, "")}\n`;
}

async function saveFiveMLicenseKey(instanceId, licenseKey) {
  const config = await loadInstanceConfig(instanceId);
  if (!isFiveMInstance(config)) {
    throw createInstanceError("NOT_FIVEM_INSTANCE", 400);
  }
  const key = normalizeFiveMLicenseInput(licenseKey);
  const filePath = getFiveMConfigPath(config.id);
  let configText = await readTextIfExists(filePath, 128 * 1024);
  if (!configText) {
    configText = getDefaultFiveMServerConfig(config);
  }
  const nextText = updateFiveMLicenseInConfig(configText, key);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, nextText, "utf8");
  const result = await refreshFiveMReadiness(config.id);
  return {
    success: true,
    instance: result.instance,
    readiness: result.readiness,
    configPath: FIVEM_CONFIG_RELATIVE_PATH,
    licenseKeySaved: true,
    maskedLicenseKey: "********",
  };
}

function parseMinecraftVersion(value) {
  return String(value || "").match(/\b(?:1\.\d+(?:\.\d+)?|\d{2,}\.\d+(?:\.\d+)?)\b/)?.[0] || null;
}

function findMinecraftVersionInObject(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number") {
    return parseMinecraftVersion(value);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const detected = findMinecraftVersionInObject(item, depth + 1);
      if (detected) return detected;
    }
    return null;
  }
  if (typeof value !== "object") {
    return null;
  }

  const preferredKeys = [
    "minecraftVersion",
    "gameVersion",
    "serverVersion",
    "version",
    "versionName",
    "displayVersion",
    "id",
    "minecraft",
    "minecraftArguments",
  ];
  for (const key of preferredKeys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const detected = findMinecraftVersionInObject(value[key], depth + 1);
      if (detected) return detected;
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (!/(version|minecraft|manifest|installer|marketplace|metadata|server)/i.test(key)) {
      continue;
    }
    const detected = findMinecraftVersionInObject(child, depth + 1);
    if (detected) return detected;
  }
  return null;
}

function inferNeoForgeMinecraftVersion(value) {
  const literal = parseMinecraftVersion(value);
  if (literal) {
    return literal;
  }
  const modern = String(value || "").match(/^(\d{2})\.(\d+)\./);
  return modern ? `1.${Number.parseInt(modern[1], 10)}.${Number.parseInt(modern[2], 10)}` : null;
}

function parseBuildNumber(value) {
  return String(value || "").match(/(?:build|b)[-_. ]?(\d{1,8})\b/i)?.[1] || null;
}

function parseSoftwareVersion(value) {
  return String(value || "").match(/\b\d+(?:\.\d+){1,4}(?:[-+][A-Za-z0-9_.-]+)?\b/)?.[0] || null;
}

function parsePaperBuildNumber(value) {
  const text = String(value || "");
  return text.match(/\bpaper[-_\s]?(?:mc[-_\s]?)?(?:version\s*)?1\.\d+(?:\.\d+)?[-_\s+#]*(\d{1,8})\b/i)?.[1] ||
    text.match(/\bpaper\b[^\n\r]*(?:build|#)\s*(\d{1,8})\b/i)?.[1] ||
    parseBuildNumber(text);
}

function inferServerSoftwareFromText(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("bungeecord")) return "BungeeCord";
  if (text.includes("waterfall")) return "Waterfall";
  if (text.includes("velocity")) return "Velocity";
  if (text.includes("sponge")) return "Sponge";
  if (text.includes("folia")) return "Folia";
  if (text.includes("neoforge")) return "NeoForge";
  if (text.includes("forge")) return "Forge";
  if (text.includes("fabric")) return "Fabric";
  if (text.includes("quilt")) return "Quilt";
  if (text.includes("purpur")) return "Purpur";
  if (text.includes("spigot")) return "Spigot";
  if (text.includes("bukkit")) return "Bukkit";
  if (text.includes("paper")) return "Paper";
  if (text.includes("minecraft")) return "Vanilla";
  return null;
}

function encodeVarInt(value) {
  const bytes = [];
  let remaining = Number(value) >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

function decodeVarInt(buffer, offset = 0) {
  let value = 0;
  let position = 0;
  let currentOffset = offset;
  while (currentOffset < buffer.length) {
    const current = buffer[currentOffset];
    value |= (current & 0x7f) << (7 * position);
    currentOffset += 1;
    if ((current & 0x80) !== 0x80) {
      return { value, offset: currentOffset };
    }
    position += 1;
    if (position > 5) {
      break;
    }
  }
  return null;
}

function buildMinecraftStatusRequest(port) {
  const host = Buffer.from("127.0.0.1", "utf8");
  const handshakePayload = Buffer.concat([
    encodeVarInt(0),
    encodeVarInt(764),
    encodeVarInt(host.length),
    host,
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    encodeVarInt(1),
  ]);
  const handshake = Buffer.concat([encodeVarInt(handshakePayload.length), handshakePayload]);
  const requestPayload = encodeVarInt(0);
  return Buffer.concat([handshake, encodeVarInt(requestPayload.length), requestPayload]);
}

function parseMinecraftStatusResponse(buffer) {
  const packetLength = decodeVarInt(buffer, 0);
  if (!packetLength) {
    return null;
  }
  const packetId = decodeVarInt(buffer, packetLength.offset);
  if (!packetId) {
    return null;
  }
  const jsonLength = decodeVarInt(buffer, packetId.offset);
  if (!jsonLength) {
    return null;
  }
  const jsonStart = jsonLength.offset;
  const jsonEnd = jsonStart + jsonLength.value;
  if (jsonEnd > buffer.length) {
    return null;
  }
  return JSON.parse(buffer.subarray(jsonStart, jsonEnd).toString("utf8"));
}

async function readTextIfExists(filePath, maxBytes = 512 * 1024) {
  try {
    const stats = await fs.stat(filePath);
    if (!stats.isFile() || stats.size > maxBytes) {
      return "";
    }
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function listDirectoryNames(directory) {
  try {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() || entry.isFile()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function unzipText(filePath, entryName) {
  if (!filePath || !(await pathExists(filePath))) {
    return "";
  }
  const result = await execFile("unzip", ["-p", filePath, entryName], { timeout: 2500 });
  return result.ok ? result.stdout : "";
}

function getJarCandidates(config) {
  const candidates = [];
  candidates.push(config.serverJar, config.serverJarPath, config.startJar, config.jar, config.entrypoint);
  const args = Array.isArray(config.args) ? config.args : [];
  const jarIndex = args.findIndex((arg) => arg === "-jar");
  if (jarIndex >= 0 && args[jarIndex + 1]) {
    candidates.push(args[jarIndex + 1]);
  }
  for (const arg of args) {
    if (/\.jar$/i.test(String(arg || ""))) {
      candidates.push(arg);
    }
  }
  candidates.push(
    "server.jar",
    "paper.jar",
    "purpur.jar",
    "folia.jar",
    "fabric-server.jar",
    "velocity.jar",
    "waterfall.jar",
    "bungeecord.jar",
    "sponge.jar"
  );
  return [...new Set(candidates.map((candidate) => String(candidate || "").trim()).filter(Boolean))];
}

function isServerInstallerJarName(value = "") {
  return /(?:^|[/\\])(?:forge|neoforge|quilt)(?:-[^/\\]+)?-installer\.jar$/i.test(String(value || ""));
}

function replaceJarArg(args = [], jarPath = "server.jar") {
  return normalizeJavaJarCommandArgs(args, jarPath);
}

function executableName(executable) {
  return path.basename(String(executable || "").trim()).toLowerCase();
}

function isScriptExecutable(executable) {
  return ["bash", "sh", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executableName(executable));
}

function isStartupScript(value) {
  return /^(?:\.\/)?(?:run|start|startserver)\.(?:sh|bat|cmd|ps1)$/i.test(path.basename(String(value || "").trim()));
}

function normalizeScriptLauncherPath(scriptPath) {
  const normalized = String(scriptPath || "").trim().replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("./") || normalized.startsWith("../") || path.isAbsolute(normalized)) {
    return normalized;
  }
  return normalized.includes("/") ? normalized : `./${normalized}`;
}

function getStartupScriptLauncher(scriptPath) {
  const script = normalizeScriptLauncherPath(scriptPath);
  const name = path.basename(script).toLowerCase();
  if (name.endsWith(".sh")) return { executable: "bash", args: [script] };
  if (name.endsWith(".bat") || name.endsWith(".cmd")) return { executable: "cmd.exe", args: ["/c", script] };
  if (name.endsWith(".ps1")) return { executable: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script] };
  return null;
}

function getConfiguredStartupScriptArg(config = {}) {
  const args = Array.isArray(config.args) ? config.args : [];
  const index = args.findIndex((arg) => isStartupScript(arg));
  return index >= 0 ? { index, path: args[index] } : null;
}

function buildStartupScriptCommand(executable, args = []) {
  const scriptIndex = args.findIndex((arg) => isStartupScript(arg));
  const scriptPath = scriptIndex >= 0 ? validateRelativeAssetPath(args[scriptIndex], "ENTRYPOINT").replace(/\\/g, "/") : null;
  const launcher = scriptPath ? getStartupScriptLauncher(scriptPath) : null;
  if (!launcher) {
    return null;
  }
  if (!isScriptExecutable(executable) && !/^java(?:\.exe)?$/i.test(executableName(executable))) {
    return null;
  }
  return {
    executable: launcher.executable,
    args: [...launcher.args, ...args.slice(scriptIndex + 1)],
  };
}

async function findStartupScript(config) {
  const workingDirectory = config.workingDirectory || "data";
  const root = resolveRelativeManagedPath(config.id, workingDirectory, "data");
  const args = Array.isArray(config.args) ? config.args : [];
  const configured = [
    config.startupScript,
    config.entrypoint,
    ...args.filter(isStartupScript),
  ].map((candidate) => String(candidate || "").replace(/^\.([/\\])/, "").trim()).filter(Boolean);
  const preferred = process.platform === "win32"
    ? ["startserver.bat", "run.bat", "start.bat", "startserver.cmd", "run.cmd", "start.cmd", "run.ps1", "start.ps1", "startserver.sh", "run.sh", "start.sh"]
    : ["run.sh", "startserver.sh", "start.sh", "startserver.bat", "run.bat", "start.bat", "startserver.cmd", "run.cmd", "start.cmd", "run.ps1", "start.ps1"];
  for (const candidate of [...configured, ...preferred]) {
    try {
      const relative = validateRelativeAssetPath(candidate, "ENTRYPOINT");
      const target = path.resolve(root, relative);
      if (isInsideRoot(target, root) && await pathExists(target)) {
        return relative.replace(/\\/g, "/");
      }
    } catch {}
  }
  return null;
}

async function findExistingStartupScript(config, candidates = []) {
  const workingDirectory = config.workingDirectory || "data";
  const root = resolveRelativeManagedPath(config.id, workingDirectory, "data");
  for (const candidate of candidates) {
    try {
      const relative = validateRelativeAssetPath(candidate, "ENTRYPOINT");
      const target = path.resolve(root, relative);
      if (isInsideRoot(target, root) && await pathExists(target)) {
        return relative.replace(/\\/g, "/");
      }
    } catch {}
  }
  return null;
}

async function configuredJarExists(config = {}) {
  const workingDirectory = config.workingDirectory || "data";
  const dataRoot = resolveRelativeManagedPath(config.id, workingDirectory, "data");
  const candidates = [
    config.serverJar,
    config.serverJarPath,
    config.startJar,
    config.jar,
  ];
  const args = Array.isArray(config.args) ? config.args : [];
  const jarIndex = args.findIndex((arg) => arg === "-jar");
  if (jarIndex >= 0 && args[jarIndex + 1]) {
    candidates.push(args[jarIndex + 1]);
  }
  for (const candidate of [...new Set(candidates.map((entry) => String(entry || "").trim()).filter(Boolean))]) {
    try {
      const relative = validateRelativeAssetPath(candidate, "JAR");
      const absolute = path.resolve(dataRoot, relative);
      if (isInsideRoot(absolute, dataRoot) && await pathExists(absolute)) {
        return true;
      }
    } catch {}
  }
  return false;
}

function hasStartupScriptArgs(config = {}) {
  return (Array.isArray(config.args) ? config.args : []).some(isStartupScript);
}

function isScriptBasedCommand(config = {}) {
  return isScriptExecutable(config.executable) || hasStartupScriptArgs(config);
}

function usesJavaJarCommand(config = {}) {
  const args = Array.isArray(config.args) ? config.args : [];
  const executable = executableName(config.executable);
  if (isScriptBasedCommand(config)) {
    return false;
  }
  return executable === "java" || executable === "java.exe" || args.includes("-jar");
}

function isInvalidCommandExit(config = {}, exitCode, failureReason = "") {
  return Number(exitCode) === 2 ||
    /INVALID_COMMAND|invalid command|invalid option|usage/i.test(String(failureReason || "")) ||
    (isScriptBasedCommand(config) && Number(exitCode) === 127);
}

function resetRestartBackoff(instanceId) {
  const timer = restartTimers.get(instanceId);
  if (timer) clearTimeout(timer);
  restartTimers.delete(instanceId);
  restartBackoffStates.delete(instanceId);
}

function scheduleAutomaticRestart(instanceId, delayMs, callback = () => startInstance(instanceId, { automaticRestart: true })) {
  const existing = restartTimers.get(instanceId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    restartTimers.delete(instanceId);
    Promise.resolve(callback()).catch(() => {});
  }, delayMs);
  timer.unref?.();
  restartTimers.set(instanceId, timer);
  return timer;
}

function disposeInstanceService() {
  for (const instanceId of installationSessions.keys()) terminateInstallationSession(instanceId);
  for (const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();
  for (const timer of versionRefreshTimers.values()) clearTimeout(timer);
  versionRefreshTimers.clear();
  restartBackoffStates.clear();
}

async function shutdownInstanceService(options = {}) {
  disposeInstanceService();
  const timeoutMs = validatePositiveInteger(options.timeoutMs, 5000, 30000, "shutdownTimeoutMs");
  const instanceIds = [...runningProcesses.keys()];
  const results = await Promise.allSettled(instanceIds.map((instanceId) => stopInstance(instanceId, { timeoutMs })));

  for (const [index, result] of results.entries()) {
    if (result.status === "fulfilled") continue;
    const entry = runningProcesses.get(instanceIds[index]);
    const pid = entry?.child?.pid;
    if (entry) entry.requestedStop = true;
    if (pid && isProcessAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }

  runningProcesses.clear();
  metricsSamples.clear();
  return {
    stopped: results.filter((result) => result.status === "fulfilled").length,
    forced: results.filter((result) => result.status === "rejected").length,
    failures: results.flatMap((result, index) => result.status === "rejected"
      ? [{ instanceId: instanceIds[index], code: result.reason?.code || "INSTANCE_SHUTDOWN_FAILED" }]
      : []),
  };
}

function getRestartBackoffDecision(instanceId, options = {}) {
  const immediateExit = Boolean(options.immediateExit);

  if (!immediateExit) {
    restartBackoffStates.delete(instanceId);
    return {
      allowed: true,
      delayMs: RESTART_BACKOFF_BASE_MS,
      failures: 0,
    };
  }

  const previous = restartBackoffStates.get(instanceId) || { failures: 0 };
  const failures = previous.failures + 1;
  const delayMs = Math.min(RESTART_BACKOFF_BASE_MS * (2 ** Math.max(0, failures - 1)), RESTART_BACKOFF_MAX_MS);
  const allowed = failures <= RESTART_BACKOFF_MAX_IMMEDIATE_FAILURES;

  restartBackoffStates.set(instanceId, {
    failures,
    lastFailureAt: nowIso(),
    delayMs,
  });

  return {
    allowed,
    delayMs,
    failures,
  };
}

async function findJarPaths(config) {
  const workingDirectory = config.workingDirectory || "data";
  const roots = [
    resolveRelativeManagedPath(config.id, workingDirectory, "data"),
    path.join(instancePath(config.id), "data"),
  ];
  const paths = [];
  for (const root of roots) {
    for (const candidate of getJarCandidates(config)) {
      try {
        const resolved = path.resolve(root, candidate);
        if (isInsideRoot(resolved, instancePath(config.id)) && await pathExists(resolved)) {
          paths.push(resolved);
        }
      } catch {}
    }
    const names = await listDirectoryNames(root);
    for (const name of names.filter((entry) => /\.jar$/i.test(entry) && !isServerInstallerJarName(entry))) {
      paths.push(path.join(root, name));
    }
  }
  return [...new Set(paths)];
}

async function repairConfiguredServerJar(config) {
  if (!usesJavaJarCommand(config)) {
    return config;
  }

  const workingDirectory = config.workingDirectory || "data";
  const dataRoot = resolveRelativeManagedPath(config.id, workingDirectory, "data");
  const jars = await findJarPaths(config);
  const jarPath = jars[0] || null;
  if (!jarPath) {
    if (await hasNeoForgeRuntimeSignal(config)) {
      const error = createInstanceError("NEOFORGE_RUNTIME_INCOMPLETE", 400, {
        missing: ["run.sh or startserver.sh", "libraries/.../unix_args.txt"],
        suggestion: "Retry server bootstrap or reinstall this instance.",
      });
      error.message = neoforgeRuntimeIncompleteMessage();
      throw error;
    }
    const error = createInstanceError("SERVER_JAR_MISSING", 400);
    error.message = "No server JAR is configured for this instance. Upload a server JAR to the data folder or install this server from the Marketplace.";
    throw error;
  }

  const relativeJar = path.relative(dataRoot, jarPath).replace(/\\/g, "/");
  const configuredJar = String(config.serverJar || config.serverJarPath || config.startJar || "").trim();
  const jarIndex = Array.isArray(config.args) ? config.args.findIndex((arg) => arg === "-jar") : -1;
  const argJar = jarIndex >= 0 ? String(config.args[jarIndex + 1] || "").trim() : "";
  const repairedArgs = replaceJarArg(config.args, relativeJar);
  if (configuredJar === relativeJar && argJar === relativeJar && JSON.stringify(config.args || []) === JSON.stringify(repairedArgs)) {
    return config;
  }

  const repaired = {
    ...config,
    args: repairedArgs,
    serverJar: relativeJar,
    serverJarPath: relativeJar,
    startJar: relativeJar,
    updatedAt: nowIso(),
  };
  await saveInstanceConfig(repaired);
  await appendLog(config.id, "stdout", `Repaired server JAR command: ${formatCommandForLog(repaired)}`).catch(() => {});
  return repaired;
}

async function repairScriptLauncherCommand(config) {
  const executable = executableName(config.executable);
  const args = Array.isArray(config.args) ? config.args : [];
  const configuredScript = getConfiguredStartupScriptArg(config);
  const configuredScriptName = path.basename(String(configuredScript?.path || config.startupScript || "")).toLowerCase();
  const javaTryingToRunScript = (executable === "java" || executable === "java.exe") && args.some(isStartupScript);
  const javaTryingToRunInstallerJar = (executable === "java" || executable === "java.exe") &&
    args.some((arg) => /(?:^|[/\\])(?:forge|neoforge)(?:-[^/\\]+)?-installer\.jar$/i.test(String(arg || "")));
  const generatedRunScript = await findExistingStartupScript(config, process.platform === "win32" ? ["run.bat", "run.cmd", "run.ps1", "run.sh"] : ["run.sh", "run.bat", "run.cmd", "run.ps1"]);
  const startserverUsingGeneratedRun = generatedRunScript && /^startserver\.(?:sh|bat|cmd|ps1)$/i.test(configuredScriptName);
  const script = generatedRunScript || await findStartupScript(config);
  const javaTryingToRunMissingJarWithScript = (executable === "java" || executable === "java.exe") &&
    args.includes("-jar") &&
    Boolean(script) &&
    !await configuredJarExists(config) &&
    await hasNeoForgeRuntimeSignal(config, script);
  if (!javaTryingToRunScript && !javaTryingToRunInstallerJar && !startserverUsingGeneratedRun && !javaTryingToRunMissingJarWithScript) {
    return config;
  }

  if (!script) {
    const error = createInstanceError("STARTUP_SCRIPT_MISSING", 400, {
      executable: config.executable,
      args,
      expected: process.platform === "win32"
        ? ["startserver.bat", "run.bat", "start.bat", "startserver.cmd", "run.cmd", "start.cmd", "run.ps1", "start.ps1", "startserver.sh", "run.sh", "start.sh"]
        : ["startserver.sh", "run.sh", "start.sh", "startserver.bat", "run.bat", "start.bat", "startserver.cmd", "run.cmd", "start.cmd", "run.ps1", "start.ps1"],
    });
    error.message = "No valid server launch script was found for this modpack instance.";
    throw error;
  }

  const launcher = getStartupScriptLauncher(script);
  if (!launcher) {
    throw createInstanceError("STARTUP_SCRIPT_UNSUPPORTED", 400, { script });
  }
  const scriptIndex = configuredScript?.index ?? -1;
  const extraArgs = scriptIndex >= 0 && !javaTryingToRunInstallerJar ? args.slice(scriptIndex + 1) : [];
  const repaired = {
    ...config,
    type: config.type === "java-app" && javaTryingToRunMissingJarWithScript ? "custom-command" : config.type,
    executable: launcher.executable,
    args: [...launcher.args, ...extraArgs],
    startupScript: script,
    serverSoftware: config.serverSoftware || (javaTryingToRunMissingJarWithScript ? "NeoForge" : null),
    loader: config.loader || (javaTryingToRunMissingJarWithScript ? "neoforge" : null),
    serverJar: javaTryingToRunInstallerJar || javaTryingToRunMissingJarWithScript ? null : config.serverJar,
    serverJarPath: javaTryingToRunInstallerJar || javaTryingToRunMissingJarWithScript ? null : config.serverJarPath,
    startJar: javaTryingToRunInstallerJar || javaTryingToRunMissingJarWithScript ? null : config.startJar,
    updatedAt: nowIso(),
  };
  await saveInstanceConfig(repaired);
  await appendLog(config.id, "stdout", `Repaired startup script command: ${formatCommandForLog(repaired)}`).catch(() => {});
  return repaired;
}

function isNeoForgeInstance(config = {}) {
  return /neoforge/i.test([
    config.loader,
    config.serverSoftware,
    config.softwareVersion,
    config.loaderVersion,
    config.templateId,
    config.displayName,
    config.startupScript,
    ...(Array.isArray(config.tags) ? config.tags : []),
    ...(Array.isArray(config.args) ? config.args : []),
  ].filter(Boolean).join(" "));
}

async function hasNeoForgeRuntimeSignal(config = {}, scriptPath = "") {
  if (isNeoForgeInstance(config)) {
    return true;
  }
  const workingDirectory = config.workingDirectory || "data";
  const dataRoot = resolveRelativeManagedPath(config.id, workingDirectory, "data");
  const scripts = [
    scriptPath,
    "run.sh",
    "startserver.sh",
  ].map((entry) => String(entry || "").replace(/^\.\//, "").trim()).filter(Boolean);
  for (const script of [...new Set(scripts)]) {
    try {
      const relative = validateRelativeAssetPath(script, "ENTRYPOINT");
      const text = await readTextIfExists(path.join(dataRoot, relative), 256 * 1024);
      if (/neoforge/i.test(text) || extractNeoForgeUnixArgsReferences(text).length > 0) {
        return true;
      }
    } catch {}
  }
  const rootNames = await listDirectoryNames(dataRoot);
  if (rootNames.some((name) => /^neoforge-.*installer\.jar$/i.test(name))) {
    return true;
  }
  const neoForgeVersions = await listDirectoryNames(path.join(dataRoot, "libraries", "net", "neoforged", "neoforge"));
  return neoForgeVersions.length > 0;
}

function extractNeoForgeUnixArgsReferences(scriptText = "") {
  const refs = [];
  const pattern = /(?:^|[@'"=\s])((?:\.\/)?libraries\/net\/neoforged\/neoforge\/([^\/\s'"`]+)\/unix_args\.txt)\b/gi;
  let match;
  while ((match = pattern.exec(String(scriptText || "")))) {
    refs.push({
      relativePath: match[1].replace(/^\.\//, ""),
      version: match[2],
    });
  }
  return refs;
}

async function getExistingNeoForgeUnixArgs(dataRoot) {
  const root = path.join(dataRoot, "libraries", "net", "neoforged", "neoforge");
  const versions = await listDirectoryNames(root);
  const existing = [];
  for (const version of versions) {
    const relativePath = path.join("libraries", "net", "neoforged", "neoforge", version, "unix_args.txt").replace(/\\/g, "/");
    if (await pathExists(path.join(dataRoot, relativePath))) {
      existing.push({ version, relativePath });
    }
  }
  return existing;
}

function neoforgeRuntimeIncompleteMessage(details = {}) {
  if (details.mismatch) {
    return `NeoForge runtime files are incomplete or mismatched. The startup script expects ${details.expectedVersion || "a different NeoForge version"} but generated runtime files are ${details.availableVersions?.join(", ") || "missing"}. Retry server bootstrap or reinstall this instance.`;
  }
  return "NeoForge runtime files are incomplete. Retry server bootstrap or reinstall this instance.";
}

async function validateNeoForgeRuntimeFiles(config) {
  if (process.platform === "win32" || !isNeoForgeInstance(config) || !isScriptBasedCommand(config)) {
    return null;
  }
  const scriptArg = getConfiguredStartupScriptArg(config);
  const scriptPath = scriptArg?.path || config.startupScript;
  if (!scriptPath || !/\.sh$/i.test(String(scriptPath))) {
    return null;
  }
  const workingDirectory = config.workingDirectory || "data";
  const dataRoot = resolveRelativeManagedPath(config.id, workingDirectory, "data");
  const scriptRelative = validateRelativeAssetPath(String(scriptPath).replace(/^\.\//, ""), "ENTRYPOINT");
  const scriptAbsolute = path.resolve(dataRoot, scriptRelative);
  if (!isInsideRoot(scriptAbsolute, dataRoot) || !await pathExists(scriptAbsolute)) {
    return {
      ok: false,
      code: "NEOFORGE_RUNTIME_INCOMPLETE",
      message: neoforgeRuntimeIncompleteMessage(),
      details: { missing: [scriptRelative] },
    };
  }
  const scriptText = await readTextIfExists(scriptAbsolute, 256 * 1024);
  const missing = [];
  if (!await pathExists(path.join(dataRoot, "user_jvm_args.txt"))) {
    missing.push("user_jvm_args.txt");
  }
  const refs = extractNeoForgeUnixArgsReferences(scriptText);
  if (refs.length === 0) {
    return missing.length
      ? { ok: false, code: "NEOFORGE_RUNTIME_INCOMPLETE", message: neoforgeRuntimeIncompleteMessage(), details: { missing } }
      : null;
  }
  const existingUnixArgs = await getExistingNeoForgeUnixArgs(dataRoot);
  for (const ref of refs) {
    const absolute = path.join(dataRoot, ref.relativePath);
    if (!await pathExists(absolute)) {
      missing.push(ref.relativePath);
    }
  }
  if (missing.length === 0) {
    return null;
  }
  const expectedVersion = refs.find((ref) => missing.includes(ref.relativePath))?.version || refs[0]?.version || null;
  const availableVersions = existingUnixArgs.map((entry) => entry.version);
  const mismatch = Boolean(expectedVersion && availableVersions.length > 0 && !availableVersions.includes(expectedVersion));
  return {
    ok: false,
    code: "NEOFORGE_RUNTIME_INCOMPLETE",
    message: neoforgeRuntimeIncompleteMessage({ mismatch, expectedVersion, availableVersions }),
    details: {
      missing,
      expectedVersion,
      availableVersions,
      mismatch,
      suggestion: "Retry server bootstrap or reinstall this instance.",
    },
  };
}

function classifyNeoForgeRuntimeOutput(text = "") {
  const match = String(text || "").match(/(?:could not open|No such file or directory).*?`?((?:\.\/)?libraries\/net\/neoforged\/neoforge\/([^\/\s'`]+)\/unix_args\.txt)'?/i);
  if (!match) {
    return null;
  }
  return {
    code: "NEOFORGE_RUNTIME_INCOMPLETE",
    message: neoforgeRuntimeIncompleteMessage(),
    details: {
      missing: [match[1].replace(/^\.\//, "")],
      expectedVersion: match[2] || null,
      suggestion: "Retry server bootstrap or reinstall this instance.",
    },
  };
}

async function detectFromKnownFiles(config) {
  const dataRoot = path.join(instancePath(config.id), "data");
  const detections = [];
  const jsonCandidates = [
    path.join(dataRoot, "metadata.json"),
    path.join(dataRoot, "version.json"),
    path.join(dataRoot, "install_profile.json"),
  ];

  for (const filePath of jsonCandidates) {
    try {
      const parsed = await readJson(filePath);
      const id = parsed.minecraftVersion || parsed.serverVersion || parsed.id || parsed.minecraftArguments || parsed.version || parsed.versionName || parsed.minecraft;
      const detectedMinecraftVersion = parseMinecraftVersion(id) || findMinecraftVersionInObject(parsed);
      detections.push({
        game: parsed.game || parsed.versionInfo?.game || null,
        serverSoftware: parsed.serverSoftware || parsed.versionInfo?.software || inferServerSoftwareFromText(JSON.stringify(parsed)) || null,
        minecraftVersion: detectedMinecraftVersion,
        gameVersion: parseMinecraftVersion(parsed.gameVersion || parsed.versionInfo?.gameVersion) || detectedMinecraftVersion,
        softwareVersion: parsed.softwareVersion || parsed.versionInfo?.softwareVersion || null,
        displayVersion: parsed.displayVersion || parsed.versionInfo?.displayVersion || parsed.version || null,
        displayVersionDetail: parsed.displayVersionDetail || parsed.versionInfo?.displayVersionDetail || null,
        buildNumber: parsed.buildNumber || parsed.paperBuild || parseBuildNumber(JSON.stringify(parsed)),
        paperBuild: parsed.paperBuild || null,
        buildDate: parsed.buildDate || parsed.versionInfo?.buildDate || null,
        versionName: parsed.versionName || parsed.version || null,
        versionInfo: parsed.versionInfo || null,
      });
    } catch {}
  }

  const forgeVersions = await listDirectoryNames(path.join(dataRoot, "libraries", "net", "minecraftforge", "forge"));
  const forgeVersion = forgeVersions.find((name) => parseMinecraftVersion(name));
  if (forgeVersion) {
    detections.push({ serverSoftware: "Forge", minecraftVersion: parseMinecraftVersion(forgeVersion), softwareVersion: forgeVersion, buildNumber: forgeVersion });
  }

  const neoForgeVersions = await listDirectoryNames(path.join(dataRoot, "libraries", "net", "neoforged", "neoforge"));
  const neoForgeScriptRefs = [];
  for (const scriptName of ["run.sh", "startserver.sh"]) {
    const scriptText = await readTextIfExists(path.join(dataRoot, scriptName), 256 * 1024);
    neoForgeScriptRefs.push(...extractNeoForgeUnixArgsReferences(scriptText));
  }
  const referencedNeoForgeVersion = neoForgeScriptRefs.find((ref) => neoForgeVersions.includes(ref.version))?.version || null;
  const neoForgeVersion = referencedNeoForgeVersion || neoForgeVersions.find((name) => inferNeoForgeMinecraftVersion(name));
  if (neoForgeVersion) {
    detections.push({ serverSoftware: "NeoForge", minecraftVersion: inferNeoForgeMinecraftVersion(neoForgeVersion), softwareVersion: neoForgeVersion, buildNumber: neoForgeVersion });
  }

  const fabricProperties = await readTextIfExists(path.join(dataRoot, "fabric-server-launcher.properties"));
  if (fabricProperties) {
    detections.push({ serverSoftware: "Fabric", minecraftVersion: parseMinecraftVersion(fabricProperties), softwareVersion: parseSoftwareVersion(fabricProperties), buildNumber: parseBuildNumber(fabricProperties) });
  }

  return detections.find((entry) => entry.minecraftVersion || entry.serverSoftware) || {};
}

function parsePropertiesText(text) {
  return String(text || "").split(/\r?\n/).reduce((properties, line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
      return properties;
    }
    const separator = trimmed.search(/[:=]/);
    if (separator < 0) {
      return properties;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (key) {
      properties[key] = value;
    }
    return properties;
  }, {});
}

async function detectFromServerProperties(config) {
  const dataRoot = path.join(instancePath(config.id), "data");
  const candidates = [
    path.join(dataRoot, "server.properties"),
    path.join(dataRoot, "server", "server.properties"),
  ];

  for (const filePath of candidates) {
    const text = await readTextIfExists(filePath, 128 * 1024);
    if (!text) {
      continue;
    }
    const properties = parsePropertiesText(text);
    const versionSource = properties["minecraft-version"] ||
      properties["server-version"] ||
      properties.version ||
      properties["serverVersion"] ||
      text.match(/minecraft(?: server)? version[:= ]+([0-9][^\s#]+)/i)?.[1];
    const minecraftVersion = parseMinecraftVersion(versionSource);
    if (minecraftVersion) {
      return {
        serverSoftware: inferServerSoftware(config),
        minecraftVersion,
      };
    }
  }

  return {};
}

async function detectFromLogs(config) {
  const dataRoot = path.join(instancePath(config.id), "data");
  const candidates = [
    path.join(dataRoot, "logs", "latest.log"),
    path.join(dataRoot, "server", "logs", "latest.log"),
    logPath(config.id, "stdout"),
    logPath(config.id, "stderr"),
  ];

  for (const filePath of candidates) {
    const text = await readTextIfExists(filePath, 256 * 1024);
    if (!text) {
      continue;
    }
    const softwareLine = text.match(/(?:This server is running|Starting|Loading|Bootstrap).{0,220}\b(?:Paper|Purpur|Folia|Fabric|Quilt|Forge|NeoForge|Velocity|Waterfall|BungeeCord|Sponge|Spigot|Bukkit)\b.{0,220}/i)?.[0] ||
      text.match(/\b(?:Paper|Purpur|Folia|Fabric|Quilt|Forge|NeoForge|Velocity|Waterfall|BungeeCord|Sponge|Spigot|Bukkit)\b.{0,220}(?:version|build|loader).{0,160}/i)?.[0] ||
      "";
    const minecraftLine = text.match(/Starting minecraft server version\s+([0-9][^\s]+)/i)?.[0] ||
      text.match(/\bMC[:\s-]+(1\.\d+(?:\.\d+)?)/i)?.[0] ||
      "";
    const loaderLine = text.match(/\b(?:Fabric Loader|Quilt Loader)\s+([0-9][^\s]+)/i)?.[0] || "";
    const forgeLine = text.match(/\b(?:Forge|NeoForge)\s+(?:version\s+)?([0-9][^\s]+)/i)?.[0] || "";
    const searchable = `${softwareLine}\n${minecraftLine}\n${loaderLine}\n${forgeLine}`;
    const minecraftVersion = parseMinecraftVersion(searchable);
    const serverSoftware = inferServerSoftwareFromText(searchable);
    if (serverSoftware || minecraftVersion) {
      return {
        serverSoftware,
        minecraftVersion,
        buildNumber: parsePaperBuildNumber(searchable) || parseBuildNumber(searchable),
        paperBuild: /paper|purpur|folia/i.test(serverSoftware || "") ? parsePaperBuildNumber(searchable) : null,
        softwareVersion: parseSoftwareVersion(loaderLine || forgeLine || softwareLine),
      };
    }
  }

  return {};
}

async function detectFromJars(config) {
  const jars = await findJarPaths(config);
  for (const jarPath of jars) {
    const fileName = path.basename(jarPath);
    const versionJson = await unzipText(jarPath, "version.json");
    if (versionJson) {
      try {
        const parsed = JSON.parse(versionJson);
        const minecraftVersion = parseMinecraftVersion(parsed.id || parsed.name || parsed.version);
        if (minecraftVersion) {
          const serverSoftware = inferServerSoftwareFromText(fileName) || inferServerSoftware({ ...config, args: [...(config.args || []), fileName] }) || "Vanilla";
          return {
            minecraftVersion,
            serverSoftware,
            buildNumber: /paper|purpur|folia/i.test(serverSoftware) ? parsePaperBuildNumber(fileName) : parseBuildNumber(fileName),
            paperBuild: /paper|purpur|folia/i.test(serverSoftware) ? parsePaperBuildNumber(fileName) : null,
            softwareVersion: parseSoftwareVersion(fileName),
          };
        }
      } catch {}
    }

    const manifest = await unzipText(jarPath, "META-INF/MANIFEST.MF");
    const searchable = `${fileName}\n${manifest}`;
    const minecraftVersion = parseMinecraftVersion(searchable);
    const serverSoftware = inferServerSoftwareFromText(searchable) || inferServerSoftware({ ...config, args: [...(config.args || []), searchable] }) || null;
    const softwareVersion = manifest.match(/^(?:Implementation-Version|Specification-Version|Bundle-Version):\s*(.+)$/im)?.[1]?.trim() ||
      parseSoftwareVersion(searchable);
    if (minecraftVersion || serverSoftware || softwareVersion) {
      return {
        minecraftVersion,
        serverSoftware,
        buildNumber: parsePaperBuildNumber(searchable) || parseBuildNumber(searchable),
        paperBuild: parsePaperBuildNumber(searchable),
        softwareVersion,
      };
    }

    const fabricJson = await unzipText(jarPath, "fabric.mod.json");
    if (fabricJson) {
      return {
        serverSoftware: "Fabric",
        minecraftVersion: parseMinecraftVersion(fabricJson),
        buildNumber: parseBuildNumber(fabricJson),
        softwareVersion: parseSoftwareVersion(fabricJson),
      };
    }
  }
  return {};
}

function getMinecraftStatusPorts(config) {
  const values = [
    config.queryPort,
    config.primaryPort,
    ...(Array.isArray(config.ports) ? config.ports : []),
    25565,
  ];
  return [...new Set(values.map((value) => Number.parseInt(value, 10)).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))];
}

async function queryMinecraftStatus(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks = [];
    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(PORT_CONNECT_TIMEOUT_MS);
    socket.on("connect", () => {
      socket.write(buildMinecraftStatusRequest(port));
    });
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const buffer = Buffer.concat(chunks);
      try {
        const parsed = parseMinecraftStatusResponse(buffer);
        if (parsed?.version?.name) {
          finish(parsed);
        }
      } catch {
        finish(null);
      }
    });
    socket.on("timeout", () => finish(null));
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

async function detectFromMinecraftStatus(config) {
  for (const port of getMinecraftStatusPorts(config)) {
    const status = await queryMinecraftStatus(port);
    const minecraftVersion = parseMinecraftVersion(status?.version?.name);
    if (minecraftVersion) {
      return {
        serverSoftware: inferServerSoftware(config),
        minecraftVersion,
      };
    }
  }
  return {};
}

function buildVersionLabel(metadata) {
  const software = metadata.serverSoftware || null;
  const game = metadata.game || metadata.versionInfo?.game || inferGameFamily(metadata);
  const isMinecraft = game === "minecraft" || isMinecraftSoftwareName([software, metadata.type, metadata.templateId, metadata.id].filter(Boolean).join(" "));
  if (!isMinecraft && metadata.versionInfo?.displayVersion) {
    return cleanVersionValue(metadata.versionInfo.displayVersion);
  }
  const minecraftVersion = isMinecraft
    ? parseMinecraftVersion(metadata.minecraftVersion || metadata.gameVersion || metadata.serverVersion || metadata.versionName || metadata.version || metadata.versionInfo?.gameVersion || metadata.versionInfo?.displayVersion)
    : cleanVersionValue(metadata.minecraftVersion || metadata.serverVersion || metadata.versionName || metadata.version);
  const savedVersion = cleanVersionValue(metadata.versionName || metadata.version);
  if (!isMinecraft && savedVersion && savedVersion !== minecraftVersion) {
    return savedVersion;
  }
  const buildNumber = cleanVersionValue(metadata.paperBuild || metadata.buildNumber);
  const buildSuffix = buildNumber && buildNumber !== minecraftVersion ? ` build ${buildNumber}` : "";
  if (software && minecraftVersion) {
    return `${software} ${minecraftVersion}${buildSuffix}`;
  }
  const templateVersion = cleanVersionValue(metadata.templateVersion);
  if (isMinecraft) {
    return null;
  }
  return cleanVersionValue(metadata.versionName || metadata.version || metadata.serverVersion || metadata.minecraftVersion) ||
    (buildNumber ? `Build ${buildNumber}` : null) ||
    (templateVersion ? `Template v${templateVersion}` : null);
}

function hasUsableCachedVersion(config) {
  if (config.versionCacheVersion !== VERSION_CACHE_VERSION) {
    return false;
  }
  const cached = cleanVersionValue(config.versionInfo?.displayVersion || config.displayVersion || config.versionName || config.version || config.serverVersion || config.minecraftVersion || config.gameVersion);
  if (!cached || cached === "Unknown version") {
    return false;
  }
  const isMinecraft = inferGameFamily(config) === "minecraft" || isMinecraftSoftwareName([config.serverSoftware, config.type, config.templateId, config.id, ...(Array.isArray(config.tags) ? config.tags : [])].filter(Boolean).join(" "));
  if (!isMinecraft) {
    return true;
  }
  return Boolean(parseMinecraftVersion([
    config.versionInfo?.gameVersion,
    config.versionInfo?.minecraftVersion,
    config.versionInfo?.displayVersion,
    config.minecraftVersion,
    config.gameVersion,
    config.serverVersion,
    config.versionName,
    config.version,
    config.displayVersion,
  ].filter(Boolean).join(" ")));
}

async function detectInstanceVersion(config, options = {}) {
  if (!options.force && hasUsableCachedVersion(config)) {
    return config;
  }

  const software = inferServerSoftware(config);
  const known = await detectFromKnownFiles(config);
  const properties = software ? await detectFromServerProperties(config) : {};
  const jar = await detectFromJars(config);
  const logs = await detectFromLogs(config);
  const status = software ? await detectFromMinecraftStatus(config) : {};
  const detected = {
    serverSoftware: known.serverSoftware || properties.serverSoftware || jar.serverSoftware || logs.serverSoftware || status.serverSoftware || software || null,
    minecraftVersion: parseMinecraftVersion([
      known.minecraftVersion,
      known.gameVersion,
      properties.minecraftVersion,
      jar.minecraftVersion,
      logs.minecraftVersion,
      config.minecraftVersion,
      config.gameVersion,
      config.serverVersion,
      config.versionName,
      config.version,
      config.displayVersion,
      status.minecraftVersion,
    ].filter(Boolean).join(" ")),
    softwareVersion: cleanVersionValue(known.softwareVersion || jar.softwareVersion || logs.softwareVersion || config.softwareVersion),
    buildNumber: cleanVersionValue(known.buildNumber || known.paperBuild || jar.buildNumber || jar.paperBuild || logs.buildNumber || logs.paperBuild || config.buildNumber || config.paperBuild),
    paperBuild: cleanVersionValue(known.paperBuild || jar.paperBuild || logs.paperBuild || config.paperBuild),
    versionName: cleanVersionValue(known.versionName || config.versionName),
  };
  const versionInfo = normalizeVersionInfo({
    ...config.versionInfo,
    ...(known.versionInfo || {}),
    game: known.game || config.game || null,
    gameVersion: known.gameVersion || config.gameVersion || detected.minecraftVersion || null,
    softwareVersion: known.softwareVersion || detected.softwareVersion || config.softwareVersion || null,
    displayVersion: known.displayVersion || config.displayVersion || null,
    displayVersionDetail: known.displayVersionDetail || config.displayVersionDetail || null,
    buildDate: known.buildDate || config.buildDate || null,
    ...detected,
  }, { ...config, ...detected });
  const label = buildVersionLabel({ ...config, ...detected, versionInfo });
  if (!label && !detected.minecraftVersion && !detected.serverSoftware && !versionInfo) {
    return {
      ...config,
      detectedVersionAt: nowIso(),
      versionCacheVersion: VERSION_CACHE_VERSION,
    };
  }

  return {
    ...config,
    ...detected,
    versionInfo,
    game: versionInfo?.game || config.game || null,
    gameVersion: versionInfo?.gameVersion || config.gameVersion || detected.minecraftVersion || null,
    softwareVersion: versionInfo?.softwareVersion || detected.softwareVersion || config.softwareVersion || null,
    displayVersion: versionInfo?.displayVersion || config.displayVersion || label || detected.minecraftVersion || null,
    displayVersionDetail: versionInfo?.displayVersionDetail || config.displayVersionDetail || null,
    buildDate: versionInfo?.buildDate || config.buildDate || null,
    serverVersion: detected.minecraftVersion || config.serverVersion || null,
    version: label || detected.minecraftVersion || config.version || null,
    detectedVersionAt: nowIso(),
    versionCacheVersion: VERSION_CACHE_VERSION,
  };
}

async function backfillInstanceVersion(config, options = {}) {
  const next = await detectInstanceVersion(config, options);
  if (
    next.version !== config.version ||
    next.serverVersion !== config.serverVersion ||
    next.serverSoftware !== config.serverSoftware ||
    next.minecraftVersion !== config.minecraftVersion ||
    next.game !== config.game ||
    next.gameVersion !== config.gameVersion ||
    next.softwareVersion !== config.softwareVersion ||
    next.displayVersion !== config.displayVersion ||
    next.displayVersionDetail !== config.displayVersionDetail ||
    JSON.stringify(next.versionInfo || null) !== JSON.stringify(config.versionInfo || null) ||
    next.buildNumber !== config.buildNumber ||
    next.paperBuild !== config.paperBuild ||
    next.versionName !== config.versionName ||
    next.versionCacheVersion !== config.versionCacheVersion
  ) {
    try {
      await saveInstanceConfig(next);
    } catch (error) {
      if (error?.code !== "EROFS" && error?.code !== "EACCES" && error?.code !== "EPERM") {
        throw error;
      }
    }
  }
  return next;
}

async function loadInstanceConfig(instanceId) {
  const id = validateInstanceId(instanceId);
  const filePath = configPath(id);

  try {
    const config = await readJson(filePath);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      throw createInstanceError("INSTANCE_CONFIG_INVALID", 500);
    }
    const schemaVersion = config.schemaVersion === undefined ? 0 : Number(config.schemaVersion);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 0) {
      throw createInstanceError("INSTANCE_CONFIG_SCHEMA_INVALID", 500, { schemaVersion: config.schemaVersion });
    }
    if (schemaVersion > INSTANCE_CONFIG_SCHEMA_VERSION) {
      throw createInstanceError("INSTANCE_CONFIG_SCHEMA_UNSUPPORTED", 409, {
        schemaVersion,
        supportedSchemaVersion: INSTANCE_CONFIG_SCHEMA_VERSION,
      });
    }
    if (schemaVersion < INSTANCE_CONFIG_SCHEMA_VERSION) {
      const backupPath = `${filePath}.schema-v${schemaVersion}.backup`;
      if (!await pathExists(backupPath)) {
        await fs.copyFile(filePath, backupPath, fsSync.constants.COPYFILE_EXCL);
      }
      const migrated = { ...config, schemaVersion: INSTANCE_CONFIG_SCHEMA_VERSION };
      await writeJson(filePath, migrated);
      return migrated;
    }
    return config;
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw createInstanceError("INSTANCE_NOT_FOUND", 404);
    }
    if (String(error?.code || "").startsWith("INSTANCE_CONFIG_")) {
      throw error;
    }

    throw createInstanceError("INSTANCE_CONFIG_UNREADABLE", 500);
  }
}

async function saveInstanceConfig(config) {
  config = clearInstallerRuntimeJarMetadata(config);
  await ensureInstanceDirectories(config.id);
  await writeJson(configPath(config.id), { ...config, schemaVersion: INSTANCE_CONFIG_SCHEMA_VERSION });
}

function isProcessAlive(pid) {
  if (!pid) {
    return false;
  }

  if (typeof processAliveProvider === "function") {
    return Boolean(processAliveProvider(pid));
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function normalizePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function readProcText(filePath) {
  try {
    return fsSync.readFileSync(filePath);
  } catch {
    return null;
  }
}

function readProcLink(filePath) {
  try {
    return fsSync.readlinkSync(filePath);
  } catch {
    return null;
  }
}

function parseProcStatIdentity(pid) {
  const stat = readProcText(`/proc/${pid}/stat`);
  if (!stat) {
    return { name: null, ppid: null };
  }
  const text = stat.toString("utf8");
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  const name = open >= 0 && close > open ? text.slice(open + 1, close) : null;
  const fields = close >= 0 ? text.slice(close + 2).split(" ") : [];
  return {
    name,
    ppid: normalizePid(fields[1]),
  };
}

function parseProcCmdline(pid) {
  const buffer = readProcText(`/proc/${pid}/cmdline`);
  if (!buffer) {
    return { args: [], commandLine: "" };
  }
  const args = buffer.toString("utf8").split("\0").filter(Boolean);
  return {
    args,
    commandLine: args.join(" "),
  };
}

function parseSocketTable(filePath, protocol) {
  const text = readProcText(filePath);
  if (!text) {
    return [];
  }
  return text.toString("utf8").split(/\r?\n/).slice(1).map((line) => {
    const columns = line.trim().split(/\s+/);
    if (columns.length < 10) {
      return null;
    }
    const local = columns[1] || "";
    const state = columns[3] || "";
    const inode = columns[9] || "";
    const portHex = local.split(":")[1];
    const port = Number.parseInt(portHex, 16);
    if (!Number.isInteger(port) || port <= 0 || !inode) {
      return null;
    }
    if (protocol.startsWith("tcp") && state !== "0A") {
      return null;
    }
    return { protocol, port, inode };
  }).filter(Boolean);
}

function readProcessSocketInodes(pid) {
  const fdDir = `/proc/${pid}/fd`;
  const inodes = new Set();
  let entries = [];
  try {
    entries = fsSync.readdirSync(fdDir);
  } catch {
    return inodes;
  }
  for (const entry of entries) {
    const target = readProcLink(path.join(fdDir, entry));
    const match = String(target || "").match(/^socket:\[(\d+)\]$/);
    if (match) {
      inodes.add(match[1]);
    }
  }
  return inodes;
}

async function inspectSystemProcesses() {
  if (typeof processInspectionProvider === "function") {
    const snapshot = await processInspectionProvider();
    return {
      processes: Array.isArray(snapshot?.processes) ? snapshot.processes : [],
      ports: Array.isArray(snapshot?.ports) ? snapshot.ports : [],
    };
  }

  if (process.platform !== "linux") {
    return { processes: [], ports: [] };
  }

  let procEntries = [];
  try {
    procEntries = fsSync.readdirSync("/proc", { withFileTypes: true });
  } catch {
    return { processes: [], ports: [] };
  }

  const processes = [];
  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) {
      continue;
    }
    const pid = normalizePid(entry.name);
    if (!pid) {
      continue;
    }
    const identity = parseProcStatIdentity(pid);
    const cmdline = parseProcCmdline(pid);
    processes.push({
      pid,
      ppid: identity.ppid,
      name: identity.name,
      commandLine: cmdline.commandLine,
      args: cmdline.args,
      exe: readProcLink(`/proc/${pid}/exe`),
      cwd: readProcLink(`/proc/${pid}/cwd`),
      socketInodes: readProcessSocketInodes(pid),
    });
  }

  const socketRows = [
    ...parseSocketTable("/proc/net/tcp", "tcp"),
    ...parseSocketTable("/proc/net/tcp6", "tcp6"),
    ...parseSocketTable("/proc/net/udp", "udp"),
    ...parseSocketTable("/proc/net/udp6", "udp6"),
  ];
  const processesByInode = new Map();
  for (const proc of processes) {
    for (const inode of proc.socketInodes || []) {
      if (!processesByInode.has(inode)) {
        processesByInode.set(inode, []);
      }
      processesByInode.get(inode).push(proc.pid);
    }
  }
  const ports = [];
  for (const row of socketRows) {
    for (const pid of processesByInode.get(row.inode) || []) {
      ports.push({ port: row.port, protocol: row.protocol, pid, inode: row.inode });
    }
  }

  return { processes, ports };
}

function isPalworldRuntimeCandidate(config = {}) {
  return inferGameFamily(config) === "palworld" ||
    /palworld|palserver/i.test([
      config.templateId,
      config.displayName,
      config.id,
      config.executable,
      ...(Array.isArray(config.args) ? config.args : []),
      ...(Array.isArray(config.tags) ? config.tags : []),
    ].join(" "));
}

function isBenignPalworldStderrLine(line = "", options = {}) {
  const text = String(line || "").trim();
  if (!text) {
    return true;
  }
  if (/^\[S_API\]\s+SteamAPI_Init\(\):\s+Loaded local ['"]steamclient\.so['"] OK\.?$/i.test(text)) {
    return true;
  }
  if (/^Setting breakpad minidump AppID\s*=\s*\d+$/i.test(text)) {
    return true;
  }
  if (/^\[S_API FAIL\]\s+Tried to access Steam interface\s+\S+\s+before SteamAPI_Init succeeded\.?$/i.test(text)) {
    return true;
  }
  if (/o1291919\.ingest\.us\.sentry\.io/i.test(text) && /\b(HTTP\/2\s+200|200\b|successful|uploaded)\b/i.test(text)) {
    return true;
  }
  if (options.requestedStop && /Exiting abnormally\s*\(error code:\s*143\)|\bSIGTERM\b/i.test(text)) {
    return true;
  }
  return false;
}

function isBenignPalworldStderrOutput(config = {}, text = "", options = {}) {
  if (!isPalworldRuntimeCandidate(config)) {
    return false;
  }
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((line) => isBenignPalworldStderrLine(line, options));
}

function configuredRuntimePorts(config = {}) {
  return [...new Set([
    ...(Array.isArray(config.ports) ? config.ports : []),
    config.primaryPort,
  ].map((port) => Number(port)).filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))];
}

async function safeRealpath(filePath) {
  try {
    return await fs.realpath(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

async function buildDetachedRuntimeSpec(config = {}) {
  if (!isPalworldRuntimeCandidate(config)) {
    return null;
  }
  const instanceRoot = await safeRealpath(instancePath(config.id));
  const workingDirectory = await safeRealpath(resolveRelativeManagedPath(config.id, config.workingDirectory, "data"));
  return {
    kind: "palworld",
    instanceRoot,
    workingDirectory,
    processNames: new Set([
      "palserver-linux-shipping",
      "palserver-win64-shipping-cmd.exe",
      "palserver-win64-shipping.exe",
    ]),
    executableFragments: [
      path.join("Pal", "Binaries", "Linux", "PalServer-Linux-Shipping"),
      path.join("Pal", "Binaries", "Win64", "PalServer-Win64-Shipping-Cmd.exe"),
      path.join("Pal", "Binaries", "Win64", "PalServer-Win64-Shipping.exe"),
    ],
    ports: configuredRuntimePorts(config),
  };
}

function processOwnsPorts(proc, ports, portRows) {
  const requiredPorts = ports || [];
  if (requiredPorts.length === 0) {
    return { ok: false, ownedPorts: [] };
  }
  const ownedPorts = [...new Set(portRows
    .filter((row) => normalizePid(row.pid) === normalizePid(proc.pid) && requiredPorts.includes(Number(row.port)))
    .map((row) => Number(row.port)))];
  return {
    ok: requiredPorts.every((port) => ownedPorts.includes(port)),
    ownedPorts,
  };
}

function collectProcessPathCandidates(proc) {
  const values = [
    proc.exe,
    proc.cwd,
    ...(Array.isArray(proc.args) ? proc.args : []),
    ...String(proc.commandLine || "").split(/\s+/),
  ];
  return values
    .map((value) => String(value || "").trim().replace(/^"|"$/g, ""))
    .filter((value) => value && path.isAbsolute(value))
    .map((value) => path.resolve(value));
}

function processMatchesDetachedIdentity(proc, spec) {
  const name = path.basename(String(proc.name || proc.exe || proc.args?.[0] || "")).toLowerCase();
  const commandLine = String(proc.commandLine || "");
  const exe = String(proc.exe || "");
  const cwd = String(proc.cwd || "");
  const expectedName = spec.processNames.has(name);
  const expectedExecutable = spec.executableFragments.some((fragment) => {
    const normalizedFragment = fragment.replace(/\\/g, "/").toLowerCase();
    return exe.replace(/\\/g, "/").toLowerCase().endsWith(normalizedFragment) ||
      commandLine.replace(/\\/g, "/").toLowerCase().includes(normalizedFragment);
  });
  const pathInsideInstance = collectProcessPathCandidates({ ...proc, exe, cwd, commandLine })
    .some((candidate) => isInsideRoot(candidate, spec.instanceRoot) || isInsideRoot(candidate, spec.workingDirectory));
  return (expectedName || expectedExecutable) && pathInsideInstance;
}

async function discoverDetachedRuntime(config = {}) {
  const spec = await buildDetachedRuntimeSpec(config);
  if (!spec) {
    return null;
  }
  const snapshot = await inspectSystemProcesses();
  for (const proc of snapshot.processes) {
    if (!normalizePid(proc.pid) || !isProcessAlive(proc.pid)) {
      continue;
    }
    if (!processMatchesDetachedIdentity(proc, spec)) {
      continue;
    }
    const ports = processOwnsPorts(proc, spec.ports, snapshot.ports);
    if (!ports.ok) {
      continue;
    }
    return {
      pid: normalizePid(proc.pid),
      ppid: normalizePid(proc.ppid),
      processName: proc.name || path.basename(proc.exe || ""),
      executablePath: proc.exe || null,
      workingDirectory: proc.cwd || null,
      commandLine: proc.commandLine || null,
      ports: ports.ownedPorts,
      detectionMethod: "detached-runtime-process",
      runtimeKind: spec.kind,
    };
  }
  return null;
}

async function findUnrelatedPortConflicts(config = {}) {
  const ports = configuredRuntimePorts(config);
  if (ports.length === 0) {
    return [];
  }
  const spec = await buildDetachedRuntimeSpec(config);
  const snapshot = await inspectSystemProcesses();
  const conflicts = [];
  for (const row of snapshot.ports) {
    const port = Number(row.port);
    const pid = normalizePid(row.pid);
    if (!ports.includes(port) || !pid || !isProcessAlive(pid)) {
      continue;
    }
    const proc = snapshot.processes.find((entry) => normalizePid(entry.pid) === pid) || { pid };
    if (spec && processMatchesDetachedIdentity(proc, spec)) {
      continue;
    }
    conflicts.push({
      port,
      protocol: row.protocol || null,
      pid,
      processName: proc.name || path.basename(proc.exe || "") || null,
    });
  }
  return conflicts;
}

async function adoptDiscoveredRuntime(config, runtime, options = {}) {
  if (!runtime?.pid || !isProcessAlive(runtime.pid)) {
    return null;
  }
  const updated = await updateRuntimeState(config.id, {
    state: INSTANCE_STATES.RUNNING,
    pid: runtime.pid,
    exitCode: null,
    signal: null,
    failureReason: null,
    // A discovered detached server is already alive and has passed the Agent's
    // process/identity checks. Treat it as ready; game-specific log readiness
    // is handled while a directly spawned wrapper is still attached.
    readinessState: "ready",
    healthState: "healthy",
    lastStartedAt: config.lastStartedAt || nowIso(),
    runtimeProcess: {
      pid: runtime.pid,
      ppid: runtime.ppid || null,
      processName: runtime.processName || null,
      executablePath: runtime.executablePath || null,
      workingDirectory: runtime.workingDirectory || null,
      ports: runtime.ports || [],
      detectionMethod: runtime.detectionMethod || "detached-runtime-process",
      reconciledAt: nowIso(),
      reason: options.reason || null,
    },
  });
  return updated;
}

function getActiveRunningProcess(instanceId) {
  const entry = runningProcesses.get(instanceId);
  return entry?.child?.pid && isProcessAlive(entry.child.pid) ? entry : null;
}

function isCurrentRunningProcess(instanceId, child) {
  const entry = runningProcesses.get(instanceId);
  return Boolean(entry && entry.child === child);
}

async function reconcileConfigState(config) {
  const detachedRuntime = await discoverDetachedRuntime(config).catch(() => null);
  if (detachedRuntime) {
    return adoptDiscoveredRuntime(config, detachedRuntime, { reason: "reconcile" });
  }

  const processEntry = runningProcesses.get(config.id);
  const pid = processEntry?.child?.pid || config.pid;

  if (pid && isProcessAlive(pid)) {
    const state = processEntry && config.state === INSTANCE_STATES.STARTING ? INSTANCE_STATES.STARTING : INSTANCE_STATES.RUNNING;
    return {
      ...config,
      state,
      pid,
    };
  }

  if (config.state === INSTANCE_STATES.RUNNING || config.state === INSTANCE_STATES.STARTING || config.state === INSTANCE_STATES.STOPPING || config.state === INSTANCE_STATES.RESTARTING) {
    const intentionalStop = config.state === INSTANCE_STATES.STOPPING;
    const updated = {
      ...config,
      state: intentionalStop ? INSTANCE_STATES.STOPPED : INSTANCE_STATES.UNKNOWN,
      pid: null,
      runtimeProcess: null,
      lastStoppedAt: config.lastStoppedAt || nowIso(),
      failureReason: intentionalStop ? null : "STALE_PID",
      readinessState: intentionalStop ? "stopped" : "unknown",
      healthState: "unknown",
    };

    await saveInstanceConfig(updated);
    return updated;
  }

  return config;
}

async function listInstanceIds() {
  const root = getInstanceRoot();

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).filter((name) => {
      return /^[a-zA-Z0-9][a-zA-Z0-9_-]{1,63}$/.test(name);
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw createInstanceError("INSTANCE_ROOT_UNAVAILABLE", 500);
  }
}

async function listInstances() {
  const ids = await listInstanceIds();
  const instances = [];

  for (const id of ids) {
    try {
      let config = await reconcileConfigState(await loadInstanceConfig(id));
      if (config.installationState === "installing") {
        continue;
      }
      if (isFiveMInstance(config)) {
        config = (await refreshFiveMReadiness(config.id)).config;
      }
      instances.push(await publicConfigDetailed(await backfillInstanceVersion(config)));
    } catch {
      continue;
    }
  }

  return {
    root: getInstanceRoot(),
    instances: instances.sort((left, right) => left.displayName.localeCompare(right.displayName)),
  };
}

async function createInstance(payload) {
  const config = normalizeInstanceConfig(payload || {});

  if (await pathExists(configPath(config.id))) {
    throw createInstanceError("INSTANCE_ALREADY_EXISTS", 409);
  }

  await saveInstanceConfig(config);

  return publicConfig(config);
}

async function updateInstance(instanceId, payload = {}) {
  const current = await loadInstanceConfig(instanceId);

  if (payload.javaRuntime !== undefined || payload.javaRuntimeOverride !== undefined || payload.requiredJavaMajor !== undefined) {
    throw createInstanceError("JAVA_RUNTIME_SELECTION_AGENT_OWNED", 403);
  }
  if (payload.executable !== undefined && path.isAbsolute(String(payload.executable)) && isMinecraftJavaInstance({ ...current, ...payload })) {
    throw createInstanceError("JAVA_RUNTIME_PATH_NOT_ALLOWED", 403);
  }

  if (
    payload.state !== undefined
    || payload.pid !== undefined
    || payload.exitCode !== undefined
    || payload.signal !== undefined
    || payload.setupRequired !== undefined
    || payload.setupReadiness !== undefined
    || payload.readinessState !== undefined
    || payload.healthState !== undefined
  ) {
    throw createInstanceError("RUNTIME_FIELDS_READ_ONLY");
  }

  const next = {
    ...current,
    displayName: payload.displayName !== undefined || payload.name !== undefined
      ? validateDisplayName(payload.displayName || payload.name, current.id)
      : current.displayName,
    workingDirectory: payload.workingDirectory !== undefined
      ? path.relative(instancePath(current.id), resolveRelativeManagedPath(current.id, payload.workingDirectory, "data")) || "."
      : current.workingDirectory,
    executable: payload.executable !== undefined ? validateExecutable(payload.executable) : current.executable,
    args: payload.args !== undefined
      ? normalizeShellWrapperArgs(payload.executable !== undefined ? validateExecutable(payload.executable) : current.executable, normalizeStringArray(payload.args, "ARGS", 128))
      : normalizeShellWrapperArgs(payload.executable !== undefined ? validateExecutable(payload.executable) : current.executable, current.args),
    startupArguments: payload.startupArguments !== undefined ? normalizeStringArray(payload.startupArguments, "ARGS", 128) : current.startupArguments,
    startupScript: payload.startupScript !== undefined ? (payload.startupScript ? validateRelativeAssetPath(payload.startupScript, "ENTRYPOINT") : null) : current.startupScript,
    environment: payload.environment !== undefined || payload.env !== undefined
      ? normalizeEnvironment(payload.environment || payload.env)
      : current.environment,
    autoStart: payload.autoStart !== undefined ? validateBoolean(payload.autoStart, current.autoStart) : current.autoStart,
    restartPolicy: payload.restartPolicy !== undefined ? validateRestartPolicy(payload.restartPolicy) : current.restartPolicy,
    startupTimeoutMs: payload.startupTimeoutMs !== undefined
      ? validatePositiveInteger(payload.startupTimeoutMs, current.startupTimeoutMs, MAX_STARTUP_TIMEOUT_MS, "startupTimeoutMs")
      : current.startupTimeoutMs,
    shutdownTimeoutMs: payload.shutdownTimeoutMs !== undefined
      ? validatePositiveInteger(payload.shutdownTimeoutMs, current.shutdownTimeoutMs, MAX_SHUTDOWN_TIMEOUT_MS, "shutdownTimeoutMs")
      : current.shutdownTimeoutMs,
    memoryLimit: payload.memoryLimit !== undefined
      ? (payload.memoryLimit ? validateMemoryValue(payload.memoryLimit) : null)
      : current.memoryLimit,
    serverJar: payload.serverJar !== undefined || payload.jar !== undefined
      ? (normalizeOptionalJarPath(payload.serverJar) || normalizeOptionalJarPath(payload.jar))
      : current.serverJar,
    serverJarPath: payload.serverJarPath !== undefined || payload.serverJar !== undefined || payload.jar !== undefined
      ? (normalizeOptionalJarPath(payload.serverJarPath) || normalizeOptionalJarPath(payload.serverJar) || normalizeOptionalJarPath(payload.jar))
      : current.serverJarPath,
    startJar: payload.startJar !== undefined || payload.serverJar !== undefined || payload.jar !== undefined
      ? (normalizeOptionalJarPath(payload.startJar) || normalizeOptionalJarPath(payload.serverJar) || normalizeOptionalJarPath(payload.jar))
      : current.startJar,
    ports: payload.ports !== undefined ? normalizePorts(payload.ports) : current.ports,
    game: payload.game !== undefined ? (payload.game ? String(payload.game).slice(0, 80) : null) : current.game,
    version: payload.version !== undefined ? (payload.version ? String(payload.version).slice(0, 80) : null) : current.version,
    versionName: payload.versionName !== undefined ? (payload.versionName ? String(payload.versionName).slice(0, 80) : null) : current.versionName,
    serverVersion: payload.serverVersion !== undefined ? (payload.serverVersion ? String(payload.serverVersion).slice(0, 80) : null) : current.serverVersion,
    serverSoftware: payload.serverSoftware !== undefined ? (payload.serverSoftware ? String(payload.serverSoftware).slice(0, 80) : null) : current.serverSoftware,
    loader: payload.loader !== undefined ? (payload.loader ? String(payload.loader).slice(0, 80) : null) : current.loader,
    loaderVersion: payload.loaderVersion !== undefined ? (payload.loaderVersion ? String(payload.loaderVersion).slice(0, 80) : null) : current.loaderVersion,
    minecraftVersion: payload.minecraftVersion !== undefined ? (payload.minecraftVersion ? String(payload.minecraftVersion).slice(0, 80) : null) : current.minecraftVersion,
    gameVersion: payload.gameVersion !== undefined ? (payload.gameVersion ? String(payload.gameVersion).slice(0, 80) : null) : current.gameVersion,
    softwareVersion: payload.softwareVersion !== undefined ? (payload.softwareVersion ? String(payload.softwareVersion).slice(0, 80) : null) : current.softwareVersion,
    displayVersion: payload.displayVersion !== undefined ? (payload.displayVersion ? String(payload.displayVersion).slice(0, 120) : null) : current.displayVersion,
    displayVersionDetail: payload.displayVersionDetail !== undefined ? (payload.displayVersionDetail ? String(payload.displayVersionDetail).slice(0, 120) : null) : current.displayVersionDetail,
    templateVersion: payload.templateVersion !== undefined ? (payload.templateVersion ? String(payload.templateVersion).slice(0, 80) : null) : current.templateVersion,
    templateId: payload.templateId !== undefined ? (payload.templateId ? String(payload.templateId).slice(0, 80) : null) : current.templateId,
    buildNumber: payload.buildNumber !== undefined ? (payload.buildNumber ? String(payload.buildNumber).slice(0, 80) : null) : current.buildNumber,
    paperBuild: payload.paperBuild !== undefined ? (payload.paperBuild ? String(payload.paperBuild).slice(0, 80) : null) : current.paperBuild,
    buildDate: payload.buildDate !== undefined ? (payload.buildDate ? String(payload.buildDate).slice(0, 80) : null) : current.buildDate,
    detectedVersionAt: payload.detectedVersionAt !== undefined ? payload.detectedVersionAt : current.detectedVersionAt,
    versionCacheVersion: payload.versionCacheVersion !== undefined ? payload.versionCacheVersion : current.versionCacheVersion,
    connectionHost: payload.connectionHost !== undefined ? (payload.connectionHost ? String(payload.connectionHost).slice(0, 255) : null) : current.connectionHost,
    primaryPort: payload.primaryPort !== undefined
      ? (() => {
        const port = Number.parseInt(payload.primaryPort, 10);
        return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
      })()
      : current.primaryPort,
    tags: payload.tags !== undefined ? normalizeTags(payload.tags) : current.tags,
    installationState: normalizeInstallationState(payload.installationState, current.installationState || "active"),
    installationOperationId: normalizeInstallationState(payload.installationState, current.installationState || "active") === "installing"
      ? current.installationOperationId || null
      : null,
    updatedAt: nowIso(),
  };

  next.versionInfo = normalizeVersionInfo(payload.versionInfo !== undefined ? payload.versionInfo : current.versionInfo, next);
  if (
    (payload.args !== undefined || payload.executable !== undefined || payload.workingDirectory !== undefined) &&
    payload.versionInfo === undefined &&
    payload.displayVersion === undefined &&
    payload.gameVersion === undefined &&
    payload.minecraftVersion === undefined
  ) {
    next.versionCacheVersion = null;
    next.detectedVersionAt = null;
  }

  const resolvedNext = current.installationState === "installing" && next.installationState === "active"
    ? resolveInstanceJavaRuntime(next)
    : next;
  assertExecutableAllowed(resolvedNext.executable);
  assertSafeArguments(resolvedNext.args);
  await saveInstanceConfig(resolvedNext);
  return publicConfig(resolvedNext);
}

async function renameInstance(instanceId, displayName) {
  return updateInstance(instanceId, { displayName });
}

async function duplicateInstance(instanceId, payload = {}) {
  const source = await reconcileConfigState(await loadInstanceConfig(instanceId));
  const activePid = source.pid && isProcessAlive(source.pid) ? source.pid : null;
  if (activePid || getActiveRunningProcess(source.id)) {
    throw createInstanceError("INSTANCE_RUNNING", 409);
  }

  const nextId = validateInstanceId(payload.id || `${source.id}-copy`);
  const targetPath = instancePath(nextId);
  if (await pathExists(configPath(nextId)) || await pathExists(targetPath)) {
    throw createInstanceError("INSTANCE_ALREADY_EXISTS", 409);
  }

  await ensureManagedPath(targetPath);
  await fs.cp(instancePath(source.id), targetPath, { recursive: true, errorOnExist: true, force: false });
  const now = nowIso();
  const duplicated = {
    ...source,
    id: nextId,
    displayName: validateDisplayName(payload.displayName || payload.name, `${source.displayName || source.id} Copy`),
    createdAt: now,
    updatedAt: now,
    lastStartedAt: null,
    lastStoppedAt: null,
    state: INSTANCE_STATES.STOPPED,
    pid: null,
    exitCode: null,
    signal: null,
    failureReason: null,
    setupRequired: source.setupRequired || null,
    setupReadiness: source.setupReadiness || null,
    runtimeProcess: null,
    duplicatedFrom: source.id,
  };
  await writeJson(configPath(nextId), duplicated);
  return {
    instance: publicConfig(duplicated),
    sourceId: source.id,
    duplicated: true,
  };
}

async function deleteInstance(instanceId) {
  const id = validateInstanceId(instanceId);
  terminateInstallationSession(id);
  let config;
  const basePath = instancePath(id);
  const result = {
    success: false,
    id,
    instanceId: id,
    deleted: false,
    filesDeleted: false,
    metadataRemoved: false,
    alreadyMissing: false,
    partiallyFailed: false,
    stale: false,
    errors: [],
  };

  try {
    config = await reconcileConfigState(await loadInstanceConfig(id));
  } catch (error) {
    if (error?.code === "INSTANCE_NOT_FOUND" || error?.code === "INSTANCE_CONFIG_UNREADABLE") {
      const processEntry = runningProcesses.get(id);
      const pid = processEntry?.child?.pid || processEntry?.pid;
      if (pid && isProcessAlive(pid)) {
        throw createInstanceError("INSTANCE_RUNNING", 409);
      }

      const existed = await pathExists(basePath);
      await fs.rm(basePath, { recursive: true, force: true });
      runningProcesses.delete(id);
      metricsSamples.delete(id);

      return {
        ...result,
        success: true,
        id,
        instanceId: id,
        deleted: true,
        filesDeleted: existed,
        metadataRemoved: true,
        alreadyMissing: !existed,
        stale: true,
      };
    }

    throw error;
  }

  if (config.pid && isProcessAlive(config.pid)) {
    throw createInstanceError("INSTANCE_RUNNING", 409);
  }

  try {
    const existed = await pathExists(instancePath(config.id));
    await fs.rm(instancePath(config.id), { recursive: true, force: true });
    runningProcesses.delete(config.id);
    metricsSamples.delete(config.id);

    return {
      ...result,
      success: true,
      id: config.id,
      instanceId: config.id,
      deleted: true,
      filesDeleted: existed,
      metadataRemoved: true,
      alreadyMissing: !existed,
    };
  } catch (error) {
    const deleteError = createInstanceError("INSTANCE_DELETE_FAILED", 500, {
      result: {
        ...result,
        id: config.id,
        filesDeleted: false,
        metadataRemoved: false,
        alreadyMissing: false,
        partiallyFailed: true,
        errors: [{
          code: error?.code || "FILES_DELETE_FAILED",
          message: error?.message || "Instance files could not be deleted.",
        }],
      },
    });
    deleteError.message = "Instance files could not be deleted. You can remove the instance record without deleting files.";
    throw deleteError;
  }
}

async function recoverIncompleteInstallations() {
  const repaired = [];
  const failures = [];
  for (const id of await listInstanceIds()) {
    let config;
    try {
      config = await loadInstanceConfig(id);
    } catch (error) {
      failures.push({ instanceId: id, code: error?.code || "INSTANCE_RECOVERY_READ_FAILED" });
      continue;
    }
    if (config.installationState !== "installing") continue;
    try {
      if (config.pid && isProcessAlive(config.pid)) {
        await stopInstance(id);
      }
      await deleteInstance(id);
      repaired.push({ instanceId: id, action: "removed-incomplete-installation" });
    } catch (error) {
      failures.push({ instanceId: id, code: error?.code || "INSTANCE_RECOVERY_DELETE_FAILED" });
    }
  }
  return { repaired, failures };
}

async function forgetInstance(instanceId) {
  const id = validateInstanceId(instanceId);
  const processEntry = runningProcesses.get(id);
  const result = {
    success: false,
    id,
    instanceId: id,
    deleted: false,
    filesDeleted: false,
    metadataRemoved: false,
    alreadyMissing: false,
    partiallyFailed: false,
    stale: true,
    errors: [],
  };

  const pid = processEntry?.child?.pid || processEntry?.pid;
  if (pid && isProcessAlive(pid)) {
    throw createInstanceError("INSTANCE_RUNNING", 409);
  }

  const record = configPath(id);
  const basePath = instancePath(id);
  const recordExisted = await pathExists(record);
  const baseExisted = await pathExists(basePath);

  try {
    await fs.rm(record, { force: true });
    runningProcesses.delete(id);
    metricsSamples.delete(id);
    return {
      ...result,
      success: true,
      deleted: true,
      filesDeleted: false,
      metadataRemoved: recordExisted,
      alreadyMissing: !recordExisted,
      stale: true,
    };
  } catch (error) {
    const forgetError = createInstanceError("INSTANCE_FORGET_FAILED", 500, {
      result: {
        ...result,
        partiallyFailed: true,
        errors: [{
          code: error?.code || "METADATA_REMOVE_FAILED",
          message: error?.message || "Instance metadata could not be removed.",
        }],
      },
    });
    forgetError.message = "Instance metadata could not be removed.";
    throw forgetError;
  }
}

async function updateRuntimeState(instanceId, patch) {
  const current = await loadInstanceConfig(instanceId);
  const updated = {
    ...current,
    ...patch,
    updatedAt: nowIso(),
  };

  await saveInstanceConfig(updated);
  return updated;
}

async function rotateLogIfNeeded(filePath) {
  try {
    const stats = await fs.stat(filePath);

    if (stats.size < MAX_LOG_BYTES) {
      return;
    }

    await fs.rename(filePath, `${filePath}.1`).catch(() => {});
  } catch {
    // Missing logs are created on first write.
  }
}

function redactLogLine(line) {
  return String(line || "")
    .replace(/\b(?:token|secret|password|credential|api[_-]?key)\b\s*[:=]\s*\S+/gi, (match) => `${match.split(/[:=]/)[0]}=[redacted]`)
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/-]+=*/g, "Bearer [redacted]");
}

function appendProcessTail(entry, streamName, chunk) {
  if (!entry) {
    return;
  }
  const lines = String(chunk || "").split(/\r?\n/).filter(Boolean);
  if (!Array.isArray(entry.outputTail)) {
    entry.outputTail = [];
  }
  for (const line of lines) {
    entry.outputTail.push({
      stream: streamName,
      message: redactLogLine(line),
    });
  }
  if (entry.outputTail.length > PROCESS_TAIL_LINE_LIMIT) {
    entry.outputTail.splice(0, entry.outputTail.length - PROCESS_TAIL_LINE_LIMIT);
  }
}

function formatCommandForLog(config = {}) {
  const parts = [config.executable, ...(Array.isArray(config.args) ? config.args : [])]
    .filter((part) => part !== undefined && part !== null)
    .map((part) => {
      const text = redactLogLine(String(part));
      return /\s/.test(text) ? JSON.stringify(text) : text;
    });
  return parts.join(" ");
}

async function readEulaStatus(config = {}) {
  if (inferGameFamily(config) !== "minecraft" && !isMinecraftSoftwareName([config.type, config.serverSoftware, config.displayName, config.id].join(" "))) {
    return "not-applicable";
  }
  const workingDirectory = config.workingDirectory || "data";
  const eulaPath = path.join(resolveRelativeManagedPath(config.id, workingDirectory, "data"), "eula.txt");
  const text = await readTextIfExists(eulaPath, 16 * 1024);
  if (!text) {
    return "missing";
  }
  return /^\s*eula\s*=\s*true\s*$/im.test(text) ? "accepted" : "not-accepted";
}

async function getJavaVersionForLog(executable) {
  if (!/^java(?:\.exe)?$/i.test(executableName(executable))) {
    return "not-java";
  }
  const result = await execFile(executable, ["-version"], { timeout: 3000, maxBuffer: 64 * 1024 });
  const output = [result.stderr, result.stdout].filter(Boolean).join("\n").split(/\r?\n/).find(Boolean);
  return output ? redactLogLine(output) : "unknown";
}

async function appendLog(instanceId, streamName, chunk) {
  const filePath = logPath(instanceId, streamName);
  const lines = String(chunk || "").split(/\r?\n/).filter(Boolean);

  if (lines.length === 0) {
    return;
  }

  await rotateLogIfNeeded(filePath);

  const payload = lines.map((line) => {
    return JSON.stringify({
      at: nowIso(),
      stream: streamName,
      message: redactLogLine(line),
    });
  }).join("\n");

  await fs.appendFile(filePath, `${payload}\n`, { mode: 0o600 });
}

function scheduleVersionRefresh(instanceId, delayMs = 2500) {
  const existing = versionRefreshTimers.get(instanceId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(async () => {
    versionRefreshTimers.delete(instanceId);
    try {
      await backfillInstanceVersion(await loadInstanceConfig(instanceId), { force: true });
    } catch {}
  }, delayMs);
  timer.unref?.();
  versionRefreshTimers.set(instanceId, timer);
}

function buildSpawnEnvironment(config) {
  return {
    PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: path.join(instancePath(config.id), "runtime"),
    ...config.environment,
  };
}

async function startInstance(instanceId, options = {}) {
  if (!options.automaticRestart) {
    resetRestartBackoff(instanceId);
  }

  let config = await backfillInstanceVersion(await reconcileConfigState(await loadInstanceConfig(instanceId)), { force: true });
  if (config.installationState === "installing") {
    const error = createInstanceError("INSTANCE_INSTALLATION_INCOMPLETE", 409, { instanceId: config.id });
    error.message = "The instance cannot start until installation completes.";
    throw error;
  }
  config = await repairScriptLauncherCommand(config);
  const runtimeResolvedConfig = resolveInstanceJavaRuntime(config);
  if (runtimeResolvedConfig.executable !== config.executable || JSON.stringify(runtimeResolvedConfig.javaRuntime) !== JSON.stringify(config.javaRuntime)) {
    config = { ...runtimeResolvedConfig, updatedAt: nowIso() };
    await saveInstanceConfig(config);
    await appendLog(config.id, "stdout", `Selected Java ${config.javaRuntime.major} runtime: ${config.executable}`).catch(() => {});
  }
  const repairedArgs = normalizeShellWrapperArgs(config.executable, config.args);
  if (JSON.stringify(repairedArgs) !== JSON.stringify(config.args || [])) {
    config = await updateInstance(config.id, { args: repairedArgs });
    await appendLog(config.id, "stdout", `Repaired startup command arguments: ${formatCommandForLog(config)}`).catch(() => {});
  }

  const discoveredRuntime = await discoverDetachedRuntime(config).catch(() => null);
  if (discoveredRuntime) {
    const runningConfig = await adoptDiscoveredRuntime(config, discoveredRuntime, { reason: "start-preflight" });
    const error = createInstanceError("INSTANCE_ALREADY_RUNNING", 409, {
      state: "ALREADY_RUNNING",
      runtime: discoveredRuntime,
      instance: publicConfig(runningConfig),
    });
    error.message = "The instance is already running.";
    throw error;
  }

  if (getActiveRunningProcess(config.id) || (config.pid && isProcessAlive(config.pid))) {
    const error = createInstanceError("INSTANCE_ALREADY_RUNNING", 409, {
      state: "ALREADY_RUNNING",
      pid: config.pid || getActiveRunningProcess(config.id)?.child?.pid || null,
    });
    error.message = "The instance is already running.";
    throw error;
  }

  const portConflicts = await findUnrelatedPortConflicts(config).catch(() => []);
  if (portConflicts.length > 0) {
    const error = createInstanceError("PORT_IN_USE", 409, {
      field: "ports",
      conflicts: portConflicts,
      expected: "configured instance ports must be free or owned by the same instance runtime",
    });
    error.message = "One or more configured ports are already in use by another process.";
    throw error;
  }

  config = await repairConfiguredServerJar(config);
  const workingDirectory = resolveRelativeManagedPath(config.id, config.workingDirectory, "data");
  assertExecutableAllowed(config.executable);
  await fs.mkdir(workingDirectory, { recursive: true });
  await assertFiveMCanStart(config);
  const neoForgeRuntimeValidation = await validateNeoForgeRuntimeFiles(config);
  if (neoForgeRuntimeValidation?.ok === false) {
    await appendLog(config.id, "stderr", neoForgeRuntimeValidation.message).catch(() => {});
    const failedConfig = await updateRuntimeState(config.id, {
      state: INSTANCE_STATES.FAILED,
      pid: null,
      exitCode: null,
      signal: null,
      failureReason: neoForgeRuntimeValidation.code,
      failureDetails: neoForgeRuntimeValidation.details,
      readinessState: "failed",
      healthState: "crashed",
      lastStoppedAt: nowIso(),
    });
    return publicConfig(failedConfig);
  }
  await appendLog(config.id, "stdout", `Starting ${config.displayName}`);
  const commandForLog = formatCommandForLog(config);
  const javaVersion = await getJavaVersionForLog(config.executable).catch((error) => `unavailable: ${error?.code || error?.message || "unknown"}`);
  const eulaStatus = await readEulaStatus(config).catch((error) => `unavailable: ${error?.code || error?.message || "unknown"}`);
  const jarIndex = Array.isArray(config.args) ? config.args.findIndex((arg) => arg === "-jar") : -1;
  const commandDiagnostics = {
    command: commandForLog,
    workingDirectory,
    executable: config.executable,
    args: config.args,
    javaVersion,
    serverJar: config.serverJar || config.serverJarPath || config.startJar || null,
    mainClassOrJar: jarIndex >= 0 ? config.args[jarIndex + 1] || null : (isScriptBasedCommand(config) ? config.args?.[0] || null : null),
    eulaStatus,
  };
  console.info("[Instances] Starting instance process.", {
    instanceId: config.id,
    ...commandDiagnostics,
  });
  await appendLog(config.id, "stdout", `Launch command: ${commandForLog || "unavailable"}`);
  await appendLog(config.id, "stdout", `Working directory: ${workingDirectory}`);
  await appendLog(config.id, "stdout", `Java version: ${javaVersion}`);
  await appendLog(config.id, "stdout", `EULA status: ${eulaStatus}`);
  scheduleVersionRefresh(config.id, 2500);

  config = await updateRuntimeState(config.id, {
    state: INSTANCE_STATES.STARTING,
    pid: null,
    exitCode: null,
    signal: null,
    failureReason: null,
    failureDetails: null,
    readinessState: "starting",
    healthState: "unknown",
    runtimeProcess: null,
    lastStartedAt: nowIso(),
  });

  let child;

  try {
    child = childProcess.spawn(config.executable, config.args, {
      cwd: workingDirectory,
      env: buildSpawnEnvironment(config),
      detached: false,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    const failedConfig = await updateRuntimeState(config.id, {
      state: INSTANCE_STATES.FAILED,
      failureReason: "SPAWN_FAILED",
      readinessState: "failed",
      healthState: "crashed",
      lastStoppedAt: nowIso(),
    });

    return publicConfig(failedConfig);
  }

    runningProcesses.set(config.id, {
      child,
      startedAt: Date.now(),
      requestedStop: false,
      suppressRestart: false,
      failureReason: null,
      startupTimer: null,
      discoveryTimer: null,
      outputTail: [],
      commandDiagnostics,
    });

  child.on("error", (error) => {
    if (!isCurrentRunningProcess(config.id, child)) {
      return;
    }
    const reason = error?.code === "ENOENT" ? "EXECUTABLE_NOT_FOUND" : "PROCESS_ERROR";
    const entry = runningProcesses.get(config.id);
    if (entry) {
      entry.failureReason = reason;
      entry.suppressRestart = true;
      appendProcessTail(entry, "stderr", `${error?.message || reason}\n`);
    }
    appendLog(config.id, "stderr", `${error?.message || reason}\n`).catch(() => {});
    updateRuntimeState(config.id, {
      state: INSTANCE_STATES.FAILED,
      pid: null,
      failureReason: reason,
      lastStoppedAt: nowIso(),
    }).catch(() => {});
  });

  if (!child.pid) {
    const failedConfig = await updateRuntimeState(config.id, {
      state: INSTANCE_STATES.FAILED,
      pid: null,
      failureReason: "SPAWN_FAILED",
      lastStoppedAt: nowIso(),
    });

    if (isCurrentRunningProcess(config.id, child)) {
      runningProcesses.delete(config.id);
    }
    return publicConfig(failedConfig);
  }

  child.stdout.on("data", (chunk) => {
    const text = String(chunk || "");
    appendLog(config.id, "stdout", chunk).catch(() => {});
    appendProcessTail(runningProcesses.get(config.id), "stdout", chunk);
    if (isFiveMInstance(config) && FIVEM_LICENSE_FAILURE_PATTERN.test(text)) {
      const entry = runningProcesses.get(config.id);
      if (entry) {
        entry.suppressRestart = true;
        entry.failureReason = "FIVEM_LICENSE_REQUIRED";
      }
    }
    if (/Done \([^)]+\)!|For help, type|Timings Reset|Server marked as running|Listening on port\s+\d+|Server started/i.test(String(chunk))) {
      if (!isCurrentRunningProcess(config.id, child)) {
        return;
      }
      updateRuntimeState(config.id, {
        state: INSTANCE_STATES.RUNNING,
        pid: child.pid,
        readinessState: "ready",
        healthState: "healthy",
      }).catch(() => {});
      scheduleVersionRefresh(config.id, 1000);
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = String(chunk || "");
    appendLog(config.id, "stderr", chunk).catch(() => {});
    const entry = runningProcesses.get(config.id);
    appendProcessTail(entry, "stderr", chunk);
    const benignPalworldStderr = isBenignPalworldStderrOutput(config, text, {
      requestedStop: Boolean(entry?.requestedStop),
    });
    const neoForgeRuntimeError = classifyNeoForgeRuntimeOutput(text);
    if (neoForgeRuntimeError && !benignPalworldStderr) {
      if (entry) {
        entry.failureReason = neoForgeRuntimeError.code;
        entry.failureDetails = neoForgeRuntimeError.details;
        entry.failureMessage = neoForgeRuntimeError.message;
        entry.suppressRestart = true;
      }
      appendLog(config.id, "stderr", neoForgeRuntimeError.message).catch(() => {});
    }
    if (!benignPalworldStderr && /invalid option|usage:|cannot execute|No such file or directory|not found/i.test(text)) {
      if (entry) {
        entry.failureReason = entry.failureReason || "INVALID_COMMAND";
        if (/invalid option|usage:/i.test(text)) {
          entry.suppressRestart = true;
        }
      }
    }
    if (isFiveMInstance(config) && FIVEM_LICENSE_FAILURE_PATTERN.test(text)) {
      const entry = runningProcesses.get(config.id);
      if (entry) {
        entry.suppressRestart = true;
        entry.failureReason = "FIVEM_LICENSE_REQUIRED";
      }
    }
  });

  child.on("exit", (exitCode, signal) => {
    const entry = runningProcesses.get(config.id);
    if (!entry || entry.child !== child) {
      console.info("[Instances] Ignoring stale instance process exit.", {
        instanceId: config.id,
        pid: child.pid || null,
        exitCode,
        signal,
        activePid: entry?.child?.pid || null,
      });
      return;
    }
    const requestedStop = entry?.requestedStop || false;
    const suppressRestart = entry?.suppressRestart || false;
    const failureReason = entry?.failureReason || "PROCESS_EXITED";
    const invalidCommandExit = isInvalidCommandExit(config, exitCode, failureReason);
    const runtimeMs = entry?.startedAt ? Date.now() - entry.startedAt : 0;
    const earlyCleanExit = !requestedStop && Number(exitCode) === 0 && runtimeMs > 0 && runtimeMs < STARTUP_EARLY_EXIT_MS;

    if (entry?.startupTimer) {
      clearTimeout(entry.startupTimer);
    }

    const failed = !requestedStop && (exitCode !== 0 || earlyCleanExit);
    const resolvedFailureReason = earlyCleanExit
      ? "EARLY_CLEAN_EXIT"
      : failed ? failureReason : null;

    discoverDetachedRuntime(config).then(async (runtime) => {
      if (runtime && !requestedStop) {
        const updated = await adoptDiscoveredRuntime(config, runtime, { reason: "wrapper-exit" });
        console.info("[Instances] Reconciled detached instance runtime after wrapper exit.", {
          instanceId: config.id,
          wrapperPid: child.pid || null,
          runtimePid: runtime.pid,
          runtimePpid: runtime.ppid || null,
          ports: runtime.ports || [],
        });
        appendLog(config.id, "stdout", `Reconciled detached runtime PID: ${runtime.pid}`).catch(() => {});
        if (entry?.startupTimer) {
          clearTimeout(entry.startupTimer);
        }
        if (entry?.discoveryTimer) {
          clearInterval(entry.discoveryTimer);
        }
        runningProcesses.delete(config.id);
        return updated;
      }

      runningProcesses.delete(config.id);
      metricsSamples.delete(config.id);
      return updateRuntimeState(config.id, {
      state: failed ? INSTANCE_STATES.FAILED : INSTANCE_STATES.STOPPED,
      pid: null,
      exitCode,
      signal,
      failureReason: resolvedFailureReason,
      failureDetails: entry?.failureDetails || null,
      readinessState: failed ? "failed" : "stopped",
      healthState: failed ? "crashed" : "unknown",
      lastStoppedAt: nowIso(),
      });
    }).then(async (updatedConfig) => {
      if (updatedConfig?.state === INSTANCE_STATES.RUNNING && updatedConfig?.pid) {
        return;
      }
      const stopReason = earlyCleanExit
        ? "Server exited immediately; this modpack may be client-only or missing server files."
        : entry?.failureMessage && failed ? entry.failureMessage
        : `Stopped ${updatedConfig.displayName} exitCode=${exitCode ?? "null"} signal=${signal || "null"}`;
      console.info("[Instances] Instance process exited.", {
        instanceId: config.id,
        pid: child.pid || null,
        exitCode,
        signal,
        runtimeMs,
        requestedStop,
        failed,
        failureReason: resolvedFailureReason,
        command: entry?.commandDiagnostics?.command || commandForLog,
        workingDirectory: entry?.commandDiagnostics?.workingDirectory || workingDirectory,
        javaVersion: entry?.commandDiagnostics?.javaVersion || javaVersion,
        eulaStatus: entry?.commandDiagnostics?.eulaStatus || eulaStatus,
        outputTail: entry?.outputTail || [],
      });
      appendLog(config.id, failed ? "stderr" : "stdout", stopReason).catch(() => {});
      if (earlyCleanExit && entry?.outputTail?.length) {
        const tailLines = entry.outputTail.map((line) => `[${line.stream}] ${line.message}`).join("\n");
        appendLog(config.id, "stderr", `Last ${Math.min(PROCESS_TAIL_LINE_LIMIT, entry.outputTail.length)} output lines before early exit:\n${tailLines}`).catch(() => {});
      }

      if (invalidCommandExit) {
        appendLog(config.id, "stderr", "Auto-restart disabled after invalid command exit.").catch(() => {});
      }

      if (failed && !suppressRestart && !invalidCommandExit && !earlyCleanExit && (updatedConfig.restartPolicy === "always" || updatedConfig.restartPolicy === "on-failure")) {
        const backoff = getRestartBackoffDecision(config.id, { immediateExit: runtimeMs > 0 && runtimeMs < STARTUP_EARLY_EXIT_MS });
        if (backoff.allowed) {
          appendLog(config.id, "stderr", `Auto-restart scheduled in ${Math.round(backoff.delayMs / 1000)}s after failure ${backoff.failures || 1}.`).catch(() => {});
          scheduleAutomaticRestart(config.id, backoff.delayMs);
        } else {
          await updateRuntimeState(config.id, {
            state: INSTANCE_STATES.FAILED,
            pid: null,
            failureReason: "CRASH_LOOP",
            restartFailures: backoff.failures,
            crashLoopDetectedAt: nowIso(),
          });
          appendLog(config.id, "stderr", `Auto-restart disabled after ${backoff.failures} immediate failures. Manual Start will reset retries.`).catch(() => {});
        }
      } else if (!failed && !suppressRestart && !invalidCommandExit && updatedConfig.restartPolicy === "always" && !requestedStop) {
        const backoff = getRestartBackoffDecision(config.id, { immediateExit: runtimeMs > 0 && runtimeMs < STARTUP_EARLY_EXIT_MS });
        if (backoff.allowed) {
          appendLog(config.id, "stderr", `Auto-restart scheduled in ${Math.round(backoff.delayMs / 1000)}s after exit ${backoff.failures || 1}.`).catch(() => {});
          scheduleAutomaticRestart(config.id, backoff.delayMs);
        } else {
          await updateRuntimeState(config.id, {
            state: INSTANCE_STATES.FAILED,
            pid: null,
            failureReason: "CRASH_LOOP",
            restartFailures: backoff.failures,
            crashLoopDetectedAt: nowIso(),
          });
          appendLog(config.id, "stderr", `Auto-restart disabled after ${backoff.failures} immediate exits. Manual Start will reset retries.`).catch(() => {});
        }
      }
    }).catch(() => {});
  });

  const startupTimer = setTimeout(() => {
    const entry = runningProcesses.get(config.id);

    if (!isPalworldRuntimeCandidate(config) && entry?.child === child && child.exitCode === null && isProcessAlive(child.pid)) {
      updateRuntimeState(config.id, {
        state: INSTANCE_STATES.RUNNING,
        pid: child.pid,
        readinessState: "timeout",
        healthState: "degraded",
        failureReason: "READINESS_TIMEOUT",
      }).catch(() => {});
    }
  }, config.startupTimeoutMs);

  const discoveryTimer = isPalworldRuntimeCandidate(config) ? setInterval(() => {
    const entry = runningProcesses.get(config.id);
    if (!entry || entry.child !== child || entry.requestedStop) {
      clearInterval(discoveryTimer);
      return;
    }
    discoverDetachedRuntime(config).then(async (runtime) => {
      if (!runtime) {
        return;
      }
      await adoptDiscoveredRuntime(config, runtime, { reason: "post-launch-discovery" });
      appendLog(config.id, "stdout", `Discovered detached runtime PID: ${runtime.pid}`).catch(() => {});
      clearInterval(discoveryTimer);
      if (entry.startupTimer) {
        clearTimeout(entry.startupTimer);
      }
    }).catch(() => {});
  }, 1000) : null;
  discoveryTimer?.unref?.();

  const existingEntry = runningProcesses.get(config.id);
  runningProcesses.set(config.id, {
    child,
    startedAt: Date.now(),
    requestedStop: existingEntry?.requestedStop || false,
    suppressRestart: existingEntry?.suppressRestart || false,
    failureReason: existingEntry?.failureReason || null,
    startupTimer,
    discoveryTimer,
    outputTail: existingEntry?.outputTail || [],
    commandDiagnostics,
  });

  const updated = await updateRuntimeState(config.id, {
    state: INSTANCE_STATES.STARTING,
    pid: child.pid,
  });
  await appendLog(config.id, "stdout", `Process PID: ${child.pid}`);

  return publicConfig(updated);
}

async function writeInstanceInput(instanceId, input) {
  const config = await reconcileConfigState(await loadInstanceConfig(instanceId));
  const entry = runningProcesses.get(config.id);

  if (!entry?.child?.stdin || !entry.child.stdin.writable) {
    throw createInstanceError("INSTANCE_STDIN_UNAVAILABLE", 409);
  }

  const command = String(input || "");

  if (!command.trim() || command.includes("\0") || command.length > 4096) {
    throw createInstanceError("INVALID_COMMAND");
  }

  entry.child.stdin.write(command.endsWith("\n") ? command : `${command}\n`);
  await appendLog(config.id, "stdin", `> ${command.trim()}`);

  return {
    id: config.id,
    sent: true,
  };
}

async function forceKillInstance(instanceId) {
  const config = await reconcileConfigState(await loadInstanceConfig(instanceId));
  const entry = runningProcesses.get(config.id);
  const pid = entry?.child?.pid || config.pid;

  if (!pid || !isProcessAlive(pid)) {
    throw createInstanceError("INSTANCE_NOT_RUNNING", 409);
  }

  if (entry) {
    entry.requestedStop = true;
    if (entry.discoveryTimer) {
      clearInterval(entry.discoveryTimer);
    }
    if (entry.startupTimer) {
      clearTimeout(entry.startupTimer);
    }
  }

  process.kill(pid, "SIGKILL");
  const updated = await updateRuntimeState(config.id, {
    state: INSTANCE_STATES.STOPPED,
    pid: null,
    signal: "SIGKILL",
    runtimeProcess: null,
    lastStoppedAt: nowIso(),
  });

  runningProcesses.delete(config.id);
  metricsSamples.delete(config.id);
  resetRestartBackoff(config.id);
  return publicConfig(updated);
}

function waitForPidExit(pid, timeoutMs) {
  return new Promise((resolve) => {
    if (!pid || !isProcessAlive(pid)) {
      resolve(true);
      return;
    }
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (!isProcessAlive(pid)) {
        clearInterval(timer);
        resolve(true);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        resolve(false);
      }
    }, 250);
    timer.unref?.();
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }

    const timer = setTimeout(() => resolve(false), timeoutMs);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function stopInstance(instanceId, options = {}) {
  let config = await reconcileConfigState(await loadInstanceConfig(instanceId));
  const entry = runningProcesses.get(config.id);
  const pid = entry?.child?.pid || config.pid;

  if (!pid || !isProcessAlive(pid)) {
    resetRestartBackoff(config.id);
    config = await updateRuntimeState(config.id, {
      state: INSTANCE_STATES.STOPPED,
      pid: null,
      lastStoppedAt: config.lastStoppedAt || nowIso(),
    });
    return publicConfig(config);
  }

  await updateRuntimeState(config.id, {
    state: INSTANCE_STATES.STOPPING,
  });
  await appendLog(config.id, "stdout", `Stopping ${config.displayName}`);

  if (entry) {
    entry.requestedStop = true;
    if (entry.discoveryTimer) {
      clearInterval(entry.discoveryTimer);
    }
    if (entry.startupTimer) {
      clearTimeout(entry.startupTimer);
    }
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // The reconcile path below will correct stale PIDs.
  }

  const requestedTimeout = Number(options.timeoutMs);
  const shutdownTimeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(config.shutdownTimeoutMs, requestedTimeout)
    : config.shutdownTimeoutMs;
  const exited = entry ? await waitForExit(entry.child, shutdownTimeoutMs) : await waitForPidExit(pid, shutdownTimeoutMs);

  if (!exited && isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The process may have exited between checks.
    }
  }

  config = await updateRuntimeState(config.id, {
    state: INSTANCE_STATES.STOPPED,
    pid: null,
    runtimeProcess: null,
    lastStoppedAt: nowIso(),
  });

  runningProcesses.delete(config.id);
  metricsSamples.delete(config.id);
  resetRestartBackoff(config.id);

  return publicConfig(config);
}

async function restartInstance(instanceId) {
  const config = await loadInstanceConfig(instanceId);
  await updateRuntimeState(config.id, {
    state: INSTANCE_STATES.RESTARTING,
  });
  await stopInstance(config.id);
  return startInstance(config.id);
}

async function getStatus(instanceId) {
  let config = await reconcileConfigState(await loadInstanceConfig(instanceId));
  if (isFiveMInstance(config)) {
    config = (await refreshFiveMReadiness(config.id)).config;
  }
  return publicConfigDetailed(await backfillInstanceVersion(config));
}

async function readRecentLines(filePath, lineLimit) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return content.split(/\r?\n/).filter(Boolean).slice(-lineLimit).map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return {
          at: null,
          stream: path.basename(filePath, ".log"),
          message: redactLogLine(line),
        };
      }
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw createInstanceError("LOG_UNREADABLE", 500);
  }
}

async function readLogs(instanceId, options = {}) {
  const config = await loadInstanceConfig(instanceId);
  const limit = Math.min(validatePositiveInteger(options.limit, 200, MAX_LOG_LINES), MAX_LOG_LINES);
  const stream = String(options.stream || "all");
  const streams = stream === "all" ? ["stdin", "stdout", "stderr"] : [stream];

  if (!streams.every((entry) => entry === "stdin" || entry === "stdout" || entry === "stderr")) {
    throw createInstanceError("INVALID_LOG_STREAM");
  }

  const entries = (await Promise.all(streams.map((streamName) => {
    return readRecentLines(logPath(config.id, streamName), limit);
  }))).flat();

  return {
    id: config.id,
    entries: entries.sort((left, right) => String(left.at || "").localeCompare(String(right.at || ""))).slice(-limit),
  };
}

async function clearLogs(instanceId, options = {}) {
  const config = await loadInstanceConfig(instanceId);
  const stream = String(options.stream || "all");
  const streams = stream === "all" ? ["stdin", "stdout", "stderr"] : [stream];

  if (!streams.every((entry) => entry === "stdin" || entry === "stdout" || entry === "stderr")) {
    throw createInstanceError("INVALID_LOG_STREAM");
  }

  await Promise.all(streams.map((streamName) => fs.writeFile(logPath(config.id, streamName), "", { mode: 0o600 }).catch(() => {})));
  return {
    id: config.id,
    cleared: streams,
  };
}

async function listInstanceFiles(instanceId, requestedPath = ".") {
  const config = await loadInstanceConfig(instanceId);
  const resolved = resolveInstanceDataPath(config.id, requestedPath);
  await assertNoInstanceDataEscape(resolved);
  const stats = await fs.stat(resolved.path).catch((error) => {
    if (error?.code === "ENOENT") {
      throw createInstanceError("PATH_NOT_FOUND", 404);
    }

    throw createInstanceError("PATH_UNAVAILABLE", 400);
  });

  if (!stats.isDirectory()) {
    throw createInstanceError("PATH_NOT_DIRECTORY");
  }

  const entries = await fs.readdir(resolved.path, { withFileTypes: true });
  const normalizedEntries = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(resolved.path, entry.name);
    const entryStats = await fs.lstat(entryPath).catch(() => null);
    const entryType = entryStats?.isSymbolicLink()
      ? "symlink"
      : entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : "other";

    return {
      name: entry.name,
      path: path.relative(resolved.root, entryPath) || ".",
      type: entryType,
      isDirectory: entryType === "directory",
      size: entryType === "file" ? entryStats?.size ?? null : null,
      modifiedAt: entryStats?.mtime?.toISOString?.() || null,
    };
  }));

  return {
    id: config.id,
    currentPath: resolved.relativePath,
    entries: normalizedEntries.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }

      return left.name.localeCompare(right.name);
    }),
  };
}

async function readInstanceFile(instanceId, requestedPath) {
  const config = await loadInstanceConfig(instanceId);
  const resolved = resolveInstanceDataPath(config.id, requestedPath);
  await assertNoInstanceDataEscape(resolved);
  const stats = await fs.stat(resolved.path).catch((error) => {
    if (error?.code === "ENOENT") {
      throw createInstanceError("PATH_NOT_FOUND", 404);
    }

    throw createInstanceError("PATH_UNAVAILABLE", 400);
  });

  if (!stats.isFile()) {
    throw createInstanceError("PATH_NOT_FILE");
  }

  if (stats.size > 1024 * 1024) {
    return {
      id: config.id,
      path: resolved.relativePath,
      supported: false,
      reason: "file_too_large",
      content: "",
    };
  }

  return {
    id: config.id,
    path: resolved.relativePath,
    supported: true,
    content: await fs.readFile(resolved.path, "utf8"),
  };
}

async function instanceFileExists(instanceId, requestedPath) {
  const config = await loadInstanceConfig(instanceId);
  const resolved = resolveInstanceDataPath(config.id, requestedPath);
  await assertNoInstanceDataEscape(resolved);
  const stats = await fs.stat(resolved.path).catch((error) => {
    if (error?.code === "ENOENT") {
      return null;
    }

    throw createInstanceError("PATH_UNAVAILABLE", 400);
  });

  return {
    id: config.id,
    path: resolved.relativePath,
    exists: Boolean(stats),
    type: stats ? (stats.isDirectory() ? "directory" : stats.isFile() ? "file" : "other") : null,
    size: stats?.size ?? null,
    modifiedAt: stats?.mtime?.toISOString?.() || null,
  };
}

async function writeInstanceFile(instanceId, requestedPath, content, options = {}) {
  const config = await loadInstanceConfig(instanceId);
  const resolved = resolveInstanceDataPath(config.id, requestedPath);
  await assertNoInstanceDataEscape(resolved, { forWrite: true });
  const encoding = options && options.encoding === "base64" ? "base64" : "utf8";
  const payload = encoding === "base64"
    ? Buffer.from(String(content || ""), "base64")
    : String(content ?? "");
  await fs.mkdir(path.dirname(resolved.path), { recursive: true });
  await atomicWriteManagedFile(resolved.path, payload, encoding === "base64" ? {} : { encoding: "utf8" });
  if (/\.(jar|json|properties)$/i.test(resolved.relativePath) || /metadata\.json|install_profile\.json|version\.json/i.test(resolved.relativePath)) {
    await saveInstanceConfig({
      ...config,
      versionCacheVersion: null,
      detectedVersionAt: null,
      updatedAt: nowIso(),
    }).catch(() => {});
  }
  if (isFiveMInstance(config) && resolved.relativePath === FIVEM_CONFIG_RELATIVE_PATH) {
    await refreshFiveMReadiness(config.id).catch(() => {});
  }
  return {
    id: config.id,
    path: resolved.relativePath,
    saved: true,
  };
}

async function createInstanceFolder(instanceId, requestedPath) {
  const config = await loadInstanceConfig(instanceId);
  const resolved = resolveInstanceDataPath(config.id, requestedPath);
  await assertNoInstanceDataEscape(resolved, { forWrite: true });
  await fs.mkdir(resolved.path, { recursive: true });
  return {
    id: config.id,
    path: resolved.relativePath,
    created: true,
  };
}

async function renameInstanceFile(instanceId, fromPath, toPath) {
  const config = await loadInstanceConfig(instanceId);
  const from = resolveInstanceDataPath(config.id, fromPath);
  const to = resolveInstanceDataPath(config.id, toPath);
  await assertNoInstanceDataEscape(from);
  await assertNoInstanceDataEscape(to, { forWrite: true });
  await fs.mkdir(path.dirname(to.path), { recursive: true });
  await fs.rename(from.path, to.path);
  return {
    id: config.id,
    oldPath: from.relativePath,
    path: to.relativePath,
    renamed: true,
  };
}

async function deleteInstanceFile(instanceId, requestedPath) {
  const config = await loadInstanceConfig(instanceId);
  const resolved = resolveInstanceDataPath(config.id, requestedPath);
  await assertNoInstanceDataEscape(resolved);

  if (resolved.relativePath === ".") {
    throw createInstanceError("PATH_NOT_ALLOWED", 403);
  }

  await fs.rm(resolved.path, { recursive: true, force: true });
  return {
    id: config.id,
    path: resolved.relativePath,
    deleted: true,
  };
}

function parseProperties(content) {
  return String(content || "").split(/\r?\n/).reduce((properties, line) => {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      return properties;
    }

    const index = trimmed.indexOf("=");

    if (index > 0) {
      properties[trimmed.slice(0, index)] = trimmed.slice(index + 1);
    }

    return properties;
  }, {});
}

function serializeProperties(properties) {
  return Object.entries(properties || {})
    .filter(([key]) => /^[a-z0-9_.-]+$/i.test(key))
    .map(([key, value]) => `${key}=${String(value ?? "")}`)
    .join("\n");
}

async function readMinecraftProperties(instanceId) {
  const config = await readGameServerConfig(instanceId, { adapterId: "minecraft" });
  return {
    id: validateInstanceId(instanceId),
    path: config.filePath || "server.properties",
    properties: stringifyProperties(config.values || {}),
    sourceHash: config.sourceHash,
  };
}

async function writeMinecraftProperties(instanceId, properties) {
  const existing = await readMinecraftProperties(instanceId);
  const saved = await writeGameServerConfig(instanceId, {
    adapterId: "minecraft",
    sourceHash: existing.sourceHash,
    values: properties && typeof properties === "object" && !Array.isArray(properties) ? properties : {},
  });

  return {
    id: validateInstanceId(instanceId),
    path: saved.filePath || "server.properties",
    properties: stringifyProperties(saved.values || {}),
    saved: true,
  };
}

function stringifyProperties(properties = {}) {
  return Object.entries(properties).reduce((output, [key, value]) => {
    output[key] = Array.isArray(value) ? value.join(",") : String(value ?? "");
    return output;
  }, {});
}

function normalizeInstanceDataRelativePath(value, fallback) {
  const raw = String(value || fallback || "").replace(/\\/g, "/").replace(/^\/+/, "");
  return raw.replace(/^data\/+/i, "").replace(/\/+$/, "") || ".";
}

function toApiRelativePath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function getPalworldInstallDirectory(config = {}) {
  const explicit = config.steamInstallDir || config.installDir || config.serverInstallDir;
  if (explicit) return normalizeInstanceDataRelativePath(explicit, "server");

  const workingDirectory = normalizeInstanceDataRelativePath(config.workingDirectory, "");
  if (workingDirectory && workingDirectory !== ".") return workingDirectory;

  const argText = Array.isArray(config.args) ? config.args.join(" ") : "";
  const match = argText.match(/(?:^|\s)(?:\.\/)?([^"'`\s]+)\/PalServer\.(?:sh|exe)\b/i);
  if (match) return normalizeInstanceDataRelativePath(match[1], "server");

  return "server";
}

function getPalworldPlatformOrder(config = {}) {
  const searchable = [
    config.platform,
    config.os,
    config.executable,
    ...(Array.isArray(config.args) ? config.args : []),
  ].join(" ").toLowerCase();

  if (searchable.includes("window") || searchable.includes(".exe")) {
    return ["WindowsServer", "LinuxServer"];
  }
  return ["LinuxServer", "WindowsServer"];
}

function getPalworldConfigCandidates(config = {}) {
  const installDirectory = getPalworldInstallDirectory(config);
  return getPalworldPlatformOrder(config).map((platformName) => (
    normalizeInstanceDataRelativePath(`${installDirectory}/Pal/Saved/Config/${platformName}/PalWorldSettings.ini`)
  ));
}

async function resolveExistingGameConfigPath(config, adapterId) {
  if (adapterId === "minecraft") {
    for (const requestedPath of ["server.properties", "server/server.properties"]) {
      const resolved = resolveInstanceDataPath(config.id, requestedPath);
      await assertNoInstanceDataEscape(resolved);
      const stats = await fs.stat(resolved.path).catch(() => null);
      if (stats?.isFile()) {
        return { ...resolved, exists: true, candidates: ["server.properties", "server/server.properties"] };
      }
    }
    return { ...resolveInstanceDataPath(config.id, "server.properties"), exists: false, candidates: ["server.properties", "server/server.properties"] };
  }

  if (adapterId === "palworld") {
    const candidates = getPalworldConfigCandidates(config);
    for (const requestedPath of candidates) {
      const resolved = resolveInstanceDataPath(config.id, requestedPath);
      await assertNoInstanceDataEscape(resolved);
      const stats = await fs.stat(resolved.path).catch(() => null);
      if (stats?.isFile()) {
        return { ...resolved, exists: true, candidates };
      }
    }
    return { ...resolveInstanceDataPath(config.id, candidates[0]), exists: false, candidates };
  }

  throw createInstanceError("UNSUPPORTED_GAME_CONFIG", 404);
}

function inferConfigAdapterId(config = {}, requestedAdapterId = null) {
  if (requestedAdapterId && getAdapter(requestedAdapterId)) return requestedAdapterId;
  const family = inferGameFamily(config);
  if (family === "minecraft") return "minecraft";
  if (family === "palworld") return "palworld";
  return null;
}

function getDefaultGameConfigContent(adapter) {
  if (!adapter) return "";
  const values = adapter.fields.reduce((output, fieldMeta) => {
    output[fieldMeta.key] = fieldMeta.defaultValue;
    return output;
  }, {});
  const document = adapter.format === "palworld-options"
    ? { prefix: "[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(", suffix: ")\n", entries: [] }
    : { entries: [], trailingNewline: true };
  return serializeDocument(adapter, document, values);
}

async function readGameServerConfig(instanceId, options = {}) {
  const config = await loadInstanceConfig(instanceId);
  const adapterId = inferConfigAdapterId(config, options.adapterId);
  const adapter = getAdapter(adapterId);

  if (!adapter) {
    return {
      id: config.id,
      supported: false,
      reason: "unsupported_game",
      message: "This instance does not have a supported game configuration adapter yet.",
    };
  }

  const resolved = await resolveExistingGameConfigPath(config, adapter.id);
  await assertNoInstanceDataEscape(resolved, { forWrite: true });
  const stats = resolved.exists ? await fs.stat(resolved.path) : null;
  const content = resolved.exists
    ? await fs.readFile(resolved.path, "utf8")
    : getDefaultGameConfigContent(adapter);
  return {
    id: config.id,
    ...buildConfigModel(adapter.id, content, {
      filePath: toApiRelativePath(resolved.relativePath),
      modifiedAt: stats?.mtime?.toISOString?.() || null,
      missing: !resolved.exists,
    }),
    candidates: resolved.candidates,
  };
}

async function createGameConfigBackup(config, resolved) {
  const stats = await fs.stat(resolved.path).catch(() => null);
  if (!stats?.isFile()) return null;

  const backupRoot = resolveInstanceDataPath(config.id, ".anxos-config-backups");
  await assertNoInstanceDataEscape(backupRoot, { forWrite: true });
  await fs.mkdir(backupRoot.path, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const safeName = resolved.relativePath.replace(/[\\/]+/g, "__").replace(/[^a-z0-9_.-]/gi, "_");
  const backupRelativePath = normalizeInstanceDataRelativePath(`.anxos-config-backups/${safeName}.${stamp}.bak`);
  const backup = resolveInstanceDataPath(config.id, backupRelativePath);
  await assertNoInstanceDataEscape(backup, { forWrite: true });
  await fs.copyFile(resolved.path, backup.path);
  return backup.relativePath;
}

async function writeGameServerConfig(instanceId, payload = {}) {
  const config = await loadInstanceConfig(instanceId);
  const adapterId = inferConfigAdapterId(config, payload.adapterId);
  const adapter = getAdapter(adapterId);

  if (!adapter) {
    throw createInstanceError("UNSUPPORTED_GAME_CONFIG", 404);
  }

  const resolved = await resolveExistingGameConfigPath(config, adapter.id);
  await assertNoInstanceDataEscape(resolved, { forWrite: true });
  const exists = Boolean(await fs.stat(resolved.path).catch(() => null));
  const currentContent = exists ? await fs.readFile(resolved.path, "utf8") : getDefaultGameConfigContent(adapter);
  const currentHash = hashContent(currentContent);

  if (payload.sourceHash && payload.sourceHash !== currentHash) {
    throw createInstanceError("CONFIG_MODIFIED_EXTERNALLY", 409);
  }

  const merged = mergeSubmittedValues(adapter, currentContent, payload.values || {});
  if (!merged.validation.ok) {
    const error = createInstanceError("CONFIG_VALIDATION_FAILED", 400);
    error.validation = merged.validation.errors;
    throw error;
  }

  const backupPath = await createGameConfigBackup(config, resolved);
  const nextContent = serializeDocument(adapter, merged.document, merged.values);
  await fs.mkdir(path.dirname(resolved.path), { recursive: true });
  await atomicWriteManagedFile(resolved.path, nextContent, { encoding: "utf8" });

  let restartResult = null;
  if (payload.restart === true) {
    restartResult = await restartInstance(config.id);
  }

  return {
    id: config.id,
    adapterId: adapter.id,
    filePath: toApiRelativePath(resolved.relativePath),
    saved: true,
    backupPath: backupPath ? toApiRelativePath(backupPath) : null,
    sourceHash: hashContent(nextContent),
    restartRequired: adapter.fields.some((fieldMeta) => fieldMeta.restartRequired && Object.prototype.hasOwnProperty.call(payload.values || {}, fieldMeta.key)),
    restarted: Boolean(restartResult),
    restartResult,
    values: buildConfigModel(adapter.id, nextContent, { filePath: toApiRelativePath(resolved.relativePath) }).values,
  };
}

function readProcStat(pid) {
  try {
    const stat = fsSync.readFileSync(`/proc/${pid}/stat`, "utf8");
    const parts = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return {
      utime: Number.parseInt(parts[11], 10) || 0,
      stime: Number.parseInt(parts[12], 10) || 0,
      rssPages: Number.parseInt(parts[21], 10) || 0,
    };
  } catch {
    return null;
  }
}

function readTotalCpuTicks() {
  try {
    const firstLine = fsSync.readFileSync("/proc/stat", "utf8").split(/\r?\n/)[0];
    return firstLine.split(/\s+/).slice(1).reduce((total, value) => total + (Number.parseInt(value, 10) || 0), 0);
  } catch {
    return null;
  }
}

async function getDirectorySizeBytes(rootPath) {
  let total = 0;

  async function walk(currentPath) {
    let entries;

    try {
      entries = await fs.readdir(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const entryPath = path.join(currentPath, entry.name);

      try {
        const stats = await fs.stat(entryPath);
        total += stats.size;

        if (entry.isDirectory()) {
          await walk(entryPath);
        }
      } catch {
        // Skip files that disappear while metrics are collected.
      }
    }
  }

  await walk(rootPath);
  return total;
}

function checkPort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const done = (open) => {
      socket.destroy();
      resolve({
        port,
        open,
      });
    };

    socket.setTimeout(PORT_CONNECT_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function getMetrics(instanceId) {
  const config = await reconcileConfigState(await loadInstanceConfig(instanceId));
  const pid = config.pid && isProcessAlive(config.pid) ? config.pid : null;
  const procStat = pid ? readProcStat(pid) : null;
  const totalCpuTicks = pid ? readTotalCpuTicks() : null;
  const previousSample = metricsSamples.get(config.id);
  const processTicks = procStat ? procStat.utime + procStat.stime : null;
  let cpuPercent = null;

  if (previousSample && processTicks !== null && totalCpuTicks !== null) {
    const processDelta = processTicks - previousSample.processTicks;
    const totalDelta = totalCpuTicks - previousSample.totalCpuTicks;

    if (totalDelta > 0) {
      cpuPercent = Math.max(0, (processDelta / totalDelta) * os.cpus().length * 100);
    }
  }

  if (processTicks !== null && totalCpuTicks !== null) {
    metricsSamples.set(config.id, {
      processTicks,
      totalCpuTicks,
      sampledAt: Date.now(),
    });
  }

  const startedAt = config.lastStartedAt ? Date.parse(config.lastStartedAt) : null;

  return {
    id: config.id,
    state: config.state,
    pid,
    uptimeSeconds: pid && startedAt ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0,
    cpuPercent,
    cpuSeconds: processTicks === null ? null : processTicks / PROC_STAT_TICKS_PER_SECOND,
    memoryRssBytes: procStat ? procStat.rssPages * PAGE_SIZE_BYTES : null,
    diskBytes: await getDirectorySizeBytes(instancePath(config.id)),
    ports: await Promise.all((config.ports || []).map(checkPort)),
  };
}

module.exports = {
  _test: {
    configuredRuntimePorts,
    atomicWriteManagedFile,
    discoverDetachedRuntime,
    evaluateFiveMReadiness,
    findUnrelatedPortConflicts,
    getPalworldConfigCandidates,
    getFiveMLicenseReason,
    updateFiveMLicenseInConfig,
    inferConfigAdapterId,
    resolveExistingGameConfigPath,
    parseRandomSeedFromLevelDat,
    parseTpsFromMessages,
    normalizeShellWrapperArgs,
    formatCommandForLog,
    isBenignPalworldStderrOutput,
    getRestartBackoffDecision,
    getResourceCounts() {
      return {
        restartTimers: restartTimers.size,
        versionRefreshTimers: versionRefreshTimers.size,
        runningProcesses: runningProcesses.size,
      };
    },
    resetRestartBackoff,
    scheduleAutomaticRestart,
    setProcessInspectionProvider(provider) {
      processInspectionProvider = typeof provider === "function" ? provider : null;
    },
    setProcessAliveProvider(provider) {
      processAliveProvider = typeof provider === "function" ? provider : null;
    },
  },
  configureInstanceService,
  disposeInstanceService,
  shutdownInstanceService,
  INSTANCE_STATES,
  INSTANCE_CONFIG_SCHEMA_VERSION,
  INSTANCE_TYPES: [...INSTANCE_TYPES],
  createInstance,
  duplicateInstance,
  deleteInstance,
  forgetInstance,
  clearLogs,
  beginInstallationSession,
  beginSteamCmdUpdateSession,
  repairLegacySteamCmdMetadata,
  cancelInstallationSession,
  closeInstallationSession,
  createInstanceFolder,
  deleteInstanceFile,
  forceKillInstance,
  getMetrics,
  readGameServerConfig,
  getStatus,
  executeInstallationPhase,
  executeSteamCmdUpdate,
  instanceFileExists,
  listInstanceFiles,
  listInstances,
  readInstanceFile,
  readLogs,
  recoverIncompleteInstallations,
  readMinecraftProperties,
  refreshFiveMReadiness,
  renameInstance,
  renameInstanceFile,
  restartInstance,
  saveFiveMLicenseKey,
  startInstance,
  stopInstance,
  updateInstance,
  writeInstanceFile,
  writeGameServerConfig,
  writeInstanceInput,
  writeMinecraftProperties,
};
