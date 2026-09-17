#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// V2-G Wave 1 node lifecycle smoke (hermetic): pins every runtime root, then
// exercises the desktop-driven node lifecycle against fake Agent HTTP servers
// — best-effort enrollment revocation on delete (success, refused, and
// timeout paths), node group persistence/validation, manual disconnect without
// deleting the record, reconnect restore, and delete-after-revoke cleanup.

const repoRoot = path.resolve(__dirname, "..");
const indexSource = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8");
const appSource = fs.readFileSync(path.join(repoRoot, "app.js"), "utf8");
const preloadSource = fs.readFileSync(path.join(repoRoot, "preload.js"), "utf8");

// Renderer surface: the group filter, group field, and disconnect/reconnect
// actions must be wired end to end (toolbar -> renderer -> preload -> IPC).
[
  '<select data-node-group-filter aria-label="Filter nodes by group">',
  'data-node-field="group"',
].forEach((needle) => assert(indexSource.includes(needle), `Nodes page UI should include ${needle}`));

[
  "function syncNodeGroupFilterOptions",
  "function nodeMatchesGroupFilter",
  "async function disconnectNodeById",
  "async function reconnectNodeById",
  "function getNodeDeleteToast",
  "remote revocation failed",
  'nodeActions.splice(2, 0, node.manualDisconnect === true ? ["reconnect", "Reconnect"] : ["disconnect", "Disconnect"]);',
].forEach((needle) => assert(appSource.includes(needle), `Renderer node lifecycle should include ${needle}`));

assert(preloadSource.includes('disconnect: (nodeId) => ipcRenderer.invoke("nodes:disconnect", { nodeId })'), "preload should expose nodes:disconnect");
assert(preloadSource.includes('reconnect: (nodeId) => ipcRenderer.invoke("nodes:reconnect", { nodeId })'), "preload should expose nodes:reconnect");

// Pin runtime roots BEFORE requiring any src/ service module.
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
pinAgentRoots("anx-node-lifecycle-roots-");

const nodeService = require("../src/services/nodeService");
const { getNodeToken } = require("../src/services/nodeCredentialStore");

function readNodesJson() {
  return JSON.parse(fs.readFileSync(nodeService.getNodesPath(), "utf8"));
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve())).catch(() => {});
}

// Fake Agent: health/stats authenticate with the shared bearer token, and
// /api/v1/enroll/revoke mirrors the real agent contract (bearer + explicit
// confirmRevoke, owner-permission gated) with switchable behavior so the
// best-effort delete semantics can be exercised without a live agent.
function createFakeAgent({ token, deviceId, revokeBehavior = "success" }) {
  const state = { healthRequests: 0, statsRequests: 0, revokeRequests: [] };
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const bodyText = Buffer.concat(chunks).toString("utf8");
      const respond = (status, payload) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      const bearer = request.headers.authorization || "";
      if (request.url === "/api/v1/health" && request.method === "GET") {
        state.healthRequests += 1;
        if (bearer !== `Bearer ${token}`) return respond(401, { error: { code: "UNAUTHORIZED" } });
        return respond(200, {
          ok: true,
          apiVersion: "1",
          protocolVersion: 1,
          identity: { deviceId, hostname: "Lifecycle Node", platform: "linux", agentVersion: "1.7.0" },
        });
      }
      if (request.url === "/api/v1/stats" && request.method === "GET") {
        state.statsRequests += 1;
        if (bearer !== `Bearer ${token}`) return respond(401, { error: { code: "UNAUTHORIZED" } });
        return respond(200, { ok: true });
      }
      if (request.url === "/api/v1/enroll/revoke" && request.method === "POST") {
        let parsedBody = {};
        try { parsedBody = JSON.parse(bodyText || "{}"); } catch {}
        if (bearer !== `Bearer ${token}`) return respond(401, { error: { code: "UNAUTHORIZED" } });
        state.revokeRequests.push({
          authorization: bearer,
          confirmRevoke: parsedBody.confirmRevoke,
          reason: parsedBody.reason,
        });
        if (revokeBehavior === "refuse") {
          return respond(403, { error: { code: "API_PERMISSION_DENIED", message: "This Agent credential is not allowed to access the requested API capability." } });
        }
        if (revokeBehavior === "hang") {
          return; // never respond; exercises the revocation timeout path
        }
        return respond(200, {
          state: "revoked",
          enrollmentId: `enr-${deviceId}`,
          revokedAtIso: new Date().toISOString(),
          reEnrollRequired: true,
        });
      }
      respond(404, { error: { code: "NOT_FOUND" } });
    });
  });
  return { server, state };
}

