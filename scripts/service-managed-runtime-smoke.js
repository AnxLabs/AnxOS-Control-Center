"use strict";

// Unit tests for the systemd controller: pure state mapping, allowlist/unit
// validation, and the EXACT argv the Agent will run (a sudoers rule pins these).

const test = require("node:test");
const assert = require("node:assert/strict");
const runtime = require("../src/shared/instances/serviceManagedRuntime");

const UNIT = "anxrp-fxserver.service";

function recorder(responder) {
  const calls = [];
  const execFile = async (file, args, options) => {
    calls.push({ file, args, options });
    return responder ? responder(file, args) : { ok: true, code: 0, stdout: "", stderr: "" };
  };
  return { calls, execFile };
}

const SHOW_ACTIVE = [
  "LoadState=loaded", "ActiveState=active", "SubState=running", "Result=success",
  "MainPID=102490", "ExecMainStatus=0", "NRestarts=0",
  "ActiveEnterTimestamp=Tue 2026-10-06 10:00:00 UTC", "UnitFileState=enabled",
].join("\n");

test("mapSystemdState covers every systemd active state and fails unknown", () => {
  const map = (over) => runtime.mapSystemdState({ loadState: "loaded", subState: "x", result: "success", ...over });
  assert.equal(map({ activeState: "active" }).stateKey, "RUNNING");
  assert.equal(map({ activeState: "reloading" }).stateKey, "RUNNING");
  assert.equal(map({ activeState: "activating", subState: "start" }).stateKey, "STARTING");
  assert.equal(map({ activeState: "activating", subState: "auto-restart" }).stateKey, "RESTARTING");
  assert.equal(map({ activeState: "deactivating" }).stateKey, "STOPPING");
  assert.equal(map({ activeState: "inactive" }).stateKey, "STOPPED");
  assert.equal(map({ activeState: "failed", result: "exit-code" }).failureReason, "PROCESS_EXITED");
  assert.equal(map({ activeState: "failed", result: "signal" }).failureReason, "PROCESS_KILLED");
  assert.equal(map({ activeState: "failed", result: "core-dump" }).failureReason, "PROCESS_KILLED");
  assert.equal(map({ activeState: "failed", result: "start-limit-hit" }).failureReason, "CRASH_LOOP");
  assert.equal(map({ activeState: "failed", result: "timeout" }).failureReason, "START_TIMEOUT");
  // Anything not positively understood is Unknown, never Stopped.
  assert.equal(map({ activeState: "maintenance" }).stateKey, "UNKNOWN");
  assert.equal(map({ activeState: null }).stateKey, "UNKNOWN");
  assert.equal(runtime.mapSystemdState({ loadState: "not-found", activeState: "inactive" }).stateKey, "UNKNOWN");
  assert.equal(runtime.mapSystemdState(null).stateKey, "UNKNOWN");
});

test("unit names: only well-formed .service names are accepted", () => {
  for (const good of ["anxrp-fxserver.service", "a.service", "my_unit@1.service", "a:b.service"]) {
    assert.equal(runtime.validateUnitName(good), good);
  }
  for (const bad of ["", "x", "x.timer", "../x.service", "a b.service", "a;rm.service", "-x.service", "a/b.service", "x.service\n--now", "a$(id).service", `${"a".repeat(120)}.service`]) {
    assert.throws(() => runtime.validateUnitName(bad), (error) => error.code === "SERVICE_UNIT_INVALID", JSON.stringify(bad));
  }
});

