const assert = require("assert");
const fs = require("fs");
const path = require("path");
const task = require("../src/shared/windowsAgentScheduledTask");
const service = require("../src/services/agentControlService")._test;

const executable = "C:\\Users\\Example User\\AppData\\Local\\Programs\\AnxOS Control Center\\AnxOS Control Center.exe";
const userId = "DESKTOP-TEST\\Example User";
const canonical = task.buildWindowsAgentTaskDefinition({ executablePath: executable, userId });

assert.strictEqual(canonical.executable, executable, "Canonical registration must preserve the current installed executable path.");
assert.strictEqual(canonical.arguments, "--agent");
assert.strictEqual(canonical.workingDirectory, path.win32.dirname(executable));
assert.strictEqual(canonical.userId, userId);
assert.strictEqual(canonical.logonType, "Interactive");
assert.strictEqual(canonical.runLevel, "Highest");
assert.deepStrictEqual(canonical.trigger, { type: "Logon", userId });
assert.strictEqual(canonical.settings.startWhenAvailable, true);
assert.strictEqual(canonical.settings.allowStartOnBatteries, true);
assert.strictEqual(canonical.settings.stopOnBatteryTransition, false);
assert.strictEqual(canonical.settings.multipleInstances, "IgnoreNew");

const correctSnapshot = {
  found: true,
  taskName: "AnxOSAgent",
  taskPath: "\\",
  actions: [{ execute: executable, arguments: "--agent", workingDirectory: path.win32.dirname(executable) }],
  principal: { userId, logonType: "Interactive", runLevel: "Highest" },
  triggers: [{ type: "MSFT_TaskLogonTrigger", userId, enabled: true }],
  settings: { enabled: true, startWhenAvailable: true, allowStartOnBatteries: true, stopOnBatteryTransition: false, multipleInstances: "IgnoreNew" },
  state: "Ready",
};
assert.deepStrictEqual(task.compareWindowsAgentTask(correctSnapshot, canonical).mismatches, [], "A canonical per-user task must remain unchanged.");
assert.strictEqual(task.compareWindowsAgentTask(correctSnapshot, canonical).matches, true, "Repeated migration must be idempotent.");
assert.strictEqual(task.windowsUserIdsMatch("Example User", userId), true, "An unqualified current user must match its machine-qualified form.");
assert.strictEqual(task.windowsUserIdsMatch(".\\Example User", userId), true, "A dot-qualified current user must match its machine-qualified form.");
assert.strictEqual(task.windowsUserIdsMatch("OTHER-DESKTOP\\Example User", userId), false, "Two conflicting qualified identities must not match.");
assert.deepStrictEqual(task.compareWindowsAgentTask({ ...correctSnapshot, principal: { ...correctSnapshot.principal, userId: "Example User" }, triggers: [{ ...correctSnapshot.triggers[0], userId: "Example User" }] }, canonical).mismatches, [], "Equivalent qualified and unqualified current-user identities must compare equal.");
expectMismatch({ ...correctSnapshot, legacyTaskNames: ["AnxOS Agent"] }, "legacy-task-present");

function expectMismatch(snapshot, mismatch) {
  assert(task.compareWindowsAgentTask(snapshot, canonical).mismatches.includes(mismatch), `Expected ${mismatch} mismatch.`);
}

expectMismatch({ ...correctSnapshot, principal: { ...correctSnapshot.principal, runLevel: "Limited" } }, "run-level");
expectMismatch({ ...correctSnapshot, actions: [{ ...correctSnapshot.actions[0], execute: "C:\\Program Files\\AnxOS Control Center\\AnxOS Control Center.exe" }] }, "executable");
expectMismatch({ ...correctSnapshot, actions: [{ ...correctSnapshot.actions[0], arguments: "" }] }, "arguments");
expectMismatch({ ...correctSnapshot, actions: [{ ...correctSnapshot.actions[0], workingDirectory: "C:\\Program Files\\AnxOS Control Center" }] }, "working-directory");
expectMismatch({ ...correctSnapshot, principal: { ...correctSnapshot.principal, logonType: "Password" } }, "logon-type");
expectMismatch({ ...correctSnapshot, triggers: [] }, "logon-trigger");
expectMismatch({ found: false }, "task-missing");

