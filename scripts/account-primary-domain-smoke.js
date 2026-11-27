#!/usr/bin/env node
"use strict";

// 217-C: anxhost.anxlabs.net is the app's primary website.
//   D1 both hosts are trusted; the legacy origin is unchanged (FI-UPD-01)
//   D2 account pages (sign-in, activation, account) open on the primary host,
//      although the bundled website config still names the legacy one
//   D3 legacy and primary account URLs are approved; other hosts are refused
//   D4 a site URL set through the environment is used exactly as given
//   D5 the update fallback reads the primary website first, then the legacy one
//   D6 the account function source allows the primary origin beside the legacy one
// Run: node scripts/account-primary-domain-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const PRIMARY = "https://anxhost.anxlabs.net";
const LEGACY = "https://anxoscontrolcenter.org";
const SITE_ENV = ["ANXOS_WEBSITE_BASE_URL", "WEBSITE_BASE_URL", "ANXOS_ACCOUNT_SITE_URL"];

function loadService(configDir, env = {}) {
  process.env.ANXHUB_CONFIG_DIR = configDir;
  for (const key of SITE_ENV) delete process.env[key];
  Object.assign(process.env, env);
  for (const file of ["accountAuthService.js", "secureSessionStore.js"]) delete require.cache[require.resolve(path.join(root, "src", "services", file))];
  return require("../src/services/accountAuthService");
}

const results = [];
async function check(label, fn) {
  try { await fn(); results.push(`PASS ${label}`); } catch (error) { results.push(`FAIL ${label}\n  ${error.message}`); }
}

async function main() {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-primary-domain-"));
  try {
    await check("D1 both hosts are trusted and the legacy origin is unchanged", () => {
      const site = require("../src/shared/officialSite");
      assert.strictEqual(site.OFFICIAL_SITE_ORIGIN, LEGACY);
      assert.strictEqual(site.PRIMARY_SITE_ORIGIN, PRIMARY);
      assert.deepStrictEqual([...site.OFFICIAL_SITE_HOSTNAMES].sort(), ["anxhost.anxlabs.net", "anxoscontrolcenter.org"]);
    });

    await check("D2 account pages open on the primary host", () => {
      const bundled = fs.readFileSync(path.join(root, "website", "account-config.js"), "utf8");
      assert.ok(bundled.includes(`siteUrl: "${LEGACY}"`), "the bundled website config still names the legacy host (the website and Supabase emails use it)");
      const service = loadService(configDir);
      assert.strictEqual(service.buildWebsiteUrl("activate", { code: "ABCD-2345" }), `${PRIMARY}/activate/?code=ABCD-2345`);
      assert.strictEqual(service.buildWebsiteUrl("signin"), `${PRIMARY}/signin/`);
      assert.strictEqual(service.buildWebsiteUrl("account"), `${PRIMARY}/account/`);
      assert.strictEqual(service.getStatus().siteUrl, PRIMARY);
    });

    await check("D3 legacy and primary URLs are approved; other hosts are refused", () => {
      const source = fs.readFileSync(path.join(root, "src", "services", "accountAuthService.js"), "utf8");
      assert.ok(source.includes("const APPROVED_AUTH_HOSTS = new Set(OFFICIAL_SITE_HOSTNAMES);"), "the allowlist is the shared host list");
      const service = loadService(configDir, { ANXOS_WEBSITE_BASE_URL: `${LEGACY}` });
      assert.strictEqual(service.buildWebsiteUrl("signin"), `${LEGACY}/signin/`, "legacy host still approved");
      const evil = loadService(configDir, { ANXOS_WEBSITE_BASE_URL: "https://anxhost.anxlabs.net.example.com" });
      assert.throws(() => evil.buildWebsiteUrl("signin"), (error) => error.code === "ACCOUNT_URL_NOT_APPROVED", "a look-alike host is refused");
    });

    await check("D4 a site URL from the environment is used exactly as given", () => {
      const service = loadService(configDir, { ANXOS_WEBSITE_BASE_URL: `${LEGACY}/` });
      assert.strictEqual(service.getStatus().siteUrl, LEGACY);
    });

    await check("D5 the update fallback reads the primary website first, then the legacy one", () => {
      const source = fs.readFileSync(path.join(root, "src", "services", "updateManager.js"), "utf8");
      const primaryAt = source.indexOf("`${PRIMARY_SITE_ORIGIN}/config.js`");
      const legacyAt = source.indexOf("`${OFFICIAL_SITE_ORIGIN}/config.js`");
      assert.ok(primaryAt > 0 && legacyAt > primaryAt, "primary config.js is listed before the legacy one");
    });

    await check("D6 the account function source allows the primary origin beside the legacy one", () => {
      for (const name of ["anxos-account", "anxos-marketplace-curseforge"]) {
        const source = fs.readFileSync(path.join(root, "supabase", "functions", name, "index.ts"), "utf8");
        const list = source.slice(source.indexOf("const DEFAULT_ALLOWED_ORIGINS = ["), source.indexOf("];", source.indexOf("const DEFAULT_ALLOWED_ORIGINS = [")));
        assert.ok(list.includes(`"${LEGACY}"`) && list.includes(`"${PRIMARY}"`), `${name} keeps the legacy origin and adds the primary one`);
      }
    });
  } finally {
    for (const key of SITE_ENV) delete process.env[key];
    fs.rmSync(configDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  for (const line of results) console.log(line);
  const failed = results.filter((line) => line.startsWith("FAIL")).length;
  if (failed) { process.exitCode = 1; console.log(`account-primary-domain-smoke: ${failed} failed`); } else console.log(`account-primary-domain-smoke passed (${results.length} checks)`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
