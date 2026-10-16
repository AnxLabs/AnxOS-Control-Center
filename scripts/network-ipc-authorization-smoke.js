"use strict";

// Network IPC authorization smoke. Run from the repository root:
//   node scripts/network-ipc-authorization-smoke.js
//
// Exercises every channel registered by src/ipc/networkIpc.js (the V2-K
// Endpoint Manager / connectivity / provider surface) through its real
// handler, with:
//   - the REAL role decisions (securityService.userHasPermission over
//     ROLE_PERMISSIONS) for Admin, Operator, Viewer, Service and an unknown
//     role, behind a guard double that records the call order;
//   - the REAL node-context guard (src/ipc/nodeContext.js);
//   - the REAL error envelopes (createIpcError / normalizeIpcError).
// Endpoint, diagnostics, provider and store services are recording doubles, so
// the smoke proves that no service, store or audit work happens before the
// guard chain authorizes the request.
//
// Covers, per channel: the exact registered channel set; locked sessions
// refused (AUTH_UNLOCK_REQUIRED) before any permission check; the exact
// permission and target each channel asks for; role allow/deny against the
// real role table; guard order (unlock -> permission -> node context -> work);
// node-scoped channels refusing a missing node (NODE_REQUIRED) before any work;
// expected-error envelopes ({ ok: false, error }) vs typed throws for
// unexpected failures; and the endpoints:list composition.
// The permission matrix (scripts/permission-matrix-smoke.js) separately runs
// these channels against real local sessions; this smoke pins the ordering and
// argument contract the matrix does not observe.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// Fail closed: a run that never reaches its summary (for example a read that
// never settles, letting the event loop drain) must not exit 0.
process.exitCode = 1;

