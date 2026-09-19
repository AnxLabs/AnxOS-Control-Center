"use strict";

// V2-E bullet 1 — game-adapter contract gate.
//
// This smoke is the reason the contract cannot drift. It derives every
// capability for every shipped adapter from the shipped code, then checks that
// three things agree:
//
//   1. the derived truth (this file, from the real modules and real source),
//   2. ADAPTER_CONTRACT_STATUS in src/shared/gameAdapterContract.js,
//   3. the capability matrix in docs/v2/V2E_GAME_ADAPTER_CONTRACT.md.
//
// It also exercises validateAdapterContract() in both directions: a definition
// that meets the contract is accepted, and a definition missing each required
// capability in turn is refused by name.
//
// Derivation kinds are labelled, because they are not equally strong:
//   LIVE   — the status comes from calling a shipped module or the instance core
//   ANCHOR — the status comes from a named source anchor (the same technique
//            scripts/steamcmd-instance-update-smoke.js already uses); if the
//            anchor disappears the gate fails
//   RULE   — a small hand-written family mapping whose inputs are gated by LIVE
//            probes and ANCHOR checks. There are exactly two of these
//            (session phases, artifact-derived version detection) and both are
//            marked RULE at the point of use.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const contract = require("../src/shared/gameAdapterContract");
const manager = require("../src/shared/gameServerConfigManager");
const installerRegistry = require("../src/services/marketplaceInstallerRegistry");
const instanceService = require("../src/shared/instances/instanceServiceCore");

const ROOT = path.resolve(__dirname, "..");
const CORE_RELATIVE = "src/shared/instances/instanceServiceCore.js";
const MARKETPLACE_RELATIVE = "src/services/marketplaceService.js";
const DOC_RELATIVE = "docs/v2/V2E_GAME_ADAPTER_CONTRACT.md";

const CORE_SOURCE = fs.readFileSync(path.join(ROOT, CORE_RELATIVE), "utf8");
const MARKETPLACE_SOURCE = fs.readFileSync(path.join(ROOT, MARKETPLACE_RELATIVE), "utf8");
const DOC_SOURCE = fs.readFileSync(path.join(ROOT, DOC_RELATIVE), "utf8");
const TEMPLATES = require("../config/marketplace-templates.json");

// The shipped adapters and the template that represents each. The four families
// without a config adapter ship the same way as the three that have one, so they
// are gated too.
const SHIPPED = Object.freeze([
  Object.freeze({ family: "minecraft", templateId: "minecraft-paper" }),
  Object.freeze({ family: "palworld", templateId: "palworld" }),
  Object.freeze({ family: "fivem", templateId: "fivem" }),
  Object.freeze({ family: "terraria", templateId: "terraria-tshock" }),
  Object.freeze({ family: "valheim", templateId: "valheim" }),
  Object.freeze({ family: "rust", templateId: "rust" }),
  Object.freeze({ family: "cs2", templateId: "cs2" }),
]);

// The three ids the config adapter registry serves. A family outside this set is
// expected to be refused by the validator: that is divergence D-5 in the
// document, and this smoke proves it rather than asserting it in prose.
const CONFIG_ADAPTER_FAMILIES = Object.freeze(["minecraft", "palworld", "fivem"]);
const FAMILIES_WITHOUT_CONFIG_ADAPTER = Object.freeze(["terraria", "valheim", "rust", "cs2"]);

const INSTALLER_SESSION_FAMILIES = Object.freeze(["forge", "neoforge", "quilt", "steamcmd-update"]);

const STEAMCMD_INSTALLER_TYPE = "steamcmd-native";

function requireNeedle(source, needle, label) {
  assert(
    source.includes(needle),
    `Source anchor missing (${label}): expected to find ${JSON.stringify(needle)}. ` +
      "If the code moved or was renamed, update the contract document and this gate together.",
  );
}

function templateFor(templateId) {
  const template = TEMPLATES.find((entry) => entry.id === templateId);
  assert(template, `Template "${templateId}" is not in config/marketplace-templates.json.`);
  return template;
}

function sampleConfig(entry) {
  const template = templateFor(entry.templateId);
  return {
    id: `contract-${entry.family}`,
    templateId: template.id,
    displayName: template.displayName,
    type: template.instanceType,
    game: entry.family,
    tags: Array.isArray(template.tags) ? template.tags : [],
    serverSoftware: null,
  };
}

// Highest number of declared verify files across the template's own installer
// and every per-platform installer override (`template.platforms.<os>.installer`).
function verifyFileCount(template) {
  const direct = template.installer && Array.isArray(template.installer.verifyFiles)
    ? template.installer.verifyFiles.length
    : 0;
  const platforms = template.platforms && typeof template.platforms === "object" ? template.platforms : {};
  let highest = direct;
  for (const platform of Object.values(platforms)) {
    const files = platform && platform.installer && Array.isArray(platform.installer.verifyFiles)
      ? platform.installer.verifyFiles.length
      : 0;
    highest = Math.max(highest, files);
  }
  return highest;
}

