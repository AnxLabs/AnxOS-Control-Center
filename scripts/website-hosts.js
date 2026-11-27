#!/usr/bin/env node
"use strict";

// The website's two hosts and which one is canonical (the address search
// engines index and every generated canonical, sitemap and JSON-LD URL uses).
//
//   anxhost.anxlabs.net      the AnxHost website (new)
//   anxoscontrolcenter.org   legacy: kept registered and serving forever for
//                            installed apps (sign-in, config.js, release notes,
//                            downloads); its sign-in pages are never moved
//
// The source of truth is `const CANONICAL_HOST = ...` in website/_worker.js;
// the sitemap, IndexNow, release metadata and the website smokes read it from
// here. Switching it is a production change that needs the owner's approval:
// it turns on the worker's 301s from legacy pages to the new host.
//
// Usage:
//   node scripts/website-hosts.js                 print the canonical host
//   node scripts/website-hosts.js --check         exit 1 if a surface disagrees with it
//   node scripts/website-hosts.js --switch=new    make anxhost.anxlabs.net canonical
//   node scripts/website-hosts.js --switch=legacy make anxoscontrolcenter.org canonical
//   --root=<dir>                                  operate on another copy (tests)

const fs = require("fs");
const path = require("path");

const LEGACY_HOST = "anxoscontrolcenter.org";
const NEW_HOST = "anxhost.anxlabs.net";
const ROOT = path.resolve(__dirname, "..");
// Sign-in stays on the legacy host until the app and account service trust the
// new one (Build 217, separate approval): absolute links to these keep it.
const AUTH_PATH = /^\/(?:account|activate|signin|signup|sign-in|sign-up|profile|device|device-login|forgot-password|reset-password)(?:[/.?#"']|$)/i;

function workerPath(root = ROOT) {
  return path.join(root, "website", "_worker.js");
}

function canonicalHost(root = ROOT) {
  const source = fs.readFileSync(workerPath(root), "utf8");
  const match = /^const CANONICAL_HOST = (LEGACY_HOST|NEW_HOST);$/m.exec(source);
  if (!match) throw new Error("website/_worker.js does not declare CANONICAL_HOST as LEGACY_HOST or NEW_HOST");
  return match[1] === "NEW_HOST" ? NEW_HOST : LEGACY_HOST;
}

function canonicalOrigin(root = ROOT) {
  return `https://${canonicalHost(root)}`;
}

function sitePages(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "assets" && entry.name !== "functions") out.push(...sitePages(full));
    } else if (entry.name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out;
}

function rewriteFile(file, transform) {
  const raw = fs.readFileSync(file, "utf8");
  const crlf = raw.includes("\r\n");
  const next = transform(raw.replace(/\r\n/g, "\n"));
  if (next === raw.replace(/\r\n/g, "\n")) return false;
  fs.writeFileSync(file, crlf ? next.replace(/\n/g, "\r\n") : next);
  return true;
}

// Absolute links from one host to the other, keeping sign-in links on legacy.
function moveLinks(text, fromHost, toHost) {
  return text.replace(new RegExp(`https://${fromHost.replace(/\./g, "\\.")}(/[^\\s"'<>)\\]]*)?`, "g"), (whole, rest = "") => {
    if (AUTH_PATH.test(rest || "/")) return `https://${LEGACY_HOST}${rest}`;
    return `https://${toHost}${rest}`;
  });
}

function switchHosts(target, { root = ROOT } = {}) {
  const toHost = target === "new" ? NEW_HOST : target === "legacy" ? LEGACY_HOST : null;
  if (!toHost) throw new Error("--switch must be new or legacy");
  const fromHost = toHost === NEW_HOST ? LEGACY_HOST : NEW_HOST;
  const site = path.join(root, "website");
  const changed = [];
  if (rewriteFile(workerPath(root), (text) => text.replace(/^const CANONICAL_HOST = (?:LEGACY_HOST|NEW_HOST);$/m, `const CANONICAL_HOST = ${toHost === NEW_HOST ? "NEW_HOST" : "LEGACY_HOST"};`))) changed.push("website/_worker.js");
  for (const file of sitePages(site)) {
    if (rewriteFile(file, (text) => moveLinks(text, fromHost, toHost))) changed.push(path.relative(root, file));
  }
  for (const name of ["robots.txt", "sitemap.xml", "sitemap-state.json", "config.js"]) {
    const file = path.join(site, name);
    if (!fs.existsSync(file)) continue;
    // config.js: only its siteUrl and the release links built from it move;
    // the download and GitHub URLs in it are on github.com.
    if (rewriteFile(file, (text) => moveLinks(text, fromHost, toHost))) changed.push(`website/${name}`);
  }
  return { host: toHost, changed };
}

function checkHosts({ root = ROOT } = {}) {
  const host = canonicalHost(root);
  const origin = `https://${host}`;
  const site = path.join(root, "website");
  const problems = [];
  for (const file of sitePages(site)) {
    const html = fs.readFileSync(file, "utf8");
    for (const match of html.matchAll(/<link rel="canonical" href="([^"]+)"/g)) {
      const href = match[1];
      const rest = href.replace(/^https:\/\/[^/]+/, "");
      const expected = AUTH_PATH.test(rest || "/") ? `https://${LEGACY_HOST}` : origin;
      if (!href.startsWith(`${expected}/`) && href !== expected) problems.push(`${path.relative(root, file)}: canonical ${href} is not on ${expected}`);
    }
    for (const match of html.matchAll(/<meta property="og:url" content="([^"]+)"/g)) {
      if (!match[1].startsWith(`${origin}/`) && !AUTH_PATH.test(match[1].replace(/^https:\/\/[^/]+/, ""))) problems.push(`${path.relative(root, file)}: og:url ${match[1]} is not on ${origin}`);
    }
  }
  const robots = fs.readFileSync(path.join(site, "robots.txt"), "utf8");
  if (!robots.includes(`Sitemap: ${origin}/sitemap.xml`)) problems.push(`website/robots.txt does not name ${origin}/sitemap.xml`);
  const sitemap = fs.readFileSync(path.join(site, "sitemap.xml"), "utf8");
  for (const match of sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    if (!match[1].startsWith(`${origin}/`)) problems.push(`website/sitemap.xml lists ${match[1]}`);
  }
  const config = fs.readFileSync(path.join(site, "config.js"), "utf8");
  if (!config.includes(`siteUrl: "${origin}"`)) problems.push(`website/config.js siteUrl is not ${origin}`);
  const accountConfig = fs.readFileSync(path.join(site, "account-config.js"), "utf8");
  if (!accountConfig.includes(`siteUrl: "https://${LEGACY_HOST}"`)) problems.push("website/account-config.js must keep sign-in on the legacy host");
  return { host, problems };
}

function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, "").split("="); return [key, rest.length ? rest.join("=") : true]; }));
  const root = args.root ? path.resolve(String(args.root)) : ROOT;
  if (args.switch) {
    const result = switchHosts(String(args.switch), { root });
    console.log(`Canonical host is now ${result.host}; ${result.changed.length} file(s) changed. Run node scripts/website-sitemap.js and the website tier next.`);
    return;
  }
  if (args.check) {
    const { host, problems } = checkHosts({ root });
    if (problems.length) {
      console.error(`Website hosts disagree with the canonical host ${host}:\n- ${problems.join("\n- ")}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Website hosts agree: canonical ${host}, sign-in on ${LEGACY_HOST}.`);
    return;
  }
  console.log(canonicalHost(root));
}

if (require.main === module) main();

module.exports = { LEGACY_HOST, NEW_HOST, AUTH_PATH, canonicalHost, canonicalOrigin, switchHosts, checkHosts, moveLinks };
