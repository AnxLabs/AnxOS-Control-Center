#!/usr/bin/env node
"use strict";

// Build 216-F regression: the phone's server-page loader fetches a tab's data
// by tab name. Every name it checks must be a real tab in the shared
// ServerView.MAIN_TABS list (or a detail view under one), or that tab never
// loads. Until 216-F the loader checked "addons" while the Add-ons tab is
// "mods", so the phone never listed installed add-ons (since Phase 7).

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "src", "mobile", "web", "app.js"), "utf8");
const ServerView = require(path.join(root, "src", "shared", "serverViewModel.js"));
const known = new Set([...ServerView.MAIN_TABS, ...Object.keys(ServerView.TAB_PARENT || {})]);

const start = app.indexOf('case "server": {');
assert(start > -1, "the phone's server loader exists");
const loader = app.slice(start, app.indexOf("return { server: detail", start));
const checked = [...loader.matchAll(/tab === "([a-z-]+)"/g)].map((match) => match[1]);
assert(checked.length >= 5, `the loader checks its tabs (found ${checked.length})`);
const unknown = checked.filter((name) => !known.has(name));
assert.deepStrictEqual(unknown, [], `the phone loader checks tab names that are not tabs: ${unknown.join(", ")}`);
assert(checked.includes("mods"), "the Add-ons tab (\"mods\") loads its installed list");
console.log(`mobile-tab-loader-smoke: ${checked.length} loader tab names, all real tabs (${checked.join(", ")})`);
