#!/usr/bin/env node
"use strict";

// Build 215 features in the REAL Electron app (isolated profile, config and
// home folder, --qa-mode), against DISPOSABLE targets only:
//   - the anx215-a systemd container (official anxos-agent package, update
//     helper, OpenSSH on 127.0.0.1:2221, Agent on 127.0.0.1:47191), prepared
//     by scripts/build215-agent-update-acceptance.js's setup;
//   - a disposable Agent started from this checkout, using this PC's Docker.
// Never touches the installed app, its Local Agent, Anxlab or the VPS.
//
//   U1 a locked start loads SSH profiles once unlocked, without visiting Files
//      (Bug A), and Agent Control can Verify Access
//   K1 SSH > Set up key sign-in turns the password profile into a key profile
//   E1 the Update tooltip names the package method (Bug E)
//   F1 the Update confirmation: stacked title, computer, both builds, method,
//      services (Bug F)
//   P1 live progress steps while the real 2.0-build213 -> 2.0-build214 update
//      runs through the update helper
//   C1 afterwards: no stale "Pending" line or "not connected", history shows
//      the verified build, nowhere "0.1.0" (Bugs C, D)
//   D1 Create Server shows "Will it run on this computer?" above Advanced
//      options, and it follows the memory field
//   W1 My Servers > All computers lists Docker services with type, ports and
//      kept data next to the computers' servers
//   W2 Update on an AnxOS Docker service (older nginx under the template tag)
//      replaces it from the window and keeps its data
// Screenshots: BUILD215_QA_SHOTS=<dir>. BUILD215_QA_ONLY=D1,W1 runs a subset
// (checks after K1 need K1). Run: node scripts/build215-ui-qa.js

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { _electron: electron } = require("playwright-core");
const { Client } = require("ssh2");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");

const appRoot = path.resolve(path.join(__dirname, ".."));
const shotsDir = process.env.BUILD215_QA_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "anx-build215-shots-"));
fs.mkdirSync(shotsDir, { recursive: true });
const CONTAINER = "anx215-a";
const SSH_PORT = 2221;
const AGENT_PORT = 47191;
const FROM = "2.0-build213";
const TO = "2.0-build214";
const PASSWORD = process.env.ANX215_PASSWORD || "anx215-disposable-pw";
const NGINX = "anx215qa-web";
const NGINX_PORT = 18081;
// The open confirmation (static modals elsewhere in the page are hidden).
const OPEN_DIALOG = ".app-modal-backdrop:last-of-type .app-modal";

