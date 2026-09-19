#!/usr/bin/env node
// Behavioral coverage for F5 of the first V2 runtime acceptance pass.
//
// FINDING (cycle 20): an older node Agent answered HTTP 404 for
// GET /api/v1/jobs?limit=100 (the route does not exist in that Agent build). The
// jobs view degraded without crashing, but it implied "nothing to show" instead
// of "this Agent cannot answer this view".
//
// MECHANISM / SIGNAL: the client already produces the code for that shape. The
// desktop Agent client returns the payload's own error code, and the Agent's
// unknown-route response is {"error":{"code":"NOT_FOUND"}} with HTTP 404
// (agent/src/server.js); the live session recorded exactly that
// (.dev-logs/live.log, 2026-09-19T09:09:15.429Z, GET /api/v1/jobs?limit=100 ->
// status 404, errorCode NOT_FOUND, responseBody {"error":{"code":"NOT_FOUND",...}}).
// The fleet service carries that code to the renderer as entry.jobs.code. No new
// code is invented here: NOT_FOUND plus the 404/405 status are the existing
// signals, classified with the same endpoint-unsupported family that
// src/services/agentClient.js isCompatibilityFallbackAllowed already uses.
//
// The real renderer functions are extracted from app.js and driven with a fake
// DOM, so this asserts observed rendered output, not source text.
//
// What it does NOT prove: that a live Operations or Nodes page reaches these
// functions, or that any particular Agent build answers 404 (no Electron and no
// live node are used here).

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

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

function extractConstBlock(name) {
  const start = source.indexOf(`const ${name} = Object.freeze([`);
  if (start < 0) return null;
  const end = source.indexOf("]);", start);
  assert(end >= 0, `Could not extract the ${name} declaration.`);
  return source.slice(start, end + 3);
}

function extractConstExpression(name) {
  const start = source.indexOf(`const ${name} =`);
  assert(start >= 0, `app.js must declare ${name}.`);
  // The declared copy is a single double-quoted string (which itself contains a
  // semicolon), so the declaration ends at the first quote-then-semicolon.
  const end = source.indexOf('";', start);
  assert(end >= 0, `Could not find the end of the ${name} declaration.`);
  return source.slice(start, end + 2);
}

const DECLARATIONS = [
  extractConstBlock("AGENT_JOBS_VIEW_UNSUPPORTED_CODES"),
  extractConstExpression("AGENT_JOBS_VIEW_UNSUPPORTED_MESSAGE"),
].filter(Boolean).join("\n");
assert(DECLARATIONS.includes("AGENT_JOBS_VIEW_UNSUPPORTED_CODES"), "app.js must declare AGENT_JOBS_VIEW_UNSUPPORTED_CODES.");

const EXTRACTED = [
  "isAgentJobsViewUnsupported",
  "formatFleetJobs",
  "createTextElement",
  "renderDurableJobs",
].map(extractFunction).join("\n\n");

// --- minimal fake DOM -------------------------------------------------------
function createFakeElement(tagName) {
  const element = {
    tagName: String(tagName || "div").toUpperCase(),
    children: [],
    dataset: {},
    className: "",
    textContent: "",
    hidden: false,
    append(...nodes) {
      nodes.forEach((node) => {
        if (node === null || node === undefined) return;
        element.children.push(node);
      });
    },
    appendChild(node) { element.children.push(node); return node; },
    replaceChildren(...nodes) { element.children = []; element.append(...nodes); },
    setAttribute(name, value) { element[name] = value; },
  };
  Object.defineProperty(element, "childElementCount", { get: () => element.children.length });
  return element;
}

function collectText(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  const own = typeof node.textContent === "string" ? node.textContent : "";
  const nested = (node.children || []).map(collectText).join(" ");
  return `${own} ${nested}`.trim();
}

function createHarness(jobsState) {
  const list = createFakeElement("div");
  const message = createFakeElement("div");
  const pill = createFakeElement("span");
  const document = { createElement: (tag) => createFakeElement(tag) };
  const context = {
    console,
    document,
    jobsList: list,
    jobsMessage: message,
    jobsStatusPill: pill,
    jobsState,
    JOB_TERMINAL_STATES: new Set(["cancelled", "failed", "succeeded", "timeout"]),
    setJobsStatusPill: (label, tone) => { pill.textContent = label; pill.className = tone || ""; },
    createEmptyState: (title, className) => {
      const node = createFakeElement("div");
      node.className = className || "";
      node.textContent = title;
      return node;
    },
    getSelectedNode: () => ({ displayName: "Anxlab", name: "Anxlab" }),
    getSelectedNodeId: () => "agent-device-b4c39d2e-efdf-4b3c-864e-721c50f0a7e5",
    createDurableJobItem: (job) => {
      const node = createFakeElement("article");
      node.textContent = String(job?.id || "");
      return node;
    },
  };
  vm.createContext(context);
  vm.runInContext(
    `${DECLARATIONS}\n${EXTRACTED}\nthis.isAgentJobsViewUnsupported = isAgentJobsViewUnsupported;\nthis.formatFleetJobs = formatFleetJobs;\nthis.renderDurableJobs = renderDurableJobs;\nthis.AGENT_JOBS_VIEW_UNSUPPORTED_MESSAGE = AGENT_JOBS_VIEW_UNSUPPORTED_MESSAGE;`,
    context,
  );
  return { list, message, pill, context };
}

function emptyJobsState(overrides = {}) {
  return {
    jobs: [],
    total: 0,
    loaded: true,
    loading: false,
    error: null,
    unsupported: false,
    pendingIds: new Set(),
    ...overrides,
  };
}

