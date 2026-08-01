#!/usr/bin/env node
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  buildReleaseInfo,
  getReleaseConfigPath,
  normalizeReleaseConfig,
  readReleaseConfig,
} = require("../src/shared/releaseConfig");

const args = process.argv.slice(2);
const increment = !args.includes("--no-increment-build");
const builderArgs = args.filter((arg) => arg !== "--no-increment-build");
process.env.ANXOS_WINDOWS_BUILD_REQUESTED = builderArgs.includes("--win") || process.platform === "win32" ? "1" : "0";
const { getAzureSigningConfig } = require("./azure-signing-config");
const release = readReleaseConfig();
const nextRelease = increment ? { ...release, build: release.build + 1 } : release;

process.umask(0o022);

if (increment) {
  fs.writeFileSync(getReleaseConfigPath(), `${JSON.stringify(normalizeReleaseConfig(nextRelease), null, 2)}\n`);
}

const info = buildReleaseInfo(nextRelease);
console.log(`Packaging AnxOS Control Center ${info.compactLabel}`);

if (builderArgs.includes("--win") || process.platform === "win32") {
  const runtimeBuild = spawnSync(process.execPath, [path.join(__dirname, "prepare-windows-runtime-bundle.js")], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
  });
  if (runtimeBuild.error || runtimeBuild.status !== 0) {
    console.error(runtimeBuild.error?.message || "Windows bundled runtime preparation failed.");
    process.exit(runtimeBuild.status || 1);
  }
  const helperBuild = spawnSync(process.execPath, [path.join(__dirname, "build-windows-hardware-telemetry.js")], {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false,
  });
  if (helperBuild.error || helperBuild.status !== 0) {
    console.error(helperBuild.error?.message || "Windows hardware telemetry helper build failed.");
    process.exit(helperBuild.status || 1);
  }
}

function chmodSafe(filePath, mode) {
  try {
    fs.chmodSync(filePath, mode);
  } catch {}
}

function normalizePackageInputPath(filePath) {
  if (!fs.existsSync(filePath)) return;
  const stats = fs.lstatSync(filePath);
  if (stats.isSymbolicLink()) return;
  if (stats.isDirectory()) {
    chmodSafe(filePath, 0o755);
    for (const entry of fs.readdirSync(filePath)) {
      normalizePackageInputPath(path.join(filePath, entry));
    }
    return;
  }
  if (stats.isFile()) {
    chmodSafe(filePath, (stats.mode & 0o111) !== 0 ? 0o755 : 0o644);
  }
}

function normalizePackageInputs() {
  [
    path.join(process.cwd(), "assets"),
    path.join(process.cwd(), "src"),
    path.join(process.cwd(), "agent", "src"),
    path.join(process.cwd(), "agent", "package.json"),
    path.join(process.cwd(), "config", "agent.example.json"),
    path.join(process.cwd(), "config", "marketplace-templates.json"),
    path.join(process.cwd(), "config", "ssh-profiles.json"),
    path.join(process.cwd(), "website", "account-config.js"),
    path.join(process.cwd(), "website", "anxos-design-system.css"),
  ].forEach(normalizePackageInputPath);
}

function getGitCommit() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

fs.writeFileSync(path.join(process.cwd(), "release-build.json"), `${JSON.stringify({
  version: info.version,
  build: info.build,
  channel: info.channel,
  releaseLabel: info.compactLabel,
  releaseTag: info.tag,
  artifactVersion: info.artifactVersion,
  buildDate: new Date().toISOString(),
  gitCommit: process.env.ANXOS_BUILD_COMMIT || getGitCommit(),
  websiteUrl: info.websiteUrl,
  releaseRepository: info.releaseRepository,
  releaseRepositoryUrl: info.releaseRepositoryUrl,
  releaseUrl: info.releaseUrl,
  updateSource: info.updateSource,
  supportedOperatingSystems: info.supportedOperatingSystems,
  minimumArchitecture: info.minimumArchitecture,
}, null, 2)}\n`);

normalizePackageInputs();

const localBinDir = path.join(process.cwd(), "node_modules", ".bin");
const dynamicConfigPath = path.join(__dirname, "electron-builder-config.js");
if (!builderArgs.includes("--config")) builderArgs.push("--config", dynamicConfigPath);
try {
  console.log(`Windows Azure Trusted Signing: ${getAzureSigningConfig() ? "enabled" : "disabled (unsigned build)"}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const result = spawnSync(
  process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
  builderArgs,
  {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: process.platform === "win32",
    env: {
      ...process.env,
      // Ensure resolution works even when this script is invoked directly
      // (e.g. `node scripts/run-electron-builder.js ...`) rather than only
      // through an npm script, where npm would otherwise prepend this path
      // automatically.
      PATH: [localBinDir, process.env.PATH || ""].filter(Boolean).join(path.delimiter),
      ANXOS_RELEASE_ARTIFACT_VERSION: info.artifactVersion,
    },
  },
);

if (result.error) {
  console.error(`electron-builder could not be started: ${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  console.error(`electron-builder was terminated by signal ${result.signal}.`);
  process.exit(1);
}

// result.status is 0 on success. A non-zero exit code must propagate as a
// failure; it must never be silently coerced into a success exit code.
process.exit(typeof result.status === "number" ? result.status : 1);
