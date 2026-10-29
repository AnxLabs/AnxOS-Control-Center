const assert = require("assert");
const Module = require("module");

const handlers = new Map();
const originalError = Object.assign(new Error("Docker socket access was denied."), {
  code: "DOCKER_SOCKET_PERMISSION_DENIED",
  status: 403,
  details: { retryable: false, suggestion: "Grant the Agent user access to the Docker socket.", nodeId: "node-a" },
});
const serviceRouter = new Proxy({}, {
  get: (_target, property) => async () => {
    if (property === "inspectDockerContainer") throw originalError;
    return {};
  },
});

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (request === "../services/serviceRouter") return serviceRouter;
  if (request === "../services/securityService") return { audit: () => {}, requirePermission: () => ({}) };
  if (request === "./expectedAgentError") return { wrapExpectedAgentRead: async (_channel, task) => task() };
  if (request === "./nodeContext") return { requireNodeContext: (payload) => payload };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require("../src/ipc/dockerIpc").registerDockerIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  const handler = handlers.get("docker:inspectContainer");
  assert(handler, "Docker inspection handler should be registered.");
  await assert.rejects(
    () => handler({}, { nodeId: "node-a", container: "container-a" }),
    (error) => {
      assert.strictEqual(error.code, "DOCKER_SOCKET_PERMISSION_DENIED");
      assert.strictEqual(error.details.retryable, false);
      assert.strictEqual(error.details.suggestion, "Grant the Agent user access to the Docker socket.");
      assert.strictEqual(error.statusCode, 403);
      assert.notStrictEqual(error.cause, originalError);
      assert.strictEqual(error.cause.code, originalError.code);
      assert.match(error.message, /^DOCKER_SOCKET_PERMISSION_DENIED:/);
      return true;
    },
    "Docker IPC should retain the shared structured error contract.",
  );
  console.log("Docker IPC error contract smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
