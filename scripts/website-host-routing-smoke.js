#!/usr/bin/env node
"use strict";

// Host routing in website/_worker.js for the AnxHost domain move
// (anxhost.anxlabs.net new, anxoscontrolcenter.org legacy). No network.
//   H1 as committed, the legacy host stays canonical: its pages are served and
//      indexable, the new host serves the same pages marked noindex
//   H2 the new host never serves sign-in: account, activate, sign-in and the
//      other auth pages go to the same path and query on the legacy host
//   H3 www of either host goes to the canonical host, except paths installed
//      apps use, which go to the legacy host
//   H4 with CANONICAL_HOST switched to the new host, ordinary legacy pages get
//      a 301 to the same path and query on the new host
//   H5 after the switch, nothing an installed app or tool uses is redirected:
//      config.js, release-notes.json, the download API, sign-in pages, the
//      IndexNow key, robots, sitemap and assets; POSTs are never redirected
//   H6 *.pages.dev copies are never indexed in either mode
// Run: node scripts/website-host-routing-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const LEGACY = "anxoscontrolcenter.org";
const NEW = "anxhost.anxlabs.net";
const workerPath = path.join(__dirname, "..", "website", "_worker.js");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "anx-hosts-"));

async function loadWorker(canonical) {
  let source = fs.readFileSync(workerPath, "utf8");
  assert.match(source, /^const CANONICAL_HOST = LEGACY_HOST;$/m, "the committed worker keeps the legacy host canonical");
  if (canonical === "new") source = source.replace(/^const CANONICAL_HOST = LEGACY_HOST;$/m, "const CANONICAL_HOST = NEW_HOST;");
  const target = path.join(scratch, `worker-${canonical}.mjs`);
  fs.writeFileSync(target, source);
  return (await import(pathToFileURL(target).href)).default;
}

const env = {
  ASSETS: {
    fetch: async (request) => {
      const url = new URL(typeof request === "string" ? request : request.url);
      return new Response(`asset ${url.pathname}`, { status: 200, headers: { "content-type": url.pathname.endsWith(".js") ? "text/javascript" : "text/html" } });
    },
  },
};

async function hit(worker, url, method = "GET") {
  return worker.fetch(new Request(url, { method, body: method === "POST" ? "x" : undefined }), env, { waitUntil() {} });
}

function assertRedirect(response, location, status, label) {
  assert.strictEqual(response.status, status, `${label}: status ${status}`);
  assert.strictEqual(response.headers.get("location"), location, `${label}: location`);
}

async function assertServed(response, label, { indexable }) {
  assert.strictEqual(response.status, 200, `${label}: served`);
  assert.strictEqual(response.headers.get("location"), null, `${label}: not redirected`);
  assert.strictEqual(response.headers.get("x-robots-tag"), indexable ? null : "noindex, nofollow", `${label}: ${indexable ? "indexable" : "noindex"}`);
}

const AUTH_PATHS = ["/account/", "/activate/?code=ABCD-1234", "/signin/", "/signup/", "/profile.html", "/device-login.html", "/forgot-password/", "/reset-password.html#token", "/sign-in", "/account.html"];
const APP_PATHS = ["/config.js", "/release-notes.json", "/account-config.js", "/robots.txt", "/sitemap.xml", "/63065fedd3db1e49b0c6286f2bfa4350.txt", "/assets/anxhost-logo.png", "/site.js", "/favicon.ico"];

async function main() {
  const legacyMode = await loadWorker("legacy");
  const newMode = await loadWorker("new");

  // H1
  for (const page of ["/", "/download", "/release-notes", "/features/", "/faq/index.html"]) {
    await assertServed(await hit(legacyMode, `https://${LEGACY}${page}`), `legacy ${page}`, { indexable: true });
    await assertServed(await hit(legacyMode, `https://${NEW}${page}`), `new ${page}`, { indexable: false });
  }
  console.log("PASS H1 legacy stays canonical as committed; the new host serves pages marked noindex");

  // H2
  for (const worker of [legacyMode, newMode]) {
    for (const auth of AUTH_PATHS) {
      const url = new URL(`https://${NEW}${auth}`);
      assertRedirect(await hit(worker, url.toString()), `https://${LEGACY}${url.pathname}${url.search}`, 302, `new-host ${auth}`);
      await assertServed(await hit(worker, `https://${LEGACY}${auth}`), `legacy ${auth}`, { indexable: worker === legacyMode });
    }
  }
  console.log(`PASS H2 the new host sends all ${AUTH_PATHS.length} sign-in paths to the legacy host, in both modes`);

  // H3
  assertRedirect(await hit(legacyMode, `https://www.${LEGACY}/release-notes?x=1`), `https://${LEGACY}/release-notes?x=1`, 301, "www legacy, legacy mode");
  assertRedirect(await hit(legacyMode, `https://www.${NEW}/download`), `https://${LEGACY}/download`, 301, "www new, legacy mode");
  assertRedirect(await hit(newMode, `https://www.${LEGACY}/download?y=2`), `https://${NEW}/download?y=2`, 301, "www legacy, new mode");
  assertRedirect(await hit(newMode, `https://www.${LEGACY}/activate/?code=1`), `https://${LEGACY}/activate/?code=1`, 301, "www sign-in stays legacy");
  assertRedirect(await hit(newMode, `https://www.${LEGACY}/config.js`), `https://${LEGACY}/config.js`, 301, "www config stays legacy");
  console.log("PASS H3 www goes to the canonical host, and app paths to the legacy host");

  // H4
  for (const page of ["/", "/download", "/release-notes?build=216", "/features/", "/faq/index.html", "/getting-started/", "/windows-installation"]) {
    assertRedirect(await hit(newMode, `https://${LEGACY}${page}`), `https://${NEW}${page}`, 301, `legacy ${page} after the switch`);
    await assertServed(await hit(newMode, `https://${NEW}${page}`), `new ${page} after the switch`, { indexable: true });
  }
  assert.strictEqual((await hit(newMode, `https://${LEGACY}/download`)).headers.get("cache-control"), "public, max-age=3600");
  console.log("PASS H4 after the switch, legacy pages 301 to the same path and query on the new host");

  // H5
  for (const appPath of APP_PATHS) {
    await assertServed(await hit(newMode, `https://${LEGACY}${appPath}`), `legacy ${appPath} after the switch`, { indexable: false });
  }
  const api = await hit(newMode, `https://${LEGACY}/api/download/latest/not-a-platform`);
  assert.strictEqual(api.status, 404, "the download API answers on the legacy host (unsupported platform), not a redirect");
  assert.strictEqual(api.headers.get("location"), null);
  for (const method of ["POST", "PUT"]) {
    const response = await hit(newMode, `https://${LEGACY}/download`, method);
    assert.strictEqual(response.headers.get("location"), null, `${method} is never redirected`);
  }
  console.log(`PASS H5 after the switch, ${APP_PATHS.length} app and tool paths, the download API and non-GET requests stay on the legacy host`);

  // H6
  for (const worker of [legacyMode, newMode]) {
    for (const host of ["anxos-control-center.pages.dev", "3f9c2a1b.anxos-control-center.pages.dev"]) {
      await assertServed(await hit(worker, `https://${host}/`), host, { indexable: false });
    }
  }
  console.log("PASS H6 pages.dev copies are noindex in both modes");

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log("Website host routing smoke passed (6 checks).");
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
