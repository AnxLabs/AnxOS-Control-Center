"use strict";

// AnxNet device identity: one Ed25519 key pair per device, generated locally.
// The private key never leaves the device; the caller decides where it is
// stored (Electron safeStorage on the desktop, a 0600 file for headless
// nodes) through a { read(), write(text) } store.

const crypto = require("crypto");
const { createSelfSignedCertificate } = require("./certs");

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

function base32(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function publicKeyDer(publicKey) {
  const key = typeof publicKey === "string" ? crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }) : publicKey;
  return key.export({ format: "der", type: "spki" });
}

// "SHA256:<base64>" like SSH; used to pin the owner key in invite codes.
function fingerprint(publicKey) {
  return `SHA256:${crypto.createHash("sha256").update(publicKeyDer(publicKey)).digest("base64").replace(/=+$/, "")}`;
}

function deviceIdFor(publicKey) {
  return `dev-${base32(crypto.createHash("sha256").update(publicKeyDer(publicKey)).digest()).slice(0, 16)}`;
}

function publicKeyBase64(publicKey) {
  return publicKeyDer(publicKey).toString("base64");
}

function importPublicKey(base64) {
  return crypto.createPublicKey({ key: Buffer.from(String(base64 || ""), "base64"), format: "der", type: "spki" });
}

function fromPrivateKeyPem(pem) {
  const privateKey = crypto.createPrivateKey(pem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("ANXNET_IDENTITY_KEY_TYPE");
  const publicKey = crypto.createPublicKey(privateKey);
  const deviceId = deviceIdFor(publicKey);
  let certificate = null;
  return {
    deviceId,
    privateKey,
    publicKey,
    publicKeyBase64: publicKeyBase64(publicKey),
    fingerprint: fingerprint(publicKey),
    // TLS material, created once per process.
    tlsOptions() {
      if (!certificate) certificate = createSelfSignedCertificate({ privateKey, publicKey }, deviceId);
      return { key: privateKey.export({ format: "pem", type: "pkcs8" }), cert: certificate };
    },
    sign(data) {
      return crypto.sign(null, Buffer.isBuffer(data) ? data : Buffer.from(String(data)), privateKey).toString("base64");
    },
  };
}

function createIdentity() {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  return fromPrivateKeyPem(privateKey.export({ format: "pem", type: "pkcs8" }));
}

// Load the device identity from the store, creating it on first use. The
// stored text is the PKCS#8 PEM; the store is responsible for protecting it.
function loadOrCreateIdentity(store) {
  const existing = store.read();
  if (existing) return fromPrivateKeyPem(existing);
  const identity = createIdentity();
  store.write(identity.privateKey.export({ format: "pem", type: "pkcs8" }));
  return identity;
}

function verifySignature(publicKeyB64, data, signatureB64) {
  try {
    return crypto.verify(null, Buffer.isBuffer(data) ? data : Buffer.from(String(data)), importPublicKey(publicKeyB64), Buffer.from(String(signatureB64 || ""), "base64"));
  } catch {
    return false;
  }
}

// The peer's device id from a TLS socket's certificate.
function peerFromTlsSocket(socket) {
  const certificate = socket.getPeerX509Certificate?.();
  if (!certificate || certificate.publicKey.asymmetricKeyType !== "ed25519") return null;
  const publicKey = certificate.publicKey;
  return { deviceId: deviceIdFor(publicKey), publicKeyBase64: publicKeyBase64(publicKey) };
}

module.exports = {
  base32,
  createIdentity,
  deviceIdFor,
  fingerprint,
  fromPrivateKeyPem,
  importPublicKey,
  loadOrCreateIdentity,
  peerFromTlsSocket,
  publicKeyBase64,
  verifySignature,
};
