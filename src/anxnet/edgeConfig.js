"use strict";

// Checks an AnxNet edge config (edge.json) before the edge listens, so a
// mistake is reported in words instead of surfacing later as a gateway that
// publishes the wrong ports or serves nobody. Used by
// src/anxnet/bin/anxnet-edge.js (normal start and --check).
//
// The rules that matter most for a public server:
// - the gateway's public port range may never include a management port
//   (SSH, the Agent, Docker, Remote Desktop...) or the edge's own port;
// - a gateway needs the public address players will use;
// - every network entry needs a real owner public key, or the edge would
//   accept nobody.

const crypto = require("crypto");
const net = require("net");
const path = require("path");
const { MANAGEMENT_PORTS } = require("./roster");

const KNOWN_KEYS = new Set(["dataDir", "listenHost", "port", "networks", "relay", "gateway", "maxConnections", "grantSweepMs"]);
const KNOWN_RELAY_KEYS = new Set(["enabled", "maxSessionsPerNetwork", "maxSessions", "bytesPerSecond", "idleMs"]);
const KNOWN_GATEWAY_KEYS = new Set(["enabled", "bindHost", "publicHost", "portRange", "maxRoutesPerNetwork", "maxConnsPerRoute", "maxFlowsPerRoute", "bytesPerSecond", "flowIdleMs", "hostGraceMs"]);
const MAX_GATEWAY_PORTS = 1000;
const MAX_NETWORKS = 32;

