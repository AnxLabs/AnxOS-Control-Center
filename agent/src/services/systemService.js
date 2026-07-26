const childProcess = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");

const { getConfig } = require("../config");
const { logger } = require("./diagnosticsLogger");
const { readWindowsHardwareTemperature } = require("../../../src/shared/windowsHardwareTemperature");
let windowsHardwareTemperatureReader = readWindowsHardwareTemperature;

let previousCpuSample = readCpuSample();
let previousNetworkSample = null;
const DISK_STATS_UNAVAILABLE = "DISK_STATS_UNAVAILABLE";
const diskStatsWarningState = new Map();
const DISK_STATS_WARNING_REPEAT_INTERVAL_MS = 5 * 60 * 1000;
const WINDOWS_CPU_TEMP_UNAVAILABLE = "WINDOWS_CPU_TEMP_UNAVAILABLE";
const WINDOWS_CPU_TEMP_PROVIDER_FAILED = "WINDOWS_CPU_TEMP_PROVIDER_FAILED";
const WINDOWS_CPU_TEMP_INVALID = "WINDOWS_CPU_TEMP_INVALID";
const CPU_TEMP_WARNING_REPEAT_INTERVAL_MS = 5 * 60 * 1000;
const CPU_TEMP_CACHE_MS = 30 * 1000;
const cpuTempWarningState = new Map();
let cpuTemperatureCache = null;
let cpuTemperatureExecFile = execFile;

function execFile(command, args, options = {}) {
  return new Promise((resolve) => {
    childProcess.execFile(command, args, {
      timeout: options.timeout || 2500,
      maxBuffer: options.maxBuffer || 256 * 1024,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout || "",
        stderr: stderr || "",
      });
    });
  });
}

function round(value, decimals = 1) {
  if (!Number.isFinite(value)) {
    return null;
  }

  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

async function readOsVersion() {
  if (process.platform !== "linux") {
    return `${os.type()} ${os.release()}`;
  }

  try {
    const content = await fs.readFile("/etc/os-release", "utf8");
    const prettyName = content
      .split("\n")
      .find((line) => line.startsWith("PRETTY_NAME="));

    if (prettyName) {
      return prettyName.replace("PRETTY_NAME=", "").replace(/^"|"$/g, "");
    }
  } catch {
    return `${os.type()} ${os.release()}`;
  }

  return `${os.type()} ${os.release()}`;
}

function readCpuSample() {
  const cpus = os.cpus();
  return cpus.reduce((acc, cpu) => {
    const times = cpu.times;
    acc.idle += times.idle;
    acc.total += times.user + times.nice + times.sys + times.idle + times.irq;
    return acc;
  }, { idle: 0, total: 0 });
}

function getCpuUsagePercent() {
  const nextSample = readCpuSample();
  const idleDelta = nextSample.idle - previousCpuSample.idle;
  const totalDelta = nextSample.total - previousCpuSample.total;
  previousCpuSample = nextSample;

  if (totalDelta <= 0) {
    return null;
  }

  return round((1 - idleDelta / totalDelta) * 100);
}

function buildDiskUsage(total, free, mount) {
  if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) {
    return null;
  }

  const used = Math.max(total - free, 0);
  return {
    mount: mount || null,
    total,
    used,
    free,
    percent: round((used / total) * 100),
  };
}

function emitCpuTemperatureWarning(code, reason, details = {}) {
  const key = `${code}:${process.platform}:${reason}`;
  const now = Date.now();
  const previous = cpuTempWarningState.get(key) || { count: 0, lastEmittedAt: 0 };
  const next = { count: previous.count + 1, lastEmittedAt: previous.lastEmittedAt };
  const shouldEmit = !previous.lastEmittedAt || now - previous.lastEmittedAt >= CPU_TEMP_WARNING_REPEAT_INTERVAL_MS;
  if (shouldEmit) {
    next.lastEmittedAt = now;
    logger.warn("system-stats", "Agent CPU temperature unavailable.", {
      code,
      reason,
      suppressedCount: Math.max(next.count - 1, 0),
      platform: process.platform,
      provider: details.provider || null,
      sensor: details.sensor || null,
      message: details.message || null,
    }, { file: "agent", errorCode: code });
    next.count = 0;
  }
  cpuTempWarningState.set(key, next);
}

