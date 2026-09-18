const childProcess = require("child_process");
const os = require("os");

// V2-H: read-only network inventory for the agent host — interfaces, listening
// ports, cross-interface port conflicts, and a single-port bound check.
// Discovery only: nothing here provisions, writes, or opens sockets. Node has
// no portable listener enumeration, so listeners come from the platform's own
// netstat/ss output, parsed defensively and capped. Commands run via execFile
// (no shell) with timeouts, mirroring systemService's exec pattern.
const LISTENER_COMMAND_TIMEOUT_MS = 5000;
const LISTENER_COMMAND_MAX_BUFFER = 512 * 1024;
const MAX_LISTENER_ROWS = 1000;
const MAX_REPORTED_CONFLICT_ADDRESSES = 32;

let execFileImpl = execFile;
let networkInterfacesImpl = () => os.networkInterfaces();

function execFile(command, args, options = {}) {
  return new Promise((resolve) => {
    childProcess.execFile(command, args, {
      timeout: options.timeout || LISTENER_COMMAND_TIMEOUT_MS,
      maxBuffer: options.maxBuffer || LISTENER_COMMAND_MAX_BUFFER,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout || "",
        stderr: stderr || "",
      });
    });
  });
}

// Conflict rule: the same (protocol, port) bound on more than one distinct
// local address. The one exception is the normal dual-stack wildcard pair
// (0.0.0.0 + [::] or * + [::]), which is a single listener covering both
// families, not a collision.
const DUAL_STACK_WILDCARD = new Set(["0.0.0.0", "*", "[::]", "::"]);

function isWildcardAddress(address) {
  return DUAL_STACK_WILDCARD.has(address);
}

function isNormalDualStackWildcard(addresses) {
  if (addresses.size !== 2) {
    return false;
  }
  const hasIpv4Wildcard = addresses.has("0.0.0.0") || addresses.has("*");
  const hasIpv6Wildcard = addresses.has("[::]") || addresses.has("::");
  return hasIpv4Wildcard && hasIpv6Wildcard;
}

// "0.0.0.0:135" / "[::]:135" / "*:22" → { address, port }. Bare unbracketed
// IPv6 (colon-separated but not bracket-terminated) is rejected as malformed.
function splitHostPort(raw) {
  const value = String(raw || "").trim();
  const separator = value.lastIndexOf(":");
  if (separator <= 0) {
    return null;
  }
  const portText = value.slice(separator + 1);
  if (!/^\d+$/.test(portText)) {
    return null;
  }
  const port = Number(portText);
  if (port > 65535) {
    return null;
  }
  const address = value.slice(0, separator);
  if (!address) {
    return null;
  }
  // Bare unbracketed IPv6 (e.g. "::1" with no port) is ambiguous, but the
  // netstat Linux form ":::22" (host "::" + port) legitimately appears, so
  // accept address parts made only of hex digits, dots, colons, and zones.
  if (address.includes(":") && !address.endsWith("]") && !/^[0-9a-fA-F:.]+$/.test(address)) {
    return null;
  }
  return { address, port };
}

function normalizeListenerProtocol(value) {
  const protocol = String(value || "").trim().toLowerCase();
  if (protocol.startsWith("tcp")) return "tcp";
  if (protocol.startsWith("udp")) return "udp";
  return null;
}

// Windows `netstat -ano`: Proto Local Foreign State PID. The TCP state word
// is LOCALE-DEPENDENT ("LISTENING", "ÉCOUTE", "ABHÖREN", ...) but the column
// POSITIONS are fixed, and a listening row's foreign address is always the
// wildcard-with-port-0 form (0.0.0.0:0 / [::]:0). So listeners are selected
// state-agnostically: TCP row whose foreign endpoint parses with port 0.
// Parse telemetry (rawTcpRows/tcpRowsParsed) reports when raw TCP rows
// existed but none matched, so a shape that breaks the heuristic surfaces
// as telemetry instead of a silently empty inventory (review P1-3).
function parseWindowsNetstatListeners(stdout) {
  const rows = [];
  let rawTcpRows = 0;
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const fields = rawLine.trim().split(/\s+/);
    if (fields.length < 4) {
      continue;
    }
    const protocol = normalizeListenerProtocol(fields[0]);
    if (!protocol) {
      continue;
    }
    if (protocol === "tcp") {
      rawTcpRows += 1;
    }
    const local = splitHostPort(fields[1]);
    if (!local) {
      continue;
    }
    let pid = null;
    let state = null;
    if (protocol === "tcp") {
      const foreign = splitHostPort(fields[2] || "");
      // A listening socket's foreign endpoint is the wildcard with port 0.
      if (!foreign || foreign.port !== 0) {
        continue;
      }
      state = fields[3] || null;
      pid = Number(fields[4] ?? fields[3]);
    } else {
      // UDP rows are "Proto Local Foreign PID": the last column is the pid,
      // and every row is a bound socket.
      pid = Number(fields[fields.length - 1]);
    }
    if (!Number.isInteger(pid) || pid < 0) {
      continue;
    }
    rows.push({
      protocol,
      localAddress: local.address,
      localPort: local.port,
      state,
      pid,
      processName: null,
    });
  }
  const deduped = dedupeListenerRows(rows);
  return { rows: deduped, rawTcpRows, tcpRowsParsed: deduped.filter((row) => row.protocol === "tcp").length };
}

