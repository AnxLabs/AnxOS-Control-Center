const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

const rootDir = path.resolve(__dirname, "..");
const distDir = path.resolve(process.env.ANXOS_UPDATE_MANIFEST_OUT_DIR || path.join(rootDir, "dist"));
const { getReleaseInfo } = require(path.join(rootDir, "src", "shared", "releaseConfig"));
const repositoryUrl = "https://github.com/AnxLabs/AnxOS-Control-Center-Releases";
const release = getReleaseInfo();
const defaultBaseUrl = `${repositoryUrl}/releases/download/${release.tag}`;
const baseUrl = (process.env.ANXOS_UPDATE_BASE_URL || process.env.ANXHUB_UPDATE_BASE_URL || defaultBaseUrl).replace(/\/+$/, "");

function sha256File(filePath) {
  const digest = crypto.createHash("sha256");
  const descriptor = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) digest.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return digest.digest("hex");
}

const assetDefinitions = [
  {
    key: "windows-setup",
    platform: "windows",
    packageType: "nsis",
    role: "installer",
    requiredForRelease: true,
    name: `AnxOS-Control-Center-Setup-${release.artifactVersion}.exe`,
  },
  {
    key: "windows-setup-blockmap",
    platform: "windows",
    packageType: "blockmap",
    role: "updater-metadata",
    requiredForRelease: true,
    name: `AnxOS-Control-Center-Setup-${release.artifactVersion}.exe.blockmap`,
  },
  {
    key: "windows-portable",
    platform: "windows",
    packageType: "portable",
    role: "portable",
    requiredForRelease: true,
    name: `AnxOS-Control-Center-${release.artifactVersion}-portable.exe`,
  },
  {
    key: "windows-latest-yml",
    platform: "windows",
    packageType: "latest-yml",
    role: "updater-metadata",
    requiredForRelease: true,
    name: "latest.yml",
  },
  {
    key: "linux-deb",
    platform: "linux",
    packageType: "deb",
    role: "installer",
    requiredForRelease: true,
    name: `AnxOS-Control-Center-${release.artifactVersion}.deb`,
  },
  {
    key: "linux-appimage",
    platform: "linux",
    packageType: "appimage",
    role: "portable",
    requiredForRelease: true,
    name: `AnxOS-Control-Center-${release.artifactVersion}.AppImage`,
  },
  {
    key: "linux-latest-yml",
    platform: "linux",
    packageType: "latest-yml",
    role: "updater-metadata",
    requiredForRelease: true,
    name: "latest-linux.yml",
  },
];

const expectedReleaseArtifacts = assetDefinitions.map((definition) => ({
  key: definition.key,
  name: definition.name,
  platform: definition.platform,
  packageType: definition.packageType,
  role: definition.role,
  requiredForRelease: definition.requiredForRelease,
}));

// ---------------------------------------------------------------------------
// Rollback / downgrade truth (V2-J bullet 6)
//
// The manifest used to state only that a rollback preserves user data,
// instances and backups. That is literally true and materially incomplete: the
// on-disk records carry schema versions that a downgraded build refuses to
// read. The section below separates APPLICATION rollback (the binaries get
// older) from DATA-SCHEMA rollback (the stored records do not) and reports, per
// store, the schema version this build writes, the oldest build that can read
// that schema, and whether a downgrade degrades the store.
//
// Nothing here is measured: no downgrade has ever been executed. The schema
// versions are READ FROM THE CODE at generation time; the "oldest build that
// can read it" values are declared from schema history (the git commit that
// introduced each bump, with the release.json build of that commit) and are
// voided to UNKNOWN automatically if the code's schema version no longer
// matches the version the declaration was written for.
// ---------------------------------------------------------------------------

// A store that has never been bumped is still on its first schema, so any build
// that knows the store reads it identically. That is what makes the baseline
// rule sound rather than optimistic.
const BASELINE_SCHEMA_VERSION = 1;

