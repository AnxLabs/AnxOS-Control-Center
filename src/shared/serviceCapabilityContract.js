"use strict";

// Generic service-capability seam for managed services (instances).
//
// Rule: the generic service system must not be tightly coupled to any family.
// Planned capabilities are visible as extension points but never rendered as
// working features.
//
// deriveServiceCapabilities() answers the one question the UI must ask before
// it renders a domain surface: "what can this specific service honestly show
// right now?" It combines three inputs:
//
//   1. the service family (the nullable domain discriminator: minecraft,
//      fivem, ...), which selects the declared family extensions,
//   2. the node capability map (a node that cannot run managed services must
//      not advertise their surfaces), and
//   3. KNOWN_FAMILY_EXTENSIONS below, the per-family extras table.
//
// GENERIC_CAPABILITIES belong to every managed service. A declared family
// extension is either already shipped ("available"), declared but not built
// ("planned", extension point only) or genuinely absent ("unsupported").
// A capability is never in both `capabilities` and `unsupported`, and a
// "planned" extension never enters `capabilities`.
//
// Future domain adapters (for example a FiveM FXServer HTTP API adapter or a
// Minecraft player-file adapter) plug in by editing KNOWN_FAMILY_EXTENSIONS:
// add the entry as "planned" while it does not exist, flip it to "available"
// once it ships. The vocabulary SERVICE_CAPABILITY_IDS stays closed.
//
// This file must stay dependency-free: Electron Builder copies src/shared/**/*
// into the standalone agent runtime (docs/ARCHITECTURE.md:53-54), so no
// requires into src/services, no Electron, no fs and no external dependencies
// are allowed here. The drift gate that keeps the tables, their ordering and
// their honesty claims pinned is scripts/service-capability-smoke.js.

const CONTRACT_VERSION = 1;

// The closed vocabulary of capabilities a managed service surface can expose.
// Order is significant: derived capability maps are keyed in this order, so the
// same instance always serializes identically.
const SERVICE_CAPABILITY_IDS = Object.freeze([
  "lifecycle",
  "console",
  "logs",
  "metrics",
  "configuration",
  "backups",
  "endpoints",
  "diagnostics",
  "players",
  "resources",
  "serverMetadata",
]);

// The only states a capability claim can have:
//   available   — shipped and safe to render as a working feature,
//   planned     — a declared extension point; visible, never rendered as working,
//   unsupported — explicitly not provided (node limit or absent domain support).
const CAPABILITY_STATES = Object.freeze(["available", "planned", "unsupported"]);

// Every managed service gets these unless the node capability map says
// otherwise. Entries added here must also exist in SERVICE_CAPABILITY_IDS.
const GENERIC_CAPABILITIES = Object.freeze([
  "lifecycle",
  "console",
  "logs",
  "metrics",
  "configuration",
  "backups",
  "endpoints",
  "diagnostics",
]);

// Maps a service capability to the node capability key whose explicit `false`
// value disables it. The keys mirror buildNodeCapabilities() in
// src/services/nodeService.js (both the application host and Agent nodes
// report `instances` and `backups`). The names are declared here rather than
// imported so this module stays dependency-free; the smoke pins the mapping.
const NODE_CAPABILITY_REQUIREMENTS = Object.freeze({
  backups: "backups",
  diagnostics: "instances",
  endpoints: "instances",
  metrics: "instances",
});

// Per-family extras beyond GENERIC_CAPABILITIES — the seam future FiveM and
// Minecraft domain adapters plug into. No adapter code lives here: an entry
// describes what the family can offer, never how it is implemented. Every
// extension id must be part of SERVICE_CAPABILITY_IDS.
const KNOWN_FAMILY_EXTENSIONS = Object.freeze({
  minecraft: Object.freeze({
    players: Object.freeze({
      state: "available",
      reason: "Minecraft player file adapters ship with AnxOS.",
    }),
  }),
  fivem: Object.freeze({
    players: Object.freeze({
      state: "planned",
      reason: "FiveM player list requires the FXServer HTTP API adapter (not implemented).",
    }),
    resources: Object.freeze({
      state: "planned",
      reason: "FiveM resource inventory requires the FXServer HTTP API adapter (not implemented).",
    }),
    serverMetadata: Object.freeze({
      state: "planned",
      reason: "FiveM server metadata requires the FXServer HTTP API adapter (not implemented).",
    }),
  }),
  // Shipped families with no domain extras yet. They keep their declared empty
  // maps so adding an extension stays a one-line change.
  palworld: Object.freeze({}),
  terraria: Object.freeze({}),
  valheim: Object.freeze({}),
  rust: Object.freeze({}),
  cs2: Object.freeze({}),
});

const UNKNOWN_FAMILY_REASON = "No domain adapter is registered for this service family.";

