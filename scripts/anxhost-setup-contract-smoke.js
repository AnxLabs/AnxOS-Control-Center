#!/usr/bin/env node
"use strict";

// Build 216-D: the contract between AnxHost Setup (windows/setup, Rust), its
// NSIS install engine (windows/installer.nsh), the packaging script and the
// app's updater. Runs anywhere (no Rust needed); `cargo test` in
// windows/setup covers the Rust side on Windows.
//   S1 the registry GUID Setup reads is electron-builder's UUID v5 of the
//      frozen appId, and the frozen names (folder, exe, uninstaller) match
//   S2 Setup pins the same publisher as the app's updater
//   S3 every status line installer.nsh writes is one Setup parses, in order
//   S4 the uninstall handoff only runs for interactive, non-update uninstalls,
//      and the engine never rewrites its own uninstall entry
//   S5 the engine format written by the packaging script is read back by the
//      same rule as Setup's (also behind a certificate table and padding)
//   S6 latest.yml is rewritten for Setup's own SHA-512 and size
//   S7 the updater of an installed build picks Setup, and never the engine
//   S8 the uninstall copy is added to the app's resources only when built

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), "utf8");
const pkg = JSON.parse(read("package.json"));
const detectRs = read("windows", "setup", "src", "detect.rs");
const engineRs = read("windows", "setup", "src", "engine.rs");
const nsh = read("windows", "installer.nsh");
const setup = require("./build-anxhost-setup");

const results = [];
function check(label, fn) {
  try {
    fn();
    results.push(`PASS ${label}`);
  } catch (error) {
    results.push(`FAIL ${label}\n  ${error.stack || error}`);
  }
}
const rustConst = (source, name) => new RegExp(`const ${name}: &str = "([^"]*)"`).exec(source)?.[1];

check("S1 registry GUID and frozen names", () => {
  const guid = rustConst(detectRs, "APP_GUID");
  assert.strictEqual(pkg.build.appId, "com.anxos.controlcenter", "appId is frozen");
  try {
    const { UUID } = require("builder-util-runtime");
    assert.strictEqual(guid, UUID.v5(pkg.build.appId, UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3")), "GUID = electron-builder's UUID v5 of the appId");
  } catch (error) {
    if (error.code !== "MODULE_NOT_FOUND") throw error;
    assert.strictEqual(guid, "3f8b9dfa-3a76-52ec-8ba9-f2ea082d6457");
  }
  assert.strictEqual(rustConst(detectRs, "APP_FOLDER_NAME"), pkg.build.productName);
  assert.strictEqual(rustConst(detectRs, "APP_EXE"), `${pkg.build.productName}.exe`);
  assert.strictEqual(rustConst(detectRs, "UNINSTALLER_EXE"), `Uninstall ${pkg.build.productName}.exe`);
});

check("S2 the same publisher pin as the updater", () => {
  const signature = read("src", "shared", "installerSignature.js");
  const cn = /commonName: "([^"]+)"/.exec(signature)[1];
  const issuer = /issuerCommonNamePrefix: "([^"]+)"/.exec(signature)[1];
  assert.strictEqual(rustConst(engineRs, "PUBLISHER_CN"), cn);
  assert.strictEqual(rustConst(engineRs, "ISSUER_CN_PREFIX"), issuer);
  assert.strictEqual(setup.TRUSTED_PUBLISHER_CN, cn);
});

