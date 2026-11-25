#!/usr/bin/env node
"use strict";

// Build 216-A2 Home and Customize Home: acceptance checks in the REAL app.
// Off-screen, isolated profile, real Agent test fixture, signed-in disposable
// owner (background polling needs it since Build 212); see
// scripts/test-helpers/anxhost-real-app.js.
//
//   H1  Home renders with the AnxHost page layer: "Overview" eyebrow, the four
//       overview tiles with values, token surfaces (pages.css and home.css
//       loaded), and no app-name "AnxOS" in Home text (the "AnxOS Agent"
//       product name and the AnxOS distro label are frozen)
//   H2  sections: Needs attention, My Servers (live cards from the Agent),
//       Computers (cards with an eight-state status shape), Setup checklist
//   H3  a server card opens that server's page; the card is keyboard
//       reachable and opens on Enter
//   H4  a computer card opens Computers for that computer
//   H5  Customize Home: toggle opens and closes the panel (aria-expanded),
//       hide a section, move a section with focus kept on the moved
//       section, choices survive a reload, Reset restores the default
//   H6  density select changes the app-wide density setting
//   H7  every inventoried Home action still routes: quick actions and next
//       step in "More actions" go to their pages
//   H8  layout: no horizontal overflow or clipped Home text at 900x640,
//       1280x800 and 1920x1080
//   H9  contrast: WCAG AA for Home text (4.5:1), 3:1 for status shapes
//   H10 no renderer errors
//
// Usage: node scripts/anxhost-home-ui-qa.js [--shots=<dir>]

const fs = require("fs");
const path = require("path");
const { launchRealApp, waitFor, evaluateMain } = require("./test-helpers/anxhost-real-app");
const { signInQaOwner } = require("./test-helpers/qa-owner");

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
    if (m) {
      const parts = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
      return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
    }
    m = /^color\\(srgb ([^)]+)\\)/.exec(s);
    if (m) {
      const parts = m[1].split(/[ /]+/).filter(Boolean).map(Number);
      return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts.length > 3 ? parts[3] : 1 };
    }
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

async function goHome(page) {
  await page.evaluate(() => window.showPage("dashboard"));
  await page.waitForTimeout(250);
}

