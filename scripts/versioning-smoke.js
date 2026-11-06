const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJson = require("../package.json");
const {
  buildReleaseInfo,
  normalizeBuild,
  normalizeChannel,
  normalizeReleaseTag,
  normalizeReleaseVersion,
  parseReleaseTagBuild,
  readReleaseConfig,
} = require("../src/shared/releaseConfig");
const {
  UPDATE_STORE_SCHEMA_VERSION,
  UpdateManager,
  compareReleaseBuilds,
  extractReleaseBuild,
  pickLatestPublishedRelease,
  parseWebsiteConfigRelease,
} = require("../src/services/updateManager");

const release = buildReleaseInfo(readReleaseConfig());
const packageSource = fs.readFileSync(path.join(root, "package.json"), "utf8");
const diagnosticsSource = fs.readFileSync(path.join(root, "src", "services", "diagnosticsService.js"), "utf8");
const mainSource = fs.readFileSync(path.join(root, "main.js"), "utf8");
const updateManagerSource = fs.readFileSync(path.join(root, "src", "services", "updateManager.js"), "utf8");
const builderSource = fs.readFileSync(path.join(root, "scripts", "run-electron-builder.js"), "utf8");
const manifestSource = fs.readFileSync(path.join(root, "scripts", "write-update-manifest.js"), "utf8");
const releaseArtifactValidatorSource = fs.readFileSync(path.join(root, "scripts", "validate-release-artifacts.js"), "utf8");
const releaseWorkflowSource = fs.readFileSync(path.join(root, ".github", "workflows", "windows-release.yml"), "utf8");
const websiteConfig = fs.readFileSync(path.join(root, "website", "config.js"), "utf8");
const websiteNotes = JSON.parse(fs.readFileSync(path.join(root, "website", "release-notes.json"), "utf8"));
const currentReleaseNotesPaths = [
  path.join(root, `RELEASE_NOTES_${release.artifactVersion}.md`),
  path.join(root, `RELEASE_NOTES_${release.version}.md`),
];
const currentReleaseNotesPath = currentReleaseNotesPaths.find((filePath) => fs.existsSync(filePath));
const currentReleaseNotes = currentReleaseNotesPath ? fs.readFileSync(currentReleaseNotesPath, "utf8") : "";

assert(/^\d+\.\d+\.\d+$/.test(packageJson.version), "package.json must keep an internal SemVer-compatible version.");
assert.strictEqual(normalizeReleaseVersion(release.version), release.version, "Public release version must use major.minor format.");
assert.strictEqual(normalizeBuild(release.build), release.build, "Build must parse as a non-negative integer.");
assert.strictEqual(normalizeChannel("beta"), "Beta", "Channel aliases must normalize for release commands.");
assert(!/^\d+\.\d+\.\d+$/.test(release.version), "Public release version must not be three-number SemVer.");

