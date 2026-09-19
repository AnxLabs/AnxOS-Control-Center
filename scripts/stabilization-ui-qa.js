#!/usr/bin/env node
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");

const root = path.resolve(__dirname, "..");
const artifactDir = path.join(root, "artifacts", "qa", `stabilization-${new Date().toISOString().replace(/[:.]/g, "-")}`);
fs.mkdirSync(artifactDir, { recursive: true });

// The single QA instance fixture. It is declared here, rather than inside the
// game-config injection, because two places now need it to agree: the Files
// layout block selects it to bring the instance workspace on screen, and the
// game-config block injects it as the selected instance. A second, divergent
// literal for the same instance id is how the two blocks would silently start
// testing different things.
const QA_INSTANCE = {
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

function redacted(value) {
  return String(value || "").replace(/(token|password|secret|authorization|cookie|session)[=:]\S+/gi, "$1=[redacted]");
}

async function visible(page, selector) {
  return page.locator(selector).first().isVisible().catch(() => false);
}

// ---------------------------------------------------------------------------
// Condition-based waits.
//
// Every wait in this file used to be a fixed `page.waitForTimeout(<n>)`. A fixed
// wait in an acceptance harness that drives production behaviour is a latent
// defect, not a style choice: the literal silently bounds the very interval it
// is waiting on, so the harness — not the product — decides how fast the UI may
// settle. That had already happened here. renderer app.js debounces the game
// config search at 80 ms, and the comment at that call site says the 80 ms was
// chosen to fit inside this file's 100 ms literal: raising the debounce to the
// 120 ms every other search box in app.js uses would have turned this file red
// for no product reason. The same kind of coupling existed at launch, where the
// 1000 ms literal was the only reason the negative first-experience assertions
// below meant anything — the onboarding welcome is deliberately deferred by a
// 350 ms timer, so a slower defer would have made "no onboarding before Sign In"
// pass because nothing had been shown YET rather than because nothing is shown.
//
// The fixed waits also masked failures in the other direction. Several
// assertions here are satisfied by "the UI has not rendered yet": `.page` and
// `.instance-tab-panel` are `display: none` until they are active, and a hidden
// element measures 0x0, so "the file grid fits inside the viewport" and "this
// workspace introduces no horizontal overflow" both pass before there is
// anything to measure. A wait that stops early therefore produced a green run
// that proved nothing.
//
// The loop shape (generous budget, fast-fail when the process dies, last
// observed state in the failure message) follows the established idiom in
// scripts/test-helpers/agent-readiness.js. It is local rather than shared
// because this is the only acceptance script that drives Electron; if a second
// one needs it, it belongs in test-helpers/ beside waitForAgentReady.
//
// BUDGETS
// A condition here is a same-renderer DOM/state update that settles in single
// digit milliseconds on an idle machine, so 10 s is roughly a thousand times the
// observed latency. That slack is deliberate: the budget exists to absorb a
// frame stall or a loaded machine, not to measure the product, because a gate
// that fails for environmental reasons trains everyone to ignore it. The
// bootstrap wait gets the reference helper's 30 s because it spans process
// warm-up, account and security restore, and the first node refresh, which are
// I/O bound rather than renderer bound.
// ---------------------------------------------------------------------------
const CONDITION_BUDGET_MS = 10000;
const BOOTSTRAP_BUDGET_MS = 30000;
const CONDITION_POLL_MS = 100;
// Every wait below fails with a diagnostic naming the condition it was waiting for,
// so this watchdog exists only to catch a step that has NO budget of its own (a hang,
// a missing await). It must therefore exceed the sum of the budgets that can elapse in
// a single run — otherwise it pre-empts a diagnosable failure with an opaque
// "timed out", which is exactly what a fixed 60 s did once these waits became
// condition-based (19 waits at 10 s plus a 30 s bootstrap). Derived rather than magic
// so the two cannot silently drift apart again.
const MAX_WAIT_BUDGETS_PER_RUN = 21; // 19 waits today, plus headroom for new ones
const WATCHDOG_MS = BOOTSTRAP_BUDGET_MS + MAX_WAIT_BUDGETS_PER_RUN * CONDITION_BUDGET_MS + 30000;

async function waitForCondition(page, { label, probe, budgetMs = CONDITION_BUDGET_MS, intervalMs = CONDITION_POLL_MS, electronProcess = null }) {
  const attempts = Math.max(1, Math.ceil(budgetMs / intervalMs));
  const startedAt = Date.now();
  let lastState = "no observation recorded";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // A process that has exited can never satisfy the condition, and the polls
    // after the window closed would replace this diagnosis with a second, less
    // specific error. Same fast-fail as waitForAgentReady's dead child.
    if (electronProcess && (electronProcess.exitCode !== null || electronProcess.signalCode !== null)) {
      throw new Error(
        `${label} can never become true: the application exited (code=${electronProcess.exitCode} signal=${electronProcess.signalCode}) after ${Date.now() - startedAt} ms. Last observed state: ${lastState}`,
      );
    }
    try {
      const observation = await probe();
      lastState = redacted(observation.state);
      if (observation.ready) return observation;
    } catch (error) {
      lastState = redacted(`probe could not observe anything: ${error?.message || String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(
    `${label} did not become true within ${Date.now() - startedAt} ms of polling ` +
    `(budget ${budgetMs} ms, ${attempts} polls at ${intervalMs} ms). Last observed state: ${lastState}`,
  );
}

// Generic element-visible observation. The match count is kept for the failure
// diagnostic because "the selector matched nothing" and "it matched but is
// collapsed" are different defects and the message has to say which one it saw.
async function visibilityObservation(page, selector) {
  const state = await page.evaluate((target) => {
    const nodes = Array.from(document.querySelectorAll(target));
    const visibleCount = nodes.filter((node) => {
      if (node.hidden) return false;
      const box = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    }).length;
    return { matches: nodes.length, visibleCount };
  }, selector);
  return { ready: state.visibleCount > 0, state: `${selector} matched=${state.matches} visible=${state.visibleCount}` };
}

function securitySectionObservation(page, section) {
  return visibilityObservation(page, `[data-security-section="${section}"]`).then(async (visibleState) => {
    const context = await page.evaluate((target) => {
      const button = document.querySelector(`[data-security-section-target="${target}"]`);
      return {
        buttonFound: Boolean(button),
        ariaCurrent: button ? button.getAttribute("aria-current") : null,
        visibleSections: Array.from(document.querySelectorAll("[data-security-section]"))
          .filter((node) => {
            if (node.hidden) return false;
            const box = node.getBoundingClientRect();
            return box.width > 0 && box.height > 0;
          })
          .map((node) => node.dataset.securitySection),
      };
    }, section);
    return { ready: visibleState.ready, state: `${visibleState.state} ${JSON.stringify(context)}` };
  });
}

// "The file browser is on screen and measurable." The assertions this gates are
// about the grid's height relative to the viewport and about which element owns
// vertical scrolling, and all three of those are trivially satisfied by a
// display:none panel — so the wait has to prove the panel is laid out.
async function instanceFilesObservation(page) {
  const state = await page.evaluate(() => {
    const panel = document.querySelector('[data-instance-panel="files"]');
    const card = document.querySelector(".instance-workspace-card");
    const height = (node) => (node ? Math.round(node.getBoundingClientRect().height) : 0);
    return {
      // cardHidden is the cause of a collapsed measurement, so it belongs in the
      // state: "the workspace card is hidden because no instance is selected" and
      // "the card is shown but the grid is 0 high" are different bugs.
      cardPresent: Boolean(card),
      cardHidden: card ? card.hidden : null,
      snapshotInstanceCount: (() => {
        try {
          return window.eval("Array.isArray(latestInstancesSnapshot?.instances) ? latestInstancesSnapshot.instances.length : null");
        } catch (error) {
          return `unreadable: ${error?.message || String(error)}`;
        }
      })(),
      panelPresent: Boolean(panel),
      panelActive: panel ? panel.classList.contains("is-active") : false,
      gridHeight: height(document.querySelector(".instance-files-grid")),
      browserHeight: height(document.querySelector(".instance-file-browser")),
      editorHeight: height(document.querySelector("[data-instance-file-editor]")),
    };
  });
  return {
    ready: state.cardPresent && state.cardHidden === false && state.panelPresent && state.panelActive &&
      state.gridHeight > 0 && state.browserHeight > 0 && state.editorHeight > 0,
    state: JSON.stringify(state),
  };
}

// One observation of the whole game-config form: the debounced search query, the
// rendered/measurable field set, the dirty-state controls and the status line.
// Every game-config wait below reads this, so each failure can report the state
// of the form rather than just "it was not ready".
async function gameConfigObservation(page) {
  const state = await page.evaluate(() => {
    const read = (expression) => {
      try {
        return window.eval(expression);
      } catch (error) {
        return `unreadable: ${error?.message || String(error)}`;
      }
    };
    const fields = {};
    Array.from(document.querySelectorAll("[data-game-config-field]")).forEach((input) => {
      const wrapper = input.closest(".instance-game-config-field");
      fields[input.dataset.gameConfigField] = {
        value: input.type === "checkbox" ? Boolean(input.checked) : input.value,
        inputHeight: Math.round(input.getBoundingClientRect().height),
        wrapperHeight: wrapper ? Math.round(wrapper.getBoundingClientRect().height) : 0,
      };
    });
    const saveRestart = document.querySelector("[data-game-config-save-restart]");
    const resetCurrent = document.querySelector("[data-game-config-reset-current]");
    const status = document.querySelector("[data-game-config-status]");
    return {
      query: read("gameConfigState.query"),
      showAdvanced: read("gameConfigState.showAdvanced"),
      activeCategory: document.querySelector(".instance-game-config-section.is-active")?.textContent || "",
      categories: Array.from(document.querySelectorAll(".instance-game-config-section")).map((button) => button.textContent),
      // The panel renders ONE category at a time (`getActiveGameConfigFields`
      // filters by `activeCategory`), but `categories` is derived from the
      // query-filtered field set. So the number of category buttons is the
      // observable that distinguishes "filtered" from "unfiltered" — the rendered
      // field count does not change, because clearing the query does not change
      // which category is active. This is the count the query filter would produce
      // when it matches everything: every distinct category among non-advanced
      // fields (advanced fields are hidden until the Advanced toggle is on).
      unfilteredCategoryCount: (() => {
        const model = read("gameConfigState.model");
        if (!model || typeof model !== "object" || !Array.isArray(model.fields)) return null;
        return new Set(model.fields.filter((field) => !field.advanced).map((field) => field.category)).size;
      })(),
      fields,
      saveRestartDisabled: saveRestart ? saveRestart.disabled : null,
      resetCurrentDisabled: resetCurrent ? resetCurrent.disabled : null,
      status: status ? status.textContent : null,
    };
  });
  // A field only counts as measurable once its wrapper has been laid out; a 0x0
  // wrapper is what "this panel has not re-rendered yet" looks like, and it is
  // exactly the state in which the layout assertions in this file pass for no
  // reason.
  const measurableKeys = Object.entries(state.fields)
    .filter(([, field]) => field.inputHeight > 0 && field.wrapperHeight > 0)
    .map(([key]) => key);
  const renderedKeys = Object.keys(state.fields);
  const observed = {
    query: state.query,
    showAdvanced: state.showAdvanced,
    activeCategory: state.activeCategory,
    categories: state.categories,
    unfilteredCategoryCount: state.unfilteredCategoryCount,
    renderedKeys,
    measurableKeys,
    saveRestartDisabled: state.saveRestartDisabled,
    resetCurrentDisabled: state.resetCurrentDisabled,
    status: state.status,
    values: Object.fromEntries(Object.entries(state.fields).map(([key, field]) => [key, field.value])),
  };
  return { ...state, measurableKeys, renderedKeys, state: JSON.stringify(observed) };
}

// `.page` is display:none until showPage() marks it active, and a hidden page
// measures 0x0 — which is precisely the reading that makes the horizontal
// overflow assertion in the workspace loop unfalsifiable. The `page-in`
// animation that runs once a page becomes active is Y-only (styles.css
// @keyframes page-in), so the horizontal measurement does not need to wait for
// the animation to finish; being active and laid out is sufficient.
async function pageLayoutObservation(page, pageName) {
  const state = await page.evaluate((name) => {
    const section = document.querySelector(`[data-page="${name}"]`);
    const main = document.querySelector(".main-content");
    const box = section ? section.getBoundingClientRect() : null;
    return {
      sectionPresent: Boolean(section),
      isActive: section ? section.classList.contains("is-active") : false,
      sectionWidth: box ? Math.round(box.width) : 0,
      sectionHeight: box ? Math.round(box.height) : 0,
      mainPresent: Boolean(main),
      mainClientWidth: main ? main.clientWidth : 0,
      activePages: Array.from(document.querySelectorAll(".page.is-active")).map((node) => node.dataset.page),
    };
  }, pageName);
  return {
    ready: state.sectionPresent && state.isActive && state.sectionWidth > 0 && state.sectionHeight > 0 && state.mainPresent && state.mainClientWidth > 0,
    state: `page=${pageName} ${JSON.stringify(state)}`,
  };
}

// "Where is the app sending the user, and has it finished deciding?" Resolved is
// `setupDetectionResolved`, which app.js sets only after account restore,
// security state and the first node refresh have all completed and the gates
// have been rendered. From that point at least one surface is settled: a gate is
// on screen, the deferred onboarding surface has appeared, or the app's own
// `shouldShowOnboardingWelcome()` says it never will. Polling that instead of
// sleeping keeps the negative assertions below honest without depending on how
// long the 350 ms onboarding defer happens to be.
async function firstExperienceObservation(page) {
  const state = await page.evaluate(() => {
    const read = (expression) => {
      try {
        return window.eval(expression);
      } catch (error) {
        return `unreadable: ${error?.message || String(error)}`;
      }
    };
    const surface = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return "missing";
      if (node.hidden) return "hidden";
      const box = node.getBoundingClientRect();
      return box.width > 0 && box.height > 0 ? "visible" : "collapsed";
    };
    return {
      setupDetectionResolved: read("setupDetectionResolved"),
      accountRestorationResolved: read("accountRestorationResolved"),
      onboardingNeeded: read("typeof shouldShowOnboardingWelcome === 'function' ? shouldShowOnboardingWelcome() : 'unreadable'"),
      securityGate: surface("[data-security-gate]"),
      localSetupGate: surface("[data-local-setup-gate]"),
      onboardingWelcome: surface("[data-onboarding-welcome]"),
      onboardingWizard: surface("[data-onboarding-wizard]"),
    };
  });
  const surfaceVisible = ["securityGate", "localSetupGate", "onboardingWelcome", "onboardingWizard"]
    .some((key) => state[key] === "visible");
  return {
    ready: state.setupDetectionResolved === true && (surfaceVisible || state.onboardingNeeded === false),
    state: JSON.stringify(state),
  };
}

// The dashboard assertions read the friendly empty state, and an unrendered
// dashboard reports the placeholder text ("Checking", "Checking current state")
// that no CTA pattern matches — so "no Create Server CTA when instances exist"
// used to be satisfiable by the dashboard never having rendered at all. Being
// active, laid out, and past the placeholders is the precondition that makes the
// read meaningful.
async function dashboardObservation(page) {
  const layout = await pageLayoutObservation(page, "dashboard");
  const friendly = await page.evaluate(() => {
    const fields = Array.from(document.querySelectorAll("[data-dashboard-friendly]"));
    const empty = document.querySelector("[data-dashboard-friendly-empty]");
    return {
      friendlyFieldCount: fields.length,
      placeholderCount: fields.filter((field) => /^checking/i.test(field.textContent || "")).length,
      samples: fields.slice(0, 4).map((field) => `${field.dataset.dashboardFriendly}=${(field.textContent || "").slice(0, 40)}`),
      emptyStatePresent: Boolean(empty),
      emptyStateHidden: empty ? empty.hidden : null,
      emptyStateText: empty ? (empty.textContent || "").slice(0, 120) : "",
    };
  });
  return {
    ready: layout.ready && friendly.friendlyFieldCount > 0 && friendly.placeholderCount < friendly.friendlyFieldCount,
    state: `${layout.state} ${JSON.stringify(friendly)}`,
  };
}

async function main() {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-stabilization-qa-"));
  const qaEnvironment = createIsolatedQaEnv("anx-stabilization-config-");
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
  }, WATCHDOG_MS);
  try {
    app = await electron.launch({
      args: [`--user-data-dir=${userDataDir}`, "--no-sandbox", root, "--qa-mode"],
      env: { ...process.env, ...qaEnvironment.env, ANXOS_QA_MODE: "1" },
    });
    const appProcess = app.process();
    const onMainOutput = (chunk) => mainLogs.push(redacted(chunk.toString()));
    appProcess.stdout?.on("data", onMainOutput);
    appProcess.stderr?.on("data", onMainOutput);
    const page = await app.firstWindow();
    // Every wait in this file goes through these, so the Electron process handle
    // is attached once and a dead app fails a wait immediately instead of
    // burning the budget first.
    const waitFor = (options) => waitForCondition(page, { electronProcess: appProcess, ...options });
    const waitForGameConfig = (label, predicate) => waitFor({
      label,
      probe: async () => {
        const observation = await gameConfigObservation(page);
        return { ready: predicate(observation), state: observation.state };
      },
    });
    const waitForGameConfigField = (key, label) => waitForGameConfig(label, (observation) => observation.measurableKeys.includes(key));
    // Category buttons inside the game-config editor. Scoped to the editor's
    // section list and matched exactly because an unscoped
    // getByRole("button", { name: "Players" }) also matches the Instances
    // workspace tab of the same name: app.js unhides that tab list as soon as an
    // instance is selected, which the game-config block requires, so the unscoped
    // locator is a strict-mode violation that fails the run deterministically.
    const gameConfigSectionButton = (label) => page.locator("[data-game-config-sections]").getByRole("button", { name: label, exact: true });
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
    await waitFor({
      label: "The first-experience decision must be resolved and one of its surfaces settled (a gate on screen, or onboarding shown/settled)",
      budgetMs: BOOTSTRAP_BUDGET_MS,
      probe: () => firstExperienceObservation(page),
    });
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
      await waitFor({
        label: `Security section "${section}" must become visible once its navigation button is clicked`,
        probe: () => securitySectionObservation(page, section),
      });
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
      // Kept as a fixed settle delay on purpose. The assertion it gates is
      // negative ("Test Connection must not also open Node Details") and there
      // is no predicate that holds on every legitimate path: testNodeById
      // returns before touching the DOM when the nodes bridge is unavailable,
      // which is a valid --qa-mode path, so polling for its only positive effect
      // (the "Node connected." toast) would fail a legitimate run. Polling for
      // the real test-connection round trip instead would make this assertion
      // depend on a remote node's latency — a new environmental test rather than
      // more coverage. A bounded observation window is the only way to assert
      // that something did NOT happen, so the window stays.
      await page.waitForTimeout(250);
      const detailsAfterTest = await visible(page, "[data-node-details-modal]:not([hidden])");
      assert(!(detailsAfterTest && !detailsInitiallyVisible), "Test Connection must not open Node Details.");
    }

    // The instance file browser lives inside `.instance-workspace-card`, which
    // app.js keeps `hidden` until an instance is selected (`setInstanceDetails`
    // sets `card.hidden = !instance`). The QA instance used to be injected only
    // further down, for the game-config checks, so this block measured a
    // display:none panel: every height read 0 and the four assertions below were
    // satisfied by `0 <= viewportHeight` plus the cascaded `overflow-y: auto`,
    // with no browser on screen. The fixture is now established first, through
    // the app's own selection path, so what gets measured is a rendered workspace.
    //
    // Residual race, accepted and reported by the wait rather than silently: the
    // Instances page polls every 5 s (INSTANCE_PAGE_REFRESH_INTERVAL_MS) and a
    // poll that renders an empty list clears the injected snapshot and collapses
    // the card again. The fixture is re-established immediately before the wait,
    // so the exposure is one poll interval wide, and if a poll does win the
    // failure names `cardHidden` and the snapshot length.
    await page.evaluate((instance) => window.eval(`
      latestInstancesSnapshot = { instances: [${JSON.stringify(instance)}] };
      selectInstance(${JSON.stringify(instance.id)});
      showPage("instances");
      setActiveInstanceTab("files");
    `), QA_INSTANCE);
    await waitFor({
      label: "The Files tab panel must be active and laid out before its fit and overflow are measured",
      probe: () => instanceFilesObservation(page),
    });
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

    await page.evaluate((qaInstance) => {
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
        selectedInstanceId = ${JSON.stringify(qaInstance.id)};
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
    }, QA_INSTANCE);
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
    // The search rebuild is debounced in app.js. Polling the flushed query plus
    // the rendered match is what removes the coupling: the debounce used to be
    // pinned at 80 ms only because this file slept 100 ms afterwards.
    await waitForGameConfig(
      'The debounced game-config search for "players" must flush and render the matching field',
      (observation) => observation.query === "players" && observation.measurableKeys.includes("max-players"),
    );
    assert.strictEqual(await page.locator('[data-game-config-field="max-players"]').isVisible(), true, "Search must keep matching settings visible.");
    const playersSectionBox = await gameConfigSectionButton("Players").boundingBox();
    const playersFieldBox = await page.locator('[data-game-config-field="max-players"]').locator("xpath=..").boundingBox();
    assert(playersSectionBox && playersFieldBox && playersFieldBox.y <= playersSectionBox.y + 16, "Players fields must start near the top of the editor area.");
    await page.locator("[data-game-config-search]").fill("");
    // `gameConfigState.query` is written synchronously by the input listener, so
    // `query === ""` alone proves nothing about the debounced rebuild. Wait for the
    // rebuild itself: clearing the filter must restore the unfiltered category set.
    // `categories` is derived from the query-filtered fields (see
    // `renderGameConfigPanel`), so it is the observable that moves — the rendered
    // field count does NOT, because the active category is unchanged by a clear.
    // This deliberately does not depend on the debounce duration, so changing that
    // duration cannot make this wait pass or fail for the wrong reason.
    await waitForGameConfig(
      "Clearing the game-config search must re-render the unfiltered category set (every non-advanced category, not just those the query matched)",
      (observation) =>
        observation.query === "" && observation.categories.length === observation.unfilteredCategoryCount,
    );
    await page.locator("[data-game-config-advanced]").check();
    await waitForGameConfig(
      "Enabling advanced settings must re-render the field list with the Advanced category available",
      (observation) => observation.showAdvanced === true && observation.categories.includes("Advanced"),
    );
    await gameConfigSectionButton("Advanced").click();
    await waitForGameConfigField("enable-command-block", 'The Advanced category must render and lay out the "Command Blocks" boolean field');
    const booleanFieldBox = await page.locator('[data-game-config-field="enable-command-block"]').locator("xpath=..").boundingBox();
    const fieldsPanelBox = await page.locator("[data-game-config-fields]").boundingBox();
    assert(booleanFieldBox && fieldsPanelBox && booleanFieldBox.y <= fieldsPanelBox.y + 12, "Boolean settings must render at the top of the settings form, not centered in empty space.");
    await gameConfigSectionButton("Resource Pack").click();
    await waitForGameConfigField("resource-pack", 'The "Resource Pack" category must render and lay out its advanced field');
    assert.strictEqual(await page.locator('[data-game-config-field="resource-pack"]').isVisible(), true, "Advanced mode must reveal advanced settings.");
    await gameConfigSectionButton("Network").click();
    await waitForGameConfigField("server-port", 'The "Network" category must render its port field before it is edited');
    await page.locator('[data-game-config-field="server-port"]').fill("25566");
    await waitForGameConfig(
      "Editing server-port must enable Save and Restart and report a restart-required change",
      (observation) => observation.saveRestartDisabled === false && /restart required/i.test(observation.status || ""),
    );
    assert.strictEqual(await page.locator("[data-game-config-save-restart]").isEnabled(), true, "Save and Restart must enable after a restart-required change.");
    assert(/restart required/i.test(await page.locator("[data-game-config-status]").textContent()), "Restart-required changes must be visible.");
    await gameConfigSectionButton("Players").click();
    await waitForGameConfigField("max-players", 'The "Players" category must render its field before it is edited');
    await page.locator('[data-game-config-field="max-players"]').fill("21");
    // The reset button is disabled unless the form is dirty, so clicking it
    // before the edit registers would silently do nothing and the next two
    // assertions would then be checking the wrong thing.
    await waitForGameConfig(
      "A dirty Players field must enable Reset Current before it is clicked",
      (observation) => observation.resetCurrentDisabled === false,
    );
    await page.locator("[data-game-config-reset-current]").click();
    await waitForGameConfig(
      "Reset Current must restore the selected category and leave the other modified category dirty",
      (observation) => observation.fields["max-players"]?.value === "20" && observation.saveRestartDisabled === false,
    );
    assert.strictEqual(await page.locator('[data-game-config-field="max-players"]').inputValue(), "20", "Reset Current must restore the selected category to saved values.");
    assert.strictEqual(await page.locator("[data-game-config-save-restart]").isEnabled(), true, "Reset Current must preserve dirty settings in other categories.");
    await page.locator('[data-game-config-field="max-players"]').fill("22");
    await waitForGameConfig(
      "Editing after Reset Current must mark the form dirty again",
      (observation) => observation.saveRestartDisabled === false,
    );
    assert.strictEqual(await page.locator("[data-game-config-save-restart]").isEnabled(), true, "Editing after Reset Current must mark the form dirty again.");
    await page.locator("[data-game-config-reset-current]").click();
    await waitForGameConfig(
      'Reset Current on "Players" must restore its field before the category is left',
      (observation) => observation.fields["max-players"]?.value === "20",
    );
    await gameConfigSectionButton("Network").click();
    await waitForGameConfig(
      'The "Network" category must render its still-modified field with Reset Current enabled',
      (observation) => observation.measurableKeys.includes("server-port") && observation.resetCurrentDisabled === false,
    );
    await page.locator("[data-game-config-reset-current]").click();
    await waitForGameConfig(
      "Resetting the last modified category must clear the dirty state and restore its field",
      (observation) => observation.saveRestartDisabled === true && observation.fields["server-port"]?.value === "25565",
    );
    assert.strictEqual(await page.locator("[data-game-config-save-restart]").isDisabled(), true, "Reset Current must clear dirty state after all modified categories are reset.");

    await page.evaluate(() => window.showPage?.("dashboard"));
    // An unrendered dashboard still reads its "Checking" placeholders, which no
    // CTA pattern matches, so the assertion below used to be satisfiable by the
    // dashboard simply not having rendered yet.
    await waitFor({
      label: "The Dashboard must be active, laid out, and past its placeholder state before its empty state is read",
      probe: () => dashboardObservation(page),
    });
    await page.evaluate(() => {
      const main = document.querySelector(".main-content");
      if (main) main.scrollTop = 0;
      window.scrollTo(0, 0);
    });
    const dashboardText = await page.locator("[data-dashboard-friendly-empty]").textContent().catch(() => "");
    const instanceCount = await page.evaluate(() => Array.isArray(window.latestInstancesSnapshot?.instances) ? window.latestInstancesSnapshot.instances.length : null).catch(() => null);
    if (instanceCount && instanceCount > 0) {
      assert(!/Create your first server|No servers yet/i.test(dashboardText), "Dashboard must not show Create Server CTA when instances exist.");
    }

    await page.screenshot({ path: path.join(artifactDir, "stabilization-1182x821.png") });
    for (const workspace of ["instances", "playit", "marketplace", "nodes"]) {
      await page.evaluate((pageName) => {
        window.showPage?.(pageName);
        const main = document.querySelector(".main-content");
        if (main) main.scrollTop = 0;
      }, workspace);
      // A workspace that has not been activated is display:none, so it measures
      // 0x0 and the overflow assertion below would read 0 for every workspace and
      // could never fail. Being active and laid out is the precondition that
      // makes that assertion about the workspace instead of about the wait.
      await waitFor({
        label: `The "${workspace}" workspace must be active and laid out before its horizontal overflow is measured`,
        probe: () => pageLayoutObservation(page, workspace),
      });
      const horizontalLayout = await page.evaluate(() => {
        const main = document.querySelector(".main-content");
        if (!main) return { overflow: 0, offenders: [] };
        const right = main.getBoundingClientRect().right;
        const offenders = Array.from(main.querySelectorAll("*"))
          .map((element) => ({ element, box: element.getBoundingClientRect() }))
          .filter(({ box }) => box.width > 0 && box.right > right + 2)
          .slice(0, 8)
          .map(({ element, box }) => ({
            className: String(element.className || "").slice(0, 100),
            tagName: element.tagName,
            overflow: Math.round(box.right - right),
          }));
        return { overflow: main.scrollWidth - main.clientWidth, offenders };
      });
      assert(horizontalLayout.overflow <= 8, `${workspace} workspace must not introduce page-level horizontal overflow beyond its native scrollbar gutter: ${JSON.stringify(horizontalLayout)}`);
      await page.screenshot({ path: path.join(artifactDir, `v19-${workspace}-1182x821.png`) });
    }
    if (rendererErrors.length) {
      writeArtifacts({ pass: false, rendererErrors, fileLayout });
      throw new Error(`Renderer errors were reported: ${rendererErrors.join("; ")}`);
    }
    writeArtifacts({ pass: true, fileLayout });
    console.log(JSON.stringify({ pass: true, artifactDir, fileLayout }, null, 2));
  } finally {
    clearTimeout(watchdog);
    await app?.close?.().catch(() => {});
    // Windows can still hold the profile directory for a moment after the app
    // exits, so this retries rather than racing the handle release. Retries only
    // apply because `recursive` is true; a non-recursive removal would ignore them.
    //
    // A cleanup failure must NOT be allowed to replace the verdict: this runs in a
    // `finally`, so throwing here would discard an assertion failure (or the pass
    // payload) and report only an EPERM — which is how a real failure was masked
    // once already. Report it and let the run's own result stand.
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (cleanupError) {
      console.warn(
        `[cleanup] could not remove the QA profile directory ${userDataDir}: ${cleanupError?.code || cleanupError?.message || cleanupError}`,
      );
    }
    qaEnvironment.cleanup();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
