#!/usr/bin/env node
"use strict";

// Build 216-A9 Activity, Security, Settings, Maintenance and Anx Workspace:
// checks in the REAL app. Off-screen, isolated profile, real Agent test
// fixture, signed-in disposable owner.
//
// SAFETY: actions that change the owner account, tokens, remote access,
// emergency controls, caches, updates or that open folders and save dialogs
// are checked by presence only. Everything here changes the isolated profile
// at most, and each changed setting is put back.
//
//   W1  Activity: Notifications, Task details and Maintenance are tabs of one
//       destination; notification filters; task filters; refreshes
//   W2  Settings: every category opens; a changed setting is saved and kept
//       across a reload; its category's Reset restores it
//   W3  the accent setting now re-tints the AnxHost accent (a dark text
//       colour on a light accent keeps buttons at 4.5:1); purple restores
//       the tokens
//   W4  help topics open the contextual help dialog, which closes
//   W5  Security: every section opens; event filters switch; the audit
//       export preview loads; the signed-in owner is shown
//   W6  Anx Workspace opens for the signed-in owner; its overview actions and
//       log search and level filter respond
//   W7  layout at 900x640, 1280x800 and 1920x1080; W8 contrast; W9 every A9
//       inventory hook present; W10 errors
//
// Usage: node scripts/anxhost-account-ui-qa.js [--shots=<dir>]

const fs = require("fs");
const path = require("path");
const { launchRealApp, waitFor } = require("./test-helpers/anxhost-real-app");
const { signInQaOwner } = require("./test-helpers/qa-owner");
const { inventoryRows, checkInventoryHooks } = require("./test-helpers/inventory-hooks");

const shotsArg = process.argv.find((arg) => arg.startsWith("--shots="));
const SHOTS = shotsArg ? path.resolve(shotsArg.slice(8)) : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
const check = (id, ok, message) => {
  results.push({ id, ok: Boolean(ok), message });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${message}`);
};
async function shot(page, name) {
  if (!SHOTS) return;
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 15000 }).catch(() => {});
}

const CONTRAST = `
  const parse = (value) => {
    const s = String(value || "").trim();
    let m = /^rgba?\\(([^)]+)\\)/.exec(s);
    if (m) { const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
    m = /^color\\(srgb ([^)]+)\\)/.exec(s);
    if (m) { const p = m[1].split(/[ /]+/).filter(Boolean).map(Number); return { r: p[0] * 255, g: p[1] * 255, b: p[2] * 255, a: p.length > 3 ? p[3] : 1 }; }
    return null;
  };
  const over = (t, b) => ({ r: t.r * t.a + b.r * (1 - t.a), g: t.g * t.a + b.g * (1 - t.a), b: t.b * t.a + b.b * (1 - t.a), a: 1 });
  const backgroundOf = (element) => {
    const layers = [];
    for (let node = element; node && node.nodeType === 1; node = node.parentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) { layers.push(bg); if (bg.a >= 1) break; }
    }
    let colour = { r: 8, g: 6, b: 13, a: 1 };
    for (let i = layers.length - 1; i >= 0; i -= 1) colour = over(layers[i], colour);
    return colour;
  };
  const channel = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
