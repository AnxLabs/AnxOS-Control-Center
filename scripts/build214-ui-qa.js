#!/usr/bin/env node
"use strict";

// Build 214 features in the REAL Electron app (isolated profile and config,
// --qa-mode) against a REAL disposable Agent on this PC started by this
// script. Installs really run: Docker containers need Docker, the SteamCMD
// game needs SteamCMD and internet. Never touches the installed app, its
// Local Agent, its data, or any other computer.
//   L1 catalog labels: Jellyfin, IT-Tools, Stirling PDF and Immich are
//      installable; Java application says why it is not; Windows-only games
//      name their operating system
//   J1 Jellyfin: the Media folder field appears, an empty or system folder is
//      refused, the install finishes, the folder is mounted read-only
//   J2 Jellyfin with an empty folder finishes with a visible warning
//   P1 Stirling PDF: the "Save this password" dialog shows the password the
//      container was given, and the completion text points to the Docker page
//   F1 a busy port fails in the window with a plain message; nothing created
//   S1 a SteamCMD game (Unturned) installs from the window, reports ready,
//      and stops from My Servers
// Everything created is named anx214qa-* and removed at the end.
// Set BUILD214_QA_SHOTS=<dir> to keep screenshots; BUILD214_QA_ONLY=J1,...
// runs a subset. Run: node scripts/build214-ui-qa.js

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");

const appRoot = path.resolve(process.env.ANX_QA_APP_ROOT || path.join(__dirname, ".."));
const shotsDir = process.env.BUILD214_QA_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), "anx-build214-shots-"));
const only = new Set(String(process.env.BUILD214_QA_ONLY || "").split(",").map((value) => value.trim()).filter(Boolean));
const runs = (id) => !only.size || only.has(id);
const PREFIX = "anx214qa-";

function docker(args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile("docker", args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || "").trim(), stderr: String(stderr || "").trim() });
    });
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
    server.on("error", reject);
  });
}

async function waitFor(page, predicate, arg, label, timeoutMs = 30000) {
  try {
    await page.waitForFunction(predicate, arg, { timeout: timeoutMs, polling: 500 });
  } catch (error) {
    throw new Error(`Timed out waiting for ${label}: ${error.message.split("\n")[0]}`);
  }
}

