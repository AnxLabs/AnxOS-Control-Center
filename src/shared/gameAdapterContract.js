"use strict";

// V2-E bullet 1 — the game-adapter contract, machine-checkable half.
//
// docs/v2/V2E_GAME_ADAPTER_CONTRACT.md states the contract in prose and carries
// the per-adapter capability matrix. This module carries the same REQUIRED /
// OPTIONAL capability split and the same per-adapter status table in a form a
// validator can check, plus validateAdapterContract() for a candidate adapter
// definition.
//
// The gate that keeps document, module and shipped code from drifting apart is
// scripts/game-adapter-contract-smoke.js. It derives each capability from the
// real adapters and compares the result against ADAPTER_CONTRACT_STATUS here
// and against the matrix in the document.
//
// This file must stay dependency-free: Electron Builder copies src/shared/**/*
// into the standalone agent runtime (docs/ARCHITECTURE.md:53-54), so a require
// into src/services would break that copy. Mirrored constants are therefore
// declared here and drift-checked by the smoke instead of being imported.

const CONTRACT_VERSION = 1;

// The six areas named by the roadmap bullet (docs/MASTER_ROADMAP.md:212), plus
// one documented extension area. Every capability belongs to exactly one area.
const CONTRACT_AREAS = Object.freeze([
  "installation",
  "versions",
  "configuration",
  "lifecycle",
  "readiness",
  "updates",
  "persistence",
]);

const STATUS = Object.freeze({
  YES: "YES",
  NO: "NO",
  UNPROVEN: "UNPROVEN",
});

const STATUS_VALUES = Object.freeze([STATUS.YES, STATUS.NO, STATUS.UNPROVEN]);

// Capability vocabulary. `required: true` means the instance core cannot serve
// the adapter at all without it — validateAdapterContract() refuses a
// definition that omits one. `required: false` means the adapter is fully
// operable without it; the capability matrix records which shipped adapters
// have it.
const CAPABILITIES = Object.freeze({
  "install.provision": Object.freeze({
    area: "installation",
    required: true,
    description: "Declares how an instance of this game is obtained: a supported installer type, or an explicit no-install path.",
  }),
  "install.artifactVerify": Object.freeze({
    area: "installation",
    required: false,
    description: "Declares post-install artifact verification candidates, so an installer that exits 0 without producing the runtime is still detected as failed.",
  }),
  "install.sessionPhases": Object.freeze({
    area: "installation",
    required: false,
    description: "Installation is driven through the agent installation-session protocol with a named installer family and phase.",
  }),
  "config.adapter": Object.freeze({
    area: "configuration",
    required: true,
    description: "Resolves in the config adapter registry with a supported format, a non-empty field set and a default file path.",
  }),
  "config.resolvePath": Object.freeze({
    area: "configuration",
    required: true,
    description: "Has an in-instance config path resolver, so the editor can find the file before it exists.",
  }),
  "config.write": Object.freeze({
    area: "configuration",
    required: true,
    description: "Implements the parse, read, validate and serialize round-trip for its declared format.",
  }),
  "config.secrets": Object.freeze({
    area: "configuration",
    required: false,
    description: "Declares at least one sensitive field, which is redacted before the value reaches the renderer.",
  }),
  "config.restartRequired": Object.freeze({
    area: "configuration",
    required: false,
    description: "Marks the fields whose change requires an instance restart after save.",
  }),
  "config.validation": Object.freeze({
    area: "configuration",
    required: false,
    description: "Declares field constraints that are enforced before any write.",
  }),
  "lifecycle.startStop": Object.freeze({
    area: "lifecycle",
    required: true,
    description: "Maps to an instance type the core can start, stop and restart.",
  }),
  "lifecycle.logs": Object.freeze({
    area: "lifecycle",
    required: true,
    description: "Console output is captured and readable. Provided generically for every instance type.",
  }),
  "lifecycle.metrics": Object.freeze({
    area: "lifecycle",
    required: true,
    description: "Process metrics are reported. Provided generically for every instance type.",
  }),
  "readiness.signal": Object.freeze({
    area: "readiness",
    required: true,
    description: "Readiness is observable. Every instance type gets the shared port probe and log-pattern signal.",
  }),
  "readiness.gate": Object.freeze({
    area: "readiness",
    required: false,
    description: "A pre-start readiness gate can block startup until the adapter's own prerequisites are satisfied.",
  }),
  "readiness.gameSpecific": Object.freeze({
    area: "readiness",
    required: false,
    description: "The adapter contributes behaviour beyond the shared readiness signal: its own failure classification, timeout policy or stderr filtering.",
  }),
  "version.resolveAtInstall": Object.freeze({
    area: "versions",
    required: false,
    description: "Install resolves a concrete artifact version and persists it into instance version metadata.",
  }),
  "version.detect": Object.freeze({
    area: "versions",
    required: false,
    description: "A post-install version detection path exists for the family.",
  }),
  "version.detectFromArtifact": Object.freeze({
    area: "versions",
    required: false,
    description: "Version is re-derived from the installed artifact or its manifest, rather than re-read from install-written metadata.",
  }),
  "version.pin": Object.freeze({
    area: "versions",
    required: false,
    description: "A durable version identity is persisted and a later operation compares against it.",
  }),
  "update.inPlace": Object.freeze({
    area: "updates",
    required: false,
    description: "An in-place update operation exists for the adapter.",
  }),
  "update.rollback": Object.freeze({
    area: "updates",
    required: false,
    description: "A rollback path exists for a failed update.",
  }),
  "backup.worldScope": Object.freeze({
    area: "persistence",
    required: false,
    description: "Declares the instance-relative save-data directories a world backup must capture. Extension area beyond the six roadmap areas.",
  }),
});

