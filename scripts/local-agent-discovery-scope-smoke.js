#!/usr/bin/env node
"use strict";

// Build 213 RC1 acceptance: the new readers of registered computers must not
// run Local Agent discovery. Plain nodeService.listNodes() probes this PC's
// Agent on 127.0.0.1:47131 (health, stats, instances and a dependency check)
// on every call; the fleet list (every 30 s), the Agent update overview and
// the move checks called it that way, and in the installed app each refresh
// re-probed the owner's real Local Agent.
//
// The three IPC modules are loaded with Electron and every service stubbed;
// nodeService records the options of each listNodes call. Each Build 213
// channel is then invoked, and every listNodes call must pass
// discoverLocalAgent: false (registered computers are still health-checked).
//   L1 instances:listAcrossComputers
//   L2 nodes:agentUpdateOverview
//   L3 workload:migrationPreflight
const assert = require("assert");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-discovery-scope-"));
process.env.ANXHUB_CONFIG_DIR = path.join(smokeRoot, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

const calls = [];
const nodes = [
  { id: "lab", kind: "agent", name: "Lab", displayName: "Lab", enabled: true, connection: { status: "online" }, agentStatus: { state: "Connected" } },
  { id: "vps", kind: "agent", name: "VPS", displayName: "VPS", enabled: true, connection: { status: "online" }, agentStatus: { state: "Connected" } },
];
const ipcHandlers = new Map();
const electronStub = {
  ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler), on: () => {}, removeHandler: () => {} },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  app: { getPath: () => smokeRoot, isPackaged: false, getVersion: () => "2.0.0" },
  dialog: {}, shell: {}, clipboard: {}, safeStorage: { isEncryptionAvailable: () => false },
};
const anything = () => new Proxy(function stub() {}, {
  get: (target, property) => (property === "then" ? undefined : anything()),
  apply: () => anything(),
});
const nodeServiceStub = new Proxy({
  listNodes: async (options) => { calls.push(options || {}); return { nodes }; },
  getNodesPath: () => path.join(process.env.ANXHUB_CONFIG_DIR, "nodes.json"),
  getNode: (id) => nodes.find((node) => node.id === id) || null,
  getSelectedNodeId: () => "lab",
  getExecutionTarget: () => ({ type: "agent", nodeId: "lab", config: {} }),
}, { get: (target, property) => (property in target ? target[property] : anything()) });
const securityStub = new Proxy({
  requirePermission: () => ({ role: "Owner" }),
  requireLocalOwnerAuthenticated: () => ({ role: "Owner" }),
  requireOwner: () => ({ role: "Owner" }),
  audit: () => {},
}, { get: (target, property) => (property in target ? target[property] : () => ({})) });

// The Build 213 services that call listNodes stay real; everything else in
// src/services is a stub.
const REAL = new Set(["../services/serverFleetService", "../services/agentUpdateManager", "../services/migrationPreflightService"]);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (request === "../services/nodeService" || request === "./nodeService") return nodeServiceStub;
  if (request === "../services/securityService") return securityStub;
  if (request.startsWith("../services/") && !REAL.has(request)) return anything();
  return originalLoad.call(this, request, parent, isMain);
};
// Kept in place until the end: some handlers require their services when
// they run, and those must be the stubs too (never a real Agent client).
require("../src/ipc/instancesIpc").registerInstancesIpc();
require("../src/ipc/nodesIpc").registerNodesIpc();
require("../src/ipc/workloadIpc").registerWorkloadIpc();

async function invoke(channel, ...args) {
  const handler = ipcHandlers.get(channel);
  assert.ok(handler, `${channel} is registered`);
  calls.length = 0;
  // Stubbed services make later steps fail; only the listNodes calls matter.
  await Promise.resolve(handler({ sender: { send: () => {} } }, ...args)).catch((error) => { if (process.env.DEBUG_SCOPE) console.log(channel, error?.code, error?.message); });
  return [...calls];
}

(async () => {
  const checks = [
    ["L1", "instances:listAcrossComputers", []],
    ["L2", "nodes:agentUpdateOverview", []],
    ["L3", "workload:migrationPreflight", [{ sourceNodeId: "lab", targetNodeId: "vps", instanceId: "survival" }]],
  ];
  for (const [id, channel, args] of checks) {
    const seen = await invoke(channel, ...args);
    assert.ok(seen.length > 0, `${id} ${channel} reads the registered computers`);
    for (const options of seen) {
      assert.strictEqual(options.discoverLocalAgent, false, `${id} ${channel} must not run Local Agent discovery (listNodes ${JSON.stringify(options)})`);
      assert.notStrictEqual(options.refreshIdentity, false, `${id} ${channel} still health-checks the registered computers`);
    }
    console.log(`  ok ${id} ${channel}: ${seen.length} listNodes call(s), none with Local Agent discovery`);
  }
  console.log("Local Agent discovery scope smoke passed (3 checks).");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  Module._load = originalLoad;
  try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch {}
  setTimeout(() => process.exit(process.exitCode || 0), 50);
});
