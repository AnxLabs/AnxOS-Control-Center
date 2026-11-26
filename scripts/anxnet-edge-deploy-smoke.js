#!/usr/bin/env node
"use strict";

// AnxNet Anywhere (Build 213-G), isolated: the edge exactly as it would be
// deployed on an owner's server, as its own process started from the CLI with
// an edge.json, on loopback. No public address, port or firewall is touched.
//
//   E1 edge.json checks: management ports, the edge's own port, a gateway
//      without a public address, bad keys, typos and an edge that does nothing
//      are caught before anything listens
//   E2 --check prints the firewall ports and exits without listening or
//      creating a key; a bad config exits 1 with the problems
//   E3 the CLI process, configured from the panel's "Copy edge config"
//      template, publishes a TCP and a UDP game to plain clients through the
//      gateway; the fingerprint it prints is the one the owner pins
//   E4 two members that can't reach each other connect through the same
//      process's relay
//   E5 stopping the edge process closes its public ports
const assert = require("assert");
const childProcess = require("child_process");
const crypto = require("crypto");
const dgram = require("dgram");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxnet-edge-deploy-"));
const { AnxNetNode } = require("../src/anxnet/node");
const { servicePorts } = require("./test-helpers/anxnet-ports");
// The port each test service is shared on; set at the start of main().
let svcPort = (port) => port;
const { validateEdgeConfig } = require("../src/anxnet/edgeConfig");
const identityLib = require("../src/anxnet/identity");

const CLI = path.join(__dirname, "..", "src", "anxnet", "bin", "anxnet-edge.js");
const nodes = [];
const servers = [];
const children = [];

function pass(label) { console.log(`  ok ${label}`); }

