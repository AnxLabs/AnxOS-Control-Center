#!/usr/bin/env node
"use strict";

// The six Build 212 acceptance findings, checked in the REAL Electron app
// (isolated profile and config, --qa-mode, a test Agent on this PC started by
// this script). Never touches the installed app, its Local Agent or its data.
//   A1 Agent Control and Computers show the build the Agent reports
//      (identity.agentArtifactVersion), never the "0.1.0" placeholder; an
//      Agent that reports no build reads "Build not reported"
//   A2 while AnxOS is locked, background polling sends no protected requests
//      (no LOGIN_REQUIRED stream in ipc.log), and it resumes after the unlock
//   A3 with an offline REMOTE computer selected, Home never says "Connect
//      your local Agent"; its action opens that computer
//   A4 Docker: Restart, Remove and Logs of every row are visible without
//      horizontal scrolling at 1100, 1440 and 1920 px wide windows
//   A5 SSH: the status line shows the active session's own message, not the
//      last event of another session
//   A6 Files: the Folders pill reflects the selected storage, not the
//      selected computer's Agent: an offline computer's storage never reads
//      "Connected" while another computer is selected and online
// Found by the RC2 acceptance in the installed app:
//   A7 after switching from an online computer to an offline one, Home's
//      setup checklist describes the offline one, not the earlier Agent
//      Control reply
//   A8 the metrics notice for an offline computer does not outlive the switch
//      to an online one, and every error toast leaves the screen by itself
//      (measured by computed opacity, not by class)
// Set ACCEPTANCE_QA_SHOTS=<dir> to keep screenshots. ANX_QA_APP_ROOT runs
// these checks against another checkout (used to show they fail before the
// fixes).
// Run: node scripts/acceptance-fixes-ui-qa.js

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");

const appRoot = path.resolve(process.env.ANX_QA_APP_ROOT || path.join(__dirname, ".."));
const shotsDir = process.env.ACCEPTANCE_QA_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "anx-acceptance-shots-"));
const only = new Set(String(process.env.ACCEPTANCE_QA_ONLY || "").split(",").map((value) => value.trim()).filter(Boolean));
const runs = (id) => !only.size || only.has(id);

