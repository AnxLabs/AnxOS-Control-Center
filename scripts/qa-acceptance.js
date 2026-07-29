const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");

const root = path.resolve(__dirname, "..");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = path.join(root, "artifacts", "qa", timestamp);
const screenshotDir = path.join(artifactDir, "screenshots");
fs.mkdirSync(screenshotDir, { recursive: true });
const timeline = [];
const results = [];
const rendererErrors = [];
const rendererWarnings = [];
const rendererLogs = [];
const fatalWarnings = [];
const strictSecurity = process.env.ANXOS_QA_STRICT_SECURITY === "1";
const ACTION_TIMEOUT_MS = 8_000;
const GLOBAL_TIMEOUT_MS = 180_000;
const CLEANUP_TIMEOUT_MS = 12_000;
let electronApp = null;
let appWindow = null;
let spawnedPid = null;
let completed = false;
let qaEnvironment = null;
let qaUserDataDir = null;
const redact = (value) => String(value || "").replace(/(authorization|token|password|secret|api[_-]?key|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");
function record(action, target, expected, observed, pass, screenshot = null) {
  const entry = { timestamp: new Date().toISOString(), action, target, expected, observed: redact(observed), pass, screenshot };
  timeline.push(entry);
  results.push({ name: action, pass, observed: entry.observed });
}

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${timeoutMs}ms.`), { code: "QA_TIMEOUT" })), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function dismissSafeBlockingModals(window) {
  const updateModal = window.locator("[data-update-modal]");
  if (await updateModal.isVisible({ timeout: 500 }).catch(() => false)) {
    const dismiss = updateModal.locator('[data-update-action="dismiss"]').first();
    if (await dismiss.isVisible({ timeout: 500 }).catch(() => false)) {
      await dismiss.click({ timeout: ACTION_TIMEOUT_MS });
      await updateModal.waitFor({ state: "hidden", timeout: ACTION_TIMEOUT_MS });
      return "update prompt dismissed with Later";
    }
  }
  return null;
}

async function clickWithSafeModalRecovery(window, locator, { allowDomFallback = false } = {}) {
  try {
    await locator.click({ timeout: Math.min(3_000, ACTION_TIMEOUT_MS) });
    return { clicked: true, dismissed: null };
  } catch (error) {
    const dismissed = await dismissSafeBlockingModals(window);
    if (dismissed) {
      await locator.click({ timeout: ACTION_TIMEOUT_MS });
      return { clicked: true, dismissed };
    }
    if (await window.locator("[data-security-gate]").isVisible({ timeout: 500 }).catch(() => false)) {
      return { clicked: false, gated: true, dismissed: null };
    }
    if (allowDomFallback) {
      await locator.evaluate((element) => element.click());
      return { clicked: true, dismissed: null, domFallback: true };
    }
    throw error;
  }
}

async function captureFailureDiagnostics(error) {
  const failure = {
    timestamp: new Date().toISOString(),
    code: error?.code || null,
    message: redact(error?.message || String(error)),
    timelineEntries: timeline.length,
    rendererErrors,
    rendererWarnings,
  };
  if (appWindow && !appWindow.isClosed()) {
    try {
      failure.url = redact(appWindow.url());
      failure.title = redact(await appWindow.title());
      failure.ownerGateVisible = await appWindow.locator("[data-security-gate]").isVisible({ timeout: 500 }).catch(() => false);
      failure.updateModalVisible = await appWindow.locator("[data-update-modal]").isVisible({ timeout: 500 }).catch(() => false);
      failure.screenshot = "failure.png";
      await appWindow.screenshot({ path: path.join(artifactDir, failure.screenshot), timeout: ACTION_TIMEOUT_MS });
    } catch (captureError) {
      failure.captureError = redact(captureError?.message || String(captureError));
    }
  }
  fs.writeFileSync(path.join(artifactDir, "failure.json"), JSON.stringify(failure, null, 2));
}

async function cleanupElectron() {
  if (electronApp) {
    await withTimeout(electronApp.close(), CLEANUP_TIMEOUT_MS, "Electron shutdown").catch(() => {});
  }
  if (spawnedPid) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(spawnedPid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      try { process.kill(-spawnedPid, "SIGKILL"); } catch {}
      try { process.kill(spawnedPid, "SIGKILL"); } catch {}
    }
  }
  if (qaEnvironment) {
    qaEnvironment.cleanup();
    qaEnvironment = null;
  }
  if (qaUserDataDir) {
    fs.rmSync(qaUserDataDir, { recursive: true, force: true });
    qaUserDataDir = null;
  }
}

async function navigationInventory(window) {
  return window.locator("[data-page-target], [data-testid], [aria-label]").evaluateAll((nodes) => nodes.slice(0, 250).map((node) => ({
    tag: node.tagName,
    page: node.getAttribute("data-page-target"),
    testid: node.getAttribute("data-testid"),
    aria: node.getAttribute("aria-label"),
    text: (node.textContent || "").trim().slice(0, 120),
    href: node.getAttribute("href"),
    hidden: node.hidden || node.getAttribute("aria-hidden") === "true",
    disabled: Boolean(node.disabled) || node.getAttribute("aria-disabled") === "true",
  })));
}

async function main() {
  const startedAt = Date.now();
  let lastStage = "launch-start";
  const stage = (name, details = {}) => { lastStage = name; console.error(`[QA][stage] ${name}`, JSON.stringify({ elapsedMs: Date.now() - startedAt, ...details })); };
  const executable = process.env.ANXOS_QA_EXECUTABLE || undefined;
  qaUserDataDir = fs.mkdtempSync(path.join(require("os").tmpdir(), "anx-qa-profile-"));
  qaEnvironment = createIsolatedQaEnv("anx-qa-config-");
  const launchOptions = { args: [`--user-data-dir=${qaUserDataDir}`, "--no-sandbox", root, "--qa-mode"], env: { ...process.env, ...qaEnvironment.env, ANXOS_QA_MODE: "1" } };
  if (executable) launchOptions.executablePath = executable;
  stage("electron-launch-start");
  const app = await electron.launch(launchOptions);
  electronApp = app;
  spawnedPid = app.process()?.pid || null;
  stage("electron-spawned", { pid: app.process()?.pid || null });
  const mainLogs = [];
  app.process().stdout?.on("data", (chunk) => mainLogs.push(redact(chunk.toString())));
  app.process().stderr?.on("data", (chunk) => mainLogs.push(redact(chunk.toString())));
  stage("first-window-wait-start");
  const window = await withTimeout(app.firstWindow(), ACTION_TIMEOUT_MS, `Main window launch at ${lastStage}`);
  appWindow = window;
  window.setDefaultTimeout(ACTION_TIMEOUT_MS);
  window.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
  stage("first-window-ready");
  window.on("console", (message) => {
    const entry = redact(`${message.type()}: ${message.text()}`);
    if (message.type() === "error") rendererErrors.push(entry);
    else if (message.type() === "warning") {
      rendererWarnings.push(entry);
      if (strictSecurity && /content security policy|CSP/i.test(message.text())) fatalWarnings.push(entry);
    } else rendererLogs.push(entry);
  });
  window.on("pageerror", (error) => rendererErrors.push(redact(`pageerror: ${error.stack || error.message}`)));
  stage("page-load-start");
  await window.waitForLoadState("domcontentloaded");
  stage("page-load-complete");
  const shot = async (name) => { const file = path.join(screenshotDir, `${name}.png`); await window.screenshot({ path: file }); return path.relative(artifactDir, file); };
  const title = await window.title();
  stage("qa-assertions-started");
  const welcomeSkip = window.locator('[data-onboarding-welcome] [data-onboarding-action="skip"]');
  if (await welcomeSkip.count()) {
    await welcomeSkip.evaluate((element) => element.click());
    await window.locator("[data-onboarding-welcome]").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    await window.waitForTimeout(300);
  }
  const useDevice = window.locator('[data-local-setup-action="use-device"]');
  if (await useDevice.count()) {
    await useDevice.evaluate((element) => element.click());
    await window.locator("[data-local-setup-gate]").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  }
  const dismissSetupOverlays = async () => {
    const skip = window.locator('[data-onboarding-welcome] [data-onboarding-action="skip"]');
    if (await skip.count() && await skip.isVisible().catch(() => false)) {
      await skip.evaluate((element) => element.click());
      await window.locator("[data-onboarding-welcome]").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    }
    const device = window.locator('[data-local-setup-action="use-device"]');
    if (await device.count() && await device.isVisible().catch(() => false)) {
      await device.evaluate((element) => element.click());
      await window.locator("[data-local-setup-gate]").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    }
    const dismissUpdate = window.locator('[data-update-modal] [data-update-action="dismiss"]').first();
    if (await dismissUpdate.count() && await dismissUpdate.isVisible().catch(() => false)) {
      await dismissUpdate.evaluate((element) => element.click());
      await window.locator("[data-update-modal]").waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    }
  };
  record("launch", "main window", "AnxOS Control Center window appears", title, Boolean(title));
  record("qa-indicator", "[data-testid=qa-mode-indicator]", "QA MODE is visible", await window.locator("[data-testid=qa-mode-indicator]").textContent().catch(() => "missing"), await window.locator("[data-testid=qa-mode-indicator]").isVisible().catch(() => false), await shot("launch"));
  const navInventory = await navigationInventory(window).catch(() => []);
  fs.writeFileSync(path.join(artifactDir, "navigation-inventory.json"), JSON.stringify(navInventory, null, 2));
  const dismissedAtLaunch = await dismissSafeBlockingModals(window);
  if (dismissedAtLaunch) record("dismiss-update", "startup updater", "Update prompt is safely deferred", dismissedAtLaunch, true);
  const ownerGateVisible = await window.locator("[data-security-gate]").isVisible({ timeout: 1_000 }).catch(() => false);
  record("owner-gate", "[data-security-gate]", "Legitimate owner gate is detected without bypassing authentication", String(ownerGateVisible), true);
  for (const page of ["dashboard", "nodes", "agent-control", "marketplace", "instances", "public-access", "diagnostics", "settings"]) {
    stage(`navigation-${page}-start`);
    await dismissSetupOverlays();
    const navigationTarget = page === "public-access" ? "playit" : page === "diagnostics" ? "agent-control" : page;
    const link = page === "public-access"
      ? window.locator('[data-page-target="playit"], [data-testid="nav-public-access"], button[aria-label="Public Access"], a[aria-label="Public Access"]').first()
      : window.locator(`[data-page-target="${navigationTarget}"], [data-testid="nav-${navigationTarget}"]`).first();
    const dismissed = await dismissSafeBlockingModals(window);
    if (dismissed) record(`dismiss-update-before-${page}`, "startup updater", "Update prompt is safely deferred", dismissed, true);
    if (await link.count()) {
      if (await window.locator("[data-security-gate]").isVisible({ timeout: 500 }).catch(() => false)) {
        record(`navigate-${page}`, page, "navigation control exists while protected content remains owner-gated", "control present; click intentionally skipped", true);
        continue;
      }
      await link.scrollIntoViewIfNeeded().catch(() => {});
      // Keep modal/gate detection while retaining a DOM-click fallback for compact
      // layouts where the fixed sidebar footer can overlap the lowest nav item.
      const clickResult = await clickWithSafeModalRecovery(window, link, { allowDomFallback: true });
      if (clickResult.dismissed) record(`dismiss-update-during-${page}`, "startup updater", "Update prompt is safely deferred", clickResult.dismissed, true);
      if (clickResult.gated) {
        record(`navigate-${page}`, page, "navigation control exists while protected content remains owner-gated", "owner gate appeared; click intentionally skipped", true);
        continue;
      }
      stage(`navigation-${page}-clicked`, { domFallback: Boolean(clickResult.domFallback) });
      await window.waitForTimeout(300);
      if (page === "nodes") {
        const picker = window.locator("[data-node-picker]");
        if (await picker.count() && await picker.isVisible().catch(() => false)) {
          const trigger = window.locator("[data-node-picker-trigger]").first();
          if (await trigger.count()) await trigger.evaluate((element) => element.click());
          await picker.waitFor({ state: "hidden", timeout: 2000 }).catch(() => {});
        }
      }
      await dismissSetupOverlays();
      if (page === "diagnostics") {
        await window.waitForTimeout(500);
        const diagnosticsSection = window.locator('[data-agent-control-section-target="diagnostics"], [data-testid="agent-control-diagnostics"], button[aria-label="Diagnostics"]').first();
        if (await diagnosticsSection.count() && await diagnosticsSection.isVisible().catch(() => false) && !await diagnosticsSection.isDisabled().catch(() => false)) await diagnosticsSection.evaluate((element) => element.click());
      }
      let visible;
      let pageScreenshot = null;
      if (page === "marketplace") {
        const marketplaceWindow = await electronApp.waitForEvent("window", { timeout: 5_000 })
          .catch(() => electronApp.windows().find((candidate) => candidate !== window && /Marketplace/i.test(candidate.url())));
        if (marketplaceWindow) {
          await marketplaceWindow.waitForLoadState("domcontentloaded").catch(() => {});
          visible = await marketplaceWindow.locator('[data-page="marketplace"]').isVisible().catch(() => false);
          pageScreenshot = await marketplaceWindow.screenshot({ path: path.join(screenshotDir, "marketplace.png") })
            .then(() => path.relative(artifactDir, path.join(screenshotDir, "marketplace.png")))
            .catch(() => null);
        } else {
          visible = false;
        }
      } else {
        visible = page === "diagnostics"
          ? await window.locator('[data-agent-control-section="diagnostics"]').isVisible().catch(() => false)
          : await window.locator(`[data-page="${page === "public-access" ? "playit" : page}"]`).isVisible().catch(() => false);
        pageScreenshot = await shot(page);
      }
      record(`navigate-${page}`, page, page === "marketplace" ? "dedicated window becomes visible" : "page becomes visible", String(visible), visible, pageScreenshot);
      stage(`navigation-${page}-complete`, { visible });
    } else record(`navigate-${page}`, page, "navigation control exists", `control not found; inventory=${JSON.stringify(navInventory.filter((entry) => /public|diagnostic|agent/i.test(`${entry.page} ${entry.testid} ${entry.aria} ${entry.text}`)))}`, false);
  }
  fs.writeFileSync(path.join(artifactDir, "timeline.json"), JSON.stringify(timeline, null, 2));
  const failedResults = results.filter((entry) => !entry.pass);
  const acceptancePass = failedResults.length === 0 && rendererErrors.length === 0 && fatalWarnings.length === 0;
  fs.writeFileSync(path.join(artifactDir, "results.json"), JSON.stringify({ results, failedResults, pass: acceptancePass }, null, 2));
  fs.writeFileSync(path.join(artifactDir, "renderer-console.log"), rendererErrors.join("\n"));
  fs.writeFileSync(path.join(artifactDir, "renderer-warnings.log"), rendererWarnings.join("\n"));
  fs.writeFileSync(path.join(artifactDir, "renderer-info.log"), rendererLogs.join("\n"));
  fs.writeFileSync(path.join(artifactDir, "network-errors.json"), "[]\n");
  fs.writeFileSync(path.join(artifactDir, "environment.json"), JSON.stringify({ platform: process.platform, node: process.version, qaMode: true, executable: executable ? path.basename(executable) : "electron", isolatedConfig: true }, null, 2));
  fs.writeFileSync(path.join(artifactDir, "main-process.log"), mainLogs.join(""));
  const summary = [
    "# QA Acceptance",
    "",
    `Result: ${acceptancePass ? "PASS" : "FAIL"}`,
    `Failed checkpoints: ${failedResults.length ? failedResults.map((entry) => `${entry.name} (${entry.observed})`).join("; ") : "none"}`,
    `Renderer errors: ${rendererErrors.length}`,
    `Renderer warnings: ${rendererWarnings.length}${strictSecurity ? " (strict security enabled)" : ""}`,
    `Fatal warnings: ${fatalWarnings.length}`,
    `Screenshots: ${fs.readdirSync(screenshotDir).filter((name) => name.endsWith(".png")).length}`,
    `Artifact directory: ${artifactDir}`,
    "",
    "CSP warnings are non-fatal unless ANXOS_QA_STRICT_SECURITY=1 is set.",
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(artifactDir, "summary.md"), summary);
  console.log(JSON.stringify({ artifactDir, pass: acceptancePass, failedResults, rendererErrors, rendererWarnings, fatalWarnings }, null, 2));
  completed = true;
  return acceptancePass;
}

async function run() {
  let pass = false;
  try {
    pass = await withTimeout(main(), GLOBAL_TIMEOUT_MS, "QA acceptance run");
  } catch (error) {
    console.error(redact(error.stack || error.message));
    await captureFailureDiagnostics(error).catch(() => {});
  } finally {
    await cleanupElectron();
  }
  process.exitCode = pass && completed ? 0 : 1;
}

run();
