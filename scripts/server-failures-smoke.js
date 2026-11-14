#!/usr/bin/env node
"use strict";

// Regression for common server startup failures (Phase 3.4).
//   F1 the classifier recognises real failure lines (port taken, Java out of
//      memory, disk full) and ignores ordinary log lines;
//   F2 every recognised code has a plain explanation and next step, and the
//      renderer shows it instead of the raw code;
//   F3 a REAL server process that fails to bind its port and exits, with
//      "restart if it crashes" on, is reported as PORT_IN_USE and is not
//      restarted; a control process that just crashes is still restarted.
// F3 runs real child processes in a temporary instance root.
// Run: node scripts/server-failures-smoke.js

const assert = require("assert");
const childProcess = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const failures = require(path.join(root, "src", "shared", "instances", "serverFailures.js"));
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // F1
  const cases = [
    ["[12:00:01] [Server thread/WARN]: **** FAILED TO BIND TO PORT!", "PORT_IN_USE"],
    ["java.net.BindException: Address already in use: bind", "PORT_IN_USE"],
    ["Error: listen EADDRINUSE: address already in use :::30120", "PORT_IN_USE"],
    ["Only one usage of each socket address (protocol/network address/port) is normally permitted.", "PORT_IN_USE"],
    ["Exception in thread \"Server thread\" java.lang.OutOfMemoryError: Java heap space", "OUT_OF_MEMORY"],
    ["There is insufficient memory for the Java Runtime Environment to continue.", "OUT_OF_MEMORY"],
    ["java.io.IOException: No space left on device", "DISK_FULL"],
    ["There is not enough space on the disk.", "DISK_FULL"],
  ];
  for (const [line, code] of cases) {
    assert.strictEqual(failures.classifyServerOutput(line)?.code, code, `classifies: ${line}`);
  }
  for (const line of [
    "[Server thread/INFO]: Starting minecraft server on *:25565",
    "[Server thread/INFO]: Done (3.2s)! For help, type \"help\"",
    "Plugin MemoryMonitor enabled: 512 MB free",
    "Saving chunks for level 'world'/minecraft:overworld",
    "",
  ]) {
    assert.strictEqual(failures.classifyServerOutput(line), null, `ignores: ${line}`);
  }
  assert.strictEqual(failures.classifyServerOutput("**** FAILED TO BIND TO PORT!").suppressRestart, true, "a taken port stops restarts");
  assert.strictEqual(failures.classifyServerOutput("java.lang.OutOfMemoryError").suppressRestart, false, "out of memory leaves restarts to the policy");
  console.log("PASS F1 real failure lines are recognised, ordinary lines are not");

  // F2
  for (const rule of failures.OUTPUT_RULES) {
    const explained = failures.explainServerFailure(rule.code);
    assert.ok(explained?.title && explained?.detail && explained?.fix, `${rule.code} is explained`);
  }
  for (const code of ["CRASH_LOOP", "EARLY_CLEAN_EXIT", "PROCESS_KILLED", "PROCESS_EXITED", "INVALID_COMMAND"]) {
    assert.ok(failures.explainServerFailure(code), `${code} is explained`);
  }
  assert.strictEqual(failures.explainServerFailure("SOMETHING_ELSE"), null, "unknown codes fall back to the raw reason");
  assert.ok(app.includes("const explainedReason = serviceManagedReason ? \"\" : describeServerFailureCode(instance?.failureReason);"), "the server page explains known codes");
  const at = index.indexOf('src="src/shared/instances/serverFailures.js"');
  assert.ok(at > 0 && at < index.indexOf('src="app.js"'), "serverFailures.js loads before app.js");
  console.log("PASS F2 every recognised failure has a plain explanation and next step");

  // F3: real processes, temporary instance root.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-server-failures-"));
  process.env.AGENT_INSTANCE_ROOT = path.join(tempRoot, "instances");
  const instanceService = require(path.join(root, "agent", "src", "services", "instances", "instanceService.js"));
  const originalSpawn = childProcess.spawn;
  const spawns = [];
  childProcess.spawn = (command, args, options) => {
    spawns.push(String(args?.[args.length - 1] || ""));
    return originalSpawn(command, args, options);
  };
  const serverScript = (line) => `console.log(${JSON.stringify(line)}); setTimeout(() => process.exit(1), 400);`;
  async function runCase(id, line) {
    await instanceService.createInstance({
      id,
      displayName: id,
      type: "custom-command",
      workingDirectory: "data",
      executable: process.execPath,
      args: ["-e", serverScript(line)],
      restartPolicy: "on-failure",
    });
    const before = spawns.length;
    await instanceService.startInstance(id);
    let status = null;
    for (let i = 0; i < 60; i += 1) {
      await wait(100);
      status = await instanceService.getStatus(id);
      if (String(status?.state || "").toLowerCase() === "failed") break;
    }
    return { status, spawnsForCase: () => spawns.length - before };
  }
  try {
    const bind = await runCase("bind-failure", "[Server thread/WARN]: **** FAILED TO BIND TO PORT!");
    assert.strictEqual(String(bind.status?.state || "").toLowerCase(), "failed", `the server is reported failed (${bind.status?.state})`);
    assert.strictEqual(bind.status?.failureReason, "PORT_IN_USE", `the failure is PORT_IN_USE (${bind.status?.failureReason})`);
    await wait(2500);
    assert.strictEqual(bind.spawnsForCase(), 1, "a taken port is not restarted in a loop");

    const crash = await runCase("plain-crash", "Something went wrong");
    assert.strictEqual(crash.status?.failureReason, "PROCESS_EXITED", `an ordinary crash keeps its reason (${crash.status?.failureReason})`);
    let restarted = false;
    for (let i = 0; i < 80 && !restarted; i += 1) {
      await wait(100);
      restarted = crash.spawnsForCase() > 1;
    }
    const logText = await fs.promises.readFile(path.join(process.env.AGENT_INSTANCE_ROOT, "plain-crash", "logs", "latest.log"), "utf8").catch(() => "");
    assert.ok(restarted || /Auto-restart scheduled/.test(logText), "an ordinary crash is still restarted by the policy");
    console.log(`PASS F3 a real bind failure is reported and not restarted; an ordinary crash ${restarted ? "was restarted" : "scheduled a restart"}`);

    // F4: a status poll that sees the crashed child's PID gone before Node
    // delivers its "exit" event must not record Stopped/STALE_PID (it used to,
    // and could overwrite the crash: F3 failed about 1 run in 15 under load).
    // The window is forced by reporting the still-running child as dead.
    await instanceService.createInstance({
      id: "exit-pending",
      displayName: "exit-pending",
      type: "custom-command",
      workingDirectory: "data",
      executable: process.execPath,
      args: ["-e", "setTimeout(() => process.exit(1), 1500);"],
      restartPolicy: "never",
    });
    await instanceService.startInstance("exit-pending");
    instanceService._test.setProcessAliveProvider(() => false);
    let pending;
    try {
      pending = await instanceService.getStatus("exit-pending");
    } finally {
      instanceService._test.setProcessAliveProvider(null);
    }
    assert.notStrictEqual(pending?.failureReason, "STALE_PID", "a pending exit is not recorded as a stale PID");
    assert.notStrictEqual(String(pending?.state || "").toLowerCase(), "stopped", `a pending exit is not recorded as Stopped (${pending?.state})`);
    let settled = null;
    for (let i = 0; i < 60; i += 1) {
      await wait(100);
      settled = await instanceService.getStatus("exit-pending");
      if (String(settled?.state || "").toLowerCase() === "failed") break;
    }
    assert.strictEqual(String(settled?.state || "").toLowerCase(), "failed", `the crash is recorded once the exit arrives (${settled?.state})`);
    assert.strictEqual(settled?.failureReason, "PROCESS_EXITED", `the crash keeps its reason (${settled?.failureReason})`);
    console.log("PASS F4 a status poll before the exit event does not overwrite the crash");
  } finally {
    childProcess.spawn = originalSpawn;
    for (const id of ["bind-failure", "plain-crash", "exit-pending"]) {
      await instanceService.stopInstance(id).catch(() => {});
    }
    await wait(300);
    if (typeof instanceService.shutdownInstanceService === "function") await instanceService.shutdownInstanceService().catch(() => {});
    try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }

  console.log("Server failures smoke passed (4 checks).");
}

main().then(() => process.exit(process.exitCode || 0), (error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
