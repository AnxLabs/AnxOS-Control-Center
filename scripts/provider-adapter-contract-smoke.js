"use strict";

// Provider-adapter contract smoke.
//
// This is the gate that keeps the provider-adapter seam honest in both
// directions:
//
//   1. the two shipped adapters (Playit, Manual / Port Forwarding) satisfy the
//      contract validator,
//   2. malformed adapter definitions are refused with the exact error codes,
//   3. the Playit adapter maps the real snapshot shape (installed, running,
//      connected, tunnelAddress, tunnelDomain, localTarget, localIp,
//      localPort, protocol, tunnelId, version, lastCheckedAt, diagnostics,
//      tunnels) into the one canonical provider shape, including the
//      sensitive-field stripping that must never leak a credential,
//   4. createPlayitProviderAdapter().capabilities deep-equals the frozen
//      PLAYIT_PROVIDER_CAPABILITIES drift table,
//   5. the manual adapter reports setup-required with and without recorded
//      manual endpoints.
//
// Plain node plus node:assert. Every fixture is local; no file, process,
// network or provider access of any kind.

const assert = require("assert");

const contract = require("../src/shared/providerAdapterContract");
const playitModule = require("../src/shared/providers/playitProviderAdapter");
const manualModule = require("../src/shared/providers/manualProviderAdapter");

const playit = playitModule.createPlayitProviderAdapter();
const manual = manualModule.createManualProviderAdapter();

