#!/usr/bin/env node
const assert = require("assert");
const childProcess = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");

const telemetry = require("../src/shared/windowsHardwareTemperature");
const systemService = require("../agent/src/services/systemService");

function sensor(name, value, extra = {}) {
  return { name, value, sensorType: "Temperature", hardware: "Intel CPU", identifier: `/cpu/${name}`, ...extra };
}

function withPlatform(value, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value });
  return Promise.resolve()
    .then(fn)
    .finally(() => Object.defineProperty(process, "platform", descriptor));
}

async function readAgentTemperatureWithHardware(payload) {
  systemService._test.resetCpuTemperatureCacheForTest();
  systemService._test.setWindowsHardwareTemperatureReaderForTest(async () => payload);
  return withPlatform("win32", () => systemService._test.getCpuTemperature());
}

const packageReading = telemetry.classifyPayload({
  ok: true,
  timestamp: "2026-07-17T12:00:00.000Z",
  sensors: [sensor("CPU Core #1", 48), sensor("CPU Package", 55), sensor("CPU Core Max", 58)],
});
assert.strictEqual(packageReading.cpu.sensorName, "CPU Package", "CPU Package must be preferred.");
assert.strictEqual(packageReading.cpu.temperatureCelsius, 55);
assert.strictEqual(packageReading.source, "Embedded LibreHardwareMonitor");
assert.strictEqual(packageReading.timestamp, "2026-07-17T12:00:00.000Z");

const ccdReading = telemetry.classifyPayload({
  ok: true,
  sensors: [sensor("CPU Core Max", 65), sensor("CPU Tctl/Tdie", 67), sensor("CPU CCD #1", 63)],
});
assert.strictEqual(ccdReading.cpu.sensorName, "CPU CCD #1", "CPU CCD must follow CPU Package.");

const tctlReading = telemetry.classifyPayload({
  ok: true,
  sensors: [sensor("CPU Core Max", 65), sensor("CPU Tctl/Tdie", 67)],
});
assert.strictEqual(tctlReading.cpu.sensorName, "CPU Tctl/Tdie", "CPU Tctl/Tdie must follow CPU CCD.");

const coreMaxReading = telemetry.classifyPayload({
  ok: true,
  sensors: [sensor("CPU Core #1", 62), sensor("CPU Core Max", 65)],
});
assert.strictEqual(coreMaxReading.cpu.sensorName, "CPU Core Max", "CPU Core Max must be the first fallback.");

const highestCoreReading = telemetry.classifyPayload({
  ok: true,
  sensors: [sensor("CPU Core #1", 51), sensor("CPU Core #2", 57), sensor("GPU Core", 73, { hardware: "NVIDIA GPU" })],
});
assert.strictEqual(highestCoreReading.cpu.sensorName, "CPU Core #2", "Highest valid CPU core must be the final CPU fallback.");
assert.strictEqual(highestCoreReading.gpu.core.temperatureCelsius, 73, "GPU core temperature may be returned separately.");

const gpuReading = telemetry.classifyPayload({
  ok: true,
  sensors: [sensor("CPU Package", 50), sensor("GPU Core", 70, { hardware: "AMD GPU" }), sensor("GPU Hot Spot", 82, { hardware: "AMD GPU" })],
});
assert.strictEqual(gpuReading.gpu.core.temperatureCelsius, 70);
assert.strictEqual(gpuReading.gpu.hotspot.temperatureCelsius, 82);

const invalid = telemetry.classifyPayload({
  ok: true,
  sensors: [sensor("CPU Package", null), sensor("CPU Core #1", "NaN"), sensor("CPU Core #2", -4), sensor("CPU Core #3", 126)],
});
assert.strictEqual(invalid.available, false, "Invalid and unrealistic readings must be rejected.");
assert.strictEqual(invalid.reason, "cpu_sensor_unavailable");

const nonElevated = telemetry.classifyPayload({ ok: true, elevated: false, sensors: [{ name: "GPU Core", hardware: "NVIDIA GPU", value: 55 }] });
assert.strictEqual(nonElevated.reason, "cpu_sensor_unavailable_requires_elevation_or_driver");

