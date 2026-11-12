"use strict";

// AnxOS's own local certificate authority for the phone gateway.
//
// Phones only allow an installable app, service workers and secure cookies
// over trusted HTTPS. Without a domain or cloud service, the practical way is
// a small private CA created on this computer: you install its certificate
// on your phone once, and AnxOS issues the gateway's HTTPS certificate for
// this computer's LAN addresses from it. Keys stay in the AnxOS config
// folder (0600). Algorithms: ECDSA P-256 with SHA-256, which iOS and Android
// both accept. Leaf certificates last 397 days (within Apple's limits) and
// are reissued when they near expiry or the computer's addresses change.

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

// ---- DER --------------------------------------------------------------------------

function length(n) {
  if (n < 0x80) return Buffer.from([n]);
  const bytes = [];
  for (let value = n; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag, content) => Buffer.concat([Buffer.from([tag]), length(content.length), content]);
const seq = (...parts) => tlv(0x30, Buffer.concat(parts));
const set = (...parts) => tlv(0x31, Buffer.concat(parts));
const octets = (buffer) => tlv(0x04, buffer);
const bool = (value) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const utf8 = (text) => tlv(0x0c, Buffer.from(text, "utf8"));
const bitString = (buffer, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), buffer]));
function integer(buffer) {
  let bytes = buffer;
  while (bytes.length > 1 && bytes[0] === 0 && !(bytes[1] & 0x80)) bytes = bytes.subarray(1);
  if (bytes[0] & 0x80) bytes = Buffer.concat([Buffer.from([0]), bytes]);
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
function time(date) {
  // UTCTime until 2049, GeneralizedTime after (RFC 5280).
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return date.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, "ascii")) : tlv(0x18, Buffer.from(`${iso}Z`, "ascii"));
}
const name = (commonName, organization = "AnxOS") => seq(
  set(seq(oid("2.5.4.10"), utf8(organization))),
  set(seq(oid("2.5.4.3"), utf8(commonName))),
);
const extension = (id, critical, value) => seq(oid(id), ...(critical ? [bool(true)] : []), octets(value));
const ECDSA_SHA256 = seq(oid("1.2.840.10045.4.3.2"));

function keyIdentifier(publicKey) {
  const spki = publicKey.export({ format: "der", type: "spki" });
  return crypto.createHash("sha1").update(spki.subarray(spki.length - 65)).digest();
}

function pem(der, label = "CERTIFICATE") {
  return `-----BEGIN ${label}-----\n${der.toString("base64").match(/.{1,64}/g).join("\n")}\n-----END ${label}-----\n`;
}

// subjectAltName from IPv4 addresses and DNS names.
function subjectAltName({ ips = [], dns = [] }) {
  const entries = [
    ...dns.map((host) => tlv(0x82, Buffer.from(host, "ascii"))),
    ...ips.filter((ip) => net.isIPv4(ip)).map((ip) => tlv(0x87, Buffer.from(ip.split(".").map(Number)))),
  ];
  return seq(...entries);
}

function issue({ subjectName, subjectKey, issuerName, issuerKey, issuerPublicKey, days, ca, san }) {
  const notBefore = new Date(Date.now() - 60 * 60 * 1000);
  const notAfter = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  const extensions = [
    extension("2.5.29.19", true, ca ? seq(bool(true), integer(Buffer.from([0]))) : seq()),
    // keyUsage: CA = keyCertSign + cRLSign; server = digitalSignature.
    extension("2.5.29.15", true, ca ? bitString(Buffer.from([0x06]), 1) : bitString(Buffer.from([0x80]), 7)),
    extension("2.5.29.14", false, octets(keyIdentifier(subjectKey))),
    extension("2.5.29.35", false, seq(tlv(0x80, keyIdentifier(issuerPublicKey)))),
  ];
  if (!ca) {
    extensions.push(extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))));
    extensions.push(extension("2.5.29.17", false, subjectAltName(san)));
  }
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(Buffer.concat([Buffer.from([0x01]), crypto.randomBytes(15)])),
    ECDSA_SHA256,
    issuerName,
    seq(time(notBefore), time(notAfter)),
    subjectName,
    subjectKey.export({ format: "der", type: "spki" }),
    tlv(0xa3, seq(...extensions)),
  );
  const signature = crypto.sign("sha256", tbs, issuerKey);
  return pem(seq(tbs, ECDSA_SHA256, bitString(signature)));
}

// Virtual adapters (WSL, Hyper-V, VirtualBox, Docker...) and VPNs are listed
// after the real home-network adapter, so the QR code points at the address
// a phone on the same Wi-Fi can actually reach.
const VIRTUAL_ADAPTER = /vethernet|wsl|hyper-v|virtualbox|vmware|vmnet|vbox|docker|br-|veth|virbr|loopback/i;
const VPN_ADAPTER = /tailscale|zerotier|wireguard|wg\d|tun|tap|utun|openvpn|anxnet/i;

