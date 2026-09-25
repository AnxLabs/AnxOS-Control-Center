#!/usr/bin/env node
// Responsive Mobile UI QA harness
//
// Boots the real Electron app against an isolated profile and sweeps every
// target page across phone/tablet/narrow-desktop viewports, failing on document
// or dialog overflow in the active page and recording controls smaller than
// 36px for review.
//
// First-run gates are dismissed BEFORE any other interaction and in a fixed
// order: the welcome modal is skipped first because its full-window backdrop
// intercepts pointer events for everything behind it (including the local setup
// gate's "Use this device" action). The dismissal helpers and the DOM-click
// pattern mirror scripts/qa-acceptance.js.
//
// Run: node scripts/responsive-mobile-ui-qa.js
// Artifacts: artifacts/qa/responsive-mobile-<ISO-timestamp>/

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");

const root = path.resolve(__dirname, "..");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = path.join(root, "artifacts", "qa", `responsive-mobile-${timestamp}`);
fs.mkdirSync(artifactDir, { recursive: true });

const VIEWPORTS = [
  { name: "phone-portrait", width: 390, height: 844 },
  { name: "phone-landscape", width: 844, height: 390 },
  { name: "tablet-portrait", width: 768, height: 1024 },
  { name: "tablet-landscape", width: 1024, height: 768 },
  { name: "narrow-desktop", width: 1182, height: 821 },
];

// `domPage` is the real `data-page` value: getSafePageName() (app.js) falls back
// to the default page for unknown names, so "public-access"/"diagnostics" must
// resolve to their actual pages, matching qa-acceptance's navigation mapping.
const PAGES = [
  { name: "dashboard", domPage: "dashboard" },
  { name: "nodes", domPage: "nodes" },
  { name: "agent-control", domPage: "agent-control" },
  { name: "marketplace", domPage: "marketplace" },
  { name: "instances", domPage: "instances" },
  { name: "public-access", domPage: "playit" },
  { name: "diagnostics", domPage: "agent-control" },
  { name: "settings", domPage: "settings" },
  { name: "security", domPage: "security" },
];
const MIN_CONTROL_SIZE = 36;
const ACTION_TIMEOUT_MS = 8_000;
const STARTUP_READY_TIMEOUT_MS = 20_000;
const WELCOME_APPEAR_TIMEOUT_MS = 5_000;
const GLOBAL_TIMEOUT_MS = 240_000;
const CLEANUP_TIMEOUT_MS = 12_000;
const SETTLE_MS = 300;

const results = [];
const rendererErrors = [];
const mainLogs = [];
let electronApp = null;
let spawnedPid = null;
let qaEnvironment = null;
let qaUserDataDir = null;
let verdictWritten = false;