const REQUIRED_CAPABILITIES = Object.freeze(
  Object.keys(CAPABILITIES).filter((id) => CAPABILITIES[id].required),
);

const OPTIONAL_CAPABILITIES = Object.freeze(
  Object.keys(CAPABILITIES).filter((id) => !CAPABILITIES[id].required),
);

// Mirrors the format switch in src/shared/gameServerConfigManager.js:590-606.
// A format outside this set silently falls through to the properties parser,
// which is a real trap: the write would appear to succeed while producing the
// wrong document. Drift-checked by the smoke.
const SUPPORTED_CONFIG_FORMATS = Object.freeze([
  "properties",
  "palworld-options",
  "fivem-cfg",
]);

// Mirrors the readiness signals the core actually implements:
// port probe src/shared/instances/instanceServiceCore.js:5303-5345,
// log pattern src/shared/instances/instanceServiceCore.js:5089.
const SUPPORTED_READINESS_MODES = Object.freeze([
  "port",
  "log",
  "port-or-log",
  "external-gate",
]);

// Mirrors SUPPORTED_INSTALLER_TYPES in src/services/marketplaceInstallerRegistry.js:1-11.
// Declared here rather than imported to keep this module free of src/services
// dependencies (see the header). The smoke asserts the two sets are equal.
const SUPPORTED_INSTALLER_TYPES = Object.freeze([
  "archive-download",
  "curseforge",
  "direct-download",
  "docker-image",
  "java-runtime",
  "local-import",
  "no-install",
  "provider-download",
  "steamcmd-native",
]);

