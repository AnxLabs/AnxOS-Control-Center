#!/usr/bin/env node
"use strict";

// Website product screenshots from the INSTALLED, signed AnxHost CC build
// (Build 216 RC3 on the owner's PC), driven against a disposable demo dataset.
//
//   - The executable must be the installed app: Authenticode Valid, publisher
//     Anjo ROSIMO, and HKCU AnxHostBuild = 216 (checked before launch).
//   - Throwaway --user-data-dir and isolated config/log folders (qa-mode, as
//     every real-app UI suite runs), so the owner's installed data, Local
//     Agent and computers are never read or written. AGENT_URL points at a
//     closed port; the only Agent it talks to is a disposable fixture Agent
//     (scripts/test-helpers/service-managed-agent-fixture.js) seeded with demo
//     servers in a temporary folder.
//   - Windows stay off-screen and unfocused; the QA MODE badge (a qa-mode-only
//     element) is removed from the DOM before each capture.
//   - Before saving, each screen's visible text is checked for this PC's host
//     name, the Windows user name and private IPv4 addresses; a hit stops the
//     capture and nothing is written for that screen.
//
// Usage: node scripts/capture-anxhost-rc3-screenshots.js [--exe=<path>] [--out=<dir>] [--write-site]
//   --write-site  also writes website/assets/product/<name>.png and .webp

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { _electron: electron, chromium } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");
const { signInQaOwner } = require("./test-helpers/qa-owner");

const root = path.resolve(__dirname, "..");
const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, "").split("="); return [key, rest.length ? rest.join("=") : true]; }));
const EXE = args.exe || path.join(process.env.LOCALAPPDATA || "", "Programs", "AnxOS Control Center", "AnxOS Control Center.exe");
const OUT = path.resolve(args.out || path.join(root, "artifacts", "anxhost-rc3-shots"));
const SITE_PRODUCT = path.join(root, "website", "assets", "product");
const WIDTH = 1500;
const HEIGHT = 950;
const OFFSCREEN = { x: -32000, y: -32000 };

const DEMO_HOSTNAME = "home-server";

const DEMO_PRELOAD = path.join(__dirname, "test-helpers", "demo-machine-preload.js");

function verifyInstalledBuild() {
  if (!fs.existsSync(EXE)) throw new Error(`Installed app not found at ${EXE}`);
  const script = [
    `$s = Get-AuthenticodeSignature -LiteralPath '${EXE.replace(/'/g, "''")}'`,
    "$b = (Get-ItemProperty 'HKCU:\\Software\\3f8b9dfa-3a76-52ec-8ba9-f2ea082d6457' -ErrorAction SilentlyContinue).AnxHostBuild",
    "[pscustomobject]@{ status = [string]$s.Status; subject = [string]$s.SignerCertificate.Subject; build = [string]$b } | ConvertTo-Json -Compress",
  ].join("; ");
  // Windows PowerShell must not inherit PowerShell 7's module path, or the
  // Security module (Get-AuthenticodeSignature) fails to load.
  const psEnv = { ...process.env };
  delete psEnv.PSModulePath;
  const result = JSON.parse(execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8", env: psEnv }));
  if (result.status !== "Valid" || !/CN=Anjo ROSIMO/.test(result.subject)) throw new Error(`Installed app signature is not valid: ${JSON.stringify(result)}`);
  if (args.exe === undefined && result.build !== "216") throw new Error(`Installed build is ${result.build}, not 216`);
  return result;
}

// Runs in the Electron main process: one virtual off-screen display, windows
// parked there, never focused or shown in the taskbar.
function hideWindowsFromDesktop({ BrowserWindow, screen }, offscreen) {
  if (!screen.__anxShotsPatched) {
    screen.__anxShotsPatched = true;
    const area = { x: offscreen.x, y: offscreen.y, width: 4000, height: 3000 };
    const virtual = { id: 9_999_998, label: "anx-shots-virtual", bounds: area, workArea: area, workAreaSize: { width: area.width, height: area.height }, size: { width: area.width, height: area.height }, scaleFactor: 1, rotation: 0, internal: false, monochrome: false, accelerometerSupport: "unknown", touchSupport: "unknown", colorDepth: 24, colorSpace: "", depthPerComponent: 8, displayFrequency: 60, detected: true };
    screen.getAllDisplays = () => [virtual];
    screen.getPrimaryDisplay = () => virtual;
    screen.getDisplayMatching = () => virtual;
    screen.getDisplayNearestPoint = () => virtual;
  }
  const park = (win) => {
    if (!win || win.isDestroyed()) return;
    const { width, height } = win.getBounds();
    win.setSkipTaskbar(true);
    win.setBounds({ x: offscreen.x, y: offscreen.y, width, height });
  };
  const proto = BrowserWindow.prototype;
  if (!proto.__anxShotsPatched) {
    proto.__anxShotsPatched = true;
    proto.show = function show() { park(this); this.showInactive(); park(this); };
    proto.focus = function focus() {};
    proto.moveTop = function moveTop() {};
  }
  for (const win of BrowserWindow.getAllWindows()) park(win);
}

function patchMainProcess(_electron, { preload, hostname, address }) {
  process.env.ANX_DEMO_HOSTNAME = hostname;
  process.env.ANX_DEMO_ADDRESS = address;
  process.mainModule.require(preload);
}

async function evaluateMain(app, fn, arg) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await app.evaluate(fn, arg); } catch (error) { lastError = error; await new Promise((r) => setTimeout(r, 150)); }
  }
  throw lastError;
}

