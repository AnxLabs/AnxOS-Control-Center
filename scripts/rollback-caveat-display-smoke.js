#!/usr/bin/env node
// Behavioral coverage for the V2-J bullet 6 rollback caveat in the update UI.
//
// The real `describeRollbackCaveat` and `renderUpdateRollbackCaveat` functions
// are extracted from app.js and driven with a fake DOM. Guidance objects are
// produced by the REAL `src/services/updateManager` normalizer/evaluator, so
// the surface is exercised with the exact contract the main process emits.
//
// The invariant this file exists for: a downgrade must never be rendered as
// safe unless `rollbackIsSafe === true`.
//
// What it does NOT prove: that the update modal is reached at runtime (no
// Electron is launched) or anything about live layout.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const updateManager = require("../src/services/updateManager");

const APP_PATH = path.resolve(__dirname, "..", "app.js");
const source = fs.readFileSync(APP_PATH, "utf8");

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

const EXTRACTED = ["describeRollbackCaveat", "renderUpdateRollbackCaveat"].map(extractFunction).join("\n\n");

function createFakeElement(tagName) {
  const element = {
    tagName: String(tagName || "div").toUpperCase(),
    children: [],
    dataset: {},
    className: "",
    textContent: "",
    hidden: false,
    append(...nodes) { nodes.forEach((node) => { if (node !== null && node !== undefined) element.children.push(node); }); },
    replaceChildren(...nodes) { element.children = []; element.append(...nodes); },
    setAttribute(name, value) { element[name] = value; },
    addEventListener() {},
  };
  return element;
}

function collectText(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (node.textContent) return String(node.textContent);
  return (node.children || []).map(collectText).join(" ");
}

const context = {
  document: { createElement: (tag) => createFakeElement(tag) },
  createTextElement: (tagName, text = "", className = "") => {
    const element = context.document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text ?? "";
    return element;
  },
};
vm.createContext(context);
vm.runInContext(`${EXTRACTED}\nthis.describeRollbackCaveat = describeRollbackCaveat;\nthis.renderUpdateRollbackCaveat = renderUpdateRollbackCaveat;`, context);

function render(guidance) {
  const container = createFakeElement("section");
  context.renderUpdateRollbackCaveat(guidance, container);
  return container;
}

// --- guidance fixtures built by the real updateManager ----------------------
function guidanceFromManifest(rollback, runningBuild) {
  return updateManager.evaluateRollbackGuidance(updateManager.normalizeRollbackGuidance(rollback), runningBuild);
}

const preservationOnly = guidanceFromManifest({
  preservesUserData: true,
  preservesInstances: true,
  preservesBackups: true,
}, 250);

const safeContract = guidanceFromManifest({
  preservesUserData: true,
  preservationIsNotReadability: true,
  dataSchemaRollback: {
    direction: "backward-compatible",
    summary: { status: "safe" },
    stores: [{ id: "instances", label: "Instances", minimumBuild: 200, downgradeStatus: "safe" }],
  },
}, 250);

const olderBuild = guidanceFromManifest({
  preservesUserData: true,
  preservationIsNotReadability: true,
  dataSchemaRollback: {
    direction: "backward-compatible",
    summary: { status: "safe" },
    stores: [{ id: "instances", label: "Instances", minimumBuild: 300, downgradeStatus: "safe" }],
  },
}, 250);

const degradedContract = guidanceFromManifest({
  preservesUserData: true,
  preservationIsNotReadability: true,
  dataSchemaRollback: {
    direction: "backward-compatible",
    summary: { status: "safe" },
    stores: [
      { id: "instances", label: "Instances", minimumBuild: 200, downgradeStatus: "safe" },
      { id: "audit", label: "Audit log", minimumBuild: 200, downgradeStatus: "degraded" },
    ],
  },
}, 250);

