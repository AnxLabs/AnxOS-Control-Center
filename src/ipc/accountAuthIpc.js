const { ipcMain } = require("electron");
const diagnostics = require("../services/diagnosticsService");
const {
  cancelDeviceLogin,
  checkDeviceLogin,
  getStatus,
  listAccountDevices,
  loginWithPassword,
  logout,
  openAccountPage,
  restoreSession,
  refreshSession,
  revokeCurrentDevice,
  startDeviceLogin,
  redactSecret,
} = require("../services/accountAuthService");
const { normalizeIpcError } = require("../shared/ipcError");

function getAccountErrorMessage(error) {
  return redactSecret(error?.message || error?.code || "AnxOS account request failed.");
}

async function invokeAccountOperation(operation, operationName = "account") {
  console.info("[Account][IPC] Operation started.", { operation: operationName });
  try {
    const result = await operation();
    diagnostics.log("info", "account-auth", operationName, "Cloud account operation completed", {}, { file: "auth" });
    console.info("[Account][IPC] Operation completed.", { operation: operationName });
    return result;
  } catch (error) {
    diagnostics.logError("account-auth", operationName, error, {}, { file: "auth" });
    const normalized = normalizeIpcError(error, {
      code: "ACCOUNT_REQUEST_FAILED",
      friendlyMessage: getAccountErrorMessage(error),
      suggestion: "Check the account connection and credentials, then retry.",
    });
    console.warn("[Account][IPC] Operation failed.", {
      operation: operationName,
      code: normalized.code,
      message: normalized.friendlyMessage,
    });
    return {
      ok: false,
      error: normalized,
    };
  }
}

function registerAccountAuthIpc() {
  ipcMain.handle("account:getStatus", async () => invokeAccountOperation(() => getStatus(), "account:getStatus"));
  ipcMain.handle("account:restore", async () => invokeAccountOperation(() => restoreSession(), "account:restore"));
  ipcMain.handle("account:startDeviceLogin", async () => invokeAccountOperation(() => startDeviceLogin(), "account:startDeviceLogin"));
  ipcMain.handle("account:loginWithPassword", async (_, payload = {}) => invokeAccountOperation(() => loginWithPassword(payload), "account:loginWithPassword"));
  ipcMain.handle("account:checkDeviceLogin", async () => invokeAccountOperation(() => checkDeviceLogin(), "account:checkDeviceLogin"));
  ipcMain.handle("account:cancelDeviceLogin", async () => invokeAccountOperation(() => cancelDeviceLogin(), "account:cancelDeviceLogin"));
  ipcMain.handle("account:refresh", async () => invokeAccountOperation(() => refreshSession(), "account:refresh"));
  ipcMain.handle("account:openPage", async () => invokeAccountOperation(() => openAccountPage(), "account:openPage"));
  ipcMain.handle("account:listDevices", async () => invokeAccountOperation(() => listAccountDevices(), "account:listDevices"));
  ipcMain.handle("account:revokeCurrentDevice", async () => invokeAccountOperation(() => revokeCurrentDevice(), "account:revokeCurrentDevice"));
  ipcMain.handle("account:logout", async () => invokeAccountOperation(() => logout(), "account:logout"));
}

module.exports = {
  registerAccountAuthIpc,
};
