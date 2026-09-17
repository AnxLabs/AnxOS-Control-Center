const { ipcMain } = require("electron");
const {
  clearInstanceLogs,
  createInstance,
  createInstanceFolder,
  createRestartSchedule,
  deleteInstance,
  deleteInstanceFile,
  deleteRestartSchedule,
  duplicateInstance,
  evaluateRestartSchedules,
  forgetInstance,
  forceKillInstance,
  getGameServerConfig,
  getInstanceLogs,
  getInstanceMetrics,
  getInstanceStatus,
  getFiveMReadiness,
  getMinecraftProperties,
  listInstanceFiles,
  listInstances,
  listRestartSchedules,
  openInstanceFolder,
  readInstanceFile,
  repairNeoForgeRuntime,
  renameInstance,
  renameInstanceFile,
  restartInstance,
  saveGameServerConfig,
  saveMinecraftProperties,
  saveFiveMLicenseKey,
  sendInstanceCommand,
  startInstance,
  stopInstance,
  updateInstance,
  updateRestartSchedule,
  writeInstanceFile,
} = require("../services/serviceRouter");
const { audit, checkRateLimit, requirePermission } = require("../services/securityService");
const { wrapExpectedAgentRead } = require("./expectedAgentError");
const { requireNodeContext } = require("./nodeContext");
const { createIpcError } = require("../shared/ipcError");
const { setAuditEventEmitter } = require("../shared/instances/jobLifecycle");

function getInstanceErrorMessage(error) {
  const code = error?.payload?.error?.code || error?.code;
  const message = error?.payload?.error?.message;

  if (code) {
    return message && message !== "Request failed." ? `${code}: ${message}` : code;
  }

  return error?.message || "Instance request failed.";
}

async function invokeInstanceOperation(operation) {
  try {
    return await operation();
  } catch (error) {
    const wrapped = createIpcError(error, {
      code: "INSTANCE_REQUEST_FAILED",
      fallbackMessage: getInstanceErrorMessage(error),
      suggestion: "Review the instance status and diagnostics, correct the reported problem, then retry.",
    });
    if (error?.validation) {
      wrapped.validation = error.validation;
    }
    throw wrapped;
  }
}

function registerInstanceHandler(channel, handler) {
  ipcMain.handle(channel, (event, payload = {}) => {
    requireNodeContext(payload, channel);
    return handler(event, payload);
  });
}

// Job records live in the process that executes the operation. The desktop
// main owns the local application-host node's store; remote nodes own theirs
// in the Agent and are re-observed through the Agent jobs REST surface.
function getLocalJobService() {
  // Lazy require: keeps module load free of electron-dependent services so
  // existing IPC smokes can mock the surfaces they exercise.
  return require("../services/localInstanceService");
}

function getJobTargetLabel(event) {
  const target = event?.target || {};
  return target.instanceId || target.requestedId || "unknown";
}

