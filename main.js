const { app, BrowserWindow, Menu, Tray, ipcMain, screen, dialog } = require("electron");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { registerAccountAuthIpc } = require("./src/ipc/accountAuthIpc");
const { registerActionIpc } = require("./src/ipc/actionIpc");
const { registerAmpIpc } = require("./src/ipc/ampIpc");
const { registerBackupsIpc } = require("./src/ipc/backupsIpc");
const { registerDockerIpc } = require("./src/ipc/dockerIpc");
const { disposeFilesIpc, registerFilesIpc } = require("./src/ipc/filesIpc");
const { instrumentIpcHandlers } = require("./src/ipc/ipcHandlerInstrumentation");
const { registerInstancesIpc } = require("./src/ipc/instancesIpc");
const { registerMarketplaceIpc } = require("./src/ipc/marketplaceIpc");
const { registerMaintenanceIpc } = require("./src/ipc/maintenanceIpc");
const { registerNetworkInventoryIpc } = require("./src/ipc/networkInventoryIpc");
const { registerWebhookAlertsIpc } = require("./src/ipc/webhookAlertsIpc");
const { registerInfrastructureInventoryIpc } = require("./src/ipc/infrastructureInventoryIpc");
const { registerNetworkIpc } = require("./src/ipc/networkIpc");
const { registerNodesIpc } = require("./src/ipc/nodesIpc");
const { registerComputersIpc } = require("./src/ipc/computersIpc");
const { registerNotificationsIpc } = require("./src/ipc/notificationsIpc");
const { registerOwnerWorkspaceIpc } = require("./src/ipc/ownerWorkspaceIpc");
const { registerPlayitIpc } = require("./src/ipc/playitIpc");
const { registerPublicAccessIpc } = require("./src/ipc/publicAccessIpc");
const { registerAnxNetIpc } = require("./src/ipc/anxnetIpc");
// Visible product name (216-B1); internal identifiers stay AnxOS (FROZEN_IDENTIFIERS.md).
const PRODUCT_NAME = require("./src/shared/productBrand").productName;
const anxnetService = require("./src/services/anxnetService");
const { registerMobileGatewayIpc } = require("./src/ipc/mobileGatewayIpc");
const mobileGatewayService = require("./src/services/mobileGatewayService");
const { registerSecurityIpc } = require("./src/ipc/securityIpc");
const { startIdleLockMonitor } = require("./src/services/idleLockMonitor");
const { registerSettingsIpc } = require("./src/ipc/settingsIpc");
const { registerAiOperationsIpc } = require("./src/ipc/aiOperationsIpc");
const { disposeSshIpc, registerSshIpc } = require("./src/ipc/sshIpc");
const { registerSystemIpc } = require("./src/ipc/systemIpc");
const { registerTelemetryIpc } = require("./src/ipc/telemetryIpc");
const { registerWorkloadIpc } = require("./src/ipc/workloadIpc");
const { registerDeveloperUpdatesIpc, registerUpdatesIpc } = require("./src/ipc/updatesIpc");
const { logStartupStatus: logCurseForgeStartupStatus } = require("./src/services/providers/curseforgeProvider");
const { UpdateManager } = require("./src/services/updateManager");
const updateHandoff = require("./src/services/updateHandoffService");
const { configureElectronPaths } = require("./src/services/electronPaths");
const { createAlertStateCollector } = require("./src/services/alertStateCollector");
const { DeveloperGitUpdater } = require("./src/services/developerGitUpdater");
const { openExternalUrl } = require("./src/services/externalUrlService");
const { applyWindowNavigationGuard } = require("./src/services/windowNavigationGuard");
const { getReleaseInfo } = require("./src/shared/releaseConfig");
const packageJson = require("./package.json");
const qaMode = process.argv.includes("--qa-mode") || process.env.ANXOS_QA_MODE === "1";
const agentMode = process.argv.includes("--agent");
if (agentMode) {
  app.setPath("sessionData", path.join(app.getPath("userData"), "AgentRuntimeSession"));
}
if (qaMode) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu");
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-gpu-rasterization");
  app.commandLine.appendSwitch("disable-features", "VizDisplayCompositor");
  app.commandLine.appendSwitch("in-process-gpu");
}

const APP_ICON_PATH = process.platform === "win32"
  ? path.join(__dirname, "assets", "icon.ico")
  : path.join(__dirname, "assets", "icons", "png", "512x512.png");
const WINDOW_MAXIMIZED_CHANGED_CHANNEL = "window:maximized-changed";
const DEFAULT_WINDOW_BOUNDS = {
  width: 1180,
  height: 820,
};
const MAIN_WINDOW_SHOW_FALLBACK_MS = 4000;
const MAIN_WINDOW_WATCHDOG_FIRST_MS = 2500;
const MAIN_WINDOW_WATCHDOG_RESET_MS = 7000;
const MAIN_WINDOW_WATCHDOG_RECREATE_MS = 11000;
const STARTUP_ATTEMPT_STALE_MS = 2 * 60 * 1000;
const updateManager = new UpdateManager();
const developerGitUpdater = new DeveloperGitUpdater({ app, appRoot: __dirname });
let mainWindow = null;
let tray = null;
let appShuttingDown = false;
let appShutdownComplete = false;
let activeStartupAttemptId = null;
let mainWindowWatchdogTimers = [];
const gotSingleInstanceLock = agentMode || app.requestSingleInstanceLock();

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
if (qaMode) {
  app.on("child-process-gone", (_, details = {}) => {
    console.error("[Desktop] QA child process exited.", {
      type: details.type || null,
      reason: details.reason || null,
      exitCode: details.exitCode ?? null,
      serviceName: details.serviceName || null,
      name: details.name || null,
    });
  });
}

