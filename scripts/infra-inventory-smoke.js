"use strict";

// AIM-1 hermetic smoke: inventory model + desktop inventory service against an
// injected fake Agent reader. Covers identity (§5.7, CL9), read-only route
// allow-list, offline/stale handling, skipped nodes, duplicates, identity
// mismatch, permission boundaries, Docker absence, restart recovery, store
// quarantine and future-schema refusal, single-flight, unregistered-node
// retention, bounds, service-managed instances, protection defaults and
// secret exclusion.

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const model = require("../src/shared/infraInventoryModel");
const inventory = require("../src/services/infrastructureInventoryService");

const SECRET = "SUPERSECRET-ENV-VALUE-9f3a";
const FULL_ID = "a".repeat(64);
const FULL_ID_2 = "b".repeat(64);

function identity(deviceId = "dev-1", installationId = "inst-1", generation = "gen-1") {
  return { deviceId, agentInstallationId: installationId, agentIdentityGeneration: generation, hostname: `${deviceId}-host`, platform: "linux", agentVersion: "2.0-build206" };
}

function makeAgent(options = {}) {
  const world = {
    identity: options.identity || identity(),
    allowedUnits: options.allowedUnits || ["anxrp-fxserver.service"],
    dockerInstalled: options.dockerInstalled !== false,
    containers: options.containers || [
      { id: FULL_ID.slice(0, 12), name: "qdrant", image: "qdrant/qdrant:v1.19.2", state: "running", status: "Up 3 hours (healthy)", health: "healthy", ports: ["6333/tcp"] },
    ],
    volumes: options.volumes || [{ name: "qdrant-data", driver: "local", scope: "local", containersUsing: ["qdrant"] }],
    networks: options.networks || [{ id: "123456789abc", name: "ai-box", driver: "bridge", scope: "local" }],
    projects: options.projects || [{ Name: "ai-box", Status: "running(1)", ConfigFiles: "/srv/ai-box/compose.yaml" }],
    listeners: options.listeners || [{ protocol: "tcp", localAddress: "127.0.0.1", localPort: 6333, pid: 900, processName: "qdrant" }],
    instances: options.instances || [
      { id: "mc-1", displayName: "Minecraft", type: "minecraft", state: "Running", healthState: "healthy" },
      {
        id: "fivem-fxserver",
        displayName: "AnxRP",
        type: "systemd-service",
        state: "Running",
        serviceManager: { kind: "systemd", unit: "anxrp-fxserver.service" },
        serviceStatus: { observed: true, unit: "anxrp-fxserver.service", activeState: "active", subState: "running", externalMainPid: 4242, uptimeSeconds: 3600, restartCount: 0 },
        ports: [30120],
      },
    ],
    failures: options.failures || {},
    calls: [],
  };
  const reader = async (pathname, requestOptions) => {
    world.calls.push({ method: requestOptions?.method || "GET", pathname, config: requestOptions?.config });
    const failure = Object.entries(world.failures).find(([pattern]) => pathname.startsWith(pattern));
    if (failure) throw failure[1]();
    if (pathname === "/api/v1/health") {
      return { ok: true, identity: world.identity, mode: "read-write", capabilities: { os: "linux", supportsDocker: null, supportsSystemMetrics: true, supportsServiceControl: false, serviceManagedInstances: { supported: true, mechanism: "systemd", allowedUnits: world.allowedUnits } } };
    }
    if (pathname === "/api/v1/system/summary") return { hostname: world.identity.hostname, cpu: { cores: 8 }, memory: { total: 16e9 } };
    if (pathname === "/api/v1/instances") return { instances: world.instances };
    if (pathname === "/api/v1/network/inventory") return { listeners: world.listeners, listenersTruncated: false };
    if (pathname === "/api/v1/docker/containers") {
      return world.dockerInstalled
        ? { installed: true, daemonRunning: true, containers: world.containers }
        : { installed: false, daemonRunning: false, message: "Docker is not installed or is not available on PATH for this node.", containers: [] };
    }
    const containerInspect = pathname.match(/^\/api\/v1\/docker\/containers\/([^/]+)\/inspect$/);
    if (containerInspect) {
      const short = decodeURIComponent(containerInspect[1]);
      const isQdrant = short === FULL_ID.slice(0, 12);
      const full = isQdrant ? FULL_ID : short.padEnd(64, "c").slice(0, 64);
      // Like the real Docker inspect: volume mounts carry name + driver, and
      // NetworkSettings carries the full network IDs.
      const volumeMounts = isQdrant
        ? world.volumes.map((volume) => ({ Type: "volume", Name: volume.name, Driver: volume.driver, Source: `/var/lib/docker/volumes/${SECRET}` }))
        : [];
      const networks = isQdrant
        ? Object.fromEntries(world.networks.map((network) => [network.name, { NetworkID: network.fullId || network.id.padEnd(64, "e") }]))
        : {};
      return { inspect: [{
        Id: full,
        Name: "/qdrant",
        Created: "2026-10-01T00:00:00.000Z",
        Config: { Image: "qdrant/qdrant:v1.19.2", Env: [`QDRANT__SERVICE__API_KEY=${SECRET}`], Labels: { "com.docker.compose.project": "ai-box", "com.docker.compose.service": "qdrant", "secret.label": SECRET } },
        HostConfig: { RestartPolicy: { Name: "unless-stopped" } },
        Mounts: [...volumeMounts, { Type: "bind", Source: "/etc/secret", Destination: "/secret" }],
        NetworkSettings: { Networks: networks },
      }] };
    }
    const volumeInspect = pathname.match(/^\/api\/v1\/docker\/volumes\/([^/]+)\/inspect$/);
    if (volumeInspect) return { inspect: [{ Name: decodeURIComponent(volumeInspect[1]), CreatedAt: world.volumeCreatedAt || "2026-09-30T12:00:00Z", Labels: { "com.docker.compose.project": "ai-box" } }] };
    if (pathname === "/api/v1/docker/compose/projects") return { projects: world.projects };
    throw Object.assign(new Error(`unexpected route ${pathname}`), { status: 404 });
  };
  return { world, reader };
}

function agentNode(id, extra = {}) {
  return { id, kind: "agent", displayName: id, enabled: true, connection: { status: "online" }, agentIdentity: { deviceId: extra.deviceId || "dev-1" }, ...extra };
}

let tempRoot;
let clock;
function setup({ reader, nodes, storePath }) {
  inventory.resetInfrastructureInventory();
  inventory.configureInfrastructureInventory({
    storePath: storePath || path.join(tempRoot, `inventory-${Math.random().toString(16).slice(2)}.json`),
    now: () => clock,
    reader,
    nodes: () => nodes,
    agentConfigFor: (nodeId) => ({ nodeId, token: "[test]" }),
  });
}

