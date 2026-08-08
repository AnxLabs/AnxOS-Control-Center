const { spawn, execFile } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { app, shell } = require("electron");
const agentClient = require("./agentClient");
const { getAllNodesSync, getNode, getNodeAgentConfig, getSelectedNodeId, listNodes, recordAuthenticatedNodeHealth } = require("./nodeService");
const diagnostics = require("./diagnosticsService");
const { AGENT_STATUS, classifyAgentError, createAgentStatusSnapshot } = require("../shared/agentStatus");
const { readAgentRuntimeConfig, restoreAgentRuntimeConfig, saveAgentRuntimeConfig } = require("../shared/agentRuntimeConfigStore");
const { getReleaseInfo } = require("../shared/releaseConfig");
const {
  getBundledLocalAgentRuntime,
  getBundledLocalAgentVersion,
  getPublicLocalAgentRuntimeInfo,
} = require("./localAgentRuntimeService");
const { testConnection } = require("./agentClient");
const {
  WINDOWS_AGENT_TASK_NAME,
  buildWindowsAgentTaskDefinition,
  buildWindowsTaskInspectionScript,
  buildWindowsTaskRegistrationScript,
  compareWindowsAgentTask,
  getCurrentWindowsUser,
} = require("../shared/windowsAgentScheduledTask");
const {
  pairLocalAgent,
  readLocalAgentPairingStatus,
  restoreLocalAgentCredential,
  rotateLocalAgentCredentials,
  snapshotLocalAgentCredential,
} = require("./localAgentPairingService");

const SERVICE_NAME = WINDOWS_AGENT_TASK_NAME;
const LOCAL_AGENT_DISPLAY_NAME = "This PC";
const REMOTE_DIAGNOSTICS_CACHE_MS = 30000;
let managedProcess = null;
let operationInFlight = null;
let lastRestartReason = null;
let lastError = null;
let lastInstallSteps = [];
const remoteDiagnosticsRequests = new Map();
const remoteDiagnosticsCache = new Map();

