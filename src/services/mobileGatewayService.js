"use strict";

// Phone access (Phase 7): owns the mobile gateway's lifecycle for the
// desktop. Off by default; the owner turns it on, pairs phones with a QR
// code and a chosen role, and can revoke any phone at once.
//
// Everything is stored in <config>/mobile: the local CA and the gateway
// certificate (0600 keys), the paired devices (token hashes only) and the
// on/off setting.

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const QRCode = require("qrcode");
const { getDefaultConfigDirectory } = require("./secureSessionStore");
const { ensureCertificates, lanAddresses } = require("../mobile/localCa");
const { createSessionStore, ROLES } = require("../mobile/sessions");
const { createMobileApi } = require("../mobile/api");
const { createGateway } = require("../mobile/gateway");

const DEFAULT_PORT = 47800;
const events = new EventEmitter();
let gateway = null;
let sessions = null;
let certificates = null;
let lastError = "";

function dataDir() {
  return path.join(getDefaultConfigDirectory(), "mobile");
}

function settingsPath() {
  return path.join(dataDir(), "settings.json");
}

function readSettings() {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
    const port = Number(parsed.port);
    return { enabled: parsed.enabled === true, port: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT };
  } catch {
    return { enabled: false, port: DEFAULT_PORT };
  }
}

function writeSettings(settings) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function getSessions() {
  if (!sessions) sessions = createSessionStore({ folder: dataDir() });
  return sessions;
}

function defaultServices() {
  return {
    serviceRouter: () => require("./serviceRouter"),
    nodeService: () => require("./nodeService"),
    systemService: () => require("./systemService"),
    modManager: () => require("./modManagerService"),
    anxnet: () => require("./anxnetService"),
    verifyBackup: (nodeId, backupId) => {
      const agentClient = require("./agentClient");
      return agentClient.verifyBackup(backupId, agentClient.forNode(nodeId).target.config);
    },
  };
}

function defaultSecurity() {
  const security = require("./securityService");
  return {
    ROLE_PERMISSIONS: security.ROLE_PERMISSIONS,
    requirePermission: security.requirePermission,
    getStatus: security.getStatus,
    audit: security.audit,
    checkRateLimit: security.checkRateLimit,
  };
}

function log(level, event, details) {
  try {
    require("./diagnosticsService").log(level, "mobile", event, `Phone access: ${event}`, details || {}, { file: "mobile" });
  } catch {
    // Diagnostics are optional here.
  }
}

const MAX_PHONE_CHECKS = 20;

function phoneChecksPath() {
  return path.join(dataDir(), "phone-checks.json");
}

function readPhoneChecks() {
  try {
    const parsed = JSON.parse(fs.readFileSync(phoneChecksPath(), "utf8"));
    return Array.isArray(parsed.checks) ? parsed.checks : [];
  } catch {
    return [];
  }
}

function recordPhoneCheck(report) {
  const checks = [report, ...readPhoneChecks()].slice(0, MAX_PHONE_CHECKS);
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(phoneChecksPath(), JSON.stringify({ checks }, null, 2), { mode: 0o600 });
  events.emit("changed");
}

function urls() {
  if (!gateway || !certificates) return [];
  // Home-network address first (lanAddresses ranks them); only addresses the
  // certificate covers.
  const ranked = lanAddresses().filter((ip) => certificates.ips.includes(ip));
  const rest = certificates.ips.filter((ip) => ip !== "127.0.0.1" && !ranked.includes(ip));
  return [...ranked, ...rest].map((ip) => `https://${ip}:${gateway.port}/`);
}

function status() {
  const settings = readSettings();
  return {
    enabled: settings.enabled,
    running: Boolean(gateway && gateway.port),
    port: gateway ? gateway.port : settings.port,
    urls: urls(),
    caFingerprint: certificates ? certificates.caFingerprint : null,
    devices: getSessions().listDevices(),
    pendingPairings: getSessions().pendingPairings(),
    roles: ROLES,
    phoneChecks: readPhoneChecks(),
    error: lastError,
  };
}

