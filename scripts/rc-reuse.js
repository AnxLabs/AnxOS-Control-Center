"use strict";

// Lets qa:release reuse the smokes rc:validate already passed on the same
// commit, instead of running them a second time (about 112 checks, 7 minutes,
// at Build 216). Reuse is refused unless the rc:validate results file proves
// the same commit, a clean tree before and after that run, a clean tree now,
// and the same platform: a Linux CI run never stands in for a Windows check.

const RC_RESULTS_SCHEMA = 1;

// "node scripts/x.js" with nothing else: a script run with extra arguments or
// environment is a different check, so it is never treated as the same one.
function scriptFileOf(npmCommand) {
  const match = /^node (scripts\/[A-Za-z0-9._/-]+\.js)$/.exec(String(npmCommand || "").trim());
  return match ? match[1] : null;
}

// Returns { ok: true, commit, files } or { ok: false, reason }.
function loadReusableRcResults(results, { head, treeClean, platform, packageScripts }) {
  if (!results || results.schema !== RC_RESULTS_SCHEMA) return { ok: false, reason: "not an rc:validate results file" };
  if (!head || results.commit !== head) return { ok: false, reason: `it is for commit ${String(results.commit || "unknown").slice(0, 8)}, not HEAD ${String(head || "unknown").slice(0, 8)}` };
  if (results.treeCleanAtStart !== true || results.treeCleanAtEnd !== true) return { ok: false, reason: "the working tree was not clean during that run" };
  if (!treeClean) return { ok: false, reason: "the working tree is not clean now" };
  if (results.platform !== platform) return { ok: false, reason: `it ran on ${results.platform}, not ${platform}` };
  const files = new Set();
  for (const name of Array.isArray(results.passed) ? results.passed : []) {
    const file = scriptFileOf(packageScripts?.[name]);
    if (file) files.add(file);
  }
  return { ok: true, commit: results.commit, files };
}

// Splits a tier's checks into the ones to run and the ones already passed.
function partitionChecks(checks, reusableFiles) {
  const run = [];
  const reused = [];
  for (const check of checks) {
    const [command, commandArgs] = check;
    const reusable = command === "node" && commandArgs.length === 1 && reusableFiles.has(commandArgs[0]);
    (reusable ? reused : run).push(check);
  }
  return { run, reused };
}

module.exports = { RC_RESULTS_SCHEMA, scriptFileOf, loadReusableRcResults, partitionChecks };
