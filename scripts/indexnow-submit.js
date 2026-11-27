#!/usr/bin/env node
// Tells IndexNow search engines (Bing, Yandex, Seznam, Naver and others; not
// Google) which website pages changed, so a new release is recrawled within
// hours instead of whenever the crawler next visits.
//
// The pages to submit come from website/sitemap.xml: every URL whose <lastmod>
// is on or after --since (default: the newest lastmod in the sitemap, which is
// the date of the last content change website-sitemap.js recorded).
//
// The key is public by design: IndexNow proves ownership by fetching
// https://anxoscontrolcenter.org/<key>.txt, whose content must be the key.
// Before posting, this script fetches that file from the live site and refuses
// to submit if it is missing or different (the deploy has not gone live yet).
//
// Dry run by default: prints what it would submit and makes no request.
//   --submit             fetch the live key file, then POST to IndexNow
//   --since=YYYY-MM-DD   submit pages changed on or after this date
//   --all                submit every sitemap URL
const fs = require("fs");
const path = require("path");

const SITE = path.resolve(__dirname, "..", "website");
// The canonical host (website/_worker.js CANONICAL_HOST, see website-hosts.js).
const HOST = require("./website-hosts").canonicalHost();
const ORIGIN = `https://${HOST}`;
const ENDPOINT = "https://api.indexnow.org/indexnow";

function findKey(siteDir = SITE) {
  const keys = fs.readdirSync(siteDir).filter((name) => /^[0-9a-f]{32}\.txt$/.test(name)).filter((name) => {
    return fs.readFileSync(path.join(siteDir, name), "utf8").trim() === name.slice(0, -4);
  });
  if (keys.length !== 1) throw new Error(`Expected exactly one IndexNow key file in website/ (found ${keys.length})`);
  const key = keys[0].slice(0, -4);
  return { key, keyLocation: `${ORIGIN}/${keys[0]}` };
}

function planSubmission({ siteDir = SITE, since = null, all = false } = {}) {
  const xml = fs.readFileSync(path.join(siteDir, "sitemap.xml"), "utf8");
  const entries = [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => ({
    loc: /<loc>([^<]+)<\/loc>/.exec(match[1])?.[1]?.trim() || "",
    lastmod: /<lastmod>([^<]+)<\/lastmod>/.exec(match[1])?.[1]?.trim() || null,
  }));
  const onSite = entries.filter((entry) => entry.loc.startsWith(`${ORIGIN}/`));
  const newest = onSite.map((entry) => entry.lastmod).filter(Boolean).sort().pop() || null;
  const cutoff = all ? null : (since || newest);
  const urlList = onSite.filter((entry) => !cutoff || (entry.lastmod && entry.lastmod >= cutoff)).map((entry) => entry.loc);
  const { key, keyLocation } = findKey(siteDir);
  return { cutoff, payload: { host: HOST, key, keyLocation, urlList } };
}

async function submit(payload, { fetchImpl = fetch } = {}) {
  if (!payload.urlList.length) return { submitted: 0, status: null };
  const live = await fetchImpl(payload.keyLocation, { headers: { "user-agent": "AnxOS-website-indexnow" } });
  const liveKey = live.ok ? (await live.text()).trim() : null;
  if (liveKey !== payload.key) {
    throw new Error(`The live key file ${payload.keyLocation} is ${live.ok ? "different" : `unavailable (HTTP ${live.status})`}; deploy the website before submitting.`);
  }
  const response = await fetchImpl(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", "user-agent": "AnxOS-website-indexnow" },
    body: JSON.stringify(payload),
  });
  // 200 = accepted, 202 = accepted while the key is being validated.
  if (response.status !== 200 && response.status !== 202) throw new Error(`IndexNow refused the submission (HTTP ${response.status})`);
  return { submitted: payload.urlList.length, status: response.status };
}

async function main(argv = process.argv.slice(2)) {
  const since = argv.find((arg) => arg.startsWith("--since="))?.slice(8) || null;
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error("--since must be YYYY-MM-DD");
  const { cutoff, payload } = planSubmission({ since, all: argv.includes("--all") });
  console.log(`IndexNow: ${payload.urlList.length} page(s) ${cutoff ? `changed since ${cutoff}` : "in the sitemap"}:`);
  for (const url of payload.urlList) console.log(`  ${url}`);
  if (!argv.includes("--submit")) {
    console.log("Dry run: nothing was sent. Add --submit after the website deploy is live.");
    return;
  }
  const result = await submit(payload);
  console.log(`IndexNow accepted ${result.submitted} URL(s) (HTTP ${result.status}).`);
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });

module.exports = { findKey, planSubmission, submit, ENDPOINT };
