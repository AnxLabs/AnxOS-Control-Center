"use strict";

// Smoke test for the shared endpoint model. Run from the repository root:
//   node scripts/endpoint-model-smoke.js

const assert = require("node:assert");

const {
  ENDPOINT_TYPES,
  ENDPOINT_PROTOCOLS,
  ENDPOINT_SOURCES,
  ENDPOINT_TYPE_LABELS,
  MAX_ENDPOINT_NAME_LENGTH,
  MAX_HOST_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_METADATA_KEYS,
  MAX_METADATA_VALUE_LENGTH,
  validateEndpointInput,
  buildEndpointId,
  endpointKey,
  formatEndpointAddress,
  normalizeEndpointRecord,
  describeEndpointType,
  sortEndpoints,
  publicEndpointView,
  isLoopbackHost,
  isPrivateHost,
} = require("../src/shared/endpointModel");

let checks = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    checks += 1;
  } catch (error) {
    failures.push(`${name}: ${error && error.message ? error.message : String(error)}`);
  }
}

function expectOk(result) {
  assert.strictEqual(result.ok, true, `expected ok=true, got errors: ${JSON.stringify(result.errors)}`);
  return result.value;
}

function expectErrors(result, codes) {
  assert.strictEqual(result.ok, false, `expected ok=false, got value: ${JSON.stringify(result.value)}`);
  assert.ok(Array.isArray(result.errors));
  assert.deepStrictEqual(result.errors.map((error) => error.code).sort(), [...codes].sort());
  for (const error of result.errors) {
    assert.strictEqual(typeof error.field, "string");
    assert.strictEqual(typeof error.message, "string");
    assert.ok(error.message.length > 0);
  }
}

function baseInput(overrides) {
  const input = {
    name: "Anxlab FXServer",
    type: "lan",
    host: "192.168.1.50",
    port: 30120,
    protocol: "tcp",
    providerId: "local-vm",
    serviceId: "fivem-anxlab",
    computerId: "comp-01",
    source: "manual",
    notes: "Primary test server",
    metadata: { region: "home", slots: 32, verified: true, note: null },
  };
  return Object.assign(input, overrides);
}

test("exported constants and bounds", () => {
  assert.ok(Object.isFrozen(ENDPOINT_TYPES));
  assert.ok(Object.isFrozen(ENDPOINT_PROTOCOLS));
  assert.ok(Object.isFrozen(ENDPOINT_SOURCES));
  assert.deepStrictEqual([...ENDPOINT_TYPES], ["lan", "private", "tailscale", "public", "custom"]);
  assert.deepStrictEqual([...ENDPOINT_PROTOCOLS], ["tcp", "udp", "http", "https"]);
  assert.deepStrictEqual([...ENDPOINT_SOURCES], ["discovered", "manual", "provider"]);
  assert.deepStrictEqual(
    { ...ENDPOINT_TYPE_LABELS },
    { lan: "LAN", private: "Private", tailscale: "Tailscale", public: "Public", custom: "Custom" }
  );
  assert.strictEqual(MAX_ENDPOINT_NAME_LENGTH, 120);
  assert.strictEqual(MAX_HOST_LENGTH, 253);
  assert.strictEqual(MAX_NOTES_LENGTH, 500);
  assert.strictEqual(MAX_METADATA_KEYS, 24);
  assert.strictEqual(MAX_METADATA_VALUE_LENGTH, 300);
});

test("valid IPv4 input produces canonical value without id or timestamps", () => {
  const value = expectOk(validateEndpointInput(baseInput()));
  assert.deepStrictEqual(
    Object.keys(value).sort(),
    [
      "computerId",
      "enabled",
      "host",
      "metadata",
      "name",
      "notes",
      "port",
      "protocol",
      "providerId",
      "serviceId",
      "source",
      "type",
    ].sort()
  );
  assert.strictEqual(value.name, "Anxlab FXServer");
  assert.strictEqual(value.type, "lan");
  assert.strictEqual(value.host, "192.168.1.50");
  assert.strictEqual(value.port, 30120);
  assert.strictEqual(value.protocol, "tcp");
  assert.strictEqual(value.enabled, true);
  assert.strictEqual(value.providerId, "local-vm");
  assert.strictEqual(value.serviceId, "fivem-anxlab");
  assert.strictEqual(value.computerId, "comp-01");
  assert.strictEqual(value.source, "manual");
  assert.strictEqual(value.notes, "Primary test server");
  assert.deepStrictEqual(value.metadata, { region: "home", slots: 32, verified: true, note: null });
  assert.strictEqual(value.id, undefined);
  assert.strictEqual(value.createdAt, undefined);
});

