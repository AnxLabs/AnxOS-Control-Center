// F5 regression leg: the Content-Security-Policy meta in index.html must allow
// Monaco's data:-URL web worker (worker-src 'self' blob: data:). When it does
// not, Chromium logs a CSP violation and Monaco falls back with "Could not
// create web worker(s). Falling back to loading web worker code in main
// thread, which might cause UI freezes".
//
// This smoke launches the real Electron app, opens the Files page, connects the
// local filesystem, opens a real file in the Monaco editor, and asserts:
//   * at least one worker was constructed and none threw (window.Worker probe);
//   * zero CSP violation console errors;
//   * no Monaco worker fallback warning;
//   * the Monaco editor actually rendered (.monaco-editor visible).
//
// Electron-only; hermetic QA env (isolated config/log/tmp) plus a temp probe
// directory. No user data is read or written.
//
// Precondition: this smoke launches the real Electron app and drives a desktop
// session, which is only available on the Windows QA host. `rc:validate`
// auto-discovers every `*:smoke` script, so an unmet precondition must exit 0
// with an explicit marker instead of failing the gate (same
// PRECONDITION_NOT_MET convention as scripts/packaging-artifact-smoke.js).
if (process.platform !== "win32") {
  console.log("Monaco worker CSP smoke skipped (PRECONDITION_NOT_MET: requires a Windows desktop session)");
  process.exit(0);
}

const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");

const root = path.resolve(__dirname, "..");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = path.join(root, "artifacts", "monaco-worker-csp", timestamp);
fs.mkdirSync(artifactDir, { recursive: true });

const ACTION_TIMEOUT_MS = 10_000;
const GLOBAL_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 12_000;

const consoleEntries = [];
const rendererErrors = [];
const cspViolations = [];
const workerFallbackWarnings = [];

