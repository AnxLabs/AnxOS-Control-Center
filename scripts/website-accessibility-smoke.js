const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const websiteRoot = path.join(root, "website");

function read(file) {
  return fs.readFileSync(path.join(websiteRoot, file), "utf8");
}

const publicPages = [
  "index.html",
  "download/index.html",
  "download.html",
  "features/index.html",
  "getting-started/index.html",
  "setup/index.html",
  "system-requirements/index.html",
  "windows-installation/index.html",
  "security-privacy/index.html",
  "faq/index.html",
  "release-notes.html",
];

const styles = read("styles.css");
const download = read("download/index.html");
const site = read("site.js");
const releaseService = read("release-download-service.js");

for (const file of publicPages) {
  const html = read(file);
  assert(html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'), `${file} must use a mobile viewport.`);
  assert(html.includes("data-site-menu-toggle") && html.includes('aria-expanded="false"') && html.includes('aria-controls="site-nav"'), `${file} must expose an accessible mobile menu toggle.`);
  assert(html.includes("data-site-nav") && html.includes('aria-label="Primary"'), `${file} must expose a labelled primary navigation.`);
  assert(/<h1[\s>]/.test(html), `${file} must include a page-level h1.`);
  // `#icon-*` and the `#main` skip-link anchor are exempt; every other hash fragment remains forbidden.
  assert(!/\s(?:href|src)=["'][^"']*#[^"']*["']/.test(html.replace(/href="#icon-[^"]+"/g, "").replace(/href="#main"/g, "")), `${file} must not rely on hash-fragment navigation.`);
}

assert(download.includes("Download AnxOS for Windows"), "Download page must keep the primary Windows CTA visible without JavaScript.");
assert(download.includes("Portable Version") && download.includes("View Release Notes") && download.includes("Installation Help") && download.includes("System Requirements"), "Download page must keep secondary options visible without JavaScript.");
assert(download.includes('role="status"') && download.includes("Checking the latest published release"), "Download page must expose an accessible loading status.");
assert(download.includes('aria-live="polite"') && download.includes("Loading packages"), "Download page must avoid layout jumps with visible loading placeholders.");
assert(site.includes("No downloadable release is currently available.") && site.includes("Download information is temporarily unavailable. Please try again shortly."), "Download renderer must handle missing or slow release metadata.");
assert(site.includes("setDownloadLinksLoading()") && site.includes("applyDownloads({ force: true })"), "Download retry must reset loading state and force a fresh lookup.");
assert(releaseService.includes("preferredAssetForPlatform") && releaseService.includes("detectPlatform"), "Download platform detection must be presentation-only code, not a hard restriction.");

assert(styles.includes("a:focus-visible") && styles.includes(".button:focus-visible") && styles.includes(".site-nav a:focus-visible"), "CSS must expose visible focus states for links, buttons, and navigation.");
assert(styles.includes(".account-form select") && styles.includes(".account-form textarea") && styles.includes(".account-form textarea:focus-visible"), "Website forms must style select and textarea controls with visible focus states.");
assert(/\.button\s*\{[\s\S]*min-height:\s*44px/.test(styles), "Primary buttons must meet a 44px touch target.");
assert(/\.site-menu-button\s*\{[\s\S]*min-height:\s*44px/.test(styles), "Mobile menu button must meet a 44px touch target.");
assert(styles.includes("@media (max-width: 640px)") && styles.includes(".download-primary__actions") && styles.includes("grid-template-columns: 1fr"), "CSS must stack download actions on small screens.");
assert(styles.includes("@media (prefers-reduced-motion: reduce)"), "CSS must respect reduced-motion preference.");
assert(!/font-size:\s*clamp\([^;]*(?:vw|vh|vmin|vmax)/.test(styles), "CSS heading and text sizes must use breakpoints instead of viewport-scaled font sizes.");
assert(styles.includes("overflow-wrap: anywhere") && styles.includes("white-space: normal"), "Buttons and download metadata must handle long filenames and labels.");
assert(styles.includes(".release-meta dd") && styles.includes("text-overflow: ellipsis"), "Release metadata must avoid long filename overflow.");
assert(styles.includes(".download-status[data-tone=\"warn\"]") && styles.includes(".download-status[data-tone=\"ok\"]"), "Download status must not rely on color alone without text state.");

console.log("Website accessibility and responsive smoke checks passed.");
