"use strict";

// Provider integration smoke. Run from the repository root:
//   node scripts/provider-integration-smoke.js
//
// Exercises src/services/providerIntegrationService.js with the REAL provider
// adapters (src/shared/providers/*), the REAL endpoint service and the REAL
// endpoint store in a temp config directory. Only the Playit snapshot source is
// faked (docs/ENDPOINT_MANAGER.md: "a smoke with fake snapshots for the new
// provider's state mapping and tunnel reconciliation").
//
// Covers: provider state mapping (not-installed, auth-required, stopped,
// degraded, running, live-connection-wins, skipped tunnel entries); bounded
// degradation (throw, rejection, timeout -> unknown + PROVIDER_SNAPSHOT_UNAVAILABLE);
// NODE_REQUIRED; unsupported and manual providers; snapshot caching and
// refresh; credential stripping; and syncTunnels reconciliation: created /
// unchanged / updated classification, idempotence, service association
// (associated / ambiguous / unassociated), an invalid tunnel skipped without
// aborting the sync, stale provider endpoints reported but never deleted or
// disabled, per-node isolation, and the not-installed / unavailable / invalid
// snapshot refusals that change nothing.

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createEndpointStore } = require("../src/services/endpointStore");
const { createEndpointService } = require("../src/services/endpointService");
const { createProviderIntegrationService } = require("../src/services/providerIntegrationService");

// Fail closed: a run that never reaches its summary (for example a read that
// never settles, letting the event loop drain) must not exit 0.
process.exitCode = 1;

let checks = 0;
const failures = [];
const tempDirs = [];

async function test(name, fn) {
  try {
    await fn();
    checks += 1;
  } catch (error) {
    failures.push(`${name}: ${error && error.stack ? error.stack : String(error)}`);
  }
}

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "anx-provider-integration-"));
  tempDirs.push(dir);
  return dir;
}

const NODE = "agent-node-1";
const OTHER_NODE = "agent-node-2";
const SECRET = "playit-secret-should-never-surface-7f3a";

// A world: real store + real endpoint service as the gateway; the Playit
// snapshot comes from `world.snapshot` (a value, a function, or an error).
function makeWorld({ cacheTtlMs = 0, snapshotTimeoutMs = 200 } = {}) {
  const store = createEndpointStore({ configDirectory: tempDir() });
  const endpoints = createEndpointService({ store });
  const world = { store, endpoints, snapshot: null, calls: 0, clock: Date.parse("2026-10-15T12:00:00.000Z") };
  const gateway = {
    listEndpoints: (filter) => endpoints.listEndpoints(filter),
    upsertProviderEndpoint: (payload) => endpoints.upsertProviderEndpoint(payload),
    recordProviderSync: (nodeId, patch) => endpoints.recordProviderSync(nodeId, patch),
    getProviderSyncs: () => endpoints.getProviderSyncs(),
  };
  world.service = createProviderIntegrationService({
    deps: {
      endpointGateway: gateway,
      cacheTtlMs,
      snapshotTimeoutMs,
      getPlayitSnapshot: ({ nodeId }) => {
        world.calls += 1;
        world.lastNodeId = nodeId;
        const value = typeof world.snapshot === "function" ? world.snapshot() : world.snapshot;
        if (value instanceof Error) throw value;
        return value;
      },
    },
    now: () => world.clock,
  });
  return world;
}

function runningSnapshot(tunnels, extra = {}) {
  return {
    installed: true,
    running: true,
    connected: true,
    version: "0.15.26",
    region: "north-america",
    tunnelAddress: "anx-mc.joinmc.link:23001",
    localIp: "127.0.0.1",
    localPort: 25565,
    lastCheckedAt: "2026-10-15T11:59:00.000Z",
    tunnels,
    ...extra,
  };
}

function tunnel(id, publicAddress, localPort, protocol, extra = {}) {
  return { id, name: `Tunnel ${id}`, publicAddress, localTarget: localPort === null ? null : `127.0.0.1:${localPort}`, localPort, protocol, region: "north-america", ...extra };
}

