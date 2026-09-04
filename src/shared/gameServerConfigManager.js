"use strict";

const crypto = require("crypto");

const FIELD_TYPES = Object.freeze([
  "text",
  "multiline",
  "integer",
  "decimal",
  "boolean",
  "select",
  "multi-select",
  "secret",
  "port",
  "file-path",
  "directory-path",
]);

const MINECRAFT_FIELDS = Object.freeze([
  field("server-port", "Server Port", "Network", "port", "25565", {
    description: "TCP port used by the Minecraft server.",
    min: 1,
    max: 65535,
    required: true,
    restartRequired: true,
  }),
  field("max-players", "Max Players", "Players", "integer", "20", {
    description: "Maximum number of players allowed online.",
    min: 1,
    max: 100000,
    required: true,
    restartRequired: true,
  }),
  field("difficulty", "Difficulty", "Gameplay", "select", "easy", {
    description: "World difficulty.",
    allowedValues: ["peaceful", "easy", "normal", "hard"],
    restartRequired: true,
  }),
  field("gamemode", "Game Mode", "Gameplay", "select", "survival", {
    description: "Default game mode for new players.",
    allowedValues: ["survival", "creative", "adventure", "spectator"],
    restartRequired: true,
  }),
  field("motd", "MOTD", "Identity", "text", "AnxOS Minecraft Server", {
    description: "Message shown in the server browser.",
  }),
  field("online-mode", "Online Mode", "Security", "boolean", "true", {
    description: "Verify player accounts with Mojang/Microsoft.",
    restartRequired: true,
  }),
  field("white-list", "Whitelist", "Security", "boolean", "false", {
    description: "Only allow players on the whitelist.",
  }),
  field("pvp", "PVP", "Gameplay", "boolean", "true", {
    description: "Allow player-versus-player combat.",
    restartRequired: true,
  }),
  field("view-distance", "View Distance", "Performance", "integer", "10", {
    description: "Chunks sent to each player.",
    min: 2,
    max: 32,
    restartRequired: true,
  }),
  field("simulation-distance", "Simulation Distance", "Performance", "integer", "10", {
    description: "Chunks around players that continue ticking.",
    min: 2,
    max: 32,
    restartRequired: true,
  }),
  field("spawn-protection", "Spawn Protection", "Gameplay", "integer", "16", {
    description: "Protected spawn radius in blocks.",
    min: 0,
    max: 100000,
  }),
  field("enable-command-block", "Command Blocks", "Advanced", "boolean", "false", {
    description: "Allow command blocks to run.",
    advanced: true,
    restartRequired: true,
  }),
  field("allow-flight", "Allow Flight", "Advanced", "boolean", "false", {
    description: "Permit flight when the server is not modded for it.",
    advanced: true,
  }),
  field("resource-pack", "Resource Pack URL", "Resource Pack", "text", "", {
    description: "Resource pack URL sent to players.",
    advanced: true,
  }),
  field("resource-pack-sha1", "Resource Pack SHA-1", "Resource Pack", "text", "", {
    description: "SHA-1 hash for the resource pack.",
    advanced: true,
    validation: { pattern: "^[a-fA-F0-9]{0,40}$" },
  }),
  field("resource-pack-prompt", "Resource Pack Prompt", "Resource Pack", "text", "", {
    description: "Prompt shown before downloading the resource pack.",
    advanced: true,
  }),
  field("require-resource-pack", "Require Resource Pack", "Resource Pack", "boolean", "false", {
    description: "Require players to accept the configured resource pack.",
    advanced: true,
  }),
]);

