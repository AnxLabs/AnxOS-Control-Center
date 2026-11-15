"use strict";

// Who is online on a game server, from the game's own status interface
// (Phase 8). One adapter per game family:
//   minecraft : Server List Ping (online, max, a sample of names). Vanilla
//               Minecraft does not report each player's ping.
//   fivem     : the FXServer's loopback /players.json and /dynamic.json.
//               Each player's ping is reported by the server.
//   palworld  : the server's REST API (/v1/api/players, /v1/api/metrics) on
//               127.0.0.1, only when the owner enabled it in
//               PalWorldSettings.ini. Each player's ping is reported.
//   valheim, rust, cs2 : the Steam A2S query (A2S_INFO, A2S_PLAYER): names,
//               score and connected time. A2S has no ping.
// Rules:
//   * Never invent a value. Ping is shown only where the game reports it per
//     player; otherwise the result says it is not supported.
//   * Names are shown, never stored on disk or logged. Identifiers, IP
//     addresses and account ids from the game are dropped here. A
//     service-managed server keeps its stricter rule: counts and pings only.
//   * Gentle on the server: one query per server every few seconds at most,
//     loopback only, small timeouts, bounded responses.
//   * Join and leave events are what AnxOS saw between two reads, kept in
//     memory only (bounded), and only when the full list of names is known.

const dgram = require("dgram");
const http = require("http");

const CACHE_MS = 5000;
const HTTP_TIMEOUT_MS = 2500;
const UDP_TIMEOUT_MS = 1200;
const MAX_HTTP_BYTES = 512 * 1024;
const MAX_PLAYERS = 256;
const MAX_EVENTS = 40;
const HIGH_PING_MS = 150;

const PALWORLD_SETTINGS_PATHS = [
  "Pal/Saved/Config/LinuxServer/PalWorldSettings.ini",
  "Pal/Saved/Config/WindowsServer/PalWorldSettings.ini",
];

const SOURCE_LABELS = Object.freeze({
  "minecraft-status": "Minecraft status ping",
  "fivem-players": "FiveM server player list",
  "palworld-rest": "Palworld REST API",
  "steam-a2s": "Steam server query (A2S)",
});

function familyOf(config = {}) {
  const text = [config.game, config.templateId, config.type, config.displayName, config.id, config.serverSoftware, ...(Array.isArray(config.tags) ? config.tags : [])].join(" ").toLowerCase();
  if (text.includes("hytale")) return "hytale";
  if (text.includes("palworld")) return "palworld";
  if (text.includes("fivem") || text.includes("fxserver")) return "fivem";
  if (text.includes("valheim")) return "valheim";
  if (text.includes("counter-strike") || /\bcs2\b/.test(text)) return "cs2";
  if (/\brust\b/.test(text)) return "rust";
  if (text.includes("terraria") || text.includes("tshock")) return "terraria";
  if (/minecraft|paper|purpur|spigot|bukkit|fabric|quilt|forge|neoforge|vanilla|velocity|waterfall|bungeecord/.test(text)) return "minecraft";
  return null;
}

function portsOf(config = {}) {
  return [config.primaryPort, ...(Array.isArray(config.ports) ? config.ports : [])]
    .map((value) => Number.parseInt(typeof value === "object" && value ? value.port : value, 10))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

function wholeOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function cleanName(value) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return text ? text.slice(0, 64) : null;
}

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

function httpGetJson({ port, pathname, headers = {}, timeoutMs = HTTP_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: "127.0.0.1", port, path: pathname, headers, timeout: timeoutMs, agent: false }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(Object.assign(new Error(`HTTP ${response.statusCode}`), { code: response.statusCode === 401 ? "UNAUTHORIZED" : `HTTP_${response.statusCode}` }));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_HTTP_BYTES) {
          request.destroy(Object.assign(new Error("Response too large"), { code: "TOO_LARGE" }));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          reject(Object.assign(new Error("Invalid JSON"), { code: "INVALID_JSON" }));
        }
      });
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("Timed out"), { code: "TIMEOUT" })));
    request.on("error", reject);
  });
}

// One UDP request/response exchange on loopback.
function udpExchange(port, payload, timeoutMs = UDP_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      socket.close();
      reject(Object.assign(new Error("No reply"), { code: "TIMEOUT" }));
    }, timeoutMs);
    socket.once("message", (message) => {
      clearTimeout(timer);
      socket.close();
      resolve(message);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.close();
      reject(error);
    });
    socket.send(payload, port, "127.0.0.1");
  });
}

// ---------------------------------------------------------------------------
// Steam A2S
// ---------------------------------------------------------------------------

