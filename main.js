const { app, BrowserWindow, Menu, ipcMain, screen } = require("electron");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { registerAccountAuthIpc } = require("./src/ipc/accountAuthIpc");
const { registerActionIpc } = require("./src/ipc/actionIpc");
const { registerAmpIpc } = require("./src/ipc/ampIpc");
const { registerBackupsIpc } = require("./src/ipc/backupsIpc");
const { registerDockerIpc } = require("./src/ipc/dockerIpc");
const { disposeFilesIpc, registerFilesIpc } = require("./src/ipc/filesIpc");
const { registerInstancesIpc } = require("./src/ipc/instancesIpc");
const { registerMarketplaceIpc } = require("./src/ipc/marketplaceIpc");
const { registerMaintenanceIpc } = require("./src/ipc/maintenanceIpc");
const { registerNodesIpc } = require("./src/ipc/nodesIpc");
const { registerOwnerWorkspaceIpc } = require("./src/ipc/ownerWorkspaceIpc");
const { registerPlayitIpc } = require("./src/ipc/playitIpc");
const { registerPublicAccessIpc } = require("./src/ipc/publicAccessIpc");
const { registerSecurityIpc } = require("./src/ipc/securityIpc");
const { registerSettingsIpc } = require("./src/ipc/settingsIpc");
const { disposeSshIpc, registerSshIpc } = require("./src/ipc/sshIpc");
const { registerSystemIpc } = require("./src/ipc/systemIpc");
const { registerStorageWindowIpc } = require("./src/ipc/storageWindowIpc");
const { registerDeveloperUpdatesIpc, registerUpdatesIpc } = require("./src/ipc/updatesIpc");
const { logStartupStatus: logCurseForgeStartupStatus } = require("./src/services/providers/curseforgeProvider");
const { UpdateManager } = require("./src/services/updateManager");
const { configureElectronPaths } = require("./src/services/electronPaths");
const { DeveloperGitUpdater } = require("./src/services/developerGitUpdater");
const { openExternalUrl } = require("./src/services/externalUrlService");
const { getReleaseInfo } = require("./src/shared/releaseConfig");
const packageJson = require("./package.json");
const qaMode = process.argv.includes("--qa-mode") || process.env.ANXOS_QA_MODE === "1";
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
const ADD_STORAGE_SAVED_CHANNEL = "files:storageConnectionSaved";
const DEFAULT_WINDOW_BOUNDS = {
  width: 1180,
  height: 820,
};
const updateManager = new UpdateManager();
const developerGitUpdater = new DeveloperGitUpdater({ app, appRoot: __dirname });
let mainWindow = null;
let addStorageWindow = null;
let pendingAddStoragePayload = null;
let appShuttingDown = false;
let appShutdownComplete = false;
const gotSingleInstanceLock = app.requestSingleInstanceLock();

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
const diagnostics = require("./src/services/diagnosticsService");
const { registerDiagnosticsIpc } = require("./src/ipc/diagnosticsIpc");
const { registerAgentControlIpc } = require("./src/ipc/agentControlIpc");
const { registerDependenciesIpc } = require("./src/ipc/dependenciesIpc");
const localInstanceService = require("./src/services/localInstanceService");
const originalConsoleError = console.error.bind(console);
console.error = (...args) => {
  originalConsoleError(...args);
  diagnostics.log("error", "desktop", "console-error", args.map((value) => value?.message || String(value)).join(" "), { arguments: args }, { file: "desktop" });
};

function instrumentIpcHandlers() {
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => register(channel, async (...args) => {
    if (appShuttingDown) {
      throw Object.assign(new Error("The application is shutting down and cannot accept new requests."), { code: "APPLICATION_SHUTTING_DOWN" });
    }
    const correlationId = diagnostics.correlationId("ipc");
    const startedAt = Date.now();
    diagnostics.log("info", "ipc", channel, "IPC request started", {}, { file: "ipc", correlationId });
    try {
      const result = await listener(...args);
      diagnostics.log("info", "ipc", channel, "IPC request completed", { durationMs: Date.now() - startedAt }, { file: "ipc", correlationId });
      return result;
    } catch (error) {
      diagnostics.logError("ipc", channel, error, { durationMs: Date.now() - startedAt }, { file: "ipc", correlationId });
      throw error;
    }
  });
}

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
    name: "AnxOS Control Center",
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

function saveWindowState(window) {
  if (!window || window.isDestroyed()) {
    return;
  }

  try {
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

function getCenteredChildBounds(parent, width = 520, height = 650) {
  const parentBounds = parent && !parent.isDestroyed() ? parent.getBounds() : screen.getPrimaryDisplay().workArea;
  const display = screen.getDisplayMatching(parentBounds);
  const workArea = display.workArea;
  const x = Math.round(parentBounds.x + (parentBounds.width - width) / 2);
  const y = Math.round(parentBounds.y + (parentBounds.height - height) / 2);
  return {
    width,
    height,
    x: Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width),
    y: Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height),
  };
}

