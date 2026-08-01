const { execFile } = require("child_process");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const agentClient = require("./agentClient");
const { getExecutionTarget, getSelectedNodeId } = require("./nodeService");
const { readWindowsHardwareTemperature } = require("../shared/windowsHardwareTemperature");

let previousCpuSample = readCpuSample();
let previousNetworkSample = null;
let localTemperatureUnavailableReason = null;
const loggedAgentMetricWarnings = new Set();
const EXPECTED_AGENT_SYSTEM_ERROR_CODES = new Set([
  "UNAUTHORIZED",
  "AUTHENTICATION_FAILED",
  "AGENT_UNAVAILABLE",
  "ECONNREFUSED",
  "TIMEOUT",
  "NETWORK_ERROR",
  "NODE_DISABLED",
  "NODE_NOT_FOUND",
  "NODE_REQUIRED",
  "AGENT_INCOMPATIBLE",
]);

function exec(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 2500, windowsHide: true, ...options }, (error, stdout) => {
      if (error) {
        resolve("");
        return;
      }

      resolve(stdout.trim());
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

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function findValue(source, keys = []) {
  if (!source || typeof source !== "object") {
    return undefined;
  }

  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) {
      return source[key];
    }
  }

  return undefined;
}

function normalizePercent(value) {
  const number = safeNumber(value);
  if (number === null) {
    return null;
  }
  if (number >= 0 && number <= 1) {
    return round(number * 100);
  }
  return round(number);
}

function normalizeDiskMetric(snapshot = {}) {
  const source = snapshot.disk || snapshot.storage || snapshot.filesystem || snapshot.fs || snapshot.rootDisk || null;
  if (!source || typeof source !== "object") {
    return null;
  }

  const total = safeNumber(findValue(source, ["total", "totalBytes", "totalSpace", "totalSpaceBytes", "size", "sizeBytes", "blocksTotalBytes"]));
  const free = safeNumber(findValue(source, ["free", "freeBytes", "freeSpace", "freeSpaceBytes", "available", "availableBytes", "avail", "availBytes"]));
  const usedRaw = safeNumber(findValue(source, ["used", "usedBytes", "usedSpace", "usedSpaceBytes"]));
  const used = usedRaw ?? (total !== null && free !== null ? Math.max(total - free, 0) : null);
  const percent = normalizePercent(findValue(source, ["percent", "usagePercent", "usedPercent", "pct"]));
  const mount = findValue(source, ["mount", "mountPoint", "path", "target", "filesystem"]) || null;

  if (total === null || total <= 0 || free === null || used === null) {
    return null;
  }

  return {
    mount,
    total,
    used,
    free,
    percent: percent ?? round((used / total) * 100),
  };
}

function isExpectedAgentSystemError(error = {}) {
  const code = String(error.code || error.payload?.error?.code || "").toUpperCase();
  return error.status === 401 || error.statusCode === 401 || EXPECTED_AGENT_SYSTEM_ERROR_CODES.has(code);
}

function normalizeNetworkMetric(snapshot = {}) {
  const source = snapshot.network || snapshot.net || snapshot.networkIo || snapshot.networkIO || null;
  if (!source || typeof source !== "object") {
    return null;
  }

  const totalDownload = safeNumber(findValue(source, [
    "totalDownload",
    "download",
    "rx",
    "rxBytes",
    "received",
    "receivedBytes",
    "totalReceived",
    "totalDownloaded",
    "totalRx",
  ]));
  const totalUpload = safeNumber(findValue(source, [
    "totalUpload",
    "upload",
    "tx",
    "txBytes",
    "sent",
    "sentBytes",
    "totalSent",
    "totalUploaded",
    "totalTx",
  ]));
  const downloadPerSecond = safeNumber(findValue(source, [
    "downloadPerSecond",
    "rxPerSecond",
    "rxBytesPerSecond",
    "receivedPerSecond",
    "downloadRate",
  ]));
  const uploadPerSecond = safeNumber(findValue(source, [
    "uploadPerSecond",
    "txPerSecond",
    "txBytesPerSecond",
    "sentPerSecond",
    "uploadRate",
  ]));

  if (totalDownload === null && totalUpload === null && downloadPerSecond === null && uploadPerSecond === null) {
    return null;
  }

  return {
    downloadPerSecond: downloadPerSecond ?? 0,
    uploadPerSecond: uploadPerSecond ?? 0,
    totalDownload,
    totalUpload,
  };
}

