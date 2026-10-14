"use strict";

// AIM-1 inventory <-> REAL Agent HTTP server (Build 206 service-managed fixture).
// Only systemd is replaced (a state file the fixture controls); the Agent
// process, its HTTP API and auth, the desktop nodeService registry,
// agentClient.requestJson and the inventory service are production code.
//
// Proves across the real client/server boundary:
//   - the service-managed instance is discovered with a verified host/unit
//     identity, systemd ownership and health from systemd state;
//   - discovery issues ZERO systemd control calls, spawns nothing but the
//     Agent's own background helpers, and never rewrites the instance record;
//   - a node registered for a different device is refused (identity mismatch);
//   - a node with a rejected token degrades per section (permission boundary);
//   - an unreachable node is reported unavailable and its prior resources stale;
//   - a systemd restart (new MainPID) keeps the same inventory identity.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-aim1-agent-"));
process.env.ANXHUB_CONFIG_DIR = path.join(temp, "config");
fs.mkdirSync(process.env.ANXHUB_CONFIG_DIR, { recursive: true });

const { startServiceManagedAgent } = require("./test-helpers/service-managed-agent-fixture");

function writeJson(name, value) {
  fs.writeFileSync(path.join(process.env.ANXHUB_CONFIG_DIR, name), `${JSON.stringify(value, null, 2)}\n`);
}

function closedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function main() {
  const agent = await startServiceManagedAgent({ initial: "running" });
  const deadPort = await closedPort();
  try {
    const health = (await agent.api("GET", "/api/v1/health")).json;
    const deviceId = health?.identity?.deviceId;
    assert.ok(deviceId, "fixture Agent reports a deviceId");

    const node = (id, extra) => ({ id, kind: "agent", name: id, displayName: id, enabled: true, connection: { status: "online" }, ...extra });
    writeJson("agent.json", { backendMode: "agent", agentUrl: "http://127.0.0.1:9", agentToken: "legacy-token-must-not-be-used" });
    writeJson("nodes.json", {
      schemaVersion: 2,
      selectedNodeId: "ovh",
      nodes: [
        node("ovh", { baseUrl: agent.url, agentUrl: agent.url, agentIdentity: { deviceId } }),
        node("impostor", { baseUrl: agent.url, agentUrl: agent.url, agentIdentity: { deviceId: "some-other-device" } }),
        node("gone", { baseUrl: `http://127.0.0.1:${deadPort}`, agentUrl: `http://127.0.0.1:${deadPort}`, agentIdentity: { deviceId: "gone-device" } }),
      ],
    });
    writeJson("node-agent-credentials.json", {
      schemaVersion: 1,
      nodes: {
        ovh: { agentToken: agent.token },
        impostor: { agentToken: agent.token },
        gone: { agentToken: agent.token },
      },
    });

    const inventory = require("../src/services/infrastructureInventoryService");
    inventory.resetInfrastructureInventory();
    inventory.configureInfrastructureInventory({ storePath: path.join(temp, "inventory.json") });

    const recordSha = agent.recordSha();
    agent.clearRecords();

    let snapshot = await inventory.refreshInventory({ force: true });
    const nodes = Object.fromEntries(snapshot.nodes.map((entry) => [entry.nodeId, entry]));

    // --- the real node is collected with a verified identity ------------------
    assert.strictEqual(nodes.ovh.status, "collected", JSON.stringify(nodes.ovh));
    assert.strictEqual(nodes.ovh.hostVerified, true);
    const ovhResources = snapshot.resources.filter((resource) => (resource.nodeIds || []).includes("ovh"));
    const host = ovhResources.find((resource) => resource.kind === "host");
    assert.ok(host && host.identity.verified, "host identity verified from the real Agent");
    assert.strictEqual(host.identity.components.deviceId, deviceId);
    assert.ok(host.capabilities.serviceManagedInstances, "Build 206 serviceManagedInstances capability recorded");
    assert.strictEqual(host.capabilities.supportsServiceControl, false);

    const svc = ovhResources.find((resource) => resource.kind === "service-managed-instance");
    assert.ok(svc, "service-managed instance discovered");
    assert.strictEqual(svc.identity.verified, true);
    assert.strictEqual(svc.identity.components.instanceId, agent.instanceId);
    assert.strictEqual(svc.identity.components.unit, agent.unit);
    assert.strictEqual(svc.ownership.owner, "systemd");
    assert.strictEqual(svc.health.state, "healthy");
    assert.strictEqual(svc.protection.scope, "production");
    const firstMainPid = svc.details.externalMainPid;

    // --- identity mismatch, permission boundary, unreachable node --------------
    assert.strictEqual(nodes.impostor.status, "unavailable");
    assert.strictEqual(nodes.impostor.code, "AGENT_IDENTITY_MISMATCH");
    assert.ok(!snapshot.resources.some((resource) => (resource.nodeIds || []).includes("impostor")), "nothing attributed to the impostor node");

    assert.strictEqual(nodes.gone.status, "unavailable");
    assert.strictEqual(nodes.gone.code, "NODE_UNREACHABLE", JSON.stringify(nodes.gone));

    assert.strictEqual(snapshot.resources.filter((resource) => resource.kind === "host").length, 1);

    // --- discovery changed nothing -------------------------------------------
    assert.deepStrictEqual(agent.controlCalls(), [], "inventory must never issue a systemd control call");
    assert.deepStrictEqual(agent.spawnAttempts(), [], "inventory must not make the Agent spawn anything");
    assert.strictEqual(agent.recordSha(), recordSha, "instance record unchanged");

    // --- a systemd restart (new MainPID) keeps the identity -------------------
    agent.patchState({ unit: { ...agent.state().unit, mainPid: (firstMainPid || 4242) + 1000, activeEnterTimestampMs: Date.now() } });
    snapshot = await inventory.refreshInventory({ force: true });
    const svcAfter = snapshot.resources.find((resource) => resource.kind === "service-managed-instance");
    assert.strictEqual(svcAfter.key, svc.key);
    assert.strictEqual(svcAfter.firstSeen, svc.firstSeen);
    assert.notStrictEqual(svcAfter.details.externalMainPid, firstMainPid);

    // --- permission boundary: the node's stored token is rejected ---------------
    // Health is public, so the host is still identified; every authenticated
    // section must fail as AUTH_FAILED, never as an empty list.
    // The credential store migrates its file on first read and refuses a
    // hand-edited legacy file, and agentClient re-resolves any config carrying
    // a nodeId from the canonical registry (so a token cannot be swapped in
    // that way). The rejected token is therefore sent with a URL-only config;
    // the real agentClient and the real Agent decide.
    const wrongToken = "anxos_wrong-token-for-inventory-smoke-0000000000";
    inventory.configureInfrastructureInventory({ agentConfigFor: () => ({ backendMode: "agent", agentUrl: agent.url, agentToken: wrongToken }) });
    snapshot = await inventory.refreshInventory({ force: true });
    inventory.configureInfrastructureInventory({ agentConfigFor: null });
    const rejected = snapshot.nodes.find((entry) => entry.nodeId === "ovh");
    assert.strictEqual(rejected.status, "collected", JSON.stringify(rejected));
    const sections = Object.fromEntries(rejected.sections.map((section) => [section.name, section]));
    assert.strictEqual(sections.instances.code, "AUTH_FAILED", JSON.stringify(sections.instances));
    assert.strictEqual(sections.system.code, "AUTH_FAILED");
    assert.strictEqual(sections.listeners.code, "AUTH_FAILED");
    // A rejected read is not evidence of deletion: the last-known instance is
    // kept, marked stale with the section's reason.
    const kept = snapshot.resources.find((resource) => resource.kind === "service-managed-instance" && resource.key === svc.key);
    assert.ok(kept, "service-managed instance retained after an unauthorized read");
    assert.strictEqual(kept.stale, true);
    assert.strictEqual(kept.staleReason, "AUTH_FAILED");
    assert.deepStrictEqual(agent.controlCalls(), [], "still no control calls");

    // --- the Agent stops: resources become stale, never deleted ----------------
    await agent.stop();
    snapshot = await inventory.refreshInventory({ force: true });
    const stale = snapshot.resources.filter((resource) => (resource.nodeIds || []).includes("ovh"));
    assert.ok(stale.length > 0 && stale.every((resource) => resource.stale === true), "offline Agent keeps last-known resources as stale");
    assert.strictEqual(snapshot.nodes.find((entry) => entry.nodeId === "ovh").code, "NODE_UNREACHABLE");

    const persisted = fs.readFileSync(path.join(temp, "inventory.json"), "utf8");
    assert.ok(!persisted.includes(agent.token), "Agent token never persisted");
    console.log(`infra inventory agent smoke passed (${stale.length} resources from the real Agent)`);
  } finally {
    await agent.stop();
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
