const assert = require("node:assert/strict");
const path = require("node:path");

const rootDir = path.resolve(__dirname, "..");
const diag = require(path.join(rootDir, "src", "shared", "connectivityDiagnostics.js"));
const graph = require(path.join(rootDir, "src", "shared", "connectivityGraph.js"));

const NOW = "2026-09-27T12:30:00.000Z";
const CHECKED_AT = "2026-09-27T12:29:58.000Z";

function makeEndpoint(id, type, name, host, port, extra = {}) {
  return { id, type, name, host, port, protocol: "tcp", ...extra };
}

function makeFailureStages() {
  return [
    diag.createStage({ id: "service-process", state: "healthy", detail: "process up" }),
    diag.createStage({ id: "local-socket", state: "healthy", detail: "port open" }),
    diag.createStage({ id: "host-network", state: "healthy", detail: "firewall ok" }),
    diag.createStage({ id: "agent", state: "healthy", detail: "agent online" }),
    diag.createStage({ id: "provider", state: "failed", detail: "tunnel down" }),
    diag.createStage({ id: "public-endpoint", state: "failed", detail: "public refused" }),
  ];
}

async function main() {
  const computer = { nodeId: "node-1", name: "AJ-DESKTOP" };
  const service = { id: "svc-anxrp", name: "AnxRP" };
  const endpoints = [
    makeEndpoint("ep-public", "public", "Public", "anxrp.playit.gg", 30120, {
      providerId: "playit",
      address: "anxrp.playit.gg:30120",
    }),
    makeEndpoint("ep-lan", "lan", "LAN", "192.168.1.50", 30120),
    makeEndpoint("ep-private", "private", "Private", "127.0.0.1", 30120),
  ];
  const providers = [
    { id: "playit", name: "playit.gg" },
    { id: "tailscale", name: "Tailscale" },
  ];

  // --- No diagnostics: every node and edge is unknown -----------------------
  const blind = graph.buildConnectivityGraph({ computer, service, endpoints, providers, now: NOW });
  assert.strictEqual(blind.generatedAt, NOW);
  assert.ok(blind.nodes.length > 0);
  assert.ok(blind.nodes.every((node) => node.state === "unknown"), "inventory alone must never fake health");
  assert.ok(blind.edges.every((edge) => edge.state === "unknown"), "inventory alone must never fake a path");
  assert.strictEqual(blind.summary.state, "unknown");
  assert.strictEqual(blind.summary.label, "Unknown");
  assert.strictEqual(blind.summary.truncated, undefined, "no truncation flag when nothing was dropped");

  // --- Full diagnostics -------------------------------------------------------
  const diagnosticsResult = diag.buildDiagnosticsResult({
    target: { nodeId: "node-1", serviceId: "svc-anxrp" },
    stages: makeFailureStages(),
    checkedAt: CHECKED_AT,
  });
  const built = graph.buildConnectivityGraph({ computer, service, endpoints, diagnostics: diagnosticsResult, providers, now: NOW });

  assert.deepStrictEqual(
    built.nodes.map((node) => node.id),
    ["service:svc-anxrp", "computer:node-1", "provider:playit", "endpoint:ep-lan", "endpoint:ep-private", "endpoint:ep-public"],
    "node order: service, computer, providers sorted, endpoints sorted by type/name/id",
  );
  const byId = new Map(built.nodes.map((node) => [node.id, node]));
  assert.strictEqual(byId.get("service:svc-anxrp").kind, "service");
  assert.strictEqual(byId.get("service:svc-anxrp").state, "failed", "service node mirrors overall diagnostics state");
  assert.strictEqual(byId.get("service:svc-anxrp").label, "AnxRP");
  assert.strictEqual(byId.get("service:svc-anxrp").stageId, "service-process");
  assert.strictEqual(byId.get("computer:node-1").kind, "computer");
  assert.strictEqual(byId.get("computer:node-1").state, "healthy");
  assert.strictEqual(byId.get("computer:node-1").stageId, "agent");
  assert.strictEqual(byId.get("provider:playit").kind, "provider");
  assert.strictEqual(byId.get("provider:playit").state, "failed");
  assert.strictEqual(byId.get("provider:playit").label, "playit.gg");
  assert.strictEqual(byId.get("endpoint:ep-lan").state, "healthy", "direct endpoints combine local-socket + host-network");
  assert.strictEqual(byId.get("endpoint:ep-lan").stageId, "local-socket");
  assert.strictEqual(byId.get("endpoint:ep-lan").address, "192.168.1.50:30120");
  assert.strictEqual(byId.get("endpoint:ep-lan").endpointId, "ep-lan");
  assert.strictEqual(byId.get("endpoint:ep-private").state, "healthy");
  assert.strictEqual(byId.get("endpoint:ep-public").state, "failed", "provider-sourced endpoints follow the provider stage");
  assert.strictEqual(byId.get("endpoint:ep-public").stageId, "provider");
  assert.strictEqual(byId.get("endpoint:ep-public").address, "anxrp.playit.gg:30120");
  assert.ok(!byId.has("provider:tailscale"), "providers not referenced by an endpoint get no node");

  assert.deepStrictEqual(
    built.edges.map((edge) => `${edge.from}->${edge.to}:${edge.state}`),
    [
      "service:svc-anxrp->computer:node-1:healthy",
      "computer:node-1->endpoint:ep-lan:healthy",
      "computer:node-1->endpoint:ep-private:healthy",
      "computer:node-1->endpoint:ep-public:failed",
      "provider:playit->endpoint:ep-public:failed",
    ],
  );
  assert.strictEqual(built.edges[0].label, "");
  assert.strictEqual(built.edges[1].label, "tcp 30120");
  assert.strictEqual(built.edges[3].label, "tcp 30120");
  assert.strictEqual(built.edges[4].state, "failed", "provider -> public endpoint mirrors the public-endpoint stage");

  assert.strictEqual(built.summary.state, "failed");
  assert.strictEqual(built.summary.label, "Failed");
  assert.ok(built.summary.detail.includes("failed"), "summary detail must note the worst-state counts");

  // Determinism: two calls with identical input deep-equal byte-for-byte.
  const repeated = graph.buildConnectivityGraph({ computer, service, endpoints, diagnostics: diagnosticsResult, providers, now: NOW });
  assert.deepStrictEqual(repeated, built);

  // --- Provider node exists but diagnostics has no provider stage ------------
  const noProviderDiagnostics = diag.buildDiagnosticsResult({
    stages: makeFailureStages().filter((stage) => stage.id !== "provider"),
    checkedAt: CHECKED_AT,
  });
  const missingProviderStage = graph.buildConnectivityGraph({ computer, service, endpoints, diagnostics: noProviderDiagnostics, now: NOW });
  const missingById = new Map(missingProviderStage.nodes.map((node) => [node.id, node]));
  assert.strictEqual(missingById.get("provider:playit").state, "unknown", "missing provider stage must never guess provider health");
  assert.strictEqual(missingById.get("endpoint:ep-public").state, "unknown");
  const providerEdge = missingProviderStage.edges.find((edge) => edge.from === "provider:playit");
  assert.strictEqual(providerEdge.state, "failed", "provider -> endpoint edge still mirrors the public-endpoint stage");

  // --- Endpoint ordering ------------------------------------------------------
  const shuffled = [
    makeEndpoint("ep-z", "private", "Alpha", "10.0.0.3", 1),
    makeEndpoint("ep-b", "lan", "Beta", "10.0.0.2", 2),
    makeEndpoint("ep-a", "lan", "Alpha", "10.0.0.1", 3),
  ];
  const ordered = graph.buildConnectivityGraph({ endpoints: shuffled, now: NOW });
  assert.deepStrictEqual(
    ordered.nodes.filter((node) => node.kind === "endpoint").map((node) => node.id),
    ["endpoint:ep-a", "endpoint:ep-b", "endpoint:ep-z"],
    "endpoints sort by type, then name, then id",
  );

  // --- Node cap: 50 endpoints truncate to the 40-node budget -----------------
  const many = Array.from({ length: 50 }, (_, index) =>
    makeEndpoint(`ep-${String(index).padStart(3, "0")}`, "lan", `LAN ${String(index).padStart(3, "0")}`, "192.168.1.10", 30120),
  );
  const capped = graph.buildConnectivityGraph({ computer, service, endpoints: many, now: NOW });
  assert.strictEqual(capped.nodes.length, 40);
  assert.strictEqual(capped.summary.truncated, true);
  assert.ok(capped.summary.detail.includes("omitted"), "truncation must be visible in the summary detail");
  const keptEndpointIds = capped.nodes.filter((node) => node.kind === "endpoint").map((node) => node.id);
  assert.strictEqual(keptEndpointIds.length, 38, "40 total minus the fixed service + computer nodes");
  assert.strictEqual(keptEndpointIds[0], "endpoint:ep-000");
  assert.strictEqual(keptEndpointIds[37], "endpoint:ep-037");
  assert.ok(capped.edges.length <= 39, "edges must only reference kept nodes");
  assert.ok(capped.edges.every((edge) => capped.nodes.some((node) => node.id === edge.to)), "no dangling edges");

  // --- Empty input stays safe --------------------------------------------------
  const empty = graph.buildConnectivityGraph();
  assert.strictEqual(empty.generatedAt, null);
  assert.deepStrictEqual(empty.nodes.map((node) => node.id), ["service:unknown", "computer:unknown"]);
  assert.ok(empty.nodes.every((node) => node.state === "unknown"));
  assert.strictEqual(empty.edges.length, 1);
  assert.strictEqual(empty.edges[0].state, "unknown");
  assert.strictEqual(empty.summary.state, "unknown");
  assert.strictEqual(graph.buildConnectivityGraph(null).summary.state, "unknown");
  assert.strictEqual(graph.buildConnectivityGraph({ endpoints: "not-an-array" }).nodes.length, 2);

  // --- getStageState helper -----------------------------------------------------
  assert.strictEqual(graph.getStageState(null, "agent"), "unknown");
  assert.strictEqual(graph.getStageState(diagnosticsResult, "provider"), "failed");
  assert.strictEqual(graph.getStageState(diagnosticsResult, "provider", "degraded"), "failed");
  assert.strictEqual(graph.getStageState(diagnosticsResult, "warp-drive", "healthy"), "healthy");
  assert.strictEqual(
    graph.getStageState({ stages: [{ id: "agent", state: "banana" }] }, "agent", "unknown"),
    "unknown",
    "invalid stage states fall back",
  );
  assert.strictEqual(graph.MAX_NODES, 40);

  console.log("connectivity-graph-smoke: all assertions passed.");
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
