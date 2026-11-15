#!/usr/bin/env node
"use strict";

// Regression checks for the instance engine fixes:
//   IE1 Palworld players: the REST settings are read from the Marketplace
//       layout (data/server/Pal/...), not only the flat layout.
//   IE2 Daily restart schedules keep their wall-clock time across a
//       daylight-saving change (fall back and spring forward).
//   IE3 Crash-loop protection trips for a server that crashes 30 s after
//       every start, and a long stable run still resets the budget.
//   IE4 A ready line cancels the startup timer: a healthy server never shows
//       READINESS_TIMEOUT, fast or slow.
//   IE5 Job records are pruned: terminal records beyond the per-server cap
//       are deleted from disk and memory; running and recent keyed ones stay.
//   IE6 A sample without CPU time or memory reads "not reported", not
//       "Measuring…" / "CPU warming", and a systemd unit's uptime is used.
//   IE7 A daily schedule an older build drifted by an hour across DST is
//       re-anchored to its wall-clock time: one restart, at the right hour.
//   IE8 Daily schedules at 00:xx (and every other time) never loop forever on
//       a DST day: one restart per day at the wall-clock time, in zones that
//       repeat or skip midnight too. Each zone runs in a worker thread that
//       is terminated after 30 s, so a hang fails instead of blocking.
//   IE9 A status poll during a crash's exit handling never replaces the
//       handler's CRASH_LOOP with PROCESS_EXITED (polls run every few ms
//       while the server crash-loops, so they overlap the handler's writes).
// Hermetic: temporary roots, a fake child_process.spawn (nothing is launched),
// a fake systemd, a local fake Palworld REST server on an ephemeral loopback
// port, and injected clocks. No real Agent, service or scheduled task.
// Run: node scripts/instance-engine-fixes-smoke.js

const childProcess = require("child_process");

// The DST checks need America/Edmonton from process start. Assigning TZ at
// runtime is not honoured everywhere (CI's Linux runner kept UTC rules), so
// the smoke re-runs itself with TZ in its environment.
if (process.env.TZ !== "America/Edmonton") {
  const rerun = childProcess.spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
    env: { ...process.env, TZ: "America/Edmonton" },
    stdio: "inherit",
  });
  process.exit(rerun.status === null ? 1 : rerun.status);
}

const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { PassThrough } = require("stream");
const vm = require("vm");

const repoRoot = path.resolve(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-instance-engine-fixes-"));
for (const [key, sub] of Object.entries({
  ANXHUB_CONFIG_DIR: "cfg",
  ANXOS_CONFIG_DIR: "cfg2",
  ANXOS_LOG_DIR: "logs",
  AGENT_INSTANCE_ROOT: "instances",
  AGENT_BACKUP_ROOT: "backups",
  AGENT_TEMP_DIR: "temp",
  AGENT_LOG_DIR: "agent-logs",
  AGENT_IDENTITY_PATH: "identity.json",
  AGENT_RESTART_SCHEDULE_ROOT: "restart-schedules",
})) {
  process.env[key] = path.join(tempRoot, sub);
}
// Never the developer's real Local Agent.
process.env.AGENT_URL = "http://127.0.0.1:9";
// The test servers run this Node binary, wherever it is installed (CI's lives
// outside the default executable roots).
process.env.AGENT_INSTANCE_EXECUTABLE_ROOTS = path.dirname(process.execPath);
const instanceRoot = process.env.AGENT_INSTANCE_ROOT;
fs.mkdirSync(instanceRoot, { recursive: true });

// ---- fake child processes: nothing is ever launched -------------------------
const children = [];
let nextFakePid = 990001;
function createFakeChild() {
  const child = new EventEmitter();
  child.pid = nextFakePid;
  nextFakePid += 1;
  child.exitCode = null;
  child.signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const emit = child.emit.bind(child);
  child.emit = (name, ...args) => {
    if (name === "exit") {
      child.exitCode = args[0] ?? null;
      child.signalCode = args[1] || null;
    }
    return emit(name, ...args);
  };
  child.kill = () => true;
  return child;
}
// Kept for IE8's per-zone runs of this same Node binary (never a server).
const realSpawnSync = childProcess.spawnSync;
childProcess.spawn = () => {
  const child = createFakeChild();
  children.push(child);
  return child;
};
for (const name of ["spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[name] = (file) => {
    throw new Error(`child process launch blocked in test: ${name}(${file})`);
  };
}

const notificationPath = require.resolve(path.join(repoRoot, "agent", "src", "services", "notificationService"));
require.cache[notificationPath] = { id: notificationPath, filename: notificationPath, loaded: true, exports: { notify() {} } };

const core = require(path.join(repoRoot, "src", "shared", "instances", "instanceServiceCore.js"));
const instanceEvents = [];
core.configureInstanceService({
  getConfig: () => ({ instanceRoot }),
  onInstanceEvent: (event, details) => instanceEvents.push({ event, details }),
});
core._test.setProcessAliveProvider((pid) => children.some((child) => child.pid === pid && child.exitCode === null));

console.info = () => {};
console.warn = () => {};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await wait(25);
  }
  return Boolean(await predicate());
}

