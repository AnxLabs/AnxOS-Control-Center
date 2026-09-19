#!/usr/bin/env node
// Regression coverage for F2(a) of the first V2 runtime acceptance pass: the
// node switch never completed and the sidebar stayed on "Switching node…".
//
// ROOT CAUSE (proven from the live renderer log): renderInstanceRestartSchedules
// referenced five identifiers that app.js never declared —
//   restartScheduleList / restartScheduleEmpty / restartScheduleStatus /
//   restartSchedulesState / restartSchedulesRequestInFlight
// — so every call threw `ReferenceError: restartScheduleList is not defined`.
// .dev-logs/renderer.log records that exact stack ten times on 2026-09-19
// (09:09:10Z .. 09:14:45Z) for
//   renderInstanceRestartSchedules -> setInstanceDetails -> renderInstancesUnavailable
//   -> resetNodeScopedRendererState -> selectNode
// Because selectNode() called resetNodeScopedRendererState BEFORE its try
// block, the throw escaped the finally that clears nodeSwitchInProgress, so the
// flag stayed true forever: the sidebar reported "Switching node…" for the rest
// of the session and reloadActiveNodeData never ran (which is why every
// node-scoped surface stayed on its cleared placeholder).
//
// This smoke extracts the REAL declaration statements from app.js and executes
// them in a vm context, then drives the REAL renderInstanceRestartSchedules with
// a fake DOM. Pre-fix the extraction step fails, naming exactly which
// declaration is missing; post-fix the function renders.
//
// What it does NOT prove: that a live window renders the panel, or that any
// particular node switch completes (no Electron and no node are used here).

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const APP_PATH = path.resolve(__dirname, "..", "app.js");
const source = fs.readFileSync(APP_PATH, "utf8");

const REQUIRED_DECLARATIONS = [
  "restartScheduleList",
  "restartScheduleEmpty",
  "restartScheduleStatus",
  "restartSchedulesState",
  "restartSchedulesRequestInFlight",
];

