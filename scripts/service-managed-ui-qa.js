#!/usr/bin/env node
"use strict";

// Desktop UI acceptance for service-managed ("systemd-service") instances.
//
// Launches the REAL Electron app (isolated profile and config, --qa-mode) against
// a REAL Agent process whose only fake is systemd (a state file). Drives the UI
// with real clicks and reads what the Agent actually did.
//
// Proves:
//   S1 Running  - the instance renders as a systemd service; Stop/Reload work
//                 through the UI as single systemd calls; everything the Agent
//                 refuses (console, force-kill, edit, rename, duplicate, delete,
//                 backups, scheduled restarts) is disabled with a reason and STAYS
//                 disabled across tab switches and refreshes; the controls come
//                 back for an ordinary instance selected afterwards.
//   S2 Unknown  - an unreadable service is shown as Unknown with its reason, and
//                 every lifecycle control is disabled (fail closed).
//   S3 Failed   - a failed service can be started from the UI.
//
// Never touches the installed app or its data. Run: node scripts/service-managed-ui-qa.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");

const root = path.resolve(__dirname, "..");
const artifactDir = process.env.SERVICE_MANAGED_UI_QA_ARTIFACTS || fs.mkdtempSync(path.join(os.tmpdir(), "anx-svc-ui-qa-"));
fs.mkdirSync(artifactDir, { recursive: true });
// Every locked control explains itself; the wording is specific per control (force kill, delete, ...).
const isLockReason = (title) => /(?:is|are) unavailable|^Unavailable|Not available for a service-managed instance/.test(String(title || ""));
const INSTANCE_ID = "fivem-fxserver";
const PLAIN_ID = "plain-server";
const TIMEOUT_MS = 20000;

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

// Retry an assertion until it holds (the UI settles asynchronously); report the last failure on timeout.
async function eventuallyOn(page, label, assertion, timeoutMs = 12000) {
  const started = Date.now();
  for (;;) {
    try { await assertion(); return; } catch (error) {
      if (Date.now() - started > timeoutMs) { error.message = `${label}: ${error.message}`; throw error; }
    }
    await page.waitForTimeout(200);
  }
}

async function launch(agent) {
  const qa = createIsolatedQaEnv("anx-svc-ui-qa-config-");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-svc-ui-qa-profile-"));
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "ovh", nodes: [{ id: "ovh", kind: "agent", name: "OVH", displayName: "OVH", baseUrl: agent.url, agentUrl: agent.url, enabled: true, agentIdentity: { deviceId: "device-ovh" } }] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { ovh: { agentToken: agent.token } } });
  // The VS Code / Claude extension host exports ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node.
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", root, "--qa-mode"], env });
  const mainLogs = [];
  app.process().stdout?.on("data", (chunk) => mainLogs.push(redacted(chunk)));
  app.process().stderr?.on("data", (chunk) => mainLogs.push(redacted(chunk)));
  const page = await app.firstWindow();
  const rendererErrors = [];
  page.on("pageerror", (error) => rendererErrors.push(redacted(error.stack || error.message)));
  page.on("console", (message) => { if (message.type() === "error") rendererErrors.push(redacted(message.text())); });
  page.setDefaultTimeout(10000);
  await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window?.setSize(1500, 1000); window?.center(); });
  await page.waitForLoadState("domcontentloaded");
  // A fresh profile shows the first-run chooser; pick the same option a user would.
  const useDevice = page.getByRole("button", { name: "Use this device" }).first();
  await waitFor(page, "app shell ready", async () => (await page.evaluate(() => typeof window.showPage === "function")), 30000);
  if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
  await page.evaluate(() => window.showPage("instances"));
  return {
    app,
    page,
    rendererErrors,
    mainLogs,
    async close() {
      await app.close().catch(() => {});
      // Best effort: Windows can hold the profile for a moment after Electron exits, and a
      // leftover temp directory must never turn a passing run into a failure.
      for (const cleanup of [() => qa.cleanup(), () => fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })]) {
        try { cleanup(); } catch {}
      }
    },
  };
}

const visibleScript = `(el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden" && !el.closest("[hidden]"); }`;

async function rowInfo(page, id) {
  return page.evaluate((instanceId) => {
    const row = document.querySelector(`[data-instances-list] tr[data-instance-id="${instanceId}"]`);
    if (!row) return null;
    return {
      text: row.innerText.replace(/\s+/g, " "),
      buttons: Object.fromEntries(Array.from(row.querySelectorAll("button[data-instance-row-action]")).map((button) => [button.dataset.instanceRowAction, { disabled: button.disabled }])),
    };
  }, id);
}

