const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-dependency-public-access-node-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

async function main() {
  writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "nodes.json"), {
    schemaVersion: 2,
    selectedNodeId: "node-a",
    nodes: [
      {
        id: "node-a",
        kind: "agent",
        name: "Node A",
        displayName: "Node A",
        baseUrl: "http://127.0.0.1:47131",
        agentUrl: "http://127.0.0.1:47131",
        enabled: true,
        agentIdentity: { deviceId: "device-a", platform: "linux" },
      },
      {
        id: "node-b",
        kind: "agent",
        name: "Node B",
        displayName: "Node B",
        baseUrl: "http://127.0.0.1:57131",
        agentUrl: "http://127.0.0.1:57131",
        enabled: true,
        agentIdentity: { deviceId: "device-b", platform: "linux" },
      },
      {
        id: "node-disabled",
        kind: "agent",
        name: "Disabled Node",
        displayName: "Disabled Node",
        baseUrl: "http://127.0.0.1:67131",
        agentUrl: "http://127.0.0.1:67131",
        enabled: false,
        agentIdentity: { deviceId: "device-disabled", platform: "linux" },
      },
    ],
  });
  writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "node-agent-credentials.json"), {
    schemaVersion: 1,
    nodes: {
      "node-a": { agentToken: "token-a" },
      "node-b": { agentToken: "token-b" },
      "node-disabled": { agentToken: "token-disabled" },
    },
  });

  const agentClient = require("../src/services/agentClient");
  const serviceRouter = require("../src/services/serviceRouter");
  const publicAccess = require("../src/services/publicAccessProviderService");
  const registry = require("../src/shared/publicAccessServiceRegistry");

  const originals = {
    checkDependencies: agentClient.checkDependencies,
    installDependencies: agentClient.installDependencies,
    listPublicAccessServices: agentClient.listPublicAccessServices,
    createPublicAccessService: agentClient.createPublicAccessService,
    deletePublicAccessService: agentClient.deletePublicAccessService,
  };

  try {
    const seen = [];
    agentClient.checkDependencies = async (payload, config) => {
      seen.push({ type: "check", payload, config });
      return {
        ok: true,
        dependencies: [{ id: "java", state: "installed" }],
        missingDependencyIds: [],
      };
    };
    agentClient.installDependencies = async (payload, config) => {
      seen.push({ type: "install", payload, config });
      return {
        ok: true,
        jobs: [{ id: "job-java", dependencyId: "java", state: "completed" }],
      };
    };
    agentClient.listPublicAccessServices = async (payload, config) => {
      seen.push({ type: "public-list", payload, config });
      return {
        services: [{ id: "same-service", providerId: "playit", localPort: 25565 }],
      };
    };
    agentClient.createPublicAccessService = async (payload, config) => {
      seen.push({ type: "public-create", payload, config });
      return {
        success: true,
        service: { id: "same-service", providerId: payload.providerId, localPort: payload.localPort },
      };
    };
    agentClient.deletePublicAccessService = async (serviceId, config) => {
      seen.push({ type: "public-delete", serviceId, config });
      return { success: true, serviceId };
    };

    const dependencyCheck = await serviceRouter.checkDependencies({ nodeId: "node-a", dependencyIds: ["java"] });
    assert.strictEqual(dependencyCheck.nodeId, "node-a", "Dependency check response should carry node identity.");
    assert.strictEqual(dependencyCheck.dependencies[0].nodeId, "node-a", "Dependency entries should carry node identity.");
    const dependencyInstall = await serviceRouter.installDependencies({ nodeId: "node-b", dependencyIds: ["java"] });
    assert.strictEqual(dependencyInstall.nodeId, "node-b", "Dependency install response should carry node identity.");
    assert.strictEqual(dependencyInstall.jobs[0].nodeId, "node-b", "Dependency jobs should carry node identity.");
    assert.strictEqual(seen.find((entry) => entry.type === "check").config.nodeId, "node-a", "Dependency check config should carry Node A.");
    assert.strictEqual(seen.find((entry) => entry.type === "install").config.nodeId, "node-b", "Dependency install config should carry Node B.");

    await assert.rejects(
      () => serviceRouter.checkDependencies({ nodeId: "node-disabled", dependencyIds: ["java"] }),
      (error) => error.code === "NODE_DISABLED",
      "Disabled dependency nodes should reject before request dispatch.",
    );

    const servicesA = await publicAccess.listPublicAccessServices({ nodeId: "node-a" });
    const servicesB = await publicAccess.listPublicAccessServices({ nodeId: "node-b" });
    assert.strictEqual(servicesA.nodeId, "node-a", "Public Access list should carry Node A.");
    assert.strictEqual(servicesA.services[0].nodeId, "node-a", "Public Access service entries should carry Node A.");
    assert.strictEqual(servicesB.nodeId, "node-b", "Public Access list should carry Node B.");
    assert.strictEqual(servicesB.services[0].nodeId, "node-b", "Public Access service entries should carry Node B.");

    const created = await publicAccess.createPublicAccessService({
      nodeId: "node-a",
      providerId: "playit",
      providerName: "Playit.gg",
      localPort: 25565,
      protocol: "tcp",
    });
    assert.strictEqual(created.nodeId, "node-a", "Public Access create response should carry node identity.");
    assert.strictEqual(seen.find((entry) => entry.type === "public-create").config.nodeId, "node-a", "Public Access create config should carry Node A.");

    await assert.rejects(
      () => publicAccess.listPublicAccessServices({ nodeId: "node-disabled" }),
      (error) => error.code === "NODE_DISABLED",
      "Disabled Public Access nodes should reject before request dispatch.",
    );
  } finally {
    Object.assign(agentClient, originals);
  }

  const localA = await publicAccess.createPublicAccessService({
    nodeId: "application-host",
    providerId: "playit",
    providerName: "Playit.gg",
    localPort: 24454,
    protocol: "tcp",
  });
  const localB = registry.createAccessService({
    nodeId: "node-a",
    providerId: "playit",
    providerName: "Playit.gg",
    localPort: 24455,
    protocol: "tcp",
  }, { configDir: process.env.ANXHUB_CONFIG_DIR });
  assert.strictEqual((await publicAccess.listPublicAccessServices({ nodeId: "application-host" })).services.length, 1, "Local Public Access services should be node-filtered.");
  assert.strictEqual(registry.listAccessServices({ configDir: process.env.ANXHUB_CONFIG_DIR, nodeId: "node-a" }).length, 1, "Registry Public Access services should be node-filtered.");
  await assert.rejects(
    () => publicAccess.deletePublicAccessService({ nodeId: "application-host", serviceId: localB.id }),
    (error) => error.code === "PROVIDER_RESOURCE_NOT_FOUND",
    "Public Access delete should not remove another node's service.",
  );
  await publicAccess.deletePublicAccessService({ nodeId: "application-host", serviceId: localA.service.id });

  const routerSource = fs.readFileSync(path.join(__dirname, "..", "src", "services", "serviceRouter.js"), "utf8");
  const ipcSource = fs.readFileSync(path.join(__dirname, "..", "src", "ipc", "dependenciesIpc.js"), "utf8");
  const publicAccessSource = fs.readFileSync(path.join(__dirname, "..", "src", "services", "publicAccessProviderService.js"), "utf8");
  const registrySource = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "publicAccessServiceRegistry.js"), "utf8");
  assert(routerSource.includes("next.dependencies = next.dependencies.map"), "Dependency responses should project node identity onto dependency entries.");
  assert(ipcSource.includes("dependencyNodeId: result.nodeId || payload.nodeId || null"), "Dependency diagnostics should use resolved node identity.");
  assert(publicAccessSource.includes("getAgentConfigForPublicAccess"), "Public Access should use a node-aware agent config helper.");
  assert(registrySource.includes("service.nodeId !== options.nodeId"), "Public Access registry delete should enforce node ownership.");

  console.log("Dependency and Public Access node smoke checks passed.");
}

main()
  .finally(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
