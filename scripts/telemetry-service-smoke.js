const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-telemetry-service-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");

const store = require("../src/shared/telemetryStore");
const telemetryService = require("../src/services/telemetryService");
const prefs = require("../src/services/settingsPreferenceService");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const HOST_METRICS = ["cpuPercent", "memoryPercent", "diskPercent", "networkDownBps", "networkUpBps"];
const INSTANCE_SERIES_METRICS = ["cpuPercent", "memoryRssBytes", "uptimeSeconds", "crashLoop"];

let clock = Date.UTC(2026, 8, 28, 0, 0, 0);
const now = () => clock;

function baseHostSummary() {
  return {
    cpu: { usagePercent: 10 },
    memory: { percent: 40 },
    disk: { percent: 30 },
    network: { downloadPerSecond: 100, uploadPerSecond: 50 },
    uptimeSeconds: 1000,
  };
}

function createFakeDeps(overrides = {}) {
  const deps = {
    getPreferences: () => ({}),
    listNodes: async () => ({
      nodes: [
        { id: "application-host", kind: "application-host" },
        { id: "node-a", kind: "agent", enabled: true },
      ],
    }),
    getHostSummary: async () => baseHostSummary(),
    listInstances: async () => ({ instances: [{ id: "inst-1", state: "Running", healthState: "healthy" }] }),
    getInstanceMetrics: async () => ({ cpuPercent: 5.5, memoryRssBytes: 1024, uptimeSeconds: 60 }),
    getEndpointHealth: async () => [],
    getProviderStates: async () => null,
  };
  return { ...deps, ...overrides };
}

function expectedHealthyKeys() {
  const keys = [];
  for (const nodeId of ["application-host", "node-a"]) {
    for (const metric of HOST_METRICS) keys.push(store.hostSeriesKey(nodeId, metric));
    for (const metric of INSTANCE_SERIES_METRICS) keys.push(store.instanceSeriesKey(nodeId, "inst-1", metric));
    keys.push(store.endpointSeriesKey(`ep-${nodeId}`, "available"));
    keys.push(store.providerSeriesKey(nodeId, `playit-${nodeId}`, "connected"));
  }
  return keys.sort();
}

