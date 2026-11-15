#!/usr/bin/env node
"use strict";

// Regression checks for the app shell fixes (node drawer, node freshness on
// other pages, Home tiles, Settings General, Activity, onboarding, node
// health checks, Docker page layout, Routes modal).
//   S1 ui-shell-1     the node drawer keeps its own computer's health after a
//                     health refresh, and "Test connection" tests that computer
//   S2 ui-shell-2     node health is re-checked (fleet summary) on every
//                     visible page, not only Home and Computers
//   S3 ui-shell-3     Home "Servers running" uses the live list when the fleet
//                     roll-up does not cover every computer
//   S4 ui-shell-4     Default page and Restore previous page decide the
//                     startup page
//   S5 ui-shell-5     a recovered incident is annotated " — recovered" once
//   S6 ui-shell-6     saving a setting does not reset onboarding progress,
//                     setup type or dismissed tips
//   S7 visual-core-2  Home "Players online" reads the numeric player count
//   S8 visual-core-3  a health check of a connected computer does not record
//                     it as "connecting" while the probe is in flight
//   S9 visual-core-5  the Docker workspace collapses to one column before it
//                     can overflow the content area
//   S10 visual-core-7 the Routes modal derives the main address state from the
//                     computer's connection when there are no fallback routes
//   S11 R12           Home and dashboard cards use a Players-tab reading only
//                     while it is recent and from the selected computer
//   S12 R13           a message that already contains " — recovered" keeps a
//                     single trailing suffix across syncs
// Renderer code runs in node:vm against fake DOM objects; the node service
// runs against a temporary config folder with the Agent client stubbed, so no
// request leaves this process.
// Run: node scripts/shell-fixes-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname, "..");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-shell-fixes-"));
process.env.ANXHUB_CONFIG_DIR = tempDir;
process.env.AGENT_URL = "http://127.0.0.1:9";

const appSource = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const homeDashboardSource = fs.readFileSync(path.join(ROOT, "src", "renderer", "homeDashboard.js"), "utf8");
const homeDashboardModelSource = fs.readFileSync(path.join(ROOT, "src", "shared", "homeDashboardModel.js"), "utf8");
const stylesSource = fs.readFileSync(path.join(ROOT, "styles.css"), "utf8");

// ---------------------------------------------------------------------------
// Source extraction
// ---------------------------------------------------------------------------

