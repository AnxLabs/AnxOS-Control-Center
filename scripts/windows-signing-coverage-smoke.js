#!/usr/bin/env node
// Phase 9: Smart App Control compatibility of the Windows release.
//   W1 build.win.signExts names exactly the files Build 209 shipped unsigned
//      (six Electron DLLs and the .node modules) plus PowerShell scripts, and
//      none of the third-party DLLs that ship already signed
//   W2 the release coverage check fails unsigned or broken files, accepts
//      third-party signatures on third-party files, and requires the AnxOS
//      publisher on everything AnxOS signs itself
//   W3 the NSIS staging step copies both toolsets, signs and verifies every
//      x86-unicode plugin DLL, returns electron-builder's override variables,
//      and refuses when a plugin stays unsigned or the plugins are missing;
//      the Trusted Signing command carries no credentials
//   W4 (when electron-builder's NSIS toolsets are cached here) the real
//      toolsets hold the plugins Smart App Control blocked (nsExec, System)
//      and the extractor (nsis7z)
//   W6 the NSIS signing step prepares PowerShell exactly as electron-builder
//      does (pwsh.exe when present; the same NuGet and TrustedSigning setup
//      commands, read from electron-builder itself) and reports the shell's
//      own error text when module setup fails (CI run 43503163673 failed
//      silently in Windows PowerShell)
//   W5 (when Build 209 or later is installed here) the coverage check run on
//      the installed release lists exactly its unsigned files
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = path.resolve(__dirname, "..");
const { classifySignatures, isSignedByAnxOS, listCoveredFiles, readSignatures } = require("./windows-signature-coverage");
const { TRUSTED_SIGNING_SETUP_COMMANDS, listPluginDlls, locateNsisToolsets, prepareSignedNsisToolsets, prepareTrustedSigning, resolvePowerShell, trustedSigningCommand } = require("./sign-nsis-toolsets");

const OURS = { status: "Valid", subject: "CN=Anjo ROSIMO, O=Anjo ROSIMO, L=calgary, S=ab, C=CA", issuer: "CN=Microsoft ID Verified CS AOC CA 03, O=Microsoft Corporation, C=US", timestamped: true };
const MICROSOFT = { status: "Valid", subject: "CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US", issuer: "CN=Microsoft Code Signing PCA 2011, O=Microsoft Corporation", timestamped: true };
const BUILD_209_UNSIGNED = [
  "resources/app.asar.unpacked/node_modules/cpu-features/build/Release/cpufeatures.node",
  "resources/app.asar.unpacked/node_modules/ssh2/lib/protocol/crypto/build/Release/sshcrypto.node",
  "dxcompiler.dll", "ffmpeg.dll", "libEGL.dll", "libGLESv2.dll", "vk_swiftshader.dll", "vulkan-1.dll",
  // The installer runs this to register the Agent's startup task.
  "resources/install-agent-task.ps1",
];
const THIRD_PARTY_SIGNED = ["d3dcompiler_47.dll", "resources/bundled-runtimes/win-x64/java/16/bin/server/jvm.dll", "resources/bundled-runtimes/win-x64/dotnet/8/shared/Microsoft.NETCore.App/8.0.29/coreclr.dll", "resources/bundled-runtimes/win-x64/dotnet/8/shared/Microsoft.NETCore.App/8.0.29/msvcp140_cor3.dll"];

