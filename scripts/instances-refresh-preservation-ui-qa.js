#!/usr/bin/env node
"use strict";

// Desktop UI regression for Instances auto-refresh.
//
// Launches the REAL Electron app (isolated profile and config, --qa-mode)
// against a REAL Agent (its only fake is systemd, a state file) and lets the
// Instances page poll on its own. Proves that an automatic refresh updates
// only live data and never interrupts the user:
//   R1 live data updates: a state change on the Agent reaches the list on the
//      next poll, without the loading overlay, a busy page, or a toast;
//   R2 an unsaved settings edit keeps its value, caret and focus across polls,
//      the Settings tab stays active, scroll position and row elements are
//      kept (rows are updated in place, not remounted);
//   R3 a saved edit is reloaded from the stored configuration (the form ends
//      clean), so refresh gating never strands the form as "Unsaved";
//   R4 a node that stops answering keeps the last list on screen, quietly:
//      no reset, no toast per poll, and the unsaved edit is still there.
//
// Focus and scroll checks need an undisturbed window: a mouse click on the test
// window (or OS focus changes) during the run can move focus. On failure the
// assertion message includes the recorded blur/scroll/focus-call events, which
// show whether the app or the environment moved focus.
//
// Never touches the installed app or its data.
// Run: node scripts/instances-refresh-preservation-ui-qa.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent, INSTANCE_ID } = require("./test-helpers/service-managed-agent-fixture");

const root = path.resolve(__dirname, "..");
const artifactDir = process.env.INSTANCES_REFRESH_UI_QA_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), "anx-refresh-ui-qa-"));
fs.mkdirSync(artifactDir, { recursive: true });
const PLAIN_ID = "plain-server";
const TIMEOUT_MS = 20000;
// The page polls every INSTANCE_PAGE_REFRESH_INTERVAL_MS (5 s); two full
// cycles plus slack guarantees at least two polls landed.
const TWO_POLLS_MS = 12500;

function redacted(value) {
  return String(value || "").replace(/(token|password|secret|authorization|cookie|session)[=:]\S+/gi, "$1=[redacted]");
}

