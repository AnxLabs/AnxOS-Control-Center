const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const instanceService = require("../src/shared/instances/instanceServiceCore");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForStatus(instanceId, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let status = null;
  do {
    status = await instanceService.getStatus(instanceId);
    if (predicate(status)) return status;
    await wait(50);
  } while (Date.now() < deadline);
  return status;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-instance-health-"));
  instanceService.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });

  await instanceService.createInstance({
    id: "ready-health-smoke",
    name: "Ready Health Smoke",
    type: "custom-command",
    executable: process.execPath,
    args: ["-e", "console.log('Done (0.1s)! For help, type help'); setInterval(() => {}, 1000)"],
    startupTimeoutMs: 1000,
  });
  await instanceService.startInstance("ready-health-smoke");
  const ready = await waitForStatus("ready-health-smoke", (status) => status?.readinessState === "ready");
  assert.strictEqual(ready.processState, "Running");
  assert.strictEqual(ready.readinessState, "ready");
  assert.strictEqual(ready.healthState, "healthy");
  assert.strictEqual(ready.serverReady, true);
  await instanceService.stopInstance("ready-health-smoke");

  await instanceService.createInstance({
    id: "degraded-health-smoke",
    name: "Degraded Health Smoke",
    type: "custom-command",
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    startupTimeoutMs: 50,
  });
  await instanceService.startInstance("degraded-health-smoke");
  const degraded = await waitForStatus("degraded-health-smoke", (status) => status?.readinessState === "timeout");
  assert.strictEqual(degraded.processState, "Running");
  assert.strictEqual(degraded.readinessState, "timeout");
  assert.strictEqual(degraded.healthState, "degraded");
  assert.strictEqual(degraded.serverReady, false);
  await instanceService.stopInstance("degraded-health-smoke");

  await instanceService.deleteInstance("ready-health-smoke");
  await instanceService.deleteInstance("degraded-health-smoke");
  instanceService.disposeInstanceService();
  fs.rmSync(root, { recursive: true, force: true });
  console.log("Instance health state smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
