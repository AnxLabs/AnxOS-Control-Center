const { BrowserWindow, ipcMain } = require("electron");
const { FileService } = require("../services/fileService");
const {
  deleteConnection,
  listConnections,
  saveConnection,
  setDefaultConnection,
  testConnection,
} = require("../services/storageConnectionService");
const { audit, checkRateLimit, requirePermission } = require("../services/securityService");
const { createIpcError } = require("../shared/ipcError");

const fileService = new FileService();
let filesIpcRegistered = false;
let filesTransferEventsRegistered = false;

function registerFileHandler(channel, handler) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      throw createIpcError(error, {
        code: "FILES_REQUEST_FAILED",
        fallbackMessage: "File operation failed.",
        suggestion: "Refresh the current folder, verify the path and permissions, then retry.",
      });
    }
  });
}

function registerFilesIpc() {
  if (filesIpcRegistered) {
    return fileService;
  }

  filesIpcRegistered = true;

  if (!filesTransferEventsRegistered) {
    filesTransferEventsRegistered = true;
    fileService.on("transfer", (payload) => {
      BrowserWindow.getAllWindows().forEach((window) => {
        if (!window.isDestroyed()) {
          window.webContents.send("files:transfer", payload);
        }
      });
    });
  }

  registerFileHandler("files:list", async (_, payload = {}) => { requirePermission("files:read", payload.path); return fileService.list(payload); });
  registerFileHandler("files:identity", async (_, payload = {}) => { requirePermission("files:read", payload.nodeId || payload.storageId); return fileService.identity(payload); });
  registerFileHandler("files:listConnections", async () => { requirePermission("files:read", "storage-connections"); return listConnections(); });
  registerFileHandler("files:saveConnection", async (_, payload = {}) => {
    requirePermission("settings:write", "storage-connections");
    audit({ action: "files.storage.save", target: payload.id || payload.name || payload.host });
    return saveConnection(payload);
  });
  registerFileHandler("files:deleteConnection", async (_, payload = {}) => {
    requirePermission("settings:write", payload.storageId || payload.id);
    audit({ action: "files.storage.delete", target: payload.storageId || payload.id });
    return deleteConnection(payload.storageId || payload.id);
  });
  registerFileHandler("files:setDefaultConnection", async (_, payload = {}) => {
    requirePermission("settings:write", payload.storageId || payload.id);
    audit({ action: "files.storage.default", target: payload.storageId || payload.id });
    return setDefaultConnection(payload.storageId || payload.id);
  });
  registerFileHandler("files:testConnection", async (_, payload = {}) => { requirePermission("settings:write", payload.id || payload.host || "storage-connection-test"); return testConnection(payload); });
  registerFileHandler("files:disconnect", async (_, payload = {}) => { requirePermission("files:read", payload.profileId || payload.storageId); return fileService.disconnect(payload.profileId, payload.storageId); });
  registerFileHandler("files:cancelTransfer", async (_, payload = {}) => {
    requirePermission("files:write", payload.transferId || payload.id);
    audit({ action: "files.transfer.cancel", target: payload.transferId || payload.id });
    return fileService.cancelTransfer(payload.transferId || payload.id);
  });
  registerFileHandler("files:readText", async (_, payload = {}) => { requirePermission("files:read", payload.path); return fileService.readText(payload); });
  registerFileHandler("files:writeText", async (_, payload = {}) => {
    requirePermission("files:write", payload.path);
    checkRateLimit("files-write", 120, 60 * 1000);
    audit({ action: "files.write", target: payload.path });
    return fileService.writeText(payload);
  });
  registerFileHandler("files:mkdir", async (_, payload = {}) => {
    requirePermission("files:write", payload.path);
    audit({ action: "files.mkdir", target: payload.path });
    return fileService.mkdir(payload);
  });
  registerFileHandler("files:rename", async (_, payload = {}) => {
    requirePermission("files:write", `${payload.oldPath} -> ${payload.newPath}`);
    audit({ action: "files.rename", target: payload.oldPath });
    return fileService.rename(payload);
  });
  registerFileHandler("files:copy", async (_, payload = {}) => {
    requirePermission("files:write", `${payload.sourcePath || payload.path} -> ${payload.destinationPath || payload.newPath}`);
    audit({ action: "files.copy", target: payload.sourcePath || payload.path });
    return fileService.copy(payload);
  });
  registerFileHandler("files:newFile", async (_, payload = {}) => {
    requirePermission("files:write", payload.path || payload.filePath);
    audit({ action: "files.newFile", target: payload.path || payload.filePath });
    return fileService.newFile(payload);
  });
  registerFileHandler("files:delete", async (_, payload = {}) => {
    requirePermission("files:write", payload.path);
    audit({ action: "files.delete", target: payload.path });
    return fileService.delete(payload);
  });
  registerFileHandler("files:upload", async (_, payload = {}) => {
    requirePermission("files:write", payload.directoryPath);
    checkRateLimit("files-upload", 30, 60 * 1000);
    audit({ action: "files.upload", target: payload.directoryPath });
    return fileService.upload(payload);
  });
  registerFileHandler("files:uploadContent", async (_, payload = {}) => {
    requirePermission("files:write", payload.directoryPath);
    checkRateLimit("files-upload-content", 120, 60 * 1000);
    audit({ action: "files.upload", target: payload.directoryPath, detail: { dropped: true } });
    return fileService.uploadContent(payload);
  });
  registerFileHandler("files:download", async (_, payload = {}) => { requirePermission("files:read", payload.path); return fileService.download(payload); });
  return fileService;
}

function disposeFilesIpc() {
  fileService.dispose();
  filesIpcRegistered = false;
}

module.exports = {
  disposeFilesIpc,
  registerFilesIpc,
};
