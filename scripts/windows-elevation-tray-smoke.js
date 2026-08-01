#!/usr/bin/env node
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");

assert.strictEqual(
  packageJson.build?.win?.requestedExecutionLevel,
  "requireAdministrator",
  "Windows builds must request administrator elevation at launch.",
);
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
