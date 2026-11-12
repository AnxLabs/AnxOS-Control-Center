const { BrowserWindow, dialog, ipcMain } = require("electron");
const fs = require("fs");
const mobile = require("../services/mobileGatewayService");
const { audit, requireOwner, requirePermission } = require("../services/securityService");
const { createIpcError } = require("../shared/ipcError");

// Phone access (Phase 7). Reading the status is settings:read. Turning it
// on or off, pairing a phone and revoking phones are owner-only (a paired
// phone can act with the role it was given), and each is audited.

const EXPECTED = /^PHONE_ACCESS_OFF$|^INVALID_ROLE$/;

function invoke(operation) {
  return Promise.resolve()
    .then(operation)
    .catch((error) => {
      const code = String(error?.code || "");
      if (EXPECTED.test(code)) return { ok: false, error: { code, message: error.message } };
      throw createIpcError(error, { code: "PHONE_ACCESS_REQUEST_FAILED", fallbackMessage: "The Phone access request failed." });
    });
}

function owner(channel, action, operation) {
  ipcMain.handle(channel, (_, payload = {}) => invoke(() => {
    requireOwner("phone-access");
    audit({ action, target: String(payload.deviceId || payload.role || "phone-access").slice(0, 80) });
    return operation(payload);
  }));
}

let registered = false;

function registerMobileGatewayIpc() {
  if (registered) return;
  registered = true;
  ipcMain.handle("mobile:status", () => invoke(() => { requirePermission("settings:read", "phone-access"); return mobile.status(); }));
  owner("mobile:enable", "mobile.enable", () => mobile.enable());
  owner("mobile:disable", "mobile.disable", () => mobile.disable());
  owner("mobile:createPairing", "mobile.pairing.create", (payload) => mobile.createPairing(String(payload.role || "")));
  owner("mobile:cancelPairings", "mobile.pairing.cancel", () => mobile.cancelPairings());
  owner("mobile:revokeDevice", "mobile.device.revoke", (payload) => mobile.revokeDevice(String(payload.deviceId || "")));
  owner("mobile:revokeAll", "mobile.device.revokeAll", () => mobile.revokeAll());
  owner("mobile:saveCaCertificate", "mobile.ca.export", async () => {
    const { pem, fingerprint } = mobile.caCertificate();
    const selection = await dialog.showSaveDialog({
      title: "Save the AnxOS certificate for your phone",
      defaultPath: "anxos-local-ca.crt",
      filters: [{ name: "Certificate", extensions: ["crt"] }],
    });
    if (selection.canceled || !selection.filePath) return { canceled: true };
    await fs.promises.writeFile(selection.filePath, pem);
    return { canceled: false, path: selection.filePath, fingerprint };
  });
  if (typeof mobile.events?.on === "function") mobile.events.on("changed", () => {
    BrowserWindow.getAllWindows().forEach((window) => {
      if (!window.isDestroyed()) window.webContents.send("mobile:changed", {});
    });
  });
}

module.exports = { registerMobileGatewayIpc };
