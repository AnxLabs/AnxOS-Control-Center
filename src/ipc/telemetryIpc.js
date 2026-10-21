const { ipcMain } = require("electron");
const {
  clearTelemetry,
  exportTelemetry,
  getTelemetrySeries,
  getTelemetrySummary,
} = require("../services/telemetryService");
const { audit, requireLocalOwnerAuthenticated, requirePermission } = require("../services/securityService");
const { createIpcError } = require("../shared/ipcError");

// V2-K: sampled telemetry surface. The store is desktop-local, so the reads
// stay at telemetry:read for every observability tier and the destructive
// clear sits at telemetry:manage; export is its own tier so a future export
// policy can move without widening the reads. All channels are local-owner
// gated like their diagnostics neighbours, and each audited action is listed
// explicitly so a poll-heavy read is still attributable.
async function invokeTelemetryOperation(operation) {
  try {
    return await operation();
  } catch (error) {
    throw createIpcError(error, {
      code: "TELEMETRY_REQUEST_FAILED",
      fallbackMessage: "Telemetry request failed.",
      suggestion: "Review the telemetry diagnostics, correct the reported problem, then retry.",
    });
  }
}

function registerTelemetryIpc() {
  ipcMain.handle("telemetry:getSummary", async (_, payload = {}) => invokeTelemetryOperation(() => {
    requireLocalOwnerAuthenticated("telemetry:getSummary", "Unlock AnxOS to view telemetry.");
    requirePermission("telemetry:read", payload.nodeId);
    audit({ action: "telemetry.getSummary", target: payload.nodeId || "telemetry" });
    return getTelemetrySummary({ nodeId: payload.nodeId, sinceMs: payload.sinceMs });
  }));
  ipcMain.handle("telemetry:getSeries", async (_, payload = {}) => invokeTelemetryOperation(() => {
    requireLocalOwnerAuthenticated("telemetry:getSeries", "Unlock AnxOS to view telemetry.");
    requirePermission("telemetry:read", payload.nodeId);
    audit({ action: "telemetry.getSeries", target: payload.nodeId || "telemetry" });
    return getTelemetrySeries({
      nodeId: payload.nodeId,
      sinceMs: payload.sinceMs,
      keys: payload.keys,
      limit: payload.limit,
    });
  }));
  ipcMain.handle("telemetry:export", async (_, payload = {}) => invokeTelemetryOperation(() => {
    requireLocalOwnerAuthenticated("telemetry:export", "Unlock AnxOS to export telemetry.");
    requirePermission("telemetry:export", payload.nodeId);
    audit({ action: "telemetry.export", target: payload.nodeId || "telemetry" });
    return exportTelemetry({ nodeId: payload.nodeId, sinceMs: payload.sinceMs });
  }));
  ipcMain.handle("telemetry:clear", async (_, payload = {}) => invokeTelemetryOperation(() => {
    requireLocalOwnerAuthenticated("telemetry:clear", "Unlock AnxOS to clear telemetry.");
    requirePermission("telemetry:manage", payload.nodeId);
    audit({ action: "telemetry.clear", target: payload.nodeId || "telemetry" });
    return clearTelemetry();
  }));
}

module.exports = {
  registerTelemetryIpc,
};
