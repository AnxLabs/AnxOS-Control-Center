class MinecraftConfigError extends Error {
  constructor(message, code = "MINECRAFT_CONFIG_FAILED", details = {}) {
    super(message);
    this.name = "MinecraftConfigError";
    this.code = code;
    this.details = details;
  }
}

function parseMinecraftPort(value, fallback = null) {
  const raw = Array.isArray(value) ? value[0] : value;
  if ((raw === undefined || raw === null || raw === "") && fallback !== null) {
    return parseMinecraftPort(fallback, null);
  }
  if (typeof raw === "string" && !/^\d+$/.test(raw.trim())) {
    throw new MinecraftConfigError("Enter a whole-number Minecraft port between 1 and 65535.", "MINECRAFT_PORT_INVALID", { value: raw });
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MinecraftConfigError("Enter a Minecraft port between 1 and 65535.", "MINECRAFT_PORT_INVALID", { value: raw });
  }
  return port;
}

function resolveMinecraftPort(options = {}, defaultPorts = [25565]) {
  const candidate = Array.isArray(options.ports) && options.ports.length > 0
    ? options.ports[0]
    : options.port;
  return parseMinecraftPort(candidate, Array.isArray(defaultPorts) && defaultPorts.length > 0 ? defaultPorts[0] : 25565);
}

function normalizePortList(value, fallback = []) {
  if (value === undefined || value === null || value === "") {
    return Array.isArray(fallback) ? fallback.map((port) => parseMinecraftPort(port)) : [];
  }
  const rawPorts = Array.isArray(value) ? value : String(value).split(",");
  return rawPorts
    .filter((port) => String(port).trim() !== "")
    .map((port) => parseMinecraftPort(port));
}

function buildMinecraftProperties(options = {}, port = 25565) {
  const selectedPort = parseMinecraftPort(port, 25565);
  return {
    "server-port": String(selectedPort),
    motd: options.motd || `${String(options.name || options.instanceName || "AnxHost Server").trim() || "AnxHost Server"} on AnxHost`,
    "max-players": String(options.maxPlayers || 20),
    difficulty: options.difficulty || "normal",
    gamemode: options.gamemode || "survival",
    "view-distance": String(options.viewDistance || 10),
    "simulation-distance": String(options.simulationDistance || 10),
    "online-mode": options.onlineMode === false ? "false" : "true",
    "allow-flight": options.allowFlight ? "true" : "false",
    "spawn-protection": String(options.spawnProtection || 16),
    pvp: options.pvp === false ? "false" : "true",
    "white-list": options.whitelist ? "true" : "false",
    "generate-structures": options.generateStructures === false ? "false" : "true",
    "level-seed": options.seed || "",
  };
}

async function applyMinecraftServerProperties(agentClient, instanceId, options = {}, port = 25565, agentConfig = null) {
  const selectedPort = parseMinecraftPort(port, 25565);
  try {
    const result = await agentClient.saveMinecraftProperties(instanceId, buildMinecraftProperties(options, selectedPort), agentConfig);
    const savedPort = String(result?.properties?.["server-port"] || "");
    if (savedPort && savedPort !== String(selectedPort)) {
      throw new MinecraftConfigError("Minecraft server.properties did not save the selected port.", "SERVER_PROPERTIES_UPDATE_FAILED", {
        instanceId,
        expectedPort: selectedPort,
        actualPort: savedPort,
      });
    }
    return result;
  } catch (error) {
    if (error instanceof MinecraftConfigError) {
      throw error;
    }
    throw new MinecraftConfigError("Unable to update Minecraft server.properties.", "SERVER_PROPERTIES_UPDATE_FAILED", {
      instanceId,
      port: selectedPort,
      message: error?.message || "server.properties update failed",
      code: error?.code || error?.payload?.error?.code || null,
    });
  }
}

module.exports = {
  MinecraftConfigError,
  applyMinecraftServerProperties,
  buildMinecraftProperties,
  normalizePortList,
  parseMinecraftPort,
  resolveMinecraftPort,
};
