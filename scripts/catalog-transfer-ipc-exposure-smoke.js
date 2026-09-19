#!/usr/bin/env node
// Behavioral exposure coverage for the V2-D catalog-transfer channels
// (`marketplace:exportCatalog`, `marketplace:importCatalog`) — the roadmap gap
// recorded in docs/MASTER_ROADMAP.md ("service-level only — no IPC channel and
// no renderer surface exist yet, so nothing in the running app can invoke it").
//
// Two layers, both real (same technique as scripts/preload-exposure-contract-smoke.js,
// which is why the earlier alert/job exposure was trustworthy):
//
//   A. preload.js is loaded with a fake `electron` module; every
//      `ipcRenderer.invoke` is recorded, and each namespace call is asserted to
//      hit the EXACT registered channel with the payload shape
//      src/ipc/marketplaceIpc.js expects, to pass the handler result straight
//      through, and to raise the handler's ok:false payload through
//      invokeMarketplace (code/details preserved).
//
//   B. src/ipc/marketplaceIpc.js is loaded with a fake ipcMain (which records
//      the handlers it registers) and the REAL catalogTransferService; each
//      handler is then invoked with the payload preload would send, and its
//      argument/return contract is asserted end to end (real export bytes, real
//      round-trip import, real typed refusal).
//
// A static "preload.js contains exportCatalog" pin would pass even if the
// namespace called the wrong channel or dropped the payload; layer A exists to
// fail on exactly that.
//
// What this does NOT prove: that the renderer calls these namespaces, that any
// UI renders them, or that a saved file round-trips. No Electron is launched, so
// these channels have no runtime evidence.

const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const path = require("path");
const vm = require("vm");
const { EventEmitter } = require("events");

// Objects created inside the vm context carry that realm's Object.prototype, so
// cross-realm deepStrictEqual is prototype-sensitive. Normalize through JSON.
const asPlain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

let failures = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${label}: ${error.message}`);
  }
}
async function checkAsync(label, fn) {
  try {
    await fn();
    console.log(`  PASS  ${label}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL  ${label}: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Layer A: the real preload.js, with a recording fake electron.
// ---------------------------------------------------------------------------
const invocations = [];
const exposed = {};
const bridgeResponses = new Map();

const fakeElectron = {
  contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
  ipcRenderer: {
    invoke: (channel, payload) => {
      invocations.push({ channel, payload });
      if (bridgeResponses.has(channel)) return Promise.resolve(bridgeResponses.get(channel));
      return Promise.resolve({ ok: true });
    },
    send: () => {},
    on: () => {},
    removeListener: () => {},
  },
};

const preloadSandbox = {
  require: (id) => {
    if (id === "electron") return fakeElectron;
    throw new Error(`Unexpected require in preload sandbox: ${id}`);
  },
  Buffer,
  process,
  console,
  URL,
};
vm.createContext(preloadSandbox);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, "..", "preload.js"), "utf8"), preloadSandbox);

// ---------------------------------------------------------------------------
// Layer B: the real marketplace IPC module, with the real catalogTransferService.
// ---------------------------------------------------------------------------
const ipcHandlers = new Map();
const progressEvents = new EventEmitter();
const fakeIpcElectron = {
  ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler) },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: { showOpenDialog: async () => ({ canceled: true }), showSaveDialog: async () => ({ canceled: true }) },
};

// Recording stub for the heavy marketplace transports this smoke does not
// exercise; the catalog service stays real on purpose.
function makeRecordingProxy(prefix) {
  return new Proxy({}, {
    get: (target, property) => {
      if (typeof property === "symbol") return undefined;
      if (!Object.prototype.hasOwnProperty.call(target, property)) {
        target[property] = async (...args) => ({ _stub: `${prefix}.${String(property)}`, args });
      }
      return target[property];
    },
  });
}

const originalModuleLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return fakeIpcElectron;
  if (request === "../services/marketplaceService") return makeRecordingProxy("marketplaceService");
  if (request === "../services/marketplaceInstallService") {
    return Object.assign(makeRecordingProxy("marketplaceInstallService"), { marketplaceInstallEvents: progressEvents });
  }
  if (request === "../services/securityService") return { requirePermission: () => {}, audit: () => {} };
  if (request === "../services/externalUrlService") return { openExternalUrl: async () => {} };
  return originalModuleLoad.call(this, request, parent, isMain);
};
try {
  require("../src/ipc/marketplaceIpc").registerMarketplaceIpc();
} finally {
  Module._load = originalModuleLoad;
}

const DEPENDENCY_FIXTURE = { kind: "dependency", id: "java", content: { id: "java" } };

