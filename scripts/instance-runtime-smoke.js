#!/usr/bin/env node
const assert = require("assert");
const childProcess = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");

const servicePath = require.resolve("../agent/src/services/instances/instanceService");

function clearService() {
  delete require.cache[servicePath];
}

function palworldPayload(id, port = 8211, queryPort = 27015) {
  return {
    id,
    displayName: "Palworld Runtime Smoke",
    type: "custom-command",
    workingDirectory: "data/server",
    executable: "bash",
    args: [
      "-lc",
      `chmod +x ./PalServer.sh 2>/dev/null || true; exec ./PalServer.sh -port=${port} -players=32 -useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS`,
    ],
    restartPolicy: "on-failure",
    ports: [port, queryPort],
    primaryPort: port,
    templateId: "palworld",
    game: "palworld",
    tags: ["palworld", "steamcmd", "game-server"],
    startupTimeoutMs: 7200000,
  };
}

async function withTempService(fn, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-instance-runtime-smoke-"));
  const previousRoot = process.env.AGENT_INSTANCE_ROOT;
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  process.env.AGENT_INSTANCE_ROOT = path.join(root, "instances");
  clearService();
  if (options.platform) {
    Object.defineProperty(process, "platform", {
      configurable: true,
      enumerable: originalPlatformDescriptor?.enumerable ?? true,
      value: options.platform,
    });
  }
  const instanceService = require(servicePath);
  try {
    await fn(instanceService, root);
  } finally {
    instanceService._test.setProcessInspectionProvider(null);
    instanceService._test.setProcessAliveProvider(null);
    if (previousRoot === undefined) {
      delete process.env.AGENT_INSTANCE_ROOT;
    } else {
      process.env.AGENT_INSTANCE_ROOT = previousRoot;
    }
    clearService();
    if (options.platform) {
      Object.defineProperty(process, "platform", originalPlatformDescriptor);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function createFakeChild(pid = 701001) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const originalEmit = child.emit.bind(child);
  child.emit = (eventName, ...args) => {
    if (eventName === "exit") {
      child.exitCode = args[0] ?? null;
      child.signalCode = args[1] || null;
    }
    return originalEmit(eventName, ...args);
  };
  return child;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runtimeSnapshot(instanceRoot, pid = 580981, port = 8211, queryPort = 27015) {
  const executablePath = path.join(instanceRoot, "data", "server", "Pal", "Binaries", "Linux", "PalServer-Linux-Shipping");
  return {
    processes: [{
      pid,
      ppid: 1,
      name: "PalServer-Linux-Shipping",
      exe: executablePath,
      cwd: path.join(instanceRoot, "data", "server"),
      commandLine: `${executablePath} Pal -port=${port} -players=32 -useperfthreads -NoAsyncLoadingThread -UseMultithreadForDS`,
    }],
    ports: [
      { protocol: "udp", port, pid },
      { protocol: "udp", port: queryPort, pid },
    ],
  };
}

async function createPalworld(instanceService, id = "palworld-runtime-smoke", port = 8211, queryPort = 27015) {
  await instanceService.createInstance(palworldPayload(id, port, queryPort));
  await instanceService.writeInstanceFile(id, "server/PalServer.sh", "#!/usr/bin/env bash\n");
  return path.join(process.env.AGENT_INSTANCE_ROOT, id);
}

async function assertDetachedRuntimeReconciliation() {
  await withTempService(async (instanceService) => {
    const instanceRoot = await createPalworld(instanceService);
    instanceService._test.setProcessAliveProvider((pid) => Number(pid) === 580981);
    instanceService._test.setProcessInspectionProvider(() => runtimeSnapshot(instanceRoot));

    let status = await instanceService.updateInstance("palworld-runtime-smoke", {});
    status = await instanceService.getStatus("palworld-runtime-smoke");
    assert.strictEqual(status.state, "Running", "Detached Palworld process should reconcile to Running.");
    assert.strictEqual(status.pid, 580981, "Reconciled runtime PID should be preserved.");
    assert.strictEqual(status.runtimeProcess?.ppid, 1, "Detached PPID 1 should be recorded.");
    assert.deepStrictEqual(status.runtimeProcess?.ports, [8211, 27015], "Configured Palworld ports should be verified.");

    await assert.rejects(
      () => instanceService.startInstance("palworld-runtime-smoke"),
      (error) => {
        assert.strictEqual(error.code, "INSTANCE_ALREADY_RUNNING", "Duplicate start should return already-running compatibility code.");
        assert.strictEqual(error.state, "ALREADY_RUNNING", "Duplicate start should include structured ALREADY_RUNNING state.");
        assert.strictEqual(error.runtime?.pid, 580981, "Duplicate start should report the reconciled runtime PID.");
        return true;
      },
      "Duplicate start should not launch another Palworld process."
    );

    await assert.rejects(
      () => instanceService.deleteInstance("palworld-runtime-smoke"),
      (error) => {
        assert.strictEqual(error.code, "INSTANCE_RUNNING", "Delete should refuse while detached runtime is active.");
        return true;
      },
      "Delete must guard live detached runtimes."
    );
  });
}

async function assertPalworldShellCommandNormalization() {
  await withTempService(async (instanceService) => {
    const payload = palworldPayload("palworld-command-normalization");
    const created = await instanceService.createInstance(payload);
    assert.strictEqual(created.executable, "bash", "Palworld executable should remain bash.");
    assert.deepStrictEqual(created.args, payload.args, "Palworld shell startup script should remain one argv entry.");
    assert(created.args[1].includes("2>/dev/null"), "Palworld script should preserve stderr redirect in argv[2].");
    assert(created.args[1].includes("|| true"), "Palworld script should preserve shell fallback operator in argv[2].");
    assert(created.args[1].includes("; exec ./PalServer.sh"), "Palworld script should preserve semicolon operator in argv[2].");

    await instanceService.createInstance({
      ...payload,
      id: "palworld-flattened-command",
      args: ["-lc", "chmod", "+x", "./PalServer.sh", "2>/dev/null", "||", "true;", "exec", "./PalServer.sh", "-port=8211"],
    });
    const repaired = await instanceService.updateInstance("palworld-flattened-command", {});
    assert.deepStrictEqual(
      repaired.args,
      ["-lc", "chmod +x ./PalServer.sh 2>/dev/null || true; exec ./PalServer.sh -port=8211"],
      "Existing flattened Palworld shell commands should be repaired without reinstalling."
    );
  });
}

async function assertPalworldSpawnArgvAndLogs() {
  await withTempService(async (instanceService) => {
    const payload = palworldPayload("palworld-spawn-argv");
    await instanceService.createInstance(payload);
    await instanceService.writeInstanceFile(payload.id, "server/PalServer.sh", "#!/usr/bin/env bash\n");
    instanceService._test.setProcessInspectionProvider(() => ({ processes: [], ports: [] }));
    const originalSpawn = childProcess.spawn;
    const calls = [];
    const fakeChild = createFakeChild(701101);
    childProcess.spawn = (command, args, options) => {
      calls.push({ command, args: [...args], options });
      return fakeChild;
    };
    try {
      const started = await instanceService.startInstance(payload.id);
      assert.strictEqual(started.pid, 701101, "Started Palworld wrapper PID should be recorded.");
      assert.strictEqual(calls.length, 1, "Palworld start should spawn exactly one wrapper process.");
      assert.strictEqual(calls[0].command, "bash", "argv[0] executable should be bash.");
      assert.strictEqual(calls[0].args[0], "-lc", "argv[1] should be -lc.");
      assert.strictEqual(calls[0].args[1], payload.args[1], "argv[2] should be the full Palworld shell script.");
      assert.strictEqual(calls[0].args.length, 2, "Palworld shell script must not be whitespace-split.");
      assert(calls[0].args[1].includes("2>/dev/null"), "stderr redirect should remain inside argv[2].");
      assert(calls[0].args[1].includes("|| true"), "fallback operator should remain inside argv[2].");
      assert(calls[0].args[1].includes("; exec"), "semicolon command separator should remain inside argv[2].");

      const logs = await instanceService.readLogs(payload.id, { stream: "stdout", limit: 20 });
      const launchLine = logs.entries.find((entry) => String(entry.message || "").startsWith("Launch command:"));
      assert(launchLine, "Startup logs should include a readable launch command.");
      assert(launchLine.message.includes('"chmod +x ./PalServer.sh'), "Readable launch command should quote the multi-word script argument.");
      const status = await instanceService.getStatus(payload.id);
      assert.deepStrictEqual(status.args, payload.args, "Log formatting must not mutate stored argv.");

      fakeChild.emit("exit", 0, null);
      await wait(20);
    } finally {
      childProcess.spawn = originalSpawn;
    }
  });
}

async function assertJavaScriptLauncherRepair() {
  await withTempService(async (instanceService) => {
    const id = "atm10-script-launcher-repair";
    await instanceService.createInstance({
      id,
      displayName: "ATM10 Script Launcher Repair",
      type: "java-app",
      workingDirectory: "data",
      executable: "java",
      args: ["run.sh", "nogui"],
      restartPolicy: "never",
      game: "minecraft",
      tags: ["minecraft", "modpack", "curseforge"],
      startupTimeoutMs: 60000,
    });
    await instanceService.writeInstanceFile(id, "run.sh", "#!/usr/bin/env bash\necho 'Done (1.000s)! For help, type \"help\"'\n");

    const originalSpawn = childProcess.spawn;
    const calls = [];
    const fakeChild = createFakeChild(701151);
    childProcess.spawn = (command, args, options) => {
      calls.push({ command, args: [...args], options });
      return fakeChild;
    };
    try {
      const started = await instanceService.startInstance(id);
      assert.strictEqual(started.pid, 701151, "Script launcher repair should still record the wrapper PID.");
      assert.strictEqual(calls.length, 1, "Script launcher repair should spawn exactly one process.");
      assert.strictEqual(calls[0].command, "bash", "Linux shell scripts should launch through bash instead of java.");
      assert.deepStrictEqual(calls[0].args, ["./run.sh", "nogui"], "Existing modpack script arguments should be preserved behind the shell launcher.");
      assert.strictEqual(
        path.normalize(calls[0].options.cwd),
        path.join(process.env.AGENT_INSTANCE_ROOT, id, "data"),
        "Script launch working directory should remain the instance data directory."
      );
      const repaired = await instanceService.getStatus(id);
      assert.strictEqual(repaired.executable, "bash", "Invalid persisted Java launcher should be repaired on start.");
      assert.deepStrictEqual(repaired.args, ["./run.sh", "nogui"], "Repaired launcher argv should be persisted.");
      const logs = await instanceService.readLogs(id, { stream: "stdout", limit: 20 });
      const launchLine = logs.entries.find((entry) => String(entry.message || "").startsWith("Launch command:"));
      assert(launchLine, "Script launcher startup logs should include a readable launch command.");
      assert(launchLine.message.includes("bash ./run.sh nogui"), "Script launcher log must not prefix run.sh with Java.");
      assert(!launchLine.message.includes("java run.sh"), "Script launcher log must not include java run.sh.");
      fakeChild.emit("exit", 0, null);
      await wait(20);
    } finally {
      childProcess.spawn = originalSpawn;
    }
  }, { platform: "linux" });
}

async function assertInstallerJarWithStartupScriptRepair() {
  await withTempService(async (instanceService) => {
    const id = "atm10-installer-startserver-repair";
    await instanceService.createInstance({
      id,
      displayName: "ATM10 Installer Startserver Repair",
      type: "java-app",
      workingDirectory: "data",
      executable: "java",
      args: ["-Xmx12G", "-jar", "neoforge-installer.jar", "nogui"],
      jar: "neoforge-installer.jar",
      serverJar: "neoforge-installer.jar",
      serverJarPath: "neoforge-installer.jar",
      startJar: "neoforge-installer.jar",
      restartPolicy: "never",
      game: "minecraft",
      tags: ["minecraft", "modpack", "curseforge", "neoforge"],
      startupTimeoutMs: 60000,
    });
    await instanceService.writeInstanceFile(id, "startserver.sh", "#!/usr/bin/env bash\necho 'Done (1.000s)! For help, type \"help\"'\n");
    await instanceService.writeInstanceFile(id, "user_jvm_args.txt", "-Xmx4G\n");
    await instanceService.writeInstanceFile(id, "neoforge-installer.jar", "");

    const originalSpawn = childProcess.spawn;
    const calls = [];
    const fakeChild = createFakeChild(701153);
    childProcess.spawn = (command, args, options) => {
      calls.push({ command, args: [...args], options });
      return fakeChild;
    };
    try {
      await instanceService.startInstance(id);
      assert.strictEqual(calls.length, 1, "Installer-jar repair should spawn exactly one process.");
      assert.strictEqual(calls[0].command, "bash", "Installer jars must not be used when startserver.sh exists.");
      assert.deepStrictEqual(calls[0].args, ["./startserver.sh"], "ATM10 startserver.sh should launch through bash without installer jar args.");
      const repaired = await instanceService.getStatus(id);
      assert.strictEqual(repaired.executable, "bash");
      assert.deepStrictEqual(repaired.args, ["./startserver.sh"]);
      assert.strictEqual(repaired.serverJar, null, "Installer jar should not remain configured as the runtime server jar.");
      const logs = await instanceService.readLogs(id, { stream: "stdout", limit: 20 });
      const launchLine = logs.entries.find((entry) => String(entry.message || "").startsWith("Launch command:"));
      assert(launchLine, "Installer-jar repair startup logs should include a readable launch command.");
      assert(launchLine.message.includes("bash ./startserver.sh"), "ATM10 launch log should show the shell script command.");
      assert(!launchLine.message.includes("java -jar neoforge-installer.jar nogui"), "ATM10 launch log must not show the installer jar command.");
      fakeChild.emit("exit", 0, null);
      await wait(20);
    } finally {
      childProcess.spawn = originalSpawn;
    }
  }, { platform: "linux" });
}

async function assertInstallerJarWithScriptArgumentRepair() {
  await withTempService(async (instanceService) => {
    const id = "atm10-installer-script-argument-repair";
    await instanceService.createInstance({
      id,
      displayName: "ATM10 Installer Script Argument Repair",
      type: "java-app",
      workingDirectory: "data",
      executable: "java",
      args: ["-jar", "neoforge-installer.jar", "./startserver.sh"],
      jar: "neoforge-installer.jar",
      serverJar: "neoforge-installer.jar",
      serverJarPath: "neoforge-installer.jar",
      startJar: "neoforge-installer.jar",
      startScript: "./startserver.sh",
      restartPolicy: "never",
async function assertNeoForgeRunScriptPreferenceAndRuntimeValidation() {
  await withTempService(async (instanceService) => {
    const id = "atm10-run-script-preferred";
    await instanceService.createInstance({
      id,
      displayName: "ATM10 Run Script Preferred",
      type: "java-app",
      workingDirectory: "data",
      executable: "bash",
      args: ["./startserver.sh"],
      startupScript: "startserver.sh",
      restartPolicy: "on-failure",
      game: "minecraft",
      tags: ["minecraft", "modpack", "curseforge", "neoforge"],
      startupTimeoutMs: 60000,
    });
    await instanceService.writeInstanceFile(id, "startserver.sh", "#!/usr/bin/env bash\necho 'Done (1.000s)! For help, type \"help\"'\n");
    await instanceService.writeInstanceFile(id, "neoforge-installer.jar", "");
    await instanceService.writeInstanceFile(id, "startserver.sh", "#!/usr/bin/env bash\nexec ./run.sh \"$@\"\n");
    await instanceService.writeInstanceFile(id, "run.sh", "#!/usr/bin/env bash\nexec java @user_jvm_args.txt @libraries/net/neoforged/neoforge/21.1.228/unix_args.txt \"$@\"\n");
    await instanceService.writeInstanceFile(id, "user_jvm_args.txt", "-Xmx4G\n");
    await instanceService.writeInstanceFile(id, "libraries/net/neoforged/neoforge/21.1.228/unix_args.txt", "--launchTarget neoforgeserver\n");

    const originalSpawn = childProcess.spawn;
    const calls = [];
    const fakeChild = createFakeChild(701154);
    childProcess.spawn = (command, args, options) => {
      calls.push({ command, args: [...args], options });
      return fakeChild;
    };
    try {
      await instanceService.startInstance(id);
      assert.strictEqual(calls.length, 1, "Bad installer/script command should be repaired before spawn.");
      assert.strictEqual(calls[0].command, "bash", "Installer jar must be replaced by shell script launch.");
      assert.deepStrictEqual(calls[0].args, ["./startserver.sh"], "Script path must not be passed as an installer-jar argument.");
      const launchText = `${calls[0].command} ${calls[0].args.join(" ")}`;
      assert(!launchText.includes("-jar neoforge-installer.jar"), "Repaired launch must not contain the NeoForge installer jar.");
      const repaired = await instanceService.getStatus(id);
      assert.strictEqual(repaired.executable, "bash");
      assert.deepStrictEqual(repaired.args, ["./startserver.sh"]);
      assert.strictEqual(repaired.serverJar, null, "Installer jar should not remain configured as the runtime server jar.");
      assert.strictEqual(calls.length, 1, "Generated run.sh preference should spawn exactly one process.");
      assert.strictEqual(calls[0].command, "bash", "Generated run.sh should launch through bash.");
      assert.deepStrictEqual(calls[0].args, ["./run.sh"], "Generated run.sh should replace bootstrap startserver.sh.");
      const repaired = await instanceService.getStatus(id);
      assert.strictEqual(repaired.startupScript, "run.sh", "Generated run.sh should become the persisted runtime script.");
      assert.deepStrictEqual(repaired.args, ["./run.sh"], "Generated run.sh should become the persisted runtime argv.");
      fakeChild.emit("exit", 0, null);
      await wait(20);
    } finally {
      childProcess.spawn = originalSpawn;
    }
  }, { platform: "linux" });
}

async function assertNeoForgeMissingUnixArgsPreflightDoesNotRestart() {
  await withTempService(async (instanceService) => {
    const id = "atm10-missing-unix-args-preflight";
    await instanceService.createInstance({
      id,
      displayName: "ATM10 Missing Unix Args Preflight",
      type: "java-app",
      workingDirectory: "data",
      executable: "bash",
      args: ["./run.sh"],
      startupScript: "run.sh",
      restartPolicy: "on-failure",
      game: "minecraft",
      tags: ["minecraft", "modpack", "curseforge", "neoforge"],
      startupTimeoutMs: 60000,
    });
    await instanceService.writeInstanceFile(id, "run.sh", "#!/usr/bin/env bash\nexec java @user_jvm_args.txt @libraries/net/neoforged/neoforge/21.1.228/unix_args.txt \"$@\"\n");
    await instanceService.writeInstanceFile(id, "user_jvm_args.txt", "-Xmx4G\n");

    const originalSpawn = childProcess.spawn;
    let spawnCount = 0;
    childProcess.spawn = () => {
      spawnCount += 1;
      return createFakeChild(701155);
    };
    try {
      const status = await instanceService.startInstance(id);
      assert.strictEqual(spawnCount, 0, "Missing NeoForge unix_args.txt should fail before spawning.");
      assert.strictEqual(status.state, "Failed", "Missing NeoForge runtime files should mark the instance failed.");
      assert.strictEqual(status.failureReason, "NEOFORGE_RUNTIME_INCOMPLETE", "Missing unix_args.txt should use an actionable failure reason.");
      assert(status.failureDetails?.missing?.includes("libraries/net/neoforged/neoforge/21.1.228/unix_args.txt"), "Missing details should name the unix_args.txt path.");
      const logs = await instanceService.readLogs(id, { stream: "stderr", limit: 20 });
      assert(logs.entries.some((entry) => /NeoForge runtime files are incomplete/.test(entry.message)), "Missing unix_args.txt should write an actionable error.");
      await wait(80);
      assert.strictEqual(instanceService._test.getResourceCounts().restartTimers, 0, "Missing unix_args.txt must not schedule auto-restart.");
    } finally {
      childProcess.spawn = originalSpawn;
    }
  }, { platform: "linux" });
}

async function assertNeoForgeMissingUnixArgsStderrDoesNotRestart() {
  await withTempService(async (instanceService) => {
    const id = "atm10-missing-unix-args-stderr";
    await instanceService.createInstance({
      id,
      displayName: "ATM10 Missing Unix Args Stderr",
      type: "custom-command",
      workingDirectory: "data",
      executable: "bash",
      args: ["./custom.sh"],
      restartPolicy: "on-failure",
      startupTimeoutMs: 60000,
    });
    await instanceService.writeInstanceFile(id, "custom.sh", "#!/usr/bin/env bash\n");

    const originalSpawn = childProcess.spawn;
    const fakeChild = createFakeChild(701156);
    let spawnCount = 0;
    childProcess.spawn = () => {
      spawnCount += 1;
      return fakeChild;
    };
    try {
      await instanceService.startInstance(id);
      fakeChild.stderr.emit("data", "Error: could not open `libraries/net/neoforged/neoforge/21.1.228/unix_args.txt'\\n");
      fakeChild.emit("exit", 1, null);
      await wait(120);
      const status = await instanceService.getStatus(id);
      assert.strictEqual(status.failureReason, "NEOFORGE_RUNTIME_INCOMPLETE", "stderr unix_args.txt failures should be classified clearly.");
      assert.strictEqual(spawnCount, 1, "stderr unix_args.txt failures should not auto-restart.");
      assert.strictEqual(instanceService._test.getResourceCounts().restartTimers, 0, "stderr unix_args.txt failures must not leave restart timers.");
    } finally {
      childProcess.spawn = originalSpawn;
    }
  }, { platform: "linux" });
}

async function assertNeoForgeVersionMismatchDetected() {
  await withTempService(async (instanceService) => {
    const id = "atm10-neoforge-version-mismatch";
    await instanceService.createInstance({
      id,
      displayName: "ATM10 NeoForge Version Mismatch",
      type: "java-app",
      workingDirectory: "data",
      executable: "bash",
      args: ["./run.sh"],
      startupScript: "run.sh",
      restartPolicy: "on-failure",
      game: "minecraft",
      tags: ["minecraft", "modpack", "curseforge", "neoforge"],
      startupTimeoutMs: 60000,
    });
    await instanceService.writeInstanceFile(id, "run.sh", "#!/usr/bin/env bash\nexec java @user_jvm_args.txt @libraries/net/neoforged/neoforge/21.1.228/unix_args.txt \"$@\"\n");
    await instanceService.writeInstanceFile(id, "user_jvm_args.txt", "-Xmx4G\n");
    await instanceService.writeInstanceFile(id, "libraries/net/neoforged/neoforge/21.1.227/unix_args.txt", "--launchTarget neoforgeserver\n");

    const status = await instanceService.startInstance(id);
    assert.strictEqual(status.state, "Failed", "NeoForge version mismatches should fail before launch.");
    assert.strictEqual(status.failureReason, "NEOFORGE_RUNTIME_INCOMPLETE", "NeoForge version mismatches should use the runtime-incomplete failure reason.");
    assert.strictEqual(status.failureDetails?.mismatch, true, "NeoForge version mismatch details should be explicit.");
    assert.strictEqual(status.failureDetails?.expectedVersion, "21.1.228", "Expected NeoForge version should be captured.");
    assert.deepStrictEqual(status.failureDetails?.availableVersions, ["21.1.227"], "Available generated NeoForge versions should be captured.");
    const logs = await instanceService.readLogs(id, { stream: "stderr", limit: 20 });
    assert(logs.entries.some((entry) => /NeoForge runtime files are incomplete/.test(entry.message)), "Mismatch error should write an actionable runtime-incomplete message.");
  }, { platform: "linux" });
}

async function assertRestartBackoffBounds() {
  await withTempService(async (instanceService) => {
    const instanceId = "restart-backoff-smoke";
    const delays = [];
    for (let index = 0; index < 5; index += 1) {
      const decision = instanceService._test.getRestartBackoffDecision(instanceId, { immediateExit: true });
      assert.strictEqual(decision.allowed, true, "Immediate exit should be restartable before the retry ceiling.");
      delays.push(decision.delayMs);
    }
    const blocked = instanceService._test.getRestartBackoffDecision(instanceId, { immediateExit: true });
    assert.strictEqual(blocked.allowed, false, "Immediate exit should stop restarting after the retry ceiling.");
    assert.deepStrictEqual(delays, [1000, 2000, 4000, 8000, 16000], "Immediate restart delays should back off exponentially.");

    instanceService._test.resetRestartBackoff(instanceId);
    const reset = instanceService._test.getRestartBackoffDecision(instanceId, { immediateExit: true });
    assert.strictEqual(reset.allowed, true, "Manual start/stop reset should allow retries again.");
    assert.strictEqual(reset.delayMs, 1000, "Manual reset should restore the initial restart delay.");
  });
}

async function assertScheduledRestartCancellation() {
  await withTempService(async (instanceService) => {
    let restarted = false;
    instanceService._test.scheduleAutomaticRestart("cancel-restart-smoke", 30, () => {
      restarted = true;
    });
    instanceService._test.resetRestartBackoff("cancel-restart-smoke");
    await wait(80);
    assert.strictEqual(restarted, false, "Manual lifecycle reset must cancel a pending automatic restart timer.");
  });
}

async function assertStopDoesNotRestart() {
  await withTempService(async (instanceService) => {
    const payload = {
      id: "intentional-stop-smoke",
      displayName: "Intentional Stop Smoke",
      type: "custom-command",
      workingDirectory: "data",
      executable: "node",
      args: ["server.js"],
      restartPolicy: "always",
      startupTimeoutMs: 60000,
    };
    await instanceService.createInstance(payload);
    const originalSpawn = childProcess.spawn;
    const originalKill = process.kill;
    const fakeChild = createFakeChild(701201);
    const alive = new Set([701201]);
    let spawnCount = 0;
    childProcess.spawn = () => {
      spawnCount += 1;
      return fakeChild;
    };
    process.kill = (pid, signal) => {
      if (Number(pid) === 701201 && signal === "SIGTERM") {
        alive.delete(701201);
        setImmediate(() => fakeChild.emit("exit", 0, null));
        return true;
      }
      return originalKill(pid, signal);
    };
    instanceService._test.setProcessAliveProvider((pid) => alive.has(Number(pid)));
    try {
      await instanceService.startInstance(payload.id);
      const stopped = await instanceService.stopInstance(payload.id);
      assert.strictEqual(stopped.state, "Stopped", "Intentional stop should transition to Stopped.");
      await wait(1200);
      assert.strictEqual(spawnCount, 1, "Intentional stop must not schedule an automatic restart.");
    } finally {
      childProcess.spawn = originalSpawn;
      process.kill = originalKill;
    }
  });
}

async function assertJavaAndArgumentCompatibility() {
  await withTempService(async (instanceService) => {
    const minecraftPayload = {
      id: "minecraft-java-smoke",
      displayName: "Minecraft Java Smoke",
      type: "minecraft-paper",
      workingDirectory: "data",
      executable: "java",
      memoryLimit: "2G",
      jar: "paper.jar",
      args: ["--nogui-extra"],
      restartPolicy: "never",
    };
    const minecraft = await instanceService.createInstance(minecraftPayload);
    assert.strictEqual(minecraft.executable, "java", "Minecraft startup should still use Java.");
    assert.deepStrictEqual(minecraft.args, ["-Xmx2G", "-jar", "paper.jar", "nogui", "--nogui-extra"], "Minecraft Java args should remain tokenized.");
    await instanceService.writeInstanceFile(minecraftPayload.id, "paper.jar", "");
    const originalSpawn = childProcess.spawn;
    const calls = [];
    const fakeChild = createFakeChild(701152);
    childProcess.spawn = (command, args, options) => {
      calls.push({ command, args: [...args], options });
      return fakeChild;
    };
    try {
      await instanceService.startInstance(minecraftPayload.id);
      assert.strictEqual(calls.length, 1, "Jar-based Minecraft start should spawn exactly one process.");
      assert.strictEqual(calls[0].command, "java", "Jar-based Minecraft start should still use Java.");
      assert.deepStrictEqual(calls[0].args, ["-Xmx2G", "-jar", "paper.jar", "nogui", "--nogui-extra"], "Jar-based Minecraft launch argv should remain unchanged.");
      const logs = await instanceService.readLogs(minecraftPayload.id, { stream: "stdout", limit: 20 });
      const launchLine = logs.entries.find((entry) => String(entry.message || "").startsWith("Launch command:"));
      assert(launchLine, "Jar-based Minecraft startup logs should include a readable launch command.");
      assert(launchLine.message.includes("java -Xmx2G -jar paper.jar nogui --nogui-extra"), "Jar-based Minecraft launch log should show Java jar command.");
      fakeChild.emit("exit", 0, null);
      await wait(20);
    } finally {
      childProcess.spawn = originalSpawn;
    }

    const spaced = await instanceService.createInstance({
      id: "path-space-smoke",
      displayName: "Path Space Smoke",
      type: "custom-command",
      workingDirectory: "data",
      executable: "bash",
      args: ["-lc", 'exec "./server path/start.sh" "$WORLD_NAME"'],
      environment: { WORLD_NAME: "World One" },
      restartPolicy: "never",
    });
    assert.deepStrictEqual(spaced.args, ["-lc", 'exec "./server path/start.sh" "$WORLD_NAME"'], "Paths with spaces and env references should stay in the shell script argv.");
    assert.strictEqual(spaced.environment.WORLD_NAME, "[configured]", "Public instance config should redact but preserve configured environment.");

    const envArg = await instanceService.createInstance({
      id: "env-arg-smoke",
      displayName: "Env Arg Smoke",
      type: "custom-command",
      workingDirectory: "data",
      executable: "node",
      args: ["--data-dir=${ANXOS_DATA_DIR}", "--name=World One"],
      restartPolicy: "never",
    });
    assert.deepStrictEqual(envArg.args, ["--data-dir=${ANXOS_DATA_DIR}", "--name=World One"], "Environment-variable-like arguments and spaces should remain intact.");
  });
}

async function assertNoUnrelatedAdoptionAndPortCollision() {
  await withTempService(async (instanceService) => {
    const instanceRoot = await createPalworld(instanceService, "palworld-collision-smoke");
    const unrelatedRoot = `${instanceRoot}2`;
    instanceService._test.setProcessAliveProvider((pid) => [600001, 600002].includes(Number(pid)));
    instanceService._test.setProcessInspectionProvider(() => ({
      processes: [{
        pid: 600001,
        ppid: 1,
        name: "PalServer-Linux-Shipping",
        exe: path.join(unrelatedRoot, "data", "server", "Pal", "Binaries", "Linux", "PalServer-Linux-Shipping"),
        cwd: path.join(unrelatedRoot, "data", "server"),
        commandLine: `${path.join(unrelatedRoot, "data", "server", "Pal", "Binaries", "Linux", "PalServer-Linux-Shipping")} Pal -port=8211`,
      }, {
        pid: 600002,
        ppid: 1,
        name: "other-service",
        exe: "/usr/bin/other-service",
        cwd: "/tmp",
        commandLine: "/usr/bin/other-service --port 27015",
      }],
      ports: [
        { protocol: "udp", port: 8211, pid: 600001 },
        { protocol: "udp", port: 27015, pid: 600002 },
      ],
    }));

    const status = await instanceService.getStatus("palworld-collision-smoke");
    assert.notStrictEqual(status.pid, 600001, "Unrelated PalServer process with a similar path prefix must not be adopted.");
    assert.notStrictEqual(status.state, "Running", "Unrelated PalServer process must not transition the instance to Running.");

    await assert.rejects(
      () => instanceService.startInstance("palworld-collision-smoke"),
      (error) => {
        assert.strictEqual(error.code, "PORT_IN_USE", "Unrelated configured port ownership should be reported as PORT_IN_USE.");
        assert(error.conflicts?.some((conflict) => conflict.port === 8211 && conflict.pid === 600001), "Port conflict should include the unrelated PalServer owner.");
        assert(error.conflicts?.some((conflict) => conflict.port === 27015 && conflict.pid === 600002), "Port conflict should include other query-port owner.");
        return true;
      },
      "Unrelated port ownership should block start instead of adopting the process."
    );
  });
}

async function assertStopAfterReconciliation() {
  await withTempService(async (instanceService) => {
    const instanceRoot = await createPalworld(instanceService, "palworld-stop-smoke");
    const alive = new Set([580982]);
    instanceService._test.setProcessAliveProvider((pid) => alive.has(Number(pid)));
    instanceService._test.setProcessInspectionProvider(() => alive.has(580982) ? runtimeSnapshot(instanceRoot, 580982) : { processes: [], ports: [] });

    let status = await instanceService.getStatus("palworld-stop-smoke");
    assert.strictEqual(status.state, "Running", "Stop smoke should first reconcile detached runtime.");

    const originalKill = process.kill;
    process.kill = (pid, signal) => {
      if (Number(pid) === 580982 && (signal === "SIGTERM" || signal === "SIGKILL")) {
        alive.delete(580982);
        return true;
      }
      return originalKill(pid, signal);
    };
    try {
      status = await instanceService.stopInstance("palworld-stop-smoke");
      assert.strictEqual(status.state, "Stopped", "Stop should transition reconciled detached runtime to Stopped.");
      assert.strictEqual(status.pid, null, "Stop should clear runtime PID.");
    } finally {
      process.kill = originalKill;
    }
  });
}

async function assertAtomicConfigWriteRetriesWindowsRenameContention() {
  await withTempService(async (instanceService, root) => {
    const targetPath = path.join(root, "atomic-config.json");
    const originalRename = fs.promises.rename;
    let attempts = 0;
    fs.promises.rename = async (from, to) => {
      attempts += 1;
      if (attempts <= 2) {
        const error = new Error("transient Windows rename contention");
        error.code = "EPERM";
        throw error;
      }
      return originalRename(from, to);
    };
    try {
      await instanceService._test.atomicWriteManagedFile(targetPath, `${JSON.stringify({ ok: true, attempt: "retry" }, null, 2)}\n`);
    } finally {
      fs.promises.rename = originalRename;
    }
    assert.strictEqual(attempts, 3, "Transient Windows rename failures should retry within a bounded attempt count.");
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(targetPath, "utf8")), { ok: true, attempt: "retry" }, "Successful retry must leave valid final JSON.");
    assert.strictEqual(fs.readdirSync(root).filter((name) => name.startsWith("atomic-config.json.") && name.endsWith(".tmp")).length, 0, "Successful retry must not leave temporary files.");
  }, { platform: "win32" });
}

async function assertAtomicConfigWriteDoesNotRetryWindowsOnlyErrorsOnOtherPlatforms() {
  await withTempService(async (instanceService, root) => {
    const targetPath = path.join(root, "atomic-non-windows.json");
    const originalRename = fs.promises.rename;
    let attempts = 0;
    fs.promises.rename = async () => {
      attempts += 1;
      const error = new Error("non-Windows EPERM should not retry");
      error.code = "EPERM";
      throw error;
    };
    try {
      await assert.rejects(
        () => instanceService._test.atomicWriteManagedFile(targetPath, "{}\n"),
        (error) => error.code === "EPERM",
        "Non-Windows EPERM rename failures must propagate without retry."
      );
    } finally {
      fs.promises.rename = originalRename;
    }
    assert.strictEqual(attempts, 1, "Non-Windows EPERM rename failures should not retry.");
    assert.strictEqual(fs.existsSync(targetPath), false, "Failed non-Windows atomic write must not create the final file.");
    assert.strictEqual(fs.readdirSync(root).filter((name) => name.startsWith("atomic-non-windows.json.") && name.endsWith(".tmp")).length, 0, "Failed non-Windows atomic write must clean up its temporary file.");
  }, { platform: "linux" });
}

async function assertAtomicConfigWritePropagatesPermanentRenameFailures() {
  await withTempService(async (instanceService, root) => {
    const targetPath = path.join(root, "atomic-permanent.json");
    const originalRename = fs.promises.rename;
    fs.promises.rename = async () => {
      const error = new Error("permanent permission failure");
      error.code = "EISDIR";
      throw error;
    };
    try {
      await assert.rejects(
        () => instanceService._test.atomicWriteManagedFile(targetPath, "{}\n"),
        (error) => error.code === "EISDIR",
        "Permanent rename failures must propagate."
      );
    } finally {
      fs.promises.rename = originalRename;
    }
    assert.strictEqual(fs.existsSync(targetPath), false, "Failed atomic write must not create the final file.");
    assert.strictEqual(fs.readdirSync(root).filter((name) => name.startsWith("atomic-permanent.json.") && name.endsWith(".tmp")).length, 0, "Failed atomic write must clean up its temporary file.");
  });
}

async function assertRenameDuplicateAndCrashLifecycle() {
  await withTempService(async (instanceService) => {
    await instanceService.createInstance({
      id: "duplicate-source",
      displayName: "Duplicate Source",
      type: "custom-command",
      workingDirectory: "data",
      executable: "node",
      args: ["server.js"],
      restartPolicy: "never",
      ports: [25565],
    });
    await instanceService.writeInstanceFile("duplicate-source", "server.properties", "server-port=25565\n");

    const renamed = await instanceService.renameInstance("duplicate-source", "Renamed Source");
    assert.strictEqual(renamed.displayName, "Renamed Source", "Instance rename should update display name without changing ID.");

    const duplicated = await instanceService.duplicateInstance("duplicate-source", {
      id: "duplicate-copy",
      displayName: "Duplicate Copy",
    });
    assert.strictEqual(duplicated.duplicated, true, "Duplicate operation should report success.");
    assert.strictEqual(duplicated.instance.id, "duplicate-copy", "Duplicate should use requested target ID.");
    assert.strictEqual(duplicated.instance.displayName, "Duplicate Copy", "Duplicate should use requested display name.");
    assert.strictEqual(duplicated.instance.state, "Stopped", "Duplicated instances should start stopped.");
    assert.strictEqual(duplicated.instance.pid, null, "Duplicated instances should not inherit runtime PID.");
    assert.strictEqual(duplicated.instance.duplicatedFrom, "duplicate-source", "Duplicate should preserve source identity metadata.");
    const copiedFile = await instanceService.readInstanceFile("duplicate-copy", "server.properties");
    assert.strictEqual(copiedFile.content, "server-port=25565\n", "Duplicate should copy instance data files.");

    await instanceService.updateInstance("duplicate-copy", {});
    const crashedConfigPath = path.join(process.env.AGENT_INSTANCE_ROOT, "duplicate-copy", "config.json");
    const crashedConfig = JSON.parse(fs.readFileSync(crashedConfigPath, "utf8"));
    fs.writeFileSync(crashedConfigPath, `${JSON.stringify({
      ...crashedConfig,
      state: "Failed",
      failureReason: "PROCESS_EXITED",
      pid: null,
    }, null, 2)}\n`);
    const crashed = await instanceService.getStatus("duplicate-copy");
    assert.strictEqual(crashed.lifecycleState, "Crashed", "Failed process exits should expose Crashed lifecycle state.");
    assert.strictEqual(crashed.crashed, true, "Failed process exits should expose crashed=true.");

    fs.writeFileSync(crashedConfigPath, `${JSON.stringify({
      ...crashedConfig,
      state: "Failed",
      failureReason: "CRASH_LOOP",
      restartFailures: 6,
      crashLoopDetectedAt: new Date().toISOString(),
      pid: null,
    }, null, 2)}\n`);
    const crashLoop = await instanceService.getStatus("duplicate-copy");
    assert.strictEqual(crashLoop.lifecycleState, "Crash Loop", "Exhausted restart attempts should expose a distinct Crash Loop lifecycle state.");
    assert.strictEqual(crashLoop.crashLoop, true, "Crash-loop status should survive service and application restart through persisted metadata.");
    assert.strictEqual(crashLoop.restartFailures, 6, "Crash-loop status should preserve the bounded restart attempt count.");

    await assert.rejects(
      () => instanceService.duplicateInstance("duplicate-source", { id: "duplicate-copy" }),
      (error) => error.code === "INSTANCE_ALREADY_EXISTS",
      "Duplicate should refuse to overwrite an existing instance."
    );
  });
}

async function run() {
  await assertPalworldShellCommandNormalization();
  await assertPalworldSpawnArgvAndLogs();
  await assertJavaScriptLauncherRepair();
  await assertInstallerJarWithStartupScriptRepair();
  await assertInstallerJarWithScriptArgumentRepair();
  await assertNeoForgeRunScriptPreferenceAndRuntimeValidation();
  await assertNeoForgeMissingUnixArgsPreflightDoesNotRestart();
  await assertNeoForgeMissingUnixArgsStderrDoesNotRestart();
  await assertNeoForgeVersionMismatchDetected();
  await assertRestartBackoffBounds();
  await assertScheduledRestartCancellation();
  await assertStopDoesNotRestart();
  await assertJavaAndArgumentCompatibility();
  await assertDetachedRuntimeReconciliation();
  await assertNoUnrelatedAdoptionAndPortCollision();
  await assertStopAfterReconciliation();
  await assertAtomicConfigWriteRetriesWindowsRenameContention();
  await assertAtomicConfigWriteDoesNotRetryWindowsOnlyErrorsOnOtherPlatforms();
  await assertAtomicConfigWritePropagatesPermanentRenameFailures();
  await assertRenameDuplicateAndCrashLifecycle();
  console.log("Instance runtime smoke checks passed.");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
