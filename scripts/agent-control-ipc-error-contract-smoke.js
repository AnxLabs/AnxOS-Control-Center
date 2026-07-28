const assert = require("assert");
const Module = require("module");

const handlers = new Map();
const audits = [];
let failStatus = false;
const control = new Proxy({}, {
  get: (_target, property) => async () => {
    if (property === "getStatus") {
      if (failStatus) throw Object.assign(new Error("agentToken=control-secret"), { code: "AGENT_SERVICE_FAILED", statusCode: 500 });
      return { running: true };
    }
    return {};
  },
});

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (request === "../services/agentControlService") return control;
  if (request === "../services/securityService") {
    return {
      audit: (entry) => audits.push(entry),
      requireLocalOwnerAuthenticated: () => ({ username: "owner" }),
      requireOwner: () => ({ username: "owner" }),
    };
  }
  if (request === "./nodeContext") return { requireNodeContext: (payload) => payload };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require("../src/ipc/agentControlIpc").registerAgentControlIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  const handler = handlers.get("agentControl:status");
  assert.deepStrictEqual(await handler({}, { nodeId: "node-a" }), { running: true });
  failStatus = true;
  await assert.rejects(handler({}, { nodeId: "node-a" }), (error) => {
    assert.strictEqual(error.code, "AGENT_SERVICE_FAILED");
    assert.strictEqual(error.statusCode, 500);
    assert(!JSON.stringify(error).includes("control-secret"));
    return true;
  });
  assert.strictEqual(audits.at(-1).reason, "AGENT_SERVICE_FAILED");
  assert(!JSON.stringify(audits).includes("control-secret"));
  console.log("Agent Control IPC error contract smoke checks passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
