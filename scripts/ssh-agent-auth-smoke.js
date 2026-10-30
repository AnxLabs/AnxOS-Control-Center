#!/usr/bin/env node
"use strict";

// Unattended SSH with a passphrase-protected key through the OS SSH agent
// (Windows OpenSSH Authentication Agent / SSH_AUTH_SOCK). Background Agent
// Start/Stop/Restart and Update must work without a passphrase prompt, the
// key file stays encrypted, and AnxOS stores only an opt-in flag.
//
// A real in-process ssh2 server accepts only the generated encrypted key; a
// fake agent on a named pipe (Unix socket off Windows) holds the unlocked key,
// as `ssh-add` would, plus an unrelated key that must never be offered.
// Run: node scripts/ssh-agent-auth-smoke.js

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-ssh-agent-"));
process.env.ANXHUB_CONFIG_DIR = root;
process.env.ANXOS_SELECTED_NODE_ID = "agent-node";

const { AgentProtocol, Server, utils: { parseKey } } = require("ssh2");
const { SshService } = require("../src/services/sshService");

const PASSPHRASE = "fixture-agent-passphrase-91d2";
let results = 0;
const pass = (label) => { results += 1; console.log(`PASS ${label}`); };

function keygen(file, passphrase) {
  try {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", passphrase, "-C", "anxos-fixture", "-f", file], { stdio: "ignore" });
  } catch (error) {
    throw new Error(`ssh-keygen is required for this smoke test (${error.message}).`);
  }
}

const agentPathFor = (name) => (process.platform === "win32"
  ? `\\\\.\\pipe\\anxos-smoke-${name}-${process.pid}`
  : path.join(root, `${name}.sock`));

// A minimal ssh-agent: lists the given unlocked keys and signs with them.
function startFakeAgent(name, privateKeys) {
  const stats = { listed: 0, signed: 0, signedWith: [] };
  const server = net.createServer((socket) => {
    const protocol = new AgentProtocol(false);
    protocol.on("identities", (req) => {
      stats.listed += 1;
      protocol.getIdentitiesReply(req, privateKeys);
    });
    protocol.on("sign", (req, pubKey, data) => {
      const key = privateKeys.find((candidate) => candidate.getPublicSSH().equals(pubKey.getPublicSSH()));
      if (!key) return protocol.failureReply(req);
      stats.signed += 1;
      stats.signedWith.push(key.comment || "key");
      return protocol.signReply(req, key.sign(data));
    });
    socket.pipe(protocol).pipe(socket);
    socket.on("error", () => {});
  });
  const agentPath = agentPathFor(name);
  return new Promise((resolve) => server.listen(agentPath, () => resolve({ server, agentPath, stats })));
}

