// V2-J bullet 2 (correlation): one correlation context primitive shared by the
// desktop main process and the standalone Agent runtime.
//
// Canonical field name: `correlationId`.
//
// That name is NOT new — it is the id the log entry schema has always carried
// (`StructuredLogger.write`), the id the diagnostics IPC surface accepts
// (`src/ipc/diagnosticsIpc.js`), and the id `diagnosticsService.correlationId()`
// already mints for agent process logging. The sibling ids that already exist
// elsewhere are reused as join keys instead of being renamed or duplicated:
//   - `jobId`       durable job record id (`src/shared/instances/jobLifecycle`)
//   - `operationId` long-running operation id (`src/shared/longOperationService`)
// A correlation scope carries `correlationId` plus those two optional join keys
// so a user operation, its backend job, the Agent actions it triggers and the
// workload log lines it produces can be joined on ids that already exist. This
// module never mints a fourth id concept.
//
// Redaction safety: ids minted here are opaque (`<prefix>-<uuid>`), never
// derived from user input, and never contain a path, token or secret. The
// prefix must already be a lowercase operation label (`[a-z][a-z0-9-]{0,23}`) —
// anything else, including a path, token or free-form request input, falls back
// to the neutral `corr` prefix instead of being sanitized into the id, so a
// caller cannot smuggle request input into a log field through this API.
// `createCorrelationScope`/`correlationMetadata` likewise accept an externally
// supplied id only when it already matches the opaque shape. The legacy
// `StructuredLogger.write` resolution (explicit option, then
// `context.correlationId`) is unchanged and is tried before the ambient scope,
// so existing callers keep exactly the behavior they had.
//
// Propagation is ambient (AsyncLocalStorage): a scope entered with
// `runWithCorrelationScope`/`withOperationScope` attaches its id to every log
// entry written inside it — including entries written by services this module
// has never heard of — and to the boundaries that opt in via
// `correlationMetadata()` (job records, workload log lines, Agent action audit
// lines). Without an active scope nothing changes anywhere.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { AsyncLocalStorage } = require("async_hooks");
const { sanitizeForDiagnostics } = require("./redaction");

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_RETAINED_FILES = 3;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Canonical correlation field name (see the module header). Exported so callers
// never have to hardcode the spelling.
const CORRELATION_ID_FIELD = "correlationId";
const CORRELATION_ID_PREFIX = "corr";
// Wire header carrying an operation's correlation id between the desktop main
// process and a standalone Agent runtime. Declared in this shared module (both
// processes already require it) so the two ends of the header cannot drift.
const CORRELATION_HEADER = "x-anxos-correlation-id";
// An operation label may be a correlation-id prefix verbatim; nothing else is.
// Enforced as an allowlist (never a sanitizer) so unrelated characters cannot
// be transformed into an id that still looks opaque while carrying input.
const CORRELATION_PREFIX_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;
// `<prefix>-<uuid v4>`: the only shape this module mints or accepts from a
// caller. Anything else (paths, tokens, free-form request input) is rejected.
const CORRELATION_ID_PATTERN = /^[a-z][a-z0-9-]{0,23}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_LENGTH = 36;
const MAX_JOIN_KEY_LENGTH = 128;
const JOIN_KEY_PATTERN = /^[A-Za-z0-9_.:@-]{1,128}$/;
const correlationStorage = new AsyncLocalStorage();

function normalizeCorrelationPrefix(prefix, fallback = CORRELATION_ID_PREFIX) {
  const raw = typeof prefix === "string" ? prefix.trim() : "";
  return CORRELATION_PREFIX_PATTERN.test(raw) ? raw : fallback;
}

function createCorrelationId(prefix = CORRELATION_ID_PREFIX) {
  return `${normalizeCorrelationPrefix(prefix)}-${crypto.randomUUID()}`;
}

function isCorrelationId(value) {
  return typeof value === "string" && CORRELATION_ID_PATTERN.test(value);
}

// Existing ids (jobId/operationId) are reused as-is; they are only bounded in
// length and rejected when they contain whitespace, separators or control
// characters, which keeps a path or token from riding in as a join key.
function normalizeJoinKey(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  return JOIN_KEY_PATTERN.test(raw) ? raw.slice(0, MAX_JOIN_KEY_LENGTH) : null;
}

function createCorrelationScope(options = {}) {
  const parent = correlationStorage.getStore() || null;
  const config = typeof options === "string" ? { prefix: options } : (options && typeof options === "object" ? options : {});
  // A nested scope inherits the parent id (that is the point of correlation: a
  // job, an Agent action and a workload log line belong to the user operation
  // that caused them). An explicit, opaque id starts a new root scope instead.
  const requested = isCorrelationId(config.correlationId) ? config.correlationId : null;
  const id = requested || parent?.id || createCorrelationId(config.prefix);
  return Object.freeze({
    id,
    // Derived from the id so the prefix can never disagree with it.
    prefix: id.slice(0, Math.max(0, id.length - UUID_LENGTH - 1)),
    root: !parent,
    inherited: Boolean(parent && !requested),
    parentId: parent?.id || null,
    depth: parent ? parent.depth + 1 : 0,
    jobId: normalizeJoinKey(config.jobId) || parent?.jobId || null,
    operationId: normalizeJoinKey(config.operationId) || parent?.operationId || null,
    startedAt: new Date().toISOString(),
  });
}

// Returns the active scope when no callback is supplied, so a caller that owns
// its own control flow can still read the id without nesting.
function runWithCorrelationScope(options, fn) {
  const scope = createCorrelationScope(options);
  if (typeof fn !== "function") return scope;
  return correlationStorage.run(scope, fn);
}

function withOperationScope(prefix, fn) {
  return runWithCorrelationScope({ prefix }, fn);
}

function currentCorrelation() { return correlationStorage.getStore() || null; }

function currentCorrelationId() { return correlationStorage.getStore()?.id || null; }

// Existing join keys only: `correlationId`, plus `jobId`/`operationId` when the
// scope carries them. Spreadable into a log context or a record.
function correlationFields() {
  const scope = correlationStorage.getStore();
  if (!scope) return {};
  const fields = { [CORRELATION_ID_FIELD]: scope.id };
  if (scope.jobId) fields.jobId = scope.jobId;
  if (scope.operationId) fields.operationId = scope.operationId;
  return fields;
}

// Boundary helper: `{ correlationId }` when one is available, `{}` otherwise —
// so the caller can conditionally spread it and stay byte-identical to today
// when no correlation is in play.
function correlationMetadata(explicit) {
  const id = isCorrelationId(explicit) ? explicit : currentCorrelationId();
  return id ? { [CORRELATION_ID_FIELD]: id } : {};
}

// Ambient fallback for the logging entry points. Precedence matches the
// historical contract exactly: explicit option, then `context.correlationId`
// (both returned verbatim, as before), then the active scope.
function resolveEntryCorrelationId(options = {}, context = {}) {
  const explicit = options?.correlationId || context?.correlationId || null;
  return explicit === null ? currentCorrelationId() : explicit;
}

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
        correlationId: resolveEntryCorrelationId(options, context), platform: process.platform,
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

module.exports = {
  CORRELATION_HEADER,
  CORRELATION_ID_FIELD,
  CORRELATION_ID_PREFIX,
  DEFAULT_MAX_BYTES,
  StructuredLogger,
  correlationFields,
  correlationMetadata,
  createCorrelationId,
  createCorrelationScope,
  currentCorrelation,
  currentCorrelationId,
  isCorrelationId,
  resolveEntryCorrelationId,
  runWithCorrelationScope,
  safeWriteJson,
  withOperationScope,
};
