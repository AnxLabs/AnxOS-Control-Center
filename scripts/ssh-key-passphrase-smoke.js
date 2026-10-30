#!/usr/bin/env node
"use strict";

// Encrypted private keys on the SSH page. Before the fix an encrypted key with
// no passphrase threw from ssh2's client.connect() after the session existed:
// the user saw the raw parse error, then "Connection timed out before the SSH
// handshake completed." from the orphaned connect timer, and the renderer
// offered an account *password* field. This covers the service mapping, the
// orphan-timer regression, and a real connection to an in-process ssh2 server
// that only accepts the generated (passphrase-protected) key.
// Run: node scripts/ssh-key-passphrase-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { execFileSync } = require("child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-ssh-passphrase-"));
process.env.ANXHUB_CONFIG_DIR = root;
process.env.ANXOS_SELECTED_NODE_ID = "passphrase-node";

const { Server, utils: { parseKey } } = require("ssh2");
const { SshService } = require("../src/services/sshService");

const PASSPHRASE = "fixture-passphrase-4c1e";
const CONNECT_TIMEOUT_MS = 80;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function keygen(file, passphrase) {
  try {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", "anxos-fixture", "-f", file], { stdio: "ignore" });
  } catch (error) {
    throw new Error(`ssh-keygen is required for this smoke test (${error.message}).`);
  }
}

async function waitFor(predicate, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await delay(5);
  }
}

const encryptedKey = path.join(root, "id_encrypted");
const plainKey = path.join(root, "id_plain");
const hostKey = path.join(root, "host_key");
const invalidKey = path.join(root, "id_invalid");
keygen(encryptedKey, PASSPHRASE);
keygen(plainKey, "");
keygen(hostKey, "");
fs.writeFileSync(invalidKey, "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-key\n-----END OPENSSH PRIVATE KEY-----\n");

let results = 0;
function pass(label) {
  results += 1;
  console.log(`PASS ${label}`);
}

function profileFor(keyPath, overrides = {}) {
  return {
    id: "passphrase-profile",
    nodeId: "passphrase-node",
    displayName: "Passphrase fixture",
    host: "127.0.0.1",
    port: 22,
    username: "fixture",
    authType: "privateKey",
    privateKeyPath: keyPath,
    ...overrides,
  };
}

function serviceFor(profile, options = {}) {
  const service = new SshService({ connectTimeoutMs: CONNECT_TIMEOUT_MS, ...options });
  service.getProfile = () => profile;
  return service;
}

