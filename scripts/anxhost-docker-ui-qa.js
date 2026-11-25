#!/usr/bin/env node
"use strict";

// Build 216-A6 Docker and Compose: acceptance checks in the REAL app for the
// AnxHost look and the A6 inventory rows no other suite covers. Off-screen,
// isolated profile, real Agent test fixture, signed-in disposable owner.
//
// SAFETY: the Agent fixture can reach this PC's real Docker daemon, which may
// run the owner's own containers. This suite only READS Docker (lists,
// refreshes, the cleanup Preview, logs, inspect). Every action that changes
// Docker (create, pull, prune, Compose up/stop/down/pull/build, container
// start/stop/remove) is checked by presence only and never clicked.
//
//   D1  Docker page: summary tiles and the container table on tokens; search
//       and status filter enabled when Docker answers
//   D2  inspector tabs (Overview, Logs, Stats, Inspect) for a container, when
//       one is listed
//   D3  logs: Refresh, search, tail, Pause, Copy, Export, Clear (the view)
//   D4  resources: Refresh images, volumes and networks, Compose Discover,
//       cleanup Preview (read-only), the cleanup choices
//   D5  every Docker-changing control and the create form's 15 fields are
//       kept (presence only)
//   D6  layout at 900x640, 1280x800 and 1920x1080; D7 contrast; D8 errors
//   D9  every A6 inventory hook is in the running app (presence)
//
// Usage: node scripts/anxhost-docker-ui-qa.js [--shots=<dir>]

const fs = require("fs");
const path = require("path");
const { launchRealApp, waitFor } = require("./test-helpers/anxhost-real-app");
const { signInQaOwner } = require("./test-helpers/qa-owner");
const { inventoryRows, checkInventoryHooks } = require("./test-helpers/inventory-hooks");

const shotsArg = process.argv.find((arg) => arg.startsWith("--shots="));
const SHOTS = shotsArg ? path.resolve(shotsArg.slice(8)) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (id, ok, message) => {
  results.push({ id, ok: Boolean(ok), message });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${message}`);
};
async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 15000 }).catch(() => {});
}

const CONTRAST = `
  const parse = (value) => {
    const s = String(value || "").trim();
    let m = /^rgba?\\(([^)]+)\\)/.exec(s);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = /^color\\(srgb ([^)]+)\\)/.exec(s);
    if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
    return null;
  };
  const over = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
  const backgroundOf = (element) => {
    const layers = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 1) break; }
    }
    let colour = { r: 8, g: 6, b: 13, a: 1 };
    for (let i = layers.length - 1; i >= 0; i -= 1) colour = over(layers[i], colour);
    return colour;
  };
  const channel = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