function extractFunction(name) {
  const needle = `function ${name}(`;
  const start = source.indexOf(needle);
  assert(start >= 0, `Could not find function ${name} in app.js.`);
  const open = source.indexOf("{", start);
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

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${label}`);
    console.error(`       ${error.message}`);
  }
}

console.log("F2 node-switch reset crash smoke");

// --- 1. Every identifier the reset path dereferences must be declared --------
// This is the check that names the original defect: a bare reference to an
// undeclared identifier throws on READ in a classic script, so `if (!name)`
// is not a safe guard.
const declarationSources = new Map();
for (const name of REQUIRED_DECLARATIONS) {
  const match = source.match(new RegExp(`^(?:const|let|var) ${name}\\b[^\\n]*$`, "m"));
  declarationSources.set(name, match ? match[0] : null);
}

check("the restart-schedule renderer references only declared identifiers", () => {
  const missing = REQUIRED_DECLARATIONS.filter((name) => !declarationSources.get(name));
  assert.deepStrictEqual(
    missing,
    [],
    `app.js does not declare: ${missing.join(", ")}. The reset path throws ReferenceError on these.`,
  );
});

// --- 2. The reset path must be inside selectNode's unconditional finally -----
check("selectNode's finally covers the node-scoped reset", () => {
  const start = source.indexOf("async function selectNode(");
  assert(start >= 0, "Could not find selectNode in app.js.");
  const body = source.slice(start, source.indexOf("\nfunction getNodeFormPayload()", start));
  const tryIndex = body.indexOf("try {");
  const resetIndex = body.indexOf("resetNodeScopedRendererState(");
  const finallyIndex = body.lastIndexOf("} finally {");
  assert(tryIndex >= 0 && resetIndex >= 0 && finallyIndex >= 0, "selectNode must keep a try/finally around the reset.");
  assert(
    tryIndex < resetIndex,
    "resetNodeScopedRendererState must run inside selectNode's try, or a throw in it strands nodeSwitchInProgress.",
  );
  assert(resetIndex < finallyIndex, "The reset must precede the finally that clears nodeSwitchInProgress.");
});

// --- 3. Behavioural: the real renderer runs against a fake DOM ---------------
function createFakeElement(tagName) {
  const element = {
    tagName: String(tagName || "div").toUpperCase(),
    children: [],
    dataset: {},
    className: "",
    textContent: "",
    title: "",
    hidden: null,
    listeners: {},
    append(...nodes) { nodes.forEach((node) => element.children.push(node)); },
    appendChild(node) { element.children.push(node); return node; },
    replaceChildren(...nodes) { element.children = []; element.append(...nodes); },
    setAttribute(name, value) { element[name] = value; },
    addEventListener(name, handler) { element.listeners[name] = handler; },
  };
  return element;
}

function collectText(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  const own = typeof node.textContent === "string" ? node.textContent : "";
  return [own, ...(node.children || []).map(collectText)].filter(Boolean).join(" ");
}

function createHarness() {
  const bySelector = new Map();
  const document = {
    createElement: (tag) => createFakeElement(tag),
    querySelector: (selector) => {
      if (!bySelector.has(selector)) bySelector.set(selector, createFakeElement("div"));
      return bySelector.get(selector);
    },
  };
  const toggles = [];
  const removals = [];
  const context = {
    console,
    document,
    hasRestartSchedules: true,
    getDesktopApiState: () => ({ hasRestartSchedules: context.hasRestartSchedules }),
    formatRestartScheduleSummary: (schedule) => `summary:${schedule.id}`,
    formatRestartScheduleNextRun: () => "next in 1h",
    setRestartScheduleEnabled: (schedule, enabled) => toggles.push({ id: schedule.id, enabled }),
    deleteRestartScheduleEntry: (schedule) => removals.push(schedule.id),
  };
  vm.createContext(context);
  // The declaration statements come from app.js verbatim: they are what the fix
  // added, and executing them here is what makes this a repro rather than a
  // restatement of the fix.
  const declarations = REQUIRED_DECLARATIONS.map((name) => declarationSources.get(name)).join("\n");
  vm.runInContext(
    // `let` declarations are lexical bindings inside the vm script, so they are
    // not reachable as context properties: expose explicit setters instead.
    `${declarations}\n${extractFunction("renderInstanceRestartSchedules")}\nthis.renderInstanceRestartSchedules = renderInstanceRestartSchedules;\nthis.setRestartSchedulesState = (value) => { restartSchedulesState = value; };`,
    context,
  );
  return {
    context,
    toggles,
    removals,
    list: bySelector.get('[data-restart-schedule-list]'),
    empty: bySelector.get('[data-restart-schedule-empty]'),
    status: bySelector.get('[data-restart-schedule-status]'),
  };
}

check("the real renderer renders rows for the selected instance without throwing", () => {
  const harness = createHarness();
  harness.context.setRestartSchedulesState({
    supported: true,
    instanceId: "server-a",
    schedules: [
      { id: "s1", enabled: true, warnMinutes: 5 },
      { id: "s2", enabled: false, warnMinutes: 10 },
    ],
  });
  harness.context.renderInstanceRestartSchedules({ id: "server-a" });
  const rendered = collectText(harness.list);
  assert(/summary:s1/.test(rendered), `The first schedule must render, got ${JSON.stringify(rendered)}.`);
  assert(/summary:s2/.test(rendered), "The second schedule must render.");
  assert(/enabled/.test(rendered) && /disabled/.test(rendered), "Each row must disclose its enabled state.");
  assert.strictEqual(harness.empty.hidden, true, "The empty state must be hidden when schedules exist.");
  assert.strictEqual(harness.status.textContent, "2 schedules configured", "The status must count the configured schedules.");
  assert.strictEqual(harness.list.children.length, 2, "Exactly one row per schedule must be rendered.");
});

check("the real renderer shows the empty state and an honest status for no selection", () => {
  const harness = createHarness();
  harness.context.setRestartSchedulesState({ supported: true, instanceId: null, schedules: [] });
  harness.context.renderInstanceRestartSchedules(null);
  assert.strictEqual(collectText(harness.list), "", "No rows may be rendered without a selected instance.");
  assert.strictEqual(harness.empty.hidden, false, "The empty state must be visible without schedules.");
  assert.strictEqual(harness.status.textContent, "No instance selected", "The status must say no instance is selected.");
});

check("the real renderer reports an unsupported Agent honestly", () => {
  const harness = createHarness();
  harness.context.setRestartSchedulesState({ supported: false, instanceId: "server-a", schedules: [] });
  harness.context.renderInstanceRestartSchedules({ id: "server-a" });
  assert.strictEqual(harness.status.textContent, "Unavailable", "An unsupported Agent must render as Unavailable, not as zero schedules.");
  assert.strictEqual(collectText(harness.list), "", "An unsupported Agent must not render rows.");
});

check("the real renderer reports an unavailable bridge honestly", () => {
  const harness = createHarness();
  harness.context.hasRestartSchedules = false;
  harness.context.setRestartSchedulesState({ supported: true, instanceId: "server-a", schedules: [{ id: "s1", enabled: true, warnMinutes: 5 }] });
  harness.context.renderInstanceRestartSchedules({ id: "server-a" });
  assert.strictEqual(harness.status.textContent, "Unavailable", "A missing bridge must render as Unavailable.");
});

if (failures) {
  console.error(`\nF2 node-switch reset crash smoke FAILED (${failures} check(s)).`);
  process.exitCode = 1;
} else {
  console.log("\nF2 node-switch reset crash smoke passed.");
}