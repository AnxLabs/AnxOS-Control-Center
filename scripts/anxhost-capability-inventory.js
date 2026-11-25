#!/usr/bin/env node
"use strict";

// Build 216 capability inventory (AnxHost CC rebirth, PLANS.md 216-0).
//
// Reads the shipped UI sources and lists every page, region, tab, action,
// input, control, dialog, keyboard shortcut, window, preload (IPC) method and
// phone screen, tab and API route. Each row gets a stable ID, its location
// today, the tests that reference it and its Build 216 destination and wave.
//
//   node scripts/anxhost-capability-inventory.js           write docs/anxhost/CAPABILITY_INVENTORY.md and .json
//   node scripts/anxhost-capability-inventory.js --check   fail if any row is unmapped, or if the UI no longer
//                                                           matches the committed inventory (a hook disappeared
//                                                           or appeared without the inventory being updated)
//
// Verification ticks ("[x]") in the Markdown are preserved when it is rewritten.
// Read-only with respect to the app: it never runs or changes application code.

const fs = require("fs");
const Module = require("module");
const path = require("path");

const root = path.resolve(__dirname, "..");
const DOC_DIR = path.join(root, "docs", "anxhost");
const MD_PATH = path.join(DOC_DIR, "CAPABILITY_INVENTORY.md");
const JSON_PATH = path.join(DOC_DIR, "capability-inventory.json");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");

// ---------------------------------------------------------------- destinations

const DEST = {
  // Pages (index.html section[data-page])
  "page:dashboard": ["HOME", "Home (dashboard)", "Home", "A2"],
  "page:amp": ["AMP", "Legacy AMP page (hidden; showPage redirects to Home)", "Retire after verification (LEGACY_RETIREMENT.md)", "A10"],
  "page:playit": ["SHARE", "Sharing (playit and public access)", "Network › Sharing", "A7"],
  "page:coolpals": ["COOLPALS", "Legacy Coolpals page (hidden; showPage redirects to Home)", "Retire after verification (LEGACY_RETIREMENT.md)", "A10"],
  "page:docker": ["DOCKER", "Tools › Docker", "Docker", "A6"],
  "page:marketplace": ["MKT", "Add Server (Marketplace and Create Server; separate windows)", "Add Server, inside the main window", "A4"],
  "page:instances": ["SRV", "My Servers and the server view", "My Servers", "A3"],
  "page:ssh": ["SSH", "Tools › SSH", "Terminal › SSH", "A8"],
  "page:files": ["FILES", "Tools › Files", "Files", "A8"],
  "page:console": ["CONSOLE", "Tools › Console", "Terminal › Server consoles", "A8"],
  "page:backups": ["BACKUP", "More › Backups", "Backups", "A8"],
  "page:operations": ["TASKS", "Tools › Task details", "Activity › Tasks", "A9"],
  "page:notifications": ["ACTIVITY", "More › Activity", "Activity › Notifications", "A9"],
  "page:maintenance": ["MAINT", "Tools › Maintenance", "Activity › Maintenance", "A9"],
  "page:security": ["SEC", "More › Security (includes Phone Access)", "Security", "A9"],
  "page:owner-workspace": ["OWNER", "Anx Workspace (owner only)", "Anx Workspace (owner only)", "A9"],
  "page:agent-control": ["AGENT", "Tools › Agent Control", "Computers › Agent Control", "A5"],
  "page:nodes": ["NODES", "Computers and AnxNet", "Computers › Overview and AnxNet", "A5"],
  "page:network": ["NET", "Tools › Network", "Network › Addresses and endpoints", "A7"],
  "page:settings": ["SET", "Settings", "Settings", "A9"],
  // Regions outside the pages (index.html)
  "region:startup-screen": ["SHELL", "Startup splash", "Shell › Startup splash", "A1"],
  "region:security-gate": ["GATE", "Local Owner sign-in gate", "Shell › Sign-in gate (session persistence in 216-E)", "A1"],
  "region:local-setup-gate": ["GATE", "Local setup gate", "Shell › Local setup gate", "A1"],
  "region:titlebar": ["TITLE", "Custom title bar", "Shell › Title bar", "A1"],
  "region:global-search": ["SEARCH", "Global search (Ctrl+K)", "Shell › Global search", "A1"],
  "region:command-palette": ["PALETTE", "Command palette (Ctrl+Shift+P)", "Shell › Command palette", "A1"],
  "region:sidebar": ["NAV", "Sidebar navigation", "Shell › Sidebar (new information architecture)", "A1"],
  "region:node-picker": ["NAV", "Computer switcher popover", "Shell › Computer switcher", "A1"],
  "region:shell": ["SHELL", "App shell", "Shell", "A1"],
  "region:node-modal": ["NODES", "Add or edit computer dialog", "Computers › Add or edit computer", "A5"],
  "region:endpoint-modal": ["NET", "Endpoint dialog", "Network › Endpoint dialog", "A7"],
  "region:instance-endpoint-picker": ["NET", "Server endpoint picker", "Network › Endpoint picker", "A7"],
  "region:node-details-modal": ["NODES", "Computer details drawer", "Computers › Computer details", "A5"],
  "region:update-ready-banner": ["UPDATE", "Update ready banner", "Shell › Update banner", "A1"],
  "region:update-modal": ["UPDATE", "Update dialog", "Shell › Update dialog", "A1"],
  "region:dev-update-modal": ["UPDATE", "Developer update dialog", "Shell › Developer update dialog", "A1"],
  "region:onboarding-welcome": ["ONBOARD", "Onboarding welcome", "Shell › Onboarding", "A1"],
  "region:onboarding-wizard": ["ONBOARD", "Onboarding wizard", "Shell › Onboarding", "A1"],
  "region:contextual-help-modal": ["HELP", "Contextual help", "Shell › Contextual help", "A1"],
  "region:fivem-setup-modal": ["SRV", "FiveM setup dialog", "My Servers › FiveM setup", "A3"],
  // Build 216-A8: Add Storage in the main window (it was its own window).
  "region:add-storage-modal": ["FILES", "Add Storage dialog", "Files › Add Storage inside the main window", "A8"],
  "region:toast": ["SHELL", "Toasts", "Shell › Toasts", "A1"],
  "region:assistant-panel": ["ASSIST", "Assistant panel", "Shell › Assistant panel", "A1"],
  // Build 216-A1 shell additions.
  "region:operation-tray": ["TRAY", "Operation tray", "Shell › Operation tray", "A1"],
  // Other surfaces
  "shared-dialogs": ["DIALOG", "Dialogs built in app.js", "Shell › Shared dialog pattern", "A1"],
  "shortcuts": ["KEYS", "Keyboard shortcuts", "Shell › Keyboard shortcuts", "A1"],
  "window:main": ["WIN", "Main window (frameless, custom title bar)", "Shell › Main window", "A1"],
  "window:workspace": ["WIN", "Separate Marketplace / Create Server windows", "Retire: Add Server moves into the main window", "A4"],
  "window:add-storage": ["WIN", "Separate Add Storage window", "Files › Add Storage inside the main window", "A8"],
  "window:diagnostic": ["WIN", "Startup diagnostic window", "Keep (minimal restyle)", "A1"],
  // Phone
  "phone:shell": ["PHONE", "Phone PWA shell and bottom tabs", "Phone › Shell", "C"],
  "phone:screen": ["PHONE", "Phone PWA screens", "Phone › Screens", "C"],
  "phone:server-tab": ["PHONE", "Phone server tabs", "Phone › Server view", "C"],
  "phone:api": ["PHONEAPI", "Phone gateway API (src/mobile/api.js)", "Keep unchanged (phone UI calls it)", "C"],
};

