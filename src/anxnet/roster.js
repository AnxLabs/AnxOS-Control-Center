"use strict";

// The AnxNet roster: who belongs to a network, their names and addresses,
// who was revoked, and which services are shared. It is one JSON document
// signed by the owner's device key, with a version that only goes up. Every
// node pins the owner key at enrollment and accepts a roster only when it is
// signed by that key and newer than the one it holds.
//
// Invitations (owner side): random secrets shown once, stored as SHA-256
// hashes with an expiry, a use limit and a revoked flag.

const crypto = require("crypto");
const names = require("./names");
const { deviceIdFor, fingerprint, importPublicKey, verifySignature, base32 } = require("./identity");

const DEFAULT_INVITE_TTL_MS = 60 * 60 * 1000;
const MAX_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DEVICES = 250;
const MAX_SERVICES = 200;
// Ports AnxNet never shares, matching the Sharing guard (shareHealth.js).
const MANAGEMENT_PORTS = new Map([[22, "SSH"], [2375, "Docker"], [2376, "Docker (TLS)"], [3389, "Remote Desktop"], [5900, "VNC"], [5985, "WinRM"], [5986, "WinRM (TLS)"], [6566, "the AnxOS Agent"]]);

function error(code, message, statusCode = 400) {
  return Object.assign(new Error(message || code), { code, statusCode });
}

// Deterministic JSON (sorted keys) so a signature covers exactly one text.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sign(doc, ownerIdentity) {
  return { doc, signature: ownerIdentity.sign(canonical(doc)) };
}

function verify(signed, ownerPublicKeyB64, options = {}) {
  if (!signed || typeof signed !== "object" || !signed.doc || !signed.signature) throw error("ANXNET_ROSTER_INVALID", "The network roster is malformed.");
  if (!verifySignature(ownerPublicKeyB64, canonical(signed.doc), signed.signature)) throw error("ANXNET_ROSTER_SIGNATURE", "The network roster is not signed by the network owner.", 403);
  if (options.networkId && signed.doc.networkId !== options.networkId) throw error("ANXNET_ROSTER_NETWORK", "The roster is for another network.", 403);
  if (Number.isFinite(options.minVersion) && !(signed.doc.version > options.minVersion)) throw error("ANXNET_ROSTER_STALE", "The roster is not newer than the one already held.", 409);
  return signed.doc;
}

function nextSlot(doc) {
  const used = new Set(doc.devices.map((device) => device.slot));
  for (let slot = 1; slot < 65000; slot += 1) if (!used.has(slot)) return slot;
  throw error("ANXNET_NETWORK_FULL", "This network has no free addresses.");
}

function deviceEntry(doc, { publicKeyBase64, name, role }) {
  const label = names.uniqueLabel(name, doc.devices.map((device) => device.label));
  const slot = nextSlot(doc);
  return {
    deviceId: deviceIdFor(importPublicKey(publicKeyBase64)),
    publicKey: publicKeyBase64,
    name: String(name || label).slice(0, 64),
    label,
    hostname: names.deviceHostname(label, doc.name),
    slot,
    address: names.addressForSlot(slot),
    role,
    addedAt: new Date().toISOString(),
  };
}

// A new network owned by `ownerIdentity`.
function createNetwork(ownerIdentity, { ownerName = "this-computer", networkName, takenNames = [] } = {}) {
  const name = networkName && names.isValidNetworkName(networkName) ? networkName : names.generateNetworkName(takenNames);
  const doc = {
    schema: 1,
    networkId: `net-${base32(crypto.randomBytes(16))}`,
    name,
    domain: names.networkDomain(name),
    version: 1,
    issuedAt: new Date().toISOString(),
    owner: { deviceId: ownerIdentity.deviceId, publicKey: ownerIdentity.publicKeyBase64 },
    devices: [],
    revoked: [],
    services: [],
    relays: [],
    gateways: [],
  };
  doc.devices.push(deviceEntry(doc, { publicKeyBase64: ownerIdentity.publicKeyBase64, name: ownerName, role: "owner" }));
  return sign(doc, ownerIdentity);
}

