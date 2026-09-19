const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-settings-permissions-"));
process.env.ANXHUB_CONFIG_DIR = path.join(root, "config");
process.env.ANXOS_FORCE_PRODUCTION = "1";

const security = require("../src/services/securityService");
const {
  assertCanResetSettingsCategory,
  assertCanWriteSettingsPayload,
  getSettingsPermissions,
  requireSettingsCapability,
} = require("../src/services/settingsPermissionService");

function assertForbidden(operation, message) {
  assert.throws(operation, (error) => error?.code === "FORBIDDEN", message);
}

async function main() {
  let permissions = getSettingsPermissions();
  assert.strictEqual(permissions.owner, false, "Setup/local mode must not be treated as Owner Settings access.");
  assert.strictEqual(permissions.capabilities.canManageDeveloperSettings, false, "Developer settings must not be enabled before Owner sign-in.");

  assert.doesNotThrow(
    () => assertCanWriteSettingsPayload({ "appearance.theme": "dark" }, "public-preferences"),
    "Public user preferences should not require Owner access.",
  );
  assertForbidden(
    () => assertCanWriteSettingsPayload({ "developer.debugMode": true }, "developer-preferences"),
    "Developer settings writes must require Owner access.",
  );
  assert.doesNotThrow(
    () => assertCanResetSettingsCategory("general"),
    "Resetting public General settings should not require Owner access.",
  );
  assertForbidden(
    () => assertCanResetSettingsCategory("developer"),
    "Resetting Developer settings must require Owner access.",
  );
  assertForbidden(
    () => requireSettingsCapability("canManageMarketplaceSettings", "marketplace-config"),
    "Marketplace administration must return FORBIDDEN without Owner access.",
  );

  await security.setupAdmin({ username: "owner", password: "StrongOwnerPass123!", passwordConfirm: "StrongOwnerPass123!" });
  await security.login({ username: "owner", password: "StrongOwnerPass123!" });

  permissions = getSettingsPermissions();
  assert.strictEqual(permissions.owner, true, "Owner sign-in must enable Owner Settings access.");
  assert.strictEqual(permissions.capabilities.canManageMarketplaceSettings, true, "Owner should manage Marketplace settings.");
  assert.strictEqual(permissions.capabilities.canManageDeveloperSettings, true, "Owner should manage Developer settings.");
  assert.doesNotThrow(
    () => assertCanWriteSettingsPayload({ "developer.debugMode": true }, "developer-preferences"),
    "Owner should be able to write Developer settings.",
  );
  assert.doesNotThrow(
    () => requireSettingsCapability("canManageMarketplaceSettings", "marketplace-config"),
    "Owner should be able to access Marketplace administration.",
  );

  security.logout();
  permissions = getSettingsPermissions();
  assert.strictEqual(permissions.owner, false, "Sign-out must remove Owner Settings access.");
  assertForbidden(
    () => requireSettingsCapability("canManageDeveloperSettings", "developer-updates"),
    "Developer controls must become forbidden after sign-out.",
  );

  console.log("Settings permission runtime smoke checks passed.");
}

(async () => {
  try {
    await main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
})();