// Returns the index just past the bracket that closes the one at `start`,
// skipping strings, template literals and comments.
function skipBalanced(source, start, open, close) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      index = source.indexOf("\n", index);
      continue;
    }
    if (char === "/" && next === "*") {
      index = source.indexOf("*/", index) + 1;
      continue;
    }
    if (char === "\"" || char === "'") {
      index += 1;
      while (source[index] !== char) {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      continue;
    }
    if (char === "`") {
      index += 1;
      while (source[index] !== "`") {
        if (source[index] === "\\") index += 1;
        else if (source[index] === "$" && source[index + 1] === "{") index = skipBalanced(source, index + 1, "{", "}") - 1;
        index += 1;
      }
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw new Error(`Unbalanced ${open}${close} from ${start}.`);
}

function extractFunction(name, { optional = false, source = appSource } = {}) {
  const match = new RegExp(`^(?:async\\s+)?function\\s+${name}\\s*\\(`, "m").exec(source);
  if (!match) {
    if (optional) return "";
    throw new Error(`app.js has no function ${name}.`);
  }
  const signatureEnd = skipBalanced(source, match.index + match[0].length - 1, "(", ")");
  const bodyStart = source.indexOf("{", signatureEnd);
  return source.slice(match.index, skipBalanced(source, bodyStart, "{", "}"));
}

function extractFunctions(names, options) {
  return names.map((name) => extractFunction(name, options)).join("\n\n");
}

// ---------------------------------------------------------------------------
// Fake DOM
// ---------------------------------------------------------------------------

class FakeElement {
  constructor(tagName = "div") {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.className = "";
    this._text = "";
    this.hidden = false;
    this.style = {};
    this.listeners = {};
    this.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  }

  get textContent() {
    return this._text + this.children.map((child) => child.textContent).join(" ");
  }

  set textContent(value) {
    this._text = String(value ?? "");
    this.children = [];
  }

  append(...nodes) {
    nodes.forEach((node) => this.children.push(typeof node === "string" ? Object.assign(new FakeElement("#text"), { _text: node }) : node));
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }

  removeEventListener() {}

  remove() {}

  querySelector() {
    return null;
  }

  querySelectorAll() {
    return [];
  }

  findAll(predicate) {
    const found = [];
    const walk = (element) => {
      element.children.forEach((child) => {
        if (predicate(child)) found.push(child);
        walk(child);
      });
    };
    walk(this);
    return found;
  }
}

function createFakeDocument(overrides = {}) {
  return {
    readyState: "complete",
    hidden: false,
    body: new FakeElement("body"),
    createElement: (tagName) => new FakeElement(tagName),
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
    ...overrides,
  };
}

const checks = [];
function check(id, title, fn) {
  checks.push({ id, title, fn });
}

// ---------------------------------------------------------------------------
// S1 ui-shell-1: the node drawer owns its computer
// ---------------------------------------------------------------------------

check("S1", "the node drawer keeps showing and acting on the computer it was opened for", async () => {
  const code = extractFunctions([
    "getOpenNodeDetailsId",
    "refreshNodeHealth",
    "renderNodeHealth",
    "getSharedNodeHealthModel",
    "runNodeHealthAction",
    "testSelectedNode",
    "testNodeById",
    "buildConnectivityHealth",
    "buildAgentHealth",
  ].filter((name) => name !== "getOpenNodeDetailsId" || /function getOpenNodeDetailsId\(/.test(appSource)));
  const log = { tested: [], toasts: [] };
  const nodes = {
    ovh: { id: "ovh", kind: "agent", displayName: "OVH", online: true },
    anxlab: { id: "anxlab", kind: "agent", displayName: "Anxlab", online: false },
  };
  const context = {
    console,
    log,
    nodes,
    selectedId: "ovh",
    overviewRows: [],
    nodeHealthStatus: new FakeElement("span"),
    nodeHealthUpdated: new FakeElement("p"),
    nodeHealthOverview: new FakeElement("div"),
    nodeHealthCategories: null,
    nodeHealthIssues: null,
    nodeDetailsModal: Object.assign(new FakeElement("section"), { hidden: false }),
    nodeDetailsId: null,
    nodeHealthGeneration: 0,
    nodeHealthState: null,
    nodeHealthSnapshotCache: new Map(),
    NODE_HEALTH_RESOURCE_THRESHOLDS: { latencyWarningMs: 500 },
    NODE_HEALTH_STALE_MS: 60000,
  };
  const prelude = `
    function getSelectedNodeId() { return selectedId; }
    function getSelectedNode() { return nodes[selectedId]; }
    function getNodePickerNodes() { return Object.values(nodes); }
    function getNodeHealthCacheKey(node) { return "k:" + node.id; }
    function buildNodeHealthModel(node = getSelectedNode()) {
      const bad = !node.online;
      return { nodeId: node.id, cacheKey: "k:" + node.id, nodeName: node.displayName, state: bad ? "Degraded" : "Healthy",
        issueCount: bad ? 1 : 0, staleCount: 0, historicalIssueCount: 0, categories: [], currentIssueCategories: [], updatedAt: 0 };
    }
    function syncNodeHealthNotifications() {}
    function renderNodeConnectivity() {}
    function nodeHealthTone(state) { return String(state).toLowerCase(); }
    function normalizeNodeHealthState(state) { return state; }
    function formatHealthCheckedAt() { return "now"; }
    function getNodeHealthBreakdown() { return { critical: 0, warnings: 0, healthy: 0, unknown: 0, notTested: 0, unavailable: 0 }; }
    function renderSecuritySummaryGrid(target, rows) { overviewRows = rows; }
    function getDesktopApiState() { return { hasNodes: true, api: { nodes: { test: async (id) => { log.tested.push(id); return { connected: nodes[id].online }; } } } }; }
    async function refreshNodes() { refreshNodeHealth(); }
    function showToast(message) { log.toasts.push(message); }
    function getFriendlyErrorMessage(message) { return message; }
    function testAgentConnection() {}
    function showPage() {}
    function openNodeDetails() {}
    function getNodeVisualState(node) { return node.online ? "online" : "offline"; }
    function getNodeConnectionState(node) { return { state: node.online ? "Connected" : "Offline", primary: node.online ? "Connected" : "Offline", secondary: "Agent" }; }
    function getCurrentAgentHealthTarget() { return { nodeId: "ovh", latencyMs: 999, lastHeartbeat: null }; }
    function getHealthRuntime() { return { latencyMs: 999 }; }
    function isNodeHealthStale() { return false; }
    function buildNodeHealthCategory(category) { return category; }
    var agentControlState = null, agentControlMessage = null, agentControlLastRuntimeSnapshot = null;
    function getAgentRuntime() { return null; }
    function isAgentTargetRunning() { return false; }
    function formatAgentProcess() { return "unknown"; }
  `;
  vm.createContext(context);
  vm.runInContext(`${prelude}\n${code}`, context, { filename: "app.js (extracted)" });
  const nodeRow = () => (context.overviewRows.find((row) => row[0] === "Node") || [])[1];

  // openNodeDetails("anxlab") while OVH is selected: the non-selected branch.
  context.nodeDetailsId = "anxlab";
  context.renderNodeHealth(context.getSharedNodeHealthModel(nodes.anxlab));
  assert.strictEqual(context.nodeHealthStatus.textContent, "Degraded");

  // The Computers page 5 s poll: refreshNodes() -> refreshNodeHealth().
  const selectedHealth = context.refreshNodeHealth();
  assert.strictEqual(selectedHealth.nodeId, "ovh", "refreshNodeHealth still returns the selected computer's health");
  assert.strictEqual(context.nodeHealthState.nodeId, "ovh", "the selected computer's health state is kept");
  assert.strictEqual(context.nodeHealthStatus.textContent, "Degraded", "the Anxlab drawer must not switch to OVH's health");
  assert.strictEqual(nodeRow(), "Anxlab", "the drawer overview names the computer it was opened for");

  // "Test connection" in the Anxlab drawer tests Anxlab.
  await context.runNodeHealthAction("test-node");
  assert.deepStrictEqual(log.tested, ["anxlab"], "Test connection in the Anxlab drawer must test Anxlab");
  assert.notStrictEqual(log.toasts[0], "Node connected.", "an offline computer must not be reported connected");
  assert.strictEqual(context.nodeHealthStatus.textContent, "Degraded");

  // A non-selected computer's connectivity card only offers what acts on it
  // and never borrows the selected computer's latency.
  const connectivity = context.buildConnectivityHealth(nodes.anxlab);
  const actionIds = (category) => JSON.parse(JSON.stringify(category.actions.map((entry) => entry.action)));
  assert.deepStrictEqual(actionIds(connectivity), ["test-node"], "Ping Agent / Open Agent Control act on the selected computer only");
  assert.match(connectivity.evidence, /Latency unavailable/, "latency belongs to the selected computer only");
  const selectedConnectivity = context.buildConnectivityHealth(nodes.ovh);
  assert.deepStrictEqual(actionIds(selectedConnectivity), ["test-node", "ping-agent", "open-agent-control"]);
  const agent = context.buildAgentHealth(nodes.anxlab);
  assert.deepStrictEqual(actionIds(agent), ["test-node"], "the Agent card of another computer does not open the selected computer's Agent Control");
  assert.strictEqual(agent.action, "test-node");
  assert.deepStrictEqual(actionIds(context.buildAgentHealth(nodes.ovh)), ["open-agent-control", "reconnect-agent", "agent-diagnostics"]);

  // With the drawer closed, health actions act on the selected computer.
  context.nodeDetailsModal.hidden = true;
  log.tested.length = 0;
  await context.runNodeHealthAction("test-node");
  assert.deepStrictEqual(log.tested, ["ovh"]);
  context.refreshNodeHealth();
  assert.strictEqual(context.nodeHealthStatus.textContent, "Healthy");
});

// ---------------------------------------------------------------------------
// Home dashboard harness (S2, S3, S7)
// ---------------------------------------------------------------------------

function loadHomeDashboard(globals = {}) {
  let tick = null;
  const clock = { now: 1_000_000_000_000 };
  const RealDate = Date;
  class FakeDate extends RealDate {
    static now() {
      return clock.now;
    }
  }
  const document = createFakeDocument({ hidden: globals.hidden === true });
  const context = {
    console,
    Date: FakeDate,
    document,
    localStorage: { getItem: () => null, setItem() {} },
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval() {},
    setTimeout: () => 0,
    nodesState: { nodes: [] },
    fleetState: null,
    getSelectedNodeId: () => "",
    getNodeVisualState: () => "online",
    getNodeConnectionState: () => null,
    getNodeIdentity: () => ({}),
    getInstances: () => [],
    getInstanceNodeLabel: () => "",
    isInstanceRunning: (instance) => instance.state === "running",
    getMinecraftSummaryData: () => null,
    isInstancesSnapshotCurrentForSelectedNode: () => true,
    getFriendlyDashboardState: () => null,
    getActivePageName: () => "dashboard",
    getDesktopApiState: () => ({ api: {} }),
    refreshFleetSummary: () => Promise.resolve(),
    ...globals,
  };
  delete context.hidden;
  context.window = context;
  vm.createContext(context);
  vm.runInContext(homeDashboardModelSource, context, { filename: "homeDashboardModel.js" });
  const exposed = homeDashboardSource.replace("root.AnxHomeDashboard = {", "root.__buildState = buildState;\n  root.AnxHomeDashboard = {");
  assert.notStrictEqual(exposed, homeDashboardSource, "homeDashboard.js changed shape: cannot reach buildState");
  vm.runInContext(exposed, context, { filename: "homeDashboard.js" });
  return { context, tick: () => tick && tick(), advance: (ms) => { clock.now += ms; } };
}

// ---------------------------------------------------------------------------
// S2 ui-shell-2: node freshness on every visible page
// ---------------------------------------------------------------------------

check("S2", "node health is re-checked on every visible page at the fleet interval", () => {
  for (const page of ["dashboard", "nodes", "settings", "notifications", "operations", "instances"]) {
    let calls = 0;
    const home = loadHomeDashboard({ getActivePageName: () => page, refreshFleetSummary: () => { calls += 1; return Promise.resolve(); } });
    home.tick();
    assert.strictEqual(calls, 1, `${page}: the first tick re-checks node health`);
    home.advance(5000);
    home.tick();
    assert.strictEqual(calls, 1, `${page}: re-checks stay at the 30 s fleet interval`);
    home.advance(31000);
    home.tick();
    assert.strictEqual(calls, 2, `${page}: node health is re-checked again after 30 s`);
  }
  let hiddenCalls = 0;
  const hidden = loadHomeDashboard({ hidden: true, getActivePageName: () => "settings", refreshFleetSummary: () => { hiddenCalls += 1; } });
  hidden.tick();
  hidden.advance(31000);
  hidden.tick();
  assert.strictEqual(hiddenCalls, 0, "a hidden window does not poll");
});

// ---------------------------------------------------------------------------
// S3 ui-shell-3: Home "Servers running"
// ---------------------------------------------------------------------------

check("S3", "Home Servers running uses fleet counts only when they cover every computer", () => {
  // (a) Local-only mode: the application host is never in the fleet roll-up.
  const hostNode = { id: "application-host", kind: "application-host", displayName: "This PC" };
  let home = loadHomeDashboard({
    nodesState: { nodes: [hostNode] },
    getSelectedNodeId: () => "application-host",
    getInstances: () => [{ id: "mc", state: "running" }, { id: "pal", state: "running" }],
    fleetState: { nodes: [{ nodeId: "application-host", kind: "application-host", instances: { available: false } }], totals: { instanceCount: 0, runningInstanceCount: 0, inventoryUnavailableNodes: 1 } },
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(home.context.__buildState().overview.servers)), { value: "2", detail: "of 2 running" }, "local-only mode counts the local servers");

  // (b) The only Agent computer is offline.
  home = loadHomeDashboard({
    nodesState: { nodes: [{ id: "ovh", kind: "agent", displayName: "OVH" }] },
    getSelectedNodeId: () => "ovh",
    getNodeVisualState: () => "offline",
    getInstances: () => [{ id: "x", state: "running" }],
    fleetState: { nodes: [{ nodeId: "ovh", kind: "agent", instances: { available: false } }], totals: { instanceCount: 0, runningInstanceCount: 0, inventoryUnavailableNodes: 1 } },
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(home.context.__buildState().overview.servers)), { value: "—", detail: "Computer not connected" }, "an offline computer does not read as 0 of 0");

  // (c) Every computer is covered: fleet counts are used for the others and
  // the selected computer's live list replaces its 30 s old fleet count.
  home = loadHomeDashboard({
    nodesState: { nodes: [{ id: "ovh", kind: "agent", displayName: "OVH" }, { id: "anxlab", kind: "agent", displayName: "Anxlab" }] },
    getSelectedNodeId: () => "ovh",
    getInstances: () => [{ id: "a", state: "running" }, { id: "b", state: "stopped" }],
    fleetState: {
      nodes: [
        { nodeId: "ovh", kind: "agent", instances: { available: true, instanceCount: 2, runningInstanceCount: 0 } },
        { nodeId: "anxlab", kind: "agent", instances: { available: true, instanceCount: 3, runningInstanceCount: 2 } },
      ],
      totals: { instanceCount: 5, runningInstanceCount: 2, inventoryUnavailableNodes: 0 },
    },
  });
  assert.deepStrictEqual(JSON.parse(JSON.stringify(home.context.__buildState().overview.servers)), { value: "3", detail: "of 5 running" }, "fleet counts for other computers plus the live list for the selected one");
});

// ---------------------------------------------------------------------------
// S4 ui-shell-4: startup page
// ---------------------------------------------------------------------------

check("S4", "Default page and Restore previous page decide the startup page", () => {
  const statement = /const startupPage = ([\s\S]*?);\s*showPage\(startupPage\);/.exec(appSource);
  assert(statement, "applySettings must still choose a startupPage");
  const pages = ["dashboard", "instances", "files", "settings", "security", "nodes", "console"].map((page) => ({ dataset: { page } }));
  const storage = new Map();
  const context = {
    pages,
    DEFAULT_SETTINGS: { "general.defaultPage": "dashboard" },
    LAST_PAGE_STORAGE_KEY: "anxos.navigation.lastPage.v1",
    window: { localStorage: { getItem: (key) => (storage.has(key) ? storage.get(key) : null), setItem: (key, value) => storage.set(key, String(value)) } },
    shouldRequireAccountBeforeOnboarding: () => false,
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunctions(["getSafePageName", "readLastPageName"])}\n${extractFunction("resolveStartupPage", { optional: true })}\nfunction startupPageFor(settings) { return ${statement[1]}; }`, context, { filename: "app.js (extracted)" });
  const startup = (settings, lastPage) => {
    storage.clear();
    if (lastPage !== undefined) storage.set(context.LAST_PAGE_STORAGE_KEY, lastPage);
    return context.startupPageFor(settings);
  };
  assert.strictEqual(startup({ "general.defaultPage": "instances" }), "instances", "a fresh profile opens the Default page");
  assert.strictEqual(startup({ "general.defaultPage": "instances", "general.restorePreviousPage": false }, "settings"), "instances", "Restore previous page off opens the Default page");
  assert.strictEqual(startup({ "general.defaultPage": "instances", "general.restorePreviousPage": true }, "files"), "files", "Restore previous page on reopens the last page");
  assert.strictEqual(startup({ "general.defaultPage": "instances" }, "files"), "files", "restoring is the default");
  assert.strictEqual(startup({ "general.defaultPage": "instances" }, "nope"), "instances", "an unknown stored page falls back to the Default page");
  assert.strictEqual(startup({ "general.defaultPage": "nope", "general.restorePreviousPage": false }), "dashboard", "an unknown Default page falls back to Home");
  context.shouldRequireAccountBeforeOnboarding = () => true;
  assert.strictEqual(startup({ "general.defaultPage": "instances" }, "files"), "security", "the account gate still wins");
});

// ---------------------------------------------------------------------------
// S5 ui-shell-5: recovered incidents
// ---------------------------------------------------------------------------

check("S5", "a recovered incident is annotated once and re-syncs do not rewrite it", () => {
  const context = {
    console,
    NOTIFICATION_MAX_MESSAGE_LENGTH: 520,
    NOTIFICATION_ACTIONS: {},
    NOTIFICATION_SEVERITIES: ["info", "success", "warning", "error", "critical"],
    OPERATIONAL_NOTIFICATION_DEDUP_PREFIX: "op:",
    OPERATIONAL_NOTIFICATION_CATEGORY_MAP: { agent: "Agent" },
    notificationState: { items: [] },
    persisted: 0,
  };
  vm.createContext(context);
  vm.runInContext(`
    function loadNotificationHistory() {}
    function persistNotificationHistory() { persisted += 1; }
    function renderNotificationCenter() {}
    function getFriendlyOperationText(value) { return String(value || ""); }
    function createNotification(entry) { notificationState.items.push({ ...entry }); }
    ${(/^const RECOVERED_NOTIFICATION_SUFFIX = .*;$/m.exec(appSource) || [""])[0]}
    ${extractFunction("stripRecoveredSuffix", { optional: true })}
    ${extractFunctions(["sanitizeNotificationText", "normalizeNotificationSeverity", "mapOperationalNotificationCategory", "mergeOperationalNotificationEvents"])}
  `, context, { filename: "app.js (extracted)" });
  const incident = { id: "evt-1", severity: "critical", category: "agent", title: "OVH disconnected", message: "OVH is not reachable." };
  context.mergeOperationalNotificationEvents([incident]);
  const resolved = { ...incident, resolvedAt: "2026-11-14T10:00:00.000Z" };
  const recovery = { id: "evt-2", severity: "info", category: "agent", title: "OVH reconnected", message: "OVH is reachable again." };
  context.persisted = 0;
  for (let sync = 0; sync < 3; sync += 1) context.mergeOperationalNotificationEvents([recovery, resolved]);
  const item = context.notificationState.items.find((entry) => entry.dedupKey === "op:evt-1");
  assert.strictEqual(item.message, "OVH is not reachable. — recovered", "the suffix is added exactly once");
  assert.strictEqual(item.resolved, true);
  assert.strictEqual(context.persisted, 1, "only the first sync that sees the recovery saves the history");

  // A record an older build already polluted is repaired.
  item.message = "OVH is not reachable. — recovered — recovered — recovered";
  context.mergeOperationalNotificationEvents([resolved]);
  assert.strictEqual(item.message, "OVH is not reachable. — recovered", "repeated suffixes from older builds collapse to one");

  // ...including one that reached the 520-character cap mid-suffix.
  item.message = `OVH is not reachable.${" — recovered".repeat(60)}`.slice(0, 520).trim();
  context.mergeOperationalNotificationEvents([resolved]);
  assert.strictEqual(item.message, "OVH is not reachable. — recovered", "a suffix run cut off by the length cap collapses to one");

  // A message that only mentions recovery elsewhere is kept as written.
  item.message = "Disk — recovered space after cleanup";
  context.mergeOperationalNotificationEvents([resolved]);
  assert.strictEqual(item.message, "Disk — recovered space after cleanup — recovered");
});

// ---------------------------------------------------------------------------
// S6 ui-shell-6: saving settings
// ---------------------------------------------------------------------------

check("S6", "saving a setting sends only the settings inputs and keeps onboarding state", async () => {
  const sent = [];
  const applied = [];
  const stored = {
    "appearance.reduceMotion": false,
    "general.defaultPage": "dashboard",
    "onboarding.completed": true,
    "onboarding.setupType": "remote",
    "guidance.dismissedTips": "files-explained,backups-explained",
  };
  const input = (setting, value) => ({ dataset: { setting }, type: typeof value === "boolean" ? "checkbox" : "text", checked: value === true, value: String(value) });
  const context = {
    console,
    DEFAULT_SETTINGS: {
      "appearance.reduceMotion": false,
      "general.defaultPage": "dashboard",
      "onboarding.completed": false,
      "onboarding.setupType": "this-pc",
      "guidance.dismissedTips": "",
    },
    currentSettings: { ...stored },
    settingsInputs: [input("appearance.reduceMotion", true), input("general.defaultPage", "dashboard")],
    settingsSaveInFlight: false,
    sent,
    applied,
  };
  vm.createContext(context);
  vm.runInContext(`
    function getCurrentSettings() { return currentSettings; }
    function getSettingInputValue(input) { return input.type === "checkbox" ? input.checked : input.value; }
    function isSettingKeyAuthorized() { return true; }
    function writeStoredSettings() {}
    function applySettings(settings) { applied.push(settings); currentSettings = settings; }
    function syncAccentSwatches() {}
    function refreshPlayitStatus() {}
    function setSettingsStatus() {}
    function normalizeIpcErrorMessage(error) { return String(error && error.message); }
    function getDesktopApiState() {
      return { hasPreferences: true, api: { settings: { savePreferences: async (patch) => { sent.push(patch); return { settings: { ...currentSettings, ...patch } }; } } } };
    }
    ${extractFunction("saveSettings")}
  `, context, { filename: "app.js (extracted)" });
  await context.saveSettings();
  assert.strictEqual(sent.length, 1);
  const patch = sent[0];
  assert.strictEqual(patch["appearance.reduceMotion"], true, "the changed setting is saved");
  for (const key of ["onboarding.completed", "onboarding.setupType", "guidance.dismissedTips"]) {
    assert(!Object.prototype.hasOwnProperty.call(patch, key), `${key} has no settings input and must not be sent`);
  }
  const appliedSettings = applied[0];
  assert.strictEqual(appliedSettings["onboarding.completed"], true, "setup stays complete in this session");
  assert.strictEqual(appliedSettings["onboarding.setupType"], "remote");
  assert.strictEqual(appliedSettings["guidance.dismissedTips"], "files-explained,backups-explained");
});

// ---------------------------------------------------------------------------
// S7 visual-core-2: Home "Players online"
// ---------------------------------------------------------------------------

check("S7", "Home Players online counts the players a server reports", () => {
  const playerCountsSource = extractFunction("getInstancePlayerCounts", { optional: true });
  const helper = {};
  if (playerCountsSource) {
    const helperContext = { window: {} };
    vm.createContext(helperContext);
    vm.runInContext(`${playerCountsSource}\nthis.getInstancePlayerCounts = getInstancePlayerCounts;`, helperContext);
    helper.getInstancePlayerCounts = helperContext.getInstancePlayerCounts;
    helper.live = helperContext.window;
  }
  const minecraft = { id: "mc", state: "running", minecraft: { players: { online: 2, max: 20, status: "reported" } } };
  const palworld = { id: "pal", state: "running", players: { online: 3, max: 32 } };
  const home = loadHomeDashboard({
    nodesState: { nodes: [{ id: "ovh", kind: "agent", displayName: "OVH" }] },
    getSelectedNodeId: () => "ovh",
    getInstances: () => [minecraft, palworld, { id: "quiet", state: "running", minecraft: { players: { online: null, status: "query-disabled" } } }],
    // The display summary is a formatted string, never a count.
    getMinecraftSummaryData: (instance) => ({ players: instance.minecraft?.players?.online != null ? `${instance.minecraft.players.online} / ${instance.minecraft.players.max}` : "Query disabled" }),
    ...helper,
  });
  const overview = home.context.__buildState().overview;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(overview.players)), { value: "5", detail: "players online" }, "reported players add up; a server that reports none is left out");
  assert(playerCountsSource, "app.js provides getInstancePlayerCounts for summaries");
  const counts = (instance) => JSON.parse(JSON.stringify(helper.getInstancePlayerCounts(instance)));
  assert.deepStrictEqual(counts(minecraft), { online: 2, max: 20 });
  assert.deepStrictEqual(counts({ id: "q", minecraft: { players: { online: null } } }), { online: null, max: null });
  helper.live.AnxLivePlayers = { supports: () => true, latest: () => ({ available: true, online: 4, max: 10 }) };
  assert.deepStrictEqual(counts({ id: "fivem" }), { online: 4, max: 10 }, "live counts from the Players panel are used when nothing else reports");
});

// ---------------------------------------------------------------------------
// S8 visual-core-3: health checks of connected computers
// ---------------------------------------------------------------------------

check("S8", "a health check keeps a connected computer's recorded state until the probe answers", async () => {
  const agentClient = require(path.join(ROOT, "src", "services", "agentClient"));
  let releaseProbe = null;
  let probes = 0;
  agentClient.getHealth = async (config) => {
    const deviceId = String(config?.agentUrl || "").endsWith(":10") ? "fresh-device" : "ovh-device";
    const health = { ok: true, service: "anxos-agent", apiVersion: "v1", protocolVersion: 1, identity: { deviceId, hostname: deviceId, agentVersion: "0.1.0" } };
    probes += 1;
    if (releaseProbe === false) return health;
    return new Promise((resolve) => { releaseProbe = () => resolve(health); });
  };
  agentClient.getSystemStats = async () => ({ hostname: "ovh", cpu: { usagePercent: 1 }, memory: { used: 1, total: 2, percent: 50 } });
  const nodeService = require(path.join(ROOT, "src", "services", "nodeService"));
  const { setNodeToken } = require(path.join(ROOT, "src", "services", "nodeCredentialStore"));
  const nodes = [
    { id: "ovh", kind: "agent", displayName: "OVH", agentUrl: "http://127.0.0.1:9", baseUrl: "http://127.0.0.1:9", agentIdentity: { deviceId: "ovh-device" } },
    { id: "fresh", kind: "agent", displayName: "Fresh", agentUrl: "http://127.0.0.1:10", baseUrl: "http://127.0.0.1:10", agentIdentity: { deviceId: "fresh-device" } },
  ];
  fs.mkdirSync(path.dirname(nodeService.getNodesPath()), { recursive: true });
  fs.writeFileSync(nodeService.getNodesPath(), `${JSON.stringify({ schemaVersion: 2, selectedNodeId: "ovh", nodes }, null, 2)}\n`);
  setNodeToken("ovh", "token-ovh");
  setNodeToken("fresh", "token-fresh");

  releaseProbe = false;
  let result = await nodeService.checkNodeHealth("ovh", { timeoutMs: 100 });
  assert.strictEqual(result.state, "online");

  releaseProbe = null;
  const pending = nodeService.checkNodeHealth("ovh", { timeoutMs: 100 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(typeof releaseProbe, "function", "the second check is waiting on its probe");
  const during = nodeService.getNode("ovh");
  assert.strictEqual(during.connection?.status, "online", "a connected computer is not recorded as connecting while it is checked");
  assert.strictEqual(during.lastConnectionState, "online");
  releaseProbe();
  result = await pending;
  assert.strictEqual(result.state, "online");

  // A computer never seen online still shows that it is being checked.
  releaseProbe = null;
  const first = nodeService.checkNodeHealth("fresh", { timeoutMs: 100 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(nodeService.getNode("fresh").connection?.status, "connecting", "a first check still reads Connecting");
  releaseProbe();
  assert.strictEqual((await first).state, "online");
  assert.strictEqual(probes, 3);
});

// ---------------------------------------------------------------------------
// S9 visual-core-5: Docker page layout
// ---------------------------------------------------------------------------

check("S9", "the Docker workspace collapses before its two columns can overflow the content area", () => {
  const css = stylesSource.replace(/\/\*[\s\S]*?\*\//g, "");
  // Unconditional rules only: strip every @media / @container block.
  let topLevel = "";
  const atBlocks = [];
  for (let index = 0; index < css.length;) {
    const at = css.indexOf("@", index);
    if (at < 0) {
      topLevel += css.slice(index);
      break;
    }
    topLevel += css.slice(index, at);
    const open = css.indexOf("{", at);
    const end = skipBalanced(css, open, "{", "}");
    atBlocks.push({ prelude: css.slice(at, open).trim(), body: css.slice(open + 1, end - 1) });
    index = end;
  }
  const declarationsFor = (source, selector) => {
    const found = [];
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match;
    while ((match = ruleRe.exec(source))) {
      const selectors = match[1].split(",").map((entry) => entry.trim());
      if (selectors.includes(selector)) found.push(match[2]);
    }
    return found;
  };
  const lastValue = (bodies, property) => {
    let value = null;
    bodies.forEach((body) => {
      const re = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`, "g");
      let match;
      while ((match = re.exec(body))) value = match[1].trim();
    });
    return value;
  };

  const workspaceColumns = lastValue(declarationsFor(topLevel, ".docker-workspace"), "grid-template-columns");
  const workspaceGap = lastValue(declarationsFor(topLevel, ".docker-workspace"), "gap");
  const minimums = [...String(workspaceColumns).matchAll(/minmax\(\s*(\d+)px/g)].map((match) => Number(match[1]));
  const needed = minimums.reduce((sum, value) => sum + value, 0) + (minimums.length > 1 ? parseFloat(workspaceGap) || 0 : 0);

  const shell = declarationsFor(topLevel, ".docker-shell");
  assert.strictEqual(lastValue(shell, "grid-template-columns"), "minmax(0, 1fr)", "a wide child must not stretch every Docker section past the content area");
  assert.strictEqual(lastValue(shell, "container-type"), "inline-size", "the Docker shell sizes its workspace from its own width, which accounts for the sidebar");

  const collapse = atBlocks.find((block) => /^@container\b/.test(block.prelude)
    && lastValue(declarationsFor(block.body, ".docker-workspace"), "grid-template-columns") === "minmax(0, 1fr)");
  assert(collapse, "an @container rule collapses .docker-workspace to one column");
  const threshold = Number((/max-width:\s*(\d+)px/.exec(collapse.prelude) || [])[1]);
  assert(needed > 0 && threshold >= needed, `the workspace collapses at ${threshold}px but needs ${needed}px for two columns`);
});

