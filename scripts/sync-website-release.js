const fs = require("fs");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const { OFFICIAL_SITE_ORIGIN } = require(path.join(rootDir, "src", "shared", "officialSite"));
const { getReleaseInfo } = require(path.join(rootDir, "src", "shared", "releaseConfig"));
const websiteConfigPath = path.join(rootDir, "website", "config.js");
const releaseNotesPath = path.join(rootDir, "website", "release-notes.json");
const releaseRepository = {
  owner: "AnxLabs",
  repo: "AnxOS-Control-Center-Releases",
};
const repositoryUrl = `https://github.com/${releaseRepository.owner}/${releaseRepository.repo}`;
const release = getReleaseInfo();
const releaseAssetBaseUrl = `${repositoryUrl}/releases/download/${release.tag}`;

const releaseAssets = [
  {
    fileName: `AnxOS-Control-Center-Setup-${release.artifactVersion}.exe`,
    url: `${releaseAssetBaseUrl}/AnxOS-Control-Center-Setup-${release.artifactVersion}.exe`,
  },
  {
    fileName: `AnxOS-Control-Center-${release.artifactVersion}-portable.exe`,
    url: `${releaseAssetBaseUrl}/AnxOS-Control-Center-${release.artifactVersion}-portable.exe`,
  },
  {
    fileName: `AnxOS-Control-Center-${release.artifactVersion}.AppImage`,
    url: `${releaseAssetBaseUrl}/AnxOS-Control-Center-${release.artifactVersion}.AppImage`,
  },
  {
    fileName: `AnxOS-Control-Center-${release.artifactVersion}.deb`,
    url: `${releaseAssetBaseUrl}/AnxOS-Control-Center-${release.artifactVersion}.deb`,
  },
];

function formatReleaseAssetsForConfig(assets) {
  return `[\n${assets.map((asset) => `      {\n          fileName: "${asset.fileName}",\n          url: "${asset.url}"\n      }`).join(",\n")}\n  ]`;
}
function formatReleaseDate(date = new Date()) {
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Edmonton",
  });
}

function readReleaseNotes() {
  if (!fs.existsSync(releaseNotesPath)) {
    return [];
  }

  try {
    const notes = JSON.parse(fs.readFileSync(releaseNotesPath, "utf8"));
    return Array.isArray(notes) ? notes : [];
  } catch (error) {
    console.warn(`Could not read website/release-notes.json: ${error.message}`);
    return [];
  }
}

function getReleaseNotes() {
  const releaseDate = formatReleaseDate();
  const today = new Date().toISOString().slice(0, 10);
  const currentTag = release.tag;
  const notes = readReleaseNotes().map((entry) => {
    const tag = entry.tag || (entry.build ? `v${entry.version}-build${entry.build}` : `v${entry.version}`);
    const staleSemverUrl = /\/releases\/tag\/v\d+\.\d+\.\d+$/i.test(String(entry.url || ""));
    const sourceRepositoryUrl = /^https:\/\/github\.com\/(?:bungopam-byte|AnxLabs)\/AnxOS-Control-Center\/releases\/tag\//i.test(String(entry.url || ""));
    return {
      ...entry,
      tag,
      url: !entry.url || staleSemverUrl || sourceRepositoryUrl ? `${repositoryUrl}/releases/tag/${tag}` : entry.url,
    };
  });

  if (!notes.some((entry) => (entry.version === release.version && Number(entry.build) === release.build) || entry.tag === currentTag)) {
    notes.unshift({
      version: release.version,
      build: release.build,
      channel: release.channel,
      tag: currentTag,
      date: releaseDate,
      datetime: today,
      title: `AnxOS ${release.versionLabel}`,
      summary: "Latest AnxOS-Control-Center release.",
      changes: [
        "Updated application build, website metadata, and downloadable release assets.",
      ],
      url: `${repositoryUrl}/releases/tag/${currentTag}`,
    });
  }

  return notes;
}

const releaseNotes = getReleaseNotes();
fs.writeFileSync(releaseNotesPath, `${JSON.stringify(releaseNotes, null, 2)}\n`);

const config = `window.ANXOS_DOWNLOAD_CONFIG = {
  brandName: "AnxOS",
  appName: "AnxOS-Control-Center",
  subtitle: "A desktop control center for Minecraft servers, modpacks, remote nodes, and automation.",
  siteUrl: "${OFFICIAL_SITE_ORIGIN}",
  logoPath: "/assets/anxos-logo.png",
  latestVersion: "${release.version}",
  build: "${release.build}",
  buildNumber: "${release.build}",
  channel: "${release.channel}",
  releaseLabel: "${release.compactLabel}",
  releaseDate: "${formatReleaseDate()}",
  releaseTag: "${release.tag}",
  releaseRepository: {
    owner: "${releaseRepository.owner}",
    repo: "${releaseRepository.repo}",
  },
  repositoryUrl: "${repositoryUrl}",
  releaseUrl: "${repositoryUrl}/releases/tag/${release.tag}",
  githubReleasesApiUrl: "https://api.github.com/repos/${releaseRepository.owner}/${releaseRepository.repo}/releases?per_page=20",
  stableDownloadEndpoints: {
    windows: "/api/download/latest/windows",
    windowsPortable: "/api/download/latest/windows-portable",
    linuxAppImage: "/api/download/latest/linux-appimage",
    linuxDeb: "/api/download/latest/linux-deb",
  },
  releaseAssets: ${formatReleaseAssetsForConfig(releaseAssets)},
  releaseNotes: ${JSON.stringify(releaseNotes, null, 4).replace(/^/gm, "  ").trimStart()},
};
`;

fs.writeFileSync(websiteConfigPath, config);
console.log(`Updated website/config.js for ${release.compactLabel}.`);
