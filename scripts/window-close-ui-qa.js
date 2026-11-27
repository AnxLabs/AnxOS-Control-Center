#!/usr/bin/env node
"use strict";

// Build 216: closing the main window threw "closeAddStorageWindow is not
// defined" in its close handler (the function was removed with the separate
// Add Storage window). Real app, QA profile:
//   W1 closing the main window (as its title-bar Close does) raises no
//      uncaught exception in the main process
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launchRealApp, evaluateMain } = require("./test-helpers/anxhost-real-app");

(async () => {
  const run = await launchRealApp({ prefix: "anx-216-close-" });
  const results = [];
  try {
    // In QA mode closing the last window quits the app, so the main process
    // writes what happens to a file as it happens.
    const record = path.join(os.tmpdir(), `anx-216-close-${process.pid}.txt`);
    fs.rmSync(record, { force: true });
    const armed = await evaluateMain(run.app, ({ BrowserWindow }, file) => {
      const fsMain = process.mainModule.require("fs");
      process.on("uncaughtException", (error) => fsMain.appendFileSync(file, `uncaught: ${error && error.message}\n`));
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes("index.html"));
      if (!win) return false;
      win.once("closed", () => fsMain.appendFileSync(file, "closed\n"));
      setTimeout(() => win.close(), 50);
      return true;
    }, record);
    for (let i = 0; i < 50 && !(fs.existsSync(record) && fs.readFileSync(record, "utf8").includes("closed")); i++) await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 500));
    const lines = fs.existsSync(record) ? fs.readFileSync(record, "utf8").trim().split("\n") : [];
    fs.rmSync(record, { force: true });
    try {
      assert(armed, "no main window to close");
      const uncaught = lines.filter((l) => l.startsWith("uncaught"));
      assert.deepStrictEqual(uncaught, [], uncaught.join(" | "));
      assert(lines.includes("closed"), "the main window did not close");
      results.push("PASS W1 closing the main window raises no uncaught exception");
    } catch (error) {
      results.push(`FAIL W1 ${error.message}`);
    }
  } finally {
    await run.close();
  }
  for (const line of results) console.log(line);
  const failed = results.filter((line) => line.startsWith("FAIL")).length;
  console.log(failed ? `window-close-ui-qa: ${failed} check(s) failed` : `window-close-ui-qa passed (${results.length} check)`);
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
