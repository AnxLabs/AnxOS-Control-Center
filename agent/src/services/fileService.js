const fs = require("fs");
const fsPromises = require("fs/promises");
let accessPath = fsPromises.access;
const os = require("os");
const path = require("path");
const { getConfig } = require("../config");

const DEFAULT_TEXT_READ_LIMIT_BYTES = 1024 * 1024;
const BINARY_SAMPLE_BYTES = 4096;
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const RESTART_REQUIRED_SKEW_MS = 1000;
const FILE_CAPABILITIES = {
  upload: true,
  download: true,
  rename: true,
  delete: true,
  copy: true,
  move: true,
  createFolder: true,
  editText: true,
  dragDrop: true,
  search: true,
  sort: true,
  storageUsage: true,
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function createFileError(code, statusCode = 400, message = null, details = {}) {
  return Object.assign(new Error(message || code), {
    code,
    statusCode,
    details: {
      code,
      field: details.field || null,
      value: details.value || null,
      expected: details.expected || null,
      suggestion: details.suggestion || null,
      ...details,
    },
  });
}

function getRuntimeConfigSources() {
  return [
    process.env.ANXOS_AGENT_RUNTIME_CONFIG
      ? { type: "environment-file", path: process.env.ANXOS_AGENT_RUNTIME_CONFIG }
      : null,
    process.env.ANXHUB_CONFIG_DIR
      ? { type: "config-directory", path: path.join(process.env.ANXHUB_CONFIG_DIR, "agent-runtime.json") }
      : null,
  ].filter(Boolean);
}

function getConfigurationRestartStatus() {
  const processStartedAt = Date.now() - (process.uptime() * 1000);
  const changedSources = [];

  for (const source of getRuntimeConfigSources()) {
    try {
      const stats = fs.statSync(source.path);
      if (stats.mtimeMs > processStartedAt + RESTART_REQUIRED_SKEW_MS) {
        changedSources.push({
          type: source.type,
          changedAt: stats.mtime.toISOString(),
        });
      }
    } catch {
      // Missing config files are reported by the root status, not restart status.
    }
  }

  return {
    restartRequired: changedSources.length > 0,
    changedSources,
  };
}

function getConfiguredRootEntries() {
  const config = getConfig();
  const homeDirectory = os.homedir() || process.cwd();
  let source = "default-home";
  let rawRoots = [homeDirectory];

  if (Object.prototype.hasOwnProperty.call(process.env, "AGENT_FILE_ROOTS")) {
    source = "environment";
    rawRoots = String(process.env.AGENT_FILE_ROOTS || "").split(path.delimiter);
  } else if (config.allowedFolders.length) {
    source = "runtime-config";
    rawRoots = config.allowedFolders;
  }

  return rawRoots.map((root, index) => ({
    rawValue: String(root ?? ""),
    index,
    source,
  }));
}

function expandConfiguredRoot(rawValue) {
  const trimmed = String(rawValue || "").trim();
  if (trimmed === "~") {
    return os.homedir() || "";
  }
  if (trimmed.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir() || "", trimmed.slice(2));
  }
  return trimmed;
}

function createRootStatus(code, message, entry, extra = {}) {
  return {
    configuredValue: entry?.rawValue || "",
    source: entry?.source || "unknown",
    index: entry?.index ?? 0,
    status: code,
    code,
    message,
    exists: false,
    readable: false,
    isDirectory: false,
    normalizedPath: null,
    realPath: null,
    ...extra,
  };
}

