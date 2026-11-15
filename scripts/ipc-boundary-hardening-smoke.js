#!/usr/bin/env node
"use strict";

// IPC boundary hardening (hermetic; no Electron, no network, no SSH host).
//
// 1 ipc-boundary-1: every BrowserWindow that loads preload.js may only
//   navigate to the app's own page. A file dropped outside a drop zone
//   (file:///C:/.../readme.html), a UNC share and a dragged web link are
//   refused in the main, Add Storage and workspace windows alike. Runs the
//   REAL main.js window factories against a fake electron, plus the renderer
//   drop guard against fake drag events.
// 2 ipc-boundary-2: SSH terminal output bursts over 16,000 characters reach
//   the renderer whole and in order, and multi-byte characters split across
//   ssh2 packets are decoded intact.
// 3 ipc-boundary-3: window.open from the Marketplace / Create Server
//   workspace windows is handed to openExternalUrl (as in the main window),
//   and "Open Project Details" never calls window.open("") without a URL.
//
// Run: node scripts/ipc-boundary-hardening-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const Module = require("module");
const { EventEmitter } = require("events");
const { pathToFileURL } = require("url");

const REPO = path.join(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-ipc-boundary-"));
process.env.ANXHUB_CONFIG_DIR = tempRoot;
process.env.AGENT_URL = process.env.AGENT_URL || "http://127.0.0.1:9";

let checks = 0;
const pass = (label) => { checks += 1; console.log(`PASS ${label}`); };

// ---------------------------------------------------------------------------
// Harness: compile the real main.js with a fake electron and inert local
// modules, then expose its window factories.
// ---------------------------------------------------------------------------
function loadMainWindowFactories() {
  function noop() { return deep; }
  const deep = new Proxy(noop, {
    get(_, key) {
      if (key === "then") return undefined;
      if (key === Symbol.toPrimitive) return () => "";
      if (key === "prototype") return {};
      return deep;
    },
    apply() { return deep; },
    construct() { return deep; },
  });

  const windows = [];
  const externalOpens = [];
  class FakeWebContents {
    constructor() { this.handlers = {}; this.openHandler = null; this.loaded = ""; }
    on(eventName, handler) { (this.handlers[eventName] ||= []).push(handler); return this; }
    once(eventName, handler) { return this.on(eventName, handler); }
    setWindowOpenHandler(handler) { this.openHandler = handler; }
    send() {}
    getURL() { return this.loaded; }
    openDevTools() {}
  }
  class FakeBrowserWindow {
    constructor(options) {
      this.opts = options;
      this.webContents = new FakeWebContents();
      this.id = windows.length + 1;
      windows.push(this);
    }
    on() { return this; }
    once() { return this; }
    loadFile(file, options) { this.webContents.loaded = pathToFileURL(file).href; this.loadOptions = options; }
    loadURL(url) { this.webContents.loaded = url; }
    isDestroyed() { return false; }
    isVisible() { return false; }
    isMinimized() { return false; }
    getBounds() { return { x: 0, y: 0, width: 100, height: 100 }; }
    show() {} focus() {} hide() {} maximize() {} close() {}
    static getFocusedWindow() { return null; }
    static getAllWindows() { return windows; }
  }
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };
  const fakeApp = new Proxy({
    whenReady: () => new Promise(() => {}),
    requestSingleInstanceLock: () => true,
    getPath: () => tempRoot,
    on() {},
    once() {},
    isPackaged: true,
    commandLine: { appendSwitch() {} },
    getVersion: () => "0.0.0",
  }, { get(target, key) { return key in target ? target[key] : deep; } });
  const fakeElectron = {
    app: fakeApp,
    BrowserWindow: FakeBrowserWindow,
    Menu: deep,
    Tray: deep,
    ipcMain: deep,
    screen: {
      getAllDisplays: () => [{ workArea }],
      getPrimaryDisplay: () => ({ workArea }),
      getDisplayMatching: () => ({ workArea }),
    },
    dialog: deep,
    shell: deep,
  };

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return fakeElectron;
    if (request === "./src/services/externalUrlService") {
      return { openExternalUrl: async (url, options) => { externalOpens.push({ url, source: options?.source }); return { opened: true }; } };
    }
    if (request === "./package.json") return originalLoad.apply(this, arguments);
    // The navigation guard is the code under test: load it for real.
    if (/windowNavigationGuard$/.test(request)) return originalLoad.apply(this, arguments);
    if (request.startsWith("./") || request.startsWith("../")) return deep;
    if (request === "child_process") return deep;
    return originalLoad.apply(this, arguments);
  };
  try {
    const mainPath = path.join(REPO, "main.js");
    const source = `${fs.readFileSync(mainPath, "utf8")}\n;module.exports.__ipcBoundaryTest = { createWindow, openWorkspaceWindow, openAddStorageWindow, createStartupDiagnosticWindow };\n`;
    const mainModule = new Module(mainPath, module);
    mainModule.filename = mainPath;
    mainModule.paths = Module._nodeModulePaths(REPO);
    mainModule._compile(source, mainPath);
    return { factories: mainModule.exports.__ipcBoundaryTest, windows, externalOpens };
  } finally {
    Module._load = originalLoad;
  }
}

