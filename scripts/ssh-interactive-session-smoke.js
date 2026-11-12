#!/usr/bin/env node
"use strict";

// Interactive SSH sessions (Phase 5 audit), end to end against a REAL
// in-process ssh2 server with generated keys. Nothing leaves this machine.
//   T1 an unknown host key is never trusted silently: the first connect is
//      refused with its fingerprint and no shell is opened;
//   T2 after approval the shell opens as a PTY (xterm-256color, the
//      requested size), typed input and Ctrl+C reach the server, and its
//      output streams back;
//   T3 resize sends a window-change with the new size;
//   T4 disconnect closes the channel and the session (no orphans);
//   T5 a changed host key is refused and no shell opens;
//   T6 a key the server doesn't accept fails with a plain message.
// Run: node scripts/ssh-interactive-session-smoke.js

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-ssh-interactive-"));
process.env.ANXHUB_CONFIG_DIR = root;
process.env.ANXOS_SELECTED_NODE_ID = "ssh-node";

const { Server, utils: { parseKey } } = require("ssh2");
const { SshService } = require("../src/services/sshService");

function keygen(file) {
  try {
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "anxos-fixture", "-f", file], { stdio: "ignore" });
  } catch (error) {
    throw new Error(`ssh-keygen is required for this smoke test (${error.message}).`);
  }
}

function fingerprintOf(publicKeyFile) {
  const key = parseKey(fs.readFileSync(publicKeyFile, "utf8"));
  return `SHA256:${crypto.createHash("sha256").update(key.getPublicSSH()).digest("base64").replace(/=+$/, "")}`;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await delay(25);
  }
  throw new Error(`Timed out: ${label}`);
}

