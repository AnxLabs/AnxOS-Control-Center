"use strict";

// Integration-level no-fake-green / degraded-mode smoke for the connectivity
// pipeline, telemetry gap semantics, operational-notification seeding, and the
// stale-agent computer summary. Pure and injected: no network, no Agent, no
// Electron. Run from the repository root:
//   node scripts/connectivity-no-fake-green-smoke.js
//
// The single property under test: absence of evidence can never read as
// "healthy", absence of evidence is never "failed", and a "down" state emits
// exactly one transition-driven notification. This file pairs the pure model
// sweep (buildDiagnosticsResult + connectivityGraph + presentation) with the
// real service pipelines for the cases that historically fake green: a running
// process with a closed port, a missing provider, a timed-out probe, an
// unreachable public endpoint, missing telemetry samples, and a stale agent.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const diagnosticsModel = require("../src/shared/connectivityDiagnostics");
const presentation = require("../src/shared/connectivityPresentation");
const healthModel = require("../src/shared/healthModel");
const { buildConnectivityGraph } = require("../src/shared/connectivityGraph");
const telemetryStore = require("../src/shared/telemetryStore");
const { createConnectivityDiagnosticsService } = require("../src/services/connectivityDiagnosticsService");
const { createTelemetryService } = require("../src/services/telemetryService");
const { createOperationalNotificationService } = require("../src/services/operationalNotificationService");
const { createComputerService } = require("../src/services/computerService");

const NOW = "2026-09-27T12:30:00.000Z";
const SERVICE_ID = "svc-anxrp";

let checks = 0;
const failures = [];
const tempDirs = [];

async function test(name, fn) {
  try {
    await fn();
    checks += 1;
  } catch (error) {
    failures.push(`${name}: ${error && error.stack ? error.stack : String(error)}`);
  }
}

