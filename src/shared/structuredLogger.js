const fs = require("fs");
const path = require("path");
const { sanitizeForDiagnostics } = require("./redaction");

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_RETAINED_FILES = 3;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function safeWriteJson(filePath, value) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(sanitizeForDiagnostics(value), null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, filePath);
    return true;
  } catch { return false; }
}

class StructuredLogger {
  constructor(options = {}) {
    this.directory = options.directory;
    this.source = options.source || "anxos";
    this.processName = options.processName || "main";
    this.appVersion = options.appVersion || null;
    this.agentVersion = options.agentVersion || null;
    this.maxBytes = Number(options.maxBytes || DEFAULT_MAX_BYTES);
    this.retainedFiles = Number(options.retainedFiles || DEFAULT_RETAINED_FILES);
    this.retentionMs = Number(options.retentionMs || DEFAULT_RETENTION_MS);
    this.live = options.live !== false;
    this.cleanup();
  }

  getPath(name) { return path.join(this.directory, `${name}.log`); }

  rotate(filePath) {
    try {
      if (!fs.existsSync(filePath) || fs.statSync(filePath).size < this.maxBytes) return;
      for (let index = this.retainedFiles - 1; index >= 1; index -= 1) {
        const from = `${filePath}.${index}`;
        const to = `${filePath}.${index + 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, to);
      }
      fs.renameSync(filePath, `${filePath}.1`);
    } catch {}
  }

  cleanup() {
    try {
      const cutoff = Date.now() - this.retentionMs;
      for (const entry of fs.readdirSync(this.directory, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.log\.\d+$/.test(entry.name)) continue;
        const filePath = path.join(this.directory, entry.name);
        if (fs.statSync(filePath).mtimeMs < cutoff || Number(entry.name.match(/\.(\d+)$/)?.[1] || 0) > this.retainedFiles) fs.rmSync(filePath, { force: true });
      }
    } catch {}
  }

  write(level, operation, message, context = {}, options = {}) {
    try {
      const entry = sanitizeForDiagnostics({
        timestamp: new Date().toISOString(), severity: level, source: options.source || this.source,
        process: options.process || this.processName, operation: operation || "event", message: String(message || ""),
        errorCode: options.errorCode || context?.code || null, stack: options.stack || context?.stack || null,
        correlationId: options.correlationId || context?.correlationId || null, platform: process.platform,
        appVersion: this.appVersion, agentVersion: this.agentVersion, context,
      });
      fs.mkdirSync(this.directory, { recursive: true });
      const subsystem = String(options.file || this.source || "desktop").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
      for (const filePath of [this.getPath(subsystem), ...(this.live ? [this.getPath("live")] : [])]) {
        this.rotate(filePath);
        fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      }
      if (level === "error" || level === "fatal") safeWriteJson(path.join(this.directory, "latest-error.json"), entry);
      return entry;
    } catch { return null; }
  }

  info(operation, message, context, options) { return this.write("info", operation, message, context, options); }
  warn(operation, message, context, options) { return this.write("warn", operation, message, context, options); }
  error(operation, error, context = {}, options = {}) {
    const normalized = error instanceof Error ? error : new Error(String(error?.message || error || "Unknown error"));
    return this.write("error", operation, normalized.message, { ...context, error: normalized }, { ...options, errorCode: normalized.code || options.errorCode, stack: normalized.stack });
  }
  snapshot(name, value) { return safeWriteJson(path.join(this.directory, name), value); }
}

module.exports = { DEFAULT_MAX_BYTES, StructuredLogger, safeWriteJson };
