#!/usr/bin/env node
"use strict";

// AnxNet measurements (not part of validation; run by hand). The owner and
// a member run as two separate OS processes on this computer; this process
// plays the game client and server. Everything is loopback, so the numbers
// show AnxNet's own overhead (TLS, multiplexing, an extra hop through two
// node processes), not real network latency.
//   connect:    member asks for a peer session (TLS 1.3 handshake + hello)
//   round trip: 500 one-byte ping-pongs, AnxNet forward vs direct loopback
//   throughput: 64 MB one way, AnxNet forward vs direct loopback
//   UDP:        200 datagram round trips through the multiplexer
//   idle cost:  CPU time and memory of each node over 10 s with no traffic
// Run: node scripts/anxnet-perf.js

const { fork } = require("child_process");
const dgram = require("dgram");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

if (process.argv[2] === "--child") {
  const { AnxNetNode } = require("../src/anxnet/node");
  const node = new AnxNetNode({ dataDir: process.argv[3], deviceName: process.argv[4], listenHost: "127.0.0.1", dnsPort: 0 });
  const handlers = {
    start: () => node.start(),
    create: () => node.createNetwork({ name: "anx-perf10" }),
    invite: () => node.createInvite({ preApproved: true }),
    join: (code) => node.joinNetwork(code),
    share: (input) => node.shareService(input),
    status: () => node.status(),
    connect: async (deviceId) => { const started = process.hrtime.bigint(); const peer = await node.ensurePeer(deviceId); return { ms: Number(process.hrtime.bigint() - started) / 1e6, path: peer.path }; },
    usage: () => ({ cpu: process.cpuUsage(), rss: process.memoryUsage().rss, heap: process.memoryUsage().heapUsed }),
    stop: () => node.stop(),
  };
  process.on("message", async ({ id, command, argument }) => {
    try { process.send({ id, result: await handlers[command](argument) }); } catch (error) { process.send({ id, error: error.message }); }
  });
  return;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxnet-perf-"));

function child(name) {
  const proc = fork(__filename, ["--child", path.join(root, name), name], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  let next = 0;
  const pending = new Map();
  proc.on("message", ({ id, result, error }) => { const entry = pending.get(id); pending.delete(id); if (error) entry.reject(new Error(error)); else entry.resolve(result); });
  return {
    proc,
    call: (command, argument) => new Promise((resolve, reject) => { const id = ++next; pending.set(id, { resolve, reject }); proc.send({ id, command, argument }); }),
  };
}

function server(handler) {
  const srv = net.createServer(handler);
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(srv)));
}

async function pingPong(port, host, rounds) {
  const socket = net.connect(port, host);
  socket.setNoDelay(true);
  await new Promise((resolve) => socket.once("connect", resolve));
  const times = [];
  for (let index = 0; index < rounds; index += 1) {
    const started = process.hrtime.bigint();
    socket.write("x");
    await new Promise((resolve) => socket.once("data", resolve));
    times.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  socket.destroy();
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)], p95: times[Math.floor(times.length * 0.95)] };
}

async function throughput(port, host, bytes) {
  const socket = net.connect(port, host);
  await new Promise((resolve) => socket.once("connect", resolve));
  const chunk = Buffer.alloc(64 * 1024, 7);
  const started = process.hrtime.bigint();
  const done = new Promise((resolve) => socket.once("data", resolve)); // sink answers when it got everything
  let sent = 0;
  while (sent < bytes) {
    if (!socket.write(chunk)) await new Promise((resolve) => socket.once("drain", resolve));
    sent += chunk.length;
  }
  await done;
  const seconds = Number(process.hrtime.bigint() - started) / 1e9;
  socket.destroy();
  return (bytes / seconds) / (1024 * 1024);
}

async function main() {
  const BYTES = 64 * 1024 * 1024;
  const echo = await server((socket) => { socket.setNoDelay(true); socket.on("data", (data) => socket.write(data)); });
  const sink = await server((socket) => { let total = 0; socket.on("data", (data) => { total += data.length; if (total >= BYTES) socket.write("done"); }); });
  const udp = dgram.createSocket("udp4");
  udp.on("message", (message, remote) => udp.send(message, remote.port, remote.address));
  await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));

  const owner = child("owner");
  const member = child("member");
  await owner.call("start");
  await member.call("start");
  await owner.call("create");
  const { code } = await owner.call("invite");
  await member.call("join", code);
  for (let index = 0; index < 100 && (await member.call("status")).network.coordinator.state !== "connected"; index += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  await owner.call("share", { name: "echo", port: 26001, protocol: "tcp", targetHost: "127.0.0.1", targetPort: echo.address().port });
  await owner.call("share", { name: "sink", port: 26002, protocol: "tcp", targetHost: "127.0.0.1", targetPort: sink.address().port });
  await owner.call("share", { name: "voice", port: 26003, protocol: "udp", targetHost: "127.0.0.1", targetPort: udp.address().port });
  for (let index = 0; index < 100 && (await member.call("status")).forwards.length < 3; index += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  const ownerId = (await owner.call("status")).deviceId;
  const ownerAddress = (await member.call("status")).devices.find((device) => device.role === "owner").address;

  const connect = await member.call("connect", ownerId);
  const rawRtt = await pingPong(echo.address().port, "127.0.0.1", 500);
  const anxRtt = await pingPong(26001, ownerAddress, 500);
  const rawMbps = await throughput(sink.address().port, "127.0.0.1", BYTES);
  const anxMbps = await throughput(26002, ownerAddress, BYTES);

  const client = dgram.createSocket("udp4");
  await new Promise((resolve) => client.bind(0, "127.0.0.1", resolve));
  const udpTimes = [];
  for (let index = 0; index < 200; index += 1) {
    const started = process.hrtime.bigint();
    client.send(Buffer.from("u"), 26003, ownerAddress);
    await new Promise((resolve) => client.once("message", resolve));
    udpTimes.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  client.close();
  udpTimes.sort((a, b) => a - b);

  const before = { owner: await owner.call("usage"), member: await member.call("usage") };
  await new Promise((resolve) => setTimeout(resolve, 10000));
  const after = { owner: await owner.call("usage"), member: await member.call("usage") };
  const idle = (who) => ({
    cpuPercent: (((after[who].cpu.user + after[who].cpu.system) - (before[who].cpu.user + before[who].cpu.system)) / 1e6 / 10 * 100).toFixed(2),
    rssMb: (after[who].rss / 1048576).toFixed(1),
  });

  const report = {
    environment: `${os.type()} ${os.release()}, ${os.cpus()[0].model}, Node ${process.version}; owner and member are separate processes on one computer (loopback)`,
    connectMs: Number(connect.ms.toFixed(1)),
    roundTripMs: { direct: { median: Number(rawRtt.median.toFixed(3)), p95: Number(rawRtt.p95.toFixed(3)) }, anxnet: { median: Number(anxRtt.median.toFixed(3)), p95: Number(anxRtt.p95.toFixed(3)) } },
    throughputMBps: { direct: Number(rawMbps.toFixed(0)), anxnet: Number(anxMbps.toFixed(0)) },
    udpRoundTripMs: { median: Number(udpTimes[100].toFixed(3)), p95: Number(udpTimes[190].toFixed(3)) },
    idleOver10s: { owner: idle("owner"), member: idle("member") },
  };
  console.log(JSON.stringify(report, null, 2));
  await owner.call("stop");
  await member.call("stop");
  owner.proc.kill();
  member.proc.kill();
  echo.close();
  sink.close();
  udp.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}

main().catch((error) => { console.error(error); process.exit(1); });
