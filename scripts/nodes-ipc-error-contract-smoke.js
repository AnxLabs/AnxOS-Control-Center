const assert = require("assert");
const Module = require("module");

const handlers = new Map();
const originalError = Object.assign(new Error("Pairing expired."), {
  code: "PAIRING_EXPIRED",
  status: 409,
  details: { retryable: true, suggestion: "Start a new pairing session.", nodeId: "node-a" },
});
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (request === "../services/nodeService") {
    return {
      checkAllNodeHealth: async () => [],
      checkNodeHealth: async () => ({}),
      deleteNode: async () => ({}),
      getNodeCredentialStatus: async () => ({}),
      listNodes: async () => { throw originalError; },
      pairNodeFromCode: async () => ({}),
      repairNodeCredential: async () => ({}),
      saveNode: async () => ({}),
      testNode: async () => ({}),
      testNodeConnectionPayload: async () => ({}),
    };
  }
  if (request === "../services/activeNodeSelectionService") return { restorePersistedActiveNode: async () => ({}), setActiveNode: async () => ({}) };
  if (request === "../shared/agentTokenStore") return { generateAgentToken: () => "test-token" };
  if (request === "../services/securityService") return { audit: () => {}, requirePermission: () => ({}) };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require("../src/ipc/nodesIpc").registerNodesIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  const handler = handlers.get("nodes:list");
  assert(handler, "Node list handler should be registered.");
  await assert.rejects(
    () => handler({}, {}),
    (error) => {
      assert.strictEqual(error.code, "PAIRING_EXPIRED");
      assert.strictEqual(error.details.retryable, true);
      assert.strictEqual(error.details.suggestion, "Start a new pairing session.");
      assert.strictEqual(error.statusCode, 409);
      assert.notStrictEqual(error.cause, originalError);
      assert.strictEqual(error.cause.code, originalError.code);
      assert.match(error.message, /^PAIRING_EXPIRED:/);
      return true;
    },
    "Node IPC should retain the shared structured error contract.",
  );
  console.log("Node IPC error contract smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
