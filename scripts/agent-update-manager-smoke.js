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
    assert.deepStrictEqual(bounded, { enabled: true, days: [0, 6], start: "03:00", durationMinutes: 120 });
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
    const policy = manager.normalizeAutoUpdatePolicy({ enabled: true, start: "03:00", durationMinutes: 60 });
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

  console.log("Agent update manager smoke passed (8 cases).");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