function findSsLocalAddressField(fields) {
  // ss rows are either "State Recv-Q Send-Q Local Peer Process" (classic) or
  // "Netid State Recv-Q Send-Q Local Peer Process". The local address is the
  // first non-numeric field that follows at least two numeric fields
  // (Recv-Q/Send-Q); header rows never satisfy that shape.
  let numericRun = 0;
  for (let index = 0; index < fields.length; index += 1) {
    if (/^\d+$/.test(fields[index])) {
      numericRun += 1;
      continue;
    }
    if (numericRun >= 2) {
      return splitHostPort(fields[index]);
    }
    numericRun = 0;
  }
  return null;
}

function parseSsProcessInfo(line) {
  const match = /users:\(\("([^"]*)",pid=(\d+)/.exec(String(line || ""));
  if (!match) {
    return { processName: null, pid: null };
  }
  return { processName: match[1] || null, pid: Number(match[2]) };
}

// `ss -tlnp` / `ss -ulnp`: TCP listeners report LISTEN, UDP rows report
function parseSsListeners(stdout, protocol) {
  const normalizedProtocol = normalizeListenerProtocol(protocol);
  if (!normalizedProtocol) {
    return [];
  }
  const expectedState = normalizedProtocol === "tcp" ? "LISTEN" : "UNCONN";
  const rows = [];
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const fields = rawLine.trim().split(/\s+/);
    if (!fields[0] || fields[0] === "State" || fields[0] === "Netid") {
      continue;
    }
    if (!fields.slice(0, 3).includes(expectedState)) {
      continue;
    }
    const local = findSsLocalAddressField(fields);
    if (!local) {
      continue;
    }
    const processInfo = parseSsProcessInfo(rawLine);
    rows.push({
      protocol: normalizedProtocol,
      localAddress: local.address,
      localPort: local.port,
      state: null,
      pid: processInfo.pid,
      processName: processInfo.processName,
    });
  }
  return dedupeListenerRows(rows);
}

// Linux netstat -tlnp / -ulnp fallback for hosts without ss.
function parseLinuxNetstatListeners(stdout, protocol) {
  const normalizedProtocol = normalizeListenerProtocol(protocol);
  if (!normalizedProtocol) {
    return [];
  }
  const rows = [];
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const fields = rawLine.trim().split(/\s+/);
    if (fields.length < 6) {
      continue;
    }
    const rowProtocol = normalizeListenerProtocol(fields[0]);
    if (rowProtocol !== normalizedProtocol) {
      continue;
    }
    // TCP rows end with State PID/Program; UDP rows end with PID/Program.
    if (normalizedProtocol === "tcp" && fields[5] !== "LISTEN") {
      continue;
    }
    const local = splitHostPort(fields[3]);
    if (!local) {
      continue;
    }
    const processInfo = /^(\d+)\/(.+)$/.exec(fields[fields.length - 1] || "");
    rows.push({
      protocol: normalizedProtocol,
      localAddress: local.address,
      localPort: local.port,
      state: normalizedProtocol === "tcp" ? fields[5] : null,
      pid: processInfo ? Number(processInfo[1]) : null,
      processName: processInfo ? processInfo[2] : null,
    });
  }
  return dedupeListenerRows(rows);
}

function dedupeListenerRows(rows) {
  const seen = new Set();
  const deduped = [];
  for (const row of rows) {
    const key = [row.protocol, row.localAddress, row.localPort, row.pid, row.state].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(row);
  }
  return deduped;
}

