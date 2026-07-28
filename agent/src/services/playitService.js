const { execFile } = require("child_process");
const fs = require("fs/promises");
const net = require("net");

const { getPlayitSnapshot: getBasePlayitSnapshot } = require("../../../src/services/playitService");

const COMMAND_TIMEOUT_MS = 2200;
const CONTROL_COMMAND_TIMEOUT_MS = 15000;
const SOCKET_TIMEOUT_MS = 500;
const PLAYIT_IPC_VERSION = 2;
const MAX_METADATA_FILE_BYTES = 256 * 1024;
const MAX_LOG_BYTES = 128 * 1024;
const PLAYIT_SERVICE_CANDIDATES = ["playit", "playit-agent"];
const PLAYIT_DOMAIN_PATTERN = /\b[a-z0-9][a-z0-9.-]*\.(?:playit\.(?:gg|cloud|fan)|ply\.gg)\b/gi;
const LOCAL_TARGET_PATTERN = /\b(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}\b/i;
const PLAYIT_IPC_PERMISSION_CODES = new Set(["EACCES", "EPERM"]);
const PLAYIT_CONTROL_HOSTS = new Set(["api.playit.gg"]);
const PLAYIT_IPC_UNAVAILABLE_TUNNEL_FIELDS = {
  protocol: {
    reason: "not_exposed_by_playit_ipc_v2",
    message:
      "Official Playit IPC v2 TunnelState exposes display_address, destination, is_disabled, and disabled_reason only; tunnel protocol is not present.",
  },
  tunnelId: {
    reason: "not_exposed_by_playit_ipc_v2",
    message:
      "Official Playit IPC v2 TunnelState does not expose a per-tunnel id. PendingTunnelState has id, but active TunnelState does not.",
  },
};

function exec(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: options.timeout || COMMAND_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        errorCode: error?.code || error?.name || null,
        stdout: stdout ? stdout.trim() : "",
        stderr: stderr ? stderr.trim() : "",
      });
    });
  });
}

function parseVersion(output) {
  const match = String(output || "").match(/\b(?:version\s*)?v?(\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?)\b/i);
  return match?.[1] || null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function sanitizeCommandLine(value) {
  return String(value || "")
    .replace(/(\bAuthorization:\s*Bearer\s+)\S+/gi, "$1[redacted]")
    .replace(/(\bBearer\s+)\S+/gi, "$1[redacted]")
    .replace(/(--?(?:secret|token|password|credential|api[_-]?key)(?:=|\s+))\S+/gi, "$1[redacted]")
    .replace(/\b(?:secret|token|password|credential|api[_-]?key)\b\s*[:=]\s*\S+/gi, (match) => `${match.split(/[:=]/)[0]}=[redacted]`);
}

function formatMode(mode) {
  return `0${(mode & 0o777).toString(8)}`;
}

function getCurrentIdentity() {
  return {
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    gid: typeof process.getgid === "function" ? process.getgid() : null,
    groups: typeof process.getgroups === "function" ? unique(process.getgroups()) : [],
  };
}

function splitShellWords(value) {
  const words = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
  let match;

  while ((match = pattern.exec(String(value || ""))) !== null) {
    words.push(match[1] || match[2] || match[3]);
  }

  return words;
}

function getArgValues(words, longName, shortName = null) {
  const values = [];

  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    const longPrefix = `${longName}=`;

    if (word === longName && words[index + 1]) {
      values.push(words[index + 1]);
      index += 1;
    } else if (word.startsWith(longPrefix)) {
      values.push(word.slice(longPrefix.length));
    } else if (shortName && word === shortName && words[index + 1]) {
      values.push(words[index + 1]);
      index += 1;
    }
  }

  return values;
}

function parseRuntimePaths(commandLines) {
  const logPaths = [];
  const socketPaths = [];
  const secretPaths = [];

  for (const line of commandLines) {
    const words = splitShellWords(line);
    logPaths.push(...getArgValues(words, "--log-path"), ...getArgValues(words, "--log-file"), ...getArgValues(words, "--log", "-l"));
    socketPaths.push(...getArgValues(words, "--socket-path"), ...getArgValues(words, "--socket"));
    secretPaths.push(...getArgValues(words, "--secret-path"), ...getArgValues(words, "--config"), ...getArgValues(words, "--config-path"));
  }

  return {
    logPaths: unique(logPaths),
    socketPaths: unique(socketPaths),
    secretPaths: unique(secretPaths),
  };
}

function extractPlayitAddress(content) {
  const matches = String(content || "").match(PLAYIT_DOMAIN_PATTERN) || [];
  return matches.find((match) => !isPlayitControlEndpoint(match)) || null;
}

function splitHostPort(value) {
  const match = String(value || "").match(/^(.+):(\d{1,5})$/);

  return {
    ip: match?.[1] || null,
    port: match?.[2] || null,
  };
}