async function main() {
  const signExts = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).build.win.signExts;

  // W1
  for (const file of BUILD_209_UNSIGNED) assert.ok(isSignedByAnxOS(`C:/app/${file}`, { signExts }), `${file} is signed by the release build`);
  for (const file of THIRD_PARTY_SIGNED) assert.ok(!isSignedByAnxOS(`C:/app/${file}`, { signExts }), `${file} keeps its own publisher's signature`);
  assert.ok(isSignedByAnxOS("C:/app/resources/install-agent-task.ps1", { signExts }), "the installer's PowerShell script is signed");
  assert.ok(!signExts.includes(".dll"), "signExts never re-signs every DLL (that would replace Microsoft and Eclipse signatures)");
  console.log(`PASS W1 signExts covers Build 209's ${BUILD_209_UNSIGNED.length} unsigned files (DLLs, native modules, the PowerShell script) and no third-party DLL`);

  // W2
  const options = { signExts, ourExecutables: ["AnxOS Control Center.exe", "elevate.exe"], nsisStageRoot: "C:/dist/.signed-nsis" };
  const results = [
    { file: "C:/app/AnxOS Control Center.exe", ...OURS },
    { file: "C:/app/ffmpeg.dll", ...OURS },
    { file: "C:/app/d3dcompiler_47.dll", ...MICROSOFT },
    { file: "C:/dist/AnxOS-Control-Center-Setup-2.0-build999.exe", ...OURS },
    { file: "C:/dist/.signed-nsis/nsis/Plugins/x86-unicode/nsExec.dll", ...OURS },
  ];
  assert.deepStrictEqual(classifySignatures(results, options), [], "a fully signed release passes");
  const bad = classifySignatures([
    { file: "C:/app/libEGL.dll", status: "NotSigned" },
    { file: "C:/app/vulkan-1.dll", ...MICROSOFT },
    { file: "C:/app/resources/x.node", ...OURS, status: "HashMismatch" },
    { file: "C:/dist/.signed-nsis/nsis-resources/plugins/x86-unicode/nsis7z.dll", status: "NotSigned" },
    { file: "C:/app/resources/bundled-runtimes/jvm.dll", ...MICROSOFT, subject: "CN=Eclipse.org Foundation, Inc." },
    { file: "C:/app/AnxOS Control Center.exe", ...OURS, subject: "CN=Someone Else, O=Someone Else" },
  ], options);
  assert.deepStrictEqual(bad.map((failure) => [path.basename(failure.file), failure.reason.split(":")[0]]), [
    ["libEGL.dll", "signature NotSigned"],
    ["vulkan-1.dll", "UPDATE_INSTALLER_WRONG_PUBLISHER"],
    ["x.node", "signature HashMismatch"],
    ["nsis7z.dll", "signature NotSigned"],
    ["AnxOS Control Center.exe", "UPDATE_INSTALLER_WRONG_PUBLISHER"],
  ]);
  console.log("PASS W2 coverage check: unsigned/broken files fail, third-party signatures stay valid, AnxOS files need the AnxOS publisher");

  // W3
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "anx-nsis-signing-"));
  try {
    const fakeNsis = path.join(temp, "nsis-3.0.4.1");
    const fakeResources = path.join(temp, "nsis-resources-3.4.1");
    for (const [dir, names] of [
      [path.join(fakeNsis, "Plugins", "x86-unicode"), ["nsExec.dll", "System.dll", "nsDialogs.dll"]],
      [path.join(fakeNsis, "Plugins", "x86-ansi"), ["nsExec.dll"]],
      [path.join(fakeNsis, "Bin"), ["makensis.exe"]],
      [path.join(fakeResources, "plugins", "x86-unicode"), ["nsis7z.dll", "UAC.dll", "StdUtils.dll"]],
    ]) {
      fs.mkdirSync(dir, { recursive: true });
      for (const name of names) fs.writeFileSync(path.join(dir, name), `unsigned ${name}`);
    }
    const signedFiles = new Set();
    const stageRoot = path.join(temp, "dist", ".signed-nsis");
    const logs = [];
    const prepared = await prepareSignedNsisToolsets({
      azure: { endpoint: "https://eus.codesigning.azure.net", certificateProfileName: "profile", codeSigningAccountName: "account" },
      stageRoot,
      toolsets: { nsisDir: fakeNsis, resourcesDir: fakeResources },
      sign: (file) => signedFiles.add(file),
      readSignature: (file) => (signedFiles.has(file) ? OURS : { status: "NotSigned" }),
      log: (line) => logs.push(line),
    });
    assert.deepStrictEqual(prepared.env, { ELECTRON_BUILDER_NSIS_DIR: path.join(stageRoot, "nsis"), ELECTRON_BUILDER_NSIS_RESOURCES_DIR: path.join(stageRoot, "nsis-resources") });
    assert.deepStrictEqual(prepared.plugins.map((plugin) => path.basename(plugin.file)).sort(), ["StdUtils.dll", "System.dll", "UAC.dll", "nsDialogs.dll", "nsExec.dll", "nsis7z.dll"], "every x86-unicode plugin, and only those");
    assert.ok(fs.existsSync(path.join(stageRoot, "nsis", "Bin", "makensis.exe")), "the compiler is copied with its plugins");
    assert.strictEqual(fs.readFileSync(path.join(fakeNsis, "Plugins", "x86-unicode", "nsExec.dll"), "utf8"), "unsigned nsExec.dll", "the cached toolset is never modified");
    assert.ok(fs.existsSync(path.join(stageRoot, "signed-plugins.json")));
    assert.match(logs.join("\n"), /Signed and verified 6 NSIS plugin DLL/);
    await assert.rejects(prepareSignedNsisToolsets({
      azure: { endpoint: "e", certificateProfileName: "p", codeSigningAccountName: "a" },
      stageRoot,
      toolsets: { nsisDir: fakeNsis, resourcesDir: fakeResources },
      sign: () => {},
      readSignature: () => ({ status: "NotSigned" }),
      log: () => {},
    }), (error) => error.code === "UPDATE_INSTALLER_UNSIGNED", "a plugin left unsigned stops the build");
    fs.rmSync(path.join(fakeNsis, "Plugins", "x86-unicode", "System.dll"));
    await assert.rejects(prepareSignedNsisToolsets({
      azure: { endpoint: "e", certificateProfileName: "p", codeSigningAccountName: "a" },
      stageRoot, toolsets: { nsisDir: fakeNsis, resourcesDir: fakeResources }, sign: () => {}, readSignature: () => OURS, log: () => {},
    }), /expected plugins/);
    await assert.rejects(prepareSignedNsisToolsets({ azure: null, stageRoot }), /needs the Azure Trusted Signing configuration/);
    const command = trustedSigningCommand({ endpoint: "https://x.codesigning.azure.net", certificateProfileName: "it's", codeSigningAccountName: "acct" }, "C:\\a b\\System.dll");
    assert.match(command, /-CertificateProfileName 'it''s'/);
    assert.match(command, /-Files 'C:\\a b\\System\.dll'/);
    assert.doesNotMatch(command, /SECRET|AZURE_CLIENT/i, "credentials stay in the environment, never in the command");
    console.log("PASS W3 NSIS staging signs and verifies every Unicode plugin, leaves the cache untouched, and fails closed");

    // W4
    let toolsets = null;
    try {
      toolsets = await Promise.race([locateNsisToolsets({}), new Promise((resolve) => setTimeout(() => resolve(null), 60000))]);
    } catch {
      toolsets = null;
    }
    if (toolsets && fs.existsSync(toolsets.nsisDir)) {
      const names = [...listPluginDlls(toolsets.nsisDir), ...listPluginDlls(toolsets.resourcesDir)].map((file) => path.basename(file).toLowerCase());
      for (const required of ["nsexec.dll", "system.dll", "nsis7z.dll", "uac.dll"]) assert.ok(names.includes(required), `${required} is among the plugins to sign`);
      console.log(`PASS W4 electron-builder's real NSIS toolsets: ${names.length} Unicode plugin DLLs to sign, including nsExec, System, nsis7z and UAC`);
    } else {
      console.log("SKIP W4 electron-builder's NSIS toolsets are not cached here");
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }

  // W5
  const installed = path.join(process.env.LOCALAPPDATA || "", "Programs", "AnxOS Control Center");
  if (process.platform === "win32" && fs.existsSync(path.join(installed, "AnxOS Control Center.exe"))) {
    const files = listCoveredFiles([installed]);
    const failures = classifySignatures(readSignatures(files), { signExts, ourExecutables: ["AnxOS Control Center.exe", "elevate.exe"] });
    const unsigned = failures.filter((failure) => /NotSigned/.test(failure.reason)).map((failure) => path.relative(installed, failure.file).replace(/\\/g, "/")).sort();
    const others = failures.filter((failure) => !/NotSigned/.test(failure.reason));
    assert.deepStrictEqual(others, [], `the installed release has no signature failures other than unsigned files (${JSON.stringify(others.slice(0, 3))})`);
    const knownGap = [...BUILD_209_UNSIGNED].sort();
    assert.ok(unsigned.every((file) => knownGap.includes(file)), `unsigned files are the known Build 209 gap (${unsigned.join(", ")})`);
    console.log(`PASS W5 installed release checked (${files.length} files): ${unsigned.length ? `${unsigned.length} unsigned, exactly the known gap a signed Phase 9 build closes` : "fully signed"}`);
  } else {
    console.log("SKIP W5 no installed AnxOS release on this machine");
  }
  // W6
  const ebSource = fs.readFileSync(require.resolve("app-builder-lib/out/codeSign/windowsSignAzureManager.js"), "utf8");
  for (const command of TRUSTED_SIGNING_SETUP_COMMANDS) assert.ok(ebSource.includes(command), `electron-builder runs the same setup: ${command}`);
  const ebVm = fs.readFileSync(require.resolve("app-builder-lib/out/vm/vm.js"), "utf8");
  assert.ok(ebVm.includes("Get-Command pwsh.exe") && ebVm.includes('"pwsh.exe"'), "electron-builder prefers pwsh.exe");
  const calls = [];
  const runner = (outcomes) => (command, args) => { calls.push([command, args[args.length - 1]]); return outcomes.shift() || { status: 0, stdout: "", stderr: "" }; };
  assert.strictEqual(resolvePowerShell(runner([{ status: 0 }])), "pwsh.exe");
  assert.strictEqual(resolvePowerShell(runner([{ status: 1 }])), "powershell.exe");
  calls.length = 0;
  const shell = prepareTrustedSigning(runner([{ status: 0 }, { status: 1, stderr: "NuGet already present" }, { status: 0 }]));
  assert.strictEqual(shell, "pwsh.exe", "a failed NuGet step is tolerated, as electron-builder does");
  assert.deepStrictEqual(calls.map((call) => call[0]), ["powershell.exe", "pwsh.exe", "pwsh.exe"], "probe with Windows PowerShell, then set up in the chosen shell");
  assert.deepStrictEqual(calls.slice(1).map((call) => call[1]), TRUSTED_SIGNING_SETUP_COMMANDS);
  assert.throws(() => prepareTrustedSigning(runner([{ status: 1 }, { status: 0 }, { status: 1, stderr: "Unable to find repository 'PSGallery'" }])), /powershell\.exe failed \(exit 1\): Unable to find repository 'PSGallery'/);
  assert.doesNotMatch(trustedSigningCommand({ endpoint: "e", certificateProfileName: "p", codeSigningAccountName: "a" }, "C:/x.dll"), /Install-Module/, "module setup runs once, not per file");
  console.log("PASS W6 NSIS signing prepares PowerShell exactly as electron-builder does and reports setup errors");

  console.log("Windows signing coverage smoke passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