async function setViewport(app, page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    if (viewport.width === WIDTH && viewport.height === HEIGHT) return;
    await evaluateMain(app, ({ BrowserWindow }, { dw, dh, offscreen, first, w, h }) => {
      const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      win.setMinimumSize(320, 240);
      if (win.isMaximized()) win.unmaximize();
      const bounds = win.getBounds();
      win.setBounds(first ? { x: offscreen.x, y: offscreen.y, width: w, height: h } : { ...bounds, width: bounds.width + dw, height: bounds.height + dh });
    }, { dw: WIDTH - viewport.width, dh: HEIGHT - viewport.height, offscreen: OFFSCREEN, first: attempt === 0, w: WIDTH, h: HEIGHT });
    await page.waitForTimeout(400);
  }
}

// A demo Minecraft-style console: prints believable startup lines, then idles.
function demoServerScript(lines, port) {
  return `try{require('net').createServer(s=>s.end()).on('error',()=>{}).listen(${Number(port)},'127.0.0.1');}catch{}const lines=${JSON.stringify(lines)};let i=0;const t=setInterval(()=>{if(i<lines.length){console.log(lines[i++]);}else{clearInterval(t);}},120);setInterval(()=>{},60000);process.on('SIGTERM',()=>process.exit(0));`;
}

function demoInstances() {
  const minecraft = ["[Server thread/INFO]: Starting minecraft server version 1.21.4", "[Server thread/INFO]: Loading properties", "[Server thread/INFO]: Default game type: SURVIVAL", "[Server thread/INFO]: Preparing level \"world\"", "[Server thread/INFO]: Preparing spawn area: 100%", "[Server thread/INFO]: Done (6.214s)! For help, type \"help\"", "[Server thread/INFO]: Running AutoSave", "[Server thread/INFO]: Saved the game"];
  const valheim = ["Valheim dedicated server 0.219.16", "Loading world: Midgard", "World saved ( 412ms )", "Game server connected"];
  const node = (id, displayName, serverSoftware, ports, lines, extra = {}) => ({
    config: { id, displayName, serverSoftware, type: "custom-command", executable: process.execPath, args: ["-e", demoServerScript(lines, ports[0])], ports, environment: { ELECTRON_RUN_AS_NODE: "1" }, ...extra },
    files: { "server.properties": "motd=AnxHost demo\nmax-players=20\n", "eula.txt": "eula=true\n" },
  });
  return [
    node("survival-smp", "Survival SMP", "Paper 1.21.4", [25565], minecraft, { memory: "6G" }),
    node("creative-build", "Creative Build", "Vanilla 1.21.4", [25566], minecraft),
    node("valheim-midgard", "Valheim — Midgard", "Valheim Dedicated Server", [2456, 2457], valheim),
    node("modded-pack", "All the Mods 10", "NeoForge 21.1", [25567], minecraft),
  ];
}

