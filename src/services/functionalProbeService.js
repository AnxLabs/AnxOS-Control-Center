"use strict";

// AIM-2 increment 2: runs functional probes for services recognized in the
// AIM-1 infrastructure inventory (functionalProbeAdapters).
//
// Every run asks planProbeRun() first. With no Owner-approved scope, which is
// where the AIM-0 sign-off (2026-10-30) leaves every service, nothing is
// requested and the result is not-evaluated:LIVE_RUNS_DEFERRED.
//
// Scope approvals are read from functional-probe-scopes.json in the config
// folder. There is deliberately no in-app writer: approving a live run is a
// rare, deliberate Owner decision (AIM-0 §5). Shape:
//   { "schemaVersion": 1, "scopes": { "<inventory resource key>": {
//       "classification": "non-production", "liveRunApproved": true,
//       "baseUrl": "http://10.0.0.5:6333", "approvedBy": "Owner", "approvedAt": "...",
//       "expected": { ...the adapter's evaluate() context: expectedVersion (Sona),
//                     expectedCollections, baseline, wiring, expectedModels,
//                     expectedDimension, expectedText } } } }
// A resource is non-production only if BOTH the inventory protection (an
// Owner-confirmed classification) and its scope entry say so; otherwise it is
// production and probed on demand only. Probes are unauthenticated and
// read-only: no credential is read, stored or sent.
//
// Sona additionally reports its stack dependencies (sandbox, plugin host,
// Claude Code worker, browser, search, Cloudflare tunnel) from the inventory
// AnxOS already collected. That needs no probe and no approval, so a down
// dependency fails Sona functionally even while live probes stay deferred;
// healthy dependencies alone never make Sona "Works".

const fs = require("fs");
const path = require("path");
const model = require("../shared/functionalProbeModel");
const { evaluateDeclaredDependencies, planProbeRun, recognizeFunctionalService, sonaStackDependencies } = require("../shared/functionalProbeAdapters");

const SCOPES_FILE = "functional-probe-scopes.json";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 256 * 1024;
const LIVENESS_FROM_INVENTORY = Object.freeze({ healthy: "healthy", degraded: "degraded", failed: "failed", stopped: "failed" });

function resolveConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) return process.env.ANXHUB_CONFIG_DIR;
  try {
    const { app } = require("electron");
    if (app && typeof app.getPath === "function") return path.join(app.getPath("userData"), "config");
  } catch {}
  return path.join(process.cwd(), "config");
}

function readScopes(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && parsed.schemaVersion === 1 && parsed.scopes && typeof parsed.scopes === "object" ? parsed.scopes : {};
  } catch {
    // Missing or unreadable means "nothing approved", never "everything approved".
    return {};
  }
}

// Bounded HTTP for probes: http(s) only, no redirects (a probe must never be
// steered to another host), a timeout and a response size cap.
async function defaultRequest({ method, url, body, timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES }) {
  const target = new URL(url);
  if (target.protocol !== "http:" && target.protocol !== "https:") throw Object.assign(new Error("Unsupported probe protocol."), { code: "PROBE_PROTOCOL" });
  const init = { method, redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: {} };
  if (body !== undefined && body !== null) {
    if (typeof body === "string") {
      init.body = body;
      init.headers["content-type"] = "text/plain";
    } else {
      init.body = JSON.stringify(body);
      init.headers["content-type"] = "application/json";
    }
  }
  const response = await fetch(target, init);
  const declared = Number(response.headers.get("content-length"));
  // An oversized answer is no answer: the evaluator sees "no response", never an empty success.
  if (Number.isFinite(declared) && declared > maxBytes) return { status: null, error: "RESPONSE_TOO_LARGE" };
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { status: null, error: "RESPONSE_TOO_LARGE" };
  const isJson = /json/i.test(response.headers.get("content-type") || "");
  let parsed = text;
  if (isJson) {
    try { parsed = JSON.parse(text); } catch { parsed = null; }
  }
  return { status: response.status, body: parsed };
}

