const { ipcMain } = require("electron");
const computerService = require("../services/computerService");
const nodeService = require("../services/nodeService");
const { audit, requireLocalOwnerAuthenticated, requirePermission } = require("../services/securityService");
const { createIpcError } = require("../shared/ipcError");

// V2-K: computer summary read. A computer summary composes per-node identity,
// endpoint, telemetry and cached-diagnostics state (see computerService), so
// it stays at the nodes:read tier every observability role already holds. The
// application host is a valid target, so an explicit nodeId is optional and
// the selected node (defaulting to the application host) is used instead of
// refusing the read; the service itself never throws and reports degraded
// reasons instead.
async function invokeComputersOperation(operation) {
  try {
    return await operation();
  } catch (error) {
    throw createIpcError(error, {
      code: "COMPUTERS_OPERATION_FAILED",
      fallbackMessage: "Computer summary request failed.",
      suggestion: "Review the computer diagnostics, correct the reported problem, then retry.",
    });
  }
}

function resolveComputerNodeId(payload = {}) {
  if (typeof payload.nodeId === "string" && payload.nodeId.trim()) return payload.nodeId.trim();
  const selected = nodeService.getSelectedNodeId();
  if (typeof selected === "string" && selected.trim()) return selected.trim();
  return nodeService.APPLICATION_HOST_NODE_ID;
}

function registerComputersIpc() {
  ipcMain.handle("computers:getSummary", async (_, payload = {}) => invokeComputersOperation(() => {
    requireLocalOwnerAuthenticated("computers:getSummary", "Unlock AnxOS to view computers.");
    requirePermission("nodes:read", "computers");
    const nodeId = resolveComputerNodeId(payload);
    audit({ action: "computers.getSummary", target: nodeId || "computers" });
    return computerService.getComputerSummary({ nodeId });
  }));
}

module.exports = {
  registerComputersIpc,
};