function manualEndpoint(world, overrides) {
  return world.endpoints.createEndpoint(Object.assign({
    name: "LAN entry",
    type: "lan",
    host: "192.168.1.50",
    port: 25565,
    protocol: "tcp",
    serviceId: "svc-minecraft",
    computerId: NODE,
    source: "manual",
  }, overrides));
}

function providerEndpoints(world, nodeId = NODE) {
  return world.endpoints.listEndpoints({ nodeId }).filter((endpoint) => endpoint.source === "provider");
}

async function expectRejectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.strictEqual(error && error.code, code, `expected ${code}, got ${error && error.code}: ${error && error.message}`);
    return;
  }
  assert.fail(`expected a rejection with code ${code}`);
}

async function main() {
  // -------------------------------------------------------------------------
  // Provider state mapping
  // -------------------------------------------------------------------------
  await test("state mapping: each Playit snapshot shape maps to one canonical state", async () => {
    const world = makeWorld();
    const cases = [
      [{ installed: false, running: false }, { state: "not-installed", availability: "unavailable" }],
      [{ installed: true, running: false, diagnostics: { ok: false, message: "Please sign in to Playit." } }, { state: "auth-required", availability: "available", connected: null }],
      [{ installed: true, running: true, connected: true, authenticated: false }, { state: "running", connected: true }],
      [{ installed: true, running: false }, { state: "stopped", availability: "available" }],
      [{ installed: true, running: true, connected: false }, { state: "degraded", connected: false }],
      [runningSnapshot([]), { state: "running", availability: "available", connected: true }],
      [{}, { state: "unknown", availability: "unknown" }],
    ];
    for (const [snapshot, expected] of cases) {
      world.snapshot = snapshot;
      const state = await world.service.getProviderStateForNode({ nodeId: NODE, providerId: "playit" });
      assert.strictEqual(state.providerId, "playit");
      for (const [key, value] of Object.entries(expected)) {
        assert.strictEqual(state[key], value, `${JSON.stringify(snapshot)} -> ${key}`);
      }
    }
    assert.strictEqual(world.lastNodeId, NODE, "the snapshot is requested for the selected node");
  });

  await test("state mapping: addresses, auth diagnostics and skipped tunnel entries", async () => {
    const world = makeWorld();
    world.snapshot = runningSnapshot([tunnel("t-1", "anx-mc.joinmc.link:23001", 25565, "tcp"), 42, "not-a-tunnel"]);
    const state = await world.service.getProviderStateForNode({ nodeId: NODE, providerId: "playit" });
    assert.strictEqual(state.publicAddress, "anx-mc.joinmc.link:23001");
    assert.strictEqual(state.localTarget, "127.0.0.1:25565");
    assert.strictEqual(state.tunnels.length, 1);
    assert.ok(state.diagnostics.some((entry) => entry.code === "PLAYIT_TUNNEL_SKIPPED"), "invalid tunnel entries are reported");

    world.snapshot = { installed: true, running: false, signInRequired: true };
    const auth = await world.service.getProviderStateForNode({ nodeId: NODE, providerId: "playit" });
    assert.strictEqual(auth.state, "auth-required");
    assert.ok(auth.diagnostics.some((entry) => entry.code === "PLAYIT_AUTH_REQUIRED"));

    world.snapshot = { installed: false, signInRequired: true };
    const missing = await world.service.getProviderStateForNode({ nodeId: NODE, providerId: "playit" });
    assert.strictEqual(missing.state, "not-installed", "not installed wins over auth evidence");
    assert.ok(!missing.diagnostics.some((entry) => entry.code === "PLAYIT_AUTH_REQUIRED"));
  });

  await test("degradation: throw, rejection and timeout become unknown + PROVIDER_SNAPSHOT_UNAVAILABLE", async () => {
    const world = makeWorld({ snapshotTimeoutMs: 50 });
    const sources = [
      () => new Error("agent offline"),
      () => Promise.reject(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" })),
      () => new Promise(() => {}),
    ];
    for (const source of sources) {
      world.snapshot = source;
      const state = await world.service.getProviderStateForNode({ nodeId: NODE, providerId: "playit" });
      assert.strictEqual(state.state, "unknown");
      assert.ok(state.diagnostics.some((entry) => entry.code === "PROVIDER_SNAPSHOT_UNAVAILABLE"));
    }
    const snapshot = await world.service.getProviderSnapshot({ nodeId: NODE });
    assert.strictEqual(snapshot.providers[0].state, "unknown", "the snapshot read never throws on provider failure");
  });

  await test("NODE_REQUIRED is the only refusal; unsupported and manual providers answer", async () => {
    const world = makeWorld();
    world.snapshot = runningSnapshot([]);
    for (const nodeId of [undefined, "", "   ", 42]) {
      await expectRejectCode(world.service.getProviderStateForNode({ nodeId, providerId: "playit" }), "NODE_REQUIRED");
      await expectRejectCode(world.service.getProviderSnapshot({ nodeId }), "NODE_REQUIRED");
      await expectRejectCode(world.service.syncTunnels({ nodeId }), "NODE_REQUIRED");
    }
    assert.strictEqual(world.calls, 0, "no snapshot is requested without a node");
    const unsupported = await world.service.getProviderStateForNode({ nodeId: NODE, providerId: "ngrok" });
    assert.strictEqual(unsupported.state, "unsupported");
    assert.ok(unsupported.diagnostics.some((entry) => entry.code === "PROVIDER_UNSUPPORTED"));
    const manual = await world.service.getProviderStateForNode({ nodeId: NODE, providerId: "manual" });
    assert.strictEqual(manual.providerId, "manual");
    assert.strictEqual(world.calls, 0, "unsupported and manual providers never read the Playit snapshot");
  });

  await test("snapshot cache: reused within the TTL, bypassed by refresh, expired after the TTL", async () => {
    const world = makeWorld({ cacheTtlMs: 30_000 });
    world.snapshot = runningSnapshot([]);
    const first = await world.service.getProviderSnapshot({ nodeId: NODE });
    assert.deepStrictEqual(first.providers.map((provider) => provider.providerId), ["playit", "manual"]);
    assert.strictEqual(first.cache.cached, false);
    const second = await world.service.getProviderSnapshot({ nodeId: NODE });
    assert.strictEqual(second.cache.cached, true);
    assert.strictEqual(world.calls, 1);
    await world.service.getProviderSnapshot({ nodeId: NODE, refresh: true });
    assert.strictEqual(world.calls, 2, "refresh bypasses the cache");
    world.clock += 30_001;
    const expired = await world.service.getProviderSnapshot({ nodeId: NODE });
    assert.strictEqual(expired.cache.cached, false);
    assert.strictEqual(world.calls, 3, "the cache expires after its TTL");
    await world.service.getProviderSnapshot({ nodeId: OTHER_NODE });
    assert.strictEqual(world.calls, 4, "the cache is per node");
  });

  await test("credentials in the snapshot never reach provider state or stored endpoints", async () => {
    const world = makeWorld();
    world.snapshot = runningSnapshot(
      [tunnel("t-secret", "anx-mc.joinmc.link:23001", 25565, "tcp", { secretKey: SECRET, agentKey: SECRET, token: SECRET })],
      { secretKey: SECRET, agentSecret: SECRET, diagnostics: { ok: true, apiKey: SECRET } },
    );
    const state = await world.service.getProviderStateForNode({ nodeId: NODE, providerId: "playit" });
    assert.ok(!JSON.stringify(state).includes(SECRET), "provider state carries no credential");
    // Array diagnostics pass through as objects: the contract's stripping must
    // drop credential fields and scrub a credential out of the message text.
    world.snapshot = runningSnapshot([], { diagnostics: [{ code: "PLAYIT_AGENT", message: `agent restarted; Authorization: Bearer ${SECRET}`, token: SECRET, apiKey: SECRET, nested: { secret: SECRET } }] });
    const withDiagnostics = await world.service.getProviderStateForNode({ nodeId: NODE, providerId: "playit" });
    assert.ok(withDiagnostics.diagnostics.some((entry) => entry.code === "PLAYIT_AGENT"), "the diagnostic itself is kept");
    assert.ok(!JSON.stringify(withDiagnostics).includes(SECRET), "credential fields are stripped from diagnostics");
    world.snapshot = runningSnapshot(
      [tunnel("t-secret", "anx-mc.joinmc.link:23001", 25565, "tcp", { secretKey: SECRET, agentKey: SECRET, token: SECRET })],
      { secretKey: SECRET, agentSecret: SECRET, diagnostics: { ok: true, apiKey: SECRET } },
    );
    const sync = await world.service.syncTunnels({ nodeId: NODE });
    assert.strictEqual(sync.ok, true);
    assert.ok(!JSON.stringify(sync).includes(SECRET), "the sync result carries no credential");
    assert.ok(!JSON.stringify(world.endpoints.listEndpoints({})).includes(SECRET), "stored endpoints carry no credential");
    assert.ok(!fs.readFileSync(path.join(world.store.configDirectory, "endpoints.json"), "utf8").includes(SECRET), "endpoints.json carries no credential");
  });

  // -------------------------------------------------------------------------
  // V2-K D2: provider diagnostic text is scrubbed in every shape
  // -------------------------------------------------------------------------
  await test("D2: credentials in diagnostic text never reach provider state, sync results or persisted data", async () => {
    const world = makeWorld();
    const shapes = [
      { ok: false, message: `auth failed: secret_key=${SECRET}` },
      `playit agent key ${SECRET}`,
      [`tunnel refused; token: ${SECRET}`, `agent-key: "${SECRET}" rejected`],
      [{ code: "PLAYIT_AGENT", message: `restart; Authorization: Bearer ${SECRET}` }],
      { errorCode: `ERR_${SECRET}`, message: `password=${SECRET} was refused` },
    ];
    for (const diagnostics of shapes) {
      world.snapshot = { installed: true, running: true, connected: false, diagnostics };
      const state = await world.service.getProviderStateForNode({ nodeId: NODE, providerId: "playit" });
      assert.ok(state.diagnostics.length > 0, `${JSON.stringify(diagnostics).slice(0, 40)}: the diagnostic is kept`);
      assert.ok(!JSON.stringify(state).includes(SECRET), `${JSON.stringify(diagnostics).slice(0, 40)}: no credential in provider state`);
      const snapshot = await world.service.getProviderSnapshot({ nodeId: NODE, refresh: true });
      assert.ok(!JSON.stringify(snapshot).includes(SECRET), "no credential in the snapshot the renderer receives");
      const cached = await world.service.getCachedProviderSnapshot({ nodeId: NODE });
      assert.ok(!JSON.stringify(cached).includes(SECRET), "no credential in the cached state background readers use");
    }
    // a short, low-entropy secret is caught only by the assignment rule
    const SHORT = "hunter2pass";
    for (const diagnostics of [{ ok: false, message: `login refused: secret_key=${SHORT}` }, [`agent-key: ${SHORT}`], `password = "${SHORT}" expired`]) {
      world.snapshot = { installed: true, running: true, connected: false, diagnostics };
      const shortState = await world.service.getProviderStateForNode({ nodeId: NODE, providerId: "playit" });
      assert.ok(!JSON.stringify(shortState).includes(SHORT), `${JSON.stringify(diagnostics).slice(0, 40)}: short credential removed`);
    }
    // a skipped tunnel's validation message is scrubbed too (sync result -> renderer)
    world.snapshot = runningSnapshot([{ id: "t-skip", name: `api_key=${SECRET}`, localTarget: "127.0.0.1:4444", localPort: 4444, protocol: "tcp" }]);
    const sync = await world.service.syncTunnels({ nodeId: NODE });
    assert.ok(!JSON.stringify(sync).includes(SECRET), "no credential in the sync result");
    const persisted = fs.readFileSync(path.join(world.store.configDirectory, "endpoints.json"), "utf8");
    assert.ok(!persisted.includes(SECRET), "no credential in persisted endpoint or sync data");
    // structured identifiers are not diagnostic text: a long tunnel id survives
    const uuid = "3f2a9c1e-7b4d-4e8a-9c2f-1a2b3c4d5e6f";
    world.snapshot = runningSnapshot([tunnel(uuid, "anx-mc.joinmc.link:23001", 25565, "tcp")]);
    const kept = await world.service.getProviderStateForNode({ nodeId: NODE, providerId: "playit" });
    assert.strictEqual(kept.tunnels[0].id, uuid, "tunnel ids are not redacted");
  });

  // -------------------------------------------------------------------------
  // V2-K D3: background readers use the last-known state and never probe
  // -------------------------------------------------------------------------
  await test("D3: the cache-only read never requests a snapshot, even when nothing is known or the TTL expired", async () => {
    const world = makeWorld({ cacheTtlMs: 30_000 });
    world.snapshot = runningSnapshot([tunnel("t-mc", "anx-mc.joinmc.link:23001", 25565, "tcp")]);
    const empty = await world.service.getCachedProviderSnapshot({ nodeId: NODE });
    assert.deepStrictEqual(empty.providers, [], "nothing known yet: no providers, no probe");
    assert.strictEqual(empty.cache.cached, false);
    assert.strictEqual(world.calls, 0, "no snapshot request before an explicit read");

    await world.service.getProviderSnapshot({ nodeId: NODE });   // explicit read (Network page)
    assert.strictEqual(world.calls, 1);
    const cached = await world.service.getCachedProviderSnapshot({ nodeId: NODE });
    assert.strictEqual(cached.providers[0].state, "running", "the explicit read is reused");
    assert.strictEqual(cached.cache.cached, true);
    world.clock += 10 * 60_000;                                    // far past the TTL
    const stale = await world.service.getCachedProviderSnapshot({ nodeId: NODE });
    assert.strictEqual(stale.providers[0].state, "running", "last-known state survives the TTL");
    assert.ok(stale.cache.ageMs >= 10 * 60_000, "its age is reported");
    for (let i = 0; i < 5; i += 1) await world.service.getCachedProviderSnapshot({ nodeId: NODE });
    assert.strictEqual(world.calls, 1, "repeated background reads never request a snapshot");

    world.snapshot = { installed: true, running: false };
    await world.service.syncTunnels({ nodeId: NODE });             // explicit sync updates it
    assert.strictEqual((await world.service.getCachedProviderSnapshot({ nodeId: NODE })).providers[0].state, "stopped");
    world.snapshot = new Error("agent offline");
    await world.service.getProviderStateForNode({ nodeId: NODE, providerId: "playit" });
    assert.strictEqual((await world.service.getCachedProviderSnapshot({ nodeId: NODE })).providers[0].state, "unknown", "an explicit failed read is remembered honestly");
    assert.deepStrictEqual((await world.service.getCachedProviderSnapshot({ nodeId: OTHER_NODE })).providers, [], "per node");
    await expectRejectCode(world.service.getCachedProviderSnapshot({}), "NODE_REQUIRED");
  });

  // -------------------------------------------------------------------------
  // V2-K D1: provider sync records reach the snapshot through the real service
  // -------------------------------------------------------------------------
  await test("D1: snapshot.syncs carries the persisted sync record through the endpoint service contract", async () => {
    const endpointModule = require("../src/services/endpointService");
    assert.strictEqual(typeof endpointModule.getProviderSyncs, "function", "the default endpoint service exports getProviderSyncs");
    const world = makeWorld();
    assert.strictEqual(typeof world.endpoints.getProviderSyncs, "function", "the endpoint service instance exposes getProviderSyncs");
    world.snapshot = runningSnapshot([tunnel("t-mc", "anx-mc.joinmc.link:23001", 25565, "tcp")]);
    const before = await world.service.getProviderSnapshot({ nodeId: NODE, refresh: true });
    assert.strictEqual(before.syncs, null, "no sync recorded yet");
    const sync = await world.service.syncTunnels({ nodeId: NODE });
    const after = await world.service.getProviderSnapshot({ nodeId: NODE, refresh: true });
    assert.ok(after.syncs, "the snapshot carries the sync record");
    assert.strictEqual(after.syncs.lastSyncAt, sync.lastSyncAt);
    assert.strictEqual(after.syncs.state, "running");
    assert.strictEqual(after.syncs.tunnelCount, 1);
    assert.deepStrictEqual((await world.service.getCachedProviderSnapshot({ nodeId: NODE })).syncs, after.syncs, "the cache-only read carries it too");
    const fresh = createProviderIntegrationService({ deps: { endpointGateway: world.endpoints, getPlayitSnapshot: () => world.snapshot } });
    assert.strictEqual((await fresh.getProviderSnapshot({ nodeId: NODE })).syncs.lastSyncAt, sync.lastSyncAt, "the endpoint service itself is a complete gateway");
  });

  // -------------------------------------------------------------------------
  // Tunnel reconciliation
  // -------------------------------------------------------------------------
  await test("sync: creates, associates and records; one invalid tunnel is skipped without aborting", async () => {
    const world = makeWorld();
    manualEndpoint(world, { serviceId: "svc-minecraft", port: 25565, protocol: "tcp" });
    manualEndpoint(world, { name: "Voice A", serviceId: "svc-voice-a", host: "192.168.1.51", port: 7777, protocol: "udp" });
    manualEndpoint(world, { name: "Voice B", serviceId: "svc-voice-b", host: "192.168.1.52", port: 7777, protocol: "udp" });
    world.snapshot = runningSnapshot([
      tunnel("t-mc", "anx-mc.joinmc.link:23001", 25565, "tcp"),
      tunnel("t-voice", "anx-voice.ply.gg:41000", 7777, "udp"),
      tunnel("t-free", "anx-free.ply.gg:42000", 9999, "tcp"),
      tunnel("t-noport", "anx-noport.ply.gg:43000", null, "tcp"),
      // no public address: the endpoint model rejects the input (host required)
      { id: "t-nohost", name: "No host", localTarget: "127.0.0.1:4444", localPort: 4444, protocol: "tcp" },
    ]);

    const result = await world.service.syncTunnels({ nodeId: NODE });
    assert.strictEqual(result.ok, true, JSON.stringify(result.notes));
    assert.strictEqual(result.state, "running");
    assert.strictEqual(result.endpointsCreated.length, 3, "three tunnels became provider endpoints");
    assert.deepStrictEqual(result.endpointsUpdated, []);
    assert.deepStrictEqual(result.unchanged, []);
    assert.deepStrictEqual(result.associated.map((entry) => [entry.tunnelId, entry.serviceId]), [["t-mc", "svc-minecraft"]]);
    assert.deepStrictEqual(result.ambiguous, [{ tunnelId: "t-voice", services: ["svc-voice-a", "svc-voice-b"] }]);
    assert.strictEqual(result.unassociated.length, 1);
    assert.strictEqual(result.skipped.length, 1);
    assert.strictEqual(result.skipped[0].tunnelId, "t-nohost");
    assert.strictEqual(result.skipped[0].code, "ENDPOINT_VALIDATION_FAILED");
    assert.ok(result.notes.some((note) => /t-noport.*no local port/.test(note)), "a tunnel without a local port is noted");

    const stored = providerEndpoints(world);
    assert.strictEqual(stored.length, 3);
    const mc = stored.find((endpoint) => endpoint.metadata && endpoint.metadata.tunnelId === "t-mc");
    assert.ok(mc, "the t-mc endpoint is stored");
    assert.strictEqual(mc.host, "anx-mc.joinmc.link");
    assert.strictEqual(mc.port, 23001, "the public port is used, never invented");
    assert.strictEqual(mc.serviceId, "svc-minecraft");
    assert.strictEqual(mc.providerId, "playit");
    assert.strictEqual(mc.computerId, NODE);
    const voice = stored.find((endpoint) => endpoint.metadata && endpoint.metadata.tunnelId === "t-voice");
    assert.strictEqual(voice.serviceId ?? null, null, "an ambiguous tunnel is not associated with either service");

    const syncs = world.store.getProviderSyncs();
    assert.strictEqual(syncs[NODE].providerId, "playit");
    assert.strictEqual(syncs[NODE].state, "running");
    assert.strictEqual(syncs[NODE].tunnelCount, 5);
    assert.strictEqual(syncs[NODE].errorCode ?? null, null);
  });

  await test("sync is idempotent, reports updates, and reports stale endpoints without deleting them", async () => {
    const world = makeWorld();
    const tunnels = [
      tunnel("t-mc", "anx-mc.joinmc.link:23001", 25565, "tcp"),
      tunnel("t-free", "anx-free.ply.gg:42000", 9999, "tcp"),
    ];
    world.snapshot = runningSnapshot(tunnels);
    const first = await world.service.syncTunnels({ nodeId: NODE });
    assert.strictEqual(first.endpointsCreated.length, 2);
    const ids = [...first.endpointsCreated].sort();

    const again = await world.service.syncTunnels({ nodeId: NODE });
    assert.deepStrictEqual(again.endpointsCreated, [], "a repeated sync creates nothing");
    assert.deepStrictEqual(again.endpointsUpdated, []);
    assert.deepStrictEqual([...again.unchanged].sort(), ids, "a repeated sync reports every record unchanged");
    assert.strictEqual(providerEndpoints(world).length, 2);

    // t-mc moves to a new public port; t-free disappears from Playit.
    world.snapshot = runningSnapshot([tunnel("t-mc", "anx-mc.joinmc.link:23999", 25565, "tcp")]);
    const moved = await world.service.syncTunnels({ nodeId: NODE });
    assert.strictEqual(moved.endpointsCreated.length + moved.endpointsUpdated.length, 1, "the moved tunnel is created or updated, never left stale");
    const freeId = first.endpointsCreated.find((id) => providerEndpoints(world).find((endpoint) => endpoint.id === id && endpoint.metadata.tunnelId === "t-free"));
    assert.ok(freeId, "the t-free endpoint id is known");
    assert.ok(moved.staleProviderEndpoints.includes(freeId), "the vanished tunnel's endpoint is reported stale");
    const stale = world.endpoints.getEndpoint(freeId);
    assert.strictEqual(stale.enabled, true, "a stale provider endpoint is never disabled");
    assert.ok(moved.notes.some((note) => /reported only, left unchanged/.test(note)));
    const current = providerEndpoints(world).find((endpoint) => endpoint.metadata.tunnelId === "t-mc" && endpoint.port === 23999);
    assert.ok(current, "the moved tunnel's endpoint carries the new public port");
  });

  await test("stale detection is per node and per provider", async () => {
    const world = makeWorld();
    world.snapshot = runningSnapshot([tunnel("t-b", "anx-b.ply.gg:44000", 8080, "tcp")]);
    const other = await world.service.syncTunnels({ nodeId: OTHER_NODE });
    assert.strictEqual(other.endpointsCreated.length, 1);
    world.snapshot = runningSnapshot([]);
    const mine = await world.service.syncTunnels({ nodeId: NODE });
    assert.strictEqual(mine.ok, true);
    assert.deepStrictEqual(mine.staleProviderEndpoints, [], "another node's provider endpoints are never reported stale here");
    assert.strictEqual(providerEndpoints(world, OTHER_NODE).length, 1);
  });

  await test("refusals change nothing: not installed, snapshot unavailable, snapshot invalid", async () => {
    const world = makeWorld();
    world.snapshot = runningSnapshot([tunnel("t-mc", "anx-mc.joinmc.link:23001", 25565, "tcp")]);
    await world.service.syncTunnels({ nodeId: NODE });
    const before = JSON.stringify(world.endpoints.listEndpoints({}));
    const cases = [
      [{ installed: false, running: false, tunnels: [tunnel("t-x", "x.ply.gg:1", 1, "tcp")] }, "PLAYIT_NOT_INSTALLED", "not-installed"],
      [new Error("agent offline"), "AGENT_UNAVAILABLE", "unknown"],
      ["not an object", "PROVIDER_SNAPSHOT_INVALID", "unknown"],
    ];
    for (const [snapshot, errorCode, state] of cases) {
      world.snapshot = snapshot;
      const result = await world.service.syncTunnels({ nodeId: NODE });
      assert.strictEqual(result.ok, false, errorCode);
      assert.strictEqual(result.errorCode, errorCode);
      assert.strictEqual(result.state, state);
      assert.deepStrictEqual(result.endpointsCreated, []);
      assert.strictEqual(JSON.stringify(world.endpoints.listEndpoints({})), before, `${errorCode}: no endpoint changed`);
      const recorded = world.store.getProviderSyncs()[NODE];
      assert.strictEqual(recorded.errorCode, errorCode, "the refusal is recorded");
      assert.strictEqual(recorded.tunnelCount, 0);
    }
  });

  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (failures.length) {
    console.error(`provider-integration smoke: ${failures.length} failed, ${checks} passed`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(`provider-integration smoke: all ${checks} test groups passed`);
  process.exitCode = 0;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