function tempDir(prefix = "anx-no-fake-green-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Pure-model sweep harness
// ---------------------------------------------------------------------------

// One endpoint per route kind so the graph exercises every mapping:
// direct (local-socket + host-network), provider (provider stage), public.
const SWEEP_ENDPOINTS = [
  { id: "ep-lan", type: "lan", name: "LAN", host: "192.168.1.50", port: 30120, protocol: "tcp" },
  { id: "ep-provider", type: "public", name: "Playit", host: "anxlab-example.playit.gg", port: 30120, protocol: "tcp", providerId: "playit" },
  { id: "ep-public", type: "public", name: "Panel", host: "panel.example.com", port: 8080, protocol: "http" },
];

const SWEEP_PROVIDERS = [{ id: "playit", name: "Playit" }];

function allStages(state) {
  return Object.fromEntries(diagnosticsModel.STAGE_IDS.map((id) => [id, state]));
}

function buildStages(states) {
  return diagnosticsModel.STAGE_IDS.map((id) => ({
    id,
    state: states[id],
    detail: `${id}: ${states[id]}`,
    evidence: { note: states[id] },
  }));
}

// Mirrors the scope aggregation connectivityDiagnosticsService performs, so the
// sweep result carries the same reachability shape the live pipeline produces.
function scopesFromState(states) {
  const local = healthModel.combineStates([states["service-process"], states["local-socket"]]);
  return {
    process: states["service-process"],
    local,
    lan: healthModel.combineStates([local, states["host-network"]]),
    private_overlay: "not_configured",
    public: states["public-endpoint"],
  };
}

function buildSweepResult(states) {
  return diagnosticsModel.buildDiagnosticsResult({
    target: { nodeId: "node-1", serviceId: SERVICE_ID },
    stages: buildStages(states),
    scopes: scopesFromState(states),
    checkedAt: NOW,
    durationMs: 1,
    cached: false,
  });
}

function buildSweepGraph(result) {
  return buildConnectivityGraph({
    computer: { id: "node-1", name: "SWEEP-BOX" },
    service: { id: SERVICE_ID, name: "AnxRP" },
    endpoints: SWEEP_ENDPOINTS,
    providers: SWEEP_PROVIDERS,
    diagnostics: result,
    now: NOW,
  });
}

// ---------------------------------------------------------------------------
// Live-pipeline harness (injected fakes only)
// ---------------------------------------------------------------------------

function makeEndpoint(id, type, name, host, port, extra = {}) {
  return { id, type, name, host, port, protocol: "tcp", enabled: true, providerId: null, serviceId: SERVICE_ID, ...extra };
}

function makeInventory(listening = true) {
  return {
    supported: true,
    listenerSource: "fixture",
    listeners: [],
    interfaces: [],
    checkPort: {
      port: 30120,
      protocol: "tcp",
      listening,
      boundAddresses: listening ? ["0.0.0.0"] : [],
      listenerSource: "fixture",
    },
  };
}

function createHarness(options = {}) {
  const probes = [];
  const deps = {
    getServiceContext: async () => ({
      instance: {
        id: SERVICE_ID,
        displayName: "AnxRP",
        state: "running",
        pid: 4242,
        uptimeSeconds: 600,
        processRunning: true,
      },
      computer: { id: "node-1", name: "SWEEP-BOX" },
    }),
    getAgentState: async () => ({ kind: "application-host", state: "online", lastContact: null, agentVersion: null, stale: false }),
    getEndpoints: async () => (options.endpoints || []).map((endpoint) => ({ ...endpoint })),
    getProviderState: async () => (options.providerState === undefined ? null : options.providerState),
    getNetworkInventory: async () => options.inventory || makeInventory(true),
    probeTcp: async (request) => {
      probes.push(request);
      return options.probe ? options.probe(request) : { ok: true, result: "connected", latencyMs: 2 };
    },
  };
  const service = createConnectivityDiagnosticsService({
    deps,
    now: () => NOW,
    probeTimeoutMs: options.probeTimeoutMs === undefined ? 2500 : options.probeTimeoutMs,
  });
  return { service, probes };
}

function stageOf(result, id) {
  return result.stages.find((stage) => stage.id === id);
}

async function main() {
  // -------------------------------------------------------------------------
  // A. Unknown-never-green sweep + explicit positive control
  // -------------------------------------------------------------------------

  await test("unknown-never-green sweep: no stage combo leaks healthy or invents failure", async () => {
    const combos = [
      {
        name: "all-unknown",
        hasUnknown: true,
        hasFailed: false,
        expectedOverall: "unknown",
        states: allStages("unknown"),
      },
      {
        name: "unknown+degraded",
        hasUnknown: true,
        hasFailed: false,
        expectedOverall: "unknown",
        states: {
          "service-process": "healthy",
          "local-socket": "unknown",
          "host-network": "healthy",
          agent: "degraded",
          provider: "unknown",
          "public-endpoint": "unknown",
        },
      },
      {
        name: "unsupported-only",
        hasUnknown: false,
        hasFailed: false,
        expectedOverall: "not_configured",
        states: allStages("unsupported"),
      },
      {
        name: "not_configured-only",
        hasUnknown: false,
        hasFailed: false,
        expectedOverall: "not_configured",
        states: allStages("not_configured"),
      },
      {
        name: "mixed-with-failed",
        hasUnknown: true,
        hasFailed: true,
        expectedOverall: "failed",
        states: {
          "service-process": "healthy",
          "local-socket": "unknown",
          "host-network": "failed",
          agent: "healthy",
          provider: "degraded",
          "public-endpoint": "unknown",
        },
      },
    ];

    for (const combo of combos) {
      const result = buildSweepResult(combo.states);
      assert.strictEqual(result.overall.state, combo.expectedOverall, `${combo.name}: overall state`);
      if (!combo.hasFailed) {
        assert.notStrictEqual(result.overall.state, "failed", `${combo.name}: absence of evidence is never failed`);
      }
      if (combo.hasUnknown) {
        assert.notStrictEqual(result.overall.state, "healthy", `${combo.name}: unknown evidence is never green`);
      }

      const expectedLocal = healthModel.combineStates([combo.states["service-process"], combo.states["local-socket"]]);
      const expectedScopes = {
        process: combo.states["service-process"],
        local: expectedLocal,
        lan: healthModel.combineStates([expectedLocal, combo.states["host-network"]]),
        private_overlay: "not_configured",
        public: combo.states["public-endpoint"],
      };
      const governingByScope = {
        process: [combo.states["service-process"]],
        local: [combo.states["service-process"], combo.states["local-socket"]],
        lan: [combo.states["service-process"], combo.states["local-socket"], combo.states["host-network"]],
        private_overlay: [],
        public: [combo.states["public-endpoint"]],
      };
      for (const [scope, state] of Object.entries(result.reachability)) {
        assert.strictEqual(state, expectedScopes[scope], `${combo.name}: reachability.${scope} must mirror its stages`);
        const governing = governingByScope[scope] || [];
        if (governing.includes("unknown")) {
          assert.notStrictEqual(state, "healthy", `${combo.name}: reachability.${scope} with unknown evidence must not be green`);
        }
        if (!governing.includes("failed")) {
          assert.notStrictEqual(state, "failed", `${combo.name}: reachability.${scope} must not invent failure`);
        }
      }

      const graph = buildSweepGraph(result);
      assert.notStrictEqual(graph.summary.state, "healthy", `${combo.name}: graph summary must not be green`);
      if (!combo.hasFailed) {
        assert.notStrictEqual(graph.summary.state, "failed", `${combo.name}: graph summary must not invent failure`);
      }

      const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
      const directState = healthModel.combineStates([combo.states["local-socket"], combo.states["host-network"]]);
      assert.strictEqual(nodeById.get("endpoint:ep-lan").state, directState, `${combo.name}: direct endpoint state`);
      assert.strictEqual(nodeById.get("endpoint:ep-provider").state, combo.states.provider, `${combo.name}: provider endpoint state`);
      assert.strictEqual(nodeById.get("endpoint:ep-public").state, combo.states["public-endpoint"], `${combo.name}: public endpoint state`);
      assert.strictEqual(nodeById.get(`service:${SERVICE_ID}`).state, result.overall.state, `${combo.name}: service node state`);
      assert.strictEqual(nodeById.get("computer:node-1").state, combo.states.agent, `${combo.name}: computer node state`);
      if (!combo.hasFailed) {
        for (const node of graph.nodes) {
          assert.notStrictEqual(node.state, "failed", `${combo.name}: graph node ${node.id} must not invent failure`);
        }
      }

      const summary = presentation.summarizeConnectivity(result);
      if (combo.hasUnknown) {
        assert.notStrictEqual(summary.tone, "ok", `${combo.name}: presentation must not be green`);
        assert.ok(!summary.headline.includes("Healthy"), `${combo.name}: headline must not say Healthy`);
      }
      if (!combo.hasFailed) {
        assert.notStrictEqual(summary.tone, "error", `${combo.name}: presentation must not claim failure`);
        assert.ok(!summary.headline.startsWith("Path broken"), `${combo.name}: headline must not name a broken path`);
        assert.deepStrictEqual(summary.failedStages, [], `${combo.name}: no failed stages`);
      }
      for (const row of summary.scopeRows) {
        const governing = governingByScope[row.scope] || [];
        if (governing.includes("unknown")) {
          assert.notStrictEqual(row.state, "healthy", `${combo.name}: scope row ${row.scope} with unknown evidence must not be green`);
        }
        if (!governing.includes("failed")) {
          assert.notStrictEqual(row.state, "failed", `${combo.name}: scope row ${row.scope} must not invent failure`);
        }
      }
    }

    // Missing evidence entirely (no stages at all) is unknown, never green,
    // never failed.
    const missing = diagnosticsModel.buildDiagnosticsResult({ target: { nodeId: "node-1" }, stages: [], scopes: {}, checkedAt: NOW });
    assert.strictEqual(missing.overall.state, "unknown");
    assert.notStrictEqual(missing.overall.state, "failed");
    const missingGraph = buildConnectivityGraph({ computer: { id: "node-1" }, endpoints: SWEEP_ENDPOINTS, diagnostics: null, now: NOW });
    assert.strictEqual(missingGraph.summary.state, "unknown");
    for (const node of missingGraph.nodes) assert.strictEqual(node.state, "unknown");
    const missingSummary = presentation.summarizeConnectivity(null);
    assert.notStrictEqual(missingSummary.tone, "ok");
    for (const row of missingSummary.scopeRows) assert.strictEqual(row.state, "unknown");
  });

  await test("negative control: identical inputs with full positive evidence ARE healthy", async () => {
    const healthy = allStages("healthy");
    const result = buildSweepResult(healthy);
    assert.strictEqual(result.overall.state, "healthy");
    assert.strictEqual(result.reachability.process, "healthy");
    assert.strictEqual(result.reachability.local, "healthy");
    assert.strictEqual(result.reachability.lan, "healthy");
    assert.strictEqual(result.reachability.public, "healthy");

    const graph = buildSweepGraph(result);
    assert.strictEqual(graph.summary.state, "healthy");
    for (const node of graph.nodes) assert.strictEqual(node.state, "healthy", `node ${node.id} should be healthy`);

    const summary = presentation.summarizeConnectivity(result);
    assert.strictEqual(summary.tone, "ok");
    assert.strictEqual(summary.headline, "Healthy");
    assert.deepStrictEqual(summary.unknownStages, []);
    assert.deepStrictEqual(summary.failedStages, []);
  });

  // -------------------------------------------------------------------------
  // B. Live pipeline scenarios
  // -------------------------------------------------------------------------

  await test("running service with a refused local port: overall failed, local scope failed, headline names Local Port", async () => {
    const h = createHarness({
      endpoints: [makeEndpoint("ep-lan", "lan", "LAN", "127.0.0.1", 30120)],
      inventory: makeInventory(false),
      probe: async () => ({ ok: false, result: "refused", code: "ECONNREFUSED" }),
    });
    const result = await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assert.strictEqual(stageOf(result, "service-process").state, "healthy", "process is running...");
    assert.strictEqual(stageOf(result, "local-socket").state, "failed", "...but the port is closed");
    assert.strictEqual(stageOf(result, "local-socket").evidence.result, "refused");
    assert.strictEqual(result.overall.state, "failed");
    assert.strictEqual(result.reachability.local, "failed");
    assert.ok(result.overall.headline.includes("Local Port"), "the headline must name the broken stage");

    const summary = presentation.summarizeConnectivity(result);
    assert.strictEqual(summary.tone, "error");
    assert.ok(summary.failedStages.includes("local-socket"));
  });

  await test("no provider configured: provider/public not_configured and the local profile stays healthy", async () => {
    const h = createHarness({
      endpoints: [makeEndpoint("ep-lan", "lan", "LAN", "127.0.0.1", 30120)],
      inventory: makeInventory(true),
    });
    const result = await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assert.strictEqual(stageOf(result, "provider").state, "not_configured");
    assert.strictEqual(stageOf(result, "public-endpoint").state, "not_configured");
    assert.strictEqual(result.overall.state, "healthy");
    assert.strictEqual(result.reachability.process, "healthy");
    assert.strictEqual(result.reachability.local, "healthy");
    assert.strictEqual(result.reachability.lan, "healthy");
    assert.strictEqual(result.reachability.public, "not_configured");
    assert.strictEqual(h.probes.length, 1, "only the local socket was probed");

    const summary = presentation.summarizeConnectivity(result);
    assert.strictEqual(summary.tone, "ok");
    const publicRow = summary.scopeRows.find((row) => row.scope === "public");
    assert.strictEqual(publicRow.state, "not_configured");
    assert.notStrictEqual(publicRow.state, "failed", "absence of a provider must not fail any scope");
  });

  await test("probe resolving after the diagnostics timeout: local-socket unknown, never failed", async () => {
    const h = createHarness({
      probeTimeoutMs: 25,
      endpoints: [makeEndpoint("ep-lan", "lan", "LAN", "127.0.0.1", 30120)],
      probe: async () => {
        await delay(120);
        return { ok: true, result: "connected", latencyMs: 120 };
      },
    });
    const result = await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    const localSocket = stageOf(result, "local-socket");
    assert.strictEqual(localSocket.state, "unknown", "a timed-out probe is missing evidence");
    assert.notStrictEqual(localSocket.state, "failed");
    assert.strictEqual(localSocket.evidence.error, "TIMEOUT");
    assert.strictEqual(result.overall.state, "unknown");
    assert.notStrictEqual(result.overall.state, "healthy");

    const summary = presentation.summarizeConnectivity(result);
    assert.notStrictEqual(summary.tone, "ok");
    assert.ok(summary.headline.startsWith("Incomplete evidence"));
    assert.ok(summary.headline.includes("Local Port"), "the unknown stage is named");
  });

  await test("provider healthy but public probe refused: public unknown with the hairpin note", async () => {
    const h = createHarness({
      endpoints: [
        makeEndpoint("ep-local", "lan", "Local", "127.0.0.1", 30120),
        makeEndpoint("ep-public", "public", "Public", "anxlab-example.playit.gg", 30120, { providerId: "playit" }),
      ],
      providerState: { providerId: "playit", state: "running", connected: true },
      probe: async (request) =>
        request.host === "127.0.0.1"
          ? { ok: true, result: "connected", latencyMs: 2 }
          : { ok: false, result: "refused", code: "ECONNREFUSED" },
    });
    const result = await h.service.runDiagnostics({ nodeId: "node-1", serviceId: SERVICE_ID });
    assert.strictEqual(stageOf(result, "provider").state, "healthy");
    const publicStage = stageOf(result, "public-endpoint");
    assert.strictEqual(publicStage.state, "unknown", "an unreachable public endpoint is unproven, not failed");
    assert.notStrictEqual(publicStage.state, "healthy");
    assert.notStrictEqual(publicStage.state, "failed");
    assert.match(publicStage.detail, /NAT hairpin/);
    assert.strictEqual(publicStage.evidence.vantage, "control-plane");
    assert.strictEqual(result.overall.state, "unknown");
    assert.strictEqual(result.reachability.public, "unknown");
    assert.strictEqual(h.probes.length, 2, "local socket and public endpoint were each probed once");
  });

  // -------------------------------------------------------------------------
  // C. Telemetry gap semantics: missing is never zero
  // -------------------------------------------------------------------------

  await test("telemetry: collector failure and unobservable states are gaps, never zero", async () => {
    const dir = tempDir();
    const sampledAt = Date.parse("2026-09-27T10:00:00.000Z");
    const service = createTelemetryService({
      storePath: path.join(dir, "telemetry.json"),
      now: () => sampledAt,
      deps: {
        getPreferences: () => ({}),
        listNodes: async () => [{ id: "node-1", kind: "application-host" }],
        getHostSummary: async () => {
          throw Object.assign(new Error("host collector unavailable"), { code: "HOST_SUMMARY_FAILED" });
        },
        listInstances: async () => ({ instances: [{ id: "inst-1", state: "Stopped" }] }),
        getEndpointHealth: async () => [{ endpointId: "ep-1", state: "unknown" }],
        getProviderStates: async () => null,
      },
    });

    const result = await service.sampleOnce();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.nodeCount, 1);
    assert.deepStrictEqual(result.nodeErrors, []);
    assert.strictEqual(result.gaps, 9, "5 host metrics + 3 stopped-instance metrics + 1 unknown endpoint");

    const lastSample = (key) => {
      const series = service.getTelemetrySeries({ keys: [key] });
      assert.strictEqual(series.series.length, 1, `${key} must exist`);
      const samples = series.series[0].samples;
      assert.ok(samples.length > 0, `${key} must carry a sample`);
      return samples[samples.length - 1];
    };
    const expectGap = (key, reason, label) => {
      const sample = lastSample(key);
      assert.strictEqual(sample.value, null, `${label}: a gap is never a value`);
      assert.strictEqual(sample.missing, reason, `${label}: gap reason`);
      assert.notStrictEqual(sample.value, 0, `${label}: missing is not zero`);
    };

    const cpuKey = telemetryStore.hostSeriesKey("node-1", "cpuPercent");
    expectGap(cpuKey, "collector-failed", "host cpu");
    expectGap(telemetryStore.instanceSeriesKey("node-1", "inst-1", "cpuPercent"), "not-running", "stopped instance cpu");
    expectGap(telemetryStore.endpointSeriesKey("node-1", "ep-1", "available"), "unknown", "endpoint availability");

    const crashLoop = service.getTelemetrySeries({ keys: [telemetryStore.instanceSeriesKey("node-1", "inst-1", "crashLoop")] });
    assert.strictEqual(crashLoop.series[0].samples[0].value, 0, "a real observed zero is still recorded as zero");

    const summary = service.getTelemetrySummary({ nodeId: "node-1" });
    const cpuRow = summary.series.find((row) => row.key === cpuKey);
    assert.ok(cpuRow, "host cpu series must be listed");
    assert.strictEqual(cpuRow.summary.avg, null, "an average over gaps is null");
    assert.notStrictEqual(cpuRow.summary.avg, 0, "an average over gaps must not read as zero");
    assert.strictEqual(cpuRow.summary.missingCount, 1);
    assert.strictEqual(cpuRow.summary.latestValue, null);
  });

  // -------------------------------------------------------------------------
  // D. Operational notifications: seeding, no spam, exactly one transition
  // -------------------------------------------------------------------------

  await test("notifications: first observation seeds and a down service emits exactly one event", async () => {
    const dir = tempDir();
    const instanceState = (state) => ({ instances: [{ nodeId: "node-1", instanceId: "svc-1", state }] });

    {
      let clock = Date.parse("2026-09-27T12:00:00.000Z");
      const journal = createOperationalNotificationService({
        collectState: async () => instanceState("Stopped"),
        storePath: path.join(dir, "notifications-seed.json"),
        now: () => clock,
      });
      const first = await journal.evaluate();
      assert.strictEqual(first.ok, true);
      assert.strictEqual(first.events.length, 0, "a first observation seeds, it never notifies");
      clock += 60000;
      const second = await journal.evaluate();
      assert.strictEqual(second.events.length, 0, "a still-stopped service on a seeded journal stays silent");
      assert.strictEqual(journal.list().events.length, 0);
    }

    {
      let clock = Date.parse("2026-09-27T12:00:00.000Z");
      let state = "Running";
      const journal = createOperationalNotificationService({
        collectState: async () => instanceState(state),
        storePath: path.join(dir, "notifications-transition.json"),
        now: () => clock,
      });
      const step = async (next) => {
        state = next;
        clock += 60000;
        return journal.evaluate();
      };

      let outcome = await step("Running");
      assert.strictEqual(outcome.events.length, 0, "seed");
      outcome = await step("Running");
      assert.strictEqual(outcome.events.length, 0);
      outcome = await step("Stopped");
      assert.strictEqual(outcome.events.length, 1, "running -> stopped emits exactly one event");
      assert.strictEqual(outcome.events[0].severity, "warning");
      assert.strictEqual(outcome.events[0].title, "Service stopped unexpectedly");
      assert.strictEqual(outcome.events[0].dedupKey, "instance:node-1:svc-1");

      let emitted = 1;
      for (let index = 0; index < 10; index += 1) {
        outcome = await step("Stopped");
        assert.strictEqual(outcome.events.length, 0, `repeat evaluation ${index + 1} must not re-notify`);
        emitted += outcome.events.length;
      }
      assert.strictEqual(emitted, 1, "a service down for 10 consecutive evaluations still has exactly one event");
      assert.strictEqual(journal.list().events.length, 1);

      outcome = await step("Running");
      assert.strictEqual(outcome.events.length, 1, "recovery is announced once it follows an announced incident");
      assert.strictEqual(outcome.events[0].title, "Service running again");
      outcome = await step("Running");
      assert.strictEqual(outcome.events.length, 0, "recovery is not re-announced");
    }
  });

  // -------------------------------------------------------------------------
  // E. Stale agent: present, stale, and never healthy
  // -------------------------------------------------------------------------

  await test("stale agent: offline node summary stays present, marked stale, never healthy", async () => {
    const staleLastSeen = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    let instanceReads = 0;
    const service = createComputerService({
      deps: {
        getNode: async () => ({
          id: "agent-1",
          displayName: "BUILD-BOX",
          kind: "agent",
          lastConnectionState: "offline",
          connection: { status: "offline", lastSeen: staleLastSeen, agentVersion: "1.4.0" },
        }),
        listEndpoints: async () => [],
        getEndpointSummary: async () => ({ total: 0, enabled: 0, disabled: 0 }),
        getTelemetrySummary: async () => ({ series: [] }),
        getProviderSyncs: async () => ({}),
        listInstances: async () => {
          instanceReads += 1;
          return { instances: [{ id: "svc-1", state: "running" }] };
        },
        getCachedDiagnostics: async () => ({ cached: false, stale: true, state: "unknown", reason: "NOT_EVALUATED" }),
        getProviderSnapshot: async () => {
          throw new Error("provider snapshot must not be consulted when the sync map is readable");
        },
      },
    });

    const summary = await service.getComputerSummary({ nodeId: "agent-1" });
    assert.ok(summary, "an offline computer must not disappear from summaries");
    assert.strictEqual(summary.id, "agent-1");
    assert.strictEqual(summary.name, "BUILD-BOX");
    assert.strictEqual(summary.online, false);
    assert.strictEqual(summary.agentState, "offline");
    assert.strictEqual(summary.agentVersion, "1.4.0");
    assert.strictEqual(summary.lastContact, staleLastSeen);
    assert.strictEqual(summary.lastContactStale, true);
    assert.strictEqual(summary.lastKnownAt, staleLastSeen);
    assert.notStrictEqual(summary.lastKnownAt, null);
    assert.strictEqual(summary.services.length, 0, "offline means the instance inventory is skipped, not fabricated");
    assert.strictEqual(instanceReads, 0, "an offline node is a normal state, not a degraded read");
    assert.strictEqual(summary.connectivity.local, "unknown", "local health is never claimed without evidence");
    assert.strictEqual(summary.connectivity.public, "not_configured");
    assert.ok(!Object.values(summary.connectivity).includes("healthy"), "no scope may read healthy from a stale agent");
    assert.strictEqual(summary.degraded, false);
  });
}

main()
  .catch((error) => {
    failures.push(`harness: ${error && error.stack ? error.stack : String(error)}`);
  })
  .then(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* best-effort temp cleanup */
      }
    }
    if (failures.length > 0) {
      console.error(`connectivity no-fake-green smoke: ${failures.length} failed, ${checks} passed`);
      for (const failure of failures) console.error(`  FAIL ${failure}`);
      process.exitCode = 1;
    } else {
      console.log(`connectivity no-fake-green smoke: all ${checks} test groups passed`);
    }
  });