function compareVersions(left, right) {
  const parse = (value) => String(value || "0").split(/[.-]/).map((part) => Number.parseInt(part, 10)).map((part) => Number.isFinite(part) ? part : 0);
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length, 3);
  for (let index = 0; index < length; index += 1) {
    const diff = (a[index] || 0) - (b[index] || 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

function getConfigDirectory() { if (process.env.ANXHUB_CONFIG_DIR) return process.env.ANXHUB_CONFIG_DIR; try { return path.join(app.getPath("userData"), "config"); } catch { return path.join(process.cwd(), "config"); } }
function getRuntimeConfigPath() { return path.join(getConfigDirectory(), "agent-runtime.json"); }
function getAgentDataDirectory() { try { return path.join(app.getPath("userData"), "agent"); } catch { return path.join(path.dirname(getConfigDirectory()), "agent"); } }
function getAgentLogsDirectory() { return path.join(getAgentDataDirectory(), "logs"); }
function getAgentInstancesDirectory() { return path.join(getAgentDataDirectory(), "instances"); }
function getAgentBackupsDirectory() { return path.join(getAgentDataDirectory(), "backups"); }
function getAgentTempDirectory() { return path.join(getAgentDataDirectory(), "tmp"); }
function getAgentUpdateDirectory() { return path.join(getAgentDataDirectory(), "updates"); }
function getAgentScript() { return getBundledLocalAgentRuntime().agentScript; }
function getAppRoot() { return getBundledLocalAgentRuntime().workingDirectory; }
function defaults() { return { name: `${os.hostname()} Agent`, host: "127.0.0.1", port: 47131, allowedOrigins: [], allowedFolders: [os.homedir(), getAgentInstancesDirectory(), getAgentBackupsDirectory()], storageRoots: [getAgentInstancesDirectory(), getAgentBackupsDirectory()], autoStart: false, updateChannel: "stable", loggingLevel: "info", connectionTimeoutMs: 10000, heartbeatIntervalMs: 5000, restartPolicy: "on-failure", ownerMachine: true, accountAssociation: null }; }
function readConfig() { return readAgentRuntimeConfig(getRuntimeConfigPath(), { defaults: defaults() }); }
function validateConfig(input = {}) {
  const value = { ...defaults(), ...input };
  value.name = String(value.name || "").trim().slice(0, 80);
  value.host = String(value.host || "127.0.0.1").trim();
  value.port = Number(value.port);
  if (!value.name) throw Object.assign(new Error("Agent name is required."), { code: "AGENT_NAME_REQUIRED" });
  if (!/^(127\.0\.0\.1|0\.0\.0\.0|localhost|::1)$/i.test(value.host)) throw Object.assign(new Error("Listening address must be local or all interfaces."), { code: "AGENT_HOST_INVALID" });
  if (!Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) throw Object.assign(new Error("Port must be between 1024 and 65535."), { code: "AGENT_PORT_INVALID" });
  for (const key of ["allowedOrigins", "allowedFolders", "storageRoots"]) value[key] = [...new Set((Array.isArray(value[key]) ? value[key] : []).map((entry) => String(entry).trim()).filter(Boolean))].slice(0, 50);
  value.connectionTimeoutMs = Math.min(120000, Math.max(1000, Number(value.connectionTimeoutMs) || 10000));
  value.heartbeatIntervalMs = Math.min(60000, Math.max(1000, Number(value.heartbeatIntervalMs) || 5000));
  if (!["stable", "beta"].includes(value.updateChannel)) value.updateChannel = "stable";
  if (!["error", "warn", "info", "debug"].includes(value.loggingLevel)) value.loggingLevel = "info";
  if (!["never", "on-failure", "always"].includes(value.restartPolicy)) value.restartPolicy = "on-failure";
  return value;
}
function saveConfig(input) { const value = saveAgentRuntimeConfig(getRuntimeConfigPath(), validateConfig(input)); diagnostics.log("info", "agent-control", "configuration-save", "Agent configuration saved", { host: value.host, port: value.port, folders: value.allowedFolders.length }, { file: "service-manager" }); return value; }
function restoreConfigBackup() { return restoreAgentRuntimeConfig(getRuntimeConfigPath(), validateConfig); }
function resetConfig() { return saveConfig(defaults()); }

function command(command, args, options = {}) { return new Promise((resolve) => execFile(command, args, { windowsHide: true, timeout: options.timeout || 15000, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => resolve({ ok: !error, code: error?.code || null, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() }))); }
function quotePowerShellValue(value) { return `'${String(value ?? "").replace(/'/g, "''")}'`; }
function ensureManagedAgentDirectories() {
  const directories = [
    getConfigDirectory(),
    getAgentDataDirectory(),
    getAgentLogsDirectory(),
    getAgentInstancesDirectory(),
    getAgentBackupsDirectory(),
    getAgentTempDirectory(),
    getAgentUpdateDirectory(),
  ];
  directories.forEach((directory) => fs.mkdirSync(directory, { recursive: true }));
  return directories;
}

function agentEnvironment(config) {
  const runtime = getBundledLocalAgentRuntime();
  return { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_ENV: "production", AGENT_HOST: config.host, AGENT_PORT: String(config.port), AGENT_FILE_ROOTS: config.allowedFolders.join(path.delimiter), AGENT_INSTANCE_ROOT: getAgentInstancesDirectory(), AGENT_BACKUP_ROOT: getAgentBackupsDirectory(), AGENT_LOG_DIR: getAgentLogsDirectory(), AGENT_TEMP_DIR: getAgentTempDirectory(), AGENT_IDENTITY_PATH: path.join(getAgentDataDirectory(), "device-identity.json"), ANXHUB_CONFIG_DIR: getConfigDirectory(), ANXOS_LOCAL_AGENT_RUNTIME_ROOT: runtime.runtimeRoot, ANXOS_LOCAL_AGENT_RUNTIME_MANIFEST: runtime.manifestPath };
}
function isWindowsAccessDenied(result = {}) { return /access is denied|administrator|elevat/i.test(`${result.stderr || ""}\n${result.stdout || ""}\n${result.code || ""}`); }

function parseWindowsNetstatListener(stdout = "", port = 47131) {
  const wanted = String(port);
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || !/^TCP$/i.test(parts[0]) || !/^LISTENING$/i.test(parts[3])) continue;
    const localAddress = parts[1] || "";
    if (!localAddress.replace(/\[|\]/g, "").endsWith(`:${wanted}`)) continue;
    const pid = Number.parseInt(parts[4], 10);
    if (Number.isInteger(pid) && pid > 0) return { pid, localAddress, protocol: parts[0], state: parts[3] };
  }
  return null;
}

async function getWindowsListeningProcess(port = readConfig().port) {
  if (process.platform !== "win32") return null;
  const netstat = await command("netstat.exe", ["-ano", "-p", "tcp"], { timeout: 10000 });
  if (!netstat.ok) return { port, verified: false, error: { code: netstat.code || "NETSTAT_FAILED", message: netstat.stderr || netstat.stdout || "Could not inspect listening processes." } };
  const listener = parseWindowsNetstatListener(netstat.stdout, port);
  if (!listener) return { port, listening: false, verified: false };
  const processScript = `Get-CimInstance Win32_Process -Filter "ProcessId=${listener.pid}" | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  const details = await command("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", processScript], { timeout: 10000 });
  let processInfo = null;
  try { processInfo = details.stdout ? JSON.parse(details.stdout) : null; } catch {}
  return {
    ...listener,
    port,
    listening: true,
    verified: Boolean(processInfo),
    process: processInfo ? {
      pid: Number(processInfo.ProcessId) || listener.pid,
      name: processInfo.Name || null,
      executablePath: processInfo.ExecutablePath || null,
      commandLine: processInfo.CommandLine || null,
    } : null,
    error: details.ok ? null : { code: details.code || "PROCESS_QUERY_FAILED", message: details.stderr || details.stdout || "Could not inspect listener process." },
  };
}

function isVerifiedOldLocalAgentProcess(processInfo = null, health = null) {
  if (!processInfo || !health?.ok) return false;
  const processPid = Number(processInfo.pid || processInfo.ProcessId || 0);
  const healthPid = Number(health?.process?.pid || 0);
  if (!processPid || !healthPid || processPid !== healthPid) return false;
  const commandLine = normalizeCommandForComparison(processInfo.commandLine || processInfo.CommandLine || "");
  const executablePath = normalizeCommandForComparison(processInfo.executablePath || processInfo.ExecutablePath || "");
  const runtimeRoot = normalizeCommandForComparison(getBundledLocalAgentRuntime().runtimeRoot || getAppRoot());
  const scriptPath = normalizeCommandForComparison(getAgentScript());
  const configMarker = normalizeCommandForComparison(`ANXHUB_CONFIG_DIR=${getConfigDirectory()}`);
  const looksLikeAnxOS = commandLine.includes("anxos") || executablePath.includes("anxos") || commandLine.includes(scriptPath) || commandLine.includes(runtimeRoot);
  const usesManagedConfig = commandLine.includes(configMarker) || commandLine.includes(normalizeCommandForComparison(getConfigDirectory()));
  return Boolean(looksLikeAnxOS && (usesManagedConfig || commandLine.includes(scriptPath)));
}

async function stopVerifiedOldLocalAgentProcess({ health = null, processInfo = null } = {}) {
  if (process.platform !== "win32") return { stopped: false, reason: "not-windows" };
  const verified = isVerifiedOldLocalAgentProcess(processInfo, health);
  if (!verified) {
    throw Object.assign(new Error("The process listening on the Local Agent port could not be verified as an old AnxOS Agent. It was not stopped."), {
      code: "LOCAL_AGENT_PROCESS_UNVERIFIED",
      processKind: "unknown-listener",
    });
  }
  const pid = Number(processInfo.pid || processInfo.ProcessId || 0);
  const result = await command("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { timeout: 15000 });
  if (!result.ok) throw Object.assign(new Error(result.stderr || result.stdout || "Verified old Local Agent process could not be stopped."), { code: "LOCAL_AGENT_STOP_FAILED", pid });
  return { stopped: true, pid, processKind: "verified-old-anxos-agent" };
}

async function stopVerifiedWindowsTaskAgent(config = readConfig()) {
  const listener = await getWindowsListeningProcess(config.port);
  if (!listener?.listening) return { stopped: false, reason: "not-listening" };
  const health = await agentClient.getHealth(getLocalAgentHealthConfig(config)).catch(() => null);
  return stopVerifiedOldLocalAgentProcess({ health, processInfo: listener.process });
}

async function getWindowsElevationState() {
  if (process.platform !== "win32") return { supported: false, elevated: false, state: "not-applicable" };
  const result = await command("net.exe", ["session"], { timeout: 5000 });
  if (result.ok) return { supported: true, elevated: true, state: "elevated" };
  if (isWindowsAccessDenied(result) || result.code === 2) return { supported: true, elevated: false, state: "not-elevated" };
  return { supported: true, elevated: null, state: "unverifiable", errorCode: result.code, message: result.stderr || result.stdout || "Could not verify administrator state." };
}

function expectedWindowsServiceCommand(config = readConfig()) {
  void config;
  const definition = buildWindowsAgentTaskDefinition();
  return `"${definition.executable}" ${definition.arguments}`;
}

async function inspectWindowsAgentScheduledTask() {
  const result = await command("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", buildWindowsTaskInspectionScript()], { timeout: 20000 });
  if (!result.ok) {
    return { found: false, inspectionFailed: true, errorCode: result.code || "AGENT_TASK_INSPECTION_FAILED", message: result.stderr || result.stdout || "The Agent task could not be inspected." };
  }
  try { return JSON.parse(result.stdout || '{"found":false}'); }
  catch { return { found: false, inspectionFailed: true, errorCode: "AGENT_TASK_INSPECTION_INVALID", message: "The Agent task returned invalid inspection data." }; }
}

function normalizeCommandForComparison(value) {
  return String(value || "").replace(/\s+/g, " ").replace(/\\/g, "/").replace(/"/g, "").trim().toLowerCase();
}

function getWindowsServiceBinaryPath(stdout = "") {
  const match = String(stdout || "").match(/(?:BINARY_PATH_NAME|Task To Run)\s*:\s*(.+)$/im);
  return match ? match[1].trim() : "";
}

function classifyLegacyWindowsServiceOwnership(qcOutput = "", descriptionOutput = "", binaryMetadata = {}) {
  const evidence = normalizeCommandForComparison(`${qcOutput}\n${descriptionOutput}`);
  if (!evidence || /does not exist|failed 1060/.test(evidence)) return { state: "missing", owned: false };
  const hasDisplayMarker = evidence.includes("display_name : anxos local agent") || evidence.includes("description : anxos local agent");
  const hasEntrypoint = evidence.includes("agent/src/server.js");
  const hasProductPath = evidence.includes("anxos control center") || evidence.includes("anxos-control-center") || evidence.includes("anxhub");
  const metadata = normalizeCommandForComparison(`${binaryMetadata.productName || ""} ${binaryMetadata.fileDescription || ""}`);
  const hasBinaryMarker = binaryMetadata.exists === true && metadata.includes("anxos control center");
  if (hasDisplayMarker && hasEntrypoint && hasProductPath && hasBinaryMarker) return { state: "verified-legacy", owned: true, stale: true };
  return { state: "ambiguous", owned: false, issues: [
    hasDisplayMarker ? null : "Legacy service display name or description is not an exact AnxOS Local Agent marker.",
    hasEntrypoint ? null : "Legacy service command does not contain the Agent server entrypoint.",
    hasProductPath ? null : "Legacy service command does not contain an AnxOS product path.",
    hasBinaryMarker ? null : "Legacy service executable metadata does not identify AnxOS Control Center.",
  ].filter(Boolean) };
}

async function inspectWindowsBinaryMetadata(commandLine = "") {
  const match = String(commandLine).match(/^\s*"([^"]+)"|^\s*([^\s]+)/);
  const executablePath = match?.[1] || match?.[2] || "";
  if (!executablePath) return { exists: false, executablePath: null };
  const script = `$item = Get-Item -LiteralPath ${quotePowerShellValue(executablePath)} -ErrorAction SilentlyContinue; if ($null -eq $item) { '{}' } else { @{ exists = $true; productName = $item.VersionInfo.ProductName; fileDescription = $item.VersionInfo.FileDescription } | ConvertTo-Json -Compress }`;
  const result = await command("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: 15000 });
  try { return { executablePath, ...JSON.parse(String(result.stdout || "{}").trim()) }; }
  catch { return { exists: false, executablePath }; }
}

function classifyWindowsTaskOwnership(taskOutput = "", verification = {}) {
  const snapshot = taskOutput && typeof taskOutput === "object" ? taskOutput : null;
  const evidence = normalizeCommandForComparison(snapshot ? JSON.stringify(snapshot) : taskOutput);
  if (!evidence || /cannot find|does not exist/.test(evidence)) return { state: "missing", owned: false };
  const exactName = snapshot
    ? String(snapshot.taskName || snapshot.TaskName || "").replace(/^\\/, "").toLowerCase() === SERVICE_NAME.toLowerCase()
    : /taskname:\s*\/anxosagent(?:\s|$)/.test(evidence);
  const hasEntrypoint = evidence.includes("agent/src/server.js") || evidence.includes("start-local-agent.cmd") || evidence.includes("start-local-agent.vbs") || evidence.includes("--agent");
  const hasProductPath = evidence.includes("anxos control center") || evidence.includes("anxos-control-center") || evidence.includes("anxhub");
  if (!(exactName && hasEntrypoint && hasProductPath)) return { state: "ambiguous", owned: false };
  return { state: verification.valid ? "valid-packaged" : "verified-stale", owned: true, stale: !verification.valid };
}

async function inspectLegacyWindowsService() {
  const [qc, description] = await Promise.all([
    command("sc.exe", ["qc", SERVICE_NAME], { timeout: 15000 }),
    command("sc.exe", ["qdescription", SERVICE_NAME], { timeout: 15000 }),
  ]);
  const binaryMetadata = await inspectWindowsBinaryMetadata(getWindowsServiceBinaryPath(qc.stdout));
  const classification = classifyLegacyWindowsServiceOwnership(`${qc.stdout}\n${qc.stderr}`, `${description.stdout}\n${description.stderr}`, binaryMetadata);
  return { ...classification, qc, description, binaryMetadata };
}

function getRegistrationStatusFromServiceState(service = {}) {
  if (!service.supported) return "unsupported";
  if (service.verification?.state === "unverifiable") return "unverifiable";
  if (!service.installed) return "missing";
  if (service.valid === false) return "invalid";
  return "valid";
}

function getLocalAgentStartupSummary({ running = false, service = {} } = {}) {
  const registrationStatus = getRegistrationStatusFromServiceState(service);
  const processLabel = running ? "Running" : "Stopped";
  const startupLabel = registrationStatus === "valid"
    ? "Startup Registered"
    : registrationStatus === "invalid"
      ? "Startup Registration Invalid"
      : registrationStatus === "unverifiable"
        ? "Startup Registration Unverifiable"
        : registrationStatus === "missing"
          ? "Startup Not Registered"
          : "Startup Unsupported";
  return {
    processState: processLabel,
    registrationState: registrationStatus,
    label: `${processLabel} · ${startupLabel}`,
    degradesApplicationHost: false,
    repairAction: service.supported && registrationStatus !== "valid" ? "install-service" : null,
  };
}

function ensureLocalAgentBackendSelected(config) {
  const effective = agentClient.getEffectiveAgentSettings();
  if (effective.overrides?.backendMode || effective.overrides?.agentUrl) {
    return { changed: false, reason: "environment-override" };
  }
  const localAgentUrl = getLocalAgentUrl(config);
  const currentUrl = normalizeAgentUrlForComparison(effective.agentUrl);
  const localUrl = normalizeAgentUrlForComparison(localAgentUrl);
  if (effective.backendMode === "agent" && currentUrl === localUrl) {
    return { changed: false, reason: "already-selected" };
  }
  if (effective.backendMode === "agent" && currentUrl && currentUrl !== localUrl) {
    return { changed: false, reason: "remote-agent-selected" };
  }
  const settings = agentClient.saveAgentSettings({
    backendMode: "agent",
    agentUrl: localAgentUrl,
  });
  diagnostics.log("info", "agent-control", "select-local-agent-backend", "Local Agent backend selected after starting the bundled Agent", {
    agentUrl: localAgentUrl,
    previousMode: effective.backendMode,
  }, { file: "service-manager" });
  return { changed: true, reason: "selected-local-agent", settings };
}

async function start() {
  if (operationInFlight) throw Object.assign(new Error("Another Agent operation is already running."), { code: "AGENT_OPERATION_BUSY" });
  if (managedProcess && !managedProcess.killed) return getStatus();
  operationInFlight = "start";
  try {
    const config = readConfig(); fs.mkdirSync(getAgentDataDirectory(), { recursive: true });
    const service = await getServiceState();
    const agentUrl = getLocalAgentUrl(config);
    const existingHealth = await agentClient.getHealth(getLocalAgentHealthConfig(config)).catch(() => null);
    if (existingHealth?.ok) {
      const ownership = getLocalAgentLifecycleOwnership({
        health: existingHealth,
        service,
        pairing: readLocalAgentPairingStatus(),
        managed: managedProcess,
      });
      if (ownership.type === "credential-mismatch") {
        throw Object.assign(new Error(ownership.message), {
          code: "LOCAL_AGENT_OWNERSHIP_MISMATCH",
          lifecycleOwnership: ownership,
        });
      }
      ensureLocalAgentBackendSelected(config);
      lastRestartReason = ownership.managed ? "Connected to an already running managed local Agent" : "Detected an already running unmanaged local Agent";
      lastError = null;
      diagnostics.log("info", "agent-control", "start-existing-agent", "Local Agent was already listening on the configured port", {
        agentUrl,
        pid: existingHealth?.process?.pid || null,
        ownership: ownership.type,
      }, { file: "service-manager" });
      return getStatus();
    }
    const portUsed = await probePort(config.port);
    if (portUsed && !service.active) {
      throw Object.assign(new Error(`Port ${config.port} is already in use by another process. Choose a different Agent port or stop the conflicting service.`), {
        code: "AGENT_PORT_IN_USE",
      });
    }
    if (service.installed && service.valid !== false && (process.platform !== "win32" || service.enabled !== false)) {
      const result = process.platform === "linux" ? await command("systemctl", ["--user", "start", "anxos-agent.service"]) : await command("schtasks.exe", ["/Run", "/TN", SERVICE_NAME], { timeout: 30000 });
      if (!result.ok) throw Object.assign(new Error(result.stderr || result.stdout || "Background Agent could not be started."), { code: "SERVICE_START_FAILED" });
      await waitForLocalAgentHealth(config, config.connectionTimeoutMs || 10000);
      ensureLocalAgentBackendSelected(config);
      lastRestartReason = "Background service started from AnxOS"; lastError = null; return getStatus();
    }
    const runtime = getBundledLocalAgentRuntime();
    if (!runtime.exists) {
      throw Object.assign(new Error("Bundled Local Agent runtime is missing or incomplete. Repair AnxOS Control Center, then try again."), { code: "LOCAL_AGENT_RUNTIME_MISSING" });
    }
    managedProcess = spawn(process.execPath, [getAgentScript()], { cwd: getAppRoot(), env: agentEnvironment(config), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    managedProcess.spawnAt = Date.now();
    const correlationId = diagnostics.correlationId("agent-start");
    for (const [stream, severity] of [[managedProcess.stdout, "info"], [managedProcess.stderr, "error"]]) stream.on("data", (chunk) => diagnostics.log(severity, "agent", "process-output", String(chunk).trim(), { pid: managedProcess?.pid }, { file: "agent", correlationId }));
    managedProcess.once("exit", (code, signal) => { diagnostics.log(code === 0 ? "info" : "error", "agent", "process-exit", "Local Agent process exited", { code, signal, restartPolicy: config.restartPolicy }, { file: "agent", correlationId }); managedProcess = null; if (code && config.restartPolicy === "always") start().catch(() => {}); });
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (managedProcess?.exitCode !== null) throw Object.assign(new Error("Agent exited during startup."), { code: "AGENT_START_FAILED" });
    await waitForLocalAgentHealth(config, config.connectionTimeoutMs || 3500);
    ensureLocalAgentBackendSelected(config);
    lastRestartReason = "Started from AnxOS"; lastError = null; return getStatus();
  } catch (error) { lastError = { code: error.code || "AGENT_START_FAILED", message: error.message }; diagnostics.logError("agent-control", "start", error, {}, { file: "service-manager" }); throw error; }
  finally { operationInFlight = null; }
}

async function stop({ force = false } = {}) {
  if (operationInFlight) throw Object.assign(new Error("Another Agent operation is already running."), { code: "AGENT_OPERATION_BUSY" });
  operationInFlight = "stop";
  try { const config = readConfig(); const service = await getServiceState(); if (service.installed && service.active) { const result = process.platform === "linux" ? await command("systemctl", ["--user", "stop", "anxos-agent.service"]) : await command("schtasks.exe", ["/End", "/TN", SERVICE_NAME], { timeout: 30000 }); if (!result.ok && !force && !/not been started|not running|not currently running/i.test(`${result.stdout}\n${result.stderr}`)) throw Object.assign(new Error(result.stderr || result.stdout || "Background Agent could not be stopped."), { code: "SERVICE_STOP_FAILED" }); if (process.platform === "win32") await stopVerifiedWindowsTaskAgent(config); } if (managedProcess && !managedProcess.killed) { const child = managedProcess; child.kill(force ? "SIGKILL" : "SIGTERM"); await new Promise((resolve) => { const timer = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); resolve(); }, 5000); child.once("exit", () => { clearTimeout(timer); resolve(); }); }); } managedProcess = null; await waitForLocalAgentStopped(config).catch(() => false); lastRestartReason = force ? "Force stopped from AnxOS" : "Stopped from AnxOS"; return getStatus(); }
  finally { operationInFlight = null; }
}
async function restart({ force = false } = {}) { await stop({ force }); lastRestartReason = force ? "Force restarted from AnxOS" : "Restarted from AnxOS"; return start(); }

async function stopOldLocalAgentAndRepair(options = {}) {
  if (operationInFlight) throw Object.assign(new Error("Another Agent operation is already running."), { code: "AGENT_OPERATION_BUSY" });
  operationInFlight = "repair-old-local-agent";
  try {
    const config = readConfig();
    const listener = await getWindowsListeningProcess(config.port);
    const health = await agentClient.getHealth(getLocalAgentHealthConfig(config)).catch(() => null);
    if (listener?.listening && health?.ok) {
      const stopped = await stopVerifiedOldLocalAgentProcess({ health, processInfo: listener.process });
      operationInFlight = null;
      const repaired = await installLocalAgent({ autoStart: true, installService: true, reason: "old-local-agent-repair", ...options });
      return { ...repaired, stoppedOldLocalAgent: stopped, listener: { port: listener.port, pid: listener.pid, processKind: stopped.processKind } };
    }
    operationInFlight = null;
    return installLocalAgent({ autoStart: true, installService: true, reason: "old-local-agent-repair", ...options });
  } finally {
    if (operationInFlight === "repair-old-local-agent") operationInFlight = null;
  }
}

async function getServiceState() {
  if (process.platform === "linux") {
    const result = await command("systemctl", ["--user", "is-enabled", "anxos-agent.service"]);
    const active = await command("systemctl", ["--user", "is-active", "anxos-agent.service"]);
    const output = `${result.stdout}\n${result.stderr}`;
    const installed = !/not-found|No such file/i.test(output);
    const unitPath = path.join(os.homedir(), ".config", "systemd", "user", "anxos-agent.service");
    let valid = installed;
    const issues = [];
    if (installed) {
      try {
        const unit = fs.readFileSync(unitPath, "utf8");
        const normalizedUnit = normalizeCommandForComparison(unit);
        if (!normalizedUnit.includes(normalizeCommandForComparison(getAgentScript()))) issues.push("Unit does not point at the current bundled Agent server.");
        if (!normalizedUnit.includes(normalizeCommandForComparison(`ANXHUB_CONFIG_DIR=${getConfigDirectory()}`))) issues.push("Unit does not use the current Agent config directory.");
        valid = issues.length === 0;
      } catch (error) {
        valid = false;
        issues.push(error?.code === "ENOENT" ? "Unit file is missing." : "Unit file could not be verified.");
      }
    }
    const service = { supported: true, type: "systemd-user", installed, valid, enabled: result.stdout === "enabled", active: active.stdout === "active" && valid, state: installed && !valid ? "invalid" : active.stdout || "inactive", registrationStatus: installed ? valid ? "valid" : "invalid" : "missing", verification: { state: installed ? valid ? "valid" : "invalid" : "missing", issues }, privilege: { supported: false, elevated: false, state: "not-applicable" } };
    return service;
  }
  if (process.platform === "win32") {
    const legacyRegistration = await inspectLegacyWindowsService();
    const snapshot = await inspectWindowsAgentScheduledTask();
    const privilege = await getWindowsElevationState();
    if (!snapshot.found) {
      const unverifiable = snapshot.inspectionFailed === true;
      return {
        supported: true,
        type: "windows-scheduled-task",
        installed: false,
        valid: false,
        enabled: false,
        active: Boolean(managedProcess),
        state: unverifiable ? "unverifiable" : "not-installed",
        registrationStatus: unverifiable ? "unverifiable" : "missing",
        verification: {
          state: unverifiable ? "unverifiable" : "missing",
          issues: unverifiable ? ["Windows denied service verification."] : [],
          errorCode: snapshot.errorCode || null,
          message: snapshot.message || null,
        },
        privilege,
        requiresElevation: privilege.elevated !== true,
        processRunning: Boolean(managedProcess),
        startupRegistrationHealthy: false,
        legacyRegistration: { state: legacyRegistration.state, owned: legacyRegistration.owned, issues: legacyRegistration.issues || [] },
      };
    }
    const canonical = buildWindowsAgentTaskDefinition({ userId: getCurrentWindowsUser() });
    const comparison = compareWindowsAgentTask(snapshot, canonical);
    const serviceState = String(snapshot.state || "unknown").toLowerCase();
    const active = serviceState === "running";
    const enabled = snapshot.enabled !== false;
    const verification = {
      valid: comparison.matches,
      command: snapshot.actions?.[0]?.execute || null,
      expected: expectedWindowsServiceCommand(),
      issues: comparison.mismatches,
      mismatchReasons: comparison.mismatches,
      task: comparison.actual,
      canonical,
      raw: snapshot,
    };
    const service = {
      supported: true,
      type: "windows-scheduled-task",
      installed: true,
      valid: verification.valid,
      enabled,
      active: active || Boolean(managedProcess),
      state: active ? "running" : verification.valid ? serviceState || "stopped" : "invalid",
      registrationStatus: verification.valid ? "valid" : "invalid",
      verification: { state: verification.valid ? "valid" : "invalid", serviceState, ...verification },
      privilege,
      requiresElevation: privilege.elevated !== true,
      processRunning: active || Boolean(managedProcess),
      startupRegistrationHealthy: verification.valid && enabled,
      legacyRegistration: { state: legacyRegistration.state, owned: legacyRegistration.owned, issues: legacyRegistration.issues || [] },
    };
    return service;
  }
  return { supported: false, type: "unsupported", installed: false, enabled: false, active: Boolean(managedProcess), state: "unsupported" };
}

async function installService() {
  const config = readConfig();
  if (process.platform === "linux") { const unitDir = path.join(os.homedir(), ".config", "systemd", "user"); const unitPath = path.join(unitDir, "anxos-agent.service"); fs.mkdirSync(unitDir, { recursive: true }); const quote = (value) => `"${String(value).replace(/([\\"])/g, "\\$1")}"`; const unit = `[Unit]\nDescription=AnxOS Agent\nAfter=network.target\n\n[Service]\nType=simple\nEnvironment=${quote("ELECTRON_RUN_AS_NODE=1")}\nEnvironment=${quote(`ANXHUB_CONFIG_DIR=${getConfigDirectory()}`)}\nEnvironment=${quote(`AGENT_HOST=${config.host}`)}\nEnvironment=${quote(`AGENT_PORT=${config.port}`)}\nEnvironment=${quote(`AGENT_IDENTITY_PATH=${path.join(getAgentDataDirectory(), "device-identity.json")}`)}\nExecStart=${quote(process.execPath)} ${quote(getAgentScript())}\nRestart=${config.restartPolicy === "never" ? "no" : config.restartPolicy}\n\n[Install]\nWantedBy=default.target\n`; fs.writeFileSync(unitPath, unit, { mode: 0o600 }); await command("systemctl", ["--user", "daemon-reload"]); const enabled = await command("systemctl", ["--user", "enable", "--now", "anxos-agent.service"]); if (!enabled.ok) throw Object.assign(new Error(enabled.stderr || "Could not install systemd user service."), { code: "SERVICE_INSTALL_FAILED" }); }
  else if (process.platform === "win32") {
    let repaired;
    try { repaired = await agentClient.repairWindowsAgentTask(getLocalAgentHealthConfig(config)); }
    catch (error) {
      throw Object.assign(new Error("The elevated Local Agent is unavailable to repair Windows startup."), { code: "AGENT_PRIVILEGED_OPERATION_UNAVAILABLE", cause: error, recoverySuggestion: "Repair or reinstall AnxOS so the elevated Agent task can be restored, then try again." });
    }
    if (!repaired?.matchesCanonicalDefinition || repaired?.agentHealth !== "healthy") throw Object.assign(new Error("The Agent did not confirm a healthy canonical startup task."), { code: "AGENT_TASK_DEFINITION_MISMATCH", details: { mismatchReasons: repaired?.mismatchReasons || [] } });
  }
  else throw Object.assign(new Error("Agent background service management is not supported on this platform."), { code: "PLATFORM_UNSUPPORTED" });
  saveConfig({ ...config, autoStart: true }); diagnostics.log("info", "service-manager", "install", "Agent background startup installed", { platform: process.platform }, { file: "service-manager" }); return getStatus();
}