// The helper above is itself checked, because no shipped template currently
// declares a platform-only verify list, so the platform branch would otherwise
// never be exercised.
function testVerifyFileCountHelper() {
  assert.strictEqual(verifyFileCount({}), 0, "A template with no installer declares no verify files.");
  assert.strictEqual(
    verifyFileCount({ installer: { verifyFiles: ["a", "b"] } }),
    2,
    "The template-level verify list must be counted.",
  );
  assert.strictEqual(
    verifyFileCount({ platforms: { windows: { installer: { verifyFiles: ["a"] } } } }),
    1,
    "A per-platform verify list must be counted.",
  );
  assert.strictEqual(
    verifyFileCount({
      installer: { verifyFiles: ["a"] },
      platforms: { windows: { installer: { verifyFiles: ["a", "b", "c"] } } },
    }),
    3,
    "The highest verify-file count across platforms must win.",
  );
}

// ---------------------------------------------------------------------------
// Vocabulary and self-consistency (LIVE: pure module facts)
// ---------------------------------------------------------------------------

function testVocabulary() {
  const description = contract.describeContract();
  assert.strictEqual(description.contractVersion, 1, "Contract version must be declared.");

  const all = [...contract.REQUIRED_CAPABILITIES, ...contract.OPTIONAL_CAPABILITIES];
  assert.strictEqual(
    all.length,
    Object.keys(contract.CAPABILITIES).length,
    "Every capability must be classified as required or optional.",
  );
  assert.strictEqual(
    contract.REQUIRED_CAPABILITIES.length,
    8,
    "The contract must declare exactly the eight required capabilities.",
  );
  for (const id of all) {
    const capability = contract.CAPABILITIES[id];
    assert(capability, `Capability "${id}" must be defined.`);
    assert(
      contract.CONTRACT_AREAS.includes(capability.area),
      `Capability "${id}" declares an area outside CONTRACT_AREAS.`,
    );
    assert(typeof capability.description === "string" && capability.description.length > 0);
  }
  assert(
    contract.REQUIRED_CAPABILITIES.every((id) => !contract.OPTIONAL_CAPABILITIES.includes(id)),
    "Required and optional capability sets must be disjoint.",
  );

  // Mirror check: the installer-type list is declared in src/shared (which cannot
  // depend on src/services) and mirrored from the registry. Equality is enforced here.
  assert.deepStrictEqual(
    [...contract.SUPPORTED_INSTALLER_TYPES].sort(),
    [...installerRegistry.SUPPORTED_INSTALLER_TYPES].sort(),
    "The contract's installer-type mirror must equal marketplaceInstallerRegistry.SUPPORTED_INSTALLER_TYPES.",
  );

  // Mirror check: every real config adapter must declare a format the contract lists.
  for (const adapterId of Object.keys(manager.ADAPTERS)) {
    const adapter = manager.ADAPTERS[adapterId];
    assert(
      contract.SUPPORTED_CONFIG_FORMATS.includes(adapter.format),
      `Config adapter "${adapterId}" declares format "${adapter.format}", which the contract does not list.`,
    );
  }

  // Every shipped adapter must have a complete claim row.
  for (const adapterId of contract.SHIPPED_ADAPTER_IDS) {
    const claimed = contract.ADAPTER_CONTRACT_STATUS[adapterId];
    assert(claimed, `Shipped adapter "${adapterId}" must have a claim row.`);
    for (const capabilityId of all) {
      assert(
        contract.STATUS_VALUES.includes(claimed[capabilityId]),
        `Shipped adapter "${adapterId}" must claim a status for "${capabilityId}".`,
      );
    }
  }
  assert.deepStrictEqual(
    [...contract.CONFIG_ADAPTER_IDS].sort(),
    [...Object.keys(manager.ADAPTERS)].sort(),
    "CONFIG_ADAPTER_IDS must equal the ids actually present in the config adapter registry.",
  );
  return description;
}

// ---------------------------------------------------------------------------
// Derivations from the shipped code
// ---------------------------------------------------------------------------

async function probeInstallerFamily(instanceRoot, family, index) {
  const id = `contract-probe-family-${index}-${family}`;
  const operationId = `op-contract-${index}${family}`;
  await instanceService.createInstance({
    id,
    type: "custom-command",
    displayName: `Contract probe ${family}`,
    workingDirectory: "data",
    executable: "bash",
    args: ["-lc", "true"],
    installationState: "installing",
    installationOperationId: operationId,
  });
  try {
    await instanceService.beginInstallationSession(id, { operationId, installerFamily: family });
    return true;
  } catch (error) {
    if (error && error.code === "INSTALLER_FAMILY_NOT_ALLOWED") return false;
    throw error;
  }
}

