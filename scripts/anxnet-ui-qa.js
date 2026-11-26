#!/usr/bin/env node
"use strict";

// AnxNet in the REAL Electron app (isolated profile and config, --qa-mode),
// against a REAL Agent running a disposable stand-in Minecraft server, a
// headless AnxNet node in this process as "a friend's computer", and an
// AnxNet edge (relay + gateway) on loopback. Everything listens on
// 127.0.0.1 (anxnet-settings listenHost), so no firewall prompt appears and
// nothing is exposed beyond this machine. Separate computers are simulated
// by separate identities on one host.
//   U1 Computers > AnxNet: create a network from the UI
//   U2 invite from the UI, a device joins with the code, the owner approves
//      it in the UI, and it shows as connected directly
//   U3 Share dialog > Invite only: approval first, then the friend's device
//      reaches the server at the owner's AnxNet address
//   U4 Anyone can join: the gateway is set in the UI, the exposure is
//      approved, and a plain client (no AnxNet) reaches the server through
//      the gateway; "Friends can join" appears only after the test passed;
//      turning it off closes the public port; Build 213: the edge is set up
//      from the panel's "Copy edge config", which passes the edge's check
//   U5 removing the device from the UI cuts its access
//   U6 no renderer errors
//   U8 Phase 7.1: Computers > AnxNet adds the Agent's computer to the
//      network; the Share dialog then shares the server from that computer's
//      own Agent, the owner reaches it, Stop sharing and Remove clean up
//   U7 AnxNet runs in its own background process: after the AnxOS window
//      closes, a device still reaches the shared server (the host is shut
//      down by the test afterwards)
// Run: node scripts/anxnet-ui-qa.js

const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");
const { fakeMinecraftInstance } = require("./test-helpers/fake-minecraft-instance");
const { AnxNetNode, fileStore } = require("../src/anxnet/node");
const { AnxNetEdge } = require("../src/anxnet/edge");
const { validateEdgeConfig } = require("../src/anxnet/edgeConfig");
const { AnxNetHostClient } = require("../src/anxnet/hostClient");

const root = path.resolve(__dirname, "..");
const SERVER_ID = "survival-test";
const { servicePorts } = require("./test-helpers/anxnet-ports");
// The fake game's port; moved off 25599 when Windows reserves it (set in main()).
let GAME_PORT = 25599;

async function waitFor(page, predicate, arg, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, arg).catch(() => false)) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function until(check, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}`);
}

function greeting(port, host, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no answer from ${host}:${port}`)); }, timeoutMs);
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    // The stand-in server waits for the client to speak, like a real one.
    socket.on("connect", () => socket.write("hi\n"));
    socket.on("data", (data) => { clearTimeout(timer); socket.destroy(); resolve(String(data).trim()); });
  });
}

