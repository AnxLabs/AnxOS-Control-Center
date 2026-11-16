#!/usr/bin/env node
"use strict";

// The Windows "AnxOSAgent" scheduled task is machine-wide. Agent Control's
// stop() used to end it whenever it was running, even when it belonged to
// another installation: agent-control-smoke (run from a development checkout,
// where the Agent is node.exe) ended the developer's real installed Local Agent
// on every run, and nothing restarted it until the next logon.
//   S1 a running task that runs another installation's executable is left alone
//   S2 a running task that runs this installation's executable is still ended
//   S3 the decision helper: only executable or arguments mismatches mean
//      "another installation"; settings drift on our own task does not
//   S4 status counts only this installation's task as its running Agent
//   S5 after an update that could not set the Helper up again (Setup's
//      marker, no task), status asks for a restore, and Restore runs the
//      shipped task script for this installation, keeping the marker when
//      the administrator prompt is declined
//   S6 while another computer is selected, the Local Agent card's build is
//      read from the Agent's public health reply with no credential, only
//      for this installation's running Agent, and cached between polls
// Windows is faked and every child_process call is replaced before the module
// loads, so nothing on this machine is inspected, started or stopped.
// Run: node scripts/agent-control-foreign-task-stop-smoke.js

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-foreign-task-stop-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
process.env.ANXOS_LOG_DIR = path.join(root, "logs");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
Object.defineProperty(process, "platform", { value: "win32" });
// The faked Windows user, matching the fake task's principal. CI runs this on
// Linux, where these variables do not exist.
process.env.USERDOMAIN = "TEST";
process.env.USERNAME = "User";

const calls = [];
let taskExecutable = null;
let taskPresent = true;
let helperScriptResult = { stdout: "" };

function taskSnapshot() {
  return {
    found: true,
    taskName: "AnxOSAgent",
    taskPath: "\\",
    legacyTaskNames: [],
    actions: [{ execute: taskExecutable, arguments: "--agent", workingDirectory: path.dirname(taskExecutable) }],
    principal: { userId: "TEST\\User", logonType: "Interactive", runLevel: "Highest" },
    triggers: [{ type: "MSFT_TaskLogonTrigger", userId: "TEST\\User", enabled: true }],
    settings: { enabled: true, startWhenAvailable: true, allowStartOnBatteries: true, stopOnBatteryTransition: false, multipleInstances: "IgnoreNew" },
    state: "Running",
  };
}

function fakeResult(command, args) {
  const name = path.basename(String(command)).toLowerCase();
  const joined = (args || []).join(" ");
  if (name === "powershell.exe" && joined.includes("install-agent-task.ps1")) return helperScriptResult;
  if (name === "powershell.exe" && joined.includes("Get-ScheduledTask")) return { stdout: JSON.stringify(taskPresent ? taskSnapshot() : { found: false }) };
  if (name === "schtasks.exe") return { stdout: "SUCCESS: The scheduled task was ended." };
  if (name === "netstat.exe") return { stdout: "" };
  if (name === "sc.exe") return { error: Object.assign(new Error("[SC] OpenService FAILED 1060"), { code: 1060 }), stdout: "[SC] OpenService FAILED 1060: The specified service does not exist as an installed service." };
  return { error: Object.assign(new Error(`${name} is not available in this test`), { code: "ENOENT" }), stdout: "" };
}

childProcess.execFile = (command, args, options, callback) => {
  const done = typeof options === "function" ? options : callback;
  calls.push([path.basename(String(command)).toLowerCase(), ...(args || [])]);
  const result = fakeResult(command, args);
  setImmediate(() => done?.(result.error || null, result.stdout || "", result.stderr || ""));
  return { pid: 0, kill() {}, on() {}, once() {} };
};
childProcess.spawn = (command) => { throw new Error(`spawn(${command}) is not allowed in this test`); };
childProcess.exec = (command) => { throw new Error(`exec(${command}) is not allowed in this test`); };

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

const endCalls = () => calls.filter((call) => call[0] === "schtasks.exe" && call.includes("/End"));

