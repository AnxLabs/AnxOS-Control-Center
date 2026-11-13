#!/usr/bin/env node
"use strict";

// Phase 8 per-interface network telemetry and connection check
// (src/shared/networkDetails.js). Hermetic: fixtures for Linux and Windows,
// fake ping output, a fake name lookup and connect. Nothing reaches a network.
//   N1 Linux: interfaces, kinds, link speed (unknown stays null), addresses,
//      default gateway from /proc/net/route, DNS servers
//   N2 rates need two samples; a counter that went backwards gives no rate
//   N3 Windows: Get-NetAdapter JSON, Wi-Fi without a link speed, virtual
//      adapters, gateway and DNS
//   N4 ping parsing (Linux, Windows, French Windows, total loss)
//   N5 the connection check reports each step and stops at a failed lookup
//   N6 an unsupported platform and unreadable counters are reported, not zero
//   N7 the Agent's summary and its route carry the data with system:read

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const nd = require("../src/shared/networkDetails");

const PROC_NET_DEV = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  5000      50    0    0    0     0          0         0     5000      50    0    0    0     0       0          0
  eth0: 1000000   900    2    3    0     0          0         0   400000     800    1    4    0     0       0          0
 wlan0:    500      5    0    0    0     0          0         0      100       1    0    0    0     0       0          0