const registrationScript = service.buildWindowsTaskRegistrationScript(canonical);
assert(registrationScript.includes("-LogonType Interactive"), "PowerShell must use the valid Interactive logon type.");
assert(!registrationScript.includes("InteractiveToken"), "The invalid InteractiveToken enum must never be emitted.");
assert(registrationScript.includes("-RunLevel Highest"));
assert(registrationScript.includes("-Argument '--agent'"));
assert(registrationScript.includes("-WorkingDirectory 'C:\\Users\\Example User\\AppData\\Local\\Programs\\AnxOS Control Center'"), "Paths containing spaces must remain a single safely quoted PowerShell value.");
assert(registrationScript.includes("Register-ScheduledTask") && registrationScript.includes("-Force"), "Migration must replace one canonical task instead of creating duplicates.");
assert(registrationScript.includes("Unregister-ScheduledTask -TaskName 'AnxOS Agent'"), "Migration must remove the legacy spaced task name.");
assert(registrationScript.includes("-MultipleInstances IgnoreNew"), "Task Scheduler must reject overlapping Agent launches.");

const staleTask = `TaskName: \\AnxOSAgent\nTask To Run: cmd.exe /c C:\\Users\\anjor\\Documents\\AnxOS-Control-Center\\agent\\src\\server.js`;
assert.deepStrictEqual(service.classifyWindowsTaskOwnership(staleTask, { valid: false }), { state: "verified-stale", owned: true, stale: true });
const oldPackagedTask = `TaskName: \\AnxOSAgent\nTask To Run: C:\\Users\\anjor\\AppData\\Roaming\\AnxHub\\agent\\bin\\start-local-agent.vbs`;
assert.strictEqual(service.classifyWindowsTaskOwnership(oldPackagedTask, { valid: false }).state, "verified-stale");
const newPackagedTask = { taskName: "AnxOSAgent", actions: [{ execute: executable, arguments: "--agent" }] };
assert.strictEqual(service.classifyWindowsTaskOwnership(newPackagedTask, { valid: true }).state, "valid-packaged");
assert.strictEqual(service.classifyWindowsTaskOwnership(`TaskName: \\AnxOSAgent\nTask To Run: C:\\Tools\\unrelated.exe`, { valid: false }).state, "ambiguous");

const source = fs.readFileSync(require.resolve("../src/services/agentControlService"), "utf8");
const agentTaskSource = fs.readFileSync(require.resolve("../agent/src/services/windowsAgentTaskService"), "utf8");
const installerSource = fs.readFileSync(path.join(__dirname, "..", "windows", "install-agent-task.ps1"), "utf8");
const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
assert(agentTaskSource.includes("AGENT_TASK_EXECUTABLE_MISSING"), "Missing executables must return a structured failure.");
assert(agentTaskSource.includes("AGENT_TASK_REGISTRATION_FAILED"), "Registration failures must remain structured.");
assert(source.includes("repairWindowsAgentTask") && source.includes("AGENT_PRIVILEGED_OPERATION_UNAVAILABLE"), "The standard UI must route repair through the elevated authenticated Agent.");
assert(installerSource.includes("Invoke-WebRequest") && installerSource.includes("exit 24"), "Installer migration must require bounded Agent health confirmation.");
assert(installerSource.includes("Test-OwnedAgentProcess") && installerSource.includes("StatusCode -eq 200 -and"), "Installer health confirmation must belong to the expected --agent executable process.");
assert(installerSource.includes("Stop-OwnedAgentProcess") && installerSource.includes("--agent"), "Installer migration must stop only an owned Agent command line before replacement.");
assert(installerSource.includes("Unregister-ScheduledTask"), "Uninstall must remove the canonical task.");
assert(installerSource.includes('$legacyTaskNames = @("AnxOS Agent")'), "Install and uninstall must migrate the legacy spaced task name.");
assert(agentTaskSource.includes("WINDOWS_AGENT_LEGACY_TASK_NAMES"), "Authenticated repair and uninstall must include legacy task cleanup.");
assert(main.includes('process.argv.includes("--agent")') && main.includes("agentControl._test.agentEnvironment(config)"), "The packaged executable must expose the canonical --agent entry point.");
assert(!main.includes("runtimeConfig.autoStart") && !main.includes("agentControl.installService().catch"), "Standard UI startup must not perform privileged task mutation.");

console.log("Windows Agent lifecycle migration smoke checks passed.");
