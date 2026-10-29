"use strict";

// Smoke test for the endpoint service. Run from the repository root:
//   node scripts/endpoint-service-smoke.js
//
// Covers: CRUD, association validation, provider endpoints, discovery over an
// agent network-inventory fixture (loopback + wildcard LAN + Tailscale, manual
// endpoint preservation, idempotence), port-not-listening and inventory
// unsupported/unavailable paths, application-host probing, multiple ports, and
// resolveServiceEndpoints ordering.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createEndpointStore } = require("../src/services/endpointStore");
const { createEndpointService } = require("../src/services/endpointService");

let checks = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    checks += 1;
  } catch (error) {
    failures.push(`${name}: ${error && error.stack ? error.stack : String(error)}`);
  }
}

function tempDir(prefix = "anx-endpoint-service-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.strictEqual(error && error.code, code, `expected code ${code}, got ${error && error.code}: ${error && error.message}`);
    return error;
  }
  assert.fail(`expected an error with code ${code}`);
}

async function expectCodeAsync(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.strictEqual(error && error.code, code, `expected code ${code}, got ${error && error.code}: ${error && error.message}`);
    return error;
  }
  assert.fail(`expected a rejection with code ${code}`);
}

function baseInput(overrides = {}) {
  return Object.assign({
    name: "Anxlab FXServer",
    type: "lan",
    host: "192.168.1.50",
    port: 30120,
    protocol: "tcp",
    serviceId: "svc-1",
    computerId: "agent-node-1",
    source: "manual",
  }, overrides);
}

function makeWorld(deps) {
  const store = createEndpointStore({ configDirectory: tempDir() });
  const service = createEndpointService({ store, deps });
  return { store, service };
}

function agentDeps(inventory, instance) {
  return {
    listInstances: async () => ({ instances: instance ? [instance] : [] }),
    getNetworkInventory: async () => inventory,
    getNode: async () => ({ id: "agent-1", kind: "agent" }),
  };
}

const FIVEM_INSTANCE = {
  id: "svc-1",
  displayName: "Anxlab FXServer",
  ports: [{ port: 30120, protocol: "tcp" }],
  preferredPort: 30120,
};

const WILDCARD_INVENTORY = {
  supported: true,
  listeners: [
    { protocol: "tcp", localAddress: "0.0.0.0", localPort: 30120, state: "LISTENING" },
    { protocol: "tcp", localAddress: "127.0.0.1", localPort: 30120, state: "LISTENING" },
  ],
  interfaces: [
    { name: "eth0", address: "192.168.1.50", family: "IPv4", internal: false },
    { name: "tailscale0", address: "100.101.102.103", family: "IPv4", internal: false },
    { name: "lo", address: "127.0.0.1", family: "IPv4", internal: true },
  ],
};