test("describe runs exactly 'systemctl show <unit>' with no elevation and parses it", async () => {
  const { calls, execFile } = recorder(() => ({ ok: true, code: 0, stdout: SHOW_ACTIVE, stderr: "" }));
  const controller = runtime.createSystemdController({ execFile, platform: "linux", allowlist: [UNIT], elevation: "sudo" });
  const description = await controller.describe(UNIT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/systemctl");
  assert.deepEqual(calls[0].args.slice(0, 2), ["show", UNIT]);
  assert.ok(calls[0].args.includes("--no-pager"));
  assert.ok(!calls[0].args.includes("sudo") && calls[0].file !== "/usr/bin/sudo", "reads never elevate");
  assert.equal(description.activeState, "active");
  assert.equal(description.mainPid, 102490);
  assert.equal(description.restartCount, 0);
});

test("control argv is exact: [sudo -n] systemctl <verb> <unit>, nothing else", async () => {
  for (const verb of ["start", "stop", "restart"]) {
    const sudo = recorder();
    await runtime.createSystemdController({ execFile: sudo.execFile, platform: "linux", allowlist: [UNIT], elevation: "sudo" }).control(verb, UNIT);
    assert.deepEqual([sudo.calls[0].file, ...sudo.calls[0].args], ["/usr/bin/sudo", "-n", "/usr/bin/systemctl", verb, UNIT]);

    const plain = recorder();
    await runtime.createSystemdController({ execFile: plain.execFile, platform: "linux", allowlist: [UNIT], elevation: "none" }).control(verb, UNIT);
    assert.deepEqual([plain.calls[0].file, ...plain.calls[0].args], ["/usr/bin/systemctl", verb, UNIT]);
  }
});

test("only start/stop/restart exist: dangerous verbs are refused before any exec", async () => {
  const { calls, execFile } = recorder();
  const controller = runtime.createSystemdController({ execFile, platform: "linux", allowlist: [UNIT] });
  for (const verb of ["kill", "disable", "mask", "daemon-reload", "reboot", "enable", "start --now", "isolate", ""]) {
    await assert.rejects(() => controller.control(verb, UNIT), (error) => error.code === "SERVICE_VERB_INVALID", verb);
  }
  assert.equal(calls.length, 0);
});

test("allowlist is mandatory: empty or missing allowlist grants nothing", async () => {
  const { calls, execFile } = recorder();
  for (const allowlist of [[], ["other.service"]]) {
    const controller = runtime.createSystemdController({ execFile, platform: "linux", allowlist });
    await assert.rejects(() => controller.describe(UNIT), (error) => error.code === "SERVICE_UNIT_NOT_ALLOWED");
    await assert.rejects(() => controller.control("restart", UNIT), (error) => error.code === "SERVICE_UNIT_NOT_ALLOWED");
    await assert.rejects(() => controller.readJournal(UNIT, 10), (error) => error.code === "SERVICE_UNIT_NOT_ALLOWED");
  }
  assert.equal(calls.length, 0, "a refused unit must never reach exec");
});

test("allowlist comes from AGENT_SYSTEMD_UNIT_ALLOWLIST when not injected", async () => {
  const previous = process.env.AGENT_SYSTEMD_UNIT_ALLOWLIST;
  try {
    process.env.AGENT_SYSTEMD_UNIT_ALLOWLIST = `foo.service, ${UNIT}`;
    assert.deepEqual(runtime.createSystemdController({ platform: "linux" }).summary().allowedUnits, ["foo.service", UNIT]);
    delete process.env.AGENT_SYSTEMD_UNIT_ALLOWLIST;
    assert.deepEqual(runtime.createSystemdController({ platform: "linux" }).summary().allowedUnits, []);
  } finally {
    if (previous === undefined) delete process.env.AGENT_SYSTEMD_UNIT_ALLOWLIST; else process.env.AGENT_SYSTEMD_UNIT_ALLOWLIST = previous;
  }
});

test("non-linux hosts are unsupported and never exec", async () => {
  const { calls, execFile } = recorder();
  const controller = runtime.createSystemdController({ execFile, platform: "win32", allowlist: [UNIT] });
  await assert.rejects(() => controller.describe(UNIT), (error) => error.code === "SERVICE_MANAGER_UNSUPPORTED");
  await assert.rejects(() => controller.control("start", UNIT), (error) => error.code === "SERVICE_MANAGER_UNSUPPORTED");
  assert.equal(calls.length, 0);
});

test("unknown elevation values are rejected, not passed through as a command prefix", async () => {
  const { calls, execFile } = recorder();
  const controller = runtime.createSystemdController({ execFile, platform: "linux", allowlist: [UNIT], elevation: "doas" });
  await assert.rejects(() => controller.control("start", UNIT), (error) => error.code === "SERVICE_ELEVATION_INVALID");
  assert.equal(calls.length, 0);
});

test("describe fails closed on exec failure and on unparseable output", async () => {
  const failing = recorder(() => ({ ok: false, code: 1, stdout: "", stderr: "Failed to connect to bus" }));
  await assert.rejects(
    () => runtime.createSystemdController({ execFile: failing.execFile, platform: "linux", allowlist: [UNIT] }).describe(UNIT),
    (error) => error.code === "SERVICE_QUERY_FAILED");
  const garbage = recorder(() => ({ ok: true, code: 0, stdout: "hello world", stderr: "" }));
  await assert.rejects(
    () => runtime.createSystemdController({ execFile: garbage.execFile, platform: "linux", allowlist: [UNIT] }).describe(UNIT),
    (error) => error.code === "SERVICE_QUERY_FAILED");
});

test("control maps privilege failures to SERVICE_CONTROL_DENIED and others to SERVICE_CONTROL_FAILED", async () => {
  const denied = recorder(() => ({ ok: false, code: 1, stdout: "", stderr: "sudo: a password is required" }));
  await assert.rejects(
    () => runtime.createSystemdController({ execFile: denied.execFile, platform: "linux", allowlist: [UNIT], elevation: "sudo" }).control("stop", UNIT),
    (error) => error.code === "SERVICE_CONTROL_DENIED" && error.statusCode === 403);
  const polkit = recorder(() => ({ ok: false, code: 1, stdout: "", stderr: "Failed to stop x.service: Interactive authentication required." }));
  await assert.rejects(
    () => runtime.createSystemdController({ execFile: polkit.execFile, platform: "linux", allowlist: [UNIT] }).control("stop", UNIT),
    (error) => error.code === "SERVICE_CONTROL_DENIED");
  const failed = recorder(() => ({ ok: false, code: 5, stdout: "", stderr: "Unit anxrp-fxserver.service not found." }));
  await assert.rejects(
    () => runtime.createSystemdController({ execFile: failed.execFile, platform: "linux", allowlist: [UNIT] }).control("stop", UNIT),
    (error) => error.code === "SERVICE_CONTROL_FAILED" && error.statusCode === 502);
});

test("journal read uses one fixed argv so a sudoers rule can match it verbatim", async () => {
  const lines = [
    "2026-10-06T10:00:00+0000 vps anxrp-fxserver[1]: server started",
    "garbage line without a timestamp",
  ].join("\n");
  const { calls, execFile } = recorder(() => ({ ok: true, code: 0, stdout: lines, stderr: "" }));
  const controller = runtime.createSystemdController({ execFile, platform: "linux", allowlist: [UNIT], elevation: "sudo" });
  const entries = await controller.readJournal(UNIT, 5);
  assert.deepEqual([calls[0].file, ...calls[0].args], ["/usr/bin/sudo", "-n", "/usr/bin/journalctl", "-u", UNIT, "-n", "200", "-o", "short-iso", "--no-pager", "-q"]);
  // Requested limit does not change argv.
  await controller.readJournal(UNIT, 1000);
  assert.deepEqual(calls[1].args, calls[0].args);
  assert.equal(entries[0].message, "server started");
  assert.equal(entries[0].stream, "journal");
  assert.equal(entries[1].at, null);
});

test("no shell is ever used: the default exec path never enables shell", () => {
  const source = require("node:fs").readFileSync(require.resolve("../src/shared/instances/serviceManagedRuntime.js"), "utf8");
  assert.match(source, /shell: false/);
  assert.ok(!/shell:\s*true/.test(source), "shell must never be enabled");
  // execFile (argv array, no shell) is the only child_process entry point.
  assert.ok(!/childProcess\.(exec|execSync|execFileSync|spawn|spawnSync|fork)\b/.test(source), "only childProcess.execFile is allowed");
  assert.equal((source.match(/childProcess\.execFile\b/g) || []).length, 1);
});
