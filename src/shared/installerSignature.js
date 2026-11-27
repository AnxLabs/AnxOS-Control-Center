// Phase 9: Authenticode check of a downloaded Windows update installer before
// it is handed to Windows.
//
// The update manager already proves the download matches the SHA-256 in the
// release metadata. That metadata is fetched over HTTPS but is not itself
// signed, so a checksum alone cannot tell a genuine installer from one swapped
// together with its metadata. Release installers are signed in CI through
// Azure Trusted Signing ("Microsoft ID Verified CS" certificates issued to the
// publisher below), so the installer must carry a valid signature from that
// publisher before it is opened. Anything else fails closed.
//
// Windows' own Get-AuthenticodeSignature does the cryptography and chain
// validation; this module only runs it with the path passed through the
// environment (never interpolated into the command) and applies the policy.
"use strict";

const { execFile } = require("child_process");
const path = require("path");

// The publisher identity on AnxOS Control Center release builds (see the
// installed app's signature). Kept here, not in downloaded metadata, so a
// tampered feed cannot name its own publisher.
const TRUSTED_WINDOWS_PUBLISHER = Object.freeze({
  commonName: "Anjo ROSIMO",
  organization: "Anjo ROSIMO",
  // Trusted Signing rotates its intermediate CAs (AOC CA 01, 02, 03, ...).
  issuerCommonNamePrefix: "Microsoft ID Verified CS",
});

const SIGNED_EXTENSIONS = new Set([".exe", ".msi"]);
const POWERSHELL_TIMEOUT_MS = 30000;

const SIGNATURE_QUERY = [
  "$ErrorActionPreference = 'Stop'",
  "$s = Get-AuthenticodeSignature -LiteralPath $env:ANXOS_VERIFY_INSTALLER_PATH",
  "[pscustomobject]@{",
  "  status = [string]$s.Status",
  "  statusMessage = [string]$s.StatusMessage",
  "  subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null }",
  "  issuer = if ($s.SignerCertificate) { $s.SignerCertificate.Issuer } else { $null }",
  "  thumbprint = if ($s.SignerCertificate) { $s.SignerCertificate.Thumbprint } else { $null }",
  "  timestamped = [bool]$s.TimeStamperCertificate",
  "} | ConvertTo-Json -Compress",
].join("\n");

// Parses an X.500 distinguished name ("CN=a, O=b, C=CA") into its first value
// per attribute. Quoted values with commas are handled; anything malformed
// simply yields fewer attributes, which then fails the policy.
function parseDistinguishedName(value) {
  const result = {};
  const text = String(value || "");
  const pattern = /\s*([A-Za-z.0-9]+)=("(?:[^"]|"")*"|[^,]*)\s*(?:,|$)/g;
  let match;
  while ((match = pattern.exec(text)) && match[0]) {
    const key = match[1].toUpperCase();
    let raw = match[2].trim();
    if (raw.startsWith('"') && raw.endsWith('"')) raw = raw.slice(1, -1).replace(/""/g, '"');
    if (!(key in result)) result[key] = raw;
  }
  return result;
}

function signatureError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details });
}

// Applies the publisher policy to the raw Get-AuthenticodeSignature result.
// Returns a summary on success and throws a coded error otherwise.
function evaluateInstallerSignature(raw, publisher = TRUSTED_WINDOWS_PUBLISHER) {
  const status = String(raw?.status || "Unknown");
  const subject = parseDistinguishedName(raw?.subject);
  const issuer = parseDistinguishedName(raw?.issuer);
  const summary = {
    status,
    publisher: subject.CN || null,
    issuer: issuer.CN || null,
    thumbprint: typeof raw?.thumbprint === "string" ? raw.thumbprint : null,
    timestamped: raw?.timestamped === true,
  };
  if (status === "NotSigned") {
    throw signatureError("UPDATE_INSTALLER_UNSIGNED", "The downloaded installer is not signed, so it was not opened.", summary);
  }
  if (status === "HashMismatch") {
    throw signatureError("UPDATE_INSTALLER_SIGNATURE_BROKEN", "The downloaded installer was changed after it was signed, so it was not opened.", summary);
  }
  if (status !== "Valid") {
    throw signatureError("UPDATE_INSTALLER_SIGNATURE_INVALID", `Windows could not confirm the installer's signature (${status}), so it was not opened.`, summary);
  }
  const publisherMatches = subject.CN === publisher.commonName && subject.O === publisher.organization;
  const issuerMatches = typeof issuer.CN === "string" && issuer.CN.startsWith(publisher.issuerCommonNamePrefix);
  if (!publisherMatches || !issuerMatches) {
    throw signatureError("UPDATE_INSTALLER_WRONG_PUBLISHER", `The downloaded installer is signed by "${summary.publisher || "an unknown publisher"}", not by the AnxHost Control Center publisher, so it was not opened.`, summary);
  }
  return { ...summary, verified: true };
}

// The environment for a Windows PowerShell (powershell.exe) child process.
// PSModulePath is left out: when the parent is PowerShell 7 (pwsh, as in
// GitHub's Windows runners), its PSModulePath makes Windows PowerShell fail to
// load Microsoft.PowerShell.Security, so Get-AuthenticodeSignature returns
// nothing (reproduced; CI run 43506235515). Windows PowerShell rebuilds its own
// default module path when the variable is absent.
function windowsPowerShellEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
  return env;
}

function runSignatureQuery(filePath) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", SIGNATURE_QUERY],
      {
        timeout: POWERSHELL_TIMEOUT_MS,
        windowsHide: true,
        env: windowsPowerShellEnv({ ANXOS_VERIFY_INSTALLER_PATH: filePath }),
      },
      (error, stdout) => {
        if (error) {
          reject(signatureError("UPDATE_INSTALLER_SIGNATURE_UNCHECKED", "Windows could not check the installer's signature, so it was not opened.", { causeCode: error.code || null }));
          return;
        }
        try {
          resolve(JSON.parse(String(stdout || "").trim()));
        } catch {
          reject(signatureError("UPDATE_INSTALLER_SIGNATURE_UNCHECKED", "Windows returned an unreadable signature result, so the installer was not opened."));
        }
      },
    );
  });
}

// Verifies a downloaded installer. Only Windows .exe/.msi installers are
// Authenticode-checked; other platforms' packages are not signed this way and
// report `applicable: false` (their SHA-256 check still applies).
async function verifyInstallerSignature(filePath, options = {}) {
  const platform = options.platform || process.platform;
  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (platform !== "win32" || !SIGNED_EXTENSIONS.has(extension)) {
    return { applicable: false, verified: false, reason: platform !== "win32" ? "not_windows" : "not_a_windows_installer" };
  }
  const query = options.runSignatureQuery || runSignatureQuery;
  const raw = await query(filePath);
  return { applicable: true, ...evaluateInstallerSignature(raw, options.publisher || TRUSTED_WINDOWS_PUBLISHER) };
}

module.exports = {
  TRUSTED_WINDOWS_PUBLISHER,
  windowsPowerShellEnv,
  evaluateInstallerSignature,
  parseDistinguishedName,
  verifyInstallerSignature,
};
