#!/usr/bin/env node
"use strict";

// Issue #53 in the REAL Electron app (isolated profile and config, --qa-mode)
// against two disposable test Agents on this PC. Each Agent loads
// test-helpers/steamcmd-cancel-preload.js: SteamCMD is a fake that only
// records spawns, and the pre-update backup waits until this script
// releases it. Never touches the installed app, its Local Agent or real
// servers.
//   S1 Build 213 Agent: Update server files (backup on), Cancel in the
//      Download Manager while the backup runs; after the backup finishes,
//      SteamCMD never started, the build is unchanged and the row says
//      Cancelled
//   S2 Agent without cancelBeforeStart (what Build 212 reports): while the
//      backup runs, the row offers no Cancel and says why; once released
//      the update completes normally
// Run: node scripts/steamcmd-cancel-ui-qa.js

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");

const appRoot = path.resolve(process.env.ANX_QA_APP_ROOT || path.join(__dirname, ".."));
const shotsDir = process.env.STEAM_CANCEL_QA_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "anx-steam-cancel-shots-"));
const PRELOAD = path.join(__dirname, "test-helpers", "steamcmd-cancel-preload.js");
const APP_ID = 896660;
const SERVER_ID = "qa-steam-cancel";

async function waitFor(page, predicate, arg, label, timeoutMs = 30000) {
  try {
    await page.waitForFunction(predicate, arg, { timeout: timeoutMs });
  } catch (error) {
    throw new Error(`Timed out waiting for ${label}: ${error.message.split("\n")[0]}`);
  }
}

async function until(check, label, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function startSteamAgent(legacy) {
  const control = fs.mkdtempSync(path.join(os.tmpdir(), "anx-steam-cancel-control-"));
  // The page's own Steam build check must not hold the SteamCMD lock here;
  // the queue window is covered by steamcmd-update-cancel-smoke C3.
  fs.writeFileSync(path.join(control, "release-lookup"), "go");
  const agent = await startServiceManagedAgent({
    initial: "running",
    extraPreload: PRELOAD,
    env: {
      ANXOS_QA_STEAM_CONTROL: control,
      AGENT_INSTANCE_EXECUTABLE_ROOTS: path.dirname(process.execPath),
      ...(legacy ? { ANXOS_QA_LEGACY_STATUS: "1" } : {}),
    },
  });
  const created = await agent.api("POST", "/api/v1/instances", { id: SERVER_ID, displayName: "QA Steam server", type: "custom-command", executable: process.execPath, args: ["-e", "0"] });
  assert.ok([200, 201].includes(created.status), `test server created (${created.status} ${created.text.slice(0, 200)})`);
  const instanceDir = path.join(agent.home, "instances", SERVER_ID);
  const configPath = path.join(instanceDir, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, `${JSON.stringify({ ...config, installerType: "steamcmd-native", steamAppId: APP_ID, steamInstallDir: "server" }, null, 2)}\n`);
  const manifest = path.join(instanceDir, "data", "server", "steamapps", `appmanifest_${APP_ID}.acf`);
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, `"AppState"\n{\n\t"StateFlags"\t\t"4"\n\t"buildid"\t\t"41"\n}\n`);
  return {
    agent,
    control,
    spawns: () => (fs.existsSync(path.join(control, "spawns.log")) ? fs.readFileSync(path.join(control, "spawns.log"), "utf8").trim().split("\n").filter(Boolean).length : 0),
    build: () => fs.readFileSync(manifest, "utf8").match(/"buildid"\s+"(\d+)"/)[1],
    started: (name) => fs.existsSync(path.join(control, name)),
    release: (name) => fs.writeFileSync(path.join(control, name), "go"),
  };
}

// Server page > Update server files > keep "Back up the server first" ticked.
async function startUpdateFromServerPage(page, nodeId) {
  // The test signs in through the API; the renderer refreshes its own copy.
  await page.evaluate(async (node) => { await refreshSecurityState(); await selectNode(node); window.showPage("instances"); await refreshInstances({ refreshMetrics: false }); }, nodeId);
  await waitFor(page, (id) => getInstances().some((entry) => entry.id === id), SERVER_ID, "the test server in the list");
  await page.evaluate((id) => selectInstance(id), SERVER_ID);
  await waitFor(page, () => !instancesRequestInFlight && !instanceActionRequestInFlight, null, "an idle server page");
  await page.evaluate((id) => window.AnxServerView.open(id), SERVER_ID);
  try {
    await waitFor(page, () => [...document.querySelectorAll('[data-instance-action="update-steam"]')].some((button) => button.offsetParent && !button.disabled), null, "an enabled Update server files button");
  } catch (error) {
    const seen = await page.evaluate((id) => ({
      buttons: [...document.querySelectorAll('[data-instance-action="update-steam"]')].map((button) => ({ visible: Boolean(button.offsetParent), disabled: button.disabled, hidden: button.hidden, text: button.textContent.trim(), title: button.title })),
      selected: (({ id: i, state, installerType, steamAppId, type }) => ({ i, state, installerType, steamAppId, type }))(findInstance() || {}),
      page: document.querySelector(".page.is-active, [data-page].is-active")?.dataset?.page || null,
      listed: (typeof getInstances === "function" ? getInstances() : []).map((entry) => entry.id),
    }), SERVER_ID);
    throw new Error(`${error.message} ${JSON.stringify(seen)}`);
  }
  await page.locator('[data-instance-action="update-steam"]:visible').first().click();
  await waitFor(page, () => Boolean(document.querySelector("[data-confirm-ok]")), null, "the update confirmation");
  const dialog = await page.evaluate(() => {
    const modal = document.querySelector("[data-confirm-ok]").closest(".app-modal");
    const box = modal?.querySelector('input[type="checkbox"]');
    return { text: modal?.textContent || "", backupChecked: box ? box.checked : null };
  });
  assert.ok(/Back up the server first/.test(dialog.text) && dialog.backupChecked === true, `the backup option is offered and ticked (${JSON.stringify(dialog)})`);
  await page.locator("[data-confirm-ok]").last().click();
}

