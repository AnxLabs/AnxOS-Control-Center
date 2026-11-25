#!/usr/bin/env node
"use strict";

// Build 216-A7 Networking, Sharing and Public Access: acceptance checks in the
// REAL app for the AnxHost look and the A7 inventory rows no other suite
// covers. Off-screen, isolated profile, real Agent test fixture, signed-in
// disposable owner. Nothing here starts a tunnel or shares a server.
//
//   N1  Sharing ("Share with friends") and Network ("Network & addresses")
//       open as tabs of one destination; tiles and cards on tokens
//   N2  reverse proxy route form: all five fields; an invalid route is refused
//       with a message and nothing is recorded (definitions only; this build
//       writes no proxy configuration)
//   N3  Network: Run Diagnostics shows stages; each stage's action button
//       works (copy details copies; open-network refreshes in place)
//   N4  layout at 900x640, 1280x800 and 1920x1080; N5 contrast; N6 errors
//   N7  every A7 inventory hook is in the running app (presence)
//
// Usage: node scripts/anxhost-network-ui-qa.js [--shots=<dir>]

const fs = require("fs");
const path = require("path");
const { launchRealApp } = require("./test-helpers/anxhost-real-app");
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
  const real = await launchRealApp({ prefix: "anx-216-a7-qa-" });
  const { page, rendererErrors } = real;
  try {
    await signInQaOwner(page);
    await real.setViewport(1280, 800);

    // ------------------------------------------------------------ N1
    await page.evaluate(() => window.showPage("playit"));
    await page.waitForTimeout(2500);
    await shot(page, "a7-1280-sharing");
    const n1 = await page.evaluate(async () => {
      const probe = document.createElement("div");
      probe.style.background = "var(--ahx-surface-1)";
      document.body.append(probe);
      const surface1 = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const tiles = [...document.querySelectorAll(".playit-summary-card")].filter((tile) => tile.getClientRects().length > 0);
      const tab = document.querySelector('.page[data-page="playit"] [data-page-tab="network"]');
      tab?.click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      const network = document.querySelector(".page.is-active")?.dataset.page;
      document.querySelector('.page[data-page="network"] [data-page-tab="playit"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { tiles: tiles.length, onToken: tiles.every((tile) => getComputedStyle(tile).backgroundColor === surface1), network, back: document.querySelector(".page.is-active")?.dataset.page };
    });
    check("N1", n1.tiles > 0 && n1.onToken && n1.network === "network" && n1.back === "playit", `Sharing and Network are tabs of one destination (${n1.network} ⇄ ${n1.back}); ${n1.tiles} tiles on --ahx-surface-1`);

    // ------------------------------------------------------------ N2 reverse proxy route
    const n2 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const form = document.querySelector("[data-public-access-reverse-proxy-form]");
      const fields = ["hostname", "upstreamHost", "upstreamPort", "tlsMode", "pathPrefix"].filter((name) => form.querySelector(`[data-public-access-reverse-proxy-field="${name}"]`));
      const listBefore = document.querySelector("[data-public-access-reverse-proxy-list]")?.children.length || 0;
      form.querySelector('[data-public-access-reverse-proxy-field="hostname"]').value = "not a hostname!";
      form.querySelector('[data-public-access-reverse-proxy-field="upstreamPort"]').value = "70000";
      const toasts = [];
      const toast = showToast;
      window.showToast = (message, tone) => { toasts.push(String(message)); return toast(message, tone); };
      form.querySelector("[data-public-access-reverse-proxy-apply]").click();
      await wait(1500);
      window.showToast = toast;
      const notice = document.querySelector("[data-public-access-reverse-proxy-notice]")?.textContent.trim() || "";
      const invalid = [...form.querySelectorAll("[aria-invalid='true']")].length;
      return { fields, refused: notice || toasts.join(" | ") || (invalid ? `${invalid} field(s) marked invalid` : ""), listBefore, listAfter: document.querySelector("[data-public-access-reverse-proxy-list]")?.children.length || 0 };
    });
    check("N2", n2.fields.length === 5, `the reverse proxy form keeps its five fields (${n2.fields.join(", ")})`);
    check("N2", Boolean(n2.refused) && n2.listAfter === n2.listBefore, `an invalid route is refused ("${String(n2.refused).slice(0, 120)}") and nothing is recorded (${n2.listBefore} → ${n2.listAfter})`);

    // ------------------------------------------------------------ N3 diagnostics stages
    await page.evaluate(() => window.showPage("network"));
    await page.waitForTimeout(1500);
    const n3 = await page.evaluate(async () => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      document.querySelector('[data-network-action="run-diagnostics"]').click();
      for (let i = 0; i < 100 && !document.querySelector("[data-stage-id]"); i += 1) await wait(150);
      // Stage actions appear only on a stage that needs a fix, and every
      // stage passes against the test Agent. One real stage is given the
      // remediation a failing stage carries and drawn by the app's own
      // renderer, so the real buttons and handlers are exercised.
      let synthetic = false;
      if (!document.querySelector("[data-stage-action]") && networkState?.diagnostics?.stages?.length) {
        const stages = networkState.diagnostics.stages.map((stage, index) => (index === 0 ? { ...stage, remediation: [{ kind: "copy-details", label: "Copy details" }, { kind: "open-network", label: "Check again" }] } : stage));
        networkState.diagnostics = { ...networkState.diagnostics, stages };
        renderNetworkDiagnostics(networkState.diagnostics);
        synthetic = true;
        await wait(200);
      }
      const actions = [...new Set([...document.querySelectorAll("[data-stage-action]")].map((button) => button.dataset.stageAction))];
      const copied = [];
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (text) => { copied.push(String(text).length); };
      const copy = document.querySelector('[data-stage-action="copy-details"]');
      copy?.click();
      await wait(400);
      navigator.clipboard.writeText = original;
      const refresh = document.querySelector('[data-stage-action="open-network"]');
      refresh?.click();
      await wait(800);
      return { actions, synthetic, copied: copied.length, stages: document.querySelectorAll("[data-stage-id]").length, page: document.querySelector(".page.is-active")?.dataset.page, hadCopy: Boolean(copy), hadRefresh: Boolean(refresh) };
    });
    check("N3", n3.stages > 0 && n3.actions.length > 0, `Run Diagnostics shows ${n3.stages} stages; stage actions render (${n3.actions.join(", ")}${n3.synthetic ? "; every stage passed, so one was given a fix to show its actions" : ""})`);
    check("N3", n3.hadCopy && n3.copied === 1 && n3.hadRefresh && n3.page === "network", `stage actions work: copy details copied=${n3.copied}${n3.hadRefresh ? ", open-network refreshes in place" : ""}`);
    await shot(page, "a7-1280-network");

    // ------------------------------------------------------------ N4 layout
    for (const [width, height] of [[900, 640], [1280, 800], [1920, 1080]]) {
      await real.setViewport(width, height);
      for (const pageName of ["playit", "network"]) {
        await page.evaluate((name) => window.showPage(name), pageName);
        await page.waitForTimeout(500);
        const layout = await page.evaluate((name) => {
          const pageEl = document.querySelector(`.page[data-page="${name}"]`);
          const host = pageEl.closest("[data-page-host]") || pageEl.parentElement;
          const clipped = [...pageEl.querySelectorAll(".page-header h1, .page-tabs__tab, .settings-section__header h2, .status-card__top strong")]
            .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).textOverflow !== "ellipsis" && element.scrollWidth > element.clientWidth + 1 && getComputedStyle(element).overflowX !== "visible")
            .map((element) => element.textContent.trim().slice(0, 24));
          return { overflow: host.scrollWidth > host.clientWidth + 1 || document.documentElement.scrollWidth > window.innerWidth + 1, clipped };
        }, pageName);
        check("N4", !layout.overflow && !layout.clipped.length, `${width}x${height} ${pageName}: no horizontal overflow (${layout.overflow}); clipped=[${layout.clipped.join("; ")}]`);
        await shot(page, `a7-${width}x${height}-${pageName}`);
      }
    }

    // ------------------------------------------------------------ N5 contrast
    await real.setViewport(1280, 800);
    for (const pageName of ["playit", "network"]) {
      await page.evaluate((name) => window.showPage(name), pageName);
      await page.waitForTimeout(500);
      const contrast = await page.evaluate(new Function("name", `${CONTRAST}
        const pageEl = document.querySelector('.page[data-page="' + name + '"]');
        const text = [...pageEl.querySelectorAll("h1, h2, h3, .lede, p, .settings-field > span, .inline-action:not(:disabled), .status-pill, .page-tabs__tab")]
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
      check("N5", contrast.count > 10 && contrast.low.length === 0, `${pageName}: text meets 4.5:1 (${contrast.count} elements)${contrast.low.length ? `; below: ${contrast.low.slice(0, 6).join(" | ")}` : ""}`);
    }
    const hooks = await checkInventoryHooks(page, inventoryRows({ wave: "A7" }));
    check("N7", hooks.missing.length === 0, `${hooks.present.length} A7 hooks present in the running app${hooks.missing.length ? `; missing: ${hooks.missing.map((entry) => entry.hook).join(", ")}` : ""} (${hooks.notChecked.length} computed rows covered above)`);
    check("N6", rendererErrors.length === 0, rendererErrors.length ? `renderer errors: ${rendererErrors.slice(0, 3).join(" | ")}` : "no renderer errors");
  } finally {
    await real.close();
  }
  const failed = results.filter((result) => !result.ok);
  console.log(`\n${failed.length ? "FAIL" : "PASS"} anxhost-network-ui-qa: ${results.length - failed.length}/${results.length} checks`);
  if (failed.length) process.exitCode = 1;
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
