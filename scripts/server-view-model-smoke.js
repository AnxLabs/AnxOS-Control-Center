#!/usr/bin/env node
"use strict";

// Phase 5 server page rules (src/shared/serverViewModel.js).
//   P1 six main tabs; detail views keep their parent tab highlighted;
//   P2 one plain status: running operations win, a disconnected computer
//      never shows a server as running, errors carry their reason;
//   P3 live readings age to "stale", never shown as live;
//   P4 restart-required notes: only for running servers, cleared by a stop
//      or a start after the change;
//   P5 settings validation before anything is sent;
//   P6 memory suggestion only from a real reading;
//   P7 add-on support per game: plugins, mods, vanilla explained, other
//      games hidden.
// Run: node scripts/server-view-model-smoke.js

const assert = require("assert");
const Model = require("../src/shared/serverViewModel");

assert.deepStrictEqual([...Model.MAIN_TABS], ["overview", "console", "files", "mods", "backups", "settings"]);
assert.strictEqual(Model.TAB_LABELS.mods, "Add-ons");
assert.deepStrictEqual(["players", "performance", "network", "console", "nonsense"].map(Model.mainTabFor), ["overview", "overview", "settings", "console", "overview"]);
console.log("PASS P1 six main tabs; detail views map to their parent");

assert.strictEqual(Model.describeServerStatus({ state: "Running" }).label, "Running");
assert.strictEqual(Model.describeServerStatus({ state: "Running", ready: false }).label, "Starting");
assert.strictEqual(Model.describeServerStatus({ state: "Running", operation: { status: "running", type: "stop" } }).label, "Stopping");
assert.strictEqual(Model.describeServerStatus({ state: "Running", computerConnected: false }).label, "Computer offline", "a disconnected computer never shows Running");
const failed = Model.describeServerStatus({ state: "Failed", failureText: "The port is already in use." });
assert.deepStrictEqual([failed.label, failed.tone, failed.detail], ["Stopped with an error", "critical", "The port is already in use."]);
assert.strictEqual(Model.describeServerStatus({ state: "Stopped" }).label, "Stopped");
console.log("PASS P2 one plain status; operations win; offline computers never show Running");

const now = 1_000_000;
assert.strictEqual(Model.readingFreshness(now - 5000, now), "live");
assert.strictEqual(Model.readingFreshness(now - 60000, now), "stale");
assert.strictEqual(Model.readingFreshness(null, now), "none");
console.log("PASS P3 readings are live, stale or none");

let notes = Model.markRestartRequired({}, "srv", "memory", 1000);
notes = Model.markRestartRequired(notes, "srv", "add-on changes", 2000);
assert.deepStrictEqual(notes.srv, { since: 1000, reasons: ["memory", "add-on changes"] });
assert.ok(Model.restartRequiredFor(notes, { id: "srv", state: "Running" }));
assert.strictEqual(Model.restartRequiredFor(notes, { id: "srv", state: "Stopped" }), null, "a stopped server needs no restart note");
assert.ok(Model.settleRestartRequired(notes, { id: "srv", state: "Running", startedAt: new Date(500).toISOString() }).srv, "an older start keeps the note");
assert.strictEqual(Model.settleRestartRequired(notes, { id: "srv", state: "Running", startedAt: new Date(5000).toISOString() }).srv, undefined, "a start after the change clears it");
assert.strictEqual(Model.settleRestartRequired(notes, { id: "srv", state: "Stopped" }).srv, undefined, "a stop clears it");
assert.deepStrictEqual(Model.changedRestartFields({ memoryLimit: "2G", displayName: "A" }, { memoryLimit: "3G", displayName: "B" }), ["memoryLimit"], "renaming needs no restart");
console.log("PASS P4 restart notes follow the server's real state");

assert.deepStrictEqual(Model.validateServerSettings({ displayName: "", memoryLimit: "lots", startupTimeoutMs: "5" }), {
  displayName: "Give the server a name.",
  memoryLimit: "Use a size such as 4G or 4096M.",
  startupTimeoutMs: "Use a whole number of milliseconds between 1000 and 3600000.",
});
assert.deepStrictEqual(Model.validateServerSettings({ displayName: "Survival", memoryLimit: "4G", startupTimeoutMs: "60000", shutdownTimeoutMs: "" }), {});
assert.strictEqual(Model.validateServerSettings({ memoryLimit: "100M" }).memoryLimit, "Use at least 256M.");
assert.ok(Model.validateServerSettings({ environment: { "BAD NAME": "x" } }).environment);
console.log("PASS P5 settings are validated before saving");

const GB = 1024 ** 3;
assert.strictEqual(Model.suggestMemory(8 * GB, 16 * GB), "4G");
assert.strictEqual(Model.suggestMemory(64 * GB, 128 * GB), "16G", "capped at 16G");
assert.strictEqual(Model.suggestMemory(1 * GB, 4 * GB), "1G", "at least 1G");
assert.strictEqual(Model.suggestMemory(null, 16 * GB), null, "no reading, no guess");
console.log("PASS P6 memory suggestions come only from real readings");

const paper = Model.describeAddonSupport({ serverSoftware: "Paper", minecraftVersion: "1.21.1" }, { isMinecraft: true });
assert.deepStrictEqual([paper.show, paper.supported, paper.kind], [true, true, "plugins"]);
assert.strictEqual(Model.describeAddonSupport({ serverSoftware: "NeoForge", minecraftVersion: "1.21.1" }, { isMinecraft: true }).kind, "mods");
const vanilla = Model.describeAddonSupport({ serverSoftware: "Vanilla", minecraftVersion: "1.21.1" }, { isMinecraft: true });
assert.deepStrictEqual([vanilla.show, vanilla.supported], [true, false]);
assert.match(vanilla.reason, /Vanilla can't load mods or plugins/);
assert.match(Model.describeAddonSupport({ serverSoftware: "Paper" }, { isMinecraft: true }).reason, /Minecraft version/);
assert.strictEqual(Model.describeAddonSupport({ serverSoftware: "Palworld" }, { isMinecraft: false }).show, false, "other games show no Add-ons tab");
console.log("PASS P7 add-on support per game, vanilla explained");

console.log("Server view model smoke passed (7 checks).");
