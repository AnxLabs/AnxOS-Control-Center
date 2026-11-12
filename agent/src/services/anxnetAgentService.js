"use strict";

// AnxNet inside the Agent (Phase 7.1). The same AnxNet node the desktop uses
// (src/anxnet/node.js), run by the Agent, so a computer's game servers can be
// shared with an AnxNet network from that computer itself, without the
// desktop being on. Not a second agent and not a second backend.
//
// * Joining needs an invite from the network's owner, delivered through the
//   Agent's authenticated API (public-access:write). The Agent never creates
//   networks or invites.
// * It can share only its own servers' declared game ports, on loopback.
//   SSH, Docker, RDP, VNC, WinRM, this Agent's own port and the phone
//   gateway's are refused (roster.MANAGEMENT_PORTS plus blockedPorts).
// * It doesn't run a name resolver or local forwards: a server shares, it
//   doesn't consume other members' services.
// * Its device key and network state stay in the Agent's data folder (0600).

const fs = require("fs");
const os = require("os");
const path = require("path");
const { AnxNetNode } = require("../../../src/anxnet/node");
const { getConfig } = require("../config");

const DEFAULT_LISTEN_PORT = 47711;
let node = null;
let starting = null;

function anxnetRoot() {
  return path.resolve(process.env.AGENT_ANXNET_ROOT || path.join(path.dirname(getConfig().instanceRoot), "anxnet"));
}

function settings() {
  const port = Number(process.env.AGENT_ANXNET_PORT || DEFAULT_LISTEN_PORT);
  return {
    listenHost: process.env.AGENT_ANXNET_HOST === "127.0.0.1" ? "127.0.0.1" : "0.0.0.0",
    listenPort: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_LISTEN_PORT,
  };
}

function hasNetwork() {
  try {
    return Boolean(JSON.parse(fs.readFileSync(path.join(anxnetRoot(), "anxnet-state.json"), "utf8")).network);
  } catch {
    return false;
  }
}

function anxnetError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode });
}

async function ensureNode() {
  if (node) return node;
  if (starting) return starting;
  starting = (async () => {
    fs.mkdirSync(anxnetRoot(), { recursive: true, mode: 0o700 });
    const { listenHost, listenPort } = settings();
    const candidate = new AnxNetNode({
      dataDir: anxnetRoot(),
      listenHost,
      listenPort,
      enableDns: false,
      enableForwards: false,
      deviceName: os.hostname(),
      blockedPorts: [{ port: getConfig().port, name: "the AnxOS Agent" }],
    });
    try {
      await candidate.start();
    } catch (error) {
      if (error && error.code === "EADDRINUSE") {
        throw anxnetError("ANXNET_PORT_IN_USE", `Port ${listenPort} is already in use on this computer. Set AGENT_ANXNET_PORT to a free port.`, 409);
      }
      throw error;
    }
    node = candidate;
    return node;
  })();
  try {
    return await starting;
  } finally {
    starting = null;
  }
}

// What the desktop shows for this computer; no keys, no invites.
function publicStatus(status) {
  const network = status?.network || null;
  return {
    running: Boolean(node),
    deviceId: status?.deviceId || null,
    fingerprint: status?.fingerprint || null,
    listening: status?.listening || null,
    network: network ? { networkId: network.networkId, name: network.name, domain: network.domain, role: network.role, coordinator: network.coordinator } : null,
    devices: (status?.devices || []).map((device) => ({ deviceId: device.deviceId, name: device.name, hostname: device.hostname, role: device.role, self: device.self, connection: device.connection, latencyMs: device.latencyMs })),
    services: (status?.services || []).filter((service) => service.local).map((service) => ({ serviceId: service.serviceId, name: service.name, hostname: service.hostname, port: service.port, protocol: service.protocol, instanceId: service.instanceId || null })),
  };
}

async function getStatus() {
  if (!node && !hasNetwork()) return publicStatus(null);
  return publicStatus((await ensureNode()).status());
}

async function join({ code, deviceName } = {}) {
  if (typeof code !== "string" || code.length < 20 || code.length > 4096) throw anxnetError("ANXNET_INVITE_FORMAT", "Paste the whole invite code from the network's owner.");
  const active = await ensureNode();
  if (active.status().network) throw anxnetError("ANXNET_ALREADY_MEMBER", "This computer is already in an AnxNet network. Leave it first.", 409);
  const joined = await active.joinNetwork(code, { deviceName: String(deviceName || os.hostname()).slice(0, 60) });
  // Invites that aren't pre-approved wait for the owner to approve.
  return { ...publicStatus(active.status()), pendingApproval: Boolean(joined && joined.pendingApproval) };
}

async function leave() {
  if (!node && !hasNetwork()) return publicStatus(null);
  const active = await ensureNode();
  await active.leaveNetwork();
  return publicStatus(active.status());
}

// Shares one of this computer's servers. The port must be one the server
// declares; the target is always this computer.
async function share({ instanceId, port, protocol, name, allow } = {}, { loadInstance }) {
  const active = await ensureNode();
  if (!active.status().network) throw anxnetError("ANXNET_NOT_RUNNING", "This computer isn't in an AnxNet network yet.", 409);
  const instance = await loadInstance(String(instanceId || ""));
  const ports = Array.isArray(instance.ports) ? instance.ports.map(Number).filter(Number.isInteger) : [];
  const chosen = port === undefined || port === null ? ports[0] : Number(port);
  if (!ports.length || !ports.includes(chosen)) throw anxnetError("ANXNET_SERVICE_PORT", "Choose one of this server's own ports.", 400);
  const service = await active.shareService({
    name: String(name || instance.displayName || instance.id).slice(0, 64),
    port: chosen,
    protocol: ["tcp", "udp", "both"].includes(protocol) ? protocol : "tcp",
    targetHost: "127.0.0.1",
    targetPort: chosen,
    allow: allow === undefined ? "members" : allow,
    instanceId: instance.id,
  });
  return { service: { serviceId: service.serviceId, name: service.name, hostname: service.hostname, port: service.port, protocol: service.protocol }, status: publicStatus(active.status()) };
}

async function unshare({ serviceId } = {}) {
  const active = await ensureNode();
  await active.unshareService(String(serviceId || ""));
  return publicStatus(active.status());
}

// Called when the Agent starts: resume only if it was already in a network.
async function resume() {
  if (!hasNetwork()) return null;
  return ensureNode();
}

async function shutdown() {
  const active = node;
  node = null;
  if (active) await active.stop().catch(() => {});
}

module.exports = { getStatus, join, leave, resume, share, shutdown, unshare, anxnetRoot };
