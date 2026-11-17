#!/usr/bin/env node
"use strict";

// Build 213 features in the REAL Electron app (isolated profile and config,
// --qa-mode, a test Agent on this PC started by this script). Never touches the
// installed app, its Local Agent or its data.
//   B1 My Servers › All computers lists the test Agent's servers with their
//      computer, keeps the offline computer visible, and Open switches to the
//      server's computer and opens its page
//   C1 the automatic Agent update switch saves agent-auto-update.json, Turn
//      off now switches it off; a running service-managed server does not
//      block an update and the attempt is in the history; the computer list
//      says "up to date" / "not connected" instead of "can't update from here"
//   D1 the move dialog blocks with plain reasons
//   C2 (RC1 acceptance) the saved settings show before the slow computer
//      list, nothing can be saved before they load, and Save keeps the
//      chosen computers while the list loads
// Set BUILD213_QA_SHOTS=<dir> to keep screenshots; BUILD213_QA_ONLY=B1,...
// runs a subset.
// Run: node scripts/build213-ui-qa.js

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");

const appRoot = path.resolve(process.env.ANX_QA_APP_ROOT || path.join(__dirname, ".."));
const shotsDir = process.env.BUILD213_QA_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "anx-build213-shots-"));
const only = new Set(String(process.env.BUILD213_QA_ONLY || "").split(",").map((value) => value.trim()).filter(Boolean));
const runs = (id) => !only.size || only.has(id);

async function waitFor(page, predicate, arg, label, timeoutMs = 30000) {
  try {
    await page.waitForFunction(predicate, arg, { timeout: timeoutMs });
  } catch (error) {
    throw new Error(`Timed out waiting for ${label}: ${error.message.split("\n")[0]}`);
  }
}

