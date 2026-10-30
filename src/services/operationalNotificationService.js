// Operational notification journal (main process): a state-transition event log
// for machines, services, tunnel providers, endpoints and backups.
//
// Design (bounded + deterministic, dedup-first), mirroring alertService:
// - createOperationalNotificationService(...) owns an isolated journal instance:
//   state map + event log + dedupe window + optional persistence. The factory
//   is what tests and ops use; the module-level exports below operate on a
//   lazily created default instance (store in the shared config directory).
// - Evaluation is transition-driven, never snapshot-driven: the first
//   observation of a target only seeds its state, so a desktop start (or a
//   fresh journal) can never spam. A later transition emits exactly one event
//   per target; repeat changes within dedupeWindowMs are suppressed entirely.
// - Recoveries resolve the newest unresolved event for the same target and emit
//   one info event. A recovery is only announced when there is an unresolved
//   event to resolve, so the journal never claims "back online" for a problem it
//   never announced.
// - Persistence follows the alertService store conventions (atomic write,
//   corrupt-store quarantine, absolute path kept internal). A restart reloads
//   the state map, so already-notified states are never re-notified.
// - Every stored/returned message and technical detail is redacted through
//   src/shared/redaction.js before it leaves this module.
//
// Dependency injection only for collection: createOperationalNotificationCollector
// receives the desktop services as arguments and requires nothing itself. This
// module loads no service dependencies (node builtins + redaction only).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { redactString } = require("../shared/redaction");

const NOTIFICATION_EVENT_SCHEMA_VERSION = 1;
const NOTIFICATION_STORE_FILE = "notifications.json";
const DEFAULT_EVALUATION_INTERVAL_MS = 60 * 1000;
const DEFAULT_DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_EVENTS = 200;
const MAX_TECHNICAL_DETAILS_LENGTH = 300;
// Default backup source bounds: one bounded, node-scoped agent read per tick.
const MAX_BACKUP_RECORDS = 50;
const BACKUP_LIST_TIMEOUT_MS = 8 * 1000;

const SEVERITIES = Object.freeze(["info", "warning", "critical"]);
const CATEGORIES = Object.freeze(["agent", "service", "provider", "endpoint", "backup"]);

const TARGET_KEYS = Object.freeze(["nodeId", "instanceId", "endpointId", "providerId"]);

// ---------------------------------------------------------------------------
// Pure normalization helpers
// ---------------------------------------------------------------------------
function listOf(value) {
  return Array.isArray(value) ? value : [];
}

