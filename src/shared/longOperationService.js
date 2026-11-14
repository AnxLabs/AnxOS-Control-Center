const fs = require("fs");
const path = require("path");
const { SENSITIVE_KEY, redactString } = require("./redaction");

// This module is shared by both the Electron desktop process and the
// standalone Agent runtime (which never has the "electron" package
// available), so structured logging is soft-loaded and falls back to
// console output rather than hard-depending on diagnosticsService.
let diagnostics = null;
try {
  diagnostics = require("../services/diagnosticsService");
} catch {
  diagnostics = null;
}

function logEvent(level, operation, message, context = {}) {
  if (diagnostics && typeof diagnostics.log === "function") {
    diagnostics.log(level, "operations", operation, message, context, { file: "operations" });
    return;
  }
  const logger = level === "error" || level === "warn" ? console.warn : console.info;
  logger(`[LongOperation][${operation}]`, message, context);
}

const ACTIVE_STATUSES = new Set(["queued", "running", "paused"]);
const TERMINAL_STATUSES = new Set(["complete", "failed", "cancelled", "interrupted"]);
const PERSIST_DEBOUNCE_MS = 300;
const MAX_LOG_ENTRIES = 50;
// Finished operations kept in memory and on disk. The whole store is rewritten
// on every update, and without a limit it only grew (135 records back to
// July, 446 KB, on a real machine). Active operations are never dropped.
const MAX_FINISHED_OPERATIONS = 100;

function pruneFinishedOperations() {
  const finished = [...operations.values()].filter((operation) => !ACTIVE_STATUSES.has(operation.status));
  if (finished.length <= MAX_FINISHED_OPERATIONS) return;
  const stamp = (operation) => Date.parse(operation.updatedAt || operation.completedAt || operation.createdAt || "") || 0;
  finished.sort((left, right) => stamp(right) - stamp(left));
  for (const operation of finished.slice(MAX_FINISHED_OPERATIONS)) {
    operations.delete(operation.id);
  }
}
const OPERATION_SCHEMA_VERSION = 1;

class LongOperationError extends Error {
  constructor(message, code = "OPERATION_ERROR", details = {}) {
    super(message);
    this.name = "LongOperationError";
    this.code = code;
    this.details = details;
  }
}

const operations = new Map();
const runtimeHandlers = new Map();
let loaded = false;
let persistTimer = null;
let pendingPersist = false;

function getElectronApp() {
  try {
    const electron = require("electron");
    return electron && typeof electron === "object" ? electron.app || null : null;
  } catch {
    return null;
  }
}

function getConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) {
    return process.env.ANXHUB_CONFIG_DIR;
  }
  const app = getElectronApp();
  try {
    return app ? path.join(app.getPath("userData"), "config") : path.join(process.cwd(), "config");
  } catch {
    return path.join(process.cwd(), "config");
  }
}

function getOperationsStatePath() {
  return path.join(getConfigDirectory(), "long-operations.json");
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sanitizeForPersistence(value, seen = new WeakSet()) {
  if (value === null || value === undefined) {
    return value;
  }
  const type = typeof value;
  if (type === "function" || type === "symbol") {
    return undefined;
  }
  if (type === "string") {
    return redactString(value);
  }
  if (type !== "object") {
    return value;
  }
  if (seen.has(value)) {
    return undefined;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeForPersistence(item, seen))
      .filter((item) => item !== undefined);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (!isPlainObject(value)) {
    return undefined;
  }
  const result = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) {
      result[key] = "[redacted]";
      continue;
    }
    const sanitizedEntry = sanitizeForPersistence(entryValue, seen);
    if (sanitizedEntry !== undefined) {
      result[key] = sanitizedEntry;
    }
  }
  return result;
}

function atomicWriteJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function flushPersist() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingPersist = false;
  try {
    pruneFinishedOperations();
    const snapshot = [...operations.values()].map((operation) => sanitizeForPersistence(operation));
    atomicWriteJson(getOperationsStatePath(), { schemaVersion: OPERATION_SCHEMA_VERSION, operations: snapshot });
  } catch (error) {
    logEvent("warn", "persist-failed", "Long-operation state could not be persisted.", {
      errorCode: error?.code || "OPERATION_PERSIST_FAILED",
    });
  }
}