async function downloadRow(page) {
  return page.evaluate(() => {
    refreshMarketplaceDownloads();
    const rows = [...document.querySelectorAll("[data-download-list] .download-item")];
    const row = rows.find((entry) => /Update server files/i.test(entry.textContent));
    if (!row) return null;
    row.scrollIntoView({ block: "center" });
    return {
      id: row.dataset.downloadId,
      status: row.dataset.status,
      text: row.textContent,
      cancel: [...row.querySelectorAll("button")].some((button) => button.textContent.trim() === "Cancel"),
    };
  });
}

async function main() {
  const current = await startSteamAgent(false);
  const legacy = await startSteamAgent(true);
  const qa = createIsolatedQaEnv("anx-steam-cancel-qa-config-");
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "lab", nodes: [
    { id: "lab", kind: "agent", name: "Lab", displayName: "Lab", baseUrl: current.agent.url, agentUrl: current.agent.url, enabled: true },
    { id: "old", kind: "agent", name: "Old Agent", displayName: "Old Agent", baseUrl: legacy.agent.url, agentUrl: legacy.agent.url, enabled: true },
  ] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { lab: { agentToken: current.agent.token }, old: { agentToken: legacy.agent.token } } });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-steam-cancel-qa-profile-"));
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", appRoot, "--qa-mode"], env });
  const errors = [];
  const shot = (page, name) => page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 960));
    await waitFor(page, () => typeof window.showPage === "function", null, "renderer", 60000);
    const useDevice = page.getByRole("button", { name: "Use this device" }).first();
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    const testPassword = `Qa-${crypto.randomBytes(12).toString("hex")}-Zz9!`;
    const setupError = await page.evaluate(async (password) => {
      const security = window.anxhub?.security || window.anx?.security;
      const created = await security.setupAdmin({ username: "qa-owner", password, passwordConfirm: password }).catch((error) => ({ error: error?.message }));
      if (created?.error) return created.error;
      return security.login({ username: "qa-owner", password }).then(() => null).catch((error) => error?.message || "login failed");
    }, testPassword);
    assert.strictEqual(setupError, null, `QA owner setup failed: ${setupError}`);
    await page.waitForTimeout(1000);

    // S1
    await startUpdateFromServerPage(page, "lab");
    await until(() => current.started("backup-started"), "the pre-update backup to start");
    await page.evaluate(() => window.showPage("marketplace"));
    let row = null;
    await until(async () => { row = await downloadRow(page); return row?.cancel === true; }, "a Cancel button while the backup runs");
    assert.ok(/Backing up/.test(row.text), `the row shows the backup stage (${row.text.slice(0, 200)})`);
    await shot(page, "s1-backup-with-cancel");
    await page.locator(`[data-download-id="${row.id}"] button`, { hasText: "Cancel" }).click();
    await page.waitForTimeout(1500);
    current.release("release-backup");
    await until(async () => { row = await downloadRow(page); return row && row.status === "canceled"; }, "the row to say Cancelled", 20000)
      .catch((error) => { throw new Error(`${error.message}: ${JSON.stringify(row)} spawns=${current.spawns()}`); });
    await page.waitForTimeout(2000);
    assert.strictEqual(current.spawns(), 0, "SteamCMD never started after Cancel");
    assert.strictEqual(current.build(), "41", "the server files are unchanged");
    await shot(page, "s1-cancelled");
    console.log("PASS S1 Cancel clicked during the pre-update backup: SteamCMD never started, build 41 kept, row says Cancelled");

    // S2
    await startUpdateFromServerPage(page, "old");
    await until(() => legacy.started("backup-started"), "the older Agent's backup to start");
    await page.evaluate(() => window.showPage("marketplace"));
    await until(async () => { row = await downloadRow(page); return row && /Cancel is available once SteamCMD starts/.test(row.text); }, "the explanation on the older Agent's row");
    assert.strictEqual(row.cancel, false, "no Cancel while the older Agent would ignore it");
    await shot(page, "s2-older-agent-no-cancel");
    legacy.release("release-backup");
    await until(async () => { row = await downloadRow(page); return row && row.status === "completed"; }, "the older Agent's update to finish", 30000)
      .catch((error) => { throw new Error(`${error.message}: ${JSON.stringify(row)} spawns=${legacy.spawns()}`); });
    assert.strictEqual(legacy.spawns(), 1);
    assert.strictEqual(legacy.build(), "42");
    console.log("PASS S2 older Agent: no Cancel during the backup and the row says why; the update then completed (build 42)");

    assert.deepStrictEqual(errors, [], `no renderer errors (${errors.join(" | ")})`);
    console.log(`Steam cancel UI QA passed (2 checks). Screenshots: ${shotsDir}`);
  } finally {
    await app.close().catch(() => {});
    await current.agent.stop().catch(() => {});
    await legacy.agent.stop().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
