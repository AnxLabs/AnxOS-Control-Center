"use strict";

// This computer's AnxNet, as seen from the desktop main process.
//
// - AnxNet runs in its own background process (src/anxnet/host.js) by
//   default, so networks, shared servers and public routes keep working
//   while the Control Center window is closed. One host runs per data
//   folder; the desktop connects to it, or starts it (detached, as the
//   signed-in user, never as a system service). "backgroundService: false"
//   in anxnet-settings.json runs the node in this process instead.
// - The device key is encrypted with Electron safeStorage on disk and handed
//   to the host in memory over its token-protected pipe.
// - Nothing starts unless this computer is in a network or the user creates
//   or joins one.
// - Public exposure (a gateway route) needs the owner's explicit approval in
//   the renderer and an owner-signed grant; nothing is published on its own.
//   Nothing here changes OS DNS, routing or firewall settings (OS name lookup
//   is a separate, approval-gated step: src/anxnet/dnsIntegration.js).

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const { AnxNetNode } = require("../anxnet/node");
const { AnxNetHostClient } = require("../anxnet/hostClient");
const { METHODS } = require("../anxnet/host");
const identityLib = require("../anxnet/identity");
const roster = require("../anxnet/roster");
const dnsIntegration = require("../anxnet/dnsIntegration");
const { decryptPayload, encryptPayload, getDefaultConfigDirectory } = require("./secureSessionStore");

const DEFAULT_PORT = 47710;
const events = new EventEmitter();
let backend = null; // { mode, call(method, params), stop(), detach() }
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
  settings = { listenHost: "0.0.0.0", listenPort: DEFAULT_PORT, directInbound: true, backgroundService: true, keepRunningWhenClosed: true, publicRoutes: {}, ...settings };
  return settings;
}

function writeSettings(next) {
  settings = { ...readSettings(), ...next };
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return settings;
}

// The device key, encrypted at rest; created on first use.
function devicePrivateKeyPem() {
  const file = path.join(dataDir(), "anxnet-device.key.json");
  try {
    const pem = decryptPayload(JSON.parse(fs.readFileSync(file, "utf8")), file);
    if (pem) return pem;
  } catch {}
  const identity = identityLib.createIdentity();
  const pem = identity.privateKey.export({ format: "pem", type: "pkcs8" });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(encryptPayload(pem, file)), { mode: 0o600 });
  return pem;
}

function hasNetwork() {
  try { return Boolean(JSON.parse(fs.readFileSync(path.join(dataDir(), "anxnet-state.json"), "utf8")).network); } catch { return false; }
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "0.0.0.0", () => probe.close(() => resolve(true)));
  });
}

async function nodeOptions() {
  const current = readSettings();
  // A fixed port keeps invite codes valid across restarts; fall back to any
  // free port if another program holds it.
  const listenPort = current.listenPort && (await portFree(current.listenPort)) ? current.listenPort : 0;
  return {
    listenPort,
    // "0.0.0.0" lets devices on the LAN connect directly (Windows may ask once
    // to allow it through the firewall); "127.0.0.1" keeps AnxNet on this
    // computer only.
    listenHost: ["0.0.0.0", "127.0.0.1"].includes(current.listenHost) ? current.listenHost : "0.0.0.0",
    directInbound: current.directInbound !== false,
    dnsPort: Number.isInteger(current.dnsPort) ? current.dnsPort : 5353,
    deviceName: os.hostname(),
  };
}

async function startHostBackend() {
  const options = await nodeOptions();
  const client = new AnxNetHostClient({
    dataDir: dataDir(),
    hostArgs: ["--listen-host", options.listenHost, "--listen-port", String(options.listenPort), "--dns-port", String(options.dnsPort)],
  });
  await client.connect();
  await client.call("unlock", { keyPem: devicePrivateKeyPem() });
  await client.call("subscribe");
  client.on("change", () => events.emit("change"));
  client.on("pending", (entry) => events.emit("pending", entry));
  client.on("disconnected", () => { if (backend?.client === client) backend = null; events.emit("change"); });
  return {
    mode: "background",
    client,
    call: (method, params) => client.call(method, params),
    stop: async () => { await client.call("shutdown").catch(() => {}); client.disconnect(); },
    detach: () => client.disconnect(),
  };
}

