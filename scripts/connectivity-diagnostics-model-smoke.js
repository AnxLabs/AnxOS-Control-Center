const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const health = require(path.join(rootDir, "src", "shared", "healthModel.js"));
const diag = require(path.join(rootDir, "src", "shared", "connectivityDiagnostics.js"));

const CHECKED_AT = "2026-09-27T12:00:00.000Z";

// Canonical target construction: key order matches the module's canonical
// order so the pinned id can be recomputed with node:crypto.
function makeTarget(overrides = {}) {
  return {
    nodeId: overrides.nodeId !== undefined ? overrides.nodeId : "node-1",
    computerName: overrides.computerName !== undefined ? overrides.computerName : "AJ-DESKTOP",
    serviceId: overrides.serviceId !== undefined ? overrides.serviceId : "svc-anxrp",
    serviceName: overrides.serviceName !== undefined ? overrides.serviceName : "AnxRP",
    endpointId: overrides.endpointId !== undefined ? overrides.endpointId : "ep-public",
    endpointLabel: overrides.endpointLabel !== undefined ? overrides.endpointLabel : "Public (playit)",
  };
}

// Independent oracle for the embedded pure-JS sha256: recompute the exact id
// the module must produce using node:crypto.
function expectedId(target, checkedAt, stages) {
  const pairs = stages.map((stage) => [stage.id, stage.state]);
  const digest = crypto.createHash("sha256").update(JSON.stringify([target, checkedAt, pairs])).digest("hex");
  return `dx-${digest.slice(0, 16)}`;
}

function buildFailureStages() {
  return [
    diag.createStage({
      id: "service-process",
      state: "healthy",
      detail: "PID 4242 is running",
      evidence: { instanceState: "Running", processRunning: true, pid: 4242 },
    }),
    diag.createStage({
      id: "local-socket",
      state: "healthy",
      detail: "127.0.0.1:30120 accepts connections",
      evidence: { host: "127.0.0.1", port: 30120, protocol: "tcp", result: "connected", latencyMs: 3 },
    }),
    diag.createStage({
      id: "host-network",
      state: "healthy",
      detail: "Host firewall allows the game port",
      evidence: { boundAddresses: ["0.0.0.0:30120"], listenerSource: "netstat" },
    }),
    diag.createStage({
      id: "agent",
      state: "healthy",
      detail: "Agent last contact 4s ago",
      evidence: { agentState: "online", agentVersion: "1.4.2", lastContact: "2026-09-27T11:59:56Z" },
    }),
    diag.createStage({
      id: "provider",
      state: "failed",
      detail: "Tunnel daemon is not connected",
      evidence: { providerId: "playit", providerState: "disconnected", connected: false },
      remediation: [{ id: "open-provider", label: "Open Tunnel Provider", kind: "open-provider" }],
    }),
    diag.createStage({
      id: "public-endpoint",
      state: "failed",
      detail: "Public address refused the probe",
      evidence: { publicAddress: "example.playit.gg:30120", result: "refused" },
    }),
  ];
}

