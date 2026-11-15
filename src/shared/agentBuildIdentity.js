"use strict";

// The Agent's release build ("2.0-build211"), used wherever two Agent
// runtimes are compared (the remote push downgrade guard and the Local Agent
// update state). agent/package.json's version is a placeholder that never
// changes ("0.1.0"), so it can never tell two builds apart.
//
// A running Agent resolves its build once, at first use, from (in order):
//   1. ANXOS_AGENT_ARTIFACT_VERSION, set by the Desktop when it starts its
//      bundled Local Agent (the packaged runtime folder has no release file);
//   2. <runtime root>/agent-build.json, stamped by a Desktop push update;
//   3. <runtime root>/agent-release.json, stamped by the .deb build;
//   4. <runtime root>/release.json, in a source checkout.
// The first readable one wins. Nothing found means "unknown" (an Agent built
// before build reporting existed, or an unrecognised layout), never a guess.
// It is resolved once because files on disk can change under a running
// process (a Desktop upgrade, a git pull) without changing the code it runs.

const fs = require("fs");
const path = require("path");

const AGENT_BUILD_ENV = "ANXOS_AGENT_ARTIFACT_VERSION";
const AGENT_BUILD_FILENAME = "agent-build.json";
const AGENT_RELEASE_FILENAME = "agent-release.json";
const RELEASE_FILENAME = "release.json";

const ARTIFACT_PATTERN = /^v?(\d+)\.(\d+)-build(\d+)$/i;

// Accepts only a full artifact version ("2.0-build211"), so a placeholder
// semver or a bare number is never mistaken for a release build.
function parseAgentArtifactVersion(value) {
  const match = String(value ?? "").trim().match(ARTIFACT_PATTERN);
  if (!match) return null;
  const parts = [Number(match[1]), Number(match[2])];
  const build = Number(match[3]);
  if (!parts.every(Number.isSafeInteger) || !Number.isSafeInteger(build)) return null;
  return { parts, build, artifactVersion: `${parts[0]}.${parts[1]}-build${build}` };
}

function normalizeAgentArtifactVersion(value) {
  return parseAgentArtifactVersion(value)?.artifactVersion || null;
}

// -1 / 0 / 1, or null when either side is unknown or not an artifact version.
function compareAgentArtifactVersions(left, right) {
  const a = parseAgentArtifactVersion(left);
  const b = parseAgentArtifactVersion(right);
  if (!a || !b) return null;
  for (let index = 0; index < a.parts.length; index += 1) {
    if (a.parts[index] !== b.parts[index]) return a.parts[index] > b.parts[index] ? 1 : -1;
  }
  if (a.build === b.build) return 0;
  return a.build > b.build ? 1 : -1;
}

function readJsonFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// release.json holds { version: "2.0", build: 211 }; the stamped identity
// files hold { artifactVersion: "2.0-build211" }.
function artifactVersionFromReleaseConfig(config) {
  if (!config) return null;
  const version = String(config.version ?? "").trim().replace(/^v/i, "");
  const build = Number.parseInt(config.build, 10);
  if (!/^\d+\.\d+$/.test(version) || !Number.isInteger(build) || build < 0 || String(build) !== String(config.build).trim()) return null;
  return normalizeAgentArtifactVersion(`${version}-build${build}`);
}

function readReleaseConfigArtifactVersion(filePath) {
  return artifactVersionFromReleaseConfig(readJsonFile(filePath));
}

function resolveAgentArtifactVersion({ runtimeRoot = null, env = process.env } = {}) {
  const fromEnv = normalizeAgentArtifactVersion(env?.[AGENT_BUILD_ENV]);
  if (fromEnv) return { artifactVersion: fromEnv, source: "environment" };
  if (!runtimeRoot) return null;
  for (const filename of [AGENT_BUILD_FILENAME, AGENT_RELEASE_FILENAME]) {
    const artifactVersion = normalizeAgentArtifactVersion(readJsonFile(path.join(runtimeRoot, filename))?.artifactVersion);
    if (artifactVersion) return { artifactVersion, source: filename };
  }
  const fromRelease = readReleaseConfigArtifactVersion(path.join(runtimeRoot, RELEASE_FILENAME));
  return fromRelease ? { artifactVersion: fromRelease, source: RELEASE_FILENAME } : null;
}

// The build of the Agent runtime bundled with this Desktop: it ships in the
// same installer, so it is the Desktop's own release (release.json next to
// src/). Unlike getReleaseInfo(), a missing or malformed file is "unknown",
// never the hard-coded default release.
function readDesktopBundledAgentArtifactVersion(releasePath = path.join(__dirname, "..", "..", RELEASE_FILENAME)) {
  return readReleaseConfigArtifactVersion(releasePath);
}

function buildAgentBuildStamp(artifactVersion, now = new Date()) {
  const normalized = normalizeAgentArtifactVersion(artifactVersion);
  if (!normalized) return null;
  return `${JSON.stringify({ schemaVersion: 1, artifactVersion: normalized, stampedBy: "desktop-push", stampedAt: now.toISOString() }, null, 2)}\n`;
}

module.exports = {
  AGENT_BUILD_ENV,
  AGENT_BUILD_FILENAME,
  artifactVersionFromReleaseConfig,
  buildAgentBuildStamp,
  compareAgentArtifactVersions,
  normalizeAgentArtifactVersion,
  parseAgentArtifactVersion,
  readDesktopBundledAgentArtifactVersion,
  resolveAgentArtifactVersion,
};