async function main() {
  console.log("Catalog transfer IPC exposure contract smoke");
  console.log("-------------------------------------------");

  // ---- Layer A: preload wiring -------------------------------------------
  const anx = exposed.anx;
  assert(anx, "preload must expose the `anx` desktop API");

  check("bridge aliases still resolve to one desktop API (no shadowing)", () => {
    assert.strictEqual(exposed.anx, exposed.anxos);
    assert.strictEqual(exposed.anx, exposed.anxhub);
    assert.strictEqual(exposed.anx, exposed.electronAPI);
  });

  check("marketplace namespace exposes exportCatalog + importCatalog", () => {
    assert.strictEqual(typeof anx.marketplace?.exportCatalog, "function");
    assert.strictEqual(typeof anx.marketplace?.importCatalog, "function");
    // The pre-existing read/install members must be untouched by the addition.
    assert.strictEqual(typeof anx.marketplace?.listTemplates, "function");
    assert.strictEqual(typeof anx.marketplace?.installTemplate, "function");
  });

  await anx.marketplace.exportCatalog({ catalog: [], entries: [DEPENDENCY_FIXTURE] });
  check("exportCatalog -> marketplace:exportCatalog with the export options payload", () => {
    const call = invocations.at(-1);
    assert.strictEqual(call.channel, "marketplace:exportCatalog");
    assert.deepStrictEqual(asPlain(call.payload), { catalog: [], entries: [DEPENDENCY_FIXTURE] });
  });

  await anx.marketplace.exportCatalog();
  check("exportCatalog() -> same channel with an empty options object (no dropped payload)", () => {
    const call = invocations.at(-1);
    assert.strictEqual(call.channel, "marketplace:exportCatalog");
    assert.deepStrictEqual(asPlain(call.payload), {});
  });

  await anx.marketplace.importCatalog({ document: "{\"schemaVersion\":1}", existingEntries: [] });
  check("importCatalog -> marketplace:importCatalog { document, existingEntries }", () => {
    const call = invocations.at(-1);
    assert.strictEqual(call.channel, "marketplace:importCatalog");
    assert.deepStrictEqual(asPlain(call.payload), { document: "{\"schemaVersion\":1}", existingEntries: [] });
  });

  bridgeResponses.set("marketplace:exportCatalog", { ok: true, entryCount: 2, json: "{}" });
  const passthrough = await anx.marketplace.exportCatalog();
  check("exportCatalog returns the handler result verbatim", () => {
    assert.deepStrictEqual(asPlain(passthrough), { ok: true, entryCount: 2, json: "{}" });
  });

  bridgeResponses.set("marketplace:importCatalog", {
    ok: false,
    error: { code: "CATALOG_DOCUMENT_UNPARSEABLE", message: "Catalog document is not valid JSON.", friendlyMessage: "Catalog document is not valid JSON.", details: { message: "Unexpected token" } },
  });
  await checkAsync("importCatalog raises the ok:false payload as a typed error (code + details preserved)", async () => {
    await assert.rejects(
      () => anx.marketplace.importCatalog({ document: "{ not json" }),
      (error) => {
        assert.strictEqual(error.code, "CATALOG_DOCUMENT_UNPARSEABLE");
        assert.strictEqual(error.message, "Catalog document is not valid JSON.");
        assert.deepStrictEqual(asPlain(error.details), { message: "Unexpected token" });
        return true;
      },
    );
  });
  bridgeResponses.clear();

  // ---- Layer B: real handlers against the real service --------------------
  const exportHandler = ipcHandlers.get("marketplace:exportCatalog");
  const importHandler = ipcHandlers.get("marketplace:importCatalog");
  check("main registers both catalog-transfer channels", () => {
    assert.strictEqual(typeof exportHandler, "function", "marketplace:exportCatalog handler missing");
    assert.strictEqual(typeof importHandler, "function", "marketplace:importCatalog handler missing");
  });

  const exportResult = await exportHandler({ sender: {} }, { entries: [DEPENDENCY_FIXTURE] });
  check("exportCatalog handler returns the real export contract", () => {
    assert.strictEqual(exportResult.document.documentType, "anxos.marketplace.catalog-transfer");
    assert.strictEqual(exportResult.schemaVersion, 1);
    assert.strictEqual(exportResult.entryCount, 1);
    assert.strictEqual(exportResult.bytes, Buffer.byteLength(exportResult.json, "utf8"));
    assert.strictEqual(exportResult.document.entries[0].id, "java");
  });

  const exportAgain = await exportHandler({ sender: {} }, { entries: [DEPENDENCY_FIXTURE] });
  check("exportCatalog handler is byte-stable across calls (deterministic document)", () => {
    assert.strictEqual(exportAgain.json, exportResult.json);
  });

  const roundTrip = await importHandler({ sender: {} }, { document: exportResult.json, existingEntries: [] });
  check("importCatalog handler maps { document, existingEntries } onto importCatalog(input, options)", () => {
    assert.deepStrictEqual(roundTrip.counts, { considered: 1, accepted: 1, rejected: 0, unchanged: 0 });
    assert.strictEqual(roundTrip.documentVersion, 1);
    assert.strictEqual(roundTrip.accepted[0].id, "java");
    assert.strictEqual(roundTrip.offlineLimits.length, 7, "every import result must carry the seven offline limits");
  });

  const unparseable = await importHandler({ sender: {} }, { document: "{ not json" });
  check("importCatalog handler propagates the service's typed refusal", () => {
    assert.strictEqual(unparseable.ok, false);
    assert.strictEqual(unparseable.error.code, "CATALOG_DOCUMENT_UNPARSEABLE");
  });

  const noDocument = await importHandler({ sender: {} }, {});
  check("importCatalog handler refuses a missing document with the service's own code", () => {
    assert.strictEqual(noDocument.ok, false);
    assert.strictEqual(noDocument.error.code, "CATALOG_DOCUMENT_INVALID");
  });

  console.log("-------------------------------------------");
  if (failures) {
    console.error(`catalog-transfer-ipc-exposure-smoke FAILED: ${failures} check(s).`);
    process.exit(1);
  }
  console.log("catalog-transfer-ipc-exposure-smoke passed.");
}

main().catch((error) => {
  console.error("catalog-transfer-ipc-exposure-smoke crashed:", error?.stack || error?.message || error);
  process.exit(1);
});
