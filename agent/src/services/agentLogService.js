"use strict";

// Read-only access to the Agent's own structured log. The log directory is
// resolved exactly like agent/src/services/diagnosticsLogger.js resolves it, so
// `logs`, `diagnostics`, and the TUI all read the same file the runtime writes.
// Token material never reaches this layer in practice (the structured logger
// sanitizes entries before writing), and every line is passed through the
// shared redaction utility anyway.

const fs = require("fs");
const path = require("path");
const { redactString } = require("../../../src/shared/redaction");

const DEFAULT_LINES = 50;
const MAX_LINES = 2000;
const TAIL_READ_BYTES = 64 * 1024;
// The packaged unit writes here (packaging/agent-deb/anxos-agent.service). Used
// only when the configured log directory holds no agent.log: a root shell that
// never inherited ANXOS_LOG_DIR would otherwise read the wrong directory.
const FALLBACK_LOG_PATH = "/var/log/anxos-agent/agent.log";

function resolveLogDirectory(env = process.env) {
  if (trim(env.ANXOS_LOG_DIR)) return trim(env.ANXOS_LOG_DIR);
  const repositoryRoot = path.resolve(__dirname, "..", "..", "..");
  if (env.NODE_ENV === "development" || fs.existsSync(path.join(repositoryRoot, ".git"))) {
    return path.join(repositoryRoot, ".dev-logs");
  }
  return path.join(env.ANXHUB_CONFIG_DIR ? path.dirname(env.ANXHUB_CONFIG_DIR) : process.cwd(), "logs");
}

function trim(value) {
  return typeof value === "string" ? value.trim() : "";
}

// Bounded tail read: never loads a multi-megabyte log whole. The window widens
// only while it cannot prove it holds more than `lineLimit` complete lines.
function readLogTailText(filePath, lineLimit) {
  const limit = Number.isFinite(lineLimit) ? Math.trunc(lineLimit) : 0;
  if (limit <= 0) return fs.readFileSync(filePath, "utf8");
  const { size } = fs.statSync(filePath);
  let windowBytes = TAIL_READ_BYTES;
  for (;;) {
    const start = size > windowBytes ? size - windowBytes : 0;
    const readStart = start > 0 ? start - 1 : 0;
    const length = size - readStart;
    const buffer = Buffer.allocUnsafe(length);
    const handle = fs.openSync(filePath, "r");
    let read = 0;
    try {
      while (read < length) {
        const bytesRead = fs.readSync(handle, buffer, read, length - read, readStart + read);
        if (bytesRead <= 0) break;
        read += bytesRead;
      }
    } finally {
      fs.closeSync(handle);
    }

    let content = buffer.subarray(0, read).toString("utf8");
    if (readStart > 0 && content.charCodeAt(0) !== 10) {
      const firstBreak = content.indexOf("\n");
      content = firstBreak === -1 ? "" : content.slice(firstBreak + 1);
    }
    const lineCount = content === "" ? 0 : content.split(/\r?\n/).filter(Boolean).length;
    if (start === 0 || lineCount > limit) return content;
    windowBytes = Math.min(size, windowBytes * 2);
  }
}

// Resolve which file to read. The configured path wins whenever it exists;
// otherwise the packaged fallback is used so a shell without the unit's
// environment still finds the log. Callers that pass an explicit filePath get
// that path, with the same existence-based fallback.
function resolveLogFile(options = {}) {
  const directory = options.directory || resolveLogDirectory(options.env || process.env);
  const primaryPath = options.filePath || path.join(directory, "agent.log");
  const fallbackPath = options.fallbackPath || FALLBACK_LOG_PATH;
  if (primaryPath !== fallbackPath && !fs.existsSync(primaryPath) && fs.existsSync(fallbackPath)) {
    return { path: fallbackPath, primaryPath, fallbackUsed: true };
  }
  return { path: primaryPath, primaryPath, fallbackUsed: false };
}

/**
 * Tail the Agent log. Returns a result object instead of throwing so callers
 * can render "no log file yet" without treating it as a crash.
 */
function readAgentLogTail(options = {}) {
  const env = options.env || process.env;
  const requestedLines = Number.parseInt(options.lines, 10);
  const lines = Number.isFinite(requestedLines) && requestedLines > 0
    ? Math.min(requestedLines, MAX_LINES)
    : DEFAULT_LINES;
  const directory = options.directory || resolveLogDirectory(env);
  const { path: filePath, primaryPath, fallbackUsed } = resolveLogFile({
    directory,
    filePath: options.filePath,
    fallbackPath: options.fallbackPath,
    env,
  });

  try {
    if (!fs.existsSync(filePath)) {
      const candidates = primaryPath === filePath ? filePath : `${primaryPath} or ${filePath}`;
      return {
        ok: false,
        path: filePath,
        primaryPath,
        fallbackUsed: false,
        lines: [],
        errorCode: "AGENT_LOG_MISSING",
        message: `No Agent log file was found at ${candidates}.`,
      };
    }
    const text = readLogTailText(filePath, lines);
    const tail = text.split(/\r?\n/).filter(Boolean).slice(-lines);
    return {
      ok: true,
      path: filePath,
      primaryPath,
      lines: tail.map((line) => redactString(line)),
      requestedLines: lines,
      ...(fallbackUsed
        ? {
          fallbackUsed: true,
          note: `The configured Agent log directory had no log file; reading ${filePath}.`,
        }
        : {}),
    };
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      primaryPath,
      fallbackUsed,
      lines: [],
      errorCode: error?.code || "AGENT_LOG_READ_FAILED",
      message: `The Agent log at ${filePath} could not be read.`,
    };
  }
}

module.exports = {
  DEFAULT_LINES,
  FALLBACK_LOG_PATH,
  MAX_LINES,
  readAgentLogTail,
  readLogTailText,
  resolveLogDirectory,
  resolveLogFile,
};
