#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const htmlSource = fs.readFileSync(path.join(root, "index.html"), "utf8");
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
const ipcSource = fs.readFileSync(path.join(root, "src", "ipc", "dependenciesIpc.js"), "utf8");
const agentDependencySource = fs.readFileSync(path.join(root, "agent", "src", "services", "dependencyService.js"), "utf8");

[
  'data-dependency-action="check"',
  'data-dependency-action="install"',
  'data-dependency-action="update"',
  'data-dependency-action="repair"',
  'data-dependency-action="restart"',
  'data-dependency-action="verify"',
].forEach((needle) => assert(htmlSource.includes(needle), `Dependency panel must expose ${needle}.`));

assert(appSource.includes("dependencyActionLabels") && appSource.includes("Repair dependencies") && appSource.includes("Restart services and verify dependencies"), "Renderer must label graphical dependency actions.");
assert(appSource.includes('["install", "update", "repair"].includes(action)') && appSource.includes('["check", "retry", "verify", "restart"].includes(action)'), "Renderer must route graphical dependency actions through managed install/check flows.");
assert(appSource.includes("if (check?.ok === false && check.error)"), "Renderer must treat an ok:false dependency scan with missing dependencies as a valid result, not an IPC failure.");
assert(appSource.includes("check.error?.friendlyMessage || check.error?.message"), "Renderer must surface normalized dependency IPC failure messages.");
assert(appSource.includes("trusted dependency installer with in-app progress"), "Dependency confirmation must describe in-app managed installation.");
assert(ipcSource.includes("dependencies:install") && ipcSource.includes("dependencies:check") && ipcSource.includes("diagnostics.updateRuntimeState"), "Dependency IPC must keep managed install/check and diagnostics state.");
assert(agentDependencySource.includes("externalTerminal: false"), "Agent dependency jobs must not launch external terminals.");
assert(!/copy (?:and )?run|paste .* terminal|open (?:a )?(?:terminal|shell)/i.test(htmlSource), "Normal dependency UI must not instruct users to copy terminal commands.");

console.log("Dependency graphical action smoke checks passed.");