assert(compareReleaseBuilds({ version: "1.7", build: 143 }, { version: "1.7", build: 142 }) > 0, "Updater must detect newer builds in the same public version.");
assert(compareReleaseBuilds({ version: "1.8", build: 150 }, { version: "1.7", build: 999 }) > 0, "Updater must detect newer public versions.");
assert.strictEqual(extractReleaseBuild("v1.7-build143"), 143, "Updater must parse build numbers from release tags.");
const updaterAsset = (tag, digest = `sha256:${"cd".repeat(32)}`) => ({
    name: process.platform === "win32" ? `AnxOS-Control-Center-Setup-${tag.replace(/^v/, "")}.exe` : `AnxOS-Control-Center-${tag.replace(/^v/, "")}.AppImage`,
    size: 100 * 1024 * 1024,
    digest,
    browser_download_url: `https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/download/${tag}/update.${process.platform === "win32" ? "exe" : "AppImage"}`,
  });
  const updaterStable = { draft: false, prerelease: false, tag_name: "v1.7-build144", published_at: "2026-07-14T06:00:00Z", assets: [updaterAsset("v1.7-build144")] };
  const updaterRc = { draft: false, prerelease: true, tag_name: "v1.7-build146", published_at: "2026-07-14T17:15:00Z", assets: [updaterAsset("v1.7-build146")] };
  const updaterRcOlder = { draft: false, prerelease: true, tag_name: "v1.7-build145", published_at: "2026-07-14T06:53:00Z", assets: [updaterAsset("v1.7-build145")] };

  // An RC is published as a pre-release, so the stable update fallback must keep preferring
  // the newest stable build even when a newer pre-release RC exists.
  assert.strictEqual(
    pickLatestPublishedRelease([updaterRc, updaterStable])?.tag_name,
    "v1.7-build144",
    "Updater stable fallback must prefer the public stable build over a newer prerelease RC.",
  );
  // An RC is still discoverable when explicitly requested for acceptance testing.
  assert.strictEqual(
    pickLatestPublishedRelease([updaterRcOlder, updaterRc], { allowPrerelease: true })?.tag_name,
    "v1.7-build146",
    "Updater must expose prerelease RCs when allowPrerelease is explicitly requested.",
  );
  // With only prereleases and no stable build, the steady updater has no stable latest.
  assert.strictEqual(pickLatestPublishedRelease([updaterRc])?.tag_name, undefined, "Updater stable fallback must not treat a lone prerelease as the stable latest.");

  const misflaggedRc = {
    draft: false,
    prerelease: false,
    tag_name: "v2.0-build205-rc3",
    name: "v2.0-build205-rc3",
    channel: "Private Alpha",
    version: "2.0",
    build: 205,
    published_at: "2026-11-06T00:00:00Z",
    assets: [updaterAsset("v2.0-build205-rc3")],
  };
  const privateAlpha = {
    draft: false,
    prerelease: true,
    tag_name: "v2.0-build209",
    name: "v2.0-build209",
    published_at: "2026-10-31T19:39:54Z",
    assets: [updaterAsset("v2.0-build209")],
  };
  const privateAlphaNamed = {
    draft: false,
    prerelease: false,
    tag_name: "v1.9-build199",
    name: "AnxOS Control Center v1.9 Build 199 - Private Alpha",
    published_at: "2026-09-04T10:00:03Z",
    assets: [updaterAsset("v1.9-build199")],
  };
  assert.strictEqual(pickLatestPublishedRelease([misflaggedRc, privateAlpha, updaterStable])?.tag_name, "v1.7-build144", "A mis-flagged RC listed first must not become the stable release.");
  assert.strictEqual(pickLatestPublishedRelease([updaterStable, privateAlpha, misflaggedRc])?.tag_name, "v1.7-build144", "Stable selection must not depend on GitHub list order.");
  assert.strictEqual(pickLatestPublishedRelease([misflaggedRc])?.tag_name, undefined, "A release-candidate tag is not stable when GitHub says prerelease=false.");
  assert.strictEqual(pickLatestPublishedRelease([privateAlphaNamed])?.tag_name, undefined, "A Private Alpha name is not stable when GitHub says prerelease=false.");
  assert.strictEqual(pickLatestPublishedRelease([misflaggedRc, privateAlpha], { channel: "Private Alpha" })?.tag_name, "v2.0-build209", "Private Alpha selection must prefer the plain prerelease over an older mis-flagged RC.");
  assert.strictEqual(pickLatestPublishedRelease([privateAlpha, misflaggedRc], { channel: "Private Alpha" })?.tag_name, "v2.0-build209", "Private Alpha selection must not depend on list order.");
  assert.strictEqual(pickLatestPublishedRelease([misflaggedRc], { channel: "Private Alpha" })?.tag_name, undefined, "An RC tag must not join Private Alpha because its channel string says Private Alpha.");
  const checksummedAlpha = {
    ...privateAlpha,
    published_at: "2026-10-01T00:00:00Z",
    html_url: "https://example.invalid/checksummed-209",
    assets: [{ ...updaterAsset("v2.0-build209"), digest: `sha256:${"ab".repeat(32)}` }],
  };
  const checksumlessAlpha = {
    ...privateAlpha,
    published_at: "2026-12-01T00:00:00Z",
    html_url: "https://example.invalid/checksumless-209",
    assets: [{ ...updaterAsset("v2.0-build209", ""), digest: "" }],
  };
  assert.strictEqual(
    pickLatestPublishedRelease([checksumlessAlpha, checksummedAlpha], { channel: "Private Alpha" })?.html_url,
    "https://example.invalid/checksummed-209",
    "The same build must keep the checksummed candidate and must not fall back to checksum-less metadata.",
  );
  const downgraded = new UpdateManager().resolveUpdateResult({
    version: "2.0",
    build: 205,
    tag_name: "v2.0-build205-rc3",
    name: "v2.0-build205-rc3",
    assets: [updaterAsset("v2.0-build205-rc3")],
  }, "fixture");
  assert.strictEqual(
    downgraded.hasUpdate,
    compareReleaseBuilds({ version: "2.0", build: 205 }, { version: release.version, build: release.build }) > 0,
    "An older candidate must not be reported as an update.",
  );
  assert(updateManagerSource.includes("selectionChannel") && updateManagerSource.includes("pickLatestPublishedRelease(candidates, selectionOptions)"), "Update checks must rank every fetched candidate for the installed channel.");
  const { NON_STABLE_MARKER } = require("../src/shared/releaseChannelSelection");
  for (const relativePath of [
    "website/release-download-service.js",
    "website/_worker.js",
    "website/functions/api/download/latest/[platform].js",
    "functions/_shared/release-download.mjs",
  ]) {
    assert(
      fs.readFileSync(path.join(root, relativePath), "utf8").includes(NON_STABLE_MARKER.toString()),
      `${relativePath} must use the shared non-stable release marker.`,
    );
  }

  // W4: the updater decides by release identity (version + build), not by the electron-builder
  // latest.yml internal package semver, so Build 200 is always distinguishable from Build 199.
  assert(compareReleaseBuilds({ version: "1.9", build: 200 }, { version: "1.9", build: 199 }) > 0, "Updater must distinguish Build 200 from Build 199 within the same public version.");
  assert.strictEqual(extractReleaseBuild("v1.9-build200"), 200, "Updater must parse the Build 200 tag identity.");
  assert(!updateManagerSource.includes("autoUpdater.checkForUpdates") && !updateManagerSource.includes("checkForUpdatesAndNotify"), "The in-app updater must not rely on electron autoUpdater (latest.yml internal semver) to drive update decisions.");