async function startAgent(root) {
  const token = `anxos_build214-qa-${crypto.randomBytes(16).toString("hex")}`;
  const configDir = path.join(root, "config");
  for (const dir of [configDir, path.join(root, "instances"), path.join(root, "logs")]) fs.mkdirSync(dir, { recursive: true });
  const port = await freePort();
  fs.writeFileSync(path.join(configDir, "agent.json"), `${JSON.stringify({ backendMode: "agent", agentUrl: `http://127.0.0.1:${port}`, agentToken: token }, null, 2)}\n`);
  const child = spawn(process.execPath, [path.join(appRoot, "agent", "src", "server.js")], {
    cwd: path.join(appRoot, "agent"),
    env: {
      ...process.env,
      ANXHUB_CONFIG_DIR: configDir,
      ANXHUB_AGENT_CONFIG_PATH: path.join(configDir, "agent.json"),
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: String(port),
      AGENT_TOKEN: token,
      AGENT_IDENTITY_PATH: path.join(configDir, "identity.json"),
      AGENT_INSTANCE_ROOT: path.join(root, "instances"),
      ANXOS_LOG_DIR: path.join(root, "logs"),
    },
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20000;
  for (;;) {
    try { if ((await fetch(`${url}/api/v1/health`)).ok) break; } catch {}
    if (Date.now() > deadline) throw new Error("the disposable Agent did not start");
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return { child, url, token, instanceRoot: path.join(root, "instances") };
}

async function main() {
  const agentRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-build214-qa-agent-"));
  const mediaFolder = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}media-`));
  fs.writeFileSync(path.join(mediaFolder, "holiday.mkv"), "not really a film");
  const emptyFolder = fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIX}empty-`));
  const imagesBefore = new Set((await docker(["images", "--format", "{{.Repository}}:{{.Tag}}"])).stdout.split(/\r?\n/));
  const agent = await startAgent(agentRoot);
  const qa = createIsolatedQaEnv("anx-build214-qa-config-");
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "lab", nodes: [
    { id: "lab", kind: "agent", name: "Lab", displayName: "Lab", baseUrl: agent.url, agentUrl: agent.url, enabled: true },
  ] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { lab: { agentToken: agent.token } } });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-build214-qa-profile-"));
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (key.startsWith("VSCODE_")) delete env[key];
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", appRoot, "--qa-mode"], env });
  const errors = [];
  const shot = (page, name) => page.screenshot({ path: path.join(shotsDir, `${name}.png`) }).catch(() => {});
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
    page.on("pageerror", (error) => errors.push(`main: ${error.message}`));
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
    await page.evaluate(async () => { await selectNode("lab"); window.showPage("dashboard"); });

    await page.evaluate(() => window.showPage("marketplace"));
    await waitFor(page, () => (marketplaceCatalog?.templates?.length || 0) > 0, null, "the Marketplace catalog", 60000);
    let wizard = null;

    // The way a user reaches a service: its Marketplace card on the main
    // window opens Create Server with that template already chosen.
    const openTemplate = async (templateId) => {
      if (wizard && !wizard.isClosed()) await wizard.close();
      const next = app.waitForEvent("window", { timeout: 30000 });
      await page.evaluate((id) => openCreateServerWorkspace(findMarketplaceTemplate(id)), templateId);
      wizard = await next;
      wizard.on("pageerror", (error) => errors.push(`create-server: ${error.message}`));
      await wizard.waitForLoadState("domcontentloaded");
      await waitFor(wizard, (id) => typeof marketplaceSelectedTemplateId !== "undefined" && marketplaceSelectedTemplateId === id && !document.querySelector("[data-marketplace-wizard]")?.hidden, templateId, `the ${templateId} setup`, 60000);
      const connected = await wizard.waitForFunction(() => validateCreateServerStep("node", { report: false }), null, { timeout: 30000, polling: 500 }).then(() => true).catch(() => false);
      if (!connected) {
        const nodes = await wizard.evaluate(() => ({ selected: getSelectedNodeId(), node: JSON.stringify(getSelectedNode?.() || null).slice(0, 400) }));
        throw new Error(`the Create Server window never sees the computer as connected: ${JSON.stringify(nodes)}`);
      }
      const picker = await wizard.evaluate(() => Boolean(document.querySelector("[data-first-server-modal]")));
      assert.strictEqual(picker, false, `the game picker does not cover the ${templateId} setup`);
      await wizard.evaluate(() => { document.querySelector("[data-create-server-advanced]").open = true; });
    };
    const fill = async (field, value) => {
      await wizard.locator(`[data-marketplace-field="${field}"]`).fill(String(value));
      await wizard.locator(`[data-marketplace-field="${field}"]`).dispatchEvent("input");
      await wizard.locator(`[data-marketplace-field="${field}"]`).dispatchEvent("change");
    };
    // Clicks Create server once it can be clicked; otherwise says why not.
    const clickInstall = async () => {
      const ready = await wizard.waitForFunction(() => {
        const button = document.querySelector("[data-marketplace-install]");
        return button && !button.disabled && button.checkVisibility() && button.getBoundingClientRect().height > 0;
      }, null, { timeout: 60000, polling: 500 }).then(() => true).catch(() => false);
      if (!ready) {
        const why = await wizard.evaluate(() => {
          const button = document.querySelector("[data-marketplace-install]");
          return { disabled: button?.disabled, visible: button?.checkVisibility(), text: button?.textContent, message: document.querySelector("[data-marketplace-message]")?.textContent, step: createServerWizardStep, inFlight: marketplaceInstallInFlight };
        });
        throw new Error(`Create server cannot be clicked: ${JSON.stringify(why)}`);
      }
      const cover = await wizard.evaluate(() => {
        const button = document.querySelector("[data-marketplace-install]");
        button.scrollIntoView({ block: "center" });
        const box = button.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return top === button || button.contains(top) ? null : { tag: top?.tagName, cls: top?.className, text: (top?.textContent || "").slice(0, 120), box: [box.left, box.top, box.width, box.height], view: [innerWidth, innerHeight] };
      });
      if (cover) throw new Error(`Create server is covered: ${JSON.stringify(cover)}`);
      await wizard.locator("[data-marketplace-install]").click();
    };
    const install = async (timeoutMs) => {
      await clickInstall();
      await waitFor(wizard, () => /Complete|Failed|Paused/.test(document.querySelector("[data-marketplace-install-state]")?.textContent || "") && !marketplaceInstallInFlight, null, "the install to finish", timeoutMs);
      return wizard.evaluate(() => ({
        state: document.querySelector("[data-marketplace-install-state]").textContent.trim(),
        message: document.querySelector("[data-marketplace-message]")?.textContent.trim() || "",
        progress: [...document.querySelectorAll("[data-marketplace-progress] .marketplace-progress-step")].map((row) => ({ status: row.dataset.status, text: row.textContent.replace(/\s+/g, " ").trim() })),
        deployment: document.querySelector("[data-create-server-deployment-state]")?.textContent.replace(/\s+/g, " ").trim() || "",
      }));
    };

    // L1
    await check("L1", async () => {
      const labels = await page.evaluate(() => Object.fromEntries(["jellyfin", "it-tools", "stirling-pdf", "immich", "java-app", "v-rising", "postgresql"].map((id) => {
        const template = marketplaceCatalog.templates.find((entry) => entry.id === id);
        return [id, { unavailable: Boolean(template.comingSoon || template.disabled), message: template.comingSoonMessage || "", platforms: template.compatibility?.platforms || [] }];
      })));
      for (const id of ["jellyfin", "it-tools", "stirling-pdf", "postgresql", "v-rising"]) assert.strictEqual(labels[id].unavailable, false, `${id} is installable`);
      assert.strictEqual(labels.immich.unavailable, false, "Immich is installable (Compose)");
      assert.ok(labels["java-app"].unavailable && labels["java-app"].message.length > 20, "Java application says why");
      assert.deepStrictEqual(labels["v-rising"].platforms, ["windows"], "V Rising names Windows");
      await page.evaluate(() => window.showPage("marketplace"));
      await page.evaluate(() => window.openMarketplaceWizard("java-app", { source: "template" }));
      const notice = await page.evaluate(() => document.querySelector("[data-marketplace-message]")?.textContent || "");
      assert.ok(notice === labels["java-app"].message, `opening Java application explains why (${notice})`);
      console.log("PASS L1 installable and unavailable cards are labelled honestly");
    });

    // J1
    await check("J1", async () => {
      await openTemplate("jellyfin");
      const field = await wizard.evaluate(() => {
        const wrap = document.querySelector('[data-marketplace-field-wrap="hostFolder"]');
        return { visible: Boolean(wrap) && !wrap.hidden && wrap.getBoundingClientRect().height > 0, label: document.querySelector("[data-marketplace-host-folder-label]")?.textContent || "" };
      });
      assert.ok(field.visible, "the Media folder field is shown for Jellyfin");
      assert.strictEqual(field.label, "Media folder");
      await fill("name", `${PREFIX}jf`);
      await fill("port", await freePort());
      await clickInstall();
      await wizard.waitForTimeout(500);
      const refused = await wizard.evaluate(() => document.querySelector("[data-marketplace-message]")?.textContent || "");
      assert.match(refused, /Enter the media folder/, `an empty media folder is refused in the window (${refused})`);
      await fill("hostFolder", "C:\\Windows");
      const system = await install(60000);
      assert.strictEqual(system.state, "Failed", `a system folder fails (${JSON.stringify(system).slice(0, 300)})`);
      assert.match(`${system.message} ${system.progress.map((step) => step.text).join(" ")}`, /system folder/i, "the reason names the system folder");
      await openTemplate("jellyfin");
      await fill("name", `${PREFIX}jf`);
      await fill("port", await freePort());
      await fill("hostFolder", mediaFolder);
      const result = await install(600000);
      await shot(wizard, "j1-jellyfin-complete");
      assert.strictEqual(result.state, "Complete", `Jellyfin installs (${JSON.stringify(result).slice(0, 500)})`);
      assert.ok(result.progress.some((step) => /Check media folder/.test(step.text) && step.status === "complete"), "the media folder check passed");
      assert.match(result.deployment, /Docker page/, "the completion text points to the Docker page");
      const mounts = JSON.parse((await docker(["inspect", `${PREFIX}jf`])).stdout)[0].Mounts;
      const media = mounts.find((mount) => mount.Destination === "/media");
      assert.ok(media && media.RW === false && media.Type === "bind", `the media folder is mounted read-only (${JSON.stringify(media)})`);
      console.log("PASS J1 Jellyfin: media folder required, system folder refused, installed with a read-only mount");
    });

    // J2
    await check("J2", async () => {
      await openTemplate("jellyfin");
      await fill("name", `${PREFIX}jf-empty`);
      await fill("port", await freePort());
      await fill("hostFolder", emptyFolder);
      const result = await install(600000);
      await shot(wizard, "j2-jellyfin-empty-folder");
      assert.strictEqual(result.state, "Complete");
      const warning = result.progress.find((step) => /Check media folder/.test(step.text));
      assert.ok(warning && warning.status === "warning" && /is empty/.test(warning.text), `the empty folder warning is visible (${JSON.stringify(warning)})`);
      console.log("PASS J2 an empty media folder finishes with a visible warning");
    });

    // P1
    await check("P1", async () => {
      await openTemplate("stirling-pdf");
      await fill("name", `${PREFIX}pdf`);
      await fill("port", await freePort());
      await clickInstall();
      const dialog = wizard.getByRole("dialog", { name: "Save your passwords" });
      await dialog.waitFor({ state: "visible", timeout: 600000 });
      await shot(wizard, "p1-password-dialog");
      const shown = await dialog.evaluate((element) => ({
        label: element.querySelector("label span")?.textContent || "",
        value: element.querySelector("input")?.value || "",
        heading: element.querySelector("h2")?.textContent || "",
      }));
      assert.strictEqual(shown.heading, "Save this password");
      assert.match(shown.label, /Stirling PDF sign-in password \(user: admin\)/);
      const env = (await docker(["inspect", `${PREFIX}pdf`, "--format", "{{range .Config.Env}}{{println .}}{{end}}"])).stdout;
      assert.ok(env.split(/\r?\n/).includes(`SECURITY_INITIALLOGIN_PASSWORD=${shown.value}`) && shown.value.length === 24, "the dialog shows the password the container was given");
      await dialog.getByRole("button", { name: "I saved them" }).click();
      await waitFor(wizard, () => /Complete/.test(document.querySelector("[data-marketplace-install-state]")?.textContent || ""), null, "Complete after the dialog");
      const profile = fs.readdirSync(userData, { recursive: true }).filter((name) => !/Cache|GPUCache|Code Cache/.test(name));
      const leaked = profile.some((name) => { try { return fs.statSync(path.join(userData, name)).isFile() && fs.readFileSync(path.join(userData, name), "latin1").includes(shown.value); } catch { return false; } });
      const configLeak = fs.readdirSync(qa.configDir, { recursive: true }).some((name) => { try { return fs.readFileSync(path.join(qa.configDir, name), "latin1").includes(shown.value); } catch { return false; } });
      assert.ok(!leaked && !configLeak, "the password is not saved in the app's profile or settings");
      console.log("PASS P1 Stirling PDF shows its generated password once and the app keeps no copy");
    });

    // F1
    await check("F1", async () => {
      const blocker = await new Promise((resolve) => { const server = http.createServer(); server.listen(0, "0.0.0.0", () => resolve(server)); });
      const busy = blocker.address().port;
      try {
        await openTemplate("docker-nginx");
        await fill("name", `${PREFIX}busy`);
        await fill("port", busy);
        const result = await install(300000);
        await shot(wizard, "f1-busy-port");
        assert.strictEqual(result.state, "Failed", `a busy port fails (${JSON.stringify(result).slice(0, 300)})`);
        assert.match(`${result.message} ${result.progress.map((step) => step.text).join(" ")}`, /port|in use|already/i, "the failure names the port");
        assert.ok(!(await docker(["inspect", `${PREFIX}busy`])).ok, "no container is left");
        const volumes = (await docker(["volume", "ls", "-q", "--filter", `name=${PREFIX}busy`])).stdout;
        assert.strictEqual(volumes, "", "no volume is left");
      } finally {
        blocker.close();
      }
      console.log("PASS F1 a busy port fails in the window with a plain reason and leaves nothing behind");
    });

    // S1
    await check("S1", async () => {
      if (process.platform !== "win32") { console.log("SKIP S1 runs on Windows (Unturned's Windows variant)"); return; }
      await openTemplate("unturned");
      await fill("name", `${PREFIX}unturned`);
      const port = 30000 + Math.floor(Math.random() * 20000);
      await fill("port", port);
      const result = await install(1500000);
      await shot(wizard, "s1-unturned-complete");
      assert.strictEqual(result.state, "Complete", `Unturned installs (${JSON.stringify(result).slice(0, 500)})`);
      await page.evaluate(() => window.showPage("instances"));
      await waitFor(page, (name) => (window.anx?.instances ? true : false) && document.body.textContent.includes(name), `${PREFIX}unturned`, "the server in My Servers", 60000);
      const status = await page.evaluate(async () => {
        const listed = await window.anx.instances.list({ nodeId: "lab" });
        const instances = listed?.instances || listed || [];
        const server = instances.find((entry) => /anx214qa-unturned/.test(entry.id || ""));
        return server ? { id: server.id, state: server.state, readiness: server.readinessState } : null;
      });
      assert.ok(status, "the server is listed");
      await waitFor(page, async (id) => {
        const listed = await window.anx.instances.list({ nodeId: "lab" });
        const server = (listed?.instances || listed || []).find((entry) => entry.id === id);
        return server?.state === "Running" && server?.readinessState === "ready";
      }, status.id, "Running and ready", 300000);
      await shot(page, "s1-unturned-running");
      await page.evaluate((id) => window.anx.instances.stop(id, { nodeId: "lab" }), status.id);
      await waitFor(page, async (id) => {
        const listed = await window.anx.instances.list({ nodeId: "lab" });
        return (listed?.instances || listed || []).find((entry) => entry.id === id)?.state === "Stopped";
      }, status.id, "Stopped", 120000);
      console.log("PASS S1 Unturned installs from the window, reports Running and ready, and stops");
    });

    if (errors.length) console.log(`Renderer errors: ${errors.join(" | ")}`);
  } finally {
    await app.close().catch(() => {});
    for (const name of (await docker(["ps", "-a", "--format", "{{.Names}}", "--filter", `name=${PREFIX}`])).stdout.split(/\r?\n/).filter(Boolean)) await docker(["rm", "-f", name]);
    for (const volume of (await docker(["volume", "ls", "-q", "--filter", `name=${PREFIX}`])).stdout.split(/\r?\n/).filter(Boolean)) await docker(["volume", "rm", volume]);
    for (const image of ["jellyfin/jellyfin:latest", "stirlingtools/stirling-pdf:3.3.0", "nginx:stable-alpine"]) if (!imagesBefore.has(image)) await docker(["rmi", image]);
    agent.child.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 2000));
    for (const dir of [agentRoot, mediaFolder, emptyFolder, userData, qa.root]) { try { if (dir) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {} }
    const left = (await docker(["ps", "-a", "-q", "--filter", `name=${PREFIX}`])).stdout;
    console.log(`Cleanup: containers left: ${left ? left.split(/\s+/).length : 0}; screenshots in ${shotsDir}`);
  }
  console.log(`\nbuild214-ui-qa: ${passed} passed, ${failures.length} failed${errors.length ? `, ${errors.length} renderer errors` : ""}.`);
  if (failures.length) process.exitCode = 1;
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(process.exitCode || 0), 500));
