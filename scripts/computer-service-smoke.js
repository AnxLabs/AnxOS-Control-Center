const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-computer-service-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");

const { createComputerService } = require("../src/services/computerService");
const telemetryStore = require("../src/shared/telemetryStore");

const FIXED_NOW = Date.now();
const RECENT = new Date(FIXED_NOW - 5000).toISOString();
const STALE = new Date(FIXED_NOW - 10 * 60 * 1000).toISOString();

const NOT_EVALUATED = { cached: false, stale: true, state: "unknown", reason: "NOT_EVALUATED" };
const CACHED_DIAGNOSTICS = {
  "agent-1|svc-1": {
    cached: true,
    cachedAt: RECENT,
    id: "dx-svc-1",
    target: { nodeId: "agent-1", serviceId: "svc-1" },
    overall: { state: "healthy" },
    stages: [],
    reachability: {
      process: "healthy",
      local: "healthy",
      lan: "healthy",
      private_overlay: "not_configured",
      public: "not_configured",
    },
  },
};

function hostNode() {
  return {
    id: "application-host",
    kind: "application-host",
    displayName: "Windows Desktop",
    applicationHost: {
      operatingSystem: "Windows_NT 10.0.26100",
      architecture: "x64",
      systemUptimeSeconds: 7200,
      memory: { total: 16000000000, used: 8000000000 },
    },
    connection: { lastSeen: RECENT, status: "online" },
  };
}

function fullAgentNode() {
  return {
    id: "agent-1",
    kind: "agent",
    enabled: true,
    displayName: "Studio PC",
    hostname: "studio",
    lastConnectionState: "online",
    lastSuccessfulHealthCheck: RECENT,
    connection: {
      connected: true,
      status: "online",
      reachable: true,
      lastSeen: RECENT,
      agentVersion: "1.4.2",
      operatingSystem: "Windows 11 Pro",
      architecture: "x64",
    },
    agentVersion: "1.4.2",
    platform: "win32",
    agentIdentity: { deviceId: "dev-1", operatingSystem: "Windows 11 Pro", architecture: "x64" },
    profile: {
      cpu: { usagePercent: 12.5, cores: 8 },
      ram: { usagePercent: 43.2, totalBytes: 34359738368 },
      storage: { percent: 61 },
      agentUptimeSeconds: 3600,
      localIpAddresses: ["192.168.1.20", "192.168.1.31"],
    },
    addresses: [{ type: "lan", address: "192.168.1.20", source: "node" }],
  };
}

function offlineNode() {
  return {
    id: "agent-off",
    kind: "agent",
    enabled: true,
    displayName: "Garage PC",
    lastConnectionState: "offline",
    lastSuccessfulHealthCheck: STALE,
    connection: { connected: false, status: "offline", reachable: false, lastSeen: STALE },
  };
}

function disabledNode() {
  return {
    id: "agent-disabled",
    kind: "agent",
    enabled: false,
    displayName: "Retired PC",
    lastConnectionState: "unknown",
    connection: { status: "unknown" },
  };
}

function endpointFixtures() {
  return [
    {
      id: "ep-lan",
      name: "Web",
      type: "lan",
      host: "192.168.1.20",
      port: 8080,
      protocol: "tcp",
      enabled: true,
      source: "discovered",
      computerId: "agent-1",
      serviceId: "svc-1",
      metadata: { scope: "lan" },
      health: { state: "healthy" },
    },
    {
      id: "ep-tail",
      name: "Overlay",
      type: "tailscale",
      host: "100.90.0.5",
      port: 9000,
      protocol: "tcp",
      enabled: true,
      source: "discovered",
      computerId: "agent-1",
      serviceId: "svc-2",
      metadata: { token: "x" },
      health: { state: "healthy" },
    },
    {
      id: "ep-loop",
      name: "Local",
      type: "private",
      host: "127.0.0.1",
      port: 8080,
      protocol: "tcp",
      enabled: true,
      source: "manual",
      computerId: "agent-1",
      serviceId: "svc-1",
      metadata: {},
      health: null,
    },
  ];
}