function textOf(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function hashEventId(dedupKey, at) {
  return `ntf-${crypto.createHash("sha256").update(`${dedupKey}${at}`).digest("hex").slice(0, 16)}`;
}

function cleanTarget(target) {
  const result = {};
  for (const key of TARGET_KEYS) {
    const value = textOf(target?.[key]);
    if (value) result[key] = value;
  }
  return result;
}

function nodeIdentity(node, index) {
  const explicitId = textOf(node?.nodeId ?? node?.id);
  // A display name is only ever a fallback identifier, so it is redacted before
  // it can reach a persisted dedupKey/target. Real ids are never redacted, so
  // well-formed records keep byte-identical dedup keys.
  const id = explicitId || redactString(textOf(node?.name ?? node?.hostname)) || `node-${index}`;
  const name = textOf(node?.name ?? node?.hostname) || id;
  return { id, name };
}

// A node is "online" only when its connection state resolves to online; every
// other recorded state (offline, degraded, connecting, authentication_failed,
// unknown) is observed as offline, with the raw state kept for the message.
function normalizeNodeObservedState(node) {
  const raw = textOf(node?.state ?? node?.health ?? node?.connection?.status ?? node?.status).toLowerCase();
  return { observed: raw === "online" ? "online" : "offline", rawState: raw || "unknown" };
}

function isCrashLoopInstance(instance) {
  if (instance?.crashLoop === true) return true;
  if (instance?.health && typeof instance.health === "object" && instance.health.crashLoop === true) return true;
  return [instance?.healthState, instance?.processState, instance?.status]
    .map((value) => (typeof value === "string" ? value.trim().toLowerCase() : ""))
    .filter(Boolean)
    .some((value) => /crash[\s_-]?loop/.test(value));
}

function normalizeInstanceState(instance) {
  const raw = textOf(instance?.state ?? instance?.processState ?? instance?.healthState ?? instance?.status).toLowerCase();
  if (isCrashLoopInstance(instance)) return { observed: "failed", rawState: raw || "crash-loop", crashLoop: true };
  if (raw === "running") return { observed: "running", rawState: raw, crashLoop: false };
  if (raw === "failed" || raw === "crashed" || raw === "error") return { observed: "failed", rawState: raw, crashLoop: false };
  return { observed: "stopped", rawState: raw || "unknown", crashLoop: false };
}

// Observed provider vocabulary: connected / degraded / stopped / not-installed /
// unknown. The collector feeds the canonical provider state from
// providerAdapterContract ({ providerId, displayName, availability, state,
// connected }), where "running" is the healthy state; the legacy
// lifecycle/health names are still read for older recorded rows.
// `connected === true` outranks the state, a "running" provider is connected
// unless its transport is explicitly down (connected === false -> degraded),
// and auth-required means the provider cannot carry traffic: stopped.
function normalizeProviderObservedState(provider) {
  const rawState = textOf(provider?.state ?? provider?.lifecycleState ?? provider?.lifecycle ?? provider?.health).toLowerCase() || "unknown";
  if (provider?.connected === true) return { observed: "connected", rawState };
  if (rawState === "running") {
    return { observed: provider?.connected === false ? "degraded" : "connected", rawState };
  }
  if (rawState === "degraded") return { observed: "degraded", rawState };
  if (rawState === "stopped" || rawState === "auth-required" || rawState === "disconnected") {
    return { observed: "stopped", rawState };
  }
  if (rawState === "not-installed") return { observed: "not-installed", rawState };
  return { observed: "unknown", rawState };
}

// Endpoints are only observable when a cached diagnostics result carries a
// health.state; this module never probes.
function endpointHealthState(endpoint) {
  const raw = endpoint?.health && typeof endpoint.health === "object" ? endpoint.health.state : null;
  const state = textOf(raw).toLowerCase();
  return state || null;
}

function backupFailureOf(backup) {
  const status = textOf(backup?.status).toLowerCase();
  const verificationStatus = textOf(backup?.verification?.status ?? backup?.verificationStatus).toLowerCase();
  const statusFailed = status === "failed" || status === "failure" || status === "error";
  // "corrupt" (an archive that no longer decodes) is a terminal verification
  // failure like a checksum mismatch; "unknown" (not evaluable) is not.
  const verificationFailed = verificationStatus === "failed" || verificationStatus === "failure" || verificationStatus === "corrupt" || backup?.verification === false;
  if (statusFailed) return { failed: true, status };
  if (verificationFailed) return { failed: true, status: verificationStatus || "verification-failed" };
  return { failed: false, status: status || "unknown" };
}

function resolveConfigDirectory() {
  if (process.env.ANXHUB_CONFIG_DIR) return process.env.ANXHUB_CONFIG_DIR;
  try {
    // Lazy require so hermetic smokes never touch the Electron runtime; under
    // plain Node this resolves to the electron binary path string and falls
    // through to the cwd default.
    const electron = require("electron");
    const app = electron && electron.app;
    if (app && typeof app.getPath === "function") return path.join(app.getPath("userData"), "config");
  } catch {}
  return path.join(process.cwd(), "config");
}

// ---------------------------------------------------------------------------
// Service factory
// ---------------------------------------------------------------------------
// createOperationalNotificationService({ collectState, storePath, now,
// dedupeWindowMs }) returns one isolated journal. `storePath` pins persistence
// for tests; production resolves <configDirectory>/notifications.json.
function createOperationalNotificationService(options = {}) {
  const collectState = typeof options.collectState === "function" ? options.collectState : async () => ({});
  const storePath = textOf(options.storePath) || null;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const dedupeWindowMs = Number.isFinite(Number(options.dedupeWindowMs)) && Number(options.dedupeWindowMs) >= 0
    ? Number(options.dedupeWindowMs)
    : DEFAULT_DEDUPE_WINDOW_MS;

  let store = emptyStore();
  let loaded = false;
  let dirty = false;
  let degraded = false;
  let quarantine = null;
  let evaluating = false;
  let timer = null;

  function emptyStore() {
    return { schemaVersion: NOTIFICATION_EVENT_SCHEMA_VERSION, events: [], state: {} };
  }

  function resolveStorePath() {
    if (storePath) return storePath;
    if (process.env.ANXOS_NOTIFICATIONS_STORE) return process.env.ANXOS_NOTIFICATIONS_STORE;
    return path.join(resolveConfigDirectory(), NOTIFICATION_STORE_FILE);
  }

  function currentTimeMs() {
    const value = Number(now());
    return Number.isFinite(value) ? value : Date.now();
  }

  function currentIso() {
    return new Date(currentTimeMs()).toISOString();
  }

  function loadStore() {
    const target = resolveStorePath();
    if (!fs.existsSync(target)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(target, "utf8"));
      const schemaVersion = Number.isInteger(raw?.schemaVersion) ? raw.schemaVersion : 0;
      if (schemaVersion > NOTIFICATION_EVENT_SCHEMA_VERSION) {
        throw Object.assign(new Error("The notification store was written by a newer build."), { code: "SCHEMA_UNSUPPORTED" });
      }
      store = {
        schemaVersion: NOTIFICATION_EVENT_SCHEMA_VERSION,
        events: listOf(raw?.events).filter((event) => event && typeof event === "object" && typeof event.id === "string"),
        state: raw?.state && typeof raw.state === "object" && !Array.isArray(raw.state) ? raw.state : {},
      };
      trimEvents();
    } catch (error) {
      // Corrupt-store quarantine (alertService/settingsPreferenceService
      // convention): keep the unreadable file once for forensics, then start
      // empty. The next persist writes a valid store.
      const quarantinePath = `${target}.corrupt-${Date.now()}`;
      try { fs.copyFileSync(target, quarantinePath, fs.constants.COPYFILE_EXCL); } catch {}
      quarantine = { path: quarantinePath, code: error?.code || "INVALID_JSON" };
      degraded = true;
      store = emptyStore();
    }
  }

  function ensureLoaded() {
    if (loaded) return;
    loadStore();
    loaded = true;
  }

  function persist() {
    if (!dirty) return;
    const target = resolveStorePath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temp, target);
    dirty = false;
  }

  // Hard bound: drop the oldest RESOLVED events first so unresolved incidents
  // always survive a busy burst; fall back to the oldest event only when every
  // retained event is still unresolved.
  function trimEvents() {
    while (store.events.length > MAX_EVENTS) {
      let index = -1;
      for (let cursor = store.events.length - 1; cursor >= 0; cursor -= 1) {
        if (store.events[cursor]?.resolvedAt) { index = cursor; break; }
      }
      if (index === -1) index = store.events.length - 1;
      store.events.splice(index, 1);
      dirty = true;
    }
  }

  // Seeds on first observation (no event); records every later state change.
  function observeState(dedupKey, observedState, at) {
    const entry = store.state[dedupKey];
    if (!entry || typeof entry !== "object") {
      store.state[dedupKey] = { state: observedState, since: at, lastNotifiedAt: null };
      dirty = true;
      return { kind: "seed", previous: null };
    }
    if (entry.state === observedState) return { kind: "same", previous: entry.state };
    const previous = textOf(entry.state) || "unknown";
    entry.state = observedState;
    entry.since = at;
    dirty = true;
    return { kind: "transition", previous };
  }

  // Emission is suppressed entirely when the same key notified within the
  // dedupe window (anti-flap). Recoveries and once-per-backupId failures pass
  // windowExempt: a resolution must not be lost to a just-sent warning.
  function emitEvent(context, fields) {
    const entry = store.state[fields.dedupKey];
    if (fields.windowExempt !== true && entry && entry.lastNotifiedAt) {
      const lastMs = Date.parse(entry.lastNotifiedAt);
      if (Number.isFinite(lastMs) && context.atMs - lastMs < dedupeWindowMs) return null;
    }
    if (entry) {
      entry.lastNotifiedAt = context.at;
      dirty = true;
    }
    const target = cleanTarget(fields.target);
    const event = {
      id: hashEventId(fields.dedupKey, context.at),
      at: context.at,
      severity: fields.severity,
      category: fields.category,
      title: redactString(String(fields.title || "")),
      message: redactString(String(fields.message || "")),
      dedupKey: fields.dedupKey,
      target,
      action: { id: fields.actionId, target: { ...target } },
      resolvedAt: null,
      technicalDetails: fields.technicalDetails
        ? redactString(String(fields.technicalDetails)).slice(0, MAX_TECHNICAL_DETAILS_LENGTH)
        : null,
    };
    store.events.unshift(event);
    context.newEvents.push(event);
    dirty = true;
    return event;
  }

  // Only problem events (warning/critical) are resolvable incidents. A recovery
  // info event is itself logged as an unresolved entry, so treating it as an
  // incident here would make the next recovery resolve the previous recovery
  // and emit forever.
  function resolveNewestUnresolvedIncident(dedupKey, at) {
    for (const event of store.events) {
      if (event && event.dedupKey === dedupKey && !event.resolvedAt && event.severity !== "info") {
        event.resolvedAt = at;
        dirty = true;
        return event;
      }
    }
    return null;
  }

  function processNodes(state, context) {
    listOf(state?.nodes).forEach((node, index) => {
      const { id: nodeId, name } = nodeIdentity(node, index);
      const { observed, rawState } = normalizeNodeObservedState(node);
      const dedupKey = `node:${nodeId}`;
      const result = observeState(dedupKey, observed, context.at);
      if (result.kind !== "transition") return;
      if (observed === "offline") {
        emitEvent(context, {
          dedupKey,
          severity: "critical",
          category: "agent",
          title: "Machine disconnected",
          message: `Machine ${name} disconnected (state: ${rawState}).`,
          target: { nodeId },
          actionId: "open-nodes",
          technicalDetails: `previous=${result.previous}; observed=offline; rawState=${rawState}; name=${name}`,
        });
        return;
      }
      if (observed === "online") {
        if (!resolveNewestUnresolvedIncident(dedupKey, context.at)) return;
        emitEvent(context, {
          dedupKey,
          severity: "info",
          category: "agent",
          title: "Machine back online",
          message: `Machine ${name} is back online.`,
          target: { nodeId },
          actionId: "open-nodes",
          technicalDetails: `previous=${result.previous}; observed=online; name=${name}`,
          windowExempt: true,
        });
      }
    });
  }

  function processInstances(state, context) {
    listOf(state?.instances).forEach((instance, index) => {
      const nodeId = textOf(instance?.nodeId ?? instance?.node);
      if (!nodeId) return;
      // Display-name fallback as identifier: redact it before it can reach a
      // persisted dedupKey/target (real ids stay byte-identical).
      const explicitInstanceId = textOf(instance?.instanceId ?? instance?.id);
      const instanceId = explicitInstanceId || redactString(textOf(instance?.name)) || `instance-${index}`;
      const { observed, rawState, crashLoop } = normalizeInstanceState(instance);
      const dedupKey = `instance:${nodeId}:${instanceId}`;
      const result = observeState(dedupKey, observed, context.at);
      if (result.kind !== "transition") return;
      const previous = result.previous;
      const base = {
        dedupKey,
        category: "service",
        target: { nodeId, instanceId },
        actionId: "open-instance",
      };
      if (observed === "failed" && crashLoop) {
        emitEvent(context, {
          ...base,
          severity: "critical",
          title: "Service crash loop",
          message: `Service ${instanceId} on ${nodeId} is crash-looping (state: ${rawState}).`,
          technicalDetails: `previous=${previous}; observed=failed; rawState=${rawState}; crashLoop=true`,
        });
        return;
      }
      if (observed === "failed" && previous === "running") {
        emitEvent(context, {
          ...base,
          severity: "critical",
          title: "Service crashed",
          message: `Service ${instanceId} on ${nodeId} failed (state: ${rawState}).`,
          technicalDetails: `previous=${previous}; observed=failed; rawState=${rawState}; crashLoop=false`,
        });
        return;
      }
      if (observed === "stopped" && previous === "running") {
        emitEvent(context, {
          ...base,
          severity: "warning",
          title: "Service stopped unexpectedly",
          message: `Service ${instanceId} on ${nodeId} stopped unexpectedly (state: ${rawState}).`,
          technicalDetails: `previous=${previous}; observed=stopped; rawState=${rawState}`,
        });
        return;
      }
      if (observed === "running" && (previous === "failed" || previous === "stopped")) {
        if (!resolveNewestUnresolvedIncident(dedupKey, context.at)) return;
        emitEvent(context, {
          ...base,
          severity: "info",
          title: "Service running again",
          message: `Service ${instanceId} on ${nodeId} is running again.`,
          technicalDetails: `previous=${previous}; observed=running`,
          windowExempt: true,
        });
      }
    });
  }

  function processProviders(state, context) {
    listOf(state?.providers).forEach((provider, index) => {
      const nodeId = textOf(provider?.nodeId ?? provider?.node);
      const nodeLabel = nodeId || "unknown";
      const providerId = textOf(provider?.providerId ?? provider?.id) || `provider-${index}`;
      const name = textOf(provider?.displayName ?? provider?.name) || providerId;
      const { observed, rawState } = normalizeProviderObservedState(provider);
      const dedupKey = `provider:${nodeLabel}:${providerId}`;
      const result = observeState(dedupKey, observed, context.at);
      if (result.kind !== "transition") return;
      const previous = result.previous;
      const base = {
        dedupKey,
        category: "provider",
        target: { nodeId, providerId },
        actionId: "open-network",
      };
      if (previous === "connected" && (observed === "stopped" || observed === "not-installed")) {
        emitEvent(context, {
          ...base,
          severity: "critical",
          title: "Tunnel provider disconnected",
          message: `Tunnel provider ${name} disconnected on ${nodeLabel} (state: ${rawState}).`,
          technicalDetails: `previous=${previous}; observed=${observed}; rawState=${rawState}`,
        });
        return;
      }
      if (previous === "connected" && observed === "degraded") {
        emitEvent(context, {
          ...base,
          severity: "warning",
          title: "Tunnel provider degraded",
          message: `Tunnel provider ${name} is degraded on ${nodeLabel}.`,
          technicalDetails: `previous=${previous}; observed=degraded; rawState=${rawState}`,
        });
        return;
      }
      if (observed === "connected" && previous !== "connected") {
        if (!resolveNewestUnresolvedIncident(dedupKey, context.at)) return;
        emitEvent(context, {
          ...base,
          severity: "info",
          title: "Tunnel provider connected",
          message: `Tunnel provider ${name} is connected again on ${nodeLabel}.`,
          technicalDetails: `previous=${previous}; observed=connected`,
          windowExempt: true,
        });
      }
    });
  }

  function processEndpoints(state, context) {
    listOf(state?.endpoints).forEach((endpoint, index) => {
      const endpointId = textOf(endpoint?.endpointId ?? endpoint?.id) || `endpoint-${index}`;
      const healthState = endpointHealthState(endpoint);
      if (!healthState) return; // no cached diagnostics -> no observation, no probing
      const nodeId = textOf(endpoint?.nodeId ?? endpoint?.computerId);
      const label = textOf(endpoint?.label ?? endpoint?.name) || endpointId;
      const dedupKey = `endpoint:${endpointId}`;
      const result = observeState(dedupKey, healthState, context.at);
      if (result.kind !== "transition") return;
      const previous = result.previous;
      const base = {
        dedupKey,
        category: "endpoint",
        target: { nodeId, endpointId },
        actionId: "open-network",
      };
      if (previous === "healthy" && healthState === "failed") {
        emitEvent(context, {
          ...base,
          severity: "warning",
          title: "Endpoint became unavailable",
          message: `Endpoint ${label} became unavailable (health: ${healthState}).`,
          technicalDetails: `previous=${previous}; observed=${healthState}; source=cached-diagnostics`,
        });
        return;
      }
      if (healthState === "healthy" && previous !== "healthy") {
        if (!resolveNewestUnresolvedIncident(dedupKey, context.at)) return;
        emitEvent(context, {
          ...base,
          severity: "info",
          title: "Endpoint available again",
          message: `Endpoint ${label} is healthy again.`,
          technicalDetails: `previous=${previous}; observed=healthy; source=cached-diagnostics`,
          windowExempt: true,
        });
      }
    });
  }

  function processBackups(state, context) {
    listOf(state?.backups).forEach((backup, index) => {
      const failure = backupFailureOf(backup);
      if (!failure.failed) return;
      const nodeId = textOf(backup?.nodeId) || "unknown";
      const instanceId = textOf(backup?.instanceId ?? backup?.instance) || "unknown";
      const backupId = textOf(backup?.backupId ?? backup?.id) || `backup-${index}`;
      const dedupKey = `backup:${nodeId}:${instanceId}:${backupId}`;
      const entry = store.state[dedupKey];
      // Once per backupId, ever: a failed backup is an immutable incident, so a
      // re-observation (or a restart) must never re-notify it.
      if (entry && entry.lastNotifiedAt) return;
      store.state[dedupKey] = {
        state: "failed",
        since: entry && entry.since ? entry.since : context.at,
        lastNotifiedAt: entry && entry.lastNotifiedAt ? entry.lastNotifiedAt : null,
      };
      dirty = true;
      emitEvent(context, {
        dedupKey,
        severity: "warning",
        category: "backup",
        title: "Backup failed",
        message: `Backup ${backupId} failed for service ${instanceId} on ${nodeId} (status: ${failure.status}).`,
        target: { nodeId, instanceId },
        actionId: "open-instance",
        technicalDetails: `status=${failure.status}; backupId=${backupId}`,
        windowExempt: true,
      });
    });
  }

  function evaluateState(state, context) {
    processNodes(state, context);
    processInstances(state, context);
    processProviders(state, context);
    processEndpoints(state, context);
    processBackups(state, context);
    trimEvents();
    return context.newEvents;
  }

  // One evaluation pass. Never throws to the caller: it catches every error and
  // reports it. Overlapping passes are skipped (the scheduler tick guard).
  async function evaluate(options = {}) {
    const evaluatedAt = currentIso();
    if (evaluating) {
      return { ok: true, evaluatedAt, events: [], skipped: true, reason: "EVALUATION_IN_PROGRESS" };
    }
    evaluating = true;
    try {
      ensureLoaded();
      const collect = typeof options.collectState === "function" ? options.collectState : collectState;
      let collected;
      try {
        collected = await collect();
      } catch (error) {
        return { ok: false, evaluatedAt, events: [], errorCode: error?.code || "NOTIFICATION_STATE_UNAVAILABLE" };
      }
      const atMs = currentTimeMs();
      const context = { at: new Date(atMs).toISOString(), atMs, newEvents: [] };
      const state = collected && typeof collected === "object" ? collected : {};
      const events = evaluateState(state, context);
      persist();
      return { ok: true, evaluatedAt, events };
    } catch (error) {
      return { ok: false, evaluatedAt, events: [], errorCode: error?.code || "NOTIFICATION_EVALUATION_FAILED" };
    } finally {
      evaluating = false;
    }
  }

  // Renderer/ops read: newest first, ISO `since` cursor filter, limit 1..100.
  // The absolute store path stays internal (getStoreStatus) so callers cannot
  // leak host filesystem layout.
  function list(options = {}) {
    ensureLoaded();
    const since = typeof options.since === "string" && options.since ? options.since : null;
    const sinceMs = since ? Date.parse(since) : NaN;
    let events = store.events;
    if (Number.isFinite(sinceMs)) {
      events = events.filter((event) => {
        const atMs = Date.parse(event?.at);
        return Number.isFinite(atMs) && atMs > sinceMs;
      });
    }
    const requested = options.limit === null || options.limit === undefined ? NaN : Number(options.limit);
    const limit = Number.isFinite(requested) ? Math.min(MAX_LIST_LIMIT, Math.max(1, Math.trunc(requested))) : DEFAULT_LIST_LIMIT;
    const page = events.slice(0, limit);
    return { events: page, cursor: page[0]?.id || null, degraded };
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // Interval scheduler: immediate first pass, unref'd timer, idempotent start.
  function start(options = {}) {
    if (timer) return stop;
    const collect = typeof options.collectState === "function" ? options.collectState : collectState;
    const intervalMs = Number.isFinite(Number(options.intervalMs)) && Number(options.intervalMs) > 0
      ? Number(options.intervalMs)
      : DEFAULT_EVALUATION_INTERVAL_MS;
    const tick = () => {
      evaluate({ collectState: collect }).catch(() => {});
    };
    tick();
    timer = setInterval(tick, intervalMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    return stop;
  }

  function getStoreStatus() {
    const target = resolveStorePath();
    return { path: target, exists: fs.existsSync(target), quarantine: quarantine ? { ...quarantine } : null };
  }

  return { evaluate, list, start, stop, getStoreStatus, resolveStorePath };
}

// ---------------------------------------------------------------------------
// Module-level default instance (shared by the module-level exports)
// ---------------------------------------------------------------------------
let defaultService = null;

function getDefaultService() {
  if (!defaultService) defaultService = createOperationalNotificationService({});
  return defaultService;
}

function startOperationalNotificationScheduler(options = {}) {
  return getDefaultService().start(options);
}

function stopOperationalNotificationScheduler() {
  if (defaultService) defaultService.stop();
}

function listOperationalNotifications(options = {}) {
  return getDefaultService().list(options);
}

async function evaluateOperationalNotifications(options = {}) {
  return getDefaultService().evaluate(options);
}

// ---------------------------------------------------------------------------
// State collector (DI-only)
// ---------------------------------------------------------------------------
// The production caller owns the lazy requires and passes the desktop services
// in, so this module stays require-free at load time. Every read degrades to an
// empty collection: an unreachable service must never break an evaluation tick.
function resolveEffectiveNodeId(nodeService) {
  if (!nodeService) return null;
  try {
    const selected = typeof nodeService.getSelectedNodeId === "function" ? nodeService.getSelectedNodeId() : null;
    return selected || nodeService.APPLICATION_HOST_NODE_ID || null;
  } catch {
    return null;
  }
}

async function attachEndpointHealth(endpoints, connectivityDiagnosticsService, fallbackNodeId) {
  const rows = listOf(endpoints);
  if (!connectivityDiagnosticsService || typeof connectivityDiagnosticsService.getCachedDiagnostics !== "function") return rows;
  const result = [];
  for (const endpoint of rows) {
    const endpointId = textOf(endpoint?.endpointId ?? endpoint?.id);
    if (!endpointId) {
      result.push(endpoint);
      continue;
    }
    // The endpoint store keys its records by computerId; diagnostics cache keys
    // are nodeId|serviceId|endpointId, so pass every identifier the record has.
    const nodeId = textOf(endpoint?.nodeId ?? endpoint?.computerId) || textOf(fallbackNodeId);
    const serviceId = textOf(endpoint?.serviceId);
    let cached = null;
    try {
      // The canonical endpoint lookup finds an evaluation whether it was run as
      // an endpoint test (no service) or a service-scoped run.
      cached = typeof connectivityDiagnosticsService.getCachedEndpointDiagnostics === "function"
        ? await connectivityDiagnosticsService.getCachedEndpointDiagnostics({ nodeId: nodeId || null, endpointId, endpoint })
        : await connectivityDiagnosticsService.getCachedDiagnostics({ nodeId: nodeId || null, serviceId: serviceId || null, endpointId, endpoint });
    } catch {
      cached = null;
    }
    // Cache-only read: a miss is an explicit sentinel (NOT_EVALUATED), never a
    // fabricated state. No cached evaluation -> no health observation and no
    // probe from this module.
    const hasEvaluation = Boolean(cached) && cached.cached !== false && (cached.cached === true || Boolean(cached.overall));
    if (!hasEvaluation) {
      result.push(endpoint);
      continue;
    }
    const state = textOf(cached?.overall?.state ?? cached?.state ?? cached?.health?.state).toLowerCase();
    if (!state) {
      result.push(endpoint);
      continue;
    }
    const health = endpoint?.health && typeof endpoint.health === "object" ? { ...endpoint.health, state } : { state };
    result.push({ ...endpoint, health });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Backup records (default agent read path)
// ---------------------------------------------------------------------------
// Agent records carry id/instanceId/status/createdAt plus a verification
// lifecycle ({ state: "unverified"|"verified"|"failed"|"corrupt"|"unknown" }).
// The evaluator consumes status / verification.status, so the verification
// state is projected into that shape.
function mapBackupRecord(record, nodeId) {
  const source = record && typeof record === "object" && !Array.isArray(record) ? record : {};
  const backupId = textOf(source.backupId ?? source.id);
  if (!backupId) return null;
  const verification = source.verification && typeof source.verification === "object" ? source.verification : null;
  const mapped = {
    nodeId: textOf(source.nodeId) || textOf(nodeId) || "unknown",
    instanceId: textOf(source.instanceId ?? source.instance) || "unknown",
    backupId,
    status: textOf(source.status).toLowerCase(),
    createdAt: textOf(source.createdAt) || null,
  };
  const verificationStatus = textOf(verification?.status ?? verification?.state ?? source.verificationStatus).toLowerCase();
  if (verificationStatus) {
    mapped.verificationStatus = verificationStatus;
    mapped.verification = { status: verificationStatus };
  } else if (source.verification === false) {
    mapped.verificationStatus = "failed";
    mapped.verification = { status: "failed" };
  }
  return mapped;
}

function mapBackupRecords(payload, nodeId) {
  const rows = payload && typeof payload === "object" && !Array.isArray(payload) ? payload.backups : payload;
  return listOf(rows)
    .slice(0, MAX_BACKUP_RECORDS)
    .map((record) => mapBackupRecord(record, nodeId))
    .filter(Boolean);
}

function withTimeout(value, timeoutMs, code) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("Backup listing timed out."), { code })), timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref();
    Promise.resolve(value).then(
      (result) => { clearTimeout(timer); resolve(result); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

async function readBackupRecords(listBackups, nodeId) {
  try {
    const payload = await withTimeout(listBackups({ nodeId }), BACKUP_LIST_TIMEOUT_MS, "BACKUP_LIST_TIMEOUT");
    return mapBackupRecords(payload, nodeId);
  } catch {
    return [];
  }
}

// Default backup source: the same node-scoped desktop read path the Backups
// page uses (serviceRouter.listBackups -> agent /api/v1/backups/list). The
// require is lazy so module load stays free of service dependencies; the read
// is bounded (8 s timeout, 50-record cap), scoped to the effective node, and
// every failure degrades to [].
async function readDefaultBackupRecords(nodeId) {
  if (!nodeId) return [];
  let router = null;
  try {
    router = require("./serviceRouter");
  } catch {
    return [];
  }
  if (!router || typeof router.listBackups !== "function") return [];
  return readBackupRecords((options) => router.listBackups(options), nodeId);
}

function createOperationalNotificationCollector({
  nodeService,
  alertService,
  serviceRouter,
  endpointService,
  providerIntegrationService,
  connectivityDiagnosticsService,
  backupProvider,
  backupService,
} = {}) {
  return async () => {
    const effectiveNodeId = resolveEffectiveNodeId(nodeService);

    let nodes = [];
    if (nodeService && typeof nodeService.listNodes === "function") {
      try {
        const payload = await nodeService.listNodes({ discoverLocalAgent: false, refreshIdentity: false });
        nodes = listOf(payload?.nodes ?? payload);
      } catch {
        nodes = [];
      }
    }

    let instances = [];
    if (alertService && typeof alertService.resolveInstanceSnapshot === "function" && serviceRouter && typeof serviceRouter.listInstances === "function") {
      try {
        const payload = await alertService.resolveInstanceSnapshot(
          effectiveNodeId,
          () => serviceRouter.listInstances({}).catch(() => ({ instances: [] })),
        );
        instances = listOf(payload?.instances);
      } catch {
        instances = [];
      }
    }

    let endpoints = [];
    if (endpointService && typeof endpointService.listEndpoints === "function") {
      try {
        const payload = await endpointService.listEndpoints({ nodeId: effectiveNodeId });
        endpoints = listOf(payload?.endpoints ?? payload);
      } catch {
        endpoints = [];
      }
    }

    // Background evaluation never probes the Agent for provider state: it
    // reads the last state an explicit refresh or sync recorded. Probing here
    // made the Agent run the provider binary on every evaluation.
    let providers = [];
    if (providerIntegrationService && typeof providerIntegrationService.getCachedProviderSnapshot === "function") {
      try {
        const snapshot = await providerIntegrationService.getCachedProviderSnapshot({ nodeId: effectiveNodeId });
        providers = listOf(snapshot?.providers ?? snapshot);
      } catch {
        providers = [];
      }
    }

    let backups = [];
    if (typeof backupProvider === "function") {
      // Explicit override: the caller owns the record shape.
      try {
        const payload = await backupProvider({ nodeId: effectiveNodeId });
        backups = listOf(payload?.backups ?? payload);
      } catch {
        backups = [];
      }
    } else if (backupService && typeof backupService.listBackups === "function") {
      backups = await readBackupRecords((options) => backupService.listBackups(options), effectiveNodeId);
    } else if (serviceRouter && typeof serviceRouter.listBackups === "function") {
      // Injected desktop read path (the same module the Backups page uses).
      backups = await readBackupRecords((options) => serviceRouter.listBackups(options), effectiveNodeId);
    } else {
      backups = await readDefaultBackupRecords(effectiveNodeId);
    }

    const endpointsWithHealth = await attachEndpointHealth(endpoints, connectivityDiagnosticsService, effectiveNodeId);

    return { nodes, instances, providers, endpoints: endpointsWithHealth, backups };
  };
}

module.exports = {
  NOTIFICATION_EVENT_SCHEMA_VERSION,
  NOTIFICATION_STORE_FILE,
  DEFAULT_EVALUATION_INTERVAL_MS,
  DEFAULT_DEDUPE_WINDOW_MS,
  MAX_EVENTS,
  SEVERITIES,
  CATEGORIES,
  createOperationalNotificationService,
  createOperationalNotificationCollector,
  evaluateOperationalNotifications,
  listOperationalNotifications,
  startOperationalNotificationScheduler,
  stopOperationalNotificationScheduler,
};
