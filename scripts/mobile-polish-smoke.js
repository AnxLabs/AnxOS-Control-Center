#!/usr/bin/env node
"use strict";

// 217-F: phone app polish.
//   P1 every tap target is at least 44 px tall: buttons (small ones too), the
//      back button, server tabs and breadcrumb buttons (they were 25-37 px)
//   P2 losing the connection is shown at once and polling stops until the
//      phone is back online
//   P3 a hidden page does no freshness work (battery), and polling already
//      stops while hidden
// Run: node scripts/mobile-polish-smoke.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const web = path.join(__dirname, "..", "src", "mobile", "web");
const css = fs.readFileSync(path.join(web, "app.css"), "utf8");
const js = fs.readFileSync(path.join(web, "app.js"), "utf8");

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `app.css has a rule for ${selector}`);
  return match[1];
}
function px(body, property) {
  const match = body.match(new RegExp(`(?:^|[;\\s])${property}:\\s*(\\d+)px`));
  return match ? Number(match[1]) : null;
}

const results = [];
function check(label, fn) {
  try { fn(); results.push(`PASS ${label}`); } catch (error) { results.push(`FAIL ${label}\n  ${error.message}`); }
}

check("P1 tap targets are at least 44 px", () => {
  for (const selector of [".button", ".button.is-small", ".server-tabs a", ".breadcrumb button", ".check", ".input, .select, .textarea"]) {
    const value = px(rule(selector), "min-height");
    assert.ok(value >= 44, `${selector} min-height ${value}px`);
  }
  const back = rule(".topbar__back");
  assert.ok(px(back, "width") >= 44 && px(back, "height") >= 44, ".topbar__back is 44 x 44");
});

check("P2 going offline is shown at once and stops polling", () => {
  const start = js.indexOf('window.addEventListener("offline"');
  assert.ok(start > 0, "an offline handler exists");
  const body = js.slice(start, js.indexOf("});", start));
  assert.ok(body.includes("stopPolling()") && body.includes('code: "OFFLINE"') && body.includes("updateBanner()"), "stops polling and shows the offline banner");
  assert.ok(js.includes('window.addEventListener("online", () => { if (state.session) load({ background: true }); });'), "comes back on its own when online");
});

check("P3 a hidden page does no freshness work and stops polling", () => {
  assert.ok(js.includes("if (state.session && !document.hidden) { updateStatus(); updateBanner(); }"), "the 5 s freshness tick skips hidden pages");
  assert.ok(js.includes("if (!base || document.hidden || !state.session) return;"), "no poll is scheduled while hidden");
  assert.ok(js.includes("if (document.hidden) stopPolling();"), "polling stops when the page is hidden");
});

for (const line of results) console.log(line);
const failed = results.filter((line) => line.startsWith("FAIL")).length;
if (failed) { process.exitCode = 1; console.log(`mobile-polish-smoke: ${failed} failed`); } else console.log(`mobile-polish-smoke passed (${results.length} checks)`);
