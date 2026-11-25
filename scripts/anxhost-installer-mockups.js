#!/usr/bin/env node
"use strict";

// Build 216-D installer design proposal: renders every installer page as a
// mockup at the real NSIS Modern UI 2 size (dialog 503x390, sidebar 164x314,
// header art 150x57), using the approved AnxHost brand SVGs. Output goes to
// docs/anxhost/d-installer/ for owner review.
//
// With --write-art it also writes the installer's own bitmaps,
// windows/installer-art/sidebar.bmp (164x314) and header.bmp (150x57), as
// 24-bit BMPs rendered from the same art at 1x, so the shipped art stays
// reproducible from the brand SVGs.
//
// Usage: node scripts/anxhost-installer-mockups.js [--write-art]

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BRAND = path.join(ROOT, "docs", "anxhost", "brand", "svg");
const OUT = path.join(ROOT, "docs", "anxhost", "d-installer");
const ART = path.join(ROOT, "windows", "installer-art");

const svg = (name) => fs.readFileSync(path.join(BRAND, name), "utf8").replace(/<\?xml[^>]*>/, "");

const MARK_A = svg("anxhost-mark-option-a-dark.svg");
const WORD_TAG = svg("anxhost-wordmark-tagline-dark.svg");
const SMALL = svg("anxhost-icon-small.svg");

const NAME = "AnxHost Control Center";
const HELPER = "AnxHost Helper";

function sidebar() {
  return `<div class="side">
    <div class="side-mark">${MARK_A}</div>
    <div class="side-word">${WORD_TAG}</div>
    <div class="side-foot">formerly AnxOS Control Center</div>
  </div>`;
}

function buttons({ back = true, next = "Next >", cancel = true, nextDisabled = false } = {}) {
  return `<div class="bar">
    <span class="brand">AnxHost Control Center by AnxLabs</span>
    <span class="btns">
      <button ${back ? "" : "disabled"}>&lt; Back</button>
      <button class="primary" ${nextDisabled ? "disabled" : ""}>${next}</button>
      <button ${cancel ? "" : "disabled"}>Cancel</button>
    </span>
  </div>`;
}

function welcomePage({ title, paragraphs, extra = "", nav }) {
  return `<div class="dlg">
    <div class="welcome">
      ${sidebar()}
      <div class="wtext">
        <h1>${title}</h1>
        ${paragraphs.map((p) => `<p>${p}</p>`).join("")}
        ${extra}
      </div>
    </div>
    ${buttons(nav)}
  </div>`;
}

function innerPage({ title, subtitle, body, nav }) {
  return `<div class="dlg">
    <div class="head">
      <div class="htext"><b>${title}</b><span>${subtitle}</span></div>
      <div class="hart"><div class="hmark">${SMALL}</div></div>
    </div>
    <div class="inner">${body}</div>
    ${buttons(nav)}
  </div>`;
}