// State of every visible control carrying a given selector.
async function controls(page, selector) {
  return page.evaluate(({ selector: sel, visible }) => {
    const isVisible = eval(visible);
    return Array.from(document.querySelectorAll(sel)).filter(isVisible).map((element) => ({ disabled: Boolean(element.disabled), title: element.title || "", text: (element.textContent || "").trim() }));
  }, { selector, visible: visibleScript });
}

async function selectRow(page, id) {
  await waitFor(page, `row ${id} listed`, () => rowInfo(page, id));
  await page.locator(`[data-instances-list] tr[data-instance-id="${id}"] td`).first().click();
  await waitFor(page, "workspace card visible", () => page.evaluate(() => { const card = document.querySelector(".instance-workspace-card"); return card && !card.hidden; }));
  await page.waitForTimeout(400);
}

async function openTab(page, tab) {
  await page.locator(`[data-instance-tab="${tab}"]`).first().click();
  await page.waitForTimeout(600);
}

async function noticeText(page) {
  return page.evaluate(() => { const card = document.querySelector("[data-service-managed-card]"); return card && !card.hidden ? card.innerText.replace(/\s+/g, " ") : ""; });
}

async function assertLocked(page, label, selectors) {
  for (const selector of selectors) {
    const found = await controls(page, selector);
    assert.ok(found.length > 0, `${label}: expected a visible control for ${selector}`);
    for (const control of found) {
      assert.strictEqual(control.disabled, true, `${label}: ${selector} must be disabled`);
      assert.ok(isLockReason(control.title), `${label}: ${selector} must explain why (title: ${control.title})`);
    }
  }
}

// Clicks the first visible, enabled match, waiting for the app to enable it (its own
// busy logic re-enables controls asynchronously after refreshes and operations).
async function clickVisibleEnabled(page, selector) {
  let element = null;
  await waitFor(page, `an enabled visible control for ${selector}`, async () => {
    const handle = await page.evaluateHandle(({ sel, visible }) => {
      const isVisible = eval(visible);
      return Array.from(document.querySelectorAll(sel)).find((candidate) => isVisible(candidate) && !candidate.disabled) || null;
    }, { sel: selector, visible: visibleScript });
    element = handle.asElement();
    return Boolean(element);
  });
  // The app can re-render (and briefly disable the control) between the lookup and the click.
  await waitFor(page, `click on ${selector}`, async () => {
    try {
      await element.click({ timeout: 1500 });
      return true;
    } catch {
      const handle = await page.evaluateHandle(({ sel, visible }) => {
        const isVisible = eval(visible);
        return Array.from(document.querySelectorAll(sel)).find((candidate) => isVisible(candidate) && !candidate.disabled) || null;
      }, { sel: selector, visible: visibleScript });
      element = handle.asElement() || element;
      return false;
    }
  });
}

// Performs one lifecycle click the way a user would: wait until the app is idle, click
// (and confirm), and retry if the app swallowed the click because its previous operation
// was still in flight. Returns the control calls the Agent actually made.
async function driveLifecycle(page, agent, label, attempt) {
  for (let tries = 1; tries <= 3; tries += 1) {
    await waitFor(page, `app idle before ${label}`, () => page.evaluate(() => window.eval("instanceActionRequestInFlight === false")));
    agent.clearRecords();
    try {
      await attempt();
    } catch (error) {
      // A click swallowed while the app was busy never opens its confirm dialog; retry like a user.
      if (tries === 3) throw error;
      await page.keyboard.press("Escape").catch(() => {});
      continue;
    }
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && agent.controlCalls().length === 0) await page.waitForTimeout(150);
    if (agent.controlCalls().length > 0) break;
  }
  await page.waitForTimeout(1200); // a duplicate call would show up here
  const calls = agent.controlCalls();
  if (calls.length !== 1) console.error(`[driveLifecycle:${label}] unexpected control calls; timeline: ${JSON.stringify(agent.callLog().map((entry) => ({ ...entry, at: entry.at - Date.now() })))}`);
  return calls;
}

