#!/usr/bin/env node
"use strict";

// qa:release --reuse-rc skips only what rc:validate already passed on the
// same commit, with a clean tree, on the same platform.
//   R1 a matching results file maps passed npm smokes to their scripts
//   R2 another commit, a dirty tree (then or now), another platform or an
//      unknown file is refused
//   R3 a failed suite, or a smoke run with arguments or environment, is not
//      reused; checks with arguments and git checks always run
//   R4 the real release tier and package.json produce a reuse set (the
//      wiring qa:release uses), and every reused check is a release check
// Run: node scripts/rc-reuse-smoke.js

const assert = require("assert");
const path = require("path");
const { RC_RESULTS_SCHEMA, scriptFileOf, loadReusableRcResults, partitionChecks } = require("./rc-reuse");

const packageScripts = {
  "a:smoke": "node scripts/a-smoke.js",
  "b:smoke": "node scripts/b-smoke.js",
  "c:smoke": "node scripts/c-smoke.js --strict",
  "d:smoke": "AGENT_URL=x node scripts/d-smoke.js",
  "e:smoke": "node scripts/e-smoke.js",
};
const head = "4c830ec4aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const base = { schema: RC_RESULTS_SCHEMA, commit: head, treeCleanAtStart: true, treeCleanAtEnd: true, platform: "win32", passed: ["a:smoke", "b:smoke", "c:smoke", "d:smoke"], failed: ["e:smoke"] };
const context = { head, treeClean: true, platform: "win32", packageScripts };
const checks = [
  ["node", ["scripts/a-smoke.js"]],
  ["node", ["scripts/b-smoke.js"]],
  ["node", ["scripts/c-smoke.js"]],
  ["node", ["scripts/d-smoke.js"]],
  ["node", ["scripts/e-smoke.js"]],
  ["node", ["--check", "app.js"]],
  ["node", ["scripts/ui-qa.js"]],
  ["git", ["diff", "--check"]],
];

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push(`PASS ${label}`);
  } catch (error) {
    results.push(`FAIL ${label}\n  ${error.stack || error}`);
  }
}

check("R1 a matching results file maps passed smokes to their scripts", () => {
  const reusable = loadReusableRcResults(base, context);
  assert.strictEqual(reusable.ok, true, reusable.reason);
  assert.deepStrictEqual([...reusable.files].sort(), ["scripts/a-smoke.js", "scripts/b-smoke.js"]);
});

check("R2 another commit, a dirty tree, another platform or a foreign file is refused", () => {
  const refused = (override, ctx = context) => loadReusableRcResults({ ...base, ...override }, ctx);
  assert.match(refused({ commit: "0".repeat(40) }).reason, /not HEAD/);
  assert.match(refused({ treeCleanAtStart: false }).reason, /not clean during/);
  assert.match(refused({ treeCleanAtEnd: false }).reason, /not clean during/);
  assert.match(refused({}, { ...context, treeClean: false }).reason, /not clean now/);
  assert.match(refused({ platform: "linux" }).reason, /ran on linux/);
  assert.match(refused({ schema: 99 }).reason, /not an rc:validate results file/);
  assert.strictEqual(loadReusableRcResults(null, context).ok, false);
  assert.strictEqual(refused({}, { ...context, head: null }).ok, false);
});

check("R3 failed suites and smokes with arguments are not reused; other checks always run", () => {
  assert.strictEqual(scriptFileOf("node scripts/c-smoke.js --strict"), null);
  assert.strictEqual(scriptFileOf("AGENT_URL=x node scripts/d-smoke.js"), null);
  assert.strictEqual(scriptFileOf("node scripts/a-smoke.js"), "scripts/a-smoke.js");
  const { files } = loadReusableRcResults(base, context);
  const { run, reused } = partitionChecks(checks, files);
  assert.deepStrictEqual(reused.map(([, a]) => a.join(" ")), ["scripts/a-smoke.js", "scripts/b-smoke.js"]);
  assert.deepStrictEqual(run.map(([c, a]) => [c, ...a].join(" ")), [
    "node scripts/c-smoke.js", "node scripts/d-smoke.js", "node scripts/e-smoke.js",
    "node --check app.js", "node scripts/ui-qa.js", "git diff --check",
  ]);
});

check("R4 the real release tier and package.json produce a reuse set", () => {
  const fs = require("fs");
  const source = fs.readFileSync(path.join(__dirname, "release-validation.js"), "utf8");
  const block = source.slice(source.indexOf("  release: ["), source.indexOf("\n  ],", source.indexOf("  release: [")));
  const releaseFiles = new Set([...block.matchAll(/\["node", \["(scripts\/[^"]+\.js)"\]\]/g)].map((m) => m[1]));
  const realScripts = require(path.join(__dirname, "..", "package.json")).scripts;
  const smokes = Object.keys(realScripts).filter((name) => name.endsWith(":smoke"));
  const reusable = loadReusableRcResults({ ...base, passed: smokes }, { ...context, packageScripts: realScripts });
  const releaseChecks = [...releaseFiles].map((file) => ["node", [file]]);
  const { run, reused } = partitionChecks(releaseChecks, reusable.files);
  assert.ok(reused.length > 50, `release checks that rc:validate also runs are reusable (${reused.length})`);
  assert.ok(run.some(([, a]) => /-ui-qa\.js$/.test(a[0])), "real-app UI checks still run");
  for (const [, a] of reused) assert.ok(releaseFiles.has(a[0]));
});

for (const line of results) console.log(line);
const failed = results.filter((line) => line.startsWith("FAIL")).length;
if (failed) {
  console.log(`rc-reuse-smoke: ${failed} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`rc-reuse-smoke passed (${results.length} checks)`);
