#!/usr/bin/env node
// Behavioral coverage for the instance launch-link host guard (renderer lane
// hardening recorded in docs/v2/V2_CAMPAIGN_QUEUES.md: "app.js assigns href
// from instance.connectionHost, which is length-capped but not scheme/host
// validated").
//
// WHY: instance.connectionHost is a node-supplied field that the renderer
// renders into an http:// href on the Instances page and the dashboard app
// cards (getInstanceServiceUrl). It was length-capped by the instance service
// but never validated as a bare host, so a value carrying URL structure
// ("/", "@", "?", "#", ":") could retarget the launch link to another site.
// The scheme stays pinned to plain HTTP, so this is link-target hardening, not
// script-execution prevention. The renderer now validates the host and returns
// "" (the link is hidden) instead of substituting a different destination.
//
// The real renderer functions are extracted from app.js and driven directly, so
// this asserts observed return values, not source text.
//
// What it does NOT prove: that a live Instances page or dashboard card reaches
// these functions, or how any particular browser would treat a crafted URL.

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

function extractConstLine(name) {
  const start = source.indexOf(`const ${name} = `);
  assert(start >= 0, `app.js must declare ${name}.`);
  // The working tree is checked out with CRLF endings on Windows, so the
  // declaration ends with ";\r\n" — match the line end with an optional
  // carriage return instead of assuming ";\n".
  const rest = source.slice(start);
  const match = rest.match(/;[ \t]*\r?\n/);
  assert(match, `Could not find the end of the ${name} declaration.`);
  return rest.slice(0, match.index + 1);
}

const DECLARATIONS = extractConstLine("INSTANCE_CONNECTION_HOST_PATTERN");

const EXTRACTED = [
  "isSafeInstanceConnectionHost",
  "normalizePortEntry",
  "getInstancePorts",
  "getInstancePrimaryPort",
  "getInstanceConnectionHost",
  "getInstanceServiceUrl",
].map(extractFunction).join("\n\n");

// The node lookup is stubbed: this smoke covers host validation, not node
// resolution. URL is injected because a fresh vm context has no Node globals.
function createHarness() {
  const context = {
    console,
    URL,
    getSelectedNodeAgentUrl: () => "http://192.168.1.50:8766",
  };
  vm.createContext(context);
  vm.runInContext(
    `${DECLARATIONS}\n${EXTRACTED}\nthis.getInstanceServiceUrl = getInstanceServiceUrl;\nthis.isSafeInstanceConnectionHost = isSafeInstanceConnectionHost;`,
    context,
  );
  return context;
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

console.log("Instance launch-link host guard smoke");

check("an IPv4 host with a port builds the plain-HTTP launch link", () => {
  const { getInstanceServiceUrl } = createHarness();
  assert.strictEqual(getInstanceServiceUrl({ connectionHost: "192.168.1.10", ports: [25565] }), "http://192.168.1.10:25565");
});

check("a DNS hostname with a port builds the launch link", () => {
  const { getInstanceServiceUrl } = createHarness();
  assert.strictEqual(getInstanceServiceUrl({ connectionHost: "mc.example.com", ports: [25565] }), "http://mc.example.com:25565");
});

check("a bracketed IPv6 host builds the launch link", () => {
  const { getInstanceServiceUrl } = createHarness();
  assert.strictEqual(getInstanceServiceUrl({ connectionHost: "[::1]", ports: [25565] }), "http://[::1]:25565");
});

check("an underscore hostname (common Windows name) is still accepted", () => {
  const { getInstanceServiceUrl } = createHarness();
  assert.strictEqual(getInstanceServiceUrl({ connectionHost: "my_server", ports: [25565] }), "http://my_server:25565");
});

check("a missing host falls back to the selected node's hostname", () => {
  const { getInstanceServiceUrl } = createHarness();
  assert.strictEqual(getInstanceServiceUrl({ ports: [25565] }), "http://192.168.1.50:25565");
});

check("a string or object port is normalized like the instances page does", () => {
  const { getInstanceServiceUrl } = createHarness();
  assert.strictEqual(getInstanceServiceUrl({ connectionHost: "10.0.0.5", primaryPort: "25565" }), "http://10.0.0.5:25565");
  assert.strictEqual(getInstanceServiceUrl({ connectionHost: "10.0.0.5", primaryPort: { hostPort: 25566 } }), "http://10.0.0.5:25566");
});

check("a host carrying URL structure is rejected and the link is hidden", () => {
  const { getInstanceServiceUrl, isSafeInstanceConnectionHost } = createHarness();
  for (const host of [
    "evil.example.com/phish",
    "user@evil.example.com",
    "evil.example.com?x=1",
    "evil.example.com#frag",
    "evil.example.com:80",
    "javascript:alert(1)",
    "   ",
    "a".repeat(254),
  ]) {
    assert.strictEqual(isSafeInstanceConnectionHost(host), false, `${JSON.stringify(host)} must not validate as a bare host.`);
    assert.strictEqual(
      getInstanceServiceUrl({ connectionHost: host, ports: [25565] }),
      "",
      `${JSON.stringify(host)} must hide the launch link rather than retarget it.`,
    );
  }
});

check("no port still yields no link", () => {
  const { getInstanceServiceUrl } = createHarness();
  assert.strictEqual(getInstanceServiceUrl({ connectionHost: "192.168.1.10" }), "");
});

if (failures) {
  console.error(`\nInstance launch-link host guard smoke FAILED (${failures} check(s)).`);
  process.exitCode = 1;
} else {
  console.log("\nInstance launch-link host guard smoke passed.");
}