async function privacyCheck(page, label) {
  const text = await page.evaluate(() => document.body.innerText);
  const needles = [os.hostname(), os.userInfo().username, "DESKTOP-", "anjor"].filter((value) => value && value.length >= 4);
  const hits = needles.filter((needle) => text.toLowerCase().includes(needle.toLowerCase()));
  const privateIp = text.match(/\b(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}(?:\.\d{1,3})?\b/g) || [];
  if (hits.length || privateIp.length) throw new Error(`${label}: private details on screen (${[...new Set([...hits.map(() => "host or user name"), ...privateIp])].join(", ")})`);
}

async function capture(page, name, { prepare, settle = 1200 } = {}) {
  if (prepare) await prepare();
  await page.waitForTimeout(settle);
  await page.evaluate(() => document.querySelectorAll('[data-testid="qa-mode-indicator"]').forEach((node) => node.remove()));
  await privacyCheck(page, name);
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`captured ${name}`);
  return file;
}

async function writeWebDerivatives(files) {
  const browser = await chromium.launch({ executablePath: ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].find((p) => fs.existsSync(p)) });
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
  for (const file of files) {
    const base = path.basename(file, ".png");
    fs.copyFileSync(file, path.join(SITE_PRODUCT, `${base}.png`));
    const dataUrl = `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`;
    const webp = await page.evaluate(async (src) => {
      const image = new Image();
      image.src = src;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d").drawImage(image, 0, 0);
      return canvas.toDataURL("image/webp", 0.86);
    }, dataUrl);
    fs.writeFileSync(path.join(SITE_PRODUCT, `${base}.webp`), Buffer.from(webp.split(",")[1], "base64"));
  }
  await browser.close();
}

