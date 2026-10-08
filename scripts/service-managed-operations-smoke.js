"use strict";

// Operations layer for service-managed instances: configuration, evidence readers, the player-aware
// preflight, the Safe Restart state machine, and the restart history. A deterministic fake world
// (virtual clock, systemd, status file, player endpoints, sockets) drives every fail-closed branch;
// the history store uses real files in a temp directory.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const operations = require("../src/shared/instances/serviceManagedOperations");

const UNIT = "anxrp-fxserver.service";
const ID = "fivem-fxserver";
const T0 = 1791450000000;

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeConfig(statusPath, overrides = {}) {
  return {
    id: ID,
    type: "systemd-service",
    ports: [30120],
    serviceManager: {
      kind: "systemd",
      unit: UNIT,
      operations: {
        health: { kind: "anxrp-status-file", path: statusPath, maxAgeSeconds: 60 },
        players: { kind: "fxserver-http", baseUrl: "http://127.0.0.1:30120" },
        listeners: { ports: [30120], protocols: ["tcp", "udp"] },
        safeRestart: { timeoutSeconds: 60 },
        ...overrides,
      },
    },
  };
}

// A world whose observable state is a function of a virtual clock. `flags` inject faults.
function makeWorld(flags = {}) {
  const dir = tempDir("anx-ops-");
  const statusDir = path.join(dir, "status");
  fs.mkdirSync(statusDir, { recursive: true });
  const statusPath = path.join(statusDir, "anxrp-status.json");
  const instanceDir = path.join(dir, "instance");
  fs.mkdirSync(path.join(instanceDir, "logs"), { recursive: true });
  const world = {
    dir, statusPath, instanceDir, clock: T0, calls: [], restartAt: null, flags: { ...flags }, sleeps: 0, onSleep: null,
    delays: { pid: 2000, listeners: 3000, ready: 6000 },
    before: { pid: 4242, enteredMs: T0 - 3600 * 1000, restartCount: 0, boot: "boot-1" },
    deployment: null, // string content, or null for absent
    statPaths: {},
    players: { clients: 0, roster: [] },
  };
  const f = () => world.flags;
  const sinceRestart = () => (world.restartAt === null ? -1 : world.clock - world.restartAt);

  world.systemd = () => {
    const dt = sinceRestart();
    if (dt < 0 || f().pidNeverChanges) {
      return { activeState: f().initialState || "active", subState: f().initialSub || "running", mainPid: f().initialPid ?? world.before.pid, enteredMs: world.before.enteredMs, restartCount: world.before.restartCount };
    }
    if (dt < world.delays.pid && !f().pidNeverChanges) return { activeState: "activating", subState: "start", mainPid: 0, enteredMs: world.restartAt, restartCount: world.before.restartCount };
    if (f().pidChangesAgain && dt > world.delays.ready + 500) return { activeState: "active", subState: "running", mainPid: 6000, enteredMs: world.restartAt + world.delays.ready + 400, restartCount: world.before.restartCount };
    return { activeState: "active", subState: "running", mainPid: f().samePidNewTimestamp ? world.before.pid : 5000, enteredMs: world.restartAt + world.delays.pid, restartCount: world.before.restartCount + (f().crashLoop ? 1 : 0) };
  };

  world.statusDocument = () => {
    const dt = sinceRestart();
    const ready = dt >= world.delays.ready && !f().neverReady;
    if (dt < 0) return { state: f().healthState || "READY", boot_id: f().noBootId ? undefined : world.before.boot, framework: { version: "0.5.0" }, uptime_sec: 4000, sessions: { active: 0, total: 0, spawned: 0, with_character: 0 } };
    if (ready) return { state: "READY", boot_id: f().bootIdUnchanged ? world.before.boot : "boot-2", framework: { version: "0.5.0" }, uptime_sec: 3, sessions: { active: 0, total: 0, spawned: 0, with_character: 0 } };
    return { state: "STARTING", boot_id: "boot-2", uptime_sec: 1 };
  };

  world.deps = (extra = {}) => ({
    now: () => world.clock,
    sleep: async (ms) => { world.clock += ms; world.sleeps += 1; if (world.onSleep) await world.onSleep(); },
    newId: (() => { let n = 0; return () => `op_test_${++n}`; })(),
    env: { AGENT_SERVICE_STATUS_ROOTS: statusDir },
    instanceDir: (config) => (f().historyBroken ? path.join(world.dir, "no", "such", "\0bad") : config && config.id !== ID ? path.join(world.dir, `other-${config.id}`) : instanceDir),
    agentBuild: () => ({ artifactVersion: "2.0-build206", releaseTag: "v2.0-build206", builtAt: "2026-10-08T03:43:40.244Z" }),
    describe: async (unit) => {
      assert.equal(unit, UNIT);
      if (f().describeThrows) throw Object.assign(new Error("x"), { code: "SERVICE_QUERY_FAILED" });
      const s = world.systemd();
      return { unit, loadState: f().notLoaded ? "not-found" : "loaded", activeState: s.activeState, subState: s.subState, result: "success", mainPid: s.mainPid, restartCount: s.restartCount, unitFileState: "enabled", activeEnterTimestampMs: s.enteredMs, activeEnterTimestamp: new Date(s.enteredMs).toISOString() };
    },
    control: async (verb, unit) => {
      world.calls.push([verb, unit]);
      if (f().controlThrows) throw Object.assign(new Error("denied"), { code: "SERVICE_CONTROL_DENIED" });
      if (verb === "restart") world.restartAt = world.clock;
      if (f().playerJoinsAfterControl) world.players = { clients: 2, roster: [{ name: "a" }, { name: "b" }] };
      return { unit, verb };
    },
    readFile: async (target, max) => {
      if (target === statusPath) {
        if (f().healthMissing) throw Object.assign(new Error("x"), { code: "ENOENT" });
        if (f().healthUnreadable) throw Object.assign(new Error("x"), { code: "EACCES" });
        if (f().healthTooLarge) throw Object.assign(new Error("x"), { code: "TOO_LARGE" });
        const text = f().healthInvalid ? "{not json" : JSON.stringify(world.statusDocument());
        return { text, mtimeMs: world.clock - (f().healthAgeMs ?? 2000), size: text.length };
      }
      if (target.endsWith("deployment.json")) {
        if (world.deployment === null) throw Object.assign(new Error("x"), { code: "ENOENT" });
        return { text: world.deployment, mtimeMs: world.clock, size: world.deployment.length };
      }
      throw Object.assign(new Error("unexpected read"), { code: "ENOENT" });
    },
    httpGetJson: async ({ pathname }) => {
      if (f().playersDown) throw Object.assign(new Error("x"), { code: "ECONNREFUSED" });
      if (pathname === "/dynamic.json") return { clients: f().playersMismatch ? world.players.clients + 1 : world.players.clients };
      if (pathname === "/players.json") { if (f().rosterDown) throw Object.assign(new Error("x"), { code: "TIMEOUT" }); return world.players.roster; }
      throw new Error(`unexpected ${pathname}`);
    },
    listListeningSockets: async () => {
      if (f().listenersUnavailable) return null;
      const dt = sinceRestart();
      if (dt >= 0 && dt < world.delays.listeners) return [];
      if (f().udpMissing) return [{ port: 30120, protocol: "tcp" }];
      if (dt >= 0 && f().portsNeverReturn) return [];
      return [{ port: 30120, protocol: "tcp" }, { port: 30120, protocol: "udp" }, { port: 22, protocol: "tcp" }];
    },
    statPath: async (target) => {
      const mode = world.statPaths[target];
      if (mode === "missing") throw Object.assign(new Error("x"), { code: "ENOENT" });
      if (mode === "denied") throw Object.assign(new Error("x"), { code: "EACCES" });
      return {};
    },
    ...extra,
  });

  world.service = (extra) => operations.createServiceOperations(world.deps(extra));
  world.config = (overrides) => makeConfig(statusPath, overrides);
  world.cleanup = () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  return world;
}

