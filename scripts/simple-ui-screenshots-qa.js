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
//   S3 Computers and Sharing show tabs to their joined pages;
//   S4 Activity lists running work from the shared operations state and
//      opens its Task details; finished work leaves the list;
//   S5 a server's Share dialog explains in plain words whether friends can
//      join, and Test connection runs the read-only connectivity diagnostics;
//   S6 sharing asks first: cancelling creates nothing, approving sends the
//      request (refused here because the QA app is locked), and a server on a
//      management port (SSH) is refused before any approval dialog. Playit is
//      marked installed in memory only; this disposable app has no real Playit.
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

    // S1: Home (Phase 4 layout).
    await page.evaluate(() => window.showPage("dashboard"));
    await page.waitForTimeout(2500);
    await shot(page, "01-home");
    const home = await page.evaluate(() => {
      // checkVisibility also treats content inside a closed <details> as hidden.
      const visible = (el) => Boolean(el) && el.checkVisibility() && el.getBoundingClientRect().height > 0;
      const details = document.querySelector("[data-dashboard-details]");
      return {
        tiles: [...document.querySelectorAll("[data-home-overview] [data-home-tile]")].filter(visible).map((tile) => tile.dataset.homeTile),
        serversTile: document.querySelector('[data-home-tile="servers"]')?.textContent || "",
        sections: [...document.querySelectorAll("[data-home-sections] > [data-home-section]")].filter(visible).map((section) => section.dataset.homeSection),
        attentionRows: document.querySelectorAll("[data-home-attention] [role=listitem]").length,
        computerCards: [...document.querySelectorAll("[data-home-computers] [data-computer-id]")].map((card) => ({ freshness: card.dataset.freshness, text: card.textContent })),
        serverGridInSection: Boolean(document.querySelector('[data-home-section="servers"] [data-dashboard-app-grid]')),
        welcomeVisible: visible(document.querySelector(".dashboard-welcome")),
        detailsOpen: details?.open,
        cpuVisible: visible(document.querySelector('[data-dashboard-details] [data-field="cpuUsage"]')),
        tileRow: Boolean(document.querySelector("[data-dashboard-widgets]")),
      };
    });
    assert.deepStrictEqual(home.tiles, ["servers", "computers", "players", "attention"], "four overview tiles");
    assert.deepStrictEqual(home.sections, ["attention", "servers", "computers", "setup"], "default section order");
    assert.ok(home.attentionRows >= 1, "Needs attention always shows a row (an item or All good)");
    assert.ok(home.serversTile.includes("—") && home.serversTile.includes("Computer not connected"), `the QA computer is offline, so its last-known servers are not counted as running (${home.serversTile})`);
    assert.ok(home.computerCards.length >= 1, "each computer has a card");
    // The QA computer is disconnected: its card must not show live numbers.
    for (const card of home.computerCards) {
      if (card.freshness !== "fresh") assert.ok(!/\b\d{1,3}%/.test(card.text), `a computer without live readings shows no percentages (${card.text})`);
    }
    assert.strictEqual(home.serverGridInSection, true, "server cards live in My Servers");
    assert.strictEqual(home.welcomeVisible, false, "the old summary grid is tucked into details, not duplicated");
    assert.strictEqual(home.detailsOpen, false, "details start collapsed");
    assert.strictEqual(home.cpuVisible, false, "CPU details are tucked away");
    assert.strictEqual(home.tileRow, false, "the old duplicate tile row stays gone");
    await page.locator("[data-dashboard-details] > summary").click();
    await page.waitForTimeout(200);
    assert.strictEqual(await page.evaluate(() => document.querySelector('[data-dashboard-details] [data-field="cpuUsage"]').checkVisibility()), true, "opening the details shows CPU");
    await page.locator("[data-dashboard-details] > summary").click();
    console.log(`PASS S1 Home: overview, Needs attention, My Servers, Computers (${home.computerCards.map((card) => card.freshness).join(", ")})`);

    // S7: Customize reorders and hides sections, and the choice survives a reload.
    await page.locator("[data-home-customize-toggle]").click();
    await page.waitForTimeout(200);
    assert.strictEqual(await page.locator('[data-home-customize] [data-section-id="attention"] input').isDisabled(), true, "Needs attention cannot be hidden");
    await page.locator('[data-home-customize] [data-section-id="computers"] button', { hasText: "Move up" }).click();
    await page.locator('[data-home-customize] [data-section-id="setup"] input').uncheck();
    await shot(page, "07-customize");
    await page.locator("[data-home-customize-toggle]").click();
    // Put the DOM back in the default order, then re-apply from storage: the
    // stored preference alone must restore the layout. (Storage surviving a
    // real restart is proven for the sidebar groups by N3.)
    const customized = await page.evaluate(() => {
      const container = document.querySelector("[data-home-sections]");
      ["attention", "servers", "computers", "setup"].forEach((id) => {
        const section = container.querySelector(`[data-home-section="${id}"]`);
        section.hidden = false;
        container.append(section);
      });
      window.AnxHomeDashboard.applySectionPreferences();
      return ({
      order: [...document.querySelectorAll("[data-home-sections] > [data-home-section]")].map((section) => section.dataset.homeSection),
      setupHidden: document.querySelector('[data-home-section="setup"]').hidden,
      });
    });
    assert.deepStrictEqual(customized.order.slice(0, 3), ["attention", "computers", "servers"], "the stored order is applied");
    assert.strictEqual(customized.setupHidden, true, "a hidden section stays hidden");
    await page.evaluate(() => { localStorage.removeItem("anxos.home.sections.v1"); window.AnxHomeDashboard.applySectionPreferences(); });
    console.log("PASS S7 Customize reorders and hides sections and remembers them");

    // S3: joined pages show their tabs.
    for (const [pageName, tabs] of [["nodes", ["nodes", "agent-control"]], ["playit", ["playit", "network"]]]) {
      await page.evaluate((name) => window.showPage(name), pageName);
      await page.waitForTimeout(300);
      const shown = await page.evaluate((name) => [...document.querySelectorAll(`.page[data-page="${name}"] .page-tabs__tab`)].map((t) => t.dataset.pageTab), pageName);
      assert.deepStrictEqual(shown, tabs, `${pageName} shows its tabs`);
      await shot(page, `03-${pageName}`);
    }
    console.log("PASS S3 Computers and Sharing show tabs to their joined pages");

    // S8: the Computers page shows the detail panel for a computer.
    await page.evaluate(() => window.showPage("nodes"));
    await page.waitForTimeout(800);
    const detailPanel = await page.evaluate(() => ({
      chips: document.querySelectorAll("[data-computer-details] [data-view-computer]").length,
      cards: document.querySelectorAll("[data-computer-details] .computer-card").length,
      graph: Boolean(document.querySelector("[data-computer-details] .computer-graph__svg")),
      info: [...document.querySelectorAll("[data-computer-details] .computer-details__row span")].map((span) => span.textContent),
      sections: [...document.querySelectorAll("[data-computer-details] h3")].map((h) => h.textContent),
    }));
    assert.ok(detailPanel.chips >= 1, "a chip per computer");
    assert.ok(detailPanel.cards >= 4, "CPU, memory, disk and network cards");
    assert.ok(detailPanel.graph, "a recent-activity graph");
    // Phase 8 added the Network section.
    assert.deepStrictEqual(detailPanel.sections, ["Recent activity", "Computer and Agent", "Network", "Servers on this computer", "Alerts"]);
    assert.ok(detailPanel.info.includes("Agent version") && detailPanel.info.includes("Operating system"));
    await page.evaluate(() => document.querySelector("[data-computer-details]").scrollIntoView());
    await shot(page, "08-computer-details");
    console.log("PASS S8 Computers page shows resource cards, graph, Agent info, servers and alerts");

    // S4: Activity shows running work from operationsState.
    await page.evaluate(() => window.showPage("notifications"));
    const operationId = await page.evaluate(() => window.startOperation({ type: "Backups", title: "Back up Friends Server", target: "OVH", step: "Copying world files", percent: 40 }));
    await page.waitForTimeout(200);
    const activity = await page.evaluate(() => ({
      shown: document.querySelector("[data-activity-in-progress]").checkVisibility(),
      items: [...document.querySelectorAll("[data-activity-in-progress-list] [data-operation-id]")].map((row) => row.textContent),
      navLabel: document.querySelector('.nav-menu [data-page-target="notifications"] [data-nav-label]').textContent,
    }));
    assert.strictEqual(activity.navLabel, "Activity");
    assert.strictEqual(activity.shown, true, "In progress is shown while work runs");
    assert.ok(activity.items.some((text) => text.includes("Back up Friends Server") && text.includes("Copying world files")), "the running task is listed with its step");
    await shot(page, "04-activity");
    await page.locator(`[data-activity-in-progress-list] [data-operation-id="${operationId}"]`).click();
    await page.waitForTimeout(200);
    assert.strictEqual(await page.evaluate(() => document.querySelector(".page.is-active")?.dataset.page), "operations", "clicking a task opens Task details");
    await page.evaluate((id) => window.finishOperation(id, true, "Backup complete."), operationId);
    await page.evaluate(() => window.showPage("notifications"));
    await page.waitForTimeout(200);
    assert.strictEqual(await page.evaluate(() => document.querySelector("[data-activity-in-progress]").checkVisibility()), false, "finished work leaves In progress");
    console.log("PASS S4 Activity lists running work and links to Task details");

    // S5: Share dialog for the test Agent's server.
    await page.evaluate(() => window.showPage("instances"));
    await waitFor(page, () => typeof getInstances === "function" && getInstances().length > 0, null, "test server in My Servers");
    const instanceId = await page.evaluate(() => getInstances()[0].id);
    await page.evaluate((id) => window.openShareServerModal(id), instanceId);
    await page.waitForTimeout(300);
    const shareBefore = await page.evaluate(() => {
      const dialog = document.querySelector("[data-share-server-modal]");
      return {
        open: Boolean(dialog),
        heading: dialog?.querySelector(".share-server-health h3")?.textContent || "",
        headline: dialog?.querySelector(".share-server-health__status")?.textContent || "",
        status: dialog?.querySelector("[data-share-health-status]")?.dataset.shareHealthStatus || "",
        checks: [...(dialog?.querySelectorAll(".share-server-health > .share-server-checklist li") || [])].map((li) => li.dataset.checkId),
        hasTest: Boolean(dialog?.querySelector("[data-share-server-test]")),
      };
    });
    assert.ok(shareBefore.open, "the Share dialog opens");
    assert.strictEqual(shareBefore.heading, "Can friends join?");
    assert.ok(shareBefore.headline && !/^(running|matched|unknown)$/i.test(shareBefore.headline), "the headline is a plain sentence");
    assert.notStrictEqual(shareBefore.status, "Public access ready", "the test server has no verified public path, so it is not reported ready");
    assert.deepStrictEqual(shareBefore.checks, ["server", "game", "playit", "tunnel", "address"]);
    assert.ok(shareBefore.hasTest, "Test connection is offered");
    await shot(page, "05-share-dialog");
    // Sharing never starts without approval: in QA, Playit on the test
    // computer is not ready, so the start is refused before any approval
    // dialog; either way no access record may be created.
    const servicesBefore = await page.evaluate((id) => getInstanceAccessServices(findInstance(id)).length, instanceId);
    const startButton = page.locator("[data-share-server-start]");
    if (await startButton.count()) {
      await startButton.click();
      await page.waitForTimeout(600);
      const confirmOpen = await page.locator("[data-confirm-ok]").count();
      if (confirmOpen) {
        const message = await page.evaluate(() => document.querySelector("[data-confirm-ok]")?.closest(".app-modal")?.textContent || "");
        assert.match(message, /Only this game port is shared/, "the approval says exactly what is shared");
        await page.locator("[data-confirm-cancel]").last().click();
        await page.waitForTimeout(300);
      }
      const servicesAfter = await page.evaluate((id) => getInstanceAccessServices(findInstance(id)).length, instanceId);
      assert.strictEqual(servicesAfter, servicesBefore, "nothing is shared without approval");
      console.log(`  share start: ${confirmOpen ? "approval dialog shown and cancelled" : "refused before approval (Playit not ready)"}`);
      await page.keyboard.press("Escape");
      await page.evaluate((id) => window.openShareServerModal(id), instanceId);
      await page.waitForTimeout(300);
    }
    await page.locator("[data-share-server-test]").click();
    await waitFor(page, () => {
      const result = document.querySelector("[data-share-server-test-result]");
      return Boolean(result) && result.textContent.trim().length > 0 && !/Checking the path/.test(result.textContent);
    }, null, "connection test result");
    await page.waitForTimeout(400);
    const testText = await page.evaluate(() => document.querySelector("[data-share-server-test-result]")?.textContent || "");
    assert.ok(testText.length > 0, "the connection test reports a result");
    await shot(page, "05b-share-test");
    await page.keyboard.press("Escape");
    // S6: approval, cancellation and the management-port guard.
    const readyPlayit = () => page.evaluate(() => {
      latestPublicAccessSnapshot = { ...(latestPublicAccessSnapshot || {}), providers: [{ id: "playit", name: "Playit.gg", installed: true }], services: [] };
    });
    const waitForApproval = () => waitFor(page, () => Boolean(document.querySelector("[data-confirm-ok]")), null, "approval dialog");
    await readyPlayit();
    await page.evaluate((id) => { window.__shareAttempt = createAccessServiceForInstance(findInstance(id), "playit").then((value) => ({ value }), (error) => ({ error: error?.code || error?.message })); }, instanceId);
    await waitForApproval();
    const approvalText = await page.evaluate(() => document.querySelector("[data-confirm-ok]").closest(".app-modal").textContent);
    assert.match(approvalText, /over the internet\?/, "the approval names internet sharing");
    assert.match(approvalText, /(TCP|UDP) port \d+/, "the approval names the exact port and protocol");
    assert.match(approvalText, /Only this game port is shared/);
    await shot(page, "06-share-approval");
    await page.locator("[data-confirm-cancel]").last().click();
    const cancelled = await page.evaluate(() => window.__shareAttempt);
    assert.deepStrictEqual(cancelled, { value: null }, "cancelling creates nothing and is not an error");
    await readyPlayit();
    await page.evaluate((id) => { window.__shareAttempt = createAccessServiceForInstance(findInstance(id), "playit").then((value) => ({ value: Boolean(value) }), (error) => ({ error: error?.code || error?.message || "error" })); }, instanceId);
    await waitForApproval();
    await page.locator("[data-confirm-ok]").last().click();
    const approved = await page.evaluate(() => window.__shareAttempt);
    assert.ok(approved.error || approved.value, "approving sends the request");
    await readyPlayit();
    const guarded = await page.evaluate(() => createAccessServiceForInstance({ id: "qa-ssh", displayName: "SSH test", state: "running", primaryPort: 22, ports: [22] }, "playit").then(() => "created", (error) => error?.code || "error"));
    assert.strictEqual(guarded, "PUBLIC_ACCESS_SENSITIVE_PORT", "a management port is refused");
    assert.strictEqual(await page.locator("[data-confirm-ok]").count(), 0, "no approval dialog is shown for a refused port");
    console.log(`PASS S6 sharing asks first, cancel creates nothing, approve sends the request (${approved.error || "created"}), port 22 refused`);

    console.log(`PASS S5 Share dialog explains sharing and runs Test connection (${shareBefore.status}; test: ${testText.slice(0, 80)})`);

    // S2: Create Server.
    await page.evaluate(() => window.showPage("dashboard"));
    const opened = app.waitForEvent("window", { timeout: 20000 });
    await page.locator('[data-home-section="servers"] [data-dashboard-action="create-server"]').click();
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
    const summaryText = await wizardWindow.evaluate(() => document.querySelector("[data-create-server-package-summary]").textContent);
    assert.match(summaryText, /Software it needs/, "the setup step says what software the game needs");
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

    // An occupied port is explained and blocks Create server. The QA computer
    // is offline, so the live listener result is injected in memory.
    const occupied = await wizardWindow.evaluate(() => {
      document.querySelector('[data-marketplace-field="port"]').value = "25565";
      document.querySelector("[data-create-server-advanced]").open = false;
      createServerPortCheck = { templateId: findMarketplaceTemplate().id, nodeId: getSelectedNodeId(), status: "done", owners: { 25565: "java (PID 412)" }, truncated: false };
      const ok = window.validateCreateServerStep("configuration");
      return {
        ok,
        message: document.querySelector("[data-marketplace-message]")?.textContent || "",
        advancedOpen: document.querySelector("[data-create-server-advanced]").open,
      };
    });
    assert.strictEqual(occupied.ok, false, "an occupied port blocks Create server");
    assert.ok(occupied.message.includes("Port 25565 is already in use on this computer by java (PID 412)"), occupied.message);
    assert.strictEqual(occupied.advancedOpen, true, "Advanced options opens to the port");
    await shot(wizardWindow, "02d-occupied-port");
    await wizardWindow.close().catch(() => {});
    console.log("PASS S2 Create Server: one setup step, Advanced options collapsed and opened on errors");

    assert.deepStrictEqual(rendererErrors, [], "no renderer errors");
    console.log("Simple UI QA passed (8 checks).");
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
