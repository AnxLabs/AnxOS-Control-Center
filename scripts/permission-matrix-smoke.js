// V2-I Wave 1: standing actor x resource x action permission-matrix harness.
//
// Asserts the CURRENT permission model end to end against the declarative
// table in test-helpers/permission-matrix.js:
//   1. Pure cross-checks of the table against the real decision functions
//      (securityService ROLE_PERMISSIONS/userHasPermission, agent
//      permissions.authorizeApiPermission, auth.isAuthorized, and the
//      enrollment route permission map).
//   2. Desktop IPC handler-level exercise: real securityService guards with
//      stubbed transports, every matrix cell asserted (allow/deny, denial
//      code, audit-on-denial), a locked-desktop sweep across every privileged
//      channel, and node-context invariants.
//   3. Agent REST route-level exercise against real spawned Agents with
//      pinned roots: full-profile, restricted-profile, and unauthenticated
//      actors, cross-node token refusal, and enrollment-binding drift.
//   4. Coverage enforcement: every registered IPC channel and every Agent
//      REST route family must have a matrix row, or the harness fails.
const assert = require("assert");
const { EventEmitter } = require("events");
const fs = require("fs");
const Module = require("module");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const bcrypt = require("bcryptjs");

const rootDir = path.resolve(__dirname, "..");
const matrix = require("../test-helpers/permission-matrix");
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");

const AUTHORIZATION_GATE_CODES = new Set([
  "UNAUTHORIZED",
  "AGENT_TOKEN_MISSING",
  "API_PERMISSION_DENIED",
  "NODE_BINDING_MISMATCH",
  "REVOKED",
]);
const AUDIT_ACTION_BY_CODE = {
  PERMISSION_DENIED: "security.permission",
  OWNER_REQUIRED: "security.ownerWorkspace",
  FORBIDDEN: "security.ownerWorkspace",
};

// ---------------------------------------------------------------------------
// Hermetic root pinning. Must run BEFORE any src/ module is required.
// ---------------------------------------------------------------------------
const smokeRoot = pinAgentRoots("anx-permission-matrix-");
process.env.ANXOS_FORCE_PRODUCTION = "1";
const configDirectory = path.join(smokeRoot, "config");
fs.mkdirSync(configDirectory, { recursive: true });

// ---------------------------------------------------------------------------
// Transport stubs (recorded so deny probes can prove the guard ran first).
// ---------------------------------------------------------------------------
const serviceInvocations = new Map();
function recordService(name) {
  serviceInvocations.set(name, (serviceInvocations.get(name) || 0) + 1);
}
function makeRecordingFunction(name) {
  return async () => { recordService(name); return {}; };
}
function makeRecordingProxy(prefix) {
  return new Proxy({}, {
    get: (target, property) => {
      if (typeof property === "symbol") return undefined;
      if (Object.prototype.hasOwnProperty.call(target, property)) return target[property];
      return makeRecordingFunction(`${prefix}.${String(property)}`);
    },
  });
}

class MockFileService extends EventEmitter {}
for (const method of ["list", "identity", "readText", "writeText", "upload", "download", "delete", "mkdir", "newFile", "rename", "copy", "disconnect", "cancelTransfer"]) {
  MockFileService.prototype[method] = makeRecordingFunction(`fileService.${method}`);
}
class MockSshService extends EventEmitter {}
for (const method of ["listProfiles", "saveProfile", "deleteProfile", "assignProfileToNode", "connect", "getSession", "write", "resize", "approveHostKey", "disconnect"]) {
  MockSshService.prototype[method] = makeRecordingFunction(`sshService.${method}`);
}

const ipcHandlers = new Map();
const ipcEventListeners = new Set();
const fakeSender = { send: () => {}, isDestroyed: () => false };
const fakeStorageWindow = { isDestroyed: () => false, webContents: fakeSender };
const electronStub = {
  ipcMain: {
    handle: (channel, handler) => ipcHandlers.set(channel, handler),
    on: (channel) => ipcEventListeners.add(channel),
  },
  BrowserWindow: { getAllWindows: () => [], fromWebContents: () => null },
  dialog: {
    showOpenDialog: async () => ({ canceled: true }),
    showSaveDialog: async () => ({ canceled: true }),
  },
  clipboard: { writeText: () => {} },
  shell: { openPath: async () => "", openExternal: async () => {}, showItemInFolder: () => {} },
  app: { getPath: () => smokeRoot, isPackaged: false },
  safeStorage: { isEncryptionAvailable: () => false },
};

