#!/usr/bin/env node
"use strict";

// V2-J bullet 6 store sweep: proves the verify-or-refuse policy is wired into
// the client-side stores that migrated behind an UNVERIFIED recovery point.
//
// For each wired store this smoke runs two legs against a fresh temp tree:
//
//   A. a verifiable recovery point lets the migration proceed (and the recovery
//      point is a byte copy of the pre-migration file);
//   B. a deliberately CORRUPTED, pre-existing recovery point (same byte length,
//      different bytes, so the check must be a hash check and not a size check)
//      refuses the migration, AND the store file stays byte-identical and the
//      pre-existing recovery point is never deleted or rewritten.
//
// What this does NOT prove: that restoring any recovery point would succeed, or
// that a restored installation works. No restore drill has run in this
// repository. See migrationRecoveryPolicy.js for the same caveat.

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-migration-store-recovery-"));

function hashFile(target) {
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

function readJson(target) {
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

// Same byte length, different bytes: the recovery point is the right SIZE but
// the wrong CONTENT, so only a hash comparison can catch it.
function corruptBackup(backupPath, originalBytes) {
  if (originalBytes.length === 0) {
    fs.writeFileSync(backupPath, Buffer.from("#"));
    return;
  }
  const corrupted = Buffer.from(originalBytes);
  corrupted[corrupted.length - 1] ^= 0xff;
  fs.writeFileSync(backupPath, corrupted);
}

const results = [];
const covered = [];

async function runCase(spec) {
  // ---- Leg A: a verifiable recovery point lets the migration proceed. ----
  const dirA = fs.mkdtempSync(path.join(root, "a-"));
  spec.prepare(dirA);
  const { filePath, backupPath, legacyBytes } = spec.paths(dirA);
  assert(fs.existsSync(filePath), `${spec.name}: fixture must exist before the read`);
  let legAError = null;
  try {
    await spec.run();
  } catch (error) {
    legAError = error;
  }
  assert(
    legAError === null,
    `${spec.name}: a verifiable recovery point must let the migration proceed (observed ${legAError && (legAError.code || legAError.message)})`,
  );
  assert(fs.existsSync(backupPath), `${spec.name}: the pre-migration recovery point must be taken`);
  assert.deepStrictEqual(
    fs.readFileSync(backupPath),
    legacyBytes,
    `${spec.name}: the recovery point must be a byte copy of the pre-migration file`,
  );
  if (spec.expectMigrated !== false) {
    assert.notDeepStrictEqual(
      fs.readFileSync(filePath),
      legacyBytes,
      `${spec.name}: a verified recovery point must let the rewrite happen`,
    );
  }
  if (typeof spec.verifyMigrated === "function") spec.verifyMigrated(filePath);

  // ---- Leg B: an unverifiable recovery point refuses and writes nothing. ----
  const dirB = fs.mkdtempSync(path.join(root, "b-"));
  spec.prepare(dirB);
  const pathsB = spec.paths(dirB);
  corruptBackup(pathsB.backupPath, pathsB.legacyBytes);
  const fileHashBefore = hashFile(pathsB.filePath);
  const backupHashBefore = hashFile(pathsB.backupPath);

  let legBError = null;
  let legBResult;
  try {
    legBResult = await spec.run();
  } catch (error) {
    legBError = error;
  }

  if (spec.refusal.mode === "throw") {
    assert(
      legBError !== null,
      `${spec.name}: an unverifiable recovery point must refuse the migration`,
    );
    assert.strictEqual(
      legBError.code,
      spec.refusal.code,
      `${spec.name}: refusal must name the invariant (observed ${legBError.code})`,
    );
  } else if (spec.refusal.mode === "degrade") {
    assert(
      legBError === null,
      `${spec.name}: the store's degraded-refusal path must not throw (observed ${legBError && (legBError.code || legBError.message)})`,
    );
    spec.refusal.assert(legBResult);
  } else {
    assert(
      legBError === null,
      `${spec.name}: the store's silent-refusal path must not throw (observed ${legBError && (legBError.code || legBError.message)})`,
    );
    assert.strictEqual(legBResult, null, `${spec.name}: a silent refusal must not surface a migrated value`);
    assert.throws(
      () => spec.directRefusalProbe(),
      (error) => error && error.code === spec.refusal.code,
      `${spec.name}: the direct probe must name the invariant ${spec.refusal.code}`,
    );
  }
  assert.strictEqual(
    hashFile(pathsB.filePath),
    fileHashBefore,
    `${spec.name}: a refused migration must leave the store byte-identical`,
  );
  assert.strictEqual(
    hashFile(pathsB.backupPath),
    backupHashBefore,
    `${spec.name}: a pre-existing recovery point must never be deleted or rewritten`,
  );

  results.push({ store: spec.name, proceededLeg: "PASS", refusedLeg: "PASS", byteIdenticalOnRefusal: true });
  covered.push(spec.name);
}

async function main() {
  const applicationHostService = require("../src/services/applicationHostService");
  const instanceForgetService = require("../src/services/instanceForgetService");
  const nodeService = require("../src/services/nodeService");
  const { UpdateManager, UPDATE_STORE_SCHEMA_VERSION } = require("../src/services/updateManager");
  const { SecureSessionStore, encryptPayload, SECURE_SESSION_SCHEMA_VERSION } = require("../src/services/secureSessionStore");
  const securityService = require("../src/services/securityService");
  const settingsPreferenceService = require("../src/services/settingsPreferenceService");
  const storageConnectionService = require("../src/services/storageConnectionService");
  const { SshService, SSH_PROFILES_SCHEMA_VERSION } = require("../src/services/sshService");
  const ownerAccountConfig = require("../src/services/ownerAccountConfig");
  const agentRuntimeConfigStore = require("../src/shared/agentRuntimeConfigStore");
  const agentTokenStore = require("../src/shared/agentTokenStore");
  const publicAccessServiceRegistry = require("../src/shared/publicAccessServiceRegistry");

  function setConfigDir(dir) {
    const configDir = path.join(dir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    process.env.ANXHUB_CONFIG_DIR = configDir;
    return configDir;
  }

  function writeJsonFile(target, value) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    return fs.readFileSync(target);
  }

  // ---------------------------------------------------------------------------
  // 1. application host identity — writeHostIdentity rewrite
  // ---------------------------------------------------------------------------
  await runCase({
    name: "application-host-identity",
    prepare(dir) {
      const configDir = setConfigDir(dir);
      this._file = path.join(configDir, "application-host.json");
      this._backup = `${this._file}.schema-v0.backup`;
      this._legacy = writeJsonFile(this._file, { hostId: "host-smoke-identity-0001" });
    },
    paths() {
      return { filePath: this._file, backupPath: this._backup, legacyBytes: this._legacy };
    },
    run: () => applicationHostService.getApplicationHost(),
    verifyMigrated(filePath) {
      const migrated = readJson(filePath);
      assert.strictEqual(migrated.schemaVersion, applicationHostService.APPLICATION_HOST_SCHEMA_VERSION, "host identity schema must advance");
      assert.strictEqual(migrated.hostId, "host-smoke-identity-0001", "migration must not rotate the host id");
    },
    refusal: { mode: "throw", code: "APPLICATION_HOST_MIGRATION_RECOVERY_UNVERIFIED" },
  });

  // ---------------------------------------------------------------------------
  // 2. forgotten instances — readStore rewrite
  // ---------------------------------------------------------------------------
  await runCase({
    name: "forgotten-instances",
    prepare(dir) {
      const configDir = setConfigDir(dir);
      this._file = path.join(configDir, "forgotten-instances.json");
      this._backup = `${this._file}.schema-v0.backup`;
      this._legacy = writeJsonFile(this._file, { entries: [{ nodeId: "application-host", instanceId: "kept-instance" }] });
    },
    paths() {
      return { filePath: this._file, backupPath: this._backup, legacyBytes: this._legacy };
    },
    run: () => instanceForgetService.isInstanceForgotten("application-host", "kept-instance"),
    verifyMigrated(filePath) {
      assert.strictEqual(readJson(filePath).schemaVersion, instanceForgetService.FORGOTTEN_SCHEMA_VERSION, "forgotten-instance schema must advance");
    },
    refusal: { mode: "throw", code: "FORGOTTEN_INSTANCE_MIGRATION_RECOVERY_UNVERIFIED" },
  });

  // ---------------------------------------------------------------------------
  // 3. node registry — readNodeState rewrite (write gated on credential unlock)
  // ---------------------------------------------------------------------------
  await runCase({
    name: "node-registry",
    prepare(dir) {
      const configDir = setConfigDir(dir);
      this._file = path.join(configDir, "nodes.json");
      this._backup = `${this._file}.schema-v0.backup`;
      this._legacy = writeJsonFile(this._file, { nodes: [], selectedNodeId: null });
    },
    paths() {
      return { filePath: this._file, backupPath: this._backup, legacyBytes: this._legacy };
    },
    run: () => nodeService.getAllNodesSync(),
    // The registry rewrite is gated on credential unlock, which this smoke does
    // not hold, so leg A proves only that the verified recovery point unblocks
    // the read; the refusal leg is the load-bearing one.
    expectMigrated: false,
    refusal: { mode: "throw", code: "NODE_CONFIG_MIGRATION_RECOVERY_UNVERIFIED" },
  });

  // ---------------------------------------------------------------------------
  // 4. update store — loadStore rewrite (degrades instead of throwing)
  // ---------------------------------------------------------------------------
  await runCase({
    name: "update-store",
    prepare(dir) {
      this._file = path.join(dir, "updates.json");
      this._backup = `${this._file}.schema-v0.backup`;
      this._legacy = writeJsonFile(this._file, { skippedVersions: ["1.9.0"], pendingInstall: null });
    },
    paths() {
      return { filePath: this._file, backupPath: this._backup, legacyBytes: this._legacy };
    },
    run() {
      const manager = new UpdateManager();
      manager.storePath = this._file;
      manager.loadStore();
      this._manager = manager;
      return manager;
    },
    verifyMigrated(filePath) {
      assert.strictEqual(readJson(filePath).schemaVersion, UPDATE_STORE_SCHEMA_VERSION, "update store schema must advance");
      assert.strictEqual(this._manager.storeError, null, "a verified migration must not degrade the store");
    },
    // The update store refuses through its degraded storeError channel rather
    // than throwing, because loadStore runs during startup IPC registration.
    refusal: {
      mode: "degrade",
      code: "UPDATE_STORE_MIGRATION_RECOVERY_UNVERIFIED",
      assert(manager) {
        assert.strictEqual(
          manager && manager.storeError && manager.storeError.code,
          "UPDATE_STORE_MIGRATION_RECOVERY_UNVERIFIED",
          "update store must refuse through its degraded storeError channel",
        );
      },
    },
  });

  // ---------------------------------------------------------------------------
  // 5. encrypted session store — envelope rewrite
  // ---------------------------------------------------------------------------
  await runCase({
    name: "secure-session",
    prepare(dir) {
      const configDir = path.join(dir, "config");
      fs.mkdirSync(configDir, { recursive: true });
      this._file = path.join(configDir, "account.json");
      this._backup = `${this._file}.schema-v0.backup`;
      this._legacy = writeJsonFile(this._file, { schemaVersion: 0, ...encryptPayload({ accountId: "smoke-account" }, this._file) });
    },
    paths() {
      return { filePath: this._file, backupPath: this._backup, legacyBytes: this._legacy };
    },
    run() {
      return new SecureSessionStore({ configDirectory: path.dirname(this._file), fileName: "account.json" }).read();
    },
    verifyMigrated(filePath) {
      assert.strictEqual(readJson(filePath).schemaVersion, SECURE_SESSION_SCHEMA_VERSION, "secure-session schema must advance");
    },
    refusal: { mode: "throw", code: "SECURE_SESSION_MIGRATION_RECOVERY_UNVERIFIED" },
  });

  // ---------------------------------------------------------------------------
  // 6. security state — readSecurityFile({migrate:true}) rewrite, via getStatus
  // ---------------------------------------------------------------------------
  await runCase({
    name: "security-state",
    prepare(dir) {
      const configDir = setConfigDir(dir);
      this._file = path.join(configDir, "security.json");
      this._backup = `${this._file}.schema-v0.backup`;
      this._legacy = writeJsonFile(this._file, { users: [], persistentSessions: [], trustedDevices: [], agentTokens: {} });
    },
    paths() {
      return { filePath: this._file, backupPath: this._backup, legacyBytes: this._legacy };
    },
    run: () => securityService.getStatus(),
    verifyMigrated(filePath) {
      assert.strictEqual(readJson(filePath).schemaVersion, securityService.SECURITY_SCHEMA_VERSION, "security-state schema must advance");
    },
    refusal: { mode: "throw", code: "SECURITY_STORE_MIGRATION_RECOVERY_UNVERIFIED" },
  });

  // ---------------------------------------------------------------------------
  // 7. persistent session state — parsePersistentSessionRecord rewrite.
  //    readPersistentSessionFile wraps the refusal into a null (the store's
  //    established quiet path), so the refusal is asserted through the exported
  //    parse probe while the byte-identity assertion still holds on disk.
  // ---------------------------------------------------------------------------
  await runCase({
    name: "persistent-session-state",
    prepare(dir) {
      const configDir = setConfigDir(dir);
      this._file = path.join(configDir, "session.dat");
      this._backup = `${this._file}.schema-v0.backup`;
      this._legacy = writeJsonFile(this._file, { ...securityService._test.encryptLocalSession({ accountId: "smoke-remembered" }), schemaVersion: 0 });
    },
    paths() {
      return { filePath: this._file, backupPath: this._backup, legacyBytes: this._legacy };
    },
    run: () => securityService._test.readPersistentSessionFile(),
    verifyMigrated(filePath) {
      // securityService does not export PERSISTENT_SESSION_SCHEMA_VERSION; the
      // store has a single current schema (1) and the fixture was written at 0.
      assert.strictEqual(readJson(filePath).schemaVersion, 1, "persistent-session schema must advance");
    },
    refusal: { mode: "silent", code: "PERSISTENT_SESSION_MIGRATION_RECOVERY_UNVERIFIED" },
    directRefusalProbe: () => securityService._test.parsePersistentSessionRecord(),
  });

  // ---------------------------------------------------------------------------
  // 8. settings preferences — readPreferences rewrite
  // ---------------------------------------------------------------------------
  await runCase({
    name: "settings-preferences",
    prepare(dir) {
      const configDir = setConfigDir(dir);
      this._file = path.join(configDir, "preferences.json");
      this._backup = `${this._file}.schema-v0.backup`;
      this._legacy = writeJsonFile(this._file, { "interface.guidedMode": false, "startup.sound": true });
    },
    paths() {
      return { filePath: this._file, backupPath: this._backup, legacyBytes: this._legacy };
    },
    run: () => settingsPreferenceService.readPreferences(),
    verifyMigrated(filePath) {
      assert.strictEqual(readJson(filePath).schemaVersion, settingsPreferenceService.SETTINGS_SCHEMA_VERSION, "settings schema must advance");
    },
    refusal: { mode: "throw", code: "SETTINGS_STORE_MIGRATION_RECOVERY_UNVERIFIED" },
  });

  // ---------------------------------------------------------------------------
  // 9. storage connections — readStore rewrite, via listConnections
  // ---------------------------------------------------------------------------
  await runCase({
    name: "storage-connections",
    prepare(dir) {
      const configDir = setConfigDir(dir);
      this._file = path.join(configDir, "storage-connections.json");
      this._backup = `${this._file}.schema-v0.backup`;
      this._legacy = writeJsonFile(this._file, { defaultConnectionId: "local", connections: [] });
    },
    paths() {
      return { filePath: this._file, backupPath: this._backup, legacyBytes: this._legacy };
    },
    run: () => storageConnectionService.listConnections(),
    verifyMigrated(filePath) {
      assert.strictEqual(readJson(filePath).schemaVersion, storageConnectionService.STORAGE_CONNECTIONS_SCHEMA_VERSION, "storage-connections schema must advance");
    },
    refusal: { mode: "throw", code: "STORAGE_CONNECTION_MIGRATION_RECOVERY_UNVERIFIED" },
  });

  // ---------------------------------------------------------------------------
  // 10. SSH profiles — readProfilesConfig rewrite, via listProfiles
  // ---------------------------------------------------------------------------
  await runCase({
    name: "ssh-profiles",
    prepare(dir) {
      const configDir = setConfigDir(dir);
      this._file = path.join(configDir, "ssh-profiles.json");
      this._backup = `${this._file}.schema-v0.backup`;
      this._legacy = writeJsonFile(this._file, { servers: [], profiles: [] });
    },
    paths() {
      return { filePath: this._file, backupPath: this._backup, legacyBytes: this._legacy };
    },
    run: () => new SshService().listProfiles(),
    verifyMigrated(filePath) {
      assert.strictEqual(readJson(filePath).schemaVersion, SSH_PROFILES_SCHEMA_VERSION, "ssh-profiles schema must advance");
    },
    refusal: { mode: "throw", code: "SSH_PROFILES_MIGRATION_RECOVERY_UNVERIFIED" },
  });

  // ---------------------------------------------------------------------------
  // 11. agent runtime config — migrateConfig rewrite
  // ---------------------------------------------------------------------------
  await runCase({
    name: "agent-runtime-config",
    prepare(dir) {
      this._file = path.join(dir, "agent-runtime.json");
      this._backup = `${this._file}.pre-migration-v0.backup`;
      this._legacy = writeJsonFile(this._file, { bindAddress: "127.0.0.1", port: 47131 });
    },
    paths() {
      return { filePath: this._file, backupPath: this._backup, legacyBytes: this._legacy };
    },
    run() {
      return agentRuntimeConfigStore.readAgentRuntimeConfig(this._file, { defaults: {} });
    },
    verifyMigrated(filePath) {
      assert.strictEqual(readJson(filePath).schemaVersion, agentRuntimeConfigStore.AGENT_RUNTIME_CONFIG_SCHEMA_VERSION, "agent-runtime-config schema must advance");
    },
    refusal: { mode: "throw", code: "AGENT_RUNTIME_CONFIG_MIGRATION_RECOVERY_UNVERIFIED" },
  });

  // ---------------------------------------------------------------------------
  // 12. agent config/token store — readAgentConfigFile rewrite
  // ---------------------------------------------------------------------------
  await runCase({
    name: "agent-config",
    prepare(dir) {
      this._file = path.join(dir, "agent.json");
      this._backup = `${this._file}.schema-v0.backup`;
      this._legacy = writeJsonFile(this._file, { backendMode: "local", agentUrl: "http://127.0.0.1:47131", agentToken: "" });
    },
    paths() {
      return { filePath: this._file, backupPath: this._backup, legacyBytes: this._legacy };
    },
    run() {
      return agentTokenStore.readAgentConfigFile(this._file);
    },
    verifyMigrated(filePath) {
      assert.strictEqual(readJson(filePath).schemaVersion, agentTokenStore.AGENT_CONFIG_SCHEMA_VERSION, "agent-config schema must advance");
    },
    refusal: { mode: "throw", code: "AGENT_CONFIG_MIGRATION_RECOVERY_UNVERIFIED" },
  });

  // ---------------------------------------------------------------------------
  // 13. public-access registry — readRegistry rewrite
  // ---------------------------------------------------------------------------
  await runCase({
    name: "public-access-registry",
    prepare(dir) {
      this._file = path.join(dir, "public-access-services.json");
      this._backup = `${this._file}.schema-v0.backup`;
      this._legacy = writeJsonFile(this._file, { services: [] });
    },
    paths() {
      return { filePath: this._file, backupPath: this._backup, legacyBytes: this._legacy };
    },
    run() {
      return publicAccessServiceRegistry.readRegistry({ filePath: this._file });
    },
    verifyMigrated(filePath) {
      assert.strictEqual(readJson(filePath).schemaVersion, publicAccessServiceRegistry.SCHEMA_VERSION, "public-access schema must advance");
    },
    refusal: { mode: "throw", code: "PUBLIC_ACCESS_MIGRATION_RECOVERY_UNVERIFIED" },
  });

  // ---------------------------------------------------------------------------
  // 14. owner accounts — readOwnerAccountsFile rewrite
  // ---------------------------------------------------------------------------
  await runCase({
    name: "owner-accounts",
    prepare(dir) {
      const configDir = path.join(dir, "config");
      fs.mkdirSync(configDir, { recursive: true });
      this._file = path.join(configDir, "owner-accounts.json");
      this._backup = `${this._file}.schema-v0.backup`;
      this._legacy = writeJsonFile(this._file, { userIds: ["owner-smoke-user"], emails: ["owner@example.test"] });
    },
    paths() {
      return { filePath: this._file, backupPath: this._backup, legacyBytes: this._legacy };
    },
    run() {
      return ownerAccountConfig.readOwnerAccountsFile(path.dirname(this._file));
    },
    verifyMigrated(filePath) {
      assert.strictEqual(readJson(filePath).schemaVersion, ownerAccountConfig.OWNER_ACCOUNTS_SCHEMA_VERSION, "owner-accounts schema must advance");
    },
    refusal: { mode: "throw", code: "OWNER_ACCOUNT_MIGRATION_RECOVERY_UNVERIFIED" },
  });

  // ---------------------------------------------------------------------------
  // 15. owner workspace — readState rewrite, driven through getWorkspace with
  //     the owner authorization gate stubbed (the migration branch itself is
  //     what is under test here).
  // ---------------------------------------------------------------------------
  const realRequireOwner = securityService.requireOwner;
  securityService.requireOwner = () => ({ id: "smoke-owner", role: "Owner" });
  let ownerWorkspaceService;
  try {
    ownerWorkspaceService = require("../src/services/ownerWorkspaceService");
  } finally {
    securityService.requireOwner = realRequireOwner;
  }
  await runCase({
    name: "owner-workspace",
    prepare(dir) {
      const configDir = setConfigDir(dir);
      this._file = path.join(configDir, "owner-workspace", "workspace.json");
      this._backup = `${this._file}.schema-v0.backup`;
      this._legacy = writeJsonFile(this._file, { contents: {}, apiHistory: [] });
    },
    paths() {
      return { filePath: this._file, backupPath: this._backup, legacyBytes: this._legacy };
    },
    run() {
      const real = securityService.requireOwner;
      securityService.requireOwner = () => ({ id: "smoke-owner", role: "Owner" });
      try {
        return ownerWorkspaceService.getWorkspace();
      } finally {
        securityService.requireOwner = real;
      }
    },
    verifyMigrated(filePath) {
      assert.strictEqual(readJson(filePath).version, ownerWorkspaceService.WORKSPACE_VERSION, "owner-workspace schema must advance");
    },
    refusal: { mode: "throw", code: "OWNER_WORKSPACE_MIGRATION_RECOVERY_UNVERIFIED" },
  });

  assert.strictEqual(covered.length, 15, `expected 15 wired stores covered, saw ${covered.length}`);

  console.log(JSON.stringify({
    status: "PASS",
    classification: "MIGRATION STORE RECOVERY POINTS VERIFIED-OR-REFUSED",
    storesCovered: results.length,
    proceededWithVerifiedRecoveryPoint: results.length,
    refusedOnUnverifiableRecoveryPoint: results.length,
    refusedLeavesStoreByteIdentical: results.length,
    corruptRecoveryPointsWereSameLengthDifferentBytes: true,
    preExistingRecoveryPointsNeverDeleted: true,
    restoreDrillRun: false,
    stores: results.map((entry) => entry.store),
  }, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    delete process.env.ANXHUB_CONFIG_DIR;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });