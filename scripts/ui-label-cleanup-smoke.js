#!/usr/bin/env node
// Source regression for the visible label cleanup. Route ids, aliases,
// settings targets, and action handlers stay. Only the visible names move.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8").replace(/\r\n/g, "\n");
const index = read("index.html");
const app = read("app.js");

const navStart = index.indexOf('id="app-sidebar-nav"');
const navEnd = index.indexOf("</nav>", navStart);
const nav = index.slice(navStart, navEnd);

const labels = {
  console: ["Console", "Live output from your servers"],
  playit: ["Public Access", "Share a server on the internet"],
  operations: ["Tasks", "Work running in the background"],
  notifications: ["Alerts", "Warnings and messages worth acting on"],
  nodes: ["Computers", "This PC and any other computer you add"],
  network: ["Addresses", "Saved addresses and connection checks"],
  "agent-control": ["Agent", "Install, start, and repair the Agent"],
};

for (const [pageId, [label, description]] of Object.entries(labels)) {
  assert(nav.includes(`data-page-target="${pageId}"`), `${pageId} route id must stay on the nav button.`);
  assert(nav.includes(`data-page-label="${label}"`), `${pageId} visible label must be ${label}.`);
  assert(nav.includes(`data-nav-description="${description}"`), `${pageId} description must state its scope.`);
  assert(index.includes(`data-page="${pageId}"`), `${pageId} page section must remain.`);
}

assert(!nav.includes('data-page-label="Monitoring"'), "Console must not keep the Monitoring nav label.");
assert(index.includes("<h1>Console</h1>"), "The console page heading must say Console.");
assert(index.includes("<h1>Tasks</h1>"), "The operations page heading must say Tasks.");
assert(index.includes("<h1>Alerts</h1>"), "The notifications page heading must say Alerts.");
assert(index.includes("<h1>Computers</h1>"), "The nodes page heading must say Computers.");
assert(index.includes("<h1>Addresses</h1>"), "The network page heading must say Addresses.");
assert(index.includes("<h1>Agent</h1>"), "The agent-control page heading must say Agent.");
assert(index.includes("<h1>Public Access</h1>"), "Public Access keeps its name.");

assert(index.includes("<h3>Notification preferences</h3>"), "Settings notifications heading must be marked as preferences.");
assert(index.includes("<h3>Connection preferences</h3>"), "Settings network heading must be marked as preferences.");
assert(index.includes("<h3>App backup preferences</h3>"), "Settings backups heading must be marked as preferences.");
assert(index.includes("<h3>Security preferences</h3>"), "Settings security heading must be marked as preferences.");
assert(index.includes('data-setting="security.requireOwnerForSensitiveActions" disabled'), "Security preference fields must stay disabled.");
assert(index.includes('data-setting="network.proxyMode" disabled'), "Connection preference fields must stay disabled.");
assert(index.includes('data-setting="backups.configBackups" disabled'), "App backup preference fields must stay disabled.");
assert(!index.includes('data-settings-category="security"') || index.includes("data-security-action=\"rotate-agent-token\""), "Security preferences must keep their existing actions.");

[
  "general",
  "appearance",
  "startup",
  "notifications",
  "performance",
  "storage",
  "backups",
  "network",
  "integrations",
  "updates",
  "about",
  "security",
  "marketplace-admin",
  "developer",
].forEach((category) => {
  assert(index.includes(`data-settings-category-target="${category}"`), `Settings category ${category} must remain.`);
});

assert(app.includes('if (pageName === "minecraft")') && app.includes('return "instances"'), "minecraft must still alias to instances.");
assert(app.includes('if (pageName === "amp" || pageName === "coolpals")') && app.includes('return "dashboard"'), "amp and coolpals must still alias to dashboard.");
assert(app.includes('pages: ["nodes", "network", "playit", "ssh", "agent-control"]'), "Infrastructure route ids must stay.");
assert(app.includes('label: "Open Computers", run: () => showPage("nodes")'), "Open Computers must still open the nodes route.");
assert(app.includes('label: "Open Addresses", run: () => showPage("network")'), "Open Addresses must still open the network route.");
assert(app.includes('action: { label: "Open Agent", page: "agent-control" }'), "Open Agent must still open agent-control.");
assert(app.includes("data-page=\"amp\"") || index.includes('data-page="amp"'), "Unreachable AMP markup must remain.");
assert(index.includes('data-page="coolpals"'), "Unreachable CoolPals markup must remain.");
const securitySettings = index.slice(index.indexOf('data-settings-category="security"'), index.indexOf('data-settings-category="network"'));
assert(securitySettings.includes('data-setting="security.requireOwnerForSensitiveActions" disabled'), "Security preferences must keep the existing disabled fields.");
assert(!securitySettings.includes("data-page-target"), "Security preferences must not be replaced with a page link.");

console.log("ui-label-cleanup-smoke passed");
