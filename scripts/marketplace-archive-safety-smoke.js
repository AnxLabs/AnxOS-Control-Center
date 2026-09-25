const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Pin runtime roots before service modules load (eb13b83 job-store leak lesson).
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-marketplace-archive-safety-");

const marketplace = require("../src/services/marketplaceInstallService")._test;
const marketplaceService = require("../src/services/marketplaceService")._test;

for (const unsafePath of ["/etc/passwd", "C:\\Windows\\system.ini", "../outside", "folder/../../outside"]) {
  assert.throws(() => marketplace.safeArchivePath(unsafePath), (error) => error?.code === "ARCHIVE_PATH_UNSAFE", `Archive path must be rejected: ${unsafePath}`);
}
assert.strictEqual(marketplace.safeArchivePath("config/server.toml"), "config/server.toml");

assert.throws(
  () => marketplace.validateZipDirectory({ files: [{ path: "huge.bin", type: "File", compressedSize: 1024, uncompressedSize: 9 * 1024 * 1024 * 1024 }] }),
  (error) => error?.code === "ARCHIVE_LIMIT_EXCEEDED",
  "Oversized expanded entries must be rejected before extraction.",
);
assert.throws(
  () => marketplace.validateZipDirectory({ files: [{ path: "bomb.bin", type: "File", compressedSize: 1024, uncompressedSize: 32 * 1024 * 1024 }] }),
  (error) => error?.code === "ARCHIVE_COMPRESSION_UNSAFE",
  "Unsafe compression ratios must be rejected before extraction.",
);

// ---------------------------------------------------------------------------
// Installer path containment, driven through the REAL marketplaceService
// builders. Regression: installer.archive, installer.extractDir and
// additionalArchives[].archive/extractDir land inside tar/unzip/PowerShell
// commands that run in the instance directory, so absolute paths, ".."
// segments and drive/scheme ":" must be refused before any script is built,
// while the relative paths the shipped catalog uses must keep building.
// ---------------------------------------------------------------------------
const INSTALLER_BUILDERS = [
  ["linux", marketplaceService.buildArchiveInstallerScript],
  ["windows", marketplaceService.buildWindowsArchiveInstallerScript],
];

function assertInstallerRejected(build, installer, label) {
  assert.throws(
    () => build(installer),
    (error) => {
      assert.strictEqual(error?.code, "INVALID_TEMPLATE_CATALOG", `${label} must fail with INVALID_TEMPLATE_CATALOG, saw ${error?.code}`);
      return true;
    },
    `${label} must be rejected`,
  );
}

// Unsafe installer.archive values on both platforms. The safety assertion runs
// before the archive-type check, so non-zip values still refuse on containment.
for (const archive of ["../../outside", "../../outside.tar.gz", "/etc/passwd", "C:\\Windows\\x.zip", "nested/../evil.tar.gz"]) {
  for (const [platform, build] of INSTALLER_BUILDERS) {
    assertInstallerRejected(build, { archive, extractDir: "server" }, `${platform} installer.archive ${archive}`);
  }
}

// Unsafe installer.extractDir values use a legitimate archive per platform.
for (const extractDir of ["../../outside", "/etc/passwd", "C:\\Windows\\x", "nested/../evil"]) {
  assertInstallerRejected(marketplaceService.buildArchiveInstallerScript, { archive: "server/pack.tar.gz", extractDir }, `linux installer.extractDir ${extractDir}`);
  assertInstallerRejected(marketplaceService.buildWindowsArchiveInstallerScript, { archive: "tshock.zip", extractDir }, `windows installer.extractDir ${extractDir}`);
}