async function waitFor(check, label, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out: ${label}`);
}

async function makeNode(name, options = {}) {
  const node = new AnxNetNode({ dataDir: path.join(root, name), deviceName: name, listenHost: "127.0.0.1", dnsPort: 0, ...options });
  nodes.push(node);
  await node.start();
  return node;
}

async function join(owner, name, nodeOptions) {
  const member = await makeNode(name, nodeOptions);
  const { code } = owner.createInvite({ preApproved: true });
  await member.joinNetwork(code, { deviceName: name });
  await waitFor(() => member.status().network?.version >= owner.status().network.version && member.status().network.coordinator.state === "connected", `${name} connected`);
  return member;
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function tcpEchoServer(prefix) {
  const server = net.createServer((socket) => socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from(prefix), data]))));
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function udpEchoServer(prefix) {
  const socket = dgram.createSocket("udp4");
  socket.on("message", (message, remote) => socket.send(Buffer.concat([Buffer.from(prefix), message]), remote.port, remote.address));
  servers.push({ close: () => socket.close() });
  return new Promise((resolve) => socket.bind(0, "127.0.0.1", () => resolve(socket.address().port)));
}

function tcpRoundTrip(port, host, text, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`no TCP answer from ${host}:${port}`)); }, timeoutMs);
    socket.on("error", (cause) => { clearTimeout(timer); reject(cause); });
    socket.on("connect", () => socket.write(text));
    socket.on("data", (data) => { clearTimeout(timer); socket.end(); resolve(String(data)); });
  });
}

function udpRoundTrip(port, host, text, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => { socket.close(); reject(new Error(`no UDP answer from ${host}:${port}`)); }, timeoutMs);
    socket.on("message", (data) => { clearTimeout(timer); socket.close(); resolve(String(data)); });
    socket.send(Buffer.from(text), port, host);
  });
}

function runCli(configFile, args = []) {
  return childProcess.spawnSync(process.execPath, [CLI, "--config", configFile, ...args], { encoding: "utf8", timeout: 20000 });
}

function startCli(configFile) {
  const child = childProcess.spawn(process.execPath, [CLI, "--config", configFile], { stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  return {
    child,
    output: () => output,
    ready: () => waitFor(() => /Fingerprint \(add this in AnxOS\): (SHA256:\S+)/.test(output) || child.exitCode !== null, "edge process ready", 15000)
      .then(() => {
        const match = output.match(/Fingerprint \(add this in AnxOS\): (SHA256:\S+)/);
        if (!match) throw new Error(`edge process did not start:\n${output}`);
        return match[1];
      }),
  };
}

// The same shape the AnxNet panel's "Copy edge config" produces
// (src/renderer/anxnetPanel.js edgeConfigTemplate).
function panelTemplate(network) {
  return {
    dataDir: "/var/lib/anxnet-edge",
    listenHost: "0.0.0.0",
    port: 47700,
    networks: [{ networkId: network.networkId, ownerPublicKey: network.ownerPublicKey }],
    relay: { enabled: true },
    gateway: { enabled: false, publicHost: "", portRange: [30000, 30099] },
  };
}

async function main() {
  // Windows can reserve the usual block after a restart; use one that opens.
  svcPort = await servicePorts(25620, 3);
  if (svcPort.base !== 25620) console.log(`service ports moved to ${svcPort.base}+ (the usual block is reserved on this computer)`);
  console.log("AnxNet edge deployment smoke (isolated, loopback)");
  const ownerKey = identityLib.createIdentity().publicKeyBase64;
  const networkId = `net-${"a".repeat(26)}`;
  const base = { dataDir: path.join(root, "edge-data"), port: 47700, networks: [{ networkId, ownerPublicKey: ownerKey }], relay: { enabled: true } };

  // E1
  assert.strictEqual(validateEdgeConfig(base).ok, true, "a relay-only edge is valid");
  const errorsOf = (config) => validateEdgeConfig(config).errors.join(" | ");
  assert.match(errorsOf({ ...base, gateway: { enabled: true, publicHost: "203.0.113.10", portRange: [47100, 47200] } }), /47131 \(the AnxOS Agent\)/);
  assert.match(errorsOf({ ...base, gateway: { enabled: true, publicHost: "203.0.113.10", portRange: [20, 30] } }), /1024 or above/);
  assert.match(errorsOf({ ...base, gateway: { enabled: true, publicHost: "203.0.113.10", portRange: [47690, 47710] } }), /edge's own port 47700/);
  assert.match(errorsOf({ ...base, gateway: { enabled: true, portRange: [30000, 30099] } }), /publicHost is required/);
  assert.match(errorsOf({ ...base, gateway: { enabled: true, publicHost: "203.0.113.10", portRange: [30000, 40000] } }), /at most 1000 ports/);
  assert.match(errorsOf({ ...base, port: 22 }), /SSH/);
  assert.match(errorsOf({ ...base, networks: [{ networkId, ownerPublicKey: "bm90IGEga2V5" }] }), /not a public key/);
  assert.match(errorsOf({ ...base, networks: [{ networkId: "home", ownerPublicKey: ownerKey }] }), /not an AnxNet network id/);
  assert.match(errorsOf({ ...base, relay: { enabled: false } }), /would do nothing/);
  assert.match(errorsOf({ ...base, dataDir: "edge-data" }), /absolute path/);
  assert.match(validateEdgeConfig({ ...base, gatway: {} }).warnings.join(" "), /gatway is not a known setting/);
  assert.match(validateEdgeConfig({ ...base, gateway: { enabled: true, publicHost: "192.168.1.5", portRange: [30000, 30009] } }).warnings.join(" "), /not a public address/);
  assert.deepStrictEqual(validateEdgeConfig({ ...base, gateway: { enabled: true, publicHost: "203.0.113.10", portRange: [30000, 30099] } }).summary.firewall, ["47700/tcp (edge)", "30000-30099/tcp and /udp (gateway routes)"]);
  pass("E1 management ports, own port, missing public address, bad keys, typos and a do-nothing edge are caught");

  // E2
  const goodFile = path.join(root, "good.json");
  fs.writeFileSync(goodFile, JSON.stringify({ ...base, gateway: { enabled: true, publicHost: "203.0.113.10", portRange: [30000, 30099] } }));
  const checked = runCli(goodFile, ["--check"]);
  assert.strictEqual(checked.status, 0, checked.stderr);
  assert.match(checked.stdout, /Firewall must allow: 47700\/tcp \(edge\); 30000-30099\/tcp and \/udp/);
  assert.match(checked.stdout, /Nothing was started/);
  assert.ok(!fs.existsSync(path.join(base.dataDir, "edge.key")), "--check creates no key");
  const badFile = path.join(root, "bad.json");
  fs.writeFileSync(badFile, JSON.stringify({ ...base, gateway: { enabled: true, publicHost: "203.0.113.10", portRange: [47100, 47200] } }));
  const refused = runCli(badFile);
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /Problem: gateway\.portRange includes 47131/);
  assert.ok(!fs.existsSync(path.join(base.dataDir, "edge.key")), "a refused config starts nothing");
  pass("E2 --check reports the firewall ports and starts nothing; a bad config is refused before listening");

  // E3
  const owner = await makeNode("owner");
  await owner.createNetwork({ name: "anx-edge42", deviceName: "Desktop" });
  const network = owner.status().network;
  const edgePort = await freePort();
  const rangeStart = 46000 + crypto.randomInt(0, 90) * 10;
  const deployed = {
    ...panelTemplate(network),
    dataDir: path.join(root, "deployed-edge"),
    listenHost: "127.0.0.1",
    port: edgePort,
    gateway: { enabled: true, bindHost: "127.0.0.1", publicHost: "127.0.0.1", portRange: [rangeStart, rangeStart + 9] },
  };
  assert.deepStrictEqual(deployed.networks, [{ networkId: network.networkId, ownerPublicKey: network.ownerPublicKey }], "the template carries this network");
  const deployedFile = path.join(root, "edge.json");
  fs.writeFileSync(deployedFile, JSON.stringify(deployed, null, 2));
  const edge = startCli(deployedFile);
  const fingerprint = await edge.ready();
  assert.match(edge.output(), /Warning: gateway\.publicHost 127\.0\.0\.1 is not a public address/);
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(path.join(deployed.dataDir, "edge.key")).mode & 0o077, 0, "the edge key is private to its user");
  const entry = { host: "127.0.0.1", port: edgePort, fingerprint };
  await owner.setEdges({ relays: [entry], gateways: [entry] });
  const gameTcp = await tcpEchoServer("mc:");
  const gameUdp = await udpEchoServer("bedrock:");
  const tcpGame = await owner.shareService({ name: "Minecraft Java", port: svcPort(25620), protocol: "tcp", targetHost: "127.0.0.1", targetPort: gameTcp });
  const udpGame = await owner.shareService({ name: "Minecraft Bedrock", port: svcPort(25621), protocol: "udp", targetHost: "127.0.0.1", targetPort: gameUdp });
  const gateway = owner.doc.gateways[0];
  const tcpRoute = await owner.publish({ gateway, ...owner.signGatewayGrant({ serviceId: tcpGame.serviceId, protocol: "tcp", gatewayFingerprint: fingerprint }) });
  const udpRoute = await owner.publish({ gateway, ...owner.signGatewayGrant({ serviceId: udpGame.serviceId, protocol: "udp", gatewayFingerprint: fingerprint }) });
  assert.ok(tcpRoute.publicPort >= rangeStart && tcpRoute.publicPort <= rangeStart + 9);
  assert.strictEqual(await tcpRoundTrip(tcpRoute.publicPort, "127.0.0.1", "join"), "mc:join");
  assert.strictEqual(await udpRoundTrip(udpRoute.publicPort, "127.0.0.1", "ping"), "bedrock:ping");
  const players = await Promise.all([1, 2, 3].map((index) => tcpRoundTrip(tcpRoute.publicPort, "127.0.0.1", `p${index}`)));
  assert.deepStrictEqual(players, ["mc:p1", "mc:p2", "mc:p3"]);
  const wrongPin = { host: "127.0.0.1", port: edgePort, fingerprint: `SHA256:${"B".repeat(43)}` };
  await assert.rejects(owner.publish({ gateway: wrongPin, ...owner.signGatewayGrant({ serviceId: tcpGame.serviceId, protocol: "tcp", gatewayFingerprint: wrongPin.fingerprint }) }));
  pass(`E3 the edge process (from the panel template) published TCP ${tcpRoute.publicPort} and UDP ${udpRoute.publicPort} to plain clients; a wrong fingerprint is refused`);

  // E4
  const farC = await join(owner, "far-c", { enableForwards: false });
  const farD = await join(owner, "far-d", { directInbound: false });
  await waitFor(() => farD.status().relayLinks.some((link) => link.state === "connected") && farC.status().relayLinks.some((link) => link.state === "connected"), "relay registrations", 15000);
  const secretPort = await tcpEchoServer("relayed:");
  const relayed = await farD.shareService({ name: "Far game", port: svcPort(25622), protocol: "tcp", targetHost: "127.0.0.1", targetPort: secretPort, allow: [farC.identity.deviceId] });
  farC.options.enableForwards = true;
  await waitFor(async () => { await farC.applyRoster(); return farC.status().forwards.some((forward) => forward.serviceId === relayed.serviceId); }, "far-c forward");
  const farDAddress = farD.status().devices.find((device) => device.self).address;
  assert.strictEqual(await tcpRoundTrip(svcPort(25622), farDAddress, "hello", 15000), "relayed:hello");
  assert.strictEqual(farC.status().devices.find((device) => device.deviceId === farD.identity.deviceId).connection, "relay");
  pass("E4 two members that refuse direct connections reached each other through the edge process's relay");

  // E5
  edge.child.kill();
  await waitFor(() => edge.child.exitCode !== null || edge.child.signalCode !== null, "edge process exit");
  await waitFor(() => tcpRoundTrip(tcpRoute.publicPort, "127.0.0.1", "late", 1000).then(() => false, () => true), "public port closed", 10000);
  pass("E5 stopping the edge process closes its public game ports");
  console.log("AnxNet edge deployment smoke passed (5 checks).");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  for (const child of children) if (child.exitCode === null) child.kill();
  for (const node of nodes) await node.stop().catch(() => {});
  for (const server of servers) try { server.close(); } catch {}
  setTimeout(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} process.exit(process.exitCode || 0); }, 300);
});
