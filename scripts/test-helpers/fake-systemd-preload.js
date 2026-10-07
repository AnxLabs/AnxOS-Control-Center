"use strict";

// TEST-ONLY. Loaded with `node --require` into a REAL Agent process so the Agent
// can be exercised end to end on a host with no systemd (the Windows dev box).
// It replaces only the systemd controller; every other line of the Agent, the
// HTTP server, auth, routing and the instance core, is the production code.
//
// State lives in a JSON file (FAKE_SYSTEMD_FILE) so the test driver can flip the
// "service" between states and read back exactly which control calls the Agent
// made. The Agent must never launch the workload, so every child-process launch
// from this process is recorded for the tests to inspect.

const fs = require("fs");
const path = require("path");
const childProcess = require("child_process");

const file = process.env.FAKE_SYSTEMD_FILE;
if (!file) {
  throw new Error("FAKE_SYSTEMD_FILE is required");
}

function read() {
  // The test driver rewrites this file too; retry on a torn read.
  for (let attempt = 0; ; attempt += 1) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if (attempt >= 20) throw error;
    }
  }
}

function write(value) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2));
  // Windows refuses to rename over a file the other process has open at that instant.
  for (let attempt = 0; ; attempt += 1) {
    try { fs.renameSync(temp, file); return; } catch (error) {
      if (attempt >= 50 || !/^(EPERM|EBUSY|EACCES)$/.test(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = function guarded(...args) {
    const state = read();
    state.spawnAttempts = [...(state.spawnAttempts || []), { name, command: String(args[0]) }];
    write(state);
    // The Agent legitimately spawns unrelated helpers (disk stats and so on), so
    // spawns are recorded, not refused. Tests clear the record around a lifecycle
    // call and assert nothing was launched during it. FAKE_SYSTEMD_REFUSE_SPAWNS=1
    // turns recording into a hard refusal for runs that want it.
    if (process.env.FAKE_SYSTEMD_REFUSE_SPAWNS === "1") throw new Error(`child process launch refused in test: ${name}`);
    return original.apply(this, args);
  };
}

const core = require(path.resolve(process.env.AGENT_REPO_ROOT || path.join(__dirname, "..", ".."), "src", "shared", "instances", "instanceServiceCore"));

core.configureInstanceService({
  systemdController: {
    async describe(unit) {
      const state = read();
      state.calls.push(["describe", unit]);
      write(state);
      if (state.failDescribe) {
        throw Object.assign(new Error(state.failDescribe), { code: state.failDescribe });
      }
      return { unit, ...state.unit };
    },
    async control(verb, unit) {
      const state = read();
      state.calls.push([verb, unit]);
      state.callLog = [...(state.callLog || []), { verb, unit, at: Date.now() }];
      if (verb === "start") Object.assign(state.unit, { activeState: "active", subState: "running", mainPid: 5000, result: "success" });
      if (verb === "stop") Object.assign(state.unit, { activeState: "inactive", subState: "dead", mainPid: null });
      if (verb === "restart") Object.assign(state.unit, { activeState: "active", subState: "running", mainPid: (state.unit.mainPid || 5000) + 1, restartCount: (state.unit.restartCount || 0) + 1 });
      write(state);
      return { unit, verb };
    },
    async readJournal(unit) {
      const state = read();
      state.calls.push(["journal", unit]);
      write(state);
      if (state.journalError) throw Object.assign(new Error("denied"), { code: state.journalError });
      return state.journal || [];
    },
    summary() {
      return { mechanism: "systemd", supported: true, elevation: "sudo", allowedUnits: [read().unit.unit] };
    },
  },
});
