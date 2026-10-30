#!/usr/bin/env node
"use strict";

// Automation tools and screen readers read the AnxOS window through Windows UI
// Automation. Chromium only builds the accessibility tree after a client first
// asks, so the first query saw an empty window (9 elements, 0 buttons; 50 and
// 6 with the fix, measured against the QA lock screen). The desktop process
// must turn accessibility on once the app is ready; the --agent process has no
// window and must not.
// Run: node scripts/automation-accessibility-smoke.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const main = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
const readyAt = main.indexOf("app.whenReady().then(async () => {");
const agentReturnAt = main.indexOf("return;", main.indexOf("if (agentMode) {", readyAt));
const enableAt = main.indexOf("app.setAccessibilitySupportEnabled(true);");

assert(readyAt > -1, "main.js must initialize the desktop in app.whenReady()");
assert(enableAt > -1, "the desktop must enable Chromium accessibility support");
assert(enableAt > agentReturnAt && agentReturnAt > readyAt, "accessibility is enabled after app ready, on the desktop path only (after the --agent early return)");
assert.strictEqual(main.split("setAccessibilitySupportEnabled(").length - 1, 1, "accessibility support is set in exactly one place and never turned off");
assert(!/setContentProtection\(\s*true/.test(main), "the main window must stay capturable (no content protection)");

console.log("automation accessibility smoke passed (5 checks).");
