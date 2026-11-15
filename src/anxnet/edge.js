"use strict";

// AnxNet edge: an optional server the network owner runs on a reachable
// machine. Two roles, each off unless configured:
//
// Relay: joins two members' byte streams when they can't reach each other
// directly. Members run TLS end to end through it, so it only ever sees
// ciphertext. It checks membership against the owner-signed roster of a
// network it was configured to serve, and limits sessions, bandwidth and
// idle time.
//
// Gateway: publishes an approved game service on a public port so ordinary
// game clients (without AnxNet) can join. Every route needs a grant signed
// by the network owner for this gateway, and stays within the configured
// port range and connection, flow and bandwidth limits.
//
// The edge never starts by itself on a user's computer: it is a separate
// program (src/anxnet/bin/anxnet-edge.js) that someone deliberately runs.

const crypto = require("crypto");
const dgram = require("dgram");
const net = require("net");
const tls = require("tls");
const { EventEmitter } = require("events");

const identityLib = require("./identity");
const roster = require("./roster");
const { FrameReader, TYPES, encode, jsonLineReader, sendJsonLine } = require("./frames");

const DEFAULTS = {
  listenHost: "0.0.0.0",
  port: 47700,
  relay: { enabled: true, maxSessionsPerNetwork: 64, maxSessions: 512, bytesPerSecond: 4 * 1024 * 1024, idleMs: 5 * 60 * 1000 },
  gateway: { enabled: false, bindHost: "0.0.0.0", publicHost: null, portRange: [30000, 30099], maxRoutesPerNetwork: 8, maxConnsPerRoute: 64, maxFlowsPerRoute: 256, bytesPerSecond: 8 * 1024 * 1024, flowIdleMs: 60000, hostGraceMs: 5000 },
};

function error(code, message) {
  return roster.error(code, message);
}

// Pipes a -> b at no more than `rate` bytes per second (token bucket),
// pausing the source instead of buffering.
function throttledPipe(from, to, rate, onActivity) {
  let tokens = rate;
  let last = Date.now();
  from.on("data", (chunk) => {
    onActivity?.();
    const now = Date.now();
    tokens = Math.min(rate, tokens + ((now - last) / 1000) * rate);
    last = now;
    tokens -= chunk.length;
    const ok = to.write(chunk);
    if (tokens < 0) {
      from.pause();
      setTimeout(() => from.resume(), Math.min(1000, Math.ceil((-tokens / rate) * 1000)));
    } else if (!ok) {
      from.pause();
      to.once("drain", () => from.resume());
    }
  });
  from.on("end", () => to.end());
  from.on("close", () => to.destroy());
  from.on("error", () => to.destroy());
}

class AnxNetEdge extends EventEmitter {
  constructor(options = {}) {
    super();
    if (!options.keyStore) throw new Error("ANXNET_EDGE_KEYSTORE_REQUIRED");
    this.options = {
      ...DEFAULTS,
      ...options,
      relay: { ...DEFAULTS.relay, ...(options.relay || {}) },
      gateway: { ...DEFAULTS.gateway, ...(options.gateway || {}) },
    };
    this.identity = identityLib.loadOrCreateIdentity(options.keyStore);
    this.allowed = new Map((options.networks || []).map((entry) => [entry.networkId, entry.ownerPublicKey]));
    this.rosters = new Map(); // networkId -> doc
    this.links = new Map(); // `${networkId}:${deviceId}` -> { socket, kind }
    this.sessions = new Map(); // sessionId -> pending/active relay session
    this.routes = new Map(); // routeId -> route
    this.stats = { relaySessions: 0, relayRefused: 0, gatewayConnections: 0, gatewayRefused: 0 };
  }

  get fingerprint() {
    return this.identity.fingerprint;
  }