test("valid hostname input is trimmed, lowercased, trailing dot stripped", () => {
  const value = expectOk(validateEndpointInput({ name: "Tailnet box", type: "tailscale", host: "  My-Box.Example.COM.  " }));
  assert.strictEqual(value.host, "my-box.example.com");
  assert.strictEqual(value.port, null);
  assert.strictEqual(value.protocol, null);
  assert.strictEqual(value.providerId, null);
  assert.strictEqual(value.serviceId, null);
  assert.strictEqual(value.computerId, null);
  assert.strictEqual(value.source, "manual");
  assert.strictEqual(value.enabled, true);
  assert.strictEqual(value.notes, "");
  assert.deepStrictEqual(value.metadata, {});
});

test("valid bracketed IPv6 and raw IPv6 hosts", () => {
  const bracketed = expectOk(validateEndpointInput({ name: "V6 bracketed", type: "private", host: "[2001:DB8::1]", port: "30120" }));
  assert.strictEqual(bracketed.host, "2001:DB8::1");
  assert.strictEqual(bracketed.port, 30120);
  const raw = expectOk(validateEndpointInput({ name: "V6 raw", type: "private", host: "::1" }));
  assert.strictEqual(raw.host, "::1");
  assert.strictEqual(raw.port, null);
});

test("host rejection table", () => {
  const rejected = [
    "127.0.0.1; rm -rf /",
    "$(id)",
    "`id`",
    "host/../etc",
    "host with space",
    "-bad",
    'quote"host',
    "semi;host",
    "amp&host",
    "pipe|host",
    "lt<host",
    "gt>host",
    "par(en)",
    "brace{host}",
    "bracket[host]",
    "ban]ket",
    "dollar$host",
    "bang!host",
    "star*host",
    "quest?host",
    "tilde~host",
    "caret^host",
    "equals=host",
    "comma,host",
    "back\\slash",
    "ho\tst",
    "new\nline",
    "carriage\rreturn",
    "trailing\\",
    "leading\\",
    ".leading.dot",
    "double..dot",
  ];
  for (const host of rejected) {
    const result = validateEndpointInput(baseInput({ host }));
    assert.strictEqual(result.ok, false, `expected rejection for host ${JSON.stringify(host)}`);
    assert.deepStrictEqual(result.errors.map((error) => error.code), ["ENDPOINT_HOST_INVALID"], `unexpected codes for host ${JSON.stringify(host)}`);
  }
});

test("port coercion and bounds", () => {
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ port: "30120" }))).port, 30120);
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ port: 1 }))).port, 1);
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ port: 65535 }))).port, 65535);
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ port: undefined }))).port, null);
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ port: null }))).port, null);
  for (const port of [0, 65536, 3.5, -1, "0", "65536", "3.5", "abc", "", true, NaN, Infinity]) {
    expectErrors(validateEndpointInput(baseInput({ port })), ["ENDPOINT_PORT_INVALID"]);
  }
});

test("enum validation", () => {
  expectErrors(validateEndpointInput(baseInput({ type: "wan" })), ["ENDPOINT_TYPE_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ type: "" })), ["ENDPOINT_TYPE_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ type: 42 })), ["ENDPOINT_TYPE_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ source: "cloud" })), ["ENDPOINT_SOURCE_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ protocol: "smtp" })), ["ENDPOINT_PROTOCOL_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ protocol: "TCP" })), ["ENDPOINT_PROTOCOL_INVALID"]);
  for (const type of ENDPOINT_TYPES) {
    assert.strictEqual(expectOk(validateEndpointInput(baseInput({ type }))).type, type);
  }
  for (const protocol of ENDPOINT_PROTOCOLS) {
    assert.strictEqual(expectOk(validateEndpointInput(baseInput({ protocol }))).protocol, protocol);
  }
  for (const source of ENDPOINT_SOURCES) {
    assert.strictEqual(expectOk(validateEndpointInput(baseInput({ source }))).source, source);
  }
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ source: undefined }))).source, "manual");
});