async function startAndFinish(service, config, options = {}) {
  const started = await service.startSafeRestart(config, { confirm: true, ...options });
  await started.completion;
  return service.getOperation(config, started.operation.id);
}

// ------------------------------- configuration -------------------------------

test("operations config: valid record, and each invalid part fails closed with a reason", () => {
  const w = makeWorld();
  try {
    const env = { AGENT_SERVICE_STATUS_ROOTS: path.dirname(w.statusPath) };
    const ok = operations.normalizeOperationsConfig(w.config(), env);
    assert.ok(ok.health && ok.players && ok.listeners);
    assert.deepEqual(ok.problems, []);
    assert.equal(operations.safeRestartAvailability(ok).available, true);
    assert.equal(ok.players.host, "127.0.0.1");
    assert.equal(ok.players.port, 30120);

    const outside = operations.normalizeOperationsConfig(w.config({ health: { kind: "anxrp-status-file", path: path.join(os.tmpdir(), "elsewhere.json") } }), env);
    assert.equal(outside.health, null);
    assert.match(outside.problems.join(" "), /outside AGENT_SERVICE_STATUS_ROOTS/);

    assert.equal(operations.normalizeOperationsConfig(w.config(), {}).health, null, "no allowed roots means no file may be read");
    assert.match(operations.normalizeOperationsConfig(w.config(), {}).problems.join(" "), /AGENT_SERVICE_STATUS_ROOTS is not set/);

    for (const badPath of ["relative/status.json", `${w.statusPath}x`, `${path.dirname(w.statusPath)}${path.sep}..${path.sep}status${path.sep}anxrp-status.json`, `${w.statusPath}\0`]) {
      assert.equal(operations.normalizeOperationsConfig(w.config({ health: { kind: "anxrp-status-file", path: badPath } }), env).health, null, JSON.stringify(badPath));
    }
    for (const badUrl of ["http://example.com:30120", "https://127.0.0.1:30120", "http://127.0.0.1", "http://user:pw@127.0.0.1:30120", "http://127.0.0.1:30120/admin", "ftp://127.0.0.1:30120", "not a url", "http://10.0.0.5:30120"]) {
      assert.equal(operations.normalizeOperationsConfig(w.config({ players: { kind: "fxserver-http", baseUrl: badUrl } }), env).players, null, badUrl);
    }
    assert.equal(operations.normalizeOperationsConfig(w.config({ players: { kind: "fxserver-http", baseUrl: "http://localhost:30120" } }), env).players.host, "127.0.0.1");
    assert.equal(operations.normalizeOperationsConfig(w.config({ players: { kind: "fxserver-http", baseUrl: "http://[::1]:30120" } }), env).players.host, "::1");
    assert.equal(operations.normalizeOperationsConfig(w.config({ health: { kind: "anxrp-status-file", path: w.statusPath, maxAgeSeconds: 5 } }), env).health, null);
    assert.equal(operations.normalizeOperationsConfig(w.config({ safeRestart: { timeoutSeconds: 5 } }), env).problems.length > 0, true);
    assert.equal(operations.normalizeOperationsConfig(w.config({ listeners: { ports: [0, 70000] } }), env).listeners, null);
    assert.deepEqual(operations.normalizeOperationsConfig(w.config({ listeners: undefined }), env).listeners.ports, [30120], "ports default from the record");
    for (const missing of ["health", "players"]) {
      const partial = operations.normalizeOperationsConfig(w.config({ [missing]: undefined }), env);
      assert.equal(operations.safeRestartAvailability(partial).available, false, `${missing} missing disables Safe Restart`);
    }
    assert.equal(operations.safeRestartAvailability(operations.normalizeOperationsConfig({ serviceManager: { kind: "systemd", unit: UNIT } }, env)).available, false);
  } finally { w.cleanup(); }
});

