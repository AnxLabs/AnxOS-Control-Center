#!/usr/bin/env node
// Headless Agent update-check smoke.
//
// Covers the stamped release-identity contract (agent-release.json):
//   - readAgentReleaseIdentity honors ANXOS_AGENT_RELEASE_PATH and never throws
//     on missing/malformed stamps;
//   - compareArtifactVersions is build-aware and returns null for incomparable
//     input (never a false update);
//   - evaluateUpdateState never claims update-available for a development
//     install with no artifact marker and never suggests a downgrade;
//   - parseReleasePayload tolerates malformed JSON;
//   - findAgentDebAsset prefers the amd64 package, tolerates the documented
//     arch fallback, attaches the checksum asset, and refuses non-.deb names.
//
// Then an end-to-end leg against a local fake release endpoint: the CLI
// `update --check --json` reports current vs update-available and never fetches
// the .deb (the endpoint records every request), so nothing is downloaded or
// installed.
"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const cliPath = path.join(rootDir, "agent", "src", "cli.js");
const packageJson = require("../agent/package.json");
const updateCheck = require("../agent/src/services/agentUpdateCheck");
const {
  compareArtifactVersions,
  evaluateUpdateState,
  findAgentDebAsset,
  parseReleasePayload,
  readAgentReleaseIdentity,
} = updateCheck._test;

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-agent-update-smoke-"));
const configDir = path.join(smokeRoot, "config");
const logDir = path.join(smokeRoot, "logs");
fs.mkdirSync(configDir, { recursive: true });
fs.mkdirSync(logDir, { recursive: true });

const RELEASE_206 = {
  tag_name: "v2.0-build206",
  published_at: "2026-09-25T00:00:00Z",
  html_url: "https://example.invalid/releases/v2.0-build206",
  assets: [
    { name: "AnxOS-Agent-2.0-build206-arm64.deb", browser_download_url: "https://example.invalid/download/arm64.deb", size: 10 },
    { name: "AnxOS-Agent-2.0-build206-amd64.deb", browser_download_url: "https://example.invalid/download/amd64.deb", size: 20 },
    { name: "AnxOS-Agent-2.0-build206-amd64.deb.sha256", browser_download_url: "https://example.invalid/download/amd64.deb.sha256", size: 1 },
    { name: "AnxOS-Agent-2.0-build206.AppImage", browser_download_url: "https://example.invalid/download/appimage", size: 30 },
  ],
};
const RELEASE_205 = {
  tag_name: "v2.0-build205",
  assets: [
    { name: "AnxOS-Agent-2.0-build205-amd64.deb", browser_download_url: "https://example.invalid/download/amd64-205.deb", size: 20 },
    { name: "AnxOS-Agent-2.0-build205-amd64.deb.sha256", browser_download_url: "https://example.invalid/download/amd64-205.deb.sha256", size: 1 },
  ],
};