async function run() {
  const real = await launchRealApp({ prefix: "anx-216-a2-qa-" });
  const { page, rendererErrors } = real;
  try {
    await signInQaOwner(page);
    await real.setViewport(1280, 800);
    await goHome(page);
    // Live data: the fixture's servers reach Home through the normal poll.
    await waitFor(page, () => document.querySelectorAll('[data-testid="home-server-card"]').length > 0, null, "Home server cards", 400);
    // The fixture computer answers; the "Owner Machine" (this PC's Local
    // Agent) is unreachable on purpose (AGENT_URL is a closed port).
    await waitFor(page, () => Boolean(document.querySelector('[data-testid="home-computer"][data-computer-id="qa"][data-connection="online"]')), null, "QA Computer online on Home", 400);
    await page.waitForTimeout(500);
    await shot(page, "a2-1280-home");

    // ------------------------------------------------------------ H1 page layer
    const h1 = await page.evaluate(() => {
      const home = document.querySelector('[data-testid="home-page"]');
      const tiles = [...document.querySelectorAll('[data-testid="home-tile"]')].map((tile) => ({
        key: tile.dataset.homeTile,
        label: tile.querySelector(".home-tile__label")?.innerText.trim(),
        value: tile.querySelector(".home-tile__value")?.innerText.trim(),
      }));
      const sheets = [...document.styleSheets].map((sheet) => sheet.href || "").filter((href) => /anxhost\/(pages|home)\.css$/.test(href));
      const tile = document.querySelector('[data-testid="home-tile"]');
      const rootStyle = getComputedStyle(document.documentElement);
      const tileBg = getComputedStyle(tile).backgroundColor;
      const probe = document.createElement("div");
      probe.style.background = "var(--ahx-surface-1)";
      document.body.append(probe);
      const surface1 = getComputedStyle(probe).backgroundColor;
      probe.remove();
      // Home text without the frozen product name "AnxOS Agent" and the
      // AnxOS distro label ("AnxOS (linux)").
      const copy = home.cloneNode(true);
      copy.querySelectorAll(".home-computer__title span").forEach((span) => span.remove());
      const text = copy.textContent.replace(/AnxOS Agent/g, "");
      return {
        eyebrow: home.querySelector(".page-header .eyebrow")?.innerText.trim(),
        title: home.querySelector(".page-header h1")?.innerText.trim(),
        tiles,
        sheets: sheets.map((href) => href.split("/").pop()),
        tileUsesToken: tileBg === surface1,
        stray: (text.match(/.{0,40}AnxOS.{0,40}/g) || []).slice(0, 3),
        shell: rootStyle.getPropertyValue("--ahx-surface-1").trim() !== "",
      };
    });
    check("H1", /^overview$/i.test(h1.eyebrow) && h1.title === "Home", `page header "${h1.eyebrow}" / "${h1.title}"`);
    check("H1", h1.tiles.length === 4 && ["servers", "computers", "players", "attention"].every((key) => h1.tiles.some((tile) => tile.key === key && tile.label && tile.value)), `overview tiles: ${h1.tiles.map((tile) => `${tile.key}=${tile.value}`).join(", ")}`);
    check("H1", h1.sheets.includes("pages.css") && h1.sheets.includes("home.css") && h1.tileUsesToken && h1.shell, `AnxHost page layer loaded (${h1.sheets.join(", ")}); tiles use --ahx-surface-1=${h1.tileUsesToken}`);
    check("H1", h1.stray.length === 0, h1.stray.length ? `app-name "AnxOS" still on Home: ${h1.stray.join(" | ")}` : "no app-name \"AnxOS\" on Home (AnxOS Agent and the distro label are frozen)");

    // ------------------------------------------------------------ H2 sections
    const h2 = await page.evaluate(() => {
      const sections = [...document.querySelectorAll('[data-testid^="home-section-"]')].map((section) => ({
        id: section.dataset.homeSection,
        visible: !section.hidden && section.getBoundingClientRect().height > 0,
        heading: section.querySelector("h2")?.innerText.trim(),
      }));
      const statuses = [...document.querySelectorAll('[data-testid="home-computer"] .home-status')].map((status) => {
        const before = getComputedStyle(status, "::before");
        return { connection: status.closest("[data-connection]").dataset.connection, label: status.innerText.trim(), shape: before.content !== "none" && parseFloat(before.width) > 0 };
      });
      const attention = document.querySelectorAll('[data-testid="home-attention-item"], [data-testid="home-attention-ok"]').length;
      const servers = [...document.querySelectorAll('[data-testid="home-server-card"]')].map((card) => card.querySelector("strong")?.innerText.trim());
      return { sections, statuses, attention, servers };
    });
    check("H2", ["attention", "servers", "computers", "setup"].every((id) => h2.sections.some((section) => section.id === id && section.visible && section.heading)), `sections: ${h2.sections.map((section) => `${section.id}="${section.heading}"`).join(", ")}`);
    check("H2", h2.attention > 0, `Needs attention shows ${h2.attention} item(s) or the all-clear line`);
    check("H2", h2.servers.length > 0 && h2.servers.includes("AnxRP"), `My Servers shows live cards from the Agent: ${h2.servers.join(", ")}`);
    check("H2", h2.statuses.some((status) => status.connection === "online") && h2.statuses.some((status) => status.connection === "offline") && h2.statuses.every((status) => status.label && status.shape), `computer statuses keep a visible label and a status shape: ${h2.statuses.map((status) => `${status.connection}="${status.label}"`).join(", ")}`);

    // ------------------------------------------------------------ H3 server card
    const opened = await page.evaluate(() => {
      const card = [...document.querySelectorAll('[data-testid="home-server-card"]')].find((entry) => entry.querySelector("strong")?.innerText.trim() === "AnxRP");
      card.click();
      return card.dataset.instanceId;
    });
    await page.waitForTimeout(600);
    const serverPage = await page.evaluate(() => ({ page: document.querySelector(".page.is-active")?.dataset.page, view: document.querySelector('.page[data-page="instances"]')?.dataset.serverView, selected: typeof selectedInstanceId === "string" ? selectedInstanceId : null }));
    check("H3", serverPage.page === "instances" && serverPage.view === "open" && serverPage.selected === opened, `clicking a server card opens its server page (page=${serverPage.page}, view=${serverPage.view}, selected=${serverPage.selected === opened})`);
    await page.evaluate(() => window.AnxServerView?.close?.());
    await goHome(page);
    await page.evaluate(() => document.querySelector('[data-testid="home-server-card"]').focus());
    const focusable = await page.evaluate(() => document.activeElement?.dataset.testid === "home-server-card" && document.activeElement.getAttribute("role") === "button");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(600);
    const keyboardOpened = await page.evaluate(() => document.querySelector(".page.is-active")?.dataset.page);
    check("H3", focusable && keyboardOpened === "instances", `server card is a focusable button and opens on Enter (page=${keyboardOpened})`);
    await page.evaluate(() => window.AnxServerView?.close?.());

    // ------------------------------------------------------------ H4 computer card
    await goHome(page);
    const computerId = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="home-computer"]');
      card.click();
      return card.dataset.computerId;
    });
    await page.waitForTimeout(600);
    const computers = await page.evaluate(() => ({ page: document.querySelector(".page.is-active")?.dataset.page, details: document.querySelector(".computer-details")?.innerText.length || 0 }));
    check("H4", computers.page === "nodes" && computers.details > 0, `a computer card opens Computers with its details (${computerId}, page=${computers.page})`);

    // ------------------------------------------------------------ H5 customize
    await goHome(page);
    const toggle = page.locator('[data-testid="home-customize-toggle"]');
    await toggle.click();
    await page.waitForTimeout(200);
    const openState = await page.evaluate(() => ({
      expanded: document.querySelector('[data-testid="home-customize-toggle"]').getAttribute("aria-expanded"),
      hidden: document.querySelector('[data-testid="home-customize"]').hidden,
      rows: [...document.querySelectorAll('[data-testid="home-customize-row"]')].map((row) => row.dataset.sectionId),
      labels: [...document.querySelectorAll("[data-home-customize-move]")].map((button) => button.getAttribute("aria-label")),
    }));
    check("H5", openState.expanded === "true" && !openState.hidden && openState.rows.length === 4, `Customize opens (aria-expanded=${openState.expanded}); rows ${openState.rows.join(", ")}`);
    check("H5", openState.labels.length === 8 && openState.labels.every((label) => /^Move .+ (up|down)$/.test(label)), `move buttons name their section (${openState.labels.slice(0, 2).join(", ")}, ...)`);
    await shot(page, "a2-1280-customize");

    // Hide Computers (not required) and move Setup checklist up with the keyboard.
    await page.locator('[data-testid="home-customize-row"][data-section-id="computers"] input[type="checkbox"]').click();
    const setupUp = page.locator('[data-testid="home-customize-row"][data-section-id="setup"] [data-home-customize-move="up"]');
    await setupUp.focus();
    await page.keyboard.press("Enter");
    await page.waitForTimeout(200);
    const afterMove = await page.evaluate(() => ({
      order: [...document.querySelectorAll('[data-testid^="home-section-"]')].map((section) => section.dataset.homeSection),
      computersHidden: document.querySelector('[data-home-section="computers"]').hidden,
      focus: document.activeElement?.getAttribute("aria-label"),
    }));
    check("H5", afterMove.computersHidden && afterMove.order.indexOf("setup") < afterMove.order.indexOf("computers"), `hide and move apply at once: order ${afterMove.order.join(" > ")}, computers hidden=${afterMove.computersHidden}`);
    check("H5", /^Move Setup checklist (up|down)$/.test(afterMove.focus || ""), `keyboard focus stays on the moved section ("${afterMove.focus}")`);

    await page.reload();
    await waitFor(page, () => typeof window.showPage === "function" && (document.querySelector(".nav-menu")?.getBoundingClientRect().width || 0) > 0, null, "reload");
    await goHome(page);
    const persisted = await page.evaluate(() => ({
      order: [...document.querySelectorAll('[data-testid^="home-section-"]')].map((section) => section.dataset.homeSection),
      computersHidden: document.querySelector('[data-home-section="computers"]').hidden,
    }));
    check("H5", persisted.computersHidden && persisted.order.join() === afterMove.order.join(), `choices survive a reload (${persisted.order.join(" > ")}, computers hidden=${persisted.computersHidden})`);

    await page.locator('[data-testid="home-customize-toggle"]').click();
    await page.waitForTimeout(200);
    await page.locator('[data-testid="home-customize"] button', { hasText: "Reset to default" }).click();
    await page.waitForTimeout(200);
    const reset = await page.evaluate(() => ({
      order: [...document.querySelectorAll('[data-testid^="home-section-"]')].map((section) => section.dataset.homeSection),
      anyHidden: [...document.querySelectorAll('[data-testid^="home-section-"]')].some((section) => section.hidden),
    }));
    check("H5", reset.order.join() === "attention,servers,computers,setup" && !reset.anyHidden, `Reset restores the default (${reset.order.join(" > ")})`);

    // ------------------------------------------------------------ H6 density
    const density = await page.evaluate(async () => {
      const select = document.querySelector('[data-testid="home-customize"] select');
      select.value = "compact";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; i < 40 && document.documentElement.dataset.uiDensity !== "compact"; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      const compact = document.documentElement.dataset.uiDensity;
      select.value = "comfortable";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      for (let i = 0; i < 40 && document.documentElement.dataset.uiDensity === "compact"; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
      return { compact, back: document.documentElement.dataset.uiDensity };
    });
    check("H6", density.compact === "compact" && density.back !== "compact", `density select drives the app-wide density (compact=${density.compact}, back=${density.back})`);
    await page.locator('[data-testid="home-customize-toggle"]').click();
    const closed = await page.evaluate(() => ({ expanded: document.querySelector('[data-testid="home-customize-toggle"]').getAttribute("aria-expanded"), hidden: document.querySelector('[data-testid="home-customize"]').hidden }));
    check("H5", closed.expanded === "false" && closed.hidden, `Customize closes (aria-expanded=${closed.expanded})`);

    // ------------------------------------------------------------ H7 actions
    // Since A4, Create Server opens Add Server in the main window (no window
    // may open; the window count is still checked).
    const windowCount = () => evaluateMain(real.app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length);
    const windowsBefore = await windowCount();
    const idsBefore = await evaluateMain(real.app, ({ BrowserWindow }) => BrowserWindow.getAllWindows().map((win) => win.id));
    const ROUTES = { "create-server": "marketplace", instances: "instances", nodes: "nodes", backups: "backups", "public-access": "playit", docker: "docker", "share-server": null };
    const routed = [];
    for (const [action, expected] of Object.entries(ROUTES)) {
      await goHome(page);
      const landed = await page.evaluate(async (name) => {
        const details = document.querySelector('[data-testid="home-details"]');
        details.open = true;
        const button = details.querySelector(`[data-dashboard-action="${name}"]`);
        if (!button) return "missing";
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
        return document.querySelector(".page.is-active")?.dataset.page || "none";
      }, action);
      // Share with Friends opens a dialog or the sharing page depending on state.
      let ok = expected ? landed === expected : landed !== "missing";
      if (expected === "window") {
        let opened = 0;
        for (let i = 0; i < 40 && opened <= windowsBefore; i += 1) { opened = await windowCount(); if (opened <= windowsBefore) await page.waitForTimeout(150); }
        ok = landed !== "missing" && opened > windowsBefore;
        // Close only the window this action opened.
        await evaluateMain(real.app, ({ BrowserWindow }, keep) => { BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed() && !keep.includes(win.id)).forEach((win) => win.close()); }, idsBefore);
        await page.waitForTimeout(300);
      }
      routed.push(`${action}->${landed}${ok ? "" : " (expected " + expected + ")"}`);
      await page.keyboard.press("Escape").catch(() => {});
      if (!ok) check("H7", false, `quick action ${action} landed on ${landed}`);
    }
    check("H7", routed.every((entry) => !entry.includes("expected")), `quick actions route: ${routed.join(", ")}`);
    const windowsAfter = await windowCount();
    check("H7", windowsAfter === windowsBefore, `no Home action opens a window (${windowsBefore} → ${windowsAfter})`);
    await goHome(page);
    const inventoried = await page.evaluate(() => ["refresh", "start-all", "stop-all", "restart-agent"].map((name) => [name, Boolean(document.querySelector(`[data-testid="home-details"] [data-dashboard-action="${name}"]`))]));
    check("H7", inventoried.every(([, present]) => present) && await page.evaluate(() => Boolean(document.querySelector("[data-dashboard-next-action]")) && Boolean(document.querySelector('[data-setup-health-action="continue"]'))), `the other inventoried Home controls are present: ${inventoried.map(([name, present]) => `${name}=${present}`).join(", ")}, next step, Continue Setup`);

    // ------------------------------------------------------------ H11 behaviour of the other A2 rows
    // Actions that would restart the fixture Agent or every server are
    // checked at the function they call (recorded, not run); the rest run.
    await goHome(page);
    const spied = await page.evaluate(async () => {
      const calls = [];
      const originals = { runAgentControlAction, runDashboardBulkInstanceAction, runDashboardFriendlyAction, showToast };
      window.runAgentControlAction = async (...args) => { calls.push(`agent:${args[0]}`); };
      window.runDashboardBulkInstanceAction = async (...args) => { calls.push(`bulk:${args[0]}`); };
      window.runDashboardFriendlyAction = (...args) => { calls.push(`friendly:${args[0]}`); return originals.runDashboardFriendlyAction(...args); };
      window.showToast = (message, tone) => { calls.push(`toast:${message}`); return originals.showToast(message, tone); };
      try {
        const details = document.querySelector('[data-testid="home-details"]');
        details.open = true;
        for (const name of ["restart-agent", "start-all", "stop-all", "refresh"]) {
          details.querySelector(`[data-dashboard-action="${name}"]`).click();
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        // Refresh waits for every page's refresh before it confirms (up to 30 s;
        // the snapshot read alone took 4 to 6 s on the test PC on 2026-11-24).
        for (let i = 0; i < 300 && !calls.includes("toast:Dashboard refreshed."); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
        document.querySelector("[data-dashboard-next-action]").click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        window.showPage("dashboard");
        document.querySelector('[data-setup-health-action="continue"]').click();
        await new Promise((resolve) => setTimeout(resolve, 300));
      } finally {
        Object.assign(window, originals);
      }
      return calls;
    });
    check("H11", ["agent:restart", "bulk:start", "bulk:stop"].every((call) => spied.includes(call)), `Restart Agent, Start All and Stop All reach their actions (${spied.filter((call) => /^(agent|bulk):/.test(call)).join(", ")})`);
    check("H11", spied.some((call) => call === "toast:Dashboard refreshed."), "Refresh Dashboard refreshes and confirms");
    check("H11", spied.filter((call) => call.startsWith("friendly:")).length >= 6, `next step and Continue Setup run their actions (${spied.filter((call) => call.startsWith("friendly:")).slice(-2).join(", ")})`);
    await page.keyboard.press("Escape").catch(() => {});

    await goHome(page);
    const attention = await page.evaluate(async () => {
      const button = document.querySelector('[data-testid="home-attention-item"] [data-attention-action]');
      if (!button) return { label: null, page: null };
      const label = button.innerText.trim();
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      return { label, id: button.dataset.attentionAction, page: document.querySelector(".page.is-active")?.dataset.page };
    });
    check("H11", attention.label && attention.page && attention.page !== "dashboard", `attention action "${attention.label}" (${attention.id}) opens ${attention.page}`);

    // The computer details panel on Computers: internet check (system.networkCheck).
    await page.evaluate(() => window.AnxHomeDashboard.openComputer("qa"));
    await page.waitForTimeout(500);
    const network = await page.evaluate(async () => {
      const button = document.querySelector('[data-network-check="qa"]');
      if (!button) return "no button";
      button.click();
      for (let i = 0; i < 300; i += 1) {
        const result = document.querySelector('[data-network-check-result="qa"]');
        if (result && result.innerText.trim()) return result.innerText.trim().slice(0, 80);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return "no result";
    });
    check("H11", network !== "no button" && network !== "no result", `internet check runs from the computer details and shows a result ("${network.replace(/\n/g, " / ")}")`);

    // First-server guide: close and "Browse all games".
    const firstServer = await page.evaluate(async () => {
      const wait = () => new Promise((resolve) => setTimeout(resolve, 250));
      openFirstServerGuide();
      await wait();
      const opened = Boolean(document.querySelector("[data-first-server-modal] [role=dialog]"));
      // Initial focus is set on the next animation frame.
      for (let i = 0; i < 20 && !document.activeElement?.closest("[data-first-server-modal]"); i += 1) await wait();
      const focusInside = Boolean(document.activeElement?.closest("[data-first-server-modal]"));
      const focused = `${document.activeElement?.tagName}.${document.activeElement?.className}`.slice(0, 60);
      const visibility = document.visibilityState;
      document.querySelector('[data-first-server-modal] [data-first-server-action="close"]').click();
      await wait();
      const closed = !document.querySelector("[data-first-server-modal]");
      openFirstServerGuide();
      await wait();
      document.querySelector('[data-first-server-modal] [data-first-server-action="marketplace"]').click();
      await wait();
      return { opened, focusInside, focused, visibility, closed, browse: document.querySelector(".page.is-active")?.dataset.page, gone: !document.querySelector("[data-first-server-modal]") };
    });
    check("H11", firstServer.opened && firstServer.focusInside && firstServer.closed && firstServer.browse === "marketplace" && firstServer.gone, `first-server guide opens with focus inside, closes, and "Browse all games" opens Add Server (${JSON.stringify(firstServer)})`);

    // Shared dialog rule behind that fix: a disabled initial target still
    // leaves focus inside the dialog.
    const fallback = await page.evaluate(async () => {
      const overlay = document.createElement("div");
      overlay.className = "app-modal-backdrop";
      overlay.innerHTML = '<section class="app-modal" role="dialog" aria-modal="true" tabindex="-1"><button type="button" disabled data-qa-disabled>Unavailable</button><button type="button" data-qa-enabled>Available</button></section>';
      document.body.append(overlay);
      const deactivate = activateModal(overlay, { initialFocus: () => overlay.querySelector("[data-qa-disabled]") });
      for (let i = 0; i < 20 && !overlay.contains(document.activeElement); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      const focused = document.activeElement?.hasAttribute("data-qa-enabled");
      deactivate();
      overlay.remove();
      return focused;
    });
    check("H11", fallback, "a dialog whose initial target is disabled focuses its first enabled control");

    // Home IPC rows, called as the renderer calls them, as the signed-in owner.
    const ipc = await page.evaluate(async () => {
      const api = window.anxos;
      const nodeId = getSelectedNodeId();
      const run = async (name, call) => {
        try { const value = await call(); return `${name}=${value && value.ok === false ? `refused:${value.error?.code || value.error?.message || "?"}` : "ok"}`; } catch (error) { return `${name}=threw:${String(error?.message || error).slice(0, 60)}`; }
      };
      return [
        await run("system.getSnapshot", () => api.system.getSnapshot({ nodeId })),
        await run("telemetry.getSummary", () => api.telemetry.getSummary({ nodeId })),
        await run("telemetry.getSeries", () => api.telemetry.getSeries({ nodeId, keys: [], sinceMs: Date.now() - 3600000 })),
        await run("telemetry.export", () => api.telemetry.export({ nodeId })),
        await run("telemetry.clear", () => api.telemetry.clear({ nodeId })),
        await run("amp.getSnapshot", () => api.amp.getSnapshot({ nodeId })),
      ];
    });
    const ipcOk = ipc.filter((entry) => entry.endsWith("=ok") || entry.startsWith("amp.getSnapshot=refused"));
    check("H11", ipcOk.length === ipc.length, `Home IPC calls answer (${ipc.join(", ")}; AMP may refuse when no AMP is configured)`);
    await goHome(page);

    // ------------------------------------------------------------ H8 layout
    for (const [width, height] of [[900, 640], [1280, 800], [1920, 1080]]) {
      await real.setViewport(width, height);
      await goHome(page);
      await page.evaluate(() => { document.querySelector('[data-testid="home-details"]').open = false; });
      await page.waitForTimeout(400);
      const layout = await page.evaluate(() => {
        const home = document.querySelector('[data-testid="home-page"]');
        const host = home.closest("[data-page-host]") || home.parentElement;
        const clipped = [...home.querySelectorAll(".home-tile__label, .home-tile__value, .home-section__header h2, .home-computer__title strong, .dashboard-app-card strong, .page-header h1, .inline-action")]
          .filter((element) => element.getBoundingClientRect().width > 0)
          .filter((element) => {
            const style = getComputedStyle(element);
            if (style.textOverflow === "ellipsis") return false;
            return element.scrollWidth > element.clientWidth + 1 && style.overflowX !== "visible";
          })
          .map((element) => element.innerText.trim().slice(0, 30));
        const outside = [...home.querySelectorAll(".home-tile, .home-section, .home-computer, .dashboard-app-card, .page-header")]
          .filter((element) => element.getBoundingClientRect().width > 0)
          .filter((element) => element.getBoundingClientRect().right > host.getBoundingClientRect().right + 1)
          .map((element) => element.className.split(" ")[0]);
        return { overflowX: host.scrollWidth > host.clientWidth + 1, docOverflow: document.documentElement.scrollWidth > window.innerWidth + 1, clipped, outside };
      });
      check("H8", !layout.overflowX && !layout.docOverflow && !layout.clipped.length && !layout.outside.length, `${width}x${height}: no horizontal overflow (page=${layout.overflowX}, window=${layout.docOverflow}), clipped=[${layout.clipped.join("; ")}], outside=[${layout.outside.join(", ")}]`);
      await shot(page, `a2-${width}x${height}-home`);
    }

    // ------------------------------------------------------------ H9 contrast
    await real.setViewport(1280, 800);
    await goHome(page);
    const contrast = await page.evaluate(new Function(`${CONTRAST_HELPERS}
      const home = document.querySelector('[data-testid="home-page"]');
      const textNodes = [...home.querySelectorAll(".page-header h1, .page-header .eyebrow, .page-header .lede, .home-tile__label, .home-tile__value, .home-tile__detail, .home-section__header h2, .home-attention__text strong, .home-attention__text span, .home-attention__ok, .home-computer__title strong, .home-computer__title span, .home-computer__foot span, .home-meter__label, .home-meter__value, .home-status, .dashboard-app-card strong, .dashboard-app-card__meta span, .instance-state, .status-pill, .inline-action:not(:disabled), .dashboard-setup-health__header p")]
        .filter((element) => element.getBoundingClientRect().width > 0 && element.innerText.trim());
      const low = [];
      for (const element of textNodes) {
        const fg = parse(getComputedStyle(element).color);
        const r = ratio(over(fg, backgroundOf(element)), backgroundOf(element));
        if (r < 4.5) low.push(element.className.split(" ")[0] + " '" + element.innerText.trim().slice(0, 24) + "' " + r.toFixed(2));
      }
      const shapes = [...home.querySelectorAll(".home-status")].map((status) => {
        const before = getComputedStyle(status, "::before");
        const colour = parse(before.backgroundColor)?.a > 0 ? parse(before.backgroundColor) : parse(before.borderTopColor);
        return ratio(over(colour, backgroundOf(status.parentElement)), backgroundOf(status.parentElement));
      });
      return { count: textNodes.length, low, shapes: shapes.map((value) => Number(value.toFixed(2))) };
    `));
    check("H9", contrast.count > 20 && contrast.low.length === 0, `Home text meets 4.5:1 (${contrast.count} elements)${contrast.low.length ? `; below: ${contrast.low.slice(0, 6).join(" | ")}` : ""}`);
    check("H9", contrast.shapes.length > 0 && contrast.shapes.every((value) => value >= 3), `status shapes meet 3:1 (${contrast.shapes.join(", ")})`);

    // ------------------------------------------------------------ H10 errors
    check("H10", rendererErrors.length === 0, rendererErrors.length ? `renderer errors: ${rendererErrors.slice(0, 3).join(" | ")}` : "no renderer errors");
  } finally {
    await real.close();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${failed.length ? "FAIL" : "PASS"} anxhost-home-ui-qa: ${results.length - failed.length}/${results.length} checks`);
  if (failed.length) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