async function startInProcessBackend() {
  const pem = devicePrivateKeyPem();
  const node = new AnxNetNode({ ...(await nodeOptions()), dataDir: dataDir(), keyStore: { read: () => pem, write: () => {} } });
  node.on("change", () => events.emit("change"));
  node.on("pending", (entry) => events.emit("pending", entry));
  await node.start();
  return {
    mode: "in-app",
    node,
    call: async (method, params) => {
      const handler = METHODS[method];
      if (!handler) throw roster.error("ANXNET_HOST_METHOD", "Unknown method.");
      return handler(node, params);
    },
    stop: () => node.stop(),
    detach: () => node.stop(),
  };
}

async function ensureBackend() {
  if (backend) return backend;
  if (starting) return starting;
  starting = (async () => {
    if (readSettings().backgroundService !== false) {
      try {
        backend = await startHostBackend();
        return backend;
      } catch (error) {
        // Never leave the user without AnxNet because the helper couldn't
        // start: run it in this process and say so.
        events.emit("warning", { code: error.code || "ANXNET_HOST_START_FAILED", message: `AnxNet's background process couldn't start (${error.message}); running inside AnxOS instead.` });
      }
    }
    backend = await startInProcessBackend();
    return backend;
  })().finally(() => { starting = null; });
  return starting;
}

// At app start: connect to (or start) AnxNet only if this computer is in a
// network.
async function resume() {
  if (!hasNetwork()) return null;
  try {
    await ensureBackend();
    await republishRoutes();
    return status();
  } catch (error) {
    events.emit("warning", { code: error.code || "ANXNET_START_FAILED", message: error.message });
    return null;
  }
}

// At app quit: the background process keeps running unless the user turned
// that off; an in-app node always stops with the app.
async function shutdown() {
  if (!backend) return;
  const current = backend;
  backend = null;
  if (current.mode === "background" && readSettings().keepRunningWhenClosed !== false) current.detach();
  else await current.stop().catch(() => {});
}

function publicSettings() {
  const current = readSettings();
  return {
    listenPort: current.listenPort,
    directInbound: current.directInbound !== false,
    backgroundService: current.backgroundService !== false,
    keepRunningWhenClosed: current.keepRunningWhenClosed !== false,
  };
}

async function status() {
  if (!backend) return { running: false, mode: null, network: null, settings: publicSettings() };
  try {
    const nodeStatus = await backend.call("status");
    let usage = null;
    if (backend.mode === "background") usage = await backend.call("usage").catch(() => null);
    return { running: true, mode: backend.mode, ...nodeStatus, host: usage ? { pid: usage.pid, uptimeSeconds: usage.uptimeSeconds, rssMb: Math.round(usage.rss / 1048576) } : null, settings: publicSettings() };
  } catch (error) {
    return { running: false, mode: backend?.mode || null, network: null, error: error.message, settings: publicSettings() };
  }
}

async function call(method, params) {
  return (await ensureBackend()).call(method, params);
}

async function requireNetwork() {
  if (!backend && !hasNetwork()) throw roster.error("ANXNET_NOT_RUNNING", "This computer isn't in an AnxNet network yet.", 409);
  return ensureBackend();
}

async function createNetwork(input = {}) {
  await call("createNetwork", { name: input.name || undefined, deviceName: input.deviceName || undefined });
  return status();
}

async function joinNetwork(input = {}) {
  const result = await call("joinNetwork", { code: String(input.code || ""), deviceName: input.deviceName || undefined });
  return { ...(await status()), pendingApproval: Boolean(result.pendingApproval) };
}

async function leaveNetwork() {
  if (!backend && !hasNetwork()) return { left: false };
  const active = await ensureBackend();
  for (const routeId of Object.keys(readSettings().publicRoutes || {})) await active.call("unpublish", { routeId }).catch(() => {});
  writeSettings({ publicRoutes: {} });
  const result = await active.call("leaveNetwork");
  backend = null;
  await active.stop().catch(() => {});
  return result;
}

function createInvite(input = {}) {
  return requireNetwork().then((active) => active.call("createInvite", { ttlMs: Number(input.ttlMinutes || 60) * 60 * 1000, maxUses: Number(input.maxUses || 1), preApproved: input.preApproved === true, label: input.label }));
}

const ownerAction = (method, toParams) => async (...args) => {
  const active = await requireNetwork();
  const result = await active.call(method, toParams(...args));
  return { result, status: await status() };
};

async function serviceTargetReachable(targetHost, targetPort) {
  return new Promise((resolve) => {
    const socket = net.connect(targetPort, targetHost);
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 3000);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", () => { clearTimeout(timer); resolve(false); });
  });
}

