#!/usr/bin/env node
"use strict";

// Regression for the Home dashboard / Computers view model (Phase 4).
//   H1 freshness: live, stale with age, unavailable; stale or disconnected
//      computers never show CPU/RAM as live numbers;
//   H2 pressure alerts need sustained evidence: a spike never alerts,
//      a gap in readings never counts as sustained;
//   H3 Needs attention: disconnected computers, crashed servers (with the
//      plain failure explanation), low disk, missing readings; most severe first;
//   H4 overview counts and players ("—" when nothing reports players);
//   H5 section preferences: unknown ids dropped, missing ids restored,
//      Needs attention cannot be hidden, history stays bounded.
// Readings are synthetic; nothing measures a real machine.
// Run: node scripts/home-dashboard-model-smoke.js

const assert = require("assert");
const path = require("path");

const model = require(path.join(__dirname, "..", "src", "shared", "homeDashboardModel.js"));
const failures = require(path.join(__dirname, "..", "src", "shared", "instances", "serverFailures.js"));

const NOW = 10_000_000;
const reading = (overrides = {}) => ({ at: NOW - 1000, cpuPercent: 20, memoryPercent: 40, memoryUsed: 4e9, memoryTotal: 1e10, diskPercent: 50, diskFree: 5e11, netDown: 1000, netUp: 500, gpus: [], perCore: [], platform: "linux", osVersion: "Debian 12", ...overrides });
const history = (key, values, stepMs) => values.map((value, index) => ({ at: NOW - (values.length - 1 - index) * stepMs, cpuPercent: key === "cpuPercent" ? value : 10, memoryPercent: key === "memoryPercent" ? value : 10 }));

// H1
assert.deepStrictEqual(model.freshnessOf(NOW - 1000, NOW, { freshMs: 10000 }), { state: "fresh", ageMs: 1000 });
assert.deepStrictEqual(model.freshnessOf(NOW - 20000, NOW, { freshMs: 10000 }).state, "stale");
assert.deepStrictEqual(model.freshnessOf(NOW - 10 * 60000, NOW).state, "unavailable");
assert.deepStrictEqual(model.freshnessOf(null, NOW).state, "unavailable");
assert.strictEqual(model.formatAge(45000), "45s ago");
assert.strictEqual(model.formatAge(120000), "2 min ago");

const online = { id: "a", name: "Anxlab", connection: "online", selected: false, serverCount: 2, runningServerCount: 1 };
let card = model.buildComputerCard(online, { reading: reading() }, NOW);
assert.deepStrictEqual([card.freshness, card.freshnessLabel, card.cpuPercent, card.os], ["fresh", "Live", 20, "Debian 12"]);
card = model.buildComputerCard(online, { reading: reading({ at: NOW - 60000 }) }, NOW);
assert.deepStrictEqual([card.freshness, card.freshnessLabel, card.cpuPercent], ["stale", "Last reading 1 min ago", 20], "a stale reading is labeled with its age");
card = model.buildComputerCard(online, { reading: reading({ at: NOW - 10 * 60000 }) }, NOW);
assert.deepStrictEqual([card.freshness, card.cpuPercent, card.memoryPercent], ["unavailable", null, null], "a too-old reading is not shown");
card = model.buildComputerCard({ ...online, connection: "offline" }, { reading: reading() }, NOW);
assert.deepStrictEqual([card.freshness, card.freshnessLabel, card.cpuPercent], ["unavailable", "Not connected", null], "a disconnected computer never shows its last numbers as live");
card = model.buildComputerCard({ ...online, isAnxOS: true }, { reading: reading() }, NOW);
assert.strictEqual(card.os, "AnxOS (Debian 12)");
card = model.buildComputerCard({ ...online, selected: true }, { reading: reading({ at: NOW - 20000 }) }, NOW);
assert.strictEqual(card.freshness, "stale", "the selected computer has a tighter freshness window");
console.log("PASS H1 freshness labels and no stale numbers shown as live");

// H2
assert.strictEqual(model.isSustained(history("memoryPercent", [95, 96, 97, 95, 96, 97, 98], 10000), "memoryPercent", 90, 60000, NOW), true, "a minute above 90% is sustained");
assert.strictEqual(model.isSustained(history("memoryPercent", [40, 41, 99, 40, 41, 40, 42], 10000), "memoryPercent", 90, 60000, NOW), false, "a spike is not sustained");
assert.strictEqual(model.isSustained(history("memoryPercent", [95, 96, 97], 2000), "memoryPercent", 90, 60000, NOW), false, "readings covering only a few seconds are not sustained");
assert.strictEqual(model.isSustained([...history("memoryPercent", [95, 96, 97, 95, 96, 97, 98], 10000)].map((entry, index) => (index === 3 ? { ...entry, memoryPercent: null } : entry)), "memoryPercent", 90, 60000, NOW), false, "a missing reading breaks the run");
console.log("PASS H2 pressure needs sustained readings, spikes never alert");

