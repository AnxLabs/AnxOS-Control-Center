"use strict";

// The phone's API: a fixed list of routes, each one a thin call into the
// same main-process services the desktop IPC handlers use, behind the same
// permission tiers. Nothing here manages servers itself.
//
// Every route is checked twice:
//   1. the phone's own role (Viewer, Operator or Owner, chosen when it was
//      paired) must include the route's permission, and
//   2. the computer's AnxOS session must allow it too (requirePermission),
//      so a phone never does more than the person signed in on the computer,
//      and nothing works while AnxOS is locked there.
//
// What a phone can never do, whatever its role: run arbitrary commands on
// the computer, change a server's executable, arguments or working folder,
// open SSH, touch Docker, see Agent tokens or node credentials, or reach an
// Agent directly. Those routes simply do not exist.

const Model = require("../shared/homeDashboardModel");
const ServerView = require("../shared/serverViewModel");
const RestorePreview = require("../shared/restorePreview");
const { redactString } = require("../shared/redaction");

const CACHE_MS = 4000;
// Agent reachability is checked at most this often, however many phones ask.
const HEALTH_MS = 15000;
const HEALTH_TIMEOUT_MS = 5000;
const SETTINGS_FIELDS = Object.freeze(["displayName", "memoryLimit", "autoStart", "restartPolicy"]);
const RESTART_POLICIES = Object.freeze(["never", "on-failure", "always"]);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

function text(value, max = 200) {
  return String(value ?? "").slice(0, max);
}

function relativePath(value, field = "path") {
  const raw = String(value ?? "").replace(/\\/g, "/").trim();
  if (raw.length > 512 || /\u0000/.test(raw)) throw httpError(400, "INVALID_PATH", `That ${field} is not valid.`);
  return raw || ".";
}

// Agent and service errors, reduced to a code and a redacted message.
function toPublicError(error) {
  const nested = error?.payload?.error || {};
  const code = String(error?.code || nested.code || "REQUEST_FAILED").slice(0, 64);
  const status = Number(error?.status || error?.statusCode || nested.statusCode) || null;
  const rawMessage = (typeof error?.friendlyMessage === "string" && error.friendlyMessage)
    || (typeof nested.message === "string" && nested.message !== "Request failed." && nested.message)
    || error?.message || "Request failed.";
  const mapped = {
    LOGIN_REQUIRED: [423, "AnxOS is locked on the computer. Unlock it there to continue."],
    AUTH_UNLOCK_REQUIRED: [423, "AnxOS is locked on the computer. Unlock it there to continue."],
    AUTH_LOCKED: [423, "AnxOS is locked on the computer. Unlock it there to continue."],
    LOCAL_CREDENTIALS_LOCKED: [423, "AnxOS is locked on the computer. Unlock it there to continue."],
    PERMISSION_DENIED: [403, "The account signed in on the computer can't do this."],
    INSTANCE_CONFIG_CONFLICT: [409, "Someone changed these settings since you opened them. Reload and try again."],
    AGENT_UNAVAILABLE: [502, "AnxOS can't reach that computer right now."],
    NODE_NOT_FOUND: [404, "That computer isn't known to AnxOS."],
    INSTANCE_NOT_FOUND: [404, "That server doesn't exist."],
    PATH_NOT_FOUND: [404, "That file or folder doesn't exist."],
  }[code];
  const fallbackStatus = status && status >= 400 && status < 600 ? status : 500;
  return {
    status: mapped ? mapped[0] : fallbackStatus >= 500 && /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(rawMessage) ? 502 : fallbackStatus,
    code,
    message: redactString(mapped ? mapped[1] : String(rawMessage)).slice(0, 300),
  };
}

function connectionOf(node) {
  if (node.kind === "application-host") return "online";
  if (node.enabled === false) return "offline";
  const state = node.agentStatus?.state;
  if (state === "Connected") return "online";
  if (state === "Connecting") return "installing";
  if (state === "Degraded") return "warning";
  if (state === "Offline") return "offline";
  return "error";
}

function isOnline(computer) {
  return computer.connection === "online" || computer.connection === "warning";
}

// "Minecraft · Paper", the same wording as the desktop's server header.
function gameLabel(instance) {
  const title = (value) => String(value || "").replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()).trim();
  const game = isMinecraft(instance) ? "Minecraft" : title(instance.game || instance.templateName || instance.type || "");
  const software = String(instance.serverSoftware || "").trim();
  const sameAsGame = software.toLowerCase() === game.toLowerCase() || software.toLowerCase() === "vanilla";
  return software && !sameAsGame ? `${game} · ${title(software)}` : game;
}

function isMinecraft(instance) {
  const searchable = [instance?.type, ...(Array.isArray(instance?.tags) ? instance.tags : [])].join(" ").toLowerCase();
  return searchable.includes("minecraft") || instance?.type === "minecraft-paper";
}

