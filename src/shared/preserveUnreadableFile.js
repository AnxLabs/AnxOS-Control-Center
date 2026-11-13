// Keeps a copy of an encrypted store that could not be read, for recovery.
//
// The stores used to write `<file>.undecryptable-<ms>.backup` (or
// `.corrupt-<ms>.backup`) on every failed read. A store that stays unreadable
// is read again and again, so one PC collected 646 such copies with only 3
// distinct contents (Phase 9 audit). A copy is now written only when no
// existing preserved copy of that file and kind holds the same bytes; every
// distinct copy is still kept, because any of them may be the one needed to
// recover credentials.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const KINDS = new Set(["undecryptable", "corrupt"]);

function preservedPattern(kind) {
  if (!KINDS.has(kind)) throw new Error(`Unknown preserved-copy kind: ${kind}`);
  return new RegExp(`^\\.${kind}-(\\d+)(?:-\\d+)?\\.backup$`);
}

function sha256OfFile(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

// Lists existing preserved copies of filePath, newest first.
function listPreservedCopies(filePath, kind = "undecryptable") {
  const pattern = preservedPattern(kind);
  const directory = path.dirname(filePath);
  const base = path.basename(filePath);
  let names = [];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(base) && pattern.test(name.slice(base.length)))
    .map((name) => ({ path: path.join(directory, name), stamp: Number(pattern.exec(name.slice(base.length))[1]) }))
    .sort((left, right) => right.stamp - left.stamp);
}

// Returns { path, created }: the existing copy with identical bytes, or a new
// copy. Throws if the source cannot be read or the copy cannot be written, so
// callers keep their existing error handling.
function preserveUnreadableFile(filePath, options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const kind = options.kind || "undecryptable";
  const digest = sha256OfFile(filePath);
  for (const copy of listPreservedCopies(filePath, kind)) {
    try {
      if (sha256OfFile(copy.path) === digest) return { path: copy.path, created: false };
    } catch {
      // An unreadable earlier copy is not proof of a duplicate; keep looking.
    }
  }
  const stamp = now();
  let target = `${filePath}.${kind}-${stamp}.backup`;
  for (let attempt = 1; fs.existsSync(target); attempt += 1) {
    target = `${filePath}.${kind}-${stamp}-${attempt}.backup`;
  }
  fs.copyFileSync(filePath, target, fs.constants.COPYFILE_EXCL);
  return { path: target, created: true };
}

module.exports = { listPreservedCopies, preserveUnreadableFile };
