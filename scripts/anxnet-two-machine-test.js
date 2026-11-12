#!/usr/bin/env node
"use strict";

// AnxNet between two real machines (or this PC and a WSL / VM guest).
// Non-destructive: temporary data folders, test servers on high ports,
// nothing installed, no OS settings changed. Needs Node.js 20+ on both.
//
// Machine A (owner):
//   node scripts/anxnet-two-machine-test.js owner --listen 0.0.0.0 --advertise <A's LAN IP>
//   -> prints an invite code, then waits.
// Machine B (member):
//   node scripts/anxnet-two-machine-test.js member --invite <code> [--listen 0.0.0.0]
//
// Checks, reported by the member:
//   T1 enrollment (pre-approved test invite) and roster sync
//   T2 private names: B's AnxNet resolver answers A's hostnames
//   T3 TCP: a test server on A reached from B through AnxNet (1 MB both ways)
//   T4 UDP: a test UDP server on A reached from B
//   T5 measured round trip (median of 50) and connection type
//   T6 interruption: A drops all sessions; B reconnects and traffic resumes
//   T7 revocation: A removes B; B's access ends
// The owner side stays up until the member reports done (or Ctrl+C).
// Firewalls: A must accept inbound TCP/UDP on its AnxNet port (printed). If
// it doesn't, the member reports which step failed instead of passing.

const dgram = require("dgram");
const dns = require("dns");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { AnxNetNode } = require("../src/anxnet/node");

const args = process.argv.slice(2);
const role = args[0];
const option = (name, fallback = null) => { const index = args.indexOf(name); return index >= 0 && args[index + 1] ? args[index + 1] : fallback; };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TCP_SERVICE_PORT = 26501;
const UDP_SERVICE_PORT = 26502;

async function until(check, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await check()) return; await delay(200); }
  throw new Error(`Timed out: ${label}`);
}

async function owner() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anxnet-2m-owner-"));
  const advertise = option("--advertise");
  const node = new AnxNetNode({ dataDir, deviceName: os.hostname(), listenHost: option("--listen", "0.0.0.0"), listenPort: Number(option("--port", 47790)), udpPort: Number(option("--port", 47790)), dnsPort: 0, advertiseHosts: advertise ? [advertise] : null });
  await node.start();
  await node.createNetwork({ deviceName: os.hostname() });
  const tcp = net.createServer((socket) => socket.on("data", (data) => socket.write(data)));
  await new Promise((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  const udp = dgram.createSocket("udp4");
  udp.on("message", (message, remote) => udp.send(message, remote.port, remote.address));
  await new Promise((resolve) => udp.bind(0, "127.0.0.1", resolve));
  await node.shareService({ name: "Test TCP", port: TCP_SERVICE_PORT, protocol: "tcp", targetHost: "127.0.0.1", targetPort: tcp.address().port });
  await node.shareService({ name: "Test UDP", port: UDP_SERVICE_PORT, protocol: "udp", targetHost: "127.0.0.1", targetPort: udp.address().port });
  const { code } = node.createInvite({ preApproved: true, ttlMs: 30 * 60 * 1000 });
  const status = node.status();
  console.log(`Network ${status.network.name} (${status.network.domain}); AnxNet port TCP/UDP ${status.listening.tcpPort}/${status.listening.udpPort}`);
  console.log(`Advertised addresses: ${node.tcpEndpoints().map((entry) => entry.host).join(", ")}`);
  console.log(`\nINVITE ${code}\n`);
  node.on("peer", ({ deviceId, path: kind }) => {
    const peer = node.peers.get(deviceId);
    console.log(`Peer ${deviceId} connected (${kind}) from ${peer?.socket.remoteAddress}, ${peer?.socket.getProtocol?.()} ${peer?.socket.getCipher?.()?.name}`);
  });
  node.on("peer-message", async ({ deviceId, message }) => {
    if (message.t === "interrupt") {
      console.log("Member asked for an interruption: dropping all sessions.");
      for (const peer of node.peers.values()) peer.socket.destroy();
      for (const socket of node.coordClients.values()) socket.destroy();
    }
    if (message.t === "revoke-me") {
      console.log("Member asked to be removed: revoking, then stopping in 10 s.");
      await node.revokeDevice(deviceId).catch((error) => console.log("revoke failed", error.message));
      setTimeout(async () => { await node.stop(); tcp.close(); udp.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); }, 10000);
    }
    if (message.t === "done") { console.log("Member finished. Stopping."); setTimeout(async () => { await node.stop(); tcp.close(); udp.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); }, 500); }
  });
  process.on("SIGINT", async () => { await node.stop(); process.exit(0); });
}