async function main() {
  // K1-K5: key parsing happens before any connection, with distinct codes.
  const encryptedService = serviceFor(profileFor(encryptedKey));
  assert.throws(
    () => encryptedService.buildConnectConfig(encryptedService.getProfile(), {}),
    (error) => error.code === "SSH_KEY_PASSPHRASE_REQUIRED" && /passphrase/i.test(error.message) && /not the SSH account password/i.test(error.message),
  );
  pass("K1 an encrypted key without a passphrase asks for the key passphrase, not the account password");

  assert.throws(
    () => encryptedService.buildConnectConfig(encryptedService.getProfile(), { passphrase: "wrong-passphrase" }),
    (error) => error.code === "SSH_KEY_PASSPHRASE_INCORRECT" && /passphrase is incorrect/i.test(error.message),
  );
  pass("K2 a wrong passphrase is reported as incorrect");

  const unlocked = encryptedService.buildConnectConfig(encryptedService.getProfile(), { passphrase: PASSPHRASE });
  assert.strictEqual(unlocked.passphrase, PASSPHRASE);
  assert.ok(unlocked.privateKey.includes("OPENSSH PRIVATE KEY"));
  assert.strictEqual(unlocked.password, undefined, "a key profile never sends an account password");
  pass("K3 the right passphrase is passed to ssh2 with the key");

  const plainService = serviceFor(profileFor(plainKey));
  const plainConfig = plainService.buildConnectConfig(plainService.getProfile(), {});
  assert.strictEqual(plainConfig.passphrase, undefined);
  pass("K4 an unencrypted key needs no passphrase");

  const invalidService = serviceFor(profileFor(invalidKey));
  assert.throws(
    () => invalidService.buildConnectConfig(invalidService.getProfile(), {}),
    (error) => error.code === "SSH_PRIVATE_KEY_INVALID" && /could not be parsed/i.test(error.message),
  );
  pass("K5 an unparseable key file has its own error");

  // K6: the reported bug. No client is created, nothing is left behind, and
  // no timeout fires afterwards.
  let clientsCreated = 0;
  const k6 = serviceFor(profileFor(encryptedKey), { createClient: () => { clientsCreated += 1; return new EventEmitter(); } });
  const k6Errors = [];
  k6.on("session-error", (event) => k6Errors.push(event));
  assert.throws(
    () => k6.connect({ profileId: "passphrase-profile", nodeId: "passphrase-node" }),
    (error) => error.code === "SSH_KEY_PASSPHRASE_REQUIRED",
  );
  await delay(CONNECT_TIMEOUT_MS * 3);
  assert.strictEqual(clientsCreated, 0);
  assert.strictEqual(k6.sessions.size, 0);
  assert.deepStrictEqual(k6Errors.map((event) => event.code), [], "no orphaned connect timer may report a timeout");
  pass("K6 a missing passphrase fails before connecting and never reports a timeout");

  // K7: if ssh2 itself throws synchronously, the session fails once with the
  // mapped error and its timer is cleared.
  class ThrowingClient extends EventEmitter {
    connect() { throw new Error("Cannot parse privateKey: Encrypted private OpenSSH key detected, but no passphrase given"); }
    end() {}
    destroy() {}
  }
  const k7 = serviceFor(profileFor(plainKey), { createClient: () => new ThrowingClient() });
  const k7Errors = [];
  k7.on("session-error", (event) => k7Errors.push(event));
  assert.throws(
    () => k7.connect({ profileId: "passphrase-profile", nodeId: "passphrase-node" }),
    (error) => error.code === "SSH_KEY_PASSPHRASE_REQUIRED",
  );
  await delay(CONNECT_TIMEOUT_MS * 3);
  assert.deepStrictEqual(k7Errors.map((event) => event.code), ["SSH_KEY_PASSPHRASE_REQUIRED"]);
  assert.strictEqual(k7.sessions.size, 0);
  pass("K7 a synchronous ssh2 throw fails the session once, with no later timeout");

  // K8: a host that never answers reports a timeout naming host:port.
  class StalledClient extends EventEmitter { connect() {} end() {} destroy() {} }
  const k8 = serviceFor(profileFor(plainKey, { host: "203.0.113.9", port: 2222 }), { createClient: () => new StalledClient() });
  const k8Errors = [];
  k8.on("session-error", (event) => k8Errors.push(event));
  k8.connect({ profileId: "passphrase-profile", nodeId: "passphrase-node" });
  await waitFor(() => k8Errors.length > 0, "connect timeout");
  assert.strictEqual(k8Errors[0].code, "SSH_CONNECTION_TIMEOUT");
  assert.match(k8Errors[0].message, /handshake/i);
  assert.match(k8Errors[0].message, /203\.0\.113\.9:2222/);
  pass("K8 a network timeout names the host and port and what to check");

  // K9: background work can't prompt, so an encrypted key is refused clearly.
  const fingerprintFile = path.join(root, "ssh-known-hosts.json");
  fs.writeFileSync(fingerprintFile, `${JSON.stringify({ "127.0.0.1:22": { fingerprint: "SHA256:fixture" } })}\n`);
  assert.throws(
    () => encryptedService.createUnattendedConnectConfig("passphrase-profile"),
    (error) => error.code === "SSH_KEY_PASSPHRASE_UNATTENDED" && /background tasks/i.test(error.message),
  );
  fs.rmSync(fingerprintFile);
  pass("K9 unattended use of an encrypted key gets an explanation instead of a parse error");

  // K10-K12: a real SSH server that accepts only the generated public key.
  const allowedKey = parseKey(fs.readFileSync(`${encryptedKey}.pub`, "utf8"));
  const server = new Server({ hostKeys: [fs.readFileSync(hostKey)] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "publickey" && ctx.key.algo === allowedKey.type && ctx.key.data.equals(allowedKey.getPublicSSH())) {
        if (!ctx.signature) return ctx.accept();
        return allowedKey.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject();
      }
      return ctx.reject(["publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("pty", (acceptPty) => acceptPty?.());
        session.on("shell", (acceptShell) => {
          const stream = acceptShell();
          stream.write("fixture shell ready\r\n");
          stream.on("data", () => {});
        });
      });
    });
    client.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    const live = serviceFor(profileFor(encryptedKey, { port }), { connectTimeoutMs: 5000 });
    const liveErrors = [];
    live.on("session-error", (event) => liveErrors.push(event));

    // First contact: approve the host key, as the SSH page does.
    live.connect({ profileId: "passphrase-profile", nodeId: "passphrase-node", passphrase: PASSPHRASE });
    await waitFor(() => liveErrors.length > 0, "host-key prompt");
    assert.strictEqual(liveErrors[0].code, "SSH_HOST_KEY_UNKNOWN");
    live.approveHostKey("passphrase-profile", liveErrors[0].details.fingerprint);

    assert.throws(
      () => live.connect({ profileId: "passphrase-profile", nodeId: "passphrase-node" }),
      (error) => error.code === "SSH_KEY_PASSPHRASE_REQUIRED",
    );
    assert.throws(
      () => live.connect({ profileId: "passphrase-profile", nodeId: "passphrase-node", passphrase: "wrong-passphrase" }),
      (error) => error.code === "SSH_KEY_PASSPHRASE_INCORRECT",
    );
    pass("K10 against a real server, a missing or wrong passphrase is caught before connecting");

    const snapshot = live.connect({ profileId: "passphrase-profile", nodeId: "passphrase-node", passphrase: PASSPHRASE });
    await waitFor(() => live.sessions.get(snapshot.id)?.shellReady === true || liveErrors.length > 1, "shell ready");
    assert.strictEqual(liveErrors.length, 1, JSON.stringify(liveErrors.slice(1)));
    assert.strictEqual(live.sessions.get(snapshot.id).status, "connected");
    live.disconnect(snapshot.id);
    pass("K11 the right passphrase connects and opens a shell");

    const otherKey = serviceFor(profileFor(plainKey, { port }), { connectTimeoutMs: 5000 });
    const otherErrors = [];
    otherKey.on("session-error", (event) => otherErrors.push(event));
    otherKey.connect({ profileId: "passphrase-profile", nodeId: "passphrase-node" });
    await waitFor(() => otherErrors.length > 0, "authentication failure");
    assert.strictEqual(otherErrors[0].code, "SSH_AUTHENTICATION_FAILED");
    assert.match(otherErrors[0].message, /rejected this key for fixture@127\.0\.0\.1/);
    assert.match(otherErrors[0].message, /authorized_keys/);
    const serialized = JSON.stringify([...liveErrors, ...otherErrors, ...k6Errors, ...k7Errors]);
    assert.ok(!serialized.includes(PASSPHRASE), "the passphrase never appears in SSH events");
    pass("K12 a key the server rejects names the account and authorized_keys; no event carries the passphrase");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  // K13: renderer contract.
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const index = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.ok(index.includes("data-ssh-password-label"), "the prompt label can switch between Password and Key passphrase");
  assert.ok(app.includes('sshPasswordLabel.textContent = passphrase ? "Key passphrase" : "Password";'));
  assert.ok(app.includes('sshCredentialPromptKind === "passphrase" ? { passphrase: value } : { password: value }'), "the prompt sends a passphrase as a passphrase, never as a password");
  assert.ok(app.includes('code === "SSH_KEY_PASSPHRASE_REQUIRED" || code === "SSH_KEY_PASSPHRASE_INCORRECT"'), "passphrase errors reopen the prompt in passphrase mode");
  assert.ok(app.includes("// A key profile has no password to re-enter; only show the error."), "other key-profile errors don't show a password field");
  pass("K13 the SSH page asks for the key passphrase separately from the account password");

  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(`ssh key passphrase smoke passed (${results} checks).`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
