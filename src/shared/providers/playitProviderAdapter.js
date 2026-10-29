"use strict";

// Playit.gg provider adapter. Pure mapper only: the desktop and agent Playit
// services (src/services/playitService.js and agent/src/services/playitService.js)
// own detection and produce the snapshot consumed here — installed, running,
// connected, tunnelAddress, tunnelDomain, localTarget, localIp, localPort,
// protocol, tunnelId, version, lastCheckedAt, diagnostics, tunnels. This module
// maps that snapshot into the one canonical provider shape defined by
// src/shared/providerAdapterContract.js. No fs, no network, no child processes.
//
// createTunnel / deleteTunnel stay false: AnxOS does not create or delete
// provider tunnels today. The detected Playit integration does not expose a
// safe local API for provider-side tunnel management, so those capabilities are
// declared absent rather than approximated. New tunnels are made in Playit.gg
// itself and reconciled here after Playit reports them.

const {
  normalizeProviderState,
  normalizeTunnel,
} = require("../providerAdapterContract");

// The drift table for this adapter. The smoke deep-equals
// createPlayitProviderAdapter().capabilities against this object, so a
// capability change must be made here and in the adapter at once.
const PLAYIT_PROVIDER_CAPABILITIES = Object.freeze({
  detect: true,
  status: true,
  listTunnels: true,
  controlAgent: true,
  publicAddress: true,
  localTarget: true,
  region: true,
  endpointDiscovery: true,
  createTunnel: false,
  deleteTunnel: false,
});

