const assert = require("assert");
const Module = require("module");

const handlers = new Map();
let serviceInvoked = false;
const nodeService = new Proxy({}, {
  get: () => async () => { serviceInvoked = true; return {}; },
});
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (request === "../services/nodeService") return nodeService;
  if (request === "../services/activeNodeSelectionService") return { restorePersistedActiveNode: async () => { serviceInvoked = true; return {}; }, setActiveNode: async () => { serviceInvoked = true; return {}; } };
  if (request === "../shared/agentTokenStore") return { generateAgentToken: () => "test-token" };
  if (request === "../services/securityService") {
    return {
      audit: () => {},
      requireLocalOwnerAuthenticated: () => { throw Object.assign(new Error("Permission denied."), { code: "PERMISSION_DENIED" }); },
      requirePermission: () => { throw Object.assign(new Error("Permission denied."), { code: "PERMISSION_DENIED" }); },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require("../src/ipc/nodesIpc").registerNodesIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  for (const channel of ["nodes:list", "nodes:restore", "nodes:select", "nodes:test", "nodes:testConnection", "nodes:health", "nodes:healthAll", "nodes:credentialStatus"]) {
    serviceInvoked = false;
    const handler = handlers.get(channel);
    assert(handler, `${channel} should be registered.`);
    await assert.rejects(
      () => handler({}, { nodeId: "node-a", agentUrl: "https://internal.example.test", agentToken: "hidden" }),
      (error) => error?.code === "PERMISSION_DENIED",
      `${channel} should reject an unauthorized renderer request.`,
    );
    assert.strictEqual(serviceInvoked, false, `${channel} must authorize before accessing node data or making an outbound request.`);
  }
  console.log("Node IPC authorization smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
