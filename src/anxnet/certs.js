"use strict";

// A self-signed X.509 v3 certificate for an Ed25519 key, so a node can speak
// TLS 1.3. Node can parse certificates but not create them, and AnxOS has no
// X.509 builder dependency; this is the small DER encoder needed for one
// fixed certificate shape (RFC 5280, RFC 8410).
//
// Trust never comes from this certificate. A peer is accepted only when the
// certificate's public key belongs to a non-revoked device in the
// owner-signed roster (see roster.js and node.js).

const crypto = require("crypto");

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let value = n; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag, content) {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));

function integer(buffer) {
  const bytes = buffer[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buffer]) : buffer;
  return tlv(0x02, bytes);
}

function oid(dotted) {
  const parts = dotted.split(".").map(Number);
  const bytes = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [];
    let value = part;
    do { chunk.unshift(value & 0x7f); value = Math.floor(value / 128); } while (value > 0);
    for (let index = 0; index < chunk.length - 1; index += 1) chunk[index] |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const utf8 = (text) => tlv(0x0c, Buffer.from(text, "utf8"));
const bitString = (buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), buffer]));

function generalizedTime(date) {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return tlv(0x18, Buffer.from(`${iso}Z`, "ascii"));
}

const ED25519 = "1.3.101.112";
const COMMON_NAME = "2.5.4.3";

function name(commonName) {
  return seq(set(seq(oid(COMMON_NAME), utf8(commonName))));
}

// keyPair: { privateKey: KeyObject, publicKey: KeyObject } (Ed25519).
function createSelfSignedCertificate(keyPair, commonName, options = {}) {
  const notBefore = options.notBefore || new Date(Date.now() - 60 * 60 * 1000);
  const notAfter = options.notAfter || new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);
  const spki = keyPair.publicKey.export({ format: "der", type: "spki" });
  const algorithm = seq(oid(ED25519));
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(crypto.randomBytes(16)),
    algorithm,
    name(commonName),
    seq(generalizedTime(notBefore), generalizedTime(notAfter)),
    name(commonName),
    spki,
  );
  const signature = crypto.sign(null, tbs, keyPair.privateKey);
  const der = seq(tbs, algorithm, bitString(signature));
  const base64 = der.toString("base64").match(/.{1,64}/g).join("\n");
  return `-----BEGIN CERTIFICATE-----\n${base64}\n-----END CERTIFICATE-----\n`;
}

module.exports = { createSelfSignedCertificate };