const PAGES = [
  {
    id: "01-welcome-new",
    label: "Welcome (new install)",
    html: welcomePage({
      title: `Welcome to ${NAME}`,
      paragraphs: [
        `This installs ${NAME} on this PC.`,
        "Create game servers, manage the computers that run them and share them with friends, without the command line.",
        "Setup takes about a minute.",
      ],
    }),
  },
  {
    id: "02-welcome-upgrade",
    label: "Welcome (update or repair)",
    html: welcomePage({
      title: `Update ${NAME}`,
      paragraphs: [
        `${NAME} is already installed. Setup updates or repairs it in place.`,
        "Your servers, worlds, settings, backups and paired computers are kept.",
      ],
      extra: `<div class="chip">Installed: Build 215 &nbsp;→&nbsp; New: Build 216</div>`,
    }),
  },
  {
    id: "03-install-mode",
    label: "Who is it for (electron-builder page, restyled header only)",
    html: innerPage({
      title: "Choose who can use it",
      subtitle: `Install it for your account or for everyone on this PC.`,
      body: `<label class="radio"><i class="on"></i>Only for me (recommended)</label>
        <p class="hint">No administrator approval needed for the app itself.</p>
        <label class="radio"><i></i>Anyone who uses this computer</label>
        <p class="hint">Windows asks for administrator approval.</p>`,
    }),
  },
  {
    id: "04-folder",
    label: "Install folder",
    html: innerPage({
      title: "Choose the install folder",
      subtitle: "The app goes here. Your servers and data are stored separately.",
      body: `<div class="field"><span>C:\\Users\\you\\AppData\\Local\\Programs\\AnxOS Control Center</span><button>Browse…</button></div>
        <p class="hint">Space required: 410 MB &nbsp;·&nbsp; Space available: 212 GB</p>
        <p class="hint">The folder name stays the same on updates so nothing has to move.</p>`,
    }),
  },
  {
    id: "05-setup-helper",
    label: "Set up (Helper choice)",
    html: innerPage({
      title: "Set up AnxHost",
      subtitle: "Choose what to set up on this PC.",
      body: `<div class="opt"><b>${NAME}</b><span>The app you use to create and manage servers. Always installed.</span></div>
        <label class="check"><i class="on"></i><b>${HELPER}</b> <em>Recommended</em></label>
        <p class="hint ind">Runs in the background so the app can start, stop and watch servers on this PC, even after a restart. Includes AnxNet, the private network for playing with friends, which stays off until you join one.</p>
        <div class="note ind"><b>Windows will ask for administrator approval</b> so the Helper can start when you sign in. Setup does not change your security settings, firewall or other apps. You can set it up later in Agent Control.</div>`,
    }),
  },
  {
    id: "06-progress",
    label: "Installing",
    html: innerPage({
      title: "Installing",
      subtitle: `Please wait while ${NAME} is installed.`,
      body: `<p class="step">Setting up the ${HELPER}. Windows may ask for administrator approval…</p>
        <div class="prog"><div style="width:72%"></div></div>
        <div class="log">Extract: resources\\app.asar<br>Extract: resources\\install-agent-task.ps1<br>Stopping the ${HELPER} for the update…<br>Setting up the ${HELPER}…</div>`,
      nav: { back: false, next: "Next >", nextDisabled: true },
    }),
  },
  {
    id: "07-finish",
    label: "Finish",
    html: welcomePage({
      title: `${NAME} is ready`,
      paragraphs: [
        "Setup has finished.",
        "Open the app to create your first server or connect another computer.",
      ],
      extra: `<label class="check light"><i class="on"></i>Open ${NAME} now</label>`,
      nav: { back: false, next: "Finish", cancel: false },
    }),
  },
  {
    id: "08-uninstall",
    label: "Uninstall",
    html: welcomePage({
      title: `Uninstall ${NAME}`,
      paragraphs: [
        `This removes the app and the ${HELPER} from this PC.`,
        "Your servers, worlds, backups, settings and paired computers are kept, so installing again picks up where you left off. Servers on other computers are not affected.",
      ],
      nav: { back: false, next: "Uninstall" },
    }),
  },
];

