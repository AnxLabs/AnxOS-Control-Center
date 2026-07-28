const { ipcMain } = require("electron");
const control = require("../services/agentControlService");
const { audit, requireLocalOwnerAuthenticated, requireOwner } = require("../services/securityService");
const { requireNodeContext } = require("./nodeContext");
const { createIpcError } = require("../shared/ipcError");

function normalizeAgentControlError(error) {
  return createIpcError(error, {
    code: "AGENT_CONTROL_REQUEST_FAILED",
    fallbackMessage: "Agent Control operation failed.",
    suggestion: "Review Agent Control diagnostics, correct the reported issue, then retry.",
  });
}

function authorize(operation) {
  requireLocalOwnerAuthenticated(
    `agent-control:${operation}`,
    operation === "start" ? "Unlock AnxOS to start the Local Agent." : "Unlock AnxOS to manage the Local Agent.",
  );
  return requireOwner(`agent-control:${operation}`);
}

async function runAuthorized(operation, handler) {
  try {
    const actor = authorize(operation);
    return await runAudited(operation, actor, handler);
  } catch (error) {
    if (error?.details?.technicalDetails) throw error;
    throw normalizeAgentControlError(error);
  }
}

async function runLocalLifecycle(operation, handler) {
  return runAuthorized(operation, handler);
}

async function runAudited(operation, actor, handler) {
  try {
    const result = await handler();
    audit({ action: `agent.control.${operation}`, actor, target: "local-agent", outcome: "ok" });
    return result;
  } catch (error) {
    const wrapped = normalizeAgentControlError(error);
    audit({
      action: `agent.control.${operation}`,
      actor,
      target: "local-agent",
      outcome: "failed",
      reason: wrapped.code,
    });
    throw wrapped;
  }
}

function registerAgentControlIpc() {
  ipcMain.handle("agentControl:list", (_, payload = {}) => runAuthorized("list", () => control.listAgents(requireNodeContext(payload, "Agent Control listing"))));
  ipcMain.handle("agentControl:status", (_, payload = {}) => runAuthorized("status", () => control.getStatus(payload)));
  ipcMain.handle("agentControl:diagnostics", () => runAuthorized("diagnostics", () => control.runDiagnostics()));
  ipcMain.handle("agentControl:remoteDiagnostics", (_, payload = {}) => {
    const actor = authorize("remote-diagnostics");
    return runAudited("remote-diagnostics", actor, () => control.captureRemoteDiagnostics(payload.nodeId));
  });
  ipcMain.handle("agentControl:getConfig", () => runAuthorized("config-read", () => control.readConfig()));
  ipcMain.handle("agentControl:saveConfig", (_, payload = {}) => runAuthorized("config-save", () => control.saveConfig(payload)));
  ipcMain.handle("agentControl:restoreConfig", () => runAuthorized("config-restore", () => control.restoreConfigBackup()));
  ipcMain.handle("agentControl:resetConfig", () => runAuthorized("config-reset", () => control.resetConfig()));
  for (const [channel, operation] of Object.entries({ start: () => control.start(), stop: () => control.stop(), restart: () => control.restart(), forceRestart: () => control.restart({ force: true }) })) {
    ipcMain.handle(`agentControl:${channel}`, () => runLocalLifecycle(channel, operation));
  }
  ipcMain.handle("agentControl:installLocalAgent", (_, payload = {}) => runLocalLifecycle("install-local-agent", () => control.installLocalAgent(payload)));
  ipcMain.handle("agentControl:stopOldLocalAgentAndRepair", (_, payload = {}) => runLocalLifecycle("stop-old-local-agent-and-repair", () => control.stopOldLocalAgentAndRepair(payload)));
  ipcMain.handle("agentControl:pairLocalAgent", (_, payload = {}) => runLocalLifecycle("pair-local-agent", () => control.pairLocalAgentSecurely(payload)));
  ipcMain.handle("agentControl:startPairingSession", (_, payload = {}) => runLocalLifecycle("start-pairing-session", () => control.startPairingSession(payload)));
  ipcMain.handle("agentControl:updateLocalAgent", (_, payload = {}) => runLocalLifecycle("update-local-agent", () => control.updateLocalAgent(payload)));
  for (const [channel, operation] of Object.entries({ installService: () => control.installService(), uninstallService: () => control.uninstallService(), enableAutoStart: () => control.setAutoStart(true), disableAutoStart: () => control.setAutoStart(false), openLogs: () => control.openLogs(), openDataFolder: () => control.openDataFolder() })) ipcMain.handle(`agentControl:${channel}`, () => runAuthorized(channel, operation));
}
module.exports = { registerAgentControlIpc };
