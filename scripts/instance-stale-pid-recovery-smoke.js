const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const instanceService = require("../src/shared/instances/instanceServiceCore");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-stale-pid-"));
  instanceService.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });
  await instanceService.createInstance({
    id: "stale-pid-smoke",
    name: "Stale PID Smoke",
    type: "custom-command",
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
  });

  const configPath = path.join(root, "stale-pid-smoke", "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  fs.writeFileSync(configPath, `${JSON.stringify({ ...config, state: "Running", pid: 2147483647 }, null, 2)}\n`);
  const repaired = await instanceService.getStatus("stale-pid-smoke");
  // A dead PID is authoritative proof the runtime is gone: reconciliation now
  // lands on Stopped (startable, updatable) instead of a blocking Unknown,
  // while STALE_PID survives as the last-operation evidence.
  assert.strictEqual(repaired.processState, "Stopped");
  assert.strictEqual(repaired.lifecycleState, "Stopped");
  assert.strictEqual(repaired.healthState, "unknown");
  assert.strictEqual(repaired.failureReason, "STALE_PID");
  assert.strictEqual(repaired.pid, null);
  assert.strictEqual(repaired.processRunning, false);

  await instanceService.deleteInstance("stale-pid-smoke");
  fs.rmSync(root, { recursive: true, force: true });
  console.log("Instance stale PID recovery smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
