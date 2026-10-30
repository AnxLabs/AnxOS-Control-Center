"use strict";

// Service-capability seam drift gate.
//
// Pins the honesty rules of src/shared/serviceCapabilityContract.js so the UI
// seam cannot drift into over-claiming:
//
//   1. every managed service advertises exactly the generic capabilities,
//   2. a node capability key that is explicitly false removes exactly the
//      service capability mapped to it,
//   3. a shipped family extension (Minecraft players) is available,
//   4. declared-but-unbuilt family extensions (FiveM players / resources /
//      serverMetadata) are extension points only and never advertised as
//      working,
//   5. null and unknown families get no domain extras,
//   6. derivation is deterministic: same input, same output, same key order,
//   7. the exported tables are frozen, and
//   8. KNOWN_FAMILY_EXTENSIONS covers exactly the shipped service families
//      (drift check against src/shared/gameAdapterContract.js).
//
// The expected strings are written out here on purpose: a change to a reason,
// a label or a gate message must be a conscious edit on both sides.

const assert = require("assert");

const contract = require("../src/shared/serviceCapabilityContract");
const adapterContract = require("../src/shared/gameAdapterContract");

const EXPECTED_LABELS = Object.freeze({
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

const NODE_GATE_REASONS = Object.freeze({
  backups: "This node does not support backups for managed services.",
  diagnostics: "This node does not support diagnostics for managed services.",
  endpoints: "This node does not support endpoints for managed services.",
  metrics: "This node does not support metrics for managed services.",
});

const FIVEM_REASONS = Object.freeze({
  players: "FiveM player list requires the FXServer HTTP API adapter (not implemented).",
  resources: "FiveM resource inventory requires the FXServer HTTP API adapter (not implemented).",
  serverMetadata: "FiveM server metadata requires the FXServer HTTP API adapter (not implemented).",
});

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function derive(input) {
  return contract.deriveServiceCapabilities(input);
}

// Shared shape/consistency checks applied to every derivation in this smoke.
function assertDerivedShape(derived, label) {
  assert(typeof derived === "object" && derived !== null, `${label}: derivation must return an object.`);
  assert(derived.capabilities && typeof derived.capabilities === "object", `${label}: capabilities must be an object.`);
  assert(derived.unsupported && typeof derived.unsupported === "object", `${label}: unsupported must be an object.`);
  assert(Array.isArray(derived.extensionPoints), `${label}: extensionPoints must be an array.`);

  for (const id of Object.keys(derived.capabilities)) {
    assert(contract.SERVICE_CAPABILITY_IDS.includes(id), `${label}: capabilities contains unknown id "${id}".`);
    assert(!hasOwn(derived.unsupported, id), `${label}: "${id}" is both available and unsupported.`);
    assert.strictEqual(derived.capabilities[id], true, `${label}: "${id}" must be true when present.`);
  }
  for (const id of Object.keys(derived.unsupported)) {
    assert(contract.SERVICE_CAPABILITY_IDS.includes(id), `${label}: unsupported contains unknown id "${id}".`);
    assert(
      typeof derived.unsupported[id] === "string" && derived.unsupported[id].length > 0,
      `${label}: unsupported "${id}" must carry a non-empty reason.`,
    );
  }

  const pointIds = derived.extensionPoints.map((entry) => entry.id);
  assert.deepStrictEqual(pointIds, [...pointIds].sort(), `${label}: extensionPoints must be sorted by id.`);
  for (const entry of derived.extensionPoints) {
    assert(contract.SERVICE_CAPABILITY_IDS.includes(entry.id), `${label}: extension point "${entry.id}" is outside the vocabulary.`);
    assert(
      entry.state === "planned" || entry.state === "available",
      `${label}: extension point "${entry.id}" must be planned or available, got "${entry.state}".`,
    );
    assert(
      typeof entry.reason === "string" && entry.reason.length > 0,
      `${label}: extension point "${entry.id}" must carry a non-empty reason.`,
    );
    if (entry.state === "planned") {
      assert.strictEqual(
        hasOwn(derived.capabilities, entry.id),
        false,
        `${label}: planned "${entry.id}" must never appear in capabilities.`,
      );
    }
    if (entry.state === "available") {
      assert.strictEqual(derived.capabilities[entry.id], true, `${label}: available "${entry.id}" must be in capabilities.`);
    }
  }
}

function assertCapabilityRefused(derived, capabilityId, reasonFragment, label) {
  let thrown = null;
  try {
    contract.assertCapability(derived, capabilityId);
  } catch (error) {
    thrown = error;
  }
  assert(thrown, `${label}: assertCapability("${capabilityId}") must throw.`);
  assert.strictEqual(
    thrown.code,
    "CAPABILITY_UNSUPPORTED",
    `${label}: the refusal must be coded CAPABILITY_UNSUPPORTED.`,
  );
  assert(
    thrown.message.includes(capabilityId),
    `${label}: the refusal message must name the capability "${capabilityId}" (got: ${thrown.message}).`,
  );
  if (reasonFragment) {
    assert(
      thrown.message.includes(reasonFragment),
      `${label}: the refusal message must carry the reason (got: ${thrown.message}).`,
    );
  }
  return thrown;
}

// ---------------------------------------------------------------------------
// Vocabulary and frozen tables
// ---------------------------------------------------------------------------

function testVocabulary() {
  assert.strictEqual(contract.CONTRACT_VERSION, 1, "The seam must declare contract version 1.");

  assert.deepStrictEqual(
    [...contract.SERVICE_CAPABILITY_IDS],
    [
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
    ],
    "SERVICE_CAPABILITY_IDS must stay the documented vocabulary.",
  );
  assert.strictEqual(
    new Set(contract.SERVICE_CAPABILITY_IDS).size,
    contract.SERVICE_CAPABILITY_IDS.length,
    "SERVICE_CAPABILITY_IDS must not contain duplicates.",
  );

  assert.deepStrictEqual(
    [...contract.CAPABILITY_STATES],
    ["available", "planned", "unsupported"],
    "CAPABILITY_STATES must stay the three documented states.",
  );

  assert.deepStrictEqual(
    [...contract.GENERIC_CAPABILITIES],
    ["lifecycle", "console", "logs", "metrics", "configuration", "backups", "endpoints", "diagnostics"],
    "GENERIC_CAPABILITIES must stay the documented generic set.",
  );
  for (const id of contract.GENERIC_CAPABILITIES) {
    assert(contract.SERVICE_CAPABILITY_IDS.includes(id), `Generic capability "${id}" must be part of the vocabulary.`);
  }

  assert.deepStrictEqual(
    { ...contract.NODE_CAPABILITY_REQUIREMENTS },
    { backups: "backups", diagnostics: "instances", endpoints: "instances", metrics: "instances" },
    "NODE_CAPABILITY_REQUIREMENTS must stay the documented node-key mapping.",
  );
  for (const [capabilityId, nodeKey] of Object.entries(contract.NODE_CAPABILITY_REQUIREMENTS)) {
    assert(
      contract.GENERIC_CAPABILITIES.includes(capabilityId),
      `Node-gated "${capabilityId}" must be a generic capability.`,
    );
    assert(typeof nodeKey === "string" && nodeKey.length > 0, "Every node gate must name a node capability key.");
  }

  // Frozen tables: the seam is a contract, not a scratch pad.
  const frozenTables = [
    ["SERVICE_CAPABILITY_IDS", contract.SERVICE_CAPABILITY_IDS],
    ["CAPABILITY_STATES", contract.CAPABILITY_STATES],
    ["GENERIC_CAPABILITIES", contract.GENERIC_CAPABILITIES],
    ["NODE_CAPABILITY_REQUIREMENTS", contract.NODE_CAPABILITY_REQUIREMENTS],
    ["KNOWN_FAMILY_EXTENSIONS", contract.KNOWN_FAMILY_EXTENSIONS],
  ];
  for (const [name, table] of frozenTables) {
    assert(Object.isFrozen(table), `${name} must be frozen.`);
  }
  for (const family of Object.keys(contract.KNOWN_FAMILY_EXTENSIONS)) {
    const extensions = contract.KNOWN_FAMILY_EXTENSIONS[family];
    assert(Object.isFrozen(extensions), `KNOWN_FAMILY_EXTENSIONS.${family} must be frozen.`);
    for (const [id, entry] of Object.entries(extensions)) {
      assert(Object.isFrozen(entry), `KNOWN_FAMILY_EXTENSIONS.${family}.${id} must be frozen.`);
    }
  }
  assert.throws(
    () => { contract.SERVICE_CAPABILITY_IDS.push("telepathy"); },
    TypeError,
    "A frozen table must refuse mutation.",
  );
  assert.throws(
    () => { contract.KNOWN_FAMILY_EXTENSIONS.minecraft = {}; },
    TypeError,
    "A frozen table must refuse mutation.",
  );

  assert(
    typeof contract.UNKNOWN_FAMILY_REASON === "string" && contract.UNKNOWN_FAMILY_REASON.length > 0,
    "UNKNOWN_FAMILY_REASON must be a non-empty string.",
  );

  // Every extension entry is well-formed and lives outside the generic set
  // (extensions are domain surfaces, not re-statements of generic ones).
  for (const [family, extensions] of Object.entries(contract.KNOWN_FAMILY_EXTENSIONS)) {
    for (const [id, entry] of Object.entries(extensions)) {
      assert(contract.SERVICE_CAPABILITY_IDS.includes(id), `${family}.${id} is outside the capability vocabulary.`);
      assert(
        !contract.GENERIC_CAPABILITIES.includes(id),
        `${family}.${id} must be a domain extension, not a generic capability.`,
      );
      assert(
        contract.CAPABILITY_STATES.includes(entry.state),
        `${family}.${id} declares an unknown state "${entry.state}".`,
      );
      assert(typeof entry.reason === "string" && entry.reason.length > 0, `${family}.${id} must explain itself.`);
    }
  }

  // Drift gate: the seam must know exactly the families the shipped game
  // adapters recognize. A new shipped family fails here until it is declared.
  assert.deepStrictEqual(
    Object.keys(contract.KNOWN_FAMILY_EXTENSIONS).sort(),
    [...adapterContract.SHIPPED_ADAPTER_IDS].sort(),
    "KNOWN_FAMILY_EXTENSIONS must cover exactly the shipped service families.",
  );

  // Labels: human-readable for every id, stable, and never invented.
  for (const id of contract.SERVICE_CAPABILITY_IDS) {
    assert.strictEqual(
      contract.describeCapability(id),
      EXPECTED_LABELS[id],
      `describeCapability("${id}") must return the documented label.`,
    );
  }
  assert.strictEqual(contract.describeCapability("telepathy"), "Unknown", "An unknown id must not invent a label.");
}

// ---------------------------------------------------------------------------
// Generic services and node gating
// ---------------------------------------------------------------------------

function testGenericService() {
  const derived = derive({ instanceType: "custom-command", family: null });
  assertDerivedShape(derived, "generic service");
  assert.strictEqual(derived.family, null, "A null family must stay null.");
  assert.deepStrictEqual(
    Object.keys(derived.capabilities),
    [...contract.GENERIC_CAPABILITIES],
    "A generic service must advertise exactly the generic capabilities, in vocabulary order.",
  );
  for (const id of contract.GENERIC_CAPABILITIES) {
    assert.strictEqual(derived.capabilities[id], true, `"${id}" must be available for a generic service.`);
  }
  assert.deepStrictEqual(derived.unsupported, {}, "A generic service with no node map has nothing unsupported.");
  assert.deepStrictEqual(derived.extensionPoints, [], "A family-less service has no domain extension points.");

  // Defaults and whitespace families behave like an explicit null family.
  assert.deepStrictEqual(derive(), derived, "derive() must default to the generic service.");
  assert.deepStrictEqual(derive({}), derived, "derive({}) must default to the generic service.");
  assert.strictEqual(derive({ family: "   " }).family, null, "A whitespace family must normalize to null.");

  // Helper surface.
  assert.strictEqual(contract.assertCapability(derived, "lifecycle"), true, "An available capability must assert true.");
  for (const id of contract.SERVICE_CAPABILITY_IDS) {
    assert.strictEqual(
      contract.isCapabilityAvailable(derived, id),
      contract.GENERIC_CAPABILITIES.includes(id),
      `isCapabilityAvailable("${id}") must match the derived map.`,
    );
  }
}

function testNodeGating() {
  const derived = derive({
    instanceType: "custom-command",
    family: null,
    nodeCapabilities: { backups: false, instances: true },
  });
  assertDerivedShape(derived, "node-gated service");

  assert.strictEqual(hasOwn(derived.capabilities, "backups"), false, "Node-disabled backups must leave capabilities.");
  assert.strictEqual(derived.unsupported.backups, NODE_GATE_REASONS.backups, "The node gate must explain itself.");
  assert.deepStrictEqual(
    Object.keys(derived.capabilities),
    contract.SERVICE_CAPABILITY_IDS.filter((id) => contract.GENERIC_CAPABILITIES.includes(id) && id !== "backups"),
    "Removing backups must not disturb the remaining vocabulary order.",
  );

  // The node capability key "instances" is not a service capability id: its
  // true value only keeps the capabilities mapped to it available.
  assert.strictEqual(
    contract.SERVICE_CAPABILITY_IDS.includes("instances"),
    false,
    "\"instances\" must not be a service capability id.",
  );
  assert.strictEqual(hasOwn(derived.capabilities, "instances"), false, "A node key must not leak into capabilities.");
  assert.strictEqual(hasOwn(derived.unsupported, "instances"), false, "A node key must not leak into unsupported.");
  for (const id of ["diagnostics", "endpoints", "metrics"]) {
    assert.strictEqual(derived.capabilities[id], true, `instances: true must keep "${id}" available.`);
  }

  const refusal = assertCapabilityRefused(derived, "backups", NODE_GATE_REASONS.backups, "node gating");
  assert.strictEqual(refusal.capabilityId, "backups", "The refusal must carry the capability id.");
  assert.strictEqual(refusal.reason, NODE_GATE_REASONS.backups, "The refusal must carry the reason.");

  // instances: false disables the three instance-gated capabilities only.
  const noInstances = derive({ family: null, nodeCapabilities: { instances: false, backups: true } });
  assertDerivedShape(noInstances, "instances-disabled service");
  assert.deepStrictEqual(
    Object.keys(noInstances.unsupported),
    ["metrics", "endpoints", "diagnostics"],
    "Only the instance-gated capabilities may be disabled, in vocabulary order.",
  );
  for (const id of ["diagnostics", "endpoints", "metrics"]) {
    assert.strictEqual(noInstances.unsupported[id], NODE_GATE_REASONS[id], `"${id}" must carry its node-gate reason.`);
  }
  assert.strictEqual(noInstances.capabilities.backups, true, "backups: true must stay available.");

  // An explicit true never disables, and a missing/non-object node map gates
  // nothing.
  const backupsTrue = derive({ family: null, nodeCapabilities: { backups: true } });
  assert.strictEqual(backupsTrue.capabilities.backups, true, "An explicit true must not disable a capability.");
  for (const value of [null, "nope", []]) {
    const ungated = derive({ family: null, nodeCapabilities: value });
    assert.strictEqual(ungated.capabilities.backups, true, "Without a node capability map nothing is node-gated.");
    assert.deepStrictEqual(ungated.unsupported, {}, "Without a node capability map nothing is unsupported.");
  }
}

// ---------------------------------------------------------------------------
// Family extensions
// ---------------------------------------------------------------------------

function testMinecraft() {
  const derived = derive({ instanceType: "minecraft", family: "minecraft" });
  assertDerivedShape(derived, "minecraft");
  assert.strictEqual(derived.family, "minecraft");
  assert.strictEqual(derived.capabilities.players, true, "Minecraft player adapters ship with AnxOS.");
  assert.deepStrictEqual(
    derived.extensionPoints,
    [{ id: "players", state: "available", reason: "Minecraft player file adapters ship with AnxOS." }],
    "Minecraft must expose players as an available extension point.",
  );
  assert.strictEqual(hasOwn(derived.unsupported, "players"), false, "An available extension must not be unsupported.");
  for (const id of contract.GENERIC_CAPABILITIES) {
    assert.strictEqual(derived.capabilities[id], true, `Minecraft must keep generic "${id}" available.`);
  }
  assert.strictEqual(contract.assertCapability(derived, "players"), true, "An available extension must assert true.");

  // A known family without an extension falls back to the generic reason.
  assertCapabilityRefused(derived, "resources", "Capability \"resources\" is not available", "minecraft fallback");

  // Family normalization must reach the same table entry.
  const messy = derive({ family: "  MineCraft  " });
  assert.strictEqual(messy.family, "minecraft", "The family must normalize to lowercase, trimmed text.");
  assert.deepStrictEqual(messy, derived, "A normalized family must derive the same result.");
}

function testFiveM() {
  const derived = derive({ instanceType: "fivem", family: "fivem" });
  assertDerivedShape(derived, "fivem");
  assert.deepStrictEqual(
    derived.extensionPoints,
    [
      { id: "players", state: "planned", reason: FIVEM_REASONS.players },
      { id: "resources", state: "planned", reason: FIVEM_REASONS.resources },
      { id: "serverMetadata", state: "planned", reason: FIVEM_REASONS.serverMetadata },
    ],
    "FiveM extensions must be exactly the three planned adapters, sorted by id.",
  );
  for (const [id, reason] of Object.entries(FIVEM_REASONS)) {
    assert.strictEqual(hasOwn(derived.capabilities, id), false, `Planned FiveM "${id}" must never be available.`);
    assert.strictEqual(derived.capabilities[id], undefined, `Planned FiveM "${id}" must never be available.`);
    assert.strictEqual(
      contract.isCapabilityAvailable(derived, id),
      false,
      `Planned FiveM "${id}" must not pass the availability check.`,
    );
    assert.strictEqual(hasOwn(derived.unsupported, id), false, "A planned capability is an extension point, not unsupported.");
  }

  // Negative control, explicitly: planned is never available.
  for (const point of derived.extensionPoints) {
    assert.strictEqual(point.state, "planned", "Every FiveM extension must be planned at this time.");
    assert.notStrictEqual(
      derived.capabilities[point.id],
      true,
      `Planned capability "${point.id}" must never appear as available.`,
    );
  }

  const refusal = assertCapabilityRefused(derived, "players", FIVEM_REASONS.players, "fivem");
  assert.strictEqual(refusal.capabilityId, "players", "The refusal must carry the capability id.");
  assert.strictEqual(refusal.reason, FIVEM_REASONS.players, "The refusal must carry the reason.");
}

function testUnknownFamilyAndDeterminism() {
  const first = derive({ instanceType: "custom-command", family: "unregistered-family" });
  const second = derive({ instanceType: "custom-command", family: "unregistered-family" });
  assertDerivedShape(first, "unknown family");
  assert.strictEqual(first.family, "unregistered-family", "An unknown family must pass through normalized.");
  assert.deepStrictEqual(first.extensionPoints, [], "An unknown family must get no domain extras.");
  assert.deepStrictEqual(first.unsupported, {}, "An unknown family must not fabricate unsupported entries.");
  assert.deepStrictEqual(
    Object.keys(first.capabilities),
    [...contract.GENERIC_CAPABILITIES],
    "An unknown family must still advertise exactly the generic capabilities.",
  );
  assert.deepStrictEqual(first, second, "Two identical derivations must be deep-equal.");
  assert.strictEqual(
    JSON.stringify(first),
    JSON.stringify(second),
    "Two identical derivations must serialize identically (deterministic key order).",
  );

  const refusal = assertCapabilityRefused(first, "players", contract.UNKNOWN_FAMILY_REASON, "unknown family");
  assert.strictEqual(refusal.reason, contract.UNKNOWN_FAMILY_REASON, "An unknown family refusal must carry the family reason.");

  // Determinism also holds for a family with planned extensions and for a
  // node-gated derivation.
  assert.strictEqual(
    JSON.stringify(derive({ family: "fivem" })),
    JSON.stringify(derive({ family: "fivem" })),
    "Planned extension ordering must be deterministic.",
  );
  const gated = { family: "fivem", nodeCapabilities: { instances: false, backups: false } };
  assert.strictEqual(
    JSON.stringify(derive(gated)),
    JSON.stringify(derive(gated)),
    "Node-gated derivations must be deterministic.",
  );
}

// Sweep the whole declared table: every entry must produce exactly the state it
// declares, and no family may advertise anything it did not declare.
function testFamilyTableHonesty() {
  for (const family of Object.keys(contract.KNOWN_FAMILY_EXTENSIONS)) {
    const derived = derive({ family });
    assertDerivedShape(derived, `family ${family}`);
    assert.strictEqual(
      JSON.stringify(derive({ family })),
      JSON.stringify(derived),
      `"${family}" must derive deterministically.`,
    );
    for (const [id, extension] of Object.entries(contract.KNOWN_FAMILY_EXTENSIONS[family])) {
      const points = derived.extensionPoints.filter((entry) => entry.id === id);
      if (extension.state === "available") {
        assert.strictEqual(derived.capabilities[id], true, `Available "${family}/${id}" must be in capabilities.`);
        assert.deepStrictEqual(
          points,
          [{ id, state: "available", reason: extension.reason }],
          `Available "${family}/${id}" must be an extension point.`,
        );
      } else if (extension.state === "planned") {
        assert.strictEqual(hasOwn(derived.capabilities, id), false, `Planned "${family}/${id}" must never be available.`);
        assert.deepStrictEqual(
          points,
          [{ id, state: "planned", reason: extension.reason }],
          `Planned "${family}/${id}" must be an extension point.`,
        );
      } else if (extension.state === "unsupported") {
        assert.strictEqual(derived.unsupported[id], extension.reason, `Unsupported "${family}/${id}" must carry its reason.`);
        assert.deepStrictEqual(points, [], `Unsupported "${family}/${id}" must not be an extension point.`);
      }
    }
    for (const id of Object.keys(derived.capabilities)) {
      assert(
        contract.GENERIC_CAPABILITIES.includes(id) || hasOwn(contract.KNOWN_FAMILY_EXTENSIONS[family], id),
        `"${family}" advertised "${id}" from nowhere.`,
      );
    }
  }
}

// ---------------------------------------------------------------------------

function main() {
  testVocabulary();
  testGenericService();
  testNodeGating();
  testMinecraft();
  testFiveM();
  testUnknownFamilyAndDeterminism();
  testFamilyTableHonesty();
  console.log(
    `service-capability: ${contract.SERVICE_CAPABILITY_IDS.length} capabilities, `
      + `${contract.GENERIC_CAPABILITIES.length} generic, `
      + `${Object.keys(contract.KNOWN_FAMILY_EXTENSIONS).length} known families`,
  );
  console.log("service-capability smoke passed");
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
