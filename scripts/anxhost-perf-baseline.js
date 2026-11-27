#!/usr/bin/env node
"use strict";

// Build 217-A performance evidence. A lightweight, repeatable measurement of
// one app checkout, not a pass/fail gate. Per round:
//
//   cold start   a fresh profile: renderer ready, first interactive screen
//                (the setup gate or the sidebar)
//   idle         a signed-in disposable owner on Home, then on My Servers:
//                Agent requests by route over a fixed window, the app's
//                memory (working set and private bytes, all processes) and
//                CPU from Electron's process metrics
//   warm start   the same profile launched again
//
// Every Agent request goes through a counting proxy in front of the real
// fixture Agent, so duplicate polling shows up by route. The app runs in
// qa-mode with an isolated profile, off-screen and unfocused; it never
// touches the installed app, its data or the real Local Agent. QA mode turns
// off GPU acceleration, so absolute memory differs from a normal launch:
// compare builds measured the same way, the same day, by median.
//
// Usage:
//   node scripts/anxhost-perf-baseline.js [--app=<checkout>] [--label=x]
//        [--rounds=3] [--idle-ms=60000] [--settle-ms=20000] [--out=<file.json>]

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { _electron: electron } = require("playwright-core");
const { createIsolatedQaEnv } = require("./test-helpers/isolated-qa-env");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");
const { signInQaOwner } = require("./test-helpers/qa-owner");

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, "").split("="); return [key, rest.length ? rest.join("=") : true]; }));
const repo = path.resolve(__dirname, "..");
const appRoot = path.resolve(String(args.app || repo));
const label = String(args.label || path.basename(appRoot));
const rounds = Math.max(1, Number(args.rounds) || 3);
const IDLE_MS = Math.max(10_000, Number(args["idle-ms"]) || 60_000);
const SETTLE_MS = Math.max(5_000, Number(args["settle-ms"]) || 20_000);
const OFFSCREEN = { x: -32000, y: -32000 };
const SIZE = { width: 1280, height: 800 };

function hideWindowsFromDesktop({ BrowserWindow, screen }, offscreen) {
  if (!screen.__anxPerfPatched) {
    screen.__anxPerfPatched = true;
    const area = { x: offscreen.x, y: offscreen.y, width: 4000, height: 3000 };
    const virtual = { id: 9_999_997, label: "anx-perf-virtual", bounds: area, workArea: area, workAreaSize: { width: area.width, height: area.height }, size: { width: area.width, height: area.height }, scaleFactor: 1, rotation: 0, internal: false, monochrome: false, accelerometerSupport: "unknown", touchSupport: "unknown", colorDepth: 24, colorSpace: "", depthPerComponent: 8, displayFrequency: 60, detected: true };
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
  if (!proto.__anxPerfPatched) {
    proto.__anxPerfPatched = true;
    proto.show = function show() { park(this); this.showInactive(); park(this); };
    proto.focus = function focus() {};
    proto.moveTop = function moveTop() {};
  }
  for (const win of BrowserWindow.getAllWindows()) park(win);
}

async function evaluateMain(app, fn, arg) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await app.evaluate(fn, arg); } catch (error) { lastError = error; await new Promise((r) => setTimeout(r, 150)); }
  }
  throw lastError;
}

