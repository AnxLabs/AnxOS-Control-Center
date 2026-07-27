#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const index = fs.readFileSync(path.join(root, "index.html"), "utf8");
const styles = fs.readFileSync(path.join(root, "styles.css"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");

assert(index.includes('data-ui-generation="v1.9"'), "The v1.9 renderer must opt into the refreshed workspace theme.");
assert(index.includes('class="inline-action dashboard-launcher'), "Dashboard must expose compact service launchers.");
for (const action of ["create-server", "instances", "share-server", "public-access", "backups", "marketplace", "docker", "nodes"]) {
  assert(index.includes(`data-dashboard-action="${action}"`), `Dashboard launcher is missing: ${action}`);
}
assert(app.includes('if (action === "share-server")') && app.includes("openShareServerModal(instance)"), "Dashboard Share Server must reuse the existing safe sharing flow.");
assert(app.includes('if (action === "backups") return showPage("backups")'), "Dashboard Backups must route to the existing workspace.");
assert(styles.includes('html[data-ui-generation="v1.9"] .dashboard-welcome'), "v1.9 dashboard layout styling must exist.");
assert(styles.includes('html[data-ui-generation="v1.9"] .dashboard-launcher'), "v1.9 compact launcher styling must exist.");
assert(styles.includes('html[data-ui-generation="v1.9"] .marketplace-card'), "Marketplace must inherit the v1.9 surface styling.");
assert(styles.includes('html[data-ui-generation="v1.9"] .public-access-provider'), "Public Access must inherit the v1.9 surface styling.");
assert(styles.includes('html[data-ui-generation="v1.9"] .instances-summary-card'), "Instances must inherit the v1.9 compact summary styling.");
assert(styles.includes('html[data-ui-generation="v1.9"] .nodes-summary-card'), "Nodes must inherit the v1.9 compact summary styling.");
assert(!styles.includes("border-radius: 24px"), "The v1.9 workspace must avoid oversized card rounding.");

console.log("v1.9 UI refresh smoke checks passed.");
