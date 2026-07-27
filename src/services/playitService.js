const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const COMMAND_TIMEOUT_MS = 2200;
const CONTROL_COMMAND_TIMEOUT_MS = 15000;
const MAX_LOG_BYTES = 128 * 1024;
const PLAYIT_SERVICE_CANDIDATES = ["playit", "playit-agent"];
const PLAYIT_DOMAIN_PATTERN = /\b[a-z0-9][a-z0-9.-]*\.(?:playit\.(?:gg|cloud|fan)|ply\.gg)\b/gi;
const LOCAL_TARGET_PATTERN = /\b(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\d{1,3}(?:\.\d{1,3}){3}):\d{2,5}\b/i;
const SENSITIVE_KEY_PATTERN = /token|secret|password|credential|api[_-]?key/i;

function exec(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: options.timeout || COMMAND_TIMEOUT_MS, windowsHide: true, ...options }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        errorCode: error?.code || error?.name || null,
        stdout: stdout ? stdout.trim() : "",
        stderr: stderr ? stderr.trim() : "",
      });
    });
  });
}

function createPlayitError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, statusCode: details.statusCode || 400, ...details });
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function parseJsonArray(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function getConfigCandidates() {
  return unique([
    process.env.PLAYIT_CONFIG_PATH,
    path.join(process.cwd(), "playit.toml"),
    process.platform === "win32" && process.env.PROGRAMDATA ? path.join(process.env.PROGRAMDATA, "playit_gg", "playit.toml") : null,
    process.platform === "win32" && process.env.PROGRAMDATA ? path.join(process.env.PROGRAMDATA, "playit", "playit.toml") : null,
    process.platform === "win32" && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "playit_gg", "playit.toml") : null,
    process.platform === "win32" && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "playit", "playit.toml") : null,
    process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "playit_gg", "playit.toml") : null,
    process.platform === "win32" && process.env.APPDATA ? path.join(process.env.APPDATA, "playit", "playit.toml") : null,
    process.platform === "win32" ? null : path.join("/etc", "playit", "playit.toml"),
    path.join(os.homedir(), ".config", "playit_gg", "playit.toml"),
    path.join(os.homedir(), ".config", "playit", "playit.toml"),
    path.join(os.homedir(), ".playit", "playit.toml"),
  ]);
}

function getWindowsInstallCandidates() {
  if (process.platform !== "win32") {
    return [];
  }

  return unique([
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "playit_gg", "bin", "playit.exe") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "playit_gg", "playit.exe") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "playit", "playit.exe") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs", "playit", "playit", "playit.exe") : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "playit_gg", "bin", "playit.exe") : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "playit_gg", "playit.exe") : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "playit", "playit.exe") : null,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "playit", "playit", "playit.exe") : null,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "playit_gg", "bin", "playit.exe") : null,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "playit_gg", "playit.exe") : null,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "playit", "playit.exe") : null,
    process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "playit", "playit", "playit.exe") : null,
  ]);
}

function getLogCandidates() {
  return unique([
    process.env.PLAYIT_LOG_PATH,
    process.env.PROGRAMDATA ? path.join(process.env.PROGRAMDATA, "playit_gg", "logs", "playitd.log") : null,
    process.env.PROGRAMDATA ? path.join(process.env.PROGRAMDATA, "playit_gg", "logs", "playit.log") : null,
    process.env.PROGRAMDATA ? path.join(process.env.PROGRAMDATA, "playit", "logs", "playitd.log") : null,
    process.env.PROGRAMDATA ? path.join(process.env.PROGRAMDATA, "playit", "logs", "playit.log") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "playit_gg", "logs", "playitd.log") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "playit_gg", "logs", "playit.log") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "playit", "logs", "playitd.log") : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "playit", "logs", "playit.log") : null,
    path.join(os.homedir(), ".config", "playit_gg", "playit.log"),
    path.join(os.homedir(), ".config", "playit", "playit.log"),
    path.join(os.homedir(), ".playit", "playit.log"),
  ]);
}

function getEnvValue(keys) {
  for (const key of keys) {
    const value = process.env[key];

    if (value && !SENSITIVE_KEY_PATTERN.test(key)) {
      return value;
    }
  }

  return null;
}

function extractPlayitAddress(content) {
  const matches = content.match(PLAYIT_DOMAIN_PATTERN);
  return matches?.[0] || null;
}

