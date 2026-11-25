#!/usr/bin/env node
"use strict";

// Build 216-A1 Desktop Shell Rebirth: acceptance checks in the REAL app
// (docs/anxhost/A1_FINISH_LINE.md). Off-screen, isolated profile, real Agent
// test fixture; see scripts/test-helpers/anxhost-real-app.js.
//
//   S1  title bar: AnxHost CC brand, simplified mark at 20-28 px, window title,
//       window controls visible and not covered
//   S2  sidebar information architecture: Run / Infrastructure / Tools / footer
//   S3  all 20 pages: 17 reachable from the sidebar and destination tabs,
//       Anx Workspace owner-gated from the footer, legacy amp/coolpals keep
//       their redirect; every reachable page is also in global search
//   S4  responsive: expanded at 1280, icon rail at 900x640 with every entry
//       visible and content above the fold, overlay via Ctrl+B and Esc,
//       hand-collapse remembered with the existing storage key
//   S5  keyboard: Tab reaches the nav with a visible focus ring, Ctrl+K and
//       Ctrl+Shift+P open and Esc closes search and the palette, all 10
//       inventoried shortcuts still handled
//   S6  operation tray: a running operation shows "1 running", opens the
//       tray, Esc closes it, an item opens Activity › Task details
//   S7  contrast: WCAG AA (4.5:1) for shell text, 3:1 for icons and focus ring
//   S8  branding: no "AnxOS Control Center" in shell surfaces; frozen data
//       folder and storage keys unchanged
//   S9  shared dialog pattern and Assistant: update dialog, onboarding and
//       Assistant open with the AnxHost surfaces
//   S10 no renderer errors
//
// Usage: node scripts/anxhost-shell-ui-qa.js [--shots=<dir>]

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { launchRealApp } = require("./test-helpers/anxhost-real-app");
const { selector } = require("../test-helpers/testid-convention");

