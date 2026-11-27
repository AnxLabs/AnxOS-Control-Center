#!/usr/bin/env node
"use strict";

// Writes the one shared AnxHost header and footer into every website page that
// has the site chrome, and links the AnxHost design layer (anxhost-site.css)
// right after styles.css. Pages differ only in their <main>, so the chrome is
// generated instead of hand-copied (the old copies had drifted in whitespace).
//
// Usage:
//   node scripts/website-chrome.js          rewrite the pages
//   node scripts/website-chrome.js --check  exit 1 if any page differs

const fs = require("fs");
const path = require("path");

const SITE = path.join(__dirname, "..", "website");

const HEADER = `<header class="site-header">
      <div class="site-header__inner">
        <a class="brand" href="/" aria-label="AnxHost Control Center home">
          <span class="brand-mark"><img data-logo src="/assets/anxhost-logo.png" alt="" width="28" height="28"></span>
          <span class="brand-copy"><strong data-config="brandName">AnxHost</strong><span>Control Center</span></span>
        </a>
        <button class="site-menu-button" type="button" data-site-menu-toggle aria-expanded="false" aria-controls="site-nav">Menu</button>
        <nav class="site-nav" id="site-nav" data-site-nav aria-label="Primary">
          <a href="/features/">Features</a>
          <a href="/getting-started/">Getting Started</a>
          <a href="/setup/">Setup</a>
          <a href="/release-notes">Release Notes</a>
          <a href="/faq/">FAQ</a>
          <a href="/signin/" data-auth-nav="signed-out" hidden>Sign In</a>
          <a href="/profile" data-auth-nav="signed-in" hidden>Profile</a>
          <button class="site-nav__button" type="button" data-auth-nav="signed-in" data-auth-action="signout" hidden>Sign Out</button>
          <a class="site-nav__cta" href="/download">Download</a>
        </nav>
      </div>
    </header>`;

const FOOTER = `<footer class="site-footer">
      <div class="site-footer__brand">
        <img src="/assets/anxhost-icon.svg" alt="" width="32" height="32">
        <strong>AnxHost Control Center</strong>
        <span>Local-first control for the servers and PCs you own. Formerly AnxOS Control Center.</span>
        <span class="site-footer__note">Private Alpha · <a href="/security-privacy/">Security &amp; Privacy</a></span>
      </div>
      <nav class="site-footer__nav" aria-label="Footer">
        <div class="site-footer__col">
          <h2>Product</h2>
          <a href="/">Home</a><a href="/features/">Features</a><a href="/download">Download</a><a href="/release-notes">Release Notes</a><a href="/system-requirements/">System Requirements</a>
        </div>
        <div class="site-footer__col">
          <h2>Guides</h2>
          <a href="/getting-started/">Getting Started</a><a href="/setup/">Setup</a><a href="/windows-installation/">Windows Installation</a><a href="/faq/">FAQ</a>
        </div>
        <div class="site-footer__col">
          <h2>Project</h2>
          <a href="/security-privacy/">Security</a><a data-config-href="repositoryUrl" href="https://github.com/AnxLabs/AnxOS-Control-Center-Releases">GitHub</a><a href="https://anxlabs.net">AnxLabs</a>
          <a href="/signin/" data-auth-nav="signed-out" hidden>Sign In</a><a href="/signup/" data-auth-nav="signed-out" hidden>Sign Up</a><a href="/profile" data-auth-nav="signed-in" hidden>Profile</a><button class="site-nav__button" type="button" data-auth-nav="signed-in" data-auth-action="signout" hidden>Sign Out</button>
        </div>
      </nav>
      <div class="site-footer__legal"><span>© 2026 AnxHost Control Center · AnxLabs</span><span>anxhost.anxlabs.net · anxoscontrolcenter.org</span></div>
    </footer>`;

const DESIGN_LAYER = '<link rel="stylesheet" href="/anxhost-site.css">';

function pages(dir = SITE) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "assets" || entry.name === "functions") continue;
      out.push(...pages(full));
    } else if (entry.name.endsWith(".html")) {
      out.push(full);
    }
  }
  return out.sort();
}

function render(html) {
  if (!/<header class="site-header">/.test(html) || !/<footer class="site-footer">/.test(html)) return html;
  let next = html
    .replace(/<header class="site-header">[\s\S]*?<\/header>/, HEADER)
    .replace(/<footer class="site-footer">[\s\S]*?<\/footer>/, FOOTER);
  if (!next.includes(DESIGN_LAYER)) {
    next = next.replace(/(<link rel="stylesheet" href="\/?styles\.css">)/, `$1\n    ${DESIGN_LAYER}`);
  }
  return next;
}

function main() {
  const check = process.argv.includes("--check");
  const stale = [];
  let withChrome = 0;
  for (const file of pages()) {
    const raw = fs.readFileSync(file, "utf8");
    const crlf = raw.includes("\r\n");
    const html = raw.replace(/\r\n/g, "\n");
    const next = render(html);
    if (/<header class="site-header">/.test(html)) withChrome += 1;
    if (next !== html) {
      stale.push(path.relative(SITE, file));
      if (!check) fs.writeFileSync(file, crlf ? next.replace(/\n/g, "\r\n") : next);
    }
  }
  if (check) {
    if (stale.length) {
      console.error(`Website chrome is out of date in ${stale.length} page(s): ${stale.join(", ")}. Run node scripts/website-chrome.js.`);
      process.exitCode = 1;
      return;
    }
    console.log(`Website chrome is current on ${withChrome} page(s).`);
    return;
  }
  console.log(`Website chrome written to ${stale.length} of ${withChrome} page(s).`);
}

if (require.main === module) main();

module.exports = { HEADER, FOOTER, DESIGN_LAYER, render, pages };
