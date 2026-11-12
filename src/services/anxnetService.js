"use strict";

// Hosts this computer's AnxNet node in the desktop main process.
//
// - The node starts only when this computer is in an AnxNet network (or the
//   user creates or joins one), so AnxOS opens no extra ports otherwise.
// - The device key is encrypted with Electron safeStorage (machine-bound
//   AES-GCM where safeStorage is unavailable), using the app's existing
//   secure store helpers.
// - Public exposure (a gateway route) needs the owner's explicit approval in
//   the renderer and an owner-signed grant; this service never publishes on
//   its own. Nothing here changes OS DNS, routing or firewall settings.

const fs = require("fs");
const net = require("net");
const path = require("path");
const { EventEmitter } = require("events");

const { AnxNetNode, fileStore } = require("../anxnet/node");
const roster = require("../anxnet/roster");
const { decryptPayload, encryptPayload, getDefaultConfigDirectory } = require("./secureSessionStore");

const DEFAULT_PORT = 47710;
const events = new EventEmitter();
let node = null;
let starting = null;
let settings = null;

function dataDir() {
  return path.join(getDefaultConfigDirectory(), "anxnet");
}

function settingsPath() {
  return path.join(dataDir(), "anxnet-settings.json");
}

function readSettings() {
  if (settings) return settings;
  try { settings = JSON.parse(fs.readFileSync(settingsPath(), "utf8")); } catch { settings = {}; }
  settings = { listenHost: "0.0.0.0", listenPort: DEFAULT_PORT, directInbound: true, publicRoutes: {}, ...settings };
  return settings;
}

function writeSettings(next) {
  settings = { ...readSettings(), ...next };
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return settings;
}

// The device key, encrypted at rest.
function encryptedKeyStore() {
  const file = path.join(dataDir(), "anxnet-device.key.json");
  return {
    read() {
      try { return decryptPayload(JSON.parse(fs.readFileSync(file, "utf8")), file); } catch { return null; }
    },
    write(text) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(encryptPayload(text, file)), { mode: 0o600 });
    },
  };
}

function hasNetwork() {
  return fs.existsSync(path.join(dataDir(), "anxnet-state.json")) && (() => {
    try { return Boolean(JSON.parse(fs.readFileSync(path.join(dataDir(), "anxnet-state.json"), "utf8")).network); } catch { return false; }
  })();
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "0.0.0.0", () => probe.close(() => resolve(true)));
  });
}

async function ensureNode() {
  if (node?.started) return node;
  if (starting) return starting;
  starting = (async () => {
    const current = readSettings();
    // A fixed port keeps invite codes valid across restarts; fall back to any
    // free port if another program holds it.
    const listenPort = current.listenPort && (await portFree(current.listenPort)) ? current.listenPort : 0;
    const created = new AnxNetNode({
      dataDir: dataDir(),
      keyStore: encryptedKeyStore(),
      listenPort,
      // "0.0.0.0" lets devices on the LAN connect directly (Windows may ask
      // once to allow it through the firewall); "127.0.0.1" keeps AnxNet on
      // this computer only.
      listenHost: ["0.0.0.0", "127.0.0.1"].includes(current.listenHost) ? current.listenHost : "0.0.0.0",
      directInbound: current.directInbound !== false,
      deviceName: require("os").hostname(),
    });
    created.on("change", () => events.emit("change"));
    created.on("pending", (entry) => events.emit("pending", entry));
    created.on("warning", (warning) => events.emit("warning", warning));
    await created.start();
    node = created;
    return node;
  })().finally(() => { starting = null; });
  return starting;
}

// Called at app start: resume only if this computer is in a network.
async function resume() {
  if (!hasNetwork()) return null;
  return ensureNode().then(() => status()).catch((error) => {
    events.emit("warning", { code: error.code || "ANXNET_START_FAILED", message: error.message });
    return null;
  });
}

async function shutdown() {
  if (node) await node.stop().catch(() => {});
  node = null;
}

function status() {
  if (!node) return { running: false, network: null, settings: publicSettings() };
  return { running: true, ...node.status(), settings: publicSettings() };
}

function publicSettings() {
  const current = readSettings();
  return { listenPort: current.listenPort, directInbound: current.directInbound !== false };
}

async function createNetwork(input = {}) {
  const active = await ensureNode();
  await active.createNetwork({ name: input.name || undefined, deviceName: input.deviceName || undefined });
  return status();
}

async function joinNetwork(input = {}) {
  const active = await ensureNode();
  const result = await active.joinNetwork(String(input.code || ""), { deviceName: input.deviceName || undefined });
  return { ...status(), pendingApproval: Boolean(result.pendingApproval) };
}

async function leaveNetwork() {
  if (!node) return { left: false };
  for (const routeId of Object.keys(readSettings().publicRoutes || {})) await node.unpublish(routeId).catch(() => {});
  writeSettings({ publicRoutes: {} });
  const result = await node.leaveNetwork();
  await shutdown();
  return result;
}

function requireNode() {
  if (!node) throw roster.error("ANXNET_NOT_RUNNING", "This computer isn't in an AnxNet network yet.", 409);
  return node;
}

function createInvite(input = {}) {
  return requireNode().createInvite({ ttlMs: Number(input.ttlMinutes || 60) * 60 * 1000, maxUses: Number(input.maxUses || 1), preApproved: input.preApproved === true, label: input.label });
}

const ownerAction = (method) => async (...args) => { const result = await requireNode()[method](...args); return { result, status: status() }; };