async function member() {
  const code = option("--invite");
  if (!code) throw new Error("Pass --invite <code> from the owner.");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "anxnet-2m-member-"));
  const node = new AnxNetNode({ dataDir, deviceName: os.hostname(), listenHost: option("--listen", "0.0.0.0"), dnsPort: 0 });
  const results = [];
  const record = (id, ok, detail) => { results.push({ id, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${id} ${detail}`); };
  const sendControl = async (message) => { const peer = await node.ensurePeer(node.doc.owner.deviceId); node.writeFrame(peer, 7, 0, message); };
  try {
    await node.start();
    await node.joinNetwork(code, { deviceName: os.hostname() });
    await until(() => node.status().network?.coordinator?.state === "connected", "enrollment");
    await until(() => node.status().forwards.length >= 2, "service forwards");
    record("T1", true, `enrolled in ${node.status().network.name}`);

    const ownerDevice = node.status().devices.find((device) => device.role === "owner");
    const resolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
    resolver.setServers([`${node.dns.host}:${node.dns.port}`]);
    const [address] = await resolver.resolve4(ownerDevice.hostname);
    record("T2", address === ownerDevice.address, `${ownerDevice.hostname} -> ${address}`);

    const payload = Buffer.alloc(1024 * 1024, 0x5a);
    const echoed = await new Promise((resolve, reject) => {
      const socket = net.connect(TCP_SERVICE_PORT, ownerDevice.address);
      let received = 0;
      socket.on("connect", () => socket.write(payload));
      socket.on("data", (data) => { received += data.length; if (received >= payload.length) { socket.destroy(); resolve(received); } });
      socket.on("error", reject);
      setTimeout(() => { socket.destroy(); reject(new Error(`only ${received} bytes came back`)); }, 30000);
    });
    record("T3", echoed === payload.length, `1 MB through AnxNet TCP, ${echoed} bytes back`);

    const udpReply = await new Promise((resolve) => {
      const socket = dgram.createSocket("udp4");
      socket.on("message", (message) => { socket.close(); resolve(String(message)); });
      socket.send(Buffer.from("udp-check"), UDP_SERVICE_PORT, ownerDevice.address);
      setTimeout(() => { try { socket.close(); } catch {} resolve(null); }, 5000);
    });
    record("T4", udpReply === "udp-check", `UDP round trip ${udpReply ? "answered" : "timed out"}`);

    const times = [];
    for (let index = 0; index < 50; index += 1) {
      const started = process.hrtime.bigint();
      await new Promise((resolve, reject) => { const socket = net.connect(TCP_SERVICE_PORT, ownerDevice.address); socket.on("connect", () => socket.write("x")); socket.on("data", () => { socket.destroy(); resolve(); }); socket.on("error", reject); });
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    const connection = node.status().devices.find((device) => device.role === "owner").connection;
    const ownerPeer = node.peers.get(node.doc.owner.deviceId);
    const wire = ownerPeer ? `${ownerPeer.socket.getProtocol?.() || "?"} ${ownerPeer.socket.getCipher?.()?.name || "?"}, ${ownerPeer.socket.localAddress} -> ${ownerPeer.socket.remoteAddress}:${ownerPeer.socket.remotePort}` : "no peer socket";
    record("T5", true, `connect + round trip median ${times[25].toFixed(2)} ms over a ${connection} connection (${wire})`);

    await sendControl({ t: "interrupt" });
    await delay(1500);
    await until(() => node.status().network.coordinator.state === "connected", "reconnect after interruption", 90000);
    const again = await new Promise((resolve) => { const socket = net.connect(TCP_SERVICE_PORT, ownerDevice.address); socket.on("connect", () => socket.write("again")); socket.on("data", (data) => { socket.destroy(); resolve(String(data)); }); socket.on("error", () => resolve(null)); });
    record("T6", again === "again", "traffic resumed after the owner dropped every session");

    await sendControl({ t: "revoke-me" });
    await until(() => node.status().network.coordinator.state === "removed", "revocation", 20000);
    const after = await new Promise((resolve) => { const socket = net.connect(TCP_SERVICE_PORT, ownerDevice.address); socket.on("connect", () => socket.write("after")); socket.on("data", () => { socket.destroy(); resolve("answered"); }); socket.on("error", () => resolve("refused")); setTimeout(() => { socket.destroy(); resolve("no answer"); }, 4000); });
    record("T7", after !== "answered", `after removal the server is ${after === "answered" ? "still reachable (FAIL)" : "unreachable"}`);
  } catch (error) {
    record("ERROR", false, error.message);
  } finally {
    await node.stop().catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ machine: `${os.hostname()} ${os.platform()} ${os.release()}`, passed: results.filter((entry) => entry.ok).length, failed: results.filter((entry) => !entry.ok).length, results }, null, 2));
  process.exit(results.every((entry) => entry.ok) ? 0 : 1);
}

if (role === "owner") owner().catch((error) => { console.error(error.message); process.exit(1); });
else if (role === "member") member();
else { console.error("Usage: anxnet-two-machine-test.js owner|member ..."); process.exit(2); }