function registerInstancesIpc() {
  // Bridge per-job state transitions into the existing redacted audit stream;
  // securityService.audit stays the single append-only store (.0600).
  setAuditEventEmitter((event) => {
    audit({
      action: event.action || "job.event",
      outcome: event.outcome || "ok",
      target: `${event.type || "job"}:${getJobTargetLabel(event)}`,
      reason: typeof event.jobId === "string" ? event.jobId : null,
    });
  });

  registerInstanceHandler("instances:list", async (_, payload = {}) => wrapExpectedAgentRead("instances:list", () => { requirePermission("instance:read", payload.nodeId); return listInstances(payload); }));
  registerInstanceHandler("instances:create", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:write", payload.id || payload.name || "new-instance");
    audit({ action: "instance.create", target: payload.id || payload.name || "new-instance" });
    return createInstance(payload);
  }));
  registerInstanceHandler("instances:update", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:write", payload.instanceId);
    audit({ action: "instance.update", target: payload.instanceId });
    return updateInstance(payload.instanceId, payload.config || {}, payload);
  }));
  registerInstanceHandler("instances:rename", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:write", payload.instanceId);
    audit({ action: "instance.rename", target: payload.instanceId });
    return renameInstance(payload.instanceId, payload.displayName || payload.name, payload);
  }));
  registerInstanceHandler("instances:duplicate", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:write", payload.instanceId);
    audit({ action: "instance.duplicate", target: payload.instanceId });
    return duplicateInstance(payload.instanceId, payload.config || payload.options || payload, payload);
  }));
  registerInstanceHandler("instances:openFolder", async (_, payload = {}) => invokeInstanceOperation(() => {
    audit({ action: "instance.openFolder", target: payload.instanceId });
    return openInstanceFolder(payload.instanceId, payload);
  }));
  registerInstanceHandler("instances:getStatus", async (_, payload = {}) => wrapExpectedAgentRead("instances:getStatus", () => { requirePermission("instance:read", payload.instanceId); return getInstanceStatus(payload.instanceId, payload); }));
  registerInstanceHandler("instances:getMetrics", async (_, payload = {}) => wrapExpectedAgentRead("instances:getMetrics", () => { requirePermission("instance:read", payload.instanceId); return getInstanceMetrics(payload.instanceId, payload); }));
  registerInstanceHandler("instances:getLogs", async (_, payload = {}) => wrapExpectedAgentRead("instances:getLogs", () => { requirePermission("instance:read", payload.instanceId); return getInstanceLogs(payload.instanceId, payload); }));
  registerInstanceHandler("instances:clearLogs", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("files:write", `${payload.instanceId}:logs`);
    audit({ action: "instance.logs.clear", target: payload.instanceId });
    return clearInstanceLogs(payload.instanceId, payload);
  }));
  registerInstanceHandler("instances:sendCommand", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:write", payload.instanceId);
    checkRateLimit("console-command", 120, 60 * 1000);
    audit({ action: "instance.command", target: payload.instanceId });
    return sendInstanceCommand(payload.instanceId, payload.command, payload);
  }));
  registerInstanceHandler("instances:start", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:lifecycle", payload.instanceId);
    audit({ action: "instance.start", target: payload.instanceId });
    return startInstance(payload.instanceId, payload);
  }));
  registerInstanceHandler("instances:stop", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:lifecycle", payload.instanceId);
    audit({ action: "instance.stop", target: payload.instanceId });
    return stopInstance(payload.instanceId, payload);
  }));
  registerInstanceHandler("instances:restart", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:lifecycle", payload.instanceId);
    audit({ action: "instance.restart", target: payload.instanceId });
    return restartInstance(payload.instanceId, payload);
  }));
  registerInstanceHandler("instances:repairNeoForgeRuntime", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:lifecycle", payload.instanceId);
    audit({ action: "instance.neoforge.repairRuntime", target: payload.instanceId });
    return repairNeoForgeRuntime(payload.instanceId, payload);
  }));
  registerInstanceHandler("instances:forceKill", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:lifecycle", payload.instanceId);
    audit({ action: "instance.forceKill", target: payload.instanceId });
    return forceKillInstance(payload.instanceId, payload);
  }));
  registerInstanceHandler("instances:delete", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:delete", payload.instanceId);
    audit({ action: "instance.delete", target: payload.instanceId });
    return deleteInstance(payload.instanceId, payload);
  }));
  registerInstanceHandler("instances:forget", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:delete", payload.instanceId);
    audit({ action: "instance.forget", target: payload.instanceId });
    return forgetInstance(payload.instanceId, payload);
  }));
  // V2-E scheduled restarts: permission split mirrors the agent's central
  // route gate (read → instance:read, mutate → instance:write, remove →
  // instance:delete); the scheduler itself runs server-side in the agent.
  registerInstanceHandler("instances:listRestartSchedules", async (_, payload = {}) => wrapExpectedAgentRead("instances:listRestartSchedules", () => {
    requirePermission("instance:read", payload.instanceId);
    return listRestartSchedules(payload.instanceId, payload);
  }));
  registerInstanceHandler("instances:createRestartSchedule", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:write", payload.instanceId);
    audit({ action: "instance.restartSchedule.create", target: payload.instanceId });
    return createRestartSchedule(payload.instanceId, payload, payload);
  }));
  registerInstanceHandler("instances:updateRestartSchedule", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:write", payload.instanceId);
    audit({ action: "instance.restartSchedule.update", target: `${payload.instanceId}:${payload.scheduleId}` });
    return updateRestartSchedule(payload.instanceId, payload.scheduleId, payload, payload);
  }));
  registerInstanceHandler("instances:deleteRestartSchedule", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:delete", payload.instanceId);
    audit({ action: "instance.restartSchedule.delete", target: `${payload.instanceId}:${payload.scheduleId}` });
    return deleteRestartSchedule(payload.instanceId, payload.scheduleId, payload);
  }));
  registerInstanceHandler("instances:evaluateRestartSchedules", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:write", payload.instanceId);
    audit({ action: "instance.restartSchedule.evaluate", target: payload.instanceId });
    return evaluateRestartSchedules(payload.instanceId, payload);
  }));
  registerInstanceHandler("instances:listFiles", async (_, payload = {}) => invokeInstanceOperation(() => { requirePermission("instance:read", payload.instanceId); return listInstanceFiles(payload.instanceId, payload.path, payload); }));
  registerInstanceHandler("instances:readFile", async (_, payload = {}) => invokeInstanceOperation(() => { requirePermission("instance:read", payload.instanceId); return readInstanceFile(payload.instanceId, payload.path, payload); }));
  registerInstanceHandler("instances:writeFile", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("files:write", `${payload.instanceId}:${payload.path}`);
    checkRateLimit("instance-file-write", 120, 60 * 1000);
    audit({ action: "instance.file.write", target: `${payload.instanceId}:${payload.path}` });
    return writeInstanceFile(payload.instanceId, payload.path, payload.content, { ...payload, encoding: payload.encoding });
  }));
  registerInstanceHandler("instances:deleteFile", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("files:write", `${payload.instanceId}:${payload.path}`);
    audit({ action: "instance.file.delete", target: `${payload.instanceId}:${payload.path}` });
    return deleteInstanceFile(payload.instanceId, payload.path, payload);
  }));
  registerInstanceHandler("instances:createFolder", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("files:write", `${payload.instanceId}:${payload.path}`);
    audit({ action: "instance.folder.create", target: `${payload.instanceId}:${payload.path}` });
    return createInstanceFolder(payload.instanceId, payload.path, payload);
  }));
  registerInstanceHandler("instances:renameFile", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("files:write", `${payload.instanceId}:${payload.oldPath}`);
    audit({ action: "instance.file.rename", target: `${payload.instanceId}:${payload.oldPath}` });
    return renameInstanceFile(payload.instanceId, payload.oldPath, payload.newPath, payload);
  }));
  registerInstanceHandler("instances:getMinecraftProperties", async (_, payload = {}) => invokeInstanceOperation(() => { requirePermission("instance:read", payload.instanceId); return getMinecraftProperties(payload.instanceId, payload); }));
  registerInstanceHandler("instances:getGameServerConfig", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:read", payload.instanceId);
    return getGameServerConfig(payload.instanceId, payload);
  }));
  registerInstanceHandler("instances:saveGameServerConfig", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("files:write", `${payload.instanceId}:game-config`);
    if (payload.restart === true) {
      requirePermission("instance:lifecycle", payload.instanceId);
    }
    audit({ action: payload.restart === true ? "instance.game-config.write-restart" : "instance.game-config.write", target: payload.instanceId });
    return saveGameServerConfig(payload.instanceId, payload, payload);
  }));
  registerInstanceHandler("instances:saveMinecraftProperties", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("files:write", `${payload.instanceId}:server.properties`);
    audit({ action: "instance.minecraft.properties.write", target: payload.instanceId });
    return saveMinecraftProperties(payload.instanceId, payload.properties, payload);
  }));
  registerInstanceHandler("instances:getFiveMReadiness", async (_, payload = {}) => invokeInstanceOperation(() => { requirePermission("instance:read", payload.instanceId); return getFiveMReadiness(payload.instanceId, payload); }));
  registerInstanceHandler("instances:saveFiveMLicenseKey", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("files:write", `${payload.instanceId}:server.cfg`);
    checkRateLimit("fivem-license-save", 20, 60 * 1000);
    audit({ action: "instance.fivem.license.write", target: payload.instanceId });
    return saveFiveMLicenseKey(payload.instanceId, payload.licenseKey, payload);
  }));
  registerInstanceHandler("instances:jobs:list", async (_, payload = {}) => invokeInstanceOperation(() => {
    requirePermission("instance:read", payload.nodeId || payload.instanceId || "application-host");
    return getLocalJobService().listInstanceJobs({
      limit: payload.limit,
      type: payload.type,
      instanceId: payload.instanceId,
    });
  }));
  registerInstanceHandler("instances:jobs:get", async (_, payload = {}) => invokeInstanceOperation(async () => {
    requirePermission("instance:read", payload.instanceId || payload.jobId);
    const job = await getLocalJobService().getInstanceJob(payload.jobId);
    if (!job) {
      throw Object.assign(new Error("JOB_NOT_FOUND"), { code: "JOB_NOT_FOUND", statusCode: 404 });
    }
    return { job };
  }));
  registerInstanceHandler("instances:jobs:cancel", async (_, payload = {}) => invokeInstanceOperation(async () => {
    requirePermission("instance:lifecycle", payload.instanceId || "unknown-target");
    audit({ action: "job.cancel", target: payload.jobId || "unknown-job" });
    const outcome = await getLocalJobService().cancelInstanceJob(payload.jobId, { reason: payload.reason });
    if (!outcome) {
      throw Object.assign(new Error("JOB_NOT_FOUND"), { code: "JOB_NOT_FOUND", statusCode: 404 });
    }
    return outcome;
  }));
}

module.exports = {
  registerInstancesIpc,
};
