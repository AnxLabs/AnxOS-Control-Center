const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-instance-shutdown-"));
const service = require("../src/shared/instances/instanceServiceCore");
service.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });
process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function main() {
  await service.createInstance({
    id: "shutdown-smoke",
    displayName: "Shutdown Smoke",
    type: "custom-command",
    executable: process.execPath,
    args: ["-e", "console.log('Server started'); setInterval(() => {}, 1000)"],
    startupTimeoutMs: 10000,
    shutdownTimeoutMs: 10000,
  });
  const started = await service.startInstance("shutdown-smoke");
  assert(started.pid && alive(started.pid), "The test instance should be running before shutdown.");
  assert(service._test.getResourceCounts().versionRefreshTimers > 0, "Instance startup should own its delayed version refresh timer.");
  const result = await service.shutdownInstanceService({ timeoutMs: 2000 });
  assert.strictEqual(result.stopped, 1, "Shared shutdown should stop its owned instance.");
  assert.strictEqual(alive(started.pid), false, "Owned instance processes must not survive service shutdown.");
  const persisted = JSON.parse(fs.readFileSync(path.join(root, "shutdown-smoke", "config.json"), "utf8"));
  assert.strictEqual(persisted.state, service.INSTANCE_STATES.STOPPED, "Shutdown should persist an intentional stopped state.");
  assert.strictEqual(persisted.pid, null, "Shutdown should clear the persisted PID.");
  assert.deepStrictEqual(service._test.getResourceCounts(), { restartTimers: 0, versionRefreshTimers: 0, runningProcesses: 0 }, "Instance shutdown must release every owned timer and process record.");

  const alreadyStopped = await service.stopInstance("shutdown-smoke");
  assert.strictEqual(alreadyStopped.processState, service.INSTANCE_STATES.STOPPED, "Stopping an already-stopped instance must be idempotent.");

  const duplicateStopStart = await service.startInstance("shutdown-smoke");
  const concurrentStops = await Promise.all([
    service.stopInstance("shutdown-smoke", { timeoutMs: 2000 }),
    service.stopInstance("shutdown-smoke", { timeoutMs: 2000 }),
  ]);
  assert(concurrentStops.every((entry) => entry.processState === service.INSTANCE_STATES.STOPPED), "Duplicate stop requests must converge on Stopped.");
  assert.strictEqual(alive(duplicateStopStart.pid), false, "Duplicate stop requests must not leave a stale process.");

  const restarted = await service.restartInstance("shutdown-smoke");
  assert(restarted.pid && alive(restarted.pid), "Restart must start a fresh authorized process.");
  await service.stopInstance("shutdown-smoke", { timeoutMs: 2000 });
  const cycled = await service.startInstance("shutdown-smoke");
  assert(cycled.pid && alive(cycled.pid), "A repeated lifecycle cycle must remain startable.");
  let readiness = await service.getStatus("shutdown-smoke");
  for (let attempt = 0; attempt < 20 && readiness.processState !== service.INSTANCE_STATES.RUNNING; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    readiness = await service.getStatus("shutdown-smoke");
  }
  assert.strictEqual(readiness.processState, service.INSTANCE_STATES.RUNNING, "The real Node workload must report a truthful running state.");
  await service.stopInstance("shutdown-smoke", { timeoutMs: 2000 });

  await service.createInstance({
    id: "stop-timeout-smoke",
    displayName: "Stop Timeout Smoke",
    type: "custom-command",
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    shutdownTimeoutMs: 1000,
  });
  const timeoutPath = path.join(root, "stop-timeout-smoke", "config.json");
  const timeoutConfig = JSON.parse(fs.readFileSync(timeoutPath, "utf8"));
  fs.writeFileSync(timeoutPath, `${JSON.stringify({ ...timeoutConfig, state: service.INSTANCE_STATES.RUNNING, pid: 999999 }, null, 2)}\n`);
  const originalKill = process.kill;
  const timeoutKeepAlive = setInterval(() => {}, 1000);
  service._test.setProcessAliveProvider((pid) => Number(pid) === 999999);
  // The fabricated PID 999999 must also be visible to the real process-snapshot
  // authority used by identity reconciliation, or Linux (/proc) will reconcile the
  // fake PID to Stopped and the unresponsive branch is never exercised. Injecting a
  // controlled snapshot keeps this contract test host-independent.
  service._test.setProcessInspectionProvider(async () => ({
    processes: [{
      pid: 999999,
      name: path.basename(process.execPath),
      exe: process.execPath,
      commandLine: [process.execPath, "-e", "setInterval(() => {}, 1000)"].join(" "),
      args: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
      cwd: path.dirname(process.execPath),
    }],
    ports: [],
  }));
  process.kill = () => true;
  try {
    await assert.rejects(
      () => service.stopInstance("stop-timeout-smoke", { timeoutMs: 1 }),
      (error) => error?.code === "INSTANCE_STOP_FAILED",
      "An unresponsive process must produce a specific stop failure.",
    );
  } finally {
    clearInterval(timeoutKeepAlive);
    process.kill = originalKill;
    service._test.setProcessAliveProvider(null);
    service._test.setProcessInspectionProvider(null);
  }
  const timeoutPersisted = JSON.parse(fs.readFileSync(timeoutPath, "utf8"));
  assert.strictEqual(timeoutPersisted.state, service.INSTANCE_STATES.RUNNING, "A stop timeout must not remain stuck in Stopping while the process is proven alive.");
  assert.strictEqual(timeoutPersisted.failureReason, "INSTANCE_STOP_FAILED");
  assert.strictEqual(timeoutPersisted.failureDetails?.timeoutMs, 1);

  await service.createInstance({
    id: "failed-install-smoke",
    displayName: "Failed Install Smoke",
    type: "node-app",
    executable: process.execPath,
    args: ["missing-entrypoint.js"],
    installationState: "installing",
    installStage: "download",
    installationOperationId: "shutdown-smoke-operation",
  });
  const failedRecovery = await service.recoverIncompleteInstallations();
  assert(failedRecovery.repaired.some((entry) => entry.instanceId === "failed-install-smoke"), "Interrupted installation must be retained for inspection.");
  const failedInstall = await service.getStatus("failed-install-smoke");
  assert.strictEqual(failedInstall.installationState, "failed");
  assert.match(failedInstall.lastInstallError, /^INSTALLATION_INTERRUPTED:/);
  await assert.rejects(
    () => service.startInstance("failed-install-smoke"),
    (error) => error?.code === "INSTANCE_INSTALLATION_FAILED",
    "A retained failed installation must not start.",
  );

  const liveRemoval = await service.deleteInstance("shutdown-smoke");
  const failedRemoval = await service.deleteInstance("failed-install-smoke");
  assert(liveRemoval.success && liveRemoval.filesDeleted, "Stopped workload removal must clean its managed resources.");
  assert(failedRemoval.success && failedRemoval.filesDeleted, "Failed installation removal must clean its retained resources.");
  assert.deepStrictEqual(service._test.getResourceCounts(), { restartTimers: 0, versionRefreshTimers: 0, runningProcesses: 0 }, "Acceptance must leave no managed process or timer resources.");

  console.log(JSON.stringify({
    status: "PASS",
    provider: "local node-app workload",
    lifecycle: ["install-record", "activate", "start", "readiness", "stop", "restart", "stop", "remove"],
    repeatedCycles: 2,
    failedInstallRetained: true,
    failedInstallStartRejected: true,
    failedInstallRemoved: true,
    residualManagedProcesses: 0,
  }, null, 2));
}

main().finally(async () => {
  await service.shutdownInstanceService({ timeoutMs: 1000 }).catch(() => {});
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
