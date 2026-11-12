"use strict";

// A userspace stand-in for a home router's UDP NAT, for AnxNet hole-punching
// tests on one machine. A node gets this socket instead of a real one; its
// traffic leaves through "external" sockets on 127.0.0.1, and inbound
// packets are filtered the way real NATs filter them.
//   cone:      one external port for every destination (endpoint-independent
//              mapping), inbound only from address:port pairs it has sent to
//              (address-and-port-dependent filtering). Hole punching works.
//   symmetric: a new external port per destination. Hole punching fails,
//              as it does on real symmetric NAT / some CGNAT.
// This is a simulation; real-router behavior is not verified by it.

const dgram = require("dgram");
const { EventEmitter } = require("events");

function createNatSocketFactory(type = "cone") {
  return () => {
    const inside = new EventEmitter();
    const externals = new Map(); // destination key (symmetric) or "*" (cone) -> { socket, allowed }
    let closed = false;
    const stats = { dropped: 0, delivered: 0 };

    function external(destinationKey) {
      const key = type === "symmetric" ? destinationKey : "*";
      let entry = externals.get(key);
      if (!entry) {
        const socket = dgram.createSocket("udp4");
        entry = { socket, allowed: new Set(), ready: new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve)) };
        socket.on("message", (message, remote) => {
          if (closed) return;
          if (!entry.allowed.has(`${remote.address}:${remote.port}`)) { stats.dropped += 1; return; }
          stats.delivered += 1;
          inside.emit("message", message, remote);
        });
        socket.on("error", () => {});
        externals.set(key, entry);
      }
      return entry;
    }

    inside.bind = (_port, _host, callback) => { (typeof _host === "function" ? _host : callback)?.(); };
    inside.address = () => ({ address: "10.0.0.2", port: 40000, family: "IPv4" });
    inside.send = (buffer, port, host) => {
      if (closed) return;
      const key = `${host}:${port}`;
      const entry = external(key);
      entry.allowed.add(key);
      entry.ready.then(() => { if (!closed) entry.socket.send(buffer, port, host); });
    };
    inside.close = () => { closed = true; for (const entry of externals.values()) { try { entry.socket.close(); } catch {} } };
    inside.natStats = stats;
    inside.externalPorts = () => [...externals.values()].map((entry) => entry.socket.address().port);
    return inside;
  };
}

module.exports = { createNatSocketFactory };
