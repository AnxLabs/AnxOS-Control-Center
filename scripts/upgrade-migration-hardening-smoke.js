// Upgrade and migration hardening (hermetic). One numbered check per finding:
//   1 upgrade-migration-1  Agent runtimes are compared by release build, not
//                          agent/package.json's fixed placeholder version, so
//                          an older Desktop refuses to push its runtime over a
//                          newer node and the Local Agent update state works.
//   2 upgrade-migration-2  An in-place upgrade's run of the installed
//                          uninstaller stops the AnxOS Helper but keeps its
//                          startup task; only a real uninstall removes it.
//   3 upgrade-migration-3  A full restore interrupted mid-swap (Agent killed)
//                          leaves the server recoverable, and startup puts it
//                          back with no staging folders left behind.
//   4 upgrade-migration-4  Install opens the verified installer again after
//                          an earlier handoff in the same session.
// Every root is a fresh temp folder. Electron, SSH, the node registry and
// health probes are fakes; the interrupted restore runs in a child process
// that exits mid-swap. Nothing touches the network, a real Agent, a scheduled
// task, a service or the developer's data.
const assert = require("assert");
const childProcess = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");
const zlib = require("zlib");

const rootDir = path.resolve(__dirname, "..");
const RESTORE_CHILD_FLAG = "--interrupted-restore-child";

