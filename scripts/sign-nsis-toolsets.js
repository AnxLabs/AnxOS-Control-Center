// Phase 9: sign the NSIS plugin DLLs that the Windows installer loads.
//
// An NSIS installer extracts its plugin DLLs (nsExec, System, nsis7z, UAC,
// StdUtils, ...) to %TEMP% and loads them. electron-builder signs the
// installer and uninstaller but takes the plugins unsigned from its cached
// toolsets, so on Windows 11 with Smart App Control on, Code Integrity
// refuses to load them and the signed installer aborts without installing
// (reproduced in Windows Sandbox, event 3033 for nsExec.dll and System.dll).
//
// For a signed release build this copies the NSIS compiler bundle and the
// NSIS resources bundle electron-builder would use into dist/.signed-nsis,
// signs every plugin DLL there with the same Azure Trusted Signing account
// as the rest of the build, verifies each signature against the pinned
// publisher, and points electron-builder at the copies through its own
// ELECTRON_BUILDER_NSIS_DIR / ELECTRON_BUILDER_NSIS_RESOURCES_DIR overrides.
// Nothing is signed without the Azure configuration, and nothing outside the
// copies is modified.
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { evaluateInstallerSignature, windowsPowerShellEnv } = require("../src/shared/installerSignature");

const PLUGIN_ARCH_DIRS = new Set(["x86-unicode"]);

// Every plugin DLL under an x86-unicode directory (the only plugin
// architecture electron-builder's Unicode installer loads).
function listPluginDlls(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".dll") && PLUGIN_ARCH_DIRS.has(path.basename(directory).toLowerCase())) found.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found.sort();
}

// The two toolset directories electron-builder would use for this config.
async function locateNsisToolsets(buildConfig = {}) {
  const windows = require("app-builder-lib/out/toolsets/windows");
  const nsisToolset = buildConfig.toolsets?.nsis;
  const makensis = await windows.getMakeNsisPath(nsisToolset, buildConfig.nsis?.customNsisBinary);
  // Legacy bundles set NSISDIR to the bundle root; the unified bundle's
  // makensis.cmd sits in the root itself.
  const nsisDir = makensis.env?.NSISDIR || path.dirname(makensis.path);
  const pluginsDir = await windows.getNsisPluginsPath(nsisToolset, buildConfig.nsis?.customNsisResources);
  const resourcesDir = path.basename(pluginsDir).toLowerCase() === "plugins" && path.basename(path.dirname(pluginsDir)).toLowerCase() === "windows"
    ? path.dirname(path.dirname(pluginsDir))
    : path.dirname(pluginsDir);
  return { nsisDir, resourcesDir };
}

function copyTree(source, target) {
  fs.cpSync(source, target, { recursive: true, force: true, errorOnExist: false, dereference: true });
}

function trustedSigningCommand(azure, filePath) {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    `Invoke-TrustedSigning -Endpoint ${quote(azure.endpoint)} -CertificateProfileName ${quote(azure.certificateProfileName)} -CodeSigningAccountName ${quote(azure.codeSigningAccountName)} -TimestampRfc3161 'http://timestamp.acs.microsoft.com' -TimestampDigest 'SHA256' -FileDigest 'SHA256' -Files ${quote(filePath)}`,
  ].join("; ");
}

// The same module setup electron-builder runs before it signs: the NuGet
// provider (best effort; runners usually have it), then TrustedSigning.
// Without the provider, Windows PowerShell 5.1 stops Install-Module at a
// prompt, which fails at once in a non-interactive build (CI run
// 43503163673).
const TRUSTED_SIGNING_SETUP_COMMANDS = [
  "Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser",
  "Install-Module -Name TrustedSigning -MinimumVersion 0.5.0 -Force -Repository PSGallery -Scope CurrentUser",
];

// electron-builder signs through pwsh.exe when it exists and falls back to
// powershell.exe; this step uses the same shell so the module it installs is
// the one Invoke-TrustedSigning loads.
function resolvePowerShell(run = spawnSync) {
  const probe = run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Command pwsh.exe"], { encoding: "utf8", windowsHide: true });
  return probe.status === 0 ? "pwsh.exe" : "powershell.exe";
}

function tail(text, length = 800) {
  const value = String(text || "").trim();
  return value.length > length ? `...${value.slice(-length)}` : value;
}

let preparedShell = null;

