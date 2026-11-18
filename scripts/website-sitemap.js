#!/usr/bin/env node
// Keeps website/sitemap.xml's <lastmod> dates true to real content changes.
//
// website/sitemap-state.json records, for each sitemap URL, a fingerprint of
// the page it is served from and the date that content last changed. A run
// moves a URL's lastmod only when its page's content changed (line endings
// ignored), so a release that rewrites the homepage and release notes dates
// only those pages. New URLs are seeded from the page's last commit date.
//
// Runs as part of `npm run website:sync` (the release promotion workflow's
// website step) after release-docs.js has rewritten the pages.
//   --check          exit 1 if the sitemap or state is out of date (no writes)
//   --date=YYYY-MM-DD  the date to record for changed pages (default: today, UTC)
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "website");
const SITEMAP = path.join(SITE, "sitemap.xml");
const STATE = path.join(SITE, "sitemap-state.json");
const ORIGIN = "https://anxoscontrolcenter.org";

// "/x" is served from x.html, "/x/" from x/index.html, "/" from index.html.
function sourceFileFor(urlPath) {
  if (urlPath === "/") return "index.html";
  const trimmed = urlPath.replace(/^\/+/, "");
  if (trimmed.endsWith("/")) return `${trimmed}index.html`;
  return `${trimmed}.html`;
}

function fingerprint(file) {
  const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  return crypto.createHash("sha256").update(text).digest("hex");
}

function lastCommitDate(file, cwd = ROOT) {
  try {
    const date = execFileSync("git", ["log", "-1", "--format=%cs", "--", file], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  } catch {
    return null;
  }
}

function parseSitemap(xml) {
  return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => {
    const block = match[1];
    const loc = /<loc>([^<]+)<\/loc>/.exec(block)?.[1]?.trim();
    return {
      loc,
      changefreq: /<changefreq>([^<]+)<\/changefreq>/.exec(block)?.[1]?.trim() || null,
      priority: /<priority>([^<]+)<\/priority>/.exec(block)?.[1]?.trim() || null,
    };
  }).filter((entry) => entry.loc);
}

function renderSitemap(entries) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'];
  for (const entry of entries) {
    lines.push("  <url>", `    <loc>${entry.loc}</loc>`, `    <lastmod>${entry.lastmod}</lastmod>`);
    if (entry.changefreq) lines.push(`    <changefreq>${entry.changefreq}</changefreq>`);
    if (entry.priority) lines.push(`    <priority>${entry.priority}</priority>`);
    lines.push("  </url>");
  }
  lines.push("</urlset>", "");
  return lines.join("\n");
}

// Returns { sitemap, state, changed: [urls], problems: [] } without writing.
function planSitemap({ date, siteDir = SITE } = {}) {
  const today = date || new Date().toISOString().slice(0, 10);
  const sitemapFile = path.join(siteDir, "sitemap.xml");
  const stateFile = path.join(siteDir, "sitemap-state.json");
  const entries = parseSitemap(fs.readFileSync(sitemapFile, "utf8"));
  const previous = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { schemaVersion: 1, pages: {} };
  const state = { schemaVersion: 1, pages: {} };
  const changed = [];
  const problems = [];
  for (const entry of entries) {
    if (!entry.loc.startsWith(`${ORIGIN}/`)) { problems.push(`${entry.loc} is not on ${ORIGIN}`); continue; }
    const urlPath = entry.loc.slice(ORIGIN.length) || "/";
    const source = sourceFileFor(urlPath);
    const file = path.join(siteDir, source);
    if (!fs.existsSync(file)) { problems.push(`${entry.loc} has no page at website/${source}`); continue; }
    const sha256 = fingerprint(file);
    const known = previous.pages?.[urlPath];
    let lastmod;
    if (known && known.sha256 === sha256 && /^\d{4}-\d{2}-\d{2}$/.test(known.lastmod || "")) {
      lastmod = known.lastmod;
    } else {
      lastmod = known ? today : (lastCommitDate(path.join("website", source), path.dirname(siteDir)) || today);
      changed.push(entry.loc);
    }
    state.pages[urlPath] = { source: `website/${source}`, sha256, lastmod };
    entry.lastmod = lastmod;
  }
  return { sitemap: renderSitemap(entries), state: `${JSON.stringify(state, null, 2)}\n`, changed, problems };
}

function main(argv = process.argv.slice(2)) {
  const check = argv.includes("--check");
  const date = argv.find((arg) => arg.startsWith("--date="))?.slice(7);
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("--date must be YYYY-MM-DD");
  const plan = planSitemap({ date });
  if (plan.problems.length) {
    console.error(`Sitemap problems:\n- ${plan.problems.join("\n- ")}`);
    process.exitCode = 1;
    return;
  }
  const currentSitemap = fs.readFileSync(SITEMAP, "utf8").replace(/\r\n/g, "\n");
  const currentState = fs.existsSync(STATE) ? fs.readFileSync(STATE, "utf8").replace(/\r\n/g, "\n") : "";
  const outOfDate = currentSitemap !== plan.sitemap || currentState !== plan.state;
  if (check) {
    if (outOfDate) {
      console.error(`Sitemap is out of date (${plan.changed.length ? `changed: ${plan.changed.join(", ")}` : "format or state"}). Run: npm run website:sync`);
      process.exitCode = 1;
    } else {
      console.log("Sitemap lastmod dates match the pages' content.");
    }
    return;
  }
  if (outOfDate) {
    fs.writeFileSync(SITEMAP, plan.sitemap);
    fs.writeFileSync(STATE, plan.state);
  }
  console.log(`Sitemap: ${plan.changed.length} page(s) dated${plan.changed.length ? ` (${plan.changed.join(", ")})` : ""}.`);
}

if (require.main === module) main();

module.exports = { planSitemap, parseSitemap, sourceFileFor };