async function validateConfiguredRoot(entry) {
  const expanded = expandConfiguredRoot(entry.rawValue);

  if (!String(entry.rawValue || "").trim()) {
    return createRootStatus(
      "FILESYSTEM_ROOT_EMPTY",
      "The Agent filesystem root is empty.",
      entry,
      {
        field: "filesystemRoot",
        suggestion: "Set AGENT_FILE_ROOTS or allowedFolders to an absolute directory and restart the Agent.",
      },
    );
  }

  if (expanded.includes("\0") || !path.isAbsolute(expanded)) {
    return createRootStatus(
      "FILESYSTEM_ROOT_INVALID",
      "The Agent filesystem root must be an absolute path.",
      entry,
      {
        field: "filesystemRoot",
        normalizedPath: expanded || null,
        suggestion: "Configure an absolute filesystem root such as /home/anx or /srv/files and restart the Agent.",
      },
    );
  }

  const normalizedPath = path.normalize(expanded);

  let realPath;
  try {
    realPath = await fsPromises.realpath(normalizedPath);
  } catch (error) {
    return createRootStatus(
      error?.code === "ENOENT" ? "FILESYSTEM_ROOT_MISSING" : "FILESYSTEM_ROOT_INVALID",
      error?.code === "ENOENT"
        ? "The configured Agent filesystem root does not exist."
        : "The configured Agent filesystem root could not be resolved.",
      entry,
      {
        field: "filesystemRoot",
        normalizedPath,
        errorCode: error?.code || null,
        suggestion: "Create the configured directory or update the Agent filesystem root, then restart the Agent.",
      },
    );
  }

  let stats;
  try {
    stats = await fsPromises.stat(realPath);
  } catch (error) {
    return createRootStatus(
      "FILESYSTEM_ROOT_INVALID",
      "The configured Agent filesystem root could not be inspected.",
      entry,
      {
        field: "filesystemRoot",
        exists: true,
        normalizedPath,
        realPath,
        errorCode: error?.code || null,
        suggestion: "Check the configured root permissions and restart the Agent after fixing configuration.",
      },
    );
  }

  if (!stats.isDirectory()) {
    return createRootStatus(
      "FILESYSTEM_ROOT_INVALID",
      "The configured Agent filesystem root is not a directory.",
      entry,
      {
        field: "filesystemRoot",
        exists: true,
        normalizedPath,
        realPath,
        suggestion: "Configure the Agent filesystem root to an existing directory.",
      },
    );
  }

  try {
    await accessPath(realPath, fs.constants.R_OK | fs.constants.X_OK);
  } catch (error) {
    return createRootStatus(
      "FILESYSTEM_ROOT_UNREADABLE",
      "The configured Agent filesystem root is not readable by the Agent process.",
      entry,
      {
        field: "filesystemRoot",
        exists: true,
        isDirectory: true,
        normalizedPath,
        realPath,
        errorCode: error?.code || null,
        suggestion: "Grant the Agent process user read and execute access to the configured root, or choose a readable root.",
      },
    );
  }

  return createRootStatus(
    "valid",
    "The configured Agent filesystem root is valid.",
    entry,
    {
      exists: true,
      readable: true,
      isDirectory: true,
      normalizedPath,
      realPath,
    },
  );
}

async function getRootValidationReport() {
  const rootStatuses = await Promise.all(getConfiguredRootEntries().map(validateConfiguredRoot));
  const validRoots = unique(rootStatuses
    .filter((rootStatus) => rootStatus.status === "valid" && rootStatus.realPath)
    .map((rootStatus) => rootStatus.realPath));
  const effectiveRoot = validRoots[0] || null;
  const primaryStatus = rootStatuses.find((rootStatus) => rootStatus.status === "valid") || rootStatuses[0] || null;
  const restartStatus = getConfigurationRestartStatus();

  return {
    validRoots,
    effectiveRoot,
    primaryStatus,
    rootStatuses,
    configSourceType: primaryStatus?.source || "unknown",
    restartRequired: restartStatus.restartRequired,
    changedSources: restartStatus.changedSources,
  };
}

async function getAllowedRoots() {
  return (await getRootValidationReport()).validRoots;
}

function getBackupRootPath() {
  const config = getConfig();
  return path.resolve(process.env.AGENT_BACKUP_ROOT || path.join(path.dirname(config.instanceRoot), "backups"));
}

function getKnownUserFolder(name) {
  const homeDirectory = os.homedir() || "";
  return homeDirectory ? path.join(homeDirectory, name) : null;
}

function addShortcut(candidates, id, name, candidatePath, options = {}) {
  if (!candidatePath) {
    return;
  }
  candidates.push({
    id,
    name,
    path: candidatePath,
    kind: options.kind || "folder",
    protected: Boolean(options.protected),
    warning: options.warning || null,
  });
}

