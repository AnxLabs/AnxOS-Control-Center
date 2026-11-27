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
const { preserveUnreadableFile } = require("../shared/preserveUnreadableFile");

const DEFAULT_PORT = 47710;
const REPUBLISH_RETRY_MIN_MS = 5000;
const REPUBLISH_RETRY_MAX_MS = 5 * 60 * 1000;
const events = new EventEmitter();
let backend = null; // { mode, call(method, params), stop(), detach() }
let starting = null;
let settings = null;
// Saved "Anyone can join" routes that couldn't be reopened yet, by service;
// shown in status() and retried with backoff.
const publicRouteErrors = new Map();
let republishTimer = null;
let republishAttempt = 0;

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

function isDevicePem(value) {
  return typeof value === "string" && value.includes("-----BEGIN PRIVATE KEY-----");
}

function deviceKeyUnreadable(file, cause, kind) {
  // Keep a copy of exactly what was on disk; the file itself is not touched.
  if (kind) {
    try { preserveUnreadableFile(file, { kind }); } catch {}
  }
  const error = roster.error(
    "ANXNET_DEVICE_KEY_UNREADABLE",
    "AnxNet is locked: this computer's AnxNet key couldn't be read (the system keyring may be locked or unavailable). The key file was kept, and AnxNet won't start with a new identity.",
    409,
  );
  if (cause) Object.defineProperty(error, "cause", { value: cause, enumerable: false });
  return error;
}

// A new key is written to a temporary file and linked into place, so a crash
// never leaves a half-written key and an existing key is never replaced.
function createDeviceKey(file) {
  const identity = identityLib.createIdentity();
  const pem = identity.privateKey.export({ format: "pem", type: "pkcs8" });
  const record = encryptPayload(pem, file);
  // The fallback cipher key includes the computer name; recording it lets the
  // key be decrypted after the computer is renamed.
  if (record.method === "aes-256-gcm") record.hostname = os.hostname();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporaryPath = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(record), { mode: 0o600, flag: "wx" });
    try {
      fs.linkSync(temporaryPath, file);
    } catch (error) {
      // Another start created the key first: use that one.
      if (error?.code === "EEXIST" || fs.existsSync(file)) return devicePrivateKeyPem();
      // A file system without hard links.
      fs.renameSync(temporaryPath, file);
    }
  } finally {
    try { fs.rmSync(temporaryPath, { force: true }); } catch {}
  }
  return pem;
}

// The device key, encrypted at rest; created only when there is none.
//
// The key is this computer's AnxNet identity (its deviceId, and ownership of
// any network it created), and nothing can rebuild it. A key file that exists
// but can't be read or decrypted (a locked or missing keyring, a damaged
// file) is kept as it is, with a recovery copy, and AnxNet reports that it is
// locked instead of joining with a new identity.
function devicePrivateKeyPem() {
  const file = path.join(dataDir(), "anxnet-device.key.json");
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return createDeviceKey(file);
    throw deviceKeyUnreadable(file, error, null);
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    throw deviceKeyUnreadable(file, error, "corrupt");
  }
  const currentHostname = os.hostname();
  const hostnames = record?.method === "aes-256-gcm" && typeof record.hostname === "string" && record.hostname && record.hostname !== currentHostname
    ? [currentHostname, record.hostname]
    : [currentHostname];
  let failure = null;
  for (const hostname of hostnames) {
    let pem = null;
    try {
      pem = decryptPayload(record, file, { hostname });
    } catch (error) {
      failure = error;
    }
    if (!isDevicePem(pem)) continue;
    // A fallback key written before the computer name was recorded: record
    // it now (same ciphertext), so a later rename doesn't lock the key.
    if (record.method === "aes-256-gcm" && !record.hostname) {
      const temporaryPath = `${file}.${process.pid}.${Date.now()}.tmp`;
      try {
        fs.writeFileSync(temporaryPath, JSON.stringify({ ...record, hostname }), { mode: 0o600, flag: "wx" });
        fs.renameSync(temporaryPath, file);
      } catch {
        try { fs.rmSync(temporaryPath, { force: true }); } catch {}
      }
    }
    return pem;
  }
  throw deviceKeyUnreadable(file, failure, "undecryptable");
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

// Ports AnxNet must never forward to on this computer's network, beyond the
// fixed list in roster.MANAGEMENT_PORTS: every registered Agent's port and
// the phone gateway's port.
function blockedPorts() {
  const ports = new Map();
  try {
    for (const node of require("./nodeService").getAllNodesSync()) {
      const port = Number(new URL(node.baseUrl || node.agentUrl || "http://x").port);
      if (Number.isInteger(port) && port > 0) ports.set(port, "the AnxHost Agent");
    }
  } catch {
    // The fixed list still applies.
  }
  try {
    const phone = JSON.parse(fs.readFileSync(path.join(getDefaultConfigDirectory(), "mobile", "settings.json"), "utf8"));
    if (Number.isInteger(Number(phone.port))) ports.set(Number(phone.port), "AnxHost Phone Access");
  } catch {
    // Phone access not configured.
  }
  return [...ports].map(([port, name]) => ({ port, name }));
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
    blockedPorts: blockedPorts(),
  };
}

