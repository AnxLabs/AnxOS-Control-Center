const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const { StructuredLogger } = require("../src/shared/structuredLogger");

const handlers = new Map();
let shouldFail = false;
const nestedToken = "provider-nested-bearer-token";
const deepestCause = Object.assign(new Error(`Provider rejected Authorization: Bearer ${nestedToken}`), {
  code: "ERR_BAD_RESPONSE",
});
const providerCause = Object.assign(new Error("Provider request failed."), {
  code: "PROVIDER_HTTP_ERROR",
  cause: deepestCause,
});
const providerError = Object.assign(new Error("Request failed with status code 401"), {
  code: "PROVIDER_REQUEST_FAILED",
  response: {
    status: 401,
    statusText: "Unauthorized",
    data: {
      error: `Authorization: Bearer ${nestedToken}`,
      provider: "modrinth",
    },
  },
  cause: providerCause,
});
const diagnostics = {
  captureSnapshot: () => {
    if (shouldFail) throw providerError;
    return { runtimeState: { applicationRunning: true } };
  },
  copySummary: async () => "summary",
  exportBundle: async () => ({}),
  log: () => ({}),
  openFolder: async () => ({}),
  readLogs: () => ({}),
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      BrowserWindow: { fromWebContents: () => null },
      clipboard: { writeText: () => {} },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), on: () => {} },
    };
  }
  if (request === "../services/diagnosticsService") return diagnostics;
  if (request === "../services/securityService") return { checkRateLimit: () => {}, requirePermission: () => ({ role: "Owner" }) };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require("../src/ipc/diagnosticsIpc").registerDiagnosticsIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  const handler = handlers.get("diagnostics:capture");
  assert.deepStrictEqual(await handler({}, {}), { runtimeState: { applicationRunning: true } });
  shouldFail = true;
  let thrown;
  await assert.rejects(handler({}, {}), (error) => {
    thrown = error;
    assert.strictEqual(error.code, "PROVIDER_REQUEST_FAILED");
    assert.strictEqual(error.statusCode, 401);
    const serialized = JSON.stringify(error);
    assert(!serialized.includes(nestedToken));
    assert(!JSON.stringify(error.cause).includes(nestedToken));
    assert(serialized.includes("[redacted]"));
    assert.match(error.details.technicalDetails.cause.cause.message, /^Provider rejected Authorization=/);
    assert.strictEqual(error.details.technicalDetails.response.status, 401);
    return true;
  });

  const logDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "anx-ipc-error-contract-"));
  const logger = new StructuredLogger({ directory: logDirectory, source: "ipc", live: true });
  logger.error("provider-request", thrown, { status: thrown.statusCode }, { file: "ipc" });
  const persisted = ["ipc.log", "live.log", "latest-error.json"]
    .map((name) => fs.readFileSync(path.join(logDirectory, name), "utf8"))
    .join("\n");
  assert(!persisted.includes(nestedToken));
  assert(persisted.includes("PROVIDER_REQUEST_FAILED"));
  assert(persisted.includes('"status":401'));
  console.log("Diagnostics IPC error contract smoke checks passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
