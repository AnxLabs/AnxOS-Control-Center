#!/usr/bin/env node
// Builds the official AnxOS Agent Debian package.
//
// The package is assembled from the same file selection the desktop
// extraResources use (agent/**, src/shared/**, src/services/**, the staged
// runtime dependency closure, and the runtime config files) plus the Debian
// control metadata, the systemd unit and the /usr/bin wrapper. An official Node
// 22 LTS Linux binary is bundled so a fresh Debian/Ubuntu host needs neither
// git, npm, nor a source checkout.
//
// dpkg-deb is only available on Linux; on other platforms the script assembles
// the exact tree dpkg-deb would consume and prints STAGED-ONLY with the two
// commands that finish the job. Nothing here prints secret material.
"use strict";

const crypto = require("crypto");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const { buildReleaseInfo, readReleaseConfig } = require("../src/shared/releaseConfig");

const rootDir = path.resolve(__dirname, "..");
const packagingDir = path.join(rootDir, "packaging", "agent-deb");
const stagedDependenciesDir = path.join(rootDir, "resources", "agent-runtime-node-modules");
const defaultDistDir = path.join(rootDir, "dist");
const STAGE_MARKER = ".anxos-agent-deb-stage";
const STAGE_MARKER_CONTENT = "AnxOS Agent deb staging marker; kept outside the package tree.\n";
const DEFAULT_NODE_VERSION = "22.14.0";

const SUPPORTED_ARCHES = new Map([
  ["amd64", { node: "x64", elfMachine: 0x3e }],
  ["arm64", { node: "arm64", elfMachine: 0xb7 }],
]);

const RUNTIME_ROOT_RELATIVE = path.join("usr", "lib", "anxos-agent");
const WRAPPER_RELATIVE = path.join("usr", "bin", "anxos-agent");
const AGENT_RELEASE_FILENAME = "agent-release.json";
const CONTROL_CONFIG_FILES = ["agent.example.json", "local-agent-runtime.json", "marketplace-templates.json"];

const WRAPPER_CONTENT = [
  "#!/bin/sh",
  'exec /usr/lib/anxos-agent/node/bin/node /usr/lib/anxos-agent/agent/src/cli.js "$@"',
  "",
].join("\n");

const PLACEHOLDER_NODE_CONTENT = [
  "#!/bin/sh",
  "# ANXOS-AGENT-PLACEHOLDER-NODE: staged with --stage-only, this runtime is not real.",
  'echo "AnxOS Agent stage placeholder Node runtime; rebuild with --download-node or --node-dir." >&2',
  "exit 1",
  "",
].join("\n");

// Directories that must never be staged, mirroring the runtime manifest's
// excluded patterns plus local tooling state that is never source.
const TOOLING_SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".github",
  ".mimosa",
  ".v2c",
  "test",
  "tests",
  "__tests__",
  "coverage",
]);

const FORBIDDEN_STAGED_FILES = new Set([
  ".env",
  "device-identity.json",
  "enrollment.json",
  "nodes.json",
  "agent.json",
  "application-host.json",
  "owner-accounts.json",
  "marketplace.json",
  "long-operations.json",
  "ssh-known-hosts.json",
  "windows-runtime-bundle.json",
]);

function chmodSafe(filePath, mode) {
  try {
    fs.chmodSync(filePath, mode);
  } catch {}
}

function isForbiddenStagedFile(name) {
  return FORBIDDEN_STAGED_FILES.has(name)
    || name.startsWith(".env.")
    || name.endsWith(".map")
    || name.endsWith(".log");
}

function isRuntimeSourceFile(name) {
  return name.endsWith(".js") && !name.endsWith(".map");
}

function copyTree(sourceDir, targetDir, options = {}, depth = 0) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Missing packaging input directory: ${path.relative(rootDir, sourceDir)}`);
  }
  fs.mkdirSync(targetDir, { recursive: true });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (TOOLING_SKIP_DIRECTORIES.has(entry.name)) continue;
      if (depth === 0 && options.rootSkipDirectories && options.rootSkipDirectories.has(entry.name)) continue;
      if (options.skipDirectories && options.skipDirectories.has(entry.name)) continue;
      copyTree(path.join(sourceDir, entry.name), path.join(targetDir, entry.name), options, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    if (isForbiddenStagedFile(entry.name)) continue;
    if (options.skipFile && options.skipFile(entry.name)) continue;
    fs.copyFileSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
  }
}

function copyFileInto(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Missing packaging input file: ${path.relative(rootDir, sourcePath)}`);
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function sumFileBytes(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += sumFileBytes(entryPath);
    else if (entry.isFile() && !entry.isSymbolicLink()) total += fs.statSync(entryPath).size;
  }
  return total;
}

