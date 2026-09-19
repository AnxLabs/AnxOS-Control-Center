#!/usr/bin/env node
// Hermetic V2-J bullet 6 coverage: "Take and verify required recovery points
// before risky migrations."
//
// Cycle 17 distinguished application rollback from data-schema rollback, and
// the update manifest reports per-store downgrade status. What was still
// missing was the first half of the sentence: before a risky migration runs, a
// recovery point is taken AND VERIFIED, and the migration is refused if it
// cannot be.
//
// What this smoke proves, against the real policy module and the real migration
// call sites on temp trees:
//   1. the pure policy refuses when a recovery point cannot be taken;
//   2. it refuses when a recovery point was taken but NOT verified (an
//      unverified copy is never `verified`);
//   3. it proceeds when a recovery point was taken and verified — the positive
//      control that stops a refuses-everything policy from passing;
//   4. it proceeds-with-warning ONLY for a store the descriptor explicitly
//      declares reconstructible and names a source for;
//   5. descriptor contradictions and backwards version transitions are refused;
//   6. byte verification is a size AND hash match, and a written-but-not-read
//      recovery point is `unverified`;
//   7. a real migration with an unverifiable recovery point is REFUSED and
//      leaves the store BYTE-IDENTICAL, on three stores (instance config
//      byte-copy, node credentials encrypted re-encode, marketplace provider
//      config encrypted re-encode), while a verified recovery point proceeds.
//
// It does NOT prove a restore drill: a verified recovery point proves the bytes
// (or the logical payload) match the pre-migration source, not that restoring
// it would produce a working installation.
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  MIGRATION_RECOVERY_REASONS,
  MIGRATION_VERDICTS,
  VERIFICATION_REASONS,
  decideMigrationRecovery,
  verifyRecoveryPoint,
} = require("../src/shared/migrationRecoveryPolicy");

const instanceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-migration-recovery-instances-"));
const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-migration-recovery-config-"));
process.env.ANXHUB_CONFIG_DIR = configRoot;

const service = require("../src/shared/instances/instanceServiceCore");
service.configureInstanceService({ getConfig: () => ({ instanceRoot }) });
const nodeCredentialStore = require("../src/services/nodeCredentialStore");
const providerConfigService = require("../src/services/providerConfigService");

const build199Fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "build199-instance-config.json"), "utf8"));

