#!/usr/bin/env node
"use strict";

// The website's /api/download/latest/<platform> route when GitHub refuses it.
// On 2026-11-27 about half of the live requests returned 502: the Worker asked
// GitHub's API on every request, unauthenticated, from Cloudflare's shared
// outbound IPs, and GitHub answered 403 (rate limit). No network is used here.
//   D1 GitHub refuses and nothing is cached: the stable release named by this
//      deployment's config.js is served (the old route returned 502)
//   D2 a successful list is reused: repeated downloads ask GitHub once
//   D3 after the fresh window, a refusal serves the last good list, not config
//   D4 ?prerelease=1 never falls back to config.js (it names only stable)
//   D5 a configured ANXOS_GITHUB_TOKEN is sent; without it nothing is
//   D6 the config fallback refuses any URL outside the official release repo
//   D7 the dormant Pages Function behaves the same (D1, D2)
// Run: node scripts/website-download-resilience-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pathToFileURL } = require("url");

const site = path.join(__dirname, "..", "website");
const configSource = fs.readFileSync(path.join(site, "config.js"), "utf8");
const RELEASES = "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/download/";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "anx-download-"));
let copies = 0;

// A fresh module copy per scenario, so module-level memory starts empty.
async function freshModule(relative) {
  copies += 1;
  const target = path.join(scratch, `module-${copies}.mjs`);
  fs.copyFileSync(path.join(site, relative), target);
  return import(pathToFileURL(target).href);
}

function fakeCache() {
  const store = new Map();
  return {
    store,
    default: {
      async match(request) {
        const hit = store.get(typeof request === "string" ? request : request.url);
        return hit ? hit.clone() : undefined;
      },
      async put(request, response) {
        store.set(typeof request === "string" ? request : request.url, response.clone());
      },
    },
  };
}

function assets(config = configSource) {
  return {
    fetch: async (request) => {
      const url = new URL(typeof request === "string" ? request : request.url);
      if (url.pathname === "/config.js") return new Response(config, { status: 200, headers: { "content-type": "text/javascript" } });
      return new Response("not found", { status: 404 });
    },
  };
}

function githubRelease(build, prerelease = false) {
  const tag = `v2.0-build${build}`;
  return {
    tag_name: tag, draft: false, prerelease, published_at: `2026-11-${String(build % 28 + 1).padStart(2, "0")}T00:00:00Z`,
    assets: [
      `AnxOS-Control-Center-Setup-2.0-build${build}.exe`,
      `AnxOS-Control-Center-2.0-build${build}-portable.exe`,
      `AnxOS-Control-Center-2.0-build${build}.AppImage`,
      `AnxOS-Control-Center-2.0-build${build}.deb`,
    ].map((name) => ({ name, browser_download_url: `${RELEASES}${tag}/${name}` })),
  };
}

function installFetch(responder) {
  const calls = [];
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return responder(String(url), options);
  };
  return calls;
}

const refused = () => new Response(JSON.stringify({ message: "API rate limit exceeded" }), { status: 403 });
const listed = (releases) => () => new Response(JSON.stringify(releases), { status: 200, headers: { "content-type": "application/json" } });
const configBuild = /buildNumber:\s*"(\d+)"/.exec(configSource)?.[1];

async function callWorker(worker, platform, env, query = "") {
  return worker.fetch(new Request(`https://anxoscontrolcenter.org/api/download/latest/${platform}${query}`), env, { waitUntil() {} });
}