const parsedWebsiteRelease = parseWebsiteConfigRelease(websiteConfig, "https://anxoscontrolcenter.org/config.js");
const {
  collectReleasePages,
  isStableChannelRelease,
  releaseMatchesSelectionChannel,
} = require("../src/shared/releaseChannelSelection");
assert.strictEqual(isStableChannelRelease(parsedWebsiteRelease), false, "The committed website config tag is an RC and must not parse as stable.");
assert.strictEqual(releaseMatchesSelectionChannel(parsedWebsiteRelease, "private-alpha"), false, "An RC tag must not become Private Alpha because the website channel string says so.");
assert.strictEqual(parsedWebsiteRelease.version, release.version, "Website config must expose the centralized public version.");
const pagingChecks = async () => {
  const seen = [];
  const collected = await collectReleasePages("https://example.invalid/releases?per_page=100&page=1", async (url) => {
    seen.push(url);
    const page = new URL(url).searchParams.get("page");
    if (page === "2") return { releases: [updaterStable], link: "" };
    return {
      releases: Array.from({ length: 100 }, () => misflaggedRc),
      link: "<https://example.invalid/releases?per_page=100&page=2>; rel=\"next\"",
    };
  }, { pageSize: 100, maxPages: 5 });
  assert.strictEqual(collected.complete, true, "a short later page completes the scan.");
  assert.strictEqual(collected.urls.length, 2, "the scan must follow one same-origin next page.");
  assert.strictEqual(pickLatestPublishedRelease(collected.releases)?.tag_name, "v1.7-build144", "a stable release on page 2 must beat a full first page of mis-flagged RCs.");
  const capped = [];
  const cappedResult = await collectReleasePages("https://example.invalid/releases?page=1", async (url) => {
    capped.push(url);
    const page = Number(new URL(url).searchParams.get("page") || "1") + 1;
    return {
      releases: Array.from({ length: 100 }, () => misflaggedRc),
      link: `<https://example.invalid/releases?page=${page}>; rel="next"`,
    };
  }, { pageSize: 100, maxPages: 5 });
  assert.strictEqual(capped.length, 5, "release paging must stop at the page cap.");
  assert.strictEqual(cappedResult.complete, false, "a capped scan must not claim the feed was fully read.");
  const foreign = require("../src/shared/releaseChannelSelection").nextReleasePageUrl(
    "<https://evil.example/releases?page=2>; rel=\"next\"",
    "https://example.invalid/releases?page=1",
  );
  assert.strictEqual(foreign, "", "a next link to another origin must be ignored.");
};
assert(
  parsedWebsiteRelease.build <= release.build,
  "Website config must not advertise a build newer than the local development build.",
);
assert.strictEqual(parsedWebsiteRelease.channel, release.channel, "Website config must expose the centralized channel.");

