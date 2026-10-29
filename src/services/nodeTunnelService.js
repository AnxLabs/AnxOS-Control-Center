"use strict";

// App-managed SSH tunnels for Agent nodes whose Agent only listens on the
// node itself (transport.type === "ssh-tunnel", see nodeService).
//
// For each such node the desktop listens on the node's loopback Agent URL
// (for example http://127.0.0.1:47132) and forwards every connection over one
// SSH session to transport.remoteHost:remotePort on the node. Requests keep
// using the node's Agent URL unchanged; the tunnel is transparent to
// agentClient.
//
// Security: the listener binds 127.0.0.1 only, and SSH uses the same rule as
// unattended SSH commands (key authentication, host key already approved by
// the user). The Agent token still authenticates every request end to end.
//
// Reliability: SSH keepalives detect dead links; a dropped session reconnects
// with exponential backoff (1s doubling to 60s). If another program already
// owns the local port (for example a manual `ssh -L`), the tunnel steps aside
// and reports "external" instead of fighting over the port.

const { EventEmitter } = require("events");
const net = require("net");

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 60000;
const LOOPBACK_HOST = "127.0.0.1";
const TUNNEL_STATES = Object.freeze(["connecting", "connected", "reconnecting", "external", "failed", "stopped"]);
// Errors that retrying cannot fix until the user changes something.
const PERMANENT_ERROR_CODES = new Set([
  "SSH_COMMAND_KEY_AUTH_REQUIRED",
  "SSH_HOST_KEY_NOT_APPROVED",
  "SSH_HOST_KEY_MISMATCH",
  "SSH_PROFILE_NOT_FOUND",
  "SSH_PROFILE_FIELDS_REQUIRED",
  "SSH_PRIVATE_KEY_READ_FAILED",
  "SSH_AUTH_FAILED",
]);

