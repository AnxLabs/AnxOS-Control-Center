#!/usr/bin/env node
"use strict";

// Desktop UI regression for the grouped sidebar.
//
// Launches the REAL Electron app (isolated profile and config, --qa-mode) and
// proves that grouping the sidebar kept every page reachable:
//   N1 every primary page has exactly one visible entry: the 16 grouped pages
//      in their groups, Settings pinned below them; legacy pages stay hidden;
//   N2 each group header toggles its items and reports aria-expanded;
//   N3 collapsed groups persist across a restart (same profile);
//   N4 opening a page whose group is collapsed opens that group, so the
//      current page is never hidden;
//   N5 the icon-only sidebar shows every item with no group headers;
//   N6 every entry still navigates to its page (Marketplace opens its own
//      workspace window, as before).
//
// Never touches the installed app or its data.
// Run: node scripts/sidebar-navigation-groups-ui-qa.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");

const root = path.resolve(__dirname, "..");
const EXPECTED_GROUPS = {
  overview: ["dashboard", "notifications", "console", "operations"],
  servers: ["instances", "marketplace", "docker", "files", "backups"],
  infrastructure: ["nodes", "network", "playit", "ssh", "agent-control"],
  administration: ["security", "maintenance"],
};

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
    const ready = await page.evaluate(() => (document.querySelector(".nav-menu")?.getBoundingClientRect().width || 0) > 0);
    if (ready) break;
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(400);
  return { app, page, rendererErrors };
}

