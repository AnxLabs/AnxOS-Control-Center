const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const SOURCE = "Embedded LibreHardwareMonitor";
const MIN_CELSIUS = 1;
const MAX_CELSIUS = 125;
const DEFAULT_PROVIDER_TIMEOUT_MS = 8000;
const DEFAULT_PROVIDER_STARTUP_TIMEOUT_MS = 20000;
const MAX_PROVIDER_LINE_BYTES = 256 * 1024;
let providerProcess = null;
let providerPath = null;
let providerBuffer = "";
let pendingRead = null;
let shutdownHooksRegistered = false;

function unrefProviderHandle(handle) {
  if (handle && typeof handle.unref === "function") handle.unref();
}

function unavailable(reason) {
  return { available: false, status: "unavailable", source: SOURCE, provider: SOURCE, timestamp: new Date().toISOString(), reason };
}

function validCelsius(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= MIN_CELSIUS && number <= MAX_CELSIUS;
}

function sensorText(sensor = {}) {
  return [sensor.name, sensor.Name, sensor.identifier, sensor.Identifier, sensor.hardware, sensor.Parent]
    .filter(Boolean).join(" ").toLowerCase();
}

function isCpuSensor(sensor = {}) {
  const text = sensorText(sensor);
  return /\b(cpu|processor|intelcpu|amdcpu)\b/.test(text) && !/\b(gpu|graphics|storage|disk|ssd|nvme|battery)\b/.test(text);
}

function isGpuSensor(sensor = {}) {
  return /\b(gpu|graphics|nvidia|amdgpu|intelgpu)\b/.test(sensorText(sensor));
}

function sensorValue(sensor = {}) {
  return Number(sensor.value ?? sensor.Value);
}