// Apply a change as the owner: copy, mutate, bump version, re-sign.
function update(signed, ownerIdentity, mutate) {
  if (signed.doc.owner.deviceId !== ownerIdentity.deviceId) throw error("ANXNET_NOT_OWNER", "Only the network owner can change the network.", 403);
  const doc = JSON.parse(JSON.stringify(signed.doc));
  const result = mutate(doc);
  doc.version += 1;
  doc.issuedAt = new Date().toISOString();
  return { signed: sign(doc, ownerIdentity), result };
}

function isRevoked(doc, deviceId) {
  return doc.revoked.some((entry) => entry.deviceId === deviceId);
}

// A device may take part only while it is listed and not revoked.
function memberFor(doc, deviceId, publicKeyBase64 = null) {
  if (isRevoked(doc, deviceId)) return null;
  const device = doc.devices.find((entry) => entry.deviceId === deviceId) || null;
  if (!device) return null;
  if (publicKeyBase64 && device.publicKey !== publicKeyBase64) return null;
  return device;
}

function addDevice(signed, ownerIdentity, { publicKeyBase64, name }) {
  return update(signed, ownerIdentity, (doc) => {
    const deviceId = deviceIdFor(importPublicKey(publicKeyBase64));
    if (isRevoked(doc, deviceId)) throw error("ANXNET_DEVICE_REVOKED", "This device was removed from the network. Remove the revocation first, or join with a new device key.", 403);
    const existing = doc.devices.find((device) => device.deviceId === deviceId);
    if (existing) return existing;
    if (doc.devices.length >= MAX_DEVICES) throw error("ANXNET_NETWORK_FULL", "This network has reached its device limit.");
    const entry = deviceEntry(doc, { publicKeyBase64, name, role: "member" });
    doc.devices.push(entry);
    return entry;
  });
}

function revokeDevice(signed, ownerIdentity, deviceId) {
  return update(signed, ownerIdentity, (doc) => {
    if (deviceId === doc.owner.deviceId) throw error("ANXNET_CANNOT_REVOKE_OWNER", "The owner's own device can't be removed.");
    const device = doc.devices.find((entry) => entry.deviceId === deviceId);
    if (!device) throw error("ANXNET_DEVICE_NOT_FOUND", "That device is not in this network.", 404);
    doc.devices = doc.devices.filter((entry) => entry.deviceId !== deviceId);
    doc.services = doc.services.filter((service) => service.deviceId !== deviceId);
    doc.services.forEach((service) => { if (Array.isArray(service.allow)) service.allow = service.allow.filter((id) => id !== deviceId); });
    doc.revoked.push({ deviceId, publicKey: device.publicKey, at: new Date().toISOString() });
    return device;
  });
}

function renameNetwork(signed, ownerIdentity, newName) {
  if (!names.isValidNetworkName(newName)) throw error("ANXNET_NAME_INVALID", "Network names look like anx-frost72: lowercase letters, digits and dashes after anx-.");
  return update(signed, ownerIdentity, (doc) => {
    doc.name = newName;
    doc.domain = names.networkDomain(newName);
    doc.devices.forEach((device) => { device.hostname = names.deviceHostname(device.label, newName); });
    doc.services.forEach((service) => {
      const host = doc.devices.find((device) => device.deviceId === service.deviceId);
      if (host) service.hostname = names.serviceHostname(service.label, host.label, newName);
    });
    return newName;
  });
}

function renameDevice(signed, ownerIdentity, deviceId, newName) {
  return update(signed, ownerIdentity, (doc) => {
    const device = doc.devices.find((entry) => entry.deviceId === deviceId);
    if (!device) throw error("ANXNET_DEVICE_NOT_FOUND", "That device is not in this network.", 404);
    device.name = String(newName || device.name).slice(0, 64);
    device.label = names.uniqueLabel(newName, doc.devices.filter((entry) => entry !== device).map((entry) => entry.label));
    device.hostname = names.deviceHostname(device.label, doc.name);
    doc.services.filter((service) => service.deviceId === deviceId).forEach((service) => { service.hostname = names.serviceHostname(service.label, device.label, doc.name); });
    return device;
  });
}

