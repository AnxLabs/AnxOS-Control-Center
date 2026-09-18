const { ipcMain } = require("electron");
const { getNetworkInventory } = require("../services/serviceRouter");
const { requireLocalOwnerAuthenticated, requirePermission } = require("../services/securityService");
const { requireNodeContext } = require("./nodeContext");
const { wrapExpectedAgentRead } = require("./expectedAgentError");

// V2-H: read-only network inventory (interfaces, ports, listeners, conflicts)
// for the selected node's Agent host. Node-scoped read tier, same guard chain
// as the other node-credential reads (nodes:health pattern).
function registerNetworkInventoryIpc() {
  ipcMain.handle("networkInventory:get", async (_, payload = {}) => wrapExpectedAgentRead("networkInventory:get", () => {
    requireLocalOwnerAuthenticated("networkInventory:get", "Unlock AnxOS to inspect node network inventory.");
    requirePermission("nodes:read", payload.nodeId);
    const context = requireNodeContext(payload, "network inventory");
    return getNetworkInventory({ ...payload, nodeId: context.nodeId });
  }, {
    code: "NETWORK_INVENTORY_REQUEST_FAILED",
    fallbackMessage: "Network inventory request failed.",
    suggestion: "Verify the selected node and its Agent connection, then retry.",
  }));
}

module.exports = {
  registerNetworkInventoryIpc,
};
