#!/usr/bin/env node
// Hermetic smoke for V2-J bullet 6: the update manifest must distinguish
// APPLICATION rollback (the binaries get older) from DATA-SCHEMA rollback (the
// stored records do not), and the update flow must never present a downgrade
// that degrades functionality as safe.
//
// What is proven here (mechanism only — NO downgrade has been executed):
//   1. the generated manifest's rollback block reports every schema-versioned
//      store with its schema version and a downgrade status;
//   2. a store whose schema is newer than a named candidate downgrade build is
//      DEGRADED, and the same store is SAFE for a candidate at or above its
//      minimum build — so neither "always SAFE" nor "always DEGRADED" passes;
//   3. a store whose schema version cannot be read, or whose declared minimum
//      build is stale relative to the code, is UNKNOWN and never SAFE;
//   4. the summary separates application rollback from data-schema rollback and
//      cannot report SAFE while any store is degraded;
//   5. the updater's own evaluation refuses to call a downgrade safe without an
//      explicit contract, warns when the installed build is below the data
//      schema, and defaults to UNKNOWN when it has nothing to compare;
//   6. the file the real CLI writes (not just the returned object) contains the
//      block.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const rootDir = path.resolve(__dirname, "..");
const generator = require(path.join(rootDir, "scripts", "write-update-manifest.js"));
const {
  ROLLBACK_STATUSES,
  evaluateRollbackGuidance,
  normalizeRollbackGuidance,
} = require(path.join(rootDir, "src", "services", "updateManager.js"));

const { SAFE, DEGRADED, UNKNOWN } = ROLLBACK_STATUSES;

const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-rollback-signalling-"));
const manifestPath = path.join(outputDir, "update-manifest.json");

function findStore(block, id) {
  const store = block.dataSchemaRollback.stores.find((entry) => entry.id === id);
  assert(store, `The rollback contract must report the ${id} store.`);
  return store;
}

