const assert = require("assert");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const maintenance = require("../src/services/maintenanceService");

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "anxos-maintenance-"));
  const paths = {
    userData: path.join(root, "userData"),
    cache: path.join(root, "ElectronCache"),
    sessionData: path.join(root, "SessionData"),
    temp: path.join(root, "tmp"),
    diagnosticsDirectory: path.join(root, "logs"),
    configDirectory: path.join(root, "config"),
  };
  try {
    await writeFile(path.join(paths.cache, "cache.bin"), Buffer.alloc(1024));
    await writeFile(path.join(paths.cache, "nested", "entry.bin"), Buffer.alloc(512));
    await writeFile(path.join(root, "outside.txt"), "outside");
    try {
      await fs.symlink(path.join(root, "outside.txt"), path.join(paths.cache, "outside-link"));
    } catch {
      // Some Windows developer environments require elevated symlink privileges.
    }
    await writeFile(path.join(paths.sessionData, "Cookies"), "cookie-data");
    await writeFile(path.join(paths.diagnosticsDirectory, "desktop.log"), "log");
    await writeFile(path.join(paths.diagnosticsDirectory, "desktop.log.1"), "old-log");
    await writeFile(path.join(paths.diagnosticsDirectory, "latest-error.json"), "{}");
    await writeFile(path.join(paths.temp, "AnxHub", "install.tmp"), "temporary");
    await writeFile(path.join(paths.configDirectory, "marketplace-cache", "catalog.json"), "{}");

    const scan = await maintenance.scan(paths);
    assert(scan.categories.some((category) => category.id === "electron-cache"), "scan should include electron-cache.");
    const cache = scan.categories.find((category) => category.id === "electron-cache");
    assert(cache.pathLabel && cache.pathLabel !== "[redacted-path]", "Maintenance operational results must retain their path label value.");
    assert(cache.sizeBytes >= 1536, "electron cache size should be measured from real files.");
    assert.strictEqual(cache.restartRequired, true, "electron cache should require restart.");
    const session = scan.categories.find((category) => category.id === "session-cache");
    assert.strictEqual(session.signsOut, true, "session cache should warn about sign-out.");
    assert.strictEqual(session.confirmationRequired, true, "session cache should require confirmation.");

    await assert.rejects(
      maintenance.clear(["../arbitrary-path"], paths),
      /Maintenance category is not supported/,
      "renderer-style arbitrary paths must be rejected as category IDs.",
    );

    const clearedCache = await maintenance.clear(["electron-cache"], paths);
    assert(clearedCache.reclaimedBytes >= 1536, "cleanup should report verified reclaimed bytes.");
    assert.strictEqual(clearedCache.restartRequired, true, "cleanup result should preserve restart-required state.");
    const cacheResult = clearedCache.results[0];
    assert(["cleared", "partial"].includes(cacheResult.status), "cleanup should be cleared or partial when symlinks are skipped.");
    if (cache.symlinkCount > 0) {
      assert(cacheResult.failures.some((failure) => failure.code === "MAINTENANCE_SYMLINK_SKIPPED"), "symlink cleanup should be reported as skipped.");
      assert.strictEqual(cacheResult.status, "partial", "symlink skip should create a partial cleanup result.");
    }

    const afterCache = await maintenance.scanCategory("electron-cache", paths);
    assert(afterCache.sizeBytes < cache.sizeBytes, "post-cleanup measurement should decrease after removal.");

    const clearedLogs = await maintenance.clear(["logs", "diagnostics-state", "temporary-files", "marketplace-metadata"], paths);
    assert(clearedLogs.results.every((result) => result.verified), "all cleanup results should be verified by measuring after cleanup.");
    assert(clearedLogs.reclaimedBytes > 0, "logs/temp/metadata cleanup should reclaim measured bytes.");

    const notDirectoryPath = path.join(root, "not-directory");
    await fs.writeFile(notDirectoryPath, "file");
    const failed = await maintenance.scanCategory("electron-cache", { ...paths, cache: notDirectoryPath });
    assert.strictEqual(failed.status, "failed", "measurement failure should surface as failed category state.");
    assert(failed.errors.length > 0, "failed measurement should include actionable errors.");

    const definitions = maintenance.getCategoryDefinitions(paths);
    assert(definitions.every((definition) => !String(definition.path).includes("..")), "category paths should be internally resolved definitions.");

    console.log("Maintenance smoke checks passed.");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
