#!/usr/bin/env node
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

// V2-G Wave 2 fleet aggregation smoke (hermetic): pins every runtime root, then
// exercises the desktop-side fleet roll-up and controlled cross-node batch
// actions against fake Agent HTTP servers — summary shape and totals for
// online/offline/disconnected fixture nodes, bounded concurrency (max 3, proven
// with a counting executor and with a real five-node batch), honest per-node
// partial failures, the destructive stop confirmation, and per-target binding
// (wrong-node and application-host guards).

const repoRoot = path.resolve(__dirname, "..");
// Sources may carry CRLF terminators on Windows checkouts; normalize so the
// wiring needles below match either form.
const indexSource = fs.readFileSync(path.join(repoRoot, "index.html"), "utf8").replace(/\r\n/g, "\n");
const appSource = fs.readFileSync(path.join(repoRoot, "app.js"), "utf8").replace(/\r\n/g, "\n");
const preloadSource = fs.readFileSync(path.join(repoRoot, "preload.js"), "utf8").replace(/\r\n/g, "\n");

// Renderer surface: fleet panel, per-node fleet rows, and batch start/stop
// controls wired end to end (toolbar -> renderer -> preload -> IPC).
[
  '<button class="inline-action" type="button" data-fleet-action="start" title="Reconnect the filtered nodes">Start Nodes</button>',
  'data-fleet-action="stop"',
  'data-fleet-panel',
  'data-fleet-rows',
  'data-fleet-action="refresh"',
].forEach((needle) => assert(indexSource.includes(needle), `Nodes page fleet UI should include ${needle}`));

[
  "function renderFleetSummary",
  "function refreshFleetSummary",
  "function getFleetTargetNodes",
  "async function runFleetBatchActionFromUi",
  'if (action === "stop" && !(await confirmDestructiveAction({',
  "    refreshNodes();\n    refreshFleetSummary();\n    startNodeRefreshPolling();",
].forEach((needle) => assert(appSource.includes(needle), `Renderer fleet aggregation should include ${needle}`));

[
  'fleetSummary: () => ipcRenderer.invoke("nodes:fleetSummary")',
  'fleetBatch: (payload = {}) => ipcRenderer.invoke("nodes:fleetBatch", payload)',
].forEach((needle) => assert(preloadSource.includes(needle), `preload should expose ${needle.split(" => ")[0]}`));

// Pin runtime roots BEFORE requiring any src/ service module.
const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");
const smokeRoot = pinAgentRoots("anx-fleet-aggregation-roots-");

const nodeService = require("../src/services/nodeService");
const {
  FLEET_BATCH_MAX_TARGETS,
  FLEET_CONCURRENCY_LIMIT,
  getFleetSummary,
  runFleetBatchAction,
  runWithConcurrency,
} = require("../src/services/fleetService");

assert.strictEqual(FLEET_CONCURRENCY_LIMIT, 3, "fleet fan-out must be bounded at 3 concurrent operations");

function findFreePort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
}

// Shared tracker proving the production fan-out never exceeds the bound.
const healthConcurrency = { inFlight: 0, max: 0 };
function resetHealthConcurrency() {
  healthConcurrency.inFlight = 0;
  healthConcurrency.max = 0;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

async function close(server) {
  if (typeof server.closeAllConnections === "function") server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve())).catch(() => {});
}

