"use strict";

// Provider background-probe smoke (V2-K D3). Run from the repository root:
//   node scripts/provider-background-probe-smoke.js
//
// App startup starts two background loops that read provider state: the
// operational notification scheduler (main.js) and the telemetry sampler.
// Reading provider state through providerIntegrationService.getProviderSnapshot
// makes the selected node's Agent run the provider binary (where.exe /
// playit.exe on Windows), so background loops must use the cache-only read.
//
// This wires the REAL scheduler, the REAL telemetry sampler (with its default
// provider path, not an injected one) and the REAL providerIntegrationService
// module exactly as main.js does, replacing only the Agent snapshot entry point
// (serviceRouter.getPlayitSnapshot) with a counter. It proves:
//   - repeated scheduler ticks and telemetry samples make zero snapshot calls;
//   - an explicit refresh (the Network page) does call it, once;
//   - the background loops then report that last-known state without calling it
//     again, so notifications and telemetry stay useful.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

// Fail closed: a run that never reaches its summary must not exit 0.
process.exitCode = 1;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-provider-probe-"));
const NODE = "agent-node-1";
const agent = { snapshotCalls: 0 };

const routerStub = {
  getPlayitSnapshot: async ({ nodeId } = {}) => {
    agent.snapshotCalls += 1;
    agent.lastNodeId = nodeId;
    return { installed: true, running: true, connected: true, tunnelAddress: "anx-mc.joinmc.link:23001", tunnels: [] };
  },
};
const electronStub = {
  app: { getPath: () => tempDir, getName: () => "AnxOS", getVersion: () => "0.0.0", isPackaged: false, on() {}, whenReady: async () => {} },
  ipcMain: { handle() {} },
};
const originalLoad = Module._load;
Module._load = function loadWithAgentCounter(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (request === "./serviceRouter") return routerStub;
  return originalLoad.call(this, request, parent, isMain);
};

const providerIntegrationService = require("../src/services/providerIntegrationService");
const notifications = require("../src/services/operationalNotificationService");
const telemetry = require("../src/services/telemetryService");

const nodeService = {
  APPLICATION_HOST_NODE_ID: "app-host",
  getSelectedNodeId: () => NODE,
  listNodes: async () => ({ nodes: [{ id: NODE, kind: "agent", enabled: true, connection: { status: "online" } }] }),
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  // The scheduler as main.js starts it: immediate first tick, then the interval.
  const journal = notifications.createOperationalNotificationService({
    storePath: path.join(tempDir, "notifications.json"),
    collectState: notifications.createOperationalNotificationCollector({
      nodeService,
      endpointService: { listEndpoints: async () => [] },
      providerIntegrationService,
      connectivityDiagnosticsService: { getCachedDiagnostics: async () => ({ cached: false, state: "unknown", reason: "NOT_EVALUATED" }) },
    }),
  });
  const stopScheduler = journal.start({ intervalMs: 25 });

  // The telemetry sampler with its DEFAULT provider read (getProviderStates not injected).
  const sampler = telemetry.createTelemetryService({
    storePath: path.join(tempDir, "telemetry.json"),
    deps: {
      listNodes: nodeService.listNodes,
      getPreferences: () => ({ "telemetry.enabled": true }),
      getHostSummary: async () => null,
      listInstances: async () => ({ instances: [] }),
      getInstanceMetrics: async () => null,
      getEndpointHealth: async () => [],
    },
  });

  for (let i = 0; i < 4; i += 1) {
    await sampler.sampleOnce();
    await wait(30);
  }
  assert.strictEqual(agent.snapshotCalls, 0, `background scheduler ticks and telemetry samples made ${agent.snapshotCalls} Agent provider probe(s)`);
  const seriesBeforeRefresh = sampler.getTelemetryState().seriesCount;

  // An explicit refresh (Network page -> providers:getStatus) does probe, once.
  const explicit = await providerIntegrationService.getProviderSnapshot({ nodeId: NODE, refresh: true });
  assert.strictEqual(agent.snapshotCalls, 1, "an explicit refresh reads the Agent");
  assert.strictEqual(agent.lastNodeId, NODE);
  assert.strictEqual(explicit.providers[0].state, "running");

  // Background loops keep running and now report that state without probing.
  await wait(80);
  for (let i = 0; i < 2; i += 1) await sampler.sampleOnce();
  stopScheduler();
  assert.strictEqual(agent.snapshotCalls, 1, "background loops reuse the last-known state instead of probing again");
  const cached = await providerIntegrationService.getCachedProviderSnapshot({ nodeId: NODE });
  assert.strictEqual(cached.providers[0].state, "running", "the last-known state is available to background readers");
  const seriesAfterRefresh = sampler.getTelemetryState().seriesCount;
  assert.ok(seriesAfterRefresh > seriesBeforeRefresh, `telemetry samples provider state from the cache once it is known (series ${seriesBeforeRefresh} -> ${seriesAfterRefresh})`);

  Module._load = originalLoad;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log("provider background-probe smoke passed (0 background Agent provider probes)");
  process.exitCode = 0;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