// Errors after this point mean a host process answered: AnxOS must not start
// a second node on the same data folder next to it.
function hostAnswered(error) {
  if (error && error.code !== "ANXNET_HOST_DISCONNECTED") error.anxnetHostAlive = true;
  return error;
}

async function startHostBackend() {
  // Read the key first: a key that can't be read must not start a host.
  const keyPem = devicePrivateKeyPem();
  const options = await nodeOptions();
  const client = new AnxNetHostClient({
    dataDir: dataDir(),
    hostArgs: ["--listen-host", options.listenHost, "--listen-port", String(options.listenPort), "--dns-port", String(options.dnsPort), "--blocked-ports", options.blockedPorts.map((entry) => entry.port).join(",") || "none"],
  });
  await client.connect();
  try {
    await client.call("unlock", { keyPem });
    await client.call("subscribe");
  } catch (error) {
    client.disconnect();
    throw hostAnswered(error);
  }
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
        // An unreadable device key, or a host that is running (perhaps with
        // another key), is reported as it is: an in-process node would run
        // beside that host on the same data folder, or with a new identity.
        if (error?.code === "ANXNET_DEVICE_KEY_UNREADABLE" || error?.code === "ANXNET_HOST_KEY_MISMATCH" || error?.anxnetHostAlive) throw error;
        // Never leave the user without AnxNet because the helper couldn't
        // start: run it in this process and say so.
        events.emit("warning", { code: error.code || "ANXNET_HOST_START_FAILED", message: `AnxNet's background process couldn't start (${error.message}); running inside AnxHost instead.` });
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
  stopRepublishRetry();
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
    return { running: true, mode: backend.mode, ...nodeStatus, publicRouteErrors: [...publicRouteErrors.values()], host: usage ? { pid: usage.pid, uptimeSeconds: usage.uptimeSeconds, rssMb: Math.round(usage.rss / 1048576) } : null, settings: publicSettings() };
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
  stopRepublishRetry();
  publicRouteErrors.clear();
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
  await unpublishLiveRoutes(active, serviceId);
  writeSettings({ publicRoutes: routes });
  publicRouteErrors.delete(serviceId);
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
  publicRouteErrors.delete(service.serviceId);
  const tcpRoute = routes.find((route) => route.protocol === "tcp");
  const test = await require("../anxnet/readiness").testPublicRoute(tcpRoute || routes[0], { game: input.game, minecraft: /minecraft/i.test(`${service.name} ${input.game || ""}`) });
  return { routes, test, status: await status() };
}

// After a restart, routes saved as on are opened again (with fresh grants).
// A route that can't be reopened now (gateway down, no network yet) stays
// saved and on: it is reported in status() and tried again with backoff.
// Only the owner turning Anyone can join off (or unsharing) removes it.
async function republishRoutes() {
  const stored = readSettings().publicRoutes || {};
  const serviceIds = [...new Set(Object.values(stored).map((route) => route.serviceId))];
  if (!serviceIds.length) { publicRouteErrors.clear(); return; }
  const active = await ensureBackend();
  const nodeStatus = await active.call("status");
  const live = new Set((nodeStatus.publicRoutes || []).map((route) => route.serviceId));
  const keep = (serviceId, into) => Object.entries(stored).filter(([, route]) => route.serviceId === serviceId).forEach(([id, route]) => { into[id] = route; });
  const next = {};
  for (const serviceId of serviceIds) {
    if (live.has(serviceId)) { keep(serviceId, next); publicRouteErrors.delete(serviceId); continue; }
    try {
      const { routes } = await publishRoutes(active, nodeStatus, serviceId);
      routes.forEach((route) => { next[route.routeId] = { serviceId, protocol: route.protocol, publicHost: route.publicHost, publicPort: route.publicPort }; });
      publicRouteErrors.delete(serviceId);
    } catch (error) {
      keep(serviceId, next);
      publicRouteErrors.set(serviceId, { serviceId, code: error.code || "ANXNET_REPUBLISH_FAILED", message: error.message, at: new Date().toISOString() });
      events.emit("warning", { code: error.code || "ANXNET_REPUBLISH_FAILED", message: `A public route couldn't be reopened: ${error.message}` });
    }
  }
  // The owner may have turned a route on or off while this ran.
  const latest = readSettings().publicRoutes || {};
  const wanted = new Set(Object.values(latest).map((route) => route.serviceId));
  const merged = Object.fromEntries(Object.entries(latest).filter(([, route]) => !serviceIds.includes(route.serviceId)));
  Object.entries(next).forEach(([id, route]) => { if (wanted.has(route.serviceId)) merged[id] = route; });
  writeSettings({ publicRoutes: merged });
  for (const serviceId of publicRouteErrors.keys()) if (!wanted.has(serviceId)) publicRouteErrors.delete(serviceId);
  if (publicRouteErrors.size) scheduleRepublish();
  else republishAttempt = 0;
}

