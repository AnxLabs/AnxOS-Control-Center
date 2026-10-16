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
    const endpoint = makeEndpoint("ep-canon", "lan", "Canonical", "192.168.1.20", 30120, { computerId: "node-1" });
    const legacy = makeEndpoint("ep-legacy", "lan", "Legacy", "192.168.1.21", 30120);
    const { service } = createHarness({ endpoints: [endpoint, legacy] });
    // endpoints:test runs without a service id
    const tested = await service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-canon", refresh: true });
    assert.equal(service.getCachedDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, endpointId: "ep-canon" }).cached, false,
      "an exact-key read with the endpoint's service id misses an endpoint test (the original defect)");
    const canonical = service.getCachedEndpointDiagnostics({ nodeId: "node-1", endpointId: "ep-canon" });
    assert.equal(canonical.cached, true, "the canonical lookup finds the endpoint test");
    assert.equal(canonical.overall.state, tested.overall.state);
    const [projected] = service.projectEndpointHealth([{ ...endpoint }]);
    assert.equal(projected.health.state, tested.overall.state, "the evaluation is projected onto the record");
    assert.equal(projected.health.status, tested.overall.state);
    assert.equal(projected.lastCheckedAt, canonical.cachedAt);
    const legacyTested = await service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-legacy", refresh: true });
    const [viaFallback] = service.projectEndpointHealth([{ ...legacy }], { fallbackNodeId: "node-1" });
    assert.equal(viaFallback.health.state, legacyTested.overall.state, "the list's node id is used when the record has none");
    const [never] = service.projectEndpointHealth([{ id: "ep-never", computerId: "node-1" }]);
    assert.equal(never.health, undefined, "an endpoint never evaluated gets no fabricated health");
    const [otherNode] = service.projectEndpointHealth([{ ...endpoint, computerId: "node-2" }]);
    assert.equal(otherNode.health, undefined, "evaluations are per node");
    assert.equal(service.getCachedEndpointDiagnostics({ nodeId: "node-1" }).cached, false, "no endpoint id: not evaluated");
  }

  // --- PR #9 second review P2-A: an edited endpoint never shows the health
  //     of the target it pointed at before the edit (within the cache TTL) ---
  {
    const original = makeEndpoint("ep-edit", "lan", "Edited", "192.168.1.30", 30120, { computerId: "node-1" });
    const bystander = makeEndpoint("ep-other", "lan", "Other", "192.168.1.31", 30120, { computerId: "node-1" });
    const endpoints = [{ ...original }, { ...bystander }];
    const { service, calls } = createHarness({ endpoints, cacheTtlMs: 30000 });
    const tested = await service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-edit", refresh: true });
    await service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, endpointId: "ep-edit", refresh: true });
    await service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-other", refresh: true });
    const runs = calls.endpoints;

    const [unchanged] = service.projectEndpointHealth([{ ...original }]);
    assert.equal(unchanged.health.state, tested.overall.state, "the tested target shows its result");
    const [renamed] = service.projectEndpointHealth([{ ...original, name: "Renamed", notes: "n" }]);
    assert.equal(renamed.health.state, tested.overall.state, "a rename does not change the target");

    const edits = {
      host: { host: "192.168.1.99" },
      port: { port: 30121 },
      protocol: { protocol: "udp" },
      node: { computerId: "node-2" },
      service: { serviceId: "svc-other" },
      type: { type: "public" },
    };
    for (const [field, change] of Object.entries(edits)) {
      const edited = { ...original, ...change };
      const [projectedEdit] = service.projectEndpointHealth([edited]);
      assert.equal(projectedEdit.health, undefined, `${field} edit: no health from the old target is projected`);
      assert.equal(projectedEdit.lastCheckedAt, undefined, `${field} edit: no stale lastCheckedAt`);
      const canonical = service.getCachedEndpointDiagnostics({ nodeId: "node-1", endpointId: "ep-edit", endpoint: edited });
      assert.equal(canonical.cached, false, `${field} edit: the canonical lookup refuses the old target`);
      assert.equal(canonical.reason, "NOT_EVALUATED", `${field} edit: reads as missing (not evaluated), not as unknown health`);
      const exact = service.getCachedDiagnostics({ nodeId: "node-1", endpointId: "ep-edit", endpoint: edited });
      assert.equal(exact.cached, false, `${field} edit: the exact-key read refuses the old target`);
      assert.equal(exact.reason, "NOT_EVALUATED");
      // Re-checked after every edit: a refused read for one record never
      // removes the entry a still-matching record is entitled to (except the
      // exact-key read, which drops the mismatched entry it was asked about).
      const stillCanonical = service.getCachedEndpointDiagnostics({ nodeId: "node-1", endpointId: "ep-edit", endpoint: original });
      assert.equal(stillCanonical.cached, true, `${field} edit: the unedited record still reads its own result`);
    }
    assert.equal(calls.endpoints, runs, "cache reads never trigger a run");

    // Service-level reads (no record supplied) keep the existing behaviour.
    const serviceRead = service.getCachedDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, endpointId: "ep-edit" });
    assert.equal(serviceRead.cached, true, "a read without a record is not identity-checked");
    // Supplying the stale record to the exact-key read drops that entry.
    const refused = service.getCachedDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, endpointId: "ep-edit", endpoint: { ...original, host: "10.0.0.9" } });
    assert.equal(refused.cached, false);
    assert.equal(service.getCachedDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, endpointId: "ep-edit" }).cached, false,
      "the exact-key entry that described another target is dropped");

    // A run against the edited target is cached for the edited record.
    endpoints[0] = { ...original, host: "192.168.1.99" };
    const retested = await service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-edit", refresh: true });
    const [fresh] = service.projectEndpointHealth([{ ...endpoints[0] }]);
    assert.equal(fresh.health.state, retested.overall.state, "the edited target shows its own new result");
    const [old] = service.projectEndpointHealth([{ ...original }]);
    assert.equal(old.health, undefined, "and the old target's record no longer matches it");

    // Endpoint-scoped invalidation drops every segment for that endpoint only.
    await service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, endpointId: "ep-edit", refresh: true });
    const dropped = service.invalidateDiagnostics({ endpointId: "ep-edit" });
    assert.equal(dropped.invalidated, 2, "both the endpoint-test and service-scoped entries are dropped");
    assert.equal(service.getCachedEndpointDiagnostics({ nodeId: "node-1", endpointId: "ep-edit" }).cached, false);
    assert.equal(service.getCachedEndpointDiagnostics({ nodeId: "node-1", endpointId: "ep-other", endpoint: { ...bystander } }).cached, true,
      "other endpoints keep their results");
    assert.equal(service.invalidateDiagnostics({ endpointId: "ep-other", nodeId: "node-9" }).invalidated, 0, "a node filter narrows the drop");
    assert.equal(service.invalidateDiagnostics({ endpointId: "ep-other", nodeId: "node-1" }).invalidated, 1);
  }

  // --- PR #9 third review: an endpoint deleted while its run is in flight
  //     never shows that run's result; service-level reads are unchanged ---
  {
    const doomed = makeEndpoint("ep-doomed", "lan", "Doomed", "192.168.1.40", 30120, { computerId: "node-1" });
    const survivor = makeEndpoint("ep-survivor", "lan", "Survivor", "192.168.1.41", 30120, { computerId: "node-1" });
    const endpoints = [{ ...doomed }, { ...survivor }];
    let releaseProbe = null;
    let gateProbe = false;
    const probe = async () => {
      if (gateProbe) await new Promise((resolve) => { releaseProbe = resolve; });
      return { ok: true, result: "connected", latencyMs: 3 };
    };
    const { service } = createHarness({ endpoints, probe });
    // This service-level run selects ep-doomed (the first enabled endpoint).
    const serviceBeforeDelete = await service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, refresh: true });
    assert.ok(serviceBeforeDelete.overall);
    await service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-survivor", refresh: true });

    // Start a run, then delete the endpoint (store removal + invalidation)
    // before the run finishes and writes its result.
    gateProbe = true;
    const inFlight = service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-doomed", refresh: true });
    for (let i = 0; i < 50 && !releaseProbe; i += 1) await delay(5);
    assert.ok(releaseProbe, "the doomed endpoint's run reached its probe");
    endpoints.splice(0, 1);
    service.invalidateDiagnostics({ endpointId: "ep-doomed" });
    gateProbe = false;
    releaseProbe();
    await inFlight;

    // Repair loop round 2: the service-level result that tested ep-doomed was
    // dropped with it; a service-level run after the delete selects the
    // survivor and is cached as before.
    assert.equal(service.getCachedDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID }).cached, false,
      "a service-level result that tested the deleted endpoint is dropped");
    const serviceLevel = await service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, refresh: true });

    // Endpoint reads that name the endpoint and carry its (absent) record.
    const exact = service.getCachedDiagnostics({ nodeId: "node-1", endpointId: "ep-doomed", endpoint: null });
    assert.equal(exact.cached, false, "a deleted endpoint's late result is not served by the exact-key read");
    assert.equal(exact.reason, "NOT_EVALUATED", "it reads as missing, not as unknown health");
    const canonical = service.getCachedEndpointDiagnostics({ nodeId: "node-1", endpointId: "ep-doomed", endpoint: null });
    assert.equal(canonical.cached, false, "nor by the canonical endpoint lookup");
    assert.equal(canonical.reason, "NOT_EVALUATED");
    const listed = service.projectEndpointHealth(endpoints.map((entry) => ({ ...entry })));
    assert.deepStrictEqual(listed.map((entry) => entry.id), ["ep-survivor"]);
    assert.ok(listed[0].health, "the surviving endpoint keeps its own result");
    assert.equal(service.getCachedEndpointDiagnostics({ nodeId: "node-1", endpointId: "ep-survivor", endpoint: { ...survivor } }).cached, true);

    // Service-level reads name no endpoint: a record field (even null) has no effect.
    const serviceRead = service.getCachedDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, endpoint: null });
    assert.equal(serviceRead.cached, true, "a service-level read is unchanged by the endpoint rule");
    assert.equal(serviceRead.overall.state, serviceLevel.overall.state);
    assert.equal(service.getCachedDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID }).cached, true);

    // Defense in depth: an endpoint that disappears without an invalidation
    // (endpointService swallows an invalidation failure; a direct store
    // removal) leaves its cached result in place. A read that names it with a
    // null record still refuses that result.
    await service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-survivor", refresh: true });
    endpoints.splice(endpoints.findIndex((entry) => entry.id === "ep-survivor"), 1);
    assert.equal(service.getCachedDiagnostics({ nodeId: "node-1", endpointId: "ep-survivor" }).cached, true,
      "the entry is still cached (no invalidation ran)");
    const goneExact = service.getCachedDiagnostics({ nodeId: "node-1", endpointId: "ep-survivor", endpoint: null });
    assert.equal(goneExact.cached, false, "a vanished endpoint's cached result is refused by the exact-key read");
    assert.equal(goneExact.reason, "NOT_EVALUATED");
    const goneCanonical = service.getCachedEndpointDiagnostics({ nodeId: "node-1", endpointId: "ep-survivor", endpoint: null });
    assert.equal(goneCanonical.cached, false, "and by the canonical lookup");
    assert.equal(goneCanonical.reason, "NOT_EVALUATED");
  }

  // --- PR #9 fourth review: a run whose endpoint is edited or deleted while
  //     it is in flight is discarded for its caller and every joined caller;
  //     it is never cached or returned ---
  {
    const original = makeEndpoint("ep-mut", "lan", "Mutated", "192.168.1.50", 30120, { computerId: "node-1" });
    const other = makeEndpoint("ep-bystander", "lan", "Bystander", "192.168.1.51", 30120, { computerId: "node-1" });
    const endpoints = [{ ...original }, { ...other }];
    // Each probe of a gated host waits until the test releases it.
    const gates = [];
    let gatedHost = null;
    const probe = async (request) => {
      if (gatedHost && request.host === gatedHost) await new Promise((resolve) => gates.push(resolve));
      return { ok: true, result: "connected", latencyMs: 3 };
    };
    const { service, calls } = createHarness({ endpoints, probe });
    const waitForGate = async (count) => {
      for (let i = 0; i < 100 && gates.length < count; i += 1) await delay(5);
      assert.ok(gates.length >= count, "the run reached its probe");
    };
    const isDiscarded = (result, label) => {
      assert.equal(result.discarded, "ENDPOINT_CHANGED", `${label}: discarded`);
      assert.equal(result.reason, "NOT_EVALUATED", `${label}: reads as not evaluated (missing), not as unknown health`);
      assert.equal(result.cached, false, label);
      assert.equal(result.overall, undefined, `${label}: carries no target result`);
      assert.equal(result.stages, undefined, `${label}: carries no stages`);
    };
    const nothingCached = (label) => {
      // Not even a record-less read (no identity check) finds a result.
      assert.equal(service.getCachedDiagnostics({ nodeId: "node-1", endpointId: "ep-mut" }).cached, false, `${label}: nothing cached`);
      assert.equal(service.getCachedEndpointDiagnostics({ nodeId: "node-1", endpointId: "ep-mut" }).cached, false, `${label}: nothing cached (canonical)`);
    };

    // 1. Edit during a run: the direct caller and a joined caller are both
    //    discarded; a caller arriving after the edit starts a fresh run.
    gatedHost = original.host;
    const direct = service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-mut", refresh: true });
    await waitForGate(1);
    const joined = service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-mut", refresh: true });
    assert.equal(calls.probe, 1, "the second caller joined the in-flight run");
    endpoints[0] = { ...original, host: "192.168.1.150" };
    service.invalidateDiagnostics({ endpointId: "ep-mut" }); // what endpointService does on a target edit
    const fresh = await service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-mut", refresh: true });
    assert.equal(calls.probe, 2, "a caller after the edit does not join the stale run");
    assert.notEqual(fresh.discarded, "ENDPOINT_CHANGED", "the fresh run tested the current target");
    gates.splice(0).forEach((release) => release());
    isDiscarded(await direct, "edited, direct caller");
    isDiscarded(await joined, "edited, joined caller");
    const [shown] = service.projectEndpointHealth([{ ...endpoints[0] }]);
    assert.equal(shown.health.state, fresh.overall.state, "only the fresh run's result is cached, for the current target");
    assert.equal(service.getCachedEndpointDiagnostics({ nodeId: "node-1", endpointId: "ep-mut", endpoint: { ...original } }).cached, false,
      "the old target never gets a result");

    // 2. Delete during a run.
    service.invalidateDiagnostics({ endpointId: "ep-mut" });
    gatedHost = endpoints[0].host;
    const doomed = service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-mut", refresh: true });
    await waitForGate(1);
    endpoints.splice(0, 1);
    service.invalidateDiagnostics({ endpointId: "ep-mut" });
    gates.splice(0).forEach((release) => release());
    isDiscarded(await doomed, "deleted");
    nothingCached("deleted");
    endpoints.unshift({ ...original });

    // 3. A rename (no invalidation) during a run keeps its result.
    gatedHost = original.host;
    const renamedRun = service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-mut", refresh: true });
    await waitForGate(1);
    endpoints[0] = { ...original, name: "Renamed" };
    gates.splice(0).forEach((release) => release());
    const renamedResult = await renamedRun;
    assert.notEqual(renamedResult.discarded, "ENDPOINT_CHANGED", "a rename does not discard");
    assert.ok(renamedResult.overall, "a rename keeps the run's result");

    // 4. Runs that did not test the changed endpoint are unaffected: a
    //    service-level run (it selects ep-mut, the first enabled endpoint) and
    //    ep-bystander's own run, while an endpoint neither tested changes.
    gatedHost = other.host;
    const serviceRun = service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, refresh: true });
    const otherRun = service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-bystander", refresh: true });
    await waitForGate(1);
    service.invalidateDiagnostics({ endpointId: "ep-unrelated" });
    gatedHost = null;
    gates.splice(0).forEach((release) => release());
    const serviceResult = await serviceRun;
    const otherResult = await otherRun;
    assert.notEqual(serviceResult.discarded, "ENDPOINT_CHANGED", "a service-level run is not discarded by an unrelated endpoint change");
    assert.ok(serviceResult.overall);
    assert.equal(service.getCachedDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID }).cached, true, "and is cached as before");
    assert.notEqual(otherResult.discarded, "ENDPOINT_CHANGED", "another endpoint's run is unaffected");
    assert.equal(service.getCachedEndpointDiagnostics({ nodeId: "node-1", endpointId: "ep-bystander", endpoint: { ...other } }).cached, true);

    // 5. Repair loop round 2: a service-level run tracks the endpoint it
    //    selected. Editing that endpoint mid-run discards the run (and every
    //    joined caller), a later caller starts a fresh run, and a completed
    //    service-level result that tested it is dropped.
    gatedHost = original.host;
    const selectedRun = service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, refresh: true });
    await waitForGate(1);
    const joinedService = service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, refresh: true });
    const probesBeforeEdit = calls.probe;
    endpoints[0] = { ...original, host: "192.168.1.250" };
    service.invalidateDiagnostics({ endpointId: "ep-mut" });
    gatedHost = null;
    const freshService = await service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, refresh: true });
    assert.ok(calls.probe > probesBeforeEdit, "a service-level caller after the edit starts a fresh run");
    assert.notEqual(freshService.discarded, "ENDPOINT_CHANGED");
    gates.splice(0).forEach((release) => release());
    isDiscarded(await selectedRun, "service-level, selected endpoint edited");
    isDiscarded(await joinedService, "service-level, joined caller");
    const cachedService = service.getCachedDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assert.equal(cachedService.cached, true, "only the fresh service-level run is cached");
    assert.equal(cachedService.checkedAt, freshService.checkedAt);
    service.invalidateDiagnostics({ endpointId: "ep-mut" });
    assert.equal(service.getCachedDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID }).cached, false,
      "a completed service-level result that tested the edited endpoint is dropped");
    endpoints[0] = { ...original };

    // 6. The public endpoint a run reports on is tracked too.
    const publicEndpoint = makeEndpoint("ep-public", "public", "Public", "203.0.113.10", 30120, { computerId: "node-1" });
    endpoints.push({ ...publicEndpoint });
    gatedHost = publicEndpoint.host;
    const publicRun = service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, refresh: true });
    await waitForGate(1);
    endpoints[endpoints.length - 1] = { ...publicEndpoint, host: "203.0.113.99" };
    service.invalidateDiagnostics({ endpointId: "ep-public" });
    gatedHost = null;
    gates.splice(0).forEach((release) => release());
    isDiscarded(await publicRun, "service-level, public endpoint edited");
    endpoints.pop();
  }

  // --- PR #9 repair loop round 3: a change to endpoint selection on a node
  //     (an endpoint created, deleted, enabled, disabled or retargeted) drops
  //     and discards service-level results on that node, and every result on
  //     it when the public selection may have changed ---
  {
    const first = makeEndpoint("ep-first", "lan", "First", "192.168.1.70", 30120, { computerId: "node-1" });
    const second = makeEndpoint("ep-second", "lan", "Second", "192.168.1.71", 30120, { computerId: "node-1" });
    const endpoints = [{ ...first }, { ...second }];
    const gates = [];
    let gatedHost = null;
    const probe = async (request) => {
      if (gatedHost && request.host === gatedHost) await new Promise((resolve) => gates.push(resolve));
      return { ok: true, result: "connected", latencyMs: 3 };
    };
    const { service } = createHarness({ endpoints, probe });
    const waitForGate = async () => {
      for (let i = 0; i < 100 && gates.length < 1; i += 1) await delay(5);
      assert.equal(gates.length, 1, "the run reached its probe");
    };
    const cachedService = (nodeId) => service.getCachedDiagnostics({ nodeId, serviceId: SERVICE_ID }).cached;
    const cachedEndpoint = (nodeId) => service.getCachedEndpointDiagnostics({ nodeId, endpointId: "ep-second", endpoint: { ...second } }).cached;
    const seed = async () => {
      await service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, refresh: true });
      await service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-second", refresh: true });
      await service.runDiagnostics({ nodeId: "node-2", serviceId: SERVICE_ID, refresh: true });
    };

    // A non-public endpoint created on node-1: service-level results there may
    // now select differently; endpoint results and other nodes are kept.
    await seed();
    service.invalidateDiagnostics({ endpointId: "ep-created", selectionNodeIds: ["node-1"] });
    assert.equal(cachedService("node-1"), false, "node-1's service-level result is dropped");
    assert.equal(cachedEndpoint("node-1"), true, "an endpoint result that tested another endpoint is kept");
    assert.equal(cachedService("node-2"), true, "another node's service-level result is kept");

    // A public endpoint changed on node-1: every run there reports on the
    // public selection, so endpoint results are dropped as well.
    await seed();
    service.invalidateDiagnostics({ endpointId: "ep-public-new", selectionNodeIds: ["node-1"], publicSelectionChanged: true });
    assert.equal(cachedService("node-1"), false);
    assert.equal(cachedEndpoint("node-1"), false, "a public selection change drops endpoint results on that node");
    assert.equal(cachedService("node-2"), true, "and leaves other nodes alone");

    // An endpoint with no node may be listed for any node.
    await seed();
    service.invalidateDiagnostics({ endpointId: "ep-nodeless", selectionNodeIds: [null] });
    assert.equal(cachedService("node-1"), false);
    assert.equal(cachedService("node-2"), false, "a node-less endpoint change reaches every node");
    assert.equal(cachedEndpoint("node-1"), true);

    // In flight: disabling ep-second mid-run discards the service-level run on
    // its node (it may have selected differently) but not ep-first's own test.
    gatedHost = first.host;
    const serviceRun = service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID, refresh: true });
    await waitForGate();
    const firstRun = service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-first", refresh: true });
    endpoints[1] = { ...second, enabled: false };
    service.invalidateDiagnostics({ endpointId: "ep-second", selectionNodeIds: ["node-1"] });
    gatedHost = null;
    gates.splice(0).forEach((release) => release());
    assert.equal((await serviceRun).discarded, "ENDPOINT_CHANGED", "an in-flight service-level run is discarded by a selection change");
    assert.notEqual((await firstRun).discarded, "ENDPOINT_CHANGED", "an endpoint test is not discarded by a non-public selection change");
    assert.equal(cachedService("node-1"), false, "the discarded run was not cached");

    // In flight with a public change: the endpoint test is discarded too.
    gatedHost = first.host;
    const firstAgain = service.runDiagnostics({ nodeId: "node-1", endpointId: "ep-first", refresh: true });
    await waitForGate();
    service.invalidateDiagnostics({ endpointId: "ep-public-new", selectionNodeIds: ["node-1"], publicSelectionChanged: true });
    gatedHost = null;
    gates.splice(0).forEach((release) => release());
    assert.equal((await firstAgain).discarded, "ENDPOINT_CHANGED", "a public selection change discards an in-flight endpoint test");

    // Without selection fields the endpoint-only behaviour is unchanged.
    await seed();
    service.invalidateDiagnostics({ endpointId: "ep-unrelated-2" });
    assert.equal(cachedService("node-1"), true, "an endpoint-only invalidation leaves service-level results");
  }

  // --- PR #9 repair loop round 1: endpoint ids may contain the "|" cache-key
  //     delimiter; lookups, invalidation and in-flight detach use the stored
  //     endpoint id, never one parsed from the key ---
  {
    const piped = makeEndpoint("ep|pipe", "lan", "Piped", "192.168.1.60", 30120, { computerId: "node-1" });
    // Its id equals the piped id's suffix: a key parse would confuse the two.
    const suffix = makeEndpoint("pipe", "lan", "Suffix", "192.168.1.61", 30120, { computerId: "node-1" });
    const endpoints = [{ ...piped }, { ...suffix }];
    const gates = [];
    let gatedHost = null;
    const probe = async (request) => {
      if (gatedHost && request.host === gatedHost) await new Promise((resolve) => gates.push(resolve));
      return { ok: true, result: "connected", latencyMs: 3 };
    };
    const { service, calls } = createHarness({ endpoints, probe });

    const tested = await service.runDiagnostics({ nodeId: "node-1", endpointId: "ep|pipe", refresh: true });
    await service.runDiagnostics({ nodeId: "node-1", endpointId: "pipe", refresh: true });
    const found = service.getCachedEndpointDiagnostics({ nodeId: "node-1", endpointId: "ep|pipe", endpoint: { ...piped } });
    assert.equal(found.cached, true, "the canonical lookup finds an endpoint whose id contains |");
    const [projected] = service.projectEndpointHealth([{ ...piped }]);
    assert.equal(projected.health.state, tested.overall.state, "and its health is projected");

    // Invalidating the suffix id drops only that endpoint.
    assert.equal(service.invalidateDiagnostics({ endpointId: "pipe" }).invalidated, 1, "only the suffix endpoint's entry is dropped");
    assert.equal(service.getCachedEndpointDiagnostics({ nodeId: "node-1", endpointId: "ep|pipe", endpoint: { ...piped } }).cached, true,
      "the piped endpoint keeps its result");
    assert.equal(service.invalidateDiagnostics({ endpointId: "ep|pipe", nodeId: "node-9" }).invalidated, 0, "a node filter narrows the drop");
    assert.equal(service.invalidateDiagnostics({ endpointId: "ep|pipe" }).invalidated, 1, "the piped endpoint's entry is dropped by its own id");
    assert.equal(service.getCachedEndpointDiagnostics({ nodeId: "node-1", endpointId: "ep|pipe" }).cached, false);

    // An edit during a run detaches the in-flight run: a later caller starts
    // a fresh run and gets the current target's result.
    gatedHost = piped.host;
    const stale = service.runDiagnostics({ nodeId: "node-1", endpointId: "ep|pipe", refresh: true });
    for (let i = 0; i < 100 && gates.length < 1; i += 1) await delay(5);
    assert.equal(gates.length, 1, "the run reached its probe");
    const probesBefore = calls.probe;
    endpoints[0] = { ...piped, host: "192.168.1.160" };
    service.invalidateDiagnostics({ endpointId: "ep|pipe" });
    const fresh = await service.runDiagnostics({ nodeId: "node-1", endpointId: "ep|pipe", refresh: true });
    assert.equal(calls.probe, probesBefore + 1, "a caller after the edit starts a fresh run");
    assert.notEqual(fresh.discarded, "ENDPOINT_CHANGED", "and receives the current target's result");
    gatedHost = null;
    gates.splice(0).forEach((release) => release());
    assert.equal((await stale).discarded, "ENDPOINT_CHANGED", "the stale run is discarded");
  }

  console.log("connectivity-diagnostics-service-smoke: all assertions passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
