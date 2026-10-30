#!/usr/bin/env node
"use strict";

// Remote Agent Start / Stop / Restart (src/services/remoteAgentLifecycleService.js)
// and the Agent's self-restart route (agent/src/routes/agentLifecycle.js).
// SSH, health and the Agent API are all injected; nothing reaches a node.
// Run: node scripts/remote-agent-lifecycle-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-remote-agent-lifecycle-"));
process.env.ANXHUB_CONFIG_DIR = tempDir;

const { createRemoteAgentLifecycleService, _test } = require("../src/services/remoteAgentLifecycleService");
const { AGENT_SELF_RESTART_EXIT_CODE, getSelfRestartCapability, handleAgentRestart } = require("../agent/src/routes/agentLifecycle");

const NODE = { id: "node-a", kind: "agent", displayName: "Node A" };
const KEY_PROFILE = { id: "key-a", authType: "privateKey", username: "debian" };
const probeOutput = (user, system) => `--- user ---\n${user}\n--- system ---\n${system}\n`;

function harness({ profile = KEY_PROFILE, scope = "user", actionResult = { code: 0, stdout: "", stderr: "" }, health = [], selfRestart = false } = {}) {
  const commands = [];
  const healthQueue = [...health];
  let lastConnected = healthQueue.length ? healthQueue[healthQueue.length - 1] : true;
  const calls = { selfRestart: 0 };
  const service = createRemoteAgentLifecycleService({
    resolveNode: (nodeId) => (nodeId === NODE.id ? NODE : null),
    getProfile: () => profile,
    runner: async (profileId, command) => {
      commands.push(command);
      if (command.includes("LoadState")) {
        return { code: 0, stdout: probeOutput(scope === "user" ? "loaded" : "not-found", scope === "system" ? "loaded" : "not-found") };
      }
      return actionResult;
    },
    healthProbe: async () => {
      const connected = healthQueue.length ? healthQueue.shift() : lastConnected;
      return { connected, selfRestart };
    },
    requestSelfRestart: async () => { calls.selfRestart += 1; return { restarting: true }; },
    sleep: async () => {},
    verifyAttempts: 4,
    verifyDelayMs: 0,
  });
  return { service, commands, calls };
}

const expectCode = async (promise, code) => assert.rejects(promise, (error) => { assert.strictEqual(error.code, code); return true; });