async function main() {
  try {
    // --- Disabled setting: skipped with no writes -------------------------
    const disabledPath = path.join(root, "disabled.json");
    const disabledService = telemetryService.createTelemetryService({
      deps: createFakeDeps({ getPreferences: () => ({ "telemetry.enabled": false }) }),
      storePath: disabledPath,
      now,
    });
    const disabledResult = await disabledService.sampleOnce();
    assert.strictEqual(disabledResult.ok, true);
    assert.strictEqual(disabledResult.skipped, "disabled");
    assert.strictEqual(disabledService.getTelemetryState().lastSampleAt, null);
    assert.strictEqual(disabledService.getTelemetryState().sampleCount, 0);
    assert(!fs.existsSync(disabledPath), "disabled sampling must not write telemetry state");

    // --- Overlap guard -----------------------------------------------------
    let releaseHostSummary;
    const hostGate = new Promise((resolve) => { releaseHostSummary = resolve; });
    const overlapService = telemetryService.createTelemetryService({
      deps: createFakeDeps({ getHostSummary: async () => { await hostGate; return baseHostSummary(); } }),
      storePath: path.join(root, "overlap.json"),
      now,
    });
    const runningSample = overlapService.sampleOnce();
    const overlapResult = await overlapService.sampleOnce();
    assert.strictEqual(overlapResult.skipped, "overlap", "a second concurrent sample must be skipped, not duplicated");
    releaseHostSummary();
    const finishedSample = await runningSample;
    assert.strictEqual(finishedSample.ok, true);
    assert.strictEqual(finishedSample.skipped, undefined);

    // --- Healthy cycle + persistence round trip ----------------------------
    const healthyPath = path.join(root, "healthy.json");
    const healthyDeps = createFakeDeps({
      getEndpointHealth: async ({ nodeId }) => [{ endpointId: `ep-${nodeId}`, state: "healthy" }],
      getProviderStates: async ({ nodeId }) => ({ providers: [{ providerId: `playit-${nodeId}`, connected: true }] }),
    });
    const healthyService = telemetryService.createTelemetryService({ deps: healthyDeps, storePath: healthyPath, now });
    const healthyResult = await healthyService.sampleOnce();
    assert.strictEqual(healthyResult.ok, true);
    assert.strictEqual(healthyResult.nodeCount, 2);
    assert.strictEqual(healthyResult.nodeErrors.length, 0);
    assert(fs.existsSync(healthyPath), "sampling should write the telemetry store");
    if (process.platform !== "win32") {
      assert.strictEqual(fs.statSync(healthyPath).mode & 0o777, 0o600, "telemetry state file should be owner-only");
    }

    const healthyState = healthyService.getTelemetryState();
    assert.strictEqual(healthyState.degraded, false);
    assert.strictEqual(healthyState.seriesCount, expectedHealthyKeys().length);
    const healthySeries = healthyService.getTelemetrySeries({});
    assert.deepStrictEqual(healthySeries.series.map((row) => row.key).sort(), expectedHealthyKeys());
    for (const row of healthySeries.series) {
      assert.strictEqual(row.samples.length, 1, `${row.key} should have exactly one sample`);
      assert.strictEqual(row.samples[0].missing, null, `${row.key} should be a present sample`);
      assert.strictEqual(typeof row.samples[0].value, "number", `${row.key} should be numeric`);
    }
    const parsedStore = store.deserializeState(fs.readFileSync(healthyPath, "utf8"));
    assert.strictEqual(parsedStore.ok, true, "the written file must be a valid bounded state");

    const reloadedService = telemetryService.createTelemetryService({ deps: healthyDeps, storePath: healthyPath, now });
    const reloadedCpu = reloadedService.getTelemetrySeries({ keys: [store.hostSeriesKey("application-host", "cpuPercent")] });
    assert.strictEqual(reloadedCpu.series.length, 1);
    assert.strictEqual(reloadedCpu.series[0].samples.length, 1, "deserialized series should round trip");
    assert.strictEqual(reloadedCpu.series[0].samples[0].value, 10);

    // --- Missing is not zero ----------------------------------------------
    clock = Date.UTC(2026, 8, 28, 1, 0, 0);
    const missingPath = path.join(root, "missing.json");
    let transientSummary = {
      cpu: { usagePercent: null },
      memory: { percent: 40 },
      disk: { percent: 30 },
      network: { downloadPerSecond: 0, uploadPerSecond: 50 },
      uptimeSeconds: 1000,
    };
    const missingService = telemetryService.createTelemetryService({
      deps: createFakeDeps({
        getHostSummary: async () => transientSummary,
        getEndpointHealth: async () => [
          { endpointId: "ep-unknown", state: "unknown" },
          { endpointId: "ep-failed", state: "failed" },
        ],
      }),
      storePath: missingPath,
      now,
    });
    await missingService.sampleOnce();

    const cpuRow = missingService.getTelemetrySeries({ keys: [store.hostSeriesKey("application-host", "cpuPercent")] }).series[0];
    assert.strictEqual(cpuRow.samples[0].value, null);
    assert.strictEqual(cpuRow.samples[0].missing, "collector-failed", "a null collector value must be a gap, not zero");

    const downRow = missingService.getTelemetrySeries({ keys: [store.hostSeriesKey("application-host", "networkDownBps")] }).series[0];
    assert.strictEqual(downRow.samples[0].value, 0, "a real zero must stay a present value");
    assert.strictEqual(downRow.samples[0].missing, null);

    const unknownRow = missingService.getTelemetrySeries({ keys: [store.endpointSeriesKey("ep-unknown", "available")] }).series[0];
    assert.strictEqual(unknownRow.samples[0].value, null);
    assert.strictEqual(unknownRow.samples[0].missing, "unknown", "unknown endpoint state is a gap, never a zero");

    const failedRow = missingService.getTelemetrySeries({ keys: [store.endpointSeriesKey("ep-failed", "available")] }).series[0];
    assert.strictEqual(failedRow.samples[0].value, 0);
    assert.strictEqual(failedRow.samples[0].missing, null);

    // One gap plus one 40 must average to 40: gaps never contribute 0.
    transientSummary = { ...transientSummary, cpu: { usagePercent: 40 } };
    clock += 60000;
    await missingService.sampleOnce();
    const cpuSummary = missingService.getTelemetrySummary({ nodeId: "application-host" })
      .series.find((row) => row.key === store.hostSeriesKey("application-host", "cpuPercent")).summary;
    assert.strictEqual(cpuSummary.count, 2);
    assert.strictEqual(cpuSummary.missingCount, 1);
    assert.strictEqual(cpuSummary.avg, 40, "summaries must average present samples only");
    assert.strictEqual(cpuSummary.min, 40);
    assert.strictEqual(cpuSummary.max, 40);
    assert.strictEqual(cpuSummary.latestValue, 40);
    const downSummary = missingService.getTelemetrySummary({ nodeId: "application-host" })
      .series.find((row) => row.key === store.hostSeriesKey("application-host", "networkDownBps")).summary;
    assert.strictEqual(downSummary.missingCount, 0, "a zero is not a gap");
    assert.strictEqual(downSummary.avg, 0);

    // --- Provider connectivity: explicit lifecycle evidence only -----------
    clock = Date.UTC(2026, 8, 28, 1, 30, 0);
    const providerService = telemetryService.createTelemetryService({
      deps: createFakeDeps({
        getProviderStates: async () => ({
          providers: [
            { providerId: "playit-stopped-available", state: "stopped", availability: "available", connected: null },
            { providerId: "playit-stopped-connected-flag", state: "stopped", connected: true },
            { providerId: "playit-running", state: "running", connected: true },
            { providerId: "playit-running-no-flag", state: "running" },
            { providerId: "playit-running-not-connected", state: "running", connected: false },
            { providerId: "playit-auth-required", state: "auth-required" },
            { providerId: "playit-not-installed", state: "not-installed" },
            { providerId: "playit-degraded", state: "degraded" },
            { providerId: "playit-error", state: "error" },
            { providerId: "playit-unknown-available", state: "unknown", availability: "available" },
            { providerId: "playit-no-evidence" },
            { providerId: "playit-disconnected", connected: false },
          ],
        }),
      }),
      storePath: path.join(root, "provider-mapping.json"),
      now,
    });
    await providerService.sampleOnce({ nodeIds: ["application-host"] });
    const providerSample = (providerId) => {
      const series = providerService.getTelemetrySeries({
        keys: [store.providerSeriesKey("application-host", providerId, "connected")],
      });
      assert.strictEqual(series.series.length, 1, `${providerId} provider series must be registered`);
      assert.strictEqual(series.series[0].samples.length, 1, `${providerId} must have exactly one sample`);
      return series.series[0].samples[0];
    };

    const stoppedAvailable = providerSample("playit-stopped-available");
    assert.strictEqual(stoppedAvailable.value, 0, "a stopped provider with availability available is not connected");
    assert.notStrictEqual(stoppedAvailable.value, 1, "availability must never fabricate a connected sample");
    assert.strictEqual(stoppedAvailable.missing, null);
    assert.strictEqual(providerSample("playit-stopped-connected-flag").value, 0, "a stopped lifecycle state cannot be overridden by a stale connected flag");

    assert.strictEqual(providerSample("playit-running").value, 1, "running with connected true is connected");
    assert.strictEqual(providerSample("playit-running").missing, null);
    assert.strictEqual(providerSample("playit-running-no-flag").value, 1, "a running provider without a connected boolean is connected");
    assert.strictEqual(providerSample("playit-running-not-connected").value, 0, "connected false is an explicit not-connected zero");

    for (const providerId of ["playit-auth-required", "playit-not-installed", "playit-degraded", "playit-error"]) {
      const sample = providerSample(providerId);
      assert.strictEqual(sample.value, 0, `${providerId} is an explicit not-connected observation`);
      assert.strictEqual(sample.missing, null);
    }
    assert.strictEqual(providerSample("playit-disconnected").value, 0, "connected false with no state is an explicit not-connected observation");

    for (const providerId of ["playit-unknown-available", "playit-no-evidence"]) {
      const sample = providerSample(providerId);
      assert.strictEqual(sample.value, null, `${providerId} has no connectivity evidence and must be a gap`);
      assert.strictEqual(sample.missing, "unknown", `${providerId} gap reason`);
      assert.notStrictEqual(sample.value, 0, `${providerId} missing is not zero`);
    }

    // --- One collector throws, other nodes continue ------------------------
    clock = Date.UTC(2026, 8, 28, 2, 0, 0);
    const throwService = telemetryService.createTelemetryService({
      deps: createFakeDeps({
        getHostSummary: async ({ nodeId }) => {
          if (nodeId === "node-a") throw Object.assign(new Error("agent offline"), { code: "AGENT_UNAVAILABLE" });
          return baseHostSummary();
        },
      }),
      storePath: path.join(root, "throw.json"),
      now,
    });
    const throwResult = await throwService.sampleOnce();
    assert.strictEqual(throwResult.ok, true, "sampleOnce must never throw or abort");
    assert.strictEqual(throwResult.nodeErrors.length, 0, "a per-node collector failure is captured as gaps");
    const failedNodeCpu = throwService.getTelemetrySeries({ keys: [store.hostSeriesKey("node-a", "cpuPercent")] }).series[0];
    assert.strictEqual(failedNodeCpu.samples[0].value, null);
    assert.strictEqual(failedNodeCpu.samples[0].missing, "collector-failed");
    const healthyNodeCpu = throwService.getTelemetrySeries({ keys: [store.hostSeriesKey("application-host", "cpuPercent")] }).series[0];
    assert.strictEqual(healthyNodeCpu.samples[0].value, 10, "the other node must still be sampled");
    const continuedInstance = throwService.getTelemetrySeries({ keys: [store.instanceSeriesKey("node-a", "inst-1", "cpuPercent")] }).series[0];
    assert.strictEqual(continuedInstance.samples[0].value, 5.5, "instance sampling continues after a host collector failure");

    // --- Stopped instance: gap, not zero -----------------------------------
    let metricsCalls = 0;
    const stoppedService = telemetryService.createTelemetryService({
      deps: createFakeDeps({
        listInstances: async () => ({ instances: [{ id: "inst-off", state: "Stopped", healthState: "healthy" }] }),
        getInstanceMetrics: async () => { metricsCalls += 1; return { cpuPercent: 1, memoryRssBytes: 1, uptimeSeconds: 1 }; },
      }),
      storePath: path.join(root, "stopped.json"),
      now,
    });
    await stoppedService.sampleOnce();
    assert.strictEqual(metricsCalls, 0, "stopped instances must not be metric-probed");
    const stoppedUptime = stoppedService.getTelemetrySeries({ keys: [store.instanceSeriesKey("application-host", "inst-off", "uptimeSeconds")] }).series[0];
    assert.strictEqual(stoppedUptime.samples[0].value, null);
    assert.strictEqual(stoppedUptime.samples[0].missing, "not-running", "a stopped instance records a not-running gap, never zero");
    const stoppedCrashLoop = stoppedService.getTelemetrySeries({ keys: [store.instanceSeriesKey("application-host", "inst-off", "crashLoop")] }).series[0];
    assert.strictEqual(stoppedCrashLoop.samples[0].value, 0, "crashLoop is read from the instance record, so 0 is a real observation");
    assert.strictEqual(stoppedCrashLoop.samples[0].missing, null);

    // --- Interval/retention clamping ---------------------------------------
    const lowClampService = telemetryService.createTelemetryService({
      deps: createFakeDeps({ getPreferences: () => ({ "telemetry.samplingIntervalMs": 1000, "telemetry.retentionDays": 0 }) }),
      storePath: path.join(root, "clamp-low.json"),
      now,
    });
    assert.strictEqual(lowClampService.getTelemetryState().samplingIntervalMs, 30000);
    assert.strictEqual(lowClampService.getTelemetryState().retentionDays, 1);
    const highClampService = telemetryService.createTelemetryService({
      deps: createFakeDeps({ getPreferences: () => ({ "telemetry.samplingIntervalMs": 999999999, "telemetry.retentionDays": 99 }) }),
      storePath: path.join(root, "clamp-high.json"),
      now,
    });
    assert.strictEqual(highClampService.getTelemetryState().samplingIntervalMs, 3600000);
    assert.strictEqual(highClampService.getTelemetryState().retentionDays, 30);
    const defaultClampService = telemetryService.createTelemetryService({
      deps: createFakeDeps({ getPreferences: () => ({ "telemetry.samplingIntervalMs": "not-a-number" }) }),
      storePath: path.join(root, "clamp-default.json"),
      now,
    });
    assert.strictEqual(defaultClampService.getTelemetryState().samplingIntervalMs, 120000);
    assert.strictEqual(defaultClampService.getTelemetryState().retentionDays, 7);

    // --- Retention trims old samples on save -------------------------------
    clock = Date.UTC(2026, 8, 28, 3, 0, 0);
    const retentionStart = clock;
    const retentionService = telemetryService.createTelemetryService({
      deps: createFakeDeps(),
      storePath: path.join(root, "retention.json"),
      now,
    });
    await retentionService.sampleOnce();
    clock = retentionStart + 10 * MS_PER_DAY;
    await retentionService.sampleOnce();
    const retainedCpu = retentionService.getTelemetrySeries({ keys: [store.hostSeriesKey("application-host", "cpuPercent")] }).series[0];
    assert.strictEqual(retainedCpu.samples.length, 1, "samples older than the retention window are trimmed on save");
    assert.strictEqual(retainedCpu.samples[0].at, new Date(clock).toISOString());

    // --- Corrupt store: quarantine, degrade, keep sampling -----------------
    clock = Date.UTC(2026, 8, 28, 4, 0, 0);
    const corruptPath = path.join(root, "corrupt.json");
    fs.writeFileSync(corruptPath, "{ not valid json");
    const corruptService = telemetryService.createTelemetryService({ deps: createFakeDeps(), storePath: corruptPath, now });
    const corruptState = corruptService.getTelemetryState();
    assert.strictEqual(corruptState.degraded, true);
    assert.strictEqual(corruptState.errorCode, "TELEMETRY_STATE_CORRUPT");
    assert.strictEqual(corruptState.storeAvailable, true);
    const corruptResult = await corruptService.sampleOnce();
    assert.strictEqual(corruptResult.ok, true, "sampling continues after a corrupt store");
    assert(
      fs.readdirSync(root).some((name) => name.startsWith("corrupt.json.corrupt-")),
      "the corrupt store should be preserved in a quarantine file",
    );
    const rewroteStore = store.deserializeState(fs.readFileSync(corruptPath, "utf8"));
    assert.strictEqual(rewroteStore.ok, true, "a fresh state should be written after quarantine");
    assert.strictEqual(Object.keys(rewroteStore.state.series).length, corruptService.getTelemetryState().seriesCount);

    // --- Future schema: degraded, file untouched ---------------------------
    const futurePath = path.join(root, "future.json");
    fs.writeFileSync(futurePath, `${JSON.stringify({ schemaVersion: store.TELEMETRY_SCHEMA_VERSION + 500, series: {} })}\n`, { mode: 0o600 });
    const futureBytes = fs.readFileSync(futurePath);
    const futureService = telemetryService.createTelemetryService({ deps: createFakeDeps(), storePath: futurePath, now });
    const futureState = futureService.getTelemetryState();
    assert.strictEqual(futureState.degraded, true);
    assert.strictEqual(futureState.errorCode, "TELEMETRY_SCHEMA_UNSUPPORTED");
    assert.strictEqual(futureState.storeAvailable, false);
    const futureResult = await futureService.sampleOnce();
    assert.strictEqual(futureResult.ok, true);
    assert.strictEqual(futureService.getTelemetryState().seriesCount > 0, true, "sampling continues in memory only");
    assert(fs.readFileSync(futurePath).equals(futureBytes), "a newer schema file must stay byte-for-byte unchanged");

    // --- Export bounds + clear ---------------------------------------------
    clock = Date.UTC(2026, 8, 28, 5, 0, 0);
    const exportPath = path.join(root, "export.json");
    const exportService = telemetryService.createTelemetryService({
      deps: createFakeDeps({
        getEndpointHealth: async ({ nodeId }) => [{ endpointId: `ep-${nodeId}`, state: "healthy" }],
      }),
      storePath: exportPath,
      now,
    });
    await exportService.sampleOnce();
    const nodeExport = exportService.exportTelemetry({ nodeId: "node-a" });
    assert(/^anxos-telemetry-.+\.json$/.test(nodeExport.suggestedFilename), "export should suggest a bounded telemetry filename");
    assert(nodeExport.series.length > 0);
    assert(nodeExport.series.every((row) => row.nodeId === "node-a"), "node-scoped export filters series");
    for (const row of nodeExport.series) {
      assert(row.samples.length <= store.DEFAULT_MAX_SAMPLES_PER_SERIES, "export rows are bounded by the store cap");
    }
    const fullExport = exportService.exportTelemetry({});
    assert(fullExport.series.length > nodeExport.series.length);
    assert(!JSON.stringify(fullExport).includes(root), "exports must not leak filesystem paths");
    const cleared = exportService.clearTelemetry();
    assert.strictEqual(cleared.cleared, true);
    assert(cleared.removedSeries > 0);
    assert.strictEqual(exportService.getTelemetryState().seriesCount, 0);
    const clearedReload = telemetryService.createTelemetryService({ deps: createFakeDeps(), storePath: exportPath, now });
    assert.strictEqual(clearedReload.getTelemetryState().seriesCount, 0, "cleared state must persist");

    // --- Real settings keys: defaults + clamping + integration -------------
    const initial = prefs.readPreferences();
    assert.strictEqual(initial.settings["telemetry.enabled"], true);
    assert.strictEqual(initial.settings["telemetry.samplingIntervalMs"], 120000);
    assert.strictEqual(initial.settings["telemetry.retentionDays"], 7);
    assert.strictEqual(prefs.SETTING_DEFINITIONS["telemetry.enabled"].type, "boolean");
    assert.strictEqual(prefs.SETTING_DEFINITIONS["telemetry.samplingIntervalMs"].category, "telemetry");

    const clampedLow = prefs.updatePreferences({ "telemetry.samplingIntervalMs": 1000, "telemetry.retentionDays": 0 });
    assert.strictEqual(clampedLow.settings["telemetry.samplingIntervalMs"], 30000, "settings must clamp the sampling interval low bound");
    assert.strictEqual(clampedLow.settings["telemetry.retentionDays"], 1, "settings must clamp the retention low bound");
    const clampedHigh = prefs.updatePreferences({ "telemetry.samplingIntervalMs": 999999999, "telemetry.retentionDays": 99 });
    assert.strictEqual(clampedHigh.settings["telemetry.samplingIntervalMs"], 3600000, "settings must clamp the sampling interval high bound");
    assert.strictEqual(clampedHigh.settings["telemetry.retentionDays"], 30, "settings must clamp the retention high bound");
    const toggled = prefs.updatePreferences({ "telemetry.enabled": false });
    assert.strictEqual(toggled.settings["telemetry.enabled"], false);

    const realPrefsService = telemetryService.createTelemetryService({
      deps: createFakeDeps({ getPreferences: () => prefs.readPreferences().settings }),
      storePath: path.join(root, "real-prefs.json"),
      now,
    });
    assert.strictEqual(realPrefsService.getTelemetryState().samplingIntervalMs, 3600000, "effective interval comes from the real settings key");
    assert.strictEqual(realPrefsService.getTelemetryState().enabled, false);
    const realDisabled = await realPrefsService.sampleOnce();
    assert.strictEqual(realDisabled.skipped, "disabled", "the real settings key disables sampling");

    const reset = prefs.resetPreferences("telemetry");
    assert.strictEqual(reset.settings["telemetry.enabled"], true);
    assert.strictEqual(reset.settings["telemetry.samplingIntervalMs"], 120000);
    assert.strictEqual(reset.settings["telemetry.retentionDays"], 7);

    // --- Timer start/stop contract -----------------------------------------
    const started = realPrefsService.startTelemetrySampler();
    assert.strictEqual(started.running, true);
    const stopped = realPrefsService.stopTelemetrySampler();
    assert.strictEqual(stopped.running, false);

    // --- PR #9 review P2: the DEFAULT endpoint read records real series ----
    {
      const Module = require("module");
      const originalLoad = Module._load;
      Module._load = function loadWithEndpointDoubles(request, parent, isMain) {
        if (parent && /telemetryService\.js$/.test(parent.filename || "")) {
          if (request === "./endpointService") {
            return { listEndpoints: ({ nodeId }) => [{ id: `ep-tested-${nodeId}`, computerId: nodeId }, { id: `ep-never-${nodeId}`, computerId: nodeId }] };
          }
          if (request === "./connectivityDiagnosticsService") {
            return {
              projectEndpointHealth: (endpoints) => endpoints.map((endpoint) => (endpoint.id.startsWith("ep-tested")
                ? { ...endpoint, health: { status: "healthy", state: "healthy" } }
                : endpoint)),
            };
          }
        }
        return originalLoad.call(this, request, parent, isMain);
      };
      try {
        const deps = createFakeDeps();
        delete deps.getEndpointHealth; // exercise the production default path
        const service = telemetryService.createTelemetryService({ deps, storePath: path.join(root, "endpoint-default.json"), now });
        await service.sampleOnce();
        const testedKey = store.endpointSeriesKey("ep-tested-node-a", "available");
        const nodeScoped = service.getTelemetrySeries({ nodeId: "node-a" }).series.map((row) => row.key);
        assert(nodeScoped.includes(testedKey), "the default path records endpoint series, readable node-scoped");
        assert(!service.getTelemetrySeries({}).series.some((row) => row.key.includes("ep-never")), "never-evaluated endpoints record nothing");
        const summary = service.getTelemetrySummary({ nodeId: "node-a" });
        assert((summary.series || []).some((row) => row.key === testedKey), "the node-scoped summary includes endpoint series");
      } finally {
        Module._load = originalLoad;
      }
    }

    console.log("Telemetry service smoke checks passed.");
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