docker0:      0      0    0    0    0     0          0         0        0       0    0    0    0     0       0          0
`;
const PROC_NET_ROUTE = `Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
eth0	00000000	0101A8C0	0003	0	0	100	00000000	0	0	0
wlan0	00000000	0101A8C0	0003	0	0	600	00000000	0	0	0
eth0	0001A8C0	00000000	0001	0	0	100	00FFFFFF	0	0	0
`;

function linuxFs(counters = PROC_NET_DEV) {
  const files = {
    "/proc/net/dev": counters,
    "/proc/net/route": PROC_NET_ROUTE,
    "/etc/resolv.conf": "# generated\nnameserver 192.168.1.1\nnameserver 1.1.1.1\nsearch lan\n",
    "/sys/class/net/eth0/speed": "1000\n",
    "/sys/class/net/eth0/operstate": "up\n",
    "/sys/class/net/wlan0/speed": "-1\n",
    "/sys/class/net/wlan0/operstate": "up\n",
    "/sys/class/net/docker0/operstate": "down\n",
  };
  const dirs = new Set(["/sys/class/net/wlan0/wireless", "/sys/devices/virtual/net/docker0"]);
  return {
    readFile: async (file) => { if (file in files) return files[file]; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
    exists: async (file) => dirs.has(file),
  };
}
const linuxIfs = {
  eth0: [{ family: "IPv4", address: "192.168.1.134" }, { family: "IPv6", address: "fe80::1" }, { family: "IPv6", address: "2001:db8::5" }],
  wlan0: [{ family: "IPv4", address: "192.168.1.140" }],
};

async function main() {
  // N1
  let clock = 1_000_000;
  let counters = PROC_NET_DEV;
  const fsLinux = linuxFs();
  const linux = nd.createNetworkDetailsSampler({ platform: "linux", readFile: (file) => (file === "/proc/net/dev" ? Promise.resolve(counters) : fsLinux.readFile(file)), exists: fsLinux.exists, networkInterfaces: () => linuxIfs, now: () => clock });
  const first = await linux();
  assert.strictEqual(first.reason, "warming_up");
  assert.deepStrictEqual(first.interfaces.map((row) => [row.name, row.kind, row.up, row.linkSpeedMbps]), [["eth0", "ethernet", true, 1000], ["wlan0", "wifi", true, null], ["docker0", "virtual", false, null]], "loopback is left out; Wi-Fi's unknown speed stays null");
  const eth = first.interfaces[0];
  assert.deepStrictEqual([eth.ipv4, eth.ipv6], [["192.168.1.134"], ["2001:db8::5"]], "link-local IPv6 is left out");
  assert.deepStrictEqual([eth.errors, eth.dropped, eth.downloadPerSecond], [3, 7, null], "errors and drops are summed; no rate from one sample");
  assert.deepStrictEqual(first.gateway, { address: "192.168.1.1", interface: "eth0" }, "the lowest-metric default route");
  assert.deepStrictEqual(first.dnsServers, ["192.168.1.1", "1.1.1.1"]);
  console.log("PASS N1 Linux interfaces, link speed, addresses, gateway and DNS");

  // N2
  clock += 500;
  assert.strictEqual(await linux(), first, "a reading younger than the cache is reused");
  clock += 1500;
  counters = PROC_NET_DEV.replace("1000000   900", "1200000   950").replace("400000     800", "500000     850");
  const second = await linux();
  assert.strictEqual(second.reason, null);
  assert.deepStrictEqual([second.interfaces[0].downloadPerSecond, second.interfaces[0].uploadPerSecond], [100000, 50000], "bytes over two seconds");
  clock += 2500;
  counters = PROC_NET_DEV.replace("1000000   900", "10   900");
  const third = await linux();
  assert.strictEqual(third.interfaces[0].downloadPerSecond, null, "a counter that went backwards gives no rate");
  console.log("PASS N2 rates need two samples; a reset counter gives no rate");

  // N3
  const windowsJson = JSON.stringify({
    adapters: [
      { Name: "Ethernet", InterfaceDescription: "Realtek PCIe 2.5GbE", Status: "Up", ReceiveLinkSpeed: 1000000000, MediaType: "802.3", ifIndex: 7, Virtual: false },
      { Name: "Wi-Fi", InterfaceDescription: "Intel Wi-Fi 6E", Status: "Disconnected", ReceiveLinkSpeed: 0, MediaType: "Native 802.11", ifIndex: 9, Virtual: false },
      { Name: "vEthernet (WSL)", InterfaceDescription: "Hyper-V Virtual Ethernet Adapter", Status: "Up", ReceiveLinkSpeed: 10000000000, MediaType: "802.3", ifIndex: 40, Virtual: true },
      { Name: "Tailscale", InterfaceDescription: "Tailscale Tunnel", Status: "Up", ReceiveLinkSpeed: 100000000000, MediaType: "802.3", ifIndex: 12, Virtual: false },
    ],
    stats: { Name: "Ethernet", ReceivedBytes: 5000, SentBytes: 2000, ReceivedDiscardedPackets: 1, OutboundDiscardedPackets: 0, ReceivedPacketErrors: 0, OutboundPacketErrors: 2 },
    gateway: { NextHop: "192.168.1.1", InterfaceAlias: "Ethernet" },
    dns: [{ InterfaceAlias: "Ethernet", ServerAddresses: ["192.168.1.1"] }, { InterfaceAlias: "Tailscale", ServerAddresses: "100.100.100.100" }],
  });
  let commands = 0;
  const windows = nd.createNetworkDetailsSampler({ platform: "win32", execFile: async (command, args) => { commands += 1; assert.strictEqual(command, "powershell.exe"); assert.ok(args.includes("-NonInteractive")); return { ok: true, stdout: windowsJson }; }, networkInterfaces: () => ({ Ethernet: [{ family: "IPv4", address: "192.168.1.20" }] }), now: () => clock });
  const win = await windows();
  assert.deepStrictEqual(win.interfaces.map((row) => [row.name, row.kind, row.up, row.linkSpeedMbps]), [["Ethernet", "ethernet", true, 1000], ["Wi-Fi", "wifi", false, null], ["vEthernet (WSL)", "virtual", true, 10000], ["Tailscale", "vpn", true, 100000]]);
  assert.deepStrictEqual([win.interfaces[0].errors, win.interfaces[0].dropped, win.interfaces[0].ipv4], [2, 1, ["192.168.1.20"]]);
  assert.strictEqual(win.interfaces[1].errors, null, "an adapter without statistics reports null, not 0");
  assert.deepStrictEqual([win.gateway, win.dnsServers], [{ address: "192.168.1.1", interface: "Ethernet" }, ["192.168.1.1", "100.100.100.100"]]);
  clock += 5000;
  await windows();
  assert.strictEqual(commands, 1, "PowerShell is not started again within its 15-second cache");
  console.log("PASS N3 Windows adapters, statistics, gateway and DNS (one PowerShell query per 15 s)");

  // N4
  const linuxPing = "3 packets transmitted, 3 received, 0% packet loss, time 2003ms\nrtt min/avg/max/mdev = 0.412/0.538/0.700/0.120 ms";
  const windowsPing = "Reply from 192.168.1.1: bytes=32 time=1ms TTL=64\n    Packets: Sent = 3, Received = 3, Lost = 0 (0% loss),\n    Minimum = 1ms, Maximum = 2ms, Average = 1ms";
  const frenchPing = "Réponse de 192.168.1.1 : octets=32 temps=2 ms TTL=64\n    Paquets : envoyés = 3, reçus = 3, perdus = 0 (perte 0%),\n    Minimum = 2ms, Maximum = 3ms, Moyenne = 2ms";
  const lostPing = "3 packets transmitted, 0 received, 100% packet loss, time 2040ms";
  assert.deepStrictEqual(nd._test.parsePing(linuxPing), { lossPercent: 0, latencyMs: 0.5 });
  assert.deepStrictEqual(nd._test.parsePing(windowsPing), { lossPercent: 0, latencyMs: 1 });
  assert.deepStrictEqual(nd._test.parsePing(frenchPing).latencyMs, 2);
  assert.deepStrictEqual(nd._test.parsePing(lostPing), { lossPercent: 100, latencyMs: null });
  console.log("PASS N4 ping output is read on Linux, Windows and French Windows; total loss has no latency");

  // N5
  const pings = [];
  const ok = await nd.runNetworkCheck({ gateway: "192.168.1.1", platform: "linux", execFile: async (command, args) => { pings.push([command, ...args]); return { ok: true, stdout: linuxPing }; }, lookup: async () => ({ address: "93.184.215.14" }), connect: async (host, port) => { assert.deepStrictEqual([host, port], ["93.184.215.14", 443]); return true; } });
  assert.deepStrictEqual(pings, [["ping", "-c", "3", "-W", "1", "192.168.1.1"]], "three pings to the router, nothing else");
  assert.deepStrictEqual([ok.router.ok, ok.router.lossPercent, ok.nameLookup.ok, ok.internet.ok], [true, 0, true, true]);
  let connected = false;
  const noDns = await nd.runNetworkCheck({ gateway: null, lookup: async () => { throw Object.assign(new Error("no"), { code: "ENOTFOUND" }); }, connect: async () => { connected = true; } });
  assert.deepStrictEqual([noDns.router.reason, noDns.nameLookup.reason, noDns.internet.reason, connected], ["no_gateway", "ENOTFOUND", "name_lookup_failed", false], "no connection is attempted after a failed lookup");
  const bad = await nd.runNetworkCheck({ gateway: "192.168.1.1; rm -rf /", execFile: async () => { throw new Error("must not run"); }, lookup: async () => ({ address: "1.2.3.4" }), connect: async () => true });
  assert.strictEqual(bad.router.reason, "invalid_address", "only an IP address is ever passed to ping");
  console.log("PASS N5 the check reports router, name lookup and internet; it stops after a failed lookup");

  // N6
  const mac = await nd.createNetworkDetailsSampler({ platform: "darwin" })();
  assert.deepStrictEqual([mac.supported, mac.reason, mac.interfaces.length], [false, "unsupported_platform", 0]);
  const broken = await nd.createNetworkDetailsSampler({ platform: "win32", execFile: async () => ({ ok: false, stdout: "" }) })();
  assert.deepStrictEqual([broken.supported, broken.reason], [true, "counters_unreadable"]);
  console.log("PASS N6 unsupported platforms and unreadable counters are reported, not shown as zero");

  // N7
  const agentSystem = fs.readFileSync(path.join(__dirname, "..", "agent", "src", "services", "systemService.js"), "utf8");
  assert.match(agentSystem, /networkDetails: details,/, "the Agent summary carries networkDetails");
  const server = fs.readFileSync(path.join(__dirname, "..", "agent", "src", "server.js"), "utf8");
  assert.match(server, /"\/api\/v1\/system\/network-check"[^\n]*return "system:read"/, "the check is read-tier");
  assert.match(server, /network-check" && request\.method === "POST"/, "the check runs only on POST");
  console.log("PASS N7 the Agent summary and route carry the data at system:read");

  // N8 what the Computers page shows
  const Model = require("../src/shared/homeDashboardModel");
  const shown = Model.describeNetworkDetails(win);
  assert.deepStrictEqual(shown.main.map((row) => [row.name, row.link, row.issuesText]), [["Ethernet", "1 Gb/s", "2 errors, 1 dropped"]], "only the connected wired/Wi-Fi adapter is in the main list");
  assert.deepStrictEqual(shown.other.map((row) => row.name), ["Wi-Fi", "vEthernet (WSL)", "Tailscale"], "virtual, VPN and disconnected adapters are listed separately");
  assert.strictEqual(shown.other[0].link, "Not reported", "no link speed is invented for a disconnected adapter");
  assert.strictEqual(Model.describeNetworkDetails(null).available, false, "an older Agent without network details says so");
  const steps = Model.describeNetworkCheck(ok);
  assert.deepStrictEqual(steps.map((step) => [step.id, step.ok]), [["router", true], ["lookup", true], ["internet", true]]);
  assert.match(Model.describeNetworkCheck(noDns)[2].text, /Not tested/, "internet is not reported as down when it was never tested");
  console.log("PASS N8 the Computers page lists connected adapters first and words each check step plainly");
  console.log("Network details smoke: 8 checks passed.");
}

main().catch((error) => {
  console.error("FAILED:", error);
  process.exit(1);
});
