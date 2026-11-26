#!/usr/bin/env node
"use strict";

// Build 216-A10 light theme: acceptance checks in the REAL app. Off-screen,
// isolated profile, real Agent test fixture, signed-in disposable owner.
//
//   T1  Settings > Appearance > Theme offers Dark, Light and System; choosing
//       Light with the real control switches the app and is saved (it is
//       still Light after the window reloads)
//   T2  light: every page and the states below have 0 text under WCAG AA
//       (4.5:1, 3:1 for large text; form values and placeholders included)
//       and 0 surfaces left dark on the light page
//   T3  dark: the same checks, so the bridge to the tokens kept dark readable
//   T4  terminal, console and log windows stay dark in the light theme, and
//       their text stays readable
//   T5  no renderer errors
//   T6  A10 consistency: on every page at 900x640, 1280x800 and 1920x1080 no
//       control is cut off by a panel that hides its overflow (scroll
//       containers excluded: their content can be scrolled to)
//
// States, besides each page's default view: Home's Customize panel, the
// command palette, Create Server, Add Storage, the computer details drawer,
// toasts of each tone, every Settings and Security category, and every
// visible tab of a server's page. The Assistant panel is left out (it needs
// AI help configured); its styling is covered by anxhost-shell-ui-qa.
//
// A text colour is judged against the colours actually painted under it
// (background colours and gradient stops, blended up the tree). Surfaces that
// are dark by design are excluded from the "left dark" count and reported:
// terminals, console and log windows, the code editor, meter fills and
// accent-filled buttons.
//
// Usage: node scripts/anxhost-theme-ui-qa.js [--shots=<dir>] [--verbose]

const fs = require("fs");
const path = require("path");
const { launchRealApp, passLocalSetupGate, waitFor } = require("./test-helpers/anxhost-real-app");
const { signInQaOwner } = require("./test-helpers/qa-owner");

const shotsArg = process.argv.find((arg) => arg.startsWith("--shots="));
const SHOTS = shotsArg ? path.resolve(shotsArg.slice(8)) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const VERBOSE = process.argv.includes("--verbose");

