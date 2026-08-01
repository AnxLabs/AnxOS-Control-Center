#!/usr/bin/env node
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");
const { spawnSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "config", "windows-runtime-bundle.json");
const runtimeResourcesRoot = path.join(root, "resources", "bundled-runtimes");
const outputRoot = path.join(runtimeResourcesRoot, "win-x64");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

function bundleIsCurrent() {
  try {
    const current = JSON.parse(fs.readFileSync(path.join(outputRoot, "bundle-manifest.json"), "utf8"));
    return manifest.artifacts.every((artifact) => {
      const recorded = current.artifacts?.find((entry) => entry.id === artifact.id);
      return recorded?.version === artifact.version &&
        recorded?.checksum?.toLowerCase() === artifact.checksum.toLowerCase() &&
        fs.existsSync(path.join(outputRoot, artifact.destination));
    });
  } catch {
    return false;
  }
}

function fail(message) {
  throw new Error(message);
}

function download(url, destination, redirects = 0) {
  if (redirects > 8) return Promise.reject(new Error("Too many runtime download redirects."));
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": "AnxOS-Control-Center-Build" } }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        response.resume();
        resolve(download(new URL(response.headers.location, url).toString(), destination, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Runtime download failed with HTTP ${response.statusCode}.`));
        return;
      }
      const file = fs.createWriteStream(destination, { flags: "wx", mode: 0o600 });
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    });
    request.setTimeout(120000, () => request.destroy(new Error("Runtime download timed out.")));
    request.on("error", reject);
  });
}

function checksum(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm);
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.on("end", () => resolve(hash.digest("hex")));
    input.on("error", reject);
  });
}

function expandArchive(archive, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const escapedArchive = archive.replace(/'/g, "''");
  const escapedDestination = destination.replace(/'/g, "''");
  const result = spawnSync("powershell.exe", [
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command",
    `Expand-Archive -LiteralPath '${escapedArchive}' -DestinationPath '${escapedDestination}' -Force`,
  ], { cwd: root, stdio: "inherit", windowsHide: true });
  if (result.error || result.status !== 0) fail(result.error?.message || "Runtime archive extraction failed.");
}

function flattenSingleDirectory(destination) {
  const entries = fs.readdirSync(destination, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory()) return;
  const nested = path.join(destination, entries[0].name);
  for (const entry of fs.readdirSync(nested)) {
    fs.renameSync(path.join(nested, entry), path.join(destination, entry));
  }
  fs.rmdirSync(nested);
}

async function main() {
  if (process.platform !== "win32") fail("Windows runtime bundles must be prepared on Windows.");
  if (bundleIsCurrent()) {
    console.log("Verified Windows runtime bundle is already current.");
    return;
  }
  fs.mkdirSync(runtimeResourcesRoot, { recursive: true });
  const stagingRoot = fs.mkdtempSync(path.join(runtimeResourcesRoot, ".win-x64-staging-"));
  const backupRoot = `${outputRoot}.previous-${process.pid}`;
  const resolved = [];
  try {
    for (const artifact of manifest.artifacts) {
      const destination = path.resolve(stagingRoot, artifact.destination);
      if (!destination.startsWith(`${stagingRoot}${path.sep}`)) fail(`Unsafe runtime destination: ${artifact.destination}`);
      const archive = path.join(stagingRoot, `.${artifact.id}.zip`);
      console.log(`Downloading ${artifact.id} ${artifact.version} from its pinned official source.`);
      await download(artifact.url, archive);
      const actual = await checksum(archive, artifact.algorithm);
      if (actual.toLowerCase() !== artifact.checksum.toLowerCase()) fail(`${artifact.id} checksum verification failed.`);
      expandArchive(archive, destination);
      fs.rmSync(archive, { force: true });
      if (artifact.flattenSingleDirectory) flattenSingleDirectory(destination);
      resolved.push({
        id: artifact.id,
        version: artifact.version,
        checksumAlgorithm: artifact.algorithm,
        checksum: artifact.checksum,
        destination: artifact.destination,
        license: artifact.license,
      });
    }
    fs.writeFileSync(path.join(stagingRoot, "bundle-manifest.json"), `${JSON.stringify({
      schemaVersion: manifest.schemaVersion,
      platform: manifest.platform,
      generatedAt: new Date().toISOString(),
      artifacts: resolved,
    }, null, 2)}\n`);
    fs.copyFileSync(path.join(root, "docs", "THIRD_PARTY_RUNTIMES.md"), path.join(stagingRoot, "THIRD_PARTY_RUNTIMES.md"));
    fs.rmSync(backupRoot, { recursive: true, force: true });
    if (fs.existsSync(outputRoot)) fs.renameSync(outputRoot, backupRoot);
    try {
      fs.renameSync(stagingRoot, outputRoot);
    } catch (error) {
      if (fs.existsSync(backupRoot) && !fs.existsSync(outputRoot)) fs.renameSync(backupRoot, outputRoot);
      throw error;
    }
    fs.rmSync(backupRoot, { recursive: true, force: true });
    console.log(`Prepared ${resolved.length} verified Windows runtime bundles.`);
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