// Unsafe additionalArchives entries on both platforms.
assertInstallerRejected(marketplaceService.buildArchiveInstallerScript, {
  archive: "server/pack.tar.gz",
  extractDir: "server",
  additionalArchives: [{ archive: "../../outside.tar.gz", extractDir: "server/resources", stripComponents: 0 }],
}, "linux additionalArchives archive traversal");
assertInstallerRejected(marketplaceService.buildArchiveInstallerScript, {
  archive: "server/pack.tar.gz",
  extractDir: "server",
  additionalArchives: [{ archive: "cfx-server-data.tar.gz", extractDir: "../outside", stripComponents: 0 }],
}, "linux additionalArchives extractDir traversal");
assertInstallerRejected(marketplaceService.buildWindowsArchiveInstallerScript, {
  archive: "tshock.zip",
  extractDir: "server",
  additionalArchives: [{ archive: "C:\\Windows\\x.zip", extractDir: "server/resources", stripComponents: 0 }],
}, "windows additionalArchives archive drive path");
assertInstallerRejected(marketplaceService.buildWindowsArchiveInstallerScript, {
  archive: "tshock.zip",
  extractDir: "server",
  additionalArchives: [{ archive: "pack.zip", extractDir: "..\\outside", stripComponents: 0 }],
}, "windows additionalArchives extractDir traversal");

// C0 control characters (including \n, \r, \t and NUL) are interpolated into the
// generated installer script's comment/command lines, so a newline in a catalog
// path could inject a command. They must be refused by the same containment
// check on every builder before any script text is produced.
const CONTROL_CHARACTER_PATHS = ["pack\n.tar.gz", "pack\r.zip", "pack\t.tar.xz", "pack\u0000.zip"];
for (const archive of CONTROL_CHARACTER_PATHS) {
  for (const [platform, build] of INSTALLER_BUILDERS) {
    assertInstallerRejected(build, { archive, extractDir: "server" }, `${platform} installer.archive control characters ${JSON.stringify(archive)}`);
  }
}
for (const extractDir of CONTROL_CHARACTER_PATHS) {
  assertInstallerRejected(marketplaceService.buildArchiveInstallerScript, { archive: "server/pack.tar.gz", extractDir }, `linux installer.extractDir control characters ${JSON.stringify(extractDir)}`);
  assertInstallerRejected(marketplaceService.buildWindowsArchiveInstallerScript, { archive: "tshock.zip", extractDir }, `windows installer.extractDir control characters ${JSON.stringify(extractDir)}`);
}
assertInstallerRejected(marketplaceService.buildArchiveInstallerScript, {
  archive: "server/pack.tar.gz",
  extractDir: "server",
  additionalArchives: [{ archive: "cfx\n-server-data.tar.gz", extractDir: "server/resources", stripComponents: 0 }],
}, "linux additionalArchives archive control characters");
assertInstallerRejected(marketplaceService.buildArchiveInstallerScript, {
  archive: "server/pack.tar.gz",
  extractDir: "server",
  additionalArchives: [{ archive: "cfx-server-data.tar.gz", extractDir: "server/resources\nrm -rf outside", stripComponents: 0 }],
}, "linux additionalArchives extractDir control characters");
assertInstallerRejected(marketplaceService.buildWindowsArchiveInstallerScript, {
  archive: "tshock.zip",
  extractDir: "server",
  additionalArchives: [{ archive: "pack\n.zip", extractDir: "server/resources", stripComponents: 0 }],
}, "windows additionalArchives archive control characters");
assertInstallerRejected(marketplaceService.buildWindowsArchiveInstallerScript, {
  archive: "tshock.zip",
  extractDir: "server",
  additionalArchives: [{ archive: "pack.zip", extractDir: "server\nresources", stripComponents: 0 }],
}, "windows additionalArchives extractDir control characters");

