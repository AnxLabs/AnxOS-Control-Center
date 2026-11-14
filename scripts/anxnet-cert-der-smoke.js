#!/usr/bin/env node
"use strict";

// Regression: AnxNet's self-signed TLS certificate used a random 16-byte serial
// encoded without stripping leading zero bytes. A serial starting 0x00 followed
// by 0x00-0x7f is not valid DER ("illegal padding"), so tls.createServer refused
// the certificate and AnxNet could not start (about 1 process start in 512;
// seen as an intermittent anxnet-dns-smoke failure). Forces the serials that
// used to fail and loads each certificate through the real TLS path.
// Run: node scripts/anxnet-cert-der-smoke.js

const assert = require("assert");
const crypto = require("crypto");
const tls = require("tls");

const realRandomBytes = crypto.randomBytes;
let forced = null;
crypto.randomBytes = (size, ...rest) => (forced && size === 16 && rest.length === 0 ? Buffer.from(forced) : realRandomBytes(size, ...rest));
const { createSelfSignedCertificate } = require("../src/anxnet/certs");

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
const key = privateKey.export({ format: "pem", type: "pkcs8" });
// X509Certificate.serialNumber shows the value without the DER sign byte.
const serialOf = (pem) => new crypto.X509Certificate(pem).serialNumber.toUpperCase();

function check(serialBytes, expectedSerialHex, label) {
  forced = serialBytes;
  const cert = createSelfSignedCertificate({ privateKey, publicKey }, "device-qa");
  forced = null;
  assert.doesNotThrow(() => tls.createSecureContext({ key, cert, sigalgs: "ed25519" }), `${label}: TLS accepts the certificate`);
  assert.strictEqual(serialOf(cert), expectedSerialHex, `${label}: serial is encoded minimally`);
}

const tail = Array.from({ length: 14 }, (_, i) => i + 1);
check([0x00, 0x10, ...tail], "10" + Buffer.from(tail).toString("hex").toUpperCase(), "leading 0x00 then a low byte (used to fail)");
check([0x00, 0x00, 0x05, ...tail.slice(1)], "05" + Buffer.from(tail.slice(1)).toString("hex").toUpperCase(), "two leading zeros (used to fail)");
check([0x00, 0x80, ...tail], "80" + Buffer.from(tail).toString("hex").toUpperCase(), "leading 0x00 kept before a high byte");
check([0x80, ...tail, 0x01], "80" + Buffer.from([...tail, 0x01]).toString("hex").toUpperCase(), "a high first byte gets one zero");
check(Array(16).fill(0), "0", "an all-zero serial is a single zero");

for (let i = 0; i < 300; i += 1) {
  const cert = createSelfSignedCertificate({ privateKey, publicKey }, `device-${i}`);
  tls.createSecureContext({ key, cert, sigalgs: "ed25519" });
}

crypto.randomBytes = realRandomBytes;
console.log("anxnet cert DER smoke passed (5 forced serials, 300 random certificates).");
