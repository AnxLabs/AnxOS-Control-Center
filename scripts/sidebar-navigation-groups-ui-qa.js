#!/usr/bin/env node
"use strict";

// Desktop UI regression for the sidebar's information architecture.
//
// Build 216-A1 (approved navigation, docs/anxhost/NAVIGATION_PROPOSAL.md):
// Run / Infrastructure / Tools, then the footer (Activity, Security,
// Settings, Anx Workspace for the owner) and the computer switcher. Nothing
// is hidden behind a collapsed group. Ported from the Build 215 version of
// this suite (More and a collapsible Tools group); each check keeps its
// purpose for the new layout:
//   N1 the sidebar lists exactly the 12 destinations, in their groups and in
//      order, each once; tab pages and legacy pages have no visible entry;
//   N2 group headings are labels (not toggles) and each group of entries is
//      labelled by its heading (was: group headers toggle their items);
//   N3 the hand-collapsed icon rail persists across a restart (was: collapsed
//      groups persist);
//   N4 tab pages (Agent Control, Network, Server consoles, Task details,
//      Maintenance) highlight their destination and the tabs switch pages;
//   N5 Advanced Mode does not change the sidebar: every destination is always
//      listed (was: opening a Tools page opens the Tools group);
//   N6 the icon rail shows every entry with the group labels hidden;
//   N7 every entry still navigates to its page (Add Server opens its own
//      workspace window, as before, until wave A4).
//
// Selects by data-testid (test-helpers/testid-convention.js) with the
// data-page-target identity attribute. Never touches the installed app or
// its data. Run: node scripts/sidebar-navigation-groups-ui-qa.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");
const { selector } = require("../test-helpers/testid-convention");

const root = path.resolve(__dirname, "..");
const EXPECTED_GROUPS = {
  run: ["dashboard", "instances", "marketplace"],
  infrastructure: ["nodes", "docker", "playit"],
  tools: ["files", "ssh", "backups"],
  footer: ["notifications", "security", "settings"],
};
const HEADINGS = { run: "Run", infrastructure: "Infrastructure", tools: "Tools" };
// Tab pages (child -> destination).
const JOINED_PAGES = { "agent-control": "nodes", network: "playit", console: "ssh", operations: "notifications", maintenance: "notifications" };
const expectedAll = Object.values(EXPECTED_GROUPS).flat();
const NAV_ITEM = (pageName) => `${selector("nav-item")}[data-page-target="${pageName}"]`;

function activeTab(page, pageName) {
  return page.evaluate((name) => document.querySelector(`.page[data-page="${name}"] .page-tabs__tab.is-active`)?.dataset.pageTab || null, pageName);
}

async function launch(qa, userData) {
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", root, "--qa-mode"], env });
  const page = await app.firstWindow();
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(error.message));
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window?.setSize(1440, 900); });
  await page.waitForLoadState("domcontentloaded");
  for (let i = 0; i < 200 && !(await page.evaluate(() => typeof window.showPage === "function")); i += 1) await page.waitForTimeout(150);
  const useDevice = page.getByRole("button", { name: "Use this device" }).first();
  if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
  // Wait until startup finished and the app shell (sidebar) is laid out.
  for (let i = 0; i < 200; i += 1) {
    const ready = await page.evaluate((sel) => (document.querySelector(sel)?.getBoundingClientRect().width || 0) > 0, selector("shell-sidebar"));
    if (ready) break;
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);
  return { app, page, rendererErrors };
}