// Share a server through AnxNet for invited devices. The target must answer
// from this computer before anything is shared.
async function shareService(input = {}) {
  const active = requireNode();
  const port = Number(input.port);
  const targetHost = String(input.targetHost || "127.0.0.1");
  const targetPort = Number(input.targetPort || port);
  const reachable = await new Promise((resolve) => {
    const socket = net.connect(targetPort, targetHost);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 3000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
  });
  if (!reachable && input.protocol !== "udp") {
    throw roster.error("ANXNET_TARGET_UNREACHABLE", `This computer can't reach the server at ${targetHost}:${targetPort}. Start the server first. AnxNet on this computer can share servers running here or on this computer's network.`, 409);
  }
  const service = await active.shareService({ name: input.name, port, protocol: input.protocol, targetHost, targetPort, allow: input.allow, instanceId: input.instanceId });
  return { service, status: status() };
}

async function unshareService(serviceId) {
  const active = requireNode();
  const routes = readSettings().publicRoutes || {};
  for (const [routeId, route] of Object.entries(routes)) {
    if (route.serviceId === serviceId) { await active.unpublish(routeId).catch(() => {}); delete routes[routeId]; }
  }
  writeSettings({ publicRoutes: routes });
  await active.unshareService(serviceId);
  return { removed: true, status: status() };
}

// "Anyone can join": publish a shared service on the network's gateway. The
// renderer asks the owner first; this signs the grant (owner only) and opens
// the route, then tests it from this computer.
async function publishService(input = {}) {
  const active = requireNode();
  const doc = active.doc;
  const gateway = doc?.gateways?.[0];
  if (!gateway) throw roster.error("ANXNET_NO_GATEWAY", "This network has no AnxNet gateway yet. Anyone-can-join needs a gateway on a server with a public address (see Relay and gateway).", 409);
  const service = doc.services.find((entry) => entry.serviceId === input.serviceId);
  if (!service) throw roster.error("ANXNET_SERVICE_NOT_FOUND", "Share the server with your network first.", 404);
  const protocols = service.protocol === "both" ? ["tcp", "udp"] : [service.protocol];
  const routes = [];
  for (const protocol of protocols) {
    const signed = active.signGatewayGrant({ serviceId: service.serviceId, protocol, gatewayFingerprint: gateway.fingerprint });
    const route = await active.publish({ gateway: { ...gateway, publicHost: input.publicHost || gateway.host }, ...signed });
    routes.push(route);
  }
  const stored = readSettings().publicRoutes || {};
  routes.forEach((route) => { stored[route.routeId] = { serviceId: route.serviceId, protocol: route.protocol, publicHost: route.publicHost, publicPort: route.publicPort }; });
  writeSettings({ publicRoutes: stored });
  const test = await testPublicRoute(routes.find((route) => route.protocol === "tcp") || routes[0]);
  return { routes, test, status: status() };
}

async function unpublishService(serviceId) {
  const active = requireNode();
  const stored = readSettings().publicRoutes || {};
  for (const [routeId, route] of Object.entries(stored)) {
    if (route.serviceId === serviceId) { await active.unpublish(routeId).catch(() => {}); delete stored[routeId]; }
  }
  writeSettings({ publicRoutes: stored });
  return { removed: true, status: status() };
}

// Connect to the public address through the gateway and keep the
// connection briefly: a gateway that couldn't reach the game closes it.
// This checks the path from this computer only; a friend's network may
// still block it.
function testPublicRoute(route) {
  if (!route || route.protocol !== "tcp") return Promise.resolve({ tested: false, reason: "UDP routes can't be confirmed without a game client." });
  return new Promise((resolve) => {
    const socket = net.connect(route.publicPort, route.publicHost);
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; socket.destroy(); resolve(result); } };
    socket.once("error", (error) => done({ tested: true, ok: false, reason: `Couldn't connect to ${route.publicHost}:${route.publicPort} (${error.code || error.message}).` }));
    socket.once("close", () => done({ tested: true, ok: false, reason: "The gateway accepted the connection but couldn't reach the server." }));
    socket.once("connect", () => setTimeout(() => done({ tested: true, ok: true, reason: `${route.publicHost}:${route.publicPort} reached the server through the gateway (tested from this computer).` }), 1500));
    setTimeout(() => done({ tested: true, ok: false, reason: "No answer from the gateway." }), 8000);
  });
}

async function testPeer(deviceId) {
  const active = requireNode();
  const started = Date.now();
  const peer = await active.ensurePeer(String(deviceId || ""));
  return { ok: true, path: peer.path, connectMs: Date.now() - started, latencyMs: peer.latencyMs, status: status() };
}

async function setDirectInbound(enabled) {
  writeSettings({ directInbound: enabled !== false });
  if (node) node.options.directInbound = enabled !== false;
  return status();
}

module.exports = {
  approveDevice: ownerAction("approveDevice"),
  createInvite,
  createNetwork,
  events,
  joinNetwork,
  leaveNetwork,
  publishService,
  rejectDevice: ownerAction("rejectDevice"),
  renameDevice: ownerAction("renameDevice"),
  renameNetwork: ownerAction("renameNetwork"),
  resume,
  revokeDevice: ownerAction("revokeDevice"),
  revokeInvite: ownerAction("revokeInvite"),
  setDirectInbound,
  setEdges: ownerAction("setEdges"),
  shareService,
  shutdown,
  status,
  testPeer,
  unpublishService,
  unshareService,
  _test: { dataDir, fileStore, testPublicRoute },
};