async function confirmDialog(page, labelPattern) {
  const confirm = page.getByRole("button", { name: labelPattern }).last();
  await confirm.waitFor({ state: "visible", timeout: 8000 });
  await confirm.click();
}

const LOCKED_SELECTORS = [
  '[data-instance-action="rename"]',
  '[data-instance-action="duplicate"]',
  '[data-instance-action="delete"]',
];

async function scenarioRunning(report) {
  const agent = await startServiceManagedAgent({ initial: "running", extraInstances: [PLAIN_ID] });
  const ui = await launch(agent);
  const { page } = ui;
  const eventually = (label, assertion, timeoutMs) => eventuallyOn(page, label, assertion, timeoutMs);
  try {
    agent.clearRecords();
    await waitFor(page, "service-managed row", () => rowInfo(page, INSTANCE_ID));
    let row = null;
    await eventually("row renders as a running systemd service with Stop/Reload enabled", async () => {
      row = await rowInfo(page, INSTANCE_ID);
      assert.match(row.text, /systemd service/i, "type renders as 'systemd service'");
      assert.match(row.text, /RUNNING/i);
      assert.strictEqual(row.buttons.start.disabled, true, "Start is disabled while the service runs");
      assert.strictEqual(row.buttons.stop.disabled, false);
      assert.strictEqual(row.buttons.restart.disabled, false);
    });

    await selectRow(page, INSTANCE_ID);
    assert.match(await noticeText(page), /anxrp-fxserver\.service is run by systemd/, "the Managed-by-systemd notice names the unit");
    await page.screenshot({ path: path.join(artifactDir, "running-overview.png") });
    const detail = await page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll("[data-instance-detail]")).map((el) => [el.dataset.instanceDetail, el.textContent.trim()])));
    assert.strictEqual(detail.ownership, "Managed by systemd");
    assert.strictEqual(detail.command, "systemd · anxrp-fxserver.service");
    assert.match(detail.pid, /^4242 \(owned by systemd\)$/, "systemd's PID is shown, labelled as not the Agent's");
    assert.strictEqual(detail.type, "systemd service");

    // Everything the Agent refuses is disabled, with a reason.
    await assertLocked(page, "overview", LOCKED_SELECTORS);
    await openTab(page, "console");
    await assertLocked(page, "console", ["[data-instance-console-command]", "[data-instance-console-form] button"]);
    const placeholder = await page.evaluate(() => document.querySelector("[data-instance-console-command]").placeholder);
    assert.match(placeholder, /not available for this service/i);
    await eventually("journal lines are shown in the console (redacted)", async () => {
      const journal = await page.evaluate(() => document.querySelector("[data-instance-panel='console']").innerText);
      assert.match(journal, /JOURNAL/);
      assert.ok(!/hunter2secretvalue/.test(journal), "secrets in journal lines are redacted");
    });
    await page.screenshot({ path: path.join(artifactDir, "running-console.png") });
    await openTab(page, "files");
    await assertLocked(page, "files", ['[data-instance-file-action="new-folder"]', '[data-instance-file-action="delete"]', '[data-instance-file-action="save"]']);
    await openTab(page, "backups");
    await assertLocked(page, "backups", ['[data-instance-backup-action="backup-now"]', '[data-instance-backup-action="restore"]', '[data-instance-backup-action="schedule"]', '[data-restart-schedule-action="create"]']);
    await page.screenshot({ path: path.join(artifactDir, "running-backups.png") });
    await openTab(page, "settings");
    const settings = await controls(page, '[data-instance-panel="settings"] input, [data-instance-panel="settings"] select, [data-instance-panel="settings"] textarea');
    assert.ok(settings.length > 5 && settings.every((control) => control.disabled), "every settings field is disabled");
    await eventually("Forget (Agent record only) stays available", async () => {
      const forget = await controls(page, '[data-instance-panel="settings"] [data-instance-action="forget"]');
      assert.ok(forget.length === 1 && forget[0].disabled === false, JSON.stringify(forget));
    });
    await page.screenshot({ path: path.join(artifactDir, "running-settings.png") });
    const gameConfig = await page.evaluate(() => document.querySelector("[data-instance-panel='settings']").innerText);
    assert.ok(!/will be created on save/.test(gameConfig), "no misleading 'server.cfg will be created on save'");
    assert.match(gameConfig, /not supported for this instance/i);

    // Locks survive a refresh, which re-runs the generic button updaters.
    await clickVisibleEnabled(page, '[data-instance-action="refresh"]');
    await page.waitForTimeout(1500);
    await openTab(page, "overview");
    await assertLocked(page, "after refresh", LOCKED_SELECTORS);

    // Real lifecycle through the UI: each click is exactly one systemd call.
    await openTab(page, "overview");
    assert.deepStrictEqual(await driveLifecycle(page, agent, "stop", async () => {
      await clickVisibleEnabled(page, '[data-instance-action="stop"]');
      await confirmDialog(page, /^Stop Server$/);
    }), [["stop", agent.unit]], "Stop is exactly one systemd call");
    await waitFor(page, "row shows Stopped", async () => /STOPPED/i.test((await rowInfo(page, INSTANCE_ID))?.text || ""));
    await eventually("Start is enabled once stopped", async () => {
      row = await rowInfo(page, INSTANCE_ID);
      assert.strictEqual(row.buttons.start.disabled, false);
    });
    await page.screenshot({ path: path.join(artifactDir, "stopped.png") });

    assert.deepStrictEqual(await driveLifecycle(page, agent, "start", async () => {
      await clickVisibleEnabled(page, '[data-instance-action="start"]');
    }), [["start", agent.unit]], "Start is exactly one systemd call");
    await waitFor(page, "row shows Running", async () => /RUNNING/i.test((await rowInfo(page, INSTANCE_ID))?.text || ""));

    assert.deepStrictEqual(await driveLifecycle(page, agent, "restart", async () => {
      await clickVisibleEnabled(page, '[data-instance-action="restart"]');
      await confirmDialog(page, /^Restart Server$/);
    }), [["restart", agent.unit]], "Reload is one atomic restart");
    assert.deepStrictEqual(agent.spawnAttempts(), [], "the Agent launched no process during UI-driven lifecycle");

    // The Reload above may still be settling; the app's own enable logic (not our lock)
    // keeps controls disabled until it finishes. Wait for the app to be idle instead of sleeping.
    await waitFor(page, "instance operation settled", () => page.evaluate(() => window.eval("instanceActionRequestInFlight === false")));

    // Selecting an ORDINARY instance afterwards gets its controls back.
    await selectRow(page, PLAIN_ID);
    await eventually("systemd notice is hidden for an ordinary instance", async () => {
      assert.strictEqual(await noticeText(page), "");
    });
    await eventually("ordinary instance header actions usable again", async () => {
      for (const selector of LOCKED_SELECTORS) {
        const found = await controls(page, selector);
        assert.ok(found.length > 0 && found.every((control) => !control.disabled && !isLockReason(control.title)), `ordinary instance: ${selector} must be usable again (${JSON.stringify(found)})`);
      }
    });
    await openTab(page, "console");
    await eventually("ordinary instance console usable again", async () => {
      const plainConsole = await controls(page, "[data-instance-console-command]");
      assert.ok(plainConsole.length === 1 && !plainConsole[0].disabled, "console input is usable again");
      const plainPlaceholder = await page.evaluate(() => document.querySelector("[data-instance-console-command]").placeholder);
      assert.ok(!/not available for this service/i.test(plainPlaceholder), "console placeholder restored");
    });
    await openTab(page, "backups");
    await eventually("ordinary instance backups usable again", async () => {
      const plainBackups = await controls(page, '[data-instance-backup-action="backup-now"]');
      assert.ok(plainBackups.length === 1 && !plainBackups[0].disabled, "backups usable again");
    });
    await openTab(page, "settings");
    await eventually("ordinary instance settings editable again", async () => {
      const plainSettings = await controls(page, '[data-instance-panel="settings"] input[data-instance-config="displayName"]');
      assert.ok(plainSettings.length === 1 && !plainSettings[0].disabled, "settings editable again");
    });

    // And locked again when coming back.
    await selectRow(page, INSTANCE_ID);
    await openTab(page, "overview");
    await eventually("re-selected service-managed instance is locked again", () => assertLocked(page, "re-selected service-managed", LOCKED_SELECTORS));

    assert.deepStrictEqual(ui.rendererErrors.filter((entry) => !/Unlock AnxOS|AGENT_UNAVAILABLE/i.test(entry)), [], "no renderer errors");
    report.push("S1 running: render, locks (persist across tabs/refresh), UI lifecycle = single systemd calls, locks release for ordinary instances");
  } finally {
    await ui.close();
    await agent.stop();
  }
}

