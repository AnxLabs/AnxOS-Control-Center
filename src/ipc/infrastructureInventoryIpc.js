const { ipcMain } = require("electron");
const { getInventory, refreshInventory } = require("../services/infrastructureInventoryService");
const { requireLocalOwnerAuthenticated, requirePermission } = require("../services/securityService");

// AIM-1 infrastructure inventory: read-only discovery across every registered
// Agent node. Same guard chain and read tier as networkInventory:get. Refresh
// only issues allow-listed GET requests (infrastructureInventoryService), so it
// stays in the read tier; it never changes a managed service.
function registerInfrastructureInventoryIpc() {
  ipcMain.handle("infrastructureInventory:get", async () => {
    requireLocalOwnerAuthenticated("infrastructureInventory:get", "Unlock AnxOS to view the infrastructure inventory.");
    requirePermission("nodes:read");
    return getInventory();
  });

  ipcMain.handle("infrastructureInventory:refresh", async (_, payload = {}) => {
    requireLocalOwnerAuthenticated("infrastructureInventory:refresh", "Unlock AnxOS to refresh the infrastructure inventory.");
    requirePermission("nodes:read");
    return refreshInventory({ force: payload?.force === true });
  });
}

module.exports = {
  registerInfrastructureInventoryIpc,
};
