#!/usr/bin/env node
"use strict";

// Issue #54 (Linux desktop packages could not start: "Cannot find module
// '../anxnet/node'").
//   P1 verify-packaged-app finds a desktop require that the app.asar lacks,
//      and passes the same app once the file is there
//   P2 it fails when the bundled Agent's own copies are missing
//   P3 every folder the Agent copies with extraResources that the desktop
//      also needs has its own separately rooted "files" entry. On Linux,
//      electron-builder excludes each extraResources pattern from the app's
//      root file set; a separately rooted set is not affected.
//   P4 comments that mention require() are not taken as requires

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const asar = require(path.join(ROOT, "node_modules", "@electron", "asar"));
const { verifyResources } = require("./verify-packaged-app");
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));

const results = [];
async function check(label, fn) {
  try {
    await fn();
    results.push(`PASS ${label}`);
  } catch (error) {
    results.push(`FAIL ${label}\n  ${error.stack || error}`);
  }
}

function write(base, rel, text) {
  const file = path.join(base, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

async function makeResources(dir, { withAnxNet, withAgentCopies }) {
  const app = path.join(dir, "app");
  write(app, "main.js", 'require("./src/services/anxnetService");\n');
  write(app, "src/services/anxnetService.js", '// require("./not/a/real/file") in a comment\nconst { AnxNetNode } = require("../anxnet/node");\nrequire("../shared/util");\n');
  write(app, "src/shared/util.js", "module.exports = {};\n");
  for (let i = 0; i < 60; i++) write(app, `src/shared/m${i}.js`, "module.exports = {};\n");
  if (withAnxNet) write(app, "src/anxnet/node.js", "module.exports = {};\n");
  const resources = path.join(dir, "resources");
  fs.mkdirSync(resources, { recursive: true });
  await asar.createPackage(app, path.join(resources, "app.asar"));
  if (withAgentCopies) {
    write(resources, "local-agent-runtime/src/anxnet/node.js", "module.exports = {};\n");
    write(resources, "local-agent-runtime/agent/src/server.js", "module.exports = {};\n");
  }
  return resources;
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "packaged-app-contents-"));
  try {
    await check("P1 a missing desktop module is found; the complete app passes", async () => {
      const broken = verifyResources(await makeResources(path.join(temp, "broken"), { withAnxNet: false, withAgentCopies: true }));
      assert.deepStrictEqual(broken.missing.map((m) => `${m.from} -> ${m.require}`), ["/src/services/anxnetService.js -> ../anxnet/node"]);
      const fixed = verifyResources(await makeResources(path.join(temp, "fixed"), { withAnxNet: true, withAgentCopies: true }));
      assert.deepStrictEqual(fixed.missing, []);
      assert(fixed.checked > 50, "the desktop modules were read");
    });

    await check("P2 the bundled Agent's own copies are required", async () => {
      const result = verifyResources(await makeResources(path.join(temp, "no-agent"), { withAnxNet: true, withAgentCopies: false }));
      assert(Object.values(result.agentCopies).every((present) => !present), JSON.stringify(result.agentCopies));
    });

    await check("P3 on Linux, every desktop module survives electron-builder's extraResources exclusions", () => {
      // Emulates app-builder-lib 26 on Linux (platformPackager + fileMatcher +
      // util/filter): each extraResources pattern, joined to its "from" with
      // posix paths, becomes an exclusion that is tested against every app
      // file set's own relative paths. (On Windows the join uses backslashes
      // and never matches, which is why only Linux packages broke.)
      const { Minimatch } = require(path.join(ROOT, "node_modules", "minimatch"));
      const mm = (pattern) => new Minimatch(pattern, { dot: true });
      const excludes = [];
      for (const resource of pkg.build.extraResources) {
        const from = resource.from.replace(/\\/g, "/");
        if (!resource.filter || !resource.filter.length) { excludes.push(mm(from)); continue; }
        for (const pattern of resource.filter) {
          const joined = path.posix.join(from, pattern);
          excludes.push(mm(joined));
          if (!joined.includes(".") && !/[*?[{]/.test(joined)) excludes.push(mm(`${joined}/**/*`));
        }
      }
      const excluded = (relative) => excludes.some((pattern) => pattern.match(relative));
      const matchAll = (relative, patterns) => {
        let match = false;
        for (const pattern of patterns) {
          const p = mm(pattern);
          if (match !== p.negate) continue;
          match = p.match(relative);
        }
        return match;
      };
      const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
      const packed = new Set();
      const rootPatterns = pkg.build.files.filter((entry) => typeof entry === "string");
      const needed = ["src/anxnet", "src/services", "src/shared", "agent/src"].flatMap(walk).filter((f) => f.endsWith(".js")).concat("agent/package.json");
      for (const file of needed) if (matchAll(file, rootPatterns) && !excluded(file)) packed.add(file);
      for (const set of pkg.build.files.filter((entry) => typeof entry === "object")) {
        for (const file of needed.filter((f) => f.startsWith(`${set.from}/`))) {
          const relative = file.slice(set.from.length + 1);
          if (matchAll(relative, set.filter || ["**/*"]) && !excluded(relative)) packed.add(`${set.to}/${relative}`);
        }
      }
      const lost = needed.filter((file) => !packed.has(file));
      assert.deepStrictEqual(lost.slice(0, 12), [], `${lost.length} desktop file(s) would be missing from the Linux app.asar`);
      assert(pkg.build.extraResources.some((r) => r.from === "src/anxnet" && r.to === "local-agent-runtime/src/anxnet"), "the Agent keeps its own AnxNet copy");
      assert(pkg.build.extraResources.some((r) => r.from === "agent" && r.to === "local-agent-runtime/agent"), "the Agent keeps its own copy of agent/src");
    });

    await check("P4 comments are not requires", async () => {
      const result = verifyResources(path.join(temp, "fixed", "resources"));
      assert(!result.missing.some((m) => m.require.includes("not/a/real")));
    });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  for (const line of results) console.log(line);
  const failed = results.filter((line) => line.startsWith("FAIL")).length;
  if (failed) {
    console.log(`packaged-app-contents-smoke: ${failed} of ${results.length} checks failed`);
    process.exit(1);
  }
  console.log(`packaged-app-contents-smoke passed (${results.length} checks)`);
})();
