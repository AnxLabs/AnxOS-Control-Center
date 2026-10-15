"use strict";

// Bounded telemetry sampling service.
//
// WHAT THIS MODULE IS
// -------------------
// The collector that turns the pure, bounded series model in
// `src/shared/telemetryStore.js` into a running service: it reads preferences,
// samples host / instance / endpoint / provider state into registered series,
// persists the state to `<configDirectory>/telemetry.json`, and never throws
// out of `sampleOnce()`. Every failure is either a recorded gap sample
// ("missing is not zero") or a degraded flag on the service state.
//
// DEPENDENCY SEAM
// ---------------
// Everything environment-touching is injectable (`deps`): preferences, node
// list, host summary, instances, metrics, endpoints, providers. Defaults are
// lazy-required inside the functions so the module loads under plain Node (the
// smoke script) without Electron, and so optional siblings that do not exist
// yet (`connectivityDiagnosticsService`, `providerIntegrationService`) degrade
// to "skip" instead of crashing. Endpoint health reads CACHED diagnostics only
// and never probes the network.
//
// INTERPRETATIONS FROZEN HERE (spec was explicit or silent, see report):
//   * Host series kind is "host" for the application-host node and "node" for
//     agent nodes; both use hostSeriesKey().
//   * A host-summary throw records gap "collector-failed" for that node's host
//     series and does not abort that node's instance/endpoint/provider
//     sampling.
//   * Non-running instances get gap "not-running" for cpu/memory/uptime, but
//     their crashLoop series is still sampled (0 is a real observation read
//     from the instance record, not a fabricated runtime zero).
//   * Endpoint states are binary: healthy -> 1, failed -> 0, everything else
//     (unknown/unsupported/not_configured/degraded) -> null with gap "unknown"
//     because availability cannot honestly claim either outcome.
//   * Provider entries map explicit lifecycle evidence -> 1 (`connected` true
//     or state "running"), the explicit negative states -> 0, anything else
//     (including availability-only data) -> null with gap "unknown".
//   * `sinceMs` on reads is a lookback window (now - sinceMs), not an epoch.

const fs = require("fs");
const path = require("path");
const telemetryStore = require("../shared/telemetryStore");

const APPLICATION_HOST_KIND = "application-host";
const AGENT_KIND = "agent";

const DEFAULT_SAMPLING_INTERVAL_MS = 120000;
const MIN_SAMPLING_INTERVAL_MS = 30000;
const MAX_SAMPLING_INTERVAL_MS = 3600000;
const DEFAULT_RETENTION_DAYS = 7;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Bounded fan-out: two nodes in flight at a time keeps the sampler gentle on
// agent endpoints and the local process while still overlapping network waits.
const SAMPLING_CONCURRENCY = 2;

const TELEMETRY_STATE_CORRUPT = "TELEMETRY_STATE_CORRUPT";
const TELEMETRY_SCHEMA_UNSUPPORTED = "TELEMETRY_SCHEMA_UNSUPPORTED";
const TELEMETRY_SERIES_LIMIT = "TELEMETRY_SERIES_LIMIT";
const TELEMETRY_SAVE_FAILED = "TELEMETRY_SAVE_FAILED";
const TELEMETRY_PREFERENCES_UNAVAILABLE = "TELEMETRY_PREFERENCES_UNAVAILABLE";

const INSTANCE_RUNNING_STATES = Object.freeze(["Running", "Starting"]);

const HOST_METRICS = Object.freeze([
  { metric: "cpuPercent", label: "CPU usage", unit: "percent", read: (summary) => finiteNumber(summary?.cpu?.usagePercent) },
  { metric: "memoryPercent", label: "Memory usage", unit: "percent", read: (summary) => finiteNumber(summary?.memory?.percent) },
  { metric: "diskPercent", label: "Disk usage", unit: "percent", read: (summary) => finiteNumber(summary?.disk?.percent ?? summary?.disk?.usagePercent ?? summary?.disk?.usedPercent) },
  { metric: "networkDownBps", label: "Network download", unit: "bytes/s", read: (summary) => finiteNumber(summary?.network?.downloadPerSecond) },
  { metric: "networkUpBps", label: "Network upload", unit: "bytes/s", read: (summary) => finiteNumber(summary?.network?.uploadPerSecond) },
]);

