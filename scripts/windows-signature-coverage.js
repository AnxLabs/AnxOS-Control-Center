// Phase 9: every program, library and script a Windows release ships must be
// signed, or Smart App Control can refuse to run or load it.
//
// The release verifier used to check only .exe files. Build 209 shipped six
// unsigned Electron DLLs (ffmpeg.dll, libEGL.dll, ...) and two unsigned .node
// modules, and its installer's NSIS plugins were unsigned, which Smart App
// Control blocked in a clean Windows 11 sandbox. This module classifies every
// .exe/.dll/.node/.ps1 in the packaged output:
//   - each one must have a Valid Authenticode signature (any trusted signer:
//     Microsoft, .NET, Eclipse Temurin and so on ship already signed);
//   - files AnxOS signs itself (its executables, installers, the files named
//     in build.win.signExts, and the NSIS plugins staged for signing) must be
//     signed by the pinned AnxOS publisher.
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { evaluateInstallerSignature } = require("../src/shared/installerSignature");

const COVERED_EXTENSIONS = new Set([".exe", ".dll", ".node", ".ps1"]);

function listCoveredFiles(roots) {
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && COVERED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) files.push(full);
    }
  };
  for (const root of roots) if (root && fs.existsSync(root)) {
    if (fs.statSync(root).isDirectory()) walk(root);
    else files.push(root);
  }
  return [...new Set(files)].sort();
}

// True when AnxOS itself signs this file in a release build.
function isSignedByAnxOS(filePath, options = {}) {
  const name = filePath.replace(/\\/g, "/");
  const signExts = options.signExts || [];
  if (options.ourExecutables?.some((exe) => name.toLowerCase().endsWith(`/${exe.toLowerCase()}`))) return true;
  if (/\/AnxOS-Control-Center-Setup-[^/]+\.exe$/i.test(name) || /__uninstaller\.exe$/i.test(name)) return true;
  if (options.nsisStageRoot && path.resolve(filePath).toLowerCase().startsWith(path.resolve(options.nsisStageRoot).toLowerCase() + path.sep)) return true;
  return signExts.some((ext) => !ext.startsWith("!") && name.endsWith(ext));
}

// Pure: classifies signature results ({ file, status, subject, issuer,
// timestamped }) into failures with a reason each.
function classifySignatures(results, options = {}) {
  const failures = [];
  for (const result of results) {
    if (result.status !== "Valid") {
      failures.push({ file: result.file, reason: `signature ${result.status || "missing"}` });
      continue;
    }
    if (isSignedByAnxOS(result.file, options)) {
      try {
        evaluateInstallerSignature(result);
      } catch (error) {
        failures.push({ file: result.file, reason: `${error.code}: signed by ${error.details?.publisher || "an unknown publisher"}` });
      }
    }
  }
  return failures;
}

// Reads Authenticode results for many files with one PowerShell process.
function readSignatures(files) {
  if (!files.length) return [];
  const listPath = path.join(require("os").tmpdir(), `anxos-signature-list-${process.pid}.txt`);
  fs.writeFileSync(listPath, files.join("\n"), "utf8");
  try {
    const script = [
      "$ErrorActionPreference = 'Stop'",
      "Get-Content -LiteralPath $env:ANXOS_SIGNATURE_LIST -Encoding UTF8 | Where-Object { $_ } | ForEach-Object {",
      // Get-Content lines carry PSPath and other note properties; [string]
      // keeps the JSON a plain path.
      "  $path = [string]$_",
      "  $s = Get-AuthenticodeSignature -LiteralPath $path",
      "  [pscustomobject]@{ file = $path; status = [string]$s.Status; subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null }; issuer = if ($s.SignerCertificate) { $s.SignerCertificate.Issuer } else { $null }; timestamped = [bool]$s.TimeStamperCertificate }",
      "} | ConvertTo-Json -Compress -Depth 3",
    ].join("\n");
    const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ANXOS_SIGNATURE_LIST: listPath } });
    if (result.status !== 0) throw new Error(`Get-AuthenticodeSignature failed: ${String(result.stderr || "").slice(0, 300)}`);
    const parsed = JSON.parse(String(result.stdout || "[]").trim() || "[]");
    return Array.isArray(parsed) ? parsed : [parsed];
  } finally {
    fs.rmSync(listPath, { force: true });
  }
}

module.exports = { COVERED_EXTENSIONS, classifySignatures, isSignedByAnxOS, listCoveredFiles, readSignatures };