async function uninstallService() { if (process.platform === "linux") { await command("systemctl", ["--user", "disable", "--now", "anxos-agent.service"]); fs.rmSync(path.join(os.homedir(), ".config", "systemd", "user", "anxos-agent.service"), { force: true }); await command("systemctl", ["--user", "daemon-reload"]); } else if (process.platform === "win32") { try { await agentClient.uninstallWindowsAgentTask(getLocalAgentHealthConfig(readConfig())); } catch (error) { throw Object.assign(new Error("The elevated Local Agent could not remove Windows startup."), { code: "AGENT_PRIVILEGED_OPERATION_FAILED", cause: error }); } } else throw Object.assign(new Error("Agent service management is unsupported."), { code: "PLATFORM_UNSUPPORTED" }); saveConfig({ ...readConfig(), autoStart: false }); return getStatus(); }
async function setAutoStart(enabled) { if (enabled) return installService(); return uninstallService(); }

function installerStep(id, label, state = "pending", message = "") {
  return { id, label, state, message, at: new Date().toISOString() };
}

async function installLocalAgent(options = {}) {
  if (operationInFlight) throw Object.assign(new Error("Another Agent operation is already running."), { code: "AGENT_OPERATION_BUSY" });
  operationInFlight = "install";
  const steps = [
    installerStep("runtime", "Validate bundled runtime"),
    installerStep("directories", "Create managed folders"),
    installerStep("configuration", "Create secure configuration"),
    installerStep("credentials", "Generate local credentials"),
    installerStep("service", "Configure background startup"),
    installerStep("start", "Start Local Agent"),
    installerStep("verify", "Verify connection"),
    installerStep("rollback", "Rollback pending changes"),
  ];
  const mark = (id, state, message) => {
    const step = steps.find((entry) => entry.id === id);
    if (step) {
      step.state = state;
      step.message = message || step.message;
      step.at = new Date().toISOString();
    }
    lastInstallSteps = steps.map((entry) => ({ ...entry }));
  };
  try {
    lastInstallSteps = steps.map((entry) => ({ ...entry }));
    const previousRuntimeConfig = readConfig();
    const previousAgentSettings = agentClient.readAgentSettings();
    const previousLocalCredential = snapshotLocalAgentCredential();
    let transactionStarted = false;
    let credentialRotated = false;
    const rollbackPendingChanges = (reason) => {
      if (!transactionStarted) return;
      try {
        saveConfig(previousRuntimeConfig);
        if (credentialRotated) {
          agentClient.saveAgentSettings(previousAgentSettings);
          restoreLocalAgentCredential(previousLocalCredential);
        }
        mark("rollback", "complete", reason || "Pending Local Agent changes were rolled back.");
      } catch (rollbackError) {
        mark("rollback", "failed", "Rollback could not fully restore the previous Local Agent state.");
        diagnostics.logError("agent-control", "install-local-agent-rollback", rollbackError, {}, { file: "service-manager" });
      }
    };

    const runtime = getBundledLocalAgentRuntime();
    if (!runtime.exists) {
      mark("runtime", "failed", "The bundled Local Agent runtime is missing. Repair AnxOS Control Center, then retry.");
      throw Object.assign(new Error("Bundled Local Agent runtime is missing or incomplete."), { code: "LOCAL_AGENT_RUNTIME_MISSING", steps });
    }
    mark("runtime", "complete", "Bundled runtime is available.");

    ensureManagedAgentDirectories();
    mark("directories", "complete", "Managed folders are ready.");

    const current = readConfig();
    const config = saveConfig({
      ...current,
      name: LOCAL_AGENT_DISPLAY_NAME,
      host: "127.0.0.1",
      allowedFolders: current.allowedFolders?.length ? current.allowedFolders : defaults().allowedFolders,
      storageRoots: current.storageRoots?.length ? current.storageRoots : defaults().storageRoots,
      ownerMachine: true,
      autoStart: options.autoStart !== false,
    });
    transactionStarted = true;
    mark("configuration", "complete", "Local Agent configuration is ready.");

    const localAgentUrl = getLocalAgentUrl(config);

    let serviceWarning = null;
    if (options.installService !== false) {
      try {
        await installService();
        mark("service", "complete", "Background startup is configured.");
      } catch (error) {
        const installError = error.code === "ELEVATION_REQUIRED"
          ? Object.assign(new Error("Administrator permission is required to install or repair the Local Agent."), {
            code: "ELEVATION_REQUIRED",
            recoverySuggestion: "Use Try Again to approve administrator permission, or Cancel to leave the current Local Agent unchanged.",
            cause: error,
          })
          : Object.assign(new Error(error.message || "Background startup could not be configured."), {
            code: error.code || "LOCAL_AGENT_SERVICE_INSTALL_FAILED",
            recoverySuggestion: "Repair the Local Agent from Agent Control, then try again.",
            cause: error,
          });
        serviceWarning = {
          code: installError.code,
          message: installError.recoverySuggestion || installError.message,
        };
        mark("service", error.code === "ELEVATION_REQUIRED" ? "blocked" : "failed", serviceWarning.message);
        rollbackPendingChanges("Local Agent installation was stopped before credentials changed.");
        installError.steps = steps;
        installError.serviceWarning = serviceWarning;
        throw installError;
      }
    } else {
      mark("service", "skipped", "Background startup was skipped.");
    }

    const pairing = pairLocalAgent({ agentUrl: localAgentUrl, rotate: true, reason: "local-agent-install" });
    credentialRotated = true;
    mark("credentials", "complete", `Secure local credentials were generated. Fingerprint ${pairing.fingerprint || "available"}.`);

    const statusBeforeStart = await getStatus();
    if (!statusBeforeStart.running) {
      operationInFlight = null;
      try {
        await start();
      } catch (error) {
        mark("start", "failed", error.message || "Local Agent could not be started.");
        rollbackPendingChanges("Local Agent start failed; pending credentials were rolled back.");
        throw error;
      }
      operationInFlight = "install";
    }
    mark("start", "complete", "Local Agent started.");

    const connection = await testConnection({ backendMode: "agent", agentUrl: localAgentUrl });
    if (!connection.connected) {
      mark("verify", "failed", connection.message || "Local Agent did not pass the connection check.");
      rollbackPendingChanges("Local Agent verification failed; pending credentials were rolled back.");
      throw Object.assign(new Error(connection.message || "Local Agent did not pass the connection check."), { code: "LOCAL_AGENT_VERIFY_FAILED", steps });
    }
    mark("verify", "complete", "Desktop reconnected to the Local Agent.");
    mark("rollback", "skipped", "No rollback was needed.");
    lastInstallSteps = steps.map((entry) => ({ ...entry }));
    lastRestartReason = "Installed Local Agent from AnxOS";
    lastError = null;
    return {
      ok: true,
      installed: true,
      started: true,
      serviceWarning,
      steps,
      status: await getStatus(),
    };
  } catch (error) {
    lastError = { code: error.code || "LOCAL_AGENT_INSTALL_FAILED", message: error.message };
    lastInstallSteps = steps.map((entry) => ({ ...entry }));
    diagnostics.logError("agent-control", "install-local-agent", error, { steps }, { file: "service-manager" });
    error.steps = error.steps || steps;
    throw error;
  } finally {
    operationInFlight = null;
  }
}

