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
  normalizeReleaseVersion,
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
assert.strictEqual(
  pickLatestPublishedRelease([
    { draft: false, prerelease: true, tag_name: "v1.7-build146", published_at: "2026-07-14T17:15:00Z", assets: [{ name: process.platform === "win32" ? "AnxOS-Control-Center-Setup-1.7-build146.exe" : "AnxOS-Control-Center-1.7-build146.AppImage", size: 100 * 1024 * 1024, browser_download_url: `https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/download/v1.7-build146/update.${process.platform === "win32" ? "exe" : "AppImage"}` }] },
    { draft: false, prerelease: true, tag_name: "v1.7-build145", published_at: "2026-07-14T06:53:00Z", assets: [{ name: process.platform === "win32" ? "AnxOS-Control-Center-Setup-1.7-build145.exe" : "AnxOS-Control-Center-1.7-build145.AppImage", size: 100 * 1024 * 1024, browser_download_url: `https://github.com/bungopam-byte/AnxOS-Control-Center-Releases/releases/download/v1.7-build145/update.${process.platform === "win32" ? "exe" : "AppImage"}` }] },
  ])?.tag_name,
  "v1.7-build146",
  "Updater must discover the newest published prerelease when the release repository has no stable latest release.",
);

const parsedWebsiteRelease = parseWebsiteConfigRelease(websiteConfig, "https://anxoscontrolcenter.org/config.js");
assert.strictEqual(parsedWebsiteRelease.version, release.version, "Website config must expose the centralized public version.");
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
assert(updateManagerSource.includes("releases?per_page=20") && updateManagerSource.includes("pickLatestPublishedRelease"), "Updater must discover Private Alpha prereleases instead of relying only on GitHub releases/latest.");
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
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("Versioning smoke checks passed.");
