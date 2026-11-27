const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { app, session } = require("electron");
const diagnostics = require("./diagnosticsService");
const { sanitize } = require("../shared/redaction");

const MAX_SCAN_ENTRIES = 25000;
const MAX_SCAN_DEPTH = 16;
const cleanupLocks = new Set();
let lastCleanupTimes = new Map();

function nowIso() {
  return new Date().toISOString();
}

function getAppPath(name, fallback = "") {
  try {
    return app.getPath(name);
  } catch {
    return fallback;
  }
}

function safePathLabel(filePath) {
  const resolved = path.resolve(String(filePath || ""));
  const home = os.homedir();
  return home && resolved.startsWith(home)
    ? resolved.replace(home, "~")
    : resolved;
}

function getConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) return process.env.ANXHUB_CONFIG_DIR;
  return path.join(getAppPath("userData", process.cwd()), "config");
}

function getCategoryDefinitions(options = {}) {
  const userData = options.userData || getAppPath("userData", process.cwd());
  const cache = options.cache || getAppPath("cache", path.join(userData, "ElectronCache"));
  const sessionData = options.sessionData || (() => {
    try { return app.getPath("sessionData"); } catch { return path.join(path.dirname(cache), "SessionData"); }
  })();
  const temp = options.temp || getAppPath("temp", os.tmpdir());
  const diagnosticsDirectory = options.diagnosticsDirectory || diagnostics.getDirectory();
  const configDirectory = options.configDirectory || getConfigDirectory();
  return [
    {
      id: "electron-cache",
      displayName: "Electron Cache",
      description: "Chromium disk cache used by the desktop shell.",
      path: cache,
      cleanup: "contents",
      restartRequired: true,
      signsOut: false,
      downloadsAgain: true,
      inUse: true,
      clearSessionCache: true,
    },
    {
      id: "media-cache",
      displayName: "Media Cache",
      description: "Chromium media cache for images and streamed assets.",
      path: path.join(path.dirname(cache), "MediaCache"),
      cleanup: "contents",
      restartRequired: false,
      signsOut: false,
      downloadsAgain: true,
      inUse: false,
    },
    {
      id: "session-cache",
      displayName: "Session Cache",
      description: "Electron session storage, cookies, and temporary web data.",
      path: sessionData,
      cleanup: "contents",
      restartRequired: true,
      signsOut: true,
      downloadsAgain: true,
      inUse: true,
      confirmationRequired: true,
    },
    {
      id: "logs",
      displayName: "Structured Logs",
      description: "Desktop diagnostic log files. New logs are created automatically.",
      path: diagnosticsDirectory,
      cleanup: "patterns",
      patterns: [/\.log(?:\.\d+)?$/i],
      restartRequired: false,
      signsOut: false,
      downloadsAgain: false,
      inUse: true,
    },
    {
      id: "diagnostics-state",
      displayName: "Diagnostics State",
      description: "Latest error snapshots, runtime state snapshots, and old exported diagnostic bundles stored in the diagnostics folder.",
      path: diagnosticsDirectory,
      cleanup: "patterns",
      patterns: [/^(latest-error|runtime-state)\.json$/i, /^anxos-diagnostics-.*\.json$/i],
      restartRequired: false,
      signsOut: false,
      downloadsAgain: false,
      inUse: false,
    },
    {
      id: "temporary-files",
      displayName: "Temporary Files",
      description: "AnxHost-owned temporary files under the operating system temp directory.",
      path: path.join(temp, "AnxHub"),
      cleanup: "contents",
      restartRequired: false,
      signsOut: false,
      downloadsAgain: false,
      inUse: false,
    },
    {
      id: "marketplace-metadata",
      displayName: "Marketplace Metadata Cache",
      description: "Non-secret Marketplace metadata cache. API keys and installed instances are not removed.",
      path: path.join(configDirectory, "marketplace-cache"),
      cleanup: "contents",
      restartRequired: false,
      signsOut: false,
      downloadsAgain: true,
      inUse: false,
    },
  ];
}

function categoryMap(options = {}) {
  return new Map(getCategoryDefinitions(options).map((definition) => [definition.id, definition]));
}

function getCategoryOrThrow(categoryId, options = {}) {
  const id = String(categoryId || "");
  const definition = categoryMap(options).get(id);
  if (!definition) {
    const error = new Error("Maintenance category is not supported.");
    error.code = "MAINTENANCE_CATEGORY_NOT_SUPPORTED";
    throw error;
  }
  return definition;
}

function assertSafeCategoryPath(definition) {
  const root = path.resolve(definition.path || "");
  if (!root || root === path.parse(root).root) {
    const error = new Error("Maintenance category path is unsafe.");
    error.code = "MAINTENANCE_UNSAFE_PATH";
    throw error;
  }
  return root;
}