function pinRoots(smokeRoot) {
  process.env.ANXHUB_CONFIG_DIR = path.join(smokeRoot, "config");
  process.env.ANXOS_CONFIG_DIR = path.join(smokeRoot, "config");
  process.env.ANXOS_LOG_DIR = path.join(smokeRoot, "logs");
  process.env.AGENT_LOG_DIR = path.join(smokeRoot, "logs");
  process.env.AGENT_INSTANCE_ROOT = path.join(smokeRoot, "instances");
  process.env.AGENT_BACKUP_ROOT = path.join(smokeRoot, "backups");
  process.env.AGENT_TEMP_DIR = path.join(smokeRoot, "agent-temp");
  process.env.AGENT_IDENTITY_PATH = path.join(smokeRoot, "identity.json");
  process.env.AGENT_URL = "http://127.0.0.1:9";
  delete process.env.ANXOS_AGENT_RUNTIME_CONFIG;
  delete process.env.ANXOS_AGENT_ARTIFACT_VERSION;
  for (const directory of [process.env.ANXHUB_CONFIG_DIR, process.env.AGENT_INSTANCE_ROOT, process.env.AGENT_BACKUP_ROOT]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  const jobLifecycle = require("../src/shared/instances/jobLifecycle");
  jobLifecycle.configureJobLifecycle({ getRoot: () => path.join(process.env.AGENT_INSTANCE_ROOT, "jobs") });
}

function stubModule(relative, exports) {
  const resolved = require.resolve(path.join(rootDir, relative));
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
}

// Agent config and instance lifecycle for the backup service, as in
// backup-file-fixes-smoke: every root stays in temp and nothing is started.
function stubBackupDependencies() {
  const instanceRoot = process.env.AGENT_INSTANCE_ROOT;
  stubModule("agent/src/config.js", { getConfig: () => ({ instanceRoot, allowedFolders: [] }) });
  const states = new Map();
  stubModule("agent/src/services/instances/instanceService.js", {
    async getStatus(id) {
      if (!fs.existsSync(path.join(instanceRoot, id))) throw Object.assign(new Error("INSTANCE_NOT_FOUND"), { code: "INSTANCE_NOT_FOUND" });
      return { ...(states.get(id) || { state: "Stopped", pid: null }) };
    },
    async stopInstance(id) {
      states.set(id, { state: "Stopped", pid: null });
      return { id, state: "Stopped" };
    },
    async startInstance(id) {
      states.set(id, { state: "Running", pid: 4242 });
      return { id, state: "Running" };
    },
    getWorldScopeCandidates: () => [],
  });
}

function makeInstance(id, files = {}) {
  const instancePath = path.join(process.env.AGENT_INSTANCE_ROOT, id);
  const all = {
    "config.json": JSON.stringify({ id, name: id, state: "Stopped" }),
    "data/world/level.dat": `${id}-world-before`,
    ...files,
  };
  for (const [relative, content] of Object.entries(all)) {
    const target = path.join(instancePath, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return instancePath;
}

// ---------------------------------------------------------------------------
// Child process for check 3: take a full backup, change the world, restore,
// and exit (as SIGTERM would) in the middle of the folder swap.
// ---------------------------------------------------------------------------
async function runInterruptedRestoreChild(smokeRoot) {
  pinRoots(smokeRoot);
  stubBackupDependencies();
  const fsp = require("fs/promises");
  const backupService = require("../agent/src/services/backupService");
  const instancePath = makeInstance("mc1");
  const backup = (await backupService.createBackup({ instanceId: "mc1", type: "full", name: "before" })).backup;
  fs.writeFileSync(path.join(instancePath, "data", "world", "level.dat"), "mc1-world-after");
  const livePath = await fsp.realpath(instancePath);
  const same = (candidate) => path.resolve(String(candidate)) === path.resolve(livePath);
  const realRm = fsp.rm;
  const realRename = fsp.rename;
  // Delete-in-place swap: the kill lands after config.json is gone.
  fsp.rm = async (target, options) => {
    if (same(target)) {
      await realRm(path.join(livePath, "config.json"), { force: true });
      process.exit(143);
    }
    return realRm(target, options);
  };
  // Rename-aside swap: the kill lands between the two renames.
  fsp.rename = async (from, to) => {
    const result = await realRename(from, to);
    if (same(from)) process.exit(143);
    return result;
  };
  await backupService.restoreBackup({ backupId: backup.id, confirmOverwrite: true, restart: false });
  process.exit(0);
}

// Child process for check 5: a full restore fails at its swap, so it rolls
// back from the safety snapshot, and the Agent is stopped in the middle of
// that rollback.
async function runInterruptedRollbackChild(smokeRoot) {
  pinRoots(smokeRoot);
  stubBackupDependencies();
  const fsp = require("fs/promises");
  const backupService = require("../agent/src/services/backupService");
  const instancePath = makeInstance("mc6");
  const backup = (await backupService.createBackup({ instanceId: "mc6", type: "full", name: "before" })).backup;
  fs.writeFileSync(path.join(instancePath, "data", "world", "level.dat"), "mc6-world-after");
  const livePath = await fsp.realpath(instancePath);
  const same = (candidate) => path.resolve(String(candidate)) === path.resolve(livePath);
  const realRm = fsp.rm;
  const realRename = fsp.rename;
  let swapFailed = false;
  let putBack = false;
  // The restore's own swap fails once (a locked file, say), so it puts the
  // live folder back and the rollback runs.
  fsp.rename = async (from, to) => {
    if (!swapFailed && String(from).includes(".restore-staging-") && same(to)) {
      swapFailed = true;
      throw Object.assign(new Error("resource busy"), { code: "EBUSY" });
    }
    const result = await realRename(from, to);
    if (swapFailed && same(to)) putBack = true;
    // Rollback by rename-aside: the kill lands between its two renames.
    else if (putBack && same(from)) process.exit(143);
    return result;
  };
  // Rollback by delete-in-place: the kill lands after config.json is gone.
  fsp.rm = async (target, options) => {
    if (putBack && same(target)) {
      await realRm(path.join(livePath, "config.json"), { force: true });
      process.exit(143);
    }
    return realRm(target, options);
  };
  await backupService.restoreBackup({ backupId: backup.id, confirmOverwrite: true, restart: false }).catch(() => {});
  process.exit(swapFailed ? 0 : 3);
}

if (process.argv[2] === "--interrupted-rollback-child") {
  runInterruptedRollbackChild(process.argv[3]).catch((error) => {
    console.error(error);
    process.exit(2);
  });
  return;
}

if (process.argv[2] === RESTORE_CHILD_FLAG) {
  runInterruptedRestoreChild(process.argv[3]).catch((error) => {
    console.error(error);
    process.exit(2);
  });
  return;
}

// ---------------------------------------------------------------------------
// Main process.
// ---------------------------------------------------------------------------
const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-upgrade-migration-"));
process.on("exit", () => {
  try { fs.rmSync(smokeRoot, { recursive: true, force: true }); } catch {}
});
pinRoots(smokeRoot);

const userDataRoot = path.join(smokeRoot, "user-data");
fs.mkdirSync(userDataRoot, { recursive: true });
const openedPaths = [];
const electronStub = {
  app: {
    getPath: () => userDataRoot,
    getAppPath: () => rootDir,
    getVersion: () => "2.0.0",
    isPackaged: false,
  },
  shell: {
    openPath: async (target) => {
      openedPaths.push(target);
      return "";
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  autoUpdater: undefined,
};

const remoteServicePath = path.join(rootDir, "src", "services", "remoteAgentUpdateService.js");
const fakeNodeHealth = { result: null };
const originalModuleLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (parent?.filename === remoteServicePath) {
    if (request === "./diagnosticsService") return { log: () => {}, logError: () => {} };
    if (request === "./nodeService") return { getNode: () => null, checkNodeHealth: async () => fakeNodeHealth.result };
    if (request === "./serviceRouter") return { getNetworkInventory: async () => ({ ok: true }) };
    if (request === "./applicationHostService") return { APPLICATION_HOST_NODE_ID: "application-host" };
    if (request === "./sshService") return { SshService: class StubSshService {} };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};

const releaseConfig = JSON.parse(fs.readFileSync(path.join(rootDir, "release.json"), "utf8"));
const DESKTOP_BUILD = `${releaseConfig.version}-build${releaseConfig.build}`;
const OLDER_BUILD = `${releaseConfig.version}-build${releaseConfig.build - 6}`;
const NEWER_BUILD = `${releaseConfig.version}-build${releaseConfig.build + 1}`;

const checks = [];
function check(id, title, run) {
  checks.push({ id, title, run });
}

async function rejectsWithCode(promise, code, message) {
  let caught = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert(caught, `${message}: expected ${code}, but the call succeeded.`);
  assert.strictEqual(caught.code, code, `${message}: expected ${code}, got ${caught.code} (${caught.message}).`);
  return caught;
}

// Fixtures shared with remote-agent-update-smoke: the SSH profile reaches the
// expected node, discovery finds the desktop-managed user unit.
const keyProfile = { id: "key-profile", displayName: "Key Profile", nodeId: "node-key", authType: "privateKey" };
const discoveryStdout = "--- exec ---\n{ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/anxos/app/agent/src/server.js ; ignore_errors=no }\n--- ps ---\n/usr/bin/node /srv/anxos/app/agent/src/server.js\n--- node ---\n/usr/bin/node\n";
const targetProbeStdout = "--- user ---\nloaded\n--- system ---\nnot-found\n--- hostname ---\nanxlab\n--- agents ---\n\"deviceId\":\"device-key\"\n";

function makeRunner(calls, { verifyRollback = false } = {}) {
  return async (profileId, command, options = {}) => {
    if (command.includes("--- hostname ---")) return { code: 0, stdout: targetProbeStdout, stderr: "" };
    calls.push({ command, stdin: options.stdin || null });
    if (command.includes("ExecStart")) return { code: 0, stdout: discoveryStdout, stderr: "" };
    if (command.includes("tar -xzf -")) return { code: 0, stdout: "STAGE_OK\n512", stderr: "" };
    if (verifyRollback && command.includes("ROLLBACK_PUBLISHED")) return { code: 0, stdout: "ROLLBACK_PUBLISHED\nROLLBACK_OK", stderr: "" };
    if (command.includes("SWAP_OK")) return { code: 0, stdout: "BACKUP_OK\nSTOP_OK\nPUBLISH_OK\nSWAP_OK", stderr: "" };
    throw new Error(`unexpected command: ${command.slice(0, 80)}`);
  };
}

function remoteOptions(overrides = {}) {
  const payloadRoot = path.join(smokeRoot, "payload-root");
  fs.mkdirSync(path.join(payloadRoot, "agent", "src"), { recursive: true });
  fs.writeFileSync(path.join(payloadRoot, "agent", "src", "server.js"), "// agent\n");
  fs.writeFileSync(path.join(payloadRoot, "agent", "package.json"), "{\"version\":\"0.1.0\"}\n");
  fs.writeFileSync(path.join(payloadRoot, "local-agent-runtime.json"), JSON.stringify({ includedPaths: ["agent/package.json", "agent/src"] }));
  const { enumerateRuntimePayload } = require("../src/shared/agentRuntimePayload");
  return {
    resolveNode: async () => ({ id: "node-key", displayName: "Anxlab", platform: "linux", hostname: "Anxlab", agentIdentity: { deviceId: "device-key" } }),
    sshService: { getProfileForNode: () => keyProfile, runCommand: async () => ({ code: 0, stdout: "", stderr: "" }) },
    payloadReader: () => ({ runtime: { packaged: false }, payload: enumerateRuntimePayload(payloadRoot) }),
    updateDir: path.join(smokeRoot, "agent-updates"),
    sleep: async () => {},
    verifyAttempts: 2,
    verifyDelayMs: 0,
    ...overrides,
  };
}

function nodeHealth(identity) {
  return { nodeId: "node-key", connected: true, status: "online", health: { ok: true, identity } };
}

check(1, "upgrade-migration-1: Agent runtimes are compared by release build", async () => {
  // The Agent reports its build beside the placeholder package version. The
  // Desktop passes it to the bundled Local Agent through the environment.
  process.env.ANXOS_AGENT_ARTIFACT_VERSION = NEWER_BUILD;
  const identity = require("../agent/src/services/deviceIdentityService").getDeviceIdentity();
  delete process.env.ANXOS_AGENT_ARTIFACT_VERSION;
  assert.strictEqual(identity.agentVersion, "0.1.0", "The package version is the placeholder this check is about.");
  assert.strictEqual(identity.agentArtifactVersion, NEWER_BUILD, "/health identity must carry the Agent's release build.");

  const { updateRemoteAgent } = require("../src/services/remoteAgentUpdateService");
  const { getBundledLocalAgentVersion } = require("../src/services/localAgentRuntimeService");
  assert.strictEqual(getBundledLocalAgentVersion(null), identity.agentVersion, "Both sides really do report the same placeholder version.");

  // A node on a newer build is refused before anything is uploaded, through
  // the real default health probe (checkNodeHealth's response shape).
  fakeNodeHealth.result = nodeHealth(identity);
  const calls = [];
  await rejectsWithCode(updateRemoteAgent("node-key", remoteOptions({ runner: makeRunner(calls), bundledBuild: OLDER_BUILD })), "AGENT_DOWNGRADE_REFUSED", "An older Desktop pushing over a newer node");
  assert.deepStrictEqual(calls.map((call) => call.command.slice(0, 20)), [], "Nothing may be discovered, staged or swapped before the refusal.");

  // A node that reports a build this Desktop cannot order is refused too.
  fakeNodeHealth.result = nodeHealth({ ...identity, agentArtifactVersion: OLDER_BUILD });
  await rejectsWithCode(updateRemoteAgent("node-key", remoteOptions({ runner: makeRunner([]), bundledBuild: null })), "AGENT_BUILD_UNVERIFIED", "A node build with no bundled build to compare");

  // An older node is updated, and the pushed runtime is stamped with its build
  // so the updated Agent reports it.
  const upgradeCalls = [];
  let probes = 0;
  const result = await updateRemoteAgent("node-key", remoteOptions({
    runner: makeRunner(upgradeCalls),
    bundledBuild: DESKTOP_BUILD,
    healthProbe: async () => {
      probes += 1;
      return { connected: true, networkInventoryOk: true, agentVersion: "0.1.0", agentArtifactVersion: probes === 1 ? OLDER_BUILD : DESKTOP_BUILD };
    },
  }));
  assert.strictEqual(result.updated, true);
  const staged = zlib.gunzipSync(upgradeCalls.find((call) => call.command.includes("tar -xzf -")).stdin).toString("latin1");
  assert(staged.includes("agent-build.json") && staged.includes(`"artifactVersion": "${DESKTOP_BUILD}"`), "The staged runtime must carry its build stamp.");
  const swapScript = upgradeCalls.find((call) => call.command.includes("SWAP_OK")).command;
  assert(swapScript.includes("'agent-build.json'"), "The stamp is published, backed up and rolled back with the payload.");
  // The rollback (restore_backup, run by roll_back on a failed start) removes
  // a path that has no backup, i.e. one that did not exist before the swap.
  assert(/if \[ -e "\$BACKUP\/\$p" \]; then\s[^\n]*cp -a "\$BACKUP\/\$p" "\$ROOT\/\$p"[^\n]*\s+else\s+rm -rf "\$ROOT\/\$p"/.test(swapScript), "A failed start must remove paths that did not exist before (the stamp of a first push).");
  assert(/else echo "START_FAILED"; roll_back /.test(swapScript), "A failed start rolls the payload back.");

  // The same old runtime still answering after the swap is not "updated".
  const staleCalls = [];
  await rejectsWithCode(updateRemoteAgent("node-key", remoteOptions({
    runner: makeRunner(staleCalls, { verifyRollback: true }),
    bundledBuild: DESKTOP_BUILD,
    healthProbe: async () => ({ connected: true, networkInventoryOk: true, agentVersion: "0.1.0", agentArtifactVersion: OLDER_BUILD }),
  })), "REMOTE_AGENT_UPDATE_VERIFY_FAILED", "A node still reporting its old build after the swap");
  assert(staleCalls.some((call) => call.command.includes("ROLLBACK_PUBLISHED") && call.command.includes("else rm -rf")), "The rollback must run and remove paths that had no backup.");

  // A node that predates build reporting (no build) is still updatable.
  fakeNodeHealth.result = nodeHealth({ agentVersion: "0.1.0" });
  const legacy = await updateRemoteAgent("node-key", remoteOptions({ runner: makeRunner([]), bundledBuild: DESKTOP_BUILD }));
  assert.strictEqual(legacy.updated, true, "A node without a build predates this check and is older than this Desktop.");

  // The Local Agent update state compares builds whenever both are known.
  const control = require("../src/services/agentControlService");
  const state = (agentArtifactVersion, agentVersion = "0.1.0") => control._test.getLocalAgentUpdateState({ agentVersion, identity: { agentVersion, ...(agentArtifactVersion ? { agentArtifactVersion } : {}) } });
  const older = state(OLDER_BUILD);
  assert.strictEqual(older.updateAvailable, true, "A running Agent on an older build must report an update.");
  assert.strictEqual(older.versionMismatch, true, "Update Local Agent must not return early for an older build.");
  assert.strictEqual(older.bundledVersion, DESKTOP_BUILD);
  assert.strictEqual(older.installedVersion, OLDER_BUILD);
  assert.strictEqual(state(NEWER_BUILD).agentNewerThanDesktop, true, "A running Agent on a newer build must be reported as newer.");
  assert.strictEqual(state(DESKTOP_BUILD).state, "Current");
  assert.strictEqual(state(null, "0.0.1").updateAvailable, true, "Without a build the legacy comparison still applies.");
  assert.strictEqual(state(null).state, "Current", "Without a build the placeholder versions are still equal.");
  assert.strictEqual(control._test.agentEnvironment({ host: "127.0.0.1", port: 1, allowedFolders: [] }).ANXOS_AGENT_ARTIFACT_VERSION, DESKTOP_BUILD, "The bundled Local Agent is told its build when the Desktop starts it.");

  // A pushed runtime's stamp wins over a stale checkout release.json, a
  // placeholder never counts, and nothing found is unknown.
  const { resolveAgentArtifactVersion } = require("../src/shared/agentBuildIdentity");
  const runtimeRoot = path.join(smokeRoot, "runtime-root");
  fs.mkdirSync(runtimeRoot, { recursive: true });
  assert.strictEqual(resolveAgentArtifactVersion({ runtimeRoot, env: {} }), null);
  fs.writeFileSync(path.join(runtimeRoot, "release.json"), JSON.stringify({ version: "2.0", build: 205 }));
  assert.strictEqual(resolveAgentArtifactVersion({ runtimeRoot, env: {} }).artifactVersion, "2.0-build205");
  fs.writeFileSync(path.join(runtimeRoot, "agent-release.json"), JSON.stringify({ artifactVersion: "0.1.0" }));
  assert.strictEqual(resolveAgentArtifactVersion({ runtimeRoot, env: {} }).artifactVersion, "2.0-build205", "A placeholder is never a build.");
  fs.writeFileSync(path.join(runtimeRoot, "agent-build.json"), JSON.stringify({ artifactVersion: "2.0-build211" }));
  assert.strictEqual(resolveAgentArtifactVersion({ runtimeRoot, env: {} }).artifactVersion, "2.0-build211");
  assert.strictEqual(resolveAgentArtifactVersion({ runtimeRoot, env: { ANXOS_AGENT_ARTIFACT_VERSION: "2.0-build212" } }).artifactVersion, "2.0-build212");
});

check(2, "upgrade-migration-2: an upgrade keeps the AnxOS Helper task", async () => {
  const nsh = fs.readFileSync(path.join(rootDir, "windows", "installer.nsh"), "utf8").replace(/\r\n/g, "\n");
  const macro = nsh.match(/!macro customUnInstall\n([\s\S]*?)!macroend/);
  assert(macro, "customUnInstall must exist.");
  const body = macro[1].split("\n").filter((line) => !line.trim().startsWith(";")).join("\n");
  const updated = body.match(/\$\{if\} \$\{isUpdated\}\n([\s\S]*?)\$\{else\}\n([\s\S]*?)\$\{endif\}/);
  assert(updated, "customUnInstall must branch on ${isUpdated}.");
  assert(/-Mode Stop\b/.test(updated[1]) && !/-Mode Uninstall\b/.test(updated[1]), "On an update the installed uninstaller must only stop the Helper.");
  assert(/-Mode Uninstall\b/.test(updated[2]), "A real uninstall must still remove the Helper task.");
  assert.strictEqual((body.match(/-Mode Uninstall\b/g) || []).length, 1, "No other path may remove the Helper task.");

  const script = fs.readFileSync(path.join(rootDir, "windows", "install-agent-task.ps1"), "utf8").replace(/\r\n/g, "\n");
  assert(/ValidateSet\("Install", "Uninstall", "Stop"\)/.test(script), "install-agent-task.ps1 must accept -Mode Stop.");
  const stopBranch = script.indexOf('if ($Mode -eq "Stop")');
  const stopProcess = script.indexOf("Stop-OwnedAgentProcess -ExpectedExecutable $ExecutablePath\n");
  const unregister = script.indexOf("Unregister-ScheduledTask -TaskName $taskName");
  assert(stopBranch > stopProcess, "Stop mode must stop the running Helper first, so its files can be replaced.");
  assert(stopBranch < unregister, "Stop mode must exit before anything is unregistered.");
  assert(/if \(\$Mode -eq "Stop"\) \{\n\s+Write-ElevationResult -ExitCode 0\n\s+exit 0\n\}/.test(script), "Stop mode must report success and exit.");
  if (process.platform === "win32") {
    // Parse only (no execution): the script must stay valid PowerShell.
    const parse = childProcess.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      "$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile($env:ANX_PS1, [ref]$null, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }"],
    { env: { ...process.env, ANX_PS1: path.join(rootDir, "windows", "install-agent-task.ps1") }, encoding: "utf8", timeout: 60000 });
    if (!parse.error) assert.strictEqual(parse.status, 0, `install-agent-task.ps1 must parse: ${parse.stdout}${parse.stderr}`);
  }
});

check(3, "upgrade-migration-3: an interrupted full restore is recovered at startup", async () => {
  const restoreRoot = path.join(smokeRoot, "restore");
  fs.mkdirSync(restoreRoot, { recursive: true });
  const child = childProcess.spawnSync(process.execPath, [__filename, RESTORE_CHILD_FLAG, restoreRoot], { encoding: "utf8", timeout: 120000 });
  assert.strictEqual(child.status, 143, `The restore child must be stopped mid-swap (status ${child.status}): ${child.stdout}${child.stderr}`);

  // Next Agent start: same roots, fresh process state.
  pinRoots(restoreRoot);
  stubBackupDependencies();
  const backupService = require("../agent/src/services/backupService");
  assert.strictEqual(typeof backupService.recoverInterruptedRestores, "function", "Startup must have a restore recovery step.");
  const report = await backupService.recoverInterruptedRestores();
  const instanceRoot = process.env.AGENT_INSTANCE_ROOT;
  const configPath = path.join(instanceRoot, "mc1", "config.json");
  assert(fs.existsSync(configPath), `The server folder must be back after startup recovery (${JSON.stringify(report)}).`);
  assert.strictEqual(JSON.parse(fs.readFileSync(configPath, "utf8")).id, "mc1");
  const world = fs.readFileSync(path.join(instanceRoot, "mc1", "data", "world", "level.dat"), "utf8");
  assert(["mc1-world-after", "mc1-world-before"].includes(world), "The server must hold a complete pre-restore or restored world.");
  assert.deepStrictEqual(fs.readdirSync(instanceRoot).filter((name) => name.includes(".restore-")), [], "No staging or pre-restore folder may be left behind.");
  const realServer = require("fs").readFileSync(path.join(rootDir, "agent", "src", "server.js"), "utf8");
  const startup = realServer.slice(realServer.indexOf("async function startServer()"));
  assert(startup.indexOf("recoverInterruptedRestores()") >= 0 && startup.indexOf("recoverInterruptedRestores()") < startup.indexOf("recoverIncompleteInstallations()"), "The Agent must repair restores before anything lists instances.");

  // A folder left by the older delete-then-rename swap: the server lost its
  // config.json and the staging copy is the complete, rebranded restore.
  makeInstance("mc2");
  fs.rmSync(path.join(instanceRoot, "mc2", "config.json"));
  const legacyStaging = path.join(instanceRoot, "mc2.restore-staging-abc123");
  fs.mkdirSync(path.join(legacyStaging, "data", "world"), { recursive: true });
  fs.writeFileSync(path.join(legacyStaging, "config.json"), JSON.stringify({ id: "mc2", name: "mc2", state: "Stopped" }));
  fs.writeFileSync(path.join(legacyStaging, "data", "world", "level.dat"), "mc2-restored");
  // An intact server with an unfinished extract beside it.
  makeInstance("mc3");
  fs.mkdirSync(path.join(instanceRoot, "mc3.restore-staging-def456"), { recursive: true });
  // A missing server whose only copy is an incomplete extract stays for the operator.
  const orphan = path.join(instanceRoot, "mc4.restore-staging-0a0b0c");
  fs.mkdirSync(orphan, { recursive: true });
  const second = await backupService.recoverInterruptedRestores();
  assert.strictEqual(fs.readFileSync(path.join(instanceRoot, "mc2", "data", "world", "level.dat"), "utf8"), "mc2-restored", "A completed staging copy must finish an interrupted legacy swap.");
  assert(fs.existsSync(path.join(instanceRoot, "mc3", "config.json")) && !fs.existsSync(path.join(instanceRoot, "mc3.restore-staging-def456")), "An unfinished extract beside an intact server is removed.");
  assert(fs.existsSync(orphan) && second.kept.some((entry) => entry.instanceId === "mc4"), "Nothing is deleted when no complete server copy exists.");

  // A normal full restore leaves neither folder behind.
  const mc5 = makeInstance("mc5");
  const backup = (await backupService.createBackup({ instanceId: "mc5", type: "full", name: "before" })).backup;
  fs.writeFileSync(path.join(mc5, "data", "world", "level.dat"), "mc5-after");
  await backupService.restoreBackup({ backupId: backup.id, confirmOverwrite: true, restart: false });
  assert.strictEqual(fs.readFileSync(path.join(mc5, "data", "world", "level.dat"), "utf8"), "mc5-world-before");
  assert.deepStrictEqual(fs.readdirSync(instanceRoot).filter((name) => name.startsWith("mc5.")), [], "A finished restore leaves no staging or pre-restore folder.");
});

check(5, "Build 212: a restore's rollback is crash-safe and Agent shutdown waits for restores", async () => {
  // (a) Stopped in the middle of the rollback, the server still comes back.
  const rollbackRoot = path.join(smokeRoot, "rollback");
  fs.mkdirSync(rollbackRoot, { recursive: true });
  const child = childProcess.spawnSync(process.execPath, [__filename, "--interrupted-rollback-child", rollbackRoot], { encoding: "utf8", timeout: 120000 });
  assert.strictEqual(child.status, 143, `The rollback child must be stopped mid-rollback (status ${child.status}): ${child.stdout}${child.stderr}`);
  pinRoots(rollbackRoot);
  stubBackupDependencies();
  for (const key of Object.keys(require.cache)) if (key.includes(`${path.sep}agent${path.sep}src${path.sep}services${path.sep}backupService`)) delete require.cache[key];
  const backupService = require("../agent/src/services/backupService");
  const report = await backupService.recoverInterruptedRestores();
  const instanceRoot = process.env.AGENT_INSTANCE_ROOT;
  const configPath = path.join(instanceRoot, "mc6", "config.json");
  assert(fs.existsSync(configPath), `A rollback stopped mid-way must not leave the server deleted (${JSON.stringify(report)}).`);
  const world = fs.readFileSync(path.join(instanceRoot, "mc6", "data", "world", "level.dat"), "utf8");
  assert(["mc6-world-after", "mc6-world-before"].includes(world), "The server holds a complete world after recovery.");
  assert.deepStrictEqual(fs.readdirSync(instanceRoot).filter((name) => name.includes(".restore-")), [], "No staging or pre-restore folder is left behind.");

  // (b) Agent shutdown waits for a restore that is still running.
  assert.strictEqual(typeof backupService.waitForActiveRestores, "function", "The Agent must be able to wait for running restores.");
  const idle = await backupService.waitForActiveRestores(1000);
  assert.strictEqual(idle.pending, 0, "With no restore running there is nothing to wait for.");
  const mc7 = makeInstance("mc7");
  const backup = (await backupService.createBackup({ instanceId: "mc7", type: "full", name: "before" })).backup;
  const fsp = require("fs/promises");
  const realRename = fsp.rename;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let gated = false;
  fsp.rename = async (from, to) => {
    if (!gated && String(from).includes(".restore-staging-")) { gated = true; await gate; }
    return realRename(from, to);
  };
  try {
    const restoring = backupService.restoreBackup({ backupId: backup.id, confirmOverwrite: true, restart: false });
    for (let i = 0; i < 200 && !gated; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert(gated, "The restore reached its swap.");
    let settled = false;
    const waiting = backupService.waitForActiveRestores(10000).then((result) => { settled = true; return result; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(settled, false, "Shutdown waits while a restore is still swapping folders.");
    release();
    await restoring;
    const waited = await waiting;
    assert.strictEqual(waited.pending, 0, "The wait ends once the restore has finished.");
    assert(fs.existsSync(path.join(mc7, "config.json")));
  } finally {
    fsp.rename = realRename;
    release?.();
  }
  const serverSource = fs.readFileSync(path.join(rootDir, "agent", "src", "server.js"), "utf8");
  const shutdownBody = serverSource.slice(serverSource.indexOf("async function shutdown("), serverSource.indexOf("process.once(\"SIGTERM\""));
  assert(/waitForActiveRestores\(/.test(shutdownBody) && shutdownBody.indexOf("waitForActiveRestores(") < shutdownBody.lastIndexOf("process.exit(exitCode)"), "Agent shutdown waits for running restores before it exits.");
});

check(4, "upgrade-migration-4: Install reopens the verified installer after a handoff", async () => {
  const { UpdateManager } = require("../src/services/updateManager");
  const manager = new UpdateManager();
  manager.storePath = path.join(userDataRoot, "config", "updates.json");
  const installer = path.join(userDataRoot, "AnxOS-Setup.exe");
  const bytes = crypto.randomBytes(1024);
  fs.writeFileSync(installer, bytes);
  manager.state.downloadedPath = installer;
  manager.state.latest = {
    latestReleaseVersion: "2.0",
    latestBuild: releaseConfig.build + 1,
    asset: { name: "AnxOS-Setup.exe", size: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") },
  };
  manager.verifyInstallerSignature = async () => ({ applicable: true, verified: true, publisher: "AnxLabs", issuer: "Test", timestamped: true });
  openedPaths.length = 0;
  const first = await manager.install();
  assert.strictEqual(first.installed, true);
  assert.strictEqual(manager.pendingInstall.status, "handed-off");
  // The user cancels the installer; the app keeps running and Install is clicked again.
  const second = await manager.install();
  assert.strictEqual(second.installed, true, `A second Install must open the installer again (${JSON.stringify({ ...second, state: undefined })}).`);
  assert.strictEqual(openedPaths.length, 2, "The verified installer must be opened again.");
  // A click while a launch is still being verified is the only refusal.
  let release;
  manager.verifyInstallerSignature = () => new Promise((resolve) => { release = () => resolve({ applicable: false }); });
  const inFlight = manager.install();
  for (let wait = 0; wait < 200 && !release; wait += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert(release, "The first launch must reach signature verification.");
  const doubleClick = await manager.install();
  assert.strictEqual(doubleClick.alreadyRequested, true, "A double click while the launch is in progress must not open two installers.");
  release();
  assert.strictEqual((await inFlight).installed, true);
  assert.strictEqual(openedPaths.length, 3);
  // A failed verification does not leave Install stuck.
  manager.verifyInstallerSignature = async () => { throw Object.assign(new Error("bad signature"), { code: "UPDATE_INSTALLER_SIGNATURE_INVALID" }); };
  assert.strictEqual((await manager.install()).installed, false);
  manager.verifyInstallerSignature = async () => ({ applicable: false });
  assert.strictEqual((await manager.install()).installed, true, "Install must work again after a refused attempt.");
});

(async () => {
  let failed = 0;
  for (const entry of checks) {
    try {
      await entry.run();
      console.log(`PASS ${entry.id} ${entry.title}`);
    } catch (error) {
      failed += 1;
      console.error(`FAIL ${entry.id} ${entry.title}\n  ${error && error.stack ? error.stack.split("\n").slice(0, 3).join("\n  ") : error}`);
    }
  }
  if (failed) {
    console.error(`Upgrade migration hardening smoke failed: ${failed} of ${checks.length} checks (${checks.length} checks).`);
    process.exit(1);
  }
  console.log(`Upgrade migration hardening smoke passed (${checks.length} checks).`);
})();
