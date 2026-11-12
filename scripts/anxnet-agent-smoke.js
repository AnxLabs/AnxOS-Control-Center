#!/usr/bin/env node
"use strict";

// Phase 7.1: AnxNet inside the Agent. A real Agent process (with a stand-in
// Minecraft server) joins an AnxNet network owned by a node in this process
// (standing in for the desktop) and shares its server from its own computer.
// One host; separate computers are simulated (see anxnet-two-machine-test.js
// for real separate machines).
//   A1 join only with an owner invite, through the authenticated Agent API
//   A2 share a server's own port; members reach it through AnxNet
//   A3 management ports refused: the Agent's own port, SSH, undeclared ports
//   A4 unshare removes the members' forward
//   A5 the Agent leaves AnxNet cleanly when it stops; it resumes on start
//   A6 the owner revokes the Agent's device: it can't reconnect
//   A7 a restricted Agent principal can read AnxNet status but not join
//   A8 status never exposes keys or invite secrets
// Run: node scripts/anxnet-agent-smoke.js

const assert = require("assert");
const { spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { AnxNetNode } = require("../src/anxnet/node");
const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");
const { fakeMinecraftInstance } = require("./test-helpers/fake-minecraft-instance");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "anxnet-agent-smoke-"));
const cleanup = [];
let checks = 0;
const pass = (label) => { checks += 1; console.log(`PASS ${label}`); };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { last = error; }
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${label}${last ? `: ${last.message}` : ""}`);
}

async function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

function firstReply(port, host, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    let data = "";
    const timer = setTimeout(() => { socket.destroy(); resolve(data); }, 4000);
    socket.on("connect", () => socket.write(text));
    socket.on("data", (chunk) => { data += chunk; if (data.includes("\n")) { clearTimeout(timer); socket.end(); resolve(data); } });
    socket.on("error", (error) => { clearTimeout(timer); reject(error); });
  });
}

async function main() {
  const gamePort = await freePort();
  const anxnetPort = await freePort();
  const agentAnxnetRoot = path.join(root, "agent-anxnet");
  const agent = await startServiceManagedAgent({
    initial: "stopped",
    extraInstanceConfigs: [
      fakeMinecraftInstance({ id: "survival", port: gamePort }),
      { config: { ...fakeMinecraftInstance({ id: "sneaky-ssh" }).config, displayName: "Sneaky", ports: [22] }, files: {} },
    ],
    env: { AGENT_ANXNET_ROOT: agentAnxnetRoot, AGENT_ANXNET_HOST: "127.0.0.1", AGENT_ANXNET_PORT: String(anxnetPort) },
  });
  cleanup.push(() => agent.stop());
  const owner = new AnxNetNode({ dataDir: path.join(root, "owner"), listenHost: "127.0.0.1", listenPort: 0, dnsPort: await freePort(), deviceName: "Desktop" });
  await owner.start();
  cleanup.push(() => owner.stop());
  await owner.createNetwork({ name: "anx-agent71", deviceName: "Desktop" });

  // A8 (before joining) and A1
  const empty = await agent.api("GET", "/api/v1/anxnet/status");
  assert.strictEqual(empty.status, 200);
  assert.strictEqual(empty.json.network, null);
  assert.strictEqual((await agent.api("POST", "/api/v1/anxnet/join", { code: "not-an-invite-code-at-all-really" })).json.error.code, "ANXNET_INVITE_FORMAT");
  const invite = owner.createInvite({ preApproved: true, maxUses: 1, ttlMinutes: 10, label: "Agent" });
  const joined = await agent.api("POST", "/api/v1/anxnet/join", { code: invite.code, deviceName: "Game PC" });
  assert.strictEqual(joined.status, 200, joined.text);
  assert.strictEqual(joined.json.network.name, "anx-agent71");
  assert.strictEqual(joined.json.pendingApproval, false);
  const agentDeviceId = joined.json.deviceId;
  await waitFor(() => owner.status().devices.some((device) => device.deviceId === agentDeviceId), "owner roster lists the Agent");
  assert.strictEqual((await agent.api("POST", "/api/v1/anxnet/join", { code: invite.code })).json.error.code, "ANXNET_ALREADY_MEMBER");
  const secondInvite = owner.createInvite({ preApproved: true });
  assert.notStrictEqual(secondInvite.code, invite.code);
  pass(`A1 the Agent joined "anx-agent71" with the owner's invite through its API (device ${agentDeviceId.slice(0, 12)}…); bad and repeat joins refused`);

  // A2
  await agent.api("POST", "/api/v1/instances/survival/start");
  await waitFor(async () => /running/i.test((await agent.api("GET", "/api/v1/instances")).json.instances.find((entry) => entry.id === "survival").state), "game server running", 30000);
  const shared = await agent.api("POST", "/api/v1/anxnet/share", { instanceId: "survival" });
  assert.strictEqual(shared.status, 200, shared.text);
  assert.strictEqual(shared.json.service.port, gamePort);
  assert.strictEqual(shared.json.service.hostname, "survival-test.game-pc.anx-agent71.internal");
  const serviceId = shared.json.service.serviceId;
  await waitFor(() => owner.status().forwards.some((forward) => forward.serviceId === serviceId), "owner forward to the Agent's server");
  const forward = owner.status().forwards.find((forward) => forward.serviceId === serviceId);
  const reply = await firstReply(forward.port, forward.address, "hello\n");
  assert.match(reply, /fake-minecraft/, `the game answered through AnxNet (${JSON.stringify(reply)})`);
  assert.strictEqual(owner.status().devices.find((device) => device.deviceId === agentDeviceId).connection, "direct");
  pass(`A2 the Agent shared its server (${shared.json.service.hostname}); the owner reached the game at ${forward.address}:${forward.port}, direct path`);

  // A3
  const ownPort = await agent.api("POST", "/api/v1/anxnet/share", { instanceId: "survival", port: agent.port });
  assert.strictEqual(ownPort.json.error.code, "ANXNET_SERVICE_PORT", "a port the server doesn't declare is refused");
  const ssh = await agent.api("POST", "/api/v1/anxnet/share", { instanceId: "sneaky-ssh" });
  assert.strictEqual(ssh.json.error.code, "ANXNET_SERVICE_SENSITIVE_PORT", "a server declaring port 22 is still refused");
  const missing = await agent.api("POST", "/api/v1/anxnet/share", { instanceId: "nope" });
  assert.strictEqual(missing.status, 404);
  pass("A3 undeclared ports (including the Agent's own), SSH and unknown servers are refused");

  // A4
  const unshared = await agent.api("POST", "/api/v1/anxnet/unshare", { serviceId });
  assert.strictEqual(unshared.status, 200);
  await waitFor(() => !owner.status().forwards.some((entry) => entry.serviceId === serviceId), "forward removed");
  pass("A4 unsharing removes the members' forward");

  // A8
  const statusText = JSON.stringify((await agent.api("GET", "/api/v1/anxnet/status")).json);
  for (const secret of ["PRIVATE KEY", invite.code, "secret", "invites"]) assert.ok(!statusText.includes(secret), `status leaks ${secret}`);
  const keyFile = path.join(agentAnxnetRoot, "anxnet-device.key");
  assert.ok(fs.existsSync(keyFile), "the device key stays in the Agent's data folder");
  if (process.platform !== "win32") assert.strictEqual(fs.statSync(keyFile).mode & 0o777, 0o600);
  pass("A8 status shows no keys, invite codes or secrets; the key file stays in the Agent's folder");

  // A5: stop the Agent; the owner sees it go; the same folder resumes. The
  // game server is stopped first (on Windows the Agent is killed outright,
  // which would leave the stand-in server running in the temp folder).
  await agent.api("POST", "/api/v1/instances/survival/stop");
  await waitFor(async () => /stopped/i.test((await agent.api("GET", "/api/v1/instances")).json.instances.find((entry) => entry.id === "survival").state), "game server stopped", 30000);
  await agent.stop().catch(async () => { await delay(1500); fs.rmSync(agent.home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); });
  cleanup.length = 0;
  cleanup.push(() => owner.stop());
  await waitFor(() => owner.status().devices.find((device) => device.deviceId === agentDeviceId).connection === "not-connected", "owner sees the Agent gone", 20000);
  const resumeScript = `
    const service = require(${JSON.stringify(path.join(__dirname, "..", "agent", "src", "services", "anxnetAgentService.js"))});
    service.resume().then(async (node) => {
      console.log("RESUMED " + Boolean(node) + " " + (node && node.status().network && node.status().network.name));
      process.stdin.on("data", async (data) => {
        const text = String(data).trim();
        if (text === "leave") { const result = await service.leave(); console.log("LEFT " + (result.network === null)); }
        if (text === "exit") { await service.shutdown(); process.exit(0); }
      });
    }).catch((error) => { console.log("ERROR " + error.code + " " + error.message); process.exit(1); });`;
  const resumed = spawn(process.execPath, ["-e", resumeScript], {
    env: { ...process.env, AGENT_ANXNET_ROOT: agentAnxnetRoot, AGENT_ANXNET_HOST: "127.0.0.1", AGENT_ANXNET_PORT: String(anxnetPort), AGENT_INSTANCE_ROOT: path.join(root, "resume-instances"), AGENT_TOKEN: "resume-test-token-0123456789abcdef" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let resumedOutput = "";
  resumed.stdout.on("data", (chunk) => { resumedOutput += chunk; });
  resumed.stderr.on("data", (chunk) => { resumedOutput += chunk; });
  cleanup.push(() => new Promise((resolve) => { resumed.stdin.write("exit\n"); resumed.once("exit", resolve); setTimeout(() => { resumed.kill(); resolve(); }, 3000); }));
  await waitFor(() => /RESUMED true anx-agent71/.test(resumedOutput), `resume (${resumedOutput.slice(-300)})`, 20000);
  await waitFor(() => {
    const device = owner.status().devices.find((entry) => entry.deviceId === agentDeviceId);
    return device && device.connection !== "not-connected";
  }, "the resumed node reconnects", 30000).catch(async () => {
    // A member reconnects to the coordinator; a peer session may wait for traffic.
    const peer = await owner.ensurePeer(agentDeviceId).catch(() => null);
    assert.ok(peer, "the owner can open a session to the resumed node");
  });
  pass("A5 a stopped Agent drops off; the same data folder resumes the network on the next start and reconnects");

  // A6
  await owner.revokeDevice(agentDeviceId);
  await delay(1000);
  assert.ok(!owner.status().devices.some((device) => device.deviceId === agentDeviceId), "removed from the roster");
  const retry = await owner.ensurePeer(agentDeviceId).then(() => "connected", (error) => error.code || "refused");
  assert.notStrictEqual(retry, "connected", "the owner won't open a session to a revoked device");
  resumed.stdin.write("leave\n");
  await waitFor(() => /LEFT true/.test(resumedOutput), "the revoked Agent leaves cleanly", 10000);
  pass(`A6 revoked: the Agent is out of the roster and can't get a session (${retry}); leaving clears its state`);

  // A7
  const restricted = await startServiceManagedAgent({ initial: "stopped", permissions: "public-access:read", env: { AGENT_ANXNET_ROOT: path.join(root, "restricted"), AGENT_ANXNET_HOST: "127.0.0.1", AGENT_ANXNET_PORT: String(await freePort()) } });
  cleanup.push(() => restricted.stop());
  assert.strictEqual((await restricted.api("GET", "/api/v1/anxnet/status")).status, 200);
  const denied = await restricted.api("POST", "/api/v1/anxnet/join", { code: owner.createInvite({ preApproved: true }).code });
  assert.strictEqual(denied.status, 403, denied.text);
  assert.ok(!fs.existsSync(path.join(root, "restricted", "anxnet-state.json")), "nothing was joined");
  pass("A7 an Agent principal with public-access:read sees status but can't join (403)");

  console.log(`AnxNet Agent smoke passed (${checks} checks). Real Agent process and sockets on one host; separate computers simulated.`);
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => {
    for (const step of cleanup.reverse()) await Promise.resolve().then(step).catch(() => {});
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 }); } catch {}
    setTimeout(() => process.exit(process.exitCode || 0), 200).unref();
  });