const CAPABILITY_LABELS = Object.freeze({
  lifecycle: "Start / stop / restart",
  console: "Console input",
  logs: "Logs",
  metrics: "Resource metrics",
  configuration: "Configuration editing",
  backups: "Backups",
  endpoints: "Network endpoints",
  diagnostics: "Connectivity diagnostics",
  players: "Player list",
  resources: "Resource inventory",
  serverMetadata: "Server metadata",
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeFamily(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function normalizeCapabilityId(value) {
  return String(value == null ? "" : value).trim();
}

// Own-property lookup only: a family or capability named like an Object
// prototype member ("constructor", "__proto__") must resolve to "unknown",
// never to an inherited function.
function getFamilyExtensions(family) {
  if (!family) return null;
  if (!Object.prototype.hasOwnProperty.call(KNOWN_FAMILY_EXTENSIONS, family)) return null;
  return KNOWN_FAMILY_EXTENSIONS[family];
}

function nodeGateReason(capabilityId) {
  return `This node does not support ${capabilityId} for managed services.`;
}

// Pure derivation. Returns a JSON-serializable verdict; keys of `capabilities`
// and `unsupported` follow SERVICE_CAPABILITY_IDS order and `extensionPoints`
// is sorted by id, so equal inputs always produce equal serializations.
//
// instanceType is accepted so a caller can pass a full instance identity
// unchanged; the normalized family is the sole domain discriminator today.
function deriveServiceCapabilities({ instanceType = null, family = null, nodeCapabilities = null } = {}) {
  const normalizedFamily = normalizeFamily(family);
  const familyExtensions = getFamilyExtensions(normalizedFamily);
  const nodeMap = isPlainObject(nodeCapabilities) ? nodeCapabilities : null;

  const capabilities = {};
  const unsupported = {};
  const extensionPoints = [];

  for (const capabilityId of SERVICE_CAPABILITY_IDS) {
    const nodeKey = NODE_CAPABILITY_REQUIREMENTS[capabilityId];
    const nodeDisabled = Boolean(
      nodeMap
      && nodeKey
      && Object.prototype.hasOwnProperty.call(nodeMap, nodeKey)
      && nodeMap[nodeKey] === false,
    );

    if (GENERIC_CAPABILITIES.includes(capabilityId)) {
      if (nodeDisabled) {
        unsupported[capabilityId] = nodeGateReason(capabilityId);
      } else {
        capabilities[capabilityId] = true;
      }
      continue;
    }

    const extension = familyExtensions
      && Object.prototype.hasOwnProperty.call(familyExtensions, capabilityId)
      ? familyExtensions[capabilityId]
      : null;
    if (!extension) continue;

    if (extension.state === "available") {
      if (nodeDisabled) {
        // The node gate wins: a capability the node cannot serve must never be
        // advertised as working, even when the family adapter ships. It is
        // reported as unsupported rather than as an extension point so no
        // caller can render it from extensionPoints alone.
        unsupported[capabilityId] = nodeGateReason(capabilityId);
      } else {
        capabilities[capabilityId] = true;
        extensionPoints.push({ id: capabilityId, state: "available", reason: extension.reason });
      }
    } else if (extension.state === "planned") {
      // Planned is an extension point only: it never enters capabilities.
      extensionPoints.push({ id: capabilityId, state: "planned", reason: extension.reason });
    } else if (extension.state === "unsupported") {
      unsupported[capabilityId] = nodeDisabled ? nodeGateReason(capabilityId) : extension.reason;
    }
  }

  extensionPoints.sort((left, right) => (
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  ));

  return {
    family: normalizedFamily,
    capabilities,
    unsupported,
    extensionPoints,
  };
}

function isCapabilityAvailable(derived, capabilityId) {
  if (!isPlainObject(derived) || !isPlainObject(derived.capabilities)) return false;
  const id = normalizeCapabilityId(capabilityId);
  if (!id) return false;
  return derived.capabilities[id] === true;
}

// Asserts that `derived` advertises the capability. Returns true when it does;
// otherwise throws an Error coded CAPABILITY_UNSUPPORTED whose message names
// the capability and the reason: the derived `unsupported` reason, the planned
// extension point's reason, or a generic explanation.
function assertCapability(derived, capabilityId) {
  const id = normalizeCapabilityId(capabilityId);
  if (isCapabilityAvailable(derived, id)) return true;

  let reason = null;
  if (isPlainObject(derived) && isPlainObject(derived.unsupported)
    && typeof derived.unsupported[id] === "string" && derived.unsupported[id]) {
    reason = derived.unsupported[id];
  }
  if (!reason && isPlainObject(derived) && Array.isArray(derived.extensionPoints)) {
    const point = derived.extensionPoints.find((entry) => (
      isPlainObject(entry)
      && entry.id === id
      && typeof entry.reason === "string"
      && entry.reason
    ));
    if (point) reason = point.reason;
  }
  if (!reason) {
    const family = isPlainObject(derived) ? derived.family : null;
    const familyKnown = typeof family === "string" && family
      && Object.prototype.hasOwnProperty.call(KNOWN_FAMILY_EXTENSIONS, family);
    reason = familyKnown
      ? `Capability "${id}" is not available for this service.`
      : UNKNOWN_FAMILY_REASON;
  }

  const error = new Error(`Capability "${id}" is not available: ${reason}`);
  error.code = "CAPABILITY_UNSUPPORTED";
  error.capabilityId = id;
  error.reason = reason;
  throw error;
}

function describeCapability(capabilityId) {
  const id = normalizeCapabilityId(capabilityId);
  return Object.prototype.hasOwnProperty.call(CAPABILITY_LABELS, id)
    ? CAPABILITY_LABELS[id]
    : "Unknown";
}

module.exports = {
  CAPABILITY_STATES,
  CONTRACT_VERSION,
  GENERIC_CAPABILITIES,
  KNOWN_FAMILY_EXTENSIONS,
  NODE_CAPABILITY_REQUIREMENTS,
  SERVICE_CAPABILITY_IDS,
  UNKNOWN_FAMILY_REASON,
  assertCapability,
  deriveServiceCapabilities,
  describeCapability,
  isCapabilityAvailable,
};