// Preload namespace -> the area whose redesign owns its UI callers.
const NAMESPACE_AREA = {
  app: "region:shell", diagnostics: "page:settings", agentControl: "page:agent-control", updates: "region:update-modal",
  developerUpdates: "region:dev-update-modal", maintenance: "page:maintenance", account: "region:security-gate",
  window: "region:titlebar", anxWindow: "region:titlebar", system: "page:dashboard", amp: "page:dashboard", playit: "page:playit",
  anxnet: "page:nodes", mobile: "page:security", networkInventory: "page:network", webhookAlerts: "page:settings",
  infrastructureInventory: "page:nodes", publicAccess: "page:playit", docker: "page:docker", marketplace: "page:marketplace",
  dependencies: "page:marketplace", instances: "page:instances", actions: "page:instances", backups: "page:backups",
  workload: "page:instances", nodes: "page:nodes", alerts: "page:notifications", endpoints: "page:network",
  connectivity: "page:network", providers: "page:network", telemetry: "page:dashboard", notifications: "page:notifications",
  computers: "page:nodes", files: "page:files", storageWindow: "window:add-storage", ssh: "page:ssh", ai: "region:assistant-panel",
  settings: "page:settings", security: "page:security", ownerWorkspace: "page:owner-workspace",
};

// Hook attributes created only in JavaScript (not present in index.html).
const DYNAMIC_ATTR_AREA = {
  "agent-summary-action": "page:nodes", "public-access-action": "page:playit", "docker-recovery-action": "page:docker",
  "docker-row-action": "page:docker", "instance-row-action": "page:instances", "marketplace-installed-action": "page:marketplace",
  "first-server-action": "page:dashboard", "node-health-action": "page:nodes", "node-card-action": "page:nodes",
  "endpoint-action": "page:network", "stage-action": "page:network", "docker-section": "page:docker",
  "attention-action": "page:dashboard", "servers-bulk-action": "page:instances",
};

// Renderer modules -> area, for hooks they create that index.html does not have.
const MODULE_AREA = {
  "addonsTab.js": "page:instances", "agentAutoUpdate.js": "page:agent-control", "anxnetPanel.js": "page:nodes",
  "assistantPanel.js": "region:assistant-panel", "dockerWorkspace.js": "page:docker", "dropNavigationGuard.js": "region:shell",
  "filesDrop.js": "page:files", "homeDashboard.js": "page:dashboard", "phoneAccessPanel.js": "page:security",
  "playersPanel.js": "page:instances", "serverBackups.js": "page:instances", "serverFleet.js": "page:instances",
  "serverView.js": "page:instances", "serversList.js": "page:instances", "sshConnections.js": "page:ssh",
};

// Dialogs built in JavaScript: enclosing function name -> area (first match wins).
const DIALOG_AREA = [
  [/marketplace|install|template|createserver|provider|modpack|dependenc|catalog|wizard/i, "page:marketplace"],
  [/docker|container|compose|image/i, "page:docker"],
  [/backup|restore/i, "page:backups"],
  [/node|computer|agent|pair/i, "page:nodes"],
  [/ssh|terminal/i, "page:ssh"],
  [/file|storage|editor/i, "page:files"],
  [/share|playit|public|endpoint|network|tunnel/i, "page:playit"],
  [/security|owner|password|permission|credential|token|phone|mobile/i, "page:security"],
  [/instance|server|mod|player|console|fivem|restart/i, "page:instances"],
  [/update/i, "region:update-modal"],
  [/setting/i, "page:settings"],
];

const ACTIONISH = /(?:-action|-target|-tab|-section-target|-category-target)$/;
const REGION_MARKERS = [
  "startup-screen", "security-gate", "local-setup-gate", "app-shell:shell", "titlebar", "global-search", "command-palette",
  "sidebar", "node-picker", "node-modal", "endpoint-modal", "instance-endpoint-picker", "node-details-modal",
  "update-ready-banner", "update-modal", "dev-update-modal", "onboarding-welcome", "onboarding-wizard",
  "contextual-help-modal", "add-storage-modal", "fivem-setup-modal", "assistant-panel",
  // Build 216-A1: the operation tray and the page host (the <main> that holds every page).
  "operation-tray", "page-host:shell",
];