const INSTANCE_RUNTIME_METRICS = Object.freeze([
  { metric: "cpuPercent", label: "CPU usage", unit: "percent", read: (metrics) => finiteNumber(metrics?.cpuPercent) },
  { metric: "memoryRssBytes", label: "Memory RSS", unit: "bytes", read: (metrics) => finiteNumber(metrics?.memoryRssBytes) },
  { metric: "uptimeSeconds", label: "Uptime", unit: "seconds", read: (metrics) => finiteNumber(metrics?.uptimeSeconds) },
]);

// Read-only cache accessors only: never call anything that could probe. The
// connectivity diagnostics service is not part of this change's write scope,
// so a missing module or an unknown shape degrades to "no cached endpoints".
const CACHED_DIAGNOSTICS_ACCESSORS = Object.freeze([
  "getCachedDiagnostics",
  "readCachedDiagnostics",
  "getDiagnosticsCache",
  "getLastDiagnostics",
  "readLastDiagnostics",
  "peekDiagnostics",
]);

function finiteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function clampInteger(value, fallback, min, max) {
  const number = finiteNumber(value);
  if (number === null) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function resolveConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) return process.env.ANXHUB_CONFIG_DIR;
  try {
    const electron = require("electron");
    if (electron && typeof electron.app?.getPath === "function") {
      return path.join(electron.app.getPath("userData"), "config");
    }
  } catch {
    // Plain Node (smoke scripts) has no Electron; fall through to cwd.
  }
  return path.join(process.cwd(), "config");
}

function defaultCachedEndpointHealth({ nodeId }) {
  let service = null;
  try {
    service = require("./connectivityDiagnosticsService");
  } catch {
    return [];
  }
  if (!service || typeof service !== "object") return [];
  let accessor = null;
  for (const name of CACHED_DIAGNOSTICS_ACCESSORS) {
    if (typeof service[name] === "function") {
      accessor = service[name];
      break;
    }
  }
  if (!accessor) return [];
  let snapshot = null;
  try {
    snapshot = accessor({ nodeId });
  } catch {
    return [];
  }
  return normalizeEndpointHealth(snapshot);
}

function defaultProviderStates({ nodeId }) {
  let service = null;
  try {
    service = require("./providerIntegrationService");
  } catch {
    return null;
  }
  if (!service || typeof service.getProviderSnapshot !== "function") return null;
  return service.getProviderSnapshot({ nodeId });
}

function normalizeEndpointHealth(snapshot) {
  if (!snapshot) return [];
  let source = snapshot;
  if (!Array.isArray(source) && typeof source === "object") {
    if (Array.isArray(source.endpoints)) source = source.endpoints;
    else if (Array.isArray(source.results)) source = source.results;
    else source = [];
  }
  const rows = [];
  for (const entry of Array.isArray(source) ? source : []) {
    if (!entry || typeof entry !== "object") continue;
    const endpointId = entry.endpointId || entry.endpoint?.endpointId || entry.id || null;
    if (typeof endpointId !== "string" || endpointId.length === 0) continue;
    const state = entry.state ?? entry.healthState ?? entry.status ?? "unknown";
    rows.push({ endpointId, state: String(state || "unknown") });
  }
  return rows;
}

