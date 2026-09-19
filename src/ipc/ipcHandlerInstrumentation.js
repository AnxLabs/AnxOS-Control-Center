// SMOOTH-3011 / SMOOTH-3010: IPC handler instrumentation, extracted from main.js
// so the wrapper is require-able and behaviourally testable without Electron.
//
// `instrumentIpcHandlers` replaces `ipcMain.handle` with a wrapper that:
//   (a) refuses new requests once the app is shutting down (APPLICATION_SHUTTING_DOWN),
//   (b) times each call and logs "IPC request started" / "IPC request completed {durationMs}",
//   (c) optionally measures payload bytes under ANXOS_IPC_BYTE_METRICS=1, and
//   (d) shares an `instances:list` reply with the alert scheduler, so an evaluation
//       pass reuses the payload the renderer already polled instead of repeating
//       the agent fetch.
//
// Dependency injection only: this module requires NOTHING, and in particular must
// never require main.js — that would be a require cycle. `main.js` owns the lazy
// `require("./src/services/alertService")` and passes a thin publish closure, so
// the module stays free of service dependencies at load time.
//
// SMOOTH-3011: opt-in IPC payload-size instrumentation.
//
// `context.durationMs` on the completed IPC record is this project's timing
// instrument, but it says nothing about HOW MUCH was moved, so a payload-cost
// change (e.g. trimming an instance snapshot) has no direct measurement. This
// records `context.payloadBytes` alongside `durationMs` to close that gap.
//
// The default path is deliberately untouched: measurement is gated on an
// environment flag read once at module load, and when it is off the completed
// context object literal is exactly what it was before. The gate is not just
// about the flag check — measuring at all is only worth it for payloads whose
// size is cheap to read. Strings and binary buffers expose their byte length
// without allocating; object/array payloads do not, and re-serializing a
// multi-megabyte instance snapshot (or docker/log tail) purely to count its
// bytes would cost more than the IPC call being measured. Those are skipped by
// design and report no `payloadBytes`, rather than paying to measure them.
const IPC_PAYLOAD_BYTES_ENABLED = process.env.ANXOS_IPC_BYTE_METRICS === "1";

// >>> ipc-payload-metrics:measure (self-contained; extracted and executed verbatim by scripts/ipc-payload-instrument-smoke.js) <<<
function measureIpcPayloadBytes(value) {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (Buffer.isBuffer(value) || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength;
  return null;
}
// <<< ipc-payload-metrics:measure <<<

// `isShuttingDown` is a live getter (main.js passes `() => appShuttingDown`), so the
// guard reads the current flag at call time exactly as the in-main.js closure did.
// `payloadBytesEnabled` defaults to the module-load env read above, so the shipped
// gate is unchanged; it is injectable purely so a suite can exercise both states
// deterministically instead of mutating the environment.
function instrumentIpcHandlers({
  ipcMain,
  diagnostics,
  isShuttingDown = () => false,
  publishInstanceSnapshot,
  payloadBytesEnabled = IPC_PAYLOAD_BYTES_ENABLED,
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") {
    throw new TypeError("instrumentIpcHandlers requires an ipcMain with a handle() function.");
  }
  if (!diagnostics || typeof diagnostics.log !== "function" || typeof diagnostics.logError !== "function" || typeof diagnostics.correlationId !== "function") {
    throw new TypeError("instrumentIpcHandlers requires the diagnostics service (log/logError/correlationId).");
  }
  if (typeof publishInstanceSnapshot !== "function") {
    throw new TypeError("instrumentIpcHandlers requires a publishInstanceSnapshot(nodeId, payload) function.");
  }
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, listener) => register(channel, async (...args) => {
    if (isShuttingDown()) {
      throw Object.assign(new Error("The application is shutting down and cannot accept new requests."), { code: "APPLICATION_SHUTTING_DOWN" });
    }
    const correlationId = diagnostics.correlationId("ipc");
    const startedAt = Date.now();
    diagnostics.log("info", "ipc", channel, "IPC request started", {}, { file: "ipc", correlationId });
    try {
      const result = await listener(...args);
      // SMOOTH-3010: share the instance list the renderer already polls with the
      // alert scheduler, so an evaluation pass does not repeat the agent fetch
      // (or re-trigger the implicit-node fallback). Best-effort: a share failure
      // must never affect the IPC reply.
      if (channel === "instances:list") {
        try { publishInstanceSnapshot(args[1]?.nodeId, result); } catch {}
      }
      const completedContext = { durationMs: Date.now() - startedAt };
      if (payloadBytesEnabled) {
        const payloadBytes = measureIpcPayloadBytes(result);
        if (payloadBytes !== null) completedContext.payloadBytes = payloadBytes;
      }
      diagnostics.log("info", "ipc", channel, "IPC request completed", completedContext, { file: "ipc", correlationId });
      return result;
    } catch (error) {
      diagnostics.logError("ipc", channel, error, { durationMs: Date.now() - startedAt }, { file: "ipc", correlationId });
      throw error;
    }
  });
}

module.exports = {
  IPC_PAYLOAD_BYTES_ENABLED,
  instrumentIpcHandlers,
  measureIpcPayloadBytes,
};