async function scenarioUnknown(report) {
  const agent = await startServiceManagedAgent({ initial: "running", failDescribe: "SERVICE_UNIT_NOT_ALLOWED" });
  const ui = await launch(agent);
  const { page } = ui;
  try {
    agent.clearRecords();
    await waitFor(page, "service-managed row", () => rowInfo(page, INSTANCE_ID));
    await eventuallyOn(page, "an unverifiable service is Unknown (never Stopped) with every lifecycle button disabled", async () => {
      const row = await rowInfo(page, INSTANCE_ID);
      assert.match(row.text, /UNKNOWN/i);
      assert.ok(!/STOPPED/i.test(row.text));
      assert.strictEqual(row.buttons.start.disabled, true, "Start disabled while unverified (fail closed)");
      assert.strictEqual(row.buttons.stop.disabled, true, "Stop disabled while unverified");
      assert.strictEqual(row.buttons.restart.disabled, true, "Reload disabled while unverified");
    });
    await selectRow(page, INSTANCE_ID);
    await eventuallyOn(page, "the reason is explained in the notice", async () => {
      assert.match(await noticeText(page), /not on the Agent's allowlist/i);
    });
    await eventuallyOn(page, "failure reason is human-readable, not a raw code", async () => {
      const detail = await page.evaluate(() => Object.fromEntries(Array.from(document.querySelectorAll("[data-instance-detail]")).map((el) => [el.dataset.instanceDetail, el.textContent.trim()])));
      assert.match(detail.failureReason, /not on the Agent's allowlist/i);
    });
    await eventuallyOn(page, "lifecycle controls disabled while unverified", async () => {
      for (const action of ["start", "stop", "restart"]) {
        const found = await controls(page, `[data-instance-action="${action}"]`);
        assert.ok(found.every((control) => control.disabled), `${action} is disabled in the workspace`);
      }
    });
    assert.deepStrictEqual(agent.controlCalls(), []);
    await page.screenshot({ path: path.join(artifactDir, "unknown.png") });
    report.push("S2 unknown: shown as Unknown with a readable reason; Start/Stop/Reload all disabled; no systemd call");
  } finally {
    await ui.close();
    await agent.stop();
  }
}

async function scenarioFailed(report) {
  const agent = await startServiceManagedAgent({ initial: "failed" });
  const ui = await launch(agent);
  const { page } = ui;
  try {
    await waitFor(page, "service-managed row", () => rowInfo(page, INSTANCE_ID));
    await eventuallyOn(page, "a failed service is shown as Failed and can be started", async () => {
      const row = await rowInfo(page, INSTANCE_ID);
      assert.match(row.text, /FAILED/i);
      assert.strictEqual(row.buttons.start.disabled, false);
    });
    await selectRow(page, INSTANCE_ID);
    assert.deepStrictEqual(await driveLifecycle(page, agent, "start from failed", async () => {
      await clickVisibleEnabled(page, '[data-instance-action="start"]');
    }), [["start", agent.unit]], "Start from Failed is exactly one systemd call");
    await waitFor(page, "row shows Running", async () => /RUNNING/i.test((await rowInfo(page, INSTANCE_ID))?.text || ""));
    report.push("S3 failed: Start from the UI reaches systemd once; the instance becomes Running");
  } finally {
    await ui.close();
    await agent.stop();
  }
}

async function scenarioOperations(report) {
  const agent = await startServiceManagedAgent({
    initial: "running",
    operations: true,
    deployment: {
      schema: 1,
      agentBuild: { origin: "local-unofficial", artifactVersion: "2.0-build206", builtFromCommit: "cc862de", note: "temporary package" },
      rollback: { artifact: { name: "AnxOS-Agent-2.0-build205.deb", path: "/nonexistent/AnxOS-Agent-2.0-build205.deb", sha256: "b".repeat(64) }, backup: { dir: "/nonexistent/anxos-agent-backup", createdAt: "2026-10-07T22:20:31Z" } },
      notes: ["Rollback package kept intact"],
    },
  });
  const ui = await launch(agent);
  const { page } = ui;
  const eventually = (label, assertion, timeoutMs) => eventuallyOn(page, label, assertion, timeoutMs);
  const text = (selector) => page.evaluate((sel) => document.querySelector(sel)?.innerText.replace(/\s+/g, " ").trim() || "", selector);
  const field = (name) => text(`[data-service-ops] [data-service-field="${name}"]`);
  try {
    await waitFor(page, "service-managed row", () => rowInfo(page, INSTANCE_ID));
    await selectRow(page, INSTANCE_ID);

    // ---- the panel: SYSTEMD MANAGED, systemd facts, AnxRP evidence, players, ports, build, rollback ----
    await eventually("operations panel loads live evidence", async () => {
      assert.strictEqual(await text("[data-service-ops] [data-service-badge]"), "SYSTEMD MANAGED");
      assert.match(await field("mainPid"), /^4242 - owned by systemd$/);
      assert.match(await field("systemdState"), /^active \(running\)$/);
      assert.match(await field("uptime"), /\d/);
      assert.strictEqual(await field("anxrpState"), "READY");
      assert.strictEqual(await field("bootId"), "boot-1");
      assert.strictEqual(await field("version"), "0.5.0");
      assert.strictEqual(await field("players"), "0 connected");
      assert.match(await field("listeners"), /30120 listening/);
    }, 20000).catch(async (error) => {
      const state = await page.evaluate(() => window.eval("JSON.stringify({ id: serviceOps.instanceId, error: serviceOps.error, loading: serviceOps.loading, hasOverview: Boolean(serviceOps.overview), loadedAt: serviceOps.loadedAt })")).catch((e) => String(e));
      console.error(`panel state: ${state}`);
      throw error;
    });
    const warning = await text("[data-service-build-warning]");
    assert.match(warning, /unofficial\/local build/i, "unofficial build warning");
    assert.match(warning, /cc862de/);
    const rollback = await text("[data-service-rollback]");
    assert.match(rollback, /AnxOS-Agent-2\.0-build205\.deb/);
    assert.match(rollback, /bbbbbbbbbbbb/, "rollback hash prefix");
    assert.match(rollback, /missing/i, "a rollback path that is not on disk is flagged");
    assert.match(rollback, /anxos-agent-backup/);
    await page.locator("[data-service-ops]").screenshot({ path: path.join(artifactDir, "ops-panel.png") });

    // ---- refusals stay refused, each with its own explanation ----
    await openTab(page, "settings");
    const forceKill = await controls(page, '[data-instance-action="force-kill"]');
    await openTab(page, "overview");
    assert.ok(forceKill.length > 0 && forceKill.every((control) => control.disabled && /does not own this process/.test(control.title)), JSON.stringify(forceKill));
    await assertLocked(page, "operations scenario", LOCKED_SELECTORS);
    await page.locator("[data-service-why] summary").click();
    const why = await text("[data-service-why-list]");
    for (const label of ["Force kill", "Delete", "Duplicate", "Backups", "Scheduled restarts", "Console commands"]) assert.match(why, new RegExp(label), `why-list covers ${label}`);
    await page.locator("[data-service-ops]").screenshot({ path: path.join(artifactDir, "ops-why-disabled.png") });
    await page.locator("[data-service-why] summary").click();
    await openTab(page, "console");
    await eventually("journal is read-only in the console", async () => {
      assert.match(await page.evaluate(() => document.querySelector("[data-instance-panel='console']").innerText), /JOURNAL/);
      assert.strictEqual((await controls(page, "[data-instance-console-command]"))[0].disabled, true);
    });
    await openTab(page, "overview");

    // ---- Safe Restart refused while players are connected: nothing is restarted ----
    agent.setPlayers(2);
    await page.locator("[data-service-refresh]").click();
    await eventually("panel shows the players", async () => assert.strictEqual(await field("players"), "2 connected"), 20000);
    await page.locator("[data-service-safe-restart]").click();
    await eventually("preflight lists the failed player check", async () => {
      const checks = await page.evaluate(() => Array.from(document.querySelectorAll("[data-service-preflight] li")).map((li) => ({ id: li.dataset.checkId, status: li.dataset.status, text: li.innerText })));
      const players = checks.find((check) => check.id === "players");
      assert.ok(players && players.status === "fail" && /2 player\(s\) connected/.test(players.text), JSON.stringify(checks));
    });
    assert.strictEqual(await page.locator("[data-service-safe-confirm]").isDisabled(), true, "cannot confirm a failed preflight");
    await page.locator("[data-service-ops]").screenshot({ path: path.join(artifactDir, "ops-preflight-refused.png") });
    await page.locator("[data-service-safe-cancel]").click();
    assert.strictEqual(agent.restartCalls().length, 0, "a refused preflight restarted nothing");

    // ---- an unverifiable player count is refused too ----
    agent.setPlayers(0);
    agent.setFxDown(true);
    await page.locator("[data-service-refresh]").click();
    await page.waitForTimeout(800);
    await page.locator("[data-service-safe-restart]").click();
    await eventually("unverifiable players fails the preflight", async () => {
      const status = await page.evaluate(() => document.querySelector("[data-service-preflight] li[data-check-id='players']")?.dataset.status);
      assert.strictEqual(status, "fail");
    });
    await page.locator("[data-service-safe-cancel]").click();
    agent.setFxDown(false);
    assert.strictEqual(agent.restartCalls().length, 0);

    // ---- the real thing: preflight, confirm, progress, result ----
    await page.locator("[data-service-refresh]").click();
    await eventually("evidence is healthy again", async () => assert.strictEqual(await field("players"), "0 connected"), 20000);
    await page.locator("[data-service-safe-restart]").click();
    await waitFor(page, "preflight passes and Confirm is offered", () => page.evaluate(() => { const b = document.querySelector("[data-service-safe-confirm]"); return b && !b.hidden && !b.disabled; }));
    await page.locator("[data-service-ops]").screenshot({ path: path.join(artifactDir, "ops-preflight-ok.png") });
    await page.locator("[data-service-safe-confirm]").click();
    await waitFor(page, "Safe Restart is running", () => page.evaluate(() => window.eval("serviceOps.running === true")));
    const lockedWhileRunning = await controls(page, '[data-instance-action="restart"], [data-instance-action="stop"], [data-instance-action="start"]');
    assert.ok(lockedWhileRunning.every((control) => control.disabled), "lifecycle buttons are locked during Safe Restart");
    await waitFor(page, "progress steps appear", () => page.evaluate(() => document.querySelectorAll("[data-service-progress] li").length >= 3));
    await page.locator("[data-service-ops]").screenshot({ path: path.join(artifactDir, "ops-running.png") });
    await waitFor(page, "Safe Restart finished", () => page.evaluate(() => window.eval("serviceOps.running === false")), 45000);
    await eventually("result states success with new PID and boot id", async () => {
      const result = await text("[data-service-result]");
      assert.match(result, /Safe Restart succeeded: MainPID 4242 -> \d+, boot boot-1 -> boot-2, AnxRP READY/);
    }, 20000);
    await eventually("panel shows the new boot id", async () => {
      assert.strictEqual(await field("bootId"), "boot-2");
      assert.strictEqual(await field("anxrpState"), "READY");
    }, 20000);
    await eventually("history records the success", async () => {
      assert.match(await text("[data-service-history]"), /SAFE-RESTART - SUCCEEDED\./i);
    }, 20000);
    assert.strictEqual(agent.restartCalls().length, 1, "exactly one systemctl restart for the whole flow");
    assert.deepStrictEqual(agent.spawnAttempts(), [], "the Agent launched no process");
    await page.locator("[data-service-ops]").screenshot({ path: path.join(artifactDir, "ops-succeeded.png") });
    await eventually("lifecycle buttons are released after the run", async () => {
      const restart = await controls(page, '[data-instance-action="restart"]');
      assert.ok(restart.length > 0 && restart.every((control) => !control.disabled), JSON.stringify(restart));
    }, 20000);
    assert.deepStrictEqual(ui.rendererErrors.filter((entry) => !/Unlock AnxOS|AGENT_UNAVAILABLE/i.test(entry)), [], "no renderer errors");
    report.push("S4 operations: live evidence, unofficial-build + rollback visibility, per-control explanations, refusals with players/unverifiable players, one-click Safe Restart = exactly one restart with progress, result and history");
  } finally {
    await ui.close();
    await agent.stop();
  }
}

async function main() {
  const report = [];
  const only = process.argv[2];
  const scenarios = { running: scenarioRunning, unknown: scenarioUnknown, failed: scenarioFailed, operations: scenarioOperations };
  for (const [name, run] of Object.entries(scenarios)) {
    if (only && only !== name) continue;
    await run(report);
  }
  console.log(report.join("\n"));
  console.log(`service-managed UI QA passed (screenshots: ${artifactDir})`);
}

main().then(() => process.exit(0), (error) => {
  console.error(error);
  process.exit(1);
});
