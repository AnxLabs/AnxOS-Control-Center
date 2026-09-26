"use strict";

// Read-only update check for the Agent CLI. It fetches the latest release
// metadata and compares it with the installed Agent's release identity.
//
// The installed identity comes from agent-release.json, stamped by the .deb
// build at the runtime root (/usr/lib/anxos-agent/agent-release.json). Source
// and development checkouts have no such file: update checks then stay honest
// and report "unknown / development or source install" instead of comparing a
// package artifact against agent/package.json's placeholder version.
//
// Nothing is downloaded, installed, or modified here, and the public helpers
// never throw: missing, offline, malformed, or rate-limited sources all become
// state "unknown" with a reason.

const fs = require("fs");
const path = require("path");

const packageJson = require("../../package.json");

const DEFAULT_SOURCE = "https://api.github.com/repos/AnxLabs/AnxOS-Control-Center-Releases/releases/latest";
const DEB_ASSET_PATTERN = /^AnxOS-Agent-.*\.deb$/;
const RELEASE_IDENTITY_FILENAME = "agent-release.json";
const RELEASE_IDENTITY_ENV = "ANXOS_AGENT_RELEASE_PATH";
const CHECKSUM_ASSET_SUFFIX = ".sha256";
const DEFAULT_TIMEOUT_MS = 10000;

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

function getCurrentVersion() {
  return trim(packageJson.version) || "0.0.0";
}

function parseVersionParts(value) {
  const match = String(value || "").match(/\d+(?:\.\d+)*/);
  if (!match) return [];
  return match[0].split(".").map((part) => Number.parseInt(part, 10)).filter((part) => Number.isFinite(part));
}

// Simple robust numeric-segment comparison; returns -1 / 0 / 1.
function compareVersions(left, right) {
  const a = parseVersionParts(left);
  const b = parseVersionParts(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  return 0;
}

function deriveVersionFromAssetName(assetName) {
  const match = String(assetName || "").match(/AnxOS-Agent-(\d+(?:\.\d+)*)/i);
  return match ? match[1] : null;
}

function deriveVersionFromTag(tagName) {
  return parseVersionParts(tagName).join(".") || null;
}

// ---------------------------------------------------------------------------
// Release identity (<runtime root>/agent-release.json, stamped by the build).
// ---------------------------------------------------------------------------

// Relative to agent/src/services, the runtime root is:
//   installed package: ../..      -> /usr/lib/anxos-agent/agent
//                      ../../..   -> /usr/lib/anxos-agent  (where the build stamps it)
//   repo checkout:     ../..      -> <repo>/agent
// Only a file literally named agent-release.json is ever considered, so the
// repository's release.json can never be mistaken for an installed identity.
function releaseIdentitySearchPaths() {
  return [
    path.resolve(__dirname, "..", "..", "..", RELEASE_IDENTITY_FILENAME),
    path.resolve(__dirname, "..", "..", RELEASE_IDENTITY_FILENAME),
  ];
}

// Returns the parsed identity or null. Never throws, so a corrupt or missing
// file degrades to "no package identity" instead of breaking the CLI.
function readAgentReleaseIdentity(options = {}) {
  try {
    const env = options.env || process.env;
    const candidates = [];
    const explicit = trim(options.path) || trim(env[RELEASE_IDENTITY_ENV]);
    if (explicit) candidates.push(explicit);
    const extras = Array.isArray(options.searchPaths) ? options.searchPaths : releaseIdentitySearchPaths();
    for (const extra of extras) if (extra) candidates.push(extra);

    for (const candidate of candidates) {
      let parsed = null;
      try {
        parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const artifactVersion = trim(parsed.artifactVersion);
      if (!artifactVersion) continue;
      return {
        schemaVersion: Number.isInteger(parsed.schemaVersion) ? parsed.schemaVersion : 1,
        product: trim(parsed.product) || null,
        artifactVersion,
        releaseTag: trim(parsed.releaseTag) || null,
        builtAt: trim(parsed.builtAt) || null,
        identityPath: candidate,
      };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Artifact versions ("2.0-build205"). The runtime version in package.json is a
// different, independent identity and is never compared as if it were one.
// ---------------------------------------------------------------------------

function parseArtifactVersion(value) {
  const raw = trim(value).replace(/^v/i, "");
  if (!raw) return null;
  const match = raw.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-build(\d+))?(?:[-+].*)?$/i);
  if (!match) return null;
  return {
    parts: [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)],
    build: match[4] === undefined ? null : Number(match[4]),
  };
}

// Numeric build-aware comparison with a semver-ish fallback on the version
// core. Returns -1 / 0 / 1, or null when either side is not a recognizable
// artifact version, so callers can never claim an update from garbage input.
function compareArtifactVersions(left, right) {
  const a = parseArtifactVersion(left);
  const b = parseArtifactVersion(right);
  if (!a || !b) return null;
  const length = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a.parts[index] || 0) - (b.parts[index] || 0);
    if (difference !== 0) return difference > 0 ? 1 : -1;
  }
  const aBuild = a.build === null ? 0 : a.build;
  const bBuild = b.build === null ? 0 : b.build;
  if (aBuild === bBuild) return 0;
  return aBuild > bBuild ? 1 : -1;
}

