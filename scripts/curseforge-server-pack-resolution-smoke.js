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
      listInstanceFiles: agentClient.listInstanceFiles,
      readInstanceFile: agentClient.readInstanceFile,
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
      ["startserver.sh", "run.sh", "neoforge-21.1.228-installer.jar"],
      { type: "script", path: "run.sh", command: "bash ./run.sh", message: "NeoForge bootstrap output should prefer generated run.sh over startserver.sh on Linux." }
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

    function setRuntimeFiles(files = {}) {
      const normalized = new Map(Object.entries(files).map(([key, value]) => [key.replace(/\\/g, "/").replace(/^\.\//, ""), value]));
      agentClient.instanceFileExists = async (instanceId, filePath) => ({
        exists: normalized.has(String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "")),
        path: filePath,
      });
      agentClient.readInstanceFile = async (instanceId, filePath) => {
        const key = String(filePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
        if (!normalized.has(key)) {
          const error = new Error("Not found");
          error.code = "PATH_NOT_FOUND";
          throw error;
        }
        return { supported: true, content: String(normalized.get(key) || "") };
      };
      agentClient.listInstanceFiles = async (instanceId, directoryPath = ".") => {
        const directory = String(directoryPath || ".").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "");
        const prefix = directory === "." ? "" : `${directory}/`;
        const names = new Map();
        for (const key of normalized.keys()) {
          if (!key.startsWith(prefix)) continue;
          const rest = key.slice(prefix.length);
          if (!rest) continue;
          const [name, ...tail] = rest.split("/");
          if (!name) continue;
          names.set(name, tail.length > 0 ? "directory" : "file");
        }
        return {
          entries: [...names.entries()].map(([name, type]) => ({
            name,
            path: prefix ? `${prefix}${name}` : name,
            type,
            isDirectory: type === "directory",
          })),
        };
      };
    }

    setRuntimeFiles({
      "startserver.sh": "#!/usr/bin/env bash\njava -jar neoforge-21.1.228-installer.jar --installServer\n",
      "neoforge-21.1.228-installer.jar": "installer",
    });
    const atm10BootstrapRuntime = await marketplace._test.resolveServerPackRuntime(
      "atm10-runtime-smoke",
      { type: "script", path: "startserver.sh", patch: marketplace._test.buildStartupScriptPatch("startserver.sh") },
      { provider: "curseforge", loader: "neoforge", minecraftVersion: "1.21.1" },
      { platform: "linux" }
    );
    assert.strictEqual(atm10BootstrapRuntime.serverJar, "neoforge-21.1.228-installer.jar", "ATM10-style packs should preserve the versioned NeoForge installer from the server pack.");
    assert.strictEqual(atm10BootstrapRuntime.loaderVersion, "21.1.228", "ATM10-style runtime metadata should use the server-pack NeoForge version.");
    assert.strictEqual(atm10BootstrapRuntime.versionInfo?.softwareVersion, "21.1.228", "versionInfo should persist the actual server-pack NeoForge version.");

    setRuntimeFiles({
      "startserver.sh": "#!/usr/bin/env bash\njava -jar neoforge-21.1.228-installer.jar --installServer\n",
      "neoforge-installer.jar": "generic",
      "neoforge-21.1.228-installer.jar": "versioned",
    });
    const versionedWinsRuntime = await marketplace._test.resolveServerPackRuntime(
      "atm10-versioned-wins-smoke",
      { type: "script", path: "startserver.sh", patch: marketplace._test.buildStartupScriptPatch("startserver.sh") },
      { provider: "curseforge", loader: "neoforge", minecraftVersion: "1.21.1" },
      { platform: "linux" }
    );
    assert.strictEqual(versionedWinsRuntime.serverJar, "neoforge-21.1.228-installer.jar", "Versioned server-pack installer must win over generic neoforge-installer.jar.");

    setRuntimeFiles({
      "run.sh": "#!/usr/bin/env bash\nexec java @user_jvm_args.txt @libraries/net/neoforged/neoforge/21.1.228/unix_args.txt \"$@\"\n",
      "user_jvm_args.txt": "-Xmx4G\n",
      "libraries/net/neoforged/neoforge/21.1.228/unix_args.txt": "--launchTarget neoforgeserver\n",
      "libraries/net/neoforged/neoforge/26.2.0.35-beta/unix_args.txt": "--launchTarget neoforgeserver\n",
      "neoforge-installer.jar": "generic",
      "neoforge-21.1.228-installer.jar": "versioned",
    });
    const runScriptRuntime = await marketplace._test.resolveServerPackRuntime(
      "atm10-run-version-wins-smoke",
      { type: "script", path: "run.sh", patch: marketplace._test.buildStartupScriptPatch("run.sh") },
      { provider: "curseforge", loader: "neoforge", minecraftVersion: "1.21.1" },
      { platform: "linux" }
    );
    assert.strictEqual(runScriptRuntime.loaderVersion, "21.1.228", "run.sh unix_args.txt reference must win over newer NeoForge library folders.");
    assert.strictEqual(runScriptRuntime.unixArgsPath, "libraries/net/neoforged/neoforge/21.1.228/unix_args.txt", "Runtime metadata should persist the actual run.sh unix_args path.");
    assert.strictEqual(runScriptRuntime.versionInfo?.softwareVersion, "21.1.228", "config/metadata versionInfo should match the run.sh NeoForge version.");

    setRuntimeFiles({
      "server.jar": "server-runtime",
    });
    const jarRuntime = await marketplace._test.resolveServerPackRuntime(
      "provider-jar-runtime-smoke",
      { type: "jar", path: "server.jar", patch: {} },
      { provider: "curseforge", loader: "neoforge", minecraftVersion: "1.21.1", loaderVersion: "26.2.0.35-beta" },
      { platform: "linux" }
    );
    assert.strictEqual(jarRuntime.loaderVersion, null, "Provider server-pack runtime must not inherit generic/latest loaderVersion when the actual runtime path does not prove it.");
    assert.strictEqual(jarRuntime.versionInfo?.softwareVersion, null, "Provider server-pack versionInfo must not inherit generic/latest softwareVersion.");

    setRuntimeFiles({
      "run.sh": "#!/usr/bin/env bash\nexec java @user_jvm_args.txt @libraries/net/neoforged/neoforge/21.1.228/unix_args.txt \"$@\"\n",
      "libraries/net/neoforged/neoforge/26.2.0.35-beta/unix_args.txt": "--launchTarget neoforgeserver\n",
    });
    await assert.rejects(
      () => marketplace._test.resolveServerPackRuntime(
        "atm10-runtime-mismatch-smoke",
        { type: "script", path: "run.sh", patch: marketplace._test.buildStartupScriptPatch("run.sh") },
        { provider: "curseforge", loader: "neoforge", minecraftVersion: "1.21.1" },
        { platform: "linux" }
      ),
      (error) => error?.code === "SERVER_PACK_RUNTIME_UNRESOLVED" && error.details?.expectedVersion === "21.1.228",
      "Mismatched run.sh/unix_args.txt runtime should fail clearly instead of repairing to a newer loader version.",
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

    const unreadableEncryptedState = {
      schemaVersion: providerConfig.MARKETPLACE_CONFIG_SCHEMA_VERSION,
      encrypted: { method: "safeStorage", data: "not-valid-encrypted-data" },
    };
    writeJson(configPath, unreadableEncryptedState);
    const unreadableRaw = fs.readFileSync(configPath, "utf8");
    const degraded = providerConfig.readMarketplaceConfigSafe({ includeSecrets: true });
    assert.strictEqual(degraded.config.curseForgeApiKey, "", "Unreadable Marketplace credentials must not be exposed or reused.");
    assert.strictEqual(degraded.recovery.degraded, true, "Unreadable Marketplace credentials should enter a bounded degraded state.");
    assert.strictEqual(degraded.recovery.preserved, true, "Unreadable encrypted Marketplace configuration should be preserved.");
    assert(!degraded.recovery.message.includes("MARKETPLACE_CONFIG_DECRYPT_FAILED"), "Normal recovery guidance must not expose the raw decrypt error code.");
    assert.strictEqual(fs.readFileSync(configPath, "utf8"), unreadableRaw, "Degraded recovery must not modify the unreadable encrypted config.");
    const preservedBackups = fs.readdirSync(path.dirname(configPath)).filter((name) => name === `${path.basename(configPath)}.decrypt-failed.backup`);
    providerConfig.readMarketplaceConfigSafe({ includeSecrets: true });
    assert.strictEqual(
      fs.readdirSync(path.dirname(configPath)).filter((name) => name === `${path.basename(configPath)}.decrypt-failed.backup`).length,
      preservedBackups.length,
      "Repeated reads in degraded state must not retry decryption or create backup spam.",
    );
    const degradedStatus = curseforgeProvider._test.getApiKeyStatus();
    assert.strictEqual(degradedStatus.degraded, true, "CurseForge status should report saved provider credentials as degraded.");
    assert.doesNotThrow(() => curseforgeProvider.logStartupStatus(), "Marketplace decrypt failure must not escape the optional startup status probe.");
    assert.throws(
      () => curseforgeProvider.ensureConfigured({}),
      (error) => error?.code === "CURSEFORGE_PROVIDER_SETTINGS_UNAVAILABLE" && !error.message.includes("MARKETPLACE_CONFIG_DECRYPT_FAILED"),
      "Credential-dependent CurseForge actions should fail with friendly degraded guidance.",
    );
    const mainSource = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
    assert(
      mainSource.indexOf("createWindow();") < mainSource.indexOf("logCurseForgeStartupStatus();"),
      "The main window must be created before the optional CurseForge startup status probe.",
    );
    assert(
      mainSource.includes('diagnostics.logError("startup", "marketplace-provider-degraded"'),
      "Marketplace startup degradation should be bounded by desktop diagnostics.",
    );

    console.log("CurseForge server-pack resolution smoke checks passed.");
  } finally {
    curseforgeProvider.resolveFile = original.resolveFile;
    curseforgeProvider.getFile = original.getFile;
    curseforgeProvider.getFiles = original.getFiles;
    curseforgeProvider.getMod = original.getMod;
    curseforgeProvider.downloadFile = original.downloadFile;
    agentClient.instanceFileExists = original.instanceFileExists;
    agentClient.listInstanceFiles = original.listInstanceFiles;
    agentClient.readInstanceFile = original.readInstanceFile;
    global.fetch = original.fetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
