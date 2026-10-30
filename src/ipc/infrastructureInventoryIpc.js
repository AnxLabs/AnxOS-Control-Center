const { ipcMain } = require("electron");
const { getInventory, refreshInventory } = require("../services/infrastructureInventoryService");
const { describeFunctionalProbes, runFunctionalProbe } = require("../services/functionalProbeService");
const { audit, requireLocalOwnerAuthenticated, requirePermission } = require("../services/securityService");

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

  // AIM-2: Health vs Functional state of recognized services. Reading it never
  // probes anything, so it shares the inventory's read tier.
  ipcMain.handle("infrastructureInventory:functional", async () => {
    requireLocalOwnerAuthenticated("infrastructureInventory:functional", "Unlock AnxOS to view functional checks.");
    requirePermission("nodes:read");
    return describeFunctionalProbes();
  });

  // On-demand functional check for one service. Owner only and audited: once
  // the Owner approves a scope it sends requests to that service. Until then
  // (AIM-0) the gate records LIVE_RUNS_DEFERRED without sending anything.
  ipcMain.handle("infrastructureInventory:checkFunction", async (_, payload = {}) => {
    requireLocalOwnerAuthenticated("infrastructureInventory:checkFunction", "Unlock AnxOS to run a functional check.");
    requirePermission("settings:write", payload.resourceKey || "functional-check");
    const resourceKey = typeof payload.resourceKey === "string" ? payload.resourceKey.slice(0, 512) : "";
    audit({ action: "infrastructure.functional-check", target: resourceKey || "unknown" });
    return runFunctionalProbe(resourceKey, { trigger: "on-demand" });
  });
}

module.exports = {
  registerInfrastructureInventoryIpc,
};
