// Best-effort console facade that must never crash the process.
//
// Console writes target stdout/stderr, which can be a closed or broken pipe
// (for example when the app is launched from a terminal that has exited, or
// from a parent process that has detached its IO). A synchronous write to such
// a pipe throws EPIPE (and on Windows EAGAIN/EBADF/EIO variants), and an
// uncaught EPIPE from a best-effort log write can terminate the whole app.
// These diagnostics are never load-bearing, so we swallow pipe-closed errors
// silently and let any other unexpected error propagate unchanged.

const BROKEN_PIPE_CODES = new Set(["EPIPE", "ECONNRESET", "EAGAIN", "EIO", "EBADF"]);

function isBrokenPipeError(error) {
  if (error == null) return false;
  if (typeof error === "number") return BROKEN_PIPE_CODES.has(error);
  const code = error?.code || error?.errno;
  if (BROKEN_PIPE_CODES.has(String(code))) return true;
  const message = String(error?.message || error || "");
  return /broken pipe|closed pipe|pipe is being closed|error writing to stdout|EPIPE/i.test(message);
}

function emit(target, args) {
  if (typeof target !== "function") return;
  try {
    target(...args);
  } catch (error) {
    if (!isBrokenPipeError(error)) {
      throw error;
    }
  }
}

const safeConsole = {
  info: (...args) => emit(console.info && console.info.bind(console), args),
  warn: (...args) => emit(console.warn && console.warn.bind(console), args),
  error: (...args) => emit(console.error && console.error.bind(console), args),
  log: (...args) => emit(console.log && console.log.bind(console), args),
  emit,
  isBrokenPipeError,
};

module.exports = safeConsole;