const dockerExec = (script) => execFileSync("docker", ["exec", CONTAINER, "bash", "-c", script], { encoding: "utf8", env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
const docker = (args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}

async function waitFor(page, predicate, arg, label, timeoutMs = 30000) {
  try {
    await page.waitForFunction(predicate, arg, { timeout: timeoutMs, polling: 400 });
  } catch (error) {
    throw new Error(`Timed out waiting for ${label}: ${error.message.split("\n")[0]}`);
  }
}

async function hostFingerprint() {
  const seen = await new Promise((resolve, reject) => {
    const client = new Client();
    let fingerprint = null;
    client.on("error", (error) => (fingerprint ? resolve(fingerprint) : reject(error)));
    client.on("ready", () => { client.end(); resolve(fingerprint); });
    client.connect({ host: "127.0.0.1", port: SSH_PORT, username: "nobody-probe", password: "x", tryKeyboard: false, hostVerifier: (key) => {
      fingerprint = `SHA256:${crypto.createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
      return true;
    } });
  });
  const local = dockerExec("for f in /etc/ssh/ssh_host_*_key.pub; do ssh-keygen -lf $f | cut -d' ' -f2; done").split(/\s+/).filter(Boolean);
  assert(local.includes(seen), "the SSH host key is the container's own");
  return seen;
}

async function startLocalAgent(root) {
  const token = `anxos_build215-qa-${crypto.randomBytes(16).toString("hex")}`;
  const configDir = path.join(root, "config");
  for (const dir of [configDir, path.join(root, "instances"), path.join(root, "logs")]) fs.mkdirSync(dir, { recursive: true });
  const port = await freePort();
  fs.writeFileSync(path.join(configDir, "agent.json"), `${JSON.stringify({ backendMode: "agent", agentUrl: `http://127.0.0.1:${port}`, agentToken: token }, null, 2)}\n`);
  const child = spawn(process.execPath, [path.join(appRoot, "agent", "src", "server.js")], {
    cwd: path.join(appRoot, "agent"),
    env: { ...process.env, ANXHUB_CONFIG_DIR: configDir, ANXHUB_AGENT_CONFIG_PATH: path.join(configDir, "agent.json"), AGENT_HOST: "127.0.0.1", AGENT_PORT: String(port), AGENT_TOKEN: token, AGENT_IDENTITY_PATH: path.join(configDir, "identity.json"), AGENT_INSTANCE_ROOT: path.join(root, "instances"), ANXOS_LOG_DIR: path.join(root, "logs") },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${url}/api/v1/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error("the disposable Agent did not start");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { child, url, token };
}

async function main() {
  // Disposable node A back on the older build, key sign-in not yet set up.
  if (dockerExec("dpkg-query -W -f='${Version}' anxos-agent").trim() !== FROM) {
    const back = dockerExec(`/usr/lib/anxos-agent/update-helper rollback ${FROM} || true`);
    assert(/RESULT=rolled-back/.test(back), `could not put ${CONTAINER} back on ${FROM}: ${back}`);
  }
  dockerExec("rm -f /home/anx/.ssh/authorized_keys");
  const nodeToken = dockerExec('python3 -c "import json; print(json.load(open(\'/var/lib/anxos-agent/config/agent.json\'))[\'agentToken\'])"').trim();
  const fingerprint = await hostFingerprint();

  // An AnxOS-installed nginx on an older image (for W2), via the same request
  // builder as the Marketplace.
  for (const args of [["rm", "-f", NGINX], ["rm", "-f", `${NGINX}-before-update`], ["volume", "rm", "-f", `${NGINX}-site`]]) { try { docker(args); } catch {} }
  docker(["pull", "-q", "nginx:1.26-alpine"]);
  docker(["tag", "nginx:1.26-alpine", "nginx:stable-alpine"]);
  const { buildDockerInstallRequest } = require("../src/shared/marketplaceDockerTemplate");
  const { findTemplate } = require("../src/services/marketplaceService");
  const { payload } = buildDockerInstallRequest(findTemplate("docker-nginx"), { containerName: NGINX, hostPorts: [NGINX_PORT], portMappings: [`${NGINX_PORT}:80`], start: true });
  await require("../src/shared/dockerService").createContainer(payload);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  docker(["exec", NGINX, "sh", "-c", "echo anx215-ui-kept > /usr/share/nginx/html/marker.txt"]);
  const nginxOldImage = docker(["inspect", NGINX, "--format", "{{.Image}}"]);

  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-build215-qa-agent-"));
  const lab = await startLocalAgent(agentRoot);
  const qa = createIsolatedQaEnv("anx-build215-qa-config-");
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "anx-build215-qa-home-"));
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  const closedPort = await freePort();
  require("../src/shared/agentRuntimeConfigStore").saveAgentRuntimeConfig(path.join(qa.configDir, "agent-runtime.json"), { port: closedPort });
  const nodeUrl = `http://127.0.0.1:${AGENT_PORT}`;
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "anx215a", nodes: [
    { id: "anx215a", kind: "agent", name: "Test node A", displayName: "Test node A", baseUrl: nodeUrl, agentUrl: nodeUrl, enabled: true },
    { id: "lab", kind: "agent", name: "Lab PC", displayName: "Lab PC", baseUrl: lab.url, agentUrl: lab.url, enabled: true },
  ] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { anx215a: { agentToken: nodeToken }, lab: { agentToken: lab.token } } });
  write("ssh-profiles.json", { schemaVersion: 1, servers: [{ id: "test-node-a-server", displayName: "Test node A", host: "127.0.0.1", nodeId: "anx215a" }], profiles: [{ id: "test-node-a-anx", serverId: "test-node-a-server", displayName: "Test node A", host: "127.0.0.1", port: SSH_PORT, username: "anx", authType: "password", nodeId: "anx215a" }], defaultServerId: "test-node-a-server", defaultProfileId: "test-node-a-anx" });
  write("ssh-known-hosts.json", { [`127.0.0.1:${SSH_PORT}`]: { fingerprint, approvedAt: new Date().toISOString() } });

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-build215-qa-profile-"));
  // The new key goes to this disposable home, never the developer's ~/.ssh.
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1", USERPROFILE: home, HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const launch = () => electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", appRoot, "--qa-mode"], env });
  // First launch only creates the owner, so the second one starts locked.
  const ownerPassword = `Qa-${crypto.randomBytes(12).toString("hex")}-Zz9!`;
  {
    const first = await launch();
    const page = await first.firstWindow();
    await waitFor(page, () => typeof window.showPage === "function", null, "renderer", 60000);
    const useDevice = page.getByRole("button", { name: "Use this device" }).first();
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    await page.evaluate(async (password) => {
      const security = window.anxhub?.security || window.anx?.security;
      await security.setupAdmin({ username: "qa-owner", password, passwordConfirm: password });
    }, ownerPassword);
    await first.close();
  }
  const app = await launch();
  const errors = [];
  const results = [];
  const shot = (page, name) => page.screenshot({ path: path.join(shotsDir, `${name}.png`) }).catch(() => {});
  const only = new Set(String(process.env.BUILD215_QA_ONLY || "").split(",").map((value) => value.trim()).filter(Boolean));
  const check = async (id, title, fn) => {
    if (only.size && !only.has(id)) return;
    try {
      const note = await fn();
      results.push({ id, title, passed: true, note: note || "" });
      console.log(`PASS ${id} ${title}${note ? ` — ${note}` : ""}`);
    } catch (error) {
      results.push({ id, title, passed: false, note: error.message });
      console.log(`FAIL ${id} ${title} — ${error.message}`);
    }
  };
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 960));
    await waitFor(page, () => typeof window.showPage === "function", null, "renderer", 60000);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const lockedProfiles = await page.evaluate(() => ({ count: sshProfilesState.profiles.length, locked: securityState?.localOwnerAuthenticated !== true }));
    // The unlock the way the sign-in screen does it (login, then the
    // protected-state refresh).
    await page.evaluate(async (password) => {
      const security = window.anxhub?.security || window.anx?.security;
      const result = await security.login({ username: "qa-owner", password });
      await refreshProtectedStateAfterLocalOwnerAuthentication(result);
    }, ownerPassword);

    await check("U1", "SSH profiles load at unlock (no visit to Files)", async () => {
      await waitFor(page, () => sshProfilesState.profiles.length > 0, null, "SSH profiles after unlock", 20000);
      const visitedFiles = await page.evaluate(() => document.querySelector('[data-page="files"]')?.classList.contains("is-active") || false);
      assert.strictEqual(visitedFiles, false);
      assert.strictEqual(lockedProfiles.locked, true, "the app started locked");
      assert.strictEqual(lockedProfiles.count, 0, "no profiles while locked");
      return `${lockedProfiles.count} profiles while locked, ${await page.evaluate(() => sshProfilesState.profiles.length)} after unlock`;
    });

    await check("K1", "Set up key sign-in from the SSH page", async () => {
      await page.evaluate(() => { window.showPage("ssh"); sshSelectedProfileId = "test-node-a-anx"; renderSshView(); });
      await waitFor(page, () => !document.querySelector("[data-ssh-key-setup]").hidden, null, "the Set up key sign-in button");
      await page.locator("[data-ssh-key-setup]").click();
      await page.locator('[data-key-setup-field="password"]').fill(PASSWORD);
      await shot(page, "K1-key-setup-dialog");
      await page.getByRole("button", { name: "Set up key sign-in" }).last().click();
      await waitFor(page, () => /Key sign-in works/.test(document.querySelector('[aria-label="Set up key sign-in"]')?.textContent || ""), null, "key sign-in to finish", 60000);
      await shot(page, "K1-key-setup-done");
      const keyProfile = await page.evaluate(() => sshProfilesState.profiles.find((profile) => profile.authType === "privateKey" && profile.nodeId === "anx215a"));
      assert(keyProfile, "a key profile for the node");
      await page.getByRole("button", { name: "Done" }).click();
      const keys = dockerExec("wc -l < /home/anx/.ssh/authorized_keys").trim();
      return `${keyProfile.displayName}; authorized_keys lines: ${keys}`;
    });

    await page.evaluate(async () => { await selectNode("anx215a"); window.showPage("agent-control"); setActiveAgentControlSection("updates"); });
    await check("E1", "Verify Access, then the Update tooltip names the package method", async () => {
      await waitFor(page, () => {
        const button = document.querySelector('[data-agent-control-action="verifyRemoteControl"]');
        return button && !button.disabled;
      }, null, "Verify Access to be enabled", 60000);
      const loaded = await page.waitForFunction(() => getAgentControlOverviewTarget()?.nodeId === "anx215a", null, { timeout: 60000, polling: 500 }).then(() => true).catch(() => false);
      if (!loaded) {
        const state = await page.evaluate(() => ({ state: agentControlState ? Object.keys(agentControlState) : null, remote: (agentControlState?.remote || []).map((entry) => entry.nodeId), selected: getSelectedNodeId(), page: getActivePageName(), inFlight: agentControlRefreshInFlight, busy: agentControlBusy, message: document.querySelector("[data-agent-control-message]")?.textContent || "" }));
        throw new Error(`Agent Control never loaded this computer: ${JSON.stringify(state).slice(0, 700)}`);
      }
      const guards = await page.evaluate(async () => {
        const before = { busy: agentControlBusy, incompatible: getAgentCompatibilityView().incompatible, locked: isAuthRecoveryLocked?.() || false, target: getAgentControlOverviewTarget()?.nodeId || null, local: isAgentTargetLocal(getAgentControlOverviewTarget()) };
        await runAgentControlAction("verifyRemoteControl");
        return before;
      });
      const verified = await page.waitForFunction(() => remoteAgentAccessVerifications.get("anx215a")?.verified === true, null, { timeout: 60000, polling: 400 }).then(() => true).catch(() => false);
      if (!verified) {
        const why = await page.evaluate(() => ({ verification: remoteAgentAccessVerifications.get("anx215a") || null, message: document.querySelector("[data-agent-control-message]")?.textContent || "", node: (nodesState.nodes || []).find((node) => node.id === "anx215a")?.platform || null }));
        throw new Error(`Verify Access did not pass: ${JSON.stringify({ ...why, guards }).slice(0, 800)}`);
      }
      await waitFor(page, () => !document.querySelector('[data-agent-control-action="updateAgent"]').disabled, null, "Update to be enabled", 30000);
      const title = await page.evaluate(() => document.querySelector('[data-agent-control-action="updateAgent"]').title);
      assert(/release package/.test(title) && !/bundled/i.test(title), title);
      return title.slice(0, 90);
    });

    await check("F1", "Update confirmation names computer, builds, method and services", async () => {
      await page.evaluate(() => document.querySelector('[data-agent-control-action="updateAgent"]').click());
      await waitFor(page, (selector) => /Update the Agent on/.test(document.querySelector(`${selector} h2`)?.textContent || ""), OPEN_DIALOG, "the confirmation", 30000);
      await shot(page, "F1-update-confirmation");
      const dialog = await page.evaluate((selector) => {
        const modal = document.querySelector(selector);
        const rows = Object.fromEntries([...modal.querySelectorAll(".app-modal__details dt")].map((dt) => [dt.textContent, dt.nextElementSibling?.textContent || ""]));
        return { title: modal.querySelector("h2").textContent, direction: getComputedStyle(modal.querySelector(".app-modal__header")).flexDirection, rows, confirm: modal.querySelector("[data-confirm-ok]").textContent };
      }, OPEN_DIALOG);
      assert.strictEqual(dialog.direction, "column", "title stacked");
      assert.strictEqual(dialog.rows["Current build"], FROM);
      assert.strictEqual(dialog.rows["New build"], TO);
      assert(/release package/i.test(dialog.rows.Method));
      assert(/Docker containers/.test(dialog.rows.Services));
      assert.strictEqual(dialog.confirm, "Update Agent");
      return `${dialog.title} ${FROM} -> ${TO}`;
    });

    await check("P1", "Live progress while the real update runs", async () => {
      await page.evaluate((selector) => document.querySelector(`${selector} [data-confirm-ok]`).click(), OPEN_DIALOG);
      await waitFor(page, () => !document.querySelector("[data-agent-update-progress]").hidden && document.querySelectorAll("[data-agent-update-step]").length > 0, null, "progress steps", 60000);
      await waitFor(page, () => /in progress/.test(document.querySelector("[data-agent-update-progress]").textContent), null, "a running step", 60000).catch(() => {});
      await shot(page, "P1-update-progress");
      await waitFor(page, (to) => new RegExp(`updated to ${to.replace(/\./g, "\\.")}`).test(document.querySelector("[data-agent-control-message]")?.textContent || ""), TO, "the update to finish", 240000);
      await shot(page, "P1-update-done");
      const steps = await page.evaluate(() => [...document.querySelectorAll("[data-agent-update-step]")].map((row) => `${row.dataset.agentUpdateStep}:${row.querySelector(".status-pill").textContent}`));
      const installed = dockerExec("dpkg-query -W -f='${Version}' anxos-agent").trim();
      assert.strictEqual(installed, TO);
      return `${steps.join(", ")}; node now ${installed}`;
    });

    await check("C1", "No stale pending/not connected; verified build in history; no 0.1.0", async () => {
      await waitFor(page, () => /2\.0-build213 → 2\.0-build214/.test(document.querySelector("[data-agent-update-history]")?.textContent || ""), null, "the history row", 60000);
      await waitFor(page, () => !/Pending:/.test(document.querySelector("[data-agent-update-history]")?.textContent || ""), null, "the pending line to go", 60000);
      await shot(page, "C1-after-update");
      const text = await page.evaluate(() => ({
        history: document.querySelector("[data-agent-update-history]").textContent,
        computers: document.querySelector("[data-agent-auto-update-computers]").textContent,
        section: document.querySelector('[data-agent-control-section="updates"]').textContent,
      }));
      assert(/\(verified\)/.test(text.history), text.history);
      const nodeLine = text.computers.split("Test node A")[1]?.split(/Lab PC|Owner Machine/)[0] || "";
      assert(/2\.0-build214/.test(nodeLine) && /up to date/.test(nodeLine) && !/not connected/.test(nodeLine), `Test node A: ${nodeLine}`);
      assert(!/0\.1\.0/.test(text.section), "no placeholder version in the Updates section");
      return text.computers.replace(/\s+/g, " ").trim().slice(0, 120);
    });

    await check("D1", "Create Server shows whether the computer fits, outside Advanced options", async () => {
      await page.evaluate(async () => { await selectNode("lab"); window.showPage("marketplace"); });
      await waitFor(page, () => (marketplaceCatalog?.templates?.length || 0) > 0, null, "the catalog", 60000);
      const next = app.waitForEvent("window", { timeout: 30000 });
      await page.evaluate(() => openCreateServerWorkspace(findMarketplaceTemplate("valheim")));
      const wizard = await next;
      await wizard.waitForLoadState("domcontentloaded");
      await waitFor(wizard, () => !document.querySelector("[data-create-server-fit]")?.hidden, null, "the fit check", 60000);
      // The window asks the computer for its memory and disk once; wait for it.
      await wizard.waitForFunction(() => document.querySelector("[data-create-server-fit]").dataset.verdict !== "unknown", null, { timeout: 20000, polling: 400 }).catch(() => {});
      const first = await wizard.evaluate(() => ({ verdict: document.querySelector("[data-create-server-fit]").dataset.verdict, text: document.querySelector("[data-create-server-fit]").textContent, insideAdvanced: Boolean(document.querySelector("[data-create-server-fit]").closest("details")) }));
      assert.strictEqual(first.insideAdvanced, false, "visible without opening anything");
      await wizard.screenshot({ path: path.join(shotsDir, "D1-create-server-fit.png") }).catch(() => {});
      await wizard.evaluate(() => { document.querySelector("[data-create-server-advanced]").open = true; });
      await wizard.locator('[data-marketplace-field="memory"]').fill("4096G");
      await wizard.locator('[data-marketplace-field="memory"]').dispatchEvent("input");
      await waitFor(wizard, () => document.querySelector("[data-create-server-fit]").dataset.verdict === "no", null, "the fit to follow the memory field", 10000);
      const after = await wizard.evaluate(() => document.querySelector("[data-create-server-fit] li[data-verdict='no']")?.textContent || "");
      await wizard.close();
      return `${first.verdict}: ${first.text.replace(/\s+/g, " ").slice(0, 120)} | 4096G -> ${after.slice(0, 80)}`;
    });

    await check("W1", "All computers lists Docker services with type, ports and data", async () => {
      await page.evaluate(() => { window.showPage("instances"); window.AnxServerFleet.setEnabled(true); });
      await waitFor(page, (name) => [...document.querySelectorAll("[data-server-fleet-row]")].some((row) => row.textContent.includes(name)), NGINX, "the Docker service row", 60000);
      await shot(page, "W1-all-computers");
      const row = await page.evaluate((name) => {
        const match = [...document.querySelectorAll("[data-server-fleet-row]")].find((entry) => entry.textContent.includes(name));
        return [...match.querySelectorAll("td")].map((cell) => cell.textContent.trim());
      }, NGINX);
      assert(row.some((cell) => /Docker service.*AnxOS/.test(cell)), row.join(" | "));
      assert(row.some((cell) => cell.includes(String(NGINX_PORT))), "ports shown");
      assert(row.some((cell) => cell.includes(`${NGINX}-site`)), "kept data shown");
      return row.slice(1, 9).join(" | ");
    });

    await check("W2", "Update an AnxOS Docker service from the window; data kept", async () => {
      await page.evaluate((name) => {
        const match = [...document.querySelectorAll("[data-server-fleet-row]")].find((entry) => entry.textContent.includes(name));
        [...match.querySelectorAll("button")].find((button) => button.textContent === "Update").click();
      }, NGINX);
      await waitFor(page, (selector) => /Update .* on /.test(document.querySelector(`${selector} h2`)?.textContent || ""), OPEN_DIALOG, "the Docker update confirmation", 30000);
      await shot(page, "W2-docker-update-confirmation");
      const notUndone = await page.evaluate((selector) => [...document.querySelectorAll(`${selector} .app-modal__details dt`)].find((dt) => dt.textContent === "Not undone")?.nextElementSibling?.textContent || "", OPEN_DIALOG);
      assert(/database/.test(notUndone), "the confirmation separates image rollback from data");
      await page.evaluate((selector) => document.querySelector(`${selector} [data-confirm-ok]`).click(), OPEN_DIALOG);
      const deadline = Date.now() + 240000;
      while (docker(["inspect", NGINX, "--format", "{{.Image}}"]) === nginxOldImage && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2000));
      await new Promise((resolve) => setTimeout(resolve, 25000));
      const after = docker(["inspect", NGINX, "--format", "{{.Image}}"]);
      const marker = docker(["exec", NGINX, "cat", "/usr/share/nginx/html/marker.txt"]);
      assert.notStrictEqual(after, nginxOldImage, "runs the newer image");
      assert.strictEqual(marker, "anx215-ui-kept", "data kept");
      await shot(page, "W2-after-docker-update");
      return `${nginxOldImage.slice(7, 19)} -> ${after.slice(7, 19)}, data kept`;
    });

    assert.deepStrictEqual(errors.filter((message) => !/ResizeObserver/.test(message)), [], "no renderer errors");
  } finally {
    await app.close().catch(() => {});
    lab.child.kill();
    for (const args of [["rm", "-f", NGINX], ["rm", "-f", `${NGINX}-before-update`], ["volume", "rm", "-f", `${NGINX}-site`], ["rmi", "nginx:1.26-alpine"]]) { try { docker(args); } catch {} }
    qa.cleanup();
    for (const dir of [userData, agentRoot, home]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  }
  const failed = results.filter((result) => !result.passed).length;
  if (errors.length) console.log(`Renderer errors: ${errors.join(" | ")}`);
  console.log(`\n${results.length - failed}/${results.length} passed. Screenshots: ${shotsDir}`);
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
