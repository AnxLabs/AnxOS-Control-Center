#!/usr/bin/env node
// Product media capture for the public website.
//
// Captures REAL product media from three sources:
//   1. A real rendered Agent TUI frame (pure renderer, headless) at 92x30.
//   2. A performance baseline of the CURRENT website served from a tiny local
//      static server (port 4288) measured with headless Chromium.
//   3. Screenshots of the real AnxOS Control Center Electron app launched with
//      the repo's proven launch recipe but deliberately WITHOUT --qa-mode /
//      ANXOS_QA_MODE so no QA MODE badge appears.
//
// Safety rules baked into this script:
//   - It never kills an unrelated process. It only ever terminates the exact
//     process tree it spawned (taskkill /PID <spawnedPid> /T /F).
//   - It uses a throwaway --user-data-dir plus createIsolatedQaEnv() config/log
//     directories, so the running installed app is never touched.
//   - Screenshots are scanned for hostnames/usernames/emails/tokens/IPs before
//     any web derivative is produced, and only clean shots are derived.
//
// Run: node scripts/capture-product-screenshots.js
// Outputs:
//   artifacts/website-shots/<timestamp>/raw/*.png
//   artifacts/website-shots/<timestamp>/manifest.json
//   artifacts/website-shots/<timestamp>/tui-frame.txt
//   artifacts/website-shots/<timestamp>/perf-baseline.json
//   artifacts/website-shots/<timestamp>/summary.json
//   website/assets/product/*.png|.webp   (clean shots only)

"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { _electron: electron, chromium } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { renderScreen } = require("../agent/src/tui/render");

const root = path.resolve(__dirname, "..");
const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const artifactDir = path.join(root, "artifacts", "website-shots", timestamp);
const rawDir = path.join(artifactDir, "raw");
const webDir = path.join(root, "website", "assets", "product");
const siteRoot = path.join(root, "website");

const PORT = 4288;
const WINDOW_WIDTH = 1500;
const WINDOW_HEIGHT = 950;
const MAX_DERIVATIVE_WIDTH = 1600;
const SETTLE_MS = 400;
const ACTION_TIMEOUT_MS = 8_000;
const LAUNCH_TIMEOUT_MS = 45_000;
const FIRST_WINDOW_TIMEOUT_MS = 20_000;
const STARTUP_READY_TIMEOUT_MS = 30_000;
const DOC_LOAD_TIMEOUT_MS = 45_000;
const WELCOME_APPEAR_TIMEOUT_MS = 5_000;
const CLEANUP_TIMEOUT_MS = 12_000;
const PERF_WAIT_MS = 6_000;

fs.mkdirSync(rawDir, { recursive: true });
fs.mkdirSync(webDir, { recursive: true });