function getLocalAgentUpdateState(status = {}) {
  const bundledVersion = getBundledLocalAgentVersion(null);
  const installedVersion = status.agentVersion || status.identity?.agentVersion || null;
  const comparison = installedVersion && bundledVersion ? compareVersions(installedVersion, bundledVersion) : null;
  const updateAvailable = comparison !== null && comparison < 0;
  const agentNewerThanDesktop = comparison !== null && comparison > 0;
  return {
    bundledVersion: bundledVersion || "unavailable",
    installedVersion,
    updateAvailable,
    agentNewerThanDesktop,
    versionMismatch: comparison !== null && comparison !== 0,
    state: updateAvailable
      ? "Local Agent Update Available"
      : agentNewerThanDesktop
        ? "Agent newer than Desktop"
        : comparison === 0
          ? "Current"
          : "Unknown",
    compatible: !agentNewerThanDesktop,
    checkedAt: new Date().toISOString(),
  };
}

function backupLocalAgentState(label = "update") {
  ensureManagedAgentDirectories();
  const safeLabel = String(label || "update").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 40);
  const backupRoot = path.join(getAgentUpdateDirectory(), `${new Date().toISOString().replace(/[:.]/g, "-")}-${safeLabel}`);
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const copied = [];
  const copyIfExists = (source, relativeTarget) => {
    if (!fs.existsSync(source)) return;
    const target = path.join(backupRoot, relativeTarget);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(source, target, { recursive: true, force: true });
    copied.push(relativeTarget);
  };
  copyIfExists(getRuntimeConfigPath(), "config/agent-runtime.json");
  copyIfExists(`${getRuntimeConfigPath()}.backup`, "config/agent-runtime.json.backup");
  copyIfExists(path.join(getConfigDirectory(), "agent.json"), "config/agent.json");
  copyIfExists(path.join(getAgentDataDirectory(), "device-identity.json"), "agent/device-identity.json");
  fs.writeFileSync(path.join(backupRoot, "manifest.json"), `${JSON.stringify({
    createdAt: new Date().toISOString(),
    reason: label,
    copied,
    excludes: ["instances", "backups", "logs", "tmp"],
  }, null, 2)}\n`, { mode: 0o600 });
  return { backupRoot, copied };
}

