#!/usr/bin/env node
"use strict";

// Build 216-0 UI baseline capture (AnxHost CC rebirth).
//
// Launches the REAL Electron app with an isolated profile and config
// (--qa-mode, backed by the real Agent test fixture) and, for each window
// size, shows every data-page section, records what is actually shown and
// how long the switch took, and saves a screenshot.
//
// It is evidence capture, not a pass/fail gate: it fails only when the app
// cannot start. Run it again after each 216-A wave to compare with Build 215.
//
// The owner's desktop is not interrupted: in this disposable QA app only,
// BrowserWindow show/focus are patched so windows open unfocused, off-screen
// and out of the taskbar. Production code is not changed. Never touches the
// installed app or its data.
//
// Usage: node scripts/anxhost-ui-baseline-capture.js <outputDir> [--sizes=900x640,1280x800,1920x1080]

const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");

const root = path.resolve(__dirname, "..");
const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "anxhost-ui-baseline"));
const sizeArg = (process.argv.find((arg) => arg.startsWith("--sizes=")) || "--sizes=900x640,1280x800,1920x1080").slice(8);
const SIZES = sizeArg.split(",").map((value) => {
  const [width, height] = value.split("x").map(Number);
  return { width, height, label: `${width}x${height}` };
});
const OFFSCREEN = { x: -32000, y: -32000 };
const SETTLE_MS = 1500;

async function waitFor(page, predicate, arg, label, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (await page.evaluate(predicate, arg).catch(() => false)) return;
    await page.waitForTimeout(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Runs in the Electron main process: keep every window unfocused and off-screen.
// The app's startup watchdog treats a window outside every display as unusable
// and moves it back on screen, so this QA app is also given one virtual display
// at the off-screen position and told it is the primary display.
function hideWindowsFromDesktop({ BrowserWindow, screen }, offscreen) {
  if (!screen.__anxBaselinePatched) {
    screen.__anxBaselinePatched = true;
    const area = { x: offscreen.x, y: offscreen.y, width: 4000, height: 3000 };
    const virtual = { id: 9_999_999, label: "anx-baseline-virtual", bounds: area, workArea: area, workAreaSize: { width: area.width, height: area.height }, size: { width: area.width, height: area.height }, scaleFactor: 1, rotation: 0, internal: false, monochrome: false, accelerometerSupport: "unknown", touchSupport: "unknown", colorDepth: 24, colorSpace: "", depthPerComponent: 8, displayFrequency: 60, detected: true };
    screen.getAllDisplays = () => [virtual];
    screen.getPrimaryDisplay = () => virtual;
    screen.getDisplayMatching = () => virtual;
    screen.getDisplayNearestPoint = () => virtual;
  }
  const park = (win) => {
    if (!win || win.isDestroyed()) return;
    const { width, height } = win.getBounds();
    win.setSkipTaskbar(true);
    win.setBounds({ x: offscreen.x, y: offscreen.y, width, height });
  };
  const proto = BrowserWindow.prototype;
  if (!proto.__anxBaselinePatched) {
    proto.__anxBaselinePatched = true;
    proto.show = function show() { park(this); this.showInactive(); park(this); };
    proto.focus = function focus() {};
    proto.moveTop = function moveTop() {};
  }
  for (const win of BrowserWindow.getAllWindows()) park(win);
}

// The main process can still be initialising when Playwright attaches, so the
// first evaluate may hit a replaced context; retry briefly.
async function evaluateMain(app, fn, arg) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await app.evaluate(fn, arg); } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw lastError;
}

