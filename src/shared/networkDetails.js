"use strict";

// Per-interface network telemetry and an on-demand connection check
// (Phase 8). Shared by the Agent (agent/src/services/systemService.js) and the
// desktop when it manages this PC directly (src/services/systemService.js).
//
// Rules, as in metricsSampler.js:
//   * Never fabricate. A rate needs two samples; a value the platform does not
//     report (link speed of a Wi-Fi or virtual adapter, errors on some
//     drivers) is null, never 0.
//   * Link speed is what the adapter negotiated with the switch or access
//     point. It is not internet speed and is never shown as such.
//   * Passive collection only: /proc/net/dev, /sys/class/net, /proc/net/route
//     and /etc/resolv.conf on Linux; one PowerShell query on Windows, cached.
//     The active check (router ping, one name lookup, one HTTPS connection)
//     runs only when a person asks for it.

const childProcess = require("child_process");
const dns = require("dns");
const fs = require("fs/promises");
const net = require("net");
const os = require("os");

const LINUX_CACHE_MS = 2000;
const WINDOWS_CACHE_MS = 15 * 1000;
const COMMAND_TIMEOUT_MS = 8000;
const MAX_INTERFACES = 32;
const CHECK_HOST = "example.com";

const VPN_NAME = /tailscale|zerotier|wireguard|^wg\d|utun|^tun\d|^tap\d|openvpn|nordlynx|anxnet/i;
const VIRTUAL_NAME = /vethernet|wsl|hyper-v|virtualbox|vmware|vmnet|vbox|docker|^br-|^veth|virbr|loopback|isatap|teredo|6to4|bluetooth/i;

function defaultExecFile(command, args, options = {}) {
  return new Promise((resolve) => {
    try {
      childProcess.execFile(command, args, { timeout: options.timeout || COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
        resolve({ ok: !error, stdout: String(stdout || ""), code: error?.code || null });
      });
    } catch (error) {
      resolve({ ok: false, stdout: "", code: error?.code || "SPAWN_FAILED" });
    }
  });
}

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function kindFromName(name, { wireless = false, virtual = false } = {}) {
  if (VPN_NAME.test(name)) return "vpn";
  if (virtual || VIRTUAL_NAME.test(name)) return "virtual";
  if (wireless || /wi-?fi|wlan|wireless|^wl/i.test(name)) return "wifi";
  if (/ethernet|^eth|^en/i.test(name)) return "ethernet";
  return "other";
}

// Addresses from Node, IPv4 first. Link-local IPv6 (fe80::) is left out: it
// is not an address anyone else can use.
function addressesFor(name, interfaces) {
  const entries = Array.isArray(interfaces?.[name]) ? interfaces[name] : [];
  const ipv4 = entries.filter((entry) => entry.family === "IPv4" || entry.family === 4).map((entry) => entry.address);
  const ipv6 = entries.filter((entry) => (entry.family === "IPv6" || entry.family === 6) && !/^fe80:/i.test(entry.address)).map((entry) => entry.address);
  return { ipv4, ipv6 };
}

// ---------------------------------------------------------------------------
// Linux
// ---------------------------------------------------------------------------

function parseProcNetDevInterfaces(content) {
  const rows = {};
  String(content || "").split(/\r?\n/).slice(2).forEach((line) => {
    const index = line.indexOf(":");
    if (index < 0) return;
    const name = line.slice(0, index).trim();
    const values = line.slice(index + 1).trim().split(/\s+/).map(Number);
    if (!name || values.length < 12) return;
    rows[name] = {
      rxBytes: values[0], rxErrors: values[2], rxDropped: values[3],
      txBytes: values[8], txErrors: values[10], txDropped: values[11],
    };
  });
  return rows;
}

// The default route: Destination 00000000 with the lowest metric. Addresses in
// /proc/net/route are little-endian hex.
function parseProcNetRoute(content) {
  const routes = String(content || "").split(/\r?\n/).slice(1).map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 8 && parts[1] === "00000000");
  routes.sort((a, b) => Number(a[6]) - Number(b[6]));
  const best = routes[0];
  if (!best || !/^[0-9a-f]{8}$/i.test(best[2])) return null;
  const hex = best[2];
  const address = [6, 4, 2, 0].map((offset) => parseInt(hex.slice(offset, offset + 2), 16)).join(".");
  return address === "0.0.0.0" ? null : { address, interface: best[0] };
}