// The documented per-adapter status table (docs/v2/V2E_GAME_ADAPTER_CONTRACT.md
// §5.2). YES = the code shows it today, NO = the code shows it is absent,
// UNPROVEN = the code does not settle the question either way. Nothing here is
// a claim about a live server; every row is a code-path claim.
const ADAPTER_CONTRACT_STATUS = Object.freeze({
  minecraft: Object.freeze({
    "install.provision": STATUS.YES,
    "install.artifactVerify": STATUS.NO,
    "install.sessionPhases": STATUS.YES,
    "config.adapter": STATUS.YES,
    "config.resolvePath": STATUS.YES,
    "config.write": STATUS.YES,
    "config.secrets": STATUS.NO,
    "config.restartRequired": STATUS.YES,
    "config.validation": STATUS.YES,
    "lifecycle.startStop": STATUS.YES,
    "lifecycle.logs": STATUS.YES,
    "lifecycle.metrics": STATUS.YES,
    "readiness.signal": STATUS.YES,
    "readiness.gate": STATUS.NO,
    "readiness.gameSpecific": STATUS.NO,
    "version.resolveAtInstall": STATUS.YES,
    "version.detect": STATUS.YES,
    "version.detectFromArtifact": STATUS.YES,
    "version.pin": STATUS.NO,
    "update.inPlace": STATUS.NO,
    "update.rollback": STATUS.NO,
    "backup.worldScope": STATUS.NO,
  }),
  palworld: Object.freeze({
    "install.provision": STATUS.YES,
    "install.artifactVerify": STATUS.YES,
    "install.sessionPhases": STATUS.NO,
    "config.adapter": STATUS.YES,
    "config.resolvePath": STATUS.YES,
    "config.write": STATUS.YES,
    "config.secrets": STATUS.YES,
    "config.restartRequired": STATUS.YES,
    "config.validation": STATUS.YES,
    "lifecycle.startStop": STATUS.YES,
    "lifecycle.logs": STATUS.YES,
    "lifecycle.metrics": STATUS.YES,
    "readiness.signal": STATUS.YES,
    "readiness.gate": STATUS.NO,
    "readiness.gameSpecific": STATUS.YES,
    "version.resolveAtInstall": STATUS.NO,
    "version.detect": STATUS.YES,
    "version.detectFromArtifact": STATUS.YES,
    "version.pin": STATUS.YES,
    "update.inPlace": STATUS.YES,
    "update.rollback": STATUS.NO,
    "backup.worldScope": STATUS.YES,
  }),
  fivem: Object.freeze({
    "install.provision": STATUS.YES,
    "install.artifactVerify": STATUS.YES,
    "install.sessionPhases": STATUS.NO,
    "config.adapter": STATUS.YES,
    "config.resolvePath": STATUS.YES,
    "config.write": STATUS.YES,
    "config.secrets": STATUS.YES,
    "config.restartRequired": STATUS.YES,
    "config.validation": STATUS.YES,
    "lifecycle.startStop": STATUS.YES,
    "lifecycle.logs": STATUS.YES,
    "lifecycle.metrics": STATUS.YES,
    "readiness.signal": STATUS.YES,
    "readiness.gate": STATUS.YES,
    "readiness.gameSpecific": STATUS.YES,
    "version.resolveAtInstall": STATUS.YES,
    "version.detect": STATUS.YES,
    "version.detectFromArtifact": STATUS.NO,
    "version.pin": STATUS.NO,
    "update.inPlace": STATUS.NO,
    "update.rollback": STATUS.NO,
    "backup.worldScope": STATUS.YES,
  }),
  terraria: Object.freeze({
    "install.provision": STATUS.YES,
    "install.artifactVerify": STATUS.YES,
    "install.sessionPhases": STATUS.NO,
    "config.adapter": STATUS.NO,
    "config.resolvePath": STATUS.NO,
    "config.write": STATUS.NO,
    "config.secrets": STATUS.NO,
    "config.restartRequired": STATUS.NO,
    "config.validation": STATUS.NO,
    "lifecycle.startStop": STATUS.YES,
    "lifecycle.logs": STATUS.YES,
    "lifecycle.metrics": STATUS.YES,
    "readiness.signal": STATUS.YES,
    "readiness.gate": STATUS.NO,
    "readiness.gameSpecific": STATUS.NO,
    "version.resolveAtInstall": STATUS.YES,
    "version.detect": STATUS.YES,
    "version.detectFromArtifact": STATUS.NO,
    "version.pin": STATUS.NO,
    "update.inPlace": STATUS.NO,
    "update.rollback": STATUS.NO,
    "backup.worldScope": STATUS.YES,
  }),
  valheim: Object.freeze({
    "install.provision": STATUS.YES,
    "install.artifactVerify": STATUS.YES,
    "install.sessionPhases": STATUS.NO,
    "config.adapter": STATUS.NO,
    "config.resolvePath": STATUS.NO,
    "config.write": STATUS.NO,
    "config.secrets": STATUS.NO,
    "config.restartRequired": STATUS.NO,
    "config.validation": STATUS.NO,
    "lifecycle.startStop": STATUS.YES,
    "lifecycle.logs": STATUS.YES,
    "lifecycle.metrics": STATUS.YES,
    "readiness.signal": STATUS.YES,
    "readiness.gate": STATUS.NO,
    "readiness.gameSpecific": STATUS.NO,
    "version.resolveAtInstall": STATUS.NO,
    "version.detect": STATUS.YES,
    "version.detectFromArtifact": STATUS.YES,
    "version.pin": STATUS.YES,
    "update.inPlace": STATUS.YES,
    "update.rollback": STATUS.NO,
    "backup.worldScope": STATUS.NO,
  }),
  rust: Object.freeze({
    "install.provision": STATUS.YES,
    "install.artifactVerify": STATUS.YES,
    "install.sessionPhases": STATUS.NO,
    "config.adapter": STATUS.NO,
    "config.resolvePath": STATUS.NO,
    "config.write": STATUS.NO,
    "config.secrets": STATUS.NO,
    "config.restartRequired": STATUS.NO,
    "config.validation": STATUS.NO,
    "lifecycle.startStop": STATUS.YES,
    "lifecycle.logs": STATUS.YES,
    "lifecycle.metrics": STATUS.YES,
    "readiness.signal": STATUS.YES,
    "readiness.gate": STATUS.NO,
    "readiness.gameSpecific": STATUS.NO,
    "version.resolveAtInstall": STATUS.NO,
    "version.detect": STATUS.YES,
    "version.detectFromArtifact": STATUS.YES,
    "version.pin": STATUS.YES,
    "update.inPlace": STATUS.YES,
    "update.rollback": STATUS.NO,
    "backup.worldScope": STATUS.NO,
  }),
  cs2: Object.freeze({
    "install.provision": STATUS.YES,
    "install.artifactVerify": STATUS.YES,
    "install.sessionPhases": STATUS.NO,
    "config.adapter": STATUS.NO,
    "config.resolvePath": STATUS.NO,
    "config.write": STATUS.NO,
    "config.secrets": STATUS.NO,
    "config.restartRequired": STATUS.NO,
    "config.validation": STATUS.NO,
    "lifecycle.startStop": STATUS.YES,
    "lifecycle.logs": STATUS.YES,
    "lifecycle.metrics": STATUS.YES,
    "readiness.signal": STATUS.YES,
    "readiness.gate": STATUS.NO,
    "readiness.gameSpecific": STATUS.NO,
    "version.resolveAtInstall": STATUS.NO,
    "version.detect": STATUS.YES,
    "version.detectFromArtifact": STATUS.YES,
    "version.pin": STATUS.YES,
    "update.inPlace": STATUS.YES,
    "update.rollback": STATUS.NO,
    "backup.worldScope": STATUS.NO,
  }),
});

