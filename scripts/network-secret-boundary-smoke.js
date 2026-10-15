"use strict";

// Network/telemetry/notification secret-boundary smoke.
//
// Proves the V2-K networking, telemetry and notification surfaces never
// persist, export or project credential-shaped material:
//
//   1. provider path   raw Playit snapshot with token/apiKey/auth/refreshToken
//                      at the top level AND inside a tunnel, through
//                      providerIntegrationService.syncTunnels with a recording
//                      gateway -> sync result, recorded endpoint inputs,
//                      "store" content, getProviderSnapshot output and adapter
//                      diagnostics stay clean.
//   2. diagnostics     provider  state / instance / agent fixtures carrying
//                      secret markers through runDiagnostics -> serialized
//                      result incl. graph + evidence; plus a negative control
//                      proving createStage refuses nested (raw snapshot)
//                      evidence with a TypeError.
//   3. endpoint store  a legacy public-access-services.json fixture with
//                      secret-looking provider fields is migrated -> stored
//                      file bytes and the list projection stay clean and all
//                      metadata values are primitives.
//   4. notifications   collectState with node name / instance name / message-
//                      like state fields carrying "token=abc123" and
//                      "password: hunter2" -> notifications.json is redacted.
//   5. telemetry       a hostile telemetry.json (label "secret=xyz", private
//                      path) plus marker-laden endpoint metadata is loaded,
//                      sampled, saved and exported -> file + exportTelemetry
//                      contain no marker strings and no filesystem paths.
//   6. IPC projection  the real endpoints:list / notifications:list handlers
//                      (electron and the security gate stubbed with
//                      Module._load) -> no marker values and no key names
//                      matching /token|secret|password|api[_-]?key|authorization/i.
//
// Every assertion scans SERIALIZED content so a leaked key name and a leaked
// value both fail the run. Every leak-sensitive fixture starts with a negative
// control proving the marker scan can actually see the raw fixture. The smoke
// is hermetic: runtime roots are pinned by test-helpers/pin-agent-roots.js,
// every service is driven through injected deps, and all state lives in temp
// directories.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const { pinAgentRoots } = require("../test-helpers/pin-agent-roots");

const smokeRoot = pinAgentRoots("anxos-network-secret-boundary-");
// Pin explicitly even when the caller had ANXHUB_CONFIG_DIR set: the IPC
// projection scenario seeds a hostile endpoints.json into this directory.
process.env.ANXHUB_CONFIG_DIR = path.join(smokeRoot, "config");
delete process.env.ANXOS_NOTIFICATIONS_STORE;
const configDir = process.env.ANXHUB_CONFIG_DIR;
fs.mkdirSync(configDir, { recursive: true });

const diagnosticsModel = require("../src/shared/connectivityDiagnostics");
const { buildEndpointId } = require("../src/shared/endpointModel");
const telemetryStore = require("../src/shared/telemetryStore");
const { createPlayitProviderAdapter } = require("../src/shared/providers/playitProviderAdapter");
const { createProviderIntegrationService } = require("../src/services/providerIntegrationService");
const { createConnectivityDiagnosticsService } = require("../src/services/connectivityDiagnosticsService");
const { createEndpointStore } = require("../src/services/endpointStore");
const { createEndpointService } = require("../src/services/endpointService");
const { createOperationalNotificationService } = require("../src/services/operationalNotificationService");
const { createTelemetryService } = require("../src/services/telemetryService");

// ---------------------------------------------------------------------------
// Markers and scanners
// ---------------------------------------------------------------------------

const MARKERS = Object.freeze({
  topToken: "playit-secret-ALLIGATOR",
  topApiKey: "key-ALLIGATOR-top",
  authPassword: "pw-ALLIGATOR-auth",
  refreshToken: "rt-ALLIGATOR-refresh",
  tunnelToken: "tunnel-secret-ALLIGATOR",
  tunnelApiKey: "key-ALLIGATOR-tunnel",
  tunnelPassword: "pw-ALLIGATOR-tunnel",
  legacyToken: "playit-secret-ALLIGATOR-legacy",
  legacyApiKey: "key-ALLIGATOR-legacy",
  legacyPassword: "pw-ALLIGATOR-legacy",
  legacyRefresh: "rt-ALLIGATOR-legacy",
  injectedApiKey: "key-ALLIGATOR-endpoint",
  injectedToken: "playit-secret-ALLIGATOR-endpoint",
  notificationToken: "token=abc123",
  notificationPassword: "password: hunter2",
  telemetryLabel: "secret=xyz",
  telemetryPath: "C:\\Users\\aj\\private\\telemetry.log",
});