// Windows often names virtual adapters just "Ethernet 2", so their vendor
// MAC prefixes count too: VirtualBox, Hyper-V, VMware, Docker.
const VIRTUAL_MAC = /^(0a:00:27|08:00:27|00:15:5d|00:50:56|00:0c:29|00:05:69|00:1c:14|02:42:)/i;

function addressRank(name, address, mac = "") {
  if (VIRTUAL_ADAPTER.test(name) || VIRTUAL_MAC.test(mac)) return 3;
  if (VPN_ADAPTER.test(name) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) return 2;
  if (/^(192\.168|10)\./.test(address)) return 0;
  return 1;
}

function lanAddresses() {
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, entries]) => (entries || []).map((entry) => ({ name, ...entry })))
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !String(entry.address).startsWith("169.254."))
    .map((entry, index) => ({ address: entry.address, rank: addressRank(entry.name, entry.address, entry.mac), index }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map((entry) => entry.address);
}

function writeSecret(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o600 });
}

// The CA (created once) and a server certificate for the given addresses.
function ensureCertificates(folder, { ips = lanAddresses(), hostname = os.hostname() } = {}) {
  const caKeyFile = path.join(folder, "anxos-local-ca.key");
  const caCertFile = path.join(folder, "anxos-local-ca.crt");
  const leafKeyFile = path.join(folder, "gateway.key");
  const leafCertFile = path.join(folder, "gateway.crt");
  const leafInfoFile = path.join(folder, "gateway.json");
  const caInfoFile = path.join(folder, "anxos-local-ca.json");
  let caKey;
  let caCert;
  let caCommonName;
  if (fs.existsSync(caKeyFile) && fs.existsSync(caCertFile) && fs.existsSync(caInfoFile)) {
    caKey = crypto.createPrivateKey(fs.readFileSync(caKeyFile, "utf8"));
    caCert = fs.readFileSync(caCertFile, "utf8");
    caCommonName = JSON.parse(fs.readFileSync(caInfoFile, "utf8")).commonName;
  } else {
    caKey = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const caPublic = crypto.createPublicKey(caKey);
    // The issuer name in every certificate must match this byte for byte, so
    // the name is stored rather than rebuilt from the hostname later.
    caCommonName = `AnxOS Local CA (${hostname})`;
    caCert = issue({ subjectName: name(caCommonName), subjectKey: caPublic, issuerName: name(caCommonName), issuerKey: caKey, issuerPublicKey: caPublic, days: 3650, ca: true });
    writeSecret(caKeyFile, caKey.export({ format: "pem", type: "pkcs8" }));
    writeSecret(caCertFile, caCert);
    writeSecret(caInfoFile, JSON.stringify({ commonName: caCommonName }));
    try { fs.unlinkSync(leafInfoFile); } catch {}
  }
  const caPublic = crypto.createPublicKey(caKey);
  const wantedIps = [...new Set(["127.0.0.1", ...ips])].sort();
  let info = null;
  try { info = JSON.parse(fs.readFileSync(leafInfoFile, "utf8")); } catch {}
  const fresh = info && JSON.stringify(info.ips) === JSON.stringify(wantedIps) && Date.parse(info.expiresAt) - Date.now() > 30 * 24 * 60 * 60 * 1000 && fs.existsSync(leafCertFile);
  if (!fresh) {
    const leafKey = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const leafCert = issue({
      subjectName: name(`AnxOS on ${hostname}`),
      subjectKey: crypto.createPublicKey(leafKey),
      issuerName: name(caCommonName),
      issuerKey: caKey,
      issuerPublicKey: caPublic,
      days: 397,
      ca: false,
      san: { ips: wantedIps, dns: ["localhost"] },
    });
    writeSecret(leafKeyFile, leafKey.export({ format: "pem", type: "pkcs8" }));
    writeSecret(leafCertFile, leafCert);
    writeSecret(leafInfoFile, JSON.stringify({ ips: wantedIps, expiresAt: new Date(new crypto.X509Certificate(leafCert).validTo).toISOString() }));
  }
  const caX509 = new crypto.X509Certificate(caCert);
  return {
    caCert,
    caFingerprint: caX509.fingerprint256,
    key: fs.readFileSync(leafKeyFile, "utf8"),
    cert: fs.readFileSync(leafCertFile, "utf8"),
    ips: wantedIps,
  };
}

module.exports = { ensureCertificates, lanAddresses, _test: { issue, name } };