configureElectronPaths(app, qaMode ? {
  appDataPath: app.getPath("userData"),
  localAppDataPath: app.getPath("userData"),
  tempPath: path.join(app.getPath("userData"), "tmp"),
} : {});
// 217-E: move aside temp files left by a save that was cut off (only this
// installation's desktop, holding the single-instance lock, does this).
let orphanTempRecovery = null;
if (gotSingleInstanceLock && !agentMode) {
  try {
    orphanTempRecovery = require("./src/shared/orphanTempRecovery").recoverOrphanTempFiles(require("./src/services/secureSessionStore").getDefaultConfigDirectory());
  } catch (error) {
    orphanTempRecovery = { error: error?.code || error?.message || "ORPHAN_TEMP_RECOVERY_FAILED" };
  }
}
const diagnostics = require("./src/services/diagnosticsService");
if (orphanTempRecovery && (orphanTempRecovery.quarantined?.length || orphanTempRecovery.failed || orphanTempRecovery.error)) {
  diagnostics.log(orphanTempRecovery.orphanedStore?.length || orphanTempRecovery.error ? "warn" : "info", "storage", "orphan-temp-files", "Moved aside temp files left by an interrupted save.", orphanTempRecovery, { file: "desktop" });
}
const { registerDiagnosticsIpc } = require("./src/ipc/diagnosticsIpc");
const { registerAgentControlIpc } = require("./src/ipc/agentControlIpc");
const { registerAlertsIpc } = require("./src/ipc/alertsIpc");
const { registerDependenciesIpc } = require("./src/ipc/dependenciesIpc");
const localInstanceService = require("./src/services/localInstanceService");
// V2-D install transactions: marketplace install jobs ride the shared V2-A job
// store owned by the local instance service; warm the marketplace wrappers up
// through the same configure-and-reconcile hook the instance jobs use.
const { setMarketplaceJobsWarmup } = require("./src/services/marketplaceInstallJobService");
setMarketplaceJobsWarmup(() => localInstanceService.recoverInstanceJobs());
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  originalConsoleError(...args);
  diagnostics.log("error", "desktop", "console-error", args.map((value) => value?.message || String(value)).join(" "), { arguments: args }, { file: "desktop" });
};

// SMOOTH-3011 / SMOOTH-3010: the IPC instrumentation wrapper (shutdown guard,
// start/completed timing records, opt-in payload-byte metrics, and the
// `instances:list` → alert-scheduler snapshot share) now lives in
// src/ipc/ipcHandlerInstrumentation.js. It is invoked below, before the first
// handler is registered, so every channel registered from that point on is wrapped.

function getGitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: __dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function readBuildMetadata() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "release-build.json"), "utf8"));
  } catch {
    return {};
  }
}

function getRuntimeInfo() {
  const trustedDevelopmentMode = process.env.ANXOS_TRUSTED_DEVELOPMENT_MODE === "1" && app.isPackaged === false;
  const release = getReleaseInfo();
  const buildMetadata = readBuildMetadata();
  return {
    name: PRODUCT_NAME,
    version: release.versionLabel,
    releaseVersion: release.version,
    build: release.buildLabel,
    buildNumber: release.build,
    channel: release.channel,
    releaseLabel: release.compactLabel,
    releaseTag: release.tag,
    packageVersion: packageJson.version,
    appVersion: release.compactLabel,
    gitCommit: buildMetadata.gitCommit || process.env.ANXOS_BUILD_COMMIT || getGitCommit(),
    buildDate: buildMetadata.buildDate || process.env.ANXOS_BUILD_DATE || null,
    websiteUrl: release.websiteUrl,
    releaseRepository: release.releaseRepository,
    releaseRepositoryUrl: release.releaseRepositoryUrl,
    releaseUrl: release.releaseUrl,
    updateSource: release.updateSource,
    supportedOperatingSystems: release.supportedOperatingSystems,
    minimumArchitecture: release.minimumArchitecture,
    electron: process.versions.electron || null,
    node: process.versions.node || null,
    chromium: process.versions.chrome || null,
    isPackaged: app.isPackaged === true,
    trustedDevelopmentMode,
    developmentMode: trustedDevelopmentMode,
  };
}

function getWindowStatePath() {
  return path.join(app.getPath("userData"), "config", "window-state.json");
}

function getStartupRecoveryPath() {
  return path.join(app.getPath("userData"), "config", "window-startup-recovery.json");
}

function readStartupRecoveryState() {
  try {
    return JSON.parse(fs.readFileSync(getStartupRecoveryPath(), "utf8"));
  } catch {
    return { attempts: [] };
  }
}

function writeStartupRecoveryState(state = {}) {
  try {
    fs.mkdirSync(path.dirname(getStartupRecoveryPath()), { recursive: true });
    fs.writeFileSync(getStartupRecoveryPath(), JSON.stringify({
      ...state,
      attempts: Array.isArray(state.attempts) ? state.attempts.slice(-5) : [],
    }, null, 2));
  } catch (error) {
    logWindowLifecycle("startup-recovery-write-failed", "Could not persist startup recovery state.", { message: error.message }, "warn");
  }
}

