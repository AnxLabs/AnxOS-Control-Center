"use strict";

// Provider-adapter contract, machine-checkable half.
//
// Public Access today is Playit plus manual port forwarding. The provider
// surface is moving behind one adapter contract, so a future provider (another
// tunnel service, a relay, ...) can be evaluated the same way Playit is. The
// rule that makes that possible is "one canonical provider shape":
//
//   every provider adapter maps its provider-specific detection snapshot into
//   the single canonical provider state produced by normalizeProviderState();
//   consumers read only that canonical shape and never provider-specific
//   fields.
//
// A provider adapter declares which capabilities it has (a boolean table) and
// must implement a function for each capability it declares true. Only four
// capabilities carry behaviour at this seam: detect() and status() return a
// canonical provider state, listTunnels() returns canonical tunnels, and
// endpointDiscovery() turns one canonical tunnel into an endpoint-model input.
// The remaining capabilities are descriptive booleans: they say whether
// publicAddress / localTarget / region are meaningful for this provider, or
// whether an agent control channel or provider-side tunnel create/delete
// exists. An adapter must never claim a capability it does not have.
//
// This file must stay dependency-free: Electron Builder copies src/shared/**/*
// into the standalone agent runtime, so no require into src/services, no
// Electron, no fs and no network. Only the sibling redaction module is used,
// for its sensitive-key regex and its shared string redactor.
// scripts/provider-adapter-contract-smoke.js keeps the adapters, this
// vocabulary and their capability tables honest.

const { SENSITIVE_KEY, redactString } = require("./redaction");

const CONTRACT_VERSION = 1;

const PROVIDER_CAPABILITY_IDS = Object.freeze([
  "detect",
  "status",
  "listTunnels",
  "controlAgent",
  "publicAddress",
  "localTarget",
  "region",
  "endpointDiscovery",
  "createTunnel",
  "deleteTunnel",
]);

const PROVIDER_STATES = Object.freeze([
  "running",
  "stopped",
  "not-installed",
  "auth-required",
  "setup-required",
  "degraded",
  "unsupported",
  "unknown",
]);

const PROVIDER_AVAILABILITY = Object.freeze([
  "available",
  "unavailable",
  "unknown",
]);

const TUNNEL_PROTOCOLS = Object.freeze([
  "tcp",
  "udp",
  "http",
  "https",
]);

const SENSITIVE_FIELD_DENYLIST = Object.freeze([
  "token",
  "secret",
  "password",
  "credential",
  "apiKey",
  "api_key",
  "auth",
  "authorization",
  "privateKey",
  "refreshToken",
  "accessToken",
]);

// The only capabilities that require an adapter function. Everything else in
// PROVIDER_CAPABILITY_IDS is a descriptive boolean checked by
// validateProviderAdapter().
const FUNCTIONAL_CAPABILITIES = Object.freeze([
  "detect",
  "status",
  "listTunnels",
  "endpointDiscovery",
]);

const MAX_DIAGNOSTICS = 8;
const MAX_DIAGNOSTIC_CODE_LENGTH = 120;
const MAX_DIAGNOSTIC_MESSAGE_LENGTH = 500;
const MAX_STRING_LENGTH = 2000;
const MAX_STRIP_DEPTH = 8;
const MAX_ARRAY_ENTRIES = 200;
const MAX_DIAGNOSTIC_TEXT_ENTRIES = 50;

// Adapter ids are lowercase slugs: letters, digits and dashes, starting with a
// letter. This keeps ids safe to use as object keys on every consumer side.
const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

// A value that looks like an inline credential assignment is treated as
// entirely sensitive. Replacing only the matched prefix would leave the secret
// value in place, so the whole value becomes "[redacted]".
const SECRET_VALUE_PATTERN = /(token|secret|passwd|password|api[_-]?key)\s*[:=]/i;