function chooseCpuSensor(sensors = []) {
  const valid = sensors.filter((sensor) => isCpuSensor(sensor) && validCelsius(sensorValue(sensor)));
  const packageSensor = valid.find((sensor) => /\bcpu package\b|\bpackage\b/.test(sensorText(sensor)));
  if (packageSensor) return packageSensor;
  const ccdSensor = valid.find((sensor) => /\bccd(?:\s*#?\d+)?\b/.test(sensorText(sensor)));
  if (ccdSensor) return ccdSensor;
  const tctlSensor = valid.find((sensor) => /\btctl\b|\btdie\b|\btctl\/tdie\b/.test(sensorText(sensor)));
  if (tctlSensor) return tctlSensor;
  const coreMax = valid.find((sensor) => /\bcore max\b|\bcpu max\b/.test(sensorText(sensor)));
  if (coreMax) return coreMax;
  return valid.filter((sensor) => /\bcore\b/.test(sensorText(sensor)))
    .sort((left, right) => sensorValue(right) - sensorValue(left))[0] || null;
}

function chooseGpuSensors(sensors = []) {
  const valid = sensors.filter((sensor) => isGpuSensor(sensor) && validCelsius(sensorValue(sensor)));
  return {
    core: valid.find((sensor) => /\bgpu core\b|\bcore\b/.test(sensorText(sensor)) && !/hot\s*spot|hotspot/.test(sensorText(sensor))) || null,
    hotspot: valid.find((sensor) => /hot\s*spot|hotspot|junction/.test(sensorText(sensor))) || null,
  };
}

function normalizeSensor(sensor, timestamp = new Date().toISOString()) {
  if (!sensor) return null;
  return {
    temperatureCelsius: Math.round(sensorValue(sensor) * 10) / 10,
    sensorName: sensor.name || sensor.Name || "Temperature",
    source: SOURCE,
    provider: SOURCE,
    timestamp,
    status: "available",
  };
}

function classifyPayload(payload = {}) {
  const timestamp = payload.timestamp || new Date().toISOString();
  if (payload.ok !== true) {
    return { available: false, status: "unavailable", source: SOURCE, provider: SOURCE, timestamp, reason: payload.reason || "provider_failed" };
  }
  const sensors = Array.isArray(payload.sensors) ? payload.sensors : [];
  const cpu = normalizeSensor(chooseCpuSensor(sensors), timestamp);
  const selectedGpu = chooseGpuSensors(sensors);
  const gpu = {
    core: normalizeSensor(selectedGpu.core, timestamp),
    hotspot: normalizeSensor(selectedGpu.hotspot, timestamp),
  };
  if (!gpu.core && !gpu.hotspot) {
    Object.assign(gpu, { core: null, hotspot: null });
  }
  if (!cpu) return {
    available: false,
    status: "unavailable",
    source: SOURCE,
    timestamp,
    reason: payload.cpuHardwareEnumerated === true && payload.cpuTemperatureSensorsEnumerated > 0 && payload.pawnIoInstalled === false
      ? "low_level_driver_missing"
      : payload.elevated === false ? "cpu_sensor_unavailable_requires_elevation_or_driver" : sensors.length ? "cpu_sensor_unavailable" : "no_sensors",
    gpu,
  };
  return { available: true, status: "available", source: SOURCE, provider: SOURCE, timestamp, cpu, gpu };
}

function parseSensorRows(stdout) {
  if (!stdout || !String(stdout).trim()) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function queryHardwareMonitorNamespace(namespace, options = {}) {
  const execFile = options.execFile || childProcess.execFile;
  const script = [
    "$ErrorActionPreference = 'Stop';",
    `Get-CimInstance -Namespace '${namespace}' -ClassName Sensor -Filter "SensorType='Temperature'"`,
    "| Select-Object Name,Identifier,Parent,SensorType,Value",
    "| ConvertTo-Json -Compress",
  ].join(" ");

  return new Promise((resolve) => {
    execFile("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      script,
    ], {
      timeout: options.namespaceTimeoutMs || 5000,
      windowsHide: true,
      maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      if (error) {
        resolve(unavailable(error.code === "ETIMEDOUT" ? "provider_timeout" : "provider_unavailable"));
        return;
      }
      try {
        const reading = classifyPayload({
          ok: true,
          source: namespace,
          timestamp: new Date().toISOString(),
          sensors: parseSensorRows(stdout),
        });
        resolve({
          ...reading,
          source: namespace,
          provider: namespace,
          cpu: reading.cpu ? { ...reading.cpu, source: namespace, provider: namespace } : reading.cpu,
          gpu: reading.gpu ? {
            core: reading.gpu.core ? { ...reading.gpu.core, source: namespace, provider: namespace } : null,
            hotspot: reading.gpu.hotspot ? { ...reading.gpu.hotspot, source: namespace, provider: namespace } : null,
          } : null,
        });
      } catch {
        resolve(unavailable("provider_invalid_response"));
      }
    });
  });
}

async function readExistingHardwareMonitorTemperature(options = {}) {
  const namespaces = ["root\\LibreHardwareMonitor", "root\\OpenHardwareMonitor"];
  let lastUnavailable = unavailable("provider_unavailable");
  for (const namespace of namespaces) {
    const reading = await queryHardwareMonitorNamespace(namespace, options);
    if (reading.available) return reading;
    lastUnavailable = reading;
  }
  return lastUnavailable;
}

function resolveHelperPath(options = {}) {
  if (options.helperPath) return fs.existsSync(options.helperPath) ? options.helperPath : null;
  const candidates = [
    process.env.ANXOS_HARDWARE_TELEMETRY_HELPER,
    process.resourcesPath && path.join(process.resourcesPath, "hardware-telemetry", "anxos-hardware-telemetry.exe"),
    path.resolve(__dirname, "../../../hardware-telemetry/anxos-hardware-telemetry.exe"),
    path.resolve(__dirname, "../../resources/hardware-telemetry/win-x64/anxos-hardware-telemetry.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function stopWindowsHardwareTemperatureProvider() {
  if (providerProcess) {
    providerProcess.stdin?.destroy?.();
    providerProcess.stdout?.destroy?.();
    providerProcess.stderr?.destroy?.();
    if (!providerProcess.killed) providerProcess.kill();
    unrefProviderHandle(providerProcess);
  }
  providerProcess = null;
  providerPath = null;
  providerBuffer = "";
  if (pendingRead) {
    clearTimeout(pendingRead.timer);
    pendingRead.resolve(unavailable("provider_stopped"));
    pendingRead = null;
  }
}

function settlePendingRead(reason) {
  if (!pendingRead) return false;
  const current = pendingRead;
  pendingRead = null;
  clearTimeout(current.timer);
  current.resolve(unavailable(reason));
  return true;
}

function ensureProvider(helperPath) {
  if (providerProcess && providerPath === helperPath && !providerProcess.killed) return providerProcess;
  stopWindowsHardwareTemperatureProvider();
  providerPath = helperPath;
  const spawnedProvider = childProcess.spawn(helperPath, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  providerProcess = spawnedProvider;
  unrefProviderHandle(spawnedProvider);
  unrefProviderHandle(spawnedProvider.stdin);
  unrefProviderHandle(spawnedProvider.stdout);
  unrefProviderHandle(spawnedProvider.stderr);
  spawnedProvider.stdout.setEncoding("utf8");
  if (typeof spawnedProvider.stdin?.on === "function") {
    spawnedProvider.stdin.on("error", (error) => {
      if (providerProcess !== spawnedProvider) return;
      settlePendingRead(error?.code === "EPIPE" ? "provider_pipe_closed" : "provider_stdin_failed");
    });
  }
  spawnedProvider.stdout.on("data", (chunk) => {
    if (providerProcess !== spawnedProvider) return;
    providerBuffer += chunk;
    if (Buffer.byteLength(providerBuffer, "utf8") > MAX_PROVIDER_LINE_BYTES) {
      settlePendingRead("provider_invalid_response");
      stopWindowsHardwareTemperatureProvider();
      return;
    }
    const newline = providerBuffer.indexOf("\n");
    if (newline < 0 || !pendingRead) return;
    const line = providerBuffer.slice(0, newline).trim();
    providerBuffer = providerBuffer.slice(newline + 1);
    const current = pendingRead;
    pendingRead = null;
    clearTimeout(current.timer);
    try {
      current.resolve(classifyPayload(JSON.parse(line)));
    } catch {
      current.resolve(unavailable("provider_invalid_response"));
    }
  });
  spawnedProvider.on("error", (error) => {
    if (providerProcess !== spawnedProvider) return;
    settlePendingRead(error.code === "EACCES" ? "access_denied_or_driver_unavailable" : "provider_failed");
  });
  spawnedProvider.on("exit", () => {
    if (providerProcess !== spawnedProvider) return;
    providerProcess = null;
    providerPath = null;
    settlePendingRead("provider_exited");
  });
  if (!shutdownHooksRegistered) {
    shutdownHooksRegistered = true;
    process.once("exit", stopWindowsHardwareTemperatureProvider);
  }
  return spawnedProvider;
}

function runHelper(helperPath, options = {}) {
  if (pendingRead) return pendingRead.promise;
  const startingProvider = !providerProcess || providerPath !== helperPath || providerProcess.killed;
  const provider = ensureProvider(helperPath);
  let resolveRead;
  const promise = new Promise((resolve) => { resolveRead = resolve; });
  const timeoutMs = startingProvider
    ? options.startupTimeoutMs || DEFAULT_PROVIDER_STARTUP_TIMEOUT_MS
    : options.timeoutMs || DEFAULT_PROVIDER_TIMEOUT_MS;
  const timer = setTimeout(() => {
    if (!pendingRead || pendingRead.promise !== promise) return;
    pendingRead = null;
    resolveRead(unavailable("provider_timeout"));
    stopWindowsHardwareTemperatureProvider();
  }, timeoutMs);
  pendingRead = { resolve: resolveRead, timer, promise };
  if (!provider.stdin || provider.stdin.destroyed || provider.stdin.writableEnded) {
    settlePendingRead("provider_pipe_closed");
    return promise;
  }
  provider.stdin.write("read\n", (error) => {
    if (error) {
      settlePendingRead(error.code === "EPIPE" ? "provider_pipe_closed" : "provider_write_failed");
    }
  });
  return promise;
}

async function readWindowsHardwareTemperature(options = {}) {
  const helperPath = resolveHelperPath(options);
  const embedded = helperPath
    ? await runHelper(helperPath, options)
    : unavailable("provider_missing");
  if (embedded.available || options.disableNamespaceFallback === true) return embedded;

  const existingProvider = await readExistingHardwareMonitorTemperature(options);
  return existingProvider.available ? existingProvider : embedded;
}

module.exports = {
  DEFAULT_PROVIDER_STARTUP_TIMEOUT_MS,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  SOURCE,
  classifyPayload,
  chooseCpuSensor,
  chooseGpuSensors,
  parseSensorRows,
  queryHardwareMonitorNamespace,
  readExistingHardwareMonitorTemperature,
  readWindowsHardwareTemperature,
  resolveHelperPath,
  stopWindowsHardwareTemperatureProvider,
  validCelsius,
};
