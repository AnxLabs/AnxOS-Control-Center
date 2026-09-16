const assert = require("assert");
const Module = require("module");

const handlers = new Map();
let serviceInvoked = false;
const serviceProxy = new Proxy({}, { get: () => async () => { serviceInvoked = true; return {}; } });
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (["../services/serviceRouter", "../services/systemService", "../services/publicAccessProviderService", "../services/marketplaceService"].includes(request)) return serviceProxy;
  if (request === "../services/diagnosticsService") return { updateRuntimeState: () => {}, log: () => {} };
  if (request === "../services/securityService") return { audit: () => {}, requirePermission: () => { throw Object.assign(new Error("Permission denied."), { code: "PERMISSION_DENIED" }); } };
  if (request === "./expectedAgentError") return { wrapExpectedAgentRead: async (_channel, task) => task() };
  if (request === "./nodeContext") return { requireNodeContext: (payload) => payload };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require("../src/ipc/systemIpc").registerSystemIpc();
  require("../src/ipc/ampIpc").registerAmpIpc();
  require("../src/ipc/dependenciesIpc").registerDependenciesIpc();
  require("../src/ipc/publicAccessIpc").registerPublicAccessIpc();
  require("../src/ipc/playitIpc").registerPlayitIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  const channels = ["system:getSnapshot", "amp:getSnapshot", "dependencies:getCatalog", "dependencies:check", "dependencies:plan", "publicAccess:getSnapshot", "publicAccess:listServices", "playit:getSnapshot"];
  for (const channel of channels) {
    serviceInvoked = false;
    const handler = handlers.get(channel);
    assert(handler, `${channel} should be registered.`);
    const invoke = () => handler({}, { nodeId: "node-a" });
    if (channel.startsWith("dependencies:")) {
      const result = await invoke();
      assert.strictEqual(result.ok, false, `${channel} should return its existing failure envelope.`);
      assert.strictEqual(result.error.code, "PERMISSION_DENIED");
    } else {
      await assert.rejects(invoke, (error) => error?.code === "PERMISSION_DENIED", `${channel} should reject an unauthorized renderer request.`);
    }
    assert.strictEqual(serviceInvoked, false, `${channel} must authorize before querying operational data.`);
  }
  console.log("Operational read IPC authorization smoke checks passed.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
