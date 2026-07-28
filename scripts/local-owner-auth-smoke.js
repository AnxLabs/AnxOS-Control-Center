const assert = require("assert");
const bcrypt = require("bcryptjs");
const fs = require("fs");
const os = require("os");
const path = require("path");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-local-owner-auth-"));
const activeConfig = path.join(root, "active", "config");
const legacyConfig = path.join(root, "legacy", "config");
const legacyPath = path.join(legacyConfig, "security.json");
process.env.ANXHUB_CONFIG_DIR = activeConfig;
process.env.ANXOS_FORCE_PRODUCTION = "1";

const password = "1245";
const passwordHash = bcrypt.hashSync(password, 12);
fs.mkdirSync(legacyConfig, { recursive: true });
fs.writeFileSync(legacyPath, `${JSON.stringify({ users: [{ id: "existing-owner", username: "Anx", role: "Owner", passwordHash }], persistentSessions: [] }, null, 2)}\n`);

async function main() {
  const servicePath = require.resolve("../src/services/securityService");
  let security = require(servicePath);
  const migrated = security._test.migrateLegacyOwnerUsers(security._test.normalizeSecurityState(), [legacyPath]);
  assert.strictEqual(migrated.users[0].username, "Anx", "Legacy Owner should migrate to the active local store.");
  assert.strictEqual(migrated.users[0].passwordHash, passwordHash, "Migration must preserve the existing password hash exactly.");
  assert(fs.existsSync(legacyPath), "Migration must not delete or modify the legacy owner store.");

  const signedIn = await security.login({ username: "Anx", password, staySignedIn: true });
  assert.strictEqual(signedIn.ownerAuthorized, true, "Successful Local Owner sign-in must authorize the Owner.");
  assert.strictEqual(signedIn.localOwnerAuthenticated, true, "Successful Local Owner sign-in must establish local authentication.");
  assert.strictEqual(signedIn.localCredentialContextAvailable, true, "Credential context must be available before login resolves.");
  assert.strictEqual(signedIn.authState, "unlocked", "Successful Local Owner sign-in must finish in the unlocked state.");
  let status = security.getStatus();
  assert.strictEqual(status.localOwnerAuthenticated, true, "Authoritative security status must report the Local Owner as authenticated.");
  assert.strictEqual(status.localCredentialContextAvailable, true, "Authoritative security status must report the credential context as available.");

  const recovery = require("../src/services/authRecoveryState");
  recovery.enterLockedRecoverable(Object.assign(new Error("simulated account-session recovery race"), {
    code: "SECURE_SESSION_DECRYPT_FAILED",
  }), { source: "account-session" });
  status = security.getStatus();
  assert.strictEqual(status.localOwnerAuthenticated, true, "An account-session recovery update must not reset an active Local Owner session.");
  assert.strictEqual(status.localCredentialContextAvailable, true, "The local credential context must survive unrelated account recovery state.");

  const appSource = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  assert(appSource.includes("refreshProtectedStateAfterLocalOwnerAuthentication"), "Renderer must use one canonical protected-state refresh coordinator.");
  assert(appSource.includes("authResult.localOwnerAuthenticated !== true"), "Renderer must reject an early sign-in success without local authentication.");
  assert(appSource.includes("authResult.localCredentialContextAvailable !== true"), "Renderer must reject an early sign-in success without credential context.");
  assert.strictEqual((appSource.match(/refreshProtectedStateAfterLocalOwnerAuthentication\(authResult\)/g) || []).length, 1, "Local Owner form submission must invoke the protected refresh coordinator exactly once.");

  security.logoutAllSessions();
  status = security.getStatus();
  assert.strictEqual(status.localOwnerAuthenticated, false, "Signing out all local sessions must clear local authentication.");
  assert.strictEqual(status.localCredentialContextAvailable, false, "Signing out all local sessions must clear the credential context.");
  const afterLogout = JSON.parse(fs.readFileSync(path.join(activeConfig, "security.json"), "utf8"));
  assert.strictEqual(afterLogout.users.length, 1, "Log out all sessions must preserve local Owner accounts.");
  assert.strictEqual(afterLogout.users[0].passwordHash, passwordHash, "Log out all sessions must preserve password hashes.");

  delete process.env.ANXOS_FORCE_PRODUCTION;
  process.env.NODE_ENV = "development";
  process.env.ANXOS_TRUSTED_DEVELOPMENT_MODE = "1";
  delete require.cache[servicePath];
  security = require(servicePath);
  const messages = [];
  const originalInfo = console.info;
  console.info = (...args) => messages.push(args);
  try {
    await assert.rejects(security.login({ username: "Anx", password: "incorrect password" }), /Invalid username or password/);
  } finally {
    console.info = originalInfo;
  }
  const diagnostic = messages.find(([label, details]) => label === "[Security][LocalOwner]" && details?.event === "authentication-failed")?.[1];
  assert.strictEqual(diagnostic?.ownerExists, true, "Diagnostics should report that the Owner exists.");
  assert.strictEqual(diagnostic?.username, "Anx", "Diagnostics should report the matched username.");
  assert.strictEqual(diagnostic?.authenticationProvider, "local-owner", "Diagnostics should identify the local provider.");
  assert.strictEqual(diagnostic?.failureReason, "HASH_MISMATCH", "Diagnostics should classify a password mismatch.");
  assert.strictEqual(diagnostic?.hashFormat, "bcrypt", "Diagnostics should classify the hash format without logging it.");
  assert(!JSON.stringify(messages).includes(passwordHash), "Diagnostics must not contain password hashes.");
  assert(!JSON.stringify(messages).includes("incorrect password"), "Diagnostics must not contain passwords.");
  const failedStatus = security.getStatus();
  assert.strictEqual(failedStatus.localOwnerAuthenticated, false, "Incorrect credentials must not authenticate the Local Owner.");
  assert.strictEqual(failedStatus.localCredentialContextAvailable, false, "Incorrect credentials must not establish credential context.");
  console.log("Local Owner authentication smoke checks passed.");
}

main().finally(() => fs.rmSync(root, { recursive: true, force: true })).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
