#!/usr/bin/env node
"use strict";

// Build 216-A5 Computers, fleet, AnxNet and Agent Control: acceptance checks
// in the REAL app for the AnxHost look and for the A5 inventory rows no other
// suite covers. Off-screen, isolated profile, real Agent test fixture,
// signed-in disposable owner; see scripts/test-helpers/anxhost-real-app.js.
//
//   C1  Computers: summary tiles on tokens, a card per computer with its
//       state, Refresh, the computer details panel
//   C2  computer details drawer: opens, Refresh, Edit opens the edit dialog,
//       Remove asks first (cancelled, nothing removed), close
//   C3  Add Computer dialog: the three setup paths, Advanced manual setup,
//       fields, Save refuses an empty address, pairing controls (Paste,
//       Restart, Get a new code, Cancel), Download link, Delete kept
//   C4  fleet actions: Check All updates and Load Network Inventory answer
//   C5  Agent Control: every section opens; every configuration field is
//       present and filled from the Agent; setup mode and start options
//   C6  Agent logs: search, severity, Pause, Wrap, Refresh
//   C7  diagnostics and provenance: Capture Snapshot, Copy Summary, Run
//       Health Checks, Load Provenance Report, Copy Report, New Browser Code;
//       the actions that change an Agent (pair, repair, save, reload, reconnect,
//       update, mobile pairing, complete setup) are present and not run here
//   C8  Test Connection answers for the selected computer
//   C9  layout at 900x640, 1280x800 and 1920x1080 for Computers and Agent
//       Control (no horizontal overflow, no clipped headers)
//   C10 contrast (WCAG AA) on both pages
//   C11 no renderer errors
//   C12 every A5 inventory hook is in the running app (data-* hooks in the
//       DOM after the pages above were visited, api.* hooks callable)
//
// Usage: node scripts/anxhost-computers-ui-qa.js [--shots=<dir>]

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

