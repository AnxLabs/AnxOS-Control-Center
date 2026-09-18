#!/usr/bin/env node
// Pre-public-deploy consistency guard. Refuses to deploy unless the committed
// website metadata (website/config.js) advertises the exact build that is currently
// the public stable (non-prerelease) latest release in the official release
// repository. This prevents an RC from being auto-promoted into the stable website
// and prevents stale website metadata from being published while downloads resolve
// a different build.
const fs = require("fs");
const path = require("path");

const DEFAULT_STABLE_REPOSITORY = "AnxLabs/AnxOS-Control-Center-Releases";
const RELEASES_PER_PAGE = 100;

function buildFromTag(value) {
  const match = String(value || "").match(/build[-_.]?(\d+)/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function configBuildNumber(text) {
  const match = String(text || "").match(/buildNumber\s*:\s*"?(\d+)"?/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

// The build number alone is not enough to keep the website honest. Build 203
// shipped artifacts named `1.9-build203` and published them under the tag
// `v1.9-build203-rc2`, but the product version was bumped to 2.0 afterwards, so
// a config regenerated from release.json advertised `v2.0-build203` and
// `2.0-build203` asset names — six URLs that all 404 — while the numeric build
// check below stayed satisfied. These readers let the guard compare the tag and
// the asset names against the release that actually exists.
function readQuotedValueAfter(source, key, from = 0) {
  const at = source.indexOf(key, from);
  if (at === -1) return null;
  const rest = source.slice(at + key.length);
  const start = rest.indexOf('"');
  if (start === -1) return null;
  const end = rest.indexOf('"', start + 1);
  if (end === -1) return null;
  return { value: rest.slice(start + 1, end), next: at + key.length + end + 1 };
}

function configReleaseTag(text) {
  const found = readQuotedValueAfter(String(text || ""), "releaseTag:");
  return found ? found.value : null;
}

function configAssetFileNames(text) {
  const source = String(text || "");
  const names = [];
  let from = 0;
  for (;;) {
    const found = readQuotedValueAfter(source, "fileName:", from);
    if (!found) break;
    names.push(found.value);
    from = found.next;
  }
  return names;
}

function pickStableRelease(releases) {
  return (Array.isArray(releases) ? releases : [])
    .filter((release) => release && !release.draft && !release.prerelease)
    .sort((left, right) => new Date(right.published_at || right.created_at || 0) - new Date(left.published_at || left.created_at || 0))
    .find((release) => (release.assets || []).some((asset) => /\.(exe|appimage|deb)$/i.test(String(asset?.name || "")))) || null;
}

async function resolveStableRelease() {
  if (process.env.STABLE_LATEST_TAG) {
    return { tag_name: process.env.STABLE_LATEST_TAG };
  }
  const response = await fetch(`https://api.github.com/repos/${DEFAULT_STABLE_REPOSITORY}/releases?per_page=${RELEASES_PER_PAGE}`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "anxos-deploy-verifier" },
  });
  if (!response.ok) {
    throw new Error(`Could not resolve the stable latest release from ${DEFAULT_STABLE_REPOSITORY} (HTTP ${response.status}).`);
  }
  const stable = pickStableRelease(await response.json());
  if (!stable) {
    throw new Error(`No stable (non-prerelease) AnxOS release is currently published in ${DEFAULT_STABLE_REPOSITORY}.`);
  }
  return stable;
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const configText = fs.readFileSync(path.join(root, "website", "config.js"), "utf8");
  const configBuild = configBuildNumber(configText);
  if (!Number.isInteger(configBuild)) {
    throw new Error("website/config.js must declare a numeric buildNumber before public deployment.");
  }
  const stable = await resolveStableRelease();
  const stableBuild = buildFromTag(stable.tag_name);
  if (!Number.isInteger(stableBuild)) {
    throw new Error(`Could not derive a build number from stable release ${stable.tag_name}.`);
  }
  if (configBuild !== stableBuild) {
    throw new Error(`Website config advertises build ${configBuild} but the public stable release is build ${stableBuild} (${stable.tag_name}). Refusing to deploy inconsistent metadata.`);
  }
  // A matching build number does not mean the links work: the tag and the asset
  // file names must name the release and the artifacts that actually exist.
  const configTag = configReleaseTag(configText);
  if (!configTag) {
    throw new Error("website/config.js must declare releaseTag before public deployment.");
  }
  if (configTag !== stable.tag_name) {
    throw new Error(`Website config advertises tag ${configTag} but the public stable release is ${stable.tag_name}. Refusing to deploy a release link that does not exist.`);
  }
  const stableAssetNames = new Set((Array.isArray(stable.assets) ? stable.assets : []).map((asset) => String(asset?.name || "")));
  if (stableAssetNames.size) {
    const missing = configAssetFileNames(configText).filter((name) => !stableAssetNames.has(name));
    if (missing.length) {
      throw new Error(`Website config lists download asset(s) that ${stable.tag_name} does not publish: ${missing.join(", ")}. Refusing to deploy links that would 404.`);
    }
  } else {
    console.log("Stable release assets were not resolved (offline tag override); skipping the asset-name comparison.");
  }
  console.log(`Website config (build ${configBuild}, tag ${configTag}) matches the public stable release ${stable.tag_name}.`);
}

module.exports = { buildFromTag, configBuildNumber, configReleaseTag, configAssetFileNames, pickStableRelease, resolveStableRelease, DEFAULT_STABLE_REPOSITORY };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}