function parseResolvConf(content) {
  return String(content || "").split(/\r?\n/).map((line) => /^\s*nameserver\s+(\S+)/.exec(line)?.[1]).filter(Boolean).slice(0, 6);
}

async function readLinux({ readFile, exists, interfaces }) {
  const counters = parseProcNetDevInterfaces(await readFile("/proc/net/dev"));
  const names = Object.keys(counters).filter((name) => name !== "lo").slice(0, MAX_INTERFACES);
  const rows = await Promise.all(names.map(async (name) => {
    const sys = `/sys/class/net/${name}`;
    const [speed, operstate, wireless, virtual] = await Promise.all([
      readFile(`${sys}/speed`).then((text) => finiteOrNull(text.trim())).catch(() => null),
      readFile(`${sys}/operstate`).then((text) => text.trim()).catch(() => "unknown"),
      exists(`${sys}/wireless`),
      exists(`/sys/devices/virtual/net/${name}`),
    ]);
    return {
      name,
      kind: kindFromName(name, { wireless, virtual }),
      up: operstate === "up" || (operstate === "unknown" && addressesFor(name, interfaces).ipv4.length > 0),
      // The kernel reports -1 (or nothing) when it does not know the speed.
      linkSpeedMbps: speed !== null && speed > 0 ? speed : null,
      ...addressesFor(name, interfaces),
      counters: counters[name],
    };
  }));
  const gateway = parseProcNetRoute(await readFile("/proc/net/route").catch(() => ""));
  const dnsServers = parseResolvConf(await readFile("/etc/resolv.conf").catch(() => ""));
  return { interfaces: rows, gateway, dnsServers, source: "linux-proc-sys" };
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const WINDOWS_QUERY = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$a=@(Get-NetAdapter | Select-Object Name,InterfaceDescription,Status,ReceiveLinkSpeed,MediaType,ifIndex,Virtual)",
  "$s=@(Get-NetAdapterStatistics | Select-Object Name,ReceivedBytes,SentBytes,ReceivedDiscardedPackets,OutboundDiscardedPackets,ReceivedPacketErrors,OutboundPacketErrors)",
  "$g=Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1 NextHop,InterfaceAlias",
  "$d=@(Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object { $_.ServerAddresses } | Select-Object InterfaceAlias,ServerAddresses)",
  "@{adapters=$a;stats=$s;gateway=$g;dns=$d} | ConvertTo-Json -Depth 4 -Compress",
].join(";");

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

function parseWindowsQuery(output, interfaces) {
  let parsed;
  try {
    parsed = JSON.parse(String(output || "").trim());
  } catch {
    return null;
  }
  const stats = new Map(asArray(parsed.stats).map((row) => [row.Name, row]));
  const rows = asArray(parsed.adapters).slice(0, MAX_INTERFACES).map((adapter) => {
    const stat = stats.get(adapter.Name) || {};
    const speedBits = finiteOrNull(adapter.ReceiveLinkSpeed);
    const label = `${adapter.Name} ${adapter.InterfaceDescription || ""}`;
    const wireless = /802\.11|wireless|wi-?fi/i.test(`${adapter.MediaType || ""} ${label}`);
    return {
      name: String(adapter.Name || ""),
      description: String(adapter.InterfaceDescription || ""),
      kind: kindFromName(label, { wireless, virtual: adapter.Virtual === true }),
      up: String(adapter.Status || "").toLowerCase() === "up",
      linkSpeedMbps: speedBits && speedBits > 0 ? Math.round(speedBits / 1e6) : null,
      ...addressesFor(adapter.Name, interfaces),
      counters: stat.Name ? {
        rxBytes: finiteOrNull(stat.ReceivedBytes), txBytes: finiteOrNull(stat.SentBytes),
        rxErrors: finiteOrNull(stat.ReceivedPacketErrors), txErrors: finiteOrNull(stat.OutboundPacketErrors),
        rxDropped: finiteOrNull(stat.ReceivedDiscardedPackets), txDropped: finiteOrNull(stat.OutboundDiscardedPackets),
      } : null,
    };
  });
  const gatewayAddress = parsed.gateway?.NextHop && parsed.gateway.NextHop !== "0.0.0.0" ? String(parsed.gateway.NextHop) : null;
  const dnsServers = [...new Set(asArray(parsed.dns).flatMap((row) => asArray(row.ServerAddresses)).map(String))].slice(0, 6);
  return {
    interfaces: rows,
    gateway: gatewayAddress ? { address: gatewayAddress, interface: String(parsed.gateway.InterfaceAlias || "") } : null,
    dnsServers,
    source: "windows-netadapter",
  };
}

