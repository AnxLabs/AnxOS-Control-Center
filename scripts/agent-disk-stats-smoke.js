const assert = require("assert");
const childProcess = require("child_process");
const fsPromises = require("fs/promises");
const path = require("path");

const root = path.resolve(__dirname, "..");
const servicePath = path.join(root, "agent", "src", "services", "systemService.js");

function setPlatform(value) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
  return () => Object.defineProperty(process, "platform", descriptor);
}

function reloadSystemService() {
  delete require.cache[require.resolve(servicePath)];
  return require(servicePath);
}

async function withPatchedRuntime(platform, patches, fn) {
  const restorePlatform = setPlatform(platform);
  const originalExecFile = childProcess.execFile;
  const originalStatfs = fsPromises.statfs;
  const originalStat = fsPromises.stat;
  try {
    if (patches.execFile) childProcess.execFile = patches.execFile;
    if (patches.statfs) fsPromises.statfs = patches.statfs;
    if (patches.stat) fsPromises.stat = patches.stat;
    const systemService = reloadSystemService();
    if (platform === "win32") {
      // getSystemSummary() also reads CPU temperature on Windows, which is an
      // unrelated feature that legitimately shells out via its own dedicated
      // test seam. This test only asserts disk-stats behavior, so give CPU
      // temperature reading a benign "no provider" response instead of
      // letting it hit this test's disk-only execFile guard/mocks.
      systemService._test.setWindowsHardwareTemperatureReaderForTest(async () => ({
        available: false,
        reason: "mocked_no_hardware_monitor_provider",
        source: "test",
      }));
    }
    await fn(systemService);
  } finally {
    childProcess.execFile = originalExecFile;
    fsPromises.statfs = originalStatfs;
    fsPromises.stat = originalStat;
    delete require.cache[require.resolve(servicePath)];
    restorePlatform();
  }
}

async function main() {
  const windowsPath = "C:\\Users\\anjor\\AppData\\Roaming\\AnxHub\\agent\\instances";

  await withPatchedRuntime("win32", {
    execFile: () => { throw new Error("df must not be spawned for Windows disk stats"); },
    statfs: async (targetPath) => {
      assert.strictEqual(targetPath, "C:\\");
      return { bsize: 4096, blocks: 1000, bavail: 250, bfree: 300 };
    },
  }, async (systemService) => {
    assert.strictEqual(systemService._test.resolveDiskRoot(windowsPath, "win32"), "C:\\");
    const disk = await systemService._test.getDiskUsage(windowsPath);
    assert.deepStrictEqual(disk, {
      mount: "C:\\",
      total: 4096000,
      used: 3072000,
      free: 1024000,
      percent: 75,
    });
    const summary = await systemService.getSystemSummary();
    assert(summary && summary.source === "agent", "full system stats should still return on Windows");
  });

  await withPatchedRuntime("win32", {
    execFile: () => { throw new Error("df must not be spawned for Windows disk stats failures"); },
    statfs: async () => { throw new Error("native statfs unavailable"); },
  }, async (systemService) => {
    systemService._test.diskStatsWarningState.clear();
    const disk = await systemService._test.getDiskUsage(windowsPath);
    assert.strictEqual(disk, null, "Windows disk lookup should degrade safely");
    const summary = await systemService.getSystemSummary();
    assert(summary && summary.source === "agent", "disk enrichment failure must not fail system stats");
    assert(
      [...systemService._test.diskStatsWarningState.keys()].some((key) => key.includes("windows_disk_lookup_failed")),
      "Windows disk lookup failures should be categorized and suppressible",
    );
  });

  await withPatchedRuntime("linux", {
    stat: async () => ({}),
    statfs: async () => { throw new Error("statfs unsupported in this smoke"); },
    execFile: (command, args, options, callback) => {
      assert.strictEqual(command, "df");
      // The service's path module follows the host OS even when this test
      // simulates Linux on Windows. Assert the normalized path for that host
      // rather than hard-coding POSIX separators.
      assert.deepStrictEqual(args, ["-kP", path.resolve("/srv/anxos")]);
      callback(null, "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 1000 250 750 25% /srv\n", "");
    },
  }, async (systemService) => {
    const disk = await systemService._test.getDiskUsage("/srv/anxos");
    assert.strictEqual(disk.mount, "/srv");
    assert.strictEqual(disk.total, 1024000);
    assert.strictEqual(disk.free, 768000);
  });

  console.log("Agent disk stats smoke checks passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
