#!/usr/bin/env node
// Regression smoke for the Agent action route POST /api/v1/actions/docker.*.
//
// Until Phase 8 maintenance the Docker action runner passed the record returned
// by resolveDockerExecutable() ({ executablePath, found, checks }) to execFile
// as the command, so every docker.start/stop/restart action failed with
// ERR_INVALID_ARG_TYPE. This smoke drives the real route handler
// (handleActionInvoke) with Docker's process execution faked, so it runs on any
// host and never touches a real container:
//   A1 start/stop/restart run "<docker path> <command> <container>" with the
//      path string the Docker service resolves, bracketed by inspects
//   A2 unknown actions and not-implemented actions are refused without
//      running Docker
//   A3 the action permission (docker:write) is enforced
//   A4 a missing or invalid container target and a bad JSON body are refused
//      before Docker runs
//   A5 a missing Docker executable is DOCKER_NOT_INSTALLED (503)
//   A6 an unknown container is CONTAINER_NOT_FOUND (404) and a failed Docker
//      command is DOCKER_ACTION_FAILED (502)
//   A7 the real executable lookup used by the runner returns a string
"use strict";

const assert = require("assert");
const childProcess = require("child_process");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const dockerService = require(path.join(rootDir, "src", "shared", "dockerService.js"));

// Delegating fakes, installed before the action runner is loaded (it binds
// execFile and the executable lookup at require time).
const realExecFile = childProcess.execFile;
const realGetExecutable = dockerService.getDockerExecutableOrThrow;
let execCalls = [];
let execBehaviour = () => ({ error: null, stdout: "", stderr: "" });
let executableBehaviour = () => realGetExecutable();

childProcess.execFile = function fakeExecFile(command, args, options, callback) {
  execCalls.push({ command, args: [...args] });
  const outcome = execBehaviour(command, args);
  setImmediate(() => callback(outcome.error, outcome.stdout || "", outcome.stderr || ""));
  return { pid: 0 };
};
dockerService.getDockerExecutableOrThrow = (...args) => executableBehaviour(...args);

const { handleActionInvoke } = require(path.join(rootDir, "agent", "src", "routes", "actions.js"));

function inspectJson(name, state) {
  return JSON.stringify([{ Id: `id-${name}`, Name: `/${name}`, State: { Status: state } }]);
}

function happyDocker() {
  let state = "exited";
  return (command, args) => {
    if (args[0] === "container" && args[1] === "inspect") return { error: null, stdout: inspectJson(args[2], state) };
    if (args[0] === "start" || args[0] === "restart") state = "running";
    if (args[0] === "stop") state = "exited";
    return { error: null, stdout: args[1] };
  };
}

async function invoke(actionId, body) {
  const request = {
    method: "POST",
    headers: { "user-agent": "agent-docker-actions-smoke" },
    socket: { remoteAddress: "127.0.0.1" },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  };
  const url = new URL(`http://127.0.0.1:47131/api/v1/actions/${encodeURIComponent(actionId)}`);
  return handleActionInvoke(request, url);
}