function managementPortName(port) {
  return MANAGEMENT_PORTS.get(Number(port)) || null;
}

// A shared service: what other members can reach on `deviceId`.
function addService(signed, ownerIdentity, input) {
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw error("ANXNET_SERVICE_PORT", "Choose a port between 1 and 65535.");
  const reserved = managementPortName(port);
  if (reserved) throw error("ANXNET_SERVICE_SENSITIVE_PORT", `Port ${port} is used by ${reserved}. AnxNet never shares management ports.`, 403);
  const protocol = ["tcp", "udp", "both"].includes(input.protocol) ? input.protocol : "tcp";
  const targetHost = String(input.targetHost || "127.0.0.1");
  if (!/^[A-Za-z0-9.:-]{1,253}$/.test(targetHost)) throw error("ANXNET_SERVICE_TARGET", "The service address is not valid.");
  const allow = input.allow === "members" || input.allow === undefined ? "members" : (Array.isArray(input.allow) ? input.allow.map(String) : []);
  return update(signed, ownerIdentity, (doc) => {
    const host = doc.devices.find((device) => device.deviceId === input.deviceId);
    if (!host) throw error("ANXNET_DEVICE_NOT_FOUND", "That device is not in this network.", 404);
    if (doc.services.length >= MAX_SERVICES) throw error("ANXNET_SERVICE_LIMIT", "This network has reached its service limit.");
    const existing = doc.services.find((service) => service.deviceId === input.deviceId && service.port === port && service.protocol === protocol);
    if (existing) return existing;
    const label = names.uniqueLabel(input.name, doc.services.filter((service) => service.deviceId === host.deviceId).map((service) => service.label), "service");
    const service = {
      serviceId: `svc-${base32(crypto.randomBytes(8))}`,
      deviceId: host.deviceId,
      name: String(input.name || label).slice(0, 64),
      label,
      hostname: names.serviceHostname(label, host.label, doc.name),
      protocol,
      port,
      targetHost,
      targetPort: Number(input.targetPort) || port,
      allow,
      instanceId: input.instanceId ? String(input.instanceId).slice(0, 80) : null,
      createdAt: new Date().toISOString(),
    };
    doc.services.push(service);
    return service;
  });
}

function removeService(signed, ownerIdentity, serviceId) {
  return update(signed, ownerIdentity, (doc) => {
    const before = doc.services.length;
    doc.services = doc.services.filter((service) => service.serviceId !== serviceId);
    if (doc.services.length === before) throw error("ANXNET_SERVICE_NOT_FOUND", "That shared service doesn't exist.", 404);
    return serviceId;
  });
}

function serviceAllows(doc, service, deviceId) {
  if (!service || !memberFor(doc, deviceId) || !memberFor(doc, service.deviceId)) return false;
  if (service.deviceId === deviceId) return true;
  return service.allow === "members" || (Array.isArray(service.allow) && service.allow.includes(deviceId));
}

function setEdges(signed, ownerIdentity, { relays, gateways }) {
  return update(signed, ownerIdentity, (doc) => {
    const clean = (list) => (Array.isArray(list) ? list : []).slice(0, 8).map((entry) => ({ host: String(entry.host), port: Number(entry.port), fingerprint: String(entry.fingerprint || "") }))
      .filter((entry) => /^[A-Za-z0-9.:-]{1,253}$/.test(entry.host) && Number.isInteger(entry.port) && /^SHA256:[A-Za-z0-9+/]{43}$/.test(entry.fingerprint));
    if (relays) doc.relays = clean(relays);
    if (gateways) doc.gateways = clean(gateways);
    return { relays: doc.relays, gateways: doc.gateways };
  });
}

