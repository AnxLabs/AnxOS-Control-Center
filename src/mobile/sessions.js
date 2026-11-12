"use strict";

// Paired phones and their sessions.
//
// * Pairing codes: 128 random bits, kept in memory only (as a hash), single
//   use, 5 minutes. Each carries the role the owner chose on the computer.
// * Sessions: a random 256-bit token in an HttpOnly cookie. Only its SHA-256
//   is stored, so the devices file cannot be replayed as a credential.
//   A session ends after 14 days without use, 90 days after pairing at the
//   latest, or as soon as the owner revokes the device.
// * CSRF: an HMAC of the session's hash under a per-install secret. The page
//   reads it from /api/session (same origin only; there are no CORS headers)
//   and sends it as a header on every change.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_PAIRINGS = 5;
const SESSION_IDLE_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_MAX_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_DEVICES = 20;
// lastSeen is written at most this often, so polling does not rewrite the file.
const TOUCH_WRITE_MS = 5 * 60 * 1000;
const ROLES = Object.freeze(["Viewer", "Operator", "Owner"]);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const randomToken = (bytes) => crypto.randomBytes(bytes).toString("base64url");

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cleanDeviceName(value) {
  const text = String(value || "").replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 60);
  return text || "Phone";
}

function createSessionStore({ folder, now = () => Date.now() } = {}) {
  if (!folder) throw new Error("A folder for the devices file is required.");
  const devicesFile = path.join(folder, "devices.json");
  const secretFile = path.join(folder, "session-secret");
  const pairings = new Map();
  let devices = null;
  let secret = null;

  function writePrivate(file, text) {
    fs.mkdirSync(folder, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, text, { mode: 0o600 });
    fs.renameSync(temp, file);
  }

  function getSecret() {
    if (secret) return secret;
    try {
      secret = Buffer.from(fs.readFileSync(secretFile, "utf8").trim(), "base64");
    } catch {
      secret = null;
    }
    if (!secret || secret.length < 32) {
      secret = crypto.randomBytes(32);
      writePrivate(secretFile, secret.toString("base64"));
    }
    return secret;
  }

  function load() {
    if (devices) return devices;
    try {
      const parsed = JSON.parse(fs.readFileSync(devicesFile, "utf8"));
      devices = Array.isArray(parsed.devices) ? parsed.devices.filter((entry) => entry && entry.id && entry.tokenHash && ROLES.includes(entry.role)) : [];
    } catch {
      devices = [];
    }
    return devices;
  }

  function save() {
    writePrivate(devicesFile, JSON.stringify({ version: 1, devices: load() }, null, 2));
  }

  function expired(device, at) {
    return at - Date.parse(device.lastSeenAt || device.createdAt) > SESSION_IDLE_MS
      || at - Date.parse(device.createdAt) > SESSION_MAX_MS;
  }

  function prune(at = now()) {
    const before = load().length;
    devices = load().filter((device) => !expired(device, at));
    if (devices.length !== before) save();
    for (const [hash, pairing] of pairings) {
      if (pairing.expiresAt <= at || pairing.used) pairings.delete(hash);
    }
  }

  function publicDevice(device) {
    return {
      id: device.id,
      name: device.name,
      role: device.role,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt || device.createdAt,
      lastAddress: device.lastAddress || "",
      expiresAt: new Date(Math.min(
        Date.parse(device.lastSeenAt || device.createdAt) + SESSION_IDLE_MS,
        Date.parse(device.createdAt) + SESSION_MAX_MS,
      )).toISOString(),
    };
  }

  return {
    ROLES,

    createPairing(role) {
      if (!ROLES.includes(role)) throw Object.assign(new Error("Choose Viewer, Operator or Owner."), { code: "INVALID_ROLE", status: 400, expose: true });
      prune();
      if (pairings.size >= MAX_PENDING_PAIRINGS) {
        // The oldest unused code goes first; only a handful are ever live.
        const oldest = [...pairings.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)[0];
        pairings.delete(oldest[0]);
      }
      const code = randomToken(16);
      const expiresAt = now() + PAIRING_TTL_MS;
      pairings.set(sha256(code), { role, expiresAt, used: false });
      return { code, role, expiresAt: new Date(expiresAt).toISOString() };
    },

    cancelPairings() {
      pairings.clear();
    },

    pendingPairings() {
      prune();
      return pairings.size;
    },

    // Exchanges a pairing code for a session token. A code works once.
    redeemPairing(code, { deviceName, address } = {}) {
      prune();
      const hash = sha256(String(code || ""));
      const pairing = pairings.get(hash);
      if (!pairing || pairing.used || pairing.expiresAt <= now()) {
        throw Object.assign(new Error("This pairing code is not valid. Make a new one on the computer."), { code: "PAIRING_INVALID", status: 401, expose: true });
      }
      pairing.used = true;
      pairings.delete(hash);
      if (load().length >= MAX_DEVICES) {
        throw Object.assign(new Error(`At most ${MAX_DEVICES} phones can be paired. Remove one on the computer first.`), { code: "TOO_MANY_DEVICES", status: 409, expose: true });
      }
      const token = randomToken(32);
      const at = new Date(now()).toISOString();
      const device = {
        id: `dev_${randomToken(9)}`,
        name: cleanDeviceName(deviceName),
        role: pairing.role,
        tokenHash: sha256(token),
        createdAt: at,
        lastSeenAt: at,
        lastAddress: String(address || "").slice(0, 64),
      };
      load().push(device);
      save();
      return { token, device: publicDevice(device) };
    },

    // The device for a session token, or null. Updates lastSeen.
    authenticate(token, { address } = {}) {
      if (!token || typeof token !== "string" || token.length > 128) return null;
      const hash = sha256(token);
      const at = now();
      const device = load().find((entry) => safeEqual(entry.tokenHash, hash));
      if (!device) return null;
      if (expired(device, at)) {
        prune(at);
        return null;
      }
      if (at - Date.parse(device.lastSeenAt || device.createdAt) > TOUCH_WRITE_MS || (address && device.lastAddress !== address)) {
        device.lastSeenAt = new Date(at).toISOString();
        if (address) device.lastAddress = String(address).slice(0, 64);
        save();
      }
      return { ...publicDevice(device), tokenHash: device.tokenHash };
    },

    csrfFor(tokenHash) {
      return crypto.createHmac("sha256", getSecret()).update(`csrf:${tokenHash}`).digest("base64url");
    },

    checkCsrf(tokenHash, value) {
      return Boolean(value) && safeEqual(this.csrfFor(tokenHash), value);
    },

    listDevices() {
      prune();
      return load().map(publicDevice);
    },

    revokeDevice(id) {
      const before = load().length;
      devices = load().filter((device) => device.id !== id);
      if (devices.length === before) return false;
      save();
      return true;
    },

    revokeAll() {
      const count = load().length;
      devices = [];
      pairings.clear();
      save();
      return count;
    },
  };
}

module.exports = { createSessionStore, ROLES, PAIRING_TTL_MS, SESSION_IDLE_MS, SESSION_MAX_MS };
