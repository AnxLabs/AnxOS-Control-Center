#!/usr/bin/env node
"use strict";

// Smoothness campaign — wasted-work package (SMOOTH-2002/2003/2004/2005/2006/
// 2011/2013/2014/2015/2017 and SMOOTH-1008).
//
// WHY THIS EXISTS
// Every fix in this package removes work that ran on a hot path without
// changing what the user is shown. "Removes work" is invisible to an ordinary
// behavioural test: if the panel still shows the right thing, no assertion can
// tell whether it was rebuilt once or once per keystroke. So the assertions here
// are COUNTS of the work itself, taken by driving the REAL functions extracted
// from app.js against a fake DOM:
//
//   * how many times the field container is replaceChildren()'d per edit,
//   * whether the focused node is the same object before and after an edit,
//   * how many timers are registered per polled source,
//   * how many times monaco.layout() / a CSS custom property is written per
//     mousemove, per frame and per drag,
//   * how many localStorage writes and scroll-geometry reads a scroll burst
//     produces,
//   * how many document queries getActivePageName() performs,
//   * how many elements and listeners renderSettingsSearch() creates,
//   * whether the row-text read is skipped when no query is active.
//
// MUTATION TEETH
// Each risky fix carries a mutation self-test: the same scenario is re-run
// against a deliberately re-broken copy of app.js in memory, and the check is
// required to FAIL and to name the guard. Without that, a scenario that
// silently stopped observing anything would keep passing forever.
//
// WHAT THIS DOES NOT PROVE
// No Electron is launched and no real DOM is used, so this proves the
// MECHANISM (node identity, call counts, timer registrations), not the rendered
// result and not the caret itself. `activeElement` identity is asserted as the
// closest observable stand-in for caret preservation; a real caret lives in
// Chromium and is only exercised by the orchestrator's confirming launch. It
// also cannot measure frame time — every smoothness benefit in this package is
// structural, not profiled. See the report's UNPROVEN section.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_PATH = path.resolve(__dirname, "..", "app.js");
const REAL_SOURCE = fs.readFileSync(APP_PATH, "utf8").replace(/\r\n/g, "\n");

// --- source extraction ------------------------------------------------------

