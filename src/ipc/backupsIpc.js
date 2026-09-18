const { ipcMain, dialog } = require("electron");
const fs = require("fs");
const path = require("path");
const {
  createBackup,
  deleteBackup,
  deleteBackupDestination,
  deleteBackupSchedule,
  downloadBackup,
  importBackup,
  listBackupDestinations,
  listBackupSchedules,
  listBackups,
  pushBackupToDestination,
  restoreBackup,
  restoreBackupFromDestination,
  saveBackupDestination,
  saveBackupSchedule,
} = require("../services/serviceRouter");
const { audit, requirePermission } = require("../services/securityService");
const { wrapExpectedAgentRead } = require("./expectedAgentError");
const { requireNodeContext } = require("./nodeContext");
const { createIpcError } = require("../shared/ipcError");
const { MAX_BACKUP_ARCHIVE_BYTES } = require("../shared/backupLimits");
// V2-J bullet 2: the operation scope every backup action enters, so the durable
// job it mints and the Agent-side archive work join on one id.
const { runWithCorrelationScope } = require("../shared/structuredLogger");

async function writeFileAtomically(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(temporaryPath, content, { flag: "wx", mode: 0o600 });
    await fs.promises.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

async function invokeBackupOperation(operation) {
  try {
    return await runWithCorrelationScope({ prefix: "backup" }, operation);
  } catch (error) {
    throw createIpcError(error, {
      code: "BACKUP_REQUEST_FAILED",
      fallbackMessage: "Backup request failed.",
      suggestion: "Review the backup diagnostics, correct the reported problem, then retry.",
    });
  }
}

async function saveBackupDownload(backupId, options = {}) {
  requirePermission("backups:write", backupId);
  const payload = await downloadBackup(backupId, options);
  const suggested = backupId.endsWith(".tar.gz") ? backupId : `${backupId}.tar.gz`;
  const selection = await dialog.showSaveDialog({
    title: "Download backup",
    defaultPath: suggested,
    filters: [{ name: "Backup archives", extensions: ["tar.gz", "tgz"] }],
  });

  if (selection.canceled || !selection.filePath) {
    return { canceled: true };
  }

  await writeFileAtomically(selection.filePath, payload.buffer);
  audit({ action: "backup.download", target: backupId });
  return {
    canceled: false,
    path: selection.filePath,
    size: payload.buffer.length,
  };
}

async function importBackupFromFile(payload = {}) {
  requirePermission("backups:write", payload.instanceId);
  const selection = await dialog.showOpenDialog({
    title: "Import backup",
    properties: ["openFile"],
    filters: [{ name: "Backup archives", extensions: ["tar.gz", "tgz"] }],
  });

  if (selection.canceled || !selection.filePaths?.[0]) {
    return { canceled: true };
  }

  const filePath = selection.filePaths[0];
  const stats = await fs.promises.stat(filePath);
  if (!stats.isFile()) {
    throw Object.assign(new Error("The selected backup is not a regular file."), { code: "BACKUP_ARCHIVE_INVALID", statusCode: 400 });
  }
  if (stats.size > MAX_BACKUP_ARCHIVE_BYTES) {
    throw Object.assign(new Error("The selected backup exceeds the supported archive size limit."), {
      code: "BACKUP_ARCHIVE_LIMIT_EXCEEDED",
      statusCode: 413,
      details: { archiveBytes: stats.size, maxArchiveBytes: MAX_BACKUP_ARCHIVE_BYTES },
    });
  }
  const content = (await fs.promises.readFile(filePath)).toString("base64");
  const result = await importBackup({
    ...payload,
    name: payload.name || path.basename(filePath),
    content,
    encoding: "base64",
  });
  audit({ action: "backup.import", target: result?.backup?.id || payload.instanceId });
  return result;
}

function registerBackupsIpc() {
  ipcMain.handle("backups:list", async (_, payload = {}) => wrapExpectedAgentRead("backups:list", () => { requirePermission("backups:read", payload.nodeId); return listBackups(requireNodeContext(payload, "backup listing")); }));
  ipcMain.handle("backups:create", async (_, payload = {}) => invokeBackupOperation(() => {
    requireNodeContext(payload, "backup creation");
    requirePermission("backups:write", payload.instanceId);
    audit({ action: "backup.create", target: payload.instanceId });
    return createBackup(payload);
  }));
  ipcMain.handle("backups:restore", async (_, payload = {}) => invokeBackupOperation(() => {
    requireNodeContext(payload, "backup restore");
    requirePermission("backups:restore", payload.backupId);
    audit({ action: "backup.restore", target: payload.backupId });
    return restoreBackup(payload);
  }));
  ipcMain.handle("backups:delete", async (_, payload = {}) => invokeBackupOperation(() => {
    requireNodeContext(payload, "backup deletion");
    requirePermission("backups:write", payload.backupId);
    audit({ action: "backup.delete", target: payload.backupId });
    return deleteBackup(payload.backupId, payload);
  }));
  ipcMain.handle("backups:download", async (_, payload = {}) => invokeBackupOperation(() => saveBackupDownload(payload.backupId, requireNodeContext(payload, "backup download"))));
  ipcMain.handle("backups:import", async (_, payload = {}) => invokeBackupOperation(() => importBackupFromFile(requireNodeContext(payload, "backup import"))));
  ipcMain.handle("backups:listSchedules", async (_, payload = {}) => wrapExpectedAgentRead("backups:listSchedules", () => { requirePermission("backups:read", payload.nodeId); return listBackupSchedules(requireNodeContext(payload, "backup schedules")); }));
  ipcMain.handle("backups:saveSchedule", async (_, payload = {}) => invokeBackupOperation(() => {
    requireNodeContext(payload, "backup schedule save");
    requirePermission("backups:write", payload.instanceId);
    audit({ action: "backup.schedule.save", target: payload.instanceId });
    return saveBackupSchedule(payload);
  }));
  ipcMain.handle("backups:deleteSchedule", async (_, payload = {}) => invokeBackupOperation(() => {
    requireNodeContext(payload, "backup schedule deletion");
    requirePermission("backups:write", payload.instanceId);
    audit({ action: "backup.schedule.delete", target: payload.instanceId });
    return deleteBackupSchedule(payload.instanceId, payload);
  }));
  // V2-F wave 5 destinations. The guard runs before any transport call so a
  // denied actor never reaches the agent.
  ipcMain.handle("backups:listDestinations", async (_, payload = {}) => wrapExpectedAgentRead("backups:listDestinations", () => { requirePermission("backups:read", payload.nodeId); return listBackupDestinations(requireNodeContext(payload, "backup destination listing")); }));
  ipcMain.handle("backups:saveDestination", async (_, payload = {}) => invokeBackupOperation(() => {
    requireNodeContext(payload, "backup destination save");
    requirePermission("backups:write", payload.destinationId || payload.connectionId || payload.nodeId);
    audit({ action: "backup.destination.save", target: payload.destinationId || payload.connectionId || null });
    return saveBackupDestination(payload);
  }));
  ipcMain.handle("backups:deleteDestination", async (_, payload = {}) => invokeBackupOperation(() => {
    requireNodeContext(payload, "backup destination deletion");
    requirePermission("backups:write", payload.destinationId || payload.nodeId);
    audit({ action: "backup.destination.delete", target: payload.destinationId || null });
    return deleteBackupDestination(payload.destinationId, payload);
  }));
  ipcMain.handle("backups:pushDestination", async (_, payload = {}) => invokeBackupOperation(() => {
    requireNodeContext(payload, "backup destination push");
    requirePermission("backups:write", payload.backupId || payload.instanceId);
    audit({ action: "backup.destination.push", target: payload.backupId || null });
    return pushBackupToDestination(payload);
  }));
  ipcMain.handle("backups:restoreFromDestination", async (_, payload = {}) => invokeBackupOperation(() => {
    requireNodeContext(payload, "backup restore from destination");
    requirePermission("backups:restore", payload.backupId || payload.instanceId);
    audit({ action: "backup.restore.remote", target: payload.backupId || null });
    return restoreBackupFromDestination(payload);
  }));
}

module.exports = {
  registerBackupsIpc,
};
