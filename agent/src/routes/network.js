const { checkPort, collectNetworkInventory } = require("../services/networkInventoryService");

// V2-H: read-only host network inventory (interfaces, listeners, conflicts).
// Mirrors handleSystemSummary: GET-only, no provisioning, agent-side read.
async function handleNetworkInventory(url) {
  const body = await collectNetworkInventory();

  // Optional single-port bound check reusing the same listener parse.
  const checkPortValue = url?.searchParams?.get("checkPort");
  if (checkPortValue != null) {
    const protocol = String(url.searchParams.get("protocol") || "tcp").trim().toLowerCase();
    body.checkPort = await checkPort(Number(checkPortValue), { protocol });
  }

  return {
    statusCode: 200,
    body,
  };
}

module.exports = {
  handleNetworkInventory,
};
