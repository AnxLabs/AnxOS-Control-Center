"use strict";

// Smoke for src/services/connectivityDiagnosticsService.js.
//
// Every scenario injects fake dependencies and a fixed clock, so the pipeline
// is exercised end to end without a running Agent, endpoints store, or network:
//   (a) full healthy chain                  (h) UDP is unsupported, public path decides
//   (b) provider not-installed failure      (i) provider healthy + public probe refused
//   (c) port refused                        (j) caching, refresh, in-flight dedupe
//   (d) inventory says port not listening   (k) thrown dependency -> unknown
//   (e) probe hangs past its budget         (l) invalidateDiagnostics
//   (f) agent offline                       (m) unknown endpointId -> ENOTFOUND
//   (g) nothing configured
// Plus the real bounded probeTcp implementation against loopback.

const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const diag = require(path.join(rootDir, "src", "shared", "connectivityDiagnostics.js"));
const serviceModule = require(path.join(rootDir, "src", "services", "connectivityDiagnosticsService.js"));

const NOW = "2026-09-27T12:30:00.000Z";
const SERVICE_ID = "svc-anxrp";

const DEFAULT_INSTANCE = {
  id: SERVICE_ID,
  displayName: "AnxRP",
  state: "running",
  pid: 4242,
  uptimeSeconds: 600,
  processRunning: true,
  healthState: "healthy",
};

const APPLICATION_HOST_AGENT = {
  kind: "application-host",
  state: "online",
  lastContact: null,
  agentVersion: null,
  stale: false,
};

const ONLINE_AGENT = {
  kind: "agent",
  state: "online",
  lastContact: NOW,
  agentVersion: "1.4.0",
  stale: false,
};

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeEndpoint(id, type, name, host, port, extra = {}) {
  return { id, type, name, host, port, protocol: "tcp", enabled: true, providerId: null, serviceId: SERVICE_ID, ...extra };
}

function makeInventory(overrides = {}) {
  const listening = overrides.listening !== false;
  return {
    supported: overrides.supported !== false,
    listenerSource: overrides.listenerSource || "netstat-fixture",
    listeners: [],
    interfaces: [],
    errors: [],
    checkPort: {
      port: 30120,
      protocol: "tcp",
      listening,
      wildcardBound: listening,
      boundAddresses: listening ? ["0.0.0.0"] : [],
      listenerSource: overrides.listenerSource || "netstat-fixture",
    },
  };
}

function createHarness(options = {}) {
  const instance = options.instance === undefined ? DEFAULT_INSTANCE : options.instance;
  const computer = options.computer === undefined ? { id: "node-1", name: "AJ-DESKTOP" } : options.computer;
  const endpoints = options.endpoints || [];
  const agentState = options.agentState || APPLICATION_HOST_AGENT;
  const providerState = options.providerState === undefined ? null : options.providerState;
  const inventory = options.inventory || makeInventory();
  const probe = options.probe || (async () => ({ ok: true, result: "connected", latencyMs: 3 }));
  const calls = { context: 0, agent: 0, endpoints: 0, provider: 0, inventory: 0, probe: 0 };
  const probeCalls = [];

  const deps = {
    getServiceContext: async () => {
      calls.context += 1;
      if (options.contextError) throw options.contextError;
      return { instance, computer };
    },
    getAgentState: async () => {
      calls.agent += 1;
      return agentState;
    },
    getEndpoints: async () => {
      calls.endpoints += 1;
      if (options.endpointsError) throw options.endpointsError;
      return endpoints.map((endpoint) => ({ ...endpoint }));
    },
    getProviderState: async () => {
      calls.provider += 1;
      if (options.providerError) throw options.providerError;
      return providerState;
    },
    getNetworkInventory: async (request) => {
      calls.inventory += 1;
      if (options.inventoryError) throw options.inventoryError;
      return typeof inventory === "function" ? inventory(request) : inventory;
    },
    probeTcp: async (request) => {
      calls.probe += 1;
      probeCalls.push(request);
      return probe(request, probeCalls.length);
    },
  };

  const service = serviceModule.createConnectivityDiagnosticsService({
    deps,
    now: () => NOW,
    cacheTtlMs: options.cacheTtlMs === undefined ? 30000 : options.cacheTtlMs,
    probeTimeoutMs: options.probeTimeoutMs === undefined ? 2500 : options.probeTimeoutMs,
  });

  return { service, calls, probeCalls, deps };
}