// ---------------------------------------------------------------- helpers

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

const slug = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";
const clean = (value, max = 70) => String(value || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;|&amp;|&middot;|&rarr;|&hellip;/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const camelToKebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function attributes(tagText) {
  const attrs = [];
  for (const m of tagText.matchAll(/\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs.push({ name: m[1], value: m[3] ?? m[4] ?? m[5] ?? null });
  }
  return attrs;
}

// ---------------------------------------------------------------- index.html

function indexHtmlRows() {
  const html = read("index.html");
  const lineOf = lineIndex(html);
  const lines = html.split("\n");
  const regionStarts = [];
  lines.forEach((text, i) => {
    const page = text.match(/<section class="page[^"]*" data-page="([^"]+)"/);
    if (page) { regionStarts.push({ line: i + 1, key: `page:${page[1]}` }); return; }
    if (/<\/main>/.test(text)) { regionStarts.push({ line: i + 1, key: "region:shell" }); return; }
    if (/\sid="toast"/.test(text)) { regionStarts.push({ line: i + 1, key: "region:toast" }); return; }
    for (const marker of REGION_MARKERS) {
      const [attr, alias] = marker.split(":");
      if (new RegExp(`\\sdata-${attr}(?=[\\s>])`).test(text)) { regionStarts.push({ line: i + 1, key: `region:${alias || attr}` }); return; }
    }
  });
  const regionAt = (line) => {
    let key = null;
    for (const start of regionStarts) if (start.line <= line) key = start.key; else break;
    return key;
  };

  const rows = [];
  const bodyStart = html.indexOf("<body");
  for (const m of html.matchAll(/<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g)) {
    if (m.index < bodyStart) continue;
    const tag = m[1].toLowerCase();
    if (["script", "link", "meta", "style", "svg", "path", "circle", "rect", "line", "polyline", "polygon", "g", "use", "img", "br", "span", "strong", "small", "p", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "code", "pre", "em", "b", "i", "kbd", "label", "option", "dt", "dd", "dl", "table", "thead", "tbody", "tr", "td", "th", "fieldset", "legend", "header", "footer", "article", "figure", "picture", "time", "abbr", "output", "progress", "meter", "template"].includes(tag)) continue;
    const line = lineOf(m.index);
    const attrs = attributes(m[2]);
    const data = attrs.filter((a) => a.name.startsWith("data-") && a.name !== "data-tooltip");
    const get = (name) => attrs.find((a) => a.name === name)?.value;
    const region = regionAt(line);
    let label = get("aria-label") || get("title") || get("placeholder") || get("data-tooltip") || "";
    if (!label && ["button", "a", "summary"].includes(tag)) {
      const end = html.indexOf(`</${tag}>`, m.index);
      if (end > 0 && end - m.index < 4000) label = html.slice(m.index + m[0].length, end);
    }
    label = clean(label);
    const push = (kind, hook, extra = {}) => rows.push({ source: "index.html", line, region, kind, hook, label, tag, ...extra });

    if (tag === "section" && get("data-page")) { push("page", `data-page=${get("data-page")}`); continue; }
    const actionish = data.filter((a) => a.value !== null && ACTIONISH.test(a.name.slice(5)));
    if (actionish.length) {
      for (const a of actionish) {
        const name = a.name.slice(5);
        const kind = name === "page-target" ? "nav" : /-action$/.test(name) ? "action" : "tab";
        push(kind, `data-${name}=${a.value}`);
      }
      continue;
    }
    if (get("role") === "dialog" || tag === "dialog") { push("dialog", data[0] ? `data-${data[0].name.slice(5)}${data[0].value ? `=${data[0].value}` : ""}` : `#${get("id") || slug(label)}`); continue; }
    if (["input", "select", "textarea"].includes(tag)) {
      const hook = data.find((a) => a.value !== null) || data[0];
      push("input", hook ? `data-${hook.name.slice(5)}${hook.value !== null ? `=${hook.value}` : ""}` : get("id") ? `#${get("id")}` : get("name") ? `name=${get("name")}` : null, { inputType: get("type") || tag });
      continue;
    }
    if (["button", "summary"].includes(tag) || (tag === "a" && (data.length || get("href")?.startsWith("http")))) {
      const hook = data[0];
      push("control", hook ? `data-${hook.name.slice(5)}${hook.value !== null ? `=${hook.value}` : ""}` : get("id") ? `#${get("id")}` : null);
    }
  }
  return { rows, regionStarts };
}

// ---------------------------------------------------------------- JavaScript-created hooks

function enclosingFunction(lines, lineNumber) {
  for (let i = lineNumber - 1; i >= 0 && i > lineNumber - 400; i -= 1) {
    const m = lines[i].match(/^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/) || lines[i].match(/^\s*(?:const|let)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/);
    if (m) return m[1];
  }
  return "";
}

function jsRows(htmlAttrRegions) {
  const files = [["app.js", read("app.js")], ...fs.readdirSync(path.join(root, "src/renderer")).filter((f) => f.endsWith(".js")).sort().map((f) => [`src/renderer/${f}`, read(`src/renderer/${f}`)])];
  const rows = [];
  for (const [file, text] of files) {
    const lineOf = lineIndex(text);
    const lines = text.split("\n");
    const moduleArea = MODULE_AREA[path.basename(file)] || null;
    const areaForAttr = (name) => {
      const regions = htmlAttrRegions.get(name);
      if (regions && regions.size === 1) return [...regions][0];
      if (DYNAMIC_ATTR_AREA[name]) return DYNAMIC_ATTR_AREA[name];
      if (moduleArea) return moduleArea;
      if (regions && regions.size > 1) return [...regions][0];
      return null;
    };
    const add = (name, value, index) => {
      if (!ACTIONISH.test(name)) return;
      const kind = name === "page-target" ? "nav" : /-action$/.test(name) ? "action" : "tab";
      const line = lineOf(index);
      rows.push({ source: file, line, region: areaForAttr(name), kind, hook: `data-${name}=${value ?? "*"}`, label: value === null ? `values computed in ${enclosingFunction(lines, line) || "code"}` : "", tag: "js" });
    };
    for (const m of text.matchAll(/dataset\.([a-zA-Z0-9]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`|([^;\n]+))/g)) add(camelToKebab(m[1]), m[2] ?? m[3] ?? m[4] ?? null, m.index);
    for (const m of text.matchAll(/setAttribute\(\s*["']data-([a-z0-9-]+)["']\s*,\s*(?:"([^"]*)"|'([^']*)'|([^)]+))\)/g)) add(m[1], m[2] ?? m[3] ?? null, m.index);
    for (const m of text.matchAll(/data-([a-z0-9-]+)=\\?"([^"\\$]*)\\?"/g)) add(m[1], m[2], m.index);

    // Dialogs built in code.
    const seen = new Set();
    for (const m of text.matchAll(/(?:setAttribute\(\s*["']role["']\s*,\s*["']dialog["']|\.role\s*=\s*["']dialog["']|role:\s*["']dialog["'])/g)) {
      const line = lineOf(m.index);
      const fn = enclosingFunction(lines, line) || `line-${line}`;
      if (seen.has(fn)) continue;
      seen.add(fn);
      const area = moduleArea && moduleArea !== "region:shell" ? moduleArea : (DIALOG_AREA.find(([re]) => re.test(fn))?.[1] || "shared-dialogs");
      rows.push({ source: file, line, region: area, kind: "dialog", hook: `fn:${fn}`, label: `dialog built by ${fn}()`, tag: "js" });
    }
    // Keyboard shortcuts.
    if (file === "app.js") {
      lines.forEach((text2, i) => {
        if (!/(ctrlKey|metaKey)/.test(text2)) return;
        const key = text2.match(/\.key(?:\.toLowerCase\(\))?\s*===?\s*["']([^"']+)["']/);
        if (!key) return;
        const combo = `${/shiftKey/.test(text2) ? "Shift+" : ""}${key[1]}`;
        rows.push({ source: file, line: i + 1, region: "shortcuts", kind: "shortcut", hook: `key:Ctrl+${combo}`, label: clean(text2, 70), tag: "js" });
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------- windows

function windowRows() {
  const text = read("main.js");
  const lines = text.split("\n");
  const rows = [];
  lines.forEach((line, i) => {
    if (!/new BrowserWindow\(/.test(line)) return;
    const fn = enclosingFunction(lines, i + 1);
    const key = /workspace/i.test(line + fn) ? "window:workspace" : /addStorage/i.test(line + fn) ? "window:add-storage" : /diagnostic/i.test(line + fn) ? "window:diagnostic" : "window:main";
    rows.push({ source: "main.js", line: i + 1, region: key, kind: "window", hook: `window:${key.split(":")[1]}`, label: `BrowserWindow in ${fn || "main.js"}()`, tag: "main" });
  });
  return rows;
}

// ---------------------------------------------------------------- preload / IPC

function loadPreloadApi() {
  const exposed = {};
  const fake = {
    contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
    ipcRenderer: { invoke() {}, send() {}, on() {}, once() {}, off() {}, removeListener() {}, removeAllListeners() {} },
  };
  const originalLoad = Module._load;
  Module._load = function load(request, ...rest) { return request === "electron" ? fake : originalLoad.call(this, request, ...rest); };
  const listenersBefore = { u: process.listeners("uncaughtException"), r: process.listeners("unhandledRejection") };
  try {
    const preloadPath = path.join(root, "preload.js");
    delete require.cache[preloadPath];
    require(preloadPath);
  } finally {
    Module._load = originalLoad;
    for (const l of process.listeners("uncaughtException")) if (!listenersBefore.u.includes(l)) process.off("uncaughtException", l);
    for (const l of process.listeners("unhandledRejection")) if (!listenersBefore.r.includes(l)) process.off("unhandledRejection", l);
  }
  const methods = [];
  const walk = (obj, prefix) => {
    for (const [key, value] of Object.entries(obj || {})) {
      if (typeof value === "function") {
        const source = value.toString();
        const channel = (source.match(/["'`]([a-zA-Z][a-zA-Z0-9-]*:[a-zA-Z0-9:._-]+)["'`]/) || [])[1] || "";
        methods.push({ path: [...prefix, key], channel });
      } else if (value && typeof value === "object") walk(value, [...prefix, key]);
    }
  };
  walk(exposed.anx, []);
  walk(exposed.anxWindow, ["anxWindow"]);
  return { methods, globals: Object.keys(exposed) };
}

function ipcRows(uiText) {
  const { methods } = loadPreloadApi();
  const nameCount = new Map();
  for (const method of methods) {
    const name = method.path[method.path.length - 1];
    nameCount.set(name, (nameCount.get(name) || 0) + 1);
  }
  const prepared = uiText.map(([file, text]) => [file, text, lineIndex(text), text.split("\n")]);
  return methods.map((method) => {
    const dotted = method.path.join(".");
    const name = method.path[method.path.length - 1];
    const esc = (v) => v.replace(/[$]/g, "\\$");
    const exact = new RegExp(`\\b${method.path.map(esc).join("\\??\\.")}\\s*(?:\\?\\.)?\\(`, "g");
    const byName = new RegExp(`(?:\\??\\.${esc(name)}\\s*(?:\\?\\.)?\\(|["']${esc(name)}["'])`, "g");
    const nsToken = new RegExp(`\\b(?:api|desktopApi|bridge)?\\??\\.${esc(method.path[0])}\\b|["']${esc(method.path[0])}["']`);
    const callers = [];
    let match = "exact";
    for (const [file, text, lineOf] of prepared) for (const m of text.matchAll(exact)) callers.push(`${file}:${lineOf(m.index)}`);
    if (!callers.length) {
      // Renderer code usually aliases a namespace first (const api = ...instances; api.safeRestart()).
      match = nameCount.get(name) === 1 ? "by method name" : "by method name near its namespace";
      for (const [file, text, lineOf, lines] of prepared) {
        for (const m of text.matchAll(byName)) {
          const line = lineOf(m.index);
          if (nameCount.get(name) > 1 && !file.endsWith(".html")) {
            const windowText = lines.slice(Math.max(0, line - 40), line + 5).join("\n");
            if (!nsToken.test(windowText)) continue;
          }
          callers.push(`${file}:${line}`);
        }
      }
    }
    // No call found: classify what evidence the renderer does have.
    let evidence = null;
    if (!callers.length) {
      const suffix = (name.match(/[A-Z][a-z]+$/) || [""])[0];
      const probes = [
        ["feature-detected with typeof", new RegExp(`typeof[^;]*\\.${esc(name)}\\b`)],
        ["method name built at runtime", suffix ? new RegExp(`\\$\\{[^}]+\\}${suffix}\\b`) : null],
        ["referenced without a direct call", new RegExp(`[.?"']${esc(name)}\\b`)],
      ];
      for (const [label, re] of probes) {
        if (!re) continue;
        for (const [file, , , lines] of prepared) {
          const index = lines.findIndex((l) => re.test(l));
          if (index >= 0) { evidence = `${label} (${file}:${index + 1})`; break; }
        }
        if (evidence) break;
      }
      if (!evidence) evidence = "no reference in the renderer (candidate unused by the UI; backend kept)";
    }
    return {
      source: "preload.js",
      line: 0,
      region: NAMESPACE_AREA[method.path[0]] || null,
      kind: "ipc",
      hook: `api.${dotted}`,
      label: method.channel,
      channel: method.channel,
      callers,
      callerMatch: callers.length ? match : "none",
      evidence,
      tag: "ipc",
    };
  });
}

// ---------------------------------------------------------------- phone

function phoneRows() {
  const rows = [];
  const web = read("src/mobile/web/app.js");
  const webLines = web.split("\n");
  const html = read("src/mobile/web/index.html");
  html.split("\n").forEach((line, i) => {
    const tab = line.match(/data-tab="([^"]+)"/);
    if (tab) rows.push({ source: "src/mobile/web/index.html", line: i + 1, region: "phone:shell", kind: "phone-tab", hook: `phone-tab=${tab[1]}`, label: clean(line.replace(/.*data-tab="[^"]+"[^>]*>/, ""), 40), tag: "phone" });
  });
  webLines.forEach((line, i) => {
    const m = line.match(/^\s*function (render[A-Z][A-Za-z]*)\(/);
    if (m) rows.push({ source: "src/mobile/web/app.js", line: i + 1, region: "phone:screen", kind: "phone-screen", hook: `phone-fn:${m[1]}`, label: m[1].replace(/^render/, ""), tag: "phone" });
  });
  const svm = read("src/shared/serverViewModel.js");
  const tabs = JSON.parse((svm.match(/MAIN_TABS = Object\.freeze\((\[[^\]]*\])\)/) || [])[1].replace(/'/g, '"'));
  const svmLine = svm.split("\n").findIndex((l) => /MAIN_TABS = /.test(l)) + 1;
  for (const tab of tabs) rows.push({ source: "src/shared/serverViewModel.js", line: svmLine, region: "phone:server-tab", kind: "phone-tab", hook: `server-tab=${tab}`, label: `server tab ${tab}`, tag: "phone" });
  const api = read("src/mobile/api.js");
  const apiLines = api.split("\n");
  apiLines.forEach((line, i) => {
    const m = line.match(/route\(\s*"([A-Z]+)"\s*,\s*(?:"([^"]+)"|`([^`]+)`|([A-Za-z_][A-Za-z0-9_]*))\s*,\s*"([^"]+)"/);
    if (!m) return;
    const routePath = (m[2] || m[3] || "${" + m[4] + "}").replace(/\$\{serverPath\}/, "/servers/:nodeId/:instanceId");
    const tail = routePath.split("/").filter((p) => p && !p.startsWith(":")).slice(-2).join("/");
    const callers = [];
    webLines.forEach((w, j) => { if (tail && w.includes(`/${tail}`)) callers.push(`src/mobile/web/app.js:${j + 1}`); });
    rows.push({ source: "src/mobile/api.js", line: i + 1, region: "phone:api", kind: "phone-api", hook: `${m[1]} ${routePath}`, label: `permission ${m[5]}`, callers, tag: "phone" });
  });
  return rows;
}

// ---------------------------------------------------------------- marketplace catalog

function templateRows() {
  const text = read("config/marketplace-templates.json");
  const lines = text.split("\n");
  const templates = JSON.parse(text);
  return templates.map((template) => {
    const line = lines.findIndex((l) => l.includes(`"id": "${template.id}"`)) + 1;
    const flags = [template.disabled || template.comingSoon ? "disabled/coming soon" : "", template.experimental ? "experimental" : ""].filter(Boolean).join(", ");
    return {
      source: "config/marketplace-templates.json",
      line,
      region: "page:marketplace",
      kind: "template",
      hook: `template:${template.id}`,
      label: `${template.displayName} · ${template.category} · ${template.installerType} · badge ${template.icon}${flags ? ` · ${flags}` : ""}`,
      tag: "catalog",
    };
  });
}

// ---------------------------------------------------------------- tests

function loadTests() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) { if (!["node_modules", "fixtures"].includes(entry.name)) walk(rel); continue; }
      if (!/\.(js|mjs|cjs)$/.test(entry.name)) continue;
      if (/anxhost-capability-inventory|anxhost-ui-baseline-capture/.test(entry.name)) continue;
      out.push([rel, read(rel)]);
    }
  };
  walk("scripts");
  walk("test-helpers");
  return out;
}

function testsFor(row, tests) {
  const hook = row.hook || "";
  let match;
  if (row.kind === "page") {
    const name = hook.split("=")[1];
    match = (t) => t.includes(`data-page="${name}"`) || t.includes(`data-page=${name}]`) || t.includes(`data-page='${name}'`) || t.includes(`data-page=\\"${name}\\"`) || t.includes(`showPage("${name}")`) || t.includes(`showPage('${name}')`) || t.includes(`page-target="${name}"`) || t.includes(`page-target=${name}]`);
  } else if (hook.startsWith("data-")) {
    const [attr, value] = hook.split("=");
    if (value === undefined || value === "*") match = (t) => new RegExp(`${attr.replace(/[-]/g, "\\-")}(?![a-z0-9-])`).test(t);
    else match = (t) => t.includes(attr) && (t.includes(`"${value}"`) || t.includes(`'${value}'`) || t.includes(`=${value}]`) || t.includes(`=\\"${value}\\"`));
  } else if (row.kind === "ipc") {
    const dotted = hook.slice(4);
    match = (t) => (row.channel && t.includes(`"${row.channel}"`)) || t.includes(`.${dotted}(`);
  } else if (hook.startsWith("fn:")) {
    const fn = hook.slice(3);
    match = (t) => t.includes(fn);
  } else if (row.kind === "phone-api") {
    const p = hook.split(" ")[1].split("/").filter((s) => s && !s.startsWith(":")).slice(-2).join("/");
    match = (t) => t.includes(`/${p}`);
  } else if (hook.startsWith("phone-tab=") || hook.startsWith("server-tab=")) {
    const v = hook.split("=")[1];
    match = (t) => /mobile/.test(t.slice(0, 4000)) && t.includes(`"${v}"`);
  } else if (hook.startsWith("template:")) {
    const id = hook.slice(9);
    match = (t) => t.includes(`"${id}"`) || t.includes(`'${id}'`);
  } else if (hook.startsWith("phone-fn:")) {
    match = (t) => t.includes(hook.slice(9));
  } else if (hook.startsWith("#")) {
    const id = hook.slice(1);
    match = (t) => t.includes(`#${id}`) || t.includes(`id="${id}"`);
  } else if (hook.startsWith("window:")) {
    const key = hook.slice(7);
    const needle = { main: "firstWindow", workspace: "openWorkspace", "add-storage": "storageWindow", diagnostic: "startup diagnostic" }[key] || key;
    match = (t) => t.includes(needle);
  } else if (hook.startsWith("key:")) {
    const k = hook.split("+").pop();
    match = (t) => t.includes(`Control+${k}`) || t.includes(`Control+Shift+${k}`) || (t.includes("ctrlKey") && t.includes(`"${k}"`));
  } else return [];
  return tests.filter(([, text]) => match(text)).map(([rel]) => rel.replace(/^scripts\//, ""));
}

// ---------------------------------------------------------------- assemble

const KIND_CODE = { page: "PAGE", nav: "NAV", tab: "TAB", action: "ACT", input: "IN", control: "CTL", dialog: "DLG", shortcut: "KEY", window: "WIN", ipc: "IPC", "phone-tab": "TAB", "phone-screen": "SCR", "phone-api": "API", template: "TPL" };
const WAVE_ORDER = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "C"];

function buildInventory() {
  const { rows: htmlRows } = indexHtmlRows();
  const htmlAttrRegions = new Map();
  for (const row of htmlRows) {
    const attr = (row.hook || "").match(/^data-([a-z0-9-]+)/)?.[1];
    if (!attr) continue;
    if (!htmlAttrRegions.has(attr)) htmlAttrRegions.set(attr, new Set());
    htmlAttrRegions.get(attr).add(row.region);
  }
  const uiText = [["app.js", read("app.js")], ...fs.readdirSync(path.join(root, "src/renderer")).filter((f) => f.endsWith(".js")).sort().map((f) => [`src/renderer/${f}`, read(`src/renderer/${f}`)]), ["windows/add-storage.js", read("windows/add-storage.js")], ["index.html", read("index.html")]];
  const all = [...htmlRows, ...jsRows(htmlAttrRegions), ...windowRows(), ...ipcRows(uiText), ...phoneRows(), ...templateRows()];

  // De-duplicate: one row per (area, kind, hook); hooks without a stable selector stay separate.
  const merged = new Map();
  const htmlHooks = new Set(htmlRows.map((r) => r.hook).filter(Boolean));
  for (const row of all) {
    if (row.tag === "js" && row.kind !== "dialog" && row.kind !== "shortcut" && htmlHooks.has(row.hook)) continue;
    const key = row.hook ? `${row.region}|${row.kind}|${row.hook}` : `${row.region}|${row.kind}|${row.source}:${row.line}`;
    const existing = merged.get(key);
    if (existing) { existing.occurrences += 1; continue; }
    merged.set(key, { ...row, occurrences: 1 });
  }

  const tests = loadTests();
  const used = new Map();
  const rows = [...merged.values()].map((row) => {
    const dest = DEST[row.region];
    const code = dest ? dest[0] : "UNMAPPED";
    const base = `CAP-${code}-${KIND_CODE[row.kind] || "X"}-${slug(row.hook ? row.hook.replace(/^data-/, "").replace(/^api\./, "") : `${row.label || "unlabelled"}`)}`;
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    const id = n === 1 ? base : `${base}-${n}`;
    const t = testsFor(row, tests);
    return {
      id, kind: row.kind, area: row.region || null, hook: row.hook || null, label: row.label || "",
      today: `${row.source}${row.line ? `:${row.line}` : ""}`, todayArea: dest ? dest[1] : null,
      destination: dest ? dest[2] : null, wave: dest ? dest[3] : null, stableHook: Boolean(row.hook),
      occurrences: row.occurrences, channel: row.channel || null, callers: row.callers || null, callerMatch: row.callerMatch || null, evidence: row.evidence || null,
      tests: t.slice(0, 4), testCount: t.length,
    };
  });
  rows.sort((a, b) => WAVE_ORDER.indexOf(a.wave) - WAVE_ORDER.indexOf(b.wave) || String(a.area).localeCompare(String(b.area)) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return rows;
}

// ---------------------------------------------------------------- output

function previousTicks() {
  if (!fs.existsSync(MD_PATH)) return new Set();
  const ticks = new Set();
  for (const m of fs.readFileSync(MD_PATH, "utf8").matchAll(/^\| \[x\] \| (CAP-[^ |]+)/gm)) ticks.add(m[1]);
  return ticks;
}

const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");

function renderMarkdown(rows, ticks) {
  const byWave = new Map();
  for (const row of rows) {
    const wave = row.wave || "UNMAPPED";
    if (!byWave.has(wave)) byWave.set(wave, []);
    byWave.get(wave).push(row);
  }
  const count = (pred) => rows.filter(pred).length;
  const kinds = {};
  for (const row of rows) kinds[row.kind] = (kinds[row.kind] || 0) + 1;
  const desktopRows = rows.filter((r) => !String(r.area).startsWith("phone:"));
  const phoneRowsList = rows.filter((r) => String(r.area).startsWith("phone:"));
  const out = [];
  out.push("# Build 216 capability inventory (AnxHost CC)");
  out.push("");
  out.push("Generated by `node scripts/anxhost-capability-inventory.js` from the shipped UI sources (`index.html`, `app.js`, `src/renderer/*.js`, `main.js`, `preload.js`, `src/mobile/web/*`, `src/mobile/api.js`, `src/shared/serverViewModel.js`). Do not edit rows by hand; edit the generator or the UI and regenerate. Ticks in the first column are kept when the file is regenerated.");
  out.push("");
  out.push("`npm run anxhost-capability-inventory:smoke` fails when a row is unmapped or when the UI and this inventory disagree (a hook was removed or added without regenerating). During 216-A every wave keeps its rows working, ticks them here after verification, and regenerates deliberately when a hook changes.");
  out.push("");
  out.push("## Summary");
  out.push("");
  out.push("| Measure | Count |");
  out.push("| --- | --- |");
  out.push(`| Rows (capabilities) | ${rows.length} |`);
  out.push(`| Desktop rows | ${desktopRows.length} |`);
  out.push(`| Phone rows | ${phoneRowsList.length} |`);
  out.push(`| **Unmapped rows** | **${count((r) => !r.destination)}** |`);
  out.push(`| Rows with a stable hook (selector, function, route or IPC method) | ${count((r) => r.stableHook)} |`);
  out.push(`| Rows without a stable hook (need a \`data-testid\` in 216-A) | ${count((r) => !r.stableHook)} |`);
  out.push(`| Rows referenced by at least one test script | ${count((r) => r.testCount > 0)} |`);
  out.push(`| Verified in 216 (ticked) | ${rows.filter((r) => ticks.has(r.id)).length} |`);
  for (const [kind, n] of Object.entries(kinds).sort()) out.push(`| Kind \`${kind}\` | ${n} |`);
  out.push("");
  out.push("## Rows by wave");
  out.push("");
  out.push("| Wave | Rows | Destinations |");
  out.push("| --- | --- | --- |");
  for (const wave of [...WAVE_ORDER, "UNMAPPED"]) {
    const list = byWave.get(wave);
    if (!list) continue;
    out.push(`| ${wave} | ${list.length} | ${cell([...new Set(list.map((r) => r.destination))].join("; "))} |`);
  }
  out.push("");
  out.push("## Columns");
  out.push("");
  out.push("- **✓**: ticked once the row is verified working in its Build 216 destination.");
  out.push("- **Kind**: page, nav (sidebar target), tab (tab or section switch), action, input, control (button or link without an action attribute), dialog, shortcut, window, ipc (preload method), template (Marketplace catalog entry; each needs bundled artwork in A4), phone-screen, phone-tab, phone-api.");
  out.push("- **Hook**: the stable selector (`data-*` attribute and value), function, IPC method or route that identifies the capability. `*` means the value is computed at runtime.");
  out.push("- **Today**: file and line in Build 215 (`13825d70`); `×n` when the hook appears n times in that area.");
  out.push("- **Backend / IPC**: for ipc rows, the IPC channel and the UI files that call it; for phone-api rows, the phone UI caller. UI rows reach the backend through the ipc rows of the same area.");
  out.push("- **Tests**: test scripts in `scripts/` and `test-helpers/` that reference the hook (first four, then the total).");
  out.push("");
  const silentIpc = rows.filter((r) => r.kind === "ipc" && !r.callers.length);
  const ipcMatch = {};
  for (const row of rows.filter((r) => r.kind === "ipc")) ipcMatch[row.callerMatch] = (ipcMatch[row.callerMatch] || 0) + 1;
  out.push("## IPC notes");
  out.push("");
  out.push(`Preload exposes ${rows.filter((r) => r.kind === "ipc").length} methods (\`window.anx\` and its aliases, plus \`window.anxWindow\`). UI callers were found ${Object.entries(ipcMatch).map(([k, v]) => `${k}: ${v}`).join(", ")}. "By method name" covers the common pattern of aliasing a namespace first (\`const api = ...instances; api.safeRestart()\`).`);
  out.push("");
  out.push(`${silentIpc.length} methods have no direct call in the renderer. Each is classified by the evidence the renderer does contain, stays mapped to the area that owns it, and is confirmed by behaviour in its wave (the backend is unchanged in every case):`);
  out.push("");
  const byEvidence = new Map();
  for (const row of silentIpc) {
    const label = String(row.evidence || "unclassified").replace(/ \(.*\)$/, "");
    if (!byEvidence.has(label)) byEvidence.set(label, []);
    byEvidence.get(label).push(row);
  }
  out.push("| Evidence | Count | Methods (wave, where) |");
  out.push("| --- | --- | --- |");
  for (const [label, list] of byEvidence) {
    out.push(`| ${cell(label)} | ${list.length} | ${cell(list.map((r) => `\`${r.hook.slice(4)}\` (${r.wave}${/\((.*)\)$/.test(r.evidence || "") ? `, ${(r.evidence.match(/\(([^()]*)\)$/) || [])[1] || ""}` : ""})`).join(", "))} |`);
  }
  out.push("");
  for (const wave of [...WAVE_ORDER, "UNMAPPED"]) {
    const list = byWave.get(wave);
    if (!list) continue;
    out.push(`## Wave ${wave}`);
    out.push("");
    const byDest = new Map();
    for (const row of list) {
      const key = `${row.destination}`;
      if (!byDest.has(key)) byDest.set(key, []);
      byDest.get(key).push(row);
    }
    for (const [dest, destRows] of byDest) {
      const todayAreas = [...new Set(destRows.map((r) => r.todayArea))].join("; ");
      const namespaces = [...new Set(destRows.filter((r) => r.kind === "ipc").map((r) => r.hook.split(".")[1]))];
      out.push(`### ${dest}`);
      out.push("");
      out.push(`Today: ${todayAreas}. Rows: ${destRows.length}.${namespaces.length ? ` Backend namespaces owned here: ${namespaces.map((n) => `\`${n}\``).join(", ")}.` : ""}`);
      out.push("");
      out.push("| ✓ | ID | Kind | Hook | Label | Today | Backend / IPC | Tests |");
      out.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const row of destRows) {
        const backend = row.kind === "ipc" ? `\`${row.channel || "?"}\`; UI callers${row.callerMatch && row.callerMatch !== "exact" && row.callers.length ? ` (${row.callerMatch})` : ""}: ${row.callers.length ? row.callers.slice(0, 3).join(", ") + (row.callers.length > 3 ? ` +${row.callers.length - 3}` : "") : `no direct call: ${row.evidence || "unclassified"}`}`
          : row.kind === "phone-api" ? `UI: ${row.callers.length ? row.callers.slice(0, 2).join(", ") : "none found statically"}` : "";
        const tests = row.testCount ? `${row.tests.join(", ")}${row.testCount > row.tests.length ? ` (+${row.testCount - row.tests.length})` : ""}` : "none";
        out.push(`| ${ticks.has(row.id) ? "[x]" : "[ ]"} | ${row.id} | ${row.kind} | ${cell(row.hook ? `\`${row.hook}\`` : "(no stable hook)")} | ${cell(row.label)} | ${cell(row.today)}${row.occurrences > 1 ? ` ×${row.occurrences}` : ""} | ${cell(backend)} | ${cell(tests)} |`);
      }
      out.push("");
    }
  }
  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}

function main() {
  const check = process.argv.includes("--check");
  const rows = buildInventory();
  const unmapped = rows.filter((r) => !r.destination);
  if (check) {
    const failures = [];
    if (unmapped.length) failures.push(`${unmapped.length} unmapped row(s): ${unmapped.slice(0, 10).map((r) => `${r.today} ${r.hook}`).join("; ")}`);
    if (!fs.existsSync(JSON_PATH)) failures.push(`missing ${path.relative(root, JSON_PATH)}; run the generator`);
    else {
      const committed = new Set(JSON.parse(fs.readFileSync(JSON_PATH, "utf8")).rows.map((r) => r.id));
      const current = new Set(rows.map((r) => r.id));
      const removed = [...committed].filter((id) => !current.has(id));
      const added = [...current].filter((id) => !committed.has(id));
      if (removed.length) failures.push(`${removed.length} inventoried capability hook(s) no longer found in the UI: ${removed.slice(0, 15).join(", ")}${removed.length > 15 ? " ..." : ""}`);
      if (added.length) failures.push(`${added.length} UI hook(s) not in the inventory (regenerate deliberately): ${added.slice(0, 15).join(", ")}${added.length > 15 ? " ..." : ""}`);
    }
    if (failures.length) {
      for (const failure of failures) console.error(`FAIL ${failure}`);
      process.exitCode = 1;
      return;
    }
    console.log(`PASS capability inventory: ${rows.length} rows, 0 unmapped, UI matches docs/anxhost/capability-inventory.json`);
    return;
  }
  fs.mkdirSync(DOC_DIR, { recursive: true });
  const ticks = previousTicks();
  fs.writeFileSync(MD_PATH, renderMarkdown(rows, ticks));
  fs.writeFileSync(JSON_PATH, `${JSON.stringify({ generatedFrom: "scripts/anxhost-capability-inventory.js", rows: rows.map(({ id, kind, area, hook, wave, destination }) => ({ id, kind, area, hook, wave, destination })) }, null, 1)}\n`);
  console.log(`wrote ${rows.length} rows (${unmapped.length} unmapped) to ${path.relative(root, MD_PATH)} and ${path.relative(root, JSON_PATH)}`);
  if (unmapped.length) {
    for (const row of unmapped.slice(0, 40)) console.log(`  UNMAPPED ${row.today} ${row.kind} ${row.hook} ${row.label}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { buildInventory };
