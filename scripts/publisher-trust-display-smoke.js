#!/usr/bin/env node
// Behavioral coverage for the V2-D publisher-trust warning surface.
//
// The real `describePublisherTrustNotice` and `createPublisherTrustNotice`
// functions are extracted from app.js and driven with a fake DOM. Verdicts are
// produced by the REAL `src/shared/publisherTrustPolicy` (the same module the
// main process uses), so the assertions prove the surface renders the policy's
// exported operator copy verbatim rather than phrasing of its own.
//
// What it does NOT prove: that the renderer calls these functions (no Electron
// is launched), that the Marketplace install review actually reaches them, or
// anything about a live DOM.

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const policy = require("../src/shared/publisherTrustPolicy");

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

const EXTRACTED = ["describePublisherTrustNotice", "createPublisherTrustNotice"].map(extractFunction).join("\n\n");

// --- minimal fake DOM -------------------------------------------------------
function createFakeElement(tagName) {
  const element = {
    tagName: String(tagName || "div").toUpperCase(),
    children: [],
    dataset: {},
    className: "",
    textContent: "",
    hidden: false,
    listeners: {},
    append(...nodes) {
      nodes.forEach((node) => {
        if (node === null || node === undefined) return;
        element.children.push(node);
      });
    },
    appendChild(node) { element.children.push(node); return node; },
    replaceChildren(...nodes) { element.children = []; element.append(...nodes); },
    setAttribute(name, value) { element[name] = value; },
    addEventListener(type, handler) { (element.listeners[type] = element.listeners[type] || []).push(handler); },
  };
  return element;
}

function collectText(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (node.textContent) return String(node.textContent);
  return (node.children || []).map(collectText).join(" ");
}

function createHarness() {
  const context = {
    document: { createElement: (tag) => createFakeElement(tag) },
    // Real implementation semantics (app.js createTextElement).
    createTextElement: (tagName, text = "", className = "") => {
      const element = context.document.createElement(tagName);
      if (className) element.className = className;
      element.textContent = text ?? "";
      return element;
    },
  };
  vm.createContext(context);
  vm.runInContext(`${EXTRACTED}\nthis.describePublisherTrustNotice = describePublisherTrustNotice;\nthis.createPublisherTrustNotice = createPublisherTrustNotice;`, context);
  return context;
}

const harness = createHarness();

function render(verdict) {
  return harness.createPublisherTrustNotice(harness.describePublisherTrustNotice(verdict));
}

const VERIFIED_HASH = "a".repeat(64);
function policyVerdict({ entry = {}, facts = {} } = {}) {
  return policy.evaluatePublisherTrust(entry, facts);
}

// --- verdict fixtures built by the real policy ------------------------------
const verifiedVerdict = policyVerdict({
  entry: { provider: "anxos", checksum: `sha256:${VERIFIED_HASH}` },
  facts: { computedHash: `sha256:${VERIFIED_HASH}` },
});
const unverifiedVerdict = policyVerdict({ entry: { provider: "acme-corp", checksum: `sha256:${VERIFIED_HASH}` } });
const mismatchVerdict = policyVerdict({
  entry: { provider: "acme-corp", checksum: `sha256:${VERIFIED_HASH}` },
  facts: { computedHash: `sha256:${"b".repeat(64)}` },
});
const unknownVerdict = policyVerdict({ entry: {} });

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

console.log("Publisher trust display smoke");
console.log("-----------------------------");

check("fixtures cover the four operator-relevant verdicts", () => {
  assert.strictEqual(verifiedVerdict.verdict, "verified", `expected verified, got ${verifiedVerdict.verdict}`);
  assert.strictEqual(unverifiedVerdict.verdict, "unverified-publisher");
  assert.strictEqual(mismatchVerdict.verdict, "hash-mismatch");
  assert.strictEqual(unknownVerdict.verdict, "unknown");
});