const A2S_HEADER = Buffer.from([0xff, 0xff, 0xff, 0xff]);

function readCString(buffer, offset) {
  const end = buffer.indexOf(0, offset);
  if (end < 0) return { value: "", next: buffer.length };
  return { value: buffer.toString("utf8", offset, end), next: end + 1 };
}

function parseA2sInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6 || buffer.readInt32LE(0) !== -1 || buffer[4] !== 0x49) return null;
  let offset = 6; // header, 'I', protocol
  for (let index = 0; index < 4; index += 1) offset = readCString(buffer, offset).next; // name, map, folder, game
  if (offset + 4 > buffer.length) return null;
  return { online: buffer[offset + 2], max: buffer[offset + 3] };
}

function parseA2sPlayers(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 6 || buffer.readInt32LE(0) !== -1 || buffer[4] !== 0x44) return null;
  const count = buffer[5];
  const players = [];
  let offset = 6;
  for (let index = 0; index < count && offset < buffer.length && players.length < MAX_PLAYERS; index += 1) {
    offset += 1; // index
    const name = readCString(buffer, offset);
    offset = name.next;
    if (offset + 8 > buffer.length) break;
    const score = buffer.readInt32LE(offset);
    const duration = buffer.readFloatLE(offset + 4);
    offset += 8;
    players.push({ name: cleanName(name.value), score, durationSeconds: Number.isFinite(duration) && duration >= 0 ? Math.round(duration) : null });
  }
  return players;
}

// Requests that may first be answered with a challenge (0x41) must be sent
// again with that challenge appended.
async function a2sRequest(exchange, port, body) {
  let reply = await exchange(port, Buffer.concat([A2S_HEADER, body]));
  if (reply.length >= 9 && reply.readInt32LE(0) === -1 && reply[4] === 0x41) {
    const challenge = reply.subarray(5, 9);
    const base = body[0] === 0x55 ? Buffer.from([0x55]) : body;
    reply = await exchange(port, Buffer.concat([A2S_HEADER, base, challenge]));
  }
  return reply;
}

async function readA2s(config, family, { exchange }) {
  const ports = portsOf(config);
  const primary = ports[0];
  const candidates = [...new Set([
    Number.parseInt(config.queryPort, 10),
    family === "valheim" && primary ? primary + 1 : null,
    primary,
    family === "rust" && primary ? primary + 2 : null,
  ].filter((port) => Number.isInteger(port) && port > 0 && port <= 65535))].slice(0, 3);
  for (const port of candidates) {
    let info;
    try {
      info = parseA2sInfo(await a2sRequest(exchange, port, Buffer.concat([Buffer.from("TSource Engine Query", "latin1"), Buffer.from([0])])));
    } catch {
      info = null;
    }
    if (!info) continue;
    let players = null;
    try {
      players = parseA2sPlayers(await a2sRequest(exchange, port, Buffer.from([0x55, 0xff, 0xff, 0xff, 0xff])));
    } catch {
      players = null;
    }
    return {
      source: "steam-a2s",
      online: info.online,
      max: info.max,
      players: (players || []).map((player) => ({ name: player.name, pingMs: null, connectedSeconds: player.durationSeconds, score: player.score })),
      namesComplete: Array.isArray(players) && players.length === info.online,
      pingSupported: false,
      pingNote: "The Steam server query does not include each player's ping.",
      queryPort: port,
    };
  }
  return { error: "no_response", message: "The server did not answer the Steam server query. It may still be starting, or its query port may be different." };
}

// ---------------------------------------------------------------------------
// Minecraft, FiveM, Palworld
// ---------------------------------------------------------------------------

async function readMinecraft(config, { queryMinecraft }) {
  const reply = await queryMinecraft(config).catch(() => null);
  const status = reply && reply.status;
  if (!status || !status.players) return { error: "no_response", message: "The server did not answer the Minecraft status ping. It may still be starting." };
  const sample = Array.isArray(status.players.sample) ? status.players.sample : [];
  const online = wholeOrNull(status.players.online);
  // Servers often hide or cap the sample (12 names by default); placeholder
  // entries some plugins add have an all-zero id.
  const names = sample.filter((entry) => entry && entry.id !== "00000000-0000-0000-0000-000000000000").map((entry) => ({ name: cleanName(entry.name), pingMs: null, connectedSeconds: null }));
  return {
    source: "minecraft-status",
    online,
    max: wholeOrNull(status.players.max),
    players: names.filter((entry) => entry.name).slice(0, MAX_PLAYERS),
    namesComplete: online !== null && names.length === online,
    pingSupported: false,
    pingNote: "Minecraft does not report each player's ping to AnxOS. A server plugin can provide it; none is set up.",
  };
}

