#!/usr/bin/env node
"use strict";

// Build 216-A4 Marketplace artwork: generates one ORIGINAL SVG tile per
// Marketplace template into src/assets/anxhost/marketplace/<template-id>.svg.
//
// Every tile is drawn here from simple shapes (a tinted rounded square and a
// white pictogram); no third-party logo, screenshot or trademark is used, so
// each file's source is this script and its licence is the project's own
// (AnxLabs, UNLICENSED/proprietary, see docs/anxhost/MARKETPLACE_ART_SOURCES.md).
// The files are bundled with the app (no remote image is loaded) and the card
// falls back to the template's text monogram when a file is missing.
//
// Usage: node scripts/anxhost-marketplace-art.js          (write the files)
//        node scripts/anxhost-marketplace-art.js --check  (fail if any template
//               lacks art, a file is stale, or a file is not referenced)

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const OUT = path.join(root, "src", "assets", "anxhost", "marketplace");
const templatesFile = path.join(root, "config", "marketplace-templates.json");

// Pictograms on a 128 x 128 canvas, drawn in white over the tile.
const S = 'fill="none" stroke="#fff" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"';
const F = 'fill="#fff"';
const MOTIFS = {
  // Minecraft family: each a distinct shape and hue.
  "grass-cube": `<path ${S} d="M64 30 96 46v38L64 100 32 84V46z"/><path ${S} d="M32 46l32 16 32-16M64 62v38"/><path ${F} opacity=".35" d="M64 30 96 46 64 62 32 46z"/>`,
  "paper": `<path ${S} d="M40 28h34l16 16v56H40z"/><path ${S} d="M74 28v16h16M50 62h28M50 76h28M50 90h18"/>`,
  "pillar": `<path ${S} d="M44 30h40M44 98h40M50 30v68M78 30v68"/><path ${S} d="M50 52h28M50 76h28"/>`,
  "weave": `<path ${S} d="M34 46c10-8 20 8 30 0s20-8 30 0M34 64c10-8 20 8 30 0s20-8 30 0M34 82c10-8 20 8 30 0s20-8 30 0"/>`,
  "anvil": `<path ${S} d="M30 50h56c0 10 8 14 14 14H78v10l10 14H44l10-14V64H42c-8 0-12-6-12-14z"/>`,
  "anvil-spark": `<path ${S} d="M26 58h48c0 8 6 12 12 12H66v8l8 12H38l8-12v-8H36c-6 0-10-5-10-12z"/><path ${S} d="M92 28v16M84 36h16M86 30l12 12M98 30 86 42"/>`,
  "speed": `<path ${S} d="M36 40l24 24-24 24M62 40l24 24-24 24"/><path ${S} d="M90 52h8M90 76h8" opacity=".7"/>`,
  "falls": `<path ${S} d="M34 34h60"/><path ${S} d="M42 46c0 10 6 12 6 22s-6 12-6 22M64 46c0 10 6 12 6 22s-6 12-6 22M86 46c0 10 6 12 6 22s-6 12-6 22"/>`,
  "links": `<rect ${S} x="26" y="50" width="40" height="28" rx="14"/><rect ${S} x="62" y="50" width="40" height="28" rx="14"/>`,
  "strata": `<path ${S} d="M30 44h68M30 64h68M30 84h68"/><path ${S} d="M46 44v20M76 64v20M58 84v14M30 44v54h68V44"/>`,
  // Games.
  "sword": `<path ${S} d="M88 28 52 64l12 12 36-36V28z"/><path ${S} d="M40 64l24 24M46 82 34 94M36 84l8 8"/>`,
  "helm": `<path ${S} d="M36 76a28 28 0 0 1 56 0v10H36z"/><path ${S} d="M36 70c-10-4-14-16-10-28M92 70c10-4 14-16 10-28M64 50v36"/>`,
  "hexnut": `<path ${S} d="M64 28 95 46v36L64 100 33 82V46z"/><circle ${S} cx="64" cy="64" r="14"/>`,
  "crosshair": `<circle ${S} cx="64" cy="64" r="28"/><path ${S} d="M64 26v18M64 84v18M26 64h18M84 64h18"/><circle ${F} cx="64" cy="64" r="5"/>`,
  "pin": `<path ${S} d="M64 102s-26-26-26-46a26 26 0 0 1 52 0c0 20-26 46-26 46z"/><circle ${S} cx="64" cy="56" r="10"/>`,
  "paw": `<ellipse ${F} cx="64" cy="78" rx="18" ry="15"/><circle ${F} cx="40" cy="58" r="8"/><circle ${F} cx="54" cy="42" r="8"/><circle ${F} cx="74" cy="42" r="8"/><circle ${F} cx="88" cy="58" r="8"/>`,
  "crescent": `<path ${S} d="M78 30a34 34 0 1 0 22 50 28 28 0 1 1-22-50z"/><path ${S} d="M60 58l6 10 6-10" opacity=".8"/>`,
  "mist": `<path ${S} d="M30 50h44M44 64h54M30 78h48M54 92h34"/>`,
  "tent": `<path ${S} d="M64 32 28 96h72z"/><path ${S} d="M64 32v64M52 96l12-22 12 22"/>`,
  "flame": `<path ${S} d="M64 28c14 18 24 28 24 44a24 24 0 0 1-48 0c0-10 6-18 10-22 0 10 6 14 10 14 0-14-4-24 4-36z"/><path ${S} d="M40 102h48"/>`,
  "gear": `<circle ${S} cx="64" cy="64" r="16"/><path ${S} d="M64 28v12M64 88v12M28 64h12M88 64h12M39 39l8 8M81 81l8 8M89 39l-8 8M47 81l-8 8"/>`,
  "calendar": `<rect ${S} x="32" y="36" width="64" height="58" rx="8"/><path ${S} d="M32 52h64M48 28v14M80 28v14M56 66h16l-10 20"/>`,
  "wrench": `<path ${S} d="M84 30a18 18 0 0 0-22 24L32 84l12 12 30-30a18 18 0 0 0 24-22l-12 12-10-2-2-10z"/>`,
  "house": `<path ${S} d="M30 62 64 34l34 28M38 56v40h52V56"/><path ${S} d="M52 70h24M52 82h24"/>`,
  "footprint": `<path ${S} d="M64 98c-12 0-18-8-18-18s8-16 18-16 18 6 18 16-6 18-18 18z"/><path ${S} d="M44 56l-6-18M64 52V32M84 56l6-18"/>`,
  "rocket": `<path ${S} d="M64 26c16 12 20 32 14 52H50c-6-20-2-40 14-52z"/><circle ${S} cx="64" cy="54" r="7"/><path ${S} d="M50 78l-12 12v8l14-6M78 78l12 12v8l-14-6M58 92h12"/>`,
  "footprint-up": `<path ${S} d="M64 102c-10 0-16-7-16-15s7-14 16-14 16 5 16 14-6 15-16 15z"/><path ${S} d="M46 64l-5-14M64 60V44M82 64l5-14M50 34l14-10 14 10"/>`,
  "gem": `<path ${S} d="M42 34h44l14 22-36 44-36-44z"/><path ${S} d="M28 56h72M52 34l-8 22 20 44 20-44-8-22"/>`,
  "gears": `<circle ${S} cx="50" cy="56" r="14"/><path ${S} d="M50 30v8M50 74v8M24 56h8M68 56h8"/><circle ${S} cx="84" cy="84" r="10"/><path ${S} d="M84 66v6M84 96v6M66 84h6M96 84h6"/>`,
  "shield": `<path ${S} d="M64 28 94 38v24c0 20-14 34-30 40-16-6-30-20-30-40V38z"/><path ${S} d="M64 44v44M48 62h32"/>`,
  // Applications and services.
  "proxy": `<rect ${S} x="30" y="34" width="68" height="20" rx="6"/><rect ${S} x="30" y="74" width="68" height="20" rx="6"/><path ${S} d="M64 54v20M44 44h4M44 84h4"/>`,
  "play": `<rect ${S} x="28" y="34" width="72" height="60" rx="14"/><path ${F} d="M56 50v28l24-14z"/>`,
  "photo": `<rect ${S} x="28" y="34" width="72" height="60" rx="10"/><path ${S} d="M36 86l20-22 14 14 8-8 16 16"/><circle ${F} cx="82" cy="52" r="7"/>`,
  "cloud": `<path ${S} d="M44 90h44a18 18 0 0 0 0-36 26 26 0 0 0-50 6 15 15 0 0 0 6 30z"/>`,
  "branch": `<circle ${S} cx="42" cy="34" r="8"/><circle ${S} cx="42" cy="94" r="8"/><circle ${S} cx="86" cy="50" r="8"/><path ${S} d="M42 42v44M86 58c0 18-44 10-44 28"/>`,
  "heartbeat": `<path ${S} d="M26 66h20l8-20 14 40 10-28 6 8h18"/>`,
  "bars": `<path ${S} d="M32 96h64M40 96V70M56 96V50M72 96V60M88 96V36"/>`,
  "trend": `<path ${S} d="M30 94h68M30 94V34"/><path ${S} d="M38 82l18-18 14 10 22-28"/><circle ${F} cx="92" cy="46" r="6"/>`,
  "database": `<ellipse ${S} cx="64" cy="38" rx="28" ry="10"/><path ${S} d="M36 38v52c0 6 12 10 28 10s28-4 28-10V38M36 64c0 6 12 10 28 10s28-4 28-10"/>`,
  "database-wave": `<ellipse ${S} cx="64" cy="38" rx="28" ry="10"/><path ${S} d="M36 38v52c0 6 12 10 28 10s28-4 28-10V38"/><path ${S} d="M46 70c6-6 12 6 18 0s12 6 18 0"/>`,
  "database-bolt": `<ellipse ${S} cx="64" cy="38" rx="28" ry="10"/><path ${S} d="M36 38v52c0 6 12 10 28 10s28-4 28-10V38"/><path ${S} d="M68 56 56 74h14l-8 16"/>`,
  "bubble-code": `<path ${S} d="M30 40a8 8 0 0 1 8-8h52a8 8 0 0 1 8 8v36a8 8 0 0 1-8 8H58L42 98V84h-4a8 8 0 0 1-8-8z"/><path ${S} d="M54 48l-8 10 8 10M74 48l8 10-8 10"/>`,
  "bubble-bot": `<path ${S} d="M30 40a8 8 0 0 1 8-8h52a8 8 0 0 1 8 8v36a8 8 0 0 1-8 8H58L42 98V84h-4a8 8 0 0 1-8-8z"/><circle ${F} cx="52" cy="58" r="6"/><circle ${F} cx="76" cy="58" r="6"/>`,
  "code": `<path ${S} d="M48 42 28 64l20 22M80 42l20 22-20 22M70 34 58 94"/>`,
  "prompt": `<rect ${S} x="26" y="34" width="76" height="60" rx="10"/><path ${S} d="M40 54l12 10-12 10M60 76h22"/>`,
  "cup": `<path ${S} d="M36 52h48v20a20 20 0 0 1-20 20h-8a20 20 0 0 1-20-20z"/><path ${S} d="M84 58h6a10 10 0 0 1 0 20h-6M30 102h60M52 28c-4 6 4 10 0 16M68 28c-4 6 4 10 0 16"/>`,
  "folder-in": `<path ${S} d="M28 42a6 6 0 0 1 6-6h18l8 8h34a6 6 0 0 1 6 6v40a6 6 0 0 1-6 6H34a6 6 0 0 1-6-6z"/><path ${S} d="M64 56v24M54 70l10 10 10-10"/>`,
  "toolbox": `<rect ${S} x="28" y="50" width="72" height="44" rx="8"/><path ${S} d="M50 50v-8a6 6 0 0 1 6-6h16a6 6 0 0 1 6 6v8M28 68h72M58 68v8h12v-8"/>`,
  "document": `<path ${S} d="M40 28h34l16 16v56H40z"/><path ${S} d="M74 28v16h16"/><path ${S} d="M50 66h28M50 80h28"/>`,
};