// ---------------------------------------------------------------------------
// S10 visual-core-7: Routes modal main address
// ---------------------------------------------------------------------------

check("S10", "the Routes modal shows the main address state from the computer's connection", () => {
  const states = { ovh: "online", anxlab: "offline" };
  const document = createFakeDocument();
  const context = {
    console,
    document,
    nodesState: {
      nodes: [
        { id: "ovh", kind: "agent", displayName: "OVH", baseUrl: "http://127.0.0.1:33544", fallbackUrls: [] },
        { id: "anxlab", kind: "agent", displayName: "Anxlab", baseUrl: "http://127.0.0.1:33545", fallbackUrls: [] },
        { id: "vps", kind: "agent", displayName: "VPS", baseUrl: "http://192.0.2.5:47132", fallbackUrls: [{ url: "http://198.51.100.5:47132", label: "Tailscale" }] },
      ],
    },
    nodeRouteStatusById: new Map(),
    nodeTunnelStatusById: new Map(),
    NODE_TUNNEL_STATE_LABELS: {},
    Option: class Option extends FakeElement {
      constructor(text, value) {
        super("option");
        this._text = text;
        this.value = value;
      }
    },
    Promise,
  };
  vm.createContext(context);
  vm.runInContext(`
    function getDesktopApiState() { return { api: { ssh: {} } }; }
    function getNodeVisualState(node) { return (${JSON.stringify(states)})[node.id] || "installing"; }
    function createTextElement(tagName, text = "", className = "") { const element = document.createElement(tagName); element.textContent = text; element.className = className; return element; }
    function activateModal() { return () => {}; }
    function normalizeIpcErrorMessage(error, fallback) { return fallback; }
    function refreshNodeConnectivityStatus() {}
    function renderNodes() {}
    ${extractFunction("describeNodeRouteEntry", { optional: true })}
    ${extractFunction("openNodeRoutesModal")}
  `, context, { filename: "app.js (extracted)" });
  const mainRow = (nodeId) => {
    document.body.children = [];
    context.openNodeRoutesModal(nodeId);
    const rows = document.body.findAll((element) => element.tagName === "LI");
    assert(rows.length, `${nodeId}: the modal lists addresses`);
    const pill = rows[0].findAll((element) => /status-pill/.test(element.className))[0];
    return { text: pill.textContent, className: pill.className };
  };
  const ovh = mainRow("ovh");
  assert.match(ovh.text, /In use/, "a connected computer without fallbacks uses its main address");
  assert.match(ovh.className, /status-pill--ok/);
  const anxlab = mainRow("anxlab");
  assert.match(anxlab.text, /Not answering/, "an offline computer's main address is not answering");
  assert.match(anxlab.className, /status-pill--warning/);
  const vps = mainRow("vps");
  assert.strictEqual(vps.text, "Not checked yet", "with fallback routes the resolver's checks decide the state");
});