function startWindowStartupAttempt(reason = "startup") {
  const now = new Date();
  const state = readStartupRecoveryState();
  const attempts = Array.isArray(state.attempts) ? state.attempts : [];
  const recentUnshown = attempts.filter((attempt) => {
    const startedAt = Date.parse(attempt.startedAt || "");
    return Number.isFinite(startedAt)
      && now.getTime() - startedAt <= STARTUP_ATTEMPT_STALE_MS
      && attempt.visibleAt == null
      && attempt.completedAt == null;
  });
  const id = `${now.getTime()}-${process.pid}`;
  activeStartupAttemptId = id;
  const safeMode = recentUnshown.length >= 1;
  const next = {
    ...state,
    safeModeLastReason: safeMode ? "previous launch did not record a visible main window" : state.safeModeLastReason || null,
    attempts: [
      ...attempts.filter((attempt) => {
        const startedAt = Date.parse(attempt.startedAt || "");
        return Number.isFinite(startedAt) && now.getTime() - startedAt <= STARTUP_ATTEMPT_STALE_MS;
      }),
      { id, pid: process.pid, reason, startedAt: now.toISOString(), visibleAt: null, completedAt: null },
    ],
  };
  writeStartupRecoveryState(next);
  if (safeMode) {
    logWindowLifecycle("startup-safe-mode", "Previous launch did not record a visible window; ignoring saved window state.", {
      attemptCount: recentUnshown.length,
      reason,
    }, "warn");
  }
  return { id, safeMode };
}

function completeWindowStartupAttempt(status, context = {}) {
  if (!activeStartupAttemptId) return;
  const now = new Date().toISOString();
  const state = readStartupRecoveryState();
  const attempts = Array.isArray(state.attempts) ? state.attempts : [];
  writeStartupRecoveryState({
    ...state,
    attempts: attempts.map((attempt) => attempt.id === activeStartupAttemptId
      ? {
          ...attempt,
          visibleAt: status === "visible" ? attempt.visibleAt || now : attempt.visibleAt || null,
          completedAt: status === "closed" || status === "failed" ? now : attempt.completedAt || null,
          status,
          context,
        }
      : attempt),
  });
}

function readWindowState() {
  try {
    const state = JSON.parse(fs.readFileSync(getWindowStatePath(), "utf8"));
    const width = Number.parseInt(state.width, 10);
    const height = Number.parseInt(state.height, 10);
    const x = Number.parseInt(state.x, 10);
    const y = Number.parseInt(state.y, 10);

    return {
      width: Number.isFinite(width) ? Math.max(width, 900) : DEFAULT_WINDOW_BOUNDS.width,
      height: Number.isFinite(height) ? Math.max(height, 640) : DEFAULT_WINDOW_BOUNDS.height,
      x: Number.isFinite(x) ? x : undefined,
      y: Number.isFinite(y) ? y : undefined,
      maximized: state.maximized === true,
    };
  } catch {
    return {
      ...DEFAULT_WINDOW_BOUNDS,
      maximized: false,
    };
  }
}

function logWindowLifecycle(operation, message, context = {}, severity = "info") {
  diagnostics.log(severity, "desktop-window", operation, message, context, { file: "desktop" });
}

logWindowLifecycle(
  "single-instance-lock",
  gotSingleInstanceLock
    ? "Single-instance lock acquired."
    : "Single-instance lock unavailable; duplicate process will exit.",
  { gotSingleInstanceLock },
  gotSingleInstanceLock ? "info" : "warn",
);

function getDefaultWindowBounds() {
  const workArea = screen.getPrimaryDisplay().workArea;
  const width = Math.min(DEFAULT_WINDOW_BOUNDS.width, Math.max(900, workArea.width));
  const height = Math.min(DEFAULT_WINDOW_BOUNDS.height, Math.max(640, workArea.height));
  return {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
  };
}

function getBoundsIntersectionArea(a = {}, b = {}) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function normalizeWindowStateForDisplays(state = {}) {
  const displays = screen.getAllDisplays();
  const fallback = getDefaultWindowBounds();
  const width = Number.isFinite(state.width) ? Math.max(900, Math.min(state.width, Math.max(...displays.map((display) => display.workArea.width), fallback.width))) : fallback.width;
  const height = Number.isFinite(state.height) ? Math.max(640, Math.min(state.height, Math.max(...displays.map((display) => display.workArea.height), fallback.height))) : fallback.height;
  const hasPosition = Number.isFinite(state.x) && Number.isFinite(state.y);
  const candidate = {
    width,
    height,
    x: hasPosition ? state.x : fallback.x,
    y: hasPosition ? state.y : fallback.y,
  };
  const visible = displays.some((display) => getBoundsIntersectionArea(candidate, display.workArea) >= Math.min(20000, candidate.width * candidate.height * 0.2));
  if (!visible || state.minimized === true || state.hidden === true || state.visible === false) {
    logWindowLifecycle("bounds-reset", "Saved window bounds were invalid or invisible; reset to centered default bounds.", {
      saved: state,
      fallback,
      displayCount: displays.length,
    }, "warn");
    return {
      ...fallback,
      maximized: false,
    };
  }
  const display = screen.getDisplayMatching(candidate);
  const workArea = display.workArea;
  const normalized = {
    width,
    height,
    x: Math.min(Math.max(candidate.x, workArea.x), Math.max(workArea.x, workArea.x + workArea.width - width)),
    y: Math.min(Math.max(candidate.y, workArea.y), Math.max(workArea.y, workArea.y + workArea.height - height)),
    maximized: state.maximized === true,
  };
  logWindowLifecycle("bounds-validated", "Saved window bounds validated for current displays.", { saved: state, normalized });
  return normalized;
}

