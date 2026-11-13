const { ipcMain } = require("electron");
const { getSystemSnapshot, runNetworkCheck } = require("../services/systemService");
const { wrapExpectedAgentRead } = require("./expectedAgentError");
const { requireNodeContext } = require("./nodeContext");
const { requirePermission } = require("../services/securityService");

function registerSystemIpc() {
  // Phase 8: a person-initiated connection check on the selected computer.
  ipcMain.handle("system:networkCheck", async (_, payload = {}) => wrapExpectedAgentRead("system:networkCheck", () => { requirePermission("system:read", payload.nodeId); return runNetworkCheck(requireNodeContext(payload, "network check")); }));
  ipcMain.handle("system:getSnapshot", async (_, payload = {}) => wrapExpectedAgentRead("system:getSnapshot", () => { requirePermission("system:read", payload.nodeId); return getSystemSnapshot(requireNodeContext(payload, "system metrics")); }));
}

module.exports = {
  registerSystemIpc,
};
