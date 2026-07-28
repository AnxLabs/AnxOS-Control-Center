#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const recovery = require("../src/services/authRecoveryState");
const { createIpcError } = require("../src/shared/ipcError");
const { sanitize } = require("../src/shared/redaction");

const root = path.resolve(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "app.js"), "utf8");
const nodeServiceSource = fs.readFileSync(path.join(root, "src", "services", "nodeService.js"), "utf8");
const nodeIpcSource = fs.readFileSync(path.join(root, "src", "ipc", "nodesIpc.js"), "utf8");
const agentControlIpcSource = fs.readFileSync(path.join(root, "src", "ipc", "agentControlIpc.js"), "utf8");
const securitySource = fs.readFileSync(path.join(root, "src", "services", "securityService.js"), "utf8");
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-node-credential-recovery-"));
process.env.ANXHUB_CONFIG_DIR = path.join(temporaryRoot, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });
const credentialStore = require("../src/services/nodeCredentialStore");

recovery.enterLocked({ setupRequired: false });
recovery.enterLocalCredentialsLocked({ reason: "node_credentials_unavailable" });
const locked = recovery.getState();
assert.strictEqual(locked.state, "local_credentials_locked");
assert.strictEqual(locked.authenticated, false);
assert.strictEqual(locked.reason, "node_credentials_unavailable");
assert.match(locked.message, /Saved node credentials could not be restored/);
assert.throws(
  () => recovery.requireLocalCredentialsUnlocked("nodes:save", "Unlock AnxOS to manage nodes."),
  (error) => error?.code === "LOCAL_AUTHENTICATION_REQUIRED" && !error.message.includes("NODE_CREDENTIAL_DECRYPT_FAILED"),
);

const lockedCredentialError = createIpcError(
  Object.assign(new Error("Unlock AnxOS to access saved node credentials."), {
    code: "LOCAL_AUTHENTICATION_REQUIRED",
  }),
);
assert.strictEqual(lockedCredentialError.code, "LOCAL_AUTHENTICATION_REQUIRED");
assert(!lockedCredentialError.message.includes("NODE_CREDENTIAL_MISSING"), "Locked local authentication must not be misclassified as a missing node credential.");

const wrapped = createIpcError(
  Object.assign(new Error("Saved node credentials could not be decrypted on this device."), {
    code: "NODE_CREDENTIAL_DECRYPT_FAILED",
  }),
);
assert.strictEqual(wrapped.message, "Saved node credentials could not be restored. Unlock AnxOS to continue.");
assert(!wrapped.message.includes("NODE_CREDENTIAL_DECRYPT_FAILED"));

const diagnostic = sanitize({
  message: "NODE_CREDENTIAL_DECRYPT_FAILED: Saved node credentials could not be decrypted on this device.",
  errorCode: "NODE_CREDENTIAL_DECRYPT_FAILED",
  encrypted: "opaque-encrypted-credential",
});
const diagnosticText = JSON.stringify(diagnostic);
assert(!diagnosticText.includes("NODE_CREDENTIAL_DECRYPT_FAILED"));
assert(!diagnosticText.includes("opaque-encrypted-credential"));
assert(diagnosticText.includes("Saved node credentials could not be restored"));

const credentialPath = credentialStore.getNodeCredentialsPath();
const unreadableCredential = `${JSON.stringify({
  schemaVersion: credentialStore.NODE_CREDENTIAL_SCHEMA_VERSION,
  encrypted: {
    method: "aes-256-gcm",
    iv: Buffer.alloc(12).toString("base64"),
    tag: Buffer.alloc(16).toString("base64"),
    data: Buffer.from("unreadable-node-credential").toString("base64"),
  },
}, null, 2)}\n`;
fs.writeFileSync(credentialPath, unreadableCredential, { mode: 0o600 });
assert.throws(
  () => credentialStore.getNodeToken("preserved-node"),
  (error) => error?.code === "NODE_CREDENTIAL_DECRYPT_FAILED",
);
assert.strictEqual(fs.readFileSync(credentialPath, "utf8"), unreadableCredential, "Unreadable encrypted node credentials must remain byte-for-byte intact.");

