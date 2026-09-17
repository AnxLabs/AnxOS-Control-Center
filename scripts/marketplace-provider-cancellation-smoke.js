const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-marketplace-cancel-"));
process.env.ANXHUB_CONFIG_DIR = root;
// Pin runtime roots before service modules load (eb13b83 job-store leak lesson).
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-marketplace-cancel-roots-");

const longOperations = require("../src/shared/longOperationService");
const marketplaceInstallService = require("../src/services/marketplaceInstallService");
const marketplaceService = require("../src/services/marketplaceService");

async function main() {
  let retryAttempts = 0;
  const install = marketplaceInstallService._test.createProviderInstallOperation({
    providerProjectId: "secret-project",
    name: "Cancellation Smoke",
  }, {
    nodeId: "node-a",
    instanceId: "cancel-smoke",
    retry: async () => ({ attemptId: `attempt-${++retryAttempts}` }),
  });

  const listed = marketplaceService.getDownloads("node-a").downloads.find((entry) => entry.id === install.operation.id);
  assert(listed, "Provider install must be visible through the shared Download Manager registry.");
  assert.strictEqual(listed.canCancel, true);
  assert.strictEqual(install.signal.aborted, false);

  marketplaceService.cancelDownload(install.operation.id, { nodeId: "node-a" });
  assert.strictEqual(install.signal.aborted, true, "Cancellation must abort the underlying task signal.");
  assert.throws(
    () => marketplaceInstallService._test.throwIfInstallCancelled(install.signal),
    (error) => error?.code === "INSTALL_CANCELLED" && error?.details?.retryable === true,
  );
  const retried = await longOperations.retryOperation(install.operation.id);
  assert.deepStrictEqual(retried, { attemptId: "attempt-1" }, "Retry must invoke a new execution handler.");
  assert.strictEqual(retryAttempts, 1, "Retry must not merely reset the old operation status.");

  const persisted = JSON.stringify(longOperations._test.sanitizeForPersistence(longOperations.getOperation(install.operation.id)));
  assert(!persisted.includes("AbortController"), "Runtime cancellation handles must not be persisted.");
  longOperations.deleteOperation(install.operation.id);
  console.log("Marketplace provider cancellation smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