function normalizeProviderStates(snapshot) {
  if (!snapshot) return [];
  let source = snapshot;
  if (!Array.isArray(source) && typeof source === "object") {
    if (Array.isArray(source.providers)) source = source.providers;
    else if (Array.isArray(source.states)) source = source.states;
    else if (source.providers && typeof source.providers === "object") {
      source = Object.entries(source.providers).map(([providerId, value]) => (
        value && typeof value === "object" ? { providerId, ...value } : { providerId }
      ));
    } else {
      source = [];
    }
  }
  const rows = [];
  for (const entry of Array.isArray(source) ? source : []) {
    if (!entry || typeof entry !== "object") continue;
    const providerId = entry.providerId || entry.id || entry.provider || entry.name || null;
    if (typeof providerId !== "string" || providerId.length === 0) continue;
    rows.push({ providerId, ...entry });
  }
  return rows;
}

// A provider is connected only on explicit lifecycle evidence: `connected`
// true, or a "running" state with no contradiction. An `availability` flag is
// never evidence on its own (a stopped provider can still report "available"),
// and a not-connected lifecycle state or `connected: false` is a real zero.
// Everything else stays a gap so the series can never read a fabricated value.
const PROVIDER_NEGATIVE_STATES = Object.freeze(["stopped", "auth-required", "not-installed", "degraded", "error"]);

function providerConnectedValue(entry) {
  if (entry.connected === false) return 0;
  const state = typeof entry.state === "string" ? entry.state.toLowerCase() : null;
  if (state !== null && PROVIDER_NEGATIVE_STATES.includes(state)) return 0;
  if (entry.connected === true) return 1;
  if (state === "running") return 1;
  return null;
}

/**
 * Factory. All environment access is injectable via `deps`; `storePath` and
 * `now` exist so tests can point the store at a temp file and drive a fake
 * clock. Nothing touches the filesystem until the first sample or read.
 */