fs.writeFileSync(path.join(process.env.ANXHUB_CONFIG_DIR, "security.json"), `${JSON.stringify({
  users: [{ id: "owner-1", username: "Anx", role: "Owner", passwordHash: "test-only-hash" }],
  persistentSessions: [],
}, null, 2)}\n`);
fs.writeFileSync(path.join(process.env.ANXHUB_CONFIG_DIR, "nodes.json"), `${JSON.stringify({
  schemaVersion: 3,
  selectedNodeId: "preserved-node",
  nodes: [{
    id: "preserved-node",
    kind: "agent",
    displayName: "Preserved Node",
    agentUrl: "http://127.0.0.1:47131",
    agentIdentity: { deviceId: "preserved-device" },
  }],
}, null, 2)}\n`);
const lockedNodeService = require("../src/services/nodeService");
assert.throws(
  () => lockedNodeService.getNodeAgentConfig("preserved-node"),
  (error) => error?.code === "LOCAL_AUTHENTICATION_REQUIRED",
  "Encrypted credential state plus a locked Local Owner session must be classified as local authentication required.",
);
assert.strictEqual(fs.readFileSync(credentialPath, "utf8"), unreadableCredential, "Locked credential classification must not rewrite encrypted credentials.");

const recovered = credentialStore.replaceUnreadableStore({
  "existing-node": { agentToken: "existing-configured-token" },
});
assert.strictEqual(recovered.recovered, true, "An unreadable store should be recoverable from an existing credential source.");
assert.strictEqual(recovered.recoveredNodeCount, 1, "Recovery should report the number of existing credentials migrated.");
assert.strictEqual(credentialStore.getNodeToken("existing-node"), "existing-configured-token", "Recovered credentials should be readable from the canonical store.");
assert(
  fs.readdirSync(process.env.ANXHUB_CONFIG_DIR).some((name) => name.startsWith("node-agent-credentials.json.undecryptable-") && name.endsWith(".backup")),
  "Credential recovery must preserve the unreadable ciphertext before replacing the canonical store.",
);

assert(securitySource.includes("localOwnerAuthenticated"), "Security status must expose local Owner authentication separately.");
assert(securitySource.includes("enterLocalCredentialsLocked"), "Authorized account identity must enter a local-credentials-locked state.");
assert(nodeServiceSource.includes("if (!localCredentialsUnlocked())") && nodeServiceSource.includes("credentialsLocked: true"), "Locked node listing must avoid decrypt and remain visible.");
assert(nodeServiceSource.includes("preserveDecryptionError: true"), "Authenticated credential-backed operations must preserve decrypt-failure classification.");
assert(nodeServiceSource.includes("Unlock AnxOS to access saved node credentials."), "Credential-backed node operations must distinguish local lock from a genuinely missing credential.");
assert(nodeServiceSource.includes("nodeCredentialRecovery?.degraded") && nodeServiceSource.includes("credentialRecovery: nodeCredentialRecovery"), "Unreadable encrypted node credentials must degrade only credential-backed node paths.");
assert(nodeServiceSource.includes("requireNodeCredentialWrite(\"node-config-write\""), "Node configuration writes must require local credential authentication.");
assert(nodeIpcSource.includes("requireLocalOwnerAuthenticated(\"nodes:save\""), "Node saves must require local Owner authentication.");
assert(nodeIpcSource.includes("requireLocalOwnerAuthenticated(\"nodes:test-connection\""), "Node connection tests must require local Owner authentication.");
assert(agentControlIpcSource.includes("requireLocalOwnerAuthenticated("), "Local Agent actions must require local Owner authentication.");
assert(appSource.includes("Unlock AnxOS to start the Application Host."), "Application Host must show explicit unlock guidance.");
assert(appSource.includes("securityState?.localOwnerAuthenticated !== true") && appSource.includes("loadMarketplaceSettings"), "Marketplace settings must remain degraded without requesting protected credentials.");
assert(appSource.includes("refreshProtectedStateAfterLocalOwnerAuthentication") && appSource.includes("refreshNodes({ forceHealthRefresh: true })") && appSource.includes("loadMarketplaceSettings()"), "Successful unlock must retry protected state through the deduplicated coordinator.");
assert(appSource.includes("Saved node credentials could not be restored. Unlock AnxOS to continue."), "Renderer errors and Operations history must use friendly credential recovery text.");

recovery.enterUnlocking();
recovery.enterUnlocked({ provider: "local-owner" });
assert.strictEqual(recovery.getState().authenticated, true);
assert.doesNotThrow(() => recovery.requireLocalCredentialsUnlocked("nodes:save"));

fs.rmSync(temporaryRoot, { recursive: true, force: true });
console.log("Node credential recovery smoke checks passed.");