// template id -> [motif, hue start, hue end]
const ART = {
  "minecraft-vanilla": ["grass-cube", "#3f9d4a", "#1f5f2e"],
  "minecraft-paper": ["paper", "#8fa3c8", "#34446a"],
  "minecraft-purpur": ["pillar", "#b25fd6", "#5e2a80"],
  "minecraft-fabric": ["weave", "#c9a46c", "#6f5332"],
  "minecraft-forge": ["anvil", "#d0743a", "#6f3214"],
  "minecraft-neoforge": ["anvil-spark", "#f08a3c", "#7a2f12"],
  "velocity": ["speed", "#3ba7d8", "#17506f"],
  "waterfall": ["falls", "#2f8fd8", "#173f7a"],
  "bungeecord": ["links", "#e0a23a", "#7a4d12"],
  "terraria-tshock": ["sword", "#4fae7a", "#235c3e"],
  "valheim": ["helm", "#8a6b4a", "#3b2a1c"],
  "rust": ["hexnut", "#c8553d", "#5c2014"],
  "cs2": ["crosshair", "#e3a33a", "#5e3d10"],
  "fivem": ["pin", "#f07a2f", "#7a3010"],
  "palworld": ["paw", "#3fb0c9", "#175766"],
  "v-rising": ["crescent", "#b3313f", "#4a0f18"],
  "enshrouded": ["mist", "#5b7fa6", "#22324a"],
  "unturned": ["tent", "#6e8f3c", "#2f4216"],
  "dont-starve-together": ["flame", "#9c5a2b", "#3b1d0b"],
  "satisfactory": ["gear", "#f0a33a", "#6e430f"],
  "seven-days-to-die": ["calendar", "#9b2f2f", "#3a0f0f"],
  "garrys-mod": ["wrench", "#3a86d8", "#163b6a"],
  "project-zomboid": ["house", "#7d8f5a", "#333d22"],
  "ark-survival-evolved": ["footprint", "#3d9c8c", "#164a42"],
  "space-engineers": ["rocket", "#4d6bd8", "#1c2a66"],
  "ark-survival-ascended": ["footprint-up", "#2fb3a0", "#0f5249"],
  "core-keeper": ["gem", "#7c5cd6", "#2f1f6a"],
  "factorio": ["gears", "#d08a2f", "#5a360c"],
  "hytale": ["shield", "#3f8fe0", "#1a3a70"],
  "docker-minecraft-bedrock": ["strata", "#5b6470", "#1f242b"],
  "docker-nginx": ["proxy", "#2fa06a", "#11452c"],
  "jellyfin": ["play", "#8a5cd6", "#2f6fd6"],
  "immich": ["photo", "#e0604f", "#3a6fd6"],
  "nextcloud": ["cloud", "#2f8fd8", "#124a7a"],
  "gitea": ["branch", "#5aa84a", "#24521c"],
  "uptime-kuma": ["heartbeat", "#2fbf80", "#0f5a3a"],
  "grafana": ["bars", "#f0a33a", "#c2402f"],
  "prometheus": ["trend", "#d8573a", "#5c1e10"],
  "postgresql": ["database", "#3f6fb0", "#18304f"],
  "mariadb": ["database-wave", "#b07a4a", "#3d2512"],
  "redis": ["database-bolt", "#d8433a", "#5a1310"],
  "discord-js": ["bubble-code", "#5865d8", "#262d6e"],
  "python-discord-bot": ["bubble-bot", "#4a78c0", "#d0a83a"],
  "node-app": ["code", "#4f9c3f", "#1f4a18"],
  "python-app": ["prompt", "#3a6fb0", "#c9a43a"],
  "java-app": ["cup", "#c0623a", "#4a2210"],
  "python-app-import": ["folder-in", "#3a6fb0", "#6a5a20"],
  "node-app-import": ["folder-in", "#4f9c3f", "#2a3a18"],
  "it-tools": ["toolbox", "#4aa0b0", "#1a4a52"],
  "stirling-pdf": ["document", "#d0453a", "#5a1712"],
};

