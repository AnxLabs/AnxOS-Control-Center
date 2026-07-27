const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-cf-server-pack-"));
process.env.ANXHUB_CONFIG_DIR = root;

const nodeService = require("../src/services/nodeService");
const credentials = require("../src/services/nodeCredentialStore");
const providerConfig = require("../src/services/providerConfigService");
const curseforgeProvider = require("../src/services/providers/curseforgeProvider");
const agentClient = require("../src/services/agentClient");
const marketplace = require("../src/services/marketplaceInstallService");

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function file(id, fileName, extra = {}) {
  return {
    id,
    projectId: 100,
    name: fileName,
    fileName,
    minecraftVersions: extra.minecraftVersions || ["1.20.1"],
    loaders: extra.loaders || ["fabric"],
    releaseType: extra.releaseType || 1,
    serverPackFileId: extra.serverPackFileId || null,
  };
}

async function main() {
  assert.deepStrictEqual(
    marketplace._test.getCurseForgeManifestFiles(null, { isDedicatedServerPack: true }),
    [],
    "Official CurseForge server packs may be complete server archives without a client manifest.json.",
  );
    assert.throws(
      () => marketplace._test.getCurseForgeManifestFiles(null, { isDedicatedServerPack: false }),
      (error) => error?.code === "UNSUPPORTED_MODPACK",
      "Unverified client archives must still require CurseForge manifest metadata.",
    );
    assert.strictEqual(marketplace._test.isCurseForgeServerSignalPath("startserver.sh"), true, "CurseForge server signal detection should include ATM10 startserver.sh.");
    assert.deepStrictEqual(marketplace._test.buildStartupScriptPatch("startserver.sh"), {
      executable: "bash",
      args: ["./startserver.sh"],
      startupArguments: ["./startserver.sh"],
      startupScript: "startserver.sh",
    }, "Linux shell startup scripts should launch through bash with an explicit relative path.");
    assert.strictEqual(marketplace._test.isInstallerJarName("neoforge-21.1.228-installer.jar"), true, "Versioned NeoForge installer jars should be recognized as installers, not runtime jars.");
    const original = {
      resolveFile: curseforgeProvider.resolveFile,
      getFile: curseforgeProvider.getFile,
      getFiles: curseforgeProvider.getFiles,
      getMod: curseforgeProvider.getMod,
      downloadFile: curseforgeProvider.downloadFile,
      instanceFileExists: agentClient.instanceFileExists,
      fetch: global.fetch,
    };
  const agentRequests = [];
  const filesById = new Map();
  let selectedFile = null;
  let listedFiles = [];
  let failFileIds = new Set();

  function resetScenario({ selected, files, failIds = [] }) {
    selectedFile = selected;
    listedFiles = files;
    failFileIds = new Set(failIds.map(String));
    filesById.clear();
    [selected, ...files].forEach((entry) => filesById.set(String(entry.id), entry));
  }

  try {
    writeJson(nodeService.getNodesPath(), {
      schemaVersion: 2,
      selectedNodeId: "anxlab",
      nodes: [{
        id: "anxlab",
        kind: "agent",
        displayName: "Anxlab",
        agentUrl: "http://192.168.1.134:47131",
        baseUrl: "http://192.168.1.134:47131",
        enabled: true,
        agentIdentity: { deviceId: "device-anxlab", hostname: "Anxlab" },
      }],
      removedLocalAgents: [],
    });
    credentials.setNodeToken("anxlab", "node-token");
    writeJson(providerConfig.getMarketplaceConfigPath(), { curseForgeApiKey: "legacy-cf-key" });
    assert.strictEqual(providerConfig.readMarketplaceConfig({ includeSecrets: true }).curseForgeApiKey, "legacy-cf-key", "Legacy Marketplace credentials should survive migration.");
    assert(!fs.readFileSync(providerConfig.getMarketplaceConfigPath(), "utf8").includes("legacy-cf-key"), "Migrated Marketplace credentials must be encrypted.");
    const marketplaceBackup = `${providerConfig.getMarketplaceConfigPath()}.schema-v0.backup`;
    assert(fs.existsSync(marketplaceBackup), "Marketplace credential migration should preserve an encrypted safety copy.");
    assert(!fs.readFileSync(marketplaceBackup, "utf8").includes("legacy-cf-key"), "Marketplace migration backups must not retain plaintext credentials.");
    providerConfig.saveMarketplaceConfig({ curseForgeApiKey: "desktop-cf-key" });
    assert(!fs.readFileSync(providerConfig.getMarketplaceConfigPath(), "utf8").includes("desktop-cf-key"), "Marketplace API credentials must be encrypted at rest.");
    assert.strictEqual(providerConfig.readMarketplaceConfig({ includeSecrets: true }).curseForgeApiKey, "desktop-cf-key", "Trusted Marketplace services should decrypt the saved API key.");
    curseforgeProvider._test.setRuntimeApiKey("desktop-cf-key");

    curseforgeProvider.resolveFile = async () => selectedFile;
    curseforgeProvider.getMod = async () => ({ id: 100, provider: "curseforge", providerProjectId: 100, loaders: ["fabric"] });
    curseforgeProvider.getFiles = async () => listedFiles;
    curseforgeProvider.getFile = async (projectId, fileId) => {
      if (failFileIds.has(String(fileId))) {
        const error = new Error("CurseForge file not found.");
        error.code = "CURSEFORGE_FILE_NOT_FOUND";
        error.status = 404;
        throw error;
      }
      return filesById.get(String(fileId)) || null;
    };
    curseforgeProvider.downloadFile = async () => {
      throw new Error("Server-pack resolution smoke should not download files.");
    };
    global.fetch = async (url, options = {}) => {
      agentRequests.push({ url: String(url), auth: options.headers?.Authorization || "" });
      throw new Error(`Unexpected Agent request before server-pack validation: ${url}`);
    };

    async function assertStartupTarget(files, expected, options = {}) {
      const available = new Set(files);
      agentClient.instanceFileExists = async (instanceId, filePath) => ({ exists: available.has(filePath), path: filePath });
      const target = await marketplace._test.resolveInstalledStartupTarget(
        "atm10-startup-smoke",
        { serverJar: options.serverJar || "neoforge-21.1.228-installer.jar" },
        options,
        { platform: options.platform || "linux" }
      );
      assert.strictEqual(target.type, expected.type, expected.message);
      assert.strictEqual(target.path, expected.path, expected.message);
      if (expected.command) {
        assert.strictEqual(`${target.patch.executable} ${target.patch.args.join(" ")}`, expected.command, expected.message);
        assert(!`${target.patch.executable} ${target.patch.args.join(" ")}`.includes("java"), "Script startup target must not include Java.");
      }
    }

    await assertStartupTarget(
      ["startserver.sh", "startserver.bat", "neoforge-21.1.228-installer.jar"],
      { type: "script", path: "startserver.sh", command: "bash ./startserver.sh", message: "ATM10-style packs should prefer startserver.sh over the NeoForge installer jar on Linux." }
    );
    await assertStartupTarget(
      ["run.sh", "neoforge-21.1.228-installer.jar"],
      { type: "script", path: "run.sh", command: "bash ./run.sh", message: "CurseForge packs with run.sh should launch through bash." }
    );
    await assertStartupTarget(
      ["startserver.bat", "startserver.sh", "neoforge-21.1.228-installer.jar"],
      { type: "script", path: "startserver.bat", command: "cmd.exe /c ./startserver.bat", message: "Windows Agents should prefer startserver.bat when present." },
      { platform: "win32" }
    );
    await assertStartupTarget(
      ["server.jar"],
      { type: "jar", path: "server.jar", message: "Jar fallback should remain available when no startup script exists." },
      { serverJar: "server.jar" }
    );

    resetScenario({
      selected: file(10, "Client Pack.zip", { serverPackFileId: 11 }),
      files: [file(11, "Client Pack Server Pack.zip")],
    });
    const explicit = await marketplace._test.resolveCurseForgeServerPackSelection({ projectId: 100, minecraftVersion: "1.20.1", loader: "fabric" });
    assert.strictEqual(explicit.selectedFile.id, 10, "Selected client file should be preserved for review.");
    assert.strictEqual(explicit.serverFile.id, 11, "Explicit serverPackFileId should win.");
    assert.strictEqual(explicit.source, "selected-file-serverPackFileId");

    resetScenario({
      selected: file(20, "Client Pack 1.20.1.zip"),
      files: [
        file(21, "Client Pack 1.20.1.zip", { serverPackFileId: 22 }),
        file(22, "Client Pack Server Pack 1.20.1.zip"),
        file(23, "Client Pack Server Pack 1.19.4.zip", { minecraftVersions: ["1.19.4"] }),
      ],
    });
    const linked = await marketplace._test.resolveCurseForgeServerPackSelection({ projectId: 100, minecraftVersion: "1.20.1", loader: "fabric" });
    assert.strictEqual(linked.serverFile.id, 22, "Compatible project-level serverPackFileId should be selected.");
    assert.strictEqual(linked.source, "project-serverPackFileId");

    resetScenario({
      selected: file(30, "Client Pack.zip", { serverPackFileId: 31 }),
      files: [
        file(31, "Missing Server Pack.zip"),
        file(32, "Client Pack Dedicated Server Files.zip"),
      ],
      failIds: [31],
    });
    await assert.rejects(
      () => marketplace._test.resolveCurseForgeServerPackSelection({ projectId: 100, minecraftVersion: "1.20.1", loader: "fabric" }),
      (error) => error?.code === "CURSEFORGE_SERVER_PACK_REQUIRED",
      "An unavailable relationship must not fall back to a filename-only server-pack guess.",
    );

    resetScenario({
      selected: file(40, "Client Only Optimizer.zip"),
      files: [file(41, "Client Only Optimizer.zip"), file(42, "Client Only Optimizer Server Pack 1.19.4.zip", { minecraftVersions: ["1.19.4"] })],
    });
    await assert.rejects(
      () => marketplace._test.resolveCurseForgeServerPackSelection({ projectId: 100, minecraftVersion: "1.20.1", loader: "fabric" }),
      (error) => error?.code === "CURSEFORGE_SERVER_PACK_REQUIRED" && /does not provide a compatible dedicated-server pack/.test(error.message),
      "Wrong-version server packs should not satisfy the selected version.",
    );

    resetScenario({
      selected: file(50, "Fabulously.Optimized-12.2.2.zip"),
      files: [file(50, "Fabulously.Optimized-12.2.2.zip")],
    });
    await assert.rejects(
      () => marketplace.installPack({ provider: "curseforge", providerProjectId: "100", nodeId: "anxlab", id: "client-only", name: "Client Only", minecraftVersion: "1.20.1", loader: "fabric" }),
      (error) => error?.code === "CURSEFORGE_SERVER_PACK_REQUIRED" && /does not provide a compatible dedicated-server pack/.test(error.message),
      "Client-only CurseForge packs should fail before Agent installation.",
    );
    assert.strictEqual(agentRequests.length, 0, "Unsupported client-only CurseForge packs must not make pre-validation Agent requests.");

    const configPath = providerConfig.getMarketplaceConfigPath();
    const futureState = { schemaVersion: providerConfig.MARKETPLACE_CONFIG_SCHEMA_VERSION + 1, encrypted: { method: "future", data: "opaque" } };
    writeJson(configPath, futureState);
    const futureRaw = fs.readFileSync(configPath, "utf8");
    assert.throws(
      () => providerConfig.readMarketplaceConfig({ includeSecrets: true }),
      (error) => error?.code === "MARKETPLACE_CONFIG_SCHEMA_UNSUPPORTED",
      "Future Marketplace config schemas must fail without being downgraded.",
    );
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), futureRaw, "Future Marketplace config must remain unchanged.");

    fs.writeFileSync(configPath, "{not-json\n", { mode: 0o600 });
    assert.throws(
      () => providerConfig.readMarketplaceConfig({ includeSecrets: true }),
      (error) => error?.code === "MARKETPLACE_CONFIG_CORRUPT",
      "Corrupt Marketplace config must not silently discard credentials.",
    );
    assert(fs.readdirSync(path.dirname(configPath)).some((name) => name.startsWith(`${path.basename(configPath)}.corrupt-`)), "Corrupt Marketplace config should be preserved.");

    console.log("CurseForge server-pack resolution smoke checks passed.");
  } finally {
    curseforgeProvider.resolveFile = original.resolveFile;
    curseforgeProvider.getFile = original.getFile;
    curseforgeProvider.getFiles = original.getFiles;
    curseforgeProvider.getMod = original.getMod;
    curseforgeProvider.downloadFile = original.downloadFile;
    agentClient.instanceFileExists = original.instanceFileExists;
    global.fetch = original.fetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
