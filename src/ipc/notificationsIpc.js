const { ipcMain } = require("electron");
const { listOperationalNotifications } = require("../services/operationalNotificationService");
const { audit, requireLocalOwnerAuthenticated, requirePermission } = require("../services/securityService");
const { createIpcError } = require("../shared/ipcError");

// V2-K: operational notification journal read. The events are derived entirely
// from per-node data the same actors may already read, so the journal is read
// at the nodes:read tier; the channel is local-owner gated like alerts:list
// and audited because it exposes cross-node operational history.
async function invokeNotificationsOperation(operation) {
  try {
    return await operation();
  } catch (error) {
    throw createIpcError(error, {
      code: "NOTIFICATIONS_REQUEST_FAILED",
      fallbackMessage: "Notification request failed.",
      suggestion: "Retry after the notification scheduler finishes its next evaluation.",
    });
  }
}

function registerNotificationsIpc() {
  ipcMain.handle("notifications:list", async (_, payload = {}) => invokeNotificationsOperation(() => {
    requireLocalOwnerAuthenticated("notifications:list", "Unlock AnxOS to view notifications.");
    requirePermission("nodes:read", "notifications");
    audit({ action: "notifications.list", target: payload.nodeId || "notifications" });
    return listOperationalNotifications({ since: payload.since, limit: payload.limit });
  }));
}

module.exports = {
  registerNotificationsIpc,
};
