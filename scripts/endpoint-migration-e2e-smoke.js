"use strict";

// Integration-level smoke for the legacy Public Access -> endpoint migration and
// endpoint-store recovery. Run from the repository root:
//   node scripts/endpoint-migration-e2e-smoke.js
//
// Scope:
//   1. A realistic legacy public-access-services.json in the exact schema
//      publicAccessServiceRegistry writes (schemaVersion 1 + services[]):
//      playit (FiveM-style), tailscale (privateAddress + endpointOptions),
//      cloudflare-tunnel, a record with no localPort, a record with an
//      unparseable public host, and a non-object entry. Asserted: report counts
//      and reasons, endpoint types/hosts/ports/protocols/providerIds and
//      metadata.legacyRef, serviceId/computerId links, the legacy file left
//      byte-for-byte untouched, second-load idempotence, and no automatic
//      migration when endpoints.json already exists.
//   2. Recovery: corrupt endpoints.json -> byte-exact quarantine + empty store,
//      with create/update/delete still working through endpointService and an
//      honest degraded flag.
//   3. Future schema (999) -> typed refusal, file untouched by later operations.
//   4. Compatibility: scripts/public-access-smoke.js still exits 0 with this
//      code present, and creates no endpoints.json in a pinned config dir.
//
// This complements scripts/endpoint-store-smoke.js (unit-level CRUD/migration
// coverage): here the fixture is the realistic registry-shaped state and the
// legacy subsystem is executed for real.

const assert = require("node:assert");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createEndpointStore } = require("../src/services/endpointStore");
const { createEndpointService } = require("../src/services/endpointService");

const root = path.resolve(__dirname, "..");

let checks = 0;
const failures = [];
const tempDirs = [];

function test(name, fn) {
  try {
    fn();
    checks += 1;
  } catch (error) {
    failures.push(`${name}: ${error && error.stack ? error.stack : String(error)}`);
  }
}