// Fake Agent mirroring the real read surface the fleet service uses:
// /api/v1/health (identity + compatibility), /api/v1/stats (authenticated
// probe), /api/v1/instances and /api/v1/jobs (read-only inventory counts).
function createFakeAgent({ token, deviceId, healthDelayMs = 0 }) {
  const state = { healthRequests: 0, statsRequests: 0, instancesRequests: 0, jobsRequests: 0 };
  const server = http.createServer((request, response) => {
    const respond = (status, payload) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    };
    const authorized = (request.headers.authorization || "") === `Bearer ${token}`;
    if (request.url === "/api/v1/health" && request.method === "GET") {
      state.healthRequests += 1;
      if (!authorized) return respond(401, { error: { code: "UNAUTHORIZED" } });
      if (healthDelayMs > 0) {
        healthConcurrency.inFlight += 1;
        healthConcurrency.max = Math.max(healthConcurrency.max, healthConcurrency.inFlight);
        return setTimeout(() => {
          healthConcurrency.inFlight -= 1;
          respond(200, {
            ok: true,
            apiVersion: "1",
            protocolVersion: 1,
            identity: { deviceId, hostname: `${deviceId}-host`, platform: "linux", agentVersion: "1.7.0" },
          });
        }, healthDelayMs);
      }
      return respond(200, {
        ok: true,
        apiVersion: "1",
        protocolVersion: 1,
        identity: { deviceId, hostname: `${deviceId}-host`, platform: "linux", agentVersion: "1.7.0" },
      });
    }
    if (request.url === "/api/v1/stats" && request.method === "GET") {
      state.statsRequests += 1;
      if (!authorized) return respond(401, { error: { code: "UNAUTHORIZED" } });
      return respond(200, { ok: true });
    }
    if (request.url === "/api/v1/instances" && request.method === "GET") {
      state.instancesRequests += 1;
      if (!authorized) return respond(401, { error: { code: "UNAUTHORIZED" } });
      return respond(200, {
        root: `/srv/${deviceId}`,
        instances: [
          { id: "alpha", displayName: "Alpha", processRunning: true, state: "Running" },
          { id: "beta", displayName: "Beta", processRunning: true, state: "Starting" },
          { id: "gamma", displayName: "Gamma", processRunning: false, state: "Stopped" },
        ],
      });
    }
    const requestPath = new URL(request.url, "http://localhost").pathname;
    if (requestPath === "/api/v1/jobs" && request.method === "GET") {
      state.jobsRequests += 1;
      if (!authorized) return respond(401, { error: { code: "UNAUTHORIZED" } });
      return respond(200, {
        jobs: [
          { id: "job_a", state: "succeeded" },
          { id: "job_b", state: "failed" },
          { id: "job_c", state: "running" },
        ],
        total: 3,
      });
    }
    respond(404, { error: { code: "NOT_FOUND" } });
  });
  return { server, state };
}

