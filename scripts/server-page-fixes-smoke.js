#!/usr/bin/env node
"use strict";

// Server page: Settings and Files tabs keep to one server, Discard discards,
// memory validation matches what Save accepts, and the page layout holds.
// The real renderer functions run in a vm against a fake DOM and a fake
// desktop API; nothing reaches an Agent, the network or the OS.
//   1 (ui-servers-1)      the Files editor belongs to the server it was opened
//                         on: switching servers clears it, a dirty file asks
//                         first (also on Back), and Save never writes into
//                         another server;
//   2 (ui-servers-2)      no phantom "Unsaved changes" after the form is
//                         cleared and filled again;
//   3 (ui-servers-3)      opening another server on Settings loads that
//                         server's game settings, and Save never sends another
//                         server's adapter or hash;
//   4 (ui-servers-4)      memory such as "6GB" is refused by validation (with
//                         a field error), never silently dropped by Save, and
//                         an invalid memory edit still counts as unsaved;
//   5 (ui-servers-6)      "Discard changes" on leaving, and the Discard button,
//                         put every field (all game-settings sections) back;
//   6 (instance-engine-3) a computer switch or list reload leaves no phantom
//                         unsaved state and no previous server's game settings;
//   7 (visual-core-1)     after Discard on leaving, the next server opens with
//                         no prompt and its own game settings;
//   8 (visual-core-6)     the sticky server header sits flush with the top of
//                         the scroll area and is opaque;
//   9 (visual-core-8)     the Files grid gives the list room for its columns
//                         and never grows wider than its container;
//  10 (R6)                a server picked from another surface (palette,
//                         notification, Server Updates, console, Marketplace,
//                         dashboard) while the view is open loads its own
//                         Settings and Files, and unsaved edits ask first;
//  11 (Q2)                the same holds when the server is picked off the
//                         servers page (Marketplace, dashboard) or after a
//                         computer switch (Server Updates row), and list polls
//                         never load a tab twice or retry a failed load.
// Run: node scripts/server-page-fixes-smoke.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const serverViewSource = fs.readFileSync(path.join(ROOT, "src", "renderer", "serverView.js"), "utf8");
const cssSource = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");
const Model = require("../src/shared/serverViewModel");

// ---- source extraction --------------------------------------------------------

// Returns the end index (exclusive) of the balanced block that opens at `open`,
// skipping strings, template literals, comments and regex-free code.
function matchBlock(source, open, openChar = "{", closeChar = "}") {
  const stack = [];
  for (let k = open; k < source.length; k += 1) {
    const c = source[k];
    const mode = stack[stack.length - 1];
    if (mode === "'" || mode === '"') { if (c === "\\") { k += 1; continue; } if (c === mode) stack.pop(); continue; }
    if (mode === "`") {
      if (c === "\\") { k += 1; continue; }
      if (c === "`") { stack.pop(); continue; }
      if (c === "$" && source[k + 1] === "{") { stack.push("${"); k += 1; }
      continue;
    }
    if (mode === "//") { if (c === "\n") stack.pop(); continue; }
    if (mode === "/*") { if (c === "*" && source[k + 1] === "/") { stack.pop(); k += 1; } continue; }
    if (c === "/" && source[k + 1] === "/") { stack.push("//"); k += 1; continue; }
    if (c === "/" && source[k + 1] === "*") { stack.push("/*"); k += 1; continue; }
    if (c === "'" || c === '"' || c === "`") { stack.push(c); continue; }
    if (c === openChar) { stack.push(openChar); continue; }
    if (c === closeChar) {
      const top = stack.pop();
      if (top === "${") continue;
      if (!stack.length) return k + 1;
    }
  }
  throw new Error("unterminated block");
}

function extractFunction(source, name, { optional = false } = {}) {
  const match = new RegExp(`^[ \\t]*(async )?function ${name}\\(`, "m").exec(source);
  if (!match) {
    if (optional) return "";
    throw new Error(`missing function ${name}`);
  }
  const start = match.index + match[0].search(/\S/);
  const paramsEnd = matchBlock(source, source.indexOf("(", match.index), "(", ")");
  const bodyOpen = source.indexOf("{", paramsEnd);
  return source.slice(start, matchBlock(source, bodyOpen));
}

// The Discard button's click handler, whatever form it takes.
function extractCancelHandler() {
  const marker = 'instanceConfigCancelButton?.addEventListener("click", ';
  const at = appSource.indexOf(marker);
  if (at < 0) throw new Error("missing Discard button handler");
  const callOpen = at + marker.length - '"click", '.length - 1;
  const callEnd = matchBlock(appSource, callOpen, "(", ")");
  return appSource.slice(at + marker.length, callEnd - 1).trim();
}

// The notification action table (its "Open Instance" entries pick a server).
function extractNotificationActions() {
  const marker = "const NOTIFICATION_ACTIONS = ";
  const at = appSource.indexOf(marker);
  if (at < 0) throw new Error("missing NOTIFICATION_ACTIONS");
  const open = at + marker.length;
  return appSource.slice(open, matchBlock(appSource, open));
}

const APP_FUNCTIONS = [
  "setInstanceConfigValue", "getInstanceConfigValue", "collectInstanceConfigPayload", "collectInstanceConfigPayloadBase",
  "readInstanceEnvironmentEditor", "formatInstanceEnvironmentForEditor", "populateInstanceConfigForm", "syncInstanceConfigDirtyState",
  "hasUnsavedInstanceSettings", "isInstanceConfigFormBusy", "shouldRepopulateInstanceConfigForm", "getInstanceConfigFormKey",
  "setMinecraftPropertyValue", "populateMinecraftProperties", "normalizeMemoryLimit",
  "parseMemoryFromArgs", "parseJarFromArgs", "getStartupArgsForConfig", "pickInstanceConflictFields", "stringifyArgs",
  "getGameConfigField", "normalizeGameConfigInputValue", "normalizeGameConfigSnapshotValue", "snapshotGameConfigValues",
  "collectGameConfigValues", "getChangedGameConfigValues", "isGameConfigDirty", "setGameConfigStatus", "extractGameConfigValidationErrors",
  "renderGameConfigPanel", "updateGameConfigStatusLine", "createGameConfigField", "getActiveGameConfigFields", "createGameConfigInput",
  "updateGameConfigField", "resetGameConfigToCurrent", "loadGameServerConfig", "saveInstanceConfiguration", "validateInstanceSettingsForm",
  "refreshInstanceFiles", "openInstanceTextFile", "hasDirtyInstanceFile", "confirmDiscardInstanceFile", "syncInstanceFileDirtyState",
  "saveInstanceTextFile", "selectInstance", "setInstanceDetails", "openInstanceServerView", "setActiveInstanceTab",
  "openServerUpdateRow", "openConsoleInstanceFiles", "runMarketplaceInstalledAction", "openMarketplaceInstance",
];
// Present on only one side of the fix (added by it, or collectMinecraftProperties
// removed by it); a missing one is skipped so older code fails on behaviour.
const OPTIONAL_APP_FUNCTIONS = ["resetInstanceFileEditor", "resetAllGameConfigToCurrent", "discardInstanceSettingsEdits", "clearGameConfigState", "confirmSwitchInstance", "confirmLeaveInstanceFile", "reloadStaleServerViewTab", "collectMinecraftProperties"];
const SERVER_VIEW_FUNCTIONS = ["isOpen", "open", "close", "confirmLeaveSettings"];

