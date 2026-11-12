#!/usr/bin/env node
"use strict";

// Regression for Create Server's recommended settings (Phase 2).
//   C1 the port moves off one already used by another server on the computer;
//   C2 memory is lowered to fit a small computer and kept otherwise;
//   C3 the renderer prefills the wizard from these recommendations and
//      checks the template's software before the user clicks Create server.
// Run: node scripts/create-server-defaults-smoke.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const defaults = require(path.join(root, "src", "shared", "createServerDefaults.js"));
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const GIB = 1024 * 1024 * 1024;

// C1
assert.deepStrictEqual(defaults.recommendPort(25565, []), { port: 25565, changed: false, reason: "" });
let port = defaults.recommendPort(25565, [25565, "25566/tcp", 8080]);
assert.strictEqual(port.port, 25567, "skips every used port, including 'port/proto' strings");
assert.strictEqual(port.changed, true);
assert.match(port.reason, /25565 is already used .* picked 25567/);
assert.strictEqual(defaults.recommendPort(null, [1]).port, null, "no default port means no recommendation");
port = defaults.recommendPort(65535, [65535]);
assert.strictEqual(port.port, 65535, "never recommends a port above 65535");
assert.match(port.reason, /choose a port under Advanced options/);
console.log("PASS C1 port avoids other servers on the computer");

// C2
assert.deepStrictEqual(defaults.recommendMemory("4G", { totalBytes: 16 * GIB }), { memory: "4G", changed: false, warning: "" });
assert.deepStrictEqual(defaults.recommendMemory("4G"), { memory: "4G", changed: false, warning: "" }, "no metrics keeps the recommendation");
let memory = defaults.recommendMemory("4G", { totalBytes: 4 * GIB });
assert.strictEqual(memory.memory, "3G", "4 GiB computer leaves 1 GiB for the system");
assert.strictEqual(memory.changed, true);
assert.match(memory.warning, /usually wants 4G, .* about 4G in total, so AnxOS set 3G/);
memory = defaults.recommendMemory("2G", { totalBytes: 1.2 * GIB });
assert.strictEqual(memory.memory, "2G", "too-small computers keep the value and get a warning");
assert.match(memory.warning, /very little/);
assert.strictEqual(defaults.parseMemoryMiB("512M"), 512);
assert.strictEqual(defaults.parseMemoryMiB("2g"), 2048);
assert.strictEqual(defaults.parseMemoryMiB("lots"), null);
assert.strictEqual(defaults.formatMemoryMiB(1536), "1536M");
assert.deepStrictEqual(defaults.recommendMemory("bad", { totalBytes: GIB }), { memory: "bad", changed: false, warning: "" }, "invalid input is left for field validation");
console.log("PASS C2 memory fits the computer");

// C3
assert.ok(app.includes("const recommendations = getCreateServerRecommendations(template);"), "the wizard prefills from recommendations");
assert.ok(app.includes("AnxCreateServerDefaults.recommendPort(") && app.includes("AnxCreateServerDefaults.recommendMemory("), "the renderer uses the shared module");
assert.ok(app.includes("refreshCreateServerDependencyState(template).catch(() => {});"), "the software check starts when the wizard opens");
const moduleAt = index.indexOf('src="src/shared/createServerDefaults.js"');
assert.ok(moduleAt > 0 && moduleAt < index.indexOf('src="app.js"'), "createServerDefaults.js loads before app.js");
console.log("PASS C3 the wizard uses the recommendations and checks software up front");

console.log("Create Server defaults smoke passed (3 checks).");