const PROVIDER_MARKERS = Object.freeze([
  MARKERS.topToken,
  MARKERS.topApiKey,
  MARKERS.authPassword,
  MARKERS.refreshToken,
  MARKERS.tunnelToken,
  MARKERS.tunnelApiKey,
  MARKERS.tunnelPassword,
]);

const ALLIGATOR = /alligator/i;

// Matches both raw (C:\Users\...) and JSON-escaped (C:\\Users\\...) private
// paths so a scan of serialized content cannot be fooled by escaping.
const PRIVATE_PATH_PATTERN = /(?:[A-Za-z]:[\\/]{1,2}Users[\\/]{1,2}|\/home\/|\/Users\/)/;

// The IPC key-name contract from the task: token/secret/password/apiKey/
// authorization. The denylist adds the provider adapter's own field names
// (auth, refreshToken, ...) which must never appear as object keys either.
const SENSITIVE_KEY_PATTERN = /token|secret|password|api[_-]?key|authorization/i;
const SENSITIVE_KEY_DENYLIST = Object.freeze([
  "token",
  "apikey",
  "auth",
  "refreshtoken",
  "accesstoken",
  "privatekey",
  "password",
  "secret",
  "authorization",
  "credential",
]);

function serialized(value) {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

function assertNoAlligator(value, label) {
  const text = serialized(value);
  assert.ok(!ALLIGATOR.test(text), `${label}: ALLIGATOR marker leaked: ${text.slice(0, 300)}`);
}

function assertNoMarkers(value, label, markers) {
  const text = serialized(value);
  for (const marker of markers) {
    assert.ok(!text.includes(marker), `${label}: marker "${marker}" leaked: ${text.slice(0, 300)}`);
  }
}

function assertNoPrivatePaths(value, label) {
  const text = serialized(value);
  assert.ok(!PRIVATE_PATH_PATTERN.test(text), `${label}: private filesystem path leaked: ${text.slice(0, 300)}`);
}

function isSensitiveKeyName(key) {
  const text = String(key);
  if (SENSITIVE_KEY_PATTERN.test(text)) return true;
  const compact = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_DENYLIST.some((entry) => compact.includes(entry));
}

function collectSensitiveKeyPaths(value, prefix = "$", found = [], depth = 0) {
  if (found.length >= 50 || depth > 10 || value === null || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectSensitiveKeyPaths(value[index], `${prefix}[${index}]`, found, depth + 1);
    }
    return found;
  }
  for (const key of Object.keys(value)) {
    const childPrefix = `${prefix}.${key}`;
    if (isSensitiveKeyName(key)) found.push(childPrefix);
    collectSensitiveKeyPaths(value[key], childPrefix, found, depth + 1);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 1. Provider path
// ---------------------------------------------------------------------------

const FIXED_NOW_ISO = "2026-09-28T03:30:00.000Z";
const PROVIDER_NODE_ID = "node-secret-alpha";

function secretPlayitSnapshot() {
  return {
    installed: true,
    running: true,
    connected: true,
    version: "0.15.0",
    region: "us-west",
    lastCheckedAt: FIXED_NOW_ISO,
    token: MARKERS.topToken,
    apiKey: MARKERS.topApiKey,
    auth: { password: MARKERS.authPassword },
    refreshToken: MARKERS.refreshToken,
    diagnostics: { errorCode: null, message: `Sign in required for tunnel; token=${MARKERS.topToken}` },
    tunnels: [
      {
        id: "t-77",
        name: "Public tunnel",
        publicAddress: "axn.playit.gg:30120",
        localTarget: "127.0.0.1:30120",
        protocol: "tcp",
        region: "us-west",
        token: MARKERS.tunnelToken,
        apiKey: MARKERS.tunnelApiKey,
        auth: { password: MARKERS.tunnelPassword },
      },
    ],
  };
}

function createRecordingGateway() {
  const state = { endpoints: [], inputs: [], syncPatches: [], calls: [] };
  return {
    state,
    listEndpoints({ nodeId } = {}) {
      state.calls.push("listEndpoints");
      return state.endpoints.map((entry) => JSON.parse(JSON.stringify(entry)));
    },
    upsertProviderEndpoint({ input, nodeId } = {}) {
      state.calls.push("upsertProviderEndpoint");
      const recorded = JSON.parse(JSON.stringify(input));
      state.inputs.push({ nodeId: nodeId || null, input: recorded });
      const existingIndex = state.endpoints.findIndex((entry) => entry.id === recorded.id);
      const endpoint = { ...recorded, id: recorded.id || buildEndpointId(recorded) };
      if (existingIndex >= 0) state.endpoints[existingIndex] = endpoint;
      else state.endpoints.push(endpoint);
      return JSON.parse(JSON.stringify(endpoint));
    },
    recordProviderSync(nodeId, patch) {
      state.calls.push("recordProviderSync");
      state.syncPatches.push({ nodeId: nodeId || null, patch: JSON.parse(JSON.stringify(patch)) });
    },
    getProviderSyncs() {
      state.calls.push("getProviderSyncs");
      return {};
    },
  };
}

async function scenarioProviderPath() {
  const fixture = secretPlayitSnapshot();
  // Negative control: the raw snapshot really carries every marker, so the
  // absence assertions below would fail if any path echoed them.
  const fixtureText = serialized(fixture);
  assert.ok(fixtureText.includes("ALLIGATOR") && fixtureText.includes(MARKERS.topToken), "negative control: raw snapshot must contain the markers");

  const gateway = createRecordingGateway();
  const service = createProviderIntegrationService({
    deps: {
      getPlayitSnapshot: () => JSON.parse(JSON.stringify(fixture)),
      endpointGateway: gateway,
      snapshotTimeoutMs: 100,
    },
    now: () => FIXED_NOW_ISO,
  });

  const syncResult = await service.syncTunnels({ nodeId: PROVIDER_NODE_ID });
  assert.equal(syncResult.ok, true, "the fixture snapshot must sync successfully");
  assert.equal(syncResult.endpointsCreated.length, 1, "the tunnel must become exactly one endpoint");
  assert.equal(gateway.state.inputs.length, 1, "the gateway must have recorded one endpoint input");
  assert.equal(gateway.state.syncPatches.length, 1, "the gateway must have recorded one provider sync");

  const providerSnapshot = await service.getProviderSnapshot({ nodeId: PROVIDER_NODE_ID, refresh: true });
  assert.equal(providerSnapshot.providers.length, 2, "playit + manual providers are reported");

  assertNoAlligator(syncResult, "provider sync result");
  assertNoMarkers(syncResult, "provider sync result", PROVIDER_MARKERS);
  assertNoAlligator({ inputs: gateway.state.inputs, endpoints: gateway.state.endpoints, syncPatches: gateway.state.syncPatches }, "provider gateway persistence");
  assertNoMarkers({ inputs: gateway.state.inputs, endpoints: gateway.state.endpoints, syncPatches: gateway.state.syncPatches }, "provider gateway persistence", PROVIDER_MARKERS);
  assertNoAlligator(providerSnapshot, "getProviderSnapshot output");
  assertNoMarkers(providerSnapshot, "getProviderSnapshot output", PROVIDER_MARKERS);

  const sensitivePaths = collectSensitiveKeyPaths({
    syncResult,
    recordedInputs: gateway.state.inputs,
    recordedEndpoints: gateway.state.endpoints,
    recordedSyncs: gateway.state.syncPatches,
    providerSnapshot,
  });
  assert.deepEqual(sensitivePaths, [], `provider path exposed sensitive key names: ${sensitivePaths.join(", ")}`);

  // Fidelity: the clean tunnel fields did survive (the absence above is not
  // the product of "nothing was produced").
  assert.equal(syncResult.tunnels[0].id, "t-77");
  assert.equal(gateway.state.endpoints[0].host, "axn.playit.gg");
  assert.equal(gateway.state.endpoints[0].port, 30120);

  // Adapter-stripped state diagnostics must not echo the credential-shaped
  // snapshot diagnostics message (it must be scrubbed, not passed through).
  const adapter = createPlayitProviderAdapter();
  const adapterState = adapter.status(secretPlayitSnapshot());
  assert.equal(adapterState.state, "running");
  assert.equal(adapterState.tunnels.length, 1);
  assertNoAlligator(adapterState, "playit adapter state");
  assert.ok(
    adapterState.diagnostics.some((entry) => entry.message === "[redacted]"),
    "the adapter must scrub a credential-shaped diagnostics message",
  );
  const playitProvider = providerSnapshot.providers.find((provider) => provider.providerId === "playit");
  assert.ok(playitProvider.diagnostics.some((entry) => entry.message === "[redacted]"), "the snapshot path must scrub the same message");
}

// ---------------------------------------------------------------------------
// 2. Diagnostics path
// ---------------------------------------------------------------------------

const DIAGNOSTICS_NOW = "2026-09-28T04:00:00.000Z";
const DIAGNOSTICS_NODE_ID = "node-diag-secret";
const DIAGNOSTICS_SERVICE_ID = "svc-anxrp";

async function scenarioDiagnosticsPath() {
  const providerFixture = {
    providerId: "playit",
    state: "running",
    connected: true,
    publicAddress: "anxrp.playit.gg:30120",
    region: "us-west",
    token: MARKERS.topToken,
    apiKey: MARKERS.topApiKey,
    auth: { password: MARKERS.authPassword },
    refreshToken: MARKERS.refreshToken,
    tunnels: [
      {
        id: "t-77",
        name: "AnxRP",
        protocol: "tcp",
        localPort: 30120,
        token: MARKERS.tunnelToken,
        apiKey: MARKERS.tunnelApiKey,
      },
    ],
  };
  const instanceFixture = {
    id: "svc-anxrp",
    displayName: "AnxRP",
    state: "running",
    processRunning: true,
    pid: 4242,
    uptimeSeconds: 600,
    healthState: "healthy",
    token: MARKERS.topToken,
    apiKey: MARKERS.topApiKey,
    env: { password: MARKERS.authPassword, refreshToken: MARKERS.refreshToken },
  };
  const agentFixture = {
    kind: "agent",
    state: "online",
    lastContact: DIAGNOSTICS_NOW,
    agentVersion: "1.4.0",
    stale: false,
    agentToken: MARKERS.topToken,
    refreshToken: MARKERS.refreshToken,
  };
  const endpointsFixture = [
    {
      id: "ep-public-1",
      name: "Playit tunnel",
      type: "public",
      host: "anxrp.playit.gg",
      port: 30120,
      protocol: "tcp",
      enabled: true,
      providerId: "playit",
      serviceId: DIAGNOSTICS_SERVICE_ID,
      computerId: DIAGNOSTICS_NODE_ID,
      metadata: { token: MARKERS.topToken },
      token: MARKERS.topToken,
    },
  ];

  // Negative control: every fixture carries markers that a leak would expose.
  assert.ok(serialized({ providerFixture, instanceFixture, agentFixture }).includes("ALLIGATOR"), "negative control: diagnostics fixtures must contain the markers");

  const service = createConnectivityDiagnosticsService({
    deps: {
      getServiceContext: async () => ({ instance: instanceFixture, computer: { id: DIAGNOSTICS_NODE_ID, name: "AJ-DESKTOP" } }),
      getAgentState: async () => agentFixture,
      getEndpoints: async () => endpointsFixture.map((entry) => ({ ...entry })),
      getProviderState: async () => providerFixture,
      getNetworkInventory: async () => ({
        supported: true,
        listenerSource: "fixture",
        listeners: [],
        interfaces: [],
        checkPort: { port: 30120, protocol: "tcp", listening: true, boundAddresses: ["0.0.0.0"], listenerSource: "fixture" },
      }),
      probeTcp: async () => ({ ok: true, result: "connected", latencyMs: 2 }),
    },
    now: () => DIAGNOSTICS_NOW,
  });

  const result = await service.runDiagnostics({ nodeId: DIAGNOSTICS_NODE_ID, serviceId: DIAGNOSTICS_SERVICE_ID, refresh: true });
  assert.equal(result.overall.state, "healthy", "the fixture must produce a healthy diagnostics run");
  assert.ok(result.graph && Array.isArray(result.graph.nodes) && result.graph.nodes.length > 0, "the result must include the connectivity graph");
  assertNoAlligator(result, "diagnostics result incl. graph + evidence");
  assertNoMarkers(result, "diagnostics result incl. graph + evidence", PROVIDER_MARKERS);

  // The provider evidence is rebuilt from the canonical state (raw snapshot
  // fields like top-level tunnelId never feed evidence).
  const providerStage = result.stages.find((stage) => stage.id === "provider");
  assert.ok(providerStage, "the provider stage must exist");
  assert.equal(providerStage.evidence.tunnelId, "t-77");
  assert.equal(providerStage.evidence.publicAddress, "anxrp.playit.gg:30120");

  // Negative control: the shared model refuses any nested evidence, so a raw
  // snapshot can never be embedded into a diagnostics stage at all.
  assert.throws(
    () => diagnosticsModel.createStage({ id: "provider", state: "unknown", evidence: { snapshot: providerFixture } }),
    (error) => error instanceof TypeError,
    "createStage must reject a nested provider snapshot",
  );
  assert.throws(
    () => diagnosticsModel.createStage({ id: "provider", state: "unknown", evidence: { snapshots: [providerFixture] } }),
    (error) => error instanceof TypeError,
    "createStage must reject an array of nested provider snapshots",
  );
  const scalarStage = diagnosticsModel.createStage({ id: "provider", state: "unknown", evidence: { tunnelId: "t-77" } });
  assert.equal(scalarStage.evidence.tunnelId, "t-77", "flat scalar evidence must still be accepted");
}

// ---------------------------------------------------------------------------
// 3. Endpoint store path
// ---------------------------------------------------------------------------

async function scenarioEndpointStorePath() {
  const dir = fs.mkdtempSync(path.join(smokeRoot, "endpoint-store-"));
  const legacyPath = path.join(dir, "public-access-services.json");
  const legacyPayload = {
    schemaVersion: 1,
    services: [
      {
        id: "access-secret",
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
        // Secret-looking provider fields the migration must never copy.
        providerToken: MARKERS.legacyToken,
        apiKey: MARKERS.legacyApiKey,
        auth: { password: MARKERS.legacyPassword },
        refreshToken: MARKERS.legacyRefresh,
        credentials: { apiKey: MARKERS.legacyApiKey },
      },
    ],
  };
  fs.writeFileSync(legacyPath, `${JSON.stringify(legacyPayload, null, 2)}\n`);
  const legacyBytes = fs.readFileSync(legacyPath);

  // Negative control: the legacy fixture really contains the markers.
  assert.ok(ALLIGATOR.test(legacyBytes.toString("utf8")), "negative control: the legacy fixture must contain the markers");

  const store = createEndpointStore({ configDirectory: dir });
  const document = store.load();
  assert.ok(document.legacyMigration && document.legacyMigration.source === "public-access-services.json", "the legacy file must migrate");
  assert.ok(document.legacyMigration.imported >= 1, "the legacy service must produce at least one endpoint");

  const created = store.upsert({
    name: "Manual endpoint",
    type: "lan",
    host: "10.0.0.77",
    port: 25565,
    protocol: "tcp",
    computerId: "agent-node-1",
    source: "manual",
    metadata: { region: "yyc", tier: 2 },
  });
  assert.match(created.id, /^ep-/);

  const endpointsPath = path.join(dir, "endpoints.json");
  const fileText = fs.readFileSync(endpointsPath, "utf8");
  assertNoAlligator(fileText, "endpoints.json bytes");
  assertNoMarkers(fileText, "endpoints.json bytes", [MARKERS.legacyToken, MARKERS.legacyApiKey, MARKERS.legacyPassword, MARKERS.legacyRefresh]);

  const reloaded = store.load();
  assertNoAlligator(reloaded, "endpoint store document");

  const service = createEndpointService({ store });
  const listed = service.listEndpoints({ nodeId: "agent-node-1" });
  assertNoAlligator(listed, "endpoints list projection");
  assertNoMarkers(listed, "endpoints list projection", [MARKERS.legacyToken, MARKERS.legacyApiKey, MARKERS.legacyPassword, MARKERS.legacyRefresh]);
  assert.deepEqual(collectSensitiveKeyPaths(listed), [], "the endpoint projection must not expose sensitive key names");

  for (const record of listed) {
    for (const [key, value] of Object.entries(record.metadata || {})) {
      const type = typeof value;
      assert.ok(
        value === null || type === "string" || type === "number" || type === "boolean",
        `${record.id} metadata.${key} must be a primitive, got ${type}`,
      );
    }
  }

  const migrated = listed.find((record) => record.metadata && record.metadata.legacyRef === "access-secret" && record.type === "public");
  assert.ok(migrated, "the legacy public service must be projected as a public endpoint");
  assert.equal(migrated.metadata.tunnelId, "tun-1", "legitimate addressing metadata survives migration");
  assert.ok(!Object.prototype.hasOwnProperty.call(migrated, "apiKey"), "credential-shaped top-level fields must not survive");
  assert.ok(!Object.prototype.hasOwnProperty.call(migrated, "providerToken"));

  // A nested metadata value is refused at the write path instead of persisted.
  assert.throws(
    () => store.upsert({
      name: "Nested metadata",
      type: "lan",
      host: "10.0.0.88",
      metadata: { nested: { token: MARKERS.legacyToken } },
    }),
    (error) => error && error.code === "ENDPOINT_VALIDATION_FAILED",
    "nested metadata must be rejected",
  );
  assertNoAlligator(fs.readFileSync(endpointsPath, "utf8"), "endpoints.json bytes after the rejected write");

  assert.ok(legacyBytes.equals(fs.readFileSync(legacyPath)), "the legacy file must never be rewritten");
}

// ---------------------------------------------------------------------------
// 4. Notification path
// ---------------------------------------------------------------------------

const NOTIFICATION_START_MS = Date.parse("2026-09-28T05:00:00.000Z");

async function scenarioNotificationPath() {
  const notificationsPath = path.join(configDir, "notifications.json");
  let clock = NOTIFICATION_START_MS;
  const service = createOperationalNotificationService({ storePath: notificationsPath, now: () => clock });

  const seedState = {
    nodes: [
      { nodeId: "node-secret", name: `workstation ${MARKERS.notificationToken}`, state: "online" },
      { nodeId: "node-plain", name: "beta", state: "online" },
    ],
    instances: [
      { nodeId: "node-2", instanceId: "svc-pass", name: `database ${MARKERS.notificationPassword}`, state: "Running" },
    ],
  };
  const transitionState = {
    nodes: [
      { nodeId: "node-secret", name: `workstation ${MARKERS.notificationToken}`, state: "offline" },
      { nodeId: "node-plain", name: "beta", state: "online" },
    ],
    instances: [
      { nodeId: "node-2", instanceId: "svc-pass", name: `database ${MARKERS.notificationPassword}`, state: MARKERS.notificationPassword },
    ],
  };

  // Negative control: the pre-redaction states really carry both markers.
  assert.ok(serialized({ seedState, transitionState }).includes(MARKERS.notificationToken), "negative control: fixtures must contain token=abc123");
  assert.ok(serialized({ seedState, transitionState }).includes(MARKERS.notificationPassword), "negative control: fixtures must contain password: hunter2");

  clock += 60000;
  const seeded = await service.evaluate({ collectState: async () => seedState });
  assert.equal(seeded.events.length, 0, "the first observation seeds state without emitting events");

  clock += 60000;
  const evaluated = await service.evaluate({ collectState: async () => transitionState });
  assert.equal(evaluated.events.length, 2, "one node disconnect and one service stop must emit");

  const storedText = fs.readFileSync(notificationsPath, "utf8");
  assert.ok(!storedText.includes("abc123"), "notifications.json must not contain token=abc123");
  assert.ok(!storedText.includes("hunter2"), "notifications.json must not contain password: hunter2");
  assert.ok(storedText.includes("[redacted]"), "notifications.json must carry the redaction placeholder");
  assertNoAlligator(storedText, "notifications.json");

  const stored = JSON.parse(storedText);
  const agentEvent = stored.events.find((event) => event.category === "agent");
  assert.ok(agentEvent, "the node disconnect event must be stored");
  assert.ok(agentEvent.message.includes("[redacted]") && !agentEvent.message.includes("abc123"), "the node name must be redacted in message");
  assert.ok(agentEvent.technicalDetails.includes("[redacted]") && !agentEvent.technicalDetails.includes("abc123"), "the node name must be redacted in technicalDetails");
  const serviceEvent = stored.events.find((event) => event.category === "service");
  assert.ok(serviceEvent, "the service stop event must be stored");
  assert.ok(serviceEvent.message.includes("[redacted]") && !serviceEvent.message.includes("hunter2"), "the message-like instance state must be redacted");
  assert.ok(serviceEvent.technicalDetails.includes("[redacted]") && !serviceEvent.technicalDetails.includes("hunter2"), "the raw instance state must be redacted in technicalDetails");

  // Note: identifier fields (dedupKey / target ids) are outside the module's
  // message/technicalDetails redaction contract; this smoke pins the
  // documented behavior, and any instance-name-as-fallback-id gap is tracked
  // as a reported finding rather than asserted here.
}

// ---------------------------------------------------------------------------
// 5. Telemetry path
// ---------------------------------------------------------------------------

const TELEMETRY_NOW_MS = Date.parse("2026-09-28T06:00:00.000Z");

async function scenarioTelemetryPath() {
  const telemetryPath = path.join(smokeRoot, "telemetry", "telemetry.json");
  fs.mkdirSync(path.dirname(telemetryPath), { recursive: true });

  // Negative control: a hostile store (written by a hypothetical older build
  // or tampered on disk) carries an unredacted label, metadata value and a
  // private filesystem path.
  const hostileState = {
    schemaVersion: 1,
    series: {
      "host:node-x:cpu": {
        key: "host:node-x:cpu",
        kind: "host",
        label: `CPU ${MARKERS.telemetryLabel}`,
        unit: "percent",
        nodeId: "node-x",
        instanceId: null,
        metadata: { note: MARKERS.telemetryPath, token: MARKERS.telemetryLabel },
        registeredAt: "2026-09-28T05:00:00.000Z",
        samples: [{ at: "2026-09-28T05:01:00.000Z", value: 1, missing: null }],
      },
    },
  };
  const hostileText = serialized(hostileState);
  assert.ok(hostileText.includes(MARKERS.telemetryLabel), "negative control: the hostile store must contain secret=xyz");
  assert.ok(
    hostileState.series["host:node-x:cpu"].metadata.note.includes("C:\\Users\\aj"),
    "negative control: the hostile store must contain the private path",
  );
  fs.writeFileSync(telemetryPath, `${JSON.stringify(hostileState, null, 2)}\n`);

  // 5a. Model boundary: registerSeries, read, serialize and export all redact.
  const modelState = telemetryStore.createEmptyState();
  const registration = telemetryStore.registerSeries(modelState, {
    key: "host:node-y:cpu",
    kind: "host",
    label: `CPU ${MARKERS.telemetryLabel}`,
    unit: "percent",
    metadata: { note: MARKERS.telemetryPath },
  });
  assert.equal(registration.ok, true);
  const read = telemetryStore.readSeries(modelState, "host:node-y:cpu");
  assert.ok(read.label.includes("[redacted]") && !read.label.includes(MARKERS.telemetryLabel), "registerSeries must redact the label");
  const modelBytes = telemetryStore.serializeState(modelState);
  assert.ok(!modelBytes.includes(MARKERS.telemetryLabel), "serializeState must redact the label");
  assertNoPrivatePaths(modelBytes, "serializeState output");
  const modelExport = telemetryStore.exportSeries(modelState, {});
  assert.ok(!serialized(modelExport).includes(MARKERS.telemetryLabel), "exportSeries must redact the label");

  // 5b. Service boundary: a marker-laden endpoint row must not reach the
  // persisted store or the export; the hostile loaded series must be redacted
  // on load, rewritten redacted, and exported redacted.
  const service = createTelemetryService({
    deps: {
      getPreferences: () => ({}),
      listNodes: async () => ({ nodes: [{ id: "node-telemetry", kind: "agent", enabled: true }] }),
      getHostSummary: async () => ({ cpu: { usagePercent: 12 }, memory: { percent: 41 }, disk: { percent: 30 } }),
      listInstances: async () => ({ instances: [] }),
      getInstanceMetrics: async () => ({}),
      getEndpointHealth: async () => ([
        {
          endpointId: "ep-anxrp",
          state: "healthy",
          label: MARKERS.notificationPassword,
          metadata: { apiKey: MARKERS.topApiKey, token: MARKERS.topToken },
        },
      ]),
      getProviderStates: async () => null,
    },
    storePath: telemetryPath,
    now: () => TELEMETRY_NOW_MS,
  });
  await service.sampleOnce();

  const fileText = fs.readFileSync(telemetryPath, "utf8");
  assert.ok(fileText.includes("[redacted]"), "telemetry.json must carry the redaction placeholder");
  assert.ok(!fileText.includes(MARKERS.telemetryLabel), "telemetry.json must not contain the raw series label marker");
  assert.ok(!ALLIGATOR.test(fileText), "telemetry.json must not contain endpoint metadata marker values");
  assert.ok(!fileText.includes("hunter2"), "telemetry.json must not contain endpoint label marker values");
  assertNoPrivatePaths(fileText, "telemetry.json");

  const exported = service.exportTelemetry({});
  const exportedText = serialized(exported);
  assert.ok(!exportedText.includes(MARKERS.telemetryLabel), "exportTelemetry must not contain the raw series label marker");
  assert.ok(!ALLIGATOR.test(exportedText), "exportTelemetry must not contain endpoint metadata marker values");
  assert.ok(!exportedText.includes("hunter2"), "exportTelemetry must not contain endpoint label marker values");
  assertNoPrivatePaths(exported, "exportTelemetry output");
  assert.ok(Array.isArray(exported.series) && exported.series.length > 0, "the export must contain the sampled series");

  const hostileSeries = exported.series.find((row) => row.key === "host:node-x:cpu");
  assert.ok(hostileSeries, "the hostile loaded series must survive as redacted, not disappear");
  assert.ok(hostileSeries.label.includes("[redacted]") && !hostileSeries.label.includes(MARKERS.telemetryLabel), "the loaded label must be redacted");
  assert.ok(!hostileSeries.metadata.note.includes("C:\\Users\\aj"), "the loaded metadata path must be redacted");
  assert.ok(!hostileSeries.metadata.token.includes(MARKERS.telemetryLabel), "the loaded metadata value must be redacted");
}

// ---------------------------------------------------------------------------
// 6. IPC projection
// ---------------------------------------------------------------------------

const IPC_NODE_ID = "agent-node-ipc";

function seedHostileEndpointFile() {
  const endpointsSeed = {
    schemaVersion: 1,
    endpoints: [
      {
        id: "ep-seeded",
        name: "Seeded endpoint",
        type: "lan",
        host: "192.168.1.99",
        port: 30120,
        protocol: "tcp",
        enabled: true,
        providerId: null,
        serviceId: null,
        computerId: IPC_NODE_ID,
        source: "manual",
        notes: "",
        metadata: { tunnelId: "tun-1", tunnelName: "fxserver", region: "yyc", nested: { token: MARKERS.injectedToken } },
        // Credential-shaped top-level fields the store's normalization drops.
        apiKey: MARKERS.injectedApiKey,
        token: MARKERS.injectedToken,
        auth: { password: MARKERS.legacyPassword },
      },
    ],
    providerSyncs: {},
    legacyMigration: null,
  };
  fs.writeFileSync(path.join(configDir, "endpoints.json"), `${JSON.stringify(endpointsSeed, null, 2)}\n`);
}

async function scenarioIpcProjection() {
  seedHostileEndpointFile();

  const handlers = new Map();
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "electron") {
      return { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } };
    }
    if (request === "../services/securityService") {
      return { audit: () => {}, requireLocalOwnerAuthenticated: () => {}, requirePermission: () => {} };
    }
    if (request === "./nodeContext") {
      return { requireNodeContext: (payload) => payload };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    require("../src/ipc/networkIpc").registerNetworkIpc();
    require("../src/ipc/notificationsIpc").registerNotificationsIpc();
  } finally {
    Module._load = originalLoad;
  }

  const endpointsHandler = handlers.get("endpoints:list");
  const notificationsHandler = handlers.get("notifications:list");
  assert.equal(typeof endpointsHandler, "function", "endpoints:list must be registered");
  assert.equal(typeof notificationsHandler, "function", "notifications:list must be registered");

  const endpointsResult = await endpointsHandler({}, { nodeId: IPC_NODE_ID });
  assert.ok(Array.isArray(endpointsResult.endpoints) && endpointsResult.endpoints.length === 1, "the seeded endpoint must be projected");
  const seeded = endpointsResult.endpoints[0];
  assert.ok(!Object.prototype.hasOwnProperty.call(seeded, "apiKey"), "unknown credential-shaped top-level keys must be dropped by the projection");
  assert.ok(!Object.prototype.hasOwnProperty.call(seeded, "token"));
  assert.ok(!Object.prototype.hasOwnProperty.call(seeded, "auth"));
  assertNoAlligator(endpointsResult, "endpoints:list handler output");

  // The notifications handler reads the store written by scenario 4.
  const notificationsResult = await notificationsHandler({}, { limit: 10 });
  assert.ok(Array.isArray(notificationsResult.events) && notificationsResult.events.length >= 1, "the stored notification events must be projected");
  const notificationsText = serialized(notificationsResult);
  assert.ok(!notificationsText.includes("abc123"), "notifications:list must not expose the node-name marker");
  assert.ok(!notificationsText.includes("hunter2"), "notifications:list must not expose the instance-state marker");
  assertNoAlligator(notificationsResult, "notifications:list handler output");

  const sensitivePaths = collectSensitiveKeyPaths({ endpointsResult, notificationsResult });
  assert.deepEqual(sensitivePaths, [], `sensitive key names must not reach any IPC output: ${sensitivePaths.join(", ")}`);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const scenarios = [
  ["provider path (sync -> endpoint -> snapshot)", scenarioProviderPath],
  ["diagnostics path (result + graph + evidence)", scenarioDiagnosticsPath],
  ["endpoint store path (legacy migration + projection)", scenarioEndpointStorePath],
  ["notification path (notifications.json redaction)", scenarioNotificationPath],
  ["telemetry path (telemetry.json + export redaction)", scenarioTelemetryPath],
  ["IPC projection (endpoints:list / notifications:list)", scenarioIpcProjection],
];

async function main() {
  console.log("network-secret-boundary smoke");
  for (const [name, run] of scenarios) {
    await run();
    console.log(`  [PASS] ${name}`);
  }
  console.log("network-secret-boundary smoke passed");
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
