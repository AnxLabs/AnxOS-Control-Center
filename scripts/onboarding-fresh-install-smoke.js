// Onboarding Fresh Install Smoke
//
// Closes the campaign acceptance item "Onboarding on a fresh install - NOT VERIFIED"
// (docs/v2/V2_CAMPAIGN_QUEUES.md, cycle-25 acceptance queue). `qa:acceptance`
// handles onboarding defensively: it dismisses the welcome and asserts nothing
// about it, so the cycle-21 fix to `renderOnboardingFirstServerStep` (the
// "Create First Server" step rendered an empty, permanently stuck wizard body
// because it read the undeclared `instancesState`) had no runtime coverage.
//
// This harness boots the real Electron app against a genuinely empty, isolated
// profile (the launch recipe is copied from scripts/qa-acceptance.js) and walks
// the complete first-run flow: welcome -> 7 wizard steps -> finish -> settings
// persistence -> dashboard. Any failed check, renderer console error, or renderer
// page error fails the run.
//
// Run: node scripts/onboarding-fresh-install-smoke.js
// Artifacts: artifacts/onboarding/<ISO-timestamp>/

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");

const root = path.resolve(__dirname, "..");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = path.join(root, "artifacts", "onboarding", timestamp);
fs.mkdirSync(artifactDir, { recursive: true });

const ACTION_TIMEOUT_MS = 8_000;
const WELCOME_TIMEOUT_MS = 15_000;
const TOAST_TIMEOUT_MS = 3_000;
const PREFERENCES_POLL_MS = 3_000;
const GLOBAL_TIMEOUT_MS = 240_000;
const CLEANUP_TIMEOUT_MS = 12_000;

const WELCOME_TITLE = "Welcome to AnxOS Control Center";
const STEP_EXPECTATIONS = [
  { index: 1, id: "sign-in", title: "Sign In" },
  { index: 2, id: "local-owner", title: "Local Owner" },
  { index: 3, id: "connect-agent", title: "Connect Local Agent" },
  { index: 4, id: "prepare-node", title: "Prepare Node" },
  { index: 5, id: "first-server", title: "Create First Server" },
  { index: 6, id: "public-access", title: "Configure Public Access" },
  { index: 7, id: "finish", title: "Finish Setup" },
];

const startedAt = new Date().toISOString();
const checks = [];
const consoleErrors = [];
const pageErrors = [];
const mainLogs = [];
let electronApp = null;
let appWindow = null;
let spawnedPid = null;
let qaEnvironment = null;
let qaUserDataDir = null;