test("name validation", () => {
  expectErrors(validateEndpointInput(baseInput({ name: "" })), ["ENDPOINT_NAME_REQUIRED"]);
  expectErrors(validateEndpointInput(baseInput({ name: "   " })), ["ENDPOINT_NAME_REQUIRED"]);
  expectErrors(validateEndpointInput(baseInput({ name: undefined })), ["ENDPOINT_NAME_REQUIRED"]);
  expectErrors(validateEndpointInput(baseInput({ name: 42 })), ["ENDPOINT_NAME_REQUIRED"]);
  expectErrors(validateEndpointInput(baseInput({ name: "x".repeat(MAX_ENDPOINT_NAME_LENGTH + 1) })), ["ENDPOINT_NAME_TOO_LONG"]);
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ name: "  Anx  " }))).name, "Anx");
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ name: "x".repeat(MAX_ENDPOINT_NAME_LENGTH) }))).name.length, MAX_ENDPOINT_NAME_LENGTH);
});

test("provider/service/computer identifier validation", () => {
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ providerId: "local-vm" }))).providerId, "local-vm");
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ providerId: undefined }))).providerId, null);
  expectErrors(validateEndpointInput(baseInput({ providerId: "" })), ["ENDPOINT_PROVIDER_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ providerId: "Local VM" })), ["ENDPOINT_PROVIDER_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ providerId: "-bad" })), ["ENDPOINT_PROVIDER_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ providerId: "a".repeat(65) })), ["ENDPOINT_PROVIDER_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ providerId: 42 })), ["ENDPOINT_PROVIDER_INVALID"]);
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ serviceId: "svc.1_a-b" }))).serviceId, "svc.1_a-b");
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ serviceId: "x".repeat(120) }))).serviceId.length, 120);
  expectErrors(validateEndpointInput(baseInput({ serviceId: "x".repeat(121) })), ["ENDPOINT_SERVICE_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ serviceId: "bad id" })), ["ENDPOINT_SERVICE_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ computerId: "bad id" })), ["ENDPOINT_COMPUTER_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ computerId: "x".repeat(121) })), ["ENDPOINT_COMPUTER_INVALID"]);
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ computerId: null }))).computerId, null);
});

test("notes bound and default", () => {
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ notes: "x".repeat(MAX_NOTES_LENGTH) }))).notes.length, MAX_NOTES_LENGTH);
  expectErrors(validateEndpointInput(baseInput({ notes: "x".repeat(MAX_NOTES_LENGTH + 1) })), ["ENDPOINT_NOTES_TOO_LONG"]);
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ notes: undefined }))).notes, "");
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ notes: null }))).notes, "");
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ notes: 42 }))).notes, "42");
});

test("enabled flag validation", () => {
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ enabled: false }))).enabled, false);
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ enabled: undefined }))).enabled, true);
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ enabled: null }))).enabled, true);
  expectErrors(validateEndpointInput(baseInput({ enabled: "yes" })), ["ENDPOINT_ENABLED_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ enabled: 1 })), ["ENDPOINT_ENABLED_INVALID"]);
});