// Share a server through AnxNet for invited devices. The target must answer
// from this computer before anything is shared.
async function shareService(input = {}) {
  const active = await requireNetwork();
  const port = Number(input.port);
  const targetHost = String(input.targetHost || "127.0.0.1");
  const targetPort = Number(input.targetPort || port);
  if (input.protocol !== "udp" && !(await serviceTargetReachable(targetHost, targetPort))) {
    throw roster.error("ANXNET_TARGET_UNREACHABLE", `This computer can't reach the server at ${targetHost}:${targetPort}. Start the server first. AnxNet on this computer can share servers running here or on this computer's network.`, 409);
  }
  const service = await active.call("shareService", { name: input.name, port, protocol: input.protocol, targetHost, targetPort, allow: input.allow, instanceId: input.instanceId });
  return { service, status: await status() };
}

async function unshareService(serviceId) {
  const active = await requireNetwork();
  const routes = readSettings().publicRoutes || {};
  for (const [routeId, route] of Object.entries(routes)) {
    if (route.serviceId === serviceId) { await active.call("unpublish", { routeId }).catch(() => {}); delete routes[routeId]; }
  }
  writeSettings({ publicRoutes: routes });
  await active.call("unshareService", { serviceId });
  return { removed: true, status: await status() };
}

async function publishRoutes(active, nodeStatus, serviceId, publicHost) {
  const gateway = nodeStatus.network?.gateways?.[0];
  if (!gateway) throw roster.error("ANXNET_NO_GATEWAY", "This network has no AnxNet gateway yet. Anyone-can-join needs a gateway on a server with a public address (see Relay and gateway).", 409);
  const service = (nodeStatus.services || []).find((entry) => entry.serviceId === serviceId);
  if (!service) throw roster.error("ANXNET_SERVICE_NOT_FOUND", "Share the server with your network first.", 404);
  const routes = [];
  for (const protocol of service.protocol === "both" ? ["tcp", "udp"] : [service.protocol]) {
    const signed = await active.call("signGatewayGrant", { serviceId, protocol, gatewayFingerprint: gateway.fingerprint });
    routes.push(await active.call("publish", { gateway: { ...gateway, publicHost: publicHost || gateway.host }, ...signed }));
  }
  return { routes, service };
}

// "Anyone can join": publish a shared service on the network's gateway. The
// renderer asks the owner first; then the route is tested from this computer
// before anything says friends can join.
async function publishService(input = {}) {
  const active = await requireNetwork();
  const nodeStatus = await active.call("status");
  const { routes, service } = await publishRoutes(active, nodeStatus, String(input.serviceId || ""), input.publicHost);
  const stored = readSettings().publicRoutes || {};
  routes.forEach((route) => { stored[route.routeId] = { serviceId: route.serviceId, protocol: route.protocol, publicHost: route.publicHost, publicPort: route.publicPort }; });
  writeSettings({ publicRoutes: stored });
  const tcpRoute = routes.find((route) => route.protocol === "tcp");
  const test = await require("../anxnet/readiness").testPublicRoute(tcpRoute || routes[0], { game: input.game, minecraft: /minecraft/i.test(`${service.name} ${input.game || ""}`) });
  return { routes, test, status: await status() };
}

// After a restart, routes saved as on are opened again (with fresh grants).
async function republishRoutes() {
  const stored = readSettings().publicRoutes || {};
  const serviceIds = [...new Set(Object.values(stored).map((route) => route.serviceId))];
  if (!serviceIds.length) return;
  const active = await ensureBackend();
  const nodeStatus = await active.call("status");
  const live = new Set((nodeStatus.publicRoutes || []).map((route) => route.serviceId));
  const next = {};
  for (const serviceId of serviceIds) {
    if (live.has(serviceId)) { Object.entries(stored).filter(([, route]) => route.serviceId === serviceId).forEach(([id, route]) => { next[id] = route; }); continue; }
    try {
      const { routes } = await publishRoutes(active, nodeStatus, serviceId);
      routes.forEach((route) => { next[route.routeId] = { serviceId, protocol: route.protocol, publicHost: route.publicHost, publicPort: route.publicPort }; });
    } catch (error) {
      events.emit("warning", { code: error.code || "ANXNET_REPUBLISH_FAILED", message: `A public route couldn't be reopened: ${error.message}` });
    }
  }
  writeSettings({ publicRoutes: next });
}

