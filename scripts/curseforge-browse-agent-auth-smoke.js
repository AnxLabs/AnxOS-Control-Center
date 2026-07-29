#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-curseforge-browse-"));
  process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
  process.env.ANXOS_LOG_DIR = path.join(root, "logs");
  process.env.ANXHUB_DISABLE_CURSEFORGE_ENV_FALLBACK = "1";
  fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

  const records = [];
  const agent = http.createServer((request, response) => {
    records.push({ type: "agent", url: request.url, auth: request.headers.authorization || "" });
    if (request.url.startsWith("/api/v1/marketplace/curseforge/search")) {
      if (request.headers.authorization !== "Bearer node-token") {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Agent token rejected." } }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: 42, name: "Agent Pack", summary: "From agent", latestFilesIndexes: [] }], pagination: { totalCount: 1 } }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: { code: "NOT_FOUND" } }));
  });
  const port = await listen(agent);
  const agentUrl = `http://127.0.0.1:${port}`;
  const originalFetch = global.fetch;

  try {
    const nodes = require("../src/services/nodeService");
    const credentials = require("../src/services/nodeCredentialStore");
    const agentClient = require("../src/services/agentClient");
    const providerConfig = require("../src/services/providerConfigService");
    const marketplace = require("../src/services/marketplaceInstallService");
    const curseforge = require("../src/services/providers/curseforgeProvider");

    writeJson(nodes.getNodesPath(), {
      schemaVersion: nodes.NODE_SCHEMA_VERSION,
      selectedNodeId: "anxlab",
      nodes: [{
        id: "anxlab",
        kind: "agent",
        name: "Anxlab",
        displayName: "Anxlab",
        agentUrl,
        baseUrl: agentUrl,
        enabled: true,
        agentIdentity: { deviceId: "anxlab-device", hostname: "Anxlab" },
      }],
      removedLocalAgents: [],
    });
    credentials.setNodeToken("anxlab", "node-token");
    writeJson(agentClient.getAgentConfigPath(), { backendMode: "agent", agentUrl, agentToken: "stale-global-token" });
    providerConfig.saveMarketplaceConfig({ curseForgeApiKey: "desktop-cf-key" });
    curseforge._test.setRuntimeApiKey();

    global.fetch = async (url, options = {}) => {
      const textUrl = String(url);
      records.push({ type: textUrl.includes("/api/v1/marketplace/curseforge/") ? "agent-fetch" : "curseforge-api", url: textUrl, apiKey: options.headers?.["x-api-key"] || options.headers?.get?.("x-api-key") || "" });
      if (textUrl.startsWith(`${agentUrl}/api/v1/marketplace/curseforge/search`)) {
        assert.notStrictEqual(options.headers.Authorization, "Bearer stale-global-token", "Agent proxy must not use the stale global Agent token.");
        if (options.headers.Authorization !== "Bearer node-token") {
          return new Response(JSON.stringify({ error: { code: "UNAUTHORIZED", message: "Agent token rejected." } }), { status: 401, headers: { "Content-Type": "application/json" } });
        }
        return new Response(JSON.stringify({
          data: [{ id: 42, slug: "agent-pack", name: "Agent Pack", summary: "Agent result", latestFilesIndexes: [] }],
          pagination: { totalCount: 1 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (textUrl.startsWith("https://api.curseforge.com/v1/mods/search")) {
        assert.strictEqual(options.headers["x-api-key"], "desktop-cf-key", "Browse search should use the desktop CurseForge API key.");
        return new Response(JSON.stringify({
          data: [{ id: 100, slug: "desktop-pack", name: "Desktop Pack", summary: "Browse result", latestFilesIndexes: [] }],
          pagination: { totalCount: 1 },
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (textUrl.startsWith("https://api.curseforge.com/v1/mods/100/files")) {
        return new Response(JSON.stringify({ data: [{ id: 200, modId: 100, displayName: "Server", fileName: "server.zip", gameVersions: ["1.20.1"], dependencies: [] }] }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (textUrl.startsWith("https://api.curseforge.com/v1/mods/100")) {
        return new Response(JSON.stringify({ data: { id: 100, slug: "desktop-pack", name: "Desktop Pack", summary: "Details", latestFilesIndexes: [] } }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      throw new Error(`Unexpected fetch: ${textUrl}`);
    };

    const search = await marketplace.searchProviderPacks({ provider: "curseforge", nodeId: "anxlab", query: "desktop" });
    assert.strictEqual(search.results.length, 1, "CurseForge search should work with no Agent proxy call.");
    assert.strictEqual(search.diagnostics.nodeId, "anxlab", "Browse diagnostics should retain selected node id.");
    assert.strictEqual(search.diagnostics.nodeLabel, "Anxlab", "Browse diagnostics should retain selected node label.");
    assert.strictEqual(search.diagnostics.agentProxy, false, "Browse diagnostics should state that Agent proxy was not used.");
    assert.strictEqual(search.diagnostics.credentialSource, "desktop-curseforge-api-key", "Browse should use the desktop API-key credential source.");
    assert(!records.some((record) => record.type === "agent" || record.type === "agent-fetch"), "Browse-only requests must never use Agent proxy.");

    const versions = await marketplace.getProviderPackVersions({ provider: "curseforge", nodeId: "anxlab", providerProjectId: "100" });
    assert.strictEqual(versions.nodeId, "anxlab", "Version browsing should retain selected node context without Agent proxy.");
    const details = await marketplace.getProviderPackDetails({ provider: "curseforge", nodeId: "anxlab", providerProjectId: "100" });
    assert.strictEqual(details.nodeLabel, "Anxlab", "Project browsing should retain selected node label without Agent proxy.");

    const installConfig = marketplace._test.getCurseForgeBrowseConfig("anxlab");
    assert.strictEqual(installConfig.useAgentProxy, false, "Browse config should explicitly disable Agent proxy.");
    const proxyConfig = (() => {
      const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "marketplaceInstallService.js"), "utf8");
      assert(source.includes("function getCurseForgeAgentConfig"), "Install config helper should exist.");
      // The credential source classification itself lives in the shared
      // marketplaceInstallContext.js helper (used by both the desktop
      // marketplaceService.js and marketplaceInstallService.js), not
      // duplicated per-provider in marketplaceInstallService.js.
      const contextSource = fs.readFileSync(path.join(__dirname, "..", "src", "services", "marketplaceInstallContext.js"), "utf8");
      assert(contextSource.includes('credentialSource: "protected-node-credential"'), "Install config should identify node credential source.");
      return true;
    })();
    assert.strictEqual(proxyConfig, true);
    const agentProxyConfig = marketplace._test.getCurseForgeAgentConfig("anxlab");
    assert.strictEqual(agentProxyConfig.agentNodeId, "anxlab", "Install/proxy config should carry selected node id.");
    assert.strictEqual(agentProxyConfig.agentNodeLabel, "Anxlab", "Install/proxy config should carry selected node label.");
    assert.strictEqual(agentProxyConfig.credentialSource, "protected-node-credential", "Install/proxy config should identify canonical node credential source.");
    const proxiedSearch = await curseforge._test.curseForgeClient.searchMods({ searchFilter: "agent" }, agentProxyConfig);
    assert.strictEqual(proxiedSearch.data?.[0]?.id, 42, "Explicit Agent-proxy requests should succeed with the canonical selected-node credential.");
    credentials.setNodeToken("anxlab", "rejected-node-token");
    const rejectedProxyConfig = marketplace._test.getCurseForgeAgentConfig("anxlab");
    await assert.rejects(
      () => curseforge._test.curseForgeClient.searchMods({ searchFilter: "agent" }, rejectedProxyConfig),
      (error) => error?.code === "UNAUTHORIZED" &&
        error.details?.source === "agent-proxy" &&
        error.details?.nodeId === "anxlab" &&
        error.details?.nodeLabel === "Anxlab" &&
        error.details?.credentialSource === "protected-node-credential",
      "Agent 401 should be surfaced as selected-node Agent proxy authentication failure.",
    );
    providerConfig.saveMarketplaceConfig({ curseForgeApiKey: "" });
    curseforge._test.setRuntimeApiKey();
    const fallback = await marketplace._test.withCurseForgeBrowseFallback("anxlab", async (config) => {
      if (!config.useAgentProxy) {
        const error = new Error("CurseForge API key is required.");
        error.code = "CURSEFORGE_API_KEY_REQUIRED";
        throw error;
      }
      return "agent-fallback";
    });
    assert.strictEqual(
      fallback.value,
      "agent-fallback",
      "A rejected desktop CurseForge credential should fall back to the selected registered Agent.",
    );
    assert.strictEqual(
      fallback.config.credentialSource,
      "protected-node-credential",
      "CurseForge browse fallback should use the selected node credential.",
    );

    console.log("CurseForge browse Agent auth smoke checks passed.");
  } finally {
    global.fetch = originalFetch;
    agent.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
