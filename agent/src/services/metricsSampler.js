"use strict";

// Rate-based host metrics for the Agent: CPU (total and per core), network
// throughput and NVIDIA GPU usage.
//
// Rules:
//   * Never fabricate. A rate needs two samples, so the first reading (and any
//     platform or tool that cannot measure) reports null with a reason, never 0.
//   * One shared sample per metric. Several clients (two desktops, the
//     dashboard and the Computers page) polling close together used to reset
//     each other's baseline and get rates over a few milliseconds. A sample
//     younger than MIN_SAMPLE_INTERVAL_MS is reused instead of re-measured.
//   * Native, read-only collection: os.cpus(), /proc/net/dev, `netstat -e`,
//     `nvidia-smi --query-gpu`. Nothing is installed or changed.

const childProcess = require("child_process");
const fs = require("fs/promises");
const os = require("os");

const MIN_SAMPLE_INTERVAL_MS = 900;
const GPU_CACHE_MS = 10 * 1000;
const COMMAND_TIMEOUT_MS = 4000;

// A command that cannot even be started (a synchronous spawn error) yields
// { ok: false } like any other failure, so one unreadable metric never takes
// the whole system summary down with it.
function defaultExecFile(command, args) {
  return new Promise((resolve) => {
    try {
      childProcess.execFile(command, args, { timeout: COMMAND_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 }, (error, stdout) => {
        resolve({ ok: !error, code: error?.code || null, stdout: String(stdout || "") });
      });
    } catch (error) {
      resolve({ ok: false, code: error?.code || "SPAWN_FAILED", stdout: "" });
    }
  });
}

function round(value, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// ---------------------------------------------------------------------------
// CPU
// ---------------------------------------------------------------------------

function readCpuTimes(cpus) {
  return cpus.map((cpu) => {
    const times = cpu.times || {};
    const idle = Number(times.idle) || 0;
    const total = idle + (Number(times.user) || 0) + (Number(times.nice) || 0) + (Number(times.sys) || 0) + (Number(times.irq) || 0);
    return { idle, total };
  });
}

function percentBetween(previous, next) {
  const totalDelta = next.total - previous.total;
  const idleDelta = next.idle - previous.idle;
  if (!(totalDelta > 0) || idleDelta < 0) return null;
  return round(Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100)));
}

