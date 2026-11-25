#!/usr/bin/env node
"use strict";

// Build 216-B: writes the website's brand assets from the approved AnxHost
// brand set (docs/anxhost/brand, LOGO_STANDARD.md), so they stay reproducible:
//
//   website/assets/favicon.svg          small icon (16-32 px use)
//   website/assets/favicon-16.png, -32  small icon PNGs
//   website/favicon.ico                 16, 32 and 48 px
//   website/assets/anxhost-logo.png     header mark (28 px shown, 64 px file)
//   website/assets/apple-touch-icon.png Option B touch icon, 180 px
//   website/assets/icon-192.png, -512   Option B touch icons
//   website/assets/social-preview.png   1200x630, Option A lockup (large branding)
//
// Usage: node scripts/anxhost-website-assets.js

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BRAND = path.join(ROOT, "docs", "anxhost", "brand");
const SITE = path.join(ROOT, "website");
const ASSETS = path.join(SITE, "assets");

const copy = (from, to) => fs.copyFileSync(path.join(BRAND, from), path.join(ASSETS, to));

function ico(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = 6 + 16 * pngs.length;
  const entries = pngs.map(({ size, data }) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += data.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...pngs.map((png) => png.data)]);
}

async function main() {
  copy("svg/anxhost-icon-small.svg", "favicon.svg");
  copy("png/favicon/anxhost-favicon-16.png", "favicon-16.png");
  copy("png/favicon/anxhost-favicon-32.png", "favicon-32.png");
  copy("png/touch/anxhost-touch-180.png", "apple-touch-icon.png");
  copy("png/touch/anxhost-touch-192.png", "icon-192.png");
  copy("png/touch/anxhost-touch-512.png", "icon-512.png");
  fs.writeFileSync(path.join(SITE, "favicon.ico"), ico([16, 32, 48].map((size) => ({
    size,
    data: fs.readFileSync(path.join(BRAND, "png", "favicon", `anxhost-favicon-${size}.png`)),
  }))));

  const { chromium } = require("playwright-core");
  const exe = [process.env.ANXHOST_BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].filter(Boolean).find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    const small = fs.readFileSync(path.join(BRAND, "svg", "anxhost-icon-small.svg"), "utf8").replace(/<\?xml[^>]*>/, "");
    await page.setViewportSize({ width: 64, height: 64 });
    await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:64px;height:64px}</style>${small}`);
    await page.screenshot({ path: path.join(ASSETS, "anxhost-logo.png"), omitBackground: true, clip: { x: 0, y: 0, width: 64, height: 64 } });

    const lockup = fs.readFileSync(path.join(BRAND, "svg", "anxhost-lockup-option-a-dark.svg"), "utf8").replace(/<\?xml[^>]*>/, "");
    await page.setViewportSize({ width: 1200, height: 630 });
    await page.setContent(`<!doctype html><style>
      html,body{margin:0;width:1200px;height:630px;overflow:hidden}
      body{display:grid;place-items:center;background:radial-gradient(circle at 78% 82%,rgba(140,62,230,.32),transparent 46%),linear-gradient(160deg,#2a1450 0%,#181521 55%,#0e0b14 100%);font-family:"Segoe UI",system-ui,sans-serif;color:#f7f6fa}
      .wrap{display:grid;justify-items:center;gap:26px}
      .wrap svg{width:760px;height:auto;display:block}
      p{margin:0;font-size:30px;color:#c3c0cf;letter-spacing:.2px}
      small{position:absolute;bottom:28px;font-size:18px;color:#9d98ad}
    </style><div class="wrap">${lockup}<p>Your hardware. One control center.</p></div><small>formerly AnxOS Control Center</small>`);
    await page.screenshot({ path: path.join(ASSETS, "social-preview.png"), clip: { x: 0, y: 0, width: 1200, height: 630 } });
  } finally {
    await browser.close();
  }
  // Link previews cache by URL, so the pages carry a content hash.
  const previewHash = crypto.createHash("sha256").update(fs.readFileSync(path.join(ASSETS, "social-preview.png"))).digest("hex").slice(0, 12);
  for (const page of ["index.html", "release-notes.html"]) {
    const file = path.join(SITE, page);
    const source = fs.readFileSync(file, "utf8");
    fs.writeFileSync(file, source.replace(/assets\/social-preview\.png(?:\?v=[a-f0-9]+)?/g, `assets/social-preview.png?v=${previewHash}`));
  }
  console.log(`Wrote the AnxHost website icons, header mark and social preview (v=${previewHash}).`);
}

main().catch((error) => { console.error(error); process.exit(1); });