// ---- invitations (owner side) -------------------------------------------------

function hashSecret(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest("hex");
}

function createInvite(invites, { ttlMs = DEFAULT_INVITE_TTL_MS, maxUses = 1, preApproved = false, label = "" } = {}) {
  const ttl = Math.min(Math.max(Number(ttlMs) || DEFAULT_INVITE_TTL_MS, 60 * 1000), MAX_INVITE_TTL_MS);
  const secret = base32(crypto.randomBytes(16));
  const record = {
    inviteId: `inv-${base32(crypto.randomBytes(6))}`,
    hash: hashSecret(secret),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttl).toISOString(),
    maxUses: Math.min(Math.max(Number(maxUses) || 1, 1), 50),
    uses: 0,
    preApproved: preApproved === true,
    revoked: false,
    label: String(label || "").slice(0, 64),
  };
  return { secret, invites: [...invites.filter((invite) => isInviteUsable(invite)), record], record };
}

function isInviteUsable(invite, now = Date.now()) {
  return invite && !invite.revoked && invite.uses < invite.maxUses && Date.parse(invite.expiresAt) > now;
}

// Constant-time match of a presented secret; returns the invite record.
function matchInvite(invites, secret, now = Date.now()) {
  const presented = Buffer.from(hashSecret(secret), "hex");
  const match = invites.find((invite) => crypto.timingSafeEqual(Buffer.from(invite.hash, "hex"), presented));
  if (!match) throw error("ANXNET_INVITE_INVALID", "That invite code isn't valid for this network.", 403);
  if (match.revoked) throw error("ANXNET_INVITE_REVOKED", "That invite was cancelled.", 403);
  if (Date.parse(match.expiresAt) <= now) throw error("ANXNET_INVITE_EXPIRED", "That invite has expired. Ask for a new one.", 403);
  if (match.uses >= match.maxUses) throw error("ANXNET_INVITE_USED", "That invite was already used.", 403);
  return match;
}

// The code a person pastes on the joining device. It pins the owner key.
function encodeInviteCode({ doc, secret, coordinator }) {
  const payload = { v: 1, n: doc.networkId, name: doc.name, fp: fingerprint(doc.owner.publicKey), c: coordinator, s: secret };
  return `anx1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
}

function decodeInviteCode(code) {
  const match = /^anx1\.([A-Za-z0-9_-]{20,2000})$/.exec(String(code || "").trim());
  if (!match) throw error("ANXNET_INVITE_FORMAT", "That doesn't look like an AnxNet invite code.");
  let payload;
  try { payload = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8")); } catch { throw error("ANXNET_INVITE_FORMAT", "That invite code is damaged."); }
  if (payload.v !== 1 || !/^net-[a-z2-7]{26}$/.test(payload.n) || !/^SHA256:/.test(payload.fp) || !Array.isArray(payload.c) || !payload.c.length || !/^[a-z2-7]{26}$/.test(payload.s)) {
    throw error("ANXNET_INVITE_FORMAT", "That invite code is incomplete.");
  }
  const coordinator = payload.c.slice(0, 6).map((entry) => ({ host: String(entry.host), port: Number(entry.port), udpPort: Number(entry.udpPort) || null })).filter((entry) => entry.host && Number.isInteger(entry.port));
  return { networkId: payload.n, name: payload.name, ownerFingerprint: payload.fp, coordinator, secret: payload.s };
}

module.exports = {
  MANAGEMENT_PORTS,
  addDevice,
  addService,
  canonical,
  createInvite,
  createNetwork,
  decodeInviteCode,
  encodeInviteCode,
  error,
  hashSecret,
  isInviteUsable,
  isRevoked,
  managementPortName,
  matchInvite,
  memberFor,
  removeService,
  renameDevice,
  renameNetwork,
  revokeDevice,
  serviceAllows,
  setEdges,
  update,
  verify,
};