function isPort(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isPrivateOrLocal(host) {
  if (host === "localhost") return true;
  if (!net.isIP(host)) return false;
  if (net.isIPv4(host)) {
    const [a, b] = host.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0;
  }
  const lower = host.toLowerCase();
  return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80");
}

function checkPositive(section, key, value, errors, max = Number.MAX_SAFE_INTEGER) {
  if (value === undefined) return;
  if (!Number.isFinite(value) || value <= 0 || value > max) errors.push(`${section}.${key} must be a positive number${max < Number.MAX_SAFE_INTEGER ? ` up to ${max}` : ""}.`);
}

function unknownKeys(object, known, label, warnings) {
  for (const key of Object.keys(object || {})) {
    if (!known.has(key)) warnings.push(`${label}${key} is not a known setting and is ignored (check the spelling).`);
  }
}

// Returns { ok, errors, warnings, summary }. errors stop the edge; warnings
// are printed and the edge still starts.
function validateEdgeConfig(config) {
  const errors = [];
  const warnings = [];
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return { ok: false, errors: ["The config file must hold one JSON object."], warnings, summary: null };
  }
  unknownKeys(config, KNOWN_KEYS, "", warnings);

  if (typeof config.dataDir !== "string" || !config.dataDir.trim()) errors.push("Set dataDir: the folder for the edge's key, for example /var/lib/anxnet-edge.");
  else if (!path.isAbsolute(config.dataDir)) errors.push("dataDir must be an absolute path, so the edge always finds the same key.");

  const port = config.port === undefined ? 47700 : config.port;
  if (!isPort(port)) errors.push("port must be a whole number from 1 to 65535.");
  else if (MANAGEMENT_PORTS.has(port)) errors.push(`port ${port} is ${MANAGEMENT_PORTS.get(port)}'s port. Pick another one, for example 47700.`);
  if (config.listenHost !== undefined && (typeof config.listenHost !== "string" || !config.listenHost.trim())) errors.push("listenHost must be an address, for example 0.0.0.0.");

  if (!Array.isArray(config.networks) || !config.networks.length) {
    errors.push("List at least one network in networks. AnxHost shows the entry under Computers > AnxNet > Relay and gateway (Copy edge config).");
  } else if (config.networks.length > MAX_NETWORKS) {
    errors.push(`An edge serves at most ${MAX_NETWORKS} networks.`);
  } else {
    const seen = new Set();
    config.networks.forEach((entry, index) => {
      const label = `networks[${index}]`;
      if (!entry || typeof entry !== "object") { errors.push(`${label} must be an object with networkId and ownerPublicKey.`); return; }
      if (!/^net-[a-z2-7]{26}$/.test(String(entry.networkId || ""))) errors.push(`${label}.networkId is not an AnxNet network id (net-…).`);
      else if (seen.has(entry.networkId)) errors.push(`${label}.networkId is listed twice.`);
      else seen.add(entry.networkId);
      try {
        crypto.createPublicKey({ key: Buffer.from(String(entry.ownerPublicKey || ""), "base64"), format: "der", type: "spki" });
      } catch {
        errors.push(`${label}.ownerPublicKey is not a public key. Copy it from AnxHost instead of typing it.`);
      }
    });
  }

  const relay = config.relay || {};
  const gateway = config.gateway || {};
  if (config.relay !== undefined && (typeof config.relay !== "object" || Array.isArray(config.relay))) errors.push("relay must be an object, for example { \"enabled\": true }.");
  if (config.gateway !== undefined && (typeof config.gateway !== "object" || Array.isArray(config.gateway))) errors.push("gateway must be an object, for example { \"enabled\": false }.");
  unknownKeys(relay, KNOWN_RELAY_KEYS, "relay.", warnings);
  unknownKeys(gateway, KNOWN_GATEWAY_KEYS, "gateway.", warnings);
  const relayOn = relay.enabled !== false;
  const gatewayOn = gateway.enabled === true;
  for (const key of ["maxSessionsPerNetwork", "maxSessions", "bytesPerSecond", "idleMs"]) checkPositive("relay", key, relay[key], errors);
  for (const key of ["maxRoutesPerNetwork", "maxConnsPerRoute", "maxFlowsPerRoute", "bytesPerSecond", "flowIdleMs", "hostGraceMs"]) checkPositive("gateway", key, gateway[key], errors);
  if (!relayOn && !gatewayOn) errors.push("Both the relay and the gateway are off, so the edge would do nothing. Turn one on.");

  let portRange = null;
  if (gatewayOn) {
    if (typeof gateway.publicHost !== "string" || !gateway.publicHost.trim()) {
      errors.push("gateway.publicHost is required: the public IP or name players connect to.");
    } else if (isPrivateOrLocal(gateway.publicHost.trim())) {
      warnings.push(`gateway.publicHost ${gateway.publicHost} is not a public address. Only devices on that network can join through it.`);
    }
    const range = gateway.portRange === undefined ? [30000, 30099] : gateway.portRange;
    if (!Array.isArray(range) || range.length !== 2 || !range.every(isPort) || range[0] > range[1]) {
      errors.push("gateway.portRange must be [first, last], two ports with first ≤ last, for example [30000, 30099].");
    } else if (range[0] < 1024) {
      errors.push("gateway.portRange must start at 1024 or above.");
    } else if (range[1] - range[0] + 1 > MAX_GATEWAY_PORTS) {
      errors.push(`gateway.portRange may cover at most ${MAX_GATEWAY_PORTS} ports.`);
    } else {
      const blocked = [...MANAGEMENT_PORTS.entries()].filter(([value]) => value >= range[0] && value <= range[1]);
      if (blocked.length) errors.push(`gateway.portRange includes ${blocked.map(([value, name]) => `${value} (${name})`).join(", ")}. A public gateway must never publish management ports.`);
      if (isPort(port) && port >= range[0] && port <= range[1]) errors.push(`gateway.portRange includes the edge's own port ${port}.`);
      portRange = range;
    }
  }

  const summary = errors.length ? null : {
    listen: `${config.listenHost || "0.0.0.0"}:${port}`,
    relay: relayOn,
    gateway: gatewayOn ? { publicHost: gateway.publicHost.trim(), portRange } : null,
    networks: config.networks.map((entry) => entry.networkId),
    // What the server's firewall has to allow, and nothing else.
    firewall: [`${port}/tcp (edge)`, ...(portRange ? [`${portRange[0]}-${portRange[1]}/tcp and /udp (gateway routes)`] : [])],
  };
  return { ok: errors.length === 0, errors, warnings, summary };
}

module.exports = { validateEdgeConfig, MAX_GATEWAY_PORTS };
