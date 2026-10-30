const assert = require("assert");
const Module = require("module");

const handlers = new Map();
const secret = "security-secret-token-value";
const originalError = Object.assign(new Error(`Authorization: Bearer ${secret}`), {
  code: "LOGIN_REQUIRED",
  status: 401,
  details: { retryable: true, suggestion: "Sign in and retry.", diagnostics: { token: secret } },
});
const securityService = new Proxy({}, {
  get: (_target, property) => async () => {
    if (property === "login") throw originalError;
    return {};
  },
});
const logEntries = [];

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, shell: { openPath: async () => "" } };
  if (request === "../services/securityService") return securityService;
  if (request === "../services/diagnosticsService") return { log: (...args) => logEntries.push(args) };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require("../src/ipc/securityIpc").registerSecurityIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  const dashboardHandler = handlers.get("security:getDashboard");
  await assert.rejects(
    () => dashboardHandler({}, {}),
    (error) => error?.code === "NODE_REQUIRED",
    "Security Center dashboard requests must reject missing target context.",
  );
  const handler = handlers.get("security:login");
  assert(handler, "Security login handler should be registered.");
  await assert.rejects(
    () => handler({}, { username: "owner", password: "hidden" }),
    (error) => {
      assert.strictEqual(error.code, "LOGIN_REQUIRED");
      assert.strictEqual(error.details.retryable, true);
      assert.strictEqual(error.details.suggestion, "Sign in and retry.");
      assert.strictEqual(error.statusCode, 401);
      assert.notStrictEqual(error.cause, originalError);
      assert.strictEqual(error.cause.code, originalError.code);
      assert(!JSON.stringify(error.details).includes(secret));
      assert(!error.message.includes(secret));
      return true;
    },
    "Security IPC should retain a redacted structured error contract.",
  );
  assert(!JSON.stringify(logEntries).includes(secret), "Security IPC diagnostics must not contain raw failure secrets.");
  console.log("Security IPC error contract smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