async function main() {
  const successAgent = createFakeAgent({ token: "a-token", deviceId: "lifecycle-node-a" });
  const refusedAgent = createFakeAgent({ token: "b-token", deviceId: "lifecycle-node-b", revokeBehavior: "refuse" });
  const hangingAgent = createFakeAgent({ token: "c-token", deviceId: "lifecycle-node-c", revokeBehavior: "hang" });
  const portA = await listen(successAgent.server);
  const portB = await listen(refusedAgent.server);
  const portC = await listen(hangingAgent.server);
  const urlA = `http://127.0.0.1:${portA}`;
  const urlB = `http://127.0.0.1:${portB}`;
  const urlC = `http://127.0.0.1:${portC}`;

  try {
    // --- 1. Group persistence and validation ---
    const created = await nodeService.saveNode({
      displayName: "Lifecycle A",
      agentUrl: urlA,
      agentToken: "a-token",
      group: "  Lab A  ",
    });
    const nodeA = created.node;
    assert.strictEqual(nodeA.id, "agent-lifecycle-node-a", "node id should derive from the agent deviceId");
    assert.strictEqual(nodeA.group, "Lab A", "group must be trimmed when saved");

    const persistedA = readNodesJson().nodes.find((entry) => entry.id === nodeA.id);
    assert.strictEqual(persistedA.group, "Lab A", "group must round-trip through nodes.json");

    const relisted = await nodeService.listNodes({ discoverLocalAgent: false, refreshIdentity: false });
    assert.strictEqual(relisted.nodes.find((node) => node.id === nodeA.id).group, "Lab A", "group must survive listNodes");

    await assert.rejects(
      () => nodeService.saveNode({ id: nodeA.id, displayName: "Lifecycle A", agentUrl: urlA, group: "x".repeat(41) }),
      (error) => error?.code === "INVALID_NODE_GROUP",
      "groups over 40 characters must be refused",
    );

    const cleared = await nodeService.saveNode({ id: nodeA.id, displayName: "Lifecycle A", agentUrl: urlA, group: "" });
    assert.strictEqual(cleared.node.group, "", "an empty group must be allowed and clear the label");
    const regrouped = await nodeService.saveNode({ id: nodeA.id, displayName: "Lifecycle A", agentUrl: urlA, group: "  Rack 4  " });
    assert.strictEqual(regrouped.node.group, "Rack 4", "group labels are stored trimmed");

    // --- 2. Disconnect clears runtime state without deleting the record ---
    const healthRequestsBeforeDisconnect = successAgent.state.healthRequests;
    const disconnectResult = nodeService.disconnectNode(nodeA.id);
    assert.strictEqual(disconnectResult.disconnected, true, "disconnect should confirm the node was disconnected");

    const afterDisconnect = nodeService.getNode(nodeA.id);
    assert.strictEqual(afterDisconnect.manualDisconnect, true, "disconnect must persist the manual-disconnect flag");
    assert.strictEqual(afterDisconnect.connection?.connected, false, "disconnect must clear the connected state");
    assert.strictEqual(afterDisconnect.connection?.status, "offline", "disconnect must mark the node offline");
    assert.match(afterDisconnect.connection?.message || "", /Disconnected from AnxOS by the owner/, "disconnect must record an owner disconnect message");
    assert.strictEqual(getNodeToken(nodeA.id), "a-token", "disconnect must not delete the node credential");

    const disconnectedHealth = await nodeService.checkNodeHealth(nodeA.id);
    assert.strictEqual(disconnectedHealth.state, "offline", "health checks must report a manually disconnected node offline");
    assert.strictEqual(successAgent.state.healthRequests, healthRequestsBeforeDisconnect, "health checks must not probe the Agent while manually disconnected");
    assert.strictEqual(disconnectedHealth.connected, false, "a manually disconnected node is not connected");

    const listedAfterDisconnect = await nodeService.listNodes({ discoverLocalAgent: false, refreshIdentity: false });
    assert(listedAfterDisconnect.nodes.some((node) => node.id === nodeA.id), "disconnect must not delete the node record");
    assert.strictEqual(listedAfterDisconnect.nodes.find((node) => node.id === nodeA.id).manualDisconnect, true, "manual disconnect must survive listNodes");

    // --- 3. Reconnect restores polling and online state ---
    const reconnectResult = await nodeService.reconnectNode(nodeA.id);
    assert.strictEqual(reconnectResult.state, "online", "reconnect must resume health checks and restore online state");
    assert(successAgent.state.healthRequests > healthRequestsBeforeDisconnect, "reconnect must probe the Agent again");
    const afterReconnect = nodeService.getNode(nodeA.id);
    assert.strictEqual(afterReconnect.manualDisconnect, false, "reconnect must clear the manual-disconnect flag");
    assert.strictEqual(afterReconnect.connection?.connected, true, "reconnect must restore the connected state");

    // --- 4. Delete revokes the Agent enrollment first (success path) ---
    const deleteA = await nodeService.deleteNode(nodeA.id, { timeoutMs: 2000 });
    assert.strictEqual(deleteA.deleted, true, "delete should confirm local deletion");
    assert.strictEqual(deleteA.revocation?.attempted, true, "revocation must be attempted when the node has an Agent URL");
    assert.strictEqual(deleteA.revocation.revoked, true, "revocation against a permissive Agent must succeed");
    assert.strictEqual(successAgent.state.revokeRequests.length, 1, "exactly one revocation request must be sent");
    assert.strictEqual(successAgent.state.revokeRequests[0].authorization, "Bearer a-token", "revocation must authenticate with the node's own Agent token");
    assert.strictEqual(successAgent.state.revokeRequests[0].confirmRevoke, true, "revocation must send explicit confirmRevoke");
    assert.strictEqual(successAgent.state.revokeRequests[0].reason, "removed-from-control-center", "revocation must carry a reason");

    const afterDeleteA = readNodesJson();
    assert(afterDeleteA.nodes.every((node) => node.id !== nodeA.id), "deleted node must be removed from the registry");
    assert.strictEqual(getNodeToken(nodeA.id), "", "deleting a node must delete its stored credential");

    // --- 5. Revocation refusal is best-effort: delete proceeds, failure surfaced ---
    const createdB = await nodeService.saveNode({ displayName: "Lifecycle B", agentUrl: urlB, agentToken: "b-token" });
    const nodeB = createdB.node;
    const deleteB = await nodeService.deleteNode(nodeB.id, { timeoutMs: 2000 });
    assert.strictEqual(deleteB.deleted, true, "a refused revocation must still delete the node locally");
    assert.strictEqual(deleteB.revocation.revoked, false, "a refused revocation must not be reported as revoked");
    assert.strictEqual(deleteB.revocation.code, "API_PERMISSION_DENIED", "the refusal code must be surfaced");
    assert(typeof deleteB.revocation.reason === "string" && deleteB.revocation.reason.length > 0, "the refusal reason must be surfaced");
    const afterDeleteB = readNodesJson();
    assert(afterDeleteB.nodes.every((node) => node.id !== nodeB.id), "a refused revocation must still remove the local record");

    // --- 6. Revocation timeout is best-effort with a bounded wait ---
    const createdC = await nodeService.saveNode({ displayName: "Lifecycle C", agentUrl: urlC, agentToken: "c-token" });
    const nodeC = createdC.node;
    const deleteC = await nodeService.deleteNode(nodeC.id, { timeoutMs: 1000 });
    assert.strictEqual(deleteC.deleted, true, "a timed-out revocation must still delete the node locally");
    assert.strictEqual(deleteC.revocation.revoked, false, "a timed-out revocation must not be reported as revoked");
    assert.strictEqual(deleteC.revocation.code, "AGENT_TIMEOUT", "a timed-out revocation must be reported as a timeout");

    // --- 7. Delete-after-revoke removes everything ---
    const finalState = readNodesJson();
    for (const nodeId of [nodeA.id, nodeB.id, nodeC.id]) {
      assert(finalState.nodes.every((node) => node.id !== nodeId), `deleted node ${nodeId} must be gone from the registry`);
      assert.strictEqual(getNodeToken(nodeId), "", `credential for ${nodeId} must be removed from the protected store`);
    }
    assert.strictEqual(refusedAgent.state.revokeRequests.length, 1, "the refusing agent must have received exactly one revocation attempt");
    assert.strictEqual(hangingAgent.state.revokeRequests.length, 1, "the hanging agent must have received exactly one revocation attempt");

    console.log("node-lifecycle-smoke passed");
  } finally {
    for (const agent of [successAgent, refusedAgent, hangingAgent]) {
      if (typeof agent.server.closeAllConnections === "function") agent.server.closeAllConnections();
      await close(agent.server);
    }
  }
}

main().catch((error) => {
  console.error("node-lifecycle-smoke FAILED:", error);
  process.exitCode = 1;
});
