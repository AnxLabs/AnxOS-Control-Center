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
//   P5 My Servers: rows show the game; Sort by name reorders them; in select
//      mode a checkbox click selects without opening the server; bulk Start
//      confirms with every name, skips the running one, starts the stopped
//      one through the normal action path; bulk Stop stops it again
//   P7 Docker: one section at a time (Containers by default), shortcuts,
//      the toolbar keeps only Refresh and the container actions sit in the
//      selected container's details panel; Manage storage opens Volumes;
//      images and volumes say whether a container uses them (Docker is not
//      running on this PC, so the image and volume lists come from fake IPC
//      handlers installed in the test app only)
//   P8 Files: two files dropped on the list of a disposable folder on this
//      PC are uploaded byte for byte; the existing one is replaced only after
//      a confirmation that names it
//   P6 when the Agent goes away, a server that was running reads
//      "Last known: Running", never a live "Running"
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
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const list = (await agent.api("GET", "/api/v1/instances")).json;
      const entry = (Array.isArray(list) ? list : list?.instances || []).find((instance) => instance.id === MC_ID);
      if (/stopped/i.test(String(entry?.state || ""))) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    console.log(`PASS P4 Players tab: ${live.names.join(", ")} online (${live.count.replace(/\s+/g, " ")}); ping Not supported for Minecraft`);

    // P5
    await page.evaluate(async () => { if (window.AnxServerView.isOpen()) await window.AnxServerView.close(); window.showPage("instances"); });
    await page.evaluate(() => refreshInstances?.());
    await waitFor(page, (id) => getInstances().some((instance) => instance.id === id && /stopped/i.test(instance.state || "")), MC_ID, "the test server stopped in the list", 40000);
    await waitFor(page, () => document.querySelectorAll("[data-instances-list] tr[data-instance-id]").length >= 2 && document.querySelector("[data-instances-list]").checkVisibility(), null, "the server list", 20000);
    const rowMeta = await page.evaluate((id) => document.querySelector(`[data-instances-list] tr[data-instance-id="${id}"] .instance-name-cell span`)?.textContent, MC_ID);
    assert.match(rowMeta, /^Minecraft · Paper 1\.21\.1 · players-test$/, `the row says what the server is (${rowMeta})`);
    await page.locator("[data-servers-sort]").selectOption("name");
    await page.waitForTimeout(300);
    const order = await page.evaluate(() => [...document.querySelectorAll("[data-instances-list] tr[data-instance-id]")].map((row) => row.querySelector(".instance-name-cell strong").textContent));
    assert.deepStrictEqual(order, [...order].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })), `sorted by name (${order.join(", ")})`);
    await page.locator("[data-servers-select-toggle]").click();
    await waitFor(page, () => document.querySelectorAll("[data-instances-list] [data-server-select]").length >= 2, null, "checkboxes in select mode");
    const runningId = await page.evaluate((id) => getInstances().find((instance) => instance.id !== id && /running/i.test(instance.state || ""))?.id, MC_ID);
    assert.ok(runningId, "the fixture's running server is listed");
    for (const id of [MC_ID, runningId]) await page.locator(`[data-server-select="${id}"]`).click();
    assert.strictEqual(await page.evaluate(() => window.AnxServerView.isOpen()), false, "a checkbox click does not open the server");
    assert.match(await page.locator("[data-servers-bulk-count]").textContent(), /2 selected/);
    await page.locator('[data-servers-bulk-action="start"]').click();
    await waitFor(page, () => Boolean(document.querySelector("[data-confirm-ok]")), null, "bulk start confirmation");
    const confirmText = await page.evaluate(() => document.querySelector("[data-confirm-ok]").closest(".app-modal").textContent);
    assert.match(confirmText, /Players Test/, "the confirmation names the server to start");
    assert.match(confirmText, /Skipped \(already running or busy\)/, "the running server is skipped and said so");
    await shot(page, "p5-bulk-confirm");
    await page.locator("[data-confirm-ok]").last().click();
    await waitFor(page, (id) => getInstances().some((instance) => instance.id === id && /running/i.test(instance.state || "")), MC_ID, "the selected server started", 60000);
    await page.waitForTimeout(1500);
    await page.locator('[data-servers-bulk-action="stop"]').waitFor({ state: "visible" });
    await waitFor(page, () => !document.querySelector('[data-servers-bulk-action="stop"]').disabled, null, "bulk stop enabled", 20000);
    // Deselect the fixture's service so only the test server is stopped.
    await page.locator(`[data-server-select="${runningId}"]`).click();
    await page.locator('[data-servers-bulk-action="stop"]').click();
    await waitFor(page, () => Boolean(document.querySelector("[data-confirm-ok]")), null, "bulk stop confirmation");
    await page.locator("[data-confirm-ok]").last().click();
    await waitFor(page, (id) => getInstances().some((instance) => instance.id === id && /stopped/i.test(instance.state || "")), MC_ID, "the selected server stopped", 60000);
    await shot(page, "p5-servers");
    await page.locator("[data-servers-select-toggle]").click();
    console.log(`PASS P5 My Servers: game shown, sorted by name, bulk Start skipped the running server and started the stopped one, bulk Stop stopped it`);

    // P7
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("docker:listImages");
      ipcMain.handle("docker:listImages", async () => ({ images: [
        { id: "sha256:aaa", repository: "nginx", tag: "1.27", size: "190MB", containersUsing: ["web"] },
        { id: "sha256:bbb", repository: "redis", tag: "7", size: "130MB", containersUsing: [] },
      ] }));
      ipcMain.removeHandler("docker:listVolumes");
      ipcMain.handle("docker:listVolumes", async () => ({ volumes: [
        { name: "web-data", driver: "local", mountpoint: "/var/lib/docker/volumes/web-data/_data", containersUsing: ["web"] },
        { name: "old-cache", driver: "local", mountpoint: "/var/lib/docker/volumes/old-cache/_data", containersUsing: [] },
      ] }));
    });
    await page.evaluate(() => { try { localStorage.removeItem("anxos.docker.section.v1"); } catch {} window.showPage("docker"); window.AnxDockerWorkspace.show("containers"); });
    await page.waitForTimeout(800);
    const docker = await page.evaluate(() => {
      const host = document.querySelector('.page[data-page="docker"]');
      const visible = (el) => Boolean(el) && el.checkVisibility();
      return {
        sections: [...host.querySelectorAll("[data-docker-section]")].map((button) => button.dataset.dockerSection),
        shortcuts: [...host.querySelectorAll("[data-docker-shortcuts] button")].map((button) => button.textContent),
        toolbar: [...host.querySelectorAll(".docker-toolbar .docker-actions [data-docker-action]")].map((button) => button.dataset.dockerAction),
        detailActions: [...host.querySelectorAll("[data-docker-details-actions] [data-docker-action]")].map((button) => button.dataset.dockerAction),
        tableVisible: visible(host.querySelector(".docker-table-panel")),
        resourcePanelsVisible: [...host.querySelectorAll(".docker-resource-panel")].filter(visible).length,
        height: host.scrollHeight,
      };
    });
    assert.deepStrictEqual(docker.sections, ["containers", "images", "volumes", "networks", "compose", "create", "cleanup"]);
    assert.deepStrictEqual(docker.shortcuts, ["Create a container", "View logs", "Manage storage", "View networks"]);
    assert.deepStrictEqual(docker.toolbar, ["refresh"], "the toolbar keeps only Refresh");
    assert.deepStrictEqual(docker.detailActions, ["start", "stop", "restart", "pause", "unpause", "kill", "remove", "logs", "terminal"], "container actions sit in the details panel");
    assert.deepStrictEqual([docker.tableVisible, docker.resourcePanelsVisible], [true, 0], "Containers shows only the container table and details");
    await shot(page, "p7-docker-containers");
    await page.locator("[data-docker-shortcuts] button", { hasText: "Manage storage" }).click();
    await waitFor(page, () => document.querySelectorAll("[data-docker-volumes-list] .docker-resource-item").length === 2, null, "volumes listed", 15000);
    const storage = await page.evaluate(() => {
      const host = document.querySelector('.page[data-page="docker"]');
      const visible = (el) => Boolean(el) && el.checkVisibility();
      return {
        tableVisible: visible(host.querySelector(".docker-table-panel")),
        panels: [...host.querySelectorAll(".docker-resource-panel")].filter(visible).map((panel) => panel.querySelector("h3").textContent.trim()),
        volumes: [...host.querySelectorAll("[data-docker-volumes-list] .docker-resource-item")].map((item) => ({ text: item.textContent, removeDisabled: item.querySelector("button.inline-action--danger")?.disabled })),
        active: host.querySelector("[data-docker-section].is-active")?.dataset.dockerSection,
      };
    });
    assert.deepStrictEqual([storage.active, storage.tableVisible, storage.panels], ["volumes", false, ["Volumes"]]);
    assert.ok(/used by web/.test(storage.volumes[0].text) && storage.volumes[0].removeDisabled === true, "a volume in use cannot be removed");
    assert.ok(/used by none/.test(storage.volumes[1].text) && storage.volumes[1].removeDisabled === false, "an unused volume can be removed (with confirmation)");
    await shot(page, "p7-docker-storage");
    await page.locator("[data-docker-section=\"images\"]").click();
    await waitFor(page, () => document.querySelectorAll("[data-docker-images-list] .docker-resource-item").length === 2, null, "images listed", 15000);
    const images = await page.evaluate(() => [...document.querySelectorAll("[data-docker-images-list] .docker-resource-item")].map((item) => item.textContent));
    assert.ok(/used by 1 container/.test(images[0]) && /not used by any container/.test(images[1]), `image usage in plain words (${images.join(" | ")})`);
    await page.evaluate(() => window.AnxDockerWorkspace.show("containers"));
    console.log(`PASS P7 Docker: 7 sections, toolbar = Refresh, 9 container actions in the details panel, page ${docker.height}px tall; storage and image usage in plain words`);

    // P8
    const dropFolder = fs.mkdtempSync(path.join(os.tmpdir(), "anx-phase8-drop-"));
    fs.writeFileSync(path.join(dropFolder, "keep.txt"), "old contents");
    await page.evaluate(() => window.showPage("files"));
    // Selecting this PC opens it directly (no Connect click).
    await page.locator(".storage-connection-item", { hasText: "Local Filesystem" }).first().click();
    await waitFor(page, () => filesConnectionState.connected === true && latestFilesListing?.local === true, null, "this PC's files connected", 30000).catch(async (error) => {
      console.log("Files state at timeout:", await page.evaluate(() => JSON.stringify({ state: filesConnectionState, local: latestFilesListing?.local, path: latestFilesListing?.path, items: [...document.querySelectorAll(".storage-connection-item")].map((item) => item.textContent + (item.classList.contains("is-active") ? " [active]" : "")), connect: document.querySelector('[data-file-action="connect"], [data-files-connect]')?.outerHTML?.slice(0, 160) }).slice(0, 1500)));
      throw error;
    });
    await page.locator("[data-files-path]").fill(dropFolder);
    await page.locator('[data-file-action="go"]').click();
    await waitFor(page, () => [...document.querySelectorAll("[data-file-list] tr[data-file-path]")].some((row) => row.dataset.filePath.endsWith("keep.txt")), null, "the disposable folder listed", 20000);
    await page.evaluate(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([new Uint8Array(Array.from({ length: 512 }, (_, index) => index % 256))], "drop.bin"));
      transfer.items.add(new File(["new contents"], "keep.txt", { type: "text/plain" }));
      const zone = document.querySelector("[data-files-drop-zone]");
      zone.dispatchEvent(new DragEvent("dragover", { dataTransfer: transfer, bubbles: true, cancelable: true }));
      zone.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }));
    });
    await waitFor(page, () => Boolean(document.querySelector("[data-confirm-ok]")), null, "replace confirmation", 15000);
    assert.match(await page.evaluate(() => document.querySelector("[data-confirm-ok]").closest(".app-modal").textContent), /keep\.txt already exists/, "the confirmation names the file it would replace");
    await page.locator("[data-confirm-ok]").last().click();
    for (let attempt = 0; attempt < 60 && !(fs.existsSync(path.join(dropFolder, "drop.bin")) && fs.readFileSync(path.join(dropFolder, "keep.txt"), "utf8") === "new contents"); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 250));
    const dropped = fs.readFileSync(path.join(dropFolder, "drop.bin"));
    assert.ok(dropped.equals(Buffer.from(Array.from({ length: 512 }, (_, index) => index % 256))), "the dropped binary file matches byte for byte");
    assert.strictEqual(fs.readFileSync(path.join(dropFolder, "keep.txt"), "utf8"), "new contents", "the confirmed file was replaced");
    await waitFor(page, () => [...document.querySelectorAll("[data-file-list] tr[data-file-path]")].some((row) => row.dataset.filePath.endsWith("drop.bin")), null, "the list refreshed", 15000);
    await shot(page, "p8-files-drop");
    fs.rmSync(dropFolder, { recursive: true, force: true });
    console.log("PASS P8 Files: two dropped files uploaded byte for byte; the existing one replaced after a named confirmation");

    // P6
    await page.evaluate(() => window.showPage("instances"));
    await page.waitForTimeout(500);
    await agent.stop();
    await waitFor(page, (id) => { const pill = document.querySelector(`[data-instances-list] tr[data-instance-id="${id}"] .instance-state`); return Boolean(pill) && pill.classList.contains("is-stale") && pill.textContent === "Last knownRunning"; }, runningId, "the stale state marked as last known", 90000).catch(async (error) => {
      console.log("Row at timeout:", await page.evaluate((id) => document.querySelector(`[data-instances-list] tr[data-instance-id="${id}"]`)?.textContent, runningId), await page.evaluate(() => JSON.stringify({ visual: getNodeVisualState(getSelectedNode()), status: getAgentStatusSnapshot(getSelectedNode()), page: getActivePageName() }).slice(0, 600)));
      throw error;
    });
    await shot(page, "p6-last-known");
    const actionsVisible = await page.evaluate((id) => { const row = document.querySelector(`[data-instances-list] tr[data-instance-id="${id}"]`); const table = row.closest("table").parentElement.getBoundingClientRect(); const last = row.querySelector(".instance-row-actions button:last-child").getBoundingClientRect(); return last.right <= table.right + 1; }, runningId);
    assert.ok(actionsVisible, "the row actions still fit in the table");
    console.log("PASS P6 with the Agent gone, a running server reads 'Last known · Running' and its actions still fit");

    assert.deepStrictEqual(errors, [], `renderer errors: ${errors.join(" | ")}`);
    console.log(`Phase 8 UI QA: 8 checks passed. Screenshots: ${shotsDir}`);
  } finally {
    await Promise.race([app.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 15000))]);
    await agent.stop().catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