async function main() {
  // Keep local-agent discovery away from any real Local Agent on this machine:
  // point the desktop's discovery port at a port the smoke verified as free so
  // node registration cannot pull an uncontrolled node into the fixture
  // registry.
  const discoveryPort = await findFreePort();
  fs.mkdirSync(path.join(smokeRoot, "config"), { recursive: true });
  fs.writeFileSync(
    path.join(smokeRoot, "config", "agent-runtime.json"),
    `${JSON.stringify({ schemaVersion: 1, port: discoveryPort }, null, 2)}\n`,
  );

  // --- 1. Bounded-concurrency runner: a counting executor proves max 3 -------
  {
    const counter = { inFlight: 0, max: 0 };
    const tasks = Array.from({ length: 10 }, (_, index) => async () => {
      counter.inFlight += 1;
      counter.max = Math.max(counter.max, counter.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      counter.inFlight -= 1;
      return index;
    });
    const results = await runWithConcurrency(tasks, 3);
    assert.strictEqual(results.length, 10, "the bounded runner must complete every task");
    assert.deepStrictEqual(results, Array.from({ length: 10 }, (_, index) => index), "the bounded runner must preserve task order");
    assert.strictEqual(counter.max, 3, `a counting executor must observe at most 3 concurrent tasks (observed ${counter.max})`);
  }

  // --- 2. Fixture fleet: online / offline / disconnected ---------------------
  const agentA = createFakeAgent({ token: "a-token", deviceId: "fleet-node-a", healthDelayMs: 150 });
  const agentD = createFakeAgent({ token: "d-token", deviceId: "fleet-node-d", healthDelayMs: 150 });
  const agentE = createFakeAgent({ token: "e-token", deviceId: "fleet-node-e", healthDelayMs: 150 });
  const agentF = createFakeAgent({ token: "f-token", deviceId: "fleet-node-f", healthDelayMs: 150 });
  const agentG = createFakeAgent({ token: "g-token", deviceId: "fleet-node-g", healthDelayMs: 150 });
  const agentC = createFakeAgent({ token: "c-token", deviceId: "fleet-node-c" });
  const portA = await listen(agentA.server);
  const portC = await listen(agentC.server);
  const portD = await listen(agentD.server);
  const portE = await listen(agentE.server);
  const portF = await listen(agentF.server);
  const portG = await listen(agentG.server);

  try {
    const nodeA = (await nodeService.saveNode({ displayName: "Fleet A", agentUrl: `http://127.0.0.1:${portA}`, agentToken: "a-token", group: "Lab" })).node;

    // Register the offline node while its endpoint still answers, then close
    // the server so the node becomes genuinely unreachable.
    const agentB = createFakeAgent({ token: "b-token", deviceId: "fleet-node-b" });
    const portB = await listen(agentB.server);
    const nodeB = (await nodeService.saveNode({ displayName: "Fleet B", agentUrl: `http://127.0.0.1:${portB}`, agentToken: "b-token", group: "Lab" })).node;
    await close(agentB.server);

    const nodeC = (await nodeService.saveNode({ displayName: "Fleet C", agentUrl: `http://127.0.0.1:${portC}`, agentToken: "c-token", group: "Rack 4" })).node;
    const disconnectC = nodeService.disconnectNode(nodeC.id);
    assert.strictEqual(disconnectC.disconnected, true, "fixture node C must be owner-disconnected");
    const cHealthRequestsBefore = agentC.state.healthRequests;

    // --- 3. Fleet summary shape and totals -----------------------------------
    const summary = await getFleetSummary();
    assert.strictEqual(summary.concurrencyLimit, 3, "the summary must report its concurrency bound");
    assert.strictEqual(typeof summary.checkedAt, "string", "the summary must be timestamped");
    assert.strictEqual(summary.nodes.length, 4, "the summary must cover the application host plus 3 fixture nodes");

    const hostEntry = summary.nodes.find((entry) => entry.kind === "application-host");
    assert(hostEntry, "the application host must appear as a fleet entry");
    assert.strictEqual(hostEntry.connection.status, "online", "the application host is the running desktop");
    assert.strictEqual(hostEntry.instances.available, false, "the application host has no fleet-managed Agent inventory");
    assert.strictEqual(hostEntry.instances.code, "APPLICATION_HOST_NOT_AGENT", "the application host inventory must be marked honestly");

    const entryA = summary.nodes.find((entry) => entry.nodeId === nodeA.id);
    assert.strictEqual(entryA.kind, "agent");
    assert.strictEqual(entryA.group, "Lab");
    assert.strictEqual(entryA.connection.status, "online", "the online fixture must report online after the health refresh");
    assert.strictEqual(entryA.instances.available, true, "live inventory must be read for a reachable node");
    assert.strictEqual(entryA.instances.instanceCount, 3, "instance count must come from the Agent's own inventory");
    assert.strictEqual(entryA.instances.runningInstanceCount, 2, "running count must be derived from processRunning");
    assert.strictEqual(entryA.jobs.available, true, "job outcome counts must be read for a reachable node");
    assert.deepStrictEqual(entryA.jobs.byState, { failed: 1, running: 1, succeeded: 1 }, "job outcome counts must be aggregated by state");
    assert.strictEqual(entryA.jobs.sampled, 3, "the job sample size must be reported");
    assert.strictEqual(entryA.jobs.total, 3, "the node's own job total must be reported");
    assert(agentA.state.instancesRequests >= 1, "the online fixture must have been queried for instances");
    assert(agentA.state.jobsRequests >= 1, "the online fixture must have been queried for job outcomes");

    const entryB = summary.nodes.find((entry) => entry.nodeId === nodeB.id);
    assert.strictEqual(entryB.connection.status, "offline", "the offline fixture must report offline");
    assert.strictEqual(entryB.instances.available, false, "an unreachable node must not invent inventory");
    assert.strictEqual(entryB.instances.code, "NODE_OFFLINE", "the offline code must be surfaced");
    assert.strictEqual(entryB.jobs.available, false, "an unreachable node must not invent job outcomes");

    const entryC = summary.nodes.find((entry) => entry.nodeId === nodeC.id);
    assert.strictEqual(entryC.connection.status, "offline", "the disconnected fixture must report offline");
    assert.strictEqual(entryC.connection.manualDisconnect, true, "the owner disconnect flag must be surfaced");
    assert.strictEqual(entryC.instances.available, false, "a disconnected node must not be probed for inventory");
    assert.strictEqual(entryC.instances.code, "NODE_DISCONNECTED", "the disconnected code must be surfaced");
    assert.strictEqual(agentC.state.healthRequests, cHealthRequestsBefore, "a manually disconnected node must not be probed at all");

    const totals = summary.totals;
    assert.strictEqual(totals.nodes, 4, "totals must count every fleet entry");
    assert.strictEqual(totals.agents, 3, "totals must count registered Agent nodes");
    assert.strictEqual(totals.applicationHosts, 1, "totals must count the application host");
    assert.strictEqual(totals.online, 2, "the application host and the online fixture are online");
    assert.strictEqual(totals.offline, 2, "the offline and disconnected fixtures are offline");
    assert.strictEqual(totals.manuallyDisconnected, 1, "owner disconnects must be counted");
    assert.strictEqual(totals.instanceCount, 3, "instance totals must only sum known inventory");
    assert.strictEqual(totals.runningInstanceCount, 2, "running totals must only sum known inventory");
    assert.strictEqual(totals.inventoryAvailableNodes, 1, "only reachable Agent nodes contribute inventory");
    assert.strictEqual(totals.inventoryUnavailableNodes, 3, "unavailable inventory nodes must be counted honestly");
    assert.deepStrictEqual(totals.jobs, { failed: 1, running: 1, succeeded: 1 }, "job outcome totals must sum only known records");
    assert.strictEqual(totals.jobsAvailableNodes, 1, "only reachable Agent nodes contribute job counts");
    assert.strictEqual(totals.jobsUnavailableNodes, 3, "unavailable job nodes must be counted honestly");

    // --- 4. Batch guards: action, targets, size, and destructive confirm ------
    await assert.rejects(
      () => runFleetBatchAction({ action: "restart", nodeIds: [nodeA.id] }),
      (error) => error?.code === "FLEET_BATCH_ACTION_INVALID",
      "unknown batch actions must be refused",
    );
    await assert.rejects(
      () => runFleetBatchAction({ action: "start" }),
      (error) => error?.code === "FLEET_BATCH_TARGETS_REQUIRED",
      "a batch with no targets must be refused",
    );
    await assert.rejects(
      () => runFleetBatchAction({ action: "start", nodeIds: Array.from({ length: FLEET_BATCH_MAX_TARGETS + 1 }, (_, index) => `agent-extra-${index}`) }),
      (error) => error?.code === "FLEET_BATCH_TOO_LARGE",
      "an oversized batch must be refused",
    );
    const manualDisconnectBefore = nodeService.getNode(nodeA.id).manualDisconnect;
    await assert.rejects(
      () => runFleetBatchAction({ action: "stop", nodeIds: [nodeA.id] }),
      (error) => error?.code === "FLEET_BATCH_CONFIRMATION_REQUIRED",
      "a destructive stop without explicit confirmation must be refused",
    );
    assert.strictEqual(nodeService.getNode(nodeA.id).manualDisconnect, manualDisconnectBefore, "a refused batch must not touch any node");

    // --- 5. Batch start: bounded concurrency proven on the production path ----
    const nodeD = (await nodeService.saveNode({ displayName: "Fleet D", agentUrl: `http://127.0.0.1:${portD}`, agentToken: "d-token" })).node;
    const nodeE = (await nodeService.saveNode({ displayName: "Fleet E", agentUrl: `http://127.0.0.1:${portE}`, agentToken: "e-token" })).node;
    const nodeF = (await nodeService.saveNode({ displayName: "Fleet F", agentUrl: `http://127.0.0.1:${portF}`, agentToken: "f-token" })).node;
    const nodeG = (await nodeService.saveNode({ displayName: "Fleet G", agentUrl: `http://127.0.0.1:${portG}`, agentToken: "g-token" })).node;
    resetHealthConcurrency();
    const startTargets = [nodeA.id, nodeD.id, nodeE.id, nodeF.id, nodeG.id];
    const startOutcome = await runFleetBatchAction({ action: "start", nodeIds: startTargets });
    assert.strictEqual(startOutcome.concurrencyLimit, 3, "batch actions must report their concurrency bound");
    assert.strictEqual(startOutcome.summary.total, 5, "every target must get a result record");
    assert.strictEqual(startOutcome.summary.succeeded, 5, "all reachable fixtures must start successfully");
    assert.strictEqual(startOutcome.summary.failed, 0, "a fully successful batch reports zero failures");
    assert.deepStrictEqual(
      startOutcome.results.map((result) => result.nodeId),
      startTargets,
      "per-node results must stay bound to their own target order",
    );
    startOutcome.results.forEach((result) => {
      assert.strictEqual(result.ok, true, `batch start result for ${result.nodeId} must succeed`);
      assert.strictEqual(result.code, "OK");
      assert.strictEqual(result.state, "online");
      assert(typeof result.message === "string" && result.message.length > 0, "each per-node result must carry a message");
    });
    assert.strictEqual(healthConcurrency.max, 3, `the production batch fan-out must never exceed 3 concurrent node actions (observed ${healthConcurrency.max})`);
    [agentA, agentD, agentE, agentF, agentG].forEach((agent, index) => {
      assert(agent.state.healthRequests >= 1, `batch start must act on node ${startTargets[index]} itself`);
    });

    // --- 6. Batch start with partial failure surfaced honestly ----------------
    const partialOutcome = await runFleetBatchAction({ action: "start", nodeIds: [nodeA.id, nodeB.id, "agent-ghost"] });
    assert.strictEqual(partialOutcome.summary.total, 3, "every target gets a per-node result");
    assert.strictEqual(partialOutcome.summary.succeeded, 1, "only the reachable node succeeds");
    assert.strictEqual(partialOutcome.summary.failed, 2, "the offline and unknown nodes fail");
    const resultA = partialOutcome.results.find((result) => result.nodeId === nodeA.id);
    const resultB = partialOutcome.results.find((result) => result.nodeId === nodeB.id);
    const resultGhost = partialOutcome.results.find((result) => result.nodeId === "agent-ghost");
    assert.strictEqual(resultA.ok, true, "the reachable node must succeed in a mixed batch");
    assert.strictEqual(resultB.ok, false, "the offline node must fail honestly");
    assert.strictEqual(resultB.code, "NODE_OFFLINE", "the offline node's failure code must be surfaced");
    assert(typeof resultB.message === "string" && resultB.message.length > 0, "the offline node's failure reason must be surfaced");
    assert.strictEqual(resultGhost.ok, false, "an unregistered target must fail");
    assert.strictEqual(resultGhost.code, "NODE_NOT_FOUND", "a wrong-node target must be refused by the registry guard");
    ["nodeId", "ok", "code", "message"].forEach((field) => {
      partialOutcome.results.forEach((result) => {
        assert(field in result, `per-node result records must include ${field}`);
      });
    });

    // --- 7. Target binding: the application host is not a batch target --------
    const hostOutcome = await runFleetBatchAction({ action: "stop", nodeIds: ["application-host"], confirm: true });
    assert.strictEqual(hostOutcome.results.length, 1, "the application host attempt gets its own record");
    assert.strictEqual(hostOutcome.results[0].ok, false, "the application host must not be a batch target");
    assert.strictEqual(hostOutcome.results[0].code, "APPLICATION_HOST_READ_ONLY", "the application host guard must be exercised");

    // --- 8. Batch stop: explicit confirmation, per-node success ---------------
    const stopOutcome = await runFleetBatchAction({ action: "stop", nodeIds: [nodeA.id, nodeC.id], confirm: true });
    assert.strictEqual(stopOutcome.summary.succeeded, 2, "stopping registered nodes succeeds per node");
    assert.strictEqual(stopOutcome.summary.failed, 0, "an already-disconnected node still stops cleanly");
    assert.strictEqual(nodeService.getNode(nodeA.id).manualDisconnect, true, "batch stop must disconnect node A");
    assert.strictEqual(nodeService.getNode(nodeC.id).manualDisconnect, true, "batch stop must leave node C disconnected");
    assert(agentC.state.healthRequests === cHealthRequestsBefore, "stopping a disconnected node must not probe its Agent");

    const restored = await nodeService.reconnectNode(nodeA.id);
    assert.strictEqual(restored.state, "online", "node A must be restorable after the batch stop");

    // --- 9. New IPC channels authorize before touching any service ------------
    const Module = require("module");
    const handlers = new Map();
    const serviceInvocations = [];
    const auditEvents = [];
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === "electron") return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
      if (request === "../services/nodeService") {
        return new Proxy({}, {
          get: () => async (...args) => {
            serviceInvocations.push("nodeService");
            return {};
          },
        });
      }
      if (request === "../services/fleetService") {
        return {
          getFleetSummary: async () => {
            serviceInvocations.push("getFleetSummary");
            return {};
          },
          runFleetBatchAction: async () => {
            serviceInvocations.push("runFleetBatchAction");
            return {};
          },
        };
      }
      if (request === "../services/activeNodeSelectionService") return { restorePersistedActiveNode: async () => ({}), setActiveNode: async () => ({}) };
      if (request === "../shared/agentTokenStore") return { generateAgentToken: () => "test-token" };
      if (request === "../services/securityService") {
        return {
          audit: (event) => auditEvents.push(event),
          requireLocalOwnerAuthenticated: () => { throw Object.assign(new Error("Permission denied."), { code: "PERMISSION_DENIED" }); },
          requirePermission: () => { throw Object.assign(new Error("Permission denied."), { code: "PERMISSION_DENIED" }); },
        };
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      require("../src/ipc/nodesIpc").registerNodesIpc();
    } finally {
      Module._load = originalLoad;
    }
    for (const [channel, payload] of [
      ["nodes:fleetSummary", {}],
      ["nodes:fleetBatch", { action: "stop", nodeIds: [nodeA.id], confirm: true }],
    ]) {
      const handler = handlers.get(channel);
      assert(handler, `${channel} should be registered.`);
      serviceInvocations.length = 0;
      await assert.rejects(
        () => handler({}, payload),
        (error) => error?.code === "PERMISSION_DENIED",
        `${channel} must reject an unauthorized renderer request.`,
      );
      assert.strictEqual(serviceInvocations.length, 0, `${channel} must authorize before invoking any service.`);
      assert(
        auditEvents.every((event) => !String(event?.action || "").startsWith("node.fleet-batch")),
        `${channel} must not audit a batch action it refused.`,
      );
    }

    console.log("fleet-aggregation-smoke passed");
  } finally {
    for (const agent of [agentA, agentC, agentD, agentE, agentF, agentG]) {
      await close(agent.server);
    }
  }
}

main().catch((error) => {
  console.error("fleet-aggregation-smoke FAILED:", error);
  // Fail loudly and exit immediately: pending Agent keep-alive sockets or log
  // throttles must never leave this smoke hanging in a CI/background runner.
  process.exit(1);
});
