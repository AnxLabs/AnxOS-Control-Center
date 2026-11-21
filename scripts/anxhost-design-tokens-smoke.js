#!/usr/bin/env node
"use strict";

// AnxHost CC design tokens and patterns (Build 216-0).
//   - every var(--ahx-*) used by patterns.css and the gallery is defined in tokens.css;
//   - the light theme only overrides tokens the dark theme defines (no light-only tokens);
//   - patterns.css contains no raw colour literals (components use tokens only);
//   - every status in the status system has a token in both themes and a pattern rule;
//   - Build 216-A1: the desktop shell (shell.css) uses defined tokens only, has
//     no raw colour literals, and scopes every rule under :root[data-shell="ahx"].
// Run: node scripts/anxhost-design-tokens-smoke.js

const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8").replace(/\r\n/g, "\n");
const tokens = read("src/renderer/anxhost/tokens.css");
const patterns = read("src/renderer/anxhost/patterns.css");
const gallery = read("docs/anxhost/gallery/ui-patterns.html");
const shell = read("src/renderer/anxhost/shell.css");
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

for (const [name, text] of [["patterns.css", patterns], ["ui-patterns.html", gallery], ["tokens.css", tokens], ["shell.css", shell]]) {
  const missing = [...used(text)].filter((token) => !all.has(token));
  if (missing.length) failures.push(`${name} uses undefined token(s): ${missing.join(", ")}`);
}
const lightOnly = [...light].filter((token) => !dark.has(token));
if (lightOnly.length) failures.push(`light theme defines tokens the dark theme does not: ${lightOnly.join(", ")}`);

for (const [name, text] of [["patterns.css", patterns], ["shell.css", shell]]) {
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
const shellRules = shell.replace(/\/\*[\s\S]*?\*\//g, "").match(/[^{}]+(?=\{)/g) || [];
const unscoped = shellRules
  .map((selectorText) => selectorText.trim())
  .filter((selectorText) => selectorText && !selectorText.startsWith("@"))
  .flatMap((selectorText) => splitSelectorList(selectorText).map((part) => part.trim()))
  .filter((part) => part && !part.startsWith(':root[data-shell="ahx"]'));
if (unscoped.length) failures.push(`shell.css has selectors outside :root[data-shell="ahx"]: ${unscoped.slice(0, 5).join(" | ")}`);
if (shellRules.length < 50) failures.push(`shell.css looks empty (${shellRules.length} rules)`);

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
  console.log(`PASS design tokens: ${all.size} tokens (${dark.size} themed in dark, ${light.size} overridden in light), ${used(patterns).size} used by patterns, ${STATUSES.length} statuses, no raw colours in patterns; shell.css token-only and scoped (${shellRules.length} rules)`);
}
