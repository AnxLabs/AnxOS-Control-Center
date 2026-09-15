#!/usr/bin/env node
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { buildReleaseInfo, readReleaseConfig } = require("../src/shared/releaseConfig");

const rootDir = path.resolve(__dirname, "..");
const release = buildReleaseInfo(readReleaseConfig());
const forbiddenTextPattern = /(GITHUB_TOKEN|GH_TOKEN|PERSONAL_ACCESS_TOKEN|ANXOS_RELEASE_REPO_TOKEN|CURSEFORGE_API_KEY|CF_API_KEY|sk-[A-Za-z0-9_-]+|127\.0\.0\.1|localhost:\d+|\/home\/anx\/|C:\\Users\\)/i;

function parseArgs(argv) {
  const options = {
    directory: path.join(rootDir, "release-artifacts"),
    fixture: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--directory") {
      options.directory = path.resolve(argv[index + 1] || "");
      index += 1;
    } else if (arg === "--fixture") {
      options.fixture = true;
    }
  }
  return options;
}

function expectedArtifacts() {
  return [
    `AnxOS-Control-Center-Setup-${release.artifactVersion}.exe`,
    `AnxOS-Control-Center-Setup-${release.artifactVersion}.exe.blockmap`,
    `AnxOS-Control-Center-${release.artifactVersion}-portable.exe`,
    "latest.yml",
    `AnxOS-Control-Center-${release.artifactVersion}.deb`,
    `AnxOS-Control-Center-${release.artifactVersion}.AppImage`,
    "latest-linux.yml",
    "update-manifest.json",
    "SHA256SUMS",
  ];
}