function isBoundsVisibleOnAnyDisplay(bounds = {}) {
  if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) {
    return false;
  }
  return screen.getAllDisplays().some((display) => getBoundsIntersectionArea(bounds, display.workArea) >= Math.min(20000, bounds.width * bounds.height * 0.2));
}

function isUsableVisibleWindow(window) {
  if (!window || window.isDestroyed()) return false;
  if (!window.isVisible() || window.isMinimized()) return false;
  return isBoundsVisibleOnAnyDisplay(window.getBounds());
}

function resetWindowToSafeBounds(window, reason = "safe-bounds-reset") {
  if (!window || window.isDestroyed()) return false;
  const bounds = getDefaultWindowBounds();
  if (window.isMinimized()) window.restore();
  if (window.isMaximized()) window.unmaximize();
  window.setBounds(bounds, false);
  logWindowLifecycle("window-safe-bounds-reset", "Main window bounds reset to a centered visible area.", { reason, bounds }, "warn");
  return true;
}

function showAndFocusWindow(window, reason = "show") {
  if (!window || window.isDestroyed()) {
    return false;
  }
  if (window.isMinimized()) {
    window.restore();
  }
  if (!isBoundsVisibleOnAnyDisplay(window.getBounds())) {
    resetWindowToSafeBounds(window, reason);
  }
  if (!window.isVisible()) {
    window.show();
  }
  if (process.platform === "darwin") {
    app.focus({ steal: true });
  }
  window.focus();
  if (!isUsableVisibleWindow(window)) {
    resetWindowToSafeBounds(window, `${reason}:post-show`);
    window.show();
    window.focus();
  }
  const usable = isUsableVisibleWindow(window);
  logWindowLifecycle("window-show-focus", "Main window shown and focused.", {
    reason,
    visible: window.isVisible(),
    minimized: window.isMinimized(),
    bounds: window.getBounds(),
    usable,
  });
  if (usable) {
    completeWindowStartupAttempt("visible", { reason, bounds: window.getBounds() });
  }
  return usable;
}

function recreateMainWindow(reason = "recreate") {
  const oldWindow = mainWindow;
  if (oldWindow && !oldWindow.isDestroyed()) {
    try {
      oldWindow.destroy();
    } catch (error) {
      logWindowLifecycle("window-destroy-failed", "Could not destroy stale main window before recreation.", { reason, message: error.message }, "warn");
    }
  }
  mainWindow = null;
  createWindow({ showReason: reason, safeMode: true });
  return false;
}

function ensureMainWindowVisible(reason = "ensure-visible", options = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    logWindowLifecycle("window-recreate", "Main window was missing during visibility request; creating a new window.", { reason }, "warn");
    createWindow({ showReason: reason });
    return false;
  }
  // A window hidden to the tray (or minimized) is not visible by design: show
  // it first, and recreate it only if it is still unusable after a real
  // attempt. Recreating discards the renderer's state (open SSH sessions,
  // unsaved edits), which reopening from the tray must not do.
  if (options.recreateIfUnusable && !isUsableVisibleWindow(mainWindow)) {
    if (showAndFocusWindow(mainWindow, `${reason}:show-before-recreate`)) return true;
    logWindowLifecycle("window-recreate-unusable", "Main window remained unusable after recovery attempt; recreating it.", {
      reason,
      visible: mainWindow.isVisible(),
      minimized: mainWindow.isMinimized(),
      bounds: mainWindow.getBounds(),
    }, "warn");
    return recreateMainWindow(reason);
  }
  return showAndFocusWindow(mainWindow, reason);
}

function saveWindowState(window) {
  if (!window || window.isDestroyed()) {
    return;
  }

  try {
    if (window.isMinimized() || !window.isVisible() || !isBoundsVisibleOnAnyDisplay(window.getBounds())) {
      logWindowLifecycle("window-state-save-skipped", "Skipped saving minimized, hidden, or off-screen window state.", {
        minimized: window.isMinimized(),
        visible: window.isVisible(),
        bounds: window.getBounds(),
      }, "warn");
      return;
    }
    const bounds = window.isMaximized() ? window.getNormalBounds() : window.getBounds();
    const state = {
      ...bounds,
      maximized: window.isMaximized(),
    };
    fs.mkdirSync(path.dirname(getWindowStatePath()), { recursive: true });
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state, null, 2));
  } catch {
    // Window state is a convenience preference; failure should not block startup or shutdown.
  }
}

function getSenderWindow(event) {
  return BrowserWindow.fromWebContents(event.sender) || null;
}

function sendMaximizedState(window) {
  if (!window || window.isDestroyed()) {
    return;
  }

  window.webContents.send(WINDOW_MAXIMIZED_CHANGED_CHANNEL, window.isMaximized());
}

function registerWindowIpc() {
  ipcMain.on("window:minimize", (event) => {
    getSenderWindow(event)?.minimize();
  });

  ipcMain.on("window:maximize", (event) => {
    const window = getSenderWindow(event);

    if (window && !window.isMaximized()) {
      window.maximize();
    }
  });

  ipcMain.on("window:restore", (event) => {
    const window = getSenderWindow(event);

    if (!window) {
      return;
    }

    if (window.isMinimized()) {
      window.restore();
      return;
    }

    if (window.isMaximized()) {
      window.unmaximize();
    }
  });

  ipcMain.on("window:close", (event) => {
    getSenderWindow(event)?.close();
  });

  ipcMain.handle("window:isMaximized", (event) => {
    return Boolean(getSenderWindow(event)?.isMaximized());
  });

}

