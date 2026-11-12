"use strict";

// What this computer's own addresses say about reaching it from outside
// (Phase 7.1). This is a local reading only: it can tell "behind carrier-grade
// NAT" or "has a public address", but whether a router forwards a port can
// only be known by testing from outside, which AnxOS never claims to have
// done here.

const os = require("os");

const VPN_ADAPTER = /tailscale|zerotier|wireguard|wg\d|utun|tun\d|tap\d|openvpn|nordlynx|anxnet/i;
const VIRTUAL_ADAPTER = /vethernet|wsl|hyper-v|virtualbox|vmware|vmnet|vbox|docker|br-|veth|virbr/i;
const VIRTUAL_MAC = /^(0a:00:27|08:00:27|00:15:5d|00:50:56|00:0c:29|00:05:69|00:1c:14|02:42:)/i;

function ipv4Parts(address) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(address));
  return match ? match.slice(1).map(Number) : null;
}

// One address: "private", "cgnat", "vpn", "virtual", "link-local",
// "loopback" or "public".
function classifyAddress({ address, name = "", mac = "" }) {
  const parts = ipv4Parts(address);
  if (!parts) return "other";
  const [a, b] = parts;
  if (a === 127) return "loopback";
  if (a === 169 && b === 254) return "link-local";
  if (VIRTUAL_ADAPTER.test(name) || VIRTUAL_MAC.test(mac)) return "virtual";
  if (VPN_ADAPTER.test(name)) return "vpn";
  if (a === 100 && b >= 64 && b <= 127) return "cgnat";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
  return "public";
}

// A summary for the UI. `interfaces` defaults to this computer's.
function assessReachability(interfaces = os.networkInterfaces()) {
  const addresses = Object.entries(interfaces || {})
    .flatMap(([name, entries]) => (entries || []).map((entry) => ({ name, ...entry })))
    .filter((entry) => entry.family === "IPv4" || entry.family === 4)
    .map((entry) => ({ address: entry.address, name: entry.name, kind: classifyAddress(entry) }))
    .filter((entry) => !["loopback", "link-local", "other"].includes(entry.kind));
  const has = (kind) => addresses.some((entry) => entry.kind === kind);
  let verdict;
  if (has("public")) verdict = { key: "public", text: "This computer has a public address. Others can connect directly if its firewall allows it (not tested from outside)." };
  else if (has("cgnat")) verdict = { key: "cgnat", text: "This computer is behind carrier-grade NAT (a 100.64.x.x address from the provider). Devices outside your home usually can't connect to it directly; AnxNet needs a relay for them." };
  else if (has("private")) verdict = { key: "private", text: "This computer is on a home network behind a router. Outside devices connect directly only if hole punching works or a port is forwarded; otherwise AnxNet uses a relay." };
  else verdict = { key: "none", text: "This computer has no network address that other devices can use right now." };
  return { addresses, verdict, vpn: has("vpn"), testedFromOutside: false };
}

module.exports = { assessReachability, classifyAddress };
