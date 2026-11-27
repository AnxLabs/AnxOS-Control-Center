"use strict";

// 217-E: temp files left by an interrupted save.
//
// Every store writes `<file>.<pid>.<...>.tmp` and then renames it over
// `<file>`. If the process is ended between the write and the rename (the
// installer forcing the app closed, a crash, a power cut), the temp file is
// left behind for good. On the development PC, `alerts.json.<pid>.<time>.tmp`
// had been left in the real config folder.
//
// At startup, each such file in the config folder (and one level of
// subfolders) that is old enough, and whose writer is not running, is moved
// into `.recovered-tmp/` beside it, never deleted outright. That folder keeps
// the newest 20 files. Nothing is put back automatically: some stores delete
// their file on purpose (a sign-out removes the saved session), and restoring
// an old temp copy would undo that. A temp file whose store file is missing
// is reported (`orphanedStore`) so support can recover it by hand.
// Only `.json` stores are touched. A temp file younger than minAgeMs is left
// alone, because another process (the Local Agent shares this folder) may be
// in the middle of a save.

const fs = require("fs");
const path = require("path");

const TEMP_PATTERN = /^(.+\.json)\.(\d+)(?:\.[^.\\/]+)*\.tmp$/;
const QUARANTINE_DIR = ".recovered-tmp";
const QUARANTINE_KEEP = 20;
const DEFAULT_MIN_AGE_MS = 10 * 60 * 1000;

function defaultIsPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function isCompleteJson(filePath) {
  try {
    JSON.parse(fs.readFileSync(filePath, "utf8"));
    return true;
  } catch {
    return false;
  }
}

function listTempFiles(directory, depth) {
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (depth > 0 && entry.name !== QUARANTINE_DIR && !entry.name.startsWith(".")) found.push(...listTempFiles(full, depth - 1));
    } else if (entry.isFile() && TEMP_PATTERN.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

function pruneQuarantine(directory) {
  const quarantine = path.join(directory, QUARANTINE_DIR);
  let names;
  try {
    names = fs.readdirSync(quarantine);
  } catch {
    return;
  }
  const files = names
    .map((name) => ({ name, at: (() => { try { return fs.statSync(path.join(quarantine, name)).mtimeMs; } catch { return 0; } })() }))
    .sort((a, b) => b.at - a.at);
  for (const old of files.slice(QUARANTINE_KEEP)) {
    try { fs.rmSync(path.join(quarantine, old.name), { force: true }); } catch {}
  }
}

function recoverOrphanTempFiles(rootDirectory, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const minAgeMs = Number.isFinite(options.minAgeMs) ? options.minAgeMs : DEFAULT_MIN_AGE_MS;
  const isPidAlive = typeof options.isPidAlive === "function" ? options.isPidAlive : defaultIsPidAlive;
  const ownPid = Number.isInteger(options.pid) ? options.pid : process.pid;
  const result = { quarantined: [], orphanedStore: [], skipped: 0, failed: 0 };
  if (!rootDirectory || !fs.existsSync(rootDirectory)) return result;

  const touchedDirectories = new Set();
  for (const tempPath of listTempFiles(rootDirectory, 1)) {
    const match = path.basename(tempPath).match(TEMP_PATTERN);
    const pid = Number(match[2]);
    let stats;
    try {
      stats = fs.statSync(tempPath);
    } catch {
      continue;
    }
    if (pid === ownPid || now - stats.mtimeMs < minAgeMs || isPidAlive(pid)) {
      result.skipped += 1;
      continue;
    }
    const directory = path.dirname(tempPath);
    const target = path.join(directory, match[1]);
    const relative = path.relative(rootDirectory, tempPath);
    try {
      if (!fs.existsSync(target) && isCompleteJson(tempPath)) result.orphanedStore.push(path.relative(rootDirectory, target));
      const quarantine = path.join(directory, QUARANTINE_DIR);
      fs.mkdirSync(quarantine, { recursive: true });
      fs.renameSync(tempPath, path.join(quarantine, path.basename(tempPath)));
      result.quarantined.push(relative);
      touchedDirectories.add(directory);
    } catch {
      result.failed += 1;
    }
  }
  for (const directory of touchedDirectories) pruneQuarantine(directory);
  return result;
}

module.exports = {
  DEFAULT_MIN_AGE_MS,
  QUARANTINE_DIR,
  QUARANTINE_KEEP,
  TEMP_PATTERN,
  recoverOrphanTempFiles,
};
