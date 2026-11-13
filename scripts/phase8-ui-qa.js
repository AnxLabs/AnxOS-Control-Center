#!/usr/bin/env node
"use strict";

// Phase 8 desktop checks in the REAL Electron app (isolated profile and
// config, --qa-mode, a test Agent on this PC). Never touches the installed
// app or its data.
//   P1 Computers > Network lists the Agent computer's adapters (with link
//      speed, never presented as internet speed), router and DNS; Check
//      connection runs the router / name lookup / internet steps on the Agent
//   P2 a fresh install has no SSH profile and the SSH form is blank (the
//      developer's own server used to be pre-filled)
//   P3 Settings > Default page lists the current page names
//   P4 a running Minecraft test server: Overview's Players card opens the
//      Players tab, where Online now lists the two players its status ping
//      reports, and ping says "Not supported" (Minecraft does not report it)
// Set PHASE8_SHOTS=<dir> to keep screenshots.
// Run: node scripts/phase8-ui-qa.js

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const net = require("net");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");
const { fakeMinecraftInstance } = require("./test-helpers/fake-minecraft-instance");

const root = path.resolve(__dirname, "..");
const shotsDir = process.env.PHASE8_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "anx-phase8-shots-"));

async function waitFor(page, predicate, arg, label, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await page.evaluate(predicate, arg).catch(() => false)) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const gamePort = await new Promise((resolve) => { const probe = net.createServer(); probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  const MC_ID = "players-test";
  const agent = await startServiceManagedAgent({ initial: "running", extraInstanceConfigs: [fakeMinecraftInstance({ id: MC_ID, displayName: "Players Test", port: gamePort, players: ["Alex", "Sam"] })] });
  const qa = createIsolatedQaEnv("anx-phase8-qa-config-");
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "ovh", nodes: [{ id: "ovh", kind: "agent", name: "OVH", displayName: "OVH", baseUrl: agent.url, agentUrl: agent.url, enabled: true }] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { ovh: { agentToken: agent.token } } });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-phase8-qa-profile-"));
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", root, "--qa-mode"], env });
  const errors = [];
  const shot = (page, name) => page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 960));
    await waitFor(page, () => typeof window.showPage === "function", null, "renderer", 60000);
    const useDevice = page.getByRole("button", { name: "Use this device" }).first();
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    // Unlocked with a test owner whose random per-run password is never
    // printed or saved elsewhere (the mobile-ui-qa pattern), so node health
    // checks run and the test Agent shows as connected.
    const testPassword = `Qa-${crypto.randomBytes(12).toString("hex")}-Zz9!`;
    const unlocked = await page.evaluate(async (password) => {
      const security = window.anxhub?.security || window.anx?.security;
      const setup = await security.setupAdmin({ username: "qa-owner", password, passwordConfirm: password }).catch((error) => ({ error: error?.message }));
      const login = await security.login({ username: "qa-owner", password }).catch((error) => ({ error: error?.message }));
      return { setupError: setup?.error || null, loginError: login?.error || null };
    }, testPassword);
    assert.ok(!unlocked.setupError && !unlocked.loginError, `QA owner unlock failed: ${unlocked.setupError || unlocked.loginError}`);
    await page.reload();
    await waitFor(page, () => typeof window.showPage === "function", null, "app after unlock", 60000);
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    await waitFor(page, () => (document.querySelector(".nav-menu")?.getBoundingClientRect().width || 0) > 0, null, "app shell", 60000);

    // P1
    await page.evaluate(() => { try { localStorage.setItem("anxos.computers.selected.v1", "ovh"); } catch {} window.showPage("nodes"); });
    await page.evaluate(() => document.querySelector('[data-computer-details] [data-view-computer="ovh"]')?.click());
    // The Agent reads Windows adapters with one PowerShell query, cached for
    // 15 s, so allow a few polls before giving up.
    await waitFor(page, () => document.querySelectorAll("[data-computer-network] .computer-network__adapter").length > 0, null, "network adapters", 90000).catch(async (error) => {
      console.log("Network section at timeout:", await page.evaluate(() => document.querySelector("[data-computer-details]")?.textContent.slice(0, 1200)));
      throw error;
    });
    const network = await page.evaluate(() => {
      const section = document.querySelector("[data-computer-network]");
      return {
        id: section.dataset.computerNetwork,
        text: section.textContent,
        rows: [...section.querySelectorAll(".computer-network__table:not(.computer-network__other *) > .computer-network__adapter")].map((row) => row.textContent),
        button: section.querySelector("[data-network-check]")?.disabled,
      };
    });
    assert.strictEqual(network.id, "ovh", "the Network section belongs to the Agent computer");
    assert.match(network.text, /Router/, "router row");
    assert.match(network.text, /DNS servers/, "DNS row");
    assert.match(network.text, /Link speed/, "link speed column");
    assert.match(network.text, /not your internet speed/, "link speed is never presented as internet speed");
    assert.ok(network.rows.length >= 1, "at least one connected adapter");
    assert.strictEqual(network.button, false, "Check connection is available for a connected computer");
    await page.evaluate(() => document.querySelector("[data-computer-network]").scrollIntoView({ block: "start" }));
    await shot(page, "p1-network");
    await page.locator("[data-computer-network] [data-network-check]").click();
    await waitFor(page, () => document.querySelectorAll("[data-network-check-result] .computer-network__step").length === 3 || Boolean(document.querySelector("[data-network-check-result] .home-attention__item")), null, "connection check result", 45000);
    const steps = await page.evaluate(() => [...document.querySelectorAll("[data-network-check-result] .computer-network__step")].map((row) => ({ id: row.dataset.step, text: row.textContent })));
    if (!steps.length) console.log("CHECK ERROR:", await page.evaluate(() => document.querySelector("[data-network-check-result]")?.textContent));
    assert.deepStrictEqual(steps.map((step) => step.id), ["router", "lookup", "internet"], `three steps (${JSON.stringify(steps)})`);
    await page.evaluate(() => document.querySelector("[data-network-check-result]").scrollIntoView({ block: "center" }));
    await shot(page, "p1-network-check");
    console.log(`PASS P1 Computers > Network: ${network.rows.length} connected adapter(s), router, DNS; check: ${steps.map((step) => step.text.replace(/\s+/g, " ")).join(" | ")}`);

    // P2
    await page.evaluate(() => window.showPage("ssh"));
    await page.waitForTimeout(800);
    const ssh = await page.evaluate(async () => {
      const profiles = await getDesktopApiState().api.ssh.listProfiles();
      return {
        profiles: (profiles?.profiles || profiles?.data?.profiles || []).length,
        name: document.querySelector("[data-ssh-profile-name]")?.value,
        host: document.querySelector("[data-ssh-profile-host]")?.value,
        user: document.querySelector("[data-ssh-profile-username]")?.value,
        page: document.querySelector('.page[data-page="ssh"]').textContent,
      };
    });
    assert.strictEqual(ssh.profiles, 0, "no SSH profile on a fresh install");
    assert.deepStrictEqual([ssh.name, ssh.host, ssh.user], ["", "", ""], "the new-profile form starts blank");
    assert.doesNotMatch(ssh.page, /192\.168\.1\.134/, "the developer's server is nowhere on the page");
    console.log("PASS P2 SSH starts with no profiles and a blank form");

    // P3
    const options = await page.evaluate(() => [...document.querySelectorAll('select[data-setting="general.defaultPage"] option')].map((option) => option.textContent));
    assert.ok(options.includes("Home") && options.includes("My Servers") && options.includes("Computers") && options.includes("Sharing"), `current names (${options.join(", ")})`);
    assert.ok(!options.some((label) => /Dashboard|Minecraft|AMP|CoolPals|Nodes|Public Access/.test(label)), "retired names are gone");
    console.log("PASS P3 Default page lists the current page names");

    // P4
    const started = await agent.api("POST", `/api/v1/instances/${MC_ID}/start`, {});
    assert.ok(started.status < 300, `the test server starts (${started.status} ${started.text.slice(0, 200)})`);
    let reported = null;
    for (let attempt = 0; attempt < 60 && !(reported && reported.available); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      reported = (await agent.api("GET", `/api/v1/instances/${MC_ID}/players`)).json;
    }
    assert.ok(reported && reported.available, `the Agent reads the players (${JSON.stringify(reported)})`);
    await page.evaluate((id) => { window.showPage("instances"); refreshInstances?.(); }, MC_ID);
    await waitFor(page, (id) => typeof getInstances === "function" && getInstances().some((instance) => instance.id === id && /running/i.test(instance.state || "")), MC_ID, "the test server running in My Servers", 40000);
    await page.evaluate((id) => openDashboardInstanceDetails(id), MC_ID);
    await waitFor(page, () => [...document.querySelectorAll(".server-card")].some((card) => /Players/.test(card.textContent)), null, "Players card on Overview", 20000);
    await page.locator("[data-server-open-tab=\"players\"]").first().click();
    await waitFor(page, () => document.querySelectorAll("[data-live-players] [data-live-player]").length === 2, null, "two players online", 30000);
    const live = await page.evaluate(() => ({
      names: [...document.querySelectorAll("[data-live-players] [data-live-player]")].map((row) => row.dataset.livePlayer),
      count: document.querySelector("[data-live-players-count]")?.textContent,
      ping: document.querySelector("[data-live-players-ping]")?.textContent,
      pingKind: document.querySelector("[data-live-players-ping]")?.dataset.livePlayersPing,
      rows: [...document.querySelectorAll("[data-live-players] [data-live-player]")].map((row) => row.textContent),
    }));
    assert.deepStrictEqual(live.names, ["Alex", "Sam"]);
    assert.match(live.count, /2 of 20/);
    assert.deepStrictEqual([live.pingKind, /Not supported/.test(live.ping)], ["not-supported", true], "no ping is invented for Minecraft");
    assert.ok(live.rows.every((row) => /Not supported/.test(row)), "each player's ping says Not supported");
    await shot(page, "p4-players");
    await agent.api("POST", `/api/v1/instances/${MC_ID}/stop`, {});
    console.log(`PASS P4 Players tab: ${live.names.join(", ")} online (${live.count.replace(/\s+/g, " ")}); ping Not supported for Minecraft`);

    assert.deepStrictEqual(errors, [], `renderer errors: ${errors.join(" | ")}`);
    console.log(`Phase 8 UI QA: 4 checks passed. Screenshots: ${shotsDir}`);
  } finally {
    await Promise.race([app.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 15000))]);
    await agent.stop().catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