async function main() {
  const signature = verifyInstalledBuild();
  console.log(`Installed app: signature ${signature.status}, build ${signature.build}`);
  fs.mkdirSync(OUT, { recursive: true });

  const agent = await startServiceManagedAgent({ initial: "running", operations: true, extraPreload: DEMO_PRELOAD, env: { ANX_DEMO_HOSTNAME: DEMO_HOSTNAME, ANX_DEMO_ADDRESS: "192.0.2.24" }, extraInstanceConfigs: demoInstances() });
  agent.setPlayers?.(3);
  const qa = createIsolatedQaEnv("anx-shots-config-");
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "unused-demo-token" });
  write("nodes.json", {
    schemaVersion: 2,
    selectedNodeId: "home-server",
    nodes: [
      { id: "home-server", kind: "agent", name: "Home Server", displayName: "Home Server", baseUrl: agent.url, agentUrl: agent.url, enabled: true },
      { id: "basement-pc", kind: "agent", name: "Basement PC", displayName: "Basement PC", baseUrl: "http://127.0.0.1:9", agentUrl: "http://127.0.0.1:9", enabled: true },
    ],
  });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { "home-server": { agentToken: agent.token }, "basement-pc": { agentToken: "demo-offline" } } });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-shots-profile-"));
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;

  for (const id of ["survival-smp", "creative-build", "valheim-midgard"]) {
    const started = await agent.api("POST", `/api/v1/instances/${id}/start`, {});
    console.log(`demo server ${id}: start HTTP ${started.status}`);
  }

  let app;
  try {
    app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${userData}`, "--qa-mode"], env, timeout: 60000 });
    await evaluateMain(app, hideWindowsFromDesktop, OFFSCREEN);
    await evaluateMain(app, patchMainProcess, { preload: DEMO_PRELOAD, hostname: "workstation", address: "192.0.2.10" });
    const page = await app.firstWindow();
    await evaluateMain(app, hideWindowsFromDesktop, OFFSCREEN);
    await page.waitForFunction(() => typeof window.showPage === "function", null, { timeout: 60000 });
    const useDevice = page.getByRole("button", { name: "Use this device" }).first();
    for (let i = 0; i < 40; i += 1) {
      if (await useDevice.isVisible().catch(() => false)) { await useDevice.click(); break; }
      if (await page.evaluate(() => (document.querySelector(".nav-menu")?.getBoundingClientRect().width || 0) > 0).catch(() => false)) break;
      await page.waitForTimeout(150);
    }
    await signInQaOwner(page);
    const skip = page.locator('[data-onboarding-action="skip"]').first();
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await page.evaluate(() => { if (typeof setOwnerNavExpanded === "function") setOwnerNavExpanded(false); });
    await setViewport(app, page);
    const show = (name) => page.evaluate((target) => window.showPage(target), name);
    const files = [];
    const only = args.only ? String(args.only).split(",") : null;
    const want = (name) => !only || only.includes(name);

    if (want("control-center-dashboard")) files.push(await capture(page, "control-center-dashboard", { prepare: () => show("dashboard"), settle: 5000 }));
    if (want("control-center-instances")) files.push(await capture(page, "control-center-instances", { prepare: () => show("instances"), settle: 4000 }));
    if (want("control-center-nodes")) files.push(await capture(page, "control-center-nodes", { prepare: () => show("nodes"), settle: 4000 }));
    if (want("control-center-marketplace")) files.push(await capture(page, "control-center-marketplace", { prepare: () => show("marketplace"), settle: 4000 }));
    if (want("control-center-public-access")) files.push(await capture(page, "control-center-public-access", {
      prepare: async () => {
        await show("network");
        await page.waitForTimeout(800);
        await page.locator('[data-page="network"] [data-page-tab="playit"]').first().click().catch((error) => console.warn(`Share tab: ${error.message}`));
      },
      settle: 4000,
    }));
    if (want("control-center-agent-control")) files.push(await capture(page, "control-center-agent-control", { prepare: () => show("agent-control"), settle: 4000 }));
    if (want("control-center-settings")) files.push(await capture(page, "control-center-settings", { prepare: () => show("settings"), settle: 2000 }));
    if (want("control-center-settings-updates")) {
      files.push(await capture(page, "control-center-settings-updates", {
        prepare: async () => {
          await show("settings");
          await page.waitForTimeout(800);
          await page.locator('[data-page="settings"] .settings-nav').getByText("Updates", { exact: true }).first().click().catch((error) => console.warn(`Updates section: ${error.message}`));
        },
        settle: 2500,
      }));
    }
    if (want("control-center-add-computer")) {
      files.push(await capture(page, "control-center-add-computer", {
        prepare: async () => {
          await show("nodes");
          await page.waitForTimeout(1200);
          await page.getByRole("button", { name: /add (a )?computer/i }).first().click().catch(() => {});
        },
        settle: 2000,
      }));
    }
    if (args["write-site"]) {
      await writeWebDerivatives(files);
      console.log(`wrote ${files.length} screenshot(s) and WebP copies to website/assets/product`);
    }
    fs.writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify({ capturedAt: new Date().toISOString(), executable: path.basename(EXE), signature, build: signature.build, viewport: `${WIDTH}x${HEIGHT}`, dataset: "disposable demo (fixture Agent, temporary folders)", files: files.map((file) => path.basename(file)) }, null, 2)}\n`);
  } finally {
    if (app) await app.close().catch(() => {});
    await agent.stop().catch(() => {});
    for (const dir of [userData]) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    try { qa.cleanup(); } catch {}
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
