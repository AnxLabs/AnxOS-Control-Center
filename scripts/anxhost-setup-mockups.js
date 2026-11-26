#!/usr/bin/env node
"use strict";

// Build 216-D (custom installer proposal): renders every screen of the
// proposed standalone AnxHost Setup window from one HTML/CSS design, with the
// approved AnxHost brand SVGs and the app's colour tokens. Output:
// docs/anxhost/d-installer/custom/ (one PNG per screen and a design sheet).
// The same markup is meant to become the real setup window's UI (a WebView2
// page hosted by a small signed Rust program), so what the owner approves here
// is what ships.
//
// Usage: node scripts/anxhost-setup-mockups.js

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BRAND = path.join(ROOT, "docs", "anxhost", "brand", "svg");
const OUT = path.join(ROOT, "docs", "anxhost", "d-installer", "custom");

const img = (name, cls = "") => `<img class="${cls}" alt="" src="data:image/svg+xml;base64,${fs.readFileSync(path.join(BRAND, name)).toString("base64")}">`;
const MARK = (cls) => img("anxhost-mark-option-a-dark.svg", cls);
const WORD = (cls) => img("anxhost-wordmark-tagline-dark.svg", cls);
const ICON = (cls) => img("anxhost-icon-small.svg", cls);

const CSS = `
:root {
  --ink-1000:#08060d; --ink-950:#0e0c14; --ink-900:#15131d; --ink-850:#1d1b28; --ink-800:#272535; --ink-700:#3a374c;
  --ink-500:#767289; --ink-400:#9c98ab; --ink-300:#c3c0cf; --ink-100:#eeedf3;
  --v-950:#1b0033; --v-900:#300058; --v-700:#6010a0; --v-600:#7818c0; --v-500:#8c3ee6; --v-400:#a46af5; --v-300:#bf96ff; --v-200:#d8c0ff;
  --ok:#3ccf91; --warn:#f2b84b; --err:#ff6b81;
  --ease: cubic-bezier(.22,1,.36,1);
}
* { box-sizing: border-box; }
body { margin:0; padding:28px; background:#05040a; font:13px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif; color:var(--ink-100); }
h2.cap { font:600 13px "Segoe UI"; color:var(--ink-400); margin:0 0 10px; letter-spacing:.2px; }
.sheet { display:grid; grid-template-columns:repeat(2, 820px); gap:34px 36px; }
.win { width:820px; height:520px; border-radius:12px; overflow:hidden; position:relative; display:flex; flex-direction:column;
  background:var(--ink-950); border:1px solid rgb(255 255 255 / .07); box-shadow:0 24px 60px rgb(0 0 0 / .55), 0 0 0 1px rgb(120 24 192 / .12); }
.title { height:40px; flex:none; display:flex; align-items:center; gap:10px; padding:0 6px 0 14px; background:rgb(8 6 13 / .55); border-bottom:1px solid rgb(255 255 255 / .05); position:relative; z-index:2; }
.title .ti { width:18px; height:18px; }
.title b { font-weight:600; font-size:12.5px; letter-spacing:.2px; }
.title .sep { color:var(--ink-500); font-size:12px; }
.title .grow { flex:1; }
.title .wb { width:40px; height:30px; border-radius:7px; display:grid; place-items:center; color:var(--ink-400); font-size:13px; }
.title .wb.x:hover, .title .wb.hot { background:#c42b45; color:#fff; }
.body { flex:1; display:flex; min-height:0; }
.hero { width:280px; flex:none; position:relative; overflow:hidden; display:flex; flex-direction:column; align-items:center; justify-content:center; padding:24px;
  background: radial-gradient(260px 220px at 50% 38%, rgb(140 62 230 / .34), transparent 72%), linear-gradient(170deg, #2a1450 0%, var(--ink-900) 58%, var(--ink-1000) 100%); border-right:1px solid rgb(255 255 255 / .05); }
.hero::before { content:""; position:absolute; inset:0; background-image: radial-gradient(rgb(255 255 255 / .07) 1px, transparent 1.3px); background-size:14px 14px;
  -webkit-mask-image: radial-gradient(200px 260px at 50% 40%, #000, transparent 80%); }
.hero .mark { width:132px; height:132px; filter: drop-shadow(0 10px 28px rgb(140 62 230 / .45)); position:relative; }
.hero .word { width:190px; margin-top:14px; position:relative; }
.hero .formerly { position:absolute; bottom:18px; left:0; right:0; text-align:center; font-size:11px; color:var(--ink-400); }
.hero .chip-formerly { margin-top:16px; position:relative; font-size:11.5px; padding:5px 11px; border-radius:999px; color:var(--v-200); background:rgb(120 24 192 / .22); border:1px solid rgb(191 150 255 / .25); }
.main { flex:1; min-width:0; display:flex; flex-direction:column; padding:30px 34px 22px; position:relative; }
.steps { display:flex; gap:6px; align-items:center; margin-bottom:18px; font-size:11.5px; color:var(--ink-500); }
.steps span { display:flex; align-items:center; gap:6px; }
.steps i { width:7px; height:7px; border-radius:50%; background:var(--ink-700); display:inline-block; }
.steps .on { color:var(--v-200); } .steps .on i { background:var(--v-400); box-shadow:0 0 0 3px rgb(164 106 245 / .2); }
.steps .done { color:var(--ink-300); } .steps .done i { background:var(--v-600); }
.steps .ln { width:18px; height:1px; background:var(--ink-700); }
h1 { font:600 23px/1.25 "Segoe UI Variable Display","Segoe UI",system-ui; margin:0 0 10px; letter-spacing:-.2px; }
h1 .accent { background:linear-gradient(90deg, var(--v-300), var(--v-500)); -webkit-background-clip:text; color:transparent; }
p.lead { color:var(--ink-300); margin:0 0 14px; font-size:13.5px; max-width:460px; }
.ver { display:inline-flex; align-items:center; gap:8px; font-size:12px; padding:6px 10px; border-radius:8px; background:rgb(255 255 255 / .04); border:1px solid rgb(255 255 255 / .07); color:var(--ink-300); margin-bottom:14px; }
.ver b { color:var(--ink-100); font-weight:600; } .ver .arr { color:var(--v-400); }
.kept { margin:2px 0 0; padding:12px 14px; border-radius:10px; background:linear-gradient(180deg, rgb(120 24 192 / .10), rgb(120 24 192 / .04)); border:1px solid rgb(191 150 255 / .14); }
.kept h3 { margin:0 0 7px; font-size:12px; font-weight:600; color:var(--v-200); letter-spacing:.3px; text-transform:uppercase; }
.kept ul { margin:0; padding:0; list-style:none; display:grid; grid-template-columns:1fr 1fr; gap:4px 16px; font-size:12.5px; color:var(--ink-300); }
.kept li::before { content:"✓"; color:var(--ok); margin-right:7px; font-weight:700; }
.spacer { flex:1; }
.actions { display:flex; align-items:center; gap:10px; }
.actions .grow { flex:1; }
.link { color:var(--v-300); font-size:12.5px; }
.btn { font:600 13px "Segoe UI"; padding:9px 18px; border-radius:9px; border:1px solid rgb(255 255 255 / .10); background:var(--ink-850); color:var(--ink-100); }
.btn.ghost { background:transparent; }
.btn.primary { border:0; color:#fff; background:linear-gradient(180deg, var(--v-500), var(--v-600)); box-shadow:0 6px 18px rgb(120 24 192 / .45), inset 0 1px 0 rgb(255 255 255 / .18); padding:9px 22px; }
.btn.danger { border:0; color:#fff; background:linear-gradient(180deg, #e0485f, #b8293f); box-shadow:0 6px 18px rgb(196 43 69 / .35); }
.btn.focus { outline:2px solid var(--v-300); outline-offset:2px; }
.field { margin-bottom:14px; }
.field label { display:block; font-size:12px; color:var(--ink-400); margin-bottom:6px; font-weight:600; letter-spacing:.2px; }
.path { display:flex; gap:8px; }
.path .in { flex:1; padding:9px 12px; border-radius:9px; background:var(--ink-1000); border:1px solid rgb(255 255 255 / .09); color:var(--ink-100); font-size:12.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.path .btn { padding:8px 14px; }
.hint { font-size:12px; color:var(--ink-500); margin-top:6px; }
.card { display:flex; gap:12px; padding:13px 14px; border-radius:11px; background:var(--ink-900); border:1px solid rgb(255 255 255 / .07); margin-bottom:10px; }
.card.sel { border-color:rgb(164 106 245 / .55); background:linear-gradient(180deg, rgb(120 24 192 / .14), rgb(120 24 192 / .05)); }
.card .tg { width:36px; height:20px; border-radius:999px; flex:none; margin-top:2px; position:relative; background:var(--ink-700); }
.card .tg::after { content:""; position:absolute; top:3px; left:3px; width:14px; height:14px; border-radius:50%; background:#fff; }
.card .tg.on { background:linear-gradient(90deg, var(--v-600), var(--v-500)); } .card .tg.on::after { left:19px; }
.card .rd { width:16px; height:16px; border-radius:50%; flex:none; margin-top:2px; border:2px solid var(--ink-500); }
.card .rd.on { border-color:var(--v-400); background:radial-gradient(circle, var(--v-400) 40%, transparent 46%); }
.card b { display:block; font-size:13px; margin-bottom:2px; }
.card span { font-size:12px; color:var(--ink-400); }
.tag { display:inline-block; font-size:10px; font-weight:700; letter-spacing:.5px; padding:2px 7px; border-radius:5px; margin-left:6px; color:#fff; background:var(--v-600); vertical-align:1px; }
.uac { display:flex; gap:10px; align-items:flex-start; font-size:12px; color:var(--ink-300); padding:9px 12px; border-radius:9px; background:rgb(242 184 75 / .07); border:1px solid rgb(242 184 75 / .20); }
.uac .sh { color:var(--warn); font-weight:700; }
.tabs2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
.prog { margin:6px 0 4px; }
.prog .meta { display:flex; justify-content:space-between; font-size:12px; color:var(--ink-400); margin-bottom:8px; }
.prog .meta b { color:var(--ink-100); font-weight:600; }
.bar { height:8px; border-radius:999px; background:rgb(255 255 255 / .06); overflow:hidden; }
.bar .fill { height:100%; border-radius:999px; background:linear-gradient(90deg, var(--v-600), var(--v-400)); box-shadow:0 0 14px rgb(164 106 245 / .55); }
.list { margin:16px 0 0; padding:0; list-style:none; display:flex; flex-direction:column; gap:8px; font-size:12.5px; }
.list li { display:flex; gap:10px; align-items:center; color:var(--ink-500); }
.list li .ic { width:18px; height:18px; border-radius:50%; display:grid; place-items:center; font-size:11px; flex:none; border:1.5px solid var(--ink-700); }
.list li.done { color:var(--ink-300); } .list li.done .ic { border:0; background:rgb(60 207 145 / .16); color:var(--ok); }
.list li.run { color:var(--ink-100); } .list li.run .ic { border-color:var(--v-400); border-right-color:transparent; }
.list li .sub { margin-left:auto; color:var(--ink-500); font-size:11.5px; }
.log { margin-top:12px; border-radius:10px; background:var(--ink-1000); border:1px solid rgb(255 255 255 / .07); font:11px/1.55 "Cascadia Mono",Consolas,monospace; color:var(--ink-400); padding:9px 12px; height:118px; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
.log .t { color:var(--ink-500); } .log .ok { color:var(--ok); } .log .v { color:var(--v-300); }
.toggle { font-size:12px; color:var(--v-300); margin-top:12px; display:inline-flex; gap:6px; align-items:center; }
.center { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:20px 50px; position:relative; }
.center .mark { width:96px; height:96px; filter: drop-shadow(0 10px 26px rgb(140 62 230 / .5)); }
.center h1 { margin-top:16px; }
.center p.lead { margin-left:auto; margin-right:auto; text-align:center; }
.glow { position:absolute; inset:0; background: radial-gradient(420px 260px at 50% 10%, rgb(140 62 230 / .28), transparent 70%); pointer-events:none; }
.okring { width:64px; height:64px; border-radius:50%; display:grid; place-items:center; background:rgb(60 207 145 / .12); border:1.5px solid rgb(60 207 145 / .45); color:var(--ok); font-size:28px; margin-top:-6px; }
.errring { width:64px; height:64px; border-radius:50%; display:grid; place-items:center; background:rgb(255 107 129 / .10); border:1.5px solid rgb(255 107 129 / .45); color:var(--err); font-size:30px; font-weight:700; }
.chk { display:flex; gap:8px; align-items:center; font-size:12.5px; color:var(--ink-300); margin:4px 0 0; justify-content:center; }
.chk i { width:16px; height:16px; border-radius:5px; background:linear-gradient(180deg, var(--v-500), var(--v-600)); color:#fff; display:grid; place-items:center; font-size:10px; font-style:normal; }
.errbox { text-align:left; margin-top:14px; width:100%; max-width:540px; border-radius:10px; padding:11px 13px; background:rgb(255 107 129 / .06); border:1px solid rgb(255 107 129 / .22); font-size:12.5px; color:var(--ink-300); }
.errbox b { color:var(--ink-100); }
.apps { display:flex; flex-direction:column; gap:8px; margin:6px 0 12px; }
.app { display:flex; align-items:center; gap:10px; padding:10px 12px; border-radius:10px; background:var(--ink-900); border:1px solid rgb(255 255 255 / .07); font-size:12.5px; }
.app .dot { width:8px; height:8px; border-radius:50%; background:var(--ok); box-shadow:0 0 0 3px rgb(60 207 145 / .15); }
.app .sub { margin-left:auto; color:var(--ink-500); font-size:11.5px; }
`;

