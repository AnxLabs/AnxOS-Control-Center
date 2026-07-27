#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-marketplace-install-node-"));
  process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
  process.env.ANXOS_LOG_DIR = path.join(root, "logs");
  fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

  const originalFetch = global.fetch;
  const records = [];

  try {
    const nodes = require("../src/services/nodeService");
    const credentials = require("../src/services/nodeCredentialStore");
    const agentClient = require("../src/services/agentClient");
    const marketplace = require("../src/services/marketplaceInstallService");
    const providerConfig = require("../src/services/providerConfigService");
    const curseforge = require("../src/services/providers/curseforgeProvider");
    const modrinth = require("../src/services/providers/modrinthProvider");

    writeJson(nodes.getNodesPath(), {
      schemaVersion: nodes.NODE_SCHEMA_VERSION,
      selectedNodeId: "anxlab",
      nodes: [
        {
          id: "anxlab",
          kind: "agent",
          name: "Anxlab",
          displayName: "Anxlab",
          agentUrl: "http://192.168.1.134:47131",
          baseUrl: "http://192.168.1.134:47131",
          enabled: true,
          agentIdentity: { deviceId: "anxlab-device", hostname: "Anxlab" },
        },
        {
          id: "node-b",
          kind: "agent",
          name: "Node B",
          displayName: "Node B",
          agentUrl: "http://10.0.0.2:47131",
          baseUrl: "http://10.0.0.2:47131",
          enabled: true,
          agentIdentity: { deviceId: "node-b-device", hostname: "NodeB" },
        },
      ],
      removedLocalAgents: [],
    });
    credentials.setNodeToken("anxlab", "node-token-anxlab");
    credentials.setNodeToken("node-b", "node-token-b");
    writeJson(agentClient.getAgentConfigPath(), {
      backendMode: "agent",
      agentUrl: "http://192.168.1.134:47131",
      agentToken: "stale-global-token",
    });
    providerConfig.saveMarketplaceConfig({ curseForgeApiKey: "desktop-cf-key" });
    curseforge._test.setRuntimeApiKey();
    curseforge.getMod = async () => ({ id: 100, provider: "curseforge", providerProjectId: 100, loaders: ["forge"], serverCompatible: true });
    curseforge.resolveFile = async () => ({
      id: 1000,
      projectId: 100,
      fileName: "cf-client.zip",
      minecraftVersions: ["1.20.1"],
      loaders: ["forge"],
      serverCompatible: true,
    });
    curseforge.getFile = async () => ({
      id: 1001,
      projectId: 100,
      fileName: "cf-server-pack.zip",
      minecraftVersions: ["1.20.1"],
      loaders: ["forge"],
    });
    curseforge.getFiles = async () => [
      {
        id: 1000,
        projectId: 100,
        fileName: "cf-client.zip",
        minecraftVersions: ["1.20.1"],
        loaders: ["forge"],
        serverCompatible: true,
      },
    ];
    modrinth.getProject = async () => ({
      id: "mr-pack",
      providerProjectId: "mr-pack",
      slug: "mr-pack",
      title: "MR Pack",
      projectType: "modpack",
      serverSide: "required",
      clientSide: "optional",
    });
    modrinth.resolveVersion = async () => ({
      id: "mr-version",
      projectId: "mr-pack",
      name: "MR Version",
      versionNumber: "1.0.0",
      minecraftVersions: ["1.20.1"],
      loaders: ["fabric"],
      type: "release",
      primaryFile: { filename: "mr-server.jar", url: "https://mock.local/mr-server.jar", hashes: { sha1: "mr" } },
      files: [{ filename: "mr-server.jar", url: "https://mock.local/mr-server.jar", hashes: { sha1: "mr" } }],
      dependencies: [],
    });

    global.fetch = async (url, options = {}) => {
      const endpoint = String(url);
      const record = {
        endpoint,
        auth: options.headers?.Authorization || "",
        body: options.body ? JSON.parse(options.body) : null,
      };
      records.push(record);
      if (endpoint.endsWith("/api/v1/stats")) {
        const expectedToken = endpoint.startsWith("http://10.0.0.2") ? "node-token-b" : "node-token-anxlab";
        assert.strictEqual(record.auth, `Bearer ${expectedToken}`, "Disk preflight must use the selected node credential.");
        return new Response(JSON.stringify({
          disk: { availableBytes: 20 * 1024 ** 3, totalBytes: 100 * 1024 ** 3, mount: "/srv" },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (endpoint === "http://192.168.1.134:47131/api/v1/dependencies/check") {
        if (record.auth === "Bearer rejected-token") {
          return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Agent token rejected." } }), { status: 401, headers: { "Content-Type": "application/json" } });
        }
        assert.strictEqual(record.auth, "Bearer node-token-anxlab", "Anxlab dependency check must use the canonical node credential.");
        assert.notStrictEqual(record.auth, "Bearer stale-global-token", "Stale global Agent token must not override Anxlab install credentials.");
        assert.strictEqual(record.body.nodeId, "anxlab", "Dependency check payload should carry Anxlab nodeId.");
        return new Response(JSON.stringify({
          ok: false,
          dependencies: [{ id: "java", installed: false, state: "missing" }],
          missingDependencyIds: ["java"],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (endpoint === "http://10.0.0.2:47131/api/v1/dependencies/check") {
        assert.strictEqual(record.auth, "Bearer node-token-b", "Switching nodes should switch dependency-check credentials.");
        assert.strictEqual(record.body.nodeId, "node-b", "Dependency check payload should carry Node B nodeId.");
        return new Response(JSON.stringify({
          ok: false,
          dependencies: [{ id: "java", installed: false, state: "missing" }],
          missingDependencyIds: ["java"],
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected Agent request: ${endpoint}`);
    };

    const target = marketplace._test.resolveMarketplaceInstallTarget({ nodeId: "anxlab", operation: "smoke" });
    assert.strictEqual(target.nodeId, "anxlab");
    assert.strictEqual(target.nodeLabel, "Anxlab");
    assert.strictEqual(target.agentUrl, "http://192.168.1.134:47131");
    assert.strictEqual(target.targetLabel, "node:anxlab");
    assert.strictEqual(target.credentialSource, "protected-node-credential");
    assert.strictEqual(target.agentConfig.agentToken, "node-token-anxlab");

    await assert.rejects(
      () => marketplace.installPack({ provider: "curseforge", providerProjectId: "100", nodeId: "anxlab", id: "cf-install", name: "CF Install", minecraftVersion: "1.20.1", loader: "forge" }),
      (error) => error?.code === "DEPENDENCIES_REQUIRED",
      "CurseForge install should reach node-scoped dependency checking before asking for dependency repair.",
    );
    assert(records.some((record) => record.endpoint.endsWith("/api/v1/dependencies/check") && record.auth === "Bearer node-token-anxlab"), "Anxlab install must check dependencies with the node credential.");
    assert(!records.some((record) => record.auth === "Bearer stale-global-token"), "Anxlab install must never use the stale global Agent token.");

    await assert.rejects(
      () => marketplace.installPack({ provider: "modrinth", providerProjectId: "mr-pack", nodeId: "node-b", id: "mr-install", name: "MR Install", minecraftVersion: "1.20.1", loader: "fabric" }),
      (error) => error?.code === "DEPENDENCIES_REQUIRED",
      "Modrinth install should also use the selected-node dependency path.",
    );
    assert(records.some((record) => record.endpoint === "http://10.0.0.2:47131/api/v1/dependencies/check" && record.auth === "Bearer node-token-b"), "Switching selected install node should change the full credential context.");

    const localTarget = marketplace._test.resolveMarketplaceInstallTarget({ nodeId: "application-host", operation: "smoke" });
    assert.strictEqual(localTarget.type, "application-host", "Application Host target must remain separate from registered remote nodes.");
    assert.strictEqual(localTarget.agentConfig.backendMode, "local", "Application Host must not reuse the previous remote credential.");
    const countBeforeMissingTarget = records.length;
    await assert.rejects(
      () => marketplace.installPack({ provider: "modrinth", providerProjectId: "mr-pack", id: "missing-target", name: "Missing Target" }),
      (error) => error?.code === "INSTALL_TARGET_REQUIRED",
      "Missing install target should fail before any Agent request.",
    );
    assert.strictEqual(records.length, countBeforeMissingTarget, "Missing install target must not make an Agent request.");

    credentials.setNodeToken("anxlab", "rejected-token");
    await assert.rejects(
      () => marketplace._test.ensureProviderPackDependencies({ provider: "curseforge", nodeId: "anxlab", id: "auth-check" }, marketplace._test.resolveMarketplaceInstallTarget({ nodeId: "anxlab" }).agentConfig),
      (error) => error?.code === "NODE_CREDENTIAL_REJECTED" && /Anxlab credential rejected/.test(error.message),
      "Agent 401 should be reported as selected-node credential rejection.",
    );

    console.log("Marketplace install selected-node smoke checks passed.");
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
