#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const preload = fs.readFileSync(path.join(root, "preload.js"), "utf8");
const ipc = fs.readFileSync(path.join(root, "src", "ipc", "accountAuthIpc.js"), "utf8");

assert(app.includes("let accountRestorationResolved = false;"), "Renderer must track unresolved account restoration.");
assert(app.includes("accountRestorationResolved && securityState.setupRequired"), "First Experience must wait for account restoration before rendering.");
assert(app.includes("accountRefreshGeneration"), "Renderer must guard account refreshes against stale async results.");
assert(app.includes("let onboardingOpenGeneration = 0;"), "Renderer must guard delayed onboarding opens against stale auth decisions.");
assert(app.includes("function shouldRequireAccountBeforeOnboarding()"), "Renderer must define account-before-onboarding requirements.");
assert(app.includes("function shouldBlockOnboardingForAccount()"), "Renderer must block onboarding while account state requires sign-in.");
assert(app.includes("!shouldBlockOnboardingForAccount()"), "Onboarding welcome must not be eligible before auth is resolved.");
assert(app.includes("setOnboardingWelcomeVisible(false);") && app.includes("setOnboardingWizardVisible(false);"), "Auth state rendering must close onboarding when sign-in is required.");
assert(app.includes("async function bootstrapApplication()"), "Renderer must bootstrap account/security before default routing.");

const bootstrap = app.slice(app.indexOf("async function bootstrapApplication()"), app.indexOf("function renderSecurityState()"));
assert(bootstrap.indexOf("await refreshAccountState({ restore: true })") >= 0, "Bootstrap must restore the account session first.");
assert(bootstrap.indexOf("await refreshSecurityState()") > bootstrap.indexOf("await refreshAccountState({ restore: true })"), "Bootstrap must resolve security after account restoration.");
assert(bootstrap.indexOf("applySettings(storedSettings, { openDefaultPage: true })") > bootstrap.indexOf("await refreshSecurityState()"), "Default page routing must wait for auth and security decisions.");

const startup = app.slice(app.indexOf("loadSettings();"), app.indexOf("registerRefreshTask(updateLocalTime"));
assert(startup.includes("bootstrapApplication();"), "Startup must use the sequenced bootstrap function.");
assert(!startup.includes("refreshAccountState();\nrefreshSecurityState();"), "Startup must not restore account/security in parallel.");
assert(preload.includes("restore: () => invokeAccount(\"account:restore\")"), "Preload must expose bounded account restoration.");
assert(ipc.includes("account:restore"), "IPC must expose bounded account restoration.");

console.log("Bootstrap auth order smoke checks passed.");
