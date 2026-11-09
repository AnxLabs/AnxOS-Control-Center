// Read-only reader for Project Forge's local health contract (`forge.health/1`).
// Forge rewrites the file atomically every 60 s while it runs. This module only
// reads it: no network listener, no writes, no process inspection. Only the
// whitelisted fields below are passed on, so nothing unexpected in the file
// (now or in a later contract revision) leaks into Agent responses.
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const FORGE_HEALTH_SCHEMA_PREFIX = "forge.health/1";
const DEFAULT_STALE_AFTER_SECONDS = 180;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ALERTS = 20;
const MAX_TEXT_LENGTH = 400;
const STATUS_VALUES = new Set(["ok", "warning", "critical", "stopped"]);
const ALERT_SEVERITIES = new Set(["critical", "high", "warning", "info"]);
const FORGE_SOURCE = "Project Forge";
// Forge rewrites health.json every 60 s; the Dashboard polls every second.
const DEFAULT_CACHE_MS = 5 * 1000;

function resolveForgeHealthPath(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  if (platform === "win32") {
    return env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, "AnxLabs", "Forge", "health.json") : null;
  }
  const home = options.homedir || os.homedir();
  const dataHome = env.XDG_DATA_HOME || (home ? path.posix.join(home, ".local", "share") : null);
  return dataHome ? path.posix.join(dataHome, "anxlabs", "forge", "health.json") : null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Missing or non-numeric values stay null: the contract says null means
// "could not measure", never zero.
function finiteOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function textOrNull(value, maxLength = MAX_TEXT_LENGTH) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function normalizeVerdict(verdict) {
  if (!isPlainObject(verdict)) return null;
  const result = {
    id: textOrNull(verdict.id, 80),
    severity: textOrNull(verdict.severity, 20),
    title: textOrNull(verdict.title),
  };
  return result.id || result.title ? result : null;
}

function normalizeThermals(section) {
  if (!isPlainObject(section)) return null;
  return {
    gpuC: finiteOrNull(section.gpu_c),
    cpuC: finiteOrNull(section.cpu_c),
    level: textOrNull(section.level, 20),
    summary: textOrNull(section.summary),
  };
}

function normalizeMemory(section) {
  if (!isPlainObject(section)) return null;
  return {
    availableBytes: finiteOrNull(section.available_bytes),
    totalBytes: finiteOrNull(section.total_bytes),
    commitPercent: finiteOrNull(section.commit_percent),
    pressure: textOrNull(section.pressure, 20),
  };
}

function normalizeKernel(section) {
  if (!isPlainObject(section)) return null;
  return {
    pagedBytes: finiteOrNull(section.paged_bytes),
    nonpagedBytes: finiteOrNull(section.nonpaged_bytes),
    growthBytesPerHour: finiteOrNull(section.growth_bytes_per_hour),
    verdict: normalizeVerdict(section.verdict),
  };
}

function normalizeCrashes(section) {
  if (!isPlainObject(section)) return null;
  const counts = isPlainObject(section.counts) ? section.counts : {};
  return {
    days: finiteOrNull(section.days),
    counts: {
      appCrashes: finiteOrNull(counts.app_crashes),
      appHangs: finiteOrNull(counts.app_hangs),
      unexpectedShutdowns: finiteOrNull(counts.unexpected_shutdowns),
      gpuResets: finiteOrNull(counts.gpu_resets),
      hardwareErrors: finiteOrNull(counts.hardware_errors),
    },
    verdict: normalizeVerdict(section.verdict),
  };
}

function normalizeBoost(section) {
  if (!isPlainObject(section)) return null;
  return {
    active: typeof section.active === "boolean" ? section.active : null,
    profile: textOrNull(section.profile, 80),
  };
}

function normalizeAlerts(alerts) {
  if (!Array.isArray(alerts)) return [];
  return alerts
    .filter(isPlainObject)
    .map((alert) => ({
      severity: ALERT_SEVERITIES.has(alert.severity) ? alert.severity : "info",
      code: textOrNull(alert.code, 80),
      title: textOrNull(alert.title),
      detail: textOrNull(alert.detail),
      forgePage: textOrNull(alert.forge_page, 40),
    }))
    .filter((alert) => alert.title || alert.code)
    .slice(0, MAX_ALERTS);
}

function unavailableForgeHealth(state, reason, extra = {}) {
  return {
    available: false,
    fresh: false,
    stale: false,
    state,
    reason,
    source: FORGE_SOURCE,
    status: null,
    alerts: [],
    ...extra,
  };
}