const noGuidance = guidanceFromManifest(null, 250);

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${label}: ${error.message}`);
  }
}

console.log("Rollback caveat display smoke");
console.log("-----------------------------");

check("fixtures: only the SAFE contract with a current build evaluates rollbackIsSafe", () => {
  assert.strictEqual(safeContract.rollbackIsSafe, true, JSON.stringify(safeContract));
  assert.strictEqual(preservationOnly.rollbackIsSafe, false);
  assert.strictEqual(olderBuild.rollbackIsSafe, false);
  assert.strictEqual(degradedContract.rollbackIsSafe, false);
  assert.strictEqual(noGuidance.rollbackIsSafe, false);
});

check("rollbackIsSafe:true renders as safe", () => {
  const caveat = context.describeRollbackCaveat(safeContract);
  assert.strictEqual(caveat.safe, true);
  assert.strictEqual(caveat.tone, "ok");
});

check("preservation-only guidance never renders as safe", () => {
  const container = render(preservationOnly);
  assert.strictEqual(container.dataset.rollbackSafe, "false");
  const text = collectText(container);
  assert.ok(!/safe to roll back/i.test(text), `must not claim safe: ${text}`);
  assert.ok(text.includes(preservationOnly.warning), `the service's warning must be shown verbatim: ${text}`);
});

check("a running build below the data-schema floor renders critical, never safe", () => {
  const container = render(olderBuild);
  assert.strictEqual(container.dataset.rollbackSafe, "false");
  const text = collectText(container);
  assert.ok(container.className.includes("update-rollback-caveat--critical"), container.className);
  assert.ok(/may leave data unreadable/i.test(text), text);
  assert.ok(!/safe to roll back/i.test(text), text);
  assert.ok(text.includes("Instances"), `blocked store must be named: ${text}`);
});

check("a DEGRADED store downgrades an overall-SAFE manifest and is never safe", () => {
  const container = render(degradedContract);
  const text = collectText(container);
  assert.strictEqual(container.dataset.rollbackSafe, "false");
  assert.ok(container.className.includes("update-rollback-caveat--critical"), container.className);
  assert.ok(!/safe to roll back/i.test(text), "must not claim safe");
});

check("a manifest with no contract renders a warning, not nothing", () => {
  const container = render(noGuidance);
  assert.strictEqual(container.hidden, false);
  assert.strictEqual(container.dataset.rollbackSafe, "false");
  assert.ok(!/safe to roll back/i.test(collectText(container)));
});

check("absent/unavailable guidance renders nothing rather than a false reassurance", () => {
  assert.strictEqual(context.describeRollbackCaveat(null), null);
  assert.strictEqual(render(null).hidden, true);
  assert.strictEqual(render({ available: false }).hidden, true);
});

check("fail closed: a non-boolean or absent rollbackIsSafe is never safe", () => {
  // These carry no evaluator warning either, so the correct outcome is "render
  // nothing"; what matters is that none of them yields a safe caveat.
  const cases = [
    context.describeRollbackCaveat({ available: true, rollbackIsSafe: "true", dataSchemaStatus: "safe" }),
    context.describeRollbackCaveat({ available: true, rollbackIsSafe: undefined, dataSchemaStatus: "safe" }),
    context.describeRollbackCaveat({ available: true, dataSchemaStatus: "safe" }),
  ];
  cases.forEach((caveat) => assert.ok(!caveat || caveat.safe !== true, JSON.stringify(caveat)));
});

check("teeth: only rollbackIsSafe===true yields an 'ok' caveat", () => {
  const unsafe = context.describeRollbackCaveat({ ...safeContract, rollbackIsSafe: false });
  assert.ok(!unsafe || unsafe.tone !== "ok", JSON.stringify(unsafe));
  const safe = context.describeRollbackCaveat({ ...preservationOnly, rollbackIsSafe: true });
  assert.strictEqual(safe.tone, "ok");
  const container = render({ ...preservationOnly, rollbackIsSafe: true });
  assert.strictEqual(container.dataset.rollbackSafe, "true");
});

console.log("-----------------------------");
if (failures) {
  console.error(`rollback-caveat-display-smoke FAILED: ${failures} assertion group(s) failed.`);
  process.exit(1);
}
console.log("rollback-caveat-display-smoke passed (9 checks).");