async function main() {
  GAME_PORT = (await servicePorts(25599, 1))(25599);
  if (GAME_PORT !== 25599) console.log(`game port moved to ${GAME_PORT} (25599 is reserved on this computer)`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "anxnet-ui-qa-"));
  const agentAnxnetPort = await new Promise((resolve) => { const probe = net.createServer(); probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  // The Agent's AnxNet listens on loopback only in this test.
  const agent = await startServiceManagedAgent({ initial: "stopped", extraInstanceConfigs: [fakeMinecraftInstance({ id: SERVER_ID, port: GAME_PORT })], env: { AGENT_ANXNET_ROOT: path.join(temp, "agent-anxnet"), AGENT_ANXNET_HOST: "127.0.0.1", AGENT_ANXNET_PORT: String(agentAnxnetPort) } });
  const qa = createIsolatedQaEnv("anx-anxnet-qa-config-");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-anxnet-qa-profile-"));
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "anx-anxnet-qa-shots-"));
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "ovh", nodes: [{ id: "ovh", kind: "agent", name: "OVH", displayName: "OVH", baseUrl: agent.url, agentUrl: agent.url, enabled: true }] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { ovh: { agentToken: agent.token } } });
  fs.mkdirSync(path.join(qa.configDir, "anxnet"), { recursive: true });
  fs.writeFileSync(path.join(qa.configDir, "anxnet", "anxnet-settings.json"), JSON.stringify({ listenHost: "127.0.0.1", listenPort: 0 }));
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", root, "--qa-mode"], env });
  const errors = [];
  let friend = null;
  let friend2 = null;
  let edge = null;
  const shot = (page, name) => page.screenshot({ path: path.join(artifacts, `${name}.png`) });
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 960));
    await waitFor(page, () => typeof window.showPage === "function", null, "app start", 60000);
    const useDevice = page.getByRole("button", { name: "Use this device" }).first();
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    await waitFor(page, () => (document.querySelector('[data-testid="shell-sidebar"]')?.getBoundingClientRect().width || 0) > 0, null, "app shell", 60000);

    // U1
    await page.evaluate(() => window.showPage("nodes"));
    await waitFor(page, () => [...document.querySelectorAll("[data-anxnet-panel] button")].some((button) => button.textContent === "Create a network"), null, "AnxNet setup");
    await page.evaluate(() => document.querySelector("[data-anxnet-panel]").scrollIntoView({ block: "start" }));
    await shot(page, "01-anxnet-setup");
    await page.locator("[data-anxnet-panel] button", { hasText: "Create a network" }).click();
    await waitFor(page, () => Boolean(document.querySelector("[data-anxnet-panel] .anxnet-name")), null, "network created");
    const networkName = await page.locator("[data-anxnet-panel] .anxnet-name").textContent();
    assert.match(networkName, /^anx-[a-z]+\d{2}$/);
    console.log(`PASS U1 a network is created from the UI (${networkName}.internal)`);

    // U2
    await page.locator("[data-anxnet-panel] button", { hasText: "Invite a device" }).click();
    await waitFor(page, () => Boolean(document.querySelector(".anxnet-invite__code")), null, "invite code");
    const code = (await page.locator(".anxnet-invite__code").textContent()).trim();
    await shot(page, "02-anxnet-invite");
    friend = new AnxNetNode({ dataDir: path.join(temp, "friend"), deviceName: "Friend PC", listenHost: "127.0.0.1", dnsPort: 0 });
    await friend.start();
    console.log("invite code length", code.length, JSON.stringify(await page.evaluate(() => window.AnxNetUi._state()?.listening)));
    const joined = await friend.joinNetwork(code, { deviceName: "Friend PC" });
    assert.strictEqual(joined.pendingApproval, true, "an invite without pre-approval waits for the owner");
    await page.evaluate(() => window.AnxNetUi.refresh());
    await waitFor(page, () => document.querySelector(".anxnet-pending")?.textContent.includes("Friend PC"), null, "pending approval in the UI");
    await shot(page, "03-anxnet-pending");
    await page.locator(".anxnet-pending button", { hasText: "Approve" }).click();
    await until(() => friend.status().network.coordinator.state === "connected", "friend connected");
    await page.locator("[data-anxnet-panel] .anxnet-row", { hasText: "Friend PC" }).locator("button", { hasText: "Test" }).click();
    await waitFor(page, () => [...document.querySelectorAll("[data-anxnet-panel] .anxnet-row")].some((row) => row.textContent.includes("Friend PC") && row.textContent.includes("Connected directly")), null, "friend shown as connected directly");
    await shot(page, "04-anxnet-devices");
    console.log("PASS U2 invite from the UI, owner approval in the UI, the device shows as connected directly");

    // U3
    await page.evaluate((id) => getDesktopApiState().api.instances.start(id, getNodeScopedPayload(getNodeRequestContext("qa"))), SERVER_ID);
    await until(() => greeting(GAME_PORT, "127.0.0.1", 2000).then(() => true, () => false), "game port up", 30000);
    await page.evaluate(() => window.showPage("instances"));
    await waitFor(page, (id) => Boolean(findInstance(id)), SERVER_ID, "server listed", 30000);
    await page.evaluate((id) => window.openShareServerModal(id), SERVER_ID);
    await waitFor(page, () => [...document.querySelectorAll(".anxnet-share button")].some((button) => button.textContent === "Invite only"), null, "AnxNet share options");
    await shot(page, "05-share-anxnet");
    await page.locator(".anxnet-share button", { hasText: "Invite only" }).click();
    await waitFor(page, () => Boolean(document.querySelector("[data-confirm-ok]")), null, "share approval");
    assert.match(await page.evaluate(() => document.querySelector("[data-confirm-ok]").closest(".app-modal").textContent), /Nothing is opened to the internet/);
    await page.locator("[data-confirm-ok]").last().click();
    await until(() => friend.status().forwards.some((forward) => forward.port === GAME_PORT), "friend gets the server", 20000);
    const ownerAddress = friend.status().devices.find((device) => device.role === "owner").address;
    assert.strictEqual(await greeting(GAME_PORT, ownerAddress), "fake-minecraft", "the friend reaches the server through AnxNet");
    console.log(`PASS U3 Invite only: approved, and the friend's device reaches the server at ${ownerAddress}:${GAME_PORT}`);

    // U4
    const status = await page.evaluate(() => getDesktopApiState().api.anxnet.status());
    await page.locator("[data-share-server-close]").last().click().catch(() => {});
    await page.evaluate(() => window.showPage("nodes"));
    await page.locator("[data-anxnet-panel] .anxnet-advanced summary").click();
    const form = page.locator("[data-anxnet-panel] .anxnet-edges");
    // Build 213: the edge is configured from the panel's "Copy edge config"
    // (captured here; the real clipboard is left alone).
    await page.evaluate(() => { window.__copiedText = []; Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (text) => { window.__copiedText.push(String(text)); return Promise.resolve(); } } }); });
    // RC1 acceptance: the button sits with the explanation, above the edge
    // fields, not in one of their grid cells.
    const placement = await form.evaluate((node) => {
      const copy = [...node.querySelectorAll("button")].find((button) => button.textContent === "Copy edge config");
      const firstField = node.querySelector("input");
      return { inIntro: Boolean(copy.closest(".anxnet-edges-intro")), above: copy.getBoundingClientRect().bottom <= firstField.getBoundingClientRect().top };
    });
    assert.deepStrictEqual(placement, { inIntro: true, above: true }, `Copy edge config is in its own row (${JSON.stringify(placement)})`);
    await form.locator("button", { hasText: "Copy edge config" }).click();
    await waitFor(page, () => (window.__copiedText || []).length === 1, null, "edge config copied");
    const copiedConfig = JSON.parse(await page.evaluate(() => window.__copiedText[0]));
    assert.deepStrictEqual(copiedConfig.networks, [{ networkId: status.network.networkId, ownerPublicKey: status.network.ownerPublicKey }], "the copied config names this network and its owner key");
    assert.strictEqual(copiedConfig.gateway.enabled, false, "the gateway stays off until the owner turns it on");
    assert.strictEqual(validateEdgeConfig(copiedConfig).ok, true, "the copied config passes the edge's own check as it is");
    edge = new AnxNetEdge({ ...copiedConfig, keyStore: fileStore(path.join(temp, "edge.key")), listenHost: "127.0.0.1", port: 0, gateway: { ...copiedConfig.gateway, enabled: true, bindHost: "127.0.0.1", publicHost: "127.0.0.1", portRange: [45900, 45909] } });
    const edgeInfo = await edge.start();
    await form.locator("input").nth(0).fill("127.0.0.1");
    await form.locator("input").nth(1).fill(String(edgeInfo.port));
    await form.locator("input").nth(2).fill(edgeInfo.fingerprint);
    await form.locator("input[type=checkbox]").nth(0).check();
    await form.locator("input[type=checkbox]").nth(1).check();
    await form.locator("button", { hasText: "Save" }).click();
    await waitFor(page, () => window.AnxNetUi._state()?.network?.gateways?.length === 1, null, "gateway saved");
    await page.evaluate(() => window.showPage("instances"));
    await page.evaluate((id) => window.openShareServerModal(id), SERVER_ID);
    await waitFor(page, () => [...document.querySelectorAll(".anxnet-share button")].some((button) => button.textContent === "Anyone can join"), null, "Anyone can join option");
    await page.evaluate(() => { window.__toasts = []; const original = showToast; showToast = (message, tone) => { window.__toasts.push(String(message)); return original(message, tone); }; });
    await page.locator(".anxnet-share button", { hasText: "Anyone can join" }).click();
    await waitFor(page, () => Boolean(document.querySelector("[data-confirm-ok]")), null, "public exposure approval");
    const approval = await page.evaluate(() => document.querySelector("[data-confirm-ok]").closest(".app-modal").textContent);
    assert.match(approval, /Anyone who has the address can connect/);
    await shot(page, "06-anyone-can-join-approval");
    await page.locator("[data-confirm-ok]").last().click();
    await waitFor(page, () => (window.__toasts || []).some((text) => /Friends can join at|isn't confirmed/.test(text)), null, "publish result", 30000);
    const toast = await page.evaluate(() => window.__toasts.find((text) => /Friends can join at|isn't confirmed/.test(text)));
    assert.match(toast, /^Friends can join at 127\.0\.0\.1:459\d\d/, `only a passed test says friends can join (${toast})`);
    assert.match(toast, /answered as a Minecraft server \(Paper 1\.21\.1, 0\/20 players\)/, "the readiness check spoke Minecraft's status protocol through the gateway");
    const publicPort = Number(/127\.0\.0\.1:(\d+)/.exec(toast)[1]);
    assert.strictEqual(await greeting(publicPort, "127.0.0.1"), "fake-minecraft", "a plain client without AnxNet reaches the server through the gateway");
    await waitFor(page, () => Boolean(document.querySelector(".anxnet-share")), null, "share dialog reopened");
    await shot(page, "07-anyone-can-join-on");
    await page.locator(".anxnet-share button", { hasText: "Turn off Anyone can join" }).click();
    await until(() => !edge.status().routes.length, "public route removed", 10000);
    await assert.rejects(greeting(publicPort, "127.0.0.1", 2000), "the public port is closed after turning it off");
    console.log(`PASS U4 Anyone can join: approved, plain client reached the server on ${publicPort}, "Friends can join" only after the test, and turning it off closed the port`);

    // U5
    await page.locator("[data-share-server-close]").last().click().catch(() => {});
    await page.evaluate(() => window.showPage("nodes"));
    await page.evaluate(() => window.AnxNetUi.refresh());
    await page.locator("[data-anxnet-panel] .anxnet-row", { hasText: "Friend PC" }).locator("button", { hasText: "Remove" }).click();
    await waitFor(page, () => Boolean(document.querySelector("[data-confirm-ok]")), null, "remove confirmation");
    await page.locator("[data-confirm-ok]").last().click();
    await until(() => friend.status().network.coordinator.state === "removed", "friend removed", 15000);
    await assert.rejects(greeting(GAME_PORT, ownerAddress, 2000), "the removed device can no longer reach the server");
    await shot(page, "08-anxnet-after-remove");
    console.log("PASS U5 removing the device in the UI cuts its access");

    // U8
    await page.evaluate(() => window.AnxNetUi.refreshAgents());
    await waitFor(page, () => [...document.querySelectorAll("[data-anxnet-panel] .anxnet-agents .anxnet-row")].some((row) => row.textContent.includes("OVH") && row.textContent.includes("Not in AnxNet")), null, "the Agent computer listed", 20000);
    await shot(page, "09-agent-not-in-anxnet");
    await page.locator("[data-anxnet-panel] .anxnet-agents .anxnet-row", { hasText: "OVH" }).locator("button", { hasText: "Add to AnxNet" }).click();
    await waitFor(page, () => Boolean(document.querySelector("[data-confirm-ok]")), null, "add confirmation");
    assert.match(await page.evaluate(() => document.querySelector("[data-confirm-ok]").closest(".app-modal").textContent), /SSH, Docker and the Agent's own port are never shared/);
    await page.locator("[data-confirm-ok]").last().click();
    await waitFor(page, () => [...document.querySelectorAll("[data-anxnet-panel] .anxnet-agents .anxnet-row")].some((row) => row.textContent.includes("OVH") && row.textContent.includes("In this network")), null, "the Agent joined", 30000);
    const agentAnx = (await agent.api("GET", "/api/v1/anxnet/status")).json;
    assert.strictEqual(agentAnx.network.networkId, (await page.evaluate(() => getDesktopApiState().api.anxnet.status())).network.networkId, "the Agent is in this network");
    await shot(page, "10-agent-in-anxnet");
    await page.evaluate(() => window.showPage("instances"));
    await page.evaluate((id) => window.openShareServerModal(id), SERVER_ID);
    await waitFor(page, () => /shared from that computer/.test(document.querySelector(".anxnet-share")?.textContent || ""), null, "share from the Agent's computer", 20000);
    await shot(page, "11-share-from-agent");
    await page.locator(".anxnet-share button", { hasText: "Invite only" }).click();
    await waitFor(page, () => Boolean(document.querySelector("[data-confirm-ok]")), null, "agent share approval");
    await page.locator("[data-confirm-ok]").last().click();
    let agentForward = null;
    await until(async () => {
      const desk = await page.evaluate(() => getDesktopApiState().api.anxnet.status());
      const service = (desk.services || []).find((entry) => entry.deviceId === agentAnx.deviceId);
      agentForward = service && (desk.forwards || []).find((entry) => entry.serviceId === service.serviceId);
      return Boolean(agentForward);
    }, "the owner gets a forward to the Agent's server", 20000);
    assert.strictEqual(await greeting(agentForward.port, agentForward.address), "fake-minecraft", "the owner reaches the server through the Agent's own AnxNet node");
    await waitFor(page, () => /Invite only is on, from OVH/.test(document.querySelector(".anxnet-share")?.textContent || ""), null, "shared state in the dialog", 20000);
    await page.locator(".anxnet-share button", { hasText: "Stop sharing" }).click();
    await until(async () => !((await page.evaluate(() => getDesktopApiState().api.anxnet.status())).forwards || []).some((entry) => entry.serviceId === agentForward.serviceId), "forward removed", 20000);
    await page.locator("[data-share-server-close]").last().click().catch(() => {});
    await page.evaluate(() => window.showPage("nodes"));
    await page.evaluate(() => window.AnxNetUi.refreshAgents());
    await page.locator("[data-anxnet-panel] .anxnet-agents .anxnet-row", { hasText: "OVH" }).locator("button", { hasText: "Remove" }).click();
    await waitFor(page, () => Boolean(document.querySelector("[data-confirm-ok]")), null, "remove computer confirmation");
    await page.locator("[data-confirm-ok]").last().click();
    await until(async () => (await agent.api("GET", "/api/v1/anxnet/status")).json.network === null, "the Agent left", 20000);
    console.log(`PASS U8 the Agent's computer was added from the UI, shared the server itself (reached at ${agentForward.address}:${agentForward.port}), and Stop sharing and Remove cleaned up`);

    assert.deepStrictEqual(errors, [], "no renderer errors");
    console.log("PASS U6 no renderer errors");

    // U7: a second device joins, then the window closes.
    const status7 = await page.evaluate(() => getDesktopApiState().api.anxnet.status());
    assert.strictEqual(status7.mode, "background", "AnxNet runs in its background process");
    assert.ok(status7.host?.pid && status7.host.pid !== (await app.evaluate(() => process.pid)), "the host is not the app's process");
    const invite7 = await page.evaluate(() => getDesktopApiState().api.anxnet.createInvite({ preApproved: true }));
    friend2 = new AnxNetNode({ dataDir: path.join(temp, "friend2"), deviceName: "Friend 2", listenHost: "127.0.0.1", dnsPort: 0 });
    await friend2.start();
    await friend2.joinNetwork(invite7.code, { deviceName: "Friend 2" });
    await until(() => friend2.status().forwards.some((forward) => forward.port === GAME_PORT), "friend 2 gets the server");
    // Quit AnxOS. On Windows the detached host inherits Electron's stdout
    // pipe, so Playwright's close() can wait on that pipe; wait for the
    // Electron process itself to exit instead.
    const electronPid = app.process().pid;
    app.close().catch(() => {});
    const exited = await new Promise((resolve) => { if (app.process().exitCode !== null) resolve(true); app.process().once("exit", () => resolve(true)); setTimeout(() => resolve(false), 30000); });
    assert.ok(exited, `AnxOS (pid ${electronPid}) quit`);
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.strictEqual(await greeting(GAME_PORT, ownerAddress), "fake-minecraft", "with AnxOS closed, the device still reaches the server");
    console.log(`PASS U7 with the AnxOS window closed, AnxNet's background process (pid ${status7.host.pid}) still serves the shared server`);
    console.log(`AnxNet UI QA passed (8 checks). Screenshots: ${artifacts}`);
  } catch (error) {
    // Print now: cleanup below can take a while, and the reason matters.
    console.error("FAILED:", error);
    throw error;
  } finally {
    // The background host outlives the app on purpose (and holds Playwright's
    // pipe), so stop it first, then close the app with a time limit.
    try {
      const hostClient = new AnxNetHostClient({ dataDir: path.join(qa.configDir, "anxnet"), spawnHost: false });
      if (await hostClient.tryConnect()) await hostClient.call("shutdown").catch(() => {});
      hostClient.disconnect();
    } catch {}
    await Promise.race([app.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 15000))]);
    try { app.process().kill(); } catch {}
    await friend?.stop().catch(() => {});
    await friend2?.stop().catch(() => {});
    await edge?.stop().catch(() => {});
    await agent.stop().catch(() => {});
    try { qa.cleanup(); } catch {}
    try { fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5 }); } catch {}
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5 }); } catch {}
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