function svgFor(id, [motif, from, to]) {
  const gradient = `ahx-art-${id}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-hidden="true">
  <!-- AnxHost CC Marketplace art: ${id}. Original artwork generated by scripts/anxhost-marketplace-art.js (Build 216-A4). -->
  <defs><linearGradient id="${gradient}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>
  <rect width="128" height="128" rx="28" fill="url(#${gradient})"/>
  <rect x="1.5" y="1.5" width="125" height="125" rx="26.5" fill="none" stroke="#fff" stroke-opacity=".14" stroke-width="3"/>
  ${MOTIFS[motif]}
</svg>
`;
}

const DOCS = path.join(root, "docs", "anxhost", "MARKETPLACE_ART_SOURCES.md");

function sourcesDoc(list) {
  const rows = list.map((template) => {
    const [motif, from, to] = ART[template.id];
    return `| \`src/assets/anxhost/marketplace/${template.id}.svg\` | ${template.displayName || template.id} | ${motif} | ${from} → ${to} | Original (this project) | AnxLabs, proprietary (UNLICENSED, as \`package.json\`) |`;
  });
  return `# Marketplace artwork: sources and licences

Generated by \`scripts/anxhost-marketplace-art.js\` (Build 216-A4); \`--check\`
fails when a template has no art, a file or this record is stale, or a file
belongs to no template.

Every file below is **original artwork made for AnxHost CC**: a tinted
rounded square and a white pictogram drawn from simple shapes in that script.
No third-party logo, trademark, screenshot or downloaded image is used, so no
outside permission is needed. The pictograms only suggest a genre or theme;
they are not the games' or products' marks. Files are bundled with the app
(no remote image is loaded; the CSP \`img-src\` is unchanged), and a card falls
back to the template's text monogram when its file cannot load.

The ten Minecraft-family entries (Vanilla, Paper, Purpur, Fabric, Forge,
NeoForge, Bedrock, Velocity, Waterfall, BungeeCord) each have a distinct
pictogram and colour.

| File | Template | Pictogram | Colours | Source | Licence |
| --- | --- | --- | --- | --- | --- |
${rows.join("\n")}
`;
}

function templates() {
  const raw = JSON.parse(fs.readFileSync(templatesFile, "utf8"));
  return Array.isArray(raw) ? raw : raw.templates || [];
}

function main() {
  const check = process.argv.includes("--check");
  const ids = templates().map((template) => template.id);
  const problems = [];
  for (const id of ids) if (!ART[id]) problems.push(`no art defined for template "${id}"`);
  for (const id of Object.keys(ART)) {
    if (!ids.includes(id)) problems.push(`art defined for unknown template "${id}"`);
    if (!MOTIFS[ART[id][0]]) problems.push(`unknown motif "${ART[id][0]}" for "${id}"`);
  }
  const mcFamily = ["minecraft-vanilla", "minecraft-paper", "minecraft-purpur", "minecraft-fabric", "minecraft-forge", "minecraft-neoforge", "docker-minecraft-bedrock", "velocity", "waterfall", "bungeecord"];
  const identities = new Set(mcFamily.map((id) => ART[id] && ART[id].join("|")));
  const motifs = new Set(mcFamily.map((id) => ART[id] && ART[id][0]));
  if (identities.size !== mcFamily.length || motifs.size !== mcFamily.length) problems.push("the 10 Minecraft-family entries must each have a distinct motif");
  if (problems.length) {
    problems.forEach((problem) => console.error(`FAIL ${problem}`));
    process.exitCode = 1;
    return;
  }
  if (!check) fs.mkdirSync(OUT, { recursive: true });
  let stale = 0;
  for (const id of ids) {
    const file = path.join(OUT, `${id}.svg`);
    const content = svgFor(id, ART[id]);
    if (check) {
      const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n") : null;
      if (current !== content) { console.error(`FAIL ${path.relative(root, file)} is missing or stale (run without --check)`); stale += 1; }
    } else {
      fs.writeFileSync(file, content);
    }
  }
  const extra = fs.existsSync(OUT) ? fs.readdirSync(OUT).filter((name) => name.endsWith(".svg") && !ids.includes(name.slice(0, -4))) : [];
  extra.forEach((name) => console.error(`FAIL ${name} belongs to no template`));
  // Source and licence record: one row per file (PLANS.md section 5).
  const docs = sourcesDoc(templates());
  if (check) {
    const current = fs.existsSync(DOCS) ? fs.readFileSync(DOCS, "utf8").replace(/\r\n/g, "\n") : null;
    if (current !== docs) { console.error(`FAIL ${path.relative(root, DOCS)} is missing or stale (run without --check)`); stale += 1; }
  } else {
    fs.writeFileSync(DOCS, docs);
  }
  if (stale || extra.length) { process.exitCode = 1; return; }
  console.log(`${check ? "PASS" : "WROTE"} marketplace art: ${ids.length}/${ids.length} templates, ${new Set(Object.values(ART).map((entry) => entry[0])).size} motifs, 10 distinct Minecraft-family identities`);
}

main();