function tempDir(prefix = "anx-endpoint-migration-e2e-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
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

function readBytes(file) {
  return fs.readFileSync(file);
}

function findEndpoint(endpoints, predicate, label) {
  const match = endpoints.find(predicate);
  assert.ok(match, `expected an endpoint matching ${label || String(predicate)}`);
  return match;
}

// Realistic legacy registry state (the shape publicAccessServiceRegistry
// persists: schemaVersion 1 plus normalized access-service records).
function legacyFixture() {
  return {
    schemaVersion: 1,
    services: [
      {
        id: "access-playit-anxrp",
        name: "AnxRP Public",
        providerId: "playit",
        providerName: "Playit.gg",
        accessType: "public-internet",
        nodeId: "anxlab",
        linkedInstanceId: "anxrp",
        localHost: "127.0.0.1",
        localPort: 30120,
        protocol: "tcp",
        providerResourceId: null,
        publicAddress: "anxlab-example.playit.gg:30120",
        publicHostname: null,
        localServiceUrl: null,
        path: null,
        tunnelName: "anxrp",
        tunnelId: "tun-anxrp-30120",
        ingressStatus: null,
        privateAddress: null,
        hostname: null,
        IPv4: null,
        IPv6: null,
        addressPreference: null,
        endpointOptions: [],
        state: "running",
        status: "Public",
        providerResourceStatus: "detected",
        unsupportedReason: null,
        createdAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-09-20T08:30:00.000Z",
        lastCheckedAt: "2026-09-20T08:30:00.000Z",
      },
      {
        id: "access-tailscale-minecraft",
        name: "Minecraft Tailnet",
        providerId: "tailscale",
        providerName: "Tailscale",
        accessType: "private-tailnet",
        nodeId: "anxlab",
        linkedInstanceId: "minecraft-vanilla",
        localHost: "127.0.0.1",
        localPort: 25565,
        protocol: "tcp",
        providerResourceId: null,
        publicAddress: null,
        publicHostname: null,
        localServiceUrl: null,
        path: null,
        tunnelName: null,
        tunnelId: null,
        ingressStatus: null,
        privateAddress: "anxlab.tailnet.ts.net:25565",
        hostname: "anxlab.tailnet.ts.net",
        IPv4: "100.64.0.10",
        IPv6: "fd7a:115c:a1e0::10",
        addressPreference: "magicdns",
        endpointOptions: [
          { type: "magicdns", label: "MagicDNS", host: "anxlab.tailnet.ts.net", address: "anxlab.tailnet.ts.net:25565" },
          { type: "ipv4", label: "Tailscale IPv4", host: "100.64.0.10", address: "100.64.0.10:25565" },
          { type: "ipv6", label: "Tailscale IPv6", host: "fd7a:115c:a1e0::10", address: "[fd7a:115c:a1e0::10]:25565" },
          { type: "ipv4", label: "Over cap", host: "100.64.0.11", address: "100.64.0.11:25565" },
        ],
        state: "available",
        status: "Private Tailnet",
        providerResourceStatus: null,
        unsupportedReason: null,
        createdAt: "2026-08-02T10:00:00.000Z",
        updatedAt: "2026-09-20T08:30:00.000Z",
        lastCheckedAt: "2026-09-20T08:30:00.000Z",
      },
      {
        id: "access-cloudflare-panel",
        name: "Panel",
        providerId: "cloudflare-tunnel",
        providerName: "Cloudflare Tunnel",
        accessType: "public-internet",
        nodeId: "anxlab",
        linkedInstanceId: null,
        localHost: "127.0.0.1",
        localPort: 8080,
        protocol: "http",
        providerResourceId: null,
        publicAddress: "panel.example.com",
        publicHostname: "panel.example.com",
        localServiceUrl: "http://127.0.0.1:8080",
        path: null,
        tunnelName: null,
        tunnelId: "1a2b3c4d-5e6f-7890-abcd-ef0123456789",
        ingressStatus: "pending-config",
        privateAddress: null,
        hostname: null,
        IPv4: null,
        IPv6: null,
        addressPreference: null,
        endpointOptions: [],
        state: "pending-provider-setup",
        status: "Pending tunnel setup",
        providerResourceStatus: "not-created-by-anxos",
        unsupportedReason: null,
        createdAt: "2026-08-03T10:00:00.000Z",
        updatedAt: "2026-09-20T08:30:00.000Z",
        lastCheckedAt: "2026-09-20T08:30:00.000Z",
      },
      {
        id: "access-noport",
        name: "Incomplete record",
        providerId: "manual-port-forwarding",
        providerName: "Manual Port Forwarding",
        accessType: "public-internet",
        nodeId: "anxlab",
        linkedInstanceId: null,
        localHost: "127.0.0.1",
        localPort: null,
        protocol: "tcp",
        publicAddress: "anxlab.example.com:25565",
        state: "pending-provider-setup",
        status: "Pending provider setup",
        createdAt: "2026-08-04T10:00:00.000Z",
        updatedAt: "2026-09-20T08:30:00.000Z",
        lastCheckedAt: null,
      },
      {
        id: "access-badhost",
        name: "Malformed Public",
        providerId: "manual-port-forwarding",
        providerName: "Manual Port Forwarding",
        accessType: "public-internet",
        nodeId: "anxlab",
        linkedInstanceId: null,
        localHost: "127.0.0.1",
        localPort: 25575,
        protocol: "tcp",
        // A host with spaces can never validate as an endpoint host: the local
        // candidate imports, the public candidate is skipped as "invalid".
        publicAddress: "not a host:25575",
        state: "pending-provider-setup",
        status: "Pending provider setup",
        createdAt: "2026-08-05T10:00:00.000Z",
        updatedAt: "2026-09-20T08:30:00.000Z",
        lastCheckedAt: null,
      },
      "superseded-legacy-record",
    ],
  };
}

function writeLegacyFixture(dir) {
  const file = path.join(dir, "public-access-services.json");
  fs.writeFileSync(file, `${JSON.stringify(legacyFixture(), null, 2)}\n`, { mode: 0o600 });
  return file;
}

function writeEndpointsDocument(dir, document) {
  const file = path.join(dir, "endpoints.json");
  fs.writeFileSync(file, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function requireEndpointsJson(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "endpoints.json"), "utf8"));
}

// ---------------------------------------------------------------------------
// 1. Realistic legacy fixture -> endpoints, with links and untouched legacy file
// ---------------------------------------------------------------------------