// ---------------------------------------------------------------------------
// S11 R12: live player counts in summaries are recent and from this computer
// ---------------------------------------------------------------------------

check("S11", "summaries use a live player reading only while it is recent and from the selected computer", async () => {
  const panelSource = fs.readFileSync(path.join(ROOT, "src", "renderer", "playersPanel.js"), "utf8");
  let now = Date.parse("2026-11-14T10:00:00.000Z");
  let selectedNodeId = "node-a";
  let tab = "players";
  let selected = { id: "palworld", game: "palworld", state: "running" };
  let respond = async () => ({ available: true, running: true, online: 5, max: 32, players: [] });
  class FakeDate extends Date {
    static now() { return now; }
  }
  const context = {
    console,
    Date: FakeDate,
    document: createFakeDocument(),
    setInterval: () => 1,
    findInstance: () => selected,
    getActivePageName: () => "instances",
    getSelectedNodeId: () => selectedNodeId,
    getDesktopApiState: () => ({ api: { instances: { getPlayers: (...args) => respond(...args) } } }),
    getNodeRequestContext: () => ({}),
    getNodeScopedPayload: () => ({}),
  };
  Object.defineProperty(context, "activeInstanceTab", { get: () => tab });
  context.window = context;
  vm.createContext(context);
  vm.runInContext(panelSource, context, { filename: "playersPanel.js" });
  vm.runInContext(`${extractFunction("getInstancePlayerCounts")}\nthis.getInstancePlayerCounts = getInstancePlayerCounts;`, context, { filename: "app.js (extracted)" });
  const counts = (instance) => JSON.parse(JSON.stringify(context.getInstancePlayerCounts(instance)));
  const palworld = { id: "palworld", game: "palworld", state: "running" };

  await context.AnxLivePlayers.refresh();
  tab = "console";
  selected = null;
  assert.deepStrictEqual(counts(palworld), { online: 5, max: 32 }, "a fresh reading is used");

  selectedNodeId = "node-b";
  assert.deepStrictEqual(counts(palworld), { online: null, max: null }, "another computer's server with the same id does not get this reading");
  assert.strictEqual(context.AnxLivePlayers.latest("palworld"), null, "the server page header does not show another computer's reading either");
  selectedNodeId = "node-a";
  assert.deepStrictEqual(counts(palworld), { online: 5, max: 32 });

  now += 60 * 1000;
  assert.deepStrictEqual(counts(palworld), { online: null, max: null }, "a reading the Players tab stopped refreshing is not reported as current");

  // A reading that answers after the computer changed is discarded.
  tab = "players";
  selected = palworld;
  let release = null;
  respond = () => new Promise((resolve) => { release = resolve; });
  const pending = context.AnxLivePlayers.refresh();
  selectedNodeId = "node-b";
  release({ available: true, running: true, online: 7, max: 32, players: [] });
  await pending;
  assert.deepStrictEqual(counts(palworld), { online: null, max: null }, "a reading taken for computer A is not stored for computer B");
});

