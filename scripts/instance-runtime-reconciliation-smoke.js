const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const instanceService = require("../src/shared/instances/instanceServiceCore");

const ALIVE_PID = 424242;

function palworldInstancePayload(id) {
  return {
    id,
    displayName: "Palworld Reconciliation Smoke",
    type: "custom-command",
    workingDirectory: "data/server",
    executable: "steamcmd",
    args: ["+runscript", "pal-run.txt"],
    ports: [8211],
    primaryPort: 8211,
    templateId: "palworld",
    game: "palworld",
    tags: ["palworld", "steamcmd"],
  };
}

async function withTempService(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-runtime-reconcile-"));
  instanceService.configureInstanceService({ getConfig: () => ({ instanceRoot: root }) });
  try {
    await fn(root);
  } finally {
    instanceService.disposeInstanceService();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch (error) {
        // Windows can briefly keep the temp root locked while spawned
        // children release their working directory handles.
        if (attempt === 4) console.warn(`cleanup warning: ${error.message}`);
        else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
    }
  }
}

async function createPalworldInstance(root, id, overrides = {}) {
  await instanceService.createInstance(palworldInstancePayload(id));
  const configPath = path.join(root, id, "config.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const next = {
    ...config,
    installerType: "steamcmd-native",
    steamAppId: 2394010,
    ...overrides,
  };
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

function setAliveProvider(alivePids = []) {
  instanceService._test.setProcessAliveProvider((pid) => alivePids.includes(Number(pid)));
}

function setSnapshotProvider({ processes = [], ports = [], fail = false } = {}) {
  instanceService._test.setProcessInspectionProvider(() => {
    if (fail) throw new Error("inspection unavailable");
    return { processes, ports };
  });
}

function palworldProc(pid, root) {
  return {
    pid,
    ppid: 1,
    name: "palserver-linux-shipping",
    exe: path.join(root, "instances", "pal-smoke", "data", "server", "Pal", "Binaries", "Linux", "PalServer-Linux-Shipping"),
    cwd: path.join(root, "instances", "pal-smoke", "data", "server"),
    commandLine: path.join(root, "instances", "pal-smoke", "data", "server", "Pal", "Binaries", "Linux", "PalServer-Linux-Shipping"),
    args: [],
    socketInodes: [],
  };
}

async function expectUpdateBlocked(instanceId) {
  await assert.rejects(
    () => instanceService.beginSteamCmdUpdateSession(instanceId, { operationId: "smoke-update-session-0001" }),
    (error) => error.code === "STEAMCMD_UPDATE_REQUIRES_STOPPED",
  );
}

async function expectUpdateAllowed(instanceId) {
  const session = await instanceService.beginSteamCmdUpdateSession(instanceId, { operationId: "smoke-update-session-0001" });
  assert.ok(session?.token, "update session should open when the reconciled runtime is stopped");
  await instanceService.cancelInstallationSession(instanceId, { operationId: session.operationId, token: session.token });
}

async function main() {
  await withTempService(async (root) => {
    // 1. Persisted "Running" with a genuinely alive, identity-matching
    //    Palworld process => update must remain blocked.
    setAliveProvider([ALIVE_PID]);
    setSnapshotProvider({
      processes: [palworldProc(ALIVE_PID, root)],
      ports: [{ port: 8211, protocol: "udp", pid: ALIVE_PID, inode: "1" }],
    });
    await createPalworldInstance(root, "pal-smoke", { state: "Running", pid: ALIVE_PID });
    const adopted = await instanceService.getStatus("pal-smoke");
    assert.strictEqual(adopted.processState, "Running", "a live matching runtime must stay Running");
    await expectUpdateBlocked("pal-smoke");
    setAliveProvider([]);
    setSnapshotProvider({ processes: [], ports: [] });
    await instanceService.deleteInstance("pal-smoke");

    // 2. Persisted "Running" with the process missing => reconcile to Stopped
    //    and allow the update (the original incident).
    setAliveProvider([]);
    setSnapshotProvider({ processes: [], ports: [] });
    await createPalworldInstance(root, "pal-smoke", { state: "Running", pid: ALIVE_PID });
    const reconciled = await instanceService.getStatus("pal-smoke");
    assert.strictEqual(reconciled.processState, "Stopped");
    assert.strictEqual(reconciled.failureReason, "STALE_PID");
    assert.strictEqual(reconciled.pid, null);
    await expectUpdateAllowed("pal-smoke");
    setAliveProvider([]);
    setSnapshotProvider({ processes: [], ports: [] });
    await instanceService.deleteInstance("pal-smoke");

    // 3. Stale PID reused by an unrelated process => must NOT be treated as
    //    the instance; reconcile to Stopped instead of Running.
    setAliveProvider([ALIVE_PID]);
    setSnapshotProvider({
      processes: [{
        pid: ALIVE_PID,
        ppid: 1,
        name: "python3",
        exe: "/usr/bin/python3",
        cwd: "/var/www",
        commandLine: "python3 -m http.server 8211",
        args: [],
        socketInodes: [],
      }],
      ports: [{ port: 8211, protocol: "tcp", pid: ALIVE_PID, inode: "2" }],
    });
    await createPalworldInstance(root, "pal-smoke", { state: "Running", pid: ALIVE_PID });
    const pidReused = await instanceService.getStatus("pal-smoke");
    assert.strictEqual(pidReused.processState, "Stopped", "a reused PID must not count as the instance runtime");
    assert.strictEqual(pidReused.failureReason, "PID_IDENTITY_MISMATCH");
    await expectUpdateAllowed("pal-smoke");
    setAliveProvider([]);
    setSnapshotProvider({ processes: [], ports: [] });
    await instanceService.deleteInstance("pal-smoke");

    // 4. Reload failed + process gone => runtime stopped-honest, the failed
    //    operation evidence stays available.
    setAliveProvider([]);
    setSnapshotProvider({ processes: [], ports: [] });
    await createPalworldInstance(root, "pal-smoke", {
      state: "Failed",
      pid: null,
      failureReason: "INSTANCE_STOP_FAILED",
    });
    const reloadFailed = await instanceService.getStatus("pal-smoke");
    assert.strictEqual(reloadFailed.processState, "Failed");
    assert.strictEqual(reloadFailed.failureReason, "INSTANCE_STOP_FAILED");
    assert.strictEqual(reloadFailed.processRunning, false);
    await expectUpdateAllowed("pal-smoke");
    setAliveProvider([]);
    setSnapshotProvider({ processes: [], ports: [] });
    await instanceService.deleteInstance("pal-smoke");

    // 5. Runtime probe unavailable with nothing to verify against => must NOT
    //    falsely declare Stopped.
    setAliveProvider([]);
    setSnapshotProvider({ fail: true });
    await createPalworldInstance(root, "pal-smoke", { state: "Running", pid: null });
    const probeUnavailable = await instanceService.getStatus("pal-smoke");
    assert.strictEqual(probeUnavailable.processState, "Unknown", "unavailable probe must not fabricate a Stopped verdict");
    await expectUpdateBlocked("pal-smoke");
    setAliveProvider([]);
    setSnapshotProvider({ processes: [], ports: [] });
    await instanceService.deleteInstance("pal-smoke");

    // 6. Stopped instance => update allowed.
    setAliveProvider([]);
    setSnapshotProvider({ processes: [], ports: [] });
    await createPalworldInstance(root, "pal-smoke", { state: "Stopped", pid: null });
    await expectUpdateAllowed("pal-smoke");
    setAliveProvider([]);
    setSnapshotProvider({ processes: [], ports: [] });
    await instanceService.deleteInstance("pal-smoke");

    // 7. Legacy persisted Unknown/STALE_PID record => migrate to Stopped so a
    //    stale record cannot block maintenance forever.
    await createPalworldInstance(root, "pal-smoke", { state: "Unknown", pid: null, failureReason: "STALE_PID" });
    const legacy = await instanceService.getStatus("pal-smoke");
    assert.strictEqual(legacy.processState, "Stopped");
    assert.strictEqual(legacy.failureReason, "STALE_PID");
    await expectUpdateAllowed("pal-smoke");
    setAliveProvider([]);
    setSnapshotProvider({ processes: [], ports: [] });
    await instanceService.deleteInstance("pal-smoke");

    // 8. Unknown record without evidence (probe was inconclusive) stays
    //    Unknown across repeated reconciliations.
    setSnapshotProvider({ fail: true });
    await createPalworldInstance(root, "pal-smoke", { state: "Unknown", pid: null, failureReason: "RUNTIME_PROBE_INCONCLUSIVE" });
    const inconclusive = await instanceService.getStatus("pal-smoke");
    assert.strictEqual(inconclusive.processState, "Unknown");
    setAliveProvider([]);
    setSnapshotProvider({ processes: [], ports: [] });
    await instanceService.deleteInstance("pal-smoke");

    // 9. Genuinely running tracked child => update blocked; after a real stop
    //    => update allowed (restart/reload failures must not leave a phantom
    //    running state).
    instanceService._test.setProcessAliveProvider(null);
    instanceService._test.setProcessInspectionProvider(null);
    await instanceService.createInstance({
      id: "tracked-smoke",
      displayName: "Tracked Child Smoke",
      type: "custom-command",
      executable: process.execPath,
      args: ["-e", "console.log('Server started'); setTimeout(() => {}, 20000)"],
    });
    const trackedConfigPath = path.join(root, "tracked-smoke", "config.json");
    const trackedConfig = JSON.parse(fs.readFileSync(trackedConfigPath, "utf8"));
    fs.writeFileSync(trackedConfigPath, `${JSON.stringify({ ...trackedConfig, installerType: "steamcmd-native", steamAppId: 2394010 }, null, 2)}\n`);
    const started = await instanceService.startInstance("tracked-smoke");
    assert.ok(["Starting", "Running"].includes(started.processState), `unexpected start state: ${started.processState}`);
    let runningState = started;
    for (let attempt = 0; attempt < 40 && runningState.processState !== "Running"; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      runningState = await instanceService.getStatus("tracked-smoke");
    }
    assert.strictEqual(runningState.processState, "Running", "tracked child should reach Running");
    await expectUpdateBlocked("tracked-smoke");
    const stopped = await instanceService.stopInstance("tracked-smoke", { timeoutMs: 3000 });
    assert.strictEqual(stopped.processState, "Stopped");
    await expectUpdateAllowed("tracked-smoke");
    await instanceService.deleteInstance("tracked-smoke");
  });

  console.log("Instance runtime reconciliation smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