const redact = (value) => String(value || "").replace(/(authorization|token|password|secret|api[_-]?key|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${timeoutMs}ms.`), { code: "QA_TIMEOUT" })), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function writeVerdict(payload) {
  verdictWritten = true;
  fs.writeFileSync(path.join(artifactDir, "results.json"), JSON.stringify(payload, null, 2));
}

async function cleanupElectron() {
  if (electronApp) {
    await withTimeout(electronApp.close(), CLEANUP_TIMEOUT_MS, "Electron shutdown").catch(() => {});
    electronApp = null;
  }
  if (spawnedPid) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(spawnedPid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      try { process.kill(-spawnedPid, "SIGKILL"); } catch {}
      try { process.kill(spawnedPid, "SIGKILL"); } catch {}
    }
    spawnedPid = null;
  }
  if (qaEnvironment) {
    try { qaEnvironment.cleanup(); } catch {}
    qaEnvironment = null;
  }
  if (qaUserDataDir) {
    try { fs.rmSync(qaUserDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
    qaUserDataDir = null;
  }
}

// Dismiss one gate if both its container and its trigger are visible. Uses a
// DOM click (evaluate) rather than an actionability-checked click: a modal
// backdrop still up intercepts pointer events, which makes locator.click()
// hang until timeout even though the trigger is visible and enabled.
async function dismissGate(page, { trigger, container, label }) {
  const containerLocator = page.locator(container).first();
  if (!(await containerLocator.count()) || !(await containerLocator.isVisible({ timeout: 500 }).catch(() => false))) return null;
  const triggerLocator = page.locator(trigger).first();
  if (!(await triggerLocator.count()) || !(await triggerLocator.isVisible({ timeout: 500 }).catch(() => false))) return null;
  await triggerLocator.evaluate((element) => element.click());
  await containerLocator.waitFor({ state: "hidden", timeout: ACTION_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);
  return label;
}

// Dismiss first-run gates in strict order: welcome (whose backdrop blocks
// everything), then the local setup gate, then the update prompt. Repeats while
// dismissing one gate reveals the next, bounded to terminate deterministically.
async function dismissGates(page) {
  const dismissed = [];
  for (let pass = 0; pass < 4; pass += 1) {
    const welcome = await dismissGate(page, {
      trigger: '[data-onboarding-welcome] [data-onboarding-action="skip"]',
      container: "[data-onboarding-welcome]",
      label: "onboarding welcome skipped",
    });
    if (welcome) { dismissed.push(welcome); continue; }
    const useDevice = await dismissGate(page, {
      trigger: '[data-local-setup-action="use-device"]',
      container: "[data-local-setup-gate]",
      label: "local setup gate resolved with use-device",
    });
    if (useDevice) { dismissed.push(useDevice); continue; }
    const update = await dismissGate(page, {
      trigger: '[data-update-modal] [data-update-action="dismiss"]',
      container: "[data-update-modal]",
      label: "update prompt deferred",
    });
    if (update) { dismissed.push(update); continue; }
    break;
  }
  return dismissed;
}

async function inspectViewport(page, viewport) {
  return page.evaluate(({ viewport, pageNames, minControlSize }) => {
    const isVisible = (node) => {
      if (!node || node.hidden) return false;
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const active = document.querySelector('.page.is-active');
    const activePage = active?.dataset.page || null;
    const rect = (node) => {
      const box = node.getBoundingClientRect();
      return { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
    };
    const visibleNodes = (selector) => Array.from(document.querySelectorAll(selector)).filter((node) => {
      if (node.closest("[hidden]")) return false;
      return isVisible(node);
    });
    const overflowNodes = visibleNodes(".page.is-active *").filter((node) => {
      const style = getComputedStyle(node);
      const intentionalEllipsis = style.overflowX === "hidden" && style.textOverflow === "ellipsis";
      return node.scrollWidth > node.clientWidth + 2 && !intentionalEllipsis && style.overflowX !== "auto" && style.overflowX !== "scroll";
    }).slice(0, 20).map((node) => ({
      selector: node.className ? `.${String(node.className).split(/\\s+/).filter(Boolean).slice(0, 2).join(".")}` : node.tagName.toLowerCase(),
      text: (node.textContent || "").trim().slice(0, 100),
      parent: node.parentElement?.className || node.parentElement?.tagName || null,
      scrollWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
      rect: rect(node),
    }));
    const activeRect = active ? rect(active) : null;
    const controls = visibleNodes(".page.is-active button, .page.is-active input, .page.is-active select, .page.is-active textarea, .sidebar button, .app-titlebar button");
    const smallControls = controls.filter((node) => {
      const box = node.getBoundingClientRect();
      return box.width < minControlSize - 1 || box.height < minControlSize - 1;
    }).slice(0, 20).map((node) => ({
      text: (node.getAttribute("aria-label") || node.textContent || node.getAttribute("placeholder") || "").trim().slice(0, 80),
      tag: node.tagName,
      rect: rect(node),
    }));
    const scrollOwners = visibleNodes(".page.is-active, .page.is-active .panel, .page.is-active [role=tabpanel], .page.is-active [class*=workspace], .page.is-active [class*=table], .page.is-active [class*=form]").filter((node) => {
      const style = getComputedStyle(node);
      return /auto|scroll/.test(style.overflowY) && node.scrollHeight > node.clientHeight + 8;
    }).slice(0, 12).map((node) => ({
      selector: node.className ? `.${String(node.className).split(/\\s+/).filter(Boolean).slice(0, 2).join(".")}` : node.tagName.toLowerCase(),
      scrollHeight: node.scrollHeight,
      clientHeight: node.clientHeight,
    }));
    const dialogs = visibleNodes('[role="dialog"], .app-modal, .global-search-dialog, .command-palette-dialog').map((node) => ({
      role: node.getAttribute("role"),
      rect: rect(node),
      viewportSafe: node.getBoundingClientRect().left >= 0 && node.getBoundingClientRect().right <= window.innerWidth + 1 && node.getBoundingClientRect().top >= 0 && node.getBoundingClientRect().bottom <= window.innerHeight + 1,
    }));
    return {
      viewport,
      activePage,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      activeRect,
      pageCount: pageNames.length,
      overflowNodes,
      smallControls,
      scrollOwners,
      dialogs,
    };
  }, { viewport, pageNames: PAGES.map((page) => page.name), minControlSize: MIN_CONTROL_SIZE });
}

async function main() {
  const stage = (name) => console.error(`[responsive-qa][stage] ${name}`);
  stage("electron-launch-start");
  qaUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-responsive-mobile-profile-"));
  qaEnvironment = createIsolatedQaEnv("anx-responsive-mobile-config-");
  const app = await withTimeout(electron.launch({
    args: [`--user-data-dir=${qaUserDataDir}`, "--no-sandbox", root, "--qa-mode"],
    env: { ...process.env, ...qaEnvironment.env, ANXOS_QA_MODE: "1" },
  }), ACTION_TIMEOUT_MS * 3, "Electron launch");
  electronApp = app;
  spawnedPid = app.process()?.pid || null;
  app.process().stdout?.on("data", (chunk) => mainLogs.push(redact(chunk.toString())));
  app.process().stderr?.on("data", (chunk) => mainLogs.push(redact(chunk.toString())));
  stage("electron-spawned");
  const page = await withTimeout(app.firstWindow(), ACTION_TIMEOUT_MS, "Main window launch");
  page.setDefaultTimeout(ACTION_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
  page.on("pageerror", (error) => rendererErrors.push(redact(`pageerror: ${error.stack || error.message}`)));
  page.on("console", (message) => {
    if (message.type() === "error") rendererErrors.push(redact(`console-error: ${message.text()}`));
  });

  stage("startup-screen-wait");
  await page.waitForLoadState("domcontentloaded");
  await page.locator("[data-startup-screen]").waitFor({ state: "hidden", timeout: STARTUP_READY_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(SETTLE_MS);

  stage("first-run-gates");
  const welcome = page.locator("[data-onboarding-welcome]");
  if (await welcome.count()) {
    await welcome.waitFor({ state: "visible", timeout: WELCOME_APPEAR_TIMEOUT_MS }).catch(() => {});
  }
  const launchDismissals = await dismissGates(page);

  for (const viewport of VIEWPORTS) {
    stage(`viewport-${viewport.name}`);
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0]?.setSize(size.width, size.height), viewport);
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.waitForTimeout(SETTLE_MS);
    for (const target of PAGES) {
      await dismissGates(page);
      await page.evaluate((name) => window.showPage?.(name), target.domPage);
      await page.waitForTimeout(SETTLE_MS);
      const result = await inspectViewport(page, viewport);
      result.requestedPage = target.name;
      result.domPage = target.domPage;
      result.pageSwitchMismatch = result.activePage !== target.domPage;
      result.screenshot = path.join(artifactDir, `${viewport.name}-${target.name}.png`);
      await page.screenshot({ path: result.screenshot });
      results.push(result);
    }
  }

  const failures = results.filter((result) => {
    const activeOverflow = result.overflowNodes.filter((node) => !/xterm|code|log|table-wrap|file-browser|file-editor/i.test(node.selector));
    const documentOverflow = result.documentWidth > result.viewportWidth + 2 || result.bodyWidth > result.viewportWidth + 2;
    const dialogOverflow = result.dialogs.some((dialog) => !dialog.viewportSafe);
    return documentOverflow || activeOverflow.length > 0 || dialogOverflow || result.pageSwitchMismatch;
  }).map((result) => ({
    viewport: result.viewport.name,
    page: result.requestedPage,
    activePage: result.activePage,
    pageSwitchMismatch: result.pageSwitchMismatch,
    documentWidth: result.documentWidth,
    viewportWidth: result.viewportWidth,
    overflowNodes: result.overflowNodes,
    dialogs: result.dialogs,
  }));

  const smallControlCount = results.reduce((total, result) => total + result.smallControls.length, 0);
  fs.writeFileSync(path.join(artifactDir, "main-process.log"), mainLogs.join(""));
  fs.writeFileSync(path.join(artifactDir, "renderer-errors.log"), rendererErrors.join("\n"));
  const pass = failures.length === 0 && rendererErrors.length === 0;
  writeVerdict({
    pass,
    artifactDir,
    launchDismissals,
    failures,
    rendererErrors,
    viewports: VIEWPORTS.map((item) => item.name),
    pages: PAGES.map((item) => item.name),
    checks: results.length,
    smallControlCount,
    results,
  });
  stage("complete");
  console.log(JSON.stringify({ pass, artifactDir, viewports: VIEWPORTS.map((item) => item.name), pages: PAGES.length, checks: results.length, failures: failures.length, rendererErrors: rendererErrors.length, smallControlCount }, null, 2));
  if (failures.length > 0) throw new Error(`Responsive overflow/dialog failures: ${JSON.stringify(failures.slice(0, 8))}`);
  if (rendererErrors.length > 0) throw new Error(`Renderer errors: ${JSON.stringify(rendererErrors.slice(0, 8))}`);
  return pass;
}

async function run() {
  let pass = false;
  try {
    pass = await withTimeout(main(), GLOBAL_TIMEOUT_MS, "Responsive mobile QA run");
  } catch (error) {
    console.error(redact(error.stack || error.message));
    if (!verdictWritten) {
      writeVerdict({ pass: false, artifactDir, error: redact(error.message), rendererErrors, results, note: "run aborted before completion" });
    }
  } finally {
    await cleanupElectron();
  }
  process.exitCode = pass ? 0 : 1;
}

run();