const SHIPPED_ADAPTER_IDS = Object.freeze(Object.keys(ADAPTER_CONTRACT_STATUS));

// The three ids the config adapter registry actually serves
// (src/shared/gameServerConfigManager.js:222-247). The remaining shipped ids are
// families the core recognizes (src/shared/instances/instanceServiceCore.js:1685)
// but which have no configuration adapter.
const CONFIG_ADAPTER_IDS = Object.freeze(["minecraft", "palworld", "fivem"]);

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeCapabilitySet(list) {
  const output = [];
  for (const entry of Array.isArray(list) ? list : []) {
    const id = String(entry || "").trim();
    if (id && !output.includes(id)) output.push(id);
  }
  return output;
}

// Pure validator. Returns a typed verdict rather than throwing, so a caller can
// report "what is missing" without exception control flow.
//
// definition: {
//   id, label,
//   capabilities: { "<capability id>": true },
//   config:  { adapterId, format, defaultFilePath, fieldCount, pathCandidates },
//   install: { installerType },
//   readiness: { mode },
// }
//
// options.requiredCapabilities overrides the required set. It exists for the
// contract smoke, which re-runs the shipped adapters against an extended
// required set to prove the validator actually refuses.
function validateAdapterContract(definition, options = {}) {
  const input = isPlainObject(definition) ? definition : {};
  const required = normalizeCapabilitySet(
    options && options.requiredCapabilities ? options.requiredCapabilities : REQUIRED_CAPABILITIES,
  );
  const adapterId = typeof input.id === "string" && input.id.trim() ? input.id.trim() : null;
  const violations = [];

  if (!adapterId) {
    violations.push({
      capability: null,
      code: "ADAPTER_ID_MISSING",
      message: "Adapter definition must declare a non-empty string id.",
    });
  }
  if (typeof input.label !== "string" || !input.label.trim()) {
    violations.push({
      capability: null,
      code: "ADAPTER_LABEL_MISSING",
      message: "Adapter definition must declare a non-empty string label.",
    });
  }

  const capabilities = isPlainObject(input.capabilities) ? input.capabilities : null;
  if (!capabilities) {
    violations.push({
      capability: null,
      code: "CAPABILITIES_NOT_OBJECT",
      message: "Adapter definition must declare a capabilities object keyed by capability id.",
    });
  }

  const unknownCapabilities = capabilities
    ? Object.keys(capabilities).filter((id) => !Object.prototype.hasOwnProperty.call(CAPABILITIES, id))
    : [];
  for (const id of unknownCapabilities) {
    violations.push({
      capability: id,
      code: "CAPABILITY_UNKNOWN",
      message: `Capability "${id}" is not part of the game-adapter contract vocabulary.`,
    });
  }

  const missingRequired = [];
  const satisfiedRequired = [];
  for (const id of required) {
    if (!Object.prototype.hasOwnProperty.call(CAPABILITIES, id)) {
      // A caller-supplied required set may name something the vocabulary does
      // not define. That is a harness error, not an adapter defect.
      violations.push({
        capability: id,
        code: "REQUIRED_CAPABILITY_UNDEFINED",
        message: `Required capability "${id}" is not defined in the contract vocabulary.`,
      });
      continue;
    }
    const present = Boolean(capabilities && capabilities[id] === true);
    if (present) {
      satisfiedRequired.push(id);
    } else {
      missingRequired.push(id);
      violations.push({
        capability: id,
        code: "CAPABILITY_MISSING",
        message: `Required capability "${id}" (${CAPABILITIES[id].area}) is missing: ${CAPABILITIES[id].description}`,
      });
    }
  }

  const config = isPlainObject(input.config) ? input.config : null;
  if (capabilities && capabilities["config.adapter"] === true) {
    if (!config) {
      violations.push({
        capability: "config.adapter",
        code: "CONFIG_SECTION_MISSING",
        message: "config.adapter is claimed but no config section was declared.",
      });
    } else {
      const format = String(config.format || "").trim();
      if (!SUPPORTED_CONFIG_FORMATS.includes(format)) {
        violations.push({
          capability: "config.adapter",
          code: "CONFIG_FORMAT_UNSUPPORTED",
          message: `Config format "${format || "(empty)"}" is not one of ${SUPPORTED_CONFIG_FORMATS.join(", ")}; it would fall through to the properties parser.`,
        });
      }
      if (!String(config.defaultFilePath || "").trim()) {
        violations.push({
          capability: "config.adapter",
          code: "CONFIG_DEFAULT_PATH_MISSING",
          message: "config.adapter requires a non-empty defaultFilePath.",
        });
      }
      if (!Number.isInteger(config.fieldCount) || config.fieldCount < 1) {
        violations.push({
          capability: "config.adapter",
          code: "CONFIG_FIELDS_EMPTY",
          message: "config.adapter requires at least one declared field.",
        });
      }
    }
  }
  if (capabilities && capabilities["config.resolvePath"] === true
    && !(config && Array.isArray(config.pathCandidates) && config.pathCandidates.length > 0)) {
    violations.push({
      capability: "config.resolvePath",
      code: "CONFIG_PATH_CANDIDATES_MISSING",
      message: "config.resolvePath requires at least one in-instance path candidate.",
    });
  }

  const install = isPlainObject(input.install) ? input.install : null;
  if (capabilities && capabilities["install.provision"] === true) {
    if (!install) {
      violations.push({
        capability: "install.provision",
        code: "INSTALL_SECTION_MISSING",
        message: "install.provision is claimed but no install section was declared.",
      });
    } else {
      const installerType = String(install.installerType || "").trim();
      if (!SUPPORTED_INSTALLER_TYPES.includes(installerType)) {
        violations.push({
          capability: "install.provision",
          code: "INSTALLER_TYPE_UNSUPPORTED",
          message: `Installer type "${installerType || "(empty)"}" is not one the marketplace registry accepts.`,
        });
      }
    }
  }

  const readiness = isPlainObject(input.readiness) ? input.readiness : null;
  if (capabilities && capabilities["readiness.signal"] === true) {
    if (!readiness) {
      violations.push({
        capability: "readiness.signal",
        code: "READINESS_SECTION_MISSING",
        message: "readiness.signal is claimed but no readiness section was declared.",
      });
    } else {
      const mode = String(readiness.mode || "").trim();
      if (!SUPPORTED_READINESS_MODES.includes(mode)) {
        violations.push({
          capability: "readiness.signal",
          code: "READINESS_MODE_UNSUPPORTED",
          message: `Readiness mode "${mode || "(empty)"}" is not one of ${SUPPORTED_READINESS_MODES.join(", ")}.`,
        });
      }
    }
  }

  const optionalPresent = [];
  const optionalAbsent = [];
  for (const id of OPTIONAL_CAPABILITIES) {
    if (capabilities && capabilities[id] === true) {
      optionalPresent.push(id);
    } else {
      optionalAbsent.push(id);
    }
  }

  return {
    ok: violations.length === 0,
    area: "game-adapter-contract",
    contractVersion: CONTRACT_VERSION,
    adapterId,
    missingRequired,
    satisfiedRequired,
    optionalPresent,
    optionalAbsent,
    violations,
    codes: violations.map((item) => item.code),
  };
}

