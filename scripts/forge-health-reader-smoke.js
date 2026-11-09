#!/usr/bin/env node
// Project Forge health contract (forge.health/1): reader, Agent wiring and
// Dashboard presentation. Uses temp files only; never touches the real
// %LOCALAPPDATA%\AnxLabs\Forge\health.json.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const forgeHealth = require("../src/shared/forgeHealth");
const presentation = require("../src/shared/forgeHealthPresentation");
const systemService = require("../agent/src/services/systemService");

const NOW = Date.parse("2026-11-09T21:30:00Z");

function contract(overrides = {}) {
  return {
    schema: "forge.health/1",
    generated_at: "2026-11-09T21:29:00+00:00",
    stale_after_seconds: 180,
    status: "critical",
    forge: { version: "0.3.0", pid: 1234 },
    machine: { hostname: "DESKTOP-TEST", fingerprint: "fp_test", cpu: "Test CPU", ram_bytes: 1, gpu: "Test GPU" },
    boost: { active: false, profile: null, target: null, since: null, auto_boost: false },
    memory: { available_bytes: 10312830976, total_bytes: 51462049792, commit_percent: 73.3, pressure: "moderate" },
    thermals: { gpu_c: 54, cpu_c: null, level: "ok", summary: "Temperatures look fine." },
    kernel: {
      paged_bytes: 8828323008,
      nonpaged_bytes: 3620143024,
      growth_bytes_per_hour: null,
      verdict: { id: "filter_name_leak", severity: "critical", title: "A file-system filter driver is holding millions of file names" },
    },
    crashes: {
      days: 7,
      counts: { app_crashes: 0, app_hangs: 1, unexpected_shutdowns: 0, gpu_resets: 0, hardware_errors: 0 },
      verdict: { id: "app_crashes", severity: "low", title: "1 app hung" },
    },
    alerts: [
      { severity: "critical", code: "kernel.filter_name_leak", title: "A file-system filter driver is holding millions of file names", detail: "Kernel pools 11.6 GB.", forge_page: "leaks" },
      { severity: "info", code: "boost.active", title: "Game Boost running", detail: null, forge_page: "boost" },
    ],
    errors: [],
    ...overrides,
  };
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-forge-health-"));
function writeHealth(name, value) {
  const filePath = path.join(tempDir, name);
  fs.writeFileSync(filePath, typeof value === "string" ? value : JSON.stringify(value), "utf8");
  return filePath;
}

function withPlatform(value, fn) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value });
  return Promise.resolve()
    .then(fn)
    .finally(() => Object.defineProperty(process, "platform", descriptor));
}

async function main() {
  // --- Path resolution -----------------------------------------------------
  assert.strictEqual(
    forgeHealth.resolveForgeHealthPath({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" } }),
    "C:\\Users\\a\\AppData\\Local\\AnxLabs\\Forge\\health.json",
  );
  assert.strictEqual(forgeHealth.resolveForgeHealthPath({ platform: "win32", env: {} }), null, "No LOCALAPPDATA means no path, not a guess.");
  assert.strictEqual(
    forgeHealth.resolveForgeHealthPath({ platform: "linux", env: { XDG_DATA_HOME: "/data" } }),
    "/data/anxlabs/forge/health.json",
  );
  assert.strictEqual(
    forgeHealth.resolveForgeHealthPath({ platform: "linux", env: {}, homedir: "/home/a" }),
    "/home/a/.local/share/anxlabs/forge/health.json",
  );

  // --- Fresh ---------------------------------------------------------------
  const fresh = await forgeHealth.readForgeHealth({ filePath: writeHealth("fresh.json", contract()), now: NOW });
  assert.strictEqual(fresh.available, true);
  assert.strictEqual(fresh.fresh, true);
  assert.strictEqual(fresh.stale, false);
  assert.strictEqual(fresh.state, "fresh");
  assert.strictEqual(fresh.status, "critical");
  assert.strictEqual(fresh.ageSeconds, 60);
  assert.strictEqual(fresh.staleAfterSeconds, 180);
  assert.strictEqual(fresh.generatedAt, "2026-11-09T21:29:00.000Z");
  assert.strictEqual(fresh.forgeVersion, "0.3.0");
  assert.strictEqual(fresh.thermals.gpuC, 54);
  assert.strictEqual(fresh.thermals.cpuC, null, "cpu_c null must stay null (unknown), never zero.");
  assert.strictEqual(fresh.memory.pressure, "moderate");
  assert.strictEqual(fresh.kernel.verdict.id, "filter_name_leak");
  assert.strictEqual(fresh.kernel.growthBytesPerHour, null);
  assert.strictEqual(fresh.crashes.counts.appHangs, 1);
  assert.strictEqual(fresh.crashes.counts.appCrashes, 0, "A real zero count stays zero.");
  assert.deepStrictEqual(fresh.alerts.map((alert) => alert.code), ["kernel.filter_name_leak", "boost.active"], "Alerts keep Forge's ranking.");
  assert.deepStrictEqual(fresh.alerts[0], {
    severity: "critical",
    code: "kernel.filter_name_leak",
    title: "A file-system filter driver is holding millions of file names",
    detail: "Kernel pools 11.6 GB.",
    forgePage: "leaks",
  });
  // Identity fields from the file are not passed on by the Agent.
  const serialized = JSON.stringify(fresh);
  assert.ok(!serialized.includes("fp_test") && !serialized.includes("DESKTOP-TEST") && !serialized.includes("1234"), "machine identity and pid must not be exposed.");

  // --- Stale (older than stale_after_seconds) --------------------------------
  const stale = await forgeHealth.readForgeHealth({
    filePath: writeHealth("stale.json", contract({ generated_at: "2026-11-09T21:20:00Z" })),
    now: NOW,
  });
  assert.strictEqual(stale.available, true);
  assert.strictEqual(stale.fresh, false);
  assert.strictEqual(stale.stale, true);
  assert.strictEqual(stale.state, "stale");
  assert.strictEqual(stale.reason, "file_stale");
  assert.strictEqual(stale.ageSeconds, 600);

  const customWindow = forgeHealth.parseForgeHealth(JSON.stringify(contract({ stale_after_seconds: 30 })), { now: NOW });
  assert.strictEqual(customWindow.state, "stale", "stale_after_seconds from the file is honoured.");
  const badWindow = forgeHealth.parseForgeHealth(JSON.stringify(contract({ stale_after_seconds: "soon" })), { now: NOW });
  assert.strictEqual(badWindow.staleAfterSeconds, forgeHealth.DEFAULT_STALE_AFTER_SECONDS);
  assert.strictEqual(badWindow.state, "fresh");
  const noTimestamp = forgeHealth.parseForgeHealth(JSON.stringify(contract({ generated_at: "not a date" })), { now: NOW });
  assert.strictEqual(noTimestamp.state, "stale", "An unreadable timestamp cannot prove freshness.");
  assert.strictEqual(noTimestamp.ageSeconds, null);
  const future = forgeHealth.parseForgeHealth(JSON.stringify(contract({ generated_at: "2026-11-09T22:30:00Z" })), { now: NOW });
  assert.strictEqual(future.state, "stale", "A timestamp far in the future is not trusted.");

  // --- Stopped ---------------------------------------------------------------
  const stopped = await forgeHealth.readForgeHealth({
    filePath: writeHealth("stopped.json", contract({ status: "stopped", stopped_at: "2026-11-09T21:29:30Z" })),
    now: NOW,
  });
  assert.strictEqual(stopped.available, true);
  assert.strictEqual(stopped.fresh, false, "stopped is stale even with a recent timestamp.");
  assert.strictEqual(stopped.stale, true);
  assert.strictEqual(stopped.state, "stopped");
  assert.strictEqual(stopped.status, "stopped");
  assert.strictEqual(stopped.reason, "forge_stopped");

  // --- Missing -----------------------------------------------------------------
  const missing = await forgeHealth.readForgeHealth({ filePath: path.join(tempDir, "does-not-exist.json"), now: NOW });
  assert.deepStrictEqual(
    { available: missing.available, fresh: missing.fresh, state: missing.state, reason: missing.reason, status: missing.status, alerts: missing.alerts },
    { available: false, fresh: false, state: "missing", reason: "not_found", status: null, alerts: [] },
  );
  assert.strictEqual(missing.thermals, undefined, "No sections are invented for a missing file.");
  const noPath = await forgeHealth.readForgeHealth({ filePath: null });
  assert.strictEqual(noPath.state, "missing");
  assert.strictEqual(noPath.reason, "path_unavailable");

  // --- Wrong schema / invalid ---------------------------------------------------
  const wrongSchema = await forgeHealth.readForgeHealth({ filePath: writeHealth("schema2.json", contract({ schema: "forge.health/2" })), now: NOW });
  assert.strictEqual(wrongSchema.available, false);
  assert.strictEqual(wrongSchema.state, "invalid");
  assert.strictEqual(wrongSchema.reason, "unsupported_schema");
  assert.strictEqual(wrongSchema.status, null, "An unsupported schema's status is not used.");
  const minorRevision = forgeHealth.parseForgeHealth(JSON.stringify(contract({ schema: "forge.health/1.2", new_field: { x: 1 } })), { now: NOW });
  assert.strictEqual(minorRevision.available, true, "forge.health/1.x stays readable; unknown fields are ignored.");
  assert.strictEqual(minorRevision.new_field, undefined);
  const noSchema = forgeHealth.parseForgeHealth(JSON.stringify({ status: "ok" }), { now: NOW });
  assert.strictEqual(noSchema.reason, "unsupported_schema");
  const badJson = await forgeHealth.readForgeHealth({ filePath: writeHealth("bad.json", "{ not json"), now: NOW });
  assert.strictEqual(badJson.state, "invalid");
  assert.strictEqual(badJson.reason, "invalid_json");
  assert.strictEqual(forgeHealth.parseForgeHealth("[]", { now: NOW }).reason, "invalid_json");
  const tooLarge = await forgeHealth.readForgeHealth({
    filePath: "ignored",
    stat: async () => ({ size: forgeHealth.MAX_FILE_BYTES + 1 }),
    readFile: async () => { throw new Error("must not read an oversized file"); },
  });
  assert.strictEqual(tooLarge.reason, "too_large");
  const denied = await forgeHealth.readForgeHealth({
    filePath: "ignored",
    stat: async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); },
  });
  assert.strictEqual(denied.state, "unreadable");
  assert.strictEqual(denied.errorCode, "EACCES");

  // --- Partial sections -----------------------------------------------------------
  const partialDoc = contract({ status: "warning", thermals: null, kernel: null, crashes: undefined, memory: { pressure: "high" }, alerts: "nope" });
  delete partialDoc.crashes;
  delete partialDoc.boost;
  const partial = forgeHealth.parseForgeHealth(JSON.stringify(partialDoc), { now: NOW });
  assert.strictEqual(partial.available, true);
  assert.strictEqual(partial.status, "warning");
  assert.strictEqual(partial.thermals, null, "A null section stays null.");
  assert.strictEqual(partial.kernel, null);
  assert.strictEqual(partial.crashes, null, "A missing section is unknown (null).");
  assert.strictEqual(partial.boost, null);
  assert.strictEqual(partial.memory.pressure, "high");
  assert.strictEqual(partial.memory.availableBytes, null, "Missing numbers are null, never zero.");
  assert.strictEqual(partial.memory.commitPercent, null);
  assert.deepStrictEqual(partial.alerts, [], "A malformed alerts field yields no alerts.");
  const oddValues = forgeHealth.parseForgeHealth(JSON.stringify(contract({
    status: "melting",
    thermals: { gpu_c: "54", cpu_c: Number.NaN },
    alerts: [null, { severity: "apocalyptic", title: "Odd" }, { detail: "no title or code" }],
  })), { now: NOW });
  assert.strictEqual(oddValues.status, null, "An unknown status is reported as unknown.");
  assert.strictEqual(oddValues.thermals.gpuC, null, "A string temperature is not coerced.");
  assert.strictEqual(oddValues.thermals.cpuC, null);
  assert.deepStrictEqual(oddValues.alerts.map((alert) => [alert.severity, alert.title]), [["info", "Odd"]]);
  const manyAlerts = forgeHealth.parseForgeHealth(JSON.stringify(contract({
    alerts: Array.from({ length: 50 }, (_, index) => ({ severity: "warning", code: `x.${index}`, title: `Alert ${index}` })),
  })), { now: NOW });
  assert.strictEqual(manyAlerts.alerts.length, forgeHealth.MAX_ALERTS);

  // --- GPU temperature source -----------------------------------------------------
  const forgeGpu = forgeHealth.getForgeGpuTemperature(fresh);
  assert.strictEqual(forgeGpu.temperatureCelsius, 54);
  assert.strictEqual(forgeGpu.source, "Project Forge");
  assert.strictEqual(forgeHealth.getForgeGpuTemperature(stale), null, "A stale report is not a temperature source.");
  assert.strictEqual(forgeHealth.getForgeGpuTemperature(stopped), null);
  assert.strictEqual(forgeHealth.getForgeGpuTemperature(partial), null, "No thermals section, no GPU temperature.");
  assert.strictEqual(forgeHealth.getForgeGpuTemperature(missing), null);

  const merged = forgeHealth.mergeForgeGpuTemperature(null, fresh, "win32");
  assert.strictEqual(merged.core.temperatureCelsius, 54);
  assert.strictEqual(merged.hotspot, null);
  const embedded = { core: { temperatureCelsius: 61, sensorName: "GPU Core", source: "Embedded LibreHardwareMonitor" }, hotspot: { temperatureCelsius: 70 } };
  assert.strictEqual(forgeHealth.mergeForgeGpuTemperature(embedded, fresh, "win32"), embedded, "An embedded GPU reading is never replaced.");
  const hotspotOnly = forgeHealth.mergeForgeGpuTemperature({ core: null, hotspot: { temperatureCelsius: 70 } }, fresh, "win32");
  assert.strictEqual(hotspotOnly.core.source, "Project Forge");
  assert.strictEqual(hotspotOnly.hotspot.temperatureCelsius, 70);
  assert.strictEqual(forgeHealth.mergeForgeGpuTemperature(null, fresh, "linux"), null, "Forge GPU fallback is Windows-only.");
  assert.strictEqual(forgeHealth.mergeForgeGpuTemperature(null, stale, "win32"), null);

  // --- Cache ------------------------------------------------------------------------
  let clock = 0;
  let reads = 0;
  const cached = forgeHealth.createCachedForgeHealthReader({ cacheMs: 5000, now: () => clock, reader: async () => { reads += 1; return fresh; } });
  await cached();
  clock = 4999;
  await cached();
  assert.strictEqual(reads, 1, "Reads inside the cache window reuse the last result.");
  clock = 5000;
  await cached();
  assert.strictEqual(reads, 2);
  const throwing = forgeHealth.createCachedForgeHealthReader({ reader: async () => { throw new Error("boom"); } });
  assert.strictEqual((await throwing()).reason, "reader_failed", "A failing reader never throws into the snapshot.");

  // --- Agent system summary ---------------------------------------------------------
  systemService._test.setWindowsHardwareTemperatureReaderForTest(async () => ({
    available: false, status: "unavailable", source: "Embedded LibreHardwareMonitor", timestamp: new Date(NOW).toISOString(), reason: "provider_missing",
  }));
  systemService._test.setForgeHealthReaderForTest(async () => fresh);
  const winSummary = await withPlatform("win32", () => systemService.getSystemSummary());
  assert.strictEqual(winSummary.forge.state, "fresh", "The system summary carries the Forge report.");
  assert.strictEqual(winSummary.forge.alerts[0].code, "kernel.filter_name_leak");
  assert.strictEqual(winSummary.gpu.core.temperatureCelsius, 54, "Fresh Forge GPU temperature fills the missing Windows GPU reading.");
  assert.strictEqual(winSummary.gpu.core.source, "Project Forge");
  assert.strictEqual(winSummary.cpuTempC, null, "Forge does not invent a CPU temperature.");

  systemService._test.setWindowsHardwareTemperatureReaderForTest(async () => ({
    available: false, status: "unavailable", source: "Embedded LibreHardwareMonitor", timestamp: new Date(NOW).toISOString(), reason: "provider_missing",
  }));
  systemService._test.setForgeHealthReaderForTest(async () => stale);
  const staleSummary = await withPlatform("win32", () => systemService.getSystemSummary());
  assert.strictEqual(staleSummary.forge.state, "stale");
  assert.strictEqual(staleSummary.gpu, null, "A stale Forge report adds no GPU temperature.");

  systemService._test.setForgeHealthReaderForTest(async () => missing);
  const missingSummary = await systemService.getSystemSummary();
  assert.strictEqual(missingSummary.forge.available, false);
  assert.strictEqual(missingSummary.forge.state, "missing");
  systemService._test.setForgeHealthReaderForTest(null);
  systemService._test.setWindowsHardwareTemperatureReaderForTest(null);

  // --- Dashboard presentation ----------------------------------------------------------
  const notReported = presentation.describeForgeHealth(undefined);
  assert.strictEqual(notReported.pillLabel, "Unknown");
  assert.strictEqual(notReported.showAlerts, false);
  const notRunning = presentation.describeForgeHealth(missing);
  assert.strictEqual(notRunning.pillLabel, "Not running");
  assert.strictEqual(notRunning.statusLabel, "Forge not running");
  assert.deepStrictEqual(notRunning.alerts, [], "No alerts are shown without a report.");
  assert.strictEqual(presentation.describeForgeHealth(wrongSchema).pillLabel, "Unreadable");

  const freshView = presentation.describeForgeHealth(fresh);
  assert.strictEqual(freshView.pillKey, "critical");
  assert.strictEqual(freshView.statusLabel, "Critical");
  assert.strictEqual(freshView.current, true);
  assert.strictEqual(freshView.updatedLabel, "60s ago");
  assert.strictEqual(freshView.alertsCaption, null);
  assert.deepStrictEqual(freshView.alerts.map((alert) => [alert.severityKey, alert.severityLabel, alert.title, alert.detail]), [
    ["critical", "Critical", "A file-system filter driver is holding millions of file names", "Kernel pools 11.6 GB."],
    ["muted", "Info", "Game Boost running", null],
  ]);
  const okView = presentation.describeForgeHealth({ ...fresh, status: "ok", alerts: [] });
  assert.strictEqual(okView.pillKey, "ok");
  assert.strictEqual(okView.showAlerts, false);

  const stoppedView = presentation.describeForgeHealth(stopped);
  assert.strictEqual(stoppedView.pillLabel, "Stopped");
  assert.strictEqual(stoppedView.statusLabel, "Forge stopped");
  assert.strictEqual(stoppedView.current, false);
  assert.ok(/last report/i.test(stoppedView.alertsCaption) && /out of date/i.test(stoppedView.alertsCaption), "Old alerts are labelled as not current.");
  const staleView = presentation.describeForgeHealth(stale);
  assert.strictEqual(staleView.pillLabel, "Stale");
  assert.strictEqual(staleView.updatedLabel, "10m ago");

  assert.strictEqual(presentation.describeGpuTemperature(null).text, "Not reported");
  assert.strictEqual(presentation.describeGpuTemperature({ core: { temperatureCelsius: null } }).text, "Not reported", "null GPU temperature is not shown as 0°C.");
  const gpuView = presentation.describeGpuTemperature(winSummary.gpu);
  assert.strictEqual(gpuView.text, "54°C");
  assert.ok(gpuView.title.includes("Project Forge"));
  const localGpuView = presentation.describeGpuTemperature({ core: { temperatureCelsius: 61.4, temperatureSource: "Embedded LibreHardwareMonitor", temperatureSensor: "GPU Core" } });
  assert.strictEqual(localGpuView.text, "61°C");
  assert.ok(localGpuView.title.startsWith("GPU Core"));

  // --- Renderer wiring (static) -------------------------------------------------------------
  const root = path.join(__dirname, "..");
  const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
  assert.ok(indexHtml.indexOf("src/shared/forgeHealthPresentation.js") > -1 && indexHtml.indexOf("src/shared/forgeHealthPresentation.js") < indexHtml.indexOf('src="app.js"'), "Presentation loads before app.js.");
  assert.ok(indexHtml.includes("data-forge-health-card"), "Dashboard has the Forge card.");
  assert.ok(indexHtml.includes('data-field="gpuTemperature"'), "Dashboard shows GPU temperature.");
  assert.ok(appSource.includes("renderForgeHealth(safeSnapshot.forge)"), "renderSnapshot renders the Forge card.");
  assert.ok(!/innerHTML[^;\n]*alert/.test(appSource.slice(appSource.indexOf("function renderForgeHealth"), appSource.indexOf("function renderForgeHealth") + 4000)), "Forge alert text is set with textContent, not innerHTML.");

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log("Forge health reader smoke passed.");
}

main().catch((error) => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  console.error(error);
  process.exit(1);
});
