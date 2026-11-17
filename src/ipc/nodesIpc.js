const { ipcMain } = require("electron");
const {
  checkAllNodeHealth,
  checkNodeHealth,
  deleteNode,
  disconnectNode,
  getAllNodesSync,
  getNodeCredentialStatus,
  getNodesPath,
  listNodes,
  pairNodeFromCode,
  reconnectNode,
  repairNodeCredential,
  saveNode,
  setNodeFallbackUrls,
  setNodeTransport,
  testNode,
  testNodeConnectionPayload,
} = require("../services/nodeService");
const { restorePersistedActiveNode, setActiveNode } = require("../services/activeNodeSelectionService");
const { getDefaultSshService, updateRemoteAgent } = require("../services/remoteAgentUpdateService");
const { getAgentUpdateOverview, serversStoppedByAgentRestart, historyEntryFor, readAutoUpdatePolicy, readUpdateHistory, recordUpdateHistory, startAgentAutoUpdateScheduler, updateAllAgents, writeAutoUpdatePolicy } = require("../services/agentUpdateManager");
const { listInstances: listInstancesForNode } = require("../services/serviceRouter");
const { readDesktopBundledAgentArtifactVersion } = require("../shared/agentBuildIdentity");
const path = require("path");
const { getRemoteAgentLifecycleService } = require("../services/remoteAgentLifecycleService");
const { createMobilePairing } = require("../services/mobilePairingService");
const { getNodeTunnelService } = require("../services/nodeTunnelService");
const { getNodeRouteResolver } = require("../services/nodeRouteResolver");
const { suggestTailscaleRoutes } = require("../services/tailscaleRouteService");
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
  // App-managed SSH tunnels: status is a plain read; choosing a transport and
  // forcing a retry are owner actions like the other node changes.
  ipcMain.handle("nodes:tunnelStatus", async () => invokeNodeOperation(() => {
    requirePermission("nodes:read", "nodes", { localCredentials: false });
    return { tunnels: getNodeTunnelService().listStatus() };
  }));
  ipcMain.handle("nodes:setTransport", async (_, payload = {}) => invokeNodeOperation(() => {
    const context = requireNodeContext(payload, "node transport");
    requireLocalOwnerAuthenticated("nodes:set-transport", "Unlock AnxOS to manage nodes.");
    requirePermission("settings:write", context.nodeId);
    audit({ action: "node.set-transport", target: context.nodeId });
    const node = setNodeTransport(context.nodeId, payload.transport || {});
    const tunnels = getNodeTunnelService();
    tunnels.sync();
    return { node, tunnel: tunnels.getStatus(context.nodeId) };
  }));
  ipcMain.handle("nodes:reconnectTunnel", async (_, payload = {}) => invokeNodeOperation(() => {
    const context = requireNodeContext(payload, "node tunnel reconnect");
    requireLocalOwnerAuthenticated("nodes:reconnect-tunnel", "Unlock AnxOS to manage nodes.");
    requirePermission("settings:write", context.nodeId);
    audit({ action: "node.reconnect-tunnel", target: context.nodeId });
    const tunnels = getNodeTunnelService();
    tunnels.sync();
    return { tunnel: tunnels.reconnect(context.nodeId) };
  }));
  // Route fallback (LAN -> Tailscale -> ...): route status and Tailscale
  // suggestions are reads; changing a node's fallback routes is an owner action.
  ipcMain.handle("nodes:routeStatus", async () => invokeNodeOperation(() => {
    requirePermission("nodes:read", "nodes", { localCredentials: false });
    return { routes: getNodeRouteResolver().listRouteStatus() };
  }));
  ipcMain.handle("nodes:suggestRoutes", async (_, payload = {}) => invokeNodeOperation(async () => {
    const context = requireNodeContext(payload, "node route suggestions");
    requirePermission("nodes:read", context.nodeId, { localCredentials: false });
    const node = getAllNodesSync().find((entry) => entry.id === context.nodeId);
    if (!node || node.kind !== "agent") throw Object.assign(new Error("Node not found."), { code: "NODE_NOT_FOUND" });
    return suggestTailscaleRoutes(node);
  }));
  ipcMain.handle("nodes:setFallbackUrls", async (_, payload = {}) => invokeNodeOperation(async () => {
    const context = requireNodeContext(payload, "node fallback routes");
    requireLocalOwnerAuthenticated("nodes:set-fallback-urls", "Unlock AnxOS to manage nodes.");
    requirePermission("settings:write", context.nodeId);
    audit({ action: "node.set-fallback-urls", target: context.nodeId });
    const node = setNodeFallbackUrls(context.nodeId, payload.fallbackUrls || []);
    const stored = getAllNodesSync().find((entry) => entry.id === context.nodeId);
    const route = stored ? await getNodeRouteResolver().checkNode(stored).catch(() => null) : null;
    return { node, route };
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
  // Remote Agent update (one computer). The Desktop updates a Linux computer's
  // Agent to its own bundled build over SSH: from the verified release package
  // when the Agent is package-installed, otherwise by pushing the bundled
  // runtime. Owner-only because it restarts that computer's Agent. Every
  // attempt is recorded in the Agent update history.
  const agentUpdateConfigDir = () => path.dirname(getNodesPath());
  const agentUpdateOverview = () => getAgentUpdateOverview({
    // No Local Agent discovery here (it probes this PC's Agent each time).
    listNodes: async () => (await listNodes({ discoverLocalAgent: false }))?.nodes || [],
    desktopBuild: readDesktopBundledAgentArtifactVersion(),
    getProfileForNode: (nodeId) => getDefaultSshService().getProfileForNode(nodeId),
  });
  // Servers the Agent runs stop when it restarts, whatever the update method,
  // so every update path asks first and skips a computer with running servers.
  const skipIfServersRunning = async (entry) => {
    try {
      const listed = await listInstancesForNode({ nodeId: entry.nodeId });
      const instances = Array.isArray(listed) ? listed : Array.isArray(listed?.instances) ? listed.instances : [];
      // Only servers the restart would stop; service-managed ones keep running.
      const running = serversStoppedByAgentRestart(instances);
      if (running.length) {
        return { code: "REMOTE_AGENT_UPDATE_SERVERS_RUNNING", message: `${running.length} server${running.length === 1 ? " is" : "s are"} running on ${entry.name} (${running.map((instance) => instance.displayName || instance.id).slice(0, 3).join(", ")}). Stop ${running.length === 1 ? "it" : "them"} first; updating restarts the Agent.` };
      }
      return null;
    } catch (error) {
      return { code: "REMOTE_AGENT_UPDATE_WORKLOADS_UNKNOWN", message: `Could not check ${entry.name}'s servers (${error?.message || "unknown error"}), so it was not updated.` };
    }
  };
  const historyRecorder = (trigger) => {
    const ids = new Map();
    return (entry, outcome) => {
      if (!ids.has(entry.nodeId)) ids.set(entry.nodeId, { id: `${Date.now()}-${entry.nodeId}`, at: new Date().toISOString() });
      const { id, at } = ids.get(entry.nodeId);
      recordUpdateHistory(agentUpdateConfigDir(), historyEntryFor({ id, at, trigger, overviewEntry: entry, outcome }));
    };
  };
  ipcMain.handle("nodes:updateAgent", async (_, payload = {}) => invokeNodeOperation(async () => {
    const context = requireNodeContext(payload, "node agent update");
    requireLocalOwnerAuthenticated("nodes:update-agent", "Unlock AnxOS to update a node Agent.");
    requirePermission("settings:write", context.nodeId);
    audit({ action: "node.update-agent", target: context.nodeId });
    const overview = await agentUpdateOverview().catch(() => null);
    const entry = overview?.nodes?.find((candidate) => candidate.nodeId === context.nodeId) || { nodeId: context.nodeId, name: context.nodeId, installedBuild: null, targetBuild: readDesktopBundledAgentArtifactVersion() };
    const record = historyRecorder("manual");
    const skip = await skipIfServersRunning(entry);
    if (skip) {
      record(entry, { status: "skipped", code: skip.code, message: skip.message });
      throw Object.assign(new Error(skip.message), { code: skip.code });
    }
    record(entry, { status: "running" });
    try {
      const result = await updateRemoteAgent(context.nodeId);
      record(entry, { status: result?.upToDate ? "up-to-date" : "succeeded", result });
      return result;
    } catch (error) {
      record(entry, { status: error?.code === "REMOTE_AGENT_UPDATE_SUDO_REQUIRED" ? "needs-approval" : "failed", error });
      // The node reports a newer Agent than this Desktop bundles; the service
      // refuses the downgrade, so point the user at the supported path.
      if (error?.code === "AGENT_DOWNGRADE_REFUSED") {
        throw Object.assign(error, { suggestion: "Update AnxOS Control Center to get a newer bundled Agent instead of downgrading this node." });
      }
      throw error;
    }
  }));
  // Fleet Agent versions against this Desktop's bundled build, and Update All
  // (one computer at a time, same checks and history as a single update).
  ipcMain.handle("nodes:agentUpdateOverview", async () => invokeNodeOperation(async () => {
    requireLocalOwnerAuthenticated("nodes:agent-update-overview", "Unlock AnxOS to see Agent versions.");
    requirePermission("settings:write", "agent-updates");
    return agentUpdateOverview();
  }));
  ipcMain.handle("nodes:updateAllAgents", async () => invokeNodeOperation(async () => {
    requireLocalOwnerAuthenticated("nodes:update-all-agents", "Unlock AnxOS to update Agents.");
    requirePermission("settings:write", "agent-updates");
    audit({ action: "node.update-all-agents", target: "fleet" });
    const overview = await agentUpdateOverview();
    return updateAllAgents({ overview, updateAgent: (nodeId) => updateRemoteAgent(nodeId), before: skipIfServersRunning, record: historyRecorder("update-all") });
  }));
  // Automatic Agent updates: settings and history. Off unless the owner turns
  // them on; agent-auto-update.json is the one place the choice is stored and
  // the scheduler reads it on every tick.
  ipcMain.handle("nodes:getAgentAutoUpdate", async () => invokeNodeOperation(async () => {
    requireLocalOwnerAuthenticated("nodes:agent-auto-update", "Unlock AnxOS to see automatic Agent updates.");
    requirePermission("settings:write", "agent-updates");
    return { policy: readAutoUpdatePolicy(agentUpdateConfigDir()), history: readUpdateHistory(agentUpdateConfigDir()).slice(0, 50) };
  }));
  ipcMain.handle("nodes:setAgentAutoUpdate", async (_, payload = {}) => invokeNodeOperation(async () => {
    requireLocalOwnerAuthenticated("nodes:agent-auto-update", "Unlock AnxOS to change automatic Agent updates.");
    requirePermission("settings:write", "agent-updates");
    const policy = writeAutoUpdatePolicy(agentUpdateConfigDir(), payload.policy || {});
    audit({ action: "node.agent-auto-update.set", target: "fleet", enabled: policy.enabled, mode: policy.mode, computers: policy.nodeIds.length });
    return { policy, history: readUpdateHistory(agentUpdateConfigDir()).slice(0, 50) };
  }));
  const autoRecord = historyRecorder("automatic");
  startAgentAutoUpdateScheduler({
    configDir: agentUpdateConfigDir,
    getOverview: agentUpdateOverview,
    updateAgent: (nodeId) => {
      audit({ action: "node.auto-update-agent", target: nodeId });
      return updateRemoteAgent(nodeId);
    },
    before: skipIfServersRunning,
    record: autoRecord,
    notify: (entry) => autoRecord(entry, { status: "available", message: `Update ${entry.installedBuild} → ${entry.targetBuild} is ready. Automatic updates are set to notify only.` }),
    log: (outcome) => audit({ action: "node.auto-update-agents", target: "fleet", outcome: outcome.reason }),
  });

  // Remote Agent lifecycle: Start / Stop / Restart a node's Agent over SSH, or
  // Restart through the Agent itself when no SSH key profile is assigned.
  // Owner-only like the remote update: stopping or restarting the Agent stops
  // the instances it runs on that node.
  ipcMain.handle("nodes:controlAgent", async (_, payload = {}) => invokeNodeOperation(async () => {
    const context = requireNodeContext(payload, "node agent lifecycle");
    const action = String(payload.action || "");
    requireLocalOwnerAuthenticated("nodes:control-agent", "Unlock AnxOS to control a node Agent.");
    requirePermission("settings:write", context.nodeId);
    audit({ action: `node.agent-${["start", "stop", "restart"].includes(action) ? action : "invalid"}`, target: context.nodeId });
    return getRemoteAgentLifecycleService().control(context.nodeId, action);
  }));
  // Read-only check that the node's SSH key profile reaches this node and can
  // control its Agent; the renderer keeps Start/Stop/Restart and Update
  // disabled until it passes.
  ipcMain.handle("nodes:verifyAgentControl", async (_, payload = {}) => invokeNodeOperation(async () => {
    const context = requireNodeContext(payload, "node agent access check");
    requireLocalOwnerAuthenticated("nodes:verify-agent-control", "Unlock AnxOS to check access to a node Agent.");
    requirePermission("settings:write", context.nodeId);
    audit({ action: "node.agent-verify-access", target: context.nodeId });
    return getRemoteAgentLifecycleService().verify(context.nodeId);
  }));
  // Mobile pairing: mints and installs a fresh node credential for a phone and
  // returns the claim (QR + claim string). Owner-only because it hands out a
  // credential that grants full access to the node.
  ipcMain.handle("nodes:createMobilePairing", async (_, payload = {}) => invokeNodeOperation(async () => {
    const context = requireNodeContext(payload, "node mobile pairing");
    requireLocalOwnerAuthenticated("nodes:create-mobile-pairing", "Unlock AnxOS to pair a mobile device.");
    requirePermission("settings:write", context.nodeId);
    audit({ action: "node.create-mobile-pairing", target: context.nodeId });
    return createMobilePairing(context.nodeId);
  }));
}

module.exports = {
  registerNodesIpc,
};
