const { ipcMain, shell } = require("electron");
const diagnostics = require("../services/diagnosticsService");
const {
  getStatus,
  getSecurityDashboard,
  login,
  logout,
  logoutAllSessions,
  revokePersistentSession,
  revokeOtherSessions,
  removeTrustedDevice,
  renameTrustedDevice,
  rotateAgentToken,
  revokeAgentToken,
  generateReplacementAgentToken,
  getAuditFolderForOpen,
  getAuditRetentionReport,
  getAuditAccessReview,
  exportAuditWindow,
  updateRemoteAccessSettings,
  updateSessionSecuritySettings,
  disableRemoteAccess,
  lockOwnerWorkspace,
  emergencySecurityAction,
  setupAdmin,
} = require("../services/securityService");
const { createIpcError } = require("../shared/ipcError");
const { requireNodeContext } = require("./nodeContext");
const safeConsole = require("../shared/safeConsole");

async function invokeSecurityOperation(operation, operationName = "security") {
  safeConsole.info("[Security][IPC] Operation started.", { operation: operationName });
  try {
    const result = await operation();
    safeConsole.info("[Security][IPC] Operation completed.", { operation: operationName });
    return result;
  } catch (error) {
    const wrapped = createIpcError(error, {
      code: "SECURITY_IPC_FAILED",
      fallbackMessage: "Security request failed.",
      suggestion: "Review the security status and sign in again if required.",
    });
    diagnostics.log("warn", "security", operationName, "Security IPC operation failed", {
      code: wrapped.code,
      message: wrapped.friendlyMessage,
    }, { file: "auth", errorCode: wrapped.code });
    safeConsole.warn("[Security][IPC] Operation failed.", {
      operation: operationName,
      code: wrapped.code,
      message: wrapped.friendlyMessage,
    });
    throw wrapped;
  }
}

function registerSecurityIpc() {
  ipcMain.handle("security:getStatus", async () => invokeSecurityOperation(() => getStatus(), "security:getStatus"));
  ipcMain.handle("security:getDashboard", async (_, payload = {}) => invokeSecurityOperation(() => getSecurityDashboard(requireNodeContext(payload, "Security Center dashboard")), "security:getDashboard"));
  ipcMain.handle("security:setupAdmin", async (_, payload = {}) => invokeSecurityOperation(() => setupAdmin(payload), "security:setupAdmin"));
  ipcMain.handle("security:login", async (_, payload = {}) => invokeSecurityOperation(() => login(payload), "security:login"));
  ipcMain.handle("security:logout", async () => invokeSecurityOperation(() => logout(), "security:logout"));
  ipcMain.handle("security:logoutAllSessions", async () => invokeSecurityOperation(() => logoutAllSessions(), "security:logoutAllSessions"));
  ipcMain.handle("security:rotateAgentToken", async () => invokeSecurityOperation(() => rotateAgentToken(), "security:rotateAgentToken"));
  ipcMain.handle("security:revokeSession", async (_, payload = {}) => invokeSecurityOperation(() => revokePersistentSession(payload.sessionId), "security:revokeSession"));
  ipcMain.handle("security:revokeOtherSessions", async () => invokeSecurityOperation(() => revokeOtherSessions(), "security:revokeOtherSessions"));
  ipcMain.handle("security:removeTrustedDevice", async (_, payload = {}) => invokeSecurityOperation(() => removeTrustedDevice(payload.deviceId), "security:removeTrustedDevice"));
  ipcMain.handle("security:renameTrustedDevice", async (_, payload = {}) => invokeSecurityOperation(() => renameTrustedDevice(payload.deviceId, payload.name), "security:renameTrustedDevice"));
  ipcMain.handle("security:updateSessionSettings", async (_, payload = {}) => invokeSecurityOperation(() => updateSessionSecuritySettings(payload), "security:updateSessionSettings"));
  ipcMain.handle("security:updateRemoteAccess", async (_, payload = {}) => invokeSecurityOperation(() => updateRemoteAccessSettings(payload), "security:updateRemoteAccess"));
  ipcMain.handle("security:disableRemoteAccess", async () => invokeSecurityOperation(() => disableRemoteAccess(), "security:disableRemoteAccess"));
  ipcMain.handle("security:revokeAgentToken", async () => invokeSecurityOperation(() => revokeAgentToken(), "security:revokeAgentToken"));
  ipcMain.handle("security:generateReplacementAgentToken", async () => invokeSecurityOperation(() => generateReplacementAgentToken(), "security:generateReplacementAgentToken"));
  ipcMain.handle("security:lockOwnerWorkspace", async () => invokeSecurityOperation(() => lockOwnerWorkspace(), "security:lockOwnerWorkspace"));
  ipcMain.handle("security:emergencyAction", async (_, payload = {}) => invokeSecurityOperation(() => emergencySecurityAction(payload.action, payload.confirmation), "security:emergencyAction"));
  ipcMain.handle("security:openAuditFolder", async () => invokeSecurityOperation(async () => {
    const folder = getAuditFolderForOpen();
    await shell.openPath(folder);
    return { opened: true };
  }, "security:openAuditFolder"));
  // V2-I audit retention / access review / export. Each securityService function
  // already gates itself with requirePermission("settings:write", "audit-log") —
  // the same in-service guard chain as security:openAuditFolder above — so the
  // IPC layer passes the options payload through and adds no second gate.
  ipcMain.handle("security:getAuditRetentionReport", async (_, payload = {}) => invokeSecurityOperation(() => getAuditRetentionReport(payload), "security:getAuditRetentionReport"));
  ipcMain.handle("security:getAuditAccessReview", async (_, payload = {}) => invokeSecurityOperation(() => getAuditAccessReview(payload), "security:getAuditAccessReview"));
  ipcMain.handle("security:exportAuditWindow", async (_, payload = {}) => invokeSecurityOperation(() => exportAuditWindow(payload), "security:exportAuditWindow"));
}

module.exports = {
  registerSecurityIpc,
};