// ---------------------------------------------------------------------------
// Sampler
// ---------------------------------------------------------------------------

function rate(next, previous, key, seconds) {
  if (!previous || !(seconds > 0)) return null;
  const a = next?.[key];
  const b = previous?.[key];
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < b) return null; // a reset counter gives no rate
  return Math.round((a - b) / seconds);
}

function createNetworkDetailsSampler({
  platform = process.platform,
  readFile = (file) => fs.readFile(file, "utf8"),
  exists = (file) => fs.access(file).then(() => true, () => false),
  execFile = defaultExecFile,
  networkInterfaces = () => os.networkInterfaces(),
  now = () => Date.now(),
} = {}) {
  let previous = null; // { at, byName: Map(name -> counters) }
  let cache = null;
  let pending = null;
  const cacheMs = platform === "win32" ? WINDOWS_CACHE_MS : LINUX_CACHE_MS;

  async function collect() {
    const interfaces = networkInterfaces();
    if (platform === "linux") return readLinux({ readFile, exists, interfaces });
    if (platform === "win32") {
      const result = await execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_QUERY]);
      return result.ok ? parseWindowsQuery(result.stdout, interfaces) : null;
    }
    return undefined;
  }

  async function sample() {
    const at = now();
    let raw;
    try {
      raw = await collect();
    } catch {
      raw = null;
    }
    if (raw === undefined) return { supported: false, reason: "unsupported_platform", interfaces: [], gateway: null, dnsServers: [], checkedAt: new Date(at).toISOString() };
    if (!raw) return { supported: true, reason: "counters_unreadable", interfaces: [], gateway: null, dnsServers: [], checkedAt: new Date(at).toISOString() };
    const seconds = previous ? (at - previous.at) / 1000 : 0;
    const rows = raw.interfaces.map((row) => {
      const before = previous?.byName.get(row.name);
      const counters = row.counters;
      return {
        name: row.name,
        description: row.description || "",
        kind: row.kind,
        up: row.up,
        linkSpeedMbps: row.linkSpeedMbps,
        ipv4: row.ipv4,
        ipv6: row.ipv6,
        downloadPerSecond: counters ? rate(counters, before, "rxBytes", seconds) : null,
        uploadPerSecond: counters ? rate(counters, before, "txBytes", seconds) : null,
        totalDownload: counters?.rxBytes ?? null,
        totalUpload: counters?.txBytes ?? null,
        errors: counters && Number.isFinite(counters.rxErrors) && Number.isFinite(counters.txErrors) ? counters.rxErrors + counters.txErrors : null,
        dropped: counters && Number.isFinite(counters.rxDropped) && Number.isFinite(counters.txDropped) ? counters.rxDropped + counters.txDropped : null,
      };
    });
    previous = { at, byName: new Map(raw.interfaces.filter((row) => row.counters).map((row) => [row.name, row.counters])) };
    return {
      supported: true,
      reason: seconds > 0 ? null : "warming_up",
      interfaces: rows,
      gateway: raw.gateway,
      dnsServers: raw.dnsServers,
      source: raw.source,
      checkedAt: new Date(at).toISOString(),
    };
  }

  return async function sampleNetworkDetails() {
    const at = now();
    if (cache && at - cache.at < cacheMs) return cache.value;
    if (pending) return pending;
    pending = sample().then((value) => {
      cache = { at, value };
      return value;
    }).finally(() => { pending = null; });
    return pending;
  };
}

