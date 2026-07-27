const assert = require("assert");
const Module = require("module");

const handlers = new Map();
const originalError = Object.assign(new Error("The instance is in a crash loop."), {
  code: "INSTANCE_CRASH_LOOP",
  status: 409,
  details: { retryable: false, suggestion: "Inspect the latest server log before starting again.", nodeId: "node-a" },
});
const serviceNames = [
  "clearInstanceLogs", "createInstance", "createInstanceFolder", "deleteInstance", "deleteInstanceFile",
  "duplicateInstance", "forgetInstance", "forceKillInstance", "getInstanceLogs", "getInstanceMetrics",
  "getInstanceStatus", "getFiveMReadiness", "getGameServerConfig", "getMinecraftProperties", "listInstanceFiles", "listInstances",
  "openInstanceFolder", "readInstanceFile", "renameInstance", "renameInstanceFile", "restartInstance",
  "saveGameServerConfig", "saveMinecraftProperties", "saveFiveMLicenseKey", "sendInstanceCommand", "startInstance", "stopInstance",
  "updateInstance", "writeInstanceFile",
];
const serviceRouter = Object.fromEntries(serviceNames.map((name) => [name, async () => ({})]));
serviceRouter.createInstance = async () => { throw originalError; };

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (request === "../services/serviceRouter") return serviceRouter;
  if (request === "../services/securityService") return { audit: () => {}, checkRateLimit: () => {}, requirePermission: () => ({}) };
  if (request === "./expectedAgentError") return { wrapExpectedAgentRead: async (_channel, task) => task() };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require("../src/ipc/instancesIpc").registerInstancesIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  const handler = handlers.get("instances:create");
  assert(handler, "Instance creation handler should be registered.");
  await assert.rejects(
    () => handler({}, { nodeId: "node-a", id: "instance-a", name: "Instance A" }),
    (error) => {
      assert.strictEqual(error.code, "INSTANCE_CRASH_LOOP");
      assert.strictEqual(error.details.retryable, false);
      assert.strictEqual(error.details.suggestion, "Inspect the latest server log before starting again.");
      assert.strictEqual(error.statusCode, 409);
      assert.strictEqual(error.cause, originalError);
      assert.match(error.message, /^INSTANCE_CRASH_LOOP:/);
      return true;
    },
    "Instance IPC should retain the shared structured error contract.",
  );
  console.log("Instance IPC error contract smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
