#!/usr/bin/env node
"use strict";

// Regression for the single dependency-preparation flow (Phase 2).
//   D1 the shared plan helpers classify and format Agent plans;
//   D2 the renderer has exactly one plan -> confirm -> install -> verify
//      implementation, and Prepare Node, Sharing provider installs and
//      Create Server recovery all use it (no direct install calls left);
//   D3 the shared module loads before app.js.
// Run: node scripts/dependency-preparation-smoke.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const prep = require(path.join(root, "src", "shared", "dependencyPreparation.js"));
const app = fs.readFileSync(path.join(root, "app.js"), "utf8").replace(/\r\n/g, "\n");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");

// D1
assert.strictEqual(prep.classifyPlan({ ok: true, installableActions: [], manualActions: [] }), "not-needed");
assert.strictEqual(prep.classifyPlan({ ok: true, installableActions: [{ id: "java" }] }), "installable");
assert.strictEqual(prep.classifyPlan({ ok: true, installableActions: [], manualActions: [{ id: "x" }] }), "manual");
assert.strictEqual(prep.classifyPlan({ ok: false }), "manual", "an unusable plan never counts as installable");
assert.strictEqual(prep.classifyPlan(null), "manual");
const text = prep.formatPlan({
  installableActions: [{ id: "java", displayName: "Java 21", packages: ["openjdk-21-jre-headless"], commands: [{ command: "apt-get", args: ["install", "-y", "openjdk-21-jre-headless"] }] }],
  manualActions: [{ id: "steam", displayName: "Steam login", reason: "needs your account" }],
});
assert.ok(text.includes("Java 21: openjdk-21-jre-headless"), "packages are listed");
assert.ok(text.includes("apt-get install -y openjdk-21-jre-headless"), "commands are shown before anything runs");
assert.ok(text.includes("Steam login: needs your account"), "manual steps are listed");
assert.strictEqual(prep.formatPlan({}), "No dependency changes are planned.");
assert.deepStrictEqual(prep.getStillMissingIds({ missingDependencyIds: ["java"] }), ["java"]);
assert.deepStrictEqual(
  prep.getStillMissingIds({ dependencies: [{ id: "docker", installed: false }] }),
  [],
  "optional tools listed in a result are not treated as a failed install",
);
assert.strictEqual(prep.describeDependencies([{ displayName: "Java" }, "SteamCMD", { id: "7zip" }]), "Java, SteamCMD and 7zip");
assert.strictEqual(prep.describeDependencies([]), "");
console.log("PASS D1 shared plan helpers");

// D2
const installCalls = app.match(/api\.dependencies\.install\(/g) || [];
assert.strictEqual(installCalls.length, 1, `exactly one dependencies.install call in app.js (found ${installCalls.length})`);
assert.ok(app.includes("async function prepareNodeDependencies("), "the shared flow exists");
const callers = app.match(/await prepareNodeDependencies\(/g) || [];
assert.strictEqual(callers.length, 3, `Prepare Node, Sharing and Create Server use the shared flow (found ${callers.length})`);
const flow = app.slice(app.indexOf("async function prepareNodeDependencies("), app.indexOf("async function maybePrepareMarketplaceDependencies("));
assert.ok(flow.indexOf("getDependencyPreparationPlan(") < flow.indexOf("createSecurityConfirmation("), "the plan is fetched before confirmation");
assert.ok(flow.indexOf("createSecurityConfirmation(") < flow.indexOf("api.dependencies.install("), "nothing installs before the user confirms");
assert.ok(flow.includes("getStillMissingIds(installResult)"), "installs are verified");
console.log("PASS D2 one dependency install implementation, used by all three callers");

// D3
const moduleAt = index.indexOf('src="src/shared/dependencyPreparation.js"');
const appAt = index.indexOf('src="app.js"');
assert.ok(moduleAt > 0 && moduleAt < appAt, "dependencyPreparation.js loads before app.js");
console.log("PASS D3 the shared module loads before app.js");

console.log("Dependency preparation smoke passed (3 checks).");