function capListenerRows(rows) {
  if (rows.length <= MAX_LISTENER_ROWS) {
    return { rows, truncated: false, dropped: 0 };
  }
  return {
    rows: rows.slice(0, MAX_LISTENER_ROWS),
    truncated: true,
    dropped: rows.length - MAX_LISTENER_ROWS,
  };
}

function describeListenerCommandFailure(source, result) {
  const message = String(result?.stderr || result?.error || "command failed").trim().split(/\r?\n/)[0];
  return `${source}: ${message.slice(0, 200) || "command failed"}`;
}

async function resolveWindowsProcessNames(rows) {
  const pids = [...new Set(rows.map((row) => row.pid).filter((pid) => Number.isInteger(pid) && pid > 0))];
  if (!pids.length) {
    return new Map();
  }
  const result = await execFileImpl("tasklist", ["/fo", "csv", "/nh"]);
  const nameByPid = new Map();
  for (const line of String(result.stdout || "").split(/\r?\n/)) {
    const match = /^"([^"]*)","(\d+)"/.exec(line.trim());
    if (match) {
      nameByPid.set(Number(match[2]), match[1]);
    }
  }
  return nameByPid;
}

async function collectWindowsListeners() {
  const result = await execFileImpl("netstat", ["-ano"]);
  if (!result.ok) {
    return {
      source: null,
      rows: [],
      truncated: false,
      dropped: 0,
      errors: [describeListenerCommandFailure("netstat", result)],
    };
  }

  const parsed = parseWindowsNetstatListeners(result.stdout);
  const capped = capListenerRows(parsed.rows);
  const errors = [];
  // Parse telemetry (review P1-3): raw TCP rows that produced no parsed
  // listener rows mean the row shape defeated the heuristic (e.g. an
  // unexpected locale variant) — disclose it instead of returning a
  // silently-empty inventory.
  if (parsed.rawTcpRows > 0 && parsed.tcpRowsParsed === 0) {
    errors.push(`netstat: ${parsed.rawTcpRows} TCP rows were read but none parsed as listeners (unexpected output shape or locale variant).`);
  }
  try {
    const nameByPid = await resolveWindowsProcessNames(capped.rows);
    for (const row of capped.rows) {
      row.processName = nameByPid.get(row.pid) || null;
    }
  } catch (error) {
    // Best effort: process names are optional inventory metadata.
    errors.push(`tasklist: ${String(error?.message || error).slice(0, 200)}`);
  }
  return { source: "netstat", rows: capped.rows, truncated: capped.truncated, dropped: capped.dropped, errors };
}

async function collectLinuxListeners() {
  const [tcpResult, udpResult] = await Promise.all([
    execFileImpl("ss", ["-tlnp"]),
    execFileImpl("ss", ["-ulnp"]),
  ]);

  if (!tcpResult.ok && !udpResult.ok) {
    const [netstatTcp, netstatUdp] = await Promise.all([
      execFileImpl("netstat", ["-tlnp"]),
      execFileImpl("netstat", ["-ulnp"]),
    ]);
    if (!netstatTcp.ok && !netstatUdp.ok) {
      return {
        source: null,
        rows: [],
        truncated: false,
        dropped: 0,
        errors: [
          describeListenerCommandFailure("ss", tcpResult),
          describeListenerCommandFailure("netstat", netstatTcp),
        ],
      };
    }
    const netstatRows = capListenerRows([
      ...parseLinuxNetstatListeners(netstatTcp.stdout, "tcp"),
      ...parseLinuxNetstatListeners(netstatUdp.stdout, "udp"),
    ]);
    return { source: "netstat", ...netstatRows, errors: [] };
  }

  const errors = [];
  if (!tcpResult.ok) errors.push(describeListenerCommandFailure("ss (tcp)", tcpResult));
  if (!udpResult.ok) errors.push(describeListenerCommandFailure("ss (udp)", udpResult));
  const capped = capListenerRows(dedupeListenerRows([
    ...parseSsListeners(tcpResult.stdout, "tcp"),
    ...parseSsListeners(udpResult.stdout, "udp"),
  ]));
  return { source: "ss", ...capped, errors };
}

async function collectListeners(platform = process.platform) {
  if (platform === "win32") {
    return collectWindowsListeners();
  }
  if (platform === "linux") {
    return collectLinuxListeners();
  }
  return {
    source: null,
    rows: [],
    truncated: false,
    dropped: 0,
    errors: [{ source: platform, message: "Listener enumeration is not supported on this platform." }],
  };
}

