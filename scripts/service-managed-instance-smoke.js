"use strict";

// Integration tests against the real instance core with a fake systemd.
// The invariant under test: for a service-managed instance the Agent NEVER
// launches, signals or adopts a process. systemd is the sole owner.

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

// ---- hard spy: any child process launched by the Agent fails the suite ------
const launched = [];
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[name] = (...args) => {
    launched.push({ name, file: String(args[0]), args: Array.isArray(args[1]) ? args[1] : [] });
    throw new Error(`child process launch blocked in test: ${name}(${args[0]})`);
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-svc-"));
process.env.AGENT_INSTANCE_ROOT = root;
const core = require("../src/shared/instances/instanceServiceCore");
const runtime = require("../src/shared/instances/serviceManagedRuntime");

const ID = "fivem-fxserver";
const UNIT = "anxrp-fxserver.service";
const recordPath = path.join(root, ID, "config.json");

function writeRecord(overrides = {}) {
  fs.mkdirSync(path.join(root, ID, "data"), { recursive: true });
  fs.mkdirSync(path.join(root, ID, "logs"), { recursive: true });
  const record = {
    id: ID,
    type: "systemd-service",
    templateId: "fivem",
    displayName: "AnxRP",
    serverSoftware: "FiveM FXServer",
    schemaVersion: 2,
    installationState: "active",
    serverVersion: "35805-6fd665a365f56c2582c36d8ffaf301b0b1d5764b",
    workingDirectory: "data",
    ports: [30120],
    autoStart: false,
    restartPolicy: "never",
    serviceManager: { kind: "systemd", unit: UNIT },
    ...overrides,
  };
  fs.writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

function sha(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// A fake systemd: a tiny state machine plus a call log.
function fakeSystemd(initial = {}) {
  const state = {
    loadState: "loaded", activeState: "active", subState: "running", result: "success",
    mainPid: 4242, execMainStatus: 0, restartCount: 0,
    activeEnterTimestamp: "Tue 2026-10-06 10:00:00 UTC", unitFileState: "enabled",
    ...initial,
  };
  const calls = [];
  const controller = {
    state,
    calls,
    failDescribe: null,
    journal: [{ at: "2026-10-06T10:00:00+0000", stream: "journal", message: "server started token=abc123secret" }],
    async describe(unit) {
      calls.push(["describe", unit]);
      if (controller.failDescribe) throw Object.assign(new Error(controller.failDescribe), { code: controller.failDescribe });
      return { unit, ...state };
    },
    async control(verb, unit) {
      calls.push([verb, unit]);
      if (verb === "start") Object.assign(state, { activeState: "active", subState: "running", mainPid: 5000 });
      if (verb === "stop") Object.assign(state, { activeState: "inactive", subState: "dead", mainPid: null });
      if (verb === "restart") Object.assign(state, { activeState: "active", subState: "running", mainPid: 6000, restartCount: state.restartCount + 1 });
      return { unit, verb };
    },
    async readJournal(unit) {
      calls.push(["journal", unit]);
      if (controller.journalError) throw Object.assign(new Error("denied"), { code: controller.journalError });
      return controller.journal;
    },
    summary() { return { mechanism: "systemd", supported: true, elevation: "none", allowedUnits: [UNIT] }; },
  };
  controller.controls = () => calls.filter(([verb]) => ["start", "stop", "restart"].includes(verb));
  return controller;
}

function use(systemd) {
  core.configureInstanceService({ systemdController: systemd });
}

test.beforeEach(() => {
  writeRecord();
  launched.length = 0;
});

test.after(() => {
  assert.deepEqual(launched, [], "the Agent must never launch a child process for a service-managed instance");
  fs.rmSync(root, { recursive: true, force: true });
});

test("status reflects systemd, holds no PID, and never rewrites the record", async () => {
  const systemd = fakeSystemd();
  use(systemd);
  const before = sha(recordPath);
  const status = await core.listInstances();
  const instance = status.instances.find((entry) => entry.id === ID);
  assert.equal(instance.state, "Running");
  assert.equal(instance.processRunning, true);
  assert.equal(instance.pid, null, "the Agent owns no process, so it holds no PID");
  assert.equal(instance.runtimeProcess, null);
  assert.equal(instance.serviceStatus.externalMainPid, 4242, "systemd's PID is informational only");
  assert.equal(instance.serviceStatus.unit, UNIT);
  assert.equal(instance.readinessState, "ready");
  const single = await core.getStatus(ID);
  assert.equal(single.state, "Running");
  assert.equal(sha(recordPath), before, "observing must not persist anything");
  assert.deepEqual(systemd.controls(), []);
});

test("a visible FXServer process is never adopted: state still comes from systemd", async () => {
  // Make the legacy detached-runtime discovery see a perfect FXServer match.
  core._test.setProcessInspectionProvider(async () => ({
    processes: [{
      pid: 4242, ppid: 1, name: "FXServer",
      exe: path.join(root, ID, "data", "alpine", "opt", "cfx-server", "FXServer"),
      cwd: path.join(root, ID, "data"),
      commandLine: path.join(root, ID, "data", "alpine", "opt", "cfx-server", "FXServer"), args: [],
    }],
    ports: [{ port: 30120, protocol: "tcp", pid: 4242 }],
  }));
  try {
    const systemd = fakeSystemd({ activeState: "inactive", subState: "dead", mainPid: null });
    use(systemd);
    const before = sha(recordPath);
    const status = await core.getStatus(ID);
    assert.equal(status.state, "Stopped", "a lookalike process must not override systemd");
    assert.equal(status.pid, null);
    assert.equal(sha(recordPath), before);
  } finally {
    core._test.setProcessInspectionProvider(null);
  }
});

test("start asks systemd to start; it never spawns", async () => {
  const systemd = fakeSystemd({ activeState: "inactive", subState: "dead", mainPid: null });
  use(systemd);
  const result = await core.startInstance(ID);
  assert.deepEqual(systemd.controls(), [["start", UNIT]]);
  assert.equal((result.instance || result).state, "Running");
});

test("start on an already-active service is refused with INSTANCE_ALREADY_RUNNING and does nothing", async () => {
  for (const [activeState, subState] of [["active", "running"], ["activating", "start"], ["activating", "auto-restart"]]) {
    const systemd = fakeSystemd({ activeState, subState });
    use(systemd);
    await assert.rejects(() => core.startInstance(ID), (error) => error.code === "INSTANCE_ALREADY_RUNNING");
    assert.deepEqual(systemd.controls(), [], `no control call while ${activeState}/${subState}`);
  }
});

test("stop asks systemd to stop, and is a no-op when already stopped", async () => {
  const running = fakeSystemd();
  use(running);
  await core.stopInstance(ID);
  assert.deepEqual(running.controls(), [["stop", UNIT]]);

  const stopped = fakeSystemd({ activeState: "inactive", subState: "dead", mainPid: null });
  use(stopped);
  await core.stopInstance(ID);
  assert.deepEqual(stopped.controls(), []);
});

test("restart is ONE atomic service-manager restart, never stop-then-start", async () => {
  const systemd = fakeSystemd();
  use(systemd);
  await core.restartInstance(ID);
  assert.deepEqual(systemd.controls(), [["restart", UNIT]]);
});

test("unreadable service state is Unknown and every lifecycle action refuses to act blind", async () => {
  for (const failure of ["SERVICE_QUERY_FAILED", "SERVICE_UNIT_NOT_ALLOWED", "SERVICE_MANAGER_UNSUPPORTED"]) {
    const systemd = fakeSystemd();
    systemd.failDescribe = failure;
    use(systemd);
    const status = await core.getStatus(ID);
    assert.equal(status.state, "Unknown", failure);
    assert.equal(status.failureReason, failure);
    for (const action of [core.startInstance, core.stopInstance, core.restartInstance]) {
      await assert.rejects(() => action(ID), (error) => error.code === "SERVICE_STATE_UNVERIFIED", `${failure} ${action.name}`);
    }
    assert.deepEqual(systemd.controls(), []);
  }
});

test("operations that would need an owned process are refused", async () => {
  const systemd = fakeSystemd();
  use(systemd);
  const unsupported = (error) => error.code === "SERVICE_MANAGED_OPERATION_UNSUPPORTED";
  await assert.rejects(() => core.writeInstanceInput(ID, "refresh"), unsupported);
  await assert.rejects(() => core.forceKillInstance(ID), unsupported);
  await assert.rejects(() => core.updateInstance(ID, { displayName: "x" }), unsupported);
  await assert.rejects(() => core.renameInstance(ID, "x"), unsupported);
  await assert.rejects(() => core.duplicateInstance(ID, { id: "copy" }), unsupported);
  await assert.rejects(() => core.deleteInstance(ID), unsupported);
  assert.deepEqual(systemd.controls(), [], "none of these may touch the service");
  assert.ok(fs.existsSync(recordPath), "delete must not remove the instance tree");
});

test("a service-managed record cannot be created or smuggled in through the API", async () => {
  use(fakeSystemd());
  await assert.rejects(
    () => core.createInstance({ id: "evil", type: "systemd-service", displayName: "evil", serviceManager: { kind: "systemd", unit: "ssh.service" } }),
    (error) => error.code === "INVALID_INSTANCE_TYPE");
  assert.ok(!core.INSTANCE_TYPES.includes("systemd-service"));
  assert.ok(!fs.existsSync(path.join(root, "evil")));
});

test("logs come from the journal, are redacted, and degrade honestly when unreadable", async () => {
  const systemd = fakeSystemd();
  use(systemd);
  const logs = await core.readLogs(ID, { limit: 50 });
  const journal = logs.entries.filter((entry) => entry.stream === "journal");
  assert.equal(journal.length, 1);
  assert.ok(!JSON.stringify(logs).includes("abc123secret"), "secrets in journal lines are redacted");

  systemd.journalError = "SERVICE_LOGS_DENIED";
  const degraded = await core.readLogs(ID, { limit: 50 });
  assert.ok(degraded.entries.some((entry) => /journal unavailable \(SERVICE_LOGS_DENIED\)/.test(entry.message)));
});

test("start/stop/restart leave an audit note in the Agent log", async () => {
  const systemd = fakeSystemd({ activeState: "inactive", subState: "dead", mainPid: null });
  use(systemd);
  await core.startInstance(ID);
  const logs = await core.readLogs(ID, { limit: 50 });
  assert.ok(logs.entries.some((entry) => /Requested service start: anxrp-fxserver\.service/.test(entry.message)));
});

test("agent shutdown never stops or signals the service", async () => {
  const systemd = fakeSystemd();
  use(systemd);
  await core.getStatus(ID);
  const result = await core.shutdownInstanceService({ timeoutMs: 1000 });
  assert.deepEqual(systemd.controls(), []);
  assert.equal(result.stopped, 0);
  assert.equal(result.forced, 0);
});

test("forget removes only the Agent's record and never touches the service", async () => {
  const systemd = fakeSystemd();
  use(systemd);
  fs.writeFileSync(path.join(root, ID, "data", "keep.txt"), "x");
  const result = await core.forgetInstance(ID);
  assert.equal(result.success, true);
  assert.ok(!fs.existsSync(recordPath), "record removed");
  assert.ok(fs.existsSync(path.join(root, ID, "data", "keep.txt")), "files untouched");
  assert.deepEqual(systemd.controls(), []);
});

test("a record naming a unit outside the allowlist is Unknown and execs nothing (real controller)", async () => {
  const execCalls = [];
  const controller = runtime.createSystemdController({
    platform: "linux",
    allowlist: [],
    execFile: async (...args) => { execCalls.push(args); return { ok: true, stdout: "", stderr: "" }; },
  });
  core.configureInstanceService({ systemdController: controller });
  writeRecord({ serviceManager: { kind: "systemd", unit: "ssh.service" } });
  const status = await core.getStatus(ID);
  assert.equal(status.state, "Unknown");
  assert.equal(status.failureReason, "SERVICE_UNIT_NOT_ALLOWED");
  await assert.rejects(() => core.restartInstance(ID), (error) => error.code === "SERVICE_STATE_UNVERIFIED");
  assert.deepEqual(execCalls, []);
});

test("malformed service definitions fail closed", async () => {
  const systemd = fakeSystemd();
  use(systemd);
  for (const serviceManager of [undefined, { kind: "docker", unit: UNIT }, { kind: "systemd", unit: "../../etc/passwd" }, { kind: "systemd", unit: "x.timer" }, { kind: "systemd" }]) {
    writeRecord({ serviceManager });
    const status = await core.getStatus(ID);
    assert.equal(status.state, "Unknown", JSON.stringify(serviceManager));
    await assert.rejects(() => core.restartInstance(ID), (error) => error.code === "SERVICE_STATE_UNVERIFIED");
  }
  assert.deepEqual(systemd.controls(), []);
});

test("static guard: every owned-process spawn site refuses service-managed records", () => {
  const file = path.join(__dirname, "..", "src", "shared", "instances", "instanceServiceCore.js");
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const sites = lines.map((line, index) => (/childProcess\.spawn\(/.test(line) ? index : -1)).filter((index) => index >= 0);
  assert.equal(sites.length, 4, "a new spawn site was added: it must call assertNotServiceManaged() and be counted here");
  for (const index of sites) {
    const window = lines.slice(Math.max(0, index - 40), index).join("\n");
    assert.match(window, /assertNotServiceManaged\(config,/, `spawn at line ${index + 1} lacks a service-managed guard`);
  }
});

test("the owned-process spawn path hard-refuses a service-managed record", async () => {
  // Defense in depth: even if a future change routed a service-managed record
  // into the owned-process code, the spawn-site guard throws before spawning.
  const sourcePath = path.join(__dirname, "..", "src", "shared", "instances", "instanceServiceCore.js");
  const source = fs.readFileSync(sourcePath, "utf8");
  assert.match(source, /assertNotServiceManaged\(config, "start-spawn"\)/);
  assert.match(source, /code: "SERVICE_MANAGED_SPAWN_FORBIDDEN"|createInstanceError\("SERVICE_MANAGED_SPAWN_FORBIDDEN"/);
});