test("metadata bounds and shapes", () => {
  const many = {};
  for (let index = 0; index < MAX_METADATA_KEYS; index += 1) many[`key${index}`] = index;
  assert.strictEqual(Object.keys(expectOk(validateEndpointInput(baseInput({ metadata: many }))).metadata).length, MAX_METADATA_KEYS);
  expectErrors(validateEndpointInput(baseInput({ metadata: Object.assign({}, many, { overflow: true }) })), ["ENDPOINT_METADATA_INVALID"]);
  assert.strictEqual(
    expectOk(validateEndpointInput(baseInput({ metadata: { value: "x".repeat(MAX_METADATA_VALUE_LENGTH) } }))).metadata.value.length,
    MAX_METADATA_VALUE_LENGTH
  );
  expectErrors(validateEndpointInput(baseInput({ metadata: { value: "x".repeat(MAX_METADATA_VALUE_LENGTH + 1) } })), ["ENDPOINT_METADATA_INVALID"]);
  assert.deepStrictEqual(expectOk(validateEndpointInput(baseInput({ metadata: undefined }))).metadata, {});
  assert.deepStrictEqual(expectOk(validateEndpointInput(baseInput({ metadata: null }))).metadata, {});
  expectErrors(validateEndpointInput(baseInput({ metadata: { nested: { a: 1 } } })), ["ENDPOINT_METADATA_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ metadata: { list: [1, 2, 3] } })), ["ENDPOINT_METADATA_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ metadata: { missing: undefined } })), ["ENDPOINT_METADATA_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ metadata: { fn: () => undefined } })), ["ENDPOINT_METADATA_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ metadata: { infinite: Infinity } })), ["ENDPOINT_METADATA_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ metadata: [["a"]] })), ["ENDPOINT_METADATA_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ metadata: "nope" })), ["ENDPOINT_METADATA_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ metadata: new Date() })), ["ENDPOINT_METADATA_INVALID"]);
  const okTypes = expectOk(validateEndpointInput(baseInput({ metadata: { a: "s", b: 1, c: true, d: null } })));
  assert.deepStrictEqual(okTypes.metadata, { a: "s", b: 1, c: true, d: null });
  const protoKey = JSON.parse('{"__proto__":"safe"}');
  const protoChecked = expectOk(validateEndpointInput(baseInput({ metadata: protoKey })));
  assert.deepStrictEqual(protoChecked.metadata, protoKey);
  assert.strictEqual(Object.getPrototypeOf(protoChecked.metadata), Object.prototype);
});

test("collects multiple errors with fields", () => {
  const result = validateEndpointInput({ name: "", type: "bogus", host: "bad host", port: 0, source: "cloud" });
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(
    result.errors.map((error) => error.code).sort(),
    ["ENDPOINT_HOST_INVALID", "ENDPOINT_NAME_REQUIRED", "ENDPOINT_PORT_INVALID", "ENDPOINT_SOURCE_INVALID", "ENDPOINT_TYPE_INVALID"].sort()
  );
  assert.deepStrictEqual(result.errors.map((error) => error.field).sort(), ["host", "name", "port", "source", "type"].sort());
});

test("non-object input yields errors instead of throwing", () => {
  for (const input of [null, undefined, "nope", 42, []]) {
    const result = validateEndpointInput(input);
    assert.strictEqual(result.ok, false);
    assert.ok(result.errors.length >= 3);
  }
});

test("existing option is accepted and does not change the result", () => {
  const input = baseInput();
  assert.deepStrictEqual(validateEndpointInput(input, { existing: { name: "Old" } }), validateEndpointInput(input));
  assert.deepStrictEqual(validateEndpointInput(input, {}), validateEndpointInput(input));
});

test("buildEndpointId determinism and sensitivity", () => {
  const parts = {
    computerId: "comp-01",
    type: "lan",
    host: "192.168.1.50",
    port: 30120,
    protocol: "tcp",
    serviceId: "fivem-anxlab",
    name: "Anxlab FXServer",
  };
  const first = buildEndpointId(parts);
  assert.strictEqual(first, buildEndpointId(Object.assign({}, parts)));
  assert.match(first, /^ep-[0-9a-f]{16}$/);
  assert.notStrictEqual(first, buildEndpointId(Object.assign({}, parts, { name: "Other name" })));
  assert.notStrictEqual(first, buildEndpointId(Object.assign({}, parts, { serviceId: "fivem-other" })));
  assert.match(buildEndpointId({}), /^ep-[0-9a-f]{16}$/);
  const withUndefined = buildEndpointId({ computerId: undefined, type: "lan", host: "10.0.0.1", port: null, protocol: undefined, serviceId: null, name: undefined });
  const withEmpty = buildEndpointId({ computerId: "", type: "lan", host: "10.0.0.1", port: null, protocol: "", serviceId: null, name: "" });
  assert.strictEqual(withUndefined, withEmpty);
});