// Drift gate: compares an observed per-adapter capability map (derived from the
// shipped code) against ADAPTER_CONTRACT_STATUS. Returns every mismatch, so a
// removed capability or an over-claiming document row fails loudly.
function diffAdapterContractStatus(observed = {}) {
  const mismatches = [];
  const observedAdapters = isPlainObject(observed) ? observed : {};
  for (const adapterId of SHIPPED_ADAPTER_IDS) {
    const claimed = ADAPTER_CONTRACT_STATUS[adapterId];
    const actual = observedAdapters[adapterId];
    if (!isPlainObject(actual)) {
      mismatches.push({
        adapterId,
        capability: null,
        code: "ADAPTER_NOT_OBSERVED",
        claimed: null,
        observed: null,
        message: `No derived capability map was produced for shipped adapter "${adapterId}".`,
      });
      continue;
    }
    for (const capabilityId of Object.keys(CAPABILITIES)) {
      if (!Object.prototype.hasOwnProperty.call(actual, capabilityId)) {
        mismatches.push({
          adapterId,
          capability: capabilityId,
          code: "CAPABILITY_NOT_DERIVED",
          claimed: claimed[capabilityId],
          observed: null,
          message: `The derivation produced no status for "${capabilityId}".`,
        });
        continue;
      }
      if (actual[capabilityId] !== claimed[capabilityId]) {
        mismatches.push({
          adapterId,
          capability: capabilityId,
          code: "STATUS_MISMATCH",
          claimed: claimed[capabilityId],
          observed: actual[capabilityId],
          message: `Contract claims ${claimed[capabilityId]} but the shipped code shows ${actual[capabilityId]}.`,
        });
      }
    }
  }
  return {
    ok: mismatches.length === 0,
    comparedAdapters: [...SHIPPED_ADAPTER_IDS],
    mismatches,
  };
}