async function waitFor(page, label, probe, timeoutMs = TIMEOUT_MS) {
  const started = Date.now();
  let last;
  for (;;) {
    try {
      last = await probe();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for: ${label} (last: ${typeof last === "object" ? JSON.stringify(last)?.slice(0, 300) : last})`);
    }
    await page.waitForTimeout(150);
  }
}

async function launch(agent) {
  const qa = createIsolatedQaEnv("anx-refresh-ui-qa-config-");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-refresh-ui-qa-profile-"));
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  write("nodes.json", {
    schemaVersion: 2,
    selectedNodeId: "ovh",
    nodes: [{ id: "ovh", kind: "agent", name: "OVH", displayName: "OVH", baseUrl: agent.url, agentUrl: agent.url, enabled: true }],
  });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { ovh: { agentToken: agent.token } } });
  // The VS Code / Claude extension host exports ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node.
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", root, "--qa-mode"], env });
  const page = await app.firstWindow();
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(redacted(error.stack || error.message)));
  page.setDefaultTimeout(10000);
  // A short window so the Instances page scrolls (R2 checks scroll position).
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window?.setSize(1400, 760); window?.center(); });
  await page.waitForLoadState("domcontentloaded");
  const useDevice = page.getByRole("button", { name: "Use this device" }).first();
  await waitFor(page, "app shell ready", async () => (await page.evaluate(() => typeof window.showPage === "function")), 30000);
  if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
  await page.evaluate(() => window.showPage("instances"));
  return {
    app,
    page,
    rendererErrors,
    async close() {
      await app.close().catch(() => {});
      for (const cleanup of [() => qa.cleanup(), () => fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })]) {
        try { cleanup(); } catch {}
      }
    },
  };
}

function rowState(page, id) {
  return page.evaluate((instanceId) => {
    const row = document.querySelector(`[data-instances-list] tr[data-instance-id="${instanceId}"]`);
    return row ? row.innerText.replace(/\s+/g, " ") : null;
  }, id);
}

// Records, from now on, everything a refresh must not do: show the loading
// overlay, mark the page busy, raise a toast, or remount instance rows.
function installRefreshObservers(page) {
  return page.evaluate(() => {
    const log = { loadingShown: 0, pageBusy: 0, toasts: [], rowsRemoved: 0 };
    window.__refreshQa = log;
    const loading = document.querySelector("[data-instances-loading]");
    const instancesPage = document.querySelector('[data-page="instances"]');
    new MutationObserver(() => { if (loading && !loading.hidden) log.loadingShown += 1; }).observe(loading, { attributes: true, attributeFilter: ["hidden"] });
    new MutationObserver(() => { if (instancesPage.getAttribute("aria-busy") === "true") log.pageBusy += 1; }).observe(instancesPage, { attributes: true, attributeFilter: ["aria-busy"] });
    const toast = document.querySelector("#toast");
    new MutationObserver(() => { if (toast.classList.contains("is-visible")) log.toasts.push(toast.textContent); }).observe(toast, { attributes: true, childList: true, characterData: true, subtree: true });
    const list = document.querySelector("[data-instances-list]");
    new MutationObserver((records) => records.forEach((record) => record.removedNodes.forEach((node) => { if (node.nodeName === "TR") log.rowsRemoved += 1; }))).observe(list, { childList: true });
    if (window.__refreshQaDebug) {
      log.debug = [];
      const input = document.querySelector('[data-instance-config="displayName"]');
      input.addEventListener("blur", () => {
        setTimeout(() => {
          const active = document.activeElement;
          const disabledAncestor = [];
          for (let node = input; node; node = node.parentElement) if (node.hidden || node.disabled || node.inert) disabledAncestor.push(node.outerHTML.slice(0, 80));
          log.debug.push({ event: "blur", connected: input.isConnected, activeTag: active?.outerHTML?.slice(0, 120), disabledAncestor, page: document.querySelector(".page.is-active, .page:not([hidden])")?.dataset.page });
        }, 0);
      });
      const scroller = window.__qaScroller;
      const shell = document.querySelector(".instances-shell");
      log.debug.push({ event: "scroller", tag: scroller?.tagName, cls: scroller?.className, clientHeight: scroller?.clientHeight });
      scroller?.addEventListener("scroll", () => {
        log.debug.push({
          event: "scroll",
          t: Math.round(performance.now()),
          top: scroller.scrollTop,
          height: scroller.scrollHeight,
          sections: [...(shell?.children || [])].map((child) => `${(child.className || child.tagName).toString().split(" ")[0]}:${child.hidden ? "hidden" : Math.round(child.getBoundingClientRect().height)}`).join(","),
        });
      });
      const originalFocus = HTMLElement.prototype.focus;
      HTMLElement.prototype.focus = function patchedFocus(...args) {
        if (this !== input) log.debug.push({ event: "focus-call", target: this.outerHTML.slice(0, 100), stack: new Error().stack.split("\n").slice(2, 7).join(" | ") });
        return originalFocus.apply(this, args);
      };
    }
    // Element identity: a remounted row or panel would lose these marks.
    document.querySelectorAll("[data-instances-list] tr[data-instance-id]").forEach((row) => { row.__qaMark = row.dataset.instanceId; });
    return true;
  });
}

function readRefreshObservers(page) {
  return page.evaluate(() => ({
    ...window.__refreshQa,
    toasts: [...window.__refreshQa.toasts],
    rowsKeepIdentity: [...document.querySelectorAll("[data-instances-list] tr[data-instance-id]")].every((row) => row.__qaMark === row.dataset.instanceId),
  }));
}

function editorState(page) {
  return page.evaluate(() => {
    const input = document.querySelector('[data-instance-config="displayName"]');
    const settingsTab = document.querySelector('[data-instance-tab="settings"]');
    const scroller = window.__qaScroller;
    return {
      value: input?.value,
      focused: document.activeElement === input,
      caret: input?.selectionStart,
      settingsActive: settingsTab?.classList.contains("is-active"),
      settingsPanelActive: document.querySelector('[data-instance-panel="settings"]')?.classList.contains("is-active"),
      saveEnabled: document.querySelector("[data-instance-config-save]") ? !document.querySelector("[data-instance-config-save]").disabled : null,
      scrollTop: scroller ? scroller.scrollTop : null,
      inputTop: input ? Math.round(input.getBoundingClientRect().top) : null,
      scrollerHeight: scroller ? scroller.scrollHeight : null,
      attention: !document.querySelector("[data-instance-attention]")?.hidden,
    };
  });
}

async function main() {
  const report = { checks: [] };
  const pass = (name) => { report.checks.push(name); console.log(`PASS ${name}`); };
  const agent = await startServiceManagedAgent({ initial: "running", extraInstances: [PLAIN_ID] });
  const ui = await launch(agent);
  const { page } = ui;
  let agentStopped = false;
  try {
    await waitFor(page, "both rows listed", async () => (await rowState(page, INSTANCE_ID)) && (await rowState(page, PLAIN_ID)));
    await waitFor(page, "service row running", async () => /running/i.test(await rowState(page, INSTANCE_ID)));

    // Select the ordinary instance and start an unsaved edit in Settings.
    await page.locator(`[data-instances-list] tr[data-instance-id="${PLAIN_ID}"] td`).first().click();
    await waitFor(page, "workspace visible", () => page.evaluate(() => { const card = document.querySelector(".instance-workspace-card"); return card && !card.hidden; }));
    await page.locator('[data-instance-tab="settings"]').first().click();
    const input = page.locator('[data-instance-config="displayName"]').first();
    await waitFor(page, "settings form loaded", async () => (await input.inputValue()) === "Plain Server");
    await input.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" (unsaved edit)");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    const expectedValue = "Plain Server (unsaved edit)";

    // Scroll the page so the edited field sits on screen, as it does for a user
    // typing in it (focus stays in the input). A field left off screen would be
    // scrolled into view by Chromium whenever the window regains OS focus,
    // which is unrelated to the app's refresh behaviour.
    await page.evaluate(() => {
      const input = document.querySelector('[data-instance-config="displayName"]');
      let node = input;
      while (node && !(node.scrollHeight > node.clientHeight + 20 && /(auto|scroll)/.test(getComputedStyle(node).overflowY))) node = node.parentElement;
      const scroller = node || document.scrollingElement;
      window.__qaScroller = scroller;
      const offset = input.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = Math.max(0, Math.round(offset - scroller.clientHeight / 3));
    });
    await page.waitForTimeout(300);
    const before = await editorState(page);
    assert.strictEqual(before.value, expectedValue);
    assert.strictEqual(before.focused, true, "the edited field has focus before polling");
    await page.evaluate(() => { window.__refreshQaDebug = true; });
    await installRefreshObservers(page);

    // R1: change live state on the Agent and let the page pick it up by itself.
    agent.setUnit("stopped");
    await waitFor(page, "poll applies the stopped state", async () => /stopped|inactive/i.test(await rowState(page, INSTANCE_ID)), TWO_POLLS_MS * 2);
    agent.setUnit("running");
    await waitFor(page, "poll applies the running state again", async () => /running/i.test(await rowState(page, INSTANCE_ID)), TWO_POLLS_MS * 2);
    await page.waitForTimeout(TWO_POLLS_MS);
    let observed = await readRefreshObservers(page);
    assert.strictEqual(observed.loadingShown, 0, "background polls never show the loading overlay");
    assert.strictEqual(observed.pageBusy, 0, "background polls never mark the page busy");
    assert.deepStrictEqual(observed.toasts, [], "background polls raise no toasts");
    pass("R1 live state updates in place without loading overlay, busy state or toasts");

    // R2: the unsaved edit, caret, focus, tab, scroll and rows all survived.
    const after = await editorState(page);
    const diagnostics = () => `before ${JSON.stringify(before)} after ${JSON.stringify(after)} events ${JSON.stringify(observed.debug || []).slice(0, 3000)}`;
    if (process.env.REFRESH_QA_DEBUG) console.log("DEBUG", diagnostics());
    assert.strictEqual(after.value, expectedValue, "the unsaved edit is kept");
    assert.strictEqual(after.focused, true, `focus stays in the edited field (${diagnostics()})`);
    assert.strictEqual(after.caret, before.caret, "the caret does not move");
    assert.strictEqual(after.settingsActive, true, "the Settings tab stays active");
    assert.strictEqual(after.settingsPanelActive, true, "the Settings panel stays open");
    assert.strictEqual(after.saveEnabled, true, "the edit still counts as unsaved");
    assert.strictEqual(after.scrollTop, before.scrollTop, `the scroll position is kept (${diagnostics()})`);
    assert.strictEqual(observed.rowsRemoved, 0, "no row is removed and remounted");
    assert.strictEqual(observed.rowsKeepIdentity, true, "rows are updated in place");
    pass("R2 unsaved edit, caret, focus, active tab, scroll position and rows survive polling");
    await page.screenshot({ path: path.join(artifactDir, "after-polls.png") });

    // R3: saving reloads the stored configuration; the form ends clean.
    await page.locator("[data-instance-config-save]").first().click();
    await waitFor(page, "saved name shown in the list", async () => /\(unsaved edit\)/.test(await rowState(page, PLAIN_ID)), TWO_POLLS_MS * 2);
    await waitFor(page, "form is clean after save", async () => (await editorState(page)).saveEnabled === false, TWO_POLLS_MS * 2);
    assert.strictEqual((await editorState(page)).value, expectedValue, "the saved value stays in the form");
    pass("R3 a saved edit reloads cleanly from the stored configuration");

    // R4: the node stops answering. The list and a new unsaved edit stay put, quietly.
    await input.click();
    await page.keyboard.press("End");
    await page.keyboard.type(" again");
    await installRefreshObservers(page);
    await agent.stop();
    agentStopped = true;
    await page.waitForTimeout(TWO_POLLS_MS * 2);
    observed = await readRefreshObservers(page);
    assert.ok(await rowState(page, INSTANCE_ID), "the service row is still listed");
    assert.ok(await rowState(page, PLAIN_ID), "the plain row is still listed");
    assert.strictEqual((await editorState(page)).value, `${expectedValue} again`, "the unsaved edit survives a disconnected node");
    assert.strictEqual(observed.rowsRemoved, 0, "a disconnected node does not reset the list");
    assert.ok(observed.toasts.filter((text) => /refresh failed/i.test(text)).length === 0, "failed background polls raise no toasts");
    assert.strictEqual(observed.loadingShown, 0, "failed background polls never show the loading overlay");
    pass("R4 a disconnected node keeps the last list and the edit, without toasts");

    assert.deepStrictEqual(ui.rendererErrors, [], "no renderer errors");
    console.log(`Instances refresh preservation UI QA passed (${report.checks.length} checks). Artifacts: ${artifactDir}`);
  } catch (error) {
    await page.screenshot({ path: path.join(artifactDir, "failure.png") }).catch(() => {});
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    await ui.close();
    if (!agentStopped) await agent.stop().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