const missingPawnIo = telemetry.classifyPayload({
  ok: true,
  elevated: true,
  cpuHardwareEnumerated: true,
  cpuTemperatureSensorsEnumerated: 1,
  pawnIoInstalled: false,
  sensors: [{ name: "GPU Core", hardware: "AMD GPU", value: 55 }],
});
assert.strictEqual(missingPawnIo.reason, "low_level_driver_missing", "Enumerated Ryzen CPU sensors returning no valid value without PawnIO must identify the missing low-level driver.");
assert.strictEqual(telemetry.validCelsius(45), true);
assert.strictEqual(telemetry.validCelsius(0), false);
assert.strictEqual(telemetry.validCelsius(126), false);

const unavailable = telemetry.classifyPayload({ ok: false, reason: "access_denied_or_driver_unavailable" });
assert.strictEqual(unavailable.available, false);
assert.strictEqual(unavailable.reason, "access_denied_or_driver_unavailable");

async function assertExistingProviderFallback() {
  const calls = [];
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(null, JSON.stringify([
      { Name: "GPU Core", Identifier: "/gpu/0/temperature/0", Parent: "/gpu/0", SensorType: "Temperature", Value: 71 },
      { Name: "CPU Package", Identifier: "/intelcpu/0/temperature/0", Parent: "/intelcpu/0", SensorType: "Temperature", Value: 59 },
    ]), "");
  };
  const reading = await telemetry.readWindowsHardwareTemperature({
    helperPath: path.join(__dirname, "missing-helper.exe"),
    execFile,
  });
  assert.strictEqual(reading.available, true, "A running LibreHardwareMonitor namespace must be used when the embedded provider is unavailable.");
  assert.strictEqual(reading.cpu.temperatureCelsius, 59);
  assert.strictEqual(reading.cpu.sensorName, "CPU Package");
  assert.strictEqual(reading.source, "root\\LibreHardwareMonitor");
  assert.strictEqual(calls.length, 1, "Fallback must stop after the first healthy namespace.");
  assert(calls[0].args.join(" ").includes("root\\LibreHardwareMonitor"));
  assert(!calls[0].args.join(" ").includes("MSAcpi_ThermalZoneTemperature"), "ACPI thermal-zone values must never be queried.");

  const malformed = await telemetry.readExistingHardwareMonitorTemperature({
    execFile(command, args, options, callback) {
      callback(null, "{not-json", "");
    },
  });
  assert.strictEqual(malformed.available, false, "Malformed provider data must fail safely.");

  const timedOut = await telemetry.readExistingHardwareMonitorTemperature({
    execFile(command, args, options, callback) {
      const error = new Error("timed out");
      error.code = "ETIMEDOUT";
      callback(error, "", "");
    },
  });
  assert.strictEqual(timedOut.available, false, "Provider timeouts must fail safely.");
}

async function assertAgentWindowsNormalization() {
  const reading = await readAgentTemperatureWithHardware(packageReading);
  assert.strictEqual(reading.temperatureValid, true, "Agent Windows metric path must normalize valid embedded readings.");
  assert.strictEqual(reading.temperatureCelsius, 55);
  assert.strictEqual(reading.temperatureSource, telemetry.SOURCE);
  assert.strictEqual(reading.temperatureSensor, "CPU Package");

  const providerFailure = telemetry.classifyPayload({ ok: false, reason: "provider_timeout" });
  const failed = await readAgentTemperatureWithHardware(providerFailure);
  assert.strictEqual(failed.temperatureValid, false, "Agent Windows metric path must preserve unavailable provider state.");
  assert.strictEqual(failed.temperatureReason, "provider_timeout");
  systemService._test.setWindowsHardwareTemperatureReaderForTest(null);
}