const shotsArg = process.argv.find((arg) => arg.startsWith("--shots="));
const SHOTS = shotsArg ? path.resolve(shotsArg.slice(8)) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (id, ok, message) => {
  results.push({ id, ok: Boolean(ok), message });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${message}`);
};

const SIDEBAR = [
  { group: "run", pages: ["dashboard", "instances", "marketplace"] },
  { group: "infrastructure", pages: ["nodes", "docker", "playit"] },
  { group: "tools", pages: ["files", "ssh", "backups"] },
  { group: "footer", pages: ["notifications", "security", "settings"] },
];
// Tab pages and the destination whose entry they highlight.
const TAB_PAGES = { "agent-control": "nodes", network: "playit", console: "ssh", operations: "notifications", maintenance: "notifications" };

// Every visible sidebar entry and the computer switcher fit without scrolling.
function sidebarFits() {
  const menu = document.querySelector(".nav-menu");
  const items = [...document.querySelectorAll(".nav-group [data-page-target]")].filter((item) => !item.hidden);
  const switcherRect = document.querySelector("[data-sidebar-footer]").getBoundingClientRect();
  return {
    count: items.length,
    fits: menu.scrollHeight <= menu.clientHeight + 1
      && items.every((item) => { const r = item.getBoundingClientRect(); return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight; })
      && switcherRect.height > 0 && switcherRect.bottom <= window.innerHeight,
  };
}

async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 15000 }).catch(() => {});
}

// In-page contrast helpers (Chromium reports color-mix results as color(srgb ...)).
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

async function run() {
  const real = await launchRealApp({ prefix: "anx-216-a1-qa-" });
  const { page, rendererErrors } = real;
  try {
    await real.setViewport(1280, 800);
    await page.waitForTimeout(800);
    await page.evaluate(() => window.showPage("dashboard"));
    await shot(page, "a1-1280-home");

    // ------------------------------------------------------------ S1 title bar
    const titlebar = await page.evaluate(() => {
      const brand = document.querySelector('[data-testid="shell-titlebar-brand"]');
      const mark = brand?.querySelector("img");
      const rect = mark?.getBoundingClientRect();
      const controls = [...document.querySelectorAll("[data-window-action]")].map((button) => {
        const r = button.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return { action: button.dataset.windowAction, visible: r.width > 0 && r.height > 0, uncovered: Boolean(hit && button.contains(hit)) };
      });
      const full = brand?.querySelector("[data-app-name]")?.getBoundingClientRect();
      return {
        brandText: brand?.querySelector(".app-titlebar__brand-short")?.innerText.trim() || "",
        fullNameClipped: Boolean(full && full.width <= 1 && full.height <= 1),
        markSrc: mark?.getAttribute("src") || "",
        markSize: rect ? [Math.round(rect.width), Math.round(rect.height)] : [0, 0],
        title: document.title,
        controls,
      };
    });
    check("S1", titlebar.brandText === "AnxHost CC" && titlebar.fullNameClipped, `title bar shows "${titlebar.brandText}"; the full display name is kept for screen readers and the window title (clipped=${titlebar.fullNameClipped})`);
    check("S1", /anxhost-icon-small\.svg$/.test(titlebar.markSrc) && titlebar.markSize.every((v) => v >= 20 && v <= 28), `title bar mark is the simplified mark at ${titlebar.markSize.join("x")} px (${titlebar.markSrc})`);
    check("S1", titlebar.title === "AnxHost Control Center", `window title "${titlebar.title}"`);
    check("S1", titlebar.controls.length === 3 && titlebar.controls.every((c) => c.visible && c.uncovered), `window controls visible and uncovered: ${titlebar.controls.map((c) => `${c.action}=${c.visible && c.uncovered}`).join(", ")}`);

    // ------------------------------------------------------------ S2 sidebar IA
    const ia = await page.evaluate(() => [...document.querySelectorAll(".nav-menu > .nav-group")].map((group) => ({
      group: group.dataset.navGroup,
      heading: group.querySelector(".nav-group__label")?.textContent.trim(),
      pages: [...group.querySelectorAll(".nav-group__items > [data-page-target]")].filter((item) => !item.hidden).map((item) => item.dataset.pageTarget),
      labels: [...group.querySelectorAll(".nav-group__items > [data-page-target]")].filter((item) => !item.hidden).map((item) => item.querySelector("[data-nav-label]")?.textContent.trim()),
      hasOwner: Boolean(group.querySelector("[data-owner-workspace-nav]")),
    })));
    check("S2", JSON.stringify(ia.map(({ group, pages }) => ({ group, pages }))) === JSON.stringify(SIDEBAR), `groups ${ia.map((g) => `${g.group}[${g.pages.join(",")}]`).join(" ")}`);
    check("S2", ia.slice(0, 3).map((g) => g.heading).join("/") === "Run/Infrastructure/Tools", `headings ${ia.map((g) => g.heading).join(" / ")}`);
    check("S2", JSON.stringify(ia.flatMap((g) => g.labels)) === JSON.stringify(["Home", "My Servers", "Add Server", "Computers", "Docker", "Network", "Files", "Terminal", "Backups", "Activity", "Security", "Settings"]), `labels ${ia.flatMap((g) => g.labels).join(", ")}`);
    check("S2", ia.find((g) => g.group === "footer")?.hasOwner === true, "Anx Workspace entry sits in the footer group");
    const switcher = await page.evaluate(() => {
      const button = document.querySelector('[data-testid="shell-computer-switcher"]');
      return Boolean(button && button.getBoundingClientRect().height > 0 && button.closest(".sidebar"));
    });
    check("S2", switcher, "computer switcher is visible at the bottom of the sidebar");

    // ------------------------------------------------------------ S3 all 20 pages
    const allPages = await page.evaluate(() => [...document.querySelectorAll("section.page[data-page]")].map((el) => el.dataset.page));
    check("S3", allPages.length === 20, `${allPages.length} pages in the DOM`);
    const reached = [];
    for (const { pages } of SIDEBAR) {
      for (const target of pages) {
        if (target === "marketplace") continue; // opens its own window until A4; checked below
        await page.locator(`.nav-group [data-page-target="${target}"]`).click();
        await page.waitForTimeout(150);
        const active = await page.evaluate(() => window.getActivePageName?.() || document.querySelector("section.page.is-active")?.dataset.page);
        if (active === target) reached.push(target);
        else check("S3", false, `sidebar entry ${target} opened ${active}`);
      }
    }
    // Add Server keeps its current behaviour (separate Marketplace window until A4).
    const marketplaceHandled = await page.evaluate(() => {
      const item = document.querySelector('.nav-group [data-page-target="marketplace"]');
      return Boolean(item && !item.hidden && item.getBoundingClientRect().height > 0);
    });
    if (marketplaceHandled) {
      await page.evaluate(() => window.showPage("marketplace"));
      const active = await page.evaluate(() => window.getActivePageName?.());
      if (active === "marketplace") reached.push("marketplace");
    }
    for (const [tabPage, parent] of Object.entries(TAB_PAGES)) {
      await page.locator(`.nav-group [data-page-target="${parent}"]`).click();
      await page.waitForTimeout(150);
      const tab = page.locator(`section.page[data-page="${parent}"] [data-page-tab="${tabPage}"]`);
      const visible = await tab.isVisible().catch(() => false);
      if (visible) await tab.click();
      await page.waitForTimeout(150);
      const state = await page.evaluate(([name, owner]) => ({
        active: window.getActivePageName?.(),
        highlighted: document.querySelector(`.nav-group [data-page-target="${owner}"]`)?.getAttribute("aria-current") === "page",
        tabActive: document.querySelector(`section.page[data-page="${name}"] [data-page-tab="${name}"]`)?.classList.contains("is-active"),
      }), [tabPage, parent]);
      const ok = visible && state.active === tabPage && state.highlighted && state.tabActive;
      if (ok) reached.push(tabPage);
      check("S3", ok, `${tabPage}: tab on ${parent} opens it (active=${state.active}, ${parent} highlighted=${state.highlighted}, tab marked=${state.tabActive})`);
    }
    check("S3", reached.length === 17, `${reached.length}/17 regular pages reachable from the sidebar and tabs`);
    const ownerGate = await page.evaluate(() => {
      const toggle = document.querySelector("[data-owner-workspace-toggle]");
      window.showPage("owner-workspace");
      return { inFooter: Boolean(toggle?.closest('.nav-group[data-nav-group="footer"]')), active: window.getActivePageName?.() };
    });
    check("S3", ownerGate.inFooter && ownerGate.active !== "owner-workspace", `Anx Workspace is in the footer and stays owner-gated (signed out, opened ${ownerGate.active})`);
    const legacy = await page.evaluate(() => ["amp", "coolpals"].map((name) => { window.showPage(name); return [name, window.getActivePageName?.()]; }));
    check("S3", legacy.every(([, active]) => active === "dashboard"), `legacy pages keep their redirect: ${legacy.map(([a, b]) => `${a}->${b}`).join(", ")}`);
    const searchable = await page.evaluate(() => (typeof getWorkspaceSearchEntries === "function" ? getWorkspaceSearchEntries().map((entry) => entry.id) : []));
    const missingFromSearch = reached.filter((name) => !searchable.includes(name));
    check("S3", missingFromSearch.length === 0, `every reachable page is in global search${missingFromSearch.length ? ` (missing ${missingFromSearch.join(", ")})` : ""}`);

    // ------------------------------------------------------------ S4 responsive
    await page.evaluate(() => window.showPage("dashboard"));
    const expanded = await page.evaluate(() => ({
      mode: document.querySelector("[data-app-workspace]")?.dataset.sidebarMode,
      width: Math.round(document.querySelector("[data-sidebar]").getBoundingClientRect().width),
    }));
    check("S4", expanded.mode === "expanded" && expanded.width === 240, `1280x800: sidebar ${expanded.mode}, ${expanded.width} px`);
    await page.keyboard.press("Control+b");
    await page.waitForTimeout(200);
    const handCollapsed = await page.evaluate(() => ({ mode: document.querySelector("[data-app-workspace]")?.dataset.sidebarMode, stored: localStorage.getItem("anxos.sidebar.v1") }));
    check("S4", handCollapsed.mode === "rail" && handCollapsed.stored === "collapsed", `Ctrl+B at 1280 collapses to the rail and remembers it (anxos.sidebar.v1=${handCollapsed.stored})`);
    await shot(page, "a1-1280-rail-by-hand");
    await page.keyboard.press("Control+b");
    await page.waitForTimeout(200);

    for (const [w, h] of [[900, 640], [1099, 700]]) {
      const viewport = await real.setViewport(w, h);
      await page.waitForTimeout(400);
      const rail = await page.evaluate(() => {
        const sidebar = document.querySelector("[data-sidebar]");
        const menu = document.querySelector(".nav-menu");
        const items = [...document.querySelectorAll(".nav-group [data-page-target]")].filter((item) => !item.hidden);
        const switcherRect = document.querySelector("[data-sidebar-footer]").getBoundingClientRect();
        const main = document.querySelector("[data-page-host]").getBoundingClientRect();
        const heading = document.querySelector("section.page.is-active .page-header h1")?.getBoundingClientRect();
        return {
          mode: document.querySelector("[data-app-workspace]")?.dataset.sidebarMode,
          width: Math.round(sidebar.getBoundingClientRect().width),
          allVisible: items.every((item) => { const r = item.getBoundingClientRect(); return r.height > 0 && r.bottom <= window.innerHeight && r.top >= 0; }),
          noScroll: menu.scrollHeight <= menu.clientHeight + 1,
          switcherVisible: switcherRect.bottom <= window.innerHeight && switcherRect.height > 0,
          tooltips: items.every((item) => item.title.length > 0),
          mainLeft: Math.round(main.left),
          mainWidth: Math.round(main.width),
          headingTop: heading ? Math.round(heading.top) : null,
          overflowX: document.documentElement.scrollWidth > window.innerWidth,
        };
      });
      check("S4", rail.mode === "rail" && rail.width === 64, `${viewport}: icon rail, ${rail.width} px`);
      check("S4", rail.allVisible && rail.noScroll && rail.switcherVisible, `${viewport}: all 12 entries and the computer switcher visible without scrolling`);
      check("S4", rail.tooltips, `${viewport}: every rail entry has a tooltip`);
      check("S4", rail.mainLeft === 64 && rail.mainWidth >= w - 64 - 1 && rail.headingTop !== null && rail.headingTop < 160 && !rail.overflowX, `${viewport}: page content starts at the top (h1 at ${rail.headingTop} px), ${rail.mainWidth} px wide, no horizontal overflow`);
    }
    await real.setViewport(900, 640);
    await page.waitForTimeout(300);
    await shot(page, "a1-900-rail");
    await page.keyboard.press("Control+b");
    await page.waitForTimeout(250);
    const overlay = await page.evaluate(() => ({
      mode: document.querySelector("[data-app-workspace]")?.dataset.sidebarMode,
      width: Math.round(document.querySelector("[data-sidebar]").getBoundingClientRect().width),
      mainLeft: Math.round(document.querySelector("[data-page-host]").getBoundingClientRect().left),
      focusInSidebar: Boolean(document.activeElement?.closest("[data-sidebar]")),
    }));
    const overlayFit = await page.evaluate(sidebarFits);
    check("S4", overlayFit.fits && overlayFit.count === 12, `900x640 overlay: all ${overlayFit.count} entries and the switcher fit without scrolling`);
    check("S4", overlay.mode === "overlay" && overlay.width === 240 && overlay.mainLeft === 64 && overlay.focusInSidebar, `900x640 Ctrl+B opens the overlay sidebar (${overlay.width} px over the page, page stays at ${overlay.mainLeft} px, focus moved in)`);
    await shot(page, "a1-900-overlay");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const closed = await page.evaluate(() => ({ mode: document.querySelector("[data-app-workspace]")?.dataset.sidebarMode, focus: document.activeElement?.matches("[data-sidebar-toggle]") }));
    check("S4", closed.mode === "rail" && closed.focus, `Esc closes the overlay and returns focus to the toggle (mode=${closed.mode})`);
    await page.keyboard.press("Control+b");
    await page.waitForTimeout(200);
    await page.locator('.nav-group [data-page-target="docker"]').click();
    await page.waitForTimeout(200);
    const navClosed = await page.evaluate(() => ({ mode: document.querySelector("[data-app-workspace]")?.dataset.sidebarMode, active: window.getActivePageName?.() }));
    check("S4", navClosed.mode === "rail" && navClosed.active === "docker", "choosing a page in the overlay opens it and closes the overlay");
    // Phone width (below the desktop minimum; the responsive suite's sizes):
    // the rail steps aside and the title-bar menu opens the sidebar over the page.
    await real.setViewport(390, 844);
    await page.waitForTimeout(300);
    const phone = await page.evaluate(() => ({
      sidebarShown: document.querySelector("[data-sidebar]").getBoundingClientRect().width > 0,
      menuShown: document.querySelector("[data-sidebar-menu]").getBoundingClientRect().width > 0,
      mainLeft: Math.round(document.querySelector("[data-page-host]").getBoundingClientRect().left),
    }));
    await page.locator(selector("shell-sidebar-menu")).click();
    await page.waitForTimeout(250);
    const phoneOpen = await page.evaluate(() => ({
      mode: document.querySelector("[data-app-workspace]")?.dataset.sidebarMode,
      width: Math.round(document.querySelector("[data-sidebar]").getBoundingClientRect().width),
    }));
    await shot(page, "a1-390-phone-overlay");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const phoneClosed = await page.evaluate(() => ({ mode: document.querySelector("[data-app-workspace]")?.dataset.sidebarMode, focus: document.activeElement?.matches("[data-sidebar-menu]") }));
    check("S4", !phone.sidebarShown && phone.menuShown && phone.mainLeft === 0, `390x844: rail hidden, title-bar menu shown, page uses the full width (left ${phone.mainLeft})`);
    check("S4", phoneOpen.mode === "overlay" && phoneOpen.width === 240 && phoneClosed.mode === "rail" && phoneClosed.focus, `390x844: the menu opens the sidebar over the page (${phoneOpen.width} px); Esc closes it and returns focus to the menu`);

    await real.setViewport(1280, 640);
    await page.waitForTimeout(300);
    const shortFit = await page.evaluate(() => ({ mode: document.querySelector("[data-app-workspace]")?.dataset.sidebarMode }));
    const shortFits = await page.evaluate(sidebarFits);
    check("S4", shortFit.mode === "expanded" && shortFits.fits, `1280x640: expanded sidebar fits without scrolling (${shortFit.mode})`);
    await shot(page, "a1-1280x640-expanded");
    await real.setViewport(1280, 800);
    await page.waitForTimeout(300);

    // ------------------------------------------------------------ S5 keyboard
    await page.evaluate(() => window.showPage("dashboard"));
    await page.evaluate(() => document.querySelector('.nav-group [data-page-target="dashboard"]').focus());
    await page.keyboard.press("Tab");
    const tabbed = await page.evaluate(() => ({
      target: document.activeElement?.dataset?.pageTarget,
      ring: getComputedStyle(document.activeElement).boxShadow,
    }));
    check("S5", tabbed.target === "instances" && tabbed.ring && tabbed.ring !== "none", `Tab moves to the next nav entry (${tabbed.target}) with a visible focus ring`);
    for (const target of ["dashboard", "files", "settings"]) {
      await page.evaluate((name) => window.showPage(name), target);
      await page.locator("body").click({ position: { x: 600, y: 300 } }).catch(() => {});
      await page.keyboard.press("Control+k");
      await page.waitForTimeout(250);
      const searchOpen = await page.locator(selector("shell-global-search")).isVisible();
      const focusInInput = await page.evaluate(() => document.activeElement?.matches("[data-global-search-input]"));
      await page.keyboard.press("Escape");
      await page.waitForTimeout(200);
      const searchClosed = !(await page.locator(selector("shell-global-search")).isVisible());
      check("S5", searchOpen && focusInInput && searchClosed, `${target}: Ctrl+K opens search with focus in the input, Esc closes it`);
    }
    await page.keyboard.press("Control+Shift+P");
    await page.waitForTimeout(250);
    const paletteOpen = await page.locator(selector("shell-command-palette")).isVisible();
    await shot(page, "a1-1280-command-palette");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    const paletteClosed = !(await page.locator(selector("shell-command-palette")).isVisible());
    check("S5", paletteOpen && paletteClosed, "Ctrl+Shift+P opens the command palette, Esc closes it");
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(200);
    await page.keyboard.type("backups");
    await page.waitForTimeout(400);
    await shot(page, "a1-1280-global-search");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    const searchOpened = await page.evaluate(() => window.getActivePageName?.());
    check("S5", searchOpened === "backups", `search "backups" + Enter opens ${searchOpened}`);
    const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
    // The ten inventoried shortcuts (CAPABILITY_INVENTORY.md, Shell › Keyboard
    // shortcuts): K, Shift+P and B are exercised above; the rest are editor,
    // terminal and refresh handlers that A1 does not touch.
    const shortcutPatterns = ["k", "p", "b", "r", "s", "a", "c", "x", "v"].map((key) => `event.key.toLowerCase() === "${key}"`).concat(['event.key === "Insert"']);
    const missingShortcuts = shortcutPatterns.filter((pattern) => !appSource.includes(pattern));
    check("S5", missingShortcuts.length === 0, `all 10 inventoried shortcuts still handled${missingShortcuts.length ? ` (missing ${missingShortcuts.join(" ")})` : ""}`);

    // ------------------------------------------------------------ S6 operation tray
    await page.evaluate(() => window.showPage("dashboard"));
    const hiddenBefore = await page.locator(selector("operation-tray-toggle")).isVisible();
    const operationId = await page.evaluate(() => startOperation({ type: "QA", title: "QA tray check", target: "QA Computer", step: "Working", percent: 40 }));
    await page.waitForTimeout(200);
    const toggleText = (await page.locator(selector("operation-tray-toggle")).innerText()).replace(/\s+/g, " ").trim();
    check("S6", !hiddenBefore && /^1 running$/.test(toggleText), `title bar shows "${toggleText}" while one task runs (hidden before: ${!hiddenBefore})`);
    await page.locator(selector("operation-tray-toggle")).click();
    await page.waitForTimeout(200);
    const trayOpen = await page.evaluate(() => ({
      open: !document.querySelector("[data-operation-tray]").hidden,
      items: document.querySelectorAll('[data-operation-tray] [data-testid="operation-tray-item"]').length,
      expanded: document.querySelector("[data-operation-tray-toggle]").getAttribute("aria-expanded"),
    }));
    await shot(page, "a1-1280-operation-tray");
    check("S6", trayOpen.open && trayOpen.items === 1 && trayOpen.expanded === "true", `tray opens with ${trayOpen.items} item (aria-expanded=${trayOpen.expanded})`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(150);
    const trayEsc = await page.evaluate(() => ({ hidden: document.querySelector("[data-operation-tray]").hidden, focus: document.activeElement?.matches("[data-operation-tray-toggle]") }));
    check("S6", trayEsc.hidden && trayEsc.focus, "Esc closes the tray and returns focus to its button");
    await page.locator(selector("operation-tray-toggle")).click();
    await page.locator(selector("operation-tray-item")).first().click();
    await page.waitForTimeout(250);
    const opened = await page.evaluate(() => ({ active: window.getActivePageName?.(), trayHidden: document.querySelector("[data-operation-tray]").hidden }));
    check("S6", opened.active === "operations" && opened.trayHidden, `a tray item opens Activity › Task details (${opened.active})`);
    await page.evaluate((id) => { updateOperation(id, { status: "completed", step: "Done", percent: 100 }); }, operationId);
    await page.waitForTimeout(200);
    const hiddenAfter = !(await page.locator(selector("operation-tray-toggle")).isVisible());
    check("S6", hiddenAfter, "the running pill disappears when nothing is running");

    // ------------------------------------------------------------ S7 contrast
    await page.evaluate(() => window.showPage("ssh"));
    await page.waitForTimeout(200);
    const contrast = await page.evaluate(new Function(`${CONTRAST_HELPERS}
      const out = [];
      const add = (name, element, min, colourOf = (el) => getComputedStyle(el).color) => {
        if (!element) { out.push({ name, ratio: 0, min, missing: true }); return; }
        const fg = parse(colourOf(element));
        const bg = backgroundOf(element);
        out.push({ name, ratio: Math.round(ratio(fg.a < 1 ? over(fg, bg) : fg, bg) * 100) / 100, min });
      };
      add("title bar brand", document.querySelector(".app-titlebar__brand-short"), 4.5);
      add("title bar page", document.querySelector(".app-titlebar__page"), 4.5);
      add("search box text", document.querySelector(".app-titlebar__search span"), 4.5);
      add("connection label", document.querySelector("[data-titlebar-connection-label]"), 4.5);
      add("group heading", document.querySelector(".nav-group__label"), 4.5);
      add("nav entry", document.querySelector('.nav-group [data-page-target="files"] [data-nav-label]'), 4.5);
      add("nav entry (current)", document.querySelector('.nav-group [data-page-target="ssh"] [data-nav-label]'), 4.5);
      add("nav icon", document.querySelector('.nav-group [data-page-target="files"] .nav-item__icon'), 3);
      add("nav icon (current)", document.querySelector('.nav-group [data-page-target="ssh"] .nav-item__icon'), 3);
      add("tab", document.querySelector('section.page[data-page="ssh"] [data-page-tab="console"]'), 4.5);
      add("tab (current)", document.querySelector('section.page[data-page="ssh"] [data-page-tab="ssh"]'), 4.5);
      add("computer switcher name", document.querySelector(".sidebar-footer__copy strong"), 4.5);
      add("computer switcher detail", document.querySelector(".sidebar-footer__copy span"), 4.5);
      add("window control", document.querySelector('[data-window-action="close"]'), 3);
      // Focus ring: the outer ring colour against the sidebar.
      const ringColour = getComputedStyle(document.documentElement).getPropertyValue("--ahx-violet-400").trim();
      const hex = ringColour.replace("#", "");
      const ring = { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
      out.push({ name: "focus ring", ratio: Math.round(ratio(ring, backgroundOf(document.querySelector(".sidebar"))) * 100) / 100, min: 3 });
      return out;
    `));
    for (const entry of contrast) check("S7", !entry.missing && entry.ratio >= entry.min, `${entry.name}: ${entry.ratio}:1 (min ${entry.min}:1)`);

    // ------------------------------------------------------------ S8 branding
    const branding = await page.evaluate(() => {
      const surfaces = [
        ["title bar", "[data-titlebar]"], ["sidebar", "[data-sidebar]"], ["startup", "[data-startup-screen]"],
        ["security gate", "[data-security-gate]"], ["local setup gate", "[data-local-setup-gate]"],
        ["global search", "[data-global-search]"], ["command palette", "[data-command-palette]"],
        ["onboarding welcome", "[data-onboarding-welcome]"], ["onboarding wizard", "[data-onboarding-wizard]"],
        ["update dialog", "[data-update-modal]"], ["update banner", "[data-update-ready-banner]"],
        ["help", "[data-contextual-help-modal]"], ["operation tray", "[data-operation-tray]"], ["assistant", "[data-assistant-panel]"],
      ];
      return surfaces.map(([name, sel]) => {
        const el = document.querySelector(sel);
        const text = el ? `${el.textContent} ${[...el.querySelectorAll("[aria-label],[title],[placeholder]")].map((n) => `${n.getAttribute("aria-label") || ""} ${n.getAttribute("title") || ""} ${n.getAttribute("placeholder") || ""}`).join(" ")} ${el.getAttribute("aria-label") || ""}` : "";
        return { name, found: Boolean(el), legacy: /AnxOS Control Center/.test(text) };
      });
    });
    const leaking = branding.filter((entry) => !entry.found || entry.legacy).map((entry) => entry.found ? entry.name : `${entry.name} (missing)`);
    check("S8", leaking.length === 0, `no "AnxOS Control Center" in ${branding.length} shell surfaces${leaking.length ? ` (found in ${leaking.join(", ")})` : ""}`);
    const frozen = await page.evaluate(async () => ({
      dataPath: await window.anxos?.app?.getPaths?.().then((p) => p?.userData || "").catch(() => "") || "",
      sidebarKey: Object.keys(localStorage).filter((key) => key.startsWith("anxos.")).length,
    }));
    check("S8", frozen.sidebarKey > 0, `renderer storage keys keep the anxos.* prefix (${frozen.sidebarKey} keys)`);

    // ------------------------------------------------------------ S9 dialogs and Assistant
    await page.evaluate(() => {
      const modal = document.querySelector("[data-update-modal]");
      modal.hidden = false;
    });
    await page.waitForTimeout(200);
    const update = await page.evaluate(() => {
      const dialog = document.querySelector("[data-update-modal] .app-modal");
      const style = getComputedStyle(dialog);
      return { title: document.querySelector("[data-update-title]")?.textContent.trim(), radius: style.borderRadius, visible: dialog.getBoundingClientRect().height > 0 };
    });
    await shot(page, "a1-1280-update-dialog");
    await page.evaluate(() => { document.querySelector("[data-update-modal]").hidden = true; });
    check("S9", update.visible && /AnxHost/.test(update.title) && update.radius === "12px", `update dialog uses the shared AnxHost dialog pattern ("${update.title}", radius ${update.radius})`);
    await page.evaluate(() => { document.querySelector("[data-onboarding-welcome]").hidden = false; });
    await page.waitForTimeout(150);
    await shot(page, "a1-1280-onboarding-welcome");
    const welcome = await page.evaluate(() => document.querySelector("#onboarding-welcome-title")?.textContent.trim());
    await page.evaluate(() => { document.querySelector("[data-onboarding-welcome]").hidden = true; });
    check("S9", welcome === "Welcome to AnxHost Control Center", `onboarding welcome reads "${welcome}"`);
    // Owner-only surfaces: a disposable owner in this isolated profile, with a
    // password generated for this run (the same way phasex-ui-qa does).
    const testPassword = `Qa-${crypto.randomBytes(12).toString("hex")}-Zz9!`;
    const unlocked = await page.evaluate(async (password) => {
      const security = window.anxos.security;
      const setup = await security.setupAdmin({ username: "qa-owner", password, passwordConfirm: password }).catch((error) => ({ error: error?.message }));
      const login = await security.login({ username: "qa-owner", password }).catch((error) => ({ error: error?.message }));
      return { setupError: setup?.error || null, loginError: login?.error || null };
    }, testPassword);
    check("S9", !unlocked.setupError && !unlocked.loginError, `QA owner signed in (${unlocked.setupError || unlocked.loginError || "ok"})`);
    await page.reload();
    await page.waitForFunction(() => typeof window.showPage === "function", null, { timeout: 60000 });
    const useDevice = page.getByRole("button", { name: "Use this device" }).first();
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    await page.waitForFunction(() => (document.querySelector(".nav-menu")?.getBoundingClientRect().width || 0) > 0, null, { timeout: 30000 });
    await page.waitForTimeout(600);
    const ownerEntry = await page.evaluate(() => {
      const toggle = document.querySelector("[data-owner-workspace-toggle]");
      const visible = Boolean(toggle && !toggle.closest("[hidden]") && toggle.getBoundingClientRect().height > 0);
      window.showPage("owner-workspace");
      return { visible, inFooter: Boolean(toggle?.closest('.nav-group[data-nav-group="footer"]')), active: window.getActivePageName?.() };
    });
    await shot(page, "a1-1280-owner-workspace");
    check("S3", ownerEntry.visible && ownerEntry.inFooter && ownerEntry.active === "owner-workspace", `signed in as Owner: Anx Workspace shows in the footer and opens (${ownerEntry.active})`);

    // Turn AI help on the way a user does (Settings › AI Assistant).
    await page.evaluate(() => { window.showPage("settings"); setActiveSettingsCategory("ai"); });
    await page.waitForTimeout(400);
    const toggleError = await page.locator('[data-setting="ai.enabled"]').check({ timeout: 10000 }).then(() => "", (error) => String(error.message).split(/\r?\n/)[0]);
    // The setting is saved through the main process first (as phasex-ui-qa waits).
    await page.waitForFunction(() => { const button = document.querySelector("[data-assistant-open]"); return button && !button.hidden; }, null, { timeout: 10000 }).catch(() => {});
    const assistant = await page.evaluate(() => {
      const button = document.querySelector("[data-assistant-open]");
      const box = document.querySelector('[data-setting="ai.enabled"]');
      return {
        buttonShown: Boolean(button && !button.hidden && button.getBoundingClientRect().width > 0),
        box: box ? { checked: box.checked, disabled: box.disabled, visible: box.getBoundingClientRect().height > 0 } : null,
        active: window.getActivePageName?.(),
      };
    });
    assistant.toggleError = toggleError;
    if (assistant.buttonShown) {
      await page.locator(selector("shell-assistant-open")).click();
      await page.waitForTimeout(300);
    }
    const assistantOpen = await page.evaluate(() => {
      const panel = document.querySelector("[data-assistant-panel]");
      return Boolean(panel && !panel.hidden && panel.getBoundingClientRect().height > 0);
    });
    await shot(page, "a1-1280-assistant");
    check("S9", assistant.buttonShown && assistantOpen, `with AI help enabled, the title bar Assistant button opens the Assistant panel (button=${assistant.buttonShown}, open=${assistantOpen}, page=${assistant.active}, toggle=${JSON.stringify(assistant.box)} ${assistant.toggleError})`);
    await page.locator("[data-assistant-close]").click().catch(() => {});

    // Theme mechanism: the Theme setting resolves to <html data-theme>. Ported in
    // A10, when the approved light theme shipped (A1 required dark only):
    // Dark and Light are fixed, System follows the operating system, live.
    const setTheme = (value) => page.evaluate(async (theme) => {
      await saveSettingsPatch({ "appearance.theme": theme });
      return document.documentElement.dataset.theme;
    }, value);
    const themes = { start: await page.evaluate(() => document.documentElement.dataset.theme) };
    themes.options = await page.evaluate(() => [...document.querySelectorAll('[data-setting="appearance.theme"] option')].map((option) => option.value).join("/"));
    themes.light = await setTheme("light");
    await page.emulateMedia({ colorScheme: "light" });
    themes.systemLight = await setTheme("system");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(200);
    themes.systemDarkLive = await page.evaluate(() => document.documentElement.dataset.theme);
    themes.dark = await setTheme("dark");
    await page.emulateMedia({ colorScheme: null });
    check("S9", themes.start === "dark" && themes.options === "dark/light/system" && themes.light === "light" && themes.systemLight === "light" && themes.systemDarkLive === "dark" && themes.dark === "dark",
      `Theme setting resolves Dark/Light/System to data-theme, System follows the OS live (${JSON.stringify(themes)})`);

    // ------------------------------------------------------------ S11 A1 inventory hooks
    // Every A1 UI row's data-* hook is in the running app (CAPABILITY_INVENTORY.md, wave A1).
    const inventory = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "docs", "anxhost", "capability-inventory.json"), "utf8")).rows;
    const a1Hooks = inventory.filter((row) => row.wave === "A1" && /^data-[a-z-]+(=[^*]+)?$/.test(row.hook || ""));
    const missingHooks = await page.evaluate((hooks) => hooks.filter(({ hook }) => {
      const [name, value] = hook.split("=");
      return !document.querySelector(value === undefined ? `[${name}]` : `[${name}="${value}"]`);
    }).map(({ id }) => id), a1Hooks.map(({ id, hook }) => ({ id, hook })));
    check("S11", missingHooks.length === 0, `${a1Hooks.length - missingHooks.length}/${a1Hooks.length} A1 data-* hooks present in the running shell${missingHooks.length ? ` (missing ${missingHooks.join(", ")})` : ""}`);
    const dialogs = await page.evaluate(() => ["[data-global-search] [role=dialog]", "[data-command-palette] [role=dialog]", "[data-update-modal] [role=dialog]", "[data-dev-update-modal] [role=dialog]", "[data-onboarding-welcome] [role=dialog]", "[data-onboarding-wizard] [role=dialog]", "[data-contextual-help-modal] [role=dialog]"]
      .filter((sel) => { const el = document.querySelector(sel); return !el || !el.getAttribute("aria-labelledby") || !document.getElementById(el.getAttribute("aria-labelledby")); }));
    check("S11", dialogs.length === 0, `the 7 shell dialogs (inventory hook "#x") are labelled dialogs${dialogs.length ? ` (problem: ${dialogs.join(", ")})` : ""}`);

    // ------------------------------------------------------------ S12 IPC rows without a direct call
    await page.evaluate(() => window.showPage("files"));
    await page.locator(selector("shell-window-maximize")).click();
    await page.waitForFunction(() => document.body.classList.contains("window-is-maximized"), null, { timeout: 5000 }).catch(() => {});
    const maximized = await page.evaluate(async () => ({ cls: document.body.classList.contains("window-is-maximized"), api: await window.anxWindow?.isMaximized?.() }));
    await page.locator(selector("shell-window-maximize")).click();
    await page.waitForFunction(() => !document.body.classList.contains("window-is-maximized"), null, { timeout: 5000 }).catch(() => {});
    const restored = await page.evaluate(async () => ({ cls: document.body.classList.contains("window-is-maximized"), api: await window.anxWindow?.isMaximized?.() }));
    check("S12", maximized.cls && maximized.api === true && !restored.cls && restored.api === false, `maximize/restore round-trips through anxWindow.isMaximized and onMaximizedChanged (max ${JSON.stringify(maximized)}, restored ${JSON.stringify(restored)})`);
    await real.setViewport(1280, 800);
    // Build 216-A4: the sidebar's Add Server stays in the main window (no
    // window may open); the window bridge it used is kept until its approved
    // retirement, so it is still checked here by calling it directly.
    const windowsBeforeAddServer = await real.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await page.locator('[data-testid="nav-item"][data-page-target="marketplace"]').click();
    await page.waitForTimeout(800);
    const addServerInPlace = await page.evaluate(() => ({ page: window.getActivePageName?.(), mode: document.body.dataset.addServerMode }));
    const windowsAfterAddServer = await real.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    check("S12", addServerInPlace.page === "marketplace" && addServerInPlace.mode === "browse" && windowsAfterAddServer === windowsBeforeAddServer, `sidebar Add Server opens in the main window (${JSON.stringify(addServerInPlace)}; windows ${windowsBeforeAddServer} → ${windowsAfterAddServer})`);
    const workspaceOpened = real.app.waitForEvent("window", { timeout: 20000 });
    await page.evaluate(() => window.anxWindow.openWorkspace("marketplace", {}));
    const workspace = await workspaceOpened.catch(() => null);
    let workspaceState = null;
    if (workspace) {
      await workspace.waitForFunction(() => typeof window.showPage === "function", null, { timeout: 30000 }).catch(() => {});
      await workspace.waitForTimeout(1200);
      workspaceState = await workspace.evaluate(() => ({
        surface: document.body.classList.contains("marketplace-window"),
        page: window.getActivePageName?.(),
        title: document.querySelector("[data-titlebar-page]")?.textContent.trim(),
        hasContextApi: typeof window.anxWindow?.getWorkspaceContext === "function" && typeof window.anxWindow?.onWorkspaceInit === "function",
      })).catch((error) => ({ error: error.message }));
      const homeButton = workspace.locator('[data-workspace-nav="dashboard"]').first();
      const canGoHome = await homeButton.isVisible().catch(() => false);
      if (canGoHome) {
        await homeButton.click();
        await page.waitForFunction(() => window.getActivePageName?.() === "dashboard", null, { timeout: 8000 }).catch(() => {});
      } else {
        await workspace.evaluate(() => window.anxWindow?.focusMain?.("dashboard")).catch(() => {});
        await page.waitForFunction(() => window.getActivePageName?.() === "dashboard", null, { timeout: 8000 }).catch(() => {});
      }
      workspaceState.mainAfterHome = await page.evaluate(() => window.getActivePageName?.());
      await workspace.close().catch(() => {});
    }
    check("S12", Boolean(workspaceState?.surface && workspaceState.page === "marketplace" && workspaceState.hasContextApi), `the kept window bridge still opens a workspace window through window.openWorkspace, initialised by getWorkspaceContext/onWorkspaceInit (${JSON.stringify(workspaceState)})`);
    check("S12", workspaceState?.mainAfterHome === "dashboard", `the workspace window's Home returns the main window to Home (focusMain, onNavigate): main shows ${workspaceState?.mainAfterHome}`);
    const account = await page.evaluate(async () => {
      const api = window.anxos?.account;
      const status = await api?.getStatus?.().then((value) => (value && typeof value === "object" ? "object" : typeof value), (error) => `error ${error?.code || error?.message}`);
      return { status, listDevices: typeof api?.listDevices, revokeCurrentDevice: typeof api?.revokeCurrentDevice };
    });
    check("S12", account.status === "object" && account.listDevices === "function" && account.revokeCurrentDevice === "function", `account.getStatus resolves (${account.status}); account.listDevices and revokeCurrentDevice stay available to the backend with no shell UI`);

    // ------------------------------------------------------------ S10 errors
    check("S10", rendererErrors.length === 0, `renderer errors: ${rendererErrors.length ? rendererErrors.join(" | ") : "none"}`);
  } finally {
    await real.close();
  }

  // Gate screenshots: a fresh profile stops at the local setup gate.
  if (SHOTS) {
    const gate = await launchRealApp({ prefix: "anx-216-a1-gate-", stopAtGate: true });
    try {
      await gate.setViewport(1280, 800);
      await gate.page.waitForTimeout(800);
      await shot(gate.page, "a1-1280-local-setup-gate");
      await gate.page.evaluate(() => {
        document.querySelector("[data-local-setup-gate]").hidden = true;
        document.querySelector("[data-security-gate]").hidden = false;
      });
      await gate.page.waitForTimeout(200);
      await shot(gate.page, "a1-1280-security-gate");
    } finally {
      await gate.close();
    }
  }

  const failed = results.filter((entry) => !entry.ok);
  console.log(`ANXHOST SHELL UI QA: ${failed.length ? "FAIL" : "PASS"} (${results.length - failed.length}/${results.length})`);
  if (failed.length) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