// ------------------------------- evidence readers -------------------------------

test("health: READY only when fresh with a boot id; everything else is not ready", async () => {
  const w = makeWorld();
  try {
    const cfg = operations.normalizeOperationsConfig(w.config(), w.deps().env).health;
    const read = (flags) => { w.flags = flags; return operations.readHealth(cfg, w.deps()); };
    const ready = await read({});
    assert.equal(ready.ready, true);
    assert.equal(ready.bootId, "boot-1");
    assert.equal(ready.version, "0.5.0");
    assert.equal(ready.sessions.active, 0);
    assert.equal((await read({ healthAgeMs: 61000 })).ready, false, "stale");
    assert.equal((await read({ healthAgeMs: 61000 })).stale, true);
    assert.equal((await read({ healthState: "STARTING" })).ready, false);
    assert.equal((await read({ healthState: "ready" })).ready, false, "case-sensitive");
    assert.equal((await read({ noBootId: true })).ready, false, "no boot id means unverifiable");
    assert.equal((await read({ healthMissing: true })).error, "HEALTH_FILE_MISSING");
    assert.equal((await read({ healthUnreadable: true })).error, "HEALTH_FILE_UNREADABLE");
    assert.equal((await read({ healthTooLarge: true })).error, "HEALTH_FILE_TOO_LARGE");
    assert.equal((await read({ healthInvalid: true })).error, "HEALTH_FILE_INVALID");
    for (const bad of [null, undefined]) assert.equal((await operations.readHealth(bad, w.deps())).available, false);
    const weird = await operations.readHealth(cfg, w.deps({ readFile: async () => ({ text: JSON.stringify({ state: "READY", boot_id: "boot 1; rm -rf /" }), mtimeMs: w.clock, size: 10 }) }));
    assert.equal(weird.ready, false, "a boot id with unsafe characters is rejected");
  } finally { w.cleanup(); }
});

