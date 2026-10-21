"use strict";

/**
 * Endpoint model shared by the AnxOS Control Center main and renderer layers.
 *
 * Endpoint type semantics:
 * - "lan":       reachable on the local network segment (same LAN as the operator machine).
 * - "private":   reachable through private address space only (RFC1918, link-local, CGNAT);
 *                not necessarily on the local segment.
 * - "tailscale": reachable over a Tailscale tailnet (100.64/10 address or MagicDNS name);
 *                access depends on tailnet membership.
 * - "public":    reachable from the public internet; treat public exposure as hostile.
 * - "custom":    user-defined classification that does not fit the types above.
 *
 * Contract: endpoint records and their metadata are addressing/routing data only. They must
 * NEVER contain credentials, tokens, passwords, API keys, connection strings with embedded
 * secrets, or any other secret material. Secrets belong in secure storage, never in endpoint
 * records.
 *
 * This module is pure: it requires only node:crypto and stays free of electron, fs, and
 * src/services dependencies so every layer can load it. The optional `existing` argument of
 * validateEndpointInput is reserved for future update flows and does not affect validation.
 */

const crypto = require("node:crypto");

const ENDPOINT_TYPES = Object.freeze(["lan", "private", "tailscale", "public", "custom"]);
const ENDPOINT_PROTOCOLS = Object.freeze(["tcp", "udp", "http", "https"]);
const ENDPOINT_SOURCES = Object.freeze(["discovered", "manual", "provider"]);
const ENDPOINT_TYPE_LABELS = Object.freeze({
  lan: "LAN",
  private: "Private",
  tailscale: "Tailscale",
  public: "Public",
  custom: "Custom",
});

const MAX_ENDPOINT_NAME_LENGTH = 120;
const MAX_HOST_LENGTH = 253;
const MAX_NOTES_LENGTH = 500;
const MAX_METADATA_KEYS = 24;
const MAX_METADATA_VALUE_LENGTH = 300;