async function assertProviderHandlesAreReleased() {
  const originalSpawn = childProcess.spawn;
  let fakeProvider = null;
  childProcess.spawn = () => {
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    child.spawnfile = "anxos-hardware-telemetry.exe";
    child.killed = false;
    child.unrefCalled = false;
    child.killCalled = false;
    child.unref = () => { child.unrefCalled = true; };
    child.kill = () => {
      child.killCalled = true;
      child.killed = true;
      process.nextTick(() => child.emit("exit", null, "SIGTERM"));
      return true;
    };
    child.stdin = {
      destroyed: false,
      unrefCalled: false,
      write(chunk) {
        assert.strictEqual(chunk, "read\n");
        process.nextTick(() => stdout.emit("data", `${JSON.stringify({ ok: true, sensors: [sensor("CPU Package", 42)] })}\n`));
        return true;
      },
      destroy() { this.destroyed = true; },
      unref() { this.unrefCalled = true; },
    };
    child.stdout = stdout;
    child.stdout.destroyed = false;
    child.stdout.unrefCalled = false;
    child.stdout.setEncoding = (encoding) => { child.stdout.encoding = encoding; };
    child.stdout.destroy = () => { child.stdout.destroyed = true; };
    child.stdout.unref = () => { child.stdout.unrefCalled = true; };
    child.stderr = {
      destroyed: false,
      unrefCalled: false,
      destroy() { this.destroyed = true; },
      unref() { this.unrefCalled = true; },
    };
    fakeProvider = child;
    return child;
  };
  try {
    const reading = await telemetry.readWindowsHardwareTemperature({ helperPath: __filename, timeoutMs: 1000 });
    assert.strictEqual(reading.available, true, "Mocked provider should return a valid reading.");
    assert.strictEqual(fakeProvider.unrefCalled, true, "Provider child process must be unref'd.");
    assert.strictEqual(fakeProvider.stdin.unrefCalled, true, "Provider stdin pipe must be unref'd.");
    assert.strictEqual(fakeProvider.stdout.unrefCalled, true, "Provider stdout pipe must be unref'd.");
    assert.strictEqual(fakeProvider.stdout.encoding, "utf8");
    telemetry.stopWindowsHardwareTemperatureProvider();
    assert.strictEqual(fakeProvider.stdin.destroyed, true, "Stopping the provider must destroy stdin.");
    assert.strictEqual(fakeProvider.stdout.destroyed, true, "Stopping the provider must destroy stdout.");
    assert.strictEqual(fakeProvider.stderr.destroyed, true, "Stopping the provider must destroy stderr when present.");
    assert.strictEqual(fakeProvider.killCalled, true, "Stopping the provider must terminate the helper.");
  } finally {
    childProcess.spawn = originalSpawn;
    telemetry.stopWindowsHardwareTemperatureProvider();
  }
}

async function assertProviderSingleFlightAndTimeoutRecovery() {
  const originalSpawn = childProcess.spawn;
  let spawnCount = 0;
  let writeCount = 0;
  const providers = [];
  childProcess.spawn = () => {
    spawnCount += 1;
    const child = new EventEmitter();
    const stdout = new EventEmitter();
    child.killed = false;
    child.unref = () => {};
    child.kill = () => {
      child.killed = true;
      process.nextTick(() => child.emit("exit", null, "SIGTERM"));
      return true;
    };
    child.stdin = {
      destroyed: false,
      writableEnded: false,
      write(_chunk, callback) {
        writeCount += 1;
        callback?.();
        if (spawnCount > 1) {
          process.nextTick(() => stdout.emit("data", `${JSON.stringify({ ok: true, sensors: [sensor("CPU Package", 44)] })}\n`));
        }
        return true;
      },
      destroy() { this.destroyed = true; },
      unref() {},
      on() {},
    };
    child.stdout = stdout;
    child.stdout.setEncoding = () => {};
    child.stdout.destroy = () => {};
    child.stdout.unref = () => {};
    child.stderr = { destroy() {}, unref() {} };
    providers.push(child);
    return child;
  };
  try {
    const first = telemetry.readWindowsHardwareTemperature({
      helperPath: __filename,
      startupTimeoutMs: 20,
      disableNamespaceFallback: true,
    });
    const concurrent = telemetry.readWindowsHardwareTemperature({
      helperPath: __filename,
      startupTimeoutMs: 20,
      disableNamespaceFallback: true,
    });
    const [timedOut, sameTimedOut] = await Promise.all([first, concurrent]);
    assert.strictEqual(timedOut.reason, "provider_timeout", "A bounded first-start timeout must remain structured.");
    assert.strictEqual(sameTimedOut.reason, "provider_timeout", "Concurrent callers must share the active provider read.");
    assert.strictEqual(spawnCount, 1, "Concurrent telemetry requests must not launch duplicate helper processes.");
    assert.strictEqual(writeCount, 1, "Concurrent telemetry requests must issue only one provider command.");
    assert.strictEqual(providers[0].killed, true, "A timed-out provider process must be terminated.");

    const recovered = await telemetry.readWindowsHardwareTemperature({
      helperPath: __filename,
      startupTimeoutMs: 1000,
      disableNamespaceFallback: true,
    });
    assert.strictEqual(recovered.available, true, "A later request must recover by starting a fresh provider.");
    assert.strictEqual(recovered.cpu.temperatureCelsius, 44);
    assert.strictEqual(spawnCount, 2, "Timeout recovery must create exactly one replacement provider.");
  } finally {
    childProcess.spawn = originalSpawn;
    telemetry.stopWindowsHardwareTemperatureProvider();
  }
}