test("endpointKey dedupes name-insensitive identity", () => {
  const base = { computerId: "comp-01", type: "lan", host: "192.168.1.50", port: 30120, protocol: "tcp", serviceId: "fivem-anxlab" };
  assert.strictEqual(endpointKey(base), "comp-01|lan|192.168.1.50|30120|tcp|fivem-anxlab");
  assert.strictEqual(endpointKey(Object.assign({}, base, { name: "Renamed" })), endpointKey(base));
  assert.notStrictEqual(endpointKey(Object.assign({}, base, { serviceId: "fivem-other" })), endpointKey(base));
  assert.notStrictEqual(endpointKey(Object.assign({}, base, { port: null })), endpointKey(base));
  assert.strictEqual(endpointKey({}), "|||||");
  assert.strictEqual(endpointKey(null), "|||||");
});

test("formatEndpointAddress", () => {
  assert.strictEqual(formatEndpointAddress({ host: "192.168.1.50", port: 30120 }), "192.168.1.50:30120");
  assert.strictEqual(formatEndpointAddress({ host: "192.168.1.50" }), "192.168.1.50");
  assert.strictEqual(formatEndpointAddress({ host: "192.168.1.50", port: null }), "192.168.1.50");
  assert.strictEqual(formatEndpointAddress({ host: "::1", port: 30120 }), "[::1]:30120");
  assert.strictEqual(formatEndpointAddress({ host: "[::1]", port: 30120 }), "[::1]:30120");
  assert.strictEqual(formatEndpointAddress({ host: "2001:db8::1" }), "2001:db8::1");
  assert.strictEqual(formatEndpointAddress({ host: "example.com", port: 8080 }), "example.com:8080");
  assert.strictEqual(formatEndpointAddress(null), "");
});

test("normalizeEndpointRecord tolerance", () => {
  assert.strictEqual(normalizeEndpointRecord(null), null);
  assert.strictEqual(normalizeEndpointRecord(undefined), null);
  assert.strictEqual(normalizeEndpointRecord("nope"), null);
  assert.strictEqual(normalizeEndpointRecord([]), null);
  assert.strictEqual(normalizeEndpointRecord({ name: "No host" }), null);
  assert.strictEqual(normalizeEndpointRecord({ host: 42 }), null);
  assert.doesNotThrow(() => normalizeEndpointRecord({ host: "ok.example" }));

  const record = normalizeEndpointRecord({
    id: "ep-custom-id",
    name: "  Big   Name  ",
    type: "nonsense",
    host: "Example.COM.",
    port: "30120",
    protocol: "bogus",
    providerId: "BAD_PROVIDER",
    serviceId: { nested: true },
    computerId: 12345,
    source: "unknown",
    notes: "n".repeat(MAX_NOTES_LENGTH + 50),
    enabled: "yes",
    metadata: {
      good: "value",
      nested: { a: 1 },
      list: [1, 2],
      count: 5,
      infinite: Infinity,
      big: "b".repeat(MAX_METADATA_VALUE_LENGTH + 20),
      flag: false,
      empty: null,
    },
    health: { status: "online", latencyMs: 12 },
    lastCheckedAt: "2026-09-27T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: 1234567890,
  });

  assert.ok(record);
  assert.strictEqual(record.id, "ep-custom-id");
  assert.strictEqual(record.name, "Big   Name");
  assert.strictEqual(record.type, "custom");
  assert.strictEqual(record.host, "example.com");
  assert.strictEqual(record.port, 30120);
  assert.strictEqual(record.protocol, null);
  assert.strictEqual(record.providerId, null);
  assert.strictEqual(record.serviceId, null);
  assert.strictEqual(record.computerId, "12345");
  assert.strictEqual(record.source, "manual");
  assert.strictEqual(record.notes.length, MAX_NOTES_LENGTH);
  assert.strictEqual(record.enabled, true);
  assert.deepStrictEqual(Object.keys(record.metadata).sort(), ["big", "count", "empty", "flag", "good"]);
  assert.strictEqual(record.metadata.big.length, MAX_METADATA_VALUE_LENGTH);
  assert.strictEqual(record.metadata.count, 5);
  assert.strictEqual(record.metadata.flag, false);
  assert.strictEqual(record.metadata.empty, null);
  assert.strictEqual(record.metadata.infinite, undefined);
  assert.deepStrictEqual(record.health, { status: "online", latencyMs: 12 });
  assert.strictEqual(record.lastCheckedAt, "2026-09-27T00:00:00.000Z");
  assert.strictEqual(record.createdAt, "2026-01-01T00:00:00.000Z");
  assert.strictEqual(record.updatedAt, null);

  const generated = normalizeEndpointRecord({ name: "Generated", type: "lan", host: "10.0.0.5", port: 8080, protocol: "tcp", serviceId: "svc", computerId: "c1" });
  assert.ok(generated);
  assert.match(generated.id, /^ep-[0-9a-f]{16}$/);
  assert.strictEqual(
    generated.id,
    buildEndpointId({ computerId: "c1", type: "lan", host: "10.0.0.5", port: 8080, protocol: "tcp", serviceId: "svc", name: "Generated" })
  );
  assert.strictEqual(generated.health, null);
  assert.strictEqual(generated.lastCheckedAt, null);
  assert.strictEqual(generated.createdAt, null);
  assert.strictEqual(generated.updatedAt, null);
  assert.deepStrictEqual(generated.metadata, {});
});