function artifactVersionFromTag(tagName) {
  const match = trim(tagName).match(/^v?(\d+\.\d+)-build(\d+)/i);
  return match ? `${match[1]}-build${match[2]}` : null;
}

function artifactVersionFromAssetName(assetName) {
  const match = trim(assetName).match(/^AnxOS-Agent-(\d+\.\d+)-build(\d+)/i);
  if (match) return `${match[1]}-build${match[2]}`;
  return deriveVersionFromAssetName(assetName);
}

// ---------------------------------------------------------------------------
// Release payloads (GitHub releases/latest JSON).
// ---------------------------------------------------------------------------

function normalizeReleaseAssets(release) {
  const list = Array.isArray(release) ? release : Array.isArray(release?.assets) ? release.assets : [];
  return list
    .map((asset) => ({
      name: trim(asset?.name),
      downloadUrl: trim(asset?.browser_download_url ?? asset?.downloadUrl),
      sizeBytes: Number.isFinite(asset?.size) ? asset.size : null,
    }))
    .filter((asset) => asset.name);
}

// The default artifact has no architecture suffix (amd64); only non-amd64
// builds carry one. An arm64 asset is only chosen when no amd64 asset exists.
function detectAssetArch(name) {
  const match = trim(name).match(/-(arm64|armhf|i386|amd64)\.deb$/i);
  return match ? match[1].toLowerCase() : "amd64";
}

function findAgentDebAsset(release) {
  const assets = normalizeReleaseAssets(release);
  const debAssets = assets.filter((asset) => DEB_ASSET_PATTERN.test(asset.name));
  if (!debAssets.length) return null;
  const withArch = debAssets.map((asset) => ({ ...asset, arch: detectAssetArch(asset.name) }));
  const chosen = withArch.find((asset) => asset.arch === "amd64") || withArch[0];
  const checksum = assets.find((asset) => asset.name === `${chosen.name}${CHECKSUM_ASSET_SUFFIX}`);
  return {
    name: chosen.name,
    arch: chosen.arch,
    downloadUrl: chosen.downloadUrl || null,
    checksumUrl: checksum ? checksum.downloadUrl || null : null,
  };
}

// Safe parse: accepts the decoded GitHub payload or its raw JSON text and
// returns a normalized object, or null when nothing usable can be read.
function parseReleasePayload(payload) {
  let raw = payload;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const assets = normalizeReleaseAssets(raw);
  const tagName = trim(raw.tag_name) || trim(raw.tagName) || null;
  const debAsset = findAgentDebAsset(assets);
  return {
    releaseTag: tagName,
    tagName,
    latestArtifactVersion: (debAsset && artifactVersionFromAssetName(debAsset.name)) || artifactVersionFromTag(tagName),
    publishedAt: trim(raw.published_at) || null,
    htmlUrl: trim(raw.html_url) || null,
    assets,
  };
}

// ---------------------------------------------------------------------------
// Update state.
// ---------------------------------------------------------------------------