async function unpublishService(serviceId) {
  const active = await requireNetwork();
  const stored = readSettings().publicRoutes || {};
  for (const [routeId, route] of Object.entries(stored)) {
    if (route.serviceId === serviceId) { await active.call("unpublish", { routeId }).catch(() => {}); delete stored[routeId]; }
  }
  writeSettings({ publicRoutes: stored });
  return { removed: true, status: await status() };
}

async function testPeer(deviceId) {
  const active = await requireNetwork();
  const result = await active.call("testPeer", { deviceId: String(deviceId || "") });
  return { ok: true, ...result, status: await status() };
}

async function setDirectInbound(enabled) {
  writeSettings({ directInbound: enabled !== false });
  if (backend) await backend.call("setDirectInbound", { enabled: enabled !== false }).catch(() => {});
  return status();
}

// ---- OS name lookup (approval-gated; see src/anxnet/dnsIntegration.js) ----

async function dnsStatus() {
  const current = await status();
  if (!current.network) return { available: false, reason: "Create or join a network first." };
  const plan = dnsIntegration.plan({ domain: current.network.domain, networkId: current.network.networkId });
  if (!plan.supported) return { available: false, reason: plan.reason };
  const detected = await dnsIntegration.detect({ domain: current.network.domain });
  return {
    available: true,
    enabled: detected.enabled,
    conflict: detected.conflict,
    leftover: detected.leftover,
    summary: plan.summary,
    resolver: current.dns,
    needsPort: plan.resolverPort,
    portReady: current.dns?.port === plan.resolverPort,
  };
}

// The user confirmed in the UI; the OS asks for administrator permission.
async function enableDns() {
  const active = await requireNetwork();
  const current = await status();
  const plan = dnsIntegration.plan({ domain: current.network.domain, networkId: current.network.networkId });
  if (!plan.supported) throw roster.error("ANXNET_DNS_UNSUPPORTED", plan.reason, 409);
  const detected = await dnsIntegration.detect({ domain: current.network.domain });
  if (detected.conflict) throw roster.error("ANXNET_DNS_CONFLICT", "Another program already handles these names on this computer, so AnxNet left them alone.", 409);
  if (current.dns?.port !== plan.resolverPort) {
    await active.call("setDnsEndpoint", { port: plan.resolverPort });
    writeSettings({ dnsPort: plan.resolverPort });
  }
  await dnsIntegration.elevate({ lines: plan.apply });
  writeSettings({ osDns: true });
  const self = (current.devices || []).find((device) => device.self);
  const check = self ? await dnsIntegration.verify({ name: self.hostname, expected: self.address }) : null;
  return { enabled: true, verify: check, status: await dnsStatus() };
}

async function disableDns() {
  const plan = dnsIntegration.plan({ domain: "anx-placeholder.internal", networkId: `net-${"a".repeat(26)}` });
  if (!plan.supported) throw roster.error("ANXNET_DNS_UNSUPPORTED", plan.reason, 409);
  await dnsIntegration.elevate({ lines: plan.remove });
  writeSettings({ osDns: false, dnsPort: 5353 });
  if (backend) await backend.call("setDnsEndpoint", { port: 5353 }).catch(() => {});
  return { enabled: false };
}

async function setKeepRunning(enabled) {
  writeSettings({ keepRunningWhenClosed: enabled !== false });
  return status();
}

module.exports = {
  approveDevice: ownerAction("approveDevice", (deviceId) => ({ deviceId })),
  createInvite,
  createNetwork,
  dataDir,
  events,
  joinNetwork,
  leaveNetwork,
  publishService,
  rejectDevice: ownerAction("rejectDevice", (deviceId) => ({ deviceId })),
  renameDevice: ownerAction("renameDevice", (deviceId, name) => ({ deviceId, name })),
  renameNetwork: ownerAction("renameNetwork", (name) => ({ name })),
  resume,
  revokeDevice: ownerAction("revokeDevice", (deviceId) => ({ deviceId })),
  revokeInvite: ownerAction("revokeInvite", (inviteId) => ({ inviteId })),
  setDirectInbound,
  setEdges: ownerAction("setEdges", (edges) => edges),
  setKeepRunning,
  dnsStatus,
  enableDns,
  disableDns,
  shareService,
  shutdown,
  status,
  testPeer,
  unpublishService,
  unshareService,
};
