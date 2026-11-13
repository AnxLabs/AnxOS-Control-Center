"use strict";

// Phase X: the only actions the assistant can name.
//
// Each tool is a declaration over an existing Control Center operation. The
// declaration carries the permission token the normal page uses, what it
// targets, its argument schema, its side effects, whether a person must
// approve it, its timeout and how its result is verified. The model can only
// pick a tool id from this list and fill its arguments; validateToolCall()
// rejects anything else. New tools are added here by development review, never
// at runtime.
//
// Categories:
//   read         Runs without approval, under the user's own read permission.
//   operational  Needs an explicit approval of the exact target and arguments.
//   sensitive    Declared so the assistant can explain them, never executable
//                here. Their own pages keep their own confirmations.

const CATEGORIES = Object.freeze(["read", "operational", "sensitive"]);
const TARGET_KINDS = Object.freeze(["none", "node", "instance", "container"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,159}$/;

function tool(definition) {
  return Object.freeze({
    approval: definition.category === "operational",
    executable: definition.category !== "sensitive",
    timeoutMs: 15000,
    cancellable: false,
    args: {},
    sideEffects: "None. Reads only.",
    verification: "Not applicable (read only).",
    ...definition,
  });
}

const TOOLS = Object.freeze([
  // ---- read ---------------------------------------------------------------
  tool({ id: "computers.list", category: "read", permission: "nodes:read", target: "none",
    description: "List computers with connection state, OS, CPU, memory and disk use, and when each was last heard from." }),
  tool({ id: "computer.status", category: "read", permission: "system:read", target: "node",
    description: "One computer's connection, OS, Agent version and resource use." }),
  tool({ id: "servers.list", category: "read", permission: "instance:read", target: "node",
    description: "Game servers on one computer with their state, game and version." }),
  tool({ id: "server.status", category: "read", permission: "instance:read", target: "instance",
    description: "One game server's state, readiness, version and online players." }),
  tool({ id: "server.logs", category: "read", permission: "instance:read", target: "instance",
    args: { lines: { type: "integer", min: 20, max: 400, default: 200 } },
    description: "Recent console lines of one game server (redacted, treated as untrusted data)." }),
  tool({ id: "server.diagnose", category: "read", permission: "instance:read", target: "instance", timeoutMs: 20000,
    description: "Look for evidence of startup failures, port conflicts, memory exhaustion, EULA, Java, dependency and configuration errors, crash loops and disk pressure." }),
  tool({ id: "docker.containers", category: "read", permission: "docker:read", target: "node",
    description: "Docker containers on one computer with state, health and restart count." }),
  tool({ id: "docker.diagnose", category: "read", permission: "docker:read", target: "node",
    description: "Find unhealthy, restarting or failed containers and quote their evidence." }),
  tool({ id: "network.status", category: "read", permission: "nodes:read", target: "none",
    description: "Agent connections and cached connectivity diagnostics. Does not claim internet reachability without a real measurement." }),
  tool({ id: "capacity.check", category: "read", permission: "system:read", target: "node",
    args: { game: { type: "enum", values: ["minecraft", "rust", "palworld", "valheim", "terraria", "fivem", "hytale", "other"], default: "other" } },
    description: "Whether a computer has memory and disk headroom for another server, from its latest readings." }),
  tool({ id: "setup.plan", category: "read", permission: "instance:read", target: "node",
    args: {
      game: { type: "enum", values: ["minecraft", "palworld", "valheim", "terraria", "rust", "fivem", "hytale", "other"], default: "minecraft" },
      players: { type: "integer", min: 1, max: 200, default: 10 },
      wantsPlugins: { type: "boolean", default: false },
      wantsMods: { type: "boolean", default: false },
    },
    description: "Prepare a server plan (runtime, memory, storage) for the Create Server wizard. Creates nothing." }),

  // ---- operational (approval required) -----------------------------------
  tool({ id: "server.start", category: "operational", permission: "instance:lifecycle", target: "instance", timeoutMs: 120000, auditAction: "instance.start",
    sideEffects: "Starts the server process. Uses memory and CPU on its computer.",
    verification: "Reads the server status until it reports running (bounded), then reports readiness." }),
  tool({ id: "server.stop", category: "operational", permission: "instance:lifecycle", target: "instance", timeoutMs: 120000, auditAction: "instance.stop",
    sideEffects: "Stops the server. Connected players are disconnected.",
    verification: "Reads the server status until it reports stopped (bounded)." }),
  tool({ id: "server.restart", category: "operational", permission: "instance:lifecycle", target: "instance", timeoutMs: 180000, auditAction: "instance.restart",
    sideEffects: "Stops and starts the server. Connected players are disconnected.",
    verification: "Reads the server status until it reports running again (bounded)." }),
  tool({ id: "backup.create", category: "operational", permission: "backups:write", target: "instance", timeoutMs: 600000, auditAction: "backup.create",
    args: { type: { type: "enum", values: ["full", "world"], default: "full" } },
    sideEffects: "Writes a new backup archive on the server's computer. Uses disk space.",
    verification: "Lists the server's backups and looks for the new archive." }),
  tool({ id: "docker.container.restart", category: "operational", permission: "instance:lifecycle", target: "container", timeoutMs: 60000, auditAction: "docker.container.restart",
    sideEffects: "Restarts one container. Its service is briefly unavailable.",
    verification: "Reads the container list until it reports running (bounded)." }),

  // ---- sensitive (never executable through the assistant) ----------------
  tool({ id: "server.delete", category: "sensitive", permission: "instance:delete", target: "instance",
    description: "Delete a server and its data.", page: "the server's Settings tab" }),
  tool({ id: "backup.restore", category: "sensitive", permission: "backups:restore", target: "instance",
    description: "Restore or overwrite a server from a backup.", page: "Backups" }),
  tool({ id: "docker.remove", category: "sensitive", permission: "instance:delete", target: "container",
    description: "Remove containers, images or volumes.", page: "Docker" }),
  tool({ id: "network.exposure", category: "sensitive", permission: "settings:write", target: "node",
    description: "Change firewall rules or public exposure.", page: "Networking and Public Access" }),
  tool({ id: "security.permissions", category: "sensitive", permission: "settings:write", target: "none",
    description: "Change sign-in, roles or permissions.", page: "Security" }),
  tool({ id: "files.protected", category: "sensitive", permission: "files:write", target: "instance",
    description: "Edit protected server files.", page: "Files" }),
  tool({ id: "agent.update", category: "sensitive", permission: "settings:write", target: "node",
    description: "Deploy software or update an Agent.", page: "Computers" }),
]);

const TOOL_INDEX = new Map(TOOLS.map((entry) => [entry.id, entry]));

function getTool(id) {
  return TOOL_INDEX.get(String(id || "")) || null;
}

function listTools({ category = null } = {}) {
  return TOOLS.filter((entry) => !category || entry.category === category);
}

function toolError(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateId(value, name) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) throw toolError("AI_TOOL_TARGET_INVALID", `The ${name} is missing or not a valid id.`);
  return value;
}