const DENYLIST_COMPACT = Object.freeze(
  SENSITIVE_FIELD_DENYLIST.map((entry) => entry.toLowerCase().replace(/[^a-z0-9]/g, "")),
);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// A key is stripped when it matches the contract denylist (case-insensitive,
// ignoring separators) or the shared redaction sensitive-key regex, which is a
// strict superset (covers session, cookie, ciphertext, ...). Stripping more is
// safe here: a sensitive value must never survive into the canonical state.
function isDenylistedKey(key) {
  const text = String(key).toLowerCase();
  if (SENSITIVE_KEY.test(text)) return true;
  const compact = text.replace(/[^a-z0-9]/g, "");
  if (!compact) return false;
  return DENYLIST_COMPACT.some((entry) => compact.includes(entry));
}

function scrubString(value) {
  const text = String(value);
  // An inline credential assignment is replaced whole: redacting only the
  // matched prefix would leave the secret value in place.
  if (SECRET_VALUE_PATTERN.test(text)) return "[redacted]";
  // Everything else goes through the shared repo redactor so free-text
  // diagnostics cannot carry a Bearer token, JWT, private key, URL credential,
  // private path or large base64 blob into the canonical provider state.
  const redacted = redactString(text);
  return redacted.length > MAX_STRING_LENGTH ? redacted.slice(0, MAX_STRING_LENGTH) : redacted;
}

// Recursively drops denylisted keys and scrubs string values before any
// mapping sees the raw input. Tolerates circular structures (dropped) and
// bounds depth, array length and string length.
function stripSensitive(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return scrubString(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object") return null;
  if (depth >= MAX_STRIP_DEPTH) return null;
  if (seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ENTRIES).map((entry) => stripSensitive(entry, depth + 1, seen));
  }
  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isDenylistedKey(key)) continue;
    output[key] = stripSensitive(entry, depth + 1, seen);
  }
  return output;
}