test("players: a count only when both endpoints agree; the roster is never kept", async () => {
  const w = makeWorld();
  try {
    const cfg = operations.normalizeOperationsConfig(w.config(), w.deps().env).players;
    const read = (flags, players) => { w.flags = flags; if (players) w.players = players; return operations.readPlayers(cfg, w.deps()); };
    const zero = await read({}, { clients: 0, roster: [] });
    assert.deepEqual([zero.available, zero.consistent, zero.count], [true, true, 0]);
    const two = await read({}, { clients: 2, roster: [{ name: "Alice Secret", identifiers: ["license:abc"] }, { name: "Bob", identifiers: ["steam:1"] }] });
    assert.equal(two.count, 2);
    assert.ok(!/Alice|license:|steam:/.test(JSON.stringify(two)), "no names or identifiers in the result");
    const mismatch = await read({ playersMismatch: true }, { clients: 0, roster: [] });
    assert.deepEqual([mismatch.consistent, mismatch.count, mismatch.error], [false, null, "PLAYERS_SOURCES_DISAGREE"]);
    assert.equal((await read({ playersDown: true })).available, false);
    assert.equal((await read({ rosterDown: true })).available, false, "one endpoint down is not enough");
    assert.equal((await operations.readPlayers(cfg, w.deps({ httpGetJson: async ({ pathname }) => (pathname === "/dynamic.json" ? { clients: "0" } : []) }))).count, 0, "numeric strings are accepted");
    for (const bad of [-1, 1.5, "x", null, {}, [], undefined]) {
      const result = await operations.readPlayers(cfg, w.deps({ httpGetJson: async ({ pathname }) => (pathname === "/dynamic.json" ? { clients: bad } : []) }));
      assert.equal(result.available, false, JSON.stringify(bad));
    }
    assert.equal((await operations.readPlayers(null, w.deps())).available, false);
  } finally { w.cleanup(); }
});

test("listeners: every configured port and protocol, and unreadable tables are a failure", async () => {
  const w = makeWorld();
  try {
    const cfg = operations.normalizeOperationsConfig(w.config(), w.deps().env).listeners;
    const read = (flags) => { w.flags = flags; return operations.readListeners(cfg, w.deps()); };
    assert.equal((await read({})).allListening, true);
    const noUdp = await read({ udpMissing: true });
    assert.equal(noUdp.allListening, false);
    assert.deepEqual(noUdp.ports[0].protocols.map((entry) => entry.listening), [true, false]);
    const unavailable = await read({ listenersUnavailable: true });
    assert.deepEqual([unavailable.available, unavailable.allListening], [false, false]);
    assert.equal((await operations.readListeners(cfg, w.deps({ listListeningSockets: async () => { throw new Error("x"); } }))).available, false);
  } finally { w.cleanup(); }
});

// ------------------------------- preflight -------------------------------

test("preflight passes on a healthy, empty server and every single failure flips it", async () => {
  const w = makeWorld();
  try {
    const service = w.service();
    const config = w.config();
    const good = await service.preflight(config, { expectedMainPid: 4242, expectedUnit: UNIT });
    assert.equal(good.ok, true, JSON.stringify(good.checks.filter((entry) => entry.status !== "pass")));
    assert.deepEqual(good.checks.map((entry) => entry.id), ["configured", "instance", "systemd", "expected-pid", "exclusive", "anxrp-ready", "players", "listeners", "audit"]);

    const cases = [
      ["service inactive", { initialState: "inactive", initialSub: "dead" }, "systemd"],
      ["service activating", { initialState: "activating", initialSub: "start" }, "systemd"],
      ["service failed", { initialState: "failed", initialSub: "failed" }, "systemd"],
      ["no main pid", { initialPid: 0 }, "systemd"],
      ["unit not loaded", { notLoaded: true }, "systemd"],
      ["systemd unreadable", { describeThrows: true }, "systemd"],
      ["AnxRP starting", { healthState: "STARTING" }, "anxrp-ready"],
      ["AnxRP stale", { healthAgeMs: 120000 }, "anxrp-ready"],
      ["AnxRP file missing", { healthMissing: true }, "anxrp-ready"],
      ["AnxRP no boot id", { noBootId: true }, "anxrp-ready"],
      ["endpoints down", { playersDown: true }, "players"],
      ["endpoints disagree", { playersMismatch: true }, "players"],
      ["a port not listening", { udpMissing: true }, "listeners"],
      ["sockets unreadable", { listenersUnavailable: true }, "listeners"],
      ["history unwritable", { historyBroken: true }, "audit"],
    ];
    for (const [label, flags, failing] of cases) {
      w.flags = flags;
      const result = await service.preflight(config, {});
      assert.equal(result.ok, false, label);
      assert.equal(result.checks.find((entry) => entry.id === failing).status, "fail", `${label} must fail ${failing}`);
    }
    w.flags = {};
    w.players = { clients: 1, roster: [{ name: "x" }] };
    const withPlayer = await service.preflight(config, {});
    assert.equal(withPlayer.ok, false);
    assert.match(withPlayer.checks.find((entry) => entry.id === "players").detail, /1 player\(s\) connected/);
    w.players = { clients: 0, roster: [] };
    assert.equal((await service.preflight(config, { expectedMainPid: 999 })).checks.find((entry) => entry.id === "expected-pid").status, "fail");
    assert.equal((await service.preflight(config, { expectedUnit: "ssh.service" })).checks.find((entry) => entry.id === "instance").status, "fail");
    const unconfigured = await service.preflight({ ...config, serviceManager: { kind: "systemd", unit: UNIT } }, {});
    assert.equal(unconfigured.ok, false);
    assert.equal(unconfigured.checks.find((entry) => entry.id === "configured").status, "fail");
    assert.deepEqual(w.calls, [], "a preflight never controls the service");
  } finally { w.cleanup(); }
});

