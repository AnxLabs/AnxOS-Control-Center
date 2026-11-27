#!/usr/bin/env node
"use strict";

// Regression for Create Server's recommended settings (Phase 2).
//   C1 the port moves off one already used by another server on the computer;
//   C2 memory is lowered to fit a small computer and kept otherwise;
//   C3 the renderer prefills the wizard from these recommendations and
//      checks the template's software before the user clicks Create server;
//   C4 ports held by other programs are avoided and explained.
//   C5 "Will it run on this computer?" (Build 215-D): offline, wrong
//      operating system, too little memory in total or free right now, a
//      nearly full disk and missing metrics each give a plain reason; the
//      block is shown outside Advanced options and follows the memory field.
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
assert.match(memory.warning, /usually wants 4G, .* about 4G in total, so AnxHost set 3G/);
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

// C4 ports held by other programs (live listener list).
const owners = defaults.listenerPortOwners([
  { localPort: 25565, protocol: "tcp", processName: "java", pid: 412 },
  { localPort: "8080/tcp", pid: 9 },
  { localPort: 3000 },
]);
assert.deepStrictEqual(owners, { 25565: "java (PID 412)", 8080: "a program (PID 9)", 3000: "another program" });
port = defaults.recommendPort(25565, [], { owners });
assert.strictEqual(port.port, 25566);
assert.ok(port.reason.includes("in use on this computer by java (PID 412), so AnxHost picked 25566"), port.reason);
assert.strictEqual(defaults.isPortFree(25565, owners), false);
assert.strictEqual(defaults.isPortFree(25566, owners), true);
assert.strictEqual(defaults.isPortFree(25566, owners, { truncated: true }), null, "a truncated list never proves a port free");
assert.ok(app.includes("refreshCreateServerPortCheck(template).catch(() => {});"), "the live port check runs when setup opens");
assert.ok(app.includes("const busyHolder = getCreateServerPortHolder("), "Create server refuses a port another program holds");
console.log("PASS C4 ports held by other programs are avoided and explained");

{
  const fit = (overrides = {}) => defaults.assessComputerFit({
    computerName: "Anxlab",
    online: true,
    nodePlatform: "linux",
    templatePlatforms: [],
    memory: { total: 16 * GIB, used: 6 * GIB },
    templateMemory: "8G",
    disk: { free: 200 * GIB },
    ...overrides,
  });
  const good = fit();
  assert.strictEqual(good.verdict, "good");
  assert.ok(good.reasons.some((reason) => /Memory: 8G of 10 GB free/.test(reason.text)), JSON.stringify(good.reasons));
  assert.strictEqual(fit({ online: false }).verdict, "no");
  const wrongOs = fit({ templatePlatforms: ["windows"] });
  assert.strictEqual(wrongOs.verdict, "no");
  assert.ok(/runs on Windows; Anxlab runs Linux/.test(wrongOs.reasons[0].text), wrongOs.reasons[0].text);
  assert.strictEqual(fit({ nodePlatform: "win32", templatePlatforms: ["windows"] }).verdict, "good", "win32 is Windows");
  const service = fit({ nodePlatform: "win32", templatePlatforms: ["linux"], isService: true });
  assert.ok(/offered for Linux computers/.test(service.reasons[0].text));
  const tooBig = fit({ templateMemory: "32G" });
  assert.strictEqual(tooBig.verdict, "no");
  assert.ok(/set to use 32G, but Anxlab has 16 GB in total/.test(tooBig.reasons.find((reason) => reason.verdict === "no").text));
  const busy = fit({ memory: { total: 16 * GIB, used: 12 * GIB } });
  assert.strictEqual(busy.verdict, "tight");
  assert.ok(/4 GB is free right now/.test(busy.reasons.find((reason) => reason.verdict === "tight").text));
  assert.strictEqual(fit({ disk: { free: 1 * GIB } }).verdict, "no");
  const smallDisk = fit({ disk: { free: 6 * GIB } });
  assert.strictEqual(smallDisk.verdict, "tight");
  assert.ok(/size is not measured/.test(smallDisk.reasons.find((reason) => reason.verdict === "tight").text), "never claims a measured size");
  const unknown = fit({ memory: null, disk: null });
  assert.strictEqual(unknown.verdict, "unknown");
  assert.ok(unknown.reasons.every((reason) => reason.verdict === "unknown"));
  const fitBlock = index.indexOf("data-create-server-fit");
  assert.ok(fitBlock > 0 && fitBlock < index.indexOf("data-create-server-advanced"), "the fit check is above Advanced options, not inside it");
  assert.ok(app.includes("renderCreateServerFit(findMarketplaceTemplate())"), "the fit check follows the memory field");
  console.log("PASS C5 computer fit check explains good, tight, no and unknown");
}

console.log("Create Server defaults smoke passed (5 checks).");