function readRecord(id) {
  return JSON.parse(fs.readFileSync(path.join(instanceRoot, id, "config.json"), "utf8"));
}

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing function ${name}`);
  let index = source.indexOf("{", source.indexOf(")", start));
  let depth = 0;
  for (; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced function ${name}`);
}

// ---------------------------------------------------------------------------

async function checkPalworldMarketplaceLayout() {
  let requests = 0;
  const server = http.createServer((request, response) => {
    requests += 1;
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/v1/api/players") response.end(JSON.stringify({ players: [{ name: "Carol", ping: 40 }] }));
    else if (request.url === "/v1/api/metrics") response.end(JSON.stringify({ currentplayernum: 1, maxplayernum: 16 }));
    else { response.statusCode = 404; response.end("{}"); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const id = "pal-marketplace";
    const dir = path.join(instanceRoot, id);
    fs.mkdirSync(path.join(dir, "data", "server"), { recursive: true });
    fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
      schemaVersion: 2, id, displayName: "Palworld", templateId: "palworld", type: "custom-command",
      game: "palworld", tags: ["palworld", "steamcmd", "game-server"],
      executable: "bash", args: ["-lc", "exec ./PalServer.sh -port=8211"], workingDirectory: "data/server",
      primaryPort: 8211, ports: [], state: "Running", pid: null,
    }, null, 2));
    // Where the Marketplace template's server keeps it (installDir "server").
    const settings = path.join(dir, "data", "server", "Pal", "Saved", "Config", "LinuxServer", "PalWorldSettings.ini");
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, `[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(AdminPassword="x",RESTAPIEnabled=True,RESTAPIPort=${port})\n`);
    const result = await core.getPlayers(id);
    assert.notStrictEqual(result.reason, "rest_api_disabled", "the REST settings under data/server are found");
    assert.notStrictEqual(result.available, false, `players are read (reason ${result.reason})`);
    assert.strictEqual(result.online, 1, "the REST API's player count is shown");
    assert.ok(requests >= 1, "the REST API was asked");
  } finally {
    server.close();
  }
}

async function checkDailyScheduleAcrossDst() {
  const service = require(path.join(repoRoot, "agent", "src", "services", "restartScheduleService"));
  const root = path.join(tempRoot, "dst-schedules");
  fs.mkdirSync(root, { recursive: true });
  let clock = 0;
  const restarts = [];
  service.configureRestartScheduleService({
    root,
    now: () => clock,
    isInstanceRunning: async () => true,
    warnInstance: async () => ({ sent: true }),
    restartInstance: async (instanceId) => { restarts.push(clock); return { id: instanceId }; },
    restartInstanceWithSteamUpdate: async () => { throw new Error("not expected"); },
    listInstanceJobs: async () => ({ jobs: [] }),
  });
  async function runOnce(id, dueIso) {
    clock = Date.parse(dueIso);
    const schedule = {
      id, instanceId: "server-a", type: "daily", enabled: true, dailyTime: "04:00", intervalHours: null,
      warnMinutes: 5, autoUpdateSteam: false, backupBeforeUpdate: true,
      nextRunAt: dueIso, warnState: { dueAt: dueIso, longSentAt: dueIso, shortSentAt: dueIso },
      createdAt: dueIso, updatedAt: dueIso, lastRunAt: null, lastError: null, skippedAt: null, skipReason: null, lastSteamUpdate: null,
    };
    fs.writeFileSync(path.join(root, "schedules.json"), JSON.stringify({ schemaVersion: service.RESTART_SCHEDULE_SCHEMA_VERSION, schedules: [schedule] }));
    await service.runDueSchedules();
    return JSON.parse(fs.readFileSync(path.join(root, "schedules.json"), "utf8")).schedules[0];
  }
  // Oct 31 04:00 MDT; DST ends Nov 1. The next run is Nov 1 04:00 MST.
  const fall = await runOnce("dstfall000000000001", "2026-10-31T10:00:00.000Z");
  assert.strictEqual(restarts.length, 1, "the due restart ran");
  assert.strictEqual(fall.nextRunAt, "2026-11-01T11:00:00.000Z", "after fall back the schedule stays at 04:00 local");
  // Mar 13 04:00 MST; DST starts Mar 14. The next run is Mar 14 04:00 MDT.
  const spring = await runOnce("dstspring0000000001", "2027-03-13T11:00:00.000Z");
  assert.strictEqual(spring.nextRunAt, "2027-03-14T10:00:00.000Z", "after spring forward the schedule stays at 04:00 local");
  // An ordinary day keeps the next day's time.
  const plain = await runOnce("dstplain00000000001", "2026-11-05T11:00:00.000Z");
  assert.strictEqual(plain.nextRunAt, "2026-11-06T11:00:00.000Z", "an ordinary day moves by one day");
}

