const assert = require("assert");
const fs = require("fs");
const path = require("path");

// Pin runtime roots before service modules load (eb13b83 job-store leak lesson).
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-marketplace-manual-session-");

const marketplaceInstallService = require("../src/services/marketplaceInstallService");

function main() {
  const session = marketplaceInstallService._test.createPendingManualInstall({
    provider: "modrinth",
    nodeId: "node-a",
    instanceId: "manual-target-smoke",
    manual: {
      provider: "modrinth",
      fileName: "server-pack.zip",
      projectUrl: "https://modrinth.com/modpack/example",
    },
  });

  assert.strictEqual(
    marketplaceInstallService._test.getPendingManualInstall(session.id, { nodeId: "node-a" }).id,
    session.id,
    "The owning node should be able to recover its manual install session.",
  );
  assert.throws(
    () => marketplaceInstallService._test.getPendingManualInstall(session.id, { nodeId: "node-b" }),
    (error) => error?.code === "PROVIDER_MANUAL_SESSION_NODE_MISMATCH"
      && error?.details?.sessionNodeId === "node-a",
    "A different selected node must not operate on the session.",
  );

  const ipcSource = fs.readFileSync(path.join(__dirname, "..", "src", "ipc", "marketplaceIpc.js"), "utf8");
  const preloadSource = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  const rendererSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  for (const operation of [
    "Marketplace manual download recovery",
    "Marketplace manual file import",
    "Marketplace manual install resume",
  ]) {
    assert(ipcSource.includes(`requireNodeContext(payload, "${operation}")`), `${operation} must require explicit node context.`);
  }
  assert(preloadSource.includes("openManualDownloadPage: (sessionId, payload = {})"), "Preload must accept node context for manual recovery.");
  assert(rendererSource.includes('createNodeActionContext("marketplace-manual-install-resume")'), "Renderer must bind resume to the selected node generation.");

  console.log("Marketplace manual-session target smoke checks passed.");
}

main();
