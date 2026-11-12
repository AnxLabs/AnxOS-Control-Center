#!/usr/bin/env node
"use strict";

// The AnxNet background host (src/anxnet/host.js) as a real separate,
// detached process, the way AnxOS starts it. A headless AnxNet node in this
// process is a second device. Loopback only.
//   H1 the client starts the host, hands over the key, creates a network;
//      the host's token file is 0600-style and the key never touches disk
//   H2 with every client disconnected (the window closed), the host keeps
//      serving: a device joins and reaches a shared server through it
//   H3 a second host for the same data folder refuses to start (exit 3)
//   H4 a wrong token is refused
//   H5 the host is killed hard; a new one recovers the network from disk and
//      the device reconnects on its own
//   H6 shutdown stops the host and frees its pipe; idle cost is measured
// Run: node scripts/anxnet-host-smoke.js

const assert = require("assert");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { AnxNetHostClient, HOST_SCRIPT } = require("../src/anxnet/hostClient");
const { AnxNetNode } = require("../src/anxnet/node");
const { createIdentity } = require("../src/anxnet/identity");
const { pipePathFor } = require("../src/anxnet/host");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxnet-host-smoke-"));
const hostDir = path.join(root, "host");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let device = null;
let client = null;
const echo = net.createServer((socket) => socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from("echo:"), data]))));

async function until(check, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

function roundTrip(port, host, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("no answer")); }, 5000);
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
    socket.on("connect", () => socket.write(text));
    socket.on("data", (data) => { clearTimeout(timer); socket.destroy(); resolve(String(data)); });
  });
}

function newClient() {
  return new AnxNetHostClient({ dataDir: hostDir, execPath: process.execPath, hostArgs: ["--listen-host", "127.0.0.1", "--listen-port", "0"] });
}

async function main() {
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const keyPem = createIdentity().privateKey.export({ format: "pem", type: "pkcs8" });

  // H1
  client = newClient();
  await client.connect();
  const ping = await client.call("ping");
  assert.strictEqual(ping.unlocked, false, "a fresh host waits for the key");
  await assert.rejects(client.call("status"), (error) => error.code === "ANXNET_HOST_LOCKED");
  await client.call("unlock", { keyPem });
  await client.call("createNetwork", { name: "anx-host12" });
  const hostPid = (await client.call("usage")).pid;
  assert.notStrictEqual(hostPid, process.pid, "the host is its own process");
  const files = fs.readdirSync(hostDir);
  assert.ok(!files.some((name) => /key/i.test(name)), "the device key is never written by the host");
  assert.ok(files.includes("anxnet-host.token"));
  console.log(`PASS H1 the host process (pid ${hostPid}) starts, takes the key in memory only, and creates a network`);

  // H2: disconnect every client, then use the network through the host.
  const shared = await client.call("shareService", { name: "Game", port: 26111, protocol: "tcp", targetHost: "127.0.0.1", targetPort: echo.address().port });
  const { code } = await client.call("createInvite", { preApproved: true });
  client.disconnect();
  await delay(500);
  device = new AnxNetNode({ dataDir: path.join(root, "device"), deviceName: "laptop", listenHost: "127.0.0.1", dnsPort: 0 });
  await device.start();
  await device.joinNetwork(code, { deviceName: "laptop" });
  await until(() => device.status().forwards.some((forward) => forward.serviceId === shared.serviceId), "device forward");
  const ownerAddress = device.status().devices.find((entry) => entry.role === "owner").address;
  assert.strictEqual(await roundTrip(26111, ownerAddress, "closed-window"), "echo:closed-window");
  console.log("PASS H2 with the window closed (no client connected) the host keeps serving: a device joined and reached the shared server");

  // H3
  const duplicate = spawn(process.execPath, [HOST_SCRIPT, "--data-dir", hostDir, "--listen-host", "127.0.0.1", "--listen-port", "0"], { stdio: "ignore" });
  const exitCode = await new Promise((resolve) => duplicate.on("exit", resolve));
  assert.strictEqual(exitCode, 3, "a second host for the same data folder exits");
  client = newClient();
  await client.connect();
  assert.strictEqual((await client.call("usage")).pid, hostPid, "the original host is still the one answering");
  console.log("PASS H3 a duplicate host refuses to start; the original keeps running");

  // H4
  const intruder = net.connect(pipePathFor(hostDir));
  await new Promise((resolve) => intruder.once("connect", resolve));
  intruder.write(`${JSON.stringify({ id: 1, token: "0".repeat(64), method: "status" })}\n`);
  const refused = JSON.parse(String(await new Promise((resolve) => intruder.once("data", resolve))).split("\n")[0]);
  assert.strictEqual(refused.error.code, "ANXNET_HOST_UNAUTHORIZED");
  console.log("PASS H4 a request without the right token is refused");

  // H5: hard kill, then recover.
  client.disconnect();
  if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(hostPid), "/F"], { stdio: "ignore" });
  else process.kill(hostPid, "SIGKILL");
  await until(() => device.status().network.coordinator.state !== "connected", "device notices the host died");
  const ownerPort = device.state.network.coordinator[0].port;
  client = new AnxNetHostClient({ dataDir: hostDir, execPath: process.execPath, hostArgs: ["--listen-host", "127.0.0.1", "--listen-port", String(ownerPort)] });
  await client.connect();
  await client.call("unlock", { keyPem });
  const recovered = await client.call("status");
  assert.strictEqual(recovered.network.name, "anx-host12", "the network is restored from disk");
  await until(() => device.status().network.coordinator.state === "connected", "device reconnects", 70000);
  assert.strictEqual(await roundTrip(26111, ownerAddress, "after-crash"), "echo:after-crash");
  console.log("PASS H5 after a hard kill a new host restores the network and the device reconnects by itself");

  // H6
  const before = await client.call("usage");
  await delay(10000);
  const after = await client.call("usage");
  const cpuPercent = (((after.cpu.user + after.cpu.system) - (before.cpu.user + before.cpu.system)) / 1e6 / 10) * 100;
  await client.call("shutdown");
  await delay(800);
  const stillThere = await new Promise((resolve) => { const probe = net.connect(pipePathFor(hostDir)); probe.once("connect", () => { probe.destroy(); resolve(true); }); probe.once("error", () => resolve(false)); });
  assert.strictEqual(stillThere, false, "the pipe is free after shutdown");
  console.log(`PASS H6 shutdown frees the pipe; idle host over 10 s: ${cpuPercent.toFixed(2)}% CPU, ${(after.rss / 1048576).toFixed(0)} MB memory`);
  console.log("AnxNet host smoke passed (6 checks).");
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    try { const cleanup = newClient(); if (await cleanup.tryConnect()) await cleanup.call("shutdown").catch(() => {}); cleanup.disconnect(); } catch {}
    await device?.stop().catch(() => {});
    echo.close();
    await delay(300);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch {}
    setTimeout(() => process.exit(process.exitCode || 0), 100).unref();
  });
