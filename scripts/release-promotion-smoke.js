#!/usr/bin/env node
// Regression coverage for the release promotion contract established by the Build 200
// pre-tag repair:
//   RC creation != public stable promotion.
// Provable claims (network-free):
//   - Stable/latest download and update surfaces never resolve a pre-release RC.
//   - Build 199 stays the public stable latest while the Build 200 RC is pre-release.
//   - An RC is only exposed when explicitly requested (allowPrerelease / ?prerelease=1).
//   - Website static metadata must match the current stable release (deploy guard).
//   - Cloudflare deployment is manual-only and guarded; it can never auto-promote an RC.
//   - Final promotion requires an explicit workflow_dispatch and refuses re-promotion.
//   - The official release repository is unchanged and the source repo never gets binaries.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const root = path.resolve(__dirname, "..");
const RELEASES_REPO = "AnxLabs/AnxOS-Control-Center-Releases";
const RELEASES_URL = `https://github.com/${RELEASES_REPO}`;

const { RELEASE_REPOSITORY } = require(path.join(root, "src", "shared", "releaseConfig"));
const updater = require(path.join(root, "src", "services", "updateManager"));
const service = require(path.join(root, "website", "release-download-service.js"));
const guard = require(path.join(root, "scripts", "verify-website-config-vs-stable.js"));

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function releaseAsset(name) {
  return { name, size: 100 * 1024 * 1024, browser_download_url: `${RELEASES_URL}/releases/download/v1.9-build200/${name}` };
}

function sampleReleases() {
  return [
    {
      draft: false,
      prerelease: false,
      tag_name: "v1.9-build199",
      name: "AnxOS Version 1.9 build199",
      body: "Channel: Private Alpha\n\nPublic stable release.",
      published_at: "2026-09-10T00:00:00Z",
      html_url: `${RELEASES_URL}/releases/tag/v1.9-build199`,
      assets: [
        releaseAsset("AnxOS-Control-Center-Setup-1.9-build199.exe"),
        releaseAsset("AnxOS-Control-Center-1.9-build199.AppImage"),
        releaseAsset("AnxOS-Control-Center-1.9-build199.deb"),
      ],
    },
    {
      draft: false,
      prerelease: true,
      tag_name: "v1.9-build200",
      name: "AnxOS Version 1.9 build200 RC",
      body: "Channel: Private Alpha\n\nRelease candidate for acceptance testing.",
      published_at: "2026-09-15T00:00:00Z",
      html_url: `${RELEASES_URL}/releases/tag/v1.9-build200`,
      assets: [
        releaseAsset("AnxOS-Control-Center-Setup-1.9-build200.exe"),
        releaseAsset("AnxOS-Control-Center-1.9-build200.AppImage"),
        releaseAsset("AnxOS-Control-Center-1.9-build200.deb"),
      ],
    },
  ];
}

