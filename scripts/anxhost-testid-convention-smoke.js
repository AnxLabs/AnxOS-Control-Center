#!/usr/bin/env node
"use strict";

// Enforces the AnxHost CC data-testid convention (test-helpers/testid-convention.js)
// on every UI source: index.html, app.js, src/renderer/**, the phone PWA and
// the pattern gallery.
//   - every data-testid value is valid (format, known area, no user data or secrets);
//   - a testid repeated in one file is on elements that also carry a data-*-id;
//   - application JavaScript never selects by data-testid (tests only).
// Includes a self-test of the checker so a broken rule cannot pass silently.
// Run: node scripts/anxhost-testid-convention-smoke.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { checkTestId, areaOf } = require("../test-helpers/testid-convention");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

// Self-test.
assert.deepStrictEqual(checkTestId("nav-my-servers"), []);
assert.deepStrictEqual(checkTestId("dialog-stop-server-confirm"), []);
assert.strictEqual(areaOf("my-servers-table"), "my-servers");
assert.ok(checkTestId("NavHome").length, "camelCase is rejected");
assert.ok(checkTestId("banana-split").length, "unknown area is rejected");
assert.ok(checkTestId("server-row-3").length, "bare index is rejected");
assert.ok(checkTestId("network-192-168-1-20").length, "IP-like value is rejected");
assert.ok(checkTestId("security-token-field").length, "secret names are rejected");

const SOURCES = ["index.html", "app.js", "docs/anxhost/gallery/ui-patterns.html", "src/mobile/web/index.html", "src/mobile/web/app.js",
  ...fs.readdirSync(path.join(root, "src/renderer")).filter((f) => f.endsWith(".js")).map((f) => `src/renderer/${f}`)];
const APP_JS = SOURCES.filter((f) => f.endsWith(".js"));

const failures = [];
let total = 0;
for (const file of SOURCES) {
  const text = read(file);
  const tags = [...text.matchAll(/<[a-zA-Z][^>]*\sdata-testid="([^"]*)"[^>]*>/g)];
  const counts = new Map();
  for (const [tag, id] of tags) {
    total += 1;
    for (const problem of checkTestId(id)) failures.push(`${file}: data-testid="${id}" ${problem}`);
    if (!counts.has(id)) counts.set(id, []);
    counts.get(id).push(tag);
  }
  for (const m of text.matchAll(/dataset\.testid\s*=\s*["'`]([^"'`$]*)["'`]|setAttribute\(\s*["']data-testid["']\s*,\s*["'`]([^"'`$]*)["'`]/g)) {
    const id = m[1] ?? m[2];
    total += 1;
    for (const problem of checkTestId(id)) failures.push(`${file}: data-testid "${id}" ${problem}`);
  }
  for (const [id, list] of counts) {
    if (list.length > 1 && !list.every((tag) => /\sdata-[a-z-]+-id="/.test(tag))) failures.push(`${file}: data-testid="${id}" is repeated ${list.length} times without a data-*-id identity attribute`);
  }
}
for (const file of APP_JS) {
  const text = read(file);
  if (/querySelector(?:All)?\([^)]*data-testid|\.dataset\.testid\s*[!=]==|closest\([^)]*data-testid/.test(text)) failures.push(`${file}: application code selects by data-testid (tests only; use the data-* behaviour hook)`);
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`PASS data-testid convention: self-test 8/8, ${total} testid(s) across ${SOURCES.length} UI sources valid, application code does not select by testid`);
}
