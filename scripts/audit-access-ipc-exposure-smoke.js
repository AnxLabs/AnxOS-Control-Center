#!/usr/bin/env node
// Behavioral exposure coverage for the V2-I audit retention / access review /
// export channels (`security:getAuditRetentionReport`, `security:getAuditAccessReview`,
// `security:exportAuditWindow`) — this smoke closed the gap once recorded in
// docs/MASTER_ROADMAP.md ("the three functions have no IPC channel or renderer
// surface yet, so nothing in the running app can invoke them"); the roadmap
// annotation now records the wiring this smoke pins.
//
// Two layers, both real (the scripts/preload-exposure-contract-smoke.js technique):
//
//   A. preload.js is loaded with a fake `electron` module and every
//      `ipcRenderer.invoke` is recorded, asserting each namespace call hits the
//      EXACT registered channel with the payload shape src/ipc/securityIpc.js
//      expects and returns the handler result verbatim (the security namespace
//      uses the plain invoke form — it does not unwrap ok:false).
//
//   B. src/ipc/securityIpc.js is loaded with a fake ipcMain and the REAL
//      securityService over a seeded store; each handler is invoked with the
//      payload preload would send and its argument/return contract is asserted
//      against the service, including the settings:write gate (an Owner gets the
//      report, a Viewer gets PERMISSION_DENIED) and typed error propagation.
//
// What this does NOT prove: that the renderer calls these namespaces, that any
// UI renders them, or that audit data is pruned (this build only reports the
// retention decision). No Electron is launched, so these channels have no
// runtime evidence.

