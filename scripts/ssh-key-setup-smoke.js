#!/usr/bin/env node
"use strict";

// Key sign-in setup for a password profile (Build 215, SshService.
// setUpKeyAuthentication), end to end against a real in-process ssh2 server.
// The server accepts the account password, runs commands in a real bash with
// a temporary HOME, and accepts a public key only when that HOME's
// ~/.ssh/authorized_keys lists it, so the generated scripts really run.
//   K1  setup works: key file + .pub written, key added once, a fresh key
//       connection proves it, a key profile is saved for the same node and
//       the password profile is kept
//   K2  a second setup never overwrites the first key file
//   K3  a passphrase encrypts the key; the profile uses the SSH agent
//   K4  an unapproved host is refused before any key is created
//   K5  a wrong password leaves nothing behind
//   K6  a server that refuses the new key: the line is removed again, the
//       local files are deleted and no key profile is saved
//   K7  a changed host key is refused
//   K8  authorize/remove scripts: idempotent, safe on a file without a final
//       newline, and remove exactly the one line
//   K9  key files are protected: a failed Windows ACL deletes the key; on
//       Windows the real ACL grants only the current account
//   K10 Build 216-G: ssh2 drops a leading zero byte from about 1 ed25519
//       public key in 256, making a key nothing can parse; such a key is
//       never used (a new one is generated), and a generator that keeps
//       producing them is refused
// Run: node scripts/ssh-key-setup-smoke.js

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync, execFileSync } = require("child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-ssh-key-setup-"));
process.env.ANXHUB_CONFIG_DIR = root;
process.env.ANXOS_SELECTED_NODE_ID = "key-node";

const { Server, utils: { parseKey, generateKeyPairSync } } = require("ssh2");
const { SshService, _test: sshTest } = require("../src/services/sshService");

const USER = "anx";
const PASSWORD = "fixture-password-7d1c";
let passed = 0;
const pass = (label) => { passed += 1; console.log(`  ok ${label}`); };

function findBash() {
  if (process.platform !== "win32") return "bash";
  for (const candidate of [
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", "bash.exe"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Git", "bin", "bash.exe"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
const BASH = findBash();

function posixPath(value) {
  return process.platform === "win32" ? value.replace(/\\/g, "/") : value;
}

function hostKeyFingerprint(privateKey) {
  return sshTest.publicKeyFingerprint(`ssh-ed25519 ${parseKey(privateKey).getPublicSSH().toString("base64")} host`);
}

function startServer({ hostKey, home, acceptKeys = true }) {
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.username !== USER) return ctx.reject();
      if (ctx.method === "password") return ctx.password === PASSWORD ? ctx.accept() : ctx.reject(["password", "publickey"]);
      if (ctx.method === "publickey" && acceptKeys) {
        const file = path.join(home, ".ssh", "authorized_keys");
        const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean) : [];
        for (const line of lines) {
          const key = parseKey(line);
          if (key instanceof Error || !key.getPublicSSH().equals(ctx.key.data)) continue;
          if (!ctx.signature) return ctx.accept();
          return key.verify(ctx.blob, ctx.signature, ctx.hashAlgo) ? ctx.accept() : ctx.reject();
        }
      }
      return ctx.reject(["password", "publickey"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const child = spawn(BASH, ["-c", info.command], { env: { ...process.env, HOME: posixPath(home) }, windowsHide: true });
          child.stdout.on("data", (chunk) => stream.write(chunk));
          child.stderr.on("data", (chunk) => stream.stderr.write(chunk));
          child.on("close", (code) => {
            stream.exit(Number.isInteger(code) ? code : 1);
            stream.end();
          });
        });
      });
    });
    client.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

