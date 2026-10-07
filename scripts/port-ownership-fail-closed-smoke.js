"use strict";

// The port-conflict check guards "never start a second copy of a running
// server". It used to fail OPEN: a socket whose owner could not be resolved
// (e.g. owned by another user) produced no row at all, an EPERM'd PID counted
// as dead, and any error in the check was swallowed as "no conflict". These
// tests pin the fail-closed behavior.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const launched = [];
for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]) {
  childProcess[name] = (...args) => {
    launched.push(`${name}:${args[0]}`);
    throw new Error(`child process launch blocked in test: ${name}`);
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-port-"));
process.env.AGENT_INSTANCE_ROOT = root;
const core = require("../src/shared/instances/instanceServiceCore");
const { findUnrelatedPortConflicts, setProcessInspectionProvider, isPidPossiblyAlive, setProcessAliveProvider } = core._test;

const generic = { id: "web", type: "custom-command", ports: [30120], primaryPort: 30120 };

function snapshot(over) {
  return async () => ({ processes: [], ports: [], unownedPorts: [], complete: true, ...over });
}

test.afterEach(() => {
  setProcessInspectionProvider(null);
  setProcessAliveProvider(null);
  launched.length = 0;
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test("a listening socket with an unresolvable owner is a conflict (the original fail-open)", async () => {
  setProcessInspectionProvider(snapshot({ unownedPorts: [{ port: 30120, protocol: "tcp", pid: null, inode: "1" }] }));
  const conflicts = await findUnrelatedPortConflicts(generic);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].port, 30120);
  assert.equal(conflicts[0].ownerUnknown, true);
  assert.equal(conflicts[0].pid, null);
});

test("UDP-only unknown owners count too", async () => {
  setProcessInspectionProvider(snapshot({ unownedPorts: [{ port: 30120, protocol: "udp", pid: null, inode: "2" }] }));
  assert.equal((await findUnrelatedPortConflicts(generic)).length, 1);
});

test("unowned sockets on other ports are not conflicts", async () => {
  setProcessInspectionProvider(snapshot({ unownedPorts: [{ port: 22, protocol: "tcp", pid: null, inode: "3" }] }));
  assert.deepEqual(await findUnrelatedPortConflicts(generic), []);
});

test("a row with no PID is a conflict, not skipped", async () => {
  setProcessInspectionProvider(snapshot({ ports: [{ port: 30120, protocol: "tcp", pid: null }] }));
  const conflicts = await findUnrelatedPortConflicts(generic);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].ownerUnknown, true);
});

test("an incomplete snapshot (cannot read the socket tables) throws instead of reporting 'no conflict'", async () => {
  setProcessInspectionProvider(snapshot({ complete: false }));
  await assert.rejects(() => findUnrelatedPortConflicts(generic), (error) => error.code === "PORT_OWNERSHIP_UNVERIFIABLE" && error.reason === "socket-table-unreadable");
});

test("an inspection that throws fails closed", async () => {
  setProcessInspectionProvider(async () => { throw Object.assign(new Error("boom"), { code: "EIO" }); });
  await assert.rejects(() => findUnrelatedPortConflicts(generic), (error) => error.code === "PORT_OWNERSHIP_UNVERIFIABLE" && error.reason === "inspection-failed");
});

test("platforms with no socket tables at all keep legacy behavior and are flagged, not failed", async () => {
  setProcessInspectionProvider(snapshot({ complete: false, unsupported: true }));
  assert.deepEqual(await findUnrelatedPortConflicts(generic), []);
});

test("a known, live, unrelated owner is still reported with its identity", async () => {
  setProcessAliveProvider((pid) => pid === 777);
  setProcessInspectionProvider(snapshot({
    processes: [{ pid: 777, name: "nginx", exe: "/usr/sbin/nginx", cwd: "/", commandLine: "nginx", args: ["nginx"] }],
    ports: [{ port: 30120, protocol: "tcp", pid: 777 }],
  }));
  const conflicts = await findUnrelatedPortConflicts(generic);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].pid, 777);
  assert.equal(conflicts[0].processName, "nginx");
  assert.ok(!conflicts[0].ownerUnknown);
});

test("positive control: the instance's own matching FiveM runtime is not a conflict", async () => {
  const fivem = { id: "fx", type: "custom-command", templateId: "fivem", ports: [30120], workingDirectory: "data" };
  fs.mkdirSync(path.join(root, "fx", "data"), { recursive: true });
  const exe = path.join(root, "fx", "data", "alpine", "opt", "cfx-server", "FXServer");
  setProcessAliveProvider((pid) => pid === 900);
  setProcessInspectionProvider(snapshot({
    processes: [{ pid: 900, name: "FXServer", exe, cwd: path.join(root, "fx", "data"), commandLine: exe, args: [exe] }],
    ports: [{ port: 30120, protocol: "tcp", pid: 900 }, { port: 30120, protocol: "udp", pid: 900 }],
  }));
  assert.deepEqual(await findUnrelatedPortConflicts(fivem), []);
});

test("EPERM means the process exists; only ESRCH means it is gone", () => {
  const original = process.kill;
  try {
    process.kill = () => { throw Object.assign(new Error("perm"), { code: "EPERM" }); };
    assert.equal(isPidPossiblyAlive(123), true, "another user's process must count as present");
    process.kill = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
    assert.equal(isPidPossiblyAlive(123), false);
    process.kill = () => true;
    assert.equal(isPidPossiblyAlive(123), true);
    assert.equal(isPidPossiblyAlive(0), false);
    assert.equal(isPidPossiblyAlive(null), false);
  } finally {
    process.kill = original;
  }
});

function writeGenericInstance(id) {
  fs.mkdirSync(path.join(root, id, "data"), { recursive: true });
  fs.mkdirSync(path.join(root, id, "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, id, "config.json"), JSON.stringify({
    id, displayName: id, type: "custom-command", schemaVersion: 2, installationState: "active",
    workingDirectory: "data", executable: "definitely-not-spawned", args: [], ports: [30120], primaryPort: 30120,
    environment: {}, autoStart: false, restartPolicy: "never", startupTimeoutMs: 15000, shutdownTimeoutMs: 10000,
  }));
}

test("start refuses on an unknown port owner and spawns nothing", async () => {
  writeGenericInstance("blind");
  setProcessInspectionProvider(snapshot({ unownedPorts: [{ port: 30120, protocol: "tcp", pid: null, inode: "9" }] }));
  await assert.rejects(() => core.startInstance("blind"), (error) => error.code === "PORT_IN_USE" && error.conflicts?.[0]?.ownerUnknown === true);
  assert.deepEqual(launched, []);
});

test("start refuses when ownership cannot be verified at all, and spawns nothing", async () => {
  writeGenericInstance("blind2");
  setProcessInspectionProvider(snapshot({ complete: false }));
  await assert.rejects(() => core.startInstance("blind2"), (error) => error.code === "PORT_OWNERSHIP_UNVERIFIABLE");
  assert.deepEqual(launched, []);
});

test("start no longer swallows a failing conflict check", async () => {
  writeGenericInstance("blind3");
  setProcessInspectionProvider(async () => { throw new Error("inspection exploded"); });
  await assert.rejects(() => core.startInstance("blind3"), (error) => error.code === "PORT_OWNERSHIP_UNVERIFIABLE");
  assert.deepEqual(launched, []);
});