async function checkCrashLoopAfterSlowCrashes() {
  const id = "crash-after-30s";
  await core.createInstance({ id, displayName: "Crash After 30s", type: "custom-command", workingDirectory: "data", executable: process.execPath, args: ["-e", "0"], restartPolicy: "on-failure", startupTimeoutMs: 600000 });
  const realNow = Date.now;
  let offset = 0;
  Date.now = () => realNow() + offset;
  try {
    const firstSpawn = children.length;
    await core.startInstance(id);
    assert.strictEqual(children.length, firstSpawn + 1, "the manual start spawned once");
    for (let crash = 1; crash <= 4; crash += 1) {
      const before = children.length;
      offset += 30000; // the server loads for 30 s, then crashes
      children[children.length - 1].emit("exit", 1, null);
      if (crash < 4) {
        assert.ok(await waitFor(() => children.length > before, 15000), `crash ${crash} is restarted`);
        // Crash the restarted server only once its start is recorded (Starting
        // or Running with the new PID), as a real crash 30 s in would be; a
        // fixed short wait raced that bookkeeping under load.
        const restarted = children[children.length - 1];
        assert.ok(await waitFor(async () => {
          const current = await core.getStatus(id);
          return ["Starting", "Running"].includes(current.state) && current.pid === restarted.pid;
        }, 15000), `restart ${crash} is recorded as running`);
      }
    }
    await waitFor(async () => (await core.getStatus(id)).failureReason === "CRASH_LOOP", 8000);
    // An unfixed build schedules a 1 s restart here; give it the chance.
    await wait(1500);
    const status = await core.getStatus(id);
    assert.strictEqual(status.failureReason, "CRASH_LOOP", "four crashes within minutes of starting are a crash loop");
    assert.strictEqual(core._test.getResourceCounts().restartTimers, 0, "no further restart is pending");
    assert.strictEqual(children.length, firstSpawn + 4, "the server was started four times, not again");

    // A run that stayed up past the stable window resets the budget.
    await core.startInstance(id);
    offset += 11 * 60 * 1000;
    children[children.length - 1].emit("exit", 1, null);
    assert.ok(await waitFor(() => core._test.getResourceCounts().restartTimers === 1, 8000), "a crash after a long run is restarted");
  } finally {
    Date.now = realNow;
    core._test.resetRestartBackoff(id);
  }
}

async function checkPollsDuringExitKeepCrashLoop() {
  for (let round = 0; round < 3; round += 1) {
    const id = `crash-polled-${round}`;
    await core.createInstance({ id, displayName: id, type: "custom-command", workingDirectory: "data", executable: process.execPath, args: ["-e", "0"], restartPolicy: "on-failure", startupTimeoutMs: 600000 });
    const realNow = Date.now;
    let offset = 0;
    let polling = true;
    Date.now = () => realNow() + offset;
    const poller = (async () => {
      while (polling) {
        await core.getStatus(id).catch(() => {});
        await wait(3);
      }
    })();
    try {
      await core.startInstance(id);
      for (let crash = 1; crash <= 4; crash += 1) {
        const before = children.length;
        offset += 30000;
        children[children.length - 1].emit("exit", 1, null);
        if (crash < 4) {
          assert.ok(await waitFor(() => children.length > before, 15000), `round ${round}: crash ${crash} is restarted`);
          const restarted = children[children.length - 1];
          assert.ok(await waitFor(async () => (await core.getStatus(id)).pid === restarted.pid, 15000), `round ${round}: restart ${crash} is recorded`);
        }
      }
      await waitFor(async () => (await core.getStatus(id)).failureReason === "CRASH_LOOP", 8000);
      await wait(300);
      polling = false;
      await poller;
      assert.strictEqual(readRecord(id).failureReason, "CRASH_LOOP", `round ${round}: the saved record keeps CRASH_LOOP after concurrent polls`);
    } finally {
      polling = false;
      Date.now = realNow;
      core._test.resetRestartBackoff(id);
    }
  }
}

async function checkReadyLineCancelsStartupTimer() {
  async function run(id, startupTimeoutMs, slow) {
    await core.createInstance({ id, displayName: id, type: "custom-command", workingDirectory: "data", executable: process.execPath, args: ["-e", "0"], restartPolicy: "never", startupTimeoutMs });
    await core.startInstance(id);
    const child = children[children.length - 1];
    if (slow) {
      // The startup timer fires first and records READINESS_TIMEOUT.
      assert.ok(await waitFor(() => readRecord(id).failureReason === "READINESS_TIMEOUT", 5000), "slow: the startup timer fired first");
    }
    child.stdout.write("[Server thread/INFO]: Done (0.4s)! For help, type \"help\"\n");
    await waitFor(() => {
      const record = readRecord(id);
      return record.readinessState === "ready" && (record.failureReason ?? null) === null;
    }, 5000);
    // Stay well past the startup timeout so a late timer write would show.
    await wait(startupTimeoutMs + 400);
    const status = await core.getStatus(id);
    const record = readRecord(id);
    child.emit("exit", 0, null);
    return { status, record };
  }
  const fast = await run("ready-fast", 500, false);
  assert.strictEqual(fast.status.readinessState, "ready", "fast: reported ready");
  assert.strictEqual(fast.status.failureReason ?? null, null, "fast: no READINESS_TIMEOUT on a ready server");
  assert.strictEqual(fast.record.readinessState, "ready", "fast: the saved readiness stays ready");
  assert.strictEqual(fast.record.healthState, "healthy", "fast: the saved health stays healthy");
  const slow = await run("ready-slow", 300, true);
  assert.strictEqual(slow.status.readinessState, "ready", "slow: reported ready");
  assert.strictEqual(slow.status.failureReason ?? null, null, "slow: the earlier READINESS_TIMEOUT is cleared once ready");
  assert.strictEqual(slow.record.failureReason ?? null, null, "slow: the saved failure reason is cleared");
}