async function readFiveM(config, { getJson }) {
  const port = portsOf(config)[0] || 30120;
  let roster;
  let dynamic = null;
  try {
    roster = await getJson({ port, pathname: "/players.json" });
  } catch (error) {
    return { error: "no_response", message: `The FiveM server did not answer on port ${port}. It may still be starting.`, code: error?.code || null };
  }
  try {
    dynamic = await getJson({ port, pathname: "/dynamic.json" });
  } catch {
    dynamic = null;
  }
  if (!Array.isArray(roster)) return { error: "invalid_reply", message: "The FiveM server's player list could not be read." };
  return {
    source: "fivem-players",
    online: wholeOrNull(dynamic?.clients) ?? roster.length,
    max: wholeOrNull(dynamic?.sv_maxclients),
    // Only the name and ping are kept: the roster also carries identifiers
    // and endpoints, which are dropped here.
    players: roster.slice(0, MAX_PLAYERS).map((player) => ({ name: cleanName(player?.name), pingMs: wholeOrNull(player?.ping), connectedSeconds: null })),
    namesComplete: true,
    pingSupported: true,
    pingNote: "Ping as reported by the FiveM server for each player.",
  };
}

function parsePalworldSettings(text) {
  const match = /OptionSettings\s*=\s*\(([\s\S]*)\)/.exec(String(text || ""));
  if (!match) return null;
  const settings = {};
  const pattern = /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,]*)/g;
  let entry;
  while ((entry = pattern.exec(match[1]))) {
    const raw = entry[2].trim();
    settings[entry[1]] = raw.startsWith("\"") ? raw.slice(1, -1) : raw;
  }
  return settings;
}

async function readPalworld(config, { getJson, readFile, palworldSettingsPaths }) {
  // The host knows where this server keeps its settings (a Marketplace install
  // lives in data/server); the flat layout stays as a fallback.
  const hostPaths = (() => {
    try { return palworldSettingsPaths(config) || []; } catch { return []; }
  })();
  let settings = null;
  for (const relative of [...new Set([...hostPaths, ...PALWORLD_SETTINGS_PATHS])]) {
    const content = await readFile(config, relative).catch(() => null);
    if (content) {
      settings = parsePalworldSettings(content);
      if (settings) break;
    }
  }
  if (!settings || String(settings.RESTAPIEnabled).toLowerCase() !== "true") {
    return { error: "rest_api_disabled", message: "Palworld reports players through its REST API, which is off. Set RESTAPIEnabled=True and an AdminPassword in PalWorldSettings.ini, then restart the server." };
  }
  if (!settings.AdminPassword) return { error: "rest_api_no_password", message: "Palworld's REST API needs an AdminPassword in PalWorldSettings.ini." };
  const port = Number.parseInt(settings.RESTAPIPort, 10) || 8212;
  // The password stays in this process: it is sent only to 127.0.0.1 and
  // never returned or logged.
  const headers = { Authorization: `Basic ${Buffer.from(`admin:${settings.AdminPassword}`).toString("base64")}` };
  let list;
  let metrics = null;
  try {
    list = await getJson({ port, pathname: "/v1/api/players", headers });
  } catch (error) {
    return error?.code === "UNAUTHORIZED"
      ? { error: "rest_api_unauthorized", message: "Palworld's REST API refused the AdminPassword from PalWorldSettings.ini." }
      : { error: "no_response", message: `Palworld's REST API did not answer on port ${port}. It may still be starting.` };
  }
  try {
    metrics = await getJson({ port, pathname: "/v1/api/metrics", headers });
  } catch {
    metrics = null;
  }
  const players = Array.isArray(list?.players) ? list.players : [];
  return {
    source: "palworld-rest",
    online: wholeOrNull(metrics?.currentplayernum) ?? players.length,
    max: wholeOrNull(metrics?.maxplayernum) ?? wholeOrNull(settings.ServerPlayerMaxNum),
    // Account names, ids and IP addresses in the reply are dropped here.
    players: players.slice(0, MAX_PLAYERS).map((player) => ({ name: cleanName(player?.name), pingMs: wholeOrNull(player?.ping), connectedSeconds: null, level: wholeOrNull(player?.level) })),
    namesComplete: true,
    pingSupported: true,
    pingNote: "Ping as reported by the Palworld server for each player.",
  };
}

const UNSUPPORTED = Object.freeze({
  hytale: "The Hytale server does not offer a player list AnxOS can read yet.",
  terraria: "Terraria (TShock) needs a REST token to list players; AnxOS does not set one up yet.",
});