const CSS = `
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; background: #0e0c14; font: 12px "Segoe UI", system-ui, sans-serif; color: #f7f6fa; }
h2 { font: 600 13px "Segoe UI"; color: #c3c0cf; margin: 0 0 8px; }
.grid { display: grid; grid-template-columns: repeat(2, 503px); gap: 28px 32px; }
.dlg { width: 503px; height: 390px; background: #f3f3f3; color: #1b1b1f; display: flex; flex-direction: column; border: 1px solid #3a3446; box-shadow: 0 8px 24px rgb(0 0 0 / .45); }
.welcome { flex: 1; display: flex; background: #181521; color: #f7f6fa; }
.side { width: 164px; align-self: stretch; flex: none; background: linear-gradient(165deg, #2a1450 0%, #181521 62%, #120f19 100%); display: flex; flex-direction: column; align-items: center; padding-top: 34px; position: relative; overflow: hidden; }
.side::after { content: ""; position: absolute; inset: auto -40px -60px auto; width: 180px; height: 180px; border-radius: 50%; background: radial-gradient(circle, rgb(140 62 230 / .28), transparent 70%); }
.side-mark svg { width: 104px; height: 104px; display: block; }
.side-word svg { width: 128px; height: auto; display: block; margin-top: 14px; }
.side-foot { position: absolute; bottom: 12px; font-size: 9.5px; color: #9d98ad; }
.wtext { padding: 22px 22px 0 20px; }
.wtext h1 { font: 600 17px "Segoe UI"; margin: 0 0 14px; line-height: 1.25; }
.wtext p { margin: 0 0 10px; line-height: 1.45; color: #dcd9e6; }
.chip { display: inline-block; margin-top: 4px; padding: 4px 9px; border-radius: 4px; background: rgb(140 62 230 / .22); color: #e4d6fb; font-size: 11px; }
.head { height: 57px; flex: none; display: flex; background: #181521; color: #f7f6fa; border-bottom: 1px solid #2c2638; }
.htext { flex: 1; padding: 10px 14px; display: flex; flex-direction: column; gap: 3px; }
.htext b { font-weight: 600; font-size: 12px; }
.htext span { color: #c3c0cf; font-size: 11px; padding-left: 8px; }
.hart { width: 150px; height: 57px; background: linear-gradient(90deg, #181521 0%, #2a1450 100%); display: flex; align-items: center; justify-content: flex-end; padding-right: 14px; }
.hmark svg { width: 34px; height: 34px; display: block; }
.inner { flex: 1; padding: 16px 22px; background: #f3f3f3; }
.bar { height: 47px; flex: none; display: flex; align-items: center; justify-content: space-between; padding: 0 10px; border-top: 1px solid #d6d6d6; background: #f0f0f0; }
.brand { color: #8a8a90; font-size: 11px; }
.btns button { width: 75px; height: 23px; margin-left: 6px; font: 12px "Segoe UI"; background: #fdfdfd; border: 1px solid #adadad; border-radius: 3px; color: #1b1b1f; }
.btns button.primary { border-color: #7818c0; box-shadow: inset 0 0 0 1px #7818c0; }
.btns button[disabled] { color: #a0a0a0; border-color: #cfcfcf; box-shadow: none; }
.radio, .check { display: flex; align-items: center; gap: 7px; margin: 6px 0 2px; }
.radio i, .check i { width: 13px; height: 13px; border: 1px solid #6b6b70; background: #fff; flex: none; }
.radio i { border-radius: 50%; }
.radio i.on { background: radial-gradient(circle, #7818c0 38%, #fff 42%); border-color: #7818c0; }
.check i.on { background: #7818c0; border-color: #7818c0; box-shadow: inset 0 0 0 2px #fff; }
.check.light { margin-top: 18px; color: #f7f6fa; }
.check.light i.on { box-shadow: inset 0 0 0 2px #181521; }
.check em { font-style: normal; font-size: 10.5px; color: #5a1a9a; background: #eadcf9; border-radius: 3px; padding: 1px 6px; }
.hint { margin: 2px 0 10px 20px; color: #55555c; line-height: 1.4; }
.hint.ind, .note.ind { margin-left: 20px; }
.opt { display: flex; flex-direction: column; gap: 2px; margin-bottom: 12px; }
.opt span { color: #55555c; }
.note { margin-top: 4px; padding: 7px 9px; border-left: 3px solid #7818c0; background: #ebe4f5; line-height: 1.4; color: #2b2b31; }
.field { display: flex; gap: 6px; margin: 8px 0 10px; }
.field span { flex: 1; border: 1px solid #adadad; background: #fff; padding: 3px 6px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.field button { width: 75px; font: 12px "Segoe UI"; background: #fdfdfd; border: 1px solid #adadad; border-radius: 3px; }
.step { margin: 6px 0 8px; }
.prog { height: 16px; border: 1px solid #bcbcbc; background: #e6e6e6; }
.prog div { height: 100%; background: linear-gradient(90deg, #7818c0, #8c3ee6); }
.log { margin-top: 12px; height: 118px; border: 1px solid #c8c8c8; background: #fff; padding: 5px 7px; font: 11px Consolas, monospace; color: #3a3a40; line-height: 1.5; }
`;