const redact = (value) => String(value || "").replace(/(authorization|token|password|secret|api[_-]?key|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");

function recordCheck(name, pass, observed) {
  checks.push({ name, pass: pass === true, observed: redact(observed) });
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
    fs.rmSync(qaUserDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    qaUserDataDir = null;
  }
}

async function readStartupDiagnostics(window) {
  return window.evaluate(() => {
    const isVisible = (node) => Boolean(node) && !node.hidden && getComputedStyle(node).display !== "none" && getComputedStyle(node).visibility !== "hidden";
    const gateState = {};
    try { if (typeof shouldBlockOnboardingForAccount === "function") gateState.blocksOnboardingForAccount = shouldBlockOnboardingForAccount(); } catch (error) { gateState.blocksError = String(error?.message || error); }
    try { if (typeof shouldRequireAccountBeforeOnboarding === "function") gateState.requiresAccountBeforeOnboarding = shouldRequireAccountBeforeOnboarding(); } catch {}
    try { if (typeof shouldShowOnboardingWelcome === "function") gateState.shouldShowOnboardingWelcome = shouldShowOnboardingWelcome(); } catch {}
    let account = "unavailable";
    try {
      if (typeof accountState !== "undefined") {
        account = {
          authenticated: accountState.authenticated === true,
          configured: accountState.configured,
          state: accountState.state || null,
          restorationState: accountState.restorationState || null,
        };
      }
    } catch {}
    const settings = (() => { try { return JSON.parse(localStorage.getItem("anxos.settings.v1") || "null"); } catch { return null; } })();
    return {
      welcomeHidden: document.querySelector("[data-onboarding-welcome]")?.hidden ?? "missing",
      wizardHidden: document.querySelector("[data-onboarding-wizard]")?.hidden ?? "missing",
      localSetupGateVisible: isVisible(document.querySelector("[data-local-setup-gate]")),
      securityGateVisible: isVisible(document.querySelector("[data-security-gate]")),
      accountMessage: document.querySelector("[data-account-message]")?.textContent || "",
      accountState: account,
      gates: gateState,
      onboardingSettings: settings && typeof settings === "object"
        ? Object.fromEntries(Object.entries(settings).filter(([key]) => key.startsWith("onboarding.")))
        : settings,
    };
  }).catch((error) => ({ diagnosticsError: String(error?.message || error) }));
}

async function readWizardState(window) {
  return window.evaluate(() => {
    const progress = document.querySelector("[data-onboarding-wizard-progress]");
    const title = document.querySelector("[data-onboarding-wizard-title]");
    const body = document.querySelector("[data-onboarding-wizard-body]");
    const continueButton = document.querySelector('[data-onboarding-wizard-action="continue"]');
    const finishButton = document.querySelector('[data-onboarding-wizard-action="finish"]');
    const wizard = document.querySelector("[data-onboarding-wizard]");
    return {
      progress: progress ? progress.textContent.trim() : "",
      title: title ? title.textContent.trim() : "",
      bodyLength: body ? (body.textContent || "").trim().length : 0,
      continueHidden: continueButton ? continueButton.hidden : true,
      continueDisabled: continueButton ? continueButton.disabled : true,
      finishHidden: finishButton ? finishButton.hidden : true,
      finishDisabled: finishButton ? finishButton.disabled : true,
      wizardHidden: wizard ? wizard.hidden : true,
    };
  });
}

function findPreferencesFile(configDir) {
  const expected = path.join(configDir, "preferences.json");
  if (fs.existsSync(expected)) return { filePath: expected, location: "expected" };
  const stack = [configDir];
  const seen = [];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      seen.push(path.relative(configDir, full));
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "preferences.json") return { filePath: full, location: "found-by-search", seen };
    }
  }
  return { filePath: null, location: "not-found", seen };
}

function readPreferencesOnboardingCompleted(configDir) {
  const { filePath, location, seen } = findPreferencesFile(configDir);
  if (!filePath) {
    return { found: false, location, completed: false, observed: `preferences.json not found under ${configDir}; entries=${JSON.stringify(seen.slice(0, 40))}` };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const settings = raw && typeof raw === "object" && raw.settings && typeof raw.settings === "object" ? raw.settings : raw;
    return { found: true, location, filePath, completed: settings?.["onboarding.completed"] === true, observed: `${path.relative(root, filePath)} (${location}) onboarding.completed=${String(settings?.["onboarding.completed"])}` };
  } catch (error) {
    return { found: true, location, filePath, completed: false, observed: `${path.relative(root, filePath)} (${location}) unreadable: ${redact(error?.message || error)}` };
  }
}

async function captureFailureScreenshot(name) {
  if (!appWindow || appWindow.isClosed()) return null;
  try {
    await appWindow.screenshot({ path: path.join(artifactDir, name), timeout: ACTION_TIMEOUT_MS });
    return name;
  } catch {
    return null;
  }
}