(async () => {
  const control = require("../src/services/agentControlService");
  try {
    // A free port, so no health check can reach a real Agent on 47131.
    control.saveConfig({ name: "Foreign Task Smoke", host: "127.0.0.1", port: await freePort(), allowedFolders: [root], restartPolicy: "never" });

    // S1
    taskExecutable = "C:\\Program Files\\AnxOS Control Center\\AnxOS Control Center.exe";
    calls.length = 0;
    await control.stop();
    assert.ok(calls.some((call) => call[0] === "powershell.exe"), "the task was inspected (the fake was reached)");
    assert.deepStrictEqual(endCalls(), [], "a task that runs another installation's Agent is never ended");
    console.log("PASS S1 another installation's running Agent task is left alone");

    // S2
    taskExecutable = process.execPath;
    calls.length = 0;
    await control.stop();
    assert.deepStrictEqual(endCalls().map((call) => call.slice(1)), [["/End", "/TN", "AnxOSAgent"]], "this installation's running task is still ended");
    console.log("PASS S2 this installation's running Agent task is still ended");

    // S3
    const belongs = control._test.backgroundServiceBelongsToThisInstallation;
    const task = (mismatchReasons) => ({ type: "windows-scheduled-task", verification: { mismatchReasons } });
    assert.strictEqual(belongs(task([])), true);
    assert.strictEqual(belongs(task(["start-when-available", "principal-user"])), true, "settings drift on our own task still counts as ours");
    assert.strictEqual(belongs(task(["executable"])), false);
    assert.strictEqual(belongs(task(["arguments"])), false);
    assert.strictEqual(belongs({ type: "systemd-user" }), true, "systemd units are filtered by their own validity check");
    console.log("PASS S3 only an executable or arguments mismatch marks the task as another installation's");

    // S4 Status: another installation's running task is not this
    // installation's Agent, so after a stop it does not read as running.
    taskExecutable = "C:\\Program Files\\AnxOS Control Center\\AnxOS Control Center.exe";
    const foreignStatus = await control.stop();
    assert.strictEqual(foreignStatus.running, false, "another installation's running task does not make this Agent read as running");
    taskExecutable = process.execPath;
    const ownStatus = await control.getStatus();
    assert.strictEqual(ownStatus.running, true, "this installation's running task still reads as running");
    console.log("PASS S4 status counts only this installation's task as its running Agent");

    // S5
    const resources = path.join(root, "resources");
    fs.mkdirSync(resources, { recursive: true });
    const script = path.join(resources, "install-agent-task.ps1");
    fs.writeFileSync(script, "# stand-in, never run\n");
    const marker = path.join(resources, "helper-restore-needed.json");
    fs.writeFileSync(marker, "{}\n");
    assert.strictEqual(typeof control._test.setHelperResourcesDir, "function", "the Helper restore reads Setup's marker from the app resources folder");
    control._test.setHelperResourcesDir(resources);
    taskPresent = false;
    let status = await control.getStatus();
    assert.strictEqual(status.helperRestore?.needed, true, "a marker with no startup task asks for a Helper restore");
    // A development checkout (this node.exe) never registers the installed
    // Helper's machine-wide task for itself.
    calls.length = 0;
    await assert.rejects(control.restoreHelperTask(), (error) => error.code === "HELPER_RESTORE_UNAVAILABLE", "only the installed app may restore its Helper");
    assert(!calls.some((call) => call.some((part) => String(part).includes("install-agent-task.ps1"))), "a development checkout never runs the task script");
    control._test.setHelperExecutable(process.execPath);
    helperScriptResult = { error: Object.assign(new Error("The operation was canceled by the user."), { code: 1223 }), stdout: "" };
    calls.length = 0;
    await assert.rejects(control.restoreHelperTask(), (error) => error.code === "HELPER_RESTORE_DECLINED", "a declined administrator prompt is reported as declined");
    const run = calls.find((call) => call[0] === "powershell.exe" && call.includes("-File"));
    assert(run, "Restore runs the task script");
    assert.strictEqual(run[run.indexOf("-File") + 1], script, "the script shipped with this installation is used");
    assert.strictEqual(run[run.indexOf("-ExecutablePath") + 1], process.execPath, "the task runs this installation's executable");
    assert.strictEqual(run[run.indexOf("-Mode") + 1], "Install");
    assert(fs.existsSync(marker), "a declined prompt keeps the marker, so the restore is offered again");
    helperScriptResult = { stdout: "" };
    taskPresent = true;
    taskExecutable = process.execPath;
    await control.restoreHelperTask();
    assert(!fs.existsSync(marker), "a successful restore clears the marker");
    fs.writeFileSync(marker, "{}\n");
    status = await control.getStatus();
    assert.strictEqual(status.helperRestore?.needed, false, "with this installation's task present no restore is asked for");
    assert(!fs.existsSync(marker), "a marker left once the task exists is cleared");
    taskExecutable = "C:\\Program Files\\AnxOS Control Center\\AnxOS Control Center.exe";
    fs.writeFileSync(marker, "{}\n");
    status = await control.getStatus();
    assert.strictEqual(status.helperRestore?.needed, true, "another installation's task does not stand in for this one's Helper");
    const repoRoot = path.resolve(__dirname, "..");
    const appSource = fs.readFileSync(path.join(repoRoot, "app.js"), "utf8");
    assert(/restoreHelper: \{ label: "Restore AnxOS Helper"/.test(appSource), "the notification offers Restore AnxOS Helper");
    assert(/agentControl:restoreHelper/.test(fs.readFileSync(path.join(repoRoot, "preload.js"), "utf8")), "the renderer can ask for the restore");
    assert(/restoreHelper: \(\) => control\.restoreHelperTask\(\)/.test(fs.readFileSync(path.join(repoRoot, "src", "ipc", "agentControlIpc.js"), "utf8")), "the main process handles the restore as an authorized action");
    console.log("PASS S5 a Helper Setup could not register is restored from the app");

    // S6 While another computer is selected, Agent Control skips the
    // credentialed probe of this PC's Agent. The Local Agent card still shows
    // the build that Agent reports (Build 212 RC2 acceptance showed "Build not
    // reported" for a 2.0-build212 Local Agent), read from its public health
    // reply with no credential, only when this installation's Agent should be
    // running, and cached between Agent Control's polls.
    const healthRequests = [];
    const fakeAgent = http.createServer((request, response) => {
      healthRequests.push({ url: request.url, authorization: request.headers.authorization || null });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, apiVersion: "v1", protocolVersion: 1, identity: { deviceId: "device-local", hostname: "local", agentVersion: "0.1.0", agentArtifactVersion: "2.0-build212" } }));
    });
    await new Promise((resolve) => fakeAgent.listen(0, "127.0.0.1", resolve));
    try {
      control.saveConfig({ ...control.readConfig(), host: "127.0.0.1", port: fakeAgent.address().port });
      taskPresent = true;
      taskExecutable = process.execPath;
      let skipped = await control.getStatus({ skipProbe: true });
      assert.strictEqual(skipped.agentArtifactVersion, "2.0-build212", "the Local Agent's reported build is shown while another computer is selected");
      assert.strictEqual(skipped.runtime?.build, "2.0-build212", "the runtime summary carries the build too");
      assert.deepStrictEqual(healthRequests.map((entry) => entry.url), ["/api/v1/health"], "only the health route was read");
      assert.strictEqual(healthRequests[0].authorization, null, "the build is read without sending a credential");
      await control.getStatus({ skipProbe: true });
      assert.strictEqual(healthRequests.length, 1, "the build is cached between polls");
      taskExecutable = "C:\\Program Files\\AnxOS Control Center\\AnxOS Control Center.exe";
      skipped = await control.getStatus({ skipProbe: true });
      assert.strictEqual(skipped.agentArtifactVersion, null, "another installation's Agent task is not read as this installation's build");
      assert.strictEqual(healthRequests.length, 1, "nothing is read for another installation's task");
    } finally {
      await new Promise((resolve) => fakeAgent.close(resolve));
    }
    console.log("PASS S6 the Local Agent's build is shown while another computer is selected, read without a credential");
    console.log("Agent Control foreign task stop smoke passed (6 checks).");
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
