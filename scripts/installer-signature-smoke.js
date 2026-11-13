#!/usr/bin/env node
// Phase 9: a downloaded Windows update installer is opened only when it carries
// a valid Authenticode signature from the AnxOS Control Center publisher.
//   S1 distinguished names are parsed (quoted values, first value wins)
//   S2 the policy accepts only Valid + the pinned publisher + a Microsoft ID
//      Verified CS issuer; unsigned, broken, invalid and foreign signatures
//      are refused with their own codes
//   S3 non-Windows platforms and non-installer files are "not applicable"
//   S4 (Windows) real Get-AuthenticodeSignature results: this Node binary is
//      validly signed by another publisher (refused), a byte-flipped copy of it
//      is HashMismatch (refused), the same program with its signature removed
//      is NotSigned (refused), random bytes are not a program (refused); and, when
//      the installed AnxOS uninstaller is present, its genuine signature passes
//   S5 UpdateManager.install() refuses to hand off an installer whose signature
//      check fails, records why, and never marks the install as handed off
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  TRUSTED_WINDOWS_PUBLISHER,
  evaluateInstallerSignature,
  parseDistinguishedName,
  verifyInstallerSignature,
} = require("../src/shared/installerSignature");

const GENUINE = {
  status: "Valid",
  subject: "CN=Anjo ROSIMO, O=Anjo ROSIMO, L=calgary, S=ab, C=CA",
  issuer: "CN=Microsoft ID Verified CS AOC CA 03, O=Microsoft Corporation, C=US",
  thumbprint: "ABCDEF",
  timestamped: true,
};

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.strictEqual(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected ${code}`);
}

async function expectCodeAsync(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.strictEqual(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return error;
  }
  assert.fail(`expected ${code}`);
}

// Returns a copy of a signed PE file with its Authenticode certificate table
// removed (security data directory zeroed and the blob cut off): a real,
// unsigned Windows program, which Windows reports as NotSigned.
function stripAuthenticode(buffer) {
  const copy = Buffer.from(buffer);
  const peOffset = copy.readUInt32LE(0x3c);
  assert.strictEqual(copy.toString("latin1", peOffset, peOffset + 4), "PE\0\0", "expected a PE file");
  const optionalHeader = peOffset + 24;
  const magic = copy.readUInt16LE(optionalHeader);
  const directories = optionalHeader + (magic === 0x20b ? 112 : 96);
  const security = directories + 4 * 8;
  const certOffset = copy.readUInt32LE(security);
  assert.ok(certOffset > 0, "the source file must be signed");
  copy.writeUInt32LE(0, security);
  copy.writeUInt32LE(0, security + 4);
  return copy.subarray(0, certOffset);
}

async function main() {
  // S1
  assert.deepStrictEqual(parseDistinguishedName(GENUINE.subject), { CN: "Anjo ROSIMO", O: "Anjo ROSIMO", L: "calgary", S: "ab", C: "CA" });
  assert.deepStrictEqual(parseDistinguishedName('CN="Evil, Inc", O=Anjo ROSIMO'), { CN: "Evil, Inc", O: "Anjo ROSIMO" });
  assert.strictEqual(parseDistinguishedName("CN=a, CN=b").CN, "a");
  assert.deepStrictEqual(parseDistinguishedName(null), {});
  console.log("PASS S1 distinguished names parse, including quoted commas");

  // S2
  const ok = evaluateInstallerSignature(GENUINE);
  assert.strictEqual(ok.verified, true);
  assert.strictEqual(ok.publisher, TRUSTED_WINDOWS_PUBLISHER.commonName);
  assert.strictEqual(evaluateInstallerSignature({ ...GENUINE, issuer: "CN=Microsoft ID Verified CS EOC CA 01, O=Microsoft Corporation, C=US" }).verified, true, "a rotated Trusted Signing CA is accepted");
  expectCode(() => evaluateInstallerSignature({ status: "NotSigned" }), "UPDATE_INSTALLER_UNSIGNED");
  expectCode(() => evaluateInstallerSignature({ ...GENUINE, status: "HashMismatch" }), "UPDATE_INSTALLER_SIGNATURE_BROKEN");
  for (const status of ["UnknownError", "NotTrusted", "NotSupportedFileFormat", "Incompatible", "", undefined]) {
    expectCode(() => evaluateInstallerSignature({ ...GENUINE, status }), "UPDATE_INSTALLER_SIGNATURE_INVALID");
  }
  const wrong = expectCode(() => evaluateInstallerSignature({ ...GENUINE, subject: "CN=OpenJS Foundation, O=OpenJS Foundation, C=US" }), "UPDATE_INSTALLER_WRONG_PUBLISHER");
  assert.match(wrong.message, /OpenJS Foundation/);
  expectCode(() => evaluateInstallerSignature({ ...GENUINE, subject: "CN=Anjo ROSIMO, O=Someone Else" }), "UPDATE_INSTALLER_WRONG_PUBLISHER");
  expectCode(() => evaluateInstallerSignature({ ...GENUINE, subject: 'CN="Anjo ROSIMO, O=Anjo ROSIMO", O=Evil' }), "UPDATE_INSTALLER_WRONG_PUBLISHER");
  expectCode(() => evaluateInstallerSignature({ ...GENUINE, issuer: "CN=Self Signed Test CA" }), "UPDATE_INSTALLER_WRONG_PUBLISHER");
  console.log("PASS S2 only a valid signature from the pinned publisher and a Trusted Signing CA passes");

  // S3
  let queried = false;
  const neverQuery = async () => { queried = true; return GENUINE; };
  assert.deepStrictEqual(await verifyInstallerSignature("/tmp/AnxOS.AppImage", { platform: "linux", runSignatureQuery: neverQuery }), { applicable: false, verified: false, reason: "not_windows" });
  assert.strictEqual((await verifyInstallerSignature("C:\\x\\update.zip", { platform: "win32", runSignatureQuery: neverQuery })).reason, "not_a_windows_installer");
  assert.strictEqual(queried, false);
  assert.strictEqual((await verifyInstallerSignature("C:\\x\\Setup.EXE", { platform: "win32", runSignatureQuery: async () => GENUINE })).verified, true);
  console.log("PASS S3 Linux packages and non-installer files are not Authenticode-checked");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-installer-signature-"));
  try {
    // S4
    if (process.platform === "win32") {
      const foreign = await expectCodeAsync(verifyInstallerSignature(process.execPath), "UPDATE_INSTALLER_WRONG_PUBLISHER");
      assert.strictEqual(foreign.details.status, "Valid", "this Node binary is validly signed, by another publisher");
      const tamperedPath = path.join(root, "tampered-node.exe");
      const bytes = fs.readFileSync(process.execPath);
      bytes[Math.floor(bytes.length / 2)] ^= 0x01;
      fs.writeFileSync(tamperedPath, bytes);
      await expectCodeAsync(verifyInstallerSignature(tamperedPath), "UPDATE_INSTALLER_SIGNATURE_BROKEN");
      const unsignedPath = path.join(root, "AnxOS-Control-Center-Setup-unsigned.exe");
      fs.writeFileSync(unsignedPath, stripAuthenticode(fs.readFileSync(process.execPath)));
      await expectCodeAsync(verifyInstallerSignature(unsignedPath), "UPDATE_INSTALLER_UNSIGNED");
      const notAProgramPath = path.join(root, "AnxOS-Control-Center-Setup-garbage.exe");
      fs.writeFileSync(notAProgramPath, crypto.randomBytes(4096));
      await expectCodeAsync(verifyInstallerSignature(notAProgramPath), "UPDATE_INSTALLER_SIGNATURE_INVALID");
      const installedUninstaller = path.join(process.env.LOCALAPPDATA || "", "Programs", "AnxOS Control Center", "Uninstall AnxOS Control Center.exe");
      let genuineNote = "the installed AnxOS uninstaller is not present here (genuine case covered by S2)";
      if (fs.existsSync(installedUninstaller)) {
        const genuine = await verifyInstallerSignature(installedUninstaller);
        assert.strictEqual(genuine.verified, true);
        assert.strictEqual(genuine.publisher, TRUSTED_WINDOWS_PUBLISHER.commonName);
        genuineNote = `the installed AnxOS uninstaller passes (issuer ${genuine.issuer})`;
      }
      console.log(`PASS S4 real signatures: foreign publisher, byte-flipped copy, unsigned program and non-program refused; ${genuineNote}`);
    } else {
      console.log("SKIP S4 real Authenticode checks need Windows");
    }

    // S5
    const { UpdateManager } = require("../src/services/updateManager");
    const manager = new UpdateManager();
    const installerPath = path.join(root, "AnxOS-Control-Center-Setup-2.0-build999.exe");
    const payload = crypto.randomBytes(2048);
    fs.writeFileSync(installerPath, payload);
    manager.state.downloadedPath = installerPath;
    manager.state.status = "downloaded";
    manager.state.latest = { latestReleaseVersion: "2.0", latestBuild: 999, asset: { name: path.basename(installerPath), size: payload.length, sha256: crypto.createHash("sha256").update(payload).digest("hex") } };
    manager.verifyInstallerSignature = (filePath) => verifyInstallerSignature(filePath, {
      platform: "win32",
      runSignatureQuery: async () => ({ ...GENUINE, subject: "CN=Mallory, O=Mallory" }),
    });
    const events = [];
    manager.on("status", (event) => events.push(event.type));
    const result = await manager.install();
    assert.strictEqual(result.installed, false);
    assert.strictEqual(result.code, "UPDATE_INSTALLER_WRONG_PUBLISHER");
    assert.match(result.error, /not opened/);
    assert.strictEqual(manager.state.signature.verified, false);
    assert.strictEqual(manager.state.signature.publisher, "Mallory");
    assert.strictEqual(manager.pendingInstall, null, "a refused installer is never recorded as handed off");
    assert.deepStrictEqual(events, ["install-error"]);
    console.log("PASS S5 install() refuses a foreign-signed installer, records why, and never hands it off");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("Installer signature smoke: 5 checks passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
