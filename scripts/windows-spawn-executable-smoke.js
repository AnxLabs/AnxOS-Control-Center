#!/usr/bin/env node
"use strict";

// Build 214: a server whose program is named without a folder ("PalServer.exe")
// must start on Windows. Windows does not look in a new process's working
// directory, so the Agent starts the file in the server folder by full path.
//   W1 a program file in the working directory is started by its full path
//   W2 system programs, absolute paths and missing files are left alone
//   W3 a name that points outside the working directory is left alone
//   W4 other platforms are unchanged
//   W5 (Windows only) the real spawn fails for the bare name and works for
//      the resolved path
//   U1 a UDP port another socket holds counts as held (UDP-only game servers
//      become ready); a free port does not; a bind error other than "busy"
//      is never readiness
// Run: node scripts/windows-spawn-executable-smoke.js

const assert = require("assert");
const childProcess = require("child_process");
const dgram = require("dgram");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-spawn-executable-");
const core = require("../src/shared/instances/instanceServiceCore");
const resolve = core._test.resolveSpawnExecutable;

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anx-spawn-exe-"));
const serverDir = path.join(root, "server");
fs.mkdirSync(path.join(serverDir, "bin"), { recursive: true });
fs.writeFileSync(path.join(serverDir, "GameServer.exe"), "");
fs.writeFileSync(path.join(serverDir, "bin", "Nested.exe"), "");
fs.writeFileSync(path.join(root, "Outside.exe"), "");

function spawnResult(executable) {
  return new Promise((resolveResult) => {
    let child;
    try {
      child = childProcess.spawn(executable, ["/?"], { cwd: serverDir, shell: false, stdio: "ignore", windowsHide: true });
    } catch (error) {
      resolveResult({ error: error.code });
      return;
    }
    child.once("error", (error) => resolveResult({ error: error.code }));
    child.once("exit", (code) => resolveResult({ code }));
  });
}

async function main() {
  // W1
  assert.strictEqual(resolve("GameServer.exe", serverDir, "win32"), path.join(serverDir, "GameServer.exe"));
  assert.strictEqual(resolve("bin/Nested.exe", serverDir, "win32"), path.join(serverDir, "bin", "Nested.exe"));
  console.log("PASS W1 a program in the server folder is started by its full path");

  // W2
  for (const name of ["java", "cmd.exe", "bash", "Missing.exe", ""]) {
    assert.strictEqual(resolve(name, serverDir, "win32"), name, `${name || "(empty)"} is left for the system to find`);
  }
  const absolute = path.join(root, "Outside.exe");
  assert.strictEqual(resolve(absolute, serverDir, "win32"), absolute, "an absolute path is unchanged");
  assert.strictEqual(resolve("bin", serverDir, "win32"), "bin", "a folder is not a program");
  assert.strictEqual(resolve("GameServer.exe", "", "win32"), "GameServer.exe", "no working directory, no change");
  console.log("PASS W2 system programs, absolute paths and missing files are left alone");

  // W3
  assert.strictEqual(resolve("../Outside.exe", serverDir, "win32"), "../Outside.exe");
  console.log("PASS W3 a name pointing outside the server folder is left alone");

  // W4
  assert.strictEqual(resolve("GameServer.exe", serverDir, "linux"), "GameServer.exe");
  assert.strictEqual(resolve("GameServer.exe", serverDir, "darwin"), "GameServer.exe");
  console.log("PASS W4 other platforms are unchanged");

  // W5
  if (process.platform === "win32") {
    fs.copyFileSync(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe"), path.join(serverDir, "AnxSpawnProbe.exe"));
    assert.deepStrictEqual(await spawnResult("AnxSpawnProbe.exe"), { error: "ENOENT" }, "Windows does not find a bare name in the working directory");
    assert.deepStrictEqual(await spawnResult(resolve("AnxSpawnProbe.exe", serverDir)), { code: 0 }, "the resolved path starts");
    console.log("PASS W5 the real Windows spawn needs the resolved path");
  } else {
    console.log("SKIP W5 real spawn check runs on Windows only");
  }
  // U1
  const checkUdpPortHeld = core._test.checkUdpPortHeld;
  const holder = dgram.createSocket("udp4");
  await new Promise((done) => holder.bind(0, "0.0.0.0", done));
  const heldPort = holder.address().port;
  assert.deepStrictEqual(await checkUdpPortHeld(heldPort), { port: heldPort, held: true }, "a held UDP port is reported");
  holder.close();
  await new Promise((done) => setTimeout(done, 100));
  assert.deepStrictEqual(await checkUdpPortHeld(heldPort), { port: heldPort, held: false }, "a released port is free");
  const failing = () => { const socket = new (require("events"))(); socket.bind = () => setImmediate(() => socket.emit("error", Object.assign(new Error("denied"), { code: "EACCES" }))); socket.close = () => {}; return socket; };
  assert.strictEqual((await checkUdpPortHeld(80, failing)).held, false, "a permission error is not readiness");
  assert.strictEqual((await checkUdpPortHeld(80, () => { throw new Error("no sockets"); })).held, false);
  const source = fs.readFileSync(path.join(__dirname, "..", "src", "shared", "instances", "instanceServiceCore.js"), "utf8");
  assert.ok(/open \|\| \(child\.exitCode === null && \(await checkUdpPortHeld\(readinessPort\)\)\.held\)/.test(source), "the start readiness check falls back to the UDP check while the process runs");
  console.log("PASS U1 a held UDP port is readiness; anything else is not");
  console.log("Windows spawn executable smoke passed.");
}

main()
  .catch((error) => { console.error(error?.stack || error); process.exitCode = 1; })
  .finally(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} setImmediate(() => process.exit(process.exitCode || 0)); });
