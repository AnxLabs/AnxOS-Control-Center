// Behavioural checks for Build 210 feedback improvements in app.js:
//   * toasts: errors and warnings stay up long enough to read, a toast saved
//     to the Notification Center opens it on click, hover keeps it up, and
//     plain toasts stay non-interactive;
//   * instance state pills explain each state in their tooltip unless a
//     failed operation explains it instead;
//   * the Instances status filter is remembered, and restored only when the
//     select still offers that value.
// The real functions are extracted from app.js and run against small fakes.
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert(start >= 0, `Could not find function ${name} in app.js.`);
  let cursor = source.indexOf("(", start);
  for (let depth = 0; cursor < source.length; cursor += 1) {
    if (source[cursor] === "(") depth += 1;
    else if (source[cursor] === ")" && --depth === 0) { cursor += 1; break; }
  }
  const open = source.indexOf("{", cursor);
  for (let index = open, depth = 0; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Unbalanced body for ${name}.`);
}

function extractStatement(marker) {
  const start = source.indexOf(marker);
  assert(start >= 0, `Could not find "${marker}" in app.js.`);
  const open = source.indexOf("{", start);
  for (let index = open, depth = 0; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}" && --depth === 0) {
      const end = source.indexOf(";", index);
      return source.slice(start, end + 1);
    }
  }
  throw new Error(`Unbalanced statement for ${marker}.`);
}

function fakeElement() {
  const classes = new Set();
  const listeners = {};
  return {
    dataset: {},
    title: "",
    textContent: "",
    attributes: {},
    classList: {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force) => {
        const on = force === undefined ? !classes.has(name) : Boolean(force);
        if (on) classes.add(name); else classes.delete(name);
        return on;
      },
      contains: (name) => classes.has(name),
    },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(type, handler) { (listeners[type] = listeners[type] || []).push(handler); },
    dispatch(type) { (listeners[type] || []).forEach((handler) => handler({})); },
    listenerCount(type) { return (listeners[type] || []).length; },
  };
}

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`PASS ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${label}: ${error.message}`);
  }
}

// --- toasts -----------------------------------------------------------------
{
  const toast = fakeElement();
  const timers = [];
  const pages = [];
  const context = {
    toast,
    window: {
      setTimeout: (handler, delay) => { timers.push({ handler, delay, cleared: false }); return timers.length; },
      clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    },
    formatFriendlyToastMessage: (message) => ({ message }),
    inferToastTone: (message, tone) => tone || "info",
    shouldPersistToastNotification: (message, tone) => tone === "error" || tone === "warning",
    createNotification: () => {},
    inferNotificationCategoryFromText: () => "general",
    getToastNotificationTitle: () => "",
    sanitizeNotificationText: (value) => value,
    getCurrentSettings: () => ({}),
    showPage: (page) => pages.push(page),
  };
  vm.createContext(context);
  vm.runInContext([
    extractFunction("getToastDurationMs"),
    extractFunction("scheduleToastHide"),
    extractFunction("bindToastInteractions"),
    extractFunction("showToast"),
  ].join("\n\n"), context);
  const lastTimer = () => timers.filter((timer) => !timer.cleared).pop();

  check("errors and warnings stay up longer than plain toasts", () => {
    context.showToast("Saved.", "success");
    assert.strictEqual(lastTimer().delay, 2200);
    context.showToast("Disk is nearly full.", "warning");
    assert.strictEqual(lastTimer().delay, 4500);
    context.showToast("Start failed.", "error");
    assert.strictEqual(lastTimer().delay, 6500);
  });

  check("a saved toast is clickable and opens Notifications", () => {
    context.showToast("Start failed.", "error");
    assert.strictEqual(toast.classList.contains("is-actionable"), true);
    assert.strictEqual(toast.title, "Open in Notifications");
    toast.dispatch("click");
    assert.deepStrictEqual(pages, ["notifications"]);
    assert.strictEqual(toast.classList.contains("is-visible"), false, "clicking dismisses the toast");
  });

  check("a plain toast is not clickable", () => {
    pages.length = 0;
    context.showToast("Saved.", "success");
    assert.strictEqual(toast.classList.contains("is-actionable"), false);
    toast.dispatch("click");
    assert.deepStrictEqual(pages, []);
  });

  check("hover keeps a toast up and leaving hides it after a grace period", () => {
    context.showToast("Start failed.", "error");
    toast.dispatch("mouseenter");
    assert.strictEqual(lastTimer(), undefined, "hover must cancel the hide timer");
    toast.dispatch("mouseleave");
    assert.strictEqual(lastTimer().delay, 1500);
    lastTimer().handler();
    assert.strictEqual(toast.classList.contains("is-visible"), false);
  });

  check("toast listeners are bound once", () => {
    assert.strictEqual(toast.listenerCount("click"), 1);
  });
}

// --- instance state pill tooltips ----------------------------------------------
{
  const context = {
    document: { createElement: () => fakeElement() },
    getInstanceOperation: () => context.__operation,
    getInstanceOperationLabel: () => "Reloading",
    getInstanceStateClass: (state) => String(state || "stopped").trim().toLowerCase().replace(/\s+/g, "-"),
    getInstanceOperationFailureText: (operation) => (operation?.status === "failed" ? "Last restart failed: port in use" : ""),
    __operation: null,
  };
  vm.createContext(context);
  vm.runInContext(`${extractStatement("const INSTANCE_STATE_EXPLANATIONS = {")}\n${extractFunction("buildInstanceStatePill")}\nthis.INSTANCE_STATE_EXPLANATIONS = INSTANCE_STATE_EXPLANATIONS;`, context);

  check("every state the Instances filter offers has a plain-language tooltip", () => {
    ["running", "stopped", "setup-required", "failed"].forEach((state) => {
      assert.ok(context.INSTANCE_STATE_EXPLANATIONS[state], `missing explanation for ${state}`);
    });
    const pill = context.buildInstanceStatePill({ id: "a", state: "Setup Required" });
    assert.match(pill.title, /needs a setting, license or sign-in/);
  });

  check("a failed operation's explanation wins over the state tooltip", () => {
    context.__operation = { status: "failed" };
    const pill = context.buildInstanceStatePill({ id: "a", state: "Running" });
    assert.strictEqual(pill.title, "Last restart failed: port in use");
    context.__operation = null;
  });
}

// --- remembered Instances status filter ----------------------------------------
{
  const block = source.slice(
    source.indexOf("const INSTANCES_STATUS_FILTER_STORAGE_KEY"),
    source.indexOf("instancesFilterSelect?.addEventListener(\"change\""),
  );
  const changeHandler = extractStatement("instancesFilterSelect?.addEventListener(\"change\"");
  const run = (stored, options) => {
    const store = new Map(stored === undefined ? [] : [["anxos:instances-status-filter", stored]]);
    const select = { value: "all", options: options.map((value) => ({ value })), handlers: [], addEventListener(type, handler) { this.handlers.push(handler); } };
    const context = {
      instancesFilterSelect: select,
      filterInstanceRows: () => {},
      localStorage: { getItem: (key) => (store.has(key) ? store.get(key) : null), setItem: (key, value) => store.set(key, value) },
    };
    vm.createContext(context);
    vm.runInContext(`${block}\n${changeHandler}`, context);
    return { select, store };
  };

  check("a remembered status filter is restored", () => {
    const { select } = run("failed", ["all", "running", "stopped", "setup-required", "failed"]);
    assert.strictEqual(select.value, "failed");
  });

  check("a value the select no longer offers is ignored", () => {
    const { select } = run("archived", ["all", "running"]);
    assert.strictEqual(select.value, "all");
  });

  check("changing the filter remembers it", () => {
    const { select, store } = run(undefined, ["all", "running"]);
    select.value = "running";
    select.handlers.forEach((handler) => handler());
    assert.strictEqual(store.get("anxos:instances-status-filter"), "running");
  });

  check("blocked storage never breaks the filter", () => {
    const select = { value: "all", options: [{ value: "all" }], handlers: [], addEventListener(type, handler) { this.handlers.push(handler); } };
    const context = {
      instancesFilterSelect: select,
      filterInstanceRows: () => { context.__filtered = true; },
      localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } },
    };
    vm.createContext(context);
    vm.runInContext(`${block}\n${changeHandler}`, context);
    select.handlers.forEach((handler) => handler());
    assert.strictEqual(context.__filtered, true);
  });
}

if (failures) {
  console.error(`ux-feedback smoke FAILED: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("ux-feedback smoke passed.");