function navState(page) {
  return page.evaluate(({ sidebarSel }) => {
    const visible = (element) => {
      if (!element || element.closest("[hidden]")) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1 && getComputedStyle(element).visibility !== "hidden";
    };
    const sidebar = document.querySelector(sidebarSel);
    const groups = {};
    sidebar.querySelectorAll('[data-testid="nav-group"]').forEach((group) => {
      const heading = group.querySelector(".nav-group__heading");
      const items = group.querySelector('[role="group"]');
      groups[group.dataset.navGroup] = {
        heading: heading?.textContent.trim() || "",
        headingIsButton: Boolean(heading?.closest("button") || heading?.querySelector("button")),
        headingVisible: visible(group.querySelector(".nav-group__label")),
        labelledBy: items?.getAttribute("aria-labelledby") === heading?.id,
        pages: [...group.querySelectorAll('[data-testid="nav-item"]')].filter((item) => !item.hidden).map((item) => item.dataset.pageTarget),
        visiblePages: [...group.querySelectorAll('[data-testid="nav-item"]')].filter(visible).map((item) => item.dataset.pageTarget),
      };
    });
    const shown = [...sidebar.querySelectorAll("[data-page-target]")].filter(visible);
    return {
      groups,
      shownTargets: shown.map((item) => item.dataset.pageTarget),
      legacyShown: shown.filter((item) => ["minecraft", "amp", "coolpals"].includes(item.dataset.pageTarget)).length,
      active: sidebar.querySelector('[data-testid="nav-item"][aria-current="page"]')?.dataset.pageTarget || null,
      sidebarState: sidebar.dataset.sidebarState,
      labelsShown: [...sidebar.querySelectorAll('[data-testid="nav-item"] [data-nav-label]')].filter(visible).length,
    };
  }, { sidebarSel: selector("shell-sidebar") });
}