function scheduleRepublish() {
  clearTimeout(republishTimer);
  const delay = Math.min(REPUBLISH_RETRY_MAX_MS, REPUBLISH_RETRY_MIN_MS * 2 ** Math.min(republishAttempt, 6));
  republishAttempt += 1;
  republishTimer = setTimeout(() => {
    republishTimer = null;
    if (!backend) return; // AnxOS is closing or left the network
    republishRoutes().catch((error) => { events.emit("warning", { code: error.code || "ANXNET_REPUBLISH_FAILED", message: error.message }); scheduleRepublish(); });
  }, delay);
  republishTimer.unref?.();
}

function stopRepublishRetry() {
  clearTimeout(republishTimer);
  republishTimer = null;
  republishAttempt = 0;
}

// Routes the node holds for a service, by their current id (a reopened
// route can have a new id), including ones that aren't live right now
// (status() lists only live routes).
async function unpublishLiveRoutes(active, serviceId) {
  try {
    await active.call("unpublishService", { serviceId });
    return;
  } catch {
    // A background host from an older build has no unpublishService.
  }
  const nodeStatus = await active.call("status").catch(() => null);
  for (const route of nodeStatus?.publicRoutes || []) {
    if (route.serviceId === serviceId) await active.call("unpublish", { routeId: route.routeId }).catch(() => {});
  }
}

async function unpublishService(serviceId) {
  const active = await requireNetwork();
  const stored = readSettings().publicRoutes || {};
  for (const [routeId, route] of Object.entries(stored)) {
    if (route.serviceId === serviceId) { await active.call("unpublish", { routeId }).catch(() => {}); delete stored[routeId]; }
  }
  await unpublishLiveRoutes(active, serviceId);
  writeSettings({ publicRoutes: stored });
  publicRouteErrors.delete(serviceId);
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

// ---- Computers with the AnxOS Agent (Phase 7.1) --------------------------------
// An Agent runs the same AnxNet node, so a server can be shared from its own
// computer. This desktop (the network's owner) sends the Agent a single-use,
// pre-approved invite over the Agent's authenticated API.

function agentCall(nodeId, action, body) {
  const agentClient = require("./agentClient");
  const target = agentClient.forNode(String(nodeId || "")).target;
  if (!target?.config) throw roster.error("ANXNET_NOT_AN_AGENT", "That computer doesn't run the AnxHost Agent.", 400);
  return agentClient.anxnetRequest(action, body, target.config);
}

async function agentStatus(nodeId) {
  return agentCall(nodeId, "status");
}

async function addComputer(nodeId) {
  const active = await requireNetwork();
  const nodeStatus = await active.call("status");
  if (nodeStatus.network?.role !== "owner") throw roster.error("ANXNET_OWNER_ONLY", "Only the computer that owns this AnxNet network can add other computers.", 403);
  const current = await agentStatus(nodeId);
  if (current?.network) {
    if (current.network.networkId === nodeStatus.network.networkId) return { already: true, agent: current, status: await status() };
    throw roster.error("ANXNET_AGENT_OTHER_NETWORK", `That computer is already in another AnxNet network (${current.network.name}).`, 409);
  }
  let name = "";
  try { name = require("./nodeService").getNode(nodeId)?.displayName || ""; } catch {}
  const invite = await active.call("createInvite", { ttlMs: 10 * 60 * 1000, maxUses: 1, preApproved: true, label: `AnxHost Agent: ${name || nodeId}`.slice(0, 60) });
  try {
    const joined = await agentCall(nodeId, "join", { code: invite.code, deviceName: name || undefined });
    return { agent: joined, status: await status() };
  } finally {
    // The code is single-use; withdraw it if the Agent didn't consume it.
    await active.call("revokeInvite", { inviteId: invite.invite?.inviteId }).catch(() => {});
  }
}

async function removeComputer(nodeId) {
  const current = await agentStatus(nodeId);
  if (current?.deviceId && current.network) {
    const active = await requireNetwork();
    await active.call("revokeDevice", { deviceId: current.deviceId }).catch(() => {});
  }
  const left = await agentCall(nodeId, "leave", {});
  return { agent: left, status: await status() };
}

async function agentShare(input = {}) {
  const shared = await agentCall(input.nodeId, "share", { instanceId: String(input.instanceId || ""), port: input.port, protocol: input.protocol, name: input.name });
  return { ...shared, status: await status() };
}

async function agentUnshare(input = {}) {
  const left = await agentCall(input.nodeId, "unshare", { serviceId: String(input.serviceId || "") });
  return { agent: left, status: await status() };
}

module.exports = {
  addComputer,
  agentShare,
  agentStatus,
  agentUnshare,
  removeComputer,
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
  _test: { devicePrivateKeyPem },
};