function getSteamLibraryCandidates() {
  const candidates = [];
  const homeDirectory = os.homedir() || "";

  if (process.platform === "win32") {
    [
      process.env.STEAM_LIBRARY,
      process.env.STEAM_LIBRARY_PATH,
      process.env.ProgramFiles ? path.join(process.env.ProgramFiles, "Steam", "steamapps") : null,
      process.env["ProgramFiles(x86)"] ? path.join(process.env["ProgramFiles(x86)"], "Steam", "steamapps") : null,
      process.env.PROGRAMW6432 ? path.join(process.env.PROGRAMW6432, "Steam", "steamapps") : null,
      homeDirectory ? path.join(homeDirectory, "Steam", "steamapps") : null,
    ].filter(Boolean).forEach((candidate) => candidates.push(candidate));
  } else {
    [
      process.env.STEAM_LIBRARY,
      process.env.STEAM_LIBRARY_PATH,
      homeDirectory ? path.join(homeDirectory, ".steam", "steam", "steamapps") : null,
      homeDirectory ? path.join(homeDirectory, ".local", "share", "Steam", "steamapps") : null,
    ].filter(Boolean).forEach((candidate) => candidates.push(candidate));
  }

  return unique(candidates.map((candidate) => path.resolve(candidate)));
}

function buildShortcutCandidates() {
  const homeDirectory = os.homedir() || "";
  const config = getConfig();
  const candidates = [];

  addShortcut(candidates, "anxos-instances", "AnxOS Instances", config.instanceRoot, { kind: "managed" });
  addShortcut(candidates, "anxos-backups", "AnxOS Backups", getBackupRootPath(), { kind: "managed" });
  addShortcut(candidates, "desktop", "Desktop", getKnownUserFolder("Desktop"));
  addShortcut(candidates, "documents", "Documents", getKnownUserFolder("Documents"));
  addShortcut(candidates, "downloads", "Downloads", getKnownUserFolder("Downloads"));
  addShortcut(candidates, "pictures", "Pictures", getKnownUserFolder("Pictures"));
  addShortcut(candidates, "videos", "Videos", getKnownUserFolder("Videos"));
  addShortcut(candidates, "music", "Music", getKnownUserFolder("Music"));
  addShortcut(candidates, "user-profile", "User Profile", homeDirectory);

  if (process.platform === "win32") {
    addShortcut(candidates, "app-data", "AppData", process.env.APPDATA || (homeDirectory ? path.join(homeDirectory, "AppData", "Roaming") : null), {
      kind: "system",
      protected: true,
      warning: "AppData can contain application settings. Edit files here only when you know which application owns them.",
    });
    addShortcut(candidates, "program-data", "ProgramData", process.env.PROGRAMDATA || "C:\\ProgramData", {
      kind: "system",
      protected: true,
      warning: "ProgramData can contain shared application data and service configuration.",
    });
  } else {
    addShortcut(candidates, "app-data", "AppData", process.env.XDG_CONFIG_HOME || (homeDirectory ? path.join(homeDirectory, ".config") : null), {
      kind: "system",
      protected: true,
      warning: "Application data can contain settings. Edit files here only when you know which application owns them.",
    });
  }

  getSteamLibraryCandidates().forEach((steamPath, index) => {
    addShortcut(candidates, index === 0 ? "steam-libraries" : `steam-libraries-${index + 1}`, index === 0 ? "Steam Libraries" : `Steam Library ${index + 1}`, steamPath, {
      kind: "library",
    });
  });

  return candidates;
}

