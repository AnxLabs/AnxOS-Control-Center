#!/usr/bin/env node
"use strict";

// Build 216-0 logo and icon set for AnxHost CC. The owner approved the split
// strategy on 2026-11-20 (Option A for large brand moments, Option B for
// icons from 48 px, the small icon at 16-32 px); see LOGO_STANDARD.md.
//
// Draws original vector artwork from the approved-direction concept
// (A:\AnxLabs\40-Assets\Brand\anxhost-logo\): a hexagon with the AH monogram,
// a three-unit server rack, an orbit with nodes and a bottom connector node.
// The wordmark is original monoline geometric lettering drawn as SVG strokes,
// so it needs no font file and carries no font licence.
//
// Writes SVGs, PNG sizes, an .ico and a review sheet to docs/anxhost/brand/.
// Production assets (assets/icon.ico, src/assets/*, website/*) are NOT touched.
// PNGs are rendered with Playwright in a headless browser (no window opens).
//
// Usage: node scripts/anxhost-brand-build.js [--no-png]

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const OUT = path.join(root, "docs", "anxhost", "brand");

const C = {
  violet300: "#bf96ff", violet400: "#a46af5", violet500: "#8c3ee6", violet600: "#7818c0",
  violet700: "#6010a0", violet800: "#4a0d80", violet900: "#300058",
  inkDark: "#1e1e26", inkLight: "#f7f6fa", white: "#ffffff",
};

const n = (v) => Number(v.toFixed(2));

// ---------------------------------------------------------------- monoline lettering
// Glyph coordinates: cap height 0..100, x-height 28..100, baseline 100, y down.
// Each glyph: (w) => { width, d } where d is a centreline path drawn with stroke w.
function arcPoint(cx, cy, r, deg) {
  const a = (deg * Math.PI) / 180;
  return [n(cx + r * Math.cos(a)), n(cy + r * Math.sin(a))];
}
const GLYPHS = {
  A: (w) => { const h = w / 2; return { width: 86, d: `M${n(h * 0.6)} 100 L43 ${n(h * 0.9)} L${n(86 - h * 0.6)} 100 M${n(19 + h * 0.2)} 70 H${n(67 - h * 0.2)}` }; },
  H: (w) => { const h = w / 2; return { width: 74, d: `M${h} 0 V100 M${74 - h} 0 V100 M${h} 52 H${74 - h}` }; },
  C: (w) => { const h = w / 2; const r = 50 - h; const [x1, y1] = arcPoint(50, 50, r, -42); const [x2, y2] = arcPoint(50, 50, r, 42); return { width: 88, d: `M${x1} ${y1} A${n(r)} ${n(r)} 0 1 0 ${x2} ${y2}` }; },
  n: (w) => { const h = w / 2; const top = 28 + h; return { width: 58, d: `M${h} 100 V${top - h} M${h} ${top + 22} C${h} ${top + 6} ${h + 12} ${top} ${29} ${top} C${46} ${top} ${58 - h} ${top + 8} ${58 - h} ${top + 24} V100` }; },
  x: (w) => { const h = w / 2; return { width: 60, d: `M${n(h * 0.7)} 28 L${n(60 - h * 0.7)} 100 M${n(60 - h * 0.7)} 28 L${n(h * 0.7)} 100` }; },
  o: (w) => { const h = w / 2; const r = 36 - h; return { width: 72, d: `M${36 - r} 64 A${r} ${r} 0 1 0 ${36 + r} 64 A${r} ${r} 0 1 0 ${36 - r} 64 Z` }; },
  s: (w) => { const h = w / 2; const t = 28 + h; const b = 100 - h; return { width: 54, d: `M${n(52 - h * 0.6)} ${t + 9} C${48} ${t + 2} ${40} ${t} ${28} ${t} C${15} ${t} ${h + 2} ${t + 6} ${h + 2} ${t + 16} C${h + 2} ${t + 28} ${15} ${n((t + b) / 2 - 2)} ${27} ${n((t + b) / 2)} C${41} ${n((t + b) / 2 + 3)} ${54 - h - 1} ${b - 18} ${54 - h - 1} ${b - 13} C${54 - h - 1} ${b - 3} ${42} ${b} ${28} ${b} C${16} ${b} ${8} ${b - 4} ${n(h * 0.5)} ${b - 11}` }; },
  t: (w) => { const h = w / 2; return { width: 42, d: `M${12 + h} 8 V${100 - h - 16} C${12 + h} ${100 - h - 4} ${20 + h} ${100 - h} ${34 + h} ${100 - h} M0 ${28 + h} H${38 + h}` }; },
  r: (w) => { const h = w / 2; const top = 28 + h; return { width: 46, d: `M${h} 100 V${top - h} M${h} ${top + 24} C${h} ${top + 8} ${h + 14} ${top} ${32} ${top} H${46}` }; },
  l: (w) => { const h = w / 2; return { width: w + 2, d: `M${h + 1} 0 V100` }; },
  e: (w) => { const h = w / 2; const r = 36 - h; const [x2, y2] = arcPoint(36, 64, r, 42); return { width: 72, d: `M${36 - r} 64 H${36 + r} A${r} ${r} 0 1 0 ${x2} ${y2}` }; },
  " ": () => ({ width: 36, d: "" }),
};