function withTimeout(promise, timeoutMs, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${timeoutMs}ms.`), { code: "CAPTURE_TIMEOUT" })), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

const redact = (value) => String(value || "").replace(/(authorization|token|password|secret|api[_-]?key|cookie)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]");

function pngSize(filePath) {
  const buffer = fs.readFileSync(filePath);
  if (buffer.length < 24 || buffer.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// --- sensitive text scan ------------------------------------------------------

function scanTextForSensitive(text) {
  const source = String(text || "");
  const username = process.env.USERNAME || (() => { try { return os.userInfo().username; } catch { return ""; } })();
  const hostname = os.hostname();
  const home = os.homedir();
  const escape = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const isLoopback = (ip) => ip.startsWith("127.") || ip === "0.0.0.0";
  const ips = [...new Set(source.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [])];
  const nonLoopbackIps = ips.filter((ip) => !isLoopback(ip));
  const emails = [...new Set(source.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])];
  // ANX-XXXX-XXXX-XXXX is the placeholder printed in the Add Computer help text
  // (index.html), never a real pairing code; real codes never contain runs of X.
  const pairingMatches = [...new Set(source.match(/ANX-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/g) || [])];
  const pairingCodePlaceholders = pairingMatches.filter((code) => /^ANX-X{4}-X{4}-X{4}$/.test(code));
  const pairingCodes = pairingMatches.filter((code) => !/^ANX-X{4}-X{4}-X{4}$/.test(code));
  const credentialLike = [...new Set(source.match(/(?:token|secret|password|api[_-]?key|bearer)\s*[:=]\s*\S+/gi) || [])];
  const windowsUserPaths = [...new Set(source.match(/[A-Za-z]:\\Users\\[^\s\\"']+/gi) || [])];
  const usernameMatch = username && username.length >= 3 && new RegExp(`\\b${escape(username)}\\b`, "i").test(source) ? username : null;
  const hostnameMatch = hostname && new RegExp(`\\b${escape(hostname)}\\b`, "i").test(source) ? hostname : null;
  const homeDirMatch = home && source.toLowerCase().includes(home.toLowerCase()) ? home : null;
  const sensitive = Boolean(
    nonLoopbackIps.length || emails.length || pairingCodes.length || credentialLike.length
    || windowsUserPaths.length || usernameMatch || hostnameMatch || homeDirMatch,
  );
  return {
    loopbackIps: ips.filter(isLoopback),
    nonLoopbackIps,
    emails,
    pairingCodes,
    pairingCodePlaceholders,
    credentialLike,
    windowsUserPaths,
    usernameMatch,
    hostnameMatch,
    homeDirMatch,
    sensitive,
  };
}

function sensitiveNeedles(scan) {
  return [...new Set([
    ...(scan.nonLoopbackIps || []),
    ...(scan.emails || []),
    ...(scan.pairingCodes || []),
    ...(scan.credentialLike || []),
    ...(scan.windowsUserPaths || []),
    ...(scan.usernameMatch ? [scan.usernameMatch] : []),
    ...(scan.hostnameMatch ? [scan.hostnameMatch] : []),
    ...(scan.homeDirMatch ? [scan.homeDirMatch] : []),
  ])];
}

function buildAssessment(scan) {
  const placeholderNote = scan.pairingCodePlaceholders.length
    ? ` Shipped example placeholder text ${scan.pairingCodePlaceholders.join(", ")} was present (not a real code).`
    : "";
  if (!scan.sensitive) {
    const loop = scan.loopbackIps.length
      ? ` Only loopback address(es) ${scan.loopbackIps.join(", ")} were visible (non-identifying local defaults).`
      : "";
    return `Automated scan found no hostname, username, email, token, pairing code, or non-loopback IP.${loop}${placeholderNote}`;
  }
  const parts = [];
  if (scan.nonLoopbackIps.length) parts.push(`non-loopback IP(s): ${scan.nonLoopbackIps.join(", ")}`);
  if (scan.emails.length) parts.push(`email(s): ${scan.emails.join(", ")}`);
  if (scan.pairingCodes.length) parts.push(`pairing code(s): ${scan.pairingCodes.join(", ")}`);
  if (scan.credentialLike.length) parts.push(`credential-like text: ${scan.credentialLike.join(" | ")}`);
  if (scan.windowsUserPaths.length) parts.push(`Windows user path(s): ${scan.windowsUserPaths.join(", ")}`);
  if (scan.usernameMatch) parts.push(`OS username: ${scan.usernameMatch}`);
  if (scan.hostnameMatch) parts.push(`OS hostname: ${scan.hostnameMatch}`);
  if (scan.homeDirMatch) parts.push(`home directory: ${scan.homeDirMatch}`);
  return `Sensitive text matched - ${parts.join("; ")}.${placeholderNote}`;
}

// Determines which matched needles are actually inside the captured viewport
// (page.screenshot captures the viewport only, so off-screen page content is
// not part of the image).
async function findVisibleNeedles(page, needles) {
  if (!needles.length) return {};
  return page.evaluate((list) => {
    const result = {};
    const inViewport = (rect) => Boolean(rect) && rect.width > 0 && rect.height > 0
      && rect.bottom > 0 && rect.top < window.innerHeight && rect.right > 0 && rect.left < window.innerWidth;
    const lowered = list.map((needle) => needle.toLowerCase());
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const text = (node.nodeValue || "").toLowerCase();
      if (text) {
        const parent = node.parentElement;
        if (parent) {
          const style = getComputedStyle(parent);
          const elementHidden = style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0;
          if (!elementHidden) {
            for (let index = 0; index < lowered.length; index += 1) {
              const needle = list[index];
              if (result[needle] === true) continue;
              if (text.includes(lowered[index])) {
                let visible = false;
                try {
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  visible = inViewport(range.getBoundingClientRect());
                } catch {}
                if (!visible) visible = inViewport(parent.getBoundingClientRect());
                if (visible) result[needle] = true;
                else if (result[needle] !== true) result[needle] = false;
              }
            }
          }
        }
      }
      node = walker.nextNode();
    }
    for (const needle of list) if (result[needle] === undefined) result[needle] = false;
    return result;
  }, needles).catch(() => Object.fromEntries(needles.map((needle) => [needle, false])));
}

// --- Step 3: real Agent TUI frame (92x30) ------------------------------------

function captureTuiFrame() {
  const logLine = (payload) => JSON.stringify(payload);
  const state = {
    view: "status",
    connection: {
      primary: "http://127.0.0.1:47131",
      loopbackUrl: "http://127.0.0.1:47131",
      loopbackOnly: true,
      token: { readable: true, fingerprint: "7c2f" },
    },
    health: {
      identity: { agentVersion: "0.1.0", deviceId: "dev-01", platform: "linux", architecture: "x64" },
      tokenConfigured: true,
      tokenFingerprint: "7c2f",
    },
    enrollment: { state: "enrolled" },
    pairingStatus: { status: "not_paired" },
    service: { supported: true, mode: "system", state: "active", enabled: true, unitPath: "/lib/systemd/system/anxos-agent.service" },
    system: {
      cpu: { usagePercent: 3.2, cores: 4 },
      memory: { used: 3221225472, total: 8589934592, percent: 37.5 },
      disk: { free: 412316860416, total: 536870912000, percent: 23 },
      network: { downloadPerSecond: 18432, uploadPerSecond: 2048 },
    },
    logs: {
      ok: true,
      path: "/var/log/anxos-agent/agent.log",
      lines: [
        logLine({ timestamp: "2026-09-27T09:00:00.000Z", severity: "info", operation: "startup", message: "Agent service started" }),
        logLine({ timestamp: "2026-09-27T09:00:01.000Z", severity: "info", operation: "heartbeat", message: "Control Center connection healthy" }),
        logLine({ timestamp: "2026-09-27T09:00:06.000Z", severity: "info", operation: "metrics", message: "System metrics collected" }),
      ],
    },
    update: { state: "current", currentVersion: "0.1.0", latestVersion: "0.1.0" },
    cliVersion: "0.1.0",
    nowMs: Date.now(),
  };
  const text = renderScreen(state, { width: 92, height: 30, unicode: true });
  fs.writeFileSync(path.join(artifactDir, "tui-frame.txt"), `${text}\n`, "utf8");
  const scan = scanTextForSensitive(text);
  return { file: path.join(artifactDir, "tui-frame.txt"), width: 92, height: 30, scan, text };
}

// --- Step 4: static server + perf baseline -----------------------------------

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function startStaticServer() {
  const server = http.createServer((request, response) => {
    let urlPath = "/";
    try {
      urlPath = decodeURIComponent(new URL(request.url, `http://127.0.0.1:${PORT}`).pathname);
    } catch {
      response.writeHead(400).end("Bad request");
      return;
    }
    const resolved = path.resolve(siteRoot, `.${urlPath}`);
    if (!resolved.toLowerCase().startsWith(siteRoot.toLowerCase())) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    const candidates = [];
    if (urlPath.endsWith("/")) candidates.push(path.join(resolved, "index.html"));
    else {
      candidates.push(resolved);
      if (!path.extname(resolved)) {
        candidates.push(`${resolved}.html`);
        candidates.push(path.join(resolved, "index.html"));
      }
    }
    const filePath = candidates.find((candidate) => {
      try { return fs.statSync(candidate).isFile(); } catch { return false; }
    });
    if (!filePath) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    const body = fs.readFileSync(filePath);
    response.writeHead(200, {
      "content-type": MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "content-length": String(body.length),
      "cache-control": "no-store",
    });
    response.end(body);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, "127.0.0.1", () => resolve(server));
  });
}