function showMainWindowFromTray(reason = "tray") {
  ensureMainWindowVisible(reason, { recreateIfUnusable: true });
}

function createTray() {
  if (tray || qaMode) return tray;
  tray = new Tray(APP_ICON_PATH);
  tray.setToolTip(PRODUCT_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: `Open ${PRODUCT_NAME}`,
      click: () => showMainWindowFromTray("tray-menu"),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]));
  tray.on("click", () => showMainWindowFromTray("tray-click"));
  tray.on("double-click", () => showMainWindowFromTray("tray-double-click"));
  return tray;
}

function clearMainWindowWatchdogTimers() {
  for (const timer of mainWindowWatchdogTimers) {
    clearTimeout(timer);
  }
  mainWindowWatchdogTimers = [];
}

function createStartupDiagnosticWindow(title, detail, context = {}) {
  logWindowLifecycle("startup-diagnostic-window", "Showing visible startup diagnostic window.", { title, detail, context }, "error");
  const bounds = getDefaultWindowBounds();
  const diagnosticWindow = new BrowserWindow({
    ...bounds,
    minWidth: 720,
    minHeight: 460,
    title,
    icon: APP_ICON_PATH,
    backgroundColor: "#160b12",
    autoHideMenuBar: true,
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // The diagnostic page is a data: URL loaded by main; nothing may replace it.
  applyWindowNavigationGuard(diagnosticWindow.webContents, {
    allowedPages: [],
    openExternalUrl,
    openSource: "diagnostic-window-open",
    navigationSource: "diagnostic-window-navigation",
  });
  const escapedTitle = String(title || `${PRODUCT_NAME} startup problem`).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const escapedDetail = String(detail || "The app window could not be opened.").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  const escapedContext = JSON.stringify(context || {}, null, 2).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  diagnosticWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapedTitle}</title>
  <style>
    body { margin: 0; min-height: 100vh; background: #160b12; color: #f7eef4; font: 14px/1.5 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; display: grid; place-items: center; }
    main { max-width: 760px; padding: 32px; }
    h1 { margin: 0 0 12px; font-size: 24px; }
    p { color: #dccbd4; }
    pre { overflow: auto; max-height: 220px; padding: 12px; background: #26121e; border: 1px solid #563048; border-radius: 8px; color: #f7d9e8; }
  </style>
</head>
<body>
  <main>
    <h1>${escapedTitle}</h1>
    <p>${escapedDetail}</p>
    <pre>${escapedContext}</pre>
  </main>
</body>
</html>`)}`);
  return diagnosticWindow;
}

function startMainWindowWatchdog(window, reason = "startup") {
  clearMainWindowWatchdogTimers();
  const schedule = (delay, stage, action) => {
    const timer = setTimeout(() => {
      if (!window || window.isDestroyed() || mainWindow !== window) return;
      if (isUsableVisibleWindow(window)) {
        completeWindowStartupAttempt("visible", { reason: `watchdog:${stage}`, bounds: window.getBounds() });
        return;
      }
      logWindowLifecycle("startup-watchdog", "Main window was not visibly usable before watchdog deadline.", {
        reason,
        stage,
        delay,
        visible: window.isVisible(),
        minimized: window.isMinimized(),
        bounds: window.getBounds(),
      }, "warn");
      action();
    }, delay);
    mainWindowWatchdogTimers.push(timer);
  };

  schedule(MAIN_WINDOW_WATCHDOG_FIRST_MS, "show", () => {
    showAndFocusWindow(window, "startup-watchdog-show");
  });
  schedule(MAIN_WINDOW_WATCHDOG_RESET_MS, "reset-bounds", () => {
    resetWindowToSafeBounds(window, "startup-watchdog-reset");
    showAndFocusWindow(window, "startup-watchdog-reset");
  });
  schedule(MAIN_WINDOW_WATCHDOG_RECREATE_MS, "recreate", () => {
    if (!isUsableVisibleWindow(window)) {
      recreateMainWindow("startup-watchdog-recreate");
    }
  });
}

function createWindow(options = {}) {
  const startupAttempt = startWindowStartupAttempt(options.showReason || "startup");
  const safeMode = options.safeMode === true || startupAttempt.safeMode;
  const windowState = safeMode ? { ...getDefaultWindowBounds(), maximized: false } : normalizeWindowStateForDisplays(readWindowState());
  logWindowLifecycle("create-window", "Creating main window.", {
    reason: options.showReason || "startup",
    safeMode,
    bounds: windowState,
    displayCount: screen.getAllDisplays().length,
  });
  let saveWindowStateTimer = null;
  const scheduleWindowStateSave = () => {
    clearTimeout(saveWindowStateTimer);
    saveWindowStateTimer = setTimeout(() => saveWindowState(window), 250);
  };
  const window = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 900,
    minHeight: 640,
    title: PRODUCT_NAME,
    icon: APP_ICON_PATH,
    backgroundColor: "#07020f",
    autoHideMenuBar: true,
    show: false,
    frame: false,
    titleBarStyle: "hidden",
    titleBarOverlay: false,
    thickFrame: true,
    roundedCorners: true,
    ...(qaMode ? {} : { backgroundMaterial: process.platform === "win32" ? "mica" : "auto" }),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = window;
  logWindowLifecycle("create-window-complete", "Main BrowserWindow constructed.", {
    reason: options.showReason || "startup",
    bounds: window.getBounds(),
    id: window.id,
  });

  let shown = false;
  const showMainWindow = (reason) => {
    if (shown || window.isDestroyed()) return;
    if (windowState.maximized) {
      window.maximize();
    }
    const usable = showAndFocusWindow(window, reason);
    shown = usable;
    sendMaximizedState(window);
  };
  const showFallbackTimer = setTimeout(() => {
    if (!window.isDestroyed() && !window.isVisible()) {
      logWindowLifecycle("show-fallback", "Main window did not emit ready-to-show in time; forcing visible launch.", {
        timeoutMs: MAIN_WINDOW_SHOW_FALLBACK_MS,
      }, "warn");
      showMainWindow("ready-to-show-timeout");
    }
  }, MAIN_WINDOW_SHOW_FALLBACK_MS);
  window.once("ready-to-show", () => {
    logWindowLifecycle("ready-to-show", "Main window emitted ready-to-show.", {});
    clearTimeout(showFallbackTimer);
    showMainWindow("ready-to-show");
  });
  window.webContents.once("did-finish-load", () => {
    logWindowLifecycle("renderer-loaded", "Main window renderer finished loading.", {});
    if (!window.isDestroyed() && !window.isVisible()) {
      showMainWindow("did-finish-load");
    }
  });
  window.on("maximize", () => {
    saveWindowState(window);
    sendMaximizedState(window);
  });
  window.on("unmaximize", () => {
    saveWindowState(window);
    sendMaximizedState(window);
  });
  window.on("resize", scheduleWindowStateSave);
  window.on("move", scheduleWindowStateSave);
  window.on("close", (event) => {
    clearTimeout(saveWindowStateTimer);
    saveWindowState(window);
    if (!qaMode && !appShuttingDown) {
      event.preventDefault();
      window.hide();
      diagnostics.log("info", "desktop", "window-hidden-to-tray", "Main window was hidden to the notification tray.", {}, { file: "desktop" });
      return;
    }
    completeWindowStartupAttempt("closed", { reason: "window-close" });
  });
  window.on("closed", () => {
    clearTimeout(showFallbackTimer);
    clearMainWindowWatchdogTimers();
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  window.on("show", () => {
    logWindowLifecycle("window-show-event", "Main window emitted show.", { bounds: window.getBounds() });
    if (isUsableVisibleWindow(window)) completeWindowStartupAttempt("visible", { reason: "show-event", bounds: window.getBounds() });
  });
  window.on("hide", () => {
    logWindowLifecycle("window-hide-event", "Main window emitted hide.", { bounds: window.getBounds() }, "warn");
  });
  window.on("unresponsive", () => {
    logWindowLifecycle("window-unresponsive", "Main window became unresponsive during startup or runtime.", { bounds: window.getBounds() }, "error");
  });
  window.webContents.on("render-process-gone", (_, details) => {
    const context = {
      reason: details?.reason || null,
      exitCode: details?.exitCode ?? null,
    };
    logWindowLifecycle("renderer-process-gone", "Main window renderer process exited.", context, "error");
    if (qaMode) console.error("[Desktop] QA renderer process exited.", context);
    completeWindowStartupAttempt("failed", { reason: "renderer-process-gone", ...context });
    createStartupDiagnosticWindow(`${PRODUCT_NAME} renderer stopped`, "The app renderer stopped before the main window became usable. AnxHost is recreating the window with safe bounds.", context);
    recreateMainWindow("renderer-process-gone");
  });
  window.webContents.on("did-fail-load", (_, errorCode, errorDescription, validatedUrl, isMainFrame) => {
    if (!isMainFrame) return;
    const context = { errorCode, errorDescription, validatedUrl };
    logWindowLifecycle("renderer-fail-load", "Main window failed to load.", context, "error");
    if (qaMode) console.error("[Desktop] QA main window failed to load.", context);
    completeWindowStartupAttempt("failed", { reason: "did-fail-load", ...context });
    dialog.showErrorBox(`${PRODUCT_NAME} failed to load`, `${errorDescription || "The app window could not load."} (${errorCode})`);
    createStartupDiagnosticWindow(`${PRODUCT_NAME} failed to load`, `${errorDescription || "The app window could not load."} (${errorCode})`, context);
  });

  logWindowLifecycle("load-start", "Loading main renderer file.", { file: "index.html", qaMode });
  window.loadFile(path.join(__dirname, "index.html"), qaMode ? { search: "?qa-mode=1" } : undefined);
  startMainWindowWatchdog(window, options.showReason || "startup");

  if (process.env.ANXOS_OPEN_DEVTOOLS === "1" && app.isPackaged === false) {
    window.webContents.once("did-finish-load", () => {
      window.webContents.openDevTools({ mode: "detach" });
    });
  }

  applyWindowNavigationGuard(window.webContents, {
    allowedPages: [path.join(__dirname, "index.html")],
    openExternalUrl,
    openSource: "main-window-open",
    navigationSource: "main-window-navigation",
  });

  window.webContents.on("context-menu", (_, params) => {
    const template = params.isEditable
      ? [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { type: "separator" },
          { role: "selectAll" },
        ]
      : [
          { role: "copy", enabled: Boolean(params.selectionText) },
          { type: "separator" },
          { role: "selectAll" },
        ];
    Menu.buildFromTemplate(template).popup({ window });
  });
}

if (gotSingleInstanceLock) {
app.on("second-instance", () => {
  if (agentMode) return;
  logWindowLifecycle("second-instance", "Second app launch requested; restoring or recreating main window.");
  ensureMainWindowVisible("second-instance", { recreateIfUnusable: true });
});

app.whenReady().then(async () => {
  if (agentMode) {
    const agentControl = require("./src/services/agentControlService");
    const config = agentControl.readConfig();
    Object.assign(process.env, agentControl._test.agentEnvironment(config));
    diagnostics.log("info", "agent", "scheduled-task-start", "Starting the Local Agent from the canonical --agent entry point.", {
      executable: process.execPath,
      arguments: "--agent",
      workingDirectory: path.dirname(process.execPath),
    }, { file: "agent" });
    require(agentControl._test.getAgentScript());
    return;
  }
  logWindowLifecycle("app-ready", "Electron app ready; starting desktop initialization.");
  // Chromium builds the accessibility tree only after a UI Automation client
  // first asks, so that first query (screen readers, automation tools) saw an
  // empty window. Build it from the start.
  app.setAccessibilitySupportEnabled(true);
  instrumentIpcHandlers({
    ipcMain,
    diagnostics,
    isShuttingDown: () => appShuttingDown,
    publishInstanceSnapshot: (nodeId, payload) => require("./src/services/alertService").publishInstanceSnapshot(nodeId, payload),
  });
  registerDiagnosticsIpc();
  registerAccountAuthIpc();
  registerSecurityIpc();
  startIdleLockMonitor();
  registerAgentControlIpc();
  registerDependenciesIpc();
  diagnostics.captureSnapshot({ applicationRunning: true, providerMode: "initializing" });
  updateManager.on("status", (payload = {}) => {
    const severity = /error|failed/i.test(payload.type || payload.state?.status || "") ? "error" : "info";
    diagnostics.log(severity, "updater", payload.type || "status", payload.message || `Updater state: ${payload.type || payload.state?.status || "unknown"}`, { status: payload.state?.status || null, version: payload.update?.latestVersion || payload.state?.latest?.latestVersion || null }, { file: "updater", errorCode: payload.error?.code || null });
  });
  ipcMain.handle("app:getRuntimeInfo", () => getRuntimeInfo());
  registerWindowIpc();
  // 217-E: Install closes the app through its normal shutdown, then opens the
  // installer (see before-quit), and waits for sensitive work on this PC.
  updateManager.configureInstallHandoff({
    findBlockingWork: () => updateHandoff.findBlockingWork({
      listOperations: () => require("./src/shared/longOperationService").listOperations(),
      listInstanceJobs: (options) => localInstanceService.listInstanceJobs(options),
    }),
    describeBlockingWork: updateHandoff.describeBlockingWork,
    requestQuit: () => app.quit(),
  });
  registerUpdatesIpc(updateManager);
  registerDeveloperUpdatesIpc(developerGitUpdater);
  registerActionIpc();
  registerSystemIpc();
  registerAmpIpc();
  registerBackupsIpc();
  registerPlayitIpc();
  registerPublicAccessIpc();
  registerAnxNetIpc();
  // AnxNet resumes only if this computer is already in a network.
  anxnetService.resume().catch(() => {});
  registerMobileGatewayIpc();
  // Phone access starts again only if the owner left it on.
  mobileGatewayService.resume().catch(() => {});
  registerNetworkIpc();
  registerTelemetryIpc();
  registerNotificationsIpc();
  registerDockerIpc();
  registerInstancesIpc();
  registerMarketplaceIpc();
  registerMaintenanceIpc();
  registerNodesIpc();
  registerComputersIpc();
  registerNetworkInventoryIpc();
  registerWebhookAlertsIpc();
  registerInfrastructureInventoryIpc();
  registerAlertsIpc();
  // V2-J: the alert engine is inert without a driver. Start a bounded
  // evaluation loop over state the desktop already polls — it adds no new
  // network surface and is stopped on quit.
  try {
    const alertService = require("./src/services/alertService");
    const nodeService = require("./src/services/nodeService");
    const serviceRouter = require("./src/services/serviceRouter");
    // Telemetry supplies each computer's latest disk reading (DISK_PRESSURE).
    const telemetryService = require("./src/services/telemetryService");
    alertService.startAlertScheduler({
      collectState: createAlertStateCollector({ nodeService, alertService, serviceRouter, telemetryService }),
    });
    app.on("before-quit", () => {
      try { alertService.stopAlertScheduler(); } catch {}
    });
  } catch (error) {
    console.error("[Alerts] Scheduler start failed.", error?.message || error);
  }
  // V2-K: the telemetry sampler is inert without a driver. Start the bounded
  // sampling loop over state the desktop already reads; it adds no new
  // network surface and is stopped on quit.
  try {
    const telemetryService = require("./src/services/telemetryService");
    telemetryService.startTelemetrySampler();
    app.on("before-quit", () => {
      try { telemetryService.stopTelemetrySampler(); } catch {}
    });
  } catch (error) {
    console.error("[Telemetry] Sampler start failed.", error?.message || error);
  }
  // Node connectivity: keep SSH tunnels open for nodes whose Agent only
  // listens on the node itself. Re-synced periodically so configuration
  // changes and freed ports are picked up; closed on quit.
  try {
    const nodeTunnels = require("./src/services/nodeTunnelService").getNodeTunnelService();
    nodeTunnels.sync();
    // Route fallback shares the loop: re-check each node's routes so a home
    // server moves between LAN and Tailscale as the desktop moves.
    const nodeRoutes = require("./src/services/nodeRouteResolver").getNodeRouteResolver();
    nodeRoutes.refreshAll().catch(() => {});
    const nodeTunnelSyncTimer = setInterval(() => {
      try { nodeTunnels.sync(); } catch {}
      nodeRoutes.refreshAll().catch(() => {});
    }, 30000);
    nodeTunnelSyncTimer.unref?.();
    app.on("before-quit", () => {
      clearInterval(nodeTunnelSyncTimer);
      try { nodeTunnels.stopAll(); } catch {}
    });
  } catch (error) {
    console.error("[Nodes] Tunnel service start failed.", error?.message || error);
  }
  // V2-K: the operational notification journal only advances when evaluated.
  // The scheduler's immediate tick seeds state through the shared collector
  // (which degrades every unreachable service to an empty collection), and
  // every later transition emits one deduped, redacted event.
  try {
    const n = require("./src/services/operationalNotificationService");
    n.startOperationalNotificationScheduler({
      collectState: n.createOperationalNotificationCollector({
        nodeService: require("./src/services/nodeService"),
        alertService: require("./src/services/alertService"),
        serviceRouter: require("./src/services/serviceRouter"),
        endpointService: require("./src/services/endpointService"),
        providerIntegrationService: require("./src/services/providerIntegrationService"),
        connectivityDiagnosticsService: require("./src/services/connectivityDiagnosticsService"),
      }),
    });
    app.on("before-quit", () => {
      try { n.stopOperationalNotificationScheduler(); } catch {}
    });
  } catch (error) {
    console.error("[Notifications] Scheduler start failed.", error?.message || error);
  }
  registerWorkloadIpc();
  registerOwnerWorkspaceIpc();
  registerFilesIpc();
  registerSettingsIpc();
  // Phase X: optional assistant. Registers channels only; nothing behind them
  // loads until the first ai:* call.
  registerAiOperationsIpc();
  registerSshIpc();
  createTray();
  createWindow();
  try {
    logCurseForgeStartupStatus();
  } catch (error) {
    diagnostics.logError("startup", "marketplace-provider-degraded", error, {
      message: "Marketplace provider settings could not be restored. Credential-dependent providers are temporarily disabled.",
    }, { file: "desktop" });
  }
  updateManager.start();
  localInstanceService.recoverIncompleteInstallations()
    .then((instanceRecovery) => {
      if (instanceRecovery.repaired.length || instanceRecovery.failures.length) {
        diagnostics.log("info", "startup", "instance-recovery", "Incomplete local Marketplace installations were repaired.", instanceRecovery, { file: "desktop" });
      }
    })
    .catch((error) => {
      diagnostics.logError("startup", "instance-recovery", error, {}, { file: "desktop" });
    });

  // V2-D install transactions: re-observe marketplace install jobs that were in
  // flight when the desktop restarted (the V2-A "no orphan" gate), mirroring the
  // Agent's boot-time job re-observation. Interrupted marketplace jobs settle
  // as FAILED/JOB_INTERRUPTED with retry guidance.
  localInstanceService.recoverInstanceJobs()
    .then((jobRecovery) => {
      if (jobRecovery?.recovered) {
        // The recovery payload is just a ran-flag: it covers the shared pass
        // over ALL non-terminal jobs (instance + marketplace), so the message
        // must not claim marketplace jobs specifically were found.
        diagnostics.log("info", "startup", "marketplace-job-recovery", "Interrupted-job recovery pass completed; non-terminal jobs (instance and marketplace) were re-observed.", jobRecovery, { file: "desktop" });
      }
    })
    .catch((error) => {
      diagnostics.logError("startup", "marketplace-job-recovery", error, {}, { file: "desktop" });
    })
    // "Start this server when the computer starts" for local servers, after
    // job recovery as on the Agent.
    .then(() => localInstanceService.startAutoStartInstances())
    .then((autoStart) => {
      if (autoStart?.started?.length || autoStart?.failures?.length) {
        diagnostics.log("info", "startup", "instance-auto-start", "Local servers set to start with the computer were started.", autoStart, { file: "desktop" });
      }
    })
    .catch((error) => {
      diagnostics.logError("startup", "instance-auto-start", error, {}, { file: "desktop" });
    });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow({ showReason: "activate" });
    } else {
      ensureMainWindowVisible("activate", { recreateIfUnusable: true });
    }
  });
});

app.on("window-all-closed", () => {
  if (qaMode && process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (appShutdownComplete) return;
  event.preventDefault();
  if (appShuttingDown) return;
  appShuttingDown = true;
  if (tray) {
    tray.destroy();
    tray = null;
  }
  diagnostics.updateRuntimeState({ applicationRunning: false });
  updateManager.stop();
  disposeFilesIpc();
  disposeSshIpc();
  Promise.all([anxnetService.shutdown().catch(() => {}), mobileGatewayService.shutdown().catch(() => {}), localInstanceService.shutdownInstanceService()])
    .catch((error) => diagnostics.logError("shutdown", "instances", error, {}, { file: "desktop" }))
    .then(() => {
      try { require("./src/shared/longOperationService").flushPendingWrites(); } catch (error) { diagnostics.logError("shutdown", "long-operations", error, {}, { file: "desktop" }); }
      // 217-E: an update's installer opens only now, after servers stopped and
      // pending writes were saved, so it never has to force the app closed.
      return updateManager.completeInstallHandoff().catch((error) => diagnostics.logError("shutdown", "update-handoff", error, {}, { file: "desktop" }));
    })
    .finally(() => {
      appShutdownComplete = true;
      app.quit();
    });
});
} else {
  app.quit();
}

process.on("uncaughtException", (error) => diagnostics.logError("desktop", "uncaught-exception", error, {}, { file: "desktop" }));
process.on("unhandledRejection", (reason) => diagnostics.logError("desktop", "unhandled-rejection", reason instanceof Error ? reason : new Error(String(reason)), {}, { file: "desktop" }));