function countFiles(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) total += countFiles(path.join(directory, entry.name));
    else if (entry.isFile()) total += 1;
  }
  return total;
}

// Installed-Size is measured in KiB over the payload only; DEBIAN/ holds
// control metadata and is not installed. The estimate matches dpkg's policy
// ("disk space in KiB").
function measureInstalledKiB(stageDir) {
  let bytes = 0;
  for (const entry of fs.readdirSync(stageDir, { withFileTypes: true })) {
    if (entry.name === "DEBIAN") continue;
    const entryPath = path.join(stageDir, entry.name);
    if (entry.isDirectory()) bytes += sumFileBytes(entryPath);
    else if (entry.isFile() && !entry.isSymbolicLink()) bytes += fs.statSync(entryPath).size;
  }
  return Math.ceil(bytes / 1024);
}

function normalizeStageModes(stageDir) {
  const stack = [stageDir];
  while (stack.length) {
    const directory = stack.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        chmodSafe(entryPath, 0o755);
        stack.push(entryPath);
      } else if (entry.isFile()) {
        chmodSafe(entryPath, 0o644);
      }
    }
  }
  chmodSafe(stageDir, 0o755);
  for (const relative of ["DEBIAN/postinst", "DEBIAN/prerm", "DEBIAN/postrm", "usr/bin/anxos-agent", "usr/lib/anxos-agent/node/bin/node"]) {
    const target = path.join(stageDir, ...relative.split("/"));
    if (fs.existsSync(target)) chmodSafe(target, 0o755);
  }
}