async function main() {
  const permissionsBefore = process.env.AGENT_ACTION_PERMISSIONS;
  const consoleInfo = console.info;
  console.info = () => {}; // audit lines are expected; keep the output readable
  try {
    delete process.env.AGENT_ACTION_PERMISSIONS;

    // A1
    const resolved = await realGetExecutable().catch(() => "docker");
    executableBehaviour = () => realGetExecutable().catch(() => "docker");
    for (const [actionId, command, after] of [["docker.start", "start", "running"], ["docker.stop", "stop", "exited"], ["docker.restart", "restart", "running"]]) {
      execCalls = [];
      execBehaviour = happyDocker();
      const response = await invoke(actionId, { target: { container: "anxos-smoke_1.test" } });
      assert.strictEqual(response.statusCode, 200, `${actionId} must complete (got ${JSON.stringify(response.body)})`);
      assert.strictEqual(response.body.status, "completed");
      assert.strictEqual(response.body.result.command, `docker ${command}`);
      assert.strictEqual(response.body.result.after.state, after);
      assert.deepStrictEqual(execCalls.map((call) => call.args), [
        ["container", "inspect", "anxos-smoke_1.test"],
        [command, "anxos-smoke_1.test"],
        ["container", "inspect", "anxos-smoke_1.test"],
      ], `${actionId} runs inspect, the command, inspect`);
      for (const call of execCalls) {
        assert.strictEqual(typeof call.command, "string", "execFile must receive the executable path as a string");
        assert.strictEqual(call.command, resolved, "the command is the path the Docker service resolves");
      }
    }
    console.log(`PASS A1 docker.start/stop/restart run "${resolved} <command> <container>"`);

    // A2
    execCalls = [];
    const unknown = await invoke("docker.remove", { target: { container: "x" } });
    assert.strictEqual(unknown.statusCode, 404);
    assert.strictEqual(unknown.body.error.code, "ACTION_NOT_FOUND");
    process.env.AGENT_ACTION_PERMISSIONS = "*";
    const notImplemented = await invoke("amp.start", { target: { container: "x" } });
    assert.strictEqual(notImplemented.statusCode, 501);
    assert.strictEqual(notImplemented.body.error.code, "NOT_IMPLEMENTED");
    delete process.env.AGENT_ACTION_PERMISSIONS;
    assert.strictEqual(execCalls.length, 0, "refused actions never run Docker");
    console.log("PASS A2 unknown (404) and not-implemented (501) actions are refused without running Docker");

    // A3
    process.env.AGENT_ACTION_PERMISSIONS = "amp:write";
    const denied = await invoke("docker.start", { target: { container: "anxos-smoke" } });
    assert.strictEqual(denied.statusCode, 403);
    assert.strictEqual(denied.body.error.code, "ACTION_PERMISSION_DENIED");
    delete process.env.AGENT_ACTION_PERMISSIONS;
    assert.strictEqual(execCalls.length, 0, "a denied action never runs Docker");
    console.log("PASS A3 without docker:write the action is denied (403) and Docker is not run");

    // A4
    for (const [body, code] of [
      [{ target: { container: "bad;rm -rf /" } }, "INVALID_CONTAINER_TARGET"],
      [{ target: { container: "-v" } }, "INVALID_CONTAINER_TARGET"],
      [{ target: {} }, "CONTAINER_TARGET_REQUIRED"],
      [{ container: "legacy-shape" }, "CONTAINER_TARGET_REQUIRED"],
      ["{not json", "INVALID_ACTION_BODY"],
    ]) {
      const response = await invoke("docker.stop", body);
      assert.strictEqual(response.statusCode, 400, `${JSON.stringify(body)} must be refused`);
      assert.strictEqual(response.body.error.code, code);
    }
    assert.strictEqual(execCalls.length, 0, "an invalid target never reaches Docker");
    console.log("PASS A4 invalid, missing and option-like targets and bad JSON are refused (400) before Docker runs");

    // A5
    executableBehaviour = async () => {
      throw Object.assign(new Error("Docker is not installed or is not available on PATH for this node."), { code: "DOCKER_NOT_INSTALLED", statusCode: 503 });
    };
    const missing = await invoke("docker.start", { target: { container: "anxos-smoke" } });
    assert.strictEqual(missing.statusCode, 503);
    assert.strictEqual(missing.body.error.code, "DOCKER_NOT_INSTALLED");
    assert.strictEqual(execCalls.length, 0);
    executableBehaviour = () => realGetExecutable().catch(() => "docker");
    console.log("PASS A5 a missing Docker executable is DOCKER_NOT_INSTALLED (503)");

    // A6
    execBehaviour = () => ({ error: Object.assign(new Error("exit 1"), { code: 1 }), stderr: "Error: No such container: ghost" });
    const ghost = await invoke("docker.start", { target: { container: "ghost" } });
    assert.strictEqual(ghost.statusCode, 404);
    assert.strictEqual(ghost.body.error.code, "CONTAINER_NOT_FOUND");
    execBehaviour = (command, args) => (args[1] === "inspect"
      ? { error: null, stdout: inspectJson(args[2], "exited") }
      : { error: Object.assign(new Error("exit 1"), { code: 1 }), stderr: "daemon error" });
    const failed = await invoke("docker.start", { target: { container: "stuck" } });
    assert.strictEqual(failed.statusCode, 502);
    assert.strictEqual(failed.body.error.code, "DOCKER_ACTION_FAILED");
    console.log("PASS A6 unknown container is CONTAINER_NOT_FOUND (404); a failed command is DOCKER_ACTION_FAILED (502)");

    // A7
    try {
      const value = await realGetExecutable();
      assert.strictEqual(typeof value, "string", "getDockerExecutableOrThrow returns the path string");
      assert.ok(value.length > 0);
    } catch (error) {
      assert.strictEqual(error.code, "DOCKER_NOT_INSTALLED", `the lookup may only fail as DOCKER_NOT_INSTALLED (got ${error.code})`);
    }
    console.log("PASS A7 the real executable lookup returns a path string (or DOCKER_NOT_INSTALLED)");
  } finally {
    console.info = consoleInfo;
    childProcess.execFile = realExecFile;
    dockerService.getDockerExecutableOrThrow = realGetExecutable;
    if (permissionsBefore === undefined) delete process.env.AGENT_ACTION_PERMISSIONS;
    else process.env.AGENT_ACTION_PERMISSIONS = permissionsBefore;
  }
  console.log("Agent Docker actions smoke: 7 checks passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