function stageOf(result, id) {
  return result.stages.find((stage) => stage.id === id);
}

function assertValid(result, label) {
  const verdict = diag.validateDiagnosticsResult(result);
  assert.ok(verdict.ok, `${label}: result must validate: ${verdict.errors.join("; ")}`);
}

async function main() {
  // --- Public surface -------------------------------------------------------
  assert.equal(typeof serviceModule.createConnectivityDiagnosticsService, "function");
  assert.equal(typeof serviceModule.probeTcp, "function");
  assert.equal(typeof serviceModule.runDiagnostics, "function");
  assert.equal(typeof serviceModule.getCachedDiagnostics, "function");
  assert.equal(typeof serviceModule.invalidateDiagnostics, "function");
  assert.equal(typeof serviceModule.getDiagnosticsStatus, "function");

  // --- (a) full healthy chain ----------------------------------------------
  {
    const h = createHarness({
      endpoints: [
        makeEndpoint("ep-lan", "lan", "LAN", "192.168.1.50", 30120),
        makeEndpoint("ep-public", "public", "Public", "anxrp.example.net", 30120),
      ],
    });
    const result = await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assertValid(result, "(a)");
    assert.equal(result.overall.state, "healthy");
    assert.equal(result.cached, false);
    assert.equal(result.checkedAt, NOW);
    assert.equal(result.durationMs, 0);
    assert.equal(result.target.nodeId, "node-1");
    assert.equal(result.target.computerName, "AJ-DESKTOP");
    assert.equal(result.target.serviceName, "AnxRP");
    assert.equal(result.target.endpointId, "ep-lan");
    assert.equal(stageOf(result, "service-process").state, "healthy");
    assert.equal(stageOf(result, "local-socket").state, "healthy");
    assert.equal(stageOf(result, "host-network").state, "healthy");
    assert.equal(stageOf(result, "agent").state, "not_configured");
    assert.equal(stageOf(result, "provider").state, "not_configured");
    assert.equal(stageOf(result, "public-endpoint").state, "healthy");
    assert.equal(result.reachability.process, "healthy");
    assert.equal(result.reachability.local, "healthy");
    assert.equal(result.reachability.lan, "healthy");
    assert.equal(result.reachability.private_overlay, "not_configured");
    assert.equal(result.reachability.public, "healthy");
    assert.ok(result.graph && Array.isArray(result.graph.nodes) && result.graph.nodes.length > 0, "(a) graph is built");
    assert.equal(result.graph.generatedAt, NOW);
    assert.equal(h.calls.probe, 2, "(a) local-socket and public-endpoint each probe once");
  }

  // --- (b) AnxRP failure chain: provider not-installed ----------------------
  {
    const h = createHarness({
      computer: { id: "agent-node-1", name: "BUILD-BOX" },
      agentState: ONLINE_AGENT,
      endpoints: [makeEndpoint("ep-public", "public", "Playit", "anxrp.playit.gg", 30120, { providerId: "playit" })],
      providerState: { providerId: "playit", state: "not-installed", connected: false },
    });
    const result = await h.service.runDiagnostics({ nodeId: "agent-node-1", serviceId: SERVICE_ID });
    assertValid(result, "(b)");
    assert.equal(stageOf(result, "provider").state, "failed");
    assert.equal(stageOf(result, "public-endpoint").state, "failed");
    assert.equal(stageOf(result, "public-endpoint").evidence.note, "provider path failed");
    assert.equal(stageOf(result, "agent").state, "healthy");
    assert.equal(result.overall.state, "failed");
    assert.ok(result.overall.headline.includes("Tunnel Provider"), "(b) headline names the broken stage");
    assert.deepEqual(stageOf(result, "provider").remediation, [
      { id: "open-provider", label: "Open provider", kind: "open-provider" },
    ]);
  }

  // --- (c) process running, port refused ------------------------------------
  {
    const h = createHarness({
      endpoints: [makeEndpoint("ep-lan", "lan", "LAN", "192.168.1.50", 30120)],
      probe: async () => ({ ok: false, result: "refused", code: "ECONNREFUSED" }),
    });
    const result = await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assertValid(result, "(c)");
    assert.equal(stageOf(result, "local-socket").state, "failed");
    assert.equal(stageOf(result, "local-socket").evidence.result, "refused");
    assert.equal(result.overall.state, "failed");
    assert.ok(result.overall.headline.includes("Local Port"), "(c) headline names Local Port");
    assert.deepEqual(stageOf(result, "local-socket").remediation, [
      { id: "open-network", label: "Open Network", kind: "open-network" },
    ]);
  }

  // --- (d) inventory says the port is not listening -------------------------
  {
    const h = createHarness({
      endpoints: [makeEndpoint("ep-lan", "lan", "LAN", "192.168.1.50", 30120)],
      inventory: makeInventory({ listening: false }),
    });
    const result = await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assertValid(result, "(d)");
    assert.equal(stageOf(result, "local-socket").state, "healthy");
    assert.equal(stageOf(result, "host-network").state, "failed");
    assert.equal(stageOf(result, "host-network").evidence.listenerSource, "netstat-fixture");
    assert.equal(result.overall.state, "failed");
  }

  // --- (e) probe hangs past its budget -> unknown, no rejection -------------
  {
    const h = createHarness({
      probeTimeoutMs: 30,
      endpoints: [makeEndpoint("ep-lan", "lan", "LAN", "192.168.1.50", 30120)],
      probe: async () => {
        await delay(100);
        return { ok: true, result: "connected", latencyMs: 100 };
      },
    });
    const result = await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assertValid(result, "(e)");
    assert.equal(stageOf(result, "local-socket").state, "unknown", "(e) slow probe must become unknown");
    assert.ok(
      stageOf(result, "local-socket").evidence.error === "TIMEOUT" || stageOf(result, "local-socket").evidence.result === "timeout",
      "(e) evidence records the timeout",
    );
    assert.equal(result.overall.state, "unknown", "(e) unknown taints the overall path");
  }

  // --- (f) agent offline ----------------------------------------------------
  {
    const h = createHarness({
      computer: { id: "agent-node-1", name: "BUILD-BOX" },
      agentState: { kind: "agent", state: "offline", lastContact: null, agentVersion: "1.4.0", stale: false },
      endpoints: [makeEndpoint("ep-lan", "lan", "LAN", "192.168.1.50", 30120)],
    });
    const result = await h.service.runDiagnostics({ nodeId: "agent-node-1", serviceId: SERVICE_ID });
    assertValid(result, "(f)");
    assert.equal(stageOf(result, "agent").state, "failed");
    assert.equal(stageOf(result, "agent").evidence.agentState, "offline");
    assert.equal(result.overall.state, "failed");
  }

  // --- (g) nothing configured -----------------------------------------------
  {
    const h = createHarness({ instance: null, endpoints: [] });
    const result = await h.service.runDiagnostics({ nodeId: "node-1" });
    assertValid(result, "(g)");
    for (const stage of result.stages) {
      assert.equal(stage.state, "not_configured", `(g) ${stage.id} must be not_configured`);
    }
    assert.equal(result.overall.state, "not_configured");
    assert.equal(result.overall.headline, "Not configured");
    assert.equal(result.reachability.local, "not_configured");
    assert.equal(result.reachability.public, "not_configured");
  }

  // --- (h) UDP endpoint: unsupported local-socket, public path decides -------
  {
    const h = createHarness({
      probeTimeoutMs: 111,
      endpoints: [
        makeEndpoint("ep-udp", "private", "Game (UDP)", "10.0.0.5", 25565, { protocol: "udp" }),
        makeEndpoint("ep-public", "public", "Public", "game.example.net", 30120),
      ],
      probe: async ({ timeoutMs }) => (timeoutMs === 2500 ? { ok: false, result: "refused", code: "ECONNREFUSED" } : { ok: true, result: "connected", latencyMs: 2 }),
    });
    const result = await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assertValid(result, "(h)");
    assert.equal(stageOf(result, "local-socket").state, "unsupported");
    assert.equal(stageOf(result, "local-socket").detail, "UDP reachability cannot be probed");
    assert.equal(stageOf(result, "public-endpoint").state, "unknown");
    assert.equal(result.overall.state, stageOf(result, "public-endpoint").state, "(h) overall follows the public path");
    assert.equal(result.overall.state, "unknown");
  }

  // --- (i) provider healthy + public probe refused -> public unknown ---------
  {
    const h = createHarness({
      probeTimeoutMs: 111,
      computer: { id: "agent-node-1", name: "BUILD-BOX" },
      agentState: ONLINE_AGENT,
      endpoints: [makeEndpoint("ep-public", "public", "Playit", "anxrp.playit.gg", 30120, { providerId: "playit" })],
      providerState: {
        providerId: "playit",
        state: "running",
        connected: true,
        tunnelId: "tnl-77",
        publicAddress: "anxrp.playit.gg:30120",
        region: "yyc",
      },
      probe: async ({ timeoutMs }) => (timeoutMs === 2500 ? { ok: false, result: "refused", code: "ECONNREFUSED" } : { ok: true, result: "connected", latencyMs: 2 }),
    });
    const result = await h.service.runDiagnostics({ nodeId: "agent-node-1", serviceId: SERVICE_ID });
    assertValid(result, "(i)");
    const providerStage = stageOf(result, "provider");
    assert.equal(providerStage.state, "healthy");
    assert.equal(providerStage.evidence.providerState, "running");
    assert.equal(providerStage.evidence.tunnelId, "tnl-77");
    assert.equal(providerStage.evidence.publicAddress, "anxrp.playit.gg:30120");
    assert.equal(providerStage.evidence.region, "yyc");
    assert.equal(stageOf(result, "local-socket").state, "healthy");
    const publicStage = stageOf(result, "public-endpoint");
    assert.equal(publicStage.state, "unknown");
    assert.equal(publicStage.evidence.vantage, "control-plane");
    assert.ok(publicStage.evidence.note.includes("NAT hairpin"), "(i) unknown carries the vantage caveat");
    assert.equal(result.overall.state, "unknown");
  }

  // --- (j) caching, refresh, in-flight dedupe -------------------------------
  {
    const h = createHarness({ endpoints: [makeEndpoint("ep-lan", "lan", "LAN", "192.168.1.50", 30120)] });
    const first = await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assert.equal(first.cached, false);
    const second = await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assert.equal(second.cached, true, "(j) second call is a cache hit");
    assert.equal(second.cachedAt, NOW);
    assert.equal(second.id, first.id, "(j) cache hit returns the recorded result");
    assert.equal(h.calls.probe, 1, "(j) cached call must not re-probe");
    assert.equal(h.calls.context, 1, "(j) cached call must not re-resolve deps");

    const cachedView = h.service.getCachedDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assert.equal(cachedView.cached, true);

    const refreshed = await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, refresh: true });
    assert.equal(refreshed.cached, false, "(j) refresh bypasses the cache");
    assert.equal(h.calls.probe, 2, "(j) refresh re-probes");

    const slowProbe = createHarness({
      endpoints: [makeEndpoint("ep-lan", "lan", "LAN", "192.168.1.50", 30120)],
      probe: async () => {
        await delay(60);
        return { ok: true, result: "connected", latencyMs: 60 };
      },
    });
    const [p1, p2] = await Promise.all([
      slowProbe.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID }),
      slowProbe.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID }),
    ]);
    assert.strictEqual(p1, p2, "(j) parallel identical calls share one in-flight run");
    assert.equal(slowProbe.calls.probe, 1, "(j) in-flight dedupe probes once");
    const status = slowProbe.service.getDiagnosticsStatus();
    assert.equal(status.inFlight, 0);
    assert.equal(status.cachedTargets, 1);
    assert.equal(status.lastRunAt, NOW);
  }

  // --- (k) thrown dependency -> unknown stage, no throw ---------------------
  {
    const h = createHarness({
      endpoints: [makeEndpoint("ep-lan", "lan", "LAN", "192.168.1.50", 30120)],
      inventoryError: Object.assign(new Error("inventory unreachable"), { code: "ENETUNREACH" }),
    });
    const result = await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assertValid(result, "(k)");
    assert.equal(stageOf(result, "host-network").state, "unknown");
    assert.equal(stageOf(result, "host-network").evidence.error, "ENETUNREACH");
    assert.equal(result.overall.state, "unknown");
  }

  // --- (l) invalidateDiagnostics --------------------------------------------
  {
    const h = createHarness({ endpoints: [makeEndpoint("ep-lan", "lan", "LAN", "192.168.1.50", 30120)] });
    await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assert.equal(h.calls.probe, 1);

    h.service.invalidateDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assert.deepEqual(h.service.getCachedDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID }), {
      cached: false,
      stale: true,
      state: "unknown",
      reason: "NOT_EVALUATED",
    });

    const rerun = await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assert.equal(rerun.cached, false, "(l) invalidated target runs fresh");
    assert.equal(h.calls.probe, 2);

    await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    h.service.invalidateDiagnostics();
    assert.equal(h.service.getDiagnosticsStatus().cachedTargets, 0, "(l) no-arg invalidate clears all targets");
  }

  // --- (m) unknown endpointId is the only caller error ----------------------
  {
    const h = createHarness({ endpoints: [makeEndpoint("ep-lan", "lan", "LAN", "192.168.1.50", 30120)] });
    await assert.rejects(
      () => h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, endpointId: "ep-missing" }),
      (error) => error && error.code === "ENOTFOUND",
      "(m) unknown endpointId throws a typed ENOTFOUND error",
    );
    assert.equal(h.calls.probe, 0, "(m) the caller error happens before any stage runs");
  }

  // --- real bounded probeTcp against loopback -------------------------------
  {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const connected = await serviceModule.probeTcp({ host: "127.0.0.1", port: address.port, timeoutMs: 2000 });
    assert.equal(connected.ok, true);
    assert.equal(connected.result, "connected");
    assert.ok(Number.isFinite(connected.latencyMs) && connected.latencyMs >= 0);
    await new Promise((resolve) => server.close(resolve));

    const refused = await serviceModule.probeTcp({ host: "127.0.0.1", port: address.port, timeoutMs: 2000 });
    assert.equal(refused.ok, false);
    assert.equal(refused.result, "refused");
    assert.equal(refused.code, "ECONNREFUSED");

    const invalid = await serviceModule.probeTcp({ host: "", port: 0 });
    assert.equal(invalid.ok, false);
    assert.equal(invalid.result, "error");
    assert.equal(invalid.code, "EINVALIDTARGET");
  }

  // --- PR #9 review P2: one cached evaluation per endpoint, however run ----
  {
    const endpoint = makeEndpoint("ep-canon", "lan", "Canonical", "192.168.1.20", 30120);
    const { service } = createHarness({ endpoints: [endpoint] });
    // endpoints:test runs without a service id
    const tested = await service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-canon", refresh: true });
    assert.equal(service.getCachedDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, endpointId: "ep-canon" }).cached, false,
      "an exact-key read with the endpoint's service id misses an endpoint test (the original defect)");
    const canonical = service.getCachedEndpointDiagnostics({ nodeId: "node-1", endpointId: "ep-canon" });
    assert.equal(canonical.cached, true, "the canonical lookup finds the endpoint test");
    assert.equal(canonical.overall.state, tested.overall.state);
    const [projected] = service.projectEndpointHealth([{ ...endpoint, computerId: "node-1" }]);
    assert.equal(projected.health.state, tested.overall.state, "the evaluation is projected onto the record");
    assert.equal(projected.health.status, tested.overall.state);
    assert.equal(projected.lastCheckedAt, canonical.cachedAt);
    const [viaFallback] = service.projectEndpointHealth([{ id: "ep-canon" }], { fallbackNodeId: "node-1" });
    assert.equal(viaFallback.health.state, tested.overall.state, "the list's node id is used when the record has none");
    const [never] = service.projectEndpointHealth([{ id: "ep-never", computerId: "node-1" }]);
    assert.equal(never.health, undefined, "an endpoint never evaluated gets no fabricated health");
    const [otherNode] = service.projectEndpointHealth([{ ...endpoint, computerId: "node-2" }]);
    assert.equal(otherNode.health, undefined, "evaluations are per node");
    assert.equal(service.getCachedEndpointDiagnostics({ nodeId: "node-1" }).cached, false, "no endpoint id: not evaluated");
  }

  console.log("connectivity-diagnostics-service-smoke: all assertions passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