function extractFunction(source, name) {
  const needle = `function ${name}(`;
  const start = source.indexOf(needle);
  assert(start >= 0, `Could not find function ${name} in app.js.`);
  // Skip the parameter list first: a default parameter like `options = {}`
  // contains a brace, so the body's opening brace is NOT the first brace after
  // the name.
  const openParen = source.indexOf("(", start);
  let parenDepth = 0;
  let cursor = openParen;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") parenDepth += 1;
    else if (source[cursor] === ")") {
      parenDepth -= 1;
      if (parenDepth === 0) { cursor += 1; break; }
    }
  }
  const open = source.indexOf("{", cursor);
  assert(open >= 0, `Could not find the body of ${name}.`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}.`);
}

function extractBracedStatement(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, `Could not find statement starting "${marker}".`);
  const open = source.indexOf("{", start);
  assert(open >= 0, `Statement "${marker}" has no block.`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1) + (source[index + 1] === ";" ? ";" : "");
    }
  }
  throw new Error(`Could not extract statement "${marker}".`);
}

function extractLine(source, marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, `Could not find line starting "${marker}".`);
  const end = source.indexOf("\n", start);
  return source.slice(start, end < 0 ? source.length : end);
}

function extractRange(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert(start >= 0, `Could not find range start "${startMarker}".`);
  const end = source.indexOf(endMarker, start);
  assert(end >= 0, `Could not find range end "${endMarker}".`);
  return source.slice(start, end + endMarker.length);
}

function mutate(source, from, to) {
  const first = source.indexOf(from);
  assert(first >= 0, `Mutation target not present: ${JSON.stringify(from.slice(0, 60))}`);
  assert.strictEqual(
    source.indexOf(from, first + 1),
    -1,
    `Mutation target is not unique: ${JSON.stringify(from.slice(0, 60))}`,
  );
  return source.slice(0, first) + to + source.slice(first + from.length);
}

// --- fake DOM ---------------------------------------------------------------

function matchesSimple(element, part) {
  const tokens = String(part).match(/(^[a-zA-Z][\w-]*)|(\.[\w-]+)|(\[[^\]]+\])/g) || [];
  return tokens.every((token) => {
    if (token.startsWith(".")) return element.classList.contains(token.slice(1));
    if (token.startsWith("[")) {
      const parsed = token.slice(1, -1).match(/^([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'))?$/);
      if (!parsed) return false;
      const key = parsed[1].replace(/^data-/, "").replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (parsed[2] === undefined && parsed[3] === undefined) return element.dataset[key] !== undefined;
      return String(element.dataset[key]) === (parsed[2] ?? parsed[3]);
    }
    return element.tagName === token.toUpperCase();
  });
}

function matchesSelector(element, selector) {
  return String(selector).split(",").map((part) => part.trim()).filter(Boolean)
    .some((part) => matchesSimple(element, part));
}

function createFakeElement(tagName, options = {}) {
  let classes = new Set(String(options.className || "").split(/\s+/).filter(Boolean));
  let text = options.text || "";
  let value = options.value === undefined ? "" : options.value;
  const counts = { append: 0, replaceChildren: 0, listeners: {}, styleWrites: {} };
  const reads = { textContent: 0 };
  const element = {
    tagName: String(tagName || "div").toUpperCase(),
    dataset: {},
    children: [],
    parentNode: null,
    hidden: Boolean(options.hidden),
    disabled: false,
    checked: Boolean(options.checked),
    counts,
    reads,
    listeners: {},
    style: {
      setProperty(name, styleValue) {
        counts.styleWrites[name] = (counts.styleWrites[name] || 0) + 1;
        element.style[name] = String(styleValue);
      },
      getPropertyValue(name) { return element.style[name] ?? ""; },
    },
    // The real DOM coerces assigned form values to strings; code under test
    // calls .trim() on them, so the fake must coerce too.
    get value() { return value; },
    set value(next) { value = next === null || next === undefined ? "" : String(next); },
    get className() { return [...classes].join(" "); },
    set className(next) { classes = new Set(String(next || "").split(/\s+/).filter(Boolean)); },
    classList: {
      add(...names) { names.forEach((name) => classes.add(name)); },
      remove(...names) { names.forEach((name) => classes.delete(name)); },
      contains(name) { return classes.has(name); },
      toggle(name, force) {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
    },
    append(...nodes) {
      counts.append += nodes.length;
      nodes.forEach((node) => {
        if (node === null || node === undefined) return;
        if (node.parentNode) {
          const index = node.parentNode.children.indexOf(node);
          if (index >= 0) node.parentNode.children.splice(index, 1);
        }
        node.parentNode = element;
        element.children.push(node);
      });
    },
    appendChild(node) { element.append(node); return node; },
    replaceChildren(...nodes) {
      counts.replaceChildren += 1;
      element.children.forEach((child) => { if (child && typeof child === "object") child.parentNode = null; });
      element.children = [];
      element.append(...nodes);
    },
    remove() {
      if (!element.parentNode) return;
      const index = element.parentNode.children.indexOf(element);
      if (index >= 0) element.parentNode.children.splice(index, 1);
      element.parentNode = null;
    },
    addEventListener(type, handler) {
      counts.listeners[type] = (counts.listeners[type] || 0) + 1;
      (element.listeners[type] = element.listeners[type] || []).push(handler);
    },
    removeEventListener() {},
    dispatch(type, event) { (element.listeners[type] || []).forEach((handler) => handler(event)); },
    setAttribute(name, attributeValue) { element[name] = attributeValue; },
    getAttribute(name) { return element[name] === undefined ? null : element[name]; },
    focus() {},
    closest(selector) {
      let node = element;
      while (node) {
        if (matchesSelector(node, selector)) return node;
        node = node.parentNode;
      }
      return null;
    },
    querySelectorAll(selector) {
      const out = [];
      const walk = (node) => node.children.forEach((child) => {
        if (child && typeof child === "object") {
          if (matchesSelector(child, selector)) out.push(child);
          walk(child);
        }
      });
      walk(element);
      return out;
    },
    querySelector(selector) { return element.querySelectorAll(selector)[0] || null; },
  };
  Object.defineProperty(element, "textContent", {
    get() {
      reads.textContent += 1;
      return text + element.children
        .map((child) => (child && typeof child === "object" ? child.textContent : String(child ?? "")))
        .join("");
    },
    set(next) {
      text = String(next ?? "");
      element.children.forEach((child) => { if (child && typeof child === "object") child.parentNode = null; });
      element.children = [];
    },
    configurable: true,
  });
  return element;
}

function createFakeDocument() {
  const doc = {
    body: createFakeElement("body"),
    hidden: false,
    activeElement: null,
    createElementCounts: {},
    createdElements: [],
    createElement(tag) {
      doc.createElementCounts[tag] = (doc.createElementCounts[tag] || 0) + 1;
      const created = createFakeElement(tag);
      doc.createdElements.push(created);
      return created;
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    removeEventListener() {},
  };
  return doc;
}

function createFakeWindow() {
  const timers = [];
  const frames = [];
  const listeners = {};
  const localStorage = {
    store: {},
    writes: 0,
    setItem(key, stored) { localStorage.writes += 1; localStorage.store[key] = String(stored); },
    getItem(key) { return Object.prototype.hasOwnProperty.call(localStorage.store, key) ? localStorage.store[key] : null; },
  };
  const win = {
    localStorage,
    timers,
    frames,
    listeners,
    setInterval(handler) {
      const entry = { id: timers.length + 1, handler, kind: "interval", cancelled: false, ran: false };
      timers.push(entry);
      return entry.id;
    },
    clearInterval(id) { timers.forEach((entry) => { if (entry.id === id) entry.cancelled = true; }); },
    setTimeout(handler) {
      const entry = { id: timers.length + 1, handler, kind: "timeout", cancelled: false, ran: false };
      timers.push(entry);
      return entry.id;
    },
    clearTimeout(id) { timers.forEach((entry) => { if (entry.id === id) entry.cancelled = true; }); },
    requestAnimationFrame(handler) {
      const entry = { id: frames.length + 1, handler, cancelled: false, ran: false };
      frames.push(entry);
      return entry.id;
    },
    cancelAnimationFrame(id) { frames.forEach((entry) => { if (entry.id === id) entry.cancelled = true; }); },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
    removeEventListener() {},
  };
  // Pending animation frames are counted without running them, so a test can
  // assert coalescing (many events, one frame) before it pays for the frame.
  win.pendingFrames = () => frames.filter((entry) => !entry.cancelled && !entry.ran).length;
  win.runFrame = () => {
    const pending = frames.filter((entry) => !entry.cancelled && !entry.ran);
    pending.forEach((entry) => { entry.ran = true; entry.handler(); });
    return pending.length;
  };
  win.runTimers = () => {
    const pending = timers.filter((entry) => !entry.cancelled && !entry.ran && entry.kind === "timeout");
    pending.forEach((entry) => { entry.ran = true; entry.handler(); });
    return pending.length;
  };
  win.emit = (type, event) => (listeners[type] || []).forEach((handler) => handler(event));
  return win;
}

// --- sandbox ----------------------------------------------------------------

function createSandbox({ source = REAL_SOURCE, functions = [], statements = [], lines = [], ranges = [], globals = () => ({}) }) {
  const doc = createFakeDocument();
  const win = createFakeWindow();
  const context = {
    document: doc,
    window: win,
    localStorage: win.localStorage,
    console: { log() {}, warn() {}, info() {}, error() {} },
    Math,
    JSON,
    Set,
    Map,
    Object,
    Array,
    Number,
    String,
    Boolean,
    Date,
    ...globals(doc, win),
  };
  vm.createContext(context);
  const code = [
    ...functions.map((name) => extractFunction(source, name)),
    ...statements.map((marker) => extractBracedStatement(source, marker)),
    ...lines.map((marker) => extractLine(source, marker)),
    ...ranges.map(([start, end]) => extractRange(source, start, end)),
  ].join("\n\n");
  vm.runInContext(code, context);
  return {
    context,
    doc,
    win,
    run: (expression) => vm.runInContext(expression, context),
  };
}

function activeTimer(sandbox, handleExpression) {
  const id = sandbox.run(handleExpression);
  const entry = sandbox.win.timers.find((candidate) => candidate.id === id);
  assert.ok(entry, `no timer was registered for ${handleExpression}`);
  return entry;
}

function clearRecordedCalls(sandbox) {
  if (!sandbox.context.calls) return;
  Object.keys(sandbox.context.calls).forEach((key) => { delete sandbox.context.calls[key]; });
}

// --- check runner -----------------------------------------------------------

let CHECKER_QUIET = false;

function createChecker() {
  const state = { failures: 0, passed: 0, failedLabels: [] };
  return {
    state,
    check(label, fn) {
      try {
        fn();
        state.passed += 1;
        if (!CHECKER_QUIET) console.log(`  PASS  ${label}`);
      } catch (error) {
        state.failures += 1;
        state.failedLabels.push(label);
        if (!CHECKER_QUIET) console.error(`  FAIL  ${label}: ${error.message}`);
      }
    },
  };
}

// ============================================================================
// SMOOTH-2002 — the game configuration panel is edited in place
// ============================================================================

const GAME_CONFIG_MODEL = {
  supported: true,
  label: "Paper",
  filePath: "server.properties",
  missing: false,
  values: { motd: "Hello", "max-players": 20, "online-mode": true, password: "" },
  fields: [
    { key: "motd", label: "MOTD", category: "General", type: "text", description: "d", currentValue: "Hello", defaultValue: "Hi" },
    { key: "max-players", label: "Max players", category: "General", type: "integer", description: "d", currentValue: 20, defaultValue: 10, restartRequired: true, min: 1, max: 100 },
    { key: "online-mode", label: "Online mode", category: "General", type: "boolean", description: "d", currentValue: true, defaultValue: true },
    { key: "password", label: "Password", category: "Advanced", type: "secret", description: "d", currentValue: "", defaultValue: "", sensitive: true, hasCurrentValue: true, advanced: true },
  ],
};

function scenarioGameConfig(source) {
  const checker = createChecker();
  const dirtyCalls = { count: 0 };
  const sandbox = createSandbox({
    source,
    functions: [
      "getGameConfigField",
      "normalizeGameConfigInputValue",
      "normalizeGameConfigSnapshotValue",
      "collectGameConfigValues",
      "getChangedGameConfigValues",
      "isGameConfigDirty",
      "setGameConfigStatus",
      "updateGameConfigStatusLine",
      "renderGameConfigPanel",
      "createGameConfigField",
      "getActiveGameConfigFields",
      "createGameConfigInput",
      "updateGameConfigField",
    ],
    statements: ["let gameConfigState = {"],
    globals: (doc) => ({
      gameConfigFields: doc.createElement("div"),
      gameConfigSections: doc.createElement("div"),
      gameConfigStatus: createFakeElement("span"),
      gameConfigTitle: createFakeElement("h3"),
      gameConfigMeta: createFakeElement("p"),
      gameConfigSearchInput: createFakeElement("input"),
      gameConfigAdvancedInput: createFakeElement("input"),
      instanceGameConfigManager: createFakeElement("section"),
      findInstance: () => ({ id: "inst-1", displayName: "Paper" }),
      syncInstanceConfigDirtyState: () => { dirtyCalls.count += 1; },
      __model: GAME_CONFIG_MODEL,
      __dirtyCalls: dirtyCalls,
    }),
  });

  const editField = (key, nextValue) => sandbox.run(`
    (() => {
      const element = gameConfigFields.querySelectorAll("[data-game-config-field]")
        .find((candidate) => candidate.dataset.gameConfigField === ${JSON.stringify(key)});
      element.value = ${JSON.stringify(nextValue)};
      updateGameConfigField(getGameConfigField(${JSON.stringify(key)}), element);
    })();
  `);

  checker.check("baseline render builds every visible field and reports Saved", () => {
    sandbox.run("gameConfigState.model = __model; renderGameConfigPanel();");
    assert.strictEqual(sandbox.run("gameConfigFields.children.length"), 3, "expected 3 visible fields (the advanced secret is hidden)");
    assert.strictEqual(sandbox.run("gameConfigStatus.textContent"), "Saved");
  });

  checker.check("editing a field does not rebuild the panel (the focused node survives)", () => {
    const fields = sandbox.run("gameConfigFields");
    const replaceChildrenBefore = fields.counts.replaceChildren;
    const wrapper = fields.children[0];
    const input = wrapper.querySelector("[data-game-config-field]");
    assert.ok(input, "the first field must expose its input");
    sandbox.doc.activeElement = input;

    editField("motd", "Goodbye");

    assert.strictEqual(
      fields.counts.replaceChildren,
      replaceChildrenBefore,
      "editing a field must not replaceChildren() the field container",
    );
    assert.strictEqual(fields.children[0], wrapper, "the edited field's wrapper must be the same node object");
    assert.strictEqual(input.parentNode, wrapper, "the input must not have been detached and re-created");
    assert.strictEqual(sandbox.doc.activeElement, input, "the focused element must still be the same node (caret survives)");
    assert.strictEqual(input.value, "Goodbye", "the typed value must still be in the input");
  });

  checker.check("dirty marking, the status line and the dirty-state sync still update", () => {
    assert.strictEqual(sandbox.run("gameConfigStatus.textContent"), "Unsaved changes");
    assert.strictEqual(sandbox.run("gameConfigState.values.motd"), "Goodbye");
    assert.strictEqual(sandbox.run("gameConfigFields.children[0].classList.contains('is-modified')"), true);
    assert.ok(dirtyCalls.count > 0, "syncInstanceConfigDirtyState must still run");
  });

  checker.check("the restart-required wording is preserved", () => {
    editField("max-players", "40");
    assert.strictEqual(sandbox.run("gameConfigStatus.textContent"), "Unsaved changes · restart required");
    assert.strictEqual(sandbox.run("gameConfigState.values['max-players']"), 40);
  });

  checker.check("reverting a field clears its dirty mark", () => {
    editField("motd", "Hello");
    assert.strictEqual(sandbox.run("gameConfigFields.children[0].classList.contains('is-modified')"), false);
  });

  checker.check("a stale per-field validation error is cleared by the edit that touches it", () => {
    sandbox.run("gameConfigState.fieldErrors.motd = 'MOTD is invalid.'; renderGameConfigPanel();");
    const wrapper = sandbox.run("gameConfigFields.children[0]");
    const error = wrapper.querySelector(".instance-game-config-error");
    assert.strictEqual(error.hidden, false, "the invalid field must show its error");
    assert.strictEqual(error.textContent, "MOTD is invalid.");
    editField("motd", "Hello again");
    assert.strictEqual(error.hidden, true, "editing the field must clear its error");
    assert.strictEqual(error.textContent, "");
  });

  checker.check("a sensitive field still records that the operator touched it", () => {
    sandbox.run("gameConfigState.showAdvanced = true; gameConfigState.activeCategory = 'Advanced'; renderGameConfigPanel();");
    editField("password", "hunter2");
    assert.strictEqual(sandbox.run("gameConfigState.touchedSecrets.has('password')"), true);
    assert.strictEqual(sandbox.run("gameConfigState.values.password"), "hunter2");
    assert.strictEqual(sandbox.run("isGameConfigDirty()"), true);
  });

  return checker;
}

// ============================================================================
// SMOOTH-2003 — one owner per polled source
// ============================================================================

const REFRESH_TASK_START = "registerRefreshTask(updateLocalTime, 30000);";
const REFRESH_TASK_END = "// source, so removing it also removes the case where the two interleaved.";

function createPollerSandbox(source) {
  const state = { tasks: [], page: "dashboard" };
  const sandbox = createSandbox({
    source,
    functions: [
      "startAgentControlPolling",
      "stopAgentControlPolling",
      "startMonitoringConsolePolling",
      "stopMonitoringConsolePolling",
      "shouldPollMonitoringConsole",
      "startInstanceConsolePolling",
      "stopInstanceConsolePolling",
      "shouldPollInstanceConsole",
      "startInstancesPagePolling",
      "stopInstancesPagePolling",
    ],
    ranges: [[REFRESH_TASK_START, REFRESH_TASK_END]],
    lines: [
      "let agentControlPollTimer = null;",
      "let instancesPagePollTimerId = null;",
      "let monitoringConsolePollTimerId = null;",
      "let instanceConsolePollTimerId = null;",
      "let activeConsoleInstanceId = null;",
      "let activeInstanceTab = \"overview\";",
      "let selectedInstanceId = null;",
      "let instanceActionRequestInFlight = false;",
      "let marketplaceInstallPollActive = false;",
      "const CONSOLE_LOG_REFRESH_INTERVAL_MS = 2000;",
      "const INSTANCE_PAGE_REFRESH_INTERVAL_MS = 5000;",
    ],
    globals: () => {
      const calls = {};
      const record = (name) => () => { calls[name] = (calls[name] || 0) + 1; };
      return {
        calls,
        refreshTaskIds: [],
        registerRefreshTask: (callback, intervalMs) => { state.tasks.push({ callback, intervalMs }); },
        updateLocalTime: record("refreshLocalTime"),
        refreshDashboard: record("refreshDashboard"),
        refreshAmpDashboard: record("refreshAmpDashboard"),
        refreshPlayitStatus: record("refreshPlayitStatus"),
        refreshInstances: record("refreshInstances"),
        refreshConsoleMetrics: record("refreshConsoleMetrics"),
        refreshConsoleLogs: record("refreshConsoleLogs"),
        refreshMarketplaceDownloads: record("refreshMarketplaceDownloads"),
        refreshAgentControl: record("refreshAgentControl"),
        refreshInstanceLogs: record("refreshInstanceLogs"),
        consolePauseInput: { checked: false },
        instanceConsolePauseInput: { checked: false },
        AMP_REFRESH_INTERVAL_MS: 60000,
        shouldSkipNodeScopedPolling: () => false,
        getActivePageName: () => state.page,
      };
    },
  });
  sandbox.state = state;
  return sandbox;
}

function driveRefreshTasks(sandbox, page) {
  clearRecordedCalls(sandbox);
  sandbox.state.page = page;
  sandbox.state.tasks.forEach((task) => task.callback());
  return sandbox.context.calls;
}

function scenarioPollers(source) {
  const checker = createChecker();
  const sandbox = createPollerSandbox(source);

  checker.check("no refresh task refreshes instances (the 5 s page poller owns them)", () => {
    const onInstances = driveRefreshTasks(sandbox, "instances");
    assert.strictEqual(onInstances.refreshInstances || 0, 0, "the Instances page must not have two instance pollers");
    assert.strictEqual(driveRefreshTasks(sandbox, "dashboard").refreshInstances, 1, "the dashboard must still refresh instances once");
    assert.strictEqual(driveRefreshTasks(sandbox, "console").refreshInstances, 1, "the console workspace must still refresh instances once");
  });

  checker.check("no refresh task fetches console logs (the 2 s page timer owns them)", () => {
    ["console", "instances", "dashboard"].forEach((page) => {
      const calls = driveRefreshTasks(sandbox, page);
      assert.strictEqual(calls.refreshConsoleLogs || 0, 0, `no refresh task may call refreshConsoleLogs (page=${page})`);
    });
    assert.strictEqual(driveRefreshTasks(sandbox, "console").refreshConsoleMetrics, 1, "console metrics must still be refreshed by the 3 s task");
    assert.strictEqual(driveRefreshTasks(sandbox, "dashboard").refreshConsoleMetrics || 0, 0, "console metrics must not refresh off the console page");
  });

  checker.check("no refresh task refreshes agent control (the 3 s page timer owns it)", () => {
    ["agent-control", "dashboard"].forEach((page) => {
      const calls = driveRefreshTasks(sandbox, page);
      assert.strictEqual(calls.refreshAgentControl || 0, 0, `no refresh task may call refreshAgentControl (page=${page})`);
    });
  });

  checker.check("the marketplace download task stands down while the install poller owns the source", () => {
    sandbox.run("marketplaceInstallPollActive = true;");
    assert.strictEqual(driveRefreshTasks(sandbox, "marketplace").refreshMarketplaceDownloads || 0, 0, "the 1 s install poller must be the only owner during an install");
    sandbox.run("marketplaceInstallPollActive = false;");
    assert.strictEqual(driveRefreshTasks(sandbox, "marketplace").refreshMarketplaceDownloads, 1, "the 2 s task must resume ownership once the install poller is cleared");
    assert.strictEqual(driveRefreshTasks(sandbox, "dashboard").refreshMarketplaceDownloads || 0, 0);
  });

  checker.check("the surviving agent-control poller is 3 s, page-scoped, and its callback fires", () => {
    sandbox.run("agentControlPollTimer = null; getActivePageName = () => 'agent-control';");
    sandbox.run("startAgentControlPolling();");
    const timer = activeTimer(sandbox, "agentControlPollTimer");
    assert.strictEqual(timer.kind, "interval");
    clearRecordedCalls(sandbox);
    timer.handler();
    assert.strictEqual(sandbox.context.calls.refreshAgentControl, 1, "the 3 s timer must refresh agent control on its page");
    sandbox.run("getActivePageName = () => 'dashboard';");
    clearRecordedCalls(sandbox);
    timer.handler();
    assert.strictEqual(sandbox.context.calls.refreshAgentControl || 0, 0, "it must not refresh off its page");
    sandbox.run("stopAgentControlPolling();");
    assert.strictEqual(sandbox.run("agentControlPollTimer"), null, "stopping must clear the handle");
  });

  checker.check("the surviving console-log poller is 2 s and state-aware (pause + selected instance)", () => {
    sandbox.run("getActivePageName = () => 'console'; activeConsoleInstanceId = 'inst-1'; consolePauseInput.checked = false; monitoringConsolePollTimerId = null;");
    assert.strictEqual(sandbox.run("shouldPollMonitoringConsole()"), true);
    sandbox.run("startMonitoringConsolePolling();");
    const timer = activeTimer(sandbox, "monitoringConsolePollTimerId");
    clearRecordedCalls(sandbox);
    timer.handler();
    assert.strictEqual(sandbox.context.calls.refreshConsoleLogs, 1, "the 2 s console poller must fetch logs");
    sandbox.run("consolePauseInput.checked = true;");
    clearRecordedCalls(sandbox);
    timer.handler();
    assert.strictEqual(sandbox.context.calls.refreshConsoleLogs || 0, 0, "a paused console must not be polled");
    sandbox.run("consolePauseInput.checked = false; activeConsoleInstanceId = null;");
    clearRecordedCalls(sandbox);
    timer.handler();
    assert.strictEqual(sandbox.context.calls.refreshConsoleLogs || 0, 0, "no selected instance means nothing to poll");
    sandbox.run("stopMonitoringConsolePolling();");
  });

  checker.check("the surviving instances poller is 5 s and holds off during an instance action", () => {
    sandbox.run("getActivePageName = () => 'instances'; document.hidden = false; instanceActionRequestInFlight = false; instancesPagePollTimerId = null;");
    sandbox.run("startInstancesPagePolling();");
    const timer = activeTimer(sandbox, "instancesPagePollTimerId");
    clearRecordedCalls(sandbox);
    timer.handler();
    assert.strictEqual(sandbox.context.calls.refreshInstances, 1);
    sandbox.run("instanceActionRequestInFlight = true;");
    clearRecordedCalls(sandbox);
    timer.handler();
    assert.strictEqual(sandbox.context.calls.refreshInstances || 0, 0, "an in-flight instance action must hold off the poll");
    sandbox.run("instanceActionRequestInFlight = false; getActivePageName = () => 'dashboard';");
    clearRecordedCalls(sandbox);
    timer.handler();
    assert.strictEqual(sandbox.context.calls.refreshInstances || 0, 0, "leaving the page must stop the poll");
    assert.strictEqual(sandbox.run("instancesPagePollTimerId"), null, "the poller must clear itself when the page changes");
  });

  checker.check("the surviving instance-console poller is still registered for the Instances console tab", () => {
    sandbox.run("getActivePageName = () => 'instances'; activeInstanceTab = 'console'; selectedInstanceId = 'inst-1'; instanceConsolePauseInput.checked = false; instanceConsolePollTimerId = null;");
    assert.strictEqual(sandbox.run("shouldPollInstanceConsole()"), true);
    sandbox.run("startInstanceConsolePolling();");
    const timer = activeTimer(sandbox, "instanceConsolePollTimerId");
    clearRecordedCalls(sandbox);
    timer.handler();
    assert.strictEqual(sandbox.context.calls.refreshInstanceLogs, 1);
    sandbox.run("stopInstanceConsolePolling();");
  });

  return checker;
}

// ============================================================================
// SMOOTH-2004 / 2005 / 2015 — files drag, monaco layout, sticky offsets
// ============================================================================

function createFilesSandbox(source) {
  const effects = { sshResizes: 0 };
  const elements = {
    shell: createFakeElement("section"),
    connectBar: createFakeElement("div"),
    passwordPrompt: createFakeElement("div"),
  };
  elements.connectBar.offsetHeight = 40;
  elements.passwordPrompt.hidden = true;
  const sandbox = createSandbox({
    source,
    functions: [
      "rafThrottle",
      "syncFilesResizeSeparator",
      "setFilesExplorerWidth",
      "setFilesStorageWidth",
      "setFilesDetailsWidth",
      "startFilesDividerDrag",
      "updateFilesDividerDrag",
      "stopFilesDividerDrag",
      "startFilesPanelResize",
      "updateFilesPanelResize",
      "stopFilesPanelResize",
      "updateFilesStickyOffsets",
    ],
    ranges: [
      [
        "window.addEventListener(\"resize\", rafThrottle(() => {",
        "}));\n// The drag updaters are gated before any work.",
      ],
      [
        "const applyFilesDragPointerMove = rafThrottle((clientX) => {",
        "stopFilesPanelResize();\n});",
      ],
    ],
    lines: [
      "let filesDividerDragState = null;",
      "let filesPanelDragState = null;",
      "let filesExplorerWidth = 320;",
      "let filesStorageWidth = 260;",
      "let filesDetailsWidth = 260;",
      "let filesStickyOffsetPx = null;",
      "let filesViewMode = \"browse\";",
      "let monacoEditorInstance = null;",
      "const FILES_EXPLORER_WIDTH_STORAGE_KEY = \"anxos.files.explorerWidth.v1\";",
      "const FILES_STORAGE_WIDTH_STORAGE_KEY = \"anxos.files.storageWidth.v1\";",
      "const FILES_DETAILS_WIDTH_STORAGE_KEY = \"anxos.files.detailsWidth.v1\";",
      "const DEFAULT_FILES_EXPLORER_WIDTH = 320;",
      "const MIN_FILES_EXPLORER_WIDTH = 220;",
      "const MAX_FILES_EXPLORER_WIDTH = 520;",
      "const DEFAULT_FILES_STORAGE_WIDTH = 260;",
      "const MIN_FILES_STORAGE_WIDTH = 220;",
      "const MAX_FILES_STORAGE_WIDTH = 420;",
      "const DEFAULT_FILES_DETAILS_WIDTH = 260;",
      "const MIN_FILES_DETAILS_WIDTH = 220;",
      "const MAX_FILES_DETAILS_WIDTH = 420;",
    ],
    globals: (doc) => ({
      fileManagerShell: elements.shell,
      filesConnectBar: elements.connectBar,
      filesPasswordPrompt: elements.passwordPrompt,
      filesDivider: doc.createElement("div"),
      filesStorageDivider: doc.createElement("div"),
      filesDetailsDivider: doc.createElement("div"),
      resizeActiveSshSession: () => { effects.sshResizes += 1; },
      __elements: elements,
      __effects: effects,
    }),
  });
  sandbox.elements = elements;
  sandbox.effects = effects;
  sandbox.run("monacoEditorInstance = { layoutCount: 0, layout() { this.layoutCount += 1; } }; filesViewMode = 'edit';");
  return sandbox;
}

function scenarioFilesDrag(source) {
  const checker = createChecker();
  const sandbox = createFilesSandbox(source);
  const explorerWidthWrites = () => sandbox.elements.shell.counts.styleWrites["--files-explorer-width"] || 0;
  const stickyWrites = () => sandbox.elements.shell.counts.styleWrites["--files-sticky-offset"] || 0;
  const monacoLayouts = () => sandbox.run("monacoEditorInstance.layoutCount");

  checker.check("an idle mousemove does no work at all and schedules no frame", () => {
    const writesBefore = explorerWidthWrites();
    for (let index = 0; index < 25; index += 1) sandbox.win.emit("mousemove", { clientX: 100 + index });
    assert.strictEqual(sandbox.run("filesDividerDragState"), null, "no drag should be active");
    assert.strictEqual(sandbox.win.pendingFrames(), 0, "an idle mousemove must not schedule an animation frame");
    assert.strictEqual(sandbox.win.runFrame(), 0, "there must be nothing to run");
    assert.strictEqual(explorerWidthWrites(), writesBefore, "an idle mousemove must not write the width");
    assert.strictEqual(monacoLayouts(), 0);
  });

  checker.check("a live drag applies at most one width write per frame, with the latest position", () => {
    sandbox.run("startFilesDividerDrag(200);");
    const writesBefore = explorerWidthWrites();
    for (let index = 0; index < 30; index += 1) sandbox.win.emit("mousemove", { clientX: 200 + index });
    assert.strictEqual(explorerWidthWrites(), writesBefore, "coalesced pointer moves must not write before the frame runs");
    assert.strictEqual(sandbox.win.pendingFrames(), 1, "a burst of pointer moves must schedule exactly one frame");
    assert.strictEqual(sandbox.win.runFrame(), 1);
    assert.strictEqual(explorerWidthWrites(), writesBefore + 1, "one frame must produce exactly one width write");
    assert.strictEqual(sandbox.run("filesExplorerWidth"), 349, "the frame must use the latest pointer position (320 + 29)");
  });

  checker.check("no monaco layout runs during the drag, and exactly one runs at drag end", () => {
    assert.strictEqual(monacoLayouts(), 0, "no layout may have run during the drag");
    for (let index = 0; index < 10; index += 1) sandbox.win.emit("mousemove", { clientX: 260 + index });
    sandbox.win.runFrame();
    assert.strictEqual(monacoLayouts(), 0, "monaco.layout() must not be called per mousemove or per drag frame");
    sandbox.win.emit("mouseup", { clientX: 300 });
    assert.strictEqual(sandbox.run("filesDividerDragState"), null, "mouseup must end the drag");
    assert.strictEqual(sandbox.win.pendingFrames() >= 1, true, "the drag-end path must schedule the layout frame");
    sandbox.win.runFrame();
    assert.strictEqual(monacoLayouts(), 1, "exactly one monaco.layout() must run after the drag ends");
  });

  checker.check("the mouseup release position is what the drag ends on", () => {
    sandbox.run("startFilesDividerDrag(500);");
    const startWidth = sandbox.run("filesExplorerWidth");
    sandbox.win.emit("mousemove", { clientX: 540 });
    sandbox.win.emit("mouseup", { clientX: 570 });
    assert.strictEqual(
      sandbox.run("filesExplorerWidth"),
      startWidth + 70,
      "the release point must win over the last coalesced frame",
    );
  });

  checker.check("the window-resize path is coalesced and lays out monaco once per frame", () => {
    sandbox.win.runFrame(); // drain the drag-end layout frame left pending above
    sandbox.run("monacoEditorInstance.layoutCount = 0;");
    const sshBefore = sandbox.effects.sshResizes;
    for (let index = 0; index < 12; index += 1) sandbox.win.emit("resize", {});
    assert.strictEqual(sandbox.effects.sshResizes, sshBefore, "coalesced resizes must not run before the frame");
    assert.strictEqual(sandbox.win.runFrame(), 1, "12 resizes must schedule exactly one frame");
    assert.strictEqual(sandbox.effects.sshResizes, sshBefore + 1, "one frame must resize the SSH session once");
    assert.strictEqual(monacoLayouts(), 1, "one frame must lay out monaco once");
  });

  checker.check("an unchanged sticky offset is not rewritten", () => {
    sandbox.run("updateFilesStickyOffsets();");
    const writesBefore = stickyWrites();
    assert.strictEqual(writesBefore, 1, "the first call must write the offset");
    sandbox.run("updateFilesStickyOffsets(); updateFilesStickyOffsets(); updateFilesStickyOffsets();");
    assert.strictEqual(stickyWrites(), writesBefore, "repeated identical offsets must not rewrite the custom property");
    sandbox.elements.connectBar.offsetHeight = 80;
    sandbox.run("updateFilesStickyOffsets();");
    assert.strictEqual(stickyWrites(), writesBefore + 1, "a changed offset must be written");
    assert.strictEqual(sandbox.run("fileManagerShell.style.getPropertyValue('--files-sticky-offset')"), "80px");
  });

  checker.check("the throttled registrations stay wired and coalesce their callbacks", () => {
    const wired = createSandbox({
      source,
      functions: ["rafThrottle"],
      ranges: [
        ["window.addEventListener(\"resize\", rafThrottle(syncSidebarViewportState));", "window.addEventListener(\"resize\", rafThrottle(syncSidebarViewportState));"],
        ["window.addEventListener(\"resize\", rafThrottle(positionNodePicker));", "window.addEventListener(\"scroll\", rafThrottle(positionNodePicker), true);"],
        ["fileEditor?.addEventListener(\"scroll\", rafThrottle(syncFileEditorLineScroll));", "fileEditor?.addEventListener(\"scroll\", rafThrottle(syncFileEditorLineScroll));"],
      ],
      globals: () => {
        const calls = { sidebar: 0, picker: 0, gutter: 0 };
        return {
          calls,
          syncSidebarViewportState: () => { calls.sidebar += 1; },
          positionNodePicker: () => { calls.picker += 1; },
          syncFileEditorLineScroll: () => { calls.gutter += 1; },
          fileEditor: createFakeElement("div"),
        };
      },
    });
    for (let index = 0; index < 20; index += 1) wired.win.emit("resize", {});
    for (let index = 0; index < 20; index += 1) wired.win.emit("scroll", {});
    wired.run("fileEditor.listeners.scroll[0]({});");
    for (let index = 0; index < 20; index += 1) wired.run("fileEditor.listeners.scroll[0]({});");
    assert.strictEqual(wired.context.calls.sidebar, 0, "20 resizes must not produce 20 sidebar syncs");
    assert.strictEqual(wired.context.calls.picker, 0, "20 scrolls must not produce 20 picker repositions");
    assert.strictEqual(wired.context.calls.gutter, 0, "20 editor scrolls must not produce 20 gutter syncs");
    wired.win.runFrame();
    assert.strictEqual(wired.context.calls.sidebar, 1, "the sidebar sync must still run once per frame");
    assert.strictEqual(wired.context.calls.picker, 2, "the resize and scroll picker registrations must each run once per frame");
    assert.strictEqual(wired.context.calls.gutter, 1, "the gutter sync must still run once per frame");
  });

  return checker;
}

// ============================================================================
// SMOOTH-2006 — marketplace scroll: one pass per frame, debounced persist
// ============================================================================

const MARKETPLACE_SCROLL_START = "const persistMarketplaceViewStateDebounced = debounce(persistMarketplaceViewState, 250);";
const MARKETPLACE_SCROLL_END = "marketplaceGrid?.addEventListener(\"scroll\", handleMarketplaceGridScroll);";

function createMarketplaceSandbox(source) {
  const geometry = { scrollTop: 0, clientHeight: 500, scrollHeight: 2000, reads: 0 };
  const grid = createFakeElement("div");
  ["scrollTop", "clientHeight", "scrollHeight"].forEach((property) => {
    Object.defineProperty(grid, property, {
      get() { geometry.reads += 1; return geometry[property]; },
      set(next) { geometry[property] = next; },
      configurable: true,
    });
  });
  const calls = { persist: 0, loadMore: 0 };
  const sandbox = createSandbox({
    source,
    functions: ["debounce", "rafThrottle"],
    ranges: [[MARKETPLACE_SCROLL_START, MARKETPLACE_SCROLL_END]],
    globals: () => ({
      calls,
      geometry,
      marketplaceGrid: grid,
      persistMarketplaceViewState: () => { calls.persist += 1; },
      loadMarketplaceProviderPacks: () => { calls.loadMore += 1; },
      isMarketplaceProviderBrowserActive: () => true,
      marketplaceProviderHasMore: true,
      marketplaceProviderRequestInFlight: false,
    }),
  });
  sandbox.geometry = geometry;
  sandbox.calls = calls;
  sandbox.grid = grid;
  return sandbox;
}

function scenarioMarketplaceScroll(source) {
  const checker = createChecker();
  const sandbox = createMarketplaceSandbox(source);

  checker.check("a scroll burst does no work until the frame runs", () => {
    sandbox.geometry.reads = 0;
    for (let index = 0; index < 30; index += 1) sandbox.grid.dispatch("scroll", {});
    assert.strictEqual(sandbox.geometry.reads, 0, "30 scroll events must not read scroll geometry 30 times");
    assert.strictEqual(sandbox.calls.persist, 0, "30 scroll events must not serialise the view state 30 times");
    assert.strictEqual(sandbox.win.pendingFrames(), 1, "a scroll burst must schedule exactly one frame");
  });

  checker.check("one frame reads the scroll geometry once and defers the persistence", () => {
    sandbox.win.runFrame();
    assert.strictEqual(sandbox.geometry.reads, 3, "one frame must read the three geometry values exactly once each");
    assert.strictEqual(sandbox.calls.persist, 0, "the frame must not serialise the view state synchronously");
    assert.strictEqual(sandbox.win.runTimers() >= 1, true, "the debounced persistence must have a pending timer");
    assert.strictEqual(sandbox.calls.persist, 1, "the debounce must fire the persistence exactly once");
  });

  checker.check("the near-bottom check still loads the next page", () => {
    sandbox.geometry.scrollTop = 1500;
    sandbox.grid.dispatch("scroll", {});
    sandbox.win.runFrame();
    assert.strictEqual(sandbox.calls.loadMore, 1, "reaching the bottom must still load the next page");
    sandbox.geometry.scrollTop = 0;
    sandbox.grid.dispatch("scroll", {});
    sandbox.win.runFrame();
    assert.strictEqual(sandbox.calls.loadMore, 1, "not being near the bottom must not load more");
  });

  return checker;
}

// ============================================================================
// SMOOTH-1008 — the console log filter skips the row-text read when idle
// ============================================================================

function scenarioConsoleLogSearch(source) {
  const checker = createChecker();
  const rows = [];
  for (let index = 0; index < 12; index += 1) {
    const row = createFakeElement("li");
    row.textContent = index % 3 === 0 ? `error line ${index}` : `info line ${index}`;
    row.dataset.stream = index % 3 === 0 ? "stderr" : "stdout";
    row.dataset.severity = index % 3 === 0 ? "error" : "info";
    rows.push(row);
  }
  const list = createFakeElement("ul");
  rows.forEach((row) => list.append(row));
  const sandbox = createSandbox({
    source,
    functions: ["syncConsoleLogSearch"],
    globals: () => ({
      instancesLogList: list,
      instanceConsoleSearchInput: { value: "" },
      instanceConsoleFilterSelect: { value: "all" },
    }),
  });
  const totalReads = () => rows.reduce((total, row) => total + row.reads.textContent, 0);
  const resetReads = () => rows.forEach((row) => { row.reads.textContent = 0; });

  checker.check("an empty query filters without reading any row text", () => {
    sandbox.run("instanceConsoleSearchInput.value = ''; instanceConsoleFilterSelect.value = 'all';");
    resetReads();
    sandbox.run("syncConsoleLogSearch();");
    assert.strictEqual(totalReads(), 0, `an empty query must not read row text (read ${totalReads()} times)`);
    assert.strictEqual(rows.every((row) => row.hidden === false), true, "an empty query must show every row");
  });

  checker.check("a real query still matches and hides the same rows as before", () => {
    sandbox.run("instanceConsoleSearchInput.value = 'error line 6';");
    resetReads();
    sandbox.run("syncConsoleLogSearch();");
    assert.strictEqual(totalReads(), rows.length, "a real query must read each row's text once");
    assert.strictEqual(rows.filter((row) => !row.hidden).length, 1);
    assert.strictEqual(rows[6].hidden, false);
  });

  checker.check("the stream/severity filter still applies with an empty query", () => {
    sandbox.run("instanceConsoleSearchInput.value = ''; instanceConsoleFilterSelect.value = 'stderr'; syncConsoleLogSearch();");
    assert.strictEqual(rows.filter((row) => !row.hidden).length, 4, "the four stderr rows must be shown");
    assert.strictEqual(rows[3].hidden, false, "row 3 is stderr and must stay visible");
    assert.strictEqual(rows[1].hidden, true, "row 1 is stdout and must be hidden");
  });

  return checker;
}

// ============================================================================
// SMOOTH-2011 — getActivePageName stops re-querying the document
// ============================================================================

function createActivePageSandbox(source) {
  const counters = { queries: 0 };
  const activePage = { dataset: { page: "files" } };
  const sandbox = createSandbox({
    source,
    functions: ["getActivePageName"],
    lines: ["let activePageName = \"\";"],
    globals: () => ({ __counters: counters }),
  });
  sandbox.doc.querySelector = (selector) => {
    counters.queries += 1;
    return selector === ".page.is-active" ? activePage : null;
  };
  sandbox.counters = counters;
  return sandbox;
}

function scenarioActivePage(source) {
  const checker = createChecker();
  const sandbox = createActivePageSandbox(source);

  checker.check("the first read falls back to the DOM exactly once", () => {
    sandbox.counters.queries = 0;
    assert.strictEqual(sandbox.run("getActivePageName()"), "files");
    assert.strictEqual(sandbox.counters.queries, 1);
  });

  checker.check("repeated reads (including the 1 Hz dashboard poll) do not query the document", () => {
    sandbox.counters.queries = 0;
    for (let index = 0; index < 100; index += 1) sandbox.run("getActivePageName()");
    assert.strictEqual(sandbox.counters.queries, 0, `100 reads must not query the document (queried ${sandbox.counters.queries} times)`);
  });

  checker.check("the accessor returns what showPage tracked", () => {
    sandbox.run("activePageName = 'marketplace';");
    assert.strictEqual(sandbox.run("getActivePageName()"), "marketplace");
    assert.strictEqual(sandbox.counters.queries, 0);
  });

  checker.check("showPage assigns the tracked page at the DOM-authoritative point", () => {
    const pageLoop = source.indexOf('page.classList.toggle("is-active", page.dataset.page === safePageName);');
    const assignment = source.indexOf("activePageName = safePageName;");
    assert.ok(pageLoop > 0, "the page visibility loop must still be present");
    assert.ok(assignment > pageLoop, "the assignment must follow the visibility loop");
    assert.ok(
      source.indexOf("storeLastPageName(safePageName);", assignment) > assignment,
      "the assignment must precede the rest of showPage's branches",
    );
  });

  return checker;
}

// ============================================================================
// SMOOTH-2017 — the settings search result list is pooled and delegated
// ============================================================================

function createSettingsSearchSandbox(source) {
  const results = createFakeElement("div", { hidden: true });
  const calls = { activated: [] };
  const sandbox = createSandbox({
    source,
    functions: [
      "renderSettingsSearch",
      "ensureSettingsSearchResultPool",
      "bindSettingsSearchResultDelegate",
    ],
    lines: ["const SETTINGS_SEARCH_RESULT_LIMIT = 8;"],
    globals: () => ({
      settingsSearchResults: results,
      settingsSearchInput: createFakeElement("input"),
      settingsSearchResultPool: { buttons: [], empty: null },
      settingsSearchMatches: [],
      settingsSearchDelegateBound: false,
      getSettingSearchEntries: () => [
        { category: "general", title: "General settings", selector: "[data-settings-category=\"general\"]", haystack: "general settings start with anxos" },
        { category: "network", title: "Network", selector: "[data-settings-category=\"network\"]", haystack: "network port proxy" },
      ],
      setActiveSettingsCategory: (category, selector) => { calls.activated.push({ category, selector }); },
      __calls: calls,
    }),
  });
  sandbox.results = results;
  sandbox.calls = calls;
  return sandbox;
}

function scenarioSettingsSearch(source) {
  const checker = createChecker();
  const sandbox = createSettingsSearchSandbox(source);
  const renderedQuery = (query) => sandbox.run(`settingsSearchInput.value = ${JSON.stringify(query)}; renderSettingsSearch();`);
  const buttons = () => sandbox.results.children.filter((child) => child.tagName === "BUTTON");
  const visibleButtons = () => buttons().filter((button) => button.hidden === false);

  checker.check("the first render creates the pool exactly once", () => {
    renderedQuery("general");
    assert.strictEqual(buttons().length, 8, "the pool must hold the full result limit");
    assert.strictEqual(sandbox.doc.createElementCounts.button || 0, 8, "exactly 8 buttons may be created");
    assert.strictEqual(visibleButtons().length, 1, "only the matching entry is visible");
  });

  checker.check("later keystrokes update text instead of creating elements or listeners", () => {
    const createdBefore = sandbox.doc.createElementCounts.button || 0;
    assert.strictEqual(sandbox.results.counts.listeners.click || 0, 1, "exactly one delegated click listener must be bound");
    ["n", "ne", "net", "netw", "network"].forEach(renderedQuery);
    assert.strictEqual(sandbox.doc.createElementCounts.button || 0, createdBefore, "no result element may be created after the pool exists");
    assert.strictEqual(sandbox.results.counts.listeners.click || 0, 1, "no additional click listener may be bound");
    assert.strictEqual(sandbox.results.counts.replaceChildren, 1, "the container may only be cleared when the pool was built");
    assert.strictEqual(visibleButtons().length, 1);
    assert.strictEqual(visibleButtons()[0].textContent, "Network", "the visible button must carry the latest match's title");
    assert.strictEqual(visibleButtons()[0].dataset.settingsCategory, "network");
  });

  checker.check("the empty state is still announced and the panel still hides itself", () => {
    renderedQuery("zzzz");
    const empty = sandbox.results.children.find((child) => child.tagName === "P");
    assert.ok(empty && empty.hidden === false, "no matches must reveal the empty message");
    assert.strictEqual(empty.textContent, "No matching settings.");
    assert.strictEqual(sandbox.run("settingsSearchResults.hidden"), false);
    renderedQuery("");
    assert.strictEqual(sandbox.run("settingsSearchResults.hidden"), true);
    assert.strictEqual(sandbox.results.children.every((child) => child.hidden === true), true, "an empty query must hide every child");
  });

  checker.check("clicking a result still activates its category through the one delegated listener", () => {
    renderedQuery("network");
    const button = visibleButtons()[0];
    assert.ok(button, "a visible result is required");
    sandbox.calls.activated = [];
    sandbox.results.dispatch("click", { target: button });
    assert.deepStrictEqual(sandbox.calls.activated, [{ category: "network", selector: "[data-settings-category=\"network\"]" }]);
    assert.strictEqual(sandbox.run("settingsSearchResults.hidden"), true, "activating a result must hide the panel");
  });

  checker.check("a container cleared elsewhere is re-pooled without double-binding", () => {
    sandbox.results.replaceChildren();
    renderedQuery("general");
    assert.strictEqual(buttons().length, 8, "the pool must be rebuilt after an external clear");
    assert.strictEqual(sandbox.results.counts.listeners.click || 0, 1, "the delegate must not be bound twice");
  });

  return checker;
}

// ============================================================================
// mutation teeth
// ============================================================================

const TEETH = [
  {
    label: "SMOOTH-2002 rebuild restored (renderGameConfigPanel on every keystroke)",
    scenario: "gameConfig",
    expect: "does not rebuild the panel",
    mutate: (sourceValue) => mutate(
      sourceValue,
      "  gameConfigState.values[field.key] = normalizeGameConfigInputValue(field, input);",
      "  gameConfigState.values = collectGameConfigValues();\n  renderGameConfigPanel();",
    ),
  },
  {
    label: "SMOOTH-2003 duplicate agent-control poller restored (5 s)",
    scenario: "pollers",
    expect: "agent control",
    mutate: (sourceValue) => mutate(
      sourceValue,
      REFRESH_TASK_START,
      `${REFRESH_TASK_START}\nregisterRefreshTask(() => { if (getActivePageName() === "agent-control" && !document.hidden) refreshAgentControl(); }, 5000);`,
    ),
  },
  {
    label: "SMOOTH-2003 duplicate console-log fetch restored in the 3 s task",
    scenario: "pollers",
    expect: "console logs",
    mutate: (sourceValue) => mutate(
      sourceValue,
      "    refreshConsoleMetrics();\n  }\n}, 3000);",
      "    refreshConsoleMetrics();\n    refreshConsoleLogs({ silent: true });\n  }\n}, 3000);",
    ),
  },
  {
    label: "SMOOTH-2003 marketplace install-poll gate removed",
    scenario: "pollers",
    expect: "install poller",
    mutate: (sourceValue) => mutate(
      sourceValue,
      "  if (marketplaceInstallPollActive) return;\n",
      "",
    ),
  },
  {
    label: "SMOOTH-2004 per-mousemove monaco layout restored",
    scenario: "files",
    expect: "monaco",
    mutate: (sourceValue) => mutate(
      sourceValue,
      "setFilesExplorerWidth(filesDividerDragState.startWidth + delta, { persist: false, layout: false });",
      "setFilesExplorerWidth(filesDividerDragState.startWidth + delta, { persist: false });",
    ),
  },
  {
    label: "SMOOTH-2005 mousemove drag gate removed",
    scenario: "files",
    expect: "idle mousemove",
    mutate: (sourceValue) => mutate(
      sourceValue,
      "if (!filesDividerDragState && !filesPanelDragState) return;",
      "if (false) return;",
    ),
  },
  {
    label: "SMOOTH-2015 sticky-offset write guard removed",
    scenario: "files",
    expect: "unchanged sticky offset",
    mutate: (sourceValue) => mutate(
      sourceValue,
      "  if (filesStickyOffsetPx === nextOffset) {\n    return;\n  }\n",
      "",
    ),
  },
  {
    label: "SMOOTH-2006 throttle + debounce removed (per-event handler restored)",
    scenario: "marketplaceScroll",
    expect: "scroll",
    mutate: (sourceValue) => {
      // Neutralise each of the two guards separately, in place, so the rest of
      // the block (and the registration line the scenario extracts) survives.
      const synchronousThrottle = mutate(
        sourceValue,
        "const handleMarketplaceGridScroll = rafThrottle(() => {",
        "const handleMarketplaceGridScroll = ((callback) => (...args) => callback(...args))(() => {",
      );
      return mutate(
        synchronousThrottle,
        "  persistMarketplaceViewStateDebounced();",
        "  persistMarketplaceViewState();",
      );
    },
  },
  {
    label: "SMOOTH-1008 unconditional row-text read restored",
    scenario: "consoleLogSearch",
    expect: "empty query",
    mutate: (sourceValue) => mutate(
      sourceValue,
      "    const matchesQuery = !query || row.textContent.toLowerCase().includes(query);\n    const matchesFilter =",
      "    const text = row.textContent.toLowerCase();\n    const matchesQuery = !query || text.includes(query);\n    const matchesFilter =",
    ),
  },
  {
    label: "SMOOTH-2011 document query restored on every read",
    scenario: "activePage",
    expect: "repeated reads",
    mutate: (sourceValue) => mutate(
      sourceValue,
      "  if (!activePageName) {\n    activePageName = document.querySelector(\".page.is-active\")?.dataset.page || \"dashboard\";\n  }\n  return activePageName;",
      "  return document.querySelector(\".page.is-active\")?.dataset.page || \"dashboard\";",
    ),
  },
  {
    label: "SMOOTH-2017 per-render result elements restored",
    scenario: "settingsSearch",
    expect: "later keystrokes",
    mutate: (sourceValue) => mutate(
      sourceValue,
      '  pool.buttons.forEach((button, index) => {\n    const entry = matches[index];\n    button.hidden = !entry;\n    if (!entry) return;\n    button.textContent = entry.title;\n    button.dataset.settingsCategory = entry.category || "";\n  });',
      '  settingsSearchResults.replaceChildren();\n  matches.forEach((entry) => {\n    const button = document.createElement("button");\n    button.type = "button";\n    button.textContent = entry.title;\n    button.addEventListener("click", () => setActiveSettingsCategory(entry.category, entry.selector));\n    settingsSearchResults.append(button);\n  });',
    ),
  },
];

const SCENARIOS = {
  gameConfig: scenarioGameConfig,
  pollers: scenarioPollers,
  files: scenarioFilesDrag,
  marketplaceScroll: scenarioMarketplaceScroll,
  consoleLogSearch: scenarioConsoleLogSearch,
  activePage: scenarioActivePage,
  settingsSearch: scenarioSettingsSearch,
};

// --- run --------------------------------------------------------------------

const totals = { failures: 0, passed: 0 };

console.log("Smoothness wasted-work smoke");
console.log("============================");

Object.entries(SCENARIOS).forEach(([name, scenario]) => {
  console.log(`\n[${name}]`);
  const checker = scenario(REAL_SOURCE);
  totals.passed += checker.state.passed;
  totals.failures += checker.state.failures;
});

console.log("\n[mutation teeth — each must be caught and named]");
CHECKER_QUIET = true;
TEETH.forEach((tooth) => {
  const mutated = tooth.mutate(REAL_SOURCE);
  const checker = SCENARIOS[tooth.scenario](mutated);
  try {
    assert.ok(checker.state.failures > 0, `the mutation was NOT detected — the ${tooth.scenario} scenario has lost its teeth`);
    const named = checker.state.failedLabels.filter((label) => label.includes(tooth.expect));
    assert.ok(
      named.length > 0,
      `caught, but by no assertion naming "${tooth.expect}" (caught: ${checker.state.failedLabels.join(" | ")})`,
    );
    console.log(`  PASS  ${tooth.label} -> caught by "${named[0]}"`);
    totals.passed += 1;
  } catch (error) {
    totals.failures += 1;
    console.error(`  FAIL  ${tooth.label}: ${error.message}`);
  }
});

console.log("\n============================");
if (totals.failures) {
  console.error(`smoothness-wasted-work-smoke FAILED: ${totals.failures} check(s) failed, ${totals.passed} passed.`);
  process.exit(1);
}
console.log(`smoothness-wasted-work-smoke passed (${totals.passed} checks, ${TEETH.length} mutation teeth).`);