function openAddStorageWindow(payload = {}) {
  if (addStorageWindow && !addStorageWindow.isDestroyed()) {
    pendingAddStoragePayload = payload;
    if (addStorageWindow.isMinimized()) {
      addStorageWindow.restore();
    }
    addStorageWindow.focus();
    addStorageWindow.webContents.send("storageWindow:init", pendingAddStoragePayload);
    return { opened: true, focused: true };
  }

  pendingAddStoragePayload = payload;
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : BrowserWindow.getFocusedWindow();
  const bounds = getCenteredChildBounds(parent);
  addStorageWindow = new BrowserWindow({
    ...bounds,
    minWidth: 460,
    minHeight: 560,
    title: "Add Storage — AnxOS Control Center",
    parent: parent || undefined,
    modal: Boolean(parent),
    skipTaskbar: true,
    icon: APP_ICON_PATH,
    backgroundColor: "#07020f",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  addStorageWindow.once("ready-to-show", () => {
    if (!addStorageWindow || addStorageWindow.isDestroyed()) return;
    addStorageWindow.show();
    addStorageWindow.webContents.send("storageWindow:init", pendingAddStoragePayload);
  });

  addStorageWindow.on("closed", () => {
    addStorageWindow = null;
    pendingAddStoragePayload = null;
  });

  addStorageWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url, { source: "add-storage-window-open" }).catch(() => {});
    return { action: "deny" };
  });

  addStorageWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      openExternalUrl(url, { source: "add-storage-navigation" }).catch(() => {});
    }
  });

  addStorageWindow.loadFile(path.join(__dirname, "windows", "add-storage.html"));
  return { opened: true, focused: false };
}

function closeAddStorageWindow() {
  if (addStorageWindow && !addStorageWindow.isDestroyed()) {
    addStorageWindow.close();
    return { closed: true };
  }
  return { closed: false };
}

function createWindow() {
  const windowState = readWindowState();
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
    title: "AnxOS Control Center",
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

  window.once("ready-to-show", () => {
    if (windowState.maximized) {
      window.maximize();
    }
    window.show();
    sendMaximizedState(window);
  });
  if (qaMode) {
    window.webContents.once("did-finish-load", () => {
      if (!window.isDestroyed() && !window.isVisible()) {
        window.show();
        sendMaximizedState(window);
      }
    });
  }
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
  window.on("close", () => {
    clearTimeout(saveWindowStateTimer);
    closeAddStorageWindow();
    saveWindowState(window);
  });
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });
  if (qaMode) {
    window.webContents.on("render-process-gone", (_, details) => {
      console.error("[Desktop] QA renderer process exited.", {
        reason: details?.reason || null,
        exitCode: details?.exitCode ?? null,
      });
    });
    window.webContents.on("did-fail-load", (_, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (isMainFrame) {
        console.error("[Desktop] QA main window failed to load.", {
          errorCode,
          errorDescription,
          validatedUrl,
        });
      }
    });
  }

  window.loadFile(path.join(__dirname, "index.html"), qaMode ? { search: "?qa-mode=1" } : undefined);

  if (process.env.ANXOS_OPEN_DEVTOOLS === "1" && app.isPackaged === false) {
    window.webContents.once("did-finish-load", () => {
      window.webContents.openDevTools({ mode: "detach" });
    });
  }

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalUrl(url, { source: "main-window-open" }).catch(() => {});
    return { action: "deny" };
  });

  window.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      openExternalUrl(url, { source: "main-window-navigation" }).catch(() => {});
    }
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
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  const instanceRecovery = await localInstanceService.recoverIncompleteInstallations();
  if (instanceRecovery.repaired.length || instanceRecovery.failures.length) {
    diagnostics.log("info", "startup", "instance-recovery", "Incomplete local Marketplace installations were repaired.", instanceRecovery, { file: "desktop" });
  }
  instrumentIpcHandlers();
  registerDiagnosticsIpc();
  registerAgentControlIpc();
  registerDependenciesIpc();
  diagnostics.captureSnapshot({ applicationRunning: true, providerMode: "initializing" });
  updateManager.on("status", (payload = {}) => {
    const severity = /error|failed/i.test(payload.type || payload.state?.status || "") ? "error" : "info";
    diagnostics.log(severity, "updater", payload.type || "status", payload.message || `Updater state: ${payload.type || payload.state?.status || "unknown"}`, { status: payload.state?.status || null, version: payload.update?.latestVersion || payload.state?.latest?.latestVersion || null }, { file: "updater", errorCode: payload.error?.code || null });
  });
  logCurseForgeStartupStatus();
  ipcMain.handle("app:getRuntimeInfo", () => getRuntimeInfo());
  registerWindowIpc();
  registerStorageWindowIpc({
    closeWindow: closeAddStorageWindow,
    getMainWindow: () => mainWindow,
    getStorageWindow: () => addStorageWindow,
    notifySaved: (payload = {}) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(ADD_STORAGE_SAVED_CHANNEL, {
          connectionId: payload.connectionId || payload.id || null,
        });
      }
    },
    openWindow: openAddStorageWindow,
  });
  registerUpdatesIpc(updateManager);
  registerDeveloperUpdatesIpc(developerGitUpdater);
  registerAccountAuthIpc();
  registerActionIpc();
  registerSystemIpc();
  registerAmpIpc();
  registerBackupsIpc();
  registerPlayitIpc();
  registerPublicAccessIpc();
  registerDockerIpc();
  registerInstancesIpc();
  registerMarketplaceIpc();
  registerMaintenanceIpc();
  registerNodesIpc();
  registerOwnerWorkspaceIpc();
  registerFilesIpc();
  registerSettingsIpc();
  registerSecurityIpc();
  registerSshIpc();
  createWindow();
  updateManager.start();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (appShutdownComplete) return;
  event.preventDefault();
  if (appShuttingDown) return;
  appShuttingDown = true;
  diagnostics.updateRuntimeState({ applicationRunning: false });
  updateManager.stop();
  disposeFilesIpc();
  disposeSshIpc();
  localInstanceService.shutdownInstanceService({ timeoutMs: 5000 })
    .catch((error) => diagnostics.logError("shutdown", "instances", error, {}, { file: "desktop" }))
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
