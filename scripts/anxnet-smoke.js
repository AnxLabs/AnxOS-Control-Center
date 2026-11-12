#!/usr/bin/env node
"use strict";

// AnxNet end to end on one machine: several independent nodes (separate
// identities and data folders) talking over real TLS, TCP and UDP sockets
// on loopback. What this proves and what it doesn't:
//   real here:      key generation, TLS 1.3 mutual authentication, the signed
//                   roster, enrollment, DNS answers, TCP/UDP forwarding,
//                   relay pairing, gateway forwarding to plain clients;
//   simulated here: separate computers (all nodes share this host) and NAT
//                   (scripts/test-helpers/udp-nat-emulator.js).
//   X1 names, certificates, roster signatures, invites, management ports
//   X2 create network, invite, pending approval, enrollment, roster sync
//   X3 private DNS answers names; TCP service reached by its AnxNet address
//   X4 UDP service through the multiplexer
//   X5 strangers and disallowed services are refused
//   X6 revocation closes sessions and blocks reconnection
//   X7 recovery after the owner's node restarts
//   X8 UDP hole punching: cone NAT works, symmetric NAT fails clearly
//   X9 relay when direct fails; relay sees only ciphertext; revoked peers cut
//   X10 public gateway: plain TCP and UDP clients reach the game, grants are
//       required, unpublishing closes the port
// Run: node scripts/anxnet-smoke.js

const assert = require("assert");
const crypto = require("crypto");
const dgram = require("dgram");
const dns = require("dns");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const tls = require("tls");

