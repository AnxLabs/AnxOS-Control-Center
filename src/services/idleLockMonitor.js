"use strict";

// Build 216-E policy item 6 (docs/anxhost/SECURITY_REVIEW_216E.md): the
// idle-lock setting is enforced in the main process. Every 30 s the Local
// Owner session is checked against the system idle time and the last input to
// any app window; locking the operating system locks the app as well. A lock
// is announced to every window ("security:locked") so the renderer shows the
// lock screen at once instead of at its next status refresh.

const { app, BrowserWindow, powerMonitor } = require("electron");
const security = require("./securityService");

const CHECK_INTERVAL_MS = 30 * 1000;
let started = false;

function broadcastLocked(details = {}) {
  for (const window of BrowserWindow.getAllWindows()) {
    try {
      if (!window.isDestroyed()) window.webContents.send("security:locked", { reason: String(details.reason || "manual") });
    } catch {}
  }
}

function lockIfIdleLockEnabled(reason) {
  try {
    if (security.getIdleLockMs() > 0) security.lockLocalSession(reason);
  } catch {}
}

function startIdleLockMonitor() {
  if (started) return;
  started = true;
  security.onLocalSessionLocked(broadcastLocked);
  const { webContents } = require("electron");
  for (const contents of webContents.getAllWebContents()) {
    contents.on("input-event", () => security.noteUserActivity(Date.now()));
  }
  app.on("web-contents-created", (_event, contents) => {
    contents.on("input-event", () => security.noteUserActivity(Date.now()));
  });
  const timer = setInterval(() => {
    try {
      security.checkIdleLock({ systemIdleSeconds: powerMonitor.getSystemIdleTime() });
    } catch {}
  }, CHECK_INTERVAL_MS);
  timer.unref?.();
  powerMonitor.on("lock-screen", () => lockIfIdleLockEnabled("os-lock"));
  powerMonitor.on("suspend", () => lockIfIdleLockEnabled("suspend"));
}

module.exports = { startIdleLockMonitor };
