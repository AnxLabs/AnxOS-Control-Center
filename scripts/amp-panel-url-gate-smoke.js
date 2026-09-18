#!/usr/bin/env node
// Behavioral coverage for the AMP-panel URL gate (frozen-audit hardening item N3).
//
// `getAmpPanelUrl` returned a node-supplied `diagnostics.loadedAmpUrl` and the
// renderer assigned it straight to an anchor's `href`. A malicious enrolled node
// could therefore return `javascript:` and have it run in the renderer main
// world, which holds the preload IPC bridge, when the operator clicked "Open
// panel". No browser was driven during the audit, so exploitability stays
// UNPROVEN — this pins the mitigation, not an exploit.
//
// This is BEHAVIORAL: it extracts the real functions from app.js and drives the
// real `href` assignment with a fake anchor, asserting on observed anchor state
// rather than on source text. A static "app.js contains getSafeAmpPanelUrl" pin
// would not catch a second ungated assignment or a neutered protocol check.
//
// What it does NOT prove: that the panel renders, that any handler works, or
// anything about a live renderer. No Electron is launched here.

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

const EXTRACTED = [
  "getConfiguredAmpUrl",
  "getAmpPanelUrl",
  "getSafeAmpPanelUrl",
  "updateAmpPanelLink",
].map(extractFunction).join("\n\n");

function createAnchor() {
  const attributes = new Map();
  return {
    href: "",
    textContent: "Unavailable",
    setAttribute(name, value) { attributes.set(name, String(value)); },
    removeAttribute(name) {
      attributes.delete(name);
      if (name === "href") delete this.href;
    },
    getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
  };
}

function createHarness({ storedSettings = {} } = {}) {
  const anchor = createAnchor();
  const fields = new Map();
  const context = {
    ampPanelLink: anchor,
    lastLoggedAmpUrlSource: null,
    console: { info() {} },
    // vm.createContext only provides ECMAScript intrinsics; the host `URL`
    // global must be injected or getSafeAmpPanelUrl's try/catch silently
    // rejects EVERY value (the positive control below exists to catch that —
    // it caught exactly this defect in the original proof harness).
    URL,
    readStoredSettings: () => storedSettings,
    getAmpUrlSource: () => "test",
    setField: (name, value) => fields.set(name, value),
  };
  vm.createContext(context);
  vm.runInContext(`${EXTRACTED}\nthis.updateAmpPanelLink = updateAmpPanelLink;\nthis.getAmpPanelUrl = getAmpPanelUrl;\nthis.getSafeAmpPanelUrl = getSafeAmpPanelUrl;`, context);
  return { anchor, fields, updateAmpPanelLink: context.updateAmpPanelLink, getAmpPanelUrl: context.getAmpPanelUrl, getSafeAmpPanelUrl: context.getSafeAmpPanelUrl };
}

function snapshotWithLoadedAmpUrl(url) {
  return { connected: false, diagnostics: { loadedAmpUrl: url } };
}

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

console.log("AMP panel URL gate smoke");
console.log("------------------------");

// 1. javascript: must not reach href.
const js = createHarness();
js.updateAmpPanelLink(snapshotWithLoadedAmpUrl("javascript:alert(document.cookie)"));
check("javascript: URL never reaches href", () => {
  assert.notStrictEqual(js.anchor.href, "javascript:alert(document.cookie)");
  assert.ok(!String(js.anchor.href || "").toLowerCase().startsWith("javascript:"), `href was ${JSON.stringify(js.anchor.href)}`);
  assert.strictEqual(js.anchor.href === undefined || js.anchor.href === "", true, "href must be absent on rejection");
  assert.strictEqual(js.anchor.textContent, "Unavailable");
  assert.strictEqual(js.anchor.getAttribute("aria-disabled"), "true");
});
check("javascript: still shown as inert text in the URL field", () => {
  assert.strictEqual(js.fields.get("ampPanelUrl"), "javascript:alert(document.cookie)");
});

// 2. Mixed-case / whitespace javascript: variant must not reach href.
const jsCase = createHarness();
jsCase.updateAmpPanelLink(snapshotWithLoadedAmpUrl("  JavaScript:alert(1)  "));
check("mixed-case javascript: variant rejected", () => {
  assert.ok(!String(jsCase.anchor.href || "").toLowerCase().includes("javascript:"));
  assert.strictEqual(jsCase.anchor.textContent, "Unavailable");
});

