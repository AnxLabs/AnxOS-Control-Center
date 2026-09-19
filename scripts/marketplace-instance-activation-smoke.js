const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const instanceService = require("../src/shared/instances/instanceServiceCore");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-marketplace-activation-"));
  instanceService.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });

  await instanceService.createInstance({
    id: "activation-smoke",
    name: "Activation Smoke",
    type: "node-app",
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 1000)"],
    installationState: "installing",
  });
  assert.strictEqual((await instanceService.listInstances()).instances.length, 0, "Incomplete installs must not appear in normal instance listings.");
  await assert.rejects(
    () => instanceService.startInstance("activation-smoke"),
    (error) => error?.code === "INSTANCE_INSTALLATION_INCOMPLETE",
    "Incomplete installs must not be startable by direct id.",
  );

  await instanceService.updateInstance("activation-smoke", { installationState: "active" });
  const active = (await instanceService.listInstances()).instances;
  assert.strictEqual(active.length, 1, "Verified activation must make the instance visible atomically.");
  assert.strictEqual(active[0].installationState, "active");

  await instanceService.deleteInstance("activation-smoke");
  await instanceService.createInstance({
    id: "interrupted-install-smoke",
    name: "Interrupted Install Smoke",
    type: "node-app",
    executable: process.execPath,
    args: ["-e", "process.exit(0)"],
    installationState: "installing",
  });
  const recovery = await instanceService.recoverIncompleteInstallations();
  assert.deepStrictEqual(recovery.failures, []);
  assert(recovery.repaired.some((entry) => entry.instanceId === "interrupted-install-smoke"));
  const recovered = (await instanceService.listInstances()).instances.find((entry) => entry.id === "interrupted-install-smoke");
  assert(recovered, "Startup recovery must retain an interrupted install for inspection or removal.");
  assert.strictEqual(recovered.installationState, "failed");
  assert.strictEqual(recovered.installStage, "interrupted");
  assert.match(recovered.lastInstallError, /INSTALLATION_INTERRUPTED/, "Recovery must retain a specific failure code.");
  await assert.rejects(
    () => instanceService.startInstance("interrupted-install-smoke"),
    (error) => error?.code === "INSTANCE_INSTALLATION_FAILED",
    "A retained failed install must remain non-startable until repaired or removed.",
  );
  const secondRecovery = await instanceService.recoverIncompleteInstallations();
  assert.deepStrictEqual(secondRecovery, { repaired: [], failures: [] }, "Recovery must be idempotent.");
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log("Marketplace instance activation smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