function writeStamp(fileName, payload) {
  const stampPath = path.join(smokeRoot, fileName);
  fs.writeFileSync(stampPath, typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  return stampPath;
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: smokeRoot,
      env: {
        ...process.env,
        ANXHUB_CONFIG_DIR: configDir,
        ANXHUB_AGENT_CONFIG_PATH: path.join(configDir, "agent.json"),
        ANXOS_LOG_DIR: logDir,
        ...env,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdin.end();
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 30000);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function startFakeReleaseServer(requests) {
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const origin = `http://127.0.0.1:${server.address().port}`;
    const withSelfOrigin = (release) => ({
      ...release,
      assets: release.assets.map((asset) => ({ ...asset, browser_download_url: `${origin}/download/${asset.name}` })),
    });
    if (request.url === "/releases/latest") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(withSelfOrigin(RELEASE_206)));
      return;
    }
    if (request.url === "/releases/older") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(withSelfOrigin(RELEASE_205)));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "not found" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  // --- readAgentReleaseIdentity: env override + honest failure modes ------
  const stamp205 = writeStamp("stamp-205.json", { schemaVersion: 1, product: "anxos-agent", artifactVersion: "2.0-build205", releaseTag: "v2.0-build205", builtAt: "2026-09-25T00:00:00.000Z" });
  const identity = readAgentReleaseIdentity({ env: { ANXOS_AGENT_RELEASE_PATH: stamp205 }, searchPaths: [] });
  assert(identity, "the stamped identity must be read from ANXOS_AGENT_RELEASE_PATH.");
  assert.strictEqual(identity.artifactVersion, "2.0-build205", "the stamped artifact version must be surfaced.");
  assert.strictEqual(identity.product, "anxos-agent", "the stamped product must be surfaced.");
  assert.strictEqual(identity.releaseTag, "v2.0-build205", "the stamped release tag must be surfaced.");
  assert.strictEqual(identity.identityPath, stamp205, "the identity must report where it was read from.");
  assert.strictEqual(readAgentReleaseIdentity({ env: { ANXOS_AGENT_RELEASE_PATH: path.join(smokeRoot, "missing.json") }, searchPaths: [] }), null, "a missing stamp must return null, not throw.");
  const malformedStamp = writeStamp("stamp-malformed.json", "{not json");
  assert.strictEqual(readAgentReleaseIdentity({ env: { ANXOS_AGENT_RELEASE_PATH: malformedStamp }, searchPaths: [] }), null, "a malformed stamp must return null, not throw.");
  const versionlessStamp = writeStamp("stamp-versionless.json", { product: "anxos-agent", releaseTag: "v2.0-build205" });
  assert.strictEqual(readAgentReleaseIdentity({ env: { ANXOS_AGENT_RELEASE_PATH: versionlessStamp }, searchPaths: [] }), null, "a stamp without artifactVersion must return null.");
  assert.strictEqual(readAgentReleaseIdentity({ env: {}, searchPaths: [] }), null, "with no override and no search paths there must be no identity.");

  // --- compareArtifactVersions -------------------------------------------
  assert.strictEqual(compareArtifactVersions("2.0-build205", "2.0-build206"), -1, "an older build must compare lower.");
  assert.strictEqual(compareArtifactVersions("2.0-build206", "2.0-build206"), 0, "equal builds must compare equal.");
  assert.strictEqual(compareArtifactVersions("2.0-build206", "2.0-build205"), 1, "a newer build must compare higher.");
  assert.strictEqual(compareArtifactVersions("2.0-build99", "2.0-build205"), -1, "build numbers must compare numerically, not lexically.");
  assert.strictEqual(compareArtifactVersions("dev", "2.0-build205"), null, "an unparseable version must be incomparable.");
  assert.strictEqual(compareArtifactVersions("2.0-build205", ""), null, "an empty version must be incomparable.");

  // --- evaluateUpdateState guarantees ------------------------------------
  const devState = evaluateUpdateState({ installedArtifactVersion: "", release: RELEASE_206 });
  assert.strictEqual(devState.state, "unknown", `a development install must never be offered an update (got ${devState.state}).`);
  assert(/development or source install/i.test(devState.reason), "the development state must explain why the check is unknown.");
  assert.strictEqual(devState.latestArtifactVersion, "2.0-build206", "the remote version must still be reported for transparency.");

  const downgradeState = evaluateUpdateState({ installedArtifactVersion: "2.0-build206", release: RELEASE_205 });
  assert.strictEqual(downgradeState.state, "current", "a release older than the installed package must not be offered.");
  assert(/no downgrade/i.test(downgradeState.reason), "the downgrade refusal must be explained.");

  const currentState = evaluateUpdateState({ installedArtifactVersion: "2.0-build206", release: RELEASE_206 });
  assert.strictEqual(currentState.state, "current", "an equal artifact version must be current.");
  assert.strictEqual(currentState.reason, null, "an equal artifact version needs no reason.");

  const availableState = evaluateUpdateState({ installedArtifactVersion: "2.0-build205", release: RELEASE_206 });
  assert.strictEqual(availableState.state, "update-available", "a newer artifact version must be update-available.");
  assert.strictEqual(availableState.latestArtifactVersion, "2.0-build206", "the newer version must be reported.");
  assert.strictEqual(availableState.downloadUrl, "https://example.invalid/download/amd64.deb", "the amd64 download URL must be reported.");
  assert.strictEqual(availableState.checksumUrl, "https://example.invalid/download/amd64.deb.sha256", "the checksum URL must be reported.");

  const garbageState = evaluateUpdateState({ installedArtifactVersion: "dev-checkout", release: RELEASE_206 });
  assert.strictEqual(garbageState.state, "unknown", "an incomparable installed version must never produce update-available.");

  const noAssetState = evaluateUpdateState({ installedArtifactVersion: "2.0-build205", release: { tag_name: "v2.0-build206", assets: [{ name: "notes.zip" }] } });
  assert.strictEqual(noAssetState.state, "unknown", "a release without a .deb asset must not produce update-available.");
  assert(/Debian package/i.test(noAssetState.reason), "the missing-package state must explain the cause.");

  const malformedReleaseState = evaluateUpdateState({ installedArtifactVersion: "2.0-build205", release: "{oops" });
  assert.strictEqual(malformedReleaseState.state, "unknown", "malformed release metadata must degrade to unknown.");

  // --- parseReleasePayload tolerance -------------------------------------
  assert.doesNotThrow(() => parseReleasePayload("{malformed"), "parseReleasePayload must not throw on malformed JSON.");
  assert.strictEqual(parseReleasePayload("{malformed"), null, "malformed JSON must parse to null.");
  assert.strictEqual(parseReleasePayload("[1,2,3]"), null, "an array payload must parse to null.");
  assert.strictEqual(parseReleasePayload(null), null, "a null payload must parse to null.");
  const parsedFromText = parseReleasePayload(JSON.stringify(RELEASE_206));
  assert.strictEqual(parsedFromText.releaseTag, "v2.0-build206", "raw JSON text must be parsed.");
  assert.strictEqual(parsedFromText.latestArtifactVersion, "2.0-build206", "the artifact version must be derived from the asset name.");
  const parsedFromObject = parseReleasePayload(RELEASE_206);
  assert.strictEqual(parsedFromObject.latestArtifactVersion, "2.0-build206", "object payloads must be accepted directly.");
  const emptyPayload = parseReleasePayload({});
  assert(emptyPayload && Array.isArray(emptyPayload.assets) && emptyPayload.assets.length === 0, "an object without assets must normalize to an empty asset list.");

  // --- findAgentDebAsset --------------------------------------------------
  assert.strictEqual(findAgentDebAsset(RELEASE_206).name, "AnxOS-Agent-2.0-build206-amd64.deb", "the amd64 package must be preferred.");
  assert.strictEqual(findAgentDebAsset(RELEASE_206).arch, "amd64", "the chosen asset must report its arch.");
  assert.strictEqual(findAgentDebAsset({ assets: [{ name: "AnxOS-Agent-2.0-build206-arm64.deb" }] }).arch, "arm64", "an arm64-only release must fall back to arm64.");
  assert.strictEqual(findAgentDebAsset({ assets: [{ name: "AnxOS-Agent-2.0-build206.deb" }] }).arch, "amd64", "an un-suffixed package must be treated as amd64.");
  assert.strictEqual(findAgentDebAsset({ assets: [{ name: "AnxOS-Agent-2.0-build206.AppImage" }, { name: "release-notes.zip" }] }), null, "non-.deb assets must be refused.");
  assert.strictEqual(findAgentDebAsset({ assets: [] }), null, "an empty release must refuse.");
  assert.strictEqual(findAgentDebAsset([{ name: "AnxOS-Agent-2.0-build205.deb", browser_download_url: "https://example.invalid/d.deb" }]).arch, "amd64", "a bare asset array must be accepted.");

  const misflaggedRc = {
    tag_name: "v2.0-build205-rc3",
    name: "v2.0-build205-rc3",
    prerelease: false,
    channel: "Private Alpha",
    published_at: "2026-11-06T00:00:00Z",
    assets: [{ name: "AnxOS-Agent-2.0-build205.deb", browser_download_url: "https://example.invalid/205.deb" }],
  };
  const privateAlpha = {
    tag_name: "v2.0-build209",
    name: "v2.0-build209",
    prerelease: true,
    published_at: "2026-10-31T19:39:54Z",
    assets: [
      { name: "AnxOS-Agent-2.0-build209.deb", browser_download_url: "https://example.invalid/209.deb" },
      { name: "AnxOS-Agent-2.0-build209.deb.sha256", browser_download_url: "https://example.invalid/209.deb.sha256" },
    ],
  };
  const plainStable = {
    tag_name: "v1.7-build144",
    name: "v1.7-build144",
    prerelease: false,
    published_at: "2026-07-14T06:00:00Z",
    assets: [
      { name: "AnxOS-Agent-1.7-build144.deb", browser_download_url: "https://example.invalid/144.deb" },
      { name: "AnxOS-Agent-1.7-build144.deb.sha256", browser_download_url: "https://example.invalid/144.deb.sha256" },
    ],
  };
  const respond = (body) => async () => ({ ok: true, status: 200, json: async () => body });
  const stableFromReversedList = await updateCheck.checkForUpdate({
    source: "https://example.invalid/releases?per_page=20",
    installedArtifactVersion: "1.7-build100",
    fetchImpl: respond([misflaggedRc, privateAlpha, plainStable]),
  });
  assert.strictEqual(stableFromReversedList.state, "update-available", "a real stable release must remain selectable.");
  assert.strictEqual(stableFromReversedList.latestArtifactVersion, "1.7-build144", "stable selection must ignore a newer mis-flagged RC and a newer alpha, regardless of list order.");
  assert.strictEqual(stableFromReversedList.checksumUrl, "https://example.invalid/144.deb.sha256", "the selected stable package must keep its checksum URL.");
  const stableFromOtherOrder = await updateCheck.checkForUpdate({
    source: "https://example.invalid/releases?per_page=20",
    installedArtifactVersion: "1.7-build100",
    fetchImpl: respond([plainStable, privateAlpha, misflaggedRc]),
  });
  assert.strictEqual(stableFromOtherOrder.latestArtifactVersion, stableFromReversedList.latestArtifactVersion, "Agent stable selection must not depend on list order.");
  const rejectedLatest = await updateCheck.checkForUpdate({
    source: "https://example.invalid/releases/latest",
    installedArtifactVersion: "2.0-build200",
    fetchImpl: respond(misflaggedRc),
  });
  assert.strictEqual(rejectedLatest.state, "unknown", "GitHub /releases/latest must not offer a mis-flagged RC as a stable update.");
  assert.ok(!rejectedLatest.downloadUrl, "a rejected RC must not expose a download URL.");
  assert.strictEqual(rejectedLatest.channel, "stable");
  const privateAlphaUpdate = await updateCheck.checkForUpdate({
    source: "https://example.invalid/releases?per_page=20",
    channel: "Private Alpha",
    installedArtifactVersion: "2.0-build200",
    fetchImpl: respond([misflaggedRc, privateAlpha]),
  });
  assert.strictEqual(privateAlphaUpdate.state, "update-available");
  assert.strictEqual(privateAlphaUpdate.latestArtifactVersion, "2.0-build209", "Private Alpha selection must prefer Build 209 over the older mis-flagged RC.");
  assert.strictEqual(privateAlphaUpdate.checksumUrl, "https://example.invalid/209.deb.sha256", "Private Alpha selection must keep checksum enforcement metadata.");
  const privateAlphaOtherOrder = await updateCheck.checkForUpdate({
    source: "https://example.invalid/releases?per_page=20",
    channel: "private-alpha",
    installedArtifactVersion: "2.0-build200",
    fetchImpl: respond([privateAlpha, misflaggedRc]),
  });
  assert.strictEqual(privateAlphaOtherOrder.latestArtifactVersion, "2.0-build209", "Private Alpha selection must not depend on list order.");
  const noDowngrade = await updateCheck.checkForUpdate({
    source: "https://example.invalid/releases?per_page=20",
    channel: "Private Alpha",
    installedArtifactVersion: "2.0-build209",
    fetchImpl: respond([misflaggedRc, privateAlpha]),
  });
  assert.strictEqual(noDowngrade.state, "current", "a newer installed Private Alpha must not be offered an older candidate.");
  assert.notStrictEqual(noDowngrade.latestArtifactVersion, "2.0-build205");
  const olderStable = await updateCheck.checkForUpdate({
    source: "https://example.invalid/releases?per_page=20",
    installedArtifactVersion: "2.0-build209",
    fetchImpl: respond([misflaggedRc, plainStable]),
  });
  assert.strictEqual(olderStable.state, "current");
  assert.strictEqual(olderStable.latestArtifactVersion, "1.7-build144", "the stable candidate must be the plain stable release, not the mis-flagged RC.");
  assert(/no downgrade/i.test(olderStable.reason || ""), "an older stable release must not be suggested as a downgrade.");
  const channelStamp = readAgentReleaseIdentity({
    path: writeStamp("stamp-channel.json", { artifactVersion: "2.0-build209", releaseTag: "v2.0-build209", channel: "Private Alpha", product: "anxos-agent" }),
    searchPaths: [],
    env: {},
  });
  assert.strictEqual(channelStamp.channel, "Private Alpha", "a stamped update channel must be part of the installed identity.");
  assert(fs.readFileSync(path.join(rootDir, "scripts", "build-agent-deb.js"), "utf8").includes("channel: releaseInfo.channel"), "the Agent package stamp must copy the release.json channel.");
  const checksumlessNewer = {
    tag_name: "v2.0-build210",
    name: "v2.0-build210",
    prerelease: true,
    published_at: "2026-12-01T00:00:00Z",
    assets: [{ name: "AnxOS-Agent-2.0-build210.deb", browser_download_url: "https://example.invalid/210.deb" }],
  };
  const stampedChannelUpdate = await updateCheck.checkForUpdate({
    source: "https://example.invalid/releases?per_page=100&page=1",
    releaseIdentity: { artifactVersion: "2.0-build200", releaseTag: "v2.0-build200", channel: "Private Alpha" },
    fetchImpl: respond([misflaggedRc, checksumlessNewer, privateAlpha]),
  });
  assert.strictEqual(stampedChannelUpdate.channel, "private-alpha", "the installed stamp must select Private Alpha without ANXOS_UPDATE_CHANNEL.");
  assert.strictEqual(stampedChannelUpdate.latestArtifactVersion, "2.0-build209", "a newer checksum-less package must not hide the checksummed Private Alpha.");
  assert.strictEqual(stampedChannelUpdate.checksumUrl, "https://example.invalid/209.deb.sha256");
  const stableOverride = await updateCheck.checkForUpdate({
    source: "https://example.invalid/releases?per_page=100&page=1",
    env: { ANXOS_UPDATE_CHANNEL: "stable" },
    releaseIdentity: { artifactVersion: "1.7-build100", channel: "Private Alpha" },
    fetchImpl: respond([misflaggedRc, privateAlpha, plainStable]),
  });
  assert.strictEqual(stableOverride.channel, "stable", "ANXOS_UPDATE_CHANNEL must override the installed stamp.");
  assert.strictEqual(stableOverride.latestArtifactVersion, "1.7-build144");
  const { RELEASE_LIST_PAGE_SIZE } = require("../src/shared/releaseChannelSelection");
  const filler = Array.from({ length: RELEASE_LIST_PAGE_SIZE }, (_, index) => ({
    tag_name: `v9.0-build${index}-rc1`,
    name: `v9.0-build${index}-rc1`,
    prerelease: false,
    assets: [{ name: `AnxOS-Agent-9.0-build${index}.deb`, browser_download_url: "https://example.invalid/filler.deb" }],
  }));
  const pageRequests = [];
  const paged = await updateCheck.checkForUpdate({
    source: "https://example.invalid/releases?per_page=100&page=1",
    releaseIdentity: { artifactVersion: "2.0-build200", channel: "Private Alpha" },
    fetchImpl: async (url) => {
      pageRequests.push(String(url));
      const page = new URL(url).searchParams.get("page");
      if (page === "2") {
        return { ok: true, status: 200, headers: { get() { return ""; } }, json: async () => [privateAlpha] };
      }
      return {
        ok: true,
        status: 200,
        headers: { get() { return "<https://example.invalid/releases?per_page=100&page=2>; rel=\"next\""; } },
        json: async () => filler,
      };
    },
  });
  assert.strictEqual(paged.latestArtifactVersion, "2.0-build209", "Agent selection must read the release past the first full page.");
  assert.strictEqual(pageRequests.length, 2, "a short second page must stop the scan.");
  assert(pageRequests[1].includes("page=2"), "the second request must be the same-origin next page.");
  console.log("unit legs passed: identity, comparison, evaluation guarantees, payload tolerance, asset selection, channel selection");

  // --- CLI end-to-end against a local fake release endpoint ---------------
  const requests = [];
  const { server, port } = await startFakeReleaseServer(requests);
  const source = `http://127.0.0.1:${port}/releases/latest`;
  try {
    const available = await runCli(["update", "--check", "--json"], { ANXOS_AGENT_RELEASE_PATH: stamp205, ANXOS_AGENT_UPDATE_SOURCE: source });
    assert.strictEqual(available.code, 0, `update --check --json must exit 0 (stderr: ${available.stderr}).`);
    const availableJson = JSON.parse(available.stdout);
    assert.strictEqual(availableJson.state, "update-available", `the packaged 2.0-build205 install must see build206 (got ${availableJson.state}).`);
    assert.strictEqual(availableJson.installedArtifactVersion, "2.0-build205", "the CLI must read the installed artifact identity from the stamp.");
    assert.strictEqual(availableJson.latestArtifactVersion, "2.0-build206", "the CLI must report the latest artifact version.");
    assert.strictEqual(availableJson.currentVersion, packageJson.version, "the CLI must still report the independent runtime version.");
    assert.strictEqual(availableJson.assetName, "AnxOS-Agent-2.0-build206-amd64.deb", "the CLI must select the amd64 package.");
    assert.strictEqual(availableJson.downloadUrl, `http://127.0.0.1:${port}/download/AnxOS-Agent-2.0-build206-amd64.deb`, "the CLI must report the download URL without fetching it.");
    assert.strictEqual(availableJson.readOnly, true, "the check must declare itself read-only.");
    assert.strictEqual(requests.length, 1, `the check must make exactly one metadata request, saw ${JSON.stringify(requests)}.`);
    assert(!requests.some((entry) => /\.deb/.test(entry)), "no .deb download may be requested by a check.");
    const installAttempt = await runCli(["update"], { ANXOS_AGENT_RELEASE_PATH: stamp205, ANXOS_AGENT_UPDATE_SOURCE: source });
    assert.strictEqual(installAttempt.code, 2, "update without --check must be refused with the usage code (the CLI has no install path).");
    assert(/never downloads or installs/i.test(installAttempt.stderr), "the refusal must state that the CLI never installs.");

    requests.length = 0;
    const current = await runCli(["update", "--check", "--json"], { ANXOS_AGENT_RELEASE_PATH: writeStamp("stamp-206.json", { artifactVersion: "2.0-build206", product: "anxos-agent", releaseTag: "v2.0-build206" }), ANXOS_AGENT_UPDATE_SOURCE: source });
    assert.strictEqual(current.code, 0, "a current install check must exit 0.");
    assert.strictEqual(JSON.parse(current.stdout).state, "current", "an equal installed artifact must report current.");
    assert.strictEqual(requests.length, 1, "the current check must make exactly one metadata request.");

    requests.length = 0;
    const dev = await runCli(["update", "--check", "--json"], { ANXOS_AGENT_RELEASE_PATH: "", ANXOS_AGENT_UPDATE_SOURCE: source });
    assert.strictEqual(dev.code, 0, "a development install check must exit 0.");
    const devJson = JSON.parse(dev.stdout);
    assert.strictEqual(devJson.state, "unknown", `a development install must never be offered an update (got ${devJson.state}).`);
    assert.strictEqual(devJson.installedArtifactVersion, null, "a development install must report no artifact version.");
    assert(/development or source install/i.test(devJson.reason), "the development state must be explained.");
    assert(!requests.some((entry) => /\.deb/.test(entry)), "a development check must not request a package.");

    requests.length = 0;
    const olderSource = `http://127.0.0.1:${port}/releases/older`;
    const downgrade = await runCli(["update", "--check", "--json"], { ANXOS_AGENT_RELEASE_PATH: path.join(smokeRoot, "stamp-206.json"), ANXOS_AGENT_UPDATE_SOURCE: olderSource });
    assert.strictEqual(downgrade.code, 0, "an older-release check must exit 0.");
    const downgradeJson = JSON.parse(downgrade.stdout);
    assert.strictEqual(downgradeJson.state, "current", "an older remote release must not be offered as an update.");
    assert(/no downgrade/i.test(downgradeJson.reason || ""), "the downgrade refusal must be explained by the CLI.");
    console.log("CLI legs passed: update-available, current, development, and downgrade states against a local fake endpoint with no package fetch");

    console.log("agent:update:smoke passed — release identity, artifact comparison, state guarantees, and read-only CLI check");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error("agent:update:smoke FAILED:", error.stack || error.message);
  process.exitCode = 1;
}).finally(() => {
  try { fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
});
