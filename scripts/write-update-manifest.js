const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const { getReleaseInfo } = require(path.join(rootDir, "src", "shared", "releaseConfig"));
const repositoryUrl = "https://github.com/AnxLabs/AnxOS-Control-Center-Releases";
const release = getReleaseInfo();
const defaultBaseUrl = `${repositoryUrl}/releases/download/${release.tag}`;
const baseUrl = (process.env.ANXOS_UPDATE_BASE_URL || process.env.ANXHUB_UPDATE_BASE_URL || defaultBaseUrl).replace(/\/+$/, "");

function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest("hex");
}

const assetDefinitions = [
  {
    key: "windows-setup",
    platform: "windows",
    packageType: "nsis",
    role: "installer",
    requiredForRelease: true,
    name: `AnxOS-Control-Center-Setup-${release.artifactVersion}.exe`,
  },
  {
    key: "windows-setup-blockmap",
    platform: "windows",
    packageType: "blockmap",
    role: "updater-metadata",
    requiredForRelease: true,
    name: `AnxOS-Control-Center-Setup-${release.artifactVersion}.exe.blockmap`,
  },
  {
    key: "windows-portable",
    platform: "windows",
    packageType: "portable",
    role: "portable",
    requiredForRelease: true,
    name: `AnxOS-Control-Center-${release.artifactVersion}-portable.exe`,
  },
  {
    key: "windows-latest-yml",
    platform: "windows",
    packageType: "latest-yml",
    role: "updater-metadata",
    requiredForRelease: true,
    name: "latest.yml",
  },
  {
    key: "linux-deb",
    platform: "linux",
    packageType: "deb",
    role: "installer",
    requiredForRelease: true,
    name: `AnxOS-Control-Center-${release.artifactVersion}.deb`,
  },
  {
    key: "linux-appimage",
    platform: "linux",
    packageType: "appimage",
    role: "portable",
    requiredForRelease: true,
    name: `AnxOS-Control-Center-${release.artifactVersion}.AppImage`,
  },
  {
    key: "linux-latest-yml",
    platform: "linux",
    packageType: "latest-yml",
    role: "updater-metadata",
    requiredForRelease: true,
    name: "latest-linux.yml",
  },
];

const assets = assetDefinitions
  .map((definition) => {
    const filePath = path.join(distDir, definition.name);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    return {
      ...definition,
      architecture: "x64",
      size: fs.statSync(filePath).size,
      sha256: sha256File(filePath),
      downloadUrl: `${baseUrl}/${encodeURIComponent(definition.name)}`,
    };
  })
  .filter(Boolean);

const expectedReleaseArtifacts = assetDefinitions.map((definition) => ({
  key: definition.key,
  name: definition.name,
  platform: definition.platform,
  packageType: definition.packageType,
  role: definition.role,
  requiredForRelease: definition.requiredForRelease,
}));

const manifest = {
  version: release.version,
  build: release.build,
  channel: release.channel,
  releaseLabel: release.compactLabel,
  name: release.tag,
  releaseUrl: `${repositoryUrl}/releases/tag/${release.tag}`,
  publishedAt: new Date().toISOString(),
  websiteUrl: release.websiteUrl,
  releaseRepository: release.releaseRepository,
  updateSource: release.updateSource,
  supportedOperatingSystems: release.supportedOperatingSystems,
  minimumArchitecture: release.minimumArchitecture,
  expectedReleaseArtifacts,
  checksumManifest: {
    name: "SHA256SUMS",
    algorithm: "sha256",
    requiredForRelease: true,
  },
  localAgentRuntime: {
    bundled: true,
    resourceRoot: "local-agent-runtime",
    runtimeId: "anxos-local-agent",
    requiredPaths: [
      "local-agent-runtime/agent/package.json",
      "local-agent-runtime/agent/src/server.js",
      "local-agent-runtime/src/shared",
      "local-agent-runtime/src/services",
      "local-agent-runtime/node_modules/dotenv",
      "local-agent-runtime/config/agent.example.json",
      "local-agent-runtime/config/marketplace-templates.json",
      "local-agent-runtime/local-agent-runtime.json",
    ],
    excludedPatterns: [
      ".env",
      ".env.*",
      "*.map",
      ".git",
      "agent.log",
      "config/application-host.json",
      "config/device-identity.json",
      "config/nodes.json",
      "config/owner-accounts.json",
    ],
  },
  rollback: {
    preservesUserData: true,
    preservesInstances: true,
    preservesBackups: true,
    rollbackMetadataRequired: true,
  },
  assets,
};

fs.mkdirSync(distDir, { recursive: true });
const updateManifestName = "update-manifest.json";
fs.writeFileSync(path.join(distDir, updateManifestName), `${JSON.stringify(manifest, null, 2)}\n`);
const checksumEntries = [...assets.map((asset) => asset.name), updateManifestName]
  .map((name) => `${sha256File(path.join(distDir, name))}  ${name}`);
fs.writeFileSync(path.join(distDir, "SHA256SUMS"), `${checksumEntries.join("\n")}\n`);
console.log(`Wrote dist/update-manifest.json with ${assets.length} asset(s) and dist/SHA256SUMS.`);
