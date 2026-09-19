// V2-I Wave 1: standing permission-matrix definition.
//
// This module is the single source of truth for the CURRENT permission model
// (docs/MASTER_ROADMAP.md V2-I gate): an explicit actor x resource x action
// table covering the desktop IPC families and the local Agent REST families.
// scripts/permission-matrix-smoke.js asserts live behavior against this table
// and fails when a new IPC channel or Agent REST route family appears without
// a row here.
//
// Expectations are derived from the real decision functions, not hand-guessed:
// - Desktop tiers come from the guards each src/ipc module actually calls
//   (requirePermission / requireLocalOwnerAuthenticated / requireOwner /
//   settingsPermissionService.requireSettingsCapability), and role outcomes
//   are cross-checked at runtime against securityService.ROLE_PERMISSIONS and
//   securityService.userHasPermission (the pure decision core).
// - Agent REST tiers mirror agent/src/server.js getRoutePermission; the smoke
//   probes the real spawned Agent so any tier drift fails the harness.
// - Denial codes are the codes the real guards throw (LOGIN_REQUIRED,
//   LOCAL_AUTHENTICATION_REQUIRED, PERMISSION_DENIED, OWNER_REQUIRED,
//   FORBIDDEN, UNAUTHORIZED, API_PERMISSION_DENIED, NODE_BINDING_MISMATCH).
//
// Future V2-I waves extend ONE table here instead of inventing ad-hoc tests.

const DESKTOP_ACTORS = Object.freeze({
  "owner-unlocked": "Local Owner with an unlocked authenticated session (role Owner, '*').",
  "operator-unlocked": "Provisioned Operator-role session (cross-user: lifecycle-capable, no delete/write tiers).",
  "viewer-unlocked": "Provisioned Viewer-role session (cross-user: read-only).",
  "owner-locked": "Local Owner desktop after sign-out / lock: no runtime session.",
  guest: "Unauthenticated renderer with an Owner already provisioned on this device.",
});

const REST_ACTORS = Object.freeze({
  "agent-full-profile": "Local-owner-profile Agent (ANXHUB_CONFIG_DIR spawn contract, default AGENT_API_PERMISSIONS = ['*']).",
  "agent-restricted-profile": "Explicit AGENT_PERMISSION_PROFILE=restricted Agent with no configured grants (fail-closed).",
  "unauthenticated-remote": "Remote request with no bearer/X-Agent-Token credential.",
});

// Desktop IPC guard chains, in the exact order the real handlers run them.
// "permission" = requirePermission(tier); "local-owner+permission" = require
// Local Owner authentication then requirePermission; "local-owner+owner" =
// agentControlIpc's authorize(); "owner" = bare requireOwner;
// "settings-capability" = requireSettingsCapability (OWNER_REQUIRED converts
// to FORBIDDEN, audited inside requireOwner); "settings-secret" =
// assertCanReadSettingsSecret (requireLocalOwnerAuthenticated then
// requireSettingsCapability); "security-service" = guard lives inside the
// securityService operation the channel invokes; "none" = no permission guard
// at this layer (public/bootstrap channels).
const GUARDS = Object.freeze({
  permission: {
    lockedCode: "LOGIN_REQUIRED",
    lockedAudit: false,
    roleDeniedCode: "PERMISSION_DENIED",
    roleDeniedAudit: true,
  },
  "local-owner+permission": {
    // requireLocalCredentialsUnlocked throws LOCAL_AUTHENTICATION_REQUIRED
    // whenever the local-credentials gate is not unlocked (locked desktop).
    lockedCode: "LOCAL_AUTHENTICATION_REQUIRED",
    lockedAudit: false,
    roleDeniedCode: "PERMISSION_DENIED",
    roleDeniedAudit: true,
  },
  "local-owner+owner": {
    lockedCode: "LOCAL_AUTHENTICATION_REQUIRED",
    lockedAudit: false,
    roleDeniedCode: "OWNER_REQUIRED",
    roleDeniedAudit: true,
  },
  owner: {
    lockedCode: "OWNER_REQUIRED",
    lockedAudit: true,
    roleDeniedCode: "OWNER_REQUIRED",
    roleDeniedAudit: true,
  },
  "settings-capability": {
    lockedCode: "FORBIDDEN",
    lockedAudit: true,
    roleDeniedCode: "FORBIDDEN",
    roleDeniedAudit: true,
  },
  "settings-secret": {
    lockedCode: "LOCAL_AUTHENTICATION_REQUIRED",
    lockedAudit: false,
    roleDeniedCode: "FORBIDDEN",
    roleDeniedAudit: true,
  },
  "security-service": {
    lockedCode: "LOGIN_REQUIRED",
    lockedAudit: false,
    roleDeniedCode: "PERMISSION_DENIED",
    roleDeniedAudit: true,
  },
  none: { lockedCode: null, lockedAudit: false, roleDeniedCode: null, roleDeniedAudit: false },
});