// Returns { width, body } for a word; colourFn(index) gives each glyph's stroke.
function word(text, { weight, tracking, stroke }) {
  let x = 0;
  const parts = [];
  [...text].forEach((ch, i) => {
    const glyph = GLYPHS[ch](weight);
    if (glyph.d) parts.push(`<path d="${glyph.d}" transform="translate(${n(x)} 0)" stroke="${stroke(i, ch)}"/>`);
    x += glyph.width + tracking;
  });
  return { width: n(x - tracking), body: `<g fill="none" stroke-width="${weight}" stroke-linecap="butt" stroke-linejoin="miter" stroke-miterlimit="10">${parts.join("")}</g>` };
}

// ---------------------------------------------------------------- mark geometry (256 x 256)
const HEX = [[128, 14], [226, 70], [226, 186], [128, 242], [30, 186], [30, 70]];
const hexPath = (pts) => `M${pts.map(([x, y]) => `${x} ${y}`).join(" L")} Z`;
function insetHex(d) {
  return HEX.map(([x, y]) => [n(128 + (x - 128) * (1 - d)), n(128 + (y - 128) * (1 - d))]);
}

function gradients(id) {
  return `<defs>
    <linearGradient id="${id}-hex" x1="40" y1="20" x2="210" y2="240" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${C.violet500}"/><stop offset="0.55" stop-color="${C.violet700}"/><stop offset="1" stop-color="${C.violet900}"/></linearGradient>
    <linearGradient id="${id}-accent" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.violet400}"/><stop offset="1" stop-color="${C.violet700}"/></linearGradient>
    <linearGradient id="${id}-word" x1="0" y1="0" x2="0" y2="100" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${C.violet500}"/><stop offset="1" stop-color="${C.violet800}"/></linearGradient>
  </defs>`;
}

// Option A: faithful to the concept.
function markA(id, ink) {
  const rack = [146, 170, 194].map((y) => `<rect x="98" y="${y}" width="82" height="18" rx="5" fill="${ink}"/>${[150, 161, 172].map((cx) => `<circle cx="${cx}" cy="${y + 9}" r="3.2" fill="${C.violet500}"/>`).join("")}`).join("");
  return `${gradients(id)}
  <path d="M188 58 L226 80 V186 L128 242 L30 186 V70 L128 14 L158 31" fill="none" stroke="url(#${id}-hex)" stroke-width="15" stroke-linejoin="round"/>
  <ellipse cx="128" cy="132" rx="118" ry="30" transform="rotate(-14 128 132)" fill="none" stroke="${C.violet600}" stroke-width="6" stroke-dasharray="250 46 160 400" stroke-dashoffset="-20"/>
  <path d="M62 182 L104 64 L128 128" fill="none" stroke="${ink}" stroke-width="22" stroke-linejoin="miter"/>
  <path d="M80 140 H112" stroke="${ink}" stroke-width="14"/>
  <path d="M146 66 V140 M190 30 V140 M146 100 H190" fill="none" stroke="url(#${id}-hex)" stroke-width="22"/>
  ${rack}
  <path d="M139 212 V228" stroke="${ink}" stroke-width="5"/>
  <circle cx="139" cy="234" r="10" fill="${C.white}" stroke="${C.violet600}" stroke-width="6"/>
  <circle cx="22" cy="164" r="8" fill="${C.white}" stroke="${C.violet600}" stroke-width="5"/>
  <circle cx="232" cy="102" r="8" fill="${C.white}" stroke="${C.violet600}" stroke-width="5"/>`;
}

// Silhouette rim for icon-size marks. The deep fill (#6010a0 to #300058) is
// about 1.6:1 against a dark Windows taskbar (#202020), so the hexagon melted
// into it. A rim colour must reach 3:1 (WCAG non-text contrast) against both
// a dark and a light taskbar; violet400 only just does on light (3.2:1), so
// anti-aliased edges fell below. #9854ee, halfway between violet400 and
// violet500, balances both: 3.75:1 on #202020, 3.91:1 on #f3f3f3, white on
// it 4.34:1. The width is in mark units (256 = icon size): the small icon uses
// 24 (1.5 px at 16 px; a 1 px rim blurred into the fill at 16 px), Option B
// 10 (about 2 px at 48 px). Checked by scripts/anxhost-brand-assets-smoke.js.
const RIM = "#9854ee";
const rim = (width) => `<path d="${hexPath(HEX)}" fill="none" stroke="${RIM}" stroke-width="${width}" stroke-linejoin="round"/>`;

// Option B: modern filled hexagon, same monogram and rack, no orbit.
function markB(id) {
  const ink = C.white;
  const rack = [150, 172, 194].map((y) => `<rect x="100" y="${y}" width="74" height="15" rx="4.5" fill="${ink}" fill-opacity="0.95"/>${[150, 160, 170].map((cx) => `<circle cx="${cx - 4}" cy="${y + 7.5}" r="2.8" fill="${C.violet700}"/>`).join("")}`).join("");
  return `${gradients(id)}
  <path d="${hexPath(HEX)}" fill="url(#${id}-hex)" stroke-linejoin="round"/>
  ${rim(10)}
  <path d="${hexPath(insetHex(0.075))}" fill="none" stroke="${C.white}" stroke-opacity="0.18" stroke-width="3"/>
  <path d="M66 176 L104 70 L126 128" fill="none" stroke="${ink}" stroke-width="21"/>
  <path d="M82 140 H112" stroke="${ink}" stroke-width="13"/>
  <path d="M146 72 V136 M188 50 V136 M146 102 H188" fill="none" stroke="${ink}" stroke-width="21"/>
  ${rack}
  <circle cx="128" cy="226" r="9" fill="${C.white}" stroke="${C.violet400}" stroke-width="4"/>`;
}

// Small icon (16-32 px): hexagon and rack only; letters and orbit are dropped.
function markSmall(id) {
  return `${gradients(id)}
  <path d="${hexPath(HEX)}" fill="url(#${id}-hex)"/>
  ${rim(24)}
  <rect x="70" y="74" width="116" height="28" rx="8" fill="${C.white}"/>
  <rect x="70" y="114" width="116" height="28" rx="8" fill="${C.white}"/>
  <rect x="70" y="154" width="116" height="28" rx="8" fill="${C.white}"/>
  <circle cx="160" cy="88" r="6" fill="${C.violet700}"/><circle cx="160" cy="128" r="6" fill="${C.violet700}"/><circle cx="160" cy="168" r="6" fill="${C.violet700}"/>`;
}

const svg = (w, h, body, extra = "") => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}"${extra}>\n${body}\n</svg>\n`;

function wordmark(id, theme, withTagline) {
  const ink = theme === "dark" ? C.inkLight : C.inkDark;
  const anx = word("Anx", { weight: 18, tracking: 6, stroke: () => ink });
  const host = word("Host", { weight: 18, tracking: 6, stroke: () => `url(#${id}-word)` });
  const gap = 6;
  const width = anx.width + gap + host.width;
  let body = `${gradients(id)}<g transform="translate(9 9)">${anx.body}<g transform="translate(${n(anx.width + gap)} 0)">${host.body}</g></g>`;
  let height = 118;
  if (withTagline) {
    const tag = word("Control Center", { weight: 9, tracking: 5, stroke: () => ink });
    const scale = 0.38;
    const tagW = tag.width * scale;
    const total = width;
    const x = (total - tagW) / 2 + 9;
    const lineY = 150 + 50 * scale;
    body += `<g transform="translate(${n(x)} 150) scale(${scale})">${tag.body}</g>`;
    body += `<path d="M9 ${n(lineY)} H${n(x - 14)} M${n(x + tagW + 14)} ${n(lineY)} H${n(total + 9)}" stroke="${C.violet600}" stroke-width="6" stroke-linecap="round"/>`;
    height = 150 + 100 * scale + 8;
  }
  return { width: width + 18, height, body };
}