function runningState(instance) {
  return ["running", "starting", "restarting"].includes(String(instance?.state || "").toLowerCase());
}

function playersOf(instance) {
  const players = instance?.minecraft?.players || instance?.players || {};
  const online = Number(players.online);
  return Number.isFinite(online) && players.online !== null && players.online !== undefined ? online : null;
}

// Only what the phone shows. Paths, commands, arguments and environment
// values stay on the computer.
function projectInstance(instance, computer) {
  const status = ServerView.describeServerStatus({
    state: instance.state,
    computerConnected: computer ? isOnline(computer) : true,
    failureText: instance.failureReason ? text(instance.failureReason, 200) : "",
  });
  const players = instance?.minecraft?.players || null;
  return {
    id: text(instance.id, 128),
    nodeId: computer ? computer.id : "",
    computer: computer ? computer.name : "",
    name: text(instance.displayName || instance.id, 120),
    state: text(instance.state, 40),
    running: runningState(instance),
    status,
    failureReason: text(instance.failureReason, 120),
    game: text(gameLabel(instance), 80),
    type: text(instance.type, 80),
    serverSoftware: text(instance.serverSoftware, 60),
    version: text(instance.minecraftVersion || instance.serverVersion || instance.version || "", 60),
    port: Number.isFinite(Number(instance.port)) ? Number(instance.port) : null,
    players: playersOf(instance),
    maxPlayers: players && Number.isFinite(Number(players.max)) ? Number(players.max) : null,
    playerNames: players && Array.isArray(players.sample) ? players.sample.slice(0, 50).map((entry) => text(entry?.name || entry, 40)) : [],
    autoStart: instance.autoStart === true,
    memoryLimit: text(instance.memoryLimit, 20),
    isMinecraft: isMinecraft(instance),
  };
}