(async () => {
  await test("CRUD, list filters and summary", async () => {
    const { service, store } = makeWorld();
    const created = service.createEndpoint(baseInput());
    assert.match(created.id, /^ep-/);
    assert.strictEqual(created.createdAt, created.updatedAt);

    const updated = service.updateEndpoint(created.id, { name: "Renamed FXServer", notes: "updated" });
    assert.strictEqual(updated.id, created.id);
    assert.strictEqual(updated.createdAt, created.createdAt);
    assert.strictEqual(updated.name, "Renamed FXServer");
    assert.strictEqual(updated.notes, "updated");

    assert.strictEqual(service.getEndpoint(created.id).name, "Renamed FXServer");
    assert.strictEqual(service.listEndpoints({ nodeId: "agent-node-1" }).length, 1);
    assert.strictEqual(service.listEndpoints({ type: "public" }).length, 0);
    expectCode(() => service.getEndpoint("ep-missing"), "ENDPOINT_NOT_FOUND");

    const summary = service.getEndpointSummary();
    assert.strictEqual(summary.total, 1);
    assert.strictEqual(summary.enabled, 1);
    assert.strictEqual(summary.disabled, 0);
    assert.strictEqual(summary.byType.lan, 1);
    assert.strictEqual(summary.byType.public, 0);
    assert.strictEqual(summary.byHealth.unknown, 1);
    assert.strictEqual(summary.serviceCount, 1);
    assert.strictEqual(summary.computerCount, 1);
    assert.ok(typeof summary.lastUpdatedAt === "string" && summary.lastUpdatedAt.length > 0);
    assert.strictEqual(summary.degraded, false);

    service.setEndpointEnabled(created.id, false);
    assert.strictEqual(service.getEndpointSummary().disabled, 1);
    assert.strictEqual(service.listEndpoints({ enabled: false }).length, 1);

    const deleted = service.deleteEndpoint(created.id);
    assert.strictEqual(deleted.id, created.id);
    expectCode(() => service.deleteEndpoint(created.id), "ENDPOINT_NOT_FOUND");
    assert.strictEqual(store.list().length, 0);
  });

  await test("association validation", async () => {
    const { service } = makeWorld();
    const created = service.createEndpoint(baseInput({ serviceId: "svc-a", computerId: "node-a" }));

    const badId = expectCode(
      () => service.associateEndpoint({ endpointId: created.id, serviceId: "bad id" }),
      "ENDPOINT_VALIDATION_FAILED",
    );
    assert.ok(badId.details.errors.some((error) => error.code === "ENDPOINT_SERVICE_INVALID"));

    expectCode(() => service.associateEndpoint({ endpointId: created.id }), "ENDPOINT_VALIDATION_FAILED");
    expectCode(() => service.associateEndpoint({ endpointId: "ep-missing", serviceId: "svc-b" }), "ENDPOINT_NOT_FOUND");

    const associated = service.associateEndpoint({ endpointId: created.id, serviceId: "svc-b", computerId: "node-b" });
    assert.strictEqual(associated.id, created.id);
    assert.strictEqual(associated.serviceId, "svc-b");
    assert.strictEqual(associated.computerId, "node-b");
  });

  await test("caller-supplied health and lastCheckedAt never persist", async () => {
    const { service, store } = makeWorld();
    const created = service.createEndpoint(baseInput({
      health: { status: "healthy" },
      lastCheckedAt: "2026-01-01T00:00:00.000Z",
    }));
    assert.strictEqual(created.health, null, "create must strip caller-supplied health");
    assert.strictEqual(created.lastCheckedAt, null, "create must strip caller-supplied lastCheckedAt");
    assert.strictEqual(created.name, "Anxlab FXServer", "normal fields must still be saved");
    assert.strictEqual(store.get(created.id).health, null);
    assert.strictEqual(store.get(created.id).lastCheckedAt, null);

    const updated = service.updateEndpoint(created.id, {
      name: "Renamed FXServer",
      notes: "updated",
      health: { status: "healthy" },
      lastCheckedAt: "2026-01-02T00:00:00.000Z",
    });
    assert.strictEqual(updated.name, "Renamed FXServer");
    assert.strictEqual(updated.notes, "updated");
    assert.strictEqual(updated.health, null, "update must strip caller-supplied health");
    assert.strictEqual(updated.lastCheckedAt, null, "update must strip caller-supplied lastCheckedAt");
    assert.strictEqual(store.get(created.id).health, null);

    const summary = service.getEndpointSummary();
    assert.strictEqual(summary.byHealth.unknown, 1);
    assert.strictEqual(summary.byHealth.healthy, undefined, "fabricated health must not be counted");

    const persistedBytes = fs.readFileSync(store.filePath, "utf8");
    assert.ok(!persistedBytes.includes('"healthy"'), "fabricated health must not reach endpoints.json");
  });

  await test("provider endpoints require a providerId and force source provider", async () => {
    const { service } = makeWorld();
    const missing = expectCode(
      () => service.upsertProviderEndpoint({ input: { name: "Tunnel", type: "public", host: "x.playit.gg", port: 30120 } }),
      "ENDPOINT_VALIDATION_FAILED",
    );
    assert.strictEqual(missing.details.errors[0].code, "ENDPOINT_PROVIDER_REQUIRED");
    const record = service.upsertProviderEndpoint({
      nodeId: "agent-9",
      input: { name: "Tunnel", type: "public", host: "x.playit.gg", port: 30120, providerId: "playit", source: "manual" },
    });
    assert.strictEqual(record.source, "provider");
    assert.strictEqual(record.providerId, "playit");
    assert.strictEqual(record.computerId, "agent-9");
  });

  await test("agent discovery creates private/lan/tailscale once and preserves manual endpoints", async () => {
    const { service, store } = makeWorld(agentDeps(WILDCARD_INVENTORY, FIVEM_INSTANCE));
    const manual = service.createEndpoint({
      name: "Manual LAN note",
      type: "lan",
      host: "192.168.1.50",
      port: 30120,
      protocol: "tcp",
      serviceId: null,
      computerId: "agent-1",
      source: "manual",
      notes: "operator note",
    });

    const first = await service.discoverEndpoints({ nodeId: "agent-1", serviceId: "svc-1" });
    assert.strictEqual(first.state, "healthy");
    assert.strictEqual(first.inventoryAvailable, true);
    assert.strictEqual(first.portNotListening, false);
    assert.strictEqual(first.created.length, 3, `expected 3 created, got ${JSON.stringify(first.created.map((entry) => entry.host))}`);
    assert.strictEqual(first.updated.length, 0);

    const discovered = store.list({ serviceId: "svc-1" });
    assert.strictEqual(discovered.length, 3);
    const privateLoopback = discovered.find((entry) => entry.type === "private");
    assert.strictEqual(privateLoopback.host, "127.0.0.1");
    assert.strictEqual(privateLoopback.metadata.scope, "loopback");
    const lan = discovered.find((entry) => entry.type === "lan");
    assert.strictEqual(lan.host, "192.168.1.50");
    assert.strictEqual(lan.metadata.scope, "lan");
    assert.strictEqual(lan.metadata.interfaceName, "eth0");
    const tailscale = discovered.find((entry) => entry.type === "tailscale");
    assert.strictEqual(tailscale.host, "100.101.102.103");
    assert.strictEqual(tailscale.metadata.scope, "tailscale");
    for (const endpoint of discovered) {
      assert.strictEqual(endpoint.source, "discovered");
      assert.strictEqual(endpoint.computerId, "agent-1");
      assert.strictEqual(endpoint.port, 30120);
      assert.strictEqual(endpoint.protocol, "tcp");
      assert.ok(endpoint.metadata.discoveredAt);
    }

    const manualAfter = store.get(manual.id);
    assert.strictEqual(manualAfter.source, "manual");
    assert.strictEqual(manualAfter.name, "Manual LAN note");
    assert.strictEqual(manualAfter.notes, "operator note");
    assert.strictEqual(manualAfter.updatedAt, manual.updatedAt);

    const second = await service.discoverEndpoints({ nodeId: "agent-1", serviceId: "svc-1" });
    assert.strictEqual(second.created.length, 0);
    assert.strictEqual(second.updated.length, 3);
    assert.strictEqual(store.list({ serviceId: "svc-1" }).length, 3);
    assert.strictEqual(store.get(manual.id).name, "Manual LAN note");
  });

  await test("discovery skips a manual endpoint occupying the exact discovered identity", async () => {
    const { service, store } = makeWorld(agentDeps(WILDCARD_INVENTORY, FIVEM_INSTANCE));
    const manual = service.createEndpoint({
      name: "Manual LAN note",
      type: "lan",
      host: "192.168.1.50",
      port: 30120,
      protocol: "tcp",
      serviceId: "svc-1",
      computerId: "agent-1",
      source: "manual",
      notes: "operator note",
    });
    const result = await service.discoverEndpoints({ nodeId: "agent-1", serviceId: "svc-1" });
    assert.strictEqual(result.created.length, 2);
    assert.ok(result.skipped.some((entry) => entry.reason === "existing-non-discovered" && entry.endpointId === manual.id));
    assert.strictEqual(store.list({ serviceId: "svc-1" }).length, 3);
    const after = store.get(manual.id);
    assert.strictEqual(after.source, "manual");
    assert.strictEqual(after.name, "Manual LAN note");
  });

  await test("discovery reports disappeared addresses as stale without deleting them", async () => {
    const inventoryA = {
      supported: true,
      listeners: [
        { protocol: "tcp", localAddress: "0.0.0.0", localPort: 30120, state: "LISTENING" },
        { protocol: "tcp", localAddress: "127.0.0.1", localPort: 30120, state: "LISTENING" },
      ],
      interfaces: [{ name: "eth0", address: "192.168.1.10", family: "IPv4", internal: false }],
    };
    const inventoryB = {
      ...inventoryA,
      interfaces: [{ name: "eth0", address: "192.168.1.11", family: "IPv4", internal: false }],
    };
    const { service, store } = makeWorld(agentDeps(inventoryA, FIVEM_INSTANCE));

    const first = await service.discoverEndpoints({ nodeId: "agent-1", serviceId: "svc-1" });
    assert.deepStrictEqual(first.stale, [], "a first discovery has no prior addresses to report");
    const staleCandidate = store.list({ serviceId: "svc-1" }).find((entry) => entry.host === "192.168.1.10");
    assert.ok(staleCandidate, "the .10 endpoint must have been discovered");

    const second = await service.discoverEndpoints({
      nodeId: "agent-1",
      serviceId: "svc-1",
      deps: { getNetworkInventory: async () => inventoryB },
    });
    assert.ok(
      second.stale.includes(staleCandidate.id),
      `the disappeared .10 address must be reported stale, saw ${JSON.stringify(second.stale)}`,
    );
    assert.ok(
      !second.stale.includes(store.list({ serviceId: "svc-1" }).find((entry) => entry.host === "127.0.0.1").id),
      "a still-observed address must not be reported stale",
    );

    const kept = store.get(staleCandidate.id);
    assert.ok(kept, "a stale endpoint must never be deleted");
    assert.strictEqual(kept.enabled, true, "a stale endpoint must never be disabled");
    assert.strictEqual(kept.host, "192.168.1.10", "a stale endpoint must be left unchanged");
  });

  await test("port not listening creates nothing", async () => {
    const { service, store } = makeWorld(agentDeps({ supported: true, listeners: [], interfaces: [] }, FIVEM_INSTANCE));
    const result = await service.discoverEndpoints({ nodeId: "agent-1", serviceId: "svc-1" });
    assert.strictEqual(result.portNotListening, true);
    assert.strictEqual(result.created.length, 0);
    assert.strictEqual(result.state, "degraded");
    assert.strictEqual(result.ports[0].listening, false);
    assert.ok(result.skipped.some((entry) => entry.reason === "port-not-listening"));
    assert.strictEqual(store.list().length, 0);
  });

  await test("inventory unsupported and agent-unavailable paths", async () => {
    const unsupported = makeWorld(agentDeps({ supported: false, listeners: [], interfaces: [] }, FIVEM_INSTANCE));
    const unsupportedResult = await unsupported.service.discoverEndpoints({ nodeId: "agent-1", serviceId: "svc-1" });
    assert.strictEqual(unsupportedResult.state, "unsupported");
    assert.strictEqual(unsupportedResult.reason, "inventory-unsupported");
    assert.strictEqual(unsupportedResult.created.length, 0);
    assert.strictEqual(unsupported.store.list().length, 0);

    const unavailable = makeWorld({
      listInstances: agentDeps(WILDCARD_INVENTORY, FIVEM_INSTANCE).listInstances,
      getNode: agentDeps(WILDCARD_INVENTORY, FIVEM_INSTANCE).getNode,
      getNetworkInventory: async () => { throw Object.assign(new Error("Agent is unreachable."), { code: "AGENT_UNAVAILABLE" }); },
    });
    const error = await expectCodeAsync(
      unavailable.service.discoverEndpoints({ nodeId: "agent-1", serviceId: "svc-1" }),
      "ENDPOINT_AGENT_UNAVAILABLE",
    );
    assert.strictEqual(error.details.causeCode, "AGENT_UNAVAILABLE");
    assert.strictEqual(unavailable.store.list().length, 0);

    const noInventoryPayload = makeWorld(agentDeps(null, FIVEM_INSTANCE));
    const unknownResult = await noInventoryPayload.service.discoverEndpoints({ nodeId: "agent-1", serviceId: "svc-1" });
    assert.strictEqual(unknownResult.state, "unknown");
    assert.strictEqual(unknownResult.reason, "inventory-unavailable");
  });

  await test("application-host discovery uses injected local probes", async () => {
    const { service, store } = makeWorld({
      listInstances: async () => ({ instances: [{ id: "svc-web", displayName: "Local Web", ports: [{ port: 8080, protocol: "tcp" }] }] }),
      getNode: async () => ({ id: "application-host", kind: "application-host" }),
      probeLocalListeners: async ({ ports }) => ({
        supported: true,
        availability: "application-host",
        results: ports.map((entry) => ({
          port: entry.port,
          protocol: entry.protocol,
          listening: true,
          probes: [
            { host: "127.0.0.1", interfaceName: "loopback", family: "IPv4", internal: true, listening: true },
            { host: "192.168.1.50", interfaceName: "Ethernet", family: "IPv4", internal: false, listening: true },
            { host: "100.64.0.5", interfaceName: "Tailscale", family: "IPv4", internal: false, listening: true },
            { host: "192.168.1.60", interfaceName: "Ethernet", family: "IPv4", internal: false, listening: false },
          ],
        })),
      }),
    });
    const result = await service.discoverEndpoints({ nodeId: "application-host", serviceId: "svc-web" });
    assert.strictEqual(result.state, "healthy");
    assert.strictEqual(result.created.length, 3);
    const endpoints = store.list({ serviceId: "svc-web" });
    assert.ok(endpoints.some((entry) => entry.type === "private" && entry.host === "127.0.0.1"));
    assert.ok(endpoints.some((entry) => entry.type === "lan" && entry.host === "192.168.1.50"));
    assert.ok(endpoints.some((entry) => entry.type === "tailscale" && entry.host === "100.64.0.5"));
    assert.ok(!endpoints.some((entry) => entry.host === "192.168.1.60"), "closed probes must not create endpoints");
  });

  await test("multiple service ports produce multiple endpoints", async () => {
    const { service, store } = makeWorld(agentDeps({
      supported: true,
      listeners: [
        { protocol: "tcp", localAddress: "127.0.0.1", localPort: 25565, state: "LISTENING" },
        { protocol: "tcp", localAddress: "127.0.0.1", localPort: 30120, state: "LISTENING" },
      ],
      interfaces: [],
    }, {
      id: "svc-multi",
      displayName: "Multi Port",
      ports: [{ port: 25565, protocol: "tcp" }],
      preferredPort: 30120,
    }));
    const result = await service.discoverEndpoints({ nodeId: "agent-1", serviceId: "svc-multi" });
    assert.strictEqual(result.ports.length, 2);
    assert.strictEqual(result.created.length, 2);
    const ports = store.list({ serviceId: "svc-multi" }).map((entry) => entry.port).sort((a, b) => a - b);
    assert.deepStrictEqual(ports, [25565, 30120]);
  });

  await test("resolveServiceEndpoints orders enabled first and reports legacy availability", async () => {
    const { service, store } = makeWorld();
    const enabled = service.createEndpoint(baseInput({ serviceId: "svc-ord", name: "Enabled" }));
    const disabled = service.createEndpoint(baseInput({ serviceId: "svc-ord", name: "Disabled", host: "192.168.1.51" }));
    service.setEndpointEnabled(disabled.id, false);

    const resolved = service.resolveServiceEndpoints({ nodeId: "agent-node-1", serviceId: "svc-ord" });
    assert.strictEqual(resolved.endpoints.length, 2);
    assert.strictEqual(resolved.endpoints[0].id, enabled.id);
    assert.strictEqual(resolved.endpoints[1].id, disabled.id);
    assert.strictEqual(resolved.degraded, false);
    assert.strictEqual(resolved.legacyAvailable, false);

    const legacyFile = path.join(store.configDirectory, "public-access-services.json");
    fs.writeFileSync(legacyFile, `${JSON.stringify({
      schemaVersion: 1,
      services: [{ id: "access-legacy-1", nodeId: "agent-node-1", linkedInstanceId: "svc-ord", localPort: 30120 }],
    }, null, 2)}\n`);
    const withLegacy = service.resolveServiceEndpoints({ nodeId: "agent-node-1", serviceId: "svc-ord" });
    assert.strictEqual(withLegacy.legacyAvailable, true);
    const otherService = service.resolveServiceEndpoints({ nodeId: "agent-node-1", serviceId: "svc-none" });
    assert.strictEqual(otherService.legacyAvailable, false);
  });

  // PR #9 review P2: UDP ports are never "verified" with a TCP connect.
  await test("application-host UDP ports use the listener table, never a TCP probe", async () => {
    const probeLocal = require("../src/services/endpointService")._test.defaultProbeLocalListeners;
    const tcpProbes = [];
    const probeTcpPort = async (host, port) => { tcpProbes.push({ host, port }); return true; };
    const table = (rows, extra = {}) => async () => ({ source: "ss", rows, errors: [], ...extra });

    const wildcard = await probeLocal({ ports: [{ port: 7777, protocol: "udp" }], probeTcpPort, listLocalListeners: table([{ protocol: "udp", localAddress: "0.0.0.0", localPort: 7777 }]) });
    assert.strictEqual(wildcard.results[0].protocol, "udp");
    assert.strictEqual(wildcard.results[0].listening, true, "a UDP listener in the table is listening");
    assert.strictEqual(wildcard.results[0].evidence, "listener-table");
    assert.ok(wildcard.results[0].probes.length > 0 && wildcard.results[0].probes.every((probe) => probe.listening === true), "a wildcard bind covers every interface");
    assert.strictEqual(tcpProbes.length, 0, "no TCP connect is used for a UDP port");

    const tcpOnly = await probeLocal({ ports: [{ port: 7777, protocol: "udp" }], probeTcpPort, listLocalListeners: table([{ protocol: "tcp", localAddress: "0.0.0.0", localPort: 7777 }]) });
    assert.strictEqual(tcpOnly.results[0].listening, false, "a TCP listener on the same port is not UDP evidence");
    assert.strictEqual(tcpProbes.length, 0);

    const unreadable = await probeLocal({ ports: [{ port: 7777, protocol: "udp" }], probeTcpPort, listLocalListeners: table([], { source: null }) });
    assert.strictEqual(unreadable.results[0].listening, null, "no listener table means unknown, not not-listening");
    assert.strictEqual(unreadable.results[0].evidence, "unavailable");
    const udpFailed = await probeLocal({ ports: [{ port: 7777, protocol: "udp" }], probeTcpPort, listLocalListeners: table([{ protocol: "tcp", localAddress: "0.0.0.0", localPort: 80 }], { errors: ["ss (udp): command failed"] }) });
    assert.strictEqual(udpFailed.results[0].listening, null, "a failed UDP enumeration is not evidence of absence");
    const thrown = await probeLocal({ ports: [{ port: 7777, protocol: "udp" }], probeTcpPort, listLocalListeners: async () => { throw new Error("spawn failed"); } });
    assert.strictEqual(thrown.results[0].listening, null);

    const tcp = await probeLocal({ ports: [{ port: 8080, protocol: "tcp" }], probeTcpPort, listLocalListeners: table([]) });
    assert.strictEqual(tcp.results[0].listening, true, "TCP ports keep the connect probe");
    assert.ok(tcpProbes.length > 0);
  });

  await test("UDP discovery without listener evidence creates nothing and is not 'not listening'", async () => {
    const { service, store } = makeWorld({
      listInstances: async () => ({ instances: [{ id: "svc-voice", displayName: "Voice", ports: [{ port: 9987, protocol: "udp" }] }] }),
      getNode: async () => ({ id: "application-host", kind: "application-host" }),
      probeLocalListeners: async () => ({ supported: true, availability: "application-host", results: [{ port: 9987, protocol: "udp", listening: null, evidence: "unavailable", probes: [] }] }),
    });
    const result = await service.discoverEndpoints({ nodeId: "application-host", serviceId: "svc-voice" });
    assert.strictEqual(result.created.length, 0, "no endpoint without evidence");
    assert.notStrictEqual(result.portNotListening, true, "unknown evidence is not reported as not listening");
    assert.ok(result.skipped.some((entry) => entry.reason === "listener-evidence-unavailable" && entry.protocol === "udp"));
    assert.strictEqual(result.ports[0].listening, null);
    assert.notStrictEqual(result.state, "healthy");
    assert.strictEqual(store.list({ serviceId: "svc-voice" }).length, 0);
  });

  await test("PR #9 second review P2-A: target-changing edits invalidate cached diagnostics", async () => {
    const invalidated = [];
    const changesSeen = [];
    const { service } = makeWorld({ invalidateEndpointDiagnostics: (id, change) => { invalidated.push(id); changesSeen.push(change); } });
    const created = service.createEndpoint(baseInput());
    // Repair loop round 3: a new endpoint can change which endpoint a
    // service-level run on its node selects.
    assert.deepStrictEqual(invalidated, [created.id], "creating an endpoint signals a selection change");
    assert.deepStrictEqual(changesSeen, [{ nodeIds: ["agent-node-1"], publicChanged: false }]);

    invalidated.length = 0;
    service.updateEndpoint(created.id, { name: "Renamed", notes: "only labels" });
    assert.deepStrictEqual(invalidated, [], "a rename keeps the target's diagnostics");

    const changes = [
      ["host", { host: "192.168.1.77" }],
      ["port", { port: 30199 }],
      ["protocol", { protocol: "udp" }],
      ["node", { computerId: "node-z" }],
      ["service", { serviceId: "svc-z" }],
    ];
    for (const [field, change] of changes) {
      invalidated.length = 0;
      service.updateEndpoint(created.id, change);
      assert.deepStrictEqual(invalidated, [created.id], `a ${field} change invalidates that endpoint`);
    }

    invalidated.length = 0;
    service.associateEndpoint({ endpointId: created.id, serviceId: "svc-z" });
    assert.deepStrictEqual(invalidated, [], "re-associating with the same service is not a change");
    service.associateEndpoint({ endpointId: created.id, serviceId: "svc-y", computerId: "node-y" });
    assert.deepStrictEqual(invalidated, [created.id], "associating with another service or node invalidates");

    invalidated.length = 0;
    service.deleteEndpoint(created.id);
    assert.deepStrictEqual(invalidated, [created.id], "deleting an endpoint invalidates it");
    assert.throws(() => service.deleteEndpoint("ep-never-existed"), /not found/i);
    assert.deepStrictEqual(invalidated, [created.id], "deleting an unknown id invalidates nothing");
  });

  await test("PR #9 second review P2-A: an invalidation failure never fails the edit", async () => {
    const { service } = makeWorld({ invalidateEndpointDiagnostics: () => { throw new Error("diagnostics unavailable"); } });
    const created = service.createEndpoint(baseInput());
    const updated = service.updateEndpoint(created.id, { host: "192.168.1.78" });
    assert.strictEqual(updated.host, "192.168.1.78", "the edit is stored");
  });

  await test("PR #9 second review P2-A: the default dep drops the real diagnostics cache entry", async () => {
    const diagnostics = require("../src/services/connectivityDiagnosticsService");
    const { service } = makeWorld();
    const created = service.createEndpoint(baseInput());
    const originalInvalidate = diagnostics.invalidateDiagnostics;
    const seen = [];
    // Observe the module-level call without replacing the cache semantics.
    diagnostics.invalidateDiagnostics = (target) => { seen.push(target); return originalInvalidate(target); };
    try {
      service.updateEndpoint(created.id, { port: 30177 });
    } finally {
      diagnostics.invalidateDiagnostics = originalInvalidate;
    }
    assert.deepStrictEqual(seen, [{ endpointId: created.id, selectionNodeIds: ["agent-node-1"], publicSelectionChanged: false }]);
  });

  await test("PR #9 repair loop round 3: every write that can change endpoint selection is signalled", async () => {
    const signals = [];
    const record = (id, change) => signals.push({ id, ...change });
    const { service } = makeWorld({ invalidateEndpointDiagnostics: record });
    const created = service.createEndpoint(baseInput());
    signals.length = 0;

    // Enable toggles change which endpoint a service-level run selects.
    service.setEndpointEnabled(created.id, false);
    assert.deepStrictEqual(signals, [{ id: created.id, nodeIds: ["agent-node-1"], publicChanged: false }], "disabling is signalled");
    signals.length = 0;
    service.setEndpointEnabled(created.id, false);
    assert.deepStrictEqual(signals, [], "setting the same state again is not a change");
    service.updateEndpoint(created.id, { enabled: true });
    assert.deepStrictEqual(signals, [{ id: created.id, nodeIds: ["agent-node-1"], publicChanged: false }], "enabling through an edit is signalled");

    // A move between nodes reaches both nodes; a public endpoint flags the
    // public selection.
    signals.length = 0;
    service.updateEndpoint(created.id, { computerId: "agent-node-2" });
    assert.deepStrictEqual(signals, [{ id: created.id, nodeIds: ["agent-node-1", "agent-node-2"], publicChanged: false }]);
    signals.length = 0;
    const publicRecord = service.createEndpoint(baseInput({ type: "public", host: "203.0.113.20", name: "Public" }));
    assert.deepStrictEqual(signals, [{ id: publicRecord.id, nodeIds: ["agent-node-1"], publicChanged: true }], "a new public endpoint changes the public selection");
    signals.length = 0;
    service.setEndpointEnabled(publicRecord.id, false);
    assert.deepStrictEqual(signals, [{ id: publicRecord.id, nodeIds: ["agent-node-1"], publicChanged: true }]);

    // Provider sync: a new endpoint is signalled; re-syncing the same target
    // (matched by the store without an id) is not a change.
    signals.length = 0;
    const providerInput = { nodeId: "agent-node-1", input: { name: "Tunnel", type: "public", host: "tunnel.example", port: 30120, protocol: "tcp", providerId: "playit", serviceId: "svc-1" } };
    const provided = service.upsertProviderEndpoint(providerInput);
    assert.deepStrictEqual(signals, [{ id: provided.id, nodeIds: ["agent-node-1"], publicChanged: true }], "a provider endpoint is signalled");
    signals.length = 0;
    service.upsertProviderEndpoint(providerInput);
    assert.deepStrictEqual(signals, [], "an unchanged provider re-sync is not a change");

    // Delete.
    signals.length = 0;
    service.deleteEndpoint(publicRecord.id);
    assert.deepStrictEqual(signals, [{ id: publicRecord.id, nodeIds: ["agent-node-1"], publicChanged: true }], "deleting is signalled");
  });

  await test("PR #9 repair loop round 4: a provider binding change is signalled", async () => {
    const signals = [];
    const { service, store } = makeWorld({ invalidateEndpointDiagnostics: (id, change) => signals.push({ id, ...change }) });
    const created = service.createEndpoint(baseInput({ type: "public", host: "203.0.113.40", providerId: "playit" }));
    signals.length = 0;
    service.updateEndpoint(created.id, { providerId: "ngrok" });
    assert.deepStrictEqual(signals, [{ id: created.id, nodeIds: ["agent-node-1"], publicChanged: true }], "a provider-only edit is signalled");
    signals.length = 0;
    service.updateEndpoint(created.id, { providerId: "ngrok", name: "Same provider" });
    assert.deepStrictEqual(signals, [], "keeping the provider is not a change");
    assert.strictEqual(store.list().length, 1, "the provider edit updated the record in place (no second record)");
  });

  await test("PR #9 repair loop round 3: discovery writes go through the signalled path", async () => {
    const signals = [];
    const { service, store } = makeWorld({
      ...agentDeps(WILDCARD_INVENTORY, FIVEM_INSTANCE),
      invalidateEndpointDiagnostics: (id, change) => signals.push({ id, ...change }),
    });
    await service.discoverEndpoints({ nodeId: "agent-1", serviceId: "svc-1" });
    const discovered = store.list({ serviceId: "svc-1" });
    assert.ok(discovered.length > 0, "discovery created endpoints");
    assert.ok(discovered.every((entry) => signals.some((signal) => signal.id === entry.id)), "each discovered endpoint is signalled");
    signals.length = 0;
    await service.discoverEndpoints({ nodeId: "agent-1", serviceId: "svc-1" });
    assert.deepStrictEqual(signals, [], "re-discovering the same endpoints is not a change");
  });

  if (failures.length > 0) {
    console.error(`endpoint-service smoke: ${failures.length} failed, ${checks} passed`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`endpoint-service smoke: all ${checks} test groups passed`);
  }
})();