// ------------------------------- Safe Restart -------------------------------

test("Safe Restart: exactly one restart, every phase verified, and the audit trail is written", async () => {
  const w = makeWorld();
  try {
    const service = w.service();
    const config = w.config();
    let busyDuringRun = null;
    w.onSleep = async () => { busyDuringRun = busyDuringRun === null ? service.isBusy(ID) : busyDuringRun && service.isBusy(ID); };
    const operation = await startAndFinish(service, config, { expectedMainPid: 4242, expectedUnit: UNIT });
    assert.deepEqual(w.calls, [["restart", UNIT]], "exactly one restart command");
    assert.equal(operation.outcome, "succeeded", JSON.stringify(operation.steps));
    assert.deepEqual(operation.steps.map((entry) => [entry.id, entry.status]), [["preflight", "pass"], ["players-recheck", "pass"], ["restart", "pass"], ["new-process", "pass"], ["listeners", "pass"], ["ready", "pass"], ["stable", "pass"]]);
    assert.equal(operation.pre.mainPid, 4242);
    assert.equal(operation.pre.bootId, "boot-1");
    assert.equal(operation.post.mainPid, 5000);
    assert.equal(operation.post.bootId, "boot-2");
    assert.equal(operation.post.players, 0);
    assert.equal(busyDuringRun, true, "the restart lock is held for the whole run");
    assert.equal(service.isBusy(ID), false, "and released afterwards");
    const history = await service.readHistory(config, { limit: 5 });
    assert.equal(history.length, 1);
    assert.equal(history[0].outcome, "succeeded");
    assert.equal(history[0].phase, "finished");
    const lines = fs.readFileSync(path.join(w.instanceDir, "logs", operations.HISTORY_FILE), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(lines.map((line) => line.phase), ["started", "finished"], "started is written before the command, finished after");
    assert.ok(!JSON.stringify(lines).includes("Alice"), "no player data in the history");
  } finally { w.cleanup(); }
});

test("Safe Restart refuses without confirmation, with players, or on any failed check, and never touches the service", async () => {
  const w = makeWorld();
  try {
    const service = w.service();
    const config = w.config();
    await assert.rejects(() => service.startSafeRestart(config, {}), (error) => error.code === "SERVICE_SAFE_RESTART_CONFIRMATION_REQUIRED");
    await assert.rejects(() => service.startSafeRestart(config, { confirm: "yes" }), (error) => error.code === "SERVICE_SAFE_RESTART_CONFIRMATION_REQUIRED", "only the boolean true counts");
    w.players = { clients: 3, roster: [{}, {}, {}] };
    const refused = await service.startSafeRestart(config, { confirm: true }).catch((error) => error);
    assert.equal(refused.code, "SERVICE_SAFE_RESTART_REFUSED");
    assert.equal(refused.statusCode, 409);
    assert.equal(refused.checks.find((entry) => entry.id === "players").status, "fail");
    for (const flags of [{ playersDown: true }, { listenersUnavailable: true }, { healthAgeMs: 999999 }, { initialState: "inactive", initialSub: "dead" }]) {
      w.flags = flags; w.players = { clients: 0, roster: [] };
      await assert.rejects(() => service.startSafeRestart(config, { confirm: true }), (error) => error.code === "SERVICE_SAFE_RESTART_REFUSED", JSON.stringify(flags));
    }
    assert.deepEqual(w.calls, [], "no refusal ever issued a control command");
    const history = await service.readHistory(config, { limit: 10 });
    assert.ok(history.length >= 5 && history.every((entry) => entry.outcome === "refused"), "every refusal is audited");
    assert.ok(history[0].refusal.length >= 1 && history[0].refusal[0].detail);
  } finally { w.cleanup(); }
});

test("Safe Restart re-checks players right before the command", async () => {
  const w = makeWorld();
  try {
    // The preflight's player read (first /dynamic.json) sees 0; every later read sees a player who just connected.
    let dynamicReads = 0;
    const service = w.service({
      httpGetJson: async ({ pathname }) => {
        if (pathname === "/dynamic.json") { dynamicReads += 1; return { clients: dynamicReads > 1 ? 1 : 0 }; }
        return dynamicReads > 1 ? [{}] : [];
      },
    });
    const operation = await startAndFinish(service, w.config(), { expectedMainPid: 4242 });
    assert.equal(operation.outcome, "refused");
    assert.deepEqual(w.calls, [], "the late player stopped the restart before any command");
    assert.equal(operation.steps.find((entry) => entry.id === "players-recheck").status, "fail");
    assert.equal(operation.steps.some((entry) => entry.id === "restart"), false);
  } finally { w.cleanup(); }
});

test("Safe Restart never retries a failed restart command", async () => {
  const w = makeWorld({ controlThrows: true });
  try {
    const service = w.service();
    const operation = await startAndFinish(service, w.config());
    assert.equal(operation.outcome, "failed");
    assert.equal(operation.error, "SERVICE_CONTROL_DENIED");
    assert.deepEqual(w.calls, [["restart", UNIT]], "one attempt, no retry");
    assert.equal(service.isBusy(ID), false);
    assert.equal(operation.steps.some((entry) => ["new-process", "ready"].includes(entry.id)), false, "nothing is awaited after a failed command");
  } finally { w.cleanup(); }
});

test("Safe Restart: each wait that does not complete is a timeout, never a success", async () => {
  const cases = [
    ["the process never changes", { pidNeverChanges: true }, "new-process"],
    ["the MainPID is unchanged even though the start time moved", { samePidNewTimestamp: true }, "new-process"],
    ["the listeners never return", { portsNeverReturn: true }, "listeners"],
    ["AnxRP never becomes READY", { neverReady: true }, "ready"],
    ["AnxRP READY but with the OLD boot id", { bootIdUnchanged: true }, "ready"],
  ];
  for (const [label, flags, failingStep] of cases) {
    const w = makeWorld(flags);
    try {
      const service = w.service();
      const operation = await startAndFinish(service, w.config());
      assert.equal(operation.outcome, "timeout", label);
      assert.equal(operation.steps.find((entry) => entry.id === failingStep).status, "fail", label);
      assert.deepEqual(w.calls, [["restart", UNIT]], `${label}: still exactly one restart`);
      assert.equal(service.isBusy(ID), false, `${label}: lock released`);
    } finally { w.cleanup(); }
  }
});

test("Safe Restart: a service that restarts itself again is a failure (crash-loop guard)", async () => {
  for (const flags of [{ crashLoop: true }, { pidChangesAgain: true }]) {
    const w = makeWorld(flags);
    try {
      const operation = await startAndFinish(w.service(), w.config());
      assert.equal(operation.outcome, "failed", JSON.stringify(flags));
      assert.equal(operation.steps.find((entry) => entry.id === "stable").status, "fail");
      assert.deepEqual(w.calls, [["restart", UNIT]]);
    } finally { w.cleanup(); }
  }
});

test("Safe Restart is exclusive: concurrent requests issue one restart, and plain lifecycle can see the lock", async () => {
  const w = makeWorld();
  try {
    const service = w.service();
    const config = w.config();
    const [a, b] = await Promise.allSettled([service.startSafeRestart(config, { confirm: true }), service.startSafeRestart(config, { confirm: true })]);
    const fulfilled = [a, b].filter((entry) => entry.status === "fulfilled");
    assert.equal(fulfilled.length, 1, "exactly one request wins");
    const loser = [a, b].find((entry) => entry.status === "rejected").reason;
    assert.ok(["SERVICE_OPERATION_IN_PROGRESS", "SERVICE_SAFE_RESTART_REFUSED"].includes(loser.code), loser.code);
    assert.equal(service.isBusy(ID), true);
    await assert.rejects(() => service.startSafeRestart(config, { confirm: true }), (error) => ["SERVICE_OPERATION_IN_PROGRESS", "SERVICE_SAFE_RESTART_REFUSED"].includes(error.code));
    await fulfilled[0].value.completion;
    assert.deepEqual(w.calls, [["restart", UNIT]], "one restart in total");
    assert.equal(service.isBusy(ID), false);
  } finally { w.cleanup(); }
});

test("Safe Restart requires an auditable trail: unwritable history means no restart at all", async () => {
  const w = makeWorld({ historyBroken: true });
  try {
    await assert.rejects(() => w.service().startSafeRestart(w.config(), { confirm: true }), (error) => error.code === "SERVICE_SAFE_RESTART_REFUSED");
    assert.deepEqual(w.calls, []);
  } finally { w.cleanup(); }
});

// ------------------------------- history -------------------------------

test("history: interrupted operations are detected, garbage is tolerated, and the file is bounded", async () => {
  const w = makeWorld();
  try {
    const service = w.service();
    const config = w.config();
    const file = path.join(w.instanceDir, "logs", operations.HISTORY_FILE);
    fs.writeFileSync(file, [
      JSON.stringify({ v: 1, id: "op_cut_off", kind: "safe-restart", phase: "started", startedAt: "2026-10-08T01:00:00.000Z" }),
      "this line is not json",
      JSON.stringify({ v: 1, id: "op_done", kind: "restart", phase: "finished", outcome: "succeeded", startedAt: "2026-10-08T02:00:00.000Z", finishedAt: "2026-10-08T02:00:01.000Z" }),
      "{\"v\":1,\"id\":\"op_trunc",
    ].join("\n"));
    const list = await service.readHistory(config, { limit: 10 });
    assert.deepEqual(list.map((entry) => [entry.id, entry.outcome]), [["op_done", "succeeded"], ["op_cut_off", "interrupted"]], "newest first; a started record with no finish and no live process is interrupted");

    const store = operations.createHistoryStore({ instanceDir: () => w.instanceDir });
    const big = "x".repeat(2000);
    for (let index = 0; index < 700; index += 1) await store.append(config, { v: 1, id: `op_${index}`, kind: "restart", phase: "finished", outcome: "succeeded", startedAt: new Date(T0 + index).toISOString(), pad: big });
    assert.ok(fs.statSync(file).size < 3 * 1024 * 1024, "rotation keeps the file bounded");
    const after = await service.readHistory(config, { limit: 100 });
    assert.ok(after.length === 100 && after[0].id === "op_699", "the newest entries survive rotation");
    assert.ok(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).length <= 701);
  } finally { w.cleanup(); }
});