// The exact error the live session recorded for the older Agent.
const RECORDED_JOBS_404 = { code: "NOT_FOUND", status: 404, message: "Agent request failed with HTTP 404." };

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

console.log("F5 jobs version-skew vs empty state smoke");

// --- 1. The classifier consumes the existing client code ---------------------
check("the recorded NOT_FOUND/404 jobs response classifies as unsupported", () => {
  const { context } = createHarness(emptyJobsState());
  assert.strictEqual(context.isAgentJobsViewUnsupported(RECORDED_JOBS_404), true, "NOT_FOUND + 404 must classify as version skew.");
});

check("the endpoint-unsupported family and 405 classify as unsupported", () => {
  const { context } = createHarness(emptyJobsState());
  for (const code of ["ENDPOINT_NOT_SUPPORTED", "NOT_SUPPORTED", "METHOD_NOT_ALLOWED", "CAPABILITY_MISSING"]) {
    assert.strictEqual(context.isAgentJobsViewUnsupported({ code }), true, `${code} must classify as version skew.`);
  }
  assert.strictEqual(context.isAgentJobsViewUnsupported({ status: 405 }), true, "HTTP 405 must classify as version skew.");
});

check("a genuine failure (timeout, unreachable, auth) is not misread as version skew", () => {
  const { context } = createHarness(emptyJobsState());
  for (const source of [
    { code: "AGENT_REQUEST_TIMEOUT", status: 0 },
    { code: "ECONNREFUSED" },
    { code: "UNAUTHORIZED", status: 401 },
    { code: "AGENT_HTTP_ERROR", status: 500 },
    null,
  ]) {
    assert.strictEqual(context.isAgentJobsViewUnsupported(source), false, `${JSON.stringify(source)} must not classify as version skew.`);
  }
});

// --- 2. The fleet Jobs field renders version skew, not an empty answer -------
check("a 404/unsupported fleet jobs result renders the version-skew copy, not an empty answer", () => {
  const { context } = createHarness(emptyJobsState());
  const rendered = context.formatFleetJobs({ jobs: { available: false, code: "NOT_FOUND", message: "Agent request failed with HTTP 404." } });
  assert.strictEqual(rendered, context.AGENT_JOBS_VIEW_UNSUPPORTED_MESSAGE, "The fleet Jobs field must state the Agent is too old for this view.");
  assert(!/No recent jobs/.test(rendered), "A 404 must not be presented as an empty job list.");
  assert(!/HTTP 404/.test(rendered), "A 404 must not be presented as a bare HTTP error.");
});

check("a genuinely empty fleet jobs result still renders the empty answer", () => {
  const { context } = createHarness(emptyJobsState());
  assert.strictEqual(
    context.formatFleetJobs({ jobs: { available: true, byState: {}, total: 0, sampled: 0 } }),
    "No recent jobs.",
    "An Agent that answered with no jobs must still read as an empty list.",
  );
});

check("a fleet jobs result with records still renders the counts", () => {
  const { context } = createHarness(emptyJobsState());
  assert.strictEqual(
    context.formatFleetJobs({ jobs: { available: true, byState: { running: 1, succeeded: 2 }, total: 3, sampled: 3 } }),
    "Recent jobs: 1 running, 2 succeeded.",
    "Real job counts must be unaffected.",
  );
});

// --- 3. The durable-jobs panel distinguishes the two states ------------------
check("the durable-jobs panel renders the version-skew state and not the empty state", () => {
  const state = emptyJobsState({ unsupported: true, error: "Agent update required." });
  const { list, message, pill, context } = createHarness(state);
  context.renderDurableJobs();
  const rendered = collectText(list);
  const headline = collectText(message);
  assert(/Agent update required/.test(rendered), `The jobs list must state the Agent needs updating, got ${JSON.stringify(rendered)}.`);
  assert(/too old to report jobs/.test(rendered), "The jobs list must say the Agent is too old for this view.");
  assert(!/No durable jobs recorded/.test(rendered), "A 404 must not be presented as an empty job list.");
  assert(!/No durable jobs recorded/.test(headline), "The jobs message must not imply the node has no jobs.");
  assert.strictEqual(pill.textContent, "Agent update required", "The status pill must name the version skew.");
});

check("the durable-jobs panel still renders the empty state for a genuine empty response", () => {
  const { list, message, pill, context } = createHarness(emptyJobsState());
  context.renderDurableJobs();
  const rendered = collectText(list);
  const headline = collectText(message);
  assert(/No durable jobs recorded/.test(rendered), `A genuine empty store must read as empty, got ${JSON.stringify(rendered)}.`);
  assert(/Anxlab/.test(headline), "The empty state must name the selected node.");
  assert(!/too old to report jobs/.test(rendered), "The empty state must not claim version skew.");
  assert.strictEqual(pill.textContent, "0 tracked", "A genuine empty store reports zero tracked jobs.");
});

check("a genuine jobs failure keeps its own distinct state", () => {
  const { list, pill, context } = createHarness(emptyJobsState({ error: "Durable jobs could not be loaded." }));
  context.renderDurableJobs();
  const rendered = collectText(list);
  assert(/could not be loaded/.test(rendered), "A real failure must keep its own copy.");
  assert(!/too old to report jobs/.test(rendered), "A real failure must not be reported as version skew.");
  assert(!/No durable jobs recorded/.test(rendered), "A real failure must not be reported as an empty list.");
  assert.strictEqual(pill.textContent, "Unavailable", "A real failure reports Unavailable.");
});

if (failures) {
  console.error(`\nF5 jobs version-skew vs empty state smoke FAILED (${failures} check(s)).`);
  process.exitCode = 1;
} else {
  console.log("\nF5 jobs version-skew vs empty state smoke passed.");
}