test("sortEndpoints deterministic", () => {
  const list = [
    { id: "ep-2", name: "beta", type: "public", computerId: "c2", serviceId: "s1" },
    { id: "ep-1", name: "Alpha", type: "lan", computerId: "c1", serviceId: "s1" },
    { id: "ep-3", name: "alpha", type: "lan", computerId: "c1", serviceId: "s1" },
    { id: "ep-0", name: "Gamma", type: "private", computerId: "c1", serviceId: "s1" },
    { id: "ep-4", name: "Delta", type: "custom", computerId: "c1", serviceId: "s2" },
    { id: "ep-5", name: "Epsilon", type: "tailscale", computerId: "c1", serviceId: "s1" },
  ];
  const sorted = sortEndpoints(list);
  assert.deepStrictEqual(sorted.map((endpoint) => endpoint.id), ["ep-0", "ep-1", "ep-3", "ep-5", "ep-4", "ep-2"]);
  assert.deepStrictEqual(sortEndpoints(list).map((endpoint) => endpoint.id), sorted.map((endpoint) => endpoint.id));
  assert.deepStrictEqual(sortEndpoints([]), []);
  assert.deepStrictEqual(sortEndpoints(null), []);
  assert.strictEqual(list[0].id, "ep-2");
  const typeOrder = [
    { id: "a", name: "x", type: "custom", computerId: "c", serviceId: "s" },
    { id: "b", name: "x", type: "public", computerId: "c", serviceId: "s" },
    { id: "c", name: "x", type: "private", computerId: "c", serviceId: "s" },
    { id: "d", name: "x", type: "tailscale", computerId: "c", serviceId: "s" },
    { id: "e", name: "x", type: "lan", computerId: "c", serviceId: "s" },
  ];
  assert.deepStrictEqual(sortEndpoints(typeOrder).map((endpoint) => endpoint.type), ["private", "lan", "tailscale", "public", "custom"]);
});

