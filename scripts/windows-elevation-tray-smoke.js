#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const agentServerSource = fs.readFileSync(path.join(root, "agent", "src", "server.js"), "utf8");
const agentTaskSource = fs.readFileSync(path.join(root, "agent", "src", "services", "windowsAgentTaskService.js"), "utf8");
const installerSource = fs.readFileSync(path.join(root, "windows", "install-agent-task.ps1"), "utf8");

assert.strictEqual(
  packageJson.build?.win?.requestedExecutionLevel,
  "asInvoker",
  "The visible Windows application must run at standard-user privilege.",
);
assert(!mainSource.includes('Start-Process -FilePath') && !mainSource.includes('-Verb RunAs'), "Normal desktop startup must not self-elevate.");
assert(mainSource.includes('process.argv.includes("--agent")'), "The elevated Agent must retain a distinct headless entry point.");
assert(mainSource.includes("if (agentMode)") && mainSource.includes("require(agentControl._test.getAgentScript())"), "Agent mode must bootstrap headlessly before desktop initialization.");
assert(mainSource.includes("agentMode || app.requestSingleInstanceLock()"), "Elevated Agent and standard UI must use independent instance lifecycles.");
assert(agentServerSource.includes('pathname === "/api/v1/system/agent-task"') && agentServerSource.includes('return "agent:manage"'), "Privileged task repair must use an authenticated allowlisted Agent route.");
assert(agentTaskSource.includes("buildWindowsAgentTaskDefinition") && !agentTaskSource.includes("exec(") && agentTaskSource.includes("execFile("), "The Agent must use the canonical task definition and shell-safe execution.");
assert(installerSource.includes("-LogonType Interactive") && installerSource.includes("-RunLevel Highest") && installerSource.includes('Argument "--agent"'), "Installer migration must preserve the proven elevated Agent definition.");
assert.strictEqual(packageJson.build?.nsis?.include, "windows/installer.nsh", "Signed installers must run the Agent task migration hook.");
assert(
  mainSource.includes("new Tray(APP_ICON_PATH)") &&
    mainSource.includes("window-hidden-to-tray") &&
    mainSource.includes('label: "Quit"'),
  "The desktop must provide a notification-tray lifecycle with an explicit Quit action.",
);
assert(
  mainSource.includes("if (!qaMode && !appShuttingDown)") &&
    mainSource.includes("event.preventDefault()") &&
    mainSource.includes("window.hide()"),
  "Closing the normal main window must hide it without bypassing explicit shutdown.",
);
assert(
  mainSource.includes("if (qaMode && process.platform !== \"darwin\")"),
  "QA mode must retain deterministic close-and-quit behavior.",
);

console.log("Windows elevation and tray smoke checks passed.");
