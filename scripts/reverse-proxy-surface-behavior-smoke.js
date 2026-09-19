#!/usr/bin/env node
// Behavioral coverage for the V2-H reverse-proxy / certificate surface.
//
// The real `describeRouteCertificate`, `normalizeReverseProxyRouteRows`,
// `describeReverseProxyStatus` and `renderPublicAccessReverseProxy` functions
// are extracted from app.js and driven with a fake DOM. The fixtures are
// produced by the REAL Agent-side service
// (`agent/src/services/reverseProxyService.js`) against a temporary config
// directory, so the surface is exercised with the exact payloads the Agent
// emits — including the honest `applied:false` activation block.
//
// Invariants this file exists for:
//   - A certificate whose expiry is unreadable (`state: "unknown"`) is NEVER
//     rendered as valid.
//   - A recorded route is never described as applied/live: the surface shows
//     `applied:false` and the REVERSE_PROXY_ACTIVATION_UNAVAILABLE statement.
//   - Managed TLS stays pending; the surface says nothing was issued.
//
// What it does NOT prove: that the renderer reaches this path at runtime (no
// Electron is launched), or anything about live layout.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const reverseProxyService = require("../agent/src/services/reverseProxyService");

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

function extractConst(name) {
  const needle = `const ${name} = `;
  const start = source.indexOf(needle);
  assert(start >= 0, `Could not find const ${name} in app.js.`);
  // Handle both LF and CRLF checkouts.
  const terminator = /;\r?\n/.exec(source.slice(start));
  assert(terminator, `Could not find end of const ${name}.`);
  return source.slice(start, start + terminator.index + 1);
}

const EXTRACTED = [
  extractConst("REVERSE_PROXY_CERTIFICATE_STATES"),
  ["describeRouteCertificate", "normalizeReverseProxyRouteRows", "describeReverseProxyStatus", "renderPublicAccessReverseProxy"].map(extractFunction).join("\n\n"),
].join("\n\n");

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
    querySelector() { return null; },
  };
  return element;
}

function collectText(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  if (node.textContent) return String(node.textContent);
  return (node.children || []).map(collectText).join(" ");
}

function collectByDataset(node, key, out = []) {
  if (!node || typeof node !== "object") return out;
  if (node.dataset && Object.prototype.hasOwnProperty.call(node.dataset, key)) out.push(node);
  for (const child of node.children || []) collectByDataset(child, key, out);
  return out;
}

const harness = {
  document: { createElement: (tag) => createFakeElement(tag) },
  createTextElement: (tagName, text = "", className = "") => {
    const element = harness.document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text ?? "";
    return element;
  },
  setPublicAccessFirewallPill: (pill, label, tone) => {
    if (!pill) return;
    pill.className = `status-pill ${tone}`;
    pill.textContent = label;
  },
  setPublicAccessFirewallMessage: (summary, message) => {
    if (!summary) return;
    summary.textContent = message;
  },
  refreshPublicAccessReverseProxy: async () => null,
  getPublicAccessReverseProxyElements: () => ({}),
};
vm.createContext(harness);
vm.runInContext(`${EXTRACTED}\nthis.describeRouteCertificate = describeRouteCertificate;\nthis.normalizeReverseProxyRouteRows = normalizeReverseProxyRouteRows;\nthis.describeReverseProxyStatus = describeReverseProxyStatus;\nthis.renderPublicAccessReverseProxy = renderPublicAccessReverseProxy;`, harness);

function render(result) {
  const elements = {
    list: createFakeElement("div"),
    pill: createFakeElement("span"),
    summary: createFakeElement("p"),
    notice: createFakeElement("div"),
    actions: createFakeElement("div"),
  };
  const status = harness.renderPublicAccessReverseProxy(result, elements);
  return { elements, status, text: collectText(elements.list) + " " + collectText(elements.notice) + " " + collectText(elements.summary) };
}

// --- fixtures from the real Agent service -----------------------------------
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-reverse-proxy-surface-smoke-"));
const options = { configDir };