function fireWillNavigate(win, url) {
  const handlers = win.webContents.handlers["will-navigate"] || [];
  let prevented = false;
  const event = { url, preventDefault() { prevented = true; } };
  for (const handler of handlers) handler(event, url);
  return { handlers: handlers.length, allowed: !prevented };
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// 1 ipc-boundary-1
// ---------------------------------------------------------------------------
async function checkNavigationBoundary() {
  const { factories, windows, externalOpens } = loadMainWindowFactories();
  factories.createWindow({ showReason: "ipc-boundary-smoke" });
  factories.openWorkspaceWindow("marketplace", {});
  factories.openWorkspaceWindow("create-server", { template: { id: "vanilla" } });
  factories.openAddStorageWindow({});
  factories.createStartupDiagnosticWindow("diag", "detail", {});
  await flushMicrotasks();

  const byTitle = (needle) => {
    const win = windows.find((candidate) => String(candidate.opts.title || "").includes(needle));
    assert(win, `window "${needle}" was not created`);
    return win;
  };
  const mainWindow = windows.find((candidate) => candidate.opts.title === "AnxOS Control Center");
  assert(mainWindow, "main window was not created");
  const marketplace = byTitle("Marketplace");
  const createServer = byTitle("Create Server");
  const addStorage = byTitle("Add Storage");
  const diagnostic = byTitle("diag");

  const indexUrl = pathToFileURL(path.join(REPO, "index.html")).href;
  const addStorageUrl = pathToFileURL(path.join(REPO, "windows", "add-storage.html")).href;
  const foreign = [
    "file:///C:/Users/x/Downloads/modpack/readme.html",
    "file:///C:/Users/x/Downloads/server.properties",
    "file://fileserver/share/a.html",
    "file://fileserver/" + indexUrl.replace(/^file:\/\/\/?/, ""),
    `${indexUrl.replace(/index\.html$/, "")}windows/../../index.html`,
    "https://www.curseforge.com/minecraft/modpacks/all-the-mods-9",
    "http://example.com/",
    "javascript:alert(1)",
    "data:text/html,<script>1</script>",
    "about:blank",
    "",
  ];

  // Own pages stay reachable (query and hash ignored; case-insensitive drive
  // and folder names on Windows because Chromium may normalise them).
  const ownPages = [
    [mainWindow, indexUrl], [mainWindow, `${indexUrl}?qa-mode=1`], [mainWindow, `${indexUrl}#servers`],
    [marketplace, `${indexUrl}?surface=marketplace`], [createServer, `${indexUrl}?surface=create-server&templateId=vanilla`],
    [addStorage, addStorageUrl], [addStorage, `${addStorageUrl}?x=1`],
  ];
  if (process.platform === "win32") ownPages.push([mainWindow, indexUrl.replace(/^file:\/\/\/([A-Za-z])/, (_, drive) => `file:///${drive === drive.toUpperCase() ? drive.toLowerCase() : drive.toUpperCase()}`)]);
  for (const [win, url] of ownPages) {
    const result = fireWillNavigate(win, url);
    assert(result.allowed, `${win.opts.title} must allow its own page ${url}`);
  }

  for (const win of [mainWindow, marketplace, createServer, addStorage, diagnostic]) {
    for (const url of foreign) {
      const result = fireWillNavigate(win, url);
      assert(result.handlers > 0, `${win.opts.title} has no will-navigate guard`);
      assert.strictEqual(result.allowed, false, `${win.opts.title} must refuse navigation to ${JSON.stringify(url)}`);
    }
  }
  // A workspace window must not load the other window's page, nor the main
  // window the Add Storage page (each window keeps its own page).
  assert.strictEqual(fireWillNavigate(mainWindow, addStorageUrl).allowed, false, "main window must not navigate to the Add Storage page");
  assert.strictEqual(fireWillNavigate(addStorage, indexUrl).allowed, false, "Add Storage must not navigate to index.html");

  // Refused web links still open in the system browser (existing behaviour),
  // never inside the app window.
  externalOpens.length = 0;
  fireWillNavigate(marketplace, "https://www.curseforge.com/minecraft/modpacks/all-the-mods-9");
  fireWillNavigate(mainWindow, "https://modrinth.com/");
  await flushMicrotasks();
  assert.deepStrictEqual(externalOpens.map((entry) => entry.url), ["https://www.curseforge.com/minecraft/modpacks/all-the-mods-9", "https://modrinth.com/"]);
  assert.strictEqual(externalOpens[1].source, "main-window-navigation", "main window keeps its navigation source label");

  // Static: every BrowserWindow constructed in main.js gets the shared guard.
  const mainSource = fs.readFileSync(path.join(REPO, "main.js"), "utf8").replace(/\r\n/g, "\n");
  const constructed = (mainSource.match(/new BrowserWindow\(/g) || []).length;
  const guarded = (mainSource.match(/applyWindowNavigationGuard\(/g) || []).length;
  assert(constructed > 0 && guarded >= constructed, `every BrowserWindow needs applyWindowNavigationGuard (windows ${constructed}, guards ${guarded})`);
  assert(!/will-navigate[^\n]*\n[^\n]*startsWith\("file:\/\/"\)/.test(mainSource), "no will-navigate handler may allow every file:// URL");

  // Renderer layer: a drop outside a drop zone is cancelled, so Chromium
  // never performs its navigate-to-dropped-item default.
  const guardPath = path.join(REPO, "src", "renderer", "dropNavigationGuard.js");
  assert(fs.existsSync(guardPath), "src/renderer/dropNavigationGuard.js must exist");
  const indexHtml = fs.readFileSync(path.join(REPO, "index.html"), "utf8");
  const addStorageHtml = fs.readFileSync(path.join(REPO, "windows", "add-storage.html"), "utf8");
  assert(/<script src="src\/renderer\/dropNavigationGuard\.js"><\/script>/.test(indexHtml), "index.html must load the drop guard");
  assert(/<script src="\.\.\/src\/renderer\/dropNavigationGuard\.js"><\/script>/.test(addStorageHtml), "add-storage.html must load the drop guard");
  const listeners = {};
  const sandbox = {
    document: { addEventListener: (name, handler) => { listeners[name] = handler; } },
  };
  sandbox.window = sandbox;
  vm.runInNewContext(fs.readFileSync(guardPath, "utf8"), sandbox, { filename: guardPath });
  assert(listeners.dragover && listeners.drop, "drop guard must listen for dragover and drop on the document");
  const element = (tagName, extra = {}) => ({ tagName, isContentEditable: false, closest: () => null, ...extra });
  const dragEvent = (name, target, types, defaultPrevented = false) => {
    const event = {
      type: name,
      target,
      defaultPrevented,
      dataTransfer: { types, dropEffect: "copy" },
      preventDefault() { this.defaultPrevented = true; this.cancelled = true; },
    };
    listeners[name](event);
    return event;
  };
  const header = element("DIV");
  let event = dragEvent("dragover", header, ["Files"]);
  assert(event.cancelled && event.dataTransfer.dropEffect === "none", "a file dragged over the header must show no-drop");
  event = dragEvent("drop", header, ["Files"]);
  assert(event.cancelled, "a file dropped on the header must be cancelled");
  event = dragEvent("drop", header, ["text/uri-list", "text/plain"]);
  assert(event.cancelled, "a web link dropped on the page must be cancelled");
  event = dragEvent("dragover", element("DIV"), ["Files"], true);
  assert(!event.cancelled && event.dataTransfer.dropEffect === "copy", "a drop zone that handled the event keeps its own drop effect");
  event = dragEvent("drop", element("INPUT", { type: "text" }), ["text/plain"]);
  assert(!event.cancelled, "dropping text into a text field keeps the native behaviour");
  event = dragEvent("drop", element("INPUT", { type: "file" }), ["Files"]);
  assert(!event.cancelled, "dropping a file onto a file input keeps the native behaviour");
  event = dragEvent("drop", element("INPUT", { type: "text" }), ["Files"]);
  assert(event.cancelled, "a file dropped on a text field is cancelled (it would navigate)");

  pass("1 ipc-boundary-1 windows only navigate to their own app page; stray drops are cancelled");
}

// ---------------------------------------------------------------------------
// 2 ipc-boundary-2
// ---------------------------------------------------------------------------
async function checkSshOutputIntegrity() {
  // 2a IPC layer: a 32 KB ssh2 packet reaches the renderer whole, in order.
  const handlers = new Map();
  class MockSshService extends EventEmitter {
    async listProfiles() { return []; }
    dispose() {}
  }
  let mockService = null;
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
    if (request === "../services/sshService") return { SshService: class extends MockSshService { constructor() { super(); mockService = this; } } };
    if (request === "../services/securityService") return { audit() {}, checkRateLimit() {}, requirePermission() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  let sshIpc;
  try {
    const resolved = require.resolve("../src/ipc/sshIpc");
    delete require.cache[resolved];
    sshIpc = require(resolved);
  } finally {
    Module._load = originalLoad;
  }
  sshIpc.registerSshIpc();
  const sent = [];
  const sender = { send: (channel, payload) => sent.push({ channel, payload }), isDestroyed: () => false };
  await handlers.get("ssh:listProfiles")({ sender });

  let burst = "";
  for (let line = 0; burst.length < 40000; line += 1) burst += `\u001b[32mline-${String(line).padStart(5, "0")}\u001b[0m journal entry \u2500\u2500 \u00f6\r\n`;
  // A surrogate pair straddling the 16,000-character boundary must not be cut.
  burst = `${"x".repeat(15999)}\u{1F600}${burst}`;
  mockService.emit("session-output", { sessionId: "s1", chunk: burst });
  const dataEvents = sent.filter((entry) => entry.channel === "ssh:data");
  assert(dataEvents.length >= 2, "an oversized chunk is split into several ssh:data events");
  assert.strictEqual(dataEvents.map((entry) => entry.payload.chunk).join(""), burst, "every character of the burst reaches the renderer in order");
  for (const entry of dataEvents) {
    assert.strictEqual(entry.payload.sessionId, "s1");
    assert(entry.payload.chunk.length <= 16000, "each renderer payload stays bounded");
    const last = entry.payload.chunk.charCodeAt(entry.payload.chunk.length - 1);
    assert(!(last >= 0xd800 && last <= 0xdbff), "no event ends with half of a surrogate pair");
  }
  sent.length = 0;
  mockService.emit("session-output", { sessionId: "s1", chunk: "hello" });
  assert.deepStrictEqual(sent.map((entry) => entry.payload.chunk), ["hello"], "small chunks pass through as one event");
  sent.length = 0;
  mockService.emit("session-output", { sessionId: "s1", chunk: "" });
  assert.strictEqual(sent.filter((entry) => entry.channel === "ssh:data").length, 0, "an empty chunk sends nothing");
  sshIpc.disposeSshIpc();

  // 2b service layer: a UTF-8 character split across two packets survives.
  const { SshService } = require("../src/services/sshService");
  let shellStream = null;
  class ShellClient extends EventEmitter {
    connect() { queueMicrotask(() => this.emit("ready")); }
    shell(options, callback) {
      const stream = new EventEmitter();
      stream.writable = true;
      stream.write = () => {};
      stream.end = () => {};
      shellStream = stream;
      queueMicrotask(() => callback(null, stream));
    }
    end() {}
    destroy() {}
  }
  const service = new SshService({ createClient: () => new ShellClient() });
  service.getProfile = () => ({ id: "fixture", nodeId: "fixture-node", displayName: "Fixture", host: "127.0.0.1", port: 22, username: "anx", authType: "password" });
  const outputs = [];
  service.on("session-output", ({ sessionId, chunk }) => outputs.push({ sessionId, chunk }));
  const session = service.connect({ profileId: "fixture", nodeId: "fixture-node", password: "fixture-only" });
  const deadline = Date.now() + 3000;
  while (service.sessions.get(session.id)?.shellReady !== true && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(shellStream, "fake shell stream was opened");
  const text = "player \u00d6sterreich \u2500\u2500 \u{1F600} done";
  const bytes = Buffer.from(text, "utf8");
  const boxStart = bytes.indexOf(Buffer.from("\u2500", "utf8"));
  const emojiStart = bytes.indexOf(Buffer.from("\u{1F600}", "utf8"));
  shellStream.emit("data", bytes.subarray(0, boxStart + 1));
  shellStream.emit("data", bytes.subarray(boxStart + 1, emojiStart + 2));
  shellStream.emit("data", bytes.subarray(emojiStart + 2));
  const joined = outputs.filter((entry) => entry.sessionId === session.id).map((entry) => entry.chunk).join("");
  assert.strictEqual(joined, text, `multi-byte characters split across packets must be decoded intact, got ${JSON.stringify(joined)}`);
  assert(!joined.includes("\ufffd"), "no replacement characters");
  // A trailing incomplete sequence is flushed (not silently lost) on close.
  outputs.length = 0;
  shellStream.emit("data", Buffer.from([0x61, 0xe2, 0x94]));
  shellStream.emit("close");
  const tail = outputs.map((entry) => entry.chunk).join("");
  assert(tail.startsWith("a") && tail.length >= 2, `the undecodable tail is flushed on close, got ${JSON.stringify(tail)}`);
  service.dispose?.();

  pass("2 ipc-boundary-2 SSH bursts over 16,000 characters and split UTF-8 characters reach the terminal intact");
}

// ---------------------------------------------------------------------------
// 3 ipc-boundary-3
// ---------------------------------------------------------------------------
async function checkWorkspaceWindowOpen() {
  const { factories, windows, externalOpens } = loadMainWindowFactories();
  factories.openWorkspaceWindow("create-server", {});
  factories.openWorkspaceWindow("marketplace", {});
  factories.createWindow({ showReason: "ipc-boundary-smoke" });
  factories.openAddStorageWindow({});
  const projectUrl = "https://www.curseforge.com/minecraft/modpacks/example-pack";
  for (const win of windows) {
    assert.strictEqual(typeof win.webContents.openHandler, "function", `${win.opts.title} has no window-open handler`);
    externalOpens.length = 0;
    const result = win.webContents.openHandler({ url: projectUrl });
    await flushMicrotasks();
    assert.deepStrictEqual(result, { action: "deny" }, `${win.opts.title} must never open an Electron child window`);
    assert.deepStrictEqual(externalOpens.map((entry) => entry.url), [projectUrl], `${win.opts.title} must hand window.open to openExternalUrl`);
  }
  const createServer = windows.find((win) => String(win.opts.title).startsWith("Create Server"));
  externalOpens.length = 0;
  createServer.webContents.openHandler({ url: projectUrl });
  await flushMicrotasks();
  assert.strictEqual(externalOpens[0].source, "workspace-window-open");

  // "Open Project Details" falls back to a message when the template has no
  // project URL, instead of a silent window.open("").
  const appSource = fs.readFileSync(path.join(REPO, "app.js"), "utf8").replace(/\r\n/g, "\n");
  const buttonLine = appSource.split("\n").find((line) => line.includes("\"Open Project Details\""));
  assert(buttonLine, "Open Project Details button exists");
  assert(!/window\.open\([^)]*\|\|\s*""/.test(buttonLine), "Open Project Details must not call window.open with an empty URL");
  assert(/openMarketplaceProjectDetails\(template\)/.test(buttonLine), "Open Project Details uses openMarketplaceProjectDetails");
  const start = appSource.indexOf("function openMarketplaceProjectDetails(");
  assert(start > -1, "openMarketplaceProjectDetails is defined");
  const end = appSource.indexOf("\n}\n", start);
  const opened = [];
  const toasts = [];
  const sandbox = { window: { open: (...args) => { opened.push(args); return null; } }, showToast: (message) => toasts.push(message) };
  vm.runInNewContext(`${appSource.slice(start, end + 2)}\nthis.openMarketplaceProjectDetails = openMarketplaceProjectDetails;`, sandbox);
  sandbox.openMarketplaceProjectDetails({ projectUrl });
  sandbox.openMarketplaceProjectDetails({ websiteUrl: "https://modrinth.com/modpack/x" });
  sandbox.openMarketplaceProjectDetails({});
  assert.deepStrictEqual(opened.map((args) => args[0]), [projectUrl, "https://modrinth.com/modpack/x"]);
  assert.strictEqual(toasts.length, 1, "a template without a project page explains it instead of doing nothing");

  pass("3 ipc-boundary-3 workspace windows hand window.open to the system browser");
}

async function main() {
  const steps = [checkNavigationBoundary, checkSshOutputIntegrity, checkWorkspaceWindowOpen];
  const failures = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
      console.error(`FAIL ${step.name}: ${error && error.stack ? error.stack : error}`);
    }
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
  if (failures.length) {
    console.error(`ipc boundary hardening smoke failed (${failures.length} of ${steps.length} checks).`);
    process.exit(1);
  }
  console.log(`ipc boundary hardening smoke passed (${checks} checks).`);
  process.exit(0);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