// ---------------------------------------------------------------------------
// Desktop IPC families. `tier` is the permission token the family's guards
// require; `guard` is the guard chain (see GUARDS); `allow` lists the desktop
// actors whose ROLE grants the tier (locked/guest outcomes derive from the
// guard, not from the role). `probes` names representative channels the smoke
// actually invokes per tier; every registered channel must belong to a family
// (coverage enforcement), but only probes are executed.
// ---------------------------------------------------------------------------
const IPC_FAMILIES = [
  {
    // Main.js window/app management channels: these operate on the caller's
    // own window or read app metadata — no node/instance/credential surface.
    // Sender-scoped (BrowserWindow.fromWebContents), so cross-window access
    // is structurally impossible; they are pinned explicitly so the coverage
    // enforcement can see them (review P1-1). probeExempt: the channels are
    // registered in main.js, outside this smoke's stub transports — the
    // Electron runtime itself exercises them (window controls).
    id: "window-management",
    tier: null,
    guard: "none",
    probeExempt: true,
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked", "owner-locked", "guest"],
    channels: [
      "window:minimize", "window:maximize", "window:restore", "window:close",
      "window:isMaximized", "window:openWorkspace", "window:focusMain",
      "window:getWorkspaceContext", "app:getRuntimeInfo",
    ],
  },
  {
    id: "account",
    tier: null,
    guard: "none",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked", "owner-locked", "guest"],
    channels: [
      "account:getStatus", "account:restore", "account:startDeviceLogin", "account:loginWithPassword",
      "account:checkDeviceLogin", "account:cancelDeviceLogin", "account:refresh", "account:openPage",
      "account:listDevices", "account:revokeCurrentDevice", "account:logout",
    ],
  },
  {
    id: "security-public",
    tier: null,
    guard: "none",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked", "owner-locked", "guest"],
    channels: ["security:getStatus", "security:login", "security:setupAdmin", "security:logout"],
  },
  {
    id: "security-session",
    tier: "settings:write",
    guard: "security-service",
    allow: ["owner-unlocked"],
    channels: [
      "security:getDashboard", "security:logoutAllSessions", "security:revokeSession",
      "security:revokeOtherSessions", "security:removeTrustedDevice", "security:renameTrustedDevice",
      "security:updateSessionSettings", "security:updateRemoteAccess", "security:disableRemoteAccess",
      "security:rotateAgentToken", "security:revokeAgentToken", "security:generateReplacementAgentToken",
      "security:emergencyAction", "security:openAuditFolder",
      // V2-I audit retention / access review / export (V2-I exposure wave). Each
      // securityService function gates itself with
      // requirePermission("settings:write", "audit-log") — the same
      // security-service guard chain as security:openAuditFolder, so they stay in
      // this family; the IPC layer adds no second gate.
      "security:getAuditRetentionReport", "security:getAuditAccessReview", "security:exportAuditWindow",
    ],
  },
  {
    id: "security-owner",
    tier: "owner",
    // lockOwnerWorkspace guards via requireOwner inside securityService
    // (OWNER_REQUIRED for every non-owner actor).
    guard: "owner",
    allow: ["owner-unlocked"],
    channels: ["security:lockOwnerWorkspace"],
  },
  {
    id: "owner-workspace",
    tier: "owner",
    guard: "owner",
    allow: ["owner-unlocked"],
    channels: [
      "ownerWorkspace:getWorkspace", "ownerWorkspace:createPage", "ownerWorkspace:updatePage",
      "ownerWorkspace:duplicatePage", "ownerWorkspace:deletePage", "ownerWorkspace:reorderPages",
      "ownerWorkspace:selectPage", "ownerWorkspace:saveContent", "ownerWorkspace:getAnalytics",
      "ownerWorkspace:setFlag", "ownerWorkspace:runApiRequest", "ownerWorkspace:clearApiHistory",
      "ownerWorkspace:runCommand", "ownerWorkspace:readLogs",
    ],
  },
  {
    id: "owner-workspace-public",
    tier: null,
    guard: "none",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked", "owner-locked", "guest"],
    channels: ["ownerWorkspace:getStatus", "ownerWorkspace:getFlags", "ownerWorkspace:getCommands"],
  },
  {
    id: "agent-control",
    tier: "owner",
    guard: "local-owner+owner",
    allow: ["owner-unlocked"],
    channels: [
      "agentControl:list", "agentControl:status", "agentControl:diagnostics", "agentControl:createUiBootstrapCode",
      "agentControl:remoteDiagnostics", "agentControl:getConfig", "agentControl:saveConfig",
      "agentControl:restoreConfig", "agentControl:resetConfig", "agentControl:start", "agentControl:stop",
      "agentControl:restart", "agentControl:forceRestart", "agentControl:installLocalAgent",
      "agentControl:stopOldLocalAgentAndRepair", "agentControl:pairLocalAgent",
      "agentControl:startPairingSession", "agentControl:updateLocalAgent", "agentControl:installService",
      "agentControl:uninstallService", "agentControl:enableAutoStart", "agentControl:disableAutoStart",
      "agentControl:openLogs", "agentControl:openDataFolder",
    ],
  },
  {
    id: "action-bridge",
    // action:execute derives its tier per action id from actionIpc's
    // ACTION_PERMISSIONS map. docker.start is lifecycle-tier (Operator keeps
    // lifecycle); backup.restore is restore-tier and pinned separately below
    // (Operator lacks backups:restore).
    tier: null,
    guard: "permission",
    actionTiers: { "docker.start": "instance:lifecycle" },
    allow: ["owner-unlocked", "operator-unlocked"],
    channels: ["action:execute"],
  },
  {
    id: "action-bridge-restore",
    // Second representative action for action:execute: the destructive
    // restore tier, which the Operator role does not grant.
    tier: "backups:restore",
    guard: "permission",
    actionTiers: { "backup.restore": "backups:restore" },
    allow: ["owner-unlocked"],
    channels: ["action:execute"],
  },
  {
    id: "docker-read",
    tier: "docker:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: [
      "docker:getSnapshot", "docker:listContainers", "docker:inspectContainer", "docker:listImages",
      "docker:inspectImage", "docker:listNetworks", "docker:listVolumes", "docker:inspectVolume",
      "docker:inspectNetwork", "docker:listComposeProjects", "docker:getLogs", "docker:getStats",
      "docker:getCleanupPreview", "docker:preflightContainer",
    ],
  },
  {
    id: "docker-compose-read",
    tier: "docker:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: ["docker:compose"],
  },
  {
    id: "docker-lifecycle",
    tier: "instance:lifecycle",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked"],
    channels: ["docker:start", "docker:stop", "docker:restart", "docker:pause", "docker:unpause", "docker:kill"],
  },
  {
    id: "docker-write",
    tier: "instance:write",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: [
      "docker:create", "docker:pullImage", "docker:rename", "docker:exec",
      "docker:createNetwork", "docker:connectNetwork", "docker:disconnectNetwork",
    ],
  },
  {
    id: "docker-delete",
    tier: "instance:delete",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: [
      "docker:removeImage", "docker:pruneImages", "docker:delete", "docker:removeContainer",
      "docker:removeVolume", "docker:pruneVolumes", "docker:removeNetwork", "docker:pruneNetworks",
      "docker:cleanup",
    ],
  },
  {
    id: "instances-read",
    tier: "instance:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: [
      "instances:list", "instances:getStatus", "instances:getMetrics", "instances:getLogs",
      "instances:listFiles", "instances:readFile", "instances:listRestartSchedules",
      "instances:getMinecraftProperties", "instances:getGameServerConfig", "instances:getFiveMReadiness",
      "instances:jobs:list", "instances:jobs:get",
    ],
  },
  {
    id: "instances-write",
    tier: "instance:write",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: [
      "instances:create", "instances:update", "instances:rename", "instances:duplicate",
      "instances:sendCommand", "instances:createRestartSchedule", "instances:updateRestartSchedule",
      "instances:evaluateRestartSchedules",
    ],
  },
  {
    id: "instances-lifecycle",
    tier: "instance:lifecycle",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked"],
    channels: ["instances:start", "instances:stop", "instances:restart", "instances:forceKill", "instances:repairNeoForgeRuntime", "instances:jobs:cancel"],
  },
  {
    id: "instances-delete",
    tier: "instance:delete",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: ["instances:delete", "instances:forget", "instances:deleteRestartSchedule"],
  },
  {
    id: "instance-files",
    tier: "files:write",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: [
      "instances:clearLogs", "instances:writeFile", "instances:deleteFile", "instances:createFolder",
      "instances:renameFile", "instances:saveGameServerConfig", "instances:saveMinecraftProperties",
      "instances:saveFiveMLicenseKey",
    ],
  },
  {
    // V2-I hardening: openFolder previously only audited at the IPC layer;
    // it now requires instance:read ( Guests/Viewers must not pop host
    // Explorer windows). Guest has no instance:read (role model), so the
    // guest cell is a denial.
    id: "instances-open-folder",
    tier: "instance:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: ["instances:openFolder"],
  },
  {
    id: "backups-read",
    tier: "backups:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: ["backups:list", "backups:listSchedules", "backups:listDestinations"],
  },
  {
    id: "backups-write",
    tier: "backups:write",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: [
      "backups:create", "backups:delete", "backups:saveSchedule", "backups:deleteSchedule",
      // download/import guard via backups:write inside their local helpers.
      "backups:download", "backups:import",
      // V2-F wave 5 destinations: editing a destination or pushing a copy
      // mutates agent-owned backup state, so it stays in the write tier.
      "backups:saveDestination", "backups:deleteDestination", "backups:pushDestination",
    ],
  },
  {
    id: "backups-restore",
    tier: "backups:restore",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: ["backups:restore", "backups:restoreFromDestination"],
  },
  {
    id: "dependencies-read",
    tier: "dependencies:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: ["dependencies:getCatalog", "dependencies:check", "dependencies:plan"],
  },
  {
    id: "dependencies-install",
    tier: "instance:write",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: ["dependencies:install"],
  },
  {
    id: "diagnostics-log",
    tier: "system:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: ["diagnostics:log"],
  },
  {
    id: "diagnostics-manage",
    tier: "settings:write",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: ["diagnostics:capture", "diagnostics:read", "diagnostics:openFolder", "diagnostics:copySummary", "diagnostics:export"],
  },
  {
    id: "files-read",
    tier: "files:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: [
      "files:list", "files:identity", "files:listConnections", "files:disconnect",
      "files:readText", "files:download",
    ],
  },
  {
    id: "files-write",
    tier: "files:write",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: [
      "files:upload", "files:writeText", "files:delete", "files:mkdir",
      "files:newFile", "files:rename", "files:copy", "files:cancelTransfer",
    ],
  },
  {
    id: "files-connections",
    tier: "settings:write",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: ["files:saveConnection", "files:deleteConnection", "files:setDefaultConnection", "files:testConnection"],
  },
  {
    id: "marketplace-read",
    tier: "marketplace:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: [
      "marketplace:listTemplates", "marketplace:getMinecraftVersions", "marketplace:searchProviderPacks",
      "marketplace:getProviderPackVersions", "marketplace:getProviderPackDetails", "marketplace:getInstallPlan",
      "marketplace:getImportSupport", "marketplace:getDownloads",
      // V2-D catalog transfer (V2-I exposure wave): export serializes the catalog
      // this tier already lists, and import is a non-mutating validation/preview
      // (importCatalog never writes the catalog) — both are read tier, exactly
      // like marketplace:getInstallPlan above.
      "marketplace:exportCatalog", "marketplace:importCatalog",
    ],
  },
  {
    id: "marketplace-install",
    tier: "marketplace:install",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: [
      "marketplace:importCommunityTemplate", "marketplace:installTemplate", "marketplace:installPack",
      "marketplace:updateSteamServer", "marketplace:openManualDownloadPage", "marketplace:importManualDownloadFile",
      "marketplace:resumeManualInstall", "marketplace:cancelDownload", "marketplace:retryDownload",
    ],
  },
  {
    id: "nodes-read",
    // nodes:list / nodes:restore skip the local-credentials gate
    // (requirePermission with localCredentials: false) but keep the tier.
    tier: "nodes:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: ["nodes:list", "nodes:restore"],
  },
  {
    id: "nodes-credential-read",
    tier: "nodes:read",
    guard: "local-owner+permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: ["nodes:select", "nodes:test", "nodes:health", "nodes:healthAll", "nodes:fleetSummary", "nodes:credentialStatus"],
  },
  {
    id: "nodes-write",
    tier: "settings:write",
    guard: "local-owner+permission",
    allow: ["owner-unlocked"],
    channels: [
      "nodes:save", "nodes:delete", "nodes:disconnect", "nodes:reconnect", "nodes:pair",
      "nodes:repairCredential", "nodes:generateToken", "nodes:fleetBatch", "nodes:testConnection",
    ],
  },
  {
    // V2-H network inventory: node-scoped read-only host discovery
    // (interfaces, ports, listeners, conflicts), same guard chain as the
    // other node-credential reads.
    id: "network-inventory",
    tier: "nodes:read",
    guard: "local-owner+permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: ["networkInventory:get"],
  },
  {
    id: "settings-read",
    tier: "settings:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: ["settings:getPreferences"],
  },
  {
    id: "settings-permissions-read",
    tier: null,
    guard: "none",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked", "owner-locked", "guest"],
    channels: ["settings:getPermissions"],
  },
  {
    id: "settings-preferences",
    tier: "settings:preferences:write",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked"],
    channels: ["settings:savePreferences", "settings:resetPreferences"],
  },
  {
    id: "settings-agent-config",
    tier: "canManageAgentConfiguration",
    guard: "settings-secret",
    allow: ["owner-unlocked"],
    channels: ["settings:getAgentConfig", "settings:saveAgentConfig", "settings:testAgentConnection", "settings:pairAgent"],
  },
  {
    id: "settings-marketplace-config",
    tier: "canManageMarketplaceSettings",
    guard: "settings-secret",
    allow: ["owner-unlocked"],
    channels: ["settings:getMarketplaceConfig", "settings:saveMarketplaceConfig", "settings:testCurseForgeConnection"],
  },
  {
    id: "ssh-read",
    tier: "ssh:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: ["ssh:listProfiles", "ssh:getSession"],
  },
  {
    id: "ssh-write",
    tier: "instance:write",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: ["ssh:connect", "ssh:disconnect", "ssh:write", "ssh:resize", "ssh:approveHostKey"],
  },
  {
    id: "ssh-manage",
    tier: "settings:write",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: ["ssh:saveProfile", "ssh:deleteProfile", "ssh:assignProfileToNode"],
  },
  {
    id: "system-read",
    tier: "system:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: ["system:getSnapshot"],
  },
  {
    id: "public-access-read",
    tier: "public-access:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: [
      "publicAccess:getSnapshot", "publicAccess:listServices", "publicAccess:getPlayitStatus",
      "publicAccess:getPlayitLogs", "publicAccess:listPlayitTunnels",
      "publicAccess:previewFirewallRule", "publicAccess:listFirewallRules",
      // V2-H reverse-proxy/certificate state read (Agent-owned; no mutation).
      "publicAccess:getReverseProxy",
    ],
  },
  {
    id: "public-access-write",
    tier: "instance:write",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: ["publicAccess:createService", "publicAccess:deleteService", "publicAccess:createFirewallRule", "publicAccess:applyFirewallRule", "publicAccess:deleteFirewallRule", "publicAccess:controlPlayit",
      // V2-H reverse-proxy route apply: records a route definition only. The
      // Agent reports applied:false (no proxy configuration is written), so the
      // write tier matches the other public-access mutations.
      "publicAccess:applyReverseProxyRoute"],
  },
  {
    id: "amp-read",
    tier: "instance:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: ["amp:getSnapshot"],
  },
  {
    id: "playit-read",
    tier: "public-access:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: ["playit:getSnapshot"],
  },
  {
    id: "maintenance",
    tier: "settings:write",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: ["maintenance:scan", "maintenance:clear"],
  },
  {
    id: "updates-read",
    tier: "system:read",
    guard: "permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: ["updates:getState", "updates:check", "updates:open-release"],
  },
  {
    id: "updates-manage",
    tier: "settings:write",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: ["updates:download", "updates:open-downloaded", "updates:install", "updates:open-download", "updates:skip"],
  },
  {
    id: "developer-updates",
    tier: "canManageDeveloperSettings",
    guard: "settings-capability",
    allow: ["owner-unlocked"],
    channels: ["developerUpdates:getState", "developerUpdates:check", "developerUpdates:update", "developerUpdates:restart", "developerUpdates:openChanges"],
  },
  {
    id: "storage-window-open",
    tier: "settings:write",
    guard: "permission",
    allow: ["owner-unlocked"],
    channels: ["storageWindow:open"],
  },
  {
    id: "storage-window-internal",
    tier: null,
    guard: "none",
    // Verified current model: close/saved only validate the sender window
    // identity, not the actor role (window-internal channels).
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked", "owner-locked", "guest"],
    channels: ["storageWindow:close", "storageWindow:saved"],
  },
  {
    // V2-J Wave 1 alerts: read the reconciled active-alert set at the
    // node-read tier (alerts are derived from per-node data the same actors can
    // already read), acknowledge at the settings-write tier (it mutates the
    // persisted alert record). Both are local-owner gated like their
    // node-scoped neighbours.
    id: "alerts-read",
    tier: "nodes:read",
    guard: "local-owner+permission",
    allow: ["owner-unlocked", "operator-unlocked", "viewer-unlocked"],
    channels: ["alerts:list"],
  },
  {
    id: "alerts-write",
    tier: "settings:write",
    guard: "local-owner+permission",
    allow: ["owner-unlocked"],
    channels: ["alerts:acknowledge"],
  },
  {
    id: "workload-transfer",
    tier: "settings:write",
    guard: "local-owner+permission",
    allow: ["owner-unlocked"],
    channels: ["workload:transfer", "workload:transferPreview"],
  },
];