const serviceStubs = {
  "../services/serviceRouter": makeRecordingProxy("serviceRouter"),
  "../services/nodeService": new Proxy({
    getExecutionTarget: () => ({ type: "local", config: { backendMode: "local" } }),
    getNode: () => null,
    getSelectedNodeId: () => null,
  }, {
    get: (target, property) => target[property] || makeRecordingFunction(`nodeService.${String(property)}`),
  }),
  "../services/activeNodeSelectionService": {
    restorePersistedActiveNode: makeRecordingFunction("activeNodeSelectionService.restorePersistedActiveNode"),
    setActiveNode: makeRecordingFunction("activeNodeSelectionService.setActiveNode"),
  },
  "../services/fleetService": {
    getFleetSummary: makeRecordingFunction("fleetService.getFleetSummary"),
    runFleetBatchAction: makeRecordingFunction("fleetService.runFleetBatchAction"),
  },
  "../services/agentControlService": makeRecordingProxy("agentControlService"),
  "../services/maintenanceService": makeRecordingProxy("maintenanceService"),
  "../services/marketplaceService": makeRecordingProxy("marketplaceService"),
  "../services/marketplaceInstallService": Object.assign(makeRecordingProxy("marketplaceInstallService"), {
    marketplaceInstallEvents: new EventEmitter(),
  }),
  "../services/externalUrlService": { openExternalUrl: makeRecordingFunction("externalUrlService.openExternalUrl") },
  "../services/fileService": { FileService: MockFileService },
  "../services/storageConnectionService": {
    deleteConnection: makeRecordingFunction("storageConnectionService.deleteConnection"),
    listConnections: makeRecordingFunction("storageConnectionService.listConnections"),
    saveConnection: makeRecordingFunction("storageConnectionService.saveConnection"),
    setDefaultConnection: makeRecordingFunction("storageConnectionService.setDefaultConnection"),
    testConnection: makeRecordingFunction("storageConnectionService.testConnection"),
  },
  "../services/sshService": { SshService: MockSshService },
  "../services/accountAuthService": {
    getStatus: makeRecordingFunction("accountAuthService.getStatus"),
    restoreSession: makeRecordingFunction("accountAuthService.restoreSession"),
    startDeviceLogin: makeRecordingFunction("accountAuthService.startDeviceLogin"),
    loginWithPassword: makeRecordingFunction("accountAuthService.loginWithPassword"),
    checkDeviceLogin: makeRecordingFunction("accountAuthService.checkDeviceLogin"),
    cancelDeviceLogin: makeRecordingFunction("accountAuthService.cancelDeviceLogin"),
    refreshSession: makeRecordingFunction("accountAuthService.refreshSession"),
    openAccountPage: makeRecordingFunction("accountAuthService.openAccountPage"),
    listAccountDevices: makeRecordingFunction("accountAuthService.listAccountDevices"),
    revokeCurrentDevice: makeRecordingFunction("accountAuthService.revokeCurrentDevice"),
    logout: makeRecordingFunction("accountAuthService.logout"),
    redactSecret: (value) => String(value ?? ""),
  },
  "../services/settingsPreferenceService": {
    readPreferences: makeRecordingFunction("settingsPreferenceService.readPreferences"),
    resetPreferences: makeRecordingFunction("settingsPreferenceService.resetPreferences"),
    updatePreferences: makeRecordingFunction("settingsPreferenceService.updatePreferences"),
  },
  "../services/providerConfigService": {
    getMarketplaceConfigPath: () => path.join(configDirectory, "marketplace.json"),
    readMarketplaceConfigSafe: () => ({ config: {}, recovery: { degraded: false, message: null } }),
    saveMarketplaceConfig: makeRecordingFunction("providerConfigService.saveMarketplaceConfig"),
  },
  "../services/providers/curseforgeProvider": {
    _test: {
      getApiKeyStatus: () => ({ configured: false, source: null }),
      getConfigurationDiagnostics: () => ({ configured: false }),
    },
  },
  "../services/workloadTransferService": makeRecordingProxy("workloadTransferService"),
  "../services/systemService": { getSystemSnapshot: makeRecordingFunction("systemService.getSystemSnapshot") },
  "../services/actionRouter": { executeAction: makeRecordingFunction("actionRouter.executeAction") },
  "../services/diagnosticsService": {
    log: () => {},
    logError: () => {},
    updateRuntimeState: () => {},
    captureSnapshot: async () => ({}),
    readLogs: async () => ({ lines: [] }),
    openFolder: () => {},
    copySummary: async () => "summary",
    exportBundle: async () => ({}),
  },
};
const universalServiceProxy = makeRecordingProxy("unstubbedService");

const originalModuleLoad = Module._load;
// Services whose guards ARE the real permission model must never be stubbed:
// securityService, settingsPermissionService, and ownerWorkspaceService all
// stay real so every IPC probe runs the actual decision functions.
const REAL_SERVICES = new Set([
  "../services/securityService",
  "../services/settingsPermissionService",
  "../services/ownerWorkspaceService",
]);
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return electronStub;
  if (request === "./expectedAgentError") return { wrapExpectedAgentRead: async (_channel, task) => task() };
  if (Object.prototype.hasOwnProperty.call(serviceStubs, request)) return serviceStubs[request];
  if (request.startsWith("../services/") && !REAL_SERVICES.has(request)) return universalServiceProxy;
  return originalModuleLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------------------
// Register every src/ipc module with the stubbed transports and the REAL
// securityService / settingsPermissionService / authRecoveryState.
// ---------------------------------------------------------------------------
try {
  require("../src/ipc/diagnosticsIpc").registerDiagnosticsIpc();
  require("../src/ipc/accountAuthIpc").registerAccountAuthIpc();
  require("../src/ipc/securityIpc").registerSecurityIpc();
  require("../src/ipc/agentControlIpc").registerAgentControlIpc();
  require("../src/ipc/dependenciesIpc").registerDependenciesIpc();
  require("../src/ipc/storageWindowIpc").registerStorageWindowIpc({
    closeWindow: async () => {},
    getMainWindow: () => fakeStorageWindow,
    getStorageWindow: () => fakeStorageWindow,
    notifySaved: () => {},
    openWindow: async () => {},
  });
  const updateManagerStub = {
    initialize: () => {},
    getState: () => ({}),
    check: async () => ({}),
    download: async () => ({}),
    install: async () => ({}),
    openDownload: () => {},
    openRelease: () => {},
    skip: async () => ({}),
    on: () => {},
  };
  const developerUpdaterStub = {
    getState: () => ({}),
    check: async () => ({}),
    update: async () => ({}),
    restart: () => {},
    openChanges: () => {},
  };
  const updatesIpc = require("../src/ipc/updatesIpc");
  updatesIpc.registerUpdatesIpc(updateManagerStub);
  updatesIpc.registerDeveloperUpdatesIpc(developerUpdaterStub);
  require("../src/ipc/actionIpc").registerActionIpc();
  require("../src/ipc/systemIpc").registerSystemIpc();
  require("../src/ipc/ampIpc").registerAmpIpc();
  require("../src/ipc/backupsIpc").registerBackupsIpc();
  require("../src/ipc/playitIpc").registerPlayitIpc();
  require("../src/ipc/publicAccessIpc").registerPublicAccessIpc();
  require("../src/ipc/dockerIpc").registerDockerIpc();
  require("../src/ipc/instancesIpc").registerInstancesIpc();
  require("../src/ipc/marketplaceIpc").registerMarketplaceIpc();
  require("../src/ipc/maintenanceIpc").registerMaintenanceIpc();
  require("../src/ipc/nodesIpc").registerNodesIpc();
  require("../src/ipc/workloadIpc").registerWorkloadIpc();
  require("../src/ipc/ownerWorkspaceIpc").registerOwnerWorkspaceIpc();
  require("../src/ipc/filesIpc").registerFilesIpc();
  require("../src/ipc/settingsIpc").registerSettingsIpc();
  require("../src/ipc/sshIpc").registerSshIpc();
} finally {
  Module._load = originalModuleLoad;
}

