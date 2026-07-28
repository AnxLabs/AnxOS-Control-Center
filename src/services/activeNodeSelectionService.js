const fs = require("fs");
const {
  APPLICATION_HOST_NODE_ID,
  getAllNodesSync,
  getExecutionTarget,
  getNode,
  getNodeAgentConfig,
  getNodesPath,
  getSelectedNodeId,
  listNodes,
  selectNode,
} = require("./nodeService");

const subscribers = new Set();
let lastNotifiedNodeId = null;
let notificationDepth = 0;

function publicError(message, code) {
  return Object.assign(new Error(message), { code });
}

function getActiveNodeId() {
  return getSelectedNodeId() || APPLICATION_HOST_NODE_ID;
}

function getActiveNode() {
  return getNode(getActiveNodeId());
}

function getSelectableNodes() {
  return getAllNodesSync().filter((node) => node.id === APPLICATION_HOST_NODE_ID || node.enabled !== false);
}

function validateActiveNode() {
  const activeNodeId = getActiveNodeId();
  try {
    const node = getNode(activeNodeId);
    if (node.enabled === false) {
      return {
        valid: false,
        code: "NODE_DISABLED",
        nodeId: activeNodeId,
        node,
        message: "The selected node is disabled.",
      };
    }
    return { valid: true, nodeId: activeNodeId, node };
  } catch (error) {
    return {
      valid: false,
      code: error?.code || "NODE_NOT_FOUND",
      nodeId: activeNodeId,
      node: null,
      message: error?.message || "The selected node is unavailable.",
    };
  }
}

function resolveRecoveryNodeId() {
  const selectableAgents = getSelectableNodes().filter((node) => node.kind === "agent");
  if (selectableAgents.length === 1) return selectableAgents[0].id;
  return APPLICATION_HOST_NODE_ID;
}

async function notifyActiveNodeChange(previousNodeId, nextState, reason) {
  const nodeId = nextState?.selectedNodeId || getActiveNodeId();
  if (nodeId === lastNotifiedNodeId && previousNodeId === nodeId) return;
  if (notificationDepth > 4) return;
  lastNotifiedNodeId = nodeId;
  notificationDepth += 1;
  try {
    for (const callback of [...subscribers]) {
      try {
        await callback({
          previousNodeId,
          nodeId,
          selectedNodeId: nodeId,
          reason: reason || "selection",
          state: nextState,
        });
      } catch {}
    }
  } finally {
    notificationDepth -= 1;
  }
}

async function setActiveNode(nodeId, options = {}) {
  const requestedNodeId = nodeId || APPLICATION_HOST_NODE_ID;
  const previousNodeId = getActiveNodeId();
  const node = getNode(requestedNodeId);
  if (node.enabled === false && options.allowDisabled !== true) {
    throw publicError("The selected node is disabled.", "NODE_DISABLED");
  }
  if (requestedNodeId === previousNodeId) {
    return {
      changed: false,
      selectedNodeId: previousNodeId,
      node,
      ...(await listNodes({ discoverLocalAgent: false, refreshIdentity: false })),
    };
  }
  const state = await selectNode(requestedNodeId);
  await notifyActiveNodeChange(previousNodeId, state, options.reason);
  return { changed: true, node: getNode(requestedNodeId), ...state };
}

async function clearInvalidSelection(options = {}) {
  const validation = validateActiveNode();
  if (validation.valid && options.force !== true) {
    return { changed: false, ...validation, selectedNodeId: validation.nodeId };
  }
  const recoveryNodeId = resolveRecoveryNodeId();
  const state = await setActiveNode(recoveryNodeId, {
    reason: options.reason || "selection-recovery",
    allowDisabled: false,
  });
  return {
    ...state,
    recovered: true,
    requiresSelection: recoveryNodeId === APPLICATION_HOST_NODE_ID && getSelectableNodes().filter((node) => node.kind === "agent").length !== 1,
  };
}

function readPersistedSelectedNodeId() {
  try {
    const parsed = JSON.parse(fs.readFileSync(getNodesPath(), "utf8"));
    return parsed?.selectedNodeId || null;
  } catch {
    return null;
  }
}

async function restorePersistedActiveNode(options = {}) {
  const persistedNodeId = readPersistedSelectedNodeId();
  if (persistedNodeId && persistedNodeId !== APPLICATION_HOST_NODE_ID && !getAllNodesSync().some((node) => node.id === persistedNodeId)) {
    if (options.readOnly === true) {
      return {
        ...(await listNodes({ discoverLocalAgent: false, refreshIdentity: false })),
        restored: true,
        recovered: true,
        readOnly: true,
        selectedNodeId: APPLICATION_HOST_NODE_ID,
        node: getNode(APPLICATION_HOST_NODE_ID),
        requiresSelection: true,
      };
    }
    return clearInvalidSelection({ reason: "startup-recovery", force: true });
  }
  const validation = validateActiveNode();
  if (!validation.valid && validation.code === "NODE_DISABLED") {
    return {
      restored: true,
      disabled: true,
      selectedNodeId: validation.nodeId,
      node: validation.node,
      ...(await listNodes({ discoverLocalAgent: false, refreshIdentity: false })),
    };
  }
  if (validation.valid) {
    return {
      restored: true,
      selectedNodeId: validation.nodeId,
      node: validation.node,
      ...(await listNodes({ discoverLocalAgent: false, refreshIdentity: false })),
    };
  }
  if (options.readOnly === true) {
    return {
      ...(await listNodes({ discoverLocalAgent: false, refreshIdentity: false })),
      restored: true,
      recovered: true,
      readOnly: true,
      selectedNodeId: APPLICATION_HOST_NODE_ID,
      node: getNode(APPLICATION_HOST_NODE_ID),
      requiresSelection: true,
    };
  }
  return clearInvalidSelection({ reason: "startup-recovery" });
}

function resolveActiveAgentConnection() {
  const node = getActiveNode();
  if (node.kind !== "agent") {
    return {
      nodeId: APPLICATION_HOST_NODE_ID,
      agent: null,
      connection: null,
      executionTarget: getExecutionTarget(APPLICATION_HOST_NODE_ID),
    };
  }
  const config = getNodeAgentConfig(node.id);
  return {
    nodeId: node.id,
    agent: {
      nodeId: node.id,
      name: node.displayName || node.name || node.id,
      baseUrl: node.baseUrl || node.agentUrl,
      agentUrl: node.agentUrl || node.baseUrl,
      identity: node.agentIdentity || {},
      version: node.agentVersion || node.agentIdentity?.agentVersion || "",
      platform: node.platform || node.agentIdentity?.platform || "",
    },
    connection: {
      agentUrl: config.agentUrl,
      hasToken: Boolean(config.agentToken),
      tokenConfigured: Boolean(config.agentToken),
    },
    executionTarget: getExecutionTarget(node.id),
  };
}

function subscribeToActiveNodeChanges(callback) {
  if (typeof callback !== "function") return () => {};
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}

module.exports = {
  clearInvalidSelection,
  getActiveNode,
  getActiveNodeId,
  resolveActiveAgentConnection,
  restorePersistedActiveNode,
  setActiveNode,
  subscribeToActiveNodeChanges,
  validateActiveNode,
};