function toStr(value) {
  if (typeof value === "string") {
    const text = value.trim();
    return text || null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function toInt(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d{1,6}$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function toBoolOrNull(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

function parsePort(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
  }
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number.parseInt(text, 10);
  return port >= 1 && port <= 65535 ? port : null;
}

function joinHostPort(host, port) {
  if (!host) return null;
  if (port === null) return host;
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

function normalizeProtocolValue(value) {
  const text = toStr(value);
  if (!text) return null;
  const lower = text.toLowerCase();
  return TUNNEL_PROTOCOLS.includes(lower) ? lower : null;
}

// Parses "host:port" out of a plain host, "host:port", "[ipv6]:port" or
// "[ipv6]" value. Exported for reuse and testing. Returns null for anything
// that cannot be read as a host/port at all. Unbracketed IPv6 is returned
// whole with port null, because a trailing :port there would be ambiguous and
// this helper never guesses.
function parseHostPort(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  let text = String(value).trim();
  if (!text) return null;
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  text = text.split(/[/?#]/)[0].trim();
  if (!text) return null;

  const bracketed = text.match(/^\[([^\]]*)\](?::(\d{1,5}))?$/);
  if (bracketed) {
    const host = bracketed[1].trim() || null;
    const port = parsePort(bracketed[2]);
    if (!host && port === null) return null;
    return { host, port };
  }

  const colonCount = (text.match(/:/g) || []).length;
  if (colonCount === 0) return { host: text, port: null };
  if (colonCount > 1) return { host: text, port: null };

  const separator = text.indexOf(":");
  const host = text.slice(0, separator).trim() || null;
  const port = parsePort(text.slice(separator + 1));
  if (!host && port === null) return null;
  return { host, port };
}

// Maps one provider-specific tunnel record into the canonical tunnel shape.
// Tolerant by design: unknown keys are ignored, missing fields become null,
// protocol is validated against TUNNEL_PROTOCOLS. Returns null when the entry
// carries no id, no address and no port (nothing worth repairing).
function normalizeTunnel(raw = {}) {
  let source = null;
  try {
    const stripped = stripSensitive(raw);
    source = isPlainObject(stripped) ? stripped : null;
  } catch {
    source = null;
  }
  if (!source) return null;

  const id = toStr(source.id) || toStr(source.tunnelId) || toStr(source.tunnel_id) || null;
  const name = toStr(source.name) || toStr(source.tunnelName) || toStr(source.tunnel_name) || null;
  const publicAddress = toStr(source.publicAddress)
    || toStr(source.tunnelAddress)
    || toStr(source.display_address)
    || toStr(source.assigned_domain)
    || toStr(source.address)
    || toStr(source.domain)
    || null;
  const localTarget = toStr(source.localTarget) || toStr(source.local_target) || null;
  const publicParts = parseHostPort(publicAddress);
  const localParts = parseHostPort(localTarget);
  const publicHost = toStr(source.publicHost) || (publicParts ? publicParts.host : null);
  const publicPort = toInt(source.publicPort) ?? (publicParts ? publicParts.port : null);
  const localHost = toStr(source.localHost)
    || toStr(source.localIp)
    || toStr(source.local_ip)
    || (localParts ? localParts.host : null);
  const localPort = toInt(source.localPort) ?? toInt(source.local_port) ?? (localParts ? localParts.port : null);
  const region = toStr(source.region) || null;
  const protocol = normalizeProtocolValue(source.protocol)
    || normalizeProtocolValue(source.proto)
    || normalizeProtocolValue(source.type)
    || null;

  let enabled = toBoolOrNull(source.enabled);
  if (enabled === null) {
    if (source.is_disabled === true || source.disabled === true) enabled = false;
    else if (source.is_disabled === false || source.disabled === false) enabled = true;
  }

  const hasAddress = Boolean(publicAddress || publicHost || localTarget || localHost);
  const hasPort = publicPort !== null || localPort !== null;
  if (!id && !hasAddress && !hasPort) return null;

  return {
    id,
    name,
    protocol,
    localHost,
    localPort,
    publicAddress,
    publicHost,
    publicPort,
    region,
    enabled,
  };
}

function normalizeDiagnostics(rawDiagnostics) {
  const output = [];
  const push = (code, message) => {
    if (output.length >= MAX_DIAGNOSTICS) return;
    const entryCode = (toStr(code) || "PROVIDER_DIAGNOSTIC").slice(0, MAX_DIAGNOSTIC_CODE_LENGTH);
    const entryMessage = (toStr(message) || entryCode).slice(0, MAX_DIAGNOSTIC_MESSAGE_LENGTH);
    output.push({ code: entryCode, message: entryMessage });
  };
  const entries = Array.isArray(rawDiagnostics)
    ? rawDiagnostics
    : rawDiagnostics === null || rawDiagnostics === undefined
      ? []
      : [rawDiagnostics];
  for (const entry of entries) {
    if (typeof entry === "string") {
      push("PROVIDER_DIAGNOSTIC", entry);
      continue;
    }
    if (isPlainObject(entry)) {
      push(entry.code || entry.errorCode || entry.reason, entry.message || entry.detail || entry.reason);
    }
  }
  return output;
}

// Maps any provider-shaped input into the canonical provider state. Unknown or
// malformed input (null, strings, numbers, arrays) yields availability
// "unknown", state "unknown" and connected null. Never throws. Sensitive keys
// and credential-looking values are stripped before mapping.
function normalizeProviderState(raw = {}) {
  let source = {};
  try {
    const stripped = stripSensitive(raw);
    if (isPlainObject(stripped)) source = stripped;
  } catch {
    source = {};
  }

  const rawState = toStr(source.state) || toStr(source.lifecycleState);
  const state = rawState && PROVIDER_STATES.includes(rawState.toLowerCase())
    ? rawState.toLowerCase()
    : "unknown";
  const rawAvailability = toStr(source.availability);
  const availability = rawAvailability && PROVIDER_AVAILABILITY.includes(rawAvailability.toLowerCase())
    ? rawAvailability.toLowerCase()
    : "unknown";
  const tunnels = Array.isArray(source.tunnels)
    ? source.tunnels.map((entry) => normalizeTunnel(entry)).filter(Boolean)
    : [];
  const localIp = toStr(source.localIp);
  const localPort = toInt(source.localPort);
  const localTarget = toStr(source.localTarget) || joinHostPort(localIp, localPort);

  return {
    providerId: toStr(source.providerId) || toStr(source.id),
    displayName: toStr(source.displayName) || toStr(source.providerName) || toStr(source.name),
    availability,
    state,
    connected: toBoolOrNull(source.connected),
    version: toStr(source.version),
    region: toStr(source.region),
    publicAddress: toStr(source.publicAddress) || toStr(source.tunnelAddress),
    localTarget,
    tunnels,
    lastCheckedAt: toStr(source.lastCheckedAt) || toStr(source.checkedAt),
    diagnostics: normalizeDiagnostics(source.diagnostics),
  };
}

// Validates the structure of a candidate provider adapter. Returns a typed
// verdict rather than throwing. Required structure:
//   id          lowercase slug
//   displayName non-empty string
//   capabilities  object of booleans from PROVIDER_CAPABILITY_IDS
//   functions   for every FUNCTIONAL capability declared true
// The descriptive capabilities (publicAddress, localTarget, region,
// controlAgent, createTunnel, deleteTunnel) are booleans only; no function is
// required for them. When adapter.normalizeState is declared it must be a
// function.
function validateProviderAdapter(adapter) {
  const errors = [];
  const missingRequired = [];
  const input = isPlainObject(adapter) ? adapter : null;

  const rawId = input ? input.id : null;
  if (typeof rawId !== "string" || !ADAPTER_ID_PATTERN.test(rawId.trim())) {
    errors.push({
      capability: null,
      code: "ADAPTER_ID_INVALID",
      message: "Provider adapter id must be a lowercase slug (letters, digits, dashes) starting with a letter.",
    });
  }

  if (!input || typeof input.displayName !== "string" || !input.displayName.trim()) {
    errors.push({
      capability: null,
      code: "ADAPTER_LABEL_MISSING",
      message: "Provider adapter must declare a non-empty displayName.",
    });
  }

  const capabilities = input && isPlainObject(input.capabilities) ? input.capabilities : null;
  if (!capabilities) {
    errors.push({
      capability: null,
      code: "ADAPTER_CAPABILITIES_INVALID",
      message: "Provider adapter must declare a capabilities object keyed by capability id with boolean values.",
    });
  } else {
    for (const [capabilityId, value] of Object.entries(capabilities)) {
      if (!PROVIDER_CAPABILITY_IDS.includes(capabilityId)) {
        errors.push({
          capability: capabilityId,
          code: "ADAPTER_CAPABILITY_UNKNOWN",
          message: `Capability "${capabilityId}" is not part of the provider-adapter contract vocabulary.`,
        });
        continue;
      }
      if (typeof value !== "boolean") {
        errors.push({
          capability: capabilityId,
          code: "ADAPTER_CAPABILITIES_INVALID",
          message: `Capability "${capabilityId}" must be a boolean.`,
        });
      }
    }
    for (const capabilityId of FUNCTIONAL_CAPABILITIES) {
      if (capabilities[capabilityId] !== true) continue;
      if (!input || typeof input[capabilityId] !== "function") {
        missingRequired.push(capabilityId);
        errors.push({
          capability: capabilityId,
          code: "ADAPTER_FUNCTION_MISSING",
          message: `Capability "${capabilityId}" is declared true but the adapter does not implement a function named "${capabilityId}".`,
        });
      }
    }
  }

  if (input && input.normalizeState !== undefined && typeof input.normalizeState !== "function") {
    errors.push({
      capability: "normalizeState",
      code: "ADAPTER_FUNCTION_MISSING",
      message: "adapter.normalizeState is declared but is not a function.",
    });
  }

  return { ok: errors.length === 0, errors, missingRequired };
}

// Provider-level health only: "running" means the provider agent reports the
// provider itself as up. It is deliberately not a statement that any specific
// tunnel or endpoint is reachable from the public internet.
function isProviderStateHealthy(state) {
  return state === "running";
}

module.exports = {
  CONTRACT_VERSION,
  PROVIDER_CAPABILITY_IDS,
  PROVIDER_STATES,
  PROVIDER_AVAILABILITY,
  TUNNEL_PROTOCOLS,
  SENSITIVE_FIELD_DENYLIST,
  isProviderStateHealthy,
  normalizeProviderState,
  normalizeTunnel,
  parseHostPort,
  validateProviderAdapter,
};
