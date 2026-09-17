const assert = require("assert");

// Pin runtime roots before service modules load (eb13b83 job-store leak lesson).
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-marketplace-disk-preflight-");

const agentClient = require("../src/services/agentClient");
const marketplaceInstallService = require("../src/services/marketplaceInstallService");

async function main() {
  const originalGetSystemStats = agentClient.getSystemStats;
  try {
    agentClient.getSystemStats = async () => ({ disk: { availableBytes: 16 * 1024 ** 3, totalBytes: 32 * 1024 ** 3, mount: "/" } });
    const passed = await marketplaceInstallService._test.assertProviderInstallDiskSpace({}, { nodeId: "node-a" });
    assert.strictEqual(passed.requiredFreeBytes, 8 * 1024 ** 3);
    assert.strictEqual(passed.freeBytes, 16 * 1024 ** 3);

    agentClient.getSystemStats = async () => ({ disk: { availableBytes: 2 * 1024 ** 3 } });
    await assert.rejects(
      () => marketplaceInstallService._test.assertProviderInstallDiskSpace({}, { nodeId: "node-a" }),
      (error) => error?.code === "INSUFFICIENT_DISK_SPACE" && error?.details?.retryable === false,
    );

    agentClient.getSystemStats = async () => ({ disk: {} });
    await assert.rejects(
      () => marketplaceInstallService._test.assertProviderInstallDiskSpace({}, { nodeId: "node-a" }),
      (error) => error?.code === "DISK_SPACE_CHECK_UNAVAILABLE" && error?.details?.retryable === true,
    );
  } finally {
    agentClient.getSystemStats = originalGetSystemStats;
  }

  console.log("Marketplace provider disk preflight smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