const results = [];
const check = (id, ok, message) => {
  results.push({ id, ok: Boolean(ok), message });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${message}`);
};

// Dark by design: terminal, console and log windows, the code editor, and
// meter fills (the accent gradient or a status colour, a data mark).
const DARK_BY_DESIGN = ".xterm, .console-window, .ssh-terminal-window, .instance-console-viewer, .file-editor-monaco, .monaco-editor, .home-meter__bar > span";

// Runs in the page: counts text below AA and surfaces left dark (light) or
// bright (dark) for the current view.
function measureView({ theme, darkByDesign }) {
  const parse = (value) => {
    const m = String(value).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const channel = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
  // A gradient is approximated by the mean of its colour stops.
  const gradient = (image) => {
    if (!image || image === "none" || !/gradient/.test(image)) return null;
    const stops = (image.match(/rgba?\([^)]+\)/g) || []).map(parse).filter(Boolean);
    if (!stops.length) return null;
    const a = stops.reduce((sum, c) => sum + c.a, 0) / stops.length;
    if (a <= 0.02) return null;
    const mean = (k) => stops.reduce((sum, c) => sum + c[k] * c.a, 0) / (a * stops.length);
    return { r: mean("r"), g: mean("g"), b: mean("b"), a };
  };
  const painted = (element) => {
    const layers = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      const g = gradient(style.backgroundImage);
      if (g) { layers.push(g); if (g.a >= 0.99) break; }
      const c = parse(style.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 0.99) break; }
    }
    let colour = theme === "light" ? { r: 255, g: 255, b: 255, a: 1 } : { r: 0, g: 0, b: 0, a: 1 };
    for (let i = layers.length - 1; i >= 0; i -= 1) colour = over(layers[i], colour);
    return colour;
  };
  const contrast = (fg, bg) => { const f = over(fg, bg); const x = lum(f); const y = lum(bg); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const name = (element) => {
    const one = (node) => `${node.tagName.toLowerCase()}${node.classList.length ? `.${[...node.classList].slice(0, 2).join(".")}` : ""}`;
    let parent = element.parentElement;
    while (parent && !parent.classList.length) parent = parent.parentElement;
    return `${parent ? `${one(parent)} > ` : ""}${one(element)}`;
  };
  const visible = [...document.querySelectorAll("body *")].filter((element) => {
    const r = element.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    const s = getComputedStyle(element);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  });
  const lowText = [];
  const wrongSurfaces = [];
  let texts = 0;
  let surfaces = 0;
  let excluded = 0;
  for (const element of visible) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const bg = parse(style.backgroundColor);
    const g = gradient(style.backgroundImage);
    if (((bg && bg.a >= 0.5) || (g && g.a >= 0.5)) && rect.width * rect.height >= 600) {
      surfaces += 1;
      const accentFill = bg && bg.a >= 0.9 && Math.abs(bg.r - 120) < 30 && bg.g < 80 && bg.b > 150;
      if (element.closest(darkByDesign) || accentFill) excluded += 1;
      else {
        const L = lum(painted(element));
        if ((theme === "light" && L < 0.12) || (theme === "dark" && L > 0.6)) wrongSurfaces.push(`${name(element)} L=${L.toFixed(2)}`);
      }
    }
    if (element.closest(".monaco-editor")) continue;
    const isField = (element.tagName === "INPUT" && !["checkbox", "radio", "range", "color", "hidden", "file", "button", "submit"].includes(element.type)) || element.tagName === "SELECT" || element.tagName === "TEXTAREA";
    if (isField && !element.disabled) {
      const colour = element.value || element.tagName === "SELECT" ? style.color : element.placeholder ? getComputedStyle(element, "::placeholder").color : null;
      const fg = colour && parse(colour);
      if (fg) {
        texts += 1;
        const r = contrast(fg, painted(element));
        if (r < 4.5) lowText.push(`${name(element)} ${element.value ? "value" : "placeholder"} ${r.toFixed(2)}`);
      }
    }
    const ownText = [...element.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
    if (!ownText || ["SCRIPT", "STYLE", "OPTION"].includes(element.tagName)) continue;
    const fg = parse(style.color);
    if (!fg) continue;
    texts += 1;
    const large = parseFloat(style.fontSize) >= 24 || (parseFloat(style.fontSize) >= 18.66 && Number(style.fontWeight) >= 700);
    const r = contrast(fg, painted(element));
    if (!element.closest("[disabled], [aria-disabled='true']") && r < (large ? 3 : 4.5)) lowText.push(`${name(element)} ${r.toFixed(2)} "${element.textContent.trim().slice(0, 24)}"`);
  }
  return { texts, surfaces, excluded, lowText, wrongSurfaces };
}

// Surfaces animate colour changes; measure once transitions are over. This
// used to sleep 900 ms per view (about 70 views per theme); it now waits for
// the finite animations and transitions themselves (spinners run forever and
// are ignored), after a short floor so data a view asks for can arrive.
async function settle(page, floorMs = 300) {
  await page.waitForTimeout(floorMs);
  await page.evaluate(async () => {
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const deadline = Date.now() + 3000;
    await frame();
    while (Date.now() < deadline && document.getAnimations().some((animation) => animation.playState === "running" && Number.isFinite(animation.effect?.getComputedTiming?.().endTime))) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    await frame();
  });
}

async function measureAll(page, theme) {
  const views = {};
  const measure = async (label) => {
    const actual = await page.evaluate(() => document.documentElement.dataset.theme);
    const result = await page.evaluate(measureView, { theme, darkByDesign: DARK_BY_DESIGN });
    views[label] = { ...result, actual };
  };
  const step = async (label, open, arg, closeKey) => {
    try {
      const shown = await page.evaluate(open, arg);
      if (shown === false) { views[label] = { skipped: true }; return; }
      await settle(page);
      await measure(label);
    } catch (error) {
      views[label] = { error: String(error.message || error).slice(0, 200) };
    }
    if (closeKey) await page.keyboard.press(closeKey).catch(() => {});
    await settle(page, 50);
  };
  const pages = await page.evaluate(() => [...document.querySelectorAll("section.page[data-page]")].map((section) => section.dataset.page).filter((pageName) => !["amp", "coolpals"].includes(pageName)));
  for (const pageName of pages) await step(`page:${pageName}`, (n) => { window.showPage(n); return true; }, pageName);
  await step("home-customize", () => { window.showPage("dashboard"); const b = document.querySelector("[data-home-customize-toggle]"); if (!b) return false; if (b.getAttribute("aria-expanded") !== "true") b.click(); return true; });
  await page.evaluate(() => { const b = document.querySelector("[data-home-customize-toggle]"); if (b?.getAttribute("aria-expanded") === "true") b.click(); });
  await step("command-palette", () => { const b = document.querySelector("[data-command-palette-open]"); if (!b) return false; b.click(); return true; }, null, "Escape");
  await step("create-server", () => { window.showPage("marketplace"); enterAddServer("create", { template: { id: "minecraft-paper" } }); return true; });
  await step("add-storage", () => { window.showPage("files"); const b = document.querySelector('[data-storage-action="open"]'); if (!b) return false; b.click(); return true; }, null, "Escape");
  await step("computer-details", () => { window.showPage("nodes"); if (typeof openNodeDetails !== "function") return false; openNodeDetails("qa"); return true; }, null, "Escape");
  for (const tone of ["success", "error", "warning", "info"]) await step(`toast:${tone}`, (t) => { window.showPage("dashboard"); showToast(`Theme check: a ${t} message`, t); return true; }, tone);
  const settingsCategories = await page.evaluate(() => [...document.querySelectorAll("[data-settings-category-target]")].map((b) => b.dataset.settingsCategoryTarget));
  for (const category of settingsCategories) await step(`settings:${category}`, (c) => { window.showPage("settings"); document.querySelector(`[data-settings-category-target="${c}"]`).click(); return true; }, category);
  const securitySections = await page.evaluate(() => [...document.querySelectorAll("[data-security-section-target]")].map((b) => b.dataset.securitySectionTarget));
  for (const section of securitySections) await step(`security:${section}`, (c) => { window.showPage("security"); document.querySelector(`[data-security-section-target="${c}"]`).click(); return true; }, section);
  const serverId = await page.evaluate(() => { window.showPage("instances"); return document.querySelector("[data-instance-id]")?.dataset.instanceId || null; });
  if (serverId) {
    for (const tab of ["overview", "console", "files", "backups", "settings", "players", "performance", "network", "mods"]) {
      await step(`server:${tab}`, async ({ id, tab: target }) => {
        window.showPage("instances");
        if (typeof selectInstance === "function") selectInstance(id);
        await window.AnxServerView.open(id, target);
        const button = document.querySelector(`[data-instance-tab="${target}"]`);
        return Boolean(button && !button.hidden);
      }, { id: serverId, tab });
    }
    await page.evaluate(async () => { if (window.AnxServerView?.isOpen?.()) await window.AnxServerView.close(); });
  }
  return { views, serverId };
}

function summarize(views) {
  const measured = Object.entries(views).filter(([, view]) => view.texts !== undefined);
  const errors = Object.entries(views).filter(([, view]) => view.error).map(([label, view]) => `${label}: ${view.error}`);
  const low = measured.flatMap(([label, view]) => view.lowText.map((entry) => `${label}: ${entry}`));
  const wrong = measured.flatMap(([label, view]) => view.wrongSurfaces.map((entry) => `${label}: ${entry}`));
  const texts = measured.reduce((sum, [, view]) => sum + view.texts, 0);
  const surfaces = measured.reduce((sum, [, view]) => sum + view.surfaces, 0);
  const excluded = measured.reduce((sum, [, view]) => sum + view.excluded, 0);
  const themeDrift = measured.filter(([, view]) => view.actual !== measured[0][1].actual).map(([label]) => label);
  const skipped = Object.entries(views).filter(([, view]) => view.skipped).map(([label]) => label);
  return { measured: measured.length, errors, low, wrong, texts, surfaces, excluded, themeDrift, skipped };
}

async function run() {
  const real = await launchRealApp({ prefix: "anx-216-a10-qa-" });
  const { page, rendererErrors } = real;
  try {
    await signInQaOwner(page);
    await real.setViewport(1280, 800);

    // ------------------------------------------------------------ T1 the setting
    await page.evaluate(() => { window.showPage("settings"); document.querySelector('[data-settings-category-target="appearance"]').click(); });
    await page.waitForTimeout(400);
    const select = page.locator('[data-setting="appearance.theme"]');
    const options = await select.evaluate((element) => [...element.options].map((option) => `${option.value}=${option.textContent.trim()}`).join(", "));
    await select.selectOption("light");
    await waitFor(page, () => document.documentElement.dataset.theme === "light", null, "light theme applied", 50);
    const applied = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.reload();
    await waitFor(page, () => typeof window.showPage === "function", null, "renderer after reload");
    await passLocalSetupGate(page);
    await page.waitForTimeout(1500);
    const afterReload = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, saved: document.querySelector('[data-setting="appearance.theme"]')?.value }));
    if (SHOTS) {
      await page.evaluate(() => window.showPage("dashboard"));
      await settle(page);
      await page.screenshot({ path: path.join(SHOTS, "a10-1280-home-light.png") }).catch(() => {});
    }
    check("T1", options === "dark=Dark, light=Light, system=System" && applied === "light" && afterReload.theme === "light" && afterReload.saved === "light",
      `Theme offers ${options}; choosing Light applies it (${applied}) and it is saved (after reload: ${afterReload.theme}, control ${afterReload.saved})`);

    // ------------------------------------------------------------ T2 light
    const light = await measureAll(page, "light");
    const l = summarize(light.views);
    check("T2", l.measured >= 60 && l.low.length === 0 && l.wrong.length === 0 && l.errors.length === 0 && l.themeDrift.length === 0 && light.serverId,
      `light: ${l.measured} views, ${l.texts} text checks, ${l.surfaces} surfaces (${l.excluded} dark by design); below AA: ${l.low.length}, left dark: ${l.wrong.length}${l.low.length ? `; ${l.low.slice(0, 6).join(" | ")}` : ""}${l.wrong.length ? `; ${l.wrong.slice(0, 6).join(" | ")}` : ""}${l.errors.length ? `; errors: ${l.errors.join(" | ")}` : ""}${l.themeDrift.length ? `; theme changed during: ${l.themeDrift.join(", ")}` : ""} (not shown for this server: ${l.skipped.join(", ") || "none"})`);

    if (VERBOSE) for (const entry of [...l.low, ...l.wrong]) console.log(`  light ${entry}`);
    // ------------------------------------------------------------ T4 dark-by-design windows
    const windows = await page.evaluate(async ({ id }) => {
      const out = {};
      const lumOf = (element) => {
        const m = getComputedStyle(element).backgroundColor.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const [r, g, b] = m[1].split(/[ ,/]+/).map(Number).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      window.showPage("ssh");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const ssh = document.querySelector(".ssh-terminal-window");
      out.ssh = ssh ? lumOf(ssh) : null;
      window.showPage("console");
      await new Promise((resolve) => setTimeout(resolve, 800));
      const consoleWindow = document.querySelector(".console-window");
      out.console = consoleWindow ? lumOf(consoleWindow) : null;
      if (id) {
        window.showPage("instances");
        await window.AnxServerView.open(id, "console");
        await new Promise((resolve) => setTimeout(resolve, 800));
        const viewer = [...document.querySelectorAll(".instance-console-viewer")].find((element) => element.getClientRects().length);
        out.serverConsole = viewer ? lumOf(viewer) : null;
        await window.AnxServerView.close();
      }
      return out;
    }, { id: light.serverId });
    const readableInside = ["page:ssh", "page:console", "server:console"].every((label) => !light.views[label] || (light.views[label].lowText || []).length === 0);
    check("T4", [windows.ssh, windows.console, windows.serverConsole].every((value) => value !== null && value < 0.05) && readableInside,
      `terminal windows stay dark in light (luminance SSH ${windows.ssh?.toFixed(3)}, Console ${windows.console?.toFixed(3)}, server console ${windows.serverConsole?.toFixed(3)}) and their text passes AA`);
    if (SHOTS) {
      for (const pageName of ["backups", "security", "ssh", "nodes"]) {
        await page.evaluate((n) => window.showPage(n), pageName);
        await settle(page);
        await page.screenshot({ path: path.join(SHOTS, `a10-1280-${pageName}-light.png`) }).catch(() => {});
      }
    }

    // ------------------------------------------------------------ T3 dark
    await page.evaluate(async () => { await saveSettingsPatch({ "appearance.theme": "dark" }); });
    await waitFor(page, () => document.documentElement.dataset.theme === "dark", null, "dark theme applied", 50);
    await settle(page);
    const dark = await measureAll(page, "dark");
    const d = summarize(dark.views);
    check("T3", d.measured >= 60 && d.low.length === 0 && d.wrong.length === 0 && d.errors.length === 0 && d.themeDrift.length === 0,
      `dark: ${d.measured} views, ${d.texts} text checks, ${d.surfaces} surfaces; below AA: ${d.low.length}, left bright: ${d.wrong.length}${d.low.length ? `; ${d.low.slice(0, 6).join(" | ")}` : ""}${d.wrong.length ? `; ${d.wrong.slice(0, 6).join(" | ")}` : ""}${d.errors.length ? `; errors: ${d.errors.join(" | ")}` : ""}`);
    if (VERBOSE) for (const entry of [...d.low, ...d.wrong]) console.log(`  dark ${entry}`);
    if (SHOTS) {
      for (const pageName of ["dashboard", "backups", "security", "ssh", "nodes"]) {
        await page.evaluate((n) => window.showPage(n), pageName);
        await settle(page);
        await page.screenshot({ path: path.join(SHOTS, `a10-1280-${pageName === "dashboard" ? "home" : pageName}-dark.png`) }).catch(() => {});
      }
    }

    // ------------------------------------------------------------ T6 controls cut off
    const cutOff = [];
    for (const [width, height] of [[900, 640], [1280, 800], [1920, 1080]]) {
      await real.setViewport(width, height);
      const pageNames = await page.evaluate(() => [...document.querySelectorAll("section.page[data-page]")].map((section) => section.dataset.page).filter((name) => !["amp", "coolpals"].includes(name)));
      for (const pageName of pageNames) {
        await page.evaluate((name) => window.showPage(name), pageName);
        await settle(page, 150);
        const cut = await page.evaluate((name) => {
          const pageEl = document.querySelector(`.page[data-page="${name}"]`);
          return [...pageEl.querySelectorAll("button, label.console-toggle, input, select, a[href]")]
            .filter((element) => element.getClientRects().length > 0 && !element.closest("[hidden]") && getComputedStyle(element).visibility !== "hidden")
            .filter((element) => {
              const box = element.getBoundingClientRect();
              if (box.width < 2 || box.height < 2) return false;
              for (let node = element.parentElement; node && node !== pageEl; node = node.parentElement) {
                const style = getComputedStyle(node);
                if (style.overflowX === "auto" || style.overflowX === "scroll") return false;
                if (style.overflowX === "hidden" || style.overflowX === "clip") {
                  const frame = node.getBoundingClientRect();
                  return box.right > frame.right + 1 || box.left < frame.left - 1;
                }
              }
              return false;
            })
            .map((element) => (element.textContent || element.getAttribute("aria-label") || element.placeholder || element.tagName).trim().replace(/\s+/g, " ").slice(0, 24));
        }, pageName);
        for (const label of cut) cutOff.push(`${width}x${height} ${pageName}: ${label}`);
      }
    }
    await real.setViewport(1280, 800);
    if (VERBOSE) for (const entry of cutOff) console.log(`  cut ${entry}`);
    check("T6", cutOff.length === 0, `no control is cut off by a panel on any page at 900x640, 1280x800 and 1920x1080${cutOff.length ? `; cut off: ${cutOff.slice(0, 8).join(" | ")}` : ""}`);

    check("T5", rendererErrors.length === 0, rendererErrors.length ? `renderer errors: ${rendererErrors.slice(0, 3).join(" | ")}` : "no renderer errors");
  } finally {
    await real.close();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${failed.length ? "FAIL" : "PASS"} anxhost-theme-ui-qa: ${results.length - failed.length}/${results.length} checks`);
  if (failed.length) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