function main() {
  // ---- 0. Positive control: schema versions come from the code, not a list --
  const instanceVersion = generator.readSchemaConstant(
    "src/shared/instances/instanceServiceCore.js",
    "INSTANCE_CONFIG_SCHEMA_VERSION",
  );
  assert.strictEqual(instanceVersion.schemaVersion, 2, "The contract must read the instance schema version from the code.");
  assert(/instanceServiceCore\.js:\d+/.test(instanceVersion.sourceRef || ""), "The contract must cite where the schema version came from.");

  // A versioned store the catalogue does not know is still reported.
  const scanned = generator.scanSchemaConstants();
  assert(scanned.some((entry) => entry.constant === "NODE_SCHEMA_VERSION" && entry.schemaVersion === 3), "The scanner must find the node registry schema version in the code.");

  // ---- 1. Default manifest: contract present, but nothing is called safe ----
  const defaultBlock = generator.buildRollbackBlock({ candidateBuild: null, candidateBuildSource: "smoke-default" });
  for (const id of ["instance-config", "node-registry", "node-credentials", "secure-session", "agent-backup-metadata", "agent-backup-schedules", "agent-device-identity"]) {
    const store = findStore(defaultBlock, id);
    assert(Number.isInteger(store.schemaVersion), `${id} must report its schema version.`);
    assert(typeof store.schemaVersionSource === "string" && /\.js:\d+/.test(store.schemaVersionSource), `${id} must cite the file:line its schema version was read from.`);
    assert([SAFE, DEGRADED, UNKNOWN].includes(store.downgradeStatus), `${id} must report a known downgrade status.`);
  }
  assert.strictEqual(
    findStore(defaultBlock, "instance-config").downgradeStatus,
    UNKNOWN,
    "With no candidate downgrade build named, a bumped store must be UNKNOWN — never SAFE.",
  );
  assert.strictEqual(defaultBlock.dataSchemaRollback.candidateBuild, null, "An unnamed candidate must be reported as null, not guessed.");
  assert.strictEqual(defaultBlock.dataSchemaRollback.summary.downgradeIsSafe, false, "The default manifest must not claim a downgrade is safe.");
  assert.strictEqual(defaultBlock.dataSchemaRollback.noDowngradeDrill, true, "The contract must state that no downgrade drill has run.");

  // The citation must point at the declaration it names, so a reader can verify
  // it and a refactor that moves the constant cannot leave a misleading pointer.
  for (const store of defaultBlock.dataSchemaRollback.stores) {
    const ref = /^(.+):(\d+) \(([A-Z0-9_]+)\)$/.exec(store.schemaVersionSource || "");
    assert(ref, `${store.id} must cite its schema version as file:line (CONSTANT).`);
    const sourceLines = fs.readFileSync(path.join(rootDir, ref[1]), "utf8").split("\n");
    assert(
      (sourceLines[Number(ref[2]) - 1] || "").includes(`const ${ref[3]}`),
      `${store.id} cites ${store.schemaVersionSource}, which must be the line declaring ${ref[3]}.`,
    );
  }

  // ---- 2/3. Named candidate: DEGRADED below the floor, SAFE at or above it ----
  const rollbackTo199 = generator.buildRollbackBlock({ candidateBuild: 199, candidateBuildSource: "smoke" });
  const instanceAt199 = findStore(rollbackTo199, "instance-config");
  assert.strictEqual(instanceAt199.minimumBuild, 200, "The instance store must report Build 200 as the oldest build that reads schema 2.");
  assert.strictEqual(instanceAt199.downgradeStatus, DEGRADED, "A downgrade below the minimum build must be DEGRADED, not SAFE.");
  assert.notStrictEqual(instanceAt199.downgradeStatus, SAFE, "A store whose schema is newer than the candidate build must never be SAFE.");
  assert.strictEqual(instanceAt199.downgradeEffect, "preserved-not-readable", "A degraded store must say data is preserved but unreadable.");
  assert.strictEqual(instanceAt199.refusalCode, "INSTANCE_CONFIG_SCHEMA_UNSUPPORTED", "A degraded store must name the refusal an older build produces.");
  assert.strictEqual(findStore(rollbackTo199, "node-registry").downgradeStatus, SAFE, "A store whose minimum build is below the candidate must be SAFE — this is the positive control against an always-DEGRADED implementation.");
  assert.strictEqual(rollbackTo199.dataSchemaRollback.summary.status, DEGRADED, "The summary must follow the worst store, not the majority.");
  assert.deepStrictEqual(rollbackTo199.dataSchemaRollback.summary.degradedStores, ["instance-config", "agent-device-identity"], "The summary must name the degraded stores.");

  // A DEGRADED verdict rests on the refusal path existing in the code, verified
  // against the literal in the cited file rather than the citation alone.
  for (const entry of generator.SCHEMA_STORES.filter((item) => item.refusalCode)) {
    const store = findStore(rollbackTo199, entry.id);
    assert.strictEqual(
      store.refusalCodeVerifiedInSource,
      true,
      `${entry.id} declares refusal code ${entry.refusalCode}, which must be present in ${entry.refusalSource}.`,
    );
    assert.strictEqual(store.refusalPreservesData, true, `${entry.id} must claim data preservation only where its refusal path was verified.`);
  }
  const unverifiedRefusal = generator.buildRollbackBlock({
    candidateBuild: 1,
    candidateBuildSource: "smoke",
    stores: [{
      id: "unverified-refusal",
      component: "desktop",
      label: "Bumped store whose refusal literal is not in the cited file",
      source: "src/shared/instances/instanceServiceCore.js",
      constant: "INSTANCE_CONFIG_SCHEMA_VERSION",
      declaredMinimumBuild: 200,
      declaredForSchemaVersion: 2,
      refusalCode: "NOT_A_REAL_REFUSAL_CODE",
      refusalSource: "src/shared/instances/instanceServiceCore.js:3486",
    }],
  });
  const unverified = findStore(unverifiedRefusal, "unverified-refusal");
  assert.strictEqual(unverified.downgradeStatus, UNKNOWN, "A downgrade must be UNKNOWN when the refusal path cannot be verified in the source.");
  assert.strictEqual(unverified.refusalPreservesData, null, "Preservation must not be claimed without a verified refusal path.");

  const rollbackTo202 = generator.buildRollbackBlock({ candidateBuild: 202, candidateBuildSource: "smoke" });
  assert.strictEqual(findStore(rollbackTo202, "instance-config").downgradeStatus, SAFE, "A candidate at or above the minimum build must be SAFE.");
  assert.strictEqual(rollbackTo202.dataSchemaRollback.components.desktop.readAllStoresFloorBuild, 200, "The desktop floor must be derived from the highest desktop minimum build.");
  assert.strictEqual(rollbackTo202.dataSchemaRollback.components.agent.readAllStoresFloorBuild, 202, "The agent floor must be its own, because the agent runtime downgrades independently of the desktop app.");
  // A hardcoded minimum build must say where it came from, or it is a guess.
  for (const store of rollbackTo199.dataSchemaRollback.stores) {
    if (store.schemaVersion > 1) {
      assert.strictEqual(typeof store.minimumBuildEvidence, "string", `${store.id} must record the evidence for its declared minimum build.`);
      assert(store.minimumBuildEvidence.length > 0, `${store.id} must record a non-empty minimum-build evidence string.`);
    }
  }

  // ---- 4. Application rollback vs data-schema rollback ----
  assert.strictEqual(rollbackTo199.preservesInstances, true, "Preservation flags must remain truthful.");
  assert.strictEqual(rollbackTo199.preservationIsNotReadability, true, "The manifest must state that preservation is not readability.");
  assert.strictEqual(rollbackTo199.applicationRollback.inAppDowngradeSupported, false, "The manifest must not claim an in-app downgrade feature.");
  assert.strictEqual(rollbackTo199.applicationRollback.dataSchemaIsNotRolledBack, true, "Application rollback must state that the data schema is not rolled back.");
  assert.strictEqual(rollbackTo199.dataSchemaRollback.direction, "forward-only", "The data-schema direction must be reported.");
  assert(rollbackTo199.applicationRollback && rollbackTo199.dataSchemaRollback, "The rollback block must separate application rollback from data-schema rollback.");

  // ---- 3. Unreadable / stale declarations are UNKNOWN, never SAFE ----
  const unreadable = generator.buildRollbackBlock({
    candidateBuild: 1,
    candidateBuildSource: "smoke",
    stores: [{
      id: "missing-store",
      component: "desktop",
      label: "Store whose source cannot be read",
      source: "src/definitely-not-a-real-file.js",
      constant: "MISSING_STORE_SCHEMA_VERSION",
      declaredMinimumBuild: 1,
      declaredForSchemaVersion: 1,
      refusalCode: null,
      refusalSource: null,
    }],
  });
  const missing = findStore(unreadable, "missing-store");
  assert.strictEqual(missing.schemaVersion, null, "An unreadable store must report no schema version.");
  assert.strictEqual(missing.downgradeStatus, UNKNOWN, "An unreadable store must be UNKNOWN even with a candidate build that would otherwise be SAFE.");
  assert.notStrictEqual(missing.downgradeStatus, SAFE, "An unreadable store must never be reported SAFE.");
  assert(/unreadable/.test(missing.schemaVersionUnestablishedReason || ""), "An unreadable store must say why it could not be established.");

  const stale = generator.buildRollbackBlock({
    candidateBuild: 1,
    candidateBuildSource: "smoke",
    stores: [{
      id: "stale-declaration",
      component: "desktop",
      label: "Store whose declared minimum build is stale",
      source: "src/shared/instances/instanceServiceCore.js",
      constant: "INSTANCE_CONFIG_SCHEMA_VERSION",
      declaredMinimumBuild: 150,
      declaredForSchemaVersion: 1,
      refusalCode: "INSTANCE_CONFIG_SCHEMA_UNSUPPORTED",
      refusalSource: "src/shared/instances/instanceServiceCore.js:3486",
    }],
  });
  const staleStore = findStore(stale, "stale-declaration");
  assert.strictEqual(staleStore.schemaVersion, 2, "The stale-declaration case must still read the real schema version from the code.");
  assert.strictEqual(staleStore.minimumBuild, null, "A declaration written for a different schema version must not supply a minimum build.");
  assert.strictEqual(staleStore.downgradeStatus, UNKNOWN, "A stale declaration must degrade to UNKNOWN rather than reuse the stale build number.");
  assert(/stale-declaration/.test(staleStore.minimumBuildSource), "The stale declaration must be reported as stale.");

  // ---- 5. The update flow's own evaluation ----
  const missingContract = evaluateRollbackGuidance(null, 203);
  assert.strictEqual(missingContract.rollbackIsSafe, false, "No contract must never be reported as safe.");
  assert.strictEqual(missingContract.dataSchemaStatus, UNKNOWN, "No contract must default to UNKNOWN.");
  assert.strictEqual(missingContract.installedBuildVsDataSchema, "unknown", "With nothing to compare, the running build comparison must be unknown — not 'not-older'.");
  assert(missingContract.warning, "A manifest with no data-schema contract must warn.");

  const preservationOnly = normalizeRollbackGuidance({ preservesUserData: true, preservesInstances: true, preservesBackups: true, rollbackMetadataRequired: true });
  assert.strictEqual(preservationOnly.contractPresent, false, "A preservation-only rollback block must be recognized as carrying no schema contract.");
  const preservationEvaluation = evaluateRollbackGuidance(preservationOnly, 203);
  assert.strictEqual(preservationEvaluation.rollbackIsSafe, false, "A preservation-only manifest must never be presented as safe to roll back.");
  assert.strictEqual(preservationEvaluation.preservationOnly, true, "The evaluation must flag that the manifest says only preservation.");

  const guidance = normalizeRollbackGuidance(rollbackTo199);
  assert.strictEqual(guidance.contractPresent, true, "The generated contract must be recognized as present.");
  const running203 = evaluateRollbackGuidance(guidance, 203);
  assert.strictEqual(running203.installedBuildVsDataSchema, "not-older", "Build 203 is at or above every store minimum.");
  assert.strictEqual(running203.dataSchemaStatus, DEGRADED, "The declared DEGRADED status must survive normalization.");
  assert.strictEqual(running203.rollbackIsSafe, false, "A DEGRADED contract must never be reported as safe.");
  assert(running203.warning, "A degraded rollback must warn.");

  const runningAppBeforeData = evaluateRollbackGuidance(guidance, 150);
  assert.strictEqual(runningAppBeforeData.installedBuildVsDataSchema, "older", "A running build below a store minimum must be detected.");
  assert.strictEqual(runningAppBeforeData.rollbackIsSafe, false, "A running build below the data schema must never be reported as safe.");
  assert.strictEqual(runningAppBeforeData.blockedStores.length, 2, "Both stores written after Build 150 must be named as unreadable to it.");
  assert(/Build 150/.test(runningAppBeforeData.warning || ""), "The warning must name the installed build.");

  // A manifest that claims SAFE overall while listing a degraded store must not
  // be trusted.
  const lyingContract = normalizeRollbackGuidance({
    preservesUserData: true,
    preservationIsNotReadability: true,
    dataSchemaRollback: {
      direction: "forward-only",
      summary: { status: SAFE },
      stores: [{ id: "instance-config", schemaVersion: 2, minimumBuild: 200, downgradeStatus: DEGRADED }],
    },
  });
  assert.strictEqual(lyingContract.dataSchemaStatus, DEGRADED, "A SAFE summary over a degraded store must be corrected, not trusted.");
  assert.strictEqual(evaluateRollbackGuidance(lyingContract, 203).rollbackIsSafe, false, "A corrected DEGRADED contract must not be safe.");

  const unknownStores = normalizeRollbackGuidance({
    preservationIsNotReadability: true,
    dataSchemaRollback: { stores: [{ id: "instance-config", schemaVersion: null }] },
  });
  assert.strictEqual(unknownStores.dataSchemaStatus, UNKNOWN, "A store with no schema version must force UNKNOWN.");

  // ---- 6. The real CLI writes the block to disk ----
  const run = spawnSync(process.execPath, [path.join(rootDir, "scripts", "write-update-manifest.js")], {
    cwd: rootDir,
    env: { ...process.env, ANXOS_UPDATE_MANIFEST_OUT_DIR: outputDir, ANXOS_ROLLBACK_CANDIDATE_BUILD: "199" },
    encoding: "utf8",
  });
  assert.strictEqual(run.status, 0, `The manifest generator must exit 0 (stderr: ${run.stderr})`);
  const emitted = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert(emitted.rollback && emitted.rollback.dataSchemaRollback, "The written manifest must contain the data-schema rollback block.");
  assert.strictEqual(emitted.rollback.dataSchemaRollback.candidateBuild, 199, "The written manifest must honour the candidate build.");
  assert.strictEqual(
    emitted.rollback.dataSchemaRollback.stores.find((store) => store.id === "instance-config").downgradeStatus,
    DEGRADED,
    "The written manifest must report the instance store as DEGRADED for a pre-Build-200 candidate.",
  );
  assert.strictEqual(emitted.rollback.preservesInstances, true, "The written manifest must keep the preservation flags.");

  const summary = {
    status: "PASS",
    classification: "CODE-GROUNDED, NOT MEASURED (no downgrade drill has been run)",
    schemaVersionsReadFromCode: true,
    candidateComparisons: { "199": DEGRADED, "202": SAFE, "none": UNKNOWN },
    unreadableStoreStatus: missing.downgradeStatus,
    staleDeclarationStatus: staleStore.downgradeStatus,
    storedContractsRejected: ["preservation-only manifest", "SAFE summary over a degraded store"],
    emittedManifestPath: manifestPath,
    generatedSummaryAt199: rollbackTo199.dataSchemaRollback.summary,
  };
  console.log(JSON.stringify(summary, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(outputDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
