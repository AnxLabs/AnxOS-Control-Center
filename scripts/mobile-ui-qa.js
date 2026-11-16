#!/usr/bin/env node
"use strict";

// Phase 7 phone app, end to end: the REAL Electron app (isolated profile and
// config, --qa-mode, a test owner with a random per-run password) runs the
// phone gateway against a REAL Agent with a disposable stand-in Minecraft
// server. The phone is Microsoft Edge with phone emulation (viewport, touch,
// mobile user agent), trusting only the gateway certificate's key. This is
// emulation, not a real phone.
//
//   M1  Phone access: turned on and paired from the desktop Security page.
//   M2  Pairing from the QR link; the code leaves the address bar; Home
//       matches what the Agent reports (servers, computers).
//   M3  No horizontal overflow on Home, Servers, Computers and every server
//       tab, at 360, 375, 412 and 430 px wide.
//   M4  Start from the phone goes through the same Agent operation; Overview
//       turns Running by itself.
//   M5  Console: a command reaches the server and its answer streams in.
//   M6  Settings: an invalid value is refused; a valid one is saved on the
//       Agent; a stale save is refused and the newer value kept.
//   M7  Files: a binary upload arrives byte for byte; Build 213: it is not
//       offered as text and its download returns the same bytes.
//   M8  Add-ons: search, plan with its dependency, approved install.
//   M9  Backups: Back up now; Restore shows the preview and Cancel changes
//       nothing.
//   M10 Stop asks first; Cancel keeps it running; confirming stops it.
//   M11 Viewer phone: actions disabled, direct API calls refused.
//   M12 Revoking a phone on the desktop ends its access at once.
//   M13 Network loss: the phone says so, marks data with its age, and
//       recovers by itself.
//   M14 Locking AnxOS on the computer blocks the phone; unlocking restores it.
//   M15 Closing the phone's browser doesn't touch the running server.
//   M16 PWA: manifest, service worker registered, installability errors.
//   M17 No page errors or CSP violations in the phone app; none on desktop.
//   M18 Phase 7.1: landscape (844×390) without sideways scrolling; text
//       fields at 16px so iPhone doesn't zoom; the desktop Home agrees with
//       the phone by itself.
//   M19 "Check this phone" runs on the phone and its result appears in
//       Phone Access on the desktop.
// Screenshots go to the artifacts folder printed at the end.
// Run: node scripts/mobile-ui-qa.js

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { _electron: electron, chromium } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");
const { fakeMinecraftInstance } = require("./test-helpers/fake-minecraft-instance");

const root = path.resolve(__dirname, "..");
const SERVER_ID = "survival-test";
const PHONES = {
  pixel: { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36" },
  iphone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
};
const WIDTHS = [360, 375, 412, 430];

async function waitFor(page, predicate, arg, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(predicate, arg).catch(() => false)) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function until(check, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ""}`);
}

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

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
    globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === "api.modrinth.com") {
        if (url.pathname === "/v2/search") return new Response(JSON.stringify({ hits: [project("homes", "Homes")], total_hits: 1, offset: 0, limit: 20 }), { status: 200, headers: { "content-type": "application/json" } });
        const body = routes[url.pathname];
        return new Response(JSON.stringify(body || { error: "not_found" }), { status: body ? 200 : 404, headers: { "content-type": "application/json" } });
      }
      if (url.hostname === "cdn.modrinth.com") {
        const name = url.pathname.split("/").pop();
        return files[name] ? new Response(files[name], { status: 200 }) : new Response("missing", { status: 404 });
      }
      return realFetch(input, init);
    };
  });
}

async function agentInstance(agent, id) {
  const response = await agent.api("GET", "/api/v1/instances");
  return (response.json?.instances || []).find((instance) => instance.id === id) || {};
}

async function main() {
  const agent = await startServiceManagedAgent({ initial: "stopped", extraInstanceConfigs: [fakeMinecraftInstance({ id: SERVER_ID })] });
  const serverData = path.join(agent.home, "instances", SERVER_ID, "data");
  const qa = createIsolatedQaEnv("anx-mobile-qa-config-");
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-mobile-qa-profile-"));
  const edgeProfile = fs.mkdtempSync(path.join(os.tmpdir(), "anx-mobile-qa-edge-"));
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), "anx-mobile-qa-"));
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "ovh", nodes: [{ id: "ovh", kind: "agent", name: "OVH", displayName: "OVH", baseUrl: agent.url, agentUrl: agent.url, enabled: true }] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { ovh: { agentToken: agent.token } } });
  const gatewayPort = await freePort();
  fs.mkdirSync(path.join(qa.configDir, "mobile"), { recursive: true });
  fs.writeFileSync(path.join(qa.configDir, "mobile", "settings.json"), JSON.stringify({ enabled: false, port: gatewayPort }));

  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1", ANXOS_QA_MOBILE_LOOPBACK: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", root, "--qa-mode"], env });
  const desktopErrors = [];
  const phoneErrors = [];
  let browser = null;
  const shot = (page, name) => page.screenshot({ path: path.join(artifacts, `${name}.png`) });
  const passed = [];
  const pass = (id, text) => { passed.push(id); console.log(`PASS ${id} ${text}`); };

  try {
    const desk = await app.firstWindow();
    desk.on("pageerror", (error) => desktopErrors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 960));
    await waitFor(desk, () => typeof window.showPage === "function", null, "app start", 60000);
    const useDevice = desk.getByRole("button", { name: "Use this device" }).first();
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    // Phone access is owner-only, so the isolated profile gets a test owner
    // with a random per-run password that is never printed or saved elsewhere.
    const testPassword = `Qa-${crypto.randomBytes(12).toString("hex")}-Zz9!`;
    const unlocked = await desk.evaluate(async (password) => {
      const security = window.anxhub?.security || window.anx?.security;
      const setup = await security.setupAdmin({ username: "qa-owner", password, passwordConfirm: password }).catch((error) => ({ error: error?.message }));
      const login = await security.login({ username: "qa-owner", password }).catch((error) => ({ error: error?.message }));
      return { setupError: setup?.error || null, loginError: login?.error || null };
    }, testPassword);
    assert.ok(!unlocked.setupError && !unlocked.loginError, `QA owner unlock failed: ${unlocked.setupError || unlocked.loginError}`);
    await desk.reload();
    await waitFor(desk, () => typeof window.showPage === "function", null, "app after unlock", 60000);
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    await installFakeModrinth({ app });

    // M1
    await desk.evaluate(() => window.showPage("security"));
    await desk.locator('[data-security-section-target="phone"]').click();
    await waitFor(desk, () => document.querySelector("[data-phone-access-panel]")?.textContent.includes("Turn on"), null, "Phone access section");
    await desk.locator("[data-phone-access-panel]").getByRole("button", { name: "Turn on" }).click();
    await waitFor(desk, () => document.querySelector("[data-phone-access-panel] .status-pill")?.textContent === "On", null, "gateway on", 30000);
    await desk.locator("[data-phone-access-panel]").getByRole("button", { name: "Pair as Owner" }).click();
    await waitFor(desk, () => Boolean(document.querySelector(".phone-pairing__qr")), null, "pairing QR");
    await shot(desk, "01-desktop-phone-access");
    const status = await desk.evaluate(() => getDesktopApiState().api.mobile.status());
    assert.strictEqual(status.running, true);
    assert.strictEqual(status.port, gatewayPort);
    const ownerLink = (await desk.evaluate(() => getDesktopApiState().api.mobile.createPairing("Owner"))).links[0];
    const toLocal = (link) => link.replace(/^https:\/\/[^/]+\//, `https://127.0.0.1:${gatewayPort}/`);
    pass("M1", `Phone access turned on from Security > Phone Access (port ${gatewayPort}); QR shown`);

    // The phone trusts exactly the gateway certificate's public key.
    const leafPem = fs.readFileSync(path.join(qa.configDir, "mobile", "tls", "gateway.crt"), "utf8");
    const spki = crypto.createHash("sha256").update(new crypto.X509Certificate(leafPem).publicKey.export({ type: "spki", format: "der" })).digest("base64");
    browser = await chromium.launch({ channel: "msedge", headless: true, args: [`--ignore-certificate-errors-spki-list=${spki}`] });
    const phoneContext = async (profile) => {
      const context = await browser.newContext({ ...PHONES[profile], locale: "en-GB", timezoneId: "Europe/London" });
      return context;
    };
    const watch = (page, label) => {
      page.on("pageerror", (error) => phoneErrors.push(`${label}: ${error.message}`));
      page.on("console", (message) => {
        if (message.type() === "error" && !/Failed to load resource/.test(message.text())) phoneErrors.push(`${label}: ${message.text()}`);
      });
    };

    // M2
    const ownerCtx = await phoneContext("pixel");
    const phone = await ownerCtx.newPage();
    watch(phone, "owner");
    await phone.goto(toLocal(ownerLink));
    await phone.getByRole("button", { name: "Pair" }).waitFor();
    assert.ok(!phone.url().includes("pair="), "the code leaves the address bar at once");
    await phone.getByLabel("Name this phone").fill("QA Pixel");
    await phone.getByRole("button", { name: "Pair" }).click();
    await waitFor(phone, () => document.querySelectorAll(".tile").length === 4, null, "Home tiles", 30000);
    try {
      await waitFor(phone, () => /^\d+$/.test(document.querySelector(".tile strong")?.textContent || ""), null, "server count", 30000);
    } catch (error) {
      const home = await phone.evaluate(() => fetch("/api/home").then((response) => response.text())).catch((err) => err.message);
      throw new Error(`${error.message}. Phone shows: ${await phone.locator("main").textContent()} | /api/home: ${String(home).slice(0, 1500)}`);
    }
    const tiles = await phone.evaluate(() => [...document.querySelectorAll(".tile")].map((tile) => tile.querySelector("strong").textContent + " " + tile.querySelector("small").textContent));
    const agentList = (await agent.api("GET", "/api/v1/instances")).json.instances;
    const running = agentList.filter((entry) => ["running", "starting"].includes(String(entry.state).toLowerCase())).length;
    assert.strictEqual(tiles[0], `${running} of ${agentList.length} running`, "servers tile matches the Agent");
    // Computers: the test Agent answers, the legacy address in agent.json
    // (127.0.0.1:9) can't, so the truth is 1 of 2 online.
    const nodesListed = await desk.evaluate(() => getDesktopApiState().api.nodes.list().then((list) => list.nodes.filter((node) => node.kind !== "application-host" && node.enabled !== false).length));
    assert.strictEqual(tiles[1], `1 of ${nodesListed} online`, "computers tile matches what is actually reachable");
    // The desktop's own Home must agree by itself (its fleet check reloads
    // the node list when the recorded state changed; Phase 7.1 fix).
    await desk.evaluate(() => window.showPage("dashboard"));
    const desktopTile = () => desk.evaluate(() => `${document.querySelector(".home-tile--computers .home-tile__value")?.textContent} ${document.querySelector(".home-tile--computers .home-tile__detail")?.textContent}`);
    let desktopComputers = "";
    const settleStart = Date.now();
    await until(async () => (desktopComputers = await desktopTile()) === tiles[1], "desktop Home to agree", 45000).catch(() => {
      throw new Error(`desktop Home shows "${desktopComputers}", phone and reality "${tiles[1]}"`);
    });
    await shot(phone, "02-phone-home");
    await shot(desk, "02-desktop-home");
    pass("M2", `paired from the link; phone Home: servers "${tiles[0]}" (= Agent), computers "${tiles[1]}" (= reachable); desktop Home agreed by itself after ${Math.round((Date.now() - settleStart) / 1000)} s`);

    const checkOverflow = async (label) => {
      const result = await phone.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: window.innerWidth }));
      assert.ok(result.scroll <= result.width + 1, `${label}: page is ${result.scroll}px wide in a ${result.width}px window`);
    };

    // M4
    await phone.locator('.tabbar [data-tab="servers"]').click();
    await phone.locator(".row", { hasText: "Survival Test" }).click();
    await waitFor(phone, () => document.querySelector(".card .pill")?.textContent === "Stopped", null, "server Overview stopped");
    await shot(phone, "03-phone-server-stopped");
    await phone.getByRole("button", { name: "Start" }).click();
    await until(async () => ["running", "starting"].includes(String((await agentInstance(agent, SERVER_ID)).state).toLowerCase()), "the Agent to start the server").catch(async (error) => {
      const toastText = await phone.locator("[data-toast]").textContent().catch(() => "");
      const direct = await phone.evaluate(async (id) => {
        const session = await fetch("/api/session").then((response) => response.json());
        const response = await fetch(`/api/servers/ovh/${id}/start`, { method: "POST", headers: { "Content-Type": "application/json", "X-AnxOS-CSRF": session.csrf }, body: "{}" });
        return `${response.status} ${await response.text()}`;
      }, SERVER_ID);
      throw new Error(`${error.message}; phone toast "${toastText}"; direct start: ${direct}; agent state ${String((await agentInstance(agent, SERVER_ID)).state).toLowerCase()}`);
    });
    await waitFor(phone, () => document.querySelector(".card .pill")?.textContent === "Running", null, "Overview to show Running without a refresh", 40000);
    await shot(phone, "04-phone-server-running");
    pass("M4", "Start on the phone → the Agent starts the server; Overview turns Running by itself");

    // M5
    await phone.locator(".server-tabs a", { hasText: "Console" }).click();
    await waitFor(phone, () => document.querySelector(".console")?.textContent.includes("Done ("), null, "startup logs", 30000);
    await phone.getByLabel("Server command").fill("say hello from the phone");
    await phone.getByRole("button", { name: "Send" }).click();
    await waitFor(phone, () => document.querySelector(".console")?.textContent.includes("[Server] hello from the phone"), null, "the server's answer", 20000);
    await shot(phone, "05-phone-console");
    pass("M5", "console command reached the server; its answer streamed into the phone console");

    // M3 (with the server running, so every tab has content)
    const tabs = ["Overview", "Console", "Files", "Add-ons", "Backups", "Settings"];
    for (const width of WIDTHS) {
      await phone.setViewportSize({ width, height: 800 });
      for (const top of ["home", "servers", "computers", "sharing", "more"]) {
        await phone.evaluate((name) => { location.hash = `#/${name}`; }, top);
        await phone.waitForTimeout(700);
        await checkOverflow(`${width}px ${top}`);
      }
      await phone.evaluate((id) => { location.hash = `#/server/ovh/${id}/overview`; }, SERVER_ID);
      for (const tab of tabs) {
        await phone.locator(".server-tabs a", { hasText: tab }).click();
        await phone.waitForTimeout(900);
        await checkOverflow(`${width}px ${tab}`);
      }
    }
    await phone.setViewportSize(PHONES.pixel.viewport);
    await phone.evaluate(() => { location.hash = "#/computers"; });
    await waitFor(phone, () => Boolean(document.querySelector(".meter")), null, "computer readings");
    await shot(phone, "06-phone-computers");
    pass("M3", `no horizontal overflow at ${WIDTHS.join("/")} px on 5 sections and all 6 server tabs`);

    // M6
    await phone.evaluate((id) => { location.hash = `#/server/ovh/${id}/settings`; }, SERVER_ID);
    await waitFor(phone, () => Boolean(document.querySelector('[data-keep="memory"]')), null, "settings form");
    await phone.locator('[data-keep="memory"]').fill("lots");
    await phone.getByRole("button", { name: "Save" }).click();
    await waitFor(phone, () => !document.querySelector(".field-error")?.hidden, null, "inline error");
    assert.strictEqual((await agentInstance(agent, SERVER_ID)).memoryLimit, "2G", "an invalid value is not saved");
    await phone.locator('[data-keep="memory"]').fill("3G");
    await phone.getByRole("button", { name: "Save" }).click();
    await until(async () => (await agentInstance(agent, SERVER_ID)).memoryLimit === "3G", "memory saved on the Agent");
    await phone.waitForTimeout(800);
    await agent.api("PATCH", `/api/v1/instances/${SERVER_ID}`, { displayName: "Renamed Elsewhere" });
    await phone.locator('[data-keep="name"]').fill("Phone Edit");
    await phone.getByRole("button", { name: "Save" }).click();
    await waitFor(phone, () => /changed these settings/.test(document.querySelector(".field-error")?.textContent || ""), null, "conflict message");
    assert.strictEqual((await agentInstance(agent, SERVER_ID)).displayName, "Renamed Elsewhere");
    await shot(phone, "07-phone-settings-conflict");
    await agent.api("PATCH", `/api/v1/instances/${SERVER_ID}`, { displayName: "Survival Test" });
    pass("M6", "invalid memory refused (nothing saved), 3G saved on the Agent, stale save refused and the newer name kept");

    // M7
    const binary = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0xfe, 0x80]), crypto.randomBytes(40000)]);
    const uploadFile = path.join(artifacts, "phone-upload.jar");
    fs.writeFileSync(uploadFile, binary);
    await phone.evaluate((id) => { location.hash = `#/server/ovh/${id}/files`; }, SERVER_ID);
    await waitFor(phone, () => document.querySelectorAll(".row").length > 0, null, "file list");
    await phone.locator('input[type="file"]').setInputFiles(uploadFile);
    const uploaded = path.join(serverData, "phone-upload.jar");
    await until(() => fs.existsSync(uploaded) && fs.readFileSync(uploaded).equals(binary), "uploaded bytes on disk");
    await shot(phone, "08-phone-files");
    // Build 213: the same file is not offered as text, and its Download link
    // brings back the exact bytes from the real Agent.
    await phone.locator(".row__main", { hasText: "phone-upload.jar" }).click();
    await waitFor(phone, () => /isn't text/.test(document.querySelector(".sheet")?.textContent || ""), null, "binary file sheet");
    assert.strictEqual(await phone.locator(".sheet textarea").count(), 0, "a binary file never opens in the text editor");
    const downloadHref = await phone.locator(".sheet a", { hasText: "Download" }).getAttribute("href");
    const downloadedBase64 = await phone.evaluate(async (url) => {
      const response = await fetch(url, { credentials: "same-origin" });
      const bytes = new Uint8Array(await response.arrayBuffer());
      let text = "";
      for (let index = 0; index < bytes.length; index += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
      return btoa(text);
    }, downloadHref);
    assert.ok(Buffer.from(downloadedBase64, "base64").equals(binary), "the phone downloads the exact bytes");
    await shot(phone, "08b-phone-binary-file");
    await phone.locator(".sheet").getByRole("button", { name: "Close" }).click();
    pass("M7", `binary upload (${binary.length} bytes) is byte for byte identical on the server's disk; the phone shows it as not text and downloads the same bytes`);

    // M8
    await phone.evaluate((id) => { location.hash = `#/server/ovh/${id}/mods`; }, SERVER_ID);
    await waitFor(phone, () => Boolean(document.querySelector('[data-keep="addon-search"]')), null, "add-on search");
    await phone.locator('[data-keep="addon-search"]').fill("homes");
    await phone.getByRole("button", { name: "Search" }).click();
    await phone.locator(".sheet .row", { hasText: "Homes" }).getByRole("button", { name: "Add" }).click();
    await waitFor(phone, () => document.querySelector(".sheet")?.textContent.includes("Also needed: CoreLib"), null, "install plan with dependency", 20000);
    await shot(phone, "09-phone-addon-plan");
    await phone.locator(".sheet").getByRole("button", { name: "Add all" }).click();
    await until(() => fs.existsSync(path.join(serverData, "plugins", "homes-2.1.jar")) && fs.existsSync(path.join(serverData, "plugins", "corelib-1.4.jar")), "both plugin files installed", 30000);
    pass("M8", "add-on search → plan lists the required CoreLib → approved install wrote both verified files");

    // M9
    await phone.evaluate((id) => { location.hash = `#/server/ovh/${id}/backups`; }, SERVER_ID);
    await waitFor(phone, () => Boolean([...document.querySelectorAll(".button")].find((b) => b.textContent === "Back up now")), null, "backups tab");
    const before = await phone.evaluate(() => document.querySelectorAll(".view .list .row").length);
    await phone.getByRole("button", { name: "Back up now" }).click();
    await phone.locator(".sheet").getByRole("button", { name: "Whole server" }).click();
    await until(async () => {
      await phone.evaluate(() => window.dispatchEvent(new HashChangeEvent("hashchange")));
      await phone.waitForTimeout(1500);
      return (await phone.evaluate(() => document.querySelectorAll(".view .list .row").length)) > before;
    }, "the new backup in the list", 90000);
    const marker = path.join(serverData, "phone-restore-marker.txt");
    fs.writeFileSync(marker, "after backup");
    await phone.locator(".view .list .row").first().getByRole("button", { name: "Backup actions" }).click();
    await phone.locator(".sheet").getByRole("button", { name: "Restore…" }).click();
    await waitFor(phone, () => document.querySelector(".sheet")?.textContent.includes("Type RESTORE"), null, "restore preview", 20000);
    const previewText = await phone.locator(".sheet").textContent();
    assert.match(previewText, /safety copy/);
    assert.strictEqual(await phone.locator(".sheet").getByRole("button", { name: "Restore" }).isDisabled(), true, "Restore stays disabled until RESTORE is typed");
    await shot(phone, "10-phone-restore-preview");
    await phone.locator(".sheet").getByRole("button", { name: "Cancel" }).click();
    await phone.waitForTimeout(1500);
    assert.strictEqual(fs.readFileSync(marker, "utf8"), "after backup", "cancel changes nothing");
    pass("M9", "Back up now added a backup; Restore showed the preview (safety copy), needs RESTORE typed, Cancel changed nothing");

    // M11 (Viewer) while the server runs
    const viewerLink = (await desk.evaluate(() => getDesktopApiState().api.mobile.createPairing("Viewer"))).links[0];
    const viewerCtx = await phoneContext("iphone");
    const viewer = await viewerCtx.newPage();
    watch(viewer, "viewer");
    await viewer.goto(toLocal(viewerLink));
    await viewer.getByLabel("Name this phone").fill("QA Viewer");
    await viewer.getByRole("button", { name: "Pair" }).click();
    await waitFor(viewer, () => document.querySelectorAll(".tile").length === 4, null, "viewer Home", 30000);
    await viewer.evaluate((id) => { location.hash = `#/server/ovh/${id}/overview`; }, SERVER_ID);
    await waitFor(viewer, () => document.querySelector(".card .pill")?.textContent === "Running", null, "viewer Overview");
    assert.strictEqual(await viewer.getByRole("button", { name: "Stop" }).isDisabled(), true);
    assert.match(await viewer.locator(".notice").first().textContent(), /paired as Viewer/);
    await shot(viewer, "11-viewer-overview");
    const direct = await viewer.evaluate(async (id) => {
      const session = await fetch("/api/session").then((response) => response.json());
      const response = await fetch(`/api/servers/ovh/${id}/stop`, { method: "POST", headers: { "Content-Type": "application/json", "X-AnxOS-CSRF": session.csrf }, body: "{}" });
      return { status: response.status, body: await response.json() };
    }, SERVER_ID);
    assert.strictEqual(direct.status, 403);
    assert.strictEqual(direct.body.error.code, "ROLE_DENIED");
    assert.ok(["running", "starting"].includes(String((await agentInstance(agent, SERVER_ID)).state).toLowerCase()), "the server keeps running");
    pass("M11", "Viewer phone: Stop disabled with an explanation; a direct API stop with a valid session is refused (403), server untouched");

    // M12
    await desk.evaluate(() => window.showPage("security"));
    await desk.locator('[data-security-section-target="phone"]').click();
    await waitFor(desk, () => document.querySelector("[data-phone-access-panel]")?.textContent.includes("QA Viewer"), null, "viewer listed on the desktop");
    await desk.locator(".phone-device", { hasText: "QA Viewer" }).getByRole("button", { name: "Remove" }).click();
    const confirm = desk.locator("[data-confirm-ok]").last();
    await confirm.click();
    await waitFor(desk, () => !document.querySelector("[data-phone-access-panel]")?.textContent.includes("QA Viewer"), null, "viewer removed");
    await viewer.evaluate(() => { location.hash = "#/home"; });
    await waitFor(viewer, () => document.body.textContent.includes("This phone isn't paired"), null, "viewer loses access", 20000);
    await shot(desk, "12-desktop-devices");
    pass("M12", "removing the Viewer phone on the desktop ended its access on its next request");

    // M13
    await phone.evaluate(() => { location.hash = "#/home"; });
    await waitFor(phone, () => document.querySelector("[data-status]")?.textContent === "Live", null, "live");
    await ownerCtx.setOffline(true);
    await waitFor(phone, () => !document.querySelector("[data-banner]").hidden && /Can't reach AnxOS/.test(document.querySelector("[data-banner]").textContent), null, "offline banner", 40000);
    await shot(phone, "13-phone-offline");
    await ownerCtx.setOffline(false);
    await phone.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitFor(phone, () => document.querySelector("[data-banner]").hidden && document.querySelector("[data-status]")?.textContent === "Live", null, "recovered", 60000);
    pass("M13", "network loss: banner with the data's age; reconnects and returns to Live by itself");

    // M18
    await phone.setViewportSize({ width: 844, height: 390 });
    for (const target of ["#/home", "#/servers", `#/server/ovh/${SERVER_ID}/overview`, `#/server/ovh/${SERVER_ID}/console`, `#/server/ovh/${SERVER_ID}/settings`]) {
      await phone.evaluate((hash) => { location.hash = hash; }, target);
      await phone.waitForTimeout(900);
      await checkOverflow(`landscape ${target}`);
    }
    await shot(phone, "16-phone-landscape-settings");
    const fieldSize = await phone.evaluate(() => parseFloat(getComputedStyle(document.querySelector(".input")).fontSize));
    assert.ok(fieldSize >= 16, `text fields are ${fieldSize}px`);
    await phone.setViewportSize(PHONES.pixel.viewport);
    pass("M18", `landscape 844×390 without sideways scrolling on 5 views; text fields ${fieldSize}px`);

    // M19
    await phone.evaluate(() => { location.hash = "#/more"; });
    await phone.getByRole("button", { name: "Run the check" }).click();
    await waitFor(phone, () => /Sent to Phone Access/.test(document.body.textContent), null, "phone check sent", 30000);
    await shot(phone, "17-phone-check");
    await desk.evaluate(() => window.showPage("security"));
    await desk.locator('[data-security-section-target="phone"]').click();
    await waitFor(desk, () => /Phone checks/.test(document.querySelector("[data-phone-access-panel]")?.textContent || ""), null, "phone check on the desktop", 20000);
    const listed = await desk.evaluate(() => [...document.querySelectorAll("[data-phone-access-panel] .phone-device")].map((row) => row.textContent).find((text) => text.includes("Chrome on Android")) || "");
    assert.match(listed, /QA Pixel/);
    await shot(desk, "18-desktop-phone-checks");
    pass("M19", `phone check ran on the (emulated) phone and is listed on the desktop: "${listed.slice(0, 120)}"`);

    // M14 (Home polls; More doesn't, so the lock shows on the next poll)
    await phone.evaluate(() => { location.hash = "#/home"; });
    await waitFor(phone, () => document.querySelectorAll(".tile").length === 4, null, "Home before lock");
    await desk.evaluate(() => (window.anxhub?.security || window.anx?.security).logout());
    await phone.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitFor(phone, () => /locked on the computer/.test(document.querySelector("[data-banner]")?.textContent || ""), null, "locked banner", 30000);
    await shot(phone, "14-phone-locked");
    await desk.evaluate((password) => (window.anxhub?.security || window.anx?.security).login({ username: "qa-owner", password }), testPassword);
    await phone.evaluate(() => window.dispatchEvent(new Event("online")));
    await waitFor(phone, () => document.querySelector("[data-banner]").hidden, null, "unlocked again", 30000);
    pass("M14", "locking AnxOS on the computer blocks the phone (423 banner); unlocking restores it");

    // M10
    await phone.evaluate((id) => { location.hash = `#/server/ovh/${id}/overview`; }, SERVER_ID);
    await waitFor(phone, () => document.querySelector(".card .pill")?.textContent === "Running", null, "running before stop");
    await phone.getByRole("button", { name: "Stop" }).click();
    await phone.locator(".sheet").getByRole("button", { name: "Cancel" }).click();
    await phone.waitForTimeout(1500);
    assert.ok(["running", "starting"].includes(String((await agentInstance(agent, SERVER_ID)).state).toLowerCase()), "Cancel keeps it running");
    await phone.getByRole("button", { name: "Stop" }).click();
    await shot(phone, "15-phone-stop-confirm");
    await phone.locator(".sheet").getByRole("button", { name: "Stop server" }).click();
    await until(async () => String((await agentInstance(agent, SERVER_ID)).state).toLowerCase() === "stopped", "the Agent to stop the server", 40000);
    pass("M10", "Stop asks first; Cancel kept it running; confirming stopped it through the Agent");

    // M16
    const pwa = await phone.evaluate(async () => {
      const manifest = await fetch("/manifest.webmanifest").then((response) => response.json());
      const registration = await Promise.race([navigator.serviceWorker.ready.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 8000))]);
      return { manifestName: manifest.name, display: manifest.display, icons: manifest.icons.length, serviceWorker: registration, controller: Boolean(navigator.serviceWorker.controller) };
    });
    let installability = null;
    try {
      const cdp = await ownerCtx.newCDPSession(phone);
      installability = (await cdp.send("Page.getInstallabilityErrors")).installabilityErrors.map((entry) => entry.errorId);
    } catch (error) {
      installability = [`unavailable: ${error.message}`];
    }
    assert.strictEqual(pwa.manifestName, "AnxOS");
    assert.strictEqual(pwa.display, "standalone");
    pass("M16", `manifest ok (standalone, ${pwa.icons} icons); service worker ${pwa.serviceWorker ? "registered" : "NOT registered"}; installability errors: ${installability.length ? installability.join(", ") : "none"}`);

    // M15
    await phone.evaluate((id) => { location.hash = `#/server/ovh/${id}/overview`; }, SERVER_ID);
    await phone.getByRole("button", { name: "Start" }).click();
    await until(async () => String((await agentInstance(agent, SERVER_ID)).state).toLowerCase() === "running", "running again", 40000);
    await browser.close();
    browser = null;
    await new Promise((resolve) => setTimeout(resolve, 5000));
    assert.strictEqual(String((await agentInstance(agent, SERVER_ID)).state).toLowerCase(), "running", "the server keeps running after the phone closes");
    pass("M15", "closing the phone's browser left the server running (checked 5 s later on the Agent)");

    // M17
    assert.deepStrictEqual(phoneErrors, [], `phone errors: ${phoneErrors.join(" | ")}`);
    assert.deepStrictEqual(desktopErrors, [], `desktop errors: ${desktopErrors.join(" | ")}`);
    pass("M17", "no page errors or CSP violations in the phone app; no renderer errors on desktop");

    await desk.evaluate(() => getDesktopApiState().api.mobile.disable());
    console.log(`\nMobile UI QA passed: ${passed.length} checks. Screenshots: ${artifacts}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await app.close().catch(() => {});
    await agent.stop().catch(() => {});
    try { qa.cleanup(); } catch {}
    for (const folder of [userData, edgeProfile]) {
      try { fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5 }); } catch {}
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