function navState(page) {
  return page.evaluate(() => {
    const visible = (element) => {
      if (!element || element.closest("[hidden]")) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    const groups = {};
    document.querySelectorAll(".nav-group").forEach((group) => {
      groups[group.dataset.navGroup] = {
        collapsed: group.classList.contains("is-collapsed"),
        expanded: group.querySelector(".nav-group__toggle")?.getAttribute("aria-expanded"),
        headerVisible: visible(group.querySelector(".nav-group__toggle")),
        pages: [...group.querySelectorAll("[data-page-target]")].filter((item) => !item.hidden).map((item) => item.dataset.pageTarget),
        visiblePages: [...group.querySelectorAll("[data-page-target]")].filter(visible).map((item) => item.dataset.pageTarget),
      };
    });
    const allTargets = [...document.querySelectorAll(".nav-menu [data-page-target]")];
    return {
      groups,
      pinned: [...document.querySelectorAll(".nav-menu > .nav-item--pinned")].filter((item) => !item.hidden).map((item) => item.dataset.pageTarget),
      shownTargets: allTargets.filter((item) => !item.hidden).map((item) => item.dataset.pageTarget),
      legacyShown: allTargets.filter((item) => !item.hidden && ["minecraft", "amp", "coolpals"].includes(item.dataset.pageTarget)).length,
      active: document.querySelector(".nav-menu .nav-item.is-active")?.dataset.pageTarget || null,
      sidebarState: document.querySelector("[data-sidebar]")?.dataset.sidebarState,
    };
  });
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

    // N1: every primary page, exactly once, in its group; Settings pinned.
    for (const [groupId, pages] of Object.entries(EXPECTED_GROUPS)) {
      assert.ok(state.groups[groupId], `group ${groupId} exists`);
      assert.deepStrictEqual(state.groups[groupId].pages, pages, `group ${groupId} holds its pages in order`);
    }
    assert.deepStrictEqual(state.pinned, ["settings"], "Settings is pinned below the groups");
    const expectedAll = [...Object.values(EXPECTED_GROUPS).flat(), "settings"];
    assert.deepStrictEqual([...state.shownTargets].sort(), [...expectedAll].sort(), "exactly the primary pages are shown");
    assert.strictEqual(new Set(state.shownTargets).size, state.shownTargets.length, "no page is listed twice");
    assert.strictEqual(state.legacyShown, 0, "legacy pages stay hidden");
    console.log("PASS N1 every primary page has exactly one entry in its group; Settings pinned");

    // N2: toggling a group hides/shows its items and updates aria-expanded.
    await page.evaluate(() => window.showPage("dashboard"));
    const toggle = page.locator('[data-nav-group="servers"] .nav-group__toggle');
    if ((await navState(page)).groups.servers.collapsed) await toggle.click();
    state = await navState(page);
    assert.strictEqual(state.groups.servers.expanded, "true");
    assert.deepStrictEqual(state.groups.servers.visiblePages, EXPECTED_GROUPS.servers, "an open group shows its items");
    await toggle.click();
    state = await navState(page);
    assert.strictEqual(state.groups.servers.collapsed, true);
    assert.strictEqual(state.groups.servers.expanded, "false");
    assert.deepStrictEqual(state.groups.servers.visiblePages, [], "a collapsed group hides its items");
    console.log("PASS N2 group headers toggle their items and aria-expanded");

    // N3: the collapsed state survives a restart.
    await ui.app.close();
    ui = await launch(qa, userData);
    page = ui.page;
    await page.evaluate(() => window.showPage("dashboard"));
    if (process.env.NAV_QA_SHOT) await page.screenshot({ path: process.env.NAV_QA_SHOT });
    state = await navState(page);
    assert.strictEqual(state.groups.servers.collapsed, true, "the collapsed group is still collapsed after a restart");
    console.log("PASS N3 collapsed groups persist across restarts");

    // N4: opening a page in a collapsed group opens the group.
    await page.evaluate(() => window.showPage("docker"));
    state = await navState(page);
    assert.strictEqual(state.groups.servers.collapsed, false, "the active page's group opens");
    assert.ok(state.groups.servers.visiblePages.includes("docker"), `the active page is visible (${JSON.stringify(state)} ${JSON.stringify(await page.evaluate(() => { const i = document.querySelector(".nav-menu [data-page-target=docker]"); const r = i.getBoundingClientRect(); return { r: [r.width, r.height, r.top], vis: getComputedStyle(i).visibility, disp: getComputedStyle(i).display, itemsDisp: getComputedStyle(i.parentElement).display }; }))})`);
    assert.strictEqual(state.active, "docker");
    console.log("PASS N4 the active page's group always opens");

    // N5: icon-only sidebar shows every item and no headers.
    // Make sure at least one group is collapsed, through its header like a user.
    if (!(await navState(page)).groups.administration.collapsed) await page.locator('[data-nav-group="administration"] .nav-group__toggle').click();
    assert.strictEqual((await navState(page)).groups.administration.collapsed, true);
    await page.locator("[data-sidebar-toggle]").click();
    await page.waitForTimeout(500);
    state = await navState(page);
    assert.strictEqual(state.sidebarState, "collapsed");
    for (const [groupId, pages] of Object.entries(EXPECTED_GROUPS)) {
      assert.strictEqual(state.groups[groupId].headerVisible, false, `${groupId} header hidden in the icon sidebar`);
      assert.deepStrictEqual(state.groups[groupId].visiblePages, pages, `${groupId} items all visible in the icon sidebar`);
    }
    await page.locator("[data-sidebar-toggle]").click();
    await page.waitForTimeout(500);
    console.log("PASS N5 the icon-only sidebar shows every item without group headers");

    // N6: every entry still navigates (open all groups first).
    await page.evaluate(() => document.querySelectorAll(".nav-group.is-collapsed .nav-group__toggle").forEach((button) => button.click()));
    for (const pageName of expectedAll) {
      if (pageName === "marketplace") {
        // Marketplace opens in its own workspace window (existing behaviour).
        const opened = ui.app.waitForEvent("window", { timeout: 15000 });
        await page.locator(`.nav-menu [data-page-target="${pageName}"]`).click();
        const workspace = await opened;
        assert.ok(workspace, "clicking marketplace opens the Marketplace workspace window");
        await workspace.close().catch(() => {});
        continue;
      }
      await page.locator(`.nav-menu [data-page-target="${pageName}"]`).click();
      await page.waitForTimeout(150);
      state = await navState(page);
      assert.strictEqual(state.active, pageName, `clicking ${pageName} opens it (active: ${state.active})`);
    }
    console.log("PASS N6 every entry navigates to its page (Marketplace in its own window)");

    assert.deepStrictEqual(ui.rendererErrors, [], "no renderer errors");
    console.log("Sidebar navigation groups UI QA passed (6 checks).");
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
