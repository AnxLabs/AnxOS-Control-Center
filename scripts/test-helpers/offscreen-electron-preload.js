"use strict";

// Test-harness preload: keep Electron windows off the developer's desktop.
//
// Loaded with NODE_OPTIONS="--require <this file>" around a test run (for
// example `rc:validate` or `qa:feature`) so suites that launch the real app
// do not open or focus windows on the owner's screen. Tests are unchanged:
// windows are still created, shown and rendered, just off-screen, unfocused
// and out of the taskbar.
//
// - In plain Node processes (every non-Electron smoke) this file does nothing.
// - In the Electron main process it gives the app one virtual display at
//   x = y = -32000 and makes it the primary display. Without that, the app's
//   startup watchdog (main.js) treats an off-screen window as unusable and
//   moves it back on screen.
// - ANXHOST_OFFSCREEN_LOG=<file> appends one JSON line per shown window
//   (bounds, focused) as evidence.
//
// Never used by the shipped app; it only exists in test runs that opt in.

if (process.versions && process.versions.electron && process.type === "browser") {
  // eslint-disable-next-line global-require
  const { app, BrowserWindow, screen } = require("electron");
  const fs = require("fs");
  const OFF = { x: -32000, y: -32000, width: 4000, height: 3000 };
  const log = process.env.ANXHOST_OFFSCREEN_LOG || "";
  const record = (win, event) => {
    if (!log || !win || win.isDestroyed()) return;
    try { fs.appendFileSync(log, `${JSON.stringify({ pid: process.pid, event, bounds: win.getBounds(), focused: win.isFocused(), at: new Date().toISOString() })}\n`); } catch {}
  };
  if (log) { try { fs.appendFileSync(log, `${JSON.stringify({ pid: process.pid, event: "loaded", at: new Date().toISOString() })}\n`); } catch {} }
  const park = (win) => {
    if (!win || win.isDestroyed()) return;
    const { width, height } = win.getBounds();
    try { win.setSkipTaskbar(true); } catch {}
    win.setBounds({ x: OFF.x, y: OFF.y, width, height });
  };

  const proto = BrowserWindow.prototype;
  const originalShowInactive = proto.showInactive;
  proto.show = function show() { park(this); originalShowInactive.call(this); park(this); record(this, "show"); };
  proto.focus = function focus() {};
  proto.moveTop = function moveTop() {};

  // Registered before main.js runs, so it runs before the app creates windows.
  app.once("ready", () => {
    const virtual = { id: 9_999_999, label: "anx-offscreen-virtual", bounds: { ...OFF }, workArea: { ...OFF }, workAreaSize: { width: OFF.width, height: OFF.height }, size: { width: OFF.width, height: OFF.height }, scaleFactor: 1, rotation: 0, internal: false, monochrome: false, accelerometerSupport: "unknown", touchSupport: "unknown", colorDepth: 24, colorSpace: "", depthPerComponent: 8, displayFrequency: 60, detected: true };
    screen.getAllDisplays = () => [virtual];
    screen.getPrimaryDisplay = () => virtual;
    screen.getDisplayMatching = () => virtual;
    screen.getDisplayNearestPoint = () => virtual;
  });
  app.on("browser-window-created", (_event, win) => { park(win); });
} else if (!(process.versions && process.versions.electron)) {
  // Test-runner (plain Node) side. Playwright deletes NODE_OPTIONS before it
  // launches Electron, but it passes its own "-r <loader>" argument, so this
  // adds "-r <this file>" to _electron.launch() the same way.
  const Module = require("module");
  const self = __filename;
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) {
    const loaded = originalLoad.call(this, request, ...rest);
    if ((request === "playwright-core" || request === "playwright") && loaded && loaded._electron && !loaded._electron.__anxOffscreen) {
      const electronApi = loaded._electron;
      const launch = electronApi.launch.bind(electronApi);
      electronApi.launch = (options = {}) => launch({ ...options, args: ["-r", self, ...(options.args || [])] });
      electronApi.__anxOffscreen = true;
    }
    return loaded;
  };
}