let checks = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    checks += 1;
  } catch (error) {
    failures.push(`${name}: ${error && error.stack ? error.stack : String(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Real role decisions: load the real securityService (electron stubbed to a
// temp profile) and use only its pure decision function.
// ---------------------------------------------------------------------------
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-network-ipc-auth-"));
const electronForSecurity = {
  app: { getPath: () => profileDir, getName: () => "AnxOS", getVersion: () => "0.0.0", isPackaged: false, on() {}, whenReady: async () => {} },
  safeStorage: { isEncryptionAvailable: () => false },
  ipcMain: { handle() {} },
  BrowserWindow: class {},
};
const originalLoad = Module._load;
Module._load = function loadForSecurity(request, parent, isMain) {
  if (request === "electron") return electronForSecurity;
  return originalLoad.call(this, request, parent, isMain);
};
let realSecurity;
try {
  realSecurity = require("../src/services/securityService");
} finally {
  Module._load = originalLoad;
}
assert.strictEqual(typeof realSecurity.userHasPermission, "function", "the real permission decision is available");

// ---------------------------------------------------------------------------
// Recording doubles. `log` captures the order of guard and work calls.
// ---------------------------------------------------------------------------
const session = { unlocked: true, user: { id: "u1", role: "Admin" } };
const log = [];
const serviceBehavior = {};   // name -> function(args) overriding the default result

function recorder(name, result) {
  return (...args) => {
    log.push({ kind: "work", name, args });
    if (typeof serviceBehavior[name] === "function") return serviceBehavior[name](...args);
    return typeof result === "function" ? result(...args) : result;
  };
}

const securityDouble = {
  audit: (entry) => { log.push({ kind: "audit", entry }); },
  requireLocalOwnerAuthenticated: (target, message) => {
    log.push({ kind: "unlock", target });
    if (!session.unlocked) {
      throw Object.assign(new Error(message), { code: "AUTH_UNLOCK_REQUIRED", friendlyMessage: message });
    }
    return session.user;
  },
  requirePermission: (permission, target) => {
    log.push({ kind: "permission", permission, target });
    if (!realSecurity.userHasPermission(session.user, permission)) {
      throw Object.assign(new Error("Your role does not allow this action."), { code: "PERMISSION_DENIED" });
    }
    return session.user;
  },
};

const endpointServiceDouble = {
  listEndpoints: recorder("listEndpoints", [{ id: "ep-1", host: "anx.example", port: 25565 }]),
  getEndpointSummary: recorder("getEndpointSummary", { total: 1, enabled: 1, degraded: false }),
  createEndpoint: recorder("createEndpoint", (input) => ({ id: "ep-new", ...input })),
  updateEndpoint: recorder("updateEndpoint", (id) => ({ id })),
  deleteEndpoint: recorder("deleteEndpoint", (id) => ({ id, deleted: true })),
  setEndpointEnabled: recorder("setEndpointEnabled", (id, enabled) => ({ id, enabled })),
  associateEndpoint: recorder("associateEndpoint", (payload) => ({ id: payload.endpointId })),
  discoverEndpoints: recorder("discoverEndpoints", { created: [], updated: [] }),
};
const diagnosticsDouble = {
  runDiagnostics: recorder("runDiagnostics", { status: "ok" }),
  getCachedDiagnostics: recorder("getCachedDiagnostics", { status: "cached" }),
  // Cache-only projection of the latest endpoint evaluation (ep-1 was tested).
  projectEndpointHealth: (endpoints) => {
    log.push({ kind: "work", name: "projectEndpointHealth", args: [] });
    return endpoints.map((endpoint) => (endpoint.id === "ep-1"
      ? { ...endpoint, health: { status: "healthy", state: "healthy", checkedAt: "2026-10-15T12:00:00.000Z", source: "diagnostics" }, lastCheckedAt: "2026-10-15T12:00:00.000Z" }
      : endpoint));
  },
};
const providerDouble = {
  getProviderSnapshot: recorder("getProviderSnapshot", { providers: [] }),
  syncTunnels: recorder("syncTunnels", { ok: true }),
};
const storeDouble = {
  getEndpointStore: () => {
    log.push({ kind: "work", name: "getEndpointStore", args: [] });
    return { getProviderSyncs: () => ({ "node-a": { providerId: "playit", tunnelCount: 2 } }), loadReport: { legacyMigration: { migrated: 1 } } };
  },
};

const handlers = new Map();
Module._load = function loadForNetworkIpc(request, parent, isMain) {
  if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
  if (request === "../services/endpointService") return endpointServiceDouble;
  if (request === "../services/connectivityDiagnosticsService") return diagnosticsDouble;
  if (request === "../services/providerIntegrationService") return providerDouble;
  if (request === "../services/endpointStore") return storeDouble;
  if (request === "../services/securityService") return securityDouble;
  // the real node-context guard logs its refusal through diagnosticsService
  if (request === "../services/diagnosticsService") return { log: () => {}, logError: () => {} };
  return originalLoad.call(this, request, parent, isMain);
};
try {
  require("../src/ipc/networkIpc").registerNetworkIpc();
} finally {
  Module._load = originalLoad;
}

// ---------------------------------------------------------------------------
// Channel contract: permission, target field, node scoping, envelope, the
// work it must reach, and its audit action.
// ---------------------------------------------------------------------------
const PAYLOAD = Object.freeze({ nodeId: "node-a", endpointId: "ep-1", id: "ep-1", serviceId: "svc-1", enabled: false, name: "Entry" });
const CHANNELS = [
  { channel: "endpoints:list", permission: "endpoints:read", target: "nodeId", node: false, envelope: false, work: "listEndpoints", audit: "endpoints.list" },
  { channel: "endpoints:create", permission: "endpoints:write", target: "nodeId", node: false, envelope: false, work: "createEndpoint", audit: "endpoint.create", auditAfterWork: true },
  { channel: "endpoints:update", permission: "endpoints:write", target: "id", node: false, envelope: false, work: "updateEndpoint", audit: "endpoint.update" },
  { channel: "endpoints:delete", permission: "endpoints:write", target: "id", node: false, envelope: false, work: "deleteEndpoint", audit: "endpoint.delete" },
  { channel: "endpoints:setEnabled", permission: "endpoints:write", target: "id", node: false, envelope: false, work: "setEndpointEnabled", audit: "endpoint.toggle" },
  { channel: "endpoints:associate", permission: "endpoints:write", target: "endpointId", node: false, envelope: false, work: "associateEndpoint", audit: "endpoint.associate" },
  { channel: "endpoints:discover", permission: "endpoints:write", target: "nodeId", node: true, envelope: true, work: "discoverEndpoints", audit: "endpoint.discover" },
  { channel: "endpoints:test", permission: "diagnostics:run", target: "endpointId", node: true, envelope: true, work: "runDiagnostics", audit: "endpoint.test" },
  { channel: "connectivity:getDiagnostics", permission: "endpoints:read", target: "nodeId", node: true, envelope: true, work: "getCachedDiagnostics", audit: "connectivity.getDiagnostics" },
  { channel: "connectivity:runDiagnostics", permission: "diagnostics:run", target: "nodeId", node: true, envelope: true, work: "runDiagnostics", audit: "connectivity.runDiagnostics" },
  { channel: "providers:getStatus", permission: "providers:read", target: "nodeId", node: true, envelope: false, work: "getProviderSnapshot", audit: "providers.getStatus" },
  { channel: "providers:sync", permission: "providers:sync", target: "nodeId", node: true, envelope: true, work: "syncTunnels", audit: "provider.sync" },
];
const ROLES = ["Admin", "Operator", "Viewer", "Service", "NotARealRole"];

async function invoke(channel, payload) {
  log.length = 0;
  const handler = handlers.get(channel);
  assert.ok(handler, `${channel} is registered`);
  try {
    return { value: await handler({}, { ...payload }) };
  } catch (error) {
    return { error };
  }
}
const kinds = () => log.map((entry) => (entry.kind === "work" ? `work:${entry.name}` : entry.kind));
const workCalls = () => log.filter((entry) => entry.kind === "work");

async function main() {
  await test("exactly the documented channels are registered", async () => {
    assert.deepStrictEqual([...handlers.keys()].sort(), CHANNELS.map((entry) => entry.channel).sort());
  });

  await test("the channel permissions exist in the real role table", async () => {
    const admin = realSecurity.ROLE_PERMISSIONS.Admin;
    for (const { channel, permission } of CHANNELS) {
      assert.ok(admin.includes(permission), `${channel}: ${permission} is a real permission`);
    }
  });

  await test("a locked session is refused before any permission check or work", async () => {
    session.unlocked = false;
    session.user = { id: "u1", role: "Admin" };
    try {
      for (const { channel } of CHANNELS) {
        const r = await invoke(channel, PAYLOAD);
        assert.ok(r.error, `${channel} rejects`);
        assert.strictEqual(r.error.code, "AUTH_UNLOCK_REQUIRED", `${channel}: ${r.error.code}`);
        assert.deepStrictEqual(kinds(), ["unlock"], `${channel}: nothing after the unlock check (${kinds().join(",")})`);
      }
    } finally {
      session.unlocked = true;
    }
  });

  await test("each role is allowed or refused exactly as the real role table says", async () => {
    let allowed = 0;
    let denied = 0;
    for (const role of ROLES) {
      session.user = { id: `user-${role}`, role };
      for (const spec of CHANNELS) {
        const r = await invoke(spec.channel, PAYLOAD);
        const permissionCall = log.find((entry) => entry.kind === "permission");
        assert.ok(permissionCall, `${role} ${spec.channel}: the permission is checked`);
        assert.strictEqual(permissionCall.permission, spec.permission, `${spec.channel} asks for ${spec.permission}`);
        assert.strictEqual(permissionCall.target, PAYLOAD[spec.target], `${spec.channel} passes its ${spec.target} as the target`);
        const mayRun = realSecurity.userHasPermission(session.user, spec.permission);
        if (mayRun) {
          allowed += 1;
          assert.ok(!r.error, `${role} ${spec.channel} allowed (${r.error && r.error.code})`);
          if (spec.envelope) assert.notStrictEqual(r.value && r.value.ok, false, `${role} ${spec.channel}: no refusal envelope`);
          const order = kinds();
          assert.strictEqual(order[0], "unlock");
          assert.strictEqual(order[1], "permission");
          assert.ok(order.includes(`work:${spec.work}`), `${role} ${spec.channel} reaches ${spec.work} (${order.join(",")})`);
          const auditIndex = order.indexOf("audit");
          assert.ok(auditIndex > 1, `${spec.channel} audits after authorization`);
          assert.strictEqual(log[auditIndex].entry.action, spec.audit);
          if (spec.auditAfterWork) assert.ok(auditIndex > order.indexOf(`work:${spec.work}`), `${spec.channel} audits the created record`);
        } else {
          denied += 1;
          assert.ok(r.error, `${role} ${spec.channel} refused`);
          assert.strictEqual(r.error.code, "PERMISSION_DENIED", `${role} ${spec.channel}: ${r.error.code}`);
          assert.deepStrictEqual(kinds(), ["unlock", "permission"], `${role} ${spec.channel}: no audit or work after a refusal (${kinds().join(",")})`);
        }
      }
    }
    // The table must produce real allow and deny outcomes, not a constant.
    assert.ok(allowed >= 12 && denied >= 12, `allowed=${allowed} denied=${denied}`);
    session.user = { id: "u1", role: "Admin" };
  });

  await test("role outcomes match the documented tiers", async () => {
    const expectAllowed = {
      Admin: CHANNELS.map((entry) => entry.channel),
      Operator: ["endpoints:list", "endpoints:test", "connectivity:getDiagnostics", "connectivity:runDiagnostics", "providers:getStatus"],
      Viewer: ["endpoints:list", "connectivity:getDiagnostics", "providers:getStatus"],
      Service: [],
      NotARealRole: [],
    };
    for (const [role, channels] of Object.entries(expectAllowed)) {
      session.user = { id: `user-${role}`, role };
      const actual = [];
      for (const { channel } of CHANNELS) {
        const r = await invoke(channel, PAYLOAD);
        if (!r.error) actual.push(channel);
      }
      assert.deepStrictEqual(actual.sort(), [...channels].sort(), `${role} may run exactly its tier`);
    }
    session.user = { id: "u1", role: "Admin" };
  });

  await test("node-scoped channels refuse a missing node before any work", async () => {
    session.user = { id: "u1", role: "Admin" };
    for (const spec of CHANNELS.filter((entry) => entry.node)) {
      for (const nodeId of [undefined, "", "   "]) {
        const payload = { ...PAYLOAD, nodeId };
        const r = await invoke(spec.channel, payload);
        if (spec.envelope) {
          assert.ok(!r.error, `${spec.channel}: expected refusal resolves`);
          assert.strictEqual(r.value.ok, false);
          assert.strictEqual(r.value.error.code, "NODE_REQUIRED");
        } else {
          assert.ok(r.error, `${spec.channel}: rejects`);
          assert.strictEqual(r.error.code, "NODE_REQUIRED");
        }
        assert.strictEqual(workCalls().length, 0, `${spec.channel}: no work without a node`);
        assert.ok(!kinds().includes("audit"), `${spec.channel}: no audit without a node`);
      }
    }
    // node-free channels do not demand a node
    for (const spec of CHANNELS.filter((entry) => !entry.node)) {
      const r = await invoke(spec.channel, { ...PAYLOAD, nodeId: undefined });
      assert.ok(!r.error, `${spec.channel} needs no node (${r.error && r.error.code})`);
    }
  });

  await test("expected failures resolve the envelope; unexpected failures throw typed errors", async () => {
    session.user = { id: "u1", role: "Admin" };
    const expected = [
      ["providers:sync", "syncTunnels", Object.assign(new Error("agent down"), { code: "AGENT_UNAVAILABLE" })],
      ["providers:sync", "syncTunnels", Object.assign(new Error("bad tunnel"), { code: "ENDPOINT_VALIDATION_FAILED" })],
      ["endpoints:discover", "discoverEndpoints", Object.assign(new Error("no agent"), { code: "ENDPOINT_AGENT_UNAVAILABLE" })],
      ["endpoints:test", "runDiagnostics", Object.assign(new Error("unauthorized"), { status: 401 })],
      ["connectivity:runDiagnostics", "runDiagnostics", Object.assign(new Error("refused"), { code: "ECONNREFUSED" })],
    ];
    for (const [channel, work, error] of expected) {
      serviceBehavior[work] = () => { throw error; };
      const r = await invoke(channel, PAYLOAD);
      delete serviceBehavior[work];
      assert.ok(!r.error, `${channel}: ${error.code || error.status} resolves`);
      assert.strictEqual(r.value.ok, false);
      assert.ok(r.value.error, `${channel}: carries the sanitized error`);
    }
    const unexpected = [["providers:sync", "syncTunnels"], ["endpoints:discover", "discoverEndpoints"], ["providers:getStatus", "getProviderSnapshot"], ["endpoints:create", "createEndpoint"]];
    for (const [channel, work] of unexpected) {
      serviceBehavior[work] = () => { throw new Error("disk exploded"); };
      const r = await invoke(channel, PAYLOAD);
      delete serviceBehavior[work];
      assert.ok(r.error, `${channel}: an unexpected failure throws`);
      assert.strictEqual(r.error.code, "NETWORK_REQUEST_FAILED", `${channel}: ${r.error.code}`);
    }
    // an expected code on a non-envelope channel still throws (providers:getStatus)
    serviceBehavior.getProviderSnapshot = () => { throw Object.assign(new Error("agent down"), { code: "AGENT_UNAVAILABLE" }); };
    const status = await invoke("providers:getStatus", PAYLOAD);
    delete serviceBehavior.getProviderSnapshot;
    assert.ok(status.error, "providers:getStatus has no expected-error envelope");
  });

  await test("work receives the documented arguments", async () => {
    session.user = { id: "u1", role: "Admin" };
    const args = async (channel, work) => {
      await invoke(channel, PAYLOAD);
      const call = workCalls().find((entry) => entry.name === work);
      assert.ok(call, `${channel} reaches ${work}`);
      return call.args;
    };
    assert.deepStrictEqual(await args("endpoints:update", "updateEndpoint"), ["ep-1", { ...PAYLOAD }]);
    assert.deepStrictEqual(await args("endpoints:setEnabled", "setEndpointEnabled"), ["ep-1", false]);
    assert.deepStrictEqual(await args("endpoints:discover", "discoverEndpoints"), [{ nodeId: "node-a", serviceId: "svc-1" }]);
    assert.deepStrictEqual(await args("endpoints:test", "runDiagnostics"), [{ nodeId: "node-a", endpointId: "ep-1", refresh: true }]);
    assert.deepStrictEqual(await args("connectivity:getDiagnostics", "getCachedDiagnostics"), [{ nodeId: "node-a", serviceId: "svc-1", endpointId: "ep-1" }]);
    assert.deepStrictEqual(await args("connectivity:runDiagnostics", "runDiagnostics"), [{ nodeId: "node-a", serviceId: "svc-1", endpointId: "ep-1", refresh: true }]);
    assert.deepStrictEqual(await args("providers:getStatus", "getProviderSnapshot"), [{ nodeId: "node-a" }]);
    assert.deepStrictEqual(await args("providers:sync", "syncTunnels"), [{ nodeId: "node-a" }]);
  });

  await test("endpoints:list composes endpoints, summary, provider syncs and migration; a summary failure degrades", async () => {
    session.user = { id: "u1", role: "Viewer" };
    const r = await invoke("endpoints:list", { nodeId: "node-a", type: "public", enabled: true, ignored: "x" });
    assert.ok(!r.error);
    // The cached evaluation is projected onto the returned record (a completed
    // test stays visible after the refresh) and into the summary health counts.
    assert.deepStrictEqual(r.value.endpoints, [{
      id: "ep-1", host: "anx.example", port: 25565,
      health: { status: "healthy", state: "healthy", checkedAt: "2026-10-15T12:00:00.000Z", source: "diagnostics" },
      lastCheckedAt: "2026-10-15T12:00:00.000Z",
    }]);
    assert.deepStrictEqual(r.value.summary, { total: 1, enabled: 1, degraded: false, byHealth: { healthy: 1 } });
    assert.deepStrictEqual(r.value.providerSyncs, { "node-a": { providerId: "playit", tunnelCount: 2 } });
    assert.deepStrictEqual(r.value.migration, { migrated: 1 });
    assert.strictEqual(r.value.degraded, false);
    assert.deepStrictEqual(workCalls().find((entry) => entry.name === "listEndpoints").args, [{ nodeId: "node-a", type: "public", enabled: true }], "only documented filter keys pass");
    serviceBehavior.getEndpointSummary = () => { throw new Error("summary failed"); };
    const degraded = await invoke("endpoints:list", { nodeId: "node-a" });
    delete serviceBehavior.getEndpointSummary;
    assert.ok(!degraded.error, "a summary failure does not fail the list");
    assert.strictEqual(degraded.value.summary, null);
    session.user = { id: "u1", role: "Admin" };
  });

  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch { /* best effort */ }
  if (failures.length) {
    console.error(`network-ipc-authorization smoke: ${failures.length} failed, ${checks} passed`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`network-ipc-authorization smoke: all ${checks} test groups passed`);
  process.exitCode = 0;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