function writeConfig({ port, fingerprint }) {
  fs.writeFileSync(path.join(root, "ssh-profiles.json"), JSON.stringify({
    schemaVersion: 1,
    servers: [{ id: "lab-server", displayName: "Lab", host: "127.0.0.1", nodeId: "key-node" }],
    profiles: [{ id: "lab-anx", serverId: "lab-server", displayName: "Lab", host: "127.0.0.1", port, username: USER, authType: "password", nodeId: "key-node" }],
    defaultServerId: "lab-server",
    defaultProfileId: "lab-anx",
  }, null, 2));
  const known = {};
  if (fingerprint) known[`127.0.0.1:${port}`] = { fingerprint, approvedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(root, "ssh-known-hosts.json"), JSON.stringify(known, null, 2));
}

async function expectFailure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

const listKeys = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);
const authorizedLines = (home) => {
  const file = path.join(home, ".ssh", "authorized_keys");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
};

(async () => {
  if (!BASH) {
    console.log("SKIP ssh-key-setup smoke: bash is required to run the generated scripts.");
    return;
  }
  // A malformed host key (see K10) would fail this smoke about 1 run in 222.
  const hostKey = sshTest.generateUsableEd25519KeyPair().private;
  const fingerprint = hostKeyFingerprint(hostKey);

  // K1, K2
  {
    const home = fs.mkdtempSync(path.join(root, "home-"));
    const keys = path.join(root, "keys-k1");
    const { server, port } = await startServer({ hostKey, home });
    writeConfig({ port, fingerprint });
    const ssh = new SshService();
    const result = await ssh.setUpKeyAuthentication("lab-anx", { password: PASSWORD, keyDirectory: keys });
    assert.strictEqual(result.profile.authType, "privateKey");
    assert.strictEqual(result.profile.nodeId, "key-node");
    assert.strictEqual(result.passwordProfileId, "lab-anx");
    assert.strictEqual(result.passphraseProtected, false);
    assert(fs.existsSync(result.privateKeyPath) && fs.existsSync(`${result.privateKeyPath}.pub`));
    const publicLine = fs.readFileSync(`${result.privateKeyPath}.pub`, "utf8").trim();
    assert.deepStrictEqual(authorizedLines(home), [publicLine], "the key is added exactly once");
    assert.strictEqual(result.publicKeyFingerprint, sshTest.publicKeyFingerprint(publicLine));
    const profiles = ssh.listProfiles().profiles;
    assert(profiles.some((profile) => profile.id === "lab-anx" && profile.authType === "password"), "password profile kept as the fallback");
    assert.strictEqual(ssh.getProfileForNode("key-node").authType, "privateKey", "Agent Control picks the key profile");
    const proof = await ssh.runCommand(result.profile.id, "echo unattended-ok");
    assert(/unattended-ok/.test(proof.stdout), "the saved key profile works for unattended commands");
    pass("K1 key sign-in set up, proven, saved; password profile kept");

    const second = await ssh.setUpKeyAuthentication("lab-anx", { password: PASSWORD, keyDirectory: keys });
    assert.notStrictEqual(second.privateKeyPath, result.privateKeyPath);
    assert.strictEqual(fs.readFileSync(`${result.privateKeyPath}.pub`, "utf8").trim(), publicLine, "the first key is untouched");
    assert.strictEqual(authorizedLines(home).length, 2);
    pass("K2 a second setup never overwrites the first key");
    server.close();
  }

  // K3
  {
    const home = fs.mkdtempSync(path.join(root, "home-"));
    const keys = path.join(root, "keys-k3");
    const { server, port } = await startServer({ hostKey, home });
    writeConfig({ port, fingerprint });
    const ssh = new SshService();
    const result = await ssh.setUpKeyAuthentication("lab-anx", { password: PASSWORD, passphrase: "correct horse battery", keyDirectory: keys });
    assert.strictEqual(result.passphraseProtected, true);
    assert.strictEqual(result.profile.useSshAgent, true);
    assert(/ssh-add/.test(result.nextStep));
    const parsed = parseKey(fs.readFileSync(result.privateKeyPath, "utf8"));
    assert(parsed instanceof Error && /passphrase/i.test(parsed.message), "the key file is encrypted");
    assert(!(parseKey(fs.readFileSync(result.privateKeyPath, "utf8"), "correct horse battery") instanceof Error));
    pass("K3 passphrase-protected key uses the SSH agent");
    server.close();
  }

  // K4
  {
    const home = fs.mkdtempSync(path.join(root, "home-"));
    const keys = path.join(root, "keys-k4");
    const { server, port } = await startServer({ hostKey, home });
    writeConfig({ port, fingerprint: null });
    const error = await expectFailure(new SshService().setUpKeyAuthentication("lab-anx", { password: PASSWORD, keyDirectory: keys }));
    assert.strictEqual(error.code, "SSH_HOST_KEY_NOT_APPROVED");
    assert.deepStrictEqual(listKeys(keys), []);
    assert.deepStrictEqual(authorizedLines(home), []);
    pass("K4 unapproved host refused before a key exists");
    server.close();
  }

  // K5
  {
    const home = fs.mkdtempSync(path.join(root, "home-"));
    const keys = path.join(root, "keys-k5");
    const { server, port } = await startServer({ hostKey, home });
    writeConfig({ port, fingerprint });
    const ssh = new SshService();
    const error = await expectFailure(ssh.setUpKeyAuthentication("lab-anx", { password: "wrong-password", keyDirectory: keys }));
    assert.strictEqual(error.code, "SSH_AUTHENTICATION_FAILED");
    assert.deepStrictEqual(listKeys(keys), [], "no key files left behind");
    assert.deepStrictEqual(authorizedLines(home), []);
    assert.strictEqual(ssh.listProfiles().profiles.length, 1, "no key profile saved");
    assert(!JSON.stringify(error).includes("wrong-password") && !String(error.message).includes("wrong-password"), "the password never appears in the error");
    pass("K5 wrong password leaves nothing behind");
    server.close();
  }

  // K6
  {
    const home = fs.mkdtempSync(path.join(root, "home-"));
    const keys = path.join(root, "keys-k6");
    fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(home, ".ssh", "authorized_keys"), "ssh-ed25519 AAAAexisting existing@host\n");
    const { server, port } = await startServer({ hostKey, home, acceptKeys: false });
    writeConfig({ port, fingerprint });
    const ssh = new SshService();
    const error = await expectFailure(ssh.setUpKeyAuthentication("lab-anx", { password: PASSWORD, keyDirectory: keys }));
    assert(/SSH_AUTHENTICATION_FAILED|SSH_KEY_SIGN_IN_FAILED/.test(error.code), error.code);
    assert.deepStrictEqual(authorizedLines(home), ["ssh-ed25519 AAAAexisting existing@host"], "the added line was removed; the existing one kept");
    assert.deepStrictEqual(listKeys(keys), [], "local key files deleted");
    assert.strictEqual(ssh.listProfiles().profiles.length, 1, "no key profile saved");
    pass("K6 rejected key undone on both sides");
    server.close();
  }

  // K7
  {
    const home = fs.mkdtempSync(path.join(root, "home-"));
    const keys = path.join(root, "keys-k7");
    const otherHostKey = generateKeyPairSync("ed25519").private;
    const { server, port } = await startServer({ hostKey: otherHostKey, home });
    writeConfig({ port, fingerprint });
    const error = await expectFailure(new SshService().setUpKeyAuthentication("lab-anx", { password: PASSWORD, keyDirectory: keys }));
    assert.strictEqual(error.code, "SSH_HOST_KEY_MISMATCH");
    assert.deepStrictEqual(authorizedLines(home), []);
    assert.deepStrictEqual(listKeys(keys), []);
    pass("K7 changed host key refused");
    server.close();
  }

  // K8
  {
    const home = fs.mkdtempSync(path.join(root, "home-"));
    fs.mkdirSync(path.join(home, ".ssh"), { recursive: true });
    fs.writeFileSync(path.join(home, ".ssh", "authorized_keys"), "ssh-ed25519 AAAAone one@host");
    const line = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture anxos-anx@lab";
    const run = (script) => spawnSync(BASH, ["-c", script], { env: { ...process.env, HOME: posixPath(home) }, encoding: "utf8" });
    assert(/AUTHORIZED_KEY=added/.test(run(sshTest.buildAuthorizeKeyScript(line)).stdout));
    assert(/AUTHORIZED_KEY=present/.test(run(sshTest.buildAuthorizeKeyScript(line)).stdout));
    assert.deepStrictEqual(authorizedLines(home), ["ssh-ed25519 AAAAone one@host", line], "no line glued together, no duplicate");
    assert(/AUTHORIZED_KEY=removed/.test(run(sshTest.buildRemoveKeyScript(line)).stdout));
    assert.deepStrictEqual(authorizedLines(home), ["ssh-ed25519 AAAAone one@host"]);
    const injected = "ssh-ed25519 AAAA x'; touch \"$HOME/pwned\"; echo '";
    run(sshTest.buildAuthorizeKeyScript(injected));
    assert(!fs.existsSync(path.join(home, "pwned")), "a quoted key line cannot run commands");
    pass("K8 authorize/remove scripts are idempotent and exact");
  }

  // K9
  {
    const dir = path.join(root, "keys-k9");
    const error = (() => {
      try {
        sshTest.writePrivateKeyFile(dir, "acl", "PRIVATE", "ssh-ed25519 AAAA x", { platform: "win32", runIcacls: () => { throw new Error("icacls failed"); } });
      } catch (caught) {
        return caught;
      }
      return null;
    })();
    assert(error && error.code === "SSH_KEY_PROTECT_FAILED");
    assert.deepStrictEqual(listKeys(dir), [], "an unprotected key is deleted");
    if (process.platform === "win32") {
      const keyPath = sshTest.writePrivateKeyFile(dir, "real", "PRIVATE", "ssh-ed25519 AAAA x");
      const acl = execFileSync("icacls", [keyPath], { encoding: "utf8" });
      const grants = acl.split(/\r?\n/).slice(0, -2).map((lineText) => lineText.replace(keyPath, "").trim()).filter(Boolean);
      assert.strictEqual(grants.length, 1, `exactly one ACL entry: ${acl}`);
      assert(grants[0].toLowerCase().includes(String(process.env.USERNAME || os.userInfo().username).toLowerCase()), acl);
      pass("K9 key files protected (real Windows ACL: current account only)");
    } else {
      assert.strictEqual(fs.statSync(sshTest.writePrivateKeyFile(dir, "real", "PRIVATE", "ssh-ed25519 AAAA x")).mode & 0o077, 0);
      pass("K9 key files protected (mode 0600)");
    }
  }

  fs.rmSync(root, { recursive: true, force: true });
  // K10
  {
    let malformed = null;
    for (let i = 0; i < 20000 && !malformed; i += 1) {
      const candidate = generateKeyPairSync("ed25519");
      if (parseKey(candidate.private) instanceof Error) malformed = candidate;
    }
    assert(malformed, "ssh2 produced a malformed ed25519 key within 20,000 tries (about 1 in 222 expected)");
    let calls = 0;
    const once = (type, options) => { calls += 1; return calls === 1 ? malformed : generateKeyPairSync(type, options); };
    const usable = sshTest.generateUsableEd25519KeyPair({ comment: "k10" }, once);
    assert.strictEqual(calls, 2, "the malformed key was skipped and a new one generated");
    assert.notStrictEqual(usable.private, malformed.private);
    const parsed = parseKey(usable.private);
    assert(!(parsed instanceof Error) && parsed.getPublicSSH().length === 51, "the key used parses with a full 32-byte public key");
    assert.throws(() => sshTest.generateUsableEd25519KeyPair({}, () => malformed), (error) => error.code === "SSH_KEY_GENERATION_FAILED", "a generator that only produces malformed keys is refused");
    const protectedKey = sshTest.generateUsableEd25519KeyPair({ comment: "k10", passphrase: "k10 passphrase", cipher: "aes256-ctr", rounds: 4 });
    assert(!(parseKey(protectedKey.private, "k10 passphrase") instanceof Error), "a passphrase key is checked with its passphrase");
    pass("K10 a malformed generated key is never used");
  }

  console.log(`SSH key setup smoke passed (${passed} cases).`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