const PALWORLD_FIELDS = Object.freeze([
  field("ServerName", "Server Name", "Identity", "text", "AnxOS Palworld Server", {
    description: "Name shown for the dedicated server.",
    restartRequired: true,
  }),
  field("ServerDescription", "Description", "Identity", "multiline", "", {
    description: "Description shown to players.",
    restartRequired: true,
  }),
  field("ServerPassword", "Server Password", "Security", "secret", "", {
    description: "Password required to join the server.",
    sensitive: true,
    restartRequired: true,
  }),
  field("AdminPassword", "Admin Password", "Security", "secret", "", {
    description: "Password for administrator commands.",
    sensitive: true,
    restartRequired: true,
  }),
  field("PublicPort", "Game Port", "Network", "port", 8211, {
    description: "Public UDP game port.",
    min: 1,
    max: 65535,
    required: true,
    restartRequired: true,
  }),
  field("RCONPort", "RCON Port", "Network", "port", 25575, {
    description: "Remote console port.",
    min: 1,
    max: 65535,
    restartRequired: true,
    advanced: true,
  }),
  field("RCONEnabled", "RCON Enabled", "Network", "boolean", false, {
    description: "Enable remote console access.",
    restartRequired: true,
    advanced: true,
  }),
  field("ServerPlayerMaxNum", "Player Limit", "Players", "integer", 32, {
    description: "Maximum player count.",
    min: 1,
    max: 1000,
    required: true,
    restartRequired: true,
  }),
  field("Difficulty", "Difficulty", "Gameplay", "select", "None", {
    description: "Server difficulty preset.",
    allowedValues: ["None", "Normal", "Hard"],
    restartRequired: true,
  }),
  field("bIsPvP", "PVP", "Gameplay", "boolean", false, {
    description: "Allow player-versus-player combat.",
    restartRequired: true,
  }),
  field("bEnablePlayerToPlayerDamage", "Player Damage", "Gameplay", "boolean", false, {
    description: "Allow players to damage other players.",
    restartRequired: true,
    advanced: true,
  }),
  field("BackupSpan", "Backup Interval", "Backups", "decimal", 30.0, {
    description: "World backup interval in minutes.",
    min: 1,
    max: 1440,
    restartRequired: true,
    advanced: true,
  }),
  field("bIsStartLocationSelectByMap", "Map Spawn Select", "Advanced", "boolean", true, {
    description: "Allow players to select a start location on the map.",
    restartRequired: true,
    advanced: true,
  }),
]);

const FIVEM_FIELDS = Object.freeze([
  field("hostname", "Server Name", "Identity", "text", "AnxOS FiveM Server", {
    description: "Name shown in the FiveM server browser.",
    persistenceKey: "sv_hostname",
    required: true,
    restartRequired: true,
  }),
  field("maxClients", "Player Slots", "Players", "integer", 32, {
    description: "Maximum number of connected players.",
    persistenceKey: "sv_maxclients",
    min: 1,
    max: 2048,
    required: true,
    restartRequired: true,
  }),
  field("tcpEndpoint", "TCP Bind Endpoint", "Network", "text", "0.0.0.0:30120", {
    description: "Local TCP bind address and port, for example 0.0.0.0:30120.",
    persistenceKey: "endpoint_add_tcp",
    validation: { pattern: "^(?:[A-Za-z0-9:._-]+|\\[[0-9A-Fa-f:]+\\]):[0-9]{1,5}$" },
    required: true,
    restartRequired: true,
  }),
  field("udpEndpoint", "UDP Bind Endpoint", "Network", "text", "0.0.0.0:30120", {
    description: "Local UDP bind address and port, for example 0.0.0.0:30120.",
    persistenceKey: "endpoint_add_udp",
    validation: { pattern: "^(?:[A-Za-z0-9:._-]+|\\[[0-9A-Fa-f:]+\\]):[0-9]{1,5}$" },
    required: true,
    restartRequired: true,
  }),
  field("resources", "Enabled Resources", "Resources", "multiline", "mapmanager\nchat\nspawnmanager\nsessionmanager\nbasic-gamemode\nhardcap", {
    description: "One resource name per line. Each entry is persisted as an ensure command.",
    persistenceKey: "ensure",
    persistenceFormat: "repeated-command",
    validation: { pattern: "^(?:[A-Za-z0-9_.@/\\[\\]-]+(?:\\r?\\n|$))*$" },
    restartRequired: true,
  }),
  field("licenseKey", "Cfx.re License Key", "Security", "secret", "", {
    description: "FiveM server license key from Cfx.re Keymaster. Existing values are never returned to the renderer.",
    persistenceKey: "sv_licenseKey",
    sensitive: true,
    required: true,
    validation: { pattern: "^[A-Za-z0-9_-]{8,}$" },
    restartRequired: true,
  }),
]);

