"use strict";

// AnxNet private DNS: a tiny authoritative responder for one network's
// names under <network>.internal. It answers A queries for devices and the
// services this device may use, and nothing else: no recursion, no other
// domains (REFUSED), unknown names in the domain get NXDOMAIN. It binds to
// a loopback address only.

const dgram = require("dgram");

function readName(message, offset) {
  const labels = [];
  let position = offset;
  for (let guard = 0; guard < 64; guard += 1) {
    const length = message[position];
    if (length === undefined) return null;
    if (length === 0) return { name: labels.join(".").toLowerCase(), next: position + 1 };
    if (length > 63) return null; // compression is not used in queries we accept
    labels.push(message.subarray(position + 1, position + 1 + length).toString("ascii"));
    position += 1 + length;
  }
  return null;
}

// lookup(name) -> "127.77.0.3" | null (null = NXDOMAIN inside the domain).
function buildResponse(query, { domain, lookup, ttl = 30 }) {
  if (query.length < 17) return null;
  const id = query.readUInt16BE(0);
  const flags = query.readUInt16BE(2);
  if (flags & 0x8000) return null; // a response, not a query
  const questions = query.readUInt16BE(4);
  const parsed = questions === 1 ? readName(query, 12) : null;
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  const question = parsed ? query.subarray(12, parsed.next + 4) : Buffer.alloc(0);
  const qtype = parsed ? query.readUInt16BE(parsed.next) : 0;
  const qclass = parsed ? query.readUInt16BE(parsed.next + 2) : 0;
  let rcode = 0;
  let answer = null;
  const inDomain = parsed && (parsed.name === domain || parsed.name.endsWith(`.${domain}`));
  if (!parsed || qclass !== 1) rcode = 1; // FORMERR
  else if (!inDomain) rcode = 5; // REFUSED: no recursion, no other names
  else {
    const address = lookup(parsed.name);
    if (!address) rcode = 3; // NXDOMAIN
    else if (qtype === 1 || qtype === 255) {
      answer = Buffer.alloc(16);
      answer.writeUInt16BE(0xc00c, 0); // pointer to the question name
      answer.writeUInt16BE(1, 2);
      answer.writeUInt16BE(1, 4);
      answer.writeUInt32BE(ttl, 6);
      answer.writeUInt16BE(4, 10);
      address.split(".").forEach((part, index) => answer.writeUInt8(Number(part), 12 + index));
    }
  }
  // QR, AA (authoritative inside the domain), RD copied, RA 0.
  header.writeUInt16BE(0x8000 | (inDomain ? 0x0400 : 0) | (flags & 0x0100) | rcode, 2);
  header.writeUInt16BE(parsed ? 1 : 0, 4);
  header.writeUInt16BE(answer ? 1 : 0, 6);
  return Buffer.concat([header, question, answer || Buffer.alloc(0)]);
}

function startDnsServer({ host = "127.77.0.1", port = 5353, domain, lookup }) {
  if (!/^127\./.test(host)) throw new Error("ANXNET_DNS_LOOPBACK_ONLY");
  const socket = dgram.createSocket("udp4");
  const state = { domain, lookup, queries: 0 };
  socket.on("message", (message, remote) => {
    if (!/^127\./.test(remote.address)) return; // loopback clients only
    state.queries += 1;
    const response = buildResponse(message, state);
    if (response) socket.send(response, remote.port, remote.address);
  });
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(port, host, () => {
      socket.off("error", reject);
      resolve({
        host,
        port: socket.address().port,
        update(next) { if (next.domain) state.domain = next.domain; if (next.lookup) state.lookup = next.lookup; },
        stats: () => ({ queries: state.queries }),
        close: () => new Promise((done) => socket.close(() => done())),
      });
    });
  });
}

module.exports = { buildResponse, startDnsServer };
