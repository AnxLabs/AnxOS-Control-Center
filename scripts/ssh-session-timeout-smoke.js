const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-ssh-timeout-"));
process.env.ANXHUB_CONFIG_DIR = root;
process.env.ANXOS_SELECTED_NODE_ID = "timeout-node";

const source = fs.readFileSync(path.join(__dirname, "..", "src", "services", "sshService.js"), "utf8");
const { SshService } = require("../src/services/sshService");

assert(source.includes("const SHELL_START_TIMEOUT_MS = 10000;"), "SSH shell startup must have a bounded timeout.");
assert(source.includes("const DEFAULT_CONNECT_TIMEOUT_MS = 10000;"), "SSH connection establishment must have a bounded timeout.");
assert(source.indexOf("session.connectTimer = setTimeout") < source.indexOf('client.on("ready"'), "SSH connect timeout must cover pre-ready stalls.");
assert(source.indexOf("session.shellStartTimer = setTimeout") > source.indexOf('client.on("ready"'), "SSH shell startup timeout must begin after the transport is ready.");
assert(source.includes("SSH_TIMEOUT"), "SSH connection timeout must use a structured error code.");
assert(source.includes("SSH_SHELL_START_TIMEOUT"), "SSH shell startup timeout must use a structured error code.");
assert(source.includes("shellReady: Boolean(session.shellReady)"), "SSH snapshots must expose shell readiness separately from connection state.");
assert(source.includes("SSH_SHELL_NOT_READY"), "SSH write failures must distinguish a connected transport from an unready shell.");
assert(source.indexOf('stream.on("data"') < source.indexOf('session.status = "connected"'), "SSH output listeners must attach before broadcasting shell readiness.");
assert(source.includes("clearTimeout(session.shellStartTimer)"), "SSH shell startup timers must be cleared after callback or teardown.");
assert(source.includes("clearTimeout(session.connectTimer)"), "SSH connect timers must be cleared after callback or teardown.");
assert(source.includes("client.on(\"error\""), "SSH client errors must terminate the session.");
assert(source.includes("client.on(\"close\""), "SSH client close events must terminate the session.");

class StalledClient extends EventEmitter {
  connect() {}
  end() { this.ended = true; }
  destroy() { this.destroyed = true; }
}

class ReadyClient extends StalledClient {
  connect() {
    queueMicrotask(() => this.emit("ready"));
  }
  shell(options, callback) {
    this.shellOptions = options;
    this.stream = new EventEmitter();
    this.writes = [];
    this.stream.writable = true;
    this.stream.write = (data) => { this.writes.push(data); };
    this.stream.end = () => { this.streamEnded = true; };
    queueMicrotask(() => callback(null, this.stream));
  }
}

class ReadyNoShellClient extends StalledClient {
  connect() {
    queueMicrotask(() => this.emit("ready"));
  }
  shell() {}
}

async function main() {
  const stalledClient = new StalledClient();
  const service = new SshService({ createClient: () => stalledClient, connectTimeoutMs: 20, shellStartTimeoutMs: 40 });
  service.getProfile = () => ({
    id: "timeout-profile",
    nodeId: "timeout-node",
    displayName: "Timeout fixture",
    host: "127.0.0.1",
    port: 22,
    username: "fixture",
    authType: "password",
  });
  const errors = [];
  service.on("session-error", (event) => errors.push(event));
  const session = service.connect({ profileId: "timeout-profile", nodeId: "timeout-node", password: "fixture-only" });
  assert.strictEqual(session.status, "connecting", "Fixture must reproduce the pre-fix indefinite Connecting state.");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.strictEqual(errors.length, 1, "A stalled connection must emit one bounded connect failure.");
  assert.strictEqual(errors[0].code, "SSH_TIMEOUT");
  assert.match(errors[0].message, /did not respond in time/i);
  assert.strictEqual(service.sessions.size, 0, "Timeout cleanup must remove the pending session.");
  assert.strictEqual(service.sessionIdsByProfileId.size, 0, "Timeout cleanup must remove the profile mapping.");
  assert.strictEqual(stalledClient.ended, true, "Timeout cleanup must close the SSH client.");
  assert.strictEqual(stalledClient.destroyed, true, "Timeout cleanup must destroy the SSH client.");
  assert.strictEqual(stalledClient.listenerCount("ready"), 0, "Timeout cleanup must remove client listeners.");

  const noShellClient = new ReadyNoShellClient();
  service.createClient = () => noShellClient;
  const shellTimeout = service.connect({ profileId: "timeout-profile", nodeId: "timeout-node", password: "fixture-only" });
  assert.strictEqual(shellTimeout.status, "connecting", "Ready-without-shell fixture should begin in connecting state.");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.strictEqual(errors.length, 2, "A stalled shell allocation must emit one bounded shell-start failure.");
  assert.strictEqual(errors[1].code, "SSH_SHELL_START_TIMEOUT");
  assert.match(errors[1].message, /did not open a terminal in time/i);
  assert.strictEqual(service.sessions.size, 0, "Shell timeout cleanup must remove the pending session.");
  assert.strictEqual(noShellClient.ended, true, "Shell timeout cleanup must close the SSH client.");
  assert.strictEqual(noShellClient.destroyed, true, "Shell timeout cleanup must destroy the SSH client.");

  const retryClient = new ReadyClient();
  service.createClient = () => retryClient;
  const retry = service.connect({ profileId: "timeout-profile", nodeId: "timeout-node", password: "fixture-only" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const connectedRetry = service.sessions.get(retry.id);
  assert.strictEqual(connectedRetry?.status, "connected", "A clean retry must connect after timeout cleanup.");
  assert.strictEqual(connectedRetry?.shellReady, true, "A clean shell callback must mark the shell ready.");
  assert.strictEqual(service.write(retry.id, "uptime\r").sessionId, retry.id, "Writes must target the active ready shell session.");
  assert(retryClient.writes.includes("uptime\r"), "Command input must be written to the SSH shell stream.");
  connectedRetry.shellReady = false;
  assert.throws(
    () => service.write(retry.id, "date\r"),
    (error) => error.code === "SSH_SHELL_NOT_READY" && /shell is not ready/i.test(error.message),
    "Connected-but-unready shells must reject writes with a clear bounded error.",
  );
  connectedRetry.shellReady = true;
  service.disconnect(retry.id);
  assert.strictEqual(service.sessions.size, 0, "Disconnect must immediately clean up a recovered session.");
  assert.strictEqual(retryClient.streamEnded, true, "Disconnect must close the recovered PTY stream.");
  console.log("SSH session timeout smoke checks passed.");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
