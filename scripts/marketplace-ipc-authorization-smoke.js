const assert = require("assert");
const { EventEmitter } = require("events");
const Module = require("module");

const handlers = new Map();
let serviceInvoked = false;
const events = new EventEmitter();
const marketplaceService = new Proxy({ marketplaceInstallEvents: events }, {
  get: (target, property) => property in target ? target[property] : async () => { serviceInvoked = true; return {}; },
});
const installService = new Proxy({ marketplaceInstallEvents: events }, {
  get: (target, property) => property in target ? target[property] : () => { serviceInvoked = true; return {}; },
});

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") {
    return {
      BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
      dialog: { showOpenDialog: async () => ({ canceled: true }) },
      ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    };
  }
  if (request === "../services/marketplaceService") return marketplaceService;
  if (request === "../services/marketplaceInstallService") return installService;
  if (request === "../services/securityService") {
    return {
      audit: () => {},
      requirePermission: () => { throw Object.assign(new Error("Permission denied."), { code: "PERMISSION_DENIED" }); },
    };
  }
  if (request === "../services/externalUrlService") return { openExternalUrl: async () => { serviceInvoked = true; } };
  return originalLoad.call(this, request, parent, isMain);
};

try {
  require("../src/ipc/marketplaceIpc").registerMarketplaceIpc();
} finally {
  Module._load = originalLoad;
}

async function main() {
  const channels = [
    "marketplace:listTemplates",
    "marketplace:getMinecraftVersions",
    "marketplace:searchProviderPacks",
    "marketplace:getProviderPackVersions",
    "marketplace:getProviderPackDetails",
    "marketplace:getImportSupport",
    "marketplace:getInstallPlan",
    "marketplace:installTemplate",
    "marketplace:installPack",
    "marketplace:getDownloads",
    "marketplace:openManualDownloadPage",
    "marketplace:importManualDownloadFile",
    "marketplace:resumeManualInstall",
    "marketplace:cancelDownload",
    "marketplace:retryDownload",
  ];
  for (const channel of channels) {
    serviceInvoked = false;
    const handler = handlers.get(channel);
    assert(handler, `${channel} should be registered.`);
    const result = await handler({}, { sessionId: "session-a", downloadId: "download-a", nodeId: "node-a" });
    assert.strictEqual(result.ok, false, `${channel} should reject an unauthorized renderer request.`);
    assert.strictEqual(result.error.code, "PERMISSION_DENIED");
    assert.strictEqual(serviceInvoked, false, `${channel} must authorize before continuing the install transaction.`);
  }
  const missingTarget = await handlers.get("marketplace:installTemplate")({}, { templateId: "template-a" });
  assert.strictEqual(missingTarget.ok, false, "Marketplace installation must reject a missing target.");
  assert.strictEqual(missingTarget.error.code, "NODE_REQUIRED");
  assert.strictEqual(serviceInvoked, false, "A missing Marketplace target must not reach install services.");
  console.log("Marketplace IPC authorization smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
