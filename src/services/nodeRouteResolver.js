"use strict";

// Automatic route fallback for Agent nodes. A node has its main Agent URL and
// optional fallback URLs (for example its Tailscale name, so a home server
// stays reachable away from home). The desktop uses the first route that
// answers, in order, and goes back to the main route as soon as it answers
// again.
//
// Security: a route is used only after its unauthenticated /api/v1/health
// reports the same Agent identity (deviceId) as the paired node, so the Agent
// token is never sent to a different machine. Plain-HTTP fallbacks are limited
// to loopback, private LAN and Tailscale addresses (normalizeNodeFallbackUrls
// in nodeService); anything else must use HTTPS.

const { EventEmitter } = require("events");

const PROBE_TIMEOUT_MS = 3000;
const REFRESH_INTERVAL_MS = 30000;
const FAILURE_REFRESH_DEBOUNCE_MS = 2000;

async function defaultProbe(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(new URL("api/v1/health", url.endsWith("/") ? url : `${url}/`), { signal: controller.signal, headers: { Accept: "application/json" } });
    const body = await response.json().catch(() => null);
    return { ok: response.ok, latencyMs: Date.now() - started, deviceId: body?.identity?.deviceId || null };
  } catch (error) {
    return { ok: false, latencyMs: null, deviceId: null, error: error?.name === "AbortError" ? "TIMEOUT" : error?.cause?.code || error?.code || "UNREACHABLE" };
  } finally {
    clearTimeout(timer);
  }
}

function candidatesFor(node = {}) {
  const primary = node.baseUrl || node.agentUrl;
  const list = [{ url: primary, label: "Main", primary: true }];
  for (const entry of Array.isArray(node.fallbackUrls) ? node.fallbackUrls : []) {
    if (entry?.url && entry.url !== primary) list.push({ url: entry.url, label: entry.label || "Fallback", primary: false });
  }
  return list;
}

function createNodeRouteResolver(overrides = {}) {
  const deps = {
    probe: defaultProbe,
    getNodes: () => require("./nodeService").getAllNodesSync(),
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    ...overrides,
  };
  const events = new EventEmitter();
  // nodeId -> { activeUrl, routes: [...], checkedAt }
  const state = new Map();
  const inFlight = new Map();
  const pendingFailure = new Set();

  function hasFallbacks(node) {
    return node?.kind === "agent" && Array.isArray(node.fallbackUrls) && node.fallbackUrls.length > 0;
  }

  // The URL requests should use right now. Without fallbacks, or before the
  // first check, it is the node's main URL.
  function getActiveUrl(node) {
    const primary = node?.baseUrl || node?.agentUrl;
    if (!hasFallbacks(node)) return primary;
    const entry = state.get(node.id);
    const known = candidatesFor(node).some((candidate) => candidate.url === entry?.activeUrl);
    return known ? entry.activeUrl : primary;
  }

  async function checkNode(node) {
    if (!hasFallbacks(node)) {
      state.delete(node?.id);
      return null;
    }
    if (inFlight.has(node.id)) return inFlight.get(node.id);
    const work = (async () => {
      const expected = node.agentIdentity?.deviceId || null;
      const routes = [];
      let activeUrl = null;
      for (const candidate of candidatesFor(node)) {
        const result = await deps.probe(candidate.url).catch(() => ({ ok: false, error: "UNREACHABLE" }));
        const identityMatches = Boolean(result.ok && expected && result.deviceId === expected);
        const route = {
          url: candidate.url,
          label: candidate.label,
          primary: candidate.primary,
          reachable: Boolean(result.ok),
          verified: identityMatches,
          latencyMs: result.latencyMs ?? null,
          error: result.ok ? (identityMatches ? null : "IDENTITY_MISMATCH") : result.error || "UNREACHABLE",
        };
        routes.push(route);
        if (identityMatches) {
          activeUrl = candidate.url;
          break; // first verified route in order wins; later ones are not probed
        }
      }
      const previous = state.get(node.id)?.activeUrl || null;
      // Nothing answered: keep the main URL so errors read naturally.
      const next = { activeUrl: activeUrl || (node.baseUrl || node.agentUrl), routes, checkedAt: new Date(deps.now()).toISOString(), reachable: Boolean(activeUrl) };
      state.set(node.id, next);
      if (previous !== next.activeUrl) events.emit("route-changed", { nodeId: node.id, from: previous, to: next.activeUrl });
      return getRouteStatus(node.id);
    })().finally(() => inFlight.delete(node.id));
    inFlight.set(node.id, work);
    return work;
  }

  async function refreshAll() {
    let nodes = [];
    try {
      nodes = deps.getNodes() || [];
    } catch {
      return [];
    }
    const ids = new Set(nodes.map((node) => node.id));
    for (const nodeId of [...state.keys()]) if (!ids.has(nodeId)) state.delete(nodeId);
    const results = await Promise.all(nodes.filter((node) => node.enabled !== false && node.manualDisconnect !== true).map((node) => checkNode(node)));
    return results.filter(Boolean);
  }

  // A request to this node could not connect: re-check its routes soon so the
  // next request can use a route that works.
  function reportTransportFailure(nodeId) {
    if (!nodeId || pendingFailure.has(nodeId)) return;
    pendingFailure.add(nodeId);
    deps.setTimeout(() => {
      pendingFailure.delete(nodeId);
      let node = null;
      try {
        node = (deps.getNodes() || []).find((entry) => entry.id === nodeId);
      } catch {}
      if (hasFallbacks(node)) checkNode(node).catch(() => {});
    }, FAILURE_REFRESH_DEBOUNCE_MS);
  }

  function getRouteStatus(nodeId) {
    const entry = state.get(nodeId);
    return entry ? { nodeId, ...entry, routes: entry.routes.map((route) => ({ ...route })) } : null;
  }

  function listRouteStatus() {
    return [...state.keys()].map(getRouteStatus);
  }

  return { getActiveUrl, checkNode, refreshAll, reportTransportFailure, getRouteStatus, listRouteStatus, onRouteChanged: (listener) => events.on("route-changed", listener) };
}

let defaultResolver = null;
function getNodeRouteResolver() {
  if (!defaultResolver) defaultResolver = createNodeRouteResolver();
  return defaultResolver;
}

module.exports = {
  REFRESH_INTERVAL_MS,
  createNodeRouteResolver,
  getNodeRouteResolver,
  _test: { candidatesFor, defaultProbe },
};
