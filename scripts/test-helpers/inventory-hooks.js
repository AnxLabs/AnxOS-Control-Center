"use strict";

// Build 216 wave checks: whether the capability inventory's hooks for a wave
// exist in the RUNNING app (docs/anxhost/capability-inventory.json).
//
// This is a presence check, kept separate from behaviour checks in each
// wave's suite: a `data-*` hook must be in the live DOM (markup or rendered
// by the app by the time of the check) and an `api.*` hook must be a callable
// bridge method. Rows whose hook is computed (`=*`), a function-built dialog
// (`fn:`) or has no stable hook are returned as "notChecked" so the suite
// covers them by behaviour or says why not.

const fs = require("fs");
const path = require("path");

const INVENTORY = path.resolve(__dirname, "..", "..", "docs", "anxhost", "capability-inventory.json");

function inventoryRows({ wave, area = null } = {}) {
  const raw = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
  const rows = Array.isArray(raw) ? raw : raw.rows || [];
  return rows.filter((row) => row.wave === wave && (!area || row.area === area || (Array.isArray(area) && area.includes(row.area))));
}

function classify(row) {
  const hook = String(row.hook || "");
  if (/^api\.[A-Za-z0-9_.]+$/.test(hook)) return { type: "api", path: hook.slice(4).split(".") };
  if (/^data-[a-z0-9-]+=[^*]+$/.test(hook)) {
    const [name, value] = hook.split("=");
    return { type: "dom", selector: `[${name}="${value.replace(/"/g, '\\"')}"]` };
  }
  if (/^data-[a-z0-9-]+$/.test(hook)) return { type: "dom", selector: `[${hook}]` };
  // "#x" is the inventory's placeholder for a dialog found by its id at
  // run time, not a selector.
  return { type: "other" };
}

// Returns { present: [ids], missing: [{id, hook}], notChecked: [{id, hook}] }.
async function checkInventoryHooks(page, rows) {
  const plan = rows.map((row) => ({ id: row.id, hook: row.hook || "", ...classify(row) }));
  const checkable = plan.filter((entry) => entry.type === "dom" || entry.type === "api");
  const found = await page.evaluate((entries) => entries.map((entry) => {
    if (entry.type === "dom") {
      try { return Boolean(document.querySelector(entry.selector)); } catch { return false; }
    }
    // The renderer reaches the preload bridge as window.anxos (also exposed
    // under older names).
    const roots = [window.anxos, window.anxhub, window.anx].filter(Boolean);
    return roots.some((root) => {
      let value = root;
      for (const key of entry.path) value = value?.[key];
      return typeof value === "function";
    });
  }), checkable.map(({ type, selector, path: keys }) => ({ type, selector, path: keys })));
  const present = [];
  const missing = [];
  checkable.forEach((entry, index) => (found[index] ? present.push(entry.id) : missing.push({ id: entry.id, hook: entry.hook })));
  const notChecked = plan.filter((entry) => entry.type === "other").map(({ id, hook }) => ({ id, hook }));
  return { present, missing, notChecked };
}

module.exports = { inventoryRows, checkInventoryHooks };
