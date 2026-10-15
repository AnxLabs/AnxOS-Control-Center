const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const rootDir = path.resolve(__dirname, "..");
const presentation = require(path.join(rootDir, "src", "shared", "connectivityPresentation.js"));

const EXPECTED = [
  ["healthy", "Healthy", "ok"],
  ["degraded", "Degraded", "warning"],
  ["failed", "Failed", "error"],
  ["unknown", "Unknown", "neutral"],
  ["unsupported", "Unsupported", "muted"],
  ["not_configured", "Not Configured", "muted"],
];

function newSandbox() {
  const sandbox = { console };
  vm.createContext(sandbox);
  return sandbox;
}

function runSharedModule(sandbox, fileName) {
  const source = fs.readFileSync(path.join(rootDir, "src", "shared", fileName), "utf8");
  vm.runInContext(source, sandbox, { filename: fileName });
}

async function main() {
  // --- Delegated label/tone rows ---------------------------------------------
  for (const [state, label, tone] of EXPECTED) {
    assert.strictEqual(presentation.stateLabel(state), label);
    assert.strictEqual(presentation.stateTone(state), tone);
  }
  assert.strictEqual(presentation.stateLabel("bogus"), "Unknown");
  assert.strictEqual(presentation.stateTone("bogus"), "neutral");

  // --- describeStageState ------------------------------------------------------
  for (const [state, label, tone] of EXPECTED) {
    const described = presentation.describeStageState(state);
    assert.strictEqual(described.label, label);
    assert.strictEqual(described.tone, tone);
    assert.ok(typeof described.description === "string" && described.description.length > 0);
  }
  assert.deepStrictEqual(presentation.describeStageState("bogus"), presentation.describeStageState("unknown"));

  // --- buildEndpointChoices ----------------------------------------------------
  const endpoints = [
    { id: "ep-disabled", type: "public", name: "Disabled Public", host: "public.example", port: 30120, disabled: true },
    { id: "ep-custom", type: "custom", name: "Custom", host: "custom.example", port: 8080 },
    { id: "ep-private", type: "private", name: "Private", host: "192.168.1.7", port: 25565 },
    { id: "ep-local", type: "private", name: "Loopback", host: "127.0.0.1", port: 25565 },
    { id: "ep-overlay", type: "tailscale", name: "Overlay", host: "anx.tailnet.ts.net", port: 25565 },
    { id: "ep-lan", type: "lan", name: "LAN", host: "192.168.1.50", port: 25565 },
    { id: "ep-public", type: "public", name: "Public", host: "public.example", port: 25565 },
  ];
  const built = presentation.buildEndpointChoices(endpoints);
  assert.strictEqual(built.emptyMessage, "");
  assert.deepStrictEqual(
    built.choices.map((choice) => choice.scope),
    ["lan", "public", "overlay", "local", "private", "custom", "public"],
    "enabled endpoints sort by scope preference; the disabled endpoint sorts last",
  );
  assert.deepStrictEqual(
    built.choices.map((choice) => choice.value),
    ["ep-lan", "ep-public", "ep-overlay", "ep-local", "ep-private", "ep-custom", "ep-disabled"],
  );
  assert.strictEqual(built.choices[0].recommended, true, "without preferScope the first enabled preference wins");
  assert.strictEqual(built.choices.filter((choice) => choice.recommended).length, 1);
  assert.strictEqual(built.choices[6].disabled, true);
  assert.strictEqual(built.choices[6].recommended, false);
  assert.strictEqual(built.choices[0].copyText, "192.168.1.50:25565");
  assert.strictEqual(built.choices[3].copyText, "127.0.0.1:25565", "loopback private endpoints are local scope");
  assert.strictEqual(built.choices[3].label, "Loopback");
  assert.strictEqual(built.choices[5].scope, "custom");

  assert.strictEqual(
    presentation.buildEndpointChoices(endpoints, { preferScope: "public" }).choices.find((choice) => choice.recommended).value,
    "ep-public",
  );
  assert.strictEqual(
    presentation.buildEndpointChoices(endpoints, { preferScope: "local" }).choices.find((choice) => choice.recommended).value,
    "ep-local",
  );
  const noMatch = presentation.buildEndpointChoices(endpoints, { preferScope: "does-not-exist" });
  assert.ok(noMatch.choices.every((choice) => choice.recommended === false), "no matching scope means no recommendation");

  const unknownType = presentation.buildEndpointChoices([
    { id: "weird", type: "weird", host: "10.0.0.9", port: 1 },
    { id: "weird-loopback", type: "weird", host: "localhost", port: 2 },
  ]);
  assert.strictEqual(unknownType.choices.find((choice) => choice.value === "weird").scope, "custom");
  assert.strictEqual(unknownType.choices.find((choice) => choice.value === "weird-loopback").scope, "local");

  const scoped = presentation.buildEndpointChoices(
    [
      { id: "a1", type: "lan", host: "10.0.0.1", port: 1, serviceId: "svc-a" },
      { id: "b1", type: "lan", host: "10.0.0.2", port: 2, serviceId: "svc-b" },
      { id: "shared", type: "lan", host: "10.0.0.3", port: 3 },
      { id: "null-service", type: "lan", host: "10.0.0.4", port: 4, serviceId: null },
    ],
    { serviceId: "svc-a" },
  );
  assert.deepStrictEqual(
    scoped.choices.map((choice) => choice.value),
    ["a1", "shared", "null-service"],
    "serviceId filter keeps matching endpoints and service-agnostic endpoints",
  );

  assert.deepStrictEqual(presentation.buildEndpointChoices([]), { choices: [], emptyMessage: "No endpoints configured." });
  assert.deepStrictEqual(presentation.buildEndpointChoices(), { choices: [], emptyMessage: "No endpoints configured." });
  assert.strictEqual(presentation.buildEndpointChoices(null).emptyMessage, "No endpoints configured.");

  // --- formatDiagnosticsEvidence -----------------------------------------------
  const stage = {
    id: "agent",
    state: "healthy",
    evidence: {
      processRunning: true,
      pid: 4242,
      boundAddresses: ["0.0.0.0:30120", "127.0.0.1:30120"],
      note: "agent ok",
      latencyMs: 4.5,
      secretSnapshot: { token: "must-never-appear", nested: { deep: true } },
      rawPair: ["ok", { b: 1 }],
    },
  };
  const rows = presentation.formatDiagnosticsEvidence(stage);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((row) => typeof row.label === "string" && typeof row.value === "string"));
  assert.ok(!rows.some((row) => row.value.includes("object")), "no stringified objects may surface");
  assert.ok(!rows.some((row) => row.value.includes("must-never-appear")), "non-whitelisted keys are ignored entirely");
  const values = rows.map((row) => `${row.label}=${row.value}`);
  assert.ok(values.includes("PID=4242"));
  assert.ok(values.includes("Process Running=true"));
  assert.ok(values.includes("Bound Addresses=0.0.0.0:30120, 127.0.0.1:30120"));
  assert.ok(values.includes("Note=agent ok"));
  assert.ok(!values.some((line) => line.includes("Secret Snapshot")));

  const mixed = presentation.formatDiagnosticsEvidence({
    id: "host-network",
    state: "healthy",
    evidence: {
      boundAddresses: ["10.0.0.2:80", { secret: 1 }, ["nested"]],
      publicAddress: { host: "x", port: 1 },
      note: 7,
    },
  });
  assert.deepStrictEqual(mixed, [
    { label: "Bound Addresses", value: "10.0.0.2:80" },
    { label: "Note", value: "7" },
  ]);

  assert.deepStrictEqual(presentation.formatDiagnosticsEvidence(null), []);
  assert.deepStrictEqual(presentation.formatDiagnosticsEvidence({ id: "agent", state: "healthy" }), []);
  assert.deepStrictEqual(presentation.formatDiagnosticsEvidence({ evidence: { pid: 1 } }), [{ label: "PID", value: "1" }]);

  const allKeysEvidence = {};
  for (const key of [
    "instanceState",
    "processRunning",
    "pid",
    "uptimeSeconds",
    "host",
    "port",
    "protocol",
    "result",
    "latencyMs",
    "vantage",
    "boundAddresses",
    "listenerSource",
    "agentState",
    "agentVersion",
    "lastContact",
    "providerId",
    "providerState",
    "connected",
    "tunnelId",
    "publicAddress",
    "region",
    "addressSource",
    "note",
  ]) {
    allKeysEvidence[key] = "value";
  }
  const capped = presentation.formatDiagnosticsEvidence({ evidence: allKeysEvidence });
  assert.strictEqual(capped.length, presentation.MAX_EVIDENCE_ROWS);
  assert.strictEqual(presentation.MAX_EVIDENCE_ROWS, 16);
  assert.ok(capped.every((row) => typeof row.value === "string"));

  // --- graphNodeTone ------------------------------------------------------------
  assert.strictEqual(presentation.graphNodeTone({ state: "failed" }), "error");
  assert.strictEqual(presentation.graphNodeTone({ state: "healthy" }), "ok");
  assert.strictEqual(presentation.graphNodeTone(null), "neutral");

  // --- UMD browser-global wiring -------------------------------------------------
  const browser = newSandbox();
  runSharedModule(browser, "healthModel.js");
  assert.ok(browser.AnxHealthModel, "healthModel.js must publish AnxHealthModel");
  assert.strictEqual(browser.AnxHealthModel.worstState(["healthy", "failed"]), "failed");

  runSharedModule(browser, "connectivityDiagnostics.js");
  assert.ok(browser.AnxConnectivityDiagnostics, "connectivityDiagnostics.js must publish AnxConnectivityDiagnostics");
  const browserStages = ["service-process", "local-socket", "agent"].map((id) =>
    browser.AnxConnectivityDiagnostics.createStage({ id, state: "healthy", detail: `${id} ok` }),
  );
  const browserResult = browser.AnxConnectivityDiagnostics.buildDiagnosticsResult({
    target: { nodeId: "node-1" },
    stages: browserStages,
    checkedAt: "2026-09-27T00:00:00.000Z",
  });
  assert.strictEqual(browserResult.overall.state, "healthy");

  runSharedModule(browser, "connectivityPresentation.js");
  assert.ok(browser.AnxConnectivityPresentation, "connectivityPresentation.js must publish AnxConnectivityPresentation");
  assert.strictEqual(browser.AnxConnectivityPresentation.stateLabel("failed"), "Failed");
  assert.strictEqual(browser.AnxConnectivityPresentation.stateTone("failed"), "error");
  const browserSummary = browser.AnxConnectivityPresentation.summarizeConnectivity(browserResult);
  assert.strictEqual(browserSummary.headline, "Healthy");
  assert.strictEqual(browserSummary.tone, "ok");
  assert.strictEqual(browserSummary.scopeRows.length, 5);
  assert.strictEqual(browserSummary.scopeRows[0].state, "healthy");
  const browserChoices = browser.AnxConnectivityPresentation.buildEndpointChoices([
    { id: "ep-lan", type: "lan", host: "10.0.0.1", port: 25565 },
  ]);
  assert.strictEqual(browserChoices.choices.length, 1);
  assert.strictEqual(browserChoices.choices[0].recommended, true);

  // Reduced sandbox: health model but no diagnostics global — presentation
  // must degrade to truthful unknown rows instead of throwing.
  const reduced = newSandbox();
  runSharedModule(reduced, "healthModel.js");
  runSharedModule(reduced, "connectivityPresentation.js");
  assert.ok(reduced.AnxConnectivityPresentation);
  const fallback = reduced.AnxConnectivityPresentation.summarizeConnectivity(null);
  assert.strictEqual(fallback.headline, "Unknown");
  assert.strictEqual(fallback.tone, "neutral");
  assert.strictEqual(fallback.scopeRows.length, 5);
  assert.ok(fallback.scopeRows.every((row) => row.state === "unknown" && row.tone === "neutral"));
  assert.strictEqual(reduced.AnxConnectivityPresentation.stateLabel("degraded"), "Degraded");
  assert.strictEqual(reduced.AnxConnectivityPresentation.formatDiagnosticsEvidence({ evidence: { pid: 7 } })[0].value, "7");

  console.log("connectivity-presentation-smoke: all assertions passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