function sanitizeCommandLine(value) {
  return String(value)
    .replace(/(\bAuthorization:\s*Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/(\bBearer\s+)\S+/gi, "$1[redacted]")
    .replace(/(--?(?:secret|token|password|credential|api[_-]?key)(?:=|\s+))\S+/gi, "$1[redacted]")
    .replace(/\b(?:secret|token|password|credential|api[_-]?key)\b\s*[:=]\s*\S+/gi, (match) => `${match.split(/[:=]/)[0]}=[redacted]`);
}

function isPlayitProcessLine(line) {
  const command = String(line || "").replace(/^\d+\s+/, "").trim();
  const executable = command.split(/\s+/)[0] || "";

  return /(?:^|[/\\])playitd?(?:\.exe)?$/i.test(executable);
}

function extractTunnelId(content) {
  const match = content.match(/\btunnel[_ -]?id\b\s*[:=]\s*["']?([a-z0-9-]{6,})/i);
  return match?.[1] || null;
}

function extractProtocol(content) {
  const match = content.match(/\b(?:protocol|proto)\b\s*[:=]\s*["']?(tcp|udp|http|https)\b/i);
  return match?.[1]?.toUpperCase() || null;
}

function splitHostPort(value) {
  if (!value) {
    return { ip: null, port: null };
  }

  const match = String(value).match(/^(.+):(\d{2,5})$/);

  if (!match) {
    return { ip: null, port: null };
  }

  return {
    ip: match[1],
    port: match[2],
  };
}

function extractLocalTarget(content) {
  const directMatch = content.match(/\b(?:local[_-]?address|local[_-]?addr|local[_-]?target|target|proxy[_-]?addr)\b\s*[:=]\s*["']?([^"'\s#]+)/i);

  if (directMatch?.[1] && LOCAL_TARGET_PATTERN.test(directMatch[1])) {
    return directMatch[1];
  }

  const hostMatch = content.match(/\b(?:local[_-]?host|host|ip)\b\s*[:=]\s*["']?([^"'\s#]+)/i);
  const portMatch = content.match(/\b(?:local[_-]?port|port)\b\s*[:=]\s*["']?(\d{2,5})/i);

  if (hostMatch?.[1] && portMatch?.[1]) {
    return `${hostMatch[1]}:${portMatch[1]}`;
  }

  return content.match(LOCAL_TARGET_PATTERN)?.[0] || null;
}

async function readFirstAvailable(candidates) {
  const diagnostics = [];

  for (const filePath of candidates) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      diagnostics.push({ path: filePath, found: true });
      return { path: filePath, content, diagnostics };
    } catch (error) {
      diagnostics.push({ path: filePath, found: false, errorCode: error?.code || null });
    }
  }

  return { path: null, content: "", diagnostics };
}

async function readSpecificFile(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return {
      content,
      diagnostics: {
        source: filePath,
        checked: true,
        ok: true,
        errorCode: null,
        hasOutput: Boolean(content),
      },
    };
  } catch (error) {
    return {
      content: "",
      diagnostics: {
        source: filePath,
        checked: true,
        ok: false,
        errorCode: error?.code || null,
        hasOutput: false,
        reason: error?.code === "EACCES" ? "unreadable" : "not_available",
      },
    };
  }
}

async function readPlayitJournal() {
  if (process.platform === "win32") {
    return {
      content: "",
      diagnostics: {
        source: "journalctl -u playit --no-pager -n 100",
        checked: false,
        ok: false,
        errorCode: null,
        hasOutput: false,
        reason: "not_linux",
      },
    };
  }

  const result = await exec("journalctl", ["-u", "playit", "--no-pager", "-n", "100"]);
  const content = [result.stdout, result.stderr].filter(Boolean).join("\n");

  return {
    content,
    diagnostics: {
      source: "journalctl -u playit --no-pager -n 100",
      checked: true,
      ok: result.ok,
      errorCode: result.errorCode,
      hasOutput: Boolean(content),
      reason: content.includes("-- No entries --") ? "no_visible_entries" : null,
    },
  };
}

async function findPlayitBinary() {
  const explicitBinary = process.env.PLAYIT_BINARY;

  if (explicitBinary) {
    try {
      await fs.access(explicitBinary);
      return {
        installed: true,
        path: explicitBinary,
        diagnostics: [{ method: "PLAYIT_BINARY", ok: true, errorCode: null }],
      };
    } catch (error) {
      return {
        installed: false,
        path: null,
        diagnostics: [{ method: "PLAYIT_BINARY", ok: false, errorCode: error?.code || null }],
      };
    }
  }

  if (process.platform === "win32") {
    return findWindowsPlayitBinary();
  }

  const command = "which";
  const result = await exec(command, ["playit"]);

  return {
    installed: result.ok && Boolean(result.stdout),
    path: result.stdout.split(/\r?\n/)[0] || null,
    diagnostics: [{ method: command, ok: result.ok, errorCode: result.errorCode }],
  };
}

async function findWindowsPlayitBinary() {
  const diagnostics = [];
  const whereResult = await exec("where.exe", ["playit"]);
  diagnostics.push({
    method: "where.exe playit",
    ok: whereResult.ok,
    errorCode: whereResult.errorCode,
    executablePath: whereResult.stdout.split(/\r?\n/)[0] || null,
  });

  if (whereResult.ok && whereResult.stdout) {
    return {
      installed: true,
      path: whereResult.stdout.split(/\r?\n/)[0],
      diagnostics,
      detectedBy: "where.exe playit",
      processId: null,
    };
  }

  for (const commandName of ["playit", "playit.exe"]) {
    const result = await exec("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Get-Command ${commandName} -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source`,
    ]);
    const executablePath = result.stdout.split(/\r?\n/)[0] || null;
    diagnostics.push({
      method: `Get-Command ${commandName}`,
      ok: result.ok && Boolean(executablePath),
      errorCode: result.errorCode,
      executablePath,
    });

    if (executablePath) {
      return {
        installed: true,
        path: executablePath,
        diagnostics,
        detectedBy: `Get-Command ${commandName}`,
        processId: null,
      };
    }
  }

  for (const candidatePath of getWindowsInstallCandidates()) {
    try {
      await fs.access(candidatePath);
      diagnostics.push({
        method: "common install path",
        ok: true,
        errorCode: null,
        executablePath: candidatePath,
      });

      return {
        installed: true,
        path: candidatePath,
        diagnostics,
        detectedBy: "common install path",
        processId: null,
      };
    } catch (error) {
      diagnostics.push({
        method: "common install path",
        ok: false,
        errorCode: error?.code || null,
        executablePath: candidatePath,
      });
    }
  }

  const processInfo = await getWindowsPlayitProcesses();
  diagnostics.push(processInfo.diagnostics);

  if (processInfo.processes.length > 0) {
    const process = processInfo.processes[0];

    return {
      installed: true,
      path: process.executablePath,
      diagnostics,
      detectedBy: "Get-CimInstance Win32_Process",
      processId: process.processId,
    };
  }

  return {
    installed: false,
    path: null,
    diagnostics,
    detectedBy: null,
    processId: null,
  };
}

function supportsCommand(helpOutput, commandName) {
  return new RegExp(`\\b${commandName}\\b`, "i").test(helpOutput);
}

async function getCliCommands(binaryPath) {
  if (!binaryPath) {
    return {
      help: "",
      accountHelp: "",
      diagnostics: [],
    };
  }

  const [help, accountHelp] = await Promise.all([
    exec(binaryPath, ["--help"]),
    exec(binaryPath, ["account", "--help"]),
  ]);

  return {
    help: help.stdout || help.stderr,
    accountHelp: accountHelp.stdout || accountHelp.stderr,
    diagnostics: [
      { command: "playit --help", ok: help.ok, errorCode: help.errorCode, hasOutput: Boolean(help.stdout || help.stderr) },
      {
        command: "playit account --help",
        ok: accountHelp.ok,
        errorCode: accountHelp.errorCode,
        hasOutput: Boolean(accountHelp.stdout || accountHelp.stderr),
      },
    ],
  };
}

async function runCliInspection(binaryPath, commands) {
  if (!binaryPath) {
    return {
      output: "",
      outputs: [],
      commandResults: [],
    };
  }

  const attempts = [
    ["playit tunnels", ["tunnels"], supportsCommand(commands.help, "tunnels")],
    [
      "playit account status",
      ["account", "status"],
      supportsCommand(commands.help, "account") && supportsCommand(commands.accountHelp, "status"),
    ],
    ["playit status", ["status"], supportsCommand(commands.help, "status")],
  ];

  const results = [];
  const output = [];
  const outputs = [];

  for (const [label, args, supported] of attempts) {
    const result = await exec(binaryPath, args);
    const content = [result.stdout, result.stderr].filter(Boolean).join("\n");
    outputs.push({
      command: label,
      content,
      ok: result.ok,
      errorCode: result.errorCode,
      supported,
    });
    results.push({
      command: label,
      ok: result.ok,
      errorCode: result.errorCode,
      supported,
      hasOutput: Boolean(content),
    });

    if (content) {
      output.push(`${label}\n${content}`);
    }
  }

  return {
    output: output.join("\n"),
    outputs,
    commandResults: results,
  };
}

function parseRunning(cliOutput, processRunning) {
  if (/service is not running|not running|stopped|offline/i.test(cliOutput)) {
    return false;
  }

  if (/service is running|running|online/i.test(cliOutput)) {
    return true;
  }

  return processRunning;
}

function getCliState(cliOutput) {
  if (!cliOutput) {
    return null;
  }

  if (/service is not running|not running|stopped|offline/i.test(cliOutput)) {
    return "inactive";
  }

  if (/service is running|running|online/i.test(cliOutput)) {
    return "active";
  }

  return "unknown";
}

function getSystemctlStatusState(output) {
  const match = String(output || "").match(/\bActive:\s*([^\n]+)/i);
  return match?.[1]?.trim() || null;
}

function isActiveSystemctlState(state) {
  return /^active\b/i.test(String(state || ""));
}

function parseConnected(cliOutput, tunnelAddress) {
  if (/not connected|disconnected|offline/i.test(cliOutput)) {
    return false;
  }

  if (/(connected|forwarding|tunnel.+active|online)/i.test(cliOutput)) {
    return true;
  }

  return null;
}

function getUnavailableReason(source) {
  if (source.diagnostics?.reason) {
    return source.diagnostics.reason;
  }

  if (source.diagnostics?.ok === false) {
    return source.diagnostics?.supported === false ? "unsupported" : "command_failed";
  }

  if (!source.content) {
    return "no_output";
  }

  return "metadata_not_found";
}

function getParsedFieldNames(parsed) {
  return Object.entries(parsed)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key);
}

function parseTunnelMetadataSource(content) {
  const tunnelAddress = extractPlayitAddress(content);
  const localTarget = extractLocalTarget(content);
  const localParts = splitHostPort(localTarget);

  return {
    tunnelAddress,
    localTarget,
    localIp: localParts.ip,
    localPort: localParts.port,
    protocol: extractProtocol(content),
    tunnelId: extractTunnelId(content),
  };
}

function mergeTunnelMetadata(sources) {
  const metadata = {
    tunnelAddress: null,
    localTarget: null,
    localIp: null,
    localPort: null,
    protocol: null,
    tunnelId: null,
  };
  const fieldSources = {};
  const diagnostics = [];

  for (const source of sources) {
    const parsed = parseTunnelMetadataSource(source.content || "");
    const parsedFields = getParsedFieldNames(parsed);

    for (const field of Object.keys(metadata)) {
      if (!metadata[field] && parsed[field]) {
        metadata[field] = parsed[field];
        fieldSources[field] = source.name;
      }
    }

    diagnostics.push({
      source: source.name,
      checked: source.diagnostics?.checked !== false,
      ok: source.diagnostics?.ok ?? true,
      errorCode: source.diagnostics?.errorCode || null,
      supported: source.diagnostics?.supported,
      hasOutput: Boolean(source.content),
      parsedFields,
      reason: parsedFields.length > 0 ? null : getUnavailableReason(source),
    });
  }

  if (metadata.localTarget && (!metadata.localIp || !metadata.localPort)) {
    const localParts = splitHostPort(metadata.localTarget);
    metadata.localIp = metadata.localIp || localParts.ip;
    metadata.localPort = metadata.localPort || localParts.port;
  }

  return {
    ...metadata,
    fieldSources,
    diagnostics,
  };
}

async function getLinuxPlayitProcessState(cliOutput) {
  const cliState = getCliState(cliOutput);
  const diagnostics = {
    method: null,
    detectionMethod: null,
    systemctlState: null,
    cliState,
    checks: [],
  };

  const isActiveResult = await exec("systemctl", ["is-active", "playit"]);
  const isActiveState = isActiveResult.stdout.split(/\r?\n/)[0] || null;
  diagnostics.systemctlState = isActiveState;
  diagnostics.checks.push({
    command: "systemctl is-active playit",
    ok: isActiveResult.ok,
    errorCode: isActiveResult.errorCode,
    state: isActiveState,
  });

  if (isActiveSystemctlState(isActiveState)) {
    diagnostics.method = "systemctl is-active playit";
    diagnostics.detectionMethod = "systemctl is-active playit";
    return {
      running: true,
      diagnostics,
    };
  }

  const statusResult = await exec("systemctl", ["status", "playit"]);
  const statusState = getSystemctlStatusState([statusResult.stdout, statusResult.stderr].filter(Boolean).join("\n"));
  diagnostics.systemctlState = statusState || diagnostics.systemctlState;
  diagnostics.checks.push({
    command: "systemctl status playit",
    ok: statusResult.ok,
    errorCode: statusResult.errorCode,
    state: statusState,
  });

  if (isActiveSystemctlState(statusState)) {
    diagnostics.method = "systemctl status playit";
    diagnostics.detectionMethod = "systemctl status playit";
    return {
      running: true,
      diagnostics,
    };
  }

  if (cliState === "active" || cliState === "inactive") {
    diagnostics.method = "playit status";
    diagnostics.detectionMethod = "playit status";
    return {
      running: cliState === "active",
      diagnostics,
    };
  }

  const pgrepResult = await exec("pgrep", ["-af", "playit"]);
  diagnostics.checks.push({
    command: "pgrep -af playit",
    ok: pgrepResult.ok,
    errorCode: pgrepResult.errorCode,
    hasOutput: Boolean(pgrepResult.stdout),
  });
  diagnostics.method = "pgrep -af playit";
  diagnostics.detectionMethod = "pgrep -af playit";

  return {
    running: pgrepResult.ok && Boolean(pgrepResult.stdout),
    diagnostics,
  };
}

async function isPlayitProcessRunning(cliOutput = "") {
  if (process.platform === "win32") {
    const processInfo = await getWindowsPlayitProcesses();

    return {
      running: processInfo.processes.length > 0,
      diagnostics: {
        ...processInfo.diagnostics,
        method: "Get-CimInstance Win32_Process",
        processIds: processInfo.processes.map((process) => process.processId).filter(Boolean),
        executablePaths: processInfo.processes.map((process) => process.executablePath).filter(Boolean),
      },
    };
  }

  return getLinuxPlayitProcessState(cliOutput);
}

async function getWindowsPlayitProcesses() {
  const cimResult = await exec("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^playit' -or $_.CommandLine -match 'playit' -or $_.ExecutablePath -match 'playit' } | Select-Object ProcessId,Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress",
  ]);
  const cimRows = parseJsonArray(cimResult.stdout);
  const cimProcesses = cimRows
    .map((row) => ({
      processId: row.ProcessId || null,
      name: row.Name || null,
      executablePath: row.ExecutablePath || null,
      commandLine: row.CommandLine || "",
    }))
    .filter((row) => [row.name, row.executablePath, row.commandLine].filter(Boolean).join(" ").match(/\bplayit(?:\.exe|d)?\b/i));

  const checks = [
    {
      method: "Get-CimInstance Win32_Process playit",
      ok: cimResult.ok,
      errorCode: cimResult.errorCode,
      hasOutput: cimProcesses.length > 0,
    },
  ];

  if (cimProcesses.length > 0) {
    return {
      processes: cimProcesses,
      diagnostics: checks[0],
    };
  }

  const getProcessResult = await exec("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "Get-Process -ErrorAction SilentlyContinue playit,playitd | Select-Object Id,ProcessName,Path | ConvertTo-Json -Compress",
  ]);
  const getProcessRows = parseJsonArray(getProcessResult.stdout);
  const getProcessProcesses = getProcessRows
    .map((row) => ({
      processId: row.Id || null,
      name: row.ProcessName || null,
      executablePath: row.Path || null,
      commandLine: "",
    }))
    .filter((row) => [row.name, row.executablePath].filter(Boolean).join(" ").match(/\bplayit(?:\.exe|d)?\b/i));

  checks.push({
    method: "Get-Process playit,playitd",
    ok: getProcessResult.ok,
    errorCode: getProcessResult.errorCode,
    hasOutput: getProcessProcesses.length > 0,
  });

  if (getProcessProcesses.length > 0) {
    return {
      processes: getProcessProcesses,
      diagnostics: {
        method: "Get-Process playit,playitd",
        ok: getProcessResult.ok,
        errorCode: getProcessResult.errorCode,
        hasOutput: true,
        checks,
      },
    };
  }

  const tasklistResult = await exec("tasklist.exe", ["/FO", "CSV"]);
  const tasklistLines = tasklistResult.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => /\bplayit(?:d)?\.exe\b/i.test(line));
  const tasklistProcesses = tasklistLines.map((line) => ({
    processId: null,
    name: line.replace(/^"([^"]+)".*$/, "$1") || null,
    executablePath: null,
    commandLine: "",
  }));

  checks.push({
    method: "tasklist.exe /FO CSV",
    ok: tasklistResult.ok,
    errorCode: tasklistResult.errorCode,
    hasOutput: tasklistProcesses.length > 0,
  });

  if (tasklistProcesses.length > 0) {
    return {
      processes: tasklistProcesses,
      diagnostics: {
        method: "tasklist.exe /FO CSV",
        ok: tasklistResult.ok,
        errorCode: tasklistResult.errorCode,
        hasOutput: true,
        checks,
      },
    };
  }

  return {
    processes: [],
    diagnostics: {
      method: "Get-CimInstance Win32_Process playit",
      ok: cimResult.ok,
      errorCode: cimResult.errorCode,
      hasOutput: false,
      checks,
    },
  };
}

async function getPlayitProcessCommandLines() {
  if (process.platform === "win32") {
    const processInfo = await getWindowsPlayitProcesses();

    return {
      content: processInfo.processes.map((process) => process.commandLine).filter(Boolean).join("\n"),
      diagnostics: {
        command: "Get-CimInstance Win32_Process playit CommandLine",
        ok: processInfo.diagnostics.ok,
        errorCode: processInfo.diagnostics.errorCode,
        hasOutput: processInfo.processes.length > 0,
        processIds: processInfo.processes.map((process) => process.processId).filter(Boolean),
        executablePaths: processInfo.processes.map((process) => process.executablePath).filter(Boolean),
        commandLines: processInfo.processes.map((process) => sanitizeCommandLine(process.commandLine)).filter(Boolean),
      },
    };
  }

  const result =
    await exec("pgrep", ["-af", "playit"]);
  const rawOutput = result.stdout || "";
  const lines = rawOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(isPlayitProcessLine);

  return {
    content: lines.join("\n"),
    diagnostics: {
      command:
        process.platform === "win32"
          ? "Get-CimInstance Win32_Process playit CommandLine"
          : "pgrep -af playit",
      ok: result.ok,
      errorCode: result.errorCode,
      hasOutput: lines.length > 0,
      commandLines: lines.map(sanitizeCommandLine),
    },
  };
}

async function getPlayitSnapshot() {
  const [binary, configResult, logResult] = await Promise.all([
    findPlayitBinary(),
    readFirstAvailable(getConfigCandidates()),
    readFirstAvailable(getLogCandidates()),
  ]);
  const [commands, processCommandLines] = await Promise.all([
    getCliCommands(binary.path),
    getPlayitProcessCommandLines(),
  ]);
  const cli = await runCliInspection(binary.path, commands);
  const processState = await isPlayitProcessRunning(cli.output);
  const [systemConfig, journal] = await Promise.all([
    process.platform === "win32"
      ? Promise.resolve({
          content: "",
          diagnostics: {
            source: "/etc/playit/playit.toml",
            checked: false,
            ok: false,
            errorCode: null,
            hasOutput: false,
            reason: "not_linux",
          },
        })
      : readSpecificFile(path.join("/etc", "playit", "playit.toml")),
    readPlayitJournal(),
  ]);
  const combinedContent = [configResult.content, logResult.content].filter(Boolean).join("\n");
  const metadataSources = [
    ...cli.outputs.map((output) => ({
      name: output.command,
      content: output.content,
      diagnostics: {
        checked: true,
        ok: output.ok,
        errorCode: output.errorCode,
        supported: output.supported,
        reason: output.supported === false ? "unsupported" : null,
      },
    })),
    {
      name: configResult.path || "playit config file",
      content: configResult.content,
      diagnostics: {
        checked: true,
        ok: Boolean(configResult.path),
        errorCode: configResult.path ? null : configResult.diagnostics?.find((item) => item.found === false)?.errorCode || null,
        hasOutput: Boolean(configResult.content),
        reason: configResult.path ? null : "not_found",
      },
    },
    {
      name: logResult.path || "playit log file",
      content: logResult.content,
      diagnostics: {
        checked: true,
        ok: Boolean(logResult.path),
        errorCode: logResult.path ? null : logResult.diagnostics?.find((item) => item.found === false)?.errorCode || null,
        hasOutput: Boolean(logResult.content),
        reason: logResult.path ? null : "not_found",
      },
    },
    {
      name: "/etc/playit/playit.toml",
      content: systemConfig.content,
      diagnostics: systemConfig.diagnostics,
    },
    {
      name: "journalctl -u playit --no-pager -n 100",
      content: journal.content,
      diagnostics: journal.diagnostics,
    },
  ];
  const tunnelMetadata = mergeTunnelMetadata(metadataSources);
  const inspectionContent = [cli.output, processCommandLines.content, combinedContent].filter(Boolean).join("\n");
  const tunnelAddress =
    tunnelMetadata.tunnelAddress ||
    getEnvValue(["PLAYIT_ADDRESS", "PLAYIT_TUNNEL_ADDRESS", "PLAYIT_DOMAIN"]) ||
    extractPlayitAddress(inspectionContent);
  const localTarget =
    tunnelMetadata.localTarget ||
    getEnvValue(["PLAYIT_LOCAL_TARGET", "PLAYIT_TARGET", "PLAYIT_LOCAL_ADDRESS"]) ||
    extractLocalTarget(inspectionContent);
  const localParts = {
    ip: tunnelMetadata.localIp,
    port: tunnelMetadata.localPort,
    ...splitHostPort(localTarget),
  };
  const running = process.platform === "win32" ? (binary.installed ? parseRunning(cli.output, processState.running) : false) : processState.running;
  const connected = binary.installed && running
    ? parseConnected(cli.output, tunnelAddress || localTarget || tunnelMetadata.tunnelId)
    : false;

  return {
    installed: binary.installed,
    running,
    connected,
    tunnelAddress: tunnelAddress || null,
    tunnelDomain: tunnelAddress ? tunnelAddress.split(":")[0] : null,
    localTarget: localTarget || null,
    localIp: localParts.ip,
    localPort: localParts.port,
    protocol: tunnelMetadata.protocol || getEnvValue(["PLAYIT_PROTOCOL"]) || extractProtocol(inspectionContent),
    tunnelId: tunnelMetadata.tunnelId || getEnvValue(["PLAYIT_TUNNEL_ID"]) || extractTunnelId(inspectionContent),
    lastCheckedAt: new Date().toISOString(),
    lastSuccessfulRefreshAt: binary.installed && cli.commandResults.some((result) => result.ok) ? new Date().toISOString() : null,
    diagnostics: {
      binaryPath: binary.path,
      binaryDetectedBy: binary.detectedBy || binary.diagnostics.find((item) => item.ok)?.method || null,
      binaryProcessId: binary.processId || null,
      binaryChecks: binary.diagnostics,
      commandDiscovery: commands.diagnostics,
      commandResults: cli.commandResults,
      detectionMethod: processState.diagnostics.detectionMethod || processState.diagnostics.method || null,
      systemctlState: processState.diagnostics.systemctlState || null,
      cliState: processState.diagnostics.cliState || null,
      process: processState.diagnostics,
      processCommandLines: processCommandLines.diagnostics,
      tunnelMetadataSources: tunnelMetadata.diagnostics,
      tunnelMetadataFieldSources: tunnelMetadata.fieldSources,
      configFiles: configResult.diagnostics,
      logFiles: logResult.diagnostics,
      configPathUsed: configResult.path,
      logPathUsed: logResult.path,
      addressSource: tunnelMetadata.fieldSources.tunnelAddress || (tunnelAddress ? "env_or_local_file" : null),
      localTargetSource: tunnelMetadata.fieldSources.localTarget || (localTarget ? "env_or_local_file" : null),
    },
  };
}

function normalizeServiceState(value, runningFallback = false) {
  const text = String(value || "").trim().toLowerCase();
  if (/^(active|running)$/.test(text)) return "running";
  if (/^(failed|error)$/.test(text)) return "failed";
  if (/^(inactive|stopped|dead)$/.test(text)) return "stopped";
  if (/not[-_\s]?found|could not be found|no such/i.test(text)) return "service-not-found";
  return runningFallback ? "running" : "unknown";
}

async function inspectSystemdService(name, user = false) {
  if (process.platform === "win32") return null;
  const prefix = user ? ["--user"] : [];
  const [active, enabled] = await Promise.all([
    exec("systemctl", [...prefix, "is-active", name], { timeout: CONTROL_COMMAND_TIMEOUT_MS }),
    exec("systemctl", [...prefix, "is-enabled", name], { timeout: CONTROL_COMMAND_TIMEOUT_MS }),
  ]);
  const output = [active.stdout, active.stderr, enabled.stdout, enabled.stderr].filter(Boolean).join("\n");
  const found = active.ok || enabled.ok || !/not-found|not loaded|could not be found|no such/i.test(output);
  return {
    manager: user ? "systemd-user" : "systemd",
    name,
    found,
    state: found ? normalizeServiceState(active.stdout || active.stderr) : "service-not-found",
    enabled: enabled.ok ? enabled.stdout.split(/\r?\n/)[0] || "enabled" : null,
    diagnostics: {
      active: { ok: active.ok, errorCode: active.errorCode, output: sanitizeCommandLine(active.stdout || active.stderr) },
      enabled: { ok: enabled.ok, errorCode: enabled.errorCode, output: sanitizeCommandLine(enabled.stdout || enabled.stderr) },
    },
  };
}

async function inspectWindowsService(name) {
  if (process.platform !== "win32") return null;
  const script = `Get-Service -Name ${JSON.stringify(name)} -ErrorAction SilentlyContinue | Select-Object -First 1 Name,Status | ConvertTo-Json -Compress`;
  const result = await exec("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: CONTROL_COMMAND_TIMEOUT_MS });
  let parsed = null;
  try { parsed = result.stdout ? JSON.parse(result.stdout) : null; } catch {}
  return {
    manager: "windows-service",
    name,
    found: Boolean(parsed?.Name),
    state: parsed?.Status ? normalizeServiceState(parsed.Status) : "service-not-found",
    enabled: null,
    diagnostics: { query: { ok: result.ok, errorCode: result.errorCode, hasOutput: Boolean(result.stdout), stderr: sanitizeCommandLine(result.stderr) } },
  };
}

async function detectPlayitService() {
  const checks = [];
  if (process.platform === "win32") {
    for (const name of PLAYIT_SERVICE_CANDIDATES) {
      const check = await inspectWindowsService(name);
      checks.push(check);
      if (check?.found) return { selected: check, checks };
    }
    return { selected: null, checks };
  }
  for (const user of [false, true]) {
    for (const name of PLAYIT_SERVICE_CANDIDATES) {
      const check = await inspectSystemdService(name, user);
      checks.push(check);
      if (check?.found) return { selected: check, checks };
    }
  }
  return { selected: null, checks };
}

async function getPlayitStatus() {
  const snapshot = await getPlayitSnapshot();
  const service = await getPlayitServiceStatusFromSnapshot(snapshot);
  return {
    ...snapshot,
    service,
    serviceState: service.state,
    lastCheckedAt: service.lastCheckedAt,
    diagnostics: {
      ...snapshot.diagnostics,
      service: service.diagnostics,
    },
  };
}

async function getPlayitServiceStatusFromSnapshot(snapshot = null) {
  const checkedAt = new Date().toISOString();
  const current = snapshot || await getPlayitSnapshot();
  const detected = await detectPlayitService();
  const selected = detected.selected;
  const installed = Boolean(current.installed);
  const fallbackState = current.running ? "running" : installed ? "stopped" : "missing";
  const state = selected?.found ? normalizeServiceState(selected.state, current.running) : fallbackState;
  return {
    installed,
    running: state === "running" || current.running === true,
    state,
    serviceName: selected?.name || null,
    manager: selected?.manager || null,
    lastCheckedAt: checkedAt,
    message: !installed
      ? "Playit is not installed on this system."
      : selected?.found
        ? `Playit service is ${state}.`
        : current.running
          ? "Playit process is running; no managed service was found."
          : "Playit is installed, but no managed service was found.",
    diagnostics: { checks: detected.checks, fallbackProcessRunning: current.running === true },
  };
}

async function runServiceControl(action) {
  if (!["start", "stop", "restart"].includes(action)) {
    throw createPlayitError("PLAYIT_ACTION_UNSUPPORTED", "Unsupported Playit action.", { statusCode: 400 });
  }
  const snapshot = await getPlayitSnapshot();
  if (!snapshot.installed) {
    throw createPlayitError("PLAYIT_NOT_INSTALLED", "Playit is not installed on this system.", { statusCode: 404 });
  }
  const detected = await detectPlayitService();
  const selected = detected.selected;
  if (!selected?.found) {
    throw createPlayitError("PLAYIT_SERVICE_NOT_FOUND", "No managed Playit service was found for this system.", {
      statusCode: 404,
      diagnostics: { checks: detected.checks },
    });
  }
  let result;
  if (selected.manager === "windows-service") {
    const verb = action === "start" ? "Start-Service" : action === "stop" ? "Stop-Service" : "Restart-Service";
    result = await exec("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `${verb} -Name ${JSON.stringify(selected.name)} -ErrorAction Stop`], { timeout: CONTROL_COMMAND_TIMEOUT_MS });
  } else {
    const prefix = selected.manager === "systemd-user" ? ["--user"] : [];
    result = await exec("systemctl", [...prefix, action, selected.name], { timeout: CONTROL_COMMAND_TIMEOUT_MS });
  }
  if (!result.ok) {
    const code = action === "start" ? "PLAYIT_START_FAILED" : action === "stop" ? "PLAYIT_STOP_FAILED" : "PLAYIT_RESTART_FAILED";
    throw createPlayitError(code, `Playit ${action} failed.`, {
      statusCode: 500,
      diagnostics: { service: selected, errorCode: result.errorCode, stderr: sanitizeCommandLine(result.stderr), stdout: sanitizeCommandLine(result.stdout) },
    });
  }
  return { ok: true, action, service: selected, status: await getPlayitStatus() };
}

function startPlayit() {
  return runServiceControl("start");
}

function stopPlayit() {
  return runServiceControl("stop");
}

function restartPlayit() {
  return runServiceControl("restart");
}

async function getPlayitLogs(options = {}) {
  const snapshot = await getPlayitSnapshot();
  const candidates = unique([
    snapshot.diagnostics?.logPathUsed,
    process.env.PLAYIT_LOG_PATH,
    process.platform === "win32" ? null : "/var/log/playit/playit.log",
  ]);
  const logResult = await readFirstAvailable(candidates);
  const content = String(logResult.content || "").slice(-MAX_LOG_BYTES);
  if (!content) {
    return {
      ok: false,
      code: "PLAYIT_LOGS_UNAVAILABLE",
      message: "Playit logs are unavailable for this install.",
      lines: [],
      diagnostics: { files: logResult.diagnostics },
    };
  }
  const limit = Number.parseInt(options.limit, 10);
  const maxLines = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 400) : 200;
  return {
    ok: true,
    lines: content.split(/\r?\n/).filter(Boolean).slice(-maxLines).map(sanitizeCommandLine),
    lastCheckedAt: new Date().toISOString(),
  };
}

function normalizeTunnelFromSnapshot(snapshot = {}) {
  const localParts = splitHostPort(snapshot.localTarget);
  const publicParts = splitHostPort(snapshot.tunnelAddress);
  return {
    id: String(snapshot.tunnelId || snapshot.tunnelAddress || `playit-${snapshot.localPort || "tunnel"}`).replace(/\s+/g, "-"),
    name: snapshot.tunnelAddress || snapshot.tunnelDomain || snapshot.tunnelId || "Playit tunnel",
    status: snapshot.connected === false ? "unknown" : snapshot.running ? "online" : "offline",
    type: snapshot.protocol || "custom",
    protocol: snapshot.protocol || null,
    localHost: snapshot.localIp || localParts.ip || null,
    localPort: Number(snapshot.localPort || localParts.port) || null,
    publicHost: publicParts.ip || snapshot.tunnelDomain || null,
    publicPort: Number(publicParts.port) || null,
    publicAddress: snapshot.tunnelAddress || snapshot.tunnelDomain || null,
    source: "snapshot",
    matchedInstanceId: null,
    matchedInstanceName: null,
    updatedAt: snapshot.lastSuccessfulRefreshAt || snapshot.lastCheckedAt || null,
  };
}

async function listPlayitTunnels() {
  const snapshot = await getPlayitStatus();
  if (!snapshot.installed) {
    return { ok: false, code: "PLAYIT_NOT_INSTALLED", message: "Playit is not installed on this system.", tunnels: [], lastCheckedAt: snapshot.lastCheckedAt };
  }
  if (!snapshot.running && snapshot.serviceState !== "running") {
    return { ok: false, code: "PLAYIT_NOT_RUNNING", message: "Start Playit to refresh tunnel status.", tunnels: [], lastCheckedAt: snapshot.lastCheckedAt };
  }
  const tunnels = (snapshot.tunnelAddress || snapshot.localPort || snapshot.tunnelId) ? [normalizeTunnelFromSnapshot(snapshot)] : [];
  return {
    ok: true,
    tunnels,
    lastCheckedAt: new Date().toISOString(),
    message: tunnels.length ? "Playit tunnels refreshed." : "No Playit tunnels found.",
  };
}

module.exports = {
  getPlayitSnapshot,
  getPlayitStatus,
  getPlayitServiceStatus: getPlayitStatus,
  getPlayitLogs,
  listPlayitTunnels,
  restartPlayit,
  startPlayit,
  stopPlayit,
};