const RENDERER_CODE = [
  ...APP_FUNCTIONS.map((name) => extractFunction(appSource, name)),
  ...OPTIONAL_APP_FUNCTIONS.map((name) => extractFunction(appSource, name, { optional: true })),
  ...SERVER_VIEW_FUNCTIONS.map((name) => extractFunction(serverViewSource, name)),
  `var discardButtonHandler = ${extractCancelHandler()};`,
  `var NOTIFICATION_ACTIONS = ${extractNotificationActions()};`,
].join("\n\n");

// ---- fake DOM -----------------------------------------------------------------

class El {
  constructor(tag = "div") {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parent = null;
    this.dataset = {};
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.readOnly = false;
    this.type = "";
    this.title = "";
    this.textContent = "";
    this.placeholder = "";
    this._value = "";
    this._classes = new Set();
  }
  get value() { return this._value; }
  set value(next) { this._value = String(next ?? ""); }
  get className() { return [...this._classes].join(" "); }
  set className(next) { this._classes = new Set(String(next).split(/\s+/).filter(Boolean)); }
  get classList() {
    const set = this._classes;
    return {
      add: (name) => set.add(name),
      remove: (name) => set.delete(name),
      contains: (name) => set.has(name),
      toggle: (name, force) => { const on = force === undefined ? !set.has(name) : Boolean(force); if (on) set.add(name); else set.delete(name); return on; },
    };
  }
  get selectedOptions() { return this.children.filter((child) => child.selected); }
  append(...nodes) { nodes.forEach((node) => { if (node && typeof node === "object") { node.parent = this; this.children.push(node); } }); }
  appendChild(node) { this.append(node); return node; }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  addEventListener(type, listener) { (this.listeners[type] = this.listeners[type] || []).push(listener); }
  dispatch(type) { (this.listeners[type] || []).forEach((listener) => listener({ target: this })); }
  setAttribute() {}
  removeAttribute() {}
  focus() {}
  matches() { return false; }
  contains() { return false; }
  querySelector() { return null; }
  closest(selector) {
    const className = selector.startsWith(".") ? selector.slice(1) : null;
    for (let node = this.parent; node; node = node.parent) if (className && node._classes.has(className)) return node;
    return null;
  }
  descendants() { const out = []; const walk = (node) => node.children.forEach((child) => { out.push(child); walk(child); }); walk(this); return out; }
  querySelectorAll(selector) {
    if (selector === "[data-game-config-field]") return this.descendants().filter((node) => node.dataset.gameConfigField);
    if (selector === "tr") return this.descendants().filter((node) => node.tagName === "TR");
    return [];
  }
}

// ---- fixtures -----------------------------------------------------------------

function minecraftModel(id, port, motd, hash) {
  return {
    id, supported: true, adapterId: "minecraft", label: "Minecraft", filePath: "server.properties", sourceHash: hash,
    values: { "server-port": port, "max-players": 20, motd },
    fields: [
      { key: "server-port", label: "Server Port", type: "port", category: "Network", restartRequired: true, currentValue: port, defaultValue: 25565 },
      { key: "max-players", label: "Max Players", type: "integer", category: "Players", restartRequired: true, currentValue: 20, defaultValue: 20 },
      { key: "motd", label: "MOTD", type: "string", category: "General", currentValue: motd, defaultValue: "" },
    ],
  };
}

function palworldModel(id) {
  return {
    id, supported: true, adapterId: "palworld", label: "Palworld", filePath: "Pal/Saved/Config/LinuxServer/PalWorldSettings.ini", sourceHash: "hash-pals",
    values: { ServerPlayerMaxNum: 32, ServerName: "Pals" },
    fields: [
      { key: "ServerPlayerMaxNum", label: "Max Players", type: "integer", category: "Players", restartRequired: true, currentValue: 32, defaultValue: 32 },
      { key: "ServerName", label: "Server Name", type: "string", category: "General", currentValue: "Pals", defaultValue: "" },
    ],
  };
}

function baseInstance(id, displayName, game) {
  return {
    id, displayName, game, type: "custom-command", workingDirectory: "data", executable: "run.sh", args: [],
    memoryLimit: "4G", restartPolicy: "never", startupTimeoutMs: 60000, shutdownTimeoutMs: 30000, autoStart: false,
  };
}

const CONFIG_INPUT_NAMES = ["displayName", "id", "workingDirectory", "executable", "jar", "memoryLimit", "args", "restartPolicy", "startupTimeoutMs", "shutdownTimeoutMs", "autoStart", "environment"];