const SORT_TYPE_ORDER = Object.freeze(["private", "lan", "tailscale", "public", "custom"]);
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SERVICE_ID_PATTERN = /^[A-Za-z0-9._-]{1,120}$/;
const HOSTNAME_LABEL_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const IPV4_SEGMENT_PATTERN = /^\d{1,3}$/;
const IPV6_GROUP_PATTERN = /^[0-9A-Fa-f]{1,4}$/;
const HOST_REJECT_PATTERN = /[\s\u0000-\u001f\u007f\/\\;&|<>(){}[\]$`'"!*?~^=,]/;

function makeError(field, code, message) {
  return { field, code, message };
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function setOwnProperty(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function parseIPv4(raw) {
  if (typeof raw !== "string") return null;
  const parts = raw.split(".");
  if (parts.length !== 4) return null;
  const octets = [];
  for (const part of parts) {
    if (!IPV4_SEGMENT_PATTERN.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
}

function parseIPv6Groups(parts, allowTrailingIPv4) {
  const values = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (IPV6_GROUP_PATTERN.test(part)) {
      values.push(parseInt(part, 16));
      continue;
    }
    const isLast = index === parts.length - 1;
    if (allowTrailingIPv4 && isLast && part.indexOf(".") !== -1) {
      const octets = parseIPv4(part);
      if (!octets) return null;
      values.push((octets[0] << 8) | octets[1]);
      values.push((octets[2] << 8) | octets[3]);
      continue;
    }
    return null;
  }
  return values;
}

function parseIPv6(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 60) return null;
  if (raw.indexOf("%") !== -1) return null;

  const compressionCount = raw.split("::").length - 1;
  if (compressionCount > 1) return null;
  const hasCompression = compressionCount === 1;

  let headParts = [];
  let tailParts = [];
  if (hasCompression) {
    const boundary = raw.indexOf("::");
    const head = raw.slice(0, boundary);
    const tail = raw.slice(boundary + 2);
    if (head !== "") headParts = head.split(":");
    if (tail !== "") tailParts = tail.split(":");
  } else {
    headParts = raw.split(":");
  }

  const headValues = parseIPv6Groups(headParts, !hasCompression);
  if (!headValues) return null;
  const tailValues = parseIPv6Groups(tailParts, true);
  if (!tailValues) return null;

  if (!hasCompression) {
    return headValues.length === 8 ? headValues : null;
  }
  if (headValues.length + tailValues.length > 7) return null;

  const groups = new Array(8).fill(0);
  for (let index = 0; index < headValues.length; index += 1) groups[index] = headValues[index];
  for (let index = 0; index < tailValues.length; index += 1) {
    groups[8 - tailValues.length + index] = tailValues[index];
  }
  return groups;
}

function normalizeEndpointHost(rawHost) {
  if (rawHost === undefined || rawHost === null) return { ok: false, code: "ENDPOINT_HOST_REQUIRED" };
  if (typeof rawHost !== "string") return { ok: false, code: "ENDPOINT_HOST_INVALID" };

  let host = rawHost.trim();
  if (host === "") return { ok: false, code: "ENDPOINT_HOST_REQUIRED" };

  let wasBracketed = false;
  if (host.startsWith("[")) {
    if (!host.endsWith("]") || host.length < 3) return { ok: false, code: "ENDPOINT_HOST_INVALID" };
    host = host.slice(1, -1).trim();
    if (host === "") return { ok: false, code: "ENDPOINT_HOST_INVALID" };
    wasBracketed = true;
  } else if (host.endsWith("]")) {
    return { ok: false, code: "ENDPOINT_HOST_INVALID" };
  }

  if (HOST_REJECT_PATTERN.test(host)) return { ok: false, code: "ENDPOINT_HOST_INVALID" };
  if (host.startsWith("-")) return { ok: false, code: "ENDPOINT_HOST_INVALID" };

  if (wasBracketed) {
    return parseIPv6(host) ? { ok: true, host } : { ok: false, code: "ENDPOINT_HOST_INVALID" };
  }

  if (host.endsWith(".") && host.indexOf(":") === -1) host = host.slice(0, -1);
  if (host === "") return { ok: false, code: "ENDPOINT_HOST_INVALID" };

  if (parseIPv4(host)) return { ok: true, host };

  if (host.indexOf(":") !== -1) {
    return parseIPv6(host) ? { ok: true, host } : { ok: false, code: "ENDPOINT_HOST_INVALID" };
  }

  if (host.length > MAX_HOST_LENGTH) return { ok: false, code: "ENDPOINT_HOST_TOO_LONG" };

  const labels = host.split(".");
  if (labels.length === 0 || !labels.every((label) => HOSTNAME_LABEL_PATTERN.test(label))) {
    return { ok: false, code: "ENDPOINT_HOST_INVALID" };
  }

  if (/[A-Za-z]/.test(host)) host = host.toLowerCase();
  return { ok: true, host };
}

function stringifyTrimmed(value) {
  return String(value).trim();
}

function normalizeEndpointPort(rawPort) {
  if (rawPort === undefined || rawPort === null) return { ok: true, value: null };
  let port = rawPort;
  if (typeof port === "string") {
    const text = port.trim();
    if (!/^\d+$/.test(text)) return { ok: false };
    port = Number(text);
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false };
  }
  return { ok: true, value: port };
}

function validateMetadata(rawMetadata) {
  if (rawMetadata === undefined || rawMetadata === null) return { ok: true, value: {} };
  if (!isPlainObject(rawMetadata)) return { ok: false };
  const keys = Object.keys(rawMetadata);
  if (keys.length > MAX_METADATA_KEYS) return { ok: false };
  const metadata = {};
  for (const key of keys) {
    const value = rawMetadata[key];
    if (value === null || typeof value === "boolean") {
      setOwnProperty(metadata, key, value);
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      setOwnProperty(metadata, key, value);
      continue;
    }
    if (typeof value === "string" && value.length <= MAX_METADATA_VALUE_LENGTH) {
      setOwnProperty(metadata, key, value);
      continue;
    }
    return { ok: false };
  }
  return { ok: true, value: metadata };
}

function normalizeMetadata(rawMetadata) {
  if (!isPlainObject(rawMetadata)) return {};
  const metadata = {};
  let count = 0;
  for (const key of Object.keys(rawMetadata)) {
    if (count >= MAX_METADATA_KEYS) break;
    let value;
    try {
      value = rawMetadata[key];
    } catch {
      continue;
    }
    if (value === null || typeof value === "boolean") {
      setOwnProperty(metadata, key, value);
      count += 1;
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      setOwnProperty(metadata, key, value);
      count += 1;
      continue;
    }
    if (typeof value === "string") {
      setOwnProperty(metadata, key, value.slice(0, MAX_METADATA_VALUE_LENGTH));
      count += 1;
    }
  }
  return metadata;
}

function normalizeTimestamp(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function normalizeOptionalId(value, pattern) {
  if (value === undefined || value === null) return null;
  const text = typeof value === "string" ? value.trim() : String(value).trim();
  return pattern.test(text) ? text : null;
}

function jsonSafeClone(value, depth) {
  const level = typeof depth === "number" ? depth : 0;
  if (level > 8) return null;
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return value;
  if (type === "number") return Number.isFinite(value) ? value : null;
  if (type === "bigint") return value.toString();
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) {
      const cloned = jsonSafeClone(item, level + 1);
      items.push(cloned === undefined ? null : cloned);
    }
    return items;
  }
  if (type === "object") {
    const output = {};
    for (const key of Object.keys(value)) {
      const cloned = jsonSafeClone(value[key], level + 1);
      if (cloned !== undefined) setOwnProperty(output, key, cloned);
    }
    return output;
  }
  return undefined;
}

function hostErrorMessage(code) {
  if (code === "ENDPOINT_HOST_REQUIRED") return "Endpoint host is required.";
  if (code === "ENDPOINT_HOST_TOO_LONG") return `Endpoint host must be at most ${MAX_HOST_LENGTH} characters.`;
  return "Endpoint host must be a valid IPv4 address, IPv6 address, or DNS hostname.";
}

function validateEndpointInput(input, options = {}) {
  // options.existing is reserved for update-flow call sites; validation is stateless today.
  const existing = options && typeof options === "object" ? options.existing : null;
  void existing;

  const errors = [];
  const raw = isPlainObject(input) ? input : {};

  let name = "";
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    errors.push(makeError("name", "ENDPOINT_NAME_REQUIRED", "Endpoint name is required."));
  } else {
    name = raw.name.trim();
    if (name.length > MAX_ENDPOINT_NAME_LENGTH) {
      errors.push(makeError("name", "ENDPOINT_NAME_TOO_LONG", `Endpoint name must be at most ${MAX_ENDPOINT_NAME_LENGTH} characters.`));
    }
  }

  let type = null;
  if (!ENDPOINT_TYPES.includes(raw.type)) {
    errors.push(makeError("type", "ENDPOINT_TYPE_INVALID", `Endpoint type must be one of: ${ENDPOINT_TYPES.join(", ")}.`));
  } else {
    type = raw.type;
  }

  let source = "manual";
  if (raw.source !== undefined && raw.source !== null) {
    if (ENDPOINT_SOURCES.includes(raw.source)) source = raw.source;
    else errors.push(makeError("source", "ENDPOINT_SOURCE_INVALID", `Endpoint source must be one of: ${ENDPOINT_SOURCES.join(", ")}.`));
  }

  let host = null;
  const hostResult = normalizeEndpointHost(raw.host);
  if (hostResult.ok) host = hostResult.host;
  else errors.push(makeError("host", hostResult.code, hostErrorMessage(hostResult.code)));

  let port = null;
  const portResult = normalizeEndpointPort(raw.port);
  if (portResult.ok) port = portResult.value;
  else errors.push(makeError("port", "ENDPOINT_PORT_INVALID", "Endpoint port must be an integer between 1 and 65535."));

  let protocol = null;
  if (raw.protocol !== undefined && raw.protocol !== null) {
    if (ENDPOINT_PROTOCOLS.includes(raw.protocol)) protocol = raw.protocol;
    else errors.push(makeError("protocol", "ENDPOINT_PROTOCOL_INVALID", `Endpoint protocol must be one of: ${ENDPOINT_PROTOCOLS.join(", ")}.`));
  }

  let providerId = null;
  if (raw.providerId !== undefined && raw.providerId !== null) {
    if (typeof raw.providerId === "string" && PROVIDER_ID_PATTERN.test(raw.providerId)) providerId = raw.providerId;
    else errors.push(makeError("providerId", "ENDPOINT_PROVIDER_INVALID", "Provider id must match [a-z0-9][a-z0-9-]{0,63}."));
  }

  let serviceId = null;
  if (raw.serviceId !== undefined && raw.serviceId !== null) {
    if (typeof raw.serviceId === "string" && SERVICE_ID_PATTERN.test(raw.serviceId)) serviceId = raw.serviceId;
    else errors.push(makeError("serviceId", "ENDPOINT_SERVICE_INVALID", "Service id must match [A-Za-z0-9._-]{1,120}."));
  }

  let computerId = null;
  if (raw.computerId !== undefined && raw.computerId !== null) {
    if (typeof raw.computerId === "string" && SERVICE_ID_PATTERN.test(raw.computerId)) computerId = raw.computerId;
    else errors.push(makeError("computerId", "ENDPOINT_COMPUTER_INVALID", "Computer id must match [A-Za-z0-9._-]{1,120}."));
  }

  let notes = "";
  if (raw.notes !== undefined && raw.notes !== null) {
    notes = stringifyTrimmed(raw.notes);
    if (notes.length > MAX_NOTES_LENGTH) {
      errors.push(makeError("notes", "ENDPOINT_NOTES_TOO_LONG", `Endpoint notes must be at most ${MAX_NOTES_LENGTH} characters.`));
    }
  }

  let enabled = true;
  if (raw.enabled !== undefined && raw.enabled !== null) {
    if (typeof raw.enabled === "boolean") enabled = raw.enabled;
    else errors.push(makeError("enabled", "ENDPOINT_ENABLED_INVALID", "Endpoint enabled flag must be a boolean."));
  }

  let metadata = {};
  const metadataResult = validateMetadata(raw.metadata);
  if (metadataResult.ok) metadata = metadataResult.value;
  else {
    errors.push(
      makeError(
        "metadata",
        "ENDPOINT_METADATA_INVALID",
        `Endpoint metadata must be a flat object with at most ${MAX_METADATA_KEYS} keys and string/number/boolean/null values.`
      )
    );
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: { name, type, host, port, protocol, enabled, providerId, serviceId, computerId, source, notes, metadata },
  };
}

function buildEndpointId(parts) {
  const source = isPlainObject(parts) ? parts : {};
  const components = [source.computerId, source.type, source.host, source.port, source.protocol, source.serviceId, source.name].map(
    (part) => (part === undefined || part === null ? "" : String(part))
  );
  const digest = crypto.createHash("sha256").update(components.join("|"), "utf8").digest("hex");
  return `ep-${digest.slice(0, 16)}`;
}

function endpointKey(endpoint) {
  const record = isPlainObject(endpoint) ? endpoint : {};
  const computerId = record.computerId || "";
  const type = record.type || "";
  const host = record.host || "";
  const port = record.port ?? "";
  const protocol = record.protocol || "";
  const serviceId = record.serviceId || "";
  return `${computerId}|${type}|${host}|${port}|${protocol}|${serviceId}`;
}

// What a diagnostics run of this endpoint depends on: its target
// (endpointKey) plus the provider binding the provider stage reads. Kept
// separate from endpointKey, which also de-duplicates stored records, where a
// provider change must not make a second record. (name/label only feed the
// displayed label; enabled is handled as a selection change.)
function diagnosticsTargetKey(endpoint) {
  const record = isPlainObject(endpoint) ? endpoint : {};
  const providerId = typeof record.providerId === "string" ? record.providerId.trim() : "";
  return `${endpointKey(record)}|${providerId}`;
}

function formatEndpointAddress(endpoint) {
  const record = isPlainObject(endpoint) ? endpoint : {};
  let host = typeof record.host === "string" ? record.host.trim() : "";
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  const hasPort = record.port !== undefined && record.port !== null && record.port !== "";
  if (!hasPort) return host;
  const port = String(record.port);
  if (host.indexOf(":") !== -1) return `[${host}]:${port}`;
  return `${host}:${port}`;
}

function normalizeEndpointRecord(record) {
  try {
    if (!isPlainObject(record)) return null;

    const hostResult = normalizeEndpointHost(record.host);
    if (!hostResult.ok) return null;

    const host = hostResult.host;
    const type = ENDPOINT_TYPES.includes(record.type) ? record.type : "custom";
    const name = typeof record.name === "string" ? record.name.trim().slice(0, MAX_ENDPOINT_NAME_LENGTH) : "";
    const portResult = normalizeEndpointPort(record.port);
    const port = portResult.ok ? portResult.value : null;
    const protocol = ENDPOINT_PROTOCOLS.includes(record.protocol) ? record.protocol : null;
    const providerId =
      typeof record.providerId === "string" && PROVIDER_ID_PATTERN.test(record.providerId) ? record.providerId : null;
    const serviceId = normalizeOptionalId(record.serviceId, SERVICE_ID_PATTERN);
    const computerId = normalizeOptionalId(record.computerId, SERVICE_ID_PATTERN);
    const source = ENDPOINT_SOURCES.includes(record.source) ? record.source : "manual";
    const notes = typeof record.notes === "string" ? record.notes.slice(0, MAX_NOTES_LENGTH) : "";
    const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
    const metadata = normalizeMetadata(record.metadata);
    const id =
      typeof record.id === "string" && record.id.trim() !== ""
        ? record.id
        : buildEndpointId({ computerId, type, host, port, protocol, serviceId, name });
    const health = record.health === undefined ? null : record.health;
    const lastCheckedAt = normalizeTimestamp(record.lastCheckedAt);
    const createdAt = normalizeTimestamp(record.createdAt);
    const updatedAt = normalizeTimestamp(record.updatedAt);

    return {
      id,
      name,
      type,
      host,
      port,
      protocol,
      enabled,
      providerId,
      serviceId,
      computerId,
      source,
      notes,
      metadata,
      health,
      lastCheckedAt,
      createdAt,
      updatedAt,
    };
  } catch {
    return null;
  }
}

function describeEndpointType(type) {
  return Object.prototype.hasOwnProperty.call(ENDPOINT_TYPE_LABELS, type) ? ENDPOINT_TYPE_LABELS[type] : "Custom";
}

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function textOf(value) {
  return value === undefined || value === null ? "" : String(value);
}

function typeRank(type) {
  const index = SORT_TYPE_ORDER.indexOf(type);
  return index === -1 ? SORT_TYPE_ORDER.length : index;
}

function sortEndpoints(list) {
  if (!Array.isArray(list)) return [];
  const items = list.map((endpoint, index) => ({ endpoint, index }));
  items.sort((left, right) => {
    const a = isPlainObject(left.endpoint) ? left.endpoint : {};
    const b = isPlainObject(right.endpoint) ? right.endpoint : {};
    const byComputerId = compareStrings(textOf(a.computerId), textOf(b.computerId));
    if (byComputerId !== 0) return byComputerId;
    const byServiceId = compareStrings(textOf(a.serviceId), textOf(b.serviceId));
    if (byServiceId !== 0) return byServiceId;
    const byType = typeRank(a.type) - typeRank(b.type);
    if (byType !== 0) return byType;
    const byName = compareStrings(textOf(a.name).toLowerCase(), textOf(b.name).toLowerCase());
    if (byName !== 0) return byName;
    const byId = compareStrings(textOf(a.id), textOf(b.id));
    if (byId !== 0) return byId;
    return left.index - right.index;
  });
  return items.map((item) => item.endpoint);
}

function publicEndpointView(endpoint) {
  if (!isPlainObject(endpoint)) return null;
  try {
    const portResult = normalizeEndpointPort(endpoint.port);
    const health = endpoint.health === undefined ? null : jsonSafeClone(endpoint.health);
    return {
      id: typeof endpoint.id === "string" && endpoint.id !== "" ? endpoint.id : null,
      name: typeof endpoint.name === "string" ? endpoint.name : "",
      type: ENDPOINT_TYPES.includes(endpoint.type) ? endpoint.type : "custom",
      host: typeof endpoint.host === "string" ? endpoint.host : "",
      port: portResult.ok ? portResult.value : null,
      protocol: ENDPOINT_PROTOCOLS.includes(endpoint.protocol) ? endpoint.protocol : null,
      enabled: typeof endpoint.enabled === "boolean" ? endpoint.enabled : true,
      providerId:
        typeof endpoint.providerId === "string" && PROVIDER_ID_PATTERN.test(endpoint.providerId) ? endpoint.providerId : null,
      serviceId: normalizeOptionalId(endpoint.serviceId, SERVICE_ID_PATTERN),
      computerId: normalizeOptionalId(endpoint.computerId, SERVICE_ID_PATTERN),
      source: ENDPOINT_SOURCES.includes(endpoint.source) ? endpoint.source : "manual",
      notes: typeof endpoint.notes === "string" ? endpoint.notes : "",
      metadata: normalizeMetadata(endpoint.metadata),
      health: health === undefined ? null : health,
      lastCheckedAt: normalizeTimestamp(endpoint.lastCheckedAt),
      createdAt: normalizeTimestamp(endpoint.createdAt),
      updatedAt: normalizeTimestamp(endpoint.updatedAt),
    };
  } catch {
    return null;
  }
}

function normalizeClassificationHost(host) {
  if (typeof host !== "string") return "";
  let value = host.trim().toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  if (value.endsWith(".") && value.indexOf(":") === -1) value = value.slice(0, -1);
  return value;
}

function isLoopbackHost(host) {
  const value = normalizeClassificationHost(host);
  if (value === "") return false;
  if (value === "localhost") return true;
  const octets = parseIPv4(value);
  if (octets) return octets[0] === 127;
  const groups = parseIPv6(value);
  if (groups) return groups.every((group, index) => (index === 7 ? group === 1 : group === 0));
  return false;
}

function isPrivateHost(host) {
  const value = normalizeClassificationHost(host);
  if (value === "") return false;
  const octets = parseIPv4(value);
  if (!octets) return false;
  const first = octets[0];
  const second = octets[1];
  if (first === 10) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  return false;
}

module.exports = {
  ENDPOINT_TYPES,
  ENDPOINT_PROTOCOLS,
  ENDPOINT_SOURCES,
  ENDPOINT_TYPE_LABELS,
  MAX_ENDPOINT_NAME_LENGTH,
  MAX_HOST_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_METADATA_KEYS,
  MAX_METADATA_VALUE_LENGTH,
  validateEndpointInput,
  buildEndpointId,
  endpointKey,
  diagnosticsTargetKey,
  formatEndpointAddress,
  normalizeEndpointRecord,
  describeEndpointType,
  sortEndpoints,
  publicEndpointView,
  isLoopbackHost,
  isPrivateHost,
};