// Declared schema history. `declaredForSchemaVersion` pins each entry to a
// specific code state: if the code reports any other version, the declaration is
// treated as stale and the store's minimum build becomes UNKNOWN (never the
// stale number). Evidence for each declared build is the schema-bump commit and
// the release.json build committed with it; see docs/v2/V2J_RECOVERY_TARGETS.md.
const SCHEMA_STORES = [
  {
    id: "instance-config",
    component: "desktop",
    label: "Instance configuration records",
    source: "src/shared/instances/instanceServiceCore.js",
    constant: "INSTANCE_CONFIG_SCHEMA_VERSION",
    declaredMinimumBuild: 200,
    declaredForSchemaVersion: 2,
    declaredEvidence: "commit 65b5ad2 with release.json build 200 (docs/CONFIG_MIGRATIONS.md)",
    refusalCode: "INSTANCE_CONFIG_SCHEMA_UNSUPPORTED",
    refusalSource: "src/shared/instances/instanceServiceCore.js:3486",
  },
  {
    id: "node-registry",
    component: "desktop",
    label: "Node registry (nodes.json)",
    source: "src/services/nodeService.js",
    constant: "NODE_SCHEMA_VERSION",
    declaredMinimumBuild: 150,
    declaredForSchemaVersion: 3,
    declaredEvidence: "commit 48f96ba with release.json build 150",
    refusalCode: "NODE_SCHEMA_UNSUPPORTED",
    refusalSource: "src/services/nodeService.js:990",
  },
  {
    id: "node-credentials",
    component: "desktop",
    label: "Node credential store",
    source: "src/services/nodeCredentialStore.js",
    constant: "NODE_CREDENTIAL_SCHEMA_VERSION",
    declaredMinimumBuild: 150,
    declaredForSchemaVersion: 2,
    declaredEvidence: "commit 50026b5 with release.json build 150",
    refusalCode: "NODE_CREDENTIAL_SCHEMA_UNSUPPORTED",
    refusalSource: "src/services/nodeCredentialStore.js:66",
  },
  {
    id: "update-store",
    component: "desktop",
    label: "Update preferences and pending-install state",
    source: "src/services/updateManager.js",
    constant: "UPDATE_STORE_SCHEMA_VERSION",
    declaredMinimumBuild: 150,
    declaredForSchemaVersion: 2,
    declaredEvidence: "commit 9eb2b66 with release.json build 150",
    refusalCode: "UPDATE_STORE_SCHEMA_UNSUPPORTED",
    refusalSource: "src/services/updateManager.js:546",
  },
  {
    id: "marketplace-config",
    component: "desktop",
    label: "Marketplace provider configuration",
    source: "src/services/providerConfigService.js",
    constant: "MARKETPLACE_CONFIG_SCHEMA_VERSION",
    declaredMinimumBuild: 150,
    declaredForSchemaVersion: 2,
    declaredEvidence: "commit b0b8788 with release.json build 150",
    refusalCode: "MARKETPLACE_CONFIG_SCHEMA_UNSUPPORTED",
    refusalSource: "src/services/providerConfigService.js:132",
  },
  {
    id: "secure-session",
    component: "desktop",
    label: "Encrypted session state",
    source: "src/services/secureSessionStore.js",
    constant: "SECURE_SESSION_SCHEMA_VERSION",
    declaredMinimumBuild: null,
    declaredForSchemaVersion: 1,
    declaredEvidence: "never bumped (baseline schema)",
    refusalCode: "SECURE_SESSION_SCHEMA_UNSUPPORTED",
    refusalSource: "src/services/secureSessionStore.js:109",
  },
  {
    id: "agent-runtime-config",
    component: "shared",
    label: "Agent runtime configuration",
    source: "src/shared/agentRuntimeConfigStore.js",
    constant: "AGENT_RUNTIME_CONFIG_SCHEMA_VERSION",
    declaredMinimumBuild: null,
    declaredForSchemaVersion: 1,
    declaredEvidence: "never bumped (baseline schema)",
    refusalCode: "AGENT_RUNTIME_CONFIG_FUTURE_VERSION",
    refusalSource: "src/shared/agentRuntimeConfigStore.js:30",
  },
  {
    id: "agent-backup-metadata",
    component: "agent",
    label: "Backup metadata records",
    source: "agent/src/services/backupService.js",
    constant: "BACKUP_METADATA_SCHEMA_VERSION",
    declaredMinimumBuild: null,
    declaredForSchemaVersion: 1,
    declaredEvidence: "never bumped (baseline schema)",
    refusalCode: "BACKUP_METADATA_SCHEMA_UNSUPPORTED",
    refusalSource: "agent/src/services/backupService.js:676",
  },
  {
    id: "agent-backup-schedules",
    component: "agent",
    label: "Backup schedules",
    source: "agent/src/services/backupService.js",
    constant: "BACKUP_SCHEDULE_SCHEMA_VERSION",
    declaredMinimumBuild: null,
    declaredForSchemaVersion: 1,
    declaredEvidence: "never bumped (baseline schema)",
    refusalCode: "BACKUP_SCHEDULE_SCHEMA_UNSUPPORTED",
    refusalSource: "agent/src/services/backupService.js:598",
  },
  {
    id: "agent-backup-destinations",
    component: "agent",
    label: "Backup destinations",
    source: "agent/src/services/backupDestinationService.js",
    constant: "DESTINATION_SCHEMA_VERSION",
    declaredMinimumBuild: null,
    declaredForSchemaVersion: 1,
    declaredEvidence: "never bumped (baseline schema)",
    refusalCode: "BACKUP_DESTINATION_SCHEMA_UNSUPPORTED",
    refusalSource: "agent/src/services/backupDestinationService.js:248",
  },
  {
    id: "agent-device-identity",
    component: "agent",
    label: "Agent device identity",
    source: "agent/src/services/deviceIdentityService.js",
    constant: "DEVICE_IDENTITY_SCHEMA_VERSION",
    declaredMinimumBuild: 202,
    declaredForSchemaVersion: 2,
    declaredEvidence: "commit e4a12f2 with release.json build 202",
    refusalCode: "DEVICE_IDENTITY_SCHEMA_UNSUPPORTED",
    refusalSource: "agent/src/services/deviceIdentityService.js:72",
  },
];

