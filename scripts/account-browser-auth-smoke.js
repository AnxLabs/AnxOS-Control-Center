#!/usr/bin/env node
const assert = require("assert");
const Module = require("module");

const handlers = new Map();
const openedUrls = [];
const originalLoad = Module._load;

const accountService = {
  cancelDeviceLogin: async () => ({}),
  checkDeviceLogin: async () => ({}),
  getStatus: () => ({}),
  listAccountDevices: async () => [],
  loginWithPassword: async () => ({}),
  logout: async () => ({}),
  openAccountPage: async () => {
    const url = "https://anxoscontrolcenter.org/signin/";
    openedUrls.push(url);
    return { ok: true, url };
  },
  redactSecret: (value) => String(value),
  refreshSession: async () => ({}),
  restoreSession: async () => ({}),
  revokeCurrentDevice: async () => ({}),
  startDeviceLogin: async () => ({}),
};

Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  }
  if (request === "../services/accountAuthService") return accountService;
  if (request === "../services/diagnosticsService") return { log: () => {}, logError: () => {} };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require("../src/ipc/accountAuthIpc").registerAccountAuthIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  const openHandler = handlers.get("account:openPage");
  assert(openHandler, "Continue in Browser must have a registered account:openPage handler.");
  const result = await openHandler();
  assert.strictEqual(result.ok, true, "Continue in Browser should return a successful bounded IPC result.");
  assert.deepStrictEqual(openedUrls, ["https://anxoscontrolcenter.org/signin/"], "Continue in Browser should open the canonical AnxOS sign-in route.");

  let shellInvoked = false;
  const externalUrlPath = require.resolve("../src/services/externalUrlService");
  delete require.cache[externalUrlPath];
  Module._load = function patchedElectron(request, parent, isMain) {
    if (request === "electron") return { shell: { openExternal: async () => { shellInvoked = true; } } };
    if (request === "./diagnosticsService") return { log: () => {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  let externalUrlService;
  try {
    externalUrlService = require(externalUrlPath);
  } finally {
    Module._load = originalLoad;
  }
  await assert.rejects(
    () => externalUrlService.openExternalUrl("not a valid auth URL", { source: "account-page" }),
    (error) => error?.code === "EXTERNAL_URL_BLOCKED",
    "Invalid account URLs should be rejected with a friendly bounded code.",
  );
  assert.strictEqual(shellInvoked, false, "Invalid account URLs must never reach shell.openExternal.");

  console.log("Account browser auth smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
