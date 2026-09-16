const assert = require("assert");
const Module = require("module");

const handlers = new Map();
const diagnosticEntries = [];
const secret = "dependency-command-secret";
const originalError = Object.assign(new Error(`password=${secret}`), {
  code: "DEPENDENCY_OS_UNSUPPORTED",
  status: 409,
  details: { retryable: false, suggestion: "Select a supported node.", provider: "apt", diagnostics: { password: secret } },
});
const serviceRouter = {
  checkDependencies: async () => { throw originalError; },
  getDependencyCatalog: async () => ({}),
  installDependencies: async () => ({}),
  planDependencyPreparation: async () => ({}),
};
const marketplaceService = {
  createDependencyInstallRecord: () => ({}),
  finalizeDependencyInstallRecord: () => ({}),
  updateDependencyInstallRecord: () => ({}),
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (request === "../services/serviceRouter") return serviceRouter;
  if (request === "../services/marketplaceService") return marketplaceService;
  if (request === "../services/diagnosticsService") return {
    updateRuntimeState: () => {},
    log: (...args) => diagnosticEntries.push(args),
  };
  if (request === "../services/securityService") return { audit: () => {}, requirePermission: () => ({}) };
  if (request === "./nodeContext") return { requireNodeContext: (payload) => payload };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require("../src/ipc/dependenciesIpc").registerDependenciesIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  const handler = handlers.get("dependencies:check");
  assert(handler, "Dependency check handler should be registered.");
  const result = await handler({}, { nodeId: "node-a" });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.error.code, "DEPENDENCY_OS_UNSUPPORTED");
  assert.strictEqual(result.error.retryable, false);
  assert.strictEqual(result.error.status.code, 409);
  assert.strictEqual(result.error.provider.id, "apt");
  assert.strictEqual(result.error.suggestion, "Select a supported node.");
  assert(!JSON.stringify(result).includes(secret), "Dependency IPC errors must redact command credentials.");
  assert.strictEqual(diagnosticEntries.length, 1, "Dependency IPC failures should emit one diagnostic entry.");
  assert.strictEqual(diagnosticEntries[0][2], "dependencies:check", "Dependency diagnostics should identify the failed operation.");
  assert.strictEqual(diagnosticEntries[0][4].errorCode, "DEPENDENCY_OS_UNSUPPORTED", "Dependency diagnostics should record the normalized error code.");
  assert(!JSON.stringify(diagnosticEntries).includes(secret), "Dependency diagnostics must not log command credentials.");
  console.log("Dependency IPC error contract smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