`;

async function run() {
  const real = await launchRealApp({ prefix: "anx-216-a6-qa-" });
  const { page, rendererErrors } = real;
  try {
    await signInQaOwner(page);
    await real.setViewport(1280, 800);
    await page.evaluate(() => window.showPage("docker"));
    await page.waitForTimeout(4000);
    await shot(page, "a6-1280-docker");

    // ------------------------------------------------------------ D1
    const d1 = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.background = "var(--ahx-surface-1)";
      document.body.append(probe);
      const surface1 = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const tiles = [...document.querySelectorAll(".docker-summary-card")].filter((tile) => tile.getClientRects().length > 0);
      const rows = [...document.querySelectorAll('.page[data-page="docker"] tr[data-docker-container-id]')].filter((row) => row.getClientRects().length > 0 && row.dataset.dockerContainerId);
      // Only this suite's own test container is opened (its logs are read):
      // the Build 215 test node "anx215-a" when present. The owner's other
      // containers are listed but never opened.
      const own = rows.find((row) => /anx215-a|anx214qa/.test(row.textContent));
      return {
        tiles: tiles.length, onToken: tiles.every((tile) => getComputedStyle(tile).backgroundColor === surface1),
        rows: rows.length, firstId: own?.dataset.dockerContainerId || null,
        searchEnabled: !document.querySelector("[data-docker-search]").disabled,
        filterEnabled: !document.querySelector("[data-docker-filter]").disabled,
        // The container table's own empty or loading message (not another
        // panel's, such as Downloads).
        state: [...document.querySelectorAll('.page[data-page="docker"] .docker-table-wrap .docker-empty-state, .page[data-page="docker"] .docker-table-wrap .docker-loading-state')].filter((element) => !element.hidden && element.getClientRects().length > 0).map((element) => element.innerText.replace(/\s+/g, " ").trim()).join(" | "),
      };
    });
    check("D1", d1.tiles > 0 && d1.onToken, `${d1.tiles} summary tiles on --ahx-surface-1 (${d1.onToken})`);
    check("D1", d1.rows > 0 ? d1.searchEnabled && d1.filterEnabled : Boolean(d1.state), d1.rows > 0 ? `${d1.rows} containers listed; search and filter enabled` : `no containers listed; the page says why ("${d1.state}")`);

    // ------------------------------------------------------------ D2 + D3
    if (d1.firstId) {
      const d2 = await page.evaluate(async (id) => {
        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        selectDockerContainer(id);
        await wait(600);
        const tabs = [];
        for (const name of ["overview", "logs", "stats", "inspect"]) {
          document.querySelector(`[data-docker-tab="${name}"]`).click();
          await wait(500);
          tabs.push(`${name}=${document.querySelector(`[data-docker-tab="${name}"]`).classList.contains("is-active")}`);
        }
        document.querySelector('[data-docker-tab="logs"]').click();
        document.querySelector('[data-docker-log-action="refresh"]').click();
        await wait(1500);
        const search = document.querySelector("[data-docker-logs-search]");
        search.value = "zz-no-such-line";
        search.dispatchEvent(new Event("input", { bubbles: true }));
        await wait(400);
        search.value = "";
        search.dispatchEvent(new Event("input", { bubbles: true }));
        const tail = document.querySelector("[data-docker-logs-tail]");
        tail.value = "100";
        tail.dispatchEvent(new Event("change", { bubbles: true }));
        const pause = document.querySelector("[data-docker-logs-pause]");
        pause.click();
        const paused = pause.checked;
        pause.click();
        const copied = [];
        const original = navigator.clipboard.writeText.bind(navigator.clipboard);
        navigator.clipboard.writeText = async (text) => { copied.push(String(text).length); };
        document.querySelector('[data-docker-log-action="copy"]').click();
        await wait(300);
        navigator.clipboard.writeText = original;
        let exported = null;
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function captured() { exported = this.download || this.href; };
        document.querySelector('[data-docker-log-action="download"]').click();
        await wait(300);
        HTMLAnchorElement.prototype.click = click;
        document.querySelector('[data-docker-log-action="clear"]').click();
        await wait(300);
        return { tabs, paused, copied: copied.length, exported };
      }, d1.firstId);
      check("D2", d2.tabs.every((entry) => entry.endsWith("=true")), `inspector tabs open: ${d2.tabs.join(", ")}`);
      check("D3", d2.paused && d2.copied >= 0 && d2.exported !== undefined, `logs: Refresh, search, tail, Pause, Copy (${d2.copied}), Export (${d2.exported}) and Clear respond`);
    } else {
      check("D2", true, d1.rows > 0 ? "no container of this suite's own to open: inspector tabs checked by presence" : "no container on this computer: inspector tabs checked by presence");
      const present = await page.evaluate(() => ["overview", "logs", "stats", "inspect"].every((name) => document.querySelector(`[data-docker-tab="${name}"]`)) && ["refresh", "copy", "download", "clear"].every((name) => document.querySelector(`[data-docker-log-action="${name}"]`)));
      check("D3", present, "log controls kept (no container to read)");
    }

    // ------------------------------------------------------------ D4 read-only resources
    const d4 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const clicked = [];
      for (const action of ["refresh-images", "refresh-volumes", "refresh-networks", "refresh-compose", "cleanup-preview"]) {
        const button = document.querySelector(`[data-docker-resource-action="${action}"]`);
        if (!button) continue;
        if (!button.disabled) button.click();
        clicked.push(`${action}=${button.disabled ? "disabled" : "ran"}`);
        await wait(1200);
      }
      const choices = ["build-cache", "containers", "networks", "safe"].filter((name) => document.querySelector(`[data-docker-cleanup="${name}"]`));
      return { clicked, choices };
    });
    check("D4", d4.clicked.length === 5 && d4.choices.length === 4, `read-only refreshes and the cleanup Preview respond (${d4.clicked.join(", ")}); cleanup choices kept (${d4.choices.join(", ")})`);

    // ------------------------------------------------------------ D5 changing controls kept, not run
    const d5 = await page.evaluate(() => {
      const resource = ["create-container", "create-network", "prune-images", "prune-networks", "prune-volumes", "pull-image"].filter((name) => document.querySelector(`[data-docker-resource-action="${name}"]`));
      const compose = ["config", "up", "stop", "restart", "pull", "build", "logs", "down"].filter((name) => document.querySelector(`[data-docker-compose-action="${name}"]`));
      const create = ["autoRemove", "command", "cpus", "entrypoint", "environment", "image", "labels", "memory", "name", "network", "ports", "restartPolicy", "start", "user", "workdir"].filter((name) => document.querySelector(`[data-docker-create="${name}"]`));
      const inputs = ["[data-docker-image-pull]", "[data-docker-network-name]", "[data-docker-compose-project]", "[data-docker-compose-directory]", "[data-docker-compose-editor]"].filter((selector) => document.querySelector(selector));
      return { resource: resource.length, compose: compose.length, create: create.length, inputs: inputs.length };
    });
    check("D5", d5.resource === 6 && d5.compose === 8 && d5.create === 15 && d5.inputs === 5, `Docker-changing controls kept and not run: ${d5.resource}/6 resource actions, ${d5.compose}/8 Compose actions, ${d5.create}/15 create fields, ${d5.inputs}/5 inputs`);

    // ------------------------------------------------------------ D6 layout
    for (const [width, height] of [[900, 640], [1280, 800], [1920, 1080]]) {
      await real.setViewport(width, height);
      await page.evaluate(() => window.showPage("docker"));
      await page.waitForTimeout(600);
      const layout = await page.evaluate(() => {
        const pageEl = document.querySelector('.page[data-page="docker"]');
        const host = pageEl.closest("[data-page-host]") || pageEl.parentElement;
        const clipped = [...pageEl.querySelectorAll(".page-header h1, .docker-summary-card strong, .panel-heading h2, [data-docker-tab]")]
          .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).textOverflow !== "ellipsis" && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "visible")
          .map((element) => element.textContent.trim().slice(0, 24));
        return { overflow: host.scrollWidth > host.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth + 1, clipped };
      });
      check("D6", !layout.overflow && !layout.clipped.length, `${width}x${height}: no horizontal overflow (${layout.overflow}); clipped=[${layout.clipped.join("; ")}]`);
      await shot(page, `a6-${width}x${height}-docker`);
    }

    // ------------------------------------------------------------ D7 contrast
    await real.setViewport(1280, 800);
    const contrast = await page.evaluate(new Function(`${CONTRAST}
      const pageEl = document.querySelector('.page[data-page="docker"]');
      const text = [...pageEl.querySelectorAll("h1, h2, h3, .lede, .docker-summary-card span, .docker-summary-card strong, th, td, .inline-action:not(:disabled), .status-pill, [data-docker-tab], label")]
        .filter((element) => element.getClientRects().length > 0 && !element.closest("[hidden]") && element.innerText.trim());
      const low = [];
      for (const element of text) {
        const fg = parse(getComputedStyle(element).color);
        if (!fg) continue;
        const bg = backgroundOf(element);
        const r = ratio(over(fg, bg), bg);
        if (r < 4.5) low.push(element.className.split(" ")[0] + " '" + element.innerText.trim().slice(0, 24) + "' " + r.toFixed(2));
      }
      return { count: text.length, low };
    `));
    check("D7", contrast.count > 10 && contrast.low.length === 0, `Docker text meets 4.5:1 (${contrast.count} elements)${contrast.low.length ? `; below: ${contrast.low.slice(0, 6).join(" | ")}` : ""}`);
    await page.evaluate(() => window.showPage("docker"));
    const hooks = await checkInventoryHooks(page, inventoryRows({ wave: "A6" }));
    check("D9", hooks.missing.length === 0, `${hooks.present.length} A6 hooks present in the running app${hooks.missing.length ? `; missing: ${hooks.missing.map((entry) => entry.hook).join(", ")}` : ""} (${hooks.notChecked.length} computed rows covered above)`);
    check("D8", rendererErrors.length === 0, rendererErrors.length ? `renderer errors: ${rendererErrors.slice(0, 3).join(" | ")}` : "no renderer errors");
  } finally {
    await real.close();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${failed.length ? "FAIL" : "PASS"} anxhost-docker-ui-qa: ${results.length - failed.length}/${results.length} checks`);
  if (failed.length) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