async function captureSize(size, sink) {
  const agent = await startServiceManagedAgent({ initial: "running" });
  const qa = createIsolatedQaEnv("anx-216-baseline-config-");
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "qa", nodes: [{ id: "qa", kind: "agent", name: "QA Computer", displayName: "QA Computer", baseUrl: agent.url, agentUrl: agent.url, enabled: true }] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { qa: { agentToken: agent.token } } });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-216-baseline-profile-"));
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];

  const launchedAt = Date.now();
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", root, "--qa-mode"], env });
  const result = { size: size.label, startup: {}, pages: [], rendererErrors: [] };
  try {
    await evaluateMain(app, hideWindowsFromDesktop, OFFSCREEN);
    const page = await app.firstWindow();
    await evaluateMain(app, hideWindowsFromDesktop, OFFSCREEN);
    page.on("pageerror", (error) => result.rendererErrors.push(String(error.message).slice(0, 300)));
    await waitFor(page, () => typeof window.showPage === "function", null, "renderer");
    result.startup.rendererReadyMs = Date.now() - launchedAt;
    const useDevice = page.getByRole("button", { name: "Use this device" }).first();
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    await waitFor(page, () => (document.querySelector(".nav-menu")?.getBoundingClientRect().width || 0) > 0, null, "sidebar");
    result.startup.sidebarInteractiveMs = Date.now() - launchedAt;
    await evaluateMain(app, ({ BrowserWindow }, { width, height, offscreen }) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
      win.setBounds({ x: offscreen.x, y: offscreen.y, width, height });
    }, { width: size.width, height: size.height, offscreen: OFFSCREEN });
    await page.waitForTimeout(500);
    // Window bounds and the CSS viewport can differ by the frame; correct once so
    // the captured viewport is exactly the requested size.
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    if (viewport.width !== size.width || viewport.height !== size.height) {
      await evaluateMain(app, ({ BrowserWindow }, { dw, dh }) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
        const b = win.getBounds();
        // The app's 900x640 minimum applies to window bounds, which here are
        // smaller than the viewport; lower it in this QA app only.
        win.setMinimumSize(320, 240);
        win.setBounds({ ...b, width: b.width + dw, height: b.height + dh });
      }, { dw: size.width - viewport.width, dh: size.height - viewport.height });
    }
    await page.waitForTimeout(SETTLE_MS);
    result.viewport = await page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`);

    const pageNames = await page.evaluate(() => [...document.querySelectorAll("section.page[data-page]")].map((el) => el.dataset.page));
    for (const name of pageNames) {
      const switchMs = await page.evaluate((target) => new Promise((resolve) => {
        const start = performance.now();
        window.showPage(target);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round((performance.now() - start) * 10) / 10)));
      }), name);
      await page.waitForTimeout(SETTLE_MS);
      const shown = await page.evaluate(() => ({
        active: document.querySelector("section.page.is-active")?.dataset.page || "",
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      }));
      const file = path.join(outDir, size.label, `${String(pageNames.indexOf(name) + 1).padStart(2, "0")}-${name}.png`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let captured = true;
      try { await page.screenshot({ path: file, timeout: 15000 }); } catch (error) { captured = false; result.rendererErrors.push(`screenshot ${name}: ${error.message}`); }
      result.pages.push({ requested: name, ...shown, redirected: shown.active !== name, switchMs, file: captured ? path.relative(outDir, file) : null });
    }
    result.windows = await evaluateMain(app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => ({ bounds: w.getBounds(), focused: w.isFocused(), visible: w.isVisible() })));
  } finally {
    await app.close().catch(() => {});
    await agent.stop().catch(() => {});
    qa.cleanup();
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  sink.push(result);
}

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const results = [];
  for (const size of SIZES) {
    console.log(`capturing ${size.label} ...`);
    await captureSize(size, results);
    const last = results[results.length - 1];
    console.log(`  ${last.pages.filter((p) => p.file).length}/${last.pages.length} screenshots, startup ${last.startup.sidebarInteractiveMs} ms`);
  }
  const summary = { capturedAt: new Date().toISOString(), commit: process.env.ANXHOST_BASELINE_COMMIT || "", sizes: SIZES.map((s) => s.label), results };
  fs.writeFileSync(path.join(outDir, "baseline-metrics.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`metrics: ${path.join(outDir, "baseline-metrics.json")}`);
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
