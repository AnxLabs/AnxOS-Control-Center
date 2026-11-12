#!/usr/bin/env node
"use strict";

// Phase 5 server page, end to end in the REAL Electron app (isolated profile
// and config, --qa-mode) against a REAL Agent with a disposable stand-in
// Minecraft (Paper) server: a node process that prints Paper-style logs and
// answers console commands. Nothing outside temp folders is touched.
//   V1 a row opens the server on its own page: one header, six tabs, detail
//      tabs hidden; "All servers" goes back to the list;
//   V2 live state: Start in the header turns Overview to Running without a
//      manual refresh, and uptime counts up;
//   V3 console: commands reach the server and its answers stream in;
//   V4 settings: an invalid value is refused inline and nothing is saved; a
//      valid change is saved to the Agent and a running server shows
//      "restart to apply"; leaving with unsaved settings asks first;
//   V5 conflict: a save made from a stale copy is refused and the newer
//      value on the Agent is kept;
//   V6 add-ons: search, an install plan listing the required dependency,
//      approved install writes the verified files into plugins/, remove keeps
//      a backup copy. Modrinth is faked by intercepting fetch in the main
//      process for api.modrinth.com and cdn.modrinth.com only;
//   V7 no renderer errors;
//   V8 backups: Back up now adds a backup to this server's list; restore
//      shows its preview first and cancelling changes nothing;
//   V9 files: a dropped binary file is uploaded byte for byte.
// Screenshots are written to the artifacts folder printed at the end.
// Run: node scripts/server-view-ui-qa.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");
const { fakeMinecraftInstance } = require("./test-helpers/fake-minecraft-instance");

const root = path.resolve(__dirname, "..");
const SERVER_ID = "survival-test";

async function waitFor(page, predicate, arg, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, arg).catch(() => false)) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// Fake Modrinth, installed into the Electron main process. A Paper plugin
// that requires a library plugin; both files carry real SHA-512 hashes.
function installFakeModrinth({ app }) {
  return app.evaluate(async () => {
    const crypto = process.mainModule.require("crypto");
    const jar = (name) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`fake jar ${name}`)]);
    const files = { "homes-2.1.jar": jar("homes-2.1.jar"), "corelib-1.4.jar": jar("corelib-1.4.jar") };
    const sha = (name) => crypto.createHash("sha512").update(files[name]).digest("hex");
    const project = (id, title) => ({ id, project_id: id, slug: id, title, description: `${title} for testing`, project_type: "plugin", author: "QA", downloads: 1234, server_side: "required", client_side: "unsupported", icon_url: null, versions: ["1.21.1"], categories: ["paper"] });
    const version = (projectId, id, number, fileName, dependencies = []) => ({ id, project_id: projectId, name: number, version_number: number, game_versions: ["1.21.1"], loaders: ["paper"], version_type: "release", date_published: "2026-10-01T00:00:00Z", dependencies, files: [{ url: `https://cdn.modrinth.com/data/${projectId}/${fileName}`, filename: fileName, size: files[fileName].length, primary: true, hashes: { sha512: sha(fileName) } }] });
    const routes = {
      "/v2/project/homes": project("homes", "Homes"),
      "/v2/project/corelib": project("corelib", "CoreLib"),
      "/v2/project/homes/version": [version("homes", "homes-v21", "2.1", "homes-2.1.jar", [{ project_id: "corelib", dependency_type: "required" }])],
      "/v2/project/corelib/version": [version("corelib", "corelib-v14", "1.4", "corelib-1.4.jar")],
    };
    const realFetch = globalThis.__anxRealFetch || globalThis.fetch;
    globalThis.__anxRealFetch = realFetch;
    globalThis.__anxModrinthCalls = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "api.modrinth.com") {
        globalThis.__anxModrinthCalls.push(url.pathname);
        if (url.pathname === "/v2/search") return new Response(JSON.stringify({ hits: [project("homes", "Homes")], total_hits: 1, offset: 0, limit: 20 }), { status: 200, headers: { "content-type": "application/json" } });
        const body = routes[url.pathname];
        return new Response(JSON.stringify(body || { error: "not_found" }), { status: body ? 200 : 404, headers: { "content-type": "application/json" } });
      }
      if (url.hostname === "cdn.modrinth.com") {
        globalThis.__anxModrinthCalls.push(url.pathname);
        const name = url.pathname.split("/").pop();
        return files[name] ? new Response(files[name], { status: 200 }) : new Response("missing", { status: 404 });
      }
      return realFetch(input, init);
    };
    return Object.fromEntries(Object.keys(files).map((name) => [name, files[name].toString("base64")]));
  });
}