const { AnxNetNode, fileStore } = require("../src/anxnet/node");
const { AnxNetEdge } = require("../src/anxnet/edge");
const names = require("../src/anxnet/names");
const roster = require("../src/anxnet/roster");
const identityLib = require("../src/anxnet/identity");
const { buildResponse } = require("../src/anxnet/dns");
const { createNatSocketFactory } = require("./test-helpers/udp-nat-emulator");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxnet-smoke-"));
const nodes = [];
const servers = [];
let checks = 0;
const pass = (label) => { checks += 1; console.log(`PASS ${label}`); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function makeNode(name, options = {}) {
  const node = new AnxNetNode({ dataDir: path.join(root, name), deviceName: name, listenHost: "127.0.0.1", dnsPort: 0, ...options });
  nodes.push(node);
  await node.start();
  return node;
}

function tcpEchoServer(prefix = "") {
  const server = net.createServer((socket) => socket.on("data", (data) => socket.write(Buffer.concat([Buffer.from(prefix), data]))));
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function udpEchoServer(prefix = "") {
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

async function resolveWith(node, name) {
  const resolver = new dns.promises.Resolver({ timeout: 2000, tries: 1 });
  resolver.setServers([`${node.dns.host}:${node.dns.port}`]);
  return resolver.resolve4(name);
}

async function join(owner, name, options = {}) {
  const member = await makeNode(name, options.nodeOptions);
  const { code } = owner.createInvite({ preApproved: options.preApproved === true });
  const joined = await member.joinNetwork(code, { deviceName: name });
  if (joined.pendingApproval) {
    await waitFor(() => owner.status().pending.some((entry) => entry.deviceId === member.identity.deviceId), `${name} pending`);
    await owner.approveDevice(member.identity.deviceId);
  }
  await waitFor(() => member.status().network?.version >= owner.status().network.version && member.status().coordinator !== "x" && member.status().network.coordinator.state === "connected", `${name} connected`);
  return member;
}

function unitChecks() {
  // names
  const name = names.generateNetworkName();
  assert.match(name, /^anx-[a-z]+\d{2}$/);
  assert.strictEqual(names.uniqueLabel("Mini PC", ["mini-pc"]), "mini-pc-2");
  assert.strictEqual(names.toLabel("Désktop!!"), "desktop");
  assert.strictEqual(names.serviceHostname("minecraft", "mini-pc", "anx-frost72"), "minecraft.mini-pc.anx-frost72.internal");
  assert.strictEqual(names.addressForSlot(1), "127.77.0.2");
  // roster signatures
  const owner = identityLib.createIdentity();
  const other = identityLib.createIdentity();
  let signed = roster.createNetwork(owner, { ownerName: "Desktop", networkName: "anx-frost72" });
  assert.strictEqual(signed.doc.domain, "anx-frost72.internal");
  assert.strictEqual(signed.doc.devices[0].hostname, "desktop.anx-frost72.internal");
  roster.verify(signed, owner.publicKeyBase64);
  const forged = { doc: { ...signed.doc, version: 9 }, signature: other.sign(roster.canonical({ ...signed.doc, version: 9 })) };
  assert.throws(() => roster.verify(forged, owner.publicKeyBase64), (error) => error.code === "ANXNET_ROSTER_SIGNATURE");
  const tampered = { doc: { ...signed.doc, name: "anx-evil00" }, signature: signed.signature };
  assert.throws(() => roster.verify(tampered, owner.publicKeyBase64), (error) => error.code === "ANXNET_ROSTER_SIGNATURE");
  assert.throws(() => roster.verify(signed, owner.publicKeyBase64, { minVersion: 1 }), (error) => error.code === "ANXNET_ROSTER_STALE", "an old roster is never accepted again");
  assert.throws(() => roster.update(signed, other, () => {}), (error) => error.code === "ANXNET_NOT_OWNER");
  ({ signed } = roster.addDevice(signed, owner, { publicKeyBase64: other.publicKeyBase64, name: "Desktop" }));
  assert.strictEqual(signed.doc.devices[1].label, "desktop-2", "name collisions get a suffix");
  assert.throws(() => roster.addService(signed, owner, { deviceId: owner.deviceId, name: "ssh", port: 22 }), (error) => error.code === "ANXNET_SERVICE_SENSITIVE_PORT");
  assert.throws(() => roster.addService(signed, owner, { deviceId: owner.deviceId, name: "agent", port: 6566 }), (error) => error.code === "ANXNET_SERVICE_SENSITIVE_PORT");
  // invites
  let invites = [];
  const created = roster.createInvite(invites, {});
  invites = created.invites;
  assert.ok(!JSON.stringify(invites).includes(created.secret), "only the hash of an invite is stored");
  assert.strictEqual(roster.matchInvite(invites, created.secret).inviteId, created.record.inviteId);
  assert.throws(() => roster.matchInvite(invites, "a".repeat(26)), (error) => error.code === "ANXNET_INVITE_INVALID");
  created.record.uses = 1;
  assert.throws(() => roster.matchInvite(invites, created.secret), (error) => error.code === "ANXNET_INVITE_USED", "invites are single use");
  const expiring = roster.createInvite([], {});
  assert.throws(() => roster.matchInvite(expiring.invites, expiring.secret, Date.now() + 2 * 60 * 60 * 1000), (error) => error.code === "ANXNET_INVITE_EXPIRED");
  const code = roster.encodeInviteCode({ doc: signed.doc, secret: created.secret, coordinator: [{ host: "127.0.0.1", port: 1, udpPort: 2 }] });
  const decoded = roster.decodeInviteCode(code);
  assert.strictEqual(decoded.ownerFingerprint, owner.fingerprint, "the invite pins the owner key");
  assert.throws(() => roster.decodeInviteCode("hello"), (error) => error.code === "ANXNET_INVITE_FORMAT");
  // DNS packet handling
  const query = Buffer.from("abcd0100000100000000000006676f6f676c6503636f6d0000010001", "hex");
  assert.strictEqual(buildResponse(query, { domain: "anx-frost72.internal", lookup: () => "127.77.0.2" }).readUInt16BE(2) & 0xf, 5, "other domains are refused, never recursed");
  pass("X1 names, roster signatures, collisions, management ports, single-use expiring invites, DNS refusal");
}

async function main() {
  unitChecks();

  // X2
  const owner = await makeNode("desktop");
  await owner.createNetwork({ name: "anx-smoke42", deviceName: "Desktop" });
  const member = await join(owner, "mini-pc");
  const memberStatus = member.status();
  assert.strictEqual(memberStatus.network.name, "anx-smoke42");
  assert.deepStrictEqual(memberStatus.devices.map((device) => device.hostname).sort(), ["desktop.anx-smoke42.internal", "mini-pc.anx-smoke42.internal"]);
  assert.ok(JSON.parse(fs.readFileSync(path.join(root, "mini-pc", "anxnet-state.json"), "utf8")).roster, "the roster is persisted");
  pass("X2 create network, invite, owner approval, enrollment and roster sync");

  // X3
  const echoPort = await tcpEchoServer("echo:");
  const service = await owner.shareService({ name: "Minecraft", port: 25599, protocol: "tcp", targetHost: "127.0.0.1", targetPort: echoPort });
  assert.strictEqual(service.hostname, "minecraft.desktop.anx-smoke42.internal");
  await waitFor(() => member.status().forwards.some((forward) => forward.serviceId === service.serviceId), "member forward");
  const [ownerAddress] = await resolveWith(member, "desktop.anx-smoke42.internal");
  const [serviceAddress] = await resolveWith(member, service.hostname);
  assert.strictEqual(ownerAddress, "127.77.0.2");
  assert.strictEqual(serviceAddress, ownerAddress, "service names point at their host");
  await assert.rejects(resolveWith(member, "nope.anx-smoke42.internal"), (error) => error.code === "ENOTFOUND");
  assert.strictEqual(await tcpRoundTrip(25599, serviceAddress, "hello"), "echo:hello");
  const big = crypto.randomBytes(300 * 1024).toString("hex");
  const bigReply = await new Promise((resolve, reject) => {
    const socket = net.connect(25599, serviceAddress);
    let received = "";
    socket.on("data", (data) => { received += data; const body = received.replace(/echo:/g, ""); if (body.length >= big.length) { socket.end(); resolve(body); } });
    socket.on("error", reject);
    socket.on("connect", () => socket.write(big));
  });
  assert.strictEqual(bigReply, big, "large transfers arrive complete and in order");
  assert.strictEqual(member.status().devices.find((device) => device.role === "owner").connection, "direct");
  pass(`X3 private DNS resolves ${service.hostname} -> ${serviceAddress}; TCP traffic both ways, 600 KB intact, direct path`);

  // X4
  const udpPort = await udpEchoServer("udp:");
  const udpService = await owner.shareService({ name: "Voice", port: 25600, protocol: "udp", targetHost: "127.0.0.1", targetPort: udpPort });
  await waitFor(() => member.status().forwards.some((forward) => forward.serviceId === udpService.serviceId), "member udp forward");
  assert.strictEqual(await udpRoundTrip(25600, "127.77.0.2", "ping"), "udp:ping");
  pass("X4 UDP service through the encrypted multiplexer");

  // X5
  const stranger = await makeNode("stranger");
  const strangerSocket = tls.connect({ host: "127.0.0.1", port: owner.status().listening.tcpPort, ...stranger.identity.tlsOptions(), rejectUnauthorized: false, checkServerIdentity: () => undefined });
  await new Promise((resolve) => strangerSocket.once("secureConnect", resolve));
  strangerSocket.write(`${JSON.stringify({ t: "peer", networkId: owner.doc.networkId })}\n`);
  const strangerReply = JSON.parse(String(await new Promise((resolve) => strangerSocket.once("data", resolve))).split("\n")[0]);
  assert.deepStrictEqual([strangerReply.ok, strangerReply.error.code], [false, "ANXNET_NOT_MEMBER"], "a stranger's key is refused");
  const privateService = await owner.shareService({ name: "Private", port: 25601, protocol: "tcp", targetHost: "127.0.0.1", targetPort: echoPort, allow: [] });
  await delay(300);
  assert.ok(!member.status().forwards.some((forward) => forward.serviceId === privateService.serviceId), "no forward for a service this device may not use");
  await assert.rejects(resolveWith(member, privateService.hostname), (error) => error.code === "ENOTFOUND", "names of disallowed services don't resolve");
  const peer = member.peers.get(owner.identity.deviceId);
  const refused = await new Promise((resolve) => {
    const fake = new net.Socket();
    fake.write = () => true;
    fake.destroy = () => { resolve("closed"); return fake; };
    peer.streams.set(9999, fake);
    member.writeFrame(peer, 1, 9999, { serviceId: privateService.serviceId });
    setTimeout(() => resolve(peer.streams.has(9999) ? "open" : "closed"), 1500);
  });
  assert.strictEqual(refused, "closed", "the host refuses streams to a service the device may not use");
  pass("X5 strangers refused at the handshake; disallowed services get no forward, no name and no stream");

  // X6
  const live = net.connect(25599, "127.77.0.2");
  await new Promise((resolve) => live.once("connect", resolve));
  const liveClosed = new Promise((resolve) => live.once("close", resolve));
  live.on("error", () => {});
  await owner.revokeDevice(member.identity.deviceId);
  await liveClosed;
  await waitFor(() => member.status().network.coordinator.state === "removed", "member sees removal", 15000);
  await waitFor(() => member.status().forwards.length === 0, "member forwards removed");
  const revokedAttempt = await member.dial({ host: "127.0.0.1", port: owner.status().listening.tcpPort }, owner.doc.devices[0]).then(() => "connected", (error) => error.code);
  assert.strictEqual(revokedAttempt, "ANXNET_NOT_MEMBER", "a revoked device is refused even with its cached roster");
  pass("X6 revocation closes live connections, removes forwards and blocks reconnection");

  // X7
  const member2 = await join(owner, "laptop", { preApproved: true });
  const ownerPort = owner.status().listening.tcpPort;
  const ownerUdp = owner.status().listening.udpPort;
  await owner.stop();
  await waitFor(() => member2.status().network.coordinator.state === "reconnecting", "member notices the owner left");
  const restarted = new AnxNetNode({ dataDir: path.join(root, "desktop"), listenHost: "127.0.0.1", listenPort: ownerPort, udpPort: ownerUdp, dnsPort: 0 });
  nodes.push(restarted);
  await restarted.start();
  await waitFor(() => member2.status().network.coordinator.state === "connected", "member reconnects", 70000);
  assert.strictEqual(restarted.status().network.name, "anx-smoke42", "the owner's network survives a restart");
  assert.strictEqual(await tcpRoundTrip(25599, "127.77.0.2", "again"), "echo:again", "traffic flows again after recovery");
  pass("X7 the member reconnects with backoff after the owner's node restarts; state persisted");
  const ownerNode = restarted;

  // X8 hole punching through emulated NATs
  const coneA = await join(ownerNode, "cone-a", { preApproved: true, nodeOptions: { createUdpSocket: createNatSocketFactory("cone"), enableForwards: false } });
  const coneB = await join(ownerNode, "cone-b", { preApproved: true, nodeOptions: { createUdpSocket: createNatSocketFactory("cone") } });
  const udpPeer = await coneA.connectUdp(coneB.identity.deviceId);
  assert.ok(udpPeer.session, "a UDP secure session exists");
  await waitFor(() => coneB.udpSessions.has(coneA.identity.deviceId), "both sides have the UDP session");
  const udpOnB = await udpEchoServer("punched:");
  const punchedService = await coneB.shareService({ name: "Game UDP", port: 25602, protocol: "udp", targetHost: "127.0.0.1", targetPort: udpOnB, allow: [coneA.identity.deviceId] });
  coneA.options.enableForwards = true;
  await waitFor(async () => { await coneA.applyRoster(); return coneA.status().forwards.some((forward) => forward.serviceId === punchedService.serviceId); }, "cone-a forward");
  const coneBAddress = coneB.status().devices.find((device) => device.self).address;
  assert.strictEqual(await udpRoundTrip(25602, coneBAddress, "hi"), "punched:hi");
  assert.ok((coneB.udpSessions.get(coneA.identity.deviceId).received || 0) > 0, "the datagram travelled over the punched UDP channel");
  const symA = await join(ownerNode, "sym-a", { preApproved: true, nodeOptions: { createUdpSocket: createNatSocketFactory("symmetric"), enableForwards: false } });
  const symB = await join(ownerNode, "sym-b", { preApproved: true, nodeOptions: { createUdpSocket: createNatSocketFactory("symmetric"), enableForwards: false } });
  const started = Date.now();
  await assert.rejects(symA.connectUdp(symB.identity.deviceId), (error) => error.code === "ANXNET_UDP_NO_PATH");
  assert.ok(Date.now() - started < 8000, "the failure is reported within the punch timeout");
  pass(`X8 UDP hole punching: cone NAT gives an encrypted UDP path; symmetric NAT fails clearly in ${Date.now() - started} ms (emulated NAT)`);

  // X9 relay
  const relaySeen = [];
  const edge = new AnxNetEdge({ keyStore: fileStore(path.join(root, "edge", "edge.key")), listenHost: "127.0.0.1", port: 0, networks: [{ networkId: ownerNode.doc.networkId, ownerPublicKey: ownerNode.doc.owner.publicKey }], gateway: { enabled: true, bindHost: "127.0.0.1", publicHost: "127.0.0.1", portRange: [45800, 45809], hostGraceMs: 500 }, tap: (chunk) => relaySeen.push(chunk) });
  const edgeInfo = await edge.start();
  await ownerNode.setEdges({ relays: [{ host: "127.0.0.1", port: edgeInfo.port, fingerprint: edgeInfo.fingerprint }], gateways: [{ host: "127.0.0.1", port: edgeInfo.port, fingerprint: edgeInfo.fingerprint }] });
  // Two devices whose advertised addresses don't answer (as if behind NAT).
  // far-d refuses direct inbound peers ("relay only"), standing in for a
  // device that can't be reached directly; everything is on one host here.
  const farC = await join(ownerNode, "far-c", { preApproved: true, nodeOptions: { enableForwards: false } });
  const farD = await join(ownerNode, "far-d", { preApproved: true, nodeOptions: { directInbound: false } });
  await waitFor(() => farD.status().relayLinks.some((link) => link.state === "connected") && farC.status().relayLinks.some((link) => link.state === "connected"), "relay registrations", 15000);
  const secretPort = await tcpEchoServer("relayed:");
  const relayedService = await farD.shareService({ name: "Far game", port: 25603, protocol: "tcp", targetHost: "127.0.0.1", targetPort: secretPort, allow: [farC.identity.deviceId] });
  farC.options.enableForwards = true;
  await waitFor(async () => { await farC.applyRoster(); return farC.status().forwards.some((forward) => forward.serviceId === relayedService.serviceId); }, "far-c forward");
  const farDAddress = farD.status().devices.find((device) => device.self).address;
  const marker = "PLAINTEXT-MARKER-7f3a";
  const relayedReply = await tcpRoundTrip(25603, farDAddress, marker, 15000).catch((cause) => `FAILED ${cause.message} | ${JSON.stringify(farC.status().devices.find((device) => device.deviceId === farD.identity.deviceId))} | edge ${JSON.stringify(edge.status())}`);
  assert.strictEqual(relayedReply, `relayed:${marker}`);
  assert.strictEqual(farC.status().devices.find((device) => device.deviceId === farD.identity.deviceId).connection, "relay", "the path is reported as relayed");
  assert.ok(relaySeen.length > 0 && !Buffer.concat(relaySeen).includes(Buffer.from(marker)), "the relay carried only ciphertext");
  await ownerNode.revokeDevice(farC.identity.deviceId);
  await waitFor(() => edge.status().relaySessions === 0, "relay session cut after revocation", 10000);
  const viaRelayAfter = await farC.dialViaRelay(ownerNode.doc.relays[0], ownerNode.doc.devices.find((device) => device.deviceId === farD.identity.deviceId) || { deviceId: farD.identity.deviceId, publicKey: farD.identity.publicKeyBase64 }).then(() => "connected", (error) => error.code);
  assert.notStrictEqual(viaRelayAfter, "connected", "a revoked device can't use the relay");
  pass(`X9 relay connects devices that can't reach each other, sees only ciphertext, and cuts revoked devices (${viaRelayAfter})`);

  // X10 public gateway
  const gameTcp = await tcpEchoServer("mc:");
  const gameUdp = await udpEchoServer("bedrock:");
  const tcpGame = await ownerNode.shareService({ name: "Minecraft Java", port: 25610, protocol: "tcp", targetHost: "127.0.0.1", targetPort: gameTcp });
  const udpGame = await ownerNode.shareService({ name: "Minecraft Bedrock", port: 25611, protocol: "udp", targetHost: "127.0.0.1", targetPort: gameUdp });
  const gateway = ownerNode.doc.gateways[0];
  const forgedGrant = { grant: { ...ownerNode.signGatewayGrant({ serviceId: tcpGame.serviceId, protocol: "tcp", gatewayFingerprint: edgeInfo.fingerprint }).grant }, signature: farD.identity.sign("x") };
  await assert.rejects(ownerNode.publish({ gateway, ...forgedGrant }), (error) => error.code === "ANXNET_GATEWAY_GRANT", "a grant not signed by the owner is refused");
  const otherGateway = ownerNode.signGatewayGrant({ serviceId: tcpGame.serviceId, protocol: "tcp", gatewayFingerprint: "SHA256:" + "A".repeat(43) });
  await assert.rejects(ownerNode.publish({ gateway, ...otherGateway }), (error) => error.code === "ANXNET_GATEWAY_GRANT", "a grant for another gateway is refused");
  const tcpRoute = await ownerNode.publish({ gateway, ...ownerNode.signGatewayGrant({ serviceId: tcpGame.serviceId, protocol: "tcp", gatewayFingerprint: edgeInfo.fingerprint }) });
  const udpRoute = await ownerNode.publish({ gateway, ...ownerNode.signGatewayGrant({ serviceId: udpGame.serviceId, protocol: "udp", gatewayFingerprint: edgeInfo.fingerprint }) });
  assert.ok(tcpRoute.publicPort >= 45800 && tcpRoute.publicPort <= 45809, "the port comes from the gateway's allowed range");
  // Plain clients: no AnxNet involved.
  assert.strictEqual(await tcpRoundTrip(tcpRoute.publicPort, "127.0.0.1", "join"), "mc:join");
  assert.strictEqual(await udpRoundTrip(udpRoute.publicPort, "127.0.0.1", "ping"), "bedrock:ping");
  const clients = await Promise.all([1, 2, 3].map((index) => tcpRoundTrip(tcpRoute.publicPort, "127.0.0.1", `p${index}`)));
  assert.deepStrictEqual(clients, ["mc:p1", "mc:p2", "mc:p3"], "several players at once");
  await ownerNode.unpublish(tcpRoute.routeId);
  await waitFor(() => !edge.status().routes.some((route) => route.routeId === tcpRoute.routeId), "route removed");
  await assert.rejects(tcpRoundTrip(tcpRoute.publicPort, "127.0.0.1", "late", 2000), "the public port is closed after unpublishing");
  await ownerNode.unshareService(udpGame.serviceId);
  await waitFor(() => !edge.status().routes.some((route) => route.routeId === udpRoute.routeId), "UDP route removed when the service stops being shared", 10000);
  pass(`X10 gateway: plain TCP (3 at once) and UDP clients reach the game on ${tcpRoute.publicPort}/${udpRoute.publicPort}; forged and wrong-gateway grants refused; routes removed on unpublish and unshare`);

  await edge.stop();
  console.log(`AnxNet smoke passed (${checks} checks). Real sockets on one host; separate computers and NAT are simulated.`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    for (const node of nodes) await node.stop().catch(() => {});
    for (const server of servers) { try { server.close(); } catch {} }
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch {}
    setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
  });