async function checkJobRecordRetention() {
  const jobLifecycle = require(path.join(repoRoot, "src", "shared", "instances", "jobLifecycle.js"));
  const cap = Number.isInteger(jobLifecycle.MAX_TERMINAL_JOBS_PER_TARGET) ? jobLifecycle.MAX_TERMINAL_JOBS_PER_TARGET : 200;
  const root = path.join(tempRoot, "jobs-retention");
  fs.mkdirSync(root, { recursive: true });
  const hex = (n) => n.toString(16).padStart(32, "0");
  const base = Date.parse("2026-11-01T00:00:00.000Z");
  const write = (record) => fs.writeFileSync(path.join(root, `${record.id}.json`), JSON.stringify(record));
  const total = cap + 100;
  for (let index = 0; index < total; index += 1) {
    const at = new Date(base + index * 60000).toISOString();
    write({ id: `job_${hex(index + 1)}`, idempotencyKey: null, type: "instance.restart", target: { instanceId: "srv-1" }, owner: { actorId: null, role: null }, state: "succeeded", enqueuedAt: at, startedAt: at, completedAt: at, timeoutMs: 600000, attempts: 1, events: [] });
  }
  // The oldest records: one still running, one keyed and recent.
  const runningId = `job_${hex(0xaaaa)}`;
  write({ id: runningId, idempotencyKey: null, type: "instance.start", target: { instanceId: "srv-1" }, owner: { actorId: null, role: null }, state: "running", enqueuedAt: new Date(base - 120000).toISOString(), startedAt: new Date(base - 120000).toISOString(), completedAt: null, timeoutMs: 600000, attempts: 1, events: [] });
  const keyedId = `job_${hex(0xbbbb)}`;
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  write({ id: keyedId, idempotencyKey: "retention-key-0001", type: "instance.delete", target: { instanceId: "srv-1" }, owner: { actorId: null, role: null }, state: "succeeded", enqueuedAt: new Date(base - 60000).toISOString(), startedAt: recent, completedAt: recent, timeoutMs: 600000, attempts: 1, events: [] });

  await jobLifecycle._test.reset();
  jobLifecycle.configureJobLifecycle({ getRoot: () => root });
  try {
    const listed = await jobLifecycle.listJobs({ instanceId: "srv-1" });
    const files = fs.readdirSync(root).filter((name) => name.endsWith(".json"));
    assert.ok(listed.total <= cap + 2, `records are capped (${listed.total} of ${total + 2})`);
    assert.ok(files.length <= cap + 2, `files are deleted (${files.length} on disk)`);
    assert.ok(await jobLifecycle.getJob(runningId), "a running record is never pruned");
    assert.ok(fs.existsSync(path.join(root, `${runningId}.json`)), "a running record's file stays");
    assert.ok(await jobLifecycle.getJob(keyedId), "a recent keyed record stays (its key must not replay)");
    assert.ok(await jobLifecycle.getJob(`job_${hex(total)}`), "the newest record stays");
    assert.strictEqual(await jobLifecycle.getJob(`job_${hex(1)}`), null, "the oldest record is gone");
    assert.ok(!fs.existsSync(path.join(root, `job_${hex(1)}.json`)), "the oldest record's file is gone");

    // A newly settled job keeps the store at the cap.
    await jobLifecycle.createJob({ type: "instance.restart", target: { instanceId: "srv-1" }, run: async () => ({ ok: true }) });
    const after = await jobLifecycle.listJobs({ instanceId: "srv-1" });
    assert.ok(after.total <= cap + 2, `settling a job prunes the oldest (${after.total})`);
    assert.strictEqual(fs.readdirSync(root).filter((name) => name.endsWith(".json")).length, after.total, "disk and memory agree");
  } finally {
    await jobLifecycle._test.reset();
  }
}

