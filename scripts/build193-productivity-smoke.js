const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const expectedPresets = [
  "minecraft-vanilla",
  "minecraft-paper",
  "minecraft-fabric",
  "minecraft-forge",
  "minecraft-neoforge",
  "minecraft-atm10",
  "palworld",
  "rust",
  "cs2",
  "terraria",
  "valheim",
];

// Build 216 retired the dormant inline Create Instance form and its preset
// table (owner approval). Every preset's game is created through Add Server
// instead: a Marketplace template, or for ATM10 the CurseForge modpack search.
const marketplaceTemplates = JSON.parse(fs.readFileSync(path.join(root, "config", "marketplace-templates.json"), "utf8"));
const templateIds = new Set((marketplaceTemplates.templates || marketplaceTemplates).map((template) => template.id));
const presetTemplate = { terraria: "terraria-tshock" };
for (const preset of expectedPresets) {
  if (preset === "minecraft-atm10") {
    assert(app.includes("curseforge"), "ATM10 must be installable as a CurseForge modpack through Add Server.");
    continue;
  }
  const templateId = presetTemplate[preset] || preset;
  assert(templateIds.has(templateId), `Server preset ${preset} must be available as the Add Server template ${templateId}.`);
}
assert(!html.includes("data-instance-preset="), "The retired inline form's preset buttons must stay removed.");

for (const action of ["refresh", "restart-agent", "start-all", "stop-all"]) {
  assert(
    html.includes(`data-dashboard-action="${action}"`),
    `Dashboard action ${action} must be exposed.`,
  );
}

for (const eventTitle of [
  "Server started",
  "Server stopped",
  "Server crashed",
  "Backup completed",
  "Download finished",
  "Update available",
  "Public Access connected",
  "Public Access lost",
  "Docker operation completed",
  "Configuration saved",
]) {
  assert(app.includes(`"${eventTitle}"`), `Notification event ${eventTitle} must be classified.`);
}

assert(html.includes('data-notification-action="mark-all-read"'), "Notification Center must support marking all records read.");
assert(html.includes('data-notification-action="clear-all"'), "Notification Center must support clearing all records.");
assert(app.includes("NOTIFICATION_DEDUP_WINDOW_MS"), "Notification Center must retain duplicate prevention.");
assert(app.includes("NOTIFICATIONS_STORAGE_KEY"), "Notification Center must retain session persistence.");
assert(html.includes('data-field="dashboardAgentStatus"'), "Dashboard must present Agent connection status.");
assert(html.includes('data-field="dashboardPublicAccess"'), "Dashboard must present Public Access state.");

console.log("Build 193 dashboard, templates, and notification smoke checks passed.");
