#!/usr/bin/env node
// Agent update manager: fleet classification, Update All, and the automatic
// schedule (off by default).
//   M1 classification of every node state
//   M2 overview counts and the updatable total
//   M3 Update All runs one node at a time, continues past expected refusals,
//      stops at a real failure and marks the rest not started
//   M4 policy: missing/malformed file means disabled; values are bounded
//   M5 maintenance window, including one that crosses midnight
//   M6 tick: disabled / outside / once per window / next window again
//   M7 a window on the DST fall-back day (America/Denver) behaves and ends
//   M8 the scheduler with no policy file never updates anything
//   M9 notify mode records available updates and installs nothing; only
//      the computers the owner chose are considered
//   M10 running servers skip a computer; switching off stops before the next
//   M11 history: one entry per attempt, updated in place, rollback as reported
//   M12 the saved policy is what the scheduler reads; turning it off mid-run
//       stops at the next computer
process.env.TZ = "America/Denver";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const manager = require("../src/services/agentUpdateManager");

const DESKTOP = "2.0-build213";
const node = (id, build, extra = {}) => ({ id, displayName: id, platform: "linux", connection: { status: "online", agentArtifactVersion: build }, ...extra });
const keyProfile = { id: "k", authType: "privateKey" };

(async () => {
  // M1
  {
    const c = (n, profile = keyProfile) => manager.classifyNodeAgentUpdate(n, { desktopBuild: DESKTOP, profile });
    assert.strictEqual(c({ id: "application-host" }).state, "local");
    assert.strictEqual(c(node("off", "2.0-build212", { connection: { status: "offline" } })).state, "offline");
    assert.strictEqual(c(node("win", "2.0-build212", { platform: "win32" })).state, "unsupported");
    assert.strictEqual(c(node("old", "")).state, "unknown-build");
    assert.strictEqual(c(node("same", DESKTOP)).state, "up-to-date");
    assert.strictEqual(c(node("newer", "2.0-build214")).state, "newer-than-desktop");
    const noProfile = c(node("np", "2.0-build212"), null);
    assert.strictEqual(noProfile.state, "update-available");
    assert.strictEqual(noProfile.canUpdate, false);
    assert(/SSH key profile/.test(noProfile.reason));
    assert.strictEqual(c(node("pw", "2.0-build212"), { id: "p", authType: "password" }).canUpdate, false);
    const ready = c(node("ready", "2.0-build212"));
    assert.strictEqual(ready.canUpdate, true);
    assert.strictEqual(ready.reason, "Update 2.0-build212 → 2.0-build213.");
    assert.strictEqual(manager.classifyNodeAgentUpdate(node("x", "2.0-build212"), { desktopBuild: null, profile: keyProfile }).canUpdate, false);
    console.log("  ok M1 classification");
  }

  // M2
  const fleet = [{ id: "application-host" }, node("a", "2.0-build212"), node("b", DESKTOP), node("c", "2.0-build211"), node("d", "2.0-build212")];
  const overview = await manager.getAgentUpdateOverview({ listNodes: async () => fleet, desktopBuild: DESKTOP, getProfileForNode: (id) => (id === "d" ? null : keyProfile) });
  {
    assert.strictEqual(overview.updatable, 2);
    assert.strictEqual(overview.counts["update-available"], 3);
    assert.strictEqual(overview.counts["up-to-date"], 1);
    assert.strictEqual(overview.counts.local, 1);
    console.log("  ok M2 overview");
  }

  // M3
  {
    const order = [];
    let active = 0;
    const updateAgent = async (nodeId) => {
      active += 1;
      assert.strictEqual(active, 1, "one update at a time");
      order.push(nodeId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (nodeId === "a") throw Object.assign(new Error("servers"), { code: "REMOTE_AGENT_UPDATE_SERVERS_RUNNING" });
      return { updated: true };
    };
    const result = await manager.updateAllAgents({ overview, updateAgent });
    assert.deepStrictEqual(order, ["a", "c"], "continues past an expected refusal");
    assert.strictEqual(result.updated, 1);
    assert.strictEqual(result.failed, 1);

    const three = { nodes: ["p", "q", "r"].map((id) => ({ nodeId: id, name: id, canUpdate: true, targetBuild: DESKTOP })) };
    const tried = [];
    const stopping = await manager.updateAllAgents({
      overview: three,
      updateAgent: async (nodeId) => {
        tried.push(nodeId);
        if (nodeId === "q") throw Object.assign(new Error("did not verify"), { code: "REMOTE_AGENT_UPDATE_VERIFY_FAILED" });
        return { updated: true };
      },
    });
    assert.deepStrictEqual(tried, ["p", "q"], "a real failure stops the run");
    assert.strictEqual(stopping.ok, false);
    assert.deepStrictEqual(stopping.results.map((entry) => entry.code || "ok"), ["ok", "REMOTE_AGENT_UPDATE_VERIFY_FAILED", "AGENT_UPDATE_NOT_STARTED"]);
    console.log("  ok M3 Update All");
  }

  // M4
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-agent-auto-update-"));
    assert.strictEqual(manager.readAutoUpdatePolicy(dir).enabled, false, "missing file = off");
    fs.writeFileSync(path.join(dir, manager.AUTO_UPDATE_FILENAME), "{not json");
    assert.strictEqual(manager.readAutoUpdatePolicy(dir).enabled, false, "malformed file = off");
    fs.writeFileSync(path.join(dir, manager.AUTO_UPDATE_FILENAME), JSON.stringify({ enabled: "yes" }));
    assert.strictEqual(manager.readAutoUpdatePolicy(dir).enabled, false, "only literal true enables");
    fs.writeFileSync(path.join(dir, manager.AUTO_UPDATE_FILENAME), JSON.stringify({ enabled: true, days: [6, 9, 0], start: "25:00", durationMinutes: 5 }));
    const bounded = manager.readAutoUpdatePolicy(dir);
    assert.deepStrictEqual(bounded, { enabled: true, mode: "notify", nodeIds: [], days: [0, 6], start: "03:00", durationMinutes: 120 });
    assert.deepStrictEqual(manager.normalizeAutoUpdatePolicy({ mode: "apply", nodeIds: ["a", "a", "application-host", ""] }).nodeIds, ["a"], "computers deduplicated; This PC is never auto-updated here");
    fs.rmSync(dir, { recursive: true, force: true });
    assert.strictEqual(manager.DEFAULT_AUTO_UPDATE_POLICY.enabled, false);
    console.log("  ok M4 policy defaults");
  }

  // M5
  {
    const policy = manager.normalizeAutoUpdatePolicy({ enabled: true, days: [1], start: "23:00", durationMinutes: 180 });
    // 2026-11-16 is a Monday.
    assert.strictEqual(manager.isWithinMaintenanceWindow(policy, new Date(2026, 10, 16, 23, 30)), true, "Monday 23:30");
    assert.strictEqual(manager.isWithinMaintenanceWindow(policy, new Date(2026, 10, 17, 1, 30)), true, "Tuesday 01:30 belongs to Monday's window");
    assert.strictEqual(manager.isWithinMaintenanceWindow(policy, new Date(2026, 10, 17, 2, 0)), false, "window ends at 02:00");
    assert.strictEqual(manager.isWithinMaintenanceWindow(policy, new Date(2026, 10, 16, 1, 30)), false, "Monday 01:30 belongs to Sunday, not in days");
    assert.strictEqual(manager.isWithinMaintenanceWindow(policy, new Date(2026, 10, 17, 23, 30)), false, "Tuesday not in days");
    console.log("  ok M5 maintenance window");
  }

  // M6
  {
    const policy = manager.normalizeAutoUpdatePolicy({ enabled: true, mode: "apply", nodeIds: ["a", "c"], start: "03:00", durationMinutes: 60 });
    const state = {};
    let runs = 0;
    const deps = (now) => ({ policy, now, state, getOverview: async () => overview, updateAgent: async () => { runs += 1; return { updated: true }; } });
    assert.strictEqual((await manager.runAutoUpdateTick({ ...deps(new Date(2026, 10, 16, 3, 10)), policy: { ...policy, enabled: false } })).reason, "disabled");
    assert.strictEqual((await manager.runAutoUpdateTick(deps(new Date(2026, 10, 16, 5, 0)))).reason, "outside-window");
    assert.strictEqual((await manager.runAutoUpdateTick(deps(new Date(2026, 10, 16, 3, 10)))).reason, "updated");
    assert.strictEqual((await manager.runAutoUpdateTick(deps(new Date(2026, 10, 16, 3, 40)))).reason, "already-ran");
    assert.strictEqual((await manager.runAutoUpdateTick(deps(new Date(2026, 10, 17, 3, 5)))).reason, "updated", "next day's window runs again");
    assert.strictEqual(runs, 4, "two updatable nodes per window, two windows");
    console.log("  ok M6 tick once per window");
  }

  // M7
  {
    const policy = manager.normalizeAutoUpdatePolicy({ enabled: true, start: "01:00", durationMinutes: 120 });
    const started = Date.now();
    // 2026-11-01 01:30 happens twice in America/Denver (fall back).
    assert.strictEqual(manager.isWithinMaintenanceWindow(policy, new Date(2026, 10, 1, 1, 30)), true);
    assert.strictEqual(manager.isWithinMaintenanceWindow(policy, new Date(2026, 10, 1, 3, 0)), false);
    const state = {};
    const first = await manager.runAutoUpdateTick({ policy, now: new Date(2026, 10, 1, 1, 30), state, getOverview: async () => ({ updatable: 0 }), updateAgent: async () => ({}) });
    const repeat = await manager.runAutoUpdateTick({ policy, now: new Date(2026, 10, 1, 1, 45), state, getOverview: async () => ({ updatable: 0 }), updateAgent: async () => ({}) });
    assert.strictEqual(first.reason, "nothing-to-update");
    assert.strictEqual(repeat.reason, "already-ran");
    assert(Date.now() - started < 1000, "no time loop");
    console.log("  ok M7 DST fall-back day");
  }

  // M8
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-agent-auto-update-off-"));
    let called = 0;
    const scheduler = manager.startAgentAutoUpdateScheduler({ configDir: dir, getOverview: async () => { called += 1; return overview; }, updateAgent: async () => { called += 1; }, intervalMs: 60000 });
    await scheduler.tick();
    scheduler.stop();
    assert.strictEqual(called, 0, "no policy file: nothing is read or updated");
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("  ok M8 scheduler is off without a policy");
  }

  // M9
  {
    const notified = [];
    let installs = 0;
    const policy = manager.normalizeAutoUpdatePolicy({ enabled: true, mode: "notify", nodeIds: ["a"], start: "03:00", durationMinutes: 60 });
    const outcome = await manager.runAutoUpdateTick({ policy, now: new Date(2026, 10, 16, 3, 10), state: {}, getOverview: async () => overview, updateAgent: async () => { installs += 1; }, notify: (entry) => notified.push(entry.nodeId) });
    assert.strictEqual(outcome.reason, "notified");
    assert.deepStrictEqual(notified, ["a"], "only the chosen computer, and c (not chosen) is left out");
    assert.strictEqual(installs, 0, "notify-only installs nothing");
    const none = await manager.runAutoUpdateTick({ policy: { ...policy, nodeIds: [] }, now: new Date(2026, 10, 16, 3, 10), state: {}, getOverview: async () => overview, updateAgent: async () => { installs += 1; } });
    assert.strictEqual(none.reason, "nothing-to-update", "no chosen computers, nothing happens");
    console.log("  ok M9 notify-only and chosen computers");
  }

  // M10
  {
    const tried = [];
    const skipped = await manager.updateAllAgents({
      overview,
      updateAgent: async (nodeId) => { tried.push(nodeId); return { updated: true }; },
      before: async (entry) => (entry.nodeId === "a" ? { code: "REMOTE_AGENT_UPDATE_SERVERS_RUNNING", message: "1 server is running on a" } : null),
    });
    assert.deepStrictEqual(tried, ["c"], "a computer with running servers is skipped, the next is updated");
    assert.strictEqual(skipped.skippedCount, 1);
    assert.strictEqual(skipped.failed, 0, "a skip is not a failure");
    let allow = true;
    const stopped = await manager.updateAllAgents({
      overview,
      updateAgent: async (nodeId) => { allow = false; return { updated: true, nodeId }; },
      shouldContinue: () => allow,
    });
    assert.strictEqual(stopped.updated, 1);
    assert.strictEqual(stopped.results[1].code, "AGENT_UPDATE_DISABLED", "turned off mid-run: the next computer is not started");
    console.log("  ok M10 running servers and switching off");
  }

  // M11
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-agent-update-history-"));
    const entry = { nodeId: "a", name: "a", installedBuild: "2.0-build212", targetBuild: DESKTOP };
    manager.recordUpdateHistory(dir, manager.historyEntryFor({ id: "1", at: "t", trigger: "manual", overviewEntry: entry, outcome: { status: "running" } }));
    const rolledBack = Object.assign(new Error("did not come up"), { code: "REMOTE_AGENT_UPDATE_VERIFY_FAILED", details: { rollback: { verified: true } } });
    manager.recordUpdateHistory(dir, manager.historyEntryFor({ id: "1", at: "t", trigger: "manual", overviewEntry: entry, outcome: { status: "failed", error: rolledBack } }));
    let history = manager.readUpdateHistory(dir);
    assert.strictEqual(history.length, 1, "the running entry is updated in place");
    assert.deepStrictEqual([history[0].status, history[0].rollback, history[0].fromBuild, history[0].toBuild], ["failed", "rolled-back", "2.0-build212", DESKTOP]);
    const sudo = Object.assign(new Error("needs sudo"), { code: "REMOTE_AGENT_UPDATE_SUDO_REQUIRED", details: { manualCommand: "sudo apt-get install /x.deb" } });
    manager.recordUpdateHistory(dir, manager.historyEntryFor({ id: "2", at: "t", trigger: "automatic", overviewEntry: entry, outcome: { status: "needs-approval", error: sudo } }));
    const noRollback = Object.assign(new Error("no package"), { code: "REMOTE_AGENT_UPDATE_ROLLBACK_UNAVAILABLE" });
    manager.recordUpdateHistory(dir, manager.historyEntryFor({ id: "3", at: "t", trigger: "update-all", overviewEntry: entry, outcome: { status: "failed", error: noRollback } }));
    history = manager.readUpdateHistory(dir);
    assert.deepStrictEqual(history.map((item) => item.id), ["3", "2", "1"], "newest first");
    assert.strictEqual(history[1].manualCommand, "sudo apt-get install /x.deb");
    assert.strictEqual(history[0].rollback, "unavailable");
    for (let index = 0; index < 210; index += 1) manager.recordUpdateHistory(dir, { id: `bulk-${index}`, status: "skipped" });
    assert.strictEqual(manager.readUpdateHistory(dir).length, 200, "history is capped");
    fs.rmSync(dir, { recursive: true, force: true });
    console.log("  ok M11 history");
  }

  // M12
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-agent-auto-update-live-"));
    const startHour = `${String(new Date().getHours()).padStart(2, "0")}:00`;
    const saved = manager.writeAutoUpdatePolicy(dir, { enabled: true, mode: "apply", nodeIds: ["a", "c"], days: [0, 1, 2, 3, 4, 5, 6], start: startHour, durationMinutes: 120 });
    assert.deepStrictEqual(manager.readAutoUpdatePolicy(dir), saved, "what is saved is what is read");
    const updated = [];
    let scheduler = null;
    scheduler = manager.startAgentAutoUpdateScheduler({
      configDir: dir,
      getOverview: async () => overview,
      updateAgent: async (nodeId) => {
        updated.push(nodeId);
        // The owner turns automatic updates off while the first computer updates.
        manager.writeAutoUpdatePolicy(dir, { ...saved, enabled: false });
        return { updated: true };
      },
      intervalMs: 60000,
    });
    await scheduler.tick();
    assert.deepStrictEqual(updated, ["a"], "switching off stopped the run before c");
    console.log("  ok M12 saved policy controls the scheduler, and off stops at once");
    scheduler.stop();
    assert.strictEqual(manager.readAutoUpdatePolicy(dir).enabled, false);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // M13 (after the Build 213 Agent updates): only servers an Agent restart
  // would stop block an update. A service-managed server (systemd-service)
  // keeps running through the restart, as AnxRP did on the VPS.
  {
    const stopped = manager.serversStoppedByAgentRestart([
      { id: "anxrp", type: "systemd-service", state: "Running" },
      { id: "palworld", type: "custom-command", state: "Running" },
      { id: "terraria", type: "custom-command", state: "Stopped" },
      { id: "paper", type: "minecraft-paper", state: "starting" },
      { id: "staging", type: "systemd-service", state: "Starting" },
    ]).map((instance) => instance.id);
    assert.deepStrictEqual(stopped, ["palworld", "paper"], "running Agent-owned servers block; service-managed and stopped ones do not");
    assert.deepStrictEqual(manager.serversStoppedByAgentRestart([{ id: "anxrp", type: "systemd-service", state: "Running" }]), [], "a VPS that only runs AnxRP can be updated");
    assert.deepStrictEqual(manager.serversStoppedByAgentRestart(null), []);
    console.log("  ok M13 only servers the Agent restart would stop block an update");
  }

  console.log("Agent update manager smoke passed (13 cases).");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