test("realistic legacy fixture migrates with exact counts, reasons, and links", () => {
  const dir = tempDir();
  const legacyFile = writeLegacyFixture(dir);
  const legacyBytes = readBytes(legacyFile);

  const store = createEndpointStore({ configDirectory: dir });
  const document = store.load();

  assert.strictEqual(document.schemaVersion, 1);
  assert.strictEqual(document.endpoints.length, 9, "nine endpoints imported from the realistic fixture");
  assert.ok(document.legacyMigration, "the migration report must be persisted");
  assert.strictEqual(document.legacyMigration.source, "public-access-services.json");
  assert.strictEqual(document.legacyMigration.imported, 9);
  assert.strictEqual(document.legacyMigration.skipped, 3);
  assert.strictEqual(document.legacyMigration.reasons.length, 3);

  const reasonFor = (ref) => document.legacyMigration.reasons.find((entry) => entry.ref === ref) || null;
  assert.deepStrictEqual(reasonFor("access-tailscale-minecraft"), { ref: "access-tailscale-minecraft", reason: "duplicate" });
  assert.deepStrictEqual(reasonFor("access-noport"), { ref: "access-noport", reason: "no-port" });
  assert.deepStrictEqual(reasonFor("access-badhost"), { ref: "access-badhost", reason: "invalid" });
  assert.ok(
    !document.legacyMigration.reasons.some((entry) => String(entry.ref || "").includes("superseded")),
    "non-object entries are dropped without a fabricated reason",
  );

  const byType = {};
  for (const endpoint of document.endpoints) byType[endpoint.type] = (byType[endpoint.type] || 0) + 1;
  assert.deepStrictEqual(byType, { private: 4, tailscale: 3, public: 2 });
  for (const endpoint of document.endpoints) {
    assert.match(endpoint.id, /^ep-[0-9a-f]{16}$/);
    assert.strictEqual(endpoint.computerId, "anxlab", "every migrated endpoint keeps its node link");
  }

  // playit FiveM-style service.
  const playitLocal = findEndpoint(document.endpoints, (e) => e.type === "private" && e.port === 30120, "playit local");
  assert.strictEqual(playitLocal.host, "127.0.0.1");
  assert.strictEqual(playitLocal.protocol, "tcp");
  assert.strictEqual(playitLocal.providerId, null);
  assert.strictEqual(playitLocal.serviceId, "anxrp");
  assert.strictEqual(playitLocal.source, "discovered");
  assert.strictEqual(playitLocal.metadata.legacyRef, "access-playit-anxrp");
  assert.strictEqual(playitLocal.metadata.scope, "local");

  const playitPublic = findEndpoint(document.endpoints, (e) => e.type === "public" && e.providerId === "playit", "playit public");
  assert.strictEqual(playitPublic.host, "anxlab-example.playit.gg");
  assert.strictEqual(playitPublic.port, 30120);
  assert.strictEqual(playitPublic.protocol, "tcp");
  assert.strictEqual(playitPublic.serviceId, "anxrp");
  assert.strictEqual(playitPublic.source, "provider");
  assert.strictEqual(playitPublic.metadata.tunnelId, "tun-anxrp-30120");
  assert.strictEqual(playitPublic.metadata.tunnelName, "anxrp");
  assert.strictEqual(playitPublic.metadata.accessType, "public-internet");
  assert.strictEqual(playitPublic.metadata.legacyRef, "access-playit-anxrp");
  assert.ok(playitPublic.name.endsWith("(public)"), "the public candidate is distinguishable by name");

  // Tailscale service with endpointOptions (MagicDNS duplicates the primary).
  const tailscalePrimary = findEndpoint(document.endpoints, (e) => e.type === "tailscale" && e.host === "anxlab.tailnet.ts.net", "tailscale primary");
  assert.strictEqual(tailscalePrimary.port, 25565);
  assert.strictEqual(tailscalePrimary.protocol, "tcp");
  assert.strictEqual(tailscalePrimary.providerId, null);
  assert.strictEqual(tailscalePrimary.serviceId, "minecraft-vanilla");
  assert.strictEqual(tailscalePrimary.metadata.legacyRef, "access-tailscale-minecraft");
  assert.strictEqual(tailscalePrimary.metadata.addressPreference, "magicdns");
  assert.strictEqual(
    document.endpoints.filter((e) => e.host === "anxlab.tailnet.ts.net").length,
    1,
    "the MagicDNS option duplicates the primary host and is skipped, never doubled",
  );

  const tailscaleIpv4 = findEndpoint(document.endpoints, (e) => e.type === "tailscale" && e.host === "100.64.0.10", "tailscale ipv4");
  assert.strictEqual(tailscaleIpv4.port, 25565);
  assert.strictEqual(tailscaleIpv4.serviceId, "minecraft-vanilla");
  assert.strictEqual(tailscaleIpv4.metadata.optionLabel, "Tailscale IPv4");

  const tailscaleIpv6 = findEndpoint(document.endpoints, (e) => e.type === "tailscale" && e.host === "fd7a:115c:a1e0::10", "tailscale ipv6");
  assert.strictEqual(tailscaleIpv6.metadata.optionLabel, "Tailscale IPv6");
  assert.ok(!document.endpoints.some((e) => e.host === "100.64.0.11"), "endpointOptions beyond the per-service cap are not imported");

  // Cloudflare reverse-proxy record.
  const cloudflarePublic = findEndpoint(document.endpoints, (e) => e.providerId === "cloudflare-tunnel", "cloudflare public");
  assert.strictEqual(cloudflarePublic.type, "public");
  assert.strictEqual(cloudflarePublic.host, "panel.example.com");
  assert.strictEqual(cloudflarePublic.port, 8080);
  assert.strictEqual(cloudflarePublic.protocol, "http");
  assert.strictEqual(cloudflarePublic.source, "provider");
  assert.strictEqual(cloudflarePublic.metadata.legacyRef, "access-cloudflare-panel");
  assert.strictEqual(cloudflarePublic.metadata.tunnelId, "1a2b3c4d-5e6f-7890-abcd-ef0123456789");

  const cloudflareLocal = findEndpoint(document.endpoints, (e) => e.type === "private" && e.port === 8080, "cloudflare local");
  assert.strictEqual(cloudflareLocal.host, "127.0.0.1");
  assert.strictEqual(
    cloudflareLocal.protocol,
    "tcp",
    "a local candidate is normalized to tcp/udp: http ingress is not a local socket protocol",
  );
  assert.strictEqual(cloudflareLocal.serviceId, null);

  // Malformed host: local imports, the unparseable public candidate is refused.
  const badhostLocal = findEndpoint(document.endpoints, (e) => e.port === 25575, "badhost local");
  assert.strictEqual(badhostLocal.type, "private");
  assert.strictEqual(badhostLocal.host, "127.0.0.1");
  assert.strictEqual(badhostLocal.serviceId, null, "an unmapped legacy record still imports its local endpoint");
  assert.ok(!document.endpoints.some((e) => e.host.includes(" ")), "the unparseable public host was rejected, never stored");

  // The legacy file is read-only input, in every sense.
  assert.ok(legacyBytes.equals(readBytes(legacyFile)), "the legacy file must never be written");
  const persisted = requireEndpointsJson(dir);
  assert.strictEqual(persisted.schemaVersion, 1);
  assert.strictEqual(persisted.legacyMigration.imported, 9);
  assert.strictEqual(persisted.legacyMigration.skipped, 3);
  assert.strictEqual(store.loadReport.legacyMigration.imported, 9);
});