function validateArg(name, spec, value) {
  if (value === undefined || value === null) {
    if (spec.default !== undefined) return spec.default;
    if (spec.required) throw toolError("AI_TOOL_ARGS_INVALID", `Missing argument "${name}".`);
    return undefined;
  }
  if (spec.type === "integer") {
    if (!Number.isInteger(value) || value < spec.min || value > spec.max) throw toolError("AI_TOOL_ARGS_INVALID", `Argument "${name}" must be a whole number from ${spec.min} to ${spec.max}.`);
    return value;
  }
  if (spec.type === "enum") {
    if (!spec.values.includes(value)) throw toolError("AI_TOOL_ARGS_INVALID", `Argument "${name}" is not one of the supported values.`);
    return value;
  }
  if (spec.type === "boolean") {
    if (typeof value !== "boolean") throw toolError("AI_TOOL_ARGS_INVALID", `Argument "${name}" must be true or false.`);
    return value;
  }
  throw toolError("AI_TOOL_ARGS_INVALID", `Argument "${name}" has an unsupported type.`);
}

// Validates a requested call strictly: known tool, the target fields its kind
// needs (stable ids, no display names), no unknown arguments, typed values.
// Returns a normalized, frozen call. Throws a coded error otherwise.
function validateToolCall(call) {
  if (!call || typeof call !== "object" || Array.isArray(call)) throw toolError("AI_TOOL_CALL_INVALID", "The tool request is not an object.");
  const definition = getTool(call.tool);
  if (!definition) throw toolError("AI_TOOL_UNKNOWN", "That tool does not exist.");
  const target = call.target && typeof call.target === "object" ? call.target : {};
  const normalizedTarget = {};
  if (definition.target === "node" || definition.target === "instance" || definition.target === "container") {
    normalizedTarget.nodeId = validateId(target.nodeId, "computer");
  }
  if (definition.target === "instance") normalizedTarget.instanceId = validateId(target.instanceId, "server");
  if (definition.target === "container") normalizedTarget.container = validateId(target.container, "container");
  const extraTargetKeys = Object.keys(target).filter((key) => !(key in normalizedTarget));
  if (extraTargetKeys.length) throw toolError("AI_TOOL_TARGET_INVALID", "The request names target fields this tool does not use.");
  const args = call.args && typeof call.args === "object" && !Array.isArray(call.args) ? call.args : {};
  const unknown = Object.keys(args).filter((key) => !Object.prototype.hasOwnProperty.call(definition.args, key));
  if (unknown.length) throw toolError("AI_TOOL_ARGS_INVALID", `Unknown argument "${unknown[0]}".`);
  const normalizedArgs = {};
  for (const [name, spec] of Object.entries(definition.args)) {
    const value = validateArg(name, spec, args[name]);
    if (value !== undefined) normalizedArgs[name] = value;
  }
  return Object.freeze({ tool: definition.id, target: Object.freeze(normalizedTarget), args: Object.freeze(normalizedArgs), definition });
}

// The catalogue the model sees: ids, descriptions and argument shapes only.
function describeToolsForModel() {
  return TOOLS.filter((entry) => entry.category === "read" || entry.category === "operational").map((entry) => ({
    tool: entry.id,
    kind: entry.category,
    target: entry.target,
    args: Object.fromEntries(Object.entries(entry.args).map(([name, spec]) => [name, spec.type === "enum" ? spec.values : spec.type])),
    description: entry.description || entry.sideEffects,
  }));
}

module.exports = {
  CATEGORIES,
  TARGET_KINDS,
  TOOLS,
  describeToolsForModel,
  getTool,
  listTools,
  validateToolCall,
};
