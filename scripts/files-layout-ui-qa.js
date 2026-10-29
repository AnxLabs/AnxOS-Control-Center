#!/usr/bin/env node
"use strict";

// Desktop UI regression for the Files page layout.
//
// Launches the REAL Electron app (isolated profile and config, --qa-mode) at
// 1440x900, opens Files in Browse mode and checks that the explorer is
// usable: the folder tree, file list and details are laid out with real size
// (the file list wide enough for its Name/Type/Size/Modified columns, panes
// taller than a strip), the empty editor no longer takes a column beside the
// explorer, and the storage list does not scroll inside itself.
//
// Never touches the installed app or its data.
// Run: node scripts/files-layout-ui-qa.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");

const root = path.resolve(__dirname, "..");

async function main() {
  const agent = await startServiceManagedAgent({ initial: "running" });
  const qa = createIsolatedQaEnv("anx-files-ui-qa-config-");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-files-ui-qa-profile-"));
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "ovh", nodes: [{ id: "ovh", kind: "agent", name: "OVH", displayName: "OVH", baseUrl: agent.url, agentUrl: agent.url, enabled: true }] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { ovh: { agentToken: agent.token } } });
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", root, "--qa-mode"], env });
  try {
    const page = await app.firstWindow();
    const rendererErrors = [];
    page.on("pageerror", (error) => rendererErrors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window?.setSize(1440, 900); window?.setIgnoreMouseEvents(true); });
    await page.waitForLoadState("domcontentloaded");
    for (let i = 0; i < 200 && !(await page.evaluate(() => typeof window.showPage === "function")); i += 1) await page.waitForTimeout(150);
    const useDevice = page.getByRole("button", { name: "Use this device" }).first();
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    for (let i = 0; i < 200 && !(await page.evaluate(() => (document.querySelector(".nav-menu")?.getBoundingClientRect().width || 0) > 0)); i += 1) await page.waitForTimeout(150);
    await page.evaluate(() => window.showPage("files"));
    await page.waitForTimeout(1500);

    const layout = await page.evaluate(() => {
      const box = (selector) => {
        const element = document.querySelector(selector);
        if (!element || element.closest("[hidden]")) return null;
        const rect = element.getBoundingClientRect();
        return { left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom), width: Math.round(rect.width), height: Math.round(rect.height) };
      };
      const storageList = document.querySelector(".storage-connection-list");
      return {
        browseMode: !document.querySelector(".file-manager-shell").classList.contains("is-edit-mode"),
        tree: box(".folder-tree-panel"),
        list: box(".file-list-panel"),
        details: box(".file-details-panel"),
        editor: box(".file-editor-panel"),
        storageScrolls: storageList ? storageList.scrollHeight > storageList.clientHeight + 1 : false,
      };
    });
    assert.strictEqual(layout.browseMode, true, "Files opens in Browse mode");
    assert.ok(layout.tree && layout.list && layout.details && layout.editor, `all panes render (${JSON.stringify(layout)})`);
    assert.ok(layout.list.width >= 520, `the file list is wide enough for its columns (${layout.list.width}px)`);
    assert.ok(layout.list.height >= 300, `the file list is taller than a strip (${layout.list.height}px)`);
    assert.ok(layout.tree.height >= 300, `the folder tree is taller than a strip (${layout.tree.height}px)`);
    assert.ok(layout.details.top >= layout.list.bottom - 1, "details sit under the file list, not beside it");
    assert.ok(layout.editor.top >= layout.list.bottom, "the editor sits below the explorer, not in a column beside it");
    assert.strictEqual(layout.storageScrolls, false, "the storage list does not scroll inside itself");
    console.log("PASS F1 Files browse layout: wide file list, real pane heights, details and editor below");

    assert.deepStrictEqual(rendererErrors, [], "no renderer errors");
    console.log("Files layout UI QA passed (1 check).");
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    await app.close().catch(() => {});
    await agent.stop().catch(() => {});
    for (const cleanup of [() => qa.cleanup(), () => fs.rmSync(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })]) {
      try { cleanup(); } catch {}
    }
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
