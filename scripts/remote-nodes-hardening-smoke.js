#!/usr/bin/env node
// Remote-node hardening regressions (one numbered check per finding).
//
//  1. remote-nodes-1: a freshly paired Agent is enrolled at once, so a second
//     network caller cannot re-pair it (or enroll over it) before a restart.
//  2. remote-nodes-2: node-credential recovery never gives This PC's Local
//     Agent token to a remote node, and a store that only failed because the
//     OS keyring is temporarily unavailable is never overwritten.
//  3. remote-nodes-3: a changed SSH host key can be reviewed and replaced
//     (with an explicit confirmation), after which unattended SSH accepts it.
//  4. remote-nodes-4: after "Remove computer" revokes the enrollment, a
//     network caller cannot take the Agent over; the operator on the Agent
//     machine can still recover it.
//
// Hermetic: every config root is a temp folder, requests are synthetic
// objects with a fake remoteAddress, SSH uses a fake client, and nothing
// contacts the network or a real Agent.
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anx-remote-nodes-hardening-"));
process.on("exit", () => {
  try { fs.rmSync(smokeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
});
process.env.ANXOS_LOG_DIR = path.join(smokeRoot, "logs");
process.env.ANXHUB_ENV_PATH = path.join(smokeRoot, "no-such.env");
process.env.AGENT_INSTANCE_ROOT = path.join(smokeRoot, "instances");
delete process.env.AGENT_URL;
delete process.env.AGENT_TOKEN;

function useConfigDir(name) {
  const configDir = path.join(smokeRoot, name, "config");
  fs.mkdirSync(configDir, { recursive: true });
  process.env.ANXHUB_CONFIG_DIR = configDir;
  process.env.AGENT_ENROLLMENT_PATH = path.join(configDir, "enrollment.json");
  process.env.AGENT_IDENTITY_PATH = path.join(configDir, "device-identity.json");
  return configDir;
}

useConfigDir("bootstrap");
const jobLifecycle = require("../src/shared/instances/jobLifecycle");
jobLifecycle.configureJobLifecycle({ getRoot: () => path.join(process.env.AGENT_INSTANCE_ROOT, "jobs") });

const pairingRoute = require("../agent/src/routes/pairing");
const { handlePublicEnrollment } = require("../agent/src/routes/enroll");
const enrollmentService = require("../agent/src/services/enrollmentService");
const { generateAgentToken, tokenFingerprint } = require("../src/shared/agentTokenStore");

const OWNER_REMOTE = "198.51.100.20"; // TEST-NET-2
const ATTACKER = "203.0.113.66"; // TEST-NET-3
const urlFor = (pathname) => new URL(pathname, "http://127.0.0.1:47131");
const requestFor = (method, pathname, remoteAddress, { headers = {}, body } = {}) => ({
  method,
  url: pathname,
  socket: { remoteAddress },
  headers: { host: "198.51.100.5:47131", ...headers },
  body: body === undefined ? "" : JSON.stringify(body),
});

function agentConfig(configDir, token, extra = {}) {
  const configPath = path.join(configDir, "agent.json");
  fs.writeFileSync(configPath, `${JSON.stringify({ backendMode: "agent", agentUrl: "http://127.0.0.1:47131", agentToken: token, ...(extra.tokenOrigin ? { tokenOrigin: extra.tokenOrigin } : {}) }, null, 2)}\n`, { mode: 0o600 });
  return {
    token,
    instanceRoot: process.env.AGENT_INSTANCE_ROOT,
    ...(extra.tokenOrigin ? { tokenOrigin: extra.tokenOrigin } : {}),
    tokenStatus: {
      configured: true,
      source: "shared-config",
      configPath,
      fingerprint: tokenFingerprint(token),
      ...(extra.tokenOrigin ? { tokenOrigin: extra.tokenOrigin } : {}),
    },
  };
}

async function pairing(method, pathname, remoteAddress, config, options) {
  return pairingRoute.handlePairing(requestFor(method, pathname, remoteAddress, options), urlFor(pathname), config);
}

async function expectCode(invoke, code, label) {
  let caught = null;
  try {
    await invoke();
  } catch (error) {
    caught = error;
  }
  assert(caught, `${label}: expected a refusal with ${code}, but the request succeeded.`);
  assert.strictEqual(caught.code, code, `${label}: expected ${code}, got ${caught.code || caught.message}.`);
  assert.strictEqual(caught.statusCode, 403, `${label}: the refusal must be a 403.`);
}

const checks = [];
function check(id, label, run) { checks.push({ id, label, run }); }

// ---------------------------------------------------------------------------
check("remote-nodes-1", "a freshly paired Agent cannot be re-paired by a network caller", async () => {
  const configDir = useConfigDir("check-1");
  pairingRoute._test.reset();
  const generated = generateAgentToken();
  const config = agentConfig(configDir, generated, { tokenOrigin: "generated" });
  const migration = enrollmentService.migrateLegacyBinding(config);
  assert.strictEqual(migration.migrated, false, "setup: a self-generated credential must not be auto-enrolled.");
  assert.strictEqual(enrollmentService.readEnrollmentRecord(), null, "setup: a fresh Agent has no enrollment record.");

  // The owner pairs: `anxos-agent pair` on the host, code pasted remotely.
  const start = await pairing("POST", "/api/v1/pairing/start", "127.0.0.1", config);
  const ownerToken = generateAgentToken();
  const paired = await pairing("POST", "/api/v1/pairing/complete", OWNER_REMOTE, config, { body: { pairingCode: start.body.pairingCode, permanentToken: ownerToken } });
  assert.strictEqual(paired.body.status, "paired", "the owner's first pairing must succeed.");
  const record = enrollmentService.readEnrollmentRecord();
  assert(record, "a completed pairing must write an enrollment record right away.");
  assert.strictEqual(record.state, "enrolled", "the paired Agent must be enrolled.");
  assert.strictEqual(record.tokenFingerprint, tokenFingerprint(ownerToken), "the record must be bound to the paired credential.");
  assert.doesNotThrow(() => enrollmentService.assertEnrollmentBinding(config), "the owner's credential must pass the enrollment binding.");

  // An unauthenticated network caller can no longer start, read, or redeem.
  await expectCode(() => pairing("POST", "/api/v1/pairing/start", ATTACKER, config), "PAIRING_REQUIRES_EXISTING_CREDENTIAL", "attacker pairing/start");
  await expectCode(() => pairing("GET", "/api/v1/pairing/status", ATTACKER, config), "PAIRING_REQUIRES_EXISTING_CREDENTIAL", "attacker pairing/status");
  const enrollStart = handlePublicEnrollment(requestFor("POST", "/api/v1/enroll/start", ATTACKER, { body: {} }), urlFor("/api/v1/enroll/start"), config);
  const attackerToken = generateAgentToken();
  await expectCode(
    () => handlePublicEnrollment(requestFor("POST", "/api/v1/enroll/complete", ATTACKER, { body: { enrollNonce: enrollStart.body.enrollNonce, agentToken: attackerToken } }), urlFor("/api/v1/enroll/complete"), config),
    "ENROLL_REPAIR_REQUIRES_EXISTING_CREDENTIAL",
    "attacker enroll/complete",
  );
  assert.strictEqual(config.token, ownerToken, "the owner's credential must still be the live one.");
  assert.strictEqual(JSON.parse(fs.readFileSync(config.tokenStatus.configPath, "utf8")).agentToken, ownerToken, "agent.json must still hold the owner's credential.");

  // Adjacent path: the owner's desktop can still re-pair remotely, because it
  // presents the credential it holds (nodeService.postPairingComplete).
  const repairStart = await pairing("POST", "/api/v1/pairing/start", OWNER_REMOTE, config, { body: { previousAgentToken: ownerToken } });
  const rotated = generateAgentToken();
  const repaired = await pairing("POST", "/api/v1/pairing/complete", OWNER_REMOTE, config, { body: { pairingCode: repairStart.body.pairingCode, permanentToken: rotated, previousAgentToken: ownerToken } });
  assert.strictEqual(repaired.body.status, "paired", "the owner's credentialed re-pair must still succeed.");
  assert.strictEqual(config.token, rotated, "the credentialed re-pair must rotate the credential.");
});

// ---------------------------------------------------------------------------
check("remote-nodes-4", "a revoked Agent cannot be taken over from the network", async () => {
  const configDir = useConfigDir("check-4");
  pairingRoute._test.reset();
  const live = generateAgentToken();
  const config = agentConfig(configDir, live);
  assert.strictEqual(enrollmentService.migrateLegacyBinding(config).migrated, true, "setup: the persisted credential must migrate into an enrolled record.");
  enrollmentService.revokeEnrollment(config, { confirmRevoke: true, reason: "removed-from-control-center" });
  assert.strictEqual(enrollmentService.readEnrollmentRecord().state, "revoked", "setup: Remove computer revokes the enrollment.");

  await expectCode(() => pairing("POST", "/api/v1/pairing/start", ATTACKER, config), "PAIRING_REQUIRES_EXISTING_CREDENTIAL", "attacker pairing/start after revoke");
  await expectCode(() => pairing("GET", "/api/v1/pairing/status", ATTACKER, config), "PAIRING_REQUIRES_EXISTING_CREDENTIAL", "attacker pairing/status after revoke");
  const enrollStart = handlePublicEnrollment(requestFor("POST", "/api/v1/enroll/start", ATTACKER, { body: {} }), urlFor("/api/v1/enroll/start"), config);
  await expectCode(
    () => handlePublicEnrollment(requestFor("POST", "/api/v1/enroll/complete", ATTACKER, { body: { enrollNonce: enrollStart.body.enrollNonce, agentToken: generateAgentToken() } }), urlFor("/api/v1/enroll/complete"), config),
    "ENROLL_REPAIR_REQUIRES_EXISTING_CREDENTIAL",
    "attacker enroll/complete after revoke",
  );
  assert.strictEqual(enrollmentService.readEnrollmentRecord().state, "revoked", "refused requests must leave the record revoked.");
  assert.strictEqual(config.token, live, "refused requests must leave the live credential alone.");

  // A pairing code redeemed without the operator opening the session is refused
  // even when the caller guesses nothing: there is no session to redeem.
  await assert.rejects(
    () => pairing("POST", "/api/v1/pairing/complete", ATTACKER, config, { body: { pairingCode: "ANX-AAAA-AAAA", permanentToken: generateAgentToken() } }),
    (error) => ["PAIRING_REQUIRES_EXISTING_CREDENTIAL", "PAIRING_REJECTED"].includes(error.code),
    "a complete without an operator session must be refused.",
  );
  assert.strictEqual(config.token, live, "a refused complete must leave the live credential alone.");

  // Recovery: the operator opens the session on the Agent machine and pastes
  // the code into Add Computer on a remote desktop that holds no credential.
  const start = await pairing("POST", "/api/v1/pairing/start", "127.0.0.1", config);
  const recoveredToken = generateAgentToken();
  const recovered = await pairing("POST", "/api/v1/pairing/complete", OWNER_REMOTE, config, { body: { pairingCode: start.body.pairingCode, permanentToken: recoveredToken } });
  assert.strictEqual(recovered.body.status, "paired", "the operator-opened recovery pairing must succeed.");
  assert.strictEqual(recovered.body.enrollment?.recoveredFromRevocation, true, "the recovery must report the revoked record as recovered.");
  const record = enrollmentService.readEnrollmentRecord();
  assert.strictEqual(record.state, "enrolled", "the recovered record must be enrolled.");
  assert.strictEqual(record.tokenFingerprint, tokenFingerprint(recoveredToken), "the recovered record must be bound to the operator's new credential.");

  // Loopback enrollment recovery after a revoke keeps working too.
  enrollmentService.revokeEnrollment(config, { confirmRevoke: true });
  const loopbackStart = handlePublicEnrollment(requestFor("POST", "/api/v1/enroll/start", "127.0.0.1", { body: {} }), urlFor("/api/v1/enroll/start"), config);
  const loopbackToken = generateAgentToken();
  const loopbackComplete = handlePublicEnrollment(requestFor("POST", "/api/v1/enroll/complete", "127.0.0.1", { body: { enrollNonce: loopbackStart.body.enrollNonce, agentToken: loopbackToken } }), urlFor("/api/v1/enroll/complete"), config);
  assert.strictEqual(loopbackComplete.body.status, "enrolled", "a loopback re-enrollment after revoke must still succeed.");
});

// ---------------------------------------------------------------------------
check("remote-nodes-2", "credential recovery never gives the Local Agent token to a remote node", async () => {
  const configDir = useConfigDir("check-2");
  const recovery = require("../src/services/authRecoveryState");
  const credentialStore = require("../src/services/nodeCredentialStore");
  const nodeService = require("../src/services/nodeService");
  const LOCAL_TOKEN = `local-agent-owner-${generateAgentToken()}`;
  fs.writeFileSync(path.join(configDir, "security.json"), `${JSON.stringify({ users: [{ id: "owner-1", username: "Owner", role: "Owner", passwordHash: "test-only-hash" }], persistentSessions: [] }, null, 2)}\n`);
  fs.writeFileSync(path.join(configDir, "agent.json"), `${JSON.stringify({ schemaVersion: 1, backendMode: "agent", agentUrl: "http://127.0.0.1:47131", agentToken: LOCAL_TOKEN }, null, 2)}\n`);
  const writeNodes = (selectedNodeId) => fs.writeFileSync(path.join(configDir, "nodes.json"), `${JSON.stringify({
    schemaVersion: 3,
    selectedNodeId,
    nodes: [
      { id: "local", kind: "agent", displayName: "This PC", agentUrl: "http://127.0.0.1:47131", localAgent: true, agentIdentity: { deviceId: "local-device" } },
      { id: "vps", kind: "agent", displayName: "VPS", agentUrl: "http://203.0.113.7:47131", agentIdentity: { deviceId: "vps-device" } },
      { id: "lab", kind: "agent", displayName: "Lab", agentUrl: "http://203.0.113.8:47131", agentIdentity: { deviceId: "lab-device" } },
    ],
  }, null, 2)}\n`);
  const credentialPath = credentialStore.getNodeCredentialsPath();
  const unreadable = (method) => `${JSON.stringify({
    schemaVersion: credentialStore.NODE_CREDENTIAL_SCHEMA_VERSION,
    encrypted: method === "safeStorage"
      ? { method: "safeStorage", data: Buffer.from("keyring-protected-node-credentials").toString("base64") }
      : { method: "aes-256-gcm", iv: Buffer.alloc(12).toString("base64"), tag: Buffer.alloc(16).toString("base64"), data: Buffer.from("unreadable-node-credential").toString("base64") },
  }, null, 2)}\n`;
  recovery.enterUnlocking();
  recovery.enterUnlocked({ provider: "local-owner" });

  // (a) Selected remote node, permanently undecryptable store.
  writeNodes("vps");
  fs.writeFileSync(credentialPath, unreadable("aes"), { mode: 0o600 });
  nodeService.getAllNodesSync();
  let vpsToken = "";
  try { vpsToken = credentialStore.getNodeToken("vps"); } catch {}
  assert.notStrictEqual(vpsToken, LOCAL_TOKEN, "the remote node must never receive This PC's Local Agent token.");
  let vpsConfig = null;
  try { vpsConfig = nodeService.getNodeAgentConfig("vps"); } catch {}
  assert.notStrictEqual(vpsConfig?.agentToken, LOCAL_TOKEN, "the remote node's Agent config must never carry the Local Agent token.");
  let labToken = "";
  try { labToken = credentialStore.getNodeToken("lab"); } catch {}
  assert.notStrictEqual(labToken, LOCAL_TOKEN, "no other remote node may receive the Local Agent token.");

  // (b) Selected local node still recovers from its own configured token.
  writeNodes("local");
  fs.writeFileSync(credentialPath, unreadable("aes"), { mode: 0o600 });
  nodeService.getAllNodesSync();
  assert.strictEqual(credentialStore.getNodeToken("local"), LOCAL_TOKEN, "This PC's Local Agent must still recover from its configured token.");
  assert.strictEqual(credentialStore.getNodeToken("vps"), "", "a remote node must not inherit any recovered token.");

  // (c) A store that failed only because the keyring is unavailable right now
  // must stay byte-for-byte intact (it decrypts again once the keyring is back).
  writeNodes("local");
  const keyringStore = unreadable("safeStorage");
  fs.writeFileSync(credentialPath, keyringStore, { mode: 0o600 });
  assert.doesNotThrow(() => nodeService.getAllNodesSync(), "a temporarily unavailable keyring must not break node listing.");
  assert.strictEqual(fs.readFileSync(credentialPath, "utf8"), keyringStore, "a temporarily undecryptable store must not be overwritten.");
  writeNodes("vps");
  assert.doesNotThrow(() => nodeService.getAllNodesSync(), "a temporarily unavailable keyring must not break listing with a remote selection.");
  assert.strictEqual(fs.readFileSync(credentialPath, "utf8"), keyringStore, "a temporarily undecryptable store must not be overwritten for a remote selection either.");
});

// ---------------------------------------------------------------------------
check("remote-nodes-3", "a changed SSH host key can be confirmed and replaced", async () => {
  useConfigDir("check-3");
  const { SshService } = require("../src/services/sshService");
  const KEY_A = Buffer.from("fixture-host-key-A");
  const KEY_B = Buffer.from("fixture-host-key-B");
  class HostKeyClient extends EventEmitter {
    constructor(key) { super(); this.key = key; }
    connect(config) {
      const accepted = config.hostVerifier(this.key);
      queueMicrotask(() => (accepted ? this.emit("ready") : this.emit("error", Object.assign(new Error("Host key verification failed"), { code: "HOST_VERIFICATION_FAILED" }))));
    }
    shell(options, callback) {
      const stream = new EventEmitter();
      stream.writable = true;
      stream.write = () => {};
      stream.end = () => {};
      queueMicrotask(() => callback(null, stream));
    }
    end() {}
    destroy() {}
  }
  let currentKey = KEY_A;
  const service = new SshService({ createClient: () => new HostKeyClient(currentKey), connectTimeoutMs: 2000 });
  const profile = { id: "vps-profile", nodeId: "vps", displayName: "VPS", host: "vps.example.test", port: 22, username: "fixture", authType: "password" };
  service.getProfile = () => ({ ...profile });
  const errors = [];
  service.on("session-error", (event) => errors.push(event));
  const waitForErrors = async (count) => {
    const deadline = Date.now() + 5000;
    while (errors.length < count) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for SSH failure #${count}.`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return errors[count - 1];
  };

  service.connect({ profileId: profile.id, nodeId: "vps", password: "fixture-only" });
  const unknown = await waitForErrors(1);
  assert.strictEqual(unknown.code, "SSH_HOST_KEY_UNKNOWN");
  const fingerprintA = unknown.details.fingerprint;
  service.approveHostKey(profile.id, fingerprintA);

  currentKey = KEY_B;
  service.connect({ profileId: profile.id, nodeId: "vps", password: "fixture-only" });
  const changed = await waitForErrors(2);
  assert.strictEqual(changed.code, "SSH_HOST_KEY_CHANGED");
  assert.strictEqual(changed.details.expectedFingerprint, fingerprintA, "the failure must carry the saved fingerprint.");
  const fingerprintB = changed.details.receivedFingerprint;
  assert(fingerprintB && fingerprintB !== fingerprintA, "the failure must carry the new fingerprint.");

  // A plain approval must not silently replace a changed identity.
  assert.throws(() => service.approveHostKey(profile.id, fingerprintB), (error) => error.code === "SSH_HOST_KEY_CHANGE_CONFIRMATION_REQUIRED", "a changed key needs an explicit replacement confirmation.");
  // A fingerprint other than the one just received is stale.
  assert.throws(() => service.approveHostKey(profile.id, fingerprintA, { replaceChangedKey: true }), (error) => error.code === "SSH_HOST_KEY_APPROVAL_STALE");
  const approved = service.approveHostKey(profile.id, fingerprintB, { replaceChangedKey: true });
  assert.strictEqual(approved.approved, true, "the confirmed replacement must be approved.");
  assert.strictEqual(approved.previousFingerprint, fingerprintA, "the approval must report the identity it replaced.");

  // Unattended SSH (tunnels, Agent updates) now accepts B and refuses A.
  service.getProfile = () => ({ ...profile, authType: "privateKey", privateKeyPath: path.join(smokeRoot, "unused-key") });
  service.buildConnectConfig = () => ({});
  const unattended = service.createUnattendedConnectConfig(profile.id);
  assert.strictEqual(unattended.connectConfig.hostVerifier(KEY_B), true, "unattended SSH must accept the replaced key.");
  assert.strictEqual(unattended.connectConfig.hostVerifier(KEY_A), false, "unattended SSH must refuse the old key.");
  assert.strictEqual(unattended.hostKeyState.mismatch, true);
});

async function main() {
  let failures = 0;
  let index = 0;
  for (const entry of checks) {
    index += 1;
    try {
      await entry.run();
      console.log(`ok ${index} - ${entry.id}: ${entry.label}`);
    } catch (error) {
      failures += 1;
      console.error(`not ok ${index} - ${entry.id}: ${entry.label}\n  ${error.stack || error.message}`);
    }
  }
  if (failures) {
    console.error(`remote-nodes-hardening smoke FAILED: ${failures} of ${checks.length} checks (${checks.length} checks)`);
    process.exit(1);
  }
  console.log(`remote-nodes-hardening smoke passed (${checks.length} checks)`);
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
