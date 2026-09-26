// Focused regression proof for Defect B2: structured Marketplace errors must
// cross the real contextBridge with code/details intact, and the renderer's
// dependency auto-recovery path must fire instead of dead-ending.
//
// The harness launches the real application in an isolated profile, replaces
// the marketplace install handler and the dependency-plan handler with
// deterministic fixtures in the main process only, and drives the real
// preload bridge from the renderer. Nothing here touches the installed app
// or its data: the profile, config, log, and temp directories are isolated.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");

const ROOT = path.join(__dirname, "..");
const WATCHDOG_MS = 120000;

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-marketplace-bridge-"));
  const qaEnvironment = createIsolatedQaEnv("anx-marketplace-bridge-env-");
  const mainLogs = [];
  let app = null;
  let verdictWritten = false;

  const watchdog = setTimeout(() => {
    if (verdictWritten) return;
    console.error("marketplace-error-bridge-smoke FAILED: watchdog elapsed before a verdict was reached.");
    console.error(mainLogs.slice(-25).join(""));
    app?.close?.().catch(() => {});
    process.exitCode = 1;
  }, WATCHDOG_MS);

  const redact = (text) => String(text || "")
    .replace(/(token|secret|password|key)=([^\s&]+)/gi, "$1=[redacted]");

  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, "--no-sandbox", ROOT, "--qa-mode"],
      env: { ...process.env, ...qaEnvironment.env, ANXOS_QA_MODE: "1" },
    });
    const appProcess = app.process();
    appProcess.stdout?.on("data", (chunk) => mainLogs.push(redact(chunk.toString())));
    appProcess.stderr?.on("data", (chunk) => mainLogs.push(redact(chunk.toString())));

    const page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    await page.waitForLoadState("domcontentloaded");

    const bridgeReady = await page.waitForFunction(
      () => typeof window.anx?.marketplace?.installTemplate === "function"
        && typeof window.maybePrepareMarketplaceDependencies === "function"
        && typeof window.marketplaceErrorHelper?.normalizeMarketplaceError === "function",
      null,
      { timeout: 30000 },
    ).then(() => true).catch(() => false);
    assert.ok(bridgeReady, "The real preload bridge and renderer helpers must be available before driving the fixture.");

    // Main-process fixtures only: deterministic marketplace failure envelope and
    // a dependency plan that requires manual preparation, so the renderer flow
    // never depends on a real node, real auth state, or real dependency install.
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("marketplace:installTemplate");
      ipcMain.handle("marketplace:installTemplate", () => ({
        ok: false,
        error: {
          code: "DEPENDENCIES_REQUIRED",
          message: "This template requires node dependencies before installation can continue.",
          friendlyMessage: "This template requires node dependencies before installation can continue.",
          suggestion: "Install the missing node dependencies, then retry the Marketplace install.",
          retryable: true,
          status: null,
          provider: null,
          diagnostics: null,
          details: {
            templateId: "minecraft-paper",
            dependencyIds: ["java"],
            dependencies: [{
              id: "java",
              displayName: "Java 21 runtime",
              packages: ["openjdk-21-jre-headless"],
              reason: "Required by Minecraft server runtimes.",
            }],
            missingDependencies: [{
              id: "java",
              displayName: "Java 21 runtime",
              packages: ["openjdk-21-jre-headless"],
              reason: "Required by Minecraft server runtimes.",
            }],
            retryable: true,
            userAction: "install-dependencies",
          },
        },
      }));
      ipcMain.removeHandler("dependencies:plan");
      ipcMain.handle("dependencies:plan", () => ({
        ok: true,
        nodeId: "qa-node",
        dependencyIds: ["java"],
        distribution: { id: "linux", name: "Ubuntu", packageManager: "apt" },
        actions: [{
          id: "java",
          displayName: "Java 21 runtime",
          state: "missing",
          installable: false,
          reason: "Fixture: automatic installation is unavailable.",
        }],
        installableActions: [],
        manualActions: [{
          id: "java",
          displayName: "Java 21 runtime",
          hint: "Install Java 21 on the node manually.",
        }],
        missingDependencyIds: ["java"],
        requiresUserInitiation: false,
        plannedAt: new Date().toISOString(),
      }));
    });

    // PROOF 1 — the bridge rejection is a plain object carrying code/details,
    // and the real renderer normalizer preserves the dependency payload.
    const bridgeResult = await page.evaluate(async () => {
      const readKeys = (value) => (value && typeof value === "object" ? Object.keys(value) : []);
      try {
        await window.anx.marketplace.installTemplate({
          templateId: "minecraft-paper",
          nodeId: "qa-node",
          options: { name: "Bridge Smoke", version: "1.21.11", start: false },
        });
        return { threw: false };
      } catch (error) {
        const normalized = window.marketplaceErrorHelper.normalizeMarketplaceError(error, "Template install failed.");
        return {
          threw: true,
          isErrorInstance: error instanceof Error,
          keys: readKeys(error),
          code: error?.code || null,
          message: error?.message || null,
          friendlyMessage: error?.friendlyMessage || null,
          suggestion: error?.suggestion || null,
          retryable: error?.retryable === true,
          missingDependencyIds: Array.isArray(error?.details?.missingDependencies)
            ? error.details.missingDependencies.map((entry) => entry.id)
            : null,
          normalizedCode: normalized?.code || null,
          normalizedMissingDependencyIds: Array.isArray(normalized?.details?.missingDependencies)
            ? normalized.details.missingDependencies.map((entry) => entry.id)
            : null,
        };
      }
    });

    assert.strictEqual(bridgeResult.threw, true, "The Marketplace install call must reject.");
    assert.strictEqual(bridgeResult.isErrorInstance, false, "The bridge rejection must be a plain object, not an Error instance.");
    assert.strictEqual(bridgeResult.code, "DEPENDENCIES_REQUIRED", "The renderer must receive the DEPENDENCIES_REQUIRED code.");
    assert.deepStrictEqual(bridgeResult.missingDependencyIds, ["java"], "The renderer must receive details.missingDependencies across the bridge.");
    assert.strictEqual(bridgeResult.retryable, true, "The renderer must receive the retryable flag.");
    assert.strictEqual(bridgeResult.normalizedCode, "DEPENDENCIES_REQUIRED", "normalizeMarketplaceError must keep the structured code.");
    assert.deepStrictEqual(bridgeResult.normalizedMissingDependencyIds, ["java"], "normalizeMarketplaceError must keep the missing dependency list.");

    // PROOF 2 — the real recovery function fires: it returns true (handled)
    // and renders the dependency preparation state instead of bailing. The
    // legacy shape (a bridged Error whose custom fields were dropped) is
    // evaluated in the same renderer as a control and must bail.
    const recoveryResult = await page.evaluate(async () => {
      try {
        await window.anx.marketplace.installTemplate({
          templateId: "minecraft-paper",
          nodeId: "qa-node",
          options: { name: "Bridge Smoke", version: "1.21.11", start: false },
        });
        return { bridgeThrew: false };
      } catch (error) {
        const template = {
          id: "minecraft-paper",
          displayName: "Minecraft Paper",
          category: "Minecraft",
          minecraftVersion: "1.21.11",
        };
        const normalized = window.marketplaceErrorHelper.normalizeMarketplaceError(error, "Template install failed.");
        const handled = await window.maybePrepareMarketplaceDependencies(
          normalized,
          template,
          { version: "1.21.11" },
          { nodeId: "qa-node" },
          false,
        );
        const messageElement = document.querySelector("#marketplace-message, [data-marketplace-message]");
        const messageText = String(messageElement?.textContent || "");
        // Control: what the renderer used to see — an Error whose custom
        // properties were dropped by the contextBridge.
        const legacyBridgedError = new Error("This template requires node dependencies before installation can continue.");
        const legacyNormalized = window.marketplaceErrorHelper.normalizeMarketplaceError(legacyBridgedError, "Template install failed.");
        const legacyHandled = await window.maybePrepareMarketplaceDependencies(
          legacyNormalized,
          template,
          { version: "1.21.11" },
          { nodeId: "qa-node" },
          false,
        );
        return { bridgeThrew: true, handled, legacyHandled, messageText };
      }
    });

    assert.strictEqual(recoveryResult.bridgeThrew, true, "The install call must still reject for the recovery proof.");
    assert.strictEqual(recoveryResult.handled, true, "The dependency recovery flow must handle the structured DEPENDENCIES_REQUIRED error.");
    assert.strictEqual(recoveryResult.legacyHandled, false, "Control: an Error with dropped custom fields must not trigger recovery.");
    assert.match(recoveryResult.messageText, /dependencies are prepared manually/i, "The renderer must surface the dependency preparation state.");

    verdictWritten = true;
    clearTimeout(watchdog);
    console.log("marketplace-error-bridge-smoke passed.");
    console.log(JSON.stringify({
      proof1: {
        status: "PROVEN AT RUNTIME",
        channel: "marketplace:installTemplate",
        rendererReceivedCode: bridgeResult.code,
        rendererReceivedMissingDependencies: bridgeResult.missingDependencyIds,
        rejectionShape: bridgeResult.keys.sort(),
        normalizedCode: bridgeResult.normalizedCode,
      },
      proof2: {
        status: "PROVEN AT RUNTIME",
        recoveryHandled: recoveryResult.handled,
        legacyControlHandled: recoveryResult.legacyHandled,
        renderedMessage: recoveryResult.messageText.slice(0, 160),
      },
    }, null, 2));
  } finally {
    clearTimeout(watchdog);
    await app?.close?.().catch(() => {});
    qaEnvironment.cleanup();
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error("marketplace-error-bridge-smoke FAILED:", error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
