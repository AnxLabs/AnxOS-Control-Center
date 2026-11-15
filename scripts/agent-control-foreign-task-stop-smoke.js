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
// Windows is faked and every child_process call is replaced before the module
// loads, so nothing on this machine is inspected, started or stopped.
// Run: node scripts/agent-control-foreign-task-stop-smoke.js

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-foreign-task-stop-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
process.env.ANXOS_LOG_DIR = path.join(root, "logs");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
Object.defineProperty(process, "platform", { value: "win32" });

const calls = [];
let taskExecutable = null;

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
  if (name === "powershell.exe" && joined.includes("Get-ScheduledTask")) return { stdout: JSON.stringify(taskSnapshot()) };
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
    console.log("Agent Control foreign task stop smoke passed (4 checks).");
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
