const { ipcMain } = require("electron");
const { acknowledgeAlert, listAlerts } = require("../services/alertService");
const { audit, requireLocalOwnerAuthenticated, requirePermission } = require("../services/securityService");
const { createIpcError } = require("../shared/ipcError");

// V2-J Wave 1: desktop alert surface. Read at the nodes:read tier (alerts are
// derived entirely from per-node data the same actors may already read) and
// acknowledge at the settings:write tier (it mutates operator-facing state).
// Both channels are local-owner gated like their node-scoped neighbours.
// This module is DESKTOP-SIDE ONLY: it reads the persisted active-alert state
// the alert engine reconciles; it adds no Agent routes and no renderer UI.
async function invokeAlertsOperation(operation) {
  try {
    return await operation();
  } catch (error) {
    throw createIpcError(error, {
      code: "ALERTS_OPERATION_FAILED",
      fallbackMessage: "Alert request failed.",
      suggestion: "Retry after the alert engine finishes its next evaluation.",
    });
  }
}

function registerAlertsIpc() {
  ipcMain.handle("alerts:list", async () => invokeAlertsOperation(() => {
    requireLocalOwnerAuthenticated("alerts:list", "Unlock AnxOS to view alerts.");
    requirePermission("nodes:read", "alerts");
    audit({ action: "alerts.list", target: "alerts" });
    return listAlerts();
  }));
  ipcMain.handle("alerts:acknowledge", async (_, payload = {}) => invokeAlertsOperation(() => {
    requireLocalOwnerAuthenticated("alerts:acknowledge", "Unlock AnxOS to acknowledge alerts.");
    requirePermission("settings:write", "alerts");
    // Only the id crosses the IPC boundary; the acknowledgement label is set
    // desktop-side (the real actor is captured by audit above).
    const acknowledged = acknowledgeAlert({ id: payload?.id ?? payload?.alertId });
    audit({ action: "alerts.acknowledge", target: acknowledged.id });
    return acknowledged;
  }));
}

module.exports = {
  registerAlertsIpc,
};
