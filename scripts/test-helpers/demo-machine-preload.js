"use strict";

// Demo machine facts for product screenshots (capture-anxhost-rc3-screenshots.js),
// so no screen shows the capturing PC's own details. Loaded with --require into
// the disposable fixture Agent, and required in the app's main process.
//   ANX_DEMO_HOSTNAME  host name to report
//   ANX_DEMO_ADDRESS   the one LAN address, from 192.0.2.0/24 (RFC 5737, documentation only)
// The disk reads as 2 TB, 38% used. netstat/ss/tasklist list only the demo
// servers; ipconfig, route and arp return nothing.

const os = require("os");
const fs = require("fs");
const childProcess = require("child_process");

const hostname = process.env.ANX_DEMO_HOSTNAME || "demo-host";
const address = process.env.ANX_DEMO_ADDRESS || "192.0.2.10";

os.hostname = () => hostname;
// An 8-core, 32 GB machine on a released Windows 11 build.
// Steady synthetic counters: about 22% busy on every core.
const cpuStart = Date.now();
os.cpus = () => {
  const elapsed = Date.now() - cpuStart + 60_000;
  return Array.from({ length: 8 }, () => ({
    model: "Demo 8-Core Processor",
    speed: 3600,
    times: { user: Math.round(elapsed * 0.18), nice: 0, sys: Math.round(elapsed * 0.04), idle: Math.round(elapsed * 0.78), irq: 0 },
  }));
};
os.totalmem = () => 32 * 1024 ** 3;
os.freemem = () => Math.round(19.4 * 1024 ** 3);
if (process.platform === "win32") os.release = () => "10.0.26100";
os.networkInterfaces = () => ({
  Ethernet: [{ address, netmask: "255.255.255.0", family: "IPv4", mac: "02:00:00:00:00:01", internal: false, cidr: `${address}/24` }],
  "Loopback Pseudo-Interface 1": [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: true, cidr: "127.0.0.1/8" }],
});

const bsize = 4096;
const blocks = Math.floor(2e12 / bsize);
const bfree = Math.floor(blocks * 0.62);
const demoStatfs = () => ({ type: 0, bsize, blocks, bfree, bavail: bfree, files: 0, ffree: 0 });
if (fs.promises?.statfs) fs.promises.statfs = async () => demoStatfs();
if (fs.statfs) fs.statfs = (_path, options, callback) => { const done = typeof options === "function" ? options : callback; process.nextTick(() => done(null, demoStatfs())); };

const NETSTAT = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    127.0.0.1:25565        0.0.0.0:0              LISTENING       5101",
  "  TCP    127.0.0.1:25566        0.0.0.0:0              LISTENING       5102",
  "  TCP    127.0.0.1:2456         0.0.0.0:0              LISTENING       5103",
  "  TCP    127.0.0.1:30120        0.0.0.0:0              LISTENING       5104",
  "",
].join("\r\n");
const TASKLIST = [
  '"java.exe","5101","Services","0","6,291,456 K"',
  '"java.exe","5102","Services","0","2,097,152 K"',
  '"valheim_server.exe","5103","Services","0","3,145,728 K"',
  '"FXServer.exe","5104","Services","0","1,048,576 K"',
].join("\r\n");

const gateway = address.replace(/\.\d+$/, ".1");
// The adapter, gateway and DNS query in src/shared/networkDetails.js.
const ADAPTERS = JSON.stringify({
  adapters: [{ Name: "Ethernet", InterfaceDescription: "Demo 2.5GbE Controller", Status: "Up", ReceiveLinkSpeed: 2500000000, MediaType: "802.3", ifIndex: 7, Virtual: false }],
  stats: [{ Name: "Ethernet", ReceivedBytes: 48_213_771_264, SentBytes: 31_904_112_640, ReceivedDiscardedPackets: 0, OutboundDiscardedPackets: 0, ReceivedPacketErrors: 0, OutboundPacketErrors: 0 }],
  gateway: { NextHop: gateway, InterfaceAlias: "Ethernet" },
  dns: [{ InterfaceAlias: "Ethernet", ServerAddresses: [gateway] }],
});
const PING = [
  `Pinging ${gateway} with 32 bytes of data:`,
  `Reply from ${gateway}: bytes=32 time=1ms TTL=64`,
  `Reply from ${gateway}: bytes=32 time=1ms TTL=64`,
  `Reply from ${gateway}: bytes=32 time=2ms TTL=64`,
  "",
  `Ping statistics for ${gateway}:`,
  "    Packets: Sent = 3, Received = 3, Lost = 0 (0% loss),",
  "Approximate round trip times in milli-seconds:",
  "    Minimum = 1ms, Maximum = 2ms, Average = 1ms",
].join("\r\n");

function demoOutput(command, args) {
  const name = String(command || "").toLowerCase().replace(/^.*[\\/]/, "").replace(/\.exe$/, "");
  const joined = Array.isArray(args) ? args.join(" ") : "";
  if (name === "netstat" || name === "ss") return NETSTAT;
  if (name === "tasklist") return TASKLIST;
  if (name === "ipconfig" || name === "route" || name === "arp") return "";
  if ((name === "powershell" || name === "pwsh") && /Get-NetAdapter|Get-NetRoute|Get-NetIPConfiguration|Get-DnsClientServerAddress/i.test(joined)) return ADAPTERS;
  if (name === "ping") return PING;
  return null;
}

const realExecFile = childProcess.execFile;
childProcess.execFile = function demoExecFile(command, ...rest) {
  const output = demoOutput(command, rest[0]);
  if (output === null) return realExecFile.call(this, command, ...rest);
  const done = rest.find((value) => typeof value === "function");
  process.nextTick(() => done?.(null, output, ""));
  const fake = { pid: 0, stdout: null, stderr: null, kill() {}, on() { return fake; }, once() { return fake; } };
  return fake;
};

const realExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function demoExecFileSync(command, ...rest) {
  const output = demoOutput(command, rest[0]);
  if (output === null) return realExecFileSync.call(this, command, ...rest);
  const options = rest.find((value) => value && typeof value === "object" && !Array.isArray(value)) || {};
  return options.encoding ? output : Buffer.from(output);
};
