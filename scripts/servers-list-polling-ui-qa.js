#!/usr/bin/env node
"use strict";

// 217-A: My Servers rebuilt every row's Actions cell on every 5 s poll,
// although nothing had changed. The row builder ignored the "busy" rule that
// updateInstanceActionButtons() applies to the live buttons, so the fresh cell
// never matched the live one. With 150 servers that was about 2,200 DOM nodes
// per 30 s and long tasks of 74-113 ms.
//   L1 across several idle polls, no cell of an unchanged row is replaced
//   L2 the power actions still follow the server's state after the polls:
//      Start is enabled and Stop disabled for a stopped server
// Real app, isolated profile, off-screen; the fixture Agent serves 20 stopped
// servers. Run: node scripts/servers-list-polling-ui-qa.js

const assert = require("assert");
const { launchRealApp } = require("./test-helpers/anxhost-real-app");
const { signInQaOwner } = require("./test-helpers/qa-owner");

async function main() {
  const extraInstances = Array.from({ length: 20 }, (_, index) => `list-server-${String(index).padStart(2, "0")}`);
  const run = await launchRealApp({ prefix: "anx-217-list-", agentOptions: { extraInstances } });
  const results = [];
  try {
    await signInQaOwner(run.page);
    await run.page.evaluate(() => window.showPage("instances"));
    await run.page.waitForFunction(() => document.querySelectorAll('tr[data-instance-id^="list-server-"]').length === 20, null, { timeout: 60000 });
    await run.page.waitForTimeout(6000);

    // L1: mark every cell in memory (not in the markup) and count replacements.
    await run.page.evaluate(() => {
      window.__listReplacements = 0;
      for (const row of document.querySelectorAll('tr[data-instance-id^="list-server-"]')) {
        [...row.children].forEach((cell, index) => { cell.__qaCell = index; });
        new MutationObserver((records) => { for (const record of records) window.__listReplacements += record.addedNodes.length; }).observe(row, { childList: true });
      }
    });
    await run.page.waitForTimeout(16000);
    const outcome = await run.page.evaluate(() => {
      const rows = [...document.querySelectorAll('tr[data-instance-id^="list-server-"]')];
      const replacedCells = rows.flatMap((row) => [...row.children].filter((cell) => cell.__qaCell === undefined).map((cell) => `${row.dataset.instanceId}#${[...row.children].indexOf(cell)}`));
      return { rows: rows.length, replacedCells, replacements: window.__listReplacements };
    });
    assert.strictEqual(outcome.rows, 20);
    assert.deepStrictEqual(outcome.replacedCells, [], `cells replaced during idle polling: ${outcome.replacedCells.slice(0, 6).join(", ")}`);
    assert.strictEqual(outcome.replacements, 0);
    results.push("PASS L1 16 s of idle polling (3 polls) replaced no cell of 20 unchanged rows");

    // L2
    await run.page.waitForFunction(() => {
      const row = document.querySelector('tr[data-instance-id="list-server-05"]');
      return row && !row.querySelector('[data-instance-row-action="start"]').disabled;
    }, null, { timeout: 15000 });
    const buttons = await run.page.evaluate(() => {
      const row = document.querySelector('tr[data-instance-id="list-server-05"]');
      const state = (action) => row.querySelector(`[data-instance-row-action="${action}"]`).disabled;
      return { start: state("start"), stop: state("stop") };
    });
    assert.deepStrictEqual(buttons, { start: false, stop: true });
    results.push("PASS L2 a stopped server's Start is enabled and Stop disabled after the polls");
  } finally {
    await run.close();
  }
  for (const line of results) console.log(line);
  console.log(`servers-list-polling-ui-qa passed (${results.length} checks)`);
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
