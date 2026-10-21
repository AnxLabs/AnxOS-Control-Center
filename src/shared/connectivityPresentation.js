(function initializeConnectivityPresentation(root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.AnxConnectivityPresentation = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createConnectivityPresentationApi(root) {
  "use strict";

  // Renderer-facing presentation helpers. Dual-mode:
  //   - CommonJS (main process / tests): requires the sibling shared modules.
  //   - Browser <script> tags: consumes root.AnxHealthModel and
  //     root.AnxConnectivityDiagnostics and degrades gracefully when the
  //     diagnostics global has not been loaded.

  const hasCommonJs = typeof module === "object" && module && module.exports;
  let healthModel = null;
  let diagnosticsModel = null;
  if (hasCommonJs && typeof require === "function") {
    try {
      healthModel = require("./healthModel");
    } catch (error) {
      healthModel = null;
    }
    try {
      diagnosticsModel = require("./connectivityDiagnostics");
    } catch (error) {
      diagnosticsModel = null;
    }
  }
  if (!healthModel && root && root.AnxHealthModel) healthModel = root.AnxHealthModel;
  if (!diagnosticsModel && root && root.AnxConnectivityDiagnostics) {
    diagnosticsModel = root.AnxConnectivityDiagnostics;
  }

  // Presentation-only fallbacks. They exist so a missing health model global
  // degrades to truthful neutral values instead of throwing in the renderer;
  // they are never used to compute connectivity itself.
  const FALLBACK_LABELS = Object.freeze({
    healthy: "Healthy",
    degraded: "Degraded",
    failed: "Failed",
    unknown: "Unknown",
    unsupported: "Unsupported",
    not_configured: "Not Configured",
  });
  const FALLBACK_TONES = Object.freeze({
    healthy: "ok",
    degraded: "warning",
    failed: "error",
    unknown: "neutral",
    unsupported: "muted",
    not_configured: "muted",
  });
  const FALLBACK_SCOPES = Object.freeze([
    ["process", "Process"],
    ["local", "Local"],
    ["lan", "LAN"],
    ["private_overlay", "Private Overlay"],
    ["public", "Public"],
  ]);

  const STAGE_STATE_DESCRIPTIONS = Object.freeze({
    healthy: "This stage passed its checks.",
    degraded: "This stage responds, but with reduced reliability.",
    failed: "This stage did not pass and the path is broken here.",
    unknown: "Not enough evidence to judge this stage yet.",
    unsupported: "This stage does not apply in this configuration.",
    not_configured: "This stage has not been configured yet.",
  });

  const EVIDENCE_KEYS = Object.freeze([
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
  ]);

  const MAX_EVIDENCE_ROWS = 16;

  const SCOPE_PREFERENCE = Object.freeze(["lan", "public", "overlay", "local", "private", "custom"]);

  function stateLabel(state) {
    if (healthModel && typeof healthModel.stateLabel === "function") return healthModel.stateLabel(state);
    return FALLBACK_LABELS[state] || "Unknown";
  }

  function stateTone(state) {
    if (healthModel && typeof healthModel.stateTone === "function") return healthModel.stateTone(state);
    return FALLBACK_TONES[state] || "neutral";
  }

  function describeStageState(state) {
    const description = STAGE_STATE_DESCRIPTIONS[state] || STAGE_STATE_DESCRIPTIONS.unknown;
    return { label: stateLabel(state), tone: stateTone(state), description };
  }

  function fallbackScopeRows() {
    const scopes =
      healthModel && Array.isArray(healthModel.REACHABILITY_SCOPES)
        ? healthModel.REACHABILITY_SCOPES
        : FALLBACK_SCOPES.map((pair) => pair[0]);
    const labels =
      healthModel && healthModel.SCOPE_LABELS
        ? healthModel.SCOPE_LABELS
        : FALLBACK_SCOPES.reduce((map, pair) => {
            map[pair[0]] = pair[1];
            return map;
          }, {});
    return scopes.map((scope) => ({
      scope,
      label: labels[scope] || scope,
      state: "unknown",
      stateLabel: stateLabel("unknown"),
      tone: stateTone("unknown"),
    }));
  }

  function summarizeConnectivity(diagnostics) {
    if (diagnosticsModel && typeof diagnosticsModel.summarizeDiagnostics === "function") {
      return diagnosticsModel.summarizeDiagnostics(diagnostics);
    }
    return {
      headline: "Unknown",
      tone: "neutral",
      detail: "No diagnostics result available.",
      scopeRows: fallbackScopeRows(),
    };
  }

  function bareHost(value) {
    const text = String(value || "").trim().toLowerCase();
    if (!text) return "";
    if (text.startsWith("[")) {
      const end = text.indexOf("]");
      return end >= 0 ? text.slice(1, end) : text.slice(1);
    }
    const colon = text.indexOf(":");
    return colon >= 0 ? text.slice(0, colon) : text;
  }

  function isLoopbackHost(value) {
    const host = bareHost(value);
    return host === "localhost" || host === "::1" || host.startsWith("127.");
  }

  // Scope mapping from the endpoint type (host loopback refines "private" to
  // "local"). Unknown types degrade to "custom", except a loopback host which
  // is always local reachability.
  function endpointScope(endpoint) {
    const type = String((endpoint && endpoint.type) || "").trim().toLowerCase();
    const loopback = isLoopbackHost((endpoint && (endpoint.host || endpoint.address)) || "");
    switch (type) {
      case "private":
      case "local":
        return loopback ? "local" : "private";
      case "loopback":
        return "local";
      case "lan":
        return "lan";
      case "tailscale":
        return "overlay";
      case "public":
        return "public";
      case "custom":
        return "custom";
      default:
        return loopback ? "local" : "custom";
    }
  }

  function scopeRank(scope) {
    const index = SCOPE_PREFERENCE.indexOf(scope);
    return index === -1 ? SCOPE_PREFERENCE.length : index;
  }

  function endpointAddress(endpoint) {
    const explicit = String((endpoint && endpoint.address) || "").trim();
    if (explicit) return explicit;
    const host = String((endpoint && endpoint.host) || "").trim();
    const port = endpoint && endpoint.port != null ? String(endpoint.port).trim() : "";
    if (host && port) return `${host}:${port}`;
    return host;
  }

  function buildEndpointChoices(endpoints, options) {
    const input = options && typeof options === "object" && !Array.isArray(options) ? options : {};
    const serviceId = input.serviceId == null ? null : String(input.serviceId);
    const preferScope = input.preferScope == null ? null : String(input.preferScope);
    const list = (Array.isArray(endpoints) ? endpoints : []).filter(
      (endpoint) => endpoint && typeof endpoint === "object" && !Array.isArray(endpoint),
    );
    const filtered =
      serviceId == null
        ? list
        : list.filter((endpoint) => {
            const endpointServiceId = endpoint.serviceId == null ? null : String(endpoint.serviceId);
            return endpointServiceId === null || endpointServiceId === serviceId;
          });

    const entries = filtered.map((endpoint, index) => {
      const host = String(endpoint.host || "").trim();
      const port = endpoint.port != null ? String(endpoint.port).trim() : "";
      const explicitId = String(endpoint.id == null ? "" : endpoint.id).trim();
      const disabled = Boolean(endpoint.disabled) || endpoint.enabled === false;
      const scope = endpointScope(endpoint);
      return {
        index,
        disabled,
        scope,
        choice: {
          value: explicitId || `endpoint-${index}`,
          label: String(endpoint.label || endpoint.name || "").trim() || explicitId || `endpoint-${index}`,
          address: endpointAddress(endpoint),
          copyText: host && port ? `${host}:${port}` : "",
          detail: String(endpoint.detail || endpoint.description || "").trim(),
          recommended: false,
          disabled,
          scope,
        },
      };
    });

    // Enabled endpoints first; within each group, ordered by scope preference
    // [lan, public, overlay, local, private, custom] with a stable index
    // tiebreaker. Disabled endpoints are preserved but sorted last.
    entries.sort(
      (left, right) =>
        (left.disabled ? 1 : 0) - (right.disabled ? 1 : 0) ||
        scopeRank(left.scope) - scopeRank(right.scope) ||
        left.index - right.index,
    );
    const choices = entries.map((entry) => entry.choice);
    const recommendedIndex = preferScope
      ? entries.findIndex((entry) => !entry.disabled && entry.scope === preferScope)
      : entries.findIndex((entry) => !entry.disabled);
    if (recommendedIndex >= 0) choices[recommendedIndex].recommended = true;
    return { choices, emptyMessage: choices.length ? "" : "No endpoints configured." };
  }

  function stringifyEvidenceValue(value) {
    if (value == null) return null;
    if (typeof value === "string") return value;
    if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
    if (typeof value === "boolean") return value ? "true" : "false";
    if (Array.isArray(value)) {
      const parts = [];
      for (const item of value) {
        if (typeof item === "string" || typeof item === "boolean") parts.push(String(item));
        else if (typeof item === "number" && Number.isFinite(item)) parts.push(String(item));
      }
      return parts.length ? parts.join(", ") : null;
    }
    return null;
  }

  function humanizeEvidenceKey(key) {
    const acronyms = { pid: "PID", id: "ID", ms: "Ms" };
    return String(key)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(" ")
      .map((word) => {
        const lower = word.toLowerCase();
        if (acronyms[lower]) return acronyms[lower];
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
      })
      .join(" ");
  }

  // Renders only whitelisted, flat evidence. Values are always strings — a
  // nested object or array can never reach the UI, even if one slipped past the
  // stage builder.
  function formatDiagnosticsEvidence(stage) {
    const evidence =
      stage && typeof stage === "object" && stage.evidence && typeof stage.evidence === "object" && !Array.isArray(stage.evidence)
        ? stage.evidence
        : null;
    if (!evidence) return [];
    const rows = [];
    for (const key of EVIDENCE_KEYS) {
      if (rows.length >= MAX_EVIDENCE_ROWS) break;
      if (!Object.prototype.hasOwnProperty.call(evidence, key)) continue;
      const value = stringifyEvidenceValue(evidence[key]);
      if (value === null || value === "") continue;
      rows.push({ label: humanizeEvidenceKey(key), value });
    }
    return rows;
  }

  function graphNodeTone(node) {
    return stateTone(node && node.state);
  }

  // Provider last-sync records, kept per node as { [nodeId]: record }. Inputs
  // arrive in three shapes: the persisted map (endpoints:list), one node's
  // record (providers:getStatus syncs) and a sync result (providers:sync).
  // A missing or malformed input never erases what is already known.
  const SYNC_RECORD_FIELDS = ["providerId", "state", "tunnelCount", "errorCode", "lastSyncAt"];

  function toProviderSyncRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (typeof value.lastSyncAt !== "string" || !value.lastSyncAt) return null;
    const record = {};
    for (const field of SYNC_RECORD_FIELDS) {
      record[field] = Object.prototype.hasOwnProperty.call(value, field) ? value[field] : null;
    }
    if (!Number.isInteger(record.tunnelCount)) {
      record.tunnelCount = Array.isArray(value.tunnels) ? value.tunnels.length : null;
    }
    return record;
  }

  function mergeProviderSyncs(current, nodeId, incoming) {
    const merged = {};
    if (current && typeof current === "object" && !Array.isArray(current)) {
      for (const [key, value] of Object.entries(current)) {
        const record = toProviderSyncRecord(value);
        if (record) merged[key] = record;
      }
    }
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return merged;
    const single = toProviderSyncRecord(incoming);
    if (single) {
      if (typeof nodeId === "string" && nodeId) merged[nodeId] = single;
      return merged;
    }
    for (const [key, value] of Object.entries(incoming)) {
      const record = toProviderSyncRecord(value);
      if (record) merged[key] = record;
    }
    return merged;
  }

  return {
    stateLabel,
    stateTone,
    describeStageState,
    summarizeConnectivity,
    buildEndpointChoices,
    formatDiagnosticsEvidence,
    graphNodeTone,
    mergeProviderSyncs,
    MAX_EVIDENCE_ROWS,
  };
});
