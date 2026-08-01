const { execFile } = require("child_process");
const fs = require("fs");
const {
  WINDOWS_AGENT_TASK_NAME,
  WINDOWS_AGENT_LEGACY_TASK_NAMES,
  buildWindowsAgentTaskDefinition,
  buildWindowsTaskInspectionScript,
  buildWindowsTaskRegistrationScript,
  compareWindowsAgentTask,
  getCurrentWindowsUser,
} = require("../../../src/shared/windowsAgentScheduledTask");

function runPowerShell(script, timeout = 30000) {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, timeout, maxBuffer: 256 * 1024 }, (error, stdout, stderr) => resolve({ ok: !error, code: error?.code || null, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() }));
  });
}

async function inspectTask() {
  if (process.platform !== "win32") return { supported: false, found: false, matchesCanonicalDefinition: false, mismatchReasons: ["platform-unsupported"] };
  const result = await runPowerShell(buildWindowsTaskInspectionScript());
  if (!result.ok) throw Object.assign(new Error("The Agent startup task could not be inspected."), { code: "AGENT_TASK_INSPECTION_FAILED" });
  let snapshot;
  try { snapshot = JSON.parse(result.stdout || '{"found":false}'); }
  catch { throw Object.assign(new Error("The Agent startup task returned invalid inspection data."), { code: "AGENT_TASK_INSPECTION_INVALID" }); }
  const canonical = buildWindowsAgentTaskDefinition({ executablePath: process.execPath, userId: getCurrentWindowsUser() });
  const comparison = compareWindowsAgentTask(snapshot, canonical);
  return { supported: true, found: snapshot.found === true, taskName: canonical.taskName, taskPath: canonical.taskPath, legacyTaskNames: comparison.actual.legacyTaskNames, executable: comparison.actual.executable, arguments: comparison.actual.arguments, workingDirectory: comparison.actual.workingDirectory, principalUser: comparison.actual.userId, logonType: comparison.actual.logonType, runLevel: comparison.actual.runLevel, trigger: comparison.actual.triggers[0]?.type || null, enabled: comparison.actual.enabled, state: comparison.actual.state, lastRunTime: comparison.actual.lastRunTime, lastTaskResult: comparison.actual.lastTaskResult, matchesCanonicalDefinition: comparison.matches, mismatchReasons: comparison.mismatches, agentHealth: "healthy" };
}

async function repairTask() {
  if (process.platform !== "win32") throw Object.assign(new Error("Windows Agent task repair is unsupported on this platform."), { code: "PLATFORM_UNSUPPORTED", statusCode: 400 });
  if (!fs.existsSync(process.execPath)) throw Object.assign(new Error("The installed AnxOS executable is missing."), { code: "AGENT_TASK_EXECUTABLE_MISSING" });
  const definition = buildWindowsAgentTaskDefinition({ executablePath: process.execPath, userId: getCurrentWindowsUser() });
  const before = await inspectTask();
  if (!before.matchesCanonicalDefinition) {
    const result = await runPowerShell(buildWindowsTaskRegistrationScript(definition), 60000);
    if (!result.ok) throw Object.assign(new Error("The elevated Agent could not register its startup task."), { code: "AGENT_TASK_REGISTRATION_FAILED" });
  }
  const after = await inspectTask();
  if (!after.matchesCanonicalDefinition) throw Object.assign(new Error("The Agent task does not match the canonical definition after repair."), { code: "AGENT_TASK_DEFINITION_MISMATCH", details: { mismatchReasons: after.mismatchReasons } });
  return { ...after, repairAttempted: !before.matchesCanonicalDefinition, repairResult: before.matchesCanonicalDefinition ? "unchanged" : "repaired" };
}

async function uninstallTask() {
  if (process.platform !== "win32") throw Object.assign(new Error("Windows Agent task removal is unsupported on this platform."), { code: "PLATFORM_UNSUPPORTED", statusCode: 400 });
  const taskNames = [WINDOWS_AGENT_TASK_NAME, ...WINDOWS_AGENT_LEGACY_TASK_NAMES];
  const script = taskNames.map((taskName) => `Stop-ScheduledTask -TaskName '${taskName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue; Unregister-ScheduledTask -TaskName '${taskName.replace(/'/g, "''")}' -Confirm:$false -ErrorAction SilentlyContinue`).join("; ");
  const result = await runPowerShell(script, 30000);
  if (!result.ok) throw Object.assign(new Error("The Agent startup task could not be removed."), { code: "AGENT_TASK_UNINSTALL_FAILED" });
  return { removed: true, taskName: WINDOWS_AGENT_TASK_NAME };
}

module.exports = { inspectTask, repairTask, uninstallTask };
