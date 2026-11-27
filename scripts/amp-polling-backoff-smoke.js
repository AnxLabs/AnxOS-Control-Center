#!/usr/bin/env node
"use strict";

// 217-A: Home polled the AMP snapshot every 2 s even when the Agent reported
// AMP as not configured (AMP is configured on the Agent; the app only reads
// it). That was a quarter of Home's idle Agent requests in the Build 217
// baseline. An unconfigured AMP is now re-checked once a minute.
//   P1 unconfigured, same computer, under a minute: deferred
//   P2 unconfigured, a minute later: read again
//   P3 a forced refresh (computer switch, reload) always reads
//   P4 another computer always reads
//   P5 a configured AMP keeps the 2 s cadence (never deferred)
//   P6 before the first answer: read
//   P7 refreshAmpDashboard consults the rule after the existing Agent back-off
//      and records which computer the snapshot is for
// Run: node scripts/amp-polling-backoff-smoke.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

function extractFunction(name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, `app.js declares ${name}`);
  let depth = 0;
  // The body starts at the first "{" after the parameter list (which can hold
  // "= {}" defaults).
  for (let index = source.indexOf(") {", start) + 2; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") { depth -= 1; if (depth === 0) return source.slice(start, index + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

const constant = /^const AMP_UNCONFIGURED_REFRESH_INTERVAL_MS = (\d+);/m.exec(source);
assert.ok(constant, "app.js declares AMP_UNCONFIGURED_REFRESH_INTERVAL_MS");
const sandbox = { latestAmpSnapshot: null, latestAmpSnapshotNodeId: null, lastAmpRefreshAt: 0, AMP_UNCONFIGURED_REFRESH_INTERVAL_MS: Number(constant[1]) };
vm.runInNewContext(`${extractFunction("shouldDeferUnconfiguredAmpRefresh")}\nthis.defer = shouldDeferUnconfiguredAmpRefresh;`, sandbox);
const results = [];
function check(label, fn) { try { fn(); results.push(`PASS ${label}`); } catch (error) { results.push(`FAIL ${label}\n  ${error.message}`); } }
const now = 1_800_000_000_000;
const home = { nodeId: "home" };

check("P1 unconfigured, same computer, under a minute: deferred", () => {
  Object.assign(sandbox, { latestAmpSnapshot: { configured: false }, latestAmpSnapshotNodeId: "home", lastAmpRefreshAt: now - 2000 });
  assert.strictEqual(sandbox.defer(home, {}, now), true);
  assert.strictEqual(sandbox.AMP_UNCONFIGURED_REFRESH_INTERVAL_MS, 60000);
});
check("P2 unconfigured, a minute later: read again", () => {
  Object.assign(sandbox, { lastAmpRefreshAt: now - 60000 });
  assert.strictEqual(sandbox.defer(home, {}, now), false);
});
check("P3 a forced refresh always reads", () => {
  Object.assign(sandbox, { lastAmpRefreshAt: now - 1000 });
  assert.strictEqual(sandbox.defer(home, { force: true }, now), false);
});
check("P4 another computer always reads", () => {
  assert.strictEqual(sandbox.defer({ nodeId: "vps" }, {}, now), false);
});
check("P5 a configured AMP is never deferred", () => {
  Object.assign(sandbox, { latestAmpSnapshot: { configured: true, connected: true } });
  assert.strictEqual(sandbox.defer(home, {}, now), false);
});
check("P6 before the first answer: read", () => {
  Object.assign(sandbox, { latestAmpSnapshot: null, latestAmpSnapshotNodeId: null, lastAmpRefreshAt: 0 });
  assert.strictEqual(sandbox.defer(home, {}, now), false);
});
check("P7 refreshAmpDashboard consults the rule and records the computer", () => {
  const body = extractFunction("refreshAmpDashboard");
  const backoff = body.indexOf('shouldBackOffAgentPolling("amp", requestContext)');
  const rule = body.indexOf("shouldDeferUnconfiguredAmpRefresh(requestContext, options)");
  const request = body.indexOf("api.amp.getSnapshot(");
  assert.ok(backoff >= 0 && rule > backoff && request > rule, "the rule runs after the Agent back-off and before the request");
  assert.ok(/latestAmpSnapshotNodeId = requestContext\.nodeId/.test(body), "the snapshot's computer is recorded");
});

for (const line of results) console.log(line);
const failed = results.filter((line) => line.startsWith("FAIL")).length;
if (failed) { process.exitCode = 1; console.log(`amp-polling-backoff-smoke: ${failed} failed`); } else console.log(`amp-polling-backoff-smoke passed (${results.length} checks)`);