// 3. data: URL must not reach href.
const data = createHarness();
data.updateAmpPanelLink(snapshotWithLoadedAmpUrl("data:text/html,<script>1</script>"));
check("data: URL rejected", () => {
  assert.strictEqual(data.anchor.href === undefined || data.anchor.href === "", true);
  assert.strictEqual(data.anchor.textContent, "Unavailable");
});

// 4. file: URL must not reach href.
const file = createHarness();
file.updateAmpPanelLink(snapshotWithLoadedAmpUrl("file:///C:/Windows/System32/drivers/etc/hosts"));
check("file: URL rejected", () => {
  assert.strictEqual(file.anchor.href === undefined || file.anchor.href === "", true);
});

// 5. https: still reaches href (regression guard).
const https = createHarness();
https.updateAmpPanelLink(snapshotWithLoadedAmpUrl("https://amp.example.internal:8080/panel"));
check("https: URL still reaches href", () => {
  assert.strictEqual(https.anchor.href, "https://amp.example.internal:8080/panel");
  assert.strictEqual(https.anchor.textContent, "Open panel");
  assert.strictEqual(https.anchor.getAttribute("aria-disabled"), null);
});

// 6. http: still reaches href (regression guard).
const http = createHarness();
http.updateAmpPanelLink(snapshotWithLoadedAmpUrl("http://127.0.0.1:8080/"));
check("http: URL still reaches href", () => {
  assert.strictEqual(http.anchor.href, "http://127.0.0.1:8080/");
  assert.strictEqual(http.anchor.textContent, "Open panel");
});

// 7. Stale href is cleared when a previously-safe URL is replaced by javascript:.
const stale = createHarness();
stale.updateAmpPanelLink(snapshotWithLoadedAmpUrl("https://amp.example.internal/panel"));
stale.updateAmpPanelLink(snapshotWithLoadedAmpUrl("javascript:alert(1)"));
check("stale https href is removed on later javascript: value", () => {
  assert.strictEqual(stale.anchor.href === undefined || stale.anchor.href === "", true, `href was ${JSON.stringify(stale.anchor.href)}`);
  assert.strictEqual(stale.anchor.textContent, "Unavailable");
});

// 8. Configured-setting fallback is validated too (no snapshot URL).
const configured = createHarness({ storedSettings: { "amp.url": "javascript:alert(2)" } });
configured.updateAmpPanelLink(snapshotWithLoadedAmpUrl(""));
check("configured-setting javascript: URL rejected", () => {
  assert.strictEqual(configured.anchor.href === undefined || configured.anchor.href === "", true);
  assert.strictEqual(configured.anchor.textContent, "Unavailable");
});

// 9. Empty snapshot -> Unavailable, no href.
const empty = createHarness();
empty.updateAmpPanelLink(snapshotWithLoadedAmpUrl(""));
check("empty URL renders Unavailable with no href", () => {
  assert.strictEqual(empty.anchor.href === undefined || empty.anchor.href === "", true);
  assert.strictEqual(empty.anchor.textContent, "Unavailable");
  assert.strictEqual(empty.getAmpPanelUrl(snapshotWithLoadedAmpUrl("")), "");
});

// 10. Positive control for the validator itself (so the proof cannot pass by
//     the validator being replaced with one that rejects everything).
check("validator positive/negative control", () => {
  const harness = createHarness();
  assert.strictEqual(harness.getSafeAmpPanelUrl("https://ok.example/"), "https://ok.example/");
  assert.strictEqual(harness.getSafeAmpPanelUrl("javascript:alert(1)"), "");
  assert.strictEqual(harness.getSafeAmpPanelUrl(""), "");
  assert.strictEqual(harness.getSafeAmpPanelUrl("https://"), "");
  assert.strictEqual(harness.getSafeAmpPanelUrl(null), "");
});

console.log("------------------------");
if (failures) {
  console.error(`amp-panel-url-gate-smoke FAILED: ${failures} assertion group(s) failed.`);
  process.exit(1);
}
console.log("amp-panel-url-gate-smoke passed (11 checks).");