test("getOperation: unknown, malformed and foreign ids are not found", async () => {
  const w = makeWorld();
  try {
    const service = w.service();
    const config = w.config();
    const operation = await startAndFinish(service, config);
    assert.equal((await service.getOperation(config, operation.id)).outcome, "succeeded");
    for (const bad of ["op_missing", "../../etc/passwd", "a b", "", undefined, "x".repeat(200)]) {
      await assert.rejects(() => service.getOperation(config, bad), (error) => error.code === "SERVICE_OPERATION_NOT_FOUND", String(bad));
    }
    await assert.rejects(() => service.getOperation({ ...config, id: "another-instance" }, operation.id), (error) => error.code === "SERVICE_OPERATION_NOT_FOUND", "another instance's operation is not readable here");
  } finally { w.cleanup(); }
});

// ------------------------------- overview / deployment -------------------------------

test("overview: systemd view with computed uptime, AnxRP health, players, listeners, deployment and history", async () => {
  const w = makeWorld();
  try {
    const service = w.service();
    const view = await service.overview(w.config());
    assert.equal(view.unit, UNIT);
    assert.equal(view.systemd.mainPid, 4242);
    assert.equal(view.systemd.uptimeSeconds, 3600, "uptime is computed from the unit's start time and the Agent clock");
    assert.equal(view.anxrp.bootId, "boot-1");
    assert.equal(view.players.count, 0);
    assert.equal(view.listeners.allListening, true);
    assert.equal(view.safeRestart.available, true);
    assert.equal(view.deployment.declared, false, "no manifest means provenance is not declared");
    assert.ok(Array.isArray(view.recentOperations));
    w.flags = { describeThrows: true };
    assert.equal((await service.overview(w.config())).systemd.error, "SERVICE_QUERY_FAILED", "an unreadable service is reported, not hidden");
    const bare = await service.overview({ ...w.config(), serviceManager: { kind: "systemd", unit: UNIT } });
    assert.equal(bare.safeRestart.available, false);
    assert.match(bare.safeRestart.reason, /health, players, listeners/);
  } finally { w.cleanup(); }
});