async function waitFor(page, predicate, arg, label, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await page.evaluate(predicate, arg).catch(() => false)) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function readIpcLog(logDir) {
  const file = path.join(logDir, "ipc.log");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

function buildLabel(artifactVersion) {
  const match = String(artifactVersion || "").match(/^v?(\d+)\.(\d+)-build(\d+)$/i);
  return match ? `${Number(match[1])}.${Number(match[2])} Build ${Number(match[3])}` : "Build not reported";
}

async function main() {
  const agent = await startServiceManagedAgent({ initial: "running" });
  const qa = createIsolatedQaEnv("anx-acceptance-qa-config-");
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  // "lab" is the test Agent (online); "vps" points at a closed loopback port,
  // like a remote computer whose tunnel is down.
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "lab", nodes: [
    { id: "lab", kind: "agent", name: "Lab", displayName: "Lab", baseUrl: agent.url, agentUrl: agent.url, enabled: true },
    { id: "vps", kind: "agent", name: "VPS", displayName: "VPS", baseUrl: "http://127.0.0.1:9", agentUrl: "http://127.0.0.1:9", enabled: true },
  ] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { lab: { agentToken: agent.token }, vps: { agentToken: crypto.randomBytes(16).toString("hex") } } });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-acceptance-qa-profile-"));
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", appRoot, "--qa-mode"], env });
  const errors = [];
  const shot = (page, name) => page.screenshot({ path: path.join(shotsDir, `${name}.png`) });
  const failures = [];
  const check = async (id, fn) => {
    if (!runs(id)) return;
    try {
      await fn();
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
    // A test owner with a random per-run password that is never printed or saved.
    const testPassword = `Qa-${crypto.randomBytes(12).toString("hex")}-Zz9!`;
    const setup = await page.evaluate(async (password) => {
      const security = window.anxhub?.security || window.anx?.security;
      const created = await security.setupAdmin({ username: "qa-owner", password, passwordConfirm: password }).catch((error) => ({ error: error?.message }));
      return { error: created?.error || null };
    }, testPassword);
    assert.ok(!setup.error, `QA owner setup failed: ${setup.error}`);
    const unlock = async () => {
      const result = await page.evaluate(async (password) => {
        const security = window.anxhub?.security || window.anx?.security;
        return security.login({ username: "qa-owner", password }).then(() => null).catch((error) => error?.message || "login failed");
      }, testPassword);
      assert.strictEqual(result, null, `QA owner unlock failed: ${result}`);
    };

    // A2 (first, while the app starts locked like a fresh launch)
    await check("A2", async () => {
      await page.evaluate(async () => { const security = window.anxhub?.security || window.anx?.security; await security.logout().catch(() => {}); });
      // A locked launch on the page polling hits hardest: Computers.
      await page.evaluate(() => { try { localStorage.setItem("anxos.computers.selected.v1", "lab"); } catch {} });
      await page.reload();
      await waitFor(page, () => typeof window.showPage === "function", null, "renderer after lock", 60000);
      await waitFor(page, () => securityState && securityState.localOwnerAuthenticated !== true && document.querySelector("[data-security-title]")?.offsetParent !== null, null, "the sign-in screen", 30000);
      await page.evaluate(() => { window.showPage("nodes"); });
      await page.waitForTimeout(4000); // the one-off startup reads settle
      const lockedFrom = Date.now();
      await page.waitForTimeout(12000);
      const lockedTo = Date.now();
      const locked = readIpcLog(qa.logDir).filter((entry) => {
        const at = Date.parse(entry.timestamp);
        return at >= lockedFrom && at <= lockedTo && /LOGIN_REQUIRED|LOCAL_AUTHENTICATION_REQUIRED/.test(`${entry.errorCode || ""} ${entry.message || ""}`);
      });
      await shot(page, "a2-locked");
      assert.strictEqual(locked.length, 0, `no authorization errors while locked for 12 s (got ${locked.length}: ${[...new Set(locked.map((entry) => entry.operation))].join(", ")})`);
      await unlock();
      await page.reload();
      await waitFor(page, () => securityState?.localOwnerAuthenticated === true, null, "unlocked", 60000);
      if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
      await page.evaluate(() => window.showPage("dashboard"));
      const resumedFrom = Date.now();
      await page.waitForTimeout(7000);
      const resumed = readIpcLog(qa.logDir).filter((entry) => Date.parse(entry.timestamp) >= resumedFrom && entry.operation === "system:getSnapshot" && entry.message === "IPC request completed");
      assert.ok(resumed.length >= 2, `the dashboard polls again after the unlock (${resumed.length} snapshots in 7 s)`);
      console.log(`PASS A2 locked: 0 authorization errors in 12 s; unlocked: ${resumed.length} snapshot reads in 7 s`);
    });
    if (!runs("A2")) {
      await unlock();
      await page.reload();
      await waitFor(page, () => securityState?.localOwnerAuthenticated === true, null, "unlocked", 60000);
      if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    }
    await waitFor(page, () => (document.querySelector(".nav-menu")?.getBoundingClientRect().width || 0) > 0, null, "app shell", 60000);
    await page.evaluate(async () => { await selectNode("lab"); });
    await waitFor(page, () => getNodeVisualState(getSelectedNode()) === "online", null, "the test Agent online", 60000);

    // A1
    await check("A1", async () => {
      const health = await fetch(`${agent.url}/api/v1/health`).then((response) => response.json());
      const expected = buildLabel(health?.identity?.agentArtifactVersion);
      assert.notStrictEqual(health?.identity?.agentVersion, undefined, "the test Agent reports the package placeholder too");
      await page.evaluate(() => window.showPage("agent-control"));
      await page.evaluate(() => refreshAgentControl({ includeConfig: true }));
      await waitFor(page, (label) => [...document.querySelectorAll('[data-agent-control-field="agentVersion"]')].some((field) => field.textContent === label), expected, `Agent Control version "${expected}"`, 30000).catch(async (error) => {
        console.log("Agent version fields:", await page.evaluate(() => [...document.querySelectorAll('[data-agent-control-field="agentVersion"]')].map((field) => field.textContent)));
        throw error;
      });
      const shown = await page.evaluate(() => ({
        fields: [...document.querySelectorAll('[data-agent-control-field="agentVersion"]')].map((field) => field.textContent),
        compatibility: getAgentCompatibilityView().agentVersion,
        computers: formatNodeAgentContext(getSelectedNode()),
        routes: describeNodeAgentBuild(getSelectedNode()),
        old: formatAgentVersionForDisplay({ agentVersion: "0.1.0", identity: { agentVersion: "0.1.0" } }),
        page: document.querySelector('.page[data-page="agent-control"]')?.textContent || "",
      }));
      assert.strictEqual(shown.compatibility, expected, "the compatibility card names the reported build");
      assert.ok(shown.computers.endsWith(`Agent ${expected}`), `Computers shows the reported build (${shown.computers})`);
      assert.ok(shown.routes.startsWith(`Agent ${expected}`), `Routes shows the reported build (${shown.routes})`);
      assert.strictEqual(shown.old, "Build not reported", "an Agent that reports only the placeholder reads Build not reported");
      assert.ok(!/Version 0\.1\.0|Agent 0\.1\.0/.test(shown.page), "Agent Control never shows the 0.1.0 placeholder");
      await shot(page, "a1-agent-control");
      console.log(`PASS A1 Agent Control, compatibility, Computers and Routes show "${expected}"; a build-less Agent reads "Build not reported"`);
    });

    // A3
    await check("A3", async () => {
      await page.evaluate(async () => { await selectNode("vps"); window.showPage("dashboard"); });
      await waitFor(page, () => getNodeVisualState(getSelectedNode()) === "offline", null, "VPS offline", 60000);
      await page.waitForTimeout(1500);
      const home = await page.evaluate(() => {
        const state = getFriendlyDashboardState();
        window.AnxHomeDashboard?.renderHome?.();
        return { next: state.next, setup: state.setup, text: document.querySelector('.page[data-page="dashboard"]')?.textContent || "" };
      });
      assert.ok(!/local Agent/i.test(`${home.next.title} ${home.next.detail}`), `the next step is not about this PC's Agent (${home.next.title})`);
      assert.strictEqual(home.next.title, "Reconnect VPS");
      assert.strictEqual(home.next.action, "selected-computer");
      assert.ok(!/Connect your local Agent/.test(home.text), "Home never shows Connect your local Agent for the remote computer");
      await shot(page, "a3-home-remote-offline");
      await page.evaluate(() => runDashboardFriendlyAction("selected-computer"));
      await waitFor(page, () => getActivePageName() === "nodes" && localStorage.getItem("anxos.computers.viewing.v1") === "vps", null, "Computers opened on VPS", 10000);
      console.log("PASS A3 an offline remote computer gets 'Reconnect VPS', which opens that computer, never 'Connect your local Agent'");
    });

    if (runs("A3")) {
      await page.evaluate(async () => { await selectNode("lab"); });
      await waitFor(page, () => getNodeVisualState(getSelectedNode()) === "online", null, "back on the test Agent", 60000);
    }

    // A4
    await check("A4", async () => {
      await app.evaluate(({ ipcMain }) => {
        const containers = ["sona-api", "sona-sandbox", "sona-plugins", "sona-staging-sandbox", "sona-staging-plugins", "sona-staging-api", "sona-staging-tunnel"].map((name, index) => ({
          id: `c${index}`.padEnd(12, "0"), name, image: `anxlabs/${name}:1.0.0`, state: "running", status: `Up ${35 + index} hours (healthy)`,
          ports: index % 2 ? "0.0.0.0:80${index}->80/tcp, [::]:80${index}->80/tcp" : "", runningFor: `${35 + index} hours ago`,
          cpuPercent: 1.2, memoryUsage: "809 MB / 15.4 GB", memoryPercent: 5,
        }));
        ipcMain.removeHandler("docker:getSnapshot");
        ipcMain.handle("docker:getSnapshot", async () => ({ installed: true, daemonRunning: true, available: true, version: "27.0.0", containers, summary: { runningContainers: containers.length, stoppedContainers: 0, totalContainers: containers.length, images: 7, volumes: 2 } }));
      });
      const results = [];
      for (const [width, height] of [[1100, 800], [1440, 960], [1920, 1080]]) {
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size[0], size[1]), [width, height]);
        await page.evaluate(() => { window.showPage("docker"); window.AnxDockerWorkspace?.show?.("containers"); return refreshDockerStatus(); });
        await waitFor(page, () => document.querySelectorAll("[data-docker-list] tr").length === 7, null, "seven container rows", 20000);
        await page.evaluate(() => selectDockerContainer(document.querySelector("[data-docker-list] tr")?.dataset.dockerContainerId));
        await page.waitForTimeout(400);
        const layout = await page.evaluate(() => {
          const wrap = document.querySelector('.page[data-page="docker"] .docker-table-wrap');
          const box = wrap.getBoundingClientRect();
          const hidden = [];
          document.querySelectorAll("[data-docker-list] tr").forEach((row) => {
            row.querySelectorAll("[data-docker-row-action]").forEach((button) => {
              const rect = button.getBoundingClientRect();
              if (rect.width === 0 || rect.right > box.right + 1 || rect.left < box.left - 1) hidden.push(`${row.dataset.dockerContainerId}:${button.dataset.dockerRowAction}`);
            });
          });
          return { hidden, overflow: wrap.scrollWidth - wrap.clientWidth, wrap: Math.round(box.width) };
        });
        await shot(page, `a4-docker-${width}`);
        results.push(`${width}px: table ${layout.wrap}px, overflow ${layout.overflow}px`);
        assert.deepStrictEqual(layout.hidden, [], `at ${width}px every row action is visible (${layout.hidden.slice(0, 5).join(", ")})`);
        assert.ok(layout.overflow <= 1, `at ${width}px the container table needs no horizontal scrolling (overflow ${layout.overflow}px)`);
      }
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 960));
      console.log(`PASS A4 Docker row actions visible without horizontal scrolling (${results.join("; ")})`);
    });

    // A5
    await check("A5", async () => {
      await app.evaluate(({ ipcMain }) => {
        for (const channel of ["ssh:resize", "ssh:getSession", "ssh:write"]) {
          ipcMain.removeHandler(channel);
          ipcMain.handle(channel, async () => null);
        }
      });
      await page.evaluate(() => window.showPage("ssh"));
      await page.waitForTimeout(500);
      const send = (payload) => app.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.send("ssh:status", value), payload);
      const nodeId = await page.evaluate(() => getSelectedNodeId());
      const session = (id, label, extra = {}) => ({ id, label, nodeId, status: "connected", shellReady: true, profileId: `profile-${id}`, endpoint: `${id}@192.0.2.${id === "alpha" ? 10 : 20}:22`, message: `Connected to ${label}. Shell ready.`, ...extra });
      await send({ type: "session-updated", session: session("alpha", "Alpha") });
      await send({ type: "session-updated", session: session("bravo", "Bravo") });
      await page.waitForTimeout(300);
      // Make Alpha active, then let Bravo's events arrive.
      await page.locator(".ssh-session-tabs .ssh-tab", { hasText: "Alpha" }).first().click();
      await send({ type: "session-updated", session: session("bravo", "Bravo", { message: "Connected to Bravo. Shell ready." }) });
      await send({ type: "session-closed", sessionId: "bravo", message: "Bravo disconnected." });
      await page.waitForTimeout(400);
      const alpha = await page.evaluate(() => ({ active: getActiveSshSession()?.id, message: document.querySelector('[data-ssh-status="message"]')?.textContent || "", session: document.querySelector('[data-ssh-status="session"]')?.textContent || "", endpoint: document.querySelector('[data-ssh-status="endpoint"]')?.textContent || "" }));
      await shot(page, "a5-ssh-alpha");
      assert.strictEqual(alpha.active, "alpha");
      assert.ok(!/Bravo/.test(alpha.message), `Alpha's status line never shows Bravo's events (${alpha.message})`);
      assert.match(alpha.message, /Alpha/, "Alpha's own message is shown");
      assert.ok(!/bravo|192\.0\.2\.20/i.test(`${alpha.session} ${alpha.endpoint}`), "session and endpoint belong to Alpha");
      await page.locator(".ssh-session-tabs .ssh-tab", { hasText: "Bravo" }).first().click();
      await page.waitForTimeout(300);
      const bravo = await page.evaluate(() => document.querySelector('[data-ssh-status="message"]')?.textContent || "");
      assert.match(bravo, /Bravo disconnected/, `switching to Bravo shows Bravo's own last message (${bravo})`);
      console.log("PASS A5 the SSH status line shows only the active session's messages");
    });

    // A6
    await check("A6", async () => {
      await page.evaluate(() => window.showPage("files"));
      await page.locator(".storage-connection-item", { hasText: "VPS" }).first().click({ timeout: 15000 }).catch(async (error) => { console.log("storage items:", JSON.stringify(await page.evaluate(() => [...document.querySelectorAll(".storage-connection-item")].map((item) => item.textContent.replace(/\s+/g, " ").trim())))); throw error; });
      await waitFor(page, () => filesConnectionState.status !== "connecting" && Boolean(filesConnectionFailure || !filesConnectionState.connected), null, "the VPS storage attempt finished", 45000);
      await page.waitForTimeout(500);
      const vps = await page.evaluate(() => ({ pill: document.querySelector(".folder-tree-panel .panel-heading .status-pill")?.textContent, selected: getSelectedNodeId(), selectedOnline: getNodeVisualState(getSelectedNode()) }));
      await shot(page, "a6-files-vps");
      assert.strictEqual(vps.selected, "lab", "the online test Agent stays the selected computer");
      assert.strictEqual(vps.selectedOnline, "online");
      assert.notStrictEqual(vps.pill, "Connected", "the offline VPS storage never reads Connected");
      assert.ok(["Unavailable", "Disconnected"].includes(vps.pill), `the pill says the storage is not available (${vps.pill})`);
      await page.locator(".storage-connection-item", { hasText: agent.url }).first().click();
      await waitFor(page, () => filesConnectionState.connected === true, null, "Lab storage connected", 45000);
      await page.waitForTimeout(300);
      const lab = await page.evaluate(() => document.querySelector(".folder-tree-panel .panel-heading .status-pill")?.textContent);
      assert.strictEqual(lab, "Connected", "a connected storage reads Connected");
      console.log(`PASS A6 Files: offline VPS storage reads "${vps.pill}" while Lab is selected; Lab storage reads "Connected"`);
    });

    // A7 (Build 212 RC2 acceptance) Home's setup checklist read the Agent
    // Control reply of the computer selected before: after switching from an
    // online computer to an offline one it kept "Agent connected".
    await check("A7", async () => {
      await page.evaluate(async () => { await selectNode("lab"); window.showPage("agent-control"); await refreshAgentControl({ includeConfig: true }); });
      await waitFor(page, () => agentControlState?.selectedNodeId === "lab", null, "an Agent Control reply for Lab", 30000);
      await page.evaluate(() => { window.__qaLabAgentControlReply = agentControlState; });
      await page.evaluate(async () => { await selectNode("vps"); window.showPage("dashboard"); });
      await waitFor(page, () => getNodeVisualState(getSelectedNode()) === "offline", null, "VPS offline", 60000);
      await page.waitForTimeout(1500);
      const setup = await page.evaluate(() => {
        // The installed app kept Lab's reply for minutes (Agent Control polls
        // only while its page is open); a background refresh can replace it
        // here first, so put Lab's reply back to test that state exactly.
        if (agentControlState?.selectedNodeId !== "lab") agentControlState = window.__qaLabAgentControlReply;
        const item = getSetupHealthState().core.find((entry) => entry.title === "Agent connected");
        return { replyFor: agentControlState?.selectedNodeId || null, complete: item?.complete, detail: item?.detail, status: item?.status };
      });
      await shot(page, "a7-home-checklist-vps");
      assert.strictEqual(setup.replyFor, "lab", "the last Agent Control reply is still Lab's (the case under test)");
      assert.strictEqual(setup.complete, false, `the checklist does not mark the offline VPS's Agent connected (${setup.status}: ${setup.detail})`);
      assert.ok(!/can use the selected connection/.test(setup.detail || ""), `the detail does not claim a working connection (${setup.detail})`);
      console.log(`PASS A7 Home's checklist describes the offline VPS ("${setup.detail}"), not Lab's earlier reply`);
    });

    // A8 (Build 212 RC2 acceptance) "System metrics are unavailable." raised
    // for an offline computer stayed on screen after switching to an online one.
    await check("A8", async () => {
      // Start from a healthy Lab dashboard (the notice is raised once per failing computer).
      await page.evaluate(async () => { await selectNode("lab"); window.showPage("dashboard"); });
      await waitFor(page, () => latestSystemSnapshotNodeId === "lab" && systemMetricsToastNodeId === null, null, "Lab's metrics loaded", 60000);
      await page.evaluate(() => {
        window.__qaToasts = [];
        const original = window.showToast;
        window.showToast = function qaShowToast(message, tone) {
          window.__qaToasts.push({ at: Date.now(), message: String(message), node: getSelectedNodeId(), page: getActivePageName(), stack: String(new Error().stack || "").split("\n").slice(2, 5).join(" | ") });
          return original.call(this, message, tone);
        };
      });
      await page.evaluate(async () => { await selectNode("vps"); window.showPage("dashboard"); });
      await waitFor(page, () => window.__qaToasts.some((entry) => entry.message === "System metrics are unavailable."), null, "the metrics notice for the offline VPS", 30000);
      await page.evaluate(async () => { await selectNode("lab"); window.showPage("network"); });
      await waitFor(page, () => getNodeVisualState(getSelectedNode()) === "online", null, "back on Lab", 60000);
      const switchedAt = Date.now();
      await page.waitForTimeout(10000);
      // What is on screen, not the class: in RC2 the class was gone but a
      // filled [data-tone="error"] animation kept the toast at opacity 1.
      const onScreen = () => page.evaluate(() => {
        const element = document.querySelector("#toast");
        return { opacity: Number(getComputedStyle(element).opacity), text: element.textContent || "", tone: element.dataset.tone || "" };
      });
      const after = await page.evaluate((since) => window.__qaToasts.filter((entry) => entry.at >= since), switchedAt);
      const shown = await onScreen();
      await shot(page, "a8-toast-after-switch");
      if (after.length) console.log("toasts after the switch:", JSON.stringify(after.slice(0, 6)));
      assert.ok(!after.some((entry) => entry.message === "System metrics are unavailable."), "the notice is not raised again for Lab");
      assert.ok(!(shown.opacity > 0.05 && shown.text === "System metrics are unavailable."), `the VPS's metrics notice is off screen 10 s after switching to the online Lab (opacity ${shown.opacity})`);
      // Any error toast hides by itself.
      await page.evaluate(() => window.showToast("QA probe failed.", "error"));
      await page.waitForTimeout(500);
      const raised = await onScreen();
      assert.ok(raised.opacity > 0.9 && raised.tone === "error", `an error toast is shown (opacity ${raised.opacity})`);
      await page.waitForTimeout(8000);
      const later = await onScreen();
      assert.ok(later.opacity < 0.05, `an error toast hides after its duration (opacity ${later.opacity} after 8.5 s)`);
      console.log(`PASS A8 the metrics notice does not outlive the switch, and error toasts hide (opacity ${later.opacity})`);
    });

    const unexpected = errors.filter((message) => !/ResizeObserver loop/.test(message));
    if (unexpected.length) failures.push(`renderer errors: ${unexpected.join(" | ")}`);
    if (failures.length) throw new Error(`${failures.length} check(s) failed:\n  ${failures.join("\n  ")}`);
    console.log(`Acceptance fixes UI QA: ${only.size || 8} checks passed. Screenshots: ${shotsDir}`);
  } finally {
    await Promise.race([app.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 15000))]);
    await agent.stop().catch(() => {});
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error("FAILED:", error.message || error);
  process.exit(1);
});
