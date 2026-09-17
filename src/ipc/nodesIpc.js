const { ipcMain } = require("electron");
const {
  checkAllNodeHealth,
  checkNodeHealth,
  deleteNode,
  disconnectNode,
  getNodeCredentialStatus,
  listNodes,
  pairNodeFromCode,
  reconnectNode,
  repairNodeCredential,
  saveNode,
  testNode,
  testNodeConnectionPayload,
} = require("../services/nodeService");
const { restorePersistedActiveNode, setActiveNode } = require("../services/activeNodeSelectionService");
const { getFleetSummary, runFleetBatchAction } = require("../services/fleetService");
const { generateAgentToken } = require("../shared/agentTokenStore");
const { audit, getStatus, requireLocalOwnerAuthenticated, requirePermission } = require("../services/securityService");
const { requireNodeContext } = require("./nodeContext");
const { createIpcError } = require("../shared/ipcError");

async function invokeNodeOperation(operation) {
  try {
    return await operation();
  } catch (error) {
    throw createIpcError(error, {
      code: "NODE_OPERATION_FAILED",
      fallbackMessage: "Node request failed.",
      suggestion: "Verify the selected node and its Agent connection, then retry.",
    });
  }
}

function registerNodesIpc() {
  ipcMain.handle("nodes:list", async () => invokeNodeOperation(() => { requirePermission("nodes:read", "nodes", { localCredentials: false }); return listNodes(); }));
  ipcMain.handle("nodes:restore", async () => invokeNodeOperation(() => {
    requirePermission("nodes:read", "nodes", { localCredentials: false });
    return restorePersistedActiveNode({ readOnly: getStatus().localOwnerAuthenticated !== true });
  }));
  ipcMain.handle("nodes:save", async (_, payload = {}) => invokeNodeOperation(() => {
    requireLocalOwnerAuthenticated("nodes:save", "Unlock AnxOS to manage nodes.");
    requirePermission("settings:write", "nodes");
    audit({ action: "node.save", target: payload.id || payload.agentUrl });
    return saveNode(payload);
  }));
  ipcMain.handle("nodes:delete", async (_, payload = {}) => invokeNodeOperation(() => {
    const context = requireNodeContext(payload, "node deletion");
    requireLocalOwnerAuthenticated("nodes:delete", "Unlock AnxOS to manage nodes.");
    requirePermission("settings:write", context.nodeId);
    audit({ action: "node.delete", target: context.nodeId });
    return deleteNode(context.nodeId);
  }));
  ipcMain.handle("nodes:disconnect", async (_, payload = {}) => invokeNodeOperation(() => {
    const context = requireNodeContext(payload, "node disconnect");
    requireLocalOwnerAuthenticated("nodes:disconnect", "Unlock AnxOS to manage nodes.");
    requirePermission("settings:write", context.nodeId);
    audit({ action: "node.disconnect", target: context.nodeId });
    return disconnectNode(context.nodeId);
  }));
  ipcMain.handle("nodes:reconnect", async (_, payload = {}) => invokeNodeOperation(() => {
    const context = requireNodeContext(payload, "node reconnect");
    requireLocalOwnerAuthenticated("nodes:reconnect", "Unlock AnxOS to manage nodes.");
    requirePermission("settings:write", context.nodeId);
    audit({ action: "node.reconnect", target: context.nodeId });
    return reconnectNode(context.nodeId);
  }));
  ipcMain.handle("nodes:select", async (_, payload = {}) => invokeNodeOperation(() => { requireLocalOwnerAuthenticated("nodes:select", "Unlock AnxOS to manage nodes."); requirePermission("nodes:read", payload.nodeId); return setActiveNode(requireNodeContext(payload, "node selection").nodeId, { reason: "ipc-select" }); }));
  ipcMain.handle("nodes:test", async (_, payload = {}) => invokeNodeOperation(() => { requireLocalOwnerAuthenticated("nodes:test", "Unlock AnxOS to use saved node credentials."); requirePermission("nodes:read", payload.nodeId); return testNode(requireNodeContext(payload, "node connection test").nodeId); }));
  ipcMain.handle("nodes:testConnection", async (_, payload = {}) => invokeNodeOperation(() => {
    requireLocalOwnerAuthenticated("nodes:test-connection", "Unlock AnxOS to use saved node credentials.");
    requirePermission("settings:write", payload.agentUrl || payload.url || "node-connection-test");
    return testNodeConnectionPayload(payload);
  }));
  ipcMain.handle("nodes:health", async (_, payload = {}) => invokeNodeOperation(() => { requireLocalOwnerAuthenticated("nodes:health", "Unlock AnxOS to use saved node credentials."); requirePermission("nodes:read", payload.nodeId); return checkNodeHealth(requireNodeContext(payload, "node health check").nodeId); }));
  ipcMain.handle("nodes:healthAll", async () => invokeNodeOperation(() => { requireLocalOwnerAuthenticated("nodes:health-all", "Unlock AnxOS to use saved node credentials."); requirePermission("nodes:read", "nodes"); return checkAllNodeHealth(); }));
  // V2-G Wave 2 fleet aggregation: read-only roll-up plus controlled batch
  // actions. The batch channel is authorized once for the fleet-scope request
  // here; every target inside it is still resolved against the registry and
  // audited per node by runFleetBatchAction/the result records below.
  ipcMain.handle("nodes:fleetSummary", async () => invokeNodeOperation(() => { requireLocalOwnerAuthenticated("nodes:fleet-summary", "Unlock AnxOS to use saved node credentials."); requirePermission("nodes:read", "nodes"); return getFleetSummary(); }));
  ipcMain.handle("nodes:fleetBatch", async (_, payload = {}) => invokeNodeOperation(async () => {
    requireLocalOwnerAuthenticated("nodes:fleet-batch", "Unlock AnxOS to manage nodes.");
    requirePermission("settings:write", "nodes");
    audit({ action: "node.fleet-batch", target: payload.action || "unknown-action" });
    const outcome = await runFleetBatchAction(payload);
    outcome.results.forEach((result) => audit({
      action: `node.fleet-batch.${outcome.action}`,
      target: result.nodeId,
      outcome: result.ok ? "ok" : "failed",
      reason: result.ok ? null : result.code,
    }));
    return outcome;
  }));
  ipcMain.handle("nodes:credentialStatus", async (_, payload = {}) => invokeNodeOperation(() => { requireLocalOwnerAuthenticated("nodes:credential-status", "Unlock AnxOS to use saved node credentials."); requirePermission("nodes:read", payload.nodeId); return getNodeCredentialStatus(requireNodeContext(payload, "node credential status").nodeId); }));
  ipcMain.handle("nodes:repairCredential", async (_, payload = {}) => invokeNodeOperation(() => {
    const context = requireNodeContext(payload, "node credential repair");
    requireLocalOwnerAuthenticated("nodes:repair-credential", "Unlock AnxOS to manage nodes.");
    requirePermission("settings:write", context.nodeId);
    audit({ action: "node.repair-credential", target: context.nodeId });
    return repairNodeCredential(context);
  }));
  ipcMain.handle("nodes:generateToken", async () => invokeNodeOperation(() => {
    requireLocalOwnerAuthenticated("nodes:generate-token", "Unlock AnxOS to manage nodes.");
    requirePermission("settings:write", "nodes");
    audit({ action: "node.generate-token", target: "node-agent-token" });
    return { token: generateAgentToken(), tokenFormat: "anxos-base64url-v1" };
  }));
  ipcMain.handle("nodes:pair", async (_, payload = {}) => invokeNodeOperation(async () => {
    requireLocalOwnerAuthenticated("nodes:pair", "Unlock AnxOS to manage nodes.");
    requirePermission("settings:write", "nodes");
    const paired = await pairNodeFromCode(payload);
    audit({ action: "node.pair-agent", target: paired.node?.id || paired.selectedNodeId || "paired-node" });
    return setActiveNode(paired.selectedNodeId, { reason: "agent-pairing", state: paired });
  }));
}

module.exports = {
  registerNodesIpc,
};
