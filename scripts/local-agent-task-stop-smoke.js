#!/usr/bin/env node
"use strict";

// Stop/Restart of the Windows scheduled-task Agent: `schtasks /End` returns
// before the Agent process has exited. The follow-up port check used to find
// that exiting Agent, fail to verify it (an elevated task's command line is
// unreadable from the app) and abort Restart with LOCAL_AGENT_PROCESS_UNVERIFIED,
// leaving the Agent stopped. stopVerifiedWindowsTaskAgent now waits for the
// port to be released, and still refuses to kill a listener it cannot verify.
// Every system call is injected; nothing is stopped on this machine.
// Run: node scripts/local-agent-task-stop-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-agent-task-stop-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

const { _test } = require("../src/services/agentControlService");

const config = { port: 47131 };
const listening = { listening: true, port: 47131, pid: 4242, process: { pid: 4242, name: "AnxOS Control Center.exe", executablePath: null, commandLine: null } };

function harness(listenerSequence) {
  const calls = [];
  let index = 0;
  const deps = {
    waitStopped: async () => { calls.push("waitStopped"); return true; },
    getListener: async () => {
      calls.push("getListener");
      const value = listenerSequence[Math.min(index, listenerSequence.length - 1)];
      index += 1;
      return value;
    },
    getHealth: async () => { calls.push("getHealth"); return null; },
    stopVerified: async ({ processInfo }) => {
      calls.push("stopVerified");
      throw Object.assign(new Error("unverified"), { code: "LOCAL_AGENT_PROCESS_UNVERIFIED", pid: processInfo.pid });
    },
    sleep: async () => { calls.push("sleep"); },
  };
  return { deps, calls };
}

(async () => {
  try {
    // T1: the ended task's Agent is still exiting for two checks, then the
    // port is free. Restart must continue, nothing is verified or killed.
    let h = harness([listening, listening, { listening: false }]);
    let result = await _test.stopVerifiedWindowsTaskAgent(config, h.deps);
    assert.deepStrictEqual(result, { stopped: false, reason: "not-listening" });
    assert.strictEqual(h.calls[0], "waitStopped", "waits for the Agent to stop answering before looking at the port");
    assert.ok(!h.calls.includes("stopVerified"), "an Agent that exits by itself is never inspected for killing");
    console.log("PASS T1 an Agent still exiting after schtasks /End no longer aborts Restart");

    // T2: something keeps holding the port. It is still verified, and an
    // unverifiable listener is still refused rather than killed.
    h = harness([listening]);
    await assert.rejects(_test.stopVerifiedWindowsTaskAgent(config, h.deps), (error) => error.code === "LOCAL_AGENT_PROCESS_UNVERIFIED");
    assert.strictEqual(h.calls.filter((call) => call === "getListener").length, 6, "gives the port a bounded time to be released");
    assert.strictEqual(h.calls.at(-1), "stopVerified");
    console.log("PASS T2 a listener that stays is still verified and never killed blindly");

    // T3: nothing listening at all.
    h = harness([{ listening: false }]);
    result = await _test.stopVerifiedWindowsTaskAgent(config, h.deps);
    assert.deepStrictEqual(result, { stopped: false, reason: "not-listening" });
    assert.ok(!h.calls.includes("sleep"));
    console.log("PASS T3 a free port returns immediately");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  console.log("local agent task stop smoke passed (3 checks).");
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