async function main() {
  const agent = await startServiceManagedAgent({ initial: "running" });
  const qa = createIsolatedQaEnv("anx-build213-qa-config-");
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "lab", nodes: [
    { id: "lab", kind: "agent", name: "Lab", displayName: "Lab", baseUrl: agent.url, agentUrl: agent.url, enabled: true },
    { id: "vps", kind: "agent", name: "VPS", displayName: "VPS", baseUrl: "http://127.0.0.1:9", agentUrl: "http://127.0.0.1:9", enabled: true },
  ] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { lab: { agentToken: agent.token }, vps: { agentToken: crypto.randomBytes(16).toString("hex") } } });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-build213-qa-profile-"));
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", appRoot, "--qa-mode"], env });
  const errors = [];
  const shot = (page, name) => page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
  const failures = [];
  let passed = 0;
  const check = async (id, fn) => {
    if (!runs(id)) return;
    try {
      await fn();
      passed += 1;
    } catch (error) {
      failures.push(`${id}: ${error.message}`);
      console.log(`FAIL ${id} ${error.message}`);
    }
  };
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 960));
    await waitFor(page, () => typeof window.showPage === "function", null, "renderer", 60000);
    const useDevice = page.getByRole("button", { name: "Use this device" }).first();
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    const testPassword = `Qa-${crypto.randomBytes(12).toString("hex")}-Zz9!`;
    const setup = await page.evaluate(async (password) => {
      const security = window.anxhub?.security || window.anx?.security;
      const created = await security.setupAdmin({ username: "qa-owner", password, passwordConfirm: password }).catch((error) => ({ error: error?.message }));
      return { error: created?.error || null };
    }, testPassword);
    assert.ok(!setup.error, `QA owner setup failed: ${setup.error}`);
    const login = await page.evaluate(async (password) => {
      const security = window.anxhub?.security || window.anx?.security;
      return security.login({ username: "qa-owner", password }).then(() => null).catch((error) => error?.message || "login failed");
    }, testPassword);
    assert.strictEqual(login, null, `QA owner unlock failed: ${login}`);

    // B1
    await check("B1", async () => {
      const listed = await page.evaluate(() => window.anx.instances.listAcrossComputers());
      const lab = listed.computers.find((computer) => computer.nodeId === "lab");
      const vps = listed.computers.find((computer) => computer.nodeId === "vps");
      assert.strictEqual(lab?.status, "online", `Lab is read live (${JSON.stringify(lab)})`);
      assert.notStrictEqual(vps?.status, "online", "the VPS is not connected");
      const labServers = listed.servers.filter((server) => server.nodeId === "lab");
      assert.ok(labServers.length >= 1, "Lab's servers are listed");
      assert.ok(labServers.every((server) => server.nodeName === "Lab" && !server.lastKnown), "each Lab server names its computer and is live");

      await page.evaluate(async () => { await selectNode("vps"); window.showPage("instances"); });
      await page.click("[data-servers-all-computers]");
      await waitFor(page, () => !document.querySelector("[data-server-fleet]").hidden && document.querySelector(".instances-main-shell").hidden, null, "the all-computers view", 15000);
      await waitFor(page, () => document.querySelectorAll("[data-server-fleet-row]").length >= 1, null, "fleet rows", 30000);
      const view = await page.evaluate(() => ({
        rows: [...document.querySelectorAll("[data-server-fleet-row]")].map((row) => [...row.children].map((cell) => cell.textContent.trim())),
        summary: document.querySelector("[data-server-fleet] .platform-note:not(.settings-section__header *)")?.textContent || "",
        pressed: document.querySelector("[data-servers-all-computers]").getAttribute("aria-pressed"),
        selected: getSelectedNodeId(),
      }));
      await shot(page, "b1-all-computers");
      assert.strictEqual(view.pressed, "true");
      assert.strictEqual(view.selected, "vps", "the offline VPS is still the selected computer");
      assert.ok(view.rows.some((cells) => cells[2] === "Lab"), `Lab's servers appear while the VPS is selected (${JSON.stringify(view.rows)})`);
      assert.ok(/VPS: not connected/.test(view.summary), `the VPS stays listed as not connected (${view.summary})`);

      await page.evaluate(() => [...document.querySelectorAll("[data-server-fleet-row]")].find((row) => row.children[2].textContent.trim() === "Lab").querySelector("button").click());
      await waitFor(page, () => getSelectedNodeId() === "lab" && document.querySelector("[data-server-fleet]").hidden, null, "switch to Lab", 30000);
      await page.waitForTimeout(1500);
      await shot(page, "b1-opened-on-lab");
      console.log(`PASS B1 All computers lists ${labServers.length} Lab server(s) while the offline VPS is selected, and Open switches to Lab`);
    });

    // C1
    await check("C1", async () => {
      const policyFile = path.join(qa.configDir, "agent-auto-update.json");
      const historyFile = path.join(qa.configDir, "agent-update-history.json");
      assert.ok(!fs.existsSync(policyFile), "a new profile has no automatic-update policy (off by default)");
      await page.evaluate(async () => { await selectNode("lab"); window.showPage("agent-control"); setActiveAgentControlSection("updates"); });
      await waitFor(page, () => /^Off\./.test(document.querySelector("[data-agent-auto-update-status]")?.textContent || ""), null, "the Off status", 30000);
      await waitFor(page, () => document.querySelectorAll('[data-agent-auto-update-computers] input[value="lab"]').length === 1, null, "Lab in the computer list", 30000);
      await page.evaluate(() => {
        const set = (selector, value) => {
          const input = document.querySelector(selector);
          if (input.type === "checkbox") input.checked = value; else input.value = value;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        set('[data-agent-auto-update-field="enabled"]', true);
        set('[data-agent-auto-update-field="mode"]', "apply");
        set('[data-agent-auto-update-field="start"]', "04:30");
        set('[data-agent-auto-update-field="durationMinutes"]', "180");
        set('[data-agent-auto-update-computers] input[value="lab"]', true);
        set('[data-agent-auto-update-days] input[value="0"]', false);
      });
      await page.click('[data-agent-auto-update-action="save"]');
      await waitFor(page, () => /^On: installs eligible updates/.test(document.querySelector("[data-agent-auto-update-status]")?.textContent || ""), null, "the On status", 15000);
      const saved = JSON.parse(fs.readFileSync(policyFile, "utf8"));
      assert.deepStrictEqual(saved, { enabled: true, mode: "apply", nodeIds: ["lab"], days: [1, 2, 3, 4, 5, 6], start: "04:30", durationMinutes: 180 }, `the file holds what was chosen (${JSON.stringify(saved)})`);
      await shot(page, "c1-auto-update-on");

      await page.click('[data-agent-auto-update-action="off"]');
      await waitFor(page, () => /^Off\./.test(document.querySelector("[data-agent-auto-update-status]")?.textContent || ""), null, "Off after Turn off now", 15000);
      const off = JSON.parse(fs.readFileSync(policyFile, "utf8"));
      assert.strictEqual(off.enabled, false, "Turn off now switches it off in the file");
      assert.deepStrictEqual(off.nodeIds, ["lab"], "other choices are kept");

      // Lab's only server is service-managed (systemd-service) and running. An
      // Agent restart does not stop it, so it must not block an update (the
      // update stops for its own reason: Lab has no SSH key profile). The
      // attempt is in the history either way.
      const outcome = await page.evaluate(() => window.anx.nodes.updateAgent("lab").then((result) => ({ ok: true, result }), (error) => ({ ok: false, message: error?.message || "error", code: error?.code || null })));
      const history = JSON.parse(fs.readFileSync(historyFile, "utf8")).entries;
      console.log(`  C1 update outcome: ${JSON.stringify(outcome).slice(0, 300)} | history: ${history[0]?.status} ${history[0]?.code}`);
      assert.ok(!/running on/.test(outcome.message || ""), `a running service-managed server does not block the update (${JSON.stringify(outcome)})`);
      assert.notStrictEqual(history[0].code, "REMOTE_AGENT_UPDATE_SERVERS_RUNNING", "the history does not say servers were running");
      await page.evaluate(() => window.AnxAgentAutoUpdate.load());
      await waitFor(page, () => document.querySelectorAll("[data-agent-update-history-row]").length >= 1, null, "the history row", 15000);
      // The computer list names an up-to-date or offline computer as such,
      // not "can't update from here".
      const notes = await page.evaluate(() => {
        const note = window.AnxAgentAutoUpdate._test.computerNote;
        return [note({ state: "up-to-date" }), note({ state: "offline" }), note({ state: "update-available", canUpdate: false }), note({ state: "update-available", canUpdate: true })];
      });
      assert.deepStrictEqual(notes, [" · up to date", " · not connected", " · can't update from here", ""]);
      await shot(page, "c1-auto-update-history");
      console.log("PASS C1 the toggle saves agent-auto-update.json exactly, Turn off now switches it off, a service-managed server does not block an update (history recorded), and computer labels are exact");
    });

    // D1
    await check("D1", async () => {
      // The test signs in through the API; the renderer reads its own copy of the
      // security state, so refresh it the way the app does after a sign-in.
      await page.evaluate(async () => { await refreshSecurityState(); await selectNode("lab"); window.showPage("instances"); await refreshInstances({ refreshMetrics: false }); });
      await waitFor(page, () => getInstances().length >= 1, null, "Lab's servers", 30000);
      const serverName = await page.evaluate(() => {
        const instance = getInstances()[0];
        selectInstance(instance.id);
        return instance.displayName || instance.id;
      });
      // The move dialog refuses to open while a list or action request runs.
      await waitFor(page, () => !instancesRequestInFlight && !instanceActionRequestInFlight && !workloadTransferInFlight, null, "an idle server page", 30000);
      await page.evaluate(() => { openWorkloadTransfer(findInstance()); });
      await waitFor(page, () => document.querySelectorAll("[data-migration-check]").length >= 3, null, "the move checks", 30000);
      const dialog = await page.evaluate(() => ({
        checks: [...document.querySelectorAll("[data-migration-check]")].map((row) => ({ id: row.dataset.migrationCheck, level: row.className.replace(/.*migration-check--/, ""), text: row.textContent })),
        previewDisabled: document.querySelector("[data-transfer-ok]").disabled,
      }));
      await shot(page, "d1-move-checks");
      const blocked = dialog.checks.filter((item) => item.level === "block").map((item) => item.id);
      assert.ok(blocked.includes("target"), `the offline VPS is named as not connected (${JSON.stringify(dialog.checks)})`);
      assert.ok(blocked.includes("stopped"), `the running server must be stopped first (${JSON.stringify(dialog.checks)})`);
      assert.strictEqual(dialog.previewDisabled, true, "Run Preview stays off while anything blocks");
      await page.click("[data-transfer-cancel]");
      console.log(`PASS D1 moving ${serverName} to the offline VPS is blocked with plain reasons (${blocked.join(", ")}), Run Preview disabled`);
    });

    // C2 (Build 213 RC1 acceptance): the computer list checks every Agent and
    // can take seconds. The saved settings must show without waiting for it,
    // nothing can be saved before they load, and Save keeps the chosen
    // computers while the list is still loading. Runs last: it replaces the
    // overview handler in this isolated app.
    await check("C2", async () => {
      const policyFile = path.join(qa.configDir, "agent-auto-update.json");
      const before = JSON.parse(fs.readFileSync(policyFile, "utf8"));
      assert.deepStrictEqual(before.nodeIds, ["lab"], "C1 left Lab chosen");
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler("nodes:agentUpdateOverview");
        ipcMain.handle("nodes:agentUpdateOverview", () => new Promise((resolve) => setTimeout(() => resolve(null), 8000)));
      });
      await page.reload();
      await waitFor(page, () => typeof window.showPage === "function", null, "renderer after reload", 60000);
      const early = await page.evaluate(() => ({
        save: document.querySelector('[data-agent-auto-update-action="save"]').disabled,
        off: document.querySelector('[data-agent-auto-update-action="off"]').disabled,
        toggle: document.querySelector('[data-agent-auto-update-field="enabled"]').disabled,
      }));
      assert.deepStrictEqual(early, { save: true, off: true, toggle: true }, `nothing can be changed before the settings load (${JSON.stringify(early)})`);
      const shownAt = Date.now();
      await page.evaluate(async () => { await refreshSecurityState(); await selectNode("lab"); window.showPage("agent-control"); setActiveAgentControlSection("updates"); });
      await waitFor(page, () => /^Off\./.test(document.querySelector("[data-agent-auto-update-status]")?.textContent || ""), null, "the saved settings before the computer list", 4000);
      const mid = await page.evaluate(() => ({
        computers: document.querySelector("[data-agent-auto-update-computers]").textContent,
        save: document.querySelector('[data-agent-auto-update-action="save"]').disabled,
      }));
      assert.ok(/Checking computers/.test(mid.computers), `the list says it is still checking (${mid.computers})`);
      assert.strictEqual(mid.save, false, "Save works once the settings are shown");
      await shot(page, "c2-settings-before-computers");
      const mtime = fs.statSync(policyFile).mtimeMs;
      await page.click('[data-agent-auto-update-action="save"]');
      const deadline = Date.now() + 10000;
      while (fs.statSync(policyFile).mtimeMs === mtime && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
      const after = JSON.parse(fs.readFileSync(policyFile, "utf8"));
      assert.notStrictEqual(fs.statSync(policyFile).mtimeMs, mtime, "Save wrote the file");
      assert.deepStrictEqual(after.nodeIds, ["lab"], `Save keeps Lab while the list is loading (${JSON.stringify(after)})`);
      assert.strictEqual(after.durationMinutes, before.durationMinutes, "and the saved window length, not a placeholder");
      console.log(`PASS C2 settings shown ${Math.round((Date.now() - shownAt) / 100) / 10} s after opening, with the computer list still loading; controls locked before; Save kept Lab and the window`);
    });

    const unexpected = errors.filter((message) => !/ResizeObserver loop/.test(message));
    if (unexpected.length) failures.push(`renderer errors: ${unexpected.join(" | ")}`);
    if (failures.length) throw new Error(`${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`);
    console.log(`Build 213 UI QA: ${passed} checks passed. Screenshots: ${shotsDir}`);
  } finally {
    await Promise.race([app.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 15000))]);
    await agent.stop().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