test("second load is idempotent and rewrites neither file", () => {
  const dir = tempDir();
  const legacyFile = writeLegacyFixture(dir);
  const first = createEndpointStore({ configDirectory: dir });
  first.load();
  const legacyBytes = readBytes(legacyFile);
  const endpointsBytes = readBytes(path.join(dir, "endpoints.json"));

  const second = createEndpointStore({ configDirectory: dir });
  const secondDocument = second.load();
  assert.strictEqual(secondDocument.endpoints.length, 9);
  assert.strictEqual(new Set(secondDocument.endpoints.map((e) => e.id)).size, 9, "endpoint ids stay unique across loads");

  const again = second.migrateLegacyAccessServices();
  assert.strictEqual(again.alreadyApplied, true);
  assert.strictEqual(again.imported, 0);
  assert.strictEqual(again.skipped, 0);
  assert.strictEqual(secondDocument.legacyMigration.imported, 9);
  assert.strictEqual(secondDocument.legacyMigration.reasons.length, 3);

  assert.ok(legacyBytes.equals(readBytes(legacyFile)), "a repeat load must not write the legacy file");
  assert.ok(
    endpointsBytes.equals(readBytes(path.join(dir, "endpoints.json"))),
    "a repeat load of the migrated state must not rewrite endpoints.json",
  );
});