async function resolveShortcut(candidate, rootReport) {
  const normalizedPath = path.resolve(candidate.path);
  const rootMatch = rootReport.validRoots.find((root) => isInsideRoot(normalizedPath, root));
  const base = {
    id: candidate.id,
    name: candidate.name,
    path: normalizedPath,
    type: "directory",
    isDirectory: true,
    kind: candidate.kind,
    protected: candidate.protected,
    warning: candidate.warning,
    available: false,
    outsideAllowedRoots: !rootMatch,
    reason: null,
  };

  if (!rootMatch) {
    return {
      ...base,
      reason: "outside_allowed_roots",
    };
  }

  try {
    const realPath = await fsPromises.realpath(normalizedPath);
    const stats = await fsPromises.stat(realPath);
    if (!stats.isDirectory()) {
      return {
        ...base,
        path: realPath,
        reason: "not_directory",
      };
    }
    if (!isInsideRoot(realPath, rootMatch)) {
      return {
        ...base,
        path: realPath,
        outsideAllowedRoots: true,
        reason: "resolves_outside_allowed_roots",
      };
    }
    await fsPromises.access(realPath, fs.constants.R_OK | fs.constants.X_OK);
    return {
      ...base,
      path: realPath,
      root: rootMatch,
      available: true,
      outsideAllowedRoots: false,
      reason: null,
    };
  } catch (error) {
    return {
      ...base,
      reason: error?.code === "ENOENT" ? "missing" : error?.code === "EACCES" || error?.code === "EPERM" ? "unreadable" : "unavailable",
      errorCode: error?.code || null,
    };
  }
}