// Legitimate relative paths keep building on both platforms.
const linuxArchive = marketplaceService.buildArchiveInstallerScript({ archive: "server/pack.tar.gz", extractDir: "server/resources" });
assert(linuxArchive.includes("EXTRACT_DIR='server/resources'"), "The linux builder must accept a nested relative extractDir.");
assert(linuxArchive.includes("tar -xzf 'server/pack.tar.gz'"), "The linux builder must accept the relative archive path.");
const linuxWithAdditional = marketplaceService.buildArchiveInstallerScript({
  archive: "server/pack.tar.gz",
  extractDir: "server",
  additionalArchives: [{ archive: "cfx-server-data.tar.gz", extractDir: "server/resources", stripComponents: 2 }],
});
assert(linuxWithAdditional.includes("cfx-server-data.tar.gz"), "The linux builder must accept the relative additional archive.");
assert(linuxWithAdditional.includes("'server/resources'"), "The linux builder must accept the relative additional extractDir.");
const windowsArchive = marketplaceService.buildWindowsArchiveInstallerScript({ archive: "tshock.zip", extractDir: "server" });
assert(windowsArchive.includes("$archivePath = 'tshock.zip'"), "The windows builder must accept the relative zip archive.");
assert(windowsArchive.includes("Expand-Archive -Path $archivePath -DestinationPath $extractDir -Force"), "The windows builder must still expand the accepted zip.");

// The whole shipped catalog still validates, and every template installer with
// declared paths still builds through the real dispatcher.
const shippedCatalog = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "config", "marketplace-templates.json"), "utf8"));
const catalogResult = marketplaceService.validateMarketplaceCatalog(shippedCatalog);
assert.strictEqual(catalogResult.valid, true, `The shipped catalog must validate: ${catalogResult.errors.map((entry) => `${entry.templateId}: ${entry.message}`).join(" | ")}`);
let shippedInstallersBuilt = 0;
for (const template of shippedCatalog) {
  if (!template.installer) continue;
  assert.doesNotThrow(() => marketplaceService.buildTemplateInstallerScript(template), `The installer of shipped template ${template.id} must still build.`);
  shippedInstallersBuilt += 1;
}
assert.strictEqual(shippedInstallersBuilt, 6, `The shipped catalog is expected to carry 6 installer templates, saw ${shippedInstallersBuilt}`);

async function main() {
  let canceled = false;
  const oversizedHeaderResponse = {
    headers: { get: () => String(1024) },
    body: { cancel: async () => { canceled = true; } },
  };
  await assert.rejects(
    () => marketplace.readBoundedResponseBuffer(oversizedHeaderResponse, { label: "Test", maxBytes: 128 }),
    (error) => error?.code === "DOWNLOAD_TOO_LARGE",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.strictEqual(canceled, true, "Oversized declared downloads must cancel the response body.");

  let streamCanceled = false;
  let reads = 0;
  const reader = {
    read: async () => (++reads === 1 ? { done: false, value: Buffer.alloc(80) } : { done: false, value: Buffer.alloc(80) }),
    cancel: async () => { streamCanceled = true; },
    releaseLock: () => {},
  };
  await assert.rejects(
    () => marketplace.readBoundedResponseBuffer({ headers: { get: () => null }, body: { getReader: () => reader } }, { label: "Test", maxBytes: 128 }),
    (error) => error?.code === "DOWNLOAD_TOO_LARGE" && error?.details?.receivedBytes === 160,
  );
  assert.strictEqual(streamCanceled, true, "Downloads crossing the runtime limit must cancel their reader.");
  const controller = new AbortController();
  let abortedReaderCanceled = false;
  const abortingReader = {
    read: async () => {
      controller.abort();
      return { done: false, value: Buffer.alloc(8) };
    },
    cancel: async () => { abortedReaderCanceled = true; },
    releaseLock: () => {},
  };
  await assert.rejects(
    () => marketplace.readBoundedResponseBuffer(
      { headers: { get: () => null }, body: { getReader: () => abortingReader } },
      { label: "Test", maxBytes: 128, signal: controller.signal },
    ),
    (error) => error?.code === "INSTALL_CANCELLED",
  );
  assert.strictEqual(abortedReaderCanceled, true, "Aborted downloads must cancel their response reader.");
  console.log("Marketplace archive and download safety smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
