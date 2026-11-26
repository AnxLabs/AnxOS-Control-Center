#!/usr/bin/env node
"use strict";

// Builds AnxHost Setup (windows/setup, Rust) around the NSIS install engine.
// docs/anxhost/d-installer/CUSTOM_INSTALLER_PROPOSAL.md has the design.
//
//   node scripts/build-anxhost-setup.js maintenance
//     Before electron-builder: Setup without an engine, signed when Azure
//     Trusted Signing is configured, at dist/.anxhost-setup/AnxHost Setup.exe.
//     scripts/electron-builder-config.js puts it in the app's resources, where
//     the NSIS uninstaller hands an interactive uninstall to it.
//
//   node scripts/build-anxhost-setup.js package
//     After electron-builder: the NSIS installer it wrote
//     (dist/AnxOS-Control-Center-Setup-<v>.exe) becomes the engine
//     (dist/engine/AnxOS-Control-Center-Engine-<v>.exe, never published).
//     Setup is built with the engine's SHA-256 compiled in, the engine is
//     appended to it, and the result is signed and published under the
//     installer's name, so the updater's /setup.*\.exe$/i finds exactly one
//     file: Setup. The blockmap and latest.yml are written for Setup.
//
// Release builds (Azure configured) require the engine to carry a valid
// signature from the pinned publisher before it is embedded, and Setup then
// refuses to run any engine without one.

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CRATE = path.join(ROOT, "windows", "setup");
const DIST = path.join(ROOT, "dist");
const MAINTENANCE_DIR = path.join(DIST, ".anxhost-setup");
const MAINTENANCE_EXE = path.join(MAINTENANCE_DIR, "AnxHost Setup.exe");
const PAYLOAD_MAGIC = Buffer.from("ANXHOST-ENGINE-1", "ascii");
const TRUSTED_PUBLISHER_CN = "Anjo ROSIMO";

const setupName = (artifactVersion) => `AnxOS-Control-Center-Setup-${artifactVersion}.exe`;
const engineName = (artifactVersion) => `AnxOS-Control-Center-Engine-${artifactVersion}.exe`;

// A clean Windows install has no Visual C++ runtime: Setup links the C runtime
// statically. RUSTFLAGS in the environment would replace .cargo/config.toml,
// so the flag is added here too.
const STATIC_CRT_FLAG = "-C target-feature=+crt-static";

function assertNoVcRuntimeImport(exe) {
  const imported = fs.readFileSync(exe).toString("latin1").match(/(vcruntime|msvcp)1\d\d(_\d)?\.dll/gi);
  if (imported) throw new Error(`AnxHost Setup imports ${[...new Set(imported.map((n) => n.toLowerCase()))].join(", ")}, which a clean Windows install does not have. It must link the C runtime statically (+crt-static).`);
}

function cargoBuild(env) {
  const targetDir = path.join(CRATE, "target");
  const rustflags = [process.env.RUSTFLAGS, STATIC_CRT_FLAG].filter(Boolean).join(" ");
  const result = spawnSync("cargo", ["build", "--release", "--locked", "--manifest-path", path.join(CRATE, "Cargo.toml")], {
    cwd: CRATE,
    stdio: "inherit",
    env: { ...process.env, CARGO_TARGET_DIR: targetDir, RUSTFLAGS: rustflags, ...env },
  });
  if (result.error) throw new Error(`cargo could not be started (${result.error.message}). Install the Rust toolchain (rustup) to build AnxHost Setup.`);
  if (result.status !== 0) throw new Error(`Building AnxHost Setup failed (cargo exit ${result.status}).`);
  const exe = path.join(targetDir, "release", "anxhost-setup.exe");
  assertNoVcRuntimeImport(exe);
  return exe;
}

function folderBytes(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += folderBytes(full);
    else if (entry.isFile()) total += fs.statSync(full).size;
  }
  return total;
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(1 << 20);
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