function schedulePersist() {
  pendingPersist = true;
  if (persistTimer) {
    return;
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (pendingPersist) {
      flushPersist();
    }
  }, PERSIST_DEBOUNCE_MS);
  if (typeof persistTimer.unref === "function") {
    persistTimer.unref();
  }
}

function loadPersistedOperations() {
  const statePath = getOperationsStatePath();
  if (!fs.existsSync(statePath)) {
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (error) {
    const backupPath = `${statePath}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(statePath, backupPath, fs.constants.COPYFILE_EXCL);
    } catch {
      // Preserve the original in place even when a diagnostic copy cannot be made.
    }
    throw new LongOperationError(
      "Long-operation recovery data is unreadable. The original file was preserved for recovery.",
      "OPERATION_STATE_CORRUPT",
      { causeCode: error?.code || "INVALID_JSON" },
    );
  }
  const schemaVersion = Number.isInteger(parsed?.schemaVersion) ? parsed.schemaVersion : 0;
  if (schemaVersion > OPERATION_SCHEMA_VERSION) {
    throw new LongOperationError(
      "Long-operation recovery data was created by a newer application version.",
      "OPERATION_SCHEMA_UNSUPPORTED",
      { schemaVersion, supportedSchemaVersion: OPERATION_SCHEMA_VERSION },
    );
  }
  const persisted = Array.isArray(parsed?.operations) ? parsed.operations : [];
  for (const entry of persisted) {
    if (!entry?.id) {
      continue;
    }
    const interrupted = ACTIVE_STATUSES.has(entry.status);
    operations.set(entry.id, {
      ...entry,
      status: interrupted ? "interrupted" : entry.status,
      error: interrupted
        ? {
            code: "INTERRUPTED_BY_RESTART",
            message: "This operation was interrupted by an application restart and could not resume automatically.",
          }
        : entry.error || null,
      canCancel: false,
      // Runtime handlers are intentionally not persisted. A recovered record
      // cannot advertise retry until its owning service registers a new
      // executable recovery handler.
      canRetry: false,
      updatedAt: new Date().toISOString(),
    });
  }
}

function ensureLoaded() {
  if (loaded) {
    return;
  }
  loadPersistedOperations();
  loaded = true;
}

function clearTimeoutHandler(id) {
  const runtime = runtimeHandlers.get(id);
  if (runtime?.timeoutHandle) {
    clearTimeout(runtime.timeoutHandle);
    runtime.timeoutHandle = null;
  }
}

function scheduleOperationTimeout(id, timeoutMs) {
  clearTimeoutHandler(id);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return;
  }
  const runtime = runtimeHandlers.get(id) || {};
  runtime.timeoutHandle = setTimeout(async () => {
    const operation = operations.get(id);
    if (!operation || !ACTIVE_STATUSES.has(operation.status)) return;
    const activeRuntime = runtimeHandlers.get(id);
    if (typeof activeRuntime?.onCancel !== "function") {
      updateOperation(id, {
        stage: "timeout-exceeded",
        message: "The expected duration was exceeded; the underlying task is still running and its lock remains held.",
        logs: [{ level: "warning", message: "Timeout exceeded without a cancellation handler; operation remains active." }],
      });
      return;
    }
    try {
      await activeRuntime.onCancel();
      failOperation(id, { code: "OPERATION_TIMEOUT", message: "This operation timed out and its underlying task was cancelled." }, { retryable: true });
    } catch (error) {
      updateOperation(id, {
        stage: "timeout-cancel-failed",
        message: "The expected duration was exceeded, but cancellation could not be confirmed; the operation remains locked.",
        logs: [{ level: "error", message: "Timeout cancellation failed; operation remains active.", code: error?.code || "CANCEL_HANDLER_FAILED" }],
      });
    }
  }, timeoutMs);
  if (typeof runtime.timeoutHandle.unref === "function") {
    runtime.timeoutHandle.unref();
  }
  runtimeHandlers.set(id, runtime);
}

function appendLogEntry(operation, entry) {
  if (!entry) {
    return;
  }
  const logs = Array.isArray(operation.logs) ? operation.logs : [];
  logs.push({
    at: new Date().toISOString(),
    level: entry.level || "info",
    message: entry.message || "",
    ...entry,
  });
  operation.logs = logs.slice(-MAX_LOG_ENTRIES);
}

function logOperationEvent(event, operation) {
  logEvent("info", event, `Long operation ${event}.`, {
    id: operation.id,
    kind: operation.kind,
    nodeId: operation.nodeId,
    status: operation.status,
    stage: operation.stage,
  });
}

function findActiveByLockKey(lockKey) {
  ensureLoaded();
  if (!lockKey) {
    return null;
  }
  for (const operation of operations.values()) {
    if (operation.lockKey === lockKey && ACTIVE_STATUSES.has(operation.status)) {
      return operation;
    }
  }
  return null;
}

function buildOperation(id, spec = {}, existing = null) {
  const now = new Date().toISOString();
  const status = spec.status || existing?.status || "queued";
  return {
    id,
    kind: spec.kind || existing?.kind || "generic",
    nodeId: spec.nodeId !== undefined ? spec.nodeId : existing?.nodeId ?? null,
    lockKey: spec.lockKey !== undefined ? spec.lockKey : existing?.lockKey ?? null,
    status,
    stage: spec.stage !== undefined ? spec.stage : existing?.stage ?? null,
    message: spec.message !== undefined ? spec.message : existing?.message ?? null,
    progress: spec.progress !== undefined ? spec.progress : existing?.progress ?? null,
    progressMode: spec.progressMode || existing?.progressMode || "indeterminate",
    error: spec.error !== undefined ? spec.error : existing?.error ?? null,
    canCancel: spec.canCancel !== undefined ? Boolean(spec.canCancel) : Boolean(existing?.canCancel),
    canRetry: spec.canRetry !== undefined ? Boolean(spec.canRetry) : Boolean(existing?.canRetry),
    retryable: spec.retryable !== undefined ? Boolean(spec.retryable) : Boolean(existing?.retryable),
    // Explicit and honest: only true when a caller has actually implemented a
    // rollback path for this operation kind. Defaults to false rather than
    // being inferred, so an operation can never silently claim a capability
    // that has no working code behind it.
    rollbackSupported: spec.rollbackSupported !== undefined ? Boolean(spec.rollbackSupported) : Boolean(existing?.rollbackSupported),
    startedAt: existing?.startedAt || now,
    updatedAt: now,
    completedAt: TERMINAL_STATUSES.has(status) ? existing?.completedAt || now : existing?.completedAt || null,
    timeoutMs: spec.timeoutMs !== undefined ? spec.timeoutMs : existing?.timeoutMs ?? null,
    parentId: spec.parentId !== undefined ? spec.parentId : existing?.parentId ?? null,
    childIds: spec.childIds || existing?.childIds || [],
    logs: existing?.logs || [],
    metadata: spec.metadata !== undefined ? spec.metadata : existing?.metadata ?? null,
  };
}

function createOperation(spec = {}) {
  ensureLoaded();
  if (spec.lockKey) {
    const duplicate = findActiveByLockKey(spec.lockKey);
    if (duplicate) {
      throw new LongOperationError(
        "An operation with this lock key is already in progress.",
        "DUPLICATE_OPERATION",
        { existingOperationId: duplicate.id, lockKey: spec.lockKey },
      );
    }
  }
  const id = spec.id || `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const operation = buildOperation(id, { ...spec, status: spec.status || "queued" });
  operations.set(id, operation);
  if (spec.timeoutMs) {
    scheduleOperationTimeout(id, spec.timeoutMs);
  }
  logOperationEvent("created", operation);
  flushPersist();
  return operation;
}

function upsertOperation(id, patch = {}) {
  ensureLoaded();
  if (!id) {
    throw new LongOperationError("An operation id is required.", "OPERATION_ID_REQUIRED");
  }
  const existing = operations.get(id);
  const operation = buildOperation(id, patch, existing);
  if (Array.isArray(patch.logs)) {
    patch.logs.forEach((entry) => appendLogEntry(operation, entry));
  }
  operations.set(id, operation);
  if (patch.timeoutMs) {
    scheduleOperationTimeout(id, patch.timeoutMs);
  }
  if (TERMINAL_STATUSES.has(operation.status)) {
    clearTimeoutHandler(id);
    flushPersist();
  } else {
    schedulePersist();
  }
  return operation;
}

function updateOperation(id, patch = {}) {
  const existing = operations.get(id);
  if (!existing) {
    throw new LongOperationError("Operation was not found.", "OPERATION_NOT_FOUND", { id });
  }
  return upsertOperation(id, patch);
}

function completeOperation(id, patch = {}) {
  return updateOperation(id, {
    ...patch,
    status: "complete",
    progress: patch.progress !== undefined ? patch.progress : 100,
    progressMode: "determinate",
    error: null,
    canRetry: false,
    canCancel: false,
  });
}

function failOperation(id, error = {}, patch = {}) {
  const hasRetryHandler = typeof runtimeHandlers.get(id)?.onRetry === "function";
  return updateOperation(id, {
    ...patch,
    status: "failed",
    error: {
      code: error.code || "OPERATION_FAILED",
      message: error.message || "This operation failed.",
    },
    canRetry: patch.retryable !== undefined ? Boolean(patch.retryable) && hasRetryHandler : hasRetryHandler,
    canCancel: false,
  });
}

async function cancelOperation(id) {
  const operation = operations.get(id);
  if (!operation) {
    throw new LongOperationError("Operation was not found.", "OPERATION_NOT_FOUND", { id });
  }
  if (!operation.canCancel) {
    throw new LongOperationError("This operation cannot be cancelled.", "OPERATION_NOT_CANCELLABLE", { id });
  }
  const runtime = runtimeHandlers.get(id);
  if (typeof runtime?.onCancel !== "function") {
    throw new LongOperationError("This operation is marked cancellable but no cancellation handler was registered.", "OPERATION_CANCEL_HANDLER_MISSING", { id });
  }
  try {
    await runtime.onCancel();
  } catch (error) {
    logEvent("warn", "cancel-handler-failed", "Long-operation cancel handler threw an error.", {
      id,
      errorCode: error?.code || "CANCEL_HANDLER_FAILED",
    });
    throw new LongOperationError("The underlying task could not be cancelled.", "OPERATION_CANCEL_FAILED", { id, causeCode: error?.code || null });
  }
  return updateOperation(id, { status: "cancelled", canCancel: false, canRetry: true });
}

async function retryOperation(id) {
  const operation = operations.get(id);
  if (!operation) {
    throw new LongOperationError("Operation was not found.", "OPERATION_NOT_FOUND", { id });
  }
  if (!operation.canRetry) {
    throw new LongOperationError("This operation cannot be retried.", "OPERATION_NOT_RETRYABLE", { id });
  }
  const runtime = runtimeHandlers.get(id);
  if (typeof runtime?.onRetry !== "function") {
    // Distinct from OPERATION_NOT_RETRYABLE: this means the operation claims
    // canRetry=true but no real retry implementation was wired up for it,
    // which is itself a bug in the caller rather than a normal rejection.
    throw new LongOperationError("This operation is marked retryable but no retry handler was registered.", "OPERATION_RETRY_HANDLER_MISSING", { id });
  }
  return runtime.onRetry();
}

function registerCancelHandler(id, handler) {
  const runtime = runtimeHandlers.get(id) || {};
  runtime.onCancel = typeof handler === "function" ? handler : null;
  runtimeHandlers.set(id, runtime);
}

function registerRetryHandler(id, handler) {
  const runtime = runtimeHandlers.get(id) || {};
  runtime.onRetry = typeof handler === "function" ? handler : null;
  runtimeHandlers.set(id, runtime);
}

function getOperation(id) {
  ensureLoaded();
  return operations.get(id) || null;
}

function listOperations(filter = {}) {
  ensureLoaded();
  return [...operations.values()].filter((operation) => {
    if (filter.kind && operation.kind !== filter.kind) return false;
    if (filter.nodeId && operation.nodeId !== filter.nodeId) return false;
    if (filter.status && operation.status !== filter.status) return false;
    return true;
  });
}

function deleteOperation(id) {
  ensureLoaded();
  clearTimeoutHandler(id);
  runtimeHandlers.delete(id);
  const existed = operations.delete(id);
  if (existed) {
    flushPersist();
  }
  return existed;
}

module.exports = {
  ACTIVE_STATUSES,
  LongOperationError,
  OPERATION_SCHEMA_VERSION,
  TERMINAL_STATUSES,
  cancelOperation,
  completeOperation,
  createOperation,
  deleteOperation,
  failOperation,
  findActiveByLockKey,
  getOperation,
  getOperationsStatePath,
  listOperations,
  registerCancelHandler,
  registerRetryHandler,
  retryOperation,
  updateOperation,
  upsertOperation,
  _test: {
    flushPersist,
    sanitizeForPersistence,
  },
};
