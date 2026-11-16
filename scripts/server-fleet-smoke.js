#!/usr/bin/env node
// Servers on all computers (serverFleetService + the renderer's filtering).
//   F1 online computers list their servers with the host computer and state
//   F2 an offline computer keeps its servers as last known from the cache
//   F3 a computer whose list fails keeps its last-known servers too
//   F4 a removed computer is dropped from the cache
//   F5 actions go to each server's own computer, one at a time
//   F6 stop/restart need confirmation; offline computers are skipped, not re-routed
//   F7 duplicates collapse, limits hold, one failure does not stop the rest
//   F8 the renderer module searches, filters and sorts across computers
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");
const fleet = require("../src/services/serverFleetService");

const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-server-fleet-"));
const anxlab = { id: "node-anxlab", displayName: "Anxlab", connection: { status: "online" } };
const vps = { id: "node-vps", displayName: "VPS", connection: { status: "online" } };
const host = { id: "application-host", displayName: "This PC" };
const lists = {
  "node-anxlab": [{ id: "palworld", displayName: "Palworld", state: "running", gameAdapter: "palworld", metrics: { cpuPercent: 12.5, memoryRssBytes: 4e9 } }, { id: "mc", displayName: "AnxRP", state: "failed", failureReason: "PORT_IN_USE" }],
  "node-vps": [{ id: "fivem", displayName: "FiveM", state: "stopped" }],
  "application-host": [],
};
let clock = "2026-11-16T12:00:00.000Z";