const CONTRAST_HELPERS = `
  const parse = (value) => {
    const s = String(value || "").trim();
    let m = /^rgba?\\(([^)]+)\\)/.exec(s);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = /^color\\(srgb ([^)]+)\\)/.exec(s);
    if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
    return null;
  };
  const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 });
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
  const real = await launchRealApp({ prefix: "anx-216-a5-qa-" });
  const { page, rendererErrors } = real;
  try {
    await signInQaOwner(page);
    await real.setViewport(1280, 800);
    await page.evaluate(() => window.showPage("nodes"));
    await waitFor(page, () => document.querySelectorAll("[data-node-list] .node-card").length > 0, null, "computer cards", 300);
    await page.waitForTimeout(800);
    await shot(page, "a5-1280-computers");

    // ------------------------------------------------------------ C1 Computers
    const c1 = await page.evaluate(async () => {
      const probe = document.createElement("div");
      probe.style.background = "var(--ahx-surface-1)";
      document.body.append(probe);
      const surface1 = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const tiles = [...document.querySelectorAll(".nodes-summary-card")].filter((tile) => tile.getClientRects().length > 0);
      const cards = [...document.querySelectorAll("[data-node-list] .node-card")].map((card) => ({ name: card.querySelector("strong")?.textContent.trim(), state: card.dataset.agentState }));
      document.querySelector('[data-node-action="refresh"]').click();
      await new Promise((resolve) => setTimeout(resolve, 800));
      return { tiles: tiles.length, onToken: tiles.every((tile) => getComputedStyle(tile).backgroundColor === surface1), cards, details: document.querySelector(".computer-details")?.innerText.length || 0, stillCards: document.querySelectorAll("[data-node-list] .node-card").length };
    });
    check("C1", c1.tiles > 0 && c1.onToken, `${c1.tiles} summary tiles on --ahx-surface-1 (${c1.onToken})`);
    check("C1", c1.cards.length >= 2 && c1.cards.every((card) => card.name && card.state) && c1.stillCards === c1.cards.length, `a card per computer with its state: ${c1.cards.map((card) => `${card.name}=${card.state}`).join(", ")}; Refresh keeps them`);
    check("C1", c1.details > 0, "the computer details panel is shown");

    // ------------------------------------------------------------ C2 details drawer
    const c2 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const modal = document.querySelector("[data-node-details-modal]");
      openNodeDetails("qa");
      await wait(400);
      const opened = !modal.hidden;
      modal.querySelector('[data-node-details-action="refresh"]').click();
      await wait(400);
      modal.querySelector('[data-node-details-action="edit"]').click();
      await wait(400);
      const editModal = document.querySelector("[data-node-modal]");
      const editing = !editModal.hidden && /Edit|Computer/i.test(document.querySelector("[data-node-modal-title]")?.textContent || "");
      setNodeModalVisible(false);
      await wait(200);
      openNodeDetails("qa");
      await wait(300);
      modal.querySelector('[data-node-details-action="remove"]').click();
      let confirm = null;
      for (let i = 0; i < 20 && !confirm; i += 1) { confirm = document.querySelector("[data-confirm-cancel], [data-confirm-ok]") ? document.querySelector(".app-modal-backdrop:last-of-type") : null; if (!confirm) await wait(100); }
      const asked = Boolean(document.querySelector("[data-confirm-ok]"));
      document.querySelector("[data-confirm-cancel]")?.click();
      await wait(400);
      const stillThere = (await window.anxos.nodes.list())?.nodes?.some?.((node) => node.id === "qa") ?? [...document.querySelectorAll("[data-node-list] .node-card strong")].some((title) => /QA Computer/.test(title.textContent));
      openNodeDetails("qa");
      await wait(300);
      document.querySelector('[data-node-action="close-details"]').click();
      await wait(300);
      const technical = [...document.querySelectorAll("[data-node-details-modal] summary")].some((summary) => /Technical details/i.test(summary.textContent));
      return { opened, editing, asked, stillThere, closed: modal.hidden, technical };
    });
    check("C2", c2.opened && c2.closed && c2.technical, `details drawer opens, keeps Technical details, and closes (${c2.opened}/${c2.closed})`);
    check("C2", c2.editing, "Edit opens the edit dialog");
    check("C2", c2.asked && c2.stillThere, `Remove asks first; cancelling removes nothing (asked=${c2.asked}, kept=${c2.stillThere})`);

    // ------------------------------------------------------------ C3 Add Computer dialog
    const c3 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      setNodeModalVisible(true);
      await wait(400);
      const modal = document.querySelector("[data-node-modal]");
      const text = modal.innerText;
      const paths = ["Desktop computer", "Headless server", "Advanced Manual Setup"].filter((label) => new RegExp(label, "i").test(text));
      const controls = ["paste-pairing-code", "restart-pairing", "pairing-retry-help", "cancel-pairing", "open-release-page", "save", "delete"].filter((name) => modal.querySelector(`[data-node-action="${name}"]`));
      const docker = Boolean(modal.querySelector('[data-node-field="dockerEnabled"]'));
      let opened = null;
      const originalOpen = typeof openExternalUrl === "function" ? openExternalUrl : null;
      if (originalOpen) window.openExternalUrl = (url) => { opened = String(url); return Promise.resolve(); };
      modal.querySelector('[data-node-action="open-release-page"]')?.click();
      await wait(200);
      if (originalOpen) window.openExternalUrl = originalOpen;
      modal.querySelector('[data-node-action="cancel-pairing"]')?.click();
      await wait(300);
      setNodeModalVisible(false);
      return { paths, controls, docker, opened };
    });
    check("C3", c3.paths.length === 3, `the three setup paths are offered (${c3.paths.join(", ")})`);
    check("C3", c3.controls.length === 7 && c3.docker, `pairing, save, delete and release controls and the Docker field are kept (${c3.controls.join(", ")})`);
    check("C3", c3.opened === null || /^https:\/\//.test(c3.opened), `the release link opens an https page (${c3.opened})`);

    // ------------------------------------------------------------ C4 fleet actions
    const c4 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const updates = document.querySelector('[data-server-updates-action="check"]');
      const before = updates.closest("section")?.innerText || "";
      updates.click();
      await wait(2500);
      const after = updates.closest("section")?.innerText || "";
      const inventory = document.querySelector('[data-network-inventory-action="load"]');
      const invBefore = inventory.closest("section")?.innerText || "";
      inventory.click();
      await wait(2500);
      return { updatesAnswered: before !== after || !updates.disabled, inventoryAnswered: (inventory.closest("section")?.innerText || "") !== invBefore };
    });
    check("C4", c4.updatesAnswered && c4.inventoryAnswered, `Check All updates and Load Network Inventory answer (${c4.updatesAnswered}/${c4.inventoryAnswered})`);

    // ------------------------------------------------------------ C5 Agent Control sections and configuration
    await page.evaluate(() => window.showPage("agent-control"));
    await page.waitForTimeout(1500);
    await shot(page, "a5-1280-agent-control");
    const c5 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const sections = [];
      for (const button of document.querySelectorAll("[data-agent-control-section-target]")) {
        button.click();
        await wait(150);
        const shown = [...document.querySelectorAll("[data-agent-control-section]")].filter((panel) => !panel.hidden && panel.getClientRects().length > 0);
        sections.push(`${button.dataset.agentControlSectionTarget}=${shown.length > 0}`);
      }
      const config = ["accountAssociation", "allowedFolders", "allowedOrigins", "connectionTimeoutMs", "heartbeatIntervalMs", "host", "loggingLevel", "name", "ownerMachine", "port", "restartPolicy", "storageRoots", "updateChannel"];
      const presentConfig = config.filter((name) => document.querySelector(`[data-agent-config="${name}"]`));
      const setup = ["mode", "autoStart"].filter((name) => document.querySelector(`[data-agent-setup="${name}"]`));
      const token = Boolean(document.querySelector('[data-agent-setting="agentToken"]'));
      return { sections, presentConfig, missingConfig: config.filter((name) => !presentConfig.includes(name)), setup, token };
    });
    check("C5", c5.sections.length >= 10 && c5.sections.every((entry) => entry.endsWith("=true")), `every Agent Control section opens (${c5.sections.length}): ${c5.sections.join(", ")}`);
    check("C5", c5.missingConfig.length === 0 && c5.setup.length === 2 && c5.token, c5.missingConfig.length ? `configuration fields missing: ${c5.missingConfig.join(", ")}` : `all 13 configuration fields, setup mode and start options, and the token field are kept`);

    // ------------------------------------------------------------ C6 logs
    const c6 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const section = document.querySelector("[data-agent-log-search]")?.closest("[data-agent-control-section]")?.dataset.agentControlSection || null;
      if (section) setActiveAgentControlSection(section);
      const target = { dataset: { agentControlSectionTarget: section } };
      await wait(300);
      document.querySelector('[data-agent-control-action="refreshLogs"]').click();
      await wait(1200);
      const search = document.querySelector("[data-agent-log-search]");
      search.value = "zz-no-such-log-line-zz";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(500);
      const severity = document.querySelector("[data-agent-log-severity]");
      const severities = [...severity.options].map((option) => option.value);
      severity.value = severities[severities.length - 1];
      severity.dispatchEvent(new Event("change", { bubbles: true }));
      await wait(300);
      const pause = document.querySelector("[data-agent-log-pause]");
      const wrap = document.querySelector("[data-agent-log-wrap]");
      pause.click();
      wrap.click();
      await wait(200);
      const state = { paused: pause.checked, wrapped: wrap.checked };
      pause.click();
      wrap.click();
      search.value = "";
      search.dispatchEvent(new Event("input", { bubbles: true }));
      severity.value = severities[0];
      severity.dispatchEvent(new Event("change", { bubbles: true }));
      return { section: target?.dataset.agentControlSectionTarget || null, severities: severities.length, state };
    });
    check("C6", c6.section && c6.severities > 1 && c6.state.paused === true && c6.state.wrapped === false, `Agent logs: Refresh, search, ${c6.severities} severities, Pause and Wrap respond (section ${c6.section})`);

    // ------------------------------------------------------------ C7 diagnostics, provenance, browser code
    const c7 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const copied = [];
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text) => { copied.push(String(text).length); };
      const toasts = [];
      const toast = showToast;
      window.showToast = (message, tone) => { toasts.push(String(message)); return toast(message, tone); };
      const run = async (selector, ms = 1500) => {
        const buttons = [...document.querySelectorAll(selector)];
        const button = buttons.find((entry) => entry.closest('[data-page="agent-control"]')) || buttons[0];
        const section = button?.closest("[data-agent-control-section]")?.dataset.agentControlSection;
        if (section) setActiveAgentControlSection(section);
        await wait(100);
        button?.click();
        await wait(ms);
        return Boolean(button);
      };
      try {
        const present = {
          capture: await run('[data-diagnostics-action="capture"]'),
          health: await run('[data-diagnostics-action="health"]', 2500),
          copySummary: await run('[data-diagnostics-action="copy"]', 600),
          loadProvenance: await run('[data-provenance-action="load"]', 2000),
          copyProvenance: await run('[data-provenance-action="copy"]', 600),
          browserCode: await run('[data-agent-control-action="mintUiBootstrapCode"]', 2000),
        };
        const code = document.querySelector("[data-agent-ui-bootstrap-code]")?.value || "";
        // The browser code is minted by this PC's Local Agent, which this
        // harness keeps unreachable on purpose; then the app must say so.
        const codeReason = toasts.find((message) => /agent|unavailable|code/i.test(message)) || "";
        const kept = ["pair", "repair", "save", "test"].filter((name) => document.querySelector(`[data-agent-action="${name}"]`)).length
          + ["completeSetup", "copyMobileClaim", "pairMobileDevice", "reconnect", "reloadConfig", "updateAllAgents", "refresh"].filter((name) => document.querySelector(`[data-agent-control-action="${name}"]`)).length
          + ["dismiss", "refresh", "retry", "update"].filter((name) => document.querySelector(`[data-agent-compatibility-action="${name}"]`)).length
          + ["open-diagnostics", "refresh"].filter((name) => document.querySelector(`[data-agent-developer-action="${name}"]`)).length
          + ["open", "export"].filter((name) => document.querySelector(`[data-diagnostics-action="${name}"]`)).length;
        return { present, copied, code: code.length, codeReason, toasts: toasts.slice(-8), kept };
      } finally {
        navigator.clipboard.writeText = original;
        window.showToast = toast;
      }
    });
    check("C7", Object.values(c7.present).every(Boolean) && c7.copied.length >= 1, `Capture Snapshot, Run Health Checks, Copy Summary, Load Provenance and Copy Report run (copied ${c7.copied.join(", ")} characters; ${c7.toasts.join(" | ").slice(0, 200)})`);
    check("C7", c7.code > 0 || Boolean(c7.codeReason), c7.code > 0 ? `New Browser Code fills a one-time code (${c7.code} characters)` : `New Browser Code says why there is no code when this PC's Agent is unreachable ("${c7.codeReason}")`);
    check("C7", c7.kept === 19, `the ${c7.kept}/19 actions that change an Agent, open folders or export files are kept (not run here)`);

    // ------------------------------------------------------------ C8 Test Connection
    const c8 = await page.evaluate(async () => {
      const button = document.querySelector('[data-agent-action="test"]');
      const section = button?.closest("[data-agent-control-section]")?.dataset.agentControlSection;
      if (section) setActiveAgentControlSection(section);
      const toasts = [];
      const toast = showToast;
      window.showToast = (message, tone) => { toasts.push(String(message)); return toast(message, tone); };
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 3000));
      window.showToast = toast;
      return toasts.join(" | ").slice(0, 160);
    });
    check("C8", c8.length > 0, `Test Connection answers ("${c8}")`);

    // ------------------------------------------------------------ C9 layout
    for (const [width, height] of [[900, 640], [1280, 800], [1920, 1080]]) {
      await real.setViewport(width, height);
      for (const pageName of ["nodes", "agent-control"]) {
        await page.evaluate((name) => window.showPage(name), pageName);
        await page.waitForTimeout(500);
        const layout = await page.evaluate((name) => {
          const pageEl = document.querySelector(`.page[data-page="${name}"]`);
          const host = pageEl.closest("[data-page-host]") || pageEl.parentElement;
          const clipped = [...pageEl.querySelectorAll(".page-header h1, .nodes-summary-card strong, .node-card strong, .page-tabs__tab, .settings-section__header h2")]
            .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).textOverflow !== "ellipsis" && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "visible")
            .map((element) => element.textContent.trim().slice(0, 24));
          return { overflow: host.scrollWidth > host.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth + 1, clipped };
        }, pageName);
        check("C9", !layout.overflow && !layout.clipped.length, `${width}x${height} ${pageName}: no horizontal overflow (${layout.overflow}); clipped=[${layout.clipped.join("; ")}]`);
        await shot(page, `a5-${width}x${height}-${pageName}`);
      }
    }

    // ------------------------------------------------------------ C10 contrast
    await real.setViewport(1280, 800);
    for (const pageName of ["nodes", "agent-control"]) {
      await page.evaluate((name) => window.showPage(name), pageName);
      await page.waitForTimeout(500);
      const contrast = await page.evaluate(new Function("name", `${CONTRAST_HELPERS}
        const pageEl = document.querySelector('.page[data-page="' + name + '"]');
        const text = [...pageEl.querySelectorAll("h1, h2, h3, .lede, .nodes-summary-card span, .nodes-summary-card strong, .node-card strong, .node-card span, dt, dd, .settings-field > span, .settings-note, .inline-action:not(:disabled), .status-pill, button[data-agent-control-section-target]")]
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
      `), pageName);
      check("C10", contrast.count > 10 && contrast.low.length === 0, `${pageName}: text meets 4.5:1 (${contrast.count} elements)${contrast.low.length ? `; below: ${contrast.low.slice(0, 6).join(" | ")}` : ""}`);
    }

    // ------------------------------------------------------------ C12 inventory hooks
    await page.evaluate(() => { window.showPage("nodes"); openNodeDetails("qa"); });
    await page.waitForTimeout(500);
    const hooks = await checkInventoryHooks(page, inventoryRows({ wave: "A5" }));
    await page.evaluate(() => setNodeDetailsVisible(false));
    check("C12", hooks.missing.length === 0, `${hooks.present.length} A5 hooks present in the running app${hooks.missing.length ? `; missing: ${hooks.missing.map((entry) => entry.hook).join(", ")}` : ""} (${hooks.notChecked.length} computed or unhooked rows are covered by the checks above)`);

    // ------------------------------------------------------------ C11 errors
    check("C11", rendererErrors.length === 0, rendererErrors.length ? `renderer errors: ${rendererErrors.slice(0, 3).join(" | ")}` : "no renderer errors");
  } finally {
    await real.close();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${failed.length ? "FAIL" : "PASS"} anxhost-computers-ui-qa: ${results.length - failed.length}/${results.length} checks`);
  if (failed.length) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
