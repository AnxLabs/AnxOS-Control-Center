#!/usr/bin/env node
"use strict";

// Build 213 features in the REAL Electron app (isolated profile and config,
// --qa-mode, a test Agent on this PC started by this script). Never touches the
// installed app, its Local Agent or its data.
//   B1 My Servers › All computers lists the test Agent's servers with their
//      computer, keeps the offline computer visible, and Open switches to the
//      server's computer and opens its page
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