check("S3 status lines written and parsed", () => {
  const written = [...nsh.matchAll(/anxStatus "([a-z-]+)/g)].map((m) => m[1]);
  assert.deepStrictEqual([...new Set(written)].sort(), ["done", "extracted", "helper", "helper-begin", "helper-skipped", "plugins", "registered", "start"]);
  for (const word of written) assert(new RegExp(`"${word}"(\\s+if [^=]*)?\\s*=>`).test(engineRs), `engine.rs parses "${word}"`);
  assert(/customFiles_x64[\s\S]{0,80}anxStatus "extracted"/.test(nsh), "extracted is reported after the files are in place");
  assert(/\$\{GetOptions\} \$R0 "\/ANXSTATUS=" \$R1/.test(nsh), "the status file comes from /ANXSTATUS=");
  // electron-builder calls customInit before InitPluginsDir: the "plugins"
  // line must not depend on an earlier plugin call having created it.
  const init = /!macro customInit([\s\S]*?)!macroend/.exec(nsh)?.[1] || "";
  assert(/InitPluginsDir[\s\S]*anxStatus "plugins \$PLUGINSDIR"/.test(init), "customInit initialises $PLUGINSDIR before reporting it");
  assert(/"plugins" if !rest\.is_empty\(\)/.test(engineRs), "an empty plugins line is not taken as a folder");
});

check("S4 uninstall handoff is interactive-only; the uninstall entry is untouched", () => {
  const unInit = /!macro customUnInit([\s\S]*?)!macroend/.exec(nsh)?.[1] || "";
  assert(/\$\{IfNot\} \$\{Silent\}/.test(unInit) && /\$\{AndIfNot\} \$\{isUpdated\}/.test(unInit), "never for /S or --updated");
  assert(/\/ANXNOHANDOFF/.test(unInit), "Setup's fallback can keep the NSIS pages");
  assert(/resources\\AnxHost Setup\.exe" --uninstall/.test(unInit), "hands off to the uninstall copy");
  assert(!/UninstallString/.test(nsh), "the engine never rewrites UninstallString (upgrades run it with /S --updated)");
  assert(/--uninstall/.test(read("windows", "setup", "src", "main.rs")));
});

check("S5 engine format: written by the script, read by Setup's rule", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anxhost-setup-contract-"));
  try {
    assert.strictEqual(new RegExp(`PAYLOAD_MAGIC: &\\[u8; 16\\] = b"${setup.PAYLOAD_MAGIC.toString("ascii")}"`).test(engineRs), true, "same magic in Rust and JS");
    const exe = path.join(dir, "setup.exe");
    // A minimal PE32+ header with an empty security directory.
    const header = Buffer.alloc(1024);
    header.write("MZ", 0, "latin1");
    header.writeUInt32LE(0x80, 0x3c);
    header.write("PE\0\0", 0x80, "latin1");
    header.writeUInt16LE(0x20b, 0x80 + 24);
    fs.writeFileSync(exe, Buffer.concat([header, Buffer.alloc(3)]));
    const engine = path.join(dir, "engine.exe");
    fs.writeFileSync(engine, Buffer.from("MZ" + "e".repeat(5000)));
    setup.appendPayload(exe, engine);
    const range = setup.payloadRange(exe);
    assert.deepStrictEqual(range && range.size, 5002);
    assert.strictEqual(fs.statSync(exe).size % 8, 0, "footer ends on 8 bytes, so signing adds no padding");
    const bytes = fs.readFileSync(exe);
    assert.strictEqual(bytes.subarray(range.offset, range.offset + range.size).toString("latin1"), "MZ" + "e".repeat(5000));
    // Signed: a certificate table follows and the header names it.
    const certAt = bytes.length;
    const signed = Buffer.concat([bytes, Buffer.alloc(64, 0xa5)]);
    signed.writeUInt32LE(certAt, 0x80 + 24 + 112 + 32);
    signed.writeUInt32LE(64, 0x80 + 24 + 112 + 36);
    fs.writeFileSync(exe, signed);
    assert.deepStrictEqual(setup.payloadRange(exe), range, "found before the certificate table");
    fs.writeFileSync(exe, header);
    assert.strictEqual(setup.payloadRange(exe), null, "a program without an engine has none");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("S6 latest.yml names Setup's own digest and size", () => {
  const before = "version: 2.0.0\nfiles:\n  - url: AnxOS-Control-Center-Setup-2.0-build216.exe\n    sha512: OLD==\n    size: 440255496\npath: AnxOS-Control-Center-Setup-2.0-build216.exe\nsha512: OLD==\nreleaseDate: '2026-11-26T00:00:00.000Z'";
  const after = setup.rewriteLatestYml(before, "AnxOS-Control-Center-Setup-2.0-build216.exe", { sha512: "NEW==", size: 441000000 });
  assert(!after.includes("OLD=="), after);
  assert.strictEqual((after.match(/sha512: NEW==/g) || []).length, 2);
  assert(after.includes("size: 441000000"));
  assert(after.includes("path: AnxOS-Control-Center-Setup-2.0-build216.exe"), "the file name is unchanged");
});

check("S7 an installed build's updater picks Setup, never the engine", () => {
  const { pickUpdateAsset } = require("../src/services/updateManager");
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  const archReal = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { ...real, value: "win32" });
  Object.defineProperty(process, "arch", { ...archReal, value: "x64" });
  try {
    const v = "2.0-build216";
    const asset = (name, size = 400 * 1048576) => ({ name, size, browser_download_url: `https://example.invalid/${name}` });
    const published = [asset(`AnxOS-Control-Center-${v}-portable.exe`), asset(setup.setupName(v)), asset(`${setup.setupName(v)}.blockmap`, 600000), asset("latest.yml", 400)];
    assert.strictEqual(pickUpdateAsset({ assets: published })?.name, setup.setupName(v));
    assert(!/setup|installer/i.test(setup.engineName(v)), "the engine's name matches none of the updater's installer rules");
  } finally {
    Object.defineProperty(process, "platform", real);
    Object.defineProperty(process, "arch", archReal);
  }
});

check("S8 the uninstall copy goes into the app's resources only when built", () => {
  const configPath = require.resolve("./electron-builder-config");
  const load = (env) => {
    const previous = process.env.ANXHOST_SETUP_MAINTENANCE_EXE;
    if (env) process.env.ANXHOST_SETUP_MAINTENANCE_EXE = env; else delete process.env.ANXHOST_SETUP_MAINTENANCE_EXE;
    delete require.cache[configPath];
    try {
      return require(configPath);
    } finally {
      if (previous === undefined) delete process.env.ANXHOST_SETUP_MAINTENANCE_EXE; else process.env.ANXHOST_SETUP_MAINTENANCE_EXE = previous;
      delete require.cache[configPath];
    }
  };
  assert(!(load(null).win.extraResources || []).some((r) => (r.filter || []).includes("AnxHost Setup.exe")), "absent when not built");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anxhost-setup-maint-"));
  try {
    const exe = path.join(dir, "AnxHost Setup.exe");
    fs.writeFileSync(exe, "MZ");
    const entry = (load(exe).win.extraResources || []).find((r) => (r.filter || []).includes("AnxHost Setup.exe"));
    assert(entry && entry.to === "." && entry.from === dir, "copied to resources\\AnxHost Setup.exe");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("S9 the Rust sources and build output never go into the app", () => {
  // RC1's first build packed windows/setup/target (about 97 MB) into the app
  // through "windows/**/*". The last matching pattern decides, as in
  // electron-builder.
  const { minimatch } = require("minimatch");
  const patterns = pkg.build.files.filter((entry) => typeof entry === "string");
  const packed = (file) => patterns.reduce((included, pattern) => {
    const negated = pattern.startsWith("!");
    return minimatch(file, negated ? pattern.slice(1) : pattern, { dot: true }) ? !negated : included;
  }, false);
  for (const file of ["windows/setup/target/release/anxhost-setup.exe", "windows/setup/target/release/deps/wry.rlib", "windows/setup/src/main.rs", "windows/setup/Cargo.toml"]) {
    assert(!packed(file), `${file} must not be packed into the app`);
  }
  assert(packed("windows/installer.nsh") && packed("windows/install-agent-task.ps1"), "the other windows/ files are still packed");
});

check("S10 Setup starts on a clean Windows (no Visual C++ runtime needed)", () => {
  // RC1's Setup imported vcruntime140.dll and could not start in a clean
  // Windows Sandbox ("System Error" before any window).
  const config = read("windows", "setup", ".cargo", "config.toml");
  assert(/\[target\.x86_64-pc-windows-msvc\][\s\S]*target-feature=\+crt-static/.test(config), ".cargo/config.toml links the C runtime statically");
  assert(/STATIC_CRT_FLAG = "-C target-feature=\+crt-static"/.test(read("scripts", "build-anxhost-setup.js")), "the packaging build passes the flag even when RUSTFLAGS is set");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anxhost-setup-crt-"));
  try {
    const dynamic = path.join(dir, "dynamic.exe");
    fs.writeFileSync(dynamic, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64), Buffer.from("VCRUNTIME140.dll\0KERNEL32.dll\0")]));
    assert.throws(() => setup.assertNoVcRuntimeImport(dynamic), /vcruntime140\.dll/, "a Setup importing the VC runtime is refused");
    const staticExe = path.join(dir, "static.exe");
    fs.writeFileSync(staticExe, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64), Buffer.from("KERNEL32.dll\0USER32.dll\0")]));
    setup.assertNoVcRuntimeImport(staticExe);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check("S11 the engine and the uninstaller get NSIS's raw command line", () => {
  // RC1 Sandbox: Command::args quoted "/D=...\AnxOS Control Center", so NSIS
  // ignored the folder and never read /ANXSTATUS= (no progress was reported).
  const engineSrc = read("windows", "setup", "src", "engine.rs");
  assert(/pub fn nsis_command[\s\S]{0,200}command\.raw_arg\(arg\)/.test(engineSrc), "nsis_command passes each argument raw");
  for (const [file, src] of [["engine.rs", engineSrc], ["uninstall.rs", read("windows", "setup", "src", "uninstall.rs")], ["ui.rs", read("windows", "setup", "src", "ui.rs")]]) {
    assert(!/Command::new\((engine|&prepared\.exe|&uninstaller)\)/.test(src), `${file} starts NSIS through nsis_command`);
  }
  assert(/fn nsis_args_reach_the_program_unquoted/.test(engineSrc), "cargo test covers a path with spaces");
});

check("S12 Setup starts no visible console window", () => {
  // RC1 Sandbox: the cleanup after Setup closed used DETACHED_PROCESS, which
  // makes Windows ignore CREATE_NO_WINDOW, so ping opened a console window.
  for (const name of ["shell.rs", "engine.rs", "uninstall.rs", "apps.rs", "ui.rs"]) {
    const src = read("windows", "setup", "src", name);
    assert(!/creation_flags\([^)]*(DETACHED_PROCESS|0x0000_0008|0x00000008|0x8\b)/.test(src), `${name} does not start a process with DETACHED_PROCESS`);
  }
  const shell = read("windows", "setup", "src", "shell.rs");
  assert(/Command::new\("cmd\.exe"\)[\s\S]{0,120}\.creation_flags\(CREATE_NO_WINDOW\)/.test(shell), "the cleanup runs cmd with CREATE_NO_WINDOW");
});

check("S13 the engine never shows NSIS's verifying window", () => {
  // RC2 Sandbox (slow disk): the silent engine's own CRC pass showed
  // "verifying installer: N%" windows. Setup verifies the engine's SHA-256
  // and signature before running it, so the engine runs with /NCRC, and the
  // installer must not force the check.
  const engineSrc = read("windows", "setup", "src", "engine.rs");
  assert(/let mut args = vec!\["\/S"\.to_string\(\), "\/NCRC"\.to_string\(\)\]/.test(engineSrc), "silent and interactive Setup runs pass /NCRC");
  assert(/let mut args = vec!\["\/NCRC"\.to_string\(\)\]/.test(read("windows", "setup", "src", "ui.rs")), "the WebView2 fallback passes /NCRC");
  assert(!/^\s*CRCCheck\s+force/im.test(nsh), "installer.nsh does not force the CRC check (/NCRC would be ignored)");
});

for (const line of results) console.log(line);
const failed = results.filter((line) => line.startsWith("FAIL")).length;
if (failed) {
  console.log(`anxhost-setup-contract-smoke: ${failed} of ${results.length} checks failed`);
  process.exit(1);
}
console.log(`anxhost-setup-contract-smoke passed (${results.length} checks)`);
