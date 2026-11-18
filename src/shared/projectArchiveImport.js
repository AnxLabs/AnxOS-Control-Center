"use strict";

// Build 214: the Node.js and Python application cards deploy a project the
// user zips on their own computer. The archive is untrusted: it is read in
// the main process, every entry is checked before anything is sent, and the
// files are written one by one through the Agent's existing file route into
// the server's own folder. Nothing in it is run by AnxOS during the install;
// the app runs as the AnxOS Agent's account (never elevated) like every
// server.
//
// AnxOS does not install packages (npm or pip) yet, so a project that needs
// some must bring them: a Node.js project with dependencies must include its
// node_modules folder, and a Python project whose requirements.txt lists
// packages is refused with a message rather than started to fail.

const path = require("path");
const unzipper = require("unzipper");

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_BYTES = 300 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_PATH_LENGTH = 240;
// Folders that are never copied: version control and macOS archive metadata.
const SKIPPED_ROOTS = new Set([".git", "__MACOSX", ".hg", ".svn"]);

const KINDS = {
  "node-application": {
    label: "Node.js",
    entries: ["index.js", "server.js", "app.js", "main.js", "bot.js", "index.mjs", "server.mjs"],
  },
  "python-application": {
    label: "Python",
    entries: ["main.py", "app.py", "bot.py", "server.py", "__main__.py"],
  },
};

function importError(message, code = "APP_IMPORT_INVALID") {
  const error = new Error(message);
  error.code = code;
  error.details = { retryable: false };
  return error;
}