function describeContract() {
  return {
    contractVersion: CONTRACT_VERSION,
    areas: [...CONTRACT_AREAS],
    requiredCapabilities: [...REQUIRED_CAPABILITIES],
    optionalCapabilities: [...OPTIONAL_CAPABILITIES],
    supportedConfigFormats: [...SUPPORTED_CONFIG_FORMATS],
    supportedReadinessModes: [...SUPPORTED_READINESS_MODES],
    supportedInstallerTypes: [...SUPPORTED_INSTALLER_TYPES],
    shippedAdapterIds: [...SHIPPED_ADAPTER_IDS],
    configAdapterIds: [...CONFIG_ADAPTER_IDS],
  };
}

module.exports = {
  ADAPTER_CONTRACT_STATUS,
  CAPABILITIES,
  CONFIG_ADAPTER_IDS,
  CONTRACT_AREAS,
  CONTRACT_VERSION,
  OPTIONAL_CAPABILITIES,
  REQUIRED_CAPABILITIES,
  SHIPPED_ADAPTER_IDS,
  STATUS,
  STATUS_VALUES,
  SUPPORTED_CONFIG_FORMATS,
  SUPPORTED_INSTALLER_TYPES,
  SUPPORTED_READINESS_MODES,
  describeContract,
  diffAdapterContractStatus,
  validateAdapterContract,
};