Promise.resolve(telemetry.readWindowsHardwareTemperature({
  helperPath: path.join(__dirname, "missing-helper.exe"),
  disableNamespaceFallback: true,
}))
  .then(async (missing) => {
    assert.strictEqual(missing.reason, "provider_missing", "Missing bundled provider must have an explicit reason.");
    await assertExistingProviderFallback();
    await assertProviderHandlesAreReleased();
    await assertProviderSingleFlightAndTimeoutRecovery();
    await assertAgentWindowsNormalization();
    const systemSource = fs.readFileSync(path.join(__dirname, "../src/services/systemService.js"), "utf8");
    assert(systemSource.includes('target.type === "agent"') && systemSource.includes("getLocalSystemSnapshot()"), "Selected Agent and Local Application Host metrics must stay routed separately.");
    assert(systemSource.includes("readWindowsHardwareTemperature"), "Local Application Host must use the shared Windows provider.");
    const agentSource = fs.readFileSync(path.join(__dirname, "../agent/src/services/systemService.js"), "utf8");
    assert(agentSource.includes("readWindowsHardwareTemperature"), "Windows Agent must use the shared Windows provider.");
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
    assert(packageJson.build.extraResources.some((entry) => entry.to === "hardware-telemetry"), "Packaged Windows builds must include the helper.");
    const windowsTargets = packageJson.build.win.target.map((entry) => entry.target);
    assert(windowsTargets.includes("nsis"), "Windows installer must include embedded telemetry resources.");
    assert(windowsTargets.includes("portable"), "Windows portable build must include embedded telemetry resources.");
    const builderSource = fs.readFileSync(path.join(__dirname, "run-electron-builder.js"), "utf8");
    assert(builderSource.includes("build-windows-hardware-telemetry.js"), "Windows packaging must build the embedded helper before electron-builder.");
    const providerSource = fs.readFileSync(path.join(__dirname, "../src/shared/windowsHardwareTemperature.js"), "utf8");
    assert(providerSource.includes("ensureProvider") && providerSource.includes('provider.stdin.write("read\\n"'), "Hardware provider must be initialized once and reused.");
    assert(providerSource.includes("stopWindowsHardwareTemperatureProvider"), "Hardware provider must be disposed on shutdown.");
    assert(providerSource.includes("root\\\\LibreHardwareMonitor"), "Windows fallback must query the LibreHardwareMonitor namespace.");
    assert(!providerSource.includes("MSAcpi_ThermalZoneTemperature"), "Windows fallback must not use unreliable ACPI thermal-zone values.");
    const helperSource = fs.readFileSync(path.join(__dirname, "../tools/windows-hardware-telemetry/Program.cs"), "utf8");
    assert(helperSource.includes("new Computer { IsCpuEnabled = true }"), "The embedded helper must limit LibreHardwareMonitor discovery to CPU sensors.");
    assert(!helperSource.includes("IsGpuEnabled = true"), "The CPU-temperature helper must not initialize unrelated GPU hardware.");
    const rendererSource = fs.readFileSync(path.join(__dirname, "../app.js"), "utf8");
    assert(rendererSource.includes('return "Temperature unavailable";'), "Unavailable temperature must use neutral Runtime-card language.");
    assert(!rendererSource.includes('return "Requires sensor support";'), "Runtime card must not show an error-looking sensor-support badge.");
    console.log("Windows CPU temperature smoke checks passed.");
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
