#!/usr/bin/env node
"use strict";

// AnxHost CC design tokens and patterns (Build 216-0).
//   - every var(--ahx-*) used by patterns.css and the gallery is defined in tokens.css;
//   - the light theme only overrides tokens the dark theme defines (no light-only tokens);
//   - patterns.css contains no raw colour literals (components use tokens only);
//   - every status in the status system has a token in both themes and a pattern rule;
//   - Build 216-A1: the desktop shell (shell.css) uses defined tokens only, has
//     no raw colour literals, and scopes every rule under :root[data-shell="ahx"].
//   - Build 216-A2: the same rules for every AnxHost page stylesheet (every
//     .css in src/renderer/anxhost other than tokens.css and patterns.css,
//     so later waves are covered when they add a file), plus no :is() lists
//     in selectors (they cost page-switch time in A1).
//   - Build 216-A10: the light theme uses token values only (PLANS.md): no
//     stylesheet other than tokens.css has a [data-theme] selector or a
//     prefers-color-scheme query, so there are 0 per-component light rules;
//     legacy-bridge.css only sets custom properties at the root, and the
//     always-dark terminal tokens are not redefined by the light block.
// Run: node scripts/anxhost-design-tokens-smoke.js

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const tokens = read("src/renderer/anxhost/tokens.css");
const patterns = read("src/renderer/anxhost/patterns.css");
const gallery = read("docs/anxhost/gallery/ui-patterns.html");
const shell = read("src/renderer/anxhost/shell.css");
const anxhostDir = path.join(root, "src/renderer/anxhost");
const shellFiles = fs.readdirSync(anxhostDir)
  .filter((name) => name.endsWith(".css") && name !== "tokens.css" && name !== "patterns.css")
  .sort()
  .map((name) => [name, read(`src/renderer/anxhost/${name}`)]);
const STATUSES = ["running", "starting", "stopping", "updating", "degraded", "error", "offline", "stopped"];

function block(selectorStart) {
  const start = tokens.indexOf(selectorStart);
  if (start < 0) return "";
  const open = tokens.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < tokens.length; i += 1) {
    if (tokens[i] === "{") depth += 1;
    if (tokens[i] === "}") { depth -= 1; if (depth === 0) return tokens.slice(open + 1, i); }
  }
  return "";
}
const declared = (text) => new Set([...text.matchAll(/(--ahx-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
const used = (text) => new Set([...text.matchAll(/var\((--ahx-[a-z0-9-]+)/g)].map((m) => m[1]));

const failures = [];
const all = declared(tokens);
const dark = declared(block(":root,\n[data-theme=\"dark\"]"));
const light = declared(block("[data-theme=\"light\"]"));
if (!dark.size) failures.push("dark theme block not found");
if (!light.size) failures.push("light theme block not found");

for (const [name, text] of [["patterns.css", patterns], ["ui-patterns.html", gallery], ["tokens.css", tokens], ...shellFiles]) {
  const missing = [...used(text)].filter((token) => !all.has(token));
  if (missing.length) failures.push(`${name} uses undefined token(s): ${missing.join(", ")}`);
}
const lightOnly = [...light].filter((token) => !dark.has(token));
if (lightOnly.length) failures.push(`light theme defines tokens the dark theme does not: ${lightOnly.join(", ")}`);

for (const [name, text] of [["patterns.css", patterns], ...shellFiles]) {
  const rawColours = text.split("\n").map((line, i) => [i + 1, line]).filter(([, line]) => /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(line));
  if (rawColours.length) failures.push(`${name} has raw colour literals on line(s) ${rawColours.map(([n]) => n).join(", ")}`);
}

// Every shell.css selector is scoped to the AnxHost shell (comments removed;
// @media wrappers are not selectors).
// Splits a selector list on top-level commas (not those inside :is(...) or :not(...)).
function splitSelectorList(list) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const char of list) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) { parts.push(current); current = ""; } else current += char;
  }
  parts.push(current);
  return parts;
}
const selectorsOf = (text) => (text.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^{}]+(?=\{)/g) || [])
  .map((selectorText) => selectorText.trim())
  .filter((selectorText) => selectorText && !selectorText.startsWith("@"));
const ruleCounts = [];
for (const [name, text] of shellFiles) {
  const rules = selectorsOf(text);
  ruleCounts.push(`${name} ${rules.length}`);
  const parts = rules.flatMap((selectorText) => splitSelectorList(selectorText).map((part) => part.trim())).filter(Boolean);
  const unscoped = parts.filter((part) => !part.startsWith(':root[data-shell="ahx"]'));
  if (unscoped.length) failures.push(`${name} has selectors outside :root[data-shell="ahx"]: ${unscoped.slice(0, 5).join(" | ")}`);
  const isLists = parts.filter((part) => part.includes(":is("));
  if (isLists.length) failures.push(`${name} uses :is() selector lists: ${isLists.slice(0, 3).join(" | ")}`);
  if (rules.length < 10) failures.push(`${name} looks empty (${rules.length} rules)`);
}
const shellRules = selectorsOf(shell);
if (shellRules.length < 50) failures.push(`shell.css looks empty (${shellRules.length} rules)`);
for (const required of ["shell.css", "pages.css", "home.css"]) {
  if (!shellFiles.some(([name]) => name === required)) failures.push(`${required} is missing`);
}

// A10: 0 per-component light overrides.
const themeBranches = [["styles.css", read("styles.css")], ["patterns.css", patterns], ...shellFiles]
  .filter(([, text]) => /\[data-theme|prefers-color-scheme/.test(text.replace(/\/\*[\s\S]*?\*\//g, "")))
  .map(([name]) => name);
if (themeBranches.length) failures.push(`theme-specific rules outside tokens.css (light must come from token values only): ${themeBranches.join(", ")}`);
const bridge = shellFiles.find(([name]) => name === "legacy-bridge.css");
if (!bridge) failures.push("legacy-bridge.css is missing");
else {
  const rootBlock = bridge[1].match(/:root\[data-shell="ahx"\] \{([^}]*)\}/);
  const declarations = rootBlock ? rootBlock[1].replace(/\/\*[\s\S]*?\*\//g, "").split(";").map((d) => d.trim()).filter(Boolean) : [];
  if (declarations.length < 20 || declarations.some((d) => !/^--[a-z0-9-]+\s*:\s*var\(--ahx-[a-z0-9-]+\)$/.test(d))) failures.push("legacy-bridge.css root block must map legacy variables to --ahx tokens only");
}
for (const token of ["--ahx-terminal-bg", "--ahx-terminal-text", "--ahx-terminal-muted", "--ahx-terminal-danger", "--ahx-terminal-accent"]) {
  if (!dark.has(token)) failures.push(`dark theme is missing ${token}`);
  if (light.has(token)) failures.push(`${token} must stay dark in the light theme`);
}

for (const status of STATUSES) {
  const token = `--ahx-status-${status}`;
  if (!dark.has(token)) failures.push(`dark theme is missing ${token}`);
  if (!light.has(token)) failures.push(`light theme is missing ${token}`);
  if (!patterns.includes(`.ahx-status[data-status="${status}"]`)) failures.push(`patterns.css has no rule for status "${status}"`);
}

if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`PASS design tokens: ${all.size} tokens (${dark.size} themed in dark, ${light.size} overridden in light), ${used(patterns).size} used by patterns, ${STATUSES.length} statuses, no raw colours in patterns; page stylesheets token-only, scoped and free of :is() lists; no theme-specific rules outside tokens.css (${ruleCounts.join(", ")})`);
}