function startServer(hostKeyFile, allowedPublicFile, observed) {
  const allowed = parseKey(fs.readFileSync(allowedPublicFile, "utf8"));
  const server = new Server({ hostKeys: [fs.readFileSync(hostKeyFile)] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method !== "publickey" || !ctx.key.data.equals(allowed.getPublicSSH())) return ctx.reject(["publickey"]);
      if (!ctx.signature) return ctx.accept();
      return allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo) === true ? ctx.accept() : ctx.reject();
    });
    client.on("ready", () => {
      client.on("session", (acceptSession) => {
        const session = acceptSession();
        session.on("pty", (accept, _reject, info) => {
          observed.pty = { term: info.term, cols: info.cols, rows: info.rows };
          accept && accept();
        });
        session.on("window-change", (accept, _reject, info) => {
          observed.windowChanges.push({ cols: info.cols, rows: info.rows });
          accept && accept();
        });
        session.on("shell", (accept) => {
          const stream = accept();
          observed.shells += 1;
          stream.write("fixture$ ");
          stream.on("data", (chunk) => {
            const text = chunk.toString("utf8");
            observed.input += text;
            if (text.includes("\u0003")) stream.write("^C\r\nfixture$ ");
            else stream.write(text.replace(/\r/g, "\r\n"));
          });
          stream.on("close", () => { observed.closed += 1; });
        });
      });
    });
    client.on("error", () => {});
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function main() {
  const userKey = path.join(root, "id_user");
  const otherKey = path.join(root, "id_other");
  const hostKey = path.join(root, "host_key");
  const otherHostKey = path.join(root, "host_key_2");
  [userKey, otherKey, hostKey, otherHostKey].forEach(keygen);
  const observed = { pty: null, windowChanges: [], shells: 0, input: "", closed: 0 };
  let server = await startServer(hostKey, `${userKey}.pub`, observed);
  const port = server.address().port;

  const profile = { id: "fixture-profile", nodeId: "ssh-node", displayName: "Fixture", host: "127.0.0.1", port, username: "fixture", authType: "privateKey", privateKeyPath: userKey };
  const service = new SshService({ connectTimeoutMs: 8000, authenticationTimeoutMs: 8000, shellStartTimeoutMs: 8000 });
  let currentProfile = profile;
  service.getProfile = () => currentProfile;
  const output = new Map();
  service.on("session-output", (event) => {
    const id = event.sessionId || event.id;
    output.set(id, `${output.get(id) || ""}${event.chunk || event.data || ""}`);
  });
  const statusOf = (id) => service.getSession(id)?.status;

  try {
    // T1
    const first = service.connect({ profileId: profile.id, nodeId: "ssh-node", cols: 100, rows: 30 });
    await until(() => service.pendingHostKeys.has(profile.id) || ["failed", "error", "disconnected"].includes(String(statusOf(first.id) || first.status)), "the host key prompt");
    const pending = service.pendingHostKeys.get(profile.id);
    assert.ok(pending, "the unknown host key is held for approval");
    assert.strictEqual(pending.fingerprint, fingerprintOf(`${hostKey}.pub`), "the fingerprint shown is the server's real one");
    await until(() => !["connecting", "authenticating", "opening-shell"].includes(String(statusOf(first.id))), "the refused attempt to settle");
    assert.strictEqual(observed.shells, 0, "no shell is opened before approval");
    console.log("PASS T1 an unknown host key is held for approval; no shell opens");

    // T2
    service.approveHostKey(profile.id, pending.fingerprint);
    const session = service.connect({ profileId: profile.id, nodeId: "ssh-node", cols: 100, rows: 30 });
    await until(() => observed.shells === 1 && /fixture\$/.test(output.get(session.id) || ""), "the shell prompt");
    assert.deepStrictEqual(observed.pty, { term: "xterm-256color", cols: 100, rows: 30 }, "a real PTY of the requested size");
    service.write(session.id, "echo hello\r");
    await until(() => (output.get(session.id) || "").includes("echo hello"), "typed input to echo back");
    service.write(session.id, "\u0003");
    await until(() => (output.get(session.id) || "").includes("^C"), "Ctrl+C to reach the server");
    assert.ok(observed.input.includes("\u0003"), "Ctrl+C is sent as the interrupt byte");
    service.write(session.id, "\u001b[A");
    await until(() => observed.input.includes("\u001b[A"), "an arrow key escape sequence");
    console.log("PASS T2 approved host: PTY opens, typed input, Ctrl+C and arrow keys reach the server, output streams back");

    // T3
    service.resize(session.id, { cols: 140, rows: 40 });
    await until(() => observed.windowChanges.some((change) => change.cols === 140 && change.rows === 40), "window-change");
    console.log("PASS T3 resize sends the new terminal size");

    // T4
    service.disconnect(session.id);
    await until(() => observed.closed >= 1, "the server-side channel to close");
    await until(() => !["connected", "opening-shell"].includes(String(statusOf(session.id))), "the session to end");
    console.log(`PASS T4 disconnect closes the channel and ends the session (${statusOf(session.id) || "removed"})`);

    // T5: same address, different host key.
    await new Promise((resolve) => server.close(resolve));
    server = await new Promise((resolve) => {
      const replacement = new Server({ hostKeys: [fs.readFileSync(otherHostKey)] }, (client) => {
        client.on("authentication", (ctx) => ctx.accept());
        client.on("ready", () => client.on("session", (accept) => accept().on("shell", (acceptShell) => { observed.shells += 1; acceptShell().end(); })));
        client.on("error", () => {});
      });
      replacement.listen(port, "127.0.0.1", () => resolve(replacement));
    });
    const shellsBefore = observed.shells;
    const changed = service.connect({ profileId: profile.id, nodeId: "ssh-node", cols: 80, rows: 24 });
    await until(() => !["idle", "connecting", "authenticating", "opening-shell"].includes(String(statusOf(changed.id))), "the changed-key attempt to settle");
    const changedSnapshot = service.getSession(changed.id) || {};
    assert.notStrictEqual(changedSnapshot.status, "connected", "a changed host key never connects");
    assert.match(String(changedSnapshot.message || changedSnapshot.error?.message || ""), /host|fingerprint|identity/i, "the reason names the host identity");
    assert.strictEqual(observed.shells, shellsBefore, "no shell opens to the impostor");
    console.log("PASS T5 a changed host key is refused and no shell opens");

    // T6: back to the real host, wrong key.
    await new Promise((resolve) => server.close(resolve));
    server = await new Promise((resolve) => {
      const real = new Server({ hostKeys: [fs.readFileSync(hostKey)] }, (client) => {
        client.on("authentication", (ctx) => ctx.reject(["publickey"]));
        client.on("error", () => {});
      });
      real.listen(port, "127.0.0.1", () => resolve(real));
    });
    currentProfile = { ...profile, privateKeyPath: otherKey };
    const denied = service.connect({ profileId: profile.id, nodeId: "ssh-node", cols: 80, rows: 24 });
    await until(() => !["idle", "connecting", "authenticating", "opening-shell"].includes(String(statusOf(denied.id))), "the denied attempt to settle");
    const deniedSnapshot = service.getSession(denied.id) || {};
    assert.notStrictEqual(deniedSnapshot.status, "connected");
    assert.match(String(deniedSnapshot.message || deniedSnapshot.error?.message || ""), /authentication|key|rejected/i, "a plain authentication message");
    assert.doesNotMatch(String(deniedSnapshot.message || ""), /BEGIN|PRIVATE KEY/, "no key material in the message");
    console.log("PASS T6 a key the server rejects fails with a plain message");

    console.log("SSH interactive session smoke passed (6 checks).");
  } finally {
    try { service.dispose(); } catch {}
    await new Promise((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
