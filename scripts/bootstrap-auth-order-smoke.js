#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const ipc = fs.readFileSync(path.join(root, "src", "ipc", "accountAuthIpc.js"), "utf8");

assert(app.includes("let accountRestorationResolved = false;"), "Renderer must track unresolved account restoration.");
assert(app.includes("let setupDetectionResolved = false;"), "Renderer must track unresolved setup detection.");
assert(app.includes("accountRestorationResolved && securityState.setupRequired"), "First Experience must wait for account restoration before rendering.");
assert(app.includes("accountRefreshGeneration"), "Renderer must guard account refreshes against stale async results.");
assert(app.includes("let onboardingOpenGeneration = 0;"), "Renderer must guard delayed onboarding opens against stale auth decisions.");
assert(app.includes("function shouldRequireAccountBeforeOnboarding()"), "Renderer must define account-before-onboarding requirements.");
assert(app.includes("function shouldBlockOnboardingForAccount()"), "Renderer must block onboarding while account state requires sign-in.");
assert(app.includes("!shouldBlockOnboardingForAccount()"), "Onboarding welcome must not be eligible before auth is resolved.");
assert(app.includes("setOnboardingWelcomeVisible(false);") && app.includes("setOnboardingWizardVisible(false);"), "Auth state rendering must close onboarding when sign-in is required.");
assert(app.includes("async function bootstrapApplication()"), "Renderer must bootstrap account/security before default routing.");
assert(app.includes("function getExistingSetupEvidence()"), "Renderer must derive upgrade evidence without deleting user configuration.");
assert(app.includes("function shouldRepairOnboardingForExistingSetup("), "Renderer must distinguish stale upgrade flags from a fresh install.");
assert(app.includes("async function reconcileOnboardingForExistingSetup("), "Renderer must repair stale onboarding state for existing installations.");

const bootstrap = app.slice(app.indexOf("async function bootstrapApplication()"), app.indexOf("function renderSecurityState()"));
assert(bootstrap.indexOf("await refreshAccountState({ restore: true })") >= 0, "Bootstrap must restore the account session first.");
assert(bootstrap.indexOf("await refreshSecurityState()") > bootstrap.indexOf("await refreshAccountState({ restore: true })"), "Bootstrap must resolve security after account restoration.");
assert(bootstrap.indexOf("await refreshNodes()") > bootstrap.indexOf("await refreshSecurityState()"), "Bootstrap must restore persisted nodes before deciding whether setup is fresh.");
assert(bootstrap.indexOf("await loadSettings({ openOnboarding: false })") > bootstrap.indexOf("await refreshNodes()"), "Settings must not open onboarding before existing-state detection finishes.");
assert(bootstrap.indexOf("await reconcileOnboardingForExistingSetup(storedSettings)") > bootstrap.indexOf("await loadSettings({ openOnboarding: false })"), "Stale onboarding flags must be reconciled after trusted state restoration.");
assert(bootstrap.indexOf("applySettings(storedSettings, { openDefaultPage: true })") > bootstrap.indexOf("await reconcileOnboardingForExistingSetup(storedSettings)"), "Default page routing must wait for auth, security, node, and onboarding decisions.");
assert(bootstrap.indexOf("maybeOpenOnboardingWelcome(storedSettings)") > bootstrap.indexOf("applySettings(storedSettings, { openDefaultPage: true })"), "First Launch must be evaluated only after restored settings are applied.");

const startup = app.slice(app.indexOf("renderOperationsCenter();"), app.indexOf("registerRefreshTask(updateLocalTime"));
assert(startup.includes("bootstrapApplication();"), "Startup must use the sequenced bootstrap function.");
assert(!startup.includes("refreshAccountState();\nrefreshSecurityState();"), "Startup must not restore account/security in parallel.");
assert(!startup.includes("loadSettings();"), "Startup must not load onboarding settings outside the sequenced bootstrap.");
assert(preload.includes("restore: () => invokeAccount(\"account:restore\")"), "Preload must expose bounded account restoration.");
assert(ipc.includes("account:restore"), "IPC must expose bounded account restoration.");

console.log("Bootstrap auth order smoke checks passed.");