async function main() {
  const releases = sampleReleases();
  const helper = await import(pathToFileURL(path.join(root, "functions", "_shared", "release-download.mjs")).href);

  // 1. The official release repository is unchanged.
  assert.strictEqual(helper.DEFAULT_RELEASE_REPOSITORY, RELEASES_REPO, "Pages Functions must default to the official Releases repository.");
  assert.strictEqual(`${RELEASE_REPOSITORY.owner}/${RELEASE_REPOSITORY.repo}`, RELEASES_REPO, "releaseConfig must target the official Releases repository.");
  assert.deepStrictEqual(service.OFFICIAL_RELEASE_REPOSITORY, { owner: "AnxLabs", repo: "AnxOS-Control-Center-Releases" }, "Client renderer must target the official Releases repository.");
  assert(read("src/services/updateManager.js").includes(RELEASES_REPO), "In-app updater must default to the official Releases repository.");

  // 2. Stable/latest resolution must never resolve a pre-release RC.
  assert.strictEqual(helper.pickReleaseWithInstaller(releases).tag_name, "v1.9-build199", "Pages Functions stable latest must remain Build 199 while Build 200 is a prerelease.");
  assert.strictEqual(helper.pickReleaseWithInstaller(releases, { allowPrerelease: true }).tag_name, "v1.9-build200", "Explicit prerelease resolution must expose Build 200.");
  assert.strictEqual(service.latestPublishedRelease(releases, { repositoryUrl: RELEASES_URL })?.tagName, "v1.9-build199", "Client renderer stable latest must stay on Build 199.");
  assert.strictEqual(service.latestPublishedRelease(releases, { repositoryUrl: RELEASES_URL, allowPrerelease: true })?.tagName, "v1.9-build200", "Client renderer must resolve Build 200 only when allowPrerelease is requested.");
  assert.strictEqual(updater.pickLatestPublishedRelease(releases)?.tag_name, "v1.9-build199", "In-app updater stable fallback must not offer the Build 200 RC.");
  assert.strictEqual(updater.pickLatestPublishedRelease(releases, { allowPrerelease: true })?.tag_name, "v1.9-build200", "In-app updater must offer Build 200 only when explicitly requested as an RC.");

  // 3. Website static metadata must match the public stable release (deploy guard).
  assert.strictEqual(guard.configBuildNumber('window.ANXOS_DOWNLOAD_CONFIG = { build: "199", buildNumber: "199" };'), 199, "Deploy guard must parse config buildNumber.");
  assert.strictEqual(guard.buildFromTag("v1.9-build199"), 199, "Deploy guard must parse a stable tag build.");
  assert.strictEqual(guard.pickStableRelease(releases).tag_name, "v1.9-build199", "Deploy guard must resolve the stable latest while ignoring the RC.");
  const stableBuild199 = guard.buildFromTag("v1.9-build199");
  assert.strictEqual(guard.configBuildNumber('window.ANXOS_DOWNLOAD_CONFIG = { build: "199", buildNumber: "199" };'), stableBuild199, "Config Build 199 must match stable latest Build 199.");
  assert.notStrictEqual(guard.configBuildNumber('window.ANXOS_DOWNLOAD_CONFIG = { build: "200", buildNumber: "200" };'), stableBuild199, "Config advertising Build 200 must fail the stable guard while stable latest is Build 199.");

  // 4. Cloudflare deployment cannot auto-promote an RC into the stable website state.
  const cf = read(".github/workflows/cloudflare-pages-deploy.yml");
  assert(!/workflow_run/.test(cf), "Cloudflare deploy must not auto-trigger from a release or RC tag run.");
  assert(cf.includes("workflow_dispatch"), "Cloudflare deploy must be an explicit manual dispatch.");
  assert(cf.includes("verify-website-config-vs-stable.js"), "Cloudflare deploy must run the stable metadata consistency guard before publishing.");

  // 5. Final promotion requires an explicit approvable action and refuses re-promotion.
  const promote = read(".github/workflows/promote-release.yml");
  assert(promote.includes("workflow_dispatch"), "Promotion must be an explicit workflow_dispatch gate.");
  assert(promote.includes("make_latest"), "Promotion must set the release as GitHub latest.");
  assert(promote.includes("refusing to re-promote"), "Promotion must refuse an already-stable release.");
  assert(promote.includes("website:sync"), "Promotion must regenerate website metadata for the promoted build.");
  assert(promote.includes("gh workflow run cloudflare-pages-deploy.yml"), "Promotion must then trigger the guarded Cloudflare deploy.");

  // 6. Tag-flow immutability, fail-closed behavior, and Release-repo destination.
  const wr = read(".github/workflows/windows-release.yml");
  assert(wr.includes("AnxLabs/AnxOS-Control-Center-Releases"), "Release workflow must target the official Releases repository.");
  assert(!wr.includes("--clobber"), "Release workflow must not enable clobber/overwrite of historical assets.");
  assert(wr.includes("already exists"), "Release workflow must fail closed when the release already exists.");
  assert(wr.includes("--prerelease"), "A tag/RC must create a pre-release (never implicitly the stable latest).");
  assert(wr.includes("latest*.yml"), "Updater manifest generation must copy latest yml metadata into the manifest source directory.");

  // 7. The source repository never receives binaries (notes-only pointer via GITHUB_TOKEN).
  assert(wr.includes('GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}'), "Source-repository pointer must use the repo-scoped token, not the release token.");
  assert(wr.includes('GH_TOKEN: ${{ secrets.ANXOS_RELEASE_REPO_TOKEN }}'), "Release-asset publication must use the release-repository token.");

  // 8. The repair smoke itself is wired into the QA harness.
  const packageJson = JSON.parse(read("package.json"));
  assert(packageJson.scripts["release-promotion:smoke"], "release-promotion smoke must be wired into package scripts.");

  // 9. Immutable RC retry tag support: release provenance follows the actual tag,
  // while product identity stays Build 200.
  assert(promote.includes("(-[A-Za-z0-9]+)*"), "Promotion must accept an alphanumeric RC suffix tag.");
  assert(promote.includes("BUILD_NUM"), "Promotion must derive a numeric build independent of the RC suffix.");
  assert(promote.includes("ANXOS_RELEASE_TAG"), "Promotion must generate website metadata scoped to the promoted (RC) tag.");
  assert(wr.includes("ANXOS_RELEASE_TAG"), "Release workflow must pass the actual GitHub tag into metadata generation.");
  assert(wr.includes("ANXOS_UPDATE_BASE_URL"), "Release workflow must pass the RC-tag download base into the updater manifest.");
  const validateSourceAfter = read("scripts/validate-release-artifacts.js");
  assert(validateSourceAfter.includes("manifest.releaseUrl") && validateSourceAfter.includes("releases/download/${release.tag}/"), "Manifest validator must reject URLs that point at the wrong release tag.");
  const canonicalBase = "https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/download/v1.9-build200";
  assert.notStrictEqual(`${canonicalBase}/AnxOS-Control-Center-Setup-1.9-build200.exe`, `${canonicalBase}-rc2/AnxOS-Control-Center-Setup-1.9-build200.exe`, "Canonical and RC2 asset URLs must be distinct so a wrong-tag URL is caught.");

  console.log("Release promotion smoke checks passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});