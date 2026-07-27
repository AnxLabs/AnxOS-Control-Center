#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { _electron: electron } = require("playwright-core");

const root = path.resolve(__dirname, "..");
const artifactDir = path.join(root, "artifacts", "qa", `stabilization-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(artifactDir, { recursive: true });

function redacted(value) {
  return String(value || "").replace(/(token|password|secret|authorization|cookie|session)[=:]\S+/gi, "$1=[redacted]");
}

async function visible(page, selector) {
  return page.locator(selector).first().isVisible().catch(() => false);
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-stabilization-qa-"));
  let app = null;
  const rendererErrors = [];
  const mainLogs = [];
  const writeArtifacts = (extra = {}) => {
    try {
      fs.writeFileSync(path.join(artifactDir, "main-process.log"), mainLogs.join(""));
      fs.writeFileSync(path.join(artifactDir, "renderer-errors.log"), rendererErrors.join("\n"));
      fs.writeFileSync(path.join(artifactDir, "results.json"), JSON.stringify({ artifactDir, ...extra }, null, 2));
    } catch {}
  };
  const watchdog = setTimeout(() => {
    writeArtifacts({ pass: false, error: "stabilization-ui-qa timed out" });
    app?.close?.().catch(() => {});
    process.exitCode = 1;
  }, 60000);
  app = await electron.launch({
    args: [`--user-data-dir=${userDataDir}`, "--no-sandbox", root, "--qa-mode"],
    env: { ...process.env, ANXOS_QA_MODE: "1" },
  });
  app.process().stdout?.on("data", (chunk) => mainLogs.push(redacted(chunk.toString())));
  app.process().stderr?.on("data", (chunk) => mainLogs.push(redacted(chunk.toString())));
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(8000);
    page.on("console", (message) => {
      if (message.type() === "error") rendererErrors.push(redacted(message.text()));
    });
    page.on("pageerror", (error) => rendererErrors.push(redacted(error.stack || error.message)));
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (window) window.setSize(1182, 821);
    });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(artifactDir, "launch-1182x821.png") });

    const securityGateVisible = await visible(page, "[data-security-gate]");
    const localSetupVisible = await visible(page, "[data-local-setup-gate]");
    const onboardingVisible = await visible(page, "[data-onboarding-welcome]");
    assert(!(securityGateVisible && (localSetupVisible || onboardingVisible)), "First Experience must not appear in front of Sign In.");
    assert(!onboardingVisible, "First Experience welcome must not appear before Sign In or local-mode selection.");
    if (localSetupVisible) {
      await page.locator('[data-local-setup-action="use-device"]').click();
      await page.locator("[data-local-setup-gate]").waitFor({ state: "hidden", timeout: 5000 });
    }

    await page.evaluate(() => window.showPage?.("security"));
    for (const section of ["activations", "rotation", "diagnostics"]) {
      await page.locator(`[data-security-section-target="${section}"]`).first().evaluate((element) => element.click());
      await page.waitForTimeout(100);
      assert.strictEqual(await visible(page, `[data-security-section="${section}"]`), true, `Security ${section} section must be visible.`);
    }
    const diagnosticsStatus = await page.locator("[data-security-diagnostics-status]").first().textContent().catch(() => "");
    assert(/Healthy|Loading|Locked|Unavailable|Attention/i.test(diagnosticsStatus || ""), "Security Diagnostics must expose a bounded state.");

    await page.evaluate(() => window.showPage?.("nodes"));
    const detailsInitiallyVisible = await visible(page, "[data-node-details-modal]:not([hidden])");
    const clickedVisibleTestAction = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll('[data-node-card-action="test"], [data-node-details-action="test"], [data-node-action="test-form"]'));
      const visible = candidates.find((element) => {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none" && !element.closest("[hidden]");
      });
      if (!visible) return false;
      visible.click();
      return true;
    });
    if (clickedVisibleTestAction) {
      await page.waitForTimeout(250);
      const detailsAfterTest = await visible(page, "[data-node-details-modal]:not([hidden])");
      assert(!(detailsAfterTest && !detailsInitiallyVisible), "Test Connection must not open Node Details.");
    }

    await page.evaluate(() => {
      window.showPage?.("instances");
      window.setActiveInstanceTab?.("files");
    });
    await page.waitForTimeout(250);
    const fileLayout = await page.evaluate(() => {
      const grid = document.querySelector(".instance-files-grid");
      const browser = document.querySelector(".instance-file-browser");
      const editor = document.querySelector("[data-instance-file-editor]");
      if (!grid || !browser || !editor) return null;
      const gridStyle = getComputedStyle(grid);
      const browserStyle = getComputedStyle(browser);
      const editorStyle = getComputedStyle(editor);
      return {
        gridHeight: grid.getBoundingClientRect().height,
        viewportHeight: window.innerHeight,
        gridOverflow: gridStyle.overflow,
        browserOverflowY: browserStyle.overflowY,
        editorOverflowY: editorStyle.overflowY,
      };
    });
    assert(fileLayout, "Instance file browser layout must exist.");
    assert(fileLayout.gridHeight <= fileLayout.viewportHeight, "Instance file grid must fit inside the compact viewport.");
    assert(/auto|scroll/.test(fileLayout.browserOverflowY), "Instance file browser must own vertical scrolling.");
    assert(/auto|scroll/.test(fileLayout.editorOverflowY), "Instance file editor must own vertical scrolling.");

    await page.evaluate(() => {
      const qaInstance = {
        id: "qa-minecraft-config",
        displayName: "QA Minecraft Config",
        type: "minecraft-paper",
        state: "Stopped",
        workingDirectory: "data",
        executable: "java",
        args: ["-jar", "server.jar", "nogui"],
        tags: ["minecraft"],
        game: "minecraft",
        ports: [25565],
      };
      const qaModel = {
        id: qaInstance.id,
        supported: true,
        adapterId: "minecraft",
        gameId: "minecraft",
        label: "Minecraft",
        format: "properties",
        filePath: "server.properties",
        sourceHash: "qa-source-hash",
        fields: [
          { key: "server-port", label: "Server Port", description: "TCP port.", category: "Network", type: "port", defaultValue: "25565", currentValue: 25565, required: true, min: 1, max: 65535, allowedValues: null, validation: null, advanced: false, sensitive: false, restartRequired: true, persistence: { key: "server-port" } },
          { key: "max-players", label: "Max Players", description: "Player limit.", category: "Players", type: "integer", defaultValue: "20", currentValue: 20, required: true, min: 1, max: 1000, allowedValues: null, validation: null, advanced: false, sensitive: false, restartRequired: true, persistence: { key: "max-players" } },
          { key: "difficulty", label: "Difficulty", description: "World difficulty.", category: "Gameplay", type: "select", defaultValue: "easy", currentValue: "easy", required: false, min: null, max: null, allowedValues: ["peaceful", "easy", "normal", "hard"], validation: null, advanced: false, sensitive: false, restartRequired: true, persistence: { key: "difficulty" } },
          { key: "enable-command-block", label: "Command Blocks", description: "Allow command blocks.", category: "Advanced", type: "boolean", defaultValue: "false", currentValue: false, required: false, min: null, max: null, allowedValues: null, validation: null, advanced: true, sensitive: false, restartRequired: true, persistence: { key: "enable-command-block" } },
          { key: "resource-pack", label: "Resource Pack URL", description: "Resource pack URL.", category: "Resource Pack", type: "text", defaultValue: "", currentValue: "", required: false, min: null, max: null, allowedValues: null, validation: null, advanced: true, sensitive: false, restartRequired: false, persistence: { key: "resource-pack" } },
        ],
        categories: ["Network", "Players", "Gameplay", "Advanced", "Resource Pack"],
        values: {
          "server-port": 25565,
          "max-players": 20,
          difficulty: "easy",
          "enable-command-block": false,
          "resource-pack": "",
        },
        capabilities: { save: true, saveAndRestart: true, rawFilePath: "server.properties" },
      };
      return window.eval(`
        latestInstancesSnapshot = { instances: [${JSON.stringify(qaInstance)}] };
        selectedInstanceId = "qa-minecraft-config";
        gameConfigState = {
          loading: false,
          loaded: true,
          supported: true,
          error: "",
          model: ${JSON.stringify(qaModel)},
          values: { ...${JSON.stringify(qaModel.values)} },
          snapshot: JSON.stringify(${JSON.stringify(qaModel.values)}),
          query: "",
          showAdvanced: false,
          activeCategory: "",
          fieldErrors: {},
          touchedSecrets: new Set(),
        };
        showPage("instances");
        activeInstanceTab = "settings";
        instanceTabs.forEach((button) => {
          const active = button.dataset.instanceTab === activeInstanceTab;
          button.classList.toggle("is-active", active);
          button.setAttribute("aria-selected", active ? "true" : "false");
        });
        instanceTabPanels.forEach((panel) => {
          panel.classList.toggle("is-active", panel.dataset.instancePanel === activeInstanceTab);
        });
        populateInstanceConfigForm(${JSON.stringify(qaInstance)});
        renderGameConfigPanel();
      `);
    });
    await page.waitForSelector("[data-game-config-manager]:not([hidden])");
    await page.locator("[data-game-config-title]").waitFor({ state: "visible" });
    assert(/Minecraft Configuration/i.test(await page.locator("[data-game-config-title]").textContent()), "Game config title must identify the adapter.");
    const settingsFormBox = await page.locator("[data-instance-config-form]").boundingBox();
    const startupTimeoutBox = await page.locator('[data-instance-config="startupTimeoutMs"]').boundingBox();
    const shutdownTimeoutBox = await page.locator('[data-instance-config="shutdownTimeoutMs"]').boundingBox();
    const gameConfigBox = await page.locator("[data-game-config-manager]").boundingBox();
    const autoStartLabel = page.locator('[data-instance-config="autoStart"]').locator("xpath=ancestor::label[1]");
    const autoStartBox = await autoStartLabel.boundingBox();
    assert(settingsFormBox && startupTimeoutBox && shutdownTimeoutBox && gameConfigBox && autoStartBox, "Settings layout controls must be measurable.");
    assert(autoStartBox.height <= 48, "Auto Start must render as a compact setting row, not a stretched empty panel.");
    assert(autoStartBox.y <= Math.max(startupTimeoutBox.y + startupTimeoutBox.height, shutdownTimeoutBox.y + shutdownTimeoutBox.height) + 24, "Auto Start must stay near the normal instance settings.");
    assert(autoStartBox.y + autoStartBox.height <= gameConfigBox.y + 4, "Auto Start must not share or float inside the game config layout.");
    assert(gameConfigBox.x <= settingsFormBox.x + 4, "Minecraft Configuration must start at the settings form left edge.");
    assert(gameConfigBox.width >= settingsFormBox.width - 8, "Minecraft Configuration must span the settings form width.");
    await page.locator("[data-game-config-search]").fill("players");
    await page.waitForTimeout(100);
    assert.strictEqual(await page.locator('[data-game-config-field="max-players"]').isVisible(), true, "Search must keep matching settings visible.");
    const playersSectionBox = await page.getByRole("button", { name: "Players" }).boundingBox();
    const playersFieldBox = await page.locator('[data-game-config-field="max-players"]').locator("xpath=..").boundingBox();
    assert(playersSectionBox && playersFieldBox && playersFieldBox.y <= playersSectionBox.y + 16, "Players fields must start near the top of the editor area.");
    await page.locator("[data-game-config-search]").fill("");
    await page.locator("[data-game-config-advanced]").check();
    await page.waitForTimeout(100);
    await page.getByRole("button", { name: "Advanced" }).click();
    await page.waitForTimeout(100);
    const booleanFieldBox = await page.locator('[data-game-config-field="enable-command-block"]').locator("xpath=..").boundingBox();
    const fieldsPanelBox = await page.locator("[data-game-config-fields]").boundingBox();
    assert(booleanFieldBox && fieldsPanelBox && booleanFieldBox.y <= fieldsPanelBox.y + 12, "Boolean settings must render at the top of the settings form, not centered in empty space.");
    await page.getByRole("button", { name: "Resource Pack" }).click();
    await page.waitForTimeout(100);
    assert.strictEqual(await page.locator('[data-game-config-field="resource-pack"]').isVisible(), true, "Advanced mode must reveal advanced settings.");
    await page.getByRole("button", { name: "Network" }).click();
    await page.waitForTimeout(100);
    await page.locator('[data-game-config-field="server-port"]').fill("25566");
    await page.waitForTimeout(100);
    assert.strictEqual(await page.locator("[data-game-config-save-restart]").isEnabled(), true, "Save and Restart must enable after a restart-required change.");
    assert(/restart required/i.test(await page.locator("[data-game-config-status]").textContent()), "Restart-required changes must be visible.");
    await page.getByRole("button", { name: "Players" }).click();
    await page.waitForTimeout(100);
    await page.locator('[data-game-config-field="max-players"]').fill("21");
    await page.waitForTimeout(100);
    await page.locator("[data-game-config-reset-current]").click();
    await page.waitForTimeout(100);
    assert.strictEqual(await page.locator('[data-game-config-field="max-players"]').inputValue(), "20", "Reset Current must restore the selected category to saved values.");
    assert.strictEqual(await page.locator("[data-game-config-save-restart]").isEnabled(), true, "Reset Current must preserve dirty settings in other categories.");
    await page.locator('[data-game-config-field="max-players"]').fill("22");
    await page.waitForTimeout(100);
    assert.strictEqual(await page.locator("[data-game-config-save-restart]").isEnabled(), true, "Editing after Reset Current must mark the form dirty again.");
    await page.locator("[data-game-config-reset-current]").click();
    await page.waitForTimeout(100);
    await page.getByRole("button", { name: "Network" }).click();
    await page.waitForTimeout(100);
    await page.locator("[data-game-config-reset-current]").click();
    await page.waitForTimeout(100);
    assert.strictEqual(await page.locator("[data-game-config-save-restart]").isDisabled(), true, "Reset Current must clear dirty state after all modified categories are reset.");

    await page.evaluate(() => window.showPage?.("dashboard"));
    await page.waitForTimeout(250);
    const dashboardText = await page.locator("[data-dashboard-friendly-empty]").textContent().catch(() => "");
    const instanceCount = await page.evaluate(() => Array.isArray(window.latestInstancesSnapshot?.instances) ? window.latestInstancesSnapshot.instances.length : null).catch(() => null);
    if (instanceCount && instanceCount > 0) {
      assert(!/Create your first server|No servers yet/i.test(dashboardText), "Dashboard must not show Create Server CTA when instances exist.");
    }

    await page.screenshot({ path: path.join(artifactDir, "stabilization-1182x821.png") });
    if (rendererErrors.length) {
      writeArtifacts({ pass: false, rendererErrors, fileLayout });
      throw new Error(`Renderer errors were reported: ${rendererErrors.join("; ")}`);
    }
    writeArtifacts({ pass: true, fileLayout });
    console.log(JSON.stringify({ pass: true, artifactDir, fileLayout }, null, 2));
  } finally {
    clearTimeout(watchdog);
    await app.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