// Sona's dependency view from the inventory, or null for other services.
function sonaDependencyCheck(resource, resources) {
  const dependencies = sonaStackDependencies(resource, resources);
  if (resource.stale) {
    // A stale API entry means its node wasn't read this time: unknown, never "missing".
    return { dependencies, functional: model.notEvaluated(model.NOT_EVALUATED_REASONS.NO_RESPONSE, { detail: "The Sona stack was not confirmed by the latest inventory refresh." }) };
  }
  const evaluated = evaluateDeclaredDependencies({
    declared: dependencies.map((dependency) => dependency.id),
    dependencies: dependencies.filter((dependency) => dependency.present).map(({ id, liveness }) => ({ id, liveness })),
  });
  return { dependencies, functional: evaluated.functional };
}

// A dependency failure is evidence on its own; otherwise the probe (or gate)
// result stands, so passing dependencies never upgrade "not checked".
function mergeDependencyResult(primary, dependencyCheck) {
  if (!dependencyCheck || dependencyCheck.functional.outcome !== "fail") return primary;
  if (primary.outcome === "fail") return model.fromFindings({ failures: [...primary.findings, ...dependencyCheck.functional.findings] });
  return dependencyCheck.functional;
}

function createFunctionalProbeService(deps = {}) {
  const getInventory = deps.getInventory || (() => require("./infrastructureInventoryService").getInventory());
  const scopesPath = () => deps.scopesPath || path.join(resolveConfigDirectory(), SCOPES_FILE);
  const request = deps.request || defaultRequest;
  const now = deps.now || (() => new Date());
  const limits = { timeoutMs: deps.timeoutMs || DEFAULT_TIMEOUT_MS, maxBytes: deps.maxBytes || DEFAULT_MAX_BYTES };
  const results = new Map();
  const inFlight = new Map();
  let requestCount = 0;

  function effectiveScope(resource, entry) {
    const ownerConfirmedNonProduction = resource.protection?.scope === "non-production";
    return {
      classification: ownerConfirmedNonProduction && entry?.classification === "non-production" ? "non-production" : "production",
      liveRunApproved: entry?.liveRunApproved === true,
    };
  }

  function livenessOf(resource) {
    return LIVENESS_FROM_INVENTORY[resource?.health?.state] || "unknown";
  }

  function describeOne(resource, adapter, scopes, resources = []) {
    const entry = scopes[resource.key] || null;
    const scope = effectiveScope(resource, entry);
    const last = results.get(resource.key) || null;
    const dependencyCheck = adapter.id === "sona" ? sonaDependencyCheck(resource, resources) : null;
    // Without a completed run: the gate's reason if blocked, otherwise "no response yet".
    const probed = last?.functional || planProbeRun(adapter, scope) || model.notEvaluated(model.NOT_EVALUATED_REASONS.NO_RESPONSE);
    const functional = mergeDependencyResult(probed, dependencyCheck);
    const liveness = last?.liveness || livenessOf(resource);
    return {
      key: resource.key,
      name: resource.name || resource.key,
      nodeId: resource.nodeId || null,
      adapterId: adapter.id,
      label: adapter.label,
      liveness,
      functional: {
        outcome: functional.outcome,
        code: functional.code || null,
        reason: functional.reason || null,
        formatted: model.formatOutcome(functional),
        findings: functional.findings || [],
        detail: functional.detail || null,
      },
      combined: model.combineHealthAndFunctional(liveness, functional),
      dependencies: dependencyCheck ? dependencyCheck.dependencies : null,
      scope: { approved: scope.liveRunApproved, classification: scope.classification },
      checkedAt: last?.checkedAt || null,
      trigger: last?.trigger || null,
      requests: last?.requests ?? 0,
    };
  }

  function describe() {
    const inventory = getInventory() || {};
    const scopes = readScopes(scopesPath());
    const services = (Array.isArray(inventory.resources) ? inventory.resources : [])
      .map((resource) => ({ resource, adapter: recognizeFunctionalService(resource) }))
      .filter((entry) => entry.adapter)
      .map(({ resource, adapter }) => describeOne(resource, adapter, scopes, inventory.resources));
    const count = (predicate) => services.filter(predicate).length;
    return {
      contractVersion: model.CONTRACT_VERSION,
      services,
      summary: {
        services: services.length,
        passing: count((service) => service.functional.outcome === "pass"),
        degraded: count((service) => service.functional.outcome === "degraded"),
        failing: count((service) => service.functional.outcome === "fail"),
        notChecked: count((service) => service.functional.outcome === "not-evaluated"),
      },
    };
  }

  async function execute(adapter, entry) {
    const base = new URL(entry.baseUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") throw Object.assign(new Error("Scope baseUrl must be http(s)."), { code: "FUNCTIONAL_SCOPE_INVALID" });
    const call = async (probe, probePath) => {
      requestCount += 1;
      try {
        return await request({ method: probe.method, url: new URL(probePath, base).toString(), body: probe.body, ...limits });
      } catch (error) {
        return { status: null, error: error?.code || error?.name || "REQUEST_FAILED" };
      }
    };
    const before = requestCount;
    const livenessResponse = await call(adapter.liveness, adapter.liveness.path);
    const liveness = Number.isInteger(livenessResponse.status) && livenessResponse.status >= 200 && livenessResponse.status < 300 ? "healthy" : "failed";
    const responses = {};
    for (const probe of adapter.probes) {
      if (probe.perExpectedCollection) {
        responses[probe.id] = {};
        for (const name of entry.expected?.expectedCollections || []) {
          responses[probe.id][name] = await call(probe, probe.path.replace("{name}", encodeURIComponent(name)));
        }
        continue;
      }
      if (/\{[^}]+\}/.test(probe.path)) continue; // unresolved placeholders are never sent
      responses[probe.id] = await call(probe, probe.path);
    }
    const functional = adapter.evaluate({ ...(entry.expected || {}), credentialConfigured: false, responses });
    return { liveness, functional, requests: requestCount - before };
  }

  async function run(resourceKey, { trigger = "on-demand" } = {}) {
    if (inFlight.has(resourceKey)) return inFlight.get(resourceKey);
    const task = (async () => {
      const inventory = getInventory() || {};
      const resource = (inventory.resources || []).find((candidate) => candidate.key === resourceKey);
      if (!resource) throw Object.assign(new Error("That service is not in the infrastructure inventory."), { code: "FUNCTIONAL_TARGET_NOT_FOUND" });
      const adapter = recognizeFunctionalService(resource);
      if (!adapter) throw Object.assign(new Error("No functional check is defined for this service."), { code: "FUNCTIONAL_TARGET_UNSUPPORTED" });
      const scopes = readScopes(scopesPath());
      const entry = scopes[resource.key] || null;
      const blocked = planProbeRun(adapter, effectiveScope(resource, entry), { trigger });
      const checkedAt = now().toISOString();
      if (blocked || !entry?.baseUrl) {
        results.set(resource.key, { functional: blocked || model.notEvaluated(model.NOT_EVALUATED_REASONS.NOT_APPLICABLE, { detail: "The approved scope has no baseUrl." }), liveness: livenessOf(resource), checkedAt, trigger, requests: 0 });
      } else {
        const outcome = await execute(adapter, entry);
        results.set(resource.key, { ...outcome, checkedAt, trigger });
      }
      return describeOne(resource, adapter, scopes, inventory.resources || []);
    })();
    inFlight.set(resourceKey, task);
    try {
      return await task;
    } finally {
      inFlight.delete(resourceKey);
    }
  }

  return { describe, run, _test: { readScopes, effectiveScope, requestCount: () => requestCount } };
}

let defaultService = null;
function getFunctionalProbeService() {
  if (!defaultService) defaultService = createFunctionalProbeService();
  return defaultService;
}

function describeFunctionalProbes() {
  return getFunctionalProbeService().describe();
}

function runFunctionalProbe(resourceKey, options = {}) {
  return getFunctionalProbeService().run(resourceKey, options);
}

module.exports = {
  SCOPES_FILE,
  createFunctionalProbeService,
  defaultRequest,
  describeFunctionalProbes,
  getFunctionalProbeService,
  runFunctionalProbe,
};
