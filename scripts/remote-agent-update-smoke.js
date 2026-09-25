// Remote Agent push update — hermetic smoke.
//
// Proves the remote update service is fail-closed and honest without any real
// SSH host:
//   - refusals: non-node target, application host, non-Linux platform, missing
//     or password-only SSH profile, undiscoverable unit;
//   - payload: manifest-driven enumeration with exclusions + deterministic
//     ustar round-trip (including the >100 char prefix path form and checksum
//     validation);
//   - SSH primitive refusals: key auth required, approved host identity
//     required, command required (real sshService, file-backed fixtures);
//   - happy path: discovery -> stage (tar on stdin) -> backup-before-publish
//     swap -> verify -> record;
//   - verify failure: rollback runs and the record says rolled-back;
//   - teeth: the swap-ordering invariant rejects a publish-before-stop script.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const Module = require("module");

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-remote-agent-update-"));
const configDirectory = path.join(smokeRoot, "config");
fs.mkdirSync(configDirectory, { recursive: true });

const electronStub = {
  app: {
    getPath: () => smokeRoot,
    isPackaged: false,
  },
};

// The real sshService is loaded before the service patch so its refusal legs
// exercise the shipped implementation; the service under test gets light stubs
// for its unrelated transports.
const originalModuleLoad = Module._load;
const realSshServiceModule = originalModuleLoad.call(Module, "../src/services/sshService", module, false);
const remoteServicePath = path.join(__dirname, "..", "src", "services", "remoteAgentUpdateService.js");
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return electronStub;
  const parentIsRemoteService = parent?.filename === remoteServicePath;
  if (parentIsRemoteService && request === "./diagnosticsService") return { log: () => {}, logError: () => {} };
  if (parentIsRemoteService && request === "./nodeService") return { getNode: () => null };
  if (parentIsRemoteService && request === "./applicationHostService") return { APPLICATION_HOST_NODE_ID: "application-host" };
  if (parentIsRemoteService && request === "./sshService") return { SshService: class StubSshService {} };
  if (parentIsRemoteService && request === "./localAgentRuntimeService") {
    return {
      getBundledLocalAgentRuntime: () => ({ exists: false, runtimeRoot: null, packaged: false }),
      getBundledLocalAgentVersion: () => null,
    };
  }
  return originalModuleLoad.call(this, request, parent, isMain);
};
let remoteAgentUpdateService;
try {
  remoteAgentUpdateService = require(remoteServicePath);
} finally {
  Module._load = originalModuleLoad;
}

const { updateRemoteAgent, getRemoteUpdateDirectory, _test } = remoteAgentUpdateService;
const { enumerateRuntimePayload } = require("../src/shared/agentRuntimePayload");
const { createTarGz, readTarEntries } = require("../src/shared/agentRuntimeTar");