const ADAPTERS = Object.freeze({
  minecraft: Object.freeze({
    id: "minecraft",
    gameId: "minecraft",
    label: "Minecraft",
    format: "properties",
    defaultFilePath: "server.properties",
    fields: MINECRAFT_FIELDS,
  }),
  palworld: Object.freeze({
    id: "palworld",
    gameId: "palworld",
    label: "Palworld",
    format: "palworld-options",
    defaultFilePath: "server/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini",
    fields: PALWORLD_FIELDS,
  }),
  fivem: Object.freeze({
    id: "fivem",
    gameId: "fivem",
    label: "FiveM",
    format: "fivem-cfg",
    defaultFilePath: "server/server.cfg",
    fields: FIVEM_FIELDS,
  }),
});

function field(key, label, category, type, defaultValue, options = {}) {
  return Object.freeze({
    key,
    label,
    description: options.description || "",
    category,
    type,
    defaultValue,
    required: Boolean(options.required),
    min: options.min ?? null,
    max: options.max ?? null,
    allowedValues: options.allowedValues || null,
    validation: options.validation || null,
    advanced: Boolean(options.advanced),
    sensitive: Boolean(options.sensitive || type === "secret"),
    restartRequired: Boolean(options.restartRequired),
    persistence: Object.freeze({
      key: options.persistenceKey || key,
      format: options.persistenceFormat || null,
    }),
  });
}

function getAdapter(adapterId) {
  return ADAPTERS[String(adapterId || "").toLowerCase()] || null;
}

function hashContent(content) {
  return crypto.createHash("sha256").update(String(content ?? ""), "utf8").digest("hex");
}

function parsePropertiesDocument(content) {
  const text = String(content || "");
  const hadTrailingNewline = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (hadTrailingNewline) {
    lines.pop();
  }
  const entries = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return { type: "blank", raw: line };
    if (trimmed.startsWith("#") || trimmed.startsWith("!")) return { type: "comment", raw: line };
    const match = line.match(/^(\s*([^:=\s]+)\s*)([:=])(.*)$/);
    if (!match) return { type: "raw", raw: line };
    return {
      type: "entry",
      raw: line,
      prefix: match[1],
      key: match[2],
      separator: match[3],
      value: match[4].trimStart(),
    };
  });
  return { type: "properties", entries, trailingNewline: hadTrailingNewline || text.length === 0 };
}

function readPropertiesValues(document) {
  const values = {};
  for (const entry of document.entries || []) {
    if (entry.type === "entry") {
      values[entry.key] = entry.value;
    }
  }
  return values;
}

function serializePropertiesDocument(document, fields, values) {
  const fieldKeys = new Set(fields.map((item) => item.persistence.key));
  const seenKeys = new Set();
  const lastIndexes = new Map();
  (document.entries || []).forEach((entry, index) => {
    if (entry.type === "entry") lastIndexes.set(entry.key, index);
  });
  const lines = (document.entries || []).map((entry, index) => {
    if (entry.type !== "entry" || !fieldKeys.has(entry.key) || lastIndexes.get(entry.key) !== index) {
      return entry.raw;
    }
    seenKeys.add(entry.key);
    const fieldMeta = fields.find((candidate) => candidate.persistence.key === entry.key);
    return `${entry.prefix || entry.key}${entry.separator || "="}${serializeValueForFormat(fieldMeta, values[fieldMeta.key], "properties")}`;
  });

  for (const fieldMeta of fields) {
    if (!seenKeys.has(fieldMeta.persistence.key) && Object.prototype.hasOwnProperty.call(values, fieldMeta.key)) {
      lines.push(`${fieldMeta.persistence.key}=${serializeValueForFormat(fieldMeta, values[fieldMeta.key], "properties")}`);
    }
  }

  return `${lines.join("\n")}${document.trailingNewline ? "\n" : ""}`;
}

