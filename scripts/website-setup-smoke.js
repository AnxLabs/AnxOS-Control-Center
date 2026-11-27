const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const websiteRoot = path.join(root, "website");
const read = (file) => fs.readFileSync(path.join(websiteRoot, file), "utf8");
const setup = read("setup/index.html");
const index = read("index.html");
const download = read("download/index.html");
const gettingStarted = read("getting-started/index.html");
const styles = read("styles.css");
const site = read("site.js");

assert(setup.includes('data-standalone-route="setup"'), "/setup must serve the setup guide.");
assert(setup.includes(`rel="canonical" href="${require("./website-hosts").canonicalOrigin()}/setup/"`), "/setup must have canonical metadata.");
assert(setup.includes('href="/download"') && setup.includes("Download AnxHost"), "Setup download CTAs must point to /download.");
assert(!/data-download=(?:"|')[^"']+/.test(setup), "Setup CTAs must remain on the existing download route instead of starting a release download.");
for (const html of [setup, index, download, gettingStarted, read("features/index.html"), read("system-requirements/index.html"), read("windows-installation/index.html"), read("security-privacy/index.html"), read("faq/index.html")]) {
  assert(html.includes('href="/setup/"'), "Primary public pages must include the Setup Guide navigation entry.");
}

[
  "Download AnxHost", "Install and launch", "Sign in and create the Local Owner", "Connect the Local Agent",
  "Prepare the node", "Create the first server", "Start and manage the server", "Let friends join",
  "Connect to the server", "Troubleshooting",
].forEach((heading) => assert(setup.includes(heading), `Setup guide must include heading: ${heading}`));

[
  "Agent Offline", "Agent Unauthorized", "Dependency missing", "Port already in use", "EULA not accepted",
  "Java version mismatch", "Server starts then stops", "Public address unavailable", "Diagnostics and logs",
].forEach((heading) => assert(setup.includes(heading), `Setup troubleshooting must include: ${heading}`));

const internalTargets = Array.from(setup.matchAll(/href="(\/[^"]*)"/g), (match) => match[1])
  .filter((target) => !target.includes("#"));
for (const target of new Set(internalTargets)) {
  const relative = target.replace(/^\//, "");
  const candidates = relative
    ? [path.join(websiteRoot, relative), path.join(websiteRoot, relative, "index.html"), path.join(websiteRoot, `${relative}.html`)]
    : [path.join(websiteRoot, "index.html")];
  assert(candidates.some((candidate) => fs.existsSync(candidate)), `Internal setup link must resolve: ${target}`);
}

assert(styles.includes(".setup-step") && styles.includes("@media (max-width:640px)"), "Setup guide must include responsive step styling.");
assert(styles.includes("minmax(0,1fr)") && styles.includes("overflow-wrap:anywhere"), "Setup layout must constrain mobile content and long commands.");
assert(styles.includes(".command-row button:focus-visible") && setup.includes("aria-label=\"Copy"), "Copy controls must have keyboard focus and accessible labels.");
assert(site.includes("function bindCopyControls()") && !/window\.(?:alert|prompt|confirm)\(/.test(setup), "Setup interactions must use inline UI, not browser dialogs.");

console.log("Website setup guide smoke checks passed.");