// ---------------------------------------------------------------------------
// On-demand connection check
// ---------------------------------------------------------------------------

// `ping` output differs by platform and language; only the numbers are read.
function parsePing(output) {
  const text = String(output || "");
  const loss = /(\d+(?:\.\d+)?)%\s*(?:packet\s*)?loss/i.exec(text) || /\((\d+)%\s*\w+\)/.exec(text);
  const linuxAvg = /=\s*[\d.]+\/([\d.]+)\/[\d.]+/.exec(text);
  const windowsAvg = /(?:Average|Moyenne|Mittelwert|Media)\s*=\s*(\d+)\s*ms/i.exec(text);
  const times = [...text.matchAll(/(?:time|temps|zeit|tiempo)[=<]\s*([\d.]+)\s*ms/gi)].map((match) => Number(match[1]));
  const average = linuxAvg ? Number(linuxAvg[1]) : windowsAvg ? Number(windowsAvg[1]) : times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
  return {
    lossPercent: loss ? Number(loss[1]) : null,
    latencyMs: Number.isFinite(average) ? Math.round(average * 10) / 10 : null,
  };
}

async function pingHost(address, { platform = process.platform, execFile = defaultExecFile, count = 3 } = {}) {
  if (!net.isIP(address)) return { ok: false, reason: "invalid_address", lossPercent: null, latencyMs: null };
  const args = platform === "win32" ? ["-n", String(count), "-w", "1000", address] : ["-c", String(count), "-W", "1", address];
  const result = await execFile("ping", args, { timeout: count * 1500 + 2000 });
  const parsed = parsePing(result.stdout);
  if (parsed.lossPercent === null && parsed.latencyMs === null) return { ok: false, reason: result.code === "ENOENT" ? "ping_unavailable" : "no_reply", lossPercent: null, latencyMs: null };
  return { ok: parsed.lossPercent !== 100, reason: null, ...parsed };
}

function timed(fn) {
  const started = process.hrtime.bigint();
  return fn().then(
    (value) => ({ value, ms: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10 }),
    (error) => ({ error, ms: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10 }),
  );
}

function tcpConnect(host, port, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })); }, timeoutMs);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

// Three checks, in the order a home connection depends on them: the router,
// name lookup, and the internet. Each is one small request.
async function runNetworkCheck({
  gateway = null,
  platform = process.platform,
  execFile = defaultExecFile,
  lookup = (host) => dns.promises.lookup(host, { family: 4 }),
  connect = tcpConnect,
  host = CHECK_HOST,
} = {}) {
  const startedAt = new Date().toISOString();
  const router = gateway
    ? { address: gateway, ...(await pingHost(gateway, { platform, execFile })) }
    : { address: null, ok: false, reason: "no_gateway", lossPercent: null, latencyMs: null };
  const lookedUp = await timed(() => lookup(host));
  const nameLookup = lookedUp.error
    ? { host, ok: false, reason: lookedUp.error.code || "lookup_failed", latencyMs: null }
    : { host, ok: true, reason: null, latencyMs: lookedUp.ms };
  let internet;
  if (!nameLookup.ok) {
    internet = { host, ok: false, reason: "name_lookup_failed", latencyMs: null };
  } else {
    const connected = await timed(() => connect(lookedUp.value.address, 443));
    internet = connected.error
      ? { host, ok: false, reason: connected.error.code || "connect_failed", latencyMs: null }
      : { host, ok: true, reason: null, latencyMs: connected.ms };
  }
  return { startedAt, finishedAt: new Date().toISOString(), router, nameLookup, internet };
}

module.exports = {
  CHECK_HOST,
  createNetworkDetailsSampler,
  runNetworkCheck,
  _test: { parseProcNetDevInterfaces, parseProcNetRoute, parseResolvConf, parseWindowsQuery, parsePing, kindFromName, WINDOWS_QUERY },
};
