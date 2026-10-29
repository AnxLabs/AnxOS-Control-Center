"use strict";

// App-managed SSH tunnels (src/services/nodeTunnelService.js) against a fake
// SSH client: real loopback sockets on the desktop side, and a local echo
// server standing in for the remote Agent. No real SSH connection is made.
// Run: node scripts/node-tunnel-service-smoke.js

const assert = require("assert");
const net = require("net");
const { EventEmitter } = require("events");
const { createNodeTunnelService } = require("../src/services/nodeTunnelService");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(15);
  }
  assert.fail(`timed out waiting for: ${label}`);
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function startEcho() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.on("data", (data) => socket.write(`agent:${data}`)));
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function request(port, text) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let reply = "";
    socket.on("data", (data) => { reply += data; socket.end(); });
    socket.on("close", () => resolve(reply || null));
    socket.on("error", () => resolve(null));
    socket.write(text);
  });
}

// A fake ssh2 Client: "connects" according to the scripted plan and forwards
// to the echo server on the agent's port.
function fakeSsh(plan) {
  const clients = [];
  const configs = [];
  return {
    clients,
    configs,
    createUnattendedConnectConfig(profileId) {
      if (plan.configError) throw Object.assign(new Error("nope"), { code: plan.configError });
      configs.push(profileId);
      return { connectConfig: { host: "node.example" }, hostKeyState: { mismatch: false } };
    },
    createClient() {
      const client = new EventEmitter();
      client.end = () => setImmediate(() => client.emit("close"));
      client.connect = () => setImmediate(() => {
        const outcome = plan.outcomes.shift() || "ready";
        if (outcome === "ready") client.emit("ready");
        else client.emit("error", Object.assign(new Error(outcome), { code: outcome }));
      });
      client.forwardOut = (srcHost, srcPort, host, port, callback) => {
        const stream = net.connect(plan.echoPort, "127.0.0.1");
        stream.once("connect", () => callback(null, stream));
        stream.once("error", (error) => callback(error));
        assert.deepStrictEqual([host, port], ["127.0.0.1", 47132], "forwards to the Agent port on the node");
      };
      clients.push(client);
      return client;
    },
  };
}

function node(port, transport = {}) {
  return {
    id: "ovh",
    kind: "agent",
    enabled: true,
    baseUrl: `http://127.0.0.1:${port}`,
    transport: { type: "ssh-tunnel", sshProfileId: "ovh-key", remoteHost: "127.0.0.1", remotePort: 47132, ...transport },
  };
}

