#!/usr/bin/env node
"use strict";

// Renders the AnxHost CC UI pattern gallery (docs/anxhost/gallery/ui-patterns.html)
// in dark and light with a headless browser (no window opens), and checks WCAG
// contrast of the semantic token pairs in both themes.
//
// Exit code 1 if any text pair is below 4.5:1 or any UI/status pair below 3:1.
// Usage: node scripts/anxhost-gallery-render.js [--no-shots]

const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const root = path.resolve(__dirname, "..");
const gallery = path.join(root, "docs", "anxhost", "gallery", "ui-patterns.html");
const outDir = path.join(root, "docs", "anxhost", "gallery");

// [foreground token, background token, minimum ratio, note]
const PAIRS = [
  ["--ahx-text-primary", "--ahx-bg-content", 4.5, "body text on page"],
  ["--ahx-text-primary", "--ahx-surface-1", 4.5, "body text on card"],
  ["--ahx-text-primary", "--ahx-surface-3", 4.5, "body text in dialog"],
  ["--ahx-text-secondary", "--ahx-bg-content", 4.5, "secondary text on page"],
  ["--ahx-text-secondary", "--ahx-surface-1", 4.5, "secondary text on card"],
  ["--ahx-text-muted", "--ahx-surface-1", 4.5, "muted text on card"],
  ["--ahx-text-muted", "--ahx-bg-sidebar", 4.5, "group labels in sidebar"],
  ["--ahx-text-secondary", "--ahx-bg-sidebar", 4.5, "sidebar items"],
  ["--ahx-text-link", "--ahx-bg-content", 4.5, "links"],
  ["--ahx-accent-text", "--ahx-surface-1", 4.5, "accent text on card"],
  ["--ahx-text-on-accent", "--ahx-accent", 4.5, "primary button label"],
  ["--ahx-danger", "--ahx-surface-1", 4.5, "error text on card"],
  ["--ahx-status-running", "--ahx-surface-1", 3, "status pill"],
  ["--ahx-status-starting", "--ahx-surface-1", 3, "status pill"],
  ["--ahx-status-stopping", "--ahx-surface-1", 3, "status pill"],
  ["--ahx-status-updating", "--ahx-surface-1", 3, "status pill"],
  ["--ahx-status-degraded", "--ahx-surface-1", 3, "status pill"],
  ["--ahx-status-error", "--ahx-surface-1", 3, "status pill"],
  ["--ahx-status-offline", "--ahx-surface-1", 3, "status pill"],
  ["--ahx-status-stopped", "--ahx-surface-1", 3, "status pill"],
  ["--ahx-text-disabled", "--ahx-surface-1", 0, "disabled text (exempt from WCAG; reported only)"],
];

function findBrowser() {
  return [process.env.ANXHOST_BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].filter(Boolean).find((p) => fs.existsSync(p));
}

async function main() {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const results = [];
  let failed = 0;
  for (const theme of ["dark", "light"]) {
    await page.goto(`${pathToFileURL(gallery).href}?theme=${theme}`);
    await page.waitForLoadState("load");
    if (!process.argv.includes("--no-shots")) {
      await page.screenshot({ path: path.join(outDir, `ui-patterns-${theme}.png`), fullPage: true });
    }
    const measured = await page.evaluate((pairs) => {
      const probe = document.createElement("div");
      document.body.appendChild(probe);
      const rgb = (token) => {
        probe.style.color = `var(${token})`;
        const m = getComputedStyle(probe).color.match(/[\d.]+/g).map(Number);
        return m.slice(0, 3);
      };
      const lum = ([r, g, b]) => {
        const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const out = pairs.map(([fg, bg, min, note]) => {
        const a = lum(rgb(fg));
        const b = lum(rgb(bg));
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        return { fg, bg, min, note, ratio: Math.round(ratio * 100) / 100 };
      });
      probe.remove();
      return out;
    }, PAIRS);
    for (const row of measured) {
      const pass = row.ratio >= row.min;
      if (!pass) failed += 1;
      results.push({ theme, ...row, pass });
    }
  }
  await browser.close();
  fs.writeFileSync(path.join(outDir, "contrast-report.json"), `${JSON.stringify(results, null, 2)}\n`);
  for (const r of results) console.log(`${r.pass ? "PASS" : "FAIL"} ${r.theme.padEnd(5)} ${r.ratio.toFixed(2).padStart(5)}:1 (min ${r.min}) ${r.fg} on ${r.bg} — ${r.note}`);
  if (failed) { console.error(`${failed} contrast pair(s) below the minimum`); process.exitCode = 1; }
  else console.log(`PASS contrast: ${results.length} token pairs in dark and light`);
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