async function getFilesystemShortcuts(rootReport = null) {
  const report = rootReport || await getRootValidationReport();
  const shortcuts = await Promise.all(buildShortcutCandidates().map((candidate) => resolveShortcut(candidate, report)));
  const seen = new Set();
  return shortcuts.filter((shortcut) => {
    const key = `${shortcut.id}:${String(shortcut.path || "").toLowerCase()}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function buildRootEntries(rootReport, shortcuts = []) {
  const rootEntries = rootReport.validRoots.map((rootPath) => ({
    name: path.basename(rootPath) || rootPath,
    path: rootPath,
    type: "directory",
    isDirectory: true,
    kind: "root",
    available: true,
  }));

  const seen = new Set(rootEntries.map((entry) => String(entry.path).toLowerCase()));
  shortcuts
    .filter((shortcut) => shortcut.available)
    .forEach((shortcut) => {
      const key = String(shortcut.path || "").toLowerCase();
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      rootEntries.push(shortcut);
    });

  return rootEntries;
}

async function getFilesystemIdentity() {
  const homeDirectory = os.homedir() || process.cwd();
  const rootReport = await getRootValidationReport();
  const shortcuts = await getFilesystemShortcuts(rootReport);
  const homeRealPath = await fsPromises.realpath(homeDirectory).catch(() => null);
  const homeInsideRoot = Boolean(homeRealPath && rootReport.validRoots.some((root) => isInsideRoot(homeRealPath, root)));
  const rootIsUsable = Boolean(rootReport.effectiveRoot && rootReport.primaryStatus?.status === "valid" && rootReport.primaryStatus.readable);
  const initialPath = homeInsideRoot ? homeRealPath : rootIsUsable ? rootReport.effectiveRoot : null;

  return {
    platform: process.platform,
    hostname: os.hostname(),
    homeDirectory,
    rootPath: rootReport.effectiveRoot || path.parse(homeDirectory).root || path.sep,
    filesystemRoot: rootReport.effectiveRoot,
    filesystemRootStatus: rootReport.primaryStatus || null,
    filesystemRoots: rootReport.rootStatuses,
    filesystemRootExists: Boolean(rootReport.primaryStatus?.exists),
    filesystemRootReadable: Boolean(rootReport.primaryStatus?.readable),
    homeInsideFilesystemRoot: homeInsideRoot,
    initialPath,
    pathSeparator: path.sep,
    roots: buildRootEntries(rootReport, shortcuts),
    shortcuts,
    fileShortcuts: shortcuts,
    capabilities: FILE_CAPABILITIES,
    configSourceType: rootReport.configSourceType,
    restartRequired: rootReport.restartRequired,
  };
}

function isInsideRoot(filePath, root) {
  const relative = path.relative(root, filePath);
  return relative === "" || (relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function throwRootConfigurationError(rootReport) {
  const status = rootReport.primaryStatus || {
    code: "FILESYSTEM_ROOT_INVALID",
    message: "The Agent filesystem root is not valid.",
  };
  throw createFileError(status.code || "FILESYSTEM_ROOT_INVALID", 403, status.message, {
    field: status.field || "filesystemRoot",
    value: status.configuredValue || null,
    normalizedPath: status.normalizedPath || null,
    realPath: status.realPath || null,
    configSourceType: status.source || rootReport.configSourceType || "unknown",
    rootExists: Boolean(status.exists),
    rootReadable: Boolean(status.readable),
    restartRequired: Boolean(rootReport.restartRequired),
    suggestion: status.suggestion || "Fix the Agent filesystem root configuration and restart the Agent.",
  });
}

async function resolveAllowedPath(requestedPath) {
  if (!requestedPath) {
    throw createFileError("PATH_REQUIRED", 400, "A filesystem path is required.", {
      field: "path",
      suggestion: "Choose a folder inside the configured Agent filesystem root.",
    });
  }

  if (requestedPath.includes("\0")) {
    throw createFileError("INVALID_PATH", 400, "The requested path is malformed.", {
      field: "path",
      value: requestedPath,
      expected: "A path without null bytes.",
    });
  }

  const resolvedPath = path.resolve(requestedPath);
  const rootReport = await getRootValidationReport();
  const allowedRoots = rootReport.validRoots;

  if (allowedRoots.length === 0) {
    throwRootConfigurationError(rootReport);
  }

  const rootMatch = allowedRoots.find((root) => isInsideRoot(resolvedPath, root));

  if (!rootMatch) {
    throw createFileError("PATH_NOT_ALLOWED", 403, "The requested path is outside the configured Agent filesystem root.", {
      field: "path",
      value: requestedPath,
      requestedPath: resolvedPath,
      filesystemRoot: rootReport.effectiveRoot,
      configSourceType: rootReport.configSourceType,
      suggestion: "Select a path inside the configured Agent filesystem root.",
    });
  }

  let realPath;

  try {
    realPath = await fsPromises.realpath(resolvedPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw createFileError("PATH_NOT_FOUND", 404, "The requested path does not exist.", {
        field: "path",
        value: requestedPath,
        requestedPath: resolvedPath,
        filesystemRoot: rootMatch,
        suggestion: "Refresh the folder or choose an existing path inside the configured root.",
      });
    }

    if (error?.code === "EACCES" || error?.code === "EPERM") {
      throw createFileError("PATH_UNREADABLE", 403, "The requested path is not readable by the Agent process.", {
        field: "path",
        value: requestedPath,
        requestedPath: resolvedPath,
        filesystemRoot: rootMatch,
        errorCode: error?.code || null,
        suggestion: "Grant the Agent process user permission to read that path or choose another folder.",
      });
    }

    throw createFileError("REALPATH_FAILED", 400, "The requested path could not be resolved safely.", {
      field: "path",
      value: requestedPath,
      requestedPath: resolvedPath,
      filesystemRoot: rootMatch,
      errorCode: error?.code || null,
      suggestion: "Check whether the path still exists and is accessible, then retry.",
    });
  }

  if (!isInsideRoot(realPath, rootMatch)) {
    throw createFileError("PATH_NOT_ALLOWED", 403, "The requested path resolves outside the configured Agent filesystem root.", {
      field: "path",
      value: requestedPath,
      requestedPath: resolvedPath,
      resolvedRealPath: realPath,
      filesystemRoot: rootMatch,
      suggestion: "Choose a path that does not leave the configured root through a symbolic link.",
    });
  }

  return {
    path: realPath,
    root: rootMatch,
  };
}

// Delete and rename act on the entry the user selected, never on what it
// points to: resolving the whole path made Delete remove a symlink's or
// junction's target folder and leave the link. Only the parent is resolved
// (so a linked parent still cannot leave the root); the entry itself is
// examined with lstat. A configured root keeps the full resolution so the
// root-delete guard still sees it.
async function resolveAllowedEntryPath(requestedPath) {
  if (!requestedPath || requestedPath.includes("\0")) {
    return resolveAllowedPath(requestedPath);
  }
  const entryPath = path.resolve(requestedPath);
  const parentPath = path.dirname(entryPath);
  const rootReport = await getRootValidationReport();
  if (parentPath === entryPath || rootReport.validRoots.some((root) => path.relative(root, entryPath) === "")) {
    return resolveAllowedPath(requestedPath);
  }
  const parent = await resolveAllowedPath(parentPath);
  const realEntryPath = path.join(parent.path, path.basename(entryPath));
  if (!isInsideRoot(realEntryPath, parent.root)) {
    throw createFileError("PATH_NOT_ALLOWED", 403, "The requested path is outside the configured Agent filesystem root.", {
      field: "path",
      value: requestedPath,
      filesystemRoot: parent.root,
    });
  }
  try {
    await fsPromises.lstat(realEntryPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw createFileError("PATH_NOT_FOUND", 404, "The requested path does not exist.", {
        field: "path",
        value: requestedPath,
        filesystemRoot: parent.root,
        suggestion: "Refresh the folder or choose an existing path inside the configured root.",
      });
    }
    throw error;
  }
  return { path: realEntryPath, root: parent.root };
}

async function resolveAllowedTargetPath(requestedPath) {
  if (!requestedPath || requestedPath.includes("\0")) {
    throw createFileError("INVALID_PATH", 400, "The target path is malformed.", {
      field: "path",
      value: requestedPath || "",
      expected: "A non-empty path without null bytes.",
    });
  }
  const targetPath = path.resolve(requestedPath);
  const parent = await resolveAllowedPath(path.dirname(targetPath));
  if (!isInsideRoot(targetPath, parent.root)) {
    throw createFileError("PATH_NOT_ALLOWED", 403, "The target path is outside the configured Agent filesystem root.", {
      field: "path",
      value: requestedPath,
      filesystemRoot: parent.root,
    });
  }
  const targetStats = await fsPromises.lstat(targetPath).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (targetStats?.isSymbolicLink()) {
    throw createFileError("PATH_NOT_ALLOWED", 403, "The target path is a symbolic link and cannot be overwritten safely.", {
      field: "path",
      value: requestedPath,
      filesystemRoot: parent.root,
      suggestion: "Choose a regular file inside the configured root instead of a symbolic link.",
    });
  }
  return { path: targetPath, root: parent.root };
}

async function atomicWriteFile(targetPath, content, options = {}) {
  const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fsPromises.writeFile(tempPath, content, { ...options, flag: "wx", mode: options.mode || 0o600 });
    await fsPromises.rename(tempPath, targetPath);
  } catch (error) {
    await fsPromises.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function pathExists(filePath) {
  return fsPromises.lstat(filePath).then(() => true, (error) => {
    if (error?.code === "ENOENT") return false;
    throw error;
  });
}

async function assertCopyTreeSafe(sourcePath) {
  const stats = await fsPromises.lstat(sourcePath);
  if (stats.isSymbolicLink()) {
    throw createFileError("COPY_SYMLINK_UNSUPPORTED", 400, "Folders containing symbolic links cannot be copied safely.", {
      field: "sourcePath",
      value: sourcePath,
      suggestion: "Remove the symbolic link or copy regular files separately.",
    });
  }
  if (!stats.isFile() && !stats.isDirectory()) {
    throw createFileError("COPY_FILE_TYPE_UNSUPPORTED", 400, "This filesystem entry type cannot be copied safely.", {
      field: "sourcePath",
      value: sourcePath,
    });
  }
  if (!stats.isDirectory()) return stats;
  const entries = await fsPromises.readdir(sourcePath);
  for (const entry of entries) {
    await assertCopyTreeSafe(path.join(sourcePath, entry));
  }
  return stats;
}

async function copyPathAtomically(sourcePath, destinationPath, conflictPolicy) {
  const sourceStats = await assertCopyTreeSafe(sourcePath);
  const destinationExists = await pathExists(destinationPath);
  if (destinationExists && conflictPolicy !== "replace") {
    throw createFileError("FILES_CONFLICT", 409, "An item already exists at the copy destination.", {
      field: "destinationPath",
      value: destinationPath,
      suggestion: "Choose a different destination or explicitly confirm replacement.",
    });
  }
  if (destinationExists) {
    const destinationStats = await fsPromises.lstat(destinationPath);
    if (sourceStats.isDirectory() || destinationStats.isDirectory()) {
      throw createFileError("DIRECTORY_REPLACE_UNSUPPORTED", 409, "Folder replacement is not supported because it cannot be committed atomically.", {
        field: "destinationPath",
        value: destinationPath,
        suggestion: "Choose a new folder name or delete the existing folder explicitly first.",
      });
    }
  }
  if (sourceStats.isDirectory() && isInsideRoot(destinationPath, sourcePath)) {
    throw createFileError("COPY_DESTINATION_INSIDE_SOURCE", 400, "A folder cannot be copied inside itself.", {
      field: "destinationPath",
      value: destinationPath,
    });
  }

  const tempPath = path.join(path.dirname(destinationPath), `.${path.basename(destinationPath)}.${process.pid}.${Date.now()}.copy.tmp`);
  try {
    await fsPromises.cp(sourcePath, tempPath, {
      recursive: sourceStats.isDirectory(),
      errorOnExist: true,
      force: false,
      filter: async (candidate) => {
        const stats = await fsPromises.lstat(candidate);
        if (!stats.isFile() && !stats.isDirectory()) {
          throw createFileError("COPY_FILE_TYPE_UNSUPPORTED", 400, "The source changed to an unsupported filesystem entry during copy.", {
            field: "sourcePath",
            value: candidate,
          });
        }
        return true;
      },
    });
    await fsPromises.rename(tempPath, destinationPath);
  } catch (error) {
    await fsPromises.rm(tempPath, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function getFileType(stats) {
  if (stats.isDirectory()) {
    return "directory";
  }

  if (stats.isFile()) {
    return "file";
  }

  if (stats.isSymbolicLink()) {
    return "symlink";
  }

  return "other";
}

function normalizeMetadata(filePath, stats) {
  return {
    name: path.basename(filePath),
    type: getFileType(stats),
    size: stats.size,
    modified: stats.mtime.toISOString(),
  };
}

async function statResolvedPath(resolvedPath) {
  const stats = await fsPromises.stat(resolvedPath.path);

  return {
    path: resolvedPath.path,
    root: resolvedPath.root,
    ...normalizeMetadata(resolvedPath.path, stats),
  };
}

async function statPath(requestedPath) {
  return statResolvedPath(await resolveAllowedPath(requestedPath));
}

async function listFiles(requestedPath) {
  const resolvedPath = await resolveAllowedPath(requestedPath);
  const stats = await fsPromises.stat(resolvedPath.path);

  if (!stats.isDirectory()) {
    throw createFileError("PATH_NOT_DIRECTORY", 400);
  }

  const entries = await fsPromises.readdir(resolvedPath.path, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(resolvedPath.path, entry.name);

    try {
      const entryStats = await fsPromises.stat(entryPath);
      return {
        path: entryPath,
        ...normalizeMetadata(entryPath, entryStats),
        // Links are listed by what they point to so a linked folder still
        // opens; the flag tells the UI that Delete removes only the link.
        ...(entry.isSymbolicLink() ? { isSymlink: true } : {}),
      };
    } catch {
      return {
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "other",
        size: null,
        modified: null,
      };
    }
  }));
  const rootReport = await getRootValidationReport();
  const shortcuts = await getFilesystemShortcuts(rootReport);
  const sortedEntries = files.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "directory" ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
  const fileCount = sortedEntries.filter((entry) => entry.type !== "directory").length;
  const directoryCount = sortedEntries.filter((entry) => entry.type === "directory").length;
  const immediateFileBytes = sortedEntries.reduce((total, entry) => total + (entry.type === "file" && Number.isFinite(entry.size) ? entry.size : 0), 0);

  return {
    path: resolvedPath.path,
    currentPath: resolvedPath.path,
    root: resolvedPath.root,
    roots: buildRootEntries(rootReport, shortcuts),
    shortcuts,
    capabilities: FILE_CAPABILITIES,
    entries: sortedEntries,
    summary: {
      directoryCount,
      fileCount,
      totalCount: sortedEntries.length,
      immediateFileBytes,
      storageUsageScope: "current-directory",
    },
  };
}

function hasBinaryBytes(buffer) {
  return buffer.includes(0);
}

async function isTextFile(filePath) {
  const handle = await fsPromises.open(filePath, "r");

  try {
    const buffer = Buffer.alloc(BINARY_SAMPLE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SAMPLE_BYTES, 0);
    const sample = buffer.subarray(0, bytesRead);

    if (hasBinaryBytes(sample)) {
      return false;
    }

    TEXT_DECODER.decode(sample);
    return true;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

async function readTextFile(requestedPath) {
  const resolvedPath = await resolveAllowedPath(requestedPath);
  const stats = await fsPromises.stat(resolvedPath.path);

  if (!stats.isFile()) {
    throw createFileError("PATH_NOT_FILE", 400);
  }

  if (stats.size > DEFAULT_TEXT_READ_LIMIT_BYTES) {
    return {
      path: resolvedPath.path,
      root: resolvedPath.root,
      ...normalizeMetadata(resolvedPath.path, stats),
      supported: false,
      reason: "file_too_large",
      content: null,
    };
  }

  if (!(await isTextFile(resolvedPath.path))) {
    return {
      path: resolvedPath.path,
      root: resolvedPath.root,
      ...normalizeMetadata(resolvedPath.path, stats),
      supported: false,
      reason: "binary_unsupported",
      content: null,
    };
  }

  return {
    path: resolvedPath.path,
    root: resolvedPath.root,
    ...normalizeMetadata(resolvedPath.path, stats),
    supported: true,
    content: await fsPromises.readFile(resolvedPath.path, "utf8"),
  };
}

async function createFileDownload(requestedPath) {
  const resolvedPath = await resolveAllowedPath(requestedPath);
  const stats = await fsPromises.stat(resolvedPath.path);

  if (!stats.isFile()) {
    throw createFileError("PATH_NOT_FILE", 400);
  }

  return {
    path: resolvedPath.path,
    root: resolvedPath.root,
    name: path.basename(resolvedPath.path),
    size: stats.size,
    modified: stats.mtime.toISOString(),
    stream: fs.createReadStream(resolvedPath.path),
  };
}

async function mutateFile(action, payload = {}) {
  if (action === "write" || action === "newFile") {
    const target = await resolveAllowedTargetPath(payload.path);
    await atomicWriteFile(target.path, String(payload.content || ""), { encoding: "utf8" });
    return { path: target.path, saved: true };
  }
  if (action === "mkdir") {
    const target = await resolveAllowedTargetPath(payload.path);
    await fsPromises.mkdir(target.path, { recursive: false });
    return { path: target.path, created: true };
  }
  if (action === "rename" || action === "copy") {
    const sourcePath = payload.sourcePath || payload.oldPath;
    const source = action === "rename" ? await resolveAllowedEntryPath(sourcePath) : await resolveAllowedPath(sourcePath);
    const destination = await resolveAllowedTargetPath(payload.destinationPath || payload.newPath);
    if (action === "rename") await fsPromises.rename(source.path, destination.path);
    else await copyPathAtomically(source.path, destination.path, payload.conflictPolicy);
    return action === "rename"
      ? { oldPath: source.path, newPath: destination.path, renamed: true }
      : { sourcePath: source.path, destinationPath: destination.path, copied: true };
  }
  if (action === "delete") {
    const target = await resolveAllowedEntryPath(payload.path);
    if (target.path === target.root) {
      throw createFileError("ROOT_DELETE_FORBIDDEN", 403, "Configured filesystem roots cannot be deleted through the file browser.", {
        field: "path",
        value: payload.path,
        filesystemRoot: target.root,
      });
    }
    await fsPromises.rm(target.path, { recursive: true, force: false });
    return { path: target.path, deleted: true };
  }
  if (action === "upload") {
    const target = await resolveAllowedTargetPath(payload.path);
    await atomicWriteFile(target.path, Buffer.from(String(payload.content || ""), "base64"));
    return { path: target.path, uploaded: true };
  }
  throw createFileError("UNSUPPORTED_FILE_ACTION", 400);
}

module.exports = {
  __setTestHooks(hooks = {}) { accessPath = hooks.access || fsPromises.access; },
  createFileDownload,
  getFilesystemIdentity,
  getRootValidationReport,
  isInsideRoot,
  listFiles,
  mutateFile,
  readTextFile,
  resolveAllowedPath,
  statPath,
};