// Automated QA runs listen on loopback only, so tests never open a LAN port
// (or trigger a firewall prompt). Real use always listens on the LAN.
function defaultHost() {
  return process.env.ANXOS_QA_MODE === "1" && process.env.ANXOS_QA_MOBILE_LOOPBACK === "1" ? "127.0.0.1" : "0.0.0.0";
}

async function start({ services = defaultServices(), security = defaultSecurity(), webRoot = path.join(__dirname, "..", "mobile", "web"), host = defaultHost() } = {}) {
  if (gateway) return status();
  const settings = readSettings();
  try {
    certificates = ensureCertificates(path.join(dataDir(), "tls"), { ips: lanAddresses() });
    const api = createMobileApi({ services, security });
    const candidate = createGateway({
      certificates,
      sessions: getSessions(),
      api,
      webRoot,
      sharedRoot: path.join(__dirname, "..", "shared"),
      iconsRoot: path.join(__dirname, "..", "..", "assets", "icons", "png"),
      port: settings.port,
      host,
      onDevicesChanged: () => events.emit("changed"),
      onPhoneCheck: recordPhoneCheck,
      log,
    });
    await candidate.start();
    gateway = candidate;
    lastError = "";
    log("info", "started", { port: gateway.port, addresses: certificates.ips.length });
  } catch (error) {
    gateway = null;
    lastError = error && error.code === "EADDRINUSE"
      ? `Port ${settings.port} is already in use on this computer.`
      : "Phone access could not start.";
    log("warn", "start-failed", { code: error && error.code });
  }
  events.emit("changed");
  return status();
}

async function stop() {
  if (gateway) {
    const closing = gateway;
    gateway = null;
    await closing.stop();
    log("info", "stopped", {});
  }
  getSessions().cancelPairings();
  events.emit("changed");
  return status();
}

async function enable(options) {
  writeSettings({ ...readSettings(), enabled: true });
  return start(options);
}

async function disable() {
  writeSettings({ ...readSettings(), enabled: false });
  return stop();
}

async function resume() {
  if (readSettings().enabled) await start();
  return status();
}

async function createPairing(role) {
  if (!gateway) throw Object.assign(new Error("Turn on Phone access first."), { code: "PHONE_ACCESS_OFF" });
  const pairing = getSessions().createPairing(role);
  const addresses = urls();
  // The code is in the fragment, so it is never sent to the server in the URL
  // or logged by anything along the way; the page reads it and posts it.
  const links = addresses.map((base) => `${base}#pair=${pairing.code}`);
  const qrDataUrl = links.length ? await QRCode.toDataURL(links[0], { errorCorrectionLevel: "M", margin: 1, width: 280 }) : null;
  events.emit("changed");
  return { role: pairing.role, expiresAt: pairing.expiresAt, links, qrDataUrl, caFingerprint: certificates.caFingerprint, caUrl: addresses[0] ? `${addresses[0]}anxos-local-ca.crt` : null };
}

function cancelPairings() {
  getSessions().cancelPairings();
  events.emit("changed");
  return status();
}

function revokeDevice(deviceId) {
  const removed = getSessions().revokeDevice(String(deviceId || ""));
  events.emit("changed");
  return { removed, ...status() };
}

function revokeAll() {
  const removed = getSessions().revokeAll();
  events.emit("changed");
  return { removed, ...status() };
}

function caCertificate() {
  if (!certificates) certificates = ensureCertificates(path.join(dataDir(), "tls"), { ips: lanAddresses() });
  return { pem: certificates.caCert, fingerprint: certificates.caFingerprint };
}

module.exports = {
  caCertificate,
  cancelPairings,
  createPairing,
  dataDir,
  disable,
  enable,
  events,
  resume,
  revokeAll,
  revokeDevice,
  shutdown: stop,
  status,
};