// ---------------------------------------------------------------------------
// Agent REST families. Tiers mirror agent/src/server.js getRoutePermission
// (verified V2-I survey); the smoke pins them end to end against a spawned
// Agent, so tier drift in either direction fails.
// public: true = reachable before bearer auth by design.
// ---------------------------------------------------------------------------
// Security P1: the pairing handshake is pre-auth (so it stays a publicRoute)
// but now authorizes internally for an already-enrolled node. These constants
// are the contract the smoke cross-checks against the real pairing handler.
const PAIRING_STATUS_PATH = "/api/v1/pairing/status";
const PAIRING_INTERNAL_AUTHORIZATION = "pairing-existing-credential";
const PAIRING_REQUIRES_EXISTING_CREDENTIAL = "PAIRING_REQUIRES_EXISTING_CREDENTIAL";

const REST_FAMILIES = [
  { id: "rest-health", tier: null, publicRoute: true, routes: [{ method: "GET", path: "/api/v1/health" }] },
  {
    id: "rest-system-read",
    tier: "system:read",
    publicRoute: false,
    routes: [{ method: "GET", path: "/api/v1/stats" }, { method: "GET", path: "/api/v1/system/summary" }],
  },
  {
    id: "rest-network-inventory",
    tier: "system:read",
    publicRoute: false,
    routes: [{ method: "GET", path: "/api/v1/network/inventory" }],
  },
  { id: "rest-files-read", tier: "files:read", publicRoute: false, routes: [{ method: "GET", path: "/api/v1/files/identity" }] },
  {
    id: "rest-files-write",
    tier: "files:write",
    publicRoute: false,
    // Unrouted files POST: still permission-gated (files:write) but 405s
    // before any handler runs, so the allow probe stays side-effect free.
    routes: [{ method: "POST", path: "/api/v1/files/matrix-probe" }],
  },
  { id: "rest-console-read", tier: "console:read", publicRoute: false, routes: [{ method: "GET", path: "/api/v1/console/commands" }] },
  { id: "rest-console-write", tier: "console:write", publicRoute: false, routes: [{ method: "POST", path: "/api/v1/console/matrix-probe" }] },
  {
    id: "rest-backups-read",
    tier: "backups:read",
    publicRoute: false,
    routes: [{ method: "GET", path: "/api/v1/backups/list" }],
  },
  { id: "rest-backups-write", tier: "backups:write", publicRoute: false, routes: [{ method: "POST", path: "/api/v1/backups/matrix-probe" }] },
  { id: "rest-backups-restore", tier: "backups:restore", publicRoute: false, routes: [{ method: "POST", path: "/api/v1/backups/matrix-probe/restore" }] },
  { id: "rest-jobs-read", tier: "instance:read", publicRoute: false, routes: [{ method: "GET", path: "/api/v1/jobs" }] },
  { id: "rest-jobs-cancel", tier: "instance:lifecycle", publicRoute: false, routes: [{ method: "POST", path: "/api/v1/jobs/matrix-probe/cancel" }] },
  { id: "rest-instances-read", tier: "instance:read", publicRoute: false, routes: [{ method: "GET", path: "/api/v1/instances" }] },
  { id: "rest-instances-write", tier: "instance:write", publicRoute: false, routes: [{ method: "POST", path: "/api/v1/instances/matrix-probe" }] },
  { id: "rest-instances-lifecycle", tier: "instance:lifecycle", publicRoute: false, routes: [{ method: "POST", path: "/api/v1/instances/matrix-probe/start" }] },
  { id: "rest-instances-delete", tier: "instance:delete", publicRoute: false, routes: [{ method: "DELETE", path: "/api/v1/instances/matrix-probe" }] },
  { id: "rest-docker-read", tier: "docker:read", publicRoute: false, routes: [{ method: "GET", path: "/api/v1/docker" }] },
  { id: "rest-docker-write", tier: "docker:write", publicRoute: false, routes: [{ method: "POST", path: "/api/v1/docker/matrix-probe" }] },
  { id: "rest-dependencies-read", tier: "dependencies:read", publicRoute: false, routes: [{ method: "GET", path: "/api/v1/dependencies/catalog" }] },
  { id: "rest-dependencies-write", tier: "dependencies:write", publicRoute: false, routes: [{ method: "POST", path: "/api/v1/dependencies/matrix-probe/install" }] },
  { id: "rest-marketplace-read", tier: "marketplace:read", publicRoute: false, routes: [{ method: "GET", path: "/api/v1/marketplace/curseforge/status" }] },
  { id: "rest-public-access-read", tier: "public-access:read", publicRoute: false, routes: [{ method: "GET", path: "/api/v1/playit/status" }] },
  { id: "rest-public-access-write", tier: "public-access:write", publicRoute: false, routes: [{ method: "POST", path: "/api/v1/public-access/matrix-probe" }] },
  {
    // V2-H reverse-proxy/certificate lifecycle: the read path returns the
    // recorded routes, certificate lifecycle states, and the explicit
    // activation/issuance "unsupported in this build" blocks.
    id: "rest-public-access-reverse-proxy-read",
    tier: "public-access:read",
    publicRoute: false,
    routes: [{ method: "GET", path: "/api/v1/public-access/reverse-proxy" }],
  },
  {
    // Write tier for the apply endpoint. The probe body is intentionally empty
    // so route validation refuses it (REVERSE_PROXY_HOSTNAME_REQUIRED) before
    // anything is persisted — the tier is exercised with no side effect.
    id: "rest-public-access-reverse-proxy-write",
    tier: "public-access:write",
    publicRoute: false,
    routes: [{ method: "POST", path: "/api/v1/public-access/reverse-proxy/routes", body: {} }],
  },
  { id: "rest-amp-read", tier: "instance:read", publicRoute: false, routes: [{ method: "GET", path: "/api/v1/amp/status" }] },
  { id: "rest-diagnostics", tier: "owner", publicRoute: false, routes: [{ method: "GET", path: "/api/v1/diagnostics" }] },
  { id: "rest-agent-task", tier: "agent:manage", publicRoute: false, routes: [{ method: "GET", path: "/api/v1/system/agent-task" }] },
  { id: "rest-actions-read", tier: "actions:read", publicRoute: false, routes: [{ method: "GET", path: "/api/v1/actions" }] },
  {
    id: "rest-actions-execute",
    tier: "actions:execute",
    publicRoute: false,
    // Unknown action id: the execute tier is still enforced by
    // getRoutePermission before the handler 404s on ACTION_NOT_FOUND.
    routes: [{ method: "POST", path: "/api/v1/actions/matrix-probe.action", body: {} }],
  },
  {
    id: "rest-enroll-public",
    tier: null,
    publicRoute: true,
    routes: [{ method: "GET", path: "/api/v1/enroll/status" }],
  },
  {
    id: "rest-pairing",
    // Legacy pairing handshake: still reachable pre-auth (the route is
    // dispatched before isAuthorized and the tier is null), but as of the
    // Security P1 change it authorizes INTERNALLY for an already-enrolled node:
    // a non-loopback caller must prove possession of a trusted credential or it
    // is refused with PAIRING_REQUIRES_EXISTING_CREDENTIAL (403). A node with no
    // enrollment record (or a non-enrolled record) stays open — bootstrap and
    // recovery. The internalAuthorization marker is cross-checked against the
    // real pairing handler in scripts/permission-matrix-smoke.js.
    tier: null,
    publicRoute: true,
    internalAuthorization: PAIRING_INTERNAL_AUTHORIZATION,
    routes: [{ method: "GET", path: PAIRING_STATUS_PATH }],
  },
  {
    id: "rest-ui-session",
    tier: "ui:session",
    publicRoute: false,
    routes: [
      { method: "GET", path: "/api/v1/ui/session" },
      { method: "POST", path: "/api/v1/ui/session", body: {} },
    ],
  },
  {
    id: "rest-ui-public",
    tier: null,
    publicRoute: true,
    routes: [{ method: "GET", path: "/api/v1/ui" }],
  },
  // Enrollment management routes run LAST in the smoke: a successful
  // credentials/rotate probe rewrites the agent credential, so it must not
  // invalidate earlier full-profile probes.
  { id: "rest-enroll-revoke", tier: "owner", publicRoute: false, routes: [{ method: "POST", path: "/api/v1/enroll/revoke", body: {} }] },
  { id: "rest-credentials-rotate", tier: "agent:manage", publicRoute: false, routes: [{ method: "POST", path: "/api/v1/credentials/rotate", body: {} }] },
];