async function main() {
  const stage = (name) => console.error(`[onboarding-smoke][stage] ${name} (${Date.now() - startMs}ms)`);
  const startMs = Date.now();

  qaUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-qa-onboarding-profile-"));
  qaEnvironment = createIsolatedQaEnv("anx-qa-onboarding-config-");
  stage("electron-launch-start");
  const app = await electron.launch({
    args: [`--user-data-dir=${qaUserDataDir}`, "--no-sandbox", root, "--qa-mode"],
    env: { ...process.env, ...qaEnvironment.env, ANXOS_QA_MODE: "1" },
  });
  electronApp = app;
  spawnedPid = app.process()?.pid || null;
  app.process().stdout?.on("data", (chunk) => mainLogs.push(redact(chunk.toString())));
  app.process().stderr?.on("data", (chunk) => mainLogs.push(redact(chunk.toString())));
  const window = await withTimeout(app.firstWindow(), ACTION_TIMEOUT_MS, "Main window launch");
  appWindow = window;
  window.setDefaultTimeout(ACTION_TIMEOUT_MS);
  window.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
  window.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(redact(message.text()));
  });
  window.on("pageerror", (error) => pageErrors.push(redact(error.stack || error.message)));
  await window.waitForLoadState("domcontentloaded");
  stage("window-ready");

  const shot = async (name) => {
    await window.screenshot({ path: path.join(artifactDir, name), timeout: ACTION_TIMEOUT_MS });
    return name;
  };

  // 1-3: welcome modal.
  const welcome = window.locator("[data-onboarding-welcome]");
  let welcomeVisible = false;
  try {
    await welcome.waitFor({ state: "visible", timeout: WELCOME_TIMEOUT_MS });
    welcomeVisible = true;
  } catch {}
  if (welcomeVisible) {
    await shot("onboarding-welcome.png").catch(() => {});
    recordCheck("onboarding-welcome-visible", true, `welcome modal visible within ${WELCOME_TIMEOUT_MS}ms of launch`);
  } else {
    const diagnostics = await readStartupDiagnostics(window);
    recordCheck("onboarding-welcome-visible", false, `welcome modal NOT visible within ${WELCOME_TIMEOUT_MS}ms; diagnostics=${JSON.stringify(diagnostics)}`);
    throw Object.assign(
      new Error(`Onboarding welcome did not become visible within ${WELCOME_TIMEOUT_MS}ms on a fresh isolated profile. Observed: ${JSON.stringify(diagnostics)}`),
      { code: "ONBOARDING_WELCOME_MISSING", diagnostics },
    );
  }

  const welcomeTitle = await window.locator("#onboarding-welcome-title").textContent().catch(() => "");
  recordCheck("onboarding-welcome-title", (welcomeTitle || "").trim() === WELCOME_TITLE, `title="${(welcomeTitle || "").trim()}"`);

  const startButton = window.locator('[data-onboarding-welcome] [data-onboarding-action="start"]');
  const skipButton = window.locator('[data-onboarding-welcome] [data-onboarding-action="skip"]');
  const startCount = await startButton.count();
  const skipCount = await skipButton.count();
  const startEnabled = startCount > 0 && await startButton.isEnabled().catch(() => false);
  const skipEnabled = skipCount > 0 && await skipButton.isEnabled().catch(() => false);
  recordCheck("onboarding-welcome-actions", startEnabled && skipEnabled, `start: count=${startCount} enabled=${startEnabled}; skip: count=${skipCount} enabled=${skipEnabled}`);
  if (!startEnabled) {
    throw Object.assign(new Error("Onboarding welcome 'Set Up AnxOS' action is missing or disabled."), { code: "ONBOARDING_START_UNAVAILABLE" });
  }

  // 4: start -> wizard step 1.
  stage("click-start");
  await startButton.click({ timeout: ACTION_TIMEOUT_MS });
  const wizard = window.locator("[data-onboarding-wizard]");
  let wizardVisible = false;
  try {
    await wizard.waitFor({ state: "visible", timeout: ACTION_TIMEOUT_MS });
    wizardVisible = true;
  } catch {}
  recordCheck("onboarding-wizard-visible", wizardVisible, wizardVisible ? "wizard modal visible after start" : "wizard modal not visible after start");
  if (!wizardVisible) {
    throw Object.assign(new Error("Onboarding wizard did not become visible after clicking 'Set Up AnxOS'."), { code: "ONBOARDING_WIZARD_MISSING" });
  }

  // 5: walk all seven steps using footer controls only. Body primary buttons on
  // steps 1/3/4 trigger account login, Local Agent install/pair and dependency
  // install, so they are never clicked.
  for (const step of STEP_EXPECTATIONS) {
    stage(`step-${step.index}-wait`);
    let stepReached = true;
    try {
      await window.waitForFunction(({ index, title }) => {
        const progress = document.querySelector("[data-onboarding-wizard-progress]");
        const titleNode = document.querySelector("[data-onboarding-wizard-title]");
        return Boolean(progress && progress.textContent.trim() === `Step ${index} of 7`
          && titleNode && titleNode.textContent.trim() === title);
      }, { index: step.index, title: step.title }, { timeout: ACTION_TIMEOUT_MS, polling: 100 });
    } catch {
      stepReached = false;
    }
    const state = await readWizardState(window);
    if (!stepReached) {
      recordCheck(`onboarding-step-${step.index}-progress`, false, `expected "Step ${step.index} of 7" with title "${step.title}"; observed progress="${state.progress}" title="${state.title}"`);
      throw Object.assign(new Error(`Wizard never reached step ${step.index} (${step.id}). Observed progress="${state.progress}" title="${state.title}".`), { code: "ONBOARDING_STEP_NOT_REACHED" });
    }
    recordCheck(`onboarding-step-${step.index}-progress`, state.progress === `Step ${step.index} of 7`, `progress="${state.progress}"`);
    recordCheck(`onboarding-step-${step.index}-title`, state.title === step.title, `title="${state.title}"`);
    recordCheck(`onboarding-step-${step.index}-body`, state.bodyLength > 0, `bodyChars=${state.bodyLength}`);
    await shot(`onboarding-step-${step.index}-${step.id}.png`);

    if (step.index < 7) {
      const continueReady = !state.continueHidden && !state.continueDisabled;
      recordCheck(`onboarding-step-${step.index}-continue`, continueReady, `continueHidden=${state.continueHidden} continueDisabled=${state.continueDisabled}`);
      if (!continueReady) {
        throw Object.assign(new Error(`Continue is not available on step ${step.index} (${step.id}).`), { code: "ONBOARDING_CONTINUE_UNAVAILABLE" });
      }
      await window.locator('[data-onboarding-wizard-action="continue"]').click({ timeout: ACTION_TIMEOUT_MS });
    } else {
      const finishReady = !state.finishHidden && !state.finishDisabled && state.continueHidden;
      recordCheck("onboarding-step-7-finish", finishReady, `finishHidden=${state.finishHidden} finishDisabled=${state.finishDisabled} continueHidden=${state.continueHidden}`);
      if (!finishReady) {
        throw Object.assign(new Error("Finish is not visible/enabled on step 7, or Continue is still visible."), { code: "ONBOARDING_FINISH_UNAVAILABLE" });
      }
      stage("click-finish");
      await window.locator('[data-onboarding-wizard-action="finish"]').click({ timeout: ACTION_TIMEOUT_MS });
    }
  }

  // 7: finish closes the wizard; toast is transient (2.2s) so capture it now.
  let wizardHidden = false;
  try {
    await wizard.waitFor({ state: "hidden", timeout: ACTION_TIMEOUT_MS });
    wizardHidden = true;
  } catch {}
  recordCheck("onboarding-finish-wizard-hidden", wizardHidden, wizardHidden ? "wizard hidden after finish" : "wizard still visible after finish");

  let toastCaptured = false;
  let toastText = "";
  try {
    await window.waitForFunction(() => {
      const node = document.querySelector("#toast");
      return Boolean(node && node.classList.contains("is-visible") && node.textContent.includes("setup guide completed"));
    }, null, { timeout: TOAST_TIMEOUT_MS, polling: 100 });
    toastCaptured = true;
  } catch {}
  toastText = await window.locator("#toast").textContent().catch(() => "");

  // 8: persistence in localStorage and the isolated config-dir preferences.json.
  const localStorageCompleted = await window.evaluate(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("anxos.settings.v1") || "null");
      return raw && typeof raw === "object" ? raw["onboarding.completed"] === true : false;
    } catch {
      return false;
    }
  }).catch(() => false);
  recordCheck("onboarding-persistence-localstorage", localStorageCompleted === true, `anxos.settings.v1 onboarding.completed=${String(localStorageCompleted)}`);

  let preferences = { completed: false, observed: "not read" };
  const preferencesDeadline = Date.now() + PREFERENCES_POLL_MS;
  do {
    preferences = readPreferencesOnboardingCompleted(qaEnvironment.configDir);
    if (preferences.completed) break;
    await window.waitForTimeout(150).catch(() => {});
  } while (Date.now() < preferencesDeadline);
  recordCheck("onboarding-persistence-preferences-json", preferences.completed === true, preferences.observed);

  if (toastCaptured && toastText.includes("setup guide completed")) {
    recordCheck("onboarding-finish-toast", true, `toast="${toastText.trim()}"`);
  } else {
    recordCheck(
      "onboarding-finish-toast",
      preferences.completed === true && localStorageCompleted === true,
      `toast not captured within ${TOAST_TIMEOUT_MS}ms (observed="${redact((toastText || "").trim())}"); fell back to settings persistence: localStorage=${String(localStorageCompleted)} preferences.json=${String(preferences.completed)}`,
    );
  }

  // 10: reach the dashboard.
  const useDevice = window.locator('[data-local-setup-action="use-device"]');
  if (await useDevice.isVisible({ timeout: 1_000 }).catch(() => false)) {
    stage("click-use-device");
    await useDevice.click({ timeout: ACTION_TIMEOUT_MS });
  }
  const dashboardVisible = await window.locator('[data-page="dashboard"]').isVisible({ timeout: ACTION_TIMEOUT_MS }).catch(() => false);
  recordCheck("onboarding-dashboard-visible", dashboardVisible, `[data-page="dashboard"] visible=${dashboardVisible}`);
  if (dashboardVisible) await shot("dashboard.png").catch(() => {});

  return checks.every((entry) => entry.pass);
}