assert(packageSource.includes("ANXOS_RELEASE_ARTIFACT_VERSION"), "Installer artifact naming must use the public release artifact label.");
assert(packageSource.includes("scripts/run-electron-builder.js"), "Packaged build scripts must go through the build increment wrapper.");
assert(packageSource.includes("release-build.json"), "Packaged builds must include generated release build metadata.");
assert(diagnosticsSource.includes("getReleaseInfo") && diagnosticsSource.includes("packageVersion"), "Diagnostics must include public release info and keep internal package version secondary.");
assert(mainSource.includes("releaseLabel") && mainSource.includes("packageVersion"), "Runtime info must expose public release fields and internal package version.");
assert(mainSource.includes("release-build.json") && mainSource.includes("buildDate") && mainSource.includes("gitCommit"), "Runtime info must expose packaged build date and commit metadata.");
assert(builderSource.includes("release-build.json") && builderSource.includes("supportedOperatingSystems") && builderSource.includes("minimumArchitecture"), "Packaging must generate release metadata for bundled builds.");
assert(manifestSource.includes("supportedOperatingSystems") && manifestSource.includes("minimumArchitecture") && manifestSource.includes("updateSource"), "Updater metadata must publish platform and update-source details.");
assert(manifestSource.includes("expectedReleaseArtifacts") && manifestSource.includes("checksumManifest") && manifestSource.includes("localAgentRuntime") && manifestSource.includes("rollback"), "Updater metadata must publish release artifact, checksum, Local Agent runtime, and rollback details.");
assert(manifestSource.includes('fs.writeFileSync(path.join(distDir, "SHA256SUMS")') && manifestSource.includes('`${sha256File(path.join(distDir, name))}  ${name}`'), "Local update metadata generation must write a sha256sum-compatible SHA256SUMS file.");
assert(manifestSource.includes("windows-setup-blockmap") && manifestSource.includes("latest.yml") && manifestSource.includes("latest-linux.yml"), "Updater metadata must include blockmap and platform updater metadata assets.");
assert(releaseWorkflowSource.includes("--no-increment-build"), "Tagged release workflow must preserve committed release metadata.");
assert(releaseWorkflowSource.includes("latest.yml") && releaseWorkflowSource.includes("latest-linux.yml") && releaseWorkflowSource.includes("update-manifest.json"), "Tagged release workflow must publish updater metadata.");
assert(releaseWorkflowSource.includes("validate-release-artifacts.js --directory release-artifacts"), "Tagged release workflow must validate release artifacts before upload.");
assert(releaseWorkflowSource.includes("ANXOS_RELEASE_REPO_TOKEN") && releaseWorkflowSource.includes("AnxOS-Control-Center-Releases"), "Tagged release workflow must publish to the public release-only repository with the release token.");
assert(releaseArtifactValidatorSource.includes("SHA256SUMS") && releaseArtifactValidatorSource.includes("localAgentRuntime") && releaseArtifactValidatorSource.includes("forbiddenTextPattern"), "Release artifact validator must enforce checksums, bundled Local Agent metadata, and secret/path redaction.");
assert(packageSource.includes('"release:artifacts:smoke": "node scripts/validate-release-artifacts.js --fixture"'), "Package scripts must expose release artifact validation smoke coverage.");
assert(updateManagerSource.includes("AnxOS-Control-Center-Releases"), "Updater must default to the public release-only repository.");
assert(updateManagerSource.includes("DEFAULT_UPDATE_REPOSITORY") && updateManagerSource.includes("normalizeUpdateRepository(process.env.ANXOS_UPDATE_REPOSITORY)"), "Updater repository overrides must be validated before use.");
assert(updateManagerSource.includes("per_page=${RELEASE_LIST_PAGE_SIZE}") && updateManagerSource.includes("collectReleasePages") && updateManagerSource.includes("pickLatestPublishedRelease"), "Updater must page the release list and rank Private Alpha prereleases instead of relying only on GitHub releases/latest.");
assert(updateManagerSource.includes("isProductionSafeMetadataUrl") && updateManagerSource.includes("app?.isPackaged !== true") && updateManagerSource.includes('parsed.protocol === "https:"'), "Packaged builds must ignore local or non-HTTPS update metadata overrides.");
assert(!updateManagerSource.includes("192.168.1.134:8766"), "Updater must not ship a hardcoded local-network manifest fallback.");
assert(websiteConfig.includes(`latestVersion: "${release.version}"`) && websiteConfig.includes(`channel: "${release.channel}"`), "Website download metadata must display the public release model.");
assert(!websiteConfig.includes("packageVersion"), "Website public metadata must not expose the internal package SemVer.");
assert(websiteNotes.some((entry) => entry.version === parsedWebsiteRelease.version && Number(entry.build) === parsedWebsiteRelease.build && entry.channel === parsedWebsiteRelease.channel), "Website release notes must include the currently advertised public version/build/channel.");
assert(currentReleaseNotes, "Current unreleased release notes must exist in the repository.");
const currentReleaseText = currentReleaseNotes;
[
  `v${release.version}`,
  "Added",
  "Fixed",
  "QA",
].forEach((phrase) => {
  assert(currentReleaseText.includes(phrase), `Current release notes must include ${phrase}.`);
});