(async () => {
  const read = (nodes, overrides = {}) => fleet.listServersAcrossComputers({
    listNodes: async () => nodes,
    listInstancesForNode: async (nodeId) => {
      if (overrides[nodeId]) return overrides[nodeId]();
      return { instances: lists[nodeId] };
    },
    configDir,
    now: () => clock,
  });

  // F1
  const first = await read([host, anxlab, vps]);
  {
    assert.strictEqual(first.servers.length, 3);
    const palworld = first.servers.find((server) => server.instanceId === "palworld");
    assert.deepStrictEqual([palworld.nodeName, palworld.state, palworld.cpuPercent, palworld.lastKnown], ["Anxlab", "running", 12.5, false]);
    assert.strictEqual(first.servers.find((server) => server.instanceId === "mc").state, "crashed");
    assert.strictEqual(first.servers.find((server) => server.instanceId === "fivem").nodeName, "VPS");
    assert(first.computers.every((computer) => computer.status === "online"));
    const cache = JSON.parse(fs.readFileSync(path.join(configDir, fleet.CACHE_FILENAME), "utf8"));
    assert(!JSON.stringify(cache).includes("PORT_IN_USE") && !JSON.stringify(cache).includes("cpuPercent"), "cache holds names, ids, games and states only");
    console.log("  ok F1 online computers");
  }

  // F2
  clock = "2026-11-16T12:30:00.000Z";
  {
    const offlineVps = { ...vps, connection: { status: "offline" } };
    let called = false;
    const second = await read([host, anxlab, offlineVps], { "node-vps": () => { called = true; return []; } });
    assert.strictEqual(called, false, "an offline computer is not queried");
    const fivem = second.servers.find((server) => server.instanceId === "fivem");
    assert.deepStrictEqual([fivem.state, fivem.reportedState, fivem.lastKnown, fivem.fetchedAt], ["last-known", "stopped", true, "2026-11-16T12:00:00.000Z"]);
    assert.strictEqual(fivem.cpuPercent, null);
    const summary = second.computers.find((computer) => computer.nodeId === "node-vps");
    assert.deepStrictEqual([summary.status, summary.serverCount, summary.lastKnown], ["offline", 1, true]);
    console.log("  ok F2 offline computer keeps last-known servers");
  }

  // F3
  {
    const third = await read([host, anxlab, vps], { "node-anxlab": () => { throw Object.assign(new Error("Agent timed out"), { code: "AGENT_TIMEOUT" }); } });
    const anxlabServers = third.servers.filter((server) => server.nodeId === "node-anxlab");
    assert.strictEqual(anxlabServers.length, 2);
    assert(anxlabServers.every((server) => server.lastKnown));
    assert.strictEqual(third.computers.find((computer) => computer.nodeId === "node-anxlab").status, "unavailable");
    console.log("  ok F3 failed list keeps last-known servers");
  }

  // F4
  {
    await read([host, anxlab]);
    const cache = JSON.parse(fs.readFileSync(path.join(configDir, fleet.CACHE_FILENAME), "utf8"));
    assert.deepStrictEqual(Object.keys(cache.computers).sort(), ["application-host", "node-anxlab"]);
    console.log("  ok F4 removed computer dropped");
  }

  // F5
  const calls = [];
  let active = 0;
  const runAction = async (verb, target) => {
    active += 1;
    assert.strictEqual(active, 1, "one server at a time");
    calls.push(`${verb}:${target.nodeId}:${target.instanceId}`);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active -= 1;
    if (target.instanceId === "broken") throw Object.assign(new Error("Agent refused"), { code: "INSTANCE_START_FAILED" });
  };
  const authorized = [];
  const base = { listNodes: async () => [host, anxlab, { ...vps, connection: { status: "offline" } }], authorize: (target) => authorized.push(target.instanceId), runAction };
  {
    const result = await fleet.runServerFleetAction({ ...base, action: "start", targets: [{ nodeId: "node-anxlab", instanceId: "palworld" }, { nodeId: "application-host", instanceId: "local-mc" }] });
    assert.deepStrictEqual(calls, ["start:node-anxlab:palworld", "start:application-host:local-mc"]);
    assert.deepStrictEqual(authorized, ["palworld", "local-mc"], "each server is authorized");
    assert.strictEqual(result.succeeded, 2);
    console.log("  ok F5 explicit routing");
  }

  // F6
  {
    await assert.rejects(() => fleet.runServerFleetAction({ ...base, action: "stop", targets: [{ nodeId: "node-anxlab", instanceId: "palworld" }] }), (error) => error.code === "SERVER_FLEET_CONFIRMATION_REQUIRED");
    calls.length = 0;
    const result = await fleet.runServerFleetAction({ ...base, action: "restart", confirm: true, targets: [{ nodeId: "node-vps", instanceId: "fivem" }, { nodeId: "node-anxlab", instanceId: "mc" }] });
    assert.deepStrictEqual(calls, ["restart:node-anxlab:mc"], "the offline computer's server is skipped, never sent elsewhere");
    assert.strictEqual(result.results.find((entry) => entry.instanceId === "fivem").code, "NODE_OFFLINE");
    await assert.rejects(() => fleet.runServerFleetAction({ ...base, action: "delete", targets: [{ nodeId: "node-anxlab", instanceId: "mc" }] }), (error) => error.code === "SERVER_FLEET_ACTION_INVALID");
    console.log("  ok F6 confirmation and offline targets");
  }

  // F7
  {
    calls.length = 0;
    const result = await fleet.runServerFleetAction({ ...base, action: "start", targets: [{ nodeId: "node-anxlab", instanceId: "broken" }, { nodeId: "node-anxlab", instanceId: "palworld" }, { nodeId: "node-anxlab", instanceId: "palworld" }, { nodeId: "", instanceId: "x" }] });
    assert.deepStrictEqual(calls, ["start:node-anxlab:broken", "start:node-anxlab:palworld"], "deduplicated, invalid dropped, continues after a failure");
    assert.deepStrictEqual([result.succeeded, result.failed, result.ok], [1, 1, false]);
    const many = Array.from({ length: 26 }, (_, index) => ({ nodeId: "node-anxlab", instanceId: `s${index}` }));
    await assert.rejects(() => fleet.runServerFleetAction({ ...base, action: "start", targets: many }), (error) => error.code === "SERVER_FLEET_TOO_MANY");
    await assert.rejects(() => fleet.runServerFleetAction({ ...base, action: "start", targets: [] }), (error) => error.code === "SERVER_FLEET_TARGETS_REQUIRED");
    console.log("  ok F7 duplicates, limits, partial failure");
  }

  // F8
  {
    const elements = new Map();
    const fakeDocument = {
      readyState: "complete",
      hidden: false,
      querySelector: () => null,
      addEventListener: () => {},
      createElement: () => ({ append() {}, addEventListener() {}, setAttribute() {}, classList: { toggle() {} }, dataset: {} }),
    };
    const sandbox = { window: { document: fakeDocument, localStorage: { getItem: () => "0", setItem: () => {} }, setInterval: () => 0, clearInterval: () => {} } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "serverFleet.js"), "utf8"), sandbox);
    const module = sandbox.window.AnxServerFleet;
    module._test.setData(first);
    const names = () => module._test.visibleServers().map((server) => `${server.nodeName}/${server.name}`);
    assert.deepStrictEqual(names(), ["Anxlab/AnxRP", "Anxlab/Palworld", "VPS/FiveM"], "default sort groups by computer");
    void elements;
    console.log("  ok F8 renderer ordering");
  }

  fs.rmSync(configDir, { recursive: true, force: true });
  console.log("Server fleet smoke passed (8 cases).");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