async function run() {
  let fatalError = null;
  let pass = false;
  try {
    pass = await withTimeout(main(), GLOBAL_TIMEOUT_MS, "Onboarding fresh install smoke run");
  } catch (error) {
    fatalError = error;
    console.error(redact(error.stack || error.message));
    await captureFailureScreenshot("failure.png").catch(() => {});
  } finally {
    await cleanupElectron();
  }

  // 9: zero renderer errors across the whole run.
  recordCheck("renderer-console-errors", consoleErrors.length === 0, consoleErrors.length ? `${consoleErrors.length} error(s): ${consoleErrors.slice(0, 10).join(" | ")}` : "0 console errors");
  recordCheck("renderer-page-errors", pageErrors.length === 0, pageErrors.length ? `${pageErrors.length} page error(s): ${pageErrors.slice(0, 10).join(" | ")}` : "0 page errors");

  const failedChecks = checks.filter((entry) => !entry.pass);
  const status = failedChecks.length === 0 && !fatalError ? "PASS" : "FAIL";

  fs.writeFileSync(path.join(artifactDir, "results.json"), JSON.stringify(checks, null, 2));
  fs.writeFileSync(path.join(artifactDir, "renderer-console.log"), consoleErrors.join("\n"));
  fs.writeFileSync(path.join(artifactDir, "renderer-page-errors.log"), pageErrors.join("\n"));
  fs.writeFileSync(path.join(artifactDir, "main-process.log"), mainLogs.join(""));
  if (fatalError) {
    fs.writeFileSync(path.join(artifactDir, "failure.json"), JSON.stringify({
      timestamp: new Date().toISOString(),
      code: fatalError?.code || null,
      message: redact(fatalError?.message || String(fatalError)),
      diagnostics: fatalError?.diagnostics || null,
    }, null, 2));
  }
  const summary = [
    "# Onboarding Fresh Install Smoke",
    "",
    `Result: ${status}`,
    `Started: ${startedAt}`,
    `Finished: ${new Date().toISOString()}`,
    `Artifact directory: ${artifactDir}`,
    `Checks: ${checks.length} (failed: ${failedChecks.length})`,
    `Renderer console errors: ${consoleErrors.length}`,
    `Renderer page errors: ${pageErrors.length}`,
    "",
    "## Failed checks",
    failedChecks.length
      ? failedChecks.map((entry) => `- ${entry.name} - ${entry.observed}`).join("\n")
      : "- none",
    "",
    "## Fatal error",
    fatalError ? `- ${redact(fatalError.message || String(fatalError))}` : "- none",
    "",
    "## Notes",
    "- Fresh isolated profile: a temporary user-data dir plus isolated config/log/temp directories (removed on exit).",
    "- Launch recipe copied from scripts/qa-acceptance.js (playwright-core `_electron`, `--qa-mode`, `ANXOS_QA_MODE=1`).",
    "- Safe walk: footer Continue/Back only; body primary buttons on steps 1/3/4 (account login, Local Agent install/pair, dependency install) are never clicked.",
    failedChecks.some((entry) => /welcome|renderer/.test(entry.name))
      ? "- FAILURE EVIDENCE: on a fresh profile the onboarding welcome is gated by `shouldBlockOnboardingForAccount()` / `shouldRequireAccountBeforeOnboarding()` (app.js:37965-37983), whose only remaining job is ordering: it waits for account restoration to resolve (`isAccountRestorationPending()`). A signed-out device does not require an account, so a missing welcome is no longer explained by the account gate - inspect the gate diagnostics above, startup ordering and renderer errors instead."
      : "",
  ].join("\n") + "\n";
  fs.writeFileSync(path.join(artifactDir, "summary.md"), summary);

  console.log(JSON.stringify({ status, checks: checks.length, failed: failedChecks.map((entry) => entry.name), artifactDir }));
  process.exitCode = status === "PASS" ? 0 : 1;
}

run();