// Auth-required evidence only: these markers come from what Playit itself
// reported (diagnostics text or explicit booleans in the snapshot). A missing
// marker is never turned into auth-required.
const AUTH_REQUIRED_PATTERN = /(?:auth(?:entication|orization)?(?:\s+is)?\s*required|not\s+(?:logged|signed)\s+in|not\s+authenticated|unauthenticated|unauthori[sz]ed|needs?\s+(?:login|sign[ -]?in|authentication)|(?:login|sign[ -]?in)\s+required|please\s+(?:log|sign)\s+in)/i;
const MAX_AUTH_SCAN_STRINGS = 50;
const MAX_AUTH_SCAN_DEPTH = 3;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function toStr(value) {
  if (typeof value === "string") {
    const text = value.trim();
    return text || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function toInt(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{1,5}$/.test(value.trim())) return Number.parseInt(value.trim(), 10);
  return null;
}

function joinHostPort(host, port) {
  if (!host) return null;
  if (port === null) return host;
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

// The real snapshot carries diagnostics as a rich object. The canonical shape
// only has { code, message } entries, so one summary entry is produced when the
// snapshot reports a reason, an error code or a failure; a fully healthy
// diagnostics object produces no entry rather than noise.
function snapshotDiagnostics(snapshot) {
  const raw = snapshot.diagnostics;
  if (Array.isArray(raw)) {
    return raw.filter((entry) => typeof entry === "string" || isPlainObject(entry));
  }
  if (isPlainObject(raw)) {
    const code = toStr(raw.errorCode) || toStr(raw.reason);
    const message = toStr(raw.message);
    if (!code && !message && raw.ok !== false) return [];
    return [{ code: code || "PLAYIT_DIAGNOSTIC", message: message || code || "Playit diagnostics reported a failure." }];
  }
  if (typeof raw === "string" && raw.trim()) {
    return [{ code: "PLAYIT_DIAGNOSTIC", message: raw.trim() }];
  }
  return [];
}

function collectStrings(value, depth = 0, output = []) {
  if (depth > MAX_AUTH_SCAN_DEPTH || output.length >= MAX_AUTH_SCAN_STRINGS) return output;
  if (typeof value === "string") {
    output.push(value);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  const entries = Array.isArray(value)
    ? value.slice(0, MAX_AUTH_SCAN_STRINGS)
    : Object.values(value).slice(0, MAX_AUTH_SCAN_STRINGS);
  for (const entry of entries) collectStrings(entry, depth + 1, output);
  return output;
}

function hasAuthEvidence(snapshot) {
  if (snapshot.authenticated === false) return true;
  if (snapshot.authRequired === true || snapshot.signInRequired === true) return true;
  return collectStrings(snapshot.diagnostics).some((text) => AUTH_REQUIRED_PATTERN.test(text));
}

function collectTunnels(snapshot) {
  const entries = Array.isArray(snapshot.tunnels) ? snapshot.tunnels : [];
  const tunnels = [];
  let skipped = 0;
  for (const entry of entries) {
    const tunnel = normalizeTunnel(entry);
    if (tunnel) tunnels.push(tunnel);
    else skipped += 1;
  }
  return { tunnels, skipped };
}

function listTunnels(snapshot) {
  return collectTunnels(isPlainObject(snapshot) ? snapshot : {}).tunnels;
}

// detect() and status() both produce the canonical provider state, so a
// consumer never branches on which one it called.
function mapPlayitSnapshot(raw = {}) {
  const snapshot = isPlainObject(raw) ? raw : {};
  const { tunnels, skipped } = collectTunnels(snapshot);
  const installed = snapshot.installed;
  const running = snapshot.running;
  const connected = snapshot.connected === true ? true : snapshot.connected === false ? false : null;
  const authEvidence = hasAuthEvidence(snapshot);

  const diagnostics = snapshotDiagnostics(snapshot);
  if (authEvidence && installed !== false) {
    diagnostics.push({
      code: "PLAYIT_AUTH_REQUIRED",
      message: "Playit reports that sign-in or authentication is required.",
    });
  }
  if (skipped > 0) {
    diagnostics.push({
      code: "PLAYIT_TUNNEL_SKIPPED",
      message: `${skipped} tunnel entries skipped`,
    });
  }

  // installed === false wins: there is nothing to authenticate. A running,
  // connected tunnel also wins: that is live evidence, not a stale auth note.
  const authRequired = authEvidence
    && installed !== false
    && !(running === true && connected === true);

  let state;
  let availability;
  let outConnected = connected;

  if (installed === false) {
    state = "not-installed";
    availability = "unavailable";
  } else if (authRequired) {
    state = "auth-required";
    availability = installed === true ? "available" : "unknown";
    outConnected = null;
  } else if (installed === true && running === false) {
    state = "stopped";
    availability = "available";
  } else if (running === true && connected === false) {
    state = "degraded";
    availability = installed === true ? "available" : "unknown";
    outConnected = false;
  } else if (running === true) {
    state = "running";
    availability = installed === true ? "available" : "unknown";
    outConnected = connected === true ? true : null;
  } else if (connected === true) {
    state = "running";
    availability = installed === true ? "available" : "unknown";
  } else {
    state = "unknown";
    availability = installed === true ? "available" : "unknown";
  }

  const publicAddress = toStr(snapshot.publicAddress)
    || toStr(snapshot.tunnelAddress)
    || (tunnels[0] ? tunnels[0].publicAddress : null)
    || null;
  const localTarget = toStr(snapshot.localTarget) || joinHostPort(toStr(snapshot.localIp), toInt(snapshot.localPort));

  return normalizeProviderState({
    providerId: "playit",
    displayName: "Playit.gg",
    availability,
    state,
    connected: outConnected,
    version: snapshot.version,
    region: snapshot.region,
    publicAddress,
    localTarget,
    tunnels,
    lastCheckedAt: snapshot.lastCheckedAt,
    diagnostics,
  });
}

// Turns one canonical tunnel into an endpoint-model input. When the tunnel has
// no public port, the only port actually observed is the tunnel's LOCAL port,
// and that is what the endpoint carries: this helper never invents a public
// port. The metadata key set is fixed; nothing else may enter it.
function endpointFromTunnel(tunnel, options = {}) {
  const context = isPlainObject(options) ? options : {};
  const computerId = toStr(context.computerId);
  const serviceId = toStr(context.serviceId);
  const normalized = normalizeTunnel(tunnel) || {};
  const host = normalized.publicHost || null;
  const tunnelId = normalized.id || null;
  const tunnelName = normalized.name || null;
  const name = tunnelName || `Playit ${tunnelId || host || "tunnel"}`;

  return {
    name,
    type: "public",
    host,
    port: normalized.publicPort !== null && normalized.publicPort !== undefined
      ? normalized.publicPort
      : (normalized.localPort !== null && normalized.localPort !== undefined ? normalized.localPort : null),
    protocol: normalized.protocol || null,
    enabled: true,
    providerId: "playit",
    serviceId,
    computerId,
    source: "provider",
    notes: "",
    metadata: {
      tunnelId,
      tunnelName,
      region: normalized.region || null,
      addressSource: "provider",
    },
  };
}

function createPlayitProviderAdapter() {
  return {
    id: "playit",
    displayName: "Playit.gg",
    capabilities: PLAYIT_PROVIDER_CAPABILITIES,
    detect: mapPlayitSnapshot,
    status: mapPlayitSnapshot,
    listTunnels,
    endpointDiscovery: endpointFromTunnel,
    endpointFromTunnel,
    normalizeState: normalizeProviderState,
  };
}

module.exports = {
  PLAYIT_PROVIDER_CAPABILITIES,
  createPlayitProviderAdapter,
};