function lockup(id, theme, option) {
  const ink = theme === "dark" ? C.inkLight : C.inkDark;
  const mark = option === "a" ? markA(`${id}-m`, ink) : markB(`${id}-m`);
  const wm = wordmark(`${id}-w`, theme, true);
  const markSize = 256;
  const scale = (markSize * 0.82) / wm.height;
  const width = markSize + 28 + wm.width * scale;
  return svg(width, markSize, `<g>${mark}</g><g transform="translate(${markSize + 28} ${n((markSize - wm.height * scale) / 2)}) scale(${n(scale)})">${wm.body}</g>`);
}

const FILES = {};
function build() {
  FILES["anxhost-mark-option-a-dark.svg"] = svg(256, 256, markA("ad", C.inkLight));
  FILES["anxhost-mark-option-a-light.svg"] = svg(256, 256, markA("al", C.inkDark));
  FILES["anxhost-mark-option-b.svg"] = svg(256, 256, markB("b"));
  FILES["anxhost-icon-small.svg"] = svg(256, 256, markSmall("s"));
  for (const theme of ["dark", "light"]) {
    const plain = wordmark(`w${theme}`, theme, false);
    FILES[`anxhost-wordmark-${theme}.svg`] = svg(plain.width, plain.height, plain.body);
    const tag = wordmark(`t${theme}`, theme, true);
    FILES[`anxhost-wordmark-tagline-${theme}.svg`] = svg(tag.width, tag.height, tag.body);
    FILES[`anxhost-lockup-option-a-${theme}.svg`] = lockup(`la${theme}`, theme, "a");
    FILES[`anxhost-lockup-option-b-${theme}.svg`] = lockup(`lb${theme}`, theme, "b");
  }
  fs.mkdirSync(path.join(OUT, "svg"), { recursive: true });
  for (const [name, text] of Object.entries(FILES)) fs.writeFileSync(path.join(OUT, "svg", name), text);
}

// ---------------------------------------------------------------- PNG, ICO and review sheet
const ICON_SIZES = [16, 20, 24, 32, 48, 64, 128, 256, 512, 1024];
const TRAY_SIZES = [16, 20, 24, 32];
const TOUCH_SIZES = [180, 192, 512];

function icoFromPngs(pngs) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngs.length, 4);
  const entries = [];
  let offset = 6 + 16 * pngs.length;
  for (const { size, data } of pngs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); e.writeUInt8(0, 3); e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
  }
  return Buffer.concat([header, ...entries, ...pngs.map((p) => p.data)]);
}