function writeLocalAgentUpdateRecord(record = {}) {
  ensureManagedAgentDirectories();
  const filePath = path.join(getAgentUpdateDirectory(), "last-update.json");
  fs.writeFileSync(filePath, `${JSON.stringify({ ...record, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

async function updateLocalAgent(options = {}) {
  if (operationInFlight) throw Object.assign(new Error("Another Agent operation is already running."), { code: "AGENT_OPERATION_BUSY" });
  operationInFlight = "update";
  const steps = [
    installerStep("detect", "Check Agent version"),
    installerStep("backup", "Back up Agent configuration"),
    installerStep("stop", "Stop Local Agent"),
    installerStep("replace", "Apply bundled runtime"),
    installerStep("migrate", "Run migrations"),
    installerStep("start", "Restart Local Agent"),
    installerStep("verify", "Verify health"),
  ];
  const mark = (id, state, message) => {
    const step = steps.find((entry) => entry.id === id);
    if (step) {
      step.state = state;
      step.message = message || step.message;
      step.at = new Date().toISOString();
    }
  };
  let backup = null;
  let before = null;
  try {
    before = await getStatus();
    const update = getLocalAgentUpdateState(before);
    mark("detect", "complete", `${update.installedVersion || "Unknown"} -> ${update.bundledVersion}`);
    if (update.agentNewerThanDesktop && options.force !== true) {
      throw Object.assign(new Error("The Local Agent is newer than this Desktop build. Install a newer AnxOS Control Center before changing the Agent runtime."), { code: "AGENT_NEWER_THAN_DESKTOP", steps, update });
    }
    if (!update.versionMismatch && options.force !== true) {
      mark("backup", "skipped", "No update is required.");
      mark("stop", "skipped", "No update is required.");
      mark("replace", "skipped", "Bundled runtime already matches.");
      mark("migrate", "skipped", "No migrations were required.");
      mark("start", "skipped", "No restart was required.");
      mark("verify", "complete", "Local Agent already matches the bundled runtime.");
      return { ok: true, updated: false, update, steps, status: before };
    }
    backup = backupLocalAgentState("local-agent-update");
    mark("backup", "complete", "Configuration and identity state were backed up.");

    operationInFlight = null;
    await stop({ force: false }).catch(async () => stop({ force: true }));
    operationInFlight = "update";
    mark("stop", "complete", "Local Agent stopped.");

    const runtime = getBundledLocalAgentRuntime();
    if (!runtime.exists) {
      throw Object.assign(new Error("Bundled Local Agent runtime is missing or incomplete."), { code: "LOCAL_AGENT_RUNTIME_MISSING", steps });
    }
    if (before.service?.installed && before.service?.supported) {
      await installService();
      operationInFlight = "update";
    }
    mark("replace", "complete", "Service registration points to the bundled runtime.");
    mark("migrate", "complete", "No runtime migrations were required for this build.");

    operationInFlight = null;
    const started = await start();
    operationInFlight = "update";
    mark("start", "complete", "Local Agent restarted.");
    const afterUpdate = getLocalAgentUpdateState(started);
    const bundledVersion = getBundledLocalAgentVersion(null);
    if (bundledVersion && afterUpdate.installedVersion && compareVersions(afterUpdate.installedVersion, bundledVersion) !== 0) {
      throw Object.assign(new Error("Local Agent restarted but did not report the bundled runtime version."), { code: "LOCAL_AGENT_UPDATE_VERIFY_FAILED", steps, update: afterUpdate });
    }
    mark("verify", "complete", "Local Agent health verified after update.");
    const recordPath = writeLocalAgentUpdateRecord({
      fromVersion: update.installedVersion,
      toVersion: bundledVersion || "unavailable",
      backupRoot: backup.backupRoot,
      status: "complete",
    });
    lastRestartReason = "Updated Local Agent runtime from AnxOS";
    lastError = null;
    return { ok: true, updated: true, update: afterUpdate, previousUpdate: update, backup, recordPath, steps, status: await getStatus() };
  } catch (error) {
    lastError = { code: error.code || "LOCAL_AGENT_UPDATE_FAILED", message: error.message };
    diagnostics.logError("agent-control", "update-local-agent", error, { backupRoot: backup?.backupRoot || null, steps }, { file: "service-manager" });
    writeLocalAgentUpdateRecord({
      fromVersion: before?.agentVersion || null,
      toVersion: getBundledLocalAgentVersion("unavailable"),
      backupRoot: backup?.backupRoot || null,
      status: "failed",
      error: { code: error.code || "LOCAL_AGENT_UPDATE_FAILED", message: error.message },
    });
    if (backup?.backupRoot) {
      try {
        const configBackup = path.join(backup.backupRoot, "config", "agent-runtime.json");
        if (fs.existsSync(configBackup)) fs.copyFileSync(configBackup, getRuntimeConfigPath());
      } catch (rollbackError) {
        diagnostics.logError("agent-control", "update-local-agent-rollback", rollbackError, {}, { file: "service-manager" });
      }
    }
    error.steps = error.steps || steps;
    throw error;
  } finally {
    operationInFlight = null;
  }
}

async function pairLocalAgentSecurely(options = {}) {
  const config = readConfig();
  const localAgentUrl = getLocalAgentUrl(config);
  const result = options.rotate === true
    ? rotateLocalAgentCredentials({ agentUrl: localAgentUrl, reason: options.reason || "local-agent-rotation" })
    : pairLocalAgent({ agentUrl: localAgentUrl, reason: options.reason || "local-agent-pairing" });
  diagnostics.log("info", "agent-control", "local-pairing", "Local Agent pairing state updated", {
    fingerprint: result.fingerprint || null,
    rotated: result.rotated,
    credentialState: result.credentialState,
  }, { file: "service-manager" });
  return {
    ...result,
    status: await getStatus(),
  };
}

function normalizePairingTargetUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function getPairingSessionTarget(options = {}) {
  const config = readConfig();
  const requestedNodeId = String(options.nodeId || "").trim();
  const requestedAgentUrl = normalizePairingTargetUrl(options.agentUrl || "");
  if (requestedNodeId === "application-host") {
    return {
      kind: "windows-local-agent",
      nodeId: "application-host",
      name: "Windows Local Agent",
      agentUrl: getLocalAgentUrl(config),
      local: true,
    };
  }
  if (requestedNodeId && requestedNodeId !== "application-host") {
    const node = getNode(requestedNodeId);
    if (node.kind !== "agent") {
      throw Object.assign(new Error("Selected pairing target is not an Agent node."), { code: "NODE_NOT_AGENT" });
    }
    const agentUrl = normalizePairingTargetUrl(node.agentUrl || node.baseUrl);
    if (!agentUrl) throw Object.assign(new Error("Selected Agent node does not have a valid Agent URL."), { code: "INVALID_NODE_URL" });
    return {
      kind: node.localAgent ? "local-node" : "remote-node",
      nodeId: node.id,
      name: node.displayName || node.name || node.id,
      agentUrl,
      local: node.localAgent === true,
    };
  }
  if (requestedAgentUrl) {
    return {
      kind: "explicit-agent",
      nodeId: null,
      name: options.name || "Remote Agent",
      agentUrl: requestedAgentUrl,
      local: false,
    };
  }
  return {
    kind: "windows-local-agent",
    nodeId: "application-host",
    name: "Windows Local Agent",
    agentUrl: getLocalAgentUrl(config),
    local: true,
  };
}

async function startPairingSession(options = {}) {
  const target = getPairingSessionTarget(options);
  if (target.kind === "windows-local-agent") {
    if (!(await getStatus())?.running) {
      await start();
    }
  }
  let response;
  try {
    response = await fetch(`${target.agentUrl}/api/v1/pairing/start`, { method: "POST" });
  } catch (error) {
    throw Object.assign(new Error(`Remote Agent at ${target.agentUrl} is unreachable. Pairing code generation was not redirected to the Windows Local Agent.`), {
      code: "PAIRING_AGENT_UNREACHABLE",
      details: {
        agentUrl: target.agentUrl,
        nodeId: target.nodeId,
        targetName: target.name,
        reachable: false,
        cause: error?.code || error?.message || "fetch failed",
      },
    });
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.pairingCode) {
    const unsupported = response.status === 404 || response.status === 405;
    throw Object.assign(new Error(payload?.error?.message || (unsupported ? `Pairing endpoint is not supported by the Agent at ${target.agentUrl}.` : `Agent pairing setup could not start at ${target.agentUrl}.`)), {
      code: payload?.error?.code || "PAIRING_START_FAILED",
      details: {
        agentUrl: target.agentUrl,
        nodeId: target.nodeId,
        targetName: target.name,
        reachable: response.ok,
        status: response.status,
      },
    });
  }
  const returnedAgentUrl = normalizePairingTargetUrl(payload.agentUrl || target.agentUrl) || target.agentUrl;
  diagnostics.log("info", "agent-control", "pairing-session", "Temporary Agent pairing session started", {
    agentUrl: returnedAgentUrl,
    requestedAgentUrl: target.agentUrl,
    nodeId: target.nodeId,
    targetName: target.name,
    expiresAt: payload.expiresAt || null,
  }, { file: "service-manager" });
  return {
    status: payload.status || "waiting",
    pairingCode: payload.pairingCode,
    displayCode: payload.displayCode || null,
    expiresAt: payload.expiresAt || null,
    agentUrl: returnedAgentUrl,
    requestedAgentUrl: target.agentUrl,
    nodeId: target.nodeId,
    targetName: target.name,
    targetKind: target.kind,
    local: target.local,
    identity: payload.identity || null,
  };
}

async function probePort(port) { return new Promise((resolve) => { const socket = net.connect({ host: "127.0.0.1", port, timeout: 800 }); socket.once("connect", () => { socket.destroy(); resolve(true); }); socket.once("error", () => resolve(false)); socket.once("timeout", () => { socket.destroy(); resolve(false); }); }); }

async function waitForLocalAgentHealth(config, timeoutMs = 3500) {
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const health = await agentClient.getHealth(getLocalAgentHealthConfig(config));
      if (health?.ok) return health;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (lastError) throw lastError;
  throw Object.assign(new Error("Local Agent did not become healthy before the startup timeout."), { code: "AGENT_START_TIMEOUT" });
}

async function waitForLocalAgentStopped(config, timeoutMs = 3500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const health = await agentClient.getHealth(getLocalAgentHealthConfig(config)).catch(() => null);
    if (!health?.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function getLocalAgentUrl(config) {
  return `http://127.0.0.1:${config.port}`;
}

function getLocalAgentHealthConfig(config) {
  return {
    backendMode: "agent",
    agentUrl: getLocalAgentUrl(config),
    agentToken: "",
    targetLabel: "local-agent",
    suppressConnectionRefusedLog: true,
    logThrottleMs: 60000,
  };
}

function getRemoteHealthConfig(node, selectedNodeId) {
  return {
    ...getNodeAgentConfig(node.id),
    nodeId: node.id,
    nodeName: node.displayName || node.name || node.id,
    nodeUrl: node.agentUrl || node.baseUrl || null,
    targetLabel: `node:${node.id}`,
    logThrottleMs: node.id === selectedNodeId ? 15000 : 30000,
  };
}

function getUrlHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function normalizeAgentUrlForComparison(url) {
  try {
    const parsed = new URL(url);
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port || (protocol === "https:" ? "443" : protocol === "http:" ? "80" : "");
    return `${protocol}//${hostname}:${port}`;
  } catch {
    return null;
  }
}

function getConfiguredAgentHealthConfig(effective) {
  return {
    backendMode: "agent",
    agentUrl: effective.agentUrl,
    agentToken: effective.agentToken,
    targetLabel: "global-configured-agent",
    logThrottleMs: 15000,
  };
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeServiceState(value, running) {
  const text = String(value || "").toLowerCase();
  if (/restart/.test(text)) return "restarting";
  if (/repair/.test(text)) return "repairing";
  if (/start/.test(text)) return "starting";
  if (/stop/.test(text)) return "stopping";
  if (running) return "running";
  if (/stop|offline|inactive|registered|not-installed/.test(text)) return "stopped";
  if (/(^|\b)(run|running|active)(\b|$)/.test(text)) return "running";
  return "unknown";
}

function normalizeMemory(stats) {
  const memory = stats?.memory && typeof stats.memory === "object" ? stats.memory : {};
  const usedBytes = finiteNumber(memory.used ?? memory.usedBytes);
  const totalBytes = finiteNumber(memory.total ?? memory.totalBytes);
  const usagePercent = finiteNumber(memory.percent ?? memory.usagePercent);
  return {
    usedBytes,
    totalBytes,
    usagePercent: usagePercent ?? (usedBytes !== null && totalBytes > 0 ? (usedBytes / totalBytes) * 100 : null),
  };
}

function normalizeCpu(stats) {
  const cpu = stats?.cpu && typeof stats.cpu === "object" ? stats.cpu : {};
  return {
    usagePercent: finiteNumber(cpu.usagePercent),
    model: cpu.model || null,
    cores: finiteNumber(cpu.cores),
  };
}

function getDiskSpaceForPath(targetPath) {
  try {
    fs.mkdirSync(targetPath, { recursive: true });
    const stats = fs.statfsSync(targetPath);
    return {
      path: targetPath,
      availableBytes: Number(stats.bavail) * Number(stats.bsize),
      totalBytes: Number(stats.blocks) * Number(stats.bsize),
    };
  } catch (error) {
    return {
      path: targetPath,
      availableBytes: null,
      totalBytes: null,
      errorCode: error?.code || null,
    };
  }
}

function getLocalAgentStorageDiagnostics() {
  const paths = {
    config: getConfigDirectory(),
    data: getAgentDataDirectory(),
    logs: getAgentLogsDirectory(),
    instances: getAgentInstancesDirectory(),
    backups: getAgentBackupsDirectory(),
    temp: getAgentTempDirectory(),
  };
  return {
    paths,
    disk: {
      data: getDiskSpaceForPath(paths.data),
      instances: getDiskSpaceForPath(paths.instances),
      backups: getDiskSpaceForPath(paths.backups),
    },
  };
}

async function getLocalAgentDependencyDiagnostics(config) {
  const dependencyIds = ["docker", "java", "steamcmd"];
  try {
    const result = await agentClient.checkDependencies({ dependencyIds }, getLocalAgentHealthConfig(config));
    const dependencies = Array.isArray(result?.dependencies) ? result.dependencies : [];
    return {
      checked: true,
      dependencies: dependencies
        .filter((dependency) => dependencyIds.includes(dependency.id))
        .map((dependency) => ({
          id: dependency.id,
          name: dependency.name || dependency.displayName || dependency.id,
          state: dependency.state || (dependency.installed ? "installed" : "missing"),
          installed: dependency.installed === true,
          version: dependency.version || dependency.detectedVersion || null,
          restartRequired: dependency.restartRequired === true,
        })),
    };
  } catch (error) {
    return {
      checked: false,
      errorCode: error?.code || "DEPENDENCY_DIAGNOSTICS_FAILED",
      message: error?.message || "Dependency diagnostics failed.",
    };
  }
}

function getRecentSanitizedAgentLogs() {
  return diagnostics.readLogs({ sources: ["agent", "service-manager"], limit: 25 }).entries
    .map((entry) => ({
      timestamp: entry.timestamp || null,
      level: entry.level || entry.severity || null,
      source: entry.source || null,
      operation: entry.operation || null,
      message: entry.message || null,
      errorCode: entry.errorCode || entry.context?.code || null,
    }));
}

function normalizeAgentRuntimeStatus({ base = {}, health = null, stats = null, service = null, latencyMs = null, connected = false, reachable = false, capabilities = {} }) {
  const running = connected && reachable;
  const serviceState = normalizeServiceState(base.operationInFlight || service?.state || base.state, running);
  const memory = normalizeMemory(stats);
  const cpu = normalizeCpu(stats);
  const metricsSupported = Boolean(stats && (cpu.usagePercent !== null || memory.usedBytes !== null || memory.totalBytes !== null));
  const identity = health?.identity || base.identity || {};
  return {
    connected,
    reachable,
    serviceState,
    serviceManaged: Boolean(service?.installed || base.serviceManaged || running),
    hostname: identity.hostname || stats?.hostname || base.hostname || null,
    url: base.agentUrl || null,
    version: identity.agentVersion || base.agentVersion || null,
    uptimeSeconds: finiteNumber(health?.process?.uptimeSeconds ?? base.uptime ?? (reachable ? stats?.uptimeSeconds : null)),
    latencyMs: finiteNumber(latencyMs),
    pid: finiteNumber(health?.process?.pid ?? base.pid),
    cpu,
    memory,
    capabilities: {
      metrics: metricsSupported,
      lifecycle: capabilities.lifecycle === true,
      repair: capabilities.repair === true,
      reconnect: capabilities.reconnect !== false,
    },
    partialFailure: stats ? null : base.partialFailure || null,
  };
}

function createAgentControlStatusSnapshot(target = {}, options = {}) {
  const state = options.state || (options.authenticated === false
    ? AGENT_STATUS.AUTHENTICATION_REQUIRED
    : options.partialFailure
      ? AGENT_STATUS.DEGRADED
      : options.connected
        ? AGENT_STATUS.CONNECTED
        : options.reachable
          ? AGENT_STATUS.DEGRADED
          : AGENT_STATUS.OFFLINE);
  return createAgentStatusSnapshot({
    target,
    state,
    message: options.message || options.partialFailure?.message || target.mostRecentError?.message || null,
    targetId: options.targetId || target.nodeId || target.id || target.targetType || null,
    targetType: options.targetType || target.targetType || null,
    checkedAt: options.checkedAt || null,
    lastSeen: options.lastSeen || target.lastHeartbeat || null,
    metadata: {
      platform: target.platform || target.identity?.platform || null,
      type: options.targetType || target.targetType || null,
      registered: target.nodeId ? true : null,
    },
  });
}

function getLocalAgentLifecycleOwnership({ health = null, service = {}, pairing = {}, managed = null } = {}) {
  const managedChildRunning = Boolean(managed && !managed.killed);
  const healthOk = Boolean(health?.ok);
  const remoteFingerprint = health?.tokenFingerprint || null;
  const localFingerprint = pairing?.fingerprint || null;
  const credentialMatches = remoteFingerprint && localFingerprint ? remoteFingerprint === localFingerprint : null;

  if (healthOk && credentialMatches === false) {
    return {
      type: "credential-mismatch",
      state: "repair-required",
      managed: false,
      credentialMatches,
      processKind: "unverified-listener",
      message: "The process listening on the Local Agent port is using a different credential. Repair or re-pair the Local Agent before managing it.",
      repairAction: "repair-local-agent",
    };
  }

  if (healthOk && service?.active) {
    return {
      type: "managed-service",
      state: "managed",
      managed: true,
      credentialMatches,
      processKind: service.type || "service",
      message: "The Local Agent is running as the managed background service.",
      repairAction: null,
    };
  }

  if (healthOk && managedChildRunning) {
    return {
      type: "managed-child-process",
      state: "managed",
      managed: true,
      credentialMatches,
      processKind: "packaged-child-process",
      message: "The Local Agent is running as a managed packaged child process.",
      repairAction: null,
    };
  }

  if (healthOk) {
    return {
      type: "unmanaged-agent",
      state: "unmanaged",
      managed: false,
      credentialMatches,
      processKind: "external-process",
      message: "A Local Agent is reachable, but it was not started by this Control Center service manager.",
      repairAction: "repair-local-agent",
    };
  }

  if (service?.active) {
    return {
      type: "stale-managed-service",
      state: "repair-required",
      managed: true,
      credentialMatches: null,
      processKind: service.type || "service",
      message: "The Local Agent service appears active, but health verification did not succeed.",
      repairAction: "repair-local-agent",
    };
  }

  return {
    type: "offline",
    state: "offline",
    managed: Boolean(service?.installed),
    credentialMatches: null,
    processKind: service?.installed ? service.type || "service" : "none",
    message: "No Local Agent process is verified on the configured port.",
    repairAction: service?.installed ? "repair-local-agent" : "install-local-agent",
  };
}

function logRuntimePayloadShape(target, payload) {
  if (app?.isPackaged !== false) return;
  diagnostics.log("info", "agent-control", "runtime-payload-shape", "Agent runtime payload shape inspected", {
    target,
    topLevelKeys: payload && typeof payload === "object" ? Object.keys(payload).sort() : [],
    identityKeys: payload?.identity && typeof payload.identity === "object" ? Object.keys(payload.identity).sort() : [],
    processKeys: payload?.process && typeof payload.process === "object" ? Object.keys(payload.process).sort() : [],
    cpuKeys: payload?.cpu && typeof payload.cpu === "object" ? Object.keys(payload.cpu).sort() : [],
    memoryKeys: payload?.memory && typeof payload.memory === "object" ? Object.keys(payload.memory).sort() : [],
  }, { file: "agent" });
}

async function getConfiguredAgentStatus(options = {}) {
  const effective = agentClient.getEffectiveAgentSettings();
  const configured = {
    local: false,
    configured: true,
    backendMode: effective.backendMode,
    targetType: "global-configured-agent",
    healthTargetLabel: "global-configured-agent",
    state: options.skipProbe ? "Registered node selected" : effective.backendMode === "agent" ? "Offline" : "Local mode",
    running: false,
    agentUrl: effective.backendMode === "agent" ? effective.agentUrl : null,
    lifecycleSupported: false,
    service: { supported: false, type: "remote-agent", installed: false, enabled: false, active: false, state: "remote" },
    hostname: getUrlHostname(effective.agentUrl),
    identity: null,
    agentVersion: null,
    appVersion: null,
    apiVersion: null,
    protocolVersion: null,
    uptime: null,
    memoryBytes: null,
    cpuSeconds: null,
    runtime: normalizeAgentRuntimeStatus({ base: {}, connected: false, reachable: false, capabilities: { reconnect: true } }),
    connectedClients: 0,
    lastHeartbeat: null,
    latencyMs: null,
    mostRecentError: options.skipProbe ? { code: "REGISTERED_NODE_CONTEXT", message: "This URL belongs to a selected registered node; Agent Control is using the node credential instead." } : null,
  };

  if (effective.backendMode !== "agent" || !effective.agentUrl || options.skipProbe) {
    return configured;
  }

  const started = Date.now();
  try {
    const health = await agentClient.getHealth(getConfiguredAgentHealthConfig(effective));
    logRuntimePayloadShape("global-configured-agent-health", health);
    let stats = null;
    let partialFailure = null;
    try {
      stats = await agentClient.getSystemStats(getConfiguredAgentHealthConfig(effective));
      logRuntimePayloadShape("global-configured-agent-stats", stats);
    } catch (statsError) {
      partialFailure = { code: statsError.code || null, message: statsError.message || "Agent metrics endpoint unavailable." };
      diagnostics.log("warn", "agent-control", "runtime-metrics-partial", "Agent metrics endpoint did not return full runtime status", {
        target: "global-configured-agent",
        code: partialFailure.code,
        message: partialFailure.message,
      }, { file: "agent", errorCode: partialFailure.code });
    }
    const releaseInfo = getReleaseInfo();
    const appVersion = releaseInfo.compactLabel;
    const runtime = normalizeAgentRuntimeStatus({
      base: { agentUrl: effective.agentUrl, agentVersion: health?.identity?.agentVersion || health?.agentVersion, partialFailure },
      health,
      stats,
      service: { state: "running", installed: true },
      latencyMs: Date.now() - started,
      connected: true,
      reachable: true,
      capabilities: { metrics: Boolean(stats), lifecycle: false, repair: false, reconnect: true },
    });
    return {
      ...configured,
      state: "Running",
      running: true,
      identity: health?.identity || null,
      name: health?.identity?.hostname || getUrlHostname(effective.agentUrl) || "Configured Agent",
      hostname: health?.identity?.hostname || getUrlHostname(effective.agentUrl),
      operatingSystem: health?.identity?.operatingSystem || null,
      architecture: health?.identity?.architecture || null,
      agentVersion: health?.identity?.agentVersion || health?.agentVersion || null,
      appVersion,
      apiVersion: health?.apiVersion || "v1",
      protocolVersion: health?.protocolVersion || 1,
      uptime: health?.process?.uptimeSeconds ?? null,
      memoryBytes: runtime.memory.usedBytes,
      cpuSeconds: health?.process?.cpuSeconds ?? null,
      cpuUsagePercent: runtime.cpu.usagePercent,
      memoryTotalBytes: runtime.memory.totalBytes,
      memoryUsagePercent: runtime.memory.usagePercent,
      runtime,
      connectedClients: health?.process?.connectedClients || 0,
      lastHeartbeat: new Date().toISOString(),
      latencyMs: Date.now() - started,
      agentStatus: createAgentControlStatusSnapshot(configured, {
        state: partialFailure ? AGENT_STATUS.DEGRADED : AGENT_STATUS.CONNECTED,
        connected: !partialFailure,
        reachable: true,
        partialFailure,
        message: partialFailure?.message || "An authenticated Agent endpoint responded successfully.",
        targetType: "global-configured-agent",
        checkedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      }),
    };
  } catch (error) {
    const agentStatusState = classifyAgentError(error);
    return {
      ...configured,
      state: error.status === 401 || error.code === "UNAUTHORIZED" ? "Authentication failed" : "Unreachable",
      runtime: normalizeAgentRuntimeStatus({
        base: { agentUrl: effective.agentUrl, hostname: getUrlHostname(effective.agentUrl) },
        connected: false,
        reachable: false,
        capabilities: { reconnect: true },
      }),
      mostRecentError: { code: error.code || null, message: error.message || "Configured Agent is unreachable." },
      agentStatus: createAgentControlStatusSnapshot(configured, {
        state: agentStatusState,
        authenticated: agentStatusState === AGENT_STATUS.AUTHENTICATION_REQUIRED ? false : null,
        message: error.message || "Configured Agent is unreachable.",
        targetType: "global-configured-agent",
      }),
    };
  }
}

async function getStatus(_options = {}) {
  const config = readConfig();
  const service = await getServiceState();
  const agentUrl = getLocalAgentUrl(config);
  let health = null;
  let latencyMs = null;
  const started = Date.now();

  if (_options.skipProbe !== true) {
    try {
      health = await agentClient.getHealth(getLocalAgentHealthConfig(config));
      latencyMs = Date.now() - started;
    } catch {
      // Missing localhost is expected when the user is controlling a remote Agent.
    }
  }

  const listeningProcess = process.platform === "win32" ? await getWindowsListeningProcess(config.port).catch((error) => ({ port: config.port, verified: false, error: { code: error?.code || "LISTENER_INSPECTION_FAILED", message: error?.message || "Could not inspect listening process." } })) : null;
  const running = Boolean(managedProcess && !managedProcess.killed) || service.active || Boolean(health?.ok);
  const pairing = readLocalAgentPairingStatus();
  const lifecycleOwnership = getLocalAgentLifecycleOwnership({ health, service, pairing, managed: managedProcess });
  const releaseInfo = getReleaseInfo();
  const appVersion = releaseInfo.compactLabel;
  const localMemoryTotal = os.totalmem();
  const localMemoryUsed = localMemoryTotal - os.freemem();
  const localStats = {
    hostname: os.hostname(),
    uptimeSeconds: os.uptime(),
    cpu: {
      model: os.cpus()[0]?.model || null,
      cores: os.cpus().length,
      usagePercent: null,
    },
    memory: {
      used: localMemoryUsed,
      total: localMemoryTotal,
      percent: localMemoryTotal > 0 ? (localMemoryUsed / localMemoryTotal) * 100 : null,
    },
  };
  const runtime = normalizeAgentRuntimeStatus({
    base: { agentUrl, hostname: os.hostname(), agentVersion: health?.identity?.agentVersion || getBundledLocalAgentVersion("unavailable"), uptime: managedProcess ? Math.max(0, Math.round((Date.now() - (managedProcess.spawnAt || Date.now())) / 1000)) : null, serviceManaged: lifecycleOwnership.managed },
    health,
    stats: localStats,
    service,
    latencyMs,
    connected: running,
    reachable: Boolean(health?.ok),
    capabilities: { metrics: true, lifecycle: true, repair: true, reconnect: true },
  });
  const baseStatus = {
    agentVersion: health?.identity?.agentVersion || getBundledLocalAgentVersion("unavailable"),
    identity: health?.identity || null,
  };
  const startupSummary = getLocalAgentStartupSummary({ running, service });
  return {
    local: true,
    targetType: "local-agent",
    healthTargetLabel: "local-agent",
    state: operationInFlight === "start" ? "Starting" : operationInFlight === "stop" ? "Stopping" : lifecycleOwnership.state === "repair-required" ? "Repair required" : running ? "Running" : "Offline",
    operationInFlight,
    running,
    pid: health?.process?.pid || managedProcess?.pid || null,
    config,
    service,
    startupSummary,
    identity: baseStatus.identity,
    agentVersion: baseStatus.agentVersion,
    appVersion,
    apiVersion: health?.apiVersion || "v1",
    protocolVersion: health?.protocolVersion || 1,
    uptime: health?.process?.uptimeSeconds ?? (managedProcess ? Math.max(0, Math.round((Date.now() - (managedProcess.spawnAt || Date.now())) / 1000)) : null),
    memoryBytes: health?.process?.memoryBytes || null,
    cpuSeconds: health?.process?.cpuSeconds || null,
    cpuUsagePercent: runtime.cpu.usagePercent,
    memoryTotalBytes: runtime.memory.totalBytes,
    memoryUsagePercent: runtime.memory.usagePercent,
    runtime,
    pairing,
    lifecycleOwnership,
    listeningProcess,
    connectedClients: health?.process?.connectedClients || 0,
    lastHeartbeat: health ? new Date().toISOString() : null,
    latencyMs,
    hostname: os.hostname(),
    operatingSystem: `${os.type()} ${os.release()}`,
    architecture: os.arch(),
    agentUrl,
    port: config.port,
    startupMode: service.type,
    runtimeBundle: getPublicLocalAgentRuntimeInfo(),
    installerSteps: lastInstallSteps,
    update: getLocalAgentUpdateState(baseStatus),
    lastRestartReason,
    mostRecentError: lastError,
    agentStatus: createAgentControlStatusSnapshot({ targetType: "local-agent", agentUrl, hostname: os.hostname(), identity: baseStatus.identity }, {
      state: running && health?.ok ? AGENT_STATUS.CONNECTED : lifecycleOwnership.state === "repair-required" ? AGENT_STATUS.DEGRADED : AGENT_STATUS.OFFLINE,
      connected: running && health?.ok,
      reachable: Boolean(health?.ok),
      message: running && health?.ok ? "An authenticated Agent endpoint responded successfully." : lifecycleOwnership.message,
      targetType: "local-agent",
      checkedAt: health ? new Date().toISOString() : null,
      lastSeen: health ? new Date().toISOString() : null,
    }),
  };
}

async function listAgents(options = {}) {
  const requestedSelectedNodeId = typeof options.nodeId === "string"
    ? options.nodeId.trim()
    : typeof options.selectedNodeId === "string" ? options.selectedNodeId.trim() : "";
  const selectedNodeId = requestedSelectedNodeId || getSelectedNodeId();
  const selectedNode = getNode(selectedNodeId);
  const registeredRemoteSelected = selectedNode?.kind === "agent" && selectedNode.localAgent !== true;
  const local = await getStatus({ ...options, skipProbe: registeredRemoteSelected });
  const effective = agentClient.getEffectiveAgentSettings();
  const configuredUrlKey = effective.backendMode === "agent" ? normalizeAgentUrlForComparison(effective.agentUrl) : null;
  const selectedNodeUrlKey = selectedNode?.kind === "agent" ? normalizeAgentUrlForComparison(selectedNode.agentUrl || selectedNode.baseUrl) : null;
  const configuredMatchesSelectedNode = Boolean(configuredUrlKey && selectedNodeUrlKey && configuredUrlKey === selectedNodeUrlKey);
  const configured = await getConfiguredAgentStatus({ skipProbe: registeredRemoteSelected || configuredMatchesSelectedNode });
  const remote = await Promise.all(getAllNodesSync().filter((node) => node.kind === "agent").map(async (node) => {
    const healthConfig = getRemoteHealthConfig(node, selectedNodeId);
    if (registeredRemoteSelected && node.id !== selectedNodeId) {
      return {
        local: false,
        targetType: healthConfig.targetLabel,
        healthTargetLabel: healthConfig.targetLabel,
        nodeId: node.id,
        state: "Registered",
        name: node.displayName,
        agentUrl: node.agentUrl || node.baseUrl || null,
        identity: node.agentIdentity,
        agentVersion: node.agentIdentity?.agentVersion || null,
        latencyMs: null,
        mostRecentError: { code: "NOT_SELECTED", message: "Another registered node is selected; this node was not probed." },
        agentStatus: createAgentControlStatusSnapshot(node, {
          state: AGENT_STATUS.OFFLINE,
          connected: false,
          reachable: null,
          message: "Another registered node is selected; this node was not probed.",
          targetId: node.id,
          targetType: "registered-node",
        }),
      };
    }
    const started = Date.now();
    try {
      const health = await agentClient.getHealth(healthConfig);
      let stats = null;
      let partialFailure = null;
      if (node.id === selectedNodeId) {
        try {
          stats = await agentClient.getSystemStats(healthConfig);
          logRuntimePayloadShape(`${healthConfig.targetLabel}-stats`, stats);
        } catch (statsError) {
          if (statsError.status === 401 || statsError.code === "UNAUTHORIZED") {
            const authError = new Error(`${node.displayName || node.name || node.id} credential rejected`);
            authError.code = statsError.code || "UNAUTHORIZED";
            authError.status = statsError.status || 401;
            throw authError;
          }
          partialFailure = { code: statsError.code || null, message: statsError.message || "Agent metrics endpoint unavailable." };
        }
      }
      const runtime = normalizeAgentRuntimeStatus({
        base: { agentUrl: node.agentUrl || node.baseUrl, agentVersion: health.identity?.agentVersion, partialFailure },
        health,
        stats,
        service: { state: "running", installed: true },
        latencyMs: Date.now() - started,
        connected: true,
        reachable: true,
        capabilities: { metrics: Boolean(stats), lifecycle: false, repair: false, reconnect: true },
      });
      const statusCheckedAt = new Date().toISOString();
      const canonicalNode = recordAuthenticatedNodeHealth({
        nodeId: node.id,
        agentUrl: node.agentUrl || node.baseUrl,
        health,
        latencyMs: Date.now() - started,
        checkedAt: statusCheckedAt,
        message: partialFailure
          ? `Authenticated Agent health recovered; metrics remain degraded: ${partialFailure.message}`
          : "Authenticated Agent endpoint responded from Agent Control.",
      });
      return {
        local: false,
        targetType: healthConfig.targetLabel,
        healthTargetLabel: healthConfig.targetLabel,
        nodeId: canonicalNode.id,
        state: "Running",
        name: node.displayName,
        agentUrl: node.agentUrl,
        identity: health.identity,
        agentVersion: health.identity?.agentVersion,
        runtime,
        latencyMs: Date.now() - started,
        lastHeartbeat: statusCheckedAt,
        agentStatus: createAgentControlStatusSnapshot(node, {
          state: partialFailure ? AGENT_STATUS.DEGRADED : AGENT_STATUS.CONNECTED,
          connected: !partialFailure,
          reachable: true,
          partialFailure,
          message: partialFailure?.message || "An authenticated Agent endpoint responded successfully.",
          targetId: node.id,
          targetType: "registered-node",
          checkedAt: statusCheckedAt,
          lastSeen: statusCheckedAt,
        }),
      };
    } catch (error) {
      const agentStatusState = classifyAgentError(error);
      return {
        local: false,
        targetType: healthConfig.targetLabel,
        healthTargetLabel: healthConfig.targetLabel,
        nodeId: node.id,
        state: error.status === 401 ? "Authentication failed" : "Unreachable",
        name: node.displayName,
        agentUrl: node.agentUrl,
        identity: node.agentIdentity,
        mostRecentError: { code: error.code || null, message: error.message },
        agentStatus: createAgentControlStatusSnapshot(node, {
          state: agentStatusState,
          authenticated: agentStatusState === AGENT_STATUS.AUTHENTICATION_REQUIRED ? false : null,
          message: error.message,
          targetId: node.id,
          targetType: "registered-node",
        }),
      };
    }
  }));
  diagnostics.updateRuntimeState({
    localAgentProcessStatus: local.state,
    localAgentServiceStatus: local.service?.state,
    configuredAgentUrl: effective.backendMode === "agent" ? effective.agentUrl : null,
    selectedAgentId: selectedNodeId,
    connectedAgents: [
      ...(configured.running ? [{ nodeId: null, deviceId: configured.identity?.deviceId, state: configured.state, version: configured.agentVersion, target: "global-configured-agent" }] : []),
      ...remote.map((agent) => ({ nodeId: agent.nodeId, deviceId: agent.identity?.deviceId, state: agent.state, version: agent.agentVersion })),
    ],
    recentConnectionResult: [
      { target: "local-agent", url: local.agentUrl, state: local.state, latencyMs: local.latencyMs || null },
      { target: "global-configured-agent", url: configured.agentUrl, state: configured.state, latencyMs: configured.latencyMs || null },
      ...remote.map((agent) => ({ target: agent.healthTargetLabel, nodeId: agent.nodeId, url: agent.agentUrl, state: agent.state, latencyMs: agent.latencyMs || null })),
    ],
  });
  const activeRemote = remote.find((agent) => agent.nodeId === selectedNodeId) || null;
  const activeNode = {
    id: selectedNode.id,
    kind: selectedNode.kind,
    name: selectedNode.displayName || selectedNode.name || selectedNode.id,
    displayName: selectedNode.displayName || selectedNode.name || selectedNode.id,
    agentUrl: selectedNode.kind === "agent" ? selectedNode.agentUrl || selectedNode.baseUrl || null : null,
    platform: selectedNode.platform || selectedNode.agentIdentity?.platform || selectedNode.applicationHost?.platform || null,
    hostname: selectedNode.hostname || selectedNode.agentIdentity?.hostname || selectedNode.applicationHost?.hostname || null,
  };
  return {
    local,
    configured,
    remote,
    selectedNodeId,
    activeNode,
    activeAgent: selectedNode.kind === "agent" ? activeRemote : null,
    nodeState: await listNodes({ discoverLocalAgent: false, refreshIdentity: false }),
  };
}

async function captureRemoteDiagnostics(nodeId) {
  const node = getAllNodesSync().find((entry) => entry.id === nodeId && entry.kind === "agent");
  if (!node) throw Object.assign(new Error("Remote Agent node was not found."), { code: "NODE_NOT_FOUND" });
  const cached = remoteDiagnosticsCache.get(node.id);
  if (cached && Date.now() - cached.capturedAt < REMOTE_DIAGNOSTICS_CACHE_MS) {
    return { ...cached.result, cached: true };
  }
  if (remoteDiagnosticsRequests.has(node.id)) {
    return remoteDiagnosticsRequests.get(node.id);
  }
  const request = (async () => {
    const bundle = await agentClient.getDiagnostics(getNodeAgentConfig(node.id));
    const safeId = String(bundle.identity?.deviceId || node.id).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
    const directory = path.join(diagnostics.getDirectory(), "remote", safeId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "diagnostics.json"), `${JSON.stringify(require("../shared/redaction").sanitizeForDiagnostics(bundle), null, 2)}\n`, { mode: 0o600 });
    const result = { captured: true, nodeId: node.id, deviceId: safeId };
    remoteDiagnosticsCache.set(node.id, { capturedAt: Date.now(), result });
    diagnostics.log("info", "agent-control", "remote-diagnostics", "Remote Agent diagnostics captured", { nodeId: node.id, deviceId: safeId }, { file: "agent" });
    return result;
  })();
  remoteDiagnosticsRequests.set(node.id, request);
  try {
    return await request;
  } finally {
    remoteDiagnosticsRequests.delete(node.id);
  }
}

async function runDiagnostics() {
  const status = await getStatus();
  const config = readConfig();
  const effective = agentClient.getEffectiveAgentSettings();
  const localAgentOptional = effective.backendMode === "agent";
  const portUsed = await probePort(config.port);
  const registrationStatus = getRegistrationStatusFromServiceState(status.service);
  const storage = getLocalAgentStorageDiagnostics();
  const dependencySummary = status.running ? await getLocalAgentDependencyDiagnostics(config) : { checked: false, message: "Local Agent is not running." };
  const update = status.update || getLocalAgentUpdateState(status);
  const serviceRequiresElevation = Boolean(status.service?.requiresElevation && ["missing", "invalid", "unverifiable"].includes(registrationStatus));
  const serviceResult = registrationStatus === "valid"
    ? "Passed"
    : registrationStatus === "unsupported"
      ? "Not applicable"
      : serviceRequiresElevation
        ? "Blocked"
        : "Warning";
  const checks = [
    {
      id: "desktop-version",
      label: "Desktop version",
      result: status.appVersion ? "Passed" : "Warning",
      explanation: `Desktop version ${status.appVersion || "unavailable"}.`,
    },
    {
      id: "agent-version",
      label: "Agent version",
      result: update.agentNewerThanDesktop ? "Warning" : update.updateAvailable ? "Warning" : status.agentVersion ? "Passed" : "Warning",
      explanation: update.updateAvailable
        ? `Local Agent Update Available: ${update.installedVersion || "unknown"} -> ${update.bundledVersion}.`
        : update.agentNewerThanDesktop
          ? `Local Agent ${update.installedVersion} is newer than the bundled Desktop Agent ${update.bundledVersion}.`
          : `Local Agent version ${status.agentVersion || "unavailable"}.`,
      repairAction: update.updateAvailable ? "updateAgent" : null,
    },
    {
      id: "endpoint",
      label: "Local endpoint",
      result: status.agentUrl ? "Passed" : "Warning",
      explanation: status.agentUrl ? `Local endpoint ${status.agentUrl}.` : "Local Agent endpoint is not configured.",
    },
    {
      id: "process",
      label: "Agent process",
      result: status.running ? "Passed" : localAgentOptional ? "Not applicable" : "Warning",
      explanation: status.running
        ? "Local Agent is responding."
        : localAgentOptional
          ? "Local Agent is stopped, but a remote Agent backend is selected."
          : "Local Agent is not currently running.",
      repairAction: status.running || localAgentOptional ? null : "start",
    },
    {
      id: "running-since",
      label: "Running since",
      result: status.running && Number.isFinite(status.uptime) ? "Passed" : status.running ? "Warning" : "Not applicable",
      explanation: status.running && Number.isFinite(status.uptime)
        ? `Agent uptime is ${Math.round(status.uptime)} seconds.`
        : status.running
          ? "Agent is running, but uptime is unavailable."
          : "Agent is not running.",
    },
    {
      id: "service",
      label: "Service registration",
      result: serviceResult,
      explanation: registrationStatus === "valid"
        ? "Background startup registration exists and matches the current Agent command."
        : registrationStatus === "invalid"
          ? "Background startup registration exists but does not match the current Agent command."
          : registrationStatus === "unverifiable"
            ? "Windows would not allow AnxOS to verify the startup registration."
            : registrationStatus === "missing"
              ? "Background startup is not installed."
              : "Background startup is not supported on this platform.",
      repairAction: status.service?.supported && registrationStatus !== "valid" ? "install-service" : null,
      code: serviceRequiresElevation ? "ELEVATION_REQUIRED" : undefined,
      recoverySuggestion: serviceRequiresElevation ? "Run AnxOS Control Center as Administrator, then install the Agent service again." : undefined,
      registrationStatus,
      requiresElevation: serviceRequiresElevation,
      elevated: status.service?.privilege?.elevated ?? null,
    },
    {
      id: "port",
      label: "Port availability",
      result: status.running || !portUsed ? "Passed" : "Failed",
      explanation: status.running ? "Agent owns the configured port." : portUsed ? "Another process is using the configured port." : "Configured port is available.",
      repairAction: portUsed && !status.running ? "select-port" : null,
    },
    {
      id: "local-pairing",
      label: "Local pairing",
      result: status.pairing?.configured && status.pairing?.localOnly ? "Passed" : "Warning",
      explanation: status.pairing?.configured && status.pairing?.localOnly
        ? `Desktop credentials are paired locally. Fingerprint ${status.pairing.fingerprint || "available"}.`
        : "Local Agent credentials need to be paired or repaired on this computer.",
      repairAction: status.pairing?.configured && status.pairing?.localOnly ? null : "repair-pairing",
    },
    {
      id: "filesystem-access",
      label: "Filesystem access",
      result: fs.existsSync(getAgentInstancesDirectory()) && fs.existsSync(getAgentBackupsDirectory()) ? "Passed" : "Warning",
      explanation: `Instances and backups paths are ${fs.existsSync(getAgentInstancesDirectory()) && fs.existsSync(getAgentBackupsDirectory()) ? "available" : "not fully available"}.`,
      paths: {
        instances: getAgentInstancesDirectory(),
        backups: getAgentBackupsDirectory(),
      },
      repairAction: "repair-permissions",
    },
    {
      id: "disk-space",
      label: "Disk space",
      result: storage.disk.instances.availableBytes === null ? "Warning" : "Passed",
      explanation: storage.disk.instances.availableBytes === null
        ? "Disk space could not be inspected."
        : `Instance storage has ${Math.round(storage.disk.instances.availableBytes / 1024 / 1024)} MB available.`,
    },
    {
      id: "dependencies",
      label: "Dependency summary",
      result: dependencySummary.checked ? "Passed" : "Warning",
      explanation: dependencySummary.checked
        ? dependencySummary.dependencies.map((dependency) => `${dependency.name}: ${dependency.state}`).join(", ") || "No dependency details returned."
        : dependencySummary.message || "Dependency diagnostics unavailable.",
      repairAction: dependencySummary.checked ? null : "rescan-dependencies",
    },
    {
      id: "update-compatibility",
      label: "Update compatibility",
      result: update.compatible ? "Passed" : "Warning",
      explanation: update.state || "Update compatibility unknown.",
      repairAction: update.updateAvailable ? "updateAgent" : null,
    },
    { id: "configuration", label: "Configuration validity", result: "Passed", explanation: `Configuration is valid for ${config.host}:${config.port}.` },
    { id: "logs", label: "Log directory", result: fs.existsSync(diagnostics.getDirectory()) ? "Passed" : "Warning", explanation: "Diagnostics directory is writable." },
  ];
  return {
    status,
    checks,
    summary: {
      desktopVersion: status.appVersion,
      agentVersion: status.agentVersion,
      serviceStatus: status.service?.state || null,
      localEndpoint: status.agentUrl,
      authenticationStatus: status.pairing?.configured ? "Paired" : "Repair Required",
      tokenFingerprint: status.pairing?.fingerprint || null,
      portAvailable: !portUsed || status.running,
      storagePaths: storage.paths,
      diskSpace: storage.disk,
      dependencySummary,
      updateCompatibility: update,
      recentLogs: getRecentSanitizedAgentLogs(),
    },
    generatedAt: new Date().toISOString(),
  };
}
async function openLogs() { await diagnostics.openFolder(); return { opened: true }; }
async function openDataFolder() { fs.mkdirSync(getAgentDataDirectory(), { recursive: true }); await shell.openPath(getAgentDataDirectory()); return { opened: true }; }

module.exports = {
  _test: {
    agentEnvironment,
    buildWindowsAgentTaskDefinition,
    buildWindowsTaskInspectionScript,
    buildWindowsTaskRegistrationScript,
    classifyLegacyWindowsServiceOwnership,
    classifyWindowsTaskOwnership,
    compareVersions,
    expectedWindowsServiceCommand,
    getAgentScript,
    inspectWindowsAgentScheduledTask,
    getLocalAgentUpdateState,
    getRegistrationStatusFromServiceState,
    getLocalAgentStartupSummary,
    isVerifiedOldLocalAgentProcess,
    parseWindowsNetstatListener,
  },
  captureRemoteDiagnostics,
  getAgentDataDirectory,
  getRuntimeConfigPath,
  getStatus,
  installService,
  installLocalAgent,
  listAgents,
  openDataFolder,
  openLogs,
  pairLocalAgentSecurely,
  readConfig,
  resetConfig,
  restart,
  restoreConfigBackup,
  runDiagnostics,
  saveConfig,
  setAutoStart,
  startPairingSession,
  start,
  stop,
  stopOldLocalAgentAndRepair,
  uninstallService,
  updateLocalAgent,
  validateConfig,
};