function telemetryFixture(nodeId) {
  return {
    generatedAt: RECENT,
    nodeId,
    series: [
      { key: telemetryStore.hostSeriesKey(nodeId, "cpuPercent"), kind: "node", nodeId, summary: { latestValue: 12.5, latestAt: RECENT, missingCount: 0 } },
      { key: telemetryStore.hostSeriesKey(nodeId, "memoryPercent"), kind: "node", nodeId, summary: { latestValue: 43.2, latestAt: RECENT, missingCount: 0 } },
      { key: telemetryStore.hostSeriesKey(nodeId, "diskPercent"), kind: "node", nodeId, summary: { latestValue: 61, latestAt: RECENT, missingCount: 0 } },
      { key: telemetryStore.instanceSeriesKey(nodeId, "svc-1", "cpuPercent"), kind: "instance", nodeId, summary: { latestValue: 5, latestAt: RECENT, missingCount: 2 } },
    ],
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createFakeDeps(options = {}) {
  const counters = options.counters || null;
  const nodes = {
    "application-host": hostNode(),
    "agent-1": fullAgentNode(),
    "agent-off": offlineNode(),
    "agent-disabled": disabledNode(),
  };
  const instancesByNode = {
    "agent-1": [
      { id: "svc-1", displayName: "Minecraft", state: "Running", healthState: "healthy" },
      { id: "svc-2", displayName: "Voice", state: "Stopped" },
    ],
  };
  const endpointsByNode = { "agent-1": endpointFixtures() };
  const telemetryByNode = { "agent-1": telemetryFixture("agent-1") };
  const deps = {
    listNodes: async () => ({ nodes: [hostNode(), fullAgentNode(), offlineNode(), disabledNode()] }),
    getNode: async (nodeId) => {
      if (counters) {
        counters.active += 1;
        counters.max = Math.max(counters.max, counters.active);
        await sleep(counters.delayMs || 10);
        counters.active -= 1;
      }
      const node = nodes[nodeId];
      if (!node) throw Object.assign(new Error("Node not found."), { code: "NODE_NOT_FOUND" });
      return node;
    },
    listEndpoints: async ({ nodeId } = {}) => (endpointsByNode[nodeId] || []).slice(),
    getEndpointSummary: async ({ nodeId } = {}) => ({ total: (endpointsByNode[nodeId] || []).length, degraded: false }),
    getProviderSyncs: async () => ({
      "agent-1": { providerId: "playit", lastSyncAt: RECENT, state: "running", tunnelCount: 2, errorCode: null },
    }),
    getCachedProviderSnapshot: async ({ nodeId } = {}) => ({ nodeId, providers: [], syncs: null }),
    // Tripwire: the summary must never use the probing provider read.
    getProviderSnapshot: async () => { throw new Error("computer summary must not probe the provider"); },
    getTelemetrySummary: async ({ nodeId } = {}) => telemetryByNode[nodeId] || { generatedAt: RECENT, nodeId, series: [] },
    getCachedDiagnostics: ({ nodeId, serviceId } = {}) => CACHED_DIAGNOSTICS[`${nodeId}|${serviceId}`] || NOT_EVALUATED,
    listInstances: async ({ nodeId } = {}) => ({ instances: instancesByNode[nodeId] || [] }),
  };
  return { ...deps, ...(options.overrides || {}) };
}

async function main() {
  try {
    const service = createComputerService({ deps: createFakeDeps() });

    // --- Full agent: telemetry + endpoints + services + cached diagnostics --
    const full = await service.getComputerSummary({ nodeId: "agent-1" });
    assert.strictEqual(full.id, "agent-1");
    assert.strictEqual(full.name, "Studio PC");
    assert.strictEqual(full.kind, "agent");
    assert.strictEqual(full.os, "Windows 11 Pro");
    assert.strictEqual(full.architecture, "x64");
    assert.strictEqual(full.agentVersion, "1.4.2");
    assert.strictEqual(full.agentState, "online");
    assert.strictEqual(full.online, true);
    assert.strictEqual(full.lastContact, RECENT);
    assert.strictEqual(full.lastContactStale, false);
    assert.strictEqual(full.uptimeSeconds, 3600);
    assert(
      Math.abs(Date.parse(full.uptimeAt) - (FIXED_NOW - 3600 * 1000)) < 60000,
      "uptimeAt should be derived from the fixed now minus the reported uptime",
    );
    assert.deepStrictEqual(full.cpu, { usagePercent: 12.5 });
    assert.deepStrictEqual(full.memory, { percent: 43.2 });
    assert.deepStrictEqual(full.disk, { percent: 61 });
    assert.strictEqual(full.endpoints.length, 3);
    assert.strictEqual(full.endpoints[0].id, "ep-lan");
    assert.strictEqual(full.overlay.available, true);
    assert.strictEqual(full.overlay.state, "healthy");
    assert.strictEqual(full.overlay.address, "100.90.0.5");
    assert.strictEqual(full.services.length, 2);
    assert.deepStrictEqual(full.services[0], { id: "svc-1", name: "Minecraft", state: "Running", reachability: "healthy" });
    assert.strictEqual(full.services[1].reachability, "unknown", "a service without cached diagnostics reports unknown reachability");
    assert.deepStrictEqual(full.connectivity, {
      local: "healthy",
      lan: "healthy",
      private_overlay: "not_configured",
      public: "not_configured",
    });
    assert.deepStrictEqual(full.telemetry.latest, { cpuPercent: 12.5, memoryPercent: 43.2, diskPercent: 61, at: RECENT });
    assert.strictEqual(full.telemetry.seriesCount, 4);
    assert.strictEqual(full.telemetry.missingCount, 2);
    assert.deepStrictEqual(full.providerSync, {
      providerId: "playit",
      lastSyncAt: RECENT,
      state: "running",
      tunnelCount: 2,
      errorCode: null,
    });
    assert.strictEqual(full.degraded, false);
    assert.deepStrictEqual(full.degradedReasons, []);

    // --- Addresses: deduped, typed, and free of secret-shaped metadata ------
    const addressStrings = full.addresses.map((entry) => entry.address);
    assert.strictEqual(new Set(addressStrings).size, addressStrings.length, "addresses must be deduped by address");
    assert.strictEqual(addressStrings.filter((address) => address === "192.168.1.20").length, 1);
    assert.strictEqual(full.addresses.find((entry) => entry.address === "192.168.1.20").source, "endpoint");
    assert.strictEqual(full.addresses.find((entry) => entry.address === "192.168.1.31").source, "node");
    assert.strictEqual(full.addresses.find((entry) => entry.address === "127.0.0.1").type, "private");
    assert.strictEqual(addressStrings.length, 4);
    const wire = JSON.stringify(full);
    assert(!wire.includes("token"), "summaries must not leak token-keyed endpoint metadata");
    assert(!wire.includes("agentToken"), "summaries must not leak node credentials");

    // --- Offline node: normal state, stale contact, last known time ---------
    const offline = await service.getComputerSummary({ nodeId: "agent-off" });
    assert.strictEqual(offline.online, false);
    assert.strictEqual(offline.agentState, "offline");
    assert.strictEqual(offline.lastContactStale, true);
    assert.strictEqual(offline.lastKnownAt, STALE);
    assert.strictEqual(offline.degraded, false, "offline is a normal state, not a degradation");
    assert.deepStrictEqual(offline.degradedReasons, []);
    assert.notStrictEqual(offline.telemetry, null);
    assert.strictEqual(offline.telemetry.latest, null);
    assert.notStrictEqual(offline.telemetry.latest, 0);
    assert.strictEqual(offline.telemetry.seriesCount, 0);
    assert.strictEqual(offline.cpu, null);
    assert.strictEqual(offline.memory, null);
    assert.strictEqual(offline.disk, null);
    assert.deepStrictEqual(offline.services, []);
    assert.deepStrictEqual(offline.endpoints, []);
    assert.strictEqual(offline.connectivity.local, "unknown");
    assert.strictEqual(offline.connectivity.lan, "not_configured");

    // --- Telemetry missing: latest null, never zero -------------------------
    const noTelemetry = createComputerService({
      deps: createFakeDeps({
        overrides: { getTelemetrySummary: async ({ nodeId } = {}) => ({ generatedAt: RECENT, nodeId, series: [] }) },
      }),
    });
    const withoutTelemetry = await noTelemetry.getComputerSummary({ nodeId: "agent-1" });
    assert.notStrictEqual(withoutTelemetry.telemetry, null);
    assert.strictEqual(withoutTelemetry.telemetry.latest, null);
    assert.strictEqual(withoutTelemetry.telemetry.seriesCount, 0);
    assert.strictEqual(withoutTelemetry.telemetry.missingCount, 0);
    assert.strictEqual(withoutTelemetry.degraded, false, "an empty telemetry store is missing data, not a failure");

    // --- One dependency throwing: its flag is reported, other fields intact -
    const throwing = createComputerService({
      deps: createFakeDeps({
        overrides: { getTelemetrySummary: async () => { throw new Error("telemetry store unavailable"); } },
      }),
    });
    const degraded = await throwing.getComputerSummary({ nodeId: "agent-1" });
    assert.strictEqual(degraded.degraded, true);
    assert(degraded.degradedReasons.includes("telemetry-unavailable"), "the failing dependency must be named in degradedReasons");
    assert.strictEqual(degraded.telemetry, null);
    assert.strictEqual(degraded.name, "Studio PC");
    assert.strictEqual(degraded.endpoints.length, 3);
    assert.strictEqual(degraded.services.length, 2);
    assert.strictEqual(degraded.connectivity.lan, "healthy");

    // --- Unknown node: never throws -----------------------------------------
    const missing = await service.getComputerSummary({ nodeId: "agent-missing" });
    assert.strictEqual(missing.id, "agent-missing");
    assert.strictEqual(missing.kind, null);
    assert.strictEqual(missing.online, null);
    assert(missing.degradedReasons.includes("nodes-unavailable"));
    assert.strictEqual(missing.lastContactStale, true);

    // --- listComputerSummaries: host always present, disabled excluded ------
    const listed = await service.listComputerSummaries();
    assert.deepStrictEqual(listed.computers.map((entry) => entry.id), ["application-host", "agent-1", "agent-off"]);
    assert.strictEqual(listed.degraded, false);
    assert(typeof listed.generatedAt === "string" && listed.generatedAt !== "");
    const host = listed.computers[0];
    assert.strictEqual(host.kind, "application-host");
    assert.strictEqual(host.online, true);
    assert.strictEqual(host.lastContactStale, false);
    assert.strictEqual(host.uptimeSeconds, 7200);
    assert.deepStrictEqual(host.memory, { percent: 50 });
    assert.strictEqual(host.cpu, null);
    assert.strictEqual(host.disk, null);

    const withDisabled = await service.listComputerSummaries({ includeDisabled: true });
    assert.deepStrictEqual(
      withDisabled.computers.map((entry) => entry.id),
      ["application-host", "agent-1", "agent-off", "agent-disabled"],
    );

    const registryDown = createComputerService({
      deps: createFakeDeps({
        overrides: { listNodes: async () => { throw new Error("node registry unavailable"); } },
      }),
    });
    const degradedList = await registryDown.listComputerSummaries();
    assert.deepStrictEqual(degradedList.computers.map((entry) => entry.id), ["application-host"], "the application host must survive a failed node listing");
    assert.strictEqual(degradedList.degraded, true);

    // --- Bounded fan-out: at most two nodes in flight -----------------------
    const counters = { active: 0, max: 0, delayMs: 5 };
    const boundedService = createComputerService({ deps: createFakeDeps({ counters }) });
    await boundedService.listComputerSummaries({ includeDisabled: true });
    assert(counters.max <= 2, `listComputerSummaries must bound node fan-out to 2 (observed ${counters.max})`);
    assert.strictEqual(counters.max, 2, "the bound must still allow two concurrent reads");

    // --- PR #9 review L1: the sync fallback reads the cache only ----------
    {
      let probes = 0;
      const cachedReads = [];
      const fallback = createComputerService({ deps: createFakeDeps({ overrides: {
        getProviderSyncs: async () => { throw new Error("endpoints.json unreadable"); },
        getProviderSnapshot: async () => { probes += 1; throw new Error("must not probe"); },
        getCachedProviderSnapshot: async ({ nodeId } = {}) => {
          cachedReads.push(nodeId);
          return { nodeId, providers: [], syncs: { providerId: "playit", lastSyncAt: RECENT, state: "running", tunnelCount: 1, errorCode: null } };
        },
      } }) });
      const summary = await fallback.getComputerSummary({ nodeId: "agent-1" });
      assert.strictEqual(probes, 0, "the fallback never probes the Agent");
      assert.deepStrictEqual(cachedReads, ["agent-1"], "the fallback reads the cached snapshot");
      assert.strictEqual(summary.providerSync.tunnelCount, 1, "the cached sync record is used");
    }

    console.log("Computer service smoke checks passed.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
