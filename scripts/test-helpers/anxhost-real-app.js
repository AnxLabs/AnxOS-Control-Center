"use strict";

// Launches the REAL AnxHost CC Electron app for Build 216 UI checks, the same
// way scripts/anxhost-ui-baseline-capture.js does: isolated profile and config,
// --qa-mode, backed by the real Agent test fixture (service-managed-agent),
// and every window kept unfocused and off-screen so the owner's desktop is
// not interrupted. Production code is not changed; never touches the
// installed app or its data.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./isolated-qa-env");
const { startServiceManagedAgent } = require("./service-managed-agent-fixture");

const root = path.resolve(__dirname, "..", "..");
const OFFSCREEN = { x: -32000, y: -32000 };

// Runs in the Electron main process. The app's startup watchdog moves a window
// that is outside every display back on screen, so this QA app gets one
// virtual display at the off-screen position.
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

async function waitFor(page, predicate, arg, label, tries = 200) {
  for (let i = 0; i < tries; i += 1) {
    if (await page.evaluate(predicate, arg).catch(() => false)) return;
    await page.waitForTimeout(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

// Resizes the window so the CSS viewport is exactly width x height.
async function setViewport(app, page, width, height) {
  await evaluateMain(app, ({ BrowserWindow }, { width: w, height: h, offscreen }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    win.setMinimumSize(320, 240);
    win.setBounds({ x: offscreen.x, y: offscreen.y, width: w, height: h });
  }, { width, height, offscreen: OFFSCREEN });
  await page.waitForTimeout(300);
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  if (viewport.width !== width || viewport.height !== height) {
    await evaluateMain(app, ({ BrowserWindow }, { dw, dh }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      const bounds = win.getBounds();
      win.setBounds({ ...bounds, width: bounds.width + dw, height: bounds.height + dh });
    }, { dw: width - viewport.width, dh: height - viewport.height });
    await page.waitForTimeout(300);
  }
  return page.evaluate(() => `${window.innerWidth}x${window.innerHeight}`);
}

// Options: { prefix, stopAtGate } — stopAtGate leaves the local setup gate open.
async function launchRealApp({ prefix = "anx-216-a1-", stopAtGate = false } = {}) {
  const agent = await startServiceManagedAgent({ initial: "running" });
  const qa = createIsolatedQaEnv(`${prefix}config-`);
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "qa", nodes: [{ id: "qa", kind: "agent", name: "QA Computer", displayName: "QA Computer", baseUrl: agent.url, agentUrl: agent.url, enabled: true }] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { qa: { agentToken: agent.token } } });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}profile-`));
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];

  const launchedAt = Date.now();
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", root, "--qa-mode"], env });
  const rendererErrors = [];
  const timings = {};
  await evaluateMain(app, hideWindowsFromDesktop, OFFSCREEN);
  const page = await app.firstWindow();
  await evaluateMain(app, hideWindowsFromDesktop, OFFSCREEN);
  page.on("pageerror", (error) => rendererErrors.push(String(error.message).slice(0, 300)));
  await waitFor(page, () => typeof window.showPage === "function", null, "renderer");
  timings.rendererReadyMs = Date.now() - launchedAt;
  if (!stopAtGate) {
    await passLocalSetupGate(page);
    timings.sidebarInteractiveMs = Date.now() - launchedAt;
  }

  async function close() {
    await app.close().catch(() => {});
    await agent.stop().catch(() => {});
    qa.cleanup();
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  return { app, page, agent, rendererErrors, timings, close, setViewport: (w, h) => setViewport(app, page, w, h) };
}

async function passLocalSetupGate(page) {
  const useDevice = page.getByRole("button", { name: "Use this device" }).first();
  for (let i = 0; i < 40; i += 1) {
    if (await useDevice.isVisible().catch(() => false)) { await useDevice.click(); break; }
    if (await page.evaluate(() => (document.querySelector(".nav-menu")?.getBoundingClientRect().width || 0) > 0).catch(() => false)) break;
    await page.waitForTimeout(150);
  }
  await waitFor(page, () => (document.querySelector(".nav-menu")?.getBoundingClientRect().width || 0) > 0, null, "sidebar");
  // First launch opens the welcome dialog; close it as a user would.
  const skip = page.locator('[data-onboarding-action="skip"]').first();
  if (await skip.isVisible().catch(() => false)) await skip.click();
}

module.exports = { launchRealApp, passLocalSetupGate, waitFor, evaluateMain, OFFSCREEN, root };
