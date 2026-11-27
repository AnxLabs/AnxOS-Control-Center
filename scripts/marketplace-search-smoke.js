#!/usr/bin/env node
"use strict";

// 217-B: Add Server search matched the whole query as one substring, so
// "paper minecraft" or "valheim server" found nothing although both words
// appear on the card. Every word of the query must now appear (in any order);
// a one-word query behaves as before.
//   S1 words in any order match ("paper minecraft" finds Minecraft Paper)
//   S2 every word must match ("paper valheim" finds nothing)
//   S3 one word and an empty query behave as before (substring, everything)
//   S4 tags, author, category and id are still searched; case is ignored
//   S5 getFilteredMarketplaceTemplates uses the shared rule with the category
//      chips unchanged
// Run: node scripts/marketplace-search-smoke.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const source = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
function extractFunction(name) {
  const start = source.search(new RegExp(`function ${name}\\(`));
  assert.ok(start >= 0, `app.js declares ${name}`);
  let depth = 0;
  for (let index = source.indexOf(") {", start) + 2; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") { depth -= 1; if (depth === 0) return source.slice(start, index + 1); }
  }
  throw new Error(`unbalanced ${name}`);
}

const sandbox = {};
vm.runInNewContext(`${extractFunction("marketplaceTemplateMatchesQuery")}\nthis.matches = marketplaceTemplateMatchesQuery;`, sandbox);
const paper = { displayName: "Minecraft Paper", description: "High-performance Paper server for plugins and survival.", author: "AnxHost", category: "Minecraft", id: "minecraft-paper", tags: ["java", "plugins"] };
const valheim = { displayName: "Valheim", description: "Viking survival dedicated server via SteamCMD.", author: "AnxHost", category: "Game Servers", id: "valheim", tags: ["steamcmd"] };
const results = [];
function check(label, fn) { try { fn(); results.push(`PASS ${label}`); } catch (error) { results.push(`FAIL ${label}\n  ${error.message}`); } }

check("S1 words in any order match", () => {
  assert.strictEqual(sandbox.matches(paper, "paper minecraft"), true);
  assert.strictEqual(sandbox.matches(valheim, "valheim server"), true);
  assert.strictEqual(sandbox.matches(valheim, "  dedicated   viking "), true, "extra spaces are ignored");
});
check("S2 every word must match", () => {
  assert.strictEqual(sandbox.matches(paper, "paper valheim"), false);
  assert.strictEqual(sandbox.matches(valheim, "valheim plugins"), false);
});
check("S3 one word and an empty query behave as before", () => {
  assert.strictEqual(sandbox.matches(paper, "pap"), true, "substring of a word");
  assert.strictEqual(sandbox.matches(paper, ""), true);
  assert.strictEqual(sandbox.matches(paper, "   "), true);
  assert.strictEqual(sandbox.matches(paper, "terraria"), false);
});
check("S4 tags, author, category and id are searched; case is ignored", () => {
  assert.strictEqual(sandbox.matches(paper, "JAVA"), true);
  assert.strictEqual(sandbox.matches(valheim, "steamcmd game"), true);
  assert.strictEqual(sandbox.matches(paper, "minecraft-paper"), true);
  assert.strictEqual(sandbox.matches(paper, "anxhost plugins"), true);
});
check("S5 the catalog filter uses the shared rule and keeps the category chips", () => {
  const body = extractFunction("getFilteredMarketplaceTemplates");
  assert.ok(body.includes("marketplaceTemplateMatchesQuery(template, query)"), "uses the shared rule");
  assert.ok(body.includes('marketplaceActiveCategory === "Favorites"') && body.includes("isMarketplaceFavorite(template)"), "Favorites chip unchanged");
  assert.ok(!body.includes("haystack.includes(query)"), "no whole-query substring match left");
});

for (const line of results) console.log(line);
const failed = results.filter((line) => line.startsWith("FAIL")).length;
if (failed) { process.exitCode = 1; console.log(`marketplace-search-smoke: ${failed} failed`); } else console.log(`marketplace-search-smoke passed (${results.length} checks)`);
