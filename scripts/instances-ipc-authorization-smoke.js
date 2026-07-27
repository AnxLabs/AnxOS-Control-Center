const assert = require("assert");
const Module = require("module");

const handlers = new Map();
let serviceInvoked = false;
const serviceNames = [
  "clearInstanceLogs", "createInstance", "createInstanceFolder", "deleteInstance", "deleteInstanceFile",
  "duplicateInstance", "forgetInstance", "forceKillInstance", "getInstanceLogs", "getInstanceMetrics",
  "getInstanceStatus", "getFiveMReadiness", "getGameServerConfig", "getMinecraftProperties", "listInstanceFiles", "listInstances",
  "openInstanceFolder", "readInstanceFile", "renameInstance", "renameInstanceFile", "restartInstance",
  "saveGameServerConfig", "saveMinecraftProperties", "saveFiveMLicenseKey", "sendInstanceCommand", "startInstance", "stopInstance",
  "updateInstance", "writeInstanceFile",
];
const serviceRouter = Object.fromEntries(serviceNames.map((name) => [name, async () => {
  serviceInvoked = true;
  return { ok: true };
}]));

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (request === "../services/serviceRouter") return serviceRouter;
  if (request === "../services/securityService") {
    return {
      audit: () => {},
      checkRateLimit: () => {},
      requirePermission: () => {
        throw Object.assign(new Error("Permission denied."), { code: "PERMISSION_DENIED" });
      },
    };
  }
  if (request === "./expectedAgentError") return { wrapExpectedAgentRead: async (_operation, task) => task() };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  const { registerInstancesIpc } = require("../src/ipc/instancesIpc");
  registerInstancesIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  const protectedChannels = [
    "instances:list",
    "instances:getStatus",
    "instances:getMetrics",
    "instances:getLogs",
    "instances:listFiles",
    "instances:readFile",
    "instances:getGameServerConfig",
    "instances:getMinecraftProperties",
    "instances:getFiveMReadiness",
    "instances:create",
    "instances:update",
    "instances:clearLogs",
    "instances:sendCommand",
    "instances:createFolder",
    "instances:renameFile",
  ];
  for (const channel of protectedChannels) {
    serviceInvoked = false;
    const handler = handlers.get(channel);
    assert(handler, `${channel} should be registered.`);
    await assert.rejects(
      () => handler({}, { nodeId: "node-a", id: "new-instance", instanceId: "instance-a", path: "folder", oldPath: "old", newPath: "new" }),
      (error) => error?.code === "PERMISSION_DENIED",
      `${channel} should reject an unauthorized renderer request.`,
    );
    assert.strictEqual(serviceInvoked, false, `${channel} must authorize before calling its service.`);
  }
  const lifecycleHandler = handlers.get("instances:start");
  assert.throws(
    () => lifecycleHandler({}, { instanceId: "instance-a" }),
    (error) => error?.code === "NODE_REQUIRED",
    "Instance lifecycle requests must reject missing target context before authorization or execution.",
  );
  assert.strictEqual(serviceInvoked, false, "Missing instance target context must not reach the service router.");
  console.log("Instance IPC authorization smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
