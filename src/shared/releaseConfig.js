const fs = require("fs");
const path = require("path");

const DEFAULT_RELEASE = {
  version: "1.7",
  build: 143,
  channel: "Private Alpha",
};

const RELEASE_REPOSITORY = {
  owner: "AnxLabs",
  repo: "AnxOS-Control-Center-Releases",
};

const RELEASE_REPOSITORY_URL = `https://github.com/${RELEASE_REPOSITORY.owner}/${RELEASE_REPOSITORY.repo}`;
const RELEASE_WEBSITE_URL = "https://anxoscontrolcenter.org";
const SUPPORTED_OPERATING_SYSTEMS = [
  "Windows 11 x64",
  "Debian-compatible Linux x64",
  "Ubuntu-compatible Linux x64",
];

const CHANNELS = {
  development: "Development",
  "private-alpha": "Private Alpha",
  privatealpha: "Private Alpha",
  "public-alpha": "Public Alpha",
  publicalpha: "Public Alpha",
  alpha: "Public Alpha",
  beta: "Beta",
  "release-candidate": "Release Candidate",
  rc: "Release Candidate",
  stable: "Stable",
};

function getReleaseConfigPath() {
  return path.join(__dirname, "..", "..", "release.json");
}

function normalizeChannel(value) {
  const raw = String(value || "").trim();
  if (!raw) return DEFAULT_RELEASE.channel;
  const key = raw.toLowerCase().replace(/[\s_]+/g, "-");
  return CHANNELS[key] || raw.replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizeReleaseVersion(value) {
  const version = String(value || "").trim().replace(/^v/i, "");
  if (!/^\d+\.\d+$/.test(version)) {
    throw new Error(`Release version must use major.minor format, received "${value}".`);
  }
  return version;
}

function normalizeBuild(value) {
  const build = Number.parseInt(value, 10);
  if (!Number.isInteger(build) || build < 0) {
    throw new Error(`Release build must be a non-negative integer, received "${value}".`);
  }
  return build;
}

function normalizeReleaseConfig(input = {}) {
  const release = { ...DEFAULT_RELEASE, ...(input && typeof input === "object" ? input : {}) };
  return {
    version: normalizeReleaseVersion(release.version),
    build: normalizeBuild(release.build),
    channel: normalizeChannel(release.channel),
  };
}

function readReleaseConfig() {
  try {
    return normalizeReleaseConfig(JSON.parse(fs.readFileSync(getReleaseConfigPath(), "utf8")));
  } catch (error) {
    if (error.code === "ENOENT") return { ...DEFAULT_RELEASE };
    throw error;
  }
}

function buildReleaseInfo(config = readReleaseConfig()) {
  const release = normalizeReleaseConfig(config);
  const tag = `v${release.version}-build${release.build}`;
  return {
    ...release,
    versionLabel: `Version ${release.version}`,
    buildLabel: `Build ${release.build}`,
    displayName: `Version ${release.version}\nBuild ${release.build}\n${release.channel}`,
    compactLabel: `Version ${release.version} Build ${release.build} ${release.channel}`,
    artifactVersion: `${release.version}-build${release.build}`,
    tag,
    websiteUrl: RELEASE_WEBSITE_URL,
    releaseRepository: { ...RELEASE_REPOSITORY },
    releaseRepositoryUrl: RELEASE_REPOSITORY_URL,
    releaseUrl: `${RELEASE_REPOSITORY_URL}/releases/tag/${tag}`,
    updateSource: `${RELEASE_REPOSITORY_URL}/releases`,
    supportedOperatingSystems: [...SUPPORTED_OPERATING_SYSTEMS],
    minimumArchitecture: "x64",
  };
}

function getReleaseInfo() {
  return buildReleaseInfo(readReleaseConfig());
}

module.exports = {
  CHANNELS,
  RELEASE_REPOSITORY,
  RELEASE_REPOSITORY_URL,
  RELEASE_WEBSITE_URL,
  SUPPORTED_OPERATING_SYSTEMS,
  buildReleaseInfo,
  getReleaseConfigPath,
  getReleaseInfo,
  normalizeBuild,
  normalizeChannel,
  normalizeReleaseConfig,
  normalizeReleaseVersion,
  readReleaseConfig,
};