function detectPortConflicts(listeners) {
  const groups = new Map();
  for (const row of Array.isArray(listeners) ? listeners : []) {
    if (!row || typeof row.localPort !== "number") {
      continue;
    }
    const key = `${row.protocol}:${row.localPort}`;
    if (!groups.has(key)) {
      groups.set(key, { protocol: row.protocol, port: row.localPort, addresses: new Set(), processes: new Set() });
    }
    const group = groups.get(key);
    group.addresses.add(row.localAddress);
    if (row.processName) {
      group.processes.add(row.processName);
    }
  }

  const conflicts = [];
  for (const group of groups.values()) {
    if (group.addresses.size < 2 || isNormalDualStackWildcard(group.addresses)) {
      continue;
    }
    conflicts.push({
      reason: "multiple_bind_addresses",
      protocol: group.protocol,
      port: group.port,
      addresses: [...group.addresses].sort().slice(0, MAX_REPORTED_CONFLICT_ADDRESSES),
      processes: [...group.processes].sort().slice(0, MAX_REPORTED_CONFLICT_ADDRESSES),
    });
  }
  return conflicts.sort((a, b) => a.protocol.localeCompare(b.protocol) || a.port - b.port);
}

function collectNetworkInterfaces(interfaces = networkInterfacesImpl()) {
  const rows = [];
  for (const [name, addresses] of Object.entries(interfaces || {})) {
    if (!Array.isArray(addresses)) {
      continue;
    }
    for (const entry of addresses) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      rows.push({
        name,
        address: entry.address || null,
        // os.family varies by Node version (number vs "IPv4"/"IPv6").
        family: entry.family === 6 || entry.family === "IPv6" ? "IPv6" : "IPv4",
        mac: entry.mac || null,
        internal: entry.internal === true,
        cidr: entry.cidr || null,
      });
    }
  }
  return rows;
}

async function checkPort(port, options = {}) {
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    const error = new Error("Port must be an integer between 1 and 65535.");
    error.code = "INVALID_PORT";
    error.statusCode = 400;
    throw error;
  }
  const protocol = String(options.protocol || "tcp").trim().toLowerCase();
  if (protocol !== "tcp" && protocol !== "udp") {
    const error = new Error("Protocol must be tcp or udp.");
    error.code = "INVALID_PROTOCOL";
    error.statusCode = 400;
    throw error;
  }

  const listeners = await collectListeners(options.platform || process.platform);
  const entries = listeners.rows.filter((row) => row.protocol === protocol && row.localPort === portNumber);
  return {
    port: portNumber,
    protocol,
    listening: entries.length > 0,
    wildcardBound: entries.some((row) => isWildcardAddress(row.localAddress)),
    boundAddresses: [...new Set(entries.map((row) => row.localAddress))].sort().slice(0, MAX_REPORTED_CONFLICT_ADDRESSES),
    entries: entries.slice(0, 25),
    listenerSource: listeners.source,
    errors: listeners.errors,
  };
}

async function collectNetworkInventory(platform = process.platform) {
  const [interfaces, listenerResult] = await Promise.all([
    Promise.resolve(collectNetworkInterfaces()),
    collectListeners(platform),
  ]);
  const conflicts = detectPortConflicts(listenerResult.rows);
  return {
    generatedAt: new Date().toISOString(),
    hostname: os.hostname(),
    platform,
    supported: listenerResult.source !== null,
    listenerSource: listenerResult.source,
    interfaces,
    interfaceCount: interfaces.length,
    listeners: listenerResult.rows,
    listenerCount: listenerResult.rows.length,
    listenersTruncated: listenerResult.truncated,
    listenersDropped: listenerResult.dropped,
    conflicts,
    conflictCount: conflicts.length,
    errors: listenerResult.errors,
    source: "agent",
  };
}

module.exports = {
  checkPort,
  collectListeners,
  collectNetworkInterfaces,
  collectNetworkInventory,
  detectPortConflicts,
  parseLinuxNetstatListeners,
  parseSsListeners,
  parseWindowsNetstatListeners,
  _test: {
    MAX_LISTENER_ROWS,
    setExecFileForTest(fn) {
      execFileImpl = fn || execFile;
    },
    setNetworkInterfacesForTest(fn) {
      networkInterfacesImpl = fn || (() => os.networkInterfaces());
    },
    resetForTest() {
      execFileImpl = execFile;
    },
  },
};