// A safe relative path inside the server folder, or null for a folder entry.
function normalizeEntryPath(rawPath) {
  const raw = String(rawPath || "");
  if (raw.includes("\0") || raw.includes("\\")) throw importError(`The archive has an entry with an unsafe name (${raw.slice(0, 60)}).`);
  if (raw.endsWith("/")) return null;
  if (raw.startsWith("/") || /^[a-zA-Z]:/.test(raw)) throw importError(`The archive has an entry with an absolute path (${raw.slice(0, 60)}).`);
  const parts = raw.split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "")) throw importError(`The archive has an entry that leaves its folder (${raw.slice(0, 60)}).`);
  if (parts.some((part) => /[<>:"|?*\u0001-\u001f]/.test(part) || /[. ]$/.test(part))) throw importError(`The archive has a file name Windows cannot store (${raw.slice(0, 60)}).`);
  if (raw.length > MAX_PATH_LENGTH) throw importError(`The archive has a path longer than ${MAX_PATH_LENGTH} characters.`);
  return raw;
}

// A symbolic link stored in a ZIP carries the Unix file type in the upper
// half of its external attributes.
function isSymbolicLink(entry) {
  const unixMode = (Number(entry.externalFileAttributes) >>> 16) & 0o170000;
  return unixMode === 0o120000;
}

function stripCommonRoot(paths) {
  if (paths.length === 0) return { root: "", paths };
  const first = paths[0].split("/")[0];
  const shared = paths.every((entry) => entry.includes("/") && entry.split("/")[0] === first);
  return shared ? { root: first, paths: paths.map((entry) => entry.slice(first.length + 1)) } : { root: "", paths };
}

function readPackageJson(files) {
  const file = files.find((entry) => entry.path === "package.json");
  if (!file) return null;
  if (file.buffer.length > 1024 * 1024) throw importError("package.json is larger than 1 MB.");
  try {
    const parsed = JSON.parse(file.buffer.toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    throw importError("package.json is not valid JSON.");
  }
}

function listedPythonRequirements(files) {
  const file = files.find((entry) => entry.path === "requirements.txt");
  if (!file) return [];
  return file.buffer.toString("utf8").split(/\r?\n/)
    .map((line) => line.replace(/#.*/, "").trim())
    .filter(Boolean);
}

function chooseEntry(kind, files, packageJson) {
  const present = new Set(files.map((entry) => entry.path));
  if (kind === "node-application" && typeof packageJson?.main === "string" && packageJson.main.trim()) {
    const main = packageJson.main.trim().replace(/^\.\//, "");
    const candidates = [main, `${main}.js`, `${main}/index.js`];
    const found = candidates.find((candidate) => present.has(candidate));
    if (!found) throw importError(`package.json names "${main.slice(0, 60)}" as its main file, but the archive does not contain it.`);
    return found;
  }
  const found = KINDS[kind].entries.find((candidate) => present.has(candidate));
  if (!found) {
    throw importError(kind === "node-application"
      ? "The archive has no package.json \"main\" file and none of index.js, server.js, app.js, main.js or bot.js at its top level."
      : "The archive has none of main.py, app.py, bot.py, server.py or __main__.py at its top level.");
  }
  return found;
}

// Reads and checks a project archive. Returns the files to copy (paths
// relative to the project root, the archive's single top folder removed),
// the file to start and a short summary.
async function inspectProjectArchive(buffer, fileName = "", kind = "") {
  if (!KINDS[kind]) throw importError("This card does not import projects.");
  if (!/\.zip$/i.test(String(fileName))) throw importError("Choose a .zip file of the project folder.");
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw importError("The chosen file is empty.");
  if (buffer.length > MAX_ARCHIVE_BYTES) throw importError("The chosen archive is larger than 100 MB.", "APP_IMPORT_TOO_LARGE");
  if (buffer.readUInt32LE(0) !== 0x04034b50) throw importError("The chosen file is not a .zip archive.");
  let directory;
  try {
    directory = await unzipper.Open.buffer(buffer);
  } catch {
    throw importError("The chosen archive could not be read.");
  }
  const entries = [];
  let declaredBytes = 0;
  for (const entry of directory.files) {
    if (isSymbolicLink(entry)) throw importError(`The archive contains a link (${String(entry.path).slice(0, 60)}); links are not copied.`);
    const entryPath = normalizeEntryPath(entry.path);
    if (!entryPath || entry.type === "Directory") continue;
    entries.push({ entry, path: entryPath });
    declaredBytes += Number(entry.uncompressedSize || 0);
    if (entries.length > MAX_FILES) throw importError(`The archive has more than ${MAX_FILES} files.`, "APP_IMPORT_TOO_LARGE");
    if (declaredBytes > MAX_TOTAL_BYTES) throw importError("The archive unpacks to more than 300 MB.", "APP_IMPORT_TOO_LARGE");
  }
  const stripped = stripCommonRoot(entries.map((item) => item.path));
  const files = [];
  let totalBytes = 0;
  const seen = new Set();
  for (let index = 0; index < entries.length; index += 1) {
    const relative = stripped.paths[index];
    if (!relative || SKIPPED_ROOTS.has(relative.split("/")[0])) continue;
    const key = relative.toLowerCase();
    if (seen.has(key)) throw importError(`The archive has two files named ${relative.slice(0, 60)} (names differ only in letter case).`);
    seen.add(key);
    let content;
    try {
      content = await entries[index].entry.buffer();
    } catch {
      throw importError(`The archive entry ${relative.slice(0, 60)} could not be read.`);
    }
    // The size an entry declares is not trusted: count what it unpacks to.
    totalBytes += content.length;
    if (totalBytes > MAX_TOTAL_BYTES) throw importError("The archive unpacks to more than 300 MB.", "APP_IMPORT_TOO_LARGE");
    files.push({ path: relative, buffer: content });
  }
  if (files.length === 0) throw importError("The archive has no files.");
  const packageJson = kind === "node-application" ? readPackageJson(files) : null;
  if (kind === "node-application" && !packageJson) throw importError("The archive has no package.json at its top level, so it is not a Node.js project.");
  const entry = chooseEntry(kind, files, packageJson);
  if (kind === "node-application") {
    const dependencies = Object.keys(packageJson.dependencies || {});
    const hasModules = files.some((file) => file.path.startsWith("node_modules/"));
    if (dependencies.length > 0 && !hasModules) {
      throw importError(`This project needs ${dependencies.length} package${dependencies.length === 1 ? "" : "s"} (${dependencies.slice(0, 3).join(", ")}${dependencies.length > 3 ? ", ..." : ""}) and the archive has no node_modules folder. AnxOS does not run npm yet: run "npm install --omit=dev" in the project folder, then zip it again with node_modules.`, "NODE_APP_DEPENDENCIES_MISSING");
    }
  }
  if (kind === "python-application") {
    const requirements = listedPythonRequirements(files);
    if (requirements.length > 0) {
      throw importError(`requirements.txt lists ${requirements.length} package${requirements.length === 1 ? "" : "s"} (${requirements.slice(0, 3).join(", ").slice(0, 80)}). AnxOS does not install Python packages yet, so this project cannot start on the chosen computer. Projects that use only the standard library can be deployed.`, "PYTHON_APP_PACKAGES_UNSUPPORTED");
    }
  }
  return {
    files,
    entry,
    rootFolder: stripped.root || null,
    fileCount: files.length,
    totalBytes,
    summary: `${files.length} file${files.length === 1 ? "" : "s"} (${Math.max(1, Math.round(totalBytes / 1024))} KB), starting ${entry}`,
  };
}

module.exports = {
  KINDS,
  MAX_ARCHIVE_BYTES,
  MAX_FILES,
  MAX_TOTAL_BYTES,
  inspectProjectArchive,
  normalizeEntryPath,
};