const FORBIDDEN_SECRET_TEXT = /secret|abc|refreshToken["']?\s*[:=]|password/i;

function allFalseCapabilities() {
  const capabilities = {};
  for (const id of contract.PROVIDER_CAPABILITY_IDS) capabilities[id] = false;
  return capabilities;
}

// ---------------------------------------------------------------------------
// Vocabulary and pure helpers
// ---------------------------------------------------------------------------

function testVocabulary() {
  assert.strictEqual(contract.CONTRACT_VERSION, 1, "Contract version must be declared.");
  assert.strictEqual(contract.PROVIDER_CAPABILITY_IDS.length, 10, "Ten provider capabilities are defined.");
  assert.strictEqual(contract.PROVIDER_STATES.length, 8, "Eight provider states are defined.");
  assert.strictEqual(contract.PROVIDER_AVAILABILITY.length, 3, "Three availability values are defined.");
  assert.strictEqual(contract.TUNNEL_PROTOCOLS.length, 4, "Four tunnel protocols are defined.");
  assert.strictEqual(contract.SENSITIVE_FIELD_DENYLIST.length, 11, "Eleven denylisted field names are defined.");
  assert(Object.isFrozen(contract.PROVIDER_CAPABILITY_IDS), "The capability vocabulary must be frozen.");
  assert(Object.isFrozen(contract.PROVIDER_STATES), "The provider states must be frozen.");
  assert(Object.isFrozen(contract.PROVIDER_AVAILABILITY), "The availability values must be frozen.");
  assert(Object.isFrozen(contract.TUNNEL_PROTOCOLS), "The tunnel protocols must be frozen.");
  assert(Object.isFrozen(contract.SENSITIVE_FIELD_DENYLIST), "The sensitive-field denylist must be frozen.");
  assert(contract.PROVIDER_STATES.includes("running"), "The state vocabulary includes running.");
  assert(contract.PROVIDER_STATES.includes("auth-required"), "The state vocabulary includes auth-required.");
  assert(contract.PROVIDER_CAPABILITY_IDS.includes("endpointDiscovery"), "The capability vocabulary includes endpointDiscovery.");
}

function testParseHostPort() {
  assert.deepStrictEqual(contract.parseHostPort("127.0.0.1:30120"), { host: "127.0.0.1", port: 30120 });
  assert.deepStrictEqual(contract.parseHostPort("axn.playit.gg"), { host: "axn.playit.gg", port: null });
  assert.deepStrictEqual(contract.parseHostPort(":30120"), { host: null, port: 30120 });
  assert.deepStrictEqual(contract.parseHostPort("[2001:db8::1]:25565"), { host: "2001:db8::1", port: 25565 });
  assert.deepStrictEqual(contract.parseHostPort("[2001:db8::1]"), { host: "2001:db8::1", port: null });
  assert.deepStrictEqual(contract.parseHostPort("2001:db8::1"), { host: "2001:db8::1", port: null });
  assert.deepStrictEqual(contract.parseHostPort("tcp://axn.playit.gg:25565"), { host: "axn.playit.gg", port: 25565 });
  assert.strictEqual(contract.parseHostPort(""), null);
  assert.strictEqual(contract.parseHostPort(null), null);
  assert.strictEqual(contract.parseHostPort(Number.NaN), null);
}

function testNormalizeTunnel() {
  assert.strictEqual(contract.normalizeTunnel({}), null, "A tunnel with no id, address or port is unrepairable.");
  assert.strictEqual(contract.normalizeTunnel(null), null);
  assert.strictEqual(contract.normalizeTunnel("junk"), null);
  assert.strictEqual(contract.normalizeTunnel({ name: "no endpoint" }), null);

  const tunnel = contract.normalizeTunnel({
    id: "t-1",
    name: "Primary",
    publicAddress: "axn.playit.gg:25565",
    localTarget: "127.0.0.1:30120",
    protocol: "TCP",
    region: "eu-west",
    is_disabled: true,
  });
  assert.strictEqual(tunnel.id, "t-1");
  assert.strictEqual(tunnel.name, "Primary");
  assert.strictEqual(tunnel.protocol, "tcp");
  assert.strictEqual(tunnel.publicHost, "axn.playit.gg");
  assert.strictEqual(tunnel.publicPort, 25565);
  assert.strictEqual(tunnel.localHost, "127.0.0.1");
  assert.strictEqual(tunnel.localPort, 30120);
  assert.strictEqual(tunnel.region, "eu-west");
  assert.strictEqual(tunnel.enabled, false);

  const alternateKeys = contract.normalizeTunnel({
    tunnelId: "t-2",
    tunnel_name: "Alt",
    domain: "alt.playit.gg",
    local_ip: "0.0.0.0",
    local_port: "30121",
    proto: "udp",
  });
  assert.strictEqual(alternateKeys.id, "t-2");
  assert.strictEqual(alternateKeys.name, "Alt");
  assert.strictEqual(alternateKeys.protocol, "udp");
  assert.strictEqual(alternateKeys.publicAddress, "alt.playit.gg");
  assert.strictEqual(alternateKeys.localHost, "0.0.0.0");
  assert.strictEqual(alternateKeys.localPort, 30121);
}

function testNormalizeProviderStateTolerance() {
  for (const malformed of [null, undefined, "playit", 42, [], [1, 2]]) {
    const state = contract.normalizeProviderState(malformed);
    assert.strictEqual(state.state, "unknown", `Malformed input ${JSON.stringify(malformed)} must map to unknown state.`);
    assert.strictEqual(state.availability, "unknown");
    assert.strictEqual(state.connected, null);
    assert.deepStrictEqual(state.tunnels, []);
    assert.deepStrictEqual(state.diagnostics, []);
  }
  assert.strictEqual(contract.normalizeProviderState({ state: "bogus" }).state, "unknown");
  assert.strictEqual(contract.normalizeProviderState({ availability: "bogus" }).availability, "unknown");
  assert.strictEqual(contract.normalizeProviderState({ state: "running" }).state, "running");
  assert.strictEqual(contract.normalizeProviderState({ availability: "available" }).availability, "available");
  assert.strictEqual(contract.normalizeProviderState({ connected: "yes" }).connected, null);

  const many = contract.normalizeProviderState({
    diagnostics: Array.from({ length: 12 }, (_, index) => ({ code: `D${index}`, message: `entry ${index}` })),
  });
  assert.strictEqual(many.diagnostics.length, 8, "Diagnostics must be capped at eight entries.");
  assert(
    many.diagnostics.every((entry) => typeof entry.code === "string" && typeof entry.message === "string"),
    "Diagnostic entries must only contain string code and message fields.",
  );

  assert.strictEqual(contract.isProviderStateHealthy("running"), true);
  assert.strictEqual(contract.isProviderStateHealthy("degraded"), false);
  assert.strictEqual(contract.isProviderStateHealthy("setup-required"), false);
  assert.strictEqual(contract.isProviderStateHealthy("unknown"), false);
}

function testSensitiveStripping() {
  const scrubbed = contract.normalizeProviderState({
    diagnostics: [{ code: "PLAYIT_X", message: "token=playit-secret" }],
  });
  assert.strictEqual(scrubbed.diagnostics[0].code, "PLAYIT_X");
  assert.strictEqual(scrubbed.diagnostics[0].message, "[redacted]");
  assert(
    !FORBIDDEN_SECRET_TEXT.test(JSON.stringify(scrubbed)),
    "A credential-looking diagnostic value must be scrubbed.",
  );

  const benign = contract.normalizeProviderState({
    diagnostics: [{ code: "PLAYIT_OK", message: "Playit is installed." }],
  });
  assert.strictEqual(benign.diagnostics[0].message, "Playit is installed.", "Benign diagnostics must survive.");

  // F5: free-text diagnostics go through the shared repo redactor, so a
  // Bearer/JWT credential shape survives neither as a token value nor as a JWT
  // body (the weaker local scrub used to pass this through untouched).
  const bearer = contract.normalizeProviderState({
    diagnostics: [{
      code: "PLAYIT_AUTH",
      message: "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
    }],
  });
  assert.strictEqual(bearer.diagnostics[0].code, "PLAYIT_AUTH");
  assert(
    !bearer.diagnostics[0].message.includes("eyJ"),
    `A Bearer JWT must not survive diagnostic scrubbing: ${bearer.diagnostics[0].message}`,
  );
  assert(
    !/Bearer\s+[A-Za-z0-9._~+/-]/.test(bearer.diagnostics[0].message),
    `A Bearer token value must not survive diagnostic scrubbing: ${bearer.diagnostics[0].message}`,
  );
  assert(
    bearer.diagnostics[0].message.includes("[redacted]"),
    `The redactor must leave an explicit redaction marker: ${bearer.diagnostics[0].message}`,
  );
}

// ---------------------------------------------------------------------------
// Adapter validation, both directions
// ---------------------------------------------------------------------------

function testAdaptersValidate() {
  const playitVerdict = contract.validateProviderAdapter(playit);
  assert.strictEqual(playitVerdict.ok, true, `Playit adapter must validate: ${JSON.stringify(playitVerdict.errors)}`);
  assert.deepStrictEqual(playitVerdict.errors, []);
  assert.deepStrictEqual(playitVerdict.missingRequired, []);

  const manualVerdict = contract.validateProviderAdapter(manual);
  assert.strictEqual(manualVerdict.ok, true, `Manual adapter must validate: ${JSON.stringify(manualVerdict.errors)}`);
  assert.deepStrictEqual(manualVerdict.errors, []);
  assert.deepStrictEqual(manualVerdict.missingRequired, []);

  const complete = {
    id: "test-provider",
    displayName: "Test Provider",
    capabilities: { ...allFalseCapabilities(), detect: true, status: true, listTunnels: true, endpointDiscovery: true },
    detect: () => ({}),
    status: () => ({}),
    listTunnels: () => [],
    endpointDiscovery: () => ({}),
  };
  const completeVerdict = contract.validateProviderAdapter(complete);
  assert.strictEqual(completeVerdict.ok, true, "A complete adapter definition must be accepted.");
  assert.deepStrictEqual(completeVerdict.missingRequired, []);
}

function testValidatorRefusals() {
  const complete = {
    id: "test-provider",
    displayName: "Test Provider",
    capabilities: { ...allFalseCapabilities(), detect: true, status: true, listTunnels: true, endpointDiscovery: true },
    detect: () => ({}),
    status: () => ({}),
    listTunnels: () => [],
    endpointDiscovery: () => ({}),
  };

  const missingId = contract.validateProviderAdapter({ displayName: "No Id", capabilities: allFalseCapabilities() });
  assert.strictEqual(missingId.ok, false);
  assert(missingId.errors.some((error) => error.code === "ADAPTER_ID_INVALID"));

  const uppercaseId = contract.validateProviderAdapter({ ...complete, id: "Playit" });
  assert.strictEqual(uppercaseId.ok, false);
  assert(uppercaseId.errors.some((error) => error.code === "ADAPTER_ID_INVALID"));

  const missingLabel = contract.validateProviderAdapter({ ...complete, displayName: "" });
  assert.strictEqual(missingLabel.ok, false);
  assert(missingLabel.errors.some((error) => error.code === "ADAPTER_LABEL_MISSING"));

  const noCapabilities = contract.validateProviderAdapter({ ...complete, capabilities: null });
  assert.strictEqual(noCapabilities.ok, false);
  assert(noCapabilities.errors.some((error) => error.code === "ADAPTER_CAPABILITIES_INVALID"));

  const nonBooleanCapability = contract.validateProviderAdapter({
    ...complete,
    capabilities: { ...allFalseCapabilities(), detect: "yes" },
  });
  assert.strictEqual(nonBooleanCapability.ok, false);
  assert(nonBooleanCapability.errors.some((error) => error.code === "ADAPTER_CAPABILITIES_INVALID" && error.capability === "detect"));

  const missingFunction = contract.validateProviderAdapter({
    ...complete,
    detect: undefined,
    endpointDiscovery: undefined,
    capabilities: { ...allFalseCapabilities(), detect: true, endpointDiscovery: true },
  });
  assert.strictEqual(missingFunction.ok, false);
  assert(missingFunction.errors.some((error) => error.code === "ADAPTER_FUNCTION_MISSING" && error.capability === "detect"));
  assert(missingFunction.errors.some((error) => error.code === "ADAPTER_FUNCTION_MISSING" && error.capability === "endpointDiscovery"));
  assert.deepStrictEqual([...missingFunction.missingRequired].sort(), ["detect", "endpointDiscovery"]);

  const unknownCapability = contract.validateProviderAdapter({
    ...complete,
    capabilities: { ...complete.capabilities, telepathy: true },
  });
  assert.strictEqual(unknownCapability.ok, false);
  assert(unknownCapability.errors.some((error) => error.code === "ADAPTER_CAPABILITY_UNKNOWN" && error.capability === "telepathy"));

  const badNormalizeState = contract.validateProviderAdapter({ ...complete, normalizeState: "nope" });
  assert.strictEqual(badNormalizeState.ok, false);
  assert(badNormalizeState.errors.some((error) => error.code === "ADAPTER_FUNCTION_MISSING" && error.capability === "normalizeState"));

  const nullAdapter = contract.validateProviderAdapter(null);
  assert.strictEqual(nullAdapter.ok, false);
  assert(nullAdapter.errors.some((error) => error.code === "ADAPTER_ID_INVALID"));
  assert(nullAdapter.errors.some((error) => error.code === "ADAPTER_LABEL_MISSING"));
  assert(nullAdapter.errors.some((error) => error.code === "ADAPTER_CAPABILITIES_INVALID"));
}

// ---------------------------------------------------------------------------
// Playit fixtures
// ---------------------------------------------------------------------------

const healthySnapshot = {
  installed: true,
  running: true,
  connected: true,
  tunnelAddress: "axn.playit.gg:25565",
  tunnelDomain: "axn.playit.gg",
  localTarget: "127.0.0.1:25565",
  localIp: "127.0.0.1",
  localPort: 25565,
  protocol: "tcp",
  tunnelId: "tid-1",
  version: "0.15.0",
  region: "us-west",
  lastCheckedAt: "2026-09-28T00:00:00.000Z",
  diagnostics: { binaryPath: "playit.exe", errorCode: null },
  tunnels: [],
};

function testPlayitHealthy() {
  const state = playit.detect(healthySnapshot);
  assert.strictEqual(state.providerId, "playit");
  assert.strictEqual(state.displayName, "Playit.gg");
  assert.strictEqual(state.state, "running");
  assert.strictEqual(state.availability, "available");
  assert.strictEqual(state.connected, true);
  assert.strictEqual(state.publicAddress, "axn.playit.gg:25565");
  assert.strictEqual(state.localTarget, "127.0.0.1:25565");
  assert.strictEqual(state.version, "0.15.0");
  assert.strictEqual(state.region, "us-west");
  assert.strictEqual(state.lastCheckedAt, "2026-09-28T00:00:00.000Z");
  assert.strictEqual(contract.isProviderStateHealthy(state.state), true);
  assert.deepStrictEqual(playit.detect(healthySnapshot), playit.status(healthySnapshot), "detect and status must agree.");

  const preferred = playit.detect({ ...healthySnapshot, publicAddress: "custom.playit.gg:3000" });
  assert.strictEqual(preferred.publicAddress, "custom.playit.gg:3000", "publicAddress must win over tunnelAddress.");

  const noPublicAddress = playit.detect({ ...healthySnapshot, publicAddress: undefined });
  assert.strictEqual(noPublicAddress.publicAddress, "axn.playit.gg:25565", "tunnelAddress is the next publicAddress source.");
}

function testPlayitNotInstalled() {
  const state = playit.detect({ installed: false, running: false, connected: false });
  assert.strictEqual(state.state, "not-installed");
  assert.strictEqual(state.availability, "unavailable");
  assert.strictEqual(state.connected, false);
}

function testPlayitDegraded() {
  const state = playit.status({ installed: true, running: true, connected: false });
  assert.strictEqual(state.state, "degraded");
  assert.strictEqual(state.availability, "available");
  assert.strictEqual(state.connected, false);
}

function testPlayitStopped() {
  const state = playit.detect({ installed: true, running: false, connected: false });
  assert.strictEqual(state.state, "stopped");
  assert.strictEqual(state.availability, "available");
}

function testPlayitAuthRequired() {
  const state = playit.detect({
    installed: true,
    running: false,
    connected: false,
    diagnostics: { reason: "auth-required", message: "not logged in" },
  });
  assert.strictEqual(state.state, "auth-required");
  assert.strictEqual(state.availability, "available");
  assert(state.diagnostics.some((entry) => entry.code === "PLAYIT_AUTH_REQUIRED"));

  const notInvented = playit.detect({ installed: true, running: false, connected: false });
  assert.strictEqual(notInvented.state, "stopped", "Without evidence, auth-required must never be invented.");

  const liveTunnelWins = playit.detect({ ...healthySnapshot, diagnostics: { message: "please log in" }, tunnels: [] });
  assert.strictEqual(liveTunnelWins.state, "running", "A running connected tunnel must not be overridden by a stale auth note.");
}

function testPlayitMalformedInput() {
  for (const malformed of [null, undefined, "playit", 42, [], [1, 2]]) {
    const state = playit.detect(malformed);
    assert.strictEqual(state.state, "unknown", `Malformed input ${JSON.stringify(malformed)} must map to unknown state.`);
    assert.strictEqual(state.availability, "unknown");
    assert.strictEqual(state.connected, null);
    assert.deepStrictEqual(state.tunnels, []);
    assert.deepStrictEqual(playit.listTunnels(malformed), []);
  }
}

function testPlayitTunnelList() {
  const mixedSnapshot = {
    installed: true,
    running: true,
    connected: true,
    tunnels: [
      { id: "t-1", publicAddress: "one.playit.gg:25565" },
      null,
      "junk",
      7,
      { localTarget: "127.0.0.1:30120", protocol: "UDP" },
      { name: "no endpoint" },
    ],
  };

  const tunnels = playit.listTunnels(mixedSnapshot);
  assert.strictEqual(tunnels.length, 2, "Only repairable tunnel entries may be mapped.");
  assert.strictEqual(tunnels[0].id, "t-1");
  assert.strictEqual(tunnels[0].publicHost, "one.playit.gg");
  assert.strictEqual(tunnels[1].localHost, "127.0.0.1");
  assert.strictEqual(tunnels[1].localPort, 30120);
  assert.strictEqual(tunnels[1].protocol, "udp");

  const state = playit.detect(mixedSnapshot);
  assert.strictEqual(state.tunnels.length, 2);
  assert(
    state.diagnostics.some((entry) => entry.code === "PLAYIT_TUNNEL_SKIPPED" && entry.message === "4 tunnel entries skipped"),
    `The skipped tunnel count must be surfaced: ${JSON.stringify(state.diagnostics)}`,
  );
}

function testPlayitLocalTargetParsing() {
  const tunnel = contract.normalizeTunnel({ id: "t-local", localTarget: "127.0.0.1:30120" });
  assert.strictEqual(tunnel.localHost, "127.0.0.1");
  assert.strictEqual(tunnel.localPort, 30120);

  const state = playit.detect({ installed: true, running: true, connected: true, localTarget: "127.0.0.1:30120" });
  assert.strictEqual(state.localTarget, "127.0.0.1:30120");
  assert.deepStrictEqual(playit.listTunnels({ tunnels: [{ id: "t-local", localTarget: "127.0.0.1:30120" }] })[0].localPort, 30120);
}

function testPlayitSecretStripping() {
  const pollutedTunnel = {
    id: "t-1",
    publicAddress: "one.playit.gg:25565",
    localTarget: "127.0.0.1:25565",
    token: "playit-secret",
    apiKey: "abc",
    auth: { password: "x" },
    nested: { refreshToken: "t" },
  };
  const pollutedSnapshot = {
    installed: true,
    running: true,
    connected: true,
    publicAddress: "one.playit.gg:25565",
    localTarget: "127.0.0.1:25565",
    token: "playit-secret",
    apiKey: "abc",
    auth: { password: "x" },
    nested: { refreshToken: "t" },
    tunnels: [pollutedTunnel],
  };

  const outputs = [
    playit.detect(pollutedSnapshot),
    playit.status(pollutedSnapshot),
    playit.listTunnels(pollutedSnapshot),
    playit.endpointFromTunnel(pollutedTunnel),
  ];
  for (const output of outputs) {
    const json = JSON.stringify(output);
    assert(!FORBIDDEN_SECRET_TEXT.test(json), `Sensitive material survived into adapter output: ${json}`);
  }
  assert.strictEqual(playit.detect(pollutedSnapshot).publicAddress, "one.playit.gg:25565", "Clean fields must survive stripping.");
  assert.strictEqual(playit.detect(pollutedSnapshot).tunnels[0].id, "t-1", "Clean tunnel fields must survive stripping.");
}

function testPlayitIpv6Tunnel() {
  const parsed = contract.parseHostPort("[2001:db8::1]:25565");
  assert.deepStrictEqual(parsed, { host: "2001:db8::1", port: 25565 });

  const tunnel = contract.normalizeTunnel({ id: "t-v6", publicAddress: "[2001:db8::1]:25565" });
  assert.strictEqual(tunnel.publicHost, "2001:db8::1");
  assert.strictEqual(tunnel.publicPort, 25565);

  const state = playit.detect({
    installed: true,
    running: true,
    connected: true,
    tunnels: [{ id: "t-v6", publicAddress: "[2001:db8::1]:25565" }],
  });
  assert.strictEqual(state.tunnels[0].publicHost, "2001:db8::1");
  assert.strictEqual(state.tunnels[0].publicPort, 25565);
}

function testEndpointFromTunnel() {
  const tunnel = contract.normalizeTunnel({
    id: "t-9",
    name: "Minecraft",
    publicAddress: "axn.playit.gg:25565",
    localTarget: "127.0.0.1:30120",
    protocol: "tcp",
    region: "us-west",
    enabled: true,
  });
  const endpoint = playit.endpointFromTunnel(tunnel, { computerId: "c-1", serviceId: "s-1" });
  const repeated = playit.endpointFromTunnel(tunnel, { computerId: "c-1", serviceId: "s-1" });
  assert.deepStrictEqual(endpoint, repeated, "endpointFromTunnel must be deterministic.");

  assert.strictEqual(endpoint.name, "Minecraft");
  assert.strictEqual(endpoint.type, "public");
  assert.strictEqual(endpoint.host, "axn.playit.gg");
  assert.strictEqual(endpoint.port, 25565);
  assert.strictEqual(endpoint.protocol, "tcp");
  assert.strictEqual(endpoint.enabled, true);
  assert.strictEqual(endpoint.providerId, "playit");
  assert.strictEqual(endpoint.source, "provider");
  assert.strictEqual(endpoint.notes, "");
  assert.strictEqual(endpoint.serviceId, "s-1");
  assert.strictEqual(endpoint.computerId, "c-1");

  assert.deepStrictEqual(
    Object.keys(endpoint.metadata).sort(),
    ["addressSource", "region", "tunnelId", "tunnelName"],
    "endpoint metadata must use exactly the documented key set.",
  );
  assert.strictEqual(endpoint.metadata.tunnelId, "t-9");
  assert.strictEqual(endpoint.metadata.tunnelName, "Minecraft");
  assert.strictEqual(endpoint.metadata.region, "us-west");
  assert.strictEqual(endpoint.metadata.addressSource, "provider");
  assert.deepStrictEqual(
    Object.keys(endpoint).sort(),
    ["computerId", "enabled", "host", "metadata", "name", "notes", "port", "protocol", "providerId", "serviceId", "source", "type"].sort(),
    "endpointFromTunnel must not add fields beyond the endpoint model.",
  );

  const localOnly = playit.endpointFromTunnel(contract.normalizeTunnel({
    id: "t-10",
    publicAddress: "axn.playit.gg",
    localPort: 30120,
  }));
  assert.strictEqual(localOnly.host, "axn.playit.gg");
  assert.strictEqual(localOnly.port, 30120, "Without a public port the known local port is used, never an invented public port.");
  assert.strictEqual(localOnly.metadata.tunnelId, "t-10");

  const nameFallback = playit.endpointFromTunnel({ publicAddress: "two.playit.gg:25565" });
  assert.strictEqual(nameFallback.name, "Playit two.playit.gg");
}

function testPlayitCapabilityDrift() {
  assert.deepStrictEqual(
    playit.capabilities,
    playitModule.PLAYIT_PROVIDER_CAPABILITIES,
    "The created adapter's capabilities must equal the frozen drift table.",
  );
  assert.strictEqual(playit.capabilities.createTunnel, false, "AnxOS does not create provider tunnels today.");
  assert.strictEqual(playit.capabilities.deleteTunnel, false, "AnxOS does not delete provider tunnels today.");
  assert(Object.isFrozen(playitModule.PLAYIT_PROVIDER_CAPABILITIES), "The drift table must be frozen.");
}

// ---------------------------------------------------------------------------
// Manual / Port Forwarding fixtures
// ---------------------------------------------------------------------------

function testManualAdapter() {
  const withEndpoints = manual.status({ hasManualEndpoints: true });
  assert.strictEqual(withEndpoints.providerId, "manual");
  assert.strictEqual(withEndpoints.displayName, "Manual / Port Forwarding");
  assert.strictEqual(withEndpoints.state, "setup-required");
  assert.strictEqual(withEndpoints.availability, "available");
  assert.strictEqual(withEndpoints.connected, null);
  assert.strictEqual(contract.isProviderStateHealthy(withEndpoints.state), false, "Provider health is not endpoint reachability.");
  assert(
    withEndpoints.diagnostics.some((entry) => entry.code === "MANUAL_PROVIDER_ADVISORY"),
    "The manual advisory diagnostic must always be present.",
  );

  const withoutEndpoints = manual.status({});
  assert.strictEqual(withoutEndpoints.state, "setup-required");
  assert.strictEqual(withoutEndpoints.availability, "unknown");

  const noContext = manual.status();
  assert.strictEqual(noContext.state, "setup-required");
  assert.strictEqual(noContext.availability, "unknown");

  assert.deepStrictEqual(manual.listTunnels(), [], "The manual provider lists no tunnels.");
  assert.deepStrictEqual(
    manual.capabilities,
    manualModule.MANUAL_PROVIDER_CAPABILITIES,
    "The manual adapter's capabilities must equal its frozen drift table.",
  );
}

// ---------------------------------------------------------------------------

// PR #9 review M1: Agent text is bounded before redaction (no main-process
// stall), and every cut lands on a word boundary (no partial credential).
function testBoundedScrubbing() {
  const timed = (label, fn, budgetMs = 2500) => {
    const started = Date.now();
    const value = fn();
    const elapsed = Date.now() - started;
    assert(elapsed < budgetMs, `${label}: took ${elapsed} ms (budget ${budgetMs} ms)`);
    return value;
  };
  // Space-separated so bounding keeps text and the redactor really runs
  // (delimiter-free text is dropped whole by the boundary cut).
  const big = "x ".repeat(50000); // 100 KB
  const many = timed("500 x 100 KB diagnostics", () => contract.normalizeProviderState({ providerId: "playit", state: "degraded", diagnostics: Array(500).fill(big) }));
  assert(many.diagnostics.length > 0 && many.diagnostics.every((d) => d.message.length <= 500));
  // One value with a 50 KB unbroken token: only the per-string input bound
  // keeps the redactor from running on it (it is super-linear in token length).
  const longToken = ("x-".repeat(25000) + " ").repeat(2);
  timed("single value with a 50 KB token", () => contract.normalizeProviderState({ providerId: "playit", state: "degraded", publicAddress: longToken, diagnostics: [longToken] }));
  timed("100 KB structured field", () => contract.normalizeProviderState({ providerId: "playit", state: "running", publicAddress: big, region: big }));
  // distinct arrays: repeated references are skipped by the cycle guard
  // Worst case for the redactor: a long unbroken token that survives the
  // boundary cut (a delimiter follows it), ~4 ms each without a budget.
  const hostileToken = ("x-".repeat(1100) + " ").repeat(2);
  timed("200 x 200 nested strings", () => contract.normalizeProviderState({ providerId: "playit", state: "running", extra: Array.from({ length: 200 }, () => Array.from({ length: 200 }, () => hostileToken)) }));
  const wide = {};
  for (let i = 0; i < 20000; i += 1) wide[`k${i}`] = "z ".repeat(1000);
  timed("20,000-key object", () => contract.normalizeProviderState({ providerId: "playit", state: "running", extra: wide }));
  timed("hostile tunnels", () => contract.normalizeProviderState({ providerId: "playit", state: "running", tunnels: Array(500).fill({ id: big, name: big, publicAddress: big }) }));

  // A JWT straddling the input bound must not leave a fragment behind.
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
  for (let pad = 2180; pad <= 2260; pad += 7) {
    const text = "a".repeat(pad) + " Authorization: Bearer " + jwt + " tail";
    const out = contract.scrubDiagnosticText(text);
    assert(!out.includes("eyJhbGci") && !out.includes("SflKxw"), `no JWT fragment at pad ${pad}`);
  }
  // A bare credential straddling the output bound is dropped, not cut short.
  // synthetic, deliberately not shaped like any real provider key format
  const credential = "zq_demo_51HxYz0123456789abcdefSECRET";
  // the credential starts just before the 2000-character output cut
  for (let words = 393; words <= 400; words += 1) {
    const text = "word ".repeat(words) + credential + " more text";
    const out = contract.scrubDiagnosticText(text);
    assert(!out.includes("zq_demo") && !out.includes("51HxYz"), `no credential fragment at ${words} words`);
    assert(out.length <= 2000);
  }
  // An assignment past the bound still redacts the whole value.
  assert.strictEqual(contract.scrubDiagnosticText("x ".repeat(5000) + "password=hunter2pass"), "[redacted]");
  // Short text is unchanged by the bound.
  assert.strictEqual(contract.scrubDiagnosticText("agent restarted cleanly"), "agent restarted cleanly");
}

function main() {
  console.log(
    `provider-adapter-contract: v${contract.CONTRACT_VERSION}, `
      + `${contract.PROVIDER_CAPABILITY_IDS.length} capabilities, ${contract.PROVIDER_STATES.length} states`,
  );
  console.log(`  playit capabilities: ${Object.entries(playitModule.PLAYIT_PROVIDER_CAPABILITIES)
    .map(([id, value]) => `${id}=${value ? "YES" : "NO"}`)
    .join(" ")}`);

  const tests = [
    ["vocabulary", testVocabulary],
    ["parseHostPort", testParseHostPort],
    ["normalizeTunnel", testNormalizeTunnel],
    ["normalizeProviderState tolerance", testNormalizeProviderStateTolerance],
    ["sensitive stripping", testSensitiveStripping],
    ["adapter validation", testAdaptersValidate],
    ["validator refusals", testValidatorRefusals],
    ["playit healthy fixture", testPlayitHealthy],
    ["playit not-installed fixture", testPlayitNotInstalled],
    ["playit degraded fixture", testPlayitDegraded],
    ["playit stopped fixture", testPlayitStopped],
    ["playit auth-required fixture", testPlayitAuthRequired],
    ["playit malformed inputs", testPlayitMalformedInput],
    ["playit tunnel list", testPlayitTunnelList],
    ["playit localTarget parsing", testPlayitLocalTargetParsing],
    ["playit secret stripping", testPlayitSecretStripping],
    ["playit IPv6 tunnel", testPlayitIpv6Tunnel],
    ["endpointFromTunnel", testEndpointFromTunnel],
    ["playit capability drift", testPlayitCapabilityDrift],
    ["manual adapter", testManualAdapter],
    ["bounded scrubbing (PR #9 M1)", testBoundedScrubbing],
  ];

  const results = [];
  for (const [name, test] of tests) {
    try {
      test();
      results.push({ name, status: "PASS" });
    } catch (error) {
      results.push({ name, status: "FAIL" });
      console.error(`FAIL ${name}: ${error && error.message ? error.message : error}`);
      throw error;
    }
  }

  for (const result of results) console.log(`  [${result.status}] ${result.name}`);
  console.log("provider-adapter-contract smoke passed");
}

main();
