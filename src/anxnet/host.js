"use strict";

// AnxNet host: runs this computer's AnxNet node in its own background
// process, so networks, shared servers and public routes keep working while
// the Control Center window is closed. The same module can be embedded in
// the AnxOS Agent later (it only needs a data folder and a key).
//
// Control: JSON lines over a local pipe (Windows named pipe, Unix socket),
// every request carrying a random token kept in a 0600 file in the data
// folder. Only the methods listed in METHODS can be called.
// Single instance: the pipe name is derived from the data folder; a second
// host finds the pipe answering and exits instead of starting a duplicate.
// Key: the device key is handed over by the desktop (decrypted with Electron
// safeStorage there) and kept in memory only; a headless host can instead
// read a 0600 key file.
// Nothing here changes OS DNS, routing or firewall settings.

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const { AnxNetNode } = require("./node");
const { jsonLineReader, sendJsonLine } = require("./frames");

const IDLE_EXIT_MS = 30000;
const MAX_CLIENTS = 8;
const LOG_LIMIT_BYTES = 1024 * 1024;

function pipePathFor(dataDir) {
  const id = crypto.createHash("sha256").update(path.resolve(dataDir).toLowerCase()).digest("hex").slice(0, 16);
  return process.platform === "win32" ? `\\\\.\\pipe\\anxnet-host-${id}` : path.join(dataDir, "anxnet-host.sock");
}

function tokenPathFor(dataDir) {
  return path.join(dataDir, "anxnet-host.token");
}

function createLogger(dataDir) {
  const file = path.join(dataDir, "anxnet-host.log");
  return (level, message, details = {}) => {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > LOG_LIMIT_BYTES) fs.renameSync(file, `${file}.1`);
      // Codes and messages only: never keys, tokens, invites or rosters.
      fs.appendFileSync(file, `${new Date().toISOString()} ${level} ${message} ${JSON.stringify(details)}\n`, { mode: 0o600 });
    } catch {}
  };
}

// Methods a client may call, mapped to the node. Arguments are passed as
// given; the node validates them.
const METHODS = {
  status: (node) => node.status(),
  createNetwork: (node, params) => node.createNetwork(params || {}),
  joinNetwork: (node, params) => node.joinNetwork(String(params?.code || ""), { deviceName: params?.deviceName }),
  leaveNetwork: (node) => node.leaveNetwork(),
  createInvite: (node, params) => node.createInvite(params || {}),
  revokeInvite: (node, params) => node.revokeInvite(String(params?.inviteId || "")),
  approveDevice: (node, params) => node.approveDevice(String(params?.deviceId || "")),
  rejectDevice: (node, params) => node.rejectDevice(String(params?.deviceId || "")),
  revokeDevice: (node, params) => node.revokeDevice(String(params?.deviceId || "")),
  renameNetwork: (node, params) => node.renameNetwork(String(params?.name || "")),
  renameDevice: (node, params) => node.renameDevice(String(params?.deviceId || ""), String(params?.name || "")),
  setEdges: (node, params) => node.setEdges(params || {}),
  shareService: (node, params) => node.shareService(params || {}),
  unshareService: (node, params) => node.unshareService(String(params?.serviceId || "")),
  signGatewayGrant: (node, params) => node.signGatewayGrant(params || {}),
  publish: (node, params) => node.publish(params || {}),
  unpublish: (node, params) => node.unpublish(String(params?.routeId || "")),
  unpublishService: (node, params) => node.unpublishService(String(params?.serviceId || "")),
  setDirectInbound: (node, params) => { node.options.directInbound = params?.enabled !== false; return node.status(); },
  setDnsEndpoint: (node, params) => node.setDnsEndpoint({ port: Number(params?.port) || 5353 }),
  testPeer: async (node, params) => {
    const started = Date.now();
    const peer = await node.ensurePeer(String(params?.deviceId || ""));
    return { path: peer.path, connectMs: Date.now() - started, latencyMs: peer.latencyMs };
  },
  usage: () => ({ pid: process.pid, uptimeSeconds: Math.round(process.uptime()), cpu: process.cpuUsage(), rss: process.memoryUsage().rss }),
};

