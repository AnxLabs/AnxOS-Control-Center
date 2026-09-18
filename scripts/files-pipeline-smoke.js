const assert = require("assert");
const fs = require("fs/promises");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForAgent(url, token) {
  // Shared readiness helper: see scripts/test-helpers/agent-readiness.js for why
  // the budget is generous here and why the failure message must name a cause.
  const { waitForAgentReady } = require("./test-helpers/agent-readiness");
  return waitForAgentReady({
    label: "Temporary Agent",
    probe: async () => (await fetch(`${url}/api/v1/health`, { headers: { Authorization: `Bearer ${token}` } })).ok,
  });
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "anx-files-pipeline-"));
  process.env.ANXHUB_CONFIG_DIR = path.join(tempRoot, "desktop-config");
  const port = await getFreePort();
  const token = "files-pipeline-smoke-token";
  const url = `http://127.0.0.1:${port}`;
  const agent = spawn(process.execPath, [path.join(rootDir, "agent", "src", "server.js")], {
    cwd: tempRoot,
    env: {
      ...process.env,
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: String(port),
      AGENT_TOKEN: token,
      AGENT_FILE_ROOTS: tempRoot,
      AGENT_IDENTITY_PATH: path.join(tempRoot, "device-identity.json"),
      AGENT_ACTION_PERMISSIONS: "files:write",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await fs.writeFile(path.join(tempRoot, "existing.txt"), "before", "utf8");
    await waitForAgent(url, token);
    assert.strictEqual((await fetch(`${url}/api/v1/files/list?path=${encodeURIComponent(tempRoot)}`)).status, 401, "Agent files must reject unauthenticated requests.");
    const agentClient = require("../src/services/agentClient");
    const config = { backendMode: "agent", url, token };

    const identity = await agentClient.getFilesystemIdentity(config);
    assert.strictEqual(identity.platform, process.platform, "Agent identity should report the target platform.");
    assert.strictEqual(identity.homeDirectory, os.homedir(), "Agent identity should report the target home directory.");
    assert.strictEqual(identity.filesystemRoot, tempRoot, "Agent identity should report the authorized filesystem root.");
    assert.strictEqual(identity.filesystemRootStatus.status, "valid", "Agent identity should report root validation status.");
    assert.strictEqual(identity.initialPath, tempRoot, "Agent identity should fall back to the authorized root when home is outside it.");
    assert(
      identity.roots.some((root) => root.path === tempRoot && root.kind === "root" && root.available === true),
      "Agent identity should include structured allowed filesystem roots.",
    );

    const first = await agentClient.getFileListing(tempRoot, config);
    const reconnected = await agentClient.getFileListing(tempRoot, config);
    assert(first.connected && reconnected.connected, "Agent filesystem should connect and reconnect.");
    assert(first.entries.some((entry) => entry.name === "existing.txt"), "Agent listing should include files.");

    const opened = await agentClient.readFileText(path.join(tempRoot, "existing.txt"), config);
    assert.strictEqual(opened.content, "before", "Agent should open text files.");
    await agentClient.mutateFile({ action: "write", path: opened.path, content: "after" }, config);
    assert.strictEqual((await agentClient.readFileText(opened.path, config)).content, "after", "Agent should edit text files.");

    const folder = path.join(tempRoot, "folder");
    const created = path.join(folder, "created.txt");
    const copied = path.join(folder, "copied.txt");
    const renamed = path.join(folder, "renamed.txt");
    await agentClient.mutateFile({ action: "mkdir", path: folder }, config);
    await agentClient.mutateFile({ action: "newFile", path: created, content: "created" }, config);
    await agentClient.mutateFile({ action: "copy", sourcePath: created, destinationPath: copied }, config);
    await agentClient.mutateFile({ action: "rename", oldPath: copied, newPath: renamed }, config);
    assert((await agentClient.getFileListing(folder, config)).entries.some((entry) => entry.name === "renamed.txt"), "Agent should browse created folders.");
    await agentClient.mutateFile({ action: "delete", path: renamed }, config);
    await assert.rejects(
      agentClient.mutateFile({ action: "delete", path: tempRoot }, config),
      (error) => error?.code === "ROOT_DELETE_FORBIDDEN"
        && error?.payload?.error?.details?.stack === undefined
        && error?.payload?.error?.details?.responseBody === undefined,
      "Agent must not delete a configured filesystem root or expose raw stack/response details."
    );

    const { FileService } = require("../src/services/fileService");
    const localService = new FileService();
    const localListing = await localService.list({ storageId: "local", path: tempRoot });
    assert(localListing.connected && localListing.local, "Local filesystem provider should connect.");
    await localService.writeText({ storageId: "local", path: path.join(tempRoot, "local.txt"), content: "local" });
    assert.strictEqual((await localService.readText({ storageId: "local", path: path.join(tempRoot, "local.txt") })).content, "local", "Local provider should edit files.");
    await localService.writeText({ storageId: "local", path: path.join(tempRoot, "local.txt"), content: "replacement" });
    assert.strictEqual((await localService.readText({ storageId: "local", path: path.join(tempRoot, "local.txt") })).content, "replacement", "Local provider should atomically replace edited files.");
    assert.deepStrictEqual(
      (await fs.readdir(tempRoot)).filter((name) => name.includes("local.txt") && name.endsWith(".tmp")),
      [],
      "Successful local edits must not leave temporary artifacts.",
    );

    const appSource = await fs.readFile(path.join(rootDir, "app.js"), "utf8");
    assert(appSource.includes('const FILES_AGENT_PROFILE_PREFIX = "files-profile:agent:"'), "Renderer should create stable Agent filesystem profile IDs.");
    assert(appSource.includes('const FILES_LOCAL_PROFILE_PREFIX = "files-profile:local:"'), "Renderer should create stable local filesystem profile IDs.");
    assert(appSource.includes("getFilesRequestNodeId()"), "Renderer should route file requests through the selected Files profile node.");
    assert(appSource.includes("nodeId: getFilesRequestNodeId()"), "Renderer file payloads should not use the global selected node ID.");
    assert(appSource.includes("filesProfileNavigationState"), "Renderer should keep Files navigation state per stable target/profile.");
    assert(appSource.includes("filesNavigationGeneration"), "Renderer should invalidate stale filesystem responses after profile changes.");
    assert(appSource.includes("resolveFilesTargetIdentity"), "Renderer should resolve filesystem identity before listing files.");
    assert(appSource.includes("resolveFilesListPath"), "Renderer should validate remembered paths before listing files.");
    assert(appSource.includes("isPathInsideFilesIdentityRoots"), "Renderer should validate remembered paths against the current authorized root.");
    assert(appSource.includes("homeInsideFilesystemRoot ? identity?.homeDirectory"), "Renderer should use the Agent home only when it remains inside the authorized root.");
    assert(appSource.includes("isWindowsPathValue") && appSource.includes("isPathValidForFilesIdentity"), "Renderer should reject cross-platform remembered paths.");
    assert(appSource.includes("const sameTarget = Boolean(target?.key && filesConnectionState.targetKey === target.key)") && appSource.includes("path: sameTarget ? filesConnectionState.currentPath || filesConnectionState.homePath || undefined : undefined"), "Files refresh must not send a previous target path after server/profile changes.");
    assert(appSource.includes("if (filesPathInput) filesPathInput.value = \"\""), "Files target changes must clear the visible path immediately.");
    assert(appSource.includes("currentPath: listing?.currentPath || requestPath || null"), "Files listing responses must bind the visible path to the resolved request path.");
    assert(!appSource.includes("currentPath: normalized.currentPath || filesConnectionState.currentPath"), "Files renderer must not preserve stale global paths when rendering new target rows.");
    assert(!appSource.includes("path: options.path || filesConnectionState.currentPath || filesConnectionState.homePath || undefined"), "Renderer must not reuse global Files path state for list requests.");
    assert(appSource.includes("profileId: filesSelectedProfileId || null"), "Renderer request context should include the selected profile ID.");
    assert(appSource.includes("generation: filesNavigationGeneration"), "Renderer request context should include the navigation generation.");
    assert(appSource.includes('return getStorageConnectionById(selectedStorageId);'), "Renderer should not silently fall back to the default local storage connection.");
    assert(appSource.includes("getFilesProfileOptionById(filesSelectedProfileId)"), "Renderer should preserve stable profile IDs across refreshes.");
    assert(appSource.includes("refreshFilesDiscovery"), "Files workspace should refresh node/profile discovery when opened or refreshed.");
    assert(appSource.includes("if (filesConnectPromise)"), "Renderer should deduplicate Connect requests.");
    assert(appSource.includes("filesConnectionState.targetKey === target.key"), "Renderer should compare complete connection targets.");
    assert(appSource.includes("getSafeFilesConnectionError"), "Renderer should sanitize connection failures.");
    assert(appSource.includes("openFilesContextMenu") && appSource.includes('role = "menu"'), "Files workspace should expose an accessible context menu.");
    assert(appSource.includes("stageFilesCopy") && appSource.includes("pasteFilesClipboard"), "Files workspace should support staged copy and paste keyboard behavior without a second transfer system.");
    assert(appSource.includes("resolveNameConflict") && appSource.includes("getFileConflictSummary"), "Files workspace should preflight visible rename/copy/create conflicts.");
    assert(appSource.includes("async function resolveNameConflict") && appSource.includes("createSecurityTextPrompt") && appSource.includes("createSecurityConfirmation"), "Files conflict decisions should use in-app modals instead of browser dialogs.");
    assert(appSource.includes("FILE_INLINE_EDIT_LIMIT_BYTES") && appSource.includes("Large file preview disabled"), "Files workspace should avoid loading large files into the renderer editor.");
    assert(appSource.includes("Operations") && appSource.includes("transfer.retry"), "Transfer history should link to Operations and expose real retry actions when available.");
    [
      "resolveNameConflict",
      "createRemoteFolder",
      "createRemoteFile",
      "renameRemoteEntry",
      "copyRemoteEntry",
      "pasteFilesClipboard",
      "deleteRemoteEntry",
      "downloadRemoteFile",
    ].forEach((functionName) => {
      const start = appSource.indexOf(`function ${functionName}`);
      const asyncStart = appSource.indexOf(`async function ${functionName}`);
      const functionStart = start >= 0 ? start : asyncStart;
      assert(functionStart >= 0, `Renderer should define ${functionName}.`);
      const open = appSource.indexOf("{", functionStart);
      let depth = 0;
      let body = "";
      for (let index = open; index < appSource.length; index += 1) {
        const char = appSource[index];
        if (char === "{") depth += 1;
        if (char === "}") {
          depth -= 1;
          if (depth === 0) {
            body = appSource.slice(functionStart, index + 1);
            break;
          }
        }
      }
      assert(!/window\.prompt|prompt\(|window\.confirm|confirm\(/.test(body), `${functionName} should not use browser dialogs.`);
    });

    const serviceSource = await fs.readFile(path.join(rootDir, "src", "services", "fileService.js"), "utf8");
    assert(serviceSource.includes("async identity(options = {})"), "Desktop file service should expose filesystem identity for local, Agent, and SFTP providers.");
    assert(serviceSource.includes("getFilesystemIdentity(getFileNodeConfig(options))"), "Desktop file service should route Agent identity requests to the selected node.");
    assert(serviceSource.includes("FILES_CONFLICT"), "File service should reject upload conflicts instead of silently overwriting.");
    assert(serviceSource.includes("options.conflictPolicy !== \"replace\""), "File service should require explicit replace policy for upload conflicts.");
    assert(serviceSource.includes("commitLocalFile") && serviceSource.includes("createRemoteTemporaryPath"), "File writes and transfers should stage into temporary paths before commit.");
    assert(serviceSource.includes('this.sftpCall(session, "rename", temporaryPath, remotePath)'), "SFTP writes should become visible only after the temporary upload completes.");

    const preloadSource = await fs.readFile(path.join(rootDir, "preload.js"), "utf8");
    assert(preloadSource.includes("files:identity"), "Preload should expose the Files identity IPC bridge.");

    const filesIpcSource = await fs.readFile(path.join(rootDir, "src", "ipc", "filesIpc.js"), "utf8");
    assert(filesIpcSource.includes('registerFileHandler("files:identity"'), "Main process should register the Files identity IPC handler through the shared domain wrapper.");
    assert(filesIpcSource.includes("ipcMain.handle(channel"), "Files domain registration should delegate to Electron IPC exactly once.");

    const agentServerSource = await fs.readFile(path.join(rootDir, "agent", "src", "server.js"), "utf8");
    assert(agentServerSource.includes('pathname === "/api/v1/files/identity"'), "Agent should register the filesystem identity endpoint.");

    const nodeServiceSource = await fs.readFile(path.join(rootDir, "src", "services", "nodeService.js"), "utf8");
    assert(nodeServiceSource.includes("isGenericNodeDisplayName"), "Node service should replace legacy generic Agent labels when identity is refreshed.");

    console.log("Files pipeline smoke checks passed.");
  } finally {
    agent.kill("SIGTERM");
    await new Promise((resolve) => agent.once("exit", resolve));
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
