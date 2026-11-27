#!/usr/bin/env node
"use strict";

// Build 216-D: every AnxHost Setup screen fits Setup's fixed 820x520 window.
// RC1 Sandbox: on a fresh install, a long install path widened the Options
// screen past the window (Browse cut off) and the screen was taller than the
// window, so the Install button was partly below its edge.
//
// Run with node: starts Electron on this file, which renders the real
// windows/setup/src/ui.html (as ui.rs fills it, with a stub native bridge) in
// a hidden 820x520 window and drives each screen through its own functions.
// For each screen: nothing wider than the window, every button inside the
// window, and no scrolling needed.

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const LONG_PATH = "C:\\Users\\WDAGUtilityAccount\\AppData\\Local\\Programs\\AnxOS Control Center";

function page(mode) {
  // The brand images are not part of this check: a 1x1 SVG stands in.
  const pixel = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString("base64");
  const upgrade = mode === "anxos";
  const state = {
    kind: "install", build: 216, artifactVersion: "2.0-build216", hasEngine: true, appBytes: 1295 * 1048576,
    freeBytes: 77 * 1073741824, target: LONG_PATH,
    installed: upgrade ? { displayName: "AnxOS Control Center", build: null, location: LONG_PATH, allUsers: false } : null,
    helperState: upgrade ? "Running" : null, noHelper: false,
    dataFolder: "C:\\Users\\WDAGUtilityAccount\\AppData\\Roaming\\AnxHub",
    modeInfo: { mode: upgrade ? "anxos" : "fresh", from: null },
  };
  return fs.readFileSync(path.join(ROOT, "windows", "setup", "src", "ui.html"), "utf8")
    .replace("{{MARK}}", pixel).replace("{{WORD}}", pixel).replace("{{ICON}}", pixel)
    .replace("{{STATE}}", JSON.stringify(state).replace(/<\//g, "<\\/"))
    .replace("<head>", "<head><script>window.ipc = { postMessage() {} };</script>");
}

// Runs inside the page: returns one line per screen.
const CHECKS = String.raw`(async (mode) => {
  const W = innerWidth, H = innerHeight;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const check = (name) => {
    const s = document.querySelector(".screen.show");
    const m = s.querySelector(".main, .center") || s;
    const out = [];
    const sb = s.getBoundingClientRect();
    if (sb.right > W + 1) out.push("screen right " + Math.round(sb.right));
    for (const b of s.querySelectorAll("button")) {
      const r = b.getBoundingClientRect();
      if (r.width && (r.right > W + 1 || r.bottom > H + 1 || r.left < 0)) out.push("button '" + b.textContent.trim().slice(0, 24) + "' at " + Math.round(r.right) + "," + Math.round(r.bottom));
    }
    if (m.scrollHeight > m.clientHeight + 1) out.push("needs scrolling " + m.scrollHeight + ">" + m.clientHeight);
    return { name: mode + " " + name, problems: out };
  };
  const res = [check("welcome")];
  actions.options(); await wait(250); res.push(check("options"));
  if (mode === "fresh") {
    actions.allusers(document.querySelector("[data-cmd=allusers]")); await wait(150); res.push(check("options, everyone on"));
    actions.helper(); await wait(150); res.push(check("options, Helper off"));
    actions.helper(); await wait(100);
  }
  actions.back(); await wait(150);
  setup.closeApps({ processes: 3, helperState: "Running" }); await wait(250); res.push(check("close apps"));
  progress(); setStep("copy"); setup.copy({ fraction: 0.42, bytes: 540 * 1048576 });
  for (let i = 0; i < 30; i++) setup.log("engine: a long technical log line that fills the details panel " + i);
  actions.log(); await wait(250); res.push(check("progress with details"));
  setup.done({ helper: "1223", exitCode: 3, helperState: null }); await wait(250); res.push(check("done, Helper declined"));
  setup.failed({ reached: "copy", code: -1, what: null, nothingChanged: false }); await wait(250); res.push(check("failed"));
  return { viewport: [W, H], res };
})`;

async function electronMain() {
  const { app, BrowserWindow } = require("electron");
  app.disableHardwareAcceleration();
  // Each mode gets its own window: do not quit when one closes.
  app.on("window-all-closed", () => {});
  await app.whenReady();
  const results = [];
  let failed = 0;
  for (const mode of ["fresh", "anxos"]) {
    const win = new BrowserWindow({ show: false, useContentSize: true, width: 820, height: 520, webPreferences: { sandbox: true, contextIsolation: true } });
    // A failed sub-load can reject loadURL although the page itself loaded;
    // the readiness check below decides.
    let loadError = null;
    await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(page(mode)).toString("base64")}`).catch((error) => { loadError = error; });
    const ready = await win.webContents.executeJavaScript("typeof actions === 'object' && typeof setup === 'object' && !!document.querySelector('.screen.show')").catch(() => false);
    if (!ready) throw new Error(`Setup's page did not load (${loadError ? loadError.message : "no screen shown"})`);
    const out = await win.webContents.executeJavaScript(`${CHECKS}(${JSON.stringify(mode)})`);
    if (out.viewport[0] !== 820 || out.viewport[1] !== 520) {
      results.push(`FAIL ${mode}: page is ${out.viewport.join("x")}, not 820x520`);
      failed += 1;
    }
    for (const r of out.res) {
      if (r.problems.length) failed += 1;
      results.push(`${r.problems.length ? "FAIL" : "PASS"} ${r.name}${r.problems.length ? ": " + r.problems.join("; ") : ""}`);
    }
    win.destroy();
  }
  for (const line of results) console.log(line);
  console.log(failed ? `anxhost-setup-layout-ui-qa: ${failed} screen(s) do not fit` : `anxhost-setup-layout-ui-qa passed (${results.length} screens)`);
  app.exit(failed ? 1 : 0);
}

if (process.versions.electron) {
  electronMain().catch((error) => {
    console.error(error);
    require("electron").app.exit(1);
  });
} else {
  const { spawnSync } = require("child_process");
  const electron = require("electron");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const run = spawnSync(electron, [__filename], { stdio: "inherit", env });
  process.exit(run.status === null ? 1 : run.status);
}