// ---------------------------------------------------------------------------
// S12 R13: the recovery suffix is only ever stripped from the end
// ---------------------------------------------------------------------------

check("S12", "a message that already contains the recovery text keeps one suffix across syncs", () => {
  const context = { console, NOTIFICATION_MAX_MESSAGE_LENGTH: 520 };
  vm.createContext(context);
  vm.runInContext(`
    function getFriendlyOperationText(value) { return String(value || ""); }
    ${(/^const RECOVERED_NOTIFICATION_SUFFIX = .*;$/m.exec(appSource) || [""])[0]}
    ${extractFunctions(["sanitizeNotificationText", "stripRecoveredSuffix"])}
    this.annotate = (message) => sanitizeNotificationText(\`\${stripRecoveredSuffix(message)}\${RECOVERED_NOTIFICATION_SUFFIX}\`, NOTIFICATION_MAX_MESSAGE_LENGTH);
    this.strip = stripRecoveredSuffix;
  `, context, { filename: "app.js (extracted)" });
  let message = "Machine Box — recovered disconnected (state: offline).";
  const lengths = [];
  for (let sync = 0; sync < 5; sync += 1) {
    message = context.annotate(message);
    lengths.push(message.length);
  }
  assert.strictEqual(message, "Machine Box — recovered disconnected (state: offline). — recovered", "only the trailing suffix is replaced");
  assert.deepStrictEqual(lengths, Array(5).fill(lengths[0]), "the message stops growing after the first sync");
  assert.strictEqual(context.strip("Box — recovered went down — recovered — recovered — rec"), "Box — recovered went down", "a trailing run, cut short at the end, is removed and the earlier text kept");
  assert.strictEqual(context.strip("Tunnel down — rec"), "Tunnel down — rec", "a cut-off suffix with no full suffix before it is kept as written");
  assert.strictEqual(context.strip("OVH is not reachable."), "OVH is not reachable.");
});

// ---------------------------------------------------------------------------

(async () => {
  let failed = 0;
  for (const entry of checks) {
    try {
      await entry.fn();
      console.log(`PASS ${entry.id} ${entry.title}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${entry.id} ${entry.title}\n  ${error && error.stack ? error.stack.split("\n").slice(0, 3).join("\n  ") : error}`);
    }
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (failed) {
    console.error(`shell-fixes-smoke: ${failed} of ${checks.length} checks failed.`);
    process.exit(1);
  }
  console.log(`shell-fixes-smoke passed (${checks.length} checks)`);
})();
