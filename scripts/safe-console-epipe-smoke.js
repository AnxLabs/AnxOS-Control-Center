// Regression smoke for BUG #1: a console write to a closed/broken pipe must
// never propagate and crash the process. Console.info/warn/error/log are
// best-effort diagnostics, so an EPIPE/closed-pipe write error must be
// swallowed, while any other (unexpected) write error must still be thrown.

const assert = require("assert");
const safeConsole = require("../src/shared/safeConsole");

function makeWriteError(code) {
  const error = new Error("write to closed pipe");
  error.code = code;
  throw error;
}

const ORIGINALS = {
  info: console.info && console.info.bind(console),
  warn: console.warn && console.warn.bind(console),
  error: console.error && console.error.bind(console),
  log: console.log && console.log.bind(console),
};

function restoreConsole() {
  for (const key of ["info", "warn", "error", "log"]) {
    if (ORIGINALS[key]) console[key] = ORIGINALS[key];
  }
}

try {
  for (const code of ["EPIPE", "ECONNRESET", "EAGAIN", "EIO", "EBADF"]) {
    for (const level of ["info", "warn", "error", "log"]) {
      console[level] = () => makeWriteError(code);
      let threw = false;
      try {
        safeConsole[level]("epipe", "regression");
      } catch {
        threw = true;
      }
      assert(!threw, `safeConsole.${level} must swallow a ${code} write error.`);
    }
  }

  // A technically-unrelated write error (not a broken pipe) must still surface.
  for (const level of ["info", "warn", "error", "log"]) {
    console[level] = () => { throw new Error("disk is full"); };
    let threw = false;
    try {
      safeConsole[level]("non-pipe", "regression");
    } catch {
      threw = true;
    }
    assert(threw, `safeConsole.${level} must re-throw a non-broken-pipe write error.`);
  }

  // With no console.* method bound, safeConsole must no-op without throwing.
  for (const level of ["info", "warn", "error", "log"]) {
    console[level] = undefined;
    let threw = false;
    try {
      safeConsole[level]("missing", "regression");
    } catch {
      threw = true;
    }
    assert(!threw, `safeConsole.${level} must no-op when the console method is undefined.`);
  }

  restoreConsole();
  console.log("Safe console EPIPE smoke checks passed.");
} finally {
  restoreConsole();
}