function writeFile(relativePath, content) {
  const target = path.join(smokeRoot, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

function assertSwapOrderingInvariant(script) {
  const backupIndex = script.indexOf('cp -a "$ROOT/$p" "$BACKUP/$p"');
  const stopIndex = script.indexOf("systemctl --user stop");
  const publishIndex = script.indexOf('cp -a "$STAGE/$p" "$ROOT/$p"');
  assert(backupIndex >= 0, "swap script must copy the live runtime into the backup");
  assert(stopIndex >= 0, "swap script must stop the unit");
  assert(publishIndex >= 0, "swap script must publish the staged runtime");
  if (backupIndex > stopIndex) throw new Error("backup must happen before the Agent is stopped");
  if (stopIndex > publishIndex) throw new Error("nothing may be published before the Agent is stopped");
}

// ---------------------------------------------------------------------------
// Phase 1: pure helpers.
// ---------------------------------------------------------------------------
{
  const located = _test.parseExecStartValue("{ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/anxos/app/agent/src/server.js ; ignore_errors=no }");
  assert(located, "ExecStart parsing must locate the entrypoint");
  assert.strictEqual(located.entrypoint, "/srv/anxos/app/agent/src/server.js");
  assert.strictEqual(_test.runtimeRootFromEntrypoint(located.entrypoint), "/srv/anxos/app");
  assert.strictEqual(_test.runtimeRootFromEntrypoint("/agent/src/server.js"), null, "the filesystem root is not a valid runtime root");
  assert.strictEqual(_test.runtimeRootFromEntrypoint("/srv/x/data/server.js"), null, "unrelated entrypoints must not resolve");
  const ps = _test.parsePsEntrypoint("root 1 /usr/bin/node /home/anx/Projects/AnxOS-Control-Center/agent/src/server.js");
  assert(ps && ps.entrypoint === "/home/anx/Projects/AnxOS-Control-Center/agent/src/server.js", "ps fallback must locate the entrypoint");
  assert.strictEqual(_test.parseExecStartValue(""), null);
  assert.strictEqual(_test.shellQuote("a'b"), "'a'\\''b'");
}

// ---------------------------------------------------------------------------
// Phase 2: swap ordering invariant, including teeth on a mutated script.
// ---------------------------------------------------------------------------
{
  const script = _test.buildSwapScript({
    runtimeRoot: "/srv/anxos",
    stagedDir: "/srv/anxos/.anxos-agent-update/stamp/staged",
    backupDir: "/srv/anxos/.anxos-agent-update/stamp/backup",
    unitName: "anxos-agent",
    includedPaths: ["agent/src", "src/shared"],
  });
  assertSwapOrderingInvariant(script);
  assert(script.includes("set -eu"), "the swap script must fail fast");
  assert(script.includes('|| { echo "STOP_FAILED"; exit 2; }'), "a failed stop must abort before anything is published");
  assert(script.includes("SWAP_ROLLED_BACK"), "a failed start must roll back inside the script");
  const rollback = _test.buildRollbackScript({
    runtimeRoot: "/srv/anxos",
    backupDir: "/srv/anxos/.anxos-agent-update/stamp/backup",
    unitName: "anxos-agent",
    includedPaths: ["agent/src"],
  });
  assert(rollback.includes("ROLLBACK_OK"), "the rollback script must report success");
  // Teeth: the invariant must reject a script that publishes before stopping.
  const publishFirst = script.replace('cp -a "$STAGE/$p" "$ROOT/$p"', 'cp -a "$STAGE/$p" "$ROOT/$p"').split("systemctl --user stop").reverse().join("systemctl --user stop");
  assert.throws(() => assertSwapOrderingInvariant(publishFirst), /nothing may be published before the Agent is stopped|backup must happen/);
  console.log("Phase 2 passed: swap ordering invariant has teeth.");
}

// ---------------------------------------------------------------------------
// Phase 3: payload enumeration + tar round-trip.
// ---------------------------------------------------------------------------
const payloadRoot = path.join(smokeRoot, "runtime");
{
  writeFile("runtime/config/local-agent-runtime.json", JSON.stringify({
    schemaVersion: 1,
    includedPaths: ["agent/src", "src/shared", "node_modules/dotenv", "config/templates"],
    excludedPatterns: [".env", ".env.*", "*.log", "*.map", ".git", "node_modules/.cache", "test", "tests"],
  }));
  writeFile("runtime/agent/src/server.js", "// server\n");
  writeFile("runtime/agent/src/routes/instances.js", "// instances\n");
  writeFile("runtime/agent/src/debug.log", "noise\n");
  writeFile("runtime/src/shared/util.js", "// util\n");
  writeFile("runtime/node_modules/dotenv/index.js", "// dotenv\n");
  writeFile("runtime/config/templates/a.json", "{}\n");
  writeFile("runtime/config/templates/b.env", "SECRET=1\n");
  writeFile("runtime/.env", "SECRET=1\n");
  writeFile("runtime/test/spec.test.js", "// test\n");

  const payload = enumerateRuntimePayload(payloadRoot);
  const relativePaths = payload.files.map((file) => file.relativePath);
  assert.deepStrictEqual(relativePaths, [
    "agent/src/routes/instances.js",
    "agent/src/server.js",
    "config/templates/a.json",
    "config/templates/b.env",
    "node_modules/dotenv/index.js",
    "src/shared/util.js",
  ], `payload enumeration drifted: ${relativePaths.join(", ")}`);
  assert(payload.totalBytes > 0, "payload must report its byte size");

  const archive = createTarGz(payload.files.map((file) => ({
    relativePath: file.relativePath,
    content: fs.readFileSync(file.absolutePath),
    mode: file.mode,
  })));
  const entries = readTarEntries(zlib.gunzipSync(archive));
  assert.deepStrictEqual(entries.map((entry) => entry.relativePath).sort(), [...relativePaths].sort(), "tar entries must match the payload");
  const server = entries.find((entry) => entry.relativePath === "agent/src/server.js");
  assert.strictEqual(server.content.toString("utf8"), "// server\n", "tar content must round-trip");

  // Long paths must use the ustar prefix form and still round-trip.
  const longPath = `agent/src/${"nested/".repeat(12)}deep/file.js`;
  const longArchive = readTarEntries(zlib.gunzipSync(createTarGz([{ relativePath: longPath, content: Buffer.from("deep"), mode: 0o644 }])));
  assert.strictEqual(longArchive[0].relativePath, longPath, "long paths must round-trip through the prefix field");

  // Checksum validation must have teeth.
  const corrupted = Buffer.from(zlib.gunzipSync(archive));
  corrupted[0] = corrupted[0] === 0x61 ? 0x62 : 0x61;
  assert.throws(() => readTarEntries(corrupted), /checksum mismatch/);
  console.log("Phase 3 passed: payload enumeration and tar round-trip verified.");
}

// Phase 3b: payload dependency baseline. The remote update replaces only the
// manifest paths and never touches other node_modules, so the Agent's loaded
// graph may rely on: Node builtins, the shipped dotenv copy, and the
// lazily-loaded desktop-side packages that resolve from the node's existing
// node_modules (electron/ssh2/js-yaml). A NEW bare dependency in the reachable
// graph fails here until it is consciously added to this baseline.
{
  const repoRoot = path.join(__dirname, "..");
  const seen = new Set();
  const bare = new Set();
  const walk = (absolutePath) => {
    if (seen.has(absolutePath) || !fs.existsSync(absolutePath)) return;
    seen.add(absolutePath);
    const source = fs.readFileSync(absolutePath, "utf8");
    const pattern = /require\(\s*[`'"]([^`'"]+)[`'"]\s*\)/g;
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const specifier = match[1];
      if (specifier.startsWith(".")) {
        let resolved = path.resolve(path.dirname(absolutePath), specifier);
        if (!path.extname(resolved)) {
          if (fs.existsSync(`${resolved}.js`)) resolved = `${resolved}.js`;
          else if (fs.existsSync(path.join(resolved, "index.js"))) resolved = path.join(resolved, "index.js");
          else continue;
        }
        walk(resolved);
      } else if (!specifier.startsWith("/")) {
        bare.add(specifier);
      }
    }
  };
  walk(path.join(repoRoot, "agent", "src", "server.js"));
  const baseline = [
    "async_hooks", "child_process", "crypto", "dotenv", "electron", "fs", "fs/promises", "http", "js-yaml",
    "net", "os", "path", "ssh2", "stream", "url", "zlib",
  ];
  const added = [...bare].filter((specifier) => !baseline.includes(specifier)).sort();
  const removed = baseline.filter((specifier) => !bare.has(specifier)).sort();
  assert.deepStrictEqual(added, [], `The Agent graph gained bare dependencies not covered by the update payload baseline: ${added.join(", ")}`);
  assert.deepStrictEqual(removed, [], `The Agent graph no longer requires baseline packages: ${removed.join(", ")}`);
  console.log(`Phase 3b passed: Agent graph dependency baseline verified (${seen.size} modules, ${bare.size} bare specifiers).`);
}

// ---------------------------------------------------------------------------
// Phase 4: real sshService refusals (file-backed profiles under a temp config
// dir, no connection attempts).
// ---------------------------------------------------------------------------
async function main() {
  {
  process.env.ANXHUB_CONFIG_DIR = configDirectory;
  const profilesPath = path.join(configDirectory, "ssh-profiles.json");
  fs.writeFileSync(profilesPath, `${JSON.stringify({
    schemaVersion: 1,
    servers: [
      { id: "key-server", displayName: "Key Server", host: "192.0.2.10", nodeId: "node-key" },
      { id: "pw-server", displayName: "Password Server", host: "192.0.2.11", nodeId: "node-pw" },
    ],
    profiles: [
      { id: "key-profile", serverId: "key-server", displayName: "Key Profile", host: "192.0.2.10", port: 22, username: "anx", authType: "privateKey", privateKeyPath: path.join(configDirectory, "id_test"), nodeId: "node-key" },
      { id: "pw-profile", serverId: "pw-server", displayName: "Password Profile", host: "192.0.2.11", port: 22, username: "anx", authType: "password", privateKeyPath: null, nodeId: "node-pw" },
    ],
    defaultServerId: "key-server",
    defaultProfileId: "key-profile",
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(configDirectory, "ssh-known-hosts.json"), "{}\n");

  const ssh = new realSshServiceModule.SshService();
  assert.strictEqual(ssh.getProfileForNode("node-key")?.id, "key-profile", "profile-for-node lookup must resolve the assigned profile");
  assert.strictEqual(ssh.getProfileForNode("node-absent"), null, "an unassigned node must resolve to no profile");
  assert.throws(() => ssh.runCommand("key-profile", "   "), (error) => error.code === "SSH_COMMAND_REQUIRED", "an empty command must refuse");
  assert.throws(() => ssh.runCommand("pw-profile", "true"), (error) => error.code === "SSH_COMMAND_KEY_AUTH_REQUIRED", "password profiles must not run unattended commands");
  assert.throws(() => ssh.runCommand("key-profile", "true"), (error) => error.code === "SSH_HOST_KEY_NOT_APPROVED", "an unapproved host identity must refuse before connecting");
  console.log("Phase 4 passed: SSH command refusals verified against the real service.");
}

// ---------------------------------------------------------------------------
// Phase 5: orchestration inside the update service.
// ---------------------------------------------------------------------------
const keyProfile = { id: "key-profile", displayName: "Key Profile", nodeId: "node-key", authType: "privateKey" };
const payload = enumerateRuntimePayload(payloadRoot);
const updateDir = path.join(smokeRoot, "agent-updates");

function baseOptions(overrides = {}) {
  return {
    resolveNode: async () => ({ id: "node-key", displayName: "Anxlab", platform: "linux" }),
    sshService: { getProfileForNode: () => keyProfile, runCommand: async () => ({ code: 0, stdout: "", stderr: "" }) },
    payloadReader: () => ({ runtime: { packaged: false }, payload }),
    bundledVersion: "9.9.9",
    updateDir,
    sleep: async () => {},
    verifyAttempts: 3,
    verifyDelayMs: 0,
    ...overrides,
  };
}

const discoveryStdout = "--- exec ---\n{ path=/usr/bin/node ; argv[]=/usr/bin/node /srv/anxos/app/agent/src/server.js ; ignore_errors=no }\n--- ps ---\n/usr/bin/node /srv/anxos/app/agent/src/server.js\n--- node ---\n/usr/bin/node\n";

{
  const calls = [];
  const runner = async (profileId, command, options = {}) => {
    calls.push({ command, stdin: options.stdin || null });
    if (command.includes("ExecStart")) return { code: 0, stdout: discoveryStdout, stderr: "" };
    if (command.includes("tar -xzf -")) return { code: 0, stdout: "STAGE_OK\n512", stderr: "" };
    if (command.includes("SWAP_OK")) return { code: 0, stdout: "BACKUP_OK\nSTOP_OK\nPUBLISH_OK\nSWAP_OK", stderr: "" };
    throw new Error(`unexpected command: ${command.slice(0, 80)}`);
  };
  let probes = 0;
  const healthProbe = async () => {
    probes += 1;
    return probes === 1
      ? { connected: true, networkInventoryOk: false, agentVersion: "0.1.0" }
      : { connected: true, networkInventoryOk: true, agentVersion: "0.1.0" };
  };
  const result = await updateRemoteAgent("node-key", baseOptions({ runner, healthProbe }));
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.runtimeRoot, "/srv/anxos/app");
  assert.strictEqual(calls.length, 3, `expected discovery + stage + swap, saw ${calls.length}`);
  const stageCall = calls[1];
  assert(Buffer.isBuffer(stageCall.stdin), "the stage command must receive the tar payload on stdin");
  const staged = readTarEntries(zlib.gunzipSync(stageCall.stdin));
  assert(staged.some((entry) => entry.relativePath === "agent/src/server.js"), "the staged archive must contain the agent entrypoint");
  assert(!staged.some((entry) => entry.relativePath.split("/").includes(".env")), "excluded files must not be staged");
  assertSwapOrderingInvariant(calls[2].command);
  assert(calls[2].command.includes("'anxos-agent'"), "the swap must drive the managed unit");
  assert(probes >= 2, "verification must retry until the node answers the new routes");
  const record = JSON.parse(fs.readFileSync(path.join(updateDir, "remote-last-update.json"), "utf8"));
  assert.strictEqual(record.status, "updated");
  assert.strictEqual(record.runtimeRoot, "/srv/anxos/app");
  assert.strictEqual(record.payloadFiles, payload.files.length);
  assert(record.steps.every((step) => step.state === "complete" || step.state === "pending" && step.id === "rollback"), "all executed steps must be complete");
  console.log("Phase 5 passed: happy path staged, swapped, verified, and recorded.");
}

{
  const calls = [];
  const runner = async (profileId, command, options = {}) => {
    calls.push({ command, stdin: options.stdin || null });
    if (command.includes("ExecStart")) return { code: 0, stdout: discoveryStdout, stderr: "" };
    if (command.includes("tar -xzf -")) return { code: 0, stdout: "STAGE_OK\n512", stderr: "" };
    if (command.includes("ROLLBACK_PUBLISHED")) return { code: 0, stdout: "ROLLBACK_PUBLISHED\nROLLBACK_OK", stderr: "" };
    if (command.includes("SWAP_OK")) return { code: 0, stdout: "BACKUP_OK\nSTOP_OK\nPUBLISH_OK\nSWAP_OK", stderr: "" };
    throw new Error(`unexpected command: ${command.slice(0, 80)}`);
  };
  let failure = null;
  try {
    await updateRemoteAgent("node-key", baseOptions({
      runner,
      healthProbe: async () => ({ connected: true, networkInventoryOk: false, agentVersion: "0.1.0" }),
    }));
  } catch (error) {
    failure = error;
  }
  assert(failure, "a verification failure must reject");
  assert.strictEqual(failure.code, "REMOTE_AGENT_UPDATE_VERIFY_FAILED");
  assert(calls.some((call) => call.command.includes("ROLLBACK_PUBLISHED")), "the rollback script must run when verification fails");
  const record = JSON.parse(fs.readFileSync(path.join(updateDir, "remote-last-update.json"), "utf8"));
  assert.strictEqual(record.status, "rolled-back");
  console.log("Phase 5b passed: verification failure rolled back and was recorded.");
}

{
  const refusalCases = [
    [{ id: "application-host", displayName: "This PC", platform: "linux" }, "REMOTE_AGENT_UPDATE_LOCAL_TARGET"],
    [{ id: "node-key", displayName: "Windows Box", platform: "win32" }, "REMOTE_AGENT_UPDATE_PLATFORM_UNSUPPORTED"],
  ];
  for (const [node, expectedCode] of refusalCases) {
    let failure = null;
    try {
      await updateRemoteAgent(node.id, baseOptions({
        resolveNode: async () => node,
        runner: async () => {
          throw new Error("refusals must not reach the transport");
        },
      }));
    } catch (error) {
      failure = error;
    }
    assert.strictEqual(failure?.code, expectedCode, `expected ${expectedCode}, saw ${failure?.code}`);
  }
  // An unhealthy node must be refused before any SSH command runs: swapping the
  // runtime of an Agent that cannot boot is how a node is left broken.
  {
    let failure = null;
    const runnerCalls = [];
    try {
      await updateRemoteAgent("node-key", baseOptions({
        runner: async (profileId, command) => {
          runnerCalls.push(command);
          throw new Error("an unhealthy node must not reach the transport");
        },
        healthProbe: async () => ({ connected: false, networkInventoryOk: false, probeError: "AGENT_UNAVAILABLE" }),
      }));
    } catch (error) {
      failure = error;
    }
    assert.strictEqual(failure?.code, "REMOTE_AGENT_UPDATE_NODE_UNHEALTHY", `expected REMOTE_AGENT_UPDATE_NODE_UNHEALTHY, saw ${failure?.code}`);
    assert.strictEqual(runnerCalls.length, 0, "the pre-flight refusal must not run any SSH command");
  }
  for (const [profile, expectedCode] of [[null, "REMOTE_AGENT_UPDATE_SSH_PROFILE_MISSING"], [{ id: "pw", nodeId: "node-key", authType: "password" }, "REMOTE_AGENT_UPDATE_SSH_KEY_REQUIRED"]]) {
    let failure = null;
    try {
      await updateRemoteAgent("node-key", baseOptions({
        sshService: { getProfileForNode: () => profile, runCommand: async () => ({ code: 0, stdout: "", stderr: "" }) },
        runner: async () => {
          throw new Error("refusals must not reach the transport");
        },
      }));
    } catch (error) {
      failure = error;
    }
    assert.strictEqual(failure?.code, expectedCode, `expected ${expectedCode}, saw ${failure?.code}`);
  }
  let failure = null;
  try {
    await updateRemoteAgent("node-key", baseOptions({
      runner: async () => ({ code: 0, stdout: "--- exec ---\n--- ps ---\n--- node ---\n", stderr: "" }),
      healthProbe: async () => ({ connected: true, networkInventoryOk: false, agentVersion: "0.1.0" }),
    }));
  } catch (error) {
    failure = error;
  }
  assert.strictEqual(failure?.code, "REMOTE_AGENT_UPDATE_UNIT_NOT_FOUND", "an undiscoverable unit must refuse before staging");
  console.log("Phase 5c passed: all pre-flight refusals are fail-closed.");
}

{
  // Verify failure where the rollback also fails to restore health must be
  // reported as unconfirmed instead of a clean rollback.
  const calls = [];
  const runner = async (profileId, command) => {
    calls.push(command);
    if (command.includes("ExecStart")) return { code: 0, stdout: discoveryStdout, stderr: "" };
    if (command.includes("tar -xzf -")) return { code: 0, stdout: "STAGE_OK\n512", stderr: "" };
    if (command.includes("ROLLBACK_PUBLISHED")) return { code: 0, stdout: "ROLLBACK_PUBLISHED\nROLLBACK_OK", stderr: "" };
    if (command.includes("SWAP_OK")) return { code: 0, stdout: "BACKUP_OK\nSTOP_OK\nPUBLISH_OK\nSWAP_OK", stderr: "" };
    throw new Error(`unexpected command: ${command.slice(0, 80)}`);
  };
  let probes = 0;
  let failure = null;
  try {
    await updateRemoteAgent("node-key", baseOptions({
      runner,
      // Healthy before the update, unhealthy during verification and after the
      // rollback (a schema-mismatched runtime resembles this).
      healthProbe: async () => {
        probes += 1;
        return probes === 1
          ? { connected: true, networkInventoryOk: true, agentVersion: "0.1.0" }
          : { connected: false, networkInventoryOk: false, probeError: "AGENT_UNAVAILABLE" };
      },
    }));
  } catch (error) {
    failure = error;
  }
  assert(failure, "an unconfirmed rollback must reject");
  assert.strictEqual(failure.code, "REMOTE_AGENT_UPDATE_VERIFY_FAILED");
  assert(/did not restore a healthy Agent/i.test(failure.message), `unconfirmed rollback message drifted: ${failure.message}`);
  assert(calls.some((command) => command.includes("ROLLBACK_PUBLISHED")), "the rollback script must still run");
  const record = JSON.parse(fs.readFileSync(path.join(updateDir, "remote-last-update.json"), "utf8"));
  assert.strictEqual(record.rollback.verified, false, "an unverified rollback must be recorded as unverified");
  assert.strictEqual(record.healthAfterRollback.connected, false);
  console.log("Phase 5d passed: unconfirmed rollback is reported honestly.");
}

// ---------------------------------------------------------------------------
// Phase 5e: downgrade guard. A node whose Agent reports a strictly newer
// version than this Desktop's bundled runtime is refused before any transport
// or payload work; older, equal, unknown and non-semver versions keep updating
// (fail-open on versions the guard cannot compare).
// ---------------------------------------------------------------------------
{
  let runnerCalls = 0;
  let payloadReads = 0;
  let failure = null;
  try {
    await updateRemoteAgent("node-key", baseOptions({
      runner: async () => {
        runnerCalls += 1;
        throw new Error("the downgrade refusal must not reach the transport");
      },
      payloadReader: () => {
        payloadReads += 1;
        throw new Error("the downgrade refusal must not read the runtime payload");
      },
      healthProbe: async () => ({ connected: true, networkInventoryOk: false, agentVersion: "9.9.10" }),
    }));
  } catch (error) {
    failure = error;
  }
  assert(failure, "a newer node Agent must be refused");
  assert.strictEqual(failure.code, "AGENT_DOWNGRADE_REFUSED", `expected AGENT_DOWNGRADE_REFUSED, saw ${failure.code}`);
  assert.strictEqual(failure.details?.nodeAgentVersion, "9.9.10", "the refusal must name the node's newer version");
  assert.strictEqual(failure.details?.bundledVersion, "9.9.9", "the refusal must name the bundled version");
  assert.strictEqual(runnerCalls, 0, "the downgrade refusal must not run any SSH command");
  assert.strictEqual(payloadReads, 0, "the downgrade refusal must not read the runtime payload");
  console.log("Phase 5e passed: a newer node Agent refused before any transport side effect.");
}

{
  const proceedCases = [
    ["an older node Agent", "0.1.0"],
    ["an equal node Agent", "9.9.9"],
    ["an unknown node Agent version", undefined],
    ["a non-semver node Agent version", "banana"],
  ];
  for (const [label, agentVersion] of proceedCases) {
    const calls = [];
    const runner = async (profileId, command, options = {}) => {
      calls.push({ command, stdin: options.stdin || null });
      if (command.includes("ExecStart")) return { code: 0, stdout: discoveryStdout, stderr: "" };
      if (command.includes("tar -xzf -")) return { code: 0, stdout: "STAGE_OK\n512", stderr: "" };
      if (command.includes("SWAP_OK")) return { code: 0, stdout: "BACKUP_OK\nSTOP_OK\nPUBLISH_OK\nSWAP_OK", stderr: "" };
      throw new Error(`unexpected command: ${command.slice(0, 80)}`);
    };
    let probes = 0;
    const result = await updateRemoteAgent("node-key", baseOptions({
      runner,
      healthProbe: async () => {
        probes += 1;
        return probes === 1
          ? { connected: true, networkInventoryOk: false, agentVersion }
          : { connected: true, networkInventoryOk: true, agentVersion: "0.1.0" };
      },
    }));
    assert.strictEqual(result.ok, true, `${label} must proceed with the update`);
    assert.strictEqual(calls.length, 3, `${label} must reach discovery + stage + swap, saw ${calls.length}`);
  }
  console.log("Phase 5e passed: older, equal, unknown and non-semver node Agents still update.");
}

assert.strictEqual(typeof getRemoteUpdateDirectory(), "string");
console.log("Remote Agent update smoke passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});