async function checkUsageNotReported() {
  const Model = require(path.join(repoRoot, "src", "shared", "serverViewModel.js"));
  const windowsSample = { id: "win", state: "Running", pid: 41772, uptimeSeconds: 180, cpuPercent: null, cpuSeconds: null, memoryRssBytes: null, diskBytes: 1, ports: [] };
  const linuxFirstSample = { id: "lin", state: "Running", pid: 4242, uptimeSeconds: 2, cpuPercent: null, cpuSeconds: 1.5, memoryRssBytes: 1048576, diskBytes: 1, ports: [] };
  assert.strictEqual(typeof Model.reportsUsage, "function", "the model can tell an unmeasured server from a first sample");
  assert.strictEqual(Model.reportsUsage(windowsSample), false, "no CPU time and no memory: not reported");
  assert.strictEqual(Model.reportsUsage(linuxFirstSample), true, "a first Linux sample is still measuring");

  // My Servers row and detail panel (app.js).
  const app = fs.readFileSync(path.join(repoRoot, "app.js"), "utf8");
  const appContext = { window: { AnxServerViewModel: Model } };
  vm.createContext(appContext);
  for (const name of ["instanceUsageNotReported", "formatInstanceCpuPercent", "formatInstanceCpu"]) vm.runInContext(extractFunction(app, name), appContext);
  const rowCpu = vm.runInContext(`formatInstanceCpuPercent(${JSON.stringify(windowsSample)})`, appContext);
  assert.notStrictEqual(rowCpu, "CPU warming", "the row does not promise a reading that never comes");
  assert.match(rowCpu, /not reported/i, "the row says usage is not reported");
  assert.doesNotMatch(vm.runInContext(`formatInstanceCpu(${JSON.stringify(windowsSample)})`, appContext), /warming/i, "the detail panel does not say warming");
  assert.strictEqual(vm.runInContext(`formatInstanceCpuPercent(${JSON.stringify(linuxFirstSample)})`, appContext), "CPU warming", "a first Linux sample still says warming");

  // Server page Resources card (serverView.js).
  const serverView = fs.readFileSync(path.join(repoRoot, "src", "renderer", "serverView.js"), "utf8");
  const viewContext = { Model };
  vm.createContext(viewContext);
  vm.runInContext(extractFunction(serverView, "resourcesMessage"), viewContext);
  const message = (readings) => vm.runInContext(`resourcesMessage(${JSON.stringify(readings)})`, viewContext);
  assert.match(String(message({ running: true, freshness: "live", reportsUsage: false, status: "ready" })), /doesn't report usage/, "a live sample with no usage reads 'doesn't report usage'");
  assert.strictEqual(message({ running: true, freshness: "live", reportsUsage: true, status: "ready" }), null, "a measured server shows its readings");
  assert.strictEqual(message({ running: true, freshness: "none", reportsUsage: false, status: "loading" }), "Measuring…", "before the first sample it is measuring");
  assert.ok(/reportsUsage:\s*Model\.reportsUsage\(sample\)/.test(extractFunction(serverView, "liveReadings")), "live readings carry the model's verdict");

  // systemd-managed uptime comes from the unit, not a PID the Agent never has.
  const id = "svc-uptime";
  fs.mkdirSync(path.join(instanceRoot, id, "data"), { recursive: true });
  fs.writeFileSync(path.join(instanceRoot, id, "config.json"), JSON.stringify({
    id, type: "systemd-service", templateId: "fivem", displayName: "AnxRP", schemaVersion: 2, installationState: "active",
    workingDirectory: "data", ports: [], autoStart: false, restartPolicy: "never", serviceManager: { kind: "systemd", unit: "anxrp-fxserver.service" },
  }, null, 2));
  core.configureInstanceService({
    systemdController: {
      async describe(unit) {
        return { unit, loadState: "loaded", activeState: "active", subState: "running", result: "success", mainPid: 4242, execMainStatus: 0, restartCount: 0, activeEnterTimestamp: "", activeEnterTimestampMs: Date.now() - 3722 * 1000, unitFileState: "enabled" };
      },
      async control() { throw new Error("not expected"); },
      async readJournal() { return []; },
      summary() { return { mechanism: "systemd", supported: true }; },
    },
  });
  const metrics = await core.getMetrics(id);
  assert.ok(Math.abs(metrics.uptimeSeconds - 3722) <= 2, `a systemd unit's uptime is reported (${metrics.uptimeSeconds}s, not 0s)`);
}

async function checkDriftedDailyScheduleReanchored() {
  const service = require(path.join(repoRoot, "agent", "src", "services", "restartScheduleService"));
  const root = path.join(tempRoot, "drifted-schedules");
  fs.mkdirSync(root, { recursive: true });
  let clock = 0;
  let restarts = [];
  let warnings = 0;
  service.configureRestartScheduleService({
    root,
    now: () => clock,
    isInstanceRunning: async () => true,
    warnInstance: async () => { warnings += 1; return { sent: true }; },
    restartInstance: async (instanceId) => { restarts.push(clock); return { id: instanceId }; },
    restartInstanceWithSteamUpdate: async () => { throw new Error("not expected"); },
    listInstanceJobs: async () => ({ jobs: [] }),
  });
  // Ticks once a minute from startIso to endIso over a record whose stored
  // nextRunAt is what the old flat +24 h build wrote.
  async function simulate(id, storedIso, startIso, endIso) {
    restarts = [];
    warnings = 0;
    const schedule = {
      id, instanceId: "server-a", type: "daily", enabled: true, dailyTime: "04:00", intervalHours: null,
      warnMinutes: 5, autoUpdateSteam: false, backupBeforeUpdate: true,
      nextRunAt: storedIso, warnState: { dueAt: storedIso, longSentAt: null, shortSentAt: null },
      createdAt: startIso, updatedAt: startIso, lastRunAt: null, lastError: null, skippedAt: null, skipReason: null, lastSteamUpdate: null,
    };
    fs.writeFileSync(path.join(root, "schedules.json"), JSON.stringify({ schemaVersion: service.RESTART_SCHEDULE_SCHEMA_VERSION, schedules: [schedule] }));
    for (clock = Date.parse(startIso); clock <= Date.parse(endIso); clock += 60 * 1000) {
      await service.runDueSchedules();
    }
    return restarts.map((at) => new Date(at).toISOString());
  }
  // Fall back drift: a 04:00 schedule stored at 03:00 MST (10:00Z).
  const fall = await simulate("drift0fall000000001", "2026-11-15T10:00:00.000Z", "2026-11-15T09:50:00.000Z", "2026-11-15T11:10:00.000Z");
  assert.strictEqual(fall.length, 1, `a drifted-early schedule restarts once, not twice (${fall.join(", ")})`);
  assert.ok(Date.parse(fall[0]) >= Date.parse("2026-11-15T11:00:00.000Z") && Date.parse(fall[0]) < Date.parse("2026-11-15T11:01:00.000Z"),
    `the restart is at 04:00 MST, not 03:00 (${fall[0]})`);
  assert.strictEqual(warnings, 2, "one set of warnings is sent, for 04:00");
  // Spring forward drift: a 04:00 schedule stored at 05:00 MDT (11:00Z).
  const spring = await simulate("drift0spring0000001", "2027-03-15T11:00:00.000Z", "2027-03-15T09:50:00.000Z", "2027-03-15T11:10:00.000Z");
  assert.strictEqual(spring.length, 1, `a drifted-late schedule restarts once (${spring.join(", ")})`);
  assert.ok(Date.parse(spring[0]) >= Date.parse("2027-03-15T10:00:00.000Z") && Date.parse(spring[0]) < Date.parse("2027-03-15T10:01:00.000Z"),
    `the restart is at 04:00 MDT, not 05:00 (${spring[0]})`);
  // A correct record is left alone.
  const plain = await simulate("drift0none000000001", "2026-11-15T11:00:00.000Z", "2026-11-15T10:50:00.000Z", "2026-11-15T11:10:00.000Z");
  assert.deepStrictEqual(plain, ["2026-11-15T11:00:00.000Z"], "a record at its wall-clock time restarts on time");
}

// Runs inside a worker thread (see checkDailyMidnightSchedulesTerminate), so
// a scheduler that loops forever can be terminated and reported as a failure
// instead of hanging the smoke. It only uses its own arguments and require.
function dailyScheduleWorkerMain() {
  const assert = require("assert");
  const fs = require("fs");
  const path = require("path");
  // Runs in a child process started with TZ set (see the runner below).
  const workerData = JSON.parse(process.env.ANX_DAILY_SCHEDULE_RUN || "{}");
  const parentPort = { postMessage: (message) => process.stdout.write(`${JSON.stringify(message)}\n`) };
  const { repoRoot, root, zone, integration, sweepFromIso, sweepToIso, minimalityChecked } = workerData;
  const service = require(path.join(repoRoot, "agent", "src", "services", "restartScheduleService"));
  const HOUR = 60 * 60 * 1000;
  const iso = (ms) => new Date(ms).toISOString();

  async function simulate(dailyTime, storedIso, startIso, endIso) {
    let clock = 0;
    const restarts = [];
    service.configureRestartScheduleService({
      root,
      now: () => clock,
      isInstanceRunning: async () => true,
      warnInstance: async () => ({ sent: true }),
      restartInstance: async (instanceId) => { restarts.push(iso(clock)); return { id: instanceId }; },
      restartInstanceWithSteamUpdate: async () => { throw new Error("not expected"); },
      listInstanceJobs: async () => ({ jobs: [] }),
    });
    const schedule = {
      id: `midnight${dailyTime.replace(":", "")}${Date.parse(storedIso)}`, instanceId: "server-a", type: "daily", enabled: true, dailyTime, intervalHours: null,
      warnMinutes: 5, autoUpdateSteam: false, backupBeforeUpdate: true,
      nextRunAt: storedIso, warnState: { dueAt: storedIso, longSentAt: null, shortSentAt: null },
      createdAt: startIso, updatedAt: startIso, lastRunAt: null, lastError: null, skippedAt: null, skipReason: null, lastSteamUpdate: null,
    };
    fs.writeFileSync(path.join(root, "schedules.json"), JSON.stringify({ schemaVersion: service.RESTART_SCHEDULE_SCHEMA_VERSION, schedules: [schedule] }));
    for (clock = Date.parse(startIso); clock <= Date.parse(endIso); clock += 5 * 60 * 1000) {
      await service.runDueSchedules();
    }
    const saved = JSON.parse(fs.readFileSync(path.join(root, "schedules.json"), "utf8")).schedules[0];
    return { restarts, nextRunAt: saved.nextRunAt };
  }

  async function runIntegration() {
    // America/Edmonton: DST ends 2026-11-01 and 2027-11-07 at 02:00 MDT, and
    // starts 2027-03-14 at 02:00 MST. Ticks every 5 minutes.
    const cases = [
      ["00:30, correct record due on the fall-back day", "00:30", "2026-11-01T06:30:00.000Z", "2026-11-01T06:00:00.000Z", "2026-11-02T07:45:00.000Z",
        ["2026-11-01T06:30:00.000Z", "2026-11-02T07:30:00.000Z"], "2026-11-03T07:30:00.000Z"],
      ["00:00, correct record evaluated through the fall-back day", "00:00", "2026-11-02T07:00:00.000Z", "2026-11-01T06:00:00.000Z", "2026-11-02T07:15:00.000Z",
        ["2026-11-02T07:00:00.000Z"], "2026-11-03T07:00:00.000Z"],
      ["00:30, record an old build stored at 23:30 the day before", "00:30", "2027-11-08T06:30:00.000Z", "2027-11-07T19:00:00.000Z", "2027-11-08T07:45:00.000Z",
        ["2027-11-08T07:30:00.000Z"], "2027-11-09T07:30:00.000Z"],
      ["01:30, the repeated hour restarts once", "01:30", "2026-11-01T07:30:00.000Z", "2026-11-01T07:00:00.000Z", "2026-11-02T08:45:00.000Z",
        ["2026-11-01T07:30:00.000Z", "2026-11-02T08:30:00.000Z"], "2026-11-03T08:30:00.000Z"],
      ["23:30 across the fall-back day", "23:30", "2026-11-01T05:30:00.000Z", "2026-11-01T05:00:00.000Z", "2026-11-02T06:45:00.000Z",
        ["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"], "2026-11-03T06:30:00.000Z"],
      ["00:00 across the spring-forward day", "00:00", "2027-03-14T07:00:00.000Z", "2027-03-14T06:30:00.000Z", "2027-03-15T06:15:00.000Z",
        ["2027-03-14T07:00:00.000Z", "2027-03-15T06:00:00.000Z"], "2027-03-16T06:00:00.000Z"],
      ["02:30, a time the spring-forward day skips", "02:30", "2027-03-13T09:30:00.000Z", "2027-03-13T09:00:00.000Z", "2027-03-15T08:45:00.000Z",
        ["2027-03-13T09:30:00.000Z", "2027-03-14T09:30:00.000Z", "2027-03-15T08:30:00.000Z"], "2027-03-16T08:30:00.000Z"],
    ];
    for (const [label, dailyTime, storedIso, startIso, endIso, expectedRestarts, expectedNext] of cases) {
      const result = await simulate(dailyTime, storedIso, startIso, endIso);
      assert.deepStrictEqual(result.restarts, expectedRestarts, `${label}: restarts`);
      assert.strictEqual(result.nextRunAt, expectedNext, `${label}: next run`);
    }
  }

  function localDateKey(ms) {
    const date = new Date(ms);
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
  }

  // Every 15 minutes (and 1 ms before) around each UTC-offset change, and
  // every 7 hours elsewhere, for wall-clock times every 30 minutes and 23:59.
  function runSweep() {
    const from = Date.parse(sweepFromIso);
    const to = Date.parse(sweepToIso);
    const transitions = [];
    for (let t = from; t < to; t += HOUR) {
      if (new Date(t).getTimezoneOffset() !== new Date(t + HOUR).getTimezoneOffset()) {
        transitions.push(t);
      }
    }
    const fromPoints = [];
    for (const t of transitions) {
      for (let p = t - 48 * HOUR; p <= t + 48 * HOUR; p += 15 * 60 * 1000) {
        fromPoints.push(p, p - 1);
      }
    }
    for (let p = from; p < to; p += 7 * HOUR) {
      fromPoints.push(p);
    }
    const times = [];
    for (let minutes = 0; minutes < 24 * 60; minutes += 30) {
      times.push(minutes);
    }
    times.push(23 * 60 + 59);
    let calls = 0;
    for (const fromMs of fromPoints) {
      for (const minutesOfDay of times) {
        const next = service.nextDailyRunMs(minutesOfDay, fromMs);
        calls += 1;
        const where = `${zone} ${minutesOfDay} min from ${iso(fromMs)} -> ${Number.isFinite(next) ? iso(next) : next}`;
        assert.ok(Number.isFinite(next) && next > fromMs, `the next run is after the start (${where})`);
        assert.ok(next - fromMs <= (minimalityChecked ? 25 : 49) * HOUR, `the next run is within a day (${where})`);
        if (!minimalityChecked) {
          continue;
        }
        const local = new Date(next);
        const shifted = local.getTimezoneOffset() !== new Date(next - 3 * HOUR).getTimezoneOffset();
        assert.ok(local.getHours() * 60 + local.getMinutes() === minutesOfDay || shifted, `the run is at its wall-clock time (${where})`);
        const today = new Date(fromMs);
        today.setHours(Math.floor(minutesOfDay / 60), minutesOfDay % 60, 0, 0);
        if (today.getTime() > fromMs && localDateKey(today.getTime()) === localDateKey(fromMs)) {
          assert.strictEqual(next, today.getTime(), `today's run is not skipped (${where})`);
        } else {
          const start = new Date(fromMs);
          const tomorrow = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1, 12);
          assert.strictEqual(localDateKey(next), localDateKey(tomorrow.getTime()), `the run is the next day (${where})`);
        }
      }
    }
    return { calls, transitions: transitions.length };
  }

  (async () => {
    try {
      if (integration) {
        await runIntegration();
      }
      const sweep = runSweep();
      parentPort.postMessage({ ok: true, zone, ...sweep });
    } catch (error) {
      parentPort.postMessage({ ok: false, zone, error: error?.stack || String(error) });
    }
  })();
}

