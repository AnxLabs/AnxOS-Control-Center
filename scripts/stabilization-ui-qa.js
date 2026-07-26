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
