#!/usr/bin/env node
"use strict";

// Regression for the Agent's rate metrics (Phase 4.1).
//   M1 CPU: the first reading is null ("warming_up"), later readings give a
//      total and per-core percent, and two clients polling close together
//      share one sample instead of resetting each other's baseline;
//   M2 network: Linux /proc/net/dev and Windows `netstat -e` are parsed;
//      the first reading, a wrapped counter and an unsupported platform give
//      null rates with a reason, never 0;
//   M3 GPU: nvidia-smi rows are parsed ([N/A] stays null), a missing tool is
//      "no_supported_gpu_tool", and results are cached;
//   M4 the Agent summary uses these samplers.
// All readers are injected; nothing here measures the real machine.
// Run: node scripts/agent-metrics-sampler-smoke.js

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const sampler = require(path.join(root, "src", "shared", "metricsSampler.js"));

function clock(start = 1000) {
  let now = start;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

async function main() {
  // M1
  const time = clock();
  let cpus = [{ times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }, { times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } }];
  const sampleCpu = sampler.createCpuSampler({ readCpus: () => cpus, now: time.now });
  time.advance(1000);
  assert.deepStrictEqual(sampleCpu(), { usagePercent: null, perCore: [], reason: "warming_up" }, "no time passed on the CPUs yet");
  time.advance(1000);
  cpus = [{ times: { user: 50, nice: 0, sys: 0, idle: 50, irq: 0 } }, { times: { user: 0, nice: 0, sys: 0, idle: 100, irq: 0 } }];
  const busy = sampleCpu();
  assert.deepStrictEqual(busy, { usagePercent: 25, perCore: [50, 0], reason: null });
  time.advance(100);
  cpus = [{ times: { user: 51, nice: 0, sys: 0, idle: 50, irq: 0 } }, { times: { user: 0, nice: 0, sys: 0, idle: 101, irq: 0 } }];
  assert.strictEqual(sampleCpu(), busy, "a second client within the interval reuses the sample");
  time.advance(1000);
  cpus = [{ times: { user: 1, nice: 0, sys: 0, idle: 1, irq: 0 } }];
  assert.strictEqual(sampleCpu().reason, "cpu_topology_changed");
  console.log("PASS M1 CPU total and per-core, warming up, shared sample");

  // M2
  const procNetDev = (rx, tx) => `Inter-|   Receive\n face |bytes packets\n    lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0\n  eth0: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0\n`;
  assert.deepStrictEqual(sampler._test.parseProcNetDev(procNetDev(100, 200)), { download: 100, upload: 200 }, "loopback is ignored");
  const netstat = "Interface Statistics\n\n                           Received            Sent\n\nBytes                    3282772890      3755841716\nUnicast packets             1234            5678\n";
  assert.deepStrictEqual(sampler._test.parseNetstatE(netstat), { download: 3282772890, upload: 3755841716 });
  assert.deepStrictEqual(sampler._test.parseNetstatE("Schnittstellenstatistik\n\nBytes empfangen        5000000      7000000\n"), { download: 5000000, upload: 7000000 }, "a localized Bytes row is read");
  assert.strictEqual(sampler._test.parseNetstatE("Interface Statistics\n\nReceived 12 Sent 34\n"), null, "an unrecognised layout is not guessed");
  assert.deepStrictEqual(sampler._test.parseNetstatE("Statistiques\n\nOctets                    5000000      7000000\n"), { download: 5000000, upload: 7000000 }, "a localized label with two byte counters is read");
  assert.strictEqual(sampler._test.parseNetstatE("nothing here"), null);

  const netTime = clock();
  let rx = 1000;
  let tx = 2000;
  const sampleLinux = sampler.createNetworkSampler({ platform: "linux", readFile: async () => procNetDev(rx, tx), now: netTime.now });
  let reading = await sampleLinux();
  assert.strictEqual(reading.downloadPerSecond, null, "the first reading has no rate");
  assert.strictEqual(reading.reason, "warming_up");
  netTime.advance(2000);
  rx += 4000;
  tx += 1000;
  reading = await sampleLinux();
  assert.deepStrictEqual([reading.downloadPerSecond, reading.uploadPerSecond, reading.source], [2000, 500, "proc_net_dev"]);
  netTime.advance(2000);
  rx = 10;
  reading = await sampleLinux();
  assert.strictEqual(reading.downloadPerSecond, null, "a wrapped counter gives no rate");
  assert.strictEqual(reading.reason, "counter_reset");

  const sampleMac = sampler.createNetworkSampler({ platform: "darwin", now: netTime.now });
  reading = await sampleMac();
  assert.deepStrictEqual([reading.supported, reading.uploadPerSecond, reading.reason], [false, null, "unsupported_platform"], "unsupported platforms report null, not 0");

  const winTime = clock();
  let bytes = 1000000;
  const sampleWindows = sampler.createNetworkSampler({ platform: "win32", now: winTime.now, execFile: async () => ({ ok: true, stdout: `Bytes   ${bytes}   ${bytes * 2}\n` }) });
  await sampleWindows();
  winTime.advance(1000);
  bytes += 1000;
  reading = await sampleWindows();
  assert.deepStrictEqual([reading.downloadPerSecond, reading.uploadPerSecond, reading.source], [1000, 2000, "netstat_e"]);
  const failingWindows = sampler.createNetworkSampler({ platform: "win32", now: winTime.now, execFile: async () => ({ ok: false, stdout: "" }) });
  reading = await failingWindows();
  assert.deepStrictEqual([reading.supported, reading.downloadPerSecond, reading.reason], [true, null, "counters_unreadable"]);
  console.log("PASS M2 network rates are real or null with a reason, never 0");

  // M3
  const rows = "NVIDIA GeForce RTX 3060, 37, 2048, 12288, 61\nTesla T4, [N/A], 100, 15360, [Not Supported]\n";
  const devices = sampler._test.parseNvidiaSmi(rows);
  assert.strictEqual(devices.length, 2);
  assert.deepStrictEqual(devices[0], { vendor: "nvidia", name: "NVIDIA GeForce RTX 3060", utilizationPercent: 37, memoryUsedBytes: 2048 * 1048576, memoryTotalBytes: 12288 * 1048576, temperatureCelsius: 61 });
  assert.strictEqual(devices[1].utilizationPercent, null, "[N/A] stays null");
  assert.strictEqual(devices[1].temperatureCelsius, null, "[Not Supported] stays null");
  const gpuTime = clock();
  let gpuCalls = 0;
  const sampleGpu = sampler.createGpuSampler({ now: gpuTime.now, execFile: async () => { gpuCalls += 1; return { ok: true, stdout: rows }; } });
  assert.strictEqual((await sampleGpu()).available, true);
  gpuTime.advance(1000);
  await sampleGpu();
  assert.strictEqual(gpuCalls, 1, "nvidia-smi results are cached");
  const noTool = sampler.createGpuSampler({ execFile: async () => ({ ok: false, code: "ENOENT", stdout: "" }) });
  assert.deepStrictEqual(await noTool().then((value) => [value.available, value.reason]), [false, "no_supported_gpu_tool"]);
  console.log("PASS M3 NVIDIA GPU usage parsed, missing tools reported, cached");

  // M4
  const systemSource = fs.readFileSync(path.join(root, "agent", "src", "services", "systemService.js"), "utf8");
  assert.ok(systemSource.includes("usagePercent: cpuSample.usagePercent") && systemSource.includes("perCore: cpuSample.perCore"));
  assert.ok(systemSource.includes("sampleNetwork(),") && systemSource.includes("gpuUsage,"));
  assert.ok(!/uploadPerSecond:\s*0\b/.test(systemSource), "the Agent summary never reports a made-up 0 rate");
  console.log("PASS M4 the Agent summary uses the shared samplers");

  console.log("Agent metrics sampler smoke passed (4 checks).");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