// Counts every request by method and route (ids collapsed), then forwards it.
function startCountingProxy(targetUrl) {
  const target = new URL(targetUrl);
  const counts = new Map();
  let counting = false;
  const routeOf = (method, url) => `${method} ${new URL(url, "http://x").pathname.replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "/:uuid").replace(/\/instances\/[^/]+/, "/instances/:id").replace(/\/\d+(?=\/|$)/g, "/:n")}`;
  const server = http.createServer((req, res) => {
    if (counting) {
      const key = routeOf(req.method, req.url);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const upstream = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers: { ...req.headers, host: target.host } }, (response) => {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${server.address().port}`,
    start() { counts.clear(); counting = true; },
    stop() { counting = false; return Object.fromEntries([...counts].sort((a, b) => b[1] - a[1])); },
    close: () => new Promise((r) => server.close(r)),
  })));
}

async function processMetrics(app) {
  return evaluateMain(app, ({ app: electronApp }) => electronApp.getAppMetrics().map((m) => ({ type: m.type, service: m.serviceName || m.name || "", pid: m.pid, cpu: m.cpu.percentCPUUsage, workingSetKB: m.memory.workingSetSize, privateKB: m.memory.privateBytes || 0 })));
}

async function idleWindow(app, proxy, ms) {
  proxy.start();
  const samples = [];
  const started = Date.now();
  await processMetrics(app); // primes the CPU counters
  while (Date.now() - started < ms) {
    await new Promise((r) => setTimeout(r, Math.min(5000, ms - (Date.now() - started))));
    samples.push(await processMetrics(app));
  }
  const requests = proxy.stop();
  const total = Object.values(requests).reduce((sum, n) => sum + n, 0);
  const last = samples[samples.length - 1];
  const sum = (list, key) => list.reduce((acc, m) => acc + (m[key] || 0), 0);
  const cpuAvg = samples.map((list) => sum(list, "cpu")).reduce((a, b) => a + b, 0) / samples.length;
  return {
    requestsPerMinute: Number((total * 60000 / ms).toFixed(1)),
    requests,
    workingSetMB: Number((sum(last, "workingSetKB") / 1024).toFixed(1)),
    privateMB: Number((sum(last, "privateKB") / 1024).toFixed(1)),
    cpuPercentAvg: Number(cpuAvg.toFixed(2)),
    processes: last.map((m) => `${m.type}${m.service ? `(${m.service})` : ""}:${(m.workingSetKB / 1024).toFixed(0)}MB`),
  };
}

async function launch(userData, env) {
  const launchedAt = Date.now();
  const app = await electron.launch({ args: [`--user-data-dir=${userData}`, "--no-sandbox", appRoot, "--qa-mode"], env, timeout: 90000 });
  await evaluateMain(app, hideWindowsFromDesktop, OFFSCREEN);
  const page = await app.firstWindow();
  await evaluateMain(app, hideWindowsFromDesktop, OFFSCREEN);
  await page.waitForFunction(() => typeof window.showPage === "function", null, { timeout: 90000 });
  const rendererReadyMs = Date.now() - launchedAt;
  await page.waitForFunction(() => {
    const sidebar = document.querySelector(".nav-menu");
    if (sidebar && sidebar.getBoundingClientRect().width > 0) return true;
    return [...document.querySelectorAll("button")].some((b) => /Use this device|Unlock|Sign in/i.test(b.textContent || "") && b.getBoundingClientRect().width > 0);
  }, null, { timeout: 90000 });
  const firstScreenMs = Date.now() - launchedAt;
  // The startup screen has finished and the app shell is shown (the splash
  // runs for at least its minimum duration, whatever is ready earlier).
  await page.waitForFunction(() => typeof startupState !== "undefined" && startupState.finished === true && document.querySelector("[data-startup-screen], .startup-screen")?.hidden !== false, null, { timeout: 90000 }).catch(() => {});
  const shellRevealedMs = Date.now() - launchedAt;
  return { app, page, rendererReadyMs, firstScreenMs, shellRevealedMs };
}

async function setSize(app, page) {
  await evaluateMain(app, ({ BrowserWindow }, { w, h, offscreen }) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (win.isMaximized()) win.unmaximize();
    win.setBounds({ x: offscreen.x, y: offscreen.y, width: w, height: h });
  }, { w: SIZE.width, h: SIZE.height, offscreen: OFFSCREEN });
  await page.waitForTimeout(300);
}

async function round(index) {
  const agent = await startServiceManagedAgent({ initial: "running", extraInstances: ["perf-server-a", "perf-server-b"] });
  const proxy = await startCountingProxy(agent.url);
  const qa = createIsolatedQaEnv("anx-perf-config-");
  const write = (name, value) => fs.writeFileSync(path.join(qa.configDir, name), `${JSON.stringify(value, null, 2)}\n`);
  write("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "unused" });
  write("nodes.json", { schemaVersion: 2, selectedNodeId: "perf", nodes: [{ id: "perf", kind: "agent", name: "Perf Computer", displayName: "Perf Computer", baseUrl: proxy.url, agentUrl: proxy.url, enabled: true }] });
  write("node-agent-credentials.json", { schemaVersion: 1, nodes: { perf: { agentToken: agent.token } } });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "anx-perf-profile-"));
  const env = { ...process.env, ...qa.env, ANXOS_QA_MODE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = { round: index + 1 };
  let app;
  try {
    const cold = await launch(userData, env);
    app = cold.app;
    result.cold = { rendererReadyMs: cold.rendererReadyMs, firstScreenMs: cold.firstScreenMs, shellRevealedMs: cold.shellRevealedMs };
    const page = cold.page;
    const useDevice = page.getByRole("button", { name: "Use this device" }).first();
    if (await useDevice.isVisible().catch(() => false)) await useDevice.click();
    await signInQaOwner(page);
    const skip = page.locator('[data-onboarding-action="skip"]').first();
    if (await skip.isVisible().catch(() => false)) await skip.click();
    await setSize(app, page);
    await page.evaluate(() => window.showPage("dashboard"));
    await page.waitForTimeout(SETTLE_MS);
    result.idleHome = await idleWindow(app, proxy, IDLE_MS);
    await page.evaluate(() => window.showPage("instances"));
    await page.waitForTimeout(5000);
    result.idleServers = await idleWindow(app, proxy, IDLE_MS);
    await app.close();
    app = null;
    const warm = await launch(userData, env);
    app = warm.app;
    result.warm = { rendererReadyMs: warm.rendererReadyMs, firstScreenMs: warm.firstScreenMs, shellRevealedMs: warm.shellRevealedMs };
  } finally {
    if (app) await app.close().catch(() => {});
    await proxy.close().catch(() => {});
    await agent.stop().catch(() => {});
    try { qa.cleanup(); } catch {}
    fs.rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return result;
}

const median = (values) => { const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };

async function main() {
  console.log(`perf: ${label} (${appRoot}), ${rounds} round(s), idle ${IDLE_MS / 1000}s after ${SETTLE_MS / 1000}s settle`);
  const results = [];
  for (let index = 0; index < rounds; index += 1) {
    const r = await round(index);
    results.push(r);
    console.log(`round ${r.round}: cold ${r.cold.rendererReadyMs}/${r.cold.firstScreenMs}/${r.cold.shellRevealedMs} ms, warm ${r.warm.rendererReadyMs}/${r.warm.firstScreenMs}/${r.warm.shellRevealedMs} ms, Home idle ${r.idleHome.workingSetMB} MB ws / ${r.idleHome.privateMB} MB private, ${r.idleHome.cpuPercentAvg}% CPU, ${r.idleHome.requestsPerMinute} req/min; My Servers ${r.idleServers.requestsPerMinute} req/min`);
  }
  const summary = {
    label,
    appRoot,
    measuredAt: new Date().toISOString(),
    rounds,
    idleMs: IDLE_MS,
    medians: {
      coldRendererReadyMs: median(results.map((r) => r.cold.rendererReadyMs)),
      coldFirstScreenMs: median(results.map((r) => r.cold.firstScreenMs)),
      warmRendererReadyMs: median(results.map((r) => r.warm.rendererReadyMs)),
      warmFirstScreenMs: median(results.map((r) => r.warm.firstScreenMs)),
      coldShellRevealedMs: median(results.map((r) => r.cold.shellRevealedMs)),
      warmShellRevealedMs: median(results.map((r) => r.warm.shellRevealedMs)),
      homeWorkingSetMB: median(results.map((r) => r.idleHome.workingSetMB)),
      homePrivateMB: median(results.map((r) => r.idleHome.privateMB)),
      homeCpuPercent: median(results.map((r) => r.idleHome.cpuPercentAvg)),
      homeRequestsPerMinute: median(results.map((r) => r.idleHome.requestsPerMinute)),
      serversRequestsPerMinute: median(results.map((r) => r.idleServers.requestsPerMinute)),
    },
    results,
  };
  console.log(JSON.stringify(summary.medians, null, 2));
  if (args.out) {
    fs.mkdirSync(path.dirname(path.resolve(String(args.out))), { recursive: true });
    fs.writeFileSync(path.resolve(String(args.out)), `${JSON.stringify(summary, null, 2)}\n`);
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