// Decides current / update-available / unknown from an installed artifact
// version and a release payload. Guarantees: never claims update-available for
// incomparable versions and never suggests a downgrade; without an installed
// artifact version it reports the development/source situation honestly.
function evaluateUpdateState(options = {}) {
  const release = parseReleasePayload(options.release);
  const installedArtifactVersion = trim(options.installedArtifactVersion);
  const base = {
    state: "unknown",
    reason: null,
    latestArtifactVersion: null,
    downloadUrl: null,
    checksumUrl: null,
  };
  if (!release) return { ...base, reason: "The release metadata could not be read." };

  const asset = findAgentDebAsset(release);
  if (!asset) {
    return { ...base, reason: "The latest release does not expose an AnxOS Agent Debian package." };
  }
  const latestArtifactVersion = release.latestArtifactVersion;
  const located = {
    ...base,
    latestArtifactVersion: latestArtifactVersion || null,
    downloadUrl: asset.downloadUrl || null,
    checksumUrl: asset.checksumUrl || null,
  };
  if (!latestArtifactVersion) {
    return { ...located, reason: "The latest release does not expose a recognizable AnxOS Agent version." };
  }
  if (!installedArtifactVersion) {
    return { ...located, reason: "This Agent has no release identity: development or source install. Update checks compare packaged releases only." };
  }
  const comparison = compareArtifactVersions(latestArtifactVersion, installedArtifactVersion);
  if (comparison === null) {
    return { ...located, reason: `Cannot compare the installed package (${installedArtifactVersion}) with the latest release (${latestArtifactVersion}).` };
  }
  if (comparison === 0) return { ...located, state: "current" };
  if (comparison > 0) return { ...located, state: "update-available" };
  return {
    ...located,
    state: "current",
    reason: `The installed package (${installedArtifactVersion}) is newer than the latest release (${latestArtifactVersion}); no downgrade is suggested.`,
  };
}

async function checkForUpdate(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const runtimeVersion = trim(options.currentVersion) || getCurrentVersion();
  const source = trim(options.source) || trim(env.ANXOS_AGENT_UPDATE_SOURCE) || DEFAULT_SOURCE;
  const timeoutMs = Number.parseInt(options.timeoutMs, 10) > 0 ? Number.parseInt(options.timeoutMs, 10) : DEFAULT_TIMEOUT_MS;
  const identity = options.releaseIdentity === undefined
    ? readAgentReleaseIdentity({ env, path: options.releaseIdentityPath })
    : options.releaseIdentity;
  const installedArtifactVersion = trim(options.installedArtifactVersion) || trim(identity?.artifactVersion);
  const base = {
    currentVersion: runtimeVersion,
    runtimeVersion,
    installedRuntimeVersion: runtimeVersion,
    installedArtifactVersion: installedArtifactVersion || null,
    packageVersion: installedArtifactVersion || null,
    installedReleaseTag: trim(identity?.releaseTag) || null,
    releaseIdentityPath: identity?.identityPath || null,
    source,
    readOnly: true,
  };

  try {
    new URL(source);
  } catch {
    return { ...base, state: "unknown", reason: "The update source is not a valid URL.", reachable: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(source, {
      headers: { accept: "application/vnd.github+json", "user-agent": "anxos-agent-cli" },
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timer);
    const code = error?.name === "AbortError" ? "timeout" : error?.cause?.code || error?.code || error?.message || "network error";
    return { ...base, state: "unknown", reason: `The release source is unreachable (${String(code)}).`, reachable: false };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return { ...base, state: "unknown", reason: `The release source answered HTTP ${response.status}.`, reachable: true };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    return { ...base, state: "unknown", reason: "The release source did not answer with valid JSON.", reachable: true };
  }

  const release = parseReleasePayload(payload);
  if (!release) {
    return { ...base, state: "unknown", reason: "The release source did not answer with valid JSON.", reachable: true };
  }
  const evaluation = evaluateUpdateState({
    installedArtifactVersion,
    installedRuntimeVersion: runtimeVersion,
    release,
    now: options.now,
  });
  const asset = findAgentDebAsset(release);
  return {
    ...base,
    state: evaluation.state,
    reason: evaluation.reason,
    latestVersion: evaluation.latestArtifactVersion,
    latestArtifactVersion: evaluation.latestArtifactVersion,
    releaseTag: release.releaseTag,
    assetName: asset?.name || null,
    assetArch: asset?.arch || null,
    downloadUrl: evaluation.downloadUrl || asset?.downloadUrl || null,
    checksumUrl: evaluation.checksumUrl || asset?.checksumUrl || null,
    reachable: true,
  };
}

module.exports = {
  DEFAULT_SOURCE,
  checkForUpdate,
  compareArtifactVersions,
  compareVersions,
  deriveVersionFromAssetName,
  deriveVersionFromTag,
  evaluateUpdateState,
  findAgentDebAsset,
  getCurrentVersion,
  parseReleasePayload,
  readAgentReleaseIdentity,
  _test: {
    DEB_ASSET_PATTERN,
    artifactVersionFromAssetName,
    artifactVersionFromTag,
    compareArtifactVersions,
    detectAssetArch,
    evaluateUpdateState,
    findAgentDebAsset,
    normalizeReleaseAssets,
    parseArtifactVersion,
    parseReleasePayload,
    parseVersionParts,
    readAgentReleaseIdentity,
    releaseIdentitySearchPaths,
  },
};
