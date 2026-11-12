#!/usr/bin/env node
"use strict";

// Desktop UI check for the simplified Control Center (Phase 1).
//
// Launches the REAL Electron app (isolated profile and config, --qa-mode,
// backed by a test Agent) and checks the screens a non-technical user sees:
//   S1 Home shows the everyday actions and keeps the technical snapshot and
//      extra actions in one collapsed "More actions and computer details";
//   S2 Create Server is one setup step: name, EULA for Minecraft, and
//      collapsed Advanced options; Create server validates everything and
//      opens Advanced options when a field inside it is wrong;
//   S3 Computers and Sharing show tabs to their joined pages.
// Set SIMPLE_UI_SHOTS=<dir> to save screenshots of each screen.
//
// Never touches the installed app or its data.
// Run: node scripts/simple-ui-screenshots-qa.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");

const root = path.resolve(__dirname, "..");
const shotsDir = process.env.SIMPLE_UI_SHOTS || "";

async function shot(page, name) {
  if (!shotsDir) return;
  fs.mkdirSync(shotsDir, { recursive: true });
  await page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
}

async function waitFor(page, predicate, arg, label) {
  for (let i = 0; i < 200; i += 1) {
    if (await page.evaluate(predicate, arg).catch(() => false)) return;
    await page.waitForTimeout(150);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const agent = await startServiceManagedAgent({ initial: "running" });
  const qa = createIsolatedQaEnv("anx-simple-ui-qa-config-");
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "ovh", nodes: [{ id: "ovh", kind: "agent", name: "OVH", displayName: "OVH", baseUrl: agent.url, agentUrl: agent.url, enabled: true }] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { ovh: { agentToken: agent.token } } });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-simple-ui-qa-profile-"));
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", root, "--qa-mode"], env });
  const rendererErrors = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1440, 900); });
    await waitFor(page, () => typeof window.showPage === "function", null, "renderer");
    const useDevice = page.getByRole("button", { name: "Use this device" }).first();
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    await waitFor(page, () => (document.querySelector(".nav-menu")?.getBoundingClientRect().width || 0) > 0, null, "sidebar");
    await page.waitForTimeout(1500);

    // S1: Home.
    await page.evaluate(() => window.showPage("dashboard"));
    await shot(page, "01-home");
    const home = await page.evaluate(() => {
      // checkVisibility also treats content inside a closed <details> as hidden.
      const visible = (el) => Boolean(el) && el.checkVisibility() && el.getBoundingClientRect().height > 0;
      const quick = [...document.querySelectorAll('.dashboard-welcome [data-dashboard-action]')].filter(visible).map((b) => b.dataset.dashboardAction);
      const details = document.querySelector("[data-dashboard-details]");
      return {
        quick,
        detailsOpen: details?.open,
        cpuVisible: visible(document.querySelector('[data-dashboard-details] [data-field="cpuUsage"]')),
        tileRow: Boolean(document.querySelector("[data-dashboard-widgets]")),
        serversHeading: document.querySelector("[data-dashboard-app-grid] h2")?.textContent || "",
      };
    });
    assert.deepStrictEqual(home.quick, ["create-server", "instances", "share-server", "nodes"], "Home shows four everyday actions");
    assert.strictEqual(home.detailsOpen, false, "computer details start collapsed");
    assert.strictEqual(home.cpuVisible, false, "CPU details are tucked away");
    assert.strictEqual(home.tileRow, false, "the duplicate summary tile row is gone");
    assert.strictEqual(home.serversHeading, "Your Servers");
    await page.locator("[data-dashboard-details] > summary").click();
    await page.waitForTimeout(200);
    assert.strictEqual(await page.evaluate(() => document.querySelector('[data-dashboard-details] [data-field="cpuUsage"]').checkVisibility()), true, "opening the details shows CPU");
    await page.locator("[data-dashboard-details] > summary").click();
    console.log("PASS S1 Home: four everyday actions, technical details collapsed, no duplicate tiles");

    // S3: joined pages show their tabs.
    for (const [pageName, tabs] of [["nodes", ["nodes", "agent-control"]], ["playit", ["playit", "network"]]]) {
      await page.evaluate((name) => window.showPage(name), pageName);
      await page.waitForTimeout(300);
      const shown = await page.evaluate((name) => [...document.querySelectorAll(`.page[data-page="${name}"] .page-tabs__tab`)].map((t) => t.dataset.pageTab), pageName);
      assert.deepStrictEqual(shown, tabs, `${pageName} shows its tabs`);
      await shot(page, `03-${pageName}`);
    }
    console.log("PASS S3 Computers and Sharing show tabs to their joined pages");

    // S2: Create Server.
    await page.evaluate(() => window.showPage("dashboard"));
    const opened = app.waitForEvent("window", { timeout: 20000 });
    await page.locator('.dashboard-welcome [data-dashboard-action="create-server"]').click();
    const wizardWindow = await opened;
    wizardWindow.on("pageerror", (error) => rendererErrors.push(`create-server: ${error.message}`));
    await wizardWindow.waitForLoadState("domcontentloaded");
    await waitFor(wizardWindow, () => typeof window.openMarketplaceWizard === "function" && typeof marketplaceCatalog !== "undefined" && (marketplaceCatalog?.templates?.length || 0) > 0, null, "marketplace catalog");
    // Step 1 is the game picker. Pick the first game like a user would; fall
    // back to opening a Minecraft template directly if the picker is absent.
    await wizardWindow.waitForTimeout(600);
    await shot(wizardWindow, "02a-pick-a-game");
    const card = wizardWindow.locator("[data-first-server-template]:not([disabled])").first();
    if (await card.isVisible().catch(() => false)) {
      await card.click();
    } else {
      const templateId = await wizardWindow.evaluate(() => {
        const templates = marketplaceCatalog.templates.filter((t) => !t.comingSoon && !t.disabled);
        return (templates.find((t) => /minecraft/i.test(`${t.id} ${t.game || ""}`) && !t.provider) || templates[0]).id;
      });
      await wizardWindow.evaluate((id) => window.openMarketplaceWizard(id, { source: "template" }), templateId);
    }
    await waitFor(wizardWindow, () => !document.querySelector("[data-marketplace-wizard]")?.hidden, null, "setup step");
    await wizardWindow.waitForTimeout(400);
    const wizard = await wizardWindow.evaluate(() => {
      // checkVisibility also treats content inside a closed <details> as hidden.
      const visible = (el) => Boolean(el) && el.checkVisibility() && el.getBoundingClientRect().height > 0;
      return {
        steps: [...document.querySelectorAll("[data-create-server-step-nav] button")].map((b) => b.textContent),
        setupVisible: visible(document.querySelector('[data-create-server-step-panel="configuration"]')),
        nameVisible: visible(document.querySelector('[data-marketplace-field="name"]')),
        memoryVisible: visible(document.querySelector('[data-marketplace-field="memory"]')),
        advancedOpen: document.querySelector("[data-create-server-advanced]").open,
        createLabel: document.querySelector("[data-marketplace-install]").textContent,
        createVisible: visible(document.querySelector("[data-marketplace-install]")),
        nextVisible: visible(document.querySelector("[data-create-server-next]")),
      };
    });
    assert.deepStrictEqual(wizard.steps, ["1. Set up", "2. Create"], "two steps");
    assert.ok(wizard.setupVisible && wizard.nameVisible, "the setup step and name are shown");
    assert.strictEqual(wizard.memoryVisible, false, "memory is under Advanced options");
    assert.strictEqual(wizard.createLabel, "Create server");
    assert.ok(wizard.createVisible && !wizard.nextVisible, "Create server is the only forward button");
    await shot(wizardWindow, "02b-set-up");

    // A bad port inside Advanced options must open it and block the install.
    await wizardWindow.locator('[data-marketplace-field="name"]').fill("Friends Server");
    await wizardWindow.evaluate(() => {
      const eula = document.querySelector('[data-marketplace-field="acceptEula"]');
      if (eula && !eula.closest("[hidden]")) eula.checked = true;
      document.querySelector('[data-marketplace-field="port"]').value = "70000";
    });
    // The configuration check alone: in QA the test node may not be ready, and
    // the computer check runs (and fails) before it in the full sequence.
    const blocked = await wizardWindow.evaluate(() => window.validateCreateServerStep("configuration"));
    const afterBadPort = await wizardWindow.evaluate(() => ({
      advancedOpen: document.querySelector("[data-create-server-advanced]").open,
      step: createServerWizardStep,
    }));
    assert.strictEqual(blocked, false, "an invalid port blocks Create server");
    assert.strictEqual(afterBadPort.advancedOpen, true, "Advanced options opens to show the bad field");
    assert.strictEqual(afterBadPort.step, "configuration", "the wizard stays on setup");
    await shot(wizardWindow, "02c-advanced-options");
    await wizardWindow.close().catch(() => {});
    console.log("PASS S2 Create Server: one setup step, Advanced options collapsed and opened on errors");

    assert.deepStrictEqual(rendererErrors, [], "no renderer errors");
    console.log("Simple UI QA passed (3 checks).");
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => {});
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