async function main() {
  // --- Constants -------------------------------------------------------------
  assert.deepStrictEqual(
    [...diag.STAGE_IDS],
    ["service-process", "local-socket", "host-network", "agent", "provider", "public-endpoint"],
  );
  assert.deepStrictEqual(diag.STAGE_LABELS, {
    "service-process": "Service Process",
    "local-socket": "Local Port",
    "host-network": "Host Networking",
    agent: "Agent",
    provider: "Tunnel Provider",
    "public-endpoint": "Public Endpoint",
  });
  assert.deepStrictEqual(
    [...diag.REMEDIATION_KINDS],
    ["open-network", "open-provider", "start-service", "open-console", "copy-details"],
  );
  assert.strictEqual(diag.MAX_STAGES, 12);

  // --- createStage happy path ------------------------------------------------
  const providerStage = diag.createStage({
    id: "provider",
    state: "failed",
    detail: "down",
    evidence: { connected: false, providerId: "playit" },
    remediation: [{ id: "open-provider", label: "Open Tunnel Provider", kind: "open-provider" }],
  });
  assert.deepStrictEqual(providerStage, {
    id: "provider",
    label: "Tunnel Provider",
    state: "failed",
    detail: "down",
    evidence: { connected: false, providerId: "playit" },
    remediation: [{ id: "open-provider", label: "Open Tunnel Provider", kind: "open-provider" }],
  });

  // --- Negative controls: programmer errors must throw TypeError -------------
  assert.throws(() => diag.createStage({ id: "warp-drive", state: "healthy" }), TypeError, "unknown stage id");
  assert.throws(() => diag.createStage({ id: "agent", state: "excellent" }), TypeError, "unknown state");
  assert.throws(
    () => diag.createStage({ id: "agent", state: "healthy", remediation: [{ id: "x", label: "X", kind: "explode" }] }),
    TypeError,
    "unknown remediation kind",
  );
  assert.throws(
    () => diag.createStage({ id: "agent", state: "healthy", evidence: { snapshot: { token: "secret" } } }),
    TypeError,
    "nested evidence object",
  );
  assert.throws(
    () => diag.createStage({ id: "agent", state: "healthy", evidence: { list: [{ nested: true }] } }),
    TypeError,
    "array of objects",
  );
  assert.throws(
    () => diag.createStage({ id: "agent", state: "healthy", evidence: { fn: () => {} } }),
    TypeError,
    "function evidence value",
  );
  assert.throws(
    () => diag.createStage({ id: "agent", state: "healthy", evidence: "not-an-object" }),
    TypeError,
    "non-object evidence container",
  );
  assert.throws(() => diag.createStage(null), TypeError, "missing stage");

  const tooManyKeys = {};
  for (let index = 0; index < 25; index += 1) tooManyKeys[`key${index}`] = index;
  assert.throws(
    () => diag.createStage({ id: "agent", state: "healthy", evidence: tooManyKeys }),
    TypeError,
    "evidence key cap",
  );
  const tooManyItems = Array.from({ length: 33 }, (_, index) => index);
  assert.throws(
    () => diag.createStage({ id: "agent", state: "healthy", evidence: { boundAddresses: tooManyItems } }),
    TypeError,
    "evidence array cap",
  );

  // --- (a) Real AnxRP failure shape -----------------------------------------
  const failureStages = buildFailureStages();
  const target = makeTarget();
  const failure = diag.buildDiagnosticsResult({
    target,
    stages: failureStages,
    checkedAt: CHECKED_AT,
    durationMs: 812,
    cached: false,
  });
  assert.strictEqual(failure.overall.state, "failed");
  assert.strictEqual(failure.overall.headline, "Path broken at: Tunnel Provider, Public Endpoint");
  assert.ok(
    failure.overall.detail.includes("Tunnel Provider: failed — Tunnel daemon is not connected"),
    "detail must carry per-stage one-liners",
  );
  assert.strictEqual(failure.reachability.process, "healthy");
  assert.strictEqual(failure.reachability.local, "healthy");
  assert.strictEqual(failure.reachability.lan, "unknown", "LAN reachability requires an explicit vantage");
  assert.strictEqual(failure.reachability.private_overlay, "unknown");
  assert.strictEqual(failure.reachability.public, "unknown", "a public-endpoint stage does not by itself answer public reachability");
  assert.strictEqual(failure.durationMs, 812);
  assert.strictEqual(failure.cached, false);
  assert.deepStrictEqual(Object.keys(failure.target), [
    "nodeId",
    "computerName",
    "serviceId",
    "serviceName",
    "endpointId",
    "endpointLabel",
  ]);
  assert.strictEqual(failure.id, expectedId(target, CHECKED_AT, failureStages));
  assert.match(failure.id, /^dx-[0-9a-f]{16}$/);

  const failureSummary = diag.summarizeDiagnostics(failure);
  assert.strictEqual(failureSummary.headline, "Path broken at: Tunnel Provider, Public Endpoint");
  assert.strictEqual(failureSummary.tone, "error");
  assert.deepStrictEqual(failureSummary.failedStages, ["provider", "public-endpoint"]);
  assert.deepStrictEqual(failureSummary.unknownStages, []);
  assert.deepStrictEqual(
    failureSummary.scopeRows.map((row) => row.scope),
    ["process", "local", "lan", "private_overlay", "public"],
  );
  assert.strictEqual(failureSummary.scopeRows[0].label, "Process");
  assert.strictEqual(failureSummary.scopeRows[0].stateLabel, "Healthy");
  assert.strictEqual(failureSummary.scopeRows[0].tone, "ok");
  assert.strictEqual(failureSummary.scopeRows[2].label, "LAN");
  assert.strictEqual(failureSummary.scopeRows[2].state, "unknown");
  assert.strictEqual(failureSummary.scopeRows[2].tone, "neutral");

  // --- (b) All healthy -------------------------------------------------------
  const healthyStages = diag.STAGE_IDS.map((id) => diag.createStage({ id, state: "healthy", detail: `${id} ok` }));
  const healthy = diag.buildDiagnosticsResult({ target, stages: healthyStages, checkedAt: CHECKED_AT });
  assert.strictEqual(healthy.overall.state, "healthy");
  assert.strictEqual(healthy.overall.headline, "Healthy");
  assert.strictEqual(diag.summarizeDiagnostics(healthy).tone, "ok");
  assert.strictEqual(healthy.id, expectedId(target, CHECKED_AT, healthyStages));
  assert.strictEqual(diag.validateDiagnosticsResult(healthy).ok, true);

  // --- (c) Public endpoint unknown -> overall unknown ------------------------
  const unknownStages = healthyStages.map((stage) =>
    stage.id === "public-endpoint"
      ? diag.createStage({ id: "public-endpoint", state: "unknown", detail: "probe never ran" })
      : stage,
  );
  const unknownResult = diag.buildDiagnosticsResult({ target, stages: unknownStages, checkedAt: CHECKED_AT });
  assert.strictEqual(unknownResult.overall.state, "unknown", "unknown must outrank healthy");
  assert.strictEqual(unknownResult.overall.headline, "Incomplete evidence: Public Endpoint");
  assert.strictEqual(unknownResult.reachability.public, "unknown");
  const unknownSummary = diag.summarizeDiagnostics(unknownResult);
  assert.strictEqual(unknownSummary.tone, "neutral");
  assert.deepStrictEqual(unknownSummary.unknownStages, ["public-endpoint"]);
  assert.deepStrictEqual(unknownSummary.failedStages, []);

  // --- (d) Only unranked stages -> not_configured ----------------------------
  const unranked = diag.buildDiagnosticsResult({
    target,
    stages: [
      diag.createStage({ id: "service-process", state: "unsupported" }),
      diag.createStage({ id: "agent", state: "not_configured" }),
    ],
    checkedAt: CHECKED_AT,
  });
  assert.strictEqual(unranked.overall.state, "not_configured");
  assert.strictEqual(unranked.overall.headline, "Not configured");
  assert.strictEqual(unranked.reachability.process, "unsupported");
  assert.strictEqual(unranked.reachability.local, "unknown");

  // --- Reachability overrides: only valid scope states are honored -----------
  const scoped = diag.buildDiagnosticsResult({
    target,
    stages: failureStages,
    checkedAt: CHECKED_AT,
    scopes: {
      public: "failed",
      lan: "degraded",
      local: "failed",
      private_overlay: "bogus",
      not_a_scope: "healthy",
    },
  });
  assert.strictEqual(scoped.reachability.public, "failed");
  assert.strictEqual(scoped.reachability.lan, "degraded");
  assert.strictEqual(scoped.reachability.local, "failed", "scopes may override the local default");
  assert.strictEqual(scoped.reachability.private_overlay, "unknown", "invalid scope states are ignored");
  assert.strictEqual(scoped.reachability.process, "healthy", "untouched scopes keep their defaults");
  assert.ok(!("not_a_scope" in scoped.reachability));

  // --- Deterministic ids -----------------------------------------------------
  const repeated = diag.buildDiagnosticsResult({
    target,
    stages: buildFailureStages(),
    checkedAt: CHECKED_AT,
    durationMs: 812,
  });
  assert.strictEqual(repeated.id, failure.id, "identical inputs must yield an identical id");
  const changed = diag.buildDiagnosticsResult({
    target,
    stages: failureStages.map((stage) =>
      stage.id === "agent" ? diag.createStage({ id: "agent", state: "degraded" }) : stage,
    ),
    checkedAt: CHECKED_AT,
  });
  assert.notStrictEqual(changed.id, failure.id, "a changed stage state must yield a different id");

  const unicodeTarget = makeTarget({ serviceName: "AnxRP ✓ — FiveM" });
  const unicodeResult = diag.buildDiagnosticsResult({ target: unicodeTarget, stages: failureStages, checkedAt: CHECKED_AT });
  assert.strictEqual(unicodeResult.id, expectedId(unicodeTarget, CHECKED_AT, failureStages), "utf-8 hashing must match node:crypto");

  // --- Stage cap -------------------------------------------------------------
  const overflow = Array.from({ length: 13 }, () => diag.createStage({ id: "agent", state: "healthy" }));
  const overflowResult = diag.buildDiagnosticsResult({ target, stages: overflow, checkedAt: CHECKED_AT });
  assert.strictEqual(overflowResult.stages.length, diag.MAX_STAGES);

  // --- validateDiagnosticsResult ---------------------------------------------
  assert.deepStrictEqual(diag.validateDiagnosticsResult(failure), { ok: true, errors: [] });

  assert.deepStrictEqual(diag.validateDiagnosticsResult(null), { ok: false, errors: ["result must be an object"] });

  const empty = diag.validateDiagnosticsResult({});
  assert.strictEqual(empty.ok, false);
  assert.ok(empty.errors.length > 0, "empty input must produce structural errors");

  const badStageId = JSON.parse(JSON.stringify(failure));
  badStageId.stages[0].id = "warp-drive";
  const badStageIdResult = diag.validateDiagnosticsResult(badStageId);
  assert.strictEqual(badStageIdResult.ok, false);
  assert.ok(badStageIdResult.errors.some((error) => error.includes("warp-drive")));

  const badOverall = JSON.parse(JSON.stringify(failure));
  badOverall.overall.state = "fine";
  assert.strictEqual(diag.validateDiagnosticsResult(badOverall).ok, false);

  const badReachability = JSON.parse(JSON.stringify(failure));
  badReachability.reachability.public = "definitely";
  assert.strictEqual(diag.validateDiagnosticsResult(badReachability).ok, false);

  const badId = JSON.parse(JSON.stringify(failure));
  badId.id = "dx-nope";
  assert.strictEqual(diag.validateDiagnosticsResult(badId).ok, false);

  // Guard against the severity order silently drifting from healthModel.
  assert.strictEqual(health.worstState(["unsupported", "healthy"]), "healthy");

  console.log("connectivity-diagnostics-model-smoke: all assertions passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