// Scanned so that a schema-versioned store this catalogue does not enumerate is
// still reported (as uncovered) instead of silently missing from the contract.
const SCHEMA_SCAN_ROOTS = ["src", "agent/src"];
const SCHEMA_SCAN_SKIP_DIRECTORIES = new Set(["node_modules", "dist", "dist-verify", "release-artifacts"]);
const SCHEMA_CONSTANT_PATTERN = /^\s*const\s+((?:[A-Z][A-Z0-9_]*_)?SCHEMA_VERSION)\s*=\s*(\d+)\s*;/gm;

const DOWNGRADE_STATUSES = { SAFE: "SAFE", DEGRADED: "DEGRADED", UNKNOWN: "UNKNOWN" };
const DOWNGRADE_STATUS_RANK = { SAFE: 0, UNKNOWN: 1, DEGRADED: 2 };

function worstDowngradeStatus(statuses) {
  let worst = DOWNGRADE_STATUSES.SAFE;
  for (const status of statuses) {
    const normalized = DOWNGRADE_STATUSES[status] ? status : DOWNGRADE_STATUSES.UNKNOWN;
    if (DOWNGRADE_STATUS_RANK[normalized] > DOWNGRADE_STATUS_RANK[worst]) worst = normalized;
  }
  return worst;
}