function sha256(filePath) {
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

function writeFixture(directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const name of expectedArtifacts().filter((asset) => asset !== "update-manifest.json" && asset !== "SHA256SUMS")) {
    fs.writeFileSync(path.join(directory, name), `fixture ${name}\n`);
  }
  const manifest = {
    version: release.version,
    build: release.build,
    channel: release.channel,
    expectedReleaseArtifacts: expectedArtifacts()
      .filter((asset) => asset !== "update-manifest.json" && asset !== "SHA256SUMS")
      .map((name) => ({ name, requiredForRelease: true })),
    checksumManifest: { name: "SHA256SUMS", algorithm: "sha256", requiredForRelease: true },
    localAgentRuntime: {
      bundled: true,
      resourceRoot: "local-agent-runtime",
      requiredPaths: ["local-agent-runtime/agent/src/server.js"],
      excludedPatterns: [".env", "*.map", ".git"],
    },
    rollback: {
      preservesUserData: true,
      preservesInstances: true,
      preservesBackups: true,
      rollbackMetadataRequired: true,
    },
    assets: [
      { key: "windows-setup", name: `AnxOS-Control-Center-Setup-${release.artifactVersion}.exe`, platform: "windows", architecture: "x64", packageType: "nsis" },
      { key: "windows-setup-blockmap", name: `AnxOS-Control-Center-Setup-${release.artifactVersion}.exe.blockmap`, platform: "windows", architecture: "x64", packageType: "blockmap" },
      { key: "windows-latest-yml", name: "latest.yml", platform: "windows", architecture: "x64", packageType: "latest-yml" },
      { key: "windows-portable", name: `AnxOS-Control-Center-${release.artifactVersion}-portable.exe`, platform: "windows", architecture: "x64", packageType: "portable" },
      { key: "linux-deb", name: `AnxOS-Control-Center-${release.artifactVersion}.deb`, platform: "linux", architecture: "x64", packageType: "deb" },
      { key: "linux-appimage", name: `AnxOS-Control-Center-${release.artifactVersion}.AppImage`, platform: "linux", architecture: "x64", packageType: "appimage" },
      { key: "linux-latest-yml", name: "latest-linux.yml", platform: "linux", architecture: "x64", packageType: "latest-yml" },
    ].map((asset) => ({ ...asset, sha256: sha256(path.join(directory, asset.name)) })),
  };
  fs.writeFileSync(path.join(directory, "update-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const checksums = expectedArtifacts()
    .filter((asset) => asset !== "SHA256SUMS")
    .map((name) => `${sha256(path.join(directory, name))}  ${name}`)
    .join("\n");
  fs.writeFileSync(path.join(directory, "SHA256SUMS"), `${checksums}\n`);
}

function readChecksumManifest(directory) {
  const checksumsPath = path.join(directory, "SHA256SUMS");
  assert(fs.existsSync(checksumsPath), "Release artifacts must include SHA256SUMS.");
  const checksums = new Map();
  for (const line of fs.readFileSync(checksumsPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+)$/i);
    if (match) checksums.set(match[2].trim(), match[1].toLowerCase());
  }
  return checksums;
}

function assertSafeTextArtifact(filePath) {
  if (!/\.(json|ya?ml|txt|sha256|SHA256SUMS)$/i.test(filePath) && path.basename(filePath) !== "SHA256SUMS") return;
  const source = fs.readFileSync(filePath, "utf8");
  assert(!forbiddenTextPattern.test(source), `${path.basename(filePath)} must not expose secrets, localhost URLs, or private paths.`);
}

function validate(directory) {
  assert(fs.existsSync(directory), `Release artifact directory does not exist: ${directory}`);
  for (const artifact of expectedArtifacts()) {
    const artifactPath = path.join(directory, artifact);
    assert(fs.existsSync(artifactPath), `Missing release artifact: ${artifact}`);
    assert(fs.statSync(artifactPath).size > 0, `Release artifact is empty: ${artifact}`);
    assertSafeTextArtifact(artifactPath);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "update-manifest.json"), "utf8"));
  assert.strictEqual(manifest.version, release.version, "Update manifest version must match release.json.");
  assert.strictEqual(Number(manifest.build), release.build, "Update manifest build must match release.json.");
  assert.strictEqual(manifest.channel, release.channel, "Update manifest channel must match release.json.");
  assert(manifest.checksumManifest?.name === "SHA256SUMS", "Update manifest must declare the checksum manifest.");
  assert(manifest.localAgentRuntime?.bundled === true, "Update manifest must declare bundled Local Agent runtime support.");
  assert(Array.isArray(manifest.localAgentRuntime?.requiredPaths) && manifest.localAgentRuntime.requiredPaths.some((entry) => entry.includes("agent/src/server.js")), "Update manifest must list Local Agent runtime files.");
  assert(manifest.rollback?.preservesInstances === true && manifest.rollback?.preservesBackups === true, "Update manifest must document rollback/user-data preservation.");

  const requiredManifestArtifacts = new Set((manifest.expectedReleaseArtifacts || []).filter((asset) => asset.requiredForRelease).map((asset) => asset.name));
  for (const artifact of expectedArtifacts().filter((asset) => asset !== "SHA256SUMS" && asset !== "update-manifest.json")) {
    assert(requiredManifestArtifacts.has(artifact), `Update manifest must mark ${artifact} as a required release artifact.`);
  }

  const requiredPackageTypes = new Set((manifest.assets || []).map((asset) => `${asset.platform}:${asset.packageType}`));
  ["windows:nsis", "windows:portable", "windows:latest-yml", "linux:deb", "linux:appimage", "linux:latest-yml"].forEach((key) => {
    assert(requiredPackageTypes.has(key), `Update manifest assets must include ${key}.`);
  });

  const checksums = readChecksumManifest(directory);
  for (const asset of manifest.assets || []) {
    assert.strictEqual(asset.architecture, "x64", `${asset.name} must declare its supported architecture.`);
    assert.strictEqual(asset.sha256, checksums.get(asset.name), `${asset.name} manifest checksum must match SHA256SUMS.`);
  }
  for (const artifact of expectedArtifacts().filter((asset) => asset !== "SHA256SUMS")) {
    assert(checksums.has(artifact), `SHA256SUMS must include ${artifact}.`);
    assert.strictEqual(checksums.get(artifact), sha256(path.join(directory, artifact)), `SHA256SUMS digest mismatch for ${artifact}.`);
  }
}

const options = parseArgs(process.argv.slice(2));
let directory = options.directory;
if (options.fixture) {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-release-artifacts-"));
  writeFixture(directory);
}
validate(directory);
console.log(`Release artifact validation passed for ${release.tag}.`);