test("publicEndpointView is a JSON-safe clone", () => {
  const record = normalizeEndpointRecord({
    name: "View test",
    type: "public",
    host: "Example.COM",
    port: 443,
    protocol: "https",
    metadata: { ok: true },
    health: { status: "up", nested: { latency: 5 }, missing: undefined, fn: () => undefined },
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const view = publicEndpointView(record);
  assert.ok(view);
  assert.deepStrictEqual(
    Object.keys(view),
    [
      "id",
      "name",
      "type",
      "host",
      "port",
      "protocol",
      "enabled",
      "providerId",
      "serviceId",
      "computerId",
      "source",
      "notes",
      "metadata",
      "health",
      "lastCheckedAt",
      "createdAt",
      "updatedAt",
    ]
  );
  const json = JSON.stringify(view);
  assert.ok(typeof json === "string" && json.length > 0);
  const roundTrip = JSON.parse(json);
  assert.strictEqual(roundTrip.host, "example.com");
  assert.strictEqual(roundTrip.port, 443);
  assert.deepStrictEqual(roundTrip.health.nested, { latency: 5 });
  assert.strictEqual(roundTrip.health.fn, undefined);
  assert.strictEqual(roundTrip.health.missing, undefined);
  assert.ok(!json.includes("undefined"));
  view.metadata.ok = false;
  assert.strictEqual(record.metadata.ok, true);
  assert.strictEqual(publicEndpointView(null), null);
  assert.strictEqual(publicEndpointView("nope"), null);
});

test("isLoopbackHost", () => {
  for (const host of ["127.0.0.1", "127.255.0.9", "127.0.0.1.", "::1", "0:0:0:0:0:0:0:1", "[::1]", "localhost", "LOCALHOST", "localhost."]) {
    assert.strictEqual(isLoopbackHost(host), true, `expected loopback for ${host}`);
  }
  for (const host of ["128.0.0.1", "10.0.0.1", "example.com", "::2", "", null, undefined, 42]) {
    assert.strictEqual(isLoopbackHost(host), false, `expected non-loopback for ${String(host)}`);
  }
});

test("isPrivateHost", () => {
  for (const host of ["10.0.0.5", "10.255.255.255", "172.16.5.5", "172.31.255.255", "192.168.1.1", "169.254.10.10", "100.64.0.1", "100.127.255.255"]) {
    assert.strictEqual(isPrivateHost(host), true, `expected private for ${host}`);
  }
  for (const host of ["172.32.0.1", "172.15.0.1", "192.169.0.1", "169.253.0.1", "100.128.0.1", "100.63.255.255", "8.8.8.8", "::1", "fe80::1", "localhost", ""]) {
    assert.strictEqual(isPrivateHost(host), false, `expected non-private for ${host}`);
  }
});

test("describeEndpointType", () => {
  assert.strictEqual(describeEndpointType("lan"), "LAN");
  assert.strictEqual(describeEndpointType("private"), "Private");
  assert.strictEqual(describeEndpointType("tailscale"), "Tailscale");
  assert.strictEqual(describeEndpointType("public"), "Public");
  assert.strictEqual(describeEndpointType("custom"), "Custom");
  assert.strictEqual(describeEndpointType("unknown"), "Custom");
  assert.strictEqual(describeEndpointType(undefined), "Custom");
  assert.strictEqual(describeEndpointType("__proto__"), "Custom");
  assert.strictEqual(describeEndpointType("constructor"), "Custom");
});

test("negative controls", () => {
  expectErrors(validateEndpointInput(baseInput({ type: "unknown-type" })), ["ENDPOINT_TYPE_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ host: "host with space" })), ["ENDPOINT_HOST_INVALID"]);
  expectErrors(validateEndpointInput(baseInput({ metadata: { nested: { depth: 1 } } })), ["ENDPOINT_METADATA_INVALID"]);
});

test("IPv6 forms accepted and rejected", () => {
  const accepted = [
    "::",
    "::1",
    "2001:db8::ff00:42:8329",
    "fe80::1",
    "::ffff:192.168.0.1",
    "1:2:3:4:5:6:7:8",
    "2001:0db8:0000:0000:0000:0000:0000:0001",
    "1:2:3:4:5:6:1.2.3.4",
  ];
  for (const host of accepted) {
    assert.strictEqual(expectOk(validateEndpointInput(baseInput({ host }))).host, host, `IPv6 host should be stored verbatim for ${host}`);
  }
  const rejected = [":::", "1::2::3", "12345::", "1:2:3:4:5:6:7:8:9", "::ffff:999.1.1.1", "[::1", "::1]", "[::1]extra", "gggg::1"];
  for (const host of rejected) {
    expectErrors(validateEndpointInput(baseInput({ host })), ["ENDPOINT_HOST_INVALID"]);
  }
});

test("host length limits", () => {
  const tooLong = `${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}`;
  expectErrors(validateEndpointInput(baseInput({ host: tooLong })), ["ENDPOINT_HOST_TOO_LONG"]);
  const atLimit = `${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(61)}`;
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ host: atLimit }))).host.length, MAX_HOST_LENGTH);
  expectErrors(validateEndpointInput(baseInput({ host: `${"a".repeat(64)}.com` })), ["ENDPOINT_HOST_INVALID"]);
});

test("host normalization details", () => {
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ host: "127.0.0.1." }))).host, "127.0.0.1");
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ host: "EXAMPLE.com" }))).host, "example.com");
  assert.strictEqual(expectOk(validateEndpointInput(baseInput({ host: "  [::1]  " }))).host, "::1");
});

if (failures.length > 0) {
  console.error(`endpoint-model smoke: ${failures.length} failed, ${checks} passed`);
  for (const failure of failures) console.error(`  FAIL ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`endpoint-model smoke: all ${checks} test groups passed`);
}