{
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-update-store-"));
  const storePath = path.join(tempRoot, "updates.json");
  const manager = new UpdateManager();
  manager.storePath = storePath;

  fs.writeFileSync(storePath, `${JSON.stringify({ skippedVersions: ["1.6"] })}\n`, { mode: 0o600 });
  manager.loadStore();
  assert(manager.skippedVersions.has("1.6"), "legacy update preferences should preserve skipped versions.");
  assert.strictEqual(JSON.parse(fs.readFileSync(storePath, "utf8")).schemaVersion, UPDATE_STORE_SCHEMA_VERSION, "legacy update preferences should migrate to the current schema.");
  assert(fs.existsSync(`${storePath}.schema-v0.backup`), "legacy update migration should preserve the original file.");

  manager.pendingInstall = {
    status: "handed-off",
    previousVersion: "1.6",
    previousBuild: 149,
    targetVersion: release.version,
    targetBuild: release.build,
    artifactName: `AnxOS-Control-Center-Setup-${release.artifactVersion}.exe`,
  };
  manager.saveStore();
  manager.reconcilePendingInstall();
  assert.strictEqual(manager.pendingInstall.status, "launch-confirmed", "A successful target-version launch must confirm persisted installer handoff state.");
  assert.strictEqual(JSON.parse(fs.readFileSync(storePath, "utf8")).pendingInstall.status, "launch-confirmed", "Confirmed update launch state must persist atomically.");

  const futureState = { schemaVersion: UPDATE_STORE_SCHEMA_VERSION + 1, skippedVersions: ["9.9"] };
  fs.writeFileSync(storePath, `${JSON.stringify(futureState)}\n`, { mode: 0o600 });
  const futureRaw = fs.readFileSync(storePath, "utf8");
  manager.loadStore();
  assert.strictEqual(manager.storeError?.code, "UPDATE_STORE_SCHEMA_UNSUPPORTED", "future update schemas should produce a stable recovery error.");
  assert.throws(() => manager.saveStore(), (error) => error?.code === "UPDATE_STORE_SCHEMA_UNSUPPORTED", "writes must remain blocked while future update state is unresolved.");
  assert.throws(() => manager.skip("1.8"), (error) => error?.code === "UPDATE_STORE_SCHEMA_UNSUPPORTED", "skip actions must fail before mutating memory while persistence is blocked.");
  assert.strictEqual(manager.skippedVersions.has("1.8"), false, "a rejected skip action must not leave partial in-memory state.");
  assert.strictEqual(fs.readFileSync(storePath, "utf8"), futureRaw, "future update state must remain unchanged.");

  fs.writeFileSync(storePath, "{not-json\n", { mode: 0o600 });
  manager.loadStore();
  assert.strictEqual(manager.storeError?.code, "UPDATE_STORE_CORRUPT", "corrupt update state should produce a stable recovery error.");
  assert(fs.readdirSync(tempRoot).some((name) => name.startsWith("updates.json.corrupt-")), "corrupt update state should be preserved.");
fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }

  // RC-retry provenance: an immutable suffix tag overrides release provenance only,
  // never product identity (version/build/artifact naming).
  assert.strictEqual(normalizeReleaseTag("v1.9-build200"), "v1.9-build200", "Canonical release tag must be accepted.");
  assert.strictEqual(normalizeReleaseTag("v1.9-build200-rc2"), "v1.9-build200-rc2", "Immutable RC suffix tag must be accepted.");
  assert.strictEqual(parseReleaseTagBuild("v1.9-build200-rc2"), 200, "An RC suffix must normalize to product Build 200.");
  assert.strictEqual(parseReleaseTagBuild("v1.9-build200"), 200, "A canonical tag must parse to its numeric build.");
  assert.strictEqual(parseReleaseTagBuild("v1.9-build199"), 199, "A prior Build tag must parse to its own build, never Build 201.");
  assert.throws(() => normalizeReleaseTag("v1.9-build200-"), (error) => /Release tag must match/i.test(error.message), "An empty RC suffix must be rejected.");
  assert.throws(() => normalizeReleaseTag("v1.9-build200-rc2!"), (error) => /Release tag must match/i.test(error.message), "A malformed RC suffix must be rejected.");

  const priorTag = process.env.ANXOS_RELEASE_TAG;
  try {
    const retryTag = `v${release.version}-build${release.build}-rc1`;
    process.env.ANXOS_RELEASE_TAG = retryTag;
    const retryRelease = buildReleaseInfo(readReleaseConfig());
    assert.strictEqual(retryRelease.version, release.version, "RC retry must keep the configured release version family.");
    assert.strictEqual(retryRelease.artifactVersion, release.artifactVersion, "RC retry must keep the base release artifact filenames.");
    assert.strictEqual(retryRelease.tag, retryTag, "RC retry must apply the RC tag for release provenance.");
    assert.strictEqual(retryRelease.releaseUrl, `https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/tag/${retryTag}`, "RC retry release URL must reference the RC tag.");
    const assetUrl = `${retryRelease.releaseRepositoryUrl}/releases/download/${retryRelease.tag}/AnxOS-Control-Center-Setup-${retryRelease.artifactVersion}.exe`;
    assert.strictEqual(assetUrl, `https://github.com/AnxLabs/AnxOS-Control-Center-Releases/releases/download/${retryTag}/AnxOS-Control-Center-Setup-${release.artifactVersion}.exe`, "RC retry asset URL must use the RC tag with the base release filename.");
  } finally {
    if (priorTag === undefined) {
      delete process.env.ANXOS_RELEASE_TAG;
    } else {
      process.env.ANXOS_RELEASE_TAG = priorTag;
    }
  }

pagingChecks().then(() => {
  console.log("Versioning smoke checks passed.");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
