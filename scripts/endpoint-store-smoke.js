"use strict";

// Smoke test for the endpoint store. Run from the repository root:
//   node scripts/endpoint-store-smoke.js
//
// Covers: CRUD round trip, duplicate identity rejection, timestamp preservation,
// not-found paths, enabled toggling, provider sync merging, corrupt-file
// quarantine, future-schema refusal (negative control), the v0 migration guard,
// and legacy Public Access migration (imports, skips, idempotence, dry run).

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createEndpointStore } = require("../src/services/endpointStore");

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

function tempDir(prefix = "anx-endpoint-store-") {
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

function writeLegacyFixture(dir) {
  const payload = {
    schemaVersion: 1,
    services: [
      {
        id: "access-playit-1",
        name: "Anxlab FXServer",
        providerId: "playit",
        nodeId: "agent-node-1",
        linkedInstanceId: "instance-fivem",
        localHost: "127.0.0.1",
        localPort: 30120,
        protocol: "tcp",
        publicAddress: "x.playit.gg:30120",
        tunnelId: "tun-1",
        tunnelName: "fxserver",
        accessType: "public-internet",
      },
      {
        id: "access-ts-1",
        name: "Minecraft Tailnet",
        providerId: "tailscale",
        nodeId: "agent-node-1",
        localPort: 25565,
        protocol: "tcp",
        privateAddress: "100.101.102.103:25565",
        hostname: "anxbox.tailnet.ts.net",
        addressPreference: "ipv4",
        endpointOptions: [
          { type: "magicdns", label: "MagicDNS", host: "anxbox.tailnet.ts.net" },
          { type: "ipv4", label: "Tailscale IPv4", host: "100.101.102.103" },
          { type: "ipv6", label: "Tailscale IPv6", host: "fd7a:115c::1" },
          { type: "magicdns", label: "MagicDNS (duplicate)", host: "anxbox.tailnet.ts.net" },
          { type: "ipv4", label: "Over cap", host: "100.101.102.104" },
        ],
      },
      { id: "access-broken", name: "Broken", providerId: "playit", nodeId: "agent-node-1", localPort: null },
    ],
  };
  const file = path.join(dir, "public-access-services.json");
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  return file;
}

(async () => {
  await test("CRUD round trip with id and timestamps", async () => {
    const dir = tempDir();
    const store = createEndpointStore({ configDirectory: dir });
    const created = store.upsert(baseInput(), { now: "2026-01-01T00:00:00.000Z" });
    assert.match(created.id, /^ep-[0-9a-f]{16}$/);
    assert.strictEqual(created.createdAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(created.updatedAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(created.source, "manual");
    assert.strictEqual(created.enabled, true);

    const document = store.load();
    assert.strictEqual(document.schemaVersion, 1);
    assert.strictEqual(document.endpoints.length, 1);
    assert.deepStrictEqual(document.providerSyncs, {});
    assert.strictEqual(document.legacyMigration, null);
    assert.ok(fs.existsSync(path.join(dir, "endpoints.json")));

    const fetched = store.get(created.id);
    assert.strictEqual(fetched.host, "192.168.1.50");
    assert.strictEqual(fetched.port, 30120);

    assert.strictEqual(store.list().length, 1);
    assert.strictEqual(store.list({ nodeId: "agent-node-1" }).length, 1);
    assert.strictEqual(store.list({ nodeId: "other-node" }).length, 0);
    assert.strictEqual(store.list({ serviceId: "svc-1" }).length, 1);
    assert.strictEqual(store.list({ type: "public" }).length, 0);
    assert.strictEqual(store.list({ enabled: true }).length, 1);
    assert.strictEqual(store.list({ enabled: false }).length, 0);

    const roundTrip = createEndpointStore({ configDirectory: dir });
    assert.strictEqual(roundTrip.load().endpoints.length, 1);
    assert.strictEqual(roundTrip.get(created.id).name, "Anxlab FXServer");
  });

  await test("duplicate endpointKey from a different id throws ENDPOINT_DUPLICATE", async () => {
    const store = createEndpointStore({ configDirectory: tempDir() });
    const first = store.upsert(baseInput(), { now: "2026-01-01T00:00:00.000Z" });
    const error = expectCode(
      () => store.upsert({ ...baseInput({ name: "Second name" }), id: "ep-forced-other" }, { now: "2026-01-01T00:00:00.000Z" }),
      "ENDPOINT_DUPLICATE",
    );
    assert.strictEqual(error.details.existingEndpointId, first.id);
    assert.strictEqual(store.list().length, 1);
  });

  await test("update preserves id and createdAt, refreshes updatedAt", async () => {
    const store = createEndpointStore({ configDirectory: tempDir() });
    const created = store.upsert(baseInput(), { now: "2026-01-01T00:00:00.000Z" });
    const updated = store.upsert({ ...created, name: "Renamed" }, { now: "2026-02-02T00:00:00.000Z" });
    assert.strictEqual(updated.id, created.id);
    assert.strictEqual(updated.createdAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(updated.updatedAt, "2026-02-02T00:00:00.000Z");
    assert.strictEqual(updated.name, "Renamed");
    assert.strictEqual(store.list().length, 1);
  });

  await test("remove and not-found paths, setEnabled", async () => {
    const store = createEndpointStore({ configDirectory: tempDir() });
    const created = store.upsert(baseInput(), { now: "2026-01-01T00:00:00.000Z" });
    expectCode(() => store.remove("ep-missing"), "ENDPOINT_NOT_FOUND");
    const disabled = store.setEnabled(created.id, false);
    assert.strictEqual(disabled.enabled, false);
    assert.strictEqual(store.list({ enabled: false }).length, 1);
    assert.strictEqual(store.get(created.id).enabled, false);
    expectCode(() => store.setEnabled(created.id, "yes"), "ENDPOINT_VALIDATION_FAILED");
    const removed = store.remove(created.id);
    assert.strictEqual(removed.id, created.id);
    assert.strictEqual(store.get(created.id), null);
    assert.strictEqual(store.list().length, 0);
  });

  await test("provider syncs merge into providerSyncs", async () => {
    const store = createEndpointStore({ configDirectory: tempDir() });
    const first = store.recordProviderSync("agent-node-1", {
      providerId: "playit",
      state: "synced",
      lastSyncAt: "2026-01-01T00:00:00.000Z",
      tunnelCount: 1,
    });
    assert.strictEqual(first.providerId, "playit");
    assert.strictEqual(first.tunnelCount, 1);
    const merged = store.recordProviderSync("agent-node-1", { tunnelCount: 2, errorCode: "PLAYIT_TIMEOUT" });
    assert.strictEqual(merged.providerId, "playit");
    assert.strictEqual(merged.state, "synced");
    assert.strictEqual(merged.tunnelCount, 2);
    assert.strictEqual(merged.errorCode, "PLAYIT_TIMEOUT");
    const syncs = store.getProviderSyncs();
    assert.deepStrictEqual(Object.keys(syncs), ["agent-node-1"]);
    assert.strictEqual(createEndpointStore({ configDirectory: store.configDirectory }).getProviderSyncs()["agent-node-1"].tunnelCount, 2);
    expectCode(() => store.recordProviderSync("", {}), "ENDPOINT_NODE_REQUIRED");
  });

  await test("corrupt file is quarantined and the store starts empty", async () => {
    const dir = tempDir();
    const file = path.join(dir, "endpoints.json");
    fs.writeFileSync(file, "{ this is not json");
    const store = createEndpointStore({ configDirectory: dir });
    const document = store.load();
    assert.deepStrictEqual(document.endpoints, []);
    assert.strictEqual(store.loadReport.corrupt, true);
    assert.strictEqual(store.loadReport.corruptCode, "ENDPOINT_STORE_CORRUPT");
    assert.ok(store.loadReport.corruptBackupPath, "quarantine path should be recorded");
    assert.match(path.basename(store.loadReport.corruptBackupPath), /^endpoints\.json\.corrupt-\d+$/);
    assert.ok(fs.existsSync(store.loadReport.corruptBackupPath), "quarantine copy must exist");
    assert.ok(fs.existsSync(file), "original file must never be silently deleted");
    assert.strictEqual(fs.readFileSync(file, "utf8"), "{ this is not json");
    const status = store.getStatus();
    assert.strictEqual(status.corrupt, true);
    assert.strictEqual(status.endpointCount, 0);
  });

  await test("future schemaVersion throws ENDPOINT_SCHEMA_UNSUPPORTED and leaves the file untouched", async () => {
    const dir = tempDir();
    const file = path.join(dir, "endpoints.json");
    fs.writeFileSync(file, `${JSON.stringify({ schemaVersion: 99, endpoints: [] }, null, 2)}\n`);
    const before = fs.readFileSync(file);
    const store = createEndpointStore({ configDirectory: dir });
    expectCode(() => store.load(), "ENDPOINT_SCHEMA_UNSUPPORTED");
    assert.ok(before.equals(fs.readFileSync(file)), "unsupported schema must not rewrite the file");
    const status = store.getStatus();
    assert.strictEqual(status.errorCode, "ENDPOINT_SCHEMA_UNSUPPORTED");
  });

  await test("schema v0 migrates behind a verified recovery point", async () => {
    const dir = tempDir();
    const file = path.join(dir, "endpoints.json");
    fs.writeFileSync(file, `${JSON.stringify({
      endpoints: [{ id: "ep-v0-one", name: "Legacy", type: "lan", host: "10.0.0.9", port: 8080, protocol: "tcp" }],
    }, null, 2)}\n`);
    const store = createEndpointStore({ configDirectory: dir });
    const document = store.load();
    assert.strictEqual(document.schemaVersion, 1);
    assert.strictEqual(document.endpoints.length, 1);
    assert.strictEqual(document.endpoints[0].id, "ep-v0-one");
    assert.ok(fs.existsSync(`${file}.schema-v0.backup`), "recovery point must be taken before the rewrite");
    assert.strictEqual(store.loadReport.migratedFrom, 0);
    assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, 1);
  });

  await test("legacy migration imports endpoints with expected types, hosts and metadata", async () => {
    const dir = tempDir();
    const legacyFile = writeLegacyFixture(dir);
    const legacyBytes = fs.readFileSync(legacyFile);
    const store = createEndpointStore({ configDirectory: dir });
    const document = store.load();

    assert.strictEqual(document.endpoints.length, 6);
    assert.ok(document.legacyMigration);
    assert.strictEqual(document.legacyMigration.source, "public-access-services.json");
    assert.strictEqual(document.legacyMigration.imported, 6);
    assert.strictEqual(document.legacyMigration.skipped, 2);
    assert.ok(document.legacyMigration.reasons.some((entry) => entry.reason === "no-port" && entry.ref === "access-broken"));
    assert.ok(document.legacyMigration.reasons.some((entry) => entry.reason === "duplicate" && entry.ref === "access-ts-1"));

    const find = (predicate) => document.endpoints.find(predicate);
    const localPlayit = find((entry) => entry.type === "private" && entry.port === 30120);
    assert.ok(localPlayit, "local private endpoint for the playit service");
    assert.strictEqual(localPlayit.host, "127.0.0.1");
    assert.strictEqual(localPlayit.serviceId, "instance-fivem");
    assert.strictEqual(localPlayit.computerId, "agent-node-1");
    assert.strictEqual(localPlayit.source, "discovered");
    assert.strictEqual(localPlayit.metadata.scope, "local");
    assert.strictEqual(localPlayit.metadata.legacyRef, "access-playit-1");
    assert.strictEqual(localPlayit.providerId, null);

    const publicPlayit = find((entry) => entry.type === "public");
    assert.ok(publicPlayit, "public endpoint for the playit service");
    assert.strictEqual(publicPlayit.host, "x.playit.gg");
    assert.strictEqual(publicPlayit.port, 30120);
    assert.strictEqual(publicPlayit.providerId, "playit");
    assert.strictEqual(publicPlayit.source, "provider");
    assert.strictEqual(publicPlayit.serviceId, "instance-fivem");
    assert.strictEqual(publicPlayit.metadata.tunnelId, "tun-1");
    assert.strictEqual(publicPlayit.metadata.tunnelName, "fxserver");
    assert.strictEqual(publicPlayit.metadata.accessType, "public-internet");

    const tailscalePrimary = find((entry) => entry.type === "tailscale" && entry.host === "100.101.102.103");
    assert.ok(tailscalePrimary, "tailscale primary endpoint from privateAddress");
    assert.strictEqual(tailscalePrimary.port, 25565);
    assert.strictEqual(tailscalePrimary.metadata.addressPreference, "ipv4");
    assert.strictEqual(tailscalePrimary.metadata.legacyRef, "access-ts-1");

    const magicDns = find((entry) => entry.type === "tailscale" && entry.host === "anxbox.tailnet.ts.net");
    assert.ok(magicDns, "tailscale MagicDNS option endpoint");
    assert.strictEqual(magicDns.metadata.optionLabel, "MagicDNS");

    const ipv6 = find((entry) => entry.type === "tailscale" && entry.host === "fd7a:115c::1");
    assert.ok(ipv6, "tailscale IPv6 option endpoint");
    assert.strictEqual(ipv6.metadata.optionLabel, "Tailscale IPv6");

    assert.ok(legacyBytes.equals(fs.readFileSync(legacyFile)), "the legacy file must never be written");

    const second = createEndpointStore({ configDirectory: dir });
    const secondDocument = second.load();
    assert.strictEqual(secondDocument.endpoints.length, 6);
    const again = second.migrateLegacyAccessServices();
    assert.strictEqual(again.alreadyApplied, true);
    assert.strictEqual(again.imported, 0);
    assert.ok(legacyBytes.equals(fs.readFileSync(legacyFile)));
  });

  await test("migration dry run writes nothing", async () => {
    const dir = tempDir();
    writeLegacyFixture(dir);
    const store = createEndpointStore({ configDirectory: dir });
    const report = store.migrateLegacyAccessServices({ dryRun: true, now: "2026-03-03T00:00:00.000Z" });
    assert.strictEqual(report.dryRun, true);
    assert.strictEqual(report.applied, false);
    assert.strictEqual(report.imported, 6);
    assert.strictEqual(report.skipped, 2);
    assert.ok(!fs.existsSync(path.join(dir, "endpoints.json")), "dry run must not create endpoints.json");
    assert.strictEqual(store.list().length, 0);

    const document = store.load();
    assert.strictEqual(document.endpoints.length, 6);
    assert.ok(document.legacyMigration.appliedAt);
  });

  await test("migration is skipped entirely when no legacy file exists", async () => {
    const dir = tempDir();
    const store = createEndpointStore({ configDirectory: dir });
    const report = store.migrateLegacyAccessServices();
    assert.strictEqual(report.imported, 0);
    assert.strictEqual(report.applied, false);
    assert.strictEqual(store.load().legacyMigration, null);
    assert.ok(!fs.existsSync(path.join(dir, "endpoints.json")));
  });

  if (failures.length > 0) {
    console.error(`endpoint-store smoke: ${failures.length} failed, ${checks} passed`);
    for (const failure of failures) console.error(`  FAIL ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`endpoint-store smoke: all ${checks} test groups passed`);
  }
})();
