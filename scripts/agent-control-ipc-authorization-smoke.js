const assert = require("assert");
const Module = require("module");

const handlers = new Map();
const invocations = [];
let ownerAuthorized = false;
let localOwnerAuthenticated = false;
const control = new Proxy({}, {
  get: (_target, property) => (...args) => {
    invocations.push({ property, args });
    return {};
  },
});

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (request === "../services/agentControlService") return control;
  if (request === "../services/securityService") {
    return {
      audit: () => {},
      requireLocalOwnerAuthenticated: () => {
        if (localOwnerAuthenticated) return { username: "owner" };
        throw Object.assign(new Error("Unlock AnxOS to manage the Local Agent."), { code: "AUTH_UNLOCK_REQUIRED" });
      },
      requireOwner: () => {
        if (ownerAuthorized) return { username: "owner" };
        throw Object.assign(new Error("Owner authorization required."), { code: "OWNER_AUTH_REQUIRED" });
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require("../src/ipc/agentControlIpc").registerAgentControlIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  const protectedChannels = [
    "list", "status", "diagnostics", "remoteDiagnostics", "getConfig", "saveConfig",
    "restoreConfig", "resetConfig", "start", "stop", "restart", "forceRestart",
    "installLocalAgent", "pairLocalAgent",
    "startPairingSession", "updateLocalAgent", "installService", "uninstallService",
    "enableAutoStart", "disableAutoStart", "openLogs", "openDataFolder",
  ];

  for (const suffix of protectedChannels) {
    invocations.length = 0;
    const channel = `agentControl:${suffix}`;
    const handler = handlers.get(channel);
    assert(handler, `${channel} should be registered.`);
    await assert.rejects(
      () => Promise.resolve().then(() => handler({}, { nodeId: "node-a" })),
      (error) => error?.code === "AUTH_UNLOCK_REQUIRED",
      `${channel} should require Local Owner authentication.`,
    );
    assert.strictEqual(invocations.length, 0, `${channel} must authorize before invoking Agent Control services.`);
  }

  ownerAuthorized = true;
  localOwnerAuthenticated = true;
  invocations.length = 0;
  await assert.rejects(
    () => handlers.get("agentControl:list")({}, {}),
    (error) => error?.code === "NODE_REQUIRED",
    "Agent Control listing must reject missing canonical target context.",
  );
  assert.strictEqual(invocations.length, 0, "Missing Agent Control target context must not reach the service.");

  console.log("Agent Control IPC authorization smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