function createCpuSampler({ readCpus = () => os.cpus(), now = () => Date.now() } = {}) {
  let baseline = { at: now(), cores: readCpuTimes(readCpus()) };
  let last = null;
  return function sampleCpu() {
    const at = now();
    if (last && at - last.at < MIN_SAMPLE_INTERVAL_MS) return last.value;
    const cores = readCpuTimes(readCpus());
    let value;
    if (cores.length !== baseline.cores.length) {
      // CPU hot-plug or a changed affinity: start a new baseline.
      value = { usagePercent: null, perCore: [], reason: "cpu_topology_changed" };
    } else {
      const sum = (list) => list.reduce((acc, core) => ({ idle: acc.idle + core.idle, total: acc.total + core.total }), { idle: 0, total: 0 });
      const perCore = cores.map((core, index) => percentBetween(baseline.cores[index], core));
      const usagePercent = percentBetween(sum(baseline.cores), sum(cores));
      value = usagePercent === null
        ? { usagePercent: null, perCore: [], reason: "warming_up" }
        : { usagePercent, perCore, reason: null };
    }
    baseline = { at, cores };
    last = { at, value };
    return value;
  };
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

function parseProcNetDev(content) {
  return String(content || "")
    .split(/\r?\n/)
    .slice(2)
    .map((line) => line.trim())
    .filter(Boolean)
    .reduce((acc, line) => {
      const [namePart, dataPart] = line.split(":");
      const name = String(namePart || "").trim();
      if (!dataPart || name === "lo") return acc;
      const values = dataPart.trim().split(/\s+/).map(Number);
      acc.download += values[0] || 0;
      acc.upload += values[8] || 0;
      return acc;
    }, { download: 0, upload: 0 });
}

// `netstat -e` prints an "Interface Statistics" table whose "Bytes" row holds
// received and sent totals. The label is localized on some Windows editions,
// so the first data row with two large integers is used.
function parseNetstatE(output) {
  const lines = String(output || "").split(/\r?\n/);
  const bytesLine = lines.find((line) => /^\s*Bytes\s+\d+\s+\d+\s*$/i.test(line))
    || lines.find((line) => /^\s*\S[^\d]*\s+\d{4,}\s+\d{4,}\s*$/.test(line));
  if (!bytesLine) return null;
  const numbers = bytesLine.trim().split(/\s+/).slice(-2).map(Number);
  if (numbers.some((value) => !Number.isFinite(value))) return null;
  return { download: numbers[0], upload: numbers[1] };
}

function createNetworkSampler({
  platform = process.platform,
  readFile = (file) => fs.readFile(file, "utf8"),
  execFile = defaultExecFile,
  now = () => Date.now(),
} = {}) {
  let previous = null;
  let last = null;
  async function readTotals() {
    if (platform === "linux") {
      try {
        return { totals: parseProcNetDev(await readFile("/proc/net/dev")), source: "proc_net_dev" };
      } catch {
        return { totals: null, reason: "counters_unreadable" };
      }
    }
    if (platform === "win32") {
      const result = await execFile("netstat", ["-e"]);
      const totals = result.ok ? parseNetstatE(result.stdout) : null;
      return totals ? { totals, source: "netstat_e" } : { totals: null, reason: "counters_unreadable" };
    }
    return { totals: null, reason: "unsupported_platform" };
  }
  return async function sampleNetwork() {
    const at = now();
    if (last && at - last.at < MIN_SAMPLE_INTERVAL_MS) return last.value;
    const { totals, source, reason } = await readTotals();
    let value;
    if (!totals) {
      value = { supported: reason !== "unsupported_platform", uploadPerSecond: null, downloadPerSecond: null, totalUpload: null, totalDownload: null, reason };
      previous = null;
    } else if (!previous) {
      value = { supported: true, uploadPerSecond: null, downloadPerSecond: null, totalUpload: totals.upload, totalDownload: totals.download, reason: "warming_up", source };
      previous = { ...totals, at };
    } else {
      const seconds = (at - previous.at) / 1000;
      const up = totals.upload - previous.upload;
      const down = totals.download - previous.download;
      // A counter that went backwards wrapped or was reset: no rate this time.
      const wrapped = up < 0 || down < 0;
      value = {
        supported: true,
        uploadPerSecond: wrapped || !(seconds > 0) ? null : round(up / seconds, 0),
        downloadPerSecond: wrapped || !(seconds > 0) ? null : round(down / seconds, 0),
        totalUpload: totals.upload,
        totalDownload: totals.download,
        reason: wrapped ? "counter_reset" : null,
        source,
      };
      previous = { ...totals, at };
    }
    last = { at, value };
    return value;
  };
}

// ---------------------------------------------------------------------------
// GPU (NVIDIA through nvidia-smi; other vendors are reported as unavailable)
// ---------------------------------------------------------------------------

function parseNumberField(value) {
  const text = String(value || "").trim();
  if (!text || /\[(N\/A|Not Supported)\]|^N\/A$/i.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function parseNvidiaSmi(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(",").map((part) => part.trim()))
    .filter((parts) => parts.length >= 5)
    .map(([name, utilization, memoryUsed, memoryTotal, temperature]) => {
      const usedMiB = parseNumberField(memoryUsed);
      const totalMiB = parseNumberField(memoryTotal);
      return {
        vendor: "nvidia",
        name: name || "NVIDIA GPU",
        utilizationPercent: parseNumberField(utilization),
        memoryUsedBytes: usedMiB === null ? null : usedMiB * 1024 * 1024,
        memoryTotalBytes: totalMiB === null ? null : totalMiB * 1024 * 1024,
        temperatureCelsius: parseNumberField(temperature),
      };
    });
}

function createGpuSampler({ execFile = defaultExecFile, now = () => Date.now() } = {}) {
  let cache = null;
  return async function sampleGpu() {
    const at = now();
    if (cache && at - cache.at < GPU_CACHE_MS) return cache.value;
    const result = await execFile("nvidia-smi", ["--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"]);
    let value;
    if (!result.ok) {
      value = { available: false, devices: [], reason: result.code === "ENOENT" ? "no_supported_gpu_tool" : "gpu_query_failed", checkedAt: new Date(at).toISOString() };
    } else {
      const devices = parseNvidiaSmi(result.stdout);
      value = devices.length
        ? { available: true, devices, reason: null, source: "nvidia-smi", checkedAt: new Date(at).toISOString() }
        : { available: false, devices: [], reason: "no_gpu_reported", checkedAt: new Date(at).toISOString() };
    }
    cache = { at, value };
    return value;
  };
}

module.exports = {
  MIN_SAMPLE_INTERVAL_MS,
  GPU_CACHE_MS,
  createCpuSampler,
  createNetworkSampler,
  createGpuSampler,
  _test: { parseProcNetDev, parseNetstatE, parseNvidiaSmi, percentBetween },
};