// 24-bit bottom-up BMP, rows padded to 4 bytes (what NSIS Modern UI loads).
function encodeBmp(width, height, rgba) {
  const rowSize = Math.ceil((width * 3) / 4) * 4;
  const pixelBytes = rowSize * height;
  const buffer = Buffer.alloc(54 + pixelBytes);
  buffer.write("BM", 0, "ascii");
  buffer.writeUInt32LE(54 + pixelBytes, 2);
  buffer.writeUInt32LE(54, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(24, 28);
  buffer.writeUInt32LE(pixelBytes, 34);
  buffer.writeInt32LE(2835, 38);
  buffer.writeInt32LE(2835, 42);
  for (let y = 0; y < height; y += 1) {
    const row = 54 + (height - 1 - y) * rowSize;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      buffer[row + x * 3] = rgba[i + 2];
      buffer[row + x * 3 + 1] = rgba[i + 1];
      buffer[row + x * 3 + 2] = rgba[i];
    }
  }
  return buffer;
}

async function renderArt(browser) {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  const art = `<!doctype html><style>${CSS} body{padding:0;margin:0;background:#181521}
    .art-side{width:164px;height:314px}.art-head{width:150px;height:57px}</style>
    <div class="side art-side">${sidebar().replace(/^<div class="side">|<\/div>\s*$/g, "")}</div>
    <div class="hart art-head"><div class="hmark">${SMALL}</div></div>`;
  await page.setContent(art);
  const files = [];
  for (const [selector, name, width, height] of [[".art-side", "sidebar.bmp", 164, 314], [".art-head", "header.bmp", 150, 57]]) {
    const png = await page.locator(selector).screenshot();
    const rgba = await page.evaluate(async ({ data, w, h }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${data}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const context = canvas.getContext("2d");
      context.drawImage(image, 0, 0, w, h);
      return Array.from(context.getImageData(0, 0, w, h).data);
    }, { data: png.toString("base64"), w: width, h: height });
    fs.writeFileSync(path.join(ART, name), encodeBmp(width, height, rgba));
    files.push(name);
  }
  await page.close();
  return files;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require("playwright-core");
  const exe = [process.env.ANXHOST_BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].filter(Boolean).find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    for (const p of PAGES) {
      await page.setContent(`<!doctype html><style>${CSS} body{padding:0;background:transparent}</style>${p.html}`);
      await page.locator(".dlg").screenshot({ path: path.join(OUT, `${p.id}.png`) });
    }
    const sheet = `<!doctype html><style>${CSS}</style><div class="grid">${PAGES.map((p) => `<div><h2>${p.label}</h2>${p.html}</div>`).join("")}</div>`;
    await page.setViewportSize({ width: 503 * 2 + 32 + 48, height: 900 });
    await page.setContent(sheet);
    await page.screenshot({ path: path.join(OUT, "installer-design-sheet.png"), fullPage: true });
    if (process.argv.includes("--write-art")) {
      const written = await renderArt(browser);
      console.log(`Wrote ${written.join(" and ")} to ${path.relative(ROOT, ART)}`);
    }
  } finally {
    await browser.close();
  }
  console.log(`Wrote ${PAGES.length} page mockups and the design sheet to ${path.relative(ROOT, OUT)}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