function parsePalworldDocument(content) {
  const text = String(content || "");
  const optionMatch = findOptionSettings(text);
  if (!optionMatch) {
    return {
      type: "palworld-options",
      prefix: "[/Script/Pal.PalGameWorldSettings]\nOptionSettings=(",
      suffix: ")\n",
      entries: [],
      missingOptionSettings: true,
    };
  }
  return {
    type: "palworld-options",
    prefix: text.slice(0, optionMatch.start),
    suffix: text.slice(optionMatch.end),
    entries: parsePalworldEntries(optionMatch.body),
    missingOptionSettings: false,
  };
}

function findOptionSettings(text) {
  const marker = "OptionSettings=(";
  const start = text.indexOf(marker);
  if (start < 0) return null;
  const bodyStart = start + marker.length;
  let depth = 1;
  let inQuote = false;
  let escaped = false;
  for (let index = bodyStart; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return {
          start: bodyStart,
          end: index,
          body: text.slice(bodyStart, index),
        };
      }
    }
  }
  return null;
}

function parsePalworldEntries(body) {
  const chunks = splitPalworldOptions(body);
  return chunks.map((raw) => {
    const index = raw.indexOf("=");
    if (index <= 0) return { type: "raw", raw };
    const key = raw.slice(0, index).trim();
    const rawValue = raw.slice(index + 1).trim();
    return {
      type: "entry",
      raw,
      key,
      rawValue,
      value: parsePalworldValue(rawValue),
    };
  });
}

function splitPalworldOptions(body) {
  const chunks = [];
  let start = 0;
  let inQuote = false;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (char === "," && depth === 0) {
      chunks.push(body.slice(start, index));
      start = index + 1;
    }
  }
  chunks.push(body.slice(start));
  return chunks.map((chunk) => chunk.trim()).filter(Boolean);
}

function parsePalworldValue(rawValue) {
  if (/^true$/i.test(rawValue)) return true;
  if (/^false$/i.test(rawValue)) return false;
  if (/^".*"$/.test(rawValue)) {
    return rawValue.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
  }
  if (/^-?\d+$/.test(rawValue)) return Number.parseInt(rawValue, 10);
  if (/^-?\d+\.\d+$/.test(rawValue)) return Number.parseFloat(rawValue);
  return rawValue;
}

function readPalworldValues(document) {
  const values = {};
  for (const entry of document.entries || []) {
    if (entry.type === "entry") {
      values[entry.key] = entry.value;
    }
  }
  return values;
}

function serializePalworldDocument(document, fields, values) {
  const fieldKeys = new Set(fields.map((item) => item.persistence.key));
  const seenKeys = new Set();
  const chunks = [];
  for (const entry of document.entries || []) {
    if (entry.type !== "entry" || !fieldKeys.has(entry.key)) {
      chunks.push(entry.raw);
      continue;
    }
    const fieldMeta = fields.find((candidate) => candidate.persistence.key === entry.key);
    seenKeys.add(entry.key);
    chunks.push(`${entry.key}=${serializeValueForFormat(fieldMeta, values[fieldMeta.key], "palworld-options")}`);
  }
  for (const fieldMeta of fields) {
    if (!seenKeys.has(fieldMeta.persistence.key) && Object.prototype.hasOwnProperty.call(values, fieldMeta.key)) {
      chunks.push(`${fieldMeta.persistence.key}=${serializeValueForFormat(fieldMeta, values[fieldMeta.key], "palworld-options")}`);
    }
  }
  return `${document.prefix}${chunks.join(",")}${document.suffix}`;
}

function parseFiveMCfgDocument(content) {
  const text = String(content || "");
  const hadTrailingNewline = /\r?\n$/.test(text);
  const lines = text.split(/\r?\n/);
  if (hadTrailingNewline) lines.pop();
  const entries = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return { type: "blank", raw: line };
    if (trimmed.startsWith("#") || trimmed.startsWith(";") || trimmed.startsWith("//")) {
      return { type: "comment", raw: line };
    }
    const match = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)(?:\s+)(.*?)(\s*)$/);
    if (!match) return { type: "raw", raw: line };
    return {
      type: "entry",
      raw: line,
      indent: match[1],
      key: match[2],
      rawValue: match[3],
      suffix: match[4],
      value: unquoteCfgValue(match[3]),
    };
  });
  return { type: "fivem-cfg", entries, trailingNewline: hadTrailingNewline || text.length === 0 };
}

