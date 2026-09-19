const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-live-routing-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function createDependencyAgent(label, expectedToken) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        label,
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization || "",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (request.headers.authorization !== `Bearer ${expectedToken}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "UNAUTHORIZED" } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url === "/api/v1/dependencies/plan") {
        response.end(JSON.stringify({
          ok: false,
          dependencyIds: ["java"],
          installableActions: [{ id: "java", displayName: "Java", packages: ["openjdk-21-jre"], commands: [] }],
          manualActions: [],
          missingDependencyIds: ["java"],
        }));
        return;
      }
      if (request.url === "/api/v1/dependencies/install") {
        response.end(JSON.stringify({
          ok: true,
          jobs: [{ id: `${label}-job`, dependencyId: "java", state: "completed" }],
          dependencies: [{ id: "java", state: "installed" }],
        }));
        return;
      }
      if (request.url === "/api/v1/dependencies/check") {
        response.end(JSON.stringify({
          ok: true,
          dependencies: [{ id: "java", state: "installed" }],
          missingDependencyIds: [],
        }));
        return;
      }
      response.end(JSON.stringify({ ok: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        label,
        server,
        requests,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
      });
    });
  });
}

async function main() {
  const [nodeA, nodeB, legacy] = await Promise.all([
    createDependencyAgent("node-a", "token-a"),
    createDependencyAgent("node-b", "token-b"),
    createDependencyAgent("legacy-localhost", "legacy-token"),
  ]);

  writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "agent.json"), {
    backendMode: "agent",
    agentUrl: legacy.baseUrl,
    agentToken: "legacy-token",
  });
  writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "nodes.json"), {
    schemaVersion: 2,
    selectedNodeId: "node-a",
    nodes: [
      { id: "node-a", kind: "agent", displayName: "Anxlab", baseUrl: nodeA.baseUrl, agentUrl: nodeA.baseUrl, enabled: true },
      { id: "node-b", kind: "agent", displayName: "Windows PC", baseUrl: nodeB.baseUrl, agentUrl: nodeB.baseUrl, enabled: true },
    ],
  });
  writeJson(path.join(process.env.ANXHUB_CONFIG_DIR, "node-agent-credentials.json"), {
    schemaVersion: 1,
    nodes: {
      "node-a": { agentToken: "token-a" },
      "node-b": { agentToken: "token-b" },
    },
  });

  const serviceRouter = require("../src/services/serviceRouter");
  const dependenciesIpcSource = fs.readFileSync(path.join(__dirname, "..", "src", "ipc", "dependenciesIpc.js"), "utf8");
  assert(dependenciesIpcSource.includes("requireDependencyNodeContext"), "Dependency IPC must require explicit node context.");

  const installA = await serviceRouter.installDependencies({ nodeId: "node-a", dependencyIds: ["java"] });
  const installB = await serviceRouter.installDependencies({ nodeId: "node-b", dependencyIds: ["java"] });
  const checkA = await serviceRouter.checkDependencies({ nodeId: "node-a", dependencyIds: ["java"] });
  const planB = await serviceRouter.planDependencyPreparation({ nodeId: "node-b", dependencyIds: ["java"] });

  assert.strictEqual(installA.nodeId, "node-a", "Node A dependency install must retain Node A context.");
  assert.strictEqual(installB.nodeId, "node-b", "Node B dependency install must retain Node B context.");
  assert.strictEqual(checkA.nodeId, "node-a", "Node A dependency check must retain Node A context.");
  assert.strictEqual(planB.nodeId, "node-b", "Node B dependency plan must retain Node B context.");
  assert(nodeA.requests.some((entry) => entry.url === "/api/v1/dependencies/install"), "Node A Agent must receive Node A install.");
  assert(nodeB.requests.some((entry) => entry.url === "/api/v1/dependencies/install"), "Node B Agent must receive Node B install.");
  assert(nodeA.requests.every((entry) => entry.authorization === "Bearer token-a"), "Node A requests must use Node A credential.");
  assert(nodeB.requests.every((entry) => entry.authorization === "Bearer token-b"), "Node B requests must use Node B credential.");
  assert.strictEqual(legacy.requests.length, 0, "Legacy configured localhost Agent must not receive active-node dependency requests.");

  await Promise.all([nodeA, nodeB, legacy].map((agent) => new Promise((resolve) => agent.server.close(resolve))));
  console.log("Live routing regression smoke checks passed.");
}

main()
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  })
  .finally(() => {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