function instanceConfigPath(id) {
  return path.join(instanceRoot, id, "config.json");
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256Bytes(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function describeVerdict(verdict) {
  return `${verdict.verdict}:${verdict.reason}`;
}

function assertVerdict(descriptor, expected, invariant, explanation) {
  const verdict = decideMigrationRecovery(descriptor);
  assert.strictEqual(
    describeVerdict(verdict),
    expected,
    `[INVARIANT ${invariant}] ${explanation} (got ${describeVerdict(verdict)})`,
  );
  return verdict;
}

function assertRefusalCode(fn, expectedCode, invariant, explanation) {
  assert.throws(
    fn,
    (error) => error?.code === expectedCode,
    `[INVARIANT ${invariant}] ${explanation}`,
  );
}

async function assertRejectsCode(fn, expectedCode, invariant, explanation) {
  await assert.rejects(
    fn,
    (error) => error?.code === expectedCode,
    `[INVARIANT ${invariant}] ${explanation}`,
  );
}

function runPolicyChecks() {
  // 1. A recovery point that cannot be taken is REFUSED, not warned past.
  assertVerdict({
    storeId: "store-unavailable",
    fromSchemaVersion: 0,
    toSchemaVersion: 1,
    recoveryPoint: { canTake: false, taken: false, verified: false },
    reconstructible: { isReconstructible: false, source: null },
  }, `refuse:${MIGRATION_RECOVERY_REASONS.RECOVERY_POINT_UNAVAILABLE}`,
  "recovery-point-unavailable-must-refuse",
  "a migration whose recovery point cannot be taken must be refused");

  // 2. Taken but NOT verified is REFUSED. Unverified is not verified.
  assertVerdict({
    storeId: "store-unverified",
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    recoveryPoint: { canTake: true, taken: true, verified: false },
    reconstructible: { isReconstructible: false, source: null },
  }, `refuse:${MIGRATION_RECOVERY_REASONS.RECOVERY_POINT_UNVERIFIED}`,
  "unverified-recovery-point-must-refuse",
  "a recovery point that was taken but never verified must be refused");

  // 2b. A recovery point that could have been taken but was not is REFUSED.
  assertVerdict({
    storeId: "store-not-taken",
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    recoveryPoint: { canTake: true, taken: false, verified: false },
    reconstructible: { isReconstructible: false, source: null },
  }, `refuse:${MIGRATION_RECOVERY_REASONS.RECOVERY_POINT_NOT_TAKEN}`,
  "recovery-point-not-taken-must-refuse",
  "a recovery point that could have been taken but was not must be refused");

  // 3. POSITIVE CONTROL: taken AND verified proceeds.
  assertVerdict({
    storeId: "store-verified",
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    recoveryPoint: { canTake: true, taken: true, verified: true },
    reconstructible: { isReconstructible: false, source: null },
  }, `proceed:${MIGRATION_RECOVERY_REASONS.RECOVERY_POINT_VERIFIED}`,
  "verified-recovery-point-must-proceed",
  "a migration with a taken and verified recovery point must proceed");

  // 4. proceed-with-warning is reachable ONLY for a named reconstructible store.
  assertVerdict({
    storeId: "store-reconstructible",
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    recoveryPoint: { canTake: false, taken: false, verified: false },
    reconstructible: { isReconstructible: true, source: "config/marketplace-templates.json" },
  }, `proceed-with-warning:${MIGRATION_RECOVERY_REASONS.RECOVERY_POINT_UNAVAILABLE_RECONSTRUCTIBLE}`,
  "reconstructible-store-may-warn",
  "a store the descriptor explicitly declares reconstructible, with a named source, may proceed with a warning");

  // 4b. A reconstruction claim with no named source is NOT a warning — fail closed.
  assertVerdict({
    storeId: "store-unnamed-reconstruction",
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    recoveryPoint: { canTake: false, taken: false, verified: false },
    reconstructible: { isReconstructible: true, source: "   " },
  }, `refuse:${MIGRATION_RECOVERY_REASONS.RECOVERY_POINT_UNAVAILABLE}`,
  "unnamed-reconstruction-must-refuse",
  "a reconstruction claim with no named source must be refused");

  // 5. Descriptor contradictions and backwards transitions are refused.
  assertVerdict({
    storeId: "store-inconsistent-verified",
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    recoveryPoint: { canTake: true, taken: false, verified: true },
    reconstructible: { isReconstructible: false, source: null },
  }, `refuse:${MIGRATION_RECOVERY_REASONS.DESCRIPTOR_INCONSISTENT}`,
  "verified-without-taken-must-refuse",
  "a descriptor claiming a verified recovery point that was never taken must be refused");

  assertVerdict({
    storeId: "store-inconsistent-taken",
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    recoveryPoint: { canTake: false, taken: true, verified: true },
    reconstructible: { isReconstructible: false, source: null },
  }, `refuse:${MIGRATION_RECOVERY_REASONS.DESCRIPTOR_INCONSISTENT}`,
  "taken-without-cantake-must-refuse",
  "a descriptor claiming a taken recovery point it says cannot be taken must be refused");

  assertVerdict({
    storeId: "store-backwards",
    fromSchemaVersion: 2,
    toSchemaVersion: 1,
    recoveryPoint: { canTake: true, taken: true, verified: true },
    reconstructible: { isReconstructible: false, source: null },
  }, `refuse:${MIGRATION_RECOVERY_REASONS.INVALID_VERSION_TRANSITION}`,
  "backwards-transition-must-refuse",
  "a backwards schema transition must be refused even with a verified recovery point");

  assertVerdict({
    storeId: "",
    fromSchemaVersion: 1,
    toSchemaVersion: 2,
    recoveryPoint: { canTake: true, taken: true, verified: true },
    reconstructible: { isReconstructible: false, source: null },
  }, `refuse:${MIGRATION_RECOVERY_REASONS.DESCRIPTOR_INVALID}`,
  "invalid-descriptor-must-refuse",
  "a descriptor without a store id must be refused");

  // 6. Verification semantics: size AND hash for bytes; write-without-read is unverified.
  const original = Buffer.from("{\"schemaVersion\":1,\"notes\":\"pre-migration\"}\n", "utf8");
  const identical = Buffer.from(original);
  const identicalCheck = verifyRecoveryPoint({ mode: "bytes", original, copy: identical });
  assert.strictEqual(identicalCheck.verified, true, `[INVARIANT byte-verification-must-require-size-and-hash] identical copies must verify`);
  assert.strictEqual(identicalCheck.reason, VERIFICATION_REASONS.BYTE_IDENTICAL, "[INVARIANT byte-verification-reason] identical copies must report byte_identical");
  assert.strictEqual(identicalCheck.size, original.length, "[INVARIANT byte-verification-must-report-size]");

  const sameLengthDifferentBytes = Buffer.from(original);
  sameLengthDifferentBytes[5] = 0x20;
  const corruptCheck = verifyRecoveryPoint({ mode: "bytes", original, copy: sameLengthDifferentBytes });
  assert.strictEqual(corruptCheck.verified, false, "[INVARIANT byte-verification-must-reject-hash-mismatch] a same-length copy with different bytes must not verify");
  assert.strictEqual(corruptCheck.reason, VERIFICATION_REASONS.HASH_MISMATCH, "[INVARIANT byte-verification-reason] a hash mismatch must be reported as hash_mismatch");

  const truncatedCheck = verifyRecoveryPoint({ mode: "bytes", original, copy: original.subarray(0, 4) });
  assert.strictEqual(truncatedCheck.verified, false, "[INVARIANT byte-verification-must-reject-size-mismatch] a truncated copy must not verify");
  assert.strictEqual(truncatedCheck.reason, VERIFICATION_REASONS.SIZE_MISMATCH, "[INVARIANT byte-verification-reason] a size mismatch must be reported as size_mismatch");

  const neverReadCheck = verifyRecoveryPoint({ mode: "bytes", original, copy: null });
  assert.strictEqual(neverReadCheck.verified, false, "[INVARIANT written-but-never-read-is-unverified] a recovery point that was written but never read back must be unverified");
  assert.strictEqual(neverReadCheck.reason, VERIFICATION_REASONS.RECOVERY_POINT_MISSING, "[INVARIANT written-but-never-read-is-unverified]");

  const jsonCheck = verifyRecoveryPoint({ mode: "json", copy: Buffer.from("{\"schemaVersion\":2,\"encrypted\":{}}\n", "utf8") });
  assert.strictEqual(jsonCheck.verified, true, "[INVARIANT json-verification-must-parse] a parseable JSON envelope must verify");
  assert.strictEqual(jsonCheck.reason, VERIFICATION_REASONS.JSON_PARSED, "[INVARIANT json-verification-reason]");

  const jsonBroken = verifyRecoveryPoint({ mode: "json", copy: Buffer.from("not json at all", "utf8") });
  assert.strictEqual(jsonBroken.verified, false, "[INVARIANT json-verification-must-reject-unparseable] unparseable bytes must not verify");
  assert.strictEqual(jsonBroken.reason, VERIFICATION_REASONS.JSON_PARSE_FAILED, "[INVARIANT json-verification-reason]");

  const jsonUnexpected = verifyRecoveryPoint({
    mode: "json",
    copy: Buffer.from("{\"schemaVersion\":2}\n", "utf8"),
    expect: (value) => value.encrypted !== undefined,
  });
  assert.strictEqual(jsonUnexpected.verified, false, "[INVARIANT json-verification-must-honour-expectation] a parseable envelope failing the caller's expectation must not verify");
  assert.strictEqual(jsonUnexpected.reason, VERIFICATION_REASONS.JSON_EXPECTATION_FAILED, "[INVARIANT json-verification-reason]");

  // Sanity: at least one descriptor in this run must PROCEED and one must warn,
  // so a policy that refuses everything cannot satisfy this smoke.
  assert(MIGRATION_VERDICTS.PROCEED === "proceed" && MIGRATION_VERDICTS.REFUSE === "refuse", "[INVARIANT verdict-vocabulary]");
}

async function runInstanceConfigIntegration() {
  // Positive control: verified byte-copy recovery point migrates and the
  // recovery point is byte-identical to the pre-migration store.
  const positiveId = "recovery-positive";
  const positive = { ...build199Fixture, id: positiveId, displayName: "Recovery Positive" };
  writeJsonFile(instanceConfigPath(positiveId), positive);
  const preMigrationBytes = fs.readFileSync(instanceConfigPath(positiveId));
  const migrated = await service.getStatus(positiveId);
  assert.strictEqual(
    migrated.schemaVersion,
    service.INSTANCE_CONFIG_SCHEMA_VERSION,
    "[INVARIANT verified-recovery-point-must-proceed] an instance migration with a verified recovery point must run",
  );
  const positiveBackupPath = `${instanceConfigPath(positiveId)}.schema-v1.backup`;
  assert(fs.existsSync(positiveBackupPath), "[INVARIANT recovery-point-must-be-taken] a taken recovery point must exist after a verified migration");
  assert.strictEqual(
    sha256Bytes(fs.readFileSync(positiveBackupPath)),
    sha256Bytes(preMigrationBytes),
    "[INVARIANT recovery-point-must-match-pre-migration-store] the recovery point must be byte-identical to the pre-migration store",
  );

  // Unverifiable recovery point: refuse, and leave the store BYTE-IDENTICAL.
  const blockedId = "recovery-unverifiable";
  const blocked = { ...build199Fixture, id: blockedId, displayName: "Recovery Unverifiable" };
  writeJsonFile(instanceConfigPath(blockedId), blocked);
  const blockedBefore = fs.readFileSync(instanceConfigPath(blockedId));
  const blockedBackupPath = `${instanceConfigPath(blockedId)}.schema-v1.backup`;
  const corruptBackupBytes = Buffer.from("this is not the pre-migration record\n", "utf8");
  fs.writeFileSync(blockedBackupPath, corruptBackupBytes);

  await assertRejectsCode(
    () => service.getStatus(blockedId),
    "INSTANCE_CONFIG_MIGRATION_RECOVERY_UNVERIFIED",
    "unverifiable-recovery-point-must-refuse",
    "an instance migration whose recovery point cannot be verified must be refused",
  );
  assert.strictEqual(
    Buffer.compare(fs.readFileSync(instanceConfigPath(blockedId)), blockedBefore),
    0,
    "[INVARIANT store-unchanged-on-refusal] a refused instance migration must leave the store byte-identical",
  );
  assert.strictEqual(
    Buffer.compare(fs.readFileSync(blockedBackupPath), corruptBackupBytes),
    0,
    "[INVARIANT pre-existing-recovery-point-preserved] a refusal must not delete a pre-existing recovery point",
  );
}

function runNodeCredentialIntegration() {
  const credentialPath = nodeCredentialStore.getNodeCredentialsPath();
  assert.strictEqual(path.dirname(credentialPath), configRoot, "[INVARIANT node-credential-fixture-isolation] the credential store must live inside the temp config root");

  // Positive control.
  fs.rmSync(credentialPath, { force: true });
  fs.rmSync(`${credentialPath}.schema-v1.backup`, { force: true });
  writeJsonFile(credentialPath, { schemaVersion: 1, nodes: { "recovery-node": { agentToken: "recovery-token" } } });
  assert.strictEqual(
    nodeCredentialStore.getNodeToken("recovery-node"),
    "recovery-token",
    "[INVARIANT verified-recovery-point-must-proceed] a legacy node credential store with a verified recovery point must migrate",
  );
  assert(
    fs.existsSync(`${credentialPath}.schema-v1.backup`),
    "[INVARIANT recovery-point-must-be-taken] a node credential recovery point must exist after a verified migration",
  );

  // Unverifiable recovery point: refuse, store unchanged.
  fs.rmSync(`${credentialPath}.schema-v1.backup`, { force: true });
  writeJsonFile(credentialPath, { schemaVersion: 1, nodes: { "recovery-node": { agentToken: "recovery-token" } } });
  const credentialBefore = fs.readFileSync(credentialPath);
  fs.writeFileSync(`${credentialPath}.schema-v1.backup`, "corrupt credential recovery point\n");

  assertRefusalCode(
    () => nodeCredentialStore.getNodeToken("recovery-node"),
    "NODE_CREDENTIAL_MIGRATION_RECOVERY_UNVERIFIED",
    "unverifiable-recovery-point-must-refuse",
    "a node credential migration whose recovery point cannot be verified must be refused",
  );
  assert.strictEqual(
    Buffer.compare(fs.readFileSync(credentialPath), credentialBefore),
    0,
    "[INVARIANT store-unchanged-on-refusal] a refused node credential migration must leave the store byte-identical",
  );
}

function runMarketplaceIntegration() {
  const marketplacePath = providerConfigService.getMarketplaceConfigPath();
  assert.strictEqual(path.dirname(marketplacePath), configRoot, "[INVARIANT marketplace-fixture-isolation] the marketplace config must live inside the temp config root");

  // Positive control.
  fs.rmSync(marketplacePath, { force: true });
  fs.rmSync(`${marketplacePath}.schema-v0.backup`, { force: true });
  writeJsonFile(marketplacePath, { curseForgeApiKey: "legacy-cf-key" });
  const migrated = providerConfigService.readMarketplaceConfig({ includeSecrets: true });
  assert.strictEqual(
    migrated.curseForgeApiKey,
    "legacy-cf-key",
    "[INVARIANT verified-recovery-point-must-proceed] a legacy marketplace config with a verified recovery point must migrate",
  );
  assert(
    fs.existsSync(`${marketplacePath}.schema-v0.backup`),
    "[INVARIANT recovery-point-must-be-taken] a marketplace recovery point must exist after a verified migration",
  );

  // Unverifiable recovery point: refuse, store unchanged.
  fs.rmSync(`${marketplacePath}.schema-v0.backup`, { force: true });
  writeJsonFile(marketplacePath, { curseForgeApiKey: "legacy-cf-key" });
  const marketplaceBefore = fs.readFileSync(marketplacePath);
  fs.writeFileSync(`${marketplacePath}.schema-v0.backup`, "corrupt marketplace recovery point\n");

  assertRefusalCode(
    () => providerConfigService.readMarketplaceConfig({ includeSecrets: true }),
    "MARKETPLACE_CONFIG_MIGRATION_RECOVERY_UNVERIFIED",
    "unverifiable-recovery-point-must-refuse",
    "a marketplace config migration whose recovery point cannot be verified must be refused",
  );
  assert.strictEqual(
    Buffer.compare(fs.readFileSync(marketplacePath), marketplaceBefore),
    0,
    "[INVARIANT store-unchanged-on-refusal] a refused marketplace migration must leave the store byte-identical",
  );
}

async function main() {
  runPolicyChecks();
  await runInstanceConfigIntegration();
  runNodeCredentialIntegration();
  runMarketplaceIntegration();

  console.log(JSON.stringify({
    status: "PASS",
    classification: "MIGRATION RECOVERY-POINT GATE VERIFIED",
    policyVerdicts: {
      proceed: MIGRATION_VERDICTS.PROCEED,
      proceedWithWarning: MIGRATION_VERDICTS.PROCEED_WITH_WARNING,
      refuse: MIGRATION_VERDICTS.REFUSE,
    },
    verificationModes: ["bytes (size + sha256)", "json (parse + expectation, plus store-level decrypt-and-compare)"],
    integrationStores: [
      "instance-config (byte copy)",
      "node-credentials (encrypted re-encode)",
      "marketplace-provider-config (encrypted re-encode)",
    ],
    verifiedRecoveryPointProvesBytesMatchNotRestorability: true,
    restoreDrillRun: false,
  }, null, 2));
}

main()
  .finally(() => {
    fs.rmSync(instanceRoot, { recursive: true, force: true });
    fs.rmSync(configRoot, { recursive: true, force: true });
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });