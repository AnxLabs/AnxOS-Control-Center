"use strict";

// Main-process-only connectivity graph. Turns the canonical diagnostics result
// plus endpoint inventory into a deterministic node/edge graph for rendering.
// Boundaries:
//   - src/shared/** is copied into the Agent runtime: no electron, no fs, no
//     timers, no clocks — the caller injects `now`.
//   - States come exclusively from healthModel/connectivityDiagnostics. When
//     diagnostics are missing every node and edge is "unknown"; the graph never
//     fabricates health from inventory alone.

const healthModel = require("./healthModel");

// Hard cap so a pathological endpoint list cannot produce an unbounded graph.
const MAX_NODES = 40;

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeEndpointType(endpoint) {
  return String((endpoint && endpoint.type) || "").trim().toLowerCase();
}

function endpointProviderId(endpoint) {
  return String((endpoint && endpoint.providerId) || "").trim();
}

function endpointHost(endpoint) {
  return String((endpoint && (endpoint.host || endpoint.address)) || "").trim();
}

function endpointPort(endpoint) {
  const value = endpoint && endpoint.port;
  return value == null ? "" : String(value).trim();
}

function endpointProtocol(endpoint) {
  return String((endpoint && endpoint.protocol) || "").trim();
}

function endpointAddress(endpoint) {
  const explicit = String((endpoint && endpoint.address) || "").trim();
  if (explicit) return explicit;
  const host = endpointHost(endpoint);
  const port = endpointPort(endpoint);
  if (host && port) return `${host}:${port}`;
  return host || null;
}

// Edge labels are derived only from endpoint fields ("<protocol> <port>"); the
// label stays empty when nothing verifiable can be derived.
function endpointEdgeLabel(endpoint) {
  const protocol = endpointProtocol(endpoint);
  const port = endpointPort(endpoint);
  return protocol && port ? `${protocol} ${port}` : "";
}

function endpointLabel(endpoint, index) {
  const label = String((endpoint && (endpoint.label || endpoint.name)) || "").trim();
  return label || endpointAddress(endpoint) || `Endpoint ${index + 1}`;
}

// Which transport owns the computer -> endpoint hop:
//   provider-sourced (endpoint.providerId set) -> provider stage
//   public type                                -> public-endpoint stage
//   everything else (private/loopback/lan)     -> local-socket + host-network
function endpointRouteKind(endpoint) {
  if (endpointProviderId(endpoint)) return "provider";
  if (normalizeEndpointType(endpoint) === "public") return "public";
  return "direct";
}

function getStage(diagnostics, stageId) {
  if (!diagnostics || !Array.isArray(diagnostics.stages)) return null;
  const stage = diagnostics.stages.find((entry) => entry && entry.id === stageId);
  return stage && typeof stage === "object" ? stage : null;
}

function getStageState(diagnostics, stageId, fallback = "unknown") {
  const stage = getStage(diagnostics, stageId);
  if (!stage || !healthModel.CONNECTIVITY_STATES.includes(stage.state)) return fallback;
  return stage.state;
}

function getStageDetail(diagnostics, stageId) {
  const stage = getStage(diagnostics, stageId);
  return stage && typeof stage.detail === "string" ? stage.detail : "";
}

function getOverallState(diagnostics) {
  if (!diagnostics || typeof diagnostics !== "object") return "unknown";
  const state = diagnostics.overall && diagnostics.overall.state;
  return healthModel.CONNECTIVITY_STATES.includes(state) ? state : "unknown";
}

function endpointEdgeState(endpoint, diagnostics) {
  const kind = endpointRouteKind(endpoint);
  if (kind === "provider") return getStageState(diagnostics, "provider");
  if (kind === "public") return getStageState(diagnostics, "public-endpoint");
  return healthModel.combineStates([
    getStageState(diagnostics, "local-socket"),
    getStageState(diagnostics, "host-network"),
  ]);
}

function resolveProviderLabel(providers, providerId) {
  const match = providers.find((provider) => {
    if (!provider || typeof provider !== "object") return false;
    return String(provider.id || provider.providerId || "").trim() === providerId;
  });
  const label = match ? String(match.name || match.label || "").trim() : "";
  return label || providerId;
}

function buildConnectivityGraph(options) {
  const input = options && typeof options === "object" && !Array.isArray(options) ? options : {};
  const computer = input.computer && typeof input.computer === "object" ? input.computer : {};
  const service = input.service && typeof input.service === "object" ? input.service : {};
  const endpointList = (Array.isArray(input.endpoints) ? input.endpoints : []).filter(
    (endpoint) => endpoint && typeof endpoint === "object" && !Array.isArray(endpoint),
  );
  const diagnostics =
    input.diagnostics && typeof input.diagnostics === "object" && !Array.isArray(input.diagnostics)
      ? input.diagnostics
      : null;
  const providers = Array.isArray(input.providers) ? input.providers : [];

  const serviceNodeId = `service:${String(service.id || service.serviceId || "").trim() || "unknown"}`;
  const computerNodeId = `computer:${String(computer.nodeId || computer.id || "").trim() || "unknown"}`;

  // Provider nodes: one per unique providerId referenced by an endpoint,
  // sorted by id so the graph is byte-for-byte reproducible.
  const providerIds = Array.from(
    new Set(endpointList.map(endpointProviderId).filter(Boolean)),
  ).sort(compareStrings);

  // Endpoints sorted by type/name/id with a stable original-index tiebreaker,
  // then de-duplicated by explicit id so node ids stay unique.
  const decorated = endpointList.map((endpoint, index) => ({ endpoint, index }));
  decorated.sort((left, right) => {
    const leftEndpoint = left.endpoint;
    const rightEndpoint = right.endpoint;
    return (
      compareStrings(normalizeEndpointType(leftEndpoint), normalizeEndpointType(rightEndpoint)) ||
      compareStrings(
        String(leftEndpoint.name || leftEndpoint.label || ""),
        String(rightEndpoint.name || rightEndpoint.label || ""),
      ) ||
      compareStrings(String(leftEndpoint.id || ""), String(rightEndpoint.id || "")) ||
      left.index - right.index
    );
  });
  const seenEndpointIds = new Set();
  const uniqueEndpoints = [];
  for (const item of decorated) {
    const explicitId = String(item.endpoint.id == null ? "" : item.endpoint.id).trim();
    if (explicitId && seenEndpointIds.has(explicitId)) continue;
    if (explicitId) seenEndpointIds.add(explicitId);
    uniqueEndpoints.push(item);
  }

  const providerNodes = providerIds.slice(0, Math.max(0, MAX_NODES - 2)).map((providerId) => ({
    id: `provider:${providerId}`,
    kind: "provider",
    label: resolveProviderLabel(providers, providerId),
    state: getStageState(diagnostics, "provider"),
    detail: getStageDetail(diagnostics, "provider"),
    selectable: true,
    stageId: "provider",
    endpointId: null,
    address: null,
  }));
  const keptProviderIds = new Set(providerNodes.map((node) => node.id.slice("provider:".length)));

  const endpointBudget = Math.max(0, MAX_NODES - 2 - providerNodes.length);
  const keptEndpoints = uniqueEndpoints.slice(0, endpointBudget);
  const omittedCount = providerIds.length - providerNodes.length + (uniqueEndpoints.length - keptEndpoints.length);
  const truncated = omittedCount > 0;

  const nodes = [
    {
      id: serviceNodeId,
      kind: "service",
      label: String(service.name || service.displayName || "").trim() || "Service",
      state: getOverallState(diagnostics),
      detail: getStageDetail(diagnostics, "service-process"),
      selectable: true,
      stageId: "service-process",
      endpointId: null,
      address: null,
    },
    {
      id: computerNodeId,
      kind: "computer",
      label: String(computer.name || computer.computerName || "").trim() || "Computer",
      state: getStageState(diagnostics, "agent"),
      detail: getStageDetail(diagnostics, "agent"),
      selectable: true,
      stageId: "agent",
      endpointId: null,
      address: null,
    },
    ...providerNodes,
  ];

  const edges = [
    {
      from: serviceNodeId,
      to: computerNodeId,
      state: getStageState(diagnostics, "service-process"),
      label: "",
    },
  ];

  for (const item of keptEndpoints) {
    const endpoint = item.endpoint;
    const routeKind = endpointRouteKind(endpoint);
    const edgeState = endpointEdgeState(endpoint, diagnostics);
    const stageId =
      routeKind === "provider" ? "provider" : routeKind === "public" ? "public-endpoint" : "local-socket";
    const explicitId = String(endpoint.id == null ? "" : endpoint.id).trim();
    const endpointNodeId = `endpoint:${explicitId || `auto-${item.index}`}`;

    nodes.push({
      id: endpointNodeId,
      kind: "endpoint",
      label: endpointLabel(endpoint, item.index),
      state: edgeState,
      detail: getStageDetail(diagnostics, stageId),
      selectable: true,
      stageId,
      endpointId: explicitId || null,
      address: endpointAddress(endpoint),
    });
    edges.push({
      from: computerNodeId,
      to: endpointNodeId,
      state: edgeState,
      label: endpointEdgeLabel(endpoint),
    });
    if (routeKind === "provider" && keptProviderIds.has(endpointProviderId(endpoint))) {
      edges.push({
        from: `provider:${endpointProviderId(endpoint)}`,
        to: endpointNodeId,
        state: getStageState(diagnostics, "public-endpoint"),
        label: endpointEdgeLabel(endpoint),
      });
    }
  }

  const counts = { healthy: 0, degraded: 0, failed: 0, unknown: 0, unsupported: 0, not_configured: 0 };
  for (const node of nodes) counts[node.state] = (counts[node.state] || 0) + 1;
  const summaryState = healthModel.worstState(nodes.map((node) => node.state));
  let summaryDetail =
    `${nodes.length} nodes, ${edges.length} edges; ` +
    `${counts.failed} failed, ${counts.degraded} degraded, ${counts.unknown} unknown, ` +
    `${counts.healthy} healthy.`;
  let summaryTruncated;
  if (truncated) {
    summaryDetail += ` Truncated at the ${MAX_NODES}-node cap; ${omittedCount} node(s) omitted.`;
    summaryTruncated = true;
  }
  const summary = {
    state: summaryState,
    label: healthModel.stateLabel(summaryState),
    detail: summaryDetail,
  };
  if (summaryTruncated) summary.truncated = true;

  return {
    generatedAt: input.now == null ? null : input.now,
    summary,
    nodes,
    edges,
  };
}

module.exports = {
  MAX_NODES,
  buildConnectivityGraph,
  getStageState,
};
