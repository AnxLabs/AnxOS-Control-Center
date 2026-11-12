"use strict";

// AnxNet's UDP secure channel, for UDP game traffic between two nodes that
// can reach each other over UDP (same LAN, public addresses, or after hole
// punching).
//
// Key exchange (signed ephemeral Diffie-Hellman, the SIGMA pattern used by
// IKE and TLS 1.3): each side sends an ephemeral X25519 public key and an
// Ed25519 signature, made with its roster-pinned device key, over a
// transcript of both device ids, the network id, a fresh random value and
// the ephemeral key. Each side checks the peer's signature against the
// roster before deriving keys, so a stranger or revoked device cannot
// complete the exchange. HKDF-SHA256 over the shared secret and the full
// transcript gives one AES-256-GCM key per direction (ChaCha20-Poly1305 is
// not exposed by Electron's BoringSSL, so AES-GCM is used in both runtimes). Packets carry a
// 64-bit counter used as the nonce; a 2048-packet sliding window rejects
// replays. Only standard primitives from OpenSSL are used.

const crypto = require("crypto");

const MAGIC = Buffer.from("ANX1");
const KIND = Object.freeze({ HELLO: 1, DATA: 2, PUNCH: 3 });
const WINDOW = 2048n;
const REKEY_AFTER_MS = 10 * 60 * 1000;
const REKEY_AFTER_PACKETS = 2n ** 32n;
const TAG = 16;

function transcriptFor(networkId, from, to, random, ephemeral) {
  return Buffer.concat([Buffer.from(`anxnet-udp-v1|${networkId}|${from}|${to}|`), random, ephemeral]);
}

function x25519Raw(publicKey) {
  return publicKey.export({ format: "der", type: "spki" }).subarray(-32);
}

function x25519FromRaw(raw) {
  const prefix = Buffer.from("302a300506032b656e032100", "hex");
  return crypto.createPublicKey({ key: Buffer.concat([prefix, raw]), format: "der", type: "spki" });
}

// One side of a handshake. `verifyPeer(deviceId, data, signature)` must
// check the signature with the peer's roster key and its membership.
function createHandshake({ identity, networkId, peerDeviceId }) {
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const random = crypto.randomBytes(16);
  const raw = x25519Raw(ephemeral.publicKey);
  const transcript = transcriptFor(networkId, identity.deviceId, peerDeviceId, random, raw);
  const hello = {
    from: identity.deviceId,
    to: peerDeviceId,
    random: random.toString("base64"),
    ephemeral: raw.toString("base64"),
    signature: identity.sign(transcript),
  };
  return {
    hello,
    // Finish with the peer's hello; returns the session keys or throws.
    complete(peerHello, verifyPeer) {
      if (!peerHello || peerHello.from !== peerDeviceId || peerHello.to !== identity.deviceId) throw Object.assign(new Error("Handshake for another device."), { code: "ANXNET_UDP_HANDSHAKE_PEER" });
      const peerRandom = Buffer.from(String(peerHello.random), "base64");
      const peerRaw = Buffer.from(String(peerHello.ephemeral), "base64");
      if (peerRandom.length !== 16 || peerRaw.length !== 32) throw Object.assign(new Error("Malformed handshake."), { code: "ANXNET_UDP_HANDSHAKE_INVALID" });
      const peerTranscript = transcriptFor(networkId, peerDeviceId, identity.deviceId, peerRandom, peerRaw);
      if (!verifyPeer(peerDeviceId, peerTranscript, peerHello.signature)) throw Object.assign(new Error("The peer's handshake signature is not from an allowed device."), { code: "ANXNET_UDP_HANDSHAKE_AUTH" });
      const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: x25519FromRaw(peerRaw) });
      // Order both transcripts the same way on both sides.
      const [first, second] = [transcript, peerTranscript].sort(Buffer.compare);
      const salt = crypto.createHash("sha256").update(Buffer.concat([first, second])).digest();
      const material = Buffer.from(crypto.hkdfSync("sha256", shared, salt, Buffer.from("anxnet-udp-v1 keys"), 64));
      const lowFirst = identity.deviceId < peerDeviceId;
      return {
        sendKey: lowFirst ? material.subarray(0, 32) : material.subarray(32, 64),
        receiveKey: lowFirst ? material.subarray(32, 64) : material.subarray(0, 32),
        establishedAt: Date.now(),
      };
    },
  };
}

// Packet: MAGIC | kind (1) | counter (8) | ciphertext | tag (16).
class SecureUdpSession {
  constructor(keys) {
    this.sendKey = keys.sendKey;
    this.receiveKey = keys.receiveKey;
    this.establishedAt = keys.establishedAt || Date.now();
    this.sendCounter = 0n;
    this.highest = -1n;
    this.seen = new Set();
  }

  needsRekey(now = Date.now()) {
    return now - this.establishedAt > REKEY_AFTER_MS || this.sendCounter >= REKEY_AFTER_PACKETS;
  }

  seal(plaintext) {
    const counter = this.sendCounter;
    this.sendCounter += 1n;
    const header = Buffer.alloc(13);
    MAGIC.copy(header, 0);
    header.writeUInt8(KIND.DATA, 4);
    header.writeBigUInt64BE(counter, 5);
    const nonce = Buffer.concat([Buffer.alloc(4), header.subarray(5, 13)]);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.sendKey, nonce, { authTagLength: TAG });
    cipher.setAAD(header);
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Buffer.concat([header, body, cipher.getAuthTag()]);
  }

  // Returns the plaintext, or null for anything forged, damaged or replayed.
  open(packet) {
    if (packet.length < 13 + TAG || !packet.subarray(0, 4).equals(MAGIC) || packet.readUInt8(4) !== KIND.DATA) return null;
    const counter = packet.readBigUInt64BE(5);
    if (counter + WINDOW <= this.highest || this.seen.has(counter)) return null;
    const header = packet.subarray(0, 13);
    const nonce = Buffer.concat([Buffer.alloc(4), packet.subarray(5, 13)]);
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.receiveKey, nonce, { authTagLength: TAG });
      decipher.setAAD(header);
      decipher.setAuthTag(packet.subarray(packet.length - TAG));
      const plaintext = Buffer.concat([decipher.update(packet.subarray(13, packet.length - TAG)), decipher.final()]);
      this.seen.add(counter);
      if (counter > this.highest) {
        this.highest = counter;
        for (const old of this.seen) if (old + WINDOW <= this.highest) this.seen.delete(old);
      }
      return plaintext;
    } catch {
      return null;
    }
  }
}

// Unencrypted control packets for the handshake and hole punching:
// MAGIC | kind | JSON. They carry only public values and signatures.
function controlPacket(kind, message) {
  return Buffer.concat([MAGIC, Buffer.from([kind]), Buffer.from(JSON.stringify(message))]);
}

function parseControl(packet) {
  if (packet.length < 6 || !packet.subarray(0, 4).equals(MAGIC)) return null;
  const kind = packet.readUInt8(4);
  if (kind !== KIND.HELLO && kind !== KIND.PUNCH) return null;
  try { return { kind, message: JSON.parse(packet.subarray(5).toString("utf8")) }; } catch { return null; }
}

module.exports = { KIND, SecureUdpSession, controlPacket, createHandshake, parseControl };