async function main() {
  // T0: node transport settings are validated before any tunnel exists.
  const { _test: nodeTest } = require("../src/services/nodeService");
  const normalize = nodeTest.normalizeNodeTransport;
  assert.deepStrictEqual(normalize(undefined), { type: "direct" }, "existing nodes stay direct");
  assert.deepStrictEqual(normalize({ type: "ssh-tunnel", sshProfileId: "ovh-key", remotePort: 47132 }), { type: "ssh-tunnel", sshProfileId: "ovh-key", remoteHost: "127.0.0.1", remotePort: 47132 });
  for (const bad of [{ sshProfileId: "a b", remotePort: 1 }, { sshProfileId: "x", remotePort: 70000 }, { sshProfileId: "x", remoteHost: "evil;rm", remotePort: 22 }]) {
    assert.deepStrictEqual(normalize({ type: "ssh-tunnel", ...bad }), { type: "direct" }, `rejects ${JSON.stringify(bad)}`);
  }
  assert.strictEqual(nodeTest.isLoopbackAgentUrl("http://127.0.0.1:47132"), true);
  assert.strictEqual(nodeTest.isLoopbackAgentUrl("http://192.168.1.134:47131"), false, "only loopback Agent URLs can be tunneled");
  console.log("PASS T0 node transport settings are validated");

  const echo = await startEcho();
  const echoPort = echo.address().port;

  // T1: a configured node gets a working tunnel on its local Agent port.
  let port = await freePort();
  let plan = { echoPort, outcomes: ["ready"] };
  let ssh = fakeSsh(plan);
  let nodes = [node(port), { id: "lan", kind: "agent", enabled: true, baseUrl: "http://192.168.1.5:47131", transport: { type: "direct" } }];
  let service = createNodeTunnelService({ getNodes: () => nodes, getSsh: () => ssh, reconnectMinMs: 20, reconnectMaxMs: 80 });
  service.sync();
  await until(() => service.getStatus("ovh")?.state === "connected", "tunnel connected");
  assert.strictEqual(service.listStatus().length, 1, "direct nodes get no tunnel");
  assert.strictEqual(await request(port, "health"), "agent:health", "requests reach the Agent through the tunnel");
  console.log("PASS T1 an ssh-tunnel node is reachable on its local Agent URL");

  // T2: a dropped SSH session reconnects with backoff, and requests work again.
  plan.outcomes.push("ECONNREFUSED", "ready");
  ssh.clients[0].emit("close");
  await until(() => service.getStatus("ovh")?.state === "reconnecting", "reconnecting after drop");
  assert.ok(service.getStatus("ovh").lastError, "the drop reason is reported");
  await until(() => service.getStatus("ovh")?.state === "connected", "connected again");
  assert.strictEqual(ssh.clients.length, 3, "one failed retry, then a successful one");
  assert.strictEqual(service.getStatus("ovh").attempts, 0, "attempts reset after success");
  assert.strictEqual(await request(port, "again"), "agent:again");
  console.log("PASS T2 a dropped tunnel reconnects by itself with backoff");

  // T3: while down, a request fails fast instead of hanging.
  plan.outcomes.push("ETIMEDOUT", "ETIMEDOUT", "ETIMEDOUT");
  ssh.clients[ssh.clients.length - 1].emit("close");
  await until(() => service.getStatus("ovh")?.state === "reconnecting", "down");
  const started = Date.now();
  assert.strictEqual(await request(port, "x"), null);
  assert.ok(Date.now() - started < 1000, "requests during an outage fail fast");
  service.stopAll();
  console.log("PASS T3 requests fail fast while the tunnel is reconnecting");

  // T4: permanent problems (unapproved host key, password profile) stop retrying.
  port = await freePort();
  nodes = [node(port)];
  ssh = fakeSsh({ echoPort, outcomes: [], configError: "SSH_HOST_KEY_NOT_APPROVED" });
  service = createNodeTunnelService({ getNodes: () => nodes, getSsh: () => ssh, reconnectMinMs: 20 });
  service.sync();
  await until(() => service.getStatus("ovh")?.state === "failed", "failed");
  assert.strictEqual(service.getStatus("ovh").lastError.code, "SSH_HOST_KEY_NOT_APPROVED");
  await wait(100);
  assert.strictEqual(ssh.clients.length, 0, "no retry loop for problems the user must fix");
  service.stopAll();
  console.log("PASS T4 permanent SSH problems are reported once, not retried");

  // T5: a manual tunnel already on the port is left alone, then taken over.
  port = await freePort();
  const manualSockets = new Set();
  const manual = net.createServer((socket) => { manualSockets.add(socket); socket.end("manual"); });
  await new Promise((resolve) => manual.listen(port, "127.0.0.1", resolve));
  nodes = [node(port)];
  ssh = fakeSsh({ echoPort, outcomes: ["ready"] });
  service = createNodeTunnelService({ getNodes: () => nodes, getSsh: () => ssh });
  service.sync();
  await until(() => service.getStatus("ovh")?.state === "external", "external");
  assert.strictEqual(await request(port, "x"), "manual", "the manual tunnel keeps working");
  await new Promise((resolve) => { manual.close(resolve); manualSockets.forEach((socket) => socket.destroy()); });
  service.sync();
  await until(() => service.getStatus("ovh")?.state === "connected", "taken over");
  assert.strictEqual(await request(port, "mine"), "agent:mine");
  console.log("PASS T5 an existing manual tunnel is respected, then replaced when it goes away");

  // T6: config changes and removal restart or stop the tunnel and free the port.
  nodes = [node(port, { remotePort: 47133 })];
  service.sync();
  assert.strictEqual(service.getStatus("ovh").remotePort, 47133, "a changed transport restarts the tunnel");
  nodes = [{ ...node(port), manualDisconnect: true }];
  service.sync();
  assert.strictEqual(service.getStatus("ovh"), null, "a disconnected node has no tunnel");
  await until(async () => (await request(port, "x")) === null, "port released");
  console.log("PASS T6 tunnels follow node configuration and release their port");

  service.stopAll();
  echo.close();
  console.log("node tunnel service smoke passed (7 checks).");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
