#!/usr/bin/env node
"use strict";

// Issue #54: the Linux desktop packages could not start ("Cannot find module
// '../anxnet/node'"). electron-builder turns each extraResources pattern into
// an exclusion for the app's own files, and on Linux those exclusions match:
// the Agent's extraResources copies of src/anxnet and agent/src removed them
// from the desktop app.asar (on Windows the exclusions are built with
// backslashes and never match, so Windows was unaffected).
//
// This check opens finished packages and proves what they contain:
//   - every relative require() in the desktop's own code (main.js, preload.js,
//     src/**, agent/src/**) resolves to a file in app.asar or app.asar.unpacked
//   - the bundled Agent still has its own copies (local-agent-runtime)
//
// Usage: node scripts/verify-packaged-app.js <package-or-folder>...
//   .deb       extracted with dpkg-deb (Linux)
//   .AppImage  extracted with --appimage-extract (Linux, x64)
//   folder     a resources folder, or an unpacked app folder containing one

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const REQUIRE_PATTERN = /require\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g;
const AGENT_COPIES = ["local-agent-runtime/src/anxnet/node.js", "local-agent-runtime/agent/src/server.js"];

function asarApi() {
  return require(path.join(ROOT, "node_modules", "@electron", "asar"));
}

function findResources(dir) {
  const queue = [dir];
  while (queue.length) {
    const current = queue.shift();
    if (fs.existsSync(path.join(current, "app.asar"))) return current;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name !== "node_modules" && !entry.name.endsWith(".asar.unpacked")) queue.push(path.join(current, entry.name));
    }
  }
  return null;
}

/** Checks one resources folder. Returns { files, checked, missing[], agentCopies{} }. */
function verifyResources(resources) {
  const asar = asarApi();
  const archive = path.join(resources, "app.asar");
  const entries = asar.listPackage(archive).map((entry) => entry.split(path.sep).join("/"));
  const present = new Set(entries);
  const unpacked = path.join(resources, "app.asar.unpacked");
  const exists = (posixPath) => present.has(posixPath) || fs.existsSync(path.join(unpacked, ...posixPath.split("/").filter(Boolean)));
  const sources = entries.filter((entry) => /\.js$/.test(entry) && !entry.includes("/node_modules/") && (/^\/(main|preload)\.js$/.test(entry) || entry.startsWith("/src/") || entry.startsWith("/agent/src/")));
  const missing = [];
  for (const source of sources) {
    let text;
    try {
      text = asar.extractFile(archive, source.slice(1).split("/").join(path.sep)).toString("utf8");
    } catch {
      continue; // an unpacked file; its imports are checked through its packed copy
    }
    // Comments describe requires without making them (block comments and
    // whole-line // comments; a trailing // could be part of a URL string).
    const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const match of code.matchAll(REQUIRE_PATTERN)) {
      const target = path.posix.join(path.posix.dirname(source), match[1]);
      const candidates = [target, `${target}.js`, `${target}.json`, `${target}.node`, `${target}/index.js`];
      if (!candidates.some(exists)) missing.push({ from: source, require: match[1] });
    }
  }
  const agentCopies = Object.fromEntries(AGENT_COPIES.map((rel) => [rel, fs.existsSync(path.join(resources, ...rel.split("/")))]));
  return { files: entries.length, checked: sources.length, missing, agentCopies };
}

function extract(packagePath, work) {
  if (/\.deb$/i.test(packagePath)) {
    const run = spawnSync("dpkg-deb", ["-x", packagePath, work], { encoding: "utf8" });
    if (run.status !== 0) throw new Error(`dpkg-deb could not extract ${path.basename(packagePath)}: ${run.stderr || run.error}`);
    return work;
  }
  if (/\.AppImage$/i.test(packagePath)) {
    const copy = path.join(work, "app.AppImage");
    fs.copyFileSync(packagePath, copy);
    fs.chmodSync(copy, 0o755);
    const run = spawnSync(copy, ["--appimage-extract"], { cwd: work, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (run.status !== 0) throw new Error(`${path.basename(packagePath)} --appimage-extract failed: ${run.stderr || run.error}`);
    return path.join(work, "squashfs-root");
  }
  throw new Error(`Not a .deb, .AppImage or folder: ${packagePath}`);
}

/** Verifies a package or folder; returns a report line list and an ok flag. */
function verifyTarget(target) {
  const work = fs.statSync(target).isDirectory() ? null : fs.mkdtempSync(path.join(os.tmpdir(), "verify-packaged-app-"));
  try {
    const root = work ? extract(target, work) : target;
    const resources = findResources(root);
    if (!resources) return { ok: false, lines: [`FAIL ${path.basename(target)}: no app.asar found`] };
    const result = verifyResources(resources);
    const lines = [];
    const agentOk = Object.values(result.agentCopies).every(Boolean);
    const ok = result.missing.length === 0 && agentOk && result.checked > 50;
    lines.push(`${ok ? "PASS" : "FAIL"} ${path.basename(target)}: ${result.checked} desktop modules checked in ${result.files} app.asar entries; ${result.missing.length} unresolved require(s); Agent copies ${agentOk ? "present" : "MISSING"}`);
    for (const m of result.missing.slice(0, 40)) lines.push(`  missing: ${m.from} requires ${m.require}`);
    for (const [rel, present] of Object.entries(result.agentCopies)) if (!present) lines.push(`  missing Agent copy: ${rel}`);
    if (result.checked <= 50) lines.push(`  only ${result.checked} desktop modules found: not a complete app.asar`);
    return { ok, lines };
  } finally {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  }
}

module.exports = { verifyResources, verifyTarget, findResources };

if (require.main === module) {
  const targets = process.argv.slice(2);
  if (!targets.length) {
    console.error("usage: node scripts/verify-packaged-app.js <package-or-folder>...");
    process.exit(2);
  }
  let failed = 0;
  for (const target of targets) {
    try {
      const { ok, lines } = verifyTarget(path.resolve(target));
      for (const line of lines) console.log(line);
      if (!ok) failed += 1;
    } catch (error) {
      console.log(`FAIL ${path.basename(target)}: ${error.message}`);
      failed += 1;
    }
  }
  process.exit(failed ? 1 : 0);
}
