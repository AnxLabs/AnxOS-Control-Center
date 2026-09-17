const assert = require("assert");

// Pin runtime roots before service modules load (eb13b83 job-store leak lesson).
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-marketplace-cleanup-reporting-");

const agentClient = require("../src/services/agentClient");
const marketplaceInstallService = require("../src/services/marketplaceInstallService");

async function main() {
  const originalDeleteInstance = agentClient.deleteInstance;
  const originalUpdateInstance = agentClient.updateInstance;
  try {
    agentClient.deleteInstance = async () => ({ deleted: true });
    const success = await marketplaceInstallService._test.cleanupIncompleteInstance("cleanup-success", { nodeId: "node-a" });
    assert.deepStrictEqual(success, {
      attempted: true,
      succeeded: true,
      instanceId: "cleanup-success",
    });

    agentClient.deleteInstance = async () => {
      const error = new Error("Authorization: Bearer cleanup-secret-token");
      error.code = "AGENT_UNAVAILABLE";
      error.details = { authorization: "Bearer cleanup-secret-token" };
      throw error;
    };
    const failed = await marketplaceInstallService._test.cleanupIncompleteInstance("cleanup-failed", { nodeId: "node-a" });
    assert.strictEqual(failed.attempted, true);
    assert.strictEqual(failed.succeeded, false);
    assert.strictEqual(failed.error.code, "AGENT_UNAVAILABLE");
    assert(!JSON.stringify(failed).includes("cleanup-secret-token"), "Cleanup diagnostics must redact credentials.");
    assert(failed.suggestion.includes("Delete the incomplete instance"));

    let retainedPatch = null;
    agentClient.updateInstance = async (_id, patch) => {
      retainedPatch = patch;
      return { instance: { id: "retained-failure", ...patch } };
    };
    const retained = await marketplaceInstallService._test.retainIncompleteInstance("retained-failure", "DOWNLOAD_FAILED: interrupted", { nodeId: "node-a" });
    assert.strictEqual(retained.succeeded, true);
    assert.strictEqual(retainedPatch.installationState, "failed");
    assert.strictEqual(retainedPatch.installStage, "Failed");
    assert.match(retainedPatch.lastInstallError, /DOWNLOAD_FAILED/);
  } finally {
    agentClient.deleteInstance = originalDeleteInstance;
    agentClient.updateInstance = originalUpdateInstance;
  }

  console.log("Marketplace cleanup reporting smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