async function main() {
  // A configured node (backed by a real Agent) skips the first-run chooser.
  const agent = await startServiceManagedAgent({ initial: "running" });
  const qa = createIsolatedQaEnv("anx-nav-ui-qa-config-");
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}
`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "ovh", nodes: [{ id: "ovh", kind: "agent", name: "OVH", displayName: "OVH", baseUrl: agent.url, agentUrl: agent.url, enabled: true }] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { ovh: { agentToken: agent.token } } });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-nav-ui-qa-profile-"));
  let ui = await launch(qa, userData);
  try {
    let { page } = ui;
    let state = await navState(page);

    // N1: exactly the 12 destinations, grouped and ordered, each once.
    for (const [groupId, pages] of Object.entries(EXPECTED_GROUPS)) {
      assert.deepStrictEqual(state.groups[groupId]?.pages, pages, `${groupId} holds its destinations in order`);
      assert.deepStrictEqual(state.groups[groupId].visiblePages, pages, `${groupId} shows every destination`);
    }
    assert.deepStrictEqual(Object.keys(state.groups), Object.keys(EXPECTED_GROUPS), "groups in order: Run, Infrastructure, Tools, footer");
    assert.deepStrictEqual([...state.shownTargets].sort(), [...expectedAll].sort(), "exactly the 12 destinations have visible entries");
    assert.strictEqual(new Set(state.shownTargets).size, state.shownTargets.length, "no page is listed twice");
    assert.strictEqual(state.legacyShown, 0, "legacy pages stay hidden");
    console.log("PASS N1 sidebar: Run, Infrastructure, Tools and the footer list the 12 destinations once each");

    // N2: headings label their groups; nothing to open or close.
    for (const [groupId, heading] of Object.entries(HEADINGS)) {
      assert.strictEqual(state.groups[groupId].heading, heading, `${groupId} heading reads ${heading}`);
      assert.strictEqual(state.groups[groupId].headingIsButton, false, `${groupId} heading is a label, not a toggle`);
      assert.strictEqual(state.groups[groupId].headingVisible, true, `${groupId} heading is shown in the full sidebar`);
    }
    for (const groupId of Object.keys(EXPECTED_GROUPS)) {
      assert.strictEqual(state.groups[groupId].labelledBy, true, `${groupId} entries are labelled by the group heading`);
    }
    console.log("PASS N2 group headings are labels for their groups, not toggles");

    // N3: the hand-collapsed icon rail survives a restart.
    await page.locator(selector("shell-sidebar-toggle")).click();
    await page.waitForTimeout(300);
    assert.strictEqual((await navState(page)).sidebarState, "collapsed", "the toggle collapses the sidebar to the rail");
    await ui.app.close();
    ui = await launch(qa, userData);
    page = ui.page;
    await page.evaluate(() => window.showPage("dashboard"));
    if (process.env.NAV_QA_SHOT) await page.screenshot({ path: process.env.NAV_QA_SHOT });
    state = await navState(page);
    assert.strictEqual(state.sidebarState, "collapsed", "the rail is still collapsed after a restart");
    await page.locator(selector("shell-sidebar-toggle")).click();
    await page.waitForTimeout(300);
    assert.strictEqual((await navState(page)).sidebarState, "expanded", "the toggle expands it again");
    console.log("PASS N3 the hand-collapsed rail persists across restarts");

    // N4: tab pages highlight their destination; the tabs switch pages.
    for (const [child, parent] of Object.entries(JOINED_PAGES)) {
      await page.evaluate((name) => window.showPage(name), child);
      state = await navState(page);
      assert.strictEqual(state.active, parent, `${child} highlights ${parent}`);
      assert.strictEqual(await activeTab(page, child), child, `${child}'s own tab is active`);
      await page.locator(`.page[data-page="${child}"] [data-page-tab="${parent}"]`).click();
      await page.waitForTimeout(150);
      assert.strictEqual((await navState(page)).active, parent, `the ${parent} tab opens ${parent}`);
      await page.locator(`.page[data-page="${parent}"] [data-page-tab="${child}"]`).click();
      await page.waitForTimeout(150);
      assert.strictEqual(await page.evaluate(() => document.querySelector(".page.is-active")?.dataset.page), child, `the ${child} tab opens ${child}`);
    }
    console.log("PASS N4 tab pages highlight their destination and the tabs switch pages");

    // N5: Advanced Mode leaves the sidebar as it is.
    const before = (await navState(page)).shownTargets;
    await page.evaluate(() => window.saveSettingsPatch({ "interface.advancedMode": true }));
    await page.waitForTimeout(300);
    assert.deepStrictEqual((await navState(page)).shownTargets, before, "Advanced Mode on: same destinations");
    await page.evaluate(() => window.saveSettingsPatch({ "interface.advancedMode": false }));
    await page.waitForTimeout(300);
    assert.deepStrictEqual((await navState(page)).shownTargets, before, "Advanced Mode off: same destinations");
    console.log("PASS N5 Advanced Mode does not hide or add sidebar destinations");

    // N6: the icon rail shows every entry, without labels or group headings.
    await page.locator(selector("shell-sidebar-toggle")).click();
    await page.waitForTimeout(400);
    state = await navState(page);
    assert.strictEqual(state.sidebarState, "collapsed");
    assert.strictEqual(state.labelsShown, 0, "no entry labels in the rail");
    for (const [groupId, pages] of Object.entries(EXPECTED_GROUPS)) {
      assert.strictEqual(state.groups[groupId].headingVisible, false, `${groupId} heading hidden in the rail`);
      assert.deepStrictEqual(state.groups[groupId].visiblePages, pages, `${groupId} entries all visible in the rail`);
    }
    await page.locator(selector("shell-sidebar-toggle")).click();
    await page.waitForTimeout(400);
    console.log("PASS N6 the icon rail shows every entry without labels or group headings");

    // N7: every entry still navigates.
    // Build 216-A4: Add Server opens in the main window like every other entry
    // (it used to open a workspace window); no window may open.
    const windowsBefore = await ui.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    for (const pageName of expectedAll) {
      await page.locator(NAV_ITEM(pageName)).click();
      await page.waitForTimeout(150);
      state = await navState(page);
      assert.strictEqual(state.active, pageName, `clicking ${pageName} opens it (active: ${state.active})`);
    }
    const windowsAfter = await ui.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    assert.strictEqual(windowsAfter, windowsBefore, "no sidebar entry opens a window");
    console.log("PASS N7 every entry navigates to its page in the main window, Add Server included");

    assert.deepStrictEqual(ui.rendererErrors, [], "no renderer errors");
    console.log("Sidebar navigation groups UI QA passed (7 checks).");
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    await ui.app.close().catch(() => {});
    await agent.stop().catch(() => {});
    for (const cleanup of [() => qa.cleanup(), () => fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })]) {
      try { cleanup(); } catch {}
    }
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
