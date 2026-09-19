const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-marketplace-credential-refresh-"));
process.env.ANXHUB_CONFIG_DIR = root;
// Pin runtime roots before service modules load (eb13b83 job-store leak lesson).
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-marketplace-credential-refresh-roots-");

const nodeService = require("../src/services/nodeService");
const credentials = require("../src/services/nodeCredentialStore");
const marketplace = require("../src/services/marketplaceInstallService");
const agentClient = require("../src/services/agentClient");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;
  const originalConsoleInfo = console.info;
  const records = [];
  const logs = [];

  try {
    writeJson(nodeService.getNodesPath(), {
      schemaVersion: 2,
      selectedNodeId: "anxlab",
      nodes: [
        {
          id: "anxlab",
          kind: "agent",
          displayName: "Anxlab",
          agentUrl: "http://192.168.1.134:47131",
          baseUrl: "http://192.168.1.134:47131",
          enabled: true,
          agentIdentity: { deviceId: "device-anxlab", hostname: "Anxlab" },
        },
      ],
      removedLocalAgents: [],
    });
    writeJson(agentClient.getAgentConfigPath(), {
      backendMode: "agent",
      agentUrl: "http://127.0.0.1:47131",
      agentToken: "global-stale-token",
    });

    console.error = (...args) => { logs.push(args.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join(" ")); };
    console.info = (...args) => { logs.push(args.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join(" ")); };

    global.fetch = async (url, options = {}) => {
      const endpoint = String(url);
      const body = options.body ? JSON.parse(options.body) : null;
      const auth = options.headers?.Authorization || "";
      records.push({ endpoint, auth, body });
      assert.notStrictEqual(auth, "Bearer global-stale-token", "Marketplace must not use the global configured-Agent token for a selected node.");
      if (endpoint !== "http://192.168.1.134:47131/api/v1/dependencies/check") {
        throw new Error(`Unexpected Agent request: ${endpoint}`);
      }
      assert.strictEqual(body.nodeId, "anxlab", "Dependency check payload should carry the selected nodeId.");
      if (auth === "Bearer rotated-token" || auth === "Bearer repaired-token" || auth === "Bearer paired-token") {
        return new Response(JSON.stringify({ ok: true, dependencies: [{ id: "java", installed: true, state: "installed" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Agent token rejected." } }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    };

    credentials.setNodeToken("anxlab", "old-token");
    const staleInstallTarget = marketplace._test.resolveMarketplaceInstallTarget({ nodeId: "anxlab", operation: "initial-install" });
    assert.strictEqual(staleInstallTarget.agentConfig.agentToken, "old-token", "The captured config starts with the old token.");

    credentials.setNodeToken("anxlab", "rotated-token");
    await marketplace._test.ensureProviderPackDependencies(
      { provider: "curseforge", nodeId: "anxlab", id: "rotated-install" },
      staleInstallTarget.agentConfig,
    );
    assert(records.some((record) => record.auth === "Bearer rotated-token"), "A rotated node token must be used even when the caller passes a stale config object.");
    assert(!records.some((record) => record.auth === "Bearer old-token"), "A stale captured node token must not be sent.");

    credentials.setNodeToken("anxlab", "rejected-token");
    const rejectedTarget = marketplace._test.resolveMarketplaceInstallTarget({ nodeId: "anxlab", operation: "retry-install" });
    await assert.rejects(
      () => marketplace._test.ensureProviderPackDependencies({ provider: "curseforge", nodeId: "anxlab", id: "rejected-install" }, rejectedTarget.agentConfig),
      (error) => error?.code === "NODE_CREDENTIAL_REJECTED" && /Anxlab credential rejected/.test(error.message),
      "A rejected selected-node token should surface as a structured node credential error.",
    );

    credentials.setNodeToken("anxlab", "repaired-token");
    await marketplace._test.ensureProviderPackDependencies(
      { provider: "curseforge", nodeId: "anxlab", id: "retry-after-repair" },
      rejectedTarget.agentConfig,
    );
    assert(records.some((record) => record.auth === "Bearer repaired-token"), "Retry after repair must resolve the refreshed protected credential.");

    credentials.setNodeToken("anxlab", "paired-token");
    await marketplace._test.ensureProviderPackDependencies(
      { provider: "curseforge", nodeId: "anxlab", id: "pairing-refresh" },
      rejectedTarget.agentConfig,
    );
    assert(records.some((record) => record.auth === "Bearer paired-token"), "Pairing updates must be visible to Marketplace without restarting.");

    const beforeMissingCredential = records.length;
    credentials.deleteNodeToken("anxlab");
    await assert.rejects(
      () => marketplace._test.ensureProviderPackDependencies({ provider: "curseforge", nodeId: "anxlab", id: "missing-token" }, rejectedTarget.agentConfig),
      (error) => error?.code === "NODE_CREDENTIAL_MISSING",
      "Missing node credential should block before an Agent request.",
    );
    assert.strictEqual(records.length, beforeMissingCredential, "Missing credential must not send an unauthenticated Agent request.");

    const combinedLogs = logs.join("\n");
    for (const secret of ["old-token", "rotated-token", "rejected-token", "repaired-token", "paired-token", "global-stale-token"]) {
      assert(!combinedLogs.includes(secret), `Logs must not expose ${secret}.`);
    }

    console.log("Marketplace credential refresh smoke checks passed.");
  } finally {
    global.fetch = originalFetch;
    console.error = originalConsoleError;
    console.info = originalConsoleInfo;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