// The format windows/setup/src/engine.rs reads (payload_range): zero padding
// so the footer ends on 8 bytes, the engine, its length (u64 LE), the magic.
function appendPayload(setupFile, engineFile) {
  const setupLength = fs.statSync(setupFile).size;
  const engineLength = fs.statSync(engineFile).size;
  const footer = 8 + PAYLOAD_MAGIC.length;
  const pad = (8 - ((setupLength + engineLength + footer) % 8)) % 8;
  const out = fs.openSync(setupFile, "a");
  try {
    fs.writeSync(out, Buffer.alloc(pad));
    const input = fs.openSync(engineFile, "r");
    try {
      const buf = Buffer.alloc(1 << 20);
      let n;
      while ((n = fs.readSync(input, buf, 0, buf.length, null)) > 0) fs.writeSync(out, buf, 0, n);
    } finally {
      fs.closeSync(input);
    }
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(engineLength));
    fs.writeSync(out, length);
    fs.writeSync(out, PAYLOAD_MAGIC);
  } finally {
    fs.closeSync(out);
  }
}

// Where the appended engine lies (the same rule as payload_range in
// windows/setup/src/engine.rs): before the Authenticode certificate table
// named by the PE header, or at the end of an unsigned file, behind up to 7
// zero bytes. Returns { offset, size } or null.
function payloadRange(file) {
  const fd = fs.openSync(file, "r");
  try {
    const length = fs.fstatSync(fd).size;
    const header = Buffer.alloc(Math.min(4096, length));
    fs.readSync(fd, header, 0, header.length, 0);
    let end = length;
    if (header.subarray(0, 2).toString("latin1") === "MZ" && header.length >= 0x40) {
      const pe = header.readUInt32LE(0x3c);
      if (pe + 0x100 <= header.length && header.subarray(pe, pe + 4).toString("latin1") === "PE\0\0") {
        const optional = pe + 24;
        const magic = header.readUInt16LE(optional);
        const dirs = magic === 0x20b ? optional + 112 : magic === 0x10b ? optional + 96 : 0;
        if (dirs) {
          const certAt = header.readUInt32LE(dirs + 32);
          const certSize = header.readUInt32LE(dirs + 36);
          if (certAt > 0 && certSize > 0 && certAt <= length) end = certAt;
        }
      }
    }
    const footer = 8 + PAYLOAD_MAGIC.length;
    for (let pad = 0; pad < 8 && end >= footer + pad; pad += 1) {
      const at = end - pad - footer;
      const buf = Buffer.alloc(footer + pad);
      fs.readSync(fd, buf, 0, buf.length, at);
      if (buf.subarray(footer).some((b) => b !== 0)) continue;
      if (buf.subarray(8, footer).equals(PAYLOAD_MAGIC)) {
        const size = Number(buf.readBigUInt64LE(0));
        if (size > 0 && size <= at) return { offset: at - size, size };
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

// latest.yml describes the published installer; after the swap it must name
// Setup's own SHA-512 and size (and blockmap size when listed).
function rewriteLatestYml(text, fileName, info) {
  const lines = String(text).split(/\r?\n/);
  let inFile = false;
  return lines.map((line) => {
    if (/^\s*-\s*url:\s*/.test(line)) inFile = line.includes(fileName);
    if (/^\S/.test(line)) inFile = false;
    if (/^sha512:/.test(line)) return `sha512: ${info.sha512}`;
    if (inFile && /^\s+sha512:/.test(line)) return line.replace(/sha512:.*/, `sha512: ${info.sha512}`);
    if (inFile && /^\s+size:/.test(line)) return line.replace(/size:.*/, `size: ${info.size}`);
    if (inFile && /^\s+blockMapSize:/.test(line) && info.blockMapSize) return line.replace(/blockMapSize:.*/, `blockMapSize: ${info.blockMapSize}`);
    return line;
  }).join("\n");
}

function azureConfig() {
  const { getAzureSigningConfig } = require("./azure-signing-config");
  return getAzureSigningConfig();
}

function sign(file, azure) {
  if (!azure) return;
  const { signWithTrustedSigning } = require("./sign-nsis-toolsets");
  signWithTrustedSigning(file, azure);
}

function requireTrustedSignature(file, label) {
  const { readAuthenticode } = require("./sign-nsis-toolsets");
  const signature = readAuthenticode(file);
  const cn = /CN=([^,]+)/.exec(signature?.subject || "")?.[1]?.trim();
  if (signature?.status !== "Valid" || cn !== TRUSTED_PUBLISHER_CN) {
    throw new Error(`${label} is not validly signed by ${TRUSTED_PUBLISHER_CN} (status ${signature?.status || "unknown"}, signer ${cn || "none"}).`);
  }
}

function artifactVersion() {
  const { buildReleaseInfo, readReleaseConfig } = require("../src/shared/releaseConfig");
  return process.env.ANXOS_RELEASE_ARTIFACT_VERSION || buildReleaseInfo(readReleaseConfig()).artifactVersion;
}

function buildMaintenance() {
  const azure = azureConfig();
  const version = artifactVersion();
  const built = cargoBuild({ ANXHOST_SETUP_ENGINE: "", ANXHOST_SETUP_ARTIFACT_VERSION: version, ANXHOST_SETUP_REQUIRE_SIGNATURE: azure ? "1" : "0" });
  fs.mkdirSync(MAINTENANCE_DIR, { recursive: true });
  fs.copyFileSync(built, MAINTENANCE_EXE);
  sign(MAINTENANCE_EXE, azure);
  console.log(`AnxHost Setup (uninstall copy): ${path.relative(ROOT, MAINTENANCE_EXE)}${azure ? " (signed)" : " (unsigned development build)"}`);
  return MAINTENANCE_EXE;
}

async function packageSetup() {
  const azure = azureConfig();
  const version = artifactVersion();
  const installer = path.join(DIST, setupName(version));
  if (!fs.existsSync(installer)) throw new Error(`The NSIS installer ${path.relative(ROOT, installer)} was not built.`);
  if (azure) requireTrustedSignature(installer, "The install engine");
  // The engine is kept for verification and never published.
  const engineDir = path.join(DIST, "engine");
  fs.mkdirSync(engineDir, { recursive: true });
  const engine = path.join(engineDir, engineName(version));
  fs.rmSync(engine, { force: true });
  fs.renameSync(installer, engine);
  fs.rmSync(`${installer}.blockmap`, { force: true });

  const appBytes = folderBytes(path.join(DIST, "win-unpacked"));
  const built = cargoBuild({
    ANXHOST_SETUP_ENGINE: engine,
    ANXHOST_SETUP_ARTIFACT_VERSION: version,
    ANXHOST_SETUP_REQUIRE_SIGNATURE: azure ? "1" : "0",
    ANXHOST_SETUP_APP_BYTES: String(appBytes),
  });
  fs.copyFileSync(built, installer);
  appendPayload(installer, engine);
  sign(installer, azure);
  if (azure) requireTrustedSignature(installer, "AnxHost Setup");

  const { buildBlockMap } = require("app-builder-lib/out/targets/blockmap/blockmap");
  const info = await buildBlockMap(installer, "gzip", `${installer}.blockmap`);
  const latest = path.join(DIST, "latest.yml");
  if (fs.existsSync(latest)) {
    fs.writeFileSync(latest, rewriteLatestYml(fs.readFileSync(latest, "utf8"), path.basename(installer), info));
  }
  console.log(`AnxHost Setup: ${path.relative(ROOT, installer)} (${Math.round(fs.statSync(installer).size / 1048576)} MB, engine ${sha256File(engine).slice(0, 16)}…, app ${Math.round(appBytes / 1048576)} MB)${azure ? " (signed)" : " (unsigned development build)"}`);
  return { installer, engine, info };
}

module.exports = { MAINTENANCE_EXE, PAYLOAD_MAGIC, TRUSTED_PUBLISHER_CN, appendPayload, assertNoVcRuntimeImport, buildMaintenance, engineName, packageSetup, payloadRange, rewriteLatestYml, setupName };

if (require.main === module) {
  const step = process.argv[2];
  Promise.resolve()
    .then(() => (step === "maintenance" ? buildMaintenance() : step === "package" ? packageSetup() : Promise.reject(new Error("usage: build-anxhost-setup.js maintenance|package"))))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