function extractLocalTarget(content) {
  const value = String(content || "");
  const directMatch = value.match(
    /\b(?:local[_ -]?(?:address|addr|target|host|ip)|target|backend|origin|proxy[_ -]?addr)\b\s*[:=]\s*["']?([^"'\s,#)]+)/i,
  );

  if (directMatch?.[1] && LOCAL_TARGET_PATTERN.test(directMatch[1])) {
    return directMatch[1];
  }

  const arrowMatch = value.match(
    /\b[a-z0-9][a-z0-9.-]*\.(?:playit\.(?:gg|cloud|fan)|ply\.gg)(?::\d{1,5})?\b[^\n]{0,120}(?:->|=>|to|forward(?:s|ing)?\s+to)[^\n]{0,80}?((?:127\.0\.0\.1|localhost|0\.0\.0\.0|\d{1,3}(?:\.\d{1,3}){3}):\d{1,5})/i,
  );

  if (arrowMatch?.[1]) {
    return arrowMatch[1];
  }

  const hostMatch = value.match(/\b(?:local[_ -]?(?:host|ip)|host|listen(?:ing)?[_ -]?ip)\b\s*[:=]\s*["']?([^"'\s,#)]+)/i);
  const portMatch = value.match(/\b(?:local[_ -]?port|listen(?:ing)?[_ -]?port|port)\b\s*[:=]\s*["']?(\d{1,5})/i);

  if (hostMatch?.[1] && portMatch?.[1]) {
    return `${hostMatch[1]}:${portMatch[1]}`;
  }

  return value.match(LOCAL_TARGET_PATTERN)?.[0] || null;
}

function extractProtocol(content) {
  const match = String(content || "").match(/\b(?:protocol|proto|port[_ -]?type|tunnel[_ -]?type)\b\s*[:=]\s*["']?(tcp|udp|http|https)\b/i);

  if (match?.[1]) {
    return match[1].toUpperCase();
  }

  const urlMatch = String(content || "").match(/\b(tcp|udp|http|https):\/\//i);
  return urlMatch?.[1]?.toUpperCase() || null;
}

function extractTunnelId(content) {
  const value = String(content || "");
  const labeledMatch = value.match(/\btunnel[_ -]?(?:id|uuid)\b\s*[:=]\s*["']?([a-z0-9][a-z0-9_-]{5,})/i);

  if (labeledMatch?.[1]) {
    return labeledMatch[1];
  }

  const compactJsonMatch = value.match(/["']tunnel[_ -]?(?:id|uuid)["']\s*:\s*["']([^"']+)["']/i);
  return compactJsonMatch?.[1] || null;
}

function normalizeProtocol(value) {
  const match = String(value || "").match(/\b(tcp|udp|http|https)\b/i);
  return match?.[1]?.toUpperCase() || null;
}

function normalizeEndpointHost(value) {
  const withoutProtocol = String(value || "")
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .split(/[/?#]/)[0]
    .replace(/^\[/, "")
    .replace(/\]$/, "");

  return withoutProtocol.replace(/:\d{1,5}$/, "").toLowerCase();
}

function isPlayitControlEndpoint(value) {
  const host = normalizeEndpointHost(value);
  return PLAYIT_CONTROL_HOSTS.has(host);
}

function stripAnsi(value) {
  return String(value || "").replace(/\u001b\[[0-9;]*m/g, "");
}

function isLocalIp(value) {
  return /^(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\d{1,3}(?:\.\d{1,3}){3})$/.test(String(value || ""));
}

function hasOwnField(value, fields) {
  return fields.some((field) => Object.prototype.hasOwnProperty.call(value, field));
}

function hasTunnelMetadataFields(value) {
  return hasOwnField(value, [
    "display_address",
    "displayAddress",
    "assigned_domain",
    "assignedDomain",
    "public_address",
    "publicAddress",
    "destination",
    "target",
    "local",
    "origin",
    "local_addr",
    "localAddr",
    "local_address",
    "localAddress",
    "local_port",
    "localPort",
    "tunnel_id",
    "tunnelId",
  ]);
}

function isPlayitIpcSource(source) {
  return /^playit IPC\b/.test(String(source?.name || ""));
}

function setMetadataValue(metadata, field, value) {
  if (!metadata[field] && value) {
    metadata[field] = String(value);
  }
}

function mergeMetadataValues(target, source) {
  for (const [field, value] of Object.entries(source || {})) {
    setMetadataValue(target, field, value);
  }

  return target;
}

function metadataFromEndpointValue(value) {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value === "string") {
    const localTarget = extractLocalTarget(value);
    const localParts = splitHostPort(localTarget);

    return {
      tunnelAddress: extractPlayitAddress(value),
      localTarget,
      localIp: localParts.ip,
      localPort: localParts.port,
      protocol: extractProtocol(value),
    };
  }

  if (typeof value !== "object") {
    return {};
  }

  const explicitLocalHost =
    value.local_addr ||
    value.localAddr ||
    value.local_address ||
    value.localAddress ||
    value.local_ip ||
    value.localIp ||
    null;
  const genericHost = value.host || value.hostname || value.ip || value.address || null;
  const host = explicitLocalHost || (isLocalIp(genericHost) ? genericHost : null);
  const port = value.port || value.local_port || value.localPort || value.port_start || value.portStart || null;
  const addressText = [
    value.display_address,
    value.displayAddress,
    value.assigned_domain,
    value.assignedDomain,
    value.public_address,
    value.publicAddress,
    value.domain,
    value.hostname,
    value.address,
  ]
    .filter(Boolean)
    .join("\n");
  const localTarget = host && port ? `${host}:${port}` : extractLocalTarget(JSON.stringify(value));
  const localParts = splitHostPort(localTarget);
  const tunnelAddress = extractPlayitAddress(addressText);
  const hasTunnelEvidence = Boolean(tunnelAddress || localTarget || value.tunnel_id || value.tunnelId || hasTunnelMetadataFields(value));

  return {
    tunnelAddress,
    localTarget,
    localIp: isLocalIp(host) ? host : localParts.ip,
    localPort: port || localParts.port,
    protocol: hasTunnelEvidence ? normalizeProtocol(value.protocol || value.proto || value.type || value.port_type || value.portType) : null,
  };
}

function parsePlayitStateObject(value, metadata = {}) {
  if (!value || typeof value !== "object") {
    return metadata;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      parsePlayitStateObject(item, metadata);
    }
    return metadata;
  }

  mergeMetadataValues(
    metadata,
    metadataFromEndpointValue(
      value.display_address ||
        value.displayAddress ||
        value.assigned_domain ||
        value.assignedDomain ||
        value.public_address ||
        value.publicAddress ||
        value.hostname,
    ),
  );
  mergeMetadataValues(metadata, metadataFromEndpointValue(value.destination || value.target || value.local || value.origin));
  mergeMetadataValues(metadata, metadataFromEndpointValue(value));

  if (value.id && !metadata.tunnelId && /tunnel/i.test(String(value.kind || value.type || value.state || ""))) {
    metadata.tunnelId = String(value.id);
  }

  if (!metadata.tunnelId && (value.tunnel_id || value.tunnelId)) {
    metadata.tunnelId = String(value.tunnel_id || value.tunnelId);
  }

  if (!metadata.protocol && hasTunnelMetadataFields(value)) {
    metadata.protocol = normalizeProtocol(value.protocol || value.proto || value.port_type || value.portType);
  }

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");

    if (key === "displayaddress" || key === "assigneddomain" || key === "publicaddress" || key === "hostname") {
      mergeMetadataValues(metadata, metadataFromEndpointValue(rawValue));
    } else if (key === "destination" || key === "target" || key === "origin") {
      mergeMetadataValues(metadata, metadataFromEndpointValue(rawValue));
    } else if (key === "tunnels" || key === "pendingtunnels") {
      parsePlayitStateObject(rawValue, metadata);
    } else if (rawValue && typeof rawValue === "object") {
      parsePlayitStateObject(rawValue, metadata);
    }
  }

  return metadata;
}

function flattenJsonMetadata(value, metadata = {}) {
  if (!value || typeof value !== "object") {
    return metadata;
  }

  parsePlayitStateObject(value, metadata);

  if (Array.isArray(value)) {
    for (const item of value) {
      flattenJsonMetadata(item, metadata);
    }
    return metadata;
  }

  const objectHasTunnelFields = hasTunnelMetadataFields(value);

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = rawKey.toLowerCase().replace(/[^a-z0-9]/g, "");

    if (rawValue && typeof rawValue === "object") {
      flattenJsonMetadata(rawValue, metadata);
      continue;
    }

    const text = rawValue === undefined || rawValue === null ? "" : String(rawValue);

    if (!metadata.tunnelAddress && /(domain|hostname|publicaddress|tunneladdress|assigneddomain|displayaddress|address)$/.test(key)) {
      metadata.tunnelAddress = extractPlayitAddress(text);
    }

    if (!metadata.localTarget && /(localtarget|localaddress|localaddr|proxyaddr|backend|origin|target|destination)$/.test(key)) {
      metadata.localTarget = extractLocalTarget(text);
    }

    if (!metadata.localIp && /(localip|localhost|listenip)$/.test(key) && isLocalIp(text)) {
      metadata.localIp = text;
    }

    if (!metadata.localPort && /(localport|listenport)$/.test(key) && /^\d{1,5}$/.test(text)) {
      metadata.localPort = text;
    }

    if (!metadata.protocol && objectHasTunnelFields && /(protocol|proto|porttype|tunneltype)$/.test(key)) {
      metadata.protocol = normalizeProtocol(text);
    }

    if (!metadata.tunnelId && /(tunnelid|tunneluuid)$/.test(key) && /^[a-z0-9][a-z0-9_-]{5,}$/i.test(text)) {
      metadata.tunnelId = text;
    }
  }

  return metadata;
}

function parseJsonMetadata(content) {
  const trimmed = String(content || "").trim();

  if (!trimmed) {
    return {};
  }

  const lineMetadata = {};
  let parsedLine = false;

  for (const frame of parseIpcFrames(trimmed)) {
    parsedLine = true;
    flattenJsonMetadata(frame, lineMetadata);
  }

  if (parsedLine) {
    return lineMetadata;
  }

  if (!/^[{[]/.test(trimmed)) {
    return {};
  }

  try {
    return flattenJsonMetadata(JSON.parse(trimmed));
  } catch {
    return {};
  }
}

function parseTunnelMetadata(content) {
  const normalizedContent = stripAnsi(content);
  const trimmedContent = normalizedContent.trim();
  const parsedJsonContent = parseIpcFrames(trimmedContent).length > 0 || /^[{[]/.test(trimmedContent);
  const jsonMetadata = parseJsonMetadata(normalizedContent);
  const localTarget = jsonMetadata.localTarget || extractLocalTarget(normalizedContent);
  const localParts = splitHostPort(localTarget);
  const tunnelAddress = jsonMetadata.tunnelAddress || extractPlayitAddress(normalizedContent);
  const tunnelId = jsonMetadata.tunnelId || extractTunnelId(normalizedContent);
  const hasTunnelEvidence = Boolean(tunnelAddress || localTarget || tunnelId);

  return {
    tunnelAddress,
    localTarget,
    localIp: jsonMetadata.localIp || localParts.ip,
    localPort: jsonMetadata.localPort || localParts.port,
    protocol: jsonMetadata.protocol || (parsedJsonContent || !hasTunnelEvidence ? null : extractProtocol(normalizedContent)),
    tunnelId,
  };
}

function parsedFieldNames(parsed) {
  return Object.entries(parsed)
    .filter(([, value]) => Boolean(value))
    .map(([key]) => key);
}

async function readMetadataFile(filePath, sourceName = filePath) {
  try {
    const handle = await fs.open(filePath, "r");

    try {
      const stat = await handle.stat();
      const length = Math.min(stat.size, MAX_METADATA_FILE_BYTES);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, Math.max(0, stat.size - length));

      return {
        name: sourceName,
        content: buffer.toString("utf8"),
        diagnostics: {
          source: filePath,
          checked: true,
          ok: true,
          errorCode: null,
          hasOutput: length > 0,
          truncated: stat.size > MAX_METADATA_FILE_BYTES,
        },
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    return {
      name: sourceName,
      content: "",
      diagnostics: {
        source: filePath,
        checked: true,
        ok: false,
        errorCode: error?.code || null,
        hasOutput: false,
        reason: error?.code === "EACCES" ? "unreadable" : "not_available",
      },
    };
  }
}

async function getProcessCommandLines() {
  if (process.platform === "win32") {
    return {
      lines: [],
      diagnostics: {
        command: "pgrep -af playit",
        checked: false,
        ok: false,
        errorCode: null,
        hasOutput: false,
        reason: "not_linux",
      },
    };
  }

  const result = await exec("pgrep", ["-af", "playit"]);
  const lines = (result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => {
      const command = line.replace(/^\d+\s+/, "").trim();
      const executable = command.split(/\s+/)[0] || "";
      return /(?:^|[/\\])playitd?(?:\.exe)?$/i.test(executable);
    });

  return {
    lines,
    diagnostics: {
      command: "pgrep -af playit",
      checked: true,
      ok: result.ok,
      errorCode: result.errorCode,
      hasOutput: lines.length > 0,
      commandLines: lines.map(sanitizeCommandLine),
    },
  };
}

function extractCommandLinesFromSystemctlStatus(output) {
  return String(output || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /(?:^|\s|[/\\])playitd?(?:\s|$)/i.test(line))
    .map((line) => line.replace(/^[├└─\s]*/, "").trim());
}

function extractCommandLinesFromSystemctlShow(output) {
  const lines = [];
  const execStart = String(output || "").match(/^ExecStart=\{[^}]*\bpath=([^ ;]+)[^}]*\bargv\[\]=([^;]+);/m);

  if (execStart?.[1]) {
    lines.push(execStart[2] ? execStart[2].trim() : execStart[1].trim());
  }

  return lines;
}

function extractCommandLinesFromUnitFile(content) {
  return String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^ExecStart=/i.test(line))
    .map((line) => line.replace(/^ExecStart=/i, "").trim())
    .filter((line) => /(?:^|[/\\])playitd?(?:\s|$)/i.test(line));
}

async function readSystemdUnitCommandLines() {
  const candidates = [
    "/etc/systemd/system/playit.service",
    "/usr/lib/systemd/system/playit.service",
    "/lib/systemd/system/playit.service",
  ];
  const diagnostics = [];
  const lines = [];

  for (const filePath of candidates) {
    try {
      const content = await fs.readFile(filePath, "utf8");
      const parsed = extractCommandLinesFromUnitFile(content);
      lines.push(...parsed);
      diagnostics.push({ path: filePath, ok: true, errorCode: null, hasOutput: parsed.length > 0 });
    } catch (error) {
      diagnostics.push({ path: filePath, ok: false, errorCode: error?.code || null, hasOutput: false });
    }
  }

  return {
    lines: unique(lines),
    diagnostics,
  };
}

async function getSystemdCommandLines() {
  if (process.platform === "win32") {
    return {
      lines: [],
      diagnostics: {
        checked: false,
        ok: false,
        errorCode: null,
        hasOutput: false,
        reason: "not_linux",
      },
    };
  }

  const [status, show, unit] = await Promise.all([
    exec("systemctl", ["status", "playit", "--no-pager"]),
    exec("systemctl", ["show", "playit", "--property=ExecStart", "--no-pager"]),
    readSystemdUnitCommandLines(),
  ]);
  const statusContent = [status.stdout, status.stderr].filter(Boolean).join("\n");
  const showContent = [show.stdout, show.stderr].filter(Boolean).join("\n");
  const lines = unique([
    ...extractCommandLinesFromSystemctlStatus(statusContent),
    ...extractCommandLinesFromSystemctlShow(showContent),
    ...unit.lines,
  ]);

  return {
    lines,
    diagnostics: {
      checked: true,
      ok: status.ok || show.ok,
      errorCode: status.ok || show.ok ? null : status.errorCode || show.errorCode,
      hasOutput: lines.length > 0,
      commandLines: lines.map(sanitizeCommandLine),
      checks: [
        { command: "systemctl status playit --no-pager", ok: status.ok, errorCode: status.errorCode, hasOutput: Boolean(statusContent) },
        { command: "systemctl show playit --property=ExecStart --no-pager", ok: show.ok, errorCode: show.errorCode, hasOutput: Boolean(showContent) },
      ],
      unitFiles: unit.diagnostics,
    },
  };
}

async function readJournal() {
  if (process.platform === "win32") {
    return {
      name: "journalctl -u playit --no-pager -n 250",
      content: "",
      diagnostics: {
        checked: false,
        ok: false,
        errorCode: null,
        hasOutput: false,
        reason: "not_linux",
      },
    };
  }

  const result = await exec("journalctl", ["-u", "playit", "--no-pager", "-n", "250"]);
  const content = [result.stdout, result.stderr].filter(Boolean).join("\n");

  return {
    name: "journalctl -u playit --no-pager -n 250",
    content,
    diagnostics: {
      checked: true,
      ok: result.ok,
      errorCode: result.errorCode,
      hasOutput: Boolean(content),
      reason: content.includes("-- No entries --") ? "no_visible_entries" : null,
    },
  };
}

function parseIpcFrames(content) {
  return String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function parseIpcFrameLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

async function queryPlayitIpc(socketPath, requests, label) {
  return new Promise((resolve) => {
    let output = "";
    let buffer = "";
    let requestFramesSent = false;
    let responseCount = 0;
    let hello = null;
    let settled = false;
    const socket = net.createConnection({ path: socketPath });
    const finish = (result) => {
      if (settled) {
        return;
      }

      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    const sendRequests = () => {
      if (requestFramesSent) {
        return;
      }

      requestFramesSent = true;

      for (const request of requests) {
        socket.write(`${JSON.stringify(request)}\n`);
      }
    };
    const processLine = (line) => {
      const frame = parseIpcFrameLine(line);

      if (!frame) {
        return;
      }

      if (frame.message_kind === "hello") {
        hello = frame.data?.protocol || null;
        if (hello?.ipc_version && hello.ipc_version !== PLAYIT_IPC_VERSION) {
          finish({ ok: false, errorCode: "EPROTO", output, label, hello });
          return;
        }

        sendRequests();
        return;
      }

      if (frame.message_kind === "response") {
        responseCount += 1;

        if (responseCount >= requests.length) {
          finish({ ok: true, errorCode: null, output, label, hello });
        }
      }
    };

    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      output += text;
      buffer += text;

      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines.map((value) => value.trim()).filter(Boolean)) {
        processLine(line);
      }
    });
    socket.on("end", () => finish({ ok: true, errorCode: null, output, label }));
    socket.on("timeout", () => finish({ ok: false, errorCode: "ETIMEDOUT", output }));
    socket.on("error", (error) => finish({ ok: false, errorCode: error?.code || error?.name || null, output }));
  });
}

async function queryRuntimeSockets(socketPaths) {
  const sources = [];
  const requestSets = [
    [
      "playit IPC get_status/get_state",
      [
        { ipc_version: PLAYIT_IPC_VERSION, request_id: 1, request: { type: "get_status" } },
        { ipc_version: PLAYIT_IPC_VERSION, request_id: 2, request: { type: "get_state" } },
      ],
    ],
    [
      "playit IPC subscribe",
      [
        { ipc_version: PLAYIT_IPC_VERSION, request_id: 1, request: { type: "subscribe" } },
      ],
    ],
  ];

  for (const socketPath of socketPaths) {
    for (const [label, requests] of requestSets) {
      const result = await queryPlayitIpc(socketPath, requests, label);
      const parsedFrames = parseIpcFrames(result.output);
      const permissionDenied = PLAYIT_IPC_PERMISSION_CODES.has(result.errorCode);

      sources.push({
        name: label,
        content: result.output,
        diagnostics: {
          source: socketPath,
          protocol: "playit-ipc-json-lines",
          checked: true,
          ok: result.ok,
          errorCode: result.errorCode,
          hasOutput: Boolean(result.output),
          frameCount: parsedFrames.length,
          requestCount: requests.length,
          serverProtocol: result.hello,
          reason: permissionDenied ? "permission_denied" : null,
        },
      });
    }
  }

  return sources;
}

async function inspectIpcSocketAccess(socketPaths, socketSources) {
  const permissionSource = socketSources.find((source) => PLAYIT_IPC_PERMISSION_CODES.has(source.diagnostics?.errorCode));
  const socketPath = permissionSource?.diagnostics?.source || socketPaths[0] || null;

  if (!socketPath) {
    return {
      checked: false,
      ok: false,
      errorCode: null,
      reason: "socket_path_not_found",
      message: "Playit metadata requires access to the playit daemon IPC socket, but no socket path was discovered.",
    };
  }

  let stat = null;
  let statError = null;

  try {
    stat = await fs.stat(socketPath);
  } catch (error) {
    statError = error;
  }

  const permissionDenied = Boolean(permissionSource);

  return {
    checked: true,
    ok: !permissionDenied,
    socketPath,
    errorCode: permissionSource?.diagnostics?.errorCode || statError?.code || null,
    reason: permissionDenied ? "permission_denied" : statError ? "stat_failed" : null,
    socket: stat
      ? {
          mode: formatMode(stat.mode),
          uid: stat.uid,
          gid: stat.gid,
          type: stat.isSocket() ? "socket" : stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
        }
      : null,
    agentIdentity: getCurrentIdentity(),
    requiredAccess: "The AnxOS Agent process needs read/write permission on the Playit daemon IPC socket and search permission on its parent runtime directory.",
    remediation:
      "Grant the agent user access through a dedicated group, ACL, or Playit systemd override that sets the socket/runtime directory group. Do not chmod the socket to 777 and do not run the whole agent as root.",
    message: permissionDenied
      ? `Playit tunnel metadata requires access to ${socketPath}; the current agent process cannot connect to the daemon IPC socket.`
      : null,
  };
}

async function runExtraCliInspection(binaryPath) {
  if (!binaryPath) {
    return [];
  }

  const attempts = [
    ["playit status --json", ["status", "--json"]],
    ["playit tunnels --json", ["tunnels", "--json"]],
    ["playit status", ["status"]],
    ["playit tunnels", ["tunnels"]],
  ];
  const sources = [];

  for (const [label, args] of attempts) {
    const result = await exec(binaryPath, args);
    const content = [result.stdout, result.stderr].filter(Boolean).join("\n");
    sources.push({
      name: label,
      content,
      diagnostics: {
        command: label,
        checked: true,
        ok: result.ok,
        errorCode: result.errorCode,
        hasOutput: Boolean(content),
      },
    });
  }

  return sources;
}

function mergeMetadata(sources) {
  const metadata = {
    tunnelAddress: null,
    localTarget: null,
    localIp: null,
    localPort: null,
    protocol: null,
    tunnelId: null,
  };
  const fieldSources = {};
  const unavailableFields = {};
  const diagnostics = [];

  for (const source of sources) {
    const parsed = parseTunnelMetadata(source.content || "");
    const fields = parsedFieldNames(parsed);
    const isIpcSource = isPlayitIpcSource(source);

    for (const field of Object.keys(metadata)) {
      if (!metadata[field] && parsed[field]) {
        metadata[field] = parsed[field];
        fieldSources[field] = source.name;
      }
    }

    if (isIpcSource && (parsed.tunnelAddress || parsed.localTarget)) {
      for (const [field, details] of Object.entries(PLAYIT_IPC_UNAVAILABLE_TUNNEL_FIELDS)) {
        if (!parsed[field]) {
          unavailableFields[field] = {
            ...details,
            source: source.name,
          };
        }
      }
    }

    diagnostics.push({
      source: source.name,
      checked: source.diagnostics?.checked !== false,
      ok: source.diagnostics?.ok ?? true,
      errorCode: source.diagnostics?.errorCode || null,
      hasOutput: Boolean(source.content),
      parsedFields: fields,
      reason: fields.length > 0 ? null : source.diagnostics?.reason || (source.content ? "metadata_not_found" : "no_output"),
      requestPath: source.diagnostics?.requestPath,
      frameCount: source.diagnostics?.frameCount,
      requestCount: source.diagnostics?.requestCount,
      serverProtocol: source.diagnostics?.serverProtocol,
    });
  }

  if (metadata.localTarget && (!metadata.localIp || !metadata.localPort)) {
    const localParts = splitHostPort(metadata.localTarget);
    metadata.localIp = metadata.localIp || localParts.ip;
    metadata.localPort = metadata.localPort || localParts.port;
  }

  for (const field of Object.keys(unavailableFields)) {
    if (metadata[field]) {
      delete unavailableFields[field];
    }
  }

  return {
    ...metadata,
    fieldSources,
    unavailableFields,
    diagnostics,
  };
}

async function collectDaemonMetadata(baseSnapshot) {
  const [processInfo, systemdInfo] = await Promise.all([
    getProcessCommandLines(),
    getSystemdCommandLines(),
  ]);
  const commandLines = unique([...processInfo.lines, ...systemdInfo.lines]);
  const runtimePaths = parseRuntimePaths(commandLines);
  const logPaths = unique([
    ...runtimePaths.logPaths,
    process.env.PLAYIT_LOG_PATH,
    process.platform === "win32" ? null : "/var/log/playit/playit.log",
  ]);
  const configPaths = unique([
    ...runtimePaths.secretPaths,
    process.env.PLAYIT_CONFIG_PATH,
    process.platform === "win32" ? null : "/etc/playit/playit.toml",
  ]);
  const [logSources, configSources, journal, cliSources, socketSources] = await Promise.all([
    Promise.all(logPaths.map((filePath) => readMetadataFile(filePath, filePath))),
    Promise.all(configPaths.map((filePath) => readMetadataFile(filePath, filePath))),
    readJournal(),
    runExtraCliInspection(baseSnapshot.diagnostics?.binaryPath),
    queryRuntimeSockets(runtimePaths.socketPaths),
  ]);
  const ipcAccess = await inspectIpcSocketAccess(runtimePaths.socketPaths, socketSources);
  const sources = [
    ...cliSources,
    ...logSources,
    ...configSources,
    journal,
    ...socketSources,
    {
      name: "process command line",
      content: commandLines.join("\n"),
      diagnostics: processInfo.diagnostics,
    },
  ];

  return {
    metadata: mergeMetadata(sources),
    diagnostics: {
      processCommandLines: processInfo.diagnostics,
      systemdCommandLines: systemdInfo.diagnostics,
      ipcAccess,
      runtimePaths,
      sources,
    },
  };
}

function pickValue(currentValue, discoveredValue) {
  return currentValue || discoveredValue || null;
}

function pickTunnelValue(currentValue, discoveredValue, currentTunnelAddress) {
  return isPlayitControlEndpoint(currentTunnelAddress || currentValue) ? discoveredValue || null : pickValue(currentValue, discoveredValue);
}

function createPlayitError(code, message, details = {}) {
  return Object.assign(new Error(message), { code, statusCode: details.statusCode || 400, ...details });
}

async function getPlayitSnapshot() {
  const baseSnapshot = await getBasePlayitSnapshot();

  if (!baseSnapshot.installed && !baseSnapshot.running) {
    return baseSnapshot;
  }

  const daemon = await collectDaemonMetadata(baseSnapshot);
  const metadata = daemon.metadata;
  const baseTunnelAddress = baseSnapshot.tunnelAddress || baseSnapshot.tunnelDomain;
  const tunnelAddress = pickTunnelValue(baseSnapshot.tunnelAddress, metadata.tunnelAddress, baseTunnelAddress);
  const localTarget = pickTunnelValue(baseSnapshot.localTarget, metadata.localTarget, baseTunnelAddress);
  const targetParts = splitHostPort(localTarget);
  const localParts = {
    ip: pickTunnelValue(baseSnapshot.localIp, pickValue(metadata.localIp, targetParts.ip), baseTunnelAddress),
    port: pickTunnelValue(baseSnapshot.localPort, pickValue(metadata.localPort, targetParts.port), baseTunnelAddress),
  };
  const protocol = metadata.protocol || (isPlayitControlEndpoint(baseTunnelAddress) ? null : baseSnapshot.protocol);
  const fieldSources = {
    ...(baseSnapshot.diagnostics?.tunnelMetadataFieldSources || {}),
    ...metadata.fieldSources,
  };
  const metadataFound = Object.values(metadata.fieldSources).some(Boolean);
  const ipcPermissionDenied = daemon.diagnostics.ipcAccess?.reason === "permission_denied";

  return {
    ...baseSnapshot,
    tunnelAddress,
    tunnelDomain: pickTunnelValue(baseSnapshot.tunnelDomain, tunnelAddress ? tunnelAddress.split(":")[0] : null, baseTunnelAddress),
    localTarget,
    localIp: localParts.ip,
    localPort: localParts.port,
    protocol,
    tunnelId: pickValue(baseSnapshot.tunnelId, metadata.tunnelId),
    diagnostics: {
      ...baseSnapshot.diagnostics,
      tunnelMetadataSources: [
        ...(baseSnapshot.diagnostics?.tunnelMetadataSources || []),
        ...metadata.diagnostics,
      ],
      tunnelMetadataFieldSources: fieldSources,
      tunnelMetadataUnavailableFields: metadata.unavailableFields,
      daemonRuntimePaths: daemon.diagnostics.runtimePaths,
      daemonMetadataCollection: {
        checked: true,
        ok: metadataFound,
        errorCode: ipcPermissionDenied ? daemon.diagnostics.ipcAccess.errorCode : null,
        reason: metadataFound ? null : ipcPermissionDenied ? "playit_ipc_permission_denied" : "metadata_not_found",
        message: metadataFound ? null : ipcPermissionDenied ? daemon.diagnostics.ipcAccess.message : null,
      },
      daemonProcessCommandLines: daemon.diagnostics.processCommandLines,
      daemonSystemdCommandLines: daemon.diagnostics.systemdCommandLines,
      playitIpcAccess: daemon.diagnostics.ipcAccess,
    },
  };
}

async function getPlayitVersion(binaryPath) {
  if (!binaryPath) {
    return {
      version: null,
      diagnostics: {
        command: "playit --version",
        ok: false,
        errorCode: "PLAYIT_BINARY_MISSING",
        hasOutput: false,
      },
    };
  }

  const result = await exec(binaryPath, ["--version"]);
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n");

  return {
    version: result.ok ? parseVersion(output) : null,
    diagnostics: {
      command: "playit --version",
      ok: result.ok,
      errorCode: result.errorCode,
      hasOutput: Boolean(output),
    },
  };
}

async function getPlayitStatus() {
  const snapshot = await getPlayitSnapshot();
  const version = await getPlayitVersion(snapshot.diagnostics?.binaryPath);
  const service = await getPlayitServiceStatusFromSnapshot(snapshot);

  return {
    ...snapshot,
    version: version.version,
    service,
    serviceState: service.state,
    lastCheckedAt: service.lastCheckedAt,
    diagnostics: {
      ...snapshot.diagnostics,
      version: version.diagnostics,
      service: service.diagnostics,
    },
  };
}

function normalizeServiceState(value, runningFallback = false) {
  const text = String(value || "").trim().toLowerCase();
  if (/^(active|running)$/.test(text)) return "running";
  if (/^(failed|error)$/.test(text)) return "failed";
  if (/^(inactive|stopped|dead)$/.test(text)) return "stopped";
  if (/not[-_\s]?found|could not be found|no such/i.test(text)) return "service-not-found";
  return runningFallback ? "running" : "unknown";
}

async function inspectSystemdService(name, user = false) {
  if (process.platform === "win32") {
    return null;
  }
  const prefix = user ? ["--user"] : [];
  const [active, enabled] = await Promise.all([
    exec("systemctl", [...prefix, "is-active", name], { timeout: CONTROL_COMMAND_TIMEOUT_MS }),
    exec("systemctl", [...prefix, "is-enabled", name], { timeout: CONTROL_COMMAND_TIMEOUT_MS }),
  ]);
  const rawState = active.stdout || active.stderr || "";
  const state = normalizeServiceState(rawState);
  const found = active.ok || enabled.ok || !/not-found|not loaded|could not be found|no such/i.test(`${active.stdout}\n${active.stderr}\n${enabled.stdout}\n${enabled.stderr}`);
  return {
    manager: user ? "systemd-user" : "systemd",
    name,
    found,
    state: found ? state : "service-not-found",
    enabled: enabled.ok ? enabled.stdout.split(/\r?\n/)[0] || "enabled" : null,
    diagnostics: {
      active: { ok: active.ok, errorCode: active.errorCode, output: sanitizeCommandLine(rawState) },
      enabled: { ok: enabled.ok, errorCode: enabled.errorCode, output: sanitizeCommandLine(enabled.stdout || enabled.stderr) },
    },
  };
}

async function inspectWindowsService(name) {
  if (process.platform !== "win32") {
    return null;
  }
  const script = `Get-Service -Name ${JSON.stringify(name)} -ErrorAction SilentlyContinue | Select-Object -First 1 Name,Status | ConvertTo-Json -Compress`;
  const result = await exec("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { timeout: CONTROL_COMMAND_TIMEOUT_MS });
  let parsed = null;
  try { parsed = result.stdout ? JSON.parse(result.stdout) : null; } catch {}
  return {
    manager: "windows-service",
    name,
    found: Boolean(parsed?.Name),
    state: parsed?.Status ? normalizeServiceState(parsed.Status) : "service-not-found",
    enabled: null,
    diagnostics: {
      query: { ok: result.ok, errorCode: result.errorCode, hasOutput: Boolean(result.stdout), stderr: sanitizeCommandLine(result.stderr) },
    },
  };
}

async function detectPlayitService() {
  const checks = [];
  if (process.platform === "win32") {
    for (const name of PLAYIT_SERVICE_CANDIDATES) {
      const check = await inspectWindowsService(name);
      checks.push(check);
      if (check?.found) return { selected: check, checks };
    }
    return { selected: null, checks };
  }
  for (const user of [false, true]) {
    for (const name of PLAYIT_SERVICE_CANDIDATES) {
      const check = await inspectSystemdService(name, user);
      checks.push(check);
      if (check?.found) return { selected: check, checks };
    }
  }
  return { selected: null, checks };
}

async function getPlayitServiceStatusFromSnapshot(snapshot = null) {
  const checkedAt = new Date().toISOString();
  const current = snapshot || await getPlayitSnapshot();
  const detected = await detectPlayitService();
  const selected = detected.selected;
  const installed = Boolean(current.installed);
  const fallbackState = current.running ? "running" : installed ? "stopped" : "missing";
  const state = selected?.found ? normalizeServiceState(selected.state, current.running) : fallbackState;
  return {
    installed,
    running: state === "running" || current.running === true,
    state,
    serviceName: selected?.name || null,
    manager: selected?.manager || null,
    lastCheckedAt: checkedAt,
    message: !installed
      ? "Playit is not installed on this node."
      : selected?.found
        ? `Playit service is ${state}.`
        : current.running
          ? "Playit process is running; no managed service was found."
          : "Playit is installed, but no managed service was found.",
    diagnostics: {
      checks: detected.checks,
      fallbackProcessRunning: current.running === true,
    },
  };
}

async function runServiceControl(action) {
  if (!["start", "stop", "restart"].includes(action)) {
    throw createPlayitError("PLAYIT_ACTION_UNSUPPORTED", "Unsupported Playit action.", { statusCode: 400 });
  }
  const snapshot = await getPlayitSnapshot();
  if (!snapshot.installed) {
    throw createPlayitError("PLAYIT_NOT_INSTALLED", "Playit is not installed on this node.", { statusCode: 404 });
  }
  const detected = await detectPlayitService();
  const selected = detected.selected;
  if (!selected?.found) {
    throw createPlayitError("PLAYIT_SERVICE_NOT_FOUND", "No managed Playit service was found for this node.", {
      statusCode: 404,
      diagnostics: { checks: detected.checks },
    });
  }
  let result;
  if (selected.manager === "windows-service") {
    const verb = action === "start" ? "Start-Service" : action === "stop" ? "Stop-Service" : "Restart-Service";
    result = await exec("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `${verb} -Name ${JSON.stringify(selected.name)} -ErrorAction Stop`,
    ], { timeout: CONTROL_COMMAND_TIMEOUT_MS });
  } else {
    const prefix = selected.manager === "systemd-user" ? ["--user"] : [];
    result = await exec("systemctl", [...prefix, action, selected.name], { timeout: CONTROL_COMMAND_TIMEOUT_MS });
  }
  if (!result.ok) {
    const code = action === "start" ? "PLAYIT_START_FAILED" : action === "stop" ? "PLAYIT_STOP_FAILED" : "PLAYIT_RESTART_FAILED";
    throw createPlayitError(code, `Playit ${action} failed.`, {
      statusCode: 500,
      diagnostics: { service: selected, errorCode: result.errorCode, stderr: sanitizeCommandLine(result.stderr), stdout: sanitizeCommandLine(result.stdout) },
    });
  }
  return {
    ok: true,
    action,
    service: selected,
    status: await getPlayitStatus(),
  };
}

async function startPlayit() {
  return runServiceControl("start");
}

async function stopPlayit() {
  return runServiceControl("stop");
}

async function restartPlayit() {
  return runServiceControl("restart");
}

async function readTail(content, maxBytes = MAX_LOG_BYTES) {
  const text = String(content || "");
  return text.length > maxBytes ? text.slice(-maxBytes) : text;
}

async function getPlayitLogs(options = {}) {
  const snapshot = await getPlayitSnapshot();
  const logPaths = unique([
    ...(snapshot.diagnostics?.daemonRuntimePaths?.logPaths || []),
    process.env.PLAYIT_LOG_PATH,
    process.platform === "win32" ? null : "/var/log/playit/playit.log",
  ]);
  const sources = await Promise.all(logPaths.map((filePath) => readMetadataFile(filePath, filePath)));
  const journal = await readJournal();
  const content = await readTail([...sources, journal].map((source) => source.content).filter(Boolean).join("\n"));
  if (!content) {
    return {
      ok: false,
      code: "PLAYIT_LOGS_UNAVAILABLE",
      message: "Playit logs are unavailable for this install.",
      lines: [],
      diagnostics: { sources: [...sources, journal].map((source) => source.diagnostics) },
    };
  }
  const limit = Number.parseInt(options.limit, 10);
  const maxLines = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 400) : 200;
  return {
    ok: true,
    lines: content.split(/\r?\n/).filter(Boolean).slice(-maxLines).map(sanitizeCommandLine),
    lastCheckedAt: new Date().toISOString(),
  };
}

function publicEndpointParts(value) {
  const text = String(value || "").trim();
  const hostPort = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0];
  const parts = splitHostPort(hostPort);
  return {
    publicHost: parts.ip || (hostPort || null),
    publicPort: parts.port,
  };
}

function normalizeTunnel(raw = {}, source = "playit", index = 0) {
  const metadata = parsePlayitStateObject(raw, {});
  const publicAddress = raw.display_address || raw.displayAddress || raw.assigned_domain || raw.assignedDomain || raw.public_address || raw.publicAddress || metadata.tunnelAddress || null;
  const publicParts = publicEndpointParts(publicAddress);
  const localTarget = raw.destination || raw.target || raw.local || raw.origin || metadata.localTarget || null;
  const localParts = splitHostPort(localTarget);
  const localHost = raw.localHost || raw.localIp || metadata.localIp || localParts.ip || null;
  const localPort = raw.localPort || raw.local_port || metadata.localPort || localParts.port || null;
  const protocol = normalizeProtocol(raw.protocol || raw.proto || raw.port_type || raw.portType || metadata.protocol) || null;
  const id = String(raw.tunnel_id || raw.tunnelId || raw.id || metadata.tunnelId || `${source}-${publicAddress || localTarget || index}`).replace(/\s+/g, "-");
  const disabled = raw.is_disabled === true || raw.disabled === true;
  return {
    id,
    name: raw.name || raw.tunnel_name || raw.tunnelName || publicAddress || id,
    status: disabled ? "offline" : publicAddress || localPort ? "online" : "unknown",
    type: raw.tunnel_type || raw.tunnelType || raw.type || (/minecraft/i.test(String(raw.name || "")) ? "Minecraft" : protocol || "custom"),
    protocol,
    localHost,
    localPort: localPort ? Number(localPort) : null,
    publicHost: publicParts.publicHost,
    publicPort: publicParts.publicPort ? Number(publicParts.publicPort) : null,
    publicAddress,
    source,
    matchedInstanceId: null,
    matchedInstanceName: null,
    updatedAt: raw.updated_at || raw.updatedAt || raw.last_updated || null,
  };
}

function collectTunnelObjects(value, output = [], seen = new Set()) {
  if (!value || typeof value !== "object") return output;
  if (Array.isArray(value)) {
    value.forEach((item) => collectTunnelObjects(item, output, seen));
    return output;
  }
  if (hasTunnelMetadataFields(value)) {
    const key = JSON.stringify(value).slice(0, 500);
    if (!seen.has(key)) {
      seen.add(key);
      output.push(value);
    }
    return output;
  }
  for (const rawValue of Object.values(value)) {
    if (rawValue && typeof rawValue === "object") collectTunnelObjects(rawValue, output, seen);
  }
  return output;
}

function parseTunnelObjectsFromContent(content) {
  const objects = [];
  const frames = parseIpcFrames(content);
  for (const frame of frames) {
    objects.push(...collectTunnelObjects(frame));
  }
  const trimmed = String(content || "").trim();
  if (frames.length === 0 && /^[{[]/.test(trimmed)) {
    try {
      objects.push(...collectTunnelObjects(JSON.parse(trimmed)));
    } catch {}
  }
  if (objects.length === 0) {
    const parsed = parseTunnelMetadata(content);
    if (parsed.tunnelAddress || parsed.localTarget || parsed.tunnelId) {
      objects.push({
        display_address: parsed.tunnelAddress,
        destination: parsed.localTarget,
        tunnel_id: parsed.tunnelId,
        protocol: parsed.protocol,
      });
    }
  }
  return objects;
}

function dedupeTunnels(tunnels = []) {
  const seen = new Set();
  return tunnels.filter((tunnel) => {
    const key = `${tunnel.id}|${tunnel.publicAddress}|${tunnel.localHost}:${tunnel.localPort}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function listPlayitTunnels() {
  const snapshot = await getPlayitStatus();
  if (!snapshot.installed) {
    return { ok: false, code: "PLAYIT_NOT_INSTALLED", message: "Playit is not installed on this node.", tunnels: [], lastCheckedAt: snapshot.lastCheckedAt };
  }
  if (!snapshot.running && snapshot.serviceState !== "running") {
    return { ok: false, code: "PLAYIT_NOT_RUNNING", message: "Start Playit to refresh tunnel status.", tunnels: [], lastCheckedAt: snapshot.lastCheckedAt };
  }
  const sources = snapshot.diagnostics?.tunnelMetadataSources || [];
  const tunnels = [];
  sources.forEach((source, sourceIndex) => {
    parseTunnelObjectsFromContent(source.content || "").forEach((raw, index) => {
      tunnels.push(normalizeTunnel(raw, source.name || `source-${sourceIndex}`, index));
    });
  });
  if (snapshot.tunnelAddress || snapshot.localPort || snapshot.tunnelId) {
    tunnels.push(normalizeTunnel({
      display_address: snapshot.tunnelAddress || snapshot.tunnelDomain,
      destination: snapshot.localTarget || (snapshot.localPort ? `${snapshot.localIp || "127.0.0.1"}:${snapshot.localPort}` : null),
      tunnel_id: snapshot.tunnelId,
      protocol: snapshot.protocol,
    }, "snapshot", 0));
  }
  return {
    ok: true,
    tunnels: dedupeTunnels(tunnels),
    lastCheckedAt: new Date().toISOString(),
    message: tunnels.length ? "Playit tunnels refreshed." : "No Playit tunnels found.",
  };
}

module.exports = {
  getPlayitSnapshot,
  getPlayitStatus,
  getPlayitServiceStatus: getPlayitStatus,
  getPlayitLogs,
  listPlayitTunnels,
  restartPlayit,
  startPlayit,
  stopPlayit,
  _test: {
    collectTunnelObjects,
    normalizeTunnel,
    parseTunnelObjectsFromContent,
  },
};