async function probeSteamCmdUpdateSupport(instanceRoot, entry, index) {
  const id = `contract-probe-update-${index}-${entry.family}`;
  const template = templateFor(entry.templateId);
  const installerType = installerRegistry.getTemplateInstallerType(template);
  const payload = {
    id,
    type: template.instanceType || "custom-command",
    displayName: `Contract update probe ${entry.family}`,
    workingDirectory: "data",
    executable: "bash",
    args: ["-lc", "true"],
    tags: Array.isArray(template.tags) ? template.tags : [],
  };
  if (installerType === STEAMCMD_INSTALLER_TYPE) {
    payload.installerType = STEAMCMD_INSTALLER_TYPE;
    payload.steamAppId = Number(template.installer?.appId || template.downloadSource?.appId);
    payload.steamInstallDir = String(template.installer?.installDir || "server");
    payload.steamVerifyFiles = Array.isArray(template.installer?.verifyFiles)
      ? template.installer.verifyFiles
      : [];
  }
  await instanceService.createInstance(payload);
  const operationId = `op-steam-update-${index}`;
  try {
    await instanceService.beginSteamCmdUpdateSession(id, { operationId });
    return true;
  } catch (error) {
    if (error && error.code === "STEAMCMD_UPDATE_UNSUPPORTED") return false;
    throw error;
  }
}

