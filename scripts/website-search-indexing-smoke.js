#!/usr/bin/env node
"use strict";

// Search-engine and AI-crawler discoverability of the website (no network).
//   I1 www.<site> redirects to the one indexed address; every *.pages.dev
//      copy (the project name and each frozen deployment) is marked noindex;
//      the real site and the download API are unchanged
//   I2 every sitemap URL has a real <lastmod> date; a content change moves
//      only that page's date, and a second run changes nothing
//   I3 the pages search engines rank for releases name the current release
//      in their static HTML and carry exactly one versioned
//      SoftwareApplication record where they carry one at all
//   I4 robots.txt names the sitemap and does not block any sitemap URL
//   I5 IndexNow submits only the newest sitemap changes, and posts nothing
//      until the live site serves the same key (fake fetch, no network)
// Run: node scripts/website-search-indexing-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const { pathToFileURL } = require("url");

const repo = path.resolve(__dirname, "..");
const site = path.join(repo, "website");
const { planSitemap } = require("./website-sitemap");

function loadConfig() {
  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(site, "config.js"), "utf8"), sandbox);
  return sandbox.window.ANXOS_SITE_CONFIG || sandbox.window.ANXHUB_SITE_CONFIG || Object.values(sandbox.window)[0];
}

async function main() {
  // I1: run the real worker against fake assets.
  const workerCopy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "anx-worker-")), "worker.mjs");
  fs.copyFileSync(path.join(site, "_worker.js"), workerCopy);
  const worker = (await import(pathToFileURL(workerCopy).href)).default;
  const env = { ASSETS: { fetch: async () => new Response("<html>page</html>", { status: 200, headers: { "content-type": "text/html" } }) } };
  const www = await worker.fetch(new Request("https://www.anxoscontrolcenter.org/release-notes?x=1"), env);
  assert.strictEqual(www.status, 301);
  assert.strictEqual(www.headers.get("location"), "https://anxoscontrolcenter.org/release-notes?x=1", "www keeps the path and query");
  for (const host of ["anxos-control-center.pages.dev", "3f9c2a1b.anxos-control-center.pages.dev"]) {
    const copy = await worker.fetch(new Request(`https://${host}/`), env);
    assert.strictEqual(copy.status, 200, `${host} still works for previews`);
    assert.strictEqual(copy.headers.get("x-robots-tag"), "noindex, nofollow", `${host} is never indexed`);
    assert.strictEqual(await copy.text(), "<html>page</html>");
  }
  const apex = await worker.fetch(new Request("https://anxoscontrolcenter.org/"), env);
  assert.strictEqual(apex.status, 200);
  assert.strictEqual(apex.headers.get("x-robots-tag"), null, "the real site is indexable");
  const api = await worker.fetch(new Request("https://anxoscontrolcenter.org/api/download/latest/not-a-platform"), env);
  assert.strictEqual(api.status, 404, "the download API is unchanged");
  console.log("PASS I1 www redirects to the indexed address; pages.dev copies are noindex");

  // I2
  const sitemap = fs.readFileSync(path.join(site, "sitemap.xml"), "utf8");
  const urls = [...sitemap.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => ({
    loc: /<loc>([^<]+)<\/loc>/.exec(match[1])?.[1],
    lastmod: /<lastmod>([^<]+)<\/lastmod>/.exec(match[1])?.[1],
  }));
  assert.ok(urls.length >= 5, "the sitemap lists the site's pages");
  const today = new Date().toISOString().slice(0, 10);
  for (const url of urls) {
    assert.match(url.lastmod || "", /^\d{4}-\d{2}-\d{2}$/, `${url.loc} has a lastmod date`);
    assert.ok(url.lastmod <= today, `${url.loc} is not dated in the future`);
  }
  assert.deepStrictEqual(planSitemap({ date: "1970-01-01" }).changed, [], "the committed dates match the pages");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "anx-sitemap-"));
  const copySite = path.join(scratch, "website");
  fs.cpSync(site, copySite, { recursive: true, filter: (source) => !/[\\/]assets[\\/]/.test(source) });
  fs.appendFileSync(path.join(copySite, "faq", "index.html"), "\n<!-- a content change -->\n");
  const plan = planSitemap({ date: "2030-01-02", siteDir: copySite });
  assert.deepStrictEqual(plan.changed, ["https://anxoscontrolcenter.org/faq/"], "only the changed page is re-dated");
  assert.match(plan.sitemap, /<loc>https:\/\/anxoscontrolcenter\.org\/faq\/<\/loc>\s*<lastmod>2030-01-02<\/lastmod>/);
  fs.writeFileSync(path.join(copySite, "sitemap.xml"), plan.sitemap);
  fs.writeFileSync(path.join(copySite, "sitemap-state.json"), plan.state);
  assert.deepStrictEqual(planSitemap({ date: "2030-01-03", siteDir: copySite }).changed, [], "a second run changes nothing");
  fs.writeFileSync(path.join(copySite, "faq", "index.html"), fs.readFileSync(path.join(copySite, "faq", "index.html"), "utf8").replace(/\r?\n/g, "\r\n"));
  assert.deepStrictEqual(planSitemap({ date: "2030-01-04", siteDir: copySite }).changed, [], "line endings are not a content change");
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log("PASS I2 sitemap dates follow real content changes only");

  // I3
  const config = loadConfig();
  const build = String(config?.build || config?.currentBuild || "").replace(/\D/g, "") || /Build (\d+)/.exec(fs.readFileSync(path.join(site, "release-notes.html"), "utf8"))?.[1];
  assert.ok(build, "the current build is known");
  for (const file of ["index.html", "release-notes.html", "download.html", "system-requirements/index.html"]) {
    const html = fs.readFileSync(path.join(site, file), "utf8");
    assert.ok(new RegExp(`Build ${build}\\b`).test(html), `${file} names Build ${build} in its static HTML`);
    const records = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)]
      .map((match) => JSON.parse(match[1]))
      .filter((record) => record["@type"] === "SoftwareApplication");
    if (records.length) {
      assert.strictEqual(records.length, 1, `${file} has one SoftwareApplication record`);
      assert.match(records[0].softwareVersion, new RegExp(`Build ${build}$`), `${file}'s structured data names Build ${build}`);
    }
  }
  console.log(`PASS I3 the release pages name Build ${build} in static HTML and structured data`);

  // I4
  const robots = fs.readFileSync(path.join(site, "robots.txt"), "utf8");
  assert.match(robots, /^Sitemap: https:\/\/anxoscontrolcenter\.org\/sitemap\.xml$/m);
  const disallowed = [...robots.matchAll(/^Disallow:\s*(\S+)/gm)].map((match) => match[1]);
  for (const url of urls) {
    const urlPath = url.loc.replace("https://anxoscontrolcenter.org", "") || "/";
    assert.ok(!disallowed.some((rule) => urlPath.startsWith(rule)), `${url.loc} is not blocked by robots.txt`);
  }
  console.log("PASS I4 robots.txt names the sitemap and blocks none of its pages");

  // I5: IndexNow submits only the pages that changed, and never before the
  // deployed site serves the same key.
  const indexnow = require("./indexnow-submit");
  const { key, keyLocation } = indexnow.findKey();
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.strictEqual(keyLocation, `https://anxoscontrolcenter.org/${key}.txt`);
  const newest = urls.map((url) => url.lastmod).sort().pop();
  const planned = indexnow.planSubmission();
  assert.deepStrictEqual(planned.payload.urlList, urls.filter((url) => url.lastmod >= newest).map((url) => url.loc), "only the newest changes are submitted");
  assert.strictEqual(indexnow.planSubmission({ all: true }).payload.urlList.length, urls.length);
  assert.ok(!disallowed.some((rule) => `/${key}.txt`.startsWith(rule)), "robots.txt does not block the key file");
  const calls = [];
  const fakeFetch = (liveKey, status = 200) => async (url, options = {}) => {
    calls.push({ url, options });
    if (url === keyLocation) return new Response(liveKey, { status: liveKey === null ? 404 : 200 });
    return new Response("", { status });
  };
  await assert.rejects(indexnow.submit(planned.payload, { fetchImpl: fakeFetch("0".repeat(32)) }), /different/);
  await assert.rejects(indexnow.submit(planned.payload, { fetchImpl: fakeFetch(null) }), /unavailable \(HTTP 404\)/);
  assert.ok(calls.every((call) => call.url === keyLocation), "nothing is posted until the live key matches");
  calls.length = 0;
  const accepted = await indexnow.submit(planned.payload, { fetchImpl: fakeFetch(key, 202) });
  assert.strictEqual(accepted.submitted, planned.payload.urlList.length);
  const post = calls.find((call) => call.url === indexnow.ENDPOINT);
  assert.strictEqual(post.options.method, "POST");
  assert.deepStrictEqual(JSON.parse(post.options.body), { host: "anxoscontrolcenter.org", key, keyLocation, urlList: planned.payload.urlList });
  await assert.rejects(indexnow.submit(planned.payload, { fetchImpl: fakeFetch(key, 403) }), /HTTP 403/);
  console.log(`PASS I5 IndexNow submits ${planned.payload.urlList.length} changed page(s) only after the live key matches`);
  console.log("Website search indexing smoke passed (5 checks).");
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