// Pure: turns raw file text into the sanitized summary the Agent exposes.
function parseForgeHealth(raw, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  let document;
  try {
    document = JSON.parse(String(raw));
  } catch {
    return unavailableForgeHealth("invalid", "invalid_json");
  }
  if (!isPlainObject(document)) {
    return unavailableForgeHealth("invalid", "invalid_json");
  }
  const schema = typeof document.schema === "string" ? document.schema : null;
  if (!schema || !schema.startsWith(FORGE_HEALTH_SCHEMA_PREFIX)) {
    return unavailableForgeHealth("invalid", "unsupported_schema", { schema: textOrNull(schema, 40) });
  }

  const staleAfterSeconds = finiteOrNull(document.stale_after_seconds) > 0
    ? document.stale_after_seconds
    : DEFAULT_STALE_AFTER_SECONDS;
  const generatedAtMs = typeof document.generated_at === "string" ? Date.parse(document.generated_at) : NaN;
  const ageSeconds = Number.isFinite(generatedAtMs) ? Math.round((now - generatedAtMs) / 1000) : null;
  const status = STATUS_VALUES.has(document.status) ? document.status : null;

  let state = "fresh";
  if (status === "stopped") {
    state = "stopped";
  } else if (ageSeconds === null || ageSeconds > staleAfterSeconds || ageSeconds < -staleAfterSeconds) {
    // An unreadable timestamp, or one far in the future, cannot prove freshness.
    state = "stale";
  }
  const fresh = state === "fresh";

  return {
    available: true,
    fresh,
    stale: !fresh,
    state,
    reason: fresh ? null : state === "stopped" ? "forge_stopped" : "file_stale",
    source: FORGE_SOURCE,
    schema: textOrNull(schema, 40),
    generatedAt: Number.isFinite(generatedAtMs) ? new Date(generatedAtMs).toISOString() : null,
    ageSeconds,
    staleAfterSeconds,
    status,
    forgeVersion: isPlainObject(document.forge) ? textOrNull(document.forge.version, 40) : null,
    thermals: normalizeThermals(document.thermals),
    memory: normalizeMemory(document.memory),
    kernel: normalizeKernel(document.kernel),
    crashes: normalizeCrashes(document.crashes),
    boost: normalizeBoost(document.boost),
    alerts: normalizeAlerts(document.alerts),
    errors: Array.isArray(document.errors)
      ? document.errors.map((entry) => textOrNull(entry, 200)).filter(Boolean).slice(0, 10)
      : [],
  };
}

async function readForgeHealth(options = {}) {
  const filePath = options.filePath === undefined ? resolveForgeHealthPath(options) : options.filePath;
  if (!filePath) {
    return unavailableForgeHealth("missing", "path_unavailable");
  }
  const readFile = options.readFile || ((target) => fs.readFile(target, "utf8"));
  const stat = options.stat || ((target) => fs.stat(target));
  try {
    const info = await stat(filePath);
    if (info && Number(info.size) > MAX_FILE_BYTES) {
      return unavailableForgeHealth("invalid", "too_large");
    }
    return parseForgeHealth(await readFile(filePath), options);
  } catch (error) {
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      return unavailableForgeHealth("missing", "not_found");
    }
    return unavailableForgeHealth("unreadable", "unreadable", { errorCode: textOrNull(error?.code, 40) });
  }
}

// GPU temperature from a fresh Forge file, in the same shape the embedded
// Windows hardware reader uses for `gpu.core`. Null when stale or unmeasured.
function getForgeGpuTemperature(forgeHealth) {
  if (!forgeHealth?.fresh || !Number.isFinite(forgeHealth.thermals?.gpuC)) return null;
  const celsius = forgeHealth.thermals.gpuC;
  if (celsius < 1 || celsius > 125) return null;
  return {
    temperatureCelsius: Math.round(celsius * 10) / 10,
    sensorName: "GPU",
    source: FORGE_SOURCE,
    provider: FORGE_SOURCE,
    timestamp: forgeHealth.generatedAt,
    status: "available",
  };
}

// On Windows the embedded sensor reader often cannot see the GPU; a fresh
// Forge reading fills only a missing GPU core value and never replaces one.
function mergeForgeGpuTemperature(gpu, forgeHealth, platform = process.platform) {
  if (platform !== "win32" || Number.isFinite(gpu?.core?.temperatureCelsius)) {
    return gpu || null;
  }
  const forgeGpu = getForgeGpuTemperature(forgeHealth);
  if (!forgeGpu) {
    return gpu || null;
  }
  return { ...(gpu || {}), core: forgeGpu, hotspot: gpu?.hotspot || null };
}

function createCachedForgeHealthReader(options = {}) {
  const reader = options.reader || readForgeHealth;
  const cacheMs = Number.isFinite(options.cacheMs) ? options.cacheMs : DEFAULT_CACHE_MS;
  const clock = options.now || Date.now;
  let cache = null;
  return async function readCachedForgeHealth() {
    const now = clock();
    if (cache && now - cache.at < cacheMs) {
      return cache.health;
    }
    let health;
    try {
      health = await reader();
    } catch {
      // readForgeHealth already maps file errors; this guards a replaced
      // reader so a Forge problem can never break a system snapshot.
      health = unavailableForgeHealth("unreadable", "reader_failed");
    }
    cache = { at: now, health };
    return health;
  };
}

module.exports = {
  DEFAULT_CACHE_MS,
  DEFAULT_STALE_AFTER_SECONDS,
  FORGE_HEALTH_SCHEMA_PREFIX,
  FORGE_SOURCE,
  MAX_ALERTS,
  MAX_FILE_BYTES,
  createCachedForgeHealthReader,
  getForgeGpuTemperature,
  mergeForgeGpuTemperature,
  parseForgeHealth,
  readForgeHealth,
  resolveForgeHealthPath,
};
