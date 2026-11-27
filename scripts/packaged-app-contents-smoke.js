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

    await check("P3 Agent extraResources folders the desktop needs are separately rooted in files", () => {
      const fileSets = pkg.build.files.filter((entry) => typeof entry === "object");
      const rootedFrom = new Set(fileSets.map((entry) => entry.from));
      const desktopNeeds = { "src/anxnet": "src/**/*", "src/services": "src/**/*", "src/shared": "src/**/*", agent: "agent/src/**/*" };
      for (const resource of pkg.build.extraResources) {
        const need = desktopNeeds[resource.from];
        if (!need) continue;
        assert(pkg.build.files.includes(need), `${need} is part of the app`);
        assert(rootedFrom.has(resource.from), `"${resource.from}" (copied to ${resource.to}) also needs a separately rooted files entry, or Linux packages lose it`);
      }
      const agentSet = fileSets.find((entry) => entry.from === "agent");
      assert(agentSet && agentSet.to === "agent" && agentSet.filter.includes("package.json") && agentSet.filter.includes("src/**/*"), "agent/package.json and agent/src are packed from their own root");
      const anxnetSet = fileSets.find((entry) => entry.from === "src/anxnet");
      assert(anxnetSet && anxnetSet.to === "src/anxnet" && anxnetSet.filter.includes("**/*.js"), "src/anxnet is packed from its own root");
      assert(pkg.build.extraResources.some((r) => r.from === "src/anxnet" && r.to === "local-agent-runtime/src/anxnet"), "the Agent keeps its own AnxNet copy");
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