function relativePath(absolutePath) {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

// Reads the schema version from the real code. Never guesses: a missing file or
// a moved/renamed constant yields an explicit reason the caller must surface as
// UNKNOWN.
function readSchemaConstant(source, constant) {
  const absolutePath = path.join(rootDir, source);
  let text;
  try {
    text = fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    return { schemaVersion: null, sourceRef: null, reason: `unreadable (${error?.code || "read failed"})` };
  }
  const pattern = new RegExp(`^\\s*const\\s+${constant}\\s*=\\s*(\\d+)\\s*;`, "m");
  const match = text.match(pattern);
  if (!match) {
    return { schemaVersion: null, sourceRef: null, reason: `constant ${constant} not declared` };
  }
  // The leading \s* may cross newlines, so cite the line of the declaration
  // itself rather than the line where the match started.
  const declarationIndex = match.index + match[0].search(/\S/);
  return {
    schemaVersion: Number.parseInt(match[1], 10),
    sourceRef: `${source}:${lineNumberAt(text, declarationIndex)} (${constant})`,
    reason: null,
  };
}

function scanSchemaConstants() {
  const found = [];
  const visit = (absolutePath) => {
    let entries;
    try {
      entries = fs.readdirSync(absolutePath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SCHEMA_SCAN_SKIP_DIRECTORIES.has(entry.name)) continue;
      const child = path.join(absolutePath, entry.name);
      if (entry.isDirectory()) {
        visit(child);
        continue;
      }
      if (!entry.name.endsWith(".js")) continue;
      let text;
      try {
        text = fs.readFileSync(child, "utf8");
      } catch {
        continue;
      }
      SCHEMA_CONSTANT_PATTERN.lastIndex = 0;
      let match;
      while ((match = SCHEMA_CONSTANT_PATTERN.exec(text)) !== null) {
        found.push({
          constant: match[1],
          schemaVersion: Number.parseInt(match[2], 10),
          source: relativePath(child),
          line: lineNumberAt(text, match.index + match[0].search(/\S/)),
        });
      }
    }
  };
  SCHEMA_SCAN_ROOTS.forEach((root) => visit(path.join(rootDir, root)));
  return found;
}

// The refusal code is what makes a degraded store "preserved but unreadable"
// rather than "data at risk". Confirm the literal still exists in the cited
// source instead of trusting the citation, which line numbers can drift past.
function verifyRefusalCode(refusalSource, refusalCode) {
  if (!refusalSource || !refusalCode) return false;
  const source = refusalSource.split(":")[0];
  try {
    return fs.readFileSync(path.join(rootDir, source), "utf8").includes(refusalCode);
  } catch {
    return false;
  }
}

// A baseline (never-bumped) store is schema-compatible in any build that knows
// the store. A bumped store needs a build at or above its declared minimum, and
// reports DEGRADED when a candidate downgrade lands below it. Everything else —
// no candidate named, no established minimum, a stale declaration, an
// unreadable source, an unverified refusal path — is UNKNOWN. SAFE is never the
// fallback.
function classifyDowngrade(store, candidateBuild) {
  if (!Number.isInteger(store.schemaVersion)) {
    return { status: DOWNGRADE_STATUSES.UNKNOWN, source: `schema version not established (${store.schemaVersionUnestablishedReason || "reason not recorded"})` };
  }
  if (store.schemaVersion <= BASELINE_SCHEMA_VERSION) {
    return { status: DOWNGRADE_STATUSES.SAFE, source: "baseline-schema-rule (no schema bump recorded)" };
  }
  if (!Number.isInteger(store.minimumBuild)) {
    return { status: DOWNGRADE_STATUSES.UNKNOWN, source: `minimum build not established (${store.minimumBuildSource})` };
  }
  if (!Number.isInteger(candidateBuild)) {
    return { status: DOWNGRADE_STATUSES.UNKNOWN, source: "no candidate downgrade build named (set ANXOS_ROLLBACK_CANDIDATE_BUILD)" };
  }
  if (candidateBuild >= store.minimumBuild) {
    return { status: DOWNGRADE_STATUSES.SAFE, source: `candidate build ${candidateBuild} >= minimum build ${store.minimumBuild}` };
  }
  if (store.refusalCodeVerifiedInSource !== true) {
    return { status: DOWNGRADE_STATUSES.UNKNOWN, source: "refusal path not verified in source, so the downgrade effect cannot be stated" };
  }
  return { status: DOWNGRADE_STATUSES.DEGRADED, source: `candidate build ${candidateBuild} < minimum build ${store.minimumBuild}` };
}

function buildCatalogueStore(entry, uncovered, candidateBuild) {
  const read = uncovered
    ? { schemaVersion: uncovered.schemaVersion, sourceRef: `${uncovered.source}:${uncovered.line} (${uncovered.constant})`, reason: null }
    : readSchemaConstant(entry.source, entry.constant);

  let minimumBuild = null;
  let minimumBuildSource = "unestablished";
  let minimumBuildEvidence = null;
  let declaredForSchemaVersion = null;

  if (!uncovered) {
    declaredForSchemaVersion = entry.declaredForSchemaVersion;
    if (!Number.isInteger(read.schemaVersion)) {
      minimumBuildSource = "unestablished (schema version unreadable)";
    } else if (read.schemaVersion !== entry.declaredForSchemaVersion) {
      // Drift guard: the declaration describes a different code state than the
      // one on disk, so it must not be reused.
      minimumBuildSource = `stale-declaration (code reports schema ${read.schemaVersion}, declaration covers schema ${entry.declaredForSchemaVersion})`;
    } else if (Number.isInteger(entry.declaredMinimumBuild)) {
      minimumBuild = entry.declaredMinimumBuild;
      minimumBuildSource = "declared-schema-history";
      minimumBuildEvidence = entry.declaredEvidence || null;
    } else if (read.schemaVersion <= BASELINE_SCHEMA_VERSION) {
      minimumBuildSource = "not-applicable (baseline schema; any build that knows the store reads it)";
    } else {
      minimumBuildSource = "unestablished (declared schema has no recorded introducing build)";
    }
  } else {
    minimumBuildSource = read.schemaVersion <= BASELINE_SCHEMA_VERSION
      ? "not-applicable (baseline schema; any build that knows the store reads it)"
      : "unestablished (store is not enumerated in the rollback catalogue)";
  }

  const refusalCodeVerifiedInSource = uncovered ? false : verifyRefusalCode(entry.refusalSource, entry.refusalCode);
  const store = {
    // Uncovered ids carry their source so two same-named constants in different
    // files cannot collide into one row.
    id: uncovered ? `${uncovered.constant.toLowerCase()}@${uncovered.source}` : entry.id,
    component: uncovered ? "unenumerated" : entry.component,
    label: uncovered ? `Schema-versioned store (${uncovered.constant})` : entry.label,
    covered: !uncovered,
    schemaVersion: read.schemaVersion,
    schemaVersionSource: read.sourceRef,
    schemaVersionUnestablishedReason: read.reason || null,
    minimumBuild,
    minimumBuildSource,
    minimumBuildEvidence,
    declaredForSchemaVersion,
    refusalCode: uncovered ? null : entry.refusalCode,
    refusalSource: uncovered ? null : entry.refusalSource,
    refusalCodeVerifiedInSource: uncovered ? null : refusalCodeVerifiedInSource,
    // A refusal path that throws before any write preserves the record on disk;
    // that is why a degraded store is "data preserved, unreadable" rather than
    // "data at risk". This is claimed only where the refusal literal was found
    // in the source; uncovered and unverified stores say nothing.
    refusalPreservesData: uncovered || !refusalCodeVerifiedInSource ? null : true,
    downgradeStatus: DOWNGRADE_STATUSES.UNKNOWN,
    downgradeStatusSource: null,
    downgradeEffect: "unknown",
    unestablishedReason: uncovered
      ? "not enumerated in the rollback catalogue; only the baseline-schema rule applies"
      : null,
  };
  const classification = classifyDowngrade(store, candidateBuild);
  store.downgradeStatus = classification.status;
  store.downgradeStatusSource = classification.source;
  store.downgradeEffect = classification.status === DOWNGRADE_STATUSES.SAFE
    ? "readable"
    : classification.status === DOWNGRADE_STATUSES.DEGRADED
      ? "preserved-not-readable"
      : "unknown";
  return store;
}

function buildDataSchemaRollback(candidateBuild, candidateBuildSource, catalogue = SCHEMA_STORES) {
  const scanned = scanSchemaConstants();
  const coveredKeys = new Set(catalogue.map((entry) => `${entry.source}::${entry.constant}`));
  const unenumerated = scanned.filter((entry) => !coveredKeys.has(`${entry.source}::${entry.constant}`));

  const stores = [
    ...catalogue.map((entry) => buildCatalogueStore(entry, null, candidateBuild)),
    ...unenumerated.map((entry) => buildCatalogueStore(null, entry, candidateBuild)),
  ];

  const components = {};
  for (const store of stores) {
    const componentNames = store.component === "shared" ? ["desktop", "agent"] : [store.component];
    for (const componentName of componentNames) {
      const current = components[componentName] || { stores: [], readAllStoresFloorBuild: null, floorComplete: true, status: DOWNGRADE_STATUSES.SAFE };
      current.stores.push(store);
      components[componentName] = current;
    }
  }
  for (const [componentName, component] of Object.entries(components)) {
    const bumped = component.stores.filter((store) => Number.isInteger(store.schemaVersion) && store.schemaVersion > BASELINE_SCHEMA_VERSION);
    const established = bumped.filter((store) => Number.isInteger(store.minimumBuild));
    component.floorComplete = established.length === bumped.length;
    component.readAllStoresFloorBuild = established.length
      ? Math.max(...established.map((store) => store.minimumBuild))
      : null;
    component.status = worstDowngradeStatus(component.stores.map((store) => store.downgradeStatus));
    component.note = !component.floorComplete
      ? "Lower bound only: at least one bumped store has no established minimum build."
      : component.readAllStoresFloorBuild === null
        ? "No store in this component has left the baseline schema, so no build threshold applies."
        : "Rolling back to a build at or above this build reads every schema-versioned store this component writes.";
    component.storeCount = component.stores.length;
    delete component.stores;
  }

  const status = worstDowngradeStatus(stores.map((store) => store.downgradeStatus));
  const idsByStatus = (target) => stores.filter((store) => store.downgradeStatus === target).map((store) => store.id);

  return {
    direction: "forward-only",
    directionSource: "every enumerated store refuses a newer schema at read time instead of rewriting it (see refusalCode/refusalSource per store)",
    scope:
      "Readability of schema-versioned stores by a build older than the named candidate. It does not cover features introduced after that build, unsigned third-party data, or any store outside this contract.",
    candidateBuild: Number.isInteger(candidateBuild) ? candidateBuild : null,
    candidateBuildSource,
    noDowngradeDrill: true,
    noDowngradeDrillNote:
      "No downgrade has been executed. Every status here is derived from code and schema history, not measured on a running install.",
    stores,
    coverage: {
      enumerated: SCHEMA_STORES.length,
      unenumerated: unenumerated.length,
      unenumeratedConstants: unenumerated.map((entry) => `${entry.constant}@${entry.source}:${entry.line}`),
    },
    components,
    summary: {
      status,
      downgradeIsSafe: status === DOWNGRADE_STATUSES.SAFE,
      counts: {
        safe: idsByStatus(DOWNGRADE_STATUSES.SAFE).length,
        degraded: idsByStatus(DOWNGRADE_STATUSES.DEGRADED).length,
        unknown: idsByStatus(DOWNGRADE_STATUSES.UNKNOWN).length,
      },
      degradedStores: idsByStatus(DOWNGRADE_STATUSES.DEGRADED),
      unknownStores: idsByStatus(DOWNGRADE_STATUSES.UNKNOWN),
    },
  };
}

function resolveRollbackCandidateBuild(env = process.env) {
  const raw = env.ANXOS_ROLLBACK_CANDIDATE_BUILD;
  if (raw === undefined || String(raw).trim() === "") {
    return { candidateBuild: null, candidateBuildSource: "unspecified (set ANXOS_ROLLBACK_CANDIDATE_BUILD to a build number for a decisive answer)" };
  }
  const parsed = Number.parseInt(String(raw).trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return { candidateBuild: null, candidateBuildSource: `unspecified (ANXOS_ROLLBACK_CANDIDATE_BUILD="${raw}" is not a build number)` };
  }
  return { candidateBuild: parsed, candidateBuildSource: "env:ANXOS_ROLLBACK_CANDIDATE_BUILD" };
}

function buildRollbackBlock(options = {}) {
  const candidate = options.candidateBuild === undefined
    ? resolveRollbackCandidateBuild(options.env || process.env)
    : {
        candidateBuild: Number.isInteger(options.candidateBuild) ? options.candidateBuild : null,
        candidateBuildSource: options.candidateBuildSource || "explicit",
      };
  return {
    preservesUserData: true,
    preservesInstances: true,
    preservesBackups: true,
    rollbackMetadataRequired: true,
    preservationIsNotReadability: true,
    preservationScope:
      "These three flags describe data preservation during a binary downgrade. They do not assert that the downgraded build can read the preserved records; see dataSchemaRollback.",
    applicationRollback: {
      inAppDowngradeSupported: false,
      capabilityNote:
        "AnxOS does not implement an in-app downgrade. An older build is installed by the operator (or by the OS installer), and the application cannot make that operation schema-safe.",
      description: "Replacing the installed binaries with an older build. User data, instances and backups are not deleted.",
      dataSchemaIsNotRolledBack: true,
    },
    dataSchemaRollback: buildDataSchemaRollback(candidate.candidateBuild, candidate.candidateBuildSource, options.stores || SCHEMA_STORES),
  };
}

function buildManifest(options = {}) {
  const assets = assetDefinitions
    .map((definition) => {
      const filePath = path.join(distDir, definition.name);

      if (!fs.existsSync(filePath)) {
        return null;
      }

      return {
        ...definition,
        architecture: "x64",
        size: fs.statSync(filePath).size,
        sha256: sha256File(filePath),
        downloadUrl: `${baseUrl}/${encodeURIComponent(definition.name)}`,
      };
    })
    .filter(Boolean);

  return {
    version: release.version,
    build: release.build,
    channel: release.channel,
    releaseLabel: release.compactLabel,
    name: release.tag,
    releaseUrl: `${repositoryUrl}/releases/tag/${release.tag}`,
    publishedAt: new Date().toISOString(),
    websiteUrl: release.websiteUrl,
    releaseRepository: release.releaseRepository,
    updateSource: release.updateSource,
    supportedOperatingSystems: release.supportedOperatingSystems,
    minimumArchitecture: release.minimumArchitecture,
    expectedReleaseArtifacts,
    checksumManifest: {
      name: "SHA256SUMS",
      algorithm: "sha256",
      requiredForRelease: true,
    },
    localAgentRuntime: {
      bundled: true,
      resourceRoot: "local-agent-runtime",
      runtimeId: "anxos-local-agent",
      requiredPaths: [
        "local-agent-runtime/agent/package.json",
        "local-agent-runtime/agent/src/server.js",
        "local-agent-runtime/src/shared",
        "local-agent-runtime/src/services",
        "local-agent-runtime/node_modules/dotenv",
        "local-agent-runtime/config/agent.example.json",
        "local-agent-runtime/config/marketplace-templates.json",
        "local-agent-runtime/local-agent-runtime.json",
      ],
      excludedPatterns: [
        ".env",
        ".env.*",
        "*.map",
        ".git",
        "agent.log",
        "config/application-host.json",
        "config/device-identity.json",
        "config/nodes.json",
        "config/owner-accounts.json",
      ],
    },
    rollback: buildRollbackBlock(options),
    assets: options.assets || assets,
  };
}

function writeManifest() {
  const manifest = buildManifest();
  const assets = manifest.assets;
  fs.mkdirSync(distDir, { recursive: true });
  const updateManifestName = "update-manifest.json";
  fs.writeFileSync(path.join(distDir, updateManifestName), `${JSON.stringify(manifest, null, 2)}\n`);
  const checksumEntries = [...assets.map((asset) => asset.name), updateManifestName]
    .map((name) => `${sha256File(path.join(distDir, name))}  ${name}`);
  fs.writeFileSync(path.join(distDir, "SHA256SUMS"), `${checksumEntries.join("\n")}\n`);
  const outputDir = relativePath(distDir) || distDir;
  console.log(`Wrote ${outputDir}/update-manifest.json with ${assets.length} asset(s) and ${outputDir}/SHA256SUMS.`);
}

module.exports = {
  BASELINE_SCHEMA_VERSION,
  DOWNGRADE_STATUSES,
  SCHEMA_STORES,
  buildManifest,
  buildRollbackBlock,
  classifyDowngrade,
  readSchemaConstant,
  resolveRollbackCandidateBuild,
  scanSchemaConstants,
  worstDowngradeStatus,
  writeManifest,
};

if (require.main === module) {
  writeManifest();
}
