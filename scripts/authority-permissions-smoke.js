#!/usr/bin/env node
// V2-A Wave 1 authority/permissions regression smoke.
// Covers: fail-closed remote agent default, local Owner wildcard compat,
// per-principal grant schema (Decision 2), Owner-only wildcard passthrough,
// User→operator legacy mapping (Decision 3), operator can act / viewer
// read-only / unknown role denied.
const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const repoRoot = path.join(__dirname, "..");

// Per-run temp data root for the spawned Agents. These roots must never be the
// repo root: the agent-layer instance service re-roots the shared job store to
// <instanceRoot>/jobs when it loads, so a repo-rooted AGENT_INSTANCE_ROOT leaks
// `<repo>/instances/jobs` into the working tree on every gate run (the rc
// residue tripwire caught exactly this).
const agentDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-authority-roots-"));
process.on("exit", () => {
  try { fs.rmSync(agentDataRoot, { recursive: true, force: true }); } catch {}
});

const PERMISSIONS_PATH = path.join(repoRoot, "agent", "src", "permissions.js");
const HEALTH_PATH = path.join(repoRoot, "agent", "src", "routes", "health.js");
const SECURITY_PATH = path.join(repoRoot, "src", "services", "securityService.js");

const ENV_KEYS = ["ANXHUB_CONFIG_DIR", "AGENT_PERMISSION_PROFILE", "AGENT_API_PERMISSIONS", "AGENT_ACTION_PERMISSIONS", "AGENT_ALLOWED_PERMISSIONS", "ANX_AGENT_ACTION_PERMISSIONS"];

function applyEnv(overrides) {
  const saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
  }
  for (const key of Object.keys(overrides)) {
    if (overrides[key] === null) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  return saved;
}

function restoreEnv(saved) {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

// The permission module reads env lazily, so callers must applyEnv() around
// every assertion and restoreEnv() afterwards.
function loadPermissionsModule() {
  delete require.cache[require.resolve(PERMISSIONS_PATH)];
  return require(PERMISSIONS_PATH);
}

function loadSecurityService() {
  const configRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-authority-config-"));
  process.env.ANXHUB_CONFIG_DIR = path.join(configRoot, "config");
  fs.rmSync(configRoot, { recursive: true, force: true });
  delete require.cache[require.resolve(SECURITY_PATH)];
  return require(SECURITY_PATH);
}

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
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      if ((await fetch(`${url}/api/v1/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Agent did not become ready.");
}

function spawnAgent(env, port, token) {
  const agentConfigPath = path.join(os.tmpdir(), `anxos-authority-agent-${port}.json`);
  // The shared-token store prefers an EXISTING config file over the env hint,
  // so pre-seed the isolated config; otherwise a stray stored agent.json in
  // the repo would silently override the token this smoke controls.
  fs.writeFileSync(agentConfigPath, JSON.stringify({ backendMode: "agent", agentToken: token }));
  const agentEnv = {
    ...process.env,
    AGENT_HOST: "127.0.0.1",
    AGENT_PORT: String(port),
    AGENT_TOKEN: token,
    ANXHUB_AGENT_CONFIG_PATH: agentConfigPath,
    AGENT_INSTANCE_ROOT: path.join(agentDataRoot, "instances"),
    AGENT_BACKUP_ROOT: path.join(agentDataRoot, "backups"),
    ...env,
  };
  // A null override means "must be absent"; child env values are stringified,
  // so explicitly delete these instead of leaking the literal "null".
  for (const key of Object.keys(agentEnv)) {
    if (agentEnv[key] === null || agentEnv[key] === undefined) {
      delete agentEnv[key];
    }
  }
  return spawn(process.execPath, [path.join(repoRoot, "agent", "src", "server.js")], {
    cwd: path.join(repoRoot, "agent"),
    env: agentEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function testAgentPermissionDefaults() {
  let saved = applyEnv({ ANXHUB_CONFIG_DIR: path.join("C:", "some", "config"), AGENT_PERMISSION_PROFILE: null, AGENT_API_PERMISSIONS: null });
  try {
    const local = loadPermissionsModule();
    assert.deepStrictEqual([...local.getConfiguredApiPermissions()].sort(), ["*"], "Local desktop-managed profile must keep the Owner wildcard (Decision 4).");
    assert.strictEqual(local.resolvePermissionProfile(), "local-owner");
  } finally {
    restoreEnv(saved);
  }

  saved = applyEnv({ ANXHUB_CONFIG_DIR: null, AGENT_PERMISSION_PROFILE: null, AGENT_API_PERMISSIONS: null });
  try {
    const restricted = loadPermissionsModule();
    assert.strictEqual(restricted.getConfiguredApiPermissions().size, 0, "Standalone/remote agent must default fail-closed with no implicit '*' (Decision 4).");
    assert.strictEqual(restricted.resolvePermissionProfile(), "restricted");
    assert.strictEqual(restricted.getDefaultApiPermissions().length, 0);
  } finally {
    restoreEnv(saved);
  }

  saved = applyEnv({ ANXHUB_CONFIG_DIR: null, AGENT_PERMISSION_PROFILE: "local-owner", AGENT_API_PERMISSIONS: null });
  try {
    const pinned = loadPermissionsModule();
    assert.deepStrictEqual([...pinned.getConfiguredApiPermissions()].sort(), ["*"], "Explicit AGENT_PERMISSION_PROFILE=local-owner must force the local wildcard.");
  } finally {
    restoreEnv(saved);
  }

  saved = applyEnv({ ANXHUB_CONFIG_DIR: null, AGENT_PERMISSION_PROFILE: null, AGENT_API_PERMISSIONS: "system:read files:read" });
  try {
    const narrowed = loadPermissionsModule();
    assert.strictEqual(narrowed.getConfiguredApiPermissions().has("system:read"), true);
    assert.strictEqual(narrowed.getConfiguredApiPermissions().has("*"), false, "Explicit AGENT_API_PERMISSIONS must always win over any default.");
  } finally {
    restoreEnv(saved);
  }

  saved = applyEnv({ ANXHUB_CONFIG_DIR: "x", AGENT_PERMISSION_PROFILE: "bogus", AGENT_API_PERMISSIONS: null });
  try {
    const unknownProfile = loadPermissionsModule();
    assert.strictEqual(unknownProfile.resolvePermissionProfile(), "restricted", "Unknown explicit profile must fail closed.");
  } finally {
    restoreEnv(saved);
  }
}

async function testGrantSchema() {
  const saved = applyEnv({
    ANXHUB_CONFIG_DIR: null,
    AGENT_PERMISSION_PROFILE: null,
    AGENT_API_PERMISSIONS: null,
    AGENT_PERMISSION_GRANTS: JSON.stringify([
      { principal: "svc-backup", role: "service", permissions: ["backups:write"] },
      { principal: "svc-bad", role: "field-marshal", permissions: ["*"] },
      { principal: "not-an-object" },
      { principal: "svc-empty", permissions: [] },
      { principal: "wildcard-user", permissions: ["*"] },
      { principal: "mini-owner", role: "owner", permissions: ["*"] },
    ]),
  });
  try {
    const mod = loadPermissionsModule();

    const { grants, errors } = mod.getPermissionGrants();
    assert.strictEqual(grants.length, 3, "Invalid grants must be dropped, not widened.");
    assert.strictEqual(errors.length, 3, "Invalid grants must be reported as errors.");
    assert.strictEqual(grants[0].role, "service");
    assert.ok(Array.isArray(grants[0].targets), "Grant schema must carry a targets field for V2-I scoping.");
    assert.ok("nodeId" in grants[0], "Grant schema must carry a nodeId field for V2-I scoping.");

    assert.strictEqual(mod.authorizeApiPermission("backups:write", { principal: "svc-backup" }).ok, true, "Service identity explicit grant must authorize.");
    assert.strictEqual(mod.authorizeApiPermission("files:write", { principal: "svc-backup" }).ok, false, "Service identity grant must not authorize outside its permissions.");

    assert.strictEqual(mod.authorizeApiPermission("files:write", { principal: "wildcard-user" }).ok, false, "Non-owner principal must not gain '*' from a grant (fail-closed).");
    assert.strictEqual(mod.authorizeApiPermission("files:write", { principal: "mini-owner" }).ok, true, "Owner-role grant may carry '*' (local Owner wildcard path).");

    const shared = mod.authorizeApiPermission("files:write", { principal: "shared-token" });
    assert.strictEqual(shared.ok, false, "Shared-token principal without grants stays fail-closed in a restricted profile.");
  } finally {
    restoreEnv(saved);
  }
}

async function testHealthModeTruthful() {
  const health = require(HEALTH_PATH);
  const empty = new Set();
  const readOnly = new Set(["system:read"]);
  const write = new Set(["*"]);
  assert.strictEqual(health._test.computeHealthMode(empty), "no-access", "Empty permission set must report no-access.");
  assert.strictEqual(health._test.computeHealthMode(readOnly), "read-only");
  assert.strictEqual(health._test.computeHealthMode(write), "read-write");
}

async function waitForAgentExit(agent) {
  await new Promise((resolve) => {
    if (agent.exitCode !== null || !agent.pid) return resolve();
    agent.once("exit", resolve);
    agent.kill();
    setTimeout(() => {
      try { agent.kill("SIGKILL"); } catch {}
      resolve();
    }, 2000);
  });
}

async function testLiveAgentProfiles() {
  const token = "authority-permissions-smoke-token";

  // Restricted standalone agent (no ANXHUB_CONFIG_DIR): fail-closed.
  let port = await getFreePort();
  let agent = spawnAgent({ ANXHUB_CONFIG_DIR: null, AGENT_PERMISSION_PROFILE: null, AGENT_API_PERMISSIONS: null }, port, token);
  try {
    const url = `http://127.0.0.1:${port}`;
    await waitForAgent(url);
    const health = await (await fetch(`${url}/api/v1/health`)).json();
    assert.strictEqual(health.mode, "no-access", "Restricted agent health must truthfully report no-access.");
    assert.strictEqual((await fetch(`${url}/api/v1/stats`)).status, 401, "Non-public APIs must still require the token.");
    const stats = await fetch(`${url}/api/v1/stats`, { headers: { Authorization: `Bearer ${token}` } });
    assert.strictEqual(stats.status, 403, "Restricted agent must deny capability routes with no grants.");
    assert.strictEqual((await stats.json()).error.code, "API_PERMISSION_DENIED");
  } finally {
    await waitForAgentExit(agent);
  }

  // Local desktop-managed profile: wildcard preserved (current installs).
  port = await getFreePort();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-authority-local-"));
  agent = spawnAgent({ ANXHUB_CONFIG_DIR: configDir, AGENT_PERMISSION_PROFILE: null, AGENT_API_PERMISSIONS: null }, port, token);
  try {
    const url = `http://127.0.0.1:${port}`;
    await waitForAgent(url);
    const health = await (await fetch(`${url}/api/v1/health`)).json();
    assert.strictEqual(health.mode, "read-write", "Local Owner profile must keep the wildcard and read-write mode.");
    assert.strictEqual((await fetch(`${url}/api/v1/stats`, { headers: { Authorization: `Bearer ${token}` } })).status, 200, "Local wildcard must keep current installs working.");
  } finally {
    await waitForAgentExit(agent);
    fs.rmSync(configDir, { recursive: true, force: true });
  }
}

async function testDesktopRoles() {
  const security = loadSecurityService();
  const owner = { role: "Owner" };
  const admin = { role: "Admin" };
  const operator = { role: "Operator" };
  const viewer = { role: "Viewer" };
  const service = { role: "Service" };
  const unknown = { role: "Root" };
  const legacyUser = { role: "User" };

  // Owner wildcard passthrough stays exclusive (Decision 4 / securityService fix).
  assert.strictEqual(security.userHasPermission(owner, "anything:at:all"), true, "Owner wildcard passthrough must remain.");
  assert.strictEqual(security.userHasPermission(admin, "instance:delete"), true);
  assert.strictEqual(security.userHasPermission(admin, "settings:write"), true);

  // Operator can act (lifecycle), but not delete/config-write.
  assert.strictEqual(security.userHasPermission(operator, "instance:lifecycle"), true, "Operator must keep lifecycle capability.");
  assert.strictEqual(security.userHasPermission(operator, "instance:read"), true);
  assert.strictEqual(security.userHasPermission(operator, "instance:delete"), false, "Operator must not delete.");
  assert.strictEqual(security.userHasPermission(operator, "settings:write"), false, "Operator must not change security settings.");
  assert.strictEqual(security.userHasPermission(operator, "marketplace:install"), false, "Operator must not install.");

  // Viewer is strictly read-only.
  assert.strictEqual(security.userHasPermission(viewer, "instance:read"), true);
  assert.strictEqual(security.userHasPermission(viewer, "backups:read"), true);
  assert.strictEqual(security.userHasPermission(viewer, "instance:lifecycle"), false, "Viewer must be read-only.");
  assert.strictEqual(security.userHasPermission(viewer, "instance:write"), false, "Viewer must be read-only.");
  assert.strictEqual(security.userHasPermission(viewer, "backups:restore"), false, "Viewer must be read-only.");

  // Service identity grants nothing implicitly.
  assert.strictEqual(security.userHasPermission(service, "instance:read"), false, "Service identity is fail-closed without explicit grants.");

  // Unknown role denied.
  assert.strictEqual(security.userHasPermission(unknown, "instance:read"), false, "Unknown role must deny.");
  assert.strictEqual(security.userHasPermission(null, "instance:read"), false, "Missing principal must deny.");

  // Legacy User → operator mapping (Decision 3): identical capability profile.
  assert.deepStrictEqual(security.getRolePermissions("User").sort(), security.getRolePermissions("Operator").sort(), "Legacy User must map to operator profile (Decision 3).");
  assert.strictEqual(security.userHasPermission(legacyUser, "instance:lifecycle"), true, "Legacy User keeps lifecycle capability.");
  assert.strictEqual(security.normalizeRole("user"), "Operator");
  assert.strictEqual(security.normalizeRole("operator"), "Operator");
  assert.strictEqual(security.normalizeRole("viewer"), "Viewer");
  assert.strictEqual(security.normalizeRole("Owner"), "Owner");
  assert.throws(() => security.normalizeRole("Root"), /Invalid role/, "Unknown role must be rejected.");

  // Canonical role list excludes the legacy alias.
  assert.deepStrictEqual(security.CANONICAL_ROLES, ["Owner", "Admin", "Operator", "Viewer", "Service"]);
  assert.ok(!security.CANONICAL_ROLES.includes("User"), "Legacy alias must not be offered for new role assignment.");
}

async function main() {
  await testAgentPermissionDefaults();
  await testGrantSchema();
  await testHealthModeTruthful();
  await testLiveAgentProfiles();
  await testDesktopRoles();
  console.log("authority-permissions-smoke: all assertions passed.");
}

main().then(() => {
  // Exit explicitly: lingering fetch keep-alive sockets can otherwise trip a
  // libuv assertion on Windows during teardown.
  process.exit(0);
}).catch((error) => {
  console.error("authority-permissions-smoke: FAILED");
  console.error(error);
  process.exit(1);
});
