"use strict";

// One AnxNet node per device (see docs/ANXNET_ARCHITECTURE.md).
//
// Listens on one TLS port and one UDP port. The owner's node is also the
// network's coordinator (enrollment, signed roster, endpoint registry, hole
// punch introductions). Peers talk over a multiplexer on a TLS connection
// that is direct or carried by an AnxNet relay; UDP services can also use
// the UDP secure channel once a UDP path exists. Every connection is
// authenticated: the TLS certificate's key must belong to a non-revoked
// device in the owner-signed roster.
//
// Hosting: the desktop main process (src/services/anxnetService.js),
// headless tests, and later the Agent. Nothing here changes OS routing,
// DNS settings or firewall rules.

const { EventEmitter } = require("events");
const crypto = require("crypto");
const dgram = require("dgram");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const tls = require("tls");

const identityLib = require("./identity");
const roster = require("./roster");
const { FrameReader, TYPES, chunks, encode, jsonLineReader, sendJsonLine } = require("./frames");
const secureUdp = require("./secureUdp");
const { startDnsServer } = require("./dns");

const HANDSHAKE_TIMEOUT_MS = 10000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 60000;
const PING_INTERVAL_MS = 15000;
const PEER_IDLE_CLOSE_MS = 5 * 60 * 1000;
const MAX_STREAMS_PER_PEER = 512;
const MAX_FLOWS_PER_SERVICE = 256;
const UDP_FLOW_IDLE_MS = 60000;
const PUNCH_INTERVAL_MS = 200;
const PUNCH_TIMEOUT_MS = 5000;
const MAX_PENDING = 20;

function error(code, message, statusCode = 400) {
  return roster.error(code, message, statusCode);
}

// Read one JSON line from a socket; any bytes after it go back to the socket.
function readLine(socket, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); socket.destroy(); reject(error("ANXNET_HANDSHAKE_TIMEOUT", "Timed out.", 504)); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); socket.off("data", onData); socket.off("close", onClose); };
    const onClose = () => { cleanup(); reject(error("ANXNET_CONNECTION_CLOSED", "The connection closed.", 503)); };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf(10);
      if (index < 0) { if (buffer.length > 512 * 1024) { cleanup(); socket.destroy(); reject(error("ANXNET_CONTROL_TOO_LARGE", "Control message too large.", 400)); } return; }
      cleanup();
      const rest = buffer.subarray(index + 1);
      socket.pause();
      if (rest.length) socket.unshift(rest);
      let message = null;
      try { message = JSON.parse(buffer.subarray(0, index).toString("utf8")); } catch {}
      resolve(message);
    };
    socket.on("data", onData);
    socket.on("close", onClose);
  });
}

// TLS inside TLS (end-to-end through a relay): Node would reuse the outer
// socket's native handle, so the inner TLS gets a plain stream of the outer
// connection's decrypted bytes instead.
function plainStream(socket) {
  const { Duplex } = require("stream");
  const duplex = new Duplex({
    read() { socket.resume(); },
    write(chunk, _encoding, callback) { socket.write(chunk, callback); },
    final(callback) { socket.end(); callback(); },
    destroy(cause, callback) { socket.destroy(); callback(cause); },
  });
  socket.on("data", (chunk) => { if (!duplex.push(chunk)) socket.pause(); });
  socket.on("end", () => duplex.push(null));
  socket.on("close", () => duplex.destroy());
  socket.on("error", () => duplex.destroy());
  return duplex;
}

function tlsConnect(identity, options) {
  return tls.connect({ ...options, ...identity.tlsOptions(), rejectUnauthorized: false, checkServerIdentity: () => undefined, minVersion: "TLSv1.3" });
}

function onceSecure(socket, { server = false } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => socket.destroy(error("ANXNET_HANDSHAKE_TIMEOUT", "Timed out.", 504)), HANDSHAKE_TIMEOUT_MS);
    socket.once("error", (cause) => { clearTimeout(timer); reject(cause); });
    socket.once(server ? "secure" : "secureConnect", () => { clearTimeout(timer); resolve(socket); });
  });
}

function lanAddresses() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address)
    .slice(0, 4);
}

function fileStore(file) {
  return {
    read() { try { return fs.readFileSync(file, "utf8"); } catch { return null; } },
    write(text) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, text, { mode: 0o600 });
      fs.renameSync(temp, file);
    },
  };
}

