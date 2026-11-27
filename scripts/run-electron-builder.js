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

// The packaged Agent runtime is published from a staged dependency closure
// (extraResources -> resources/agent-runtime-node-modules). Staging runs for
// every platform target and fails the build when a required package is missing.
const agentRuntimeDeps = spawnSync(process.execPath, [path.join(__dirname, "prepare-agent-runtime-dependencies.js")], {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: false,
});
if (agentRuntimeDeps.error || agentRuntimeDeps.status !== 0) {
  console.error(agentRuntimeDeps.error?.message || "Agent runtime dependency staging failed.");
  process.exit(agentRuntimeDeps.status || 1);
}

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
let azureSigning = null;
try {
  azureSigning = getAzureSigningConfig();
  console.log(`Windows Azure Trusted Signing: ${azureSigning ? "enabled" : "disabled; unsigned Windows builds fail release signature verification"}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function prepareWindowsInstallerToolsets() {
  if (process.env.ANXOS_WINDOWS_BUILD_REQUESTED !== "1") return {};
  if (!azureSigning) {
    console.log("NSIS plugins: unsigned (development build). Windows Smart App Control blocks this installer; only a signed release build installs on protected PCs.");
    return {};
  }
  // Phase 9: the installer's NSIS plugin DLLs must be signed too, or Smart
  // App Control refuses to load them and the signed installer aborts.
  const { prepareSignedNsisToolsets } = require("./sign-nsis-toolsets");
  const prepared = await prepareSignedNsisToolsets({
    azure: azureSigning,
    stageRoot: path.join(process.cwd(), "dist", ".signed-nsis"),
    buildConfig: JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")).build || {},
  });
  return prepared.env;
}

// Build 216-D: AnxHost Setup (windows/setup) wraps the NSIS installer. Built
// for Windows builds that include the NSIS target; ANXHOST_SETUP_SKIP=1 leaves
// it out on a development PC without Rust (release validation then refuses
// the result, because the published Setup must be AnxHost Setup).
const OTHER_TARGETS = ["portable", "dir", "zip", "7z", "msi", "appx", "squirrel"];
const setupWanted = process.platform === "win32"
  && process.env.ANXOS_WINDOWS_BUILD_REQUESTED === "1"
  && process.env.ANXHOST_SETUP_SKIP !== "1"
  && !builderArgs.includes("--prepackaged")
  && (builderArgs.includes("nsis") || !builderArgs.some((arg) => OTHER_TARGETS.includes(arg)));

function buildSetupMaintenanceCopy() {
  if (!setupWanted) return;
  const { buildMaintenance } = require("./build-anxhost-setup");
  process.env.ANXHOST_SETUP_MAINTENANCE_EXE = buildMaintenance();
}

try {
  buildSetupMaintenanceCopy();
} catch (error) {
  console.error(`Building AnxHost Setup failed: ${error.message}`);
  process.exit(1);
}

// Issue #54: prove the finished packages contain what the app requires before
// anything is uploaded (scripts/verify-packaged-app.js). On Linux: the final
// .deb and AppImage. On Windows: the unpacked app the installer was made from.
function verifyBuiltPackages(artifactVersion) {
  const { verifyTarget } = require("./verify-packaged-app");
  const dist = path.join(process.cwd(), "dist");
  const targets = [];
  if (process.platform === "linux") {
    for (const name of fs.existsSync(dist) ? fs.readdirSync(dist) : []) {
      if (name.includes(artifactVersion) && /\.(deb|AppImage)$/.test(name) && !name.startsWith("AnxOS-Agent-")) targets.push(path.join(dist, name));
    }
  } else if (process.platform === "win32" && fs.existsSync(path.join(dist, "win-unpacked"))) {
    targets.push(path.join(dist, "win-unpacked"));
  }
  let ok = true;
  for (const target of targets) {
    try {
      const result = verifyTarget(target);
      for (const line of result.lines) console.log(line);
      ok = ok && result.ok;
    } catch (error) {
      console.error(`FAIL ${path.basename(target)}: ${error.message}`);
      ok = false;
    }
  }
  if (!ok) console.error("The packaged app is incomplete (scripts/verify-packaged-app.js); nothing was published.");
  return ok;
}

prepareWindowsInstallerToolsets().then(async (toolsetEnv) => {
  const result = spawnSync(
    process.platform === "win32" ? "electron-builder.cmd" : "electron-builder",
    builderArgs,
    {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        ...toolsetEnv,
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
  if (result.status !== 0) process.exit(typeof result.status === "number" ? result.status : 1);
  if (setupWanted) {
    try {
      process.env.ANXOS_RELEASE_ARTIFACT_VERSION = info.artifactVersion;
      await require("./build-anxhost-setup").packageSetup();
    } catch (error) {
      console.error(`Packaging AnxHost Setup failed: ${error.message}`);
      process.exit(1);
    }
  }
  if (!verifyBuiltPackages(info.artifactVersion)) process.exit(1);
  process.exit(0);
}, (error) => {
  console.error(`Preparing signed NSIS toolsets failed: ${error.message}`);
  process.exit(1);
});