check("verified verdict renders the policy's exported copy verbatim", () => {
  const notice = render(verifiedVerdict);
  const expected = policy.TRUST_MESSAGES.verified;
  assert.ok(notice, "a verified verdict must produce a notice element");
  assert.strictEqual(notice.dataset.publisherTrustVerdict, "verified");
  assert.strictEqual(notice.dataset.publisherTrustVerified, "true");
  assert.strictEqual(notice.dataset.publisherTrustSeverity, "ok");
  const text = collectText(notice);
  assert.ok(text.includes(expected.title), `title missing: ${text}`);
  assert.ok(text.includes(expected.body), `body missing: ${text}`);
  assert.ok(text.includes(expected.action), `action missing: ${text}`);
});

check("unverified-publisher renders warning copy and a review flag", () => {
  const notice = render(unverifiedVerdict);
  const expected = policy.TRUST_MESSAGES["unverified-publisher"];
  assert.strictEqual(notice.dataset.publisherTrustVerdict, "unverified-publisher");
  assert.strictEqual(notice.dataset.publisherTrustVerified, "false");
  assert.strictEqual(notice.dataset.publisherTrustSeverity, "warning");
  assert.strictEqual(notice.dataset.publisherTrustReview, "required");
  const text = collectText(notice);
  assert.ok(text.includes(expected.title) && text.includes(expected.body) && text.includes(expected.action), text);
});

check("hash-mismatch is critical, not verified, and states the install refusal", () => {
  const notice = render(mismatchVerdict);
  const expected = policy.TRUST_MESSAGES["hash-mismatch"];
  assert.strictEqual(notice.dataset.publisherTrustVerdict, "hash-mismatch");
  assert.strictEqual(notice.dataset.publisherTrustVerified, "false");
  assert.strictEqual(notice.dataset.publisherTrustSeverity, "critical");
  const text = collectText(notice);
  assert.ok(text.includes(expected.title) && text.includes(expected.body) && text.includes(expected.action), text);
  assert.ok(notice.children.some((child) => child.className === "publisher-trust-notice__blocked"), "a refused install must render the blocked line");
});

check("unknown verdict is never rendered as verified", () => {
  const notice = render(unknownVerdict);
  const expected = policy.TRUST_MESSAGES.unknown;
  assert.strictEqual(notice.dataset.publisherTrustVerified, "false");
  const text = collectText(notice);
  assert.ok(text.includes(expected.title) && text.includes(expected.body) && text.includes(expected.action), text);
});

// FAIL-CLOSED: the renderer must trust only the policy's explicit flags. These
// malformed verdicts would be rendered as trusted by a truthiness/`verdict`
// check alone.
check("fail closed: verdict text alone never establishes 'verified'", () => {
  const withoutFlag = render({
    verdict: "verified",
    operatorTitle: "Verified publisher",
    operatorMessage: "body",
    operatorAction: "action",
    allowInstall: true,
  });
  assert.strictEqual(withoutFlag.dataset.publisherTrustVerified, "false", "a missing verified flag must not be treated as verified");
});

check("fail closed: a non-boolean flag is not verified", () => {
  const coerced = render({ verdict: "verified", verified: "true", allowInstall: true, operatorTitle: "t", operatorMessage: "b", operatorAction: "a" });
  assert.strictEqual(coerced.dataset.publisherTrustVerified, "false");
});

check("fail closed: a verified flag on a non-verified verdict is not verified", () => {
  const confused = render({ verdict: "unknown", verified: true, allowInstall: true, operatorTitle: "t", operatorMessage: "b", operatorAction: "a" });
  assert.strictEqual(confused.dataset.publisherTrustVerified, "false");
});

check("a verdict with no operator copy renders nothing (no invented wording)", () => {
  assert.strictEqual(harness.describePublisherTrustNotice({ verdict: "verified", verified: true }), null);
  assert.strictEqual(render({ verdict: "verified", verified: true }), null);
  assert.strictEqual(render(null), null);
});

check("dropping the verdict fails the surface (regression pin)", () => {
  // If a caller forgets to pass download.trustVerdict this returns null; the
  // companion mutation check (remove the trust field) is what this pins.
  assert.strictEqual(render(undefined), null);
  assert.ok(render(verifiedVerdict), "a present verdict must still render");
});

console.log("-----------------------------");
if (failures) {
  console.error(`publisher-trust-display-smoke FAILED: ${failures} assertion group(s) failed.`);
  process.exit(1);
}
console.log("publisher-trust-display-smoke passed (10 checks).");