const redact = (value) => String(value || "").replace(/(authorization|token|password|secret|api[_-]?key|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${timeoutMs}ms.`), { code: "QA_TIMEOUT" })), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function dismissFirstRunOverlays(window) {
  const welcomeSkip = window.locator('[data-onboarding-welcome] [data-onboarding-action="skip"]');
  if (await welcomeSkip.count() && await welcomeSkip.isVisible().catch(() => false)) {
    await welcomeSkip.evaluate((element) => element.click());
    await window.locator("[data-onboarding-welcome]").waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  }
  const useDevice = window.locator('[data-local-setup-action="use-device"]');
  if (await useDevice.count() && await useDevice.isVisible().catch(() => false)) {
    await useDevice.evaluate((element) => element.click());
    await window.locator("[data-local-setup-gate]").waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  }
  const dismissUpdate = window.locator('[data-update-modal] [data-update-action="dismiss"]').first();
  if (await dismissUpdate.count() && await dismissUpdate.isVisible().catch(() => false)) {
    await dismissUpdate.evaluate((element) => element.click());
    await window.locator("[data-update-modal]").waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  }
}

async function main() {
  const qaEnvironment = createIsolatedQaEnv("anx-monaco-csp-");
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-monaco-csp-profile-"));
  const probeDir = path.join(qaEnvironment.root, "monaco-probe");
  fs.mkdirSync(probeDir, { recursive: true });
  const probeFile = path.join(probeDir, "csp-worker-probe.json");
  fs.writeFileSync(probeFile, `${JSON.stringify({ probe: "monaco-worker-csp", nested: { ok: true } }, null, 2)}\n`, "utf8");

  let app = null;
  let summary = null;
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, "--no-sandbox", root, "--qa-mode"],
      env: { ...process.env, ...qaEnvironment.env, ANXOS_QA_MODE: "1" },
    });
    const window = await withTimeout(app.firstWindow(), ACTION_TIMEOUT_MS, "Main window launch");
    window.setDefaultTimeout(ACTION_TIMEOUT_MS);
    window.on("console", (message) => {
      const entry = { type: message.type(), text: redact(message.text()) };
      consoleEntries.push(entry);
      if (message.type() === "error") {
        rendererErrors.push(entry.text);
        if (/content security policy|refused to create a worker|refused to load the script/i.test(entry.text)) cspViolations.push(entry.text);
      }
      if (/could not create web worker/i.test(entry.text)) workerFallbackWarnings.push(entry.text);
    });
    window.on("pageerror", (error) => rendererErrors.push(redact(`pageerror: ${error.stack || error.message}`)));
    await window.waitForLoadState("domcontentloaded");
    await window.waitForTimeout(500);
    await dismissFirstRunOverlays(window);

    // Instrument window.Worker before Monaco lazily loads on first file open.
    await window.evaluate(() => {
      const probe = { constructed: 0, failed: 0, names: [] };
      window.__anxWorkerProbe = probe;
      const OriginalWorker = window.Worker;
      window.Worker = class AnxosProbedWorker extends OriginalWorker {
        constructor(url, options) {
          try {
            super(url, options);
            probe.constructed += 1;
            probe.names.push(String(options?.name || String(url).slice(0, 32)));
          } catch (error) {
            probe.failed += 1;
            throw error;
          }
        }
      };
    });

    // Open the Files page the way a user does.
    const filesNav = window.locator('[data-page-target="files"]').first();
    await filesNav.scrollIntoViewIfNeeded().catch(() => {});
    await filesNav.click({ timeout: ACTION_TIMEOUT_MS });
    await window.locator('[data-page="files"]').waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });

    // Select the local filesystem connection and connect.
    const localItem = window.locator("[data-storage-list] .storage-connection-item")
      .filter({ hasText: /Local filesystem on the application host/i }).first();
    if (await localItem.count()) await localItem.click({ timeout: ACTION_TIMEOUT_MS }).catch(() => {});
    const connectButton = window.locator("[data-files-connect]");
    await connectButton.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    if (await connectButton.isDisabled().catch(() => false)) {
      await window.waitForFunction(() => {
        const button = document.querySelector("[data-files-connect]");
        return Boolean(button && !button.disabled);
      }, null, { timeout: 15_000 });
    }
    await connectButton.click({ timeout: ACTION_TIMEOUT_MS });
    await window.waitForFunction(() => {
      const input = document.querySelector("[data-files-path]");
      return Boolean(input && !input.disabled);
    }, null, { timeout: 20_000 });

    // Navigate to the probe directory and open the probe file in Monaco.
    const pathInput = window.locator("[data-files-path]");
    await pathInput.fill(probeDir);
    await pathInput.press("Enter");
    const probeRow = window.locator("[data-file-list] tr").filter({ hasText: "csp-worker-probe.json" }).first();
    await probeRow.waitFor({ state: "visible", timeout: 20_000 });
    await probeRow.dblclick({ timeout: ACTION_TIMEOUT_MS });
    await window.locator("[data-file-editor-code-layer] .monaco-editor").first().waitFor({ state: "visible", timeout: 30_000 });
    // Give Monaco a beat to spin up the language worker it needs.
    await window.waitForTimeout(3_000);

    const workerProbe = await window.evaluate(() => window.__anxWorkerProbe || null);
    const screenshotName = "monaco-worker-csp.png";
    await window.screenshot({ path: path.join(artifactDir, screenshotName) });

    const checks = {
      workerConstructed: Boolean(workerProbe && workerProbe.constructed >= 1),
      workerConstructionFailed: Boolean(workerProbe && workerProbe.failed > 0),
      cspViolations: cspViolations.length,
      workerFallbackWarnings: workerFallbackWarnings.length,
    };
    const pass = checks.workerConstructed
      && !checks.workerConstructionFailed
      && checks.cspViolations === 0
      && checks.workerFallbackWarnings === 0;

    summary = {
      status: pass ? "PASS" : "FAIL",
      classification: "MONACO WEB WORKER STARTED UNDER CSP (NO FALLBACK)",
      checks,
      workerProbe,
      rendererErrors,
      cspViolations,
      workerFallbackWarnings,
      screenshot: screenshotName,
      artifactDir,
    };
    fs.writeFileSync(path.join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(artifactDir, "renderer-console.log"), consoleEntries.map((entry) => `${entry.type}: ${entry.text}`).join("\n"));
    return pass;
  } catch (error) {
    summary = {
      status: "FAIL",
      classification: "MONACO WEB WORKER STARTED UNDER CSP (NO FALLBACK)",
      error: redact(error?.stack || error?.message || String(error)),
      rendererErrors,
      cspViolations,
      workerFallbackWarnings,
      artifactDir,
    };
    fs.writeFileSync(path.join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(artifactDir, "renderer-console.log"), consoleEntries.map((entry) => `${entry.type}: ${entry.text}`).join("\n"));
    return false;
  } finally {
    if (app) await withTimeout(app.close(), CLEANUP_TIMEOUT_MS, "Electron shutdown").catch(() => {});
    qaEnvironment.cleanup();
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (summary) console.log(JSON.stringify(summary, null, 2));
  }
}

async function run() {
  let pass = false;
  try {
    pass = await withTimeout(main(), GLOBAL_TIMEOUT_MS, "Monaco worker CSP smoke");
  } catch (error) {
    console.error(redact(error.stack || error.message));
  }
  process.exitCode = pass ? 0 : 1;
}

run();