function localPortForNode(node = {}) {
  try {
    const url = new URL(String(node.baseUrl || node.agentUrl || ""));
    const port = Number(url.port);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function tunnelKey(node) {
  const t = node.transport || {};
  return [t.sshProfileId, t.remoteHost, t.remotePort, localPortForNode(node)].join("|");
}

function classifySshError(error, hostKeyState) {
  if (hostKeyState?.mismatch) return { code: "SSH_HOST_KEY_MISMATCH", message: "The node's SSH host key changed. Verify the server, then approve the new key in the SSH terminal." };
  const code = error?.code || null;
  if (code && PERMANENT_ERROR_CODES.has(code)) return { code, message: error.message };
  if (error?.level === "client-authentication") return { code: "SSH_AUTH_FAILED", message: "The SSH key was not accepted by the node." };
  if (["ECONNREFUSED", "ETIMEDOUT", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET"].includes(code)) {
    return { code: "SSH_UNREACHABLE", message: "The node's SSH port could not be reached." };
  }
  if (/timed out/i.test(String(error?.message || ""))) return { code: "SSH_UNREACHABLE", message: "Connecting to the node over SSH timed out." };
  return { code: code || "SSH_TUNNEL_FAILED", message: "The SSH tunnel to the node failed." };
}

function createNodeTunnelService(overrides = {}) {
  const deps = {
    getNodes: () => require("./nodeService").getAllNodesSync(),
    getSsh: () => {
      const { SshService } = require("./sshService");
      return new SshService();
    },
    createServer: (handler) => net.createServer(handler),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (timer) => clearTimeout(timer),
    reconnectMinMs: RECONNECT_MIN_MS,
    reconnectMaxMs: RECONNECT_MAX_MS,
    ...overrides,
  };
  const events = new EventEmitter();
  const tunnels = new Map();
  let ssh = null;

  function getSsh() {
    if (!ssh) ssh = deps.getSsh();
    return ssh;
  }

  function iso(ms) {
    return ms ? new Date(ms).toISOString() : null;
  }

  function statusOf(tunnel) {
    return {
      nodeId: tunnel.nodeId,
      state: tunnel.state,
      localPort: tunnel.localPort,
      remoteHost: tunnel.remoteHost,
      remotePort: tunnel.remotePort,
      sshProfileId: tunnel.sshProfileId,
      connectedAt: iso(tunnel.connectedAt),
      lastError: tunnel.lastError,
      attempts: tunnel.attempts,
      nextRetryAt: iso(tunnel.nextRetryAt),
      activeConnections: tunnel.sockets.size,
    };
  }

  function setState(tunnel, state, lastError = tunnel.lastError) {
    tunnel.state = state;
    tunnel.lastError = lastError;
    events.emit("status", statusOf(tunnel));
  }

  function scheduleReconnect(tunnel) {
    if (tunnel.stopped || tunnel.retryTimer) return;
    const delay = Math.min(deps.reconnectMaxMs, deps.reconnectMinMs * 2 ** Math.min(tunnel.attempts, 16));
    tunnel.nextRetryAt = deps.now() + delay;
    tunnel.retryTimer = deps.setTimeout(() => {
      tunnel.retryTimer = null;
      tunnel.nextRetryAt = null;
      connectSsh(tunnel);
    }, delay);
  }

  function dropClient(tunnel) {
    const client = tunnel.client;
    tunnel.client = null;
    tunnel.ready = false;
    if (client) {
      client.removeAllListeners();
      client.on("error", () => {});
      try { client.end(); } catch {}
    }
  }

  function connectSsh(tunnel) {
    if (tunnel.stopped || tunnel.client) return;
    let prepared;
    try {
      prepared = getSsh().createUnattendedConnectConfig(tunnel.sshProfileId);
    } catch (error) {
      const failure = classifySshError(error);
      tunnel.attempts += 1;
      setState(tunnel, "failed", failure);
      return;
    }
    const client = getSsh().createClient();
    tunnel.client = client;
    setState(tunnel, tunnel.connectedAt ? "reconnecting" : "connecting");
    let settledReady = false;
    client.on("ready", () => {
      settledReady = true;
      tunnel.ready = true;
      tunnel.attempts = 0;
      tunnel.connectedAt = deps.now();
      setState(tunnel, "connected", null);
    });
    const onDown = (error) => {
      if (tunnel.client !== client) return;
      dropClient(tunnel);
      for (const socket of tunnel.sockets) socket.destroy();
      if (tunnel.stopped) return;
      const failure = error ? classifySshError(error, prepared.hostKeyState) : { code: "SSH_DISCONNECTED", message: "The SSH session to the node closed." };
      tunnel.attempts += 1;
      if (PERMANENT_ERROR_CODES.has(failure.code)) {
        setState(tunnel, "failed", failure);
        return;
      }
      setState(tunnel, settledReady || tunnel.connectedAt ? "reconnecting" : "connecting", failure);
      scheduleReconnect(tunnel);
    };
    client.on("error", onDown);
    client.on("close", () => onDown(null));
    client.connect(prepared.connectConfig);
  }

  function handleSocket(tunnel, socket) {
    socket.on("error", () => {});
    if (!tunnel.ready || !tunnel.client) {
      // Fail fast so the request reports "unavailable" instead of hanging,
      // and nudge a waiting reconnect to try now.
      socket.destroy();
      if (tunnel.retryTimer && tunnel.state !== "failed") {
        deps.clearTimeout(tunnel.retryTimer);
        tunnel.retryTimer = null;
        tunnel.nextRetryAt = null;
        connectSsh(tunnel);
      }
      return;
    }
    tunnel.sockets.add(socket);
    socket.on("close", () => tunnel.sockets.delete(socket));
    tunnel.client.forwardOut(LOOPBACK_HOST, socket.remotePort || 0, tunnel.remoteHost, tunnel.remotePort, (error, stream) => {
      if (error || !stream) {
        socket.destroy();
        return;
      }
      stream.on("error", () => socket.destroy());
      socket.pipe(stream).pipe(socket);
    });
  }

  function startTunnel(node) {
    const tunnel = {
      nodeId: node.id,
      key: tunnelKey(node),
      sshProfileId: node.transport.sshProfileId,
      remoteHost: node.transport.remoteHost,
      remotePort: node.transport.remotePort,
      localPort: localPortForNode(node),
      state: "connecting",
      lastError: null,
      attempts: 0,
      connectedAt: null,
      nextRetryAt: null,
      retryTimer: null,
      client: null,
      ready: false,
      stopped: false,
      server: null,
      sockets: new Set(),
    };
    tunnels.set(node.id, tunnel);
    const server = deps.createServer((socket) => handleSocket(tunnel, socket));
    tunnel.server = server;
    server.on("error", (error) => {
      if (tunnel.stopped) return;
      if (error?.code === "EADDRINUSE") {
        setState(tunnel, "external", { code: "LOCAL_PORT_IN_USE", message: `Another program already serves 127.0.0.1:${tunnel.localPort}; AnxOS is using it as is.` });
        return;
      }
      setState(tunnel, "failed", { code: error?.code || "TUNNEL_LISTEN_FAILED", message: "AnxOS could not open the local tunnel port." });
    });
    server.listen(tunnel.localPort, LOOPBACK_HOST, () => connectSsh(tunnel));
    events.emit("status", statusOf(tunnel));
    return tunnel;
  }

  function stopTunnel(nodeId) {
    const tunnel = tunnels.get(nodeId);
    if (!tunnel) return;
    tunnel.stopped = true;
    tunnels.delete(nodeId);
    if (tunnel.retryTimer) deps.clearTimeout(tunnel.retryTimer);
    for (const socket of tunnel.sockets) socket.destroy();
    dropClient(tunnel);
    try { tunnel.server?.close(); } catch {}
    tunnel.state = "stopped";
    events.emit("status", statusOf(tunnel));
  }

  // Brings running tunnels in line with node configuration: starts tunnels
  // for enabled ssh-tunnel nodes, restarts changed ones, stops the rest.
  function sync() {
    let nodes = [];
    try {
      nodes = deps.getNodes() || [];
    } catch {
      return listStatus();
    }
    const wanted = new Map(nodes
      .filter((node) => node.kind === "agent" && node.enabled !== false && node.manualDisconnect !== true && node.transport?.type === "ssh-tunnel" && localPortForNode(node))
      .map((node) => [node.id, node]));
    for (const nodeId of [...tunnels.keys()]) {
      const node = wanted.get(nodeId);
      const tunnel = tunnels.get(nodeId);
      // An "external" tunnel retries the port on each sync, so AnxOS takes
      // over once a manual tunnel goes away.
      if (!node || tunnelKey(node) !== tunnel.key || tunnel.state === "external") stopTunnel(nodeId);
    }
    for (const [nodeId, node] of wanted) {
      if (!tunnels.has(nodeId)) startTunnel(node);
    }
    return listStatus();
  }

  // Retry now (for example after the user approved a host key).
  function reconnect(nodeId) {
    const tunnel = tunnels.get(nodeId);
    if (!tunnel) return null;
    if (tunnel.retryTimer) {
      deps.clearTimeout(tunnel.retryTimer);
      tunnel.retryTimer = null;
      tunnel.nextRetryAt = null;
    }
    if (tunnel.state === "external") {
      stopTunnel(nodeId);
      sync();
      return getStatus(nodeId);
    }
    dropClient(tunnel);
    connectSsh(tunnel);
    return statusOf(tunnel);
  }

  function getStatus(nodeId) {
    const tunnel = tunnels.get(nodeId);
    return tunnel ? statusOf(tunnel) : null;
  }

  function listStatus() {
    return [...tunnels.values()].map(statusOf);
  }

  function stopAll() {
    for (const nodeId of [...tunnels.keys()]) stopTunnel(nodeId);
  }

  return { sync, reconnect, getStatus, listStatus, stopAll, onStatus: (listener) => events.on("status", listener) };
}

let defaultService = null;
function getNodeTunnelService() {
  if (!defaultService) defaultService = createNodeTunnelService();
  return defaultService;
}

module.exports = {
  TUNNEL_STATES,
  createNodeTunnelService,
  getNodeTunnelService,
  _test: { classifySshError, localPortForNode },
};