async function startHost(options = {}) {
  const dataDir = options.dataDir;
  if (!dataDir) throw new Error("ANXNET_DATA_DIR_REQUIRED");
  fs.mkdirSync(dataDir, { recursive: true });
  const log = createLogger(dataDir);
  const pipePath = options.pipePath || pipePathFor(dataDir);
  const token = crypto.randomBytes(32).toString("hex");
  const clients = new Set();
  let node = null;
  let keyPem = options.keyPem || null;
  let idleTimer = null;
  let stopping = false;

  const server = net.createServer((socket) => {
    if (clients.size >= MAX_CLIENTS) { socket.destroy(); return; }
    clients.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => { clients.delete(socket); scheduleIdleExit(); });
    jsonLineReader(socket, (message) => handle(socket, message), { maxLineBytes: 128 * 1024 });
  });

  // Exit when this computer is in no network and nobody is connected.
  function scheduleIdleExit() {
    clearTimeout(idleTimer);
    if (options.stayAlive) return;
    idleTimer = setTimeout(() => {
      if (!clients.size && !(node && node.status().network)) stop("idle").catch(() => {});
    }, IDLE_EXIT_MS);
    idleTimer.unref?.();
  }

  async function ensureNode() {
    if (node?.started) return node;
    if (!keyPem) throw Object.assign(new Error("The AnxNet host is waiting for this computer's key."), { code: "ANXNET_HOST_LOCKED" });
    const pem = keyPem;
    node = new AnxNetNode({ ...(options.nodeOptions || {}), dataDir, keyStore: { read: () => pem, write: () => {} } });
    node.on("change", () => { for (const socket of clients) if (socket.subscribed) sendJsonLine(socket, { event: "change" }); });
    node.on("pending", (entry) => { for (const socket of clients) if (socket.subscribed) sendJsonLine(socket, { event: "pending", data: { name: entry.name } }); });
    node.on("warning", (warning) => log("warn", warning.code || "warning", {}));
    await node.start();
    log("info", "node-started", { deviceId: node.identity.deviceId });
    return node;
  }

  async function handle(socket, message) {
    const reply = (body) => sendJsonLine(socket, { id: message.id, ...body });
    const presented = Buffer.from(String(message.token || ""));
    const expected = Buffer.from(token);
    if (presented.length !== expected.length || !crypto.timingSafeEqual(presented, expected)) {
      reply({ error: { code: "ANXNET_HOST_UNAUTHORIZED", message: "Not allowed." } });
      socket.destroy();
      return;
    }
    try {
      if (message.method === "ping") return reply({ result: { pid: process.pid, unlocked: Boolean(keyPem), running: Boolean(node?.started) } });
      if (message.method === "subscribe") { socket.subscribed = true; return reply({ result: true }); }
      if (message.method === "unlock") {
        const pem = String(message.params?.keyPem || "");
        if (!/-----BEGIN PRIVATE KEY-----/.test(pem)) throw Object.assign(new Error("That isn't a device key."), { code: "ANXNET_HOST_KEY_INVALID" });
        if (keyPem && keyPem !== pem) throw Object.assign(new Error("This host already runs with another key."), { code: "ANXNET_HOST_KEY_MISMATCH" });
        keyPem = pem;
        await ensureNode();
        return reply({ result: node.status() });
      }
      if (message.method === "shutdown") { reply({ result: true }); setTimeout(() => stop("requested").catch(() => {}), 50); return undefined; }
      const method = METHODS[message.method];
      if (!method) throw Object.assign(new Error("Unknown method."), { code: "ANXNET_HOST_METHOD" });
      const active = message.method === "usage" ? null : await ensureNode();
      const result = await method(active, message.params);
      if (message.method === "leaveNetwork") scheduleIdleExit();
      return reply({ result });
    } catch (error) {
      if (!String(error?.code || "").startsWith("ANXNET_")) log("error", message.method, { code: error?.code || null });
      return reply({ error: { code: error?.code || "ANXNET_HOST_ERROR", message: error?.message || "Request failed." } });
    }
  }

  async function stop(reason) {
    if (stopping) return;
    stopping = true;
    log("info", "stopping", { reason });
    clearTimeout(idleTimer);
    for (const socket of clients) socket.destroy();
    await node?.stop().catch(() => {});
    await new Promise((resolve) => server.close(() => resolve()));
    try { fs.unlinkSync(tokenPathFor(dataDir)); } catch {}
    if (process.platform !== "win32") { try { fs.unlinkSync(pipePath); } catch {} }
    options.onStopped?.(reason);
  }

  // Single instance: refuse if another host answers on the pipe.
  const busy = await new Promise((resolve) => {
    const probe = net.connect(pipePath);
    probe.once("connect", () => { probe.destroy(); resolve(true); });
    probe.once("error", () => resolve(false));
  });
  if (busy) throw Object.assign(new Error("AnxNet is already running for this data folder."), { code: "ANXNET_HOST_RUNNING" });
  if (process.platform !== "win32") { try { fs.unlinkSync(pipePath); } catch {} }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipePath, () => { server.off("error", reject); resolve(); });
  });
  if (process.platform !== "win32") { try { fs.chmodSync(pipePath, 0o600); } catch {} }
  // Written after the pipe is ours, so a losing duplicate never overwrites it.
  fs.writeFileSync(tokenPathFor(dataDir), token, { mode: 0o600 });
  log("info", "host-started", { pid: process.pid, platform: os.platform() });
  if (keyPem) await ensureNode().catch((error) => log("error", "start", { code: error.code || null }));
  scheduleIdleExit();
  return { pipePath, stop, status: () => node?.status() || null };
}

module.exports = { METHODS, pipePathFor, startHost, tokenPathFor };