test("a pre-existing endpoints.json prevents automatic legacy migration", () => {
  const dir = tempDir();
  const legacyFile = writeLegacyFixture(dir);
  const legacyBytes = readBytes(legacyFile);
  writeEndpointsDocument(dir, {
    schemaVersion: 1,
    endpoints: [
      {
        id: "ep-existing",
        name: "Existing endpoint",
        type: "lan",
        host: "192.168.1.77",
        port: 9999,
        protocol: "tcp",
        enabled: true,
        providerId: null,
        serviceId: null,
        computerId: "anxlab",
        source: "manual",
        notes: "",
        metadata: {},
        health: null,
        lastCheckedAt: null,
        createdAt: "2026-09-01T00:00:00.000Z",
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ],
    providerSyncs: {},
    legacyMigration: null,
  });

  const store = createEndpointStore({ configDirectory: dir });
  const document = store.load();
  assert.strictEqual(document.endpoints.length, 1);
  assert.strictEqual(document.endpoints[0].id, "ep-existing");
  assert.strictEqual(document.legacyMigration, null, "load must not auto-migrate when the endpoint registry already exists");
  assert.strictEqual(store.loadReport.legacyMigration, null);
  assert.ok(legacyBytes.equals(readBytes(legacyFile)));
});

// ---------------------------------------------------------------------------
// 2. Corrupt store recovery: quarantine + CRUD controls unaffected
// ---------------------------------------------------------------------------

test("corrupt endpoints.json is quarantined byte-for-byte and CRUD still works", () => {
  const dir = tempDir();
  const file = path.join(dir, "endpoints.json");
  const corruptBytes = Buffer.from('{"schemaVersion":1,"endpoints":[{"id":"ep-trunca', "utf8");
  fs.writeFileSync(file, corruptBytes);

  const store = createEndpointStore({ configDirectory: dir });
  const document = store.load();
  assert.deepStrictEqual(document.endpoints, [], "a corrupt store starts empty");
  assert.strictEqual(store.loadReport.corrupt, true);
  assert.strictEqual(store.loadReport.corruptCode, "ENDPOINT_STORE_CORRUPT");
  assert.ok(store.loadReport.corruptBackupPath, "a quarantine copy must be recorded");
  assert.ok(fs.existsSync(store.loadReport.corruptBackupPath), "the quarantine copy must exist");
  assert.ok(
    corruptBytes.equals(readBytes(store.loadReport.corruptBackupPath)),
    "quarantine must preserve the exact corrupt bytes",
  );
  assert.ok(fs.existsSync(file), "the original file must never be silently deleted");
  assert.ok(corruptBytes.equals(readBytes(file)), "the corrupt original stays in place until the store writes new state");
  assert.strictEqual(store.getStatus().corrupt, true);
  assert.strictEqual(store.getStatus().endpointCount, 0);

  const service = createEndpointService({ store });
  const created = service.createEndpoint({
    name: "Recovered LAN",
    type: "lan",
    host: "192.168.1.9",
    port: 30121,
    protocol: "tcp",
    computerId: "anxlab",
    source: "manual",
  });
  assert.match(created.id, /^ep-[0-9a-f]{16}$/);
  assert.strictEqual(service.getEndpoint(created.id).name, "Recovered LAN");

  const updated = service.updateEndpoint(created.id, { name: "Recovered LAN v2" });
  assert.strictEqual(updated.name, "Recovered LAN v2");
  assert.strictEqual(updated.id, created.id);

  const summary = service.getEndpointSummary();
  assert.strictEqual(summary.total, 1);
  assert.strictEqual(summary.degraded, true, "a recovered store reports itself degraded while the report says so");
  const resolved = service.resolveServiceEndpoints({ nodeId: "anxlab" });
  assert.strictEqual(resolved.degraded, true);
  assert.strictEqual(resolved.endpoints.length, 1);

  const removed = service.deleteEndpoint(created.id);
  assert.strictEqual(removed.id, created.id);
  assert.strictEqual(store.get(created.id), null);
  expectCode(() => service.getEndpoint(created.id), "ENDPOINT_NOT_FOUND");

  const persisted = requireEndpointsJson(dir);
  assert.strictEqual(persisted.schemaVersion, 1);
  assert.deepStrictEqual(persisted.endpoints, []);
  assert.ok(
    corruptBytes.equals(readBytes(store.loadReport.corruptBackupPath)),
    "the quarantine copy survives later writes",
  );
  assert.strictEqual(store.getStatus().corrupt, true);
  assert.strictEqual(store.getStatus().endpointCount, 0);
});

// ---------------------------------------------------------------------------
// 3. Future schema: typed refusal, byte-identical file
// ---------------------------------------------------------------------------

test("future endpoints schema is refused and never overwritten", () => {
  const dir = tempDir();
  const file = path.join(dir, "endpoints.json");
  const futureDocument = {
    schemaVersion: 999,
    endpoints: [{ id: "ep-future", name: "Future", type: "lan", host: "10.0.0.1", port: 1234, protocol: "tcp" }],
    providerSyncs: {},
    legacyMigration: null,
  };
  fs.writeFileSync(file, `${JSON.stringify(futureDocument, null, 2)}\n`, { mode: 0o600 });
  const before = readBytes(file);

  const store = createEndpointStore({ configDirectory: dir });
  const error = expectCode(() => store.load(), "ENDPOINT_SCHEMA_UNSUPPORTED");
  assert.strictEqual(error.details.schemaVersion, 999);
  assert.strictEqual(error.details.supportedSchemaVersion, 1);

  // Later operations keep refusing, and none of them may rewrite the file.
  expectCode(() => store.list(), "ENDPOINT_SCHEMA_UNSUPPORTED");
  expectCode(
    () => store.upsert({ name: "Nope", type: "lan", host: "10.0.0.2", port: 1235, protocol: "tcp" }),
    "ENDPOINT_SCHEMA_UNSUPPORTED",
  );
  expectCode(() => store.remove("ep-future"), "ENDPOINT_SCHEMA_UNSUPPORTED");
  expectCode(() => store.migrateLegacyAccessServices(), "ENDPOINT_SCHEMA_UNSUPPORTED");

  const status = store.getStatus();
  assert.strictEqual(status.errorCode, "ENDPOINT_SCHEMA_UNSUPPORTED");
  assert.strictEqual(status.exists, true);
  assert.strictEqual(status.corrupt, false);
  assert.strictEqual(status.schemaVersion, null);
  assert.strictEqual(status.endpointCount, 0);
  assert.ok(before.equals(readBytes(file)), "a future schema must stay byte-for-byte untouched");
  assert.deepStrictEqual(
    fs.readdirSync(dir),
    ["endpoints.json"],
    "no backup/quarantine/temp artifacts may be created for a refused schema",
  );

  const second = createEndpointStore({ configDirectory: dir });
  expectCode(() => second.load(), "ENDPOINT_SCHEMA_UNSUPPORTED");
  assert.ok(before.equals(readBytes(file)));
});

// ---------------------------------------------------------------------------
// 4. Compatibility: the legacy subsystem still passes and creates no store file
// ---------------------------------------------------------------------------

test("legacy Public Access smoke still exits 0 and creates no endpoints.json", () => {
  const pinned = tempDir();
  let exitCode = null;
  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, ["scripts/public-access-smoke.js"], {
      cwd: root,
      env: { ...process.env, ANXHUB_CONFIG_DIR: pinned },
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    exitCode = 0;
  } catch (error) {
    exitCode = typeof error.status === "number" ? error.status : 1;
    stdout = String(error.stdout || "");
  }
  assert.strictEqual(
    exitCode,
    0,
    `scripts/public-access-smoke.js must still exit 0 with the endpoint migration code present.\n${stdout.slice(-2000)}`,
  );
  assert.match(stdout, /Public Access smoke checks passed/);
  assert.ok(
    !fs.existsSync(path.join(pinned, "endpoints.json")),
    "the legacy subsystem must not create the new endpoint store file",
  );
  assert.deepStrictEqual(fs.readdirSync(pinned), [], "the legacy smoke must not write into the pinned config directory");
});

// ---------------------------------------------------------------------------
// Cleanup and report (the test calls above run in order at module evaluation)
// ---------------------------------------------------------------------------

for (const dir of tempDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* best-effort temp cleanup */
  }
}

if (failures.length > 0) {
  console.error(`endpoint-migration e2e smoke: ${failures.length} failed, ${checks} passed`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`endpoint-migration e2e smoke: all ${checks} test groups passed`);
}