function writeCertificateRecords(records) {
  fs.writeFileSync(
    reverseProxyService.certificatesFilePath(options),
    `${JSON.stringify({ certificates: records }, null, 2)}\n`,
  );
}

const DAY_MS = 86400000;

async function main() {
  console.log("Reverse proxy surface behavior smoke");
  console.log("------------------------------------");

  const emptySnapshot = await reverseProxyService.getReverseProxySnapshot(options);
  const appliedManaged = await reverseProxyService.applyReverseProxyRoute({
    hostname: "managed.example.com",
    upstream: { host: "127.0.0.1", port: 61999 },
    tlsMode: "managed",
    pathPrefix: "/",
  }, options);

  // 1. Unreadable expiry -> unknown, never valid.
  await reverseProxyService.applyReverseProxyRoute({
    hostname: "unknown.example.com",
    upstream: { host: "127.0.0.1", port: 61998 },
    tlsMode: "manual",
    pathPrefix: "/",
  }, options);
  // 2. A route with real, readable certificate metadata -> issued/valid.
  await reverseProxyService.applyReverseProxyRoute({
    hostname: "valid.example.com",
    upstream: { host: "127.0.0.1", port: 61997 },
    tlsMode: "manual",
    pathPrefix: "/",
  }, options);
  // managed.example.com deliberately has NO record: managed TLS must stay pending.
  writeCertificateRecords([
    { id: "cert-unknown", hostname: "unknown.example.com", notAfter: "not-a-real-date", issuer: "Test CA" },
    { id: "cert-valid", hostname: "valid.example.com", notAfter: new Date(Date.now() + 200 * DAY_MS).toISOString(), issuer: "Test CA" },
  ]);
  const snapshot = await reverseProxyService.getReverseProxySnapshot(options);

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

  check("fixtures: the Agent reports applied:false with the activation block", () => {
    assert.strictEqual(appliedManaged.applied, false, "the Agent must not claim the route was applied");
    assert.strictEqual(appliedManaged.activation.supported, false);
    assert.strictEqual(appliedManaged.activation.code, "REVERSE_PROXY_ACTIVATION_UNAVAILABLE");
    assert.strictEqual(appliedManaged.certificate.state, "pending", "managed TLS must stay pending");
  });

  check("describeRouteCertificate: unreadable expiry is unknown, not valid", () => {
    const model = harness.describeRouteCertificate({ tlsMode: "manual", state: "unknown", verified: false, expiryVerified: false });
    assert.strictEqual(model.state, "unknown");
    assert.strictEqual(model.valid, false);
    assert.strictEqual(model.expiryKnown, false);
    assert.ok(!/^valid/i.test(model.stateLabel), `label must not start with Valid: ${model.stateLabel}`);
  });

  check("describeRouteCertificate: verified without a readable expiry is not valid", () => {
    const model = harness.describeRouteCertificate({ tlsMode: "manual", state: "issued", verified: true, expiryVerified: false });
    assert.strictEqual(model.valid, false);
  });

  check("describeRouteCertificate: a readable, verified, in-window expiry is valid", () => {
    const model = harness.describeRouteCertificate({ tlsMode: "manual", state: "issued", verified: true, expiryVerified: true, expiresAt: new Date(Date.now() + 200 * DAY_MS).toISOString() });
    assert.strictEqual(model.valid, true);
    assert.strictEqual(model.stateLabel, "Valid");
  });

  check("unknown certificate is not rendered as valid (DOM state)", () => {
    const { elements, text } = render(snapshot);
    const pills = collectByDataset(elements.list, "publicAccessReverseProxyCertificate");
    const unknownPill = pills.find((pill) => pill.dataset.publicAccessReverseProxyCertificate === "unknown");
    assert.ok(unknownPill, `an unknown-certificate row must render: ${text}`);
    assert.strictEqual(unknownPill.dataset.publicAccessReverseProxyCertificateValid, "false");
    assert.ok(!/^valid/i.test(unknownPill.textContent), `pill must not say Valid: ${unknownPill.textContent}`);
    assert.ok(/unknown|not valid/i.test(unknownPill.textContent), `pill must state it is not valid: ${unknownPill.textContent}`);
    assert.ok(text.includes("not reported as valid"), `the row must explain the unreadable expiry: ${text}`);
    // The valid counterpart from the same snapshot must still render as valid,
    // so this cannot pass by marking every certificate invalid.
    const issuedPill = pills.find((pill) => pill.dataset.publicAccessReverseProxyCertificate === "issued");
    assert.ok(issuedPill, `the readable-expiry certificate must render: ${text}`);
    assert.strictEqual(issuedPill.dataset.publicAccessReverseProxyCertificateValid, "true");
  });

  check("read snapshot renders no live/activated claim", () => {
    const { status, text } = render(snapshot);
    assert.strictEqual(status.appliedRequest, false, "a read payload must not be treated as an apply result");
    assert.strictEqual(status.activationUnavailable, true);
    assert.ok(text.includes("does not write proxy configuration"), text);
    assert.ok(!/route applied/i.test(text), `must not claim the route is applied: ${text}`);
  });

  check("managed TLS with no record renders as pending, never issued", () => {
    const { elements, text } = render(snapshot);
    const pills = collectByDataset(elements.list, "publicAccessReverseProxyCertificate");
    const pendingPill = pills.find((pill) => pill.dataset.publicAccessReverseProxyCertificate === "pending");
    assert.ok(pendingPill, `a managed route with no record must render as pending: ${text}`);
    assert.strictEqual(pendingPill.dataset.publicAccessReverseProxyCertificateValid, "false");
    assert.ok(/not issued \(pending\)/i.test(pendingPill.textContent), pendingPill.textContent);
    assert.ok(!/^valid/i.test(pendingPill.textContent), pendingPill.textContent);
    assert.ok(/does not issue certificates/i.test(text), text);
  });

  check("apply result renders applied:false and the activation code statement", () => {
    const { elements, status, text } = render(appliedManaged);
    assert.strictEqual(status.appliedRequest, true);
    assert.strictEqual(status.applied, false);
    assert.strictEqual(status.activationCode, "REVERSE_PROXY_ACTIVATION_UNAVAILABLE");
    assert.ok(/NOT applied/i.test(text), `notice must say NOT applied: ${text}`);
    assert.ok(text.includes(appliedManaged.activation.message), text);
    assert.ok(elements.notice, "the notice container must carry the statement");
  });

  check("empty snapshot renders an empty state, not a false green", () => {
    const { status, elements, text } = render(emptySnapshot);
    assert.strictEqual(status.routes.length, 0);
    assert.strictEqual(status.validCertificateCount, 0);
    assert.ok(/No reverse-proxy routes are recorded/i.test(text), text);
    assert.ok(elements.pill.textContent === "None", elements.pill.textContent);
  });

  check("fail closed: valid requires the explicit verified pair on a usable state", () => {
    assert.strictEqual(harness.describeRouteCertificate({ state: "issued", verified: true }).valid, false);
    assert.strictEqual(harness.describeRouteCertificate({ state: "issued", expiryVerified: true }).valid, false);
    assert.strictEqual(harness.describeRouteCertificate({ state: "issued", verified: "true", expiryVerified: "true" }).valid, false);
    assert.strictEqual(harness.describeRouteCertificate({ state: "pending", verified: true, expiryVerified: true }).valid, false);
    assert.strictEqual(harness.describeRouteCertificate({ state: "expired", verified: true, expiryVerified: true }).valid, false);
  });

  check("a transport error renders unavailable rather than a stale green", () => {
    const { status, elements } = render({ ok: false, error: { message: "Reverse-proxy state is unavailable for this node." } });
    assert.strictEqual(status.available, false);
    assert.strictEqual(elements.pill.textContent, "Unavailable");
  });

  console.log("------------------------------------");
  if (failures) {
    console.error(`reverse-proxy-surface-behavior-smoke FAILED: ${failures} assertion group(s) failed.`);
    process.exit(1);
  }
  console.log("reverse-proxy-surface-behavior-smoke passed (11 checks).");
}

main().catch((error) => {
  console.error("reverse-proxy-surface-behavior-smoke crashed:", error?.message || error);
  process.exit(1);
});