const titlebar = (label = "Setup") => `<div class="title">${ICON("ti")}<b>AnxHost Control Center</b><span class="sep">·</span><span class="sep">${label}</span><span class="grow"></span><span class="wb">—</span><span class="wb x">✕</span></div>`;
const steps = (active) => {
  const names = ["Welcome", "Options", "Install", "Done"];
  return `<div class="steps">${names.map((n, i) => `<span class="${i < active ? "done" : i === active ? "on" : ""}"><i></i>${n}</span>${i < names.length - 1 ? '<span class="ln"></span>' : ""}`).join("")}</div>`;
};
const hero = ({ formerly = false } = {}) => `<div class="hero">${MARK("mark")}${WORD("word")}${formerly ? '<span class="chip-formerly">Formerly AnxOS Control Center</span>' : ""}<span class="formerly">${formerly ? "Same app · new name · everything kept" : "by AnxLabs"}</span></div>`;
const kept = `<div class="kept"><h3>Kept on this PC</h3><ul>
  <li>Servers and worlds</li><li>Saved sign-ins and credentials</li><li>Settings and backups</li><li>Paired computers and phones</li><li>Agent identities</li><li>AnxNet networks</li></ul></div>`;
const win = (label, inner) => `<div class="win">${titlebar(label)}<div class="body">${inner}</div></div>`;

