const assert = require("assert");
const fs = require("fs/promises");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const fileService = require("../agent/src/services/fileService");

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
  // Shared readiness helper: the poll budget here must not double as a latent
  // boot-latency test (it did, and it failed suites under load for no product
  // reason), and a failure must name the actual cause instead of always
  // reporting a timeout. See scripts/test-helpers/agent-readiness.js.
  const { waitForAgentReady } = require("./test-helpers/agent-readiness");
  return waitForAgentReady({
    label: "Temporary Agent",
    probe: async () => (await fetch(`${url}/api/v1/health`, { headers: { Authorization: `Bearer ${token}` } })).ok,
  });
}

function setRoot(rootValue) {
  process.env.AGENT_FILE_ROOTS = rootValue;
  delete process.env.ANXOS_AGENT_RUNTIME_CONFIG;
  delete process.env.ANXHUB_CONFIG_DIR;
}

async function assertRejectsWithCode(promise, code, message) {
  await assert.rejects(
    promise,
    (error) => {
      if (process.env.ANXOS_FILES_ROOT_DIAGNOSTICS === "1" && error?.code !== code) console.error("files-root rejection", { expected: code, actual: error?.code, message: error?.message });
      return error?.code === code;
    },
    message || `Expected ${code}`,
  );
}

async function main() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "anx-agent-files-root-"));
  const originalEnv = {
    AGENT_FILE_ROOTS: process.env.AGENT_FILE_ROOTS,
    AGENT_INSTANCE_ROOT: process.env.AGENT_INSTANCE_ROOT,
    AGENT_BACKUP_ROOT: process.env.AGENT_BACKUP_ROOT,
    ANXOS_AGENT_RUNTIME_CONFIG: process.env.ANXOS_AGENT_RUNTIME_CONFIG,
    ANXHUB_CONFIG_DIR: process.env.ANXHUB_CONFIG_DIR,
  };

  try {
    const homeRoot = path.join(tempRoot, "home", "anx");
    const homeParent = path.join(tempRoot, "home");
    const similarPrefix = path.join(tempRoot, "home", "anx2");
    const outsideRoot = path.join(tempRoot, "outside");
    await fs.mkdir(homeRoot, { recursive: true });
    await fs.mkdir(similarPrefix, { recursive: true });
    await fs.mkdir(outsideRoot, { recursive: true });
    const instanceRoot = path.join(homeRoot, "AnxOS Instances");
    const backupRoot = path.join(homeRoot, "AnxOS Backups");
    await fs.mkdir(instanceRoot, { recursive: true });
    await fs.mkdir(backupRoot, { recursive: true });
    await fs.writeFile(path.join(homeRoot, "inside.txt"), "inside", "utf8");
    process.env.AGENT_INSTANCE_ROOT = instanceRoot;
    process.env.AGENT_BACKUP_ROOT = backupRoot;

    setRoot(homeRoot);
    assert.strictEqual((await fileService.resolveAllowedPath(homeRoot)).path, homeRoot, "The root path itself must be allowed.");
    assert.strictEqual((await fileService.resolveAllowedPath(`${homeRoot}${path.sep}`)).path, homeRoot, "Trailing separators should normalize to the same root.");
    assert.strictEqual((await fileService.resolveAllowedPath(path.join(homeRoot, "inside.txt"))).root, homeRoot, "A path inside /home/anx should be allowed.");
    await assertRejectsWithCode(fileService.resolveAllowedPath(similarPrefix), "PATH_NOT_ALLOWED", "Similar prefix paths must not be treated as inside the root.");
    await assertRejectsWithCode(fileService.resolveAllowedPath(outsideRoot), "PATH_NOT_ALLOWED", "Paths outside the configured root must be rejected.");

    setRoot(homeParent);
    assert.strictEqual((await fileService.resolveAllowedPath(homeRoot)).root, homeParent, "A home directory inside /home should be allowed.");
    assert.strictEqual((await fileService.resolveAllowedPath(`${homeRoot}${path.sep}`)).path, homeRoot, "Trailing slashes inside a parent root should be accepted.");

    process.env.AGENT_FILE_ROOTS = "";
    await assertRejectsWithCode(fileService.resolveAllowedPath(homeRoot), "FILESYSTEM_ROOT_EMPTY", "An empty configured root must fail explicitly.");

    setRoot("relative-root");
    await assertRejectsWithCode(fileService.resolveAllowedPath(homeRoot), "FILESYSTEM_ROOT_INVALID", "Relative configured roots must be rejected.");

    setRoot(path.join(tempRoot, "missing"));
    await assertRejectsWithCode(fileService.resolveAllowedPath(homeRoot), "FILESYSTEM_ROOT_MISSING", "Missing configured roots must fail explicitly.");

    const unreadableRoot = path.join(tempRoot, "unreadable");
    await fs.mkdir(unreadableRoot);
    if (process.platform === "win32") {
      fileService.__setTestHooks({ access: async (target, mode) => {
        if (path.resolve(target) === path.resolve(unreadableRoot)) {
          const error = new Error("simulated ACL denial");
          error.code = "EACCES";
          throw error;
        }
        return fs.access(target, mode);
      } });
    }
    if (process.platform === "win32" || (typeof process.getuid !== "function" || process.getuid() !== 0)) {
      await fs.chmod(unreadableRoot, 0o000);
      try {
        setRoot(unreadableRoot);
        await assertRejectsWithCode(fileService.resolveAllowedPath(unreadableRoot), "FILESYSTEM_ROOT_UNREADABLE", "Unreadable configured roots must fail explicitly.");
      } finally {
        if (process.platform !== "win32") await fs.chmod(unreadableRoot, 0o700);
        fileService.__setTestHooks();
        setRoot(homeRoot);
      }
    }

    if (process.platform !== "win32") {
    const symlinkRoot = path.join(tempRoot, "symlink-root");
    await fs.mkdir(symlinkRoot);
    await fs.symlink(homeRoot, path.join(symlinkRoot, "inside-link"));
    await fs.symlink(outsideRoot, path.join(homeRoot, "outside-link"));
    setRoot(homeParent);
    assert.strictEqual((await fileService.resolveAllowedPath(path.join(symlinkRoot, "..", "home", "anx"))).path, homeRoot, "Realpath normalization should allow equivalent paths inside the root.");
    assert.strictEqual((await fileService.resolveAllowedPath(path.join(homeParent, "anx"))).path, homeRoot, "Identity home can differ from root while remaining inside it.");
    setRoot(homeRoot);
    await assertRejectsWithCode(fileService.resolveAllowedPath(path.join(homeRoot, "outside-link")), "PATH_NOT_ALLOWED", "Symlinks resolving outside the root must be rejected.");
    const outsideWriteTarget = path.join(outsideRoot, "must-not-change.txt");
    const writeEscapeLink = path.join(homeRoot, "write-escape.txt");
    await fs.writeFile(outsideWriteTarget, "outside-original", "utf8");
    await fs.symlink(outsideWriteTarget, writeEscapeLink);
    await assertRejectsWithCode(
      fileService.mutateFile("write", { path: writeEscapeLink, content: "escaped" }),
      "PATH_NOT_ALLOWED",
      "Editor writes must reject symlink destinations instead of following them outside the authorized root.",
    );
    assert.strictEqual(await fs.readFile(outsideWriteTarget, "utf8"), "outside-original", "Rejected symlink writes must leave the outside target unchanged.");
    const atomicTarget = path.join(homeRoot, "atomic-save.txt");
    await fileService.mutateFile("write", { path: atomicTarget, content: "saved atomically" });
    assert.strictEqual(await fs.readFile(atomicTarget, "utf8"), "saved atomically", "Editor writes should still save regular in-root files.");
    const tempArtifacts = (await fs.readdir(homeRoot)).filter((name) => name.includes("atomic-save.txt") && name.endsWith(".tmp"));
    assert.deepStrictEqual(tempArtifacts, [], "Successful atomic writes must not leave temporary files behind.");

    const unsafeCopySource = path.join(homeRoot, "unsafe-copy-source");
    const unsafeCopyDestination = path.join(homeRoot, "unsafe-copy-destination");
    await fs.mkdir(unsafeCopySource);
    await fs.writeFile(path.join(unsafeCopySource, "regular.txt"), "regular", "utf8");
    await fs.symlink(outsideWriteTarget, path.join(unsafeCopySource, "outside-link.txt"));
    await assertRejectsWithCode(
      fileService.mutateFile("copy", { sourcePath: unsafeCopySource, destinationPath: unsafeCopyDestination }),
      "COPY_SYMLINK_UNSUPPORTED",
      "Recursive copies must reject nested symbolic links instead of reproducing an escape path.",
    );
    await assert.rejects(fs.stat(unsafeCopyDestination), { code: "ENOENT" });

    const copySource = path.join(homeRoot, "copy-source.txt");
    const copyDestination = path.join(homeRoot, "copy-destination.txt");
    await fs.writeFile(copySource, "replacement", "utf8");
    await fs.writeFile(copyDestination, "original", "utf8");
    await assertRejectsWithCode(
      fileService.mutateFile("copy", { sourcePath: copySource, destinationPath: copyDestination }),
      "FILES_CONFLICT",
      "Copy must not overwrite an existing file without explicit confirmation.",
    );
    assert.strictEqual(await fs.readFile(copyDestination, "utf8"), "original");
    await fileService.mutateFile("copy", { sourcePath: copySource, destinationPath: copyDestination, conflictPolicy: "replace" });
    assert.strictEqual(await fs.readFile(copyDestination, "utf8"), "replacement");
    assert.deepStrictEqual(
      (await fs.readdir(homeRoot)).filter((name) => name.includes("copy-destination.txt") && name.endsWith(".copy.tmp")),
      [],
      "Atomic copy replacement must not leave temporary files behind.",
    );
    }

    const copyDirectorySource = path.join(homeRoot, "copy-directory-source");
    const copyDirectoryDestination = path.join(homeRoot, "copy-directory-destination");
    await fs.mkdir(copyDirectorySource);
    await fs.mkdir(copyDirectoryDestination);
    const directoryCopy = fileService.mutateFile("copy", {
      sourcePath: copyDirectorySource,
      destinationPath: copyDirectoryDestination,
      conflictPolicy: "replace",
    });
    await assertRejectsWithCode(directoryCopy, "DIRECTORY_REPLACE_UNSUPPORTED", "Folder replacement must be rejected until it can be committed and rolled back safely.");

    const danglingLink = path.join(homeRoot, "dangling-link");
    let danglingLinkCreated = false;
    try {
      await fs.symlink(path.join(tempRoot, "does-not-exist"), danglingLink);
      danglingLinkCreated = true;
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
        console.warn(`Skipping dangling-symlink fixture: Windows symlink capability unavailable (${error.code}).`);
      } else {
        throw error;
      }
    }
    if (danglingLinkCreated) {
      await assertRejectsWithCode(fileService.resolveAllowedPath(danglingLink), "PATH_NOT_FOUND", "Realpath failures for missing targets must return a structured missing-path error.");
    }

    const runtimeConfig = path.join(tempRoot, "agent-runtime.json");
    await fs.writeFile(runtimeConfig, JSON.stringify({ allowedFolders: [homeParent] }), "utf8");
    const future = new Date(Date.now() + 5000);
    await fs.utimes(runtimeConfig, future, future);
    process.env.ANXOS_AGENT_RUNTIME_CONFIG = runtimeConfig;
    process.env.AGENT_FILE_ROOTS = homeRoot;
    const precedenceReport = await fileService.getRootValidationReport();
    assert.strictEqual(precedenceReport.effectiveRoot, homeRoot, "AGENT_FILE_ROOTS must take precedence over runtime allowedFolders.");
    assert(precedenceReport.restartRequired, "Runtime config changes after process start should report that restart may be required.");

    delete process.env.AGENT_FILE_ROOTS;
    const configReport = await fileService.getRootValidationReport();
    assert.strictEqual(configReport.effectiveRoot, homeParent, "Runtime allowedFolders should be used when AGENT_FILE_ROOTS is absent.");

    const identity = await fileService.getFilesystemIdentity();
    assert.strictEqual(identity.filesystemRoot, homeParent, "Identity should expose the effective filesystem root.");
    assert.strictEqual(identity.filesystemRootStatus.status, "valid", "Identity should expose root validation status.");
    assert.strictEqual(identity.filesystemRootExists, true, "Identity should expose root existence.");
    assert.strictEqual(identity.filesystemRootReadable, true, "Identity should expose root readability.");
    assert.strictEqual(identity.configSourceType, "runtime-config", "Identity should expose a safe config source type.");
    assert(identity.capabilities?.upload && identity.capabilities?.editText && identity.capabilities?.storageUsage, "Identity should expose local filesystem capabilities.");
    assert(Array.isArray(identity.shortcuts), "Identity should expose safe filesystem shortcuts.");
    const instanceShortcut = identity.shortcuts.find((shortcut) => shortcut.id === "anxos-instances");
    const backupShortcut = identity.shortcuts.find((shortcut) => shortcut.id === "anxos-backups");
    assert.strictEqual(instanceShortcut?.available, true, "Managed instance shortcut should be available inside the configured root.");
    assert.strictEqual(backupShortcut?.available, true, "Managed backup shortcut should be available inside the configured root.");
    assert(identity.roots.some((root) => root.name === "AnxOS Instances" && root.path === instanceRoot), "Available managed shortcuts should be exposed as navigable roots.");
    assert(identity.roots.some((root) => root.name === "AnxOS Backups" && root.path === backupRoot), "Available backup shortcuts should be exposed as navigable roots.");

    const appSource = (await fs.readFile(path.join(rootDir, "app.js"), "utf8")).replace(/\r\n/g, "\n");
    assert(appSource.includes("isPathInsideFilesIdentityRoots"), "Renderer should validate remembered paths against the Agent filesystem root.");
    assert(appSource.includes("homeInsideFilesystemRoot ? identity?.homeDirectory"), "Renderer should use home only when it is inside the authorized root.");
    assert(appSource.includes("state.currentPath = null"), "Renderer should discard remembered paths invalidated by root changes.");
    assert(appSource.includes("isWindowsPathValue") && appSource.includes("target?.providerType === \"agent-native\""), "Renderer should preserve Windows path isolation for Linux Agent profiles.");

    const port = await getFreePort();
    const token = "agent-files-root-smoke-token";
    const url = `http://127.0.0.1:${port}`;
    const authConfigDir = path.join(tempRoot, "agent-auth-config");
    await fs.mkdir(authConfigDir, { recursive: true });
    await fs.writeFile(path.join(authConfigDir, "agent.json"), JSON.stringify({
      backendMode: "agent",
      agentUrl: url,
      agentToken: token,
    }), "utf8");
    const agent = spawn(process.execPath, [path.join(rootDir, "agent", "src", "server.js")], {
      cwd: path.join(rootDir, "agent"),
      env: {
        ...process.env,
        AGENT_HOST: "127.0.0.1",
        AGENT_PORT: String(port),
        AGENT_TOKEN: token,
        AGENT_FILE_ROOTS: homeParent,
        AGENT_INSTANCE_ROOT: instanceRoot,
        AGENT_BACKUP_ROOT: backupRoot,
        ANXOS_AGENT_RUNTIME_CONFIG: "",
        ANXHUB_CONFIG_DIR: authConfigDir,
        ANXHUB_AGENT_CONFIG_PATH: path.join(authConfigDir, "agent.json"),
        ANXOS_TEST_SHUTDOWN_IPC: "1",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });

    try {
      await waitForAgent(url, token);
      const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      const identityResponse = await fetch(`${url}/api/v1/files/identity`, { headers });
      assert.strictEqual(identityResponse.status, 200, "Identity endpoint should be reachable.");
      const endpointIdentity = await identityResponse.json();
      assert.strictEqual(endpointIdentity.filesystemRoot, homeParent, "Identity endpoint should use the configured root.");
      assert.strictEqual(endpointIdentity.homeInsideFilesystemRoot, false, "The real process home is outside the temporary smoke root.");
      assert.strictEqual(endpointIdentity.initialPath, homeParent, "Identity should fall back to the authorized root when home is outside it.");
      assert(endpointIdentity.capabilities?.download && endpointIdentity.capabilities?.createFolder, "Identity endpoint should expose file capabilities.");
      assert(endpointIdentity.shortcuts.some((shortcut) => shortcut.id === "anxos-instances" && shortcut.available), "Identity endpoint should expose the managed instance shortcut.");

      const listResponse = await fetch(`${url}/api/v1/files/list?path=${encodeURIComponent(endpointIdentity.initialPath)}`, { headers });
      assert.strictEqual(listResponse.status, 200, "List endpoint should accept the identity-selected initial path.");
      const listPayload = await listResponse.json();
      assert.strictEqual(listPayload.root, homeParent, "List endpoint should use the same effective root as identity.");
      assert(listPayload.capabilities?.upload && listPayload.capabilities?.sort, "List endpoint should expose file capabilities.");
      assert.strictEqual(listPayload.summary.totalCount, listPayload.entries.length, "List endpoint should expose immediate directory storage summary.");
      assert(listPayload.roots.some((root) => root.name === "AnxOS Instances" && root.path === instanceRoot), "List endpoint should expose available shortcuts as roots.");

      const outsideResponse = await fetch(`${url}/api/v1/files/list?path=${encodeURIComponent(outsideRoot)}`, { headers });
      assert.strictEqual(outsideResponse.status, 403, "List endpoint should reject paths outside the configured root.");
      const outsidePayload = await outsideResponse.json();
      assert.strictEqual(outsidePayload.error.code, "PATH_NOT_ALLOWED", "Outside-root rejection should use a stable error code.");
    } finally {
      if (process.platform === "win32") agent.send({ type: "shutdown" });
      else agent.kill("SIGTERM");
      await new Promise((resolve) => agent.once("exit", resolve));
      assert.strictEqual(agent.exitCode, 0, "Agent SIGTERM shutdown should drain owned HTTP resources and exit cleanly.");
    }

    console.log("Agent filesystem root smoke checks passed.");
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