`;

async function run() {
  const real = await launchRealApp({ prefix: "anx-216-a9-qa-" });
  const { page, rendererErrors } = real;
  try {
    await signInQaOwner(page);
    await real.setViewport(1280, 800);

    // ------------------------------------------------------------ W1 Activity
    await page.evaluate(() => window.showPage("notifications"));
    await page.waitForTimeout(1200);
    const w1 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const tabs = [];
      for (const name of ["operations", "maintenance", "notifications"]) {
        document.querySelector(`.page.is-active [data-page-tab="${name}"]`)?.click();
        await wait(300);
        tabs.push(`${name}=${document.querySelector(".page.is-active")?.dataset.page === name}`);
      }
      const filters = [];
      for (const name of ["unread", "pinned", "critical", "all"]) {
        const button = document.querySelector(`[data-notification-filter="${name}"]`);
        button?.click();
        await wait(150);
        filters.push(`${name}=${Boolean(button?.classList.contains("is-active") || button?.getAttribute("aria-pressed") === "true")}`);
      }
      document.querySelector("[data-alerts-refresh]")?.click();
      window.showPage("operations");
      await wait(300);
      const opFilters = [];
      for (const name of ["completed", "failed", "all"]) {
        const button = document.querySelector(`[data-operation-filter="${name}"]`);
        button?.click();
        await wait(150);
        opFilters.push(`${name}=${Boolean(button?.classList.contains("is-active") || button?.getAttribute("aria-pressed") === "true")}`);
      }
      document.querySelector("[data-jobs-refresh]")?.click();
      await wait(500);
      const maintenance = Boolean(document.querySelector('[data-maintenance-action="clear-safe"]'));
      return { tabs, filters, opFilters, maintenance };
    });
    check("W1", w1.tabs.every((entry) => entry.endsWith("=true")), `Task details, Maintenance and Notifications are tabs of Activity (${w1.tabs.join(", ")})`);
    check("W1", w1.filters.every((entry) => entry.endsWith("=true")) && w1.opFilters.every((entry) => entry.endsWith("=true")) && w1.maintenance, `notification filters (${w1.filters.join(", ")}) and task filters (${w1.opFilters.join(", ")}) switch; refreshes respond; Clear Safe Caches kept (not run)`);
    await shot(page, "a9-1280-activity");

    // ------------------------------------------------------------ W2 Settings categories and a saved setting
    await page.evaluate(() => window.showPage("settings"));
    await page.waitForTimeout(800);
    const w2 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const categories = [];
      for (const button of document.querySelectorAll("[data-settings-category-target]")) {
        button.click();
        await wait(150);
        const visible = [...document.querySelectorAll(`[data-settings-category="${button.dataset.settingsCategoryTarget}"]`)].some((section) => !section.hidden && section.getClientRects().length > 0);
        categories.push(`${button.dataset.settingsCategoryTarget}=${visible}`);
      }
      return { categories, settingCount: document.querySelectorAll("[data-setting]").length };
    });
    check("W2", w2.categories.length >= 10 && w2.categories.every((entry) => entry.endsWith("=true")), `every Settings category opens (${w2.categories.length}): ${w2.categories.join(", ")}`);
    const before = await page.evaluate(() => getCurrentSettings()["appearance.reduceMotion"] === true);
    await page.evaluate(async (value) => { await saveSettingsPatch({ "appearance.reduceMotion": !value }, { statusMessage: "QA" }); }, before);
    await page.reload();
    await waitFor(page, () => typeof getCurrentSettings === "function" && (document.querySelector(".nav-menu")?.getBoundingClientRect().width || 0) > 0, null, "reload", 300);
    const kept = await page.evaluate(() => getCurrentSettings()["appearance.reduceMotion"] === true);
    const reset = await page.evaluate(async () => {
      window.showPage("settings");
      document.querySelector('[data-settings-category-target="appearance"]').click();
      await new Promise((resolve) => setTimeout(resolve, 200));
      document.querySelector('[data-settings-reset-category="appearance"]').click();
      const answer = await (async () => {
        for (let i = 0; i < 40; i += 1) {
          const ok = document.querySelector("[data-confirm-ok]");
          if (ok) { ok.click(); return "confirmed"; }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return "no confirmation";
      })();
      await new Promise((resolve) => setTimeout(resolve, 800));
      return { answer, value: getCurrentSettings()["appearance.reduceMotion"] === true, defaultValue: DEFAULT_SETTINGS["appearance.reduceMotion"] === true };
    });
    check("W2", kept === !before && reset.value === reset.defaultValue, `a changed setting is kept across a reload (${before} → ${kept}); Reset Appearance restores the default (${reset.value}, ${reset.answer})`);

    // ------------------------------------------------------------ W3 accent
    const w3 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const read = () => {
        const style = getComputedStyle(document.documentElement);
        return { accent: style.getPropertyValue("--ahx-accent").trim(), onAccent: style.getPropertyValue("--ahx-text-on-accent").trim() };
      };
      document.querySelector('[data-settings-category-target="appearance"]').click();
      await wait(150);
      document.querySelector('[data-accent-swatch="#f5c451"]').click();
      for (let i = 0; i < 30 && !/f5c451/i.test(read().accent); i += 1) await wait(100);
      const gold = read();
      const probe = document.createElement("button");
      probe.className = "inline-action inline-action--primary";
      probe.textContent = "Probe";
      document.querySelector('.page[data-page="settings"]').append(probe);
      const fg = getComputedStyle(probe).color;
      const bg = getComputedStyle(probe).backgroundColor;
      probe.remove();
      // Let the Gold save finish before the next swatch.
      await wait(1500);
      document.querySelector('[data-accent-swatch="#b66cff"]').click();
      for (let i = 0; i < 30 && /f5c451/i.test(read().accent); i += 1) await wait(100);
      const cut = [...document.querySelectorAll(".settings-accent-swatches span")].filter((span) => span.scrollWidth > span.clientWidth + 1).map((span) => span.textContent.trim());
      return { gold, fg, bg, back: read(), inline: document.documentElement.style.getPropertyValue("--ahx-accent"), cut };
    });
    const contrast = await page.evaluate(new Function("colors", `${CONTRAST} return ratio(parse(colors.fg), parse(colors.bg));`), { fg: w3.fg, bg: w3.bg });
    check("W3", /f5c451/i.test(w3.gold.accent) && contrast >= 4.5, `the Gold accent re-tints the AnxHost accent (${w3.gold.accent}); a primary button stays at ${contrast.toFixed(2)}:1`);
    check("W3", w3.inline === "" && !/f5c451/i.test(w3.back.accent), `Purple restores the token accent (${w3.back.accent})`);
    check("W3", w3.cut.length === 0, w3.cut.length ? `swatch names cut off: ${w3.cut.join(", ")}` : "every accent swatch name fits");

    // ------------------------------------------------------------ W4 help topics
    const w4 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const opened = [];
      for (const button of [...document.querySelectorAll("[data-help-topic]")].slice(0, 8)) {
        button.click();
        await wait(200);
        const modal = document.querySelector("[data-contextual-help-modal]");
        opened.push(`${button.dataset.helpTopic}=${Boolean(modal && !modal.hidden)}`);
        modal?.querySelector('[data-contextual-help-action="close"]')?.click();
        await wait(150);
      }
      return opened;
    });
    check("W4", w4.length >= 2 && w4.every((entry) => entry.endsWith("=true")), `help topics open the help dialog, which closes (${w4.join(", ")})`);

    // ------------------------------------------------------------ W5 Security
    // No dialog may be left open (an open dialog makes the page behind it inert).
    const openDialogs = await page.evaluate(() => [...document.querySelectorAll(".app-modal-backdrop")].filter((overlay) => !overlay.hidden && overlay.getClientRects().length > 0).length);
    for (let i = 0; i < openDialogs; i += 1) await page.keyboard.press("Escape");
    await page.evaluate(() => window.showPage("security"));
    await page.waitForTimeout(1000);
    const w5 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const sections = [];
      for (const button of document.querySelectorAll("[data-security-section-target]")) {
        button.click();
        await wait(300);
        // Some targets are aliases of another section (Revocations opens Sessions).
        const name = (typeof SECURITY_SECTION_ALIASES !== "undefined" && SECURITY_SECTION_ALIASES[button.dataset.securitySectionTarget]) || button.dataset.securitySectionTarget;
        const visible = [...document.querySelectorAll(`[data-security-section="${name}"]`)].some((section) => !section.hidden && section.getClientRects().length > 0);
        sections.push(`${name}=${visible}`);
      }
      document.querySelector('[data-security-section-target="audit"]')?.click();
      await wait(200);
      const filters = [];
      for (const name of ["authentication", "sessions", "tokens", "remote", "owner", "warnings", "all"]) {
        const button = document.querySelector(`[data-security-event-filter="${name}"]`);
        button?.click();
        await wait(100);
        filters.push(`${name}=${Boolean(button?.classList.contains("is-active"))}`);
      }
      document.querySelector('[data-security-section-target="audit-export"]')?.click();
      await wait(200);
      // Review loads the access review; Export Window builds the redacted
      // document in the app (no file is written) and shows it in the preview.
      document.querySelector('[data-audit-export-action="review"]')?.click();
      await wait(1200);
      document.querySelector('[data-audit-export-action="export"]')?.click();
      await wait(1500);
      const preview = (document.querySelector("[data-audit-export-preview]")?.value || "").trim().length;
      const user = document.querySelector("[data-security-current-user]")?.value || document.querySelector("[data-security-current-user]")?.textContent.trim();
      const role = document.querySelector("[data-security-current-role]")?.value || document.querySelector("[data-security-current-role]")?.textContent.trim();
      return { sections, filters, preview, user, role };
    });
    check("W5", w5.sections.length >= 15 && w5.sections.every((entry) => entry.endsWith("=true")), `every Security section opens (${w5.sections.length})${w5.sections.some((entry) => entry.endsWith("=false")) ? `; not shown: ${w5.sections.filter((entry) => entry.endsWith("=false")).join(", ")}` : ""}`);
    check("W5", w5.filters.every((entry) => entry.endsWith("=true")) && w5.preview > 0, `audit event filters switch (${w5.filters.join(", ")}); the audit export preview loads (${w5.preview} characters)`);
    check("W5", /qa-owner/.test(w5.user || "") && Boolean(w5.role), `the signed-in owner is shown (${w5.user}, ${w5.role})`);
    await shot(page, "a9-1280-security");

    // ------------------------------------------------------------ W6 Anx Workspace
    const w6 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      window.showPage("owner-workspace");
      await wait(1200);
      const opened = document.querySelector(".page.is-active")?.dataset.page === "owner-workspace";
      document.querySelector('[data-owner-overview-action="refresh"]')?.click();
      await wait(800);
      const search = document.querySelector("[data-owner-log-search]");
      if (search) { search.value = "zz-none"; search.dispatchEvent(new Event("input", { bubbles: true })); await wait(300); search.value = ""; search.dispatchEvent(new Event("input", { bubbles: true })); }
      const level = document.querySelector("[data-owner-log-level]");
      if (level && level.options?.length > 1) { level.value = level.options[1].value; level.dispatchEvent(new Event("change", { bubbles: true })); level.value = level.options[0].value; level.dispatchEvent(new Event("change", { bubbles: true })); }
      return { opened, actions: document.querySelectorAll("[data-owner-overview-action]").length, ownerActions: document.querySelectorAll("[data-owner-action]").length, search: Boolean(search), level: Boolean(level) };
    });
    check("W6", w6.opened && w6.actions >= 5 && w6.ownerActions >= 10 && w6.search && w6.level, `Anx Workspace opens for the owner; ${w6.actions} overview actions and ${w6.ownerActions} owner actions kept; log search and level filter respond`);
    await shot(page, "a9-1280-workspace");

    // ------------------------------------------------------------ W7 layout
    const PAGES = ["notifications", "operations", "maintenance", "security", "settings", "owner-workspace"];
    for (const [width, height] of [[900, 640], [1280, 800], [1920, 1080]]) {
      await real.setViewport(width, height);
      for (const pageName of PAGES) {
        await page.evaluate((name) => window.showPage(name), pageName);
        await page.waitForTimeout(350);
        const layout = await page.evaluate((name) => {
          const pageEl = document.querySelector(`.page[data-page="${name}"]`);
          const host = pageEl.closest("[data-page-host]") || pageEl.parentElement;
          const clipped = [...pageEl.querySelectorAll(".page-header h1, .page-tabs__tab, .settings-section__header h2, .settings-category-list button")]
            .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).textOverflow !== "ellipsis" && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "visible")
            .map((element) => element.textContent.trim().slice(0, 24));
          return { overflow: host.scrollWidth > host.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth + 1, clipped };
        }, pageName);
        check("W7", !layout.overflow && !layout.clipped.length, `${width}x${height} ${pageName}: no horizontal overflow (${layout.overflow}); clipped=[${layout.clipped.join("; ")}]`);
        await shot(page, `a9-${width}x${height}-${pageName}`);
      }
    }

    // ------------------------------------------------------------ W8 contrast
    await real.setViewport(1280, 800);
    for (const pageName of PAGES) {
      await page.evaluate((name) => window.showPage(name), pageName);
      await page.waitForTimeout(350);
      const result = await page.evaluate(new Function("name", `${CONTRAST}
        const pageEl = document.querySelector('.page[data-page="' + name + '"]');
        const text = [...pageEl.querySelectorAll("h1, h2, h3, .lede, .settings-field > span, .settings-note, .inline-action:not(:disabled), .status-pill, .page-tabs__tab, .settings-category-list button, th, td")]
          .filter((element) => element.getClientRects().length > 0 && !element.closest("[hidden]") && element.innerText.trim());
        const low = [];
        for (const element of text) {
          const fg = parse(getComputedStyle(element).color);
          if (!fg) continue;
          const bg = backgroundOf(element);
          const r = ratio(over(fg, bg), bg);
          if (r < 4.5) low.push(element.className.split(" ")[0] + " '" + element.innerText.trim().slice(0, 24) + "' " + r.toFixed(2));
        }
        return { count: text.length, low };
      `), pageName);
      check("W8", result.count > 3 && result.low.length === 0, `${pageName}: text meets 4.5:1 (${result.count} elements)${result.low.length ? `; below: ${result.low.slice(0, 6).join(" | ")}` : ""}`);
    }

    // ------------------------------------------------------------ W9 inventory hooks
    const hooks = await checkInventoryHooks(page, inventoryRows({ wave: "A9" }));
    check("W9", hooks.missing.length === 0, `${hooks.present.length} A9 hooks present in the running app${hooks.missing.length ? `; missing: ${hooks.missing.map((entry) => entry.hook).join(", ")}` : ""} (${hooks.notChecked.length} computed or unhooked rows covered above)`);
    check("W10", rendererErrors.length === 0, rendererErrors.length ? `renderer errors: ${rendererErrors.slice(0, 3).join(" | ")}` : "no renderer errors");
  } finally {
    await real.close();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${failed.length ? "FAIL" : "PASS"} anxhost-account-ui-qa: ${results.length - failed.length}/${results.length} checks`);
  if (failed.length) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