function createMobileApi({ services, security, now = () => Date.now() } = {}) {
  const cache = new Map();
  const vitals = new Map();

  function cached(key, ttl, load) {
    const entry = cache.get(key);
    if (entry && (entry.promise || now() - entry.at < ttl)) return entry.promise || entry.value;
    const promise = Promise.resolve().then(load).then((value) => {
      cache.set(key, { value, at: now() });
      return value;
    }, (error) => {
      cache.delete(key);
      throw error;
    });
    cache.set(key, { promise, at: now() });
    return promise;
  }

  function invalidate(prefix) {
    for (const key of cache.keys()) if (key.startsWith(prefix)) cache.delete(key);
  }

  function roleAllows(device, permission) {
    const granted = security.ROLE_PERMISSIONS[device.role] || [];
    return granted.includes("*") || granted.includes(permission);
  }

  // Both checks; throws an HTTP error the gateway turns into a response.
  function authorize(device, permission, target) {
    if (!roleAllows(device, permission)) {
      security.audit({ action: "mobile.permission", outcome: "denied", target: text(target, 120), reason: `${device.id}:${permission}` });
      throw httpError(403, "ROLE_DENIED", `This phone was paired as ${device.role} and can't do this. Pair it again with a higher role on the computer.`);
    }
    const status = security.getStatus();
    if (status.setupRequired) throw httpError(503, "SECURITY_SETUP_REQUIRED", "Set up AnxOS security on the computer before using phone access.");
    try {
      security.requirePermission(permission, target);
    } catch (error) {
      const shaped = toPublicError(error);
      throw httpError(shaped.status, shaped.code, shaped.message);
    }
  }

  function capabilities(device) {
    const can = (permission) => roleAllows(device, permission);
    return {
      read: can("instance:read"),
      lifecycle: can("instance:lifecycle"),
      console: can("instance:write"),
      settings: can("instance:write"),
      files: can("files:write"),
      addons: can("files:write"),
      backupsCreate: can("backups:write"),
      backupsVerify: can("backups:verify"),
      backupsRestore: can("backups:restore"),
      backupsDownload: can("backups:write"),
      sharing: can("public-access:read"),
    };
  }

  // ---- Computers and readings ----------------------------------------------

  async function listComputers() {
    const listing = await cached("nodes", CACHE_MS, () => services.nodeService().listNodes({ discoverLocalAgent: false, refreshIdentity: false }));
    const nodes = (Array.isArray(listing?.nodes) ? listing.nodes : []).filter((node) => node && node.enabled !== false);
    const agents = nodes.filter((node) => node.kind !== "application-host");
    const checked = await Promise.all(agents.map((node) => checkHealth(node, listing?.credentialsLocked === true)));
    const list = agents.length ? checked : nodes;
    return {
      locked: listing?.credentialsLocked === true,
      computers: list.map((node) => ({
        id: text(node.id, 128),
        name: text(node.displayName || node.name || node.id, 80),
        kind: node.kind,
        connection: connectionOf(node),
        connectionDetail: text(node.agentStatus?.secondary || "", 200),
        selected: false,
        isAnxOS: /anxos/i.test([node.agentIdentity?.osVersion, node.platformLabel].filter(Boolean).join(" ")),
        deviceId: text(node.agentIdentity?.deviceId || node.deviceId || "", 80),
      })),
    };
  }

  // The recorded connection state can be old (it is written by whoever last
  // checked), so each Agent is checked the same way the fleet summary does
  // before the phone is told it is online or offline.
  async function checkHealth(node, locked) {
    const check = services.nodeService().checkNodeHealth;
    if (locked || typeof check !== "function") return node;
    try {
      const result = await cached(`health:${node.id}`, HEALTH_MS, () => check(node.id, { timeoutMs: HEALTH_TIMEOUT_MS }));
      return result && result.node ? { ...node, ...result.node } : node;
    } catch {
      return node;
    }
  }

  // One system reading per computer at most every few seconds, however many
  // phones are asking. The history feeds the sustained-pressure rules.
  async function readVitals(computer) {
    if (!isOnline(computer)) return vitals.get(computer.id) || null;
    try {
      const snapshot = await cached(`snapshot:${computer.id}`, CACHE_MS, () => services.systemService().getSystemSnapshot({ nodeId: computer.id }));
      if (!snapshot || snapshot.ok === false) throw new Error(snapshot?.error?.message || "Readings unavailable");
      const entry = vitals.get(computer.id) || { history: [] };
      if (!entry.reading || entry.snapshot !== snapshot) {
        const reading = Model.readingFromSnapshot(snapshot, now());
        vitals.set(computer.id, { reading, snapshot, history: Model.appendHistory(entry.history, reading), error: null });
      }
    } catch (error) {
      const entry = vitals.get(computer.id) || { history: [], reading: null };
      vitals.set(computer.id, { ...entry, error: toPublicError(error).message });
    }
    return vitals.get(computer.id);
  }

  async function serversFor(computer) {
    if (!isOnline(computer)) return { computer, known: false, servers: [], error: "Computer not connected" };
    try {
      const listing = await cached(`instances:${computer.id}`, CACHE_MS, () => services.serviceRouter().listInstances({ nodeId: computer.id }));
      const instances = Array.isArray(listing?.instances) ? listing.instances : Array.isArray(listing) ? listing : [];
      return { computer, known: true, servers: instances.map((instance) => projectInstance(instance, computer)) };
    } catch (error) {
      return { computer, known: false, servers: [], error: toPublicError(error).message };
    }
  }

  async function overview() {
    const { computers, locked } = await listComputers();
    await Promise.all(computers.map(readVitals));
    const perComputer = await Promise.all(computers.map(serversFor));
    const servers = perComputer.flatMap((entry) => entry.servers);
    perComputer.forEach((entry) => {
      entry.computer.serverCount = entry.known ? entry.servers.length : null;
      entry.computer.runningServerCount = entry.known ? entry.servers.filter((server) => server.running).length : null;
    });
    const at = now();
    const vitalsById = Object.fromEntries(computers.map((computer) => [computer.id, vitals.get(computer.id) || {}]));
    const attention = Model.buildAttentionItems({
      computers,
      vitalsById,
      servers: servers.map((server) => ({ id: `${server.nodeId}/${server.id}`, name: server.name, state: server.state, failureReason: server.failureReason })),
      now: at,
    });
    const allKnown = perComputer.every((entry) => entry.known || !isOnline(entry.computer));
    const reported = servers.filter((server) => server.running && server.players !== null);
    return {
      at: new Date(at).toISOString(),
      locked,
      computers: computers.map((computer) => Model.buildComputerCard(computer, vitals.get(computer.id), at)),
      servers,
      unknownComputers: perComputer.filter((entry) => !entry.known).map((entry) => ({ id: entry.computer.id, name: entry.computer.name, reason: entry.error || "" })),
      attention,
      overview: Model.buildOverview({
        computers,
        servers,
        serversKnown: allKnown && perComputer.some((entry) => entry.known),
        players: reported.length ? reported.reduce((sum, server) => sum + server.players, 0) : null,
        attention: attention.filter((item) => item.severity !== "info"),
        unknownServersDetail: "Checking servers",
      }),
    };
  }

  async function computerFor(nodeId) {
    const { computers } = await listComputers();
    const computer = computers.find((entry) => entry.id === nodeId);
    if (!computer) throw httpError(404, "NODE_NOT_FOUND", "That computer isn't known to AnxOS.");
    return computer;
  }

  async function instanceFor(nodeId, instanceId) {
    const computer = await computerFor(nodeId);
    const { servers, known, error } = await serversFor(computer);
    if (!known) throw httpError(isOnline(computer) ? 502 : 409, "COMPUTER_UNAVAILABLE", error || "AnxOS can't reach that computer right now.");
    const server = servers.find((entry) => entry.id === instanceId);
    if (!server) throw httpError(404, "INSTANCE_NOT_FOUND", "That server doesn't exist.");
    return { computer, server };
  }

  // ---- Routes ----------------------------------------------------------------

  const routes = [];
  const route = (method, pattern, permission, handler, options = {}) => {
    const keys = [];
    const regex = new RegExp(`^${pattern.replace(/:([a-zA-Z]+)/g, (_, key) => { keys.push(key); return "([^/]+)"; })}$`);
    routes.push({ method, regex, keys, permission, handler, ...options });
  };
  const serverPath = "/servers/:nodeId/:instanceId";
  const target = (ctx, suffix = "") => `${ctx.params.instanceId}${suffix}`;
  const scoped = (ctx) => ({ nodeId: ctx.params.nodeId });
  const lifecycle = (action) => async (ctx) => {
    await instanceFor(ctx.params.nodeId, ctx.params.instanceId);
    security.audit({ action: `instance.${action}`, target: ctx.params.instanceId, reason: `mobile:${ctx.device.id}` });
    const fn = { start: "startInstance", stop: "stopInstance", restart: "restartInstance" }[action];
    const result = await services.serviceRouter()[fn](ctx.params.instanceId, scoped(ctx));
    invalidate(`instances:${ctx.params.nodeId}`);
    return { ok: true, state: text(result?.state || result?.instance?.state || "", 40) };
  };
  const modTarget = (ctx) => ({ instanceId: ctx.params.instanceId, nodeId: ctx.params.nodeId });
  const modProvider = (value) => (value === "curseforge" ? "curseforge" : "modrinth");

  route("GET", "/home", "instance:read", () => overview());
  route("GET", "/computers/:nodeId", "system:read", async (ctx) => {
    const computer = await computerFor(ctx.params.nodeId);
    const entry = await readVitals(computer);
    const reading = entry && entry.reading;
    return {
      card: Model.buildComputerCard(computer, entry, now()),
      connectionDetail: computer.connectionDetail,
      details: reading ? { cpuModel: text(reading.cpuModel, 120), cpuCores: reading.cpuCores, uptimeSeconds: reading.uptimeSeconds, diskTotal: reading.diskTotal, os: text(reading.osVersion || Model.platformLabel?.(reading.platform) || reading.platform, 80) } : null,
      attention: Model.buildAttentionItems({ computers: [computer], vitalsById: { [computer.id]: entry || {} }, now: now() }),
    };
  });

  route("GET", serverPath, "instance:read", async (ctx) => {
    const { computer, server } = await instanceFor(ctx.params.nodeId, ctx.params.instanceId);
    let metrics = null;
    if (server.running) {
      try {
        const raw = await services.serviceRouter().getInstanceMetrics(ctx.params.instanceId, scoped(ctx));
        const sampledAt = Date.parse(raw?.sampledAt || raw?.at || raw?.timestamp || "") || now();
        metrics = {
          cpuPercent: Number.isFinite(Number(raw?.cpuPercent ?? raw?.cpu)) ? Number(raw?.cpuPercent ?? raw?.cpu) : null,
          memoryBytes: Number.isFinite(Number(raw?.memoryBytes ?? raw?.memory?.rss ?? raw?.memory)) ? Number(raw?.memoryBytes ?? raw?.memory?.rss ?? raw?.memory) : null,
          freshness: ServerView.readingFreshness(sampledAt, now()),
        };
      } catch {
        metrics = null;
      }
    }
    return {
      server,
      computer: { id: computer.id, name: computer.name, connection: computer.connection },
      metrics,
      addons: ServerView.describeAddonSupport({ serverSoftware: server.serverSoftware, minecraftVersion: server.isMinecraft ? server.version : "" }, { isMinecraft: server.isMinecraft }),
    };
  });
  route("POST", `${serverPath}/start`, "instance:lifecycle", lifecycle("start"));
  route("POST", `${serverPath}/stop`, "instance:lifecycle", lifecycle("stop"));
  route("POST", `${serverPath}/restart`, "instance:lifecycle", lifecycle("restart"));

  route("GET", `${serverPath}/logs`, "instance:read", async (ctx) => {
    const limit = Math.max(20, Math.min(500, Number(ctx.query.get("limit")) || 200));
    const result = await services.serviceRouter().getInstanceLogs(ctx.params.instanceId, { ...scoped(ctx), stream: "all", limit });
    const lines = Array.isArray(result?.lines) ? result.lines : Array.isArray(result?.entries) ? result.entries : Array.isArray(result) ? result : [];
    return {
      lines: lines.slice(-limit).map((line) => ({
        at: text(line?.at, 40),
        stream: text(line?.stream, 10),
        message: redactString(text(typeof line === "string" ? line : line?.message, 2000)),
      })),
    };
  });
  route("POST", `${serverPath}/command`, "instance:write", async (ctx) => {
    const command = String(ctx.body.command ?? "").replace(/[\r\n]+/g, " ").trim();
    if (!command || command.length > 1000) throw httpError(400, "INVALID_COMMAND", "Type a command of up to 1000 characters.");
    await instanceFor(ctx.params.nodeId, ctx.params.instanceId);
    security.checkRateLimit("console-command", 120, 60 * 1000);
    security.audit({ action: "instance.command", target: ctx.params.instanceId, reason: `mobile:${ctx.device.id}` });
    await services.serviceRouter().sendInstanceCommand(ctx.params.instanceId, command, scoped(ctx));
    return { ok: true };
  });

  // Settings: only these four fields, never the executable, its arguments,
  // the working folder or environment values.
  route("GET", `${serverPath}/settings`, "instance:read", async (ctx) => {
    const listing = await services.serviceRouter().listInstances(scoped(ctx));
    const instances = Array.isArray(listing?.instances) ? listing.instances : [];
    const instance = instances.find((entry) => entry.id === ctx.params.instanceId);
    if (!instance) throw httpError(404, "INSTANCE_NOT_FOUND", "That server doesn't exist.");
    const values = {
      displayName: text(instance.displayName, 80),
      memoryLimit: text(instance.memoryLimit, 20),
      autoStart: instance.autoStart === true,
      restartPolicy: RESTART_POLICIES.includes(instance.restartPolicy) ? instance.restartPolicy : "never",
    };
    return { values, expected: { ...values }, restartPolicies: RESTART_POLICIES, desktopOnly: ["Startup command and arguments", "Working folder", "Environment variables", "Ports", "Java runtime"] };
  });
  route("PUT", `${serverPath}/settings`, "instance:write", async (ctx) => {
    const changes = {};
    const expected = {};
    for (const field of SETTINGS_FIELDS) {
      if (ctx.body.changes && Object.prototype.hasOwnProperty.call(ctx.body.changes, field)) changes[field] = ctx.body.changes[field];
      if (ctx.body.expected && Object.prototype.hasOwnProperty.call(ctx.body.expected, field)) expected[field] = ctx.body.expected[field];
    }
    if (!Object.keys(changes).length) throw httpError(400, "NO_CHANGES", "Nothing to save.");
    if ("autoStart" in changes) changes.autoStart = changes.autoStart === true;
    if ("restartPolicy" in changes && !RESTART_POLICIES.includes(changes.restartPolicy)) throw httpError(400, "INVALID_SETTINGS", "Choose a restart policy from the list.");
    if ("displayName" in changes) changes.displayName = String(changes.displayName ?? "").trim();
    if ("memoryLimit" in changes) changes.memoryLimit = String(changes.memoryLimit ?? "").trim();
    const errors = ServerView.validateServerSettings(changes);
    if (Object.keys(errors).length) throw Object.assign(httpError(400, "INVALID_SETTINGS", Object.values(errors)[0]), { fields: errors });
    security.audit({ action: "instance.update", target: ctx.params.instanceId, reason: `mobile:${ctx.device.id}` });
    await services.serviceRouter().updateInstance(ctx.params.instanceId, { ...changes, expectedConfig: Object.keys(expected).length ? expected : undefined }, scoped(ctx));
    invalidate(`instances:${ctx.params.nodeId}`);
    return { ok: true, restartRecommended: ServerView.changedRestartFields(expected, changes).length > 0 };
  });

  // Files, inside the server's own folder (the service enforces that).
  route("GET", `${serverPath}/files`, "instance:read", async (ctx) => {
    const result = await services.serviceRouter().listInstanceFiles(ctx.params.instanceId, relativePath(ctx.query.get("path")), scoped(ctx));
    return {
      path: text(result?.currentPath, 512),
      entries: (Array.isArray(result?.entries) ? result.entries : []).slice(0, 1000).map((entry) => ({
        name: text(entry.name, 255), path: text(entry.path, 512), type: text(entry.type, 12), size: entry.size ?? null, modifiedAt: entry.modifiedAt || null,
      })),
    };
  });
  route("GET", `${serverPath}/file`, "instance:read", async (ctx) => {
    const result = await services.serviceRouter().readInstanceFile(ctx.params.instanceId, relativePath(ctx.query.get("path")), scoped(ctx));
    return { path: text(result?.path, 512), supported: result?.supported !== false, reason: text(result?.reason, 60), content: result?.supported === false ? "" : String(result?.content ?? "") };
  });
  route("PUT", `${serverPath}/file`, "files:write", async (ctx) => {
    const filePath = relativePath(ctx.body.path);
    const content = String(ctx.body.content ?? "");
    if (Buffer.byteLength(content) > 1024 * 1024) throw httpError(413, "FILE_TOO_LARGE", "Text files over 1 MB can only be edited on the computer.");
    security.checkRateLimit("instance-file-write", 120, 60 * 1000);
    security.audit({ action: "instance.file.write", target: `${ctx.params.instanceId}:${filePath}`, reason: `mobile:${ctx.device.id}` });
    await services.serviceRouter().writeInstanceFile(ctx.params.instanceId, filePath, content, scoped(ctx));
    return { ok: true };
  });
  route("POST", `${serverPath}/files/upload`, "files:write", async (ctx) => {
    const filePath = relativePath(ctx.body.path);
    const contentBase64 = String(ctx.body.contentBase64 || "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64)) throw httpError(400, "INVALID_UPLOAD", "The upload was not readable.");
    if (contentBase64.length * 0.75 > MAX_UPLOAD_BYTES) throw httpError(413, "FILE_TOO_LARGE", "Files over 25 MB can only be uploaded on the computer.");
    security.checkRateLimit("instance-file-write", 120, 60 * 1000);
    security.audit({ action: "instance.file.write", target: `${ctx.params.instanceId}:${filePath}`, reason: `mobile:${ctx.device.id}` });
    // Bytes as base64, never decoded as text, so jars and images stay intact.
    await services.serviceRouter().writeInstanceFile(ctx.params.instanceId, filePath, contentBase64, { ...scoped(ctx), encoding: "base64" });
    return { ok: true };
  }, { maxBody: 36 * 1024 * 1024 });
  route("POST", `${serverPath}/files/folder`, "files:write", async (ctx) => {
    const folder = relativePath(ctx.body.path);
    security.audit({ action: "instance.folder.create", target: `${ctx.params.instanceId}:${folder}`, reason: `mobile:${ctx.device.id}` });
    await services.serviceRouter().createInstanceFolder(ctx.params.instanceId, folder, scoped(ctx));
    return { ok: true };
  });
  route("POST", `${serverPath}/files/rename`, "files:write", async (ctx) => {
    const oldPath = relativePath(ctx.body.oldPath);
    const newPath = relativePath(ctx.body.newPath);
    security.audit({ action: "instance.file.rename", target: `${ctx.params.instanceId}:${oldPath}`, reason: `mobile:${ctx.device.id}` });
    await services.serviceRouter().renameInstanceFile(ctx.params.instanceId, oldPath, newPath, scoped(ctx));
    return { ok: true };
  });
  route("POST", `${serverPath}/files/delete`, "files:write", async (ctx) => {
    const filePath = relativePath(ctx.body.path);
    if (ctx.body.confirm !== filePath || filePath === "." || filePath === "/") throw httpError(400, "CONFIRMATION_REQUIRED", "Confirm the exact file or folder to delete.");
    security.audit({ action: "instance.file.delete", target: `${ctx.params.instanceId}:${filePath}`, reason: `mobile:${ctx.device.id}` });
    await services.serviceRouter().deleteInstanceFile(ctx.params.instanceId, filePath, scoped(ctx));
    return { ok: true };
  });

  // Add-ons (Mod Manager), the same plan-then-approve flow as the desktop.
  // Projected: the phone gets names, versions and states, not folder paths
  // or backup locations.
  route("GET", `${serverPath}/addons`, "instance:read", async (ctx) => {
    const result = await services.modManager().listMods(modTarget(ctx));
    return {
      running: result?.running === true,
      mods: (result?.mods || []).slice(0, 500).map((mod) => ({
        fileName: text(mod.fileName, 255),
        title: text(mod.title, 120),
        enabled: mod.enabled === true,
        provider: text(mod.provider || "", 20),
        versionNumber: text(mod.versionNumber || "", 60),
        size: mod.size ?? null,
        dependencyOf: mod.dependencyOf ? text(mod.dependencyOf, 120) : null,
        canRollBack: mod.canRollBack === true,
      })),
      warnings: (result?.warnings || []).slice(0, 50).map((warning) => ({ title: text(warning.title, 120), missing: text(warning.missing, 120) })),
    };
  });
  route("GET", `${serverPath}/addons/updates`, "instance:read", async (ctx) => {
    const result = await services.modManager().checkModUpdates(modTarget(ctx));
    return {
      updates: (result?.updates || []).map((update) => ({ fileName: text(update.fileName, 255), title: text(update.title, 120), currentVersion: text(update.currentVersion, 60), latestVersion: text(update.latestVersion, 60) })),
      failed: Array.isArray(result?.failed) ? result.failed.length : 0,
    };
  });
  route("GET", `${serverPath}/addons/search`, "instance:read", async (ctx) => {
    const result = await services.modManager().searchMods({ ...modTarget(ctx), provider: modProvider(ctx.query.get("provider")), query: text(ctx.query.get("q"), 100), offset: Number(ctx.query.get("offset")) || 0, limit: 20 });
    return {
      provider: text(result?.provider, 20),
      total: Number(result?.total) || 0,
      hits: (result?.hits || []).slice(0, 20).map((hit) => ({ id: text(hit.id, 64), name: text(hit.name || hit.title, 120), author: text(hit.author, 60), description: text(hit.description, 240), downloads: Number(hit.downloads) || 0 })),
    };
  });
  route("GET", `${serverPath}/addons/plan`, "instance:read", (ctx) => services.modManager().planInstall({ ...modTarget(ctx), provider: modProvider(ctx.query.get("provider")), projectId: text(ctx.query.get("projectId"), 64) }));
  const modWrite = (action, call) => async (ctx) => {
    security.audit({ action: `instance.mods.${action}`, target: `${ctx.params.instanceId}:${text(ctx.body.fileName || ctx.body.projectId || "", 120)}`, reason: `mobile:${ctx.device.id}` });
    return call(ctx);
  };
  route("POST", `${serverPath}/addons/install`, "files:write", modWrite("install", (ctx) => services.modManager().installMod({
    ...modTarget(ctx),
    provider: modProvider(ctx.body.provider),
    projectId: text(ctx.body.projectId, 64),
    approvedDependencies: Array.isArray(ctx.body.approvedDependencies) ? ctx.body.approvedDependencies.slice(0, 32).map((id) => text(id, 64)) : [],
  })));
  route("POST", `${serverPath}/addons/update`, "files:write", modWrite("update", (ctx) => services.modManager().updateMod({ ...modTarget(ctx), fileName: text(ctx.body.fileName, 255) })));
  route("POST", `${serverPath}/addons/update-all`, "files:write", modWrite("updateAll", (ctx) => services.modManager().updateAllMods(modTarget(ctx))));
  route("POST", `${serverPath}/addons/rollback`, "files:write", modWrite("rollback", (ctx) => services.modManager().rollbackMod({ ...modTarget(ctx), fileName: text(ctx.body.fileName, 255) })));
  route("POST", `${serverPath}/addons/enabled`, "files:write", modWrite("setEnabled", (ctx) => services.modManager().setModEnabled({ ...modTarget(ctx), fileName: text(ctx.body.fileName, 255), enabled: ctx.body.enabled === true })));
  route("POST", `${serverPath}/addons/remove`, "files:write", modWrite("remove", (ctx) => {
    if (ctx.body.confirm !== ctx.body.fileName) throw httpError(400, "CONFIRMATION_REQUIRED", "Confirm the add-on to remove.");
    return services.modManager().removeMod({ ...modTarget(ctx), fileName: text(ctx.body.fileName, 255), enabled: ctx.body.enabled !== false });
  }));
  route("POST", `${serverPath}/addons/import`, "files:write", modWrite("import", (ctx) => {
    const contentBase64 = String(ctx.body.contentBase64 || "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(contentBase64) || contentBase64.length * 0.75 > MAX_UPLOAD_BYTES) throw httpError(400, "INVALID_UPLOAD", "Choose a .jar file up to 25 MB.");
    return services.modManager().importModFile({ ...modTarget(ctx), fileName: text(ctx.body.fileName, 200), contentBase64 });
  }), { maxBody: 36 * 1024 * 1024 });

  // Backups.
  route("GET", `${serverPath}/backups`, "backups:read", async (ctx) => {
    const result = await services.serviceRouter().listBackups({ nodeId: ctx.params.nodeId, instanceId: ctx.params.instanceId });
    const backups = Array.isArray(result?.backups) ? result.backups : Array.isArray(result) ? result : [];
    return {
      backups: backups.filter((backup) => !backup.instanceId || backup.instanceId === ctx.params.instanceId).slice(0, 200).map((backup) => ({
        id: text(backup.id, 200),
        name: text(backup.name || backup.id, 160),
        type: text(backup.type, 20),
        createdAt: backup.createdAt || null,
        size: Number.isFinite(Number(backup.size ?? backup.sizeBytes)) ? Number(backup.size ?? backup.sizeBytes) : null,
        verification: text(backup.verification?.state || backup.verificationState || backup.verified || "", 30),
        reason: text(backup.reason || backup.createdBy || "", 40),
      })),
    };
  });
  route("POST", `${serverPath}/backups`, "backups:write", async (ctx) => {
    const type = ctx.body.type === "world" ? "world" : "full";
    security.audit({ action: "backup.create", target: ctx.params.instanceId, reason: `mobile:${ctx.device.id}` });
    const result = await services.serviceRouter().createBackup({ nodeId: ctx.params.nodeId, instanceId: ctx.params.instanceId, type, name: ctx.body.name ? text(ctx.body.name, 120) : undefined });
    return { ok: true, backupId: text(result?.backup?.id || result?.id || "", 200) };
  });
  route("POST", "/backups/:nodeId/:backupId/verify", "backups:verify", async (ctx) => {
    security.audit({ action: "backup.verify", target: `${ctx.params.nodeId}:${ctx.params.backupId}`, reason: `mobile:${ctx.device.id}` });
    const result = await services.verifyBackup(ctx.params.nodeId, ctx.params.backupId);
    return { ok: true, state: text(result?.state || result?.verification?.state || result?.status || "", 40), detail: redactString(text(result?.message || result?.verification?.message || "", 300)) };
  });
  route("POST", "/backups/:nodeId/:backupId/restore-preview", "backups:restore", async (ctx) => {
    const preview = await services.serviceRouter().restoreBackup({ nodeId: ctx.params.nodeId, backupId: ctx.params.backupId, preview: true });
    const described = RestorePreview.describeRestorePreview(preview, { formatDate: (value) => new Date(value).toLocaleString("en-GB") });
    return { available: Boolean(described), lines: described ? described.lines : [], warnings: described ? described.warnings : [] };
  });
  route("POST", "/backups/:nodeId/:backupId/restore", "backups:restore", async (ctx) => {
    if (ctx.body.confirm !== "RESTORE") throw httpError(400, "CONFIRMATION_REQUIRED", "Type RESTORE to confirm.");
    security.audit({ action: "backup.restore", target: ctx.params.backupId, reason: `mobile:${ctx.device.id}` });
    await services.serviceRouter().restoreBackup({ nodeId: ctx.params.nodeId, backupId: ctx.params.backupId, restart: ctx.body.restart === true, confirmOverwrite: true });
    invalidate(`instances:${ctx.params.nodeId}`);
    return { ok: true };
  });
  route("GET", "/backups/:nodeId/:backupId/download", "backups:write", async (ctx) => {
    security.audit({ action: "backup.download", target: ctx.params.backupId, reason: `mobile:${ctx.device.id}` });
    const payload = await services.serviceRouter().downloadBackup(ctx.params.backupId, { nodeId: ctx.params.nodeId });
    const name = ctx.params.backupId.endsWith(".tar.gz") ? ctx.params.backupId : `${ctx.params.backupId}.tar.gz`;
    return { download: { buffer: payload.buffer, fileName: name.replace(/[^A-Za-z0-9._-]/g, "_"), contentType: "application/gzip" } };
  });

  // AnxNet: what this computer's AnxNet node reports, nothing more.
  route("GET", "/sharing", "public-access:read", async () => {
    const status = await services.anxnet().status();
    const network = status?.network || null;
    return {
      anxnet: {
        running: status?.running === true,
        error: status?.error ? redactString(text(status.error, 200)) : "",
        network: network ? { name: text(network.name, 80), domain: text(network.domain, 80), role: text(network.role, 10), coordinator: network.coordinator?.state || "" } : null,
        devices: (status?.devices || []).map((device) => ({ name: text(device.name, 80), self: device.self === true, connection: text(device.connection, 20), latencyMs: device.latencyMs ?? null })),
        services: (status?.services || []).map((service) => ({ name: text(service.name, 80), port: service.port ?? null, protocol: text(service.protocol, 5), local: service.local === true, reachableHere: service.reachableHere === true })),
        edgeLinks: (status?.edgeLinks || []).map((link) => ({ role: text(link.role, 10), state: text(link.state, 20) })),
        publicRoutes: (status?.publicRoutes || []).length,
      },
    };
  });

  function match(method, pathname) {
    let pathMatched = false;
    for (const entry of routes) {
      const found = entry.regex.exec(pathname);
      if (!found) continue;
      pathMatched = true;
      if (entry.method !== method) continue;
      const params = {};
      entry.keys.forEach((key, index) => {
        let value;
        try {
          value = decodeURIComponent(found[index + 1]);
        } catch {
          value = "";
        }
        params[key] = value;
      });
      if (Object.values(params).some((value) => !value || value.length > 200 || /[\u0000/\\]/.test(value) || value === "." || value === "..")) {
        return { error: httpError(400, "INVALID_TARGET", "That address is not valid.") };
      }
      return { route: entry, params };
    }
    return pathMatched ? { error: httpError(405, "METHOD_NOT_ALLOWED", "Not allowed.") } : null;
  }

  async function handle(entry, { params, query, body, device }) {
    const permission = typeof entry.permission === "function" ? entry.permission(body) : entry.permission;
    authorize(device, permission, params.instanceId || params.backupId || params.nodeId || entry.regex.source);
    return entry.handler({ params, query, body: body || {}, device });
  }

  return { match, handle, capabilities, toPublicError, routes };
}

module.exports = { createMobileApi, projectInstance, toPublicError, SETTINGS_FIELDS };