// Expected REST outcome per (actor, family). Derived from the real decision
// chain: isAuthorized (auth.js) then authorizeApiPermission (permissions.js)
// with the profile defaults from agent/src/permissions.js.
function expectedRestOutcome(family, actor) {
  if (actor === "unauthenticated-remote") {
    return family.publicRoute
      ? { allow: true, code: null }
      : { allow: false, code: "UNAUTHORIZED" };
  }
  if (actor === "agent-restricted-profile") {
    return family.tier === null
      ? { allow: true, code: null }
      : { allow: false, code: "API_PERMISSION_DENIED" };
  }
  // agent-full-profile: local-owner profile defaults to ["*"].
  return { allow: true, code: null };
}

// Expected desktop outcome per (actor, family). Role cells (operator/viewer)
// are cross-checked at runtime against the real securityService role tables;
// locked/guest outcomes come from the guard chain the family actually uses.
function expectedDesktopOutcome(family, actor) {
  const guard = GUARDS[family.guard] || GUARDS.none;
  if (actor === "owner-locked" || actor === "guest") {
    if (family.guard === "none") return { allow: true, code: null, audit: false };
    return { allow: false, code: guard.lockedCode, audit: guard.lockedAudit };
  }
  if (family.allow.includes(actor)) return { allow: true, code: null, audit: false };
  return { allow: false, code: guard.roleDeniedCode, audit: guard.roleDeniedAudit };
}

module.exports = {
  DESKTOP_ACTORS,
  REST_ACTORS,
  IPC_FAMILIES,
  REST_FAMILIES,
  PAIRING_STATUS_PATH,
  PAIRING_INTERNAL_AUTHORIZATION,
  PAIRING_REQUIRES_EXISTING_CREDENTIAL,
  expectedDesktopOutcome,
  expectedRestOutcome,
};