async function pathExists(filePath) {
  try {
    await fsp.lstat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function assertCategoryDirectory(root) {
  try {
    const stat = await fsp.lstat(root);
    if (stat.isSymbolicLink()) {
      const error = new Error("Maintenance category root cannot be a symlink.");
      error.code = "MAINTENANCE_ROOT_SYMLINK";
      throw error;
    }
    if (!stat.isDirectory()) {
      const error = new Error("Maintenance category root is not a directory.");
      error.code = "MAINTENANCE_ROOT_NOT_DIRECTORY";
      throw error;
    }
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
}

async function measurePath(root, options = {}) {
  const startedAt = Date.now();
  const result = {
    bytes: 0,
    files: 0,
    directories: 0,
    symlinks: 0,
    skipped: 0,
    errors: [],
    truncated: false,
    measuredAt: nowIso(),
    durationMs: 0,
  };
  const maxEntries = options.maxEntries || MAX_SCAN_ENTRIES;

  async function walk(target, depth) {
    if (result.files + result.directories + result.symlinks >= maxEntries) {
      result.truncated = true;
      return;
    }
    if (depth > (options.maxDepth || MAX_SCAN_DEPTH)) {
      result.skipped += 1;
      result.truncated = true;
      return;
    }
    let stat;
    try {
      stat = await fsp.lstat(target);
    } catch (error) {
      result.errors.push({ code: error.code || "STAT_FAILED", path: safePathLabel(target), message: error.message });
      return;
    }
    if (stat.isSymbolicLink()) {
      result.symlinks += 1;
      result.skipped += 1;
      return;
    }
    if (stat.isDirectory()) {
      result.directories += 1;
      let entries;
      try {
        entries = await fsp.readdir(target);
      } catch (error) {
        result.errors.push({ code: error.code || "READDIR_FAILED", path: safePathLabel(target), message: error.message });
        return;
      }
      for (const entry of entries) {
        await walk(path.join(target, entry), depth + 1);
      }
      return;
    }
    result.files += 1;
    result.bytes += stat.size;
  }

  if (await pathExists(root)) {
    await walk(root, 0);
  }
  result.durationMs = Date.now() - startedAt;
  return result;
}

function matchesPatterns(name, patterns = []) {
  return patterns.some((pattern) => pattern.test(name));
}

async function removeEntry(target) {
  const stat = await fsp.lstat(target);
  if (stat.isSymbolicLink()) {
    const error = new Error("Symlink skipped during maintenance cleanup.");
    error.code = "MAINTENANCE_SYMLINK_SKIPPED";
    throw error;
  }
  await fsp.rm(target, { recursive: true, force: true, maxRetries: 1 });
}

async function clearCategory(definition) {
  const root = assertSafeCategoryPath(definition);
  const result = {
    removedEntries: 0,
    skippedEntries: 0,
    failures: [],
  };
  try {
    await fsp.mkdir(root, { recursive: true });
    const entries = await fsp.readdir(root);
    for (const entry of entries) {
      if (definition.cleanup === "patterns" && !matchesPatterns(entry, definition.patterns)) {
        continue;
      }
      const target = path.join(root, entry);
      try {
        await removeEntry(target);
        result.removedEntries += 1;
      } catch (error) {
        result.skippedEntries += 1;
        result.failures.push({ code: error.code || "REMOVE_FAILED", path: safePathLabel(target), message: error.message });
      }
    }
  } catch (error) {
    result.failures.push({ code: error.code || "CLEANUP_FAILED", path: safePathLabel(root), message: error.message });
  }
  return result;
}

function categoryStatus(definition, measurement) {
  if (measurement.errors.length > 0) return "failed";
  if (measurement.bytes === 0 && measurement.files === 0 && measurement.directories <= 1) return "empty";
  return "available";
}

async function scanCategory(categoryId, options = {}) {
  const definition = getCategoryOrThrow(categoryId, options);
  const root = assertSafeCategoryPath(definition);
  try {
    await assertCategoryDirectory(root);
  } catch (error) {
    return sanitize({
      id: definition.id,
      displayName: definition.displayName,
      description: definition.description,
      pathLabel: safePathLabel(root),
      supported: true,
      status: "failed",
      sizeBytes: 0,
      fileCount: 0,
      directoryCount: 0,
      symlinkCount: 0,
      skippedCount: 0,
      errorCount: 1,
      errors: [{ code: error.code || "CATEGORY_PATH_INVALID", path: safePathLabel(root), message: error.message }],
      truncated: false,
      measuredAt: nowIso(),
      lastClearedAt: lastCleanupTimes.get(definition.id) || null,
      restartRequired: definition.restartRequired === true,
      signsOut: definition.signsOut === true,
      downloadsAgain: definition.downloadsAgain === true,
      inUse: definition.inUse === true,
      confirmationRequired: definition.confirmationRequired === true,
    });
  }
  const measurement = await measurePath(root, options);
  return sanitize({
    id: definition.id,
    displayName: definition.displayName,
    description: definition.description,
    pathLabel: safePathLabel(root),
    supported: true,
    status: categoryStatus(definition, measurement),
    sizeBytes: measurement.bytes,
    fileCount: measurement.files,
    directoryCount: measurement.directories,
    symlinkCount: measurement.symlinks,
    skippedCount: measurement.skipped,
    errorCount: measurement.errors.length,
    errors: measurement.errors.slice(0, 5),
    truncated: measurement.truncated,
    measuredAt: measurement.measuredAt,
    lastClearedAt: lastCleanupTimes.get(definition.id) || null,
    restartRequired: definition.restartRequired === true,
    signsOut: definition.signsOut === true,
    downloadsAgain: definition.downloadsAgain === true,
    inUse: definition.inUse === true,
    confirmationRequired: definition.confirmationRequired === true,
  });
}

async function scan(options = {}) {
  const categories = [];
  for (const definition of getCategoryDefinitions(options)) {
    try {
      categories.push(await scanCategory(definition.id, options));
    } catch (error) {
      categories.push(sanitize({
        id: definition.id,
        displayName: definition.displayName,
        description: definition.description,
        supported: false,
        status: "unsupported",
        sizeBytes: 0,
        errors: [{ code: error.code || "SCAN_FAILED", message: error.message }],
        measuredAt: nowIso(),
        lastClearedAt: lastCleanupTimes.get(definition.id) || null,
        restartRequired: definition.restartRequired === true,
        signsOut: definition.signsOut === true,
        downloadsAgain: definition.downloadsAgain === true,
        inUse: definition.inUse === true,
        confirmationRequired: definition.confirmationRequired === true,
      }));
    }
  }
  return { scannedAt: nowIso(), categories };
}

async function clear(categoryIds = [], options = {}) {
  const ids = [...new Set((Array.isArray(categoryIds) ? categoryIds : []).map(String).filter(Boolean))];
  if (!ids.length) {
    const error = new Error("Select at least one maintenance category.");
    error.code = "MAINTENANCE_EMPTY_SELECTION";
    throw error;
  }
  const locked = ids.find((id) => cleanupLocks.has(id));
  if (locked) {
    const error = new Error("A cleanup is already running for one of the selected categories.");
    error.code = "MAINTENANCE_CLEANUP_IN_PROGRESS";
    throw error;
  }
  ids.forEach((id) => cleanupLocks.add(id));
  const startedAt = nowIso();
  try {
    const results = [];
    for (const id of ids) {
      const definition = getCategoryOrThrow(id, options);
      const before = await scanCategory(id, options);
      if (definition.clearSessionCache && session?.defaultSession?.clearCache) {
        await session.defaultSession.clearCache();
      }
      const cleanup = await clearCategory(definition);
      const after = await scanCategory(id, options);
      const reclaimedBytes = Math.max(0, Number(before.sizeBytes || 0) - Number(after.sizeBytes || 0));
      const partial = cleanup.failures.length > 0 || after.errorCount > 0;
      const clearedAt = nowIso();
      lastCleanupTimes.set(id, clearedAt);
      diagnostics.log(partial ? "warn" : "info", "maintenance", "clear", partial ? "Maintenance cleanup partially completed." : "Maintenance cleanup completed.", {
        categoryId: id,
        beforeBytes: before.sizeBytes,
        afterBytes: after.sizeBytes,
        reclaimedBytes,
        removedEntries: cleanup.removedEntries,
        skippedEntries: cleanup.skippedEntries,
        failures: cleanup.failures,
      }, { file: "maintenance" });
      results.push(sanitize({
        id,
        displayName: definition.displayName,
        status: partial ? "partial" : "cleared",
        beforeBytes: before.sizeBytes,
        afterBytes: after.sizeBytes,
        reclaimedBytes,
        verified: true,
        removedEntries: cleanup.removedEntries,
        skippedEntries: cleanup.skippedEntries,
        failures: cleanup.failures.slice(0, 10),
        restartRequired: definition.restartRequired === true,
        signsOut: definition.signsOut === true,
        downloadsAgain: definition.downloadsAgain === true,
        clearedAt,
      }));
    }
    return {
      startedAt,
      completedAt: nowIso(),
      results,
      reclaimedBytes: results.reduce((sum, result) => sum + Number(result.reclaimedBytes || 0), 0),
      restartRequired: results.some((result) => result.restartRequired),
      signsOut: results.some((result) => result.signsOut),
      partial: results.some((result) => result.status === "partial"),
    };
  } finally {
    ids.forEach((id) => cleanupLocks.delete(id));
  }
}

module.exports = {
  clear,
  getCategoryDefinitions,
  scan,
  scanCategory,
  _test: {
    assertSafeCategoryPath,
    clearCategory,
    getCategoryOrThrow,
    measurePath,
    safePathLabel,
    setLastCleanupTimes(value) { lastCleanupTimes = value; },
  },
};
