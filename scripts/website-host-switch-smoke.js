#!/usr/bin/env node
"use strict";

// The prepared canonical-host switch (scripts/website-hosts.js) on a copy of
// the website. No network, and the real website/ is never written.
//   S1 in the legacy mode, every surface agrees on the legacy canonical host
//   S2 switching to anxhost.anxlabs.net moves canonicals, og:url, JSON-LD,
//      robots, sitemap, config siteUrl and the worker's CANONICAL_HOST
//   S3 sign-in stays on anxoscontrolcenter.org after the switch: account-config,
//      absolute sign-in links and the auth pages' own canonicals
//   S4 download, GitHub and asset URLs on other hosts are untouched
//   S5 switching back restores every file byte for byte
// Run: node scripts/website-host-switch-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const hosts = require("./website-hosts");

const repo = path.resolve(__dirname, "..");

function snapshot(dir) {
  const out = new Map();
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(path.relative(dir, full), fs.readFileSync(full));
    }
  };
  walk(dir);
  return out;
}

function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-host-switch-"));
  fs.cpSync(path.join(repo, "website"), path.join(root, "website"), { recursive: true, filter: (source) => !/[\\/]assets[\\/]product[\\/]/.test(source) });
  // Start from the legacy mode whichever one is committed, so the smoke runs
  // the same both before and after an approved switch.
  const committed = hosts.canonicalHost(root);
  if (committed !== hosts.LEGACY_HOST) hosts.switchHosts("legacy", { root });
  const before = snapshot(path.join(root, "website"));
  const read = (relative) => fs.readFileSync(path.join(root, "website", relative), "utf8");

  // S1
  assert.strictEqual(hosts.canonicalHost(root), hosts.LEGACY_HOST);
  assert.deepStrictEqual(hosts.checkHosts({ root }).problems, []);
  console.log(`PASS S1 every surface agrees on anxoscontrolcenter.org (committed mode: ${committed})`);

  // S2
  const result = hosts.switchHosts("new", { root });
  assert.strictEqual(result.host, hosts.NEW_HOST);
  assert.strictEqual(hosts.canonicalHost(root), hosts.NEW_HOST);
  assert.deepStrictEqual(hosts.checkHosts({ root }).problems, [], "every surface agrees on the new host");
  const index = read("index.html");
  assert.ok(index.includes('<link rel="canonical" href="https://anxhost.anxlabs.net/">'));
  assert.ok(index.includes('<meta property="og:url" content="https://anxhost.anxlabs.net/">'));
  assert.ok(index.includes('"url": "https://anxhost.anxlabs.net/"'), "JSON-LD url moves");
  assert.ok(read("download/index.html").includes('<link rel="canonical" href="https://anxhost.anxlabs.net/download">'));
  assert.match(read("robots.txt"), /^Sitemap: https:\/\/anxhost\.anxlabs\.net\/sitemap\.xml$/m);
  assert.ok(!read("sitemap.xml").includes("anxoscontrolcenter.org"), "the sitemap lists only the new host");
  assert.ok(read("config.js").includes('siteUrl: "https://anxhost.anxlabs.net"'));
  assert.match(read("_worker.js"), /^const CANONICAL_HOST = NEW_HOST;$/m);
  console.log(`PASS S2 the switch moves ${result.changed.length} file(s) to anxhost.anxlabs.net`);

  // S3
  assert.ok(read("account-config.js").includes('siteUrl: "https://anxoscontrolcenter.org"'), "account-config keeps sign-in on legacy");
  assert.ok(read("signin/index.html").includes('<link rel="canonical" href="https://anxoscontrolcenter.org/signin/">'), "auth pages keep their legacy canonical");
  assert.ok(read("activate/index.html").includes('href="https://anxoscontrolcenter.org/activate"'));
  const anyPage = fs.readdirSync(path.join(root, "website")).filter((name) => name.endsWith(".html")).map(read).join("\n")
    + ["setup/index.html", "getting-started/index.html", "windows-installation/index.html"].map(read).join("\n");
  assert.ok(!/https:\/\/anxhost\.anxlabs\.net\/(?:account|activate|signin|signup|profile|forgot-password|reset-password)\b/.test(anyPage), "no absolute sign-in link points at the new host");
  console.log("PASS S3 sign-in stays on anxoscontrolcenter.org after the switch");

  // S4
  const config = read("config.js");
  assert.ok(config.includes("https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/download/"), "GitHub download URLs are untouched");
  assert.ok(!config.includes("anxhost.anxlabs.net/releases"), "no GitHub path was rewritten onto the site host");
  console.log("PASS S4 GitHub download and repository URLs are untouched");

  // S5
  hosts.switchHosts("legacy", { root });
  const after = snapshot(path.join(root, "website"));
  assert.deepStrictEqual([...after.keys()].sort(), [...before.keys()].sort());
  for (const [file, bytes] of before) assert.ok(after.get(file).equals(bytes), `${file} is restored byte for byte`);
  assert.deepStrictEqual(hosts.checkHosts({ root }).problems, []);
  console.log(`PASS S5 switching back restores all ${before.size} files byte for byte`);

  fs.rmSync(root, { recursive: true, force: true });
  console.log("Website host switch smoke passed (5 checks).");
}

main();