test("deployment manifest: unofficial builds are flagged, and nothing is trusted blindly", async () => {
  const w = makeWorld();
  try {
    const service = w.service();
    const config = w.config();
    const sha = "a".repeat(64);
    const manifest = (agentBuild, extra = {}) => JSON.stringify({ schema: 1, agentBuild, rollback: { artifact: { name: "AnxOS-Agent-2.0-build205.deb", path: "/var/tmp/x.deb", sha256: sha }, backup: { dir: "/var/backups/x", createdAt: "2026-10-07T22:20:31Z" } }, notes: ["a note"], ...extra });

    w.deployment = manifest({ origin: "local-unofficial", artifactVersion: "2.0-build206", sha256: sha, builtFromCommit: "cc862de", note: "temporary" });
    let view = (await service.overview(config)).deployment;
    assert.deepEqual([view.declared, view.unofficial, view.origin, view.matchesRunningAgent], [true, true, "local-unofficial", true]);
    assert.equal(view.agentBuild.builtFromCommit, "cc862de");
    assert.equal(view.rollback.artifact.sha256, sha);

    w.deployment = manifest({ origin: "official", artifactVersion: "2.0-build206" });
    view = (await service.overview(config)).deployment;
    assert.deepEqual([view.unofficial, view.origin], [false, "official"]);

    for (const origin of ["Official", "official ", "", "totally-official", undefined, 5]) {
      w.deployment = manifest({ origin, artifactVersion: "2.0-build206" });
      view = (await service.overview(config)).deployment;
      assert.equal(view.unofficial, true, `origin ${JSON.stringify(origin)} must not read as official`);
    }
    w.deployment = manifest({ origin: "official", artifactVersion: "2.0-build205" });
    assert.equal((await service.overview(config)).deployment.matchesRunningAgent, false, "a manifest for another build is flagged");

    w.deployment = manifest({ origin: "local-unofficial", artifactVersion: "2.0-build206", sha256: "not-a-hash" });
    assert.equal((await service.overview(config)).deployment.agentBuild.sha256, null, "malformed hashes are dropped");
    for (const broken of ["{nope", JSON.stringify({ schema: 2 }), JSON.stringify([1, 2]), "null"]) {
      w.deployment = broken;
      const bad = (await service.overview(config)).deployment;
      assert.deepEqual([bad.declared, bad.error], [false, "DEPLOYMENT_FILE_INVALID"], broken);
    }
    w.deployment = manifest({ origin: "official", artifactVersion: "2.0-build206" });
    w.statPaths = { "/var/tmp/x.deb": "denied", "/var/backups/x": "missing" };
    view = (await service.overview(config)).deployment;
    assert.deepEqual([view.rollback.artifact.state, view.rollback.backup.state], ["unverifiable", "missing"], "an unreadable path is not reported as present or gone");
    w.statPaths = {};
    assert.equal((await service.overview(config)).deployment.rollback.artifact.state, "present");
    w.deployment = JSON.stringify({ schema: 1, agentBuild: { origin: "official", note: "x".repeat(5000) } });
    assert.ok((await service.overview(config)).deployment.agentBuild.note.length <= 500, "strings are bounded");
  } finally { w.cleanup(); }
});

