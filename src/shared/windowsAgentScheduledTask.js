const path = require("path");

const WINDOWS_AGENT_TASK_NAME = "AnxOSAgent";
const WINDOWS_AGENT_LEGACY_TASK_NAMES = ["AnxOS Agent"];

function quotePowerShellValue(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

function normalizeWindowsPath(value) {
  return path.win32.normalize(String(value || "").trim().replace(/^"|"$/g, "")).toLowerCase();
}

function normalizeUserId(value) {
  return String(value || "").trim().toLowerCase();
}

function windowsUserIdsMatch(actualValue, expectedValue) {
  const actual = normalizeUserId(actualValue).replace(/^\.\\/, "");
  const expected = normalizeUserId(expectedValue).replace(/^\.\\/, "");
  if (!actual || !expected) return actual === expected;
  if (actual === expected) return true;
  const actualQualified = actual.includes("\\");
  const expectedQualified = expected.includes("\\");
  if (actualQualified && expectedQualified) return false;
  return actual.split("\\").pop() === expected.split("\\").pop();
}

function getCurrentWindowsUser(env = process.env) {
  const username = String(env.USERNAME || "").trim();
  const domain = String(env.USERDOMAIN || "").trim();
  return domain && username ? `${domain}\\${username}` : username;
}

function buildWindowsAgentTaskDefinition({ executablePath = process.execPath, userId = getCurrentWindowsUser() } = {}) {
  const executable = path.win32.resolve(String(executablePath || ""));
  if (!executable || !path.win32.isAbsolute(executable)) {
    const error = new Error("The installed AnxOS executable path is missing or invalid.");
    error.code = "AGENT_TASK_EXECUTABLE_MISSING";
    throw error;
  }
  if (!String(userId || "").trim()) {
    const error = new Error("The current Windows user could not be determined.");
    error.code = "AGENT_TASK_USER_UNAVAILABLE";
    throw error;
  }
  return {
    taskName: WINDOWS_AGENT_TASK_NAME,
    taskPath: "\\",
    executable,
    arguments: "--agent",
    workingDirectory: path.win32.dirname(executable),
    userId: String(userId).trim(),
    logonType: "Interactive",
    runLevel: "Highest",
    trigger: { type: "Logon", userId: String(userId).trim() },
    settings: {
      enabled: true,
      startWhenAvailable: true,
      allowStartOnBatteries: true,
      stopOnBatteryTransition: false,
      multipleInstances: "IgnoreNew",
    },
    legacyTaskNames: [...WINDOWS_AGENT_LEGACY_TASK_NAMES],
  };
}

function normalizeTaskSnapshot(snapshot = {}) {
  const action = Array.isArray(snapshot.actions) ? snapshot.actions[0] || {} : snapshot.action || snapshot.actions || {};
  const principal = snapshot.principal || {};
  const triggers = Array.isArray(snapshot.triggers) ? snapshot.triggers : snapshot.trigger ? [snapshot.trigger] : [];
  const settings = snapshot.settings || {};
  return {
    found: snapshot.found !== false && Boolean(snapshot.taskName || snapshot.TaskName || action.execute || action.Execute),
    taskName: snapshot.taskName || snapshot.TaskName || null,
    taskPath: snapshot.taskPath || snapshot.TaskPath || "\\",
    executable: action.execute || action.Execute || snapshot.executable || null,
    arguments: action.arguments ?? action.Arguments ?? snapshot.arguments ?? "",
    workingDirectory: action.workingDirectory || action.WorkingDirectory || snapshot.workingDirectory || null,
    userId: principal.userId || principal.UserId || snapshot.userId || null,
    logonType: principal.logonType || principal.LogonType || snapshot.logonType || null,
    runLevel: principal.runLevel || principal.RunLevel || snapshot.runLevel || null,
    triggers: triggers.map((trigger) => ({
      type: trigger.type || trigger.Type || trigger.cimClass || trigger.CimClass || trigger.CimClassName || "",
      userId: trigger.userId || trigger.UserId || null,
      enabled: trigger.enabled ?? trigger.Enabled ?? true,
    })),
    enabled: snapshot.enabled ?? snapshot.Enabled ?? settings.enabled ?? settings.Enabled ?? true,
    state: snapshot.state || snapshot.State || null,
    lastRunTime: snapshot.lastRunTime || snapshot.LastRunTime || null,
    lastTaskResult: snapshot.lastTaskResult ?? snapshot.LastTaskResult ?? null,
    startWhenAvailable: settings.startWhenAvailable ?? settings.StartWhenAvailable ?? snapshot.startWhenAvailable ?? false,
    allowStartOnBatteries: settings.allowStartOnBatteries ?? settings.AllowStartIfOnBatteries ?? snapshot.allowStartOnBatteries ?? false,
    stopOnBatteryTransition: settings.stopOnBatteryTransition ?? settings.StopIfGoingOnBatteries ?? snapshot.stopOnBatteryTransition ?? true,
    multipleInstances: settings.multipleInstances ?? settings.MultipleInstances ?? snapshot.multipleInstances ?? null,
    legacyTaskNames: Array.isArray(snapshot.legacyTaskNames) ? snapshot.legacyTaskNames.filter(Boolean) : [],
  };
}

function compareWindowsAgentTask(snapshot, canonical) {
  const actual = normalizeTaskSnapshot(snapshot);
  const expected = canonical || buildWindowsAgentTaskDefinition();
  const mismatches = [];
  if (!actual.found) mismatches.push("task-missing");
  if (actual.found && String(actual.taskName || "").replace(/^\\/, "") !== expected.taskName) mismatches.push("task-name");
  if (normalizeWindowsPath(actual.executable) !== normalizeWindowsPath(expected.executable)) mismatches.push("executable");
  if (String(actual.arguments || "").trim() !== expected.arguments) mismatches.push("arguments");
  if (normalizeWindowsPath(actual.workingDirectory) !== normalizeWindowsPath(expected.workingDirectory)) mismatches.push("working-directory");
  if (!windowsUserIdsMatch(actual.userId, expected.userId)) mismatches.push("principal-user");
  if (!/^interactive(?:token)?$/i.test(String(actual.logonType || ""))) mismatches.push("logon-type");
  if (!/^highest$/i.test(String(actual.runLevel || ""))) mismatches.push("run-level");
  const logonTrigger = actual.triggers.find((trigger) => /logon/i.test(String(trigger.type || "")));
  if (!logonTrigger) mismatches.push("logon-trigger");
  else if (logonTrigger.userId && !windowsUserIdsMatch(logonTrigger.userId, expected.userId)) mismatches.push("trigger-user");
  if (actual.legacyTaskNames.length) mismatches.push("legacy-task-present");
  if (actual.enabled === false) mismatches.push("disabled");
  if (actual.startWhenAvailable !== true) mismatches.push("start-when-available");
  if (actual.allowStartOnBatteries !== true) mismatches.push("battery-start");
  if (actual.stopOnBatteryTransition !== false) mismatches.push("battery-stop");
  if (!/^(ignorenew|2)$/i.test(String(actual.multipleInstances || ""))) mismatches.push("multiple-instances");
  return { matches: mismatches.length === 0, mismatches, actual, expected };
}

function buildWindowsTaskInspectionScript(taskName = WINDOWS_AGENT_TASK_NAME) {
  const legacyTaskNames = WINDOWS_AGENT_LEGACY_TASK_NAMES.map(quotePowerShellValue).join(", ");
  return [
    `$task = Get-ScheduledTask -TaskName ${quotePowerShellValue(taskName)} -ErrorAction SilentlyContinue`,
    `$legacyTaskNames = @(${legacyTaskNames})`,
    "$legacyTasks = @($legacyTaskNames | Where-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue })",
    "if ($null -eq $task) { @{ found = $false; legacyTaskNames = $legacyTasks } | ConvertTo-Json -Compress; exit 0 }",
    "$info = Get-ScheduledTaskInfo -TaskName $task.TaskName -TaskPath $task.TaskPath -ErrorAction SilentlyContinue",
    "$actions = @($task.Actions | ForEach-Object { @{ execute = $_.Execute; arguments = $_.Arguments; workingDirectory = $_.WorkingDirectory } })",
    "$triggers = @($task.Triggers | ForEach-Object { @{ type = $_.CimClass.CimClassName; userId = $_.UserId; enabled = $_.Enabled } })",
    "@{ found = $true; taskName = $task.TaskName; taskPath = $task.TaskPath; legacyTaskNames = $legacyTasks; actions = $actions; principal = @{ userId = $task.Principal.UserId; logonType = [string]$task.Principal.LogonType; runLevel = [string]$task.Principal.RunLevel }; triggers = $triggers; settings = @{ enabled = $task.Settings.Enabled; startWhenAvailable = $task.Settings.StartWhenAvailable; allowStartOnBatteries = (-not $task.Settings.DisallowStartIfOnBatteries); stopOnBatteryTransition = $task.Settings.StopIfGoingOnBatteries; multipleInstances = [string]$task.Settings.MultipleInstances }; state = [string]$task.State; lastRunTime = $info.LastRunTime; lastTaskResult = $info.LastTaskResult } | ConvertTo-Json -Depth 6 -Compress",
  ].join("; ");
}

function buildWindowsTaskRegistrationScript(definition) {
  const legacyCleanup = (definition.legacyTaskNames || WINDOWS_AGENT_LEGACY_TASK_NAMES).flatMap((taskName) => [
    `Stop-ScheduledTask -TaskName ${quotePowerShellValue(taskName)} -ErrorAction SilentlyContinue`,
    `Unregister-ScheduledTask -TaskName ${quotePowerShellValue(taskName)} -Confirm:$false -ErrorAction SilentlyContinue`,
  ]);
  return [
    ...legacyCleanup,
    `$action = New-ScheduledTaskAction -Execute ${quotePowerShellValue(definition.executable)} -Argument ${quotePowerShellValue(definition.arguments)} -WorkingDirectory ${quotePowerShellValue(definition.workingDirectory)}`,
    `$principal = New-ScheduledTaskPrincipal -UserId ${quotePowerShellValue(definition.userId)} -LogonType Interactive -RunLevel Highest`,
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User ${quotePowerShellValue(definition.userId)}`,
    "$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew",
    `Register-ScheduledTask -TaskName ${quotePowerShellValue(definition.taskName)} -Action $action -Principal $principal -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null`,
  ].join("; ");
}

module.exports = {
  WINDOWS_AGENT_LEGACY_TASK_NAMES,
  WINDOWS_AGENT_TASK_NAME,
  buildWindowsAgentTaskDefinition,
  buildWindowsTaskInspectionScript,
  buildWindowsTaskRegistrationScript,
  compareWindowsAgentTask,
  getCurrentWindowsUser,
  normalizeTaskSnapshot,
  windowsUserIdsMatch,
};