function byKind(snapshot, kind) {
  return snapshot.resources.filter((resource) => resource.kind === kind);
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test("full discovery: identities, ownership, health, protection, no secrets", async () => {
  const { reader, world } = makeAgent();
  const storePath = path.join(tempRoot, "full.json");
  setup({ reader, nodes: [{ id: "local", kind: "application-host" }, agentNode("node-a")], storePath });
  const snapshot = await inventory.refreshInventory();

  const host = byKind(snapshot, "host")[0];
  assert.strictEqual(host.identity.verified, true);
  assert.strictEqual(host.key, "host:dev-1:inst-1:gen-1");
  assert.strictEqual(host.capabilities.supportsServiceControl, false);
  assert.deepStrictEqual(host.capabilities.serviceManagedInstances.allowedUnits, ["anxrp-fxserver.service"]);
  assert.strictEqual(host.capabilities.gpu, "not-reported");

  const svc = byKind(snapshot, "service-managed-instance")[0];
  assert.strictEqual(svc.identity.verified, true);
  assert.deepStrictEqual(svc.identity.components, { host: "host:dev-1:inst-1:gen-1", instanceId: "fivem-fxserver", unit: "anxrp-fxserver.service" });
  assert.strictEqual(svc.ownership.owner, "systemd");
  assert.strictEqual(svc.capabilities.agentOwnsProcess, false);
  assert.strictEqual(svc.capabilities.unitAllowlisted, true);
  assert.strictEqual(svc.health.state, "healthy");
  assert.strictEqual(svc.details.externalMainPid, 4242);

  const instance = byKind(snapshot, "instance")[0];
  assert.strictEqual(instance.identity.verified, true);
  assert.strictEqual(instance.ownership.owner, "anxos-agent");

  const container = byKind(snapshot, "container")[0];
  assert.strictEqual(container.identity.verified, true);
  assert.strictEqual(container.identity.components.containerId, FULL_ID);
  assert.strictEqual(container.identity.components.composeProject, "ai-box");
  assert.strictEqual(container.ownership.owner, "docker-compose");
  assert.deepStrictEqual(container.details.volumes, ["qdrant-data"]);

  const volume = byKind(snapshot, "volume")[0];
  assert.strictEqual(volume.identity.verified, true);
  assert.strictEqual(volume.identity.components.createdAt, "2026-09-30T12:00:00.000Z");
  assert.strictEqual(volume.details.persistentData, true);

  assert.strictEqual(byKind(snapshot, "network")[0].identity.verified, false);
  assert.strictEqual(byKind(snapshot, "compose-project")[0].identity.verified, true);
  const listener = byKind(snapshot, "listener")[0];
  assert.strictEqual(listener.identity.verified, false);
  assert.strictEqual(listener.identity.reason, "PROCESS_IDENTITY_NOT_REPORTED");

  for (const resource of snapshot.resources) {
    assert.strictEqual(resource.protection.scope, "production", `${resource.key} must default to production`);
    assert.strictEqual(resource.protection.reason, "UNCLASSIFIED_DEFAULT_PRODUCTION");
    assert.ok(resource.firstSeen && resource.lastSeen && resource.stale === false);
  }

  const appHost = snapshot.nodes.find((node) => node.nodeId === "local");
  assert.strictEqual(appHost.status, "skipped");
  assert.strictEqual(appHost.code, "APPLICATION_HOST_NOT_AGENT");
  assert.strictEqual(snapshot.summary.nodesAvailable, 1);

  const persisted = fs.readFileSync(storePath, "utf8");
  assert.ok(!persisted.includes(SECRET), "persisted inventory must not contain env, label or mount-source secrets");
  assert.ok(!JSON.stringify(snapshot).includes(SECRET), "returned inventory must not contain secrets");
  assert.ok(!persisted.includes("/etc/secret"), "bind-mount host paths must not be stored");
  assert.ok(!persisted.includes("[test]"), "node credentials must not be stored");

  assert.ok(world.calls.length > 0);
  for (const call of world.calls) {
    assert.strictEqual(call.method, "GET");
    assert.ok(inventory.READ_ROUTE_ALLOWLIST.some((pattern) => pattern.test(call.pathname)), `unexpected route ${call.pathname}`);
  }
});

test("read-only guard refuses every mutating or unknown route", async () => {
  for (const [method, pathname] of [
    ["POST", "/api/v1/instances/fivem-fxserver/restart"],
    ["POST", "/api/v1/instances/fivem-fxserver/service/safe-restart"],
    ["GET", "/api/v1/instances/fivem-fxserver/service/overview"],
    ["POST", "/api/v1/actions/docker.restart"],
    ["DELETE", "/api/v1/docker/volumes/qdrant-data"],
    ["GET", "/api/v1/docker/containers/../../etc/inspect"],
    ["GET", "/api/v1/files/read"],
    // Allow-listed paths with a mutating method must still be refused.
    ["POST", "/api/v1/instances"],
    ["DELETE", "/api/v1/docker/volumes"],
    ["PUT", "/api/v1/health"],
  ]) {
    assert.throws(() => inventory.assertReadRoute(method, pathname), (error) => error.code === "INVENTORY_ROUTE_NOT_ALLOWED", `${method} ${pathname}`);
  }
  inventory.assertReadRoute("GET", "/api/v1/instances");
});

test("offline node keeps last-known resources as stale; lastSeen unchanged", async () => {
  const { reader, world } = makeAgent();
  setup({ reader, nodes: [agentNode("node-a")] });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const first = await inventory.refreshInventory();
  const count = first.resources.length;
  world.failures["/api/v1/health"] = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  clock += 60000;
  const second = await inventory.refreshInventory();
  assert.strictEqual(second.resources.length, count);
  for (const resource of second.resources) {
    assert.strictEqual(resource.stale, true);
    assert.strictEqual(resource.lastSeen, "2026-10-14T10:00:00.000Z");
  }
  assert.strictEqual(second.resources[0].staleReason, "NODE_UNREACHABLE");
  const node = second.nodes[0];
  assert.strictEqual(node.status, "unavailable");
  assert.strictEqual(node.lastSuccessAt, "2026-10-14T10:00:00.000Z");
  assert.strictEqual(second.summary.stale, count);
});

test("disabled, disconnected and offline nodes are skipped without requests", async () => {
  const { reader, world } = makeAgent();
  setup({ reader, nodes: [
    agentNode("disabled", { enabled: false }),
    agentNode("manual", { manualDisconnect: true }),
    agentNode("offline", { connection: { status: "offline" } }),
    agentNode("authfail", { connection: { status: "authentication_failed" } }),
  ] });
  const snapshot = await inventory.refreshInventory();
  assert.strictEqual(world.calls.length, 0);
  assert.deepStrictEqual(snapshot.nodes.map((node) => node.code), ["NODE_DISABLED", "NODE_DISCONNECTED", "NODE_OFFLINE", "NODE_AUTHENTICATION_FAILED"]);
  assert.ok(snapshot.nodes.every((node) => node.status === "skipped"));
});

test("duplicate registrations of one host and duplicate list rows are merged", async () => {
  const container = { id: FULL_ID.slice(0, 12), name: "qdrant", state: "running", status: "Up", ports: [] };
  const { reader } = makeAgent({ containers: [container, { ...container }] });
  setup({ reader, nodes: [agentNode("node-a"), agentNode("node-a-again")] });
  const snapshot = await inventory.refreshInventory();
  const hosts = byKind(snapshot, "host");
  assert.strictEqual(hosts.length, 1, "one host for two registrations of the same Agent");
  assert.deepStrictEqual(hosts[0].nodeIds, ["node-a", "node-a-again"]);
  assert.strictEqual(hosts[0].duplicateNodes, true);
  const containers = byKind(snapshot, "container");
  assert.strictEqual(containers.length, 1);
  assert.ok(snapshot.summary.duplicates >= 1);
});

test("identity mismatch: no resources are attributed to the node", async () => {
  const { reader } = makeAgent({ identity: identity("other-device") });
  setup({ reader, nodes: [agentNode("node-a", { deviceId: "dev-1" })] });
  const snapshot = await inventory.refreshInventory();
  assert.strictEqual(snapshot.resources.length, 0);
  assert.strictEqual(snapshot.nodes[0].status, "unavailable");
  assert.strictEqual(snapshot.nodes[0].code, "AGENT_IDENTITY_MISMATCH");
});

test("incomplete host identity: resources listed but unverified", async () => {
  const { reader } = makeAgent({ identity: { deviceId: "dev-1", hostname: "h" } });
  setup({ reader, nodes: [agentNode("node-a")] });
  const snapshot = await inventory.refreshInventory();
  assert.ok(snapshot.resources.length > 0);
  assert.ok(snapshot.resources.every((resource) => resource.identity.verified === false));
  assert.ok(snapshot.resources.every((resource) => resource.key.startsWith("node:node-a")));
});

test("permission boundaries are reported per section, never as empty lists", async () => {
  const { reader } = makeAgent({ failures: {
    "/api/v1/docker": () => Object.assign(new Error("Forbidden"), { status: 403 }),
    "/api/v1/instances": () => Object.assign(new Error("Unauthorized"), { status: 401 }),
  } });
  setup({ reader, nodes: [agentNode("node-a")] });
  const snapshot = await inventory.refreshInventory();
  const sections = Object.fromEntries(snapshot.nodes[0].sections.map((section) => [section.name, section]));
  assert.strictEqual(sections.docker.code, "PERMISSION_DENIED");
  assert.strictEqual(sections.instances.code, "AUTH_FAILED");
  assert.strictEqual(sections.listeners.status, "ok");
  assert.strictEqual(byKind(snapshot, "container").length, 0);
  assert.strictEqual(byKind(snapshot, "host").length, 1);
});

test("failed sections keep last-known resources as stale, never drop them", async () => {
  const { reader, world } = makeAgent();
  setup({ reader, nodes: [agentNode("node-a")] });
  const first = await inventory.refreshInventory();
  const before = Object.fromEntries(model.RESOURCE_KINDS.map((kind) => [kind, byKind(first, kind).length]));
  assert.ok(before.container > 0 && before.instance > 0 && before["service-managed-instance"] > 0);
  world.failures["/api/v1/docker"] = () => Object.assign(new Error("Forbidden"), { status: 403 });
  world.failures["/api/v1/instances"] = () => Object.assign(new Error("Unauthorized"), { status: 401 });
  const second = await inventory.refreshInventory({ force: true });
  for (const kind of ["container", "volume", "network", "compose-project"]) {
    const rows = byKind(second, kind);
    assert.strictEqual(rows.length, before[kind], `${kind} kept`);
    assert.ok(rows.every((row) => row.stale && row.staleReason === "PERMISSION_DENIED"), `${kind} stale with PERMISSION_DENIED`);
  }
  for (const kind of ["instance", "service-managed-instance"]) {
    const rows = byKind(second, kind);
    assert.strictEqual(rows.length, before[kind]);
    assert.ok(rows.every((row) => row.stale && row.staleReason === "AUTH_FAILED"));
  }
  assert.ok(byKind(second, "listener").every((row) => row.stale === false), "readable sections stay fresh");
  assert.ok(byKind(second, "host").every((row) => row.stale === false));
  delete world.failures["/api/v1/docker"];
  delete world.failures["/api/v1/instances"];
  const third = await inventory.refreshInventory({ force: true });
  assert.ok(third.resources.every((row) => row.stale === false), "a later successful read clears staleness");
});

test("Docker not installed: section reported, no Docker follow-up reads", async () => {
  const { reader, world } = makeAgent({ dockerInstalled: false });
  setup({ reader, nodes: [agentNode("node-a")] });
  const snapshot = await inventory.refreshInventory();
  const docker = snapshot.nodes[0].sections.find((section) => section.name === "docker");
  assert.strictEqual(docker.code, "DOCKER_NOT_INSTALLED");
  assert.ok(!world.calls.some((call) => /volumes|networks|compose|inspect/.test(call.pathname)));
});

test("restart recovery: persisted resources reload stale; firstSeen survives", async () => {
  const { reader } = makeAgent();
  const storePath = path.join(tempRoot, "restart.json");
  setup({ reader, nodes: [agentNode("node-a")], storePath });
  clock = Date.parse("2026-10-14T10:00:00Z");
  await inventory.refreshInventory();
  // Simulate a desktop restart.
  inventory.resetInfrastructureInventory({ keepStore: true });
  const reloaded = inventory.getInventory();
  assert.ok(reloaded.resources.length > 0);
  assert.ok(reloaded.resources.every((resource) => resource.stale && resource.staleReason === "NOT_REFRESHED_SINCE_RESTART"));
  assert.ok(reloaded.nodes.every((node) => node.fromPreviousSession === true));
  clock += 3600000;
  const refreshed = await inventory.refreshInventory();
  assert.ok(refreshed.resources.every((resource) => resource.stale === false));
  assert.ok(refreshed.resources.every((resource) => resource.firstSeen === "2026-10-14T10:00:00.000Z"));
  assert.ok(refreshed.resources.every((resource) => resource.lastSeen === "2026-10-14T11:00:00.000Z"));
});

test("corrupt store is quarantined once; newer-schema store is never overwritten", async () => {
  const { reader } = makeAgent();
  const corrupt = path.join(tempRoot, "corrupt.json");
  fs.writeFileSync(corrupt, "{not json");
  setup({ reader, nodes: [agentNode("node-a")], storePath: corrupt });
  const empty = inventory.getInventory();
  assert.strictEqual(empty.resources.length, 0);
  assert.ok(empty.store.quarantine.path && fs.existsSync(empty.store.quarantine.path));
  assert.strictEqual(fs.readFileSync(empty.store.quarantine.path, "utf8"), "{not json", "quarantined bytes preserved (recoverable)");
  await inventory.refreshInventory();
  assert.ok(JSON.parse(fs.readFileSync(corrupt, "utf8")).resources.length > 0);

  const future = path.join(tempRoot, "future.json");
  const futureBody = JSON.stringify({ schemaVersion: 99, nodes: [], resources: [] });
  fs.writeFileSync(future, futureBody);
  setup({ reader, nodes: [agentNode("node-a")], storePath: future });
  const result = await inventory.refreshInventory();
  assert.strictEqual(result.store.readOnly, true);
  assert.strictEqual(result.store.quarantine.code, "INVENTORY_STORE_SCHEMA_UNSUPPORTED");
  assert.ok(result.resources.length > 0, "inventory still works in memory");
  assert.strictEqual(fs.readFileSync(future, "utf8"), futureBody, "newer store left untouched");
});

test("corrupt store leaves the active path: restarts without a refresh do not re-quarantine", async () => {
  const { reader } = makeAgent();
  const dir = fs.mkdtempSync(path.join(tempRoot, "requarantine-"));
  const store = path.join(dir, "inventory.json");
  fs.writeFileSync(store, "{still not json");
  const corruptCopies = () => fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
  setup({ reader, nodes: [agentNode("node-a")], storePath: store });
  const first = inventory.getInventory();
  assert.strictEqual(first.store.quarantine.code, "INVALID_JSON");
  assert.strictEqual(first.store.quarantine.method, "moved");
  assert.ok(!fs.existsSync(store), "the corrupt file is moved out of the active path");
  assert.strictEqual(fs.readFileSync(first.store.quarantine.path, "utf8"), "{still not json", "moved file is byte-identical (recoverable)");
  for (let restart = 0; restart < 3; restart += 1) {
    clock += 1000;
    inventory.resetInfrastructureInventory({ keepStore: true });
    const again = inventory.getInventory();
    assert.strictEqual(again.store.quarantine, null, `restart ${restart + 1}: nothing quarantined again`);
  }
  assert.strictEqual(corruptCopies().length, 1, "exactly one quarantined copy after repeated restarts");
  // Malformed-structure stores follow the same path.
  fs.writeFileSync(store, JSON.stringify({ schemaVersion: 1, nodes: [], resources: [null] }));
  inventory.resetInfrastructureInventory({ keepStore: true });
  assert.strictEqual(inventory.getInventory().store.quarantine.code, "INVENTORY_STORE_INVALID");
  inventory.resetInfrastructureInventory({ keepStore: true });
  assert.strictEqual(inventory.getInventory().store.quarantine, null);
  assert.strictEqual(corruptCopies().length, 2);
});

test("quarantine with every rename blocked: read-only, original untouched, one copy across restarts", async () => {
  const { reader } = makeAgent();
  const dir = fs.mkdtempSync(path.join(tempRoot, "locked-"));
  const store = path.join(dir, "inventory.json");
  fs.writeFileSync(store, "{locked and corrupt");
  const corruptCopies = () => fs.readdirSync(dir).filter((name) => name.includes(".corrupt-"));
  const blockedRename = () => { throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" }); };
  setup({ reader, nodes: [agentNode("node-a")], storePath: store });
  inventory.configureInfrastructureInventory({ renameSync: blockedRename });
  for (let restart = 0; restart < 3; restart += 1) {
    clock += 1000;
    inventory.resetInfrastructureInventory({ keepStore: true });
    const loaded = inventory.getInventory();
    assert.strictEqual(loaded.store.quarantine.method, "copied-not-replaced", `restart ${restart}: replacement failure is reported`);
    assert.strictEqual(loaded.store.readOnly, true, `restart ${restart}: session is read-only`);
    const refreshed = await inventory.refreshInventory({ force: true });
    assert.ok(refreshed.resources.length > 0, "inventory still works in memory");
  }
  assert.strictEqual(fs.readFileSync(store, "utf8"), "{locked and corrupt", "the active corrupt file is never written over");
  assert.strictEqual(corruptCopies().length, 1, "byte-identical copy reused, not accumulated");
  assert.strictEqual(fs.readFileSync(path.join(dir, corruptCopies()[0]), "utf8"), "{locked and corrupt");
  assert.ok(!fs.readdirSync(dir).some((name) => name.endsWith(".tmp")), "no temp file left behind");
});

test("a transient inspect gap keeps the verified volume and container records (stale)", async () => {
  const { reader, world } = makeAgent();
  setup({ reader, nodes: [agentNode("node-a")] });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const first = await inventory.refreshInventory();
  const volume = byKind(first, "volume")[0];
  const container = byKind(first, "container")[0];
  assert.ok(volume.identity.verified && container.identity.verified);
  const expectKept = (snapshot, kind, before, reason) => {
    const rows = byKind(snapshot, kind);
    assert.strictEqual(rows.length, 1, `${kind}: no duplicate unverified record`);
    assert.strictEqual(rows[0].key, before.key, `${kind}: verified key retained`);
    assert.strictEqual(rows[0].identity.verified, true, `${kind}: verified identity retained`);
    assert.strictEqual(rows[0].firstSeen, "2026-10-14T10:00:00.000Z", `${kind}: firstSeen retained`);
    assert.strictEqual(rows[0].stale, true);
    assert.strictEqual(rows[0].staleReason, reason, `${kind}: stale reason`);
  };
  // Leg 1: only the volume inspect fails (its mount is still observed).
  world.failures["/api/v1/docker/volumes/qdrant-data/inspect"] = () => Object.assign(new Error("timeout"), { code: "AGENT_TIMEOUT" });
  clock += 3600000;
  expectKept(await inventory.refreshInventory({ force: true }), "volume", volume, "IDENTITY_NOT_REREAD");
  // Leg 2: the container inspect fails too, so its mounts are unknown.
  world.failures[`/api/v1/docker/containers/${FULL_ID.slice(0, 12)}/inspect`] = () => Object.assign(new Error("timeout"), { code: "AGENT_TIMEOUT" });
  clock += 3600000;
  const gap = await inventory.refreshInventory({ force: true });
  expectKept(gap, "container", container, "IDENTITY_NOT_REREAD");
  expectKept(gap, "volume", volume, "DERIVED_FROM_PARTIAL_INSPECT");
  world.failures = {};
  clock += 3600000;
  const healed = await inventory.refreshInventory({ force: true });
  for (const [kind, before] of [["volume", volume], ["container", container]]) {
    const row = byKind(healed, kind)[0];
    assert.strictEqual(row.key, before.key);
    assert.strictEqual(row.stale, false);
    assert.strictEqual(row.firstSeen, "2026-10-14T10:00:00.000Z", `${kind}: history intact after the gap`);
  }
});

test("an identity change visible in the list is not masked by an inspect gap", async () => {
  // Container: inspect fails while the container list shows a rename.
  const { reader, world } = makeAgent();
  let listedName = "qdrant";
  const changing = async (pathname, options) => {
    const result = await reader(pathname, options);
    if (pathname === "/api/v1/docker/containers") result.containers = result.containers.map((entry) => ({ ...entry, name: listedName }));
    return result;
  };
  setup({ reader: changing, nodes: [agentNode("node-a")] });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const first = await inventory.refreshInventory();
  const oldContainer = byKind(first, "container")[0];
  const oldVolume = byKind(first, "volume")[0];
  world.failures[`/api/v1/docker/containers/${FULL_ID.slice(0, 12)}/inspect`] = () => Object.assign(new Error("timeout"), { code: "AGENT_TIMEOUT" });
  listedName = "qdrant-renamed";
  clock += 3600000;
  const second = await inventory.refreshInventory({ force: true });
  const renamed = byKind(second, "container");
  assert.strictEqual(renamed.length, 1, "container: one record");
  assert.notStrictEqual(renamed[0].key, oldContainer.key, "container: old verified key not reused");
  assert.strictEqual(renamed[0].identity.verified, false);
  assert.strictEqual(renamed[0].name, "qdrant-renamed");
  assert.strictEqual(model.applyProtection(renamed[0], { [oldContainer.key]: { scope: "non-production", ownerConfirmed: true } }).protection.scope, "production");
  // The volume's container could not be inspected, so the volume is unknown
  // this time: kept stale, never treated as deleted.
  const keptVolume = byKind(second, "volume");
  assert.strictEqual(keptVolume.length, 1);
  assert.strictEqual(keptVolume[0].key, oldVolume.key);
  assert.strictEqual(keptVolume[0].staleReason, "DERIVED_FROM_PARTIAL_INSPECT");

  // Volume: its own inspect fails while the mount (from the container inspect)
  // shows a driver change.
  delete world.failures[`/api/v1/docker/containers/${FULL_ID.slice(0, 12)}/inspect`];
  listedName = "qdrant";
  clock += 3600000;
  await inventory.refreshInventory({ force: true });
  world.failures["/api/v1/docker/volumes/qdrant-data/inspect"] = () => Object.assign(new Error("timeout"), { code: "AGENT_TIMEOUT" });
  world.volumes = world.volumes.map((volume) => ({ ...volume, driver: "nfs" }));
  clock += 3600000;
  const third = await inventory.refreshInventory({ force: true });
  const changedVolume = byKind(third, "volume");
  assert.strictEqual(changedVolume.length, 1, "volume: one record");
  assert.notStrictEqual(changedVolume[0].key, oldVolume.key, "volume: old verified key not reused after a driver change");
  assert.strictEqual(changedVolume[0].identity.verified, false);
  assert.strictEqual(changedVolume[0].stale, false);
  assert.strictEqual(model.applyProtection(changedVolume[0], { [oldVolume.key]: { scope: "non-production", ownerConfirmed: true } }).protection.scope, "production");
});

test("volume identity requires the driver, and the driver is part of the key", async () => {
  const { reader, world } = makeAgent();
  setup({ reader, nodes: [agentNode("node-a")] });
  const local = byKind(await inventory.refreshInventory(), "volume")[0];
  assert.strictEqual(local.identity.verified, true);
  world.volumes = world.volumes.map((volume) => ({ ...volume, driver: "nfs" }));
  clock += 3600000;
  const nfs = byKind(await inventory.refreshInventory({ force: true }), "volume")[0];
  assert.notStrictEqual(nfs.key, local.key, "a different driver is a different identity");
  world.volumes = world.volumes.map((volume) => ({ ...volume, driver: null }));
  clock += 3600000;
  const none = byKind(await inventory.refreshInventory({ force: true }), "volume")[0];
  assert.strictEqual(none.identity.verified, false, "no observed driver means unverified");
  assert.strictEqual(none.identity.reason, "VOLUME_DRIVER_UNAVAILABLE");
});

test("per-node cap: hard bound, low-cardinality kinds kept, containers absorb truncation", async () => {
  const { reader, world } = makeAgent();
  setup({ reader, nodes: [agentNode("node-a")] });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const first = await inventory.refreshInventory();
  const before = Object.fromEntries(["volume", "network", "compose-project"].map((kind) => [kind, byKind(first, kind).length]));
  assert.ok(before.volume > 0 && before.network > 0 && before["compose-project"] > 0);
  const bulk = (prefix) => Array.from({ length: model.LIMITS.maxResourcesPerNode + 50 }, (_, index) => ({ id: `${prefix}${String(index).padStart(11, "0")}`, name: `${prefix}-${index}`, state: "running", status: "Up", ports: [] }));
  world.containers = bulk("d");
  clock += 3600000;
  const capped = await inventory.refreshInventory({ force: true });
  assert.strictEqual(capped.nodes[0].limits.truncated, true, "truncation reported");
  assert.ok(capped.resources.length <= model.LIMITS.maxResourcesPerNode, `hard bound (${capped.resources.length})`);
  // Compose projects are prioritized and stay fresh; volumes and networks are
  // derived from container inspects the bulk containers exhaust, so they are
  // kept as stale with their history.
  const compose = byKind(capped, "compose-project");
  assert.strictEqual(compose.length, before["compose-project"]);
  assert.ok(compose.every((row) => row.stale === false), "compose kept fresh under the cap");
  for (const kind of ["volume", "network"]) {
    const rows = byKind(capped, kind);
    assert.strictEqual(rows.length, before[kind], `${kind}: kept under the cap`);
    assert.ok(rows.every((row) => row.stale && row.staleReason === "DERIVED_FROM_PARTIAL_INSPECT"), `${kind}: stale, partial inspect`);
    assert.ok(rows.every((row) => row.firstSeen === "2026-10-14T10:00:00.000Z"), `${kind}: history kept`);
  }
  assert.strictEqual(byKind(capped, "host").length, 1, "host never evicted");
  // Replacing the capped containers with different IDs must not grow the node
  // past the bound through stale carry-over.
  world.containers = bulk("e");
  clock += 3600000;
  const replaced = await inventory.refreshInventory({ force: true });
  assert.ok(replaced.resources.length <= model.LIMITS.maxResourcesPerNode, `still bounded after replacement (${replaced.resources.length})`);
  assert.strictEqual(byKind(replaced, "compose-project").length, before["compose-project"]);
  assert.strictEqual(byKind(replaced, "volume").length, before.volume);
});

test("shared records stay with their other node when one registration stops reporting them", async () => {
  const down = new Set();
  const { reader: base } = makeAgent();
  const perNode = async (pathname, options) => {
    const nodeId = options?.config?.nodeId;
    if (down.has(nodeId)) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    const result = await base(pathname, options);
    // node-a is later repointed to a different Agent (different device).
    if (nodeId === "node-a" && repointed && pathname === "/api/v1/health") return { ...result, identity: identity("dev-2", "inst-2", "gen-1") };
    return result;
  };
  let repointed = false;
  const nodes = [agentNode("node-a", { agentIdentity: {} }), agentNode("node-b")];
  setup({ reader: perNode, nodes });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const first = await inventory.refreshInventory();
  const host = byKind(first, "host")[0];
  assert.deepStrictEqual(host.nodeIds, ["node-a", "node-b"], "one host shared by both registrations");
  repointed = true;
  down.add("node-b");
  clock += 3600000;
  const second = await inventory.refreshInventory({ force: true });
  const kept = second.resources.find((resource) => resource.key === host.key);
  assert.ok(kept, "shared host not deleted when node-a stops reporting it and node-b is down");
  assert.deepStrictEqual(kept.nodeIds, ["node-b"], "only node-a's association removed");
  assert.strictEqual(kept.stale, true);
  down.delete("node-b");
  clock += 3600000;
  const third = await inventory.refreshInventory({ force: true });
  const back = third.resources.find((resource) => resource.key === host.key);
  assert.strictEqual(back.stale, false);
  assert.strictEqual(back.firstSeen, "2026-10-14T10:00:00.000Z", "history preserved for node-b");
});

test("listener enumeration unsupported keeps known listeners as stale", async () => {
  const { reader } = makeAgent();
  let unsupported = false;
  const listeners = async (pathname, options) => {
    if (unsupported && pathname === "/api/v1/network/inventory") return { supported: false, listeners: [], listenerSource: null };
    return reader(pathname, options);
  };
  setup({ reader: listeners, nodes: [agentNode("node-a")] });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const before = byKind(await inventory.refreshInventory(), "listener");
  assert.ok(before.length > 0);
  unsupported = true;
  clock += 3600000;
  const after = await inventory.refreshInventory({ force: true });
  const kept = byKind(after, "listener");
  assert.strictEqual(kept.length, before.length, "listeners not deleted");
  assert.ok(kept.every((row) => row.stale && row.staleReason === "LISTENERS_UNSUPPORTED"));
  assert.strictEqual(after.nodes[0].sections.find((section) => section.name === "listeners").code, "LISTENERS_UNSUPPORTED");
});

test("a node removed from the registry is removed from shared records, including carried ones", async () => {
  const { reader, world } = makeAgent();
  const nodes = [agentNode("node-a"), agentNode("node-b")];
  setup({ reader, nodes });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const first = await inventory.refreshInventory();
  assert.deepStrictEqual(byKind(first, "host")[0].nodeIds, ["node-a", "node-b"]);
  assert.deepStrictEqual(byKind(first, "container")[0].nodeIds, ["node-a", "node-b"]);
  // node-b is unregistered; node-a cannot read Docker, so its containers are
  // carried forward as stale with their old association.
  nodes.pop();
  world.failures["/api/v1/docker"] = () => Object.assign(new Error("Forbidden"), { status: 403 });
  clock += 3600000;
  const after = await inventory.refreshInventory({ force: true });
  const host = byKind(after, "host");
  assert.deepStrictEqual(host[0].nodeIds, ["node-a"], "re-reported record: unregistered node removed");
  const carried = byKind(after, "container");
  assert.strictEqual(carried.length, 1);
  assert.strictEqual(carried[0].stale, true, "carried forward as stale");
  assert.deepStrictEqual(carried[0].nodeIds, ["node-a"], "carried record: unregistered node removed from the association");
  assert.ok(!carried[0].duplicateNodes, "no longer reported as duplicated");
});

test("per-node cap also bounds records shared with an unavailable twin registration", async () => {
  const down = new Set();
  let prefix = "s";
  let count = 1500;
  const twin = async (pathname, options) => {
    const nodeId = options?.config?.nodeId;
    if (down.has(nodeId)) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    if (pathname === "/api/v1/health") return { identity: identity(), capabilities: {} };
    if (pathname === "/api/v1/docker/containers") {
      return { installed: true, daemonRunning: true, containers: Array.from({ length: count }, (_, index) => ({ id: `${prefix}${String(index).padStart(11, "0")}`, name: `${prefix}-${index}`, state: "running", status: "Up" })) };
    }
    if (pathname.endsWith("/inspect")) throw Object.assign(new Error("skip"), { code: "AGENT_TIMEOUT" });
    if (pathname === "/api/v1/docker/compose/projects") return { projects: [] };
    if (pathname === "/api/v1/instances") return { instances: [] };
    if (pathname === "/api/v1/network/inventory") return { listeners: [] };
    return {};
  };
  setup({ reader: twin, nodes: [agentNode("node-a"), agentNode("node-b")] });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const first = await inventory.refreshInventory();
  assert.strictEqual(byKind(first, "container").filter((row) => row.nodeIds.length === 2).length, 1500, "1,500 shared containers");
  down.add("node-b");
  prefix = "n";
  count = model.LIMITS.maxResourcesPerNode + 50;
  clock += 3600000;
  const second = await inventory.refreshInventory({ force: true });
  const ownedByA = second.resources.filter((row) => (row.nodeIds || [row.nodeId]).includes("node-a")).length;
  assert.ok(ownedByA <= model.LIMITS.maxResourcesPerNode, `node-a within its bound (${ownedByA})`);
  const keptForB = second.resources.filter((row) => row.kind === "container" && row.key.includes(":container:s"));
  assert.strictEqual(keptForB.length, 1500, "the twin's last-known containers are kept");
  assert.ok(keptForB.every((row) => !row.nodeIds.includes("node-a")), "node-a detached from the overflow rows");
});

test("an unavailable twin registration keeps its association on re-reported records", async () => {
  const down = new Set();
  const { reader: base } = makeAgent();
  const twin = async (pathname, options) => {
    if (down.has(options?.config?.nodeId)) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    return base(pathname, options);
  };
  setup({ reader: twin, nodes: [agentNode("node-a"), agentNode("node-b")] });
  const first = byKind(await inventory.refreshInventory(), "host")[0];
  assert.deepStrictEqual(first.nodeIds, ["node-a", "node-b"]);
  down.add("node-b");
  clock += 3600000;
  const second = await inventory.refreshInventory({ force: true });
  const host = byKind(second, "host")[0];
  assert.deepStrictEqual(host.nodeIds, ["node-a", "node-b"], "node-b's association survives its own outage");
  assert.strictEqual(host.duplicateNodes, true);
  assert.strictEqual(second.nodes.find((node) => node.nodeId === "node-b").status, "unavailable");
});

test("post-merge cap keeps fresh rows over stale ones and reports what it evicted", async () => {
  const { reader, world } = makeAgent({ listeners: [] });
  world.containers = Array.from({ length: model.LIMITS.maxResourcesPerNode - 1 }, (_, index) => ({ id: `k${String(index).padStart(11, "0")}`, name: `k-${index}`, state: "running", status: "Up" }));
  world.instances = [];
  world.projects = [];
  setup({ reader, nodes: [agentNode("node-a")] });
  clock = Date.parse("2026-10-14T10:00:00Z");
  await inventory.refreshInventory();
  // Docker read now fails (containers carried stale) while 200 listeners arrive.
  world.failures["/api/v1/docker"] = () => Object.assign(new Error("Forbidden"), { status: 403 });
  world.listeners = Array.from({ length: 200 }, (_, index) => ({ protocol: "tcp", localAddress: "0.0.0.0", localPort: 20000 + index, pid: 1 }));
  clock += 3600000;
  const after = await inventory.refreshInventory({ force: true });
  assert.ok(after.resources.length <= model.LIMITS.maxResourcesPerNode, "bound holds");
  assert.strictEqual(byKind(after, "listener").length, 200, "every fresh listener kept");
  assert.ok(byKind(after, "listener").every((row) => row.stale === false));
  const limits = after.nodes[0].limits;
  assert.strictEqual(limits.truncated, true, "post-merge eviction reported as truncation");
  assert.ok(limits.capEvicted > 0, "eviction count reported");
  assert.strictEqual(limits.capEvictedFresh, 0, "no fresh row evicted");
  assert.ok(limits.capEvictedByKind.container > 0, "stale containers absorbed the eviction");
  assert.strictEqual(after.summary.nodesPartial, 1, "node reported as partial");
});

test("a collected node with unread sections is partial, not complete", async () => {
  const { reader } = makeAgent({ failures: { "/api/v1/docker": () => Object.assign(new Error("Forbidden"), { status: 403 }) } });
  setup({ reader, nodes: [agentNode("node-a")] });
  const snapshot = await inventory.refreshInventory();
  assert.strictEqual(snapshot.summary.stale, 0, "first refresh: nothing stale");
  assert.strictEqual(snapshot.summary.nodesUnavailable, 0);
  assert.strictEqual(snapshot.summary.nodesPartial, 1, "unread Docker section makes the node partial");
});

test("node totals count Agent nodes only", async () => {
  const { reader } = makeAgent();
  setup({ reader, nodes: [{ id: "application-host", kind: "application-host", displayName: "This PC" }, agentNode("node-a")] });
  const snapshot = await inventory.refreshInventory();
  assert.strictEqual(snapshot.summary.nodes, 1);
  assert.strictEqual(snapshot.summary.nodesAvailable, 1);
  assert.strictEqual(snapshot.summary.nodesUnavailable, 0, "the application host does not make a complete inventory incomplete");
});

test("heavy Agent list routes are never called; volumes and networks come from bounded inspects", async () => {
  for (const pathname of ["/api/v1/docker/volumes", "/api/v1/docker/networks"]) {
    assert.throws(() => inventory.assertReadRoute("GET", pathname), (error) => error.code === "INVENTORY_ROUTE_NOT_ALLOWED", pathname);
  }
  const { reader, world } = makeAgent({
    volumes: [{ name: "qdrant-data", driver: "local" }, { name: "qdrant-snapshots", driver: "local" }],
    networks: [{ id: "net-a", name: "ai-box" }, { id: "net-b", name: "edge" }],
  });
  setup({ reader, nodes: [agentNode("node-a")] });
  const snapshot = await inventory.refreshInventory();
  assert.ok(!world.calls.some((call) => call.pathname === "/api/v1/docker/volumes" || call.pathname === "/api/v1/docker/networks"), "list routes never requested");
  assert.deepStrictEqual(byKind(snapshot, "volume").map((volume) => volume.name).sort(), ["qdrant-data", "qdrant-snapshots"]);
  assert.deepStrictEqual(byKind(snapshot, "network").map((network) => network.name).sort(), ["ai-box", "edge"]);
  const inspectCalls = world.calls.filter((call) => call.pathname.endsWith("/inspect")).length;
  assert.ok(inspectCalls <= model.LIMITS.maxInspectsPerNode, `inspects bounded (${inspectCalls})`);
  const sections = Object.fromEntries(snapshot.nodes[0].sections.map((section) => [section.name, section]));
  assert.strictEqual(sections.volumes.scope, "attached-to-containers", "partial coverage disclosed");
});

test("a different reported device is refused even when the rest of the identity is missing", async () => {
  const { reader, world } = makeAgent({ identity: { deviceId: "other-device", hostname: "h" } });
  setup({ reader, nodes: [agentNode("node-a", { deviceId: "dev-1" })] });
  const snapshot = await inventory.refreshInventory();
  assert.strictEqual(snapshot.nodes[0].code, "AGENT_IDENTITY_MISMATCH");
  assert.strictEqual(snapshot.resources.length, 0, "nothing attributed to the registered node");
  assert.deepStrictEqual(world.calls.map((call) => call.pathname), ["/api/v1/health"], "no further reads after the mismatch");
});

test("a network recreated under the same name is a new resource", async () => {
  const { reader, world } = makeAgent();
  setup({ reader, nodes: [agentNode("node-a")] });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const before = byKind(await inventory.refreshInventory(), "network")[0];
  assert.ok(before.identity.components.networkId, "full network ID recorded");
  world.networks = world.networks.map((network) => ({ ...network, fullId: "f".repeat(64) }));
  clock += 3600000;
  const after = byKind(await inventory.refreshInventory({ force: true }), "network");
  assert.strictEqual(after.length, 1);
  assert.notStrictEqual(after[0].key, before.key, "new network ID, new key");
  assert.strictEqual(after[0].firstSeen, "2026-10-14T11:00:00.000Z", "firstSeen not inherited");
});

test("fleet-wide cap evicts only the oldest stale records and never drops fresh ones", async () => {
  const perNode = 1990;
  const down = new Set();
  const fleetReader = async (pathname, options) => {
    const nodeId = options?.config?.nodeId;
    if (down.has(nodeId)) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    if (pathname === "/api/v1/health") return { identity: { deviceId: `dev-${nodeId}`, agentInstallationId: "i", agentIdentityGeneration: "g" }, capabilities: {} };
    if (pathname === "/api/v1/docker/containers") {
      return { installed: true, daemonRunning: true, containers: Array.from({ length: perNode }, (_, index) => ({ id: `${nodeId.slice(-2)}${String(index).padStart(10, "0")}`, name: `c${index}`, state: "running", status: "Up" })) };
    }
    if (pathname.endsWith("/inspect")) throw Object.assign(new Error("skip"), { code: "AGENT_TIMEOUT" });
    if (pathname === "/api/v1/docker/compose/projects") return { projects: [] };
    if (pathname === "/api/v1/instances") return { instances: [] };
    if (pathname === "/api/v1/network/inventory") return { listeners: [] };
    return {};
  };
  const nodes = Array.from({ length: 11 }, (_, index) => agentNode(`node-${String(index).padStart(2, "0")}`, { deviceId: `dev-node-${String(index).padStart(2, "0")}` }));
  setup({ reader: fleetReader, nodes });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const first = await inventory.refreshInventory();
  const total = first.resources.length;
  assert.ok(total > 20000, `fixture exceeds the fleet cap (${total})`);
  assert.strictEqual(first.fleetLimit.overCap, true, "overflow is reported");
  assert.strictEqual(first.fleetLimit.evictedStale, 0, "nothing fresh is evicted");
  assert.ok(first.resources.every((resource) => resource.stale === false));
  down.add("node-00");
  down.add("node-01");
  clock += 3600000;
  const second = await inventory.refreshInventory({ force: true });
  assert.ok(second.fleetLimit.evictedStale > 0, "stale records evicted to make room");
  assert.strictEqual(second.resources.length, 20000);
  assert.strictEqual(second.fleetLimit.overCap, false);
  const freshNow = second.resources.filter((resource) => resource.stale === false).length;
  assert.strictEqual(freshNow, total - 2 * (perNode + 1), "every fresh record kept");
});

test("container rename or compose move with the same Docker ID is a new identity", async () => {
  const { reader } = makeAgent();
  let labels = { "com.docker.compose.project": "ai-box", "com.docker.compose.service": "qdrant" };
  let listedName = "qdrant";
  const mutable = async (pathname, options) => {
    const result = await reader(pathname, options);
    if (pathname === "/api/v1/docker/containers") result.containers = result.containers.map((entry) => ({ ...entry, name: listedName }));
    if (pathname.startsWith("/api/v1/docker/containers/") && pathname.endsWith("/inspect")) {
      result.inspect[0].Config.Labels = labels;
      result.inspect[0].Name = `/${listedName}`;
    }
    return result;
  };
  setup({ reader: mutable, nodes: [agentNode("node-a")] });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const original = byKind(await inventory.refreshInventory(), "container")[0];
  listedName = "qdrant-renamed";
  clock += 3600000;
  const renamed = byKind(await inventory.refreshInventory({ force: true }), "container");
  assert.strictEqual(renamed.length, 1);
  assert.strictEqual(renamed[0].identity.components.containerId, original.identity.components.containerId, "same Docker ID");
  assert.notStrictEqual(renamed[0].key, original.key, "rename changes the key");
  assert.strictEqual(renamed[0].firstSeen, "2026-10-14T11:00:00.000Z");
  labels = { "com.docker.compose.project": "other-stack", "com.docker.compose.service": "qdrant" };
  clock += 3600000;
  const moved = byKind(await inventory.refreshInventory({ force: true }), "container")[0];
  assert.notStrictEqual(moved.key, renamed[0].key, "compose move changes the key");
  const classified = model.applyProtection(moved, { [original.key]: { scope: "non-production", ownerConfirmed: true }, [renamed[0].key]: { scope: "non-production", ownerConfirmed: true } });
  assert.strictEqual(classified.protection.scope, "production", "no classification carries across");
});

test("compose project moved to another config path is a new identity", async () => {
  let configFiles = "/srv/ai-box/compose.yaml";
  const { reader } = makeAgent();
  const moving = async (pathname, options) => {
    const result = await reader(pathname, options);
    if (pathname === "/api/v1/docker/compose/projects") result.projects = [{ Name: "ai-box", Status: "running(1)", ConfigFiles: configFiles }];
    return result;
  };
  setup({ reader: moving, nodes: [agentNode("node-a")] });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const before = byKind(await inventory.refreshInventory(), "compose-project")[0];
  configFiles = "/opt/new-home/compose.yaml";
  clock += 3600000;
  const after = byKind(await inventory.refreshInventory({ force: true }), "compose-project");
  assert.strictEqual(after.length, 1);
  assert.notStrictEqual(after[0].key, before.key, "config path change changes the key");
  assert.strictEqual(after[0].firstSeen, "2026-10-14T11:00:00.000Z");
  assert.strictEqual(model.applyProtection(after[0], { [before.key]: { scope: "non-production", ownerConfirmed: true } }).protection.scope, "production");
});

test("host identity rotation: new generation is a new host and new children", async () => {
  const { reader, world } = makeAgent();
  setup({ reader, nodes: [agentNode("node-a")] });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const before = await inventory.refreshInventory();
  const oldKeys = new Set(before.resources.map((resource) => resource.key));
  const oldHost = byKind(before, "host")[0];
  const oldSvc = byKind(before, "service-managed-instance")[0];
  // Re-pairing / credential rotation: only agentIdentityGeneration changes.
  world.identity = identity("dev-1", "inst-1", "gen-2");
  clock += 3600000;
  const after = await inventory.refreshInventory({ force: true });
  const host = byKind(after, "host")[0];
  assert.strictEqual(byKind(after, "host").length, 1, "the old host identity is not carried alongside");
  assert.notStrictEqual(host.key, oldHost.key, "host key changes with the generation");
  assert.strictEqual(host.firstSeen, "2026-10-14T11:00:00.000Z", "host firstSeen not inherited");
  assert.ok(after.resources.length >= 8, "every kind present after rotation");
  for (const resource of after.resources) {
    assert.ok(!oldKeys.has(resource.key), `${resource.kind} ${resource.key} must get a new key`);
    assert.strictEqual(resource.firstSeen, "2026-10-14T11:00:00.000Z", `${resource.kind} firstSeen not inherited`);
  }
  const svc = byKind(after, "service-managed-instance")[0];
  assert.strictEqual(svc.identity.components.host, host.key);
  const classifications = {
    [oldHost.key]: { scope: "non-production", ownerConfirmed: true },
    [oldSvc.key]: { scope: "non-production", ownerConfirmed: true },
  };
  assert.strictEqual(model.applyProtection(host, classifications).protection.scope, "production", "host classification does not survive rotation");
  assert.strictEqual(model.applyProtection(svc, classifications).protection.scope, "production", "child classification does not survive rotation");
});

test("structurally malformed stores are quarantined, not fatal", async () => {
  const { reader } = makeAgent();
  for (const [label, body] of [
    ["null resource", { schemaVersion: 1, nodes: [], resources: [null] }],
    ["resource without key", { schemaVersion: 1, nodes: [], resources: [{ kind: "host", nodeId: "n" }] }],
    ["unknown kind", { schemaVersion: 1, nodes: [], resources: [{ key: "k", kind: "spaceship", nodeId: "n" }] }],
    ["string node", { schemaVersion: 1, nodes: ["node-a"], resources: [] }],
    ["array classifications", { schemaVersion: 1, nodes: [], resources: [], classifications: [] }],
  ]) {
    const store = path.join(tempRoot, `malformed-${label.replace(/[^a-z0-9]+/gi, "-")}.json`);
    fs.writeFileSync(store, JSON.stringify(body));
    setup({ reader, nodes: [agentNode("node-a")], storePath: store });
    const loaded = inventory.getInventory();
    assert.strictEqual(loaded.resources.length, 0, label);
    assert.strictEqual(loaded.store.quarantine.code, "INVENTORY_STORE_INVALID", label);
    assert.ok(fs.existsSync(loaded.store.quarantine.path), `${label}: quarantined copy kept`);
    const refreshed = await inventory.refreshInventory({ force: true });
    assert.ok(refreshed.resources.length > 0, `${label}: inventory usable after quarantine`);
  }
});

test("a volume recreated under the same name is a new resource", async () => {
  const { reader, world } = makeAgent();
  const original = reader;
  let createdAt = "2026-09-30T12:00:00Z";
  const recreating = async (pathname, options) => {
    const result = await original(pathname, options);
    if (pathname.startsWith("/api/v1/docker/volumes/") && pathname.endsWith("/inspect")) result.inspect[0].CreatedAt = createdAt;
    return result;
  };
  setup({ reader: recreating, nodes: [agentNode("node-a")] });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const first = byKind(await inventory.refreshInventory(), "volume")[0];
  createdAt = "2026-10-14T10:30:00Z";
  clock += 3600000;
  const second = byKind(await inventory.refreshInventory({ force: true }), "volume");
  assert.strictEqual(second.length, 1, "old volume not carried alongside the new one");
  assert.notStrictEqual(second[0].key, first.key, "recreated volume gets a new key");
  assert.strictEqual(second[0].firstSeen, "2026-10-14T11:00:00.000Z", "firstSeen not inherited");
  const classified = model.applyProtection(second[0], { [first.key]: { scope: "non-production", ownerConfirmed: true } });
  assert.strictEqual(classified.protection.scope, "production", "old classification does not transfer");
  assert.ok(world.calls.length > 0);
});

test("single-flight and throttle: concurrent refreshes share one run", async () => {
  const { reader, world } = makeAgent();
  setup({ reader, nodes: [agentNode("node-a")] });
  const [a, b] = await Promise.all([inventory.refreshInventory(), inventory.refreshInventory()]);
  assert.strictEqual(world.calls.filter((call) => call.pathname === "/api/v1/health").length, 1);
  assert.strictEqual(b.joined, true);
  assert.strictEqual(a.resources.length, b.resources.length);
  const throttled = await inventory.refreshInventory();
  assert.strictEqual(throttled.throttled, true);
  assert.strictEqual(world.calls.filter((call) => call.pathname === "/api/v1/health").length, 1);
  await inventory.refreshInventory({ force: true });
  assert.strictEqual(world.calls.filter((call) => call.pathname === "/api/v1/health").length, 2);
});

test("unregistered node: resources stale, then pruned after retention", async () => {
  const { reader } = makeAgent();
  const nodes = [agentNode("node-a")];
  setup({ reader, nodes });
  clock = Date.parse("2026-10-14T10:00:00Z");
  await inventory.refreshInventory();
  nodes.length = 0;
  clock += 60000;
  const removed = await inventory.refreshInventory({ force: true });
  assert.ok(removed.resources.length > 0 && removed.resources.every((resource) => resource.staleReason === "NODE_NOT_REGISTERED"));
  clock += inventory.UNREGISTERED_RETENTION_MS + 1000;
  const pruned = await inventory.refreshInventory({ force: true });
  assert.strictEqual(pruned.resources.length, 0);
});

test("bounds: listeners and inspect calls are capped and reported", async () => {
  const listeners = Array.from({ length: 300 }, (_, index) => ({ protocol: "tcp", localAddress: "0.0.0.0", localPort: 10000 + index, pid: 1 }));
  const containers = Array.from({ length: 60 }, (_, index) => ({ id: `c${String(index).padStart(11, "0")}`, name: `c${index}`, state: "running", status: "Up", ports: [] }));
  const { reader, world } = makeAgent({ listeners, containers, volumes: [] });
  setup({ reader, nodes: [agentNode("node-a")] });
  const snapshot = await inventory.refreshInventory();
  assert.strictEqual(byKind(snapshot, "listener").length, model.LIMITS.maxListenersPerNode);
  assert.strictEqual(snapshot.nodes[0].limits.listenersTruncated, true);
  assert.strictEqual(world.calls.filter((call) => call.pathname.endsWith("/inspect")).length, model.LIMITS.maxInspectsPerNode);
  assert.strictEqual(snapshot.nodes[0].limits.inspectsSkipped, 20);
  const uninspected = byKind(snapshot, "container").filter((container) => container.identity.reason === "CONTAINER_NOT_INSPECTED");
  assert.strictEqual(uninspected.length, 20);
});

test("service-managed edge cases: unobserved, not allowlisted, MainPID change", async () => {
  const instances = [{
    id: "svc", type: "systemd-service", state: "Unknown",
    serviceManager: { kind: "systemd", unit: "other.service" },
    serviceStatus: { observed: false, unit: "other.service", error: "SERVICE_QUERY_FAILED" },
  }];
  const { reader, world } = makeAgent({ instances });
  setup({ reader, nodes: [agentNode("node-a")] });
  let snapshot = await inventory.refreshInventory();
  let svc = byKind(snapshot, "service-managed-instance")[0];
  assert.strictEqual(svc.health.state, "unknown", "unreadable service is unknown, never stopped");
  assert.strictEqual(svc.capabilities.unitAllowlisted, false);
  const key = svc.key;
  world.instances = [{ ...instances[0], state: "Running", serviceStatus: { observed: true, unit: "other.service", activeState: "active", externalMainPid: 1 } }];
  snapshot = await inventory.refreshInventory({ force: true });
  world.instances = [{ ...instances[0], state: "Running", serviceStatus: { observed: true, unit: "other.service", activeState: "active", externalMainPid: 2 } }];
  snapshot = await inventory.refreshInventory({ force: true });
  svc = byKind(snapshot, "service-managed-instance")[0];
  assert.strictEqual(svc.key, key, "a systemd restart (new MainPID) keeps the same identity");
  assert.strictEqual(svc.details.externalMainPid, 2);
});

test("allow-list judgment is not applicable on hosts without service-managed support", async () => {
  const { reader, world } = makeAgent();
  const original = reader;
  const unsupported = async (pathname, options) => {
    const result = await original(pathname, options);
    if (pathname === "/api/v1/health") result.capabilities.serviceManagedInstances = { supported: false, mechanism: null, allowedUnits: [] };
    return result;
  };
  setup({ reader: unsupported, nodes: [agentNode("node-a")] });
  const snapshot = await inventory.refreshInventory();
  const svc = byKind(snapshot, "service-managed-instance")[0];
  assert.strictEqual(svc.capabilities.unitAllowlisted, null);
  assert.ok(world.calls.length > 0);
});

test("container health uses the Agent-normalized state and the Docker status text", async () => {
  const rows = [
    { id: "h00000000001", name: "exited", state: "stopped", status: "Exited (1) 2 minutes ago", expect: "stopped" },
    { id: "h00000000002", name: "restarting", state: "stopped", status: "Restarting (1) 5 seconds ago", expect: "degraded" },
    { id: "h00000000003", name: "dead", state: "stopped", status: "Dead", expect: "failed" },
    { id: "h00000000004", name: "paused", state: "paused", status: "Up 2 hours (Paused)", expect: "stopped" },
    { id: "h00000000005", name: "running", state: "running", status: "Up 3 hours", expect: "healthy" },
    { id: "h00000000006", name: "unhealthy", state: "running", status: "Up 3 hours (unhealthy)", health: "unhealthy", expect: "failed" },
  ];
  const { reader } = makeAgent({ containers: rows.map(({ expect, ...row }) => row), volumes: [] });
  setup({ reader, nodes: [agentNode("node-a")] });
  const snapshot = await inventory.refreshInventory();
  for (const row of rows) {
    const container = byKind(snapshot, "container").find((resource) => resource.name === row.name);
    assert.ok(container, `${row.name}: listed`);
    assert.strictEqual(container.health.state, row.expect, `${row.name}: health`);
  }
});

test("a transient inspect gap keeps a twin registration's association", async () => {
  const down = new Set();
  const { reader: base, world } = makeAgent();
  const twin = async (pathname, options) => {
    if (down.has(options?.config?.nodeId)) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    return base(pathname, options);
  };
  setup({ reader: twin, nodes: [agentNode("node-a"), agentNode("node-b")] });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const container = byKind(await inventory.refreshInventory(), "container")[0];
  assert.deepStrictEqual(container.nodeIds, ["node-a", "node-b"]);
  down.add("node-b");
  world.failures[`/api/v1/docker/containers/${FULL_ID.slice(0, 12)}/inspect`] = () => Object.assign(new Error("timeout"), { code: "AGENT_TIMEOUT" });
  clock += 3600000;
  const kept = byKind(await inventory.refreshInventory({ force: true }), "container");
  assert.strictEqual(kept.length, 1);
  assert.strictEqual(kept[0].key, container.key, "verified key retained");
  assert.strictEqual(kept[0].stale, true);
  assert.deepStrictEqual(kept[0].nodeIds, ["node-a", "node-b"], "unavailable twin keeps its association");
});

test("truncated listener reads keep unseen listeners stale and mark the node partial", async () => {
  const { reader } = makeAgent();
  let truncated = false;
  const listeners = async (pathname, options) => {
    if (truncated && pathname === "/api/v1/network/inventory") {
      return { listeners: [{ protocol: "tcp", localAddress: "0.0.0.0", localPort: 7000, pid: 1 }], listenersTruncated: true };
    }
    return reader(pathname, options);
  };
  setup({ reader: listeners, nodes: [agentNode("node-a")] });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const before = byKind(await inventory.refreshInventory(), "listener");
  assert.strictEqual(before.length, 1);
  truncated = true;
  clock += 3600000;
  const after = await inventory.refreshInventory({ force: true });
  const known = byKind(after, "listener").find((row) => row.key === before[0].key);
  assert.ok(known, "listener outside the truncated prefix is not deleted");
  assert.strictEqual(known.stale, true);
  assert.strictEqual(known.staleReason, "LISTENERS_TRUNCATED");
  assert.strictEqual(after.nodes[0].sections.find((section) => section.name === "listeners").status, "partial");
  assert.strictEqual(after.summary.nodesPartial, 1);
});

test("failed container inspects make the derived volume and network sections partial", async () => {
  const { reader } = makeAgent({ failures: { [`/api/v1/docker/containers/${FULL_ID.slice(0, 12)}/inspect`]: () => Object.assign(new Error("timeout"), { code: "AGENT_TIMEOUT" }) } });
  setup({ reader, nodes: [agentNode("node-a")] });
  const snapshot = await inventory.refreshInventory();
  for (const name of ["volumes", "networks"]) {
    const section = snapshot.nodes[0].sections.find((entry) => entry.name === name);
    assert.strictEqual(section.status, "partial", `${name}: partial`);
    assert.strictEqual(section.code, "DERIVED_FROM_PARTIAL_INSPECT");
  }
  assert.strictEqual(snapshot.summary.nodesPartial, 1);
});

test("listener enumeration errors keep unseen listeners stale; process-name errors do not", async () => {
  const { reader } = makeAgent();
  let payload = null;
  const listeners = async (pathname, options) => (payload && pathname === "/api/v1/network/inventory" ? payload : reader(pathname, options));
  setup({ reader: listeners, nodes: [agentNode("node-a")] });
  clock = Date.parse("2026-10-14T10:00:00Z");
  const before = byKind(await inventory.refreshInventory(), "listener");
  assert.strictEqual(before.length, 1);
  // ss (udp) failed: only TCP rows came back, and the known listener is not among them.
  payload = { supported: true, listeners: [{ protocol: "tcp", localAddress: "0.0.0.0", localPort: 7001, pid: 1 }], listenersTruncated: false, errors: ["ss (udp): command failed"] };
  clock += 3600000;
  const partial = await inventory.refreshInventory({ force: true });
  const known = byKind(partial, "listener").find((row) => row.key === before[0].key);
  assert.ok(known, "listener missing from a partial read is not deleted");
  assert.strictEqual(known.staleReason, "LISTENERS_PARTIAL_READ");
  const section = partial.nodes[0].sections.find((entry) => entry.name === "listeners");
  assert.strictEqual(section.status, "partial");
  assert.strictEqual(partial.summary.nodesPartial, 1);
  // A Windows tasklist failure only loses process names: the read is complete.
  payload = { supported: true, listeners: [{ protocol: "tcp", localAddress: "0.0.0.0", localPort: 7001, pid: 1 }], listenersTruncated: false, errors: ["tasklist: access denied"] };
  clock += 3600000;
  const complete = await inventory.refreshInventory({ force: true });
  assert.strictEqual(complete.nodes[0].sections.find((entry) => entry.name === "listeners").status, "ok");
  assert.strictEqual(complete.summary.nodesPartial, 0);
});

test("a reachable twin's confirmation is not overwritten by an unreachable twin, in either order", async () => {
  for (const order of [["node-a", "node-b"], ["node-b", "node-a"]]) {
    const down = new Set();
    const { reader: base } = makeAgent();
    const twin = async (pathname, options) => {
      if (down.has(options?.config?.nodeId)) throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
      return base(pathname, options);
    };
    setup({ reader: twin, nodes: order.map((id) => agentNode(id)) });
    clock = Date.parse("2026-10-14T10:00:00Z");
    await inventory.refreshInventory();
    down.add("node-b");
    clock += 3600000;
    const snapshot = await inventory.refreshInventory({ force: true });
    for (const kind of ["host", "container", "listener"]) {
      const row = byKind(snapshot, kind)[0];
      assert.strictEqual(row.stale, false, `${order.join(",")} ${kind}: fresh via node-a`);
      assert.strictEqual(row.lastSeen, new Date(clock).toISOString());
      assert.deepStrictEqual(row.nodeIds, ["node-a", "node-b"], `${kind}: node-b association kept`);
    }
    assert.strictEqual(snapshot.nodes.find((node) => node.nodeId === "node-b").status, "unavailable", "the outage is reported on node-b");
  }
});

test("unregistered retention starts at removal, not at the last successful discovery", async () => {
  const { reader, world } = makeAgent();
  const nodes = [agentNode("node-a")];
  setup({ reader, nodes });
  clock = Date.parse("2026-10-01T10:00:00Z");
  await inventory.refreshInventory();
  // Offline for eight days, then removed from the registry.
  world.failures["/api/v1/"] = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
  clock += 8 * 24 * 3600000;
  await inventory.refreshInventory({ force: true });
  nodes.length = 0;
  clock += 60000;
  const removedAt = new Date(clock).toISOString();
  const removed = await inventory.refreshInventory({ force: true });
  assert.ok(removed.resources.length > 0, "full grace period after removal");
  assert.ok(removed.resources.every((row) => row.staleReason === "NODE_NOT_REGISTERED" && row.unregisteredAt === removedAt));
  clock += inventory.UNREGISTERED_RETENTION_MS - 3600000;
  const later = await inventory.refreshInventory({ force: true });
  assert.ok(later.resources.length > 0, "still within the window");
  assert.ok(later.resources.every((row) => row.unregisteredAt === removedAt), "window start is not reset");
  clock += 2 * 3600000;
  assert.strictEqual((await inventory.refreshInventory({ force: true })).resources.length, 0, "pruned once the window ends");
});

test("a twin's unread section does not stale records the other twin confirmed, in either order", async () => {
  for (const order of [["node-a", "node-b"], ["node-b", "node-a"]]) {
    const denied = new Set();
    const { reader: base } = makeAgent();
    const twin = async (pathname, options) => {
      if (denied.has(options?.config?.nodeId) && pathname.startsWith("/api/v1/docker")) throw Object.assign(new Error("Forbidden"), { status: 403 });
      return base(pathname, options);
    };
    setup({ reader: twin, nodes: order.map((id) => agentNode(id)) });
    clock = Date.parse("2026-10-14T10:00:00Z");
    await inventory.refreshInventory();
    denied.add("node-b");
    clock += 3600000;
    const snapshot = await inventory.refreshInventory({ force: true });
    for (const kind of ["container", "volume", "network", "compose-project"]) {
      const row = byKind(snapshot, kind)[0];
      assert.strictEqual(row.stale, false, `${order.join(",")} ${kind}: fresh via node-a`);
      assert.strictEqual(row.lastSeen, new Date(clock).toISOString());
      assert.deepStrictEqual(row.nodeIds, ["node-a", "node-b"], `${kind}: node-b association kept`);
    }
    const nodeB = snapshot.nodes.find((node) => node.nodeId === "node-b");
    assert.strictEqual(nodeB.sections.find((section) => section.name === "docker").status !== "ok", true, "node-b's unread section is still reported");
    assert.strictEqual(snapshot.summary.nodesPartial, 1);
  }
});

test("protection: owner-confirmed non-production applies only to verified keys", () => {
  const verified = { key: "k1", identity: { verified: true } };
  const unverifiedResource = { key: "k2", identity: { verified: false } };
  const classifications = {
    k1: { scope: "non-production", ownerConfirmed: true, confirmedAt: "2026-10-14T00:00:00Z" },
    k2: { scope: "non-production", ownerConfirmed: true },
    k3: { scope: "non-production", ownerConfirmed: false },
  };
  assert.strictEqual(model.applyProtection(verified, classifications).protection.scope, "non-production");
  assert.strictEqual(model.applyProtection(unverifiedResource, classifications).protection.scope, "production");
  assert.strictEqual(model.applyProtection({ key: "k3", identity: { verified: true } }, classifications).protection.scope, "production");
  assert.strictEqual(model.applyProtection({ key: "k4", identity: { verified: true } }, classifications).protection.reason, "UNCLASSIFIED_DEFAULT_PRODUCTION");
});

async function main() {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anxos-aim1-"));
  clock = Date.parse("2026-10-14T09:00:00Z");
  let failed = 0;
  try {
    for (const { name, fn } of tests) {
      try {
        await fn();
        console.log(`ok - ${name}`);
      } catch (error) {
        failed += 1;
        console.error(`not ok - ${name}\n${error?.stack || error}`);
      }
    }
  } finally {
    inventory.resetInfrastructureInventory();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
  if (failed) {
    console.error(`infra inventory smoke failed: ${failed}/${tests.length}`);
    process.exit(1);
  }
  console.log(`infra inventory smoke passed: ${tests.length} tests`);
}

main();