// ---------------------------------------------------------------------------
// Monitor
// ---------------------------------------------------------------------------

function createPlayerMonitor({
  now = () => Date.now(),
  getJson = httpGetJson,
  exchange = udpExchange,
  queryMinecraft = async () => null,
  readFile = async () => null,
  palworldSettingsPaths = () => [],
} = {}) {
  const state = new Map(); // instanceId -> { seen: Map(name -> firstSeenAt), events: [] }
  const cache = new Map(); // instanceId -> { at, value }
  const pending = new Map();

  function track(instanceId, names, at) {
    const entry = state.get(instanceId) || { seen: new Map(), events: [] };
    const current = new Set(names);
    for (const name of current) {
      if (!entry.seen.has(name)) {
        // The first read only records who is there; it is not a join.
        if (entry.initialized) entry.events.push({ at, type: "join", name });
        entry.seen.set(name, at);
      }
    }
    for (const name of [...entry.seen.keys()]) {
      if (!current.has(name)) {
        entry.events.push({ at, type: "leave", name });
        entry.seen.delete(name);
      }
    }
    entry.initialized = true;
    entry.events = entry.events.slice(-MAX_EVENTS);
    state.set(instanceId, entry);
    return entry;
  }

  async function readOnce(config, { running = true, serviceManaged = false } = {}) {
    const at = now();
    const family = familyOf(config);
    const base = { instanceId: config.id, game: family, checkedAt: new Date(at).toISOString() };
    if (!family || UNSUPPORTED[family]) {
      return { ...base, supported: false, reason: "unsupported_game", message: UNSUPPORTED[family] || "Player information is not available for this kind of server." };
    }
    if (!running) {
      state.delete(config.id);
      return { ...base, supported: true, running: false, online: null, max: null, players: [], events: [], ping: { supported: null }, message: "The server is not running." };
    }
    let reading;
    if (family === "minecraft") reading = await readMinecraft(config, { queryMinecraft });
    else if (family === "fivem") reading = await readFiveM(config, { getJson });
    else if (family === "palworld") reading = await readPalworld(config, { getJson, readFile, palworldSettingsPaths });
    else reading = await readA2s(config, family, { exchange });

    if (reading.error) return { ...base, supported: true, running: true, available: false, reason: reading.error, message: reading.message, online: null, max: null, players: [], events: state.get(config.id)?.events || [], ping: { supported: null } };

    const namesShown = !serviceManaged;
    const players = reading.players.map((player) => ({ ...player, name: namesShown ? player.name : null }));
    let events = state.get(config.id)?.events || [];
    if (namesShown && reading.namesComplete) {
      const tracked = track(config.id, players.map((player) => player.name).filter(Boolean), at);
      events = tracked.events;
      players.forEach((player) => {
        if (player.connectedSeconds === null && player.name && tracked.seen.has(player.name)) {
          player.seenForSeconds = Math.max(0, Math.round((at - tracked.seen.get(player.name)) / 1000));
        }
      });
    }
    const pings = players.map((player) => player.pingMs).filter((value) => value !== null && value !== undefined);
    return {
      ...base,
      supported: true,
      running: true,
      available: true,
      source: reading.source,
      sourceLabel: SOURCE_LABELS[reading.source] || reading.source,
      online: reading.online,
      max: reading.max,
      players,
      namesShown,
      namesComplete: reading.namesComplete === true,
      events: namesShown ? events : [],
      ping: reading.pingSupported
        ? { supported: true, note: reading.pingNote, averageMs: pings.length ? Math.round(pings.reduce((sum, value) => sum + value, 0) / pings.length) : null, highCount: pings.filter((value) => value >= HIGH_PING_MS).length, highThresholdMs: HIGH_PING_MS }
        : { supported: false, note: reading.pingNote },
      queryPort: reading.queryPort || null,
    };
  }

  return {
    async read(config, options = {}) {
      const key = config.id;
      const cached = cache.get(key);
      if (cached && now() - cached.at < CACHE_MS && cached.running === (options.running !== false)) return cached.value;
      if (pending.has(key)) return pending.get(key);
      const promise = readOnce(config, options).then((value) => {
        cache.set(key, { at: now(), value, running: options.running !== false });
        return value;
      }).finally(() => pending.delete(key));
      pending.set(key, promise);
      return promise;
    },
    forget(instanceId) {
      state.delete(instanceId);
      cache.delete(instanceId);
    },
  };
}

module.exports = {
  HIGH_PING_MS,
  createPlayerMonitor,
  familyOf,
  _test: { parseA2sInfo, parseA2sPlayers, parsePalworldSettings, readA2s, a2sRequest, httpGetJson, udpExchange },
};