const SCREENS = [
  { id: "01-welcome-fresh", label: "Welcome: new install", html: win("Setup", `${hero()}<div class="main">${steps(0)}
      <h1>Welcome to <span class="accent">AnxHost</span> Control Center</h1>
      <p class="lead">Create game servers, manage the computers that run them and share them with friends, without the command line.</p>
      <div class="ver">New <b>Build 216</b> · Private Alpha · 412 MB</div>
      <p class="lead" style="font-size:12.5px;color:var(--ink-400)">Installs for your Windows account in about a minute. No administrator approval is needed for the app itself.</p>
      <div class="spacer"></div>
      <div class="actions"><span class="link">Options: folder and Helper</span><span class="grow"></span><span class="btn ghost">Cancel</span><span class="btn primary focus">Install</span></div></div>`) },
  { id: "02-welcome-anxos-upgrade", label: "Welcome: AnxOS Control Center found (successor)", html: win("Upgrade", `${hero({ formerly: true })}<div class="main">${steps(0)}
      <h1>AnxOS Control Center is now <span class="accent">AnxHost</span></h1>
      <p class="lead">Same app, new name and a brand new look. Setup upgrades the copy on this PC in place.</p>
      <div class="ver">Installed <b>AnxOS Control Center · Build 215</b> <span class="arr">→</span> New <b>AnxHost · Build 216</b></div>
      ${kept}
      <div class="spacer"></div>
      <div class="actions"><span class="link">What's new in Build 216</span><span class="grow"></span><span class="btn ghost">Not now</span><span class="btn primary focus">Upgrade</span></div></div>`) },
  { id: "03-welcome-update", label: "Welcome: update an AnxHost install", html: win("Update", `${hero()}<div class="main">${steps(0)}
      <h1>Update <span class="accent">AnxHost</span> Control Center</h1>
      <p class="lead">A newer build is ready. Setup updates the installed app in place; it closes for a moment and opens again when it's done.</p>
      <div class="ver">Installed <b>Build 216</b> <span class="arr">→</span> New <b>Build 217</b></div>
      ${kept}
      <div class="spacer"></div>
      <div class="actions"><span class="grow"></span><span class="btn ghost">Not now</span><span class="btn primary focus">Update</span></div></div>`) },
  { id: "04-maintenance", label: "Same build installed: repair or uninstall", html: win("Maintenance", `${hero()}<div class="main">${steps(0)}
      <h1>AnxHost Control Center is installed</h1>
      <p class="lead">Build 216 is already on this PC. Choose what you want to do.</p>
      <div class="card sel"><span class="rd on"></span><div><b>Repair</b><span>Reinstall the program files and set the Helper up again. Fixes missing or damaged files. Nothing you have changes.</span></div></div>
      <div class="card"><span class="rd"></span><div><b>Uninstall</b><span>Remove the app, its shortcuts and the Helper. Your servers and data stay in your user profile.</span></div></div>
      <div class="spacer"></div>
      <div class="actions"><span class="grow"></span><span class="btn ghost">Close</span><span class="btn primary focus">Repair</span></div></div>`) },
  { id: "05-options", label: "Options: folder, Helper, who it's for", html: win("Options", `${hero()}<div class="main">${steps(1)}
      <h1>Options</h1>
      <div class="field"><label>INSTALL FOLDER</label><div class="path"><span class="in">C:\\Users\\you\\AppData\\Local\\Programs\\AnxOS Control Center</span><span class="btn">Browse…</span></div>
        <div class="hint">The app only. Your servers and data live in your user profile. 412 MB needed · 212 GB free.</div></div>
      <div class="card sel"><span class="tg on"></span><div><b>AnxHost Helper <span class="tag">RECOMMENDED</span></b><span>Runs in the background so the app can start, stop and watch servers on this PC, even after a restart. Includes AnxNet, which stays off until you join a network.</span></div></div>
      <div class="uac"><span class="sh">⛨</span><span>Windows will ask for administrator approval to set up the Helper. Setup never changes your security settings, firewall or other apps.</span></div>
      <div class="spacer"></div>
      <div class="actions"><span class="link">Install for everyone on this PC</span><span class="grow"></span><span class="btn ghost">Back</span><span class="btn primary focus">Install</span></div></div>`) },
  { id: "06-close-app", label: "The app is open (asked before anything closes)", html: win("Upgrade", `${hero({ formerly: true })}<div class="main">${steps(2)}
      <h1>Close the app to continue</h1>
      <p class="lead">These are running from the install folder. Setup closes them safely: running servers are stopped with their own save command first. Servers set to start automatically start again afterwards.</p>
      <div class="apps"><div class="app"><span class="dot"></span>AnxOS Control Center<span class="sub">window open</span></div>
        <div class="app"><span class="dot"></span>AnxOS Helper<span class="sub">2 servers running</span></div></div>
      <div class="spacer"></div>
      <div class="actions"><span class="grow"></span><span class="btn ghost">Cancel</span><span class="btn primary focus">Close and continue</span></div></div>`) },
  { id: "07-progress", label: "Installing: real progress, technical log expanded", html: win("Upgrade", `${hero({ formerly: true })}<div class="main">${steps(2)}
      <h1>Upgrading to AnxHost</h1>
      <div class="prog"><div class="meta"><span>Copying program files · <b>268 of 412 MB</b></span><b>65%</b></div><div class="bar"><div class="fill" style="width:65%"></div></div></div>
      <ul class="list">
        <li class="done"><span class="ic">✓</span>Checked the installer's signature<span class="sub">AnxLabs</span></li>
        <li class="done"><span class="ic">✓</span>Stopped the Helper (servers saved and stopped)<span class="sub">2 s</span></li>
        <li class="done"><span class="ic">✓</span>Removed the old program files<span class="sub">data kept</span></li>
        <li class="run"><span class="ic"></span>Copying program files</li>
        <li><span class="ic"></span>Setting up the AnxHost Helper</li>
      </ul>
      <span class="toggle">▾ Hide technical details</span>
      <div class="log"><span class="t">12:41:07</span> setup <span class="v">AnxHost Setup 216</span> · engine verified (Authenticode: AnxLabs, SHA-256 ok)<br>
        <span class="t">12:41:08</span> engine /S /D=C:\\Users\\you\\AppData\\Local\\Programs\\AnxOS Control Center<br>
        <span class="t">12:41:09</span> helper stop: install-agent-task.ps1 -Mode Stop <span class="ok">exit 0</span><br>
        <span class="t">12:41:11</span> old version removed (uninstaller --updated) <span class="ok">exit 0</span><br>
        <span class="t">12:41:12</span> extracting app-64.7z · 268.4 / 412.0 MB written</div></div>`) },
  { id: "08-done-upgrade", label: "Done: upgraded from AnxOS", html: win("Upgrade", `<div class="center"><div class="glow"></div>${MARK("mark")}
      <h1>Welcome to <span class="accent">AnxHost</span></h1>
      <p class="lead">AnxOS Control Center is now AnxHost Control Center. Your servers, computers and settings are all still there.</p>
      <div class="ver">Build 216 · Helper running · auto-start servers started</div>
      <label class="chk"><i>✓</i>Open AnxHost Control Center now</label>
      <div style="height:18px"></div>
      <div class="actions"><span class="link">Show what changed</span><span style="width:24px"></span><span class="btn primary focus">Finish</span></div></div>`) },
  { id: "09-error", label: "Error with recovery (nothing lost)", html: win("Setup", `<div class="center"><div class="errring">!</div>
      <h1>Setup couldn't finish</h1>
      <p class="lead">Nothing you had was removed. Your servers and data are untouched.</p>
      <div class="errbox"><b>What happened:</b> Windows didn't allow the program files to be replaced (a file is in use).<br><b>Try this:</b> close any open AnxHost windows and select Try again. If it stops again, restart the PC and run Setup once more.</div>
      <div style="height:16px"></div>
      <div class="actions"><span class="link">Show technical details</span><span style="width:20px"></span><span class="btn ghost">Copy details</span><span class="btn">Close</span><span class="btn primary focus">Try again</span></div></div>`) },
  { id: "10-uninstall", label: "Uninstall (from Windows Settings)", html: win("Uninstall", `${hero()}<div class="main">
      <h1>Uninstall AnxHost Control Center</h1>
      <p class="lead">This removes the app, its shortcuts and the AnxHost Helper. Servers on other computers are not affected.</p>
      ${kept}
      <p class="hint" style="margin-top:10px">Kept in %APPDATA%\\AnxHub, so installing again picks up where you left off.</p>
      <div class="spacer"></div>
      <div class="actions"><span class="grow"></span><span class="btn ghost focus">Cancel</span><span class="btn danger">Uninstall</span></div></div>`) },
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require("playwright-core");
  const exe = [process.env.ANXHOST_BROWSER, "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe"].filter(Boolean).find((p) => fs.existsSync(p));
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 });
    for (const s of SCREENS) {
      await page.setContent(`<!doctype html><style>${CSS} body{padding:0;background:transparent}</style>${s.html}`);
      await page.locator(".win").screenshot({ path: path.join(OUT, `${s.id}.png`), omitBackground: true });
    }
    await page.setViewportSize({ width: 820 * 2 + 36 + 56, height: 900 });
    await page.setContent(`<!doctype html><style>${CSS}</style><div class="sheet">${SCREENS.map((s) => `<div><h2 class="cap">${s.label}</h2>${s.html}</div>`).join("")}</div>`);
    await page.screenshot({ path: path.join(OUT, "custom-installer-design-sheet.png"), fullPage: true });
  } finally {
    await browser.close();
  }
  console.log(`Wrote ${SCREENS.length} screens and the design sheet to ${path.relative(ROOT, OUT)}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