function normalizeCpuTemperature(snapshot = {}) {
  return safeNumber(findValue(snapshot, ["cpuTempC", "temperatureCelsius", "cpuTemperatureCelsius"]))
    ?? safeNumber(findValue(snapshot.cpu, ["temperatureCelsius", "cpuTempC", "tempC", "temperature"]));
}

function normalizeAgentSystemSnapshot(snapshot = {}, configOverride = null) {
  const disk = normalizeDiskMetric(snapshot);
  const network = normalizeNetworkMetric(snapshot);
  const cpuTempC = normalizeCpuTemperature(snapshot);
  const agentConfig = configOverride || agentClient.getAgentConfig();
  const agentUrl = agentConfig.agentUrl || agentConfig.url || null;

  if (!disk && !loggedAgentMetricWarnings.has(`${agentUrl || "default"}:disk`)) {
    loggedAgentMetricWarnings.add(`${agentUrl || "default"}:disk`);
    console.warn("[AnxOS][System] Agent disk metrics unavailable or incomplete.", {
      nodeUrl: agentUrl,
      hasDiskPayload: Boolean(snapshot?.disk || snapshot?.storage || snapshot?.filesystem || snapshot?.fs || snapshot?.rootDisk),
      diskKeys: snapshot?.disk && typeof snapshot.disk === "object" ? Object.keys(snapshot.disk) : [],
    });
  }

  if (!network && !loggedAgentMetricWarnings.has(`${agentUrl || "default"}:network`)) {
    loggedAgentMetricWarnings.add(`${agentUrl || "default"}:network`);
    console.warn("[AnxOS][System] Agent network metrics unavailable or incomplete.", {
      nodeUrl: agentUrl,
      hasNetworkPayload: Boolean(snapshot?.network || snapshot?.net || snapshot?.networkIo || snapshot?.networkIO),
      networkKeys: snapshot?.network && typeof snapshot.network === "object" ? Object.keys(snapshot.network) : [],
    });
  }

  return {
    ...snapshot,
    cpu: {
      ...(snapshot?.cpu && typeof snapshot.cpu === "object" ? snapshot.cpu : {}),
      temperatureCelsius: cpuTempC,
    },
    cpuTempC,
    disk,
    network,
    source: snapshot?.source || "agent",
    diagnostics: {
      ...(snapshot?.diagnostics && typeof snapshot.diagnostics === "object" ? snapshot.diagnostics : {}),
      agent: {
        url: agentUrl,
      },
    },
  };
}

function readCpuSample() {
  const cpus = os.cpus();
  const totals = cpus.reduce(
    (acc, cpu) => {
      const times = cpu.times;
      acc.idle += times.idle;
      acc.total += times.user + times.nice + times.sys + times.idle + times.irq;
      return acc;
    },
    { idle: 0, total: 0 },
  );

  return totals;
}

function getCpuUsage() {
  const nextSample = readCpuSample();
  const idleDelta = nextSample.idle - previousCpuSample.idle;
  const totalDelta = nextSample.total - previousCpuSample.total;
  previousCpuSample = nextSample;

  if (totalDelta <= 0) {
    return null;
  }

  return round((1 - idleDelta / totalDelta) * 100);
}

async function getOsVersion() {
  if (process.platform === "linux") {
    try {
      const osRelease = await fs.readFile("/etc/os-release", "utf8");
      const prettyName = osRelease
        .split("\n")
        .find((line) => line.startsWith("PRETTY_NAME="));

      if (prettyName) {
        return prettyName.replace("PRETTY_NAME=", "").replace(/^"|"$/g, "");
      }
    } catch {
      return `${os.type()} ${os.release()}`;
    }
  }

  return `${os.type()} ${os.release()}`;
}

async function getDiskUsage() {
  if (process.platform === "win32") {
    const driveRoot = path.parse(process.cwd()).root.replace("\\", "");
    const output = await exec("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${driveRoot}'" | Select-Object Size,FreeSpace | ConvertTo-Json -Compress`,
    ]);

    try {
      const disk = JSON.parse(output);
      const total = Number(disk.Size);
      const free = Number(disk.FreeSpace);
      return buildDiskUsage(total, free, driveRoot);
    } catch {
      return null;
    }
  }

  const output = await exec("df", ["-k", "/"]);
  const lines = output.split("\n");
  const parts = lines[1]?.trim().split(/\s+/);

  if (!parts || parts.length < 5) {
    return null;
  }

  const total = Number(parts[1]) * 1024;
  const used = Number(parts[2]) * 1024;
  const free = total - used;
  return buildDiskUsage(total, free, parts[5] || "/");
}

function buildDiskUsage(total, free, mount) {
  if (!total || !Number.isFinite(total) || !Number.isFinite(free)) {
    return null;
  }

  const used = total - free;
  return {
    mount,
    total,
    used,
    free,
    percent: round((used / total) * 100),
  };
}

async function getLinuxNetworkTotals() {
  try {
    const content = await fs.readFile("/proc/net/dev", "utf8");
    return content
      .split("\n")
      .slice(2)
      .map((line) => line.trim())
      .filter(Boolean)
      .reduce(
        (acc, line) => {
          const [namePart, dataPart] = line.split(":");
          const name = namePart.trim();
          if (name === "lo" || !dataPart) {
            return acc;
          }

          const values = dataPart.trim().split(/\s+/).map(Number);
          acc.download += values[0] || 0;
          acc.upload += values[8] || 0;
          return acc;
        },
        { upload: 0, download: 0 },
      );
  } catch {
    return null;
  }
}

async function getWindowsNetworkTotals() {
  const output = await exec("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    "Get-NetAdapterStatistics | Select-Object ReceivedBytes,SentBytes | ConvertTo-Json -Compress",
  ]);

  try {
    const rows = JSON.parse(output);
    const adapters = Array.isArray(rows) ? rows : [rows];
    return adapters.reduce(
      (acc, adapter) => {
        acc.download += Number(adapter.ReceivedBytes) || 0;
        acc.upload += Number(adapter.SentBytes) || 0;
        return acc;
      },
      { upload: 0, download: 0 },
    );
  } catch {
    return null;
  }
}

async function getNetworkUsage() {
  const totals = process.platform === "win32" ? await getWindowsNetworkTotals() : await getLinuxNetworkTotals();
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

async function getCpuTemperature() {
  if (process.platform === "win32") {
    return readWindowsHardwareTemperature();
  }
  if (process.platform !== "linux") {
    return null;
  }

  try {
    const zones = await fs.readdir("/sys/class/thermal");
    for (const zone of zones.filter((name) => name.startsWith("thermal_zone"))) {
      const tempPath = `/sys/class/thermal/${zone}/temp`;
      const raw = await fs.readFile(tempPath, "utf8");
      const value = Number(raw.trim());
      if (Number.isFinite(value) && value > 0) {
        return round(value > 1000 ? value / 1000 : value);
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function getLocalSystemSnapshot() {
  const [osVersion, disk, network, localCpuTemperature] = await Promise.all([
    getOsVersion(),
    getDiskUsage(),
    getNetworkUsage(),
    getCpuTemperature(),
  ]);

  let cpuTemperature = localCpuTemperature;
  if (process.platform === "win32" && (!localCpuTemperature || localCpuTemperature.available !== true)) {
    try {
      const privilegedSnapshot = await agentClient.getSystemStats();
      const privilegedTemperature = normalizeCpuTemperature(privilegedSnapshot);
      if (Number.isFinite(privilegedTemperature)) {
        cpuTemperature = {
          available: true,
          source: privilegedSnapshot?.cpu?.temperatureSource || privilegedSnapshot?.temperatureSource || "Elevated AnxOS Agent",
          timestamp: privilegedSnapshot?.cpu?.temperatureTimestamp || privilegedSnapshot?.temperatureTimestamp || new Date().toISOString(),
          cpu: {
            temperatureCelsius: privilegedTemperature,
            sensorName: privilegedSnapshot?.cpu?.temperatureSensor || privilegedSnapshot?.temperatureSensor || "CPU Package",
          },
          gpu: null,
        };
      }
    } catch (error) {
      console.warn("[AnxOS][System] Elevated Agent temperature unavailable.", { code: error?.code || "AGENT_UNAVAILABLE" });
    }
  }

  const windowsTemperature = process.platform === "win32" && cpuTemperature && typeof cpuTemperature === "object"
    ? cpuTemperature
    : null;
  if (windowsTemperature && !windowsTemperature.available && localTemperatureUnavailableReason !== windowsTemperature.reason) {
    localTemperatureUnavailableReason = windowsTemperature.reason;
    console.warn("[AnxOS][System] Embedded Windows CPU temperature unavailable.", {
      provider: windowsTemperature.source,
      reason: windowsTemperature.reason,
    });
  }
  const cpuTemperatureCelsius = windowsTemperature?.available
    ? windowsTemperature.cpu?.temperatureCelsius ?? null
    : cpuTemperature;
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;

  return {
    currentTime: new Date().toISOString(),
    hostname: os.hostname(),
    osVersion,
    platform: process.platform,
    cpu: {
      model: os.cpus()[0]?.model || "Unknown CPU",
      cores: os.cpus().length,
      usagePercent: getCpuUsage(),
      temperatureCelsius: cpuTemperatureCelsius,
      temperatureAvailable: windowsTemperature ? windowsTemperature.available === true : Number.isFinite(cpuTemperatureCelsius),
      temperatureValid: windowsTemperature ? windowsTemperature.available === true : Number.isFinite(cpuTemperatureCelsius),
      temperatureSource: windowsTemperature?.source || (Number.isFinite(cpuTemperatureCelsius) ? "linux-sysfs" : null),
      temperatureSensor: windowsTemperature?.cpu?.sensorName || null,
      temperatureTimestamp: windowsTemperature?.timestamp || null,
      temperatureReason: windowsTemperature?.reason || null,
    },
    cpuTempC: cpuTemperatureCelsius,
    temperatureAvailable: windowsTemperature ? windowsTemperature.available === true : Number.isFinite(cpuTemperatureCelsius),
    temperatureValid: windowsTemperature ? windowsTemperature.available === true : Number.isFinite(cpuTemperatureCelsius),
    temperatureSource: windowsTemperature?.source || (Number.isFinite(cpuTemperatureCelsius) ? "linux-sysfs" : null),
    temperatureSensor: windowsTemperature?.cpu?.sensorName || null,
    temperatureTimestamp: windowsTemperature?.timestamp || null,
    temperatureReason: windowsTemperature?.reason || null,
    gpu: windowsTemperature?.gpu ? {
      core: windowsTemperature.gpu.core ? {
        temperatureCelsius: windowsTemperature.gpu.core.temperatureCelsius,
        temperatureSource: windowsTemperature.gpu.core.source,
        temperatureSensor: windowsTemperature.gpu.core.sensorName,
        temperatureTimestamp: windowsTemperature.timestamp,
      } : null,
      hotspot: windowsTemperature.gpu.hotspot ? {
        temperatureCelsius: windowsTemperature.gpu.hotspot.temperatureCelsius,
        temperatureSource: windowsTemperature.gpu.hotspot.source,
        temperatureSensor: windowsTemperature.gpu.hotspot.sensorName,
        temperatureTimestamp: windowsTemperature.timestamp,
      } : null,
    } : null,
    memory: {
      total: totalMemory,
      used: usedMemory,
      free: freeMemory,
      percent: round((usedMemory / totalMemory) * 100),
    },
    disk,
    network,
    uptimeSeconds: os.uptime(),
    source: "local",
  };
}

async function getAgentSystemSnapshot(nodeId, configOverride = null) {
  const nodeAgent = agentClient.forNode(nodeId);
  let snapshot;
  try {
    snapshot = await nodeAgent.get("/stats");
  } catch (error) {
    if (!agentClient.isCompatibilityFallbackAllowed(error)) {
      throw error;
    }
    console.warn("[AnxOS][Agent] Stats endpoint unavailable; falling back to system summary.", {
      nodeId,
      message: error?.message || String(error),
      code: error?.code || null,
    });
    snapshot = await nodeAgent.get("/system/summary");
  }
  return normalizeAgentSystemSnapshot(snapshot, configOverride);
}

async function getSystemSnapshot(options = {}) {
  const target = getExecutionTarget(options?.nodeId || getSelectedNodeId());
  const nodeConfig = target.type === "agent" ? target.config : null;

  if (nodeConfig) {
    try {
      return await getAgentSystemSnapshot(target.nodeId, nodeConfig);
    } catch (error) {
      const details = {
        nodeId: target.nodeId,
        nodeUrl: nodeConfig.agentUrl || nodeConfig.url || null,
        code: error?.code || error?.payload?.error?.code || null,
        status: error?.status || error?.statusCode || null,
        message: error?.message || String(error),
      };
      if (isExpectedAgentSystemError(error)) {
        console.warn("[AnxOS][System] Expected selected node stats failure.", details);
      } else {
        console.error("[AnxOS][System] Selected node stats fetch failed.", {
          ...details,
          stack: error?.stack || null,
        });
      }
      throw error;
    }
  }

  return getLocalSystemSnapshot();
}

module.exports = {
  _test: {
    normalizeAgentSystemSnapshot,
    normalizeDiskMetric,
    normalizeNetworkMetric,
    normalizeCpuTemperature,
  },
  getSystemSnapshot,
};