function prepareTrustedSigning(run = spawnSync) {
  // Cached for the real build only; tests pass their own runner.
  if (preparedShell && run === spawnSync) return preparedShell;
  const shell = resolvePowerShell(run);
  const provider = run(shell, ["-NoProfile", "-NonInteractive", "-Command", TRUSTED_SIGNING_SETUP_COMMANDS[0]], { encoding: "utf8", windowsHide: true });
  if (provider.status !== 0) console.log(`NuGet provider setup did not complete (it is often preinstalled): ${tail(provider.stderr, 300)}`);
  const module = run(shell, ["-NoProfile", "-NonInteractive", "-Command", TRUSTED_SIGNING_SETUP_COMMANDS[1]], { encoding: "utf8", windowsHide: true });
  if (module.status !== 0) throw new Error(`Installing the TrustedSigning module with ${shell} failed (exit ${module.status}): ${tail(module.stderr || module.stdout)}`);
  console.log(`Trusted Signing module ready (${shell}).`);
  if (run === spawnSync) preparedShell = shell;
  return shell;
}

// Signs one file with the build's Azure Trusted Signing account (the same
// Invoke-TrustedSigning call electron-builder makes). Credentials come from
// the AZURE_* environment the build already has and are never printed; the
// error text on failure is PowerShell's own (CI masks secret values).
function signWithTrustedSigning(filePath, azure) {
  const shell = prepareTrustedSigning();
  const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", trustedSigningCommand(azure, filePath)], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`Trusted Signing failed for ${path.basename(filePath)} (exit ${result.status}): ${tail(result.stderr || result.stdout)}`);
}

function readAuthenticode(filePath) {
  const script = "$s = Get-AuthenticodeSignature -LiteralPath $env:ANXOS_SIGNATURE_PATH; [pscustomobject]@{ status = [string]$s.Status; subject = if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null }; issuer = if ($s.SignerCertificate) { $s.SignerCertificate.Issuer } else { $null }; timestamped = [bool]$s.TimeStamperCertificate } | ConvertTo-Json -Compress";
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", windowsHide: true, env: windowsPowerShellEnv({ ANXOS_SIGNATURE_PATH: filePath }) });
  if (result.status !== 0) throw new Error(`Could not read the signature of ${path.basename(filePath)}: ${tail(result.stderr)}`);
  const parsed = JSON.parse(String(result.stdout).trim());
  // An empty status means PowerShell could not run the check at all; say why
  // rather than reporting an unknown signature.
  if (!parsed?.status) throw new Error(`Could not read the signature of ${path.basename(filePath)}: ${tail(result.stderr) || "no status returned"}`);
  return parsed;
}

// Copies both toolsets to stageRoot, signs and verifies every plugin DLL, and
// returns the environment overrides for electron-builder. `sign` and
// `readSignature` are injectable for tests.
async function prepareSignedNsisToolsets(options) {
  const { azure, stageRoot, toolsets, sign = signWithTrustedSigning, readSignature = readAuthenticode, log = console.log } = options;
  if (!azure) throw new Error("prepareSignedNsisToolsets needs the Azure Trusted Signing configuration.");
  const located = toolsets || await locateNsisToolsets(options.buildConfig);
  fs.rmSync(stageRoot, { recursive: true, force: true });
  const nsisDir = path.join(stageRoot, "nsis");
  const resourcesDir = path.join(stageRoot, "nsis-resources");
  copyTree(located.nsisDir, nsisDir);
  copyTree(located.resourcesDir, resourcesDir);
  const plugins = [...listPluginDlls(nsisDir), ...listPluginDlls(resourcesDir)];
  if (!plugins.some((file) => /nsExec\.dll$/i.test(file)) || !plugins.some((file) => /System\.dll$/i.test(file))) {
    throw new Error("The NSIS toolsets did not contain the expected plugins (nsExec.dll, System.dll); refusing to build an installer that cannot run under Smart App Control.");
  }
  const signed = [];
  for (const file of plugins) {
    sign(file, azure);
    const summary = evaluateInstallerSignature(readSignature(file));
    signed.push({ file: path.relative(stageRoot, file), publisher: summary.publisher, timestamped: summary.timestamped });
  }
  log(`Signed and verified ${signed.length} NSIS plugin DLL(s) for Smart App Control (publisher ${signed[0]?.publisher}).`);
  fs.writeFileSync(path.join(stageRoot, "signed-plugins.json"), `${JSON.stringify({ source: located, plugins: signed }, null, 2)}\n`);
  return {
    env: { ELECTRON_BUILDER_NSIS_DIR: nsisDir, ELECTRON_BUILDER_NSIS_RESOURCES_DIR: resourcesDir },
    plugins: signed,
  };
}

module.exports = { TRUSTED_SIGNING_SETUP_COMMANDS, listPluginDlls, locateNsisToolsets, prepareSignedNsisToolsets, prepareTrustedSigning, readAuthenticode, resolvePowerShell, trustedSigningCommand };
