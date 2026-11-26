"use strict";

// The AnxNet smokes share test services on fixed port numbers (the port a
// member connects to on the virtual address). Windows reserves port ranges
// for Hyper-V, WSL and Docker, and those ranges can move after a restart: on
// 2026-11-26 TCP 25598-25697 was reserved, binding there failed with EACCES
// and both smokes failed for a reason that had nothing to do with AnxNet.
// This picks a block of ports, starting at the smoke's usual numbers, in
// which every port can really be opened for TCP and UDP on loopback.

const dgram = require("dgram");
const net = require("net");

function canBindTcp(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function canBindUdp(port, host) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", () => { socket.close(); resolve(false); });
    socket.bind(port, host, () => socket.close(() => resolve(true)));
  });
}

async function blockIsBindable(base, size, hosts) {
  for (let port = base; port < base + size; port += 1) {
    for (const host of hosts) {
      if (!await canBindTcp(port, host) || !await canBindUdp(port, host)) return false;
    }
  }
  return true;
}

// Returns a mapper from the smoke's original port numbers to bindable ones:
// servicePorts(25599, 40) maps 25599..25638 to base..base+39. It keeps the
// original block when it works, so a run on a machine without reservations
// uses exactly the numbers it always did.
async function servicePorts(firstLegacyPort, size, { hosts = ["127.0.0.1"], maxBase = 60000, step = 100 } = {}) {
  for (let base = firstLegacyPort; base + size <= maxBase; base += step) {
    if (await blockIsBindable(base, size, hosts)) {
      const map = (legacyPort) => {
        const offset = Number(legacyPort) - firstLegacyPort;
        if (!Number.isInteger(offset) || offset < 0 || offset >= size) throw new Error(`port ${legacyPort} is outside the reserved test block`);
        return base + offset;
      };
      map.base = base;
      return map;
    }
  }
  throw new Error(`no block of ${size} bindable ports from ${firstLegacyPort}`);
}

module.exports = { servicePorts, canBindTcp, canBindUdp };
