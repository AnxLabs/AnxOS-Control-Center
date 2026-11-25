#!/usr/bin/env node
"use strict";

// Build 216-A1 brand allowlist (PLANS.md section 7; A1_FINISH_LINE.md finish
// line 5). The in-app rename changes user-visible desktop-shell branding to
// "AnxHost Control Center" / "AnxHost CC" and nothing else:
//
//   BA1 every desktop-shell region of index.html (startup, gates, title bar,
//       sidebar, search, command palette, operation tray, computer picker,
//       update banner and dialogs, onboarding, help, toast, Assistant) has no
//       "AnxOS" text, except the allowlisted phrases below.
//   BA2 the shell names the product: window <title>, startup, title bar,
//       DEFAULT_APP_NAME, and the saved legacy default maps to the new name.
//   BA3 the shell strings set from app.js (startup messages, sign-in button,
//       unlock title, command palette entry) use the new name.
//   BA4 nothing outside the allowlist was renamed: frozen identifiers are
//       checked by frozen-identifiers-smoke; here, the internal names the
//       rename must never touch are still present (preload aliases, data
//       folder, storage key prefix, Agent package name, update origin).
//
// Pages (Home, My Servers, ...) are renamed by their own waves; their
// remaining "AnxOS" text is not checked here. Usage: node scripts/anxhost-brand-allowlist-smoke.js

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const html = read("index.html");
const app = read("app.js");

// "AnxOS" text a shell region may still contain, with the reason.
const ALLOWLIST = [
  // Empty since 216-B renamed the sign-in website (the last entry).
];

const REGIONS = [
  ["startup", "data-startup-screen"],
  ["security gate", "data-security-gate"],
  ["local setup gate", "data-local-setup-gate"],
  ["title bar", "data-titlebar"],
  ["operation tray", "data-operation-tray"],
  ["global search", "data-global-search"],
  ["command palette", "data-command-palette"],
  ["sidebar", "data-sidebar"],
  ["computer picker", "data-node-picker"],
  ["update banner", "data-update-ready-banner"],
  ["update dialog", "data-update-modal"],
  ["developer update dialog", "data-dev-update-modal"],
  ["onboarding welcome", "data-onboarding-welcome"],
  ["onboarding wizard", "data-onboarding-wizard"],
  ["contextual help", "data-contextual-help-modal"],
  ["toast", 'id="toast"'],
  ["Assistant", "data-assistant-panel"],
];

// Returns the outer HTML of the element whose opening tag carries `marker`
// as a whole attribute (followed by a space, ">" or "=").
function regionOf(marker) {
  const pattern = new RegExp(`<([a-z]+)\\b[^>]*\\s${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s>=])[^>]*>`, "i");
  const open = pattern.exec(html);
  if (!open) return null;
  const tag = open[1].toLowerCase();
  const tagPattern = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = open.index;
  let depth = 0;
  let match;
  while ((match = tagPattern.exec(html))) {
    if (match[1]) depth -= 1;
    else if (!match[0].endsWith("/>")) depth += 1;
    if (depth === 0) return html.slice(open.index, tagPattern.lastIndex);
  }
  return null;
}

const failures = [];
const check = (id, ok, message) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${message}`);
  if (!ok) failures.push(id);
};

// BA1
for (const [name, marker] of REGIONS) {
  const region = regionOf(marker);
  if (!region) { check("BA1", false, `${name}: region ${marker} not found in index.html`); continue; }
  let text = region;
  for (const { phrase } of ALLOWLIST) text = text.split(phrase).join("");
  // Attribute values that are internal hooks (data-*, class, id) may carry
  // anxos names; only text and user-visible attributes count.
  const visible = text
    .replace(/\s(?:data-[a-z-]+|class|id|for|name|src|href|aria-controls|aria-labelledby|aria-describedby)="[^"]*"/gi, "");
  const hits = [...visible.matchAll(/[^<>"]{0,30}AnxOS[^<>"]{0,30}/g)].map((m) => m[0].trim());
  check("BA1", hits.length === 0, `${name}: ${hits.length ? `"AnxOS" left: ${hits.map((h) => JSON.stringify(h)).join(", ")}` : "no AnxOS text"}`);
}

// BA2
check("BA2", /<title>AnxHost Control Center<\/title>/.test(html), "window <title> is AnxHost Control Center");
check("BA2", /data-startup-screen[^>]*aria-label="AnxHost Control Center startup"/.test(html) && /<h1 data-app-name>AnxHost Control Center<\/h1>/.test(html), "startup screen names AnxHost Control Center");
check("BA2", regionOf("data-titlebar")?.includes(">AnxHost CC</strong>"), "title bar shows AnxHost CC");
check("BA2", /const DEFAULT_APP_NAME = "AnxHost Control Center";/.test(app), "DEFAULT_APP_NAME is AnxHost Control Center");
check("BA2", /LEGACY_DEFAULT_APP_NAMES = new Set\(\["AnxOS Control Center"\]\)/.test(app) && /displayName = resolveDisplayAppName\(settings\["app\.displayName"\]\)/.test(app), "a saved legacy default name shows as the new name");

// BA3
for (const [label, pattern] of [
  ["startup message", /updateStartupMessage\("Starting AnxHost CC\.\.\."/],
  ["ready message", /updateStartupMessage\("AnxHost Control Center ready\."/],
  ["sign-in button", /: "Sign in with AnxHost";/],
  ["unlock title", /: "Unlock AnxHost CC";/],
  ["command palette entry", /description: "Run AnxHost CC actions\. Shortcut: Ctrl\+Shift\+P"/],
]) {
  check("BA3", pattern.test(app), `app.js ${label} uses the AnxHost name`);
}

// BA4: internal names the rename must not touch.
const preload = read("preload.js");
const pkg = JSON.parse(read("package.json"));
for (const [label, ok] of [
  ["preload aliases anx, anxhub, anxos, electronAPI", ["anx", "anxhub", "anxos", "electronAPI"].every((alias) => new RegExp(`exposeInMainWorld\\(\\s*["']${alias}["']`).test(preload) || preload.includes(`"${alias}"`))],
  ["renderer storage keys keep the anxos. prefix", /"anxos\.sidebar\.v1"/.test(app)],
  ["package name anxos-control-center", pkg.name === "anxos-control-center"],
  ["appId com.anxos.controlcenter", pkg.build?.appId === "com.anxos.controlcenter"],
]) {
  check("BA4", ok, label);
}

if (failures.length) {
  console.error(`ANXHOST BRAND ALLOWLIST SMOKE: FAIL (${failures.length})`);
  process.exitCode = 1;
} else {
  console.log("ANXHOST BRAND ALLOWLIST SMOKE: PASS");
}