class AnxNetNode extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.dataDir) throw new Error("ANXNET_DATA_DIR_REQUIRED");
    this.options = {
      listenHost: "0.0.0.0",
      listenPort: 0,
      udpPort: 0,
      dnsHost: "127.77.0.1",
      dnsPort: 5353,
      enableDns: true,
      enableForwards: true,
      directInbound: true,
      deviceName: os.hostname(),
      advertiseHosts: null,
      ...options,
    };
    this.stateStore = options.stateStore || fileStore(path.join(options.dataDir, "anxnet-state.json"));
    this.keyStore = options.keyStore || fileStore(path.join(options.dataDir, "anxnet-device.key"));
    this.createUdpSocket = options.createUdpSocket || (() => dgram.createSocket("udp4"));
    this.state = { network: null, roster: null, invites: [], pending: [] };
    this.peers = new Map(); // deviceId -> peer session
    this.endpoints = new Map(); // coordinator: deviceId -> { tcp: [], udp, seenAt }
    this.coordClients = new Map(); // coordinator: deviceId -> control socket
    this.forwards = new Map(); // key -> listener
    this.hostFlows = new Map(); // `${peer}:${flow}` -> udp socket to target
    this.udpSessions = new Map(); // deviceId -> { session, address }
    this.pendingPunch = new Map();
    this.coordinator = { state: "idle", socket: null, attempt: 0, timer: null, message: "" };
    this.started = false;
  }

  // ---- lifecycle ---------------------------------------------------------------

  async start() {
    if (this.started) return this.status();
    this.identity = identityLib.loadOrCreateIdentity(this.keyStore);
    this.loadState();
    await this.listen();
    this.started = true;
    this.pingTimer = setInterval(() => this.pingPeers(), PING_INTERVAL_MS);
    this.pingTimer.unref?.();
    await this.applyRoster();
    if (this.state.network && !this.isOwner()) this.connectCoordinator();
    return this.status();
  }

  async stop() {
    this.started = false;
    this.closeEdgeLinks();
    clearInterval(this.pingTimer);
    clearTimeout(this.coordinator.timer);
    this.coordinator.socket?.destroy();
    this.coordinator = { state: "idle", socket: null, attempt: 0, timer: null, message: "" };
    for (const peer of this.peers.values()) peer.socket.destroy();
    this.peers.clear();
    for (const socket of this.coordClients.values()) socket.destroy();
    this.coordClients.clear();
    await this.closeForwards();
    for (const flow of this.hostFlows.values()) flow.socket.close();
    this.hostFlows.clear();
    await this.dns?.close().catch(() => {});
    this.dns = null;
    await new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    try { this.udp?.close(); } catch {}
    this.server = null;
    this.udp = null;
  }

  loadState() {
    const text = this.stateStore.read();
    if (!text) return;
    try {
      const parsed = JSON.parse(text);
      this.state = { network: parsed.network || null, roster: parsed.roster || null, invites: parsed.invites || [], pending: parsed.pending || [] };
      if (this.state.roster) roster.verify(this.state.roster, this.state.network.ownerPublicKey, { networkId: this.state.network.networkId });
    } catch (cause) {
      // A damaged or forged state file is never trusted.
      this.state = { network: null, roster: null, invites: [], pending: [] };
      this.emit("warning", { code: "ANXNET_STATE_INVALID", message: cause?.message });
    }
  }

  saveState() {
    this.stateStore.write(`${JSON.stringify(this.state, null, 2)}\n`);
  }

  listen() {
    const tlsOptions = this.identity.tlsOptions();
    this.server = tls.createServer({ ...tlsOptions, requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3" }, (socket) => this.onIncoming(socket));
    this.server.on("tlsClientError", () => {});
    this.udp = this.createUdpSocket();
    this.udp.on("message", (message, remote) => this.onUdp(message, remote));
    this.udp.on("error", () => {});
    return Promise.all([
      new Promise((resolve, reject) => { this.server.once("error", reject); this.server.listen(this.options.listenPort, this.options.listenHost, resolve); }),
      new Promise((resolve) => this.udp.bind(this.options.udpPort, this.options.listenHost === "0.0.0.0" ? undefined : this.options.listenHost, resolve)),
    ]);
  }

  get doc() {
    return this.state.roster?.doc || null;
  }

  isOwner() {
    return Boolean(this.doc && this.doc.owner.deviceId === this.identity.deviceId);
  }

  tcpEndpoints() {
    const port = this.server.address().port;
    const hosts = this.options.advertiseHosts || (this.options.listenHost === "0.0.0.0" ? lanAddresses() : [this.options.listenHost]);
    const udpPort = this.udp?.address?.()?.port || null;
    return hosts.map((host) => ({ host, port, udpPort }));
  }

  // ---- network management --------------------------------------------------------

  async createNetwork({ name, deviceName } = {}) {
    if (this.state.network) throw error("ANXNET_ALREADY_IN_NETWORK", "This device is already in an AnxNet network. Leave it first.", 409);
    const signed = roster.createNetwork(this.identity, { ownerName: deviceName || this.options.deviceName, networkName: name });
    this.state = {
      network: { networkId: signed.doc.networkId, ownerPublicKey: signed.doc.owner.publicKey, ownerFingerprint: identityLib.fingerprint(signed.doc.owner.publicKey), coordinator: this.tcpEndpoints() },
      roster: signed,
      invites: [],
      pending: [],
    };
    this.saveState();
    await this.applyRoster();
    this.emit("change");
    return this.status();
  }

  // Joining device: present the invite to the coordinator over TLS. The
  // owner key is pinned from the invite before anything is trusted.
  async joinNetwork(code, { deviceName } = {}) {
    if (this.state.network) throw error("ANXNET_ALREADY_IN_NETWORK", "This device is already in an AnxNet network. Leave it first.", 409);
    const invite = roster.decodeInviteCode(code);
    let lastError = null;
    for (const endpoint of invite.coordinator) {
      try {
        const reply = await this.request(endpoint, { t: "enroll", networkId: invite.networkId, secret: invite.secret, name: deviceName || this.options.deviceName }, { expectFingerprint: invite.ownerFingerprint });
        if (reply.error) throw error(reply.error.code, reply.error.message, 403);
        this.state = {
          network: { networkId: invite.networkId, ownerPublicKey: reply.ownerPublicKey, ownerFingerprint: invite.ownerFingerprint, coordinator: invite.coordinator },
          roster: null,
          invites: [],
          pending: [],
        };
        if (identityLib.fingerprint(reply.ownerPublicKey) !== invite.ownerFingerprint) throw error("ANXNET_OWNER_MISMATCH", "The network answered with a different owner key than the invite.", 403);
        if (reply.roster) this.acceptRoster(reply.roster);
        this.saveState();
        await this.applyRoster();
        this.connectCoordinator();
        this.emit("change");
        return { ...this.status(), pendingApproval: Boolean(reply.pending) };
      } catch (cause) {
        lastError = cause;
      }
    }
    throw lastError || error("ANXNET_COORDINATOR_UNREACHABLE", "Couldn't reach the network to join it.", 503);
  }

  async leaveNetwork() {
    const wasOwner = this.isOwner();
    this.closeEdgeLinks();
    clearTimeout(this.coordinator.timer);
    this.coordinator.socket?.destroy();
    this.coordinator = { state: "idle", socket: null, attempt: 0, timer: null, message: "" };
    for (const peer of this.peers.values()) peer.socket.destroy();
    this.peers.clear();
    for (const socket of this.coordClients.values()) socket.destroy();
    this.coordClients.clear();
    await this.closeForwards();
    await this.dns?.close().catch(() => {});
    this.dns = null;
    this.state = { network: null, roster: null, invites: [], pending: [] };
    this.saveState();
    this.emit("change");
    return { left: true, wasOwner };
  }

  requireOwner() {
    if (!this.isOwner()) throw error("ANXNET_NOT_OWNER", "Only the network owner can do this.", 403);
  }

  // Owner: change the roster, persist, and push it everywhere.
  async changeRoster(mutate) {
    this.requireOwner();
    const { signed, result } = mutate(this.state.roster);
    this.state.roster = signed;
    this.saveState();
    // Push first: a device being removed must receive the roster that removes
    // it before its connection is closed, so it knows why.
    this.pushRoster();
    await this.applyRoster();
    this.emit("change");
    return result;
  }

  createInvite(options = {}) {
    this.requireOwner();
    const { secret, invites, record } = roster.createInvite(this.state.invites, options);
    this.state.invites = invites;
    this.saveState();
    const coordinator = options.coordinator || this.state.network.coordinator || this.tcpEndpoints();
    return { code: roster.encodeInviteCode({ doc: this.doc, secret, coordinator }), invite: { ...record, hash: undefined } };
  }

  revokeInvite(inviteId) {
    this.requireOwner();
    const invite = this.state.invites.find((entry) => entry.inviteId === inviteId);
    if (!invite) throw error("ANXNET_INVITE_NOT_FOUND", "That invite doesn't exist.", 404);
    invite.revoked = true;
    this.saveState();
    return { revoked: true };
  }

  async approveDevice(deviceId) {
    this.requireOwner();
    const pending = this.state.pending.find((entry) => entry.deviceId === deviceId);
    if (!pending) throw error("ANXNET_PENDING_NOT_FOUND", "No device is waiting with that id.", 404);
    const device = await this.changeRoster((signed) => roster.addDevice(signed, this.identity, { publicKeyBase64: pending.publicKey, name: pending.name }));
    this.state.pending = this.state.pending.filter((entry) => entry.deviceId !== deviceId);
    this.saveState();
    // A waiting device that is still connected gets the roster now.
    const socket = this.coordClients.get(deviceId);
    if (socket) sendJsonLine(socket, { t: "roster", roster: this.state.roster });
    return device;
  }

  rejectDevice(deviceId) {
    this.requireOwner();
    this.state.pending = this.state.pending.filter((entry) => entry.deviceId !== deviceId);
    this.saveState();
    this.coordClients.get(deviceId)?.destroy();
    this.emit("change");
    return { rejected: true };
  }

  revokeDevice(deviceId) {
    return this.changeRoster((signed) => roster.revokeDevice(signed, this.identity, deviceId));
  }

  renameNetwork(name) {
    return this.changeRoster((signed) => roster.renameNetwork(signed, this.identity, name));
  }

  renameDevice(deviceId, name) {
    return this.changeRoster((signed) => roster.renameDevice(signed, this.identity, deviceId, name));
  }

  setEdges(edges) {
    return this.changeRoster((signed) => roster.setEdges(signed, this.identity, edges));
  }

  // Share a service hosted on this device. Members ask the owner, who checks
  // that the service really lives on the asking device.
  async shareService(input) {
    const request = { ...input, deviceId: this.identity.deviceId };
    if (this.isOwner()) return this.changeRoster((signed) => roster.addService(signed, this.identity, request));
    const reply = await this.coordinatorRequest({ t: "service-add", service: request });
    if (reply.error) throw error(reply.error.code, reply.error.message, 403);
    return reply.service;
  }

  async unshareService(serviceId) {
    const service = this.doc?.services.find((entry) => entry.serviceId === serviceId);
    if (!service) throw error("ANXNET_SERVICE_NOT_FOUND", "That shared service doesn't exist.", 404);
    if (this.isOwner()) return this.changeRoster((signed) => roster.removeService(signed, this.identity, serviceId));
    if (service.deviceId !== this.identity.deviceId) throw error("ANXNET_NOT_SERVICE_HOST", "Only the device that shares a service, or the owner, can stop sharing it.", 403);
    const reply = await this.coordinatorRequest({ t: "service-remove", serviceId });
    if (reply.error) throw error(reply.error.code, reply.error.message, 403);
    return serviceId;
  }

  // Owner-signed grant that lets a gateway publish one service on one port.
  signGatewayGrant({ serviceId, protocol, publicPort, gatewayFingerprint, ttlMs = 30 * 24 * 60 * 60 * 1000 }) {
    this.requireOwner();
    const service = this.doc.services.find((entry) => entry.serviceId === serviceId);
    if (!service) throw error("ANXNET_SERVICE_NOT_FOUND", "That shared service doesn't exist.", 404);
    const grant = {
      networkId: this.doc.networkId,
      serviceId,
      deviceId: service.deviceId,
      protocol: ["tcp", "udp"].includes(protocol) ? protocol : "tcp",
      publicPort: Number(publicPort) || 0,
      gateway: String(gatewayFingerprint || ""),
      expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      grantId: `gr-${identityLib.base32(crypto.randomBytes(8))}`,
    };
    return { grant, signature: this.identity.sign(roster.canonical(grant)) };
  }

  // ---- roster distribution --------------------------------------------------------

  acceptRoster(signed) {
    const current = this.doc?.version || 0;
    const doc = roster.verify(signed, this.state.network.ownerPublicKey, { networkId: this.state.network.networkId, minVersion: current });
    this.state.roster = signed;
    return doc;
  }

  pushRoster() {
    for (const socket of this.coordClients.values()) sendJsonLine(socket, { t: "roster", roster: this.state.roster });
    for (const link of this.edgeLinks?.values() || []) if (link.socket && !link.socket.destroyed) sendJsonLine(link.socket, { t: "roster", roster: this.state.roster });
    this.emit("roster", this.doc);
  }

  // Apply the current roster: drop sessions with devices no longer allowed,
  // refresh DNS and the local forwards.
  async applyRoster() {
    const doc = this.doc;
    for (const [deviceId, peer] of this.peers) {
      if (!doc || !roster.memberFor(doc, deviceId, peer.publicKey)) {
        peer.socket.destroy();
        this.peers.delete(deviceId);
      }
    }
    for (const [deviceId, socket] of this.coordClients) {
      const pending = this.state.pending.some((entry) => entry.deviceId === deviceId);
      if (!doc || (!roster.memberFor(doc, deviceId) && !pending)) {
        socket.destroy();
        this.coordClients.delete(deviceId);
      }
    }
    for (const [deviceId] of this.udpSessions) if (!doc || !roster.memberFor(doc, deviceId)) this.udpSessions.delete(deviceId);
    for (const [key, flow] of this.hostFlows) {
      const service = doc?.services.find((entry) => entry.serviceId === flow.serviceId);
      if (!service || !roster.serviceAllows(doc, service, flow.peerId)) { flow.socket.close(); this.hostFlows.delete(key); }
    }
    if (!doc || !roster.memberFor(doc, this.identity.deviceId)) {
      await this.closeForwards();
      await this.dns?.close().catch(() => {});
      this.dns = null;
      return;
    }
    if (this.options.enableDns) await this.ensureDns();
    if (this.options.enableForwards) await this.syncForwards();
    this.syncRelayLinks();
    for (const [routeId, route] of this.gatewayRoutes || []) {
      const service = doc.services.find((entry) => entry.serviceId === route.serviceId);
      if (!service || service.deviceId !== this.identity.deviceId) this.unpublish(routeId).catch(() => {});
    }
  }

  // ---- DNS ---------------------------------------------------------------------------

  lookupName(name) {
    const doc = this.doc;
    if (!doc) return null;
    const me = this.identity.deviceId;
    const device = doc.devices.find((entry) => entry.hostname === name && roster.memberFor(doc, entry.deviceId));
    if (device) return device.address;
    const service = doc.services.find((entry) => entry.hostname === name && roster.serviceAllows(doc, entry, me));
    if (service) return doc.devices.find((entry) => entry.deviceId === service.deviceId)?.address || null;
    return null;
  }

  // Move the resolver (for example to port 53 while OS name lookup is on).
  async setDnsEndpoint({ host = this.options.dnsHost, port = this.options.dnsPort } = {}) {
    if (!String(host).startsWith("127.")) throw error("ANXNET_DNS_LOOPBACK_ONLY", "The resolver only listens on loopback.", 400);
    this.options.dnsHost = host;
    this.options.dnsPort = Number(port);
    await this.dns?.close().catch(() => {});
    this.dns = null;
    if (this.doc && roster.memberFor(this.doc, this.identity.deviceId) && this.options.enableDns) await this.ensureDns();
    if (!this.dns) throw error("ANXNET_DNS_UNAVAILABLE", `The resolver couldn't listen on ${host}:${port}. Another program may be using it.`, 409);
    return { host: this.dns.host, port: this.dns.port };
  }

  async ensureDns() {
    const domain = this.doc.domain;
    if (this.dns) { this.dns.update({ domain, lookup: (name) => this.lookupName(name) }); return; }
    try {
      this.dns = await startDnsServer({ host: this.options.dnsHost, port: this.options.dnsPort, domain, lookup: (name) => this.lookupName(name) });
    } catch (cause) {
      this.dns = null;
      this.emit("warning", { code: "ANXNET_DNS_UNAVAILABLE", message: `Private DNS couldn't start (${cause.code || cause.message}).` });
    }
  }

  // ---- forwards (this device using others' services) -----------------------------------

  async syncForwards() {
    const doc = this.doc;
    const me = this.identity.deviceId;
    const wanted = new Map();
    for (const service of doc.services) {
      if (service.deviceId === me || !roster.serviceAllows(doc, service, me)) continue;
      const host = doc.devices.find((entry) => entry.deviceId === service.deviceId);
      if (!host) continue;
      for (const protocol of service.protocol === "both" ? ["tcp", "udp"] : [service.protocol]) {
        wanted.set(`${protocol}:${host.address}:${service.port}`, { protocol, address: host.address, service });
      }
    }
    for (const [key, forward] of this.forwards) {
      if (!wanted.has(key)) { await forward.close(); this.forwards.delete(key); }
      else forward.service = wanted.get(key).service;
    }
    for (const [key, spec] of wanted) {
      if (this.forwards.has(key)) continue;
      try {
        this.forwards.set(key, spec.protocol === "tcp" ? await this.openTcpForward(spec) : await this.openUdpForward(spec));
      } catch (cause) {
        this.emit("warning", { code: "ANXNET_FORWARD_UNAVAILABLE", message: `${spec.service.hostname}:${spec.service.port} couldn't listen locally (${cause.code || cause.message}).` });
      }
    }
  }

  async closeForwards() {
    for (const forward of this.forwards.values()) await forward.close().catch(() => {});
    this.forwards.clear();
  }

  openTcpForward(spec) {
    const sockets = new Set();
    const server = net.createServer((client) => {
      sockets.add(client);
      client.on("close", () => sockets.delete(client));
      client.pause();
      this.openStream(forward.service, client).catch((cause) => {
        this.emit("warning", { code: cause.code || "ANXNET_STREAM_FAILED", message: cause.message });
        client.destroy();
      });
    });
    const forward = {
      ...spec,
      close: () => new Promise((resolve) => { sockets.forEach((socket) => socket.destroy()); server.close(() => resolve()); }),
    };
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(spec.service.port, spec.address, () => { server.off("error", reject); resolve(forward); });
    });
  }

  openUdpForward(spec) {
    const socket = dgram.createSocket("udp4");
    const flows = new Map(); // client "ip:port" -> flowId
    const byId = new Map();
    const forward = {
      ...spec,
      flows: byId,
      deliver: (flowId, payload) => {
        const client = byId.get(flowId);
        if (client) { client.lastSeen = Date.now(); socket.send(payload, client.port, client.address); }
      },
      close: () => new Promise((resolve) => { clearInterval(sweep); socket.close(() => resolve()); }),
    };
    socket.on("message", (payload, remote) => {
      const key = `${remote.address}:${remote.port}`;
      let flowId = flows.get(key);
      if (!flowId) {
        if (flows.size >= MAX_FLOWS_PER_SERVICE) return;
        flowId = crypto.randomInt(1, 0xffffffff);
        flows.set(key, flowId);
        byId.set(flowId, { address: remote.address, port: remote.port, lastSeen: Date.now(), key });
      }
      byId.get(flowId).lastSeen = Date.now();
      this.sendDatagram(forward.service, flowId, payload).catch(() => {});
    });
    const sweep = setInterval(() => {
      const cutoff = Date.now() - UDP_FLOW_IDLE_MS;
      for (const [flowId, client] of byId) if (client.lastSeen < cutoff) { byId.delete(flowId); flows.delete(client.key); }
    }, 15000);
    sweep.unref?.();
    this.udpForwardsByService = this.udpForwardsByService || new Map();
    this.udpForwardsByService.set(spec.service.serviceId, forward);
    return new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(spec.service.port, spec.address, () => { socket.off("error", reject); resolve(forward); });
    });
  }

  async openStream(service, client) {
    const peer = await this.ensurePeer(service.deviceId);
    if (peer.streams.size >= MAX_STREAMS_PER_PEER) throw error("ANXNET_STREAM_LIMIT", "Too many open connections to that device.", 429);
    const streamId = peer.nextStreamId;
    peer.nextStreamId += 2;
    peer.streams.set(streamId, client);
    this.writeFrame(peer, TYPES.OPEN, streamId, { serviceId: service.serviceId, protocol: "tcp" });
    this.pipeLocalToPeer(peer, streamId, client);
    client.resume();
  }

  async sendDatagram(service, flowId, payload) {
    const udp = this.udpSessions.get(service.deviceId);
    const frame = encode(TYPES.DGRAM, flowId, Buffer.concat([Buffer.from(service.serviceId.padEnd(24).slice(0, 24)), payload]));
    if (udp && udp.session && !udp.session.needsRekey()) {
      this.udp.send(udp.session.seal(frame), udp.address.port, udp.address.host);
      udp.sent = (udp.sent || 0) + 1;
      return;
    }
    const peer = await this.ensurePeer(service.deviceId);
    if (peer.socket.writableLength < 512 * 1024) peer.socket.write(frame); // drop under pressure, like a network would
  }

  // ---- peers ------------------------------------------------------------------------------

  candidatesFor(deviceId) {
    const own = this.state.network?.coordinator || [];
    if (deviceId === this.doc?.owner.deviceId) return own;
    return this.endpoints.get(deviceId)?.tcp || [];
  }

  async ensurePeer(deviceId) {
    const existing = this.peers.get(deviceId);
    if (existing && !existing.socket.destroyed) return existing;
    if (this.connecting?.has(deviceId)) return this.connecting.get(deviceId);
    this.connecting = this.connecting || new Map();
    const attempt = this.connectPeer(deviceId).finally(() => this.connecting.delete(deviceId));
    this.connecting.set(deviceId, attempt);
    return attempt;
  }

  async connectPeer(deviceId) {
    const doc = this.doc;
    const device = doc && roster.memberFor(doc, deviceId);
    if (!device) throw error("ANXNET_PEER_NOT_MEMBER", "That device is not in this network.", 404);
    const failures = [];
    let candidates = this.candidatesFor(deviceId);
    if (!candidates.length && !this.isOwner()) {
      const lookup = await this.coordinatorRequest({ t: "lookup", deviceId }).catch(() => null);
      candidates = lookup?.tcp || [];
    }
    for (const endpoint of candidates) {
      try {
        const socket = await this.dial(endpoint, device);
        return this.attachPeer(socket, device, "direct", true);
      } catch (cause) {
        failures.push(`${endpoint.host}:${endpoint.port} ${cause.code || cause.message}`);
      }
    }
    for (const relay of doc.relays || []) {
      try {
        const socket = await this.dialViaRelay(relay, device);
        return this.attachPeer(socket, device, "relay", true);
      } catch (cause) {
        failures.push(`relay ${relay.host}:${relay.port} ${cause.code || cause.message}`);
      }
    }
    const peerError = error("ANXNET_NO_PATH", `No path to ${device.name}. Tried: ${failures.join("; ") || "no known address"}.${doc.relays?.length ? "" : " Add an AnxNet relay for devices that can't reach each other directly."}`, 503);
    this.lastPeerErrors = this.lastPeerErrors || new Map();
    this.lastPeerErrors.set(deviceId, { message: peerError.message, at: Date.now() });
    this.emit("change");
    throw peerError;
  }

  // Direct TLS to a peer, checking the peer key against the roster.
  dial(endpoint, device, { purpose = "peer" } = {}) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host: endpoint.host, port: endpoint.port, ...this.identity.tlsOptions(), rejectUnauthorized: false, checkServerIdentity: () => undefined, minVersion: "TLSv1.3" });
      const timer = setTimeout(() => socket.destroy(error("ANXNET_HANDSHAKE_TIMEOUT", "Timed out.", 504)), HANDSHAKE_TIMEOUT_MS);
      socket.once("error", (cause) => { clearTimeout(timer); reject(cause); });
      socket.once("secureConnect", () => {
        const peer = identityLib.peerFromTlsSocket(socket);
        if (!peer || peer.deviceId !== device.deviceId || peer.publicKeyBase64 !== device.publicKey) {
          clearTimeout(timer);
          socket.destroy();
          reject(error("ANXNET_PEER_IDENTITY", "The device at that address is not the expected AnxNet device.", 403));
          return;
        }
        sendJsonLine(socket, { t: purpose, networkId: this.doc.networkId });
        readLine(socket).then((reply) => {
          clearTimeout(timer);
          if (!reply?.ok) { socket.destroy(); reject(error(reply?.error?.code || "ANXNET_PEER_REFUSED", reply?.error?.message || "The device refused the connection.", 403)); return; }
          socket.resume();
          resolve(socket);
        }, (cause) => { clearTimeout(timer); reject(cause); });
      });
    });
  }

  // A secure stream to `device` through a relay. The relay pipes bytes; the
  // two peers then run TLS end to end inside it.
  dialViaRelay(relay, device) {
    return new Promise((resolve, reject) => {
      const outer = tls.connect({ host: relay.host, port: relay.port, ...this.identity.tlsOptions(), rejectUnauthorized: false, checkServerIdentity: () => undefined, minVersion: "TLSv1.3" });
      const timer = setTimeout(() => outer.destroy(error("ANXNET_RELAY_TIMEOUT", "The relay didn't connect the peer in time.", 504)), HANDSHAKE_TIMEOUT_MS * 2);
      outer.once("error", (cause) => { clearTimeout(timer); reject(cause); });
      outer.once("secureConnect", () => {
        const certificate = outer.getPeerX509Certificate();
        if (!certificate || identityLib.fingerprint(certificate.publicKey) !== relay.fingerprint) {
          clearTimeout(timer); outer.destroy(); reject(error("ANXNET_RELAY_IDENTITY", "The relay's key doesn't match the network's relay.", 403)); return;
        }
        sendJsonLine(outer, { t: "relay-connect", networkId: this.doc.networkId, roster: this.state.roster, target: device.deviceId });
        readLine(outer, HANDSHAKE_TIMEOUT_MS * 2).catch(() => null).then((reply) => {
          if (!reply?.ok) { clearTimeout(timer); outer.destroy(); reject(error(reply?.error?.code || "ANXNET_RELAY_REFUSED", reply?.error?.message || "The relay refused.", 403)); return; }
          const inner = tls.connect({ socket: plainStream(outer), ...this.identity.tlsOptions(), rejectUnauthorized: false, checkServerIdentity: () => undefined, minVersion: "TLSv1.3" });
          inner.once("error", (cause) => { clearTimeout(timer); reject(cause); });
          inner.once("secureConnect", () => {
            clearTimeout(timer);
            const peer = identityLib.peerFromTlsSocket(inner);
            if (!peer || peer.deviceId !== device.deviceId || peer.publicKeyBase64 !== device.publicKey) { inner.destroy(); reject(error("ANXNET_PEER_IDENTITY", "The relayed device is not the expected AnxNet device.", 403)); return; }
            resolve(inner);
          });
        });
      });
    });
  }

  attachPeer(socket, device, path, initiator) {
    const existing = this.peers.get(device.deviceId);
    if (existing && !existing.socket.destroyed) {
      // Simultaneous connects: keep the one opened by the lower device id.
      const keepNew = (initiator ? this.identity.deviceId : device.deviceId) < (existing.initiator ? this.identity.deviceId : device.deviceId);
      if (!keepNew) { socket.destroy(); return existing; }
      existing.socket.destroy();
    }
    const peer = {
      deviceId: device.deviceId,
      publicKey: device.publicKey,
      socket,
      path,
      initiator,
      streams: new Map(),
      nextStreamId: initiator ? 1 : 2,
      latencyMs: null,
      connectedAt: Date.now(),
      lastActivity: Date.now(),
    };
    socket.setNoDelay?.(true);
    socket.setKeepAlive?.(true, 15000);
    const reader = new FrameReader(socket);
    reader.on("frame", (frame) => this.onFrame(peer, frame));
    reader.on("error", () => socket.destroy());
    socket.on("close", () => {
      for (const stream of peer.streams.values()) stream.destroy();
      if (this.peers.get(device.deviceId) === peer) this.peers.delete(device.deviceId);
      this.emit("change");
    });
    socket.on("error", () => {});
    this.peers.set(device.deviceId, peer);
    this.lastPeerErrors?.delete(device.deviceId);
    this.emit("peer", { deviceId: device.deviceId, path });
    this.emit("change");
    this.ping(peer);
    return peer;
  }

  writeFrame(peer, type, id, payload) {
    if (!peer.socket.destroyed) return peer.socket.write(encode(type, id, payload));
    return false;
  }

  pipeLocalToPeer(peer, streamId, local) {
    local.on("data", (data) => {
      peer.lastActivity = Date.now();
      let ok = true;
      for (const part of chunks(data)) ok = this.writeFrame(peer, TYPES.DATA, streamId, part) && ok;
      if (!ok) { local.pause(); peer.socket.once("drain", () => local.resume()); }
    });
    const close = () => {
      if (peer.streams.get(streamId) === local) {
        peer.streams.delete(streamId);
        this.writeFrame(peer, TYPES.CLOSE, streamId);
      }
    };
    local.on("end", close);
    local.on("close", close);
    local.on("error", () => {});
  }

  onFrame(peer, frame) {
    peer.lastActivity = Date.now();
    const doc = this.doc;
    if (frame.type === TYPES.PING) { this.writeFrame(peer, TYPES.PONG, frame.id, frame.payload); return; }
    if (frame.type === TYPES.PONG) {
      const sent = Number(frame.payload.toString("utf8"));
      if (Number.isFinite(sent)) peer.latencyMs = Math.max(0, Date.now() - sent);
      return;
    }
    if (frame.type === TYPES.OPEN) {
      let request;
      try { request = JSON.parse(frame.payload.toString("utf8")); } catch { request = {}; }
      const service = doc?.services.find((entry) => entry.serviceId === request.serviceId);
      // Only declared services on this device, for allowed devices.
      if (!service || service.deviceId !== this.identity.deviceId || !roster.serviceAllows(doc, service, peer.deviceId) || peer.streams.size >= MAX_STREAMS_PER_PEER) {
        this.writeFrame(peer, TYPES.CLOSE, frame.id);
        return;
      }
      const target = net.connect(service.targetPort, service.targetHost);
      target.setNoDelay(true);
      peer.streams.set(frame.id, target);
      this.pipeLocalToPeer(peer, frame.id, target);
      target.on("error", () => { target.destroy(); });
      return;
    }
    if (frame.type === TYPES.DATA) {
      const local = peer.streams.get(frame.id);
      if (local && !local.destroyed && local.write(frame.payload) === false) {
        peer.socket.pause();
        local.once("drain", () => peer.socket.resume());
      }
      return;
    }
    if (frame.type === TYPES.CLOSE) {
      const local = peer.streams.get(frame.id);
      peer.streams.delete(frame.id);
      local?.end();
      return;
    }
    if (frame.type === TYPES.DGRAM) this.onDatagram(peer.deviceId, frame.id, frame.payload);
    if (frame.type === TYPES.CTRL) {
      let message;
      try { message = JSON.parse(frame.payload.toString("utf8")); } catch { return; }
      this.emit("peer-message", { deviceId: peer.deviceId, message });
    }
  }

  // A UDP datagram arriving from a peer, over the mux or the UDP channel.
  onDatagram(peerId, flowId, payload) {
    const doc = this.doc;
    const serviceId = payload.subarray(0, 24).toString("utf8").trim();
    const data = payload.subarray(24);
    const service = doc?.services.find((entry) => entry.serviceId === serviceId);
    if (!service) return;
    if (service.deviceId === this.identity.deviceId) {
      // Host side: deliver to the real game port.
      if (!roster.serviceAllows(doc, service, peerId) || !["udp", "both"].includes(service.protocol)) return;
      const key = `${peerId}:${flowId}`;
      let flow = this.hostFlows.get(key);
      if (!flow) {
        const perService = [...this.hostFlows.values()].filter((entry) => entry.serviceId === serviceId).length;
        if (perService >= MAX_FLOWS_PER_SERVICE) return;
        const socket = dgram.createSocket("udp4");
        flow = { socket, serviceId, peerId, lastSeen: Date.now() };
        socket.on("message", (reply) => {
          flow.lastSeen = Date.now();
          const svc = this.doc?.services.find((entry) => entry.serviceId === serviceId);
          if (svc) this.sendDatagram({ ...svc, deviceId: peerId }, flowId, reply).catch(() => {});
        });
        socket.on("error", () => {});
        this.hostFlows.set(key, flow);
        if (!this.flowSweep) {
          this.flowSweep = setInterval(() => {
            const cutoff = Date.now() - UDP_FLOW_IDLE_MS;
            for (const [flowKey, entry] of this.hostFlows) if (entry.lastSeen < cutoff) { entry.socket.close(); this.hostFlows.delete(flowKey); }
          }, 15000);
          this.flowSweep.unref?.();
        }
      }
      flow.lastSeen = Date.now();
      flow.socket.send(data, service.targetPort, service.targetHost);
      return;
    }
    // Client side: a reply for one of our local UDP forwards.
    this.udpForwardsByService?.get(serviceId)?.deliver(flowId, data);
  }

  ping(peer) {
    this.writeFrame(peer, TYPES.PING, 0, String(Date.now()));
  }

  pingPeers() {
    const now = Date.now();
    for (const [deviceId, peer] of this.peers) {
      if (peer.streams.size === 0 && now - peer.lastActivity > PEER_IDLE_CLOSE_MS && !this.udpForwardsByService?.size) {
        peer.socket.end();
        this.peers.delete(deviceId);
        continue;
      }
      this.ping(peer);
    }
  }

  // ---- incoming TLS ------------------------------------------------------------------------

  onIncoming(socket) {
    socket.on("error", () => {});
    const peer = identityLib.peerFromTlsSocket(socket);
    if (!peer) { socket.destroy(); return; }
    readLine(socket).then((hello) => {
      socket.resume();
      if (!hello) { socket.destroy(); return; }
      this.onHello(socket, peer, hello);
    }, () => socket.destroy());
  }

  refuse(socket, code, message) {
    sendJsonLine(socket, { ok: false, error: { code, message } });
    socket.end();
  }

  onHello(socket, peer, hello) {
    const doc = this.doc;
    if (!doc || hello.networkId !== doc.networkId) return this.refuse(socket, "ANXNET_NETWORK_UNKNOWN", "This device isn't in that network.");
    if (hello.t === "enroll") return this.onEnroll(socket, peer, hello);
    const member = roster.memberFor(doc, peer.deviceId, peer.publicKeyBase64);
    if (hello.t === "coord") {
      const pending = this.state.pending.find((entry) => entry.deviceId === peer.deviceId && entry.publicKey === peer.publicKeyBase64);
      if (!this.isOwner()) return this.refuse(socket, "ANXNET_NOT_COORDINATOR", "This device is not the network coordinator.");
      if (!member && !pending) return this.refuse(socket, "ANXNET_NOT_MEMBER", "This device is not allowed in the network.");
      return this.onCoordinatorClient(socket, peer, Boolean(member));
    }
    if (hello.t === "peer") {
      if (!member) return this.refuse(socket, "ANXNET_NOT_MEMBER", "This device is not allowed in the network.");
      // "Relay only": the device accepts peers only through a relay (for a
      // device behind a firewall, or one that keeps LAN exposure minimal).
      if (this.options.directInbound === false) return this.refuse(socket, "ANXNET_DIRECT_DISABLED", "This device accepts connections only through a relay.");
      sendJsonLine(socket, { ok: true });
      this.attachPeer(socket, member, "direct", false);
      return undefined;
    }
    return this.refuse(socket, "ANXNET_UNKNOWN_REQUEST", "Unknown request.");
  }

  onEnroll(socket, peer, hello) {
    if (!this.isOwner()) return this.refuse(socket, "ANXNET_NOT_COORDINATOR", "This device can't enroll devices.");
    if (roster.isRevoked(this.doc, peer.deviceId)) return this.refuse(socket, "ANXNET_DEVICE_REVOKED", "This device was removed from the network.");
    let invite;
    try { invite = roster.matchInvite(this.state.invites, hello.secret); } catch (cause) { return this.refuse(socket, cause.code, cause.message); }
    invite.uses += 1;
    const name = String(hello.name || "device").slice(0, 64);
    if (invite.preApproved || roster.memberFor(this.doc, peer.deviceId, peer.publicKeyBase64)) {
      this.changeRoster((signed) => roster.addDevice(signed, this.identity, { publicKeyBase64: peer.publicKeyBase64, name }))
        .then(() => { sendJsonLine(socket, { ok: true, ownerPublicKey: this.doc.owner.publicKey, roster: this.state.roster }); socket.end(); })
        .catch((cause) => this.refuse(socket, cause.code, cause.message));
      return undefined;
    }
    if (!this.state.pending.some((entry) => entry.deviceId === peer.deviceId)) {
      if (this.state.pending.length >= MAX_PENDING) return this.refuse(socket, "ANXNET_TOO_MANY_PENDING", "Too many devices are waiting for approval.");
      this.state.pending.push({ deviceId: peer.deviceId, publicKey: peer.publicKeyBase64, name, inviteId: invite.inviteId, requestedAt: new Date().toISOString() });
    }
    this.saveState();
    this.emit("change");
    this.emit("pending", { deviceId: peer.deviceId, name });
    sendJsonLine(socket, { ok: true, pending: true, ownerPublicKey: this.doc.owner.publicKey });
    socket.end();
    return undefined;
  }

  // ---- coordinator (owner side) -------------------------------------------------------------

  onCoordinatorClient(socket, peer, isMember) {
    const previous = this.coordClients.get(peer.deviceId);
    if (previous && previous !== socket) previous.destroy(); // one control session per device
    this.coordClients.set(peer.deviceId, socket);
    sendJsonLine(socket, isMember ? { ok: true, roster: this.state.roster } : { ok: true, pending: true });
    jsonLineReader(socket, (message) => this.onCoordinatorMessage(socket, peer, message));
    socket.on("close", () => {
      if (this.coordClients.get(peer.deviceId) === socket) this.coordClients.delete(peer.deviceId);
      this.emit("change");
    });
    this.emit("change");
  }

  onCoordinatorMessage(socket, peer, message) {
    const doc = this.doc;
    const member = roster.memberFor(doc, peer.deviceId, peer.publicKeyBase64);
    const reply = (body) => sendJsonLine(socket, { id: message.id, ...body });
    if (!member) { if (message.id) reply({ error: { code: "ANXNET_PENDING_APPROVAL", message: "Waiting for the owner's approval." } }); return; }
    if (message.t === "register") {
      const tcp = (Array.isArray(message.tcp) ? message.tcp : []).slice(0, 6)
        .map((entry) => ({ host: String(entry.host), port: Number(entry.port) }))
        .filter((entry) => /^[A-Za-z0-9.:-]{1,253}$/.test(entry.host) && Number.isInteger(entry.port));
      // The address the coordinator actually saw comes first.
      const seen = { host: socket.remoteAddress?.replace(/^::ffff:/, ""), port: tcp[0]?.port };
      const list = seen.host && seen.port && !tcp.some((entry) => entry.host === seen.host) ? [seen, ...tcp] : tcp;
      this.endpoints.set(peer.deviceId, { ...(this.endpoints.get(peer.deviceId) || {}), tcp: list, seenAt: Date.now() });
      reply({ ok: true });
      return;
    }
    if (message.t === "lookup") {
      const target = String(message.deviceId || "");
      if (!roster.memberFor(doc, target)) { reply({ error: { code: "ANXNET_PEER_NOT_MEMBER", message: "That device is not in this network." } }); return; }
      const tcp = target === this.identity.deviceId ? this.tcpEndpoints() : this.endpoints.get(target)?.tcp || [];
      reply({ ok: true, tcp, online: target === this.identity.deviceId || this.coordClients.has(target) });
      return;
    }
    if (message.t === "punch") {
      this.introduce(peer.deviceId, String(message.deviceId || "")).then((result) => reply(result)).catch((cause) => reply({ error: { code: cause.code, message: cause.message } }));
      return;
    }
    if (message.t === "service-add") {
      const service = { ...(message.service || {}), deviceId: peer.deviceId }; // members share only their own services
      this.changeRoster((signed) => roster.addService(signed, this.identity, service))
        .then((created) => reply({ ok: true, service: created }))
        .catch((cause) => reply({ error: { code: cause.code, message: cause.message } }));
      return;
    }
    if (message.t === "service-remove") {
      const service = doc.services.find((entry) => entry.serviceId === message.serviceId);
      if (!service || service.deviceId !== peer.deviceId) { reply({ error: { code: "ANXNET_NOT_SERVICE_HOST", message: "Only the device that shares a service can remove it." } }); return; }
      this.changeRoster((signed) => roster.removeService(signed, this.identity, service.serviceId))
        .then(() => reply({ ok: true }))
        .catch((cause) => reply({ error: { code: cause.code, message: cause.message } }));
    }
  }

  // ---- coordinator client (member side) ------------------------------------------------------

  connectCoordinator() {
    if (!this.started || !this.state.network || this.isOwner() || this.coordinator.socket) return;
    clearTimeout(this.coordinator.timer);
    this.coordinator.state = this.coordinator.attempt ? "reconnecting" : "connecting";
    this.emit("change");
    const endpoints = this.state.network.coordinator;
    const owner = { deviceId: identityLib.deviceIdFor(identityLib.importPublicKey(this.state.network.ownerPublicKey)), publicKey: this.state.network.ownerPublicKey };
    const tryEndpoint = async (index) => {
      if (index >= endpoints.length) throw error("ANXNET_COORDINATOR_UNREACHABLE", "Couldn't reach the network owner's device.", 503);
      try {
        return await this.dialCoordinator(endpoints[index], owner);
      } catch (cause) {
        if (cause.code === "ANXNET_NOT_MEMBER" || cause.code === "ANXNET_DEVICE_REVOKED") throw cause;
        return tryEndpoint(index + 1);
      }
    };
    tryEndpoint(0).then((socket) => this.onCoordinatorConnected(socket)).catch((cause) => this.scheduleCoordinatorRetry(cause));
  }

  dialCoordinator(endpoint, owner) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host: endpoint.host, port: endpoint.port, ...this.identity.tlsOptions(), rejectUnauthorized: false, checkServerIdentity: () => undefined, minVersion: "TLSv1.3" });
      const timer = setTimeout(() => socket.destroy(error("ANXNET_HANDSHAKE_TIMEOUT", "Timed out.", 504)), HANDSHAKE_TIMEOUT_MS);
      socket.once("error", (cause) => { clearTimeout(timer); reject(cause); });
      socket.once("secureConnect", () => {
        clearTimeout(timer);
        const peer = identityLib.peerFromTlsSocket(socket);
        if (!peer || peer.publicKeyBase64 !== owner.publicKey) { socket.destroy(); reject(error("ANXNET_OWNER_MISMATCH", "That address isn't the network owner's device.", 403)); return; }
        sendJsonLine(socket, { t: "coord", networkId: this.state.network.networkId });
        resolve(socket);
      });
    });
  }

  onCoordinatorConnected(socket) {
    this.coordinator.socket = socket;
    this.coordinator.requests = new Map();
    let first = true;
    jsonLineReader(socket, (message) => {
      if (first) {
        first = false;
        if (!message.ok) {
          this.coordinator.message = message.error?.message || "Refused.";
          this.coordinator.refusal = error(message.error?.code || "ANXNET_REFUSED", this.coordinator.message, 403);
          socket.destroy();
          return;
        }
        this.coordinator.refusal = null;
        this.coordinator.attempt = 0;
        this.coordinator.state = message.pending ? "pending-approval" : "connected";
        this.coordinator.message = message.pending ? "Waiting for the network owner to approve this device." : "";
        if (message.roster) this.onRosterFromCoordinator(message.roster);
        this.registerWithCoordinator();
        this.emit("change");
        return;
      }
      if (message.t === "roster") { this.onRosterFromCoordinator(message.roster); return; }
      if (message.t === "punch-peer") { this.startPunch(message).catch(() => {}); return; }
      const pending = message.id && this.coordinator.requests.get(message.id);
      if (pending) { this.coordinator.requests.delete(message.id); pending(message); }
    });
    socket.on("close", () => {
      for (const resolve of this.coordinator.requests?.values() || []) resolve({ error: { code: "ANXNET_COORDINATOR_DISCONNECTED", message: "Lost the connection to the network owner." } });
      this.coordinator.socket = null;
      if (this.coordinator.state === "removed") return;
      if (this.started && this.state.network && !this.isOwner()) this.scheduleCoordinatorRetry(this.coordinator.refusal || error("ANXNET_COORDINATOR_DISCONNECTED", "Lost the connection to the network owner.", 503));
    });
    socket.on("error", () => {});
  }

  onRosterFromCoordinator(signed) {
    try {
      this.acceptRoster(signed);
      this.saveState();
      this.applyRoster().then(() => this.emit("change"));
      if (this.coordinator.state === "pending-approval" && roster.memberFor(this.doc, this.identity.deviceId)) {
        this.coordinator.state = "connected";
        this.coordinator.message = "";
        this.registerWithCoordinator();
      }
      if (!roster.memberFor(this.doc, this.identity.deviceId)) {
        this.coordinator.state = "removed";
        this.coordinator.message = "This device was removed from the network by its owner.";
      }
    } catch (cause) {
      if (cause.code !== "ANXNET_ROSTER_STALE") this.emit("warning", { code: cause.code, message: cause.message });
    }
  }

  registerWithCoordinator() {
    if (!this.doc || !roster.memberFor(this.doc, this.identity.deviceId)) return;
    this.coordinatorRequest({ t: "register", tcp: this.tcpEndpoints() }).catch(() => {});
    // UDP registration lets the coordinator see this device's public UDP address.
    for (const endpoint of this.state.network.coordinator) this.sendUdpRegister(endpoint);
  }

  scheduleCoordinatorRetry(cause) {
    this.coordinator.socket = null;
    if (!this.started || !this.state.network || this.isOwner()) return;
    if (["ANXNET_NOT_MEMBER", "ANXNET_DEVICE_REVOKED", "ANXNET_OWNER_MISMATCH"].includes(cause?.code)) {
      this.coordinator.state = "removed";
      this.coordinator.message = cause.message;
      this.emit("change");
      return;
    }
    this.coordinator.attempt += 1;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(this.coordinator.attempt - 1, 6));
    this.coordinator.state = "reconnecting";
    this.coordinator.message = `${cause?.message || "Disconnected."} Retrying in ${Math.round(delay / 1000)} s.`;
    this.coordinator.timer = setTimeout(() => this.connectCoordinator(), delay);
    this.coordinator.timer.unref?.();
    this.emit("change");
  }

  coordinatorRequest(message, timeoutMs = 10000) {
    const socket = this.coordinator.socket;
    if (!socket || socket.destroyed) return Promise.reject(error("ANXNET_COORDINATOR_DISCONNECTED", "Not connected to the network owner's device.", 503));
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.coordinator.requests.delete(id); resolve({ error: { code: "ANXNET_COORDINATOR_TIMEOUT", message: "The network owner's device didn't answer." } }); }, timeoutMs);
      this.coordinator.requests.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
      sendJsonLine(socket, { ...message, id });
    });
  }

  // A one-shot TLS request to an endpoint (enrollment).
  request(endpoint, message, { expectFingerprint }) {
    return new Promise((resolve, reject) => {
      const socket = tls.connect({ host: endpoint.host, port: endpoint.port, ...this.identity.tlsOptions(), rejectUnauthorized: false, checkServerIdentity: () => undefined, minVersion: "TLSv1.3" });
      const timer = setTimeout(() => socket.destroy(error("ANXNET_HANDSHAKE_TIMEOUT", "Timed out.", 504)), HANDSHAKE_TIMEOUT_MS);
      socket.once("error", (cause) => { clearTimeout(timer); reject(cause); });
      socket.once("secureConnect", () => {
        const certificate = socket.getPeerX509Certificate();
        if (!certificate || identityLib.fingerprint(certificate.publicKey) !== expectFingerprint) {
          clearTimeout(timer); socket.destroy(); reject(error("ANXNET_OWNER_MISMATCH", "That address isn't the network owner's device.", 403)); return;
        }
        clearTimeout(timer);
        const replyTimer = setTimeout(() => { socket.destroy(); reject(error("ANXNET_COORDINATOR_TIMEOUT", "The network owner's device didn't answer.", 504)); }, HANDSHAKE_TIMEOUT_MS);
        sendJsonLine(socket, message);
        jsonLineReader(socket, (reply) => { clearTimeout(replyTimer); socket.end(); resolve(reply); });
        socket.once("close", () => { clearTimeout(replyTimer); reject(error("ANXNET_CONNECTION_CLOSED", "The network owner's device closed the connection.", 503)); });
      });
    });
  }

  // ---- UDP: registration, hole punching, secure channel ---------------------------------------

  sendUdpRegister(endpoint) {
    const body = { t: "register", networkId: this.doc.networkId, deviceId: this.identity.deviceId, at: Date.now() };
    const packet = secureUdp.controlPacket(secureUdp.KIND.PUNCH, { ...body, signature: this.identity.sign(roster.canonical(body)) });
    try { this.udp.send(packet, endpoint.udpPort || endpoint.port, endpoint.host); } catch {}
  }

  // Owner: tell both devices each other's UDP address, then they punch.
  async introduce(fromId, toId) {
    const doc = this.doc;
    if (!roster.memberFor(doc, toId)) throw error("ANXNET_PEER_NOT_MEMBER", "That device is not in this network.", 404);
    const fromUdp = this.endpoints.get(fromId)?.udp;
    const toUdp = toId === this.identity.deviceId ? { host: null, port: null, self: true } : this.endpoints.get(toId)?.udp;
    if (!fromUdp || !toUdp) throw error("ANXNET_UDP_UNKNOWN", "The coordinator hasn't seen a UDP address for both devices yet.", 409);
    const send = (deviceId, peerId, address) => {
      const socket = this.coordClients.get(deviceId);
      if (socket) sendJsonLine(socket, { t: "punch-peer", deviceId: peerId, address });
    };
    if (toUdp.self) {
      this.startPunch({ deviceId: fromId, address: fromUdp }).catch(() => {});
      return { ok: true, address: { host: null, port: this.udp.address().port, self: true } };
    }
    send(fromId, toId, toUdp);
    send(toId, fromId, fromUdp);
    return { ok: true, address: toUdp };
  }

  async connectUdp(deviceId) {
    if (this.udpSessions.get(deviceId)?.session) return this.udpSessions.get(deviceId);
    if (this.isOwner()) throw error("ANXNET_UDP_OWNER", "Ask from the member device.", 400);
    const reply = await this.coordinatorRequest({ t: "punch", deviceId });
    if (reply.error) throw error(reply.error.code, reply.error.message, 409);
    const address = reply.address.self ? { host: this.state.network.coordinator[0].host, port: reply.address.port } : reply.address;
    return this.startPunch({ deviceId, address });
  }

  startPunch({ deviceId, address }) {
    const device = this.doc && roster.memberFor(this.doc, deviceId);
    if (!device || !address?.host || !address?.port) return Promise.reject(error("ANXNET_PEER_NOT_MEMBER", "That device is not in this network.", 404));
    const existing = this.pendingPunch.get(deviceId);
    if (existing) return existing.promise;
    const handshake = secureUdp.createHandshake({ identity: this.identity, networkId: this.doc.networkId, peerDeviceId: deviceId });
    const packet = secureUdp.controlPacket(secureUdp.KIND.HELLO, handshake.hello);
    const entry = { handshake, address, packet };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
      const started = Date.now();
      entry.timer = setInterval(() => {
        if (Date.now() - started > PUNCH_TIMEOUT_MS) {
          clearInterval(entry.timer);
          this.pendingPunch.delete(deviceId);
          reject(error("ANXNET_UDP_NO_PATH", "No direct UDP path: the devices' networks don't allow it (for example symmetric NAT or a firewall).", 503));
          return;
        }
        try { this.udp.send(packet, address.port, address.host); } catch {}
      }, PUNCH_INTERVAL_MS);
    });
    this.pendingPunch.set(deviceId, entry);
    try { this.udp.send(packet, address.port, address.host); } catch {}
    return entry.promise;
  }

  onUdp(message, remote) {
    const control = secureUdp.parseControl(message);
    if (control) {
      if (control.kind === secureUdp.KIND.PUNCH && control.message.t === "register" && this.isOwner()) {
        const { signature, ...body } = control.message;
        const member = roster.memberFor(this.doc, body.deviceId);
        if (!member || body.networkId !== this.doc.networkId || Math.abs(Date.now() - Number(body.at)) > 60000) return;
        if (!identityLib.verifySignature(member.publicKey, roster.canonical(body), signature)) return;
        this.endpoints.set(body.deviceId, { ...(this.endpoints.get(body.deviceId) || {}), udp: { host: remote.address, port: remote.port } });
        return;
      }
      if (control.kind === secureUdp.KIND.HELLO) this.onUdpHello(control.message, remote);
      return;
    }
    for (const [deviceId, entry] of this.udpSessions) {
      if (entry.address.host !== remote.address || entry.address.port !== remote.port) continue;
      const plaintext = entry.session.open(message);
      if (!plaintext) return;
      entry.received = (entry.received || 0) + 1;
      if (plaintext.length < 7) return;
      const id = plaintext.readUInt32BE(1);
      if (plaintext.readUInt8(0) === TYPES.DGRAM) this.onDatagram(deviceId, id, plaintext.subarray(7));
      return;
    }
  }

  onUdpHello(hello, remote) {
    const doc = this.doc;
    const deviceId = String(hello?.from || "");
    const member = doc && roster.memberFor(doc, deviceId);
    if (!member || hello.to !== this.identity.deviceId) return;
    // A repeat of the hello this session was built from: the peer may have
    // missed our answer, so answer again instead of starting over.
    const established = this.udpSessions.get(deviceId);
    if (established && established.peerRandom === hello.random) {
      try { this.udp.send(established.helloPacket, remote.port, remote.address); } catch {}
      return;
    }
    if (established && Date.now() - established.establishedAt < 30000 && !this.pendingPunch.has(deviceId)) return;
    let entry = this.pendingPunch.get(deviceId);
    if (!entry) {
      // The peer punched first: answer with our own hello at its address.
      this.startPunch({ deviceId, address: { host: remote.address, port: remote.port } }).catch(() => {});
      entry = this.pendingPunch.get(deviceId);
      if (!entry) return;
    }
    let keys;
    try {
      keys = entry.handshake.complete(hello, (peerId, data, signature) => {
        const current = roster.memberFor(this.doc, peerId);
        return Boolean(current) && identityLib.verifySignature(current.publicKey, data, signature);
      });
    } catch {
      return;
    }
    // Send our hello once more so the peer can finish even if it missed one.
    try { this.udp.send(entry.packet, remote.port, remote.address); } catch {}
    clearInterval(entry.timer);
    this.pendingPunch.delete(deviceId);
    const session = { session: new secureUdp.SecureUdpSession(keys), address: { host: remote.address, port: remote.port }, establishedAt: Date.now(), peerRandom: hello.random, helloPacket: entry.packet };
    this.udpSessions.set(deviceId, session);
    this.emit("change");
    entry.resolve(session);
  }

  // ---- relay and gateway links (edge client) ------------------------------------------------------

  closeEdgeLinks() {
    for (const link of this.edgeLinks?.values() || []) { clearTimeout(link.timer); link.closed = true; link.socket?.destroy(); }
    this.edgeLinks = new Map();
    for (const route of this.gatewayRoutes?.values() || []) route.udpLink?.destroy();
    this.gatewayRoutes = new Map();
  }

  // Keep one registration per configured relay so others can reach this
  // device through it.
  syncRelayLinks() {
    this.edgeLinks = this.edgeLinks || new Map();
    const wanted = new Map((this.doc?.relays || []).map((relay) => [`relay:${relay.host}:${relay.port}`, relay]));
    for (const [key, link] of this.edgeLinks) {
      if (link.kind === "relay-register" && !wanted.has(key)) { link.closed = true; clearTimeout(link.timer); link.socket?.destroy(); this.edgeLinks.delete(key); }
    }
    for (const [key, relay] of wanted) {
      if (!this.edgeLinks.has(key)) this.openEdgeLink(key, relay, "relay-register");
    }
  }

  async openEdgeLink(key, edge, kind) {
    const link = this.edgeLinks.get(key) || { key, edge, kind, attempt: 0, state: "connecting", requests: new Map() };
    this.edgeLinks.set(key, link);
    if (link.closed || !this.started) return link;
    try {
      const socket = tlsConnect(this.identity, { host: edge.host, port: edge.port });
      await onceSecure(socket);
      if (identityLib.fingerprint(socket.getPeerX509Certificate().publicKey) !== edge.fingerprint) { socket.destroy(); throw error("ANXNET_EDGE_IDENTITY", "The edge's key doesn't match the network's configuration.", 403); }
      sendJsonLine(socket, { t: kind, networkId: this.doc.networkId, roster: this.state.roster });
      const reply = await readLine(socket);
      if (!reply?.ok) { socket.destroy(); throw error(reply?.error?.code || "ANXNET_EDGE_REFUSED", reply?.error?.message || "The edge refused.", 403); }
      socket.resume();
      socket.on("error", () => {});
      link.socket = socket;
      link.state = "connected";
      link.attempt = 0;
      jsonLineReader(socket, (message) => this.onEdgeMessage(link, message));
      socket.on("close", () => {
        link.socket = null;
        for (const resolve of link.requests.values()) resolve({ error: { code: "ANXNET_EDGE_DISCONNECTED", message: "Lost the connection to the edge." } });
        link.requests.clear();
        if (link.closed || !this.started || !this.state.network) return;
        this.scheduleEdgeRetry(link);
      });
      this.emit("change");
      return link;
    } catch (cause) {
      link.state = "failed";
      link.message = cause.message;
      this.scheduleEdgeRetry(link);
      throw cause;
    }
  }

  scheduleEdgeRetry(link) {
    if (link.closed || !this.started) return;
    link.attempt += 1;
    link.state = "reconnecting";
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(link.attempt - 1, 6));
    clearTimeout(link.timer);
    link.timer = setTimeout(() => this.openEdgeLink(link.key, link.edge, link.kind).catch(() => {}), delay);
    link.timer.unref?.();
    this.emit("change");
  }

  edgeRequest(link, message, timeoutMs = 10000) {
    if (!link.socket || link.socket.destroyed) return Promise.resolve({ error: { code: "ANXNET_EDGE_DISCONNECTED", message: "Not connected to the edge." } });
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => { link.requests.delete(id); resolve({ error: { code: "ANXNET_EDGE_TIMEOUT", message: "The edge didn't answer." } }); }, timeoutMs);
      link.requests.set(id, (reply) => { clearTimeout(timer); resolve(reply); });
      sendJsonLine(link.socket, { ...message, id });
    });
  }

  onEdgeMessage(link, message) {
    if (message.id && link.requests.has(message.id)) { const resolve = link.requests.get(message.id); link.requests.delete(message.id); resolve(message); return; }
    if (message.t === "incoming" && link.kind === "relay-register") { this.acceptRelayed(link.edge, message).catch(() => {}); return; }
    if (message.t === "incoming" && link.kind === "gateway-register") this.acceptGatewayConnection(link.edge, message).catch(() => {});
  }

  // The other side of a relayed connection: this device is the TLS server.
  async acceptRelayed(relay, { sessionId, from }) {
    const device = roster.memberFor(this.doc, from);
    if (!device) return;
    const outer = tlsConnect(this.identity, { host: relay.host, port: relay.port });
    await onceSecure(outer);
    if (identityLib.fingerprint(outer.getPeerX509Certificate().publicKey) !== relay.fingerprint) { outer.destroy(); return; }
    sendJsonLine(outer, { t: "relay-accept", networkId: this.doc.networkId, sessionId });
    const reply = await readLine(outer);
    if (!reply?.ok) { outer.destroy(); return; }
    const inner = new tls.TLSSocket(plainStream(outer), { isServer: true, ...this.identity.tlsOptions(), requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3" });
    inner.on("error", () => {});
    await onceSecure(inner, { server: true });
    const peer = identityLib.peerFromTlsSocket(inner);
    const member = peer && roster.memberFor(this.doc, peer.deviceId, peer.publicKeyBase64);
    if (!member || member.deviceId !== device.deviceId) { inner.destroy(); return; }
    this.attachPeer(inner, member, "relay", false);
  }

  // Publish a shared service on an AnxNet gateway. Needs an owner-signed
  // grant for that gateway (the owner's approval of the public exposure).
  async publish({ gateway, grant, signature }) {
    const service = this.doc?.services.find((entry) => entry.serviceId === grant?.serviceId);
    if (!service || service.deviceId !== this.identity.deviceId) throw error("ANXNET_NOT_SERVICE_HOST", "Only the device that hosts a service can publish it.", 403);
    this.edgeLinks = this.edgeLinks || new Map();
    this.gatewayRoutes = this.gatewayRoutes || new Map();
    const key = `gateway:${gateway.host}:${gateway.port}`;
    let link = this.edgeLinks.get(key);
    if (!link?.socket) link = await this.openEdgeLink(key, gateway, "gateway-register");
    const reply = await this.edgeRequest(link, { t: "route", grant, signature });
    if (reply.error) throw error(reply.error.code, reply.error.message, 403);
    const route = { routeId: reply.routeId, serviceId: grant.serviceId, protocol: reply.protocol, publicHost: reply.publicHost || gateway.publicHost || gateway.host, publicPort: reply.publicPort, gateway: { host: gateway.host, port: gateway.port, fingerprint: gateway.fingerprint }, linkKey: key };
    this.gatewayRoutes.set(route.routeId, route);
    if (route.protocol === "udp") await this.openGatewayUdp(gateway, route, service);
    this.emit("change");
    return route;
  }

  async unpublish(routeId) {
    const route = this.gatewayRoutes?.get(routeId);
    if (!route) return { removed: false };
    this.gatewayRoutes.delete(routeId);
    route.udpLink?.destroy();
    const link = this.edgeLinks?.get(route.linkKey);
    if (link) await this.edgeRequest(link, { t: "unroute", routeId });
    this.emit("change");
    return { removed: true };
  }

  async acceptGatewayConnection(gateway, { connId, routeId }) {
    const route = this.gatewayRoutes?.get(routeId);
    const service = route && this.doc?.services.find((entry) => entry.serviceId === route.serviceId);
    if (!route || !service || service.deviceId !== this.identity.deviceId) return;
    const target = net.connect(service.targetPort, service.targetHost);
    target.on("error", () => target.destroy());
    const socket = tlsConnect(this.identity, { host: gateway.host, port: gateway.port });
    socket.on("error", () => target.destroy());
    await onceSecure(socket);
    if (identityLib.fingerprint(socket.getPeerX509Certificate().publicKey) !== gateway.fingerprint) { socket.destroy(); target.destroy(); return; }
    sendJsonLine(socket, { t: "gateway-accept", connId });
    const reply = await readLine(socket);
    if (!reply?.ok) { socket.destroy(); target.destroy(); return; }
    socket.resume();
    socket.pipe(target);
    target.pipe(socket);
    socket.on("close", () => target.destroy());
    target.on("close", () => socket.destroy());
  }

  async openGatewayUdp(gateway, route, service) {
    const socket = tlsConnect(this.identity, { host: gateway.host, port: gateway.port });
    await onceSecure(socket);
    if (identityLib.fingerprint(socket.getPeerX509Certificate().publicKey) !== gateway.fingerprint) { socket.destroy(); throw error("ANXNET_EDGE_IDENTITY", "The gateway's key doesn't match.", 403); }
    sendJsonLine(socket, { t: "gateway-udp", routeId: route.routeId });
    const reply = await readLine(socket);
    if (!reply?.ok) { socket.destroy(); throw error(reply?.error?.code || "ANXNET_GATEWAY_REFUSED", reply?.error?.message || "The gateway refused.", 403); }
    socket.resume();
    socket.on("error", () => {});
    route.udpLink = socket;
    const flows = new Map();
    const reader = new FrameReader(socket);
    reader.on("frame", (frame) => {
      if (frame.type !== TYPES.DGRAM) return;
      let flow = flows.get(frame.id);
      if (!flow) {
        if (flows.size >= MAX_FLOWS_PER_SERVICE) return;
        const local = dgram.createSocket("udp4");
        flow = { socket: local, lastSeen: Date.now() };
        local.on("message", (payload) => { flow.lastSeen = Date.now(); if (!socket.destroyed && socket.writableLength < 512 * 1024) socket.write(encode(TYPES.DGRAM, frame.id, payload)); });
        local.on("error", () => {});
        flows.set(frame.id, flow);
      }
      flow.lastSeen = Date.now();
      flow.socket.send(frame.payload, service.targetPort, service.targetHost);
    });
    const sweep = setInterval(() => {
      const cutoff = Date.now() - UDP_FLOW_IDLE_MS;
      for (const [id, flow] of flows) if (flow.lastSeen < cutoff) { flow.socket.close(); flows.delete(id); }
    }, 15000);
    sweep.unref?.();
    socket.on("close", () => { clearInterval(sweep); for (const flow of flows.values()) flow.socket.close(); flows.clear(); });
  }

  // ---- status ---------------------------------------------------------------------------------

  status() {
    const doc = this.doc;
    const me = this.identity?.deviceId || null;
    const base = {
      deviceId: me,
      fingerprint: this.identity?.fingerprint || null,
      listening: this.server ? { tcpPort: this.server.address()?.port || null, udpPort: this.udp?.address?.()?.port || null } : null,
    };
    if (!this.state.network) return { ...base, network: null };
    const peerError = (deviceId) => this.lastPeerErrors?.get(deviceId)?.message || null;
    return {
      ...base,
      network: {
        networkId: this.state.network.networkId,
        name: doc?.name || null,
        domain: doc?.domain || null,
        version: doc?.version || 0,
        role: this.isOwner() ? "owner" : "member",
        ownerFingerprint: this.state.network.ownerFingerprint,
        ownerPublicKey: this.state.network.ownerPublicKey,
        coordinator: this.isOwner() ? { state: "this-device" } : { state: this.coordinator.state, message: this.coordinator.message },
        relays: doc?.relays || [],
        gateways: doc?.gateways || [],
      },
      devices: (doc?.devices || []).map((device) => {
        const peer = this.peers.get(device.deviceId);
        const udp = this.udpSessions.get(device.deviceId);
        return {
          deviceId: device.deviceId,
          name: device.name,
          hostname: device.hostname,
          address: device.address,
          role: device.role,
          self: device.deviceId === me,
          connection: device.deviceId === me ? "self" : peer ? peer.path : udp ? "udp" : "not-connected",
          udp: Boolean(udp),
          latencyMs: peer?.latencyMs ?? null,
          coordinatorOnline: this.isOwner() ? this.coordClients.has(device.deviceId) : null,
          lastError: peerError(device.deviceId),
        };
      }),
      pending: this.isOwner() ? this.state.pending.map(({ publicKey: _key, ...entry }) => entry) : [],
      invites: this.isOwner() ? this.state.invites.filter((invite) => roster.isInviteUsable(invite)).map(({ hash: _hash, ...invite }) => invite) : [],
      services: (doc?.services || []).map((service) => ({
        ...service,
        reachableHere: service.deviceId !== me && roster.serviceAllows(doc, service, me),
        local: service.deviceId === me,
        address: `${doc.devices.find((entry) => entry.deviceId === service.deviceId)?.address}:${service.port}`,
      })),
      dns: this.dns ? { host: this.dns.host, port: this.dns.port, domain: doc?.domain } : null,
      forwards: [...this.forwards.values()].map((forward) => ({ protocol: forward.protocol, address: forward.address, port: forward.service.port, serviceId: forward.service.serviceId })),
      relayLinks: [...(this.edgeLinks?.values() || [])].filter((link) => link.kind === "relay-register").map((link) => ({ host: link.edge.host, port: link.edge.port, state: link.state })),
      publicRoutes: [...(this.gatewayRoutes?.values() || [])].map((route) => ({ ...route })),
    };
  }
}

module.exports = { AnxNetNode, fileStore };