async function main() {
  const encryptedKey = path.join(root, "id_encrypted");
  const otherKey = path.join(root, "id_other");
  const hostKey = path.join(root, "host_key");
  keygen(encryptedKey, PASSPHRASE);
  keygen(otherKey, "");
  keygen(hostKey, "");
  const unlocked = parseKey(fs.readFileSync(encryptedKey, "utf8"), PASSPHRASE);
  const other = parseKey(fs.readFileSync(otherKey, "utf8"));
  assert.ok(!(unlocked instanceof Error) && !(other instanceof Error));
  const allowedPublic = parseKey(fs.readFileSync(`${encryptedKey}.pub`, "utf8"));

  // Real SSH server: accepts only the encrypted key's public half.
  const authAttempts = [];
  const server = new Server({ hostKeys: [fs.readFileSync(hostKey)] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method !== "publickey") return ctx.reject(["publickey"]);
      const allowed = ctx.key.data.equals(allowedPublic.getPublicSSH());
      authAttempts.push(allowed ? "allowed" : "other");
      if (!allowed) return ctx.reject(["publickey"]);
      if (!ctx.signature) return ctx.accept();
      return allowedPublic.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        accept().on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          stream.write(info.command === "echo agent-ok" ? "agent-ok\n" : "unexpected\n");
          stream.exit(0);
          stream.end();
        });
      });
    });
    client.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  // Approve the host key the way the SSH page does, so unattended use is allowed.
  const hostPublic = parseKey(fs.readFileSync(`${hostKey}.pub`, "utf8"));
  const fingerprint = `SHA256:${crypto.createHash("sha256").update(hostPublic.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
  fs.writeFileSync(path.join(root, "ssh-known-hosts.json"), `${JSON.stringify({ [`127.0.0.1:${port}`]: { fingerprint } })}\n`);

  const profile = { id: "agent-profile", nodeId: "agent-node", displayName: "Agent fixture", host: "127.0.0.1", port, username: "fixture", authType: "privateKey", privateKeyPath: encryptedKey, useSshAgent: true };
  const serviceFor = (agentPath, overrides = {}) => {
    const service = new SshService({ sshAgentPath: agentPath });
    service.getProfile = () => ({ ...profile, ...overrides });
    return service;
  };

  const loaded = await startFakeAgent("loaded", [other, unlocked]);
  const empty = await startFakeAgent("empty", [other]);
  try {
    // S1: background command, encrypted key, no passphrase anywhere.
    const result = await serviceFor(loaded.agentPath).runCommand("agent-profile", "echo agent-ok", { timeoutMs: 10000 });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout.trim(), "agent-ok");
    assert.strictEqual(loaded.stats.signed, 1, "the agent signed the login once");
    assert.deepStrictEqual(authAttempts, ["allowed", "allowed"], "only the profile's own key was offered (query + signed attempt), never the other loaded key");
    pass("S1 a background command signs in through the agent with the encrypted key, no passphrase");

    // S2: the agent is running but this key isn't loaded.
    await assert.rejects(serviceFor(empty.agentPath).runCommand("agent-profile", "echo agent-ok", { timeoutMs: 10000 }), (error) => error.code === "SSH_AGENT_KEY_NOT_LOADED" && /ssh-add/.test(error.message));
    assert.strictEqual(empty.stats.signed, 0, "an unrelated loaded key is never used");
    pass("S2 key not loaded in the agent: a clear ssh-add instruction, and no other key is tried");

    // S3: no agent running.
    assert.throws(() => serviceFor(agentPathFor("missing")).createUnattendedConnectConfig("agent-profile"), (error) => error.code === "SSH_AGENT_UNAVAILABLE");
    pass("S3 no agent running: refused before connecting");

    // S4: the public half is needed to pick the key from the agent.
    const noPub = path.join(root, "id_no_pub");
    fs.copyFileSync(encryptedKey, noPub);
    assert.throws(() => serviceFor(loaded.agentPath, { privateKeyPath: noPub }).createUnattendedConnectConfig("agent-profile"), (error) => error.code === "SSH_AGENT_PUBLIC_KEY_MISSING");
    pass("S4 a missing .pub file is reported, not guessed");

    // S5: without the agent opt-in, an encrypted key still can't run unattended.
    assert.throws(() => serviceFor(loaded.agentPath, { useSshAgent: false }).createUnattendedConnectConfig("agent-profile"), (error) => error.code === "SSH_KEY_PASSPHRASE_UNATTENDED" && /ssh-add/.test(error.message) && /Use SSH agent/.test(error.message));
    pass("S5 encrypted key without the agent: refused with how to enable the agent");

    // S6: interactive use with a typed passphrase still reads the key file.
    const interactive = serviceFor(loaded.agentPath).buildConnectConfig({ ...profile }, { passphrase: PASSPHRASE });
    assert.ok(interactive.privateKey && interactive.passphrase === PASSPHRASE && !interactive.agent);
    const viaAgent = serviceFor(loaded.agentPath).buildConnectConfig({ ...profile }, {});
    assert.ok(viaAgent.agent && !viaAgent.privateKey && !viaAgent.passphrase, "agent sign-in never loads the key file or a passphrase");
    pass("S6 a typed passphrase uses the key file; otherwise the agent, without key material in AnxOS");

    // S7: only an opt-in flag is stored; password profiles can't opt in.
    const store = new SshService();
    fs.writeFileSync(path.join(root, "ssh-profiles.json"), `${JSON.stringify({ schemaVersion: 1, servers: [], profiles: [
      { id: "key-profile", displayName: "Key", host: "127.0.0.1", port: 22, username: "fixture", authType: "privateKey", privateKeyPath: encryptedKey, nodeId: "agent-node" },
      { id: "pw-profile", displayName: "Password", host: "127.0.0.1", port: 22, username: "fixture", authType: "password", nodeId: "agent-node" },
    ] }, null, 2)}\n`);
    const saved = store.setProfileSshAgent("key-profile", true);
    assert.strictEqual(saved.profile.useSshAgent, true);
    assert.throws(() => store.setProfileSshAgent("pw-profile", true), (error) => error.code === "SSH_AGENT_KEY_PROFILE_REQUIRED");
    const stored = fs.readFileSync(path.join(root, "ssh-profiles.json"), "utf8");
    assert.ok(!stored.includes("PRIVATE KEY") && !stored.includes(PASSPHRASE), "no key material or passphrase is written");
    assert.strictEqual(store.setProfileSshAgent("key-profile", false).profile.useSshAgent, false);
    pass("S7 the profile stores only an opt-in flag; password profiles can't use the agent");
  } finally {
    for (const handle of [loaded, empty]) await new Promise((resolve) => handle.server.close(resolve));
    await new Promise((resolve) => server.close(resolve));
  }

  // S8: renderer contract.
  const app = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const index = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.ok(index.includes("data-ssh-profile-agent") && index.includes('data-agent-control-action="verifyRemoteControl"'));
  assert.ok(app.includes('if (verification?.verified !== true) return { supported: false, reason: "unverified"'), "SSH Agent actions stay disabled until access is verified");
  assert.ok(app.includes('["SSH_AGENT_UNAVAILABLE", "SSH_AGENT_KEY_NOT_LOADED", "SSH_AGENT_PUBLIC_KEY_MISSING"].includes(code)'), "an agent failure falls back to a one-time passphrase prompt");
  pass("S8 the SSH page offers the agent toggle and Agent Control gates actions on Verify Access");

  fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log(`ssh agent auth smoke passed (${results} checks).`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