function createRenderer() {
  const files = {
    survival: { "server.properties": "server-port=25565\nlevel-name=survival\n" },
    creative: { "server.properties": "server-port=25566\nlevel-name=creative\n" },
    pals: { "PalServer.sh": "#!/bin/sh\n" },
  };
  const models = {
    survival: minecraftModel("survival", 25565, "Survival MOTD", "hash-survival"),
    creative: minecraftModel("creative", 25566, "Creative MOTD", "hash-creative"),
    pals: palworldModel("pals"),
  };
  const calls = [];
  const toasts = [];
  const prompts = [];
  const settingsErrors = [];
  const api = {
    instances: {
      listFiles: async (id, filePath) => { calls.push(["listFiles", id, filePath]); return { currentPath: ".", entries: Object.keys(files[id] || {}).map((name) => ({ name, path: name, isDirectory: false, size: 10 })) }; },
      readFile: async (id, filePath) => { calls.push(["readFile", id, filePath]); return { path: filePath, supported: true, content: files[id][filePath], size: 10 }; },
      writeFile: async (id, filePath, content) => { calls.push(["writeFile", id, filePath, content]); files[id][filePath] = content; return {}; },
      getGameServerConfig: async (id) => { calls.push(["getGameServerConfig", id]); return JSON.parse(JSON.stringify(models[id])); },
      update: async (id, payload) => { calls.push(["update", id, payload]); return { instance: ctx.instances.find((instance) => instance.id === id) }; },
      saveGameServerConfig: async (id, payload) => { calls.push(["saveGameServerConfig", id, payload]); return { saved: true }; },
      saveMinecraftProperties: async (id, properties) => { calls.push(["saveMinecraftProperties", id, properties]); return {}; },
    },
  };

  const configInputs = CONFIG_INPUT_NAMES.map((name) => {
    const input = new El("input");
    input.dataset.instanceConfig = name;
    if (name === "autoStart") input.type = "checkbox";
    return input;
  });
  const saveFileButton = new El("button");
  const storage = new Map();
  const noop = () => {};
  const blank = () => "";

  const ctx = {
    console, JSON, Object, Array, Number, String, Boolean, Set, Map, Promise, Error,
    files, models, calls, toasts, prompts, settingsErrors, configInputs, confirmAnswer: true,
    instances: [baseInstance("survival", "Survival", "minecraft"), baseInstance("creative", "Creative", "minecraft"), baseInstance("pals", "Pals", "palworld")],
    // app.js state
    selectedInstanceId: null,
    activeInstanceTab: "overview",
    latestMinecraftProperties: {},
    instanceConfigSnapshot: "",
    instanceMinecraftSnapshot: "",
    populatedInstanceConfig: { instanceId: null, nodeId: null, key: "" },
    gameConfigState: { instanceId: null, loading: false, loaded: false, supported: false, error: "", model: null, values: {}, snapshot: "", query: "", showAdvanced: false, activeCategory: "", fieldErrors: {}, touchedSecrets: new Set() },
    instanceActionRequestInFlight: false,
    instanceCurrentFilePath: ".",
    selectedInstanceFilePath: null,
    instanceFilesInstanceId: null,
    instanceFilesRequestedInstanceId: null,
    openedInstanceFilePath: null,
    openedInstanceFileInstanceId: null,
    openedInstanceFileSavedContent: "",
    INSTANCE_ENV_MASK: "••••",
    INSTANCE_TAB_STORAGE_KEY: "anxos.instances.activeTab.v1",
    // DOM
    instanceConfigInputs: configInputs,
    minecraftPropertyInputs: [],
    instanceMinecraftSettings: null,
    instanceMinecraftSummary: null,
    instanceAdvancedInputs: [],
    instanceRawJson: null,
    instanceConfigSaveButton: new El("button"),
    instanceConfigCancelButton: new El("button"),
    instanceConfigDirtyLabel: new El("span"),
    gameConfigResetCurrentButton: new El("button"),
    gameConfigResetDefaultButton: new El("button"),
    gameConfigSaveRestartButton: new El("button"),
    instanceGameConfigManager: new El("section"),
    gameConfigFields: new El("div"),
    gameConfigSections: new El("div"),
    gameConfigTitle: new El("h3"),
    gameConfigMeta: new El("span"),
    gameConfigStatus: new El("span"),
    gameConfigAdvancedInput: new El("input"),
    instanceFilesList: new El("tbody"),
    instanceFilePathLabel: new El("span"),
    instanceFileEditor: Object.assign(new El("textarea"), { disabled: true }),
    instanceFileEditorName: Object.assign(new El("h3"), { textContent: "No file opened" }),
    instanceFileEditorMeta: Object.assign(new El("span"), { textContent: "Select a text/config file to preview it." }),
    instanceFileEditorState: Object.assign(new El("span"), { textContent: "Clean" }),
    instancesList: null,
    instanceTabs: [],
    instanceTabPanels: [],
    page: Object.assign(new El("section"), { scrollTop: 0 }),
    Model,
    document: {
      activeElement: null,
      createElement: (tag) => new El(tag),
      querySelector: (selector) => (selector === '[data-instance-file-action="save"]' ? saveFileButton : null),
      querySelectorAll: () => [],
    },
    window: {
      AnxServerViewModel: Model,
      queueMicrotask: (fn) => Promise.resolve().then(fn),
      localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
      confirm: () => true,
    },
    // app.js helpers the checked functions call
    findInstance: (id) => ctx.instances.find((instance) => instance.id === (id === undefined ? ctx.selectedInstanceId : id)) || null,
    getDesktopApiState: () => ({ hasInstances: true, api }),
    getSelectedNodeId: () => "local",
    getNodeRequestContext: () => ({}),
    isNodeRequestCurrent: () => true,
    createNodeActionContext: () => ({}),
    isNodeActionStillCurrent: () => true,
    getNodeScopedPayload: () => ({}),
    createSecurityConfirmation: async (options) => { prompts.push(options.title); return ctx.confirmAnswer; },
    showToast: (message) => toasts.push(message),
    showInstanceSettingsErrors: (errors) => settingsErrors.push(errors || {}),
    parseArgs: (value) => (value ? String(value).split(/\s+/) : []),
    isMinecraftInstance: (instance) => instance?.game === "minecraft",
    isServiceManagedInstance: () => false,
    refuseServiceManagedAction: () => false,
    isInstanceNotFoundError: () => false,
    handleMissingSelectedInstance: async () => {},
    getAgentErrorCode: (error) => error?.code,
    getAgentErrorMessage: (error, fallback) => `${fallback} ${error?.message || ""}`.trim(),
    getFileTypeInfo: () => ({ label: "Properties", badge: "CFG" }),
    formatBytes: (bytes) => `${bytes} B`,
    formatInstanceList: blank,
    renderInstanceFileRows: (entries) => { ctx.instanceFilesList.replaceChildren(...entries.map((entry) => Object.assign(new El("tr"), { textContent: entry.name }))); },
    renderInstanceNetwork: noop,
    renderMinecraftWorkspaceSummary: noop,
    getInstanceMetrics: () => null,
    refreshInstances: async () => {},
    storeLastInstanceId: noop,
    clearInstanceLogs: noop,
    refreshRestartSchedules: noop,
    updateInstanceActionButtons: noop,
    syncInstanceConsolePolling: noop,
    stopInstanceConsolePolling: noop,
    getActivePageName: () => "instances",
    refreshInstanceNetworkTab: noop,
    refreshInstancePerformanceTab: noop,
    refreshInstanceLogs: noop,
    refreshMinecraftPlayerFiles: noop,
    refreshInstanceMods: async () => {},
    applyServiceManagedRestrictions: noop,
    syncTabs: noop,
    render: noop,
    // Other surfaces that pick a server (notifications, Server Updates, the
    // console's Files button, Marketplace). showPage never closes the server
    // view, as in app.js.
    showPage: noop,
    selectNode: async () => {},
    getActiveConsoleInstance: () => ctx.findInstance("creative"),
    getMarketplaceStateForTemplate: () => ({ instances: [ctx.findInstance("creative")] }),
    workspaceSurface: "",
    runInstanceAction: async () => {},
    renderMarketplaceTemplates: noop,
    renderMarketplaceInstallSummary: noop,
    // setInstanceDetails' drawing helpers (not under test)
    releaseServiceManagedLocks: noop,
    getInstanceMetricsPlaceholder: blank,
    setField: noop,
    setInstanceDetail: noop,
    renderInstanceWorkspaceProfile: noop,
    renderFiveMSetupCard: noop,
    renderMinecraftPlayersPanel: noop,
    renderInstanceRestartSchedules: noop,
    formatInstanceCommandForDisplay: blank,
    formatInstanceAddressLabel: blank,
    getInstanceVersionMetadata: () => ({}),
    getInstancePrimaryPort: () => null,
    getInstancePorts: () => [],
    getInstanceOperation: () => null,
    getInstanceOperationLabel: blank,
    getInstanceStateClass: blank,
    getInstanceOperationFailureText: blank,
    formatInstanceCpu: blank,
    formatInstanceMemory: blank,
    formatInstanceValue: blank,
    getInstanceConnectionHost: blank,
    getInstanceNodeLabel: blank,
    formatDateTime: blank,
    getInstanceTypeLabel: blank,
    getInstanceOwnershipLabel: blank,
    getInstanceFailureReason: blank,
    formatDuration: blank,
    formatInstanceDisk: blank,
    formatInstancePorts: blank,
    instancesDetailsPanel: null,
    instanceWorkspaceCard: null,
    instanceAdoptRow: null,
    instanceAdoptButton: null,
    instanceAddressCopyButton: null,
  };
  vm.createContext(ctx);
  vm.runInContext(RENDERER_CODE, ctx);
  vm.runInContext("window.AnxServerView = { open, close, isOpen, confirmLeaveSettings, syncTabs, render: function () {}, markRestartRequired: function () {} };", ctx);
  ctx.run = (code) => vm.runInContext(code, ctx);
  ctx.input = (name) => configInputs.find((input) => input.dataset.instanceConfig === name);
  ctx.gameInput = (key) => ctx.gameConfigFields.descendants().find((node) => node.dataset.gameConfigField === key) || null;
  ctx.callsOf = (name) => calls.filter((call) => call[0] === name);
  return ctx;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

let checks = 0;
let failures = 0;
async function check(label, fn) {
  checks += 1;
  try {
    await fn();
    console.log(`PASS ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}\n     ${error && error.message ? error.message.split("\n")[0] : error}`);
  }
}

// ---- CSS helpers ------------------------------------------------------------------

// Flat list of { media, selectors, decls } for every style rule, one level of
// at-rule nesting (enough for styles.css).
function parseCssRules(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
  const rules = [];
  function walk(start, end, media) {
    let cursor = start;
    while (cursor < end) {
      const open = text.indexOf("{", cursor);
      if (open < 0 || open >= end) break;
      const prelude = text.slice(cursor, open).trim();
      const close = matchBlock(text, open);
      if (prelude.startsWith("@media") || prelude.startsWith("@supports")) walk(open + 1, close - 1, prelude);
      else if (!prelude.startsWith("@")) {
        const decls = {};
        text.slice(open + 1, close - 1).split(";").forEach((part) => {
          const colon = part.indexOf(":");
          if (colon > 0) decls[part.slice(0, colon).trim()] = part.slice(colon + 1).trim();
        });
        rules.push({ media, selectors: prelude.split(",").map((selector) => selector.replace(/\s+/g, " ").trim()), decls });
      }
      cursor = close;
    }
  }
  walk(0, text.length, "");
  return rules;
}

function topPadding(padding) {
  return String(padding || "").trim().split(/\s+/)[0];
}

// Resolves grid tracks written as minmax(<px>|0, <n>fr) for a container width.
function resolveTracks(template, width, gap) {
  const tracks = [...template.matchAll(/minmax\(\s*(\d+)(?:px)?\s*,\s*([\d.]+)fr\s*\)/g)].map((match) => ({ min: Number(match[1]), fr: Number(match[2]) }));
  assert.ok(tracks.length >= 2, `could not read grid tracks from "${template}"`);
  const available = width - gap * (tracks.length - 1);
  const flexible = new Set(tracks.map((_, index) => index));
  const sizes = tracks.map((track) => track.min);
  for (let pass = 0; pass < tracks.length; pass += 1) {
    const frTotal = [...flexible].reduce((sum, index) => sum + tracks[index].fr, 0);
    const fixed = tracks.reduce((sum, track, index) => sum + (flexible.has(index) ? 0 : sizes[index]), 0);
    const unit = Math.max(0, available - fixed) / frTotal;
    let clamped = false;
    [...flexible].forEach((index) => {
      if (tracks[index].fr * unit < tracks[index].min) { sizes[index] = tracks[index].min; flexible.delete(index); clamped = true; }
      else sizes[index] = tracks[index].fr * unit;
    });
    if (!clamped) break;
  }
  return { sizes, total: sizes.reduce((sum, size) => sum + size, 0) + gap * (tracks.length - 1), minimum: tracks.reduce((sum, track) => sum + track.min, 0) + gap * (tracks.length - 1) };
}

// ---- checks -------------------------------------------------------------------------

(async () => {
  await check("1 (ui-servers-1) the Files editor belongs to its server: switching clears it, a dirty file asks first, Save never writes into another server", async () => {
    const r = createRenderer();
    r.activeInstanceTab = "files";
    r.run('selectInstance("survival")');
    await r.run("refreshInstanceFiles()");
    await r.run('openInstanceTextFile("server.properties")');
    assert.strictEqual(r.openedInstanceFilePath, "server.properties");

    // A clean file: opening another server asks nothing and clears the editor.
    await r.run('openInstanceServerView("creative")');
    await flush();
    assert.strictEqual(r.selectedInstanceId, "creative");
    assert.deepStrictEqual(r.prompts, [], "a clean file must not ask before switching servers");
    assert.strictEqual(r.openedInstanceFilePath, null, "the editor must not keep Survival's file under Creative");
    assert.strictEqual(r.instanceFileEditorName.textContent, "No file opened");
    assert.strictEqual(r.instanceFileEditor.value, "", "Survival's content must not stay in the editor");
    assert.strictEqual(r.instanceFileEditor.disabled, true);
    assert.strictEqual(r.selectedInstanceFilePath, null, "a file selected on Survival must not stay selected (Rename/Delete) under Creative");
    r.instanceFileEditor.value += "motd=Creative builds\n";
    await r.run("saveInstanceTextFile()");
    assert.deepStrictEqual(r.callsOf("writeFile"), [], "Save must not write Survival's file into Creative");
    assert.ok(r.files.creative["server.properties"].includes("25566"), "Creative's server.properties keeps its own port");

    // The list reload path assigns the selection before selectInstance runs.
    const s = createRenderer();
    s.run('selectInstance("survival")');
    await s.run("refreshInstanceFiles()");
    await s.run('openInstanceTextFile("server.properties")');
    s.run('selectedInstanceId = "creative"; selectInstance("creative")');
    assert.strictEqual(s.openedInstanceFilePath, null, "a list reload that changes the server also clears the editor");

    // Save refuses a file opened on another server even if the selection moved
    // without selectInstance (computer switch, missing-server reset).
    const t = createRenderer();
    t.run('selectInstance("survival")');
    await t.run("refreshInstanceFiles()");
    await t.run('openInstanceTextFile("server.properties")');
    t.instanceFileEditor.value += "motd=edited\n";
    t.run('selectedInstanceId = "creative"');
    await t.run("saveInstanceTextFile()");
    assert.deepStrictEqual(t.callsOf("writeFile"), [], "Save must refuse a file that belongs to another server");

    // A dirty file asks first; "keep editing" stays on the server with the edit.
    const u = createRenderer();
    u.activeInstanceTab = "files";
    u.run('selectInstance("survival")');
    await u.run("refreshInstanceFiles()");
    await u.run('openInstanceTextFile("server.properties")');
    u.instanceFileEditor.value += "motd=unsaved\n";
    u.confirmAnswer = false;
    await u.run('openInstanceServerView("creative")');
    assert.deepStrictEqual(u.prompts, ["Discard unsaved file changes?"], "unsaved file edits must be confirmed before switching servers");
    assert.strictEqual(u.selectedInstanceId, "survival", "declining keeps the current server");
    assert.ok(u.instanceFileEditor.value.includes("motd=unsaved"), "declining keeps the edit");

    // Back to all servers with unsaved file edits asks too, and "Discard
    // Changes" really discards (reopening the server shows the saved text).
    u.page.dataset.serverView = "open";
    u.prompts.length = 0;
    assert.strictEqual(await u.run("close()"), false, "declining keeps the server open");
    assert.deepStrictEqual(u.prompts, ["Discard unsaved file changes?"], "Back with unsaved file edits asks first");
    assert.ok(u.instanceFileEditor.value.includes("motd=unsaved"), "declining keeps the edit");
    u.confirmAnswer = true;
    assert.strictEqual(await u.run("close()"), true);
    assert.strictEqual(u.instanceFileEditor.value, u.files.survival["server.properties"], "Discard puts the file back to its saved text");
    assert.strictEqual(u.run("hasDirtyInstanceFile()"), false);
  });

  await check("2 (ui-servers-2) clearing and refilling the Settings form leaves no phantom unsaved changes", async () => {
    const r = createRenderer();
    r.run('selectedInstanceId = "survival"; populateInstanceConfigForm(findInstance())');
    r.run("populateMinecraftProperties({})");
    assert.strictEqual(r.run("hasUnsavedInstanceSettings()"), false);
    r.run("populateInstanceConfigForm(null); populateInstanceConfigForm(findInstance())");
    assert.strictEqual(r.run("hasUnsavedInstanceSettings()"), false, "nothing was edited");
    assert.strictEqual(r.run("isInstanceConfigFormBusy()"), false);
    assert.strictEqual(r.instanceConfigDirtyLabel.textContent, "Saved");
    assert.strictEqual(r.instanceConfigSaveButton.disabled, true);

    const fresh = createRenderer();
    fresh.run('selectedInstanceId = "survival"; populateInstanceConfigForm(findInstance())');
    assert.strictEqual(fresh.run("hasUnsavedInstanceSettings()"), false, "a fresh form is clean before game settings load");
    assert.strictEqual(fresh.instanceConfigDirtyLabel.textContent, "Saved");
  });

  await check("3 (ui-servers-3) another server opened on Settings shows and saves its own game settings", async () => {
    const r = createRenderer();
    r.activeInstanceTab = "settings";
    await r.run('openInstanceServerView("survival")');
    await r.run("loadGameServerConfig()");
    assert.strictEqual(r.gameConfigTitle.textContent, "Minecraft game settings");
    assert.strictEqual(await r.run("close()"), true);
    await r.run('openInstanceServerView("pals")');
    await flush();
    assert.strictEqual(r.gameConfigState.model?.id, "pals", "Pals must not show Survival's game settings");
    assert.strictEqual(r.gameConfigTitle.textContent, "Palworld game settings");
    const playerInput = r.gameInput("ServerPlayerMaxNum") || (r.run('gameConfigState.activeCategory = "Players"; renderGameConfigPanel()'), r.gameInput("ServerPlayerMaxNum"));
    playerInput.value = "16";
    playerInput.dispatch("input");
    await r.run("saveInstanceConfiguration()");
    const sent = r.callsOf("saveGameServerConfig");
    assert.strictEqual(sent.length, 1, "the Palworld edit is saved");
    assert.deepStrictEqual([sent[0][1], sent[0][2].adapterId, sent[0][2].sourceHash], ["pals", "palworld", "hash-pals"]);

    // Startup: Settings is the stored tab and game settings loaded before any
    // server was selected; opening the first server loads its own.
    const s = createRenderer();
    s.activeInstanceTab = "settings";
    await s.run("loadGameServerConfig()");
    await s.run('openInstanceServerView("survival")');
    await flush();
    assert.strictEqual(s.gameConfigState.model?.id, "survival", "the first server opened on Settings loads its game settings");

    // Save never sends game settings loaded for another server.
    const t = createRenderer();
    t.run('selectInstance("survival")');
    await t.run("loadGameServerConfig()");
    t.run('selectedInstanceId = "pals"; gameConfigState.values["max-players"] = 40');
    await t.run("saveInstanceConfiguration()");
    assert.ok(!t.callsOf("saveGameServerConfig").some((call) => call[1] === "pals"), "Survival's adapter and hash must never be sent for Pals");
  });

  await check("4 (ui-servers-4) memory validation agrees with what Save accepts; an invalid edit is reported and still unsaved", async () => {
    const r = createRenderer();
    const normalize = (value) => { try { r.run(`normalizeMemoryLimit(${JSON.stringify(value)})`); return true; } catch { return false; } };
    for (const value of ["6GB", "4096MB", "4.5G", "4 G", "1T", "6G", "512M", "2048m", "lots"]) {
      const accepted = !Model.validateServerSettings({ memoryLimit: value }).memoryLimit;
      if (accepted) assert.ok(normalize(value), `validation accepts "${value}", so Save must accept it too`);
    }
    for (const value of ["6G", "512M", "2048m", "4096M"]) assert.strictEqual(Model.validateServerSettings({ memoryLimit: value }).memoryLimit, undefined, `"${value}" stays valid`);
    for (const value of ["6GB", "4096MB", "4.5G", "4 G", "1T"]) assert.strictEqual(Model.validateServerSettings({ memoryLimit: value }).memoryLimit, "Use a size such as 4G or 4096M.", `"${value}" is refused with the size hint`);

    r.run('selectedInstanceId = "survival"; populateInstanceConfigForm(findInstance())');
    r.input("memoryLimit").value = "6GB";
    assert.strictEqual(r.run("hasUnsavedInstanceSettings()"), true, "an invalid memory edit is still an unsaved edit");
    let rejected = null;
    await r.run("saveInstanceConfiguration()").catch((error) => { rejected = error; });
    assert.strictEqual(rejected, null, "Save must not fail silently");
    assert.deepStrictEqual(r.callsOf("update"), [], "nothing is sent for an invalid size");
    assert.ok(r.settingsErrors.some((errors) => errors.memoryLimit), "the memory field shows why");
  });

  await check("5 (ui-servers-6) Discard on leaving and the Discard button put every setting back", async () => {
    const r = createRenderer();
    r.activeInstanceTab = "settings";
    r.run('selectedInstanceId = "survival"; populateInstanceConfigForm(findInstance())');
    r.input("displayName").value = "Friends SMP";
    assert.strictEqual(r.run("hasUnsavedInstanceSettings()"), true);
    assert.strictEqual(await r.run('confirmLeaveSettings("leave Settings")'), true);
    r.run('activeInstanceTab = "console"; setInstanceDetails(findInstance()); activeInstanceTab = "settings"');
    assert.strictEqual(r.input("displayName").value, "Survival", "a discarded name edit must not come back");
    assert.strictEqual(r.run("hasUnsavedInstanceSettings()"), false);
    const before = r.prompts.length;
    await r.run('confirmLeaveSettings("leave Settings")');
    assert.strictEqual(r.prompts.length, before, "no prompt once the edit is discarded");

    const s = createRenderer();
    s.activeInstanceTab = "settings";
    s.run('selectInstance("survival")');
    await s.run("loadGameServerConfig()");
    s.run('gameConfigState.activeCategory = "Players"; renderGameConfigPanel()');
    const maxPlayers = s.gameInput("max-players");
    maxPlayers.value = "40";
    maxPlayers.dispatch("input");
    assert.strictEqual(s.run("isGameConfigDirty()"), true);
    s.run('gameConfigState.activeCategory = "Network"; renderGameConfigPanel()');
    s.run("discardButtonHandler()");
    assert.strictEqual(s.run("isGameConfigDirty()"), false, "Discard resets every game-settings section, not only the one shown");
    assert.strictEqual(s.gameConfigStatus.textContent, "Saved");
    s.run('gameConfigState.activeCategory = "Players"; renderGameConfigPanel()');
    assert.strictEqual(s.gameInput("max-players").value, "20");
  });

  await check("6 (instance-engine-3) a computer switch or list reload leaves no phantom unsaved state or old game settings", async () => {
    const r = createRenderer();
    r.activeInstanceTab = "settings";
    r.run('selectInstance("survival")');
    await r.run("loadGameServerConfig()");
    // renderInstancesUnavailable (computer switch, failed list load):
    r.run("selectedInstanceId = null; setInstanceDetails(null)");
    // renderInstancesSnapshot assigns the selection, then calls selectInstance:
    r.run('selectedInstanceId = "creative"; selectInstance("creative")');
    assert.strictEqual(r.run("hasUnsavedInstanceSettings()"), false);
    assert.strictEqual(r.instanceConfigDirtyLabel.textContent, "Saved");
    assert.notStrictEqual(r.gameConfigState.model?.id, "survival", "Survival's game settings must not stay on screen for Creative");
    await r.run('openInstanceServerView("creative")');
    await flush();
    assert.deepStrictEqual(r.prompts, [], "opening the server asks nothing");
    assert.strictEqual(await r.run('confirmLeaveSettings("go back to all servers")'), true);
    assert.deepStrictEqual(r.prompts, [], "going back asks nothing");
  });

  await check("7 (visual-core-1) after Discard on leaving, the next server opens with no prompt and its own game settings", async () => {
    const r = createRenderer();
    r.activeInstanceTab = "settings";
    await r.run('openInstanceServerView("survival")');
    await r.run("loadGameServerConfig()");
    r.run('gameConfigState.activeCategory = "Network"; renderGameConfigPanel()');
    const port = r.gameInput("server-port");
    port.value = "25599";
    port.dispatch("input");
    assert.strictEqual(await r.run("close()"), true);
    assert.deepStrictEqual(r.prompts, ["Discard unsaved settings?"]);
    assert.strictEqual(r.run("isGameConfigDirty()"), false, "the discarded game setting is gone");
    assert.strictEqual(r.run("hasUnsavedInstanceSettings()"), false);
    await r.run('openInstanceServerView("creative")');
    await flush();
    assert.strictEqual(r.prompts.length, 1, "no second prompt for the next server");
    assert.strictEqual(r.gameConfigState.model?.sourceHash, "hash-creative", "Creative shows its own game settings");
    assert.strictEqual(await r.run("close()"), true);
    await r.run('openInstanceServerView("survival")');
    await flush();
    r.run('gameConfigState.activeCategory = "Network"; renderGameConfigPanel()');
    assert.strictEqual(r.gameInput("server-port").value, "25565", "Survival shows its saved port again");
  });

  const cssRules = parseCssRules(cssSource);

  await check("8 (visual-core-6) the sticky server header is flush with the top of the scroll area and opaque", async () => {
    const headerSelector = '.page[data-page="instances"][data-server-view="open"] .instances-details-panel';
    const sticky = cssRules.filter((rule) => !rule.media && rule.selectors.includes(headerSelector) && rule.decls.position === "sticky");
    assert.strictEqual(sticky.length, 1, "one sticky header rule");
    const { decls } = sticky[0];
    assert.match(decls.top || "", /^calc\(\s*-1\s*\*\s*var\(--main-content-padding-top(?:,\s*0(?:px)?)?\)\s*\)$/, "the header sticks at the scroller's edge, above its top padding");
    const colors = [...String(decls.background || "").matchAll(/rgba?\(([^)]*)\)/g)].map((match) => match[1].split(",").map((part) => part.trim()));
    assert.ok(colors.length > 0, "the header has a painted background");
    colors.forEach((parts) => assert.ok(parts.length < 4 || Number(parts[3]) === 1, `header background must be opaque (got alpha ${parts[3]})`));
    // Every v1.9 .main-content padding (where the header is sticky, above
    // 760 px) publishes its top padding for the header.
    const scroller = 'html[data-ui-generation="v1.9"] .main-content';
    const paddings = cssRules.filter((rule) => rule.selectors.includes(scroller) && rule.decls.padding && !/max-width:\s*(?:620|760)px/.test(rule.media));
    assert.ok(paddings.length >= 2, "desktop and narrow v1.9 paddings found");
    paddings.forEach((rule) => assert.strictEqual(rule.decls["--main-content-padding-top"], topPadding(rule.decls.padding), `${rule.media || "base"} .main-content publishes its top padding`));
  });

  await check("9 (visual-core-8) the Files grid gives the list room and never outgrows its container", async () => {
    const gridRules = cssRules.filter((rule) => !rule.media && rule.selectors.includes('.page[data-page="instances"] .instance-files-grid') && rule.decls["grid-template-columns"]);
    const template = gridRules[gridRules.length - 1].decls["grid-template-columns"];
    const tableRule = cssRules.find((rule) => !rule.media && rule.selectors.includes(".instance-files-table") && rule.decls["min-width"]);
    const tableMin = Number.parseInt(tableRule.decls["min-width"], 10);
    // Grid width = window - 426 px (sidebar, paddings); two columns above 980 px.
    const narrow = resolveTracks(template, 981 - 426, 10);
    assert.ok(narrow.minimum <= 981 - 426, `the grid's minimum width (${narrow.minimum}px) must fit the narrowest two-column window`);
    const wide = resolveTracks(template, 1440 - 426, 10);
    assert.ok(wide.sizes[0] >= tableMin, `at 1440 px the list (${Math.round(wide.sizes[0])}px) fits the table (${tableMin}px)`);
    assert.ok(wide.sizes[1] >= 320, `at 1440 px the editor keeps a usable width (${Math.round(wide.sizes[1])}px)`);
    const mid = resolveTracks(template, 1100 - 426, 10);
    assert.ok(mid.total <= 1100 - 426 + 0.5, "at 1100 px nothing is clipped by the grid");
  });

  await check("10 (R6) a server picked from another surface loads its own Settings and Files, and unsaved edits ask first", async () => {
    const notSupported = "Game configuration is not supported for this instance yet.";
    // The view is open on Settings; a path that only calls selectInstance
    // (command palette, dashboard Start/Stop) picks another server.
    const r = createRenderer();
    r.activeInstanceTab = "settings";
    await r.run('openInstanceServerView("survival")');
    await flush();
    assert.strictEqual(r.gameConfigState.model?.id, "survival");
    r.run('selectInstance("creative")');
    await flush();
    assert.strictEqual(r.gameConfigState.model?.id, "creative", "Creative's game settings load while Settings is shown");
    assert.notStrictEqual(r.gameConfigStatus.textContent, notSupported);
    r.run('selectInstance("pals")');
    await flush();
    assert.strictEqual(r.gameConfigTitle.textContent, "Palworld game settings");
    // Cleared but not yet loaded for this server reads Loading, not "not supported".
    r.run("clearGameConfigState(); renderGameConfigPanel()");
    assert.strictEqual(r.gameConfigStatus.textContent, "Loading game settings...");

    // The view is open on Files: the new server's folder is listed.
    const f = createRenderer();
    f.activeInstanceTab = "files";
    await f.run('openInstanceServerView("survival")');
    await flush();
    await f.run('openInstanceTextFile("server.properties")');
    f.run('selectInstance("creative")');
    await flush();
    assert.ok(f.callsOf("listFiles").some((call) => call[1] === "creative"), "Creative's files are listed while Files is shown");
    assert.ok(f.instanceFilesList.querySelectorAll("tr").length > 0, "the Files list is not left empty");
    // With the view closed nothing is fetched in the background.
    const g = createRenderer();
    g.activeInstanceTab = "files";
    g.run('selectInstance("survival")');
    await g.run("refreshInstanceFiles()");
    g.run('selectInstance("creative")');
    await flush();
    assert.ok(!g.callsOf("listFiles").some((call) => call[1] === "creative"), "no background fetch while the server view is closed");

    // Unsaved file edits on the open server are asked about first by every
    // surface that picks another server.
    const callers = [
      ["notification open-instance", 'NOTIFICATION_ACTIONS["open-instance"].run({ relatedInstanceId: "creative" })'],
      ["notification openInstances", 'NOTIFICATION_ACTIONS.openInstances.run({ relatedInstanceId: "creative" })'],
      ["Server Updates row", 'openServerUpdateRow({ nodeId: "local", instanceId: "creative" })'],
      ["console Files", "openConsoleInstanceFiles()"],
      ["Marketplace Open Instance", 'runMarketplaceInstalledAction({ id: "paper" }, "open-instance")'],
    ];
    for (const [label, code] of callers) {
      const u = createRenderer();
      u.activeInstanceTab = "files";
      await u.run('openInstanceServerView("survival")');
      await flush();
      await u.run('openInstanceTextFile("server.properties")');
      u.instanceFileEditor.value += "motd=unsaved\n";
      u.confirmAnswer = false;
      await u.run(code);
      await flush();
      assert.deepStrictEqual(u.prompts, ["Discard unsaved file changes?"], `${label} asks before dropping unsaved file edits`);
      assert.strictEqual(u.selectedInstanceId, "survival", `${label}: declining keeps the current server`);
      assert.ok(u.instanceFileEditor.value.includes("motd=unsaved"), `${label}: declining keeps the edit`);
      u.confirmAnswer = true;
      await u.run(code);
      await flush();
      assert.strictEqual(u.selectedInstanceId, "creative", `${label}: accepting opens Creative`);
    }
    // Inline handlers (dashboard Start/Stop, command palette, endpoint picker
    // Manage) ask the same way before selecting.
    for (const marker of ["control.dataset.dashboardServerControl = quickAction;", 'showToast("That instance is no longer available.", "warning");', 'if (action === "manage") {']) {
      const at = appSource.indexOf(marker);
      assert.ok(at >= 0, `missing ${marker}`);
      const upToSelect = appSource.slice(at, appSource.indexOf("selectInstance(", at));
      assert.ok(upToSelect.includes("confirmSwitchInstance("), `the handler after ${marker} confirms before selecting`);
    }
  });

  await check("11 (Q2) a server picked off the servers page, or after a computer switch, still loads the open view's Settings and Files, once", async () => {
    // Pick Creative from another page while the view stays open on Survival:
    // whatever cleared the tab (selectInstance off the servers page, a
    // computer switch), the view loads Creative's own data once it is shown.
    const scenarios = [
      // Marketplace page: Open on an installed template selects first (on the
      // Marketplace page), then shows the servers page and selects again.
      ["Marketplace Open Instance", async (r) => {
        r.run('showPage("marketplace")');
        await r.run('runMarketplaceInstalledAction({ id: "paper" }, "open-instance")');
      }],
      // Dashboard: Start on Creative's card, then back to the servers page,
      // whose list reload re-selects the same server.
      ["dashboard Start, then open-instances", async (r) => {
        r.run('showPage("dashboard")');
        r.run('selectInstance("creative")');
        r.run('showPage("instances")');
        await r.run("refreshInstances()");
      }],
      // Server Updates row on another computer: selectNode clears both tabs
      // (resetNodeScopedRendererState) before the row's server is selected.
      ["Server Updates row on another computer", async (r) => {
        r.run('showPage("nodes")');
        await r.run('openServerUpdateRow({ nodeId: "remote", instanceId: "creative" })');
      }],
    ];
    const stage = (tab) => {
      const r = createRenderer();
      r.activePage = "instances";
      r.nodeId = "local";
      r.getActivePageName = () => r.activePage;
      r.showPage = (name) => { r.activePage = name; };
      r.getSelectedNodeId = () => r.nodeId;
      r.selectNode = async (nodeId) => { r.nodeId = nodeId; r.run("selectedInstanceId = null; resetInstanceFileEditor(); clearGameConfigState()"); };
      // renderInstancesSnapshot re-selects the current server after a reload.
      r.refreshInstances = async () => { r.run("if (selectedInstanceId) selectInstance(selectedInstanceId)"); };
      r.activeInstanceTab = tab;
      return r;
    };
    const loadsFor = (r, name, id) => r.callsOf(name).filter((call) => call[1] === id).length;
    for (const [label, pick] of scenarios) {
      const s = stage("settings");
      await s.run('openInstanceServerView("survival")');
      await flush();
      assert.strictEqual(s.gameConfigState.model?.id, "survival");
      await pick(s);
      await flush();
      assert.strictEqual(s.selectedInstanceId, "creative", `${label}: Creative is selected`);
      assert.strictEqual(s.gameConfigState.model?.id, "creative", `${label}: Creative's game settings load on the open Settings tab`);
      assert.notStrictEqual(s.gameConfigStatus.textContent, "Loading game settings...", `${label}: Settings is not left loading forever`);
      const settingsLoads = loadsFor(s, "getGameServerConfig", "creative");
      for (let poll = 0; poll < 3; poll += 1) s.run('selectInstance("creative")');
      s.run('showPage("instances")');
      await s.run("refreshInstances()");
      await flush();
      assert.strictEqual(loadsFor(s, "getGameServerConfig", "creative"), settingsLoads, `${label}: list polls do not reload game settings that are already Creative's`);

      const f = stage("files");
      await f.run('openInstanceServerView("survival")');
      await flush();
      await pick(f);
      await flush();
      assert.ok(loadsFor(f, "listFiles", "creative") > 0, `${label}: Creative's files are listed on the open Files tab`);
      assert.ok(f.instanceFilesList.querySelectorAll("tr").length > 0, `${label}: the Files list is not left empty`);
      const fileLoads = loadsFor(f, "listFiles", "creative");
      for (let poll = 0; poll < 3; poll += 1) f.run('selectInstance("creative")');
      await flush();
      assert.strictEqual(loadsFor(f, "listFiles", "creative"), fileLoads, `${label}: list polls do not relist Creative's files`);
    }

    // A failed load is not retried by every list poll (no toast per poll),
    // and a load still in flight is not started a second time.
    const e = stage("files");
    await e.run('openInstanceServerView("survival")');
    await flush();
    const listFiles = e.run("getDesktopApiState().api.instances.listFiles");
    e.run("getDesktopApiState().api.instances").listFiles = async (id, filePath) => { e.calls.push(["listFiles", id, filePath]); throw new Error("offline"); };
    e.run('showPage("marketplace")');
    await e.run('runMarketplaceInstalledAction({ id: "paper" }, "open-instance")');
    await flush();
    assert.strictEqual(loadsFor(e, "listFiles", "creative"), 1, "Creative's files are requested once");
    for (let poll = 0; poll < 3; poll += 1) e.run('selectInstance("creative")');
    await flush();
    assert.strictEqual(loadsFor(e, "listFiles", "creative"), 1, "a failed listing is not retried on every poll");
    assert.strictEqual(e.toasts.length, 1, "one error toast, not one per poll");
    // Switching away and back (a real selection change) asks again.
    e.run("getDesktopApiState().api.instances").listFiles = listFiles;
    e.run('selectInstance("pals"); selectInstance("creative")');
    await flush();
    assert.ok(e.instanceFilesList.querySelectorAll("tr").length > 0, "switching back lists Creative's files");

    const g = stage("settings");
    await g.run('openInstanceServerView("survival")');
    await flush();
    g.run('showPage("marketplace")');
    await g.run('runMarketplaceInstalledAction({ id: "paper" }, "open-instance")');
    for (let poll = 0; poll < 3; poll += 1) g.run('selectInstance("creative")');
    await flush();
    assert.strictEqual(loadsFor(g, "getGameServerConfig", "creative"), 1, "game settings in flight are not requested again by polls");

    // Returning to the servers page reloads a stale tab even when no list
    // reload re-selects the server (a failed list load).
    const pageSource = extractFunction(appSource, "showPage");
    const instancesBranch = pageSource.slice(pageSource.indexOf('if (safePageName === "instances") {'));
    const branch = instancesBranch.slice(0, matchBlock(instancesBranch, instancesBranch.indexOf("{")));
    assert.ok(/reloadStaleServerViewTab\(\)/.test(branch), "showPage(\"instances\") reloads the open view's stale tab");
  });

  await check("12 (R3-review) a listing for another server never keeps the open file, so Save cannot write it there", async () => {
    // Survival's server.properties is open (clean) on the Files tab. Another
    // surface assigns Creative directly and shows the servers page, which
    // reloads the stale tab before (or without) any list reload re-selecting:
    // the notification "Open Instance" action, Marketplace resume or install.
    const stageFiles = async () => {
      const r = createRenderer();
      r.activePage = "instances";
      r.getActivePageName = () => r.activePage;
      // As app.js: showPage("instances") reloads the open view's stale tab and
      // then refreshes the list. Here the list refresh does nothing (in flight,
      // backing off, or failed), so selectInstance never runs again.
      r.showPage = (name) => { r.activePage = name; if (name === "instances") r.run("reloadStaleServerViewTab && reloadStaleServerViewTab()"); };
      r.refreshInstances = async () => {};
      r.activeInstanceTab = "files";
      await r.run('openInstanceServerView("survival")');
      await flush();
      await r.run("refreshInstanceFiles()");
      await r.run('openInstanceTextFile("server.properties")');
      assert.strictEqual(r.run("openedInstanceFilePath"), "server.properties", "Survival's file is open");
      return r;
    };
    const assertNoCrossWrite = async (r, label) => {
      assert.notStrictEqual(r.run("instanceFileEditor.value"), r.files.survival["server.properties"], `${label}: the editor no longer shows Survival's file`);
      assert.strictEqual(r.run("openedInstanceFilePath"), null, `${label}: no file is open for Creative`);
      r.run('instanceFileEditor.value = instanceFileEditor.value + "motd=edited\\n"; syncInstanceFileDirtyState()');
      await r.run("saveInstanceTextFile()");
      const writes = r.calls.filter((call) => call[0] === "writeFile" && call[1] === "creative");
      assert.deepStrictEqual(writes, [], `${label}: nothing is written into Creative`);
      assert.strictEqual(r.files.creative["server.properties"], "server-port=25566\nlevel-name=creative\n", `${label}: Creative keeps its own port and world`);
    };

    const a = await stageFiles();
    a.run('selectedInstanceId = "creative"; showPage("instances")');
    await flush();
    await assertNoCrossWrite(a, "notification Open Instance");

    // Any direct listing for another server (Refresh, Up, upload) drops the
    // other server's folder and open file before it lists, from the root.
    const b = await stageFiles();
    b.run('instanceCurrentFilePath = "plugins"');
    b.run('selectedInstanceId = "creative"');
    await b.run("refreshInstanceFiles()");
    const lastList = b.calls.filter((call) => call[0] === "listFiles").pop();
    assert.deepStrictEqual(lastList, ["listFiles", "creative", "."], "Creative is listed from its root, not Survival's subfolder");
    await assertNoCrossWrite(b, "direct listing");
  });

  if (failures) {
    console.error(`server-page-fixes-smoke: ${failures} of ${checks} checks failed`);
    process.exitCode = 1;
    return;
  }
  console.log(`server-page-fixes-smoke passed (${checks} checks)`);
})().catch((error) => {
  console.error(`FAIL ${error && error.message ? error.message : error}`);
  if (error && error.stack) console.error(error.stack.split("\n").slice(1, 4).join("\n"));
  process.exitCode = 1;
});