async function agentInstance(agent, id) {
  const response = await agent.api("GET", "/api/v1/instances");
  return (response.json?.instances || []).find((instance) => instance.id === id) || {};
}

let failureContext = async () => "";

async function main() {
  const agent = await startServiceManagedAgent({ initial: "stopped", extraInstanceConfigs: [fakeMinecraftInstance({ id: SERVER_ID })] });
  const serverData = path.join(agent.home, "instances", SERVER_ID, "data");
  const qa = createIsolatedQaEnv("anx-server-view-qa-config-");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-server-view-qa-profile-"));
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "anx-server-view-qa-"));
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "ovh", nodes: [{ id: "ovh", kind: "agent", name: "OVH", displayName: "OVH", baseUrl: agent.url, agentUrl: agent.url, enabled: true }] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { ovh: { agentToken: agent.token } } });
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", root, "--qa-mode"], env });
  const errors = [];
  const shot = (page, name) => page.screenshot({ path: path.join(artifacts, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 960));
    await waitFor(page, () => typeof window.showPage === "function", null, "app start", 60000);
    const useDevice = page.getByRole("button", { name: "Use this device" }).first();
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    await waitFor(page, () => (document.querySelector(".nav-menu")?.getBoundingClientRect().width || 0) > 0, null, "app shell", 60000);
    const jars = await installFakeModrinth({ app });
    // Record toasts so a failure can say what the app told the user.
    await page.evaluate(() => {
      const original = showToast;
      window.__toasts = [];
      showToast = (message, tone) => { window.__toasts.push(String(message)); return original(message, tone); };
    });
    failureContext = async () => page.evaluate(() => (window.__toasts || []).slice(-5).join(" | ")).catch(() => "");
    await page.evaluate(() => window.showPage("instances"));
    await waitFor(page, (id) => Boolean(document.querySelector(`[data-instances-list] tr[data-instance-id="${id}"]`)), SERVER_ID, "server row", 40000);

    // V1
    await page.locator(`[data-instances-list] tr[data-instance-id="${SERVER_ID}"] td`).first().click();
    const view = await page.evaluate(() => ({
      mode: document.querySelector('.page[data-page="instances"]').dataset.serverView,
      tabs: [...document.querySelectorAll(".instance-tabs [data-instance-tab]")].filter((tab) => !tab.hidden && tab.offsetParent).map((tab) => tab.textContent.trim()),
      listVisible: Boolean(document.querySelector(".instances-table-panel")?.offsetParent),
      name: document.querySelector('.server-header-main [data-instance-detail="name"]').textContent.trim(),
      game: document.querySelector('[data-server-header="game"]').textContent.trim(),
    }));
    assert.deepStrictEqual(view, { mode: "open", tabs: ["Overview", "Console", "Files", "Add-ons", "Backups", "Settings"], listVisible: false, name: "Survival Test", game: "Minecraft · Paper" });
    await shot(page, "01-overview-stopped");
    await page.locator("[data-server-view-back]").click();
    assert.strictEqual(await page.evaluate(() => document.querySelector('.page[data-page="instances"]').dataset.serverView), "list", "All servers returns to the list");
    await page.locator(`[data-instances-list] tr[data-instance-id="${SERVER_ID}"] td`).first().click();
    console.log("PASS V1 a row opens one server: header, six tabs, back to the list");

    // V2
    const statusLabel = () => page.evaluate(() => document.querySelector(".server-status__label")?.textContent || "");
    assert.strictEqual(await statusLabel(), "Stopped");
    await page.locator('.instance-quick-actions [data-instance-action="start"]').click();
    await waitFor(page, () => document.querySelector(".server-status__label")?.textContent === "Running", null, "Overview to show Running", 30000);
    const uptime = async () => page.evaluate(() => [...document.querySelectorAll(".server-card--status .server-fact")].find((row) => row.textContent.includes("Up for"))?.querySelector("strong")?.textContent || "");
    await waitFor(page, () => [...document.querySelectorAll(".server-card--status .server-fact")].some((row) => row.textContent.includes("Up for")), null, "uptime", 20000);
    const firstUptime = await uptime();
    await page.waitForTimeout(6000);
    assert.notStrictEqual(await uptime(), firstUptime, "uptime counts up without a manual refresh");
    await shot(page, "02-overview-running");
    console.log(`PASS V2 Start updates Overview live (Running, up ${firstUptime} → ${await uptime()})`);

    // V3
    await page.locator('[data-instance-tab="console"]').first().click();
    await waitFor(page, () => [...document.querySelectorAll("[data-instances-logs] li")].some((line) => line.textContent.includes("Done (")), null, "startup logs", 20000);
    await page.locator("[data-instance-console-command]").fill("say hello from AnxOS");
    await page.locator("[data-instance-console-command]").press("Enter");
    await waitFor(page, () => [...document.querySelectorAll("[data-instances-logs] li")].some((line) => line.textContent.includes("[Server] hello from AnxOS")), null, "the server's answer", 20000);
    await page.locator("[data-instance-console-command]").fill("list");
    await page.locator("[data-instance-console-command]").press("Enter");
    await waitFor(page, () => [...document.querySelectorAll("[data-instances-logs] li")].some((line) => line.textContent.includes("max of 20 players")), null, "list answer", 20000);
    const lineTexts = await page.evaluate(() => [...document.querySelectorAll("[data-instances-logs] li")].map((line) => line.textContent));
    assert.strictEqual(lineTexts.filter((text) => text.includes("[Server] hello from AnxOS")).length, 1, "each answer appears once");
    await shot(page, "03-console");
    // Clear view hides the lines but keeps the server's logs.
    await page.locator('[data-instance-action="clear-console"]').click();
    assert.strictEqual(await page.evaluate(() => document.querySelectorAll("[data-instances-logs] li").length), 0, "Clear view empties the console");
    const kept = await page.evaluate((id) => getDesktopApiState().api.instances.getLogs(id, { nodeId: getSelectedNodeId(), stream: "all", limit: 200 }).then((logs) => (logs.entries || []).some((entry) => String(entry.message).includes("Done ("))), SERVER_ID);
    assert.strictEqual(kept, true, "the server's captured logs are not deleted");
    await page.locator("[data-instance-console-command]").fill("say after clear");
    await page.locator("[data-instance-console-command]").press("Enter");
    await waitFor(page, () => [...document.querySelectorAll("[data-instances-logs] li")].some((line) => line.textContent.includes("[Server] after clear")), null, "new lines after Clear view", 20000);
    assert.strictEqual(await page.evaluate(() => [...document.querySelectorAll("[data-instances-logs] li")].some((line) => line.textContent.includes("Done ("))), false, "cleared lines stay hidden");
    console.log("PASS V3 console commands reach the server, answers stream in once, Clear view keeps the server's logs");

    // V4
    await page.locator('[data-instance-tab="settings"]').first().click();
    await waitFor(page, () => document.querySelector('[data-instance-config="memoryLimit"]')?.value === "2G", null, "settings loaded");
    const memory = page.locator('[data-instance-config="memoryLimit"]');
    await memory.fill("lots");
    await page.locator("[data-instance-config-save]").click();
    await waitFor(page, () => !document.querySelector('[data-server-field-error="memoryLimit"]').hidden, null, "inline memory error");
    assert.strictEqual((await agentInstance(agent, SERVER_ID)).memoryLimit, "2G", "an invalid value is not saved");
    await memory.fill("3G");
    // Leaving with unsaved settings asks first; cancelling stays on Settings.
    await page.locator('[data-instance-tab="files"]').first().click();
    await waitFor(page, () => Boolean(document.querySelector("[data-confirm-cancel]")), null, "unsaved-settings prompt");
    await page.locator("[data-confirm-cancel]").last().click();
    assert.strictEqual(await page.evaluate(() => activeInstanceTab), "settings", "cancel keeps the Settings tab and the edit");
    assert.strictEqual(await memory.inputValue(), "3G");
    await page.locator("[data-instance-config-save]").click();
    const savedMemory = async () => (await agentInstance(agent, SERVER_ID)).memoryLimit;
    for (let i = 0; i < 50 && (await savedMemory()) !== "3G"; i += 1) await page.waitForTimeout(200);
    assert.strictEqual(await savedMemory(), "3G", "the change is saved to the server's computer");
    await waitFor(page, () => !document.querySelector("[data-server-restart-banner]").hidden, null, "restart banner");
    assert.match(await page.locator("[data-server-restart-message]").textContent(), /memory/);
    await shot(page, "04-settings-saved-restart");
    console.log("PASS V4 invalid values refused inline, unsaved changes guarded, valid change saved, restart flagged");

    // V5
    await waitFor(page, () => document.querySelector("[data-instance-config-dirty]")?.textContent === "Saved", null, "clean form");
    await agent.api("PATCH", `/api/v1/instances/${SERVER_ID}`, { displayName: "Renamed Elsewhere" });
    await page.locator('[data-instance-config="displayName"]').focus();
    await page.locator('[data-instance-config="displayName"]').fill("My Edit");
    await page.locator("[data-instance-config-save]").click();
    await page.waitForTimeout(1500);
    assert.strictEqual((await agentInstance(agent, SERVER_ID)).displayName, "Renamed Elsewhere", "a stale save never overwrites the newer change");
    console.log("PASS V5 a save from a stale copy is refused and the newer value is kept");
    await page.locator("[data-instance-config-cancel]").click();

    // V6
    await page.locator('[data-instance-tab="mods"]').first().click();
    await waitFor(page, () => document.querySelector("[data-mods-status]")?.textContent.includes("plugin"), null, "add-ons list", 20000);
    await page.locator("[data-mods-search-input]").fill("homes");
    await page.locator('[data-mods-action="search"]').click();
    await waitFor(page, () => document.querySelectorAll("[data-mods-results] .addon-row").length === 1, null, "search result");
    await page.locator("[data-mods-results] .addon-row button", { hasText: "Install" }).click();
    await waitFor(page, () => Boolean(document.querySelector(".addon-plan .addon-plan__actions")), null, "install plan");
    const planText = await page.locator(".addon-plan").textContent();
    assert.match(planText, /Homes 2\.1/);
    assert.match(planText, /also needs:\s*CoreLib 1\.4/);
    await shot(page, "05-addons-plan");
    await page.locator(".addon-plan button", { hasText: "Install all 2" }).click();
    await waitFor(page, () => document.querySelectorAll("[data-mods-installed] .addon-row").length === 2, null, "two installed add-ons", 30000);
    const pluginsDir = path.join(serverData, "plugins");
    assert.strictEqual(fs.readFileSync(path.join(pluginsDir, "homes-2.1.jar")).toString("base64"), jars["homes-2.1.jar"], "the verified file is on the server");
    assert(fs.existsSync(path.join(pluginsDir, "corelib-1.4.jar")), "the approved dependency is installed");
    await shot(page, "06-addons-installed");
    await page.locator("[data-mods-installed] .addon-row", { hasText: "Homes" }).locator("button", { hasText: "Remove" }).click();
    await waitFor(page, () => Boolean(document.querySelector("[data-confirm-ok]")), null, "remove confirmation");
    await page.locator("[data-confirm-ok]").last().click();
    await waitFor(page, () => document.querySelectorAll("[data-mods-installed] .addon-row").length === 1, null, "one add-on left", 20000);
    assert(!fs.existsSync(path.join(pluginsDir, "homes-2.1.jar")), "removed from plugins/");
    assert(fs.existsSync(path.join(serverData, ".anxos-addon-backups", "plugins", "homes-2.1.jar.removed.bak")), "a backup copy is kept outside plugins/");
    const calls = await app.evaluate(() => globalThis.__anxModrinthCalls);
    assert(calls.length > 0 && calls.every((call) => call.startsWith("/v2/") || call.startsWith("/data/")), "only the faked Modrinth endpoints were used");
    console.log("PASS V6 add-ons: search, plan with dependency, approved install of verified files, remove keeps a backup");

    // V8 backups: the tab lists this server's backups from the shared system.
    await page.locator('[data-instance-tab="backups"]').first().click();
    await waitFor(page, () => !document.querySelector("[data-server-backups-status]").textContent.includes("Loading"), null, "backups loaded", 20000);
    const before = await page.evaluate(() => document.querySelectorAll("[data-server-backups] .addon-row").length);
    await page.locator('[data-instance-backup-action="backup-now"]').click();
    for (let i = 0; i < 20; i += 1) {
      const confirm = page.locator("[data-confirm-ok]").last();
      if (await confirm.isVisible().catch(() => false)) { await confirm.click(); break; }
      if ((await page.evaluate(() => document.querySelectorAll("[data-server-backups] .addon-row").length)) > before) break;
      await page.waitForTimeout(250);
    }
    await waitFor(page, (count) => document.querySelectorAll("[data-server-backups] .addon-row").length > count, before, "the new backup in the list", 60000);
    await shot(page, "07-backups");
    // Restore always previews first; cancelling changes nothing.
    await page.locator("[data-server-backups] .addon-row").first().locator("button", { hasText: "Restore" }).click();
    await waitFor(page, () => Boolean(document.querySelector("[data-confirm-cancel]")), null, "restore preview", 20000);
    const previewText = await page.evaluate(() => document.querySelector("[data-confirm-cancel]").closest(".app-modal").textContent);
    assert.match(previewText, /restore|Restore/);
    await page.locator("[data-confirm-cancel]").last().click();
    console.log(`PASS V8 backups: Back up now adds this server's backup to the tab; restore previews first (${before} → ${before + 1})`);

    // V9 files: a dropped binary file arrives byte for byte.
    await page.locator('[data-instance-tab="files"]').first().click();
    await waitFor(page, () => document.querySelectorAll("[data-instance-files-list] tr").length > 0, null, "file list", 20000);
    await page.evaluate(() => {
      const bytes = new Uint8Array(256);
      for (let index = 0; index < 256; index += 1) bytes[index] = index;
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], "all-bytes.bin", { type: "application/octet-stream" }));
      document.querySelector("[data-instance-file-dropzone]").dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    const uploadedPath = path.join(serverData, "all-bytes.bin");
    for (let i = 0; i < 50 && !fs.existsSync(uploadedPath); i += 1) await page.waitForTimeout(200);
    const uploaded = fs.readFileSync(uploadedPath);
    assert.strictEqual(uploaded.length, 256, "every byte arrives");
    assert(uploaded.every((value, index) => value === index), "binary content is unchanged");
    console.log("PASS V9 files: a dropped binary file is uploaded byte for byte");

    // V7
    assert.deepStrictEqual(errors, [], "no renderer errors");
    console.log("PASS V7 no renderer errors");
    await page.locator('.instance-quick-actions [data-instance-action="stop"]').click().catch(() => {});
    await page.waitForTimeout(1500);
    console.log(`Server view UI QA passed (9 checks). Screenshots: ${artifacts}`);
  } catch (error) {
    console.error(`Last messages shown: ${await failureContext()}`);
    throw error;
  } finally {
    await app.close().catch(() => {});
    await agent.stop().catch(() => {});
    try { qa.cleanup(); } catch {}
    try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  }
}

main().catch(async (error) => {
  console.error(error);
  process.exitCode = 1;
});