function createTelemetryService(options = {}) {
  const injectedDeps = options.deps && typeof options.deps === "object" ? { ...options.deps } : {};
  const nowFn = typeof options.now === "function" ? options.now : () => Date.now();
  const explicitStorePath = typeof options.storePath === "string" && options.storePath.trim().length > 0
    ? options.storePath
    : null;

  let telemetry = telemetryStore.createEmptyState();
  let loaded = false;
  let storeAvailable = true;
  let degraded = false;
  let errorCode = null;
  let running = false;
  let timer = null;
  let sampling = false;
  let lastSampleAt = null;
  let seriesLimitNoted = false;

  function dep(name) {
    return typeof injectedDeps[name] === "function" ? injectedDeps[name] : null;
  }

  function getPreferencesSettings() {
    try {
      if (dep("getPreferences")) return dep("getPreferences")() || {};
      return require("./settingsPreferenceService").readPreferences().settings || {};
    } catch {
      noteDegraded(TELEMETRY_PREFERENCES_UNAVAILABLE);
      return {};
    }
  }

  function getStorePath() {
    return explicitStorePath || path.join(resolveConfigDirectory(), "telemetry.json");
  }

  function noteDegraded(code) {
    degraded = true;
    if (!errorCode) errorCode = code;
  }

  function quarantineStoreFile(file) {
    try {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`, fs.constants.COPYFILE_EXCL);
      return true;
    } catch {
      return false;
    }
  }

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const file = getStorePath();
    let raw = null;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return;
      // Unreadable (not missing) is not safe to overwrite: keep in memory.
      noteDegraded(TELEMETRY_STATE_CORRUPT);
      storeAvailable = false;
      return;
    }
    const parsed = telemetryStore.deserializeState(raw);
    if (parsed.ok) {
      telemetry = parsed.state;
      try { telemetryStore.trimToLimits(telemetry); } catch {}
      return;
    }
    if (parsed.code === TELEMETRY_SCHEMA_UNSUPPORTED) {
      // A newer build owns this file: sample in memory, never overwrite.
      noteDegraded(TELEMETRY_SCHEMA_UNSUPPORTED);
      storeAvailable = false;
      return;
    }
    // Corrupt content: preserve the original next to it, then start fresh.
    noteDegraded(TELEMETRY_STATE_CORRUPT);
    if (!quarantineStoreFile(file)) storeAvailable = false;
    telemetry = telemetryStore.createEmptyState();
  }

  function saveState() {
    if (!storeAvailable) return false;
    const file = getStorePath();
    try {
      telemetryStore.trimToLimits(telemetry);
      telemetryStore.trimToRetention(telemetry, {
        retentionMs: effectiveRetentionDays(getPreferencesSettings()) * MS_PER_DAY,
        now: nowFn(),
      });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(temp, telemetryStore.serializeState(telemetry), { mode: 0o600 });
      try {
        fs.renameSync(temp, file);
      } catch (error) {
        try { fs.rmSync(temp, { force: true }); } catch {}
        throw error;
      }
      return true;
    } catch {
      noteDegraded(TELEMETRY_SAVE_FAILED);
      return false;
    }
  }

  function effectiveEnabled(settings) {
    return settings["telemetry.enabled"] !== false;
  }

  function effectiveIntervalMs(settings) {
    return clampInteger(settings["telemetry.samplingIntervalMs"], DEFAULT_SAMPLING_INTERVAL_MS, MIN_SAMPLING_INTERVAL_MS, MAX_SAMPLING_INTERVAL_MS);
  }

  function effectiveRetentionDays(settings) {
    return clampInteger(settings["telemetry.retentionDays"], DEFAULT_RETENTION_DAYS, MIN_RETENTION_DAYS, MAX_RETENTION_DAYS);
  }

  function resolveSinceMs(sinceMs) {
    const window = finiteNumber(sinceMs);
    if (window === null || window < 0) return null;
    return Math.max(0, nowFn() - window);
  }

  function ensureSeries(key, kind, metadata, counters) {
    if (telemetry.series && Object.prototype.hasOwnProperty.call(telemetry.series, key)) return true;
    const registration = telemetryStore.registerSeries(telemetry, { key, kind, ...metadata });
    if (registration.ok) {
      counters.seriesRegistered += 1;
      return true;
    }
    if (registration.code === TELEMETRY_SERIES_LIMIT) {
      counters.skippedSeries += 1;
      if (!seriesLimitNoted) {
        seriesLimitNoted = true;
        console.warn("[AnxOS][Telemetry] Series cap reached; further series are skipped.", {
          code: TELEMETRY_SERIES_LIMIT,
          limit: telemetryStore.DEFAULT_MAX_SERIES,
        });
      }
    }
    return false;
  }

  function pushGap(key, at, reason, counters) {
    counters.gaps += 1;
    telemetryStore.pushSample(telemetry, key, { at, value: null, missing: reason });
  }

  function pushValue(key, at, value) {
    telemetryStore.pushSample(telemetry, key, { at, value });
  }

  async function selectSampleNodes(requestedNodeIds) {
    let listing;
    if (dep("listNodes")) listing = await dep("listNodes")();
    else listing = await require("./nodeService").listNodes();
    const rows = Array.isArray(listing) ? listing : Array.isArray(listing?.nodes) ? listing.nodes : [];
    const nodes = [];
    const seen = new Set();
    for (const row of rows) {
      if (!row || typeof row.id !== "string" || row.id.length === 0 || seen.has(row.id)) continue;
      const isHost = row.kind === APPLICATION_HOST_KIND;
      const isAgent = row.kind === AGENT_KIND;
      if (!isHost && !isAgent) continue;
      if (isAgent && row.enabled === false) continue;
      if (requestedNodeIds && !requestedNodeIds.includes(row.id)) continue;
      seen.add(row.id);
      nodes.push({ id: row.id, kind: isHost ? "host" : "node" });
    }
    return nodes;
  }

  async function sampleNodeHost(node, sampledAt, counters) {
    let summary = null;
    let summaryFailed = false;
    try {
      summary = dep("getHostSummary")
        ? await dep("getHostSummary")({ nodeId: node.id })
        : await require("./systemService").getSystemSnapshot({ nodeId: node.id });
      if (!summary || typeof summary !== "object") summaryFailed = true;
    } catch {
      summaryFailed = true;
    }

    for (const definition of HOST_METRICS) {
      const key = telemetryStore.hostSeriesKey(node.id, definition.metric);
      const metadata = { label: definition.label, unit: definition.unit, nodeId: node.id };
      if (!ensureSeries(key, node.kind, metadata, counters)) continue;
      if (summaryFailed) {
        pushGap(key, sampledAt, "collector-failed", counters);
        continue;
      }
      const value = definition.read(summary);
      if (value === null) {
        pushGap(key, sampledAt, "collector-failed", counters);
        continue;
      }
      pushValue(key, sampledAt, value);
    }
  }

  async function sampleNodeInstances(node, sampledAt, counters) {
    let listing = null;
    try {
      listing = dep("listInstances")
        ? await dep("listInstances")({ nodeId: node.id })
        : await require("./serviceRouter").listInstances({ nodeId: node.id });
    } catch {
      listing = null;
    }
    const instances = Array.isArray(listing) ? listing : Array.isArray(listing?.instances) ? listing.instances : [];

    for (const instance of instances) {
      if (!instance || typeof instance.id !== "string" || instance.id.length === 0) continue;
      const instanceId = instance.id;
      const state = typeof instance.state === "string" ? instance.state : null;
      const isRunning = INSTANCE_RUNNING_STATES.includes(state);
      const crashLoop = instance.healthState === "crash-loop" || instance.failureReason === "CRASH_LOOP" ? 1 : 0;

      const crashKey = telemetryStore.instanceSeriesKey(node.id, instanceId, "crashLoop");
      if (ensureSeries(crashKey, "instance", { label: "Crash loop", unit: "bool", nodeId: node.id, instanceId }, counters)) {
        pushValue(crashKey, sampledAt, crashLoop);
      }

      let metrics = null;
      let metricsFailed = false;
      if (isRunning) {
        try {
          metrics = dep("getInstanceMetrics")
            ? await dep("getInstanceMetrics")({ nodeId: node.id, instanceId })
            : await require("./serviceRouter").getInstanceMetrics(instanceId, { nodeId: node.id });
          if (!metrics || typeof metrics !== "object") metricsFailed = true;
        } catch {
          metricsFailed = true;
        }
      }

      for (const definition of INSTANCE_RUNTIME_METRICS) {
        const key = telemetryStore.instanceSeriesKey(node.id, instanceId, definition.metric);
        const metadata = { label: definition.label, unit: definition.unit, nodeId: node.id, instanceId };
        if (!ensureSeries(key, "instance", metadata, counters)) continue;
        if (!isRunning) {
          pushGap(key, sampledAt, "not-running", counters);
          continue;
        }
        if (metricsFailed) {
          pushGap(key, sampledAt, "collector-failed", counters);
          continue;
        }
        const value = definition.read(metrics);
        if (value === null) {
          pushGap(key, sampledAt, "collector-failed", counters);
          continue;
        }
        pushValue(key, sampledAt, value);
      }
    }
  }

  async function sampleNodeEndpoints(node, sampledAt, counters) {
    let rows = null;
    try {
      rows = dep("getEndpointHealth")
        ? await dep("getEndpointHealth")({ nodeId: node.id })
        : defaultCachedEndpointHealth({ nodeId: node.id });
    } catch {
      rows = null;
    }
    if (!rows) return;

    for (const row of normalizeEndpointHealth(rows)) {
      const key = telemetryStore.endpointSeriesKey(row.endpointId, "available");
      if (!ensureSeries(key, "endpoint", { label: "Endpoint availability", unit: "bool" }, counters)) continue;
      const state = row.state.toLowerCase();
      if (state === "healthy") pushValue(key, sampledAt, 1);
      else if (state === "failed") pushValue(key, sampledAt, 0);
      else pushGap(key, sampledAt, "unknown", counters);
    }
  }

  async function sampleNodeProviders(node, sampledAt, counters) {
    let rows = null;
    try {
      rows = dep("getProviderStates")
        ? await dep("getProviderStates")({ nodeId: node.id })
        : defaultProviderStates({ nodeId: node.id });
    } catch {
      rows = null;
    }
    const providers = normalizeProviderStates(rows);
    for (const provider of providers) {
      const key = telemetryStore.providerSeriesKey(node.id, provider.providerId, "connected");
      if (!ensureSeries(key, "provider", { label: "Provider connected", unit: "bool", nodeId: node.id }, counters)) continue;
      const value = providerConnectedValue(provider);
      if (value === null) pushGap(key, sampledAt, "unknown", counters);
      else pushValue(key, sampledAt, value);
    }
  }

  async function sampleNode(node, sampledAt, counters) {
    await sampleNodeHost(node, sampledAt, counters);
    await sampleNodeInstances(node, sampledAt, counters);
    await sampleNodeEndpoints(node, sampledAt, counters);
    await sampleNodeProviders(node, sampledAt, counters);
  }

  async function sampleOnce(options = {}) {
    const requestedNodeIds = Array.isArray(options.nodeIds)
      ? options.nodeIds.filter((nodeId) => typeof nodeId === "string" && nodeId.length > 0)
      : null;

    const settings = getPreferencesSettings();
    if (!effectiveEnabled(settings)) return { ok: true, skipped: "disabled" };
    if (sampling) return { ok: true, skipped: "overlap" };

    sampling = true;
    try {
      ensureLoaded();
      const nodes = await selectSampleNodes(requestedNodeIds);
      const sampledAt = new Date(nowFn()).toISOString();
      const result = {
        ok: true,
        sampledAt,
        nodeCount: nodes.length,
        seriesRegistered: 0,
        gaps: 0,
        skippedSeries: 0,
        nodeErrors: [],
      };

      let cursor = 0;
      const workerCount = Math.max(1, Math.min(SAMPLING_CONCURRENCY, nodes.length));
      const workers = Array.from({ length: nodes.length === 0 ? 0 : workerCount }, async () => {
        while (cursor < nodes.length) {
          const node = nodes[cursor];
          cursor += 1;
          try {
            await sampleNode(node, sampledAt, result);
          } catch (error) {
            result.nodeErrors.push({ nodeId: node.id, code: error?.code || "TELEMETRY_NODE_SAMPLE_FAILED" });
          }
        }
      });
      await Promise.all(workers);

      lastSampleAt = sampledAt;
      saveState();
      return result;
    } catch (error) {
      noteDegraded(error?.code || "TELEMETRY_SAMPLE_FAILED");
      return { ok: false, errorCode: error?.code || "TELEMETRY_SAMPLE_FAILED" };
    } finally {
      sampling = false;
    }
  }

  function scheduleNext() {
    if (!running || timer) return;
    const interval = effectiveIntervalMs(getPreferencesSettings());
    timer = setTimeout(() => {
      timer = null;
      if (!running) return;
      if (sampling) {
        scheduleNext();
        return;
      }
      sampleOnce().then(() => {
        if (running) scheduleNext();
      }, () => {
        if (running) scheduleNext();
      });
    }, interval);
    if (timer && typeof timer.unref === "function") timer.unref();
  }

  function startTelemetrySampler() {
    if (!running) {
      running = true;
      scheduleNext();
    }
    return getTelemetryState();
  }

  function stopTelemetrySampler() {
    running = false;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    return getTelemetryState();
  }

  function getTelemetryState() {
    try { ensureLoaded(); } catch {}
    const settings = getPreferencesSettings();
    let sampleCount = 0;
    try {
      for (const row of telemetryStore.listSeries(telemetry)) sampleCount += row.sampleCount;
    } catch {}
    return {
      enabled: effectiveEnabled(settings),
      samplingIntervalMs: effectiveIntervalMs(settings),
      retentionDays: effectiveRetentionDays(settings),
      running,
      lastSampleAt,
      seriesCount: Object.keys(telemetry.series || {}).length,
      sampleCount,
      bytes: telemetryStore.estimateStateBytes(telemetry),
      degraded,
      errorCode,
      storeAvailable,
    };
  }

  function getTelemetrySummary(options = {}) {
    try { ensureLoaded(); } catch {}
    const nodeId = typeof options.nodeId === "string" && options.nodeId.length > 0 ? options.nodeId : null;
    const since = resolveSinceMs(options.sinceMs);
    const now = nowFn();
    const series = [];
    for (const row of telemetryStore.listSeries(telemetry)) {
      if (nodeId && row.nodeId !== nodeId) continue;
      series.push({
        key: row.key,
        kind: row.kind,
        label: row.label,
        unit: row.unit,
        nodeId: row.nodeId,
        instanceId: row.instanceId,
        sampleCount: row.sampleCount,
        firstAt: row.firstAt,
        lastAt: row.lastAt,
        summary: telemetryStore.summarizeSeries(telemetry, row.key, { since, now }),
      });
    }
    return { generatedAt: new Date(now).toISOString(), nodeId, series };
  }

  function getTelemetrySeries(options = {}) {
    try { ensureLoaded(); } catch {}
    const nodeId = typeof options.nodeId === "string" && options.nodeId.length > 0 ? options.nodeId : null;
    const keyFilter = Array.isArray(options.keys) ? new Set(options.keys) : null;
    const since = resolveSinceMs(options.sinceMs);
    const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : null;
    const series = [];
    for (const row of telemetryStore.listSeries(telemetry)) {
      if (nodeId && row.nodeId !== nodeId) continue;
      if (keyFilter && !keyFilter.has(row.key)) continue;
      const record = telemetryStore.readSeries(telemetry, row.key, { since, limit });
      if (record) series.push(record);
    }
    return { generatedAt: new Date(nowFn()).toISOString(), series };
  }

  function exportTelemetry(options = {}) {
    try { ensureLoaded(); } catch {}
    const nodeId = typeof options.nodeId === "string" && options.nodeId.length > 0 ? options.nodeId : null;
    const since = resolveSinceMs(options.sinceMs);
    const generatedAt = new Date(nowFn()).toISOString();
    const keys = nodeId
      ? telemetryStore.listSeries(telemetry).filter((row) => row.nodeId === nodeId).map((row) => row.key)
      : null;
    const exported = telemetryStore.exportSeries(telemetry, { keys, since, generatedAt });
    return {
      ...exported,
      suggestedFilename: `anxos-telemetry-${generatedAt.replace(/[:.]/g, "-")}.json`,
    };
  }

  function clearTelemetry() {
    try { ensureLoaded(); } catch {}
    const removedSeries = Object.keys(telemetry.series || {}).length;
    telemetry = telemetryStore.createEmptyState();
    saveState();
    return { cleared: true, removedSeries };
  }

  return {
    startTelemetrySampler,
    stopTelemetrySampler,
    sampleOnce,
    getTelemetryState,
    getTelemetrySummary,
    getTelemetrySeries,
    exportTelemetry,
    clearTelemetry,
  };
}

const defaultService = createTelemetryService();

module.exports = {
  DEFAULT_SAMPLING_INTERVAL_MS,
  MIN_SAMPLING_INTERVAL_MS,
  MAX_SAMPLING_INTERVAL_MS,
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  createTelemetryService,
  startTelemetrySampler: () => defaultService.startTelemetrySampler(),
  stopTelemetrySampler: () => defaultService.stopTelemetrySampler(),
  sampleOnce: (options) => defaultService.sampleOnce(options),
  getTelemetryState: () => defaultService.getTelemetryState(),
  getTelemetrySummary: (options) => defaultService.getTelemetrySummary(options),
  getTelemetrySeries: (options) => defaultService.getTelemetrySeries(options),
  exportTelemetry: (options) => defaultService.exportTelemetry(options),
  clearTelemetry: () => defaultService.clearTelemetry(),
};
