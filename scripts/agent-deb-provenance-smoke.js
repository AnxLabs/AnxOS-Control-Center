#!/usr/bin/env node
// Phase 9: every Agent .deb records where its source came from.
//   V1 a Git checkout reports its HEAD and whether the packaged paths are
//      clean (untracked files count), matching git itself
//   V2 a real package build refuses dirty or unknown source unless
//      --allow-dirty; a declared export and a clean tree pass; --stage-only
//      (closure checks) never refuses
//   V3 ANXOS_SOURCE_COMMIT must be a full id and must agree with a checkout;
//      without a checkout it is recorded as an "exported" source
//   V4 the stamped agent-release.json carries sourceCommit/sourceTree, and the
//      Agent's release-identity reader returns them (malformed values dropped)
"use strict";

const assert = require("assert");
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const {
  PROVENANCE_PATHS,
  enforceSourceProvenance,
  resolveSourceProvenance,
  stageReleaseIdentity,
} = require("./build-agent-deb.js");
const { readAgentReleaseIdentity } = require("../agent/src/services/agentUpdateCheck.js");

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  assert.strictEqual(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function withConsoleWarn(fn) {
  const warnings = [];
  const original = console.warn;
  console.warn = (message) => warnings.push(String(message));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return warnings;
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-deb-provenance-"));
  try {
    // V1
    const head = git(["rev-parse", "HEAD"], rootDir).trim();
    const changed = git(["status", "--porcelain", "--untracked-files=all", "--", ...PROVENANCE_PATHS], rootDir).split(/\r?\n/).filter(Boolean).length;
    const here = resolveSourceProvenance({}, rootDir);
    assert.strictEqual(here.sourceCommit, head);
    assert.strictEqual(here.sourceTree, changed ? "dirty" : "clean");
    assert.strictEqual(here.changedPaths, changed);

    const repo = path.join(root, "repo");
    fs.mkdirSync(path.join(repo, "agent"), { recursive: true });
    git(["init", "-q"], repo);
    git(["-c", "user.email=smoke@anxos.invalid", "-c", "user.name=smoke", "commit", "-q", "--allow-empty", "-m", "base"], repo);
    fs.writeFileSync(path.join(repo, "agent", "a.js"), "1\n");
    fs.writeFileSync(path.join(repo, "notes.txt"), "outside the packaged paths\n");
    git(["add", "agent/a.js", "notes.txt"], repo);
    git(["-c", "user.email=smoke@anxos.invalid", "-c", "user.name=smoke", "commit", "-q", "-m", "add"], repo);
    const repoHead = git(["rev-parse", "HEAD"], repo).trim();
    assert.deepStrictEqual(resolveSourceProvenance({}, repo), { sourceCommit: repoHead, sourceTree: "clean", changedPaths: 0 });
    fs.writeFileSync(path.join(repo, "notes.txt"), "edited, but not packaged\n");
    assert.strictEqual(resolveSourceProvenance({}, repo).sourceTree, "clean", "changes outside the packaged paths do not make the package dirty");
    fs.writeFileSync(path.join(repo, "agent", "stray.js"), "untracked\n");
    assert.deepStrictEqual(resolveSourceProvenance({}, repo), { sourceCommit: repoHead, sourceTree: "dirty", changedPaths: 1 }, "an untracked file that would be packaged counts");
    console.log(`PASS V1 checkout provenance matches git (this repo: ${head.slice(0, 12)}, ${here.sourceTree})`);

    // V2
    const dirty = resolveSourceProvenance({}, repo);
    assert.throws(() => enforceSourceProvenance(dirty, {}), /Refusing to build a package from dirty source \(1 uncommitted change/);
    const warnings = withConsoleWarn(() => enforceSourceProvenance(dirty, { allowDirty: true }));
    assert.match(warnings.join("\n"), /records sourceTree "dirty"/);
    enforceSourceProvenance(dirty, { stageOnly: true });
    enforceSourceProvenance({ sourceCommit: repoHead, sourceTree: "clean" }, {});
    enforceSourceProvenance({ sourceCommit: repoHead, sourceTree: "exported" }, {});
    assert.throws(() => enforceSourceProvenance({ sourceCommit: null, sourceTree: "unknown" }, {}), /no Git checkout and no ANXOS_SOURCE_COMMIT/);
    console.log("PASS V2 real builds refuse dirty/unknown source unless --allow-dirty; stage-only never refuses");

    // V3
    assert.throws(() => resolveSourceProvenance({ ANXOS_SOURCE_COMMIT: "abc123" }, repo), /full 40-character/);
    assert.throws(() => resolveSourceProvenance({ ANXOS_SOURCE_COMMIT: "0".repeat(40) }, repo), /does not match this checkout's HEAD/);
    assert.strictEqual(resolveSourceProvenance({ ANXOS_SOURCE_COMMIT: repoHead.toUpperCase() }, repo).sourceTree, "dirty", "a matching declaration does not hide local changes");
    const exported = path.join(root, "exported");
    fs.mkdirSync(exported);
    assert.deepStrictEqual(resolveSourceProvenance({ ANXOS_SOURCE_COMMIT: repoHead }, exported), { sourceCommit: repoHead, sourceTree: "exported", changedPaths: null });
    assert.deepStrictEqual(resolveSourceProvenance({}, exported), { sourceCommit: null, sourceTree: "unknown", changedPaths: null });
    console.log("PASS V3 declared commits are validated and must agree with a checkout; an archive records \"exported\"");

    // V4
    const stage = path.join(root, "stage");
    const logs = [];
    const originalLog = console.log;
    console.log = (message) => logs.push(String(message));
    let identityPath;
    try {
      identityPath = stageReleaseIdentity(stage, { artifactVersion: "2.0-build999", tag: "v2.0-build999" }, { sourceCommit: repoHead, sourceTree: "clean" });
    } finally {
      console.log = originalLog;
    }
    const stamped = JSON.parse(fs.readFileSync(identityPath, "utf8"));
    assert.strictEqual(stamped.sourceCommit, repoHead);
    assert.strictEqual(stamped.sourceTree, "clean");
    const read = readAgentReleaseIdentity({ path: identityPath, searchPaths: [] });
    assert.strictEqual(read.sourceCommit, repoHead);
    assert.strictEqual(read.sourceTree, "clean");
    const malformedPath = path.join(root, "malformed.json");
    fs.writeFileSync(malformedPath, JSON.stringify({ artifactVersion: "2.0-build1", sourceCommit: "not-a-commit", sourceTree: "pristine" }));
    const malformed = readAgentReleaseIdentity({ path: malformedPath, searchPaths: [] });
    assert.strictEqual(malformed.sourceCommit, null);
    assert.strictEqual(malformed.sourceTree, null);
    const legacyPath = path.join(root, "legacy.json");
    fs.writeFileSync(legacyPath, JSON.stringify({ schemaVersion: 1, artifactVersion: "2.0-build209", releaseTag: "v2.0-build209" }));
    assert.strictEqual(readAgentReleaseIdentity({ path: legacyPath, searchPaths: [] }).sourceCommit, null, "packages from before Phase 9 still read");
    console.log("PASS V4 agent-release.json carries the source; the Agent reads it and drops malformed values");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("Agent deb provenance smoke: 4 checks passed.");
}

main();