function findBrowser() {
  const candidates = [process.env.ANXHOST_BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

async function renderPngs() {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const shot = async (svgText, size, file, background = "transparent", pad = 0) => {
    const inner = size - pad * 2;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<html><body style="margin:0;background:${background}"><div style="width:${size}px;height:${size}px;display:grid;place-items:center"><div style="width:${inner}px;height:${inner}px">${svgText.replace(/width="[\d.]+" height="[\d.]+"/, 'width="100%" height="100%"')}</div></div></body></html>`);
    const buffer = await page.screenshot({ omitBackground: background === "transparent", clip: { x: 0, y: 0, width: size, height: size } });
    if (file) fs.writeFileSync(file, buffer);
    return buffer;
  };
  const dir = (name) => { const p = path.join(OUT, "png", name); fs.mkdirSync(p, { recursive: true }); return p; };
  // App icon set: small icon up to 32 px, option B from 48 px.
  const icoParts = [];
  for (const size of ICON_SIZES) {
    const source = size <= 32 ? FILES["anxhost-icon-small.svg"] : FILES["anxhost-mark-option-b.svg"];
    const buffer = await shot(source, size, path.join(dir("app-icon"), `anxhost-app-icon-${size}.png`));
    if ([16, 20, 24, 32, 48, 64, 256].includes(size)) icoParts.push({ size, data: buffer });
  }
  fs.writeFileSync(path.join(OUT, "png", "app-icon", "anxhost-app-icon.ico"), icoFromPngs(icoParts));
  for (const size of TRAY_SIZES) await shot(FILES["anxhost-icon-small.svg"], size, path.join(dir("tray"), `anxhost-tray-${size}.png`));
  for (const size of [16, 32, 48]) await shot(FILES["anxhost-icon-small.svg"], size, path.join(dir("favicon"), `anxhost-favicon-${size}.png`));
  for (const size of TOUCH_SIZES) await shot(FILES["anxhost-mark-option-b.svg"], size, path.join(dir("touch"), `anxhost-touch-${size}.png`), "#08060d", Math.round(size * 0.1));
  await shot(FILES["anxhost-mark-option-a-dark.svg"], 512, path.join(dir("marks"), "anxhost-mark-option-a-dark-512.png"));
  await shot(FILES["anxhost-mark-option-a-light.svg"], 512, path.join(dir("marks"), "anxhost-mark-option-a-light-512.png"));
  await shot(FILES["anxhost-mark-option-b.svg"], 512, path.join(dir("marks"), "anxhost-mark-option-b-512.png"));

  // Review sheet.
  const tile = (name, bg, w) => `<figure style="margin:0;padding:20px;background:${bg};border-radius:12px;display:flex;flex-direction:column;gap:10px;align-items:center;justify-content:center"><div style="width:${w}px">${FILES[name].replace(/width="[\d.]+" height="[\d.]+"/, 'width="100%" height="auto"')}</div><figcaption style="font:12px Segoe UI;color:${bg === "#08060d" || bg === "#15131d" ? "#c3c0cf" : "#3a374c"}">${name}</figcaption></figure>`;
  const sizes = (name, bg) => `<div style="display:flex;gap:18px;align-items:flex-end;padding:18px;background:${bg};border-radius:12px">${[16, 20, 24, 32, 48, 64].map((s) => `<div style="text-align:center;font:11px Segoe UI;color:${bg === "#08060d" ? "#9c98ab" : "#57536b"}"><div style="width:${s}px;height:${s}px;margin:auto">${FILES[s <= 32 ? "anxhost-icon-small.svg" : name].replace(/width="[\d.]+" height="[\d.]+"/, `width="${s}" height="${s}"`)}</div>${s}px</div>`).join("")}</div>`;
  const sheet = `<html><body style="margin:0;padding:28px;background:#0e0c14;font-family:Segoe UI;color:#eeedf3;width:1500px">
  <h1 style="margin:0 0 4px;font-size:26px">AnxHost CC — logo and icon set (Build 216-0, approved split)</h1>
  <p style="margin:0 0 20px;color:#9c98ab">Drawn from the approved-direction concept. Split strategy approved by the owner (2026-11-20); production assets are unchanged. Option A keeps the concept's orbit and open hexagon; Option B is a filled hexagon for app icons and small surfaces; the small icon is used at 16-32 px.</p>
  <h2 style="font-size:16px">Lockups</h2>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">${tile("anxhost-lockup-option-a-dark.svg", "#08060d", 640)}${tile("anxhost-lockup-option-a-light.svg", "#f7f6fa", 640)}${tile("anxhost-lockup-option-b-dark.svg", "#08060d", 640)}${tile("anxhost-lockup-option-b-light.svg", "#f7f6fa", 640)}</div>
  <h2 style="font-size:16px">Marks and wordmarks</h2>
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px">${tile("anxhost-mark-option-a-dark.svg", "#08060d", 200)}${tile("anxhost-mark-option-a-light.svg", "#f7f6fa", 200)}${tile("anxhost-mark-option-b.svg", "#08060d", 200)}${tile("anxhost-icon-small.svg", "#f7f6fa", 200)}</div>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px">${tile("anxhost-wordmark-tagline-dark.svg", "#08060d", 520)}${tile("anxhost-wordmark-tagline-light.svg", "#f7f6fa", 520)}</div>
  <h2 style="font-size:16px">Small sizes (16-32 px use the small icon, 48+ use Option B)</h2>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">${sizes("anxhost-mark-option-b.svg", "#08060d")}${sizes("anxhost-mark-option-b.svg", "#f7f6fa")}</div>
  </body></html>`;
  await page.setViewportSize({ width: 1556, height: 1000 });
  await page.setContent(sheet);
  await page.screenshot({ path: path.join(OUT, "anxhost-brand-proposals.png"), fullPage: true });
  await browser.close();
}

async function main() {
  build();
  console.log(`wrote ${Object.keys(FILES).length} SVGs to ${path.relative(root, path.join(OUT, "svg"))}`);
  if (!process.argv.includes("--no-png")) {
    await renderPngs();
    console.log(`rendered PNG sizes, .ico and review sheet in ${path.relative(root, OUT)}`);
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