function parseArgs(argv) {
  const options = {
    arch: "amd64",
    downloadNode: false,
    nodeDir: null,
    stageOnly: false,
    stageDir: null,
    outputDir: defaultDistDir,
    refreshDeps: true,
    keepStage: false,
    nodeVersion: process.env.ANXOS_AGENT_NODE_VERSION || DEFAULT_NODE_VERSION,
    help: false,
  };
  const takesValue = new Set(["arch", "node-dir", "stage-dir", "output-dir", "node-version"]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unsupported argument: ${token}`);
    const equals = token.indexOf("=");
    const name = equals === -1 ? token.slice(2) : token.slice(2, equals);
    let value = equals === -1 ? null : token.slice(equals + 1);
    if (takesValue.has(name)) {
      if (value === null) {
        index += 1;
        value = argv[index];
        if (value === undefined) throw new Error(`Missing value for --${name}`);
      }
    } else if (value !== null) {
      throw new Error(`--${name} does not take a value`);
    }
    switch (name) {
      case "arch": options.arch = value; break;
      case "download-node": options.downloadNode = true; break;
      case "node-dir": options.nodeDir = path.resolve(value); break;
      case "node-version": options.nodeVersion = value; break;
      case "stage-only": options.stageOnly = true; break;
      case "stage-dir": options.stageDir = path.resolve(value); break;
      case "output-dir": options.outputDir = path.resolve(value); break;
      case "no-refresh-deps": options.refreshDeps = false; break;
      case "keep-stage": options.keepStage = true; break;
      case "help": options.help = true; break;
      default: throw new Error(`Unsupported argument: --${name}`);
    }
  }

  if (!SUPPORTED_ARCHES.has(options.arch)) {
    throw new Error(`Unsupported --arch value "${options.arch}". Supported architectures: amd64, arm64.`);
  }
  if (!/^\d+\.\d+\.\d+$/.test(options.nodeVersion)) {
    throw new Error(`Invalid --node-version "${options.nodeVersion}"; expected a full version such as ${DEFAULT_NODE_VERSION}.`);
  }
  if (options.downloadNode && options.nodeDir) {
    throw new Error("--download-node and --node-dir are mutually exclusive.");
  }
  if (options.stageOnly && (options.downloadNode || options.nodeDir)) {
    throw new Error("--stage-only assembles a non-runnable tree and cannot be combined with --download-node or --node-dir.");
  }
  if (!options.stageOnly && !options.downloadNode && !options.nodeDir) {
    throw new Error("No Node runtime supplied. Pass --download-node or --node-dir to build an installable package, or --stage-only to assemble a non-runnable tree for closure verification.");
  }
  if (options.stageOnly) options.keepStage = true;
  return options;
}

function printUsage() {
  console.log([
    "Usage: node scripts/build-agent-deb.js [options]",
    "",
    "  --arch amd64|arm64   Target architecture (default amd64).",
    "  --download-node      Fetch and SHA-256-verify official Node linux-<arch> from nodejs.org.",
    "  --node-dir <path>    Use an extracted Node tree containing bin/node.",
    "  --node-version <v>   Node version to download (default 22.14.0).",
    "  --stage-only         Assemble without Node; never invoke dpkg-deb.",
    "  --stage-dir <path>   Stage directory (default dist/agent-deb/stage-<arch>).",
    "  --output-dir <path>  Artifact directory (default dist).",
    "  --no-refresh-deps    Reuse resources/agent-runtime-node-modules as staged.",
    "  --keep-stage         Keep the staged tree after a successful build.",
    "  --help               Show this help.",
  ].join("\n"));
}

function ensureDependencies(options) {
  if (!options.refreshDeps) {
    const present = fs.existsSync(stagedDependenciesDir) && fs.readdirSync(stagedDependenciesDir).length > 0;
    if (!present) {
      throw new Error(`Agent runtime dependencies are not staged at ${path.relative(rootDir, stagedDependenciesDir)}. Run 'npm run agent-runtime:prepare' or omit --no-refresh-deps.`);
    }
    console.log(`Using pre-staged Agent runtime dependencies (${path.relative(rootDir, stagedDependenciesDir)}).`);
    return;
  }
  const result = spawnSync(process.execPath, [path.join(__dirname, "prepare-agent-runtime-dependencies.js")], {
    cwd: rootDir,
    stdio: "inherit",
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message || `Agent runtime dependency staging failed (exit ${result.status}).`);
  }
}

// The stage marker lives next to the stage directory, never inside it. Anything
// inside the tree is packaged by dpkg-deb (DEBIAN/ into the control archive,
// everything else into the data archive), so an in-tree marker would ship in
// the .deb on every build path that does not delete it first.
function stageMarkerPath(stageDir) {
  return `${stageDir}${STAGE_MARKER}`;
}

function prepareStageDirectory(stageDir) {
  const markerPath = stageMarkerPath(stageDir);
  const legacyMarkerPath = path.join(stageDir, "DEBIAN", STAGE_MARKER);
  if (fs.existsSync(stageDir)) {
    const entries = fs.readdirSync(stageDir);
    if (entries.length > 0 && !fs.existsSync(markerPath) && !fs.existsSync(legacyMarkerPath)) {
      throw new Error(`Refusing to clean ${stageDir}: it is not an AnxOS Agent stage (missing ${markerPath} or DEBIAN/${STAGE_MARKER}). Pick another --stage-dir or remove it manually.`);
    }
    fs.rmSync(stageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  fs.mkdirSync(path.join(stageDir, "DEBIAN"), { recursive: true });
  fs.writeFileSync(markerPath, STAGE_MARKER_CONTENT);
}

function assertLinuxNodeBinary(buffer, arch) {
  const expected = SUPPORTED_ARCHES.get(arch);
  if (buffer.length < 1024 * 1024) {
    throw new Error("Node runtime is unexpectedly small; expected an official Node Linux binary.");
  }
  if (buffer.subarray(0, 4).toString("binary") !== "\u007fELF") {
    throw new Error("Node runtime is not a Linux ELF binary; Windows/macOS executables cannot be packaged into a .deb.");
  }
  const machine = buffer.readUInt16LE(18);
  if (machine !== expected.elfMachine) {
    throw new Error(`Node runtime ELF architecture 0x${machine.toString(16)} does not match --arch ${arch}.`);
  }
}

function readNodeFromDirectory(nodeDir, arch) {
  const candidates = [path.join(nodeDir, "bin", "node"), path.join(nodeDir, "node")];
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!found) throw new Error(`--node-dir ${nodeDir} does not contain bin/node.`);
  const buffer = fs.readFileSync(found);
  assertLinuxNodeBinary(buffer, arch);
  return buffer;
}

function readCString(buffer, offset, length) {
  let end = offset;
  while (end < offset + length && buffer[end] !== 0) end += 1;
  return buffer.subarray(offset, end).toString("utf8");
}

// Minimal tar reader used for the official Node tarball: the archive is first
// gunzipped, then walked header-by-header (PAX/GNU metadata entries are
// skipped) until the wanted member is found. Only that member is materialized.
function extractNodeBinaryFromTarGz(archive) {
  const tar = zlib.gunzipSync(archive);
  const wanted = /(^|\/)bin\/node$/;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = readCString(header, 0, 100);
    const prefix = readCString(header, 345, 155);
    const sizeField = readCString(header, 124, 12).trim();
    const size = sizeField ? Number.parseInt(sizeField, 8) : 0;
    const typeFlag = String.fromCharCode(header[156] || 48);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const dataStart = offset + 512;
    if ((typeFlag === "0" || typeFlag === "\0" || typeFlag === " ") && wanted.test(fullName) && size > 0) {
      return Buffer.from(tar.subarray(dataStart, dataStart + size));
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

async function httpGetBuffer(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Download failed with HTTP ${response.status}: ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function acquireNodeFromDownload(options, arch) {
  const nodeArch = SUPPORTED_ARCHES.get(arch).node;
  const version = options.nodeVersion;
  const base = `https://nodejs.org/dist/v${version}`;
  const archiveName = `node-v${version}-linux-${nodeArch}.tar.gz`;
  console.log(`Downloading ${base}/${archiveName} and SHASUMS256.txt ...`);
  const [shasums, archive] = await Promise.all([
    httpGetBuffer(`${base}/SHASUMS256.txt`),
    httpGetBuffer(`${base}/${archiveName}`),
  ]);
  const line = shasums.toString("utf8").split(/\r?\n/).find((entry) => entry.trim().endsWith(archiveName));
  if (!line) throw new Error(`SHASUMS256.txt does not list ${archiveName}.`);
  const expected = line.trim().split(/\s+/)[0].toLowerCase();
  const actual = crypto.createHash("sha256").update(archive).digest("hex");
  if (!/^[0-9a-f]{64}$/.test(expected) || actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${archiveName}: expected ${expected || "(missing)"}, computed ${actual}.`);
  }
  console.log(`SHA-256 verified for ${archiveName}.`);
  const binary = extractNodeBinaryFromTarGz(archive);
  if (!binary) throw new Error(`Could not locate bin/node inside ${archiveName}.`);
  return binary;
}

async function stageNodeRuntime(stageDir, options, arch) {
  const target = path.join(stageDir, RUNTIME_ROOT_RELATIVE, "node", "bin", "node");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (options.nodeDir) {
    const buffer = readNodeFromDirectory(options.nodeDir, arch);
    fs.writeFileSync(target, buffer);
    console.log(`Bundled Node runtime from --node-dir (${(buffer.length / 1024 / 1024).toFixed(1)} MiB).`);
    return;
  }
  if (options.downloadNode) {
    const buffer = await acquireNodeFromDownload(options, arch);
    assertLinuxNodeBinary(buffer, arch);
    fs.writeFileSync(target, buffer);
    console.log(`Bundled official Node ${options.nodeVersion} linux-${SUPPORTED_ARCHES.get(arch).node} runtime (${(buffer.length / 1024 / 1024).toFixed(1)} MiB).`);
    return;
  }
  fs.writeFileSync(target, PLACEHOLDER_NODE_CONTENT);
  console.log(`Placeholder Node runtime written to ${path.join(RUNTIME_ROOT_RELATIVE, "node", "bin", "node")} (not runnable; --stage-only, enforced before staging).`);
}

// The release identity makes the installed package self-describing: the CLI
// update check reads /usr/lib/anxos-agent/agent-release.json instead of the
// placeholder version in agent/package.json. It contains only release
// provenance (no secrets), so it is safe to stage and ship.
function stageReleaseIdentity(stageDir, releaseInfo) {
  const target = path.join(stageDir, RUNTIME_ROOT_RELATIVE, AGENT_RELEASE_FILENAME);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const identity = {
    schemaVersion: 1,
    product: "AnxOS Agent",
    artifactVersion: releaseInfo.artifactVersion,
    releaseTag: releaseInfo.tag,
    builtAt: new Date().toISOString(),
  };
  fs.writeFileSync(target, `${JSON.stringify(identity, null, 2)}\n`);
  console.log(`Stamped release identity ${identity.artifactVersion} (${identity.releaseTag}) at ${path.join(RUNTIME_ROOT_RELATIVE, AGENT_RELEASE_FILENAME)}.`);
  return target;
}

async function stagePayload(stageDir, options, arch, releaseInfo) {
  const artifactVersion = releaseInfo.artifactVersion;
  const runtimeRoot = path.join(stageDir, RUNTIME_ROOT_RELATIVE);
  copyTree(path.join(rootDir, "agent"), path.join(runtimeRoot, "agent"), {
    rootSkipDirectories: new Set(["config"]),
    skipFile: (name) => name === "package-lock.json",
  });
  copyTree(path.join(rootDir, "src", "shared"), path.join(runtimeRoot, "src", "shared"), {
    skipFile: (name) => !isRuntimeSourceFile(name),
  });
  copyTree(path.join(rootDir, "src", "services"), path.join(runtimeRoot, "src", "services"), {
    skipFile: (name) => !isRuntimeSourceFile(name),
  });
  copyTree(stagedDependenciesDir, path.join(runtimeRoot, "node_modules"), {});
  for (const name of CONTROL_CONFIG_FILES) {
    copyFileInto(path.join(rootDir, "config", name), path.join(runtimeRoot, "config", name));
  }

  copyFileInto(path.join(packagingDir, "anxos-agent.service"), path.join(stageDir, "lib", "systemd", "system", "anxos-agent.service"));
  copyFileInto(path.join(packagingDir, "anxos-agent.env.example"), path.join(stageDir, "etc", "anxos-agent", "agent.env.example"));
  const wrapperPath = path.join(stageDir, WRAPPER_RELATIVE);
  fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
  fs.writeFileSync(wrapperPath, WRAPPER_CONTENT);

  await stageNodeRuntime(stageDir, options, arch);

  for (const script of ["postinst", "prerm", "postrm"]) {
    copyFileInto(path.join(packagingDir, script), path.join(stageDir, "DEBIAN", script));
  }

  stageReleaseIdentity(stageDir, releaseInfo);

  const installedKiB = measureInstalledKiB(stageDir);
  const template = fs.readFileSync(path.join(packagingDir, "control.template"), "utf8");
  const rendered = template
    .replace(/\{\{VERSION\}\}/g, artifactVersion)
    .replace(/\{\{ARCH\}\}/g, arch)
    .replace(/\{\{INSTALLED_SIZE\}\}/g, String(installedKiB));
  if (/\{\{[A-Z_]+\}\}/.test(rendered)) {
    throw new Error("control.template contains unresolved placeholders.");
  }
  fs.writeFileSync(path.join(stageDir, "DEBIAN", "control"), rendered);
  normalizeStageModes(stageDir);
  return { installedKiB, files: countFiles(stageDir) };
}

function detectDpkgDeb() {
  const probe = spawnSync("dpkg-deb", ["--version"], { encoding: "utf8", shell: false });
  if (probe.error || probe.status !== 0) return null;
  return "dpkg-deb";
}

function displayPath(targetPath) {
  const relative = path.relative(rootDir, targetPath);
  return relative.startsWith("..") || path.isAbsolute(relative) ? targetPath : relative;
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function debArtifactName(artifactVersion, arch) {
  return arch === "amd64" ? `AnxOS-Agent-${artifactVersion}.deb` : `AnxOS-Agent-${artifactVersion}-${arch}.deb`;
}

// Windows drive paths are reached from WSL as /mnt/<drive>/...; every other
// host keeps the path unchanged.
function wslPath(targetPath) {
  const match = /^([A-Za-z]):[\\/](.*)$/.exec(targetPath);
  if (!match) return targetPath;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replace(/\\/g, "/")}`;
}

function printStagedOnly(reason, stageDir, artifactPath) {
  const artifactName = path.basename(artifactPath);
  const outputDir = wslPath(path.dirname(artifactPath));
  const stageSource = wslPath(stageDir);
  console.log("");
  console.log(`STAGED-ONLY: ${reason}`);
  console.log(`Stage directory: ${stageDir}`);
  console.log("To finish on a Debian/Ubuntu host that has dpkg-deb, run (the stage must");
  console.log("be on a Linux filesystem: WSL DrvFs reports 0777 directories and dpkg-deb");
  console.log("refuses a control directory with bad permissions):");
  console.log("  rm -rf /tmp/anxos-agent-stage");
  console.log(`  cp -a "${stageSource}" /tmp/anxos-agent-stage`);
  console.log("  find /tmp/anxos-agent-stage -type d -exec chmod 755 {} +");
  console.log("  find /tmp/anxos-agent-stage -type f -exec chmod 644 {} +");
  console.log("  chmod 755 /tmp/anxos-agent-stage/DEBIAN/postinst /tmp/anxos-agent-stage/DEBIAN/prerm /tmp/anxos-agent-stage/DEBIAN/postrm /tmp/anxos-agent-stage/usr/bin/anxos-agent /tmp/anxos-agent-stage/usr/lib/anxos-agent/node/bin/node");
  console.log(`  dpkg-deb --build --root-owner-group /tmp/anxos-agent-stage "/tmp/${artifactName}"`);
  console.log(`  (cd /tmp && sha256sum "${artifactName}" > "${artifactName}.sha256")`);
  console.log(`  cp "/tmp/${artifactName}" "/tmp/${artifactName}.sha256" "${outputDir}/"`);
}

async function main() {
  process.umask(0o022);
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const releaseInfo = buildReleaseInfo(readReleaseConfig());
  const artifactVersion = releaseInfo.artifactVersion;
  const arch = options.arch;
  const stageDir = options.stageDir || path.join(defaultDistDir, "agent-deb", `stage-${arch}`);
  const artifactPath = path.join(options.outputDir, debArtifactName(artifactVersion, arch));
  const markerPath = stageMarkerPath(stageDir);

  console.log(`AnxOS Agent deb build: ${artifactVersion} (${arch})`);
  ensureDependencies(options);
  prepareStageDirectory(stageDir);
  const staged = await stagePayload(stageDir, options, arch, releaseInfo);
  console.log(`Staged ${staged.files} file(s), Installed-Size=${staged.installedKiB} KiB, at ${stageDir}`);

  if (options.stageOnly) {
    printStagedOnly("--stage-only requested; dpkg-deb was not invoked.", stageDir, artifactPath);
    console.log("AGENT DEB BUILD: STAGED-ONLY");
    return;
  }

  const dpkgDeb = detectDpkgDeb();
  if (!dpkgDeb) {
    printStagedOnly("dpkg-deb is not available on this host.", stageDir, artifactPath);
    console.log("AGENT DEB BUILD: STAGED-ONLY");
    return;
  }

  fs.mkdirSync(options.outputDir, { recursive: true });
  // The marker lives outside the stage directory, so dpkg-deb cannot package it
  // into the control archive on any path.
  const build = spawnSync(dpkgDeb, ["--build", "--root-owner-group", stageDir, artifactPath], {
    stdio: "inherit",
    shell: false,
  });
  const buildFailed = Boolean(build.error) || build.status !== 0 || !fs.existsSync(artifactPath);
  if (buildFailed) {
    console.error(`dpkg-deb failed (exit ${build.status}); staged tree kept at ${stageDir}`);
    throw new Error(build.error?.message || "dpkg-deb --build did not produce the artifact.");
  }

  const digest = sha256File(artifactPath);
  fs.writeFileSync(`${artifactPath}.sha256`, `${digest}  ${path.basename(artifactPath)}\n`);
  console.log(`Built ${displayPath(artifactPath)} (${fs.statSync(artifactPath).size} bytes)`);
  console.log(`SHA-256: ${digest}`);
  console.log(`Checksum file: ${displayPath(`${artifactPath}.sha256`)}`);
  console.log("AGENT DEB BUILD: BUILT");

  if (!options.keepStage) {
    fs.rmSync(stageDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.rmSync(markerPath, { force: true });
  } else {
    console.log(`Stage kept at ${stageDir}`);
  }
}

main().catch((error) => {
  console.error(`AnxOS Agent deb build failed: ${error.message}`);
  process.exitCode = 1;
});