// ---------------------------------------------------------------------------
// Real decision functions used to derive and cross-check the table.
// ---------------------------------------------------------------------------
const security = require("../src/services/securityService");
const agentPermissions = require("../agent/src/permissions");
const enrollRoutes = require("../agent/src/routes/enroll");
const agentAuth = require("../agent/src/auth");
const { tokenFingerprint } = require("../src/shared/agentTokenStore");
const auditLogPath = path.join(configDirectory, "audit.log");
function readAuditEntries() {
  try {
    return fs.readFileSync(auditLogPath, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Desktop actor session management (real securityService against the seeded
// local security store).
// ---------------------------------------------------------------------------
const OWNER_PASSWORD = "matrix-owner-password-1";
const OPERATOR_PASSWORD = "matrix-operator-password-1";
const VIEWER_PASSWORD = "matrix-viewer-password-1";

function seedSecurityStore() {
  const users = [
    { id: "matrix-owner", username: "matrix-owner", role: "Owner", passwordHash: bcrypt.hashSync(OWNER_PASSWORD, 12) },
    { id: "matrix-operator", username: "matrix-operator", role: "Operator", passwordHash: bcrypt.hashSync(OPERATOR_PASSWORD, 12) },
    { id: "matrix-viewer", username: "matrix-viewer", role: "Viewer", passwordHash: bcrypt.hashSync(VIEWER_PASSWORD, 12) },
  ];
  fs.writeFileSync(path.join(configDirectory, "security.json"), `${JSON.stringify({
    schemaVersion: 1,
    users,
    persistentSessions: [],
    trustedDevices: [],
    agentTokens: {},
    settings: {},
  }, null, 2)}\n`);
}

async function signIn(username, password) {
  const result = await security.login({ username, password });
  assert.strictEqual(result.localOwnerAuthenticated, true, `${username} session must establish local authentication.`);
  return result;
}

async function switchActor(actor) {
  security.logout();
  if (actor === "owner-unlocked") await signIn("matrix-owner", OWNER_PASSWORD);
  if (actor === "operator-unlocked") await signIn("matrix-operator", OPERATOR_PASSWORD);
  if (actor === "viewer-unlocked") await signIn("matrix-viewer", VIEWER_PASSWORD);
}

// ---------------------------------------------------------------------------
// Probe payloads: a universal payload satisfies every requireNodeContext
// call that precedes the permission guard.
// ---------------------------------------------------------------------------
const UNIVERSAL_PAYLOAD = {
  nodeId: "matrix-node-a",
  instanceId: "matrix-instance",
  id: "matrix-instance",
  backupId: "matrix-backup",
  scheduleId: "matrix-schedule",
  profileId: "matrix-profile",
  sessionId: "matrix-session",
  container: "matrix-container",
  image: "matrix-image",
  volume: "matrix-volume",
  network: "matrix-network",
  name: "matrix-name",
  path: "matrix-path",
  version: "0.0.0",
  actionId: "docker.start",
  params: {},
  settings: { "ui.theme": "dark" },
  category: "network",
};

const DESKTOP_PROBES = {
  account: { channel: "account:getStatus" },
  "security-public": { channel: "security:getStatus", serviceRecorded: false },
  "security-session": { channel: "security:updateSessionSettings", payload: { inactiveSessionExpirationMs: 86400000 }, serviceRecorded: false },
  "security-owner": { channel: "security:lockOwnerWorkspace", serviceRecorded: false },
  "owner-workspace": { channel: "ownerWorkspace:getWorkspace", serviceRecorded: false },
  "owner-workspace-public": { channel: "ownerWorkspace:getStatus", serviceRecorded: false },
  "agent-control": { channel: "agentControl:list" },
  "action-bridge": { channel: "action:execute", payload: { actionId: "docker.start", params: {} } },
  "action-bridge-restore": { channel: "action:execute", payload: { actionId: "backup.restore", params: {} } },
  "docker-read": { channel: "docker:getSnapshot" },
  "docker-compose-read": { channel: "docker:compose", payload: { action: "config", projectName: "matrix-project" } },
  "docker-lifecycle": { channel: "docker:start" },
  "docker-write": { channel: "docker:create" },
  "docker-delete": { channel: "docker:removeImage" },
  "instances-read": { channel: "instances:list" },
  "instances-write": { channel: "instances:update" },
  "instances-lifecycle": { channel: "instances:start" },
  "instances-delete": { channel: "instances:delete" },
  "instance-files": { channel: "instances:writeFile", payload: { path: "matrix-file.txt" } },
  "instances-open-folder": { channel: "instances:openFolder" },
  "backups-read": { channel: "backups:list" },
  "backups-write": { channel: "backups:create" },
  "backups-restore": { channel: "backups:restore" },
  "dependencies-read": { channel: "dependencies:getCatalog" },
  "dependencies-install": { channel: "dependencies:install" },
  "diagnostics-log": { channel: "diagnostics:log", payload: { severity: "info", operation: "matrix", message: "matrix probe" }, serviceRecorded: false },
  "diagnostics-manage": { channel: "diagnostics:read", serviceRecorded: false },
  "files-read": { channel: "files:identity" },
  "files-write": { channel: "files:writeText", payload: { path: "matrix-file.txt" } },
  "files-connections": { channel: "files:saveConnection", payload: { host: "matrix-host" } },
  "marketplace-read": { channel: "marketplace:listTemplates" },
  "marketplace-install": { channel: "marketplace:installTemplate", payload: { templateId: "matrix-template" } },
  "nodes-read": { channel: "nodes:list", payload: {} },
  "nodes-credential-read": { channel: "nodes:health", payload: { nodeId: "matrix-node-a" } },
  "nodes-write": { channel: "nodes:save", payload: { nodeId: "matrix-node", displayName: "Matrix Node" } },
  "settings-read": { channel: "settings:getPreferences" },
  "settings-permissions-read": { channel: "settings:getPermissions", serviceRecorded: false },
  "settings-preferences": { channel: "settings:resetPreferences", payload: { category: "network" } },
  "settings-agent-config": { channel: "settings:getAgentConfig", serviceRecorded: false },
  "settings-marketplace-config": { channel: "settings:getMarketplaceConfig", serviceRecorded: false },
  "ssh-read": { channel: "ssh:listProfiles" },
  "ssh-write": { channel: "ssh:connect", payload: { instanceId: "matrix-instance" } },
  "ssh-manage": { channel: "ssh:saveProfile", payload: { profileId: "matrix-profile" } },
  "system-read": { channel: "system:getSnapshot" },
  "public-access-read": { channel: "publicAccess:getSnapshot" },
  "public-access-write": { channel: "publicAccess:createService", payload: { nodeId: "matrix-node", instanceId: "matrix-instance" } },
  "amp-read": { channel: "amp:getSnapshot" },
  "playit-read": { channel: "playit:getSnapshot" },
  maintenance: { channel: "maintenance:scan" },
  "updates-read": { channel: "updates:getState", serviceRecorded: false },
  "updates-manage": { channel: "updates:skip", payload: { version: "0.0.0" }, serviceRecorded: false },
  "developer-updates": { channel: "developerUpdates:getState", serviceRecorded: false },
  "storage-window-open": { channel: "storageWindow:open", serviceRecorded: false },
  "storage-window-internal": { channel: "storageWindow:close", serviceRecorded: false },
  "workload-transfer": { channel: "workload:transferPreview", payload: { sourceNodeId: "matrix-node-a", targetNodeId: "matrix-node-b", sourceInstanceId: "matrix-instance" } },
};

function channelFamilyMap() {
  const map = new Map();
  for (const family of matrix.IPC_FAMILIES) {
    for (const channel of family.channels) {
      // A channel may be declared by multiple families only when each
      // declaring family pins a different representative action tier (the
      // action bridge); everything else must be single-family.
      if (map.has(channel)) {
        assert(
          family.actionTiers && map.get(channel).actionTiers,
          `Matrix bug: channel ${channel} declared by families ${map.get(channel)?.id} and ${family.id} without distinct action tiers.`,
        );
        continue;
      }
      map.set(channel, family);
    }
  }
  return map;
}

function handlerFor(channel) {
  const handler = ipcHandlers.get(channel);
  assert(handler, `Channel ${channel} is not registered by any src/ipc module.`);
  return handler;
}

// Desktop IPC channels report denials through two contracts: a thrown error
// with a code (createIpcError rethrow) or a resolved { ok: false, error }
// payload (dependencies/marketplace/public-access error-response contract).
// Both must carry the exact expected denial code.
function denialCodeOfOutcome(failure, resolvedResult) {
  if (failure?.code) return failure.code;
  if (resolvedResult?.ok === false) {
    return resolvedResult?.error?.code || resolvedResult?.code || null;
  }
  return null;
}

async function expectIpcDenial(channel, payload, expected, auditBefore, { serviceRecorded = true, event = {} } = {}) {
  serviceInvocations.clear();
  let failure = null;
  let resolvedResult = null;
  try {
    resolvedResult = await handlerFor(channel)({ sender: fakeSender, ...event }, payload);
  } catch (error) {
    failure = error;
  }
  const denialCode = denialCodeOfOutcome(failure, resolvedResult);
  assert(
    denialCode === expected.code,
    `${channel}: expected denial code ${expected.code} but saw ${denialCode || "no denial"} (${failure?.message || JSON.stringify(resolvedResult || null)}).`,
  );
  if (expected.audit) {
    const denied = readAuditEntries().slice(auditBefore.length)
      .filter((entry) => entry.outcome === "denied");
    assert(
      denied.some((entry) => entry.action === AUDIT_ACTION_BY_CODE[expected.code]),
      `${channel}: ${expected.code} denial must append an audited entry (${AUDIT_ACTION_BY_CODE[expected.code]}), audit log had none.`,
    );
  }
  if (serviceRecorded) {
    assert.strictEqual(serviceInvocations.size, 0, `${channel}: a denied request must not reach any transport service.`);
  }
  return failure || resolvedResult;
}

const AUTHORIZATION_DENIED_CODES = new Set([
  ...AUTHORIZATION_GATE_CODES,
  "LOGIN_REQUIRED",
  "LOCAL_AUTHENTICATION_REQUIRED",
  "AUTH_UNLOCK_REQUIRED",
  "PERMISSION_DENIED",
  "OWNER_REQUIRED",
  "FORBIDDEN",
]);

async function expectIpcAllow(channel, payload, { serviceRecorded = true, event = {} } = {}) {
  serviceInvocations.clear();
  let failure = null;
  let result = null;
  try {
    result = await handlerFor(channel)({ sender: fakeSender, ...event }, payload);
  } catch (error) {
    failure = error;
  }
  const denialCode = denialCodeOfOutcome(failure, result);
  assert(
    !denialCode || !AUTHORIZATION_DENIED_CODES.has(denialCode),
    `${channel}: expected the guard to allow this actor but the handler was denied (${denialCode}: ${failure?.message || "resolved denial payload"}).`,
  );
  if (serviceRecorded) {
    assert(serviceInvocations.size > 0, `${channel}: allow probe must reach its transport service once the guard passes.`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Phase 1: cross-check the table against the real pure decision functions.
// ---------------------------------------------------------------------------
function crossCheckTableAgainstRealFunctions() {
  const { getRolePermissions } = security;
  const desktopRoleByActor = {
    "owner-unlocked": "Owner",
    "operator-unlocked": "Operator",
    "viewer-unlocked": "Viewer",
  };
  for (const family of matrix.IPC_FAMILIES) {
    if (family.guard === "none") continue;
    if (family.actionTiers) {
      const { ACTION_PERMISSIONS } = require("../src/ipc/actionIpc");
      for (const [actionId, tier] of Object.entries(family.actionTiers)) {
        assert.strictEqual(
          ACTION_PERMISSIONS.get(actionId),
          tier,
          `Matrix drift: action bridge tier for ${actionId} disagrees with actionIpc ACTION_PERMISSIONS.`,
        );
      }
      continue;
    }
    for (const [actor, role] of Object.entries(desktopRoleByActor)) {
      const expected = matrix.expectedDesktopOutcome(family, actor);
      // Capability/unlock denials are decided before the tier is consulted,
      // so the role tables cannot contradict them.
      if (expected.code === "AUTH_UNLOCK_REQUIRED" || expected.code === "FORBIDDEN") continue;
      const roleGrants = family.tier === null || role === "Owner" || getRolePermissions(role).includes(family.tier);
      assert.strictEqual(
        roleGrants,
        family.allow.includes(actor),
        `Matrix drift for family ${family.id}: actor ${actor} (${role}) row disagrees with the real role tables for tier ${family.tier}.`,
      );
    }
  }

  // Agent REST cross-checks against the real decision functions. The explicit
  // profile override pins the restricted default independently of this
  // process's ANXHUB_CONFIG_DIR (which makes the in-process profile
  // local-owner).
  const savedProfile = process.env.AGENT_PERMISSION_PROFILE;
  const savedApiPermissions = process.env.AGENT_API_PERMISSIONS;
  try {
    delete process.env.AGENT_API_PERMISSIONS;
    delete process.env.AGENT_PERMISSION_PROFILE;
    const fullPermissions = agentPermissions.getConfiguredApiPermissions();
    assert(
      agentPermissions.isLocalOwnerProfile() && fullPermissions.has("*"),
      "Local-owner profile agents must default to the '*' API permission set.",
    );
    process.env.AGENT_PERMISSION_PROFILE = "restricted";
    assert.deepStrictEqual(
      [...agentPermissions.getConfiguredApiPermissions()],
      [],
      "Restricted-profile agents must fail closed with no default grants.",
    );
  } finally {
    if (savedProfile === undefined) delete process.env.AGENT_PERMISSION_PROFILE;
    else process.env.AGENT_PERMISSION_PROFILE = savedProfile;
    if (savedApiPermissions === undefined) delete process.env.AGENT_API_PERMISSIONS;
    else process.env.AGENT_API_PERMISSIONS = savedApiPermissions;
  }

  // Per-family restricted derivation: the explicit profile override must be
  // removed again before the harness continues (the spawned agents derive
  // their profiles from this process's environment).
  try {
    for (const family of matrix.REST_FAMILIES) {
      const expected = matrix.expectedRestOutcome(family, "agent-restricted-profile");
      process.env.AGENT_PERMISSION_PROFILE = "restricted";
      delete process.env.AGENT_API_PERMISSIONS;
      const restricted = agentPermissions.authorizeApiPermission(family.tier);
      assert.strictEqual(restricted.ok, expected.allow, `Matrix drift for REST family ${family.id}: restricted-profile expectation disagrees with authorizeApiPermission.`);
      if (!restricted.ok) {
        assert.strictEqual(restricted.code, "API_PERMISSION_DENIED", `REST family ${family.id}: restricted denial must be API_PERMISSION_DENIED.`);
      }
      // Owner/agent:manage tiers come from server.js getRoutePermission; the
      // enrollment-surface members must agree with the enrollment route
      // permission map, and diagnostics is the only other owner-tier family.
      if (family.tier === "owner") {
        if (family.id === "rest-enroll-revoke") {
          assert.strictEqual(enrollRoutes.getEnrollmentRoutePermission("/api/v1/enroll/revoke"), "owner", "Enroll revoke must remain the owner-tier enrollment route.");
        } else {
          assert.strictEqual(family.id, "rest-diagnostics", `Matrix drift: unexpected owner-tier REST family ${family.id}.`);
        }
      }
      if (family.tier === "agent:manage") {
        // /api/v1/system/agent-task carries the same tier directly from
        // server.js getRoutePermission; only credentials/rotate comes from the
        // enrollment route permission map.
        if (family.id === "rest-credentials-rotate") {
          assert.strictEqual(enrollRoutes.getEnrollmentRoutePermission("/api/v1/credentials/rotate"), "agent:manage", "Credential rotate must remain agent:manage.");
        } else {
          assert.strictEqual(family.id, "rest-agent-task", `Matrix drift: unexpected agent:manage REST family ${family.id}.`);
        }
      }
    }
  } finally {
    delete process.env.AGENT_PERMISSION_PROFILE;
    delete process.env.AGENT_API_PERMISSIONS;
  }

  assert(enrollRoutes.PUBLIC_ENROLL_PATHS.has("/api/v1/enroll/status"), "Enroll status must remain a public handshake path.");

  // Unauthenticated remote: every non-public route is refused by the real
  // bearer gate; public routes stay reachable through one of the three
  // pre-auth paths (health, the enrollment/pairing handshake, or the ui
  // browser entry bypass).
  const preAuthHandshakePaths = new Set([...enrollRoutes.PUBLIC_ENROLL_PATHS, "/api/v1/pairing/status"]);
  for (const family of matrix.REST_FAMILIES) {
    const route = family.routes[0];
    const expected = matrix.expectedRestOutcome(family, "unauthenticated-remote");
    if (family.publicRoute) {
      assert(expected.allow, `Matrix drift for REST family ${family.id}: public route must allow unauthenticated actors.`);
      const healthRoute = route.path === "/api/v1/health";
      const uiEntryRoute = route.path === "/api/v1/ui" && route.method === "GET";
      assert(
        healthRoute || uiEntryRoute || preAuthHandshakePaths.has(route.path),
        `REST family ${family.id}: marked public but no pre-auth path exists in the real gate chain.`,
      );
    } else {
      const auth = agentAuth.isAuthorized({ headers: {} }, { token: "matrix-agent-token" }, route.path);
      assert.strictEqual(auth.ok, expected.allow, `Matrix drift for REST family ${family.id}: unauthenticated expectation disagrees with auth.isAuthorized.`);
      if (!auth.ok) assert.strictEqual(auth.code, "UNAUTHORIZED", `REST family ${family.id}: unauthenticated denial must be UNAUTHORIZED.`);
    }
  }
}// ---------------------------------------------------------------------------
// Phase 2: desktop IPC handler-level exercise with the real permission core.
// ---------------------------------------------------------------------------
async function runActorProbes(actor) {
  for (const family of matrix.IPC_FAMILIES) {
    const probe = DESKTOP_PROBES[family.id];
    assert(probe, `Matrix bug: family ${family.id} has no desktop probe channel.`);
    const payload = { ...UNIVERSAL_PAYLOAD, ...(probe.payload || {}) };
    const expected = matrix.expectedDesktopOutcome(family, actor);
    if (expected.allow) {
      await expectIpcAllow(probe.channel, payload, { serviceRecorded: probe.serviceRecorded !== false });
    } else {
      const auditBefore = readAuditEntries();
      await expectIpcDenial(probe.channel, payload, expected, auditBefore, { serviceRecorded: probe.serviceRecorded !== false });
    }
  }
}

// Locked-desktop invariant: EVERY privileged channel must refuse a signed-out
// desktop with its family's denial code, before any transport work runs.
async function runLockedSweep(actor) {
  for (const [channel, family] of channelFamilyMap()) {
    if (family.guard === "none") continue;
    const expected = matrix.expectedDesktopOutcome(family, actor);
    const auditBefore = readAuditEntries();
    await expectIpcDenial(channel, { ...UNIVERSAL_PAYLOAD }, expected, auditBefore, { serviceRecorded: false });
  }
}

// Node-targeting invariant: node-aware instance requests must refuse to run
// without an explicit node context even for a fully authorized Owner.
async function runNodeContextInvariants() {
  for (const channel of ["instances:list", "instances:start", "instances:delete"]) {
    serviceInvocations.clear();
    let failure = null;
    try {
      await handlerFor(channel)({}, { instanceId: "matrix-instance" });
    } catch (error) {
      failure = error;
    }
    assert(failure, `Channel ${channel}: missing node context must be refused.`);
    assert.strictEqual(failure.code, "NODE_REQUIRED", `Channel ${channel}: expected NODE_REQUIRED for a node-less request, saw ${failure && failure.code}.`);
    assert.strictEqual(serviceInvocations.size, 0, `Channel ${channel}: node-less requests must not reach any transport.`);
  }
}

async function runDesktopMatrixPhase() {
  seedSecurityStore();

  // Guest: unauthenticated renderer with an Owner provisioned (fresh state).
  await runActorProbes("guest");

  // Local Owner, unlocked.
  await switchActor("owner-unlocked");
  await runActorProbes("owner-unlocked");
  await runNodeContextInvariants();

  // Local Owner, locked (signed out): sweep every privileged channel.
  await switchActor("owner-locked");
  await runActorProbes("owner-locked");
  await runLockedSweep("owner-locked");

  // Cross-user roles: Operator and Viewer sessions.
  await switchActor("operator-unlocked");
  await runActorProbes("operator-unlocked");
  await switchActor("viewer-unlocked");
  await runActorProbes("viewer-unlocked");
  security.logout();
}

// ---------------------------------------------------------------------------
// Phase 3: Agent REST route-level exercise against real spawned Agents.
// ---------------------------------------------------------------------------
const REST_STATUS_BY_CODE = {
  UNAUTHORIZED: 401,
  AGENT_TOKEN_MISSING: 503,
  API_PERMISSION_DENIED: 403,
  NODE_BINDING_MISMATCH: 453,
  REVOKED: 410,
};

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForAgent(url) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`, { redirect: "manual" })).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Matrix Agent did not become ready.");
}

async function restProbe(baseUrl, route, token) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (route.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${baseUrl}${route.path}`, {
    method: route.method,
    headers,
    body: route.body !== undefined ? JSON.stringify(route.body) : undefined,
    redirect: "manual",
  });
  let code = null;
  let detailsPermission = null;
  try {
    const payload = await response.json();
    code = payload?.error?.code || null;
    detailsPermission = payload?.error?.details?.permission || null;
  } catch {}
  return { status: response.status, code, detailsPermission };
}

async function runAgentRestPhase() {
  const fullDir = path.join(smokeRoot, "agents", "full");
  const restrictedDir = path.join(smokeRoot, "agents", "restricted");
  fs.mkdirSync(fullDir, { recursive: true });
  fs.mkdirSync(restrictedDir, { recursive: true });
  const tokenFull = "matrix-agent-token-full-profile";
  const tokenRestricted = "matrix-agent-token-restricted-profile";
  const portFull = await getFreePort();
  const portRestricted = await getFreePort();
  const urlFull = `http://127.0.0.1:${portFull}`;
  const urlRestricted = `http://127.0.0.1:${portRestricted}`;
  const spawnAgent = (configDir, port, token, extraEnv = {}) => spawn(process.execPath, [path.join(rootDir, "agent", "src", "server.js")], {
    cwd: path.join(rootDir, "agent"),
    env: {
      ...process.env,
      AGENT_HOST: "127.0.0.1",
      AGENT_PORT: String(port),
      AGENT_TOKEN: token,
      AGENT_FILE_ROOTS: smokeRoot,
      AGENT_INSTANCE_ROOT: path.join(configDir, "instances"),
      AGENT_BACKUP_ROOT: path.join(configDir, "backups"),
      ANXHUB_CONFIG_DIR: configDir,
      ANXHUB_AGENT_CONFIG_PATH: path.join(configDir, "agent.json"),
      AGENT_API_RATE_LIMIT_PER_MINUTE: "5000",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Pre-write each Agent's own agent.json (agent-api-authorization-smoke
  // pattern) so resolveAgentConfigPath finds the per-agent config instead of
  // falling through to any repo-level config directory.
  fs.writeFileSync(path.join(fullDir, "agent.json"), JSON.stringify({
    backendMode: "agent",
    agentUrl: urlFull,
    agentToken: tokenFull,
  }));
  fs.writeFileSync(path.join(restrictedDir, "agent.json"), JSON.stringify({
    backendMode: "agent",
    agentUrl: urlRestricted,
    agentToken: tokenRestricted,
  }));
  // Agent-side denial audit: auditAction emits scope:"agent_action_audit"
  // lines on stdout. Capture them so the harness can prove denied action
  // invocations are audited where the family audits.
  const collectAuditLines = (child) => {
    const lines = [];
    let remainder = "";
child.stdout.on("data", (chunk) => {
      remainder += String(chunk);
      const parts = remainder.split(/\r?\n/);
      remainder = parts.pop() || "";
      for (const line of parts) {
        if (line.includes("agent_action_audit")) lines.push(line);
      }
    });
    return lines;
  };
  const agents = [
    spawnAgent(fullDir, portFull, tokenFull, {}),
    // Explicit restricted profile: fail-closed, no configured grants.
    spawnAgent(restrictedDir, portRestricted, tokenRestricted, {
      AGENT_PERMISSION_PROFILE: "restricted",
      AGENT_API_PERMISSIONS: "",
    }),
  ];
  const fullAgentAuditLines = collectAuditLines(agents[0]);
  const restrictedAgentAuditLines = collectAuditLines(agents[1]);
  try {
    await waitForAgent(urlFull);
    await waitForAgent(urlRestricted);

    // Cross-node invariant: Agent A's credential must be refused by Agent B's
    // routes, while B's own credential still authenticates (and is then
    // refused on permissions only). Runs before the family loop so the
    // full-profile credential is still the configured one.
    const crossNode = await restProbe(urlRestricted, { method: "GET", path: "/api/v1/stats" }, tokenFull);
    assert.strictEqual(crossNode.code, "UNAUTHORIZED", `Cross-node: foreign agent token must be refused with UNAUTHORIZED, got ${crossNode.status} ${crossNode.code}.`);
    assert.strictEqual(crossNode.status, 401, "Cross-node refusal must use the 401 bearer gate.");
    const ownToken = await restProbe(urlRestricted, { method: "GET", path: "/api/v1/stats" }, tokenRestricted);
    assert.strictEqual(ownToken.code, "API_PERMISSION_DENIED", `Restricted agent's own token must authenticate (permission denial follows), got ${ownToken.status} ${ownToken.code}.`);

    for (const family of matrix.REST_FAMILIES) {
      for (const route of family.routes) {
        const cases = [
          ["unauthenticated-remote", urlFull, null],
          ["agent-full-profile", urlFull, tokenFull],
          ["agent-restricted-profile", urlRestricted, tokenRestricted],
        ];
        for (const [actor, baseUrl, token] of cases) {
          const probe = await restProbe(baseUrl, route, token);
          const expected = matrix.expectedRestOutcome(family, actor);
          if (expected.allow) {
            assert(
              !AUTHORIZATION_GATE_CODES.has(probe.code),
              `REST ${family.id} ${route.method} ${route.path} as ${actor}: expected the authorization gates to allow, got ${probe.status} ${probe.code}.`,
            );
          } else {
            assert.strictEqual(probe.code, expected.code, `REST ${family.id} ${route.method} ${route.path} as ${actor}: expected ${expected.code}, got ${probe.status} ${probe.code}.`);
            assert.strictEqual(probe.status, REST_STATUS_BY_CODE[expected.code], `REST ${family.id} ${route.method} ${route.path} as ${actor}: denial status drift.`);
            if (probe.code === "API_PERMISSION_DENIED") {
              assert.strictEqual(probe.detailsPermission, family.tier, `REST ${family.id}: denied permission detail must name the family tier.`);
            }
          }
        }
      }
    }

    // Enrollment binding drift: once the pinned tuple no longer matches, the
    // agent refuses privileged routes with NODE_BINDING_MISMATCH while health
    // and enrollment stay reachable. Runs last against the full-profile agent
    // with its post-rotate credential (the rotate probe rewrites the agent
    // config), because the binding gate sits behind the permission gate.
    const rotatedConfig = JSON.parse(fs.readFileSync(path.join(fullDir, "agent.json"), "utf8"));
    const effectiveToken = rotatedConfig.agentToken;
    assert(effectiveToken && effectiveToken !== tokenFull, "Credential rotate probe must have rewritten the agent credential.");
    fs.writeFileSync(path.join(fullDir, "enrollment.json"), `${JSON.stringify({
      schemaVersion: 1,
      state: "enrolled",
      tokenFingerprint: tokenFingerprint(effectiveToken),
      instanceRoot: path.join(fullDir, "other-root"),
    }, null, 2)}\n`);
    const drifted = await restProbe(urlFull, { method: "GET", path: "/api/v1/stats" }, effectiveToken);
    assert.strictEqual(drifted.code, "NODE_BINDING_MISMATCH", `Drifted agent must refuse privileged routes with NODE_BINDING_MISMATCH, got ${drifted.status} ${drifted.code}.`);
    assert.strictEqual(drifted.status, 453, "Binding drift refusal must use status 453.");
    const healthDuringDrift = await restProbe(urlFull, { method: "GET", path: "/api/v1/health" }, null);
    assert.strictEqual(healthDuringDrift.status, 200, "Health must stay reachable for a drifted agent.");
    const enrollDuringDrift = await restProbe(urlFull, { method: "GET", path: "/api/v1/enroll/status" }, null);
    assert.strictEqual(enrollDuringDrift.status, 200, "Enrollment status must stay reachable for a drifted agent.");

    // Denials must audit where the family audits: the actions bridge emits an
    // agent_action_audit record for every denied invocation, on both the
    // unauthenticated and the permission-refused paths.
    const parseAgentAudit = (lines) => lines.map((line) => JSON.parse(line));
    const fullAudit = parseAgentAudit(fullAgentAuditLines);
    assert(
      fullAudit.some((entry) => entry.actionId === "matrix-probe.action" && entry.outcome === "denied" && entry.reason === "UNAUTHORIZED"),
      "Unauthenticated action invocations must be audited as denied by the agent.",
    );
    const restrictedAudit = parseAgentAudit(restrictedAgentAuditLines);
    assert(
      restrictedAudit.some((entry) => entry.actionId === "matrix-probe.action" && entry.outcome === "denied" && entry.reason === "API_PERMISSION_DENIED" && entry.permission === "actions:execute"),
      "Permission-refused action invocations must be audited as denied with the tier named.",
    );
  } finally {
    for (const agent of agents) agent.kill("SIGTERM");
    await Promise.all(agents.map((agent) => new Promise((resolve) => agent.once("exit", resolve))));
  }
}
// ---------------------------------------------------------------------------
// Phase 4: coverage enforcement — every registered IPC channel and every
// Agent REST route family must have a matrix row.
// ---------------------------------------------------------------------------
function runCoverageEnforcement() {
  const registeredChannels = new Set([...ipcHandlers.keys()]);
  const declaredChannels = new Set(matrix.IPC_FAMILIES.flatMap((family) => family.channels));
  const uncoveredIpc = [...registeredChannels].filter((channel) => !declaredChannels.has(channel));
  assert.strictEqual(
    uncoveredIpc.length,
    0,
    `Uncovered desktop IPC channels (add matrix rows in test-helpers/permission-matrix.js): ${uncoveredIpc.join(", ")}`,
  );
  const staleIpc = [...declaredChannels].filter((channel) => !registeredChannels.has(channel));
  assert.strictEqual(staleIpc.length, 0, `Matrix rows for channels that are no longer registered: ${staleIpc.join(", ")}`);
  for (const listenerChannel of ipcEventListeners) {
    assert(declaredChannels.has(listenerChannel), `ipcMain.on channel ${listenerChannel} has no matrix row.`);
  }

  const serverSource = fs.readFileSync(path.join(rootDir, "agent", "src", "server.js"), "utf8");
  const serverSegments = new Set();
  for (const match of serverSource.matchAll(/\/api\/v1\/([a-z0-9_-]+)/g)) serverSegments.add(match[1]);
  const coveredSegments = new Set();
  for (const family of matrix.REST_FAMILIES) {
    for (const route of family.routes) {
      const match = route.path.match(/^\/api\/v1\/([a-z0-9_-]+)/);
      assert(match, `REST family ${family.id} route ${route.path} is not an /api/v1 route.`);
      coveredSegments.add(match[1]);
    }
  }
  const uncoveredRest = [...serverSegments].filter((segment) => !coveredSegments.has(segment));
  assert.strictEqual(uncoveredRest.length, 0, `Uncovered Agent REST route families (add matrix rows): ${uncoveredRest.join(", ")}`);
  const staleRest = [...coveredSegments].filter((segment) => !serverSegments.has(segment));
  assert.strictEqual(staleRest.length, 0, `Matrix REST families no longer dispatched by the agent: ${staleRest.join(", ")}`);
}

async function main() {
  crossCheckTableAgainstRealFunctions();
  await runDesktopMatrixPhase();
  await runAgentRestPhase();
  runCoverageEnforcement();
  const ipcChannelCount = matrix.IPC_FAMILIES.flatMap((family) => family.channels).length;
  console.log(`Permission matrix smoke passed: ${matrix.IPC_FAMILIES.length} desktop families (${ipcChannelCount} channels), ${matrix.REST_FAMILIES.length} Agent REST families.`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