async function main() {
  assert.ok(configBuild, "config.js names the stable build");
  const realNow = Date.now;

  // D1
  {
    global.caches = fakeCache();
    installFetch(refused);
    const worker = (await freshModule("_worker.js")).default;
    const expected = {
      windows: `AnxOS-Control-Center-Setup-2.0-build${configBuild}.exe`,
      "windows-portable": `AnxOS-Control-Center-2.0-build${configBuild}-portable.exe`,
      "linux-appimage": `AnxOS-Control-Center-2.0-build${configBuild}.AppImage`,
      "linux-deb": `AnxOS-Control-Center-2.0-build${configBuild}.deb`,
    };
    for (const [platform, file] of Object.entries(expected)) {
      const response = await callWorker(worker, platform, { ASSETS: assets() });
      assert.strictEqual(response.status, 302, `${platform}: a GitHub refusal still downloads (was 502)`);
      assert.ok(response.headers.get("location").startsWith(RELEASES), `${platform}: official release URL`);
      assert.ok(response.headers.get("location").endsWith(`/${file}`), `${platform}: the stable ${file}`);
    }
    console.log(`PASS D1 GitHub 403 with no cache serves the stable Build ${configBuild} assets from config.js`);
  }

  // D2
  {
    global.caches = fakeCache();
    let first = true;
    const calls = installFetch((url) => {
      if (first) { first = false; return listed([githubRelease(999)])(); }
      return refused();
    });
    const worker = (await freshModule("_worker.js")).default;
    for (let index = 0; index < 5; index += 1) {
      const response = await callWorker(worker, "windows", { ASSETS: assets() });
      assert.strictEqual(response.status, 302);
      assert.ok(response.headers.get("location").endsWith("AnxOS-Control-Center-Setup-2.0-build999.exe"), "the GitHub answer is used");
    }
    assert.strictEqual(calls.filter((call) => call.url.startsWith("https://api.github.com/")).length, 1, "five downloads ask GitHub once");
    // A second isolate (fresh module memory) reuses the edge cache.
    const second = (await freshModule("_worker.js")).default;
    const again = await callWorker(second, "linux-deb", { ASSETS: assets() });
    assert.ok(again.headers.get("location").endsWith("AnxOS-Control-Center-2.0-build999.deb"));
    assert.strictEqual(calls.filter((call) => call.url.startsWith("https://api.github.com/")).length, 1, "another isolate reads the edge cache");
    console.log("PASS D2 a successful release list is reused across requests and isolates");
  }

  // D3
  {
    global.caches = fakeCache();
    let now = realNow();
    Date.now = () => now;
    let answer = listed([githubRelease(998)]);
    const calls = installFetch(() => answer());
    const worker = (await freshModule("_worker.js")).default;
    assert.strictEqual((await callWorker(worker, "windows", { ASSETS: assets() })).status, 302);
    answer = refused;
    now += 6 * 60 * 1000;
    const stale = await callWorker(worker, "windows", { ASSETS: assets() });
    assert.strictEqual(stale.status, 302);
    assert.ok(stale.headers.get("location").endsWith("build998.exe"), "the last good list is used, not config.js");
    assert.strictEqual(calls.length, 2, "GitHub was asked again after the fresh window");
    now += 8 * 24 * 60 * 60 * 1000;
    const tooOld = await callWorker(worker, "windows", { ASSETS: assets() });
    assert.ok(tooOld.headers.get("location").endsWith(`build${configBuild}.exe`), "a list older than the stale window gives way to config.js");
    Date.now = realNow;
    console.log("PASS D3 after the fresh window a refusal serves the last good list");
  }

  // D4
  {
    global.caches = fakeCache();
    installFetch(refused);
    const worker = (await freshModule("_worker.js")).default;
    const response = await callWorker(worker, "windows", { ASSETS: assets() }, "?prerelease=1");
    assert.strictEqual(response.status, 503, "prerelease lookups never fall back to the stable config");
    assert.strictEqual(response.headers.get("retry-after"), "60");
    assert.deepStrictEqual(await response.json(), { error: "release_source_unavailable", status: 403 });
    console.log("PASS D4 ?prerelease=1 with GitHub refusing answers 503 with Retry-After");
  }

  // D5
  {
    global.caches = fakeCache();
    const calls = installFetch(listed([githubRelease(997)]));
    await callWorker((await freshModule("_worker.js")).default, "windows", { ASSETS: assets() });
    assert.strictEqual(calls[0].options.headers.authorization, undefined, "no token, no authorization header");
    global.caches = fakeCache();
    const tokenCalls = installFetch(listed([githubRelease(997)]));
    await callWorker((await freshModule("_worker.js")).default, "windows", { ASSETS: assets(), ANXOS_GITHUB_TOKEN: "test-token" });
    assert.strictEqual(tokenCalls[0].options.headers.authorization, "Bearer test-token");
    console.log("PASS D5 ANXOS_GITHUB_TOKEN is sent only when configured");
  }

  // D6
  {
    global.caches = fakeCache();
    installFetch(refused);
    const hostile = 'window.X = { releaseAssets: [{ url: "https://evil.example/AnxOS-Control-Center-Setup-2.0-build1.exe" }, { url: "https://github.com/someone/else/releases/download/v1/AnxOS-Control-Center-Setup-2.0-build1.exe" }] };';
    const response = await callWorker((await freshModule("_worker.js")).default, "windows", { ASSETS: assets(hostile) });
    assert.strictEqual(response.status, 503, "no official URL in config means no redirect");
    console.log("PASS D6 the config fallback only redirects to the official release repository");
  }

  // D7
  {
    global.caches = fakeCache();
    installFetch(refused);
    const fn = await freshModule(path.join("functions", "api", "download", "latest", "[platform].js"));
    const request = new Request("https://anxoscontrolcenter.org/api/download/latest/windows");
    const refusedAnswer = await fn.onRequestGet({ request, params: { platform: "windows" }, env: { ASSETS: assets() }, waitUntil() {} });
    assert.strictEqual(refusedAnswer.status, 302);
    assert.ok(refusedAnswer.headers.get("location").endsWith(`Setup-2.0-build${configBuild}.exe`));
    global.caches = fakeCache();
    let first = true;
    const calls = installFetch(() => { if (first) { first = false; return listed([githubRelease(996)])(); } return refused(); });
    for (let index = 0; index < 3; index += 1) {
      const response = await fn.onRequestGet({ request, params: { platform: "windows" }, env: { ASSETS: assets() }, waitUntil() {} });
      assert.ok(response.headers.get("location").endsWith("build996.exe"));
    }
    assert.strictEqual(calls.length, 1);
    console.log("PASS D7 the dormant Pages Function falls back and caches the same way");
  }

  fs.rmSync(scratch, { recursive: true, force: true });
  console.log("Website download resilience smoke passed (7 checks).");
}

main().catch((error) => { console.error(error?.stack || error); process.exitCode = 1; });