// H3
const vitals = {
  a: { reading: reading({ diskPercent: 98, diskFree: 1e9 }), history: history("memoryPercent", [95, 96, 97, 95, 96, 97, 98], 10000) },
  b: { reading: null, error: "unreachable" },
  c: { reading: reading({ at: NOW - 60000 }), error: "timeout" },
};
const items = model.buildAttentionItems({
  computers: [
    online,
    { id: "b", name: "VPS", connection: "offline" },
    { id: "c", name: "Laptop", connection: "online" },
  ],
  vitalsById: vitals,
  servers: [{ id: "s1", name: "Friends SMP", state: "Failed", failureReason: "PORT_IN_USE" }, { id: "s2", name: "Creative", state: "Running" }],
  now: NOW,
  explainFailure: failures.explainServerFailure,
});
const ids = items.map((item) => item.id);
assert.ok(ids.includes("computer-offline:b"));
assert.ok(ids.includes("memory:a"));
assert.ok(ids.includes("disk:a"));
assert.ok(ids.includes("monitoring:c"), "a connected computer without fresh readings is flagged");
assert.ok(ids.includes("server:s1") && !ids.includes("server:s2"));
const crashed = items.find((item) => item.id === "server:s1");
assert.strictEqual(crashed.title, "Friends SMP: its port is already taken");
assert.match(crashed.detail, /different port/);
assert.ok(items.findIndex((item) => item.severity === "warning") > items.findIndex((item) => item.severity === "critical"), "critical items come first");
assert.deepStrictEqual(model.buildAttentionItems({ computers: [online], vitalsById: { a: { reading: reading(), history: history("cpuPercent", [10, 99, 12], 1000) } }, now: NOW }), [], "a healthy computer with a CPU spike raises nothing");
const diskItem = (diskPercent, diskFree) => model.buildAttentionItems({ computers: [online], vitalsById: { a: { reading: reading({ diskPercent, diskFree }) } }, now: NOW }).find((item) => item.id === "disk:a") || null;
assert.strictEqual(diskItem(84, 5e11), null, "84% is not low disk");
assert.strictEqual(diskItem(86, 5e11).severity, "warning", "85%+ warns, like the alert engine");
assert.strictEqual(diskItem(96, 5e11).severity, "critical", "95%+ is critical, like the alert engine");
assert.strictEqual(diskItem(60, 1e9).severity, "critical", "under 2 GB free is critical, like node health");
const duplicates = model.buildAttentionItems({
  computers: [{ ...online, deviceId: "dev-1", name: "Anxlab (LAN)" }, { ...online, id: "t", deviceId: "dev-1", name: "Anxlab (Tailscale)" }, { ...online, id: "v", deviceId: "dev-2", name: "VPS" }],
  vitalsById: {},
  now: NOW,
}).filter((item) => item.id.startsWith("duplicate:"));
assert.strictEqual(duplicates.length, 1, "one item per duplicated Agent");
assert.ok(duplicates[0].detail.includes("Anxlab (LAN) and Anxlab (Tailscale) are the same AnxHost Agent"), duplicates[0].detail);
assert.deepStrictEqual(model.findDuplicateComputers([{ id: "x" }, { id: "y" }]), [], "computers without a device id are never called duplicates");
console.log("PASS H3 Needs attention covers computers, servers, disk and readings");

// H4
const overview = model.buildOverview({
  computers: [online, { id: "b", connection: "offline" }],
  servers: [{ running: true }, { running: false }],
  serversKnown: true,
  attention: items,
});
assert.deepStrictEqual([overview.servers.value, overview.servers.detail, overview.computers.value, overview.computers.detail], ["1", "of 2 running", "1", "of 2 online"]);
assert.deepStrictEqual(overview.players, { value: "—", detail: "Not reported by these servers" });
assert.strictEqual(model.buildOverview({ players: 3 }).players.value, "3");
assert.strictEqual(model.buildOverview({ fleetRunning: 4, fleetTotal: 6 }).servers.detail, "of 6 running", "fleet counts cover every computer");
assert.deepStrictEqual(model.buildOverview({ unknownServersDetail: "Computer not connected" }).servers, { value: "—", detail: "Computer not connected" }, "servers on a disconnected computer are not counted as running");
console.log("PASS H4 overview counts and players");

// H5
assert.deepStrictEqual(model.normalizePreferences(null), { order: ["attention", "servers", "computers", "setup"], hidden: [] });
assert.deepStrictEqual(model.normalizePreferences({ order: ["computers", "bogus", "servers"], hidden: ["attention", "setup", "bogus"] }), { order: ["computers", "servers", "attention", "setup"], hidden: ["setup"] });
assert.deepStrictEqual(model.moveSection(null, "computers", -1).order, ["attention", "computers", "servers", "setup"]);
assert.deepStrictEqual(model.moveSection(null, "attention", -1).order, ["attention", "servers", "computers", "setup"], "moving past the edge changes nothing");
let bounded = [];
for (let index = 0; index < model.HISTORY_LIMIT + 50; index += 1) bounded = model.appendHistory(bounded, { at: index, cpuPercent: 1, memoryPercent: 1 });
assert.strictEqual(bounded.length, model.HISTORY_LIMIT, "reading history stays bounded");
const fromSnapshot = model.readingFromSnapshot({ cpu: { usagePercent: null, perCore: [] }, memory: { percent: 50 }, network: { downloadPerSecond: null }, gpuUsage: { available: false, devices: [] } }, NOW);
assert.deepStrictEqual([fromSnapshot.cpuPercent, fromSnapshot.netDown, fromSnapshot.gpus], [null, null, []], "unmeasured values stay null");
console.log("PASS H5 preferences, bounded history, null stays null");

console.log("Home dashboard model smoke passed (5 checks).");