test("lifecycle audit: plain start/stop/restart are recorded, and an unwritable log never blocks them", async () => {
  const w = makeWorld();
  try {
    const service = w.service();
    const config = w.config();
    await service.recordLifecycle(config, "restart", "succeeded", { pre: { mainPid: 1 }, post: { mainPid: 2 } });
    await service.recordLifecycle(config, "stop", "failed", { error: "SERVICE_CONTROL_DENIED" });
    const list = await service.readHistory(config, { limit: 5 });
    assert.deepEqual(list.map((entry) => [entry.kind, entry.outcome]).sort(), [["restart", "succeeded"], ["stop", "failed"]]);
    w.flags = { historyBroken: true };
    await service.recordLifecycle(config, "start", "succeeded", {});
  } finally { w.cleanup(); }
});

test("static: the operations module never spawns a process, runs a shell or opens a non-loopback socket", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "instances", "serviceManagedOperations.js"), "utf8");
  assert.ok(!/child_process|\bspawn\b|execFile|execSync|\bexec\(|shell:\s*true|require\("net"\)|https?:\/\/(?!127\.0\.0\.1|localhost|\[::1\])/.test(source.replace(/\/\/.*$/gm, "")), "no process, shell or external network access");
  assert.ok(source.includes("LOOPBACK_HOSTS"), "player endpoints are restricted to loopback");
});
