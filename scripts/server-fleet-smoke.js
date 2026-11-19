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
//   F9 Docker services are listed with the servers (Build 215-C): type,
//      ports, kept data, health, managed/compose/existing, crash on exit 1
//   F10 a computer without Docker shows servers only; a Docker failure
//      never hides that computer's servers; offline keeps last-known services
//   F11 container actions go to the container's own computer, ids checked
//   F12 the renderer filters by type and searches images
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
    // Array.from: the sandbox builds its own Array, which deepStrictEqual
    // would compare by prototype.
    const names = () => Array.from(module._test.visibleServers(), (server) => `${server.nodeName}/${server.name}`);
    assert.deepStrictEqual(names(), ["Anxlab/AnxRP", "Anxlab/Palworld", "VPS/FiveM"], "default sort groups by computer");
    void elements;
    console.log("  ok F8 renderer ordering");
  }

  const containers = {
    "node-anxlab": [
      { id: "abc123", name: "grafana", image: "grafana/grafana:latest", state: "running", status: "Up 3 hours (healthy)", health: "healthy", ports: ["3000->3000/tcp"], mounts: ["grafana-data"], labels: { "anxos.managed": "true", "anxos.template": "grafana" } },
      { id: "def456", name: "immich-server", image: "ghcr.io/immich-app/immich-server:release", state: "exited", status: "Exited (1) 2 minutes ago", ports: [], mounts: ["immich-upload"], labels: { "com.docker.compose.project": "immich" } },
      { id: "ghi789", name: "scratch", image: "alpine", state: "exited", status: "Exited (0) 1 day ago", ports: [], mounts: [], labels: {} },
    ],
  };
  const readAll = (nodes, overrides = {}) => fleet.listServersAcrossComputers({
    listNodes: async () => nodes,
    listInstancesForNode: async (nodeId) => ({ instances: lists[nodeId] || [] }),
    listContainersForNode: async (nodeId) => {
      if (overrides[nodeId]) return overrides[nodeId]();
      if (!containers[nodeId]) throw Object.assign(new Error("Docker is not installed."), { code: "DOCKER_NOT_INSTALLED" });
      return containers[nodeId];
    },
    configDir,
    now: () => clock,
  });

  // F9
  let withDocker;
  {
    withDocker = await readAll([anxlab, vps]);
    const services = withDocker.services;
    assert.strictEqual(services.length, 3);
    const grafana = services.find((service) => service.name === "grafana");
    assert.strictEqual(grafana.kind, "docker");
    assert.strictEqual(grafana.state, "running");
    assert.strictEqual(grafana.health, "healthy");
    assert.strictEqual(grafana.managed, true);
    assert.strictEqual(grafana.template, "grafana");
    assert.deepStrictEqual(grafana.ports, ["3000->3000/tcp"]);
    assert.deepStrictEqual(grafana.storage, ["grafana-data"]);
    assert.strictEqual(grafana.key, "node-anxlab::docker::abc123");
    const immich = services.find((service) => service.name === "immich-server");
    assert.strictEqual(immich.state, "crashed", "exit code 1 is a crash");
    assert.strictEqual(immich.composeProject, "immich");
    assert.strictEqual(services.find((service) => service.name === "scratch").state, "stopped", "exit code 0 is a clean stop");
    assert(withDocker.servers.every((server) => server.kind === "server"));
    const anxlabSummary = withDocker.computers.find((computer) => computer.nodeId === "node-anxlab");
    assert.strictEqual(anxlabSummary.serviceCount, 3);
    assert.strictEqual(anxlabSummary.docker, "ok");
    const { normalizeContainer } = require("../src/shared/dockerService");
    const listed = normalizeContainer({ ID: "x1", Names: "web", Image: "nginx", State: "running", Status: "Up 1 minute", Labels: "anxos.managed=true,com.docker.compose.project=site,secret.token=abc123,maintainer=someone", Mounts: "site-data,/srv/www", Networks: "bridge" });
    assert.deepStrictEqual(listed.labels, { "anxos.managed": "true", "com.docker.compose.project": "site" }, "only AnxOS and Compose labels are kept");
    assert(!JSON.stringify(listed).includes("abc123"), "other label values never leave the computer");
    assert.deepStrictEqual(listed.mounts, ["site-data", "/srv/www"]);
    console.log("  ok F9 Docker services listed with servers");
  }

  // F10
  {
    const vpsSummary = withDocker.computers.find((computer) => computer.nodeId === "node-vps");
    assert.strictEqual(vpsSummary.docker, "off", "no Docker on that computer");
    assert.strictEqual(vpsSummary.serverCount, 1, "its servers are still listed");
    const broken = await readAll([anxlab], { "node-anxlab": async () => { throw Object.assign(new Error("Cannot connect to the Docker daemon"), { code: "DOCKER_REQUEST_FAILED" }); } });
    assert.strictEqual(broken.servers.length, 2, "a Docker failure never hides servers");
    assert.strictEqual(broken.computers[0].docker, "unavailable");
    assert(/Docker daemon/.test(broken.computers[0].dockerMessage));
    const offline = await readAll([{ ...anxlab, connection: { status: "offline" } }]);
    assert.strictEqual(offline.services.length, 3, "last-known services kept for an offline computer");
    assert(offline.services.every((service) => service.state === "last-known" && service.lastKnown));
    const cache = JSON.parse(fs.readFileSync(path.join(configDir, fleet.CACHE_FILENAME), "utf8"));
    assert(!JSON.stringify(cache).includes("3000->3000"), "ports are not cached");
    console.log("  ok F10 Docker absence and failure never hide servers; offline keeps services");
  }

  // F11
  {
    const calls = [];
    const result = await fleet.runServerFleetAction({
      action: "restart",
      confirm: true,
      targets: [{ nodeId: "node-anxlab", containerId: "abc123" }, { nodeId: "node-anxlab", containerId: "abc123" }, { nodeId: "node-anxlab", containerId: "bad;id" }, { nodeId: "node-vps", instanceId: "fivem" }],
      listNodes: async () => [anxlab, vps],
      authorize: () => {},
      runAction: async (verb, target) => calls.push(`${verb}:${target.nodeId}:${target.containerId || target.instanceId}:${target.kind}`),
    });
    assert.deepStrictEqual(calls, ["restart:node-anxlab:abc123:docker", "restart:node-vps:fivem:server"], "duplicates merged, unsafe id dropped, each to its own computer");
    assert.strictEqual(result.succeeded, 2);
    console.log("  ok F11 container actions routed to their computer");
  }

  // F12
  {
    const fakeDocument = { readyState: "complete", hidden: false, querySelector: () => null, addEventListener: () => {}, createElement: () => ({ append() {}, addEventListener() {}, setAttribute() {}, classList: { toggle() {} }, dataset: {} }) };
    const sandbox = { window: { document: fakeDocument, localStorage: { getItem: () => "0", setItem: () => {} }, setInterval: () => 0, clearInterval: () => {} } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "src", "renderer", "serverFleet.js"), "utf8"), sandbox);
    const module = sandbox.window.AnxServerFleet;
    module._test.setData(withDocker);
    const names = () => Array.from(module._test.visibleServers(), (item) => `${item.kind}:${item.name}`);
    assert.strictEqual(names().length, 6, "three servers and three services");
    module._test.setView({ type: "docker" });
    assert.deepStrictEqual(names().sort(), ["docker:grafana", "docker:immich-server", "docker:scratch"]);
    module._test.setView({ type: "server" });
    assert(names().every((name) => name.startsWith("server:")));
    module._test.setView({ type: "all", search: "immich-app" });
    assert.deepStrictEqual(names(), ["docker:immich-server"], "search matches images");
    module._test.setView({ search: "", state: "crashed" });
    assert.deepStrictEqual(names().sort(), ["docker:immich-server", "server:AnxRP"], "crashed servers and services together");
    console.log("  ok F12 renderer type filter and image search");
  }

  fs.rmSync(configDir, { recursive: true, force: true });
  console.log("Server fleet smoke passed (12 cases).");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
