const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-onboarding-smoke-"));
process.env.ANXHUB_CONFIG_DIR = path.join(tempRoot, "config");

const prefs = require("../src/services/settingsPreferenceService");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const packageJson = fs.readFileSync(path.join(root, "package.json"), "utf8");
const settingsIpc = fs.readFileSync(path.join(root, "src", "ipc", "settingsIpc.js"), "utf8");

try {
  const initial = prefs.readPreferences();
  assert.strictEqual(initial.settings["onboarding.started"], false, "Onboarding should not start by default.");
  assert.strictEqual(initial.settings["onboarding.completed"], false, "Onboarding should not be completed by default.");
  assert.strictEqual(initial.settings["onboarding.currentStep"], "welcome", "Onboarding should start at the welcome step.");
  assert.strictEqual(initial.settings["onboarding.setupType"], "this-pc", "Onboarding should default to This PC setup.");
  assert.strictEqual(initial.settings["onboarding.usageSelections"], "", "Onboarding usage choices should default empty.");
  assert.strictEqual(initial.settings["onboarding.skipped"], false, "Onboarding should not be skipped by default.");
  assert.strictEqual(initial.settings["onboarding.welcomeGuidance"], true, "Welcome guidance should default on.");
  assert.strictEqual(initial.settings["onboarding.contextualTips"], true, "Contextual tips should default on.");
  assert.strictEqual(initial.settings["guidance.pageIntroductions"], true, "Page introductions should default on.");
  assert.strictEqual(initial.settings["guidance.dismissedTips"], "", "Dismissed contextual tips should default empty.");
  assert.strictEqual(initial.settings["interface.guidedMode"], true, "Clean first launch should enable Guided Mode.");
  assert.strictEqual(initial.settings["interface.advancedMode"], false, "Advanced Mode should default off.");
  assert.strictEqual(initial.settings["onboarding.version"], prefs.ONBOARDING_VERSION, "Onboarding version should be persisted.");

  const skipped = prefs.updatePreferences({
    "onboarding.started": false,
    "onboarding.completed": false,
    "onboarding.currentStep": "welcome",
    "onboarding.setupType": "remote",
    "onboarding.skipped": true,
    "onboarding.welcomeGuidance": true,
    "onboarding.contextualTips": true,
  });
  assert.strictEqual(skipped.settings["onboarding.skipped"], true, "Skipped onboarding state should persist.");
  assert.strictEqual(skipped.settings["onboarding.setupType"], "remote", "Skipped onboarding should preserve the selected setup type.");

  const completed = prefs.updatePreferences({
    "onboarding.started": true,
    "onboarding.completed": true,
    "onboarding.currentStep": "complete",
    "onboarding.setupType": "both",
    "onboarding.skipped": false,
  });
  assert.strictEqual(completed.settings["onboarding.completed"], true, "Completed onboarding state should persist.");
  assert.strictEqual(completed.settings["onboarding.currentStep"], "complete", "Current onboarding step should persist.");

  fs.writeFileSync(prefs.getSettingsPath(), "{not valid json");
  assert.throws(
    () => prefs.readPreferences(),
    (error) => error?.code === "SETTINGS_STORE_CORRUPT",
    "Malformed onboarding settings must fail safely without silently discarding user configuration.",
  );
  assert.strictEqual(fs.readFileSync(prefs.getSettingsPath(), "utf8"), "{not valid json", "Malformed settings must remain available for recovery.");

  [
    "data-onboarding-welcome",
    "Welcome to AnxOS Control Center",
    "Manage your servers, applications, files, containers, remote systems, and public access from one place.",
    "Manage local and remote systems",
    "Install and control servers",
    "Monitor health and services",
    'data-onboarding-action="start"',
    'data-onboarding-action="skip"',
    'data-onboarding-action="restart"',
    'data-onboarding-action="reset"',
    "data-onboarding-wizard",
    "data-onboarding-wizard-progress",
    "data-onboarding-wizard-body",
    'data-onboarding-wizard-action="back"',
    'data-onboarding-wizard-action="continue"',
    'data-onboarding-wizard-action="finish"',
    'data-setting="onboarding.welcomeGuidance"',
    'data-setting="onboarding.contextualTips"',
    'data-setting="guidance.pageIntroductions"',
    'data-setting="interface.guidedMode"',
    'data-setting="interface.advancedMode"',
    "Help and Learning",
    "data-contextual-help-modal",
    "data-help-topic=\"agent\"",
    "data-help-action=\"reset-tips\"",
    "data-setup-health-center",
    "data-setup-health=\"coreProgress\"",
    "data-setup-health=\"optionalProgress\"",
    "data-setup-health-action=\"continue\"",
    "Create Your First Server",
  ].forEach((needle) => assert(index.includes(needle), `Onboarding UI missing: ${needle}`));

  [
    "ONBOARDING_STEPS",
    "ONBOARDING_SETUP_TYPES",
    "Use This PC",
    "Connect a Remote Server",
    "Configure Both",
    "Sign In",
    "Local Owner",
    "Connect Local Agent",
    "Prepare Node",
    "Create First Server",
    "Configure Public Access",
    "Finish Setup",
    "shouldShowOnboardingWelcome",
    "maybeOpenOnboardingWelcome",
    "getExistingSetupEvidence",
    "shouldRepairOnboardingForExistingSetup",
    "reconcileOnboardingForExistingSetup",
    "setOnboardingWizardVisible",
    "renderOnboardingWizard",
    "renderOnboardingSetupTypeStep",
    "renderOnboardingPrepareThisPcStep",
    "renderOnboardingInstallLocalAgentStep",
    "renderOnboardingPairSecurelyStep",
    "renderOnboardingDependenciesStep",
    "renderOnboardingStorageStep",
    "renderOnboardingSignInStep",
    "renderOnboardingLocalOwnerStep",
    "renderOnboardingConnectAgentStep",
    "renderOnboardingPrepareNodeStep",
    "renderOnboardingFirstServerStep",
    "renderOnboardingPublicAccessStep",
    "renderOnboardingRemoteSummary",
    "handleOnboardingWizardFinish",
    "PAGE_INTRODUCTIONS",
    "ensurePageIntroductions",
    "applyPageIntroductionPreference",
    "Do not show page introductions",
    "CONTEXTUAL_HELP_TOPICS",
    "openContextualHelp",
    "dismissContextualHelpTip",
    "resetDismissedContextualTips",
    "confirmDestructiveAction",
    "document.documentElement.dataset.guidedMode",
    "document.documentElement.dataset.advancedMode",
    "The Agent runs on a managed computer",
    "A system is a Windows or Linux computer connected to AnxOS.",
    "api.pairLocalAgent({ rotate: false",
    "api.installLocalAgent({ autoStart: true, installService: true })",
    "runDependencyAction(\"check\")",
    "setNodeModalVisible(true)",
    "handleOnboardingAction",
    "setOnboardingWelcomeVisible",
    '"onboarding.completed": true',
    '"onboarding.skipped": true',
    '"onboarding.started": true',
    '"onboarding.currentStep": "welcome"',
    '"onboarding.setupType": "this-pc"',
    "activateModal(onboardingWelcomeModal",
    "activateModal(onboardingWizardModal",
    "[Onboarding] Starting setup from welcome screen.",
    "Setup started, but preferences could not be saved.",
    "if (getDesktopApiState().hasAccount)",
    "await startAnxOsAccountLogin();",
    "function getSetupHealthState",
    "Essential",
    "Recommended",
    "Optional",
    "getPublicAccessSetupReadiness",
    "Configured, not checked",
    "state.optional.length",
    "function renderAgentBeginnerSummary",
    "Local AnxOS Agent",
    "Remote Agents are listed separately from this computer.",
    "service.supported === false",
    "localAgent.lifecycleSupported === false",
    "FRIENDLY_ERROR_DEFINITIONS",
    "Copy Technical Details",
    "normalizeFriendlyError",
    "openFirstServerGuide",
    'openMarketplaceWizard(templateId, { source: "manual" })',
    "first-server-guide-title",
    "first-server-guide-description",
  ].forEach((needle) => assert(app.includes(needle), `Onboarding renderer wiring missing: ${needle}`));

  assert(app.includes("Unable to confirm"), "Wizard should use Unable to confirm instead of fake ready states.");
  ["sign-in", "local-owner", "connect-agent", "prepare-node", "first-server", "public-access", "finish"].forEach((stepId) => {
    assert(app.includes(`id: "${stepId}"`), `Guided setup step missing: ${stepId}`);
  });
  assert(app.includes("marker.dataset.state = visualState"), "Setup progress must expose completed, current, blocked, optional, and upcoming states.");
  assert(app.includes('appendOnboardingPageAction(actions, "Configure Public Access", "playit")'), "Public Access setup must deep-link to the provider workflow.");
  assert(app.includes("Object.entries(patch || {}).filter(([key]) => isSettingKeyAuthorized(key))"), "Onboarding preference saves should send only the requested patch so pre-sign-in writes remain narrowly scoped.");
  assert(app.includes("No dependency check has completed yet"), "Wizard dependency step should not invent dependency results.");
  assert(app.includes("settings[\"onboarding.started\"] === true"), "Interrupted onboarding should resume the saved wizard step.");
  assert(app.includes("setupDetectionResolved &&"), "First Launch must stay hidden while existing setup detection is pending.");
  assert(app.includes("securityState.setupRequired === false"), "An existing local owner must bypass stale First Launch state.");
  assert(app.includes("securityState.persistentSession === true"), "A remembered local session must count as existing setup evidence.");
  assert(app.includes("accountState.canRefresh === true"), "A restorable account session must count as existing setup evidence.");
  assert(app.includes("configuredNodeCount > 0"), "Persisted nodes must count as existing setup evidence.");
  assert(app.includes('"onboarding.currentStep": "complete"'), "Upgrade reconciliation must persist a completed onboarding state.");
  assert(app.includes("No servers yet") && app.includes("Only this computer is connected"), "Dashboard empty states should give clear first steps.");
  assert(app.includes("The Agent is not responding.") && app.includes("Check that the Agent is running, then try again."), "Common backend errors should have friendly mappings.");
  assert(app.includes("copyNotificationDetails") && app.includes("notification.technicalDetails"), "Copied technical details should use the structured notification details path.");
  assert(!app.includes("Something went wrong"), "Raw vague error copy must not be the only user-facing error fallback.");
  assert(!app.includes("Agent marked not installed only because unreachable"), "Static guard should not rely on explanatory placeholder text.");

  assert(styles.includes(".app-modal--welcome"), "Welcome modal CSS should be scoped.");
  assert(styles.includes(".app-modal--onboarding-wizard"), "Wizard modal CSS should be scoped.");
  assert(styles.includes(".app-modal--contextual-help"), "Contextual help modal CSS should be scoped.");
  assert(styles.includes(".help-topic-grid"), "Help topic grid CSS should exist.");
  assert(styles.includes(".onboarding-step-track"), "Wizard step tracker CSS should exist.");
  assert(styles.includes(".onboarding-feature-grid"), "Welcome feature grid CSS should exist.");
  assert(styles.includes(".dashboard-setup-health"), "Setup Health center CSS should exist.");
  assert(styles.includes(".first-server-card:focus-visible"), "First-server guide cards should have visible keyboard focus.");
  assert(styles.includes("@media (prefers-reduced-motion: reduce)"), "Reduced-motion users should be respected.");
  assert(packageJson.includes('"onboarding:smoke"'), "package.json should expose onboarding smoke command.");
  assert(settingsIpc.includes("isOnboardingPreferenceUpdate(settings)"), "Onboarding-only preference writes should remain available before sign-in.");
  assert(settingsIpc.includes('key.startsWith("onboarding.") || key.startsWith("guidance.")'), "The pre-sign-in preference exception must stay narrowly scoped to onboarding and guidance keys.");

  console.log("Onboarding smoke checks passed.");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