(async () => {
  try {
    // L1: command building and probe parsing.
    assert.strictEqual(_test.parseScopeProbe(probeOutput("loaded", "loaded")), "user", "a user unit wins when both exist");
    assert.strictEqual(_test.parseScopeProbe(probeOutput("not-found", "loaded")), "system");
    assert.strictEqual(_test.parseScopeProbe(probeOutput("not-found", "not-found")), null);
    assert.strictEqual(_test.buildActionCommand("user", "restart"), "systemctl --user restart anxos-agent");
    assert.strictEqual(_test.buildActionCommand("system", "stop"), "sudo -n systemctl stop anxos-agent");
    assert.throws(() => _test.buildActionCommand("user", "kill; rm -rf /"), (error) => error.code === "REMOTE_AGENT_ACTION_INVALID");
    console.log("PASS L1 user units use systemctl --user, system units sudo -n, and only start/stop/restart are accepted");

    // L2: SSH restart of a user unit is confirmed by health.
    let h = harness({ scope: "user", health: [false, true] });
    let result = await h.service.control("node-a", "restart");
    assert.deepStrictEqual([result.mechanism, result.scope, result.confirmed], ["ssh", "user", true]);
    assert.strictEqual(h.commands.at(-1), "systemctl --user restart anxos-agent");
    console.log("PASS L2 Restart over SSH drives the user unit and waits for the Agent to answer again");

    // L3: SSH stop of a system unit waits until the Agent stops answering.
    h = harness({ scope: "system", health: [true, false] });
    result = await h.service.control("node-a", "stop");
    assert.deepStrictEqual([result.mechanism, result.scope], ["ssh", "system"]);
    assert.strictEqual(h.commands.at(-1), "sudo -n systemctl stop anxos-agent");
    console.log("PASS L3 Stop of a packaged system unit uses sudo -n and is confirmed when the Agent goes away");

    // L4: a system unit without passwordless sudo gets a clear fix.
    h = harness({ scope: "system", actionResult: { code: 1, stdout: "", stderr: "sudo: a password is required" } });
    await expectCode(h.service.control("node-a", "start"), "REMOTE_AGENT_SUDO_REQUIRED");
    h = harness({ scope: "user", actionResult: { code: 5, stdout: "", stderr: "Unit not found" } });
    await expectCode(h.service.control("node-a", "start"), "REMOTE_AGENT_ACTION_FAILED");
    h = harness({ scope: "none" });
    await expectCode(h.service.control("node-a", "start"), "REMOTE_AGENT_UNIT_NOT_FOUND");
    console.log("PASS L4 sudo, failed commands and a missing unit each report their own reason");

    // L5: without an SSH key profile, Restart goes through the Agent; Start and Stop are refused.
    h = harness({ profile: null, selfRestart: true, health: [true, true] });
    result = await h.service.control("node-a", "restart");
    assert.strictEqual(result.mechanism, "agent-api");
    assert.strictEqual(h.calls.selfRestart, 1);
    assert.strictEqual(h.commands.length, 0, "no SSH command runs without a profile");
    await expectCode(harness({ profile: null, selfRestart: true }).service.control("node-a", "start"), "REMOTE_AGENT_SSH_PROFILE_MISSING");
    await expectCode(harness({ profile: { id: "pw", authType: "password" }, selfRestart: true }).service.control("node-a", "stop"), "REMOTE_AGENT_SSH_PROFILE_MISSING");
    await expectCode(harness({ profile: null, selfRestart: false }).service.control("node-a", "restart"), "REMOTE_AGENT_LIFECYCLE_UNAVAILABLE");
    console.log("PASS L5 no SSH key: Restart uses the Agent when it can restart itself; Start and Stop need SSH");

    // L6: an action that does not take effect is reported, not claimed.
    h = harness({ scope: "user", health: [false, false, false, false] });
    await expectCode(h.service.control("node-a", "start"), "REMOTE_AGENT_ACTION_UNCONFIRMED");
    await expectCode(harness().service.control("application-host", "restart"), "REMOTE_AGENT_LIFECYCLE_LOCAL_TARGET");
    await expectCode(harness().service.control("missing-node", "restart"), "NODE_NOT_FOUND");
    await expectCode(harness().service.control("node-a", "kill"), "REMOTE_AGENT_ACTION_INVALID");
    console.log("PASS L6 an unconfirmed action, this PC, unknown nodes and unknown actions are refused");

    // A1: the Agent restarts itself only when systemd started this very process.
    assert.deepStrictEqual(getSelfRestartCapability({ INVOCATION_ID: "abc", SYSTEMD_EXEC_PID: "4242" }, "linux", 4242), { supported: true, mechanism: "systemd" });
    assert.strictEqual(getSelfRestartCapability({ INVOCATION_ID: "abc", SYSTEMD_EXEC_PID: "1000" }, "linux", 4242).supported, false, "an inherited systemd environment is not a supervisor");
    assert.strictEqual(getSelfRestartCapability({}, "linux", 4242).supported, false);
    assert.strictEqual(getSelfRestartCapability({ INVOCATION_ID: "abc", SYSTEMD_EXEC_PID: "4242" }, "win32", 4242).supported, false);
    console.log("PASS A1 self-restart is offered only for a process systemd started itself");

    // A2: the route replies before restarting, and refuses without a supervisor.
    let scheduled = null;
    let response = handleAgentRestart({ method: "POST" }, { capability: { supported: true, mechanism: "systemd" }, scheduleRestart: (delayMs) => { scheduled = delayMs; } });
    assert.strictEqual(response.statusCode, 202);
    assert.strictEqual(response.body.restarting, true);
    assert.ok(Number.isFinite(scheduled) && scheduled > 0, "the restart is scheduled after the reply");
    scheduled = null;
    response = handleAgentRestart({ method: "POST" }, { capability: { supported: false }, scheduleRestart: () => { scheduled = 1; } });
    assert.strictEqual(response.statusCode, 409);
    assert.strictEqual(response.body.error.code, "AGENT_SELF_RESTART_UNSUPERVISED");
    assert.strictEqual(scheduled, null, "an unsupervised Agent never schedules its own exit");
    assert.strictEqual(handleAgentRestart({ method: "GET" }, { capability: { supported: true }, scheduleRestart: () => { scheduled = 1; } }).statusCode, 405);
    assert.strictEqual(scheduled, null);
    assert.notStrictEqual(AGENT_SELF_RESTART_EXIT_CODE, 0, "a failure exit code, so Restart=on-failure units come back");
    console.log("PASS A2 the restart route replies first, refuses without a supervisor, and exits with a failure code");
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  console.log("remote agent lifecycle smoke passed (8 checks).");
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