// Resolver -> "does the resolver return a version". Derived by splitting the
// marketplace service into top-level functions and checking each resolver's body
// for a returned version field. Both the shorthand (`{ url, version }`) and the
// explicit (`version: ...`) form are accepted. This is ANCHOR-grade: it reads a
// named file.
function deriveResolversReturningVersion(source) {
  const chunks = source.split(/\n(?=(?:async )?function )/);
  const returnsVersion = new Set();
  for (const chunk of chunks) {
    const name = chunk.match(/^(?:async )?function\s+([A-Za-z0-9_]+)\s*\(/);
    if (!name || !/^resolve[A-Za-z0-9]+Download$/.test(name[1])) continue;
    if (/(?:^|[^A-Za-z0-9_])version\s*[,:]/.test(chunk)) returnsVersion.add(name[1]);
  }
  assert(
    returnsVersion.size > 0,
    "No *Download resolver returning a version field was found in the marketplace service.",
  );
  return returnsVersion;
}

function deriveResolverDispatch(source) {
  const dispatch = new Map();
  // Several resolvers share one branch (`resolver === "fivem-linux" ||
  // resolver === "fivem-windows"`), so the condition is scanned for every
  // resolver name it mentions rather than only the last one.
  const returnPattern = /return\s+(resolve[A-Za-z0-9]+)\s*\(\s*download/g;
  let match = returnPattern.exec(source);
  while (match) {
    const window = source.slice(Math.max(0, match.index - 400), match.index);
    const ifStart = window.lastIndexOf("if (");
    if (ifStart !== -1) {
      const condition = window.slice(ifStart);
      const names = [...condition.matchAll(/download\.resolver\s*===\s*"([a-z0-9-]+)"/g)]
        .map((entry) => entry[1]);
      for (const name of names) dispatch.set(name, match[1]);
    }
    match = returnPattern.exec(source);
  }
  assert(dispatch.size > 0, "No download-resolver dispatch entries were found in the marketplace service.");
  return dispatch;
}

function configCapabilitiesFromAdapter(adapterId) {
  if (!adapterId) {
    return {
      "config.adapter": contract.STATUS.NO,
      "config.resolvePath": contract.STATUS.NO,
      "config.write": contract.STATUS.NO,
      "config.secrets": contract.STATUS.NO,
      "config.restartRequired": contract.STATUS.NO,
      "config.validation": contract.STATUS.NO,
    };
  }
  const adapter = manager.ADAPTERS[adapterId];
  const model = manager.buildConfigModel(adapterId, "");
  assert.strictEqual(model.supported, true, `buildConfigModel must support adapter "${adapterId}".`);
  const hasValidation = adapter.fields.some((field) => (
    field.required
    || Boolean(field.validation)
    || field.min !== null
    || field.max !== null
    || Array.isArray(field.allowedValues)
  ));
  return {
    "config.adapter": contract.STATUS.YES,
    "config.resolvePath": contract.STATUS.YES,
    "config.write": contract.STATUS.YES,
    "config.secrets": adapter.fields.some((field) => field.sensitive)
      ? contract.STATUS.YES
      : contract.STATUS.NO,
    "config.restartRequired": adapter.fields.some((field) => field.restartRequired)
      ? contract.STATUS.YES
      : contract.STATUS.NO,
    "config.validation": hasValidation ? contract.STATUS.YES : contract.STATUS.NO,
  };
}

async function deriveAll() {
  const instanceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-adapter-contract-"));
  instanceService.configureInstanceService({ getConfig: () => ({ instanceRoot }) });

  // --- LIVE: installer families the core will accept for a session ----------
  const installerFamilies = {};
  let probeIndex = 0;
  for (const family of INSTALLER_SESSION_FAMILIES) {
    probeIndex += 1;
    installerFamilies[family] = await probeInstallerFamily(instanceRoot, family, probeIndex);
  }
  assert.strictEqual(installerFamilies.forge, true, "forge must be an allowed installer family.");
  assert.strictEqual(installerFamilies.neoforge, true, "neoforge must be an allowed installer family.");
  assert.strictEqual(installerFamilies.quilt, true, "quilt must be an allowed installer family.");
  assert.strictEqual(
    installerFamilies["steamcmd-update"],
    false,
    "steamcmd-update must not be an allowed installation-session family (documented divergence D-3).",
  );
  requireNeedle(CORE_SOURCE, "forge-installer.jar", "installer phases are Minecraft installers");
  requireNeedle(CORE_SOURCE, "neoforge-installer.jar", "installer phases are Minecraft installers");
  requireNeedle(CORE_SOURCE, "quilt-installer.jar", "installer phases are Minecraft installers");

  // --- ANCHOR: the shared readiness signal ---------------------------------
  requireNeedle(CORE_SOURCE, "Server marked as running", "shared readiness log pattern");
  requireNeedle(CORE_SOURCE, "readinessPortTimer", "shared readiness port probe");
  const hasSharedReadinessSignal = true;

  // --- ANCHOR: version paths ----------------------------------------------
  requireNeedle(CORE_SOURCE, "detectInstanceVersion", "post-install version detection");
  requireNeedle(CORE_SOURCE, "\"metadata.json\"", "version detection reads install metadata");
  requireNeedle(CORE_SOURCE, "detectFromMinecraftStatus", "Minecraft status-ping version detection");
  requireNeedle(MARKETPLACE_SOURCE, "appmanifest_", "SteamCMD app-manifest version detection");
  requireNeedle(CORE_SOURCE, "steamBuildId", "SteamCMD build pinning");
  requireNeedle(CORE_SOURCE, "buildIdBefore", "SteamCMD build comparison");
  requireNeedle(CORE_SOURCE, "buildIdAfter", "SteamCMD build comparison");
  requireNeedle(CORE_SOURCE, "steamAppId", "SteamCMD version identity");
  requireNeedle(CORE_SOURCE, "FIVEM_LICENSE_FAILURE_PATTERN", "FiveM runtime license classification");
  requireNeedle(CORE_SOURCE, "isBenignPalworldStderrOutput", "Palworld stderr classification");

  // --- ANCHOR: no rollback exists anywhere in the update path --------------
  const updateRegion = CORE_SOURCE.slice(
    CORE_SOURCE.indexOf("async function beginSteamCmdUpdateSession"),
    CORE_SOURCE.indexOf("async function executeSteamCmdUpdate"),
  );
  assert(updateRegion.length > 0, "The SteamCMD update region must be locatable.");
  assert(
    !/rollback/i.test(updateRegion),
    "A rollback path appeared in the SteamCMD update region. Update the contract's update.rollback rows.",
  );

  const resolversReturningVersion = deriveResolversReturningVersion(MARKETPLACE_SOURCE);
  const resolverDispatch = deriveResolverDispatch(MARKETPLACE_SOURCE);

  const capabilities = {};
  const context = {};

  for (const entry of SHIPPED) {
    const template = templateFor(entry.templateId);
    const sample = sampleConfig(entry);
    const adapterId = instanceService._test.inferConfigAdapterId(sample);
    const adapter = adapterId ? manager.ADAPTERS[adapterId] : null;
    const installerType = installerRegistry.getTemplateInstallerType(template);
    const isSteamCmd = installerType === STEAMCMD_INSTALLER_TYPE;

    // LIST: what the shared world-scope map says for this family.
    const worldScope = instanceService.getWorldScopeCandidates(sample);

    // ANCHOR + RULE: does the family's install resolve a concrete version?
    const configurationSchema = Array.isArray(template.configurationSchema) ? template.configurationSchema : [];
    const primaryResolver = template.downloads?.[0]?.resolver || template.downloadSource?.resolver || null;
    const resolverFunction = primaryResolver ? resolverDispatch.get(primaryResolver) : null;
    if (primaryResolver) {
      // If a template names a resolver the dispatch table does not know, the
      // "does this install resolve a version" derivation is unreliable, so the
      // gate fails rather than guessing.
      assert(
        resolverFunction,
        `Resolver "${primaryResolver}" is not dispatched to a known *Download resolver in the marketplace service.`,
      );
    }
    const resolvesVersionAtInstall = configurationSchema.includes("version")
      || Boolean(resolverFunction && resolversReturningVersion.has(resolverFunction));

    // RULE: which families consume the core's installer sessions and which can
    // re-derive a version from the installed artifact. Both mappings are stated
    // here rather than inferred, and both of their inputs are gated above by the
    // installer-family probes and the source anchors.
    const hasInstallerSessionPhases = entry.family === "minecraft";
    const detectsFromArtifact = isSteamCmd
      ? true
      : entry.family === "minecraft" && CORE_SOURCE.includes("detectFromJars(");

    capabilities[entry.family] = {
      ...configCapabilitiesFromAdapter(adapterId),
      "install.provision": installerRegistry.SUPPORTED_INSTALLER_TYPES.has(installerType)
        && installerType !== "no-install"
        ? contract.STATUS.YES
        : contract.STATUS.NO,
      "install.artifactVerify": verifyFileCount(template) > 0
        ? contract.STATUS.YES
        : contract.STATUS.NO,
      "install.sessionPhases": hasInstallerSessionPhases ? contract.STATUS.YES : contract.STATUS.NO,
      "lifecycle.startStop": instanceService.INSTANCE_TYPES.includes(template.instanceType)
        ? contract.STATUS.YES
        : contract.STATUS.NO,
      "lifecycle.logs": typeof instanceService.readLogs === "function" ? contract.STATUS.YES : contract.STATUS.NO,
      "lifecycle.metrics": typeof instanceService.getMetrics === "function" ? contract.STATUS.YES : contract.STATUS.NO,
      "readiness.signal": hasSharedReadinessSignal ? contract.STATUS.YES : contract.STATUS.NO,
      "readiness.gate": contract.STATUS.NO,
      "readiness.gameSpecific": contract.STATUS.NO,
      "version.resolveAtInstall": resolvesVersionAtInstall ? contract.STATUS.YES : contract.STATUS.NO,
      "version.detect": CORE_SOURCE.includes("\"metadata.json\"") ? contract.STATUS.YES : contract.STATUS.NO,
      "version.detectFromArtifact": detectsFromArtifact ? contract.STATUS.YES : contract.STATUS.NO,
      "version.pin": isSteamCmd ? contract.STATUS.YES : contract.STATUS.NO,
      "update.inPlace": contract.STATUS.NO,
      "update.rollback": contract.STATUS.NO,
      "backup.worldScope": worldScope.length > 0 ? contract.STATUS.YES : contract.STATUS.NO,
    };

    context[entry.family] = {
      adapterId,
      installerType,
      template,
      inventory: {
        kind: adapter ? "config adapter + family" : "family only",
        installerType,
        hasConfigAdapter: Boolean(adapter),
        format: adapter ? adapter.format : "none",
        defaultFilePath: adapter ? adapter.defaultFilePath : "none",
        fieldCount: adapter ? adapter.fields.length : 0,
        secretCount: adapter ? adapter.fields.filter((field) => field.sensitive).length : 0,
        restartRequiredCount: adapter ? adapter.fields.filter((field) => field.restartRequired).length : 0,
      },
    };
  }

  // --- LIVE: readiness gate and game-specific readiness --------------------
  for (const entry of SHIPPED) {
    const sample = sampleConfig(entry);
    const adapterId = context[entry.family].adapterId;
    const adapter = adapterId ? manager.ADAPTERS[adapterId] : null;
    // The write-guarded FiveM resolver walks the instance's real ancestors, so
    // the instance directory has to exist for the candidate list to resolve.
    fs.mkdirSync(path.join(instanceRoot, sample.id, "data"), { recursive: true });
    const resolved = adapter
      ? await instanceService._test.resolveExistingGameConfigPath(sample, adapterId)
      : null;
    context[entry.family].pathCandidates = resolved ? resolved.candidates : [];

    const readiness = await instanceService._test.evaluateFiveMReadiness(sample);
    const gate = entry.family === "fivem"
      ? readiness.reasonCode !== "NOT_FIVEM" && readiness.setupRequired === true
      : readiness.reasonCode !== "NOT_FIVEM";
    capabilities[entry.family]["readiness.gate"] = gate ? contract.STATUS.YES : contract.STATUS.NO;

    // Palworld's stderr filter is family-gated: it returns true for the known
    // benign SteamAPI line on a Palworld config and false on every other family.
    const benignLine = "[S_API] SteamAPI_Init(): Loaded local 'steamclient.so' OK.";
    const palworldFilter = instanceService._test.isBenignPalworldStderrOutput(sample, benignLine);
    const gameSpecific = entry.family === "palworld"
      ? palworldFilter === true
      : entry.family === "fivem"
        ? CORE_SOURCE.includes("FIVEM_LICENSE_FAILURE_PATTERN")
        : false;
    capabilities[entry.family]["readiness.gameSpecific"] = gameSpecific
      ? contract.STATUS.YES
      : contract.STATUS.NO;
  }

  // --- LIVE: in-place update support --------------------------------------
  probeIndex = 0;
  for (const entry of SHIPPED) {
    probeIndex += 1;
    const supported = await probeSteamCmdUpdateSupport(instanceRoot, entry, probeIndex);
    const expectsSteamCmd = context[entry.family].installerType === STEAMCMD_INSTALLER_TYPE;
    assert.strictEqual(
      supported,
      expectsSteamCmd,
      `In-place update support for "${entry.family}" must match its installer type.`,
    );
    capabilities[entry.family]["update.inPlace"] = supported ? contract.STATUS.YES : contract.STATUS.NO;
  }

  // The family list in this smoke must match the shipped adapter list.
  assert.deepStrictEqual(
    SHIPPED.map((entry) => entry.family).sort(),
    [...contract.SHIPPED_ADAPTER_IDS].sort(),
    "This smoke must cover exactly the shipped adapters the contract claims.",
  );

  return { instanceRoot, capabilities, context };
}

// ---------------------------------------------------------------------------
// The drift gate
// ---------------------------------------------------------------------------

function testDerivedStatusMatchesContract(derived) {
  const diff = contract.diffAdapterContractStatus(derived.capabilities);
  assert.strictEqual(
    diff.ok,
    true,
    `Derived capability status disagrees with the contract:\n${diff.mismatches
      .map((item) => `  ${item.adapterId} ${item.capability}: claimed=${item.claimed} observed=${item.observed} (${item.code})`)
      .join("\n")}`,
  );
  assert.deepStrictEqual(diff.comparedAdapters.sort(), [...contract.SHIPPED_ADAPTER_IDS].sort());
}

function parseDocumentMatrix(source) {
  const start = source.indexOf("<!-- contract-matrix:start -->");
  const end = source.indexOf("<!-- contract-matrix:end -->");
  assert(start !== -1, "The contract document must carry a contract-matrix:start marker.");
  assert(end > start, "The contract document must carry a contract-matrix:end marker after the start marker.");
  const block = source.slice(start, end);
  const matrix = {};
  let current = null;
  for (const rawLine of block.split(/\r?\n/)) {
    const heading = rawLine.match(/^####\s+([a-z0-9_-]+)\s*$/);
    if (heading) {
      current = heading[1];
      matrix[current] = {};
      continue;
    }
    if (!current) continue;
    const row = rawLine.match(/^\|\s*([A-Za-z][A-Za-z0-9._-]*)\s*\|\s*(YES|NO|UNPROVEN)\s*\|/);
    if (row) matrix[current][row[1]] = row[2];
  }
  return matrix;
}

function testDocumentMatchesContract() {
  const matrix = parseDocumentMatrix(DOC_SOURCE);
  const capabilityIds = Object.keys(contract.CAPABILITIES);
  for (const adapterId of contract.SHIPPED_ADAPTER_IDS) {
    const rows = matrix[adapterId];
    assert(rows, `The document matrix is missing a table for shipped adapter "${adapterId}".`);
    const claimed = contract.ADAPTER_CONTRACT_STATUS[adapterId];
    for (const capabilityId of capabilityIds) {
      assert(
        rows[capabilityId],
        `The document matrix is missing the row for ${adapterId} / ${capabilityId}.`,
      );
      assert.strictEqual(
        rows[capabilityId],
        claimed[capabilityId],
        `Document row ${adapterId} / ${capabilityId} says ${rows[capabilityId]} but the contract module says ${claimed[capabilityId]}.`,
      );
    }
    const documentedExtras = Object.keys(rows).filter((id) => !capabilityIds.includes(id));
    assert.deepStrictEqual(
      documentedExtras,
      [],
      `Document matrix for ${adapterId} documents capabilities outside the contract vocabulary.`,
    );
  }
  const documentedAdapters = Object.keys(matrix);
  assert.deepStrictEqual(
    documentedAdapters.sort(),
    [...contract.SHIPPED_ADAPTER_IDS].sort(),
    "The document matrix must cover exactly the shipped adapters.",
  );
}

function parseDocumentInventory(source) {
  const start = source.indexOf("<!-- contract-inventory:start -->");
  const end = source.indexOf("<!-- contract-inventory:end -->");
  assert(start !== -1, "The contract document must carry a contract-inventory:start marker.");
  assert(end > start, "The contract document must carry a contract-inventory:end marker.");
  const block = source.slice(start, end);
  const rows = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const values = rawLine.split("|").map((cell) => cell.trim()).slice(1, -1);
    if (values.length !== 7) continue;
    if (!/^[a-z][a-z0-9_-]*$/.test(values[0])) continue;
    const counts = values[6].match(/^(\d+)\s*\(\s*(\d+)\s*\/\s*(\d+)\s*\)$/);
    if (!counts) continue;
    rows[values[0]] = {
      kind: values[1],
      installerType: values[2],
      hasConfigAdapter: values[3] === "yes",
      format: values[4],
      defaultFilePath: values[5],
      fieldCount: Number(counts[1]),
      secretCount: Number(counts[2]),
      restartRequiredCount: Number(counts[3]),
    };
  }
  return rows;
}

// The inventory table is a second machine-checked surface: adapter identity,
// installer type, format, default path and field counts must all match the code.
function testInventoryMatchesCode(derived) {
  const documented = parseDocumentInventory(DOC_SOURCE);
  for (const adapterId of contract.SHIPPED_ADAPTER_IDS) {
    const row = documented[adapterId];
    assert(row, `The document inventory is missing a row for "${adapterId}".`);
    const actual = derived.context[adapterId].inventory;
    for (const key of Object.keys(actual)) {
      assert.strictEqual(
        row[key],
        actual[key],
        `Inventory row ${adapterId}.${key} says ${JSON.stringify(row[key])} but the shipped code shows ${JSON.stringify(actual[key])}.`,
      );
    }
  }
  assert.deepStrictEqual(
    Object.keys(documented).sort(),
    [...contract.SHIPPED_ADAPTER_IDS].sort(),
    "The document inventory must cover exactly the shipped adapters.",
  );
}

// ---------------------------------------------------------------------------
// Validator behaviour
// ---------------------------------------------------------------------------

function definitionFor(family, derived) {
  const context = derived.context[family];
  const adapterId = context.adapterId;
  const adapter = adapterId ? manager.ADAPTERS[adapterId] : null;
  // The validator's definition shape claims a capability with a boolean. The
  // derived map is three-valued, so only YES becomes a claim: NO is an absence
  // and UNPROVEN is explicitly not a claim either.
  const capabilities = {};
  for (const [capabilityId, status] of Object.entries(derived.capabilities[family])) {
    capabilities[capabilityId] = status === contract.STATUS.YES;
  }
  return {
    id: family,
    label: context.template.displayName || family,
    capabilities,
    config: adapter
      ? {
        adapterId,
        format: adapter.format,
        defaultFilePath: adapter.defaultFilePath,
        fieldCount: adapter.fields.length,
        pathCandidates: context.pathCandidates,
      }
      : undefined,
    install: { installerType: context.installerType },
    readiness: { mode: "port-or-log" },
  };
}

function testValidatorAcceptsCompleteDefinition(derived) {
  for (const family of CONFIG_ADAPTER_FAMILIES) {
    const verdict = contract.validateAdapterContract(definitionFor(family, derived));
    assert.strictEqual(
      verdict.ok,
      true,
      `A definition for "${family}" that meets the contract must be accepted. Violations: ${JSON.stringify(verdict.violations)}`,
    );
    assert.deepStrictEqual(verdict.missingRequired, []);
    assert.strictEqual(verdict.adapterId, family);
    assert(
      verdict.satisfiedRequired.length === contract.REQUIRED_CAPABILITIES.length,
      `"${family}" must satisfy every required capability.`,
    );
  }
}

function testValidatorRefusesMissingFamily(derived) {
  const expectedMissing = ["config.adapter", "config.resolvePath", "config.write"].sort();
  for (const family of FAMILIES_WITHOUT_CONFIG_ADAPTER) {
    const verdict = contract.validateAdapterContract(definitionFor(family, derived));
    assert.strictEqual(
      verdict.ok,
      false,
      `"${family}" has no config adapter and must not be accepted as a contract-satisfying adapter (documented divergence D-5).`,
    );
    assert.deepStrictEqual(
      [...verdict.missingRequired].sort(),
      expectedMissing,
      `"${family}" must be refused for exactly the missing configuration capabilities.`,
    );
  }
}

function testValidatorRefusesEachMissingRequiredCapability(derived) {
  const base = definitionFor("minecraft", derived);
  for (const capabilityId of contract.REQUIRED_CAPABILITIES) {
    const definition = { ...base, capabilities: { ...base.capabilities } };
    delete definition.capabilities[capabilityId];
    const verdict = contract.validateAdapterContract(definition);
    assert.strictEqual(verdict.ok, false, `Removing required capability "${capabilityId}" must be refused.`);
    assert(
      verdict.missingRequired.includes(capabilityId),
      `The verdict must name the missing capability "${capabilityId}".`,
    );
    assert(
      verdict.codes.includes("CAPABILITY_MISSING"),
      "The verdict must code the refusal as CAPABILITY_MISSING.",
    );
    assert(
      verdict.violations.some((item) => item.capability === capabilityId && item.message.includes(capabilityId)),
      `The verdict message must name the missing capability "${capabilityId}".`,
    );
  }
}

function testValidatorRefusesMalformedSections(derived) {
  const base = definitionFor("minecraft", derived);

  const badFormat = { ...base, config: { ...base.config, format: "ini" } };
  assert.strictEqual(contract.validateAdapterContract(badFormat).ok, false);
  assert(contract.validateAdapterContract(badFormat).codes.includes("CONFIG_FORMAT_UNSUPPORTED"));

  const noFields = { ...base, config: { ...base.config, fieldCount: 0 } };
  assert.strictEqual(contract.validateAdapterContract(noFields).ok, false);
  assert(contract.validateAdapterContract(noFields).codes.includes("CONFIG_FIELDS_EMPTY"));

  const noPath = { ...base, config: { ...base.config, defaultFilePath: "" } };
  assert.strictEqual(contract.validateAdapterContract(noPath).ok, false);
  assert(contract.validateAdapterContract(noPath).codes.includes("CONFIG_DEFAULT_PATH_MISSING"));

  const badInstaller = { ...base, install: { installerType: "carrier-pigeon" } };
  assert.strictEqual(contract.validateAdapterContract(badInstaller).ok, false);
  assert(contract.validateAdapterContract(badInstaller).codes.includes("INSTALLER_TYPE_UNSUPPORTED"));

  const badReadiness = { ...base, readiness: { mode: "vibes" } };
  assert.strictEqual(contract.validateAdapterContract(badReadiness).ok, false);
  assert(contract.validateAdapterContract(badReadiness).codes.includes("READINESS_MODE_UNSUPPORTED"));

  const noId = { ...base, id: "" };
  assert(contract.validateAdapterContract(noId).codes.includes("ADAPTER_ID_MISSING"));

  const noLabel = { ...base, label: "" };
  assert(contract.validateAdapterContract(noLabel).codes.includes("ADAPTER_LABEL_MISSING"));

  const noCapabilities = { ...base, capabilities: null };
  assert(contract.validateAdapterContract(noCapabilities).codes.includes("CAPABILITIES_NOT_OBJECT"));

  const unknownCapability = {
    ...base,
    capabilities: { ...base.capabilities, "config.telepathy": true },
  };
  assert(contract.validateAdapterContract(unknownCapability).codes.includes("CAPABILITY_UNKNOWN"));

  const missingCandidates = { ...base, config: { ...base.config, pathCandidates: [] } };
  assert(contract.validateAdapterContract(missingCandidates).codes.includes("CONFIG_PATH_CANDIDATES_MISSING"));

  assert.strictEqual(contract.validateAdapterContract(null).ok, false);
  assert.strictEqual(contract.validateAdapterContract(undefined).ok, false);
}

// Teeth: the validator must refuse rather than always accept. Re-running the
// real adapters against an extended required set proves the required set is
// actually consulted, and proving the refusal with the real definitions is
// stronger than proving it with a synthetic one.
function testValidatorTeeth(derived) {
  for (const family of CONFIG_ADAPTER_FAMILIES) {
    const base = definitionFor(family, derived);

    const extended = contract.validateAdapterContract(base, {
      requiredCapabilities: [...contract.REQUIRED_CAPABILITIES, "update.rollback"],
    });
    assert.strictEqual(
      extended.ok,
      false,
      `With update.rollback required, "${family}" must be refused (no adapter has a rollback path).`,
    );
    assert.deepStrictEqual(extended.missingRequired, ["update.rollback"]);
    assert(extended.codes.includes("CAPABILITY_MISSING"));

    const satisfied = contract.validateAdapterContract(
      { ...base, capabilities: { ...base.capabilities, "update.rollback": true } },
      { requiredCapabilities: [...contract.REQUIRED_CAPABILITIES, "update.rollback"] },
    );
    assert.strictEqual(
      satisfied.ok,
      true,
      `Claiming the extra capability must satisfy the extended required set for "${family}".`,
    );

    const undefinedCapability = contract.validateAdapterContract(base, {
      requiredCapabilities: [...contract.REQUIRED_CAPABILITIES, "config.telepathy"],
    });
    assert.strictEqual(undefinedCapability.ok, false);
    assert(undefinedCapability.codes.includes("REQUIRED_CAPABILITY_UNDEFINED"));
  }
}

// ---------------------------------------------------------------------------

async function main() {
  testVerifyFileCountHelper();
  const description = testVocabulary();
  console.log(
    `game-adapter-contract: ${description.requiredCapabilities.length} required, `
      + `${description.optionalCapabilities.length} optional, ${description.shippedAdapterIds.length} shipped adapters`,
  );

  const derived = await deriveAll();
  testDerivedStatusMatchesContract(derived);
  testDocumentMatchesContract();
  testInventoryMatchesCode(derived);
  testValidatorAcceptsCompleteDefinition(derived);
  testValidatorRefusesMissingFamily(derived);
  testValidatorRefusesEachMissingRequiredCapability(derived);
  testValidatorRefusesMalformedSections(derived);
  testValidatorTeeth(derived);

  console.log("game-adapter-contract smoke passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
