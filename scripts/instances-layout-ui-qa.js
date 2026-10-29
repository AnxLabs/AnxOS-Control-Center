#!/usr/bin/env node
"use strict";

// Desktop UI regression for the Instances page layout.
//
// Launches the REAL Electron app (isolated profile and config, --qa-mode)
// against a REAL Agent at a 1440x900 window and checks:
//   L1 the instance table fits its panel (no sideways scrolling) and every
//      row's power actions are fully visible;
//   L2 every inspector action is present exactly once, grouped as Power,
//      Access, Manage and Danger zone;
//   L3 the console-only Stream/Lines selects live in the Console tab;
//   L4 console log lines do not overlap: timestamp, stream and message
//      columns are laid out side by side, and rows pack at the top.
//
// Never touches the installed app or its data.
// Run: node scripts/instances-layout-ui-qa.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent, INSTANCE_ID } = require("./test-helpers/service-managed-agent-fixture");

const root = path.resolve(__dirname, "..");
const ACTIONS = {
  Power: ["start", "stop", "restart", "refresh", "repair-neoforge-runtime", "update-steam", "configure-fivem"],
  Access: ["expose-share", "share-server", "copy-access-address", "manage-access"],
  Manage: ["rename", "duplicate", "transfer-workload", "open-folder"],
  "Danger zone": ["delete", "forget"],
};

async function main() {
  const agent = await startServiceManagedAgent({ initial: "running", extraInstances: ["plain-server"] });
  const qa = createIsolatedQaEnv("anx-layout-ui-qa-config-");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-layout-ui-qa-profile-"));
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
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window?.setSize(1440, 900); });
    await page.waitForLoadState("domcontentloaded");
    for (let i = 0; i < 200 && !(await page.evaluate(() => typeof window.showPage === "function")); i += 1) await page.waitForTimeout(150);
    // A fresh profile shows the first-run chooser; pick the same option a user would.
    const useDevice = page.getByRole("button", { name: "Use this device" }).first();
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    // Wait until startup finished and the app shell is laid out.
    for (let i = 0; i < 200 && !(await page.evaluate(() => (document.querySelector(".nav-menu")?.getBoundingClientRect().width || 0) > 0)); i += 1) await page.waitForTimeout(150);
    await page.evaluate(() => window.showPage("instances"));
    for (let i = 0; i < 120 && !(await page.evaluate((id) => Boolean(document.querySelector(`[data-instances-list] tr[data-instance-id="${id}"] [data-instance-row-action="stop"]`)), INSTANCE_ID)); i += 1) await page.waitForTimeout(250);

    await page.waitForTimeout(500);
    // L1: the table fits and the row actions are fully visible.
    const fit = await page.evaluate(() => {
      const wrap = document.querySelector(".instances-table").parentElement;
      const panel = wrap.closest(".instances-table-panel");
      const panelRect = panel.getBoundingClientRect();
      const clipped = [...document.querySelectorAll("[data-instances-list] [data-instance-row-action]")]
        .filter((button) => { const rect = button.getBoundingClientRect(); return rect.right > panelRect.right + 0.5 || rect.width === 0; })
        .map((button) => { const r = button.getBoundingClientRect(); return `${button.closest("tr").dataset.instanceId}:${button.dataset.instanceRowAction}:r${Math.round(r.right)}/p${Math.round(panelRect.right)}:w${Math.round(r.width)}`; });
      return { overflow: wrap.scrollWidth - wrap.clientWidth, clipped, rowActions: [...new Set([...document.querySelectorAll("[data-instances-list] [data-instance-row-action]")].map((button) => button.dataset.instanceRowAction))] };
    });
    assert.ok(fit.overflow <= 1, `the table fits its panel (overflow ${fit.overflow}px)`);
    assert.deepStrictEqual(fit.clipped, [], `no row action is clipped (${JSON.stringify(fit)})`);
    assert.deepStrictEqual(fit.rowActions, ["start", "stop", "restart"], "rows carry the power actions");
    console.log("PASS L1 the instance table fits and row actions are fully visible");

    // L2: inspector actions, each exactly once, in their groups.
    const groups = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".instance-quick-actions .instance-action-group")].map((group) => [
      group.getAttribute("aria-label"),
      [...group.querySelectorAll("[data-instance-action]")].map((button) => button.dataset.instanceAction),
    ])));
    assert.deepStrictEqual(groups, ACTIONS, "inspector actions are grouped by purpose");
    const counts = await page.evaluate((actions) => Object.fromEntries(actions.map((action) => [action, document.querySelectorAll(`.instance-quick-actions [data-instance-action="${action}"]`).length])), Object.values(ACTIONS).flat());
    assert.ok(Object.values(counts).every((count) => count === 1), `each inspector action appears once (${JSON.stringify(counts)})`);
    console.log("PASS L2 every inspector action is present once, grouped by purpose");

    // L3: the log selects are in the Console tab, not the page controls.
    const placement = await page.evaluate(() => ({
      stream: Boolean(document.querySelector('[data-instance-panel="console"] [data-instances-log-stream]')),
      limit: Boolean(document.querySelector('[data-instance-panel="console"] [data-instances-log-limit]')),
      inControlbar: Boolean(document.querySelector(".instances-controlbar [data-instances-log-stream], .instances-controlbar [data-instances-log-limit]")),
    }));
    assert.deepStrictEqual(placement, { stream: true, limit: true, inControlbar: false });
    console.log("PASS L3 Stream and Lines selects live in the Console tab");

    // L4: console columns do not overlap and rows pack at the top.
    await page.locator(`[data-instances-list] tr[data-instance-id="${INSTANCE_ID}"] td`).first().click();
    await page.locator('[data-instance-tab="console"]').first().click();
    for (let i = 0; i < 80 && (await page.evaluate(() => document.querySelectorAll("[data-instances-logs] li").length)) < 2; i += 1) await page.waitForTimeout(250);
    const lines = await page.evaluate(() => [...document.querySelectorAll("[data-instances-logs] li")].slice(0, 2).map((line) => {
      const [time, stream, message] = [...line.children].map((child) => child.getBoundingClientRect());
      return { timeRight: time.right, streamLeft: stream.left, streamRight: stream.right, messageLeft: message.left, top: line.getBoundingClientRect().top, height: line.getBoundingClientRect().height };
    }));
    assert.ok(lines.length >= 2, "the console shows journal lines");
    for (const line of lines) {
      assert.ok(line.timeRight <= line.streamLeft + 0.5, `the timestamp does not overlap the stream (${JSON.stringify(line)})`);
      assert.ok(line.streamRight <= line.messageLeft + 0.5, `the stream does not overlap the message (${JSON.stringify(line)})`);
    }
    assert.ok(lines[1].top - lines[0].top < lines[0].height * 2.5, `consecutive lines are packed (${lines[1].top - lines[0].top}px apart)`);
    console.log("PASS L4 console lines lay out without overlap, packed at the top");

    assert.deepStrictEqual(rendererErrors, [], "no renderer errors");
    console.log("Instances layout UI QA passed (4 checks).");
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