function createTemperatureReading(value, metadata = {}) {
  const number = Number(value);
  const source = metadata.source || null;
  const sensor = metadata.sensor || null;

  if (!Number.isFinite(number) || number <= 0 || number > 125) {
    return {
      temperatureCelsius: null,
      temperatureAvailable: false,
      temperatureValid: false,
      temperatureSource: source,
      temperatureSensor: sensor,
      temperatureReason: "invalid",
    };
  }

  return {
    temperatureCelsius: round(number),
    temperatureAvailable: true,
    temperatureValid: true,
    temperatureSource: source,
    temperatureSensor: sensor,
  };
}

function createUnavailableTemperatureReading(reason, metadata = {}) {
  return {
    temperatureCelsius: null,
    temperatureAvailable: false,
    temperatureValid: false,
    temperatureSource: metadata.source || null,
    temperatureSensor: metadata.sensor || null,
    temperatureReason: reason,
  };
}

function isWindowsPlatform(platform = process.platform) {
  return platform === "win32";
}

function normalizeDiskPath(targetPath, platform = process.platform) {
  const fallbackPath = targetPath || getConfig().instanceRoot || process.cwd();
  if (isWindowsPlatform(platform)) {
    const rawPath = String(fallbackPath).replace(/\//g, "\\");
    return /^[a-zA-Z]:\\|^\\\\/.test(rawPath) ? path.win32.normalize(rawPath) : path.win32.resolve(rawPath);
  }
  return path.resolve(fallbackPath);
}

function resolveDiskRoot(targetPath, platform = process.platform) {
  const resolvedPath = normalizeDiskPath(targetPath, platform);
  if (isWindowsPlatform(platform)) {
    return path.win32.parse(resolvedPath).root || resolvedPath;
  }
  return path.parse(resolvedPath).root || resolvedPath;
}

function emitDiskStatsWarning(reason, details = {}) {
  const key = `${DISK_STATS_UNAVAILABLE}:${process.platform}:${reason}`;
  const now = Date.now();
  const previous = diskStatsWarningState.get(key) || { count: 0, lastEmittedAt: 0 };
  const next = { count: previous.count + 1, lastEmittedAt: previous.lastEmittedAt };
  const shouldEmit = !previous.lastEmittedAt || now - previous.lastEmittedAt >= DISK_STATS_WARNING_REPEAT_INTERVAL_MS;
  if (shouldEmit) {
    next.lastEmittedAt = now;
    logger.warn("disk-stats", "Agent disk statistics unavailable.", {
      code: DISK_STATS_UNAVAILABLE,
      reason,
      suppressedCount: Math.max(next.count - 1, 0),
      platform: process.platform,
      path: details.path || null,
      mount: details.mount || null,
      message: details.message || null,
      stderr: details.stderr || null,
    }, { file: "agent", errorCode: DISK_STATS_UNAVAILABLE });
    next.count = 0;
  }
  diskStatsWarningState.set(key, next);
}

async function readStatfsDiskUsage(statPath, mountPath) {
  if (typeof fs.statfs !== "function") {
    return null;
  }
  const stats = await fs.statfs(statPath);
  const blockSize = Number(stats.bsize || stats.frsize || 0);
  const total = Number(stats.blocks) * blockSize;
  const free = Number(stats.bavail ?? stats.bfree) * blockSize;
  return buildDiskUsage(total, free, mountPath || statPath);
}

async function getDiskMountPoint(targetPath, platform = process.platform) {
  if (isWindowsPlatform(platform)) {
    return resolveDiskRoot(targetPath, platform);
  }

  const result = await execFile("df", ["-kP", targetPath]);
  if (!result.ok) {
    emitDiskStatsWarning("df_mount_lookup_failed", {
      path: targetPath,
      stderr: result.stderr.trim(),
    });
    return null;
  }

  const parts = result.stdout.split(/\r?\n/)[1]?.trim().split(/\s+/);
  return parts && parts.length >= 6 ? parts[5] : null;
}

async function getDiskUsage(targetPath = getConfig().instanceRoot) {
  if (isWindowsPlatform()) {
    const resolvedPath = normalizeDiskPath(targetPath);
    const driveRoot = resolveDiskRoot(resolvedPath);
    try {
      return await readStatfsDiskUsage(driveRoot, driveRoot);
    } catch (error) {
      emitDiskStatsWarning("windows_disk_lookup_failed", {
        path: resolvedPath,
        mount: driveRoot,
        message: error?.message || String(error),
      });
      return null;
    }
  }

  let resolvedPath = normalizeDiskPath(targetPath);

  while (resolvedPath && !(await fs.stat(resolvedPath).then(() => true).catch(() => false))) {
    const parentPath = path.dirname(resolvedPath);
    if (parentPath === resolvedPath) {
      break;
    }
    resolvedPath = parentPath;
  }

  try {
    const mount = await getDiskMountPoint(resolvedPath) || resolvedPath;
    const statfsUsage = await readStatfsDiskUsage(resolvedPath, mount);
    if (statfsUsage) {
      return statfsUsage;
    }
  } catch (error) {
    emitDiskStatsWarning("statfs_disk_read_failed", {
      path: resolvedPath,
      message: error?.message || String(error),
    });
  }

  const result = await execFile("df", ["-kP", resolvedPath]);
  if (!result.ok) {
    emitDiskStatsWarning("df_disk_read_failed", {
      path: resolvedPath,
      stderr: result.stderr.trim(),
    });
    return null;
  }

  const parts = result.stdout.split(/\r?\n/)[1]?.trim().split(/\s+/);
  if (!parts || parts.length < 6) {
    return null;
  }

  return buildDiskUsage(Number(parts[1]) * 1024, Number(parts[3]) * 1024, parts[5]);
}

async function getLinuxNetworkTotals() {
  try {
    const content = await fs.readFile("/proc/net/dev", "utf8");
    return content
      .split(/\r?\n/)
      .slice(2)
      .map((line) => line.trim())
      .filter(Boolean)
      .reduce((acc, line) => {
        const [namePart, dataPart] = line.split(":");
        const name = String(namePart || "").trim();
        if (!dataPart || name === "lo") {
          return acc;
        }
        const values = dataPart.trim().split(/\s+/).map(Number);
        acc.download += values[0] || 0;
        acc.upload += values[8] || 0;
        return acc;
      }, { download: 0, upload: 0 });
  } catch (error) {
    console.warn("[AnxOS Agent][Stats] Network counters unavailable.", {
      message: error?.message || String(error),
    });
    return null;
  }
}

async function getNetworkUsage() {
  if (process.platform !== "linux") {
    return {
      uploadPerSecond: 0,
      downloadPerSecond: 0,
      totalUpload: null,
      totalDownload: null,
      supported: false,
      reason: "unsupported_platform",
    };
  }

  const totals = await getLinuxNetworkTotals();
  const now = Date.now();

  if (!totals) {
    return null;
  }

  const current = { ...totals, at: now };

  if (!previousNetworkSample) {
    previousNetworkSample = current;
    return {
      uploadPerSecond: 0,
      downloadPerSecond: 0,
      totalUpload: totals.upload,
      totalDownload: totals.download,
    };
  }

  const seconds = Math.max((now - previousNetworkSample.at) / 1000, 0.001);
  const uploadPerSecond = Math.max((current.upload - previousNetworkSample.upload) / seconds, 0);
  const downloadPerSecond = Math.max((current.download - previousNetworkSample.download) / seconds, 0);
  previousNetworkSample = current;

  return {
    uploadPerSecond: round(uploadPerSecond, 0),
    downloadPerSecond: round(downloadPerSecond, 0),
    totalUpload: totals.upload,
    totalDownload: totals.download,
  };
}

function normalizeThermalLabel(value) {
  return String(value || "").trim().toLowerCase();
}

function getThermalZoneScore(label, zoneName) {
  const text = `${normalizeThermalLabel(label)} ${normalizeThermalLabel(zoneName)}`;

  if (/\b(package|pkg|cpu|core|k10temp|x86_pkg_temp|tctl|tdie)\b/.test(text)) {
    return 100;
  }

  if (/\bthermal|temp\b/.test(text)) {
    return 25;
  }

  return 0;
}

function normalizeSensorText(value) {
  return String(value || "").trim().toLowerCase();
}

function isRejectedTemperatureSensor(sensor = {}) {
  const text = [
    sensor.Name,
    sensor.Identifier,
    sensor.Parent,
    sensor.SensorType,
  ].map(normalizeSensorText).join(" ");
  return /\b(gpu|graphics|video|ssd|hdd|disk|nvme|battery|mainboard|motherboard|ambient|acpi|thermal zone)\b/.test(text);
}

function scoreWindowsCpuTemperatureSensor(sensor = {}) {
  const text = [
    sensor.Name,
    sensor.Identifier,
    sensor.Parent,
  ].map(normalizeSensorText).join(" ");

  if (!/\b(cpu|processor|package|core)\b/.test(text)) {
    return 0;
  }

  let score = 20;
  if (/\b(cpu package|package|pkg)\b/.test(text)) score += 90;
  if (/\b(cpu)\b/.test(text)) score += 40;
  if (/\b(core)\b/.test(text)) score += 20;
  if (/\bmax|average|avg\b/.test(text)) score += 5;
  return score;
}

function normalizeWindowsSensorRows(stdout) {
  if (!stdout || !String(stdout).trim()) {
    return [];
  }
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

async function queryWindowsHardwareTemperatureNamespace(namespace) {
  const script = [
    `$ErrorActionPreference = 'Stop';`,
    `Get-CimInstance -Namespace '${namespace}' -ClassName Sensor -Filter "SensorType='Temperature'"`,
    `| Select-Object Name,Identifier,Parent,SensorType,Value`,
    `| ConvertTo-Json -Compress`,
  ].join(" ");
  return cpuTemperatureExecFile("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ], { timeout: 5000, maxBuffer: 256 * 1024 });
}

async function readWindowsCpuTemperatureReading() {
  const namespaces = ["root\\LibreHardwareMonitor", "root\\OpenHardwareMonitor"];
  let sawProvider = false;
  let invalidSensorCount = 0;
  const providerErrors = [];

  for (const namespace of namespaces) {
    const result = await queryWindowsHardwareTemperatureNamespace(namespace);
    if (!result.ok) {
      providerErrors.push(result.stderr.trim() || "provider unavailable");
      continue;
    }

    sawProvider = true;
    let rows = [];
    try {
      rows = normalizeWindowsSensorRows(result.stdout);
    } catch (error) {
      emitCpuTemperatureWarning(WINDOWS_CPU_TEMP_PROVIDER_FAILED, "windows_sensor_json_parse_failed", {
        provider: namespace,
        message: error?.message || String(error),
      });
      continue;
    }

    const candidates = rows
      .filter((sensor) => normalizeSensorText(sensor?.SensorType) === "temperature")
      .map((sensor) => ({
        ...sensor,
        numericValue: Number(sensor?.Value),
        score: scoreWindowsCpuTemperatureSensor(sensor),
      }))
      .filter((sensor) => {
        if (isRejectedTemperatureSensor(sensor) || sensor.score <= 0) {
          return false;
        }
        if (!Number.isFinite(sensor.numericValue) || sensor.numericValue <= 0 || sensor.numericValue > 125) {
          invalidSensorCount += 1;
          return false;
        }
        return true;
      })
      .sort((a, b) => b.score - a.score || b.numericValue - a.numericValue);

    if (candidates[0]) {
      return createTemperatureReading(candidates[0].numericValue, {
        source: namespace,
        sensor: candidates[0].Name || candidates[0].Identifier || "CPU temperature",
      });
    }
  }

  if (invalidSensorCount) {
    emitCpuTemperatureWarning(WINDOWS_CPU_TEMP_INVALID, "windows_cpu_temperature_invalid", {
      provider: sawProvider ? "hardware-monitor" : null,
      message: `${invalidSensorCount} CPU-like temperature sensor value${invalidSensorCount === 1 ? "" : "s"} were invalid.`,
    });
    return createUnavailableTemperatureReading("invalid", { source: "windows-hardware-monitor" });
  }

  emitCpuTemperatureWarning(
    sawProvider ? WINDOWS_CPU_TEMP_UNAVAILABLE : WINDOWS_CPU_TEMP_PROVIDER_FAILED,
    sawProvider ? "windows_cpu_temperature_not_reported" : "windows_cpu_temperature_provider_unavailable",
    {
      provider: "LibreHardwareMonitor/OpenHardwareMonitor",
      message: providerErrors.filter(Boolean).slice(0, 2).join("; ") || null,
    },
  );
  return createUnavailableTemperatureReading(sawProvider ? "not_reported" : "provider_unavailable", {
    source: "windows-hardware-monitor",
  });
}

async function readThermalZone(zoneName) {
  const zonePath = path.join("/sys/class/thermal", zoneName);

  try {
    const [rawTemp, rawLabel] = await Promise.all([
      fs.readFile(path.join(zonePath, "temp"), "utf8"),
      fs.readFile(path.join(zonePath, "type"), "utf8").catch(() => ""),
    ]);
    const value = Number(String(rawTemp).trim());

    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }

    const celsius = value > 1000 ? value / 1000 : value;

    return {
      zone: zoneName,
      label: String(rawLabel || "").trim() || zoneName,
      celsius: round(celsius),
      score: getThermalZoneScore(rawLabel, zoneName),
    };
  } catch {
    return null;
  }
}

async function getCpuTemperature() {
  if (process.platform === "win32") {
    const now = Date.now();
    if (cpuTemperatureCache && now - cpuTemperatureCache.at < CPU_TEMP_CACHE_MS) {
      return cpuTemperatureCache.reading;
    }
    const hardware = await windowsHardwareTemperatureReader();
    if (!hardware.available) {
      emitCpuTemperatureWarning(WINDOWS_CPU_TEMP_UNAVAILABLE, hardware.reason || "windows_cpu_temperature_unavailable", {
        provider: hardware.source,
        message: "Embedded Windows CPU temperature provider did not return a trustworthy sensor.",
      });
    }
    const reading = hardware.available
      ? {
        ...createTemperatureReading(hardware.cpu.temperatureCelsius, {
          source: hardware.source,
          sensor: hardware.cpu.sensorName,
        }),
        temperatureTimestamp: hardware.timestamp,
        gpuTemperature: hardware.gpu || null,
      }
      : createUnavailableTemperatureReading(hardware.reason || "provider_unavailable", { source: hardware.source });
    cpuTemperatureCache = { at: now, reading };
    return reading;
  }

  if (process.platform !== "linux") {
    return createUnavailableTemperatureReading("unsupported_platform", { source: process.platform });
  }

  try {
    const zones = (await fs.readdir("/sys/class/thermal"))
      .filter((name) => /^thermal_zone\d+$/.test(name));
    const readings = (await Promise.all(zones.map((zone) => readThermalZone(zone))))
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || b.celsius - a.celsius);

    const best = readings[0] || null;
    return best
      ? createTemperatureReading(best.celsius, { source: "linux-sysfs", sensor: best.label || best.zone })
      : createUnavailableTemperatureReading("not_reported", { source: "linux-sysfs" });
  } catch (error) {
    console.warn("[AnxOS Agent][Stats] CPU temperature unavailable.", {
      message: error?.message || String(error),
    });
    return createUnavailableTemperatureReading("provider_failed", { source: "linux-sysfs" });
  }
}

async function getSystemSummary() {
  const [osVersion, disk, network, cpuTemperature] = await Promise.all([
    readOsVersion(),
    getDiskUsage(),
    getNetworkUsage(),
    getCpuTemperature(),
  ]);
  const cpuTemperatureCelsius = cpuTemperature?.temperatureValid ? cpuTemperature.temperatureCelsius : null;
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const cpus = os.cpus();

  return {
    hostname: os.hostname(),
    platform: process.platform,
    osVersion,
    uptimeSeconds: os.uptime(),
    cpu: {
      model: cpus[0]?.model || "Unknown CPU",
      cores: cpus.length,
      usagePercent: getCpuUsagePercent(),
      loadAverage: os.loadavg(),
      temperatureCelsius: cpuTemperatureCelsius,
      temperatureAvailable: cpuTemperature?.temperatureAvailable === true,
      temperatureValid: cpuTemperature?.temperatureValid === true,
      temperatureSource: cpuTemperature?.temperatureSource || null,
      temperatureSensor: cpuTemperature?.temperatureSensor || null,
      temperatureReason: cpuTemperature?.temperatureReason || null,
      temperatureTimestamp: cpuTemperature?.temperatureTimestamp || null,
    },
    cpuTempC: cpuTemperatureCelsius,
    temperatureAvailable: cpuTemperature?.temperatureAvailable === true,
    temperatureValid: cpuTemperature?.temperatureValid === true,
    temperatureSource: cpuTemperature?.temperatureSource || null,
    temperatureSensor: cpuTemperature?.temperatureSensor || null,
    temperatureReason: cpuTemperature?.temperatureReason || null,
    temperatureTimestamp: cpuTemperature?.temperatureTimestamp || null,
    gpu: cpuTemperature?.gpuTemperature || null,
    memory: {
      total: totalMemory,
      used: usedMemory,
      free: freeMemory,
      percent: round((usedMemory / totalMemory) * 100),
    },
    disk,
    network,
    currentTime: new Date().toISOString(),
    source: "agent",
    instanceRoot: getConfig().instanceRoot,
  };
}

module.exports = {
  getSystemSummary,
  _test: {
    DISK_STATS_UNAVAILABLE,
    WINDOWS_CPU_TEMP_INVALID,
    WINDOWS_CPU_TEMP_PROVIDER_FAILED,
    WINDOWS_CPU_TEMP_UNAVAILABLE,
    CPU_TEMP_CACHE_MS,
    diskStatsWarningState,
    cpuTempWarningState,
    emitDiskStatsWarning,
    emitCpuTemperatureWarning,
    createTemperatureReading,
    getDiskMountPoint,
    getDiskUsage,
    getCpuTemperature,
    readWindowsCpuTemperatureReading,
    normalizeDiskPath,
    resolveDiskRoot,
    scoreWindowsCpuTemperatureSensor,
    isRejectedTemperatureSensor,
    setCpuTemperatureExecFileForTest(fn) {
      cpuTemperatureExecFile = fn || execFile;
      windowsHardwareTemperatureReader = readWindowsHardwareTemperature;
      cpuTemperatureCache = null;
      cpuTempWarningState.clear();
    },
    setWindowsHardwareTemperatureReaderForTest(fn) {
      windowsHardwareTemperatureReader = fn || readWindowsHardwareTemperature;
      cpuTemperatureCache = null;
      cpuTempWarningState.clear();
    },
    resetCpuTemperatureCacheForTest() {
      cpuTemperatureCache = null;
    },
  },
};