  start() {
    this.server = tls.createServer({ ...this.identity.tlsOptions(), requestCert: true, rejectUnauthorized: false, minVersion: "TLSv1.3" }, (socket) => this.onConnection(socket));
    this.server.on("tlsClientError", () => {});
    this.server.maxConnections = this.options.maxConnections || 1024;
    // Routes end when their owner-signed grant expires.
    this.grantSweep = setInterval(() => {
      for (const route of [...this.routes.values()]) if (Date.parse(route.grant.expiresAt) <= Date.now()) this.closeRoute(route);
    }, this.options.grantSweepMs || 30000);
    this.grantSweep.unref?.();
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.listenHost, () => resolve({ port: this.server.address().port, fingerprint: this.fingerprint }));
    });
  }

  async stop() {
    clearInterval(this.grantSweep);
    for (const route of this.routes.values()) this.closeRoute(route);
    for (const link of this.links.values()) link.socket.destroy();
    for (const session of this.sessions.values()) { session.a?.destroy(); session.b?.destroy(); }
    await new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  // ---- membership --------------------------------------------------------------------

  // Accept a roster for an allowed network (newer versions only) and enforce
  // its revocations on everything open here.
  acceptRoster(networkId, signed) {
    const ownerKey = this.allowed.get(networkId);
    if (!ownerKey) throw error("ANXNET_EDGE_NETWORK_NOT_SERVED", "This edge doesn't serve that network.");
    const current = this.rosters.get(networkId);
    if (signed) {
      try {
        const doc = roster.verify(signed, ownerKey, { networkId, minVersion: current?.version || 0 });
        this.rosters.set(networkId, doc);
        this.enforce(networkId);
      } catch (cause) {
        if (cause.code !== "ANXNET_ROSTER_STALE") throw cause;
      }
    }
    const doc = this.rosters.get(networkId);
    if (!doc) throw error("ANXNET_EDGE_ROSTER_REQUIRED", "Send the network roster first.");
    return doc;
  }

  enforce(networkId) {
    const doc = this.rosters.get(networkId);
    for (const [key, link] of this.links) {
      if (key.startsWith(`${networkId}:`) && !roster.memberFor(doc, link.deviceId, link.publicKey)) { link.socket.destroy(); this.links.delete(key); }
    }
    for (const session of this.sessions.values()) {
      if (session.networkId === networkId && (!roster.memberFor(doc, session.from) || !roster.memberFor(doc, session.to))) { session.a?.destroy(); session.b?.destroy(); }
    }
    for (const route of this.routes.values()) {
      const service = doc.services.find((entry) => entry.serviceId === route.grant.serviceId);
      if (route.grant.networkId === networkId && (!roster.memberFor(doc, route.grant.deviceId) || !service || service.deviceId !== route.grant.deviceId)) this.closeRoute(route);
    }
  }

  // ---- connections ---------------------------------------------------------------------

  onConnection(socket) {
    socket.on("error", () => {});
    const peer = identityLib.peerFromTlsSocket(socket);
    if (!peer) { socket.destroy(); return; }
    const timer = setTimeout(() => socket.destroy(), 10000);
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const index = buffer.indexOf(10);
      if (index < 0) { if (buffer.length > 512 * 1024) socket.destroy(); return; }
      socket.off("data", onData);
      clearTimeout(timer);
      let hello;
      try { hello = JSON.parse(buffer.subarray(0, index).toString("utf8")); } catch { socket.destroy(); return; }
      const rest = buffer.subarray(index + 1);
      if (rest.length) socket.unshift(rest);
      try {
        this.onHello(socket, peer, hello);
      } catch (cause) {
        sendJsonLine(socket, { ok: false, error: { code: cause.code || "ANXNET_EDGE_ERROR", message: cause.message } });
        socket.end();
      }
    };
    socket.on("data", onData);
  }

  member(networkId, peer, signed) {
    const doc = this.acceptRoster(networkId, signed);
    const device = roster.memberFor(doc, peer.deviceId, peer.publicKeyBase64);
    if (!device) throw error("ANXNET_NOT_MEMBER", "This device is not allowed in that network.");
    return { doc, device };
  }

  onHello(socket, peer, hello) {
    const relay = this.options.relay;
    const gateway = this.options.gateway;
    if (hello.t === "relay-register" || hello.t === "relay-connect" || hello.t === "relay-accept") {
      if (!relay.enabled) throw error("ANXNET_EDGE_RELAY_DISABLED", "This edge doesn't relay.");
    }
    hello.t = String(hello.t || "");
    if (hello.t.startsWith("gateway-") && !gateway.enabled) throw error("ANXNET_EDGE_GATEWAY_DISABLED", "This edge isn't a gateway.");
    if (hello.t === "relay-register" || hello.t === "gateway-register") {
      const { device } = this.member(hello.networkId, peer, hello.roster);
      const key = `${hello.networkId}:${peer.deviceId}:${hello.t}`;
      this.links.get(key)?.socket.destroy();
      const link = { socket, deviceId: peer.deviceId, publicKey: device.publicKey, networkId: hello.networkId, kind: hello.t };
      this.links.set(key, link);
      sendJsonLine(socket, { ok: true });
      jsonLineReader(socket, (message) => this.onLinkMessage(link, message));
      socket.on("close", () => {
        if (this.links.get(key) === link) this.links.delete(key);
        if (hello.t === "gateway-register") this.onHostGone(link);
      });
      return;
    }
    if (hello.t === "relay-connect") {
      const { doc } = this.member(hello.networkId, peer, hello.roster);
      if (!roster.memberFor(doc, hello.target)) throw error("ANXNET_PEER_NOT_MEMBER", "That device is not in the network.");
      const target = this.links.get(`${hello.networkId}:${hello.target}:relay-register`);
      if (!target) throw error("ANXNET_RELAY_PEER_OFFLINE", "That device isn't connected to the relay.");
      const active = [...this.sessions.values()];
      if (active.length >= relay.maxSessions || active.filter((session) => session.networkId === hello.networkId).length >= relay.maxSessionsPerNetwork) {
        this.stats.relayRefused += 1;
        throw error("ANXNET_RELAY_BUSY", "The relay is at its session limit.");
      }
      const sessionId = crypto.randomBytes(16).toString("hex");
      const session = { sessionId, networkId: hello.networkId, from: peer.deviceId, to: hello.target, a: socket, b: null };
      session.timer = setTimeout(() => { socket.destroy(); this.sessions.delete(sessionId); }, 10000);
      this.sessions.set(sessionId, session);
      socket.on("close", () => { this.sessions.delete(sessionId); session.b?.destroy(); });
      sendJsonLine(target.socket, { t: "incoming", sessionId, from: peer.deviceId });
      return;
    }
    if (hello.t === "relay-accept") {
      const session = this.sessions.get(String(hello.sessionId || ""));
      if (!session || session.b || session.to !== peer.deviceId) throw error("ANXNET_RELAY_SESSION", "No such relay session for this device.");
      const doc = this.rosters.get(session.networkId);
      if (!roster.memberFor(doc, peer.deviceId, peer.publicKeyBase64)) throw error("ANXNET_NOT_MEMBER", "This device is not allowed in that network.");
      clearTimeout(session.timer);
      session.b = socket;
      this.stats.relaySessions += 1;
      sendJsonLine(session.a, { ok: true });
      sendJsonLine(socket, { ok: true, from: session.from });
      let lastActivity = Date.now();
      const touch = () => { lastActivity = Date.now(); };
      throttledPipe(session.a, session.b, relay.bytesPerSecond, touch);
      throttledPipe(session.b, session.a, relay.bytesPerSecond, touch);
      // Test hook: lets tests prove the relay only carries ciphertext.
      if (typeof this.options.tap === "function") { session.a.on("data", (chunk) => this.options.tap(chunk)); session.b.on("data", (chunk) => this.options.tap(chunk)); }
      const idle = setInterval(() => { if (Date.now() - lastActivity > relay.idleMs) { session.a.destroy(); session.b.destroy(); } }, Math.min(relay.idleMs, 30000));
      socket.on("close", () => { clearInterval(idle); this.sessions.delete(session.sessionId); session.a.destroy(); });
      return;
    }
    if (hello.t === "gateway-accept") {
      const pending = this.pendingConnections?.get(String(hello.connId || ""));
      if (!pending || pending.route.grant.deviceId !== peer.deviceId) throw error("ANXNET_GATEWAY_CONNECTION", "No such gateway connection for this device.");
      this.pendingConnections.delete(pending.connId);
      clearTimeout(pending.timer);
      sendJsonLine(socket, { ok: true });
      throttledPipe(pending.client, socket, this.options.gateway.bytesPerSecond);
      throttledPipe(socket, pending.client, this.options.gateway.bytesPerSecond);
      pending.client.resume();
      return;
    }
    if (hello.t === "gateway-udp") {
      const route = this.routes.get(String(hello.routeId || ""));
      if (!route || route.grant.deviceId !== peer.deviceId || route.protocol !== "udp") throw error("ANXNET_GATEWAY_ROUTE", "No such UDP route for this device.");
      route.link?.destroy();
      route.link = socket;
      sendJsonLine(socket, { ok: true });
      const reader = new FrameReader(socket);
      reader.on("frame", (frame) => {
        if (frame.type !== TYPES.DGRAM) return;
        const client = route.flowsById.get(frame.id);
        if (client) { client.lastSeen = Date.now(); route.udp.send(frame.payload, client.port, client.address); }
      });
      reader.on("error", () => socket.destroy());
      socket.on("close", () => { if (route.link === socket) route.link = null; });
      return;
    }
    throw error("ANXNET_UNKNOWN_REQUEST", "Unknown request.");
  }

  onLinkMessage(link, message) {
    if (message.t === "roster") {
      try { this.acceptRoster(link.networkId, message.roster); } catch {}
      return;
    }
    if (link.kind !== "gateway-register") return;
    const reply = (body) => sendJsonLine(link.socket, { id: message.id, ...body });
    if (message.t === "route") {
      this.openRoute(link, message).then((route) => reply({ ok: true, routeId: route.routeId, protocol: route.protocol, publicHost: this.options.gateway.publicHost, publicPort: route.port }))
        .catch((cause) => reply({ error: { code: cause.code || "ANXNET_GATEWAY_ERROR", message: cause.message } }));
      return;
    }
    if (message.t === "unroute") {
      const route = this.routes.get(String(message.routeId || ""));
      if (route && route.grant.deviceId === link.deviceId) this.closeRoute(route);
      reply({ ok: true });
    }
  }

  // ---- gateway routes ------------------------------------------------------------------

  async openRoute(link, { grant, signature }) {
    const options = this.options.gateway;
    const ownerKey = this.allowed.get(grant?.networkId);
    if (!ownerKey || grant.networkId !== link.networkId) throw error("ANXNET_GATEWAY_GRANT", "The grant is for another network.");
    if (!identityLib.verifySignature(ownerKey, roster.canonical(grant), signature)) throw error("ANXNET_GATEWAY_GRANT", "The grant isn't signed by the network owner.");
    if (grant.gateway !== this.fingerprint) throw error("ANXNET_GATEWAY_GRANT", "The grant is for another gateway.");
    if (Date.parse(grant.expiresAt) <= Date.now()) throw error("ANXNET_GATEWAY_GRANT_EXPIRED", "The grant has expired.");
    if (grant.deviceId !== link.deviceId) throw error("ANXNET_GATEWAY_GRANT", "The grant is for another device.");
    const doc = this.rosters.get(grant.networkId);
    const service = doc?.services.find((entry) => entry.serviceId === grant.serviceId);
    if (!service || service.deviceId !== grant.deviceId) throw error("ANXNET_SERVICE_NOT_FOUND", "That service isn't shared in the network.");
    if (roster.managementPortName(service.targetPort) || roster.managementPortName(service.port)) throw error("ANXNET_SERVICE_SENSITIVE_PORT", "Management ports are never published.");
    const protocol = grant.protocol === "udp" ? "udp" : "tcp";
    const existing = [...this.routes.values()].find((route) => route.grant.serviceId === grant.serviceId && route.protocol === protocol);
    if (existing) {
      // The host asking again (after reconnecting, or to renew its grant)
      // keeps the route: it moves to this link and takes a later grant.
      existing.hostLink = link;
      if (Date.parse(grant.expiresAt) > Date.parse(existing.grant.expiresAt)) existing.grant = grant;
      return existing;
    }
    if ([...this.routes.values()].filter((route) => route.grant.networkId === grant.networkId).length >= options.maxRoutesPerNetwork) throw error("ANXNET_GATEWAY_ROUTE_LIMIT", "This network has reached its public route limit.");
    const [low, high] = options.portRange;
    const used = new Set([...this.routes.values()].map((route) => `${route.protocol}:${route.port}`));
    const candidates = grant.publicPort ? [grant.publicPort] : Array.from({ length: high - low + 1 }, (_, index) => low + index);
    const route = { routeId: crypto.randomBytes(8).toString("hex"), grant, protocol, hostLink: link, connections: new Set(), flows: new Map(), flowsById: new Map() };
    for (const port of candidates) {
      if (port < low || port > high || used.has(`${protocol}:${port}`)) continue;
      try {
        if (protocol === "tcp") await this.listenTcp(route, port);
        else await this.listenUdp(route, port);
        route.port = port;
        this.routes.set(route.routeId, route);
        this.emit("route", { routeId: route.routeId, protocol, port });
        return route;
      } catch {}
    }
    throw error("ANXNET_GATEWAY_PORT", "No public port in the allowed range is free.");
  }

  listenTcp(route, port) {
    const options = this.options.gateway;
    const server = net.createServer((client) => {
      client.on("error", () => {});
      if (route.connections.size >= options.maxConnsPerRoute || !route.hostLink || route.hostLink.socket.destroyed) {
        this.stats.gatewayRefused += 1;
        client.destroy();
        return;
      }
      client.pause();
      route.connections.add(client);
      client.on("close", () => route.connections.delete(client));
      this.pendingConnections = this.pendingConnections || new Map();
      const connId = crypto.randomBytes(12).toString("hex");
      const pending = { connId, route, client, timer: setTimeout(() => { this.pendingConnections.delete(connId); client.destroy(); }, 10000) };
      this.pendingConnections.set(connId, pending);
      this.stats.gatewayConnections += 1;
      sendJsonLine(route.hostLink.socket, { t: "incoming", connId, routeId: route.routeId });
    });
    route.server = server;
    return new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, options.bindHost, () => { server.off("error", reject); resolve(); });
    });
  }

  listenUdp(route, port) {
    const options = this.options.gateway;
    const socket = dgram.createSocket("udp4");
    route.udp = socket;
    socket.on("message", (payload, remote) => {
      if (!route.link || route.link.destroyed) return;
      const key = `${remote.address}:${remote.port}`;
      let flow = route.flows.get(key);
      if (!flow) {
        if (route.flows.size >= options.maxFlowsPerRoute) { this.stats.gatewayRefused += 1; return; }
        flow = { id: crypto.randomInt(1, 0xffffffff), address: remote.address, port: remote.port, lastSeen: Date.now(), key };
        route.flows.set(key, flow);
        route.flowsById.set(flow.id, flow);
        this.stats.gatewayConnections += 1;
      }
      flow.lastSeen = Date.now();
      if (route.link.writableLength < 512 * 1024) route.link.write(encode(TYPES.DGRAM, flow.id, payload));
    });
    socket.on("error", () => {});
    route.sweep = setInterval(() => {
      const cutoff = Date.now() - options.flowIdleMs;
      for (const [key, flow] of route.flows) if (flow.lastSeen < cutoff) { route.flows.delete(key); route.flowsById.delete(flow.id); }
    }, 15000);
    route.sweep.unref?.();
    return new Promise((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(port, options.bindHost, () => { socket.off("error", reject); resolve(); });
    });
  }

  closeRoute(route) {
    if (!this.routes.has(route.routeId)) return;
    this.routes.delete(route.routeId);
    clearInterval(route.sweep);
    route.server?.close();
    for (const client of route.connections) client.destroy();
    try { route.udp?.close(); } catch {}
    route.link?.destroy();
    // Tell the host, so it reopens the route (with a fresh grant) or stops
    // listing it as public.
    if (route.hostLink?.socket && !route.hostLink.socket.destroyed) sendJsonLine(route.hostLink.socket, { t: "route-closed", routeId: route.routeId });
    this.emit("route-closed", { routeId: route.routeId });
  }

  // Routes outlive a brief host disconnect, then go.
  onHostGone(link) {
    setTimeout(() => {
      const back = this.links.get(`${link.networkId}:${link.deviceId}:gateway-register`);
      for (const route of [...this.routes.values()]) {
        if (route.hostLink === link) {
          if (back) route.hostLink = back;
          else this.closeRoute(route);
        }
      }
    }, this.options.gateway.hostGraceMs);
  }

  status() {
    return {
      fingerprint: this.fingerprint,
      port: this.server?.address()?.port || null,
      networks: [...this.allowed.keys()],
      links: this.links.size,
      relaySessions: [...this.sessions.values()].filter((session) => session.b).length,
      routes: [...this.routes.values()].map((route) => ({ routeId: route.routeId, protocol: route.protocol, port: route.port, serviceId: route.grant.serviceId, connections: route.connections.size, flows: route.flows.size })),
      stats: { ...this.stats },
    };
  }
}

module.exports = { AnxNetEdge, throttledPipe };
