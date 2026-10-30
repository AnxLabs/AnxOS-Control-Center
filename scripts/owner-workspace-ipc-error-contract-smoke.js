const assert = require("assert");
const Module = require("module");

const handlers = new Map();
const secret = "owner-workspace-api-secret";
const originalError = Object.assign(new Error(`api_key=${secret}`), {
  code: "OWNER_ACCESS_REQUIRED",
  status: 403,
  details: { retryable: false, suggestion: "Sign in as Owner.", diagnostics: { authorization: secret } },
});
const workspace = new Proxy({}, {
  get: (_target, property) => () => {
    if (property === "getWorkspace") throw originalError;
    return {};
  },
});

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (request === "../services/ownerWorkspaceService") return workspace;
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require("../src/ipc/ownerWorkspaceIpc").registerOwnerWorkspaceIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  const handler = handlers.get("ownerWorkspace:getWorkspace");
  assert(handler, "Owner Workspace read handler should be registered.");
  await assert.rejects(
    () => handler({}, {}),
    (error) => {
      assert.strictEqual(error.code, "OWNER_ACCESS_REQUIRED");
      assert.strictEqual(error.details.retryable, false);
      assert.strictEqual(error.details.suggestion, "Sign in as Owner.");
      assert.strictEqual(error.statusCode, 403);
      assert.notStrictEqual(error.cause, originalError);
      assert.strictEqual(error.cause.code, originalError.code);
      assert(!JSON.stringify(error.cause).includes(secret));
      assert(!JSON.stringify(error.details).includes(secret));
      assert(!error.message.includes(secret));
      return true;
    },
    "Owner Workspace IPC should retain a redacted structured error contract.",
  );
  console.log("Owner Workspace IPC error contract smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