async function checkDailyMidnightSchedulesTerminate() {
  const root = path.join(tempRoot, "midnight-schedules");
  fs.mkdirSync(root, { recursive: true });
  // The time zone is read when a process starts, so each zone runs in its own
  // child process with TZ in its environment, killed after 30 s. Havana
  // repeats 00:xx when DST ends; Santiago and Beirut change at midnight;
  // Lord Howe moves by 30 minutes; Apia skipped 2011-12-30 entirely.
  const runs = [
    { zone: "America/Edmonton", integration: true, sweepFromIso: "2026-01-01T00:00:00.000Z", sweepToIso: "2028-01-01T00:00:00.000Z", minimalityChecked: true },
    { zone: "America/Havana", sweepFromIso: "2026-01-01T00:00:00.000Z", sweepToIso: "2028-01-01T00:00:00.000Z", minimalityChecked: true },
    { zone: "America/Santiago", sweepFromIso: "2026-01-01T00:00:00.000Z", sweepToIso: "2028-01-01T00:00:00.000Z", minimalityChecked: true },
    { zone: "Asia/Beirut", sweepFromIso: "2026-01-01T00:00:00.000Z", sweepToIso: "2028-01-01T00:00:00.000Z", minimalityChecked: true },
    { zone: "Australia/Lord_Howe", sweepFromIso: "2026-01-01T00:00:00.000Z", sweepToIso: "2028-01-01T00:00:00.000Z", minimalityChecked: true },
    { zone: "Europe/London", sweepFromIso: "2026-01-01T00:00:00.000Z", sweepToIso: "2027-01-01T00:00:00.000Z", minimalityChecked: true },
    { zone: "Pacific/Apia", sweepFromIso: "2011-12-01T00:00:00.000Z", sweepToIso: "2012-02-01T00:00:00.000Z", minimalityChecked: false },
  ];
  for (const run of runs) {
    const child = realSpawnSync(process.execPath, ["-e", `(${dailyScheduleWorkerMain.toString()})();`], {
      env: { ...process.env, TZ: run.zone, ANX_DAILY_SCHEDULE_RUN: JSON.stringify({ repoRoot, root, ...run }) },
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const line = String(child.stdout || "").trim().split(/\r?\n/).filter(Boolean).pop() || "";
    let result;
    try { result = JSON.parse(line); } catch { result = null; }
    if (!result) {
      result = child.error?.code === "ETIMEDOUT" || child.signal
        ? { ok: false, error: "the scheduler did not return within 30 s (it loops forever)" }
        : { ok: false, error: `no result (exit ${child.status}): ${String(child.stderr || "").slice(-600)}` };
    }
    assert.ok(result.ok, `${run.zone}: ${result.error}`);
    assert.ok(result.transitions > 0 || run.zone === "Pacific/Apia", `${run.zone}: the sweep crossed a DST change`);
  }
  assert.strictEqual(new Date(Date.parse("2026-07-01T12:00:00.000Z")).getHours(), 6, "the smoke runs in America/Edmonton");
}

const checks = [
  ["IE1 Palworld players read REST settings from the Marketplace layout", checkPalworldMarketplaceLayout],
  ["IE2 daily restart schedules keep their local time across DST", checkDailyScheduleAcrossDst],
  ["IE3 crash-loop protection trips for crashes 30 s after starting", checkCrashLoopAfterSlowCrashes],
  ["IE4 a ready line cancels the startup timer and clears READINESS_TIMEOUT", checkReadyLineCancelsStartupTimer],
  ["IE5 terminal job records are capped on disk and in memory", checkJobRecordRetention],
  ["IE6 unmeasured usage reads 'not reported'; systemd uptime is used", checkUsageNotReported],
  ["IE7 a daily schedule drifted by an older build is re-anchored to its local time", checkDriftedDailyScheduleReanchored],
  ["IE8 daily schedules near midnight never hang the Agent on a DST day", checkDailyMidnightSchedulesTerminate],
  ["IE9 status polls during a crash's exit handling keep CRASH_LOOP", checkPollsDuringExitKeepCrashLoop],
];

(async () => {
  let failed = 0;
  for (const [label, check] of checks) {
    try {
      await check();
      console.log(`PASS ${label}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${label}\n  ${error?.stack || error}`);
    }
  }
  core.disposeInstanceService();
  try { fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  if (failed) {
    console.log(`instance-engine-fixes-smoke: ${failed} of ${checks.length} checks failed`);
    process.exit(1);
  }
  console.log(`instance-engine-fixes-smoke passed (${checks.length} checks)`);
  process.exit(0);
})();