const assert = require("assert");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const vm = require("vm");

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
async function expectRejects(label, operation, predicate, description) {
  try {
    await operation();
    failures += 1;
    console.error(`  FAIL  ${label}: expected a rejection (${description}) but the handler resolved.`);
  } catch (error) {
    try {
      assert(predicate(error), description);
      console.log(`  PASS  ${label}`);
    } catch (assertionError) {
      failures += 1;
      console.error(`  FAIL  ${label}: ${assertionError.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Hermetic root pinning. Must run BEFORE securityService is required.
// ---------------------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-audit-ipc-exposure-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

const security = require("../src/services/securityService");

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const OLD = new Date(NOW - 40 * DAY_MS).toISOString();
const RECENT = new Date(NOW - 60 * 60 * 1000).toISOString();
const WINDOW_FROM = new Date(NOW - 2 * DAY_MS).toISOString();
const WINDOW_TO = new Date(NOW + DAY_MS).toISOString();
const SECRET_VALUE = "SEEDEDSECRETVALUE7c21";
const OWNER_PASSWORD = "audit-ipc-owner-password";
const VIEWER_PASSWORD = "audit-ipc-viewer-password";

// ---------------------------------------------------------------------------
// Layer A: the real preload.js, with a recording fake electron.
// ---------------------------------------------------------------------------
const invocations = [];
const exposed = {};
const bridgeResponses = new Map();
const fakePreloadElectron = {
  contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
  ipcRenderer: {
    invoke: (channel, payload) => {
      invocations.push({ channel, payload });
      return Promise.resolve(bridgeResponses.has(channel) ? bridgeResponses.get(channel) : { ok: true });
    },
    send: () => {},
    on: () => {},
    removeListener: () => {},
  },
};
const preloadSandbox = {
  require: (id) => {
    if (id === "electron") return fakePreloadElectron;
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
// Layer B: the real security IPC module against the real securityService.
// ---------------------------------------------------------------------------
const ipcHandlers = new Map();
const fakeIpcElectron = {
  ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler) },
  shell: { openPath: async () => "" },
};
const originalModuleLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return fakeIpcElectron;
  if (request === "../services/diagnosticsService") return { log: () => {}, correlationId: () => "smoke" };
  return originalModuleLoad.call(this, request, parent, isMain);
};
try {
  require("../src/ipc/securityIpc").registerSecurityIpc();
} finally {
  Module._load = originalModuleLoad;
}

const AUDIT_CHANNELS = [
  "security:getAuditRetentionReport",
  "security:getAuditAccessReview",
  "security:exportAuditWindow",
];

function seedAuditLog() {
  const records = [
    { at: OLD, actor: null, action: "alerts.list", outcome: "ok", target: "alerts", reason: null },
    { at: OLD, actor: null, action: "security.login", outcome: "failed", target: "owner", reason: "INVALID_CREDENTIALS" },
    { at: RECENT, actor: null, action: "node.repair-credential", outcome: "ok", target: `Bearer ${SECRET_VALUE}`, reason: null },
  ];
  fs.writeFileSync(path.join(process.env.ANXHUB_CONFIG_DIR, "audit.log"), `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
  return records.length;
}

async function main() {
  console.log("Audit retention IPC exposure contract smoke");
  console.log("------------------------------------------");

  // ---- Layer A: preload wiring -------------------------------------------
  const anx = exposed.anx;
  assert(anx, "preload must expose the `anx` desktop API");

  check("bridge aliases still resolve to one desktop API (no shadowing)", () => {
    assert.strictEqual(exposed.anx, exposed.anxos);
    assert.strictEqual(exposed.anx, exposed.anxhub);
    assert.strictEqual(exposed.anx, exposed.electronAPI);
  });

  check("security namespace exposes the three audit members", () => {
    for (const member of ["getAuditRetentionReport", "getAuditAccessReview", "exportAuditWindow"]) {
      assert.strictEqual(typeof anx.security?.[member], "function", `anx.security.${member} must be a function`);
    }
    // The pre-existing members must be untouched by the addition.
    assert.strictEqual(typeof anx.security?.getDashboard, "function");
    assert.strictEqual(typeof anx.security?.openAuditFolder, "function");
  });

  await anx.security.getAuditRetentionReport({ now: NOW, windowMs: 30 * DAY_MS });
  check("getAuditRetentionReport -> security:getAuditRetentionReport with the options payload", () => {
    const call = invocations.at(-1);
    assert.strictEqual(call.channel, "security:getAuditRetentionReport");
    assert.deepStrictEqual(asPlain(call.payload), { now: NOW, windowMs: 30 * DAY_MS });
  });

  await anx.security.getAuditAccessReview();
  check("getAuditAccessReview() -> security:getAuditAccessReview with an empty options object", () => {
    const call = invocations.at(-1);
    assert.strictEqual(call.channel, "security:getAuditAccessReview");
    assert.deepStrictEqual(asPlain(call.payload), {});
  });

  await anx.security.exportAuditWindow({ from: WINDOW_FROM, to: WINDOW_TO, now: NOW });
  check("exportAuditWindow -> security:exportAuditWindow { from, to, now }", () => {
    const call = invocations.at(-1);
    assert.strictEqual(call.channel, "security:exportAuditWindow");
    assert.deepStrictEqual(asPlain(call.payload), { from: WINDOW_FROM, to: WINDOW_TO, now: NOW });
  });

  bridgeResponses.set("security:getAuditRetentionReport", { enforced: false, totalRecords: 3 });
  const bridgePassthrough = await anx.security.getAuditRetentionReport();
  check("security namespace returns the handler result verbatim (plain invoke, no unwrapping)", () => {
    assert.deepStrictEqual(asPlain(bridgePassthrough), { enforced: false, totalRecords: 3 });
  });
  bridgeResponses.clear();

  // ---- Layer B: real handlers over a real, seeded store -------------------
  check("main registers all three audit channels", () => {
    for (const channel of AUDIT_CHANNELS) {
      assert.strictEqual(typeof ipcHandlers.get(channel), "function", `${channel} handler missing`);
    }
  });

  // Sign in first, THEN seed the audit log: setupAdmin/login write audit lines
  // of their own, and seeding last pins the store to exactly the known set below.
  await security.setupAdmin({ username: "owner", password: OWNER_PASSWORD });
  await security.login({ username: "owner", password: OWNER_PASSWORD });
  const seededCount = seedAuditLog();

  const retentionHandler = ipcHandlers.get("security:getAuditRetentionReport");
  const reviewHandler = ipcHandlers.get("security:getAuditAccessReview");
  const exportHandler = ipcHandlers.get("security:exportAuditWindow");

  const retention = await retentionHandler({}, { now: NOW, windowMs: 30 * DAY_MS });
  check("getAuditRetentionReport handler returns the real retention-decision contract", () => {
    assert.strictEqual(retention.enforced, false, "retention must be reported as a decision, not an enforcement");
    assert.strictEqual(typeof retention.enforcementNote, "string");
    assert.strictEqual(retention.totalRecords, seededCount);
    assert(Array.isArray(retention.policy?.rules) && retention.policy.rules.length > 0, "the report must publish the retention rules");
    assert.strictEqual(typeof retention.prunedByClass, "object");
    assert.strictEqual(typeof retention.protectedRetained, "object");
  });

  const review = await reviewHandler({}, { from: WINDOW_FROM, to: WINDOW_TO, now: NOW });
  check("getAuditAccessReview handler projects the seeded window", () => {
    assert.strictEqual(review.recordCount, 1, "only the in-window record may be projected");
    assert(!JSON.stringify(review).includes(SECRET_VALUE), "the access review must not leak the seeded secret");
  });

  const exported = await exportHandler({}, { from: WINDOW_FROM, to: WINDOW_TO, now: NOW });
  check("exportAuditWindow handler returns the redacted, deterministic export contract", () => {
    assert.strictEqual(typeof exported.json, "string");
    assert.strictEqual(exported.recordCount, 1);
    assert.strictEqual(exported.redacted, true);
    assert.strictEqual(exported.deterministic, true);
    assert.strictEqual(typeof exported.maxExportRecords, "number");
    assert.strictEqual(JSON.parse(exported.json).schema, "anxos.audit.export");
    assert(!exported.json.includes(SECRET_VALUE), "the export must not leak the seeded secret");
  });

  const exportedAgain = await exportHandler({}, { from: WINDOW_FROM, to: WINDOW_TO, now: NOW });
  check("exportAuditWindow handler is byte-identical across calls", () => {
    assert.strictEqual(exportedAgain.json, exported.json);
  });

  await expectRejects(
    "exportAuditWindow handler propagates the service's typed refusal for an over-cap window",
    () => exportHandler({}, { now: NOW, maxExportRecords: 1 }),
    (error) => error.code === "AUDIT_EXPORT_WINDOW_TOO_LARGE",
    "expected code AUDIT_EXPORT_WINDOW_TOO_LARGE",
  );

  // ---- Layer B: the settings:write gate is the service's, untouched -------
  const securityPath = path.join(process.env.ANXHUB_CONFIG_DIR, "security.json");
  const state = JSON.parse(fs.readFileSync(securityPath, "utf8"));
  state.users.push({
    id: "viewer-1",
    username: "viewer1",
    role: "Viewer",
    passwordHash: bcrypt.hashSync(VIEWER_PASSWORD, 12),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastLoginAt: null,
  });
  fs.writeFileSync(securityPath, `${JSON.stringify(state, null, 2)}\n`);
  security.logout();
  await security.login({ username: "viewer1", password: VIEWER_PASSWORD });

  await expectRejects(
    "a Viewer is refused by the service's settings:write gate (retention)",
    () => retentionHandler({}, { now: NOW }),
    (error) => error.code === "PERMISSION_DENIED",
    "expected PERMISSION_DENIED",
  );
  await expectRejects(
    "a Viewer is refused by the service's settings:write gate (access review)",
    () => reviewHandler({}, { now: NOW }),
    (error) => error.code === "PERMISSION_DENIED",
    "expected PERMISSION_DENIED",
  );
  await expectRejects(
    "a Viewer is refused by the service's settings:write gate (export)",
    () => exportHandler({}, { from: WINDOW_FROM, to: WINDOW_TO, now: NOW }),
    (error) => error.code === "PERMISSION_DENIED",
    "expected PERMISSION_DENIED",
  );

  console.log("------------------------------------------");
  if (failures) {
    console.error(`audit-access-ipc-exposure-smoke FAILED: ${failures} check(s).`);
    process.exit(1);
  }
  console.log("audit-access-ipc-exposure-smoke passed.");
}

main().catch((error) => {
  console.error("audit-access-ipc-exposure-smoke crashed:", error?.stack || error?.message || error);
  process.exit(1);
});