function unquoteCfgValue(value) {
  const text = String(value ?? "").trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return text;
}

function readFiveMCfgValues(document, fields) {
  const values = {};
  for (const fieldMeta of fields) {
    const matches = (document.entries || []).filter((entry) => entry.type === "entry" && entry.key.toLowerCase() === fieldMeta.persistence.key.toLowerCase());
    if (fieldMeta.persistence.format === "repeated-command") {
      values[fieldMeta.persistence.key] = matches.map((entry) => entry.value).join("\n");
    } else if (matches.length > 0) {
      values[fieldMeta.persistence.key] = matches[matches.length - 1].value;
    }
  }
  return values;
}

function serializeFiveMCfgValue(fieldMeta, value) {
  const text = String(value ?? "");
  if (fieldMeta.type === "integer" || fieldMeta.type === "port") return String(Number.parseInt(text, 10));
  if (fieldMeta.persistence.format === "repeated-command") return text;
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ")}"`;
}

function serializeFiveMCfgDocument(document, fields, values) {
  const fieldsByPersistenceKey = new Map(fields.map((item) => [item.persistence.key.toLowerCase(), item]));
  const lastIndexes = new Map();
  (document.entries || []).forEach((entry, index) => {
    if (entry.type === "entry" && fieldsByPersistenceKey.has(entry.key.toLowerCase())) lastIndexes.set(entry.key.toLowerCase(), index);
  });
  const seen = new Set();
  const lines = [];
  (document.entries || []).forEach((entry, index) => {
    if (entry.type !== "entry") {
      lines.push(entry.raw);
      return;
    }
    const key = entry.key.toLowerCase();
    const fieldMeta = fieldsByPersistenceKey.get(key);
    if (!fieldMeta) {
      lines.push(entry.raw);
      return;
    }
    if (fieldMeta.persistence.format === "repeated-command") {
      if (seen.has(key)) return;
      seen.add(key);
      const resources = String(values[fieldMeta.key] ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      lines.push(...resources.map((resource) => `${entry.indent || ""}${fieldMeta.persistence.key} ${resource}`));
      return;
    }
    if (lastIndexes.get(key) !== index) {
      lines.push(entry.raw);
      return;
    }
    seen.add(key);
    lines.push(`${entry.indent || ""}${fieldMeta.persistence.key} ${serializeFiveMCfgValue(fieldMeta, values[fieldMeta.key])}${entry.suffix || ""}`);
  });
  for (const fieldMeta of fields) {
    const key = fieldMeta.persistence.key.toLowerCase();
    if (seen.has(key)) continue;
    if (fieldMeta.persistence.format === "repeated-command") {
      const resources = String(values[fieldMeta.key] ?? "").split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      lines.push(...resources.map((resource) => `${fieldMeta.persistence.key} ${resource}`));
    } else {
      lines.push(`${fieldMeta.persistence.key} ${serializeFiveMCfgValue(fieldMeta, values[fieldMeta.key])}`);
    }
  }
  return `${lines.join("\n")}${document.trailingNewline ? "\n" : ""}`;
}

function parseDocument(adapter, content) {
  if (adapter.format === "palworld-options") return parsePalworldDocument(content);
  if (adapter.format === "fivem-cfg") return parseFiveMCfgDocument(content);
  return parsePropertiesDocument(content);
}

function readDocumentValues(adapter, document) {
  if (adapter.format === "palworld-options") return readPalworldValues(document);
  if (adapter.format === "fivem-cfg") return readFiveMCfgValues(document, adapter.fields);
  return readPropertiesValues(document);
}

function serializeDocument(adapter, document, values) {
  if (adapter.format === "palworld-options") return serializePalworldDocument(document, adapter.fields, values);
  if (adapter.format === "fivem-cfg") return serializeFiveMCfgDocument(document, adapter.fields, values);
  return serializePropertiesDocument(document, adapter.fields, values);
}

function serializeValueForFormat(fieldMeta, value, format) {
  if (format === "palworld-options") {
    if (fieldMeta.type === "boolean") return value ? "True" : "False";
    if (fieldMeta.type === "integer" || fieldMeta.type === "port") return String(Number.parseInt(value, 10));
    if (fieldMeta.type === "decimal") return String(Number(value));
    return `"${String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r?\n/g, "\\n")}"`;
  }
  if (fieldMeta.type === "boolean") return value ? "true" : "false";
  if (fieldMeta.type === "multi-select") return Array.isArray(value) ? value.join(",") : String(value || "");
  return String(value ?? "");
}

function coerceFieldValue(fieldMeta, rawValue) {
  const value = rawValue ?? fieldMeta.defaultValue;
  if (fieldMeta.type === "boolean") {
    if (typeof value === "boolean") return value;
    return /^(true|1|yes|on)$/i.test(String(value));
  }
  if (fieldMeta.type === "integer" || fieldMeta.type === "port") {
    if (value === "") return "";
    return Number.parseInt(value, 10);
  }
  if (fieldMeta.type === "decimal") {
    if (value === "") return "";
    return Number(value);
  }
  if (fieldMeta.type === "multi-select") {
    if (Array.isArray(value)) return value.map(String);
    return String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  }
  return String(value ?? "");
}

function validateValues(adapter, values) {
  const errors = {};
  const allowedTypes = new Set(FIELD_TYPES);
  const fieldsByKey = new Map(adapter.fields.map((fieldMeta) => [fieldMeta.key, fieldMeta]));
  for (const key of Object.keys(values || {})) {
    if (!fieldsByKey.has(key)) {
      errors[key] = "Unknown setting.";
    }
  }
  for (const fieldMeta of adapter.fields) {
    const value = values[fieldMeta.key];
    if (!allowedTypes.has(fieldMeta.type)) {
      errors[fieldMeta.key] = "Unsupported setting type.";
      continue;
    }
    if (fieldMeta.required && (value === null || value === undefined || value === "")) {
      errors[fieldMeta.key] = "This setting is required.";
      continue;
    }
    if (value === null || value === undefined || value === "") continue;
    if (["integer", "port"].includes(fieldMeta.type)) {
      const number = Number(value);
      if (!Number.isInteger(number)) {
        errors[fieldMeta.key] = "Enter a whole number.";
        continue;
      }
      if (fieldMeta.type === "port" && (number < 1 || number > 65535)) {
        errors[fieldMeta.key] = "Enter a port from 1 to 65535.";
        continue;
      }
      if (fieldMeta.min !== null && number < fieldMeta.min) errors[fieldMeta.key] = `Minimum value is ${fieldMeta.min}.`;
      if (fieldMeta.max !== null && number > fieldMeta.max) errors[fieldMeta.key] = `Maximum value is ${fieldMeta.max}.`;
    }
    if (fieldMeta.type === "decimal") {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        errors[fieldMeta.key] = "Enter a number.";
        continue;
      }
      if (fieldMeta.min !== null && number < fieldMeta.min) errors[fieldMeta.key] = `Minimum value is ${fieldMeta.min}.`;
      if (fieldMeta.max !== null && number > fieldMeta.max) errors[fieldMeta.key] = `Maximum value is ${fieldMeta.max}.`;
    }
    if (fieldMeta.allowedValues && fieldMeta.type === "select" && !fieldMeta.allowedValues.includes(String(value))) {
      errors[fieldMeta.key] = "Choose an allowed value.";
    }
    if (fieldMeta.allowedValues && fieldMeta.type === "multi-select") {
      const invalid = (Array.isArray(value) ? value : []).find((item) => !fieldMeta.allowedValues.includes(String(item)));
      if (invalid) errors[fieldMeta.key] = "Choose allowed values only.";
    }
    if (["file-path", "directory-path"].includes(fieldMeta.type) && (String(value).includes("..") || /^[a-z]:[\\/]/i.test(String(value)) || String(value).startsWith("/") || String(value).startsWith("\\"))) {
      errors[fieldMeta.key] = "Use a relative path inside the instance.";
    }
    if (fieldMeta.validation?.pattern) {
      const pattern = new RegExp(fieldMeta.validation.pattern);
      if (!pattern.test(String(value))) {
        errors[fieldMeta.key] = "Value does not match the required format.";
      }
    }
  }
  return {
    ok: Object.keys(errors).length === 0,
    errors,
  };
}

function buildConfigModel(adapterId, content, options = {}) {
  const adapter = getAdapter(adapterId);
  if (!adapter) {
    return { supported: false, reason: "unsupported_game" };
  }
  const document = parseDocument(adapter, content);
  const rawValues = readDocumentValues(adapter, document);
  const values = {};
  const fields = adapter.fields.map((fieldMeta) => {
    const currentValue = coerceFieldValue(fieldMeta, rawValues[fieldMeta.persistence.key]);
    values[fieldMeta.key] = currentValue;
    return {
      ...fieldMeta,
      currentValue: fieldMeta.sensitive ? "" : currentValue,
      hasCurrentValue: fieldMeta.sensitive ? String(rawValues[fieldMeta.persistence.key] ?? "").length > 0 : currentValue !== "",
      redacted: Boolean(fieldMeta.sensitive),
      modified: false,
    };
  });
  return {
    supported: true,
    adapterId: adapter.id,
    gameId: adapter.gameId,
    label: adapter.label,
    format: adapter.format,
    filePath: options.filePath || adapter.defaultFilePath,
    sourceHash: hashContent(content),
    modifiedAt: options.modifiedAt || null,
    missing: Boolean(options.missing),
    fields,
    categories: [...new Set(fields.map((item) => item.category))],
    values: redactValues(adapter, values),
    capabilities: {
      save: true,
      saveAndRestart: true,
      rawFilePath: options.filePath || adapter.defaultFilePath,
    },
  };
}

function mergeSubmittedValues(adapter, content, submittedValues = {}) {
  const document = parseDocument(adapter, content);
  const rawValues = readDocumentValues(adapter, document);
  const nextValues = {};
  for (const fieldMeta of adapter.fields) {
    const current = coerceFieldValue(fieldMeta, rawValues[fieldMeta.persistence.key]);
    const submitted = Object.prototype.hasOwnProperty.call(submittedValues, fieldMeta.key)
      ? submittedValues[fieldMeta.key]
      : current;
    nextValues[fieldMeta.key] = coerceFieldValue(fieldMeta, submitted);
  }
  return {
    document,
    values: nextValues,
    validation: validateValues(adapter, nextValues),
  };
}

function redactValues(adapter, values) {
  const redacted = {};
  for (const fieldMeta of adapter.fields) {
    const value = values[fieldMeta.key];
    redacted[fieldMeta.key] = fieldMeta.sensitive
      ? (String(value ?? "").length > 0 ? "[REDACTED]" : "")
      : value;
  }
  return redacted;
}

function redactPayload(adapterId, payload = {}) {
  const adapter = getAdapter(adapterId);
  if (!adapter) return payload;
  const clone = JSON.parse(JSON.stringify(payload || {}));
  for (const fieldMeta of adapter.fields) {
    if (fieldMeta.sensitive && clone.values && Object.prototype.hasOwnProperty.call(clone.values, fieldMeta.key)) {
      clone.values[fieldMeta.key] = "[REDACTED]";
    }
  }
  return clone;
}

module.exports = {
  ADAPTERS,
  FIELD_TYPES,
  buildConfigModel,
  getAdapter,
  hashContent,
  mergeSubmittedValues,
  parseFiveMCfgDocument,
  parsePalworldDocument,
  parsePropertiesDocument,
  redactPayload,
  redactValues,
  serializeDocument,
  validateValues,
  _test: {
    findOptionSettings,
    parsePalworldValue,
    readDocumentValues,
    splitPalworldOptions,
  },
};