function summarizeResource(r, buckets) {
  const name = String(r.name || "");
  const transfer = r.transferSize || 0;
  const encoded = r.encodedBodySize || 0;
  if (r.initiatorType === "script" || /\.m?js(\?|#|$)/i.test(name)) buckets.js += encoded;
  else if (r.initiatorType === "link" && /\.css(\?|#|$)/i.test(name)) buckets.css += encoded;
  else if (/\.css(\?|#|$)/i.test(name)) buckets.css += encoded;
  else if (r.initiatorType === "img" || /\.(png|jpe?g|webp|gif|svg|ico|avif)(\?|#|$)/i.test(name)) buckets.image += encoded;
  else if (/\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(name)) buckets.font += encoded;
  else buckets.other += encoded;
  return { transfer, encoded };
}

async function runPerfRun(browser, url, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const requests = [];
  const failures = [];
  page.on("request", (request) => requests.push(request.url()));
  page.on("requestfailed", (request) => failures.push({ url: request.url(), error: request.failure()?.errorText || "unknown" }));
  await page.addInitScript(() => {
    window.__anxLcp = null;
    try {
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const last = entries[entries.length - 1];
        if (last) {
          window.__anxLcp = {
            startTime: last.startTime,
            size: last.size,
            element: last.element ? last.element.tagName : null,
            url: last.url || null,
          };
        }
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
    } catch {
      window.__anxLcp = null;
    }
  });
  const startedAt = Date.now();
  await page.goto(url, { waitUntil: "load", timeout: 30_000 });
  await page.waitForTimeout(PERF_WAIT_MS);
  const metrics = await page.evaluate(() => {
    const nav = performance.getEntriesByType("navigation")[0] || {};
    const resources = performance.getEntriesByType("resource");
    const buckets = { js: 0, css: 0, image: 0, font: 0, other: 0 };
    let transferSizeTotal = 0;
    let encodedBodySizeTotal = 0;
    let subframeCount = 0;
    for (const entry of resources) {
      const name = String(entry.name || "");
      const transfer = entry.transferSize || 0;
      const encoded = entry.encodedBodySize || 0;
      transferSizeTotal += transfer;
      encodedBodySizeTotal += encoded;
      if (entry.initiatorType === "iframe" || entry.initiatorType === "document") subframeCount += 1;
      if (entry.initiatorType === "script" || /\.m?js(\?|#|$)/i.test(name)) buckets.js += encoded;
      else if (/\.css(\?|#|$)/i.test(name)) buckets.css += encoded;
      else if (entry.initiatorType === "img" || /\.(png|jpe?g|webp|gif|svg|ico|avif)(\?|#|$)/i.test(name)) buckets.image += encoded;
      else if (/\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(name)) buckets.font += encoded;
      else buckets.other += encoded;
    }
    return {
      documentCount: 1,
      subframeCount,
      resourceCount: resources.length,
      transferSizeTotal,
      encodedBodySizeTotal,
      mainDocumentTransferSize: nav.transferSize || 0,
      jsBytes: Math.round(buckets.js),
      cssBytes: Math.round(buckets.css),
      imageBytes: Math.round(buckets.image),
      fontBytes: Math.round(buckets.font),
      otherBytes: Math.round(buckets.other),
      lcp: window.__anxLcp || null,
      domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0),
      loadMs: Math.round(nav.loadEventEnd || 0),
    };
  });
  await context.close();
  const externalHosts = [...new Set(requests.map((requestUrl) => {
    try { return new URL(requestUrl).host; } catch { return "invalid"; }
  }).filter((host) => !/^(localhost|127\.0\.0\.1):/.test(host)))];
  return {
    ...metrics,
    wallMs: Date.now() - startedAt,
    requestCount: requests.length,
    failedRequestCount: failures.length,
    requestFailures: failures.slice(0, 10),
    externalHosts,
    externalHostsNote: "Cross-origin resources (e.g. api.github.com release widgets) may report 0 encodedBodySize/transferSize without Timing-Allow-Origin.",
  };
}

async function runPerfBaseline(browser, blockers) {
  const pages = ["/", "/download/"];
  const viewports = [
    { name: "desktop", width: 1440, height: 900 },
    { name: "mobile", width: 390, height: 844 },
  ];
  const results = [];
  for (const pagePath of pages) {
    for (const viewport of viewports) {
      const url = `http://127.0.0.1:${PORT}${pagePath}`;
      const entry = { page: pagePath, url, viewport, runs: [] };
      for (let run = 1; run <= 2; run += 1) {
        try {
          entry.runs.push(await runPerfRun(browser, url, viewport));
        } catch (error) {
          entry.runs.push({ error: redact(error?.message || String(error)) });
          blockers.push(`perf run failed for ${pagePath} @ ${viewport.name} run ${run}: ${redact(error?.message || String(error))}`);
        }
      }
      entry.reported = entry.runs[1] && !entry.runs[1].error ? "run2" : (entry.runs[0] && !entry.runs[0].error ? "run1" : "none");
      results.push(entry);
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    server: { url: `http://127.0.0.1:${PORT}`, root: path.relative(root, siteRoot) },
    method: {
      browser: "playwright-core chromium headless",
      viewports,
      runsPerPage: 2,
      reportedRun: "second run",
      lcp: "PerformanceObserver largest-contentful-paint, buffered, read after 6s",
      waitMsBeforeMetrics: PERF_WAIT_MS,
    },
    note: "Live-release widgets fetch the GitHub API at runtime; cross-origin byte counts can be 0 without Timing-Allow-Origin.",
    results,
  };
}

// --- Step 2: Electron app screenshots ----------------------------------------

// Gate dismissal copied from scripts/responsive-mobile-ui-qa.js (welcome first
// because its backdrop intercepts pointer events for everything behind it).
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

async function domClick(originalLocator, page) {
  try {
    await originalLocator.click({ timeout: 3_000 });
    return { clicked: true, domFallback: false };
  } catch {
    const dismissed = await dismissGates(page);
    if (dismissed.length) {
      await originalLocator.click({ timeout: ACTION_TIMEOUT_MS });
      return { clicked: true, domFallback: false, dismissed };
    }
    await originalLocator.evaluate((element) => element.click());
    return { clicked: true, domFallback: true };
  }
}

async function collectUiText(page) {
  return page.evaluate(() => {
    const parts = [];
    const active = document.querySelector(".page.is-active");
    if (active) parts.push(active.innerText);
    document.querySelectorAll('[role="dialog"], .app-modal, [data-node-modal]').forEach((node) => {
      if (!node.hidden && node.getClientRects().length) parts.push(node.innerText);
    });
    const values = [];
    document.querySelectorAll("input, textarea, select").forEach((element) => {
      if (element.type === "password") return;
      if (!element.getClientRects().length) return;
      const value = String(element.value || "").trim();
      if (value) values.push(value);
    });
    return {
      activeText: parts.join("\n---\n").replace(/\n{3,}/g, "\n\n").slice(0, 8_000),
      uiText: String(document.body.innerText || "").slice(0, 20_000),
      formValues: values.join("\n").slice(0, 4_000),
    };
  }).catch(() => ({ activeText: "", uiText: "", formValues: "" }));
}

async function shotWithScan(page, id, blockers, extra = {}) {
  const file = path.join(rawDir, `${id}.png`);
  await page.screenshot({ path: file, scale: "css", timeout: ACTION_TIMEOUT_MS });
  const dims = pngSize(file);
  const textInfo = await collectUiText(page);
  const scan = scanTextForSensitive(`${textInfo.uiText}\n${textInfo.formValues}`);
  const needles = sensitiveNeedles(scan);
  const visibility = await findVisibleNeedles(page, needles);
  const visibleFindings = needles.filter((needle) => visibility[needle] === true);
  const offscreenFindings = needles.filter((needle) => visibility[needle] !== true);
  const clean = visibleFindings.length === 0;
  let assessment = buildAssessment(scan);
  if (clean && offscreenFindings.length) {
    assessment += ` Matched text appears only OUTSIDE the captured viewport (${offscreenFindings.join(", ")}); the image itself contains none.`;
  }
  const record = {
    id,
    status: "captured",
    rawPath: path.relative(root, file).split(path.sep).join("/"),
    width: dims?.width || 0,
    height: dims?.height || 0,
    bytes: fs.statSync(file).size,
    sensitive: scan,
    visibleFindings,
    offscreenFindings,
    clean,
    assessment,
    visibleTextExcerpt: textInfo.activeText.replace(/\s+/g, " ").trim().slice(0, 800),
    ...extra,
  };
  if (!clean) blockers.push(`shot ${id} contains sensitive text inside the captured frame: ${visibleFindings.join(", ")}`);
  return record;
}

function skippedShot(id, label, reason) {
  return { id, label, status: "skipped", reason, clean: false, assessment: `Not captured: ${reason}` };
}

async function waitForWorkspaceWindow(electronApp, surface, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const found = electronApp.windows().find((candidate) => candidate.url().includes(`surface=${surface}`));
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return null;
}

async function cleanupElectron(electronApp, spawnedPid) {
  if (electronApp) {
    await withTimeout(electronApp.close(), CLEANUP_TIMEOUT_MS, "Electron shutdown").catch(() => {});
  }
  if (spawnedPid) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(spawnedPid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      try { process.kill(-spawnedPid, "SIGKILL"); } catch {}
      try { process.kill(spawnedPid, "SIGKILL"); } catch {}
    }
  }
}

async function captureAppShots(blockers) {
  const result = {
    launched: false,
    qaModeRequested: false,
    args: null,
    shots: [],
    gatesDismissed: [],
    notes: [],
    blockers: [],
  };
  const qaUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-website-shots-profile-"));
  const qaEnvironment = createIsolatedQaEnv("anx-website-shots-config-");
  const env = { ...process.env, ...qaEnvironment.env };
  delete env.ANXOS_QA_MODE;
  delete env.ELECTRON_ENABLE_LOGGING;
  delete env.ANXOS_OPEN_DEVTOOLS;
  const args = [`--user-data-dir=${qaUserDataDir}`, "--no-sandbox", root];
  result.args = args;
  result.userDataDir = qaUserDataDir;
  result.isolatedEnv = { configDir: qaEnvironment.configDir, logDir: qaEnvironment.logDir };
  let electronApp = null;
  let spawnedPid = null;
  const mainLogs = [];
  try {
    electronApp = await withTimeout(electron.launch({ args, env }), LAUNCH_TIMEOUT_MS, "Electron launch");
    spawnedPid = electronApp.process()?.pid || null;
    result.pid = spawnedPid;
    electronApp.process()?.stdout?.on("data", (chunk) => mainLogs.push(redact(chunk.toString())));
    electronApp.process()?.stderr?.on("data", (chunk) => mainLogs.push(redact(chunk.toString())));
    const page = await withTimeout(electronApp.firstWindow(), FIRST_WINDOW_TIMEOUT_MS, "Electron first window");
    result.launched = true;

    try {
      const paths = await electronApp.evaluate(({ app }) => ({ userData: app.getPath("userData"), appData: app.getPath("appData") }));
      result.appPaths = paths;
    } catch {}

    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(ACTION_TIMEOUT_MS);
    // The non-QA startup does more work than QA mode (update check, marketplace
    // provider restore) and can take well over 8s to reach DOMContentLoaded on
    // a cold profile, so keep this wait generous and non-fatal.
    result.firstWindowUrl = page.url();
    await page.waitForLoadState("domcontentloaded", { timeout: DOC_LOAD_TIMEOUT_MS }).catch((error) => {
      result.notes.push(`domcontentloaded wait: ${redact(error?.message || String(error))}`);
    });
    await page.waitForFunction(() => document.readyState !== "loading" && Boolean(document.body), null, { timeout: DOC_LOAD_TIMEOUT_MS }).catch(() => {});
    await page.locator("[data-startup-screen]").waitFor({ state: "hidden", timeout: STARTUP_READY_TIMEOUT_MS }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);

    await electronApp.evaluate(({ BrowserWindow }, size) => {
      const target = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
      if (target) target.setSize(size.width, size.height);
    }, { width: WINDOW_WIDTH, height: WINDOW_HEIGHT }).catch(() => {});
    await page.setViewportSize({ width: WINDOW_WIDTH, height: WINDOW_HEIGHT }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);

    const welcome = page.locator("[data-onboarding-welcome]");
    if (await welcome.count()) {
      await welcome.waitFor({ state: "visible", timeout: WELCOME_APPEAR_TIMEOUT_MS }).catch(() => {});
    }
    result.gatesDismissed = await dismissGates(page);
    result.qaBadgeVisible = await page.locator("[data-testid=qa-mode-indicator]").isVisible({ timeout: 500 }).catch(() => false);

    const surfaces = [
      { id: "01-dashboard", label: "Dashboard", nav: "dashboard" },
      { id: "02-nodes", label: "Nodes", nav: "nodes" },
      { id: "03-agent-control", label: "Agent Control", nav: "agent-control" },
      { id: "05-marketplace", label: "Marketplace", nav: "marketplace", windowed: true },
      { id: "06-instances", label: "Instances", nav: "instances" },
      { id: "07-public-access", label: "Public Access", nav: "playit" },
      { id: "08-settings", label: "Settings", nav: "settings" },
    ];

    for (const surface of surfaces) {
      try {
        await dismissGates(page);
        if (surface.windowed) {
          const link = page.locator(`[data-page-target="${surface.nav}"]`).first();
          if (!(await link.count())) {
            result.shots.push(skippedShot(surface.id, surface.label, `nav target ${surface.nav} not found`));
            continue;
          }
          await domClick(link, page);
          const marketplaceWindow = await waitForWorkspaceWindow(electronApp, "marketplace", 8_000);
          if (!marketplaceWindow) {
            result.shots.push(skippedShot(surface.id, surface.label, "marketplace workspace window did not open"));
            continue;
          }
          marketplaceWindow.setDefaultTimeout(ACTION_TIMEOUT_MS);
          await marketplaceWindow.waitForLoadState("domcontentloaded").catch(() => {});
          await dismissGates(marketplaceWindow);
          let visible = await marketplaceWindow.locator('[data-page="marketplace"]').isVisible({ timeout: 5_000 }).catch(() => false);
          if (!visible) {
            await marketplaceWindow.waitForTimeout(1_000);
            visible = await marketplaceWindow.locator('[data-page="marketplace"]').isVisible({ timeout: 3_000 }).catch(() => false);
          }
          if (!visible) {
            result.shots.push(skippedShot(surface.id, surface.label, "marketplace page did not become visible in its window"));
            continue;
          }
          await dismissGates(marketplaceWindow);
          await marketplaceWindow.waitForTimeout(SETTLE_MS);
          result.shots.push(await shotWithScan(marketplaceWindow, surface.id, blockers, { label: surface.label, window: "marketplace workspace window" }));
          continue;
        }
        const link = page.locator(`[data-page-target="${surface.nav}"]`).first();
        if (!(await link.count())) {
          result.shots.push(skippedShot(surface.id, surface.label, `nav target ${surface.nav} not found`));
          continue;
        }
        if (await link.isHidden().catch(() => false)) {
          result.shots.push(skippedShot(surface.id, surface.label, `nav target ${surface.nav} is hidden in this profile`));
          continue;
        }
        await link.scrollIntoViewIfNeeded().catch(() => {});
        const click = await domClick(link, page);
        const visible = await page.locator(`[data-page="${surface.nav}"]`).isVisible({ timeout: 5_000 }).catch(() => false);
        if (!visible) {
          const gated = await page.locator("[data-security-gate]").isVisible({ timeout: 500 }).catch(() => false);
          result.shots.push(skippedShot(surface.id, surface.label, gated ? "owner security gate visible; content not reachable without owner auth" : `page ${surface.nav} did not become visible after nav click`));
          continue;
        }
        await dismissGates(page);
        await page.waitForTimeout(SETTLE_MS);
        if (surface.id === "03-agent-control") {
          // Give the Agent Control summary a bounded chance to replace its
          // "Loading ..." placeholder (renderAgentBeginnerSummary fires on the
          // next state update) before capturing.
          await page.waitForFunction(() => {
            const section = document.querySelector("[data-agent-beginner-summary]");
            return Boolean(section) && !/Loading Agent Control summary/i.test(section.textContent || "");
          }, null, { timeout: 8_000 }).catch(() => {});
        }
        result.shots.push(await shotWithScan(page, surface.id, blockers, { label: surface.label, domFallbackClick: Boolean(click.domFallback) }));
      } catch (error) {
        result.shots.push(skippedShot(surface.id, surface.label, `capture error: ${redact(error?.message || String(error))}`));
      }
    }

    // Add Computer modal: reachable from the Nodes page's real trigger.
    try {
      await dismissGates(page);
      const nodesVisible = await page.locator('[data-page="nodes"]').isVisible({ timeout: 2_000 }).catch(() => false);
      if (!nodesVisible) {
        const link = page.locator('[data-page-target="nodes"]').first();
        if (await link.count()) await domClick(link, page);
        await page.waitForTimeout(SETTLE_MS);
      }
      const openButton = page.locator('[data-node-action="open-add"]').first();
      if (!(await openButton.count()) || await openButton.isHidden().catch(() => false)) {
        result.shots.push(skippedShot("04-add-computer", "Add Computer dialog", "Add Computer trigger [data-node-action=open-add] not visible on Nodes page"));
      } else {
        await domClick(openButton, page);
        const modalVisible = await page.locator("[data-node-modal]").isVisible({ timeout: 5_000 }).catch(() => false);
        if (!modalVisible) {
          result.shots.push(skippedShot("04-add-computer", "Add Computer dialog", "node modal did not become visible after clicking its trigger"));
        } else {
          await page.waitForTimeout(SETTLE_MS);
          result.shots.push(await shotWithScan(page, "04-add-computer", blockers, { label: "Add Computer dialog", note: "dialog opened via real [data-node-action=open-add] trigger" }));
          const close = page.locator('[data-node-modal] [data-node-action="close-modal"]').first();
          if (await close.count()) {
            await close.evaluate((element) => element.click()).catch(() => {});
            await page.locator("[data-node-modal]").waitFor({ state: "hidden", timeout: ACTION_TIMEOUT_MS }).catch(() => {});
          }
        }
      }
    } catch (error) {
      result.shots.push(skippedShot("04-add-computer", "Add Computer dialog", `capture error: ${redact(error?.message || String(error))}`));
    }

    // Settings -> Updates category (real trigger). Re-click the Settings nav
    // first because earlier captures (e.g. the Add Computer modal) may have
    // left the window on a different page.
    try {
      await dismissGates(page);
      const settingsLink = page.locator('[data-page-target="settings"]').first();
      if (await settingsLink.count()) {
        await domClick(settingsLink, page);
        await page.waitForTimeout(SETTLE_MS);
      }
      const settingsVisible = await page.locator('[data-page="settings"]').isVisible({ timeout: 5_000 }).catch(() => false);
      if (settingsVisible) {
        const updatesButton = page.locator('[data-settings-category-target="updates"]').first();
        if (await updatesButton.count()) {
          await updatesButton.evaluate((element) => element.click()).catch(() => {});
          await page.waitForTimeout(SETTLE_MS + 200);
          const updatesSectionVisible = await page.locator('[data-settings-category="updates"]').isVisible({ timeout: 3_000 }).catch(() => false);
          const record = await shotWithScan(page, "09-settings-updates", blockers, {
            label: "Settings — Updates",
            note: "Updates category opened via real [data-settings-category-target=updates] trigger",
            updatesSectionVisible,
          });
          result.shots.push(record);
        } else {
          result.shots.push(skippedShot("09-settings-updates", "Settings — Updates", "updates category trigger not found"));
        }
      } else {
        result.shots.push(skippedShot("09-settings-updates", "Settings — Updates", "settings page was not reachable"));
      }
    } catch (error) {
      result.shots.push(skippedShot("09-settings-updates", "Settings — Updates", `capture error: ${redact(error?.message || String(error))}`));
    }
  } catch (error) {
    const spawnExitCode = (() => { try { return electronApp?.process()?.exitCode; } catch { return null; } })();
    const message = redact(error?.message || String(error));
    result.blockers.push(message);
    result.launchError = message;
    result.spawnExitCode = spawnExitCode;
    blockers.push(`Electron capture failed: ${message}${spawnExitCode !== null && spawnExitCode !== undefined ? ` (spawned process exit code ${spawnExitCode})` : ""}. A pre-existing AnxOS Control Center instance was observed running before launch; if the launch was swallowed by the single-instance lock the app intentionally exits and restores the primary window instead.`);
  } finally {
    await cleanupElectron(electronApp, spawnedPid).catch(() => {});
    fs.writeFileSync(path.join(artifactDir, "electron-process.log"), mainLogs.join(""));
    try { qaEnvironment.cleanup(); } catch {}
    try { fs.rmSync(qaUserDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
  return result;
}

// --- web derivative conversion (Chromium re-encode, no new dependencies) -----

const WEB_NAMES = {
  "01-dashboard": "control-center-dashboard",
  "02-nodes": "control-center-nodes",
  "03-agent-control": "control-center-agent-control",
  "04-add-computer": "control-center-add-computer",
  "05-marketplace": "control-center-marketplace",
  "06-instances": "control-center-instances",
  "07-public-access": "control-center-public-access",
  "08-settings": "control-center-settings",
  "09-settings-updates": "control-center-settings-updates",
};

async function deriveAsset(browser, rawFile, baseName) {
  const dims = pngSize(rawFile);
  if (!dims || !dims.width || !dims.height) throw new Error(`cannot read PNG dimensions of ${rawFile}`);
  const targetWidth = Math.min(MAX_DERIVATIVE_WIDTH, dims.width);
  const targetHeight = Math.max(1, Math.round(dims.height * (targetWidth / dims.width)));
  const dataUrl = `data:image/png;base64,${fs.readFileSync(rawFile).toString("base64")}`;
  const page = await browser.newPage({ viewport: { width: targetWidth, height: targetHeight }, deviceScaleFactor: 1 });
  try {
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;padding:0}img{display:block;width:${targetWidth}px;height:${targetHeight}px}</style><img id="src" src="${dataUrl}">`,
      { waitUntil: "load" },
    );
    await page.waitForFunction(() => {
      const image = document.getElementById("src");
      return Boolean(image && image.complete && image.naturalWidth > 0);
    }, { timeout: 15_000 });
    // Playwright element screenshots only support png/jpeg, so encode both
    // formats in-page via canvas (Chromium's own PNG/WebP encoders) instead.
    const encoded = await page.evaluate((size) => {
      const image = document.getElementById("src");
      const canvas = document.createElement("canvas");
      canvas.width = size.width;
      canvas.height = size.height;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, size.width, size.height);
      return { png: canvas.toDataURL("image/png"), webp: canvas.toDataURL("image/webp", 0.92) };
    }, { width: targetWidth, height: targetHeight });
    const writeDataUrl = (value, outputPath) => {
      const base64 = String(value).split(",")[1];
      if (!base64) throw new Error(`empty encoded image for ${outputPath}`);
      fs.writeFileSync(outputPath, Buffer.from(base64, "base64"));
    };
    const pngPath = path.join(webDir, `${baseName}.png`);
    const webpPath = path.join(webDir, `${baseName}.webp`);
    writeDataUrl(encoded.png, pngPath);
    writeDataUrl(encoded.webp, webpPath);
    return {
      png: path.relative(root, pngPath).split(path.sep).join("/"),
      webp: path.relative(root, webpPath).split(path.sep).join("/"),
      width: targetWidth,
      height: targetHeight,
      pngBytes: fs.statSync(pngPath).size,
      webpBytes: fs.statSync(webpPath).size,
      downscaled: targetWidth < dims.width,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

// --- main ---------------------------------------------------------------------

async function main() {
  const startedAt = Date.now();
  const blockers = [];
  const stage = (name, extra = {}) => console.error(`[capture][stage] ${name} ${JSON.stringify({ elapsedMs: Date.now() - startedAt, ...extra })}`);

  stage("tui-frame");
  const tui = captureTuiFrame();

  stage("static-server-start");
  let server = null;
  try {
    server = await startStaticServer();
  } catch (error) {
    blockers.push(`static server failed on port ${PORT}: ${redact(error?.message || String(error))}`);
  }

  stage("chromium-launch");
  let browser = null;
  if (server) {
    try {
      browser = await chromium.launch({ headless: true });
    } catch (error) {
      blockers.push(`chromium launch failed (perf baseline and web derivatives unavailable): ${redact(error?.message || String(error))}`);
    }
  } else {
    blockers.push("static server unavailable; perf baseline skipped");
  }

  let perf = null;
  if (browser) {
    stage("perf-baseline-start");
    try {
      perf = await runPerfBaseline(browser, blockers);
      fs.writeFileSync(path.join(artifactDir, "perf-baseline.json"), JSON.stringify(perf, null, 2));
    } catch (error) {
      blockers.push(`perf baseline failed: ${redact(error?.message || String(error))}`);
    }
    stage("perf-baseline-complete");
  }

  stage("electron-launch-start");
  const electronResult = await captureAppShots(blockers);
  stage("electron-capture-complete", { launched: electronResult.launched, shots: electronResult.shots.length });

  stage("web-derivatives-start");
  const derivatives = [];
  const withheld = [];
  for (const shot of electronResult.shots) {
    if (shot.status !== "captured") {
      withheld.push({ id: shot.id, label: shot.label, reason: shot.reason });
      continue;
    }
    if (!shot.clean) {
      withheld.push({ id: shot.id, label: shot.label, reason: `sensitive text detected: ${shot.assessment}` });
      continue;
    }
    const baseName = WEB_NAMES[shot.id] || `control-center-${shot.id}`;
    if (!browser) {
      withheld.push({ id: shot.id, label: shot.label, reason: "chromium unavailable; conversion skipped" });
      continue;
    }
    try {
      const derived = await deriveAsset(browser, path.join(root, shot.rawPath.split("/").join(path.sep)), baseName);
      derivatives.push({ id: shot.id, label: shot.label, ...derived });
    } catch (error) {
      withheld.push({ id: shot.id, label: shot.label, reason: `derivative conversion failed: ${redact(error?.message || String(error))}` });
    }
  }
  stage("web-derivatives-complete", { derivatives: derivatives.length, withheld: withheld.length });

  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((resolve) => server.close(resolve));

  const manifest = {
    generatedAt: new Date().toISOString(),
    qaMode: false,
    qaModeNote: "Launched without --qa-mode and without ANXOS_QA_MODE so no QA MODE badge is rendered.",
    appPaths: electronResult.appPaths || null,
    electronLaunch: {
      launched: electronResult.launched,
      pid: electronResult.pid || null,
      args: electronResult.args,
      gatesDismissed: electronResult.gatesDismissed,
      qaBadgeVisible: electronResult.qaBadgeVisible ?? null,
      launchError: electronResult.launchError || null,
    },
    shots: electronResult.shots,
    derivatives,
    withheld,
    blockers,
  };
  fs.writeFileSync(path.join(artifactDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const summary = {
    timestamp,
    artifactDir: path.relative(root, artifactDir).split(path.sep).join("/"),
    tui: { file: path.relative(root, tui.file).split(path.sep).join("/"), width: tui.width, height: tui.height, sensitive: tui.scan.sensitive },
    perf: perf ? { file: "perf-baseline.json", results: perf.results.map((entry) => ({
      page: entry.page,
      viewport: entry.viewport.name,
      reported: entry.reported,
      metrics: entry.reported === "run2" ? entry.runs[1] : entry.runs[0],
    })) } : null,
    electron: {
      launched: electronResult.launched,
      launchError: electronResult.launchError || null,
appPaths: electronResult.appPaths || null,
    appPathsNote: "Non-QA mode intentionally keeps the app's real userData path (configureElectronPaths overrides --user-data-dir after the single-instance lock is acquired); config, logs, temp and agent paths stay isolated via the ANXHUB_CONFIG_DIR/ANXOS_* env vars from createIsolatedQaEnv().",
      qaBadgeVisible: electronResult.qaBadgeVisible ?? null,
      gatesDismissed: electronResult.gatesDismissed,
    },
    shots: electronResult.shots.map((shot) => ({ id: shot.id, label: shot.label, status: shot.status, reason: shot.reason || null, width: shot.width || null, height: shot.height || null, bytes: shot.bytes || null, clean: shot.clean || false, visibleFindings: shot.visibleFindings || [], offscreenFindings: shot.offscreenFindings || [], assessment: shot.assessment })),
    derivatives,
    withheld,
    blockers,
  };
  fs.writeFileSync(path.join(artifactDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  console.log("\n--- tui-frame.txt ---\n");
  console.log(tui.text);
  return summary;
}

main().catch((error) => {
  console.error(redact(error?.stack || error?.message || String(error)));
  process.exitCode = 1;
});