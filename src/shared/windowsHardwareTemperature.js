const childProcess = require("child_process");
const fs = require("fs");
const path = require("path");

const SOURCE = "Embedded LibreHardwareMonitor";
const MIN_CELSIUS = 1;
const MAX_CELSIUS = 125;
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
  providerProcess = childProcess.spawn(helperPath, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  unrefProviderHandle(providerProcess);
  unrefProviderHandle(providerProcess.stdin);
  unrefProviderHandle(providerProcess.stdout);
  unrefProviderHandle(providerProcess.stderr);
  providerProcess.stdout.setEncoding("utf8");
  if (typeof providerProcess.stdin?.on === "function") {
    providerProcess.stdin.on("error", (error) => {
      settlePendingRead(error?.code === "EPIPE" ? "provider_pipe_closed" : "provider_stdin_failed");
    });
  }
  providerProcess.stdout.on("data", (chunk) => {
    providerBuffer += chunk;
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
  providerProcess.on("error", (error) => {
    settlePendingRead(error.code === "EACCES" ? "access_denied_or_driver_unavailable" : "provider_failed");
  });
  providerProcess.on("exit", () => {
    providerProcess = null;
    providerPath = null;
    settlePendingRead("provider_exited");
  });
  if (!shutdownHooksRegistered) {
    shutdownHooksRegistered = true;
    process.once("exit", stopWindowsHardwareTemperatureProvider);
  }
  return providerProcess;
}

function runHelper(helperPath, options = {}) {
  if (pendingRead) return Promise.resolve(unavailable("provider_busy"));
  const provider = ensureProvider(helperPath);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingRead) return;
      pendingRead = null;
      resolve(unavailable("provider_timeout"));
      stopWindowsHardwareTemperatureProvider();
    }, options.timeoutMs || 8000);
    pendingRead = { resolve, timer };
    if (!provider.stdin || provider.stdin.destroyed || provider.stdin.writableEnded) {
      settlePendingRead("provider_pipe_closed");
      return;
    }
    provider.stdin.write("read\n", (error) => {
      if (error) {
        settlePendingRead(error.code === "EPIPE" ? "provider_pipe_closed" : "provider_write_failed");
      }
    });
  });
}

async function readWindowsHardwareTemperature(options = {}) {
  const helperPath = resolveHelperPath(options);
  if (!helperPath) return unavailable("provider_missing");
  return runHelper(helperPath, options);
}

module.exports = {
  SOURCE,
  classifyPayload,
  chooseCpuSensor,
  chooseGpuSensors,
  readWindowsHardwareTemperature,
  resolveHelperPath,
  stopWindowsHardwareTemperatureProvider,
  